// @vitest-environment happy-dom
/**
 * 额度提醒条的契约（契约 C 第 5 节）—— 从 tests/test_ui_quota_banner.py 逐条移过来，
 * 前端换成 React 之后**换了表述、一条没删**。
 *
 * 原来那份 Python 是「把 ui/index.html 的内联 JS 按源码文本锚点切一段喂给 node」，
 * 前端有了构建步骤之后那套办法就不成立了。上一版直接调 `paintQuotaBar()` 再读
 * `#quotaBar` 的 innerHTML；条子改由 <QuotaBar> 画之后，判据换成「把组件渲染进
 * index.html 里那个真容器，看渲染结果」—— **要保的东西一个字没变**（三种事件三种
 * 文案、危险色、能不能按掉、原文里的标签不许成元素），只是问的方式从「拼出了什么
 * 字符串」变成「画出了什么 DOM」，后者才是用户真正看到的东西。
 * 只有三条留在字符串断言上，因为它们钉的本来就不是组件的行为：
 * 提醒条挂在 HTML 的哪个位置、`.qbar` 用了哪些颜色 token、构建产物能不能被解析。
 *
 * 这一组里最要紧的是 C4：`budget.capped`（我们自己在设置里设的花费闸）绝不能
 * 说成「余额不足 / 去充值」。说错了，用户会去给一个根本没欠费的网关账户充钱 ——
 * 钱花了、问题一点没解决，回来还是跑不动。
 *
 * **environment 用文件头的 docblock 指定**：这个文件要一个真 DOM（组件要挂上去），
 * 而别的 UI 测试跑在 test/ui.env.ts 那个手写 stub 上，全局切会把它们一起改掉。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// 「去设置」按下去到底调没调 openSettings —— 内联处理器没有了，判据是**真的调用**。
vi.mock("../src/ui/settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/settings.js")>();
  return { ...actual, openSettings: vi.fn() };
});

import { G } from "../src/ui/state.js";
import { I18N } from "../src/ui/i18n.js";
import { clearQuota, dismissQuota, noteQuota, paintQuotaBar } from "../src/ui/quota.js";
import { balanceLine, openSettings } from "../src/ui/settings.js";
import { QuotaBar } from "../src/ui/react/quota.js";
import { ConfigForm } from "../src/ui/react/settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const html = () => readFileSync(resolve(ROOT, "ui/index.html"), "utf8");
/** 提醒条那一段的**全部**源码：判据在 quota.ts，样子在 react/quota.tsx。 */
const quotaSrc = () => readFileSync(resolve(ROOT, "ts/src/ui/quota.ts"), "utf8")
  + readFileSync(resolve(ROOT, "ts/src/ui/react/quota.tsx"), "utf8");

/** 页面里那一整段打包好的 JS（`</head>` 之后那个 script）。 */
function pageScript(): string {
  const h = html();
  const start = h.indexOf("<script>", h.indexOf("</head>")) + "<script>".length;
  return h.slice(start, h.indexOf("</script>", start));
}

const now = () => Math.floor(Date.now() / 1000);
const bar = (): any => document.getElementById("quotaBar");

// 「去网关交钱」这条线上的词。budget.capped 的文案里出现任何一个都是 C4 被破坏 ——
// 它们把一个本地开关说成了一张账单。
// 注意只列**动作/指控**词：文案里出现「网关账户没有任何问题」这类澄清是好事，
// 所以「账户」「余额」这种中性名词不能一刀切地禁掉。
const GATEWAY_MONEY_WORDS_ZH = ["充值", "余额不足", "欠费", "没钱", "补一点", "付款"];
const GATEWAY_MONEY_WORDS_EN = ["top up", "top-up", "out of credit", "insufficient",
  "run dry", "recharge", "add a little"];

