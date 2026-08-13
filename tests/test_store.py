"""持久化层。

这层最危险的失败不是"数据库连不上"，是**两个实现行为不一致** —— 开发机上
（内存）跑得好好的，上了生产（Postgres）行为变了，而且变的往往是边界情况：
空值、并发、顺序、软删除。所以下面每个用例都在**两个实现上各跑一遍**，
用同一份断言。

Postgres 侧用 SQLite 代跑：这里验的是仓储 SQL 的行为语义，不是 Postgres 的
方言特性。要一个容器才能跑测试，代价远大于收益。
"""

from __future__ import annotations

import asyncio

import pytest

from ontocopilot.store.engine import Store, database_url
from ontocopilot.store.repo import (
    AuthSessionRow,
    DecisionRow,
    DuplicateUsername,
    FileRow,
    MemoryRepo,
    ProjectMemoryRow,
    ProjectRow,
    SessionRow,
    UserRow,
    build_repo,
)


@pytest.fixture(params=["memory", "sql"])
async def repo(request):
    """两个实现，同一份断言。"""
    if request.param == "memory":
        store = await Store.open("")
        yield build_repo(store)
        await store.close()
    else:
        store = await Store.open("sqlite+aiosqlite:///:memory:", create_all=True)
        yield build_repo(store)
        await store.close()


def _sess(sid: str = "s1", **kw) -> SessionRow:
    base = {"id": sid, "title": "采购中台", "project": "ONT-112",
            "status": "idle", "error": "", "created": 1_700_000_000.0,
            "state_version": 0}
    return SessionRow(**{**base, **kw})


# ══════════════════════════════════════════════════════════════════
#  选路
# ══════════════════════════════════════════════════════════════════
async def test_no_database_url_falls_back_to_memory():
    """没配数据库**不是故障**，是受支持的模式。"""
    store = await Store.open("")
    assert not store.enabled
    assert isinstance(build_repo(store), MemoryRepo)
    health = await store.healthcheck()
    assert health["ok"] and health["mode"] == "memory"
    # 但必须**明说**会丢，不能装作没事
    assert "重启" in health["note"]
    await store.close()


def test_database_url_normalisation():
    """运维习惯写 postgres://，忘了 driver 的报错（MissingGreenlet）极难看懂。"""
    assert database_url({"DATABASE_URL": "postgres://u:p@h/db"}) == \
        "postgresql+asyncpg://u:p@h/db"
    assert database_url({"DATABASE_URL": "postgresql://u:p@h/db"}) == \
        "postgresql+asyncpg://u:p@h/db"
    assert database_url({"DATABASE_URL": "postgresql+asyncpg://u@h/db"}) == \
        "postgresql+asyncpg://u@h/db"
    assert database_url({}) == ""


# ══════════════════════════════════════════════════════════════════
#  会话
# ══════════════════════════════════════════════════════════════════
async def test_session_round_trip(repo):
    await repo.create_session(_sess())
    got = await repo.get_session("s1")
    assert got is not None
    assert (got.title, got.project, got.status) == ("采购中台", "ONT-112", "idle")


async def test_missing_session_is_none_not_an_exception(repo):
    assert await repo.get_session("没有这个") is None


async def test_sessions_list_newest_first(repo):
    for i, ts in enumerate([100.0, 300.0, 200.0]):
        await repo.create_session(_sess(f"s{i}", created=ts))
    ids = [s.id for s in await repo.list_sessions()]
    assert ids[:3] == ["s1", "s2", "s0"]


async def test_rename_session_reports_whether_it_hit_anything(repo):
    await repo.create_session(_sess())
    assert await repo.rename_session("s1", "采购计划梳理") is True
    assert (await repo.get_session("s1")).title == "采购计划梳理"
    assert await repo.rename_session("不存在", "x") is False


async def test_renaming_a_session_does_not_disturb_the_state_cas(repo):
    """改名不许推进 state_version。

    它是状态文档的 CAS 令牌：正在跑的 build/chat 都拿着自己那份期望值提交。
    跟着 +1 的话，用户在侧栏改个标题就能让另一台 worker 几分钟的梳理提交 409。
    """
    await repo.create_session(_sess())
    version = await repo.save_state("s1", {"mode": "work"})
    assert await repo.rename_session("s1", "改个名") is True
    assert (await repo.get_session("s1")).state_version == version
    # 而且不碰状态文档本身
    assert (await repo.load_state("s1", keys=["mode"])) == {"mode": "work"}


