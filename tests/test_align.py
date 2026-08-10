"""实体对齐 —— 取向是宁可漏合并，不可错合并。"""

from __future__ import annotations

from ontocopilot.onto.align import AlignPolicy, EntityAligner, align_and_apply, tokens
from ontocopilot.onto.oir import (
    OIR,
    BaseType,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    extracted,
    inferred,
)


def _px(snip: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "S", "row": 2, "col": "C"},
                      snippet=snip, extractor="docling")


def _pd(obj: str, snip: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snip, extractor="sqlglot")


def _obj(rid, api, disp, ev, aliases=()) -> ObjectType:
    return ObjectType(rid=rid, api_name=extracted(api, ev), display_name=extracted(disp, ev),
                      primary_key=inferred([]), aliases=list(aliases))


def _prop(oir, rid, parent, api, base=BaseType.STRING):
    oir.add_property(PropertyType(
        rid=rid, parent=parent, api_name=extracted(api, _px(api)),
        display_name=extracted(api, _px(api)), base_type=extracted(base, _px(api)),
        definition=extracted("", _px(api))))


def test_tokens_strip_structural_suffixes():
    """`header` 是结构角色，不该贡献区分度。"""
    assert "header" not in tokens("purchasePlanHeader")
    assert tokens("purchasePlanHeader") == {"purchase", "plan"}
    assert tokens("plan_amount") == {"plan", "amount"}
    assert tokens("头") == {"头"}  # 全是结构词时别清空


def test_same_concept_across_files_is_merged():
    """DDL 的 pbpHeader 和梳理表的 purchasePlanHeader 是同一个东西。"""
    oir = OIR()
    a = oir.add_object(_obj("ot_a", "pbpHeader", "采购业务计划头",
                            _pd("pbp_header", "CREATE TABLE pbp_header")))
    b = oir.add_object(_obj("ot_b", "purchasePlanHeader", "采购需求计划", _px("采购需求计划"),
                            aliases=["pbpHeader"]))
    for rid, parent in [("p1", a.rid), ("p2", a.rid), ("p3", b.rid), ("p4", b.rid)]:
        _prop(oir, rid, parent, {"p1": "planId", "p2": "planAmount",
                                 "p3": "planId", "p4": "planAmount"}[rid])

    result, log = align_and_apply(oir)
    assert len(oir.objects) == 1, "应合并成一个"
    assert log and log[0]["into"] == "ot_a"
    kept = next(iter(oir.objects.values()))
    assert "purchasePlanHeader" in kept.aliases or "采购需求计划" in kept.aliases


def test_ddl_backed_name_wins_the_election():
    """物理名是系统里实际存在的东西，业务名是人的说法。"""
    oir = OIR()
    biz = oir.add_object(_obj("ot_biz", "purchasePlan", "采购计划", _px("采购计划")))
    phys = oir.add_object(_obj("ot_phys", "pbpHeader", "采购业务计划头",
                               _pd("pbp_header", "CREATE TABLE")))
    for rid, parent in [("p1", biz.rid), ("p2", phys.rid)]:
        _prop(oir, rid, parent, "planId")
    _prop(oir, "p3", biz.rid, "planAmount")
    _prop(oir, "p4", phys.rid, "planAmount")

    align_and_apply(oir)
    assert set(oir.objects) == {"ot_phys"}


def test_name_similar_but_structurally_unrelated_is_not_merged():
    """错误合并会把两个对象的属性混在一起，之后极难拆开。"""
    oir = OIR()
    a = oir.add_object(_obj("ot_a", "purchasePlan", "采购计划", _px("采购计划")))
    b = oir.add_object(_obj("ot_b", "purchasePlanTemplate", "采购计划模板", _px("模板")))
    _prop(oir, "p1", a.rid, "planId")
    _prop(oir, "p2", a.rid, "planAmount")
    _prop(oir, "p3", b.rid, "templateId")
    _prop(oir, "p4", b.rid, "layoutJson")

    result, log = align_and_apply(oir)
    assert len(oir.objects) == 2, "字段毫无重叠，不该合并"
    assert log == []


