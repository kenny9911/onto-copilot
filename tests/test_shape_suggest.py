"""形状推断、规则抽取、主动建议。

这一批全部来自同一次真实失败：一份 326 行的采购梳理表，三张 sheet 三种形状，
流水线用同一套假设去套，结果是 58 个对象 / 0 属性 / 0 关系，critic 还判它"漏抽
属性"、反复重试到烧穿预算。所以下面的用例都以那份材料的真实结构为原型。
"""

from __future__ import annotations

import pytest

from ontocopilot.kernel.critic import CriticContext, Severity
from ontocopilot.onto.oir import BusinessRule, OIR, ObjectType, RuleKind, extracted, inferred
from ontocopilot.onto.parse.tabular import detect_header_row
from ontocopilot.onto.pipeline import CoverageCritic, Segment, build_oir
from ontocopilot.onto.shape import (
    ColumnRole,
    Yield,
    classify_columns,
    infer_shape,
    split_options,
    structural_extract,
)
from ontocopilot.onto.suggest import SuggestionEngine, SuggestionKind

# ── 三种真实形状的原型 ────────────────────────────────────────────
# 实体登记表：一行一个实体，**没有字段列**。编码逐行不同 —— 真实登记表就是这样，
# 编码重复的表不是登记表。
REGISTRY = [
    {"应用模块": "采购计划管理", "业务对象": "采购需求计划",
     "实体编码": "pbpHeader", "实体名称": "采购业务计划头"},
    {"应用模块": "采购计划管理", "业务对象": "", "实体编码": "pbpLine",
     "实体名称": "采购业务计划行"},
    {"应用模块": "供应商关系管理", "业务对象": "", "实体编码": "clmContract",
     "实体名称": "采购合同"},
] + [{"应用模块": "供应商关系管理", "业务对象": "", "实体编码": f"clmDoc{i}",
      "实体名称": f"合同附件{i}"} for i in range(12)]

# 行动表：多一列 url，编码列装的是**行动码**。`业务对象` 只在首行写一次。
ACTIONS = [
    {"应用模块": "采购计划管理", "业务对象": "采购需求计划",
     "实体编码": "createPbp", "实体名称": "创建PBP",
     "url": "/msourcing/openapi/v1/createPbp"},
] + [{"应用模块": "采购计划管理", "业务对象": "", "实体编码": f"queryPbp{i}",
      "实体名称": f"查询PBP{i}", "url": f"/msourcing/openapi/v1/queryPbp{i}"}
     for i in range(11)]

# 字段表：有数据类型列 —— 这一列的存在压过一切，一行就是一个属性。
_TYPES = ["varchar(64)", "decimal(18,2)", "date", "int", "varchar(32)", "timestamp"]
FIELDS = [{"所属对象": "pbpHeader", "字段名": f"field{i}", "类型": _TYPES[i % 6],
           "口径": f"第 {i} 个字段的口径说明", "必填": "是" if i % 2 else "否"}
          for i in range(12)]


def _cites(rows: list[dict]) -> list[str]:
    return [f"x.xlsx!Sheet1!R{i + 2}-{i + 2}" for i in range(len(rows))]


# ══════════════════════════════════════════════════════════════════
#  表头
# ══════════════════════════════════════════════════════════════════
def test_prose_first_row_is_not_a_header():
    """第一行是整段职责说明时，必须判"无表头"而不是硬选它。

    选了它的后果不是"列名难看" —— 那段几百字的散文会被拼进本 sheet **每一行**
    的 render，切片全被它撑爆，真正的内容挤不进模型。
    """
    duty = ("采购计划员职责：\n1、负责依据采购需求计划编制采购执行计划；\n"
            "2、负责集采计划收集及复核编制；\n3、负责采购包创建、分配及调整；")
    rule = ("业务规则：\n1、根据已审批采购申请进行采购包创建；\n"
            "2、根据历史采购包信息（采购物资/服务合并创建采购包比例），创建采购包；")
    grid = [[duty, duty + "#2", duty + "#3"],
            [rule, rule + "A", rule + "B"],
            [rule + "C", rule + "D", rule + "E"]]
    assert detect_header_row(grid) == -1


def test_real_header_still_wins():
    grid = [["应用模块", "实体编码", "实体名称"],
            ["采购计划管理", "pbpHeader", "采购业务计划头"],
            ["采购计划管理", "pbpLine", "采购业务计划行"]]
    assert detect_header_row(grid) == 0


# ══════════════════════════════════════════════════════════════════
#  列角色
# ══════════════════════════════════════════════════════════════════
def test_datatype_column_detected_by_values_not_name():
    """列名叫 col3 也认得出类型列 —— 判据是取值，不是列名。"""
    cols = {c.name: c.role for c in classify_columns(
        [{"col3": "varchar(64)"}, {"col3": "decimal(18,2)"}, {"col3": "date"}])}
    assert cols["col3"] is ColumnRole.DATATYPE


