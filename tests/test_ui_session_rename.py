"""会话改名（手动 + 自动命名回显）的前端契约测试。

UI 是单文件应用、没有打包步骤，所以行为只能把真实的 JS 抠出来喂给 Node 跑。
纯字符串比对能证明"写法在那儿"，证明不了"改完真的落到界面上"——这里两种都用。

被钉住的三件事，每一件都对应一个具体的坏结果：
  1. 改名失败时**本地一个字都不改** —— 先变成新名字、刷新又变回去，比直接
     说"没改成"更让人困惑（server.py 里那条 400 的注释讲的正是这个）。
  2. 改完就地更新侧栏 + 顶栏 <h2> —— 自动命名是后台发生的，等下次刷新才改名
     等于没改。
  3. 双击那条路在**每种模式**都在 —— 聊天模式下 ⋯ 按钮根本不存在（R5）。
"""

from __future__ import annotations

import json
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


def _node(program: str) -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "-"], input=program, text=True, capture_output=True, check=False
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ══════════════════════════════════════════════════════════════════
#  renameSession / applySessionTitle 的真实行为
# ══════════════════════════════════════════════════════════════════
def _rename_js() -> str:
    """改名那一段的真身。"""
    script = _script(_html())
    start = script.index("const SESSION_TITLE_MAX")
    return script[start : script.index("// moveSid：")]


_HARNESS = """
let SESSION_LIST = [{id:"s1", title:"新会话"}], S = {id:"s1", title:"新会话"};
let PAINTS = 0, ALERTS = [], CALLS = [], PROMPT = null, FAIL = false, REPLY = {};
const DOM = {title: {textContent: "新会话"}};
const $ = id => DOM[id];
const t = k => String(k);
const paintSessions = () => { PAINTS++; };
const alert = m => { ALERTS.push(String(m)); };
const prompt = (msg, def) => PROMPT;
const j = async (u, o) => {
  CALLS.push({u, method: o.method, body: JSON.parse(o.body)});
  if (FAIL) throw new Error("400 改标题还没接上");
  return REPLY;
};
const report = () => console.log(JSON.stringify({
  calls: CALLS, alerts: ALERTS, paints: PAINTS,
  row: SESSION_LIST[0].title, cur: S.title, head: DOM.title.textContent,
}));
__RENAME__
"""


def _run(body: str) -> dict:
    return _node(_HARNESS.replace("__RENAME__", _rename_js()) + "\n" + body)


def test_renaming_sends_the_patch_and_updates_every_place_the_title_shows() -> None:
    """标题同时出现在侧栏行、顶栏 <h2>、和内存里那个当前会话对象。

    漏掉任何一处，用户看到的就是"改了一半"——最常见的是顶栏还挂着「新会话」。
    """
    out = _run("""PROMPT = "采购计划管理实体"; renameSession("s1").then(report);""")
    assert len(out["calls"]) == 1
    call = out["calls"][0]
    assert call["method"] == "PATCH"
    assert call["u"] == "/api/sessions/s1"
    assert call["body"] == {"title": "采购计划管理实体"}
    assert out["row"] == "采购计划管理实体"
    assert out["cur"] == "采购计划管理实体"
    assert out["head"] == "采购计划管理实体", "顶栏标题没跟着改"
    assert out["paints"] == 1
    assert out["alerts"] == []


def test_a_backend_that_still_rejects_titles_leaves_the_name_untouched() -> None:
    """前端可以先于后端上线：那条 PATCH 现在对 title 就是 400。

    这时候唯一正确的反应是**什么都不改**并说一声。乐观更新在这里是有害的 ——
    名字会先变、下次刷新又变回去，用户以为是自己点错了。
    """
    out = _run("""FAIL = true; PROMPT = "新名字"; renameSession("s1").then(report);""")
    assert out["row"] == "新会话" and out["cur"] == "新会话"
    assert out["head"] == "新会话"
    assert out["paints"] == 0, "失败了还重画，说明本地已经改过了"
    assert out["alerts"] == ["session.renameFailed"]


def test_cancelling_or_keeping_the_same_name_costs_nothing() -> None:
    """取消（prompt 返回 null）、清空、原样确认，都不该发请求。

    原样确认尤其要挡：它会把标题写进服务端，于是"用户手动改过"这个状态被点亮，
    此后再也不会自动命名 —— 而用户其实只是打开看了看就按了确定。
    """
    for setup in ('PROMPT = null;', 'PROMPT = "   ";', 'PROMPT = "新会话";',
                  'PROMPT = "  新会话  ";'):
        out = _run(setup + """ renameSession("s1").then(report);""")
        assert out["calls"] == [], setup
        assert out["paints"] == 0, setup


