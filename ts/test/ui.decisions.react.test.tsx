// @vitest-environment happy-dom
/**
 * 待办卡片（必须人拍板的决策 + 不阻塞的建议）的行为契约 —— **组件版**。
 *
 * 内联 JS 时代这块没有测试：pendingCard() / questionCards() / suggestionCards() 三个
 * 拼串函数一行覆盖都没有，而它们管的是**这个产品里唯一一处不可逆动作的入口**
 * （「确认」下去就写进 Decision Ledger 并触发产物重算）。改写成组件顺手把这笔补上。
 *
 * 钉住的东西：
 *   · **没选中就点不动「确认」** —— 那一格选择就是这次不可逆动作的输入；
 *   · **已确认的卡不能再改** —— 选项没有点击行为，只剩一行「已确认」；
 *   · **每条建议都能直接采纳**，且采纳走的是对话通道（和用户自己打字说
 *     「第 N 条建议采纳」**同一条路径**）—— 两条路径会漂移，漂移那天你不知道信哪个；
 *   · ASK_MATERIAL 例外：它要的是上传材料，不是一次可执行的改动，所以没有按钮。
 *
 * 环境与 ui.contracts.workbench.react.test.tsx 同一套（见那份文件头）：立 index.html
 * 的真 body，不 mock 环里的 paint / render。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { G } from "../src/ui/state.js";
import { PendingCard } from "../src/ui/react/pending.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_HTML = readFileSync(resolve(ROOT, "ui", "index.html"), "utf8");
const SHELL = (() => {
  const from = INDEX_HTML.indexOf("<body>") + "<body>".length;
  return INDEX_HTML.slice(from, INDEX_HTML.indexOf("<script>", from));
})();

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
const g = globalThis as any;

const BASE_ROUTES: Array<[RegExp, any]> = [
  [/\/api\/sessions$/, []], [/\/api\/projects$/, { projects: [] }],
];

/** 按 URL 片段路由的假 fetch，并记下每一次请求。 */
function installFetch(routes: Array<[RegExp, any]> = []): void {
  g.fetch = async (url: string, opts: any = {}) => {
    const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method: opts.method || "GET", body });
    // refresh() 会连带拉一次会话列表 —— 不给它形状对的空壳，某条断言之外的
    // 代码路径会在 all.filter 上抛一个跟本用例无关的 unhandled rejection。
    for (const [re, payload] of [...routes, ...BASE_ROUTES] as Array<[RegExp, any]>) {
      if (re.test(String(url))) {
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
}

const card = () => render(<PendingCard />).container;
const btn = (root: Element, label: string): any =>
  Array.from(root.querySelectorAll("button") as any[]).find((b: any) => b.textContent === label);
const click = async (el: any): Promise<void> => { await act(async () => { fireEvent.click(el); }); };

/** 一个待拍板的决策。 */
const decision = (o: Record<string, unknown> = {}) => ({
  id: "d1", conflict_rid: "c1", title: "订单日期用哪个口径", impact_count: 4, reversible: false,
  options: [
    { id: "o1", label: "按下单时间", rationale: "多数报表这么算",
      evidence: [{ file_name: "订单表.xlsx", cite: "订单表.xlsx!Sheet1!R2C3" }] },
    { id: "o2", label: "按发货时间", rationale: "" },
  ], ...o,
});
const suggestion = (o: Record<string, unknown> = {}) => ({
  kind: "ADD_LINK", title: "把客户和订单连起来", impact: 3, confidence: 0.82,
  rationale: "两张表里都有客户编码", citations: ["订单表.xlsx!Sheet1!R1C1"], ...o,
});

beforeEach(() => {
  document.body.innerHTML = SHELL;
  calls = [];
  g.CSS = g.CSS || { escape: (s: string) => s };
  // refresh() 走到底会 connect() 一条 SSE —— happy-dom 没有 EventSource，
  // 不给个空壳就是一条与本用例无关的 unhandled rejection。
  g.EventSource = class { close(): void {} };
  g.alert = () => {};
  g.confirm = () => false;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 1,
          state: { dialogue: { turns: [] }, artifacts: [] }, events: [], filelist: [] };
  G.ANSWERS = {};
  G.PENDING_OPEN = true;
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = []; G.PROMPTS = []; G.FOLLOWUPS = [];
  G.THINKING = false; G.CHAT_ABORT = null;
  installFetch();
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  外壳
// ══════════════════════════════════════════════════════════════════
describe("待办卡片是对话流里的一条消息", () => {
  it("没有决策也没有建议时整块不画 —— 不留一个空壳", () => {
    expect(card().innerHTML).toBe("");
  });

  it("标题上写清楚有几件事，两块都有时用 · 连起来", () => {
    G.S.state.questions = [decision()];
    G.S.state.suggestions = [suggestion()];
    expect(card().querySelector(".pchead").textContent).toContain("1 个待拍板 · 1 条建议");
  });

  it("已确认的决策不再计入「待拍板」", () => {
    G.S.state.questions = [decision()];
    G.S.state.answered = ["c1"];
    // 只剩一条建议，那句「N 个待拍板」就该消失
    G.S.state.suggestions = [suggestion()];
    expect(card().querySelector(".pchead").textContent).not.toContain("待拍板");
  });

  it("可折叠：处理过一轮之后它该让位给对话", async () => {
    G.S.state.questions = [decision()];
    const c = card();
    expect(c.querySelector(".pcbody")).not.toBeNull();
    expect(c.querySelector(".ptri").textContent).toBe("▾");
    await click(c.querySelector(".pchead"));
    expect(G.PENDING_OPEN).toBe(false);
    expect(c.querySelector(".pcbody")).toBeNull();
    expect(c.querySelector(".ptri").textContent).toBe("▸");
  });

  it("结构与类名和原来逐字一致", () => {
    G.S.state.questions = [decision()];
    G.S.state.suggestions = [suggestion()];
    const c = card();
    for (const sel of [".pcard", ".pchead", ".ptri", ".pchi", ".pcbody",
                       ".q", ".qh", ".qm", ".qt", ".qbody", ".opt", ".rd", ".rr", ".ev",
                       ".sgc", ".sgh", ".sgi", ".sgt", ".sgm", ".sgr"]) {
      expect(c.querySelector(sel), sel).not.toBeNull();
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  决策：选一个才点得动
// ══════════════════════════════════════════════════════════════════
describe("必须人拍板的决策", () => {
  it("元信息给的是「第几条 / 影响多少 / 可不可逆」", () => {
    G.S.state.questions = [decision()];
    const c = card();
    expect(c.querySelector(".qm").textContent).toBe("第 1/1 个问题 · 涉及 4 项 · 确认后不能自动撤销");
    expect(c.querySelector(".qt").textContent).toBe("订单日期用哪个口径");
  });

  it("**没选中之前「确认」是点不动的**", () => {
    G.S.state.questions = [decision()];
    expect(btn(card(), "确认").disabled).toBe(true);
  });

  it("选一个 → 那一项高亮，确认解锁；再选另一个只有一项高亮", async () => {
    G.S.state.questions = [decision()];
    const c = card();
    const opts = Array.from(c.querySelectorAll(".opt") as any[]);
    await click(opts[0]);
    expect(G.ANSWERS["d1"]).toBe("o1");
    expect(opts[0].className).toBe("opt sel");
    expect(btn(c, "确认").disabled).toBe(false);
    await click(opts[1]);
    expect(Array.from(c.querySelectorAll(".opt.sel") as any[])).toHaveLength(1);
    expect(G.ANSWERS["d1"]).toBe("o2");
  });

  it("确认 → POST /api/sessions/{id}/answer，带 conflict_rid 与选中的 option_id", async () => {
    G.S.state.questions = [decision()];
    const c = card();
    await click(c.querySelector(".opt"));
    await click(btn(c, "确认"));
    const answer = calls.find(x => x.url === "/api/sessions/s1/answer")!;
    expect(answer.method).toBe("POST");
    expect(answer.body).toMatchObject({ conflict_rid: "c1", option_id: "o1" });
    expect(answer.body.note).toBeTruthy();
  });

  it("已确认的卡：只剩「已确认」，选项点不动，也没有提交入口", async () => {
    G.S.state.questions = [decision()];
    G.S.state.answered = ["c1"];
    G.S.state.suggestions = [suggestion()];   // 全答完时整块会收起来，留一条建议把它撑住
    const c = card();
    expect(c.querySelector(".q").className).toContain("answered");
    expect(c.querySelector(".cap").textContent).toBe("已确认");
    expect(btn(c, "确认")).toBeUndefined();
    await click(c.querySelector(".opt"));
    expect(G.ANSWERS["d1"]).toBeUndefined();     // 点了也不该记下任何选择
  });

  it("选项里的证据能跳回原文，且不会顺手把这一项选上", async () => {
    G.S.state.questions = [decision()];
    const c = card();
    const ev = c.querySelector(".ev");
    expect(ev.textContent).toBe("◧ 订单表.xlsx!Sheet1!R2C3");
    await click(ev);
    expect(G.TAB).toBe("evidence");
    expect(G.FILE).toBe("订单表.xlsx");
    expect(G.ANSWERS["d1"]).toBeUndefined();     // stopPropagation 还在
  });
});

// ══════════════════════════════════════════════════════════════════
//  建议：每一条都要能直接采纳
// ══════════════════════════════════════════════════════════════════
describe("不阻塞的建议", () => {
  it("图标按种类给，认不出的种类退回中性的 ▸", () => {
    G.S.state.suggestions = [suggestion(), suggestion({ kind: "没见过的种类" })];
    const icons = Array.from(card().querySelectorAll(".sgi") as any[]).map((x: any) => x.textContent);
    expect(icons).toEqual(["⇢", "▸"]);
  });

  it("涉及范围与可信度都写出来（可信度是百分比）", () => {
    G.S.state.suggestions = [suggestion()];
    expect(card().querySelector(".sgm").textContent).toBe("涉及 3 项 · 可信度 82%");
  });

  it("问题与建议只展示业务文案，不泄露内部协议和类型名", () => {
    G.S.state.questions = [decision({
      title: "[高][ERP顾问][blocked:sys_metaerp] 请确认系统版本 | answer:TEXT | evidence:材料#p1",
      options: [{ id: "o1", label: "按 ObjectType 处理", rationale: "apiName 不是 lowerCamelCase" }],
    })];
    G.S.state.suggestions = [suggestion({
      title: "3 个对象没有任何 ActionType",
      rationale: "建议先补进 Ontology，**不要直接发布**",
    })];
    const text = card().textContent;
    expect(text).toContain("请确认系统版本");
    expect(text).toContain("按业务对象处理");
    expect(text).toContain("系统名称不是首字母小写的英文名称");
    expect(text).toContain("3 个对象没有任何业务操作");
    expect(text).toContain("建议先补进业务模型，不要直接发布");
    expect(text).not.toMatch(/blocked:|answer:TEXT|evidence:|ObjectType|ActionType|apiName|lowerCamelCase|Ontology|\*\*/u);
  });

  it("**采纳走对话通道** —— 和用户自己打字说「第 N 条建议采纳」同一条路径", async () => {
    G.S.state.suggestions = [suggestion({ title: "甲" }), suggestion({ title: "乙" })];
    const c = card();
    await click(Array.from(c.querySelectorAll(".sgc") as any[])[1].querySelector("button"));
    const chat = calls.find(x => x.url === "/api/sessions/s1/chat")!;
    expect(chat.method).toBe("POST");
    expect(chat.body.text).toBe("第2条建议采纳");
  });

  it("ASK_MATERIAL 没有采纳按钮 —— 它要的是上传材料，不是一次可执行的改动", () => {
    G.S.state.suggestions = [suggestion({ kind: "ASK_MATERIAL" })];
    const c = card();
    expect(c.querySelector(".sgc button")).toBeNull();
    expect(c.querySelector(".sgt").textContent).toBe("把客户和订单连起来");
  });

  it("建议里的引用也能跳回原文（只有 cite、没有文件名的那种）", async () => {
    G.S.state.suggestions = [suggestion({ citations: ["订单表.xlsx!Sheet1!R1C1"] })];
    await click(card().querySelector(".sgc .ev"));
    // openSource('', cite) 会从 cite 前缀兜底出文件名
    expect(G.FILE).toBe("订单表.xlsx");
  });
});

// ══════════════════════════════════════════════════════════════════
//  转义：这块屏幕上的敌意输入也必须是字
// ══════════════════════════════════════════════════════════════════
describe("敌意输入渲染成文本，不是标记", () => {
  const EVIL = `"><img src=x onerror=alert(1)>`;

  it("决策标题 / 选项 / 建议正文里的标记都是字", () => {
    G.S.state.questions = [decision({ title: EVIL, options: [{ id: "o1", label: EVIL, rationale: EVIL }] })];
    G.S.state.suggestions = [suggestion({ title: EVIL, rationale: EVIL })];
    const c = card();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".qt").textContent).toBe(EVIL);
    expect(c.querySelector(".sgt").textContent).toBe(EVIL);
    expect(c.innerHTML).not.toMatch(/\son[a-z]+="/);
  });

  it("敌意的 id 进到 data-submit 里也长不出新属性", () => {
    G.S.state.questions = [decision({ id: EVIL })];
    G.ANSWERS[EVIL] = "o1";
    const c = card();
    const b = btn(c, "确认");
    expect(b.getAttribute("data-submit")).toBe(EVIL);
    expect(Array.from(b.attributes as any[]).map((a: any) => a.name).filter((n: string) => n.startsWith("on")))
      .toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  确认失败：不许静默
//
//  2026-08-25 用户实拍：会话正在 extracting，聊天里摆着「2 个待拍板」，
//  选了选项点「确认」—— 什么都没发生。真相是服务端 409（跑批激活期 mutation
//  租约必拒），而 postAnswer 没有 catch：一次人工拍板就这么无声消失了。
//  现在服务端改成排队（glue/decisions_queue.ts），界面必须把两种结局都说出来。
// ══════════════════════════════════════════════════════════════════
describe("「确认」的结局必须说出来", () => {
  it("服务端排队了 → 告诉用户已登记、跑完自动落账，而不是假装成功", async () => {
    const said: string[] = [];
    g.alert = (m: string) => { said.push(String(m)); };
    G.S.state.questions = [decision()];
    G.ANSWERS.d1 = "o1";
    installFetch([[/\/answer$/, { queued: true, depth: 1, message: "会话正在梳理，这次确认已经登记（队列第 1 位），本轮跑完自动落账，不用重点。" }]]);
    const c = card();
    await click(btn(c, "确认"));
    expect(calls.some((x) => x.url.endsWith("/answer"))).toBe(true);
    expect(said.join("\n")).toContain("已经登记");
    expect(said.join("\n")).not.toContain("没保存");
  });

  it("真失败 → 报出来（此前 409 被静默吞掉，用户只看到「点了没反应」）", async () => {
    const said: string[] = [];
    g.alert = (m: string) => { said.push(String(m)); };
    G.S.state.questions = [decision()];
    G.ANSWERS.d1 = "o1";
    g.fetch = async (url: string, opts: any = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET", body: null });
      if (String(url).endsWith("/answer")) {
        return { ok: false, status: 409, text: async () => JSON.stringify({ detail: "问题已更新：预期 version 1，实际 3" }), json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    const c = card();
    await click(btn(c, "确认"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("没有确认成功");
    expect(said[0]).toContain("version");
  });
});
