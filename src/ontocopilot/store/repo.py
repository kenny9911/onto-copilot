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

import asyncio
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
    #: 归属账号 id。"" = 无归属（旧会话/开放模式），强制鉴权下对所有人隐藏。
    owner: str = ""
    #: 所属项目文件夹（project.id）。"" = 未归类。**和上面的 project 不是一回事**：
    #  project 是印在交付物上的客户项目名，这里是侧栏分组。
    project_id: str = ""

    def brief(self, *, files: int = 0) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "project": self.project,
                "status": self.status, "files": files, "created": self.created,
                "error": self.error, "project_id": self.project_id}


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
    event_id: str = ""

    def as_sse(self) -> dict[str, Any]:
        """还原成 Session.emit 产出的那个扁平 dict（server.py:109）。"""
        out = {"seq": self.seq, "ts": self.ts, **self.payload, "kind": self.kind}
        if self.event_id:
            out["eventId"] = self.event_id
        return out


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
class QuestionRow:
    """统一问题表的持久化 DTO；``doc`` 是完整领域契约。"""

    id: str
    text: str
    status: str = "open"
    owner_user_id: str = ""
    audience_role: str = ""
    answer_schema: dict[str, Any] = field(default_factory=dict)
    priority: str = "normal"
    dependencies: list[str] = field(default_factory=list)
    blocked_artifacts: list[str] = field(default_factory=list)
    source_kind: str = "manual"
    source_ref: str = ""
    doc: dict[str, Any] = field(default_factory=dict)
    version: int = 0
    created: float = 0.0
    updated: float = 0.0

    @classmethod
    def from_domain(cls, question: Any) -> QuestionRow:
        d = question.to_dict()
        return cls(
            id=d["id"], text=d["text"], status=d["status"],
            owner_user_id=d.get("ownerUserId", ""),
            audience_role=d.get("audienceRole", ""),
            answer_schema=dict(d.get("answerSchema") or {}),
            priority=d.get("priority", "normal"),
            dependencies=list(d.get("dependencies") or []),
            blocked_artifacts=list(d.get("blockedArtifacts") or []),
            source_kind=d.get("sourceKind", "manual"), source_ref=d.get("sourceRef", ""),
            doc=d, version=int(d.get("version") or 0),
            created=float(d.get("createdAt") or 0), updated=float(d.get("updatedAt") or 0))


@dataclass(slots=True)
class DecisionRecordRow:
    """统一 DecisionLedger 的 append-only 行。"""

    id: str
    question_id: str
    answer: Any
    actor: str
    actor_role: str = ""
    authority: str = ""
    source_turn: str = ""
    affected_ids: list[str] = field(default_factory=list)
    supersedes: str | None = None
    revision: int | None = None
    idempotency_key: str = ""
    semantic_hash: str = ""
    rationale: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    created: float = 0.0

    @classmethod
    def from_domain(cls, decision: Any) -> DecisionRecordRow:
        d = decision.to_dict()
        return cls(
            id=d["id"], question_id=d["questionId"], answer=d.get("answer"),
            actor=d.get("actor", "user"), actor_role=d.get("actorRole", ""),
            authority=d.get("authority", ""), source_turn=d.get("sourceTurn", ""),
            affected_ids=list(d.get("affectedIds") or []), supersedes=d.get("supersedes"),
            revision=d.get("revision"), idempotency_key=d.get("idempotencyKey", ""),
            semantic_hash=decision.fingerprint, rationale=d.get("rationale", ""),
            metadata=dict(d.get("metadata") or {}), created=float(d.get("createdAt") or 0))


@dataclass(slots=True)
class RevisionRow:
    """一次 proposed/applied/rejected/rolled_back 的耐久版本记录。"""

    id: str
    ordinal: int
    parent_id: str | None
    kind: str
    status: str
    doc: dict[str, Any]
    patch_set: dict[str, Any] | None = None
    changed_ids: list[str] = field(default_factory=list)
    invalidated_artifacts: list[str] = field(default_factory=list)
    actor: str = "agent"
    source_turn: str = ""
    snapshot_hash: str = ""
    idempotency_key: str = ""
    created: float = 0.0

    @classmethod
    def from_domain(cls, revision: Any, *, idempotency_key: str = "") -> RevisionRow:
        d = revision.to_dict()
        return cls(
            id=d["id"], ordinal=int(d["ordinal"]), parent_id=d.get("parentId"),
            kind=d.get("kind", "edit"), status=d.get("status", "proposed"), doc=d,
            patch_set=d.get("patchSet"), changed_ids=list(d.get("changedIds") or []),
            invalidated_artifacts=list(d.get("invalidatedArtifacts") or []),
            actor=d.get("actor", "agent"), source_turn=d.get("sourceTurn", ""),
            snapshot_hash=d.get("snapshotHash", ""), idempotency_key=idempotency_key,
            created=float(d.get("createdAt") or 0))


@dataclass(slots=True)
class UsageRow:
    """一次模型调用的用量流水。**跨会话、跨重启的唯一账本。**

    ``tok_*`` 是**实际打给模型那几次的总和**（schema 重试、截断加预算重试都算），
    ``attempts`` 说明打了几次 —— 一次调用重试三回就是三份 token 的钱，只记最后
    一次等于把账做小。``usd_source`` 区分网关回的真实账单和本地价目表的估算：
    很多经网关发现的模型价目是编的（catalog 里统一填 2.0/8.0），估出来的金额
    看着精确、其实是错的，界面据此决定敢不敢把它当钱显示。
    """

    id: str
    ts: float
    day: str                       # 'YYYY-MM-DD'（UTC），写入时算好
    model: str
    owner: str = ""
    session_id: str = ""
    run_id: str = ""
    node_id: str = ""
    kind: str = "build"            # build | chat | aux
    effort: str = ""
    tok_in: int = 0
    tok_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    usd: float = 0.0
    usd_source: str = "estimated"  # gateway | estimated
    attempts: int = 1
    status: str = "ok"             # ok | failed

    @property
    def total(self) -> int:
        return self.tok_in + self.tok_out + self.cache_read + self.cache_write

    def validate(self) -> None:
        """Apply the same contract before either repository implementation writes."""
        if not self.id or not self.model:
            raise ValueError("usage id/model 不能为空")
        if self.kind not in {"build", "chat", "aux"}:
            raise ValueError(f"usage kind 不支持: {self.kind}")
        if min(self.tok_in, self.tok_out, self.cache_read, self.cache_write) < 0:
            raise ValueError("usage token 不能为负数")
        if self.usd < 0:
            raise ValueError("usage usd 不能为负数")
        if self.usd_source not in {"gateway", "estimated"}:
            raise ValueError(f"usage usd_source 不支持: {self.usd_source}")
        if self.attempts < 1:
            raise ValueError("usage attempts 必须至少为 1")
        if self.status not in {"ok", "failed"}:
            raise ValueError(f"usage status 不支持: {self.status}")


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
    #: 称呼用的名字，原样保留大小写与空格。空串 = 没填（管理员/CLI 建的号、
    #  迁移前的老账号），展示时回落到 username。
    display_name: str = ""

    def public(self) -> dict[str, Any]:
        """给列表/管理页看的安全投影。**永不含 password_hash / prefs 之外的内部字段。**"""
        return {"id": self.id, "username": self.username, "role": self.role,
                "active": self.active, "created": self.created,
                "display_name": self.display_name}


@dataclass(slots=True)
class AuthSessionRow:
    """登录会话。主键是令牌的 sha256（``token_hash``），不是令牌本身。"""

    token_hash: str
    user_id: str
    created: float = 0.0
    last_seen: float = 0.0
    expires: float = 0.0


@dataclass(slots=True)
class SettingRow:
    """一条全局应用设置。``value`` 是任意 JSON 可序列化值。"""

    key: str
    value: Any
    updated: float = 0.0


@dataclass(slots=True)
class ProjectRow:
    """一个项目文件夹。``owner`` 为 "" = 无归属（开放模式建的）。

    ``prefs`` 是项目级偏好的预留位（命名规范/受众/问多少），这轮恒为 ``{}``。
    """

    id: str
    name: str
    owner: str = ""
    prefs: dict[str, Any] = field(default_factory=dict)
    sort_order: int = 0


