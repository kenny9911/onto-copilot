"""把对话里的一份内容落成文件 —— md / csv / xlsx / docx / pdf。

FDE 在聊天里拿到了一张 192 行的待澄清问题表，下一句是"把这个转成 excel 给我"。
交付包解决不了这件事（那是把整个会话打成 zip），他要的是**刚刚那一份**。

这个文件盯的主要是**格式本身的坑**，因为它们全都是"跑通了、但打开是坏的"那一类：
中文变方块、Excel 把一格文本当公式、PDF 一页 3.6 MB、导出件混进交付包。
"""

from __future__ import annotations

import io

import pytest

from ontocopilot.onto.export import (
    Block,
    ExportDoc,
    blocks_from_markdown,
    render,
    resolve_format,
    safe_name,
    table_block,
)

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


def _doc() -> ExportDoc:
    return ExportDoc(title="采购计划 待澄清问题",
                     blocks=blocks_from_markdown(TABLE_MD),
                     note="共 3 条，由 OntoCopilot 导出")


# ══════════════════════════════════════════════════════════════════
#  markdown → 块
# ══════════════════════════════════════════════════════════════════
def test_markdown_becomes_the_blocks_the_user_saw_on_screen():
    """导出的结构必须和他在屏幕上看到的一致 —— 表还是表，不是一坨文字。"""
    blocks = blocks_from_markdown(TABLE_MD)
    kinds = [b.kind for b in blocks]
    assert "table" in kinds and "heading" in kinds and "code" in kinds

    tbl = next(b for b in blocks if b.kind == "table")
    assert tbl.columns == ["节点", "编号", "澄清问题", "参考选项"]
    assert len(tbl.rows) == 3

    # 行内标记落地时去掉：docx/pdf 里没有对应表达，留着就是正文里裸的 ** 和 `
    assert all("*" not in b.text and "`" not in b.text
               for b in blocks if b.kind in ("heading", "para"))
    assert any("单据上的每一个字段" in b.text for b in blocks)

    # 代码块**不**做行内处理，JSON 要原样留着
    code = next(b for b in blocks if b.kind == "code")
    assert code.text == '{"a": 1, "b": [2, 3]}'

    # 列表保留层级和序号
    items = next(b for b in blocks if b.items).items
    assert [d for d, _, _ in items] == [0, 1, 0]
    assert items[2][1] == "1."          # 有序项记住自己的序号


def test_empty_markers_do_not_become_list_items():
    """模型经常写出只有一个 '-' 的空行；那不是一条，别在 Word 里留个空项目符号。"""
    items = [b for b in blocks_from_markdown("- \n- 真的有内容\n-  \n") if b.items]
    assert len(items) == 1 and len(items[0].items) == 1


# ══════════════════════════════════════════════════════════════════
#  五种格式都得真的能打开
# ══════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("fmt", ["md", "csv", "xlsx", "docx", "pdf"])
def test_every_format_produces_a_non_trivial_file(fmt):
    data, spec = render(_doc(), fmt)
    assert len(data) > 200
    assert spec.ext == fmt
    assert safe_name("采购计划 待澄清问题", spec.ext).endswith("." + fmt)


def test_markdown_keeps_the_table_a_table():
    data, _ = render(_doc(), "md")
    text = data.decode("utf-8")
    assert "| 节点 | 编号 | 澄清问题 | 参考选项 |" in text
    assert "什么情况下使用集采？" in text


def test_csv_carries_a_bom_so_excel_does_not_show_mojibake():
    """无 BOM 的 UTF-8 csv 在 Excel 里打开是乱码 —— 而"导出的中文是乱码"
    会被当成系统坏了，不会被当成编码设置问题。"""
    data, _ = render(_doc(), "csv")
    assert data.startswith(b"\xef\xbb\xbf")
    assert "什么情况下使用集采？" in data.decode("utf-8-sig")


def test_xlsx_is_a_usable_sheet_not_just_a_dump():
    """表要能直接用：表头冻结、能筛选、列宽不至于一屏放不下。"""
    import openpyxl

    data, _ = render(_doc(), "xlsx")
    wb = openpyxl.load_workbook(io.BytesIO(data))
    ws = wb.worksheets[0]
    assert ws.freeze_panes == "A2"
    assert ws.auto_filter.ref
    assert [c.value for c in ws[1]] == ["节点", "编号", "澄清问题", "参考选项"]
    assert ws.max_row == 4                        # 表头 + 3 行
    assert all(ws.column_dimensions[c].width <= 60 for c in ("A", "B", "C", "D"))

    # 正文和表分开放：正文塞在表上面会让第一行不是表头，筛选和冻结全错位
    assert "说明" in wb.sheetnames


