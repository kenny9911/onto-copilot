"""Durable LLM usage accounting: retries, replay, failures and tenant isolation."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.dag import Difficulty
from ontocopilot.kernel.events import EventKind
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.llm import (
    LLMBackend,
    ModelGateway,
    ModelSpec,
    Usage,
    stub_routing,
)
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.store.engine import SQLITE_SCHEMA_VERSION, Store
from ontocopilot.store.migrate import discover
from ontocopilot.store.repo import MemoryRepo, UsageRow, build_repo


class SequencedBackend(LLMBackend):
    """Return paid attempts in order so retry aggregation can be asserted exactly."""

    def __init__(self, attempts: list[tuple[str, Usage]]) -> None:
        self.attempts = list(attempts)
        self.calls = 0

    async def generate(
        self,
        *,
        model: ModelSpec,
        prompt: str,
        system: str = "",
        schema: dict | None = None,
        max_tokens: int = 16_000,
        cache_system: bool = True,
        images: list[str] | None = None,
    ) -> tuple[str, Usage]:
        del model, prompt, system, schema, max_tokens, cache_system, images
        result = self.attempts[self.calls]
        self.calls += 1
        return result


@pytest.fixture(params=["memory", "sqlite"])
async def usage_repo(request) -> AsyncIterator[MemoryRepo]:
    if request.param == "memory":
        repo = MemoryRepo()
        yield repo
        return
    store = await Store.open("sqlite+aiosqlite:///:memory:", create_all=True)
    try:
        yield build_repo(store)
    finally:
        await store.close()


def _row(rid: str, *, ts: float, owner: str) -> UsageRow:
    return UsageRow(
        id=rid, ts=ts, day="2026-08-12", owner=owner, model="model-a",
        tok_in=10, tok_out=5, usd=0.01,
    )


async def test_retries_charge_total_and_recorder_replay_writes_no_second_ledger_row() -> None:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    backend = SequencedBackend([
        ("not json", Usage(tok_in=10, tok_out=2, cache_read=3, usd=0.10)),
        ('{"ok": true}', Usage(tok_in=20, tok_out=4, cache_write=5, usd=0.20)),
    ])
    ledger: list[dict] = []
    budget = Budget()
    rec = Recorder("run-usage", journal, blobs)
    gateway = ModelGateway(
        backend, rec, routing=stub_routing(), budget=budget,
        max_schema_retries=1, usage_sink=ledger.append,
    )

    completion = await gateway.call(
        "NODE", "give json", difficulty=Difficulty.LOW,
        schema={"type": "object", "required": ["ok"],
                "properties": {"ok": {"type": "boolean"}}},
    )

    assert backend.calls == 2
    assert completion.attempts == 2
    assert completion.usage.to_dict() == {
        "tok_in": 30, "tok_out": 6, "cache_read": 3, "cache_write": 5,
        "usd": pytest.approx(0.30),
    }
    assert completion.usd == pytest.approx(0.30)
    assert budget.spent("tokens") == 44
    assert budget.spent("usd") == pytest.approx(0.30)
    assert ledger == [{
        "node_id": "NODE", "model": "stub-small", "effort": "",
        "tok_in": 30, "tok_out": 6, "cache_read": 3, "cache_write": 5,
        "usd": pytest.approx(0.30), "usd_source": "gateway", "attempts": 2,
        "status": "ok", "run_id": "run-usage",
    }]
    spent_events = [e for e in journal.read("run-usage")
                    if e.kind is EventKind.BUDGET_SPENT]
    assert len(spent_events) == 1
    assert spent_events[0].payload | {} == {
        "model": "stub-small", "effort": None, "tok_in": 30, "tok_out": 6,
        "cache_read": 3, "cache_write": 5, "usd": 0.3, "attempts": 2,
        "status": "ok", "level": 0,
    }

    replay_budget = Budget()
    replay = ModelGateway(
        backend, Recorder("run-usage", journal, blobs, resume=True),
        routing=stub_routing(), budget=replay_budget, usage_sink=ledger.append,
    )
    replayed = await replay.call(
        "NODE", "give json", difficulty=Difficulty.LOW,
        schema={"type": "object", "required": ["ok"],
                "properties": {"ok": {"type": "boolean"}}},
    )

    assert replayed.usage.total == 44
    assert backend.calls == 2
    assert len(ledger) == 1, "Recorder replay must never create another billing row"
    assert replay_budget.spent("tokens") == 44
    assert len([e for e in journal.read("run-usage")
                if e.kind is EventKind.BUDGET_SPENT]) == 1


async def test_failed_schema_attempts_are_auditable_and_charged() -> None:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    backend = SequencedBackend([
        ("bad-1", Usage(tok_in=7, tok_out=1)),
        ("bad-2", Usage(tok_in=8, tok_out=2)),
    ])
    ledger: list[dict] = []
    budget = Budget()
    gateway = ModelGateway(
        backend, Recorder("run-failed", journal, blobs), routing=stub_routing(),
        budget=budget, max_schema_retries=1, usage_sink=ledger.append,
    )

    with pytest.raises(Exception, match="schema"):
        await gateway.call(
            "FAIL", "json please", difficulty=Difficulty.LOW,
            schema={"type": "object"},
        )

    assert ledger[0]["status"] == "failed"
    assert ledger[0]["attempts"] == 2
    assert (ledger[0]["tok_in"], ledger[0]["tok_out"]) == (15, 3)
    assert ledger[0]["usd_source"] == "estimated"
    assert budget.spent("tokens") == 18
    spent = [e for e in journal.read("run-failed") if e.kind is EventKind.BUDGET_SPENT]
    assert len(spent) == 1
    assert spent[0].payload["status"] == "failed"


async def test_usage_repository_owner_filter_order_limit_and_session_independence(
    usage_repo,
) -> None:
    await usage_repo.add_usage(_row("old-a", ts=10, owner="alice"))
    await usage_repo.add_usage(_row("new-a", ts=30, owner="alice"))
    await usage_repo.add_usage(_row("bob", ts=20, owner="bob"))
    await usage_repo.add_usage(_row("open", ts=40, owner=""))

    assert [r.id for r in await usage_repo.usage_since(0, owner="alice")] == [
        "new-a", "old-a",
    ]
    assert [r.id for r in await usage_repo.usage_since(0, owner="")] == ["open"]
    assert [r.id for r in await usage_repo.usage_since(15, limit=2)] == ["open", "new-a"]
    assert await usage_repo.usage_since(0, limit=0) == []
    with pytest.raises(ValueError, match="attempts"):
        await usage_repo.add_usage(UsageRow(
            id="invalid", ts=50, day="2026-08-12", model="m", attempts=0,
        ))


async def test_sqlite_schema_version_usage_constraints_and_healthcheck() -> None:
    store = await Store.open("sqlite+aiosqlite:///:memory:", create_all=True)
    try:
        async with store.engine.connect() as conn:
            version = (await conn.exec_driver_sql("PRAGMA user_version")).scalar_one()
            columns = {row[1] for row in (await conn.exec_driver_sql(
                'PRAGMA table_info("llm_usage")',
            )).all()}
        assert version == SQLITE_SCHEMA_VERSION == 12
        assert {"owner", "run_id", "attempts", "usd_source", "status"} <= columns
        assert (await store.healthcheck())["schema_version"] == 12

        repo = build_repo(store)
        with pytest.raises(ValueError, match="attempts"):
            await repo.add_usage(UsageRow(
                id="invalid", ts=1, day="2026-08-12", model="m", attempts=0,
            ))
    finally:
        await store.close()


def test_migration_catalog_keeps_usage_ledger_at_version_10() -> None:
    migrations = discover()
    assert [item.version for item in migrations] == list(range(1, 13))
    assert migrations[9].name == "llm_usage"
    assert migrations[-1].name == "user_display_name"