def test_sparse_column_becomes_group_when_others_are_dense():
    """只在每组第一行写一次的分组列。

    单看这一列：取值互不重复、都是短中文，活脱脱一个名称列。只有对照"别的列
    是满的"才知道那些空格是**继承**不是缺失。
    """
    roles = {c.name: c.role for c in classify_columns(ACTIONS)}
    assert roles["业务对象"] is ColumnRole.GROUP
    assert roles["实体编码"] is ColumnRole.IDENTIFIER
    assert roles["url"] is ColumnRole.ENDPOINT


# ══════════════════════════════════════════════════════════════════
#  形状
# ══════════════════════════════════════════════════════════════════
def test_registry_shape_has_no_properties():
    """登记表的正确答案就是零属性。

    这条是整个模块存在的理由：把"零属性"当成失败，就会在一张本来就没有字段的
    表上无限重试。
    """
    shape = infer_shape(REGISTRY)
    assert shape.row_unit == "object"
    assert Yield.OBJECTS in shape.yields
    assert Yield.PROPERTIES not in shape.yields
    assert Yield.OBJECTS in shape.rule_decidable


def test_field_sheet_shape_expects_properties():
    shape = infer_shape(FIELDS)
    assert shape.row_unit == "property"
    assert Yield.PROPERTIES in shape.yields
    # 字段的语义（口径）不是规则能定的，必须过模型
    assert Yield.PROPERTIES not in shape.rule_decidable


def test_action_shape_does_not_rule_extract_objects():
    """行动表里的编码是行动码，不是实体码 —— 规则不许拿它造对象。"""
    shape = infer_shape(ACTIONS)
    assert shape.row_unit == "action"
    assert Yield.ACTIONS in shape.rule_decidable
    assert Yield.OBJECTS not in shape.rule_decidable
    assert Yield.OBJECTS in shape.yields  # 该有对象，只是得模型来命名


def test_prose_shape_yields_rules_only():
    rows = [{"col1": f"采购计划员职责第 {i} 条：负责依据采购需求计划编制采购执行计划，"
                     f"并负责集采计划收集及复核编制、采购包创建分配及调整"} for i in range(8)]
    shape = infer_shape(rows)
    assert shape.row_unit == "rule"
    assert Yield.RULES in shape.yields
    assert Yield.PROPERTIES not in shape.yields


# ══════════════════════════════════════════════════════════════════
#  规则抽取
# ══════════════════════════════════════════════════════════════════
def test_registry_rows_extracted_without_llm():
    """一行一实体，一行都不能丢。"""
    shape = infer_shape(REGISTRY)
    out = structural_extract(REGISTRY, _cites(REGISTRY), shape)
    names = {o["api_name"] for o in out["objects"]}
    assert len(out["objects"]) == len(REGISTRY)  # 一行都不能丢
    assert {"pbpHeader", "pbpLine", "clmContract"} <= names
    assert all(o["source_locator"].startswith("x.xlsx!") for o in out["objects"])
    assert out["properties"] == []


def test_action_rows_carry_forward_filled_host():
    """分组列向下继承 —— 第二行的空白 `业务对象` 属于上一组。"""
    shape = infer_shape(ACTIONS)
    out = structural_extract(ACTIONS, _cites(ACTIONS), shape)
    assert not out["objects"]  # 行动表不许规则造对象
    assert len(out["actions"]) == len(ACTIONS)
    assert "createPbp" in {a["api_name"] for a in out["actions"]}
    assert all(a["object_display"] == "采购需求计划" for a in out["actions"])


def test_field_sheet_is_left_to_the_model():
    shape = infer_shape(FIELDS)
    out = structural_extract(FIELDS, _cites(FIELDS), shape)
    # 断言的是"规则一条都不抽"，不是"字典恰好有四个键" —— 后者会在每次新增
    # 产出类型时假报回归
    assert all(not v for v in out.values()), out




# ══════════════════════════════════════════════════════════════════
#  问卷
# ══════════════════════════════════════════════════════════════════
# 客户材料里真实存在的形状：150 行待澄清问题，"答复"整列空着等人填。
# 之前它被判成"一行一实体"，每个问题被抽成一个 ObjectType
# （apiName=nodeQuestion46，displayName="一条需求能不能只安排部分数量…"）——
# 纯粹的垃圾，而且污染了整个 OIR。
SURVEY = [{"节点": "（1）编制集采计划" if i == 0 else "",
           "编号": str(i + 1),
           "澄清问题": [
               "什么情况下使用集采，什么情况下使用普通采购？",
               "集采计划具体包括哪些内容？列出全部字段",
               "集采计划到底是在系统里编的，还是线下用 Excel 编好只把结果录进来？",
               "这项工作什么时候启动？固定周期做，还是看到框架快到期了才做？",
               "编制时主要依据什么具体数据？从哪里获取？",
               "收集是指各单位先上报、再由集采部门汇总吗？",
               "审批需要几级？分别是谁？",
               "驳回之后走什么流程？",
           ][i % 8],
           "参考选项": ["① 全线下，系统只存结果 ② 系统里编 ③ 线下编、系统里审",
                    "① 固定周期 ② 框架到期前 ③ 人工发起", ""][i % 3],
           "答复": ""} for i in range(16)]


