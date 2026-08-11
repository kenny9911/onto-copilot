"""流程模型、抽取与渲染。

对照的是一份真实材料：`实体梳理.xlsx!业务规则` 的三个合并单元格里塞着 17 个
流程节点，每个是「名称+触发条件+输入+输出+执行者」五段式。这套东西规则就能拆，
下面钉住"一个不丢、边有依据、推断的要标出来"。
"""

from __future__ import annotations

import pytest

from ontocopilot.onto.diagram import to_mermaid, to_svg
from ontocopilot.onto.flow import (
    EdgeKind,
    FlowGraph,
    FlowNode,
    NodeKind,
    Stage,
    code_for,
)
from ontocopilot.onto.flow_extract import (
    build_flow,
    looks_like_process,
    parse_steps,
    stages_from_groups,
)
from ontocopilot.onto.oir import Provenance, extracted, inferred, make_rid

# 真实材料的原文片段，含它自带的错别字「执行着」
_REAL = """（1）编制集采计划：集中采购专业机构根据集采原则，编制集采计划
触发条件：无（主要以集约化标准和框架到期日进行判断）；
输入：集采计划编制策略及集采计划编制要求，无系统节点；
输出：一级集采计划、二级集采计划、自定义集采计划；
执行者：采购计划员
（2）审核集采计划：对集采计划进行审批，以备注入采购需求计划；
触发条件：集采计划编制已完成，触发集采计划审批；
输入：集采计划
输出：已审批集采计划
执行着：集采部门领导
（3）创建采购需求计划：1）基于已审批集采计划自动注入；
触发条件：1）集采计划审批完成；
输入：1）已审批集采计划；
输出：未审批采购需求计划；
执行者：需求申请人"""


# ══════════════════════════════════════════════════════════════════
#  拆解
# ══════════════════════════════════════════════════════════════════
def test_every_step_is_extracted():
    """一个不丢。让模型读结构化文本只会在第十几个节点上开始漏。"""
    steps = parse_steps(_REAL, cite="业务规则!A14")
    assert [s.no for s in steps] == [1, 2, 3]
    assert [s.name for s in steps] == ["编制集采计划", "审核集采计划", "创建采购需求计划"]


def test_the_typo_in_the_material_is_handled():
    """材料里第 2 个节点写的是「执行着」不是「执行者」。

    真实材料就是会有错别字。认不出它就会丢掉一整个节点的执行者，
    而"这一步归谁"恰恰是业务方一眼能答、也只有他能答的。
    """
    steps = parse_steps(_REAL)
    assert steps[1].actor == "集采部门领导"


def test_all_four_fields_are_split():
    s = parse_steps(_REAL)[0]
    assert s.trigger.startswith("无（主要以集约化")
    assert "编制策略" in s.inputs
    assert s.outputs.startswith("一级集采计划")
    assert s.actor == "采购计划员"


def test_process_detection_needs_structure_not_keywords():
    """只看关键词的话，「本节说明采购流程」也会命中。"""
    assert looks_like_process(_REAL)
    assert not looks_like_process("本节说明采购流程的整体设计思路与目标。")
    assert not looks_like_process("（1）第一点（2）第二点（3）第三点")


def test_empty_input_is_not_a_crash():
    assert parse_steps("") == []
    assert parse_steps("一段没有编号的散文") == []


# ══════════════════════════════════════════════════════════════════
#  建图
# ══════════════════════════════════════════════════════════════════
def _graph():
    steps = parse_steps(_REAL, cite="业务规则!A14")
    g, mapping = stages_from_groups({"阶段一｜集采": [1, 2], "阶段二｜需求": [3]})
    return build_flow(steps, stages=mapping, file_name="实体梳理.xlsx", graph=g)


def test_each_step_becomes_an_action_plus_an_event():
    """Action 和 Event 是两种节点。合成一种，下游就既挂不上监听也挂不上权限。"""
    g = _graph()
    st = g.stats()
    assert st["actions"] == 3
    assert st["events"] == 3


def test_parallel_outputs_do_not_explode_into_separate_nodes():
    """「一级集采计划、二级集采计划、自定义集采计划」是同一个节拍的三个产物，
    画三个 EVENT 会让图爆炸。"""
    g = _graph()
    evt = next(n for n in g.nodes.values()
               if n.kind is NodeKind.EVENT and "一级集采" in n.label.value)
    assert "二级集采计划" in evt.objects