# ══════════════════════════════════════════════════════════════════
#  状态
# ══════════════════════════════════════════════════════════════════
async def test_session_status_claim_is_atomic_under_concurrency(repo):
    """Memory/SQLite 都只能让一个并发 worker 把 idle 抢成 queued。"""
    await repo.create_session(_sess())
    claimed = await asyncio.gather(*(
        repo.claim_session_status(
            "s1", from_statuses=("idle", "done", "failed", "stopped"),
            to_status="queued",
        )
        for _ in range(20)
    ))
    assert claimed.count(True) == 1
    assert claimed.count(False) == 19
    assert (await repo.get_session("s1")).status == "queued"


async def test_sqlite_status_claim_is_atomic_across_independent_repos(tmp_path):
    """两个独立连接模拟两个 worker，不能依赖同一个 PgRepo/engine 的串行化。"""
    url = f"sqlite+aiosqlite:///{tmp_path / 'claim.db'}"
    store_a = await Store.open(url, create_all=True)
    store_b = await Store.open(url)
    repo_a, repo_b = build_repo(store_a), build_repo(store_b)
    try:
        await repo_a.create_session(_sess())
        results = await asyncio.gather(*(
            repo.claim_session_status(
                "s1", from_statuses=("idle", "done", "failed", "stopped"),
                to_status="queued",
            )
            for repo in (repo_a, repo_b)
        ))
        assert sorted(results) == [False, True]
        assert (await repo_a.get_session("s1")).status == "queued"
        assert (await repo_b.get_session("s1")).status == "queued"
    finally:
        await store_b.close()
        await store_a.close()


async def test_session_status_claim_never_overwrites_awaiting_answer(repo):
    """待业务拍板是悬挂点，任何新 build claim 都不能覆盖它。"""
    await repo.create_session(_sess(status="awaiting_answer", error="等采购经理"))
    claimed = await repo.claim_session_status(
        "s1", from_statuses=("idle", "done", "failed", "stopped"),
        to_status="queued",
    )
    row = await repo.get_session("s1")
    assert claimed is False
    assert (row.status, row.error) == ("awaiting_answer", "等采购经理")


async def test_session_status_claim_allows_explicit_rerun_after_terminal_state(repo):
    await repo.create_session(_sess(status="done", error="旧错误"))
    assert await repo.claim_session_status(
        "s1", from_statuses=("idle", "done", "failed", "stopped"),
        to_status="queued", error="",
    )
    row = await repo.get_session("s1")
    assert (row.status, row.error) == ("queued", "")


async def test_state_survives_and_versions_bump(repo):
    await repo.create_session(_sess())
    v1 = await repo.save_state("s1", {"oir": {"stats": {"objects": 3}}})
    v2 = await repo.save_state("s1", {"oir": {"stats": {"objects": 7}}})
    assert v2 > v1
    assert (await repo.load_state("s1"))["oir"]["stats"]["objects"] == 7


async def test_version_and_patch_stacks_survive_restart(repo):
    """撤销历史与人工补丁栈（`_flow_versions`/`_tpl_patch_log` 等私有键）是最不该
    丢的一份状态 —— 重启后必须还在，且不能被当成 derived 在按需加载时丢掉。"""
    await repo.create_session(_sess())
    stack = [{"nodes": []}, {"nodes": [{"rid": "n1"}]}]
    plog = [{"op": "add_column", "args": {"sheet": "S", "name": "状态"}}]
    await repo.save_state("s1", {"_flow_versions": stack, "_tpl_patch_log": plog})
    got = await repo.load_state("s1")
    assert got["_flow_versions"] == stack
    assert got["_tpl_patch_log"] == plog
    # 不是 derived —— 按需加载（include_derived=False）也要留着
    keep = await repo.load_state("s1", include_derived=False)
    assert "_flow_versions" in keep and "_tpl_patch_log" in keep


async def test_partial_state_write_does_not_clobber_other_keys(repo):
    """按 key 存，不是整包覆盖 —— 否则两个并发写会互相吃掉对方。"""
    await repo.create_session(_sess())
    await repo.save_state("s1", {"corpus": {"files": 2}, "template": {"sheets": 5}})
    await repo.save_state("s1", {"template": {"sheets": 6}})
    st = await repo.load_state("s1")
    assert st["corpus"] == {"files": 2}
    assert st["template"] == {"sheets": 6}


