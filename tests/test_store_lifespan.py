"""Default persistence must be durable or fail visibly."""

from __future__ import annotations

import pytest

from ontocopilot.store import deps
from ontocopilot.store.engine import SQLITE_SCHEMA_VERSION


async def test_zero_config_lifespan_uses_persistent_sqlite(monkeypatch, tmp_path):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ONTOCOPILOT_NO_DB", raising=False)
    monkeypatch.setenv("ONTOCOPILOT_WORKSPACE", str(tmp_path))

    async with deps.lifespan(None):
        store = deps.get_store()
        assert store.mode == "sqlite"
        assert store.enabled
        assert (tmp_path / "ontocopilot.db").exists()


async def test_sqlite_start_failure_never_silently_falls_back_to_memory(
    monkeypatch, tmp_path,
):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ONTOCOPILOT_NO_DB", raising=False)
    monkeypatch.setenv("ONTOCOPILOT_WORKSPACE", str(tmp_path))

    async def broken_open(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(deps.Store, "open", broken_open)
    with pytest.raises(RuntimeError, match="ONTOCOPILOT_NO_DB=1"):
        async with deps.lifespan(None):
            pass


async def test_explicit_empty_sqlite_database_is_initialized(monkeypatch, tmp_path):
    """显式 SQLite URL 与零配置本地库一样，首次启动就必须拥有完整 schema。"""
    db = tmp_path / "explicit.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    monkeypatch.setenv("ONTOCOPILOT_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.delenv("ONTOCOPILOT_NO_DB", raising=False)

    async with deps.lifespan(None):
        assert deps.get_store().mode == "sqlite"
        assert await deps.get_repo().list_settings() == []
        health = await deps.get_store().healthcheck()
        # 版本号引常量而不是抄一个字面量。这一处是全仓第三个硬编码的 12，前两个在
        # test_usage_ledger / test_sqlite_upgrade —— 每加一次迁移就要满仓找一遍，
        # 而漏掉的那一处正好在没人跑的文件里（这次就是这么红的）。
        assert health == {"mode": "sqlite", "ok": True,
                          "schema_version": SQLITE_SCHEMA_VERSION}

    assert db.exists()
