"""Durable session-event publication.

``Session.emit`` is deliberately synchronous: domain code emits from callbacks and
there are many call sites where making the whole stack async would add no business
value.  Durability, however, is asynchronous.  This module bridges the two without
letting a provisional in-memory sequence escape to SSE:

* a synchronous emit appends a pending projection and enqueues one write;
* one worker per application event loop serialises writes;
* only the :class:`~ontocopilot.store.repo.EventRow` returned by the repository is
  published to subscribers;
* graceful shutdown drains the queue before the repository is closed.

The unavoidable crash window is therefore limited to events already accepted into
the process queue but not yet committed by the repository.  There is no false
"delivered but not durable" window: UI visibility happens after commit.
"""

from __future__ import annotations

import asyncio
import copy
import itertools
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol
from weakref import WeakKeyDictionary

from .store.repo import EventRow

_LOG = logging.getLogger(__name__)


class _EventRepo(Protocol):
    async def get_session(self, sid: str) -> Any | None: ...

    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any], *, event_id: str = ""
                           ) -> EventRow: ...


class _EventSession(Protocol):
    id: str
    events: list[dict[str, Any]]
    subscribers: list[asyncio.Queue]


@dataclass(slots=True)
class _Pending:
    session: _EventSession
    repo: _EventRepo
    kind: str
    payload: dict[str, Any]
    event_id: str
    projection: dict[str, Any]
    done: asyncio.Future[int]


@dataclass(slots=True)
class _LoopState:
    queue: asyncio.Queue[_Pending] = field(default_factory=asyncio.Queue)
    worker: asyncio.Task[None] | None = None
    receipts: dict[int, asyncio.Future[int]] = field(default_factory=dict)