def test_edges_from_the_material_carry_evidence():
    """节点 3 的触发条件里写了「集采计划审批完成」，指向节点 2 的输出 ——
    这条边有依据，不是我们连的。"""
    g = _graph()
    grounded = [e for e in g.edges.values() if e.grounded]
    assert grounded, "一条有依据的边都没有"
    assert all(e.evidence[0].extractor == "rule" for e in grounded)


def test_inferred_edges_are_marked_not_hidden():
    """接不上的按编号补，但**必须标出来**。
    一张分不清哪里是猜的流程图，比没有图更危险。"""
    g = _graph()
    for e in g.edges.values():
        if not e.grounded:
            assert e.kind is EdgeKind.INFERRED, f"{e.rid} 没有依据却不是虚线"
    assert g.stats()["inferred_edges"] == sum(
        1 for e in g.edges.values() if not e.grounded)


def test_stages_come_from_outside_not_from_guessing():
    """材料里**没有**阶段划分，只有 17 个连续编号。阶段是人划的 ——
    猜阶段会让整张图的骨架建立在没人确认过的判断上。"""
    steps = parse_steps(_REAL)
    g = build_flow(steps, file_name="x.xlsx")     # 不给 stages
    assert set(n.stage for n in g.nodes.values()) == {"main"}


# ══════════════════════════════════════════════════════════════════
#  编号
# ══════════════════════════════════════════════════════════════════
def test_codes_are_semantic_where_possible():
    assert code_for(NodeKind.ACTION, "编制集采计划") == "ACT-CP-DRAFT"
    assert code_for(NodeKind.ACTION, "创建采购包") == "ACT-PKG-CREATE"
    assert code_for(NodeKind.EVENT, "集采计划编制已发起") == "EVT-CP-PLANNING-REQUESTED"
    assert code_for(NodeKind.EVENT, "采购需求计划已提交") == "EVT-PBP-SUBMITTED"


def test_codes_are_stable_across_processes():
    """兜底编号曾用 Python 的 hash()，它带进程随机盐 —— 同一个节点每次启动
    拿到不同编号，两版图的 diff 直接全红。"""
    import subprocess
    import sys

    expr = ("from ontocopilot.onto.flow import code_for,NodeKind as K;"
            "print(code_for(K.EVENT,'某个说不上来的事'))")
    out = subprocess.run([sys.executable, "-c", expr],
                         capture_output=True, text=True).stdout.strip()
    assert out == code_for(NodeKind.EVENT, "某个说不上来的事")


def test_code_collisions_get_a_suffix():
    """撞号会让下游的钩子挂错节点。"""
    taken = {"ACT-CP-DRAFT"}
    assert code_for(NodeKind.ACTION, "编制集采计划", taken=taken) == "ACT-CP-DRAFT-2"


# ══════════════════════════════════════════════════════════════════
#  体检
# ══════════════════════════════════════════════════════════════════
def _tiny() -> FlowGraph:
    g = FlowGraph()
    g.stages["s"] = Stage(key="s", title="阶段", order=1)
    p = Provenance("f", "x.docx", {"kind": "raw"}, extractor="rule")

    def n(kind, label, grounded=True):
        return g.add_node(FlowNode(rid=make_rid("fn", label), kind=kind, stage="s",
                                   label=extracted(label, p) if grounded
                                   else inferred(label)))
    return g, n, p


def test_dead_ends_are_found():
    """图看起来是连的，但顺着走会走进死胡同 —— 那往往意味着材料少了一段。"""
    g, n, p = _tiny()
    a = n(NodeKind.ACTION, "做一件事")
    e = n(NodeKind.EVENT, "事已做完")
    g.connect(a.rid, e.rid, evidence=[p])
    assert [x.label.value for x in g.dead_ends()] == ["事已做完"]


def test_terminals_are_not_dead_ends():
    g, n, p = _tiny()
    a = n(NodeKind.ACTION, "做一件事")
    t = n(NodeKind.TERMINAL, "已归档")
    g.connect(a.rid, t.rid, evidence=[p])
    assert not g.dead_ends()


