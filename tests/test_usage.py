"""模型用量账本 —— 一次调用一行，跨会话、跨重启。

在此之前，"这个月烧了多少 token""哪个模型最贵"没有任何地方能回答：Budget 是
**每轮新建**的、快照落在 run.budget；session_state["budget"] 只是最后一次梳理的
快照；聊天那份 _chat_usd 连持久化白名单都不在。三份都加不起来。

这个文件盯的是**记账本身会说谎的那几种方式**，因为它们都不报错、只是数字不对：
重放时重复记一笔、重试的那几次不算钱、失败的调用当作没发生过。
"""

from __future__ import annotations

import time

import pytest

from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.dag import Difficulty
from ontocopilot.kernel.journal import FileBlobStore, FileJournal
from ontocopilot.kernel.llm import (
    LLMBackend,
    ModelError,
    ModelGateway,
    ModelSpec,
    RoutingTable,
    Usage,
)
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.store.repo import MemoryRepo, UsageRow

SPEC = ModelSpec("test-model", "mid", 3.0, 15.0, effort="medium")


def _routing() -> RoutingTable:
    return RoutingTable(models=dict.fromkeys(Difficulty, SPEC), judges=[SPEC])


class _Backend(LLMBackend):
    """按脚本产出，并逐次记录被调用了几回 —— 重试的那几次也是真花钱。"""

    def __init__(self, script: list[tuple[str, Usage]]) -> None:
        self.script = list(script)
        self.calls = 0

    async def generate(self, *, model, prompt, system="", schema=None,
                       max_tokens=16_000, cache_system=True, images=None):
        self.calls += 1
        text, usage = self.script[min(self.calls - 1, len(self.script) - 1)]
        return text, usage


def _gw(tmp_path, backend, sink, *, resume=False, run_id="r1") -> ModelGateway:
    rec = Recorder(run_id, FileJournal(tmp_path / "j"), FileBlobStore(tmp_path / "b"),
                   resume=resume)
    return ModelGateway(backend, rec, routing=_routing(), budget=Budget(),
                        usage_sink=sink, max_schema_retries=2)


# ══════════════════════════════════════════════════════════════════
#  收口点：全部调用都要落账
# ══════════════════════════════════════════════════════════════════
async def test_one_call_one_row_with_the_real_numbers(tmp_path):
    got: list[dict] = []
    be = _Backend([("ok", Usage(tok_in=120, tok_out=30, cache_read=10))])
    gw = _gw(tmp_path, be, got.append)

    await gw.call("n1", "问点什么")
    assert len(got) == 1
    r = got[0]
    assert r["model"] == "test-model" and r["node_id"] == "n1"
    assert (r["tok_in"], r["tok_out"], r["cache_read"]) == (120, 30, 10)
    assert r["status"] == "ok" and r["attempts"] == 1
    assert r["run_id"] == "r1"


async def test_judge_goes_through_the_same_chokepoint(tmp_path):
    """评委、SmartGateway、对话、OCR 最终都走 call —— 钩在那里才是 100% 覆盖。"""
    got: list[dict] = []
    be = _Backend([("ok", Usage(tok_in=5, tok_out=5))])
    gw = _gw(tmp_path, be, got.append)
    gw.routing.judges = [ModelSpec("judge-model", "mid", 1.0, 2.0, effort=None)]

    await gw.judge("n1", "评一下", generator=SPEC)
    assert [r["model"] for r in got] == ["judge-model"]


# ══════════════════════════════════════════════════════════════════
#  三种"账做错了但不报错"
# ══════════════════════════════════════════════════════════════════
async def test_every_retry_is_billed_and_counted(tmp_path):
    """一次调用重试三回就是三份 token 的钱。只记最后一次等于把账做小 ——
    而 schema 不合、输出被截断都会走重试，密集材料上并不罕见。"""
    got: list[dict] = []
    be = _Backend([
        ("不是 JSON", Usage(tok_in=100, tok_out=50)),      # schema 不合 → 重试
        ("还是不是", Usage(tok_in=110, tok_out=60)),       # 再不合 → 再重试
        ('{"a": 1}', Usage(tok_in=120, tok_out=20)),       # 终于对了
    ])
    gw = _gw(tmp_path, be, got.append)

    await gw.call("n1", "给我 JSON", schema={"type": "object"})
    assert be.calls == 3
    assert len(got) == 1                                    # 一次逻辑调用一行
    r = got[0]
    assert r["attempts"] == 3
    assert r["tok_in"] == 330 and r["tok_out"] == 130       # 三次的总和，不是最后一次