def test_the_stored_title_wins_over_the_one_that_was_typed() -> None:
    """服务端会再规范化一次（折空白、去首尾），PATCH 回的 brief 里是**存下的**那个。

    照着本地那份贴，界面上就会出现一个服务端并没有存下的样子，下次刷新又变 ——
    正是那种"改了又没改"的困惑。
    """
    out = _run("""
      REPLY = {id:"s1", title:"服务端规范化过的名字"};
      PROMPT = "我 敲 的"; renameSession("s1").then(report);
    """)
    assert out["row"] == "服务端规范化过的名字"
    assert out["head"] == "服务端规范化过的名字"


def test_whitespace_is_folded_the_same_way_the_server_folds_it() -> None:
    """标题里的换行会把侧栏那一行撑成两行，而它在标题里没有任何意义。"""
    out = _run("""PROMPT = "  采购计划\\n  管理  "; renameSession("s1").then(report);""")
    assert out["calls"][0]["body"] == {"title": "采购计划 管理"}


def test_an_overlong_title_is_trimmed_before_it_is_sent() -> None:
    """服务端要挡超长；在这里先截断，用户当场就看得到"最后叫什么"，
    而不是提交完被一个 400 顶回来、名字还是旧的。"""
    out = _run("""PROMPT = "长".repeat(400); renameSession("s1").then(report);""")
    assert len(out["calls"][0]["body"]["title"]) == 120
    assert out["row"] == "长" * 120


def test_the_auto_name_lands_without_a_round_trip() -> None:
    """自动命名由服务端在上传/回答之后做，前端只收到一条事件。

    applySessionTitle 必须能独立把它贴上去（不重新拉一次会话列表）——
    否则侧栏要等到下次刷新才改名，等于没改。
    """
    out = _run("""applySessionTitle("s1", "采购计划管理-v2"); report();""")
    assert out["calls"] == [], "自动命名回显不该再发一次网络请求"
    assert out["row"] == "采购计划管理-v2" and out["head"] == "采购计划管理-v2"
    assert out["paints"] == 1


def test_renaming_another_session_never_touches_the_top_bar() -> None:
    """顶栏那个 <h2> 只代表**当前**会话。

    自动命名可能发生在任意一条会话上（多 worker、多标签页），把别人的名字贴到
    顶栏是一个看起来像"会话被切走了"的假象。
    """
    out = _run("""
      SESSION_LIST.push({id:"s2", title:"新会话"});
      applySessionTitle("s2", "另一条");
      console.log(JSON.stringify({
        calls: CALLS, alerts: ALERTS, paints: PAINTS,
        row: SESSION_LIST[1].title, cur: S.title, head: DOM.title.textContent}));
    """)
    assert out["row"] == "另一条"
    assert out["head"] == "新会话" and out["cur"] == "新会话"


def test_an_unchanged_title_does_not_repaint_the_sidebar() -> None:
    """重连时 since=0 会把全部事件原样重放一遍（包括那条改名）。

    每重连一次就重画一次侧栏 = 每次网络抖动列表闪一下，还会打断正在进行的
    拖拽。名字没变就什么都不做。
    """
    out = _run("""applySessionTitle("s1", "新会话"); report();""")
    assert out["paints"] == 0


# ══════════════════════════════════════════════════════════════════
#  入口：双击（每种模式都在）+ 工作模式 ⋯ 菜单里的一项
# ══════════════════════════════════════════════════════════════════
def _sidebar_js() -> str:
    script = _script(_html())
    escapers = script[script.index("const esc =") : script.index("const j = async")]
    sidebar = script[
        script.index("function paintSessions(){") : script.index("function closePopMenu()")
    ]
    return escapers + "\n" + sidebar


def test_a_chat_session_can_still_be_renamed_although_it_has_no_menu() -> None:
    """R5 不许聊天模式的侧栏出现任何项目痕迹，那颗 ⋯ 按钮也就不在。

    而「每个会话都叫新对话」在聊天模式里一样成立 —— 所以入口选的是双击标题：
    它是唯一一条两种模式都走得通的路。
    """
    out = _node(_HARNESS_SIDEBAR.replace("__SIDEBAR__", _sidebar_js()) + """
      MODE = "chat"; PROJECTS_OK = false;
      SESSION_LIST = [{id:"s1", title:"新对话", files:0, status:"ready"}];
      paintSessions();
      console.log(JSON.stringify({html: DOM.convs.innerHTML}));
    """)
    html = out["html"]
    assert "sessionMenu" not in html, "聊天模式又长出了工作模式的 ⋯"
    assert "renameSession('s1')" in html, "聊天模式下没有任何改名入口"
    assert "ondblclick" in html


_HARNESS_SIDEBAR = """
const API = "";
let MODE = "work", PROJECTS = [], PROJECTS_OK = true, SESSION_LIST = [], S = null;
let PJ_OFF = new Set();
globalThis.localStorage = {setItem(){}, getItem(){ return null; }};
const t = (k, f, v) => String(k);
const statusText = s => String(s);
const fmtWhen = x => String(x);
const DOM = {convs: {innerHTML: ""}, pjnewBtn: {hidden: true}};
const $ = id => DOM[id];
__SIDEBAR__
"""


