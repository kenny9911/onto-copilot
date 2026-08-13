"""导出 onto/oir.py 的 golden —— 给 TS 侧 ts/src/onto/oir.ts 当安全网。

`golden/pipeline.oir.json` 是真材料跑出来的完整 OIR，但它的 properties / links /
rules 三个容器是空的（那份材料里没有），于是 PropertyType / LinkType /
BusinessRule 的 to_dict 形状、以及 validate / dependents 这些跨容器的逻辑
一条都没被钉住。这个脚本补上那部分，外加三处 Python 与 JS 必然分叉的地方：

  1. ``cite()`` 在字段缺失时打印的是 ``None``（f-string 的 str(None)），
     JS 的 String(undefined) 是 ``undefined`` —— 出处串会直接印进 xlsx 批注；
  2. ``round(x, 3)`` 是 banker's rounding，JS 的 Math.round 是 half-up；
  3. ``snippet[:300]`` 按 code point 切，JS 的 slice 按 UTF-16 code unit 切。

跑法::

    .venv/bin/python tools/golden/oir.py

产物 golden/oir.json。**字节确定**：全部输入都是字面量，重跑哈希一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    Assertion,
    BaseType,
    BusinessRule,
    Cardinality,
    LinkType,
    ObjectType,
    OpenQuestion,
    Origin,
    PropertyType,
    Provenance,
    RuleKind,
    Status,
    by_user,
    extracted,
    inferred,
    make_rid,
    oir_from_dict,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  1. cite() —— 溯源的门面，每种 locator 一个形态
# ══════════════════════════════════════════════════════════════════
CITE_CASES: list[tuple[str, dict[str, Any]]] = [
    ("实体梳理.xlsx", {"kind": "cell", "sheet": "业务对象实体梳理", "row": 44, "col": "F"}),
    ("实体梳理.xlsx", {"kind": "cell"}),  # 缺 sheet/row/col → "!!RNoneCNone"
    ("材料.xlsx", {"kind": "range", "sheet": "业务对象API梳理-行动", "rows": [2, 7]}),
    ("材料.xlsx", {"kind": "range", "sheet": "空表"}),  # 缺 rows → 默认 [0, 0]
    ("openapi.json", {"kind": "json", "pointer": "$.components.schemas.Plan"}),
    ("openapi.json", {"kind": "json"}),
    ("schema.ddl", {"kind": "ddl", "object": "clm_contract"}),
    ("扫描件.pdf", {"kind": "page", "page": 2, "bbox": [10, 20, 30, 40]}),
    ("扫描件.pdf", {"kind": "page"}),
    ("实体梳理.xlsx", {"kind": "meta", "field": "workbook.xml/absPath"}),
    ("流程.bpmn", {"kind": "xml", "pointer": "/definitions/process/task[3]"}),
    ("会议纪要.docx", {"kind": "raw", "ref": "第3段「计划金额」附近"}),
    ("怪东西.bin", {"kind": "不认识的种类"}),  # 未知 kind → 只剩文件名
    ("裸文件", {}),  # 完全没有 kind
]


def export_cite() -> list[dict[str, Any]]:
    out = []
    for name, loc in CITE_CASES:
        p = Provenance("f1", name, loc)
        out.append({"file_name": name, "locator": loc, "out": p.cite()})
    return out


# ══════════════════════════════════════════════════════════════════
#  2. round(x, 3) 与 snippet[:300]
# ══════════════════════════════════════════════════════════════════
ROUND_CASES = [
    0.5, 0.8, 0.4, 0.98, 1.0, 0.0,
    # 二进制精确的「四位小数以 5 结尾」—— 唯一能踩到 banker's rounding 的值
    0.0625, 0.1875, 0.3125, 0.9375, -0.0625,
    0.12345, 0.0005, 0.9999, 1.0005, 2.6755,
    1 / 3, 2 / 3, 0.145, 0.155,
]

LONG_SNIPPET = "甲" * 200 + "🐍" * 100 + "z" * 100  # 400 code points，含代理对


def export_scalars() -> dict[str, Any]:
    p = Provenance("f1", "长文.xlsx", {"kind": "meta", "field": "x"},
                   snippet=LONG_SNIPPET, confidence=0.0625)
    return {
        "round3": [{"in": x, "out": round(x, 3)} for x in ROUND_CASES],
        "snippet_truncation": {"in": LONG_SNIPPET, "out": p.to_dict()["snippet"]},
        # confidence=0.0625 经 round(…, 3) 落到 0.062（half-even），不是 0.063
        "prov_to_dict": p.to_dict(),
    }


# ══════════════════════════════════════════════════════════════════
#  3. 工厂 & Assertion
# ══════════════════════════════════════════════════════════════════
def export_assertions() -> dict[str, Any]:
    ev = Provenance("f3", "实体梳理.xlsx",
                    {"kind": "cell", "sheet": "业务对象实体梳理", "row": 44, "col": "F"},
                    snippet="计划金额（含税，年度累计）", extractor="docling", confidence=0.94)
    bad = Assertion("planAmount", Origin.EXTRACTED, [])
    return {
        "extracted": extracted("planAmount", ev).to_dict(),
        "extracted_conf": extracted("label", ev, confidence=1.0).to_dict(),
        "inferred": inferred(None).to_dict(),
        "by_user_plain": by_user("采用含税口径").to_dict(),
        "by_user_note": by_user("采用含税口径", note="王明在评审会上拍板").to_dict(),
        "validate_bad": bad.validate("pt_x.apiName"),
        "validate_ok": inferred("planAmount").validate("pt_x.apiName"),
        "grounded": [inferred("x").grounded, extracted("x", ev).grounded],
        "cites": extracted("x", ev, ev).cites(),
    }


# ══════════════════════════════════════════════════════════════════
#  4. 完整 OIR —— 六个容器都非空
# ══════════════════════════════════════════════════════════════════
def _xlsx(row: int, snippet: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
                      snippet=snippet, extractor="docling", confidence=0.94)


def _ddl(obj: str, snippet: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snippet, extractor="sqlglot", confidence=0.9)


def build_oir() -> OIR:
    """复刻设计稿里的「计划金额」双口径场景，六个容器都填上。"""
    o = OIR()
    plan = o.add_object(ObjectType(
        rid=make_rid("ot", "purchase_plan_header"),
        api_name=extracted("purchasePlanHeader", _xlsx(2, "采购业务计划头")),
        display_name=extracted("采购业务计划头", _xlsx(2, "采购业务计划头")),
        description=inferred("采购需求计划的头表"),
        primary_key=inferred(["pt_plan_id"]),
        aliases=["采购需求计划"],
    ))
    contract = o.add_object(ObjectType(
        rid=make_rid("ot", "clm_contract"),
        api_name=extracted("clmContract", _ddl("clm_contract", "CREATE TABLE clm_contract")),
        display_name=extracted("采购合同", _xlsx(44, "采购合同")),
        primary_key=inferred(["pt_contract_id"]),
        owner="李强",
        status=Status.CONFIRMED,
        conflicts=["cf_naming_1"],
    ))
    o.add_object(ObjectType(  # 孤儿：没有任何 Link，也没有 Action
        rid=make_rid("ot", "supplier"),
        api_name=extracted("supplier", _ddl("supplier", "CREATE TABLE supplier")),
        display_name=inferred("供应商"),
    ))
    o.add_property(PropertyType(
        rid="pt_plan_id", parent=plan.rid,
        api_name=extracted("planId", _xlsx(2, "planId")),
        display_name=extracted("计划编号", _xlsx(2, "计划编号")),
        base_type=extracted(BaseType.STRING, _ddl("pbp_header", "plan_id VARCHAR(32)")),
        definition=extracted("主键", _xlsx(2, "主键")),
        required=extracted(True, _ddl("pbp_header", "NOT NULL")),
    ))
    o.add_property(PropertyType(
        rid="pt_contract_id", parent=contract.rid,
        api_name=extracted("contractId", _ddl("clm_contract", "contract_id VARCHAR(32)")),
        display_name=extracted("合同编号", _ddl("clm_contract", "contract_id")),
        base_type=extracted(BaseType.STRING, _ddl("clm_contract", "contract_id VARCHAR(32)")),
        definition=extracted("主键", _ddl("clm_contract", "PRIMARY KEY")),
    ))
    o.add_property(PropertyType(
        rid="pt_plan_amount_budget", parent=plan.rid,
        api_name=extracted("planAmount", _xlsx(44, "planAmount")),
        display_name=extracted("计划金额", _xlsx(44, "计划金额")),
        base_type=extracted(BaseType.DECIMAL, _xlsx(44, "DECIMAL(18,2)")),
        definition=extracted("含税，年度累计，CNY", _xlsx(44, "计划金额（含税，年度累计）")),
        semantic_type=inferred("money"),
        unit=extracted("CNY", _xlsx(44, "币种=CNY")),
        value_domain=extracted(["草稿", "已提交", "已审批"], _xlsx(45, "状态枚举")),
        owner="王明",
        status=Status.PROPOSED,
        conflicts=["cf_semantic_1"],
    ))
    o.add_link(LinkType(
        rid="lt_plan_contract",
        api_name=extracted("planContracts", _ddl("clm_contract", "FOREIGN KEY (plan_id)")),
        source=plan.rid, target=contract.rid,
        cardinality=extracted(Cardinality.ONE_TO_MANY, _ddl("clm_contract", "FK")),
        join_key=extracted({"fromProp": "pt_plan_id", "toProp": "pt_contract_id"},
                           _ddl("clm_contract", "REFERENCES pbp_header(plan_id)")),
    ))
    o.add_action(ActionType(
        rid="at_createpbp",
        api_name=extracted("createPbp", _xlsx(2, "创建PBP")),
        applies_to=[plan.rid],
        parameters=inferred([{"name": "planId", "baseType": "STRING"}]),
        effects=extracted(["create:ot_purchase_plan_header"], _xlsx(2, "创建")),
        source_endpoint=extracted({"path": "/v1/createPbp", "display": "创建PBP"},
                                  _xlsx(2, "url=/v1/createPbp")),
        status=Status.DRAFT_FROM_API,
    ))
    o.add_rule(BusinessRule(
        rid="br_amount_gate",
        statement=extracted("计划金额超过 100 万时必须走二级审批。",
                            _xlsx(88, "计划金额超过100万时必须走二级审批")),
        kind=extracted(RuleKind.AUTHORITY, _xlsx(88, "审批权限")),
        applies_to=[plan.rid],
        actor=extracted("采购计划员", _xlsx(88, "责任岗位=采购计划员")),
    ))
    o.add_rule(BusinessRule(rid="br_orphan", statement=inferred("一条没挂上对象的规则。")))
    o.add_question(OpenQuestion(
        rid="oq_amount_axis",
        text=extracted("「计划金额」到底是含税还是不含税？", _xlsx(44, "计划金额")),
        options=["含税", "不含税"],
        group="采购计划管理",
        code="Q-017",
        applies_to=["pt_plan_amount_budget"],
        asked_by="system",
    ))
    o.add_question(OpenQuestion(
        rid="oq_answered",
        text=extracted("一条需求能不能只安排部分数量？", _xlsx(90, "部分安排")),
        answer=by_user("可以，剩余数量留在原需求上", note="王明"),
        group="采购计划管理",
        code="Q-046",
        owner="王明",
        status=Status.CONFIRMED,
    ))
    o.add_question(OpenQuestion(  # 答复只有空白 → 仍算未答
        rid="oq_blank_answer",
        text=inferred("空白答复算不算已答？"),
        answer=extracted("   \n  ", _xlsx(91, "  ")),
    ))
    return o


def export_oir() -> dict[str, Any]:
    o = build_oir()
    d = o.to_dict()
    rt = oir_from_dict(d).to_dict()
    assert rt == d, "oir_from_dict → to_dict 往返在 Python 侧就不闭合，先修 Python"

    broken = build_oir()
    broken.objects[make_rid("ot", "clm_contract")].primary_key = inferred([])
    broken.objects[make_rid("ot", "purchase_plan_header")].primary_key = inferred(["pt_ghost"])
    broken.links["lt_plan_contract"].source = "ot_ghost"
    broken.links["lt_plan_contract"].join_key = inferred(None)
    broken.properties["pt_plan_id"].parent = "ot_ghost"
    broken.properties["pt_contract_id"].api_name = Assertion("contractId", Origin.EXTRACTED, [])

    return {
        "to_dict": d,
        "validate_clean": o.validate(),
        "validate_broken": broken.validate(),
        "dependents": {r: o.dependents(r) for r in [
            make_rid("ot", "purchase_plan_header"), make_rid("ot", "clm_contract"),
            "pt_plan_id", "pt_contract_id", "at_createpbp", "不存在的rid"]},
        "props_of": {r: [p.rid for p in o.props_of(r)] for r in [
            make_rid("ot", "purchase_plan_header"), make_rid("ot", "supplier")]},
        "orphans": [x.rid for x in o.orphans()],
        "objects_without_actions": [x.rid for x in o.objects_without_actions()],
        "answered": {q.rid: q.answered for q in o.questions.values()},
    }


# ══════════════════════════════════════════════════════════════════
#  5. oir_from_dict 的容错 —— 脏输入进来会变成什么
# ══════════════════════════════════════════════════════════════════
DIRTY: dict[str, Any] = {
    "objects": [{
        "rid": "ot_dirty",
        # 断言不是 dict，直接给裸值 → 退化成 inferred
        "apiName": "dirtyObject",
        # origin 不认识 → inferred；confidence 是 0 → 走 `or` 落回 0.5（不是 0）
        "displayName": {"value": "脏对象", "origin": "外星人", "confidence": 0,
                        "evidence": [{"file_name": "x.xlsx", "locator": {"kind": "page"},
                                      "confidence": 0}]},
        # 整个字段缺失 → _assert_from(None) → inferred(None)
        "properties": None,
        "aliases": ["别名"],
        "status": "不认识的状态",
        "conflicts": None,
    }],
    "properties": [{
        "rid": "pt_dirty", "parent": "ot_dirty",
        "apiName": {"value": "dirty", "origin": "user", "confidence": 0.98},
        # baseType 不在枚举里 → 转换失败，原样保留字符串
        "baseType": {"value": "WEIRD_TYPE", "origin": "extracted"},
        "valueDomain": {"value": ["a", "b"]},
    }],
    "links": [{
        "rid": "lt_dirty", "from": "ot_dirty", "to": "ot_missing",
        "cardinality": {"value": "ONE_TO_MANY"},
        "joinKey": {"value": {"fromProp": "pt_dirty"}},
    }],
    "actions": [{"rid": "at_dirty", "appliesTo": ["ot_dirty"]}],
    "rules": [{"rid": "br_dirty", "statement": {"value": "规则"},
               "ruleKind": {"value": "VALIDATION", "origin": "extracted",
                            "evidence": [{"file_id": "f1", "file_name": "x", "locator": {}}]}}],
    "questions": [{"rid": "oq_dirty", "text": {"value": "问题？"},
                   "answer": {"value": "  "},
                   "askedBy": None, "group": None, "owner": None}],
    # stats 是导出物，输入里的值应当被忽略、重新算
    "stats": {"objects": 999},
}


#: 问题上缺 ``answer`` 字段（旧格式 / 手写 JSON）会让整份 OIR 的 to_dict 炸掉：
#: ``_assert_from(None)`` 还原出 ``Assertion(None)``，而 ``answered`` 直接
#: ``.value.strip()``。这不是 TS 侧要"修好"的东西 —— Python 是行为权威，TS 必须
#: 同样炸（静默当成未答会让统计数字和 Python 对不上），所以把炸的形状也导出来。
NO_ANSWER: dict[str, Any] = {"questions": [{"rid": "oq_no_answer", "text": {"value": "问？"}}]}


def export_dirty() -> dict[str, Any]:
    try:
        oir_from_dict(NO_ANSWER).to_dict()
        raise SystemExit("Python 侧不再炸了？重新核对 answered 的实现")
    except AttributeError as e:
        crash = f"{type(e).__name__}: {e}"
    return {"in": DIRTY, "out": oir_from_dict(DIRTY).to_dict(),
            "missing_answer_in": NO_ANSWER, "missing_answer_raises": crash}


def main() -> None:
    obj = {
        "cite": export_cite(),
        "scalars": export_scalars(),
        "assertions": export_assertions(),
        "oir": export_oir(),
        "from_dict_dirty": export_dirty(),
    }
    OUT.mkdir(exist_ok=True)
    p = OUT / "oir.json"
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  oir.json {p.stat().st_size} B")


if __name__ == "__main__":
    main()
