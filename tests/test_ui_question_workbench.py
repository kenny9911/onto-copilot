"""前端 FDE 问题工作台的静态契约测试。

UI 是单文件应用，没有打包步骤；这些断言保护 tab、渐进兼容路径与 Question
Ledger 写接口不被后续样式重构悄悄删掉。JavaScript 语法由可用时的 Node 校验。
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
    assert "idempotencyKey:idem" in script
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


def test_returned_template_uses_preview_then_explicit_apply() -> None:
    html = _html()
    script = _script(html)
    assert 'id="returnPicker"' in html
    assert "auditReturnPicked()" in html
    assert "/audit?apply=false" in script
    assert "/audit?apply=true" in script
    assert "系统不会应用任何数据" in script
    assert "RETURN_AUDIT.readable !== true" in script
    assert "previewBlocked" in script
    assert "confirm(msg)" in script
    assert "returnAuditCard()" in script
    assert "damage" in script and "dropped" in script
    assert "loadQuestions()" in script


def test_question_workbench_shows_server_ranked_next_batch() -> None:
    script = _script(_html())
    assert "body.nextBatch" in script
    assert 'typeof item === "string"' in script
    assert "建议下一批先问" in script


def test_question_priorities_match_domain_contract() -> None:
    script = _script(_html())
    assert '[["low","低优先级"],["normal","普通优先级"],["high","高优先级"],["blocking","阻塞交付"]]' in script
    assert '["normal","medium"' not in script
    assert 'impactN >= 3 ? "medium"' not in script


def test_release_state_is_not_confused_with_frozen_plan_state() -> None:
    script = _script(_html())
    assert "function releaseView()" in script
    assert "S?.state?.release_state" in script
    assert 'state = "BLOCKED"' in script
    assert "q.blockedArtifacts" in script
    assert 'engagement.frozen ? "FROZEN DAG" : "EDITABLE PLAN"' in script
    # A frozen plan is orthogonal to a DRAFT/BLOCKED/RELEASED artifact.
    assert 'engagement.frozen ? "FROZEN DAG" : "DRAFT"' not in script


def test_bundle_download_is_gated_while_working_artifacts_remain_available() -> None:
    script = _script(_html())
    assert 'function bundleLink(label, classes="act")' in script
    assert 'release.state === "BLOCKED"' in script
    assert "问题清单和单份草稿仍可下载" in script
    # 所有 Bundle 入口都必须走同一门禁；唯一真实 href 位于 bundleLink 内。
    assert script.count("/bundle") == 1
    assert script.count("bundleLink(") == 6  # 5 个入口 + 1 个函数定义
    assert ".act.disabled,.abtn.disabled" in _html()
    # 一个已发布会话重新打开普通问题时，当前包也必须立即降为 DRAFT。
    release = script[script.index("function releaseView()") : script.index(
        "function bundleLink(")]
    assert 'else if (pending.length) state = "DRAFT"' in release


def test_blocked_and_deferred_questions_must_reopen_before_answering() -> None:
    script = _script(_html())
    assert 'const needsReopen = ["deferred","blocked"].includes(q.status)' in script
    assert 'busy||done||needsReopen?"disabled"' in script
    assert 'needsReopen ? `<button class="act pri" onclick="qReopen(${i})"' in script


def test_sidebar_delete_handler_escapes_for_the_js_literal() -> None:
    """会话标题带一个撇号（「客户'A'的项目」）就不能弄坏这个处理器。

    这条以前钉的是 eattr —— **不够**。见下面那条通杀测试里的解释。
    """
    html = _html()
    assert "dropSession('${earg(s.id)}','${earg(s.title)}')" in html
    assert "dropSession('${s.id}','${esc(s.title)}')" not in html


def test_account_row_handlers_escape_for_the_js_literal() -> None:
    """账号表里每个内联处理器的值都夹在一对单引号中间。

    用户名只经过 strip().lower()（auth.py 的 normalize_username），引号一个都不拦：
    `x','');alert(1);//` 对任何打开账号面板的管理员就是一次存储型 XSS —— 受害者
    只是点开了那个面板。良性的 `o'brien` 则会让按钮直接失灵。
    """
    html = _html()
    assert "doDeleteUser('${earg(u.id)}','${earg(u.username)}')" in html
    assert "doDeleteUser('${esc(u.id)}','${esc(u.username)}')" not in html
    for call in ("changeRole('${earg(u.id)}'", "toggleActive('${earg(u.id)}'",
                 "doResetPassword('${earg(u.id)}')", "beginReset('${earg(u.id)}')"):
        assert call in html, call


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


def test_earg_escapes_the_js_literal_before_the_attribute() -> None:
    """顺序不能反：先 JS 转义、再属性转义。

    反过来（先 eattr 再 ejs）会把 `&#39;` 里的分号/井号一起转义掉，值就毁了。
    """
    script = _script(_html())
    body = script[script.index("const ejs ="):script.index("const earg =") + 120]
    assert "earg = s => eattr(ejs(s))" in body, "earg 的组合顺序错了"
    for piece in ("\\\\'", "\\\\n", "u2028"):
        assert piece in body or piece.replace("\\\\", "\\") in body, piece


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
def test_background_steps_stay_out_of_the_chat_stream() -> None:
    """「想推荐问题：…」这类后台轨迹只进推理面板。

    它们大多发生在回答落地**之后**，而 STEPS 那一刻刚被清空 —— 于是答案下方
    又冒出一张思考卡，像是还没答完。后端照旧在发这条 chat.step（推理面板要
    它），所以拦截点只能在这里。
    """
    script = _script(_html())
    assert 'if (ev.step.turn !== "aux")' in script, "aux 步骤又被放进对话流了"
    # 但仍要进 TRACE —— 推理面板是它唯一的家
    trace_push = script.index("TRACE.push({...ev.step")
    guard = script.index('if (ev.step.turn !== "aux")')
    assert guard < trace_push, "TRACE 也被那层判断挡住了"


def test_chips_have_a_fallback_instead_of_disappearing() -> None:
    """每一次交互结束，聊天窗口里都得有"接下来能问什么"。

    以前是 `dlg.length ? [] : PROMPTS`：只要聊过一句，追问一为空就一条出口
    都没有 —— 而服务端那时刚算好一批提示正躺在 PROMPTS 里没人用。
    """
    script = _script(_html())
    # 只看那一行赋值本身 —— 注释里写着旧写法（讲它为什么被换掉），别把注释也算进去
    assign = [ln.strip() for ln in script.splitlines()
              if ln.strip().startswith("const chips =") and "FOLLOWUPS" in ln]
    assert assign == ["const chips = FOLLOWUPS.length ? FOLLOWUPS : PROMPTS;"], assign


def test_reopening_a_session_restores_its_chips() -> None:
    """chips 是会话的一部分，隔一天回来不该消失（服务端 /state 带着它）。"""
    script = _script(_html())
    assert "FOLLOWUPS = st.followups || []" in script


def test_a_turn_in_flight_does_not_flash_stale_chips() -> None:
    """答案由 SSE 先上屏、chips 跟着 HTTP 响应才到。

    中间那一小段若照常画，用户会看到上一轮/开场那批闪一下再被换掉 ——
    位置就在输入框正上方，整块跳一跳。
    """
    script = _script(_html())
    assert "if (!THINKING && !CHAT_ABORT) {" in script


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
def test_chat_turns_are_merged_by_identity_not_blindly_appended():
    """两条真实 bug 的共同根因。

    盲追加 → 每条消息两遍：/state 已经带回完整 dialogue，而 SSE 重连固定用
    ?since=0，从耐久事件表把同样的 chat.turn 再重放一遍。
    整体覆盖 → 回答被吞：一次滞后的 /state 回来后把 state 整个换掉，抹掉了 SSE
    刚推上来、那次查询还没看到的助手回答。
    """
    js = _script(_html())
    assert "function addTurn(" in js
    assert "const turnKey =" in js

    # chat.turn 必须走 addTurn，不能再出现直接 push
    handler = js[js.index('if (ev.kind === "chat.turn")'):][:400]
    assert "addTurn(ev.turn)" in handler
    assert "turns.push(" not in handler, "又变回盲追加了"

    # /state 重取回来必须合并，不能把 dialogue 跟着 Object.assign 一起换掉
    refetch = js[js.index("/state`).then(r=>r.json()).then(st =>"):][:300]
    assert "mergeStateSnapshot(st)" in refetch


def test_state_snapshot_merge_keeps_remote_turns_and_dialogue_metadata() -> None:
    """用真实 JS helper 验证 API 的 ``st.state.dialogue`` 契约，而非只搜函数名。"""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    js = _script(_html())
    helpers = js[js.index("const turnKey =") : js.index("function bubble(")]
    program = """
