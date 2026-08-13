"""领域层：OIR 溯源、冲突分类、澄清排序、决策回写。"""

from __future__ import annotations

import pytest

from ontocopilot.onto.clarify import ClarificationEngine, apply_decision
from ontocopilot.onto.conflict import (
    ConflictKind,
    Handling,
    auto_repair,
    axis_diff,
    detect_all,
    detect_missing_actions,
    detect_naming,
    detect_perfunctory,
    detect_semantic_divergence,
    parse_axes,
    perfunctory_signals,
    to_camel,
)
from ontocopilot.onto.oir import (
    OIR,
    BaseType,
    Cardinality,
    LinkType,
    ObjectType,
    Origin,
    PropertyType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)


# ══════════════════════════════════════════════════════════════════
#  fixtures —— 复刻设计稿里的「计划金额」双口径场景
# ══════════════════════════════════════════════════════════════════
def _xlsx(row: int, snippet: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
                      snippet=snippet, extractor="docling", confidence=0.94)


def _ddl(obj: str, snippet: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snippet, extractor="sqlglot", confidence=0.9)


@pytest.fixture
def oir() -> OIR:
    o = OIR()
    plan = o.add_object(ObjectType(
        rid=make_rid("ot", "purchase_plan_header"),
        api_name=extracted("purchasePlanHeader", _xlsx(2, "采购业务计划头")),
        display_name=extracted("采购业务计划头", _xlsx(2, "采购业务计划头")),
        primary_key=inferred(["pt_plan_id"]),
    ))
    contract = o.add_object(ObjectType(
        rid=make_rid("ot", "clm_contract"),
        api_name=extracted("clmContract", _ddl("clm_contract", "CREATE TABLE clm_contract")),
        display_name=extracted("采购合同", _xlsx(44, "采购合同")),
        primary_key=inferred(["pt_contract_id"]),
    ))
    o.add_property(PropertyType(
        rid="pt_plan_id", parent=plan.rid,
        api_name=extracted("planId", _xlsx(2, "planId")),
        display_name=extracted("计划编号", _xlsx(2, "计划编号")),
        base_type=extracted(BaseType.STRING, _ddl("pbp_header", "plan_id VARCHAR(32)")),
        definition=extracted("主键", _xlsx(2, "主键")),
    ))
    o.add_property(PropertyType(
        rid="pt_contract_id", parent=contract.rid,
        api_name=extracted("contractId", _ddl("clm_contract", "contract_id VARCHAR(32)")),
        display_name=extracted("合同编号", _ddl("clm_contract", "contract_id")),
        base_type=extracted(BaseType.STRING, _ddl("clm_contract", "contract_id VARCHAR(32)")),
        definition=extracted("主键", _ddl("clm_contract", "PRIMARY KEY")),
    ))
    # ★ 同名同类型，只有口径不同 —— 纯 schema 比对发现不了
    o.add_property(PropertyType(
        rid="pt_plan_amount_budget", parent=plan.rid,
        api_name=extracted("planAmount", _xlsx(44, "planAmount")),
        display_name=extracted("计划金额", _xlsx(44, "计划金额")),
        base_type=extracted(BaseType.DECIMAL, _xlsx(44, "DECIMAL(18,2)")),
        definition=extracted("含税，年度累计，CNY", _xlsx(44, "计划金额（含税，年度累计）")),
        owner="王明",
    ))
    o.add_property(PropertyType(
        rid="pt_plan_amount_contract", parent=contract.rid,
        api_name=extracted("planAmount", _ddl("clm_contract", "plan_amount")),
        display_name=extracted("计划金额", _ddl("clm_contract", "plan_amount")),
        base_type=extracted(BaseType.DECIMAL, _ddl("clm_contract", "DECIMAL(18,2)")),
        definition=extracted("不含税，单次，CNY", _ddl("clm_contract", "-- 不含税·单次")),
        owner="李强",
    ))
    o.add_link(LinkType(
        rid="lt_plan_contract",
        api_name=extracted("planContracts", _ddl("clm_contract", "FOREIGN KEY (plan_id)")),
        source=plan.rid, target=contract.rid,
        cardinality=extracted(Cardinality.ONE_TO_MANY, _ddl("clm_contract", "FK")),
        join_key=extracted({"fromProp": "pt_plan_id", "toProp": "pt_contract_id"},
                           _ddl("clm_contract", "REFERENCES pbp_header(plan_id)")),
    ))
    return o