async def test_state_can_be_read_selectively(repo):
    """打开会话列表时不该把 800KB 的 oir 一起拉回来。"""
    await repo.create_session(_sess())
    await repo.save_state("s1", {"corpus": {"files": 2}, "oir": {"big": "x" * 500}})
    only = await repo.load_state("s1", keys=["corpus"])
    assert set(only) == {"corpus"}


# ══════════════════════════════════════════════════════════════════
#  文件
# ══════════════════════════════════════════════════════════════════
async def test_files_round_trip(repo):
    await repo.create_session(_sess())
    await repo.add_files("s1", [
        FileRow(name="梳理表.xlsx", rel_path="materials/梳理表.xlsx",
                size=38754, sha256="a" * 64)])
    got = await repo.list_files("s1")
    assert [f.name for f in got] == ["梳理表.xlsx"]
    assert got[0].size == 38754


async def test_reopening_a_session_still_has_its_materials(repo):
    """只存数量的话，重开会话就没法渲染材料列表，「点回原文」直接断掉。"""
    await repo.create_session(_sess())
    await repo.add_files("s1", [FileRow(name="a.xlsx", rel_path="materials/a.xlsx",
                                        size=1, sha256="b" * 64)])
    assert len(await repo.list_files("s1")) == 1


# ══════════════════════════════════════════════════════════════════
#  事件
# ══════════════════════════════════════════════════════════════════
async def test_events_keep_their_order(repo):
    """SSE 的 since= 补发按 seq 走 —— 顺序错了断线重连就会乱。"""
    await repo.create_session(_sess())
    for i in range(5):
        await repo.append_event("s1", f"k{i}", {"n": i})
    assert await repo.count_events("s1") == 5


async def test_event_seq_starts_at_zero_and_is_dense(repo):
    await repo.create_session(_sess())
    rows = [await repo.append_event("s1", "x", {}) for _ in range(3)]
    assert [r.seq for r in rows] == [0, 1, 2]


# ══════════════════════════════════════════════════════════════════
#  Run 生命周期
# ══════════════════════════════════════════════════════════════════
async def test_run_ids_are_unique_monotonic_and_can_finish(repo):
    await repo.create_session(_sess())
    ids = await asyncio.gather(*(repo.next_run("s1", "build:full") for _ in range(20)))
    assert len(set(ids)) == 20
    assert set(ids) == {f"s1.{i}" for i in range(20)}
    await asyncio.gather(*(
        repo.finish_run(rid, status="done", budget={"ordinal": i})
        for i, rid in enumerate(ids)
    ))


async def test_run_can_finish_suspended_or_failed(repo):
    await repo.create_session(_sess())
    suspended = await repo.next_run("s1", "build:full")
    failed = await repo.next_run("s1", "build:preview")
    await repo.finish_run(suspended, status="suspended", budget={"usd": 0.5})
    await repo.finish_run(failed, status="failed", error="cancelled")


# ══════════════════════════════════════════════════════════════════
#  决定
# ══════════════════════════════════════════════════════════════════
def _dec(ordinal: int, **kw) -> DecisionRow:
    base = {"ordinal": ordinal, "kind": "caliber", "statement": "含税指专票",
            "scope_refs": [], "turn_index": 0, "superseded_by": None,
            "target_rid": "", "option_id": "", "changed": [], "note": "",
            "ts": 1_700_000_000.0}
    return DecisionRow(**{**base, **kw})


async def test_decisions_round_trip(repo):
    await repo.create_session(_sess())
    await repo.record_decision("s1", _dec(0))
    got = await repo.list_decisions("s1")
    assert [d.statement for d in got] == ["含税指专票"]


async def test_superseded_decisions_are_kept_but_filtered(repo):
    """用户改主意的过程本身是信息 —— 删掉就没法审计「当时为什么那样做」。"""
    await repo.create_session(_sess())
    await repo.record_decision("s1", _dec(0, superseded_by=1))
    await repo.record_decision("s1", _dec(1, statement="改成普票"))
    assert len(await repo.list_decisions("s1")) == 2
    active = await repo.list_decisions("s1", active_only=True)
    assert [d.statement for d in active] == ["改成普票"]


