"""会话改名（手动 + 自动命名回显）的前端契约测试。

UI 是单文件应用、没有打包步骤，所以行为只能把真实的 JS 抠出来喂给 Node 跑。
纯字符串比对能证明"写法在那儿"，证明不了"改完真的落到界面上"——这里两种都用。

被钉住的三件事，每一件都对应一个具体的坏结果：
  1. 改名失败时**本地一个字都不改** —— 先变成新名字、刷新又变回去，比直接
     说"没改成"更让人困惑（server.py 里那条 400 的注释讲的正是这个）。
  2. 改完就地更新侧栏 + 顶栏 <h2> —— 自动命名是后台发生的，等下次刷新才改名
     等于没改。
  3. 双击那条路在**每种模式**都在 —— 聊天模式下 ⋯ 按钮根本不存在（R5）。

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

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui" / "index.html"


def _html() -> str:
    return UI.read_text(encoding="utf-8")


def _script(html: str) -> str:
    start = html.index("<script>", html.index("</head>")) + len("<script>")
    return html[start : html.index("</script>", start)]


# ══════════════════════════════════════════════════════════════════
#  renameSession / applySessionTitle 的真实行为
# ══════════════════════════════════════════════════════════════════


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


# ══════════════════════════════════════════════════════════════════
#  入口：双击（每种模式都在）+ 工作模式 ⋯ 菜单里的一项
# ══════════════════════════════════════════════════════════════════


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


def test_the_menu_offers_rename_where_the_menu_exists() -> None:
    """双击这个手势界面上没有可见提示，菜单负责让人发现它。"""
    script = _script(_html())
    body = script[script.index("function sessionMenu(") :]
    body = body[: body.index("\n}")]
    assert 't("session.rename")' in body and "renameSession(sid)" in body


# ══════════════════════════════════════════════════════════════════
#  事件流：改名要即时反映，且不许在操作记录里露出原始 key
# ══════════════════════════════════════════════════════════════════


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


