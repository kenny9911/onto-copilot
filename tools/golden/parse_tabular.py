"""onto/parse/tabular 的 golden 导出器。

这个模块的输出（列画像、类型推断、表头位置、逐行 render）是下游形状推断的**输入**，
一个字段偏了，问题清单和流程图就跟着偏。所以 TS 侧一条期望值都不许手写 —— 全部
从这里导。

导三类东西：

1. **纯函数向量**：``infer_type`` / ``profile_column`` / ``detect_header_row`` /
   ``dedupe_headers`` / ``_render_pairs`` / ``_fill_hierarchy`` / ``_read_text``。
   用例专挑 Python 与 JS 会分叉的地方：``Number("") === 0`` 而 ``int("")`` 抛、
   ``\\d`` 在 Python 里认全角数字、``str.strip()`` 与 ``trim()`` 的空白集不同、
   ``len()`` 数码点而 ``.length`` 数码元。

2. **``golden/材料.xlsx`` 的完整解析结果**。它是主导出器合成的真实业务材料，
   pipeline.*.json 就是从它跑出来的 —— 这里把上游那一层（ParsedDoc）也钉死。

3. **``golden/tabular.hard.xlsx``** —— 本文件**手写 XML** 造出来的硬骨头。
   openpyxl 写不出公式缓存值、错误值、inlineStr，也很难精确控制 min_row/min_col，
   而这四样正是 JS 侧 xlsx 选型最容易翻车的地方，所以整包 XML 自己写：

     · 日期序列号（date / datetime / time / 自定义格式）与 ``[h]:mm:ss`` timedelta；
     · 公式缓存值（数字结果与 ``t="str"`` 字符串结果）、``t="e"`` 错误值、inlineStr；
     · 合并单元格（横向分组标题 + 纵向续行）、中间空行、末尾空行；
     · 数据从 C5 起（min_row=5 / min_col=3）—— openpyxl 的 ``iter_rows()`` 从
       **有值的第一行/列**开始，而 ``_read_sheet`` 的 grid 下标被当成"第 1 行"用。
       这个错位是 Python 侧的既有行为，TS 侧必须**照样错**，不许"顺手修正"；
     · 批注（含只落在空单元格上的批注）；
     · 整数 1 与浮点 1.0 —— Python ``str()`` 给 "1" 和 "1.0"，JS 两边都是 "1"。
       这条分叉必须在 golden 里看得见，才不会被悄悄抹平。

跑法::

    .venv/bin/python tools/golden/parse_tabular.py

输出 ``golden/tabular.json`` + ``golden/tabular.hard.xlsx``（都是新文件，不碰别人的）。
CSV 用例的**字节**base64 内嵌在 json 里而不是落成文件：其中有 GBK 与非法字节，
落成文本文件迟早被编辑器或 git 的换行处理改掉，那样 TS 侧就是在拿另一份输入比对。
"""

from __future__ import annotations

import base64
import binascii
import datetime
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "golden"

from ontocopilot.onto.parse.tabular import (  # noqa: E402
    CsvParser,
    XlsxParser,
    _fill_hierarchy,
    _read_sheet,
    _read_text,
    _render_pairs,
    dedupe_headers,
    detect_header_row,
    infer_type,
    profile_column,
)

# ══════════════════════════════════════════════════════════════════
#  手写 xlsx —— 每一段 XML 都对着 openpyxl 的读取路径写
# ══════════════════════════════════════════════════════════════════
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

#: cellXfs 下标 → 用途。numFmtId 的取值决定 openpyxl 把数字转不转成日期：
#: ``is_date_format`` 看的是格式串里有没有 dmhys（引号内与方括号内的除外）。
#:   0 通用 / 1 日期(14) / 2 日期时间(22) / 3 时间(21) / 4 时长(46 ``[h]:mm:ss``)
#:   5 百分比(9) / 6 文本(49) / 7 自定义日期(164 ``yyyy"年"m"月"``)
STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="{NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/></numFmts>
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill>\
<fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="46" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""

#: 共享串表。``t="s"`` 的 ``<v>`` 是这里的下标。第 3 条故意用富文本分段（``<r>``）
#: 并夹一个拼音段（``<rPh>``）—— openpyxl 的 ``Text.content`` 只拼 ``t`` 与 ``r/t``，
#: 把 rPh 丢掉；JS 侧照抄 sheetjs/exceljs 的默认行为会把拼音也拼进去。
SST_ITEMS = [
    "应用模块",
    "业务对象",
    "实体编码",
    "实体名称",
    "口径说明",
    "采购计划管理",
    "采购需求计划",
    "pbpHeader",
    "采购业务计划头",
    "含税",
    "　全角空格开头",           # U+3000：strip 削得掉，JS trim 也削得掉
    "\ufeff带 BOM 的值",        # U+FEFF：Python strip 削不掉，JS trim 削得掉
]
SST_RICH = ('<si><r><t xml:space="preserve">富文本</t></r><r><t>拼接</t></r>'
            '<rPh sb="0" eb="3"><t>フリガナ</t></rPh></si>')


