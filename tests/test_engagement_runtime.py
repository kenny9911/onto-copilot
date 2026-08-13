"""The product FDE graph is executable, resumable and fail-closed."""

from __future__ import annotations

import pytest

from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.bus.bus import AgentBus
from ontocopilot.kernel.critic import CriticPanel
from ontocopilot.kernel.events import EventKind
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.llm import ModelGateway, ScriptedBackend, stub_routing
from ontocopilot.kernel.loop import AgentLoop
from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.kernel.scheduler import RunStatus, Scheduler
from ontocopilot.onto.engagement import build_fde_engagement_dag
from ontocopilot.onto.engagement_runtime import (
    EngagementRuntimeInput,
    engagement_critics,
    engagement_handlers,
)
from ontocopilot.onto.oir import OIR, ObjectType, inferred, make_rid
from ontocopilot.onto.questions import Question, QuestionBacklog, QuestionStatus

pytestmark = pytest.mark.asyncio


def _oir() -> OIR:
    oir = OIR()
    rid = make_rid("ot", "PurchaseOrder")
    oir.add_object(ObjectType(
        rid=rid,
        api_name=inferred("PurchaseOrder"),
        display_name=inferred("采购订单"),
        description=inferred("采购订单业务对象"),
    ))
    return oir


def _runtime(
    *,
    pending: bool = False,
    downloadable: bool = True,
    blocking: bool = True,
) -> EngagementRuntimeInput:
    backlog = QuestionBacklog()
    if pending:
        backlog.add(Question(
            id="q.erp.version",
            text="当前 ERP 产品版本是什么？",
            status=QuestionStatus.OPEN,
            audience_role="ERP顾问",
            blocked_artifacts=(["ontology.package.json"] if blocking else []),
        ))
    return EngagementRuntimeInput(
        session_id="engagement-test",
        project="采购到付款",
        oir=_oir(),
        flow=None,
        backlog=backlog,
        generated_at="2026-08-12T00:00:00+00:00",
        release_downloadable=downloadable,
    )


def _scheduler(
    runtime: EngagementRuntimeInput,
    *,
    journal: InMemoryJournal | None = None,
    blobs: InMemoryBlobStore | None = None,
    resume: bool = False,
) -> tuple[Scheduler, Recorder, InMemoryJournal, InMemoryBlobStore, ScriptedBackend]:
    journal = journal or InMemoryJournal()
    blobs = blobs or InMemoryBlobStore()
    rec = Recorder("engagement-run", journal, blobs, resume=resume)
    bus = AgentBus(rec)
    budget = Budget(tokens=1_000_000, usd=10)
    backend = ScriptedBackend(default="{}")
    gw = ModelGateway(backend, rec, routing=stub_routing(), budget=budget)
    loop = AgentLoop(
        gateway=gw,
        ctx_manager=ContextManager(system="FDE engagement runtime", budget_tokens=32_000),
        panel=CriticPanel(engagement_critics(), rec),
        bus=bus,
        recorder=rec,
        budget=budget,
        handlers=engagement_handlers(runtime),
    )
    sched = Scheduler(
        build_fde_engagement_dag(), loop, rec, bus, budget, concurrency=4,
    )
    return sched, rec, journal, blobs, backend


async def test_scheduler_executes_every_frozen_engagement_node_without_second_model_pass():
    sched, _, journal, _, backend = _scheduler(_runtime())

    outcome = await sched.run("engagement-run")

    assert outcome.ok
    expected = build_fde_engagement_dag().topo_order()
    completed = [
        event.node_id for event in journal.read("engagement-run")
        if event.kind is EventKind.NODE_COMPLETED
    ]
    assert set(completed) == set(expected)
    assert set(outcome.outputs) == set(expected)
    assert outcome.outputs["PROCESS"]["source"] == "mature_extract_composite"
    assert outcome.outputs["EXPORT"]["review_passed"] is True
    assert outcome.outputs["EXPORT"]["schema_valid"] is True
    assert outcome.outputs["EXPORT"]["downloadable"] is True
    assert backend.calls == [], "专业投影不得对成熟抽取结果二次付费"


async def test_interview_really_suspends_then_resume_executes_remaining_nodes():
    runtime = _runtime(pending=True)
    sched, _, journal, blobs, backend = _scheduler(runtime)

    suspended = await sched.run("engagement-run")

    assert suspended.status is RunStatus.SUSPENDED
    assert suspended.pending_human
    assert suspended.pending_human["node"] == "INTERVIEW"
    assert suspended.pending_human["pending"] == 1
    assert "CANONICALIZE" not in suspended.outputs
    assert backend.calls == []

    # The Question/Decision API is authoritative; when it has resolved the backlog,
    # a replay restores completed stages and executes the remainder of the same DAG.
    backlog = runtime.question_backlog()
    backlog.questions["q.erp.version"].status = QuestionStatus.ANSWERED
    resumed, _, _, _, resumed_backend = _scheduler(
        runtime, journal=journal, blobs=blobs, resume=True,
    )
    outcome = await resumed.run("engagement-run")

    assert outcome.ok
    assert set(outcome.skipped) >= {
        "INTAKE", "PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS", "GAP",
    }
    assert {"INTERVIEW", "CANONICALIZE", "REVIEW", "EXPORT"} <= set(outcome.results)
    assert resumed_backend.calls == []


async def test_review_gate_blocks_export_when_delivery_target_is_not_downloadable():
    sched, _, journal, _, backend = _scheduler(_runtime(downloadable=False))

    outcome = await sched.run("engagement-run")

    assert outcome.status is RunStatus.FAILED
    assert "REVIEW" in outcome.error
    assert "质量门" in outcome.error
    assert "EXPORT" not in outcome.outputs
    completed = {
        event.node_id for event in journal.read("engagement-run")
        if event.kind is EventKind.NODE_COMPLETED
    }
    assert "REVIEW" not in completed, "门禁失败产物不得提交 WorkingSet/checkpoint"
    assert "EXPORT" not in completed
    assert backend.calls == []


async def test_normal_open_question_is_packaged_as_downloadable_draft_not_suspended():
    sched, _, journal, _, backend = _scheduler(
        _runtime(pending=True, blocking=False),
    )

    outcome = await sched.run("engagement-run")

    assert outcome.ok
    assert outcome.outputs["INTERVIEW"]["releaseState"] == "DRAFT"
    assert outcome.outputs["REVIEW"]["releaseState"] == "DRAFT"
    assert outcome.outputs["EXPORT"]["releaseState"] == "DRAFT"
    assert outcome.outputs["EXPORT"]["downloadable"] is True
    assert any("非阻塞问题" in item for item in outcome.outputs["EXPORT"]["warnings"])
    assert {
        event.node_id for event in journal.read("engagement-run")
        if event.kind is EventKind.NODE_COMPLETED
    } == set(build_fde_engagement_dag().topo_order())
    assert backend.calls == []