def test_questionnaire_is_not_an_entity_registry():
    """核心回归：待填问卷不许被判成实体表。"""
    shape = infer_shape(SURVEY)
    assert shape.row_unit == "question"
    assert Yield.QUESTIONS in shape.yields
    # yields 里**只能**有 QUESTIONS。带上 OBJECTS 的话 CoverageCritic 会判
    # "该有对象却一个没有" = HIGH，节点反复重试直到烧穿预算 —— 就是这个模块
    # 存在的那次事故。
    assert shape.yields == {Yield.QUESTIONS}


def test_questionnaire_columns_get_their_roles():
    shape = infer_shape(SURVEY)
    roles = {c.name: c.role for c in shape.columns}
    assert roles["澄清问题"] is ColumnRole.QUESTION
    assert roles["答复"] is ColumnRole.ANSWER_SLOT
    assert roles["参考选项"] is ColumnRole.OPTIONS


def test_every_question_is_extracted_by_rule():
    shape = infer_shape(SURVEY)
    out = structural_extract(SURVEY, _cites(SURVEY), shape)
    assert len(out["questions"]) == len(SURVEY)  # 一行都不能丢
    assert not out["objects"] and not out["properties"]
    assert all(q["source_locator"].startswith("x.xlsx!") for q in out["questions"])


def test_reference_options_are_split():
    out = structural_extract(SURVEY, _cites(SURVEY), infer_shape(SURVEY))
    opts = next(q["options"] for q in out["questions"] if q["options"])
    assert len(opts) >= 2
    assert all("①" not in o and "②" not in o for o in opts)


def test_group_column_carries_down():
    """「节点」列只在每组首行写一次，下面的问题都属于同一节点。"""
    out = structural_extract(SURVEY, _cites(SURVEY), infer_shape(SURVEY))
    assert all(q["group"] == "（1）编制集采计划" for q in out["questions"])


def test_options_are_not_shredded_when_there_are_no_markers():
    """拆不出两段以上就不拆 —— 切碎的选项比不给选项更糟。"""
    assert split_options("按实际情况填写") == []
    assert split_options("") == []


def test_a_registry_with_one_blank_column_is_still_a_registry():
    """真实登记表里也常有一整列空着的备注 —— 不能因此判成问卷。

    区别在于它没有问句列。四个信号必须同时成立，这是其中一道闸。
    """
    rows = [{**r, "备注": ""} for r in REGISTRY]
    shape = infer_shape(rows)
    assert shape.row_unit == "object"


def test_a_field_sheet_with_a_blank_column_is_still_a_field_sheet():
    """字段表的口径列可能写成问句式说明，但它有数据类型列 —— 类型压过一切。"""
    rows = [{**r, "口径": f"是否必填？{r['口径']}", "备注": ""} for r in FIELDS]
    shape = infer_shape(rows)
    assert shape.row_unit == "property"
    assert Yield.PROPERTIES in shape.yields


def test_sparse_group_column_is_not_mistaken_for_the_answer_slot():
    """分组列只填 6% —— 但它不是答复槽，答复槽必须是**几乎整列空**。"""
    shape = infer_shape(ACTIONS)
    assert shape.row_unit == "action"


# ══════════════════════════════════════════════════════════════════
#  覆盖率 critic
# ══════════════════════════════════════════════════════════════════
class _Idx:
    """够 CoverageCritic 用的最小索引替身。"""

    def get(self, _cid):  # noqa: D102
        return None


def _judge(shape_rows, draft, *, key="s0"):
    seg = Segment(key=key, label="测试段", file_name="x.xlsx",
                  chunk_ids=[f"c{i}" for i in range(len(shape_rows))],
                  shape=infer_shape(shape_rows))
    critic = CoverageCritic([seg], _Idx())
    import asyncio
    # CoverageCritic 是纯规则视角（needs_llm=False），网关字段用不上
    ctx = CriticContext(node_id=f"EXTRACT.{key}", gateway=None, generator=None)
    return asyncio.run(critic.judge(draft, ctx))


def test_zero_properties_passes_on_a_registry():
    """核心回归：登记表抽出对象、零属性，必须**通过**。"""
    draft = {"objects": [{"api_name": f"o{i}"} for i in range(len(REGISTRY))],
             "properties": [], "links": []}
    assert _judge(REGISTRY, draft).passed


