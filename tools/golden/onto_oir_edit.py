"""导出 onto/oir_edit.py 的 golden 向量（供 ts/test/onto.oir_edit.test.ts 断言）。

每条向量记录一次 `apply_oir_edit(oir, op, args)`：起始 OIR 的 to_dict()、返回的
那句人话、结束时的 to_dict()，以及被拒时的**异常类型和逐字消息**。

被拒的用例尤其重要：`apply_oir_edit` 的原子性承诺是「拒了就一个字节都不变」，
只有把拒绝前后的 to_dict() 一起钉住才能验证它。异常消息也必须逐字钉 ——
那句话是直接念给用户/模型听的。

字节确定：不涉及时间/随机，重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BusinessRule,
    LinkType,
    ObjectType,
    Origin,
    PropertyType,
    Provenance,
    Status,
    by_user,
    extracted,
    inferred,
    make_rid,
)
from ontocopilot.onto.oir_edit import OIREditError, apply_oir_edit  # noqa: E402


def _prov() -> Provenance:
    return Provenance("f1", "采购计划.xlsx", {"kind": "cell"}, snippet="采购包",
                      extractor="docling")


def _base() -> OIR:
    """一份有材料出处的小 OIR：采购包（含属性 状态）+ 供应商（人工口述加的）。"""
    oir = OIR()
    p = _prov()
    ot = ObjectType(rid=make_rid("ot", "采购包"),
                    api_name=extracted("采购包", p), display_name=extracted("采购包", p),
                    aliases=["采购单"])
    oir.add_object(ot)
    pt = PropertyType(rid=make_rid("pt", "状态"), parent=ot.rid,
                      api_name=extracted("状态", p), display_name=extracted("状态", p),
                      base_type=extracted("STRING", p))
    oir.add_property(pt)
    sup = ObjectType(rid=make_rid("ot", "供应商"),
                     api_name=by_user("供应商", note="人工口述"),
                     display_name=by_user("供应商", note="人工口述"))
    oir.add_object(sup)
    sp = PropertyType(rid=make_rid("pt", f"{sup.rid}_评级"), parent=sup.rid,
                      api_name=by_user("评级", note="人工口述"),
                      display_name=by_user("评级", note="人工口述"),
                      base_type=by_user("STRING", note="人工口述"))
    oir.add_property(sp)
    lt = LinkType(rid=make_rid("lt", "包_供"), api_name=by_user("包_供", note="人工口述"),
                  source=ot.rid, target=sup.rid,
                  cardinality=inferred("ONE_TO_MANY"))
    oir.add_link(lt)
    br = BusinessRule(rid=make_rid("br", "采购包必须审批"),
                      statement=extracted("采购包必须审批后才能发布", p))
    oir.add_rule(br)
    at = ActionType(rid=make_rid("at", "publishPackage"),
                    api_name=by_user("publishPackage", note="人工口述"),
                    applies_to=[ot.rid], status=Status.DRAFT_FROM_API)
    oir.add_action(at)
    return oir


#: (label, [(op, args), …])。一条向量可以连着做几步 —— 幂等/级联要跨步验。
CASES: list[tuple[str, list[tuple[str, dict[str, Any]]]]] = [
    ("add_enum_value", [("add_enum_value", {"property": "采购包.状态", "value": "已发布"})]),
    ("add_enum_value_twice",
     [("add_enum_value", {"property": "采购包.状态", "value": "已发布"}),
      ("add_enum_value", {"property": "采购包.状态", "value": "已发布"})]),
    ("add_object_type", [("add_object_type", {"api_name": "合同", "display_name": "合同"})]),
    ("add_object_type_min", [("add_object_type", {"api_name": "  合同  "})]),
    ("add_object_type_dup", [("add_object_type", {"api_name": "采购包"})]),
    ("add_object_type_empty", [("add_object_type", {"api_name": "   "})]),
    ("add_object_desc",
     [("add_object_type", {"api_name": "合同", "description": "买卖双方的约定"})]),
    ("add_property",
     [("add_property", {"object": "供应商", "api_name": "评分", "base_type": "DECIMAL",
                        "definition": "0-100", "required": True,
                        "value_domain": ["A", "B"]})]),
    ("add_property_dup", [("add_property", {"object": "供应商", "api_name": "评级"})]),
    ("add_property_bad_type",
     [("add_property", {"object": "供应商", "api_name": "x", "base_type": "FLOAT"})]),
    ("add_property_no_object", [("add_property", {"object": "不存在的对象", "api_name": "x"})]),
    ("add_property_alias", [("add_property", {"object": "采购单", "api_name": "金额"})]),
    ("add_link",
     [("add_link", {"source": "采购包", "target": "供应商", "api_name": "供货",
                    "cardinality": "MANY_TO_MANY", "join_key": {"a": "b"}})]),
    ("add_link_default_name", [("add_link", {"source": "采购包", "target": "供应商"})]),
    ("add_link_bad_card",
     [("add_link", {"source": "采购包", "target": "供应商", "cardinality": "ONE"})]),
    ("add_link_no_target", [("add_link", {"source": "采购包", "target": "不存在"})]),
    ("add_rule",
     [("add_rule", {"statement": "采购包创建后状态变成已发布，且必须有供应商在册",
                    "kind": "PROCESS", "applies_to": ["采购包"], "actor": "采购计划员"})]),
    ("add_rule_bad_kind", [("add_rule", {"statement": "X", "kind": "FLOW"})]),
    ("add_rule_empty", [("add_rule", {"statement": "  "})]),
    ("add_action_type",
     [("add_action_type", {"api_name": "closePackage", "applies_to": ["采购包"],
                           "parameters": [{"name": "packageId", "type": "STRING"}],
                           "effects": ["采购包.状态=已关闭"],
                           "source_endpoint": {"method": "POST", "path": "/close"}})]),
    ("add_action_type_dup", [("add_action_type", {"api_name": "publishPackage"})]),
    ("edit_assertion_required",
     [("edit_assertion", {"target": "状态", "field": "required", "value": True})]),
    ("edit_assertion_required_str",
     [("edit_assertion", {"target": "状态", "field": "required", "value": "是"})]),
    ("edit_assertion_required_no",
     [("edit_assertion", {"target": "状态", "field": "required", "value": "否"})]),
    ("edit_assertion_effects",
     [("edit_assertion", {"target": "publishPackage", "field": "effects",
                          "value": ["发送发布事件"]})]),
    ("edit_assertion_base_type",
     [("edit_assertion", {"target": "状态", "field": "base_type", "value": "ENUM"})]),
    ("edit_assertion_bad_value",
     [("edit_assertion", {"target": "状态", "field": "base_type", "value": "FLOAT"})]),
    ("edit_assertion_bad_field",
     [("edit_assertion", {"target": "状态", "field": "owner", "value": "x"})]),
    ("edit_assertion_field_not_on_entity",
     [("edit_assertion", {"target": "采购包", "field": "definition", "value": "x"})]),
    ("edit_assertion_note",
     [("edit_assertion", {"target": "状态", "field": "definition", "value": "单据状态",
                          "note": "王工口述"})]),
    ("edit_assertion_cardinality",
     [("edit_assertion", {"target": make_rid("lt", "包_供"), "field": "cardinality",
                          "value": "ONE_TO_ONE"})]),
    ("set_status_rejected",
     [("set_status", {"target": "采购包", "status": "rejected"})]),
    ("set_status_bad", [("set_status", {"target": "采购包", "status": "maybe"})]),
    ("bind_rule", [("bind_rule", {"rule": "审批", "object": "供应商"})]),
    ("bind_rule_twice",
     [("bind_rule", {"rule": "审批", "object": "供应商"}),
      ("bind_rule", {"rule": "审批", "object": "供应商"})]),
    ("set_action_scope",
     [("set_action_scope", {"action": "publishPackage", "objects": ["采购包", "供应商"]})]),
    ("remove_extracted_object", [("remove_object_type", {"target": "采购包"})]),
    ("remove_user_object_cascades", [("remove_object_type", {"target": "供应商"})]),
    ("remove_user_property", [("remove_property", {"target": "供应商.评级"})]),
    ("remove_extracted_property", [("remove_property", {"target": "采购包.状态"})]),
    ("remove_link", [("remove_link", {"target": make_rid("lt", "包_供")})]),
    ("remove_link_by_name", [("remove_link", {"target": "包_供"})]),
    ("remove_extracted_rule", [("remove_rule", {"target": "审批"})]),
    ("remove_action", [("remove_action_type", {"target": "publishPackage"})]),
    ("unknown_op", [("frobnicate", {"x": 1})]),
    ("missing_kwarg", [("add_object_type", {})]),
    ("missing_two_kwargs", [("add_property", {})]),
    ("missing_three_kwargs", [("edit_assertion", {})]),
    ("unexpected_kwarg", [("add_object_type", {"api_name": "x", "nope": 1})]),
    ("unexpected_wins_over_missing", [("add_object_type", {"nope": 1})]),
    ("ambiguous_object", [("add_property", {"object": "采购", "api_name": "x"})]),
    ("substring_object", [("add_property", {"object": "供应", "api_name": "x"})]),
    ("find_by_rid", [("set_status", {"target": make_rid("ot", "采购包"),
                                     "status": "confirmed"})]),
    ("resolve_action_by_substring",
     [("set_status", {"target": "publish", "status": "confirmed"})]),
    ("resolve_nothing", [("set_status", {"target": "根本没有这个东西", "status": "confirmed"})]),
]


def main() -> None:
    out: list[dict[str, Any]] = []
    for label, steps in CASES:
        oir = _base()
        rec: dict[str, Any] = {"label": label, "before": oir.to_dict(), "steps": []}
        for op, args in steps:
            snapshot = oir.to_dict()
            try:
                note = apply_oir_edit(oir, op, args)
                rec["steps"].append({"op": op, "args": args, "ok": True, "note": note,
                                     "after": oir.to_dict()})
            except OIREditError as exc:
                rec["steps"].append({"op": op, "args": args, "ok": False,
                                     "error": "OIREditError", "message": str(exc),
                                     # 原子性：拒了之后必须与拒之前逐字节相同
                                     "unchanged": oir.to_dict() == snapshot,
                                     "after": oir.to_dict()})
            except Exception as exc:  # noqa: BLE001 —— 非 OIREditError 也要钉住
                rec["steps"].append({"op": op, "args": args, "ok": False,
                                     "error": type(exc).__name__, "message": str(exc),
                                     "unchanged": oir.to_dict() == snapshot,
                                     "after": oir.to_dict()})
        out.append(rec)

    origins = {"USER": Origin.USER.value, "EXTRACTED": Origin.EXTRACTED.value,
               "AUTO_REPAIRED": Origin.AUTO_REPAIRED.value, "INFERRED": Origin.INFERRED.value}
    dst = ROOT / "golden" / "onto.oir_edit.json"
    dst.write_text(json.dumps({"origins": origins, "cases": out},
                              ensure_ascii=False, indent=1), "utf-8")
    print(f"wrote {dst} ({dst.stat().st_size} bytes, {len(out)} cases)")


if __name__ == "__main__":
    main()