# ══════════════════════════════════════════════════════════════════
#  冲突与已答
# ══════════════════════════════════════════════════════════════════
async def test_conflicts_and_answered_rids(repo):
    await repo.create_session(_sess())
    await repo.save_state("s1", {}, conflicts=[
        {"rid": "cf_1", "kind": "caliber_divergence", "handling": "ask_user",
         "summary": "口径不一致"},
        {"rid": "cf_2", "kind": "orphan", "handling": "hint",
         "summary": "孤儿"}], asked_rids=["cf_1"])
    assert {c["rid"] for c in await repo.list_conflicts("s1")} == {"cf_1", "cf_2"}
    assert (await repo.get_conflict("s1", "cf_1"))["kind"] == "caliber_divergence"
    assert await repo.get_conflict("s1", "不存在") is None


# ══════════════════════════════════════════════════════════════════
#  账号与登录会话（鉴权层）—— 顶层数据，两个实现同一份断言
# ══════════════════════════════════════════════════════════════════
def _user(uid: str = "u1", username: str = "alice", **kw) -> UserRow:
    base = {"id": uid, "username": username, "password_hash": "scrypt$x",
            "role": "user", "active": True, "prefs": {}, "created": 1_700_000_000.0}
    return UserRow(**{**base, **kw})


async def test_user_round_trip(repo):
    await repo.create_user(_user())
    got = await repo.get_user("u1")
    assert got is not None
    assert (got.username, got.role, got.active) == ("alice", "user", True)
    assert got.password_hash == "scrypt$x"


async def test_user_lookup_by_username(repo):
    await repo.create_user(_user())
    got = await repo.get_user_by_username("alice")
    assert got is not None and got.id == "u1"
    assert await repo.get_user_by_username("nobody") is None


async def test_duplicate_username_raises_same_error_in_both(repo):
    """两个实现必须抛同一种异常 —— 否则 memory 上 409、sql 上 500，测不到。"""
    await repo.create_user(_user())
    with pytest.raises(DuplicateUsername):
        await repo.create_user(_user(uid="u2", username="alice"))


async def test_users_listed_oldest_first_and_counted(repo):
    await repo.create_user(_user("u0", "admin", role="admin", created=100.0))
    await repo.create_user(_user("u1", "bob", created=200.0))
    assert await repo.count_users() == 2
    assert [u.id for u in await repo.list_users()] == ["u0", "u1"]


async def test_update_user_fields(repo):
    await repo.create_user(_user())
    await repo.update_user("u1", role="admin", active=False,
                           password_hash="scrypt$y", prefs={"theme": "dark"})
    got = await repo.get_user("u1")
    assert (got.role, got.active, got.password_hash) == ("admin", False, "scrypt$y")
    assert got.prefs == {"theme": "dark"}


async def test_update_missing_user_returns_none(repo):
    assert await repo.update_user("ghost", role="admin") is None


async def test_delete_user_cascades_auth_sessions(repo):
    await repo.create_user(_user())
    await repo.create_auth_session(
        AuthSessionRow(token_hash="h1", user_id="u1", expires=9_999_999_999.0))
    assert await repo.get_auth_session("h1") is not None
    assert await repo.delete_user("u1") is True
    assert await repo.get_user("u1") is None
    assert await repo.get_auth_session("h1") is None      # 级联删掉


async def test_auth_session_round_trip_and_delete(repo):
    await repo.create_user(_user())
    await repo.create_auth_session(
        AuthSessionRow(token_hash="h1", user_id="u1", expires=9_999_999_999.0))
    assert (await repo.get_auth_session("h1")).user_id == "u1"
    assert await repo.delete_auth_session("h1") is True
    assert await repo.get_auth_session("h1") is None


async def test_delete_user_auth_sessions_bulk(repo):
    """停用/改密要立刻踢掉该用户的全部登录会话。"""
    await repo.create_user(_user())
    for h in ("h1", "h2", "h3"):
        await repo.create_auth_session(
            AuthSessionRow(token_hash=h, user_id="u1", expires=9_999_999_999.0))
    assert await repo.delete_user_auth_sessions("u1") == 3
    assert await repo.get_auth_session("h2") is None


