"""引擎装配与优雅降级。

**降级不是 try/except，是启动时的一次显式选路。**
``DATABASE_URL`` 没配就走持久 SQLite；只有显式 ``ONTOCOPILOT_NO_DB=1`` 才走
内存模式。中途连不上**不**偷偷回落到内存 —— 那样用户会以为数据存下来了。这条纪律和
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
SQLITE_SCHEMA_VERSION = 12


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
    async def open(cls, url: str | None = None, *, create_all: bool = False) -> Store:
        """按 URL 建引擎。URL 为空 → 内存模式，**不抛异常**。

        Args:
            create_all: 直接建表而不跑 PostgreSQL 迁移。用于零配置 SQLite
                （以及测试）；Postgres 上一律走 ``migrations/``，否则线上 schema
                的来源就有两个。
        """
        url = database_url() if url is None else url
        if not url:
            return cls(mode="memory")

        # SQLAlchemy/aiosqlite 是零配置持久化的基础依赖；这里仍延迟导入，避免
        # 显式内存模式为永远用不到的数据库组件付启动成本。
        from sqlalchemy.ext.asyncio import create_async_engine

        kw: dict[str, Any] = {"pool_pre_ping": True, "future": True}
        if url.startswith("postgresql"):
            kw |= {"pool_size": int(os.getenv("DB_POOL_SIZE", DEFAULT_POOL_SIZE)),
                   "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", DEFAULT_MAX_OVERFLOW)),
                   "pool_recycle": 1800}
        else:
            import sqlalchemy as sa
            from sqlalchemy.pool import NullPool, StaticPool

            # **单连接只对内存库成立。** 内存库必须共享一个连接，否则每个连接看到
            # 的是不同的库。但这个 else 分支同时也接住了零配置默认的**文件**库
            # （sqlite+aiosqlite:///workspace/ontocopilot.db），而 StaticPool 没有
            # 借出上限：它把同一个 DBAPI 连接同时交给每一个并发 checkout。
            #
            # 后果不是变慢，是**静默丢数据**：SSE 每 250ms 轮询一次 read_events，
            # 聊天那边在写事件，两者跑在同一个连接上，事务边界互相穿插 —— 一方的
            # ROLLBACK 会把另一方正在进行的写作废。实测 session.next_event_seq 被
            # 回退到已提交行的后面，于是下一次 append_event 分配到一个用过的 seq、
            # 撞 UNIQUE 约束，重试 5 次全撞同一个号，事件永远落不了库。而 SSE 只
            # 推库里的行 —— 助手的回答就这样从界面上消失，刷新才看得到（对话记忆
            # 是另一条路存的）。
            memory = ":memory:" in url or "mode=memory" in url
            kw |= ({"poolclass": StaticPool,
                    "connect_args": {"check_same_thread": False}} if memory
                   else {"poolclass": NullPool,
                         "connect_args": {"check_same_thread": False, "timeout": 30}})

        engine = create_async_engine(url, **kw)
        if not url.startswith("postgresql"):
            file_backed = not (":memory:" in url or "mode=memory" in url)

            # SQLite defaults foreign_keys to OFF *per connection*.  Merely declaring
            # ON DELETE CASCADE in metadata therefore leaves orphaned state/files/runs
            # in the zero-config production mode unless every pooled connection opts in.
            @sa.event.listens_for(engine.sync_engine, "connect")
            def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
                cursor = dbapi_connection.cursor()
                try:
                    cursor.execute("PRAGMA foreign_keys=ON")
                    if file_backed:
                        # 现在是真的多连接了，得让它们能好好共处：WAL 让读不再挡写
                        # （SSE 一直在轮询读），busy_timeout 让偶发争用等一下而不是
                        # 直接抛 "database is locked"。
                        cursor.execute("PRAGMA journal_mode=WAL")
                        cursor.execute("PRAGMA busy_timeout=30000")
                finally:
                    cursor.close()
        store = cls(mode="postgres" if url.startswith("postgresql") else "sqlite",
                    engine=engine, url=url)
        if create_all:
            from .schema import metadata
            if store.mode == "sqlite":
                # Parent-table rebuilds require FK enforcement to be disabled *before*
                # the transaction starts; PRAGMA foreign_keys is a no-op mid-transaction.
                async with engine.connect() as conn:
                    await conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
                    await conn.commit()
                    try:
                        async with conn.begin():
                            await _upgrade_sqlite_compat(conn)
                            await conn.run_sync(metadata.create_all)
                            await conn.exec_driver_sql(
                                f"PRAGMA user_version={SQLITE_SCHEMA_VERSION}")
                    finally:
                        await conn.exec_driver_sql("PRAGMA foreign_keys=ON")
                        await conn.commit()
            else:
                async with engine.begin() as conn:
                    await conn.run_sync(metadata.create_all)
        return store

    async def close(self) -> None:
        if self.engine is not None:
            await self.engine.dispose()

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator[Store]:
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
                if self.mode == "sqlite":
                    # SQLite 走 create_all + compatibility upgrader，没有逐条写
                    # schema_migration；它的权威版本标记是 PRAGMA user_version。
                    v = (await conn.exec_driver_sql("PRAGMA user_version")).scalar()
                else:
                    v = (await conn.execute(sa.text(
                        "SELECT COALESCE(MAX(version), 0) FROM schema_migration"))).scalar()
            return {"mode": self.mode, "ok": True, "schema_version": int(v or 0)}
        except Exception as exc:  # noqa: BLE001 — 健康检查要报出原因，不能吞
            return {"mode": self.mode, "ok": False, "error": f"{type(exc).__name__}: {exc}"}


async def _upgrade_sqlite_compat(conn: Any) -> None:
    """Upgrade zero-config SQLite databases created by pre-migration releases.

    SQLAlchemy ``create_all`` only creates missing tables; it never adds columns or
    replaces CHECK constraints.  Keep this narrowly scoped compatibility upgrader for
    the local single-process database.  PostgreSQL remains governed exclusively by the
    checksum-protected SQL migration catalog.
    """
    tables = set((await conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type='table'",
    )).scalars())
    if "session" not in tables:
        return

    session_columns = {str(row[1]) for row in (await conn.exec_driver_sql(
        'PRAGMA table_info("session")',
    )).all()}
    # 0004 is a nullable, constraint-free column and can be added safely in place.
    if "owner" not in session_columns:
        await conn.exec_driver_sql('ALTER TABLE "session" ADD COLUMN owner TEXT')
        session_columns.add("owner")

    # 0006: SQLite cannot ALTER a named CHECK constraint.  Rebuild only when the stored
    # CREATE SQL still lacks queued/stopped; preserve every existing session column/data.
    session_sql = str((await conn.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session'",
    )).scalar_one_or_none() or "")
    if "queued" not in session_sql or "stopped" not in session_sql:
        columns = [str(row[1]) for row in (await conn.exec_driver_sql(
            'PRAGMA table_info("session")',
        )).all()]
        required = {
            "id", "title", "project", "status", "error", "state_version",
            "next_event_seq", "next_run_ordinal", "next_decision_ordinal",
            "created_at", "updated_at", "owner",
        }
        # Only rebuild the known production shape.  An unknown/custom schema must fail
        # visibly instead of silently dropping columns during a best-effort copy.
        if set(columns) != required:
            raise RuntimeError(
                "SQLite session 表需要升级，但列结构不是受支持的历史版本："
                + ",".join(columns))
        await conn.exec_driver_sql("""
                CREATE TABLE session__upgrade (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '新建会话',
                    project TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'idle',
                    error TEXT NOT NULL DEFAULT '',
                    state_version BIGINT NOT NULL DEFAULT 0,
                    next_event_seq BIGINT NOT NULL DEFAULT 0,
                    next_run_ordinal INTEGER NOT NULL DEFAULT 0,
                    next_decision_ordinal INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    owner TEXT,
                    CONSTRAINT session_status_ck CHECK (status IN (
                        'idle','queued','parsing','extracting','awaiting_answer',
                        'done','failed','stopped'))
                )
            """)
        quoted = ",".join(f'"{name}"' for name in columns)
        await conn.exec_driver_sql(
            f'INSERT INTO session__upgrade ({quoted}) SELECT {quoted} FROM "session"')
        await conn.exec_driver_sql('DROP TABLE "session"')
        await conn.exec_driver_sql('ALTER TABLE session__upgrade RENAME TO "session"')

    # 0007: add durable event retry identity and its partial unique index.
    if "session_event" in tables:
        event_columns = {str(row[1]) for row in (await conn.exec_driver_sql(
            'PRAGMA table_info("session_event")',
        )).all()}
        if "event_id" not in event_columns:
            await conn.exec_driver_sql(
                'ALTER TABLE "session_event" ADD COLUMN event_id TEXT')
        await conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS session_event_event_id_uq "
            "ON session_event (event_id) WHERE event_id IS NOT NULL")

    # 0012: display_name is NOT NULL with a default, which SQLite can add in place.
    # create_all below only creates missing *tables* —— an existing app_user would keep
    # its old shape forever and every read would fail with "no such column".
    if "app_user" in tables:
        user_columns = {str(row[1]) for row in (await conn.exec_driver_sql(
            'PRAGMA table_info("app_user")',
        )).all()}
        if "display_name" not in user_columns:
            await conn.exec_driver_sql(
                'ALTER TABLE "app_user" ADD COLUMN display_name TEXT NOT NULL '
                "DEFAULT ''")

    # create_all immediately after this function supplies the append-only tables/indexes
    # introduced in 0008–0011. Running this first lets us distinguish old DBs.