def _si(text: str) -> str:
    return f'<si><t xml:space="preserve">{_esc(text)}</t></si>'


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _sheet(rows: str, *, dim: str, merges: tuple[str, ...] = (),
           legacy: bool = False) -> str:
    mc = ""
    if merges:
        mc = (f'<mergeCells count="{len(merges)}">'
              + "".join(f'<mergeCell ref="{r}"/>' for r in merges)
              + "</mergeCells>")
    ld = '<legacyDrawing r:id="rIdVml"/>' if legacy else ""
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<worksheet xmlns="{NS}" xmlns:r="{RNS}"><dimension ref="{dim}"/>'
            f"<sheetData>{rows}</sheetData>{mc}{ld}</worksheet>")


# ── sheet1 混合类型 ────────────────────────────────────────────────
# 序列号取值全部手算，别去猜：
#   45000 = 2023-03-15（1899-12-30 起算）；45000.5 = 2023-03-15 12:00
#   0.5 = 12:00:00（0<=v<1 → datetime.time）
#   1.5 配 [h]:mm:ss → timedelta(days=1.5) = "1 day, 12:00:00"
#   45000 配自定义 yyyy"年"m"月" 也是日期（引号里的字不算格式符）
SHEET_MIXED = _sheet(
    ''.join([
        '<row r="1">'
        '<c r="A1" t="s"><v>2</v></c>'
        '<c r="B1" t="s"><v>3</v></c>'
        '<c r="C1" t="s"><v>4</v></c>'
        '<c r="D1" t="inlineStr"><is><t>行内串表头</t></is></c>'
        '<c r="E1" t="s"><v>0</v></c>'
        '<c r="F1" t="s"><v>1</v></c>'
        '<c r="G1" t="s"><v>12</v></c>'
        '</row>',
        # 整数 / 浮点 1.0 / 布尔 / 日期 / 日期时间 / 时间 / 时长
        '<row r="2">'
        '<c r="A2"><v>1</v></c>'
        '<c r="B2"><v>1.0</v></c>'
        '<c r="C2" t="b"><v>1</v></c>'
        '<c r="D2" s="1"><v>45000</v></c>'
        '<c r="E2" s="2"><v>45000.5</v></c>'
        '<c r="F2" s="3"><v>0.5</v></c>'
        '<c r="G2" s="4"><v>1.5</v></c>'
        '</row>',
        # 公式缓存值（数字 / t="str" 字符串）/ 错误值 / 空 <v> / 百分比 / 文本格式数字
        '<row r="3">'
        '<c r="A3"><f>1+2</f><v>3</v></c>'
        '<c r="B3" t="str"><f>CONCAT("含","税")</f><v>含税</v></c>'
        '<c r="C3" t="e"><f>1/0</f><v>#DIV/0!</v></c>'
        '<c r="D3"><v></v></c>'
        '<c r="E3" s="5"><v>0.13</v></c>'
        '<c r="F3" s="6" t="s"><v>9</v></c>'
        '<c r="G3" s="7"><v>45000</v></c>'
        '</row>',
        # 只有样式没有值的单元格 + 全角/BOM。H4 是**最右边**那个空样式格：
        # openpyxl 照样把它收进 _cells，于是 max_column=8、grid 多出一列空列、
        # 表头多出一个 col8。放在最右边才测得出"空样式格算不算数"。
        '<row r="4">'
        '<c r="A4" t="s"><v>10</v></c>'
        '<c r="B4" t="s"><v>11</v></c>'
        '<c r="C4" s="6"/>'
        '<c r="D4"><v>-42</v></c>'
        '<c r="E4"><v>-3.5</v></c>'
        '<c r="F4"><v>1e-05</v></c>'
        '<c r="G4"><v>12345678901234567890</v></c>'
        '<c r="H4" s="6"/>'
        '</row>',
    ]),
    dim="A1:H4")

