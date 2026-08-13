"""对话动态改模板。

"让 AI 改 xlsx 模板"有一个致命陷阱：这份 xlsx 靠隐藏锚点列做往返回读，而
**列名 == Cell.field == 回写 key 是三位一体的**。模型直接吐新 xlsx 锚点必丢、
整表回读报废且不报错。所以编辑是结构化操作，每次跑守卫。下面钉住守卫拦住的
正是往返契约会断的地方。
"""

from __future__ import annotations

import pytest

from ontocopilot.onto.oir import OIR, ObjectType, inferred
from ontocopilot.onto.template import ANCHOR_RID, Role, compile_template
from ontocopilot.onto.template_edit import WRITEBACK_FIELDS, EditError, apply_edit


def _spec():
    oir = OIR()
    for i in range(5):
        oir.add_object(ObjectType(rid=f"ot_{i}", api_name=inferred(f"obj{i}"),
                                  display_name=inferred(f"对象{i}"),
                                  primary_key=inferred([])))
    return compile_template(oir), oir


def _cols(spec, sheet):
    sh = next(s for s in spec.sheets if s.name == sheet)
    return sh.columns


def _obj_sheet(spec):
    return next(s.name for s in spec.sheets if "对象" in s.name)


# ══════════════════════════════════════════════════════════════════
#  reconcile：OIR 改动进手改模板
# ══════════════════════════════════════════════════════════════════
def test_reconcile_merges_oir_changes_and_keeps_hand_edits():
    """采纳/口述改了 OIR 后重出模板：新对象的行要进来，手改的列也要还在。"""
    from ontocopilot.onto.template_edit import reconcile_template

    spec, oir = _spec()
    sh = _obj_sheet(spec)
    n_rows_before = len(next(s for s in spec.sheets if s.name == sh).rows)
    # 手改：加一列（结构编辑，进 patch_log）
    patch_log = [{"op": "add_column",
                  "args": {"sheet": sh, "name": "备注", "role": "prefilled"}}]
    # OIR 变了：加一个对象
    oir.add_object(ObjectType(rid="ot_new", api_name=inferred("objN"),
                              display_name=inferred("新对象"), primary_key=inferred([])))
    fresh, stale = reconcile_template(oir, [], patch_log)
    assert not stale
    sh2 = next(s for s in fresh.sheets if s.name == sh)
    assert len(sh2.rows) == n_rows_before + 1     # OIR 改动进来了：多一行
    assert "备注" in sh2.columns                   # 手改保留了：备注列还在


def test_reconcile_reports_stale_without_crashing():
    """重放不上的手改要报出来，不能静默丢，也不能让整次重出崩掉。"""
    from ontocopilot.onto.template_edit import reconcile_template

    _spec_value, oir = _spec()
    patch_log = [{"op": "add_column", "args": {"sheet": "根本不存在的表", "name": "x"}}]
    _fresh, stale = reconcile_template(oir, [], patch_log)
    assert len(stale) == 1 and stale[0]["op"] == "add_column"


# ══════════════════════════════════════════════════════════════════
#  正常操作
# ══════════════════════════════════════════════════════════════════
def test_add_display_column():
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    apply_edit(spec, "add_column", {"sheet": sh, "name": "备注", "role": "prefilled"})
    assert "备注" in _cols(spec, sh)
    # 三位一体：列名 == 每行 dict key == cell.field
    row = next(s for s in spec.sheets if s.name == sh).rows[0]
    assert "备注" in row and row["备注"].field == "备注"


def test_drop_primary_key():
    """primaryKey 本就建议删（172 行全空、只有 FDE 答得了）。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    apply_edit(spec, "drop_column", {"sheet": sh, "column": "primaryKey"})
    assert "primaryKey" not in _cols(spec, sh)
    # 幽灵 cell：删了列，行里也不能留着它
    assert all("primaryKey" not in r for r in
               next(s for s in spec.sheets if s.name == sh).rows)


def test_fuzzy_sheet_name():
    """模型多半不知道表名带 01_ 前缀，说「对象清单」指的是「01_对象清单」。"""
    spec, _ = _spec()
    apply_edit(spec, "set_guide", {"sheet": "对象清单", "text": "新说明"})
    sh = next(s for s in spec.sheets if "对象" in s.name)
    assert sh.guide == "新说明"


def test_undo_via_reapply():
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    before = list(_cols(spec, sh))
    apply_edit(spec, "add_column", {"sheet": sh, "name": "临时", "role": "locked"})
    apply_edit(spec, "drop_column", {"sheet": sh, "column": "临时"})
    assert _cols(spec, sh) == before


# ══════════════════════════════════════════════════════════════════
#  守卫
# ══════════════════════════════════════════════════════════════════
def test_cannot_drop_anchor():
    """锚点列删了整表就读不回来了。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    with pytest.raises(EditError, match="锚点"):
        apply_edit(spec, "drop_column", {"sheet": sh, "column": ANCHOR_RID})