beforeEach(() => {
  vi.clearAllMocks();
  G.LANG = "zh";
  G.QUOTA = null;
  G.S = { id: "s1" };
  G.CONFIG = null;
  G.CURRENT_USER = { role: "admin" };
  G.SET_TAB = "system";
  // index.html 里这个元素是 `<div class="qbar" id="quotaBar" hidden>` —— 页面一进来
  // 就是收起的。这里按原样立起来，组件挂进的就是**它**（portal 在真页面上也是
  // 挂进这一个），于是「容器自己的 class 与 hidden」也一并被测到。
  document.body.innerHTML = '<div class="qbar" id="quotaBar" hidden></div>';
  render(<QuotaBar />, { container: bar() });
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  形状：常驻条，不是 toast
// ══════════════════════════════════════════════════════════════════
describe("形状", () => {
  it("提醒条是挂在 .mhead 与消息流之间的常驻条，不是 toast", () => {
    // 余额不足是「不处理就一直干不了活」的状态，不是一条可以飘走的通知。
    // 位置也是语义的一部分：用户往下读消息时它一直在视野边上；塞进消息流里的话，
    // 多滚两屏就再也看不见了。
    const h = html();
    expect(h).toContain('<div class="qbar" id="quotaBar" hidden></div>');
    const headEnd = h.indexOf("</div>", h.indexOf('<div class="mhead">'));
    const barAt = h.indexOf('id="quotaBar"');
    const stream = h.indexOf('<div class="stream" id="stream"');
    expect(headEnd).toBeLessThan(barAt);
    expect(barAt).toBeLessThan(stream);
  });

  it("它不会自己飘走 —— 这一段里一个定时器都没有", () => {
    // 一条飘过去三秒的提示等于没提示：他很可能正盯着别的窗口等这一轮跑完。
    // 它只能因为**证据**消失（网关又成功回了一次）或用户自己按掉。
    const src = quotaSrc();
    for (const timer of ["setTimeout", "setInterval", "animation", "fadeOut"])
      expect(src, `提醒条里出现了 ${timer}，它又变成 toast 了`).not.toContain(timer);
  });

  it("配色只复用现有的颜色 token，不写死色号", () => {
    // 深浅两套主题都已经为这几个 token 校过对比度，临时写死一个色号在深色模式下
    // 多半是不可读的。
    const lines = html().split("\n");
    const start = lines.findIndex((ln) => ln.startsWith(".qbar{"));
    expect(start).toBeGreaterThan(-1);
    const block: string[] = [];
    for (const ln of lines.slice(start)) {
      if (ln.startsWith(".") && !ln.startsWith(".qbar")) break;
      block.push(ln);
    }
    const css = block.join("\n");
    const allowed = new Set(["--warn-tint", "--warn", "--warn-line", "--danger-tint",
      "--danger", "--line-soft", "--line", "--hover", "--ink", "--ink-2", "--ink-3",
      "--mono", "--panel"]);
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.filter((v) => !allowed.has(v))).toEqual([]);
    expect(/#[0-9a-fA-F]{3,6}\b/.test(css), "提醒条里写死了颜色").toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  行为：三种事件三种文案
// ══════════════════════════════════════════════════════════════════
describe("三种事件三种文案", () => {
  it("没事的时候一格都不占", () => {
    // 一条常驻的空条会把顶栏推下去。
    act(() => { paintQuotaBar(); });
    expect(bar().hidden).toBe(true);
    expect(bar().innerHTML).toBe("");
  });

  it("S1 网关真没钱：危险色 + 指向网关 + 带上原文", () => {
    act(() => { noteQuota({ kind: "quota.exhausted", ts: now(), detail: "insufficient_quota" }); });
    const b = bar();
    expect(b.hidden).toBe(false);
    expect(b.className, "余额不足没有用危险色").toContain("bad");
    expect(b.textContent).toContain("网关");
    expect(b.textContent).toContain("充值");
    expect(b.textContent, "网关原文没带上，排查时无从下手").toContain("insufficient_quota");
    expect(b.textContent, "把网关欠费说成了本地上限").not.toContain("上限");
  });

  it("C4：本地花费闸绝不能被说成一张没付的账单", () => {
    // 这一组里最重要的一条。`budget.capped` 是我们自己在设置里设的闸。把它说成
    // 「余额不足 / 去充值」，用户会去给一个根本没欠费的账户充钱 —— 钱花了、问题
    // 一点没解决。所以必须①说清是「你自己设的上限」②给出真正的出口（设置页）
    // ③一个网关账单方向的词都不出现。
    act(() => { noteQuota({ kind: "budget.capped", ts: now(), cap: 5 }); });
    const b = bar();
    expect(b.hidden).toBe(false);
    expect(b.className, "本地上限用满不是危险状态，别染成欠费的红色").not.toContain("bad");
    expect(b.textContent).toContain("上限");
    expect(b.textContent).toContain("设置");
    expect(b.textContent, "没说清是多少钱的闸，用户不知道该往上调多少").toContain("$5.00");
    for (const word of GATEWAY_MONEY_WORDS_ZH)
      expect(b.textContent, `本地上限的文案里出现了「${word}」—— 会被读成网关欠费`)
        .not.toContain(word);
    // 光是「不提充值」还不够：他上一次撞见的很可能就是真欠费那条红条，两条长得像的话
    // 他还是会往充值那边想。得**明说**网关这次没事。
    expect(b.textContent).toContain("网关");
    expect(/没有任何问题|没问题/.test(b.textContent), "没澄清网关那边其实是好的").toBe(true);
  });

  it("C4：本地闸给的出口是真能解决这件事的那个地方（设置页）", () => {
    act(() => { noteQuota({ kind: "budget.capped", ts: now(), cap: 5 }); });
    const btn = bar().querySelector("button.qact");
    expect(btn, "「去设置」按钮不在").not.toBe(null);

    // 旧世界里这里要验两头：处理器文本本身能不能跑，以及 bindGlobals 有没有把
    // openSettings 挂到全局 —— 因为按钮是 `onclick="openSettings()"`，浏览器在
    // 按下去那一刻才把它当全局作用域里的一段 JS 编译，名字没挂上就是个死按钮。
    // 组件化之后这两层都不存在了：处理器是一个**闭包**，直接验它调没调。
    fireEvent.click(btn);
    expect(openSettings, "点了没反应").toHaveBeenCalledTimes(1);
    // 顺带钉住那一整类 bug 的坟头：这块 DOM 里一个内联处理器属性都没有。
    expect(bar().innerHTML).not.toMatch(/\son[a-z]+=/);
  });

  it("S2 余额偏低：把担心的那个数摆出来，但不是危险状态", () => {
    // 「可能跑不完」必须带上那个数，否则用户没法判断是该充钱还是可以直接跑。
    act(() => { noteQuota({ kind: "quota.low", ts: now(), remaining: 1.5 }); });
    expect(bar().textContent).toContain("$1.50");
    expect(bar().className, "余额偏低只是提醒，不是已经停摆").not.toContain("bad");
  });

  it("C1：查不到数字就说不出数字，不许现编一个", () => {
    // 模板里的 `{v}` 没填就会原样上屏（「只剩 {v}」），显示 $0.00 更糟 ——
    // 那是「钱花光了」，跟「我不知道还剩多少」是两回事。
    act(() => { noteQuota({ kind: "quota.low", ts: now() }); });
    const h = bar().textContent;
    expect(h).not.toContain("{v}");
    expect(h).not.toContain("$0.00");
    expect(h).not.toContain("NaN");
    expect(h).toContain("偏低");
  });

  it("token 额度不许打扮成美元", () => {
    // New-API 那一类返回的是 token 额度，不是美元。换算不确定就不加美元符号：
    // 「剩 $2.00」会让人以为还能跑几轮，而它可能连一次调用都不够。
    act(() => { noteQuota({ kind: "quota.low", ts: now(), remaining: 12000, currency: "TOKENS" }); });
    expect(bar().textContent).not.toContain("$");
    expect(bar().textContent).toContain("额度");
  });
});

// ══════════════════════════════════════════════════════════════════
//  提醒条什么时候该消失 / 不该被降级
// ══════════════════════════════════════════════════════════════════
describe("消失与降级", () => {
  it("网关又成功回了一次，条子就该下去", () => {
    // 清掉的判据是**证据**：刚成功回了一次，就说明它有钱了。
    act(() => { noteQuota({ kind: "quota.exhausted", ts: now(), detail: "no credit" }); });
    act(() => { clearQuota(); });
    expect(bar().hidden).toBe(true);
    expect(G.QUOTA).toBe(null);
  });

  it("一条「可能跑不完」盖不掉「已经停摆」", () => {
    // 反过来会把一条红的「跑不动了」换成温和的黄条，用户以为还能接着等。
    act(() => { noteQuota({ kind: "quota.exhausted", ts: now(), detail: "no credit" }); });
    act(() => { noteQuota({ kind: "quota.low", ts: now(), remaining: 3 }); });
    expect(G.QUOTA.kind).toBe("quota.exhausted");
    expect(bar().className).toContain("bad");
  });

  it("重放三天前那条事件不会竖起一根过期的警报", () => {
    // 打开旧会话、SSE 断线重连都从 since=0 重放全部事件。提醒条断言的是**此刻**
    // 的状态，隔夜的证据撑不起这句话 —— 真没钱的话下一次调用几秒内就会把它重新竖起来。
    act(() => { noteQuota({ kind: "quota.exhausted", ts: now() - 3 * 86400, detail: "old" }); });
    expect(bar().hidden).toBe(true);
    expect(bar().innerHTML).toBe("");
    expect(G.QUOTA).toBe(null);
  });

  it("本地上限的提醒不会跟着你进另一个会话", () => {
    // 本地花费闸是「这一次运行」的事。换到另一个会话还挂着它就是句错话 ——
    // 那个会话一分钱都还没花。
    act(() => { noteQuota({ kind: "budget.capped", ts: now(), cap: 5 }); });
    G.S = { id: "s2" };
    act(() => { paintQuotaBar(); });
    expect(bar().hidden).toBe(true);
    expect(G.QUOTA).toBe(null);
  });

  it("余额不足不能被按掉，偏低可以", () => {
    // 按掉它也照样跑不动，只是把坏消息藏起来。偏低和本地上限则可以关 ——
    // 那两种情况下用户完全可能有别的打算。
    act(() => { noteQuota({ kind: "quota.exhausted", ts: now(), detail: "no credit" }); });
    expect(bar().querySelector("button.qx"), "余额不足竟然能被按掉").toBe(null);
    act(() => { clearQuota(); });
    act(() => { noteQuota({ kind: "quota.low", ts: now(), remaining: 2 }); });
    const x = bar().querySelector("button.qx");
    expect(x).not.toBe(null);
    // 按下去真的会把它收掉。
    fireEvent.click(x);
    expect(bar().hidden).toBe(true);
    // 直接调那个导出的函数同样收掉（SSE 那边也走这条路）。
    act(() => { noteQuota({ kind: "quota.low", ts: now(), remaining: 2 }); });
    act(() => { dismissQuota(); });
    expect(bar().hidden).toBe(true);
  });

  it("网关原文夹带的标签进不到条子里", () => {
    // 网关原文是外部输入。一个自建 / 被接管的网关完全可以在报错文案里塞标签，
    // 用户只是跑了一次梳理。**React 把它当文本节点画** —— 判据因此从「调用了
    // esc()」换成「它是字，不是元素」，后者才是真正要保的那件事。
    act(() => {
      noteQuota({
        kind: "quota.exhausted", ts: now(),
        detail: '<img src=x onerror=alert(1)>',
      });
    });
    expect(bar().querySelector("img")).toBe(null);
    expect(bar().querySelector(".qraw").textContent).toBe('<img src=x onerror=alert(1)>');
    expect(bar().innerHTML).toContain("&lt;img");
  });
});

// ══════════════════════════════════════════════════════════════════
//  三种状态各自画成什么样（原来在 ui.render.test.ts 的「额度提醒条」一组）
//
//  这四条跟着 paintQuotaBar 一起搬过来：它们断的是**条子的样子**，而画条子的
//  已经不是 render.ts 那条线，留在那边就得靠 ui.env 的字符串 stub 去测一棵真
//  组件树。搬家不是删除 —— 每一条的断言都在，只是从 innerHTML 里找子串变成了
//  在渲染结果里找文字和按钮。
// ══════════════════════════════════════════════════════════════════
describe("额度提醒条", () => {
  it("S1 网关没钱：危险色，且**没有**「关掉」", () => {
    G.QUOTA = { kind: "quota.exhausted", ts: 1, sid: "s1", detail: "insufficient", currency: "USD" };
    act(() => { paintQuotaBar(); });
    const b = bar();
    expect(b.className).toBe("qbar bad");
    expect(b.textContent).toContain("网关账户余额不足");
    expect(b.querySelector("button.qx")).toBe(null);
    expect(b.hidden).toBe(false);
  });

  it("S2 余额偏低：说得出数就带数，说不出就用通用句", () => {
    G.QUOTA = { kind: "quota.low", ts: 1, sid: "s1", amount: 1.5, currency: "USD" };
    act(() => { paintQuotaBar(); });
    expect(bar().textContent).toContain("只剩 $1.50");

    G.QUOTA = { kind: "quota.low", ts: 1, sid: "s1", amount: null, currency: "USD" };
    act(() => { paintQuotaBar(); });
    expect(bar().textContent).toContain("网关余额偏低");
  });

  it("S3 本地闸：**一个字都不提充值/余额**，并给「去设置」", () => {
    G.QUOTA = { kind: "budget.capped", ts: 1, sid: "s1", cap: 2, currency: "USD" };
    act(() => { paintQuotaBar(); });
    const b = bar();
    expect(b.textContent).toContain("花费上限（$2.00）用满了");
    fireEvent.click(b.querySelector("button.qact"));
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(b.textContent).not.toContain("余额");
    expect(b.textContent).not.toContain("充值");
  });

  it("本地闸是「这一次运行」的事，换到别的会话就撤掉", () => {
    G.QUOTA = { kind: "budget.capped", ts: 1, sid: "别的会话", cap: 2 };
    act(() => { paintQuotaBar(); });
    expect(G.QUOTA).toBe(null);
    expect(bar().hidden).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  设置页那一行余额（铁律 C1）
// ══════════════════════════════════════════════════════════════════
describe("设置页的余额行", () => {
  // 铁律 C1。多数网关根本没有余额接口，那是**常态不是故障**。这一行留空会被当成
  // 还没加载完（他会一直等），显示 0 会被当成钱花光了（他会去充一个根本不缺钱的
  // 账户）。两种都是假消息，所以只能明说查不到。
  it.each([
    ["null", null],
    ["{}", {}],
    ['{"known": false}', { known: false }],
    ['{"known": false, "remaining": null}', { known: false, remaining: null }],
  ])("查不到余额就明说查不到（%s）", (_label, payload) => {
    const line = balanceLine(payload);
    expect(line.trim(), "余额行留空了").not.toBe("");
    expect(line).not.toContain("0");
    expect(line).toContain("不提供");
  });

  it("查得到就把数摆出来，并注明是哪个端点给的", () => {
    // 网关五花八门，出入时得知道这个数该去哪儿核对。
    const line = balanceLine({
      known: true, remaining: 12.5, total: 50, currency: "USD",
      source: "dashboard/billing",
    });
    expect(line).toContain("$12.50");
    expect(line).toContain("$50.00");
    expect(line).toContain("dashboard/billing");
  });

  it("真查到 0 就允许显示 0", () => {
    // 反过来的一半：那个 0 是真的，不能被「查不到」盖掉。
    const line = balanceLine({ known: true, remaining: 0, currency: "USD" });
    expect(line).toContain("$0.00");
    expect(line).not.toContain("不提供");
  });

  it("余额行就挨在「预算」那一段里", () => {
    // 余额要挨着「上限」一起看才有意义：一个是网关还剩多少，一个是我们自己允许
    // 花多少，分开两屏就没人对得上。
    G.CONFIG = {
      gateway: {}, tiers: {}, catalog: [], env: [], budget: { usd_cap: 5 },
      balance: { known: true, remaining: 12.5, currency: "USD" },
    };
    const { container } = render(<ConfigForm />);
    const body = container.innerHTML;
    const budget = body.indexOf(I18N.zh!["settings.budget"]!);
    const balance = body.indexOf(I18N.zh!["balance.label"]!, budget);
    expect(budget).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(-1);
    expect(balance - budget).toBeLessThan(1200);
    // 那个数确实画出来了（旧版这里靠 balanceLine 返回的转义串，现在是文本节点）
    expect(container.textContent).toContain("$12.50");
  });
});

// ══════════════════════════════════════════════════════════════════
//  文案本身
// ══════════════════════════════════════════════════════════════════
describe("文案", () => {
  it("这一批 key 中英两本字典里都得有", () => {
    // t() 缺 key 时**静默**回落到中文再回落到 key 本身 —— 漏了 en 的表现是
    // 英文界面上冒出中文，不报错、不红。
    for (const key of ["balance.label", "balance.unknown", "balance.remaining",
      "balance.ofTotal", "balance.quotaUnit", "balance.source",
      "quota.exhausted", "quota.exhaustedHint", "quota.low",
      "quota.lowGeneric", "quota.lowHint", "budget.capped",
      "budget.cappedAmount", "budget.cappedHint",
      "quota.openSettings", "quota.dismiss"]) {
      expect(I18N.zh, `zh 少了 ${key}`).toHaveProperty([key]);
      expect(I18N.en, `en 少了 ${key}`).toHaveProperty([key]);
    }
  });

  it("C4 对英文同样成立：本地闸的英文文案里没有账单味", () => {
    // 英文更容易滑过去：「out of credit」和「hit your cap」在英文里读起来差不多，
    // 含义却完全相反。
    for (const key of ["budget.capped", "budget.cappedAmount", "budget.cappedHint"]) {
      const value = I18N.en![key]!.toLowerCase();
      for (const word of GATEWAY_MONEY_WORDS_EN)
        expect(value, `en 的 ${key} 里出现了「${word}」`).not.toContain(word);
    }
    const hint = I18N.en!["budget.cappedHint"]!.toLowerCase();
    expect(hint, "没告诉英文用户这个闸在哪儿改").toContain("settings");
    expect(hint, "没澄清网关那边其实没问题").toContain("gateway");
  });

  it("另一半：真欠费的两条必须点名是网关那边的事", () => {
    // 真欠费时不能含糊成「额度用完了」，那会被当成本地闸，用户跑去设置里把上限
    // 调高，然后撞上同一堵墙。
    for (const [dict, gateway] of [[I18N.zh!, "网关"], [I18N.en!, "gateway"]] as const)
      for (const key of ["quota.exhausted", "quota.exhaustedHint", "quota.lowHint"])
        expect(dict[key]!.toLowerCase(), `${key} 没点明是网关那边的事`)
          .toContain(gateway.toLowerCase());
  });
});

// ══════════════════════════════════════════════════════════════════
//  别把刚调好的东西带塌
// ══════════════════════════════════════════════════════════════════
describe("回归", () => {
  it("这个功能不该碰的排版变量和侧栏都还在", () => {
    // 提醒条只是往 mhead 下面插一层。排版变量和项目侧栏跟它没有关系，
    // 这条在这儿是防「顺手改一改」。
    const h = html();
    for (const token of ["--col:", ".bub:has(.mdtw)"])
      expect(h, `${token} 没了`).toContain(token);
    const sessions = readFileSync(resolve(ROOT, "ts/src/ui/sessions.ts"), "utf8");
    expect(sessions, "paintSessions() 没了").toContain("export function paintSessions()");
  });

  it("构建出来的那段 JS 能被 node 解析", () => {
    execFileSync(process.execPath, ["--check"],
      { input: pageScript(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  });
});