def test_dropped_rows_are_caught():
    """168 行只抽出 58 个 —— 这才是这类材料真正的失败模式。"""
    draft = {"objects": [{"api_name": f"o{i}"} for i in range(4)],
             "properties": [], "links": []}
    v = _judge(REGISTRY, draft)
    assert not v.passed
    assert any(f.code == "ROWS_DROPPED" and f.severity is Severity.HIGH
               for f in v.findings)


def test_missing_properties_still_caught_on_a_field_sheet():
    draft = {"objects": [{"api_name": "pbpHeader"}], "properties": [], "links": []}
    v = _judge(FIELDS, draft)
    assert not v.passed
    assert any(f.code == "PROPERTIES_MISSING" for f in v.findings)


def test_prose_segment_judged_on_rules():
    rows = [{"col1": f"规则 {i}：采购包创建后不得修改采购方式，需作废重建；"
                     f"年度计划须经二级审批后方可下发执行"} for i in range(8)]
    assert not _judge(rows, {"rules": []}).passed
    assert _judge(rows, {"rules": [{"statement": "采购包创建后不得修改采购方式"}]}).passed


# ══════════════════════════════════════════════════════════════════
#  业务规则进 OIR
# ══════════════════════════════════════════════════════════════════
def test_rules_survive_into_oir():
    """规则以前没有容器，抽出来就被丢。"""
    oir = build_oir({
        "objects": [{"api_name": "pbpHeader", "display_name": "采购业务计划头"}],
        "rules": [
            {"statement": "采购包创建后不得修改采购方式", "kind": "VALIDATION",
             "actor": "采购计划员", "applies_to": ["pbpHeader"]},
            {"statement": "年度采购计划须经二级审批", "kind": "PROCESS",
             "applies_to": []},
        ]})
    assert oir.stats()["rules"] == 2
    bound = [r for r in oir.rules.values() if r.applies_to]
    assert len(bound) == 1
    assert bound[0].kind.value is RuleKind.VALIDATION


def test_too_short_statements_are_dropped():
    oir = build_oir({"objects": [], "rules": [{"statement": "见上"}]})
    assert oir.stats()["rules"] == 0


# ══════════════════════════════════════════════════════════════════
#  建议
# ══════════════════════════════════════════════════════════════════
def _oir_with(names: list[str]) -> OIR:
    oir = OIR()
    for n in names:
        oir.add_object(ObjectType(rid=f"ot_{n}", api_name=inferred(n),
                                  display_name=inferred(n), primary_key=inferred([])))
    return oir


def test_head_line_pairs_suggested():
    oir = _oir_with(["pbpHeader", "pbpLine", "clmContractHeader", "clmContractLine",
                     "supplier"])
    sug = SuggestionEngine().propose(oir)
    link = next(s for s in sug if s.kind is SuggestionKind.ADD_LINK)
    assert "2 组" in link.title
    assert len(link.payload["links"]) == 2


def test_no_suggestion_when_link_already_exists():
    from ontocopilot.onto.oir import Cardinality, LinkType

    oir = _oir_with(["pbpHeader", "pbpLine"])
    oir.add_link(LinkType(rid="lt_1", api_name=inferred("pbpLines"),
                          source="ot_pbpHeader", target="ot_pbpLine",
                          cardinality=inferred(Cardinality.ONE_TO_MANY),
                          join_key=inferred(None)))
    assert not [s for s in SuggestionEngine().propose(oir)
                if s.kind is SuggestionKind.ADD_LINK]


def test_technical_tables_flagged_but_not_deleted():
    oir = _oir_with(["pbpHeader", "clmSpaImportTmp", "changeHistory", "syncJobLog"])
    s = next(x for x in SuggestionEngine().propose(oir)
             if x.kind is SuggestionKind.EXCLUDE)
    assert len(s.payload["objects"]) == 3
    assert "先别删" in s.rationale


def test_unbound_rules_become_a_suggestion():
    oir = _oir_with(["pbpHeader"])
    oir.add_rule(BusinessRule(rid="br_1",
                              statement=inferred("年度采购计划须经二级审批")))
    s = next(x for x in SuggestionEngine().propose(oir)
             if x.kind is SuggestionKind.BIND_RULE)
    assert s.confidence > 0.9


def test_suggestions_are_ranked_by_impact_times_confidence():
    oir = _oir_with(["pbpHeader", "pbpLine", "aTmp", "bLog", "cHis"])
    scores = [s.score for s in SuggestionEngine().propose(oir)]
    assert scores == sorted(scores, reverse=True)