def test_pure_name_match_without_structure_goes_to_review():
    """名字一模一样但两边都没属性 —— 存疑，不自动合并。"""
    oir = OIR()
    oir.add_object(_obj("ot_a", "purchasePlan", "采购计划", _px("A")))
    oir.add_object(_obj("ot_b", "purchasePlan", "采购计划", _pd("t", "B")))

    result = EntityAligner().align(oir)
    assert result.merged == {}
    assert result.uncertain, "该进人工复核队列而不是被静默丢掉"
    assert any("无结构证据" in r for s in result.uncertain for r in s.reasons)


def test_alias_evidence_is_recorded_in_the_score():
    oir = OIR()
    oir.add_object(_obj("ot_a", "pbpHeader", "采购业务计划头", _pd("t", "x")))
    oir.add_object(_obj("ot_b", "purchasePlanHeader", "采购需求计划", _px("y"),
                        aliases=["pbpHeader"]))
    scores = EntityAligner().align(oir).scores
    assert scores and scores[0].alias
    assert any("别名重合" in r for r in scores[0].reasons)


def test_scores_keep_their_reasons_for_audit():
    """合并是不可逆的，事后要能回答"当初凭什么把这两个合了"。"""
    oir = OIR()
    a = oir.add_object(_obj("ot_a", "pbpHeader", "计划头", _pd("t", "x")))
    b = oir.add_object(_obj("ot_b", "purchasePlanHeader", "计划头", _px("y")))
    _prop(oir, "p1", a.rid, "planId")
    _prop(oir, "p2", b.rid, "planId")

    s = EntityAligner().align(oir).scores[0]
    assert s.reasons and s.to_dict()["total"] > 0
    assert any("字段重叠" in r for r in s.reasons)


def test_transitive_clusters_are_merged_together():
    """A≡B、B≡C 就该是一个簇。"""
    oir = OIR()
    for i, (rid, api) in enumerate(
            [("ot_a", "pbpHeader"), ("ot_b", "purchasePlanHeader"),
             ("ot_c", "planHeader")]):
        oir.add_object(_obj(rid, api, "采购计划头", _pd("t", api) if i == 0 else _px(api)))
        for f in ("planId", "planAmount", "planName"):
            _prop(oir, f"{rid}_{f}", rid, f)

    align_and_apply(oir)
    assert len(oir.objects) == 1


def test_merge_repoints_properties_links_and_actions():
    oir = OIR()
    a = oir.add_object(_obj("ot_a", "pbpHeader", "计划头", _pd("t", "x")))
    b = oir.add_object(_obj("ot_b", "purchasePlanHeader", "计划头", _px("y")))
    c = oir.add_object(_obj("ot_c", "clmContract", "采购合同", _pd("c", "z")))
    for rid, parent in [("p1", a.rid), ("p2", b.rid)]:
        _prop(oir, rid, parent, "planId")
    _prop(oir, "p3", a.rid, "planAmount")
    _prop(oir, "p4", b.rid, "planAmount")
    _prop(oir, "p5", c.rid, "contractId")
    ev = _pd("clm", "FK")
    oir.add_link(LinkType(rid="lt", api_name=extracted("planContracts", ev),
                          source="ot_b", target="ot_c",
                          cardinality=extracted("ONE_TO_MANY", ev),
                          join_key=inferred(None)))

    align_and_apply(oir)
    assert set(oir.objects) == {"ot_a", "ot_c"}
    assert oir.links["lt"].source == "ot_a", "关系两端要跟着改挂"
    assert {p.parent for p in oir.properties.values() if p.rid in ("p1", "p2", "p3", "p4")} \
        == {"ot_a"}


def test_blocking_skips_pairs_with_nothing_in_common():
    oir = OIR()
    for rid, api in [("ot_a", "purchasePlan"), ("ot_b", "supplierBank"),
                     ("ot_c", "taxCode")]:
        oir.add_object(_obj(rid, api, api, _px(api)))
    scores = EntityAligner().align(oir).scores
    assert scores == [], "毫无共词的对象对不该进入打分"


def test_policy_thresholds_are_tunable():
    oir = OIR()
    a = oir.add_object(_obj("ot_a", "purchasePlan", "采购计划", _px("A")))
    b = oir.add_object(_obj("ot_b", "purchasePlanV2", "采购计划V2", _px("B")))
    _prop(oir, "p1", a.rid, "planId")
    _prop(oir, "p2", b.rid, "planId")

    strict = EntityAligner(AlignPolicy(merge_at=0.99)).align(oir)
    loose = EntityAligner(AlignPolicy(merge_at=0.3)).align(oir)
    assert not strict.merged and loose.merged