async def test_prune_expired_auth_sessions(repo):
    await repo.create_user(_user())
    await repo.create_auth_session(
        AuthSessionRow(token_hash="live", user_id="u1", expires=2_000_000_000.0))
    await repo.create_auth_session(
        AuthSessionRow(token_hash="dead", user_id="u1", expires=1_000.0))
    assert await repo.prune_auth_sessions(now=1_700_000_000.0) == 1
    assert await repo.get_auth_session("live") is not None
    assert await repo.get_auth_session("dead") is None


async def test_delete_session_leaves_accounts_untouched(repo):
    """删建模会话**绝不能**误伤账号/登录会话 —— 它们是顶层数据，不随会话级联。"""
    await repo.create_session(_sess())
    await repo.create_user(_user())
    await repo.create_auth_session(
        AuthSessionRow(token_hash="h1", user_id="u1", expires=9_999_999_999.0))
    await repo.delete_session("s1")
    assert await repo.get_user("u1") is not None
    assert await repo.get_auth_session("h1") is not None


# ══════════════════════════════════════════════════════════════════
#  全局设置
# ══════════════════════════════════════════════════════════════════
async def test_setting_round_trip_and_upsert(repo):
    await repo.set_setting("gateway.base_url", "http://gw:3010/v1")
    assert await repo.get_setting("gateway.base_url") == "http://gw:3010/v1"
    await repo.set_setting("gateway.base_url", "http://gw2:3010/v1")   # 覆盖
    assert await repo.get_setting("gateway.base_url") == "http://gw2:3010/v1"
    assert await repo.get_setting("不存在") is None


async def test_setting_values_keep_json_shape(repo):
    await repo.set_setting("budget.usd_cap", 12.5)
    await repo.set_setting("gateway.model.high", "anthropic/claude-sonnet-5")
    assert await repo.get_setting("budget.usd_cap") == 12.5
    keys = {s.key for s in await repo.list_settings()}
    assert keys == {"budget.usd_cap", "gateway.model.high"}


async def test_setting_delete(repo):
    await repo.set_setting("k", "v")
    assert await repo.delete_setting("k") is True
    assert await repo.delete_setting("k") is False
    assert await repo.get_setting("k") is None


async def test_delete_session_leaves_settings_untouched(repo):
    await repo.create_session(_sess())
    await repo.set_setting("gateway.base_url", "http://gw:3010/v1")
    await repo.delete_session("s1")
    assert await repo.get_setting("gateway.base_url") == "http://gw:3010/v1"


# ══════════════════════════════════════════════════════════════════
#  会话按账号隔离
# ══════════════════════════════════════════════════════════════════
async def test_session_owner_isolation(repo):
    await repo.create_session(_sess("a", owner="u1"))
    await repo.create_session(_sess("b", owner="u2"))
    await repo.create_session(_sess("c"))          # 无归属（owner=""）
    assert [s.id for s in await repo.list_sessions(owner="u1")] == ["a"]   # 只看到自己的
    assert [s.id for s in await repo.list_sessions(owner="u2")] == ["b"]
    # 无归属对任何具体用户都不可见；不带 owner 过滤时仍全列（内部/开放模式）
    assert {s.id for s in await repo.list_sessions()} == {"a", "b", "c"}
    assert (await repo.get_session("a")).owner == "u1"
    assert (await repo.get_session("c")).owner == ""        # NULL ↔ ""


async def test_ocr_chunks_survive_restart(repo):
    """扫描件切片是**花钱买来的**：重建要再调一次视觉模型，而且 OCR 结果可能和
    当初抽取时不一样 —— 那样"点回原文"看到的就不是系统真正读过的东西。
    const.py 把 _chunks 排除在 DERIVED_KEYS 之外正是这个理由，但它一度根本没进
    任何持久化白名单，于是每次重启付费识别的内容全丢。
    """
    await repo.create_session(_sess())
    chunks = {"扫描件.png": [{"cite": "扫描件.png#p1", "text": "采购包 状态 已发布",
                             "locator": {"kind": "page", "page": 1}}]}
    await repo.save_state("s1", {"_chunks": chunks})
    got = await repo.load_state("s1")
    assert got["_chunks"] == chunks
    # 不是 derived —— 按需加载也要留着
    assert "_chunks" in await repo.load_state("s1", include_derived=False)


