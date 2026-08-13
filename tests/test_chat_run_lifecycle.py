"""Chat-side Recorder journals and durable Repo Run lifecycle stay in lock-step."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from ontocopilot import server
from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.journal import FileBlobStore, FileJournal
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import SessionRow, build_repo


@pytest.fixture(params=["memory", "sqlite"])
async def chat_repo(request):
    store = (await Store.open("") if request.param == "memory" else
             await Store.open("sqlite+aiosqlite:///:memory:", create_all=True))
    repo = build_repo(store)
    set_repo_for_tests(repo)
    try:
        yield repo
    finally:
        set_repo_for_tests(None)
        await store.close()


class _Backend:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class _Gateway:
    def __init__(self, recorder: Recorder, budget: Budget) -> None:
        self.rec = recorder
        self.budget = budget


def _fake_gateways(backends: list[_Backend], seen: list[tuple[str, bool]]):
    def make(out: Path, run_id: str, *, resume: bool = False, **_identity):
        del _identity
        backend = _Backend()
        budget = Budget()
        backends.append(backend)
        seen.append((run_id, resume))
        rec = Recorder(run_id, FileJournal(out / "journal"),
                       FileBlobStore(out / "blobs"), resume=resume)
        return backend, _Gateway(rec, budget), object(), budget
    return make


async def _run_row(repo, run_id: str) -> dict:
    if hasattr(repo, "_runs"):
        return dict(repo._runs[run_id])
    from ontocopilot.store import schema as t
    async with repo._engine.connect() as conn:
        row = (await conn.execute(t.run.select().where(t.run.c.id == run_id))).mappings().one()
    return dict(row)


async def test_chat_run_success_is_durable_and_reuses_semantic_journal(
    chat_repo, tmp_path, monkeypatch,
):
    await chat_repo.create_session(SessionRow(id="chat-ok"))
    s = server.Session(id="chat-ok")
    monkeypatch.setattr(server, "ROOT", tmp_path)
    s.dir.mkdir(parents=True)
    backends: list[_Backend] = []
    seen: list[tuple[str, bool]] = []
    monkeypatch.setattr(server, "_gateways", _fake_gateways(backends, seen))

    semantic = {"text": "库存不足怎么办", "contextRevision": 2}
    async with server._chat_run(s, kind="reason", semantic_input=semantic) as first:
        first_id = first.repo_run_id
        recorder_id = first.recorder_run_id
        first.budget.spend(tokens=13, usd=0.25)
        first.gw.rec.emit(server.EventKind.THOUGHT, payload={"answer": 1})

    row = await _run_row(chat_repo, first_id)
    assert row["kind"] == "chat:reason"
    assert row["status"] == "done"
    assert row["budget"]["spent"]["tokens"] == 13
    assert row["budget"]["spent"]["usd"] == 0.25
    assert row["budget"]["recorder_run_id"] == recorder_id
    assert backends[0].closed

    async with server._chat_run(s, kind="reason", semantic_input=semantic) as second:
        second_id = second.repo_run_id
        assert second.recorder_run_id == recorder_id
        assert second.gw.rec.journal.last_seq(recorder_id) >= 0

    assert second_id != first_id
    assert seen == [(recorder_id, False), (recorder_id, True)]
    assert all(backend.closed for backend in backends)


async def test_chat_run_failure_records_error_and_budget(chat_repo, tmp_path, monkeypatch):
    await chat_repo.create_session(SessionRow(id="chat-fail"))
    s = server.Session(id="chat-fail")
    monkeypatch.setattr(server, "ROOT", tmp_path)
    s.dir.mkdir(parents=True)
    backends: list[_Backend] = []
    monkeypatch.setattr(server, "_gateways", _fake_gateways(backends, []))

    run_id = ""
    with pytest.raises(RuntimeError, match="gateway down"):
        async with server._chat_run(
            s, kind="recommend", semantic_input={"slot": "opening"},
        ) as run:
            run_id = run.repo_run_id
            run.budget.spend(tool_calls=1)
            raise RuntimeError("gateway down")

    row = await _run_row(chat_repo, run_id)
    assert row["status"] == "failed"
    assert "gateway down" in row["error"]
    assert row["budget"]["spent"]["tool_calls"] == 1
    assert backends[0].closed


async def test_chat_run_cancel_records_terminal_state_and_closes_backend(
    chat_repo, tmp_path, monkeypatch,
):
    await chat_repo.create_session(SessionRow(id="chat-cancel"))
    s = server.Session(id="chat-cancel")
    monkeypatch.setattr(server, "ROOT", tmp_path)
    s.dir.mkdir(parents=True)
    backends: list[_Backend] = []
    monkeypatch.setattr(server, "_gateways", _fake_gateways(backends, []))
    entered = asyncio.Event()
    run_ids: list[str] = []

    async def work() -> None:
        async with server._chat_run(
            s, kind="reason", semantic_input={"text": "stop"},
        ) as run:
            run_ids.append(run.repo_run_id)
            run.budget.spend(tokens=7)
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(work())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    row = await _run_row(chat_repo, run_ids[0])
    assert row["status"] == "failed"
    assert row["error"] == "cancelled"
    assert row["budget"]["spent"]["tokens"] == 7
    assert backends[0].closed
