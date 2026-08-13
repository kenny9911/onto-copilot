"""导出 kernel/recorder.py 的 golden —— 重放语义的事实。

recorder 是整个内核里最不能"看起来对"的模块：写错了不会当场报错，只会在某次
崩溃恢复时表现成"节点莫名其妙重跑了"或者"重放拿到了别人的结果"。所以这份 golden
钉的是**事件流本身**，而不是几个返回值。

**设计沿用 dag.py 的思路：golden 里存的是"程序"而不是"输入对象"。** 每个用例带
一串 ops（open/effect/complete_node/ask_human/…），Python 与 TS 各自用同一个解释器
replay 同一串 ops，再比对 (每步返回值, 完整事件流)。手抄的期望值和手抄的输入一样
不可信；这样连 effect key 的编号规则、payload 的键顺序、blob 的 ref 都一起被钉住。

四组独立向量：

* ``cases``    —— ops 程序，比对每步输出 + 事件流（去掉 ts_ms）。
* ``store``    —— INLINE_LIMIT 的边界。``len(json.dumps(...))`` 数的是**码位**，
  TS 侧 ``.length`` 数的是 UTF-16 码元，所以专门放了一条星平面字符的用例：
  照着码元判会把一个本该内联的结果甩进 blob（反过来也会）。
* ``digest``   —— 请求摘要。``str(v)`` 对容器给的是 Python repr（``{'a': 1}``），
  截断按码位切。这段字符串直接进事件日志，是人排障时唯一看得到的请求内容。
* ``clock``    —— now / rand 的 effect 形状（值本身与环境有关，只钉 key/kind/fp）。

字节确定：``now_ms`` 被钉成常量（事件时间戳与 clock.now 都走它），无随机、无集合
迭代序。重跑两次 shasum 必须一致。

跑法::

    .venv/bin/python tools/golden/recorder.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel import recorder as recorder_mod  # noqa: E402
from ontocopilot.kernel.events import EventKind  # noqa: E402
from ontocopilot.kernel.ids import fingerprint  # noqa: E402
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal  # noqa: E402
from ontocopilot.kernel.recorder import INLINE_LIMIT, Recorder, _digest  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "golden"

#: 钉死的墙钟。emit 的 ts_ms 和 clock.now 的结果都走 recorder 模块里的这个名字。
TS_MS = 1_723_000_000_000
recorder_mod.now_ms = lambda: TS_MS

#: 星平面字符（U+1D11E，UTF-16 里占两个码元）。用来把"码位 vs 码元"的分叉逼出来。
ASTRAL = "\U0001d11e"


# ══════════════════════════════════════════════════════════════════
#  ops 解释器 —— TS 侧要有一份等价实现
# ══════════════════════════════════════════════════════════════════
def materialize(spec: Any) -> Any:
    """把 ``{"__repeat__": [ch, n]}`` 展开成长串。

    长串直接写进 golden 会让文件涨到几十 KB 且 diff 全是噪声，所以只写生成式。
    """
    if isinstance(spec, dict) and "__repeat__" in spec:
        ch, n = spec["__repeat__"]
        return ch * n
    return spec


class Boom(RuntimeError):
    """用例里制造失败用的异常。类名会出现在 EFFECT_FAILED 的 error 字段里。"""


async def run_case(case: dict[str, Any]) -> dict[str, Any]:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    rec: Recorder | None = None
    outputs: list[Any] = []

    for step in case["steps"]:
        op = step["op"]
        try:
            if op == "open":
                rec = Recorder("r1", journal, blobs, resume=step.get("resume", False))
                outputs.append(None)
                continue
            assert rec is not None, "第一步必须是 open"

            if op == "effect":
                result = materialize(step.get("result"))
                if step.get("raises"):
                    def fn(msg: str = step["raises"]) -> Any:
                        raise Boom(msg)
                else:
                    def fn(v: Any = result) -> Any:
                        return v
                request = {k: materialize(v) for k, v in step["request"].items()}
                outputs.append(await rec.effect(
                    step["node"], step["kind"], request, fn, key=step.get("key")
                ))
            elif op == "complete_node":
                rec.complete_node(step["node"], materialize(step.get("output")))
                outputs.append(None)
            elif op == "node_is_complete":
                outputs.append(rec.node_is_complete(step["node"]))
            elif op == "node_output":
                outputs.append(rec.node_output(step["node"]))
            elif op == "next_attempt":
                outputs.append(rec.next_attempt(step["node"]))
            elif op == "node_entered":
                rec.emit(EventKind.NODE_ENTERED, node_id=step["node"],
                         payload={"attempt": step["attempt"]})
                outputs.append(None)
            elif op == "ask_human":
                outputs.append(await rec.ask_human(
                    step["node"], step["request_id"], step["payload"]))
            elif op == "record_human_answer":
                rec.record_human_answer(step["node"], step["request_id"], step["answer"])
                outputs.append(None)
            else:  # pragma: no cover —— 用例写错了
                raise AssertionError(f"未知 op: {op}")
        except Exception as exc:  # noqa: BLE001 —— 报错本身就是要钉的行为
            outputs.append({"__error__": type(exc).__name__, "message": str(exc)})

    events = [
        {k: v for k, v in ev.to_dict().items() if k != "ts_ms"}
        for ev in journal.read("r1")
    ]
    return {"name": case["name"], "why": case["why"], "steps": case["steps"],
            "outputs": outputs, "events": events}


# ══════════════════════════════════════════════════════════════════
#  用例
# ══════════════════════════════════════════════════════════════════
#: 超过 INLINE_LIMIT 的结果（json.dumps 后 2502 码位）。够大就行，不必真的几万字。
BIG = {"__repeat__": ["x", 2500]}

CASES: list[dict[str, Any]] = [
    {
        "name": "effect_executes_once_then_replays",
        "why": "重放不重新调用、不重新付费：第二轮 fn 返回 WRONG 也拿回首次结果",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "抽取对象"}, "result": "23 个对象"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "抽取对象"}, "result": "WRONG"},
        ],
    },
    {
        "name": "keys_are_namespaced_per_node",
        "why": "并行节点的全局顺序不稳定，所以 effect 按节点分命名空间；换序重放各拿各的",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "A", "kind": "t", "request": {"i": 0}, "result": "a0"},
            {"op": "effect", "node": "B", "kind": "t", "request": {"i": 0}, "result": "b0"},
            {"op": "effect", "node": "A", "kind": "t", "request": {"i": 1}, "result": "a1"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "B", "kind": "t", "request": {"i": 0}, "result": "WRONG"},
            {"op": "effect", "node": "A", "kind": "t", "request": {"i": 0}, "result": "WRONG"},
            {"op": "effect", "node": "A", "kind": "t", "request": {"i": 1}, "result": "WRONG"},
        ],
    },
    {
        "name": "explicit_key_replaces_the_counter",
        "why": "节点内并发的 effect（四个 critic 视角）必须显式给 key，否则计数器顺序不稳",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "CRITIC", "kind": "llm.call",
             "request": {"lens": "schema"}, "key": "schema", "result": "schema:ok"},
            {"op": "effect", "node": "CRITIC", "kind": "llm.call",
             "request": {"lens": "naming"}, "key": "naming", "result": "naming:ok"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "CRITIC", "kind": "llm.call",
             "request": {"lens": "naming"}, "key": "naming", "result": "WRONG"},
            {"op": "effect", "node": "CRITIC", "kind": "llm.call",
             "request": {"lens": "schema"}, "key": "schema", "result": "WRONG"},
        ],
    },
    {
        "name": "changed_request_raises_determinism_violation",
        "why": "重放时请求变了说明混进了未记账的非确定性，必须炸而不是放宽",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "v1"}, "result": "out"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "v2"}, "result": "out"},
        ],
    },
    {
        "name": "large_result_goes_to_blob",
        "why": "大结果落 blob，事件里只留 ref；重放从 blob 读回",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "tool.exec", "request": {}, "result": BIG},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "N", "kind": "tool.exec", "request": {}, "result": None},
        ],
    },
    {
        "name": "crash_midway_resumes_from_last_effect",
        "why": "核心承诺：第 3 步崩溃从第 3 步继续，前 3 步不重跑（失败的那次没记账）",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 0}, "result": "step0"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 1}, "result": "step1"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 2}, "result": "step2"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 3}, "raises": "沙箱超时"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 0}, "result": "WRONG"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 1}, "result": "WRONG"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 2}, "result": "WRONG"},
            {"op": "effect", "node": "LOOP", "kind": "llm.call",
             "request": {"i": 3}, "result": "step3"},
        ],
    },
    {
        "name": "duplicate_effect_record_keeps_the_first",
        "why": "同 key 的重复写入意味着重试，重放必须复用首次结果（_effects 是 setdefault）",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "p"}, "result": "first"},
            # 不 resume 的新 Recorder：计数器从头开始，于是同一个 key 被写第二遍
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "p"}, "result": "second"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": "p"}, "result": "WRONG"},
        ],
    },
    {
        "name": "completed_node_is_skipped_entirely",
        "why": "节点级 checkpoint：历史里有 NODE_COMPLETED 就直接恢复产出",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "complete_node", "node": "EXTRACT", "output": {"objects": 23}},
            {"op": "complete_node", "node": "NONE_OUT", "output": None},
            {"op": "open", "resume": True},
            {"op": "node_is_complete", "node": "EXTRACT"},
            {"op": "node_output", "node": "EXTRACT"},
            {"op": "node_is_complete", "node": "ALIGN"},
            {"op": "node_is_complete", "node": "NONE_OUT"},
            {"op": "node_output", "node": "NONE_OUT"},
            {"op": "node_output", "node": "ALIGN"},
        ],
    },
    {
        "name": "attempts_are_recovered_from_node_entered",
        "why": "重试次数从历史里的 NODE_ENTERED 恢复，恢复后接着往下数",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "next_attempt", "node": "N"},
            {"op": "node_entered", "node": "N", "attempt": 0},
            {"op": "next_attempt", "node": "N"},
            {"op": "node_entered", "node": "N", "attempt": 1},
            {"op": "open", "resume": True},
            {"op": "next_attempt", "node": "N"},
            {"op": "next_attempt", "node": "OTHER"},
        ],
    },
    {
        "name": "human_gate_suspends_then_resumes",
        "why": "HITL 是持久化的：挂起 → 人回答 → 重放到原地继续",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "CLARIFY", "kind": "llm.call",
             "request": {}, "result": "3 个问题"},
            {"op": "ask_human", "node": "CLARIFY", "request_id": "q_plan_amount",
             "payload": {"options": ["A", "B"]}},
            {"op": "open", "resume": True},
            {"op": "record_human_answer", "node": "CLARIFY", "request_id": "q_plan_amount",
             "answer": {"option_id": "split_two_properties"}},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "CLARIFY", "kind": "llm.call",
             "request": {}, "result": "WRONG"},
            {"op": "ask_human", "node": "CLARIFY", "request_id": "q_plan_amount",
             "payload": {"options": ["A", "B"]}},
        ],
    },
    {
        "name": "effect_failure_is_logged_and_reraised",
        "why": "失败的 effect 不记账，重试时真正重跑；EFFECT_FAILED 里带 类名: 消息",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "tool.exec",
             "request": {}, "raises": "沙箱超时"},
            {"op": "open", "resume": True},
            {"op": "effect", "node": "N", "kind": "tool.exec", "request": {}, "result": "ok"},
        ],
    },
    {
        "name": "prompt_body_is_not_dumped_into_the_log",
        "why": "事件日志里只留 400 码位的摘要，全量内容靠 fp 与 blob 关联",
        "steps": [
            {"op": "open", "resume": False},
            {"op": "effect", "node": "N", "kind": "llm.call",
             "request": {"prompt": {"__repeat__": ["月", 5000]}}, "result": "ok"},
        ],
    },
]


# ══════════════════════════════════════════════════════════════════
#  store：INLINE_LIMIT 的边界
# ══════════════════════════════════════════════════════════════════
#: (说明, 值生成式)。json.dumps 的长度按**码位**算 —— 引号占 2 个。
STORE_SPECS: list[tuple[str, Any]] = [
    ("恰好 2048 码位：内联", {"__repeat__": ["x", INLINE_LIMIT - 2]}),
    ("2049 码位：落 blob", {"__repeat__": ["x", INLINE_LIMIT - 1]}),
    ("CJK 2048 码位（UTF-8 是 3 倍字节）：仍然内联", {"__repeat__": ["月", INLINE_LIMIT - 2]}),
    ("星平面 1026 码位 / 2050 码元：按码元判就会错判成 blob",
     {"__repeat__": [ASTRAL, 1024]}),
    ("小对象：内联", {"objects": 23, "note": "ok"}),
    ("None：内联", None),
]


async def export_store() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for why, spec in STORE_SPECS:
        value = materialize(spec)
        journal, blobs = InMemoryJournal(), InMemoryBlobStore()
        rec = Recorder("r1", journal, blobs)
        await rec.effect("N", "tool.exec", {}, lambda v=value: v)
        ev = next(e for e in journal.read("r1") if e.kind is EventKind.EFFECT_COMPLETED)
        rows.append({
            "why": why,
            "value": spec,
            "json_len": len(json.dumps(value, ensure_ascii=False, default=str)),
            "inline": "result" in ev.payload,
            "ref": ev.ref,
        })
    return rows


# ══════════════════════════════════════════════════════════════════
#  digest：请求摘要
# ══════════════════════════════════════════════════════════════════
#: TS 侧必须逐字节相同的。**不含 float** —— 见 DIGEST_DIVERGENT。
DIGEST_EXACT: list[tuple[str, dict[str, Any]]] = [
    ("短字符串原样", {"prompt": "抽取对象", "lens": "schema"}),
    ("int / bool / None 走 str()", {"n": 10000, "ok": True, "no": False, "nil": None}),
    ("嵌套容器走 repr：单引号、', ' 分隔", {"args": {"a": 1, "b": "x"}, "xs": [1, "y", True, None]}),
    ("空容器", {"d": {}, "l": [], "s": ""}),
    ("字符串里有引号：repr 会换引号", {"q": {"k": "it's"}, "q2": {"k": 'say "hi"'}}),
    ("恰好 400 码位不截断", {"prompt": {"__repeat__": ["月", 400]}}),
    ("401 码位开始截断，尾巴带 …(+N)", {"prompt": {"__repeat__": ["月", 401]}}),
    ("长 prompt", {"prompt": {"__repeat__": ["月", 5000]}}),
    ("星平面字符按码位切，不劈成半个", {"prompt": {"__repeat__": [ASTRAL, 401]}}),
]

#: **已知分叉**（与 ids.ts / journal.ts 同一族）：JS 分不出 1 与 1.0，
#: 也不用 Python 的指数记号阈值。摘要只进日志、不进指纹，不影响重放。
DIGEST_DIVERGENT: list[tuple[str, dict[str, Any]]] = [
    ("值为整数的 float", {"t": 1.0}),
    ("小数 float", {"t": 0.25}),
    ("指数记号阈值", {"t": 1e-5}),
    ("容器里的 float", {"args": {"temperature": 1.0}}),
]


# ══════════════════════════════════════════════════════════════════
#  clock：now / rand 的 effect 形状
# ══════════════════════════════════════════════════════════════════
async def export_clock() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for call, node, req, kind in [
        ("now", "N", {}, "clock.now"),
        ("rand", "N", {"n": 10000}, "clock.rand"),
    ]:
        journal, blobs = InMemoryJournal(), InMemoryBlobStore()
        rec = Recorder("r1", journal, blobs)
        if call == "now":
            await rec.now(node)
        else:
            await rec.rand(node, req["n"])
        ev = next(e for e in journal.read("r1") if e.kind is EventKind.EFFECT_REQUESTED)
        rows.append({
            "call": call, "node": node, "n": req.get("n"),
            "key": ev.payload["key"], "kind": kind, "fp": ev.payload["fp"],
            "request": ev.payload["request"],
        })
    return rows


# ══════════════════════════════════════════════════════════════════
async def main() -> None:
    payload = {
        "_note": "由 tools/golden/recorder.py 生成，勿手改",
        "inline_limit": INLINE_LIMIT,
        "ts_ms": TS_MS,
        "fingerprints": [
            {"kind": k, "request": r, "fp": fingerprint({"kind": k, "request": r})}
            for k, r in [
                ("llm.call", {"prompt": "抽取对象"}),
                ("llm.call", {"prompt": "v1"}),
                ("clock.now", {}),
                ("clock.rand", {"n": 10000}),
                ("tool.call", {"tool": "sql", "args": {"q": "select 1"}}),
            ]
        ],
        "cases": [await run_case(c) for c in CASES],
        "store": await export_store(),
        # request 存的是生成式（长串不进 golden），两边各自 materialize 之后再打
        "digest": [
            {"why": why, "request": req,
             "out": _digest({k: materialize(v) for k, v in req.items()})}
            for why, req in DIGEST_EXACT
        ],
        "digest_divergent": [
            {"why": why, "request": req,
             "python": _digest({k: materialize(v) for k, v in req.items()})}
            for why, req in DIGEST_DIVERGENT
        ],
        "clock": await export_clock(),
    }
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "recorder.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  recorder.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    asyncio.run(main())