# ── sheet2 合并 / 空行 / 批注 ──────────────────────────────────────
# 第 1 行是横跨 A:C 的标题（合并区只有左上角有值）；第 4 行整行空；
# 第 5 行的 A 与第 4 行合并（纵向续行）；末尾两行空 —— 会被 _read_sheet 弹掉。
SHEET_MERGE = _sheet(
    ''.join([
        '<row r="1"><c r="A1" t="s"><v>4</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c>'
        '<c r="C2" t="s"><v>2</v></c></row>',
        '<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" t="s"><v>6</v></c>'
        '<c r="C3" t="s"><v>7</v></c></row>',
        # A4 在合并区 A3:A5 的**非左上角**位置上却写着值。openpyxl 先 bind_cells
        # 再 bind_merged_cells，后者把这些格子无条件换成 MergedCell（值 None）——
        # 也就是说这里的 8 号串会被**抹掉**，随后 _read_sheet 再从左上角填回来。
        # 少了"抹掉"这一步，下游看到的是一个早就作废的陈值。
        '<row r="4"><c r="A4" t="s"><v>8</v></c></row>',
        '<row r="5"><c r="C5" t="s"><v>8</v></c></row>',
        '<row r="6"><c r="B6" t="s"><v>9</v></c></row>',
    ]),
    # B6:C6 是**正文行里的横向合并**：填充之后相邻两列同值，_render_pairs 会把它们
    # 并成 `列A~列B=值`。不并的话一行 22 列同值就是同一段话重复 22 遍 —— 真实材料
    # 上就是这么丢掉一整张业务规则表的，所以这条路必须端到端有覆盖。
    dim="A1:C8", merges=("A1:C1", "A3:A5", "B6:C6"), legacy=True)

# ── sheet3 偏移 ────────────────────────────────────────────────────
# 数据从 C5 起。openpyxl 的 iter_rows() 从 min_row=5 / min_col=3 开始，
# 于是 grid[0] 其实是第 5 行、grid 的第 0 列其实是 C 列 —— 而 XlsxParser 拿
# ``h + 2 + ri`` 当 Excel 行号、拿 ``c.column - 1`` 当 grid 列下标。**照样错**。
SHEET_OFFSET = _sheet(
    ''.join([
        '<row r="5"><c r="C5" t="s"><v>2</v></c><c r="D5" t="s"><v>3</v></c></row>',
        '<row r="6"><c r="C6" t="s"><v>7</v></c><c r="D6" t="s"><v>8</v></c></row>',
        '<row r="7"><c r="C7"><v>7</v></c><c r="D7"><v>8</v></c></row>',
    ]),
    dim="C5:D7")

# ── sheet4 空表 ────────────────────────────────────────────────────
SHEET_EMPTY = _sheet("", dim="A1:A1")

# ── sheet5 层级 ────────────────────────────────────────────────────
# 分组列写一次、下面留空（没有做物理合并）—— _fill_hierarchy 的靶子。
SHEET_TREE = _sheet(
    ''.join([
        f'<row r="{i + 1}">' + "".join(
            f'<c r="{chr(65 + j)}{i + 1}" t="inlineStr"><is><t>{_esc(v)}</t></is></c>'
            for j, v in enumerate(row) if v) + "</row>"
        for i, row in enumerate([
            ["应用模块", "业务对象", "字段", "类型", "口径"],
            ["采购计划管理", "采购需求计划", "planNo", "string", "计划编号"],
            ["", "", "planAmount", "decimal", "含税金额"],
            ["", "", "planDate", "date", ""],
            ["采购订单管理", "采购订单", "poNo", "string", "订单编号"],
            ["", "", "poAmount", "decimal", ""],
            ["", "", "poDate", "date", "下单日期"],
            ["", "", "poStatus", "string", "状态"],
        ])
    ]),
    dim="A1:E8")

# ── sheet6 散文 ────────────────────────────────────────────────────
# 第 1 行就是正文（一整段规则），detect_header_row 必须返回 -1。
PROSE = ("1、需进行采购包总金额上线控制，如超出XX金额，则采购包创建失败；"
         "2、实际与计划基线对比，如提前XX天需要进行预警提醒；"
         "3、进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消。")
SHEET_PROSE = _sheet(
    f'<row r="1"><c r="A1" t="inlineStr"><is><t>{_esc(PROSE)}</t></is></c></row>'
    f'<row r="2"><c r="A2" t="inlineStr"><is><t>{_esc("（1）创建采购包；（2）审批；（3）下发。")}'
    f'</t></is></c></row>',
    dim="A1:A2")

# ── sheet7 无坐标 ──────────────────────────────────────────────────
# `<row>` 与 `<c>` 都**不带 r 属性**（规范允许，某些导出工具就这么写）。
# openpyxl 靠 row_counter / col_counter 递推，且 col_counter 在每个 <row> 开头
# 归零。不实现这条递推的话整张表会塌进第 1 行第 1 列。
SHEET_NOREF = _sheet(
    "<row><c t=\"s\"><v>2</v></c><c t=\"s\"><v>3</v></c></row>"
    "<row><c t=\"s\"><v>7</v></c><c t=\"s\"><v>8</v></c></row>"
    "<row><c><v>1</v></c><c><v>2</v></c></row>",
    dim="A1:B3")