@dataclass(slots=True)
class ProjectMemoryRow:
    """一条项目记忆。字段与 ``project_memory`` 的列一一对应。

    ``tier`` 只有两种取值，库里有 CHECK 兜着：``authoritative`` 是人拍板的约定，
    ``reference`` 是模型推断的教训。这一层只负责**如实存取**这个标记 —— 「参考档
    永不晋升」是记忆内核的判据，不在仓储里执行，但仓储绝不能把它弄丢或改写。
    """

    project_id: str
    key: str
    tier: str
    kind: str
    content: str
    confidence: float = 0.5
    support: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    #: 这条记忆是在哪个会话里形成的（reference 档进 prompt 时要逐行标出来）
    origin_session: str = ""
    #: 这条记忆读的是哪几份材料（换会话换材料时据此再降一档权重）
    origin_files: list[str] = field(default_factory=list)
    contested_by: list[str] = field(default_factory=list)
    hit_runs: list[str] = field(default_factory=list)
    use_count: int = 0
    created_run: str = ""
    last_used_run: str = ""


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
    async def list_sessions(self, limit: int = 100, *,
                            owner: str | None = None) -> list[SessionRow]: ...
    #: 只写 title 这一列，**不动 state_version** —— 见 :meth:`PgRepo.rename_session`。
    async def rename_session(self, sid: str, title: str) -> bool: ...
    async def set_status(self, sid: str, status: str, *, error: str = "") -> None: ...
    async def claim_session_status(
        self, sid: str, *, from_statuses: Sequence[str], to_status: str,
        error: str = "",
    ) -> bool: ...
    async def claim_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
        from_statuses: Sequence[str], to_status: str = "queued", error: str = "",
    ) -> bool: ...
    async def renew_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool: ...
    async def set_build_status(
        self, sid: str, *, owner: str, now: float, status: str, error: str = "",
    ) -> bool: ...
    async def release_build_lease(self, sid: str, *, owner: str) -> bool: ...
    async def request_build_cancel(self, sid: str, *, now: float) -> bool: ...
    async def reap_expired_build_lease(
        self, sid: str, *, now: float, error: str,
    ) -> bool: ...
    async def claim_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool: ...
    async def renew_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool: ...
    async def release_chat_lease(self, sid: str, *, owner: str) -> bool: ...
    async def request_chat_cancel(self, sid: str, *, now: float) -> bool: ...
    async def claim_mutation_lease(
        self, sid: str, *, owner: str, kind: str, now: float, ttl: float,
    ) -> bool: ...
    async def renew_mutation_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool: ...
    async def release_mutation_lease(self, sid: str, *, owner: str) -> bool: ...
    async def delete_session(self, sid: str) -> bool: ...
    async def reassign_sessions(self, frm: str, to: str) -> int: ...
    async def reassign_projects(self, frm: str, to: str) -> int: ...

    async def add_files(self, sid: str, files: Sequence[FileRow]) -> list[FileRow]: ...
    async def list_files(self, sid: str) -> list[FileRow]: ...
    async def remove_file(self, sid: str, name: str) -> bool: ...

    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = (),
                         expected_version: int | None = None) -> int | None: ...
    async def save_build_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None: ...
    async def save_chat_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None: ...
    async def save_mutation_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        chat_owner: str = "",
        expected_version: int | None = None,
    ) -> int | None: ...
    async def load_state(self, sid: str, *, keys: Iterable[str] | None = None,
                         include_derived: bool = True) -> dict[str, Any]: ...
    async def list_conflicts(self, sid: str) -> list[dict[str, Any]]: ...
    async def get_conflict(self, sid: str, rid: str) -> dict[str, Any] | None: ...

    async def record_decision(self, sid: str, d: DecisionRow) -> DecisionRow: ...
    async def list_decisions(self, sid: str, *, active_only: bool = False
                             ) -> list[DecisionRow]: ...
    async def answered_rids(self, sid: str) -> set[str]: ...

    async def upsert_questions(self, sid: str,
                               rows: Sequence[QuestionRow]) -> list[QuestionRow]: ...
    async def save_question(self, sid: str, row: QuestionRow, *,
                            expected_version: int | None = None) -> QuestionRow: ...
    async def list_questions(self, sid: str, *, statuses: Sequence[str] | None = None
                             ) -> list[QuestionRow]: ...
    async def get_question(self, sid: str, qid: str) -> QuestionRow | None: ...
    async def record_decision_v1(self, sid: str,
                                 row: DecisionRecordRow) -> tuple[DecisionRecordRow, bool]: ...
    async def finalize_decision_v1(self, sid: str, decision_id: str, *,
                                   status: str, error: str = ""
                                   ) -> DecisionRecordRow: ...
    async def list_decisions_v1(self, sid: str) -> list[DecisionRecordRow]: ...
    async def record_revision(self, sid: str,
                              row: RevisionRow) -> tuple[RevisionRow, bool]: ...
    async def append_revision(self, sid: str, row: RevisionRow,
                              ) -> tuple[RevisionRow, bool]: ...
    async def finalize_revision(self, sid: str, revision_id: str, *,
                                status: str) -> RevisionRow: ...
    async def list_revisions(self, sid: str) -> list[RevisionRow]: ...

    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any], *, event_id: str = ""
                           ) -> EventRow: ...
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
                          prefs: dict[str, Any] | None = None,
                          display_name: str | None = None) -> UserRow | None: ...
    async def delete_user(self, uid: str) -> bool: ...

    async def add_usage(self, row: UsageRow) -> None: ...
    async def usage_since(self, since: float, *, owner: str | None = None,
                          limit: int = 5000) -> list[UsageRow]: ...

    async def create_auth_session(self, row: AuthSessionRow) -> AuthSessionRow: ...
    async def get_auth_session(self, token_hash: str) -> AuthSessionRow | None: ...
    async def delete_auth_session(self, token_hash: str) -> bool: ...
    async def delete_user_auth_sessions(self, uid: str) -> int: ...
    async def prune_auth_sessions(self, *, now: float) -> int: ...

    # 项目文件夹与项目记忆（顶层，不随会话级联 —— 会话删了，项目和它的记忆还在）。
    async def list_projects(self, *, owner: str | None = None) -> list[ProjectRow]: ...
    async def create_project(self, row: ProjectRow) -> ProjectRow: ...
    async def get_project(self, pid: str) -> ProjectRow | None: ...
    async def rename_project(self, pid: str, name: str) -> bool: ...
    #: 返回被释放（掉回未归类）的会话数 —— 删项目**不删会话**。
    async def delete_project(self, pid: str) -> int: ...
    #: project_id 传 None 或 "" 都是「移出项目」。
    async def assign_session(self, sid: str, project_id: str | None) -> bool: ...
    async def list_project_memory(self, pid: str) -> list[ProjectMemoryRow]: ...
    async def upsert_project_memory(self, rows: list[ProjectMemoryRow]) -> int: ...
    async def delete_project_memory(self, pid: str,
                                    keys: list[str] | None = None) -> int: ...

    # 全局应用设置（顶层，不随会话级联）。
    async def get_setting(self, key: str) -> Any | None: ...
    async def set_setting(self, key: str, value: Any) -> None: ...
    async def list_settings(self) -> list[SettingRow]: ...
    async def delete_setting(self, key: str) -> bool: ...

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
        self._questions_v1: dict[str, dict[str, QuestionRow]] = {}
        self._decisions_v1: dict[str, list[DecisionRecordRow]] = {}
        self._revisions: dict[str, list[RevisionRow]] = {}
        self._events: dict[str, list[EventRow]] = {}
        self._runs: dict[str, dict[str, Any]] = {}
        #: 账号、登录会话、全局设置。**顶层**，与建模会话无关 —— 故意不进
        #  delete_session 的清理元组（那是按建模会话清的，扫到这里会误删账号/设置）。
        self._users: dict[str, UserRow] = {}
        self._auth: dict[str, AuthSessionRow] = {}
        self._settings: dict[str, Any] = {}
        #: 项目文件夹与项目记忆。也是**顶层**的 —— 项目记忆的全部意义就是比单个会话
        #  活得久，所以同样不进 delete_session 的清理元组（它按会话 id 逐个 pop，
        #  而这两个容器是按 project id 存的，扫进去只会误删同名的项目）。
        self._projects: dict[str, ProjectRow] = {}
        self._project_memory: dict[str, dict[str, ProjectMemoryRow]] = {}
        #: 模型用量流水。同样是顶层的 —— 会话删了，账还得在。
        self._usage: list[UsageRow] = []
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._build_leases: dict[str, dict[str, Any]] = {}
        self._chat_leases: dict[str, dict[str, Any]] = {}
        self._mutation_leases: dict[str, dict[str, Any]] = {}

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
        self._questions_v1.setdefault(row.id, {})
        self._decisions_v1.setdefault(row.id, [])
        self._revisions.setdefault(row.id, [])
        self._events.setdefault(row.id, [])
        self._session_locks.setdefault(row.id, asyncio.Lock())
        return row

    async def get_session(self, sid: str) -> SessionRow | None:
        return self._sessions.get(sid)

    async def list_sessions(self, limit: int = 100, *,
                            owner: str | None = None) -> list[SessionRow]:
        rows = self._sessions.values()
        if owner is not None:                      # 只看归属自己的；无归属("")天然被排除
            rows = [s for s in rows if s.owner == owner]
        return sorted(rows, key=lambda s: -s.created)[:limit]

    async def rename_session(self, sid: str, title: str) -> bool:
        s = self._sessions.get(sid)
        if s is None:
            return False
        s.title = title
        return True

    async def reassign_sessions(self, frm: str, to: str) -> int:
        n = 0
        for s in self._sessions.values():
            if (s.owner or "") == frm:
                s.owner = to
                n += 1
        return n

    async def reassign_projects(self, frm: str, to: str) -> int:
        n = 0
        for p in self._projects.values():
            if (p.owner or "") == frm:
                p.owner = to
                n += 1
        return n

    async def set_status(self, sid: str, status: str, *, error: str = "") -> None:
        s = self._sessions[sid]
        s.status, s.error = status, error

    async def claim_session_status(
        self, sid: str, *, from_statuses: Sequence[str], to_status: str,
        error: str = "",
    ) -> bool:
        """状态仍在允许集合时才更新；同一会话的并发调用只有一个能成功。"""
        lock = self._session_locks.setdefault(sid, asyncio.Lock())
        async with lock:
            row = self._sessions.get(sid)
            if row is None or row.status not in set(from_statuses):
                return False
            row.status, row.error = to_status, error
            return True

    async def claim_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
        from_statuses: Sequence[str], to_status: str = "queued", error: str = "",
    ) -> bool:
        """Atomically claim the session state and its process-independent build lease."""
        if not owner or ttl <= 0:
            raise ValueError("build lease owner 不能为空且 ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            if row is None or row.status not in set(from_statuses):
                return False
            mutation = self._mutation_leases.get(sid)
            if mutation is not None and float(mutation["expires_at"]) > now:
                return False
            row.status, row.error = to_status, error
            self._build_leases[sid] = {
                "owner": owner, "acquired_at": now,
                "heartbeat_at": now, "expires_at": now + ttl,
                "cancel_requested_at": None,
            }
            return True

    async def renew_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        if ttl <= 0:
            raise ValueError("build lease ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._build_leases.get(sid)
            if (row is None or row.status not in {"queued", "parsing", "extracting"}
                    or lease is None or lease["owner"] != owner
                    or lease.get("cancel_requested_at") is not None):
                return False
            lease["heartbeat_at"] = now
            lease["expires_at"] = now + ttl
            return True

    async def set_build_status(
        self, sid: str, *, owner: str, now: float, status: str, error: str = "",
    ) -> bool:
        """Fence a pipeline status write by invocation owner, expiry and cancel intent."""
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._build_leases.get(sid)
            if (row is None or row.status not in {"queued", "parsing", "extracting"}
                    or lease is None or lease["owner"] != owner
                    or lease.get("cancel_requested_at") is not None
                    or float(lease["expires_at"]) <= now):
                return False
            row.status, row.error = status, error
            return True

    async def release_build_lease(self, sid: str, *, owner: str) -> bool:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._build_leases.get(sid)
            if lease is None or lease["owner"] != owner:
                return False
            del self._build_leases[sid]
            return True

    async def request_build_cancel(self, sid: str, *, now: float) -> bool:
        """Persist a cooperative cancellation intent and stop the public state."""
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            if row is None or row.status not in {"queued", "parsing", "extracting"}:
                return False
            row.status, row.error = "stopped", ""
            lease = self._build_leases.get(sid)
            if lease is not None:
                lease["cancel_requested_at"] = now
            return True

    async def reap_expired_build_lease(
        self, sid: str, *, now: float, error: str,
    ) -> bool:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._build_leases.get(sid)
            if (row is None or row.status not in {"queued", "parsing", "extracting"}
                    or (lease is not None and float(lease["expires_at"]) > now)):
                return False
            row.status, row.error = "failed", error
            self._build_leases.pop(sid, None)
            return True

    async def claim_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        if not owner or ttl <= 0:
            raise ValueError("chat lease owner 不能为空且 ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            if sid not in self._sessions:
                return False
            mutation = self._mutation_leases.get(sid)
            if mutation is not None and float(mutation["expires_at"]) > now:
                return False
            lease = self._chat_leases.get(sid)
            if lease is not None and float(lease["expires_at"]) > now:
                return False
            self._chat_leases[sid] = {
                "owner": owner, "acquired_at": now, "heartbeat_at": now,
                "expires_at": now + ttl, "cancel_requested_at": None,
            }
            return True

    async def renew_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        if ttl <= 0:
            raise ValueError("chat lease ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._chat_leases.get(sid)
            if (lease is None or lease["owner"] != owner
                    or lease.get("cancel_requested_at") is not None
                    or float(lease["expires_at"]) <= now):
                return False
            lease["heartbeat_at"] = now
            lease["expires_at"] = now + ttl
            return True

    async def release_chat_lease(self, sid: str, *, owner: str) -> bool:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._chat_leases.get(sid)
            if lease is None or lease["owner"] != owner:
                return False
            del self._chat_leases[sid]
            return True

    async def request_chat_cancel(self, sid: str, *, now: float) -> bool:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._chat_leases.get(sid)
            if (lease is None or float(lease["expires_at"]) <= now
                    or lease.get("cancel_requested_at") is not None):
                return False
            lease["cancel_requested_at"] = now
            return True

    async def claim_mutation_lease(
        self, sid: str, *, owner: str, kind: str, now: float, ttl: float,
    ) -> bool:
        if not owner or not kind or ttl <= 0:
            raise ValueError("mutation lease owner/kind 不能为空且 ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            if row is None or row.status in {"queued", "parsing", "extracting"}:
                return False
            build = self._build_leases.get(sid)
            if build is not None and float(build["expires_at"]) > now:
                return False
            chat = self._chat_leases.get(sid)
            if (chat is not None and chat["owner"] != owner
                    and float(chat["expires_at"]) > now):
                return False
            current = self._mutation_leases.get(sid)
            if current is not None and float(current["expires_at"]) > now:
                return False
            self._mutation_leases[sid] = {
                "owner": owner, "kind": kind, "acquired_at": now,
                "heartbeat_at": now, "expires_at": now + ttl,
            }
            return True

    async def renew_mutation_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        if ttl <= 0:
            raise ValueError("mutation lease ttl 必须大于 0")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._mutation_leases.get(sid)
            if (lease is None or lease["owner"] != owner
                    or float(lease["expires_at"]) <= now):
                return False
            lease["heartbeat_at"] = now
            lease["expires_at"] = now + ttl
            return True

    async def release_mutation_lease(self, sid: str, *, owner: str) -> bool:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            lease = self._mutation_leases.get(sid)
            if lease is None or lease["owner"] != owner:
                return False
            del self._mutation_leases[sid]
            return True

    async def delete_session(self, sid: str) -> bool:
        """删掉一个会话的**全部**痕迹。返回它本来在不在。

        删干净很重要：留下孤儿状态或孤儿事件的话，下次建一个同 id 的会话会
        莫名其妙地继承它们。id 是随机的所以概率低，但低概率的脏数据最难查。
        """
        if sid not in self._sessions:
            return False
        for d in (self._sessions, self._files, self._state, self._conflicts,
                  self._decisions, self._questions_v1, self._decisions_v1,
                  self._revisions, self._events):
            d.pop(sid, None)
        for run_id in [rid for rid, run in self._runs.items()
                       if run["session_id"] == sid]:
            del self._runs[run_id]
        self._build_leases.pop(sid, None)
        self._chat_leases.pop(sid, None)
        self._mutation_leases.pop(sid, None)
        self._session_locks.pop(sid, None)
        return True

    # ── 文件 ─────────────────────────────────────────────────────
    async def add_files(self, sid: str, files: Sequence[FileRow]) -> list[FileRow]:
        bag = self._files.setdefault(sid, {})
        for f in files:
            bag[f.name] = f          # 同名覆盖，和 PG 的 ON CONFLICT DO UPDATE 一致
        return list(bag.values())

    async def list_files(self, sid: str) -> list[FileRow]:
        return list(self._files.get(sid, {}).values())

    async def remove_file(self, sid: str, name: str) -> bool:
        """撤掉一份材料。返回是否真的删到了 —— 删不存在的不是错误，但要如实回答。"""
        return self._files.get(sid, {}).pop(name, None) is not None

    # ── 状态 ─────────────────────────────────────────────────────
    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = (),
                         expected_version: int | None = None) -> int | None:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            s = self._sessions[sid]
            if expected_version is not None and s.state_version != expected_version:
                return None
            s.state_version += 1
            self._state.setdefault(sid, {}).update(docs)
            if conflicts is not None:
                ranks = {r: i for i, r in enumerate(asked_rids)}
                self._conflicts[sid] = {
                    c["rid"]: {**c, "_asked": c["rid"] in ranks,
                               "_ask_rank": ranks.get(c["rid"]),
                               "_version": s.state_version}
                    for c in conflicts
                }
            return s.state_version

    async def save_build_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None:
        """Checkpoint state and status only for the still-live build invocation."""
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._build_leases.get(sid)
            if (row is None or row.status not in {"queued", "parsing", "extracting"}
                    or lease is None or lease["owner"] != owner
                    or lease.get("cancel_requested_at") is not None
                    or float(lease["expires_at"]) <= now
                    or (expected_version is not None
                        and row.state_version != expected_version)):
                return None
            row.status, row.error = status, error
            row.state_version += 1
            self._state.setdefault(sid, {}).update(docs)
            if conflicts is not None:
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                self._conflicts[sid] = {
                    c["rid"]: {
                        **c, "_asked": c["rid"] in ranks,
                        "_ask_rank": ranks.get(c["rid"]),
                        "_version": row.state_version,
                    }
                    for c in conflicts
                }
            return row.state_version

    async def save_chat_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None:
        """Persist only while this exact chat invocation owns a live lease."""
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._chat_leases.get(sid)
            if (row is None or lease is None or lease["owner"] != owner
                    or lease.get("cancel_requested_at") is not None
                    or float(lease["expires_at"]) <= now
                    or (expected_version is not None
                        and row.state_version != expected_version)):
                return None
            row.state_version += 1
            self._state.setdefault(sid, {}).update(docs)
            if conflicts is not None:
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                self._conflicts[sid] = {
                    c["rid"]: {
                        **c, "_asked": c["rid"] in ranks,
                        "_ask_rank": ranks.get(c["rid"]),
                        "_version": row.state_version,
                    }
                    for c in conflicts
                }
            return row.state_version

    async def save_mutation_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        chat_owner: str = "",
        expected_version: int | None = None,
    ) -> int | None:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = self._sessions.get(sid)
            lease = self._mutation_leases.get(sid)
            chat = self._chat_leases.get(sid) if chat_owner else None
            if (row is None or lease is None or lease["owner"] != owner
                    or float(lease["expires_at"]) <= now
                    or (chat_owner and (chat is None or chat["owner"] != chat_owner
                                        or chat.get("cancel_requested_at") is not None
                                        or float(chat["expires_at"]) <= now))
                    or (expected_version is not None
                        and row.state_version != expected_version)):
                return None
            row.status, row.error = status, error
            row.state_version += 1
            self._state.setdefault(sid, {}).update(docs)
            if conflicts is not None:
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                self._conflicts[sid] = {
                    c["rid"]: {**c, "_asked": c["rid"] in ranks,
                               "_ask_rank": ranks.get(c["rid"]),
                               "_version": row.state_version}
                    for c in conflicts
                }
            return row.state_version

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

    # ── Question / Decision / Revision v1 ──────────────────────
    async def upsert_questions(self, sid: str,
                               rows: Sequence[QuestionRow]) -> list[QuestionRow]:
        now = time.time()
        bag = self._questions_v1.setdefault(sid, {})
        for row in rows:
            old = bag.get(row.id)
            row.created = row.created or (old.created if old else now)
            row.updated = row.updated or now
            bag[row.id] = row
        return list(bag.values())

    async def save_question(self, sid: str, row: QuestionRow, *,
                            expected_version: int | None = None) -> QuestionRow:
        """保存一次人工问题变更；有 expected_version 时执行乐观锁 CAS。"""
        from ..onto.questions import RevisionConflict

        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            bag = self._questions_v1.setdefault(sid, {})
            old = bag.get(row.id)
            if expected_version is not None and (
                    old is None or old.version != expected_version):
                actual = old.version if old else None
                raise RevisionConflict(
                    f"问题 {row.id} 预期 version {expected_version}，实际是 {actual}")
            if old:
                row.created = row.created or old.created
            row.updated = row.updated or time.time()
            if expected_version is not None:
                row.version = expected_version + 1
                row.doc["version"] = row.version
                row.doc["updatedAt"] = row.updated
            bag[row.id] = row
            return row

    async def list_questions(self, sid: str, *, statuses: Sequence[str] | None = None
                             ) -> list[QuestionRow]:
        rows = list(self._questions_v1.get(sid, {}).values())
        if statuses is not None:
            want = set(statuses)
            rows = [r for r in rows if r.status in want]
        return sorted(rows, key=lambda r: (r.created, r.id))

    async def get_question(self, sid: str, qid: str) -> QuestionRow | None:
        return self._questions_v1.get(sid, {}).get(qid)

    async def record_decision_v1(self, sid: str,
                                 row: DecisionRecordRow) -> tuple[DecisionRecordRow, bool]:
        from ..onto.questions import IdempotencyConflict

        if not row.idempotency_key:
            raise ValueError("Decision 必须提供 idempotency_key")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            bag = self._decisions_v1.setdefault(sid, [])
            old = next((x for x in bag if x.idempotency_key == row.idempotency_key), None)
            if old:
                if old.semantic_hash != row.semantic_hash:
                    raise IdempotencyConflict(
                        f"幂等键 {row.idempotency_key!r} 已用于另一份回答")
                return old, False
            row.created = row.created or time.time()
            active = _active_decision_v1(bag, row.question_id)
            if active and active.semantic_hash == row.semantic_hash:
                return active, False
            if active:
                row.supersedes = active.id
            bag.append(row)
            return row, True

    async def finalize_decision_v1(self, sid: str, decision_id: str, *,
                                   status: str, error: str = ""
                                   ) -> DecisionRecordRow:
        """将预先 claim 的 Decision 终结为 applied/failed。

        只允许单向 ``claimed -> applied|failed``；重放相同终态是幂等的，
        但不允许把已成功的决定改成失败（或反过来）。
        """
        if status not in {"applied", "failed"}:
            raise ValueError(f"不支持的 Decision 终态: {status}")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = next((x for x in self._decisions_v1.get(sid, [])
                        if x.id == decision_id), None)
            if row is None:
                raise KeyError(f"没有 Decision {decision_id}")
            current = str(row.metadata.get("status") or "applied")
            if current in {"applied", "failed"} and current != status:
                raise ValueError(f"Decision {decision_id} 已是 {current}，不能改为 {status}")
            row.metadata = {**row.metadata, "status": status}
            if error:
                row.metadata["error"] = error
            else:
                row.metadata.pop("error", None)
            return row

    async def list_decisions_v1(self, sid: str) -> list[DecisionRecordRow]:
        return list(self._decisions_v1.get(sid, []))

    async def record_revision(self, sid: str,
                              row: RevisionRow) -> tuple[RevisionRow, bool]:
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            bag = self._revisions.setdefault(sid, [])
            if row.idempotency_key:
                old = next((x for x in bag if x.idempotency_key == row.idempotency_key), None)
                if old:
                    if old.doc != row.doc:
                        from ..onto.questions import IdempotencyConflict
                        raise IdempotencyConflict(
                            f"幂等键 {row.idempotency_key!r} 已用于另一个 revision")
                    return old, False
            if any(x.id == row.id or x.ordinal == row.ordinal for x in bag):
                raise ValueError(f"Revision id/ordinal 已存在: {row.id}/{row.ordinal}")
            row.created = row.created or time.time()
            bag.append(row)
            bag.sort(key=lambda x: x.ordinal)
            return row, True

    async def append_revision(self, sid: str,
                              row: RevisionRow) -> tuple[RevisionRow, bool]:
        """原子分配下一 ordinal 并写 Revision，幂等键优先于发号。"""
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            bag = self._revisions.setdefault(sid, [])
            if row.idempotency_key:
                old = next((x for x in bag if x.idempotency_key == row.idempotency_key), None)
                if old:
                    # 自动分配的 id/ordinal/parent 不属于请求语义，相同 key
                    # 就返回原行；上层 Decision claim 已防止异义重用。
                    return old, False
            ordinal = max((x.ordinal for x in bag), default=0) + 1
            parent = max(bag, key=lambda x: x.ordinal).id if bag else None
            row.ordinal = ordinal
            row.id = f"rev.{ordinal}"
            row.parent_id = parent
            row.doc["id"] = row.id
            row.doc["ordinal"] = ordinal
            row.doc["parentId"] = parent
            row.created = row.created or time.time()
            bag.append(row)
            bag.sort(key=lambda x: x.ordinal)
            return row, True

    async def finalize_revision(self, sid: str, revision_id: str, *,
                                status: str) -> RevisionRow:
        """Finish a proposed artifact revision exactly once."""
        allowed = {"applied", "rejected", "rolled_back"}
        if status not in allowed:
            raise ValueError(f"不支持的 Revision 终态: {status}")
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            row = next((item for item in self._revisions.get(sid, [])
                        if item.id == revision_id), None)
            if row is None:
                raise KeyError(f"没有 Revision {revision_id}")
            if row.status != "proposed" and row.status != status:
                raise ValueError(
                    f"Revision {revision_id} 已是 {row.status}，不能改为 {status}")
            row.status = status
            row.doc["status"] = status
            return row

    async def list_revisions(self, sid: str) -> list[RevisionRow]:
        return list(self._revisions.get(sid, []))

    # ── 事件 ─────────────────────────────────────────────────────
    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any], *, event_id: str = ""
                           ) -> EventRow:
        # MemoryRepo is shared by concurrent request/background tasks in tests and
        # local mode.  Match PgRepo's row-lock semantics: sequence allocation and
        # append are one session-scoped critical section.
        async with self._session_locks.setdefault(sid, asyncio.Lock()):
            bag = self._events.setdefault(sid, [])
            if event_id:
                old = next((e for e in bag if e.event_id == event_id), None)
                if old is not None:
                    return old
            ev = EventRow(seq=len(bag), kind=kind, payload=payload, ts=time.time(),
                          event_id=event_id)
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
                          prefs: dict[str, Any] | None = None,
                          display_name: str | None = None) -> UserRow | None:
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
        if display_name is not None:
            u.display_name = display_name
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

    # ── 模型用量流水 ─────────────────────────────────────────────
    async def add_usage(self, row: UsageRow) -> None:
        row.validate()
        self._usage.append(row)

    async def usage_since(self, since: float, *, owner: str | None = None,
                          limit: int = 5000) -> list[UsageRow]:
        if limit <= 0:
            return []
        rows = [r for r in self._usage if r.ts >= since
                and (owner is None or (r.owner or "") == owner)]
        # 新的在前：截断时先丢最老的那批，而不是把最近发生的事情丢掉
        return sorted(rows, key=lambda r: -r.ts)[:limit]

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

    # ── 项目 ─────────────────────────────────────────────────────
    async def list_projects(self, *, owner: str | None = None) -> list[ProjectRow]:
        rows = list(self._projects.values())
        if owner is not None:                      # 只看归属自己的；无归属("")天然被排除
            rows = [p for p in rows if p.owner == owner]
        # sorted 是稳定的：sort_order 相同时保持插入（= 创建）顺序，与 PG 那边
        # 「sort_order, created_at」的次序一致。
        return sorted(rows, key=lambda p: p.sort_order)

    async def create_project(self, row: ProjectRow) -> ProjectRow:
        if row.id in self._projects:
            raise KeyError(f"项目已存在: {row.id}")
        self._projects[row.id] = row
        self._project_memory.setdefault(row.id, {})
        return row

    async def get_project(self, pid: str) -> ProjectRow | None:
        return self._projects.get(pid)

    async def rename_project(self, pid: str, name: str) -> bool:
        p = self._projects.get(pid)
        if p is None:
            return False
        p.name = name
        return True

    async def delete_project(self, pid: str) -> int:
        """删项目：成员会话掉回未归类，项目记忆一起删掉。返回释放了几个会话。

        顺序是刻意的 —— 先松开会话，再删记忆，最后删项目本身。反过来的话，中途
        出错会留下指向已不存在项目的会话（内存模式没有事务，见 :meth:`atomic`）。
        """
        released = 0
        for s in self._sessions.values():
            if s.project_id == pid:
                s.project_id = ""
                released += 1
        self._project_memory.pop(pid, None)
        self._projects.pop(pid, None)
        return released

    async def assign_session(self, sid: str, project_id: str | None) -> bool:
        s = self._sessions.get(sid)
        if s is None:
            return False
        s.project_id = project_id or ""            # None/"" 都是「移出项目」
        return True

    async def list_project_memory(self, pid: str) -> list[ProjectMemoryRow]:
        return sorted(self._project_memory.get(pid, {}).values(), key=lambda m: m.key)

    async def upsert_project_memory(self, rows: list[ProjectMemoryRow]) -> int:
        for row in rows:
            self._project_memory.setdefault(row.project_id, {})[row.key] = row
        return len(rows)

    async def delete_project_memory(self, pid: str,
                                    keys: list[str] | None = None) -> int:
        bag = self._project_memory.get(pid)
        if not bag:
            return 0
        if keys is None:                           # None = 整个项目的记忆全清
            n = len(bag)
            bag.clear()
            return n
        return sum(bag.pop(k, None) is not None for k in keys)

    # ── 设置 ─────────────────────────────────────────────────────
    async def get_setting(self, key: str) -> Any | None:
        return self._settings.get(key)

    async def set_setting(self, key: str, value: Any) -> None:
        self._settings[key] = value

    async def list_settings(self) -> list[SettingRow]:
        return [SettingRow(key=k, value=v) for k, v in self._settings.items()]

    async def delete_setting(self, key: str) -> bool:
        if key in self._settings:
            del self._settings[key]
            return True
        return False

    @asynccontextmanager
    async def atomic(self) -> AsyncIterator[MemoryRepo]:
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
                owner=row.owner or None,           # "" → NULL（无归属）
                project_id=row.project_id or None,  # "" → NULL（未归类）
                created_at=datetime.fromtimestamp(row.created, tz=UTC),
                updated_at=datetime.fromtimestamp(row.created, tz=UTC)))
        return row

    async def get_session(self, sid: str) -> SessionRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.session).where(
                t.session.c.id == sid))).mappings().first()
        return _session_row(r) if r else None

    async def list_sessions(self, limit: int = 100, *,
                            owner: str | None = None) -> list[SessionRow]:
        import sqlalchemy as sa

        from . import schema as t
        q = sa.select(t.session)
        if owner is not None:                      # 只看归属自己的；NULL(无归属)天然被排除
            q = q.where(t.session.c.owner == owner)
        async with self._engine.connect() as conn:
            rs = (await conn.execute(q.order_by(t.session.c.created_at.desc())
                                     .limit(limit))).mappings().all()
        return [_session_row(r) for r in rs]

    async def rename_session(self, sid: str, title: str) -> bool:
        """只写 title。**故意不碰 state_version。**

        state_version 是状态文档（oir/flow/dialogue…）的 CAS 令牌：正在跑的 build
        和 chat 都拿着自己那份期望值去提交。改个名字和那些文档毫无关系，跟着 +1
        的话，用户在侧栏上改个标题就会让另一台 worker 正在收尾的梳理提交 409，
        几分钟的活白干。跨 worker 的标题同步因此单独走一步读 row（见 server.py
        的 ``_refresh_chat_projection``），不搭这条 CAS 的车。

        updated_at 显式写：touch_updated_at 触发器只有 Postgres 有，和
        :meth:`rename_project` 同一个理由。
        """
        from datetime import UTC, datetime

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(t.session.update()
                                   .where(t.session.c.id == sid)
                                   .values(title=title,
                                           updated_at=datetime.now(tz=UTC)))
        return bool(r.rowcount)

    async def reassign_sessions(self, frm: str, to: str) -> int:
        import sqlalchemy as sa

        from . import schema as t
        # 无归属在库里是 NULL，在内存里是 ""，两边都要认 —— 只匹配其中一种，
        # 换个 repo 实现就会漏掉一半会话。
        cond = (t.session.c.owner.is_(None) if not frm
                else t.session.c.owner == frm)
        if not frm:
            cond = sa.or_(cond, t.session.c.owner == "")
        async with self._engine.begin() as conn:
            r = await conn.execute(t.session.update().where(cond).values(owner=to))
        return int(r.rowcount or 0)

    async def reassign_projects(self, frm: str, to: str) -> int:
        import sqlalchemy as sa

        from . import schema as t
        # 与 reassign_sessions 同一套 NULL/"" 双认判据 —— 项目和会话必须一起被认领，
        # 只认领会话的后果是会话还在、分组名没了，全掉回「未归类」。
        cond = (t.project.c.owner.is_(None) if not frm
                else t.project.c.owner == frm)
        if not frm:
            cond = sa.or_(cond, t.project.c.owner == "")
        async with self._engine.begin() as conn:
            r = await conn.execute(t.project.update().where(cond).values(owner=to))
        return int(r.rowcount or 0)

    async def set_status(self, sid: str, status: str, *, error: str = "") -> None:
        from . import schema as t
        async with self._engine.begin() as conn:
            await conn.execute(t.session.update().where(t.session.c.id == sid)
                               .values(status=status, error=error))

    async def claim_session_status(
        self, sid: str, *, from_statuses: Sequence[str], to_status: str,
        error: str = "",
    ) -> bool:
        """用单条条件 UPDATE 完成 CAS；进程锁不能替代这个事务边界。"""
        from . import schema as t
        allowed = tuple(dict.fromkeys(from_statuses))
        if not allowed:
            return False
        stmt = (t.session.update()
                .where(t.session.c.id == sid, t.session.c.status.in_(allowed))
                .values(status=to_status, error=error))
        async with self._engine.begin() as conn:
            result = await conn.execute(stmt)
        return int(result.rowcount or 0) == 1

    async def claim_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
        from_statuses: Sequence[str], to_status: str = "queued", error: str = "",
    ) -> bool:
        """Claim build state and lease in one transaction across all workers."""
        from . import schema as t
        allowed = tuple(dict.fromkeys(from_statuses))
        if not owner or ttl <= 0:
            raise ValueError("build lease owner 不能为空且 ttl 必须大于 0")
        if not allowed:
            return False
        import sqlalchemy as sa
        async with self._engine.begin() as conn:
            # A no-op UPDATE is the common arbitration primitive for both databases:
            # PostgreSQL locks this session row, while SQLite takes its database write
            # lock before reading the status.  ``SELECT .. FOR UPDATE`` is silently
            # ignored by SQLite and allowed two independent workers to both observe
            # ``idle`` and overwrite the lease owner.
            current_status = (await conn.execute(t.session.update().where(
                t.session.c.id == sid,
            ).values(state_version=t.session.c.state_version).returning(
                t.session.c.status,
            ))).scalar_one_or_none()
            if current_status not in allowed:
                return False
            # An expired mutation is abandoned and may be consumed.  A live domain
            # writer keeps build from changing status in this same transaction.
            await conn.execute(sa.delete(t.mutation_lease).where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.expires_at <= now,
            ))
            live_mutation = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.mutation_lease.c.session_id).where(
                    t.mutation_lease.c.session_id == sid,
                    t.mutation_lease.c.expires_at > now,
                )
            )))).scalar())
            if live_mutation:
                return False
            # A live lease with a startable public status is inconsistent but must
            # still fail closed.  Only an expired owner may be replaced.
            await conn.execute(sa.delete(t.build_lease).where(
                t.build_lease.c.session_id == sid,
                t.build_lease.c.expires_at <= now,
            ))
            live_build = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.build_lease.c.session_id).where(
                    t.build_lease.c.session_id == sid,
                )
            )))).scalar())
            if live_build:
                return False
            values = {
                "session_id": sid, "owner": owner, "acquired_at": now,
                "heartbeat_at": now, "expires_at": now + ttl,
                "cancel_requested_at": None,
            }
            await conn.execute(t.build_lease.insert().values(**values))
            await conn.execute(t.session.update().where(
                t.session.c.id == sid,
            ).values(status=to_status, error=error))
        return True

    async def renew_build_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        if ttl <= 0:
            raise ValueError("build lease ttl 必须大于 0")
        active = sa.exists(sa.select(t.session.c.id).where(
            t.session.c.id == sid,
            t.session.c.status.in_(("queued", "parsing", "extracting")),
        ))
        async with self._engine.begin() as conn:
            result = await conn.execute(t.build_lease.update().where(
                t.build_lease.c.session_id == sid,
                t.build_lease.c.owner == owner,
                t.build_lease.c.cancel_requested_at.is_(None),
                active,
            ).values(heartbeat_at=now, expires_at=now + ttl))
        return int(result.rowcount or 0) == 1

    async def set_build_status(
        self, sid: str, *, owner: str, now: float, status: str, error: str = "",
    ) -> bool:
        """Update status only while this exact invocation still owns a live lease."""
        import sqlalchemy as sa

        from . import schema as t
        owns_live_lease = sa.exists(sa.select(t.build_lease.c.session_id).where(
            t.build_lease.c.session_id == sid,
            t.build_lease.c.owner == owner,
            t.build_lease.c.cancel_requested_at.is_(None),
            t.build_lease.c.expires_at > now,
        ))
        async with self._engine.begin() as conn:
            result = await conn.execute(t.session.update().where(
                t.session.c.id == sid,
                t.session.c.status.in_(("queued", "parsing", "extracting")),
                owns_live_lease,
            ).values(status=status, error=error))
        return int(result.rowcount or 0) == 1

    async def release_build_lease(self, sid: str, *, owner: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            result = await conn.execute(sa.delete(t.build_lease).where(
                t.build_lease.c.session_id == sid,
                t.build_lease.c.owner == owner,
            ))
        return int(result.rowcount or 0) == 1

    async def request_build_cancel(self, sid: str, *, now: float) -> bool:
        """Set stopped and mark the current lease cancelled in one transaction."""
        from . import schema as t
        async with self._engine.begin() as conn:
            stopped = (await conn.execute(t.session.update().where(
                t.session.c.id == sid,
                t.session.c.status.in_(("queued", "parsing", "extracting")),
            ).values(status="stopped", error="").returning(
                t.session.c.id,
            ))).scalar_one_or_none()
            if stopped is None:
                return False
            await conn.execute(t.build_lease.update().where(
                t.build_lease.c.session_id == sid,
            ).values(cancel_requested_at=now))
        return True

    async def reap_expired_build_lease(
        self, sid: str, *, now: float, error: str,
    ) -> bool:
        """Atomically consume an expired lease before marking its build failed.

        The guarded DELETE is the arbitration point with ``renew_build_lease``:
        whichever write wins is observed by the other.  A reaper that merely read an
        old expiry could otherwise overwrite a heartbeat that committed meanwhile.
        """
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            # All build lifecycle mutations take the parent session before the lease.
            # Keeping that lock order avoids a Postgres deadlock with
            # request_build_cancel (session -> lease), while the guarded DELETE below
            # remains the renewal/reap arbitration point.
            current_status = (await conn.execute(sa.select(t.session.c.status).where(
                t.session.c.id == sid,
            ).with_for_update())).scalar_one_or_none()
            if current_status not in {"queued", "parsing", "extracting"}:
                return False
            consumed = (await conn.execute(sa.delete(t.build_lease).where(
                t.build_lease.c.session_id == sid,
                t.build_lease.c.expires_at <= now,
            ).returning(t.build_lease.c.session_id))).scalar_one_or_none()
            if consumed is None:
                # No row means either a legacy running session (safe to reconcile) or
                # a live lease.  Distinguish them inside this same transaction.
                has_live_lease = bool((await conn.execute(sa.select(sa.exists(
                    sa.select(t.build_lease.c.session_id).where(
                        t.build_lease.c.session_id == sid,
                    )
                )))).scalar())
                if has_live_lease:
                    return False
            updated = (await conn.execute(t.session.update().where(
                t.session.c.id == sid,
                t.session.c.status.in_(("queued", "parsing", "extracting")),
            ).values(status="failed", error=error).returning(
                t.session.c.id,
            ))).scalar_one_or_none()
            if updated is None:
                return False
        return True

    async def claim_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        """Claim an absent/expired session chat lease with one atomic upsert."""
        if not owner or ttl <= 0:
            raise ValueError("chat lease owner 不能为空且 ttl 必须大于 0")
        if self.mode == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        from . import schema as t
        values = {
            "session_id": sid, "owner": owner, "acquired_at": now,
            "heartbeat_at": now, "expires_at": now + ttl,
            "cancel_requested_at": None,
        }
        async with self._engine.begin() as conn:
            import sqlalchemy as sa
            status = (await conn.execute(sa.select(t.session.c.status).where(
                t.session.c.id == sid,
            ).with_for_update())).scalar_one_or_none()
            if status is None:
                return False
            await conn.execute(sa.delete(t.mutation_lease).where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.expires_at <= now,
            ))
            live_mutation = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.mutation_lease.c.session_id).where(
                    t.mutation_lease.c.session_id == sid,
                    t.mutation_lease.c.expires_at > now,
                )
            )))).scalar())
            if live_mutation:
                return False
            stmt = insert(t.chat_lease).values(**values).on_conflict_do_update(
                index_elements=["session_id"],
                set_={key: value for key, value in values.items() if key != "session_id"},
                where=t.chat_lease.c.expires_at <= now,
            ).returning(t.chat_lease.c.owner)
            try:
                claimed = (await conn.execute(stmt)).scalar_one_or_none()
            except Exception as exc:
                # Missing session is a normal false claim.  Preserve genuine DB errors;
                # checking parent first would introduce a TOCTOU with session deletion.
                from sqlalchemy.exc import IntegrityError
                if isinstance(exc, IntegrityError):
                    return False
                raise
        return claimed == owner

    async def renew_chat_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        if ttl <= 0:
            raise ValueError("chat lease ttl 必须大于 0")
        from . import schema as t
        async with self._engine.begin() as conn:
            result = await conn.execute(t.chat_lease.update().where(
                t.chat_lease.c.session_id == sid,
                t.chat_lease.c.owner == owner,
                t.chat_lease.c.cancel_requested_at.is_(None),
                t.chat_lease.c.expires_at > now,
            ).values(heartbeat_at=now, expires_at=now + ttl))
        return int(result.rowcount or 0) == 1

    async def release_chat_lease(self, sid: str, *, owner: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            result = await conn.execute(sa.delete(t.chat_lease).where(
                t.chat_lease.c.session_id == sid,
                t.chat_lease.c.owner == owner,
            ))
        return int(result.rowcount or 0) == 1

    async def request_chat_cancel(self, sid: str, *, now: float) -> bool:
        from . import schema as t
        async with self._engine.begin() as conn:
            result = await conn.execute(t.chat_lease.update().where(
                t.chat_lease.c.session_id == sid,
                t.chat_lease.c.expires_at > now,
                t.chat_lease.c.cancel_requested_at.is_(None),
            ).values(cancel_requested_at=now))
        return int(result.rowcount or 0) == 1

    async def claim_mutation_lease(
        self, sid: str, *, owner: str, kind: str, now: float, ttl: float,
    ) -> bool:
        """Claim a domain mutation after locking the parent session row."""
        import sqlalchemy as sa

        from . import schema as t
        if not owner or not kind or ttl <= 0:
            raise ValueError("mutation lease owner/kind 不能为空且 ttl 必须大于 0")
        async with self._engine.begin() as conn:
            # See ``claim_build_lease``: this must be a write, not FOR UPDATE, so two
            # aiosqlite connections cannot both pass their precondition snapshot.
            status = (await conn.execute(t.session.update().where(
                t.session.c.id == sid,
            ).values(state_version=t.session.c.state_version).returning(
                t.session.c.status,
            ))).scalar_one_or_none()
            if status is None or status in {"queued", "parsing", "extracting"}:
                return False
            live_build = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.build_lease.c.session_id).where(
                    t.build_lease.c.session_id == sid,
                    t.build_lease.c.expires_at > now,
                    t.build_lease.c.cancel_requested_at.is_(None),
                )
            )))).scalar())
            if live_build:
                return False
            live_other_chat = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.chat_lease.c.session_id).where(
                    t.chat_lease.c.session_id == sid,
                    t.chat_lease.c.owner != owner,
                    t.chat_lease.c.expires_at > now,
                    t.chat_lease.c.cancel_requested_at.is_(None),
                )
            )))).scalar())
            if live_other_chat:
                return False
            await conn.execute(sa.delete(t.mutation_lease).where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.expires_at <= now,
            ))
            exists = bool((await conn.execute(sa.select(sa.exists(
                sa.select(t.mutation_lease.c.session_id).where(
                    t.mutation_lease.c.session_id == sid,
                )
            )))).scalar())
            if exists:
                return False
            await conn.execute(t.mutation_lease.insert().values(
                session_id=sid, owner=owner, kind=kind,
                acquired_at=now, heartbeat_at=now, expires_at=now + ttl,
            ))
        return True

    async def renew_mutation_lease(
        self, sid: str, *, owner: str, now: float, ttl: float,
    ) -> bool:
        from . import schema as t
        if ttl <= 0:
            raise ValueError("mutation lease ttl 必须大于 0")
        async with self._engine.begin() as conn:
            result = await conn.execute(t.mutation_lease.update().where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.owner == owner,
                t.mutation_lease.c.expires_at > now,
            ).values(heartbeat_at=now, expires_at=now + ttl))
        return int(result.rowcount or 0) == 1

    async def release_mutation_lease(self, sid: str, *, owner: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            result = await conn.execute(sa.delete(t.mutation_lease).where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.owner == owner,
            ))
        return int(result.rowcount or 0) == 1

    async def delete_session(self, sid: str) -> bool:
        """删会话。子表靠 ON DELETE CASCADE 跟着走。

        显式删子表而不是只信赖 CASCADE 是没必要的重复，但**依赖 CASCADE 就必须
        确认外键真的声明了它** —— 没声明的话这里删完，子表里全是指向不存在会话的
        孤儿行，而且要等到下一次 JOIN 才会暴露。
        """
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            # SQLite 测试默认不启用 foreign_keys；显式删除三张新领域表，避免行为
            # 和 Postgres 的 ON DELETE CASCADE 分叉。
            for child in (t.decision_record, t.revision_record, t.question_item):
                await conn.execute(sa.delete(child).where(child.c.session_id == sid))
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
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.session_file)
                .where(t.session_file.c.session_id == sid)
                .order_by(t.session_file.c.uploaded_at, t.session_file.c.name)
            )).mappings().all()
        return [FileRow(name=r["name"], rel_path=r["rel_path"],
                        size=r["size_bytes"], sha256=r["sha256"]) for r in rs]

    async def remove_file(self, sid: str, name: str) -> bool:
        """撤掉一份材料。返回是否真的删到了 —— 删不存在的不是错误，但要如实回答。"""
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.session_file).where(
                sa.and_(t.session_file.c.session_id == sid,
                        t.session_file.c.name == name)))
        return bool(r.rowcount)

    # ── 状态 ─────────────────────────────────────────────────────
    async def save_state(self, sid: str, docs: dict[str, Any], *,
                         conflicts: Sequence[dict[str, Any]] | None = None,
                         asked_rids: Sequence[str] = (),
                         expected_version: int | None = None) -> int | None:
        """一次 mutation 一个事务：state 文档 + 整代冲突一起落，版本号一起推进。

        这是**唯一**的状态写入口。现在 s.state["oir"] 与 s.state["_oir"] 的漂移
        就来自"有的路径刷、有的路径不刷"，只留一个入口才能从结构上杜绝。
        """
        import sqlalchemy as sa

        from . import schema as t

        async with self._engine.begin() as conn:
            # 行锁 + 自增：并发的两次 save_state 拿到不同版本号，后者可见前者。
            where = [t.session.c.id == sid]
            if expected_version is not None:
                where.append(t.session.c.state_version == expected_version)
            # ``expected_version`` turns this into compare-and-swap.  PostgreSQL
            # serializes concurrent UPDATEs on the row and rechecks the predicate;
            # SQLite serializes writers, so exactly one stale snapshot can commit.
            ver = (await conn.execute(
                t.session.update().where(*where)
                .values(state_version=t.session.c.state_version + 1)
                .returning(t.session.c.state_version))).scalar_one_or_none()
            if ver is None:
                return None

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

    async def save_mutation_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        chat_owner: str = "",
        expected_version: int | None = None,
    ) -> int | None:
        """Commit a domain projection only for the live invocation owner."""
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            owns_live_lease = sa.exists(sa.select(t.mutation_lease.c.session_id).where(
                t.mutation_lease.c.session_id == sid,
                t.mutation_lease.c.owner == owner,
                t.mutation_lease.c.expires_at > now,
            ))
            where = [t.session.c.id == sid, owns_live_lease]
            if chat_owner:
                owns_live_chat = sa.exists(sa.select(t.chat_lease.c.session_id).where(
                    t.chat_lease.c.session_id == sid,
                    t.chat_lease.c.owner == chat_owner,
                    t.chat_lease.c.cancel_requested_at.is_(None),
                    t.chat_lease.c.expires_at > now,
                ))
                where.append(owns_live_chat)
            if expected_version is not None:
                where.append(t.session.c.state_version == expected_version)
            ver = (await conn.execute(t.session.update().where(*where).values(
                status=status, error=error,
                state_version=t.session.c.state_version + 1,
            ).returning(t.session.c.state_version))).scalar_one_or_none()
            if ver is None:
                return None
            for key, doc in docs.items():
                await conn.execute(self._upsert(
                    t.session_state,
                    {"session_id": sid, "key": key, "doc": doc, "version": ver,
                     "derived": key in DERIVED_KEYS},
                    index_elements=["session_id", "key"],
                    update=["doc", "version", "derived"],
                ))
            if conflicts is not None:
                await conn.execute(sa.delete(t.conflict).where(
                    t.conflict.c.session_id == sid,
                ))
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                rows = [{
                    "session_id": sid, "rid": c["rid"], "kind": c["kind"],
                    "handling": c["handling"], "summary": c.get("summary", ""),
                    "subjects": c.get("subjects") or [],
                    "detector": c.get("detector", "rule"), "owner": c.get("owner"),
                    "doc": c, "asked": c["rid"] in ranks,
                    "ask_rank": ranks.get(c["rid"]), "version": ver,
                } for c in conflicts]
                if rows:
                    await conn.execute(t.conflict.insert(), rows)
        return int(ver)

    async def save_build_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        status: str, error: str = "",
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None:
        """Atomically fence and persist one build checkpoint.

        Status, state documents and the conflict generation share the same transaction;
        a stopped/stale invocation therefore cannot write documents and only then learn
        that it lost ownership.
        """
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            owns_live_lease = sa.exists(sa.select(t.build_lease.c.session_id).where(
                t.build_lease.c.session_id == sid,
                t.build_lease.c.owner == owner,
                t.build_lease.c.cancel_requested_at.is_(None),
                t.build_lease.c.expires_at > now,
            ))
            where = [
                t.session.c.id == sid,
                t.session.c.status.in_(("queued", "parsing", "extracting")),
                owns_live_lease,
            ]
            if expected_version is not None:
                where.append(t.session.c.state_version == expected_version)
            ver = (await conn.execute(t.session.update().where(*where).values(
                status=status, error=error,
                state_version=t.session.c.state_version + 1,
            ).returning(t.session.c.state_version))).scalar_one_or_none()
            if ver is None:
                return None
            for key, doc in docs.items():
                await conn.execute(self._upsert(
                    t.session_state,
                    {"session_id": sid, "key": key, "doc": doc, "version": ver,
                     "derived": key in DERIVED_KEYS},
                    index_elements=["session_id", "key"],
                    update=["doc", "version", "derived"],
                ))
            if conflicts is not None:
                await conn.execute(sa.delete(t.conflict).where(
                    t.conflict.c.session_id == sid,
                ))
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                rows = [{
                    "session_id": sid, "rid": c["rid"], "kind": c["kind"],
                    "handling": c["handling"], "summary": c.get("summary", ""),
                    "subjects": c.get("subjects") or [],
                    "detector": c.get("detector", "rule"), "owner": c.get("owner"),
                    "doc": c, "asked": c["rid"] in ranks,
                    "ask_rank": ranks.get(c["rid"]), "version": ver,
                } for c in conflicts]
                if rows:
                    await conn.execute(t.conflict.insert(), rows)
        return int(ver)

    async def save_chat_state(
        self, sid: str, docs: dict[str, Any], *, owner: str, now: float,
        conflicts: Sequence[dict[str, Any]] | None = None,
        asked_rids: Sequence[str] = (),
        expected_version: int | None = None,
    ) -> int | None:
        """Atomically fence and persist one chat mutation.

        Checking the lease and advancing ``state_version`` happen in the same
        transaction.  A chat coroutine that outlived its lease (expiry, takeover or
        durable ``/stop``) therefore cannot overwrite the next worker's projection.
        """
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            owns_live_lease = sa.exists(sa.select(t.chat_lease.c.session_id).where(
                t.chat_lease.c.session_id == sid,
                t.chat_lease.c.owner == owner,
                t.chat_lease.c.cancel_requested_at.is_(None),
                t.chat_lease.c.expires_at > now,
            ))
            where = [t.session.c.id == sid, owns_live_lease]
            if expected_version is not None:
                where.append(t.session.c.state_version == expected_version)
            ver = (await conn.execute(t.session.update().where(*where).values(
                state_version=t.session.c.state_version + 1,
            ).returning(t.session.c.state_version))).scalar_one_or_none()
            if ver is None:
                return None
            for key, doc in docs.items():
                await conn.execute(self._upsert(
                    t.session_state,
                    {"session_id": sid, "key": key, "doc": doc, "version": ver,
                     "derived": key in DERIVED_KEYS},
                    index_elements=["session_id", "key"],
                    update=["doc", "version", "derived"],
                ))
            if conflicts is not None:
                await conn.execute(sa.delete(t.conflict).where(
                    t.conflict.c.session_id == sid,
                ))
                ranks = {rid: i for i, rid in enumerate(asked_rids)}
                rows = [{
                    "session_id": sid, "rid": c["rid"], "kind": c["kind"],
                    "handling": c["handling"], "summary": c.get("summary", ""),
                    "subjects": c.get("subjects") or [],
                    "detector": c.get("detector", "rule"), "owner": c.get("owner"),
                    "doc": c, "asked": c["rid"] in ranks,
                    "ask_rank": ranks.get(c["rid"]), "version": ver,
                } for c in conflicts]
                if rows:
                    await conn.execute(t.conflict.insert(), rows)
        return int(ver)

    async def load_state(self, sid: str, *, keys: Iterable[str] | None = None,
                         include_derived: bool = True) -> dict[str, Any]:
        import sqlalchemy as sa

        from . import schema as t
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
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.conflict.c.doc)
                .where(t.conflict.c.session_id == sid)
                .order_by(t.conflict.c.ask_rank.nulls_last(), t.conflict.c.rid)
            )).scalars().all()
        return list(rs)

    async def get_conflict(self, sid: str, rid: str) -> dict[str, Any] | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            return (await conn.execute(sa.select(t.conflict.c.doc).where(
                sa.and_(t.conflict.c.session_id == sid,
                        t.conflict.c.rid == rid)))).scalar_one_or_none()

    # ── 决定 ─────────────────────────────────────────────────────
    async def record_decision(self, sid: str, d: DecisionRow) -> DecisionRow:
        """append-only。推翻旧决定与写入新决定必须在同一事务里 ——
        否则 decision_live_answer_uq 会在中间态上炸。"""
        import sqlalchemy as sa

        from . import schema as t
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
        import sqlalchemy as sa

        from . import schema as t
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
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.decision.c.target_rid).where(sa.and_(
                    t.decision.c.session_id == sid,
                    t.decision.c.kind == "answer",
                    t.decision.c.superseded_by.is_(None),
                    t.decision.c.target_rid != "")))).scalars().all()
        return set(rs)

    # ── Question / Decision / Revision v1 ──────────────────────
    async def upsert_questions(self, sid: str,
                               rows: Sequence[QuestionRow]) -> list[QuestionRow]:
        from datetime import UTC, datetime

        from . import schema as t
        async with self._engine.begin() as conn:
            for row in rows:
                now = time.time()
                created = datetime.fromtimestamp(row.created or now, tz=UTC)
                updated = datetime.fromtimestamp(row.updated or now, tz=UTC)
                await conn.execute(self._upsert(
                    t.question_item,
                    {"session_id": sid, "id": row.id, "text": row.text,
                     "status": row.status, "owner_user_id": row.owner_user_id,
                     "audience_role": row.audience_role,
                     "answer_schema": row.answer_schema, "priority": row.priority,
                     "dependencies": row.dependencies,
                     "blocked_artifacts": row.blocked_artifacts,
                     "source_kind": row.source_kind, "source_ref": row.source_ref,
                     "doc": row.doc, "version": row.version,
                     "created_at": created, "updated_at": updated},
                    index_elements=["session_id", "id"],
                    update=["text", "status", "owner_user_id", "audience_role",
                            "answer_schema", "priority", "dependencies",
                            "blocked_artifacts", "source_kind", "source_ref", "doc",
                            "version", "updated_at"]))
        return await self.list_questions(sid)

    async def save_question(self, sid: str, row: QuestionRow, *,
                            expected_version: int | None = None) -> QuestionRow:
        """单行 CAS；问题工作台不能用 bulk upsert 覆盖并发人工回答。"""
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from ..onto.questions import RevisionConflict
        from . import schema as t
        now = time.time()
        values = {
            "text": row.text, "status": row.status,
            "owner_user_id": row.owner_user_id, "audience_role": row.audience_role,
            "answer_schema": row.answer_schema, "priority": row.priority,
            "dependencies": row.dependencies, "blocked_artifacts": row.blocked_artifacts,
            "source_kind": row.source_kind, "source_ref": row.source_ref,
            "doc": row.doc, "updated_at": datetime.fromtimestamp(row.updated or now, tz=UTC),
        }
        async with self._engine.begin() as conn:
            if expected_version is None:
                existing = (await conn.execute(sa.select(t.question_item.c.version).where(
                    sa.and_(t.question_item.c.session_id == sid,
                            t.question_item.c.id == row.id)))).scalar_one_or_none()
                if existing is None:
                    await conn.execute(t.question_item.insert().values(
                        session_id=sid, id=row.id, version=row.version,
                        created_at=datetime.fromtimestamp(row.created or now, tz=UTC),
                        **values))
                else:
                    await conn.execute(t.question_item.update().where(sa.and_(
                        t.question_item.c.session_id == sid,
                        t.question_item.c.id == row.id)).values(version=row.version, **values))
            else:
                row.version = expected_version + 1
                row.updated = row.updated or now
                row.doc["version"] = row.version
                row.doc["updatedAt"] = row.updated
                values["doc"] = row.doc
                values["updated_at"] = datetime.fromtimestamp(row.updated, tz=UTC)
                result = await conn.execute(t.question_item.update().where(sa.and_(
                    t.question_item.c.session_id == sid,
                    t.question_item.c.id == row.id,
                    t.question_item.c.version == expected_version
                )).values(version=row.version, **values))
                if not result.rowcount:
                    actual = (await conn.execute(sa.select(t.question_item.c.version).where(
                        sa.and_(t.question_item.c.session_id == sid,
                                t.question_item.c.id == row.id)))).scalar_one_or_none()
                    raise RevisionConflict(
                        f"问题 {row.id} 预期 version {expected_version}，实际是 {actual}")
        return row

    async def list_questions(self, sid: str, *, statuses: Sequence[str] | None = None
                             ) -> list[QuestionRow]:
        import sqlalchemy as sa

        from . import schema as t
        q = sa.select(t.question_item).where(t.question_item.c.session_id == sid)
        if statuses is not None:
            q = q.where(t.question_item.c.status.in_(list(statuses)))
        async with self._engine.connect() as conn:
            rows = (await conn.execute(q.order_by(t.question_item.c.created_at,
                                                   t.question_item.c.id))).mappings().all()
        return [_question_row(r) for r in rows]

    async def get_question(self, sid: str, qid: str) -> QuestionRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            row = (await conn.execute(sa.select(t.question_item).where(sa.and_(
                t.question_item.c.session_id == sid,
                t.question_item.c.id == qid)))).mappings().first()
        return _question_row(row) if row else None

    async def record_decision_v1(self, sid: str,
                                 row: DecisionRecordRow) -> tuple[DecisionRecordRow, bool]:
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from ..onto.questions import IdempotencyConflict
        from . import schema as t
        if not row.idempotency_key:
            raise ValueError("Decision 必须提供 idempotency_key")
        async with self._engine.begin() as conn:
            # Postgres 上按 session 串行化 claim，避免两个 worker 同时看到
            # “无 active decision”后插入同一内容哈希主键。SQLite 会忽略
            # FOR UPDATE，其写事务仍会串行化。
            await conn.execute(sa.select(t.session.c.id).where(
                t.session.c.id == sid).with_for_update())
            existing = (await conn.execute(sa.select(t.decision_record).where(sa.and_(
                t.decision_record.c.session_id == sid,
                t.decision_record.c.idempotency_key == row.idempotency_key
            )))).mappings().first()
            if existing:
                prior = _decision_record_row(existing)
                if prior.semantic_hash != row.semantic_hash:
                    raise IdempotencyConflict(
                        f"幂等键 {row.idempotency_key!r} 已用于另一份回答")
                return prior, False

            # 当前有效记录 = 没有被同问题的另一行 supersedes 指向的记录。
            rows = (await conn.execute(sa.select(t.decision_record).where(sa.and_(
                t.decision_record.c.session_id == sid,
                t.decision_record.c.question_id == row.question_id
            )).order_by(t.decision_record.c.created_at))).mappings().all()
            prior_rows = [_decision_record_row(r) for r in rows]
            active = _active_decision_v1(prior_rows, row.question_id)
            if active and active.semantic_hash == row.semantic_hash:
                return active, False
            if active:
                row.supersedes = active.id
            row.created = row.created or time.time()
            await conn.execute(t.decision_record.insert().values(
                session_id=sid, id=row.id, question_id=row.question_id,
                answer=row.answer, actor=row.actor, actor_role=row.actor_role,
                authority=row.authority, source_turn=row.source_turn,
                affected_ids=row.affected_ids, supersedes=row.supersedes,
                revision=row.revision, idempotency_key=row.idempotency_key,
                semantic_hash=row.semantic_hash, rationale=row.rationale,
                metadata=row.metadata,
                created_at=datetime.fromtimestamp(row.created, tz=UTC)))
        return row, True

    async def finalize_decision_v1(self, sid: str, decision_id: str, *,
                                   status: str, error: str = ""
                                   ) -> DecisionRecordRow:
        import sqlalchemy as sa

        from . import schema as t
        if status not in {"applied", "failed"}:
            raise ValueError(f"不支持的 Decision 终态: {status}")
        async with self._engine.begin() as conn:
            raw = (await conn.execute(sa.select(t.decision_record).where(sa.and_(
                t.decision_record.c.session_id == sid,
                t.decision_record.c.id == decision_id
            )).with_for_update())).mappings().first()
            if raw is None:
                raise KeyError(f"没有 Decision {decision_id}")
            row = _decision_record_row(raw)
            current = str(row.metadata.get("status") or "applied")
            if current in {"applied", "failed"} and current != status:
                raise ValueError(f"Decision {decision_id} 已是 {current}，不能改为 {status}")
            row.metadata = {**row.metadata, "status": status}
            if error:
                row.metadata["error"] = error
            else:
                row.metadata.pop("error", None)
            # updated_at 未单独加列；终态时间放 metadata，保持 append-only 表主结构。
            row.metadata["finalizedAt"] = time.time()
            await conn.execute(t.decision_record.update().where(sa.and_(
                t.decision_record.c.session_id == sid,
                t.decision_record.c.id == decision_id
            )).values(metadata=row.metadata))
        return row

    async def list_decisions_v1(self, sid: str) -> list[DecisionRecordRow]:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rows = (await conn.execute(sa.select(t.decision_record).where(
                t.decision_record.c.session_id == sid
            ).order_by(t.decision_record.c.created_at,
                       t.decision_record.c.id))).mappings().all()
        return [_decision_record_row(r) for r in rows]

    async def record_revision(self, sid: str,
                              row: RevisionRow) -> tuple[RevisionRow, bool]:
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from ..onto.questions import IdempotencyConflict
        from . import schema as t
        async with self._engine.begin() as conn:
            if row.idempotency_key:
                existing = (await conn.execute(sa.select(t.revision_record).where(sa.and_(
                    t.revision_record.c.session_id == sid,
                    t.revision_record.c.idempotency_key == row.idempotency_key
                )))).mappings().first()
                if existing:
                    prior = _revision_row(existing)
                    if prior.doc != row.doc:
                        raise IdempotencyConflict(
                            f"幂等键 {row.idempotency_key!r} 已用于另一个 revision")
                    return prior, False
            row.created = row.created or time.time()
            await conn.execute(t.revision_record.insert().values(
                session_id=sid, id=row.id, ordinal=row.ordinal,
                parent_id=row.parent_id, kind=row.kind, status=row.status,
                patch_set=row.patch_set, changed_ids=row.changed_ids,
                invalidated_artifacts=row.invalidated_artifacts, actor=row.actor,
                source_turn=row.source_turn, snapshot_hash=row.snapshot_hash,
                idempotency_key=row.idempotency_key, doc=row.doc,
                created_at=datetime.fromtimestamp(row.created, tz=UTC)))
        return row, True

    async def append_revision(self, sid: str,
                              row: RevisionRow) -> tuple[RevisionRow, bool]:
        """Postgres/SQLite 统一的原子 Revision 发号。"""
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            # 与 Decision claim 使用同一 session 行串行化，不用 MAX+1 竞态。
            await conn.execute(sa.select(t.session.c.id).where(
                t.session.c.id == sid).with_for_update())
            if row.idempotency_key:
                existing = (await conn.execute(sa.select(t.revision_record).where(sa.and_(
                    t.revision_record.c.session_id == sid,
                    t.revision_record.c.idempotency_key == row.idempotency_key
                )))).mappings().first()
                if existing:
                    return _revision_row(existing), False
            prior = (await conn.execute(sa.select(
                t.revision_record.c.id, t.revision_record.c.ordinal
            ).where(t.revision_record.c.session_id == sid)
                .order_by(t.revision_record.c.ordinal.desc()).limit(1))).first()
            ordinal = int(prior.ordinal) + 1 if prior else 1
            parent = prior.id if prior else None
            row.ordinal = ordinal
            row.id = f"rev.{ordinal}"
            row.parent_id = parent
            row.doc["id"] = row.id
            row.doc["ordinal"] = ordinal
            row.doc["parentId"] = parent
            row.created = row.created or time.time()
            await conn.execute(t.revision_record.insert().values(
                session_id=sid, id=row.id, ordinal=row.ordinal,
                parent_id=row.parent_id, kind=row.kind, status=row.status,
                patch_set=row.patch_set, changed_ids=row.changed_ids,
                invalidated_artifacts=row.invalidated_artifacts, actor=row.actor,
                source_turn=row.source_turn, snapshot_hash=row.snapshot_hash,
                idempotency_key=row.idempotency_key, doc=row.doc,
                created_at=datetime.fromtimestamp(row.created, tz=UTC)))
        return row, True

    async def finalize_revision(self, sid: str, revision_id: str, *,
                                status: str) -> RevisionRow:
        """Atomically move ``proposed`` to one terminal artifact state."""
        import sqlalchemy as sa

        from . import schema as t
        allowed = {"applied", "rejected", "rolled_back"}
        if status not in allowed:
            raise ValueError(f"不支持的 Revision 终态: {status}")
        async with self._engine.begin() as conn:
            raw = (await conn.execute(sa.select(t.revision_record).where(sa.and_(
                t.revision_record.c.session_id == sid,
                t.revision_record.c.id == revision_id,
            )))).mappings().first()
            if raw is None:
                raise KeyError(f"没有 Revision {revision_id}")
            row = _revision_row(raw)
            terminal_doc = {**row.doc, "status": status}
            updated = (await conn.execute(t.revision_record.update().where(sa.and_(
                t.revision_record.c.session_id == sid,
                t.revision_record.c.id == revision_id,
                t.revision_record.c.status == "proposed",
            )).values(status=status, doc=terminal_doc).returning(
                t.revision_record,
            ))).mappings().first()
            if updated is not None:
                return _revision_row(updated)

            # SQLite ignores ``FOR UPDATE``.  The guarded UPDATE above is the actual
            # arbitration point, so two terminal writers cannot both succeed.  Read
            # back the winner to make same-status retries idempotent and reject a
            # conflicting terminal transition.
            current = (await conn.execute(sa.select(t.revision_record).where(sa.and_(
                t.revision_record.c.session_id == sid,
                t.revision_record.c.id == revision_id,
            )))).mappings().one()
            terminal = _revision_row(current)
            if terminal.status != status:
                raise ValueError(
                    f"Revision {revision_id} 已是 {terminal.status}，不能改为 {status}")
            return terminal

    async def list_revisions(self, sid: str) -> list[RevisionRow]:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rows = (await conn.execute(sa.select(t.revision_record).where(
                t.revision_record.c.session_id == sid
            ).order_by(t.revision_record.c.ordinal))).mappings().all()
        return [_revision_row(r) for r in rows]

    # ── 事件 ─────────────────────────────────────────────────────
    async def append_event(self, sid: str, kind: str,
                           payload: dict[str, Any], *, event_id: str = ""
                           ) -> EventRow:
        """发号 + 落行一个事务。seq 由 session.next_event_seq 的行锁保证唯一 ——
        现在的 ``len(self.events)``（server.py:109）在多 worker 下必然重号。"""
        import sqlalchemy as sa

        from . import schema as t
        blob_ref = None
        raw = json.dumps(payload, ensure_ascii=False, default=str)
        raw_bytes = raw.encode("utf-8")
        # The row returned to the publisher is also the live SSE projection.  Keep
        # that projection in the same JSON-normalised shape that ``read_events``
        # will reconstruct after a reconnect; only the database representation may
        # be replaced by a blob reference.
        committed_payload = json.loads(raw)
        stored_payload = committed_payload
        if len(raw_bytes) > EVENT_INLINE_LIMIT:
            # 大 payload 落 blob。单条 node.completed node=CONFLICT 实测 235 KB，
            # 而那份内容 conflict 表里已经有了 —— 事件流不该是第二个副本。
            blob_ref = await self._put_blob(raw_bytes)
            stored_payload = {"_ref": blob_ref, "_bytes": len(raw_bytes)}
        ts = time.time()
        async with self._engine.begin() as conn:
            # Lock the owning session before checking event_id.  This serialises
            # same-session producers on both PostgreSQL and SQLite; a retry can
            # observe a just-committed original before allocating another seq.
            await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(next_event_seq=t.session.c.next_event_seq))
            if event_id:
                prior = (await conn.execute(t.session_event.select().where(
                    t.session_event.c.event_id == event_id))).mappings().first()
                if prior is not None:
                    prior_payload = prior["payload"]
                    if prior["ref"]:
                        prior_payload = json.loads(
                            (await self._get_blob(conn, prior["ref"])).decode("utf-8"))
                    return EventRow(seq=int(prior["seq"]), kind=prior["kind"],
                                    payload=prior_payload, ts=prior["ts"],
                                    event_id=prior["event_id"] or "")
            # **计数器可能落在已提交行的后面，这时不能信它。** 一旦如此，分配出来
            # 的 seq 会撞 UNIQUE 约束，而重试永远撞同一个号 —— 这个会话从此再也
            # 写不进任何事件，界面上表现为"消息要刷新才出现"。历史上文件库跑在
            # StaticPool 上（见 engine.py）就把计数器搅回去过，这些会话即使换了
            # 连接池也还是坏的。所以从**表里的真实最大值**兜一次底，顺手把计数器
            # 修回来 —— 自愈比一条修数据的 SQL 可靠，因为没人会记得去跑那条 SQL。
            used = (await conn.execute(
                sa.select(sa.func.max(t.session_event.c.seq))
                .where(t.session_event.c.session_id == sid))).scalar()
            nxt = (await conn.execute(
                sa.select(t.session.c.next_event_seq)
                .where(t.session.c.id == sid))).scalar_one()
            seq = max(int(nxt or 0), int(used) + 1 if used is not None else 0)
            await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(next_event_seq=seq + 1))
            await conn.execute(t.session_event.insert().values(
                session_id=sid, seq=seq, kind=kind, payload=stored_payload,
                ref=blob_ref, ts=ts, event_id=event_id or None))
        return EventRow(seq=int(seq), kind=kind, payload=committed_payload, ts=ts,
                        event_id=event_id)

    async def read_events(self, sid: str, since: int = 0) -> list[EventRow]:
        import sqlalchemy as sa

        from . import schema as t
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
                out.append(EventRow(seq=r["seq"], kind=r["kind"], payload=p, ts=r["ts"],
                                    event_id=r["event_id"] or ""))
        return out

    async def count_events(self, sid: str) -> int:
        import sqlalchemy as sa

        from . import schema as t
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
        import sqlalchemy as sa

        from . import schema as t
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
        import sqlalchemy as sa

        from . import schema as t
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
                    display_name=row.display_name,
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
                          prefs: dict[str, Any] | None = None,
                          display_name: str | None = None) -> UserRow | None:
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
        if display_name is not None:
            vals["display_name"] = display_name
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

    # ── 模型用量流水 ─────────────────────────────────────────────
    async def add_usage(self, row: UsageRow) -> None:
        from . import schema as t
        row.validate()
        async with self._engine.begin() as conn:
            await conn.execute(t.llm_usage.insert().values(
                id=row.id, ts=row.ts, day=row.day, owner=row.owner or "",
                session_id=row.session_id or "", run_id=row.run_id or "",
                node_id=row.node_id or "", kind=row.kind, model=row.model,
                effort=row.effort or "", tok_in=row.tok_in, tok_out=row.tok_out,
                cache_read=row.cache_read, cache_write=row.cache_write,
                usd=row.usd, usd_source=row.usd_source, attempts=row.attempts,
                status=row.status))

    async def usage_since(self, since: float, *, owner: str | None = None,
                          limit: int = 5000) -> list[UsageRow]:
        import sqlalchemy as sa

        from . import schema as t
        if limit <= 0:
            return []
        q = sa.select(t.llm_usage).where(t.llm_usage.c.ts >= since)
        if owner is not None:
            # 空归属在库里是 ''、在内存实现里可能是 None —— 两边都认，否则换个
            # repo 实现就静默少掉一半行（session.owner 上踩过同一个坑）
            q = (q.where(sa.or_(t.llm_usage.c.owner == "",
                                t.llm_usage.c.owner.is_(None)))
                 if not owner else q.where(t.llm_usage.c.owner == owner))
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                q.order_by(t.llm_usage.c.ts.desc()).limit(limit))).mappings().all()
        return [_usage_row(r) for r in rs]

    async def prune_auth_sessions(self, *, now: float) -> int:
        from datetime import UTC, datetime

        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.auth_session).where(
                t.auth_session.c.expires_at <= datetime.fromtimestamp(now, tz=UTC)))
        return int(r.rowcount or 0)

    # ── 项目 ─────────────────────────────────────────────────────
    async def list_projects(self, *, owner: str | None = None) -> list[ProjectRow]:
        import sqlalchemy as sa

        from . import schema as t
        q = sa.select(t.project)
        if owner is not None:                      # 只看归属自己的；NULL(无归属)被排除
            q = q.where(t.project.c.owner == owner)
        async with self._engine.connect() as conn:
            rs = (await conn.execute(q.order_by(t.project.c.sort_order,
                                                t.project.c.created_at))).mappings().all()
        return [_project_row(r) for r in rs]

    async def create_project(self, row: ProjectRow) -> ProjectRow:
        from datetime import UTC, datetime

        from . import schema as t
        now = datetime.now(tz=UTC)
        async with self._engine.begin() as conn:
            await conn.execute(t.project.insert().values(
                id=row.id, name=row.name,
                owner=row.owner or None,           # "" → NULL（无归属）
                prefs=row.prefs or {},             # 无 server_default，总是显式写
                sort_order=row.sort_order,
                created_at=now, updated_at=now))
        return row

    async def get_project(self, pid: str) -> ProjectRow | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            r = (await conn.execute(sa.select(t.project).where(
                t.project.c.id == pid))).mappings().first()
        return _project_row(r) if r else None

    async def rename_project(self, pid: str, name: str) -> bool:
        from datetime import UTC, datetime

        from . import schema as t
        # updated_at 显式写：touch_updated_at 触发器只有 Postgres 有，SQLite 上
        # 指望它就等于这一列永远停在创建时刻。
        async with self._engine.begin() as conn:
            r = await conn.execute(t.project.update()
                                   .where(t.project.c.id == pid)
                                   .values(name=name,
                                           updated_at=datetime.now(tz=UTC)))
        return bool(r.rowcount)

    async def delete_project(self, pid: str) -> int:
        """删项目：成员会话掉回未归类，项目记忆一起删掉。返回释放了几个会话。

        一个事务三步，且**不靠外键级联** —— project 上根本没有指过来的外键（见 0013
        的说明）。次序是先松开会话再删记忆最后删项目：同一个事务里其实无所谓，但读
        起来是「先把还要用的东西摘出来，再扔容器」，和内存实现一致。
        """
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            released = (await conn.execute(
                t.session.update().where(t.session.c.project_id == pid)
                .values(project_id=None))).rowcount
            await conn.execute(sa.delete(t.project_memory)
                               .where(t.project_memory.c.project_id == pid))
            await conn.execute(sa.delete(t.project).where(t.project.c.id == pid))
        return int(released or 0)

    async def assign_session(self, sid: str, project_id: str | None) -> bool:
        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(
                t.session.update().where(t.session.c.id == sid)
                .values(project_id=project_id or None))   # None/"" → NULL（移出项目）
        return bool(r.rowcount)

    async def list_project_memory(self, pid: str) -> list[ProjectMemoryRow]:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(
                sa.select(t.project_memory)
                .where(t.project_memory.c.project_id == pid)
                .order_by(t.project_memory.c.key))).mappings().all()
        return [_project_memory_row(r) for r in rs]

    async def upsert_project_memory(self, rows: list[ProjectMemoryRow]) -> int:
        from datetime import UTC, datetime

        from . import schema as t
        if not rows:
            return 0
        now = datetime.now(tz=UTC)
        mutable = ["tier", "kind", "content", "confidence", "support", "tags",
                   "origin_session", "origin_files", "contested_by", "hit_runs",
                   "use_count", "created_run", "last_used_run", "updated_at"]
        async with self._engine.begin() as conn:
            for row in rows:
                await conn.execute(self._upsert(
                    t.project_memory,
                    {"project_id": row.project_id, "key": row.key, "tier": row.tier,
                     "kind": row.kind, "content": row.content,
                     "confidence": row.confidence, "support": list(row.support),
                     "tags": list(row.tags), "origin_session": row.origin_session,
                     "origin_files": list(row.origin_files),
                     "contested_by": list(row.contested_by),
                     "hit_runs": list(row.hit_runs), "use_count": row.use_count,
                     "created_run": row.created_run,
                     "last_used_run": row.last_used_run, "updated_at": now},
                    index_elements=["project_id", "key"], update=mutable))
        return len(rows)

    async def delete_project_memory(self, pid: str,
                                    keys: list[str] | None = None) -> int:
        import sqlalchemy as sa

        from . import schema as t
        q = sa.delete(t.project_memory).where(t.project_memory.c.project_id == pid)
        if keys is not None:                       # None = 整个项目的记忆全清
            if not keys:
                return 0
            q = q.where(t.project_memory.c.key.in_(keys))
        async with self._engine.begin() as conn:
            r = await conn.execute(q)
        return int(r.rowcount or 0)

    # ── 设置 ─────────────────────────────────────────────────────
    async def get_setting(self, key: str) -> Any | None:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            return (await conn.execute(sa.select(t.app_setting.c.value).where(
                t.app_setting.c.key == key))).scalar_one_or_none()

    async def set_setting(self, key: str, value: Any) -> None:
        from . import schema as t
        async with self._engine.begin() as conn:
            await conn.execute(self._upsert(
                t.app_setting, {"key": key, "value": value},
                index_elements=["key"], update=["value"]))

    async def list_settings(self) -> list[SettingRow]:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.connect() as conn:
            rs = (await conn.execute(sa.select(t.app_setting.c.key,
                                               t.app_setting.c.value))).all()
        return [SettingRow(key=k, value=v) for k, v in rs]

    async def delete_setting(self, key: str) -> bool:
        import sqlalchemy as sa

        from . import schema as t
        async with self._engine.begin() as conn:
            r = await conn.execute(sa.delete(t.app_setting)
                                   .where(t.app_setting.c.key == key))
        return bool(r.rowcount)