async def test_a_call_that_ultimately_fails_still_costs_money(tmp_path):
    """连撞三回 schema 然后放弃 —— 那三次都打出去了、都计费了。
    以前这里什么都不记，账上等于这次调用从没发生过。"""
    got: list[dict] = []
    be = _Backend([("坏的", Usage(tok_in=200, tok_out=10))])
    gw = _gw(tmp_path, be, got.append)

    with pytest.raises(ModelError):
        await gw.call("n1", "给我 JSON", schema={"type": "object"})

    assert len(got) == 1
    assert got[0]["status"] == "failed"
    assert got[0]["tok_in"] == 600                          # 三次 × 200
    assert got[0]["attempts"] == 3


async def test_replaying_a_recorded_run_does_not_bill_twice(tmp_path):
    """**最要命的一种。** Recorder 重放时直接返回历史结果、根本不调模型，
    但记账如果照记不误，resume 一次账单就翻一倍 —— 而 resume 恰恰是常态
    （跑到一半中断、改配置重跑都会）。"""
    got: list[dict] = []
    be = _Backend([("ok", Usage(tok_in=100, tok_out=20))])
    gw = _gw(tmp_path, be, got.append)
    await gw.call("n1", "同一个问题")
    assert len(got) == 1 and be.calls == 1

    # 同一个 run_id + resume：日志还在，这次不该真的打模型
    got2: list[dict] = []
    be2 = _Backend([("ok", Usage(tok_in=100, tok_out=20))])
    gw2 = _gw(tmp_path, be2, got2.append, resume=True)
    await gw2.call("n1", "同一个问题")

    assert be2.calls == 0, "重放不该真的调模型"
    assert got2 == [], "重放不该再记一笔账"


async def test_gateway_billed_cost_is_marked_apart_from_local_estimates(tmp_path):
    """网关回了真实账单就用它并标 gateway；没回才用本地价目表估、标 estimated。

    这个区分是**界面敢不敢显示金额**的依据：经网关发现的模型在本地价目表里是
    统一编的（catalog 给 2.0/8.0），估出来的钱看着精确其实是错的。
    """
    got: list[dict] = []
    be = _Backend([("ok", Usage(tok_in=1000, tok_out=1000, usd=0.42))])
    gw = _gw(tmp_path, be, got.append)
    await gw.call("n1", "x")
    assert got[0]["usd_source"] == "gateway" and got[0]["usd"] == pytest.approx(0.42)

    got2: list[dict] = []
    be2 = _Backend([("ok", Usage(tok_in=1_000_000, tok_out=0))])
    gw2 = _gw(tmp_path, be2, got2.append, run_id="r2")
    await gw2.call("n1", "x")
    assert got2[0]["usd_source"] == "estimated"
    assert got2[0]["usd"] == pytest.approx(3.0)             # 1M × $3/Mtok


async def test_a_broken_sink_never_breaks_a_model_call(tmp_path):
    """记账失败是记账的事，不该把一次梳理带下去。"""
    def boom(_rec):
        raise RuntimeError("库挂了")

    be = _Backend([("ok", Usage(tok_in=1, tok_out=1))])
    gw = _gw(tmp_path, be, boom)
    comp = await gw.call("n1", "x")
    assert comp.text == "ok"


# ══════════════════════════════════════════════════════════════════
#  仓储：账要跨会话、跨会话删除活下来
# ══════════════════════════════════════════════════════════════════
def _row(**kw) -> UsageRow:
    base = {"id": kw.pop("id", "u1"), "ts": kw.pop("ts", time.time()),
            "day": kw.pop("day", "2026-08-12"), "model": kw.pop("model", "m")}
    return UsageRow(**base, **kw)


async def test_usage_outlives_the_session_it_came_from():
    """会话删了账还得在 —— 所以 session_id 不设外键、不跟着 CASCADE。"""
    repo = MemoryRepo()
    from ontocopilot.store.repo import SessionRow

    await repo.create_session(SessionRow(id="s1", title="t", created=time.time()))
    await repo.add_usage(_row(id="u1", session_id="s1", tok_in=10, tok_out=5))
    assert await repo.delete_session("s1")

    rows = await repo.usage_since(0)
    assert len(rows) == 1 and rows[0].session_id == "s1"


async def test_usage_is_filtered_by_account_and_by_time():
    repo = MemoryRepo()
    now = time.time()
    await repo.add_usage(_row(id="a", ts=now, owner="alice", tok_in=10))
    await repo.add_usage(_row(id="b", ts=now, owner="bob", tok_in=20))
    await repo.add_usage(_row(id="old", ts=now - 90 * 86400, owner="alice", tok_in=1))

    assert {r.id for r in await repo.usage_since(0)} == {"a", "b", "old"}
    assert {r.id for r in await repo.usage_since(0, owner="alice")} == {"a", "old"}
    assert {r.id for r in await repo.usage_since(now - 86400)} == {"a", "b"}


