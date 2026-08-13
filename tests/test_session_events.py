"""Durable session events and repository-cursor SSE."""

from __future__ import annotations

import asyncio
import json

import pytest

from ontocopilot import appconfig, authgate, server
from ontocopilot.server import SESSIONS, Session
from ontocopilot.session_events import SESSION_EVENTS, DurableEventHub
from ontocopilot.store.const import EVENT_INLINE_LIMIT
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import EventRow, MemoryRepo, SessionRow, build_repo


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    yield
    set_repo_for_tests(None)
    SESSIONS.clear()


@pytest.fixture(params=["memory", "sqlite"])
async def repo(request):
    if request.param == "memory":
        store = await Store.open("")
    else:
        store = await Store.open("sqlite+aiosqlite:///:memory:", create_all=True)
    value = build_repo(store)
    yield value
    await store.close()


async def _registered(repo, sid: str = "events") -> Session:
    await repo.create_session(SessionRow(id=sid))
    set_repo_for_tests(repo)
    session = Session(id=sid)
    SESSIONS[sid] = session
    return session


async def test_sync_emit_commits_in_order_and_uses_repo_sequence(repo):
    s = await _registered(repo)
    emitted = [s.emit(f"step.{n}", n=n) for n in range(20)]

    # Synchronous callers get a projection immediately, but a non-negative seq is
    # never exposed to SSE until the repository commits it.
    assert all(e["seq"] < 0 for e in emitted)
    await SESSION_EVENTS.flush()

    rows = await repo.read_events(s.id)
    assert [r.seq for r in rows] == list(range(20))
    assert [r.payload["n"] for r in rows] == list(range(20))
    assert [e["seq"] for e in emitted] == list(range(20))
    assert [e["kind"] for e in s.events] == [f"step.{n}" for n in range(20)]


async def test_subscribers_only_receive_committed_authoritative_events(repo):
    s = await _registered(repo)
    q: asyncio.Queue = asyncio.Queue()
    s.subscribers.append(q)

    projection = s.emit("ui.table", title="缺口", rows=[["x"]])
    assert q.empty()
    await SESSION_EVENTS.flush()

    visible = q.get_nowait()
    durable = (await repo.read_events(s.id))[0].as_sse()
    assert visible == durable
    assert projection == durable


