"""Agent 间通信：黑板冲突语义、定向请求的可重放性、广播。"""

from __future__ import annotations

import pytest

from ontocopilot.kernel.bus.blackboard import Blackboard
from ontocopilot.kernel.bus.bus import AgentBus, BusError
from ontocopilot.kernel.events import EventKind
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.recorder import Recorder


@pytest.fixture
def bus():
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    return AgentBus(Recorder("r1", journal, blobs)), journal, blobs


# ══════════════════════════════════════════════════════════════════
#  黑板
# ══════════════════════════════════════════════════════════════════
def test_same_value_from_two_agents_is_not_a_conflict():
    bb = Blackboard()
    bb.write("glossary/采购包", "purchasePackage", by="EXTRACT.object", confidence=0.6)
    _, newly = bb.write("glossary/采购包", "purchasePackage", by="EXTRACT.property",
                        confidence=0.7)
    assert not newly
    assert not bb.entry("glossary/采购包").contested
    assert bb.read("glossary/采购包") == "purchasePackage"


def test_disagreement_is_signal_and_both_versions_survive():
    """两个 agent 对同一 key 写不同值 —— 这就是「计划金额」双口径的机器形态。
    绝不能 last-write-wins 把矛盾抹掉。"""
    bb = Blackboard()
    bb.write("oir/pt_plan_amount/definition", "含税·年度累计",
             by="EXTRACT.xlsx", support=("实体梳理.xlsx!R44C6",), confidence=0.8)
    _, newly = bb.write("oir/pt_plan_amount/definition", "不含税·单次",
                        by="EXTRACT.ddl", support=("schema.ddl#clm_contract",), confidence=0.75)

    assert newly, "新分歧必须被报出来"
    e = bb.entry("oir/pt_plan_amount/definition")
    assert e.contested
    assert {v.value for v in e.variants} == {"含税·年度累计", "不含税·单次"}
    assert e.current.value == "含税·年度累计", "当前采信可信度最高的那个"
    assert set(e.writers()) == {"EXTRACT.xlsx", "EXTRACT.ddl"}


def test_contested_render_shows_all_variants_with_provenance():
    """模型要能看见分歧和各自出处，才可能正确处理它。"""
    bb = Blackboard()
    bb.write("oir/x/def", "含税", by="A", support=("实体梳理.xlsx!R44C6",), confidence=0.8)
    bb.write("oir/x/def", "不含税", by="B", support=("schema.ddl#clm",), confidence=0.7)
    out = bb.render()
    assert "⚠ 存在 2 种说法" in out
    assert "实体梳理.xlsx!R44C6" in out and "schema.ddl#clm" in out


def test_watchers_fire_on_new_conflict_only():
    """Critic 应该在分歧一出现就介入，而不是等阶段末尾。"""
    bb = Blackboard()
    fired: list[tuple[str, bool]] = []
    bb.watch("oir/*", lambda k, rev, newly: fired.append((k, newly)))

    bb.write("oir/a", 1, by="X")
    bb.write("oir/a", 2, by="Y")  # 新分歧
    bb.write("oir/a", 2, by="Z")  # 已经有分歧了，不是"新"分歧
    bb.write("glossary/b", 1, by="X")  # 不匹配 pattern

    assert fired == [("oir/a", False), ("oir/a", True), ("oir/a", False)]


def test_board_rebuilds_from_event_log(bus):
    """黑板必须能从事件日志重建，否则恢复 Run 会丢掉共享状态。"""
    b, journal, blobs = bus
    b.post("glossary/采购包", "purchasePackage", by="N1", confidence=0.6)
    b.post("oir/x/def", "含税", by="N1", confidence=0.8)
    b.post("oir/x/def", "不含税", by="N2", confidence=0.7)

    b2 = AgentBus(Recorder("r1", journal, blobs, resume=True))
    assert b2.restore_board() == 3
    assert b2.read("glossary/采购包") == "purchasePackage"
    assert len(b2.contested()) == 1


