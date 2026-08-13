"""停止/中断：`/stop` 端点取消在跑的对话轮或梳理任务；取消清理把状态落成
``stopped`` 并发一条 ``run.cancelled``。

会话直接注入 ``SESSIONS`` —— 不走 ``create_session`` 就不碰 repo / 不在
``workspace/`` 里落目录，测试保持无副作用。开放模式（零账号、无 ``ONTOCOPILOT_AUTH``）
下这些路由无需登录。
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from ontocopilot import appconfig, authgate, server
from ontocopilot.server import SESSIONS, Session, app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, SessionRow


@pytest.fixture(autouse=True)
def _reset(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    yield
    set_repo_for_tests(None)
    authgate._ATTEMPTS.clear()
    appconfig._CACHE = {}
    SESSIONS.clear()


def _client(repo: MemoryRepo) -> httpx.AsyncClient:
    set_repo_for_tests(repo)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t")


def _inject(sid: str = "stoptest") -> Session:
    s = Session(id=sid)
    SESSIONS[sid] = s
    return s


async def test_stop_cancels_live_run_task():
    s = _inject()
    s.run_task = asyncio.create_task(asyncio.sleep(30))
    await asyncio.sleep(0)  # 让任务真正起来
    async with _client(MemoryRepo()) as c:
        r = await c.post(f"/api/sessions/{s.id}/stop", json={"target": "run"})
    assert r.status_code == 200
    assert r.json()["stopped"] == ["run"]
    await asyncio.sleep(0.02)
    assert s.run_task.cancelled()


async def test_stop_cancels_live_chat_task():
    s = _inject()
    s.chat_task = asyncio.create_task(asyncio.sleep(30))
    await asyncio.sleep(0)
    async with _client(MemoryRepo()) as c:
        r = await c.post(f"/api/sessions/{s.id}/stop", json={"target": "chat"})
    assert r.json()["stopped"] == ["chat"]
    await asyncio.sleep(0.02)
    assert s.chat_task.cancelled()


async def test_stop_is_noop_when_nothing_running():
    s = _inject()
    async with _client(MemoryRepo()) as c:
        r = await c.post(f"/api/sessions/{s.id}/stop", json={})
    assert r.status_code == 200
    assert r.json()["stopped"] == []


async def test_stop_all_cancels_both():
    s = _inject()
    s.run_task = asyncio.create_task(asyncio.sleep(30))
    s.chat_task = asyncio.create_task(asyncio.sleep(30))
    await asyncio.sleep(0)
    async with _client(MemoryRepo()) as c:
        r = await c.post(f"/api/sessions/{s.id}/stop", json={"target": "all"})
    assert set(r.json()["stopped"]) == {"chat", "run"}
    await asyncio.sleep(0.02)
    assert s.run_task.cancelled() and s.chat_task.cancelled()


async def test_remote_worker_stop_persists_intent_and_never_claims_completion():
    """A worker without the task requests cancellation durably and reports requested."""
    repo = MemoryRepo()
    await repo.create_session(SessionRow(id="remote-stop"))
    (server.ROOT / "remote-stop").mkdir(parents=True)
    assert await repo.claim_build_lease(
        "remote-stop", owner="worker-a:run", now=1.0, ttl=10_000_000_000.0,
        from_statuses=("idle",),
    )
    # The request lands on worker B: hydration has no local run_task.
    async with _client(repo) as c:
        r = await c.post("/api/sessions/remote-stop/stop", json={"target": "run"})

    assert r.status_code == 200
    assert r.json() == {"stopped": [], "requested": ["run"]}
    assert (await repo.get_session("remote-stop")).status == "stopped"
    assert not await repo.renew_build_lease(
        "remote-stop", owner="worker-a:run", now=2.0, ttl=30.0,
    )


def test_on_run_cancelled_marks_stopped_and_emits():
    from ontocopilot.server import _on_run_cancelled

    s = Session(id="x")
    s.status = "extracting"
    _on_run_cancelled(s)
    assert s.status == "stopped"
    assert any(e["kind"] == "run.cancelled" for e in s.events)
