"""DAG 冻结、调度、agent loop、critic、gate、预算降级、崩溃恢复。"""

from __future__ import annotations

import json

import pytest

from ontocopilot.kernel.budget import Budget, DegradeLevel
from ontocopilot.kernel.bus.bus import AgentBus
from ontocopilot.kernel.critic import (
    Critic,
    CriticContext,
    CriticPanel,
    Decision,
    Finding,
    Gate,
    GateResult,
    LLMCritic,
    RuleCritic,
    Severity,
    Verdict,
    metrics_from,
)
from ontocopilot.kernel.dag import (
    Dag,
    Difficulty,
    NodeBudget,
    NodeMode,
    NodeSpec,
    ScopeSpec,
)
from ontocopilot.kernel.errors import DagError, FrozenPlanViolation, NodeFailure
from ontocopilot.kernel.events import EventKind
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.llm import ModelGateway, ScriptedBackend, stub_routing
from ontocopilot.kernel.loop import AgentLoop, NodeHandler
from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.kernel.scheduler import RunStatus, Scheduler


# ══════════════════════════════════════════════════════════════════
#  DAG
# ══════════════════════════════════════════════════════════════════
def _n(nid, deps=(), **kw):
    return NodeSpec(id=nid, mode=NodeMode.DETERMINISTIC, handler="echo", deps=tuple(deps), **kw)


def test_topo_order_is_stable_across_runs():
    """重放要求调度顺序确定 —— 按 id 排序出队保证这一点。"""
    def build():
        d = Dag("t")
        for nid, deps in [("C", ["A"]), ("A", []), ("D", ["B", "C"]), ("B", ["A"])]:
            d.add(_n(nid, deps))
        return d.topo_order()

    assert build() == build() == ["A", "B", "C", "D"]


def test_cycle_is_detected():
    d = Dag("t").add(_n("A", ["B"])).add(_n("B", ["A"]))
    with pytest.raises(DagError, match="环"):
        d.topo_order()


def test_dangling_dependency_is_detected():
    d = Dag("t").add(_n("A", ["ghost"]))
    with pytest.raises(DagError, match="不存在"):
        d.topo_order()


def test_wildcard_dependency_forms_a_barrier():
    d = Dag("t")
    d.add(NodeSpec("PARSE", NodeMode.DETERMINISTIC, "echo", fanout_over="files"))
    d.add(_n("ALIGN", ["PARSE.*"]))
    d.expand({"PARSE": ["f1", "f2", "f3"]})
    assert d.resolve_deps("ALIGN") == ["PARSE.f1", "PARSE.f2", "PARSE.f3"]
    assert d.topo_order()[-1] == "ALIGN"


def test_frozen_dag_rejects_topology_changes():
    """计划冻结是安全边界 —— 材料内容绝不能改变计划结构。"""
    d = Dag("t", freeze_before="PARSE")
    d.add(NodeSpec("PARSE", NodeMode.DETERMINISTIC, "echo", fanout_over="files"))
    d.expand({"PARSE": ["f1"]}).freeze()

    with pytest.raises(FrozenPlanViolation, match="材料内容"):
        d.add(_n("EVIL_EXFIL"))
    with pytest.raises(FrozenPlanViolation):
        d.expand({"PARSE": ["f2"]})


def test_dependents_supports_blast_radius_calculation():
    d = Dag("t").add(_n("A")).add(_n("B", ["A"])).add(_n("C", ["A"])).add(_n("D", ["B"]))
    assert d.dependents("A") == ["B", "C"]


# ══════════════════════════════════════════════════════════════════
#  预算降级
# ══════════════════════════════════════════════════════════════════
def test_degradation_ladder_matches_spec():
    b = Budget(tokens=1000)
    assert b.level is DegradeLevel.NONE
    b.spend(tokens=650)  # 剩 35% → 关多采样
    assert b.level is DegradeLevel.NO_SELF_CONSISTENCY
    assert not b.allow_self_consistency() and b.critic_rounds(2) == 2
    b.spend(tokens=150)  # 剩 20% → critic 轮数降 1
    assert b.critic_rounds(2) == 1
    b.spend(tokens=80)  # 剩 12% → 仅规则
    assert not b.allow_llm_critic() and b.critic_rounds(2) == 0
    b.spend(tokens=80)  # 剩 4% → 暂停
    assert b.must_halt()


