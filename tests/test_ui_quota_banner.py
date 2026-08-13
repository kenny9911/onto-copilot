"""前端额度提醒条的契约测试（契约 C 第 5 节）。

UI 是单文件应用、没有打包步骤，所以这里两种手段都用：形状用字符串断言钉住
（提醒条挂在哪、用了哪些颜色 token），文案与分支行为把真实的 JS 抠出来喂给
Node 跑一遍 —— 只比对字符串证明不了"三种事件真的画出三种东西"。

这一组里最要紧的是 C4：`budget.capped`（我们自己在设置里设的花费闸）绝不能
说成"余额不足 / 去充值"。说错了，用户会跑去给一个根本没欠费的网关账户充钱，
回来发现还是跑不动 —— 钱花了、问题一点没解决。
"""

from __future__ import annotations

import json
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


def _dicts(script: str) -> tuple[str, str]:
    zh, en = script.index("\n  zh: {"), script.index("\n  en: {")
    assert zh < en, "字典顺序变了，下面的切片就不对了"
    en_block = script[en:]
    return script[zh:en], en_block[: en_block.index("\n};")]


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


def test_the_bar_never_auto_dismisses_itself() -> None:
    """一条飘过去三秒的提示等于没提示：他很可能正盯着别的窗口等这一轮跑完。

    所以这一段里不许有定时器 —— 它只能因为**证据**消失（网关又成功回了一次）
    或用户自己按掉。
    """
    section = _cut(_script(_html()), "let QUOTA = null;", "// ── 上传与启动")
    for timer in ("setTimeout", "setInterval", "animation", "fadeOut"):
        assert timer not in section, f"提醒条里出现了 {timer}，它又变成 toast 了"


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


def _harness() -> str:
    sc = _script(_html())
    nfmt = sc[sc.index("function nfmt(n){") :]
    nfmt = nfmt[: nfmt.index("\n}\n") + 3]
    return (
        _HARNESS
        .replace("__I18N__", _cut(sc, "const I18N = {", "let LANG ="))
        .replace("__T__", _cut(sc, "function t(key, fallback, vars){", "\n// ──"))
        .replace("__ESC__", _cut(sc, "const esc =", "const j = async"))
        .replace("__NFMT__", nfmt)
        # 声明和函数**隔了一千两百行**：声明被刻意挪到文件顶上（那儿有注释说明
        # 是为了躲 applyI18n 的 TDZ），函数留在原处。一刀切到底会把中间整段工具
        # 代码卷进来，跟 harness 的桩撞成一片重复声明。
        .replace("__QUOTA_DECL__", _cut(sc, "let QUOTA = null;", "\nconst $ = "))
        .replace("__QUOTA__", _cut(sc, "function noteQuota(ev){", "// ── 上传与启动"))
    )


def _run(body: str) -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "-"], input=_harness() + "\n" + body, text=True,
        capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_nothing_is_shown_until_something_actually_happens() -> None:
    """没事的时候它一格都不占 —— 一条常驻的空条会把顶栏推下去。"""
    out = _run('paintQuotaBar(); console.log(dump());')
    assert out["hidden"] is True
    assert out["html"] == ""