# ══════════════════════════════════════════════════════════════════
#  建议的执行
# ══════════════════════════════════════════════════════════════════
# 在此之前 suggest() 只产出数据，没有任何代码消费 payload —— 界面上点"采纳"
# 一句话，产物纹丝不动。一个采纳不了的建议不如不给。
from ontocopilot.onto.oir import Status  # noqa: E402
from ontocopilot.onto.suggest import apply_suggestion  # noqa: E402


def _adopt(oir, kind: str):
    sug = next(s for s in SuggestionEngine().propose(oir) if str(s.kind) == kind)
    return apply_suggestion(oir, sug.to_dict())


def test_adopting_add_link_really_creates_links():
    oir = _oir_with(["pbpHeader", "pbpLine", "clmContractHeader", "clmContractLine"])
    assert not oir.links
    res = _adopt(oir, "ADD_LINK")
    assert len(res["changed"]) == 2
    assert len(oir.links) == 2
    assert not oir.orphans()  # 四个对象两两连上了，孤儿清零


def test_adopted_links_are_marked_as_the_users_decision():
    """人拍的板，后续任何自动逻辑不得覆盖。"""
    oir = _oir_with(["pbpHeader", "pbpLine"])
    _adopt(oir, "ADD_LINK")
    lt = next(iter(oir.links.values()))
    assert lt.api_name.origin is not None
    assert str(lt.api_name.origin) == "user"


def test_adopting_exclude_marks_but_does_not_delete():
    """建议自己承诺过「先别删，标记排除即可」—— 万一有个是业务表。"""
    oir = _oir_with(["pbpHeader", "aTmp", "bLog", "cHis"])
    res = _adopt(oir, "EXCLUDE")
    assert len(res["changed"]) == 3
    assert len(oir.objects) == 4  # 一个都没删
    assert {o.api_name.value for o in oir.objects.values()
            if o.status is Status.REJECTED} == {"aTmp", "bLog", "cHis"}


def test_adopted_suggestions_stop_being_suggested():
    """采纳完还挂在列表里，用户会以为没生效然后再点一次。"""
    oir = _oir_with(["pbpHeader", "pbpLine", "aTmp", "bLog", "cHis"])
    for s in SuggestionEngine().propose(oir):
        apply_suggestion(oir, s.to_dict())
    assert SuggestionEngine().propose(oir) == []


def test_adopting_twice_is_a_no_op():
    oir = _oir_with(["pbpHeader", "pbpLine"])
    sug = next(s for s in SuggestionEngine().propose(oir)
               if str(s.kind) == "ADD_LINK").to_dict()
    assert len(apply_suggestion(oir, sug)["changed"]) == 1
    assert apply_suggestion(oir, sug)["changed"] == []
    assert len(oir.links) == 1


def test_ask_material_has_nothing_to_execute():
    """它要的是人去补材料，不是系统改数据 —— 必须如实说改不了。"""
    oir = _oir_with(["pbpHeader", "pbpLine", "clmContract"])
    res = _adopt(oir, "ASK_MATERIAL")
    assert res["changed"] == []


def test_bind_rule_escalates_but_never_guesses_the_host():
    """挂错约束比不挂更糟 —— 只能标成待人处理。"""
    oir = _oir_with(["pbpHeader"])
    oir.add_rule(BusinessRule(rid="br_1", statement=inferred("年度计划须经二级审批")))
    res = _adopt(oir, "BIND_RULE")
    assert res["changed"] == ["br_1"]
    assert oir.rules["br_1"].status is Status.PROPOSED
    assert oir.rules["br_1"].applies_to == []  # 没有替人猜


# ══════════════════════════════════════════════════════════════════
#  模板的可填性
# ══════════════════════════════════════════════════════════════════
# 实测过的三个数字：原样交回 completeness=0.0000；每格认真填满也只有 0.8861，
# 永远够不到 0.95；627 格被判填写、只有 172 条写回 OIR。下面钉住这几条的修复。
from ontocopilot.onto.template import Role, compile_template  # noqa: E402


def _tpl(oir):
    return compile_template(oir)


def _required(spec) -> list:
    return [c for sh in spec.sheets for row in sh.rows for c in row.values()
            if c.role is Role.REQUIRED]


def test_no_empty_sheets():
    """一张只有表头的「属性明细」配一句「口径定义是本轮重点」—— 最强的指令
    指向一张空表。"""
    oir = _oir_with(["pbpHeader", "pbpLine"])
    spec = _tpl(oir)
    assert all(sh.rows for sh in spec.sheets), \
        [sh.name for sh in spec.sheets if not sh.rows]


def test_business_rules_reach_the_template():
    """13 条业务规则以前在模板里 0 格 —— OIR 最贵的内容在编译时蒸发。"""
    oir = _oir_with(["pbpHeader"])
    oir.add_rule(BusinessRule(rid="br_1",
                              statement=inferred("采购包创建后不得修改采购方式")))
    spec = _tpl(oir)
    names = [sh.name for sh in spec.sheets]
    assert "03_业务规则确认" in names, names
    rows = next(sh for sh in spec.sheets if sh.name == "03_业务规则确认").rows
    assert "采购包创建后不得修改采购方式" in rows[0]["规则原文"].value