def test_a_cell_that_looks_like_a_formula_stays_text():
    """材料里一格 "=SUM(A1)" 被 openpyxl 当公式写进去，Excel 打开是个错误值。"""
    import openpyxl

    data, _ = render(_doc(), "xlsx")
    ws = openpyxl.load_workbook(io.BytesIO(data)).worksheets[0]
    cell = next(c for row in ws.iter_rows() for c in row
                if isinstance(c.value, str) and c.value.startswith("=SUM"))
    assert cell.data_type == "s"                  # 文本，不是公式
    assert cell.value == "=SUM(A1) 会不会被当成公式"   # 也没被加上单引号


def test_sheet_names_survive_excels_hard_rules():
    """Excel 表名 ≤31 字符、不能有 \\/*?:[]、不能重名 —— 踩中就是存不出文件。"""
    import openpyxl

    doc = ExportDoc(title="x", blocks=[
        *table_block(["a"], [["1"]], title="报表/明细[2026]:第一版 " + "长" * 40),
        *table_block(["a"], [["2"]], title="报表/明细[2026]:第一版 " + "长" * 40),
    ])
    data, _ = render(doc, "xlsx")
    names = openpyxl.load_workbook(io.BytesIO(data)).sheetnames
    assert len(names) == len(set(names))
    for n in names:
        assert len(n) <= 31 and not set(n) & set(r"\/*?:[]")


def test_docx_keeps_chinese_readable_in_word():
    """python-docx 只写 w:ascii/w:hAnsi，不设 w:eastAsia 的话 Word 会替换中文字体。"""
    import docx
    from docx.oxml.ns import qn

    data, _ = render(_doc(), "docx")
    d = docx.Document(io.BytesIO(data))
    assert d.styles["Normal"].element.rPr.rFonts.get(qn("w:eastAsia"))
    assert len(d.tables) == 1 and len(d.tables[0].rows) == 4
    assert "什么情况下使用集采？" in d.tables[0].rows[1].cells[2].text


def test_pdf_has_real_chinese_and_is_not_multiple_megabytes():
    """两件事一起验：中文画得出来（能被提取），以及做了字体子集化。

    不子集化的话一页中文 PDF 是 3.6 MB —— 整个回退字体被嵌进去。子集化后是几十 KB。
    这不是优化，是能不能发给客户的分界。
    """
    import pymupdf

    data, _ = render(_doc(), "pdf")
    assert len(data) < 400_000, "忘了 subset_fonts()：整份中文回退字体被嵌进去了"
    text = "".join(p.get_text() for p in pymupdf.open("pdf", data))
    assert "什么情况下使用集采" in text
    assert "采购计划" in text


# ══════════════════════════════════════════════════════════════════
#  格式名 / 文件名
# ══════════════════════════════════════════════════════════════════
@pytest.mark.parametrize("said,want", [
    ("excel", "xlsx"), ("Excel", "xlsx"), ("表格", "xlsx"), (".xlsx", "xlsx"),
    ("word", "docx"), ("文档", "docx"), ("markdown", "md"), ("PDF", "pdf"),
])
def test_user_words_map_to_formats(said, want):
    """用户嘴里说的是"excel"、"word"、"表格"，不是"xlsx"。"""
    assert resolve_format(said) == want


def test_unknown_format_is_rejected_not_guessed():
    assert resolve_format("pptx") == ""
    with pytest.raises(ValueError):
        render(_doc(), "pptx")


@pytest.mark.parametrize("title", ["../../etc/passwd", "a/b\\c:d*e?f", "...", ""])
def test_file_names_cannot_escape_the_export_directory(title):
    """标题是模型给的，而它会变成磁盘上的文件名 —— 这里是唯一的路径穿越入口。"""
    name = safe_name(title, "xlsx")
    assert "/" not in name and "\\" not in name
    assert not name.startswith(".")
    assert name.endswith(".xlsx")


def test_long_titles_are_trimmed_not_rejected():
    name = safe_name("澄" * 300, "pdf")
    assert len(name) < 120 and name.endswith(".pdf")


# ══════════════════════════════════════════════════════════════════
#  服务端：AI 调 export.file 的完整一条路
# ══════════════════════════════════════════════════════════════════
class _Ctx:
    approved = True
    pending: list = []


async def test_ai_exports_the_table_it_just_showed(tmp_path, monkeypatch):
    """用户："把刚才那个问题清单转成 excel 给我"。

    这是这个功能存在的理由：他不想复制粘贴，也不想被告诉"你可以自己贴进 Excel"。
    """
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="ex1")
    s.dir.mkdir(parents=True, exist_ok=True)
    s.state["oir"] = {"questions": [
        {"rid": f"q{i}", "text": {"value": f"第 {i} 个要澄清的问题？"},
         "answer": {"value": ""}, "code": f"Q{i:03d}"} for i in range(192)]}

    reg = server._converse_tools(s)
    listed = await reg.call("ui.table", {"kind": "questions"}, _Ctx(), scope="converse")
    assert listed["已列出"] == 192

    out = await reg.call("export.file", {"format": "excel"}, _Ctx(), scope="converse")
    assert "error" not in out, out
    assert out["表格行数"] == 192
    assert out["已生成"].endswith(".xlsx")
    assert "不要贴链接" in out["说明"]

    # 落在 exports/ 子目录 —— 不能出现在会话根目录，那里是产物
    f = s.dir / "exports" / out["已生成"]
    assert f.exists() and f.stat().st_size > 1000
    assert not any(p.suffix == ".xlsx" for p in s.dir.iterdir() if p.is_file())

    import openpyxl
    ws = openpyxl.load_workbook(f).worksheets[0]
    assert ws.max_row == 193                       # 表头 + 192，一条不少

    ev = [e for e in s.events if e["kind"] == "export.ready"][-1]
    assert ev["rows"] == 192 and ev["label"] == "Excel"