# ══════════════════════════════════════════════════════════════════
#  溯源
# ══════════════════════════════════════════════════════════════════
def test_citations_point_back_to_exact_positions():
    """FDE 追问「你是怎么知道的」时，系统必须能立刻给出确切位置。"""
    assert _xlsx(44, "").cite() == "实体梳理.xlsx!业务对象实体梳理!R44CF"
    assert _ddl("clm_contract", "").cite() == "schema.ddl#clm_contract"
    assert Provenance("f1", "openapi.json",
                      {"kind": "json", "pointer": "$.components.schemas.Plan"}).cite() \
        == "openapi.json#$.components.schemas.Plan"
    assert Provenance("f3", "实体梳理.xlsx",
                      {"kind": "meta", "field": "workbook.xml/absPath"}).cite() \
        == "实体梳理.xlsx#workbook.xml/absPath"


def test_extracted_without_evidence_is_invalid():
    """类型系统逼你要么拿出出处，要么显式标 INFERRED。"""
    from ontocopilot.onto.oir import Assertion

    bad = Assertion("planAmount", Origin.EXTRACTED, [])
    assert bad.validate("pt_x.apiName") == ["pt_x.apiName: origin=EXTRACTED 但没有 evidence"]
    assert inferred("planAmount").validate("pt_x.apiName") == []
    assert not inferred("x").grounded and extracted("x", _xlsx(1, "")).grounded


def test_oir_validate_catches_structural_problems(oir):
    assert oir.validate() == []
    oir.objects[make_rid("ot", "clm_contract")].primary_key = inferred([])
    oir.links["lt_plan_contract"].source = "ot_ghost"
    errs = oir.validate()
    assert any("未声明主键" in e for e in errs)
    assert any("ot_ghost" in e for e in errs)


def test_dependents_gives_blast_radius(oir):
    plan = make_rid("ot", "purchase_plan_header")
    deps = oir.dependents(plan)
    assert "pt_plan_amount_budget" in deps and "lt_plan_contract" in deps


# ══════════════════════════════════════════════════════════════════
#  口径的结构化比较
# ══════════════════════════════════════════════════════════════════
def test_axes_are_parsed_from_free_text():
    assert parse_axes("含税，年度累计，CNY") == {
        "税": "含税", "时间粒度": "年度累计", "币种": "CNY"}


def test_axis_diff_reports_which_axis_conflicts():
    """报"哪个轴冲突"，而不是笼统的"口径不一致" —— 这决定了怎么修。"""
    d = axis_diff("含税，年度累计", "不含税，单次")
    assert d == {"税": ("含税", "不含税"), "时间粒度": ("年度累计", "单次")}


def test_one_sided_missing_axis_is_not_a_conflict():
    """一边识别不出不是矛盾，是信息缺失 —— 走 MISSING_REQUIRED 而非 ASK_USER。"""
    assert axis_diff("含税，年度累计", "金额") == {}


# ══════════════════════════════════════════════════════════════════
#  冲突检测
# ══════════════════════════════════════════════════════════════════
def test_semantic_divergence_is_found_where_schema_comparison_cannot(oir):
    """同名、同类型、只有口径文字不同 —— 这是本产品的核心价值。"""
    cs = detect_semantic_divergence(oir)
    assert len(cs) == 1
    c = cs[0]
    assert c.kind is ConflictKind.SEMANTIC_DIVERGENCE
    assert c.handling is Handling.ASK_USER, "口径分歧绝不能自动定，必须问人"
    assert "税（含税 vs 不含税）" in c.summary
    assert set(c.subjects) == {"pt_plan_amount_budget", "pt_plan_amount_contract"}
    cites = {e.cite() for e in c.evidence}
    assert "实体梳理.xlsx!业务对象实体梳理!R44CF" in cites
    assert "schema.ddl#clm_contract" in cites


