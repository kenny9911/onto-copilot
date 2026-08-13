"""冷会话恢复的并发与失败语义。"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from ontocopilot import server
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import SessionRow, build_repo


@pytest.fixture(params=["memory", "sqlite"])
async def repo(request):
    url = "" if request.param == "memory" else "sqlite+aiosqlite:///:memory:"
    store = await Store.open(url, create_all=bool(url))
    repository = build_repo(store)
    set_repo_for_tests(repository)
    yield repository
    set_repo_for_tests(None)
    await store.close()


@pytest.fixture(autouse=True)
def _isolated_sessions(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    server.SESSIONS.clear()
    server._HYDRATE_LOCKS.clear()
    server._HYDRATE_USERS.clear()
    yield
    server.SESSIONS.clear()
    server._HYDRATE_LOCKS.clear()
    server._HYDRATE_USERS.clear()


async def test_concurrent_cold_hydration_returns_one_session(repo):
    await repo.create_session(SessionRow(id="cold", title="冷会话"))
    (server.ROOT / "cold").mkdir()

    sessions = await asyncio.gather(*(server._sess_async("cold") for _ in range(12)))

    assert all(item is sessions[0] for item in sessions)
    assert server.SESSIONS["cold"] is sessions[0]
    assert [e.kind for e in await repo.read_events("cold")].count("session.restored") == 1
    assert "cold" not in server._HYDRATE_LOCKS
    assert "cold" not in server._HYDRATE_USERS


async def test_late_request_cannot_observe_partially_hydrated_session(repo, monkeypatch):
    await repo.create_session(SessionRow(id="late", title="不可见半成品"))
    (server.ROOT / "late").mkdir()
    entered = asyncio.Event()
    release = asyncio.Event()
    original = server._hydrate_into

    async def paused(session, **kwargs):
        entered.set()
        await release.wait()
        return await original(session, **kwargs)

    monkeypatch.setattr(server, "_hydrate_into", paused)
    first = asyncio.create_task(server._sess_async("late"))
    await entered.wait()
    assert "late" not in server.SESSIONS
    late = asyncio.create_task(server._sess_async("late"))
    await asyncio.sleep(0)
    assert not late.done()
    release.set()
    left, right = await asyncio.gather(first, late)
    assert left is right is server.SESSIONS["late"]


async def test_failed_hydration_cleans_partial_session_and_allows_retry(repo, monkeypatch):
    await repo.create_session(SessionRow(id="retry", title="可重试"))
    (server.ROOT / "retry").mkdir()
    original = server._hydrate_into
    calls = 0

    async def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("injected hydrate failure")
        return await original(*args, **kwargs)

    monkeypatch.setattr(server, "_hydrate_into", fail_once)
    with pytest.raises(RuntimeError, match="injected"):
        await server._sess_async("retry")

    assert "retry" not in server.SESSIONS
    assert "retry" not in server._HYDRATE_LOCKS
    assert "retry" not in server._HYDRATE_USERS

    restored = await server._sess_async("retry")
    assert restored is server.SESSIONS["retry"]
    assert restored.title == "可重试"


async def test_cold_worker_direct_links_hydrate_before_serving(repo):
    """Download/source cards remain valid after restart or a request hits another worker."""
    sid = "cold-links"
    await repo.create_session(SessionRow(id=sid, title="冷直链"))
    directory = server.ROOT / sid
    (directory / "exports").mkdir(parents=True)
    (directory / "materials").mkdir()
    (directory / "artifact.txt").write_text("artifact", encoding="utf-8")
    (directory / "exports" / "notes.md").write_text("export", encoding="utf-8")
    (directory / "materials" / "facts.txt").write_text("采购事实", encoding="utf-8")

    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        artifact = await client.get(f"/api/sessions/{sid}/artifacts/artifact.txt")
        assert artifact.status_code == 200 and artifact.content == b"artifact"
        server.SESSIONS.clear()
        exported = await client.get(f"/api/sessions/{sid}/exports/notes.md")
        assert exported.status_code == 200 and exported.content == b"export"
        server.SESSIONS.clear()
        source = await client.get(
            f"/api/sessions/{sid}/source", params={"file": "facts.txt"},
        )
        assert source.status_code == 200
        assert "采购事实" in str(source.json()["chunks"])