def test_unlabeled_gateway_branches_are_found():
    """看图的人不知道什么时候走哪条。"""
    g, n, p = _tiny()
    gw = n(NodeKind.GATEWAY, "审批结果")
    ok = n(NodeKind.EVENT, "已通过")
    no = n(NodeKind.EVENT, "已驳回")
    g.connect(gw.rid, ok.rid, kind=EdgeKind.CONDITIONAL, label="通过", evidence=[p])
    g.connect(gw.rid, no.rid, kind=EdgeKind.CONDITIONAL, evidence=[p])   # 没标签
    assert [x.label.value for x in g.unlabeled_branches()] == ["审批结果"]


def test_actions_without_events_are_found():
    """做了一件事却没有可观测结果 —— 下游没法挂监听。"""
    g, n, p = _tiny()
    a = n(NodeKind.ACTION, "做一件事")
    b = n(NodeKind.ACTION, "又做一件")
    g.connect(a.rid, b.rid, evidence=[p])
    assert [x.label.value for x in g.actions_without_events()] == ["做一件事", "又做一件"]


# ══════════════════════════════════════════════════════════════════
#  渲染
# ══════════════════════════════════════════════════════════════════
def test_mermaid_is_syntactically_plausible():
    g = _graph()
    m = to_mermaid(g)
    assert m.startswith("flowchart")
    assert "subgraph" in m and m.count("end") >= 1
    assert "classDef act" in m and "classDef evt" in m


def test_inferred_nodes_are_marked_in_mermaid():
    g, n, p = _tiny()
    n(NodeKind.ACTION, "有依据的")
    n(NodeKind.ACTION, "补出来的", grounded=False)
    m = to_mermaid(g)
    assert m.count("· 推断 ·") == 1


def test_svg_is_self_contained_and_has_no_external_refs():
    """离线可用是硬要求 —— 这个环境拉不到 npm 包，客户现场也未必有网。"""
    g = _graph()
    svg = to_svg(g)
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")
    # xmlns 那个 URL 是命名空间声明，不是要去下载的东西 —— 把它算成外部依赖
    # 是断言写粗了。真正要拦的是**会发起网络请求**的东西。
    body = svg.replace('xmlns="http://www.w3.org/2000/svg"', "")
    for bad in ("<script", "<image", "<foreignObject", "url(http", "@import",
                "src=", "href=\"http"):
        assert bad not in body, f"SVG 里有外部依赖：{bad}"


def test_svg_reports_how_much_was_inferred():
    """这个数字直接决定这张图能不能拿去跟客户对。"""
    g = _graph()
    assert "条边为系统推断" in to_svg(g)


def test_a_cyclic_graph_still_renders():
    """驳回重编是个环。因为有环就画不出来的流程图，对 FDE 的价值是零 ——
    而真实业务流程几乎一定有环。"""
    g, n, p = _tiny()
    a = n(NodeKind.ACTION, "编制")
    b = n(NodeKind.ACTION, "审批")
    g.connect(a.rid, b.rid, evidence=[p])
    g.connect(b.rid, a.rid, kind=EdgeKind.COMPENSATE, label="驳回", evidence=[p])
    svg = to_svg(g)
    assert svg.count("<rect") >= 2


# ══════════════════════════════════════════════════════════════════
#  流程图撤销（server 层工具）
# ══════════════════════════════════════════════════════════════════
async def test_flow_undo_restores_previous_version(tmp_path, monkeypatch):
    """flow.undo 弹出编辑前快照、还原整图并重出 SVG/主干；空栈时给错误而不是崩。
    人工加的节点回退后不该残留 —— 撤销要真的回到编辑前那一版。"""
    import ontocopilot.server as server
    from ontocopilot.onto.flow_edit import apply_flow_edit

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="undo1", title="UndoTest")
    s.dir.mkdir(parents=True, exist_ok=True)

    g = _graph()
    n0 = len(g.nodes)
    # 模拟一次 flow.edit：先压「编辑前」快照，再改图（加个人工节点）
    server._push_version(s, "_flow_versions", g.to_dict())
    apply_flow_edit(g, "add_node", {"kind": "action", "label": "临时加的节点"})
    s.state["_flow"] = g
    assert len(g.nodes) == n0 + 1

    reg = server._converse_tools(s)

    class Ctx:
        approved = True
        pending: list = []

    out = await reg.call("flow.undo", {}, Ctx(), scope="converse")
    assert out.get("已撤销") is True
    assert len(s.state["_flow"].nodes) == n0            # 回到编辑前
    assert s.state["_flow_versions"] == []              # 栈弹空
    assert (s.dir / "流程图.svg").exists()               # 重出了产物
    assert "流程图.svg" in s.state["artifacts"]

    out2 = await reg.call("flow.undo", {}, Ctx(), scope="converse")   # 没有可撤的了
    assert "error" in out2