async def test_exports_do_not_pollute_the_delivery_bundle(tmp_path, monkeypatch):
    """产物列表是"会话根目录下所有文件"算出来的。导出件落在根目录，就会混进
    产物 tab、混进交付包 zip，一个叫「问题清单.xlsx」的导出还会被「下载填写模板」
    抓走 —— 那个按钮取的是第一个 .xlsx。"""
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="ex2")
    s.dir.mkdir(parents=True, exist_ok=True)
    (s.dir / "模板_v1.xlsx").write_bytes(b"real artifact")
    s.state["oir"] = {"objects": [
        {"rid": "o1", "displayName": {"value": "采购包"}, "apiName": {"value": "pkg"},
         "description": {"value": ""}, "status": "candidate"}]}

    reg = server._converse_tools(s)
    await reg.call("ui.table", {"kind": "objects"}, _Ctx(), scope="converse")
    await reg.call("export.file", {"format": "xlsx"}, _Ctx(), scope="converse")

    flat = sorted(p.name for p in s.dir.iterdir() if p.is_file())
    assert flat == ["模板_v1.xlsx"], f"导出件漏进了产物目录：{flat}"


async def test_export_without_anything_to_export_says_which_step_is_missing(
        tmp_path, monkeypatch):
    """一句"导出失败"会让模型转头跟用户说"系统限制"。真实原因（还没列过表、
    还没跑梳理）是能补的，必须说出来。"""
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="ex3")
    s.dir.mkdir(parents=True, exist_ok=True)
    reg = server._converse_tools(s)

    out = await reg.call("export.file", {"format": "xlsx"}, _Ctx(), scope="converse")
    assert "还没有列过表" in out["error"]
    assert "material.rows" in out["下一步"]

    miss = await reg.call("export.file", {"format": "pdf", "source": "questions"},
                          _Ctx(), scope="converse")
    assert "error" in miss and "梳理还没跑过" in miss["error"]

    bad = await reg.call("export.file", {"format": "pptx"}, _Ctx(), scope="converse")
    assert "不支持的格式" in bad["error"]


async def test_export_can_narrow_to_the_rows_he_asked_about(tmp_path, monkeypatch):
    """"只导出临时表相关的那 17 条" —— 导出继承对话上下文才有意义。"""
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="ex4")
    s.dir.mkdir(parents=True, exist_ok=True)
    s.state["oir"] = {"rules": [
        {"rid": f"r{i}", "statement": {"value": f"临时表规则 {i}" if i < 17
                                       else f"普通规则 {i}"},
         "ruleKind": {"value": "constraint"}, "actor": {"value": ""}}
        for i in range(40)]}

    reg = server._converse_tools(s)
    out = await reg.call("export.file",
                         {"format": "csv", "source": "rules", "contains": "临时表"},
                         _Ctx(), scope="converse")
    assert out["表格行数"] == 17
    body = (s.dir / "exports" / out["已生成"]).read_bytes().decode("utf-8-sig")
    assert "临时表规则 3" in body and "普通规则 20" not in body


async def test_export_the_last_answer_and_the_conversation(tmp_path, monkeypatch):
    """"把你刚才那段回答存成 word 我发给客户"。"""
    import ontocopilot.server as server
    from ontocopilot.kernel.memory.dialogue import Speaker

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="ex5")
    s.dir.mkdir(parents=True, exist_ok=True)
    server._publish_turn(s, Speaker.USER, "集采和普通采购怎么分？")
    server._publish_turn(s, Speaker.ASSISTANT, "## 结论\n\n按**金额阈值**分。\n\n- 超 50 万走集采\n- 其余普通采购")

    reg = server._converse_tools(s)
    one = await reg.call("export.file", {"format": "docx", "source": "last_answer"},
                         _Ctx(), scope="converse")
    assert "error" not in one, one

    import docx
    d = docx.Document(s.dir / "exports" / one["已生成"])
    text = "\n".join(p.text for p in d.paragraphs)
    assert "结论" in text and "超 50 万走集采" in text
    assert "**" not in text                        # 行内标记不该落到 Word 正文里

    whole = await reg.call("export.file", {"format": "md", "source": "conversation"},
                           _Ctx(), scope="converse")
    body = (s.dir / "exports" / whole["已生成"]).read_text(encoding="utf-8")
    assert "FDE" in body and "OntoCopilot" in body and "集采和普通采购怎么分？" in body