def test_degradation_level_never_regresses():
    b = Budget(tokens=1000)
    b.spend(tokens=900)
    assert b.level is DegradeLevel.RULES_ONLY
    b.tokens = 100_000  # 就算上调额度，已宣告的降级不回退
    assert b.level >= DegradeLevel.RULES_ONLY


def test_tightest_dimension_drives_degradation():
    b = Budget(tokens=1_000_000, usd=10.0)
    b.spend(tokens=1000, usd=9.7)
    assert b.tightest[0] == "usd"
    assert b.level >= DegradeLevel.FEWER_CRITIC_ROUNDS


# ══════════════════════════════════════════════════════════════════
#  Critic / Gate
# ══════════════════════════════════════════════════════════════════
def _rec():
    return Recorder("r1", InMemoryJournal(), InMemoryBlobStore())


async def test_rule_critic_needs_no_model():
    def check(draft):
        return [
            Finding(Severity.HIGH, "NAMING_VIOLATION", p, f"{p} 不是 lowerCamelCase",
                    verifier="regex:^[a-z][a-zA-Z0-9]*$")
            for p in draft["props"] if not p[0].islower()
        ]

    c = RuleCritic("naming", check)
    v = await c.judge({"props": ["planAmount", "PlanDate", "Supplier"]}, None)
    assert not v.passed and len(v.findings) == 2
    assert all(f.verifier.startswith("regex") for f in v.findings)


async def test_panel_runs_lenses_in_parallel_and_logs_each():
    rec = _rec()
    panel = CriticPanel(
        {
            "schema": RuleCritic("schema", lambda d: []),
            "naming": RuleCritic("naming", lambda d: [
                Finding(Severity.MEDIUM, "NAMING", "x", "命名可优化", verifier="dict")]),
        },
        rec,
    )
    ctx = CriticContext(node_id="N", gateway=None, generator=None)
    verdicts = await panel.judge({}, ["schema", "naming"], ctx)
    assert {v.lens for v in verdicts} == {"schema", "naming"}
    logged = [e for e in rec.journal.read("r1") if e.kind is EventKind.CRITIC_VERDICT]
    assert len(logged) == 2


async def test_llm_critics_are_skipped_under_budget_pressure_and_it_is_logged():
    """降级必须可见 —— 悄悄跳过语义审核再交付是最严重的错误。"""
    rec = _rec()
    panel = CriticPanel(
        {"rules": RuleCritic("rules", lambda d: []),
         "semantic": LLMCritic("semantic", ["口径是否一致"])},
        rec,
    )
    ctx = CriticContext(node_id="N", gateway=None, generator=None)
    verdicts = await panel.judge({}, ["rules", "semantic"], ctx, allow_llm=False)

    assert [v.lens for v in verdicts] == ["rules"]
    degraded = [e for e in rec.journal.read("r1") if e.kind is EventKind.DEGRADED]
    assert degraded[0].payload["skipped_critics"] == ["semantic"]


def test_gate_blocks_on_high_findings_and_routes_by_failure():
    gate = Gate(
        "publish",
        require=[
            ("无高危", lambda m: m["high_findings"] == 0),
            ("完成度达标", lambda m: m.get("completeness", 0) >= 0.95),
        ],
        on_fail=lambda m: GateResult(
            Decision.ROUND_TRIP if m.get("completeness", 0) < 0.95 else Decision.ASK_USER,
            f"未过: {m['failed']}",
        ),
    )
    rec = _rec()
    verdicts = [Verdict("schema", True), Verdict("prov", False, [
        Finding(Severity.HIGH, "EVIDENCE_MISSING", "pt_x", "无证据", verifier="rule")])]

    m = {**metrics_from(verdicts), "completeness": 0.68}
    r = gate.evaluate(m, rec, "GATE")
    assert r.decision is Decision.ROUND_TRIP

    m2 = {**metrics_from([Verdict("schema", True)]), "completeness": 0.96}
    assert gate.evaluate(m2, rec, "GATE").decision is Decision.PASS