def test_push_version_caps_the_stack(monkeypatch):
    """版本栈要封顶，否则长命进程每编辑一次就无限长。"""
    import ontocopilot.server as server

    s = server.Session(id="cap1")
    for i in range(server._VERSION_STACK_CAP + 5):
        server._push_version(s, "_flow_versions", {"n": i})
    stack = s.state["_flow_versions"]
    assert len(stack) == server._VERSION_STACK_CAP
    assert stack[-1] == {"n": server._VERSION_STACK_CAP + 4}   # 留的是最近的


def test_replay_flow_patches_reapplies_manual_edits(monkeypatch, tmp_path):
    """补料重跑重建流程图后，人工加的节点要经补丁日志重现；重放不上的报 stale。"""
    import ontocopilot.server as server

    monkeypatch.setattr(server, "ROOT", tmp_path)
    s = server.Session(id="replay1")
    s.state["_flow_patch_log"] = [
        {"op": "add_node", "args": {"kind": "action", "label": "人工补的节点"}},
        {"op": "connect", "args": {"source": "不存在A", "target": "不存在B"}},
    ]
    g = _graph()
    n0 = len(g.nodes)
    stale = server._replay_flow_patches(s, g)
    assert len(g.nodes) == n0 + 1                                    # 人工节点重现
    assert any(n.label.value == "人工补的节点" for n in g.nodes.values())
    assert len(stale) == 1 and stale[0]["op"] == "connect"          # 连不存在的 → stale


# ══════════════════════════════════════════════════════════════════
#  开场与追问
# ══════════════════════════════════════════════════════════════════
# 一个空白输入框对新用户是最不友好的界面：他知道这工具能分析业务文档，
# 但不知道该说什么才有用。而每次回答之后同样有个断层 —— 系统刚说完
# 「有 3 个死路」，他得自己想出「哪三个」这个问题。
from ontocopilot.onto.prompts import followup_prompts, opening_prompts  # noqa: E402


def test_opening_changes_with_state():
    """没材料时问「这份材料里有多少对象」是荒谬的；跑完了还提示「上传材料」同样荒谬。"""
    empty = opening_prompts(state={}, files=[], status="idle")
    loaded = opening_prompts(state={}, files=["实体梳理.xlsx"], status="idle")
    assert empty and loaded
    assert {p["text"] for p in empty} != {p["text"] for p in loaded}
    assert any("你能帮我做什么" in p["text"] for p in empty)
    assert any("材料" in p["text"] for p in loaded)


def test_opening_after_a_run_talks_about_the_products():
    st = {"oir": {"stats": {"objects": 172, "properties": 0, "rules": 9,
                            "open_questions": 150}},
          "flow": {"stats": {"actions": 17, "inferred_edges": 12, "dead_ends": 3}}}
    ps = opening_prompts(state=st, files=["a.xlsx"], status="done")
    joined = " ".join(p["text"] for p in ps)
    assert "17" in joined or "12" in joined or "150" in joined, joined


def test_followups_grow_out_of_the_answer():
    """从回答本身长出来的追问，比从状态长出来的更贴 ——
    用户刚读完那句话，正想问的就是它。"""
    ps = followup_prompts(answer="材料里没有写这一段。", state={}, files=["a.xlsx"])
    assert any("要什么材料" in p["text"] for p in ps), ps


def test_followups_are_capped():
    """提示多于三条就变成噪声，人会一条都不看。"""
    st = {"oir": {"stats": {"objects": 172, "properties": 0, "rules": 9,
                            "open_questions": 150}},
          "flow": {"stats": {"actions": 17, "inferred_edges": 12}}}
    ps = followup_prompts(answer="推断 死路 口径 待确认 材料里没有",
                          state=st, files=["a.xlsx"], status="done")
    assert len(ps) <= 3


