"""Chat invocation leases are durable, single-flight and owner fenced."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from ontocopilot.store.engine import Store
from ontocopilot.store.repo import SessionRow, build_repo


async def test_chat_route_claims_before_confirm_or_reason_and_rejects_second_worker(
    repo, tmp_path, monkeypatch,
):
    """The outer HTTP boundary protects every branch, including confirm replay."""
    from ontocopilot import authgate, server
    from ontocopilot.store.deps import set_repo_for_tests

    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    authgate._ATTEMPTS.clear()
    monkeypatch.setattr(server, "ROOT", tmp_path)
    set_repo_for_tests(repo)
    await repo.create_session(SessionRow(id="chat-route"))
    (tmp_path / "chat-route").mkdir()
    first_entered = asyncio.Event()
    release = asyncio.Event()

    async def parked(_s, _body, *, chat_owner):
        assert chat_owner
        first_entered.set()
        await release.wait()
        return {"reply": "first"}

    monkeypatch.setattr(server, "_chat_claimed", parked)
    transport = httpx.ASGITransport(app=server.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        first = asyncio.create_task(client.post(
            "/api/sessions/chat-route/chat", json={"text": "first"},
        ))
        await first_entered.wait()
        second = await client.post(
            "/api/sessions/chat-route/chat", json={"text": "确认", "confirm": True},
        )
        assert second.status_code == 409
        assert "已有一轮对话" in second.text
        release.set()
        assert (await first).status_code == 200

    set_repo_for_tests(None)


@pytest.fixture(params=["memory", "sqlite"])
async def repo(request):
    store = (await Store.open("") if request.param == "memory" else
             await Store.open("sqlite+aiosqlite:///:memory:", create_all=True))
    value = build_repo(store)
    try:
        yield value
    finally:
        await store.close()


async def test_chat_lease_is_single_flight_and_owner_fenced(repo):
    await repo.create_session(SessionRow(id="chat"))
    assert await repo.claim_chat_lease(
        "chat", owner="worker-a:one", now=10.0, ttl=30.0,
    )
    assert not await repo.claim_chat_lease(
        "chat", owner="worker-b:two", now=11.0, ttl=30.0,
    )
    assert not await repo.renew_chat_lease(
        "chat", owner="worker-b:two", now=12.0, ttl=30.0,
    )
    assert not await repo.release_chat_lease("chat", owner="worker-b:two")
    assert await repo.renew_chat_lease(
        "chat", owner="worker-a:one", now=12.0, ttl=30.0,
    )
    assert await repo.release_chat_lease("chat", owner="worker-a:one")


async def test_chat_cancel_intent_fences_heartbeat_and_is_idempotent(repo):
    await repo.create_session(SessionRow(id="cancel-chat"))
    assert await repo.claim_chat_lease(
        "cancel-chat", owner="worker-a:one", now=1.0, ttl=30.0,
    )
    assert await repo.request_chat_cancel("cancel-chat", now=2.0)
    assert not await repo.request_chat_cancel("cancel-chat", now=3.0)
    assert not await repo.renew_chat_lease(
        "cancel-chat", owner="worker-a:one", now=3.0, ttl=30.0,
    )
    assert await repo.release_chat_lease("cancel-chat", owner="worker-a:one")


async def test_expired_chat_lease_can_be_taken_but_old_owner_cannot_release(repo):
    await repo.create_session(SessionRow(id="takeover"))
    assert await repo.claim_chat_lease(
        "takeover", owner="worker-a:old", now=1.0, ttl=5.0,
    )
    assert await repo.claim_chat_lease(
        "takeover", owner="worker-b:new", now=6.0, ttl=30.0,
    )
    assert not await repo.release_chat_lease("takeover", owner="worker-a:old")
    assert await repo.renew_chat_lease(
        "takeover", owner="worker-b:new", now=7.0, ttl=30.0,
    )


async def test_chat_lease_claim_is_atomic_across_independent_sqlite_repos(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'chat-lease.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        await repo_a.create_session(SessionRow(id="shared-chat"))
        results = await asyncio.gather(
            repo_a.claim_chat_lease(
                "shared-chat", owner="worker-a:one", now=10.0, ttl=30.0,
            ),
            repo_b.claim_chat_lease(
                "shared-chat", owner="worker-b:two", now=10.0, ttl=30.0,
            ),
        )
        assert sorted(results) == [False, True]
    finally:
        await store_b.close()
        await store_a.close()


async def test_missing_session_cannot_claim_chat_lease(repo):
    assert not await repo.claim_chat_lease(
        "missing", owner="worker-a:one", now=1.0, ttl=30.0,
    )


async def test_chat_state_write_is_fenced_by_owner_expiry_and_cancel(repo):
    await repo.create_session(SessionRow(id="chat-state"))
    assert await repo.claim_chat_lease(
        "chat-state", owner="worker-a:live", now=10.0, ttl=5.0,
    )
    assert await repo.save_chat_state(
        "chat-state", {"marker": "a"}, owner="worker-b:wrong", now=11.0,
    ) is None
    assert await repo.save_chat_state(
        "chat-state", {"marker": "a"}, owner="worker-a:live", now=11.0,
    ) == 1
    assert await repo.save_chat_state(
        "chat-state", {"marker": "expired"}, owner="worker-a:live", now=16.0,
    ) is None
    assert await repo.claim_chat_lease(
        "chat-state", owner="worker-b:new", now=16.0, ttl=10.0,
    )
    assert await repo.request_chat_cancel("chat-state", now=17.0)
    assert await repo.save_chat_state(
        "chat-state", {"marker": "cancelled"}, owner="worker-b:new", now=17.0,
    ) is None
    assert (await repo.load_state("chat-state"))["marker"] == "a"


async def test_state_expected_version_cas_rejects_stale_snapshot(repo):
    await repo.create_session(SessionRow(id="state-cas"))
    version = await repo.save_state("state-cas", {"oir": {"revision": 1}})
    assert version == 1
    assert await repo.save_state(
        "state-cas", {"oir": {"revision": 2}}, expected_version=version,
    ) == 2
    assert await repo.save_state(
        "state-cas", {"oir": {"revision": "stale"}}, expected_version=version,
    ) is None
    assert (await repo.load_state("state-cas"))["oir"] == {"revision": 2}


async def test_two_workers_refresh_sequential_dialogue_and_oir_edits(
    repo, tmp_path, monkeypatch,
):
    """A warm but stale worker must extend, never replace, the prior chat turn."""
    from ontocopilot import server
    from ontocopilot.kernel.memory.dialogue import DialogueMemory, Speaker
    from ontocopilot.onto.oir import OIR
    from ontocopilot.onto.oir_edit import apply_oir_edit
    from ontocopilot.store.deps import set_repo_for_tests

    sid = "sequential-workers"
    monkeypatch.setattr(server, "ROOT", tmp_path)
    set_repo_for_tests(repo)
    await repo.create_session(SessionRow(id=sid))
    (tmp_path / sid).mkdir()
    base = OIR()
    first_version = await repo.save_state(
        sid, {"oir": base.to_dict(), "dialogue": DialogueMemory().to_dict()},
    )
    # Two processes hydrated the same durable version before either chat began.
    worker_a = server.Session(id=sid, state_version=first_version)
    worker_b = server.Session(id=sid, state_version=first_version)
    for cached in (worker_a, worker_b):
        cached.state["oir"] = base.to_dict()
        cached.state["_oir"] = server.oir_from_dict(base.to_dict())
        cached.state["_dialogue"] = DialogueMemory()
        cached.state["_chat_usd"] = 0.0

    now = time.time()
    assert await repo.claim_chat_lease(
        sid, owner="worker-a:turn-1", now=now, ttl=10.0,
    )
    apply_oir_edit(worker_a.state["_oir"], "add_object_type", {
        "api_name": "PurchaseOrder", "display_name": "采购订单",
    })
    worker_a.state["oir"] = worker_a.state["_oir"].to_dict()
    worker_a.state["_chat_usd"] = 0.75
    worker_a.state["_dialogue"].say(Speaker.USER, "新增采购订单")
    worker_a.state["_dialogue"].say(Speaker.ASSISTANT, "已新增采购订单")
    await server._persist(
        worker_a, status=False, chat_owner="worker-a:turn-1",
    )
    assert await repo.release_chat_lease(sid, owner="worker-a:turn-1")

    assert await repo.claim_chat_lease(
        sid, owner="worker-b:turn-2", now=now + 1.0, ttl=10.0,
    )
    assert worker_b.state_version < (await repo.get_session(sid)).state_version
    await server._refresh_chat_projection(worker_b)
    assert [t.text for t in worker_b.state["_dialogue"].turns] == [
        "新增采购订单", "已新增采购订单",
    ]
    assert any(o.api_name.value == "PurchaseOrder"
               for o in worker_b.state["_oir"].objects.values())
    assert worker_b.state["_chat_usd"] == 0.75

    apply_oir_edit(worker_b.state["_oir"], "add_object_type", {
        "api_name": "Supplier", "display_name": "供应商",
    })
    worker_b.state["oir"] = worker_b.state["_oir"].to_dict()
    worker_b.state["_dialogue"].say(Speaker.USER, "再新增供应商")
    worker_b.state["_dialogue"].say(Speaker.ASSISTANT, "已新增供应商")
    await server._persist(
        worker_b, status=False, chat_owner="worker-b:turn-2",
    )

    final = await repo.load_state(sid)
    assert [t["text"] for t in final["dialogue"]["turns"]] == [
        "新增采购订单", "已新增采购订单", "再新增供应商", "已新增供应商",
    ]
    assert {o["apiName"]["value"] for o in final["oir"]["objects"]} == {
        "PurchaseOrder", "Supplier",
    }
    set_repo_for_tests(None)


async def test_two_sqlite_workers_cas_and_disjoint_retry_preserve_build_and_chat(tmp_path):
    """Reproduce a chat/build race through two independent connection pools."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'state-cas-race.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        sid = "build-chat-race"
        await repo_a.create_session(SessionRow(id=sid))
        base = await repo_a.save_state(sid, {
            "oir": {"revision": 0},
            "dialogue": {"turns": [], "decisions": [], "compactions": 0},
        })
        now = time.time()
        assert await repo_a.claim_build_lease(
            sid, owner="worker-a:build", now=now, ttl=30.0,
            from_statuses=("idle",),
        )
        assert await repo_b.claim_chat_lease(
            sid, owner="worker-b:chat", now=now, ttl=30.0,
        )
        build_docs = {
            "oir": {"revision": 1},
            # This is the stale full snapshot that used to erase the chat turn.
            "dialogue": {"turns": [], "decisions": [], "compactions": 0},
        }
        chat_doc = {"dialogue": {
            "turns": [{"speaker": "user", "text": "保留这一轮", "ts": now,
                       "intent": "", "refs": [], "compressed": False}],
            "decisions": [], "compactions": 0,
        }}

        # Chat wins the first CAS.  The stale full build snapshot is rejected.
        assert await repo_b.save_chat_state(
            sid, chat_doc, owner="worker-b:chat", now=now + 1,
            expected_version=base,
        ) == base + 1
        assert await repo_a.save_build_state(
            sid, build_docs, owner="worker-a:build", now=now + 1,
            status="extracting", expected_version=base,
        ) is None
        latest = (await repo_a.get_session(sid)).state_version
        # Retry only the build-owned write-set over the new version.
        assert await repo_a.save_build_state(
            sid, {"oir": build_docs["oir"]}, owner="worker-a:build", now=now + 2,
            status="extracting", expected_version=latest,
        ) == latest + 1
        state = await repo_b.load_state(sid)
        assert state["oir"] == {"revision": 1}
        assert state["dialogue"]["turns"][0]["text"] == "保留这一轮"
    finally:
        await store_b.close()
        await store_a.close()


