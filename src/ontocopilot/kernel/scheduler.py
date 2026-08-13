"""DAG 调度器 —— 依赖一就绪就开跑，不搞人为的阶段屏障。

**流水线是默认，屏障是例外**：节点依赖具体上游就是流水线（某个文件解析慢不
阻塞其它文件的抽取），依赖 ``EXTRACT.*`` 通配才形成同步屏障。整份 DAG 里真正
需要等齐的只有两处 —— 实体对齐（要全局视野才能聚类）和澄清排序（要看到全部
冲突才能选 top-3）。

崩溃恢复是两级的：历史里有 ``NODE_COMPLETED`` 的节点整个跳过；崩在半路的节点
重跑，但它已完成的 effect 从日志读回（见 :mod:`.recorder`）。
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .budget import Budget, DegradeLevel
from .bus.bus import AgentBus
from .critic import Decision, Gate, GateResult, metrics_from
from .dag import Dag, GateSpec
from .errors import BudgetExhausted, HumanInputRequired, NodeFailure
from .events import EventKind
from .llm import QuotaExhausted
from .loop import AgentLoop, NodeResult
from .memory.short_term import WorkingSet
from .recorder import Recorder


class RunStatus(StrEnum):
    COMPLETED = "completed"
    SUSPENDED = "suspended"  # 等人工决策
    FAILED = "failed"


@dataclass(slots=True)
class RunOutcome:
    status: RunStatus
    outputs: dict[str, Any] = field(default_factory=dict)
    results: dict[str, NodeResult] = field(default_factory=dict)
    pending_human: dict[str, Any] | None = None
    error: str = ""
    skipped: list[str] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status is RunStatus.COMPLETED


class Scheduler:
    """执行一个已冻结的 DAG。

    Args:
        concurrency: 并发节点数上限。默认 8 —— 再高通常是被模型端限流卡住，
            而不是被本地 CPU 卡住。
    """

    def __init__(
        self,
        dag: Dag,
        loop: AgentLoop,
        recorder: Recorder,
        bus: AgentBus,
        budget: Budget,
        *,
        concurrency: int = 8,
    ) -> None:
        if not dag.frozen:
            raise RuntimeError(
                "DAG 未冻结就交给调度器执行。冻结是安全边界 —— "
                "必须在读取任何材料内容之前完成（见架构文档 §4.5.1）。"
            )
        self.dag = dag
        self.loop = loop
        self.rec = recorder
        self.bus = bus
        self.budget = budget
        self.sem = asyncio.Semaphore(concurrency)
        self._level = DegradeLevel.NONE
        self._run_deadline: float | None = None
        self._wallclock_mark: float | None = None

    async def run(self, run_id: str, *, seed: dict[str, Any] | None = None) -> RunOutcome:
        clock = asyncio.get_running_loop().time
        self._wallclock_mark = clock()
        self._run_deadline = self._wallclock_mark + self.budget.remaining("wallclock_s")
        self.rec.emit(EventKind.RUN_STARTED, payload={"dag": self.dag.name})
        working = WorkingSet()
        for k, v in (seed or {}).items():
            working.put(k, v)

        results: dict[str, NodeResult] = {}
        skipped: list[str] = []
        done: set[str] = set(seed or ())
        pending = {n for n in self.dag.nodes}
        running: dict[asyncio.Task, str] = {}

        # 先把历史里已完成的节点恢复出来，不重跑也不重新付费
        for nid in self.dag.topo_order():
            if self.rec.node_is_complete(nid):
                working.put(nid, self.rec.node_output(nid))
                done.add(nid)
                pending.discard(nid)
                skipped.append(nid)
        if skipped:
            self.rec.emit(EventKind.RUN_RESUMED, payload={"restored": skipped})

        while pending or running:
            self._account_wallclock()
            try:
                self.budget.check("wallclock_s")
            except BudgetExhausted as exc:
                for task in running:
                    task.cancel()
                return self._fail(results, skipped, str(exc))
            self._maybe_degrade()

            ready = sorted(
                n for n in pending if set(self.dag.resolve_deps(n)) <= done
            )
            for nid in ready:
                pending.discard(nid)
                running[asyncio.create_task(self._run_node(nid, working, run_id))] = nid

            if not running:
                stuck = sorted(pending)
                return self._fail(results, skipped, f"依赖无法满足，卡住的节点: {stuck}")

            finished, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
            self._account_wallclock()
            for task in finished:
                nid = running.pop(task)
                try:
                    res = task.result()
                except HumanInputRequired as hitl:
                    for t in running:
                        t.cancel()
                    self.rec.emit(
                        EventKind.RUN_SUSPENDED,
                        payload={"node": hitl.node_id, "request_id": hitl.request_id},
                    )
                    return RunOutcome(
                        status=RunStatus.SUSPENDED, outputs=dict(working.outputs),
                        results=results, skipped=skipped,
                        pending_human={"node": hitl.node_id, "request_id": hitl.request_id,
                                       **hitl.payload},
                        budget=self.budget.snapshot(),
                    )
                except (NodeFailure, BudgetExhausted) as exc:
                    for t in running:
                        t.cancel()
                    return self._fail(results, skipped, str(exc))

                results[nid] = res
                working.put(nid, res.output, res.digest)
                self.rec.complete_node(nid, res.output)
                done.add(nid)

        self.rec.emit(
            EventKind.RUN_COMPLETED,
            payload={"nodes": len(results), "restored": len(skipped),
                     "budget": self.budget.snapshot()},
        )
        return RunOutcome(
            status=RunStatus.COMPLETED, outputs=dict(working.outputs),
            results=results, skipped=skipped, budget=self.budget.snapshot(),
        )

    # ── 单节点 ──────────────────────────────────────────────────
    async def _run_node(self, nid: str, working: WorkingSet, run_id: str) -> NodeResult:
        spec = self.dag[nid]
        deps = self.dag.resolve_deps(nid)
        last: Exception | None = None
        clock = asyncio.get_running_loop().time
        node_deadline = clock() + spec.budget.wallclock_s

        async with self.sem:
            for attempt in range(spec.retries + 1):
                try:
                    remaining = node_deadline - clock()
                    if self._run_deadline is not None:
                        remaining = min(remaining, self._run_deadline - clock())
                    if remaining <= 0:
                        raise TimeoutError
                    async with asyncio.timeout(remaining):
                        result = await self.loop.run(
                            spec,
                            working=working,
                            deps=deps,
                            run_id=run_id,
                        )
                        await self._apply_gate(nid, result)
                    return result
                except TimeoutError:
                    last = NodeFailure(
                        nid,
                        f"超过节点墙钟上限 {spec.budget.wallclock_s}s",
                        retryable=False,
                    )
                    break
                except HumanInputRequired:
                    raise  # 不是失败，是等人 —— 直接上抛让 Run 挂起
                except QuotaExhausted as exc:
                    # 网关账户没钱了。这不是"这次不巧"，重跑多少遍都一样，所以
                    # **一次都不重试**就定案。代价不是几秒退避：EXTRACT 是按
                    # segment 扇出的贵活（onto/pipeline.py 里 retries=1），走到
                    # 下面那条 `except Exception` 的话，每个分片都要再白跑一整次
                    # 节点执行 —— 用户为一个必然失败的结果多等好几分钟。
                    # 不能像 HumanInputRequired 那样裸 raise：外层只接
                    # NodeFailure / BudgetExhausted，裸抛会直接穿透 RunOutcome 契约。
                    last = exc
                    break
                except NodeFailure as exc:
                    last = exc
                    if not exc.retryable or attempt >= spec.retries:
                        break
                except Exception as exc:  # noqa: BLE001 — 记账后统一转成 NodeFailure
                    last = exc
                    if attempt >= spec.retries:
                        break
                self.rec.emit(
                    EventKind.NODE_FAILED, node_id=nid,
                    payload={"attempt": attempt, "error": f"{type(last).__name__}: {last}",
                             "will_retry": attempt < spec.retries},
                )

        # `from last` 把真异常挂进异常链。**上层判"是不是欠费"要靠它** ——
        # 光看这条消息文本是靠不住的（异常类型名会被 str 掉，见 server 侧的
        # `_signal_of`：类型优先、文本兜底，而文本兜底之所以还必须留着，是因为
        # RunOutcome.error 到最后只剩一个字符串，链在那儿就断了）。
        raise NodeFailure(nid, f"{type(last).__name__}: {last}", retryable=False) from last

    def _account_wallclock(self) -> None:
        """Charge real elapsed run time once, regardless of node concurrency."""
        if self._wallclock_mark is None:
            return
        now = asyncio.get_running_loop().time()
        elapsed = max(0.0, now - self._wallclock_mark)
        if elapsed:
            self.budget.spend(wallclock_s=elapsed)
        self._wallclock_mark = now

    # ── 质量门 ──────────────────────────────────────────────────
    async def _apply_gate(self, nid: str, result: NodeResult) -> None:
        """Evaluate a node gate immediately before committing its output.

        ``NodeSpec.gate`` is the serializable :class:`GateSpec`; older callers also
        passed the executable :class:`Gate` directly.  Supporting both here closes the
        historical type split without breaking those callers.  A non-PASS result never
        reaches ``complete_node`` or any downstream node.
        """
        gate = self.dag[nid].gate
        if gate is None:
            return

        metrics = metrics_from(result.verdicts)
        if isinstance(result.output, dict):
            # Domain handlers may expose deterministic quality measurements in their
            # structured output (for example ``completeness.required_fill_rate``).
            # Make those paths available while reserving the kernel's review keys.
            domain_metrics = {
                key: value for key, value in result.output.items() if key not in metrics
            }
            metrics = {**domain_metrics, **metrics, "output": result.output}
        if isinstance(gate, Gate):
            decision = gate.evaluate(metrics, self.rec, nid)
            await self._enforce_gate_decision(nid, gate.name, decision, result)
            return

        if not isinstance(gate, GateSpec):
            raise NodeFailure(nid, f"不支持的 gate 配置: {type(gate).__name__}", retryable=False)

        kind = gate.kind.strip().lower()
        if kind not in {"auto", "hitl"}:
            raise NodeFailure(nid, f"未知 gate kind: {gate.kind!r}", retryable=False)

        failed = [
            expr
            for expr in gate.require
            if not _requirement_passes(expr, metrics, node_id=nid)
        ]
        if kind == "auto":
            decision = GateResult(
                Decision.PASS if not failed else Decision.ABORT,
                "全部硬门通过" if not failed else f"未通过: {failed}",
                {"failed": failed},
            )
            _emit_gate(self.rec, nid, "auto", decision, failed)
            await self._enforce_gate_decision(nid, "auto", decision, result)
            return

        request_id = f"{nid}:gate"
        answer = await self.rec.ask_human(
            nid,
            request_id,
            {
                "kind": "gate",
                "gate": "hitl",
                "failed": failed,
                "metrics": metrics,
                "output": result.output,
                "actions": ["pass", "revise", "abort"],
            },
        )
        choice = str((answer or {}).get("decision", "")).strip().lower()
        mapped = {
            "pass": Decision.PASS,
            "approve": Decision.PASS,
            "revise": Decision.REVISE,
            "abort": Decision.ABORT,
            "round_trip": Decision.ROUND_TRIP,
        }.get(choice)
        if mapped is None:
            raise NodeFailure(nid, f"HITL gate 收到无效决策: {choice!r}", retryable=False)
        decision = GateResult(mapped, f"人工决策: {choice}", {"failed": failed})
        _emit_gate(self.rec, nid, "hitl", decision, failed)
        await self._enforce_gate_decision(nid, "hitl", decision, result)

    async def _enforce_gate_decision(
        self,
        nid: str,
        name: str,
        result: GateResult,
        node_result: NodeResult,
    ) -> None:
        if result.decision is Decision.PASS:
            return
        if result.decision is Decision.ASK_USER:
            request_id = f"{nid}:gate"
            answer = await self.rec.ask_human(
                nid,
                request_id,
                {
                    "kind": "gate",
                    "gate": name,
                    "reason": result.reason,
                    "detail": result.detail,
                    "output": node_result.output,
                    "actions": ["pass", "revise", "abort"],
                },
            )
            choice = str((answer or {}).get("decision", "")).strip().lower()
            if choice in {"pass", "approve"}:
                _emit_gate(
                    self.rec,
                    nid,
                    name,
                    GateResult(Decision.PASS, "人工决策: pass", result.detail),
                    list(result.detail.get("failed", ())),
                )
                return
            retryable = choice == "revise"
            final = Decision.REVISE if retryable else Decision.ABORT
            _emit_gate(
                self.rec,
                nid,
                name,
                GateResult(final, f"人工决策: {choice or '无效'}", result.detail),
                list(result.detail.get("failed", ())),
            )
            raise NodeFailure(nid, f"质量门「{name}」人工决策: {choice or '无效'}", retryable=retryable)
        if result.decision in {Decision.REVISE, Decision.AUTO_REPAIR}:
            raise NodeFailure(nid, f"质量门「{name}」要求重做：{result.reason}", retryable=True)
        raise NodeFailure(nid, f"质量门「{name}」未通过：{result.reason}", retryable=False)

    # ── 降级 ────────────────────────────────────────────────────
    def _maybe_degrade(self) -> None:
        """预算降级必须对用户可见 —— 悄悄降级再交付未审产物比失败更糟。"""
        lvl = self.budget.level
        if lvl <= self._level:
            return
        self._level = lvl
        self.rec.emit(
            EventKind.DEGRADED,
            payload={"level": int(lvl), "label": lvl.label, **self.budget.snapshot()},
        )
        self.bus.broadcast(
            frm="scheduler", topic="budget/degrade",
            payload={"level": int(lvl), "label": lvl.label},
        )

    def _fail(self, results: dict, skipped: list[str], msg: str) -> RunOutcome:
        self.rec.emit(EventKind.RUN_FAILED, payload={"error": msg})
        return RunOutcome(
            status=RunStatus.FAILED, results=results, skipped=skipped,
            error=msg, budget=self.budget.snapshot(),
        )


_REQ_RE = re.compile(
    r"^(?P<path>[A-Za-z_][A-Za-z0-9_.-]*)\s*"
    r"(?P<op>==|!=|>=|<=|>|<)\s*"
    r"(?P<value>true|false|null|-?\d+(?:\.\d+)?|'[^']*'|\"[^\"]*\")$",
    re.IGNORECASE,
)


def _requirement_passes(
    expression: str,
    metrics: dict[str, Any],
    *,
    node_id: str = "gate",
) -> bool:
    """Evaluate the deliberately small, non-executable GateSpec assertion language."""
    match = _REQ_RE.fullmatch(expression.strip())
    if match is None:
        raise NodeFailure(
            node_id,
            f"不支持的 gate require 表达式: {expression!r}",
            retryable=False,
        )

    path = match.group("path")
    parts = path.split(".")
    left: Any = metrics
    if parts[0] not in metrics and parts[0] in metrics.get("by_lens", {}):
        lens = parts.pop(0)
        left = {
            "passed": metrics["by_lens"][lens],
            "high_findings": metrics["high_by_lens"][lens],
            "total_findings": metrics["findings_by_lens"][lens],
        }
    for part in parts:
        if not isinstance(left, dict) or part not in left:
            raise NodeFailure(
                node_id,
                f"gate require 引用未知指标: {path!r}",
                retryable=False,
            )
        left = left[part]

    raw = match.group("value")
    folded = raw.lower()
    if folded == "true":
        right: Any = True
    elif folded == "false":
        right = False
    elif folded == "null":
        right = None
    elif raw[:1] in {'"', "'"}:
        right = raw[1:-1]
    else:
        right = float(raw) if "." in raw else int(raw)

    op = match.group("op")
    try:
        return {
            "==": lambda: left == right,
            "!=": lambda: left != right,
            ">=": lambda: left >= right,
            "<=": lambda: left <= right,
            ">": lambda: left > right,
            "<": lambda: left < right,
        }[op]()
    except TypeError as exc:
        raise NodeFailure(
            node_id,
            f"gate require 类型不可比较: {expression!r}",
            retryable=False,
        ) from exc


def _emit_gate(
    rec: Recorder,
    node_id: str,
    name: str,
    result: GateResult,
    failed: list[str],
) -> None:
    rec.emit(
        EventKind.GATE_EVALUATED,
        node_id=node_id,
        payload={
            "gate": name,
            "decision": str(result.decision),
            "reason": result.reason,
            "failed": failed,
        },
    )
