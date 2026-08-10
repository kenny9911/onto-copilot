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

这份定义与 ``migrations/0001_init.sql`` 是**两份来源**。SQLite 侧靠
``metadata.create_all()``，Postgres 侧靠迁移文件。漂移由
``tests/test_store.py::test_ddl_matches_metadata``（``@pytest.mark.postgres``）
兜住 —— 它在真 PG 上跑一遍迁移、再 reflect 回来和这份 metadata 比对。
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
    sa.CheckConstraint(
        "status IN ('idle','parsing','extracting','awaiting_answer','done','failed')",
        name="session_status_ck"),
)

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
)

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


__all__ = [
    "metadata", "schema_migration", "session", "session_file", "run",
    "session_state", "conflict", "decision", "chat_turn", "session_event",
    "kernel_event", "blob", "app_user", "auth_session",
    "DERIVED_KEYS", "EVENT_INLINE_LIMIT",
]