def test_followups_do_not_repeat_themselves():
    ps = followup_prompts(answer="材料里没有写，也没有找到，查不到这一段",
                          state={}, files=["a.xlsx"])
    assert len({p["text"] for p in ps}) == len(ps)


def test_a_prompt_carries_what_it_actually_sends():
    """显示文案和实际问法可以不同 —— 「看看流程图」点下去该问出具体问题。"""
    st = {"flow": {"stats": {"actions": 17, "dead_ends": 3, "inferred_edges": 5}}}
    ps = opening_prompts(state=st, files=["a.xlsx"], status="done")
    assert all(p["send"] for p in ps)
    assert any(p["send"] != p["text"] for p in ps), "没有一条把显示与发送分开"


# ══════════════════════════════════════════════════════════════════
#  网关 / 阶段 / 缺口
# ══════════════════════════════════════════════════════════════════
from ontocopilot.onto.flow_extract import (  # noqa: E402
    attach_gateways,
    gaps_to_questions,
    parse_gateways,
    stages_from_survey,
    survey_stage_groups,
)


def test_gateway_from_if_then_rule():
    """业务规则里的「如…则…」是全图唯一带条件的东西 —— 库存判断是标准双分支。"""
    gws = parse_gateways(
        "如调拨库存可满足要求，则不进行采购，如不满足，则创建采购执行计划", cite="A20")
    assert len(gws) == 1
    assert "库存" in gws[0].condition
    labels = {l for l, _ in gws[0].branches}
    assert labels == {"是", "否"}


def test_gateway_failure_branch():
    """「如超出XX金额，则采购包创建失败」—— 失败分支该标成「不满足」。"""
    gws = parse_gateways("如超出XX金额，则采购包创建失败", cite="A27")
    assert gws and gws[0].branches[0][0] == "不满足"


def test_ru_inside_a_word_is_not_a_gateway():
    """「如实填写」「例如」里的「如」不是条件从句的开头。"""
    assert parse_gateways("请如实填写，例如金额、数量") == []
    assert parse_gateways("1、根据已审批采购申请进行采购包创建") == []


def test_if_without_a_result_word_is_not_a_gateway():
    """「如果X，可以修改」没有「则/需/自动」这类结果引导词 —— 不是分叉。"""
    assert parse_gateways("如果执行计划已经建了但还没审批，可以随时修改") == []


def test_parens_do_not_break_a_rule_apart():
    """「（各阶段：立项、分配…）」里的顿号分号不能把一条规则劈碎，
    否则会冒出「当前时间、」这种半截 condition。"""
    text = ("按照采购阶段配置周期（各阶段：采购立项创建、采购包分配、评标、定标），"
            "依据采购需求时间创建；如当前时间、需求时间计算后无法满足要求，则自动预警")
    gws = parse_gateways(text, cite="A20")
    for gw in gws:
        assert not gw.condition.endswith(("、", "，")), gw.condition
        assert len(gw.condition) >= 3


def test_gateway_branches_are_terminals_not_dead_ends():
    """网关分支去向是散文短语，用 TERMINAL 承接 —— 否则全被 dead_ends() 报成
    「流程断点」，淹掉真正的断点。"""
    from ontocopilot.onto.flow import FlowGraph, NodeKind, Stage

    g = FlowGraph()
    g.stages["s"] = Stage(key="s", title="阶段", order=1)
    gws = parse_gateways("如超出XX金额，则采购包创建失败", cite="A27")
    g = attach_gateways(g, [(gws[0], None)], file_name="x.xlsx")
    leaves = [n for n in g.nodes.values() if n.kind is NodeKind.TERMINAL]
    assert leaves and not g.dead_ends()


def test_stages_from_survey_scene_ranges():
    """问卷的「业务场景（重点覆盖节点6—10）」直接给了阶段到节点区间的映射。"""
    sheets = {"规则问题": ["场景", "业务场景一：采购执行计划创建（重点覆盖节点6—10）",
                        "业务场景二：采购包创建（节点11—14）"]}
    groups = survey_stage_groups(sheets)
    assert groups[0] == ("采购执行计划创建", [6, 7, 8, 9, 10])
    assert groups[1][1] == [11, 12, 13, 14]


