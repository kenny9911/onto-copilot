"""前端额度提醒条的契约测试（契约 C 第 5 节）。

UI 是单文件应用、没有打包步骤，所以这里两种手段都用：形状用字符串断言钉住
（提醒条挂在哪、用了哪些颜色 token），文案与分支行为把真实的 JS 抠出来喂给
Node 跑一遍 —— 只比对字符串证明不了"三种事件真的画出三种东西"。

这一组里最要紧的是 C4：`budget.capped`（我们自己在设置里设的花费闸）绝不能
说成"余额不足 / 去充值"。说错了，用户会跑去给一个根本没欠费的网关账户充钱，
回来发现还是跑不动 —— 钱花了、问题一点没解决。

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

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui" / "index.html"

# "去网关交钱"这条线上的词。budget.capped 的文案里出现任何一个都是 C4 被破坏 ——
# 它们把一个本地开关说成了一张账单。
# 注意只列**动作/指控**词：文案里出现"网关账户没有任何问题"这类澄清是好事，
# 所以"账户""余额"这种中性名词不能一刀切地禁掉。
GATEWAY_MONEY_WORDS_ZH = ("充值", "余额不足", "欠费", "没钱", "补一点", "付款")
GATEWAY_MONEY_WORDS_EN = ("top up", "top-up", "out of credit", "insufficient",
                          "run dry", "recharge", "add a little")


def _html() -> str:
    return UI.read_text(encoding="utf-8")


def _script(html: str) -> str:
    start = html.index("<script>", html.index("</head>")) + len("<script>")
    return html[start : html.index("</script>", start)]


def _cut(script: str, start: str, end: str) -> str:
    """截一段源码。end 从 start 之后找 —— 分隔符（`// ──` 这类）在文件里满地都是。"""
    a = script.index(start)
    return script[a : script.index(end, a)]


# ══════════════════════════════════════════════════════════════════
#  形状：常驻条，不是 toast
# ══════════════════════════════════════════════════════════════════
def test_the_notice_is_a_persistent_bar_under_the_header() -> None:
    """余额不足是"不处理就一直干不了活"的状态，不是一条可以飘走的通知。

    位置也是语义的一部分：挂在 .mhead 下方、消息流上方，用户往下读消息时
    它一直在视野边上；塞进消息流里的话，多滚两屏就再也看不见了。
    """
    html = _html()
    assert '<div class="qbar" id="quotaBar" hidden></div>' in html
    head_end = html.index("</div>", html.index('<div class="mhead">'))
    bar = html.index('id="quotaBar"')
    stream = html.index('<div class="stream" id="stream">')
    assert head_end < bar < stream, "提醒条不在 mhead 与消息流之间"


def _qbar_css() -> str:
    """`.qbar` 那一整段规则（含续行）。第一条规则起，到不再属于它的选择器为止。"""
    lines = _html().splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith(".qbar{"))
    out: list[str] = []
    for ln in lines[start:]:
        if ln.startswith(".") and not ln.startswith(".qbar"):
            break
        out.append(ln)
    return "\n".join(out)


def test_the_bar_only_reuses_existing_color_tokens() -> None:
    """配色不引入新颜色：深浅两套主题都已经为这几个 token 校过对比度，
    临时写死一个色号在深色模式下多半是不可读的。"""
    css = _qbar_css()
    allowed = {"--warn-tint", "--warn", "--warn-line", "--danger-tint", "--danger",
               "--line-soft", "--line", "--hover", "--ink", "--ink-2", "--ink-3",
               "--mono", "--panel"}
    used = set(re.findall(r"var\((--[a-z0-9-]+)", css))
    assert used <= allowed, f"提醒条用了预期之外的 token：{used - allowed}"
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b", css), "提醒条里写死了颜色"


# ══════════════════════════════════════════════════════════════════
#  行为：三种事件三种文案
# ══════════════════════════════════════════════════════════════════
_HARNESS = """
globalThis.localStorage = {getItem(){ return null; }, setItem(){}};
__I18N__
let LANG = "zh";
__T__
__ESC__
__NFMT__
let S = {id: "s1"};
const BAR = {hidden: true, innerHTML: "", className: ""};
const $ = id => (id === "quotaBar" ? BAR : null);
let SETTINGS_OPENED = 0;
function openSettings(){ SETTINGS_OPENED++; }
__QUOTA_DECL__
__QUOTA__
const dump = () => JSON.stringify(
  {hidden: BAR.hidden, html: BAR.innerHTML, cls: BAR.className, quota: QUOTA});
const now = () => Math.floor(Date.now() / 1000);
"""


# ══════════════════════════════════════════════════════════════════
#  提醒条什么时候该消失 / 不该被降级
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  设置页那一行余额（铁律 C1）
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  文案本身
# ══════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════
#  别把刚调好的东西带塌
# ══════════════════════════════════════════════════════════════════
def test_the_layout_variables_this_feature_must_not_touch_are_intact() -> None:
    """提醒条只是往 mhead 下面插一层。排版变量和项目侧栏跟它没有关系，
    这条在这儿是防"顺手改一改"。"""
    html = _html()
    for token in ("--col:", ".bub:has(.mdtw)", "function paintSessions()"):
        assert token in html, f"{token} 没了"


def test_ui_javascript_parses_with_node() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "--check"], input=_script(_html()), text=True,
        capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
