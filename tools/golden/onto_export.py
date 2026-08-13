"""导出 onto/export.py + onto/template_plan.py 的 golden —— 给 TS 侧当安全网。

这两个模块一个都没有现成 golden：`tests/test_export.py` 里大半的断言是「含有某个
子串」，而 TS 侧最容易漂的恰恰是**没被断言到的那部分**（csv 的引号规则、markdown
的空行位置、xlsx 的列宽算式、文件名截断的边界）。所以这里把五条路的**完整产物**
逐字导出来：

  1. `blocks_from_markdown` 的块列表（含一批专挑 Python/JS 正则分叉的用例：
     `\\d` 认不认阿拉伯-印度数字、`\\w` 认不认汉字、`\\s` 认不认 U+0085/U+FEFF）。
  2. `to_markdown` / `to_csv` / `doc_to_html` 的**完整字节**（csv 走 base64，
     因为它带 BOM 且行尾是 CRLF —— 存成 JSON 字符串会被编辑器悄悄改掉）。
  3. `to_xlsx` 用 openpyxl 读回来的逐格 dump（值、data_type、列宽、冻结、筛选）。
     **不比字节**：TS 侧不可能复现 openpyxl 的 XML 排布，能对齐的是语义。
  4. `to_docx` 用 python-docx 读回来的段落/表格 dump（含 Normal 样式的 w:eastAsia）。
  5. `resolve_format` / `safe_name` 的向量表。
  6. `template_plan.plan_prompt` 的完整提示词 + `apply_plan` 的 (applied, rejected)。

跑法::

    .venv/bin/python tools/golden/onto_export.py

产物 golden/onto.export.json。**字节确定**：输入全是本文件里的字面量，xlsx/docx
写在内存 BytesIO 里、只把读回来的内容入库（不落临时路径、不带时间戳）。
重跑两次 shasum 一致。

**pdf 没有 golden**：pymupdf 属于迁移约定 §2.3 里留在 Python sidecar 的三样之一，
TS 侧不写替身。能钉住的是 `doc_to_html`（PDF 的唯一输入），它在第 2 条里。
"""

from __future__ import annotations

import base64
import io
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.onto.export import (  # noqa: E402
    FORMATS,
    SPECS,
    Block,
    ExportDoc,
    blocks_from_markdown,
    doc_to_html,
    render,
    resolve_format,
    safe_name,
    table_block,
)
from ontocopilot.onto.template import (  # noqa: E402
    Cell,
    Role,
    Sheet,
    TemplateSpec,
)
from ontocopilot.onto.template_plan import apply_plan, plan_prompt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "golden"


# ══════════════════════════════════════════════════════════════════
#  素材
# ══════════════════════════════════════════════════════════════════
#: 与 tests/test_export.py 的 TABLE_MD 逐字一致 —— 那是这条路真实跑过的输入。
TABLE_MD = """已为您列出 3 条待澄清问题。

#### 1. 核心实体定位
*（单据上的每一个字段）*

| 节点 | 编号 | 澄清问题 | 参考选项 |
| :--- | :--- | :--- | :--- |
| （1）编制集采计划 | 1 | 什么情况下使用集采？ | - |
| （1）编制集采计划 | 3 | 输入栏写了"无系统节点" | ① 全线下 ② 系统里编 |
| （2）审批 | 4 | =SUM(A1) 会不会被当成公式 | - |

- 字段信息缺失：175 个对象没有字段
  - 需要《字段梳理表》
1. 命名规范不统一

---

```json
{"a": 1, "b": [2, 3]}
```
"""

