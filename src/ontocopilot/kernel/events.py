"""事件模型 —— 内核里发生的一切都是事件。

三个用途，一套数据：
  1. **持久化执行**：崩溃后按事件重放到崩溃点，不重跑已完成的节点，也不重新
     为已完成的 LLM 调用付费。
  2. **可观测**：UI 的推理轨迹是事件流的投影，零额外埋点。
  3. **回归测试**：录真实 Run 的事件当 fixture，改代码后重放验证行为不变。

纪律（见架构文档 §4.7）：LLM 与工具调用的结果**首次执行时写入日志，重放时
直接读回**。事件本身只存小 payload，大内容（完整响应、代码输出、切片）进
BlobStore，事件里放 content_ref。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EventKind(StrEnum):
    # ── Run 生命周期 ──
    RUN_STARTED = "run.started"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_SUSPENDED = "run.suspended"  # 等人工决策
    RUN_RESUMED = "run.resumed"

    # ── 节点 ──
    NODE_ENTERED = "node.entered"
    NODE_COMPLETED = "node.completed"
    NODE_FAILED = "node.failed"
    NODE_SKIPPED = "node.skipped"

    # ── Agent Loop 内部（→ UI 推理轨迹）──
    PLAN_CREATED = "trace.plan"
    PLAN_REVISED = "trace.plan_revised"
    THOUGHT = "trace.thought"
    OBSERVATION = "trace.observation"

    # ── Effect：一切非确定性的东西 ──
    EFFECT_REQUESTED = "effect.requested"
    EFFECT_COMPLETED = "effect.completed"
    EFFECT_FAILED = "effect.failed"

    # ── 评审 ──
    CRITIC_VERDICT = "critic.verdict"
    GATE_EVALUATED = "gate.evaluated"

    # ── 人在环 ──
    HUMAN_REQUESTED = "human.requested"
    HUMAN_RECORDED = "human.recorded"

    # ── Agent 间通信 ──
    BLACKBOARD_WRITE = "bus.blackboard_write"
    MESSAGE_SENT = "bus.message"

    # ── 记忆 ──
    MEMORY_PROMOTED = "memory.promoted"  # 短期 → 长期
    MEMORY_EVICTED = "memory.evicted"
    CONTEXT_COMPACTED = "memory.compacted"

    # ── 预算 ──
    BUDGET_SPENT = "budget.spent"
    DEGRADED = "budget.degraded"


#: 重放时用于恢复 effect 结果的事件类型。
REPLAYABLE = frozenset({EventKind.EFFECT_COMPLETED, EventKind.HUMAN_RECORDED})


@dataclass(frozen=True, slots=True)
class Event:
    """一条不可变的事件记录。

    ``seq`` 在 Run 内单调递增，是日志的规范顺序。``ts_ms`` 只用于展示和
    排障 —— **工作流逻辑绝不能读它**，否则重放会产生不同结果。
    """

    run_id: str
    seq: int
    kind: EventKind
    node_id: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    ref: str | None = None  # 大内容的 BlobStore 引用
    ts_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "run_id": self.run_id,
            "seq": self.seq,
            "kind": str(self.kind),
            "ts_ms": self.ts_ms,
        }
        if self.node_id is not None:
            d["node_id"] = self.node_id
        if self.payload:
            d["payload"] = self.payload
        if self.ref is not None:
            d["ref"] = self.ref
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Event:
        return cls(
            run_id=d["run_id"],
            seq=d["seq"],
            kind=EventKind(d["kind"]),
            node_id=d.get("node_id"),
            payload=d.get("payload") or {},
            ref=d.get("ref"),
            ts_ms=d.get("ts_ms", 0),
        )


def now_ms() -> int:
    """墙钟毫秒。**只允许事件记录用**，业务逻辑要时间必须走 Recorder.now()。"""
    return int(time.time() * 1000)