def test_required_without_writeback_is_rejected():
    """加一列必填但没有回写路径 —— 填了会算完成度却在合并时静默丢（黑洞）。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    with pytest.raises(EditError, match="回写"):
        apply_edit(spec, "add_column",
                   {"sheet": sh, "name": "乱填的必填列", "role": "required"})


def test_primary_key_cannot_become_required():
    """primaryKey 提必填就重犯 172 行全空独占 58% 权重的坑。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    with pytest.raises(EditError):
        apply_edit(spec, "set_role",
                   {"sheet": sh, "column": "primaryKey", "role": "required"})


def test_duplicate_column_rejected():
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    with pytest.raises(EditError, match="已经有"):
        apply_edit(spec, "add_column", {"sheet": sh, "name": "apiName"})


def test_rename_required_to_no_writeback_rejected():
    """把必填列改成没有回写 case 的名字，会切断回写路径。"""
    spec, _ = _spec()
    obj = _obj_sheet(spec)
    # description 是必填且有回写路径；改成一个没有回写的名字应被拒
    with pytest.raises(EditError, match="回写"):
        apply_edit(spec, "rename_column",
                   {"sheet": obj, "old": "description", "new": "随便改的名"})


def test_guard_is_atomic_on_failure():
    """守卫失败要整体拒绝 —— 半应用的模板比不改更糟。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    before = list(_cols(spec, sh))
    with pytest.raises(EditError):
        apply_edit(spec, "add_column",
                   {"sheet": sh, "name": "会被拒", "role": "required"})
    assert _cols(spec, sh) == before, "被拒的编辑不该留下任何痕迹"


def test_set_options_needs_two():
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    with pytest.raises(EditError, match="两个"):
        apply_edit(spec, "set_options",
                   {"sheet": sh, "column": "owner", "options": ["只有一个"]})


def test_reorder_must_be_a_permutation():
    spec, _ = _spec()
    with pytest.raises(EditError, match="排列"):
        apply_edit(spec, "reorder_sheets", {"order": ["只有一张"]})


# ══════════════════════════════════════════════════════════════════
#  往返不变量
# ══════════════════════════════════════════════════════════════════
def test_anchors_survive_every_edit():
    """不管怎么改，每张数据表的前两列永远是锚点。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    apply_edit(spec, "add_column", {"sheet": sh, "name": "备注", "role": "prefilled"})
    apply_edit(spec, "drop_column", {"sheet": sh, "column": "primaryKey"})
    apply_edit(spec, "set_guide", {"sheet": sh, "text": "改过的说明"})
    # 每张有行的表，锚点字段都还在（锚点不在 columns 里，但在每行 cell 里）
    for s in spec.sheets:
        if not s.rows:
            continue
        # 锚点由 write_xlsx 单独写，不进 columns —— 这里验 columns 没被污染
        assert ANCHOR_RID not in s.columns


def test_edited_spec_round_trips_through_json():
    """编辑后的 spec 要能存盘再读回 —— 发模板和审回传是两次进程。"""
    from ontocopilot.onto.template import TemplateSpec

    spec, _ = _spec()
    sh = _obj_sheet(spec)
    apply_edit(spec, "add_column", {"sheet": sh, "name": "备注", "role": "prefilled"})
    back = TemplateSpec.from_dict(spec.to_dict())
    assert "备注" in next(s for s in back.sheets if s.name == sh).columns


# ══════════════════════════════════════════════════════════════════
#  往返契约的三个漏洞
# ══════════════════════════════════════════════════════════════════
def test_add_column_records_the_real_sheet_name_not_the_fuzzy_one():
    """_sheet() 是模糊匹配的（模型说「对象清单」，真表名是「01_对象清单」）。
    把调用方那个串写进 Cell.sheet，这一格的回读身份就指向一张不存在的表 ——
    业务方填了，合并时按 (sheet, rid, field) 对不上，静默丢弃。
    """
    spec, _ = _spec()
    real = _obj_sheet(spec)
    fuzzy = real.split("_", 1)[-1] if real[:2].isdigit() else real
    apply_edit(spec, "add_column", {"sheet": fuzzy, "name": "备注", "role": "prefilled"})
    sh = next(s for s in spec.sheets if s.name == real)
    assert all(r["备注"].sheet == real for r in sh.rows)     # 修好前是 fuzzy


