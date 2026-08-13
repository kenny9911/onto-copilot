"""The released wheel must contain the frontend it serves."""

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_wheel_force_includes_the_fde_workbench() -> None:
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    force = config["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    assert force["ui/index.html"] == "ontocopilot/ui/index.html"
    assert force["migrations"] == "ontocopilot/migrations"
    assert (ROOT / "ui" / "index.html").stat().st_size > 100_000
    migrations = sorted(path.name for path in (ROOT / "migrations").glob("*.sql"))
    # 0001–0009 are the release baseline protected by this regression.  Later
    # append-only migrations are valid and must not require rewriting this test.
    assert migrations[:9] == [
        "0001_init.sql",
        "0002_accounts.sql",
        "0003_app_settings.sql",
        "0004_session_owner.sql",
        "0005_question_decision_revision.sql",
        "0006_session_status.sql",
        "0007_session_event_idempotency.sql",
        "0008_build_lease.sql",
        "0009_chat_lease.sql",
    ]


def test_runtime_has_source_and_packaged_ui_candidates() -> None:
    source = (ROOT / "src" / "ontocopilot" / "server.py").read_text(encoding="utf-8")
    assert '_PACKAGED_UI = Path(__file__).resolve().parent / "ui"' in source
    assert "_SOURCE_UI if (_SOURCE_UI / \"index.html\").exists() else _PACKAGED_UI" in source
