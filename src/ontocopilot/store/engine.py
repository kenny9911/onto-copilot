"""引擎装配与优雅降级。

**降级不是 try/except，是启动时的一次显式选路。**
``DATABASE_URL`` 没配就走内存 + 文件模式，和现在的行为完全一致；配了就连库。
中途连不上**不**偷偷回落到内存 —— 那样用户会以为数据存下来了。这条纪律和
``llm_config()``（config.py:52-68）拒绝静默换端点是同一条。

用法::

    from ontocopilot.store.engine import Store

    store = await Store.open()          # 读 DATABASE_URL
    print(store.mode)                   # "postgres" | "memory"
    async with store.lifespan():
        ...
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

DEFAULT_POOL_SIZE = 5
DEFAULT_MAX_OVERFLOW = 5


def database_url(env: dict[str, str] | None = None) -> str:
    """规范化 ``DATABASE_URL``。

    接受 ``postgres://`` / ``postgresql://`` 这类运维习惯写法，统一补上
    ``+asyncpg`` 驱动 —— 忘了写 driver 的报错（``MissingGreenlet``）极难看懂。
    """
    env = os.environ if env is None else env
    raw = (env.get("DATABASE_URL") or "").strip()
    if not raw:
        return ""
    for prefix in ("postgres://", "postgresql://"):
        if raw.startswith(prefix):
            return "postgresql+asyncpg://" + raw[len(prefix):]
    return raw


@dataclass(slots=True)
class Store:
    """数据库句柄。``mode == "memory"`` 时 ``engine is None``。"""

    mode: str
    engine: Any = None
    url: str = ""

    @property
    def enabled(self) -> bool:
        return self.engine is not None

    @classmethod
    async def open(cls, url: str | None = None, *, create_all: bool = False) -> "Store":
        """按 URL 建引擎。URL 为空 → 内存模式，**不抛异常**。

        Args:
            create_all: 直接建表而不跑迁移。只给测试（SQLite）用；
                Postgres 上一律走 ``migrations/``，否则线上 schema 的来源就有两个。
        """
        url = database_url() if url is None else url
        if not url:
            return cls(mode="memory")

        # 延迟导入：没配 DATABASE_URL 的部署不该被强制装 SQLAlchemy。
        from sqlalchemy.ext.asyncio import create_async_engine

        kw: dict[str, Any] = {"pool_pre_ping": True, "future": True}
        if url.startswith("postgresql"):
            kw |= {"pool_size": int(os.getenv("DB_POOL_SIZE", DEFAULT_POOL_SIZE)),
                   "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", DEFAULT_MAX_OVERFLOW)),
                   "pool_recycle": 1800}
        else:
            # SQLite 内存库：连接池必须是单连接，否则每个连接看到的是**不同的库**。
            from sqlalchemy.pool import StaticPool
            kw |= {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}

        engine = create_async_engine(url, **kw)
        store = cls(mode="postgres" if url.startswith("postgresql") else "sqlite",
                    engine=engine, url=url)
        if create_all:
            from .schema import metadata
            async with engine.begin() as conn:
                await conn.run_sync(metadata.create_all)
        return store

    async def close(self) -> None:
        if self.engine is not None:
            await self.engine.dispose()

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator["Store"]:
        try:
            yield self
        finally:
            await self.close()

    async def healthcheck(self) -> dict[str, Any]:
        """给 ``/api/health`` 用。内存模式返回 ok —— 它是**受支持的模式**，不是故障。"""
        if self.engine is None:
            return {"mode": "memory", "ok": True,
                    "note": "未配置 DATABASE_URL，会话状态只在内存里，进程重启即丢"}
        import sqlalchemy as sa
        try:
            async with self.engine.connect() as conn:
                v = (await conn.execute(sa.text(
                    "SELECT COALESCE(MAX(version), 0) FROM schema_migration"))).scalar()
            return {"mode": self.mode, "ok": True, "schema_version": int(v or 0)}
        except Exception as exc:  # noqa: BLE001 — 健康检查要报出原因，不能吞
            return {"mode": self.mode, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
