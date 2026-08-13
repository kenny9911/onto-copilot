"""把 session_events.py 的**线上事件形态**导成 golden，给 TS 侧 session_events.ts 当安全网。

这一层没有算法，只有「前端到底收到哪些键、什么顺序、什么值」。事件名和字段名改一个字，
前端就静默瞎掉 —— 跨 HTTP 没有任何类型检查会拦住它。所以这份 golden 钉的全是**形态**：

  - `enqueue` 返回的 pending projection：`{seq, ts, **payload, kind}` 再补 `eventId`。
    键序不是装饰：payload 里带 `kind` / `seq` / `ts` / `eventId` 时，Python dict 更新
    **保留首次插入的位置、只换值**，所以同一份代码在不同 payload 下键序不同。JS 对象
    的自有属性顺序规则恰好一致，但这件事必须被钉住而不是"我记得一样"。
  - `emit_ephemeral` / `_finalise_ephemeral` 产出的事件**没有 eventId**
    —— 落地路径退化成 local-only 时，projection 被 clear+update，调用方手里那份
    projection 的 eventId 会**凭空消失**。这是真实可观测的形态差异。
  - `event.persist_failed` 的五个字段 + `error` 那个 `f"{type(e).__name__}: {e}"`。
  - `_publish_committed` 的排序键与去重：非负 seq 在前升序，负 seq 在后按 |seq| 升序。
  - `int(e.get("seq", -1))` 的强制转换语义（str/float/bool 都能进来，且是**截断**）。

导出用假仓储 + 假时钟 + 假 uuid（都只替换 `session_events` 模块命名空间里的名字，
**不碰** src/ontocopilot 的任何一个字节）。重跑两次字节一致。

    .venv/bin/python tools/golden/session_events.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import sys
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

from ontocopilot import session_events as SE  # noqa: E402
from ontocopilot.store.repo import EventRow  # noqa: E402

# ── 决定论替身 ────────────────────────────────────────────────────────


class _Clock:
    """单调递增的假时钟。真 time.time() 会让 golden 每次都不一样。"""

    def __init__(self) -> None:
        self.n = 0

    def reset(self) -> None:
        self.n = 0

    def time(self) -> float:
        self.n += 1
        return 1700000000.0 + self.n


class _Uuid:
    """uuid4().hex 的替身 —— 只用到 `.hex`。"""

    def __init__(self) -> None:
        self.n = 0

    def reset(self) -> None:
        self.n = 0

    def uuid4(self) -> SimpleNamespace:
        self.n += 1
        return SimpleNamespace(hex=f"{self.n:032x}")


class _AsyncioProxy:
    """透传 asyncio，但把 sleep 记下来并立刻返回。

    重试退避是 `min(0.05 * 2**attempt, 0.5)`，真睡会让导出慢且不影响结果 ——
    但**睡了几次、每次多久**本身是要钉的契约（TS 侧很容易写成固定间隔）。
    """

    def __init__(self, real: Any) -> None:
        self._real = real
        self.sleeps: list[float] = []

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        await self._real.sleep(0)


CLOCK = _Clock()
UUID = _Uuid()
ASYNCIO = _AsyncioProxy(asyncio)
SE.time = CLOCK          # type: ignore[assignment]
SE.uuid = UUID           # type: ignore[assignment]
SE.asyncio = ASYNCIO     # type: ignore[assignment]


class _LogSink(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


LOGS = _LogSink()
SE._LOG.addHandler(LOGS)
SE._LOG.setLevel(logging.ERROR)


# ── 假仓储 / 假会话 ───────────────────────────────────────────────────


class FakeRepo:
    """只实现 hub 用到的两个方法。真仓储的行为属于 store track 的 golden。"""

    def __init__(self, *, exists: bool = True, fail: int = 0,
                 exc: BaseException | None = None, echo_event_id: bool = True,
                 start_seq: int = 0) -> None:
        self.exists = exists
        self.fail_remaining = fail
        self.exc = exc if exc is not None else RuntimeError("库炸了")
        self.echo_event_id = echo_event_id
        self.next_seq = start_seq
        self.calls = 0
        self.rows: list[EventRow] = []
        self._by_event_id: dict[str, EventRow] = {}

    async def get_session(self, sid: str) -> Any | None:
        return object() if self.exists else None

    async def append_event(self, sid: str, kind: str, payload: dict[str, Any], *,
                           event_id: str = "") -> EventRow:
        self.calls += 1
        if self.fail_remaining > 0:
            self.fail_remaining -= 1
            raise self.exc
        if event_id and event_id in self._by_event_id:
            return self._by_event_id[event_id]      # 幂等重放，不发新号
        row = EventRow(seq=self.next_seq, kind=kind, payload=payload,
                       ts=CLOCK.time(),
                       event_id=event_id if self.echo_event_id else "")
        self.next_seq += 1
        self.rows.append(row)
        if event_id:
            self._by_event_id[event_id] = row
        return row


class FakeSession:
    def __init__(self, sid: str = "s1", events: list[dict[str, Any]] | None = None) -> None:
        self.id = sid
        self.events: list[dict[str, Any]] = [dict(e) for e in (events or [])]
        self.subscribers: list[asyncio.Queue] = []


def reset_fakes() -> None:
    """每个用例开头都调一次 —— 让每条 golden 记录**自成一体**。

    时钟/uuid 若跨用例累加，TS 侧就只能把 ts / eventId 抹成占位符再比，等于把两个
    真会被前端读到的字段从断言里删掉。逐用例复位之后，TS 侧注入同样的假时钟就能
    **逐字节**比全部字段 —— 顺带把"这条路径读了几次表"也钉住了。
    """
    CLOCK.reset()
    UUID.reset()
    ASYNCIO.sleeps.clear()
    LOGS.messages.clear()


def drain(q: asyncio.Queue) -> list[dict[str, Any]]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def shape(ev: dict[str, Any]) -> dict[str, Any]:
    """一条事件的完整形态：键序单独存 —— golden 落盘时 sort_keys=True 会打乱 dict。"""
    return {"keys": list(ev), "event": dict(ev)}


def shapes(evs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [shape(e) for e in evs]


# ── 用例 ──────────────────────────────────────────────────────────────


async def case_projection_shapes() -> list[dict[str, Any]]:
    """enqueue 之后、commit 之前，调用方拿到的那份 pending projection。"""
    cases: list[tuple[str, dict[str, Any]]] = [
        ("step.0", {}),
        ("chat.turn", {"turn": {"text": "已确认"}}),
        # payload 带 kind：键落在 payload 的位置上，值仍是形参 kind（形参在最后）
        ("ui.conflict", {"kind": "命名冲突", "detail": "两处口径不一致"}),
        # payload 带 seq/ts：值覆盖外层，位置仍是最前面两个
        ("ui.table", {"seq": 99, "ts": 5.0, "title": "缺口"}),
        # payload 带 eventId：位置是 payload 的，值被 uuid 覆盖
        ("legacy.echo", {"eventId": "caller-supplied", "n": 1}),
        # payload 键是"数组下标形状"的字符串：**这是两边唯一会分叉的键序**。
        # Python dict 一律按插入序，JS 对象把 canonical array index 的键提到最前。
        # 值和键集合完全一致，只有 JSON 里的键**顺序**不同 —— SSE 消费方解析
        # JSON，读不到顺序，所以无害；但要有记录，别哪天被当成 TS 侧的 bug。
        ("legacy.indexed", {"0": "第一行", "n": 1}),
        ("ui.table", {"title": "缺口", "columns": ["问题", "业务回答"],
                      "rows": [["金额阈值", "审批口径"]]}),
    ]
    out = []
    for kind, payload in cases:
        reset_fakes()
        hub = SE.DurableEventHub()
        sess = FakeSession()
        q: asyncio.Queue = asyncio.Queue()
        sess.subscribers.append(q)
        ev = hub.enqueue(sess, FakeRepo(), kind, dict(payload))
        out.append({
            "kind": kind, "payload": payload,
            **shape(ev),
            # enqueue **不**通知订阅者：未落库的 seq 绝不上 SSE
            "delivered_before_commit": drain(q),
            "session_events_is_projection": sess.events[-1] is ev,
        })
        await hub.shutdown()
    return out


async def case_pending_seq_counter() -> dict[str, Any]:
    """同一个 hub 的 pending seq 是进程级递增的负数（-1, -2, …），跨会话共享。"""
    reset_fakes()
    hub = SE.DurableEventHub()
    a, b = FakeSession("a"), FakeSession("b")
    repo = FakeRepo()
    seqs = [hub.enqueue(a, repo, "x", {})["seq"],
            hub.enqueue(b, repo, "y", {})["seq"],
            hub.enqueue(a, repo, "z", {})["seq"]]
    fresh = SE.DurableEventHub()
    fresh_first = fresh.enqueue(FakeSession("c"), repo, "x", {})["seq"]
    await hub.shutdown()
    await fresh.shutdown()
    return {"seqs": seqs, "fresh_hub_first": fresh_first}


async def case_ephemeral() -> list[dict[str, Any]]:
    """没有仓储/运行时时的 local-only 路径。seq = max(非负) + 1。"""
    seeds: list[list[dict[str, Any]]] = [
        [],
        [{"seq": 0, "kind": "a"}, {"seq": 1, "kind": "b"}],
        [{"seq": -1, "kind": "a"}, {"seq": -2, "kind": "b"}],
        [{"seq": 5, "kind": "a"}, {"seq": 2, "kind": "b"}],
        [{"kind": "无 seq 字段"}],
        [{"seq": "3", "kind": "字符串 seq"}],
        [{"seq": 2.9, "kind": "浮点 seq"}],
        [{"seq": True, "kind": "bool seq"}],
    ]
    out = []
    for seed in seeds:
        reset_fakes()
        hub = SE.DurableEventHub()
        sess = FakeSession(events=seed)
        q: asyncio.Queue = asyncio.Queue()
        sess.subscribers.append(q)
        ev = hub.emit_ephemeral(sess, "ui.note", {"text": "本地"})
        out.append({
            "seed": seed, **shape(ev),
            "delivered": drain(q),               # 本地路径**立刻**推给订阅者
            "session_events_len": len(sess.events),
        })
    return out


async def case_commit_flow() -> dict[str, Any]:
    """正常落库：projection 被原地回填成仓储的权威形态，订阅者只看到这一份。"""
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession()
    repo = FakeRepo()
    q: asyncio.Queue = asyncio.Queue()
    sess.subscribers.append(q)

    projections = [hub.enqueue(sess, repo, f"step.{n}", {"n": n}) for n in range(4)]
    pending = [dict(p) for p in projections]
    await hub.flush()

    delivered = drain(q)
    result = {
        "pending": shapes(pending),
        "projections": shapes(projections),
        "delivered": shapes(delivered),
        "session_events": shapes(sess.events),
        "rows": [{"seq": r.seq, "kind": r.kind, "payload": r.payload,
                  "event_id": r.event_id} for r in repo.rows],
        "receipt_after_commit_is_none": hub.receipt(projections[0]) is None,
        "wait_seq_after_commit": [await hub.wait_seq(p) for p in projections],
    }
    await hub.shutdown()
    return result


async def case_payload_frozen() -> dict[str, Any]:
    """emit 后调用方继续改同一个 rows —— 审计日志必须冻结在 emission 边界。"""
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession()
    repo = FakeRepo()
    rows = [["before"]]
    projection = hub.enqueue(sess, repo, "ui.table", {"rows": rows})
    rows[0][0] = "after"
    await hub.flush()
    out = {"row_payload": repo.rows[0].payload, "projection": dict(projection),
           "caller_rows": rows}
    await hub.shutdown()
    return out


async def case_no_event_id_echo() -> dict[str, Any]:
    """仓储回的行没有 event_id 时，as_sse 不带 eventId —— projection 上它会消失。"""
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession()
    projection = hub.enqueue(sess, FakeRepo(echo_event_id=False), "step.0", {"n": 0})
    had_event_id = "eventId" in projection
    await hub.flush()
    out = {"had_event_id_before_commit": had_event_id, **shape(projection)}
    await hub.shutdown()
    return out


async def case_detached_session() -> dict[str, Any]:
    """get_session 返回 None（单测里刻意脱离持久化的 Session）：退化成 local-only。"""
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession(events=[{"seq": 7, "kind": "旧事件"}])
    q: asyncio.Queue = asyncio.Queue()
    sess.subscribers.append(q)
    projection = hub.enqueue(sess, FakeRepo(exists=False), "step.0", {"n": 0})
    before = shape(projection)
    await hub.flush()
    out = {
        "before_commit": before,
        "after_commit": shape(projection),      # eventId 在这里**消失**
        "delivered": shapes(drain(q)),
        "session_events": shapes(sess.events),
        "wait_seq": await hub.wait_seq(projection),
    }
    await hub.shutdown()
    return out


async def case_persist_failed() -> list[dict[str, Any]]:
    """彻底写不进去：吼日志 + 推一条 event.persist_failed，绝不假装送达。"""
    out = []
    for attempts, exc in [(1, RuntimeError("库炸了")), (3, OSError("temporary")),
                          (2, ValueError("payload 太大"))]:
        reset_fakes()
        hub = SE.DurableEventHub(max_attempts=attempts)
        sess = FakeSession(events=[{"seq": 4, "kind": "旧事件"}])
        q: asyncio.Queue = asyncio.Queue()
        sess.subscribers.append(q)
        projection = hub.enqueue(sess, FakeRepo(fail=99, exc=exc), "chat.turn",
                                 {"turn": {"text": "hi"}})
        # 在失败发生**之前**就挂上去等收据的那一路：必须收到异常。
        early = asyncio.ensure_future(hub.wait_seq(projection))
        await asyncio.sleep(0)
        await hub.flush()
        try:
            early_result: Any = await early
            early_error = None
        except BaseException as e:                  # noqa: BLE001
            early_result, early_error = None, f"{type(e).__name__}: {e}"
        # 失败之后**才**问的那一路：收据已经被摘掉了，退化成读 projection 的负 seq。
        try:
            late_result: Any = await hub.wait_seq(projection)
            late_error = None
        except BaseException as e:                  # noqa: BLE001
            late_result, late_error = None, f"{type(e).__name__}: {e}"
        out.append({
            "max_attempts": attempts,
            "exc": f"{type(exc).__name__}: {exc}",
            "sleeps": list(ASYNCIO.sleeps),
            "log_messages": list(LOGS.messages),
            # 原 projection **保留**它的负 seq，供诊断；绝不改写成"已送达"
            "projection": shape(projection),
            "delivered": shapes(drain(q)),
            "session_events": shapes(sess.events),
            "wait_seq_early": {"result": early_result, "error": early_error},
            "wait_seq_late": {"result": late_result, "error": late_error},
        })
        await hub.shutdown()
    return out


async def case_retry_transient() -> dict[str, Any]:
    """一次瞬时失败后重试成功：不能写成两条。"""
    reset_fakes()
    hub = SE.DurableEventHub(max_attempts=2)
    sess = FakeSession()
    repo = FakeRepo(fail=1, exc=OSError("temporary"))
    projection = hub.enqueue(sess, repo, "once", {"n": 1})
    await hub.flush()
    out = {"calls": repo.calls, "rows": len(repo.rows), "sleeps": list(ASYNCIO.sleeps),
           **shape(projection)}
    await hub.shutdown()
    return out


async def case_sort_and_dedupe() -> list[dict[str, Any]]:
    """commit 后 session.events 的排序与去重。

    排序键：`(seq < 0, seq if seq >= 0 else -seq)` —— 非负在前升序，负号在后按
    |seq| 升序（也就是 emission 先后）。去重：同一个 durable seq 只留 projection 这份。
    """
    out = []
    seeds: list[tuple[str, list[dict[str, Any]], int]] = [
        ("乱序的历史", [{"seq": 3, "kind": "c"}, {"seq": 1, "kind": "a"},
                        {"seq": 2, "kind": "b"}], 4),
        ("混入未落库的负 seq", [{"seq": 2, "kind": "b"}, {"seq": -3, "kind": "p3"},
                                {"seq": -1, "kind": "p1"}, {"seq": 0, "kind": "a"}], 5),
        # SSE 轮询已经把同一条 seq 缓存进来了：commit 时要把它删掉，只留 projection
        ("重复 seq（在前）", [{"seq": 0, "kind": "dup", "n": 0}], 0),
        ("重复 seq（两份）", [{"seq": 0, "kind": "dup", "n": 0},
                              {"seq": 0, "kind": "dup", "n": 0}], 0),
    ]
    for label, seed, start_seq in seeds:
        reset_fakes()
        hub = SE.DurableEventHub()
        sess = FakeSession(events=seed)
        repo = FakeRepo(start_seq=start_seq)
        projection = hub.enqueue(sess, repo, "committed", {"n": 0})
        await hub.flush()
        out.append({
            "label": label, "seed": seed, "row_seq": start_seq,
            "session_events": shapes(sess.events),
            "projection_index": next(
                (i for i, e in enumerate(sess.events) if e is projection), -1),
        })
        await hub.shutdown()
    return out


async def case_receipt_and_wait_seq() -> dict[str, Any]:
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession()
    repo = FakeRepo()
    projection = hub.enqueue(sess, repo, "step.0", {"n": 0})
    out: dict[str, Any] = {
        "receipt_pending_is_none": hub.receipt(projection) is None,
        "receipt_unknown_is_none": hub.receipt({"seq": -99}) is None,
        # 已经是非负 seq 的事件：wait_seq 直接返回，不查收据
        "wait_seq_already_committed": await hub.wait_seq({"seq": 12, "kind": "x"}),
        "wait_seq_no_seq_key": await hub.wait_seq({"kind": "x"}),
        "wait_seq_unknown_negative": await hub.wait_seq({"seq": -7, "kind": "x"}),
    }
    out["wait_seq_pending"] = await hub.wait_seq(projection)
    await hub.shutdown()
    return out


async def case_shutdown_drains() -> dict[str, Any]:
    reset_fakes()
    hub = SE.DurableEventHub()
    sess = FakeSession()
    repo = FakeRepo()
    projections = [hub.enqueue(sess, repo, "tail", {"n": n}) for n in range(8)]
    await hub.shutdown()                       # 不 flush，直接 shutdown
    out = {"rows": [r.payload["n"] for r in repo.rows],
           "seqs": [p["seq"] for p in projections]}
    # shutdown 之后再 enqueue：状态被丢弃了，会重新起一个 worker
    again = hub.enqueue(sess, repo, "after", {"n": 8})
    await hub.flush()
    out["after_shutdown_seq"] = again["seq"]
    await hub.shutdown()
    return out


def case_seq_coercion() -> list[dict[str, Any]]:
    """`int(e.get("seq", -1))` 的强制转换 —— 排序键和 _next_local_seq 都走它。"""
    values: list[Any] = [0, 5, -1, -3, 2.9, -2.9, "3", "-4", True, False]
    out = []
    for v in values:
        try:
            out.append({"in": v, "out": int(v)})
        except (TypeError, ValueError) as e:
            out.append({"in": v, "error": type(e).__name__})
    for bad in ["3.5", "", "abc"]:
        try:
            out.append({"in": bad, "out": int(bad)})
        except (TypeError, ValueError) as e:
            out.append({"in": bad, "error": type(e).__name__})
    return out


def case_backoff() -> list[dict[str, Any]]:
    return [{"attempt": a, "delay": min(0.05 * (2 ** a), 0.5)} for a in range(8)]


async def main() -> None:
    out = {
        "projection_shapes": await case_projection_shapes(),
        "pending_seq_counter": await case_pending_seq_counter(),
        "ephemeral": await case_ephemeral(),
        "commit_flow": await case_commit_flow(),
        "payload_frozen": await case_payload_frozen(),
        "no_event_id_echo": await case_no_event_id_echo(),
        "detached_session": await case_detached_session(),
        "persist_failed": await case_persist_failed(),
        "retry_transient": await case_retry_transient(),
        "sort_and_dedupe": await case_sort_and_dedupe(),
        "receipt_and_wait_seq": await case_receipt_and_wait_seq(),
        "shutdown_drains": await case_shutdown_drains(),
        "seq_coercion": case_seq_coercion(),
        "backoff": case_backoff(),
    }
    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "session_events.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}")


if __name__ == "__main__":
    asyncio.run(main())
