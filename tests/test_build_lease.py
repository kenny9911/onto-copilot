"""Durable build ownership and zero-config SQLite referential integrity."""

from __future__ import annotations

import asyncio

import pytest
import sqlalchemy as sa

from ontocopilot.store import schema as t
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import DecisionRow, FileRow, SessionRow, build_repo


@pytest.fixture(params=["memory", "sqlite"])
async def repo(request):
    store = (await Store.open("") if request.param == "memory" else
             await Store.open("sqlite+aiosqlite:///:memory:", create_all=True))
    value = build_repo(store)
    try:
        yield value
    finally:
        await store.close()


async def test_live_build_lease_cannot_be_reaped_and_only_owner_can_renew(repo):
    await repo.create_session(SessionRow(id="live"))
    assert await repo.claim_build_lease(
        "live", owner="worker-a", now=100.0, ttl=30.0,
        from_statuses=("idle",),
    )
    assert not await repo.reap_expired_build_lease(
        "live", now=129.9, error="must not win",
    )
    assert not await repo.renew_build_lease(
        "live", owner="worker-b", now=120.0, ttl=30.0,
    )
    assert await repo.renew_build_lease(
        "live", owner="worker-a", now=120.0, ttl=30.0,
    )
    row = await repo.get_session("live")
    assert (row.status, row.error) == ("queued", "")


async def test_expired_or_legacy_running_build_is_reaped(repo):
    await repo.create_session(SessionRow(id="expired"))
    assert await repo.claim_build_lease(
        "expired", owner="dead-worker", now=10.0, ttl=5.0,
        from_statuses=("idle",),
    )
    assert await repo.reap_expired_build_lease(
        "expired", now=15.0, error="lease expired",
    )
    row = await repo.get_session("expired")
    assert (row.status, row.error) == ("failed", "lease expired")
    assert not await repo.renew_build_lease(
        "expired", owner="dead-worker", now=16.0, ttl=5.0,
    )

    await repo.create_session(SessionRow(id="legacy", status="extracting"))
    assert await repo.reap_expired_build_lease(
        "legacy", now=20.0, error="legacy owner unknown",
    )
    assert (await repo.get_session("legacy")).status == "failed"


async def test_durable_cancel_stops_status_and_fences_heartbeat(repo):
    await repo.create_session(SessionRow(id="cancel"))
    assert await repo.claim_build_lease(
        "cancel", owner="worker-a:run-1", now=1.0, ttl=30.0,
        from_statuses=("idle",),
    )
    assert await repo.request_build_cancel("cancel", now=2.0)
    row = await repo.get_session("cancel")
    assert (row.status, row.error) == ("stopped", "")
    assert not await repo.renew_build_lease(
        "cancel", owner="worker-a:run-1", now=3.0, ttl=30.0,
    )
    assert not await repo.request_build_cancel("cancel", now=4.0)
    assert not await repo.set_build_status(
        "cancel", owner="worker-a:run-1", now=4.0, status="done",
    )


async def test_build_status_is_fenced_by_owner_and_expiry(repo):
    await repo.create_session(SessionRow(id="fenced"))
    assert await repo.claim_build_lease(
        "fenced", owner="worker-a:old", now=10.0, ttl=5.0,
        from_statuses=("idle",),
    )
    assert not await repo.set_build_status(
        "fenced", owner="worker-b:new", now=11.0, status="extracting",
    )
    assert not await repo.set_build_status(
        "fenced", owner="worker-a:old", now=15.0, status="done",
    )
    assert (await repo.get_session("fenced")).status == "queued"


async def test_build_checkpoint_is_atomic_and_stale_writer_cannot_mutate_state(repo):
    await repo.create_session(SessionRow(id="checkpoint"))
    assert await repo.claim_build_lease(
        "checkpoint", owner="worker-a:run", now=1.0, ttl=30.0,
        from_statuses=("idle",),
    )
    version = await repo.save_build_state(
        "checkpoint", {"corpus": {"chunks": 2}},
        owner="worker-a:run", now=2.0, status="extracting",
    )
    assert version == 1
    assert (await repo.load_state("checkpoint"))["corpus"] == {"chunks": 2}

    assert await repo.request_build_cancel("checkpoint", now=3.0)
    rejected = await repo.save_build_state(
        "checkpoint", {"corpus": {"chunks": 999}, "oir": {"stale": True}},
        owner="worker-a:run", now=4.0, status="done",
    )
    assert rejected is None
    row = await repo.get_session("checkpoint")
    assert (row.status, row.state_version) == ("stopped", 1)
    assert await repo.load_state("checkpoint") == {"corpus": {"chunks": 2}}


