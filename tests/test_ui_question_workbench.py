"""前端 FDE 问题工作台的静态契约测试。

UI 是单文件应用，没有打包步骤；这些断言保护 tab、渐进兼容路径与 Question
Ledger 写接口不被后续样式重构悄悄删掉。JavaScript 语法由可用时的 Node 校验。

本文件**只剩对 `ui/index.html` 的 CSS / HTML 断言**。

原来这里还有一批「把内联 JS 按源码锚点抠出来喂给 Node 跑」的行为测试
（`_cut(script, "let QUOTA = null;", …)` 那种）。前端迁成 TypeScript + esbuild
打包之后，锚点不复存在 —— **不是锚点坏了，是这套办法在有构建步骤之后不成立了**
（本文件原来的 docstring 自己写着：「UI 是单文件应用、没有打包步骤，所以只能把
真实的 JS 抠出来」，那个前提没了）。

那批行为契约已经逐条移到 `ts/test/ui.contracts.*.test.ts`，直接 import
`ts/src/ui/*.ts` 的模块来测 —— 有类型、不依赖文本布局，比正则切 HTML 强。
移植后主 agent 做过变异验证：把提醒条里的转义拿掉、把「本地上限」文案改成
「余额不足请充值」、从英文字典删一个 key，三处都各自打红了对应用例。

留在这里的这些**仍然有效**：CSS 与 HTML 在 index.html 里逐字节保留
（由 `ts/test/ui.build.test.ts` 把关），所以对它们的断言照旧成立。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui" / "index.html"


def _html() -> str:
    return UI.read_text(encoding="utf-8")


def _script(html: str) -> str:
    start = html.index("<script>", html.index("</head>")) + len("<script>")
    return html[start : html.index("</script>", start)]


def test_question_workbench_shows_server_ranked_next_batch() -> None:
    script = _script(_html())
    assert "body.nextBatch" in script
    assert 'typeof item === "string"' in script
    assert "建议下一批先问" in script


def test_release_state_is_not_confused_with_frozen_plan_state() -> None:
    script = _script(_html())
    assert "function releaseView()" in script
    assert "S?.state?.release_state" in script
    assert 'state = "BLOCKED"' in script
    assert "q.blockedArtifacts" in script
    assert 'engagement.frozen ? "FROZEN DAG" : "EDITABLE PLAN"' in script
    # A frozen plan is orthogonal to a DRAFT/BLOCKED/RELEASED artifact.
    assert 'engagement.frozen ? "FROZEN DAG" : "DRAFT"' not in script


def test_inline_handlers_never_use_esc_or_eattr_alone() -> None:
    """通杀式回归：内联处理器里的字符串参数只能用 earg。

    **eattr 一个人不够**，这不是洁癖：浏览器先把属性值做 HTML 实体解码，再把
    解码后的字符串当 JS 编译 —— `&#39;` 解码回 `'`，照样劈开 onclick="f('…')"
    里那个字面量。实测过：只用 eattr 时，用户名 `x','');window.__pwned=1;//`
    点一下删除按钮就执行了；换成 earg 之后同一次点击不再执行，且处理器收到的
    仍是原样字符串。

    逐个点名会漏掉下一个新写的处理器，所以这条按模式扫。
    """
    import re

    bad = [m.group(0) for m in re.finditer(
        r'on[a-z]+="[^"]*\$\{(?:esc|eattr)\(', _html())]
    assert not bad, f"内联处理器里的参数要用 earg：{bad}"


def test_the_display_name_never_reaches_an_inline_handler() -> None:
    """display_name 是自由文本（引号、emoji 全放行），比用户名松得多。

    它可以出现在文本位置（那里 esc 够用），但**绝不能**进内联处理器 —— 那里
    一个撇号就能改变语义。
    """
    import re

    bad = [m.group(0) for m in re.finditer(
        r'on[a-z]+="[^"]*display_name', _html())]
    assert not bad, f"display_name 进了内联处理器：{bad}"


def test_ui_javascript_parses_with_node() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "--check"], input=_script(_html()), text=True,
        capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr


# ══════════════════════════════════════════════════════════════════
#  推荐问题 chips（用户报的两个症状里，两个都在前端）
# ══════════════════════════════════════════════════════════════════


def test_reopening_a_session_restores_its_chips() -> None:
    """chips 是会话的一部分，隔一天回来不该消失（服务端 /state 带着它）。"""
    script = _script(_html())
    assert "FOLLOWUPS = st.followups || []" in script


def test_stopping_a_turn_recovers_the_chips_it_threw_away() -> None:
    """停止是 abort 掉自己那条 fetch —— 响应连同它带的 chips 一起没了。

    服务端为这一轮算好的那批只落进了会话状态，得去取回来，否则剩下的是一批
    开场白：第一条往往正是他十轮前问过的那句。
    """
    script = _script(_html())
    stop = script.index("async function stopChat()")
    body = script[stop : stop + 900]
    assert "/state" in body and "FOLLOWUPS = st.followups" in body


# ══════════════════════════════════════════════════════════════════
#  对话记录：只能按身份合并，不能盲追加 / 整体覆盖
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  空状态问候语：认得出人就叫名字
# ══════════════════════════════════════════════════════════════════


def test_the_name_never_reaches_an_inline_handler() -> None:
    """内联 onclick 里要用 eattr（esc 不转引号）。显示名比用户名自由得多 ——
    空格、引号、emoji 全放行，塞进内联 JS 字符串就是一个注入点。"""
    script = _script(_html())
    assert "'${esc(u.display_name" not in script
    assert "'${esc(CURRENT_USER.display_name" not in script


def test_a_brand_new_account_is_not_welcomed_back() -> None:
    """注册 → reload → 点「新会话」，两三秒内就撞上这句。
    他从没来过，说"欢迎回来"是句事实错误的话。"""
    script = _script(_html())
    assert 'sessionStorage.setItem("oc_new_account"' in script
    greet = script[script.index("function greetLine()"):][:600]
    assert "empty.welcomeNew" in greet and "empty.welcomeBack" in greet


def test_open_mode_has_nobody_to_greet() -> None:
    """本地模式的合成管理员 username 字面量就是 "local" ——
    直接拼会得到「欢迎回来，local」。"""
    script = _script(_html())
    greet = script[script.index("function greetName()"):][:400]
    assert '__local__' in greet


# ══════════════════════════════════════════════════════════════════
#  操作记录：右栏「推理」要记下发生过的每一件事
# ══════════════════════════════════════════════════════════════════
def test_the_hidden_quota_bar_is_actually_hidden() -> None:
    """`hidden` 属性靠浏览器默认样式 `[hidden]{display:none}` 生效，
    而它的优先级**低于**类选择器。

    只写 `.qbar{display:flex}` 的话，paintQuotaBar 把 hidden 设回 true 也关不掉 ——
    界面顶上永远挂着一条 21px 高、没有任何文字的警告色横条。实测复现过。
    """
    html = _html()
    assert ".qbar[hidden]{display:none}" in html


def test_recommended_questions_are_not_called_decisions() -> None:
    """`prompts.ready`（聊天框上方的推荐提示）和 `clarify.request`（必须人拍板的
    建模决策）是两件完全不同的事。以前前者被显示成"2 个决策"。"""
    script = _script(_html())
    detail = script[script.index("function evDetail("):]
    detail = detail[:detail.index("\n}")]
    assert '"prompts.ready"' in detail and '"clarify.request"' in detail
    assert "个待拍板" in detail
    # 旧写法：任何带 questions 的事件都算决策。只看代码行 —— 注释里讲的正是
    # 这个旧写法为什么错，别把它算成违规。
    code = [ln for ln in script.splitlines() if not ln.strip().startswith("//")]
    assert not [ln for ln in code if "个决策" in ln]


