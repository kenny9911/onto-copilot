"""AgentBus —— agent 之间的三种通信方式，全部记账。

本内核里 agent 之间**只有三条合法通路**，没有自由对话：

  1. **DAG 边**（主通路）—— 上游节点的结构化产出流向下游。由 WorkingSet 承载，
     不经过本模块。这是绝大多数通信应该走的路。

  2. **黑板**（旁路事实）—— 很多节点都要、但不在直接路径上的共享事实。
     append-only、带出处、冲突不覆盖。见 :mod:`.blackboard`。

  3. **定向请求 / 广播**（本模块）—— 需要即时往返的场景：Critic 要求 Actor 为
     某个断言举证；调度器广播降级信号。

三者都写事件日志，所以整条协作链路可重放、可审计、可在 UI 上展开。

**为什么要这么克制。** 让 agent 自由聊天在 demo 里很好看，在生产上会同时坏掉
三件事：消息顺序不确定 → 重放失效；上下文无界增长 → 成本失控；事后无法回答
"谁认定了这件事" → 交付物不可辩护。对 FDE 场景来说第三条是致命的。
"""

from __future__ import annotations

import fnmatch
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..errors import HarnessError
from ..events import EventKind
from ..ids import fingerprint
from ..recorder import Recorder
from .blackboard import Blackboard, Revision


class BusError(HarnessError):
    """通信错误：收件人未注册、消息类型未声明。"""


@dataclass(frozen=True, slots=True)
class Message:
    """消息信封。"""

    frm: str
    to: str  # 定向请求的收件人；广播时是 topic
    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
    reply_to: str | None = None


#: 定向请求处理器。
Handler = Callable[[Message], Any | Awaitable[Any]]
#: 广播订阅者。**必须无副作用地处理**（只更新本地状态），否则会破坏重放。
Subscriber = Callable[[Message], None]


class AgentBus:
    """把黑板、定向请求、广播统一到一个入口，并全部接到事件日志上。"""

    def __init__(self, recorder: Recorder, blackboard: Blackboard | None = None) -> None:
        self.rec = recorder
        # 注意 `is None` 而不是 `or` —— Blackboard 定义了 __len__，空黑板是 falsy，
        # 用 `or` 会把调用方传进来的共享黑板悄悄替换成一个新的空黑板。
        self.board = Blackboard() if blackboard is None else blackboard
        self._handlers: dict[str, Handler] = {}
        self._subs: list[tuple[str, Subscriber]] = []

    # ══════════════════════════════════════════════════════════
    #  黑板
    # ══════════════════════════════════════════════════════════
    def post(
        self,
        key: str,
        value: Any,
        *,
        by: str,
        support: tuple[str, ...] | list[str] = (),
        confidence: float = 0.5,
        note: str = "",
    ) -> tuple[Revision, bool]:
        """写黑板并记事件。

        Returns:
            ``(revision, newly_contested)``。新产生分歧时事件里带
            ``contested=True``，调度器据此把这个 key 推进冲突队列。
        """
        rev, newly = self.board.write(
            key, value, by=by, support=support, confidence=confidence, note=note
        )
        self.rec.emit(
            EventKind.BLACKBOARD_WRITE,
            node_id=by,
            payload={**rev.to_dict(), "contested": newly},
        )
        return rev, newly

    def read(self, key: str, default: Any = None) -> Any:
        return self.board.read(key, default)

    def contested(self):
        return self.board.contested()

    def restore_board(self) -> int:
        """从事件日志重建黑板。恢复 Run 时调用一次。"""
        revs = [
            ev.payload
            for ev in self.rec.journal.read(self.rec.run_id)
            if ev.kind is EventKind.BLACKBOARD_WRITE
        ]
        self.board = Blackboard()
        self.board.replay(revs)
        return len(revs)

    # ══════════════════════════════════════════════════════════
    #  定向请求 / 响应
    # ══════════════════════════════════════════════════════════
    def register(self, name: str, handler: Handler) -> None:
        """注册一个可被定向请求的 agent。"""
        self._handlers[name] = handler

    async def request(
        self,
        *,
        frm: str,
        to: str,
        kind: str,
        payload: dict[str, Any] | None = None,
        key: str | None = None,
    ) -> Any:
        """向另一个 agent 发起请求并等待回复。

        典型用途：Critic 发现某个断言可疑，请 Actor 为它举证（CRITIC 那篇论文
        的"工具交互式批判"在多 agent 下的形态）。

        走 :meth:`Recorder.effect`，所以重放时直接读回历史回复，不会二次调用
        对方（对方内部可能是个昂贵的 LLM 调用）。

        Args:
            key: 同一节点内并发发多个请求时必须给，否则计数器顺序不稳定。
        """
        handler = self._handlers.get(to)
        if handler is None:
            raise BusError(f"收件人未注册: {to!r}（已注册: {sorted(self._handlers)}）")

        msg = Message(frm=frm, to=to, kind=kind, payload=payload or {})
        req = {"to": to, "kind": kind, "payload": payload or {}}
        ekey = key or f"msg:{to}:{kind}:{fingerprint(req)}"

        self.rec.emit(
            EventKind.MESSAGE_SENT,
            node_id=frm,
            payload={"to": to, "kind": kind, "mode": "request"},
        )

        async def call() -> Any:
            out = handler(msg)
            if hasattr(out, "__await__"):
                out = await out
            return out

        return await self.rec.effect(frm, "bus.request", req, call, key=ekey)

    # ══════════════════════════════════════════════════════════
    #  广播
    # ══════════════════════════════════════════════════════════
    def subscribe(self, topic_pattern: str, sub: Subscriber) -> None:
        """按 glob 订阅广播。

        订阅者**必须无副作用**（只改本地状态，不调外部服务、不产生新 effect），
        否则重放时会产生不一致。需要副作用的场景请走定向请求。
        """
        self._subs.append((topic_pattern, sub))

    def broadcast(self, *, frm: str, topic: str, payload: dict[str, Any] | None = None) -> int:
        """广播控制信号或事实通告。无回复。

        用于降级通知、取消信号、"我发现了一个新术语"这类通告。
        """
        msg = Message(frm=frm, to=topic, kind="broadcast", payload=payload or {})
        n = 0
        for pattern, sub in self._subs:
            if fnmatch.fnmatchcase(topic, pattern):
                sub(msg)
                n += 1
        self.rec.emit(
            EventKind.MESSAGE_SENT,
            node_id=frm,
            payload={"topic": topic, "mode": "broadcast", "receivers": n, **(payload or {})},
        )
        return n

    # ══════════════════════════════════════════════════════════
    #  渲染
    # ══════════════════════════════════════════════════════════
    def render_facts(self, pattern: str = "*") -> str:
        """黑板事实的 prompt 形态，装进 L1 working 层。"""
        return self.board.render(pattern)
