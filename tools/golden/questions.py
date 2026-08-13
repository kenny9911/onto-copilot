"""导出 onto/questions.py 的 golden —— 给 TS 侧 ts/src/onto/questions.ts 当安全网。

这个模块决定**交付给顾问的那份问题清单长什么样、按什么顺序排**。排序基准
（`next_batch` 的四元组、`to_dict` 的 `(created_at, id)`）一漂，清单顺序就变了，
而顺序变了没人看得出来 —— 只有对着 golden 逐条比才拦得住。

被钉住的分叉：

  1. ``time.time()`` 是**秒**。TS 侧写成 ``Date.now()`` 会差三个数量级，
     而 created_at 是两处排序的键。导出时把 ``time`` 换成常量时钟。
  2. Python ``sorted`` 按 **code point**，JS 默认按 UTF-16 code unit ——
     ``sorted(affected_ids)`` 进指纹、``next_batch`` 的末位 tie-break 是 id。
  3. ``str()`` / ``repr()`` 的形态：校验失败的消息里有 ``{kinds}``（list 的 str）
     和 ``{const!r}``，这些串会原样返回给调用方。
  4. ``len(str)`` 是 code point 数 —— ``minLength`` / ``maxLength`` 校验的是字数。
  5. Python 分得清 ``int`` 与 ``float``，JS 分不清：``{"type":"integer"}`` 对
     ``3.0`` 在 Python 侧是**拒绝**，JS 侧无法复现。单列在 ``validate_divergent``。

跑法::

    .venv/bin/python tools/golden/questions.py

产物 golden/questions.json。**字节确定**：时钟被钉死，其余输入全是字面量。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto import questions as Q  # noqa: E402


class _FrozenClock:
    """`_now()` 走的是 `time.time()`，而 `time` 是模块全局、调用时才解析 ——
    换掉它就能把 dataclass 的 default_factory 一起冻住。"""

    @staticmethod
    def time() -> float:
        return 1_700_000_000.0


Q.time = _FrozenClock()  # type: ignore[assignment]
NOW = 1_700_000_000.0

OUT = ROOT / "golden"


def err(fn: Any) -> dict[str, Any]:
    """跑一个可能抛的调用，把"抛没抛、抛的什么"钉下来。"""
    try:
        return {"ok": True, "value": fn()}
    except Exception as e:  # noqa: BLE001 —— 这里就是要把异常形态记下来
        return {"ok": False, "error": type(e).__name__, "message": str(e)}


def base_question(qid: str = "q.threshold", **kw: Any) -> Q.Question:
    """与 tests/test_question_domain.py 的 `_question` 同形。"""
    base: dict[str, Any] = {
        "id": qid,
        "text": "金额正好等于50万元时是否需要总监审批？",
        "answer_schema": {"type": "boolean"},
        "priority": Q.QuestionPriority.BLOCKING,
        "blocked_artifacts": ["rule.approval", "flow.gateway.approval"],
        "created_at": 100.0,
        "updated_at": 100.0,
    }
    return Q.Question(**{**base, **kw})


# ══════════════════════════════════════════════════════════════════
#  1. Question.from_dict —— 兼容层的每一条取值规则
# ══════════════════════════════════════════════════════════════════
FROM_DICT_CASES: list[tuple[str, dict[str, Any]]] = [
    ("最小输入：只有 text，id 由内容摘要导出", {"text": "提前多少天预警？"}),
    ("id 优先于 rid", {"id": "q1", "rid": "oq_1", "text": "x"}),
    ("rid 存在即认定为 open_question 来源", {"rid": "oq_1", "text": "x"}),
    ("conflict_rid 存在即认定为 conflict 来源",
     {"conflict_rid": "cf_1", "title": "审批边界不明确",
      "options": [{"id": "include", "label": "包含50万"}], "impact_count": 4, "score": 0.8}),
    ("conflict 的 options 变成 enum 型 answerSchema",
     {"conflictRid": "cf_2", "summary": "口径冲突", "options": ["a", {"id": "b"}, {"x": 1}]}),
    ("open_question 的 options 不变成 enum",
     {"rid": "oq_2", "text": "x", "options": ["甲", "乙"]}),
    ("text 是 Assertion 字典时取 value",
     {"rid": "oq_3", "text": {"value": "更新后的文案", "origin": "extracted"}}),
    ("text 显式为 None 时不回落到 title", {"text": None, "title": "标题不该被用上"}),
    ("没有 text 时回落 title", {"title": "标题"}),
    ("没有 text/title 时回落 summary", {"summary": "摘要"}),
    ("evidence id 从 text.evidence 里捞（先 id、再 cite、再 file_id）",
     {"rid": "oq_4", "text": {"value": "x", "evidence": [
         {"id": "ev1"}, {"cite": "材料.xlsx!表!R1-1"}, {"file_id": "f9"}, {"nothing": 1},
         "不是字典"]}}),
    ("显式 evidenceIds 优先于 text.evidence",
     {"rid": "oq_5", "text": {"value": "x", "evidence": [{"id": "ev1"}]},
      "evidenceIds": ["显式的"]}),
    ("answer 非空即视为已回答", {"rid": "oq_6", "text": "x", "answer": "是"}),
    ("answer 是 Assertion 字典同样算",
     {"rid": "oq_7", "text": "x", "answer": {"value": "是"}}),
    ("answer 为 0 也算已回答（Python 的 not in (None,'',[],{}) 判据）",
     {"rid": "oq_8", "text": "x", "answer": 0}),
    ("answer 为 False 也算已回答", {"rid": "oq_9", "text": "x", "answer": False}),
    ("answer 为空列表不算", {"rid": "oq_10", "text": "x", "answer": []}),
    ("answer 为空字典不算", {"rid": "oq_11", "text": "x", "answer": {}}),
    ("status=candidate 映射成 open", {"rid": "oq_12", "text": "x", "status": "candidate"}),
    ("status=confirmed 映射成 answered", {"rid": "oq_13", "text": "x", "status": "confirmed"}),
    ("status=rejected 映射成 cancelled", {"rid": "oq_14", "text": "x", "status": "rejected"}),
    ("status 大写解析不了 —— 回落 open", {"rid": "oq_15", "text": "x", "status": "OPEN"}),
    ("status 认不出来 —— 回落 open", {"rid": "oq_16", "text": "x", "status": "不认识"}),
    ("没有 status 但有 owner —— 推断成 assigned",
     {"rid": "oq_17", "text": "x", "owner": "erp.consultant"}),
    ("显式 status=open + owner —— 必须原样保留 open",
     {"id": "q_17b", "text": "x", "status": "open", "ownerUserId": "u1"}),
    ("open_question + owner + candidate —— 解释成 assigned",
     {"rid": "oq_18", "text": "x", "status": "candidate", "owner": "u1"}),
    ("blockedArtifacts 非空即 blocking 优先级",
     {"id": "q19", "text": "x", "blockedArtifacts": ["a"]}),
    ("显式 priority 认不出来 —— 回落 normal", {"id": "q20", "text": "x", "priority": "紧急"}),
    ("priority 大小写不敏感", {"id": "q21", "text": "x", "priority": "HIGH"}),
    ("snake_case 别名全都认",
     {"id": "q22", "text": "x", "answer_schema": {"type": "number"},
      "audience_role": "erp", "blocked_artifacts": ["a1"], "evidence_ids": ["e1"],
      "scope_refs": ["s1"], "created_at": 1.5, "updated_at": 2.5}),
    ("appliesTo 作为 scopeRefs 的第三顺位",
     {"rid": "oq_23", "text": "x", "appliesTo": ["ot_a", "ot_b"]}),
    ("informationGain 回落 score、blastRadius 回落 impact_count",
     {"id": "q24", "text": "x", "score": 0.8, "impact_count": 4}),
    ("缺 createdAt/updatedAt 时落到当前时间", {"id": "q25", "text": "x"}),
]


def export_from_dict() -> list[dict[str, Any]]:
    out = []
    for name, raw in FROM_DICT_CASES:
        q = Q.Question.from_dict(raw)
        out.append({"name": name, "raw": raw, "question": q.to_dict(),
                    # 再往返一次 —— 统一契约的字典必须能原样回来
                    "round_trip": Q.Question.from_dict(q.to_dict()).to_dict()})
    return out


def export_round_trip() -> dict[str, Any]:
    q = base_question(owner_user_id="user.chen", audience_role="business_owner",
                      dependencies=["q.amount_basis"], evidence_ids=["ev.221"])
    return {"question": q.to_dict(),
            "round_trip": Q.Question.from_dict(q.to_dict()).to_dict()}


def export_from_legacy() -> list[dict[str, Any]]:
    """OIR 的 OpenQuestion 走 `to_dict()` 那条路 —— TS 侧没有方法可 duck-type，
    这几条钉的就是"按形状识别出来之后必须与 Python 同结果"。"""
    from ontocopilot.onto.oir import OpenQuestion, Provenance, extracted, inferred

    p = Provenance("f1", "材料.xlsx", {"kind": "cell", "sheet": "问卷", "row": 3, "col": "B"},
                   snippet="集采和普通采购怎么分？", extractor="rule", confidence=1.0)
    rows = [
        ("带证据与选项的客户问卷条目",
         OpenQuestion(rid="oq_own", text=extracted("集采和普通采购怎么分？", p),
                      options=["全线下", "系统里编"], group="（1）编制集采计划",
                      code="3", owner="erp.consultant", asked_by="customer")),
        ("系统自挖、无 owner",
         OpenQuestion(rid="oq_sys", text=inferred("这条规则管的是哪个单据？"),
                      asked_by="system", applies_to=["ot_a"])),
        ("已经有答复的条目",
         OpenQuestion(rid="oq_answered", text=inferred("要不要留痕？"),
                      answer=inferred("要"))),
    ]
    out = []
    for name, oq in rows:
        payload = oq.to_dict()
        out.append({"name": name, "open_question": payload,
                    "question": Q.Question.from_legacy(oq).to_dict()})
    return out


def export_from_legacy_errors() -> list[dict[str, Any]]:
    return [
        {"input": "一个字符串", "result": err(lambda: Q.Question.from_legacy("x"))},
        {"input": "一个列表", "result": err(lambda: Q.Question.from_legacy([1, 2]))},
        {"input": "None", "result": err(lambda: Q.Question.from_legacy(None))},
        {"input": "一个整数", "result": err(lambda: Q.Question.from_legacy(7))},
    ]


# ══════════════════════════════════════════════════════════════════
#  2. 状态机
# ══════════════════════════════════════════════════════════════════
def export_transitions() -> list[dict[str, Any]]:
    out = []
    states = [s.value for s in Q.QuestionStatus]
    for src in states:
        for dst in [*states, "不存在的状态"]:
            for owner in ("", "u1"):
                q = base_question(status=Q.QuestionStatus(src), owner_user_id=owner)
                r = err(lambda q=q, dst=dst: q.transition(dst, now=200.0))
                out.append({"from": src, "to": dst, "owner": owner, "result": r,
                            "after": {"status": str(q.status), "updated_at": q.updated_at,
                                      "version": q.version}})
    return out


def export_assign() -> list[dict[str, Any]]:
    out = []

    q1 = base_question()
    r1 = err(lambda: q1.assign("u1", audience_role="process_owner", now=101.0))
    out.append({"name": "open → assigned", "result": r1, "after": q1.to_dict()})

    q2 = base_question(status=Q.QuestionStatus.ASSIGNED, owner_user_id="u1")
    r2 = err(lambda: q2.assign("u2", now=102.0))
    out.append({"name": "已 assigned 再分派只加 version", "result": r2, "after": q2.to_dict()})

    q3 = base_question()
    out.append({"name": "空 owner 被拒", "result": err(lambda: q3.assign("   ")),
                "after": q3.to_dict()})

    q4 = base_question(status=Q.QuestionStatus.ANSWERED)
    out.append({"name": "终态问题不能直接分派", "result": err(lambda: q4.assign("u1")),
                "after": q4.to_dict()})

    q5 = base_question()
    r5 = err(lambda: q5.assign("  u1  ", audience_role="  erp  ", now=103.0))
    out.append({"name": "owner 与 role 两头去空白", "result": r5, "after": q5.to_dict()})

    q6 = base_question(audience_role="旧角色")
    r6 = err(lambda: q6.assign("u1", now=104.0))
    out.append({"name": "不传 audience_role 就不动它", "result": r6, "after": q6.to_dict()})
    return out


# ══════════════════════════════════════════════════════════════════
#  3. Backlog：排序、统计、lifecycle
# ══════════════════════════════════════════════════════════════════
def export_next_batch() -> list[dict[str, Any]]:
    out = []

    bag = Q.QuestionBacklog()
    bag.add(base_question("q.root", status=Q.QuestionStatus.ANSWERED))
    bag.add(base_question("q.ready", dependencies=["q.root"], audience_role="business_owner",
                          information_gain=0.8, blast_radius=4))
    bag.add(base_question("q.blocked", dependencies=["q.missing"],
                          audience_role="business_owner"))
    bag.add(base_question("q.erp", priority=Q.QuestionPriority.HIGH,
                          audience_role="erp_consultant", blocked_artifacts=[]))
    out.append({"name": "依赖 / 角色 / 优先级三重过滤",
                "batch": [q.id for q in bag.next_batch(limit=5,
                                                       audience_role="business_owner")],
                "all": [q.id for q in bag.next_batch(limit=10)],
                "stats": bag.stats()})

    # 优先级权重：blocking(4) > high(3) > normal(2) > low(1)
    bag2 = Q.QuestionBacklog()
    for pid, pri in (("q.low", "low"), ("q.normal", "normal"),
                     ("q.high", "high"), ("q.blocking", "blocking")):
        bag2.add(base_question(pid, priority=Q.QuestionPriority(pri), blocked_artifacts=[]))
    out.append({"name": "按优先级权重排", "batch": [q.id for q in bag2.next_batch(limit=10)]})

    # 第二位：-(information_gain * max(1, blast_radius))；blast_radius=0 时按 1 算
    bag3 = Q.QuestionBacklog()
    for qid, gain, blast in (("q.a", 0.5, 0), ("q.b", 0.5, 3), ("q.c", 0.9, 1),
                             ("q.d", 0.0, 100)):
        bag3.add(base_question(qid, information_gain=gain, blast_radius=blast,
                               blocked_artifacts=[]))
    out.append({"name": "信息增益 × 影响半径", "batch": [q.id for q in bag3.next_batch(limit=10)]})

    # 末两位：created_at，然后 id 的 **code point** 序
    bag4 = Q.QuestionBacklog()
    for qid, created in (("q.晚", 10.0), ("q.早", 5.0), ("Zz", 5.0), ("q.😀", 5.0),
                         ("q.￿", 5.0)):
        bag4.add(base_question(qid, created_at=created, updated_at=created,
                               blocked_artifacts=[]))
    out.append({"name": "created_at 然后 id 按 code point",
                "batch": [q.id for q in bag4.next_batch(limit=10)],
                "to_dict_order": [q["id"] for q in bag4.to_dict()["questions"]]})

    # owner 过滤：没有 owner 的一律放行
    bag5 = Q.QuestionBacklog()
    bag5.add(base_question("q.mine", owner_user_id="u1"))
    bag5.add(base_question("q.hers", owner_user_id="u2"))
    bag5.add(base_question("q.free"))
    out.append({"name": "owner 过滤放行无主问题",
                "batch": [q.id for q in bag5.next_batch(limit=10, owner_user_id="u1")]})

    out.append({"name": "limit=0 与负数", "zero": [q.id for q in bag5.next_batch(limit=0)],
                "negative": [q.id for q in bag5.next_batch(limit=-3)]})
    return out


def export_backlog_lifecycle() -> dict[str, Any]:
    existing = Q.QuestionBacklog({"oq_1": Q.Question(
        id="oq_1", text="旧文案", status=Q.QuestionStatus.DEFERRED,
        owner_user_id="u1", audience_role="旧角色", created_at=10.0, updated_at=20.0,
        version=3)})
    rebuilt = Q.build_question_backlog(
        open_questions=[{"rid": "oq_1", "text": {"value": "更新后的文案"}}],
        existing=existing)
    fresh = Q.QuestionBacklog()
    fresh.add(Q.Question(id="oq_1", text="不保留 lifecycle", status=Q.QuestionStatus.OPEN,
                         created_at=1.0, updated_at=1.0), preserve_lifecycle=False)
    return {"preserved": rebuilt.to_dict(), "not_preserved": fresh.to_dict()}


def export_build_backlog() -> dict[str, Any]:
    from ontocopilot.onto.oir import OpenQuestion, inferred

    legacy = OpenQuestion(rid="oq_1", text=inferred("提前多少天预警？"),
                          options=["3", "5"], owner="erp.consultant")
    card = {"id": "q_cf1", "conflict_rid": "cf_1", "title": "审批边界不明确",
            "options": [{"id": "include", "label": "包含50万"}],
            "impact_count": 4, "score": 0.8}
    conflicts = [
        {"rid": "cf_1", "summary": "已被 clarification 覆盖", "handling": "ask_user"},
        {"rid": "cf_2", "summary": "没被覆盖的 ask_user", "handling": "ask_user"},
        {"rid": "cf_3", "summary": "auto_repair 的不问", "handling": "auto_repair"},
        {"id": "cf_4", "title": "没有 handling 字段的照样问"},
    ]
    bag = Q.build_question_backlog(open_questions=[legacy], clarification_questions=[card],
                                   conflicts=conflicts)
    return {"open_question": legacy.to_dict(), "card": card, "conflicts": conflicts,
            "backlog": bag.to_dict()}


# ══════════════════════════════════════════════════════════════════
#  4. Decision / Ledger
# ══════════════════════════════════════════════════════════════════
def _dec(**kw: Any) -> Q.Decision:
    base: dict[str, Any] = {"id": "", "question_id": "q1", "answer": True, "actor": "u1",
                            "created_at": 500.0}
    return Q.Decision(**{**base, **kw})


def export_decisions() -> dict[str, Any]:
    d = _dec(id="dec.1", actor_role="business_owner", authority="process_owner",
             affected_ids=["z.artifact", "a.artifact", "😀", "￿"],
             rationale="按 2026 年新制度")
    ledger = Q.DecisionLedger()

    first = _dec(idempotency_key="k1")
    r1 = ledger.record(first)
    # 同键同内容 —— 返回原记录，不新建
    r2 = ledger.record(_dec(idempotency_key="k1"))
    # 同键不同内容 —— 冲突
    conflict = err(lambda: ledger.record(_dec(answer=False, idempotency_key="k1")))
    # 新答案 supersede 旧的
    r3 = ledger.record(_dec(answer=False, idempotency_key="k2"))
    # 与当前 active 完全一致 —— 也不新建
    r4 = ledger.record(_dec(answer=False, idempotency_key="k3"))

    dup_id = err(lambda: Q.DecisionLedger([_dec(id="x"), _dec(id="x", answer=False)]))
    dup_key = err(lambda: Q.DecisionLedger(
        [_dec(id="a", idempotency_key="k"), _dec(id="b", idempotency_key="k")]))

    return {
        "semantic_payload": d.semantic_payload(),
        "fingerprint": d.fingerprint,
        "to_dict": d.to_dict(),
        "from_dict_round_trip": Q.Decision.from_dict(d.to_dict()).to_dict(),
        "records": [
            {"name": "首次记录", "id": r1[0].id, "created": r1[1]},
            {"name": "同幂等键同内容", "id": r2[0].id, "created": r2[1]},
            {"name": "同幂等键不同内容", "result": conflict},
            {"name": "新答案 supersede 旧的", "id": r3[0].id, "created": r3[1],
             "supersedes": r3[0].supersedes},
            {"name": "与 active 完全一致", "id": r4[0].id, "created": r4[1]},
        ],
        "ledger": ledger.to_dict(),
        "active_for_q1": ledger.active_for("q1").id,
        "active_for_missing": ledger.active_for("没有这个问题"),
        "ledger_round_trip": Q.DecisionLedger.from_dict(ledger.to_dict()).to_dict(),
        "ledger_from_list": Q.DecisionLedger.from_dict(
            ledger.to_dict()["decisions"]).to_dict(),
        "duplicate_id": dup_id,
        "duplicate_key": dup_key,
    }


def export_decision_from_dict() -> list[dict[str, Any]]:
    rows: list[tuple[str, dict[str, Any]]] = [
        ("最小输入：id 由语义摘要导出", {"question_id": "q1", "answer": "是"}),
        ("target_rid 是 questionId 的第三顺位", {"target_rid": "q9", "answer": "是"}),
        ("answer 回落 option_id", {"questionId": "q1", "option_id": "include"}),
        ("answer 回落 statement", {"questionId": "q1", "statement": "金额含 50 万"}),
        ("显式 answer=None 不回落 option_id",
         {"questionId": "q1", "answer": None, "option_id": "include"}),
        ("changed 是 affectedIds 的第三顺位",
         {"questionId": "q1", "answer": 1, "changed": ["a", "b"]}),
        ("ts 是 createdAt 的第二顺位", {"questionId": "q1", "answer": 1, "ts": 42.5}),
        ("note 是 rationale 的第二顺位", {"questionId": "q1", "answer": 1, "note": "顺手"}),
    ]
    return [{"name": n, "raw": raw, "decision": Q.Decision.from_dict(raw).to_dict()}
            for n, raw in rows]


def export_answer_question() -> dict[str, Any]:
    bag = Q.QuestionBacklog({"q.threshold": base_question()})
    ledger = Q.DecisionLedger()
    bad = err(lambda: Q.answer_question(bag, ledger, "q.threshold", "是", actor="u1",
                                        idempotency_key="answer-1"))
    first = Q.answer_question(bag, ledger, "q.threshold", True, actor="u1",
                              actor_role="business_owner", authority="process_owner",
                              idempotency_key="answer-1", revision=13, now=110.0)
    again = Q.answer_question(bag, ledger, "q.threshold", True, actor="u1",
                              actor_role="business_owner", authority="process_owner",
                              idempotency_key="answer-1", revision=13, now=111.0)
    no_key = err(lambda: Q.answer_question(bag, ledger, "q.threshold", True, actor="u1",
                                           idempotency_key="   "))
    missing = err(lambda: Q.answer_question(bag, ledger, "没有这个问题", True, actor="u1",
                                            idempotency_key="k"))

    # 新答案 supersede 旧的，历史不删
    bag.transition("q.threshold", Q.QuestionStatus.OPEN, now=112.0)
    new = Q.answer_question(bag, ledger, "q.threshold", False, actor="u1",
                            idempotency_key="answer-2", now=113.0)
    return {
        "schema_rejected": bad,
        "first": {"decision": first[0].to_dict(), "created": first[1]},
        "again": {"decision": again[0].to_dict(), "created": again[1]},
        "missing_key": no_key,
        "missing_question": missing,
        "superseding": {"decision": new[0].to_dict(), "created": new[1]},
        "ledger": ledger.to_dict(),
        "backlog": bag.to_dict(),
    }


# ══════════════════════════════════════════════════════════════════
#  5. Patch / Revision
# ══════════════════════════════════════════════════════════════════
def export_patch() -> dict[str, Any]:
    ops = [
        Q.PatchOp("replace", "/rules/rule.approval/expression", "amount >= 500000",
                  target_ids=("rule.approval",)),
        Q.PatchOp("remove", "/rules/rule.old"),
        Q.PatchOp("move", "/rules/b", None, "/rules/a"),
    ]
    patch = Q.PatchSet(id="patch.13", base_revision=12, ops=ops,
                       affected_ids=["z.rule", "a.rule"], blocked_artifacts=["flow.approval"],
                       idempotency_key="edit-12-a", actor="u1", created_at=600.0)
    rev = Q.Revision("rev.13", 13, "rev.12", "answer", Q.RevisionStatus.APPLIED,
                     patch_set=patch, changed_ids=["rule.approval"], actor="u1",
                     created_at=601.0)
    return {
        "ops": [op.to_dict() for op in ops],
        "ops_round_trip": [Q.PatchOp.from_dict(op.to_dict()).to_dict() for op in ops],
        "op_errors": [
            {"name": "不支持的 op", "result": err(lambda: Q.PatchOp("upsert", "/a"))},
            {"name": "path 不是 JSON Pointer",
             "result": err(lambda: Q.PatchOp("add", "rules/a"))},
            {"name": "move 缺 from_path", "result": err(lambda: Q.PatchOp("move", "/b"))},
            {"name": "copy 的 from_path 不是 Pointer",
             "result": err(lambda: Q.PatchOp("copy", "/b", None, "a"))},
        ],
        "patch": patch.to_dict(),
        "patch_round_trip": Q.PatchSet.from_dict(patch.to_dict()).to_dict(),
        "require_base_ok": err(lambda: patch.require_base(12)),
        "require_base_conflict": err(lambda: patch.require_base(13)),
        "patch_id_from_ops": Q.PatchSet.from_dict(
            {"baseRevision": 1, "ops": [{"op": "add", "path": "/a", "value": 1}]}).to_dict(),
        "revision": rev.to_dict(),
        "revision_round_trip": Q.Revision.from_dict(rev.to_dict()).to_dict(),
        "revision_minimal": Q.Revision.from_dict({"id": "rev.1"}).to_dict(),
        "revision_bad_status": err(
            lambda: Q.Revision.from_dict({"id": "r", "status": "不认识"})),
    }


# ══════════════════════════════════════════════════════════════════
#  6. 回答校验
# ══════════════════════════════════════════════════════════════════
VALIDATE_CASES: list[tuple[str, dict[str, Any], Any]] = [
    ("空 schema 放行一切", {}, {"随便": 1}),
    ("boolean 收 True", {"type": "boolean"}, True),
    ("boolean 拒字符串", {"type": "boolean"}, "是"),
    ("string 收字符串", {"type": "string"}, "是"),
    ("number 收整数", {"type": "number"}, 5),
    ("number 拒布尔", {"type": "number"}, True),
    ("integer 拒布尔", {"type": "integer"}, True),
    ("integer 收整数", {"type": "integer"}, 5),
    ("null 收 None", {"type": "null"}, None),
    ("联合类型：string 或 null", {"type": ["string", "null"]}, None),
    ("未知类型名一律放行", {"type": "geometry"}, 1),
    ("array 收列表", {"type": "array"}, [1, 2]),
    ("object 收字典", {"type": "object"}, {"a": 1}),
    ("object 拒列表", {"type": "object"}, [1]),
    ("const 命中", {"const": 5}, 5),
    ("const 不命中（数）", {"const": 5}, 6),
    ("const 不命中（字符串）", {"const": "包含"}, "不包含"),
    ("const 不命中（None）", {"const": None}, 1),
    ("enum 命中", {"type": "string", "enum": ["a", "b"]}, "a"),
    ("enum 不命中", {"type": "string", "enum": ["a", "b"]}, "c"),
    ("enum 里带引号的取值（repr 的引号规则）",
     {"enum": ["它说'好'", '他说"行"']}, "别的"),
    ("minLength 按 code point 数：中文+emoji 共 4 个字",
     {"type": "string", "minLength": 5}, "中文😀啊"),
    ("minLength 刚好够", {"type": "string", "minLength": 4}, "中文😀啊"),
    ("maxLength 超了", {"type": "string", "maxLength": 3}, "中文😀啊"),
    ("minimum 不足", {"type": "number", "minimum": 500000}, 400000),
    ("maximum 超了", {"type": "number", "maximum": 10}, 11),
    ("minimum 刚好", {"type": "number", "minimum": 10}, 10),
    ("items 逐项校验，路径带下标",
     {"type": "array", "items": {"type": "string"}}, ["a", 2]),
    ("required 缺字段", {"type": "object", "required": ["a", "b"]}, {"a": 1}),
    ("properties 递归校验，路径带点",
     {"type": "object", "properties": {"amount": {"type": "number", "minimum": 1}}},
     {"amount": 0}),
    ("properties 里没出现的键不校验",
     {"type": "object", "properties": {"a": {"type": "number"}}}, {"b": "随便"}),
    ("嵌套：数组里的对象",
     {"type": "array", "items": {"type": "object", "required": ["id"]}},
     [{"id": 1}, {"name": "x"}]),
]

#: 这几条 Python 与 JS 必然不同 —— JS 里 `3.0` 与 `3` 是同一个值。
#: 不跳过，钉住两边各自的形状。
VALIDATE_DIVERGENT: list[tuple[str, dict[str, Any], Any, str]] = [
    ("integer 拒 3.0（JS 无法复现：3.0 就是 3）", {"type": "integer"}, 3.0, "ok"),
    ("integer 拒 2.5（JS 侧同样拒）", {"type": "integer"}, 2.5, "error"),
]


def export_validate() -> dict[str, Any]:
    rows = []
    for name, schema, value in VALIDATE_CASES:
        rows.append({"name": name, "schema": schema, "value": value,
                     "result": err(lambda s=schema, v=value: Q._validate_answer(
                         v, s, path="$answer"))})
    div = []
    for name, schema, value, js in VALIDATE_DIVERGENT:
        div.append({"name": name, "schema": schema, "value": value, "js": js,
                    "result": err(lambda s=schema, v=value: Q._validate_answer(
                        v, s, path="$answer"))})
    return {"cases": rows, "divergent": div}


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    data = {
        "schema_version": Q.SCHEMA_VERSION,
        "now": NOW,
        "statuses": [s.value for s in Q.QuestionStatus],
        "priorities": [p.value for p in Q.QuestionPriority],
        "revision_statuses": [s.value for s in Q.RevisionStatus],
        "round_trip": export_round_trip(),
        "from_dict": export_from_dict(),
        "from_legacy": export_from_legacy(),
        "from_legacy_errors": export_from_legacy_errors(),
        "transitions": export_transitions(),
        "assign": export_assign(),
        "next_batch": export_next_batch(),
        "backlog_lifecycle": export_backlog_lifecycle(),
        "build_backlog": export_build_backlog(),
        "decisions": export_decisions(),
        "decision_from_dict": export_decision_from_dict(),
        "answer_question": export_answer_question(),
        "patch": export_patch(),
        "validate": export_validate(),
    }
    p = OUT / "questions.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
