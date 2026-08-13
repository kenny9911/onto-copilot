"""把 kernel/scheduler.py 的行为导成 golden，给 TS 侧 scheduler.ts 当安全网。

scheduler.py 之前没有 golden（Python 侧的断言散在 tests/test_orchestration.py 与
tests/test_quota.py 里）。这份把那些断言背后的**真实事件流**整个导出来。

**设计：golden 里存的是"程序"而不是"输入对象"**（沿用 tools/golden/dag.py 的做法）。
每条用例给一份 DAG 描述 + 一份**脚本化的假 AgentLoop**（节点第 n 次被调用时做什么：
返回什么、抛什么、睡多久、花多少预算），两边各自用同一份脚本 replay，再比对：

    outcome（状态 / outputs / error / skipped / pending_human）
    calls（每个节点真正被调了几次 —— 「欠费不重试」就是靠这个钉住的）
    events（journal 里的完整事件流：seq / kind / node_id / ref / payload / 键序）

事件流是最值钱的部分：节点提交顺序、NODE_FAILED 的 will_retry、GATE_EVALUATED 的
decision、HUMAN_REQUESTED 里那份 metrics 的**合并键序**，全在里面，一个字都不用猜。

**非确定性的处理**：
  · `ts_ms` 整个丢掉；
  · 预算快照里的 `spent.wallclock_s` 与 `remaining_ratio` 换成占位符 —— 它们是
    真实流逝时间。其余字段（limits / tightest / level / level_label）在给定脚本下
    是确定的，照留不误；
  · `ref` 是内容寻址的 sha，两边同样的产出必然同样的 ref，不用碰；
  · **同一批结束的多个节点，Python 侧的处理顺序本身就没有定义** ——
    `asyncio.wait` 返回的是 set，迭代顺序跟对象哈希（内存地址）走。所以除了
    `same_batch_completions_have_no_defined_order` 那条专门留着钉分叉的用例，
    其余用例都用 sleep 把完成时刻错开，免得 golden 的字节跟着内存布局漂。

跑法::

    .venv/bin/python tools/golden/scheduler.py

重跑两次 shasum 必须一致。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.budget import Budget  # noqa: E402
from ontocopilot.kernel.bus.bus import AgentBus  # noqa: E402
from ontocopilot.kernel.critic import (  # noqa: E402
    Decision,
    Finding,
    Gate,
    GateResult,
    Severity,
    Verdict,
    metrics_from,
)
from ontocopilot.kernel.dag import (  # noqa: E402
    Dag,
    GateSpec,
    NodeBudget,
    NodeMode,
    NodeSpec,
)
from ontocopilot.kernel.errors import NodeFailure  # noqa: E402
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal  # noqa: E402
from ontocopilot.kernel.llm import QuotaExhausted  # noqa: E402
from ontocopilot.kernel.loop import NodeResult  # noqa: E402
from ontocopilot.kernel.recorder import Recorder  # noqa: E402
from ontocopilot.kernel.scheduler import RunStatus, Scheduler, _requirement_passes  # noqa: E402

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  脚本化的假 AgentLoop —— TS 侧要有一份等价实现
# ══════════════════════════════════════════════════════════════════
def _verdicts(op: dict[str, Any]) -> list[Verdict]:
    out: list[Verdict] = []
    for v in op.get("verdicts", ()):
        findings = [
            Finding(
                Severity(f.get("severity", "low")),
                f.get("code", "C"),
                f.get("target", "t"),
                f.get("claim", "c"),
            )
            for f in v.get("findings", ())
        ]
        out.append(Verdict(v["lens"], v["passed"], findings))
    return out


def _error(op: dict[str, Any], node_id: str) -> Exception:
    kind = op["error"]
    if kind == "NodeFailure":
        return NodeFailure(node_id, op["reason"], retryable=op.get("retryable", True))
    if kind == "QuotaExhausted":
        return QuotaExhausted(op["model"], op["detail"], status=op.get("status", 0))
    if kind == "RuntimeError":
        return RuntimeError(op["msg"])
    if kind == "ValueError":
        return ValueError(op["msg"])
    raise AssertionError(f"未知 error: {kind}")


class ScriptedLoop:
    """按脚本行事的 AgentLoop 替身。第 n 次调用取 script[min(n, len-1)]。"""

    def __init__(
        self, scripts: dict[str, list[dict[str, Any]]], budget: Budget, rec: Recorder
    ) -> None:
        self.scripts = scripts
        self.budget = budget
        self.rec = rec
        self.calls: dict[str, int] = {}

    async def run(
        self, node: NodeSpec, *, working: Any, deps: list[str], run_id: str
    ) -> NodeResult:
        n = self.calls.get(node.id, 0)
        self.calls[node.id] = n + 1
        script = self.scripts.get(node.id) or [{"do": "ok", "output": {}}]
        return await self._apply(script[min(n, len(script) - 1)], node, working, deps)

    async def _apply(
        self, op: dict[str, Any], node: NodeSpec, working: Any, deps: list[str]
    ) -> NodeResult:
        kind = op["do"]
        if kind == "sleep":
            await asyncio.sleep(op["s"])
            return await self._apply(op["then"], node, working, deps)
        if kind == "spend":
            self.budget.spend(**op["amounts"])
            return await self._apply(op["then"], node, working, deps)
        if kind == "ask_human":
            # 真 HITL 节点走的就是这条：历史里有答案直接拿，没有就抛
            # HumanInputRequired 让整个 Run 挂起
            answer = await self.rec.ask_human(node.id, op["request_id"], op["payload"])
            return NodeResult(node.id, answer)
        if kind == "count":
            inputs = working.select(deps)
            total = sum((v or {}).get("n", 0) for v in inputs.values())
            return NodeResult(node.id, {"n": total + op.get("add", 1)}, _verdicts(op))
        if kind == "ok":
            return NodeResult(node.id, op.get("output"), _verdicts(op))
        if kind == "raise":
            raise _error(op, node.id)
        raise AssertionError(f"未知 op: {kind}")


# 唯一一个「可执行的老式 Gate」用例。Gate 的判据是 Python 函数（刻意不做表达式
# 解析），没法用数据描述，所以两边各自照着这个名字造同一个对象。
LEGACY_GATES = {
    "review_count_gt0": lambda: Gate(
        "legacy",
        [("必须有评审", lambda m: m["review_count"] > 0)],
        lambda m: GateResult(Decision.ABORT, f"未过: {m['failed']}"),
    ),
}


def _gate(spec: dict[str, Any] | None) -> Any:
    if spec is None:
        return None
    if "legacy" in spec:
        return LEGACY_GATES[spec["legacy"]]()
    return GateSpec(spec["kind"], tuple(spec.get("require", ())))


def _build_dag(case: dict[str, Any]) -> Dag:
    dag = Dag(case.get("dag_name", "t"))
    for nd in case["nodes"]:
        dag.add(
            NodeSpec(
                id=nd["id"],
                mode=NodeMode(nd.get("mode", "deterministic")),
                handler=nd.get("handler", "x"),
                deps=tuple(nd.get("deps", ())),
                budget=NodeBudget(**nd["budget"]) if "budget" in nd else NodeBudget(),
                gate=_gate(nd.get("gate")),
                retries=nd.get("retries", 0),
            )
        )
    return dag.freeze()


# ══════════════════════════════════════════════════════════════════
#  用例
# ══════════════════════════════════════════════════════════════════
COUNT = [{"do": "count"}]

CASES: list[dict[str, Any]] = [
    {
        # 产出沿边流动：D 拿到 B(2) + C(2) + 1 = 5
        "name": "pipeline_flows_outputs_along_edges",
        "nodes": [
            {"id": "A", "script": COUNT},
            # B / C 的完成时刻**故意错开**：两个节点在同一批结束时，Python 的
            # `asyncio.wait` 返回的是 set，迭代顺序跟对象哈希（内存地址）走，
            # 换句话说 Python 侧那个顺序本身就不确定。见下面
            # same_batch_completions_have_no_defined_order 那条。
            {"id": "B", "deps": ["A"], "script": [{"do": "sleep", "s": 0.03, "then": {"do": "count"}}]},
            {"id": "C", "deps": ["A"], "script": [{"do": "sleep", "s": 0.01, "then": {"do": "count"}}]},
            {"id": "D", "deps": ["B", "C"], "script": COUNT},
        ],
    },
    {
        # 同一批结束的两个节点，Python 侧的处理顺序**没有定义**（set 迭代序）。
        # TS 侧是确定的结束顺序。这条用例专门留着钉这个分叉：TS 测试对它只比
        # 多重集合，另外单独断言 TS 自己的顺序是确定的。
        "name": "same_batch_completions_have_no_defined_order",
        "nodes": [
            {"id": "A", "script": COUNT},
            {"id": "B", "deps": ["A"], "script": COUNT},
            {"id": "C", "deps": ["A"], "script": COUNT},
        ],
    },
    {
        "name": "retry_then_succeed",
        "nodes": [
            {
                "id": "A",
                "retries": 2,
                "script": [
                    {"do": "raise", "error": "NodeFailure", "reason": "临时故障"},
                    {"do": "raise", "error": "NodeFailure", "reason": "临时故障"},
                    {"do": "count"},
                ],
            }
        ],
    },
    {
        "name": "exhausted_retries_fail_the_run",
        "nodes": [
            {
                "id": "A",
                "retries": 1,
                "script": [{"do": "raise", "error": "NodeFailure", "reason": "临时故障"}],
            }
        ],
    },
    {
        # 真实事故：欠费按可重试处理时，每个扇出分片都要再白跑一整次节点执行
        "name": "quota_exhausted_is_never_retried",
        "nodes": [
            {
                "id": "A",
                "retries": 3,
                "script": [
                    {
                        "do": "raise",
                        "error": "QuotaExhausted",
                        "model": "gw-model",
                        "detail": "insufficient_user_quota",
                        "status": 429,
                    }
                ],
            }
        ],
    },
    {
        # retryable=False 的节点失败同样一次定案（欠费那条的兄弟路径）
        "name": "non_retryable_failure_is_not_retried",
        "nodes": [
            {
                "id": "A",
                "retries": 3,
                "script": [
                    {
                        "do": "raise",
                        "error": "NodeFailure",
                        "reason": "schema 校验不过",
                        "retryable": False,
                    }
                ],
            }
        ],
    },
    {
        # 通配依赖：EXTRACT 等齐两个 PARSE 分片，且 working.select 的 `.*`
        # 语义（TS 侧 FallbackWorkingSet 是重写的一份，正需要被钉住）
        "name": "wildcard_deps_form_a_barrier",
        "nodes": [
            {"id": "PARSE.f1", "script": [{"do": "sleep", "s": 0.03, "then": {"do": "count", "add": 2}}]},
            {"id": "PARSE.f2", "script": [{"do": "count", "add": 3}]},
            {"id": "EXTRACT", "deps": ["PARSE.*"], "script": COUNT},
        ],
    },
    {
        # 对照组：普通失败照常用满 retries。上一条不能靠"把重试关掉"来通过。
        "name": "normal_failure_still_uses_its_retries",
        "nodes": [
            {
                "id": "A",
                "retries": 3,
                "script": [{"do": "raise", "error": "RuntimeError", "msg": "上游 502"}],
            }
        ],
    },
    {
        "name": "node_wallclock_is_a_hard_boundary",
        "nodes": [
            {
                "id": "SLOW",
                "retries": 2,
                "budget": {"wallclock_s": 0.01},
                "script": [{"do": "sleep", "s": 0.05, "then": {"do": "ok", "output": {"late": True}}}],
            }
        ],
    },
    {
        # 崩溃恢复：历史里已完成的节点整个跳过，不重跑也不重新付费
        "name": "completed_nodes_are_restored_not_rerun",
        "nodes": [
            {"id": "A", "script": COUNT},
            {"id": "B", "deps": ["A"], "script": COUNT},
            {"id": "C", "deps": ["B"], "script": COUNT},
        ],
        "history": [
            {"op": "complete", "node": "A", "output": {"n": 1}},
            {"op": "complete", "node": "B", "output": {"n": 2}},
        ],
    },
    {
        "name": "seed_lands_in_outputs",
        "nodes": [{"id": "A", "script": COUNT}],
        "seed": {"MATERIALS": {"n": 7}},
    },
    {
        "name": "auto_gate_passes",
        "nodes": [
            {
                "id": "A",
                "gate": {"kind": "auto", "require": ["all_passed == true", "high_findings < 1"]},
                "script": [{"do": "count", "verdicts": [{"lens": "schema", "passed": True}]}],
            }
        ],
    },
    {
        # 门不过 → 产出到不了 complete_node，下游 B 一次都不会起
        "name": "auto_gate_blocks_downstream",
        "nodes": [
            {
                "id": "A",
                "gate": {"kind": "auto", "require": ["schema.passed == false"]},
                "script": [{"do": "count", "verdicts": [{"lens": "schema", "passed": True}]}],
            },
            {"id": "B", "deps": ["A"], "script": COUNT},
        ],
    },
    {
        # 领域 handler 在结构化产出里给的确定性指标也能当判据
        "name": "gate_reads_structured_output_metrics",
        "nodes": [
            {
                "id": "A",
                "gate": {"kind": "auto", "require": ["completeness.required_fill_rate >= 0.95"]},
                "script": [
                    {"do": "ok", "output": {"completeness": {"required_fill_rate": 0.68}}}
                ],
            }
        ],
    },
    {
        "name": "hitl_gate_suspends_the_run",
        "nodes": [
            {
                "id": "A",
                "gate": {"kind": "hitl"},
                "script": [
                    {
                        "do": "ok",
                        "output": {"draft": "「计划金额」两个口径"},
                        "verdicts": [
                            {
                                "lens": "schema",
                                "passed": False,
                                "findings": [{"severity": "high", "code": "BAD"}],
                            }
                        ],
                    }
                ],
            }
        ],
    },
    {
        "name": "hitl_gate_commits_after_approval",
        "nodes": [{"id": "A", "gate": {"kind": "hitl"}, "script": COUNT}],
        "history": [
            {"op": "human", "node": "A", "request_id": "A:gate", "answer": {"decision": "pass"}}
        ],
    },
    {
        # revise 是**可重试**的失败：节点会用满 retries 再定案
        "name": "hitl_gate_revise_is_retryable",
        "nodes": [{"id": "A", "retries": 1, "gate": {"kind": "hitl"}, "script": COUNT}],
        "history": [
            {"op": "human", "node": "A", "request_id": "A:gate", "answer": {"decision": "revise"}}
        ],
    },
    {
        "name": "hitl_gate_rejects_invalid_decision",
        "nodes": [{"id": "A", "gate": {"kind": "hitl"}, "script": COUNT}],
        "history": [
            {"op": "human", "node": "A", "request_id": "A:gate", "answer": {"decision": "什么"}}
        ],
    },
    {
        "name": "legacy_runtime_gate_still_works",
        "nodes": [{"id": "A", "gate": {"legacy": "review_count_gt0"}, "script": COUNT}],
    },
    {
        # 降级必须对用户可见：事件 + 广播（广播本身又落一条 MESSAGE_SENT）
        "name": "budget_degradation_is_broadcast_and_logged",
        "nodes": [
            {"id": "A", "script": COUNT},
            {"id": "B", "deps": ["A"], "script": COUNT},
        ],
        "budget": {"limits": {"tokens": 1000}, "prespend": {"tokens": 900}},
    },
    {
        # Run 级墙钟预算耗尽：下一轮调度循环开头就定案
        "name": "run_wallclock_budget_exhausts_the_run",
        "nodes": [
            {"id": "A", "script": [{"do": "spend", "amounts": {"wallclock_s": 1e9}, "then": {"do": "count"}}]},
            {"id": "B", "deps": ["A"], "script": COUNT},
        ],
    },
    {
        # HITL 节点（不是 gate）：loop 里直接 ask_human，没答案就整个 Run 挂起
        "name": "hitl_node_suspends_the_run",
        "nodes": [
            {
                "id": "CLARIFY",
                "mode": "hitl",
                "script": [
                    {
                        "do": "ask_human",
                        "request_id": "CLARIFY:hitl",
                        "payload": {"questions": ["「计划金额」两个口径怎么处理？"]},
                    }
                ],
            }
        ],
    },
    {
        "name": "hitl_node_resumes_with_the_answer",
        "nodes": [
            {
                "id": "CLARIFY",
                "mode": "hitl",
                "script": [
                    {
                        "do": "ask_human",
                        "request_id": "CLARIFY:hitl",
                        "payload": {"questions": ["「计划金额」两个口径怎么处理？"]},
                    }
                ],
            }
        ],
        "history": [
            {
                "op": "human",
                "node": "CLARIFY",
                "request_id": "CLARIFY:hitl",
                "answer": {"option_id": "split_two_properties"},
            }
        ],
    },
    {
        # 「依赖无法满足」这条分支**走不到**：冻结过的 DAG 无环、依赖必存在，
        # 所以只能把 resolve_deps 换掉才能碰到它。两边用同一个补丁，钉住的是
        # 那条消息的字节（sorted 按 code point + 元素走 repr）。
        "name": "unsatisfiable_deps_are_reported",
        "patch": "ghost_deps",
        "nodes": [{"id": "B🐍", "script": COUNT}, {"id": "A'q", "script": COUNT}],
    },
    {
        # 并发：两个独立分支同时在飞。sleep 拉开 20ms，结束顺序确定（B 先 A 后）
        "name": "independent_branches_run_concurrently",
        "nodes": [
            {"id": "A", "script": [{"do": "sleep", "s": 0.05, "then": {"do": "count"}}]},
            {"id": "B", "script": [{"do": "sleep", "s": 0.01, "then": {"do": "count"}}]},
            {"id": "C", "deps": ["A", "B"], "script": COUNT},
        ],
    },
]


# ══════════════════════════════════════════════════════════════════
#  跑一条用例
# ══════════════════════════════════════════════════════════════════
def _norm(o: Any) -> Any:
    """把预算快照里两个随真实时间变的字段换成占位符。"""
    if isinstance(o, dict):
        d = {k: _norm(v) for k, v in o.items()}
        if "remaining_ratio" in d and "spent" in d and "limits" in d:
            d["remaining_ratio"] = "<ratio>"
            if isinstance(d["spent"], dict) and "wallclock_s" in d["spent"]:
                d["spent"] = {**d["spent"], "wallclock_s": "<elapsed>"}
        return d
    if isinstance(o, list):
        return [_norm(x) for x in o]
    if isinstance(o, tuple):
        return [_norm(x) for x in o]
    return o


async def _run_case(case: dict[str, Any]) -> dict[str, Any]:
    run_id = case.get("run_id", "r1")
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()

    history = case.get("history", ())
    if history:
        seed_rec = Recorder(run_id, journal, blobs)
        for op in history:
            if op["op"] == "complete":
                seed_rec.complete_node(op["node"], op["output"])
            elif op["op"] == "human":
                seed_rec.record_human_answer(op["node"], op["request_id"], op["answer"])
            else:
                raise AssertionError(op["op"])
    rec = Recorder(run_id, journal, blobs, resume=bool(history))

    bcfg = case.get("budget", {})
    budget = Budget(**bcfg.get("limits", {}))
    if bcfg.get("prespend"):
        budget.spend(**bcfg["prespend"])

    dag = _build_dag(case)
    if case.get("patch") == "ghost_deps":
        # 实例属性遮蔽方法：冻结之后再打，且**连 topo_order 一起换成常量** ——
        # 调度器开头要用它做恢复扫描，而 topo_order 内部也会调 resolve_deps，
        # 只换 resolve_deps 的话先炸在那儿。TS 侧用同一个补丁。
        order = dag.topo_order()
        dag.topo_order = lambda: list(order)  # type: ignore[method-assign]
        dag.resolve_deps = lambda nid: ["GHOST"]  # type: ignore[method-assign]
    loop = ScriptedLoop(
        {n["id"]: n["script"] for n in case["nodes"] if "script" in n}, budget, rec
    )
    sched = Scheduler(
        dag, loop, rec, AgentBus(rec), budget, concurrency=case.get("concurrency", 8)
    )

    outcome = await sched.run(run_id, seed=case.get("seed"))

    events = []
    for ev in journal.read(run_id):
        d = ev.to_dict()
        d.pop("ts_ms", None)
        payload = d.get("payload") or {}
        events.append(
            {
                "seq": d["seq"],
                "kind": d["kind"],
                "node_id": d.get("node_id"),
                "ref": d.get("ref"),
                "payload": _norm(payload),
                # 键序单独存一份：`toEqual` 不比顺序，而 DEGRADED 的 payload 是
                # `{"level":…, "label":…, **snapshot}`，顺序本身就是被移植的行为
                "payload_keys": list(payload.keys()),
            }
        )

    return {
        "name": case["name"],
        # 输入原样带上：TS 侧 replay 的是**同一份程序**，不用在测试里手抄一遍
        "input": {k: v for k, v in case.items() if k != "name"},
        "outcome": {
            "status": str(outcome.status),
            "ok": outcome.ok,
            "outputs": _norm(outcome.outputs),
            "results": {k: _norm(v.output) for k, v in outcome.results.items()},
            "pending_human": _norm(outcome.pending_human),
            "error": outcome.error,
            "skipped": list(outcome.skipped),
            "budget": _norm(outcome.budget),
        },
        "calls": dict(sorted(loop.calls.items())),
        "events": events,
    }


# ══════════════════════════════════════════════════════════════════
#  GateSpec 断言小语言的真值表
# ══════════════════════════════════════════════════════════════════
METRIC_FIXTURES: dict[str, Any] = {
    "empty": metrics_from([]),
    "one_pass": metrics_from([Verdict("schema", True, [])]),
    "mixed": metrics_from(
        [
            Verdict("schema", True, []),
            Verdict(
                "provenance",
                False,
                [
                    Finding(Severity.HIGH, "EVIDENCE_MISSING", "t", "c"),
                    Finding(Severity.LOW, "NAMING", "t", "c"),
                ],
            ),
        ]
    ),
    # 嵌套 / 非 dict 中途节点 / 各种类型，用来钉住路径遍历与比较语义
    "nested": {
        "completeness": {"required_fill_rate": 0.68, "label": "低", "ok": False, "none": None},
        "count": 3,
        "flag": True,
        "zero": 0,
        "name": "purchasePlan",
        "items": [1, 2],
        "by_lens": {"schema": True},
        "high_by_lens": {"schema": 0},
        "findings_by_lens": {"schema": 2},
    },
}

REQ_CASES: list[tuple[str, str]] = [
    # (fixture, expression)
    ("empty", "all_passed == true"),
    ("empty", "review_count == 0"),
    ("one_pass", "all_passed == true"),
    ("one_pass", "review_count >= 1"),
    ("mixed", "all_passed == false"),
    ("mixed", "high_findings > 0"),
    ("mixed", "total_findings == 2"),
    ("mixed", "schema.passed == true"),
    ("mixed", "provenance.passed == false"),
    ("mixed", "provenance.high_findings <= 1"),
    ("mixed", "provenance.total_findings == 2"),
    ("mixed", "by_lens.schema == true"),
    ("nested", "completeness.required_fill_rate >= 0.95"),
    ("nested", "completeness.required_fill_rate > 0.5"),
    ("nested", "completeness.label == '低'"),
    ("nested", 'completeness.label != "高"'),
    ("nested", "completeness.ok == false"),
    ("nested", "completeness.none == null"),
    ("nested", "completeness.none != null"),
    ("nested", "count == 3"),
    ("nested", "count == 3.0"),
    ("nested", "count != -3"),
    ("nested", "flag == true"),
    ("nested", "flag == 1"),  # Python 的 bool 是 int 的子类
    ("nested", "flag > 0"),
    ("nested", "zero == false"),
    ("nested", "name == 'purchasePlan'"),
    ("nested", "name > 'p'"),
    ("nested", "name == 1"),
    # 大小写不敏感（正则带 re.IGNORECASE）
    ("nested", "flag == TRUE"),
    ("nested", "completeness.none == NULL"),
    # 空白：Python 的 strip 削 \x85 与 \x1c，不削
    ("nested", "  count   ==   3  "),
    ("nested", "\x85count == 3\x1c"),
    ("nested", "count\t==\n3"),
    # 报错路径
    ("nested", "count === 3"),
    ("nested", "count"),
    ("nested", "nope == 1"),
    ("nested", "completeness.nope == 1"),
    ("nested", "count.deeper == 1"),
    ("nested", "name >= 1"),
    ("nested", "completeness.none >= 0"),
    ("nested", "items > 1"),
    ("nested", "completeness >= 1"),
    ("nested", "1count == 1"),
    ("nested", "count == 'unterminated"),
    # BOM 不是 Python 的空白：strip 不削它，于是整条表达式不合法。
    # 这条是给 TS 侧的陷阱题 —— `.trim()` 会把 BOM 削掉，然后表达式就"过了"。
    ("nested", "count == 3﻿"),
    # 零宽空格同理，两边都不算空白
    ("nested", "count ​== 3"),
]

# Python 的 `\d` 在 str 模式下是 Unicode 的：阿拉伯-印度数字既能过正则、
# `int()` 也认；JS 的 `\d`（带 u 标志）只有 ASCII。补 `\p{Nd}` 只会让正则过、
# `Number()` 给 NaN —— 错得更隐蔽，所以这条分叉留着并显式钉住。
DIVERGENT: list[tuple[str, str]] = [
    ("nested", "count == ٣"),
]


def _req_snapshot(fixture: str, expr: str) -> dict[str, Any]:
    try:
        return {"fixture": fixture, "expr": expr, "result": _requirement_passes(expr, METRIC_FIXTURES[fixture])}
    except NodeFailure as exc:
        return {
            "fixture": fixture,
            "expr": expr,
            "error": str(exc),
            "retryable": exc.retryable,
        }


def main() -> None:
    cases = [asyncio.run(_run_case(c)) for c in CASES]
    payload = {
        "_": "由 tools/golden/scheduler.py 生成。见该文件头部关于'程序而非对象'的说明。",
        "run_status": {k: str(v) for k, v in RunStatus.__members__.items()},
        "metric_fixtures": METRIC_FIXTURES,
        "requirements": [_req_snapshot(f, e) for f, e in REQ_CASES],
        "known_divergences": [_req_snapshot(f, e) for f, e in DIVERGENT],
        "cases": cases,
    }
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "scheduler.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  scheduler.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    main()
