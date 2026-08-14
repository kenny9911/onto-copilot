/**
 * 事件的呈现：词汇表、好坏判定、要点、时间线归并。
 *
 * timeline() 那段是修过一次真实 bug 的：事件卡片和聊天气泡以前**两段拼接**，
 * 于是一张在对话末尾产生的表被画在整段对话最上方，而渲染完又自动滚到底 ——
 * 用户看到助手说"请见下表"，下面什么都没有，他两次报"表没画出来"。判据是
 * 「工具卡挂到紧随其后的那条助手发言之后」，这里逐条钉住。
 */
import "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G } from "../src/ui/state.js";
import { evDetail, evLabel, evStats, evTag, hasCard, timeline, opsLog } from "../src/ui/events.js";

beforeEach(() => {
  G.S = { id: "s1", status: "done", state: {}, events: [] };
  G.OPS = [];
});

describe("evLabel / evTag", () => {
  it("认得的事件给中文，认不得的也要像人话（不吐原始 key）", () => {
    expect(evLabel("corpus.ready")).toBe("读完材料");
    expect(evLabel("some.brand_new")).toBe("some brand new");
    expect(evLabel(undefined)).toBe("");
  });

  it("`_failed` 和 `.failed` 是同一件事 —— 一屏灰条里混着一条失败等于没报", () => {
    expect(evTag("parse.failed")).toBe("err");
    expect(evTag("session.rename_failed")).toBe("err");
    expect(evTag("kernel.node_failed")).toBe("err");
    expect(evTag("quota.exhausted")).toBe("err");
  });

  it("警告与成功各自的判据", () => {
    for (const k of ["run.suspended", "quota.low", "budget.capped", "extract.dropped", "flow.stale_edits"]) {
      expect(evTag(k)).toBe("warn");
    }
    for (const k of ["run.completed", "node.completed", "artifact.ready", "corpus.ready"]) {
      expect(evTag(k)).toBe("ok");
    }
    expect(evTag("node.entered")).toBe("run");
  });
});

describe("evDetail / evStats", () => {
  it("**按事件类型分别说** —— prompts.ready 不是「决策」", () => {
    expect(evDetail({ kind: "prompts.ready", questions: [1, 2] })).toBe("2 条");
    expect(evDetail({ kind: "clarify.request", questions: [1, 2] })).toBe("2 个待拍板");
    expect(evDetail({ kind: "suggest.ready", suggestions: [1] })).toBe("1 条");
  });

  it("其余按统计字段，再兜底到错误/原因", () => {
    expect(evDetail({ kind: "node.completed", node: "PARSE", title: "解析" })).toBe("PARSE · 解析");
    expect(evDetail({ kind: "x", stats: { objects: 3, orphans: 0, unknown_key: 9 } })).toBe("对象 3");
    expect(evDetail({ kind: "x", error: "炸了" })).toBe("炸了");
    expect(evDetail({ kind: "x" })).toBe("");
  });

  it("evStats 跳过 0/null 与不认识的键", () => {
    expect(evStats({ objects: 2, properties: 0, links: null, nope: 5 })).toBe("对象 2");
    expect(evStats(null)).toBe("");
  });
});

