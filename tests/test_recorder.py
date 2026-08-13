"""Recorder 的重放语义 —— 内核最容易写错的地方，先钉死。"""

from __future__ import annotations

import pytest

from ontocopilot.kernel.errors import DeterminismViolation, HumanInputRequired
from ontocopilot.kernel.events import EventKind
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.recorder import Recorder


@pytest.fixture
def store():
    return InMemoryJournal(), InMemoryBlobStore()


async def test_effect_executes_once_and_replays_without_calling(store):
    journal, blobs = store
    calls = []

    async def run(resume: bool):
        rec = Recorder("r1", journal, blobs, resume=resume)
        return await rec.effect(
            "N", "llm.call", {"prompt": "抽取对象"}, lambda: calls.append(1) or "23 个对象"
        )

    assert await run(False) == "23 个对象"
    assert len(calls) == 1

    # 重放：结果一致，但 fn 没有被再次调用（不重新付费）
    assert await run(True) == "23 个对象"
    assert len(calls) == 1


async def test_effect_keys_are_namespaced_per_node(store):
    """并行节点的全局顺序不稳定，所以 effect 必须按节点分命名空间。"""
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    await rec.effect("A", "t", {"i": 0}, lambda: "a0")
    await rec.effect("B", "t", {"i": 0}, lambda: "b0")

    # 换个顺序重放，各自仍拿回自己的结果
    rec2 = Recorder("r1", journal, blobs, resume=True)
    assert await rec2.effect("B", "t", {"i": 0}, lambda: "WRONG") == "b0"
    assert await rec2.effect("A", "t", {"i": 0}, lambda: "WRONG") == "a0"


