"""DDL 解析 —— sqlglot AST + 行内注释还原。

**注释是这个解析器最重要的产出**，不是附属信息。``plan_amount DECIMAL(18,2)``
在两张表里长得一模一样，区别全在 ``-- 含税·年度累计`` 和 ``-- 不含税·单次``
这两行注释里。丢掉注释，口径冲突就永远发现不了。

sqlglot 的 AST 不保证保留行内注释的位置，所以这里按**行号**把 ``--`` 注释关联
回列定义 —— 土办法，但对真实 DDL 稳定可靠。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .base import Finding, ParsedDoc, Parser, make_chunk

_LINE_COMMENT = re.compile(r"--\s*(.+?)\s*$")
_IDENT = re.compile(r"^\s*[`\"\[]?(\w+)[`\"\]]?\s+", re.I)
_NON_COL = re.compile(
    r"^\s*(constraint|primary\s+key|foreign\s+key|unique|key|index|check)\b", re.I)


class DdlParser(Parser):
    kind = "ddl"
    extensions = (".ddl", ".sql")

    def __init__(self, dialect: str | None = None) -> None:
        self.dialect = dialect

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        import sqlglot
        from sqlglot import exp

        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        sql = path.read_text(encoding="utf-8", errors="replace")
        comments = _column_comments(sql)

        try:
            statements = sqlglot.parse(sql, read=self.dialect)
        except Exception as exc:  # noqa: BLE001 — 方言千奇百怪，解析失败要报出来而不是静默
            doc.findings.append(Finding(
                "parse_failed", f"sqlglot 解析失败（方言 {self.dialect or '自动'}）：{exc}",
                {}, severity="warn"))
            return doc

        tables: list[dict[str, Any]] = []
        order = 0
        for stmt in statements:
            if not isinstance(stmt, exp.Create) or (stmt.kind or "").upper() != "TABLE":
                continue
            tname = _table_name(stmt)
            cols, pks, fks = _columns(stmt, comments.get(tname, {}))
            tables.append({"name": tname, "columns": cols, "primary_key": pks,
                           "foreign_keys": fks})

            # 表级切片：一眼看清这张表是什么 + 主键 + 列名概览。检索"这张表有哪些字段"
            # 时不必把每个列切片都捞出来。
            pk_str = f"，主键 {'+'.join(pks)}" if pks else ""
            doc.chunks.append(make_chunk(
                doc_id=tname, file_id=file_id, file_name=path.name,
                locator={"kind": "ddl", "object": tname},
                render=f"表 {tname}（{len(cols)} 列{pk_str}）："
                       + "、".join(c["name"] for c in cols),
                raw={"table": tname, "primary_key": pks,
                     "columns": [c["name"] for c in cols]},
                order=order, tags=["table"]))
            order += 1

            for c in cols:
                bits = [f"{tname}.{c['name']} {c['type']}"]
                if c["name"] in pks:
                    bits.append("PRIMARY KEY")
                if not c["nullable"]:
                    bits.append("NOT NULL")
                if c["comment"]:
                    bits.append(f"-- {c['comment']}")
                doc.chunks.append(make_chunk(
                    doc_id=f"{tname}.{c['name']}", file_id=file_id, file_name=path.name,
                    locator={"kind": "ddl", "object": f"{tname}.{c['name']}"},
                    render=" ".join(bits), raw=c, order=order, tags=["column"]))
                order += 1

            for fk in fks:
                doc.chunks.append(make_chunk(
                    doc_id=f"{tname}.fk.{fk['column']}", file_id=file_id, file_name=path.name,
                    locator={"kind": "ddl", "object": f"{tname}.{fk['name'] or 'fk'}"},
                    render=f"{tname}.{fk['column']} → {fk['ref_table']}.{fk['ref_column']}"
                           f"（外键，暗示 {fk['ref_table']} 一对多 {tname}）",
                    raw=fk, order=order, tags=["fk"]))
                order += 1

        doc.structured = {"tables": tables}
        if not tables:
            doc.findings.append(Finding(
                "no_tables", "文件里没有 CREATE TABLE 语句", {}, severity="warn"))
        return doc


def _table_name(stmt: Any) -> str:
    t = stmt.this
    name = getattr(getattr(t, "this", None), "name", None) or getattr(t, "name", "")
    return str(name)


def _columns(stmt: Any, comments: dict[str, str]) -> tuple[list[dict], list[str], list[dict]]:
    from sqlglot import exp

    cols: list[dict[str, Any]] = []
    pks: list[str] = []
    fks: list[dict[str, Any]] = []

    schema = stmt.this
    for e in (schema.expressions if hasattr(schema, "expressions") else []):
        if isinstance(e, exp.ColumnDef):
            name = e.name
            constraints = [type(c.kind).__name__ for c in (e.constraints or [])]
            if "PrimaryKeyColumnConstraint" in constraints:
                pks.append(name)
            cols.append({
                "name": name,
                "type": e.args.get("kind").sql() if e.args.get("kind") else "UNKNOWN",
                "nullable": "NotNullColumnConstraint" not in constraints,
                # 口径可能在 `-- 行注释`（行扫描）里，也可能在行内 `COMMENT '...'`（AST）里
                "comment": comments.get(name.lower(), "") or _inline_comment(e),
            })
        elif isinstance(e, exp.PrimaryKey):
            pks.extend(c.name for c in e.expressions if hasattr(c, "name"))
        elif isinstance(e, exp.ForeignKey):
            fks.extend(_fk_edges(e, None))
        elif isinstance(e, exp.Constraint):
            for inner in e.expressions:
                if isinstance(inner, exp.ForeignKey):
                    fks.extend(_fk_edges(inner, e.name))
                elif isinstance(inner, exp.PrimaryKey):
                    pks.extend(c.name for c in inner.expressions if hasattr(c, "name"))
    return cols, list(dict.fromkeys(pks)), fks


def _inline_comment(coldef: Any) -> str:
    """行内 ``COMMENT '...'`` → 文本（MySQL/Oracle 常这么写口径）。"""
    for c in (coldef.constraints or []):
        if type(c.kind).__name__ == "CommentColumnConstraint":
            lit = getattr(c.kind, "this", None)
            return str(getattr(lit, "this", lit) or "")
    return ""


def _fk_edges(fk: Any, con_name: str | None) -> list[dict[str, Any]]:
    """外键 → 边列表。源列与引用列**按位配对** —— 复合外键 (x,y)→(x,y) 才不会
    全指向第一个引用列。"""
    ref = fk.args.get("reference")
    ref_tbl = ""
    ref_cols: list[str] = []
    if ref is not None:
        sub = ref.this
        ref_tbl = getattr(getattr(sub, "this", None), "name", "") or getattr(sub, "name", "")
        ref_cols = [x.name for x in (getattr(sub, "expressions", None) or [])]
    out: list[dict[str, Any]] = []
    for i, c in enumerate(fk.expressions):
        rc = ref_cols[i] if i < len(ref_cols) else (ref_cols[0] if ref_cols else "")
        out.append({"name": con_name, "column": c.name,
                    "ref_table": str(ref_tbl), "ref_column": str(rc)})
    return out


def _column_comments(sql: str) -> dict[str, dict[str, str]]:
    """按行号把 ``--`` 注释关联回列。

    AST 不保证保留注释位置，而口径信息几乎全在注释里 —— 所以宁可用行扫描这种
    土办法，也不能丢。
    """
    out: dict[str, dict[str, str]] = {}
    table = ""
    for line in sql.splitlines():
        if m := re.search(r"create\s+table\s+(?:if\s+not\s+exists\s+)?"
                          r"[`\"\[]?([\w.]+)[`\"\]]?", line, re.I):
            table = m.group(1).split(".")[-1]
            out.setdefault(table, {})
            continue
        if not table:
            continue
        cm = _LINE_COMMENT.search(line)
        if not cm:
            continue
        head = line[: cm.start()]
        if _NON_COL.match(head):
            continue
        if im := _IDENT.match(head):
            out.setdefault(table, {})[im.group(1).lower()] = cm.group(1)
    return out