describe("timeline 归并", () => {
  const asst = (ts: number, text: string) => ({ speaker: "assistant", ts, text });
  const user = (ts: number, text: string) => ({ speaker: "user", ts, text });

  it("工具卡挂到紧随其后的那条助手发言之后，而不是插在提问和回答中间", () => {
    G.S.events = [{ seq: 1, ts: 150, kind: "ui.table", title: "清单", columns: ["a"], rows: [["1"]] }];
    const dlg = [user(100, "列一下"), asst(200, "已列出，见下表")];
    const keys = timeline(dlg).map((x: any) => x.key);
    // 表的 ts 是 150（早于回答），但排序键被抬到了 200 —— 排在回答之后
    expect(keys).toEqual([100, 200, 200]);
    // 归并返回的是**次序**，画的人是 <Stream>（react/stream.tsx）：每一项要么是
    // 一条发言，要么是一张事件卡。
    expect(timeline(dlg)[2]!.ev.title).toBe("清单");
    expect(timeline(dlg)[1]!.turn.text).toBe("已列出，见下表");
  });

  it("后面没有助手发言的卡片按自己的时刻排，位置不变", () => {
    G.S.events = [{ seq: 1, ts: 300, kind: "artifact.ready", name: "模板.xlsx", stats: {} }];
    const dlg = [user(100, "开始")];
    expect(timeline(dlg).map((x: any) => x.key)).toEqual([100, 300]);
  });

  it("下一条是用户发言时不抬 —— 只有助手那一轮才收编工具卡", () => {
    G.S.events = [{ seq: 1, ts: 150, kind: "artifact.ready", name: "a.xlsx", stats: {} }];
    const dlg = [user(100, "甲"), user(200, "乙")];
    expect(timeline(dlg).map((x: any) => x.key)).toEqual([100, 150, 200]);
  });

  it("画不出卡片的事件被滤掉（大多数事件只进推理轨迹）", () => {
    G.S.events = [{ seq: 1, ts: 150, kind: "node.entered", node: "PARSE" }];
    expect(timeline([user(100, "甲")]).length).toBe(1);
  });

  it("同一时刻的多张卡片按事件顺序稳定排列", () => {
    G.S.events = [
      { seq: 1, ts: 100, kind: "run.failed", error: "一" },
      { seq: 2, ts: 100, kind: "run.failed", error: "二" },
    ];
    expect(timeline([]).map((x: any) => x.ev.error)).toEqual(["一", "二"]);
  });

  it("**滤掉的那些不占 ord** —— 次序不随不相干事件的增删漂移", () => {
    // ord 用的是事件在 events 里的下标。中间插进一条画不出卡片的事件之后，
    // 两张卡的相对次序必须纹丝不动。
    G.S.events = [
      { seq: 1, ts: 100, kind: "run.failed", error: "一" },
      { seq: 2, ts: 100, kind: "node.entered", node: "PARSE" },
      { seq: 3, ts: 100, kind: "run.failed", error: "二" },
    ];
    expect(timeline([]).map((x: any) => x.ev.error)).toEqual(["一", "二"]);
  });
});

describe("hasCard：哪些事件值得单独占一张卡片", () => {
  it("大多数事件只进推理轨迹，只有需要人读全文的才升级成卡片", () => {
    for (const k of ["parse.failed", "human.recorded", "artifact.ready", "audit.applied",
                     "ui.table", "export.ready", "run.failed", "session.restored"]) {
      expect(hasCard({ kind: k }), k).toBe(true);
    }
    for (const k of ["node.entered", "prompts.ready", "chat.turn", "plan.frozen"]) {
      expect(hasCard({ kind: k }), k).toBe(false);
    }
  });

  it("corpus.ready 只有**发现了问题**才占一张卡 —— 「读完了」轨迹里已经有一行", () => {
    expect(hasCard({ kind: "corpus.ready", findings: [{ message: "x" }] })).toBe(true);
    expect(hasCard({ kind: "corpus.ready", findings: [] })).toBe(false);
    expect(hasCard({ kind: "corpus.ready" })).toBe(false);
  });
});

// 推理轨迹那两条搬去了 ui.react.stream.test.tsx —— 它归 <TraceCard>
// （react/events.tsx）之后，在这份 ui.env 字符串 stub 上测不了一棵真组件树。
// 判据一个字没改：对话事件不进轨迹、事件少于 5 条默认收起、没有事件不占位置。
describe("opsLog", () => {
  it("操作记录倒序，最新的在最上面", () => {
    G.OPS = [
      { seq: 1, kind: "a", ts: 1, label: "一", detail: "", tag: "run" },
      { seq: 2, kind: "b", ts: 2, label: "二", detail: "", tag: "ok" },
    ];
    const html = opsLog();
    expect(html).toContain("操作记录 · 2 条");
    expect(html.indexOf("二")).toBeLessThan(html.indexOf("一"));
  });

  it("没有操作记录时不占位置", () => {
    G.OPS = [];
    expect(opsLog()).toBe("");
  });
});