def test_split_option_generates_axis_aware_names(oir):
    c = detect_semantic_divergence(oir)[0]
    split = next(o for o in c.options if o.id == "split_two_properties")
    assert "planAmountTaxInclAnnual" in split.label
    assert "planAmountNetPerTime" in split.label


def test_naming_violations_are_auto_repairable(oir):
    oir.properties["pt_plan_amount_budget"].api_name = extracted("plan_amount", _xlsx(44, ""))
    oir.objects[make_rid("ot", "clm_contract")].api_name = extracted("采购合同", _xlsx(44, ""))

    cs = detect_naming(oir)
    kinds = {c.kind for c in cs}
    assert kinds == {ConflictKind.NAMING_VIOLATION}
    assert all(c.handling is Handling.AUTO_REPAIR for c in cs)

    log = auto_repair(oir, cs)
    assert oir.properties["pt_plan_amount_budget"].api_name.value == "planAmount"
    assert oir.properties["pt_plan_amount_budget"].api_name.origin is Origin.AUTO_REPAIRED
    assert all(entry["reversible"] for entry in log), "自动修必须可回滚"


def test_camel_normalization():
    assert to_camel("plan_amount") == "planAmount"
    assert to_camel("Plan Amount Total") == "planAmountTotal"
    assert to_camel("planAmount") == "planAmount"
    assert to_camel("采购合同") == "采购合同"  # 中文原样保留，需要人给译名


def test_semantic_divergence_is_never_auto_repaired(oir):
    """自动修的边界必须保守 —— 口径统一会丢信息。"""
    cs = detect_semantic_divergence(oir)
    assert auto_repair(oir, cs) == []
    assert oir.properties["pt_plan_amount_budget"].definition.value == "含税，年度累计，CNY"


def test_missing_actions_drafts_from_openapi(oir):
    """设计稿里的杀手锏：没人填 ActionType 时从写端点反推草稿。

    **聚合成一个政策问题** —— 23 个对象都缺 ActionType 时，「要不要反推」是
    一次决策，不是 23 次。逐个问会瞬间耗尽 FDE 的耐心。
    """
    endpoints = [
        {"operationId": "submitPurchasePlan", "method": "post",
         "path": "/purchase-plans/{id}/submit", "pointer": "$.paths./purchase-plans"},
        {"operationId": "createClmContract", "method": "post", "path": "/contracts"},
        {"operationId": "listSuppliers", "method": "get", "path": "/suppliers"},  # GET 不是动作
    ]
    cs = detect_missing_actions(oir, endpoints)
    assert len(cs) == 1, "应聚合成一个政策问题"
    c = cs[0]
    assert set(c.subjects) == set(oir.objects), "两个对象都缺 ActionType"

    draft = next(o for o in c.options if o.id == "draft_from_openapi")
    assert "覆盖 2/2 个对象" in draft.label
    assert all(e.cite().startswith("openapi.json#") for e in draft.evidence)
    ops = {op for ops in draft.effect["draft_actions"].values() for op in ops}
    assert ops == {"submitPurchasePlan", "createClmContract"}, "GET 端点不应入选"
    assert any(o.id == "leave_blank" for o in c.options)


def test_aggregated_action_question_outscores_per_object_ones(oir):
    """聚合后影响半径覆盖全部对象，这个问题才会被排进 top-3。"""
    endpoints = [{"operationId": "submitPurchasePlan", "method": "post", "path": "/p"}]
    cs = ClarificationEngine().rank(detect_missing_actions(oir, endpoints), oir)
    assert len(cs.questions) == 1
    q = cs.questions[0]
    assert "没有任何 ActionType" in q.title
    assert q.impact >= len(oir.objects)