async def test_server_chat_retry_merges_over_simultaneous_build_checkpoint(
    repo, tmp_path, monkeypatch,
):
    """The server retry writes chat keys only after an OIR CAS conflict."""
    from ontocopilot import server
    from ontocopilot.kernel.memory.dialogue import DialogueMemory, Speaker
    from ontocopilot.store.deps import set_repo_for_tests

    sid = "server-chat-merge"
    set_repo_for_tests(repo)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    await repo.create_session(SessionRow(id=sid))
    (tmp_path / sid).mkdir()
    initial = await repo.save_state(sid, {
        "oir": {"revision": 0},
        "dialogue": DialogueMemory().to_dict(),
    })
    s = server.Session(id=sid, state_version=initial)
    s.state.update({
        "oir": {"revision": 0},
        "_dialogue": DialogueMemory(),
        "_chat_usd": 0.5,
    })
    s.state["_dialogue"].say(Speaker.USER, "并发补充")
    now = time.time()
    assert await repo.claim_chat_lease(
        sid, owner="worker-chat", now=now, ttl=30.0,
    )
    # Another legal mutation commits after chat loaded its projection.
    assert await repo.save_state(
        sid, {"oir": {"revision": 1}}, expected_version=initial,
    ) == initial + 1
    await server._persist(s, status=False, chat_owner="worker-chat")
    final = await repo.load_state(sid)
    assert final["oir"] == {"revision": 1}
    assert final["dialogue"]["turns"][0]["text"] == "并发补充"
    assert final["_chat_usd"] == 0.5
    set_repo_for_tests(None)