#: 逐个挑正则分叉的用例。名字就是它盯的那条分叉。
MD_CASES: dict[str, str] = {
    "table_md": TABLE_MD,
    # 只有标记没内容的行不算一条（模型经常写出光秃秃的 "- "）
    "empty_markers": "- \n- 真的有内容\n-  \n",
    # `\d` 在 Python str 模式下是整个 Nd 类；JS 的 `\d` 只有 [0-9]
    "arabic_indic_digit_marker": "٣. 阿拉伯-印度数字序号\n1. 普通序号\n",
    # `\w` 在 Python 里含汉字 → 汉字紧邻时 `*斜体*` 不成立；JS 的 `\w` 不含
    "inline_star_next_to_cjk": "前*不是斜体*后\n\n空格 *是斜体* 空格\n",
    "inline_marks": "**粗**与`码`与*斜*混排\n",
    # `\s` 的两边差集：Python 认 U+0085(NEL) 不认 U+FEFF，JS 反过来
    "nel_and_bom_whitespace": "# 前面是 NEL\n﻿# 前面是 BOM\n",
    # 表格必须紧跟分隔行才算表；不然是普通段落
    "pipe_without_separator": "| 甲 | 乙 |\n| 丙 | 丁 |\n",
    "table_then_text": "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n收尾一句话\n",
    # 围栏没闭合：剩下的全进代码块
    "unclosed_fence": "```py\nx = 1\n\n还在代码里\n",
    "fence_empty_lang": "```\nplain\n```\n",
    # 标题右侧的收尾 # 要吃掉；层级取左侧 # 的个数
    "heading_trailing_hash": "### 标题 ###\n###### 六级 ######\n####### 七个不是标题\n",
    "rules": "---\n***\n___\n- - -\n",
    # 列表被正文打断 → 列表先收尾，正文另起一块
    "list_interrupted": "- 一\n- 二\n正文打断\n- 三\n",
    # 制表符缩进按 4 空格折算，depth = 空白长度 // 2
    "tab_indent": "- 零级\n\t- 制表符一级\n    - 四空格一级\n      - 六空格三级\n",
    "empty": "",
    "only_blank_lines": "\n\n   \n",
    # 表里的空格子 / 行内标记 / 首尾竖线
    "table_ragged": "| a | b | c |\n| --- | --- | --- |\n| 1 |  | **粗** |\n| 只有一格 |\n",
}


def _doc() -> ExportDoc:
    return ExportDoc(title="采购计划 待澄清问题",
                     blocks=blocks_from_markdown(TABLE_MD),
                     note="共 3 条，由 OntoCopilot 导出")


def _injection_doc() -> ExportDoc:
    """内容是**别人给的**：一格 `=HYPERLINK(...)` 在 FDE 双击打开时会被求值。"""
    return ExportDoc(
        title="=1+1 报表",
        blocks=[Block("para", "=WEBSERVICE(1)"),
                *table_block(['=cmd|\'/c calc\'!A1', "正常列"],
                             [["=HYPERLINK(1)", "+1"]])],
        note="=2+2")


def _collide_doc() -> ExportDoc:
    """Excel 表名的三条硬规矩：≤31 字符、不能有 \\/*?:[]、不能重名。"""
    long = "报表/明细[2026]:第一版 " + "长" * 40
    return ExportDoc(title="x", blocks=[
        *table_block(["a"], [["1"]], title=long),
        *table_block(["a"], [["2"]], title=long),
        *table_block(["a"], [["3"]], title=long),
    ])


def _prose_only_doc() -> ExportDoc:
    """一张表都没有：csv 退化成一列正文，xlsx 只有一张「内容」页。"""
    return ExportDoc(title="没有表的一份东西",
                     blocks=blocks_from_markdown("# 标题\n\n正文一段。\n\n- 列表项\n\n---\n"),
                     note="")


def _typed_doc() -> ExportDoc:
    """标量原样进格子（int/float/bool/None），别的 str 化。"""
    b = Block("table", columns=["名", "值"],
              rows=[["整数", 42], ["小数", 3.5], ["真", True],
                    ["空", None], ["列表", [1, 2]], ["长文本", "长" * 80]])
    return ExportDoc(title="类型", blocks=[b], note="")


DOCS: dict[str, Any] = {
    "table_doc": _doc,
    "injection": _injection_doc,
    "collide": _collide_doc,
    "prose_only": _prose_only_doc,
    "typed": _typed_doc,
}


# ══════════════════════════════════════════════════════════════════
#  dump 助手
# ══════════════════════════════════════════════════════════════════
def block_dict(b: Block) -> dict[str, Any]:
    return {"kind": b.kind, "text": b.text, "level": b.level,
            "items": [list(x) for x in b.items],
            "columns": list(b.columns), "rows": [list(r) for r in b.rows]}