def test_unchanged_prefill_is_caught():
    """AI 预填 62%，业务方原样交回 —— 说明他根本没审。
    不抓出来整个往返闭环就是自欺欺人。"""
    assert "UNCHANGED_PREFILL" in perfunctory_signals(
        value="含税，年度累计，CNY", ai_prefill="含税，年度累计，CNY")
    assert "COPIED_HEADER" in perfunctory_signals(value="口径定义", column_header="口径定义")
    assert "PLACEHOLDER" in perfunctory_signals(value="待定")
    assert "BULK_FILLED" in perfunctory_signals(value="按合同", column_distinct_ratio=0.05)
    # 真的该填「无」的格子不该被误伤成 TOO_SHORT 之外的信号
    assert perfunctory_signals(value="不含税单次结算金额", expects_definition=True) == []


def test_perfunctory_detection_routes_to_owner():
    cells = [
        {"rid": "pt_a", "field": "口径定义", "value": "口径定义",
         "column_header": "口径定义", "owner": "王明"},
        {"rid": "pt_b", "field": "口径定义", "value": "不含税，单次结算", "owner": "李强"},
    ]
    cs = detect_perfunctory(cells)
    assert len(cs) == 1
    assert cs[0].owner == "王明" and cs[0].handling is Handling.ROUND_TRIP


def test_detect_all_backlinks_conflicts_onto_entities(oir):
    cs = detect_all(oir)
    assert cs
    p = oir.properties["pt_plan_amount_budget"]
    assert any(c.rid in p.conflicts for c in cs if "pt_plan_amount_budget" in c.subjects)


# ══════════════════════════════════════════════════════════════════
#  澄清排序
# ══════════════════════════════════════════════════════════════════
def test_engine_asks_at_most_three_and_defers_the_rest(oir):
    endpoints = [{"operationId": "submitPurchasePlan", "method": "post", "path": "/p"}]
    conflicts = detect_all(oir, endpoints=endpoints)
    cs = ClarificationEngine(max_questions=3).rank(conflicts, oir)

    assert len(cs.questions) <= 3
    assert cs.stopped_because
    # 不问的没有被丢掉 —— 各自有归宿
    assert len(conflicts) == (
        len(cs.questions) + len(cs.auto_repairable) + len(cs.deferred_to_template)
        + len(cs.round_trip) + len(cs.hints)
    )


def test_semantic_divergence_outranks_everything_else(oir):
    conflicts = detect_all(oir, endpoints=[
        {"operationId": "submitPlan", "method": "post", "path": "/p"}])
    cs = ClarificationEngine().rank(conflicts, oir)
    assert cs.questions, "口径分歧必须被问出来"
    top = cs.questions[0]
    assert "口径不一致" in top.title
    assert not top.reversible, "口径决策不可逆，UI 上要标出来"
    assert top.impact >= 2


def test_every_option_carries_evidence(oir):
    """给不出出处的选项等于让人凭感觉拍板 —— 还不如不问。"""
    cs = ClarificationEngine().rank(detect_semantic_divergence(oir), oir)
    q = cs.questions[0]
    grounded = [o for o in q.options if o.evidence]
    assert len(grounded) >= 3


def test_low_score_conflicts_become_template_cells(oir):
    """没法在对话里解决的歧义不硬问，变成模板里的一个黄底格子。"""
    conflicts = detect_all(oir)
    cs = ClarificationEngine(max_questions=3, theta_ask=0.99).rank(conflicts, oir)
    assert cs.questions == []
    assert cs.deferred_to_template
    assert "低于阈值" in cs.stopped_because


def test_auto_repairable_conflicts_never_become_questions(oir):
    oir.properties["pt_plan_amount_budget"].api_name = extracted("plan_amount", _xlsx(44, ""))
    cs = ClarificationEngine().rank(detect_naming(oir), oir)
    assert cs.questions == []
    assert len(cs.auto_repairable) == 1


