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
    DecisionRow,
    EventRow,
    FileRow,
    MemoryRepo,
    SessionRow,
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
