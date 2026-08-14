"""DDL 解析器的 golden —— 给 TS 侧那份**本地**实现（node-sql-parser + 行扫描）做对照。

`tools/golden/onto_parse.py` 里已经有一份 `sql` 段，但它导的是"sidecar 线上形态
→ 薄封装接回来"的形状；sqlglot 被换掉之后，TS 侧要比的不再是"搬字段搬对没有"，
而是**同一段 DDL 解析出来的东西一不一样**。所以这里单独导一份：

* `tests/test_parse_ddl.py` 那 9 条（七种写法 + 两条语义断言）逐字搬过来 ——
  它们是「注释一条都不能丢」这件事的现场；
* 另加一批**边角写法**，专门用来量出行扫描与 AST 两条来源的分工边界：
  注释单独占一行、注释跟在 `PRIMARY KEY` 后面、反引号列名、注释文本里出现引号、
  字符串字面量里出现 `--`、块注释、schema 限定表名。这些 pytest 没覆盖，
  但 TS 侧换了解析器之后正是最容易悄悄跑偏的地方 —— 导出来才知道 Python 到底
  给什么，而不是我猜它给什么。

每条同时导 `comments`（`{列名: 注释}`，与 pytest 的断言同形）和 `doc`
（整份 ParsedDoc 的 dict —— 类型串、主键、外键、切片 render 一并钉住）。

跑法::

    .venv/bin/python tools/golden/onto_parse_sql.py

输出 ``golden/onto.parse.sql.json``。重跑两次 shasum 必须一致。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.parse.sql import DdlParser  # noqa: E402

FIXED_ID = "f_0123456789ab"


def chunk_d(c: Any) -> dict[str, Any]:
    return {"chunk_id": c.chunk_id, "file_id": c.file_id, "file_name": c.file_name,
            "locator": c.locator, "render": c.render, "raw": c.raw, "order": c.order,
            "tags": c.tags, "context": c.context}


def doc_d(d: Any) -> dict[str, Any]:
    return {"file_id": d.file_id, "file_name": d.file_name, "kind": d.kind,
            "chunks": [chunk_d(c) for c in d.chunks], "structured": d.structured,
            "findings": [{"kind": f.kind, "message": f.message, "locator": f.locator,
                          "severity": f.severity} for f in d.findings],
            "meta": d.meta}


# ══════════════════════════════════════════════════════════════════
#  用例
#
#  前 9 条 = tests/test_parse_ddl.py 的全部（7 条参数化 + 2 条语义断言里
#  用到的 4 段 DDL）。后面是 pytest 没覆盖、但换解析器最容易踩的边角。
# ══════════════════════════════════════════════════════════════════
CASES: list[tuple[str, str, str | None]] = [
    # ── pytest 的 7 条参数化 ────────────────────────────────────────
    ("列与 CREATE TABLE 挤在同一行",
     "CREATE TABLE t (a DECIMAL(18,2) -- 含税·年度累计\n);", None),
    ("中间列 + 尾随逗号",
     "CREATE TABLE t (\n  a DECIMAL(18,2), -- 含税·年度累计\n  b VARCHAR(32)\n);", None),
    ("末列无逗号",
     "CREATE TABLE t (\n  a VARCHAR(32),\n  b DECIMAL(18,2) -- 归口部门\n);", None),
    ("COMMENT 子句（MySQL/Oracle 写法）",
     "CREATE TABLE t (\n  a DECIMAL(18,2) COMMENT '含税·年度累计'\n);", None),
    ("两列各带一条",
     "CREATE TABLE t (\n  a INT, -- 第一条\n  b INT -- 第二条\n);", None),
    ("没有注释就是空串，不是 None",
     "CREATE TABLE t (\n  a INT\n);", None),
    ("单行写完整张表",
     "CREATE TABLE t (a INT -- 编号\n, b INT -- 数量\n);", None),
    # ── pytest 的两条语义断言用到的 DDL ─────────────────────────────
    ("三来源同形·同一行",
     "CREATE TABLE t (a INT --    含税·年度累计   \n);", None),
    ("三来源同形·注释独占行尾",
     "CREATE TABLE t (\n  a INT, --    含税·年度累计   \n  b INT\n);", None),
    ("只有注释不同的两张表·A",
     "CREATE TABLE plan_a (plan_amount DECIMAL(18,2) -- 含税·年度累计\n);", None),
    ("只有注释不同的两张表·B",
     "CREATE TABLE plan_b (plan_amount DECIMAL(18,2) -- 不含税·单次\n);", None),

    # ── 以下 pytest 没覆盖 ─────────────────────────────────────────
    ("注释单独占一行（列的下一行）",
     "CREATE TABLE t (\n  a INT,\n  -- 说明在自己那一行\n  b INT\n);", None),
    ("注释跟在 PRIMARY KEY 后面（不该算到列头上）",
     "CREATE TABLE t (\n  a INT,\n  b INT,\n  PRIMARY KEY (a) -- 主键说明\n);", None),
    ("注释跟在 CONSTRAINT 外键后面",
     "CREATE TABLE t (\n  a INT,\n  CONSTRAINT fk FOREIGN KEY (a) REFERENCES h(x) -- 外键说明\n);",
     None),
    ("反引号列名",
     "CREATE TABLE t (\n  `order` INT, -- 订单号\n  b INT\n);", "mysql"),
    ("注释文本里带引号和破折号",
     "CREATE TABLE t (\n  a INT -- 口径：'含税' -- 再补一句\n);", None),
    ("字符串字面量里出现 --",
     "CREATE TABLE t (\n  a VARCHAR(8) DEFAULT 'a--b', -- 真注释\n  b INT\n);", None),
    ("块注释 /* */",
     "CREATE TABLE t (\n  a INT, /* 块注释口径 */\n  b INT\n);", None),
    ("NOT NULL + 内联 PRIMARY KEY + 注释",
     "CREATE TABLE t (\n  a VARCHAR(32) NOT NULL PRIMARY KEY, -- 主键口径\n  b INT\n);", None),
    ("schema 限定表名",
     "CREATE TABLE dbo.t (\n  a INT -- 说明\n);", None),
    ("IF NOT EXISTS",
     "CREATE TABLE IF NOT EXISTS t (\n  a INT -- 说明\n);", None),
    ("复合主键 + 复合外键（按位配对）",
     "CREATE TABLE line (\n  a VARCHAR(8) COMMENT '行内注释口径',\n  b VARCHAR(8),\n"
     "  PRIMARY KEY (a, b),\n  CONSTRAINT fk_ab FOREIGN KEY (a, b) REFERENCES head(x, y)\n);",
     None),
    ("两张表 + 表级切片 + 外键切片",
     "-- 采购中台物理模型\nCREATE TABLE pbp_header (\n"
     "  plan_id      VARCHAR(32) NOT NULL PRIMARY KEY,\n"
     "  plan_name    VARCHAR(200),\n"
     "  plan_amount  DECIMAL(18,2),   -- 含税·年度累计·CNY\n"
     "  created_at   TIMESTAMP\n);\n\nCREATE TABLE clm_contract (\n"
     "  contract_id  VARCHAR(32) NOT NULL PRIMARY KEY,\n"
     "  plan_id      VARCHAR(32) NOT NULL,\n"
     "  plan_amount  DECIMAL(18,2),   -- 不含税·单次·CNY\n"
     "  CONSTRAINT fk_plan FOREIGN KEY (plan_id) REFERENCES pbp_header(plan_id)\n);\n",
     None),
    ("没有 CREATE TABLE",
     "SELECT 1;\n", None),
    ("解析不了的 DDL",
     "CREATE TABLE ( ( ( ;\n", None),
    ("方言 mysql",
     "CREATE TABLE t (\n  a TIMESTAMP, -- 时间\n  b INT UNSIGNED\n);", "mysql"),
    ("方言 postgres",
     "CREATE TABLE t (\n  a TIMESTAMP WITH TIME ZONE, -- 时间\n  b SERIAL\n);", "postgres"),
]


def main() -> None:
    out: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as td:
        for name, ddl, dialect in CASES:
            p = Path(td) / "schema.ddl"
            p.write_text(ddl, encoding="utf-8")
            doc = DdlParser(dialect=dialect).parse(p, file_id=FIXED_ID)
            tables = doc.structured.get("tables") or []
            comments = ({c["name"]: c["comment"] for c in tables[0]["columns"]}
                        if tables else {})
            out.append({"name": name, "ddl": ddl, "dialect": dialect,
                        "file_id": FIXED_ID, "file_name": "schema.ddl",
                        "comments": comments, "doc": doc_d(doc)})

    dest = ROOT / "golden" / "onto.parse.sql.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, indent=1) + "\n",
                    encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
