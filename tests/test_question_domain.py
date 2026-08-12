from __future__ import annotations

import pytest

from ontocopilot.onto.oir import OpenQuestion, inferred
from ontocopilot.onto.questions import (
    AnswerValidationError,
    DecisionLedger,
    IdempotencyConflict,
    PatchOp,
    PatchSet,
    Question,
    QuestionBacklog,
    QuestionPriority,
    QuestionStatus,
    QuestionTransitionError,
    Revision,
    RevisionConflict,
    RevisionStatus,
    answer_question,
    build_question_backlog,
)


def _question(qid: str = "q.threshold", **kw) -> Question:
    base = {
        "id": qid,
        "text": "金额正好等于50万元时是否需要总监审批？",
        "answer_schema": {"type": "boolean"},
        "priority": QuestionPriority.BLOCKING,
        "blocked_artifacts": ["rule.approval", "flow.gateway.approval"],
        "created_at": 100.0,
        "updated_at": 100.0,
    }
    return Question(**{**base, **kw})


def test_question_round_trip_preserves_contract():
    q = _question(owner_user_id="user.chen", audience_role="business_owner",
                  dependencies=["q.amount_basis"], evidence_ids=["ev.221"])
    got = Question.from_dict(q.to_dict())
    assert got == q
    assert got.to_dict()["$schema"] == "ontocopilot.question/1"


def test_open_question_and_conflict_card_migrate_to_one_backlog():
    legacy = OpenQuestion(rid="oq_1", text=inferred("提前多少天预警？"),
                          options=["3", "5"], owner="erp.consultant")
    card = {
        "id": "q_cf1", "conflict_rid": "cf_1", "title": "审批边界不明确",
        "options": [{"id": "include", "label": "包含50万"}],
        "impact_count": 4, "score": 0.8,
    }
    backlog = build_question_backlog(open_questions=[legacy],
                                     clarification_questions=[card])
    assert set(backlog.questions) == {"oq_1", "q_cf1"}
    assert backlog.questions["oq_1"].status is QuestionStatus.ASSIGNED
    assert backlog.questions["q_cf1"].source_ref == "cf_1"
    assert backlog.questions["q_cf1"].priority is QuestionPriority.BLOCKING
    assert backlog.questions["q_cf1"].answer_schema["enum"] == ["include"]


def test_rebuild_preserves_assignment_and_lifecycle():
    existing = QuestionBacklog({"oq_1": Question(
        id="oq_1", text="旧文案", status=QuestionStatus.DEFERRED,
        owner_user_id="u1", created_at=10, updated_at=20, version=3)})
    rebuilt = build_question_backlog(
        open_questions=[{"rid": "oq_1", "text": {"value": "更新后的文案"}}],
        existing=existing)
    q = rebuilt.questions["oq_1"]
    assert (q.text, q.status, q.owner_user_id, q.created_at, q.version) == (
        "更新后的文案", QuestionStatus.DEFERRED, "u1", 10, 3)


def test_assignment_and_state_machine_guards():
    q = _question()
    with pytest.raises(QuestionTransitionError):
        q.transition(QuestionStatus.ASSIGNED)
    q.assign("u1", audience_role="process_owner", now=101)
    assert (q.status, q.owner_user_id, q.version) == (QuestionStatus.ASSIGNED, "u1", 1)
    q.transition(QuestionStatus.ANSWERED, now=102)
    with pytest.raises(QuestionTransitionError):
        q.assign("u2")
    q.transition(QuestionStatus.OPEN)
    assert q.status is QuestionStatus.OPEN


def test_next_batch_respects_dependencies_role_and_priority():
    backlog = QuestionBacklog()
    backlog.add(_question("q.root", status=QuestionStatus.ANSWERED))
    backlog.add(_question("q.ready", dependencies=["q.root"],
                          audience_role="business_owner", information_gain=0.8,
                          blast_radius=4))
    backlog.add(_question("q.blocked", dependencies=["q.missing"],
                          audience_role="business_owner"))
    backlog.add(_question("q.erp", priority=QuestionPriority.HIGH,
                          audience_role="erp_consultant", blocked_artifacts=[]))
    got = backlog.next_batch(limit=5, audience_role="business_owner")
    assert [q.id for q in got] == ["q.ready"]


def test_answer_schema_and_idempotent_decision():
    backlog = QuestionBacklog({"q.threshold": _question()})
    ledger = DecisionLedger()
    with pytest.raises(AnswerValidationError):
        answer_question(backlog, ledger, "q.threshold", "是", actor="u1",
                        idempotency_key="answer-1")
    first, created = answer_question(
        backlog, ledger, "q.threshold", True, actor="u1", actor_role="business_owner",
        authority="process_owner", idempotency_key="answer-1", revision=13, now=110)
    again, created_again = answer_question(
        backlog, ledger, "q.threshold", True, actor="u1", actor_role="business_owner",
        authority="process_owner", idempotency_key="answer-1", revision=13, now=111)
    assert created is True and created_again is False
    assert again.id == first.id
    assert len(ledger.decisions) == 1
    assert backlog.questions["q.threshold"].status is QuestionStatus.ANSWERED


def test_same_idempotency_key_different_answer_is_rejected():
    backlog = QuestionBacklog({"q.threshold": _question()})
    ledger = DecisionLedger()
    answer_question(backlog, ledger, "q.threshold", True, actor="u1",
                    idempotency_key="same")
    backlog.transition("q.threshold", QuestionStatus.OPEN)
    with pytest.raises(IdempotencyConflict):
        answer_question(backlog, ledger, "q.threshold", False, actor="u1",
                        idempotency_key="same")


def test_new_answer_supersedes_old_decision_without_deleting_history():
    backlog = QuestionBacklog({"q.threshold": _question()})
    ledger = DecisionLedger()
    old, _ = answer_question(backlog, ledger, "q.threshold", True, actor="u1",
                             idempotency_key="a1")
    backlog.transition("q.threshold", QuestionStatus.OPEN)
    new, _ = answer_question(backlog, ledger, "q.threshold", False, actor="u1",
                             idempotency_key="a2")
    assert len(ledger.decisions) == 2
    assert new.supersedes == old.id
    assert ledger.active_for("q.threshold") is new
    assert DecisionLedger.from_dict(ledger.to_dict()).active_for("q.threshold").id == new.id


def test_patch_and_revision_round_trip_and_cas():
    patch = PatchSet(
        id="patch.13", base_revision=12,
        ops=[PatchOp("replace", "/rules/rule.approval/expression", "amount >= 500000",
                     target_ids=("rule.approval",))],
        affected_ids=["rule.approval"], blocked_artifacts=["flow.approval"],
        idempotency_key="edit-12-a", actor="u1")
    patch.require_base(12)
    with pytest.raises(RevisionConflict):
        patch.require_base(13)
    got_patch = PatchSet.from_dict(patch.to_dict())
    assert got_patch.fingerprint == patch.fingerprint
    rev = Revision("rev.13", 13, "rev.12", "answer", RevisionStatus.APPLIED,
                   patch_set=patch, changed_ids=["rule.approval"], actor="u1")
    assert Revision.from_dict(rev.to_dict()).to_dict() == rev.to_dict()