def test_stages_from_survey_node_column():
    """没有明写区间时，退回按「（N）名字」的业务域分组。"""
    sheets = {"流程节点问题": ["节点", "（1）编制集采计划", "（2）审批集采计划",
                          "（3）创建采购需求计划", "（4）修改采购需求计划"]}
    groups = survey_stage_groups(sheets)
    # 集采计划 1-2 一段，采购需求计划 3-4 一段
    assert [nos for _, nos in groups] == [[1, 2], [3, 4]]


def test_no_survey_returns_empty_not_a_guess():
    """抽不到就返回空 —— 上层据此退回按编号切分并注明待确认，不硬猜。"""
    assert survey_stage_groups({"x": ["一段普通说明", "另一段"]}) == []


def test_gaps_become_questions():
    """图上标黄的每一处缺口，都是一个 FDE 本该问客户却容易漏掉的问题。"""
    g = _graph()
    qs = gaps_to_questions(g, file_name="x.xlsx")
    assert qs, "有死路却没生成问题"
    assert all(q.asked_by == "system" for q in qs)
    assert any("之后是什么" in q.text.value for q in qs), [q.text.value for q in qs]


def test_main_path_drops_inferred_noise():
    """47+101 节点全画出来会挤成一团。主干视图只留有依据的骨架。"""
    g = _graph()
    main = g.main_path()
    assert len(main.nodes) <= len(g.nodes)
    # 主干里每条边都有依据
    assert all(e.grounded for e in main.edges.values())


# ══════════════════════════════════════════════════════════════════
#  流程图编辑（对话动态改）
# ══════════════════════════════════════════════════════════════════
from ontocopilot.onto.flow import flow_from_dict  # noqa: E402
from ontocopilot.onto.flow_edit import FlowEditError, apply_flow_edit  # noqa: E402


def _edit_graph():
    steps = parse_steps(_REAL, cite="业务规则!A14")
    g, mapping = stages_from_groups({"阶段一": [1, 2], "阶段二": [3]})
    return build_flow(steps, stages=mapping, file_name="x.xlsx", graph=g)


def test_rename_node_keeps_evidence():
    """改的只是措辞，材料依据没变 —— 出处要保留。"""
    g = _edit_graph()
    apply_flow_edit(g, "rename_node",
                    {"node": "编制集采计划", "label": "编制年度集采计划"})
    n = next(x for x in g.nodes.values() if x.label.value == "编制年度集采计划")
    assert n.grounded, "改名把出处丢了"


def test_manual_edge_is_marked_not_fabricated():
    """FDE 手动连的边是他拍的板，不是材料 —— 图上标成人工来源，和推断区分。"""
    g = _edit_graph()
    before = len(g.edges)
    apply_flow_edit(g, "connect",
                    {"source": "审核集采计划", "target": "创建采购需求计划"})
    assert len(g.edges) == before + 1
    manual = [e for e in g.edges.values()
              if e.evidence and e.evidence[0].extractor == "human"]
    assert manual, "人工连的边没有标成 human 来源"


def test_add_node_is_inferred_not_grounded():
    """人工加的节点不冒充材料依据。"""
    g = _edit_graph()
    apply_flow_edit(g, "add_node", {"kind": "event", "label": "集采计划已归档"})
    n = next(x for x in g.nodes.values() if x.label.value == "集采计划已归档")
    # 有 human 出处，但 origin 是 inferred（不是从材料 extracted）
    assert n.label.evidence and n.label.evidence[0].extractor == "human"


def test_remove_node_takes_its_edges():
    """留下悬空边比留下节点更糟。"""
    g = _edit_graph()
    victim = next(x for x in g.nodes.values() if x.kind is NodeKind.ACTION)
    apply_flow_edit(g, "remove_node", {"node": victim.label.value})
    assert victim.rid not in g.nodes
    assert not any(e.source == victim.rid or e.target == victim.rid
                   for e in g.edges.values())


def test_ambiguous_node_ref_is_rejected():
    """「采购包」对应多个节点，得说具体 —— 不能猜一个改。"""
    g = _edit_graph()
    apply_flow_edit(g, "add_node", {"kind": "action", "label": "编制月度计划"})
    with pytest.raises(FlowEditError, match="多个|找不到"):
        apply_flow_edit(g, "rename_node", {"node": "编制", "label": "x"})