async def test_changed_request_raises_determinism_violation(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    await rec.effect("N", "llm.call", {"prompt": "v1"}, lambda: "out")

    rec2 = Recorder("r1", journal, blobs, resume=True)
    with pytest.raises(DeterminismViolation) as ei:
        await rec2.effect("N", "llm.call", {"prompt": "v2"}, lambda: "out")
    assert "N#0" in str(ei.value)


async def test_explicit_key_survives_reordered_concurrency(store):
    """节点内并发的 effect（如四个 critic 视角）必须显式给 key。"""
    import asyncio

    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    lenses = ["schema", "provenance", "naming", "completeness"]
    await asyncio.gather(
        *(rec.effect("CRITIC", "llm.call", {"lens": ln}, lambda ln=ln: f"{ln}:ok", key=ln)
          for ln in lenses)
    )

    rec2 = Recorder("r1", journal, blobs, resume=True)
    out = await asyncio.gather(
        *(rec2.effect("CRITIC", "llm.call", {"lens": ln}, lambda: "WRONG", key=ln)
          for ln in reversed(lenses))
    )
    assert out == [f"{ln}:ok" for ln in reversed(lenses)]


async def test_same_explicit_key_is_single_flight_under_concurrency(store):
    """同一幂等键并发请求只能执行一次副作用。"""
    import asyncio

    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    calls = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def effect():
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return {"ok": True}

    first = asyncio.create_task(
        rec.effect("N", "tool.call", {"id": 1}, effect, key="same"))
    await entered.wait()
    second = asyncio.create_task(
        rec.effect("N", "tool.call", {"id": 1}, effect, key="same"))
    await asyncio.sleep(0)
    release.set()
    assert await asyncio.gather(first, second) == [{"ok": True}, {"ok": True}]
    assert calls == 1
    requested = [e for e in journal.read("r1") if e.kind is EventKind.EFFECT_REQUESTED]
    completed = [e for e in journal.read("r1") if e.kind is EventKind.EFFECT_COMPLETED]
    assert len(requested) == len(completed) == 1


async def test_same_inflight_key_with_different_request_fails_closed(store):
    import asyncio

    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    entered = asyncio.Event()
    release = asyncio.Event()

    async def effect():
        entered.set()
        await release.wait()
        return "ok"

    first = asyncio.create_task(rec.effect("N", "x", {"v": 1}, effect, key="k"))
    await entered.wait()
    with pytest.raises(DeterminismViolation):
        await rec.effect("N", "x", {"v": 2}, effect, key="k")
    release.set()
    assert await first == "ok"


async def test_large_result_goes_to_blob_store(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    big = {"chunks": ["x" * 100 for _ in range(100)]}
    await rec.effect("N", "tool.exec", {}, lambda: big)

    completed = [e for e in journal.read("r1") if e.kind is EventKind.EFFECT_COMPLETED]
    assert completed[0].ref is not None, "大结果应落 blob"
    assert "result" not in completed[0].payload
    assert len(blobs) >= 1

    rec2 = Recorder("r1", journal, blobs, resume=True)
    assert await rec2.effect("N", "tool.exec", {}, lambda: None) == big


async def test_completed_node_is_skipped_entirely(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    rec.complete_node("EXTRACT", {"objects": 23})

    rec2 = Recorder("r1", journal, blobs, resume=True)
    assert rec2.node_is_complete("EXTRACT")
    assert rec2.node_output("EXTRACT") == {"objects": 23}
    assert not rec2.node_is_complete("ALIGN")


async def test_crash_midway_resumes_from_last_effect(store):
    """核心承诺：第 47 步崩溃从第 47 步恢复，前 46 步不重跑。"""
    journal, blobs = store
    executed: list[int] = []

    async def attempt(resume: bool, crash_at: int | None):
        rec = Recorder("r1", journal, blobs, resume=resume)
        for i in range(5):
            if i == crash_at:
                raise RuntimeError("boom")
            await rec.effect("LOOP", "llm.call", {"i": i},
                             lambda i=i: executed.append(i) or f"step{i}")
        return rec

    with pytest.raises(RuntimeError):
        await attempt(False, crash_at=3)
    assert executed == [0, 1, 2]

    await attempt(True, crash_at=None)
    assert executed == [0, 1, 2, 3, 4], "前 3 步应从历史读回，只补跑 3、4"


async def test_time_and_randomness_are_recorded(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    t1, n1 = await rec.now("N"), await rec.rand("N", 10_000)

    rec2 = Recorder("r1", journal, blobs, resume=True)
    assert await rec2.now("N") == t1
    assert await rec2.rand("N", 10_000) == n1


async def test_human_gate_suspends_then_resumes(store):
    """HITL 是持久化的：挂起 → 人回答 → 重放到原地继续。"""
    journal, blobs = store
    reached_after_gate = False

    async def flow(resume: bool):
        nonlocal reached_after_gate
        rec = Recorder("r1", journal, blobs, resume=resume)
        await rec.effect("CLARIFY", "llm.call", {}, lambda: "3 个问题")
        answer = await rec.ask_human("CLARIFY", "q_plan_amount", {"options": ["A", "B"]})
        reached_after_gate = True
        return rec, answer

    with pytest.raises(HumanInputRequired) as ei:
        await flow(False)
    assert ei.value.request_id == "q_plan_amount"
    assert not reached_after_gate

    # API 层记录人的选择
    Recorder("r1", journal, blobs, resume=True).record_human_answer(
        "CLARIFY", "q_plan_amount", {"option_id": "split_two_properties"}
    )

    _, answer = await flow(True)
    assert reached_after_gate
    assert answer == {"option_id": "split_two_properties"}


async def test_effect_failure_is_logged_and_reraised(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)

    def boom():
        raise ValueError("沙箱超时")

    with pytest.raises(ValueError):
        await rec.effect("N", "tool.exec", {}, boom)

    failed = [e for e in journal.read("r1") if e.kind is EventKind.EFFECT_FAILED]
    assert len(failed) == 1
    assert "沙箱超时" in failed[0].payload["error"]

    # 失败的 effect 未记账，重试时会真正重跑
    rec2 = Recorder("r1", journal, blobs, resume=True)
    assert await rec2.effect("N", "tool.exec", {}, lambda: "ok") == "ok"


async def test_prompt_body_is_not_dumped_into_event_log(store):
    journal, blobs = store
    rec = Recorder("r1", journal, blobs)
    await rec.effect("N", "llm.call", {"prompt": "月" * 5000}, lambda: "ok")

    requested = [e for e in journal.read("r1") if e.kind is EventKind.EFFECT_REQUESTED]
    assert len(requested[0].payload["request"]["prompt"]) < 500