def test_eig_is_zero_when_there_is_no_real_choice(oir):
    from ontocopilot.onto.conflict import Conflict, Option

    engine = ClarificationEngine()
    single = Conflict("cf_x", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_plan_amount_budget"],
                      "只有一个选项", options=[Option("only", "唯一选择")])
    assert engine.eig(single) == 0.0
    assert engine.score(single, oir) == 0.0


def test_lopsided_evidence_lowers_priority(oir):
    """一边证据碾压另一边 → 系统可以自己倾向，不该占用人的注意力。"""
    from ontocopilot.onto.conflict import Conflict, Option

    engine = ClarificationEngine()
    balanced = Conflict("cf_a", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_plan_amount_budget"], "均衡",
                        options=[Option("a", "A", evidence=[_xlsx(1, "")]),
                                 Option("b", "B", evidence=[_ddl("t", "")])])
    lopsided = Conflict("cf_b", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_plan_amount_budget"], "一边倒",
                        options=[Option("a", "A", evidence=[_xlsx(i, "") for i in range(6)]),
                                 Option("b", "B")])
    assert engine.score(balanced, oir) > engine.score(lopsided, oir)


# ══════════════════════════════════════════════════════════════════
#  决策回写
# ══════════════════════════════════════════════════════════════════
def test_decision_is_written_back_as_user_origin(oir):
    c = detect_semantic_divergence(oir)[0]
    change = apply_decision(oir, c, "split_two_properties", note="跟李强确认过")

    assert set(change["changed"]) == {"pt_plan_amount_budget", "pt_plan_amount_contract"}
    a = oir.properties["pt_plan_amount_budget"]
    assert a.api_name.value == "planAmountTaxInclAnnual"
    assert a.api_name.origin is Origin.USER
    assert a.api_name.confidence >= 0.95, "人拍板的是业务事实，不是系统推断"
    assert "跟李强确认过" in a.api_name.evidence[0].snippet


def test_unify_option_copies_the_chosen_definition(oir):
    c = detect_semantic_divergence(oir)[0]
    apply_decision(oir, c, "unify_b", note="财务共享中心维护税率表")
    b_def = oir.properties["pt_plan_amount_contract"].definition.value
    assert oir.properties["pt_plan_amount_budget"].definition.value == b_def
    assert oir.properties["pt_plan_amount_budget"].definition.origin is Origin.USER


def test_unknown_option_fails_loudly(oir):
    c = detect_semantic_divergence(oir)[0]
    with pytest.raises(KeyError, match="没有选项"):
        apply_decision(oir, c, "nope")


# ══════════════════════════════════════════════════════════════════
#  口径正文与注解的切分（真实 LLM 输出触发过的 bug）
# ══════════════════════════════════════════════════════════════════
#: 这是 claude-opus-4.8 在真实材料上产出的口径原文。它写得很好 —— 顺带说明了
#: 与另一处的差异 —— 而正是这个"好"曾经让整串扫关键词的解析器判错了轴。
_REAL_A = ("计划金额。口径：含税，年度累计，CNY（Excel 批注 R5-5 与 DDL 注释 "
           "pbp_header.plan_amount '含税·年度累计·CNY' 一致）。注意与 "
           "clmContract.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)"
           "上口径不同，两处均保留，交业务方拍板")
_REAL_B = ("计划金额。口径：不含税，单次，CNY（Excel 批注 R8-8 与 DDL 注释 "
           "clm_contract.plan_amount '不含税·单次·CNY' 一致）。注意与 "
           "pbpHeader.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)"
           "上口径不同，两处均保留，交业务方拍板")


def test_primary_clause_drops_annotations():
    from ontocopilot.onto.conflict import primary_clause

    assert primary_clause(_REAL_A) == "含税，年度累计，CNY"
    assert primary_clause(_REAL_B) == "不含税，单次，CNY"
    assert primary_clause("不含税·单次·CNY") == "不含税·单次·CNY"


