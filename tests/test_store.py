"""持久化层。

这层最危险的失败不是"数据库连不上"，是**两个实现行为不一致** —— 开发机上
（内存）跑得好好的，上了生产（Postgres）行为变了，而且变的往往是边界情况：
空值、并发、顺序、软删除。所以下面每个用例都在**两个实现上各跑一遍**，
用同一份断言。

Postgres 侧用 SQLite 代跑：这里验的是仓储 SQL 的行为语义，不是 Postgres 的
方言特性。要一个容器才能跑测试，代价远大于收益。
"""

from __future__ import annotations

import pytest

from ontocopilot.store.engine import Store, database_url
from ontocopilot.store.repo import (
    AuthSessionRow,
    DecisionRow,
    DuplicateUsername,
    FileRow,
    MemoryRepo,
    SessionRow,
    SettingRow,
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


# ══════════════════════════════════════════════════════════════════
#  状态
# ══════════════════════════════════════════════════════════════════
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