def test_open_questions_reach_the_template():
    """150 个待澄清问题同理。它们是客户自己写的、分好组、带选项，只差一个答复。"""
    from ontocopilot.onto.oir import OpenQuestion

    oir = _oir_with(["pbpHeader"])
    oir.add_question(OpenQuestion(
        rid="oq_1", text=inferred("集采计划是在系统里编的还是线下编的？"),
        options=["全线下", "系统里编", "线下编、系统里审"],
        group="（1）编制集采计划", code="3"))
    spec = _tpl(oir)
    sh = next(sh for sh in spec.sheets if sh.name == "02_待澄清问题")
    assert len(sh.rows) == 1
    r = sh.rows[0]
    assert r["答复"].role is Role.REQUIRED
    assert r["澄清问题"].role is Role.LOCKED  # 问题本身不给人改
    assert "1）全线下" in r["参考选项"].value


def test_answered_questions_are_not_asked_again():
    from ontocopilot.onto.oir import OpenQuestion, Status as _S

    oir = _oir_with(["pbpHeader"])
    oir.add_question(OpenQuestion(rid="oq_1", text=inferred("已经答过的问题？"),
                                  answer=inferred("是的"), status=_S.CONFIRMED))
    assert not [sh for sh in _tpl(oir).sheets if sh.name == "02_待澄清问题"]


def test_business_people_are_not_asked_for_primary_keys():
    """「主键」是数据建模词汇。172 行全空、只有 FDE 答得了、填了也不会写回 OIR ——
    却独占完成度权重的 58%，把达标线压在够不到的地方。"""
    oir = _oir_with([f"obj{i}" for i in range(12)])
    fields = {c.field for c in _required(_tpl(oir))}
    assert "primaryKey" not in fields, fields
    assert "owner" not in fields, fields


def test_agreeing_with_a_correct_prefill_is_not_a_required_cell():
    """111 行全预填「已确认」再要人确认一遍，他核对后不动就被判敷衍。
    「我同意」是业务方最常做的动作，不该被罚。"""
    from ontocopilot.onto.oir import ActionType, Status as _S

    oir = _oir_with(["pbpHeader"])
    oir.add_action(ActionType(rid="at_1", api_name=inferred("createPbp"),
                              applies_to=["ot_pbpHeader"], status=_S.CANDIDATE))
    oir.add_action(ActionType(rid="at_2", api_name=inferred("draftAction"),
                              applies_to=["ot_pbpHeader"], status=_S.DRAFT_FROM_API))
    sh = next(s for s in _tpl(oir).sheets if s.name == "04_动作清单")
    roles = {r["apiName"].value: r["confirmed"].role for r in sh.rows}
    assert roles["createPbp"] is Role.PREFILLED      # 不是草稿，不用再确认
    assert roles["draftAction"] is Role.REQUIRED     # 是草稿，要确认


def test_read_only_actions_do_not_ask_for_effects():
    """查询接口不改数据，「影响范围」的答案是确定的 —— 111 遍里一半在问已知答案。"""
    from ontocopilot.onto.oir import ActionType

    oir = _oir_with(["pbpHeader"])
    for rid, name, path in [("at_q", "queryPbpLine", "/v1/queryPbpLine"),
                            ("at_c", "createPbp", "/v1/createPbp")]:
        oir.add_action(ActionType(rid=rid, api_name=inferred(name),
                                  applies_to=["ot_pbpHeader"],
                                  source_endpoint=inferred({"path": path})))
    sh = next(s for s in _tpl(oir).sheets if s.name == "04_动作清单")
    by = {r["apiName"].value: r["effects"] for r in sh.rows}
    assert by["queryPbpLine"].role is Role.LOCKED
    assert "只读" in by["queryPbpLine"].value
    assert by["createPbp"].role is Role.REQUIRED


def test_required_cells_stay_within_a_weeks_work():
    """172 个对象 + 111 个行动的项目，必填格数要在一个人一周填得完的量级。

    实测基线：改之前 763 格（其中 618 格全空），改之后 255 格。
    """
    oir = _oir_with([f"obj{i}" for i in range(172)])
    from ontocopilot.onto.oir import ActionType
    for i in range(111):
        oir.add_action(ActionType(rid=f"at_{i}", api_name=inferred(f"queryThing{i}"),
                                  applies_to=["ot_obj0"],
                                  source_endpoint=inferred({"path": f"/v1/queryThing{i}"})))
    n = len(_required(_tpl(oir)))
    assert n < 300, f"{n} 个必填格 —— 一周填不完"


