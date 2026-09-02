/**
 * 对话记录的合并、推荐问题 chips 的去留、操作记录与事件词汇表
 * （原 tests/test_ui_question_workbench.py 的后半）。
 *
 * 用户报过的两个症状都在这里：
 *   · 每条消息显示两遍 —— /state 已经带回完整 dialogue，SSE 重连又固定 ?since=0
 *     从耐久事件表把同样的 chat.turn 重放一遍。盲追加就翻倍。
 *   · 回答被吞 —— 一次滞后的 /state 回来后把 state 整个换掉，抹掉了 SSE 刚推上来、
 *     那次查询还没看到的助手回答。整体覆盖就丢。
 * 判据是「按身份合并」：说话人+时间戳+正文。
 *
 * chips 那一组同理：停止一轮 = abort 掉自己那条 fetch，响应连同它带的 chips 一起
 * 没了；服务端为这一轮算好的那批只落进了会话状态，得去取回来，否则剩下的是一批
 * 开场白，第一条往往正是他十轮前问过的那句。
 */
import "./ui.env.js";
import { FakeEventSource, el, resetDom } from "./ui.env.js";

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { G, OPS_CAP } from "../src/ui/state.js";
import { mergeStateSnapshot, stopChat } from "../src/ui/chat.js";
import { connect } from "../src/ui/sse.js";
import { openSession } from "../src/ui/sessions.js";
import { EV_LABEL, evDetail, opsLog } from "../src/ui/events.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const g = globalThis as any;
let calls: string[] = [];

/** 按 URL 片段路由的假 fetch。没命中的一律给一个空对象，别让被测代码炸在别处。 */
function installFetch(routes: Array<[RegExp, any]>): void {
  g.fetch = async (url: string, opts: any = {}) => {
    calls.push(`${opts.method || "GET"} ${url}`);
    for (const [re, payload] of routes) {
      if (re.test(String(url))) {
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
}

const turn = (speaker: string, ts: number, text: string) => ({ speaker, ts, text });
const ev = (o: Record<string, unknown>) => ({ seq: 1, ts: Math.floor(Date.now() / 1000), ...o });

function open(): FakeEventSource {
  connect();
  const es = FakeEventSource.last;
  if (!es) throw new Error("connect() 没有建 EventSource");
  return es;
}

beforeEach(() => {
  resetDom();
  calls = [];
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0,
          state: { dialogue: { turns: [] } }, events: [] };
  G.MODE = "work"; G.PROJECTS = []; G.PROJECTS_OK = false; G.SESSION_LIST = [];
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = []; G.QUOTA = null;
  G.PROMPTS = []; G.FOLLOWUPS = []; G.Q_BACKLOG = []; G.Q_NEXT = [];
  G.THINKING = false; G.CHAT_ABORT = null; G.TAB = "mat"; G.ES = null;
  installFetch([]);
});

// ══════════════════════════════════════════════════════════════════
//  对话记录：按身份合并，不盲追加、不整体覆盖
// ══════════════════════════════════════════════════════════════════
describe("chat.turn 走 addTurn，不是 push", () => {
  it("同一条从 SSE 重放两遍只留一份", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.turn", turn: turn("user", 1, "问") }));
    es.send(ev({ seq: 2, kind: "chat.turn", turn: turn("user", 1, "问") }));   // 重连重放
    expect(G.S.state.dialogue.turns.length).toBe(1);
  });

  it("/state 已经带回完整对话之后，SSE 的重放也不会翻倍", () => {
    mergeStateSnapshot({ id: "s1", state: { dialogue: { turns: [turn("user", 1, "问"), turn("assistant", 2, "答")] } } });
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.turn", turn: turn("user", 1, "问") }));
    es.send(ev({ seq: 2, kind: "chat.turn", turn: turn("assistant", 2, "答") }));
    expect(G.S.state.dialogue.turns.map((t: any) => t.text)).toEqual(["问", "答"]);
  });

  it("事件触发的那次 /state 重取是**合并**，不能把刚推上来的回答吞掉", async () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.turn", turn: turn("user", 1, "问") }));
    es.send(ev({ seq: 2, kind: "chat.turn", turn: turn("assistant", 2, "刚推上来的答") }));
    // 服务端那次查询发出时助手这一轮还没落库
    installFetch([[/\/state$/, { id: "s1", status: "done", filelist: [],
      state: { dialogue: { turns: [turn("user", 1, "问")], compactions: 2 } } }]]);
    es.send(ev({ seq: 3, kind: "run.completed" }));
    // 状态重取是**去抖**的（sse.ts scheduleStateRefresh，400ms 静默窗）——
    // 2026-08-25 页面冻死事故的修法：首连 `?since=0` 会回放上千条事件，每条都
    // 立刻拉一次 8MB 的 /state 会把渲染进程打满。合并语义没变，只是晚 400ms 到。
    await new Promise(r => setTimeout(r, 500));
    expect(G.S.state.dialogue.turns.map((t: any) => t.text)).toEqual(["问", "刚推上来的答"]);
    expect(G.S.state.dialogue.compactions).toBe(2);
  });
});