async def test_user_display_name_round_trips(repo):
    """一列要在四处加：迁移、schema.py、SQLite 升级器、以及这里的读写映射。

    漏了 `_user_row()` 或 PgRepo.create_user 的显式列清单，症状是"写得进去、
    永远读回空" —— 最难查的那一种。两个实现同一份断言。
    """
    await repo.create_user(_user(display_name="程 宇涵"))
    got = await repo.get_user("u1")
    assert got is not None and got.display_name == "程 宇涵"
    assert (await repo.get_user_by_username("alice")).display_name == "程 宇涵"
    assert (await repo.list_users())[0].display_name == "程 宇涵"
    assert got.public()["display_name"] == "程 宇涵"


async def test_user_without_a_display_name_reads_back_as_empty(repo):
    """管理员/CLI 建的号和迁移前的老账号都没有名字。空串，不是 None ——
    前端只判一种空值。"""
    await repo.create_user(_user())
    got = await repo.get_user("u1")
    assert got is not None and got.display_name == ""


async def test_update_user_can_change_only_the_display_name(repo):
    """三处实现（Protocol / Memory / Pg）同一次改完，否则同一份输入两种结果。"""
    await repo.create_user(_user(display_name="旧名字"))
    got = await repo.update_user("u1", display_name="新名字")
    assert got is not None and got.display_name == "新名字"
    # 只传 display_name 时，其余字段一个都不能被顺手改掉
    assert (got.username, got.role, got.active) == ("alice", "user", True)
    assert got.password_hash == "scrypt$x"
    assert (await repo.get_user("u1")).display_name == "新名字"


# ══════════════════════════════════════════════════════════════════
#  migrations 与 schema.py 的对齐
# ══════════════════════════════════════════════════════════════════
def _columns_declared_by_migrations() -> dict[str, list[str]]:
    """从 migrations/*.sql 的文本里读出每张表的列名。

    只认 CREATE TABLE 的列定义与 ALTER TABLE ... ADD COLUMN；索引、CHECK、触发器、
    plpgsql 函数一概不管 —— 那些确实已经漂移（schema.py 里一个 sa.Index 都没给
    session 建过），把它们一起管起来会让这个测试从第一天就是红的，于是被 skip 掉。
    列是**运行时会崩**的那一类漂移（"no such column"），先把这一类钉死。
    """
    import re
    from pathlib import Path

    from ontocopilot.store.migrate import MIGRATIONS

    create = re.compile(r"CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\((.*?)\n\);", re.DOTALL)
    alter = re.compile(r"ALTER TABLE (\w+)\s+ADD COLUMN (\w+)", re.IGNORECASE)
    # \b 是必须的：没有它，"checksum text NOT NULL" 会被 CHECK 前缀吃掉。
    not_a_column = re.compile(r"^(PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK)\b",
                              re.IGNORECASE)
    out: dict[str, list[str]] = {}
    for path in sorted(Path(MIGRATIONS).glob("*.sql")):
        sql = path.read_text(encoding="utf-8")
        for table, body in create.findall(sql):
            cols = []
            for raw in body.splitlines():
                line = raw.strip()
                if not line or line.startswith("--") or not_a_column.match(line):
                    continue
                m = re.match(r"^(\w+)\s+\w", line)
                if m:
                    cols.append(m.group(1))
            out[table] = cols
        for table, col in alter.findall(sql):
            out.setdefault(table, []).append(col)
    return out


def test_migrations_and_metadata_declare_the_same_columns():
    """两份真相必须逐列对齐 —— 而**没有任何机制强制**，只能靠这个测试。

    SQLite 只吃 schema.py 的 create_all，Postgres 只吃 migrations/。少写一份的症状
    是"本地一切正常、线上第一次读就 relation does not exist / no such column"，
    而且要等到那条路径真被走到才暴露。
    """
    from ontocopilot.store.schema import metadata

    declared = _columns_declared_by_migrations()
    # 每张 metadata 里的表都得有迁移，否则 Postgres 上它根本不存在
    assert set(metadata.tables) == set(declared)
    for name, table in sorted(metadata.tables.items()):
        assert set(declared[name]) == set(table.c.keys()), f"{name} 的列对不上"
        assert len(declared[name]) == len(set(declared[name])), f"{name} 有重复列"


# ══════════════════════════════════════════════════════════════════
#  项目文件夹
# ══════════════════════════════════════════════════════════════════
def _proj(pid: str = "p1", **kw) -> ProjectRow:
    return ProjectRow(**{"id": pid, "name": "采购域", **kw})


