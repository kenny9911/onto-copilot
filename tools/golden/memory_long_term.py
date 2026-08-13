"""kernel/memory 的 long_term / dialogue / context / project 四件套的 golden。

这一组是「项目内记忆共享但不污染」那个产品特性的**全部实现**，语义错了特性就废了。
所以这里不挑"代表性"用例，而是把每一条护栏连同它的**反例**一起钉死：

  - `PromotionGate`：四种理由之外一律拒；参考档在闸门**内部**被无条件挡掉
    （不是靠调用方自觉）；没有 support 的一律拒。
  - contested-not-overwrite：冲突时两条都留、标争议，**不是**后写覆盖先写。
  - 参考档不许借 confidence 0.95 把人拍板的条目打成 superseded（红队 R4）；
    反向（人拍板推翻推断）必须仍然通。
  - 参考档的 support 不许并进权威档 —— 那是从后门进交付物的溯源。
  - `recall` 不给参考档攒 hit_runs（REPEATED 的判据），use_count 照记（衰减要用）。
  - `decay`：老记忆权重下降但不删除，跌破地板才淘汰；DECISION 完全豁免。
  - `_user_said` / `_norm_quote`（住在 server.py，语义属于对话记忆）：伪造的 quote
    必须拒 —— 这是「参考档洗成权威档」那条红队路径的堵点。
  - `ContextManager.assemble`：L0/L3/L1/L2 的装配顺序与预算分配逐层钉住。

字节确定性：
  - 不直接序列化 set（str 的哈希随 PYTHONHASHSEED 变），一律先 sorted；
  - `Utterance.ts` / `Decision.ts` 是 `time.time()`，落盘前一律换成 "<ts>"；
  - 场景是**算子流**（ops），两边照同一串重放，比对每一步的返回值和终态快照。

    .venv/bin/python tools/golden/memory_long_term.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.memory.context import (  # noqa: E402
    ContextManager,
    LayerShares,
    _clip,
    _render_upstream,
)
from ontocopilot.kernel.memory.dialogue import (  # noqa: E402
    PROMOTABLE,
    Decision,
    DecisionKind,
    DialogueMemory,
    Speaker,
    Utterance,
    heuristic_digest,
)
from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex  # noqa: E402
from ontocopilot.kernel.memory.long_term import (  # noqa: E402
    DecayPolicy,
    LongTermStore,
    PromotionGate,
    PromotionReason,
    variant_of,
)
from ontocopilot.kernel.memory.project import ROW_FIELDS, ProjectMemory  # noqa: E402
from ontocopilot.kernel.memory.short_term import Scratchpad, WorkingSet  # noqa: E402
from ontocopilot.kernel.memory.types import (  # noqa: E402
    MemoryItem,
    MemoryKind,
    MemoryTier,
    Scope,
)
from ontocopilot.server import _norm_quote, _user_said  # noqa: E402

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ── 造件 ──────────────────────────────────────────────────────────
def build(init: dict[str, Any]) -> MemoryItem:
    """按 init（全 JSON 可表示）造一条 MemoryItem。TS 侧照同一份 init 造。"""
    kw = dict(init)
    if "kind" in kw:
        kw["kind"] = MemoryKind(kw["kind"])
    if "scope" in kw:
        kw["scope"] = Scope(kw["scope"])
    if "tier" in kw:
        kw["tier"] = MemoryTier(kw["tier"])
    if "hit_runs" in kw:
        kw["hit_runs"] = set(kw["hit_runs"])
    return MemoryItem(**kw)


def item(content: str, kind: str = "convention", **over: Any) -> dict[str, Any]:
    """权威档条目的 init。默认带 support —— 没 support 的连闸门都过不了。"""
    d: dict[str, Any] = {
        "key": over.pop("key", f"{kind}:k"),
        "kind": kind,
        "scope": over.pop("scope", "run"),
        "content": content,
        "support": over.pop("support", ["ev:1"]),
    }
    d.update(over)
    return d


def ref(content: str, kind: str = "lesson", **over: Any) -> dict[str, Any]:
    """参考档条目的 init —— 模型自己推断出来的。"""
    d = item(content, kind, **over)
    d["tier"] = "reference"
    d.setdefault("scope", "project")
    return d


def mask_ts(v: Any) -> Any:
    """`time.time()` 出来的时间戳换成占位符 —— 否则 golden 每次重跑都变。"""
    if isinstance(v, dict):
        return {k: ("<ts>" if k == "ts" else mask_ts(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [mask_ts(x) for x in v]
    return v


# ══════════════════════════════════════════════════════════════════
#  1. PromotionGate —— 四种理由，以及每一条拒绝的确切措辞
# ══════════════════════════════════════════════════════════════════
GATE_CASES: list[dict[str, Any]] = []
for _reason in PromotionReason:
    # 权威档 + 有 support + 判据凑满：该过的过
    GATE_CASES.append({"gate": {}, "item": item("内容", hit_runs=["r1", "r2"]),
                       "reason": str(_reason), "critic_rounds": 2})
    # 权威档但没 support：一律拒
    GATE_CASES.append({"gate": {}, "item": item("内容", support=[]),
                       "reason": str(_reason), "critic_rounds": 9})
    # 参考档：判据全凑满也拒 —— 闸门内部的无条件前置检查
    GATE_CASES.append({"gate": {}, "item": ref("内容", hit_runs=["r1", "r2", "r3"]),
                       "reason": str(_reason), "critic_rounds": 9})
GATE_CASES += [
    # 判据差一点
    {"gate": {}, "item": item("c", hit_runs=["r1"]), "reason": "repeated", "critic_rounds": 0},
    {"gate": {}, "item": item("c"), "reason": "repeated", "critic_rounds": 0},
    {"gate": {}, "item": item("c"), "reason": "critic_survived", "critic_rounds": 1},
    {"gate": {}, "item": item("c"), "reason": "critic_survived", "critic_rounds": 2},
    # 调过参数的闸门
    {"gate": {"min_distinct_runs": 3}, "item": item("c", hit_runs=["r1", "r2"]),
     "reason": "repeated", "critic_rounds": 0},
    {"gate": {"min_critic_rounds": 5}, "item": item("c"),
     "reason": "critic_survived", "critic_rounds": 4},
    # require_support=False：没依据也放行（只有显式关掉才行）
    {"gate": {"require_support": False}, "item": item("c", support=[]),
     "reason": "imported", "critic_rounds": 0},
    {"gate": {"require_support": False}, "item": ref("c", support=[]),
     "reason": "imported", "critic_rounds": 0},
]


# ══════════════════════════════════════════════════════════════════
#  2. LongTermStore —— 算子流场景
# ══════════════════════════════════════════════════════════════════
def run_store(spec: dict[str, Any]) -> dict[str, Any]:
    gate = PromotionGate(**spec.get("gate", {}))
    dk = dict(spec.get("decay", {}))
    if "immune_kinds" in dk:
        dk["immune_kinds"] = frozenset(MemoryKind(k) for k in dk["immune_kinds"])
    store = LongTermStore(spec.get("project", "proj"), gate=gate, decay=DecayPolicy(**dk))
    results: list[Any] = []
    for op in spec["ops"]:
        kind = op["op"]
        if kind == "promote":
            it = build(op["item"])
            ok, why = store.promote(it, PromotionReason(op["reason"]),
                                    run_id=op.get("run_id", ""),
                                    critic_rounds=op.get("critic_rounds", 0))
            results.append({"ok": ok, "why": why, "item_after": it.to_dict()})
        elif kind == "note":
            it = build(op["item"])
            ok, why = store.note(it, run_id=op.get("run_id", ""))
            results.append({"ok": ok, "why": why, "item_after": it.to_dict()})
        elif kind == "adopt":
            results.append(store.adopt(build(x) for x in op["items"]))
        elif kind == "recall":
            got = store.recall(
                op["query"],
                run_id=op.get("run_id", ""),
                kinds=None if op.get("kinds") is None
                else [MemoryKind(k) for k in op["kinds"]],
                limit=op.get("limit", 8),
                budget_tokens=op.get("budget_tokens"),
                current_files=None if op.get("current_files") is None
                else set(op["current_files"]),
            )
            results.append({"keys": [m.key for m in got],
                            "use_count": [m.use_count for m in got],
                            "hit_runs": [sorted(m.hit_runs) for m in got]})
        elif kind == "start_run":
            store.start_run(op["run"])
            results.append(None)
        elif kind == "decay":
            results.append([e.key for e in store.decay(op["run"])])
        elif kind == "snapshot":
            results.append(store.to_dict())
        elif kind == "get":
            got = store.get(op["key"])
            results.append(None if got is None else got.to_dict())
        elif kind == "len":
            results.append(len(store))
        else:  # pragma: no cover
            raise AssertionError(f"未知算子 {kind}")
    return {"spec": spec, "results": results, "final": store.to_dict()}


_C1 = "计划金额口径为含税年度累计"
_C2 = "计划金额口径为不含税单次"

STORE_SCENARIOS: list[dict[str, Any]] = [
    # 没依据的记忆进不去长期库
    {"name": "no_support_never_promotes", "ops": [
        {"op": "promote", "item": item("金额一律含税", support=[]),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "len"}]},
    # 单次观察不够 / 两个 Run 够
    {"name": "repeated_needs_two_runs", "gate": {"min_distinct_runs": 2}, "ops": [
        {"op": "promote", "item": item("采购包头统一叫 purchasePackage", hit_runs=["r1"]),
         "reason": "repeated", "run_id": "r1"},
        {"op": "len"},
        {"op": "promote", "item": item("采购包头统一叫 purchasePackage",
                                       hit_runs=["r1", "r2"]),
         "reason": "repeated", "run_id": "r2"},
        {"op": "len"}]},
    # 人拍板立刻高可信；scope 被顶成 project
    {"name": "human_confirmed_bumps_confidence", "ops": [
        {"op": "promote", "item": item("计划金额拆成含税/不含税两个属性", "decision",
                                       confidence=0.3),
         "reason": "human_confirmed", "run_id": "r1"}]},
    # 一致的观察加固可信度（0.98 封顶），且不堆同义副本
    {"name": "agreeing_reinforces", "ops": [
        {"op": "promote", "item": item("apiName 用 lowerCamelCase"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "promote", "item": item("apiName 用 lowerCamelCase", hit_runs=["r1", "r2"]),
         "reason": "repeated", "run_id": "r2"},
        {"op": "promote", "item": item("apiName  用   lowerCamelCase！", hit_runs=["r3"]),
         "reason": "imported", "run_id": "r3"},
        {"op": "len"}]},
    # 加固时那句 `可信度 → {x:.2f}` 落在**精确的十进制并列点**上：
    # 0.025 + 0.1 == 0.125（二进制精确），CPython 的 `.2f` 取偶给 "0.12"，
    # JS 的 `toFixed(2)` 取远离零给 "0.13"。这条串进 promote 的返回说明和事件日志。
    {"name": "reinforce_confidence_is_a_rounding_tie", "ops": [
        {"op": "promote", "item": item("apiName 用 lowerCamelCase", confidence=0.025),
         "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item("apiName 用 lowerCamelCase", hit_runs=["r1", "r2"]),
         "reason": "repeated", "run_id": "r2"},
        {"op": "promote", "item": item("apiName 用 lowerCamelCase", hit_runs=["r1", "r3"]),
         "reason": "repeated", "run_id": "r3"},
        {"op": "get", "key": "convention:k"}]},
    # 冲突 → 两条都留、标争议，**不是**后写覆盖先写
    {"name": "contested_not_overwritten", "ops": [
        {"op": "promote", "item": item(_C1, "fact"), "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item(_C2, "fact", support=["ev:9"], hit_runs=["r2", "r3"]),
         "reason": "repeated", "run_id": "r3"},
        {"op": "get", "key": "fact:k"},
        {"op": "len"}]},
    # 同一条矛盾内容再来一次：variant key 去重，不重复追加
    {"name": "same_contradiction_twice", "ops": [
        {"op": "promote", "item": item(_C1, "fact"), "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item(_C2, "fact", hit_runs=["r2", "r3"]),
         "reason": "repeated", "run_id": "r3"},
        {"op": "promote", "item": item(_C2, "fact", hit_runs=["r2", "r4"]),
         "reason": "repeated", "run_id": "r4"},
        {"op": "get", "key": "fact:k"}]},
    # 人拍板推翻既有推断：旧值降级留档（superseded），不删
    {"name": "human_supersedes_inference", "ops": [
        {"op": "promote", "item": item("采购包与计划是一对多", "fact", confidence=0.6),
         "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item("采购包与计划是多对多", "fact", support=["human:q2"]),
         "reason": "human_confirmed", "run_id": "r2"},
        {"op": "len"}]},
    # 红队 R4：参考档就算自称 0.99 也不许把人拍板的条目打进坟场
    {"name": "reference_cannot_supersede_human", "ops": [
        {"op": "promote", "item": item("计划金额一律按含税年度累计", "fact"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "note", "item": ref("计划金额一律按不含税单次", "fact",
                                   support=["llm:r2"], confidence=0.99), "run_id": "r2"},
        {"op": "get", "key": "fact:k"},
        {"op": "recall", "query": "计划金额", "run_id": "r3"}]},
    # 红队 R4 的**判别性**用例：权威档 confidence 只有 0.5（IMPORTED 那条路不加
    # 分），参考档自称 0.99。旧代码的裸比较 `new >= 0.95 > old` 在这里为真 ——
    # 参考档就能把人拍板的条目打进 superseded 坟场。加了档位判断之后必须为假。
    # 上面那条 reference_cannot_supersede_human 里 old 已经是 0.95，两版行为一样，
    # 单靠它测不出这个洞。
    {"name": "reference_cannot_supersede_low_confidence_authoritative", "ops": [
        {"op": "promote", "item": item("计划金额一律按含税年度累计", "fact"),
         "reason": "imported", "run_id": "r1"},
        {"op": "note", "item": ref("计划金额一律按不含税单次", "fact",
                                   support=["llm:r2"], confidence=0.99), "run_id": "r2"},
        {"op": "get", "key": "fact:k"},
        {"op": "len"},
        {"op": "recall", "query": "计划金额", "run_id": "r3"}]},
    # 另一半判别性用例：老的是参考档、新的是权威档但 confidence 只有 0.5。
    # 档位裁得了，就不该回落到数字 —— 人拍板的内容必须顶掉模型的猜测。
    {"name": "low_confidence_authoritative_still_supersedes_reference", "ops": [
        {"op": "note", "item": ref("采购包与计划是一对多", "fact"), "run_id": "r1"},
        {"op": "promote", "item": item("采购包与计划是多对多", "fact", key="fact:k"),
         "reason": "imported", "run_id": "r2"},
        {"op": "get", "key": "fact:k"},
        {"op": "len"}]},
    # 反向必须通：人在会话里重新拍板，顶掉模型先前的猜测
    {"name": "human_still_supersedes_guess", "ops": [
        {"op": "note", "item": ref("采购包与计划是一对多", "fact"), "run_id": "r1"},
        {"op": "promote", "item": item("采购包与计划是多对多", "fact", key="fact:k",
                                       support=["human:q2"]),
         "reason": "human_confirmed", "run_id": "r2"},
        {"op": "get", "key": "fact:k"},
        {"op": "len"}]},
    # 参考档的 support 不许并进权威档
    {"name": "reference_support_never_leaks", "ops": [
        {"op": "promote", "item": item("金额含税", "fact", support=["human:q1"]),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "note", "item": ref("金额不含税", "fact", support=["llm:猜的"]),
         "run_id": "r2"},
        {"op": "get", "key": "fact:k"}]},
    # 参考档不许借 DECISION 这个 kind
    {"name": "reference_may_not_borrow_decision", "ops": [
        {"op": "promote", "item": ref("金额口径以财务表为准", "decision"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "note", "item": ref("金额口径以财务表为准", "decision"), "run_id": "r1"},
        {"op": "len"}]},
    # note() 只收参考档
    {"name": "note_rejects_authoritative", "ops": [
        {"op": "note", "item": item("人拍的板"), "run_id": "r1"},
        {"op": "len"}]},
    # recall 不给参考档攒 hit_runs（REPEATED 的判据），use_count 照记
    {"name": "recall_no_promotion_evidence_for_reference", "ops": [
        {"op": "note", "item": ref("采购包和计划八成是一对多", key="lesson:ref"),
         "run_id": "r1"},
        {"op": "promote", "item": item("采购包与计划一对多", "fact", key="fact:auth"),
         "reason": "imported", "run_id": "r1"},
        {"op": "recall", "query": "采购包 计划", "run_id": "r2", "limit": 10},
        {"op": "recall", "query": "采购包 计划", "run_id": "r3", "limit": 10},
        {"op": "recall", "query": "采购包 计划", "run_id": "r4", "limit": 10},
        {"op": "get", "key": "lesson:ref"},
        {"op": "get", "key": "fact:auth"}]},
    # DECISION 吃 1.3 prior，排在同词法命中的推断前面
    {"name": "recall_ranks_decision_first", "ops": [
        {"op": "promote", "item": item("计划金额可能含税", "fact", key="fact:a"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "promote", "item": item("计划金额拆成两个属性", "decision", key="decision:b"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "recall", "query": "计划金额", "run_id": "r2", "limit": 2}]},
    # 参考档降权 0.6，跨材料再降 0.6
    {"name": "recall_reference_discounts", "ops": [
        {"op": "note", "item": ref("计划金额取自本表", key="lesson:near",
                                   origin_session="s1"), "run_id": "r0"},
        {"op": "note", "item": ref("计划金额取自本表", key="lesson:far",
                                   origin_session="s2", origin_files=["别的项目.xlsx"]),
         "run_id": "r0"},
        {"op": "promote", "item": item("计划金额取自本表", key="fact:auth", kind="fact"),
         "reason": "imported", "run_id": "r0"},
        {"op": "recall", "query": "计划金额", "run_id": "r1",
         "current_files": ["实体梳理.xlsx"]},
        {"op": "recall", "query": "计划金额", "run_id": "r2", "current_files": None}]},
    # superseded 变体被 recall 直接排除
    {"name": "recall_excludes_superseded", "ops": [
        {"op": "promote", "item": item("采购包与计划是一对多", "fact", confidence=0.6),
         "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item("采购包与计划是多对多", "fact", support=["human:q2"]),
         "reason": "human_confirmed", "run_id": "r2"},
        {"op": "recall", "query": "采购包 计划", "run_id": "r3", "limit": 10},
        {"op": "len"}]},
    # kinds 过滤 + limit + budget_tokens 的裁剪路径（跳过装不下的，继续往后看）
    {"name": "recall_budget_and_kinds", "ops": [
        {"op": "promote", "item": item("计划金额" * 30, "fact", key="fact:big"),
         "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item("计划金额", "term", key="term:small"),
         "reason": "imported", "run_id": "r1"},
        {"op": "recall", "query": "计划金额", "run_id": "r2", "budget_tokens": 20},
        {"op": "recall", "query": "计划金额", "run_id": "r2", "kinds": ["term"]},
        {"op": "recall", "query": "计划金额", "run_id": "r2", "kinds": []},
        {"op": "recall", "query": "毫不相干", "run_id": "r2", "limit": 5}]},
    # 空库 / 查询完全不命中
    {"name": "recall_empty", "ops": [
        {"op": "recall", "query": "任何", "run_id": "r1"},
        {"op": "promote", "item": item("内容"), "reason": "imported", "run_id": "r1"},
        {"op": "recall", "query": "", "run_id": "r1"},
        {"op": "recall", "query": "!!!", "run_id": "r1"}]},
    # 衰减：老记忆掉权重但不删；跌破地板才淘汰；DECISION 豁免
    {"name": "decay_evicts_stale_but_decisions_immune",
     "decay": {"idle_runs_before_decay": 1, "decay_per_run": 0.5, "evict_below": 0.5}, "ops": [
        {"op": "promote", "item": item("旧约定：金额列叫 amt", confidence=0.7,
                                       key="convention:stale"),
         "reason": "imported", "run_id": "r1"},
        {"op": "promote", "item": item("拆成两个属性", "decision", key="decision:keep"),
         "reason": "human_confirmed", "run_id": "r1"},
        {"op": "start_run", "run": "r2"},
        {"op": "start_run", "run": "r3"},
        {"op": "start_run", "run": "r4"},
        {"op": "decay", "run": "r4"},
        {"op": "len"}]},
    # 衰减的浮点算术：降权但活着
    {"name": "decay_lowers_without_evicting", "ops": [
        {"op": "promote", "item": item("会掉分但活着", confidence=0.9, key="convention:a"),
         "reason": "imported", "run_id": "r1"},
        {"op": "start_run", "run": "r2"},
        {"op": "start_run", "run": "r3"},
        {"op": "start_run", "run": "r4"},
        {"op": "start_run", "run": "r5"},
        {"op": "decay", "run": "r5"},
        {"op": "get", "key": "convention:a"},
        {"op": "start_run", "run": "r6"},
        {"op": "decay", "run": "r6"},
        {"op": "get", "key": "convention:a"}]},
    # last_used_run 不在 runs 里（从没被用过）→ idle = now + 1
    {"name": "decay_unknown_last_run", "ops": [
        {"op": "adopt", "items": [item("从没被用过", confidence=0.9, key="convention:x",
                                       last_used_run="没见过的run")]},
        {"op": "start_run", "run": "r1"},
        {"op": "start_run", "run": "r2"},
        {"op": "start_run", "run": "r3"},
        {"op": "decay", "run": "r3"},
        {"op": "get", "key": "convention:x"}]},
    # adopt 不过闸门、不走合并：原样装回来（含参考档）
    {"name": "adopt_bypasses_gate", "ops": [
        {"op": "adopt", "items": [item("a", key="k1"), ref("b", key="k2", support=[])]},
        {"op": "len"},
        {"op": "adopt", "items": [item("覆盖", key="k1")]},
        {"op": "get", "key": "k1"}]},
]

# recall 的排序靠打分。打分本身也单独钉一份 —— 排序出问题时能一眼看出是分数错了
# 还是排序错了。（`math.log1p` 与 `Math.log1p` 理论上可能差 1 ulp，所以 TS 侧对
# 分数用近似断言、对**顺序**用精确断言。）
SCORE_CASES = [
    (item("计划金额口径为含税年度累计", "fact"), "计划金额", None),
    (item("计划金额口径为含税年度累计", "decision"), "计划金额", None),
    (ref("计划金额口径为含税年度累计"), "计划金额", None),
    (ref("计划金额口径为含税年度累计", origin_files=["别的.xlsx"]), "计划金额",
     ["实体梳理.xlsx"]),
    (ref("计划金额口径为含税年度累计", origin_files=["实体梳理.xlsx"]), "计划金额",
     ["实体梳理.xlsx"]),
    (item("apiName 用 lowerCamelCase", tags=["naming", "camel"]), "apiName camel", None),
    (item("apiName 用 lowerCamelCase", use_count=7), "apiName", None),
    (item("apiName 用 lowerCamelCase", confidence=0.2), "apiName", None),
    (item("完全不相干"), "apiName", None),
    (item(""), "apiName", None),
    (item("apiName"), "", None),
    (item("clm_contract 表 order_no 字段"), "order_no", None),
    (item("采购包"), "采购", None),
]


# ══════════════════════════════════════════════════════════════════
#  3. dialogue
# ══════════════════════════════════════════════════════════════════
_TABLE = "| a | b |\n| - | - |\n| 1 | 2 |"
_ANSWER = f"## AI 招聘业务流程梳理表\n{_TABLE}\n\n**计划金额口径说明**\n收尾。"

DIGEST_CASES: list[list[dict[str, Any]]] = [
    [],
    [{"speaker": "user", "text": "含税一律指增值税专用发票口径"}],
    [{"speaker": "user", "text": "  "}],  # 只有空白 → 三样都没有，走兜底那句
    [{"speaker": "assistant", "text": "没有表格的普通回答\n## 小标题\n正文"}],
    [{"speaker": "assistant", "text": _ANSWER}],
    [{"speaker": "user", "text": "第一句\n换行了"},
     {"speaker": "assistant", "text": _ANSWER},
     {"speaker": "system", "text": "已完成梳理，171 个对象", "refs": ["obj:1", "obj:2"]}],
    [{"speaker": "user", "text": "很长的一句话" * 20}],  # [:60] 按码点切
    [{"speaker": "user", "text": f"emoji {'😀' * 80}"}],
    [{"speaker": "user", "text": f"第{i}句"} for i in range(12)],  # said[:8]
    [{"speaker": "assistant", "text": f"### 标题{i}\n{_TABLE}"} for i in range(9)],  # made[:6]
    [{"speaker": "user", "text": "看这些", "refs": [f"obj:{i}" for i in range(20)]}],  # refs[:12]
    [{"speaker": "assistant", "text": f"## **加粗标题**\n{_TABLE}"}],
    [{"speaker": "assistant", "text": f"**只加粗不带井号**\n{_TABLE}"}],
    [{"speaker": "assistant", "text": f"# 一\n## 一\n### 二\n#### 三\n##### 四\n{_TABLE}"}],
    [{"speaker": "assistant", "text": f"## 【带括号的标题】：\n{_TABLE}"}],
    [{"speaker": "assistant", "text": f"## a\n{_TABLE}"}],  # 标题只有 1 个字符 → 丢
    [{"speaker": "assistant", "text": "## 标题\n没有竖线表"}],
]

DIALOGUE_SCENARIOS: list[dict[str, Any]] = [
    # 决定：同类同范围后者推翻前者，作用域不同则并存
    {"name": "decide_supersedes_same_scope", "ops": [
        {"op": "say", "speaker": "user", "text": "临时表都不要"},
        {"op": "decide", "kind": "scope", "statement": "临时表都不要"},
        {"op": "say", "speaker": "user", "text": "但 clmSpaImportTmp 要留"},
        {"op": "decide", "kind": "scope", "statement": "clmSpaImportTmp 要留",
         "scope_refs": ["obj:tmp"]},
        {"op": "decide", "kind": "scope", "statement": "临时表还是都要"},
        {"op": "active_decisions"},
        {"op": "snapshot"}]},
    # scope_refs 顺序不同视为同一范围（sorted 之后比）
    {"name": "decide_scope_order_insensitive", "ops": [
        {"op": "decide", "kind": "naming", "statement": "叫 A", "scope_refs": ["b", "a"]},
        {"op": "decide", "kind": "naming", "statement": "叫 B", "scope_refs": ["a", "b"]},
        {"op": "active_decisions"},
        {"op": "snapshot"}]},
    # 不同 kind 不互相推翻
    {"name": "decide_different_kind_coexist", "ops": [
        {"op": "decide", "kind": "caliber", "statement": "含税"},
        {"op": "decide", "kind": "naming", "statement": "含税"},
        {"op": "active_decisions"}]},
    # 只有口径/命名/范围能晋升；answer/adoption/correction 不能
    {"name": "promotable_only_three_kinds", "ops": [
        {"op": "say", "speaker": "user", "text": "含税一律指增值税专用发票口径"},
        {"op": "decide", "kind": "caliber", "statement": "含税一律指增值税专用发票口径"},
        {"op": "decide", "kind": "naming", "statement": "头表统一用 Header 后缀"},
        {"op": "decide", "kind": "scope", "statement": "临时表都不要"},
        {"op": "decide", "kind": "answer", "statement": "回答了 q1"},
        {"op": "decide", "kind": "adoption", "statement": "采纳了建议 3"},
        {"op": "decide", "kind": "correction", "statement": "纠正了判断"},
        {"op": "promotable", "run_id": "r1"},
        {"op": "render_decisions"}]},
    # 被推翻的决定不进 promotable
    {"name": "promotable_skips_superseded", "ops": [
        {"op": "decide", "kind": "caliber", "statement": "含税"},
        {"op": "decide", "kind": "caliber", "statement": "不含税"},
        {"op": "promotable", "run_id": "r1"}]},
    # refs 过滤：全局决定始终在，带范围的只在命中时出现
    {"name": "active_decisions_ref_filter", "ops": [
        {"op": "decide", "kind": "caliber", "statement": "全局口径"},
        {"op": "decide", "kind": "scope", "statement": "只管 A", "scope_refs": ["a"]},
        {"op": "decide", "kind": "scope", "statement": "只管 B", "scope_refs": ["b"]},
        {"op": "active_decisions", "refs": ["a"]},
        {"op": "active_decisions", "refs": []},
        {"op": "active_decisions", "refs": None},
        {"op": "active_decisions", "kinds": ["scope"]},
        {"op": "active_decisions", "kinds": []},
        {"op": "render_decisions", "refs": ["b"]}]},
    # 压缩：决定不参与压缩，refs 一个不丢
    {"name": "compact_keeps_decisions", "init": {"keep_verbatim": 2}, "ops": [
        {"op": "say", "speaker": "user", "text": "含税一律指增值税专用发票口径"},
        {"op": "decide", "kind": "caliber", "statement": "含税一律指增值税专用发票口径"},
        {"op": "say", "speaker": "assistant", "text": _ANSWER, "refs": ["obj:1"]},
        {"op": "say", "speaker": "user", "text": "第三句", "refs": ["obj:2"]},
        {"op": "say", "speaker": "user", "text": "第四句"},
        {"op": "say", "speaker": "user", "text": "第五句"},
        {"op": "compact"},
        {"op": "snapshot"},
        {"op": "compact"},
        {"op": "active_decisions"},
        {"op": "render_recent", "limit": 3}]},
    # 轮数不够压不动（head <= 1）
    {"name": "compact_refuses_when_too_short", "init": {"keep_verbatim": 8}, "ops": [
        {"op": "say", "speaker": "user", "text": "一"},
        {"op": "say", "speaker": "user", "text": "二"},
        {"op": "compact"},
        {"op": "len"}]},
    # 按预算压到装得下
    {"name": "compact_to_fit", "init": {"budget_tokens": 40, "keep_verbatim": 2}, "ops": [
        {"op": "say", "speaker": "user", "text": "一" * 30},
        {"op": "say", "speaker": "user", "text": "二" * 30},
        {"op": "say", "speaker": "user", "text": "三" * 30},
        {"op": "say", "speaker": "user", "text": "四" * 30},
        {"op": "over_budget"},
        {"op": "compact_to_fit"},
        {"op": "tokens"},
        {"op": "len"}]},
    # render_recent 的 limit=0 是 Python 切片陷阱：给的是**全部**
    {"name": "render_recent_slice_trap", "ops": [
        {"op": "say", "speaker": "user", "text": "一"},
        {"op": "say", "speaker": "assistant", "text": "二"},
        {"op": "say", "speaker": "system", "text": "三"},
        {"op": "render_recent", "limit": 6},
        {"op": "render_recent", "limit": 2},
        {"op": "render_recent", "limit": 0},
        {"op": "render_recent", "limit": -1}]},
    # turn_index 指向"碰巧是最后一轮" —— 这正是 _user_said 要补的洞
    {"name": "turn_index_is_just_the_last_turn", "ops": [
        {"op": "say", "speaker": "user", "text": "你好，这份材料能看吗"},
        {"op": "say", "speaker": "assistant", "text": "推断：金额大概是含税的"},
        {"op": "decide", "kind": "caliber", "statement": "金额一律含税"},
        {"op": "promotable", "run_id": "r1"}]},
    # 空对话
    {"name": "empty", "ops": [
        {"op": "snapshot"}, {"op": "render_decisions"}, {"op": "render_recent", "limit": 6},
        {"op": "promotable", "run_id": "r1"}, {"op": "tokens"}, {"op": "over_budget"}]},
]


def run_dialogue(spec: dict[str, Any]) -> dict[str, Any]:
    dm = DialogueMemory(**spec.get("init", {}))
    results: list[Any] = []
    for op in spec["ops"]:
        k = op["op"]
        if k == "say":
            u = dm.say(op["speaker"], op["text"], intent=op.get("intent", ""),
                       refs=list(op.get("refs") or []))
            results.append(mask_ts(u.to_dict()))
        elif k == "decide":
            d = dm.decide(op["kind"], op["statement"],
                          scope_refs=list(op.get("scope_refs") or []))
            results.append(mask_ts(d.to_dict()))
        elif k == "active_decisions":
            got = dm.active_decisions(
                kinds=None if op.get("kinds") is None
                else tuple(DecisionKind(x) for x in op["kinds"]),
                refs=op["refs"] if "refs" in op else None,
            )
            results.append([d.statement for d in got])
        elif k == "promotable":
            results.append([m.to_dict() for m in dm.promotable(run_id=op["run_id"])])
        elif k == "render_decisions":
            results.append(dm.render_decisions(refs=op.get("refs")))
        elif k == "render_recent":
            results.append(dm.render_recent(limit=op["limit"]))
        elif k == "compact":
            results.append(dm.compact())
        elif k == "compact_to_fit":
            results.append(dm.compact_to_fit(op.get("threshold", 0.7)))
        elif k == "over_budget":
            results.append(dm.over_budget(op.get("threshold", 0.7)))
        elif k == "tokens":
            results.append(dm.tokens)
        elif k == "len":
            results.append(len(dm))
        elif k == "snapshot":
            results.append(mask_ts(dm.to_dict()))
        else:  # pragma: no cover
            raise AssertionError(f"未知算子 {k}")
    return {"spec": spec, "results": results, "final": mask_ts(dm.to_dict())}


DECISION_CASES = [
    {"kind": "caliber", "statement": "含税一律指增值税专用发票口径", "scope_refs": [],
     "turn": 3, "run_id": "r1"},
    {"kind": "naming", "statement": "头表统一用 Header 后缀", "scope_refs": [],
     "turn": 0, "run_id": "r1"},  # NAMING → CONVENTION
    {"kind": "scope", "statement": "临时表都不要",
     "scope_refs": ["a", "b", "c", "d", "e"], "turn": -1, "run_id": ""},
    {"kind": "answer", "statement": "回答 q1", "scope_refs": ["q1"], "turn": 7,
     "run_id": "r9"},
    {"kind": "correction", "statement": "😀 emoji 也要能算 key", "scope_refs": [],
     "turn": 1, "run_id": "r1"},
]

# _user_said：伪造的 quote 必须被拒。这是「参考档洗成权威档」的堵点。
SAID_TURNS = [
    {"speaker": "user", "text": "你好，这份材料能看吗"},
    {"speaker": "assistant", "text": "参考·来自会话《需求澄清》·未确认：计划金额一律按含税年度累计"},
    {"speaker": "user", "text": "那就先看采购包这一块吧。"},
    {"speaker": "system", "text": "已完成梳理，171 个对象"},
]
SAID_CASES = [
    "",  # 空
    "计",  # 归一化后只剩 1 个字符 → 一律拒
    "，。",  # 归一化后为空
    "计划金额一律按含税年度累计",  # ← 模型从 L3 里读到的参考档断言，用户从没说过
    "计划金额",
    "这份材料能看吗",  # 用户真说过
    "这份材料，能看吗？",  # 标点变了，仍算说过
    " 这 份 材 料 能 看 吗 ",  # 空白变了，仍算说过
    "先看采购包",
    "参考·来自会话《需求澄清》·未确认",  # 助手说的不算
    "已完成梳理",  # 系统说的不算
    "你好",
]


# ══════════════════════════════════════════════════════════════════
#  4. project
# ══════════════════════════════════════════════════════════════════
def run_project(spec: dict[str, Any]) -> dict[str, Any]:
    pm = ProjectMemory(spec.get("project_id", "p1"))
    results: list[Any] = []
    for op in spec["ops"]:
        k = op["op"]
        if k == "remember_decision":
            ok, why = pm.remember_decision(build(op["item"]), run_id=op.get("run_id", ""))
            results.append({"ok": ok, "why": why})
        elif k == "observe":
            it = pm.observe(op["content"],
                            kind=MemoryKind(op.get("kind", "lesson")),
                            run_id=op.get("run_id", ""),
                            session_id=op.get("session_id", ""),
                            files=list(op.get("files") or ()),
                            support=list(op.get("support") or ()),
                            confidence=op.get("confidence", 0.5))
            results.append(it.to_dict())
        elif k == "recall":
            got = pm.recall(op["query"], run_id=op.get("run_id", ""),
                            current_files=None if op.get("current_files") is None
                            else set(op["current_files"]),
                            top_k=op.get("top_k", 8))
            results.append([m.key for m in got])
        elif k == "authoritative":
            results.append([m.key for m in pm.authoritative()])
        elif k == "rows":
            results.append(pm.to_rows())
        elif k == "len":
            results.append(len(pm))
        else:  # pragma: no cover
            raise AssertionError(f"未知算子 {k}")
    return {"spec": spec, "results": results, "rows": pm.to_rows()}


PROJECT_SCENARIOS: list[dict[str, Any]] = [
    # 两档，两个入口：人拍板 → 权威；模型推断 → 参考
    {"name": "two_tiers_two_entries", "ops": [
        {"op": "remember_decision",
         "item": item("计划金额拆成含税/不含税两个属性", "decision", key="decision:a"),
         "run_id": "r1"},
        {"op": "observe", "content": "采购包名在 DDL 里叫 pkg_no", "run_id": "r1",
         "session_id": "s7", "files": ["schema.ddl"], "support": ["ev:2"]},
        {"op": "len"},
        {"op": "authoritative"},
        {"op": "rows"}]},
    # 参考档不能改标成权威 —— 升权威只能靠人重新拍板
    {"name": "remember_decision_refuses_reference", "ops": [
        {"op": "remember_decision", "item": ref("我猜金额是含税的"), "run_id": "r1"},
        {"op": "len"}]},
    # observe 借 DECISION 会被改记成 LESSON
    {"name": "observe_downgrades_decision_kind", "ops": [
        {"op": "observe", "content": "金额口径以财务表为准", "kind": "decision",
         "run_id": "r1"},
        {"op": "len"},
        {"op": "authoritative"}]},
    # 参考档撞上权威档：内容不许被顶掉
    {"name": "observe_cannot_overwrite_authoritative", "ops": [
        {"op": "remember_decision",
         "item": item("金额一律含税", "fact", key="fact:x"), "run_id": "r1"},
        {"op": "observe", "content": "金额一律不含税", "kind": "fact", "run_id": "r2",
         "session_id": "s2"},
        {"op": "rows"}]},
    {"name": "observe_confidence_and_files", "ops": [
        {"op": "observe", "content": "含税口径可能来自财务共享中心税率表",
         "run_id": "r1", "session_id": "需求澄清", "files": ["a.xlsx", "b.ddl"],
         "confidence": 0.42},
        {"op": "recall", "query": "含税 口径", "run_id": "r2",
         "current_files": ["c.xlsx"]},
        {"op": "rows"}]},
]

# from_rows：不属于本项目的行直接丢掉（隔离靠实例，mem_key 不含 project）
FROM_ROWS_CASES: list[dict[str, Any]] = [
    {"project_id": "p1", "rows": [
        {"project_id": "p1", "key": "fact:a", "tier": "authoritative", "kind": "fact",
         "content": "本项目金额含税", "confidence": 0.95},
        {"project_id": "p2", "key": "fact:a", "tier": "authoritative", "kind": "fact",
         "content": "另一个项目金额不含税", "confidence": 0.95}]},
    # 缺列的行：走 `or 默认`（注意 confidence 走的是 `.get(k, 0.5)`，判据不同）
    {"project_id": "p1", "rows": [
        {"key": "lesson:b", "kind": "lesson", "content": "没有 project_id 的行算本项目"}]},
    # 空串 / 0 / 空列表全被 `or` 回退
    {"project_id": "p1", "rows": [
        {"project_id": "p1", "key": "term:c", "kind": "term", "content": "c",
         "confidence": 0.0, "support": [], "tags": [], "origin_session": "",
         "origin_files": [], "contested_by": [], "hit_runs": [], "use_count": 0,
         "created_run": "", "last_used_run": "", "tier": ""}]},
    # 装回来的参考档还是参考档 —— 落盘一圈不该把它洗白
    {"project_id": "p1", "rows": [
        {"project_id": "p1", "key": "lesson:d", "tier": "reference", "kind": "lesson",
         "content": "模型猜的", "confidence": 0.5, "origin_session": "s7",
         "origin_files": ["schema.ddl"], "hit_runs": ["r1", "r2", "r3"]}]},
]


# ══════════════════════════════════════════════════════════════════
#  5. context —— 四层装配
# ══════════════════════════════════════════════════════════════════
CHUNKS = [
    {"chunk_id": "c1", "file_id": "f1", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "cell", "sheet": "业务对象实体梳理", "row": 44, "col": 6},
     "render": "clmContract 合同主表 计划金额 planAmount", "order": 0,
     "tags": ["rule"]},
    {"chunk_id": "c2", "file_id": "f1", "file_name": "实体梳理.xlsx",
     "locator": {"kind": "range", "sheet": "业务对象实体梳理", "rows": [45, 47]},
     "render": "计划金额口径：含税年度累计", "order": 1, "tags": []},
    {"chunk_id": "c3", "file_id": "f2", "file_name": "schema.ddl",
     "locator": {"kind": "ddl", "object": "clm_contract"},
     "render": "plan_amount decimal(18,2) -- 不含税单次", "order": 0, "tags": ["fk"]},
]

CONTEXT_SCENARIOS: list[dict[str, Any]] = [
    # 装配顺序即优先级：L0 → L3 → L1 → L2
    {"name": "layers_in_priority_order", "budget": 2000,
     "system": "你是本体建模助手。规范：apiName 用 lowerCamelCase。",
     "memories": [{"op": "promote", "item": item("采购包头统一叫 purchasePackage"),
                   "reason": "human_confirmed", "run_id": "r0"}],
     "chunks": CHUNKS,
     "assemble": {"task": "抽取 ObjectType", "query": "clmContract 计划金额",
                  "working": {"PARSE.xlsx": {"chunks": 169}}, "deps": ["PARSE.*"],
                  "run_id": "r1"}},
    # 证据地板：前三层挤占时削 working，不削证据
    {"name": "evidence_floor_defended", "budget": 900, "system": "系统",
     "memories": [], "chunks": CHUNKS,
     "assemble": {"task": "抽取", "query": "clmContract",
                  "working": {"BIG": {"blob": "填充" * 4000}}, "deps": ["BIG"],
                  "run_id": "r1"}},
    # L3 硬截断：参考档的标注必须活在每条的**前缀**里
    {"name": "reference_annotation_survives_clipping", "budget": 1000, "system": "",
     "memories": [{"op": "note",
                   "item": ref(f"计划金额口径说明{i}", key=f"lesson:{i}",
                               origin_session="上一个会话"), "run_id": "r0"}
                  for i in range(10)],
     "chunks": [],
     "assemble": {"task": "抽取属性", "query": "计划金额口径", "run_id": "r1"}},
    # 跨材料的参考档：降权 + 在 prompt 里标出来，且只标那一条
    {"name": "foreign_material_marked_once", "budget": 4000, "system": "",
     "memories": [
         {"op": "note", "item": ref("计划金额取自本表", key="lesson:near",
                                    origin_session="s1"), "run_id": "r0"},
         {"op": "note", "item": ref("计划金额取自本表", key="lesson:far",
                                    origin_session="s2",
                                    origin_files=["别的项目.xlsx"]), "run_id": "r0"}],
     "chunks": [],
     "assemble": {"task": "抽取", "query": "计划金额", "run_id": "r1",
                  "current_files": ["实体梳理.xlsx"]}},
    # 本轮教训进 L3，和长期召回并列
    {"name": "reflections_reach_later_nodes", "budget": 2000, "system": "系统",
     "memories": [], "chunks": CHUNKS,
     "reflect": ["provenance critic 驳回过无证据断言，本轮所有 baseType 必须带 evidence",
                 "provenance critic 驳回过无证据断言，本轮所有 baseType 必须带 evidence",
                 ""],
     "assemble": {"task": "抽取属性", "run_id": "r1"}},
    # scratchpad 超预算时在装配里被压缩
    {"name": "scratchpad_compacted_during_assembly", "budget": 1200, "system": "系统",
     "memories": [], "chunks": CHUNKS,
     "scratch": {"budget_tokens": 300, "keep_verbatim": 2,
                 "turns": [{"thought": f"想第{i}步", "action": f"search(q{i})",
                            "observation": f"见到 实体梳理.xlsx!业务对象实体梳理!R{40 + i}C6 "
                                           f"的内容" * 3} for i in range(8)]},
     "assemble": {"task": "抽取", "query": "clmContract", "run_id": "r1"}},
    # 冷启动：没有长期库、没有证据、没有 working
    {"name": "cold_start", "budget": 500, "system": "系统提示", "memories": None,
     "chunks": [], "assemble": {"task": "第一次跑", "run_id": ""}},
    # 节点给更紧的预算 + 自定义 shares
    {"name": "tighter_node_budget", "budget": 4000, "system": "系统" * 50,
     "shares": {"system": 0.2, "reflection": 0.2, "working": 0.3,
                "evidence_floor": 0.1},
     "memories": [{"op": "promote", "item": item("采购包头统一叫 purchasePackage"),
                   "reason": "human_confirmed", "run_id": "r0"}],
     "chunks": CHUNKS,
     "assemble": {"task": "抽取", "query": "计划金额", "run_id": "r1",
                  "budget_tokens": 600,
                  "working": {"A": "上游产出 A" * 30, "B": {"k": [1, 2, 3]}},
                  "deps": ["A", "B"], "evidence_top_k": 2}},
    # 前三层的占比之和 > 1：证据地板真的被挤占，这时**削 working、不削证据**。
    # 默认占比 0.12+0.10+0.38 = 0.60 永远走不到这条分支，只有调过 shares 才测得到。
    {"name": "evidence_floor_trims_working_not_evidence", "budget": 2000,
     "system": "系统规范" * 500,
     "shares": {"system": 0.45, "reflection": 0.3, "working": 0.3,
                "evidence_floor": 0.25},
     "memories": [{"op": "promote",
                   "item": item(f"计划金额相关约定第{i}条，口径按财务共享中心税率表",
                                key=f"convention:{i}"),
                   "reason": "human_confirmed", "run_id": "r0"} for i in range(10)],
     "chunks": CHUNKS,
     "reflect": [f"本轮教训第{i}条：所有 baseType 必须带 evidence，且口径要标明"
                 for i in range(20)],
     "assemble": {"task": "抽取", "query": "计划金额", "run_id": "r1",
                  "working": {"BIG": {"blob": "填充" * 2000}}, "deps": ["BIG"]}},
    # scratchpad 压缩发生在**算完上游预算之后** —— 挪到前面，上游能拿到的额度
    # 就变多了，整层随之漂移。要同时有 working 和超预算的 scratch 才测得到。
    {"name": "scratch_compaction_happens_after_upstream_budget", "budget": 3000,
     "system": "系统", "memories": [], "chunks": CHUNKS,
     "scratch": {"budget_tokens": 200, "keep_verbatim": 2,
                 "turns": [{"thought": f"想第{i}步", "action": f"search(q{i})",
                            "observation": f"见到 实体梳理.xlsx!业务对象实体梳理!"
                                           f"R{40 + i}C6 的内容" * 4}
                           for i in range(8)]},
     "assemble": {"task": "抽取", "query": "clmContract 计划金额", "run_id": "r1",
                  "working": {"A": "上游产出甲" * 200, "B": "上游产出乙" * 200},
                  "deps": ["A", "B"]}},
    # 1255 这个预算是挑出来的：1255×0.12=150.6、×0.10=125.5、×0.38=476.9 三个
    # 都带 ≥0.5 的小数。`int()` 是**截断**不是四舍五入，三层的额度各差 1 token，
    # 而三层都刚好被截断在额度上 —— 写成 round 会让三段文本一起漂。
    {"name": "layer_budgets_truncate_not_round", "budget": 1255,
     "system": "系统规范条目" * 60,
     "memories": [{"op": "promote",
                   "item": item(f"计划金额相关约定第{i}条，口径按财务共享中心税率表",
                                key=f"convention:{i}"),
                   "reason": "human_confirmed", "run_id": "r0"} for i in range(12)],
     "chunks": CHUNKS,
     "reflect": [f"本轮教训第{i}条：所有 baseType 必须带 evidence" for i in range(12)],
     "assemble": {"task": "抽取 ObjectType", "query": "计划金额", "run_id": "r1",
                  "working": {"BIG": "上游产出" * 400}, "deps": ["BIG"]}},
    # recall_kinds 只召回指定类型
    {"name": "recall_kinds_filter", "budget": 2000, "system": "",
     "memories": [
         {"op": "promote", "item": item("计划金额拆成两个属性", "decision",
                                        key="decision:a"),
          "reason": "human_confirmed", "run_id": "r0"},
         {"op": "promote", "item": item("计划金额可能含税", "fact", key="fact:b"),
          "reason": "imported", "run_id": "r0"}],
     "chunks": [], "assemble": {"task": "抽取", "query": "计划金额", "run_id": "r1",
                                "recall_kinds": ["decision"]}},
]


def run_context(spec: dict[str, Any]) -> dict[str, Any]:
    lt: LongTermStore | None = None
    if spec.get("memories") is not None:
        lt = LongTermStore("proj")
        for m in spec["memories"]:
            it = build(m["item"])
            if m["op"] == "promote":
                lt.promote(it, PromotionReason(m["reason"]), run_id=m.get("run_id", ""))
            else:
                lt.note(it, run_id=m.get("run_id", ""))

    ix = EvidenceIndex()
    for c in spec["chunks"]:
        ix.add(Chunk(**c))

    shares = LayerShares(**spec["shares"]) if "shares" in spec else LayerShares()
    cm = ContextManager(system=spec.get("system", ""), long_term=lt, evidence=ix,
                        budget_tokens=spec["budget"], shares=shares)
    for lesson in spec.get("reflect", ()):
        cm.reflect(lesson)

    a = dict(spec["assemble"])
    ws = None
    if "working" in a:
        ws = WorkingSet()
        for nid, out in a.pop("working").items():
            ws.put(nid, out)
    pad = None
    if "scratch" in spec:
        s = spec["scratch"]
        pad = Scratchpad(budget_tokens=s["budget_tokens"], keep_verbatim=s["keep_verbatim"])
        for t in s["turns"]:
            pad.append(**t)
    if "current_files" in a:
        a["current_files"] = set(a["current_files"])
    if "recall_kinds" in a:
        a["recall_kinds"] = tuple(MemoryKind(k) for k in a["recall_kinds"])

    ctx = cm.assemble(working=ws, scratch=pad, **a)
    return {
        "spec": spec,
        "text": ctx.text,
        "layers": ctx.layers,
        "tokens": ctx.tokens,
        "chunk_ids": [c.chunk_id for c in ctx.chunks],
        "recalled": [m.key for m in ctx.recalled],
        "compactions": ctx.compactions,
        "dropped": ctx.dropped,
        "stats": ctx.stats(),
        "reflections": cm.reflections,
    }


CLIP_CASES = [
    ("", 10), ("短", 10), ("短", 0), ("短", -1),
    ("一" * 100, 10), ("一" * 100, 1), ("一" * 100, 200),
    ("abcd" * 100, 10), ("abcd" * 100, 3),
    ("尾部有空白   " + "一" * 50, 5),
    ("😀" * 50, 5),  # 星平面：切点必须按码点，不然切出半个代理对
    ("混合 mixed 文本 " * 20, 12),
]

UPSTREAM_CASES: list[tuple[dict[str, Any], int]] = [
    ({}, 1000),
    ({"A": "纯字符串产出"}, 1000),
    ({"A": {"chunks": 169, "名字": "中文"}}, 1000),
    ({"A": "很长" * 500, "B": "也很长" * 500}, 1000),
    ({"A": "x" * 100}, 0),
    ({"A": "x" * 100}, -500),  # budget 会被 scratch.tokens 减成负数：floor 除
    ({"A": [1, 2.5, None, True], "B": {"n": {"m": []}}}, 400),
]


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    out: dict[str, Any] = {}

    out["promotion_reasons"] = [str(x) for x in PromotionReason]
    out["speakers"] = [str(x) for x in Speaker]
    out["decision_kinds"] = [str(x) for x in DecisionKind]
    out["promotable_kinds"] = sorted(str(x) for x in PROMOTABLE)
    out["row_fields"] = list(ROW_FIELDS)
    out["gate_defaults"] = {
        "min_critic_rounds": PromotionGate().min_critic_rounds,
        "min_distinct_runs": PromotionGate().min_distinct_runs,
        "min_confidence": PromotionGate().min_confidence,
        "require_support": PromotionGate().require_support,
    }
    out["decay_defaults"] = {
        "idle_runs_before_decay": DecayPolicy().idle_runs_before_decay,
        "decay_per_run": DecayPolicy().decay_per_run,
        "evict_below": DecayPolicy().evict_below,
        "immune_kinds": sorted(str(k) for k in DecayPolicy().immune_kinds),
    }
    out["layer_shares_defaults"] = {
        "system": LayerShares().system,
        "reflection": LayerShares().reflection,
        "working": LayerShares().working,
        "evidence_floor": LayerShares().evidence_floor,
    }

    rows = []
    for c in GATE_CASES:
        ok, why = PromotionGate(**c["gate"]).check(
            build(c["item"]), PromotionReason(c["reason"]),
            critic_rounds=c["critic_rounds"])
        rows.append({**c, "out": [ok, why]})
    out["gate"] = rows

    out["store"] = [run_store(s) for s in STORE_SCENARIOS]

    out["score"] = [
        {"item": init, "query": q, "current_files": cf,
         "out": LongTermStore("p")._score(build(init), q,
                                          None if cf is None else set(cf))}
        for init, q, cf in SCORE_CASES
    ]

    out["variant_of"] = [
        {"old": item("旧", key="fact:k"), "new": item("新内容"),
         "out": variant_of(build(item("旧", key="fact:k")), build(item("新内容")))},
        {"old": item("旧", key="😀"), "new": item("😀 新"),
         "out": variant_of(build(item("旧", key="😀")), build(item("😀 新")))},
    ]

    out["heuristic_digest"] = [
        {"turns": ts,
         "out": heuristic_digest([Utterance(speaker=Speaker(t["speaker"]),
                                            text=t["text"],
                                            refs=list(t.get("refs") or []))
                                  for t in ts])}
        for ts in DIGEST_CASES
    ]

    out["dialogue"] = [run_dialogue(s) for s in DIALOGUE_SCENARIOS]

    out["decision"] = [
        {"case": c,
         "key": Decision(kind=DecisionKind(c["kind"]), statement=c["statement"],
                         scope_refs=list(c["scope_refs"]),
                         turn_index=c["turn"]).key,
         "render": Decision(kind=DecisionKind(c["kind"]), statement=c["statement"],
                            scope_refs=list(c["scope_refs"]),
                            turn_index=c["turn"]).render(),
         "memory": Decision(kind=DecisionKind(c["kind"]), statement=c["statement"],
                            scope_refs=list(c["scope_refs"]),
                            turn_index=c["turn"]).to_memory(
                                run_id=c["run_id"]).to_dict()}
        for c in DECISION_CASES
    ]

    said_dm = DialogueMemory()
    for t in SAID_TURNS:
        said_dm.say(t["speaker"], t["text"])
    out["user_said"] = {
        "turns": SAID_TURNS,
        "cases": [{"quote": q, "norm": _norm_quote(q), "out": _user_said(said_dm, q)}
                  for q in SAID_CASES],
    }

    # save/load：跨会话活下来的那条路。`load` 对 from_dict **没有异常兜底**，
    # 老 mem.json 里又没有 tier / origin_* 三个字段 —— 少一个默认值就是一读就崩。
    import tempfile

    save_rows = []
    for spec in (STORE_SCENARIOS[3], STORE_SCENARIOS[6]):  # 加固 / 人拍板覆盖
        st = LongTermStore(spec.get("project", "proj"))
        for op in spec["ops"]:
            if op["op"] == "promote":
                st.promote(build(op["item"]), PromotionReason(op["reason"]),
                           run_id=op.get("run_id", ""))
            elif op["op"] == "note":
                st.note(build(op["item"]), run_id=op.get("run_id", ""))
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "嵌套/目录/mem.json"  # save 要自己建父目录
            st.save(p)
            text = p.read_text(encoding="utf-8")
            reloaded = LongTermStore.load(p).to_dict()
        save_rows.append({"name": spec["name"], "text": text, "reloaded": reloaded})
    out["store_save"] = save_rows

    legacy = {"project": "proj", "runs": ["r1"], "items": [{
        "key": "convention:x", "kind": "convention", "scope": "project",
        "content": "apiName 用 lowerCamelCase", "confidence": 0.9, "support": ["ev:1"],
        "tags": [], "meta": {}, "created_run": "r1", "last_used_run": "r1",
        "use_count": 2, "hit_runs": ["r1"], "contested_by": []}]}
    load_rows = []
    for raw in (legacy, {"project": "空库"}, {"project": "p", "runs": [], "items": []}):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "mem.json"
            p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            st = LongTermStore.load(p)
        load_rows.append({"in": raw, "out": st.to_dict()})
    out["store_load"] = load_rows

    # DialogueMemory.from_dict：active 靠 superseded_by 还原，不存 active 字段
    dlg_raw = [
        {},
        {"turns": [{"speaker": "user", "text": "一"}], "decisions": [], "compactions": 0},
        {"turns": [{"speaker": "assistant", "text": "二", "ts": 1.5, "intent": "答疑",
                    "refs": ["obj:1"], "compressed": True},
                   {"speaker": "system", "text": "三", "ts": 2.0}],
         "decisions": [
             {"key": "忽略这个键", "kind": "caliber", "statement": "含税", "turn": 0,
              "ts": 3.0, "active": True, "superseded_by": 1, "scope_refs": ["a"]},
             {"kind": "caliber", "statement": "不含税", "turn": 1, "ts": 4.0}],
         "compactions": 2},
        # 少字段的老数据
        {"turns": [{"speaker": "user", "text": "只有必填"}],
         "decisions": [{"kind": "naming", "statement": "只有必填"}]},
    ]
    out["dialogue_from_dict"] = [
        {"in": raw,
         "out": mask_ts(DialogueMemory.from_dict(dict(raw)).to_dict()),
         "active": [d.statement for d in DialogueMemory.from_dict(dict(raw))
                    .active_decisions()]}
        for raw in dlg_raw
    ]

    out["project"] = [run_project(s) for s in PROJECT_SCENARIOS]
    out["from_rows"] = [
        {"project_id": c["project_id"], "rows": c["rows"],
         "out": ProjectMemory.from_rows(c["project_id"], list(c["rows"])).to_rows()}
        for c in FROM_ROWS_CASES
    ]

    out["clip"] = [{"in": t, "max_tokens": n, "out": _clip(t, n)} for t, n in CLIP_CASES]
    out["render_upstream"] = [
        {"upstream": u, "budget": b, "out": _render_upstream(dict(u), b)}
        for u, b in UPSTREAM_CASES
    ]
    out["context"] = [run_context(s) for s in CONTEXT_SCENARIOS]

    p = OUT / "memory.long_term.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  memory.long_term.json  {p.stat().st_size} B")


if __name__ == "__main__":
    main()