async def test_large_ui_table_live_broadcast_equals_reconnect_replay(repo):
    """Blob-backed events must not expose the private ``_ref`` envelope to SSE."""
    s = await _registered(repo, "large-table")
    q: asyncio.Queue = asyncio.Queue()
    s.subscribers.append(q)
    large_cell = "审批口径" * (EVENT_INLINE_LIMIT // len("审批口径") + 1024)

    projection = s.emit(
        "ui.table",
        title="大缺口清单",
        columns=["问题", "业务回答"],
        rows=[["金额阈值", large_cell]],
    )
    await SESSION_EVENTS.flush()

    live = q.get_nowait()
    replay = (await repo.read_events(s.id))[0].as_sse()
    assert live == replay == projection
    assert live["rows"] == [["金额阈值", large_cell]]
    assert "_ref" not in live


async def test_payload_is_frozen_at_synchronous_emit_boundary(repo):
    s = await _registered(repo)
    rows = [["before"]]
    s.emit("ui.table", rows=rows)
    rows[0][0] = "after"
    await SESSION_EVENTS.flush()

    assert (await repo.read_events(s.id))[0].payload["rows"] == [["before"]]


async def test_chat_turn_receipt_resolves_to_durable_sequence(repo):
    s = await _registered(repo)
    turn = server._publish_turn(s, server.Speaker.ASSISTANT, "已确认")
    seq = await SESSION_EVENTS.wait_seq(turn)

    assert seq == 0
    assert turn["seq"] == 0
    assert (await repo.read_events(s.id))[0].kind == "chat.turn"


async def test_sse_repository_cursor_observes_external_worker_without_duplicate(repo):
    s = await _registered(repo)
    response = await server.stream(s.id, since=0)
    iterator = response.body_iterator.__aiter__()
    reset = await anext(iterator)
    assert "stream.reset" in reset

    # Simulates a commit from another worker: it shares the repository but not the
    # Session.subscribers queue or the local DurableEventHub.
    await repo.append_event(s.id, "external.done", {"worker": "b"})
    payload = json.loads((await asyncio.wait_for(anext(iterator), timeout=1.0))
                         .removeprefix("data: ").strip())
    assert payload == {"seq": 0, "ts": payload["ts"], "worker": "b",
                       "kind": "external.done"}

    # A local queue wake-up for the already-consumed seq must not send it twice.
    s.subscribers[0].put_nowait(payload)
    await repo.append_event(s.id, "external.next", {"worker": "c"})
    next_payload = json.loads((await asyncio.wait_for(anext(iterator), timeout=1.0))
                              .removeprefix("data: ").strip())
    assert next_payload["seq"] == 1
    assert next_payload["kind"] == "external.next"
    await iterator.aclose()


async def test_export_by_durable_seq_works_on_a_cold_worker(repo):
    from fastapi import Response

    s = await _registered(repo, "table-export")
    event = await s.emit_durable(
        "ui.table", title="缺口清单", columns=["名称"], rows=[["审批"]])
    seq = event["seq"]
    # Simulate load balancing to another worker: no in-memory event projection.
    s.events.clear()

    response = await server.export_table(s.id, seq=seq, format="csv")

    assert isinstance(response, Response)
    assert "审批" in response.body.decode("utf-8-sig")


async def test_hydrated_session_stream_replays_repo_cursor_once(repo):
    await repo.create_session(SessionRow(id="hydrated"))
    await repo.append_event("hydrated", "first", {"n": 1})
    await repo.append_event("hydrated", "second", {"n": 2})
    set_repo_for_tests(repo)
    (server.ROOT / "hydrated").mkdir(parents=True)

    hydrated = await server._sess_async("hydrated")
    await SESSION_EVENTS.flush()
    assert [e["seq"] for e in hydrated.events] == [0, 1, 2]
    assert hydrated.events[-1]["kind"] == "session.restored"

    response = await server.stream("hydrated", since=1)
    iterator = response.body_iterator.__aiter__()
    item = json.loads((await asyncio.wait_for(anext(iterator), timeout=1.0))
                      .removeprefix("data: ").strip())
    assert (item["seq"], item["kind"], item["n"]) == (1, "second", 2)
    await iterator.aclose()


async def test_shutdown_drains_events_before_repo_close(repo):
    hub = DurableEventHub()
    s = await _registered(repo, "shutdown")
    projections = [hub.enqueue(s, repo, "tail", {"n": n}) for n in range(8)]

    await hub.shutdown()

    assert [r.payload["n"] for r in await repo.read_events(s.id)] == list(range(8))
    assert [p["seq"] for p in projections] == list(range(8))


async def test_retry_does_not_duplicate_after_transient_failure():
    class FlakyRepo(MemoryRepo):
        calls = 0

        async def append_event(self, sid: str, kind: str,
                               payload: dict, *, event_id: str = "") -> EventRow:
            self.calls += 1
            if self.calls == 1:
                raise OSError("temporary")
            return await super().append_event(sid, kind, payload,
                                              event_id=event_id)

    repo = FlakyRepo()
    await repo.create_session(SessionRow(id="retry"))
    s = Session(id="retry")
    hub = DurableEventHub(max_attempts=2)
    projection = hub.enqueue(s, repo, "once", {"n": 1})

    await hub.flush()

    assert repo.calls == 2
    assert await repo.count_events("retry") == 1
    assert projection["seq"] == 0
    await hub.shutdown()


async def test_retrying_same_event_id_returns_original_without_duplicate(repo):
    await repo.create_session(SessionRow(id="idem"))
    first = await repo.append_event("idem", "done", {"n": 1}, event_id="evt-1")
    retry = await repo.append_event("idem", "done", {"n": 1}, event_id="evt-1")

    assert retry.seq == first.seq == 0
    assert retry.event_id == "evt-1"
    assert await repo.count_events("idem") == 1
