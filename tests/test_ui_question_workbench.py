"""前端 FDE 问题工作台的静态契约测试。

UI 是单文件应用，没有打包步骤；这些断言保护 tab、渐进兼容路径与 Question
Ledger 写接口不被后续样式重构悄悄删掉。JavaScript 语法由可用时的 Node 校验。
"""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui" / "index.html"


def _html() -> str:
    return UI.read_text(encoding="utf-8")


def _script(html: str) -> str:
    start = html.index("<script>", html.index("</head>")) + len("<script>")
    return html[start : html.index("</script>", start)]


def test_question_tab_renders_a_real_workbench() -> None:
    html = _html()
    assert 'data-t="q"' in html
    assert 'if (TAB === "q")' in html
    assert "questionWorkbench()" in html
    for capability in ("data-q-owner", "data-q-role", "data-q-priority", "data-q-answer"):
        assert capability in html


def test_question_ledger_api_and_legacy_fallback_are_both_present() -> None:
    script = _script(_html())
    assert "/questions/${encodeURIComponent(q.id)}" in script
    assert 'qRequest(i, "/answer", "POST"' in script
    assert 'qRequest(i, "/reopen", "POST"' in script
    assert 'status:"deferred"' in script
    assert "ownerUserId:" in script
    assert "audienceRole:" in script
    # 历史会话仍可把问卷问题和 conflict clarification 合为一个 backlog。
    assert "S.state?.oir?.questions" in script
    assert "S.state?.questions" in script
    assert "/api/sessions/${S.id}/answer" in script


def test_question_deliverables_have_typed_exports_and_bundle() -> None:
    html = _html()
    assert "/questions/export?format=${f}" in html
    assert '["xlsx","md","json"]' in html
    assert "/bundle" in html


def test_ui_javascript_parses_with_node() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "--check"], input=_script(_html()), text=True,
        capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