def _mem(key: str = "term:采购包", **kw) -> ProjectMemoryRow:
    base = {"project_id": "p1", "key": key, "tier": "authoritative",
            "kind": "decision", "content": "采购包 = 一次招标里打包的若干标的"}
    return ProjectMemoryRow(**{**base, **kw})


async def test_project_round_trips_and_lists_in_sort_order(repo):
    await repo.create_project(_proj("p1", name="采购域", sort_order=1))
    await repo.create_project(_proj("p2", name="财务域", sort_order=0))
    got = await repo.get_project("p1")
    assert got is not None and (got.name, got.prefs, got.sort_order) == ("采购域", {}, 1)
    assert [p.id for p in await repo.list_projects()] == ["p2", "p1"]
    assert await repo.get_project("没有这个") is None


async def test_rename_project_reports_whether_it_hit_anything(repo):
    await repo.create_project(_proj())
    assert await repo.rename_project("p1", "采购与招标") is True
    assert (await repo.get_project("p1")).name == "采购与招标"
    assert await repo.rename_project("不存在", "x") is False


async def test_project_listing_is_isolated_by_owner(repo):
    """和会话一样：无归属的项目对任何具体用户都不可见（NULL ↔ ""）。"""
    await repo.create_project(_proj("a", owner="u1"))
    await repo.create_project(_proj("b", owner="u2"))
    await repo.create_project(_proj("c"))                  # 无归属（owner=""）
    assert [p.id for p in await repo.list_projects(owner="u1")] == ["a"]
    assert {p.id for p in await repo.list_projects()} == {"a", "b", "c"}
    assert (await repo.get_project("c")).owner == ""


async def test_session_project_id_round_trips_as_empty_when_unfiled(repo):
    """库里是 NULL、内存里是 ""，两个实现必须给出同一种空值 —— 前端只判一种。"""
    await repo.create_session(_sess("s1", project_id="p1"))
    await repo.create_session(_sess("s2"))                  # 未归类
    assert (await repo.get_session("s1")).project_id == "p1"
    assert (await repo.get_session("s2")).project_id == ""
    assert (await repo.get_session("s2")).brief()["project_id"] == ""
    by_id = {s.id: s.project_id for s in await repo.list_sessions()}
    assert by_id == {"s1": "p1", "s2": ""}


async def test_assign_session_moves_it_in_and_back_out(repo):
    await repo.create_session(_sess("s1"))
    assert await repo.assign_session("s1", "p1") is True
    assert (await repo.get_session("s1")).project_id == "p1"
    # None 与 "" 都是「移出项目」，不能一个生效一个静默无视
    assert await repo.assign_session("s1", None) is True
    assert (await repo.get_session("s1")).project_id == ""
    await repo.assign_session("s1", "p1")
    await repo.assign_session("s1", "")
    assert (await repo.get_session("s1")).project_id == ""
    assert await repo.assign_session("没有这个会话", "p1") is False


async def test_deleting_a_project_releases_sessions_and_drops_its_memory(repo):
    """删项目**不删会话** —— 会话掉回未归类，项目记忆一起没。

    这正是确认框里向用户承诺的那两件事；只做一半（比如把会话也删了）是数据丢失。
    """
    await repo.create_project(_proj("p1"))
    await repo.create_project(_proj("p2"))
    await repo.create_session(_sess("s1", project_id="p1"))
    await repo.create_session(_sess("s2", project_id="p1"))
    await repo.create_session(_sess("s3", project_id="p2"))
    await repo.upsert_project_memory([_mem(), _mem(project_id="p2")])

    assert await repo.delete_project("p1") == 2            # 释放了两个会话
    assert await repo.get_project("p1") is None
    assert (await repo.get_session("s1")).project_id == ""
    assert (await repo.get_session("s2")) is not None      # 会话还在
    assert await repo.list_project_memory("p1") == []
    # 别的项目一根汗毛都不能动
    assert (await repo.get_session("s3")).project_id == "p2"
    assert len(await repo.list_project_memory("p2")) == 1