def _session_row(r: Any) -> SessionRow:
    return SessionRow(
        id=r["id"], title=r["title"], project=r["project"], status=r["status"],
        error=r["error"], created=r["created_at"].timestamp(),
        state_version=r["state_version"], owner=r["owner"] or "",
        project_id=r["project_id"] or "")          # NULL ↔ ""（未归类）


def _project_row(r: Any) -> ProjectRow:
    return ProjectRow(
        id=r["id"], name=r["name"], owner=r["owner"] or "",   # NULL ↔ ""
        prefs=r["prefs"] or {}, sort_order=int(r["sort_order"] or 0))


def _project_memory_row(r: Any) -> ProjectMemoryRow:
    return ProjectMemoryRow(
        project_id=r["project_id"], key=r["key"], tier=r["tier"], kind=r["kind"],
        content=r["content"], confidence=float(r["confidence"]),
        support=list(r["support"] or []), tags=list(r["tags"] or []),
        origin_session=r["origin_session"] or "",
        origin_files=list(r["origin_files"] or []),
        contested_by=list(r["contested_by"] or []),
        hit_runs=list(r["hit_runs"] or []), use_count=int(r["use_count"] or 0),
        created_run=r["created_run"] or "", last_used_run=r["last_used_run"] or "")


def _active_decision_v1(rows: Sequence[DecisionRecordRow],
                        question_id: str) -> DecisionRecordRow | None:
    # failed 是副作用没有生效的审计记录，既不能成为 active
    # Decision，也不能靠 supersedes 把上一个成功决定从链上拿掉。
    live = [r for r in rows if r.metadata.get("status") != "failed"]
    superseded = {r.supersedes for r in live if r.supersedes}
    return next((r for r in reversed(live)
                 if r.question_id == question_id and r.id not in superseded), None)


