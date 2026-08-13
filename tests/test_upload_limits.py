"""Streaming upload quotas and atomic replacement."""

from __future__ import annotations

from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile

from ontocopilot import server
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import FileRow, MemoryRepo, SessionRow


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    server.SESSIONS.clear()
    yield repo
    set_repo_for_tests(None)
    server.SESSIONS.clear()


async def _session(repo: MemoryRepo) -> server.Session:
    await repo.create_session(SessionRow(id="up"))
    session = server.Session(id="up")
    session.dir.mkdir(parents=True)
    server.SESSIONS[session.id] = session
    return session


async def test_upload_streams_hashes_and_registers_material(_clean, monkeypatch):
    session = await _session(_clean)
    real_create_task = server.asyncio.create_task

    def create_task(coro, *args, **kwargs):
        # Only suppress the optional post-upload recommendation.  Mutation-lease
        # heartbeats must remain real tasks or this test no longer exercises the
        # production concurrency boundary.
        code = getattr(coro, "cr_code", None)
        if code is not None and code.co_name == "_emit_ai_prompts":
            coro.close()
            return None
        return real_create_task(coro, *args, **kwargs)

    monkeypatch.setattr(server.asyncio, "create_task", create_task)
    upload = UploadFile(filename="large.csv", file=BytesIO(b"a" * (2 * 1024 * 1024 + 3)))

    result = await server.upload(session.id, [upload])

    item = result["files"][0]
    assert item["size"] == 2 * 1024 * 1024 + 3
    assert len(item["sha256"]) == 64
    assert (session.dir / "materials" / "large.csv").stat().st_size == item["size"]


async def test_oversize_replacement_keeps_old_file_and_cleans_temp(_clean, monkeypatch):
    session = await _session(_clean)
    monkeypatch.setenv("ONTOCOPILOT_MAX_UPLOAD_MB", "1")
    old = session.dir / "materials" / "same.csv"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"old")
    session.files = [{"name": old.name, "size": 3, "path": str(old), "sha256": "old"}]
    upload = UploadFile(filename="same.csv", file=BytesIO(b"x" * (1024 * 1024 + 1)))

    with pytest.raises(HTTPException) as error:
        await server.upload(session.id, [upload])

    assert error.value.status_code == 413
    assert old.read_bytes() == b"old"
    assert not list(old.parent.glob(".*.upload"))


async def test_session_file_count_limit_is_checked_before_writing(_clean, monkeypatch):
    session = await _session(_clean)
    monkeypatch.setenv("ONTOCOPILOT_MAX_FILES", "1")
    existing = session.dir / "materials" / "one.csv"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"1")
    session.files = [{"name": "one.csv", "size": 1,
                      "path": str(existing), "sha256": "x"}]
    await _clean.add_files(session.id, [FileRow(
        name="one.csv", rel_path="up/materials/one.csv", size=1, sha256="x",
    )])

    with pytest.raises(HTTPException) as error:
        await server.upload(
            session.id,
            [UploadFile(filename="two.csv", file=BytesIO(b"2"))],
        )

    assert error.value.status_code == 413
    assert not (session.dir / "materials" / "two.csv").exists()


async def test_later_oversize_file_does_not_partially_commit_batch(_clean, monkeypatch):
    session = await _session(_clean)
    monkeypatch.setenv("ONTOCOPILOT_MAX_UPLOAD_MB", "1")
    materials = session.dir / "materials"
    materials.mkdir(parents=True)

    with pytest.raises(HTTPException):
        await server.upload(
            session.id,
            [
                UploadFile(filename="ok.csv", file=BytesIO(b"ok")),
                UploadFile(filename="too-big.csv", file=BytesIO(b"x" * (1024 * 1024 + 1))),
            ],
        )

    assert not (materials / "ok.csv").exists()
    assert not list(materials.glob(".*.upload"))


async def test_second_replace_io_failure_rolls_back_entire_batch(_clean, monkeypatch):
    session = await _session(_clean)
    materials = session.dir / "materials"
    materials.mkdir(parents=True)
    old = {"one.csv": b"old-one", "two.csv": b"old-two"}
    for name, content in old.items():
        path = materials / name
        path.write_bytes(content)
        session.files.append({
            "name": name,
            "size": len(content),
            "path": str(path),
            "sha256": f"old-{name}",
        })
    await _clean.add_files(session.id, [
        FileRow(name=name, rel_path=f"up/materials/{name}", size=len(content),
                sha256=f"old-{name}")
        for name, content in old.items()
    ])

    original_replace = server.Path.replace
    upload_replaces = 0

    def fail_second_upload_replace(path, target):
        nonlocal upload_replaces
        if path.name.endswith(".upload"):
            upload_replaces += 1
            if upload_replaces == 2:
                raise OSError("injected second replace failure")
        return original_replace(path, target)

    monkeypatch.setattr(server.Path, "replace", fail_second_upload_replace)
    with pytest.raises(OSError, match="second replace"):
        await server.upload(session.id, [
            UploadFile(filename="one.csv", file=BytesIO(b"new-one")),
            UploadFile(filename="two.csv", file=BytesIO(b"new-two")),
        ])

    assert {name: (materials / name).read_bytes() for name in old} == old
    assert {row.name: row.sha256 for row in await _clean.list_files(session.id)} == {
        name: f"old-{name}" for name in old
    }
    assert {item["name"]: item["sha256"] for item in session.files} == {
        name: f"old-{name}" for name in old
    }
    assert not list(materials.glob(".*.upload"))
    assert not list(materials.glob(".*.backup"))
