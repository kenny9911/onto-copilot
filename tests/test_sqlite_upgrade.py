"""Existing zero-config SQLite files are upgraded in place, not merely create_all'd."""

from __future__ import annotations

import sqlite3

from ontocopilot.store.engine import SQLITE_SCHEMA_VERSION, Store
from ontocopilot.store.repo import build_repo


def _create_pre_0006_database(path) -> None:
    db = sqlite3.connect(path)
    try:
        db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE session (
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
                CONSTRAINT session_status_ck CHECK (status IN (
                    'idle','parsing','extracting','awaiting_answer','done','failed'))
            );
            CREATE TABLE session_event (
                session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
                seq BIGINT NOT NULL,
                kind TEXT NOT NULL,
                payload JSON NOT NULL DEFAULT '{}',
                ref TEXT,
                ts FLOAT NOT NULL,
                PRIMARY KEY (session_id, seq)
            );
            INSERT INTO session (
                id,title,project,status,error,state_version,next_event_seq,
                next_run_ordinal,next_decision_ordinal
            ) VALUES ('old','历史会话','P-1','idle','',0,1,0,0);
            INSERT INTO session_event (session_id,seq,kind,payload,ts)
            VALUES ('old',0,'old.created','{"kept":true}',1.0);
        """)
        db.commit()
    finally:
        db.close()


async def test_existing_sqlite_is_upgraded_and_data_remains_usable(tmp_path):
    path = tmp_path / "old.db"
    _create_pre_0006_database(path)
    store = await Store.open(
        f"sqlite+aiosqlite:///{path}", create_all=True,
    )
    repo = build_repo(store)
    try:
        row = await repo.get_session("old")
        assert (row.title, row.project, row.owner) == ("历史会话", "P-1", "")
        historical = await repo.read_events("old")
        assert historical[0].payload == {"kept": True}

        appended = await repo.append_event(
            "old", "new.event", {"after": "upgrade"}, event_id="evt-after-upgrade",
        )
        assert appended.seq == 1
        assert await repo.claim_build_lease(
            "old", owner="worker:new", now=10.0, ttl=30.0,
            from_statuses=("idle",),
        )
        assert await repo.request_build_cancel("old", now=11.0)
        assert (await repo.get_session("old")).status == "stopped"
        assert await repo.claim_chat_lease(
            "old", owner="worker:chat", now=12.0, ttl=30.0,
        )

        async with store.engine.connect() as conn:
            columns = {str(r[1]) for r in (await conn.exec_driver_sql(
                'PRAGMA table_info("session_event")',
            )).all()}
            assert "event_id" in columns
            assert (await conn.exec_driver_sql("PRAGMA foreign_keys")).scalar_one() == 1
            assert ((await conn.exec_driver_sql("PRAGMA user_version")).scalar_one()
                    == SQLITE_SCHEMA_VERSION)
    finally:
        await store.close()


def _create_database_with_nameless_accounts(path) -> None:
    """0011 那一代的库：有 app_user，但还没有 display_name 列。"""
    db = sqlite3.connect(path)
    try:
        db.executescript("""
            CREATE TABLE app_user (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                active BOOLEAN NOT NULL DEFAULT 1,
                prefs JSON NOT NULL DEFAULT '{}',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新建会话',
                project TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'idle',
                error TEXT NOT NULL DEFAULT '',
                state_version BIGINT NOT NULL DEFAULT 0,
                next_event_seq BIGINT NOT NULL DEFAULT 0,
                next_run_ordinal INTEGER NOT NULL DEFAULT 0,
                next_decision_ordinal INTEGER NOT NULL DEFAULT 0,
                owner TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT session_status_ck CHECK (status IN (
                    'idle','queued','parsing','extracting','awaiting_answer',
                    'done','failed','stopped'))
            );
            INSERT INTO app_user (id,username,password_hash,role)
            VALUES ('u-old','yuhan','scrypt$x','admin');
        """)
        db.commit()
    finally:
        db.close()


async def test_existing_accounts_get_the_display_name_column(tmp_path):
    """`create_all` 只建缺表、**从不加列** —— 存量库不升级的话，登录第一步就
    `no such column: app_user.display_name`。开发机上那个库正是这一代。
    """
    path = tmp_path / "accounts.db"
    _create_database_with_nameless_accounts(path)
    store = await Store.open(f"sqlite+aiosqlite:///{path}", create_all=True)
    repo = build_repo(store)
    try:
        old = await repo.get_user("u-old")
        assert old is not None
        assert old.display_name == ""          # 老账号没名字，回落到 username 展示
        async with store.engine.connect() as conn:
            columns = {str(r[1]) for r in (await conn.exec_driver_sql(
                'PRAGMA table_info("app_user")')).all()}
            assert "display_name" in columns
    finally:
        await store.close()