async def test_truncation_keeps_the_newest_not_the_oldest():
    """封顶时先丢最老的 —— 丢掉刚刚发生的事情，账本就没用了。"""
    repo = MemoryRepo()
    now = time.time()
    for i in range(10):
        await repo.add_usage(_row(id=f"u{i}", ts=now - i * 60))
    rows = await repo.usage_since(0, limit=3)
    assert [r.id for r in rows] == ["u0", "u1", "u2"]


# ══════════════════════════════════════════════════════════════════
#  聚合接口
# ══════════════════════════════════════════════════════════════════
async def test_usage_endpoint_buckets_by_time_and_splits_by_model(tmp_path, monkeypatch):
    import httpx

    from ontocopilot import server
    from ontocopilot.server import app
    from ontocopilot.store.deps import set_repo_for_tests

    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    set_repo_for_tests(repo)

    now = time.time()
    from datetime import UTC, datetime
    for i, (model, tin) in enumerate([("opus", 1000), ("opus", 500), ("flash", 200)]):
        ts = now - i * 86400
        await repo.add_usage(_row(
            id=f"u{i}", ts=ts,
            day=datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d"),
            model=model, kind="build" if i < 2 else "chat",
            tok_in=tin, tok_out=100))

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://t") as c:
        out = (await c.get("/api/usage", params={"days": 7})).json()

    assert out["total"]["calls"] == 3
    assert out["total"]["tokens"] == 1000 + 500 + 200 + 300
    assert [m["name"] for m in out["by_model"]] == ["opus", "flash"]
    assert out["by_model"][0]["tokens"] == 1700   # (1000+100) + (500+100)
    assert {k["name"] for k in out["by_kind"]} == {"build", "chat"}
    # 空桶要补出来，否则"哪天没跑"在曲线上看不出来
    assert len(out["series"]) >= 7
    assert sum(b["tokens"] for b in out["series"]) == out["total"]["tokens"]
    # 一条网关账单都没有 → 界面不该拿估算的钱当钱显示
    assert out["cost_note"] == "none"


async def test_usage_endpoint_is_honest_about_estimated_money(tmp_path, monkeypatch):
    import httpx

    from ontocopilot import server
    from ontocopilot.server import app
    from ontocopilot.store.deps import set_repo_for_tests

    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = MemoryRepo()
    set_repo_for_tests(repo)
    now = time.time()
    from datetime import UTC, datetime
    day = datetime.fromtimestamp(now, tz=UTC).strftime("%Y-%m-%d")
    await repo.add_usage(_row(id="g", ts=now, day=day, usd=0.5, usd_source="gateway"))
    await repo.add_usage(_row(id="e", ts=now, day=day, usd=99.0, usd_source="estimated"))

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://t") as c:
        out = (await c.get("/api/usage")).json()

    # 估出来的 99 块**不进**金额合计，只有网关真实账单进
    assert out["total"]["usd_billed"] == pytest.approx(0.5)
    assert out["total"]["billed_calls"] == 1
    assert out["cost_note"] == "partial"


async def test_usage_endpoint_clamps_detail_limit(tmp_path, monkeypatch):
    """查询上限在服务端钳制，不能靠仓储恰好安全来抵御超大请求。"""
    import httpx

    from ontocopilot import server
    from ontocopilot.server import app
    from ontocopilot.store.deps import set_repo_for_tests

    class CapturingRepo(MemoryRepo):
        seen_limits: list[int]

        def __init__(self) -> None:
            super().__init__()
            self.seen_limits = []

        async def usage_since(self, since, *, owner=None, limit=5000):
            self.seen_limits.append(limit)
            return []

    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "SESSIONS", {})
    repo = CapturingRepo()
    set_repo_for_tests(repo)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://t") as c:
        assert (await c.get("/api/usage", params={"limit": -9})).status_code == 200
        assert (await c.get("/api/usage", params={"limit": 999_999_999})).status_code == 200

    assert repo.seen_limits == [1, 50_000]


async def test_usage_flush_retries_the_uncommitted_head():
    """DB 瞬断后，队首仍在；下一轮 drain 能原样重试且只提交一次。"""
    from ontocopilot import server

    class FlakyRepo:
        def __init__(self) -> None:
            self.calls = 0
            self.rows = []

        async def add_usage(self, row):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("temporary database outage")
            self.rows.append(row)

    repo = FlakyRepo()
    row = _row(id="retry-me", ts=time.time())
    server._USAGE_BUF.clear()
    server._USAGE_BUF.append(row)
    try:
        with pytest.raises(RuntimeError, match="temporary"):
            await server._flush_usage(repo)
        assert list(server._USAGE_BUF) == [row]

        assert await server._flush_usage(repo) == 1
        assert repo.rows == [row]
        assert not server._USAGE_BUF
    finally:
        server._USAGE_BUF.clear()