def doc_dict(d: ExportDoc) -> dict[str, Any]:
    return {"title": d.title, "note": d.note,
            "blocks": [block_dict(b) for b in d.blocks]}


def xlsx_dump(data: bytes) -> dict[str, Any]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data))
    sheets = []
    for ws in wb.worksheets:
        cells = []
        for row in ws.iter_rows():
            cells.append([{"v": c.value, "t": c.data_type} for c in row])
        widths = {k: v.width for k, v in sorted(ws.column_dimensions.items())}
        sheets.append({
            "title": ws.title,
            "max_row": ws.max_row,
            "max_column": ws.max_column,
            "dimensions": ws.dimensions,
            "freeze_panes": ws.freeze_panes,
            "auto_filter": ws.auto_filter.ref,
            "widths": widths,
            "cells": cells,
        })
    return {"sheetnames": wb.sheetnames, "sheets": sheets}


def docx_dump(data: bytes) -> dict[str, Any]:
    import docx
    from docx.oxml.ns import qn

    d = docx.Document(io.BytesIO(data))
    rpr = d.styles["Normal"].element.rPr
    return {
        "east_asia": rpr.rFonts.get(qn("w:eastAsia")),
        "ascii_font": rpr.rFonts.get(qn("w:ascii")),
        "paragraphs": [{"style": p.style.name, "text": p.text} for p in d.paragraphs],
        "tables": [[[c.text for c in r.cells] for r in t.rows] for t in d.tables],
    }


# ══════════════════════════════════════════════════════════════════
#  template_plan
# ══════════════════════════════════════════════════════════════════
def _plan_spec() -> TemplateSpec:
    """一份手搭的最小 spec（两张表、各两行），够跑遍五个白名单 op。

    不用 compile_template：那要一整份 OIR，而这里要钉的是 apply_plan 的**逐条
    独立**语义 —— 一条违规只丢那一条，其余照常应用。
    """
    def cell(rid: str, sheet: str, field: str, value: str, role: Role,
             **kw: Any) -> Cell:
        return Cell(rid=rid, sheet=sheet, field=field, value=value, role=role, **kw)

    s1 = Sheet(name="01_对象清单", guide="先填这张", columns=["displayName", "definition"])
    for rid, name in (("o1", "采购包"), ("o2", "供应商")):
        s1.rows.append({
            "displayName": cell(rid, s1.name, "displayName", name, Role.PREFILLED),
            "definition": cell(rid, s1.name, "definition", "", Role.REQUIRED,
                               expects_prose=True),
        })
    s2 = Sheet(name="02_关系", guide="", columns=["cardinality", "primaryKey"])
    for rid in ("l1", "l2"):
        s2.rows.append({
            "cardinality": cell(rid, s2.name, "cardinality", "1:N", Role.PREFILLED,
                                options=["1:1", "1:N", "N:N"]),
            "primaryKey": cell(rid, s2.name, "primaryKey", "", Role.PREFILLED),
        })
    return TemplateSpec(sheets=[s1, s2], round=1)


#: 五条合法的 + 五条必须被拒的。**每一条的 why_rejected 都要逐字对上** ——
#: 那句话会被原样转述给用户和模型。
PLAN_EDITS: list[dict[str, Any]] = [
    {"op": "rename_column", "sheet": "01_对象清单", "old": "definition",
     "new": "口径定义", "why": "业务方读不懂 definition"},
    {"op": "set_guide", "sheet": "02_关系", "text": "一行一个关系", "why": "没有说明"},
    {"op": "set_options", "sheet": "02_关系", "column": "cardinality",
     "options": ["1:1", "1:N"], "why": "材料里只出现过这两种"},
    {"op": "set_role", "sheet": "01_对象清单", "column": "displayName",
     "role": "required", "why": "名字必须确认"},
    {"op": "reorder_sheets", "order": ["02_关系", "01_对象清单"], "why": "关系更急"},
    # ── 以下五条应当被守卫拒掉 ──────────────────────────────────
    {"op": "drop_column", "sheet": "01_对象清单", "column": "口径定义",
     "why": "白名单外的 op"},
    {"op": "rename_column", "sheet": "01_对象清单", "old": "_oir_rid",
     "new": "编号", "why": "锚点列改不得"},
    {"op": "set_role", "sheet": "02_关系", "column": "primaryKey",
     "role": "required", "why": "黑名单字段"},
    {"op": "reorder_sheets", "order": ["01_对象清单"], "why": "少了一张表"},
    {"op": "set_guide", "sheet": "根本没有这张表", "text": "x", "why": "表名不存在"},
    # 参数不对（Python 侧由 CPython 抛 TypeError 再包成 EditError）
    {"op": "set_options", "sheet": "02_关系", "why": "少了 column 和 options"},
]