def test_heterogeneous_judge_is_enforced():
    from ontocopilot.kernel.llm import ModelError, RoutingTable, ModelSpec

    gen = ModelSpec("same-model", "frontier", 5, 25)
    rt = RoutingTable(models={Difficulty.HIGH: gen}, judges=[gen])
    with pytest.raises(ModelError, match="自我增强偏差"):
        rt.judge_for(gen)


def test_production_routing_uses_cross_family_judges():
    from ontocopilot.kernel.llm import production_routing

    rt = production_routing()
    opus = rt.model_for(Difficulty.HIGH)
    assert rt.judge_for(opus).name != opus.name
    # Haiku 档不下发 effort/thinking —— 该模型不支持，传了会报错
    low = rt.model_for(Difficulty.LOW)
    assert low.effort is None and low.thinking is None


# ══════════════════════════════════════════════════════════════════
#  端到端调度
# ══════════════════════════════════════════════════════════════════
class CountHandler(NodeHandler):
    """确定性节点：把上游数字加起来。"""

    def __init__(self, add: int = 1, fail_times: int = 0):
        self.add = add
        self.fail_times = fail_times
        self.calls = 0

    def task(self, inputs):
        return "累加上游结果"

    async def execute(self, inputs, ctx):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise NodeFailure(ctx.node_id, "临时故障", retryable=True)
        return {"n": sum(v.get("n", 0) for v in inputs.values()) + self.add}


class ExtractHandler(NodeHandler):
    """SINGLE_SHOT 节点：走模型 + schema。"""

    schema = {
        "type": "object",
        "required": ["objects"],
        "properties": {"objects": {"type": "array", "items": {"type": "string"}}},
    }

    def task(self, inputs):
        return "抽取 ObjectType"


def _harness(dag, handlers, *, backend=None, budget=None, run_id="r1", resume=False,
             journal=None, blobs=None):
    # `is None`：空的 InMemoryBlobStore 是 falsy（它有 __len__），用 `or` 会换掉共享实例
    journal = InMemoryJournal() if journal is None else journal
    blobs = InMemoryBlobStore() if blobs is None else blobs
    rec = Recorder(run_id, journal, blobs, resume=resume)
    bus = AgentBus(rec)
    budget = budget or Budget()
    gw = ModelGateway(backend or ScriptedBackend(), rec, routing=stub_routing(), budget=budget)
    cm = ContextManager(system="你是本体建模助手。", budget_tokens=8000)
    panel = CriticPanel({"schema": RuleCritic("schema", lambda d: [])}, rec)
    loop = AgentLoop(gateway=gw, ctx_manager=cm, panel=panel, bus=bus,
                     recorder=rec, budget=budget, handlers=handlers)
    return Scheduler(dag.freeze(), loop, rec, bus, budget), rec, journal, blobs


async def test_pipeline_runs_and_flows_outputs_along_edges():
    dag = Dag("t")
    dag.add(_n("A")).add(_n("B", ["A"])).add(_n("C", ["A"])).add(_n("D", ["B", "C"]))
    sched, *_ = _harness(dag, {"echo": CountHandler(add=1)})

    out = await sched.run("r1")
    assert out.ok
    assert out.outputs["A"] == {"n": 1}
    assert out.outputs["B"] == out.outputs["C"] == {"n": 2}
    assert out.outputs["D"] == {"n": 5}  # B(2) + C(2) + 1


async def test_independent_branches_run_concurrently():
    import asyncio

    class SlowHandler(NodeHandler):
        def __init__(self):
            self.concurrent = 0
            self.peak = 0

        async def execute(self, inputs, ctx):
            self.concurrent += 1
            self.peak = max(self.peak, self.concurrent)
            await asyncio.sleep(0.02)
            self.concurrent -= 1
            return {"n": 1}

    h = SlowHandler()
    dag = Dag("t").add(_n("A"))
    for i in range(4):
        dag.add(_n(f"B{i}", ["A"]))
    sched, *_ = _harness(dag, {"echo": h})
    await sched.run("r1")
    assert h.peak >= 3, "同层无依赖的节点应并发跑"


