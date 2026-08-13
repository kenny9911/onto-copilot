"""缺口挖掘 —— 问题清单必须从材料里长出来，不能是写死的几句模板话。

这一批用例的原型是一份**没有问卷**的真实材料：三张登记表加一段规则散文。
它里面明摆着的空白（提前XX天、超出XX金额、一张叫「实体间关系-待梳理」的空表、
一份要确认完整性的状态清单）在旧实现里一条都问不出来 —— 那张「待澄清问题」表
只有三四行系统自问自答的模板句。
"""

from __future__ import annotations

from ontocopilot.kernel.memory.evidence import Chunk
from ontocopilot.onto.gaps import (
    empty_containers,
    enumerations,
    mine_questions,
    structural_gaps,
    undetermined_slots,
)
from ontocopilot.onto.oir import (
    OIR,
    ActionType,
    BusinessRule,
    ObjectType,
    Provenance,
    extracted,
    inferred,
)
from ontocopilot.onto.template import compile_template

RULES = (
    "业务规则：\n"
    "1、根据已审批采购申请进行采购包创建；\n"
    "2、需进行采购包总金额上线控制，如超出XX金额，则采购包创建失败；\n"
    "3、实际与计划基线对比，如提前XX天需要进行预警提醒；\n"
    "4、如第一时间未处理，则依据重复提醒要求，间隔XX天再次发送；\n"
    "5、进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消；\n"
    "6、重大预警：关键物料，会造成项目停工、关键里程碑跳票、大额损失。\n"
)


def _chunk(text: str, *, sheet="业务规则", row=47) -> Chunk:
    return Chunk(chunk_id=f"c{row}", file_id="f1", file_name="x.xlsx",
                 locator={"kind": "range", "sheet": sheet, "rows": [row, row]},
                 render=text, raw={"col1": text}, order=row, tags=["row"])


# ══════════════════════════════════════════════════════════════════
#  1. 材料自己写下的未定参数
# ══════════════════════════════════════════════════════════════════
def test_placeholders_written_by_the_customer_become_questions():
    """「提前XX天」是客户自己标的待办，原样问回去最准。"""
    gaps = undetermined_slots([_chunk(RULES)])
    texts = " ".join(g.text for g in gaps)
    assert "超出XX金额" in texts
    assert "提前XX天" in texts
    assert "间隔XX天" in texts
    assert all(g.kind.startswith("slot:") for g in gaps)


def test_a_placeholder_question_quotes_one_sentence_not_the_whole_block():
    """整段 800 字的规则塞进一个问题里，没人读得下去。"""
    gaps = undetermined_slots([_chunk(RULES)])
    assert gaps and all(len(g.text) < 200 for g in gaps)


def test_placeholder_questions_carry_a_real_locator():
    """出处要能点回原文。塞一个字符串进去只能渲染成一行字。"""
    g = undetermined_slots([_chunk(RULES)])[0]
    assert g.prov is not None
    assert g.prov.cite() == "x.xlsx!业务规则!R47-47"


def test_an_ordinary_abbreviation_is_not_a_placeholder():
    """「XX 部门」是正常缩写，不是待填的参数 —— 占位符要紧挨着单位。"""
    assert not undetermined_slots([_chunk("由XX部门负责归口管理，报XX公司备案。")])


# ══════════════════════════════════════════════════════════════════
#  2. 声明了却空着的容器
# ══════════════════════════════════════════════════════════════════
class _Doc:
    file_id = "f1"
    file_name = "x.xlsx"

    def __init__(self, findings):
        self.chunks: list = []
        self.findings = findings


class _Finding:
    def __init__(self, kind, message, locator):
        self.kind, self.message, self.locator = kind, message, locator


def test_an_empty_sheet_becomes_a_question():
    """一张叫「实体间关系-待梳理」、里面一行都没有的表，本身就是一个问题。"""
    doc = _Doc([_Finding("empty_sheet", "工作表「实体间关系-待梳理」是空的，已跳过",
                         {"sheet": "实体间关系-待梳理"})])
    gaps = empty_containers([doc])
    assert len(gaps) == 1
    assert "实体间关系-待梳理" in gaps[0].text
    assert gaps[0].prov.cite().endswith("!实体间关系-待梳理!R1-1")