# ══════════════════════════════════════════════════════════════════
#  任务描述与 critic 判据必须是同一份契约
# ══════════════════════════════════════════════════════════════════
def _seg(rows, key="s0", label="业务对象API梳理-行动"):
    return Segment(key=key, label=label, file_name="x.xlsx",
                   chunk_ids=[f"c{i}" for i in range(len(rows))],
                   shape=infer_shape(rows))


class _RowIdx(_Idx):
    """按 chunk 顺序还原 rows 的假索引 —— 只够 ExtractSegment 用。"""

    def __init__(self, rows, cites):
        self._rows = {f"c{i}": (r, cites[i]) for i, r in enumerate(rows)}

    def get(self, cid):
        pair = self._rows.get(cid)
        if pair is None:
            return None

        class _C:
            raw = pair[0]
            render = str(pair[0])

            def cite(self_inner):
                return pair[1]

        return _C()


def _task_text(rows):
    from ontocopilot.kernel.agents import default_agents
    from ontocopilot.onto.pipeline import ExtractSegment

    agent = default_agents().get("extractor")
    h = ExtractSegment(_seg(rows), _RowIdx(rows, _cites(rows)), agent, "")
    return h.task({})


def _extract_handler(rows):
    from ontocopilot.kernel.agents import default_agents
    from ontocopilot.onto.pipeline import ExtractSegment

    return ExtractSegment(_seg(rows), _RowIdx(rows, _cites(rows)),
                          default_agents().get("extractor"), "")


def test_the_task_asks_for_everything_the_critic_will_check():
    """契约必须闭合：critic 判缺失的每一类，任务描述里都得点名要。

    真实事故：行动表段的 critic 判「对象缺失」，而任务描述从头到尾没提过要抽
    对象 —— 模型照着任务做完被打回，重出一版反而把规则抽好的行动冲掉了。
    """
    from ontocopilot.onto.pipeline import _ASK

    for rows in (ACTIONS, FIELDS, REGISTRY):
        h = _extract_handler(rows)
        text = h.task({})
        assert h.wants() == [y for y in h.wants()]           # 稳定
        for y in h.wants():
            assert _ASK[y] in text, f"{h.segment.shape.row_unit} 段欠 {y.value}，任务里却没点名要"


def test_the_critic_judges_exactly_what_the_task_asked_for():
    """反向闭合：模型把任务点名要的都交了，critic 就不该再判缺失。"""
    h = _extract_handler(ACTIONS)
    draft = h.finalize({"objects": [{"api_name": "pbpHeader"}]}, {})
    v = _judge(ACTIONS, draft)
    assert v.passed, [f.claim for f in v.findings]


def test_action_segment_shows_the_model_the_host_names_it_must_name():
    """宿主对象名就写在分组列里，直接给模型看，别让它去猜、去检索。

    真实材料上模型为了找这个名字连着四轮 evidence.search，最后一个对象也没抽出来。
    """
    from ontocopilot.onto.shape import Yield

    h = _extract_handler(ACTIONS)
    assert Yield.OBJECTS in h.wants()
    assert "这一段的宿主业务对象" in h.task({})
    assert "采购需求计划" in h.task({}).split("这一段的宿主业务对象")[1][:200]


def test_long_camel_case_api_names_are_not_prose():
    """`bdPurchaseDocSubtypeMapping` 是个规规矩矩的 apiName，不是说明文字。

    真实事故：长度 > 24 一律判散文，把合法的长驼峰实体名报成噪声。
    """
    from ontocopilot.onto.pipeline import _looks_like_prose

    assert not _looks_like_prose("bdPurchaseDocSubtypeMapping")
    assert not _looks_like_prose("poChangeApplicationHeader")
    assert _looks_like_prose("与采购需求计划一致")
    assert _looks_like_prose("这一列的取值和上面那张表里写的口径保持一致即可")


def test_actions_attach_to_the_host_object_named_in_the_group_column():
    """行动表写的是中文业务对象名，实体表按同一个名字分组 —— 两边接得上。

    接不上的后果是 112 行接口全成孤儿：模板里看不到、流程图上挂不上。
    """
    reg_shape = infer_shape(REGISTRY)
    reg = structural_extract(REGISTRY, _cites(REGISTRY), reg_shape)
    act_shape = infer_shape(ACTIONS)
    act = structural_extract(ACTIONS, _cites(ACTIONS), act_shape)

    oir = build_oir({"objects": reg["objects"], "actions": act["actions"]})
    assert oir.stats()["actions"] == len(ACTIONS)
    attached = [a for a in oir.actions.values() if a.applies_to]
    assert len(attached) == len(ACTIONS), "行动全挂到「采购需求计划」这个宿主上"
    host = oir.objects[attached[0].applies_to[0]]
    assert host.api_name.value == "pbpHeader"