def _question_row(r: Any) -> QuestionRow:
    return QuestionRow(
        id=r["id"], text=r["text"], status=r["status"],
        owner_user_id=r["owner_user_id"], audience_role=r["audience_role"],
        answer_schema=dict(r["answer_schema"] or {}), priority=r["priority"],
        dependencies=list(r["dependencies"] or []),
        blocked_artifacts=list(r["blocked_artifacts"] or []),
        source_kind=r["source_kind"], source_ref=r["source_ref"],
        doc=dict(r["doc"] or {}), version=int(r["version"]),
        created=r["created_at"].timestamp(), updated=r["updated_at"].timestamp())


def _decision_record_row(r: Any) -> DecisionRecordRow:
    return DecisionRecordRow(
        id=r["id"], question_id=r["question_id"], answer=r["answer"],
        actor=r["actor"], actor_role=r["actor_role"], authority=r["authority"],
        source_turn=r["source_turn"], affected_ids=list(r["affected_ids"] or []),
        supersedes=r["supersedes"], revision=r["revision"],
        idempotency_key=r["idempotency_key"], semantic_hash=r["semantic_hash"],
        rationale=r["rationale"], metadata=dict(r["metadata"] or {}),
        created=r["created_at"].timestamp())


def _revision_row(r: Any) -> RevisionRow:
    return RevisionRow(
        id=r["id"], ordinal=int(r["ordinal"]), parent_id=r["parent_id"],
        kind=r["kind"], status=r["status"], doc=dict(r["doc"] or {}),
        patch_set=dict(r["patch_set"]) if r["patch_set"] is not None else None,
        changed_ids=list(r["changed_ids"] or []),
        invalidated_artifacts=list(r["invalidated_artifacts"] or []),
        actor=r["actor"], source_turn=r["source_turn"], snapshot_hash=r["snapshot_hash"],
        idempotency_key=r["idempotency_key"], created=r["created_at"].timestamp())