SHEETS = [
    ("混合类型", SHEET_MIXED),
    ("合并与空行", SHEET_MERGE),
    ("偏移", SHEET_OFFSET),
    ("空表", SHEET_EMPTY),
    ("层级", SHEET_TREE),
    ("散文", SHEET_PROSE),
    ("无坐标", SHEET_NOREF),
]

#: 批注挂在 sheet2 上。最后一条落在**空单元格** D6 上 —— _render_pairs 里
#: "值为空、没能落到任何 pair 的批注不丢，挂到末尾" 那条分支专门为它写的。
COMMENTS = [("A3", "这一列指的是应用模块，不是系统模块"),
            ("C3", "含税口径；\n跨年累计"),
            ("D6", "这一格没值，但口径在这儿")]


def _comments_xml() -> str:
    body = "".join(
        f'<comment ref="{ref}" authorId="0"><text><r><t xml:space="preserve">'
        f"{_esc(txt)}</t></r></text></comment>" for ref, txt in COMMENTS)
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<comments xmlns="{NS}"><authors><author>梳理助手</author></authors>'
            f"<commentList>{body}</commentList></comments>")


def _build_hard_xlsx(path: Path) -> None:
    """整包手写。zip 成员时间钉死在同一天，重跑字节不变。"""
    sst = ("".join(_si(s) for s in SST_ITEMS[:len(SST_ITEMS)])).replace(
        _si(SST_ITEMS[11]), _si(SST_ITEMS[11]))
    sst_xml = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
               f'<sst xmlns="{NS}" count="{len(SST_ITEMS) + 1}" '
               f'uniqueCount="{len(SST_ITEMS) + 1}">{sst}{SST_RICH}</sst>')

    sheet_overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i + 1}.xml" '
        f'ContentType="application/vnd.openxmlformats-officedocument.'
        f'spreadsheetml.worksheet+xml"/>' for i in range(len(SHEETS)))
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/'
        'vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="vml" ContentType="application/'
        'vnd.openxmlformats-officedocument.vmlDrawing"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        f"{sheet_overrides}"
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/xl/comments1.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/'
        'vnd.openxmlformats-package.core-properties+xml"/>'
        "</Types>")

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
        'relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/'
        '2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        "</Relationships>")

    # absPath 藏在 mc:AlternateContent 里 —— 真实 Excel 存的就是这个形状，
    # _office_metadata 的正则 `absPath[^>]*url="([^"]+)"` 认的也是它。
    wb_xml = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<workbook xmlns="{NS}" xmlns:r="{RNS}" '
        f'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        f'mc:Ignorable="x15ac">'
        f'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/'
        f'markup-compatibility/2006"><mc:Choice xmlns:x15ac="http://schemas.'
        f'microsoft.com/office/spreadsheetml/2010/11/ac">'
        f'<x15ac:absPath url="D:\\客户资料\\某某集团\\采购中台\\" xmlns:x15ac='
        f'"http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/>'
        f"</mc:Choice></mc:AlternateContent>"
        + "<sheets>"
        + "".join(f'<sheet name="{_esc(n)}" sheetId="{i + 1}" r:id="rId{i + 1}"/>'
                  for i, (n, _) in enumerate(SHEETS))
        + "</sheets></workbook>")

    n = len(SHEETS)
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
        'relationships">'
        + "".join(
            f'<Relationship Id="rId{i + 1}" Type="http://schemas.openxmlformats.org/'
            f'officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i + 1}.xml"/>' for i in range(n))
        + f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/'
          f'officeDocument/2006/relationships/styles" Target="styles.xml"/>'
          f'<Relationship Id="rId{n + 2}" Type="http://schemas.openxmlformats.org/'
          f'officeDocument/2006/relationships/sharedStrings" '
          f'Target="sharedStrings.xml"/>'
        + "</Relationships>")

    sheet2_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
        'relationships">'
        '<Relationship Id="rIdCmt" Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/comments" Target="../comments1.xml"/>'
        '<Relationship Id="rIdVml" Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/vmlDrawing" Target="../drawings/'
        'vmlDrawing1.vml"/>'
        "</Relationships>")

    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/'
            'package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            "<dc:creator>张三（甲方IT）</dc:creator>"
            "<cp:lastModifiedBy>李四</cp:lastModifiedBy>"
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z'
            "</dcterms:created>"
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z'
            "</dcterms:modified></cp:coreProperties>")

    vml = ('<xml xmlns:v="urn:schemas-microsoft-com:vml" '
           'xmlns:o="urn:schemas-microsoft-com:office:office" '
           'xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout '
           'v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout></xml>')

    members: list[tuple[str, bytes]] = [
        ("[Content_Types].xml", content_types.encode()),
        ("_rels/.rels", root_rels.encode()),
        ("docProps/core.xml", core.encode()),
        ("xl/workbook.xml", wb_xml.encode()),
        ("xl/_rels/workbook.xml.rels", wb_rels.encode()),
        ("xl/styles.xml", STYLES.encode()),
        ("xl/sharedStrings.xml", sst_xml.encode()),
        ("xl/comments1.xml", _comments_xml().encode()),
        ("xl/drawings/vmlDrawing1.vml", vml.encode()),
        ("xl/worksheets/_rels/sheet2.xml.rels", sheet2_rels.encode()),
    ]
    for i, (_, body) in enumerate(SHEETS):
        members.append((f"xl/worksheets/sheet{i + 1}.xml", body.encode()))

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


