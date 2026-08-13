"""SQLAlchemy Core 表定义 —— 只有表结构，没有 ORM 映射。

**为什么是 Core 不是 ORM**：领域对象（:class:`~ontocopilot.onto.oir.OIR`、
:class:`~ontocopilot.onto.conflict.Conflict`、
:class:`~ontocopilot.kernel.memory.dialogue.DialogueMemory`）是手写 slots
dataclass，每个值都包在 ``Assertion`` 里、带 ``evidence: list[Provenance]``。
把它们映射成 ORM 实体意味着重写 oir.py —— 而 oir.py 是这个产品的信任基础，
不该为了持久化而动。Core 让存的形态就是 ``to_dict()`` 的形态。

**为什么 Core 而不是裸 asyncpg**：测试要在没有容器的前提下跑，
SQLite（``sqlite+aiosqlite``）与 Postgres（``postgresql+asyncpg``）两套方言
共用同一份表定义，才不会出现"仓储代码写了两遍、其中一遍没人测"。

这份定义与 ``migrations/*.sql`` 是**两份来源**。SQLite 侧靠
``metadata.create_all()``，Postgres 侧靠迁移文件。**列**的漂移由
``tests/test_store.py::test_migrations_and_metadata_declare_the_same_columns``
兜住 —— 它读迁移文本、把每张表的列名和这份 metadata 比对（列漂移的症状是运行时
``no such column`` / ``relation does not exist``，是最该先钉死的一类）。

索引、CHECK、触发器**不在**那个测试的管辖范围内，而且它们**已经漂移了**：
0001 给 session 建的 ``session_created_idx`` 等索引、``touch_updated_at`` 这类
plpgsql 触发器，在这份文件里一个都没有。所以别指望 ``updated_at`` 会自动刷新 ——
SQLite 上没有触发器，该由代码显式写。
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from .const import DERIVED_KEYS, EVENT_INLINE_LIMIT

metadata = sa.MetaData()


def _json(name: str, **kw):
    """PG 上是 jsonb，其它方言退回标准 JSON。"""
    return sa.Column(name, sa.JSON().with_variant(JSONB, "postgresql"), **kw)


schema_migration = sa.Table(
    "schema_migration", metadata,
    sa.Column("version", sa.Integer, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
    sa.Column("checksum", sa.Text, nullable=False),
    sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)

#: 项目文件夹。**只是分组，不是交付物上的项目名** —— 后者是 ``session.project``
#: （一列文本，会印进导出的 xlsx 与包名），两者语义不同，不要互相顶替。
#:
#: 不设 owner 外键，理由与 ``session.owner`` 相同（见 0004）：删账号不连带删项目。
project = sa.Table(
    "project", metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("name", sa.Text, nullable=False),
    #: app_user.id；NULL/'' = 无归属。与 session.owner 同源、同样不设外键。
    sa.Column("owner", sa.Text),
    #: 项目级偏好（命名规范/受众/问多少）。这轮恒为 {}，先把位置留出来。
    #: **不给 server_default** —— 跨方言的默认值不一致，由代码总是显式写 {}。
    _json("prefs", nullable=False),
    sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)
sa.Index("project_owner_idx", project.c.owner)

#: 项目记忆：同一项目下的会话共享的结论。**跨会话，所以不能挂在 session_state 上**
#: —— 那张表主键含 session_id 且随会话 CASCADE，删掉任意一个会话就把记忆一起删了。
#:
#: ``tier`` 是这张表存在的理由：``authoritative`` 是人拍板的约定，跨会话直接生效；
#: ``reference`` 是模型推断的教训，只作提示、永不晋升、不许进交付物的 provenance。
#: 两者混在一起存但**必须能分开查**，所以是一列受 CHECK 约束的枚举而不是布尔或标签。
#:
#: 不设到 project 的外键（同 0010 的理由）：删项目时由仓储显式删这些行，别把清理
#: 交给 CASCADE —— SQLite 侧的 PRAGMA foreign_keys 未必在每条路径上都开着。
project_memory = sa.Table(
    "project_memory", metadata,
    sa.Column("project_id", sa.Text, primary_key=True),
    #: MemoryItem.key，形如 "{kind}:{slug}"。**不含 project** —— 隔离靠这里的
    #: 复合主键，不靠 key 本身，所以同名主题在不同项目下互不干扰。
    sa.Column("key", sa.Text, primary_key=True),
    sa.Column("tier", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("content", sa.Text, nullable=False),
    sa.Column("confidence", sa.Float, nullable=False),
    _json("support", nullable=False),
    _json("tags", nullable=False),
    #: 这条记忆是在哪个会话里形成的。reference 档进 prompt 时要逐行标出来源。
    sa.Column("origin_session", sa.Text, nullable=False, server_default=""),
    #: 这条记忆来自哪几份材料。换会话换材料时据此再降一档权重。
    _json("origin_files", nullable=False),
    _json("contested_by", nullable=False),
    _json("hit_runs", nullable=False),
    sa.Column("use_count", sa.Integer, nullable=False, server_default="0"),
    sa.Column("created_run", sa.Text, nullable=False, server_default=""),
    sa.Column("last_used_run", sa.Text, nullable=False, server_default=""),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.CheckConstraint("tier IN ('authoritative','reference')",
                       name="project_memory_tier_ck"),
)

session = sa.Table(
    "session", metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("title", sa.Text, nullable=False, server_default="新建会话"),
    sa.Column("project", sa.Text, nullable=False, server_default=""),
    sa.Column("status", sa.Text, nullable=False, server_default="idle"),
    sa.Column("error", sa.Text, nullable=False, server_default=""),
    sa.Column("state_version", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("next_event_seq", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("next_run_ordinal", sa.Integer, nullable=False, server_default="0"),
    sa.Column("next_decision_ordinal", sa.Integer, nullable=False, server_default="0"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    #: 会话归属的账号 id（app_user.id）。NULL/'' = 无归属 —— 迁移前的旧会话与开放
    #  模式创建的会话都是这种，在强制鉴权下对所有人隐藏。不设外键：删账号不连带
    #  删会话（归属改判交给上层），也避免与 app_user 的生命周期耦合。
    sa.Column("owner", sa.Text),
    #: 所属项目文件夹（project.id）。NULL/'' = 未归类。聊天模式的会话恒为空。
    #  不设外键：删项目时由仓储显式把成员会话置空（同 owner 的先例）。
    sa.Column("project_id", sa.Text),
    sa.CheckConstraint(
        "status IN ('idle','queued','parsing','extracting','awaiting_answer','done','failed','stopped')",
        name="session_status_ck"),
)
sa.Index("session_project_idx", session.c.project_id)

# A build task itself lives in one ASGI worker, but its ownership must not.  A
# lease prevents another worker (or a newly started replica) from treating a
# still-live ``queued/parsing/extracting`` session as abandoned.
build_lease = sa.Table(
    "build_lease", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("owner", sa.Text, nullable=False),
    sa.Column("acquired_at", sa.Float, nullable=False),
    sa.Column("heartbeat_at", sa.Float, nullable=False),
    sa.Column("expires_at", sa.Float, nullable=False),
    sa.Column("cancel_requested_at", sa.Float),
)
sa.Index("build_lease_expiry_idx", build_lease.c.expires_at)

# Chat mutates DialogueMemory and several session_state documents via a read/modify/write
# cycle.  An invocation-scoped lease prevents two ASGI workers from both reading the
# same snapshot and committing last-writer-wins updates.
chat_lease = sa.Table(
    "chat_lease", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("owner", sa.Text, nullable=False),
    sa.Column("acquired_at", sa.Float, nullable=False),
    sa.Column("heartbeat_at", sa.Float, nullable=False),
    sa.Column("expires_at", sa.Float, nullable=False),
    sa.Column("cancel_requested_at", sa.Float),
)
sa.Index("chat_lease_expiry_idx", chat_lease.c.expires_at)

# Domain mutations span Question/Decision/Revision rows, session_state and generated
# files.  One durable lease serializes that read/modify/write unit across workers and
# is mutually exclusive with a build lease.
mutation_lease = sa.Table(
    "mutation_lease", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("owner", sa.Text, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("acquired_at", sa.Float, nullable=False),
    sa.Column("heartbeat_at", sa.Float, nullable=False),
    sa.Column("expires_at", sa.Float, nullable=False),
)
sa.Index("mutation_lease_expiry_idx", mutation_lease.c.expires_at)

session_file = sa.Table(
    "session_file", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("name", sa.Text, primary_key=True),
    #: 相对 workspace/<session_id>/ —— 绝不存绝对路径（现状 server.py:187）。
    sa.Column("rel_path", sa.Text, nullable=False),
    sa.Column("size_bytes", sa.BigInteger, nullable=False),
    sa.Column("sha256", sa.Text, nullable=False, server_default=""),
    sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)

run = sa.Table(
    "run", metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), nullable=False),
    sa.Column("ordinal", sa.Integer, nullable=False),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("status", sa.Text, nullable=False, server_default="running"),
    _json("budget", nullable=False, server_default="{}"),
    sa.Column("error", sa.Text, nullable=False, server_default=""),
    sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("ended_at", sa.DateTime(timezone=True)),
    sa.UniqueConstraint("session_id", "ordinal", name="run_session_ordinal_uq"),
    sa.CheckConstraint("status IN ('running','suspended','done','failed')",
                       name="run_status_ck"),
)

session_state = sa.Table(
    "session_state", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("key", sa.Text, primary_key=True),
    _json("doc", nullable=False),
    sa.Column("version", sa.BigInteger, nullable=False),
    sa.Column("derived", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)

conflict = sa.Table(
    "conflict", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("rid", sa.Text, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("handling", sa.Text, nullable=False),
    sa.Column("summary", sa.Text, nullable=False, server_default=""),
    _json("subjects", nullable=False, server_default="[]"),
    sa.Column("detector", sa.Text, nullable=False, server_default="rule"),
    sa.Column("owner", sa.Text),
    _json("doc", nullable=False),
    sa.Column("asked", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("ask_rank", sa.Integer),
    sa.Column("version", sa.BigInteger, nullable=False),
    sa.CheckConstraint(
        "handling IN ('ask_user','auto_repair','round_trip','hint')",
        name="conflict_handling_ck"),
)

decision = sa.Table(
    "decision", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    #: DialogueMemory._decisions 的下标。superseded_by 直接引用它
    #: （dialogue.py:208），这样 DialogueMemory.from_dict 能原样读回。
    sa.Column("ordinal", sa.Integer, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("statement", sa.Text, nullable=False, server_default=""),
    _json("scope_refs", nullable=False, server_default="[]"),
    sa.Column("turn_index", sa.Integer, nullable=False, server_default="-1"),
    sa.Column("superseded_by", sa.Integer),
    sa.Column("target_rid", sa.Text, nullable=False, server_default=""),
    sa.Column("option_id", sa.Text, nullable=False, server_default=""),
    _json("changed", nullable=False, server_default="[]"),
    sa.Column("note", sa.Text, nullable=False, server_default=""),
    sa.Column("actor", sa.Text, nullable=False, server_default="user"),
    sa.Column("ts", sa.Float, nullable=False, server_default="0"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.CheckConstraint(
        "kind IN ('caliber','naming','scope','answer','adoption','correction')",
        name="decision_kind_ck"),
)

#: 一条冲突同时只能有一个生效的答复 —— POST /answer 因此天然幂等，
#: 并且取代内存里的 s.state["answered"]（server.py:490-492）。
#: SQLite 与 Postgres 都支持部分唯一索引，语法一致。
sa.Index("decision_live_answer_uq", decision.c.session_id, decision.c.target_rid,
         unique=True,
         postgresql_where=sa.text("kind = 'answer' AND superseded_by IS NULL"),
         sqlite_where=sa.text("kind = 'answer' AND superseded_by IS NULL"))


# ══════════════════════════════════════════════════════════════════
#  统一 Question / Decision / Revision（v1）
# ══════════════════════════════════════════════════════════════════
# 保留上面的 legacy decision：DialogueMemory 与 conflict /answer 仍按 ordinal 工作。
# 新表承接所有来源的问题和自由文本/结构化回答；两套数据可由兼容投影逐步迁移，
# 不要求一次性改完 server.py 的所有调用点。
question_item = sa.Table(
    "question_item", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("text", sa.Text, nullable=False),
    sa.Column("status", sa.Text, nullable=False, server_default="open"),
    sa.Column("owner_user_id", sa.Text, nullable=False, server_default=""),
    sa.Column("audience_role", sa.Text, nullable=False, server_default=""),
    _json("answer_schema", nullable=False, server_default="{}"),
    sa.Column("priority", sa.Text, nullable=False, server_default="normal"),
    _json("dependencies", nullable=False, server_default="[]"),
    _json("blocked_artifacts", nullable=False, server_default="[]"),
    sa.Column("source_kind", sa.Text, nullable=False, server_default="manual"),
    sa.Column("source_ref", sa.Text, nullable=False, server_default=""),
    _json("doc", nullable=False),
    sa.Column("version", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.CheckConstraint(
        "status IN ('open','assigned','blocked','answered','deferred','cancelled')",
        name="question_item_status_ck"),
    sa.CheckConstraint(
        "priority IN ('blocking','high','normal','low')",
        name="question_item_priority_ck"),
)
sa.Index("question_item_queue_idx", question_item.c.session_id,
         question_item.c.status, question_item.c.priority)
sa.Index("question_item_source_idx", question_item.c.session_id,
         question_item.c.source_kind, question_item.c.source_ref)


decision_record = sa.Table(
    "decision_record", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("question_id", sa.Text, nullable=False),
    _json("answer", nullable=False),
    sa.Column("actor", sa.Text, nullable=False),
    sa.Column("actor_role", sa.Text, nullable=False, server_default=""),
    sa.Column("authority", sa.Text, nullable=False, server_default=""),
    sa.Column("source_turn", sa.Text, nullable=False, server_default=""),
    _json("affected_ids", nullable=False, server_default="[]"),
    sa.Column("supersedes", sa.Text),
    sa.Column("revision", sa.BigInteger),
    sa.Column("idempotency_key", sa.Text, nullable=False),
    sa.Column("semantic_hash", sa.Text, nullable=False),
    sa.Column("rationale", sa.Text, nullable=False, server_default=""),
    _json("metadata", nullable=False, server_default="{}"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)
sa.Index("decision_record_question_idx", decision_record.c.session_id,
         decision_record.c.question_id, decision_record.c.created_at)
sa.Index("decision_record_idempotency_uq", decision_record.c.session_id,
         decision_record.c.idempotency_key, unique=True)


revision_record = sa.Table(
    "revision_record", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("ordinal", sa.BigInteger, nullable=False),
    sa.Column("parent_id", sa.Text),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("status", sa.Text, nullable=False),
    _json("patch_set", nullable=True),
    _json("changed_ids", nullable=False, server_default="[]"),
    _json("invalidated_artifacts", nullable=False, server_default="[]"),
    sa.Column("actor", sa.Text, nullable=False, server_default="agent"),
    sa.Column("source_turn", sa.Text, nullable=False, server_default=""),
    sa.Column("snapshot_hash", sa.Text, nullable=False, server_default=""),
    sa.Column("idempotency_key", sa.Text, nullable=False, server_default=""),
    _json("doc", nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.UniqueConstraint("session_id", "ordinal", name="revision_record_ordinal_uq"),
    sa.CheckConstraint(
        "status IN ('proposed','applied','rejected','rolled_back')",
        name="revision_record_status_ck"),
)
sa.Index("revision_record_idempotency_uq", revision_record.c.session_id,
         revision_record.c.idempotency_key, unique=True,
         postgresql_where=sa.text("idempotency_key <> ''"),
         sqlite_where=sa.text("idempotency_key <> ''"))

chat_turn = sa.Table(
    "chat_turn", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("ordinal", sa.Integer, primary_key=True),
    sa.Column("speaker", sa.Text, nullable=False),
    sa.Column("text", sa.Text, nullable=False),
    sa.Column("intent", sa.Text, nullable=False, server_default=""),
    _json("refs", nullable=False, server_default="[]"),
    sa.Column("compressed", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("ts", sa.Float, nullable=False, server_default="0"),
)

session_event = sa.Table(
    "session_event", metadata,
    sa.Column("session_id", sa.Text,
              sa.ForeignKey("session.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("seq", sa.BigInteger, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    _json("payload", nullable=False, server_default="{}"),
    sa.Column("ref", sa.Text),
    sa.Column("ts", sa.Float, nullable=False),
    # 进程在 commit 成功、回执返回前退出时，同一队列项恢复重试不能再写一条。
    # UUID 是跨 worker 的幂等身份；seq 仍是每会话的展示/游标顺序。
    sa.Column("event_id", sa.Text),
)
sa.Index("session_event_event_id_uq", session_event.c.event_id, unique=True,
         postgresql_where=sa.text("event_id IS NOT NULL"),
         sqlite_where=sa.text("event_id IS NOT NULL"))

kernel_event = sa.Table(
    "kernel_event", metadata,
    sa.Column("run_id", sa.Text,
              sa.ForeignKey("run.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("seq", sa.BigInteger, primary_key=True),
    sa.Column("kind", sa.Text, nullable=False),
    sa.Column("node_id", sa.Text),
    _json("payload", nullable=False, server_default="{}"),
    sa.Column("ref", sa.Text),
    sa.Column("ts_ms", sa.BigInteger, nullable=False, server_default="0"),
)

blob = sa.Table(
    "blob", metadata,
    sa.Column("ref", sa.Text, primary_key=True),
    sa.Column("data", sa.LargeBinary, nullable=False),
    sa.Column("size_bytes", sa.Integer, nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)


# ══════════════════════════════════════════════════════════════════
#  账号与登录会话（鉴权层）—— 与建模 session 无关的两张顶层表
# ══════════════════════════════════════════════════════════════════
# 数据是共享的（单管理员门禁，不按用户隔离），账号只用于登录与角色控制，
# 所以这两张表**不挂在建模 session 之下**、没有 owner 外键。
# id / password_hash / token 一律在 Python 里生成（uuid4 / scrypt / token_urlsafe），
# **不用** gen_random_uuid / pgcrypto —— 否则 SQLite 与 MemoryRepo 两条路都跑不通。
app_user = sa.Table(
    "app_user", metadata,
    sa.Column("id", sa.Text, primary_key=True),                     # uuid4().hex
    sa.Column("username", sa.Text, nullable=False, unique=True),    # 调用方已 strip().lower()
    #: 称呼用的名字，**原样保留大小写与空格**。username 被 lower() 过，拿来问候人
    #  不合适。空串 = 没填（管理员建号、CLI 建号、迁移前的老账号），展示时回落到
    #  username。不唯一、不索引 —— 重名合法，也从不按它查。
    sa.Column("display_name", sa.Text, nullable=False, server_default=""),
    sa.Column("password_hash", sa.Text, nullable=False),            # scrypt 自描述串
    sa.Column("role", sa.Text, nullable=False, server_default="user"),
    sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
    #: 外观/语言偏好（主题、强调色、时区、字号、语言）。必须在**建表时**就有 ——
    #  迁移一旦落库就按 checksum 锁死，以后想 ALTER 进来得单开一个迁移文件。
    _json("prefs", nullable=False, server_default="{}"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.CheckConstraint("role IN ('admin','user')", name="app_user_role_ck"),
)

# 登录会话：主键是令牌的 sha256，**不是令牌本身** —— 库里泄了也换不出 cookie。
# 明文令牌只活在浏览器的 HttpOnly cookie 里。过期行读时过滤 + 周期性清理。
auth_session = sa.Table(
    "auth_session", metadata,
    sa.Column("token_hash", sa.Text, primary_key=True),
    sa.Column("user_id", sa.Text,
              sa.ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
)
sa.Index("auth_session_user_idx", auth_session.c.user_id)


# 全局应用设置（管理员可改的网关/预算配置）。键值对，value 是 JSON —— 与
# session_state 同一套形态。**顶层**，与建模会话无关，故不随会话级联。
#: 模型用量流水。**一次模型调用一行，跨会话、独立于会话生命周期。**
#:
#: 为什么是独立的顶层表，而不是挂在 session 或复用 run.budget：
#:   * 它要回答的是"这个月一共烧了多少 token""哪个模型最贵"——那是跨会话的问题，
#:     而 `run.budget` 是每次调用新建一个 Budget 的**每轮快照**，
#:     `session_state["budget"]` 更只是最后一次梳理的快照，两个都加不起来。
#:   * 会话删掉/purge 之后，账还得在。所以 session_id **不设外键**、不跟着 CASCADE。
#:   * 盘上那份 journal jsonl 不能当账本：它按 run 散在各会话目录里、没有归属、
#:     purge 会连目录一起 rmtree，而且**重放会重复记账**（Recorder 回放不真的调
#:     模型，但旧代码照样 spend 一次）。
#:
#: `day` 是**存出来的**而不是查询时算的：date_trunc 只有 PG 有、strftime 只有
#: SQLite 有，任何一个都会把"两种实现走同一条代码路径"这条规矩打破。
llm_usage = sa.Table(
    "llm_usage", metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("ts", sa.Float, nullable=False),
    #: 'YYYY-MM-DD'（UTC），写入时算好，按天聚合直接 GROUP BY 它
    sa.Column("day", sa.Text, nullable=False),
    #: app_user.id；'' = 无归属。和 session.owner 一样**不设外键**（见 0004）
    sa.Column("owner", sa.Text, nullable=False, server_default=""),
    sa.Column("session_id", sa.Text, nullable=False, server_default=""),
    sa.Column("run_id", sa.Text, nullable=False, server_default=""),
    sa.Column("node_id", sa.Text, nullable=False, server_default=""),
    #: build | chat | aux —— 这次调用是干什么的
    sa.Column("kind", sa.Text, nullable=False, server_default="build"),
    sa.Column("model", sa.Text, nullable=False),
    sa.Column("effort", sa.Text, nullable=False, server_default=""),
    sa.Column("tok_in", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("tok_out", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("cache_read", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("cache_write", sa.BigInteger, nullable=False, server_default="0"),
    sa.Column("usd", sa.Float, nullable=False, server_default="0"),
    #: gateway = 网关回的真实账单；estimated = 本地价目表估的（**很多模型的价目
    #: 是编的**，见 catalog.card_from_name 的 2.0/8.0），界面据此决定敢不敢显示金额
    sa.Column("usd_source", sa.Text, nullable=False, server_default="estimated"),
    #: 实际打给模型几次（schema 重试、截断加预算重试都算），tok 是这几次的总和
    sa.Column("attempts", sa.Integer, nullable=False, server_default="1"),
    sa.Column("status", sa.Text, nullable=False, server_default="ok"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
    # 这四条曾经各写了两遍（复制粘贴留下的）。SQLAlchemy **不按名字去重** ——
    # 两个方言编出来的 CREATE TABLE 里每条都出现两次。SQLite 不校验约束名唯一性
    # 所以一直没人发现；换成 Postgres 跑 create_all 就会直接建表失败。
    # 目前 PG 走 migrate.py 不走 create_all，所以这是颗还没踩到的雷，不是活故障。
    sa.CheckConstraint("kind IN ('build','chat','aux')", name="llm_usage_kind_ck"),
    sa.CheckConstraint(
        "tok_in >= 0 AND tok_out >= 0 AND cache_read >= 0 AND cache_write >= 0",
        name="llm_usage_tokens_ck",
    ),
    sa.CheckConstraint("usd >= 0", name="llm_usage_usd_ck"),
    sa.CheckConstraint("attempts >= 1", name="llm_usage_attempts_ck"),
    sa.CheckConstraint("usd_source IN ('gateway','estimated')",
                       name="llm_usage_usd_source_ck"),
    sa.CheckConstraint("status IN ('ok','failed')", name="llm_usage_status_ck"),
)
sa.Index("llm_usage_owner_day_idx", llm_usage.c.owner, llm_usage.c.day)
sa.Index("llm_usage_ts_idx", llm_usage.c.ts)
sa.Index("llm_usage_model_day_idx", llm_usage.c.model, llm_usage.c.day)

app_setting = sa.Table(
    "app_setting", metadata,
    sa.Column("key", sa.Text, primary_key=True),
    _json("value", nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
              server_default=sa.func.now()),
)


__all__ = [
    "DERIVED_KEYS",
    "EVENT_INLINE_LIMIT",
    "app_setting",
    "app_user",
    "auth_session",
    "blob",
    "build_lease",
    "chat_lease",
    "chat_turn",
    "conflict",
    "decision",
    "decision_record",
    "kernel_event",
    "llm_usage",
    "metadata",
    "project",
    "project_memory",
    "question_item",
    "revision_record",
    "run",
    "schema_migration",
    "session",
    "session_event",
    "session_file",
    "session_state",
]
