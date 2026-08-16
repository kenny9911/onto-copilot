// @vitest-environment happy-dom
/**
 * **聊天流 #stream 归 React 之后的契约。**
 *
 * 这是用户 90% 时间在看的那块屏幕。原来画它的是 render.ts 里那三十行模板字符串，
 * 现在是 <Stream>（react/stream.tsx）。搬家不许丢的东西，这份文件逐条钉住：
 *
 *   · 空状态是**一块内容不是一个终点** —— 还没上传材料就先聊起来是最常见的入口，
 *     问候语只在还没开口时出现（否则「欢迎回来，张三」会永久挂在五十轮对话顶上）；
 *   · chips 的回落与恢复（组件那一侧在 ui.react.chat.test.tsx，这里钉的是**位置**：
 *     空状态那排居中、正常那排在流尾、一轮在路上时整排消失）；
 *   · 事件卡与气泡**按一条时间线归并** —— 工具卡挂到紧随其后的那条助手发言之后，
 *     不是插在提问和回答中间（用户两次报「表没画出来」，其实每次都画了，
 *     只是画在整段对话最上方，而渲染完又自动滚到底）；
 *   · 后台步骤（aux 轮）不进聊天流；
 *   · markdown 是 React 下**唯一**还能被 XSS 打穿的那条路，所以有针对性用例；
 *   · 入场动画只给新气泡、以及「人在底部就跟着滚，人翻上去看历史就别抢位置」。
 *
 * 搬过来的旧用例（判据一个字没改，只是从「innerHTML 里有这个子串」换成
 * 「渲染结果里有这个元素/这段文字」）：
 *   · ui.render.test.ts 的「提示气泡（chips）」5 条与「evCard 表格与导出」7 条；
 *   · ui.events.test.ts 的「traceCard」2 条；
 *   · ui.contracts.escaping.test.ts 的「空状态问候语」5 条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// 点 chip / 点「开始梳理」/ 点「确认执行」都是**发一句话出去**，这里要断的是
// 「发出去的是哪一串」，所以把这几个动作换成假的。importOriginal 保住同模块里
// 被组件当纯函数用的导出。
vi.mock("../src/ui/chat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/chat.js")>();
  return { ...actual, ask: vi.fn(), confirmAct: vi.fn() };
});
vi.mock("../src/ui/upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/upload.js")>();
  return { ...actual, startBuild: vi.fn() };
});

const { G, TBL_OPEN } = await import("../src/ui/state.js");
const { ask, confirmAct } = await import("../src/ui/chat.js");
const { startBuild } = await import("../src/ui/upload.js");
const { hasCard, timeline } = await import("../src/ui/events.js");
const { render: paintMiddle } = await import("../src/ui/render.js");
const { registeredRegions } = await import("../src/ui/react/app.js");
const { EvCard, TraceCard } = await import("../src/ui/react/events.js");
const { Stream } = await import("../src/ui/react/stream.js");

const EVIL = `"><img src=x onerror=alert(1)>`;

/** index.html 里中栏那块的真实结构（只留被测代码摸得到的那几个 id）。 */
function shell(): void {
  document.body.innerHTML = `<main class="pane main">
    <div class="stream" id="stream"></div>
    <div class="abar" id="abar"></div>
    <span class="pill" id="status"></span>
    <h2 id="title"></h2>
    <span class="cfiles" id="chip"></span>
    <textarea class="cin" id="cin"></textarea>
    <button class="cbtn go" id="send"></button>
  </main>`;
}

const box = (): any => document.getElementById("stream");

/** 把 <Stream> 挂进那个**现成的** #stream（生产里走 portal，宿主是同一个元素）。 */
function mount(): any {
  render(<Stream />, { container: box() });
  return box();
}