def test_gateway_exhausted_says_top_up_at_the_gateway_in_danger_colour() -> None:
    """S1：网关账户真的没钱了。这一条要说清"去哪儿解决"（网关，不是设置里）。"""
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now(), detail:"insufficient_quota"});
      console.log(dump());
    """)
    assert out["hidden"] is False
    assert "bad" in out["cls"], "余额不足没有用危险色"
    assert "网关" in out["html"] and "充值" in out["html"]
    assert "insufficient_quota" in out["html"], "网关原文没带上，排查时无从下手"
    assert "上限" not in out["html"], "把网关欠费说成了本地上限"


def test_the_local_cap_is_never_described_as_an_unpaid_bill() -> None:
    """C4，这一组里最重要的一条。

    `budget.capped` 是我们自己在设置里设的闸。把它说成"余额不足 / 去充值"，
    用户会去给一个根本没欠费的账户充钱 —— 钱花了，问题一点没解决，回来还是
    跑不动。所以这一条必须①说清是"你自己设的上限"②给出真正的出口（设置页）
    ③一个网关账单方向的词都不出现。
    """
    out = _run("""
      noteQuota({kind:"budget.capped", ts: now(), cap: 5});
      console.log(dump());
    """)
    html = out["html"]
    assert out["hidden"] is False
    assert "bad" not in out["cls"], "本地上限用满不是危险状态，别染成欠费的红色"
    assert "上限" in html and "设置" in html
    assert "$5.00" in html, "没说清是多少钱的闸，用户不知道该往上调多少"
    for word in GATEWAY_MONEY_WORDS_ZH:
        assert word not in html, f"本地上限的文案里出现了「{word}」——会被读成网关欠费"
    # 光是"不提充值"还不够：他上一次撞见的很可能就是真欠费那条红条，
    # 两条长得像的话他还是会往充值那边想。得**明说**网关这次没事。
    assert "网关" in html and ("没有任何问题" in html or "没问题" in html), (
        "没澄清网关那边其实是好的")


def test_the_local_cap_offers_the_settings_page_that_actually_fixes_it() -> None:
    """出口要是"能解决这件事的那个地方"：本地闸的出口在设置里，不在网关。"""
    out = _run("""
      noteQuota({kind:"budget.capped", ts: now(), cap: 5});
      const m = BAR.innerHTML.match(/onclick="(openSettings\\(\\))"/);
      if (m) eval(m[1]);
      console.log(JSON.stringify({opened: SETTINGS_OPENED, html: BAR.innerHTML}));
    """)
    assert out["opened"] == 1, "「去设置」按钮不在，或者点了没反应"


def test_a_low_balance_names_the_number_it_is_worried_about() -> None:
    """S2：查得到余额且偏低。"可能跑不完"必须带上那个数，否则用户没法判断
    是该充钱还是可以直接跑。"""
    out = _run("""
      noteQuota({kind:"quota.low", ts: now(), remaining: 1.5});
      console.log(dump());
    """)
    assert "$1.50" in out["html"]
    assert "bad" not in out["cls"], "余额偏低只是提醒，不是已经停摆"


def test_a_low_balance_without_a_number_does_not_invent_one() -> None:
    """C1 在提醒条上的形态：数字缺席时回落到不带数的那句。

    模板里的 `{v}` 没填就会原样上屏（"只剩 {v}"），显示 $0.00 更糟 ——
    那是"钱花光了"，跟"我不知道还剩多少"是两回事。
    """
    out = _run("""
      noteQuota({kind:"quota.low", ts: now()});
      console.log(dump());
    """)
    html = out["html"]
    assert "{v}" not in html and "$0.00" not in html and "NaN" not in html
    assert "偏低" in html


def test_a_token_quota_is_not_dressed_up_as_dollars() -> None:
    """New-API 那一类返回的是 token 额度，不是美元。换算不确定就不加美元符号：
    "剩 $2.00"会让人以为还能跑几轮，而它可能连一次调用都不够。"""
    out = _run("""
      noteQuota({kind:"quota.low", ts: now(), remaining: 12000, currency:"TOKENS"});
      console.log(dump());
    """)
    assert "$" not in out["html"]
    assert "额度" in out["html"]


# ══════════════════════════════════════════════════════════════════
#  提醒条什么时候该消失 / 不该被降级
# ══════════════════════════════════════════════════════════════════
def test_a_successful_call_takes_the_bar_down() -> None:
    """清掉的判据是**证据**：网关刚成功回了一次，就说明它有钱了。"""
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now(), detail:"no credit"});
      clearQuota();
      console.log(dump());
    """)
    assert out["hidden"] is True and out["quota"] is None


def test_a_low_warning_does_not_downgrade_an_exhausted_bar() -> None:
    """两条事件先后到达时，"已经停摆"永远盖过"可能跑不完"。

    反过来会把一条红的"跑不动了"换成温和的黄条，用户以为还能接着等。
    """
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now(), detail:"no credit"});
      noteQuota({kind:"quota.low", ts: now(), remaining: 3});
      console.log(dump());
    """)
    assert out["quota"]["kind"] == "quota.exhausted"
    assert "bad" in out["cls"]


def test_replaying_an_old_event_does_not_raise_a_stale_alarm() -> None:
    """打开旧会话、SSE 断线重连都从 since=0 重放全部事件。

    三天前那次余额耗尽会原样再送一遍 —— 提醒条断言的是**此刻**的状态，
    隔夜的证据撑不起这句话。真没钱的话下一次调用几秒内就会把它重新竖起来。
    """
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now() - 3 * 86400, detail:"old"});
      console.log(dump());
    """)
    assert out["hidden"] is True and out["quota"] is None


def test_the_local_cap_notice_does_not_follow_you_into_another_session() -> None:
    """本地花费闸是"这一次运行"的事。换到另一个会话还挂着它就是句错话 ——
    那个会话一分钱都还没花。"""
    out = _run("""
      noteQuota({kind:"budget.capped", ts: now(), cap: 5});
      S = {id: "s2"};
      paintQuotaBar();
      console.log(dump());
    """)
    assert out["hidden"] is True and out["quota"] is None