def test_nothing_is_invented_when_every_sheet_has_content():
    assert empty_containers([_Doc([])]) == []


# ══════════════════════════════════════════════════════════════════
#  3. 取值清单
# ══════════════════════════════════════════════════════════════════
def test_a_value_list_becomes_a_completeness_question_with_options():
    gaps = enumerations([_chunk(RULES)])
    hit = next(g for g in gaps if "进度状态标准" in g.text)
    assert hit.options[:6] == ["未开始", "执行中", "部分完成", "已完成", "已暂停", "已取消"]
    assert hit.options[-1] == "就这些，没有遗漏"


def test_parallel_clauses_are_not_a_value_list():
    """「关键物料，会造成项目停工、关键里程碑跳票」是三个分句，不是三个取值。

    判据是分隔符：中文里逗号分句、顿号分词。混用就说明这不是取值域。
    """
    assert not any("重大预警" in g.text for g in enumerations([_chunk(RULES)]))


# ══════════════════════════════════════════════════════════════════
#  4. 结构缺口
# ══════════════════════════════════════════════════════════════════
def _oir_with_orphans() -> OIR:
    oir = OIR()
    prov = Provenance("f1", "x.xlsx", {"kind": "range", "sheet": "行动", "rows": [3, 3]})
    oir.add_object(ObjectType(rid="ot_a", api_name=inferred("poHeader"),
                              display_name=inferred("采购订单头"),
                              description=inferred(""), primary_key=inferred([])))
    oir.add_action(ActionType(rid="at_x", api_name=extracted("createFoo", prov),
                              applies_to=[],
                              source_endpoint=extracted({"path": "/v1/createFoo",
                                                         "display": "创建 Foo"}, prov)))
    oir.add_rule(BusinessRule(rid="br_x",
                              statement=extracted("采购包一经分配不得拆包", prov),
                              kind=inferred(None), applies_to=[]))
    return oir


def test_an_interface_with_no_host_object_becomes_a_question():
    gaps = structural_gaps(_oir_with_orphans())
    hit = next(g for g in gaps if g.kind == "action_no_host")
    assert "createFoo" in hit.text
    assert hit.prov is not None


def test_a_rule_bound_to_nothing_becomes_a_question():
    gaps = structural_gaps(_oir_with_orphans())
    assert any(g.kind == "rule_no_host" and "拆包" in g.text for g in gaps)


# ══════════════════════════════════════════════════════════════════
#  汇总与模板
# ══════════════════════════════════════════════════════════════════
def test_mining_keeps_the_customers_own_questions_first():
    """客户自己提的疑问永远排最前 —— 那比我们发现的任何缺口都更该先答。"""
    from ontocopilot.onto.oir import OpenQuestion

    mine = OpenQuestion(rid="oq_own", text=inferred("集采和普通采购怎么分？"),
                        asked_by="customer")
    out = mine_questions(_oir_with_orphans(), docs=[], chunks=[_chunk(RULES)],
                         extra=[mine])
    assert out[0].rid == "oq_own"
    assert len(out) > 1, "证据里挖出来的问题也要在"


def test_the_question_sheet_drops_columns_that_would_be_empty():
    """没有编号、没有参考选项的材料，就不该出这两列空格。"""
    oir = _oir_with_orphans()
    for q in mine_questions(oir, docs=[], chunks=[_chunk(RULES)]):
        oir.add_question(q)
    sheet = next(s for s in compile_template(oir).sheets if "待澄清" in s.name)
    assert "澄清问题" in sheet.columns and "答复" in sheet.columns
    assert "编号" not in sheet.columns, "整列空的「编号」不该出现"
    assert "材料出处" in sheet.columns, "问题得能翻回原文"
    assert sheet.rows