/** 让容器有个可测的几何：happy-dom 的 scrollHeight 恒为 0。 */
function geometry(scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(box(), "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(box(), "clientHeight", { value: clientHeight, configurable: true });
}

const turn = (speaker: string, ts: number, text: string) => ({ speaker, ts, text });

beforeEach(() => {
  vi.clearAllMocks();
  shell();
  TBL_OPEN.clear();
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 1,
          state: { dialogue: { turns: [] } }, events: [] };
  G.LANG = "zh"; G.STREAM = null;
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = []; G.Q_BACKLOG = [];
  G.THINKING = false; G.CHAT_ABORT = null; G.NEEDS_CONFIRM = false;
  G.PROMPTS = []; G.FOLLOWUPS = []; G.QUOTA = null; G.ANSWERS = {};
  G.SEEN_SID = null; G.SEEN_BUBBLES = 0; G.PENDING_OPEN = true;
  G.CURRENT_USER = null;
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  容器的归属
// ══════════════════════════════════════════════════════════════════
describe("#stream 的主人", () => {
  it("模块顶层就登记了 region —— 不登记等于组件写了没人用", () => {
    const r = registeredRegions().find(x => x.id === "stream");
    expect(r?.Component).toBe(Stream);
  });

  it("render() 只剩「通知重画」，一个 innerHTML 都不写进 #stream", () => {
    // 它的几十个调用点一个都没动，所以这一句必须仍然让消息流跟着变。
    mount();
    act(() => { G.S.state.dialogue.turns = [turn("user", 1, "刚说的这句")]; paintMiddle(); });
    expect(box().textContent).toContain("刚说的这句");
  });

  it("没有会话时是占位符，不是一片空白", () => {
    G.S = null;
    const c = mount();
    expect(c.querySelector(".ph > .ic")!.textContent).toBe("NO SESSION");
    expect(c.textContent).toContain("新建一个会话开始");
  });
});

// ══════════════════════════════════════════════════════════════════
//  空状态：是一块内容，不是一个终点
// ══════════════════════════════════════════════════════════════════
describe("空状态", () => {
  it("还没传材料：问候语 + 居中的开场提示", () => {
    G.S.files = 0;
    G.PROMPTS = [{ text: "开场" }];
    const c = mount();
    expect(c.querySelector(".empty > h3")!.textContent).toBe("OntoCopilot");
    expect(c.querySelector(".esub")).not.toBeNull();
    expect((c.querySelector(".pchips") as any).style.justifyContent).toBe("center");
    expect(c.textContent).toContain("开场");
  });

  it("材料读完还没跑：一颗说清份数的「开始梳理」", () => {
    G.S.files = 3; G.S.status = "idle"; G.S.events = [];
    const c = mount();
    expect(c.querySelector(".empty > h3")!.textContent).toBe("3 份材料已读完");
    fireEvent.click(c.querySelector("button.sug")!);
    expect(startBuild).toHaveBeenCalled();
  });

  it("**空状态也要带开场提示** —— 那正是最需要它的时候", () => {
    G.S.files = 0;
    G.PROMPTS = [{ text: "开场" }];
    expect(mount().textContent).toContain("开场");
  });

  it("一旦聊起来，空状态就让位给对话（intro 钉在最上方，不再挡住气泡）", () => {
    G.S.files = 0;
    G.S.state.dialogue.turns = [turn("user", 1, "先跟你说说背景")];
    const c = mount();
    expect(c.querySelector(".wrap")).not.toBeNull();
    expect(c.textContent).toContain("先跟你说说背景");
    expect(c.querySelector(".empty")).not.toBeNull();     // intro 还在，只是在最上方
  });

  it("跑过一轮之后不再有空状态 —— 直接是消息流", () => {
    G.S.files = 3; G.S.status = "idle";
    G.S.events = [{ seq: 1, ts: 1, kind: "corpus.ready", findings: [], stats: {} }];
    expect(mount().querySelector(".empty")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  空状态问候语（原 ui.contracts.escaping.test.ts「空状态问候语」那一组）
// ══════════════════════════════════════════════════════════════════
describe("空状态问候语：认得出人就叫名字", () => {
  const login = (u: Record<string, unknown>) => {
    G.CURRENT_USER = { id: "u1", username: "zhang", ...u };
    G.S.files = 0;
  };
  const esub = (): any => mount().querySelector(".esub");

  it("**名字是自由文本，渲染出来必须是字不是标记**", () => {
    // 旧世界里这一行是拼进 innerHTML 的，所以先 esc 再交给 t() 插值。React 下
    // 它落进一个 JSX 文本节点，框架自己转义 —— 要保的东西一个字没变。
    login({ display_name: `<img src=x onerror="alert(1)">` });
    const c = mount();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".esub")!.textContent).toContain(`<img src=x onerror="alert(1)">`);
  });

  it("认不出人时回落到那句 tagline，而不是「欢迎回来，undefined」", () => {
    G.CURRENT_USER = null; G.S.files = 0;
    expect(esub().textContent).toBe("try, and do it");
    expect(esub().textContent).not.toContain("欢迎");
  });

  it("本地模式的合成管理员没有「谁」可称呼", () => {
    G.CURRENT_USER = { id: "__local__", username: "local" }; G.S.files = 0;
    expect(esub().textContent).toBe("try, and do it");
  });

  it("刚注册完的人说「欢迎」，不是「欢迎回来」", () => {
    login({ display_name: "张三" });
    expect(esub().textContent).toBe("欢迎回来，张三");
    cleanup();
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (k === "oc_new_account" ? "1" : null), setItem() {}, removeItem() {} };
    expect(esub().textContent).toBe("欢迎，张三");
    (globalThis as any).sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  });

  it("**有对话时问候语不再挂在消息流顶上**", () => {
    login({ display_name: "张三" });
    expect(mount().textContent).toContain("欢迎回来，张三");
    cleanup();
    G.S.state.dialogue.turns = [turn("user", 1, "半年前问的那句")];
    const c = mount();
    expect(c.textContent).toContain("半年前问的那句");
    expect(c.textContent).not.toContain("欢迎回来");
  });
});

// ══════════════════════════════════════════════════════════════════
//  推荐问题 chips 在流里的位置（原 ui.render.test.ts「提示气泡」那一组）
// ══════════════════════════════════════════════════════════════════
describe("提示气泡（chips）", () => {
  const chat = () => { G.S.state.dialogue.turns = [turn("user", 1, "问")]; };

  it("有追问就出追问", () => {
    chat();
    G.PROMPTS = [{ text: "开场" }]; G.FOLLOWUPS = [{ text: "追问" }];
    const c = mount();
    expect(c.textContent).toContain("追问");
    expect(c.textContent).not.toContain("开场");
  });

  it("**追问为空时退回开场那批** —— 不能两者都不出", () => {
    chat();
    G.PROMPTS = [{ text: "开场" }]; G.FOLLOWUPS = [];
    expect(mount().textContent).toContain("开场");
  });

  it("chip 的发送文本走 data-s，优先 send 字段", () => {
    chat();
    G.FOLLOWUPS = [{ text: "显示的", send: "真正发出去的" }];
    const btn = mount().querySelector(".pchip") as any;
    expect(btn.dataset.s).toBe("真正发出去的");
    fireEvent.click(btn);
    expect(ask).toHaveBeenCalledWith("真正发出去的");
  });

  it("这一轮还在路上时不画 chips（否则输入框正上方整块跳一跳）", () => {
    chat();
    G.FOLLOWUPS = [{ text: "追问" }];
    G.CHAT_ABORT = new AbortController();
    expect(mount().querySelector(".pchips")).toBeNull();
  });

  it("chips 排在流尾（气泡之后），空状态那排才居中", () => {
    chat();
    G.FOLLOWUPS = [{ text: "追问" }];
    const c = mount();
    const kids = [...c.querySelector(".wrap")!.children] as any[];
    expect(kids[kids.length - 1]!.className).toBe("pchips");
    expect(kids[kids.length - 1]!.style.justifyContent).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  确认闸
// ══════════════════════════════════════════════════════════════════
describe("确认闸", () => {
  it("需要点头时出现在流尾，「确认执行」走的是对话通道", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    G.NEEDS_CONFIRM = true;
    const c = mount();
    expect(c.querySelector(".cfm")!.textContent).toContain("这一步会改产物或花钱");
    fireEvent.click(c.querySelector(".cfm .act.pri")!);
    expect(confirmAct).toHaveBeenCalled();
  });

  it("「先不要」把闸关掉，整块跟着消失", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    G.NEEDS_CONFIRM = true;
    const c = mount();
    act(() => { fireEvent.click([...c.querySelectorAll(".cfm .act")].pop()!); });
    expect(G.NEEDS_CONFIRM).toBe(false);
    expect(c.querySelector(".cfm")).toBeNull();
  });

  it("正在思考时不出 —— 那一刻还没有「这一步」可确认", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    G.NEEDS_CONFIRM = true; G.THINKING = true;
    expect(mount().querySelector(".cfm")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  时间线：事件卡与气泡归并成一条
// ══════════════════════════════════════════════════════════════════
describe("事件卡与气泡在同一条时间线上", () => {
  it("工具卡挂到紧随其后的那条助手发言**之后**，不是插在提问和回答中间", () => {
    // 用户两次报「表没画出来」，其实每次都画了 —— 画在整段对话最上方，
    // 而渲染完又自动滚到底，于是他永远看不到。
    G.S.events = [{ seq: 1, ts: 150, kind: "ui.table", title: "问题清单", columns: ["a"], rows: [["1"]] }];
    G.S.state.dialogue.turns = [turn("user", 100, "列一下"), turn("assistant", 200, "已列出，见下表")];
    const c = mount();
    // 按**元素次序**断，不按 textContent 里的字符位置：「问题清单」这四个字在
    // 上方那张推理轨迹里也有一份，用 indexOf 会找到那一份。
    const kids = [...c.querySelector(".wrap")!.children] as any[];
    const asst = kids.findIndex(e => e.textContent.includes("已列出，见下表"));
    const tbl = kids.findIndex(e => e.className === "card");
    expect(asst).toBeGreaterThan(-1);
    expect(tbl).toBeGreaterThan(asst);
  });

  it("乐观上屏的气泡排在历史之后、推理卡与思考占位之前", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "历史")];
    G.PENDING = [{ speaker: "user", text: "刚打的这句", pending: true }];
    G.STEPS = [{ thought: "先查一下" }];
    G.THINKING = true;
    const c = mount();
    const cls = ([...c.querySelector(".wrap")!.children] as any[]).map(e => e.className);
    expect(cls).toEqual(["bub me", "bub me", "steps", "bub oc think"]);
    expect(c.querySelectorAll(".bub.me")[1]!.querySelector(".body").style.opacity).toBe("0.55");
  });

  it("**后台步骤不进聊天流** —— STEPS 空就没有那张推理卡", () => {
    // aux 轮（推荐问题那类后台推理）只进 G.TRACE，不进 G.STEPS；判据在
    // ui.contracts.chat.test.ts。这里钉的是另一半：STEPS 空时流里就没有 .steps，
    // 答案下方不会再冒一张思考卡。
    G.S.state.dialogue.turns = [turn("assistant", 1, "答")];
    G.TRACE = [{ turn: "aux", n: 1, thought: "想推荐问题：…" }];
    G.STEPS = [];
    const c = mount();
    expect(c.querySelector(".steps")).toBeNull();
    expect(c.textContent).not.toContain("想推荐问题");
  });
});

// ══════════════════════════════════════════════════════════════════
//  事件卡（原 ui.render.test.ts「evCard 表格与导出」那一组）
// ══════════════════════════════════════════════════════════════════
describe("<EvCard>", () => {
  const card = (ev: any): any => render(<EvCard ev={ev} />).container;
  const table = (n: number) => ({
    seq: 7, ts: 1, kind: "ui.table", title: "问题清单",
    columns: ["编号", "问题"],
    rows: Array.from({ length: n }, (_, i) => [String(i), "q" + i]),
  });

  it("默认只画前 30 行，但把总数说清楚", () => {
    const c = card(table(202));
    expect(c.textContent).toContain("共 202 条");
    expect(c.querySelector("button.act")!.textContent).toBe("展开全部 202 条");
    expect(c.querySelectorAll("tbody tr")).toHaveLength(30);
    expect(c.textContent).toContain("q29");
    expect(c.textContent).not.toContain("q30");
  });

  it("展开状态按事件 seq 记，展开后全量渲染", () => {
    TBL_OPEN.add(7);
    const c = card(table(202));
    expect(c.querySelectorAll("tbody tr")).toHaveLength(202);
    expect(c.querySelector("button.act")!.textContent).toBe("收起");
  });

  it("点一下就展开 —— 「全部列出来」这个承诺必须能兑现", () => {
    const c = card(table(202));
    act(() => { fireEvent.click(c.querySelector("button.act")!); });
    expect(TBL_OPEN.has(7)).toBe(true);
  });

  it("30 行以内不出展开按钮", () => {
    expect(card(table(30)).querySelector("button.act")).toBeNull();
  });

  it("单元格里的标记是文本，不是 DOM", () => {
    const c = card({ seq: 1, kind: "ui.table", title: "t", columns: ["a"], rows: [[EVIL]] });
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("td")!.textContent).toBe(EVIL);
  });

  it("对话里导出的文件给下载卡片（**不进产物列表**）", () => {
    const c = card({ seq: 1, kind: "export.ready", name: "清单.xlsx", label: "192 条", size: 2048, rows: 192 });
    const a = c.querySelector("a.act.pri") as any;
    expect(a.textContent).toBe("下载 清单.xlsx");
    expect(c.querySelector(".cap")!.textContent).toContain("2.0 KB");
    expect(c.querySelector(".cap")!.textContent).toContain("192 行");
    expect(a.getAttribute("href")).toBe("/api/sessions/s1/exports/%E6%B8%85%E5%8D%95.xlsx");
  });

  it("没有 findings 的 corpus.ready 不占一张卡", () => {
    expect(card({ seq: 1, kind: "corpus.ready", findings: [], stats: {} }).innerHTML).toBe("");
  });

  it("不值得单独占卡片的事件画空", () => {
    expect(card({ seq: 1, kind: "node.entered", node: "PARSE" }).innerHTML).toBe("");
  });

  it("**名单与组件同源** —— hasCard 说有的就真画得出来，说没有的就真是空的", () => {
    // 两边各写一套 if 迟早漂开：名单说「这条该有卡」而组件画空，那条事件就静默消失了。
    const kinds: any[] = [
      { seq: 1, kind: "corpus.ready", findings: [{ message: "有问题" }], stats: {} },
      { seq: 1, kind: "corpus.ready", findings: [], stats: {} },
      { seq: 1, kind: "parse.failed", error: "炸了" },
      { seq: 1, kind: "human.recorded", conflict: "c1", label: "选了甲", changed: ["A"] },
      { seq: 1, kind: "artifact.ready", name: "模板.xlsx", stats: {} },
      { seq: 1, kind: "audit.applied", revision: 2, changed: 3, dropped: [] },
      { seq: 1, kind: "ui.table", title: "t", columns: ["a"], rows: [["1"]] },
      { seq: 1, kind: "export.ready", name: "x.xlsx", size: 1 },
      { seq: 1, kind: "run.failed", error: "没跑完" },
      { seq: 1, kind: "session.restored", files: 2 },
      { seq: 1, kind: "node.entered", node: "PARSE" },
      { seq: 1, kind: "prompts.ready", questions: [1] },
    ];
    for (const ev of kinds) {
      const drawn = card(ev).innerHTML.length > 0;
      expect(drawn, `${ev.kind}（findings=${JSON.stringify(ev.findings)}）`).toBe(hasCard(ev));
      cleanup();
    }
  });

  it("回传合并那张卡上的 Bundle 走的是**同一道门禁**，不是自己拼的链接", () => {
    G.Q_BACKLOG = [{ id: "q1", status: "open", priority: "blocking" }];
    const c = card({ seq: 1, kind: "audit.applied", revision: 2, changed: 3, dropped: [] });
    expect(c.querySelector("[aria-disabled='true']")!.textContent).toContain("BLOCKED");
    expect(c.innerHTML).not.toContain("/bundle");
  });

  it("画不出卡片的事件在归并时就被滤掉（大多数事件只进推理轨迹）", () => {
    G.S.events = [{ seq: 1, ts: 150, kind: "node.entered", node: "PARSE" }];
    expect(timeline([turn("user", 100, "甲")]).length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  推理轨迹（原 ui.events.test.ts「traceCard」那两条）
// ══════════════════════════════════════════════════════════════════
describe("<TraceCard>", () => {
  const trace = (): any => render(<TraceCard />).container;

  it("对话事件不进轨迹；事件少于 5 条时默认收起", () => {
    G.S.events = [
      { seq: 1, ts: 1, kind: "chat.turn", turn: {} },
      { seq: 2, ts: 2, kind: "corpus.ready", stats: { files: 1 } },
    ];
    const c = trace();
    expect(c.querySelector("summary")!.textContent).toBe("推理轨迹 · 1 条");
    expect((c.querySelector("details") as any).open).toBe(false);
  });

  it("事件多了默认展开 —— 看不见的推理和编造的区别，用户是分辨不出来的", () => {
    G.S.events = Array.from({ length: 5 }, (_, i) => ({ seq: i, ts: i, kind: "node.entered", node: "N" }));
    expect((trace().querySelector("details") as any).open).toBe(true);
  });

  it("没有事件时不占位置", () => {
    G.S.events = [];
    expect(trace().innerHTML).toBe("");
  });

  it("失败一眼看得出来（.tag.err），要点里的标记是文本", () => {
    G.S.events = [{ seq: 1, ts: 1, kind: "persist.failed", error: EVIL }];
    const c = trace();
    expect(c.querySelector(".step > .tag.err")!.textContent).toBe("落库失败");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".sub")!.textContent).toBe(EVIL);
  });
});

// ══════════════════════════════════════════════════════════════════
//  markdown：React 下唯一还能被打穿的那条路
// ══════════════════════════════════════════════════════════════════
describe("助手气泡里的注入", () => {
  const say = (text: string): any => {
    G.S.state.dialogue.turns = [turn("assistant", 1, text)];
    return mount();
  };

  it("`\"><img src=x onerror=alert(1)>` 是字，不是一个会执行的元素", () => {
    const c = say(`看这个 ${EVIL} 行不行`);
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".mdbody")!.textContent).toContain(EVIL);
    // 判据是**属性名集合**：整棵子树上一个 on* 都不许有。拿 innerHTML 去 match
    // /\son[a-z]+=/ 是不行的 —— 被正确转义成文本的那一串里也有那个形状。
    const names = new Set<string>();
    const visit = (el: Element): void => {
      for (const a of Array.from(el.attributes) as any[]) names.add(a.name);
      for (const k of Array.from(el.children) as any[]) visit(k);
    };
    visit(c);
    expect([...names].filter(n => n.startsWith("on"))).toEqual([]);
  });

  it("`[x](javascript:alert(1))` 不会变成一个可点的链接", () => {
    // md() 根本不认链接语法 —— 于是这一串原样显示成字。**这正是要断的**：
    // 哪天有人给 md() 加上链接支持，这条会立刻红，提醒他补 javascript: 的过滤。
    const c = say(`[x](javascript:alert(1))`);
    expect(c.querySelector(".mdbody a")).toBeNull();
    expect(c.querySelector(".mdbody")!.textContent).toContain("[x](javascript:alert(1))");
  });

  it("<script> 既不成元素也不执行", () => {
    delete (globalThis as any).__pwned;
    const c = say(`<script>globalThis.__pwned=1</script>`);
    expect(c.querySelector("script")).toBeNull();
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  it("用户自己那半边是纯文本，连 markdown 都不过", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "**不该变粗**")];
    const c = mount();
    expect(c.querySelector("strong")).toBeNull();
    expect(c.querySelector(".bub.me > .body")!.textContent).toBe("**不该变粗**");
  });
});

// ══════════════════════════════════════════════════════════════════
//  打字机：截断与那根光标
// ══════════════════════════════════════════════════════════════════
describe("打字机", () => {
  it("正在流的那条按进度截断，末尾挂一根光标", () => {
    G.S.state.dialogue.turns = [turn("assistant", 1, "一二三四五")];
    G.STREAM = { full: "一二三四五", i: 2, timer: null, t0: 0 };
    const c = mount();
    expect(c.querySelector(".mdbody")!.textContent).toBe("一二");
    expect(c.querySelector(".mdbody > .cur")).not.toBeNull();
  });

  it("揭示完就收起光标 —— 一根永远闪着的光标看起来像卡住了", () => {
    G.S.state.dialogue.turns = [turn("assistant", 1, "一二三四五")];
    G.STREAM = { full: "一二三四五", i: 5, timer: null, t0: 0 };
    expect(mount().querySelector(".cur")).toBeNull();
  });

  it("**只截当前正在流的那一条** —— 历史消息不受影响", () => {
    G.S.state.dialogue.turns = [turn("assistant", 1, "很久以前那句"), turn("assistant", 2, "正在流的这句")];
    G.STREAM = { full: "正在流的这句", i: 2, timer: null, t0: 0 };
    const bodies = [...mount().querySelectorAll(".mdbody")].map((e: any) => e.textContent);
    expect(bodies).toEqual(["很久以前那句", "正在"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  入场动画与滚到底
// ══════════════════════════════════════════════════════════════════
describe("入场动画", () => {
  it("换会话时把计数对齐总数 —— 三十条历史不该一起飞进来", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "甲"), turn("assistant", 2, "乙")];
    const c = mount();
    expect(c.querySelectorAll(".bub.in")).toHaveLength(0);
    expect(G.SEEN_BUBBLES).toBe(2);
  });

  it("只有这一次新出现的那条播动画", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "甲")];
    const c = mount();
    act(() => { G.S.state.dialogue.turns.push(turn("assistant", 2, "乙")); paintMiddle(); });
    const bubs = [...c.querySelectorAll(".bub")] as any[];
    expect(bubs[0]!.classList.contains("in")).toBe(false);
    expect(bubs[1]!.classList.contains("in")).toBe(true);
  });

  it("「思考中」那颗不算数 —— 否则答案是唯一拿不到动画的那条", () => {
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    G.THINKING = true;
    mount();
    expect(G.SEEN_BUBBLES).toBe(1);          // .think 那颗没被数进去
    act(() => {
      G.THINKING = false;
      G.S.state.dialogue.turns.push(turn("assistant", 2, "答"));
      paintMiddle();
    });
    expect(box().querySelectorAll(".bub.in")).toHaveLength(1);
  });
});

describe("自动滚到底", () => {
  it("人在底部：新消息跟着上来", () => {
    geometry(1000, 300);
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    mount();
    expect(box().scrollTop).toBe(1000);
  });

  it("**人翻上去看历史就别抢他的位置**", () => {
    geometry(1000, 300);
    G.S.state.dialogue.turns = [turn("user", 1, "问")];
    mount();
    // 用户往上翻：离底 700px，远超那 120px 的判据
    box().scrollTop = 0;
    fireEvent.scroll(box());
    act(() => { G.S.state.dialogue.turns.push(turn("assistant", 2, "答")); paintMiddle(); });
    expect(box().scrollTop).toBe(0);
    // 翻回底部之后又跟着滚
    box().scrollTop = 1000;
    fireEvent.scroll(box());
    act(() => { G.S.state.dialogue.turns.push(turn("user", 3, "再问")); paintMiddle(); });
    expect(box().scrollTop).toBe(1000);
  });
});