async def test_build_lease_claim_is_atomic_across_independent_sqlite_repos(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'lease.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        await repo_a.create_session(SessionRow(id="shared"))
        results = await asyncio.gather(*(
            repo.claim_build_lease(
                "shared", owner=owner, now=100.0, ttl=30.0,
                from_statuses=("idle",),
            )
            for repo, owner in ((repo_a, "worker-a"), (repo_b, "worker-b"))
        ))
        assert sorted(results) == [False, True]
        assert not await repo_b.reap_expired_build_lease(
            "shared", now=129.0, error="still alive",
        )
    finally:
        await store_b.close()
        await store_a.close()


async def test_renew_and_reap_at_expiry_are_serializable_across_sqlite_repos(tmp_path):
    """If heartbeat wins, reaper may not overwrite it; if reap wins, renew must fail."""
    url = f"sqlite+aiosqlite:///{tmp_path / 'lease-race.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        await repo_a.create_session(SessionRow(id="race"))
        assert await repo_a.claim_build_lease(
            "race", owner="worker-a", now=10.0, ttl=5.0,
            from_statuses=("idle",),
        )
        renew, reap = await asyncio.gather(
            repo_a.renew_build_lease(
                "race", owner="worker-a", now=15.0, ttl=30.0,
            ),
            repo_b.reap_expired_build_lease(
                "race", now=15.0, error="expired",
            ),
        )
        assert (renew, reap) in {(True, False), (False, True)}
        row = await repo_a.get_session("race")
        if renew:
            assert row.status == "queued"
        else:
            assert (row.status, row.error) == ("failed", "expired")
    finally:
        await store_b.close()
        await store_a.close()


async def test_sqlite_delete_session_cascades_every_session_owned_table(tmp_path):
    store = await Store.open(
        f"sqlite+aiosqlite:///{tmp_path / 'cascade.db'}", create_all=True,
    )
    repo = build_repo(store)
    try:
        await repo.create_session(SessionRow(id="cascade"))
        await repo.add_files("cascade", [FileRow(
            name="a.csv", rel_path="materials/a.csv", size=1, sha256="a" * 64,
        )])
        await repo.save_state("cascade", {"oir": {"objects": []}}, conflicts=[{
            "rid": "cf1", "kind": "orphan", "handling": "hint",
        }])
        await repo.record_decision("cascade", DecisionRow(
            ordinal=0, kind="scope", statement="keep", scope_refs=["ot1"],
        ))
        await repo.append_event("cascade", "created", {"ok": True})
        run_id = await repo.next_run("cascade", "build:full")
        assert await repo.claim_build_lease(
            "cascade", owner="worker-a", now=1.0, ttl=30.0,
            from_statuses=("idle",),
        )
        async with store.engine.begin() as conn:
            await conn.execute(t.chat_turn.insert().values(
                session_id="cascade", ordinal=0, speaker="user", text="hello",
            ))
            await conn.execute(t.kernel_event.insert().values(
                run_id=run_id, seq=0, kind="node.entered", ts_ms=1,
            ))
        async with store.engine.connect() as conn:
            assert (await conn.exec_driver_sql("PRAGMA foreign_keys")).scalar_one() == 1

        assert await repo.delete_session("cascade")

        owned = (
            t.build_lease, t.chat_lease, t.session_file, t.session_state, t.conflict, t.decision,
            t.chat_turn, t.session_event, t.kernel_event, t.run,
        )
        async with store.engine.connect() as conn:
            counts = {
                table.name: int((await conn.execute(
                    sa.select(sa.func.count()).select_from(table),
                )).scalar_one())
                for table in owned
            }
        assert counts == {table.name: 0 for table in owned}
    finally:
        await store.close()
