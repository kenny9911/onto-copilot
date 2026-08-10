"""仓储层。

**形状：Protocol + 两个实现，不是模块级函数。**
模块级函数没法在没有数据库的时候被换掉 —— 而"没有数据库时照常工作"是硬要求，
所以可替换性必须在类型里，不能靠 monkeypatch。两个实现：

  * :class:`PgRepo` —— SQLAlchemy Core，跑 Postgres（测试里也跑 SQLite）；
  * :class:`MemoryRepo` —— 就是现在的 ``SESSIONS: dict``，包了一层同样的接口。

**事务边界：一次业务动作一个事务，由仓储方法自己开。**
路由不持有连接、不显式 begin/commit。理由是这个服务里真正需要跨方法原子性的
只有一处 —— "改完 OIR 之后把 oir/conflicts/questions/suggestions 一起落库"，
而它本来就该是**一个**方法（:meth:`save_state`），不是四个调用凑出来的事务。
把边界画在方法上，就没有"忘了 commit"这种 bug 可写。

真正需要跨方法原子的场合走 :meth:`atomic`（一个 ``AsyncConnection``
的显式作用域），目前只有 ``_run_pipeline`` 收尾用。

**一致性靠 state_version。** 每次 :meth:`save_state` 在同一事务里
``UPDATE session SET state_version = state_version + 1 ... RETURNING``（行锁），
所有写入的行都带上这个新版本号。这样就不可能出现现在这种
"磁盘上的 oir.json 是新的、/state 拿到的 s.state['oir'] 是旧的"
（_compile 写 oir.json 却不刷 s.state["oir"]，server.py:452 vs 466）。
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import AsyncIterator, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .const import DERIVED_KEYS, EVENT_INLINE_LIMIT


# ══════════════════════════════════════════════════════════════════
#  传输对象
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class SessionRow:
    """会话元数据。字段和 ``Session.brief()``（server.py:115-118）一一对应。"""

    id: str
    title: str = "新建会话"
    project: str = ""
    status: str = "idle"
    error: str = ""
    created: float = 0.0
    state_version: int = 0

    def brief(self, *, files: int = 0) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "project": self.project,
                "status": self.status, "files": files, "created": self.created,
                "error": self.error}


@dataclass(slots=True)
class FileRow:
    name: str
    rel_path: str
    size: int
    sha256: str = ""


@dataclass(slots=True)
class EventRow:
    seq: int
    kind: str
    payload: dict[str, Any]
    ts: float

    def as_sse(self) -> dict[str, Any]:
        """还原成 Session.emit 产出的那个扁平 dict（server.py:109）。"""
        return {"seq": self.seq, "ts": self.ts, **self.payload, "kind": self.kind}


@dataclass(slots=True)
class DecisionRow:
    ordinal: int
    kind: str
    statement: str = ""
    scope_refs: list[str] = field(default_factory=list)
    turn_index: int = -1
    superseded_by: int | None = None
    target_rid: str = ""
    option_id: str = ""
    changed: list[Any] = field(default_factory=list)
    note: str = ""
    ts: float = 0.0

    @property
    def active(self) -> bool:
        return self.superseded_by is None

    def to_dialogue_dict(self) -> dict[str, Any]:
        """喂给 ``DialogueMemory.from_dict``（dialogue.py:305）的形状。

        它读的键正好是 kind / statement / scope_refs / turn / ts / superseded_by。
        """
        return {"kind": self.kind, "statement": self.statement,
                "scope_refs": self.scope_refs, "turn": self.turn_index,
                "ts": self.ts, "superseded_by": self.superseded_by}


@dataclass(slots=True)
class UserRow:
    """账号。``password_hash`` 只进不出 —— :meth:`public` 绝不带它。"""

    id: str
    username: str
    password_hash: str
    role: str = "user"          # admin | user
    active: bool = True
    prefs: dict[str, Any] = field(default_factory=dict)
    created: float = 0.0

    def public(self) -> dict[str, Any]:
        """给列表/管理页看的安全投影。**永不含 password_hash / prefs 之外的内部字段。**"""
        return {"id": self.id, "username": self.username, "role": self.role,
                "active": self.active, "created": self.created}


@dataclass(slots=True)
class AuthSessionRow:
    """登录会话。主键是令牌的 sha256（``token_hash``），不是令牌本身。"""

    token_hash: str
    user_id: str
    created: float = 0.0
    last_seen: float = 0.0
    expires: float = 0.0


class DuplicateUsername(ValueError):
    """用户名（或 id）已存在。两个实现都抛它，路由层统一映射成 409。"""


# ══════════════════════════════════════════════════════════════════
#  接口
# ══════════════════════════════════════════════════════════════════
@runtime_checkable
class Repo(Protocol):
    """会话仓储。**所有方法都是一个完整事务**（除 :meth:`atomic` 作用域内）。"""

    mode: str

    async def create_session(self, row: SessionRow) -> SessionRow: ...
    async def get_session(self, sid: str) -> SessionRow | None: ...
    async def list_sessions(self, limit: int = 100) -> list[SessionRow]: ...
    async def set_status(self, sid: str, status: str, *, error: str = "") -> None: ...
    async def delete_session(self, sid: str) -> bool: ...

    async def add_files(self, sid: str, files: Sequence[FileRow]) -> list[FileRow]: ...
    async def list_files(self, sid: str) -> list[FileRow]: ...

    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = ()) -> int: ...
    async def load_state(self, sid: str, *, keys: Iterable[str] | None = None,
                         include_derived: bool = True) -> dict[str, Any]: ...
    async def list_conflicts(self, sid: str) -> list[dict[str, Any]]: ...
    async def get_conflict(self, sid: str, rid: str) -> dict[str, Any] | None: ...

    async def record_decision(self, sid: str, d: DecisionRow) -> DecisionRow: ...
    async def list_decisions(self, sid: str, *, active_only: bool = False
                             ) -> list[DecisionRow]: ...
    async def answered_rids(self, sid: str) -> set[str]: ...

    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any]) -> EventRow: ...
    async def read_events(self, sid: str, since: int = 0) -> list[EventRow]: ...
    async def count_events(self, sid: str) -> int: ...

    async def next_run(self, sid: str, kind: str) -> str: ...
    async def finish_run(self, run_id: str, *, status: str, error: str = "",
                         budget: dict[str, Any] | None = None) -> None: ...

    # 账号与登录会话（鉴权层）—— 顶层表，不随建模会话级联。
    async def create_user(self, row: UserRow) -> UserRow: ...
    async def get_user(self, uid: str) -> UserRow | None: ...
    async def get_user_by_username(self, username: str) -> UserRow | None: ...
    async def list_users(self) -> list[UserRow]: ...
    async def count_users(self) -> int: ...
    async def update_user(self, uid: str, *, role: str | None = None,
                          active: bool | None = None,
                          password_hash: str | None = None,
                          prefs: dict[str, Any] | None = None) -> UserRow | None: ...
    async def delete_user(self, uid: str) -> bool: ...

    async def create_auth_session(self, row: AuthSessionRow) -> AuthSessionRow: ...
    async def get_auth_session(self, token_hash: str) -> AuthSessionRow | None: ...
    async def delete_auth_session(self, token_hash: str) -> bool: ...
    async def delete_user_auth_sessions(self, uid: str) -> int: ...
    async def prune_auth_sessions(self, *, now: float) -> int: ...

    def atomic(self) -> Any: ...


# ══════════════════════════════════════════════════════════════════
#  内存实现 —— 没配 DATABASE_URL 时的那条路
# ══════════════════════════════════════════════════════════════════
class MemoryRepo:
    """把现在的 ``SESSIONS: dict[str, Session]``（server.py:121）关进接口里。

    行为刻意和 Postgres 版**一模一样**（同样的 state_version 递增、同样的
    answered 去重、同样的 seq 发号），这样 tests/test_store.py 那套用例
    可以原样跑两遍。不一样的只有一点：进程退出即消失 —— 这正是它的定位。
    """

    mode = "memory"

    def __init__(self) -> None:
        self._sessions: dict[str, SessionRow] = {}
        self._files: dict[str, dict[str, FileRow]] = {}
        self._state: dict[str, dict[str, Any]] = {}
        self._conflicts: dict[str, dict[str, dict[str, Any]]] = {}
        self._decisions: dict[str, list[DecisionRow]] = {}
        self._events: dict[str, list[EventRow]] = {}
        self._runs: dict[str, dict[str, Any]] = {}
        #: 账号与登录会话。**顶层**，与建模会话无关 —— 故意不进 delete_session 的
        #  清理元组（那是按建模会话清的，扫到这里会误删所有账号）。
        self._users: dict[str, UserRow] = {}
        self._auth: dict[str, AuthSessionRow] = {}

    # ── 会话 ─────────────────────────────────────────────────────
    async def create_session(self, row: SessionRow) -> SessionRow:
        if row.id in self._sessions:
            raise KeyError(f"会话已存在: {row.id}")
        row.created = row.created or time.time()
        self._sessions[row.id] = row
        self._files.setdefault(row.id, {})
        self._state.setdefault(row.id, {})
        self._conflicts.setdefault(row.id, {})
        self._decisions.setdefault(row.id, [])
        self._events.setdefault(row.id, [])
        return row

    async def get_session(self, sid: str) -> SessionRow | None:
        return self._sessions.get(sid)

    async def list_sessions(self, limit: int = 100) -> list[SessionRow]:
        return sorted(self._sessions.values(), key=lambda s: -s.created)[:limit]

    async def set_status(self, sid: str, status: str, *, error: str = "") -> None:
        s = self._sessions[sid]
        s.status, s.error = status, error

    async def delete_session(self, sid: str) -> bool:
        """删掉一个会话的**全部**痕迹。返回它本来在不在。

        删干净很重要：留下孤儿状态或孤儿事件的话，下次建一个同 id 的会话会
        莫名其妙地继承它们。id 是随机的所以概率低，但低概率的脏数据最难查。
        """
        if sid not in self._sessions:
            return False
        for d in (self._sessions, self._files, self._state, self._conflicts,
                  self._decisions, self._events):
            d.pop(sid, None)
        return True

    # ── 文件 ─────────────────────────────────────────────────────
    async def add_files(self, sid: str, files: Sequence[FileRow]) -> list[FileRow]:
        bag = self._files.setdefault(sid, {})
        for f in files:
            bag[f.name] = f          # 同名覆盖，和 PG 的 ON CONFLICT DO UPDATE 一致
        return list(bag.values())

    async def list_files(self, sid: str) -> list[FileRow]:
        return list(self._files.get(sid, {}).values())

    # ── 状态 ─────────────────────────────────────────────────────
    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = ()) -> int:
        s = self._sessions[sid]
        s.state_version += 1
        self._state.setdefault(sid, {}).update(docs)
        if conflicts is not None:
            ranks = {r: i for i, r in enumerate(asked_rids)}
            self._conflicts[sid] = {
                c["rid"]: {**c, "_asked": c["rid"] in ranks,
                           "_ask_rank": ranks.get(c["rid"]), "_version": s.state_version}
                for c in conflicts
            }
        return s.state_version

    async def load_state(self, sid: str, *, keys: Iterable[str] | None = None,
                         include_derived: bool = True) -> dict[str, Any]:
        bag = dict(self._state.get(sid, {}))
        if keys is not None:
            want = set(keys)
            bag = {k: v for k, v in bag.items() if k in want}
        if not include_derived:
            bag = {k: v for k, v in bag.items() if k not in DERIVED_KEYS}
        return bag

    async def list_conflicts(self, sid: str) -> list[dict[str, Any]]:
        return [_strip(c) for c in self._conflicts.get(sid, {}).values()]

    async def get_conflict(self, sid: str, rid: str) -> dict[str, Any] | None:
        c = self._conflicts.get(sid, {}).get(rid)
        return _strip(c) if c else None

    # ── 决定 ─────────────────────────────────────────────────────
    async def record_decision(self, sid: str, d: DecisionRow) -> DecisionRow:
        bag = self._decisions.setdefault(sid, [])
        d.ordinal = len(bag)
        d.ts = d.ts or time.time()
        for old in bag:
            if not old.active:
                continue
            # 和 DialogueMemory.decide（dialogue.py:203-208）同一条规则：
            # 同类型 + 同作用域 = 后者推翻前者。ANSWER 额外按 target_rid 收敛，
            # 这就是 PG 那条部分唯一索引 decision_live_answer_uq 的等价物。
            same_scope = sorted(old.scope_refs) == sorted(d.scope_refs)
            if old.kind == d.kind and (
                (d.kind == "answer" and old.target_rid == d.target_rid)
                or (d.kind != "answer" and same_scope)
            ):
                old.superseded_by = d.ordinal
        bag.append(d)
        return d

    async def list_decisions(self, sid: str, *, active_only: bool = False
                             ) -> list[DecisionRow]:
        bag = self._decisions.get(sid, [])
        return [d for d in bag if d.active] if active_only else list(bag)

    async def answered_rids(self, sid: str) -> set[str]:
        return {d.target_rid for d in self._decisions.get(sid, [])
                if d.kind == "answer" and d.active and d.target_rid}

    # ── 事件 ─────────────────────────────────────────────────────
    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any]) -> EventRow:
        bag = self._events.setdefault(sid, [])
        ev = EventRow(seq=len(bag), kind=kind, payload=payload, ts=time.time())
        bag.append(ev)
        return ev

    async def read_events(self, sid: str, since: int = 0) -> list[EventRow]:
        return self._events.get(sid, [])[since:]

    async def count_events(self, sid: str) -> int:
        return len(self._events.get(sid, []))

    # ── Run ──────────────────────────────────────────────────────
    async def next_run(self, sid: str, kind: str) -> str:
        n = sum(1 for r in self._runs.values() if r["session_id"] == sid)
        rid = f"{sid}.{n}"
        self._runs[rid] = {"session_id": sid, "ordinal": n, "kind": kind,
                           "status": "running"}
        return rid

    async def finish_run(self, run_id: str, *, status: str, error: str = "",
                         budget: dict[str, Any] | None = None) -> None:
        self._runs[run_id] |= {"status": status, "error": error,
                               "budget": budget or {}}

    # ── 账号 ─────────────────────────────────────────────────────
    async def create_user(self, row: UserRow) -> UserRow:
        if row.id in self._users:
            raise DuplicateUsername(f"用户 id 已存在: {row.id}")
        if any(u.username == row.username for u in self._users.values()):
            raise DuplicateUsername(f"用户名已存在: {row.username}")
        row.created = row.created or time.time()
        self._users[row.id] = row
        return row

    async def get_user(self, uid: str) -> UserRow | None:
        return self._users.get(uid)

    async def get_user_by_username(self, username: str) -> UserRow | None:
        return next((u for u in self._users.values() if u.username == username), None)

    async def list_users(self) -> list[UserRow]:
        return sorted(self._users.values(), key=lambda u: u.created)

    async def count_users(self) -> int:
        return len(self._users)

    async def update_user(self, uid: str, *, role: str | None = None,
                          active: bool | None = None,
                          password_hash: str | None = None,
                          prefs: dict[str, Any] | None = None) -> UserRow | None:
        u = self._users.get(uid)
        if u is None:
            return None
        if role is not None:
            u.role = role
        if active is not None:
            u.active = active
        if password_hash is not None:
            u.password_hash = password_hash
        if prefs is not None:
            u.prefs = prefs
        return u

    async def delete_user(self, uid: str) -> bool:
        if uid not in self._users:
            return False
        # 手动级联登录会话 == ON DELETE CASCADE。**绝不**把 _users/_auth 加进
        # delete_session 的清理元组 —— 那是按建模会话清的，会误删所有账号。
        for th in [t for t, a in self._auth.items() if a.user_id == uid]:
            self._auth.pop(th, None)
        self._users.pop(uid, None)
        return True

    # ── 登录会话 ─────────────────────────────────────────────────
    async def create_auth_session(self, row: AuthSessionRow) -> AuthSessionRow:
        row.created = row.created or time.time()
        row.last_seen = row.last_seen or row.created
        self._auth[row.token_hash] = row
        return row

    async def get_auth_session(self, token_hash: str) -> AuthSessionRow | None:
        return self._auth.get(token_hash)

    async def delete_auth_session(self, token_hash: str) -> bool:
        return self._auth.pop(token_hash, None) is not None

    async def delete_user_auth_sessions(self, uid: str) -> int:
        gone = [t for t, a in self._auth.items() if a.user_id == uid]
        for t in gone:
            self._auth.pop(t, None)
        return len(gone)

    async def prune_auth_sessions(self, *, now: float) -> int:
        gone = [t for t, a in self._auth.items() if a.expires and a.expires <= now]
        for t in gone:
            self._auth.pop(t, None)
        return len(gone)

    @asynccontextmanager
    async def atomic(self) -> AsyncIterator["MemoryRepo"]:
        """内存里没有事务。**不假装有** —— 半途异常会留下部分写入。

        这正是内存模式的代价，而不是需要被抹平的差异：假装有事务会让人在
        内存模式下写出依赖回滚的代码，切到 Postgres 才发现语义对不上。
        """
        yield self


def _strip(c: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in c.items() if not k.startswith("_")}


# ══════════════════════════════════════════════════════════════════
#  Postgres 实现
# ══════════════════════════════════════════════════════════════════
class PgRepo:
    """SQLAlchemy Core 实现。同一份代码跑 Postgres 与 SQLite。

    方言差异只有一处 —— upsert 的写法。用 ``insert(...).on_conflict_do_update``
    的方言变体，各建一次语句，别的地方一律标准 Core。
    """

    def __init__(self, engine: Any) -> None:
        self._engine = engine
        self.mode = engine.dialect.name          # "postgresql" | "sqlite"

    # ── 连接 ─────────────────────────────────────────────────────
    @asynccontextmanager
    async def atomic(self) -> AsyncIterator[Any]:
        """显式事务作用域。方法内部若已在作用域里就复用，不嵌套开事务。"""
        async with self._engine.begin() as conn:
            yield conn

    def _upsert(self, table: Any, values: dict[str, Any], *, index_elements: list[str],
                update: list[str]):
        if self.mode == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        stmt = insert(table).values(**values)
        return stmt.on_conflict_do_update(
            index_elements=index_elements,
            set_={k: getattr(stmt.excluded, k) for k in update},
        )

    # ── 会话 ─────────────────────────────────────────────────────
    async def create_session(self, row: SessionRow) -> SessionRow:
        from datetime import UTC, datetime

        from . import schema as t
        row.created = row.created or time.time()
        # created_at 必须写调用方给的时间，不能一律 now()。
        # 交给 server_default 的后果是：MemoryRepo 按 row.created 排序、PgRepo 按
        # now() 排序，同一份输入两个实现给出不同顺序 —— 而且只在生产上才看得见。
        async with self._engine.begin() as conn:
            await conn.execute(t.session.insert().values(
                id=row.id, title=row.title, project=row.project,
                status=row.status, error=row.error, state_version=0,
                next_event_seq=0, next_run_ordinal=0,
                created_at=datetime.fromtimestamp(row.created, tz=UTC),
                updated_at=datetime.fromtimestamp(row.created, tz=UTC)))
        return row

    async def get_session(self, sid: str) -> SessionRow | None:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.session).where(
                t.session.c.id == sid))).mappings().first()
        return _session_row(r) if r else None

    async def list_sessions(self, limit: int = 100) -> list[SessionRow]:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            rs = (await conn.execute(sa.select(t.session)
                                     .order_by(t.session.c.created_at.desc())
                                     .limit(limit))).mappings().all()
        return [_session_row(r) for r in rs]

    async def set_status(self, sid: str, status: str, *, error: str = "") -> None:
        from . import schema as t
        async with self._engine.begin() as conn:
            await conn.execute(t.session.update().where(t.session.c.id == sid)
                               .values(status=status, error=error))

    async def delete_session(self, sid: str) -> bool:
        """删会话。子表靠 ON DELETE CASCADE 跟着走。

        显式删子表而不是只信赖 CASCADE 是没必要的重复，但**依赖 CASCADE 就必须
        确认外键真的声明了它** —— 没声明的话这里删完，子表里全是指向不存在会话的
        孤儿行，而且要等到下一次 JOIN 才会暴露。
        """
        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(t.session.delete().where(t.session.c.id == sid))
        return bool(r.rowcount)

    # ── 文件 ─────────────────────────────────────────────────────
    async def add_files(self, sid: str, files: Sequence[FileRow]) -> list[FileRow]:
        from . import schema as t
        async with self._engine.begin() as conn:
            for f in files:
                await conn.execute(self._upsert(
                    t.session_file,
                    {"session_id": sid, "name": f.name, "rel_path": f.rel_path,
                     "size_bytes": f.size, "sha256": f.sha256},
                    index_elements=["session_id", "name"],
                    update=["rel_path", "size_bytes", "sha256"]))
        return await self.list_files(sid)

    async def list_files(self, sid: str) -> list[FileRow]:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.session_file)
                .where(t.session_file.c.session_id == sid)
                .order_by(t.session_file.c.uploaded_at, t.session_file.c.name)
            )).mappings().all()
        return [FileRow(name=r["name"], rel_path=r["rel_path"],
                        size=r["size_bytes"], sha256=r["sha256"]) for r in rs]

    # ── 状态 ─────────────────────────────────────────────────────
    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = ()) -> int:
        """一次 mutation 一个事务：state 文档 + 整代冲突一起落，版本号一起推进。

        这是**唯一**的状态写入口。现在 s.state["oir"] 与 s.state["_oir"] 的漂移
        就来自"有的路径刷、有的路径不刷"，只留一个入口才能从结构上杜绝。
        """
        from . import schema as t
        import sqlalchemy as sa

        async with self._engine.begin() as conn:
            # 行锁 + 自增：并发的两次 save_state 拿到不同版本号，后者可见前者。
            ver = (await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(state_version=t.session.c.state_version + 1)
                .returning(t.session.c.state_version))).scalar_one()

            for key, doc in docs.items():
                await conn.execute(self._upsert(
                    t.session_state,
                    {"session_id": sid, "key": key, "doc": doc, "version": ver,
                     "derived": key in DERIVED_KEYS},
                    index_elements=["session_id", "key"],
                    update=["doc", "version", "derived"]))

            if conflicts is not None:
                # 整代替换。人的决定在 decision 表里，不受影响 —— 这就是把
                # answered 从 s.state 挪走的意义。
                await conn.execute(sa.delete(t.conflict)
                                   .where(t.conflict.c.session_id == sid))
                ranks = {r: i for i, r in enumerate(asked_rids)}
                rows = [{
                    "session_id": sid, "rid": c["rid"], "kind": c["kind"],
                    "handling": c["handling"], "summary": c.get("summary", ""),
                    "subjects": c.get("subjects") or [],
                    "detector": c.get("detector", "rule"), "owner": c.get("owner"),
                    "doc": c, "asked": c["rid"] in ranks,
                    "ask_rank": ranks.get(c["rid"]), "version": ver,
                } for c in conflicts]
                if rows:
                    # 464 条一次 executemany —— 逐条 INSERT 是 464 次 round-trip。
                    await conn.execute(t.conflict.insert(), rows)
        return int(ver)

    async def load_state(self, sid: str, *, keys: Iterable[str] | None = None,
                         include_derived: bool = True) -> dict[str, Any]:
        from . import schema as t
        import sqlalchemy as sa
        q = sa.select(t.session_state.c.key, t.session_state.c.doc).where(
            t.session_state.c.session_id == sid)
        if keys is not None:
            q = q.where(t.session_state.c.key.in_(list(keys)))
        if not include_derived:
            q = q.where(sa.not_(t.session_state.c.derived))
        async with self._engine.connect() as conn:
            rs = (await conn.execute(q)).all()
        return {k: v for k, v in rs}

    async def list_conflicts(self, sid: str) -> list[dict[str, Any]]:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.conflict.c.doc)
                .where(t.conflict.c.session_id == sid)
                .order_by(t.conflict.c.ask_rank.nulls_last(), t.conflict.c.rid)
            )).scalars().all()
        return list(rs)

    async def get_conflict(self, sid: str, rid: str) -> dict[str, Any] | None:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            return (await conn.execute(sa.select(t.conflict.c.doc).where(
                sa.and_(t.conflict.c.session_id == sid,
                        t.conflict.c.rid == rid)))).scalar_one_or_none()

    # ── 决定 ─────────────────────────────────────────────────────
    async def record_decision(self, sid: str, d: DecisionRow) -> DecisionRow:
        """append-only。推翻旧决定与写入新决定必须在同一事务里 ——
        否则 decision_live_answer_uq 会在中间态上炸。"""
        from . import schema as t
        import sqlalchemy as sa
        d.ts = d.ts or time.time()
        async with self._engine.begin() as conn:
            # 发号走 session 上的计数器（行锁），不是 MAX(ordinal)+1：
            #   * 不加锁的 MAX+1 在并发下会重号，撞 decision 的主键；
            #   * `SELECT max(...) FOR UPDATE` 在 Postgres 上直接报
            #     "FOR UPDATE is not allowed with aggregate functions"。
            # 和 next_event_seq / next_run_ordinal 是同一套手法。
            d.ordinal = int((await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(next_decision_ordinal=t.session.c.next_decision_ordinal + 1)
                .returning(t.session.c.next_decision_ordinal))).scalar_one()) - 1

            sup = sa.and_(
                t.decision.c.session_id == sid,
                t.decision.c.superseded_by.is_(None),
                t.decision.c.kind == d.kind,
                t.decision.c.target_rid == d.target_rid if d.kind == "answer"
                else t.decision.c.scope_refs == (d.scope_refs or []),
            )
            await conn.execute(t.decision.update().where(sup)
                               .values(superseded_by=d.ordinal))
            await conn.execute(t.decision.insert().values(
                session_id=sid, ordinal=d.ordinal, kind=d.kind,
                statement=d.statement, scope_refs=d.scope_refs,
                turn_index=d.turn_index, superseded_by=None,
                target_rid=d.target_rid, option_id=d.option_id,
                changed=d.changed, note=d.note, ts=d.ts))
        return d

    async def list_decisions(self, sid: str, *, active_only: bool = False
                             ) -> list[DecisionRow]:
        from . import schema as t
        import sqlalchemy as sa
        q = sa.select(t.decision).where(t.decision.c.session_id == sid)
        if active_only:
            q = q.where(t.decision.c.superseded_by.is_(None))
        async with self._engine.connect() as conn:
            rs = (await conn.execute(q.order_by(t.decision.c.ordinal))).mappings().all()
        return [DecisionRow(
            ordinal=r["ordinal"], kind=r["kind"], statement=r["statement"],
            scope_refs=list(r["scope_refs"] or []), turn_index=r["turn_index"],
            superseded_by=r["superseded_by"], target_rid=r["target_rid"],
            option_id=r["option_id"], changed=list(r["changed"] or []),
            note=r["note"], ts=r["ts"]) for r in rs]

    async def answered_rids(self, sid: str) -> set[str]:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.decision.c.target_rid).where(sa.and_(
                    t.decision.c.session_id == sid,
                    t.decision.c.kind == "answer",
                    t.decision.c.superseded_by.is_(None),
                    t.decision.c.target_rid != "")))).scalars().all()
        return set(rs)

    # ── 事件 ─────────────────────────────────────────────────────
    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any]) -> EventRow:
        """发号 + 落行一个事务。seq 由 session.next_event_seq 的行锁保证唯一 ——
        现在的 ``len(self.events)``（server.py:109）在多 worker 下必然重号。"""
        from . import schema as t
        blob_ref = None
        raw = json.dumps(payload, ensure_ascii=False, default=str)
        if len(raw.encode("utf-8")) > EVENT_INLINE_LIMIT:
            # 大 payload 落 blob。单条 node.completed node=CONFLICT 实测 235 KB，
            # 而那份内容 conflict 表里已经有了 —— 事件流不该是第二个副本。
            blob_ref = await self._put_blob(raw.encode("utf-8"))
            payload = {"_ref": blob_ref, "_bytes": len(raw.encode("utf-8"))}
        ts = time.time()
        async with self._engine.begin() as conn:
            seq = (await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(next_event_seq=t.session.c.next_event_seq + 1)
                .returning(t.session.c.next_event_seq))).scalar_one() - 1
            await conn.execute(t.session_event.insert().values(
                session_id=sid, seq=seq, kind=kind, payload=payload,
                ref=blob_ref, ts=ts))
        return EventRow(seq=int(seq), kind=kind, payload=payload, ts=ts)

    async def read_events(self, sid: str, since: int = 0) -> list[EventRow]:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.session_event).where(sa.and_(
                    t.session_event.c.session_id == sid,
                    t.session_event.c.seq >= since))
                .order_by(t.session_event.c.seq))).mappings().all()
            out = []
            for r in rs:
                p = r["payload"]
                if r["ref"]:
                    p = json.loads((await self._get_blob(conn, r["ref"])).decode("utf-8"))
                out.append(EventRow(seq=r["seq"], kind=r["kind"], payload=p, ts=r["ts"]))
        return out

    async def count_events(self, sid: str) -> int:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.connect() as conn:
            return int((await conn.execute(
                sa.select(sa.func.count()).select_from(t.session_event)
                .where(t.session_event.c.session_id == sid))).scalar_one())

    # ── blob ─────────────────────────────────────────────────────
    async def _put_blob(self, raw: bytes) -> str:
        from . import schema as t
        ref = "blob:" + hashlib.sha256(raw).hexdigest()[:32]   # == ids.content_ref
        async with self._engine.begin() as conn:
            if self.mode == "postgresql":
                from sqlalchemy.dialects.postgresql import insert
            else:
                from sqlalchemy.dialects.sqlite import insert
            await conn.execute(insert(t.blob).values(
                ref=ref, data=raw, size_bytes=len(raw)
            ).on_conflict_do_nothing(index_elements=["ref"]))
        return ref

    async def _get_blob(self, conn: Any, ref: str) -> bytes:
        from . import schema as t
        import sqlalchemy as sa
        v = (await conn.execute(sa.select(t.blob.c.data)
                                .where(t.blob.c.ref == ref))).scalar_one_or_none()
        if v is None:
            raise KeyError(f"blob 不存在: {ref}")
        return bytes(v)

    # ── Run ──────────────────────────────────────────────────────
    async def next_run(self, sid: str, kind: str) -> str:
        """分配一个**每次 Run 独立**的 id。

        现在是 ``f"run_{s.id}"``（server.py:271）—— 会话 id 不是 run id，同一会话
        第二次 build 会把 seq 从 0 重来撞进同一份日志。(run_id, seq) 上有唯一约束
        之后那会直接插入失败，所以这个方法是搬库的**前置条件**，不是可选项。
        """
        from . import schema as t
        async with self._engine.begin() as conn:
            n = (await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(next_run_ordinal=t.session.c.next_run_ordinal + 1)
                .returning(t.session.c.next_run_ordinal))).scalar_one() - 1
            rid = f"{sid}.{n}"
            await conn.execute(t.run.insert().values(
                id=rid, session_id=sid, ordinal=n, kind=kind, status="running"))
        return rid

    async def finish_run(self, run_id: str, *, status: str, error: str = "",
                         budget: dict[str, Any] | None = None) -> None:
        from . import schema as t
        import sqlalchemy as sa
        async with self._engine.begin() as conn:
            await conn.execute(t.run.update().where(t.run.c.id == run_id).values(
                status=status, error=error, budget=budget or {},
                ended_at=sa.func.now()))

    # ── 账号 ─────────────────────────────────────────────────────
    async def create_user(self, row: UserRow) -> UserRow:
        from datetime import UTC, datetime

        import sqlalchemy.exc as saexc

        from . import schema as t
        row.created = row.created or time.time()
        ts = datetime.fromtimestamp(row.created, tz=UTC)
        try:
            async with self._engine.begin() as conn:
                await conn.execute(t.app_user.insert().values(
                    id=row.id, username=row.username,
                    password_hash=row.password_hash, role=row.role,
                    active=row.active, prefs=row.prefs,
                    created_at=ts, updated_at=ts))
        except saexc.IntegrityError as exc:
            # 用户名 UNIQUE 或 id 主键冲突 —— 和 MemoryRepo 抛同一种异常，
            # 路由层才能统一映射成 409（否则两个实现行为分叉，测试还测不到）。
            raise DuplicateUsername(f"用户名或 id 已存在: {row.username}") from exc
        return row

    async def get_user(self, uid: str) -> UserRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.app_user).where(
                t.app_user.c.id == uid))).mappings().first()
        return _user_row(r) if r else None

    async def get_user_by_username(self, username: str) -> UserRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.app_user).where(
                t.app_user.c.username == username))).mappings().first()
        return _user_row(r) if r else None

    async def list_users(self) -> list[UserRow]:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(sa.select(t.app_user)
                                     .order_by(t.app_user.c.created_at))).mappings().all()
        return [_user_row(r) for r in rs]

    async def count_users(self) -> int:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            return int((await conn.execute(
                sa.select(sa.func.count()).select_from(t.app_user))).scalar_one())

    async def update_user(self, uid: str, *, role: str | None = None,
                          active: bool | None = None,
                          password_hash: str | None = None,
                          prefs: dict[str, Any] | None = None) -> UserRow | None:
        from . import schema as t
        vals: dict[str, Any] = {}
        if role is not None:
            vals["role"] = role
        if active is not None:
            vals["active"] = active
        if password_hash is not None:
            vals["password_hash"] = password_hash
        if prefs is not None:
            vals["prefs"] = prefs
        if vals:
            async with self._engine.begin() as conn:
                await conn.execute(t.app_user.update()
                                   .where(t.app_user.c.id == uid).values(**vals))
        return await self.get_user(uid)

    async def delete_user(self, uid: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            # 显式先删登录会话再删账号：SQLite 默认不强制外键，不能只靠 CASCADE。
            await conn.execute(sa.delete(t.auth_session)
                               .where(t.auth_session.c.user_id == uid))
            r = await conn.execute(sa.delete(t.app_user)
                                   .where(t.app_user.c.id == uid))
        return bool(r.rowcount)

    # ── 登录会话 ─────────────────────────────────────────────────
    async def create_auth_session(self, row: AuthSessionRow) -> AuthSessionRow:
        from datetime import UTC, datetime

        from . import schema as t
        row.created = row.created or time.time()
        row.last_seen = row.last_seen or row.created
        async with self._engine.begin() as conn:
            await conn.execute(t.auth_session.insert().values(
                token_hash=row.token_hash, user_id=row.user_id,
                created_at=datetime.fromtimestamp(row.created, tz=UTC),
                last_seen_at=datetime.fromtimestamp(row.last_seen, tz=UTC),
                expires_at=datetime.fromtimestamp(row.expires, tz=UTC)))
        return row

    async def get_auth_session(self, token_hash: str) -> AuthSessionRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.auth_session).where(
                t.auth_session.c.token_hash == token_hash))).mappings().first()
        return _auth_row(r) if r else None

    async def delete_auth_session(self, token_hash: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.auth_session)
                                   .where(t.auth_session.c.token_hash == token_hash))
        return bool(r.rowcount)

    async def delete_user_auth_sessions(self, uid: str) -> int:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.auth_session)
                                   .where(t.auth_session.c.user_id == uid))
        return int(r.rowcount or 0)

    async def prune_auth_sessions(self, *, now: float) -> int:
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.auth_session).where(
                t.auth_session.c.expires_at <= datetime.fromtimestamp(now, tz=UTC)))
        return int(r.rowcount or 0)


def _session_row(r: Any) -> SessionRow:
    return SessionRow(
        id=r["id"], title=r["title"], project=r["project"], status=r["status"],
        error=r["error"], created=r["created_at"].timestamp(),
        state_version=r["state_version"])


def _user_row(r: Any) -> UserRow:
    return UserRow(
        id=r["id"], username=r["username"], password_hash=r["password_hash"],
        role=r["role"], active=bool(r["active"]), prefs=dict(r["prefs"] or {}),
        created=r["created_at"].timestamp())


def _auth_row(r: Any) -> AuthSessionRow:
    return AuthSessionRow(
        token_hash=r["token_hash"], user_id=r["user_id"],
        created=r["created_at"].timestamp(), last_seen=r["last_seen_at"].timestamp(),
        expires=r["expires_at"].timestamp())


def build_repo(store: Any) -> Repo:
    """按 Store 的模式挑实现。**这是唯一的选路点。**"""
    return MemoryRepo() if not store.enabled else PgRepo(store.engine)


__all__ = ["Repo", "MemoryRepo", "PgRepo", "SessionRow", "FileRow", "EventRow",
           "DecisionRow", "UserRow", "AuthSessionRow", "DuplicateUsername",
           "build_repo"]
