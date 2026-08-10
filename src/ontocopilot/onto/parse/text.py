"""文本类材料 —— docx / md / txt。

流程说明文档的价值集中在**规则句**里："一个执行计划可拆入多个采购包"这一句
直接决定 LinkType 的基数。所以切片按**标题层级**分段而不是按固定长度切 ——
固定长度会把一条规则切成两半，两半都失去意义。

docx 里的表格单独抽出来，它们通常是字段清单，比正文更结构化。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .base import Finding, ParsedDoc, Parser, make_chunk

#: 一个切片的软上限（字符）。超了就在句号处切开，不硬切。
SECTION_SOFT_LIMIT = 1200

#: 建模相关的规则句特征。命中的切片打 rule 标签，检索时（tag boost）优先。
#: **领域无关 + 双语**：Copilot 面向很多业务域和语言，线索只认"建模语义"（基数、
#: 约束、关系、键、口径），不夹带 含税/不含税 这种某个域独有的词 —— 那是例子不是
#: 规则线索。漏标不致命：rule 只是加权项，不是硬门禁。
_RULE_HINTS = re.compile(
    r"一个|每个|多个|至少|最多|必须|不得|应当|需要"
    r"|由.{0,8}(生成|产生|创建|拆分|合并|触发|派生)"
    r"|对应|关联|引用|属于|一对多|多对多|一对一|唯一|主键|外键|默认|枚举|取值|口径|为准"
    r"|\beach\b|\bevery\b|\bat least\b|\bat most\b|\bexactly one\b|\bmultiple\b|\bmany\b"
    r"|\bmust\b|\bshall\b|\bcannot\b|\brequired\b|\boptional\b|\bmandatory\b"
    r"|\breferences?\b|\bbelongs? to\b|\bassociated\b|\bone-to-many\b|\bmany-to-many\b"
    r"|\bunique\b|\bprimary key\b|\bforeign key\b",
    re.IGNORECASE)

_HEADING = re.compile(r"^\s*(#{1,6}\s+|第[一二三四五六七八九十百]+[章节条]|"
                      r"\d+(\.\d+)*[、.\s]|[一二三四五六七八九十]+[、.])\s*")

#: 标题层级号（Heading N / 标题 N），拿不到就退回按编号深度推断。
_HEADING_LVL = re.compile(r"(?:heading|标题)\s*(\d)", re.IGNORECASE)
_NUM_PREFIX = re.compile(r"\s*(\d+(?:\.\d+)*)")


def _is_heading(style: str | None, text: str) -> bool:
    """标题判定：Word 的 Heading 样式、本地化的"标题"样式，或编号/井号格式。

    材料来自很多业务域、很多语言，样式名不能只认英文 ``heading``。
    """
    s = (style or "").lower()
    return (s.startswith("heading") or "标题" in (style or "")
            or bool(_HEADING.match(text)))


def _heading_level(style: str | None, text: str) -> int:
    """标题层级：优先按样式号（Heading 2 → 2），否则按编号深度（``3.2.1`` → 3）。"""
    if m := _HEADING_LVL.search(style or ""):
        return int(m.group(1))
    if m := _NUM_PREFIX.match(text):
        return m.group(1).count(".") + 1
    if re.match(r"\s*第[一二三四五六七八九十百]+节", text):
        return 2
    return 1


class TextParser(Parser):
    """md / txt / 兜底。"""

    kind = "text"
    extensions = (".md", ".txt", ".markdown", ".rst")

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        from .tabular import _read_text

        text, enc = _read_text(path)
        if enc != "utf-8":
            doc.findings.append(Finding("encoding_guess", f"按 {enc} 解码", {}))
        blocks = [(_heading_of(b), b) for b in _split_sections(text)]
        _emit(doc, blocks, file_id, path.name, kind="para")
        doc.structured = {"sections": len(blocks), "chars": len(text)}
        return doc


class DocxParser(Parser):
    kind = "docx"
    extensions = (".docx",)

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        import docx

        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        d = docx.Document(str(path))

        core = d.core_properties
        meta = {k: v for k, v in (
            ("creator", core.author), ("last_modified_by", core.last_modified_by),
            ("modified", str(core.modified) if core.modified else None),
            ("title", core.title)) if v}
        doc.meta.update(meta)
        if leaked := {k: v for k, v in meta.items()
                      if k in ("creator", "last_modified_by")}:
            doc.findings.append(Finding(
                "metadata_leak",
                "文档元数据里带着作者信息（" +
                "；".join(f"{k}={v}" for k, v in leaked.items()) +
                "），对外发布前建议清理。",
                {"kind": "meta", "field": "docProps/core.xml"}, severity="warn"))

        # 正文：按标题层级聚段。current 记的是**标题面包屑**（H1 > H2 > H3），
        # 不是最近一级标题 —— 规则句脱离它所属的流程层级就容易误读。
        stack: list[tuple[int, str]] = []
        current = ""
        buf: list[str] = []
        blocks: list[tuple[str, str]] = []
        for p in d.paragraphs:
            t = (p.text or "").strip()
            if not t:
                continue
            if _is_heading(p.style.name, t):
                if buf:
                    blocks.append((current, "\n".join(buf)))
                    buf = []
                lvl = _heading_level(p.style.name, t)
                while stack and stack[-1][0] >= lvl:
                    stack.pop()
                stack.append((lvl, t))
                current = " > ".join(x for _, x in stack)
            else:
                buf.append(t)
                if sum(len(x) for x in buf) > SECTION_SOFT_LIMIT:
                    blocks.append((current, "\n".join(buf)))
                    buf = []
        if buf:
            blocks.append((current, "\n".join(buf)))
        order = _emit(doc, blocks, file_id, path.name, kind="para")

        # 表格单独抽 —— 通常是字段清单，比正文更结构化
        tables: list[dict[str, Any]] = []
        for ti, tbl in enumerate(d.tables):
            rows = [[c.text.strip() for c in r.cells] for r in tbl.rows]
            rows = [r for r in rows if any(r)]
            if not rows:
                continue
            header, body = rows[0], rows[1:]
            tables.append({"index": ti, "columns": header, "rows": len(body)})
            for ri, row in enumerate(body):
                doc.chunks.append(make_chunk(
                    doc_id=f"t{ti}r{ri}", file_id=file_id, file_name=path.name,
                    locator={"kind": "page", "page": ti + 1,
                             "bbox": [0, 0, 0, 0], "table": ti, "row": ri + 1},
                    render=" | ".join(f"{header[i]}={v}" for i, v in enumerate(row)
                                      if i < len(header) and v),
                    order=order, tags=["table"]))
                order += 1

        doc.structured = {"sections": len(blocks), "tables": tables}
        return doc


# ══════════════════════════════════════════════════════════════════
def _split_sections(text: str) -> list[str]:
    out: list[str] = []
    buf: list[str] = []
    for line in text.splitlines():
        if _HEADING.match(line) and buf:
            out.append("\n".join(buf).strip())
            buf = []
        buf.append(line)
        if sum(len(x) for x in buf) > SECTION_SOFT_LIMIT:
            joined = "\n".join(buf)
            cut = max(joined.rfind("。"), joined.rfind("\n\n"))
            if cut > len(joined) // 2:  # 在句号处切，不把规则句劈成两半
                out.append(joined[: cut + 1].strip())
                buf = [joined[cut + 1 :]]
            else:
                out.append(joined.strip())
                buf = []
    if buf and "\n".join(buf).strip():
        out.append("\n".join(buf).strip())
    return [b for b in out if b]


def _heading_of(block: str) -> str:
    first = block.strip().splitlines()[0] if block.strip() else ""
    return first[:60] if _HEADING.match(first) else ""


def _emit(doc: ParsedDoc, blocks: list[tuple[str, str]], file_id: str,
          file_name: str, *, kind: str) -> int:
    order = 0
    for heading, body in blocks:
        if not body.strip():
            continue
        is_rule = bool(_RULE_HINTS.search(body))
        doc.chunks.append(make_chunk(
            doc_id=f"s{order}", file_id=file_id, file_name=file_name,
            locator={"kind": "page", "page": 1, "bbox": [0, 0, 0, 0],
                     "section": heading or f"§{order + 1}"},
            render=(f"〔{heading}〕\n" if heading else "") + body,
            order=order, tags=[kind] + (["rule"] if is_rule else [])))
        order += 1
    return order
