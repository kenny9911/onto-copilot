from __future__ import annotations

import pytest

from ontocopilot.onto.questions import (
    Decision,
    IdempotencyConflict,
    PatchOp,
    PatchSet,
    Question,
    Revision,
    RevisionStatus,
)
from ontocopilot.store.engine import Store
from ontocopilot.store.repo import (
    DecisionRecordRow,
    QuestionRow,
    RevisionRow,
    SessionRow,
    build_repo,
)


@pytest.fixture(params=["memory", "sql"])
async def repo(request):
    store = (await Store.open("") if request.param == "memory" else
             await Store.open("sqlite+aiosqlite:///:memory:", create_all=True))
    repo = build_repo(store)
    await repo.create_session(SessionRow(id="s1"))
    yield repo
    await store.close()


def _q(text: str = "金额边界是什么？") -> Question:
    return Question(id="q1", text=text, answer_schema={"type": "number"},
                    blocked_artifacts=["rule.1"], created_at=100, updated_at=100)


def _decision(answer=500_000, key="answer-1") -> Decision:
    d = Decision(id="dec.1", question_id="q1", answer=answer, actor="u1",
                 affected_ids=["rule.1"], idempotency_key=key, created_at=101)
    return d


async def test_question_repo_round_trip_filter_and_upsert(repo):
    row = QuestionRow.from_domain(_q())
    got = await repo.upsert_questions("s1", [row])
    assert [x.id for x in got] == ["q1"]
    assert (await repo.get_question("s1", "q1")).blocked_artifacts == ["rule.1"]
    assert [x.id for x in await repo.list_questions("s1", statuses=["open"])] == ["q1"]
    row.text = "更新的问题"
    row.doc["text"] = "更新的问题"
    await repo.upsert_questions("s1", [row])
    assert (await repo.get_question("s1", "q1")).text == "更新的问题"


async def test_decision_repo_is_idempotent_and_supersedes(repo):
    first = DecisionRecordRow.from_domain(_decision())
    got, created = await repo.record_decision_v1("s1", first)
    same, created_again = await repo.record_decision_v1("s1", first)
    assert created is True and created_again is False and same.id == got.id

    changed = _decision(answer=600_000, key="answer-2")
    changed.id = "dec.2"
    second, created_second = await repo.record_decision_v1(
        "s1", DecisionRecordRow.from_domain(changed))
    assert created_second and second.supersedes == "dec.1"
    assert [x.id for x in await repo.list_decisions_v1("s1")] == ["dec.1", "dec.2"]


async def test_decision_repo_rejects_idempotency_collision(repo):
    await repo.record_decision_v1("s1", DecisionRecordRow.from_domain(_decision()))
    bad = _decision(answer=1, key="answer-1")
    bad.id = "dec.bad"
    with pytest.raises(IdempotencyConflict):
        await repo.record_decision_v1("s1", DecisionRecordRow.from_domain(bad))


async def test_revision_repo_round_trip_and_idempotency(repo):
    patch = PatchSet(id="patch.1", base_revision=0,
                     ops=[PatchOp("replace", "/rules/r1", {"threshold": 500000})],
                     idempotency_key="patch-key")
    rev = Revision("rev.1", 1, None, "answer", RevisionStatus.APPLIED,
                   patch_set=patch, changed_ids=["rule.1"], created_at=102)
    row = RevisionRow.from_domain(rev, idempotency_key="revision-key")
    got, created = await repo.record_revision("s1", row)
    same, created_again = await repo.record_revision("s1", row)
    assert created and not created_again and same.id == got.id
    assert [x.id for x in await repo.list_revisions("s1")] == ["rev.1"]


async def test_delete_session_cascades_domain_records(repo):
    await repo.upsert_questions("s1", [QuestionRow.from_domain(_q())])
    await repo.record_decision_v1("s1", DecisionRecordRow.from_domain(_decision()))
    patch = PatchSet("patch.1", 0, [PatchOp("add", "/x", 1)])
    rev = Revision("rev.1", 1, None, "edit", RevisionStatus.APPLIED, patch_set=patch)
    await repo.record_revision("s1", RevisionRow.from_domain(rev))
    assert await repo.delete_session("s1")
    assert await repo.list_questions("s1") == []
    assert await repo.list_decisions_v1("s1") == []
    assert await repo.list_revisions("s1") == []