async def test_node_retries_then_succeeds():
    dag = Dag("t").add(_n("A", retries=2))
    h = CountHandler(fail_times=2)
    sched, rec, journal, _ = _harness(dag, {"echo": h})

    out = await sched.run("r1")
    assert out.ok and h.calls == 3
    failures = [e for e in journal.read("r1") if e.kind is EventKind.NODE_FAILED]
    assert len(failures) == 2 and failures[0].payload["will_retry"]


async def test_exhausted_retries_fail_the_run():
    dag = Dag("t").add(_n("A", retries=1))
    sched, *_ = _harness(dag, {"echo": CountHandler(fail_times=5)})
    out = await sched.run("r1")
    assert out.status is RunStatus.FAILED and "临时故障" in out.error


async def test_completed_nodes_are_restored_not_rerun():
    """核心承诺：崩溃恢复时已完成的节点整个跳过，不重跑也不重新付费。"""
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()

    dag1 = Dag("t").add(_n("A")).add(_n("B", ["A"]))
    h1 = CountHandler()
    sched1, rec1, *_ = _harness(dag1, {"echo": h1}, journal=journal, blobs=blobs)
    await sched1.run("r1")
    assert h1.calls == 2

    dag2 = Dag("t").add(_n("A")).add(_n("B", ["A"])).add(_n("C", ["B"]))
    h2 = CountHandler()
    sched2, *_ = _harness(dag2, {"echo": h2}, journal=journal, blobs=blobs, resume=True)
    out = await sched2.run("r1")

    assert out.ok
    assert set(out.skipped) == {"A", "B"}
    assert h2.calls == 1, "只应跑新增的 C"
    assert out.outputs["C"] == {"n": 3}


async def test_single_shot_node_uses_schema_and_records_llm_call():
    backend = ScriptedBackend([(r"抽取 ObjectType", '{"objects": ["purchasePlan", "clmContract"]}')])
    dag = Dag("t").add(NodeSpec("EX", NodeMode.SINGLE_SHOT, "extract",
                                budget=NodeBudget(tokens=8000)))
    sched, rec, journal, _ = _harness(dag, {"extract": ExtractHandler()}, backend=backend)

    out = await sched.run("r1")
    assert out.outputs["EX"] == {"objects": ["purchasePlan", "clmContract"]}
    assert len(backend.calls) == 1
    spend = [e for e in journal.read("r1") if e.kind is EventKind.BUDGET_SPENT]
    assert spend and spend[0].payload["model"].startswith("stub")


async def test_schema_violation_retries_then_raises():
    backend = ScriptedBackend([(r"抽取", "不是 JSON")])
    dag = Dag("t").add(NodeSpec("EX", NodeMode.SINGLE_SHOT, "extract", retries=0))
    sched, *_ = _harness(dag, {"extract": ExtractHandler()}, backend=backend)
    out = await sched.run("r1")
    assert out.status is RunStatus.FAILED
    assert "schema" in out.error


async def test_llm_call_is_not_repaid_on_resume():
    """重放最重要的经济性承诺。"""
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    backend = ScriptedBackend([(r"抽取 ObjectType", '{"objects": ["a"]}')])

    dag = Dag("t").add(NodeSpec("EX", NodeMode.SINGLE_SHOT, "extract"))
    sched, *_ = _harness(dag, {"extract": ExtractHandler()}, backend=backend,
                         journal=journal, blobs=blobs)
    await sched.run("r1")
    assert len(backend.calls) == 1

    # 同一个 Run 恢复：节点已完成 → 整个跳过，模型一次都不再调
    dag2 = Dag("t").add(NodeSpec("EX", NodeMode.SINGLE_SHOT, "extract"))
    sched2, *_ = _harness(dag2, {"extract": ExtractHandler()}, backend=backend,
                          journal=journal, blobs=blobs, resume=True)
    out = await sched2.run("r1")
    assert out.outputs["EX"] == {"objects": ["a"]}
    assert len(backend.calls) == 1


