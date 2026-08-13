"""Migration history stays append-only and contiguous."""

from ontocopilot.store.migrate import discover


def test_question_and_session_state_migrations_are_discoverable() -> None:
    migrations = discover()
    # Preserve the FDE durability baseline while allowing the catalog to remain
    # append-only. ``discover`` itself verifies that every later version is contiguous.
    assert [item.version for item in migrations[:9]] == [1, 2, 3, 4, 5, 6, 7, 8, 9]
    assert migrations[4].name == "question_decision_revision"
    assert migrations[5].name == "session_status"
    assert migrations[6].name == "session_event_idempotency"
    assert migrations[7].name == "build_lease"
    assert migrations[8].name == "chat_lease"