# ══════════════════════════════════════════════════════════════════
#  切段不能破坏表的形状与合并单元格继承
# ══════════════════════════════════════════════════════════════════
def _doc(sheet: str, rows: list[dict], *, file_name="x.xlsx", extra=()):
    """伪造一份解析结果：一行一个 range/row 切片，外加若干非数据切片。"""
    from ontocopilot.kernel.memory.evidence import Chunk

    class _Doc:
        pass

    d = _Doc()
    d.file_name = file_name
    d.chunks = [
        Chunk(chunk_id=f"{sheet}_{i}", file_id="f1", file_name=file_name,
              locator={"kind": "range", "sheet": sheet, "rows": [i + 2, i + 2]},
              render=str(r), raw=r, order=i, tags=["row"])
        for i, r in enumerate(rows)
    ] + list(extra)
    return d


def test_a_sheet_split_in_two_keeps_the_group_it_inherited():
    """合并单元格只在组首写一次。把表拦腰切开，后半段就再也读不到组名了。

    真实事故：112 行接口表被按 45 行切成三段，第二段开头正卡在「采购订单」组
    中间 —— 那一组 22 个行动全部丢了宿主，最后成了挂不上任何对象的孤儿。
    """
    from ontocopilot.kernel.memory.evidence import EvidenceIndex
    from ontocopilot.onto.pipeline import SEGMENT_CHUNKS, segment_corpus

    rows = [{"应用模块": "采购计划管理", "业务对象": "采购需求计划",
             "实体编码": "createPbp", "实体名称": "创建PBP",
             "url": "/v1/createPbp"}]
    rows += [{"应用模块": "", "业务对象": "", "实体编码": f"queryPbp{i}",
              "实体名称": f"查询{i}", "url": f"/v1/queryPbp{i}"}
             for i in range(SEGMENT_CHUNKS + 10)]

    doc = _doc("行动", rows)
    index = EvidenceIndex()
    for c in doc.chunks:
        index.add(c)
    segs = segment_corpus(index, [doc])
    assert len(segs) > 1, "这份材料本来就该被切成多段"

    hosts = []
    for s in segs:
        r, cites = s.rows(index)
        out = structural_extract(r, cites, s.shape, carry_in=s.carry_in)
        hosts += [a["object_display"] for a in out["actions"]]
    assert len(hosts) == len(rows)
    assert set(hosts) == {"采购需求计划"}, "切开之后半张表的宿主丢了"


def test_shape_is_inferred_from_the_whole_sheet_not_one_window():
    """后半段里「业务对象」整列是空的，单看这一段判不出它是分组列。"""
    from ontocopilot.kernel.memory.evidence import EvidenceIndex
    from ontocopilot.onto.pipeline import SEGMENT_CHUNKS, segment_corpus

    rows = [{"应用模块": "采购", "业务对象": "采购订单", "实体编码": "poHeader",
             "实体名称": "采购订单头"}]
    rows += [{"应用模块": "", "业务对象": "", "实体编码": f"poLine{i}",
              "实体名称": f"行{i}"} for i in range(SEGMENT_CHUNKS + 5)]
    doc = _doc("实体", rows)
    index = EvidenceIndex()
    for c in doc.chunks:
        index.add(c)
    segs = segment_corpus(index, [doc])
    assert {s.shape.row_unit for s in segs} == {"object"}, "同一张表的两段形状必须一致"


def test_column_profile_chunks_are_not_data_rows():
    """解析器为每张表额外产一片列画像。它不是一行数据。

    真实事故：那片画像被当成一行，抽出一个 apiName 是整坨 profile JSON 的"实体"，
    还一路混进了模板和 critic 的报告里。
    """
    from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex
    from ontocopilot.onto.pipeline import segment_corpus

    rows = [{"实体编码": f"po{i}", "实体名称": f"名{i}"} for i in range(8)]
    schema = Chunk(chunk_id="schema", file_id="f1", file_name="x.xlsx",
                   locator={"kind": "range", "sheet": "实体", "rows": [1, 1]},
                   render="列画像", order=99,
                   raw={"实体编码": {"name": "实体编码", "count": 8, "null_rate": 0.0}},
                   tags=["schema"])
    doc = _doc("实体", rows, extra=[schema])
    index = EvidenceIndex()
    for c in doc.chunks:
        index.add(c)
    seg = next(s for s in segment_corpus(index, [doc]) if s.shape.row_count)
    got, _ = seg.rows(index)
    assert len(got) == len(rows), "列画像切片混进数据行了"


def test_prose_never_becomes_an_action_name():
    """「与采购需求计划一致」是单元格里的说明文字，不是接口名。"""
    oir = build_oir({"objects": [],
                     "actions": [{"api_name": "与采购需求计划一致"},
                                 {"api_name": "createPbp"}]})
    assert [a.api_name.value for a in oir.actions.values()] == ["createPbp"]