def test_the_question_sheet_keeps_the_columns_that_do_have_content():
    """客户问卷带编号和参考选项时，这两列必须还在。"""
    from ontocopilot.onto.oir import OpenQuestion

    oir = OIR()
    oir.add_question(OpenQuestion(
        rid="oq1", text=inferred("集采计划是在系统里编的还是线下编？"),
        options=["全线下", "系统里编", "线下编、系统里审"],
        group="（1）编制集采计划", code="3", asked_by="customer"))
    sheet = next(s for s in compile_template(oir).sheets if "待澄清" in s.name)
    assert {"编号", "参考选项", "所属部分"} <= set(sheet.columns)


# ══════════════════════════════════════════════════════════════════
#  6. 名额：客户自带的问题不能把我们自己挖的挤掉
# ══════════════════════════════════════════════════════════════════
def test_customer_questions_do_not_starve_the_mined_gaps():
    """回归：`limit` 只该约束**我们挖的**那部分。

    以前 extra 也占名额，而 extra 在生产里是客户问卷 + 流程图缺口 —— 随便一份
    材料就顶满 60。后果是"系统发现材料里缺什么"这件事一条都进不来，且悄无声息：
    空表、未定槽位、枚举缺失全被饿死。产品最该主动说话的地方彻底哑掉。
    """
    from ontocopilot.onto.oir import OpenQuestion, inferred

    extra = [OpenQuestion(rid=f"q_c{i}", text=inferred(f"客户问卷第 {i} 条"))
             for i in range(150)]
    doc = _Doc([_Finding("empty_sheet", f"空表{i}", {"sheet": f"待梳理{i}"})
                for i in range(5)])

    out = mine_questions(OIR(), docs=[doc], chunks=[], extra=extra, limit=60)
    mined = [q for q in out if q.asked_by == "system"]
    assert len(mined) == 5, f"系统自挖的缺口被挤掉了：只剩 {len(mined)} 条"
    assert len(out) == 155                      # 客户那 150 条一条不少


def test_the_limit_still_caps_what_we_mine_ourselves():
    """兜底反向断言：名额没了 —— 挖出一百条空表也只出 limit 条。"""
    doc = _Doc([_Finding("empty_sheet", f"空表{i}", {"sheet": f"待梳理{i}"})
                for i in range(100)])
    out = mine_questions(OIR(), docs=[doc], chunks=[], limit=8)
    assert len(out) == 8


# ══════════════════════════════════════════════════════════════════
#  7. 对齐拿不准的那些对，要有出口
# ══════════════════════════════════════════════════════════════════
def test_uncertain_alignment_pairs_become_questions():
    """「这俩是不是一个东西」是 FDE 每天问上百次的问题。

    对齐引擎的保守是对的（合并不可逆），但 uncertain 以前没有任何消费者 ——
    只进了一条事件载荷和 CLI 打印。系统比对了上千对、看出来了，然后什么也没说。
    """
    from ontocopilot.onto.align import PairScore
    from ontocopilot.onto.gaps import alignment_gaps
    from ontocopilot.onto.oir import ObjectType, Provenance, extracted

    p = Provenance("f1", "梳理表.xlsx", {"kind": "cell"}, extractor="rule")
    oir = OIR()
    for rid, api, cn in (("ot_a", "spProjectTeamMember", "项目团队成员信息"),
                         ("ot_b", "clmProjectTeamMember", "项目团队成员信息")):
        oir.objects[rid] = ObjectType(rid=rid, api_name=extracted(api, p),
                                      display_name=extracted(cn, p))
    score = PairScore(a="ot_a", b="ot_b", name=0.83, structure=0.0, alias=True,
                      reasons=["别名重合 ['项目团队成员信息']", "至少一边没有属性，无结构证据"])

    gaps = alignment_gaps(oir, [score])
    assert len(gaps) == 1
    q = gaps[0].to_question()
    assert "项目团队成员信息" in q.text.value
    assert "别名重合" in q.text.value          # 凭什么问，要说清楚
    assert q.applies_to == ["ot_a", "ot_b"]    # 点得回两边
    assert q.options                            # 是/否/回头问客户，不替他决定
    # 别名完全重合的那档最像真阳性，要排在别的缺口前面
    assert gaps[0].weight > 4.0


def test_alignment_gaps_are_silent_when_there_is_nothing_uncertain():
    from ontocopilot.onto.gaps import alignment_gaps

    assert alignment_gaps(OIR(), []) == []
