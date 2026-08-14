"""侧栏项目文件夹的前端契约测试。

UI 是单文件应用、没有打包步骤，所以分组逻辑只能把真实的 JS 抠出来喂给 Node 跑。
纯字符串比对只能证明"写法在那儿"，证明不了"分组分对了"——这里两种都用：
形状用断言钉，行为用 Node 跑。

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


_HARNESS = """
const API = "";
let MODE = "work", PROJECTS = [], PROJECTS_OK = true, SESSION_LIST = [], S = null;
let PJ_OFF = new Set();
let FETCHED = 0;
globalThis.localStorage = {setItem(){}, getItem(){ return null; }};
// t() 在这里退化成"回显 key"——这些测试关心的是分组结构，不是文案本身
const t = (k, f, v) => {
  let s = String(k);
  if (v) for (const x in v) s = s.split("{" + x + "}").join(String(v[x]));
  return s;
};
const statusText = s => String(s);
const fmtWhen = x => String(x);
const DOM = {convs: {innerHTML: ""}, pjnewBtn: {hidden: true}};
const $ = id => DOM[id];
__SIDEBAR__
"""


# ══════════════════════════════════════════════════════════════════
#  R5：聊天模式完全不进项目
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  渐进部署：后端还没有 /api/projects 时不许白屏、不许弹错
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  分组本身
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  文案
# ══════════════════════════════════════════════════════════════════


def test_the_drop_target_is_visible_while_dragging() -> None:
    """看不出会掉进哪儿的拖拽，用户第一次就不敢松手。"""
    html = _html()
    assert ".pjhead.dragover" in html and ".conv.dragging" in html