describe("mergeStateSnapshot：对话在 st.state.dialogue，不是响应顶层", () => {
  it("远端轮次并进来、远端元数据留住、本地事件流不动", () => {
    G.S = { events: [{ seq: 9 }], state: { dialogue: {
      turns: [turn("user", 1, "old")], decisions: [{ id: "local" }], compactions: 0 } } };
    G.PENDING = [];
    mergeStateSnapshot({
      events: 41,
      state: { marker: "server", dialogue: {
        turns: [turn("user", 1, "old"), turn("assistant", 2, "server-new")],
        decisions: [{ id: "remote" }], compactions: 2 } },
    });
    expect(G.S.state.dialogue.turns.map((t: any) => t.text)).toEqual(["old", "server-new"]);
    expect(G.S.state.dialogue.decisions).toEqual([{ id: "remote" }]);   // 元数据以远端为准
    expect(G.S.state.dialogue.compactions).toBe(2);
    expect(G.S.state.marker).toBe("server");                            // state 其余部分照抄远端
    expect(G.S.events).toEqual([{ seq: 9 }]);                           // 事件流是前端自己的，不被顶层覆盖
  });
});

// ══════════════════════════════════════════════════════════════════
//  推荐问题 chips
// ══════════════════════════════════════════════════════════════════
describe("chips 是会话的一部分", () => {
  it("重开一个聊过的会话，上一轮的追问跟着回来", async () => {
    installFetch([
      [/\/sessions\/s2\/state$/, { id: "s2", mode: "work", status: "done", filelist: [],
        prompts: [{ text: "开场" }], followups: [{ text: "接着问这个" }], state: {} }],
      [/\/api\/sessions$/, []],
      [/\/api\/projects$/, { projects: [] }],
      [/\/questions$/, { questions: [] }],
    ]);
    await openSession("s2");
    expect(G.FOLLOWUPS.map((c: any) => c.text)).toEqual(["接着问这个"]);
    expect(G.PROMPTS.map((c: any) => c.text)).toEqual(["开场"]);
  });

  it("停止一轮之后，把 abort 掉的那批 chips 从 /state 取回来", async () => {
    G.FOLLOWUPS = [];
    G.CHAT_ABORT = new AbortController();
    installFetch([[/\/state$/, { followups: [{ text: "这一轮服务端算好的追问" }] }]]);
    await stopChat();
    expect(calls).toContain("POST /api/sessions/s1/stop");
    expect(calls).toContain("GET /api/sessions/s1/state");
    expect(G.FOLLOWUPS.map((c: any) => c.text)).toEqual(["这一轮服务端算好的追问"]);
  });

  it("/state 也取不回来时不炸，交给 render 那边的兜底", async () => {
    G.FOLLOWUPS = [{ text: "上一轮的" }];
    g.fetch = async () => { throw new Error("网络断了"); };
    await expect(stopChat()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  操作记录：右栏「推理」要记下发生过的每一件事
// ══════════════════════════════════════════════════════════════════
describe("操作记录", () => {
  it("除了对话本身，发生的每一件事都记一笔", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.turn", turn: turn("user", 1, "问") }));
    es.send(ev({ seq: 2, kind: "chat.step", step: { turn: "t1", n: 1, thought: "想" } }));
    es.send(ev({ seq: 3, kind: "artifact.ready", name: "模板.xlsx", stats: {} }));
    es.send(ev({ seq: 4, kind: "persist.failed", error: "落库炸了" }));
    expect(G.OPS.map((o: any) => o.kind)).toEqual(["artifact.ready", "persist.failed"]);
    expect(opsLog()).toContain("操作记录 · 2 条");
    expect(opsLog()).toContain("落库炸了");
  });

  it("切会话要清台账，否则串台", async () => {
    G.OPS = [{ seq: 1, kind: "artifact.ready", ts: 1, label: "产物就绪", detail: "", tag: "ok" }];
    installFetch([
      [/\/sessions\/s2\/state$/, { id: "s2", mode: "work", status: "done", filelist: [], state: {} }],
      [/\/api\/sessions$/, []], [/\/api\/projects$/, { projects: [] }], [/\/questions$/, { questions: [] }],
    ]);
    await openSession("s2");
    expect(G.OPS).toEqual([]);
    expect(opsLog()).toBe("");
  });

  it("封顶，长会话不许把内存吃光", () => {
    const es = open();
    for (let i = 1; i <= OPS_CAP + 5; i++) es.send(ev({ seq: i, kind: "node.entered", node: "N" + i }));
    expect(G.OPS.length).toBe(OPS_CAP);
  });
});

describe("事件在界面上都要有中文说法", () => {
  it("服务端**实际会发的**每一种事件都有标签，不冒原始 key", () => {
    // 期望值原来是**扫 Python 原件**的 `.emit("…")` 得到的（服务端实际会发什么，
    // 由服务端代码说了算，不由这份标签表说了算）。全量 TS 化之后
    // `src/ontocopilot/` 已删，改读 `golden/python.frozen.json` —— 那 54 种事件
    // 是删除前一次性冻下来的，判据一个字没变：**服务端会发的，界面上必须有中文说法**。
    const frozen = JSON.parse(
      readFileSync(resolve(ROOT, "golden", "python.frozen.json"), "utf8"),
    ) as { server_emits: string[] };
    const emitted = new Set<string>(frozen.server_emits);
    // 对话本身不进操作记录（它在聊天窗口里，抄一遍是噪声）
    emitted.delete("chat.turn"); emitted.delete("chat.step");
    expect(emitted.size).toBeGreaterThan(0);   // 正则失效的话这条测试等于没跑
    expect([...emitted].filter(k => !EV_LABEL[k]).sort()).toEqual([]);
  });

  it("推荐问题不是决策 —— 两件完全不同的事", () => {
    expect(evDetail({ kind: "prompts.ready", questions: [1, 2] })).toBe("2 条");
    expect(evDetail({ kind: "clarify.request", questions: [1, 2] })).toBe("2 个待拍板");
    // 旧写法：任何带 questions 的事件都算决策。只看代码行 —— 注释里讲的正是这个
    // 旧写法为什么错，别把它算成违规。
    const offenders: string[] = [];
    for (const f of walk(resolve(ROOT, "ts", "src", "ui"), ".ts")) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("个决策") && !line.trim().startsWith("//")) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("额度提醒条的隐藏靠的是显式 CSS", () => {
  it("`.qbar[hidden]{display:none}` 必须在 —— 类选择器的优先级高过 [hidden] 的默认样式", () => {
    // 只写 .qbar{display:flex} 的话，paintQuotaBar 把 hidden 设回 true 也关不掉：
    // 界面顶上永远挂着一条 21px 高、没有任何文字的警告色横条。实测复现过。
    expect(readFileSync(resolve(ROOT, "ui", "index.html"), "utf8"))
      .toContain(".qbar[hidden]{display:none}");
  });
});

describe("后台步骤不进对话流", () => {
  it("aux 轮只进推理轨迹，STEPS 不动（答案下方不再冒一张思考卡）", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.step", step: { turn: "aux", n: 1, thought: "想推荐问题：…" } }));
    expect(G.STEPS).toEqual([]);
    expect(G.TRACE.length).toBe(1);
    expect(G.TRACE[0].thought).toBe("想推荐问题：…");
  });

  it("普通一轮的步骤照常进对话流", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.step", step: { turn: "t1", n: 1, thought: "先查一下" } }));
    expect(G.STEPS.length).toBe(1);
    expect(G.TRACE.length).toBe(1);
  });
});

describe("聊天窗口里永远有「接下来能问什么」", () => {
  it("这一轮还在路上时不画，落地后追问顶上；追问为空退回开场那批", async () => {
    // render 那三条判据已由 ui.render.test.ts 钉住；这里钉的是**状态怎么来的**：
    // 一轮结束后 FOLLOWUPS 要么是这一轮的，要么退回 PROMPTS，不会两者都空。
    G.PROMPTS = [{ text: "开场" }];
    G.FOLLOWUPS = [];
    G.CHAT_ABORT = new AbortController();
    installFetch([[/\/state$/, { followups: [] }]]);
    await stopChat();
    expect(G.FOLLOWUPS).toEqual([]);
    expect(G.PROMPTS.length).toBe(1);        // 兜底那批还在，render 会用它
    el("stream").innerHTML = "";
  });
});