# ══════════════════════════════════════════════════════════════════
#  向量
# ══════════════════════════════════════════════════════════════════
#: infer_type 的判据逐条打靶。JS 侧的雷：``Number("")===0``、``Number(" 1 ")===1``、
#: ``Number("0x1f")===31``、``Number("1_0")`` 是 NaN 而 Python int("1_0")==10、
#: 全角数字 ``１２３`` 在 Python 的 ``\d`` 里算数字 —— 但 _INT 用的是 re 而不是 int()，
#: 所以真正的判据是**正则**，得按正则对齐（``\d`` 认全角、``$`` 认尾随换行）。
INFER_CASES: list[list[str]] = [
    [],
    ["", "  ", "\t"],
    ["1", "2", "-3"],
    ["1", "2.5"],
    ["1.0", "-0.5"],
    ["0x1f", "1"],
    ["1_0", "20"],
    ["１２３", "４５６"],                     # 全角数字：Python \d 认，JS \d 不认
    ["1", " 2 ", "3"],                        # strip 之后仍是整数
    ["1\n", "2"],                             # Python 的 $ 认尾随换行 → 仍算 INTEGER
    ["+1", "2"],                              # _INT 不认 +
    ["1e3", "2"],
    ["2024-01-15", "2024/2/3"],
    ["2024-01-15 10:00:00", "2024-1-2 xx"],   # _DATE 不锚尾 → 仍算 DATE
    ["24-01-15"],
    ["是", "否", "是"],
    ["Y", "n", "YES", "No", "TRUE", "false"],
    ["是", "否", "也许"],
    ["A"] * 8,
    ["A"] * 7,
    ["A", "B"] * 4,
    ["A", "B", "C"] * 3,                      # 3 > max(2, 9//8) → 不是 ENUM
    ["1", "2", "3", "4", "5", "6", "7", "8"],  # 全整数优先于 ENUM
    ["含税", "不含税", "含税", "不含税", "含税", "不含税", "含税", "不含税"],
    ["Ａ", "Ｂ"],
    ["🐍", "🐍", "🐍"],
    ["\u3000是", "否"],                        # 全角空格 strip 得掉
    ["\ufeff是", "否"],                        # BOM：Python strip 削不掉、JS trim 削得掉
]

#: profile_column：空列 / 全空 / 唯一 / 重复 / 四舍五入落在 .5 上 / 样本去重取前 5。
PROFILE_CASES: list[tuple[str, list[str]]] = [
    ("空列", []),
    ("全空", ["", "  ", "\u3000"]),
    ("唯一", ["a", "b", "c"]),
    ("有重复", ["a", "a", "b", ""]),
    ("三分之一", ["a", "", ""]),
    ("七分之一", ["x", "", "", "", "", "", ""]),
    ("十六分之一", ["x"] + [""] * 15),
    ("样本超五", ["v1", "v2", "v3", "v4", "v5", "v6", "v1"]),
    ("数字列", ["1", "2", "3", "4", "5", "6", "7", "8"]),
    ("枚举列", ["含税", "不含税"] * 5),
    ("带空白", [" a ", "a", "\u3000a\u3000"]),
    ("BOM", ["\ufeffa", "a"]),
    ("三分之二", ["a", "b", ""]),
]