def _user_row(r: Any) -> UserRow:
    return UserRow(
        id=r["id"], username=r["username"], password_hash=r["password_hash"],
        role=r["role"], active=bool(r["active"]), prefs=dict(r["prefs"] or {}),
        created=r["created_at"].timestamp(),
        display_name=r["display_name"] or "")


def _usage_row(r: Any) -> UsageRow:
    return UsageRow(
        id=r["id"], ts=float(r["ts"]), day=r["day"], model=r["model"],
        owner=r["owner"] or "", session_id=r["session_id"] or "",
        run_id=r["run_id"] or "", node_id=r["node_id"] or "", kind=r["kind"],
        effort=r["effort"] or "", tok_in=int(r["tok_in"]), tok_out=int(r["tok_out"]),
        cache_read=int(r["cache_read"]), cache_write=int(r["cache_write"]),
        usd=float(r["usd"]), usd_source=r["usd_source"],
        attempts=int(r["attempts"]), status=r["status"])


def _auth_row(r: Any) -> AuthSessionRow:
    return AuthSessionRow(
        token_hash=r["token_hash"], user_id=r["user_id"],
        created=r["created_at"].timestamp(), last_seen=r["last_seen_at"].timestamp(),
        expires=r["expires_at"].timestamp())


def build_repo(store: Any) -> Repo:
    """按 Store 的模式挑实现。**这是唯一的选路点。**"""
    return MemoryRepo() if not store.enabled else PgRepo(store.engine)


__all__ = [
    "AuthSessionRow",
    "DecisionRecordRow",
    "DecisionRow",
    "DuplicateUsername",
    "EventRow",
    "FileRow",
    "MemoryRepo",
    "PgRepo",
    "QuestionRow",
    "Repo",
    "RevisionRow",
    "SessionRow",
    "SettingRow",
    "UsageRow",
    "UserRow",
    "build_repo",
]
