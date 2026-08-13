"""Durable session mutation leases serialize domain writers across workers."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from ontocopilot import server
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import FileRow, SessionRow, build_repo


@pytest.fixture(params=["memory", "sqlite"])
async def repo(request):
    store = (await Store.open("") if request.param == "memory" else
             await Store.open("sqlite+aiosqlite:///:memory:", create_all=True))
    value = build_repo(store)
    try:
        yield value
    finally:
        await store.close()


async def test_mutation_lease_is_single_flight_and_owner_fenced(repo):
    await repo.create_session(SessionRow(id="mutation"))
    assert await repo.claim_mutation_lease(
        "mutation", owner="worker-a:one", kind="question.answer", now=1.0, ttl=10.0,
    )
    assert not await repo.claim_mutation_lease(
        "mutation", owner="worker-b:two", kind="audit.apply", now=2.0, ttl=10.0,
    )
    version = await repo.save_mutation_state(
        "mutation", {"oir": {"revision": 1}}, owner="worker-a:one", now=3.0,
        status="done", expected_version=0,
    )
    assert version == 1
    assert await repo.release_mutation_lease("mutation", owner="worker-a:one")
    assert await repo.claim_mutation_lease(
        "mutation", owner="worker-b:two", kind="audit.apply", now=4.0, ttl=10.0,
    )
    assert await repo.save_mutation_state(
        "mutation", {"oir": {"stale": True}}, owner="worker-a:one", now=5.0,
        status="done", expected_version=version,
    ) is None
    assert (await repo.load_state("mutation"))["oir"] == {"revision": 1}


async def test_build_and_mutation_claims_are_mutually_exclusive(repo):
    await repo.create_session(SessionRow(id="build-first"))
    assert await repo.claim_build_lease(
        "build-first", owner="build", now=1.0, ttl=30.0,
        from_statuses=("idle",),
    )
    assert not await repo.claim_mutation_lease(
        "build-first", owner="mutation", kind="question.update", now=2.0, ttl=30.0,
    )

    await repo.create_session(SessionRow(id="mutation-first"))
    assert await repo.claim_mutation_lease(
        "mutation-first", owner="mutation", kind="question.update", now=1.0, ttl=30.0,
    )
    assert not await repo.claim_build_lease(
        "mutation-first", owner="build", now=2.0, ttl=30.0,
        from_statuses=("idle",),
    )
    assert (await repo.get_session("mutation-first")).status == "idle"


async def test_two_sqlite_connections_arbitrate_build_and_mutation(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'mutation-race.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        await repo_a.create_session(SessionRow(id="race"))
        mutation, build = await asyncio.gather(
            repo_a.claim_mutation_lease(
                "race", owner="mutation", kind="audit.apply", now=10.0, ttl=30.0,
            ),
            repo_b.claim_build_lease(
                "race", owner="build", now=10.0, ttl=30.0,
                from_statuses=("idle",),
            ),
        )
        assert (mutation, build) in {(True, False), (False, True)}
        row = await repo_a.get_session("race")
        assert row.status == ("idle" if mutation else "queued")

        await repo_a.create_session(SessionRow(id="writers"))
        claims = await asyncio.gather(
            repo_a.claim_mutation_lease(
                "writers", owner="a", kind="question.answer", now=20.0, ttl=30.0,
            ),
            repo_b.claim_mutation_lease(
                "writers", owner="b", kind="audit.apply", now=20.0, ttl=30.0,
            ),
        )
        assert sorted(claims) == [False, True]
    finally:
        await store_b.close()
        await store_a.close()


async def test_mutation_refreshes_remote_material_inventory(tmp_path, monkeypatch):
    """A worker cached before upload must not copy/delete/build from stale files."""
    repo = build_repo(await Store.open(""))
    await repo.create_session(SessionRow(id="remote"))
    material = tmp_path / "remote" / "materials" / "new.csv"
    material.parent.mkdir(parents=True)
    material.write_text("id,name\n1,A\n", encoding="utf-8")
    await repo.add_files("remote", [FileRow(
        name="new.csv", rel_path="remote/materials/new.csv",
        size=material.stat().st_size, sha256="abc",
    )])
    monkeypatch.setattr(server, "ROOT", tmp_path)
    stale = server.Session(id="remote", files=[])
    stale.dir.mkdir(parents=True, exist_ok=True)
    set_repo_for_tests(repo)
    try:
        async with server._session_mutation(stale, "materials.remove"):
            assert [item["name"] for item in stale.files] == ["new.csv"]
    finally:
        set_repo_for_tests(None)


async def test_session_model_rejects_while_remote_build_owns_session(
        repo, monkeypatch):
    now = server.time.time()
    await repo.create_session(SessionRow(id="model"))
    assert await repo.claim_build_lease(
        "model", owner="remote-build", now=now, ttl=60.0,
        from_statuses=("idle",),
    )
    stale = server.Session(id="model")
    server.SESSIONS["model"] = stale
    set_repo_for_tests(repo)
    try:
        with pytest.raises(HTTPException) as exc:
            await server.set_model("model", {"model": "anything"})
        assert exc.value.status_code == 409
        assert "model" not in stale.state
    finally:
        set_repo_for_tests(None)
        server.SESSIONS.clear()