def test_event_has_no_actor():
    g = _edit_graph()
    evt = next(x for x in g.nodes.values() if x.kind is NodeKind.EVENT)
    with pytest.raises(FlowEditError, match="不是动作"):
        apply_flow_edit(g, "set_actor", {"node": evt.label.value, "actor": "张三"})


def test_unknown_op_is_rejected():
    g = _edit_graph()
    with pytest.raises(FlowEditError, match="不支持"):
        apply_flow_edit(g, "explode_everything", {})


def test_flow_round_trips_through_dict():
    """恢复会话时 _flow 是活对象，要能从 flow.json 还原 —— 否则改不了图。"""
    g = _edit_graph()
    g2 = flow_from_dict(g.to_dict())
    assert g2.stats() == g.stats()
    # 出处也要还原 —— human/材料/推断三者的区分不能在往返里丢
    n = next(iter(g.nodes.values()))
    n2 = g2.nodes[n.rid]
    if n.label.evidence:
        assert n2.label.evidence
        assert n2.label.evidence[0].extractor == n.label.evidence[0].extractor


# ══════════════════════════════════════════════════════════════════
#  阶段划分：来自材料，不来自一条只认中文数字的正则
# ══════════════════════════════════════════════════════════════════
def test_scene_headers_written_with_arabic_digits_are_recognised():
    """材料写的是「业务场景1」不是「业务场景一」。

    只认中文数字的正则在这份材料上一个场景都抽不到，于是整张图退到"按编号每
    4 个切一段"，阶段标题全是系统编的。
    """
    from ontocopilot.onto.flow_extract import scene_headers

    got = scene_headers(["业务场景1", "采购执行计划创建"])
    assert got == ["业务场景1｜采购执行计划创建"]


def test_a_scene_title_can_live_in_the_next_cell():
    """「业务场景1」在 A 列、「采购执行计划创建」在 B 列 —— 只读 A 列就只剩编号。"""
    from ontocopilot.onto.flow_extract import scene_headers

    assert scene_headers(["业务场景2", "采购包创建", "业务规则：\n1、…"]) == \
        ["业务场景2｜采购包创建"]


def test_a_paragraph_is_not_a_node_label():
    """一个合并单元格里塞着 17 个节点的全文，不是问卷里那种「（1）编制集采计划」。

    真实事故：那 700 字被当成节点 1 的名字，于是整张图只有一个阶段、标题是
    半段说明文，另外 16 个节点全落进一个没注册的泳道。
    """
    from ontocopilot.onto.flow_extract import survey_stage_groups

    blob = ("（1）编制集采计划：集中采购专业机构根据集采原则，选取、分析、整合相关项目，"
            "对采购计划、历史采购数据进行系统性梳理与分析，编制集采计划\n"
            "触发条件：无\n输入：策略\n输出：一级集采计划\n执行者：采购计划员\n"
            "（2）审核集采计划：对集采计划进行审批\n触发条件：编制已完成\n")
    assert survey_stage_groups({"业务规则": [blob]}) == []


def test_every_node_lands_in_a_registered_stage():
    """泳道标题不能是内部 key。

    `build_flow` 给没分到阶段的节点填了 "main"，而 "main" 从来没进过
    `g.stages` —— 画出来就是一条标题写着 `main` 的泳道。
    """
    from ontocopilot.onto.flow_extract import build_flow, parse_steps

    g = build_flow(parse_steps(_REAL, cite="业务规则!A14"), file_name="x.xlsx")
    assert g.nodes
    for n in g.nodes.values():
        assert n.stage in g.stages, f"节点「{n.label.value}」落在没注册的泳道 {n.stage!r}"


def test_stages_fall_back_to_business_domain_not_fixed_size_chunks():
    """没有场景标题时，按业务域切段，而不是每 4 个硬切一刀。"""
    from ontocopilot.onto.flow_extract import build_flow, parse_steps, stages_by_domain

    steps = parse_steps(_REAL, cite="业务规则!A14")
    g, mapping = stages_by_domain(steps)
    build_flow(steps, stages=mapping, file_name="x.xlsx", graph=g)
    assert g.stages
    titles = [st.title for st in g.stages.values()]
    assert all(len(t) <= 40 for t in titles), titles