#: detect_header_row：表头在第 1 行 / 第 3 行 / 没有表头 / 扫描深度边界 / 空输入。
HEADER_CASES: list[list[list[str]]] = [
    [],
    [[]],
    [["姓名", "年龄", "城市"], ["张三", "18", "北京"], ["李四", "20", "上海"]],
    [["某某集团采购中台梳理表"], [], ["姓名", "年龄", "城市"], ["张三", "18", "北京"]],
    [[PROSE], ["（1）创建；（2）审批。"]],
    [["a", "", "", ""], ["1", "2", "3", "4"]],                 # 填充率不足
    [["1", "2", "3"], ["4", "5", "6"]],                        # 全是数值
    [["名称", "编码"], ["甲", "乙"], ["丙", "丁"]],             # 下一行不是数值
    [["x", "x"], ["1", "2"]],                                  # 下一行去重后仍相等长度
    [["col"] * 3] * 14 + [["1", "2", "3"]],                    # 超过扫描深度
    [["名称", "编码", "2024-01-01"], ["甲", "乙", "1"]],
    [["很长的表头" * 6, "编码"], ["甲", "1"]],                  # 长文本占一半
    # 专钉 `+0.1`（下一行去重后仍等长）那条加权：第 0 行与第 1 行都够格当表头，
    # 第 0 行靠"位置靠前"多 0.05，第 1 行只能靠这 0.1 反超。去掉 +0.1 就选错行。
    [["表", "格", "标"], ["名称", "名称", "编码"],
     ["甲", "乙", "丙"], ["丁", "戊", "己"]],
]

DEDUPE_CASES: list[list[str]] = [
    [],
    ["a", "b"],
    ["a", "a", "a"],
    ["", " ", "x"],
    ["a", "a#2", "a"],
    ["  名称  ", "名称"],
]

#: _render_pairs：相邻同值合并、批注就地绑列、落空的批注挂尾、header 比 row 短。
RENDER_CASES: list[dict[str, Any]] = [
    {"header": ["A", "B", "C"], "row": ["1", "2", "3"], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["x", "x", "x"], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["x", "x", "y"], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["", "", ""], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["1", "", "3"], "comments": {"1": "口径在这"}},
    {"header": ["A", "B", "C"], "row": ["x", "x", ""], "comments": {"1": "绑在合并段"}},
    {"header": ["A", "B"], "row": ["1", "2", "3"], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["1"], "comments": {"2": "越过行尾"}},
    {"header": ["A", "B", "C"], "row": [" 1 ", "1", "2"], "comments": {}},
    {"header": ["A", "B", "C"], "row": ["1", "2", "3"],
     "comments": {"0": "甲", "2": "乙", "5": "越界丢弃"}},
]

TREE_ROWS = [
    ["采购计划管理", "采购需求计划", "planNo", "string", "计划编号"],
    ["", "", "planAmount", "decimal", "含税金额"],
    ["", "", "planDate", "date", ""],
    ["采购订单管理", "采购订单", "poNo", "string", "订单编号"],
    ["", "", "poAmount", "decimal", ""],
    ["", "", "poDate", "date", "下单日期"],
    ["", "", "poStatus", "string", "状态"],
]
FILL_CASES: list[dict[str, Any]] = [
    {"header": ["应用模块", "业务对象", "字段", "类型", "口径"], "body": TREE_ROWS},
    {"header": [], "body": TREE_ROWS},
    {"header": ["A", "B"], "body": [["1", "2"]]},                # n < 2 直接返回
    # 没有密集锚列 → 原样返回，不猜
    {"header": ["A", "B", "C"], "body": [["x", "", ""], ["", "y", ""], ["", "", "z"]]},
    # 锚列在第 0 列 → 左侧没有分组列，原样返回
    {"header": ["键", "值"], "body": [["k1", "v1"], ["k2", ""], ["k3", "v3"]]},
    # 分组列文本超过 24 字 → 不当分组列
    {"header": ["说明", "字段"],
     "body": [["这是一段超过二十四个字的很长很长的说明文字，不该被当成分组列", "f1"],
              ["", "f2"], ["", "f3"], ["", "f4"]]},
    # 行长参差：短行要补齐到 ncol
    {"header": ["组", "键", "值"],
     "body": [["G1", "k1", "v1"], ["", "k2"], ["", "k3", "v3"], ["G2", "k4", "v4"]]},
    # 空白分隔行不继承
    {"header": ["组", "键"],
     "body": [["G1", "k1"], ["", "k2"], ["", ""], ["", "k3"]]},
    # 专钉锚列的 0.85 阈值：`键` 列填了 5/6 = 0.8333，**差一点点**够不上锚列，
    # 于是锚列落到 `值`，`组` 与 `键` 双双变成要继承的分组列。阈值放宽到 0.8
    # 就变成锚列是 `键`、只继承 `组` —— 两种结果对不上。
    {"header": ["组", "键", "值"],
     "body": [["G1", "k1", "v1"], ["", "k2", "v2"], ["", "k3", "v3"],
              ["G2", "", "v4"], ["", "k5", "v5"], ["", "k6", "v6"]]},
]