def test_a_hostile_session_id_cannot_break_out_of_the_dblclick_handler() -> None:
    """会话 id 拼进了一个内联处理器的字符串字面量里。

    照浏览器的真实顺序验一遍：解码属性 → 当 JS 编译。这条和 dropSession 那边
    是同一个陷阱，新写的处理器同样要用 earg。
    """
    script = _script(_html())
    defs = script[script.index("const esc =") : script.index("const earg =") + 200]
    defs = defs[: defs.index("\n", defs.index("const earg ="))]
    out = _node(defs + r"""
      const evil = "x','');globalThis.__pwned=1;//";
      const decoded = earg(evil).replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      let got = null;
      const renameSession = sid => { got = sid; };
      eval("renameSession('" + decoded + "')");
      console.log(JSON.stringify({pwned: !!globalThis.__pwned, got}));
    """)
    assert out["pwned"] is False
    assert out["got"] == "x','');globalThis.__pwned=1;//"


def test_the_menu_offers_rename_where_the_menu_exists() -> None:
    """双击这个手势界面上没有可见提示，菜单负责让人发现它。"""
    script = _script(_html())
    body = script[script.index("function sessionMenu(") :]
    body = body[: body.index("\n}")]
    assert 't("session.rename")' in body and "renameSession(sid)" in body


def test_the_row_hints_that_the_title_is_editable() -> None:
    html = _html()
    assert 'title="${eattr(t("session.renameTip"))}"' in html


# ══════════════════════════════════════════════════════════════════
#  事件流：改名要即时反映，且不许在操作记录里露出原始 key
# ══════════════════════════════════════════════════════════════════
def test_the_rename_event_is_wired_into_the_stream() -> None:
    """服务端自动命名完发一条事件；不接的话侧栏要等下次刷新才改名。"""
    script = _script(_html())
    assert 'if (ev.kind === "session.renamed") applySessionTitle(' in script
    # 服务端发的是 {id, title}；事件走当前会话那条流，缺 id 时说的就是当前这条
    assert "ev.id || S.id" in script


def test_the_rename_events_have_chinese_labels() -> None:
    """漏一条标签，操作记录里就直接冒出 `session.renamed` 这种原始 key。"""
    labels = _script(_html())
    labels = labels[labels.index("const EV_LABEL = {") :]
    labels = labels[: labels.index("\n};")]
    assert '"session.renamed"' in labels
    assert '"session.rename_failed"' in labels


def test_a_failed_auto_naming_looks_like_a_failure() -> None:
    """自动命名失败发的是 `session.rename_failed` —— 下划线，不是点号。

    evTag 原来只认 `.failed`，于是这条会和一屏灰色的普通事件长得一模一样，
    等于没报。
    """
    script = _script(_html())
    body = script[script.index("function evTag(") :]
    body = body[: body.index("\n}")]
    assert 'k.endsWith("_failed")' in body


# ══════════════════════════════════════════════════════════════════
#  文案
# ══════════════════════════════════════════════════════════════════
def test_the_default_titles_this_ui_creates_are_the_ones_the_server_calls_default() -> None:
    """自动命名只在"标题还是默认值"时接管，而**默认值是这个文件写死的**
    （newSession 用 `session.newChat` / `session.newWork`）。

    这两处一旦对不上，表现是完全静默的：会话照建，名字永远停在「新会话」，
    没有任何报错。改文案的人不会想到去看 server.py 那张集合。
    """
    script = _script(_html())
    src = (ROOT / "src" / "ontocopilot" / "server.py").read_text(encoding="utf-8")
    if "_DEFAULT_TITLES = frozenset({" not in src:
        pytest.skip("服务端没有这张默认标题集合（自动命名的判据换了写法）")
    start = src.index("_DEFAULT_TITLES = frozenset({")
    defaults = src[start : src.index("})", start)]
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    blocks = (script[zh:en], script[en:][: script[en:].index("\n};")])
    for block in blocks:
        for key in ("session.newChat", "session.newWork"):
            value = block[block.index(f'"{key}":"') + len(key) + 4 :]
            value = value[: value.index('"')]
            assert f'"{value}"' in defaults, f"{key}「{value}」不在服务端的默认标题集合里"


def test_rename_keys_exist_in_both_dictionaries() -> None:
    """t() 缺 key 时**静默**回落到中文 —— 漏了 en 的表现是英文界面冒出中文，
    不报错、不红。"""
    script = _script(_html())
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    assert zh < en, "字典顺序变了，下面的切片就不对了"
    zh_block, en_block = script[zh:en], script[en:]
    en_block = en_block[: en_block.index("\n};")]
    for key in ("session.rename", "session.renamePrompt", "session.renameTip",
                "session.renameFailed"):
        assert f'"{key}"' in zh_block, f"zh 少了 {key}"
        assert f'"{key}"' in en_block, f"en 少了 {key}"
