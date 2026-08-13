"""Durable state is a release boundary, not a best-effort log."""

from __future__ import annotations

import pytest

from ontocopilot import server
from ontocopilot.server import Session
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, SessionRow


async def test_persist_failure_is_visible_and_fails_closed(monkeypatch, tmp_path) -> None:
    repo = MemoryRepo()
    await repo.create_session(SessionRow(id="persist-fail"))
    set_repo_for_tests(repo)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    session = Session(id="persist-fail")

    async def broken_save(*_args, **_kwargs):
        raise OSError("database unavailable")

    monkeypatch.setattr(repo, "save_state", broken_save)
    try:
        with pytest.raises(OSError, match="database unavailable"):
            await server._persist(session)
        assert any(event["kind"] == "persist.failed" for event in session.events)
    finally:
        set_repo_for_tests(None)