let PENDING = [];
let S = {
  events: [{seq: 9}],
  state: {dialogue: {
    turns: [{speaker: "user", ts: 1, text: "old"}],
    decisions: [{id: "local"}], compactions: 0
  }}
};
__HELPERS__
mergeStateSnapshot({
  events: 41,
  state: {marker: "server", dialogue: {
    turns: [
      {speaker: "user", ts: 1, text: "old"},
      {speaker: "assistant", ts: 2, text: "server-new"}
    ],
    decisions: [{id: "remote"}], compactions: 2
  }}
});
console.log(JSON.stringify({
  turns: S.state.dialogue.turns,
  decisions: S.state.dialogue.decisions,
  compactions: S.state.dialogue.compactions,
  marker: S.state.marker,
  events: S.events
}));
""".replace("__HELPERS__", helpers)
    result = subprocess.run(
        [node, "-"], input=program, text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = __import__("json").loads(result.stdout)
    assert [turn["text"] for turn in payload["turns"]] == ["old", "server-new"]
    assert payload["decisions"] == [{"id": "remote"}]
    assert payload["compactions"] == 2
    assert payload["marker"] == "server"
    assert payload["events"] == [{"seq": 9}]


# ══════════════════════════════════════════════════════════════════
#  空状态问候语：认得出人就叫名字
# ══════════════════════════════════════════════════════════════════
def test_greeting_keys_exist_in_both_dictionaries() -> None:
    """t() 缺 key 时**静默**回落到中文再回落到 key 本身 ——
    漏了 en 的表现是英文界面上冒出中文，不报错、不红。"""
    script = _script(_html())
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    assert zh < en, "字典顺序变了，下面的切片就不对了"
    zh_block, en_block = script[zh:en], script[en:en + 8000]
    for key in ("login.displayName", "register.needName",
                "empty.tagline", "empty.welcomeBack", "empty.welcomeNew"):
        assert f'"{key}"' in zh_block, f"zh 少了 {key}"
        assert f'"{key}"' in en_block, f"en 少了 {key}"


def test_the_name_is_escaped_before_it_reaches_innerHTML() -> None:
    """显示名是用户自己填的自由文本，而这一行是拼进 innerHTML 的。

    t() 只做 {name} 替换、**自己不转义**，所以必须先 esc(name) 再插值。
    """
    script = _script(_html())
    greet = script[script.index("function greetLine()"):][:600]
    assert "esc(name)" in greet, "名字没转义就进了 innerHTML"
    assert "empty.tagline" in greet, "认不出人时要回落到那句 tagline"


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


def test_the_greeting_does_not_hang_over_an_old_conversation() -> None:
    """intro 在有对话时会被钉在消息流最上方。不分叉的话，「欢迎回来，张三」
    会永久挂在一段半年前的五十轮对话顶上。"""
    script = _script(_html())
    empty = script[script.index('<h3>OntoCopilot</h3>'):][:300]
    assert "hasChat ?" in empty


def test_a_hostile_username_cannot_escape_an_inline_handler() -> None:
    """行为测试，不是字符串比对。

    上面几条只能证明"写法对了"，证明不了"写法有用" —— 事实上正是这里发现
    eattr 不够：它挡得住属性闭合，挡不住 HTML 解码之后的 JS 编译。这条按浏览器
    的真实顺序走一遍：earg 拼进属性 → HTML 实体解码 → 当 JS 编译，然后断言
    ①没有执行任何注入代码 ②处理器拿到的仍是原样字符串。
    """
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    script = _script(_html())
    defs = script[script.index("const esc ="):script.index("const earg =") + 200]
    defs = defs[:defs.index("\n", defs.index("const earg ="))]

    probe = r"""
    // 攻击者能控制的：用户名（只被 strip().lower() 过）、显示名、会话标题、文件名…
    const evil = "x','');globalThis.__pwned=1;//";
    const attr = earg(evil);
    // 浏览器解析属性时先做 HTML 实体解码，再把结果当 JS 编译
    const decoded = attr.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    let received = null;
    const doDeleteUser = (id, name) => { received = name; };
    eval("doDeleteUser('u1','" + decoded + "')");
    if (globalThis.__pwned) { console.log("PWNED"); process.exit(1); }
    if (received !== evil) { console.log("MANGLED:" + received); process.exit(1); }
    console.log("OK");
    """
    result = subprocess.run(
        [node, "-e", defs + "\n" + probe], text=True, capture_output=True, check=False)
    assert result.returncode == 0, f"{result.stdout}{result.stderr}"
    assert "OK" in result.stdout