#: _read_text：BOM / GBK / 非法字节回退 latin-1 / 空文件。
TEXT_CASES: list[bytes] = [
    "姓名,年龄\n张三,18\n".encode(),
    "\ufeff姓名,年龄\n张三,18\n".encode(),
    "姓名,年龄\n张三,18\n".encode("gb18030"),
    b"\x80\x81name,age\n",
    b"",
]

#: CSV 端到端。名字进 doc_id / locator.sheet（path.stem），所以取名要稳定。
CSV_CASES: list[tuple[str, bytes]] = [
    ("逗号.csv", "姓名,年龄,城市\n张三,18,北京\n李四,20,上海\n王五,,广州\n".encode()),
    ("分号.csv", "姓名;年龄;城市\n张三;18;北京\n李四;20;上海\n".encode()),
    ("制表.tsv", "姓名\t年龄\t城市\n张三\t18\t北京\n李四\t20\t上海\n".encode()),
    ("竖线.csv", "姓名|年龄|城市\n张三|18|北京\n李四|20|上海\n".encode()),
    ("单列.csv", "只有一列\n值一\n值二\n".encode()),
    ("单列.tsv", "只有一列\n值一\n值二\n".encode()),
    ("引号.csv",
     '姓名,备注\n"张三","含税, 不含税"\n"李四","他说""好"""\n'.encode()),
    ("gbk.csv", "姓名,年龄\n张三,18\n李四,20\n".encode("gb18030")),
    ("空文件.csv", b""),
    ("只有空行.csv", "\n\n  \n".encode()),
    ("表头偏移.csv",
     "某某集团梳理表\n\n姓名,年龄,城市\n张三,18,北京\n李四,20,上海\n".encode()),
    ("大表.csv",
     ("编码,名称,数量\n" + "".join(f"c{i},名称{i},{i}\n" for i in range(30))).encode()),
    ("参差.csv", "a,b,c\n1,2\n3,4,5,6\n".encode()),
    ("多行引号.csv", '姓名,备注\n"张三","第一行\n第二行"\n'.encode()),
    # 引号没闭到输入末尾就断了 —— reader 不抛，把攒下的内容原样出成一条记录。
    ("未闭引号.csv", '姓名,备注\n"张三,备注一直没闭合\n'.encode()),
    # strict=False：闭引号后面还跟着字（`"c" x`）、字段中间冒出个引号（`d"e`），
    # 两种都当普通字符继续吃。
    ("引号后有字.csv", 'a, b ,"c" x,d"e\n1,2,3,4\n5,6,7,8\n'.encode()),
    # schema 切片的 render 里有两个 `:.0%`。1/8 与 1-7/8 都精确等于 0.125，
    # 乘 100 之后正好落在 12.5 —— Python 的 `.0f` 是 round-half-even 给 "12"，
    # JS 的 `toFixed(0)` 是 half-away-from-zero 给 "13"。这一份就是为了钉它。
    # \r\n 行尾（Windows 导出的 CSV 就是这个）。`splitlines()` 认 \r\n，
    # `split("\n")` 会给每行留一个 \r —— 那个 \r 会原样进 samples 与 raw。
    ("回车换行.csv", "姓名,年龄,城市\r\n张三,18,北京\r\n李四,20,上海\r\n".encode()),
    # 分隔符只有"引号夹着的字段"这一步猜得出来（频次分析在这份上直接失败）。
    # 故意起名 .tsv：猜不出来时的兜底是 \t，与正确答案 , 不同，这才测得出来。
    ("引号定界.tsv",
     ("名称,备注\n" + "".join(
         f'"甲{i}{"," if i % 3 else ""}{"乙" if i % 3 else ""}","a{i};b{i}"\n'
         for i in range(9))).encode()),
    ("百分比平局.csv",
     ("编码,状态,备注\n"
      + "".join(f"c{i},同,{'r' + str(i) if i < 7 else ''}\n" for i in range(8))).encode()),
]

#: `format(x, ".0%")` 的直接向量。平局（12.5 / 37.5 / -0.5）是 JS 唯一会给出
#: 别的答案的地方，profile 的比率又天生爱落在 1/8、1/16 这种精确二进制值上。
PCT_CASES: list[float] = [
    0.0, 1.0, 0.125, 0.375, 0.625, 0.875, 0.005, 0.015, 0.9375, 0.0625,
    0.3333, 0.6667, 0.4286, 0.2857, -0.125, 0.999, 0.995,
]


