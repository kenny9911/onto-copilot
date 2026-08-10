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
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .budget import Budget, DegradeLevel
from .bus.bus import AgentBus
from .dag import Dag
from .errors import BudgetExhausted, HumanInputRequired, NodeFailure
from .events import EventKind
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

    async def run(self, run_id: str, *, seed: dict[str, Any] | None = None) -> RunOutcome:
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

        async with self.sem:
            for attempt in range(spec.retries + 1):
                try:
                    return await self.loop.run(spec, working=working, deps=deps, run_id=run_id)
                except HumanInputRequired:
                    raise  # 不是失败，是等人 —— 直接上抛让 Run 挂起
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

        raise NodeFailure(nid, f"{type(last).__name__}: {last}", retryable=False)

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