async def test_project_memory_keeps_both_tiers_exactly_as_written(repo):
    """tier 是整个功能的地基：人拍板的和模型猜的必须能分开查。

    仓储不判断谁能晋升（那是记忆内核的事），但绝不能把这个标记弄丢或改写。
    """
    await repo.upsert_project_memory([
        _mem("term:采购包", tier="authoritative", confidence=0.95,
             support=["招标文件.pdf#p3"], tags=["术语"], created_run="r1"),
        _mem("lesson:字段口径", tier="reference", kind="fact", confidence=0.4,
             origin_session="s9", origin_files=["旧清单.xlsx"], hit_runs=["r1"],
             use_count=2, last_used_run="r2"),
    ])
    rows = {m.key: m for m in await repo.list_project_memory("p1")}
    assert rows["term:采购包"].tier == "authoritative"
    assert rows["term:采购包"].support == ["招标文件.pdf#p3"]
    assert rows["term:采购包"].confidence == 0.95
    ref = rows["lesson:字段口径"]
    assert (ref.tier, ref.kind) == ("reference", "fact")
    # 来源标注是 reference 档进 prompt 时逐行要打的前缀，落库丢了就补不回来
    assert (ref.origin_session, ref.origin_files) == ("s9", ["旧清单.xlsx"])
    assert (ref.hit_runs, ref.use_count, ref.last_used_run) == (["r1"], 2, "r2")


async def test_upsert_project_memory_overwrites_by_key(repo):
    await repo.upsert_project_memory([_mem(content="旧口径", confidence=0.6)])
    assert await repo.upsert_project_memory([_mem(content="新口径", confidence=0.9)]) == 1
    rows = await repo.list_project_memory("p1")
    assert len(rows) == 1
    assert (rows[0].content, rows[0].confidence) == ("新口径", 0.9)


async def test_the_same_memory_key_in_two_projects_stays_separate(repo):
    """mem_key 是 "{kind}:{slug}"，**不含 project** —— 隔离全靠复合主键。

    少了 project_id 这半个主键，两个项目里同名的术语会互相覆盖。
    """
    await repo.upsert_project_memory([
        _mem(content="采购域的口径"),
        _mem(project_id="p2", content="财务域的口径"),
    ])
    assert (await repo.list_project_memory("p1"))[0].content == "采购域的口径"
    assert (await repo.list_project_memory("p2"))[0].content == "财务域的口径"


async def test_delete_project_memory_by_keys_or_wholesale(repo):
    await repo.upsert_project_memory([_mem("a"), _mem("b"), _mem("c")])
    assert await repo.delete_project_memory("p1", ["a", "没有这条"]) == 1
    assert [m.key for m in await repo.list_project_memory("p1")] == ["b", "c"]
    assert await repo.delete_project_memory("p1", []) == 0      # 空列表 = 什么都不删
    assert await repo.delete_project_memory("p1") == 2          # None = 整个项目清空
    assert await repo.list_project_memory("p1") == []


async def test_delete_session_leaves_projects_and_their_memory_untouched(repo):
    """项目记忆的全部意义就是比单个会话活得久。

    内存实现的 delete_session 是白名单式 pop，把按 project 存的容器扫进去就等于
    「删了一个会话，同名项目跟着没了」；Pg 侧同理不能靠任何级联。
    """
    await repo.create_project(_proj("p1"))
    await repo.create_session(_sess("s1", project_id="p1"))
    await repo.upsert_project_memory([_mem(origin_session="s1")])
    await repo.delete_session("s1")
    assert await repo.get_project("p1") is not None
    assert len(await repo.list_project_memory("p1")) == 1


async def test_existing_sqlite_database_grows_the_project_id_column(tmp_path):
    """`create_all` 只建缺表、**从不加列**：老库不补 project_id，每次读会话都
    `no such column`。这条路径与重建分支那个 required 白名单是连着的 ——
    补了列却不更新白名单，老库升级会直接 RuntimeError。
    """
    import sqlite3

    path = tmp_path / "pre-0013.db"
    db = sqlite3.connect(path)
    try:
        db.executescript("""
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
            INSERT INTO session (id,title,project) VALUES ('old','历史会话','P-1');
        """)
        db.commit()
    finally:
        db.close()

    store = await Store.open(f"sqlite+aiosqlite:///{path}", create_all=True)
    repo = build_repo(store)
    try:
        old = await repo.get_session("old")
        assert old is not None and old.project_id == ""     # 老会话是未归类
        await repo.create_project(ProjectRow(id="p1", name="采购域"))
        assert await repo.assign_session("old", "p1") is True
        assert (await repo.get_session("old")).project_id == "p1"
    finally:
        await store.close()
