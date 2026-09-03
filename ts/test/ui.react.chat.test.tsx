// @vitest-environment happy-dom
/**
 * 聊天流的组件契约 —— `chat.ts` 的 bubble() / stepsCard() / thinkingBubble() 与
 * render.ts 中栏那段 chips 换成组件之后，**要保的东西一条都没变**：
 *
 *   · 类名与结构逐字对齐旧模板串（767 行 CSS 认的就是这些选择器，少一个就是少一块样式）；
 *   · chips 的回落与恢复 —— 追问为空退回开场那批，**不能两者都不出**；
 *     这一轮还在路上时一条都不画，否则输入框正上方整块跳一跳；
 *   · 「思考中」那颗气泡必须带 think 类、必须带 id=tsec 的秒表位；
 *   · 恶意输入渲染成**文本**，且渲染结果里一个 on* 属性都没有。
 *
 * 状态那一半（addTurn / mergeStateSnapshot / turnKey / stopChat）仍然住在 chat.ts，
 * 它们的 27 条测试（ui.contracts.chat + ui.session）一个字都没动 —— 那些函数一行
 * 都不碰 DOM，换宿主不该动它们。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// 点 chip = 把它当成用户自己打的字发出去。这里要断的是「发出去的是哪一串」，
// 所以把 ask 换成假的；importOriginal 保住同模块里被别处依赖的导出。
vi.mock("../src/ui/chat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/chat.js")>();
  return { ...actual, ask: vi.fn() };
});

const { G } = await import("../src/ui/state.js");
const { addTurn, ask, mergeStateSnapshot } = await import("../src/ui/chat.js");
const { Bubble, ChatChips, Chips, IntroChips, StepsCard, ThinkingBubble } =
  await import("../src/ui/react/chat.js");
const { Markdown } = await import("../src/ui/react/markdown.js");
const { WebSourcesCard } = await import("../src/ui/react/web-search.js");

const EVIL = `"><img src=x onerror=alert(1)>`;

/** 一棵子树上出现过的全部属性名 —— 值若「逃」出去，一定表现为多出来的属性名。 */
function attrNames(root: Element): Set<string> {
  const names = new Set<string>();
  const visit = (el: Element): void => {
    for (const a of Array.from(el.attributes) as any[]) names.add(a.name);
    for (const c of Array.from(el.children) as any[]) visit(c);
  };
  visit(root);
  return names;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as any).__pwned;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0,
          state: { dialogue: { turns: [] } }, events: [] };
  G.LANG = "zh"; G.STREAM = null; G.STEPS = [];
  G.PROMPTS = []; G.FOLLOWUPS = []; G.THINKING = false; G.CHAT_ABORT = null;
  G.PENDING = [];
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  气泡
// ══════════════════════════════════════════════════════════════════
describe("<Bubble>", () => {
  it("用户那边是 .bub.me > .body，纯文本不过 markdown", () => {
    const { container } = render(<Bubble turn={{ speaker: "user", text: "**不该变粗**" }} />);
    expect(container.querySelector(".bub.me > .body")).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector(".mdbody")).toBeNull();
    expect(container.textContent).toBe("**不该变粗**");
  });

  it("助手那边是 .bub.oc > .body > .mdbody，markdown 生效", () => {
    const { container } = render(<Bubble turn={{ speaker: "assistant", text: "**粗**" }} />);
    expect(container.querySelector(".bub.oc > .body > .mdbody")).not.toBeNull();
    expect(container.querySelector("strong")!.textContent).toBe("粗");
  });

  it("意图标签：低置信度多一个 low 类（那正是 CSS 用来变灰的钩子）", () => {
    const hi = render(<Bubble turn={{ speaker: "assistant", text: "x", intent: "查询", confidence: 0.9 }} />);
    expect(hi.container.querySelector(".itag")!.className).toBe("itag");
    cleanup();
    const lo = render(<Bubble turn={{ speaker: "assistant", text: "x", intent: "查询", confidence: 0.4 }} />);
    expect(lo.container.querySelector(".itag.low")).not.toBeNull();
  });

  it("没有 intent 就不出标签（不是出一个空的）", () => {
    const { container } = render(<Bubble turn={{ speaker: "assistant", text: "x" }} />);
    expect(container.querySelector(".itag")).toBeNull();
  });

  it("点击正文来源编号会定位并聚焦紧随本回答的对应来源，而不是历史同名来源", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const { container } = render(<>
      <Bubble turn={{ speaker: "assistant", text: "结论 WEB[web_0123456789abcdef]" }} />
      <section className="web-sources-card">
        <article className="web-source-article" data-source-id="web_0123456789abcdef" tabIndex={-1}>来源标题</article>
      </section>
    </>);
    const article = container.querySelector("article") as HTMLElement;
    article.scrollIntoView = scrollIntoView;
    article.focus = focus;

    fireEvent.click(container.querySelector("a.web-citation-link")!);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(container.textContent).not.toContain("WEB[");
  });

  it("编号指向折叠来源时会自动展开卡片并定位，不要求用户先手动展开", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `web_000000000000000${i}`,
      title: `来源 ${i + 1}`,
      url: `https://example${i + 1}.com/a`,
      snippet: `摘要 ${i + 1}`,
    }));
    const wanted = rows[4]!.id;
    const { container } = render(<>
      <Bubble turn={{ speaker: "assistant", text: `结论 WEB[${wanted}]` }} />
      <WebSourcesCard ev={{ kind: "web.sources", total: 5, results: rows }} />
    </>);
    expect(container.querySelector(`article[data-source-id="${wanted}"]`)).toBeNull();

    fireEvent.click(container.querySelector("a.web-citation-link")!);
    await waitFor(() => {
      expect(container.querySelector(`article[data-source-id="${wanted}"]`)).not.toBeNull();
      expect(container.querySelector(".web-source-toggle")?.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("乐观上屏的那条半透明 —— 用户要能看出「还没落地」", () => {
    const { container } = render(<Bubble turn={{ speaker: "user", text: "问", pending: true }} />);
    expect((container.querySelector(".body") as any).style.opacity).toBe("0.55");
  });

  it("正在流式的那条按进度截断，不是整块蹦出来", () => {
    G.STREAM = { full: "一二三四五", i: 2, timer: null, t0: 0 };
    const { container } = render(<Bubble turn={{ speaker: "assistant", text: "一二三四五" }} />);
    expect(container.querySelector(".mdbody")!.textContent).toBe("一二");
  });

  it("**只截当前正在流的那一条** —— 历史消息不受影响", () => {
    G.STREAM = { full: "正在流的这句", i: 2, timer: null, t0: 0 };
    const { container } = render(<Bubble turn={{ speaker: "assistant", text: "很久以前那句" }} />);
    expect(container.querySelector(".mdbody")!.textContent).toBe("很久以前那句");
  });
});

// ══════════════════════════════════════════════════════════════════
//  推理卡
// ══════════════════════════════════════════════════════════════════
describe("<StepsCard>", () => {
  it("默认折叠，summary 有明确展开语义；展开区保留思考、工具与结果", () => {
    G.STEPS = [{ thought: "先查一下", tool: "search", args: { q: "订单" }, observation: "找到 3 条" }];
    const { container } = render(<StepsCard />);
    const details = container.querySelector("details.steps") as any;
    const summary = container.querySelector(".reasoning-summary")!;
    expect(details.open).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.textContent).toContain("已完成思考");
    expect(container.querySelector(".reasoning-step-list")).toBeNull();
    fireEvent.click(summary);
    expect(container.querySelector(".reasoning-step-list .stt")!.textContent).toBe("先查一下");
    expect(container.querySelector(".sto > code")!.textContent).toBe("search");
    expect(container.querySelector(".sto")!.textContent).toContain('{"q":"订单"}');
    expect(container.querySelector(".stb")!.textContent).toBe("找到 3 条");
    expect(details.open).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
  });

  it("没调工具就不出 .sto，没有观察值就不出 .stb", () => {
    G.STEPS = [{ thought: "只是想了想" }];
    const { container } = render(<StepsCard />);
    fireEvent.click(container.querySelector("summary")!);
    expect(container.querySelector(".sto")).toBeNull();
    expect(container.querySelector(".stb")).toBeNull();
  });

  it("结果全文留在展开区，视觉层用滚动封顶而不是把审计内容截掉", () => {
    G.STEPS = [{ thought: "t", observation: "x".repeat(500) }];
    const { container } = render(<StepsCard />);
    fireEvent.click(container.querySelector("summary")!);
    expect(container.querySelector(".stb")!.textContent).toHaveLength(500);
  });

  it("工具名与观察值里的标记是文本，不是元素", () => {
    G.STEPS = [{ thought: EVIL, tool: EVIL, args: { a: EVIL }, observation: EVIL }];
    const { container } = render(<StepsCard />);
    fireEvent.click(container.querySelector("summary")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".stt")!.textContent).toBe(EVIL);
    expect([...attrNames(container.querySelector(".steps")!)].filter(n => n.startsWith("on"))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  「正在思考」占位
// ══════════════════════════════════════════════════════════════════
describe("<ThinkingBubble>", () => {
  it("**必须带 think 类** —— markNewBubbles 靠它把这颗排除在计数之外", () => {
    // 不排除的话「思考中消失、答案出现」净变化为零，于是整个界面上最该被看见的
    // 那条回答反而是唯一拿不到入场动画的。
    const { container } = render(<ThinkingBubble />);
    expect(container.querySelector(".bub.oc.think > .body.think")).not.toBeNull();
    expect(container.querySelectorAll(".dots > i")).toHaveLength(3);
  });

  it("秒表的位置是 id=tsec —— 计时器按这个 id 找它，换掉就再也写不进去", () => {
    const { container } = render(<ThinkingBubble />);
    const sec = container.querySelector(".tsec")!;
    expect(sec.id).toBe("tsec");
    expect(sec.textContent).toBe("");
  });

  it("折叠摘要只说业务进度，不泄露内部工具名或思考正文", () => {
    let c = render(<ThinkingBubble />).container;
    expect(c.querySelector("summary")!.textContent).toContain("思考中");
    expect(c.querySelector("summary")!.textContent).not.toContain("正在准备推理步骤");
    cleanup();
    G.STEPS = [{ thought: "先看看材料", tool: "web.search" }];
    c = render(<ThinkingBubble />).container;
    expect(c.querySelector("summary")!.textContent).toContain("正在搜索公开资料");
    expect(c.querySelector("summary")!.textContent).not.toContain("web.search");
    fireEvent.click(c.querySelector("summary")!);
    expect(c.querySelector(".sto > code")!.textContent).toBe("web.search");
    cleanup();
    G.STEPS = [{ thought: "只是在想这件事" }];
    c = render(<ThinkingBubble />).container;
    expect(c.querySelector("summary")!.textContent).toContain("思考中");
    expect(c.querySelector("summary")!.textContent).not.toContain("只是在想这件事");
  });

  it("完整思路只在展开区，工具名里的标记也是文本", () => {
    G.STEPS = [{ thought: "长".repeat(80) }];
    const first = render(<ThinkingBubble />).container;
    expect(first.querySelector("summary")!.textContent).not.toContain("长");
    fireEvent.click(first.querySelector("summary")!);
    expect(first.querySelector(".reasoning-details")!.textContent).toContain("长".repeat(80));
    cleanup();
    G.STEPS = [{ tool: EVIL }];
    const { container } = render(<ThinkingBubble />);
    fireEvent.click(container.querySelector("summary")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(EVIL);
  });

  it("检索候选实时变成业务进度，去重后不把文章标题铺在摘要里", () => {
    G.S.state.dialogue.turns = [{ speaker: "user", ts: 100, text: "查资料" }];
    G.STEPS = [{ turn: "run-2", n: 1, tool: "web.search" }];
    G.S.events = [
      { seq: 10, kind: "chat.step", ts: 110, step: { turn: "run-2", n: 1, tool: "web.search" } },
      { seq: 11, kind: "web.sources", ts: 120, total: 3, results: [
      { source_id: "a", title: "候选甲" }, { source_id: "b", title: "候选乙" },
      { source_id: "a", title: "重复甲" },
      ] },
    ];
    const { container } = render(<ThinkingBubble />);
    const summary = container.querySelector("summary")!;
    expect(summary.textContent).toContain("已找到 3 条候选，正在筛选");
    expect(summary.textContent).not.toContain("候选甲");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".reasoning-status")!.hasAttribute("aria-live")).toBe(false);
  });

  it("连续两轮时，新 user turn 尚未收到 chat.step 不会沿用上一轮候选数", () => {
    G.S.state.dialogue.turns = [
      { speaker: "user", ts: 100, text: "第一轮" },
      { speaker: "assistant", ts: 180, text: "第一轮答复" },
    ];
    G.S.events = [
      { seq: 1, ts: 110, kind: "chat.step", step: { turn: "run-1", n: 1, tool: "web.search" } },
      { seq: 2, ts: 120, kind: "web.sources", total: 5, results: [{ source_id: "old" }] },
    ];
    G.PENDING = [{ speaker: "user", text: "第二轮", pending: true }];
    G.STEPS = [];
    let c = render(<ThinkingBubble />).container;
    expect(c.querySelector("summary")!.textContent).toContain("思考中");
    expect(c.querySelector("summary")!.textContent).not.toContain("5 条候选");
    cleanup();

    G.STEPS = [{ turn: "run-2", n: 1, tool: "web.search" }];
    G.S.events.push(
      { seq: 3, ts: 200, kind: "chat.step", step: { turn: "run-2", n: 1, tool: "web.search" } },
      { seq: 4, ts: 210, kind: "web.sources", total: 2, results: [{ source_id: "new-a" }, { source_id: "new-b" }] },
    );
    c = render(<ThinkingBubble />).container;
    expect(c.querySelector("summary")!.textContent).toContain("已找到 2 条候选，正在筛选");
    expect(c.querySelector("summary")!.textContent).not.toContain("5 条候选");
  });

  it("展开区脱敏并限制单字段长度，收起状态不把明文挂进 DOM", () => {
    G.STEPS = [{ turn: "r", n: 1, thought: "核对凭证", tool: "http.call",
      args: { apiKey: "sk-secret", nested: { password: "123456", ok: "safe" } },
      observation: `Authorization: Bearer top-secret\nCookie=session=abc\n${"x".repeat(20_000)}` }];
    const { container } = render(<ThinkingBubble />);
    expect(container.textContent).not.toContain("sk-secret");
    expect(container.textContent).not.toContain("top-secret");
    fireEvent.click(container.querySelector("summary")!);
    expect(container.textContent).toContain("已隐藏敏感信息");
    expect(container.textContent).not.toContain("sk-secret");
    expect(container.textContent).not.toContain("123456");
    expect(container.textContent).not.toContain("top-secret");
    expect(container.textContent).toContain("内容过长，已截断");
    expect(container.querySelector(".stb")!.textContent!.length).toBeLessThan(13_000);
  });
});

// ══════════════════════════════════════════════════════════════════
//  推荐问题 chips —— 这一组是「重写时最容易丢」的那两条
// ══════════════════════════════════════════════════════════════════
describe("<ChatChips> 的回落与恢复", () => {
  const chat = (): void => { G.S.state.dialogue.turns = [{ speaker: "user", ts: 1, text: "问" }]; };

  it("有追问就出追问，开场那批不同时出（提示的位置很贵）", () => {
    chat();
    G.PROMPTS = [{ text: "开场" }];
    G.FOLLOWUPS = [{ text: "追问" }];
    const { container } = render(<ChatChips />);
    expect(container.textContent).toContain("追问");
    expect(container.textContent).not.toContain("开场");
  });

  it("**追问为空时退回开场那批** —— 不能两者都不出", () => {
    // 旧逻辑聊过一句就把 PROMPTS 清空：追问一旦为空（梳理刚跑完、材料刚传完、
    // 上一轮出错），聊天窗口就一条出口都没有 —— 而服务端刚算好的那批正躺在
    // PROMPTS 里没人用。
    chat();
    G.PROMPTS = [{ text: "开场" }];
    G.FOLLOWUPS = [];
    expect(render(<ChatChips />).container.textContent).toContain("开场");
  });

  it("这一轮还在路上时一条都不画（否则输入框正上方整块跳一跳）", () => {
    chat();
    G.FOLLOWUPS = [{ text: "追问" }];
    G.CHAT_ABORT = new AbortController();
    expect(render(<ChatChips />).container.innerHTML).toBe("");
  });

  it("正在思考时同样不画", () => {
    chat();
    G.FOLLOWUPS = [{ text: "追问" }];
    G.THINKING = true;
    expect(render(<ChatChips />).container.innerHTML).toBe("");
  });

  it("两批都空就整块不出，不是出一个空壳 .pchips", () => {
    chat();
    const { container } = render(<ChatChips />);
    expect(container.querySelector(".pchips")).toBeNull();
  });

  it("空状态那排居中（那正是最需要开场提示的时候）", () => {
    G.PROMPTS = [{ text: "开场" }];
    const { container } = render(<IntroChips />);
    expect((container.querySelector(".pchips") as any).style.justifyContent).toBe("center");
  });
});

describe("<Chips> 发出去的是哪一串", () => {
  it("显示 text、发送 send —— data-s 仍然是这批按钮在 DOM 上的身份标记", () => {
    const { container } = render(<Chips chips={[{ text: "显示的", send: "真正发出去的" }]} />);
    const btn = container.querySelector(".pchips > button.pchip") as any;
    expect(btn.textContent).toBe("显示的");
    expect(btn.dataset.s).toBe("真正发出去的");
  });

  /** chips 现在填输入框而不是直接发，所以断言要看 #cin。 */
  function composer(): HTMLTextAreaElement {
    document.getElementById("cin")?.remove();
    const el = document.createElement("textarea");
    el.id = "cin";
    document.body.appendChild(el);
    return el as HTMLTextAreaElement;
  }

  it("点一下只填进输入框，**不发送** —— 猜出来的话要留给他改", () => {
    const cin = composer();
    const { container } = render(<Chips chips={[{ text: "就这句" }]} />);
    fireEvent.click(container.querySelector(".pchip")!);
    expect(cin.value).toBe("就这句");
    // 点即发是旧行为：这些是猜的，猜错时要能改，而不是撤回已发出的消息。
    expect(ask).not.toHaveBeenCalled();
  });

  it("没有 send 就用 text 本身；有 send 就用 send", () => {
    const cin = composer();
    const { container } = render(<Chips chips={[{ text: "显示的", send: "真正要发的" }]} />);
    fireEvent.click(container.querySelector(".pchip")!);
    expect(cin.value).toBe("真正要发的");
  });

  it("填进输入框的是**原样的值**，一个字符都没被转义动过", () => {
    const evil = `x','');globalThis.__pwned=1;//`;
    const cin = composer();
    const { container } = render(<Chips chips={[{ text: "问这个", send: evil }]} />);
    fireEvent.click(container.querySelector(".pchip")!);
    expect(cin.value).toBe(evil);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("敌意提示文本是字不是标记，且一个内联处理器属性都没有", () => {
    const { container } = render(<Chips chips={[{ text: EVIL }]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".pchip")!.textContent).toBe(EVIL);
    // **判据是属性名集合，不是 innerHTML 里有没有 "onerror="。** 这一串正是被
    // 原样存进 data-s 的值（React 把里面那个 `"` 转成了 &quot;，闭不掉属性），
    // 序列化出来当然看得见它 —— 看得见是对的，长成一个真属性才是事故。
    // title 是新加的静态提示（"填进输入框，可以改了再发"），无害；判据没变 ——
    // 这里要挡的是 onclick/onerror 之类**内联处理器**长成真属性，白名单里
    // 一个 on* 都不能出现。
    expect([...attrNames(container.querySelector(".pchips")!)].sort())
      .toEqual(["class", "data-s", "title"]);
    expect([...attrNames(container.querySelector(".pchips")!)].filter((n) => n.startsWith("on")))
      .toEqual([]);
    expect((container.querySelector(".pchip") as any).dataset.s).toBe(EVIL);
  });
});

// ══════════════════════════════════════════════════════════════════
//  markdown 那条路的组件形态
// ══════════════════════════════════════════════════════════════════
/**
 * md() 本身（「先转义再套用」、栈式嵌套列表、表格、字面量 <br>）由 ui.md.test.ts
 * 的 11 条钉着，那 11 条一个字都没动 —— md.ts 是框架无关的逻辑层。
 * 这里补的是**组件形态**：它产出的元素真的落进了 DOM，而且外壳仍是 .mdbody。
 * 注入那一面在 ui.contracts.escaping.react.test.tsx（每种 md 语法一条）。
 */
describe("<Markdown>", () => {
  it("外壳是 .mdbody —— 与内联 JS 时代 bubble() 拼的那层一致", () => {
    const { container } = render(<Markdown text="正文" />);
    expect((container.querySelector("div") as any).className).toBe("mdbody");
  });

  it("类名可换，给别处（比如流式那一帧）复用同一条渲染路径", () => {
    const { container } = render(<Markdown text="正文" className="mdbody stream" />);
    expect((container.querySelector("div") as any).className).toBe("mdbody stream");
  });

  it("表格 / 列表 / 代码块出的是真元素，不是一串字面量", () => {
    const { container } = render(<Markdown text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />);
    expect(container.querySelectorAll(".mdtw > table.mdt th")).toHaveLength(2);
    cleanup();
    const list = render(<Markdown text={"1. 甲\n   - 子一\n2. 乙"} />).container;
    expect(list.querySelector("ol.mdl > ul.mdl > li")!.textContent).toBe("子一");
    cleanup();
    const code = render(<Markdown text={"```py\nx = 1\n```"} />).container;
    expect(code.querySelector("pre.mdcode")!.textContent).toBe("x = 1");
  });

  it("空输入不炸，也不留一坨空标记", () => {
    for (const v of ["", null, undefined]) {
      const { container } = render(<Markdown text={v} />);
      expect(container.querySelector(".mdbody")!.innerHTML).toBe("");
      cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  合并 × 渲染：换了框架之后「同一条消息显示两遍」不能回来
// ══════════════════════════════════════════════════════════════════
/**
 * addTurn / mergeStateSnapshot 本身没动（chat.ts，27 条测试原样保留）。这里断的是
 * **合并结果画出来是几颗气泡** —— 换宿主之后，那两条真实事故的复现路径必须仍然被堵住：
 *   · 盲追加 → 每条消息两遍（/state 已带回完整 dialogue，SSE 重连又固定 ?since=0 重放）；
 *   · 整体覆盖 → 刚由 SSE 推上来、服务端那次查询还没看到的回答被吞掉。
 */
describe("按身份合并之后再渲染", () => {
  const turns = (): any[] => (G.S.state.dialogue.turns || []).concat(G.PENDING);
  const List = (): any => <>{turns().map((t: any, i: number) => <Bubble turn={t} key={i} />)}</>;

  it("同一条重放两遍只画一颗气泡", () => {
    addTurn({ speaker: "user", ts: 1, text: "问" });
    addTurn({ speaker: "user", ts: 1, text: "问" });
    expect(render(<List />).container.querySelectorAll(".bub")).toHaveLength(1);
  });

  it("滞后的 /state 快照并进来时，刚推上来的那条还在（而且只有一颗）", () => {
    addTurn({ speaker: "user", ts: 1, text: "问" });
    addTurn({ speaker: "assistant", ts: 2, text: "刚推上来的答" });
    mergeStateSnapshot({ id: "s1", state: { dialogue: { turns: [{ speaker: "user", ts: 1, text: "问" }] } } });
    const { container } = render(<List />);
    const bubs = Array.from(container.querySelectorAll(".bub")) as any[];
    expect(bubs).toHaveLength(2);
    expect(bubs[1].textContent).toContain("刚推上来的答");
  });

  it("回执到了就撤掉乐观占位 —— 不是一条实的加一条半透明的并排站着", () => {
    G.PENDING = [{ speaker: "user", text: "问", pending: true }];
    addTurn({ speaker: "user", ts: 1, text: "问" });
    const { container } = render(<List />);
    expect(container.querySelectorAll(".bub")).toHaveLength(1);
    expect((container.querySelector(".body") as any).style.opacity).toBe("");
  });
});