def template_plan_golden() -> dict[str, Any]:
    spec = _plan_spec()
    before = spec.to_dict()
    applied, rejected = apply_plan(spec, PLAN_EDITS)
    prompt = plan_prompt(
        project="集采平台",
        stats={"objects": 12, "properties": 40},
        sheets=[{"name": sh.name, "rows": len(sh.rows), "columns": list(sh.columns)}
                for sh in _plan_spec().sheets],
        vocabulary=["集采", "采购包", "供应商"] + [f"词{i}" for i in range(45)],
        open_questions=[f"第 {i} 个待澄清问题？" for i in range(12)])
    empty_prompt = plan_prompt(project="", stats={}, sheets=[],
                               vocabulary=[], open_questions=[])
    return {
        "spec_before": before,
        "edits": PLAN_EDITS,
        "applied": applied,
        "rejected": rejected,
        "spec_after": spec.to_dict(),
        # edits 为 None / 空表时不该炸
        "applied_empty": apply_plan(_plan_spec(), [])[0],
        "prompt": prompt,
        "prompt_empty": empty_prompt,
    }


# ══════════════════════════════════════════════════════════════════
#  主
# ══════════════════════════════════════════════════════════════════
FORMAT_WORDS = ["excel", "Excel", "EXCEL", "表格", ".xlsx", "xlsx", " xls ",
                "word", "Word", "doc", "文档", "markdown", "文本", "txt",
                "md", "PDF", "pdf", ".pdf", "spreadsheet", "pptx", "", "  ",
                "..md", ".", "CSV", "csv"]

NAME_CASES = [
    ("采购计划 待澄清问题", "xlsx"),
    ("../../etc/passwd", "xlsx"),
    ("a/b\\c:d*e?f", "xlsx"),
    ("...", "xlsx"),
    ("", "xlsx"),
    (".", "xlsx"),
    ("..", "xlsx"),
    ("  多个   空白\t折成一个  ", "md"),
    ("澄" * 300, "pdf"),
    ("尾部点和空格 . . ", "csv"),
    ("带\x00控制\x1f字符", "docx"),
    ("emoji😀在第八十位附近" + "字" * 70 + "😀尾", "md"),
    ("CON", "md"),
    ("　全角空格开头", "md"),
]


def main() -> None:
    out: dict[str, Any] = {}

    out["blocks"] = {name: [block_dict(b) for b in blocks_from_markdown(text)]
                     for name, text in MD_CASES.items()}
    out["md_cases"] = MD_CASES

    docs = {name: fn() for name, fn in DOCS.items()}
    out["docs"] = {name: doc_dict(d) for name, d in docs.items()}

    out["markdown"] = {}
    out["csv"] = {}
    out["html"] = {}
    out["xlsx"] = {}
    out["docx"] = {}
    for name, d in docs.items():
        out["markdown"][name] = render(d, "md")[0].decode("utf-8")
        out["csv"][name] = base64.b64encode(render(d, "csv")[0]).decode("ascii")
        out["html"][name] = doc_to_html(d)
        out["xlsx"][name] = xlsx_dump(render(d, "xlsx")[0])
        out["docx"][name] = docx_dump(render(d, "docx")[0])

    out["specs"] = {k: {"ext": s.ext, "media_type": s.media_type, "label": s.label}
                    for k, s in SPECS.items()}
    out["formats"] = list(FORMATS)
    out["resolve_format"] = [[w, resolve_format(w)] for w in FORMAT_WORDS]
    out["safe_name"] = [[t, e, safe_name(t, e)] for t, e in NAME_CASES]
    out["safe_name_fallback"] = safe_name("", "md", fallback="兜底")
    out["template_plan"] = template_plan_golden()

    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / "onto.export.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")
    print(f"wrote {p} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