# ══════════════════════════════════════════════════════════════════
#  dump
# ══════════════════════════════════════════════════════════════════
def dump_doc(doc: Any) -> dict[str, Any]:
    """ParsedDoc → 纯 JSON。字段顺序固定，diff 才读得懂。"""
    return {
        "file_id": doc.file_id,
        "file_name": doc.file_name,
        "kind": doc.kind,
        "meta": doc.meta,
        "structured": doc.structured,
        "findings": [{"kind": f.kind, "message": f.message,
                      "locator": f.locator, "severity": f.severity}
                     for f in doc.findings],
        "chunks": [{"chunk_id": c.chunk_id, "file_id": c.file_id,
                    "file_name": c.file_name, "locator": c.locator,
                    "render": c.render, "raw": c.raw, "order": c.order,
                    "tags": c.tags, "context": c.context,
                    "cite": c.cite()} for c in doc.chunks],
        "stats": doc.stats(),
    }


def dump_sheet(ws: Any) -> dict[str, Any]:
    # 维度必须在 _read_sheet 之前取：iter_rows() 会为整个矩形**新建**空单元格，
    # 之后再问 min_row/min_column 得到的永远是 1。
    dims = {"min_row": ws.min_row, "max_row": ws.max_row,
            "min_col": ws.min_column, "max_col": ws.max_column}
    grid, comments = _read_sheet(ws)
    return {
        "title": ws.title,
        **dims,
        "grid": grid,
        # (行, 0-based 列) 的元组键 JSON 表达不了，摊成三元组列表并排序
        "comments": sorted([[r, c, t] for (r, c), t in comments.items()]),
    }


def main() -> None:
    from openpyxl import load_workbook

    OUT.mkdir(exist_ok=True)
    hard = OUT / "tabular.hard.xlsx"
    _build_hard_xlsx(hard)

    out: dict[str, Any] = {}
    out["infer_type"] = [{"values": v, "type": infer_type(v)} for v in INFER_CASES]
    out["profile_column"] = [{"name": n, "values": v, "profile": profile_column(n, v)}
                             for n, v in PROFILE_CASES]
    out["detect_header_row"] = [{"rows": r, "header": detect_header_row(r)}
                                for r in HEADER_CASES]
    out["dedupe_headers"] = [{"header": h, "out": dedupe_headers(h)}
                             for h in DEDUPE_CASES]
    out["render_pairs"] = [
        {**c, "out": _render_pairs(c["header"], c["row"],
                                   {int(k): v for k, v in c["comments"].items()})}
        for c in RENDER_CASES]
    out["fill_hierarchy"] = [{**c, "out": _fill_hierarchy(c["header"], c["body"])}
                             for c in FILL_CASES]
    out["pct_format"] = [{"x": x, "out": format(x, ".0%")} for x in PCT_CASES]
    out["read_text"] = []
    for raw in TEXT_CASES:
        tmp = OUT / "_tmp_read_text.bin"
        tmp.write_bytes(raw)
        text, enc = _read_text(tmp)
        tmp.unlink()
        out["read_text"].append({"bytes_b64": base64.b64encode(raw).decode(),
                                 "text": text, "encoding": enc})

    # ── xlsx ──
    xp = XlsxParser()
    out["xlsx"] = {}
    for name in ("材料.xlsx", "tabular.hard.xlsx"):
        p = OUT / name
        wb = load_workbook(p, data_only=True)
        out["xlsx"][name] = {
            "sha256_b64": base64.b64encode(
                __import__("hashlib").sha256(p.read_bytes()).digest()).decode(),
            "sheets": [dump_sheet(ws) for ws in wb.worksheets],
            "doc": dump_doc(xp.parse(p, file_id="f_fixed")),
        }

    # ── csv ──
    cp = CsvParser()
    out["csv"] = []
    tmpdir = OUT / "_tmp_csv"
    tmpdir.mkdir(exist_ok=True)
    for name, raw in CSV_CASES:
        p = tmpdir / name
        p.write_bytes(raw)
        out["csv"].append({
            "name": name,
            "bytes_b64": base64.b64encode(raw).decode(),
            "doc": dump_doc(cp.parse(p, file_id="f_fixed")),
        })
        p.unlink()
    tmpdir.rmdir()

    path = OUT / "tabular.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  tabular.json          {path.stat().st_size:>9} B")
    print(f"  tabular.hard.xlsx     {hard.stat().st_size:>9} B  "
          f"crc={binascii.crc32(hard.read_bytes()):08x}")


if __name__ == "__main__":
    main()
