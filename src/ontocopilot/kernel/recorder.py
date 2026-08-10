"""Recorder —— 持久化执行的核心。

**规则**：工作流代码必须是确定性的；一切非确定性（LLM 调用、工具调用、时间、
随机、网络）都必须包在 ``effect()`` 里。首次执行时结果写入日志，重放时直接
读回，不重新调用、不重新付费。

恢复粒度是两级：

  1. **节点级** —— 历史里有 ``NODE_COMPLETED`` 的节点整个跳过，直接恢复产出。
  2. **effect 级** —— 崩在半路的节点会重跑，但它已完成的 effect 从历史读回。
     所以第 47 轮崩溃是从第 47 轮继续，不是从头。

effect 的键是 ``(node_id, 序号)``，**不是全局 seq** —— 并行节点的全局顺序在两
次运行间不保证一致，按节点命名空间才稳定。节点内如果有并发 effect（比如四个
critic 视角同时跑），调用方必须显式传 ``key``，否则计数器顺序不稳。
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from .errors import DeterminismViolation, HumanInputRequired
from .events import Event, EventKind, now_ms
from .ids import fingerprint
from .journal import BlobStore, Journal

#: payload 超过这个字节数就落 BlobStore，事件里只留 ref。
INLINE_LIMIT = 2048


class Recorder:
    """一个 Run 的事件记录器 + 重放器。"""

    def __init__(
        self,
        run_id: str,
        journal: Journal,
        blobs: BlobStore,
        *,
        resume: bool = False,
    ) -> None:
        self.run_id = run_id
        self.journal = journal
        self.blobs = blobs

        self._seq = 0
        self._lock = asyncio.Lock()
        self._counters: dict[str, int] = {}  # node_id → 下一个 effect 序号

        # 重放索引
        self._effects: dict[str, dict[str, Any]] = {}  # effect key → {fp, ref, inline}
        self._completed_nodes: dict[str, str | None] = {}  # node_id → 产出 ref
        self._humans: dict[str, Any] = {}  # request_id → 答案
        self._attempts: dict[str, int] = {}  # node_id → 已尝试次数

        if resume:
            self._load_history()

    # ── 历史加载 ─────────────────────────────────────────────────
    def _load_history(self) -> None:
        for ev in self.journal.read(self.run_id):
            self._seq = max(self._seq, ev.seq + 1)
            match ev.kind:
                case EventKind.EFFECT_COMPLETED:
                    key = ev.payload["key"]
                    # 只认第一次记录：同 key 的重复写入意味着重试，应复用首次结果
                    self._effects.setdefault(
                        key,
                        {"fp": ev.payload["fp"], "ref": ev.ref, "inline": ev.payload.get("result")},
                    )
                case EventKind.NODE_COMPLETED:
                    self._completed_nodes[ev.node_id or ""] = ev.ref
                case EventKind.NODE_ENTERED:
                    nid = ev.node_id or ""
                    self._attempts[nid] = max(
                        self._attempts.get(nid, 0), ev.payload.get("attempt", 0) + 1
                    )
                case EventKind.HUMAN_RECORDED:
                    self._humans[ev.payload["request_id"]] = ev.payload.get("answer")
                case _:
                    pass

    # ── 事件发射 ─────────────────────────────────────────────────
    def emit(
        self,
        kind: EventKind,
        *,
        node_id: str | None = None,
        payload: dict[str, Any] | None = None,
        ref: str | None = None,
    ) -> Event:
        seq = self._seq
        self._seq += 1
        ev = Event(
            run_id=self.run_id,
            seq=seq,
            kind=kind,
            node_id=node_id,
            payload=payload or {},
            ref=ref,
            ts_ms=now_ms(),
        )
        self.journal.append(ev)
        return ev

    def _store(self, value: Any) -> tuple[dict[str, Any] | None, str | None]:
        """小结果内联进事件，大结果落 blob。"""
        payload = {"result": value}
        try:
            import json

            size = len(json.dumps(value, ensure_ascii=False, default=str))
        except (TypeError, ValueError):
            size = INLINE_LIMIT + 1
        if size <= INLINE_LIMIT:
            return payload, None
        return None, self.blobs.put_json(value)

    def _load(self, rec: dict[str, Any]) -> Any:
        if rec.get("ref"):
            return self.blobs.get_json(rec["ref"])
        return rec.get("inline")

    # ── 节点级 checkpoint ────────────────────────────────────────
    def node_is_complete(self, node_id: str) -> bool:
        return node_id in self._completed_nodes

    def node_output(self, node_id: str) -> Any:
        ref = self._completed_nodes[node_id]
        return self.blobs.get_json(ref) if ref else None

    def next_attempt(self, node_id: str) -> int:
        n = self._attempts.get(node_id, 0)
        self._attempts[node_id] = n + 1
        return n

    def complete_node(self, node_id: str, output: Any) -> None:
        ref = self.blobs.put_json(output)
        self._completed_nodes[node_id] = ref
        self.emit(EventKind.NODE_COMPLETED, node_id=node_id, ref=ref)

    # ── effect ───────────────────────────────────────────────────
    async def effect(
        self,
        node_id: str,
        kind: str,
        request: dict[str, Any],
        fn: Callable[[], Any | Awaitable[Any]],
        *,
        key: str | None = None,
    ) -> Any:
        """执行一次非确定性动作，或从历史读回。

        Args:
            node_id: 所属节点，决定 effect 的命名空间。
            kind: 动作类型（``llm.call`` / ``tool.exec`` / ``clock.now`` …），
                只进指纹和日志，不影响调度。
            request: 请求内容。**会被指纹化**，重放时不一致即报
                :class:`DeterminismViolation`。
            fn: 真正干活的可调用对象，同步异步均可。
            key: 节点内并发 effect 必须显式传，否则计数器顺序不稳定。
        """
        async with self._lock:
            if key is None:
                idx = self._counters.get(node_id, 0)
                self._counters[node_id] = idx + 1
                ekey = f"{node_id}#{idx}"
            else:
                ekey = f"{node_id}#{key}"
            recorded = self._effects.get(ekey)

        fp = fingerprint({"kind": kind, "request": request})

        if recorded is not None:
            if recorded["fp"] != fp:
                raise DeterminismViolation(ekey, recorded["fp"], fp)
            return self._load(recorded)

        self.emit(
            EventKind.EFFECT_REQUESTED,
            node_id=node_id,
            payload={"key": ekey, "kind": kind, "fp": fp, "request": _digest(request)},
        )
        try:
            result = fn()
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:
            self.emit(
                EventKind.EFFECT_FAILED,
                node_id=node_id,
                payload={"key": ekey, "kind": kind, "error": f"{type(exc).__name__}: {exc}"},
            )
            raise

        payload, ref = self._store(result)
        payload = {**(payload or {}), "key": ekey, "kind": kind, "fp": fp}
        self.emit(EventKind.EFFECT_COMPLETED, node_id=node_id, payload=payload, ref=ref)
        async with self._lock:
            self._effects[ekey] = {"fp": fp, "ref": ref, "inline": payload.get("result")}
        return result

    # ── 确定性的时间与随机 ────────────────────────────────────────
    async def now(self, node_id: str) -> int:
        """当前毫秒时间戳。走 effect，所以重放时返回首次执行的那个时刻。"""
        return await self.effect(node_id, "clock.now", {}, now_ms)

    async def rand(self, node_id: str, n: int) -> int:
        """[0, n) 随机整数。同样记账，重放可复现。"""
        import random

        return await self.effect(node_id, "clock.rand", {"n": n}, lambda: random.randrange(n))

    # ── 人在环 ───────────────────────────────────────────────────
    async def ask_human(self, node_id: str, request_id: str, payload: dict[str, Any]) -> Any:
        """请求人工决策。

        历史里已有答案就直接返回；否则发出请求并抛
        :class:`HumanInputRequired`，由调度器挂起整个 Run。人答完后 API 把
        ``HUMAN_RECORDED`` 写进日志再重新触发，重放走到这里就能拿到答案。
        """
        if request_id in self._humans:
            return self._humans[request_id]
        self.emit(
            EventKind.HUMAN_REQUESTED,
            node_id=node_id,
            payload={"request_id": request_id, **payload},
        )
        raise HumanInputRequired(node_id, request_id, payload)

    def record_human_answer(self, node_id: str, request_id: str, answer: Any) -> None:
        """外部（API 层）写入人工决策。"""
        self._humans[request_id] = answer
        self.emit(
            EventKind.HUMAN_RECORDED,
            node_id=node_id,
            payload={"request_id": request_id, "answer": answer},
        )


def _digest(request: dict[str, Any], limit: int = 400) -> dict[str, Any]:
    """请求摘要 —— 事件日志里不存全量请求（可能是几十万 token 的 prompt），
    全量内容通过 fp 和 blob 关联。"""
    out: dict[str, Any] = {}
    for k, v in request.items():
        s = str(v)
        out[k] = s if len(s) <= limit else s[:limit] + f"…(+{len(s) - limit})"
    return out