def test_axes_ignore_alternatives_mentioned_in_annotations():
    """模型写得越详细越容易踩这个坑：注解里提到的对照值不是本条的取值。"""
    assert parse_axes(_REAL_A)["税"] == "含税"
    assert parse_axes(_REAL_B)["税"] == "不含税"
    assert parse_axes(_REAL_A)["时间粒度"] == "年度累计"

    # 括号出现在取值**之前**的写法也要认得 —— 这是模型的另一种常见写法
    inline = "计划金额。口径（Excel 批注）：含税，年度累计，CNY；DDL 注释一致"
    assert parse_axes(inline)["税"] == "含税"
    assert parse_axes(inline)["时间粒度"] == "年度累计"


def test_real_llm_definitions_still_yield_the_conflict():
    """端到端：这两条真实口径必须能判出税轴与时间粒度轴的冲突。"""
    assert axis_diff(_REAL_A, _REAL_B) == {
        "税": ("含税", "不含税"), "时间粒度": ("年度累计", "单次")}


def test_ambiguous_axis_gets_no_value_rather_than_a_guess():
    """正文里就写了「含税/不含税」的，本来就没写清楚 —— 猜一个比留空危险。"""
    from ontocopilot.onto.conflict import axis_ambiguities

    text = "计划金额，含税/不含税两种口径都在用"
    assert "税" not in parse_axes(text)
    assert "税" in axis_ambiguities(text)


# ══════════════════════════════════════════════════════════════════
#  口径：认不出维度 ≠ 没问题
# ══════════════════════════════════════════════════════════════════
def _prop(rid: str, defn: str) -> PropertyType:
    p = _xlsx(9, defn)
    return PropertyType(rid=rid, parent="ot_x",
                        api_name=extracted("planAmount", p),
                        display_name=extracted("计划金额", p),
                        base_type=extracted(BaseType.DECIMAL, p),
                        definition=extracted(defn, p))


def _two(a: str, b: str) -> OIR:
    o = OIR()
    o.properties["p1"] = _prop("p1", a)
    o.properties["p2"] = _prop("p2", b)
    return o


def test_a_caliber_clash_is_reported_even_when_no_known_axis_matches():
    """**这条是全仓库唯一一处"系统主动把两个不同判断当成同一个"。**

    轴表只有四条采购财务轴。换个行业（工艺、条款、诊疗）一条都命中不了，于是
    两段内容完全不同的口径拿到同一个签名、被判成同一种，直接跳过 ——
    不是"没查出来"，是沉默地把分歧抹平。同时踩了「查不到就说查不到」和
    「口径不自行统一」两条纪律，而且换个行业整条功能归零、零告警。
    """
    cs = detect_semantic_divergence(
        _two("计划金额取工艺路线上首道工序的产能上限",
             "计划金额取末道工序的产能下限"))
    assert len(cs) == 1, "认不出轴就当没问题 —— 这正是要修的"
    assert cs[0].handling is Handling.ASK_USER
    assert "判不出是哪一维" in cs[0].summary, "判不出就要明说，不能装作判出来了"
    assert "首" in cs[0].summary and "末" in cs[0].summary, "至少说得出差在哪几个字"


def test_identical_calibers_stay_quiet():
    """反向断言：字面一模一样时不许报 —— 否则这个改动只是把静默换成了噪声。"""
    assert detect_semantic_divergence(_two("含税总价", "含税总价")) == []


def test_a_known_axis_still_reports_the_axis_not_the_fragments():
    """认得出维度时，输出不该退化成"差在这几个字"。"""
    cs = detect_semantic_divergence(
        _two("本次采购的计划金额，指含税总价", "计划金额按不含税口径统计"))
    assert len(cs) == 1
    assert "税（含税 vs 不含税）" in cs[0].summary
    assert "判不出" not in cs[0].summary


def test_reporting_a_clash_is_not_deciding_it():
    """报冲突 ≠ 裁决。选项里不许出现"推荐"这种字段。"""
    cs = detect_semantic_divergence(
        _two("计划金额取首道工序产能上限", "计划金额取末道工序产能下限"))
    opts = cs[0].options
    assert opts, "要给人选项"
    assert all("recommended" not in o.to_dict() for o in opts)