async def test_server_build_retry_does_not_erase_simultaneous_dialogue(
    repo, tmp_path, monkeypatch,
):
    """The reciprocal retry drops chat-owned documents from a build snapshot."""
    from ontocopilot import server
    from ontocopilot.kernel.memory.dialogue import DialogueMemory
    from ontocopilot.store.deps import set_repo_for_tests

    sid = "server-build-merge"
    set_repo_for_tests(repo)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    await repo.create_session(SessionRow(id=sid))
    (tmp_path / sid).mkdir()
    initial = await repo.save_state(sid, {
        "oir": {"revision": 0},
        "dialogue": DialogueMemory().to_dict(),
    })
    s = server.Session(
        id=sid, state_version=initial, status="extracting",
        build_lease_owner="worker-build",
    )
    s.state.update({
        "oir": {"revision": 1},
        "_dialogue": DialogueMemory(),  # stale by construction
    })
    now = time.time()
    assert await repo.claim_build_lease(
        sid, owner="worker-build", now=now, ttl=30.0,
        from_statuses=("idle",), to_status="extracting",
    )
    fresh_dialogue = DialogueMemory()
    fresh_dialogue.say("user", "不要被 build 擦掉")
    assert await repo.save_state(
        sid, {"dialogue": fresh_dialogue.to_dict()}, expected_version=initial,
    ) == initial + 1
    await server._persist(s, lease_owner="worker-build")
    final = await repo.load_state(sid)
    assert final["oir"] == {"revision": 1}
    assert final["dialogue"]["turns"][0]["text"] == "不要被 build 擦掉"
    set_repo_for_tests(None)