class DurableEventHub:
    """Process-level ordered event publisher (one production loop per process).

    Tests may create several event loops in one Python process, so loop-owned queues
    are kept separately.  A normal ASGI worker has one loop and consequently one
    FIFO writer for all of its session events.
    """

    def __init__(self, *, max_attempts: int = 5) -> None:
        self._states: WeakKeyDictionary[asyncio.AbstractEventLoop, _LoopState] = (
            WeakKeyDictionary())
        self._pending_seq = itertools.count(1)
        self._max_attempts = max(1, max_attempts)

    def enqueue(self, session: _EventSession, repo: _EventRepo, kind: str,
                payload: dict[str, Any]) -> dict[str, Any]:
        """Queue one event and return its mutable, pending in-process projection."""
        loop = asyncio.get_running_loop()
        state = self._states.setdefault(loop, _LoopState())
        # Negative values are explicitly provisional and are never sent over SSE.
        # They keep synchronous, in-process consumers able to distinguish emissions
        # while the repository assigns the only authoritative non-negative seq.
        projection = {
            "seq": -next(self._pending_seq),
            "ts": time.time(),
            **payload,
            "kind": kind,
        }
        event_id = uuid.uuid4().hex
        projection["eventId"] = event_id
        session.events.append(projection)
        done: asyncio.Future[int] = loop.create_future()
        state.receipts[id(projection)] = done
        state.queue.put_nowait(_Pending(
            session=session,
            repo=repo,
            kind=kind,
            # emit 后调用方可能继续改同一个 rows/step dict；审计日志必须冻结在
            # emission 边界，不能等 worker 真正 append 时才看到后来版本。
            payload=copy.deepcopy(payload),
            event_id=event_id,
            projection=projection,
            done=done,
        ))
        if state.worker is None or state.worker.done():
            state.worker = loop.create_task(self._run(state),
                                            name="session-event-writer")
        return projection

    @staticmethod
    def emit_ephemeral(session: _EventSession, kind: str,
                       payload: dict[str, Any]) -> dict[str, Any]:
        """Local-only compatibility path when no repository/runtime is available."""
        seq = max((int(e.get("seq", -1)) for e in session.events
                   if int(e.get("seq", -1)) >= 0), default=-1) + 1
        ev = {"seq": seq, "ts": time.time(),
              **payload, "kind": kind}
        session.events.append(ev)
        for subscriber in list(session.subscribers):
            subscriber.put_nowait(ev)
        return ev

    async def wait_seq(self, event: dict[str, Any]) -> int:
        """Resolve the repository sequence for an event returned by ``enqueue``."""
        seq = int(event.get("seq", -1))
        if seq >= 0:
            return seq
        loop = asyncio.get_running_loop()
        state = self._states.get(loop)
        receipt = state.receipts.get(id(event)) if state is not None else None
        if receipt is None:
            # A local-only event or an already finalised receipt.
            return int(event.get("seq", -1))
        return await asyncio.shield(receipt)

    def receipt(self, event: dict[str, Any]) -> asyncio.Future[int] | None:
        """Return the current-loop durability receipt without awaiting it."""
        try:
            state = self._states.get(asyncio.get_running_loop())
        except RuntimeError:
            return None
        return state.receipts.get(id(event)) if state is not None else None

    async def flush(self) -> None:
        """Wait until every event queued on the current loop has been processed."""
        state = self._states.get(asyncio.get_running_loop())
        if state is not None:
            await state.queue.join()

    async def shutdown(self) -> None:
        """Drain and stop the writer owned by the current application loop."""
        loop = asyncio.get_running_loop()
        state = self._states.get(loop)
        if state is None:
            return
        await state.queue.join()
        if state.worker is not None and not state.worker.done():
            state.worker.cancel()
            await asyncio.gather(state.worker, return_exceptions=True)
        state.worker = None
        self._states.pop(loop, None)

    async def _run(self, state: _LoopState) -> None:
        while True:
            item = await state.queue.get()
            try:
                await self._commit(item, state)
            finally:
                state.queue.task_done()

    async def _commit(self, item: _Pending, state: _LoopState) -> None:
        error: Exception | None = None
        for attempt in range(self._max_attempts):
            try:
                # Unit-level Session objects are often intentionally detached from
                # persistence.  Preserve their historical local-only behaviour.
                if await item.repo.get_session(item.session.id) is None:
                    ev = self._finalise_ephemeral(item)
                    if not item.done.done():
                        item.done.set_result(int(ev["seq"]))
                    state.receipts.pop(id(item.projection), None)
                    return
                row = await item.repo.append_event(
                    item.session.id, item.kind, item.payload,
                    event_id=item.event_id)
                self._publish_committed(item.session, item.projection, row)
                if not item.done.done():
                    item.done.set_result(row.seq)
                state.receipts.pop(id(item.projection), None)
                return
            except Exception as exc:  # noqa: BLE001 - retry is the durability boundary
                error = exc
                if attempt + 1 < self._max_attempts:
                    await asyncio.sleep(min(0.05 * (2 ** attempt), 0.5))

        assert error is not None
        # **一条事件彻底写不进去，必须吼出来。** 这次的 bug 里，助手的回答连续
        # 5 次撞 UNIQUE 约束、最终丢掉，而服务器日志**一个字都没有** —— 从外面
        # 看就是"模型答了、界面空着"，没有任何线索。丢事件是数据丢失，不是噪声。
        _LOG.error("session-event 落库失败，已丢弃：session=%s kind=%s error=%s",
                   item.session.id, item.kind, error)
        # Never pretend the original event was delivered.  Keep its provisional
        # projection for diagnosis and publish an explicit local failure signal.
        if not item.done.done():
            item.done.set_exception(error)
            # Most emitters do not await the receipt; retrieve it here so asyncio
            # does not turn the already-visible failure into a noisy warning.
            item.done.exception()
        state.receipts.pop(id(item.projection), None)
        warning = {
            "seq": self._next_local_seq(item.session),
            "ts": time.time(),
            "kind": "event.persist_failed",
            "eventKind": item.kind,
            "error": f"{type(error).__name__}: {error}",
        }
        item.session.events.append(warning)
        for subscriber in list(item.session.subscribers):
            subscriber.put_nowait(warning)

    @classmethod
    def _finalise_ephemeral(cls, item: _Pending) -> dict[str, Any]:
        ev = {"seq": cls._next_local_seq(item.session),
              "ts": time.time(),
              **item.payload, "kind": item.kind}
        item.projection.clear()
        item.projection.update(ev)
        for subscriber in list(item.session.subscribers):
            subscriber.put_nowait(ev)
        return ev

    @staticmethod
    def _next_local_seq(session: _EventSession) -> int:
        return max((int(e.get("seq", -1)) for e in session.events
                    if int(e.get("seq", -1)) >= 0), default=-1) + 1

    @staticmethod
    def _publish_committed(session: _EventSession,
                           projection: dict[str, Any], row: EventRow) -> None:
        committed = row.as_sse()
        projection.clear()
        projection.update(committed)
        # Another local SSE subscriber may already have cached this event from a
        # repository poll.  Keep one projection per durable sequence.
        duplicates = [e for e in session.events
                      if e is not projection and e.get("seq") == row.seq]
        for duplicate in duplicates:
            session.events.remove(duplicate)
        session.events.sort(key=lambda e: (
            int(e.get("seq", -1)) < 0,
            int(e.get("seq", -1)) if int(e.get("seq", -1)) >= 0
            else -int(e.get("seq", -1)),
        ))
        # This queue notification is only a wake-up hint.  SSE always reads the
        # repository by cursor before sending, so a wake-up can never introduce a
        # duplicate or expose an uncommitted payload.
        for subscriber in list(session.subscribers):
            subscriber.put_nowait(committed)


SESSION_EVENTS = DurableEventHub()


__all__ = ["SESSION_EVENTS", "DurableEventHub"]