def test_conflict_flag_lands_in_event_log(bus):
    b, journal, _ = bus
    b.post("oir/x/def", "含税", by="N1")
    b.post("oir/x/def", "不含税", by="N2")
    writes = [e for e in journal.read("r1") if e.kind is EventKind.BLACKBOARD_WRITE]
    assert [w.payload["contested"] for w in writes] == [False, True]


# ══════════════════════════════════════════════════════════════════
#  定向请求
# ══════════════════════════════════════════════════════════════════
async def test_request_response_between_agents(bus):
    """Critic 请 Actor 为可疑断言举证。"""
    b, _, _ = bus
    calls = []

    async def actor(msg):
        calls.append(msg.kind)
        return {"evidence": ["实体梳理.xlsx!R44C6"], "claim": msg.payload["claim"]}

    b.register("EXTRACT.property", actor)
    out = await b.request(
        frm="CRITIC.provenance", to="EXTRACT.property",
        kind="justify", payload={"claim": "planAmount 是 DECIMAL(18,2)"},
    )
    assert out["evidence"] == ["实体梳理.xlsx!R44C6"]
    assert calls == ["justify"]


async def test_request_is_replayed_not_re_executed(bus):
    """对方内部可能是昂贵的 LLM 调用，重放绝不能二次触发。"""
    b, journal, blobs = bus
    calls = []
    handler = lambda msg: calls.append(1) or {"ok": True}
    b.register("ACTOR", handler)

    await b.request(frm="CRITIC", to="ACTOR", kind="justify", payload={"c": 1})
    assert len(calls) == 1

    b2 = AgentBus(Recorder("r1", journal, blobs, resume=True))
    b2.register("ACTOR", handler)
    out = await b2.request(frm="CRITIC", to="ACTOR", kind="justify", payload={"c": 1})
    assert out == {"ok": True}
    assert len(calls) == 1, "重放时不应再次调用对方"


async def test_unregistered_recipient_fails_loudly(bus):
    b, _, _ = bus
    with pytest.raises(BusError, match="未注册"):
        await b.request(frm="A", to="不存在", kind="x")


async def test_concurrent_requests_need_explicit_keys(bus):
    import asyncio

    b, journal, blobs = bus
    b.register("ACTOR", lambda m: f"ans:{m.payload['i']}")
    out = await asyncio.gather(
        *(b.request(frm="C", to="ACTOR", kind="ask", payload={"i": i}, key=f"q{i}")
          for i in range(4))
    )
    assert out == [f"ans:{i}" for i in range(4)]

    b2 = AgentBus(Recorder("r1", journal, blobs, resume=True))
    b2.register("ACTOR", lambda m: "WRONG")
    again = await asyncio.gather(
        *(b2.request(frm="C", to="ACTOR", kind="ask", payload={"i": i}, key=f"q{i}")
          for i in reversed(range(4)))
    )
    assert again == [f"ans:{i}" for i in reversed(range(4))]


# ══════════════════════════════════════════════════════════════════
#  广播
# ══════════════════════════════════════════════════════════════════
def test_broadcast_reaches_glob_matched_subscribers(bus):
    b, _, _ = bus
    got: list[str] = []
    b.subscribe("budget/*", lambda m: got.append(f"budget:{m.payload.get('level')}"))
    b.subscribe("*", lambda m: got.append(f"all:{m.to}"))

    n = b.broadcast(frm="SCHED", topic="budget/degrade", payload={"level": "critic_rounds=1"})
    assert n == 2
    assert got == ["budget:critic_rounds=1", "all:budget/degrade"]

    got.clear()
    assert b.broadcast(frm="SCHED", topic="run/cancel") == 1
    assert got == ["all:run/cancel"]


def test_broadcast_is_logged(bus):
    b, journal, _ = bus
    b.broadcast(frm="SCHED", topic="budget/degrade", payload={"level": "x"})
    msgs = [e for e in journal.read("r1") if e.kind is EventKind.MESSAGE_SENT]
    assert msgs[0].payload["mode"] == "broadcast"
    assert msgs[0].payload["topic"] == "budget/degrade"