async def test_hitl_node_suspends_run_then_resumes_with_answer():
    class Clarify(NodeHandler):
        def human_request(self, draft, inputs):
            return {"questions": ["「计划金额」两个口径怎么处理？"]}

    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    dag = Dag("t").add(NodeSpec("CLARIFY", NodeMode.HITL, "clarify"))
    sched, rec, *_ = _harness(dag, {"clarify": Clarify()}, journal=journal, blobs=blobs)

    out = await sched.run("r1")
    assert out.status is RunStatus.SUSPENDED
    assert "计划金额" in json.dumps(out.pending_human, ensure_ascii=False)

    Recorder("r1", journal, blobs, resume=True).record_human_answer(
        "CLARIFY", "CLARIFY:hitl", {"option_id": "split_two_properties"}
    )

    dag2 = Dag("t").add(NodeSpec("CLARIFY", NodeMode.HITL, "clarify"))
    sched2, *_ = _harness(dag2, {"clarify": Clarify()}, journal=journal, blobs=blobs, resume=True)
    out2 = await sched2.run("r1")
    assert out2.ok
    assert out2.outputs["CLARIFY"] == {"option_id": "split_two_properties"}


async def test_budget_degradation_is_broadcast_and_logged():
    dag = Dag("t").add(_n("A")).add(_n("B", ["A"])).add(_n("C", ["B"]))
    budget = Budget(tokens=1000)
    budget.spend(tokens=900)  # 直接压到 RULES_ONLY
    sched, rec, journal, _ = _harness(dag, {"echo": CountHandler()}, budget=budget)

    got: list[str] = []
    sched.bus.subscribe("budget/*", lambda m: got.append(m.payload["label"]))
    out = await sched.run("r1")

    assert out.ok
    assert got, "降级必须广播出去"
    degraded = [e for e in journal.read("r1") if e.kind is EventKind.DEGRADED]
    assert degraded and degraded[0].payload["level"] >= int(DegradeLevel.RULES_ONLY)


async def test_unfrozen_dag_is_rejected():
    dag = Dag("t").add(_n("A"))
    rec = _rec()
    with pytest.raises(RuntimeError, match="冻结是安全边界"):
        Scheduler(dag, None, rec, AgentBus(rec), Budget())


async def test_rule_extracted_content_survives_the_critic_refine_round():
    """critic 让模型改一版，规则抽好的那部分**不能**跟着蒸发。

    真实事故：一段 45 行的行动表，规则逐行抽出 45 个 action，critic 报的是
    「对象缺失」；模型按意见重出一版 JSON，里面只有对象、没有 action —— 45 个
    行动就此消失，最终 OIR 里 168 行接口一个都没进去。修订的产物同样要过
    ``finalize``，规则那份才是权威。
    """

    class RuleBacked(NodeHandler):
        schema = {"type": "object",
                  "properties": {"objects": {"type": "array"},
                                 "actions": {"type": "array"}}}

        def finalize(self, draft, inputs):
            out = dict(draft or {})
            out["actions"] = [{"api_name": "createPbp"}]      # 规则抽好的
            return out

    class WantsObjects(Critic):
        name = "coverage"
        needs_llm = False

        async def judge(self, draft, ctx):
            missing = not (draft or {}).get("objects")
            return Verdict(lens=self.name, passed=not missing,
                           findings=[Finding(Severity.HIGH, "OBJECTS_MISSING", "s0",
                                             "应该能抽出对象，实际一个都没有")]
                           if missing else [])

    # 模型第一版没给对象；被打回后重出一版**只有对象**的 JSON
    backend = ScriptedBackend([(r"评审提出了下面这些问题", '{"objects":[{"api_name":"pbpHeader"}]}')],
                              default='{"objects":[]}')
    dag = Dag("t").add(NodeSpec("EXTRACT", NodeMode.SINGLE_SHOT, "x",
                                critics=("coverage",), critic_rounds=2))
    sched, rec, journal, blobs = _harness(dag, {"x": RuleBacked()}, backend=backend)
    sched.loop.panel = CriticPanel({"coverage": WantsObjects()}, rec)

    out = await sched.run("r1")
    assert out.ok
    got = out.outputs["EXTRACT"]
    assert [o["api_name"] for o in got["objects"]] == ["pbpHeader"], "修订产物要保留"
    assert [a["api_name"] for a in got["actions"]] == ["createPbp"], \
        "规则抽好的行动被 critic 修订环吃掉了"
