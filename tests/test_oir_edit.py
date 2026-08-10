"""对话口述改 OIR 的结构化编辑。

盯两件事：口述一律 **USER 来源**（带 human Provenance，不冒充材料抽取），以及被拒的
编辑让活 OIR **字节不变**（原子性）。这两条一破，产品的信任基础就没了。
"""

from __future__ import annotations

import pytest

from ontocopilot.onto.oir import (
    OIR,
    BaseType,
    ObjectType,
    Origin,
    PropertyType,
    Provenance,
    Status,
    extracted,
    make_rid,
    oir_from_dict,
)
from ontocopilot.onto.oir_edit import OIREditError, apply_oir_edit


def _prov() -> Provenance:
    return Provenance("f1", "采购计划.xlsx", {"kind": "cell"}, snippet="采购包",
                      extractor="docling")


def _oir() -> tuple[OIR, ObjectType, PropertyType]:
    oir = OIR()
    p = _prov()
    ot = ObjectType(rid=make_rid("ot", "采购包"),
                    api_name=extracted("采购包", p), display_name=extracted("采购包", p))
    oir.add_object(ot)
    pt = PropertyType(rid=make_rid("pt", "状态"), parent=ot.rid,
                      api_name=extracted("状态", p), display_name=extracted("状态", p),
                      base_type=extracted("STRING", p))
    oir.add_property(pt)
    return oir, ot, pt


def test_add_enum_value_is_user_origin_and_flips_to_enum():
    """「采购包创建后状态变成已发布」→ 给采购包.状态加取值「已发布」。"""
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_enum_value", {"property": "采购包.状态", "value": "已发布"})
    p = oir.properties[pt.rid]
    assert "已发布" in p.value_domain.value
    assert p.value_domain.origin is Origin.USER
    assert p.value_domain.evidence and p.value_domain.evidence[0].extractor == "human"
    assert p.base_type.value is BaseType.ENUM     # 有取值域了，类型自动改 ENUM


def test_add_object_and_property_are_user_origin():
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_object_type", {"api_name": "供应商", "display_name": "供应商"})
    sup = next(o for o in oir.objects.values() if o.api_name.value == "供应商")
    assert sup.display_name.origin is Origin.USER
    apply_oir_edit(oir, "add_property",
                   {"object": "供应商", "api_name": "评级", "base_type": "STRING"})
    pr = next(p for p in oir.properties.values() if p.api_name.value == "评级")
    assert pr.api_name.origin is Origin.USER and pr.parent == sup.rid


def test_add_rule_process_binds_to_object():
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_rule", {"statement": "采购包创建后状态变成已发布",
                                     "kind": "PROCESS", "applies_to": ["采购包"]})
    r = next(iter(oir.rules.values()))
    assert r.statement.origin is Origin.USER
    assert ot.rid in r.applies_to


def test_edit_assertion_touches_only_that_field():
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "edit_assertion",
                   {"target": "状态", "field": "required", "value": True})
    p = oir.properties[pt.rid]
    assert p.required.value is True and p.required.origin is Origin.USER
    # 其它断言的来源没被动 —— 结构化编辑的全部意义就在这
    assert p.api_name.origin is Origin.EXTRACTED
    assert p.display_name.origin is Origin.EXTRACTED


def test_no_op_can_produce_extracted_origin():
    """G-origin：任何新增/修改都不能冒充材料抽取。"""
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_object_type", {"api_name": "供应商"})
    apply_oir_edit(oir, "add_rule", {"statement": "X 必须审批", "kind": "AUTHORITY"})
    sup = next(o for o in oir.objects.values() if o.api_name.value == "供应商")
    assert sup.api_name.origin is Origin.USER
    for r in oir.rules.values():
        assert r.statement.origin is Origin.USER


def test_duplicate_api_name_rejected():
    oir, ot, pt = _oir()
    with pytest.raises(OIREditError):
        apply_oir_edit(oir, "add_object_type", {"api_name": "采购包"})


def test_link_to_nonexistent_object_rejected():
    oir, ot, pt = _oir()
    with pytest.raises(OIREditError):
        apply_oir_edit(oir, "add_link",
                       {"source": "采购包", "target": "不存在", "api_name": "x"})


def test_remove_extracted_refused_but_reject_status_allowed():
    oir, ot, pt = _oir()
    with pytest.raises(OIREditError):        # 材料抽出来的删了会丢证据
        apply_oir_edit(oir, "remove_object_type", {"target": "采购包"})
    apply_oir_edit(oir, "set_status", {"target": "采购包", "status": "rejected"})
    assert oir.objects[ot.rid].status is Status.REJECTED   # 排除是可逆的、允许


def test_remove_user_added_object_cascades():
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_object_type", {"api_name": "供应商", "display_name": "供应商"})
    apply_oir_edit(oir, "add_property", {"object": "供应商", "api_name": "评级"})
    apply_oir_edit(oir, "remove_object_type", {"target": "供应商"})
    assert not any(o.api_name.value == "供应商" for o in oir.objects.values())
    assert not any(p.api_name.value == "评级" for p in oir.properties.values())


def test_rejected_op_leaves_oir_byte_identical():
    """原子性：守卫拒绝的编辑不能留下半应用状态。"""
    oir, ot, pt = _oir()
    before = oir.to_dict()
    with pytest.raises(OIREditError):
        apply_oir_edit(oir, "add_property", {"object": "不存在的对象", "api_name": "x"})
    assert oir.to_dict() == before


def test_roundtrip_preserves_user_origin():
    """重启后加载回来，USER 来源不能被降级成 INFERRED。"""
    oir, ot, pt = _oir()
    apply_oir_edit(oir, "add_enum_value", {"property": "采购包.状态", "value": "已发布"})
    restored = oir_from_dict(oir.to_dict())
    p = next(x for x in restored.properties.values() if x.api_name.value == "状态")
    assert p.value_domain.origin is Origin.USER


async def test_oir_add_tool_is_gated_and_persists(tmp_path, monkeypatch):
    """oir.add 是 EXTERNAL：没确认时被门挡下，确认后落进 OIR 并写 oir.json。"""
    import ontocopilot.server as server
    from ontocopilot.kernel.errors import ToolDenied

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="oiredit1")
    s.dir.mkdir(parents=True, exist_ok=True)
    oir, ot, pt = _oir()
    s.state["_oir"] = oir
    reg = server._converse_tools(s)
    args = {"op": "add_enum_value", "property": "采购包.状态", "value": "已发布"}

    class Deny:
        approved = False
        pending: list = []

    with pytest.raises(ToolDenied):        # 确认门挡下改产物的动作
        await reg.call("oir.add", args, Deny(), scope="converse")
    assert "已发布" not in (oir.properties[pt.rid].value_domain.value or [])

    class OK:
        approved = True
        pending: list = []

    out = await reg.call("oir.add", args, OK(), scope="converse")
    assert "已改" in out
    assert "已发布" in oir.properties[pt.rid].value_domain.value
    assert (s.dir / "oir.json").exists()               # 落盘，重启能载回
    assert s.state["oir"]["stats"]["properties"] == 1  # 前端快照也刷了
    assert s.state["_oir_patch_log"][-1]["op"] == "add_enum_value"  # 供重跑重放