def test_out_of_credit_cannot_be_swept_under_the_rug() -> None:
    """余额不足没有「关掉」：按掉它也照样跑不动，只是把坏消息藏起来。
    偏低和本地上限则可以关 —— 那两种情况下用户完全可能有别的打算。"""
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now(), detail:"no credit"});
      const hard = BAR.innerHTML;
      clearQuota();
      noteQuota({kind:"quota.low", ts: now(), remaining: 2});
      console.log(JSON.stringify({hard, soft: BAR.innerHTML}));
    """)
    assert "dismissQuota()" not in out["hard"], "余额不足竟然能被按掉"
    assert "dismissQuota()" in out["soft"]


def test_the_gateway_error_text_cannot_smuggle_markup_into_the_bar() -> None:
    """网关原文是外部输入，而这一行是拼进 innerHTML 的。

    一个自建 / 被接管的网关完全可以在报错文案里塞标签，用户只是跑了一次梳理。
    """
    out = _run("""
      noteQuota({kind:"quota.exhausted", ts: now(),
                 detail:'<img src=x onerror=alert(1)>'});
      console.log(dump());
    """)
    assert "<img" not in out["html"]
    assert "&lt;img" in out["html"]


# ══════════════════════════════════════════════════════════════════
#  设置页那一行余额（铁律 C1）
# ══════════════════════════════════════════════════════════════════
def _balance_run(payload: str) -> str:
    sc = _script(_html())
    program = (
        _harness()
        + "\n"
        + _cut(sc, "function balanceLine(b){", "function renderConfigForm()")
        + f"\nconsole.log(JSON.stringify({{line: balanceLine({payload})}}));"
    )
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run(
        [node, "-"], input=program, text=True,
        capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)["line"]


@pytest.mark.parametrize("payload", ['null', '{}', '{"known": false}',
                                     '{"known": false, "remaining": null}'])
def test_an_unknown_balance_says_so_instead_of_showing_zero(payload: str) -> None:
    """铁律 C1。多数网关根本没有余额接口，那是**常态不是故障**。

    这一行留空会被当成还没加载完（他会一直等），显示 0 会被当成钱花光了
    （他会去充一个根本不缺钱的账户）。两种都是假消息，所以只能明说查不到。
    """
    line = _balance_run(payload)
    assert line.strip(), "余额行留空了"
    assert "0" not in line
    assert "不提供" in line


def test_a_known_balance_shows_the_number_and_where_it_came_from() -> None:
    """查得到就把数摆出来，并注明是哪个端点给的 —— 网关五花八门，
    出入时得知道这个数该去哪儿核对。"""
    line = _balance_run(
        '{"known": true, "remaining": 12.5, "total": 50, "currency": "USD",'
        ' "source": "dashboard/billing"}')
    assert "$12.50" in line and "$50.00" in line
    assert "dashboard/billing" in line


def test_a_genuinely_empty_account_is_allowed_to_show_zero() -> None:
    """反过来的一半：真查到 0，那个 0 就是真的，不能被"查不到"盖掉。"""
    line = _balance_run('{"known": true, "remaining": 0, "currency": "USD"}')
    assert "$0.00" in line
    assert "不提供" not in line


def test_the_balance_row_sits_under_the_budget_section() -> None:
    """余额要挨着"上限"一起看才有意义：一个是网关还剩多少，一个是我们自己
    允许花多少，分开两屏就没人对得上。"""
    html = _html()
    budget = html.index('esc(t("settings.budget"))')
    assert html.index('esc(t("balance.label"))', budget) - budget < 1200


# ══════════════════════════════════════════════════════════════════
#  文案本身
# ══════════════════════════════════════════════════════════════════
def test_quota_keys_exist_in_both_dictionaries() -> None:
    """t() 缺 key 时**静默**回落到中文再回落到 key 本身 ——
    漏了 en 的表现是英文界面上冒出中文，不报错、不红。"""
    zh_block, en_block = _dicts(_script(_html()))
    for key in ("balance.label", "balance.unknown", "balance.remaining",
                "balance.ofTotal", "balance.quotaUnit", "balance.source",
                "quota.exhausted", "quota.exhaustedHint", "quota.low",
                "quota.lowGeneric", "quota.lowHint", "budget.capped",
                "budget.cappedAmount", "budget.cappedHint",
                "quota.openSettings", "quota.dismiss"):
        assert f'"{key}"' in zh_block, f"zh 少了 {key}"
        assert f'"{key}"' in en_block, f"en 少了 {key}"


def test_the_english_local_cap_copy_also_keeps_billing_out_of_it() -> None:
    """C4 对英文同样成立 —— 而且英文更容易滑过去："out of credit" 和
    "hit your cap" 在英文里读起来差不多，含义却完全相反。"""
    _, en_block = _dicts(_script(_html()))
    for key in ("budget.capped", "budget.cappedAmount", "budget.cappedHint"):
        value = en_block[en_block.index(f'"{key}"') :]
        value = value[value.index(":") + 1 : value.index("\n")].lower()
        for word in GATEWAY_MONEY_WORDS_EN:
            assert word not in value, f"en 的 {key} 里出现了「{word}」"
    hint = en_block[en_block.index('"budget.cappedHint"') :]
    hint = hint[: hint.index("\n")].lower()
    assert "settings" in hint, "没告诉英文用户这个闸在哪儿改"
    assert "gateway" in hint, "没澄清网关那边其实没问题"


def test_the_two_gateway_notices_do_point_at_the_gateway() -> None:
    """另一半也得钉住：真欠费时不能含糊成"额度用完了"，那会被当成本地闸，
    用户跑去设置里把上限调高，然后撞上同一堵墙。"""
    zh_block, en_block = _dicts(_script(_html()))
    for block, gateway in ((zh_block, "网关"), (en_block, "gateway")):
        for key in ("quota.exhausted", "quota.exhaustedHint", "quota.lowHint"):
            value = block[block.index(f'"{key}"') :]
            value = value[: value.index("\n")].lower()
            assert gateway.lower() in value, f"{key} 没点明是网关那边的事"


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