def test_rename_guards_every_writeback_column_not_only_required():
    """prefilled 的 owner/definition 同样有 merge_into_oir 的回写 case，业务方照样
    会改。只守 REQUIRED 的话，把 owner 改成「负责人」就悄悄断了这一列的回写。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    col = next((c for c in _cols(spec, sh)
                if c in WRITEBACK_FIELDS
                and not any(r[c].role is Role.REQUIRED for r in
                            next(s for s in spec.sheets if s.name == sh).rows)), None)
    if col is None:
        pytest.skip("这份骨架里没有非必填的可回写列")
    with pytest.raises(EditError, match="回写"):
        apply_edit(spec, "rename_column", {"sheet": sh, "old": col, "new": "随便改个名"})


def test_dropdown_options_that_would_corrupt_the_xlsx_are_rejected():
    """内联下拉整串带引号不能超 255 字符，选项里不能有英文逗号/双引号。openpyxl
    照写不误，但业务方打开时这一列的下拉是坏的、甚至整表报修复。"""
    spec, _ = _spec()
    sh = _obj_sheet(spec)
    col = _cols(spec, sh)[1]
    with pytest.raises(EditError, match="逗号|引号"):
        apply_edit(spec, "set_options", {"sheet": sh, "column": col,
                                         "options": ["正常", "含,逗号"]})
    with pytest.raises(EditError, match="255|上限"):
        apply_edit(spec, "set_options", {"sheet": sh, "column": col,
                                         "options": [f"选项{i}" * 6 for i in range(20)]})
    # 正常的下拉照旧能设
    apply_edit(spec, "set_options", {"sheet": sh, "column": col, "options": ["是", "否"]})


# ══════════════════════════════════════════════════════════════════
#  AI 适配模板（只选 op，不生成 xlsx）
# ══════════════════════════════════════════════════════════════════
def test_ai_plan_applies_legal_edits_and_rejects_illegal_ones_independently():
    """AI 提的改法和人工的走**同一套守卫**：一条违规只丢那一条，骨架不留中间态。"""
    from ontocopilot.onto.template_plan import apply_plan

    spec, _ = _spec()
    sh = _obj_sheet(spec)
    before = [s.name for s in spec.sheets]
    applied, rejected = apply_plan(spec, [
        {"op": "set_guide", "sheet": sh, "text": "请确认每个业务对象的口径",
         "why": "业务方读不懂 apiName"},
        # 违规：把可回写的列改成没有回写路径的名字
        {"op": "rename_column", "sheet": sh, "old": "description", "new": "随便改的名",
         "why": "故意违规"},
        {"op": "set_options", "sheet": sh, "column": "owner",
         "options": ["采购部", "财务部"], "why": "取值有限"},
    ])
    assert len(applied) == 2 and len(rejected) == 1
    assert rejected[0]["op"] == "rename_column" and "回写" in rejected[0]["why_rejected"]
    assert [s.name for s in spec.sheets] == before      # 没有半途破坏


def test_ai_plan_cannot_touch_the_round_trip_anchors():
    """模型永远不产出 xlsx、也不能碰锚点 —— 那是往返回读的命根子。"""
    from ontocopilot.onto.template_plan import PLAN_SCHEMA, apply_plan

    allowed = set(PLAN_SCHEMA["properties"]["edits"]["items"]["properties"]["op"]["enum"])
    # 白名单里没有加列/删列：删了锚点或删掉业务方要填的列都是不可逆的
    assert "drop_column" not in allowed and "add_column" not in allowed

    spec, _ = _spec()
    sh = _obj_sheet(spec)
    _, rejected = apply_plan(spec, [
        {"op": "rename_column", "sheet": sh, "old": ANCHOR_RID, "new": "x", "why": "试试"}])
    assert len(rejected) == 1 and "锚点" in rejected[0]["why_rejected"]


async def test_template_adaptation_degrades_to_the_plain_skeleton():
    """模型不可用时必须退回确定性骨架 —— 适配是加分项，不能变成单点故障。"""
    from ontocopilot.onto.template_plan import adapt_template

    spec, _ = _spec()
    cols_before = {s.name: list(s.columns) for s in spec.sheets}

    class _Boom:
        async def call(self, *a, **k): raise RuntimeError("gateway down")

    out = await adapt_template(spec, gateway=_Boom(), node_id="T", project="p",
                               stats={}, vocabulary=[], open_questions=[])
    assert out["error"] and out["applied"] == []
    assert {s.name: list(s.columns) for s in spec.sheets} == cols_before
