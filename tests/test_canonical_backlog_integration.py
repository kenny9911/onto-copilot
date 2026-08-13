"""Server boundary tests for the canonical Question/Decision projection."""

from __future__ import annotations

import asyncio
import json

import pytest

from ontocopilot import server
from ontocopilot.onto import validate_package
from ontocopilot.onto.canonical import ValidationFinding, ValidationReport
from ontocopilot.onto.conflict import Conflict, ConflictKind, Option
from ontocopilot.onto.oir import OIR, BusinessRule, RuleKind, inferred
from ontocopilot.onto.questions import (
    Decision,
    Question,
    QuestionPriority,
    QuestionStatus,
)
from ontocopilot.server import Session
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo, QuestionRow, SessionRow


@pytest.fixture
def repo(monkeypatch, tmp_path):
    store = MemoryRepo()
    set_repo_for_tests(store)
    monkeypatch.setattr(server, "ROOT", tmp_path)

    async def no_prompts(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(server, "_emit_ai_prompts", no_prompts)
    yield store
    set_repo_for_tests(None)
    server.SESSIONS.clear()


async def test_compile_syncs_conflict_backlog_before_canonical_write(repo: MemoryRepo) -> None:
    """A repo-only conflict Question must exist before its Decision is projected."""
    sid = "canonical-conflict"
    await repo.create_session(SessionRow(id=sid))
    session = Session(id=sid, title="采购金额口径")
    session.dir.mkdir(parents=True)

    oir = OIR()
    oir.add_rule(BusinessRule(
        rid="br_amount_threshold",
        statement=inferred("含税金额达到 50 万需要总监审批"),
        kind=inferred(RuleKind.AUTHORITY),
    ))
    option_tax = Option("tax-inclusive", "含税金额")
    option_net = Option("tax-exclusive", "不含税金额")
    conflict = Conflict(
        rid="cf_amount_caliber",
        kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=["br_amount_threshold"],
        summary="审批阈值应使用含税还是不含税金额？",
        options=[option_tax, option_net],
    )
    question_id = "q_conflict_amount_caliber"
    persisted = Question(
        id=question_id,
        text=conflict.summary,
        status=QuestionStatus.ANSWERED,
        owner_user_id="fde-wang",
        audience_role="ERP顾问",
        answer_schema={"type": "string", "enum": [option_tax.id, option_net.id]},
        priority=QuestionPriority.BLOCKING,
        blocked_artifacts=["br_amount_threshold"],
        source_kind="conflict",
        source_ref=conflict.rid,
        why="两个制度材料的金额口径相反",
        evidence_ids=["采购制度.docx#p3"],
        information_gain=0.91,
        blast_radius=5,
        version=7,
    )
    await repo.upsert_questions(sid, [QuestionRow.from_domain(persisted)])
    decision = Decision(
        id="dec_amount_caliber",
        question_id=question_id,
        answer=option_tax.id,
        actor="fde-wang",
        actor_role="FDE",
        affected_ids=["br_amount_threshold"],
        revision=7,
        idempotency_key="canonical-conflict-answer",
    )

    # Deliberately omit state["question_backlog"].  _compile must hydrate/sync it from
    # the unified repo before _write_canonical_artifacts reads the projection.
    session.state.update({
        "_oir": oir,
        "oir": oir.to_dict(),
        "_conflicts": [conflict],
        "conflicts": [conflict.to_dict()],
        "questions": [{
            "id": question_id,
            "conflict_rid": conflict.rid,
            "title": conflict.summary,
            "options": [option_tax.to_dict(), option_net.to_dict()],
            "blockedArtifacts": ["br_amount_threshold"],
            "evidenceIds": ["采购制度.docx#p3"],
            "why": persisted.why,
            "informationGain": persisted.information_gain,
            "blastRadius": persisted.blast_radius,
        }],
        "decision_ledger": [decision.to_dict()],
    })

    await server._compile(session)
    await asyncio.sleep(0)  # allow no-op prompt/event persistence tasks to settle

    data = json.loads((session.dir / "ontology.package.json").read_text(encoding="utf-8"))
    question = next(item for item in data["questions"]
                    if item["legacyId"] == question_id)
    assert question["status"] == "answered"
    assert question["ownerUserId"] == "fde-wang"
    assert question["audienceRole"].startswith("role.")
    assert question["priority"] == "blocking"
    assert question["version"] == 7
    assert question["blockedArtifacts"] == [data["rules"][0]["id"]]
    assert question["evidenceIds"]

    projected = next(item for item in data["decisions"]
                     if item["legacyId"] == decision.id)
    assert projected["questionId"] == question["id"]
    assert projected["affectedIds"] == [data["rules"][0]["id"]]
    assert data["validation"]["status"] == "passed"
    assert not [finding for finding in validate_package(data).findings
                if finding.code == "DANGLING_REF"]


async def test_compile_fails_closed_before_writing_downloads_when_package_invalid(
        repo: MemoryRepo, monkeypatch: pytest.MonkeyPatch) -> None:
    sid = "canonical-release-gate"
    await repo.create_session(SessionRow(id=sid))
    session = Session(id=sid, title="发布闸门")
    session.dir.mkdir(parents=True)
    oir = OIR()
    session.state.update({"_oir": oir, "oir": oir.to_dict(), "_conflicts": []})

    from ontocopilot.onto import canonical

    def rejected(_package):
        return ValidationReport(findings=[ValidationFinding(
            "DANGLING_REF", "动作引用了不存在的数据对象",
            "/actions/0/relatedDataObjects/0", ref="do.missing")])

    monkeypatch.setattr(canonical, "validate_package", rejected)

    with pytest.raises(RuntimeError, match="已阻止交付"):
        await server._compile(session)

    assert not (session.dir / "模板_v1.xlsx").exists()
    assert not (session.dir / "oir.json").exists()
    assert not (session.dir / "ontology.package.json").exists()
    assert any(event["kind"] == "artifact.validation_failed"
               for event in session.events)
