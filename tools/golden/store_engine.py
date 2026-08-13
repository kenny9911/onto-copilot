"""把 store/engine.py 的 SQLite 建库路径导成 golden，给 TS 侧 engine.ts 当安全网。

engine.py 之前没有 golden。它的行为里有三块**必须逐位对齐**、手写期望值必然写错：

1. ``database_url()`` 的规范化（``postgres://`` / ``postgresql://`` → ``+asyncpg``）；
2. ``metadata.create_all`` 在 SQLite 上建出来的**库形状** —— 列类型、NOT NULL、
   server_default 的**渲染文本**（``BIGINT DEFAULT '0'`` 是带引号的，
   ``BOOLEAN DEFAULT 0`` 不带）、主键位置、外键、索引（含部分索引的谓词）；
3. ``_upgrade_sqlite_compat`` 把**老库**升级成什么样 —— 包括几个反直觉的后果，
   比如 session 表重建之后 create_all 会因为"表已存在"而**不再补 session_project_idx**。

所以这里存的不是我对 engine.py 的理解，是它真跑出来的 ``PRAGMA`` 快照：
``table_info`` / ``index_list`` / ``index_info`` / ``foreign_key_list`` + 原始
``sqlite_master.sql``。TS 侧用自己的 DDL 生成器建一遍，比对同样的 PRAGMA 快照。
（**只比对 PRAGMA、不比对 DDL 文本**：TS 侧给所有标识符都加引号，而 SQLAlchemy 只给
保留字加 —— 那是同一个库的两种写法，PRAGMA 才是"库到底长什么样"的权威回答。）

跑法::

    .venv/bin/python tools/golden/store_engine.py

字节确定：无时间戳、无随机、无绝对路径（临时目录只在过程里存在，不进 JSON）；
表/索引/外键全部按名字排序。重跑两次哈希必须一致。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.store.engine import (  # noqa: E402
    DEFAULT_MAX_OVERFLOW,
    DEFAULT_POOL_SIZE,
    SQLITE_SCHEMA_VERSION,
    Store,
    database_url,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"

# ── database_url() 的规范化用例 ────────────────────────────────────────────
# env 一律显式给全（不读进程环境），否则导出结果会随开发机的环境变量漂移。
URL_CASES: list[dict[str, str]] = [
    {},
    {"DATABASE_URL": ""},
    {"DATABASE_URL": "   "},
    {"DATABASE_URL": "  postgres://u:p@h:5432/db  "},          # 前后空白要被 strip
    {"DATABASE_URL": "postgres://u:p@h/db"},
    {"DATABASE_URL": "postgresql://u:p@h/db"},
    {"DATABASE_URL": "postgresql+asyncpg://u:p@h/db"},         # 已经带 driver，不再叠加
    {"DATABASE_URL": "postgresql+psycopg://u:p@h/db"},         # 别的 driver 也不动
    {"DATABASE_URL": "sqlite+aiosqlite:////tmp/x.db"},
    {"DATABASE_URL": "sqlite+aiosqlite:///:memory:"},
    {"DATABASE_URL": "sqlite:///rel.db"},
    # 大小写：Python 侧是 startswith 精确匹配，"Postgres://" 不会被规范化。
    {"DATABASE_URL": "Postgres://u@h/db"},
    # 密码里带 '@'、query string —— 只做前缀替换，其余原样透传。
    {"DATABASE_URL": "postgres://u:p@ss@h/db?sslmode=require"},
]

# ── 老库（迁移前的形态）──────────────────────────────────────────────────
# 手写的是**输入**（老版本发布出去的表长什么样），期望值仍然由 Python 跑出来。
# session：没有 owner（0004 之前）、没有 project_id（0013 之前）、
#          CHECK 里没有 queued/stopped（0006 之前）→ 三条补丁全都要触发。
LEGACY_SESSION = """
CREATE TABLE session (
    id TEXT NOT NULL,
    title TEXT DEFAULT '新建会话' NOT NULL,
    project TEXT DEFAULT '' NOT NULL,
    status TEXT DEFAULT 'idle' NOT NULL,
    error TEXT DEFAULT '' NOT NULL,
    state_version BIGINT DEFAULT '0' NOT NULL,
    next_event_seq BIGINT DEFAULT '0' NOT NULL,
    next_run_ordinal INTEGER DEFAULT '0' NOT NULL,
    next_decision_ordinal INTEGER DEFAULT '0' NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT session_status_ck CHECK (status IN ('idle','parsing','extracting',
        'awaiting_answer','done','failed'))
)
"""
# session_event：没有 event_id（0007 之前），也没有那条部分唯一索引。
LEGACY_SESSION_EVENT = """
CREATE TABLE session_event (
    session_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    kind TEXT NOT NULL,
    payload JSON DEFAULT '{}' NOT NULL,
    ref TEXT,
    ts FLOAT NOT NULL,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY(session_id) REFERENCES session (id) ON DELETE CASCADE
)
"""
# app_user：没有 display_name（0012 之前）。
LEGACY_APP_USER = """
CREATE TABLE app_user (
    id TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user' NOT NULL,
    active BOOLEAN DEFAULT 1 NOT NULL,
    prefs JSON DEFAULT '{}' NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT app_user_role_ck CHECK (role IN ('admin','user')),
    UNIQUE (username)
)
"""


def legacy_setup_sql(*, extra_column: bool) -> list[str]:
    """老库的建库语句。**一起导进 golden** —— TS 侧照着这份跑，两边的输入才真是同一份
    （把这几段 SQL 在测试里再手抄一遍，就又开了一个漂移的口子）。"""
    out = [LEGACY_SESSION.strip(), LEGACY_SESSION_EVENT.strip(),
           LEGACY_APP_USER.strip()]
    if extra_column:
        # 未知列 → 重建分支必须**显式失败**，不许 best-effort 拷贝时悄悄丢列。
        out.append('ALTER TABLE session ADD COLUMN weird TEXT')
    out += [
        "INSERT INTO session (id,title,project,status,error,state_version,"
        "next_event_seq,next_run_ordinal,next_decision_ordinal,"
        "created_at,updated_at) VALUES "
        "('s1','旧会话','P','done','',7,42,3,2,"
        "'2024-01-02 03:04:05','2024-01-02 03:04:06')",
        "INSERT INTO session_event (session_id,seq,kind,payload,ref,ts) "
        "VALUES ('s1',0,'session.created','{\"a\":1}',NULL,1700000000.5)",
        # created_at/updated_at 必须显式给：它们的 server_default 是 CURRENT_TIMESTAMP，
        # 让库去填的话这份 golden 就不是字节确定的了（同一秒里重跑看不出来，跨秒重跑
        # 才炸 —— 这类不确定性最难发现，所以宁可把时间钉死）。
        "INSERT INTO app_user (id,username,password_hash,created_at,updated_at) "
        "VALUES ('u1','alice','scrypt$x',"
        "'2024-01-02 03:04:07','2024-01-02 03:04:08')",
    ]
    return out


def build_legacy(path: Path, sql: list[str]) -> None:
    con = sqlite3.connect(path)
    try:
        for stmt in sql:
            con.execute(stmt)
        con.commit()
    finally:
        con.close()


def dump(path: Path) -> dict[str, Any]:
    """库的 PRAGMA 快照。**这就是"建成什么样"的权威回答**，两侧比对它。"""
    con = sqlite3.connect(path)
    try:
        cur = con.cursor()
        user_version = cur.execute("PRAGMA user_version").fetchone()[0]
        names = sorted(
            r[0] for r in cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")
            if not r[0].startswith("sqlite_"))
        tables: dict[str, Any] = {}
        for t in names:
            cols = [
                {"cid": r[0], "name": r[1], "type": r[2],
                 "notnull": r[3], "dflt_value": r[4], "pk": r[5]}
                for r in cur.execute(f'PRAGMA table_info("{t}")')
            ]
            fks = sorted(
                ({"table": r[2], "from": r[3], "to": r[4],
                  "on_update": r[5], "on_delete": r[6], "match": r[7]}
                 for r in cur.execute(f'PRAGMA foreign_key_list("{t}")')),
                key=lambda d: (d["table"], d["from"] or ""))
            idx = []
            # fetchall 先收干净：sqlite3 的同一个 cursor 被内层 execute 一冲就
            # 断流，外层只会读到第一行（这份 golden 第一版就栽在这里，两次导出
            # 的索引各剩一条且不是同一条）。
            for r in cur.execute(f'PRAGMA index_list("{t}")').fetchall():
                # r = (seq, name, unique, origin, partial)；seq 跟建表顺序绑，
                # 两侧的建表顺序不必相同，所以不导 seq。
                idx.append({
                    "name": r[1], "unique": r[2], "origin": r[3], "partial": r[4],
                    "columns": [c[2] for c in
                                cur.execute(f'PRAGMA index_info("{r[1]}")').fetchall()],
                })
            idx.sort(key=lambda d: d["name"])
            sql = cur.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                (t,)).fetchone()[0]
            tables[t] = {"columns": cols, "foreign_keys": fks, "indexes": idx,
                         "sql": sql}
        return {"user_version": user_version, "tables": tables}
    finally:
        con.close()


def dump_rows(path: Path) -> dict[str, Any]:
    """老库升级之后**数据还在不在**。重建 session 表那一步最容易把数据弄丢。"""
    con = sqlite3.connect(path)
    try:
        cur = con.cursor()
        out: dict[str, Any] = {}
        for t, order in (("session", "id"), ("session_event", "seq"),
                         ("app_user", "id")):
            cur.execute(f'SELECT * FROM "{t}" ORDER BY {order}')
            cols = [d[0] for d in cur.description]
            out[t] = [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
        return out
    finally:
        con.close()


async def open_and_dump(db: Path) -> dict[str, Any]:
    store = await Store.open(f"sqlite+aiosqlite:///{db}", create_all=True)
    try:
        health = await store.healthcheck()
    finally:
        await store.close()
    snap = dump(db)
    snap["healthcheck"] = health
    snap["mode"] = store.mode
    return snap


async def open_expect_error(db: Path) -> dict[str, Any]:
    try:
        store = await Store.open(f"sqlite+aiosqlite:///{db}", create_all=True)
    except Exception as exc:  # noqa: BLE001 —— 就是要把它的类型和文本钉住
        return {"type": type(exc).__name__, "message": str(exc)}
    await store.close()
    raise AssertionError("期望升级失败，但它成功了")


async def memory_health() -> dict[str, Any]:
    store = await Store.open("")
    out = {"mode": store.mode, "enabled": store.enabled,
           "healthcheck": await store.healthcheck()}
    await store.close()
    return out


async def collect() -> dict[str, Any]:
    tmp = Path(tempfile.mkdtemp(prefix="ontocopilot-golden-"))
    try:
        fresh = await open_and_dump(tmp / "fresh.db")

        legacy_sql = legacy_setup_sql(extra_column=False)
        legacy_db = tmp / "legacy.db"
        build_legacy(legacy_db, legacy_sql)
        legacy = await open_and_dump(legacy_db)
        legacy["rows"] = dump_rows(legacy_db)
        legacy["setup_sql"] = legacy_sql

        unknown_sql = legacy_setup_sql(extra_column=True)
        unknown_db = tmp / "unknown.db"
        build_legacy(unknown_db, unknown_sql)
        unknown = await open_expect_error(unknown_db)
        unknown["setup_sql"] = unknown_sql

        # 已经是新形态的库再开一次：三条补丁都不该动它，结果必须与 fresh 完全一致
        # （create_all 的幂等性 + 升级器不误伤）。
        again = await open_and_dump(tmp / "fresh.db")
        return {
            "constants": {
                "DEFAULT_POOL_SIZE": DEFAULT_POOL_SIZE,
                "DEFAULT_MAX_OVERFLOW": DEFAULT_MAX_OVERFLOW,
                "SQLITE_SCHEMA_VERSION": SQLITE_SCHEMA_VERSION,
            },
            "database_url": [
                {"env": env, "out": database_url(env)} for env in URL_CASES
            ],
            "memory": await memory_health(),
            "fresh": fresh,
            "reopen": again,
            "legacy": legacy,
            "legacy_unknown_schema": unknown,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    payload = asyncio.run(collect())
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "store.engine.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  store.engine.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    main()
