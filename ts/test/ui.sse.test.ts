/**
 * SSE 事件分派。
 *
 * connect() 那个 onmessage 是整个前端**最容易悄悄坏掉**的一段：EventSource 掉线
 * 会自动重连，而重连总是 ?since=0 —— 服务端把整条事件流从头再放一遍。原件注释里
 * 记着两条由此而来的真实 bug（消息显示两遍 / 表画两遍、导出按钮指向不存在的 seq），
 * 判据全在这段代码里。抽成模块之后这些判据必须逐条还在，所以这里造一个假的
 * EventSource，把事件按真实形态喂进去，断言归约结果。
 */
import "./ui.env.js";
import { FakeEventSource } from "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G, OPS_CAP, TBL_OPEN } from "../src/ui/state.js";
import { connect } from "../src/ui/sse.js";

function freshSession(): void {
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 0, state: {}, events: [] };
  G.OPS = [];
  G.TRACE = [];
  G.STEPS = [];
  G.QUOTA = null;
  G.TAB = "mat";
  TBL_OPEN.clear();
}

function open(): FakeEventSource {
  connect();
  const es = FakeEventSource.last;
  if (!es) throw new Error("connect() 没有建 EventSource");
  return es;
}

const ev = (o: Record<string, unknown>): Record<string, unknown> =>
  ({ seq: 1, ts: Math.floor(Date.now() / 1000), ...o });

describe("connect() 的事件分派", () => {
  beforeEach(freshSession);

  it("订阅的是当前会话，且总是从 since=0 起", () => {
    expect(open().url).toBe("/api/sessions/s1/stream?since=0");
  });

  it("按 seq 去重并保持有序 —— 重放同一条不会画两遍", () => {
    const es = open();
    es.send(ev({ seq: 2, kind: "node.entered", node: "PARSE" }));
    es.send(ev({ seq: 1, kind: "files.attached", files: ["a.xlsx"] }));
    es.send(ev({ seq: 2, kind: "node.entered", node: "PARSE" })); // 重放
    expect(G.S.events.map((e: any) => e.seq)).toEqual([1, 2]);
  });

  it("stream.reset 清空事件、操作记录和表格展开态", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "ui.table", title: "清单", columns: ["a"], rows: [["1"]] }));
    TBL_OPEN.add(1);
    expect(G.S.events.length).toBe(1);
    expect(G.OPS.length).toBe(1);

    es.send(ev({ seq: 0, kind: "stream.reset" }));
    expect(G.S.events).toEqual([]);
    expect(G.OPS).toEqual([]);
    expect(TBL_OPEN.size).toBe(0);
  });

  it("对话事件不进操作记录（它在聊天窗口里，抄一遍是噪声）", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.turn", turn: { speaker: "user", text: "hi", ts: 1 } }));
    es.send(ev({ seq: 2, kind: "corpus.ready", stats: { files: 1, chunks: 3 } }));
    expect(G.OPS.map((o: any) => o.kind)).toEqual(["corpus.ready"]);
    expect(G.OPS[0].label).toBe("读完材料");
    expect(G.OPS[0].tag).toBe("ok");
    expect(G.OPS[0].detail).toBe("文件 1 · 切片 3");
  });

  it("操作记录封顶，长会话不会把内存吃光", () => {
    const es = open();
    for (let i = 1; i <= OPS_CAP + 20; i++) es.send(ev({ seq: i, kind: "node.entered", node: "N" + i }));
    expect(G.OPS.length).toBe(OPS_CAP);
    // 砍的是最老的一批
    expect(G.OPS[0].detail).toBe("N21");
  });

  it("额度：quota.exhausted 竖起提醒条，一次成功的回答把它撤掉", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "quota.exhausted", detail: "insufficient balance" }));
    expect(G.QUOTA.kind).toBe("quota.exhausted");
    es.send(ev({ seq: 2, kind: "chat.turn", turn: { speaker: "assistant", text: "ok", ts: 2 } }));
    expect(G.QUOTA).toBe(null);
  });

  it("已经在喊「没钱了」时，一条 quota.low 不能把它降级成温和的黄条", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "quota.exhausted" }));
    es.send(ev({ seq: 2, kind: "quota.low", remaining: 3 }));
    expect(G.QUOTA.kind).toBe("quota.exhausted");
  });

  it("隔夜的额度事件不复活 —— 提醒条断言的是此刻", () => {
    const es = open();
    const old = Math.floor(Date.now() / 1000) - 7 * 3600;
    es.send({ seq: 1, ts: old, kind: "quota.exhausted" });
    expect(G.QUOTA).toBe(null);
  });

  it("chat.step 按 turn#n 就地更新，同一步回调两次不会追加", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.step", step: { turn: "t1", n: 1, thought: "想" } }));
    es.send(ev({ seq: 2, kind: "chat.step", step: { turn: "t1", n: 1, thought: "想", observation: "查到了" } }));
    expect(G.STEPS.length).toBe(1);
    expect(G.STEPS[0].observation).toBe("查到了");
    expect(G.TRACE.length).toBe(1);
  });

  it("aux 轮的后台调用只进推理轨迹，不进对话流", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.step", step: { turn: "aux", n: 1, thought: "想推荐问题" } }));
    expect(G.STEPS).toEqual([]);
    expect(G.TRACE.length).toBe(1);
  });

  it("助手回答落地时收起过程", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "chat.step", step: { turn: "t1", n: 1, thought: "想" } }));
    expect(G.STEPS.length).toBe(1);
    es.send(ev({ seq: 2, kind: "chat.turn", turn: { speaker: "assistant", text: "答", ts: 2 } }));
    expect(G.STEPS).toEqual([]);
  });

  it("内核事件映成同一种行结构，归到「材料梳理」那一轮", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "kernel.thought", detail: "先看表头" }));
    es.send(ev({ seq: 2, kind: "kernel.plan", detail: "分三步" }));
    es.send(ev({ seq: 3, kind: "kernel.observation", node: "SQL", detail: "12 行" }));
    es.send(ev({ seq: 4, kind: "kernel.node_failed", node: "EXTRACT", detail: "超时" }));
    expect(G.TRACE.map((x: any) => [x.turn, x.n, x.thought ?? x.observation])).toEqual([
      ["build", 1, "先看表头"],
      ["build", 2, "计划：分三步"],
      ["build", 3, "12 行"],
      ["build", 4, "EXTRACT 失败：超时"],
    ]);
    expect(G.TRACE[2].tool).toBe("SQL");
  });

  it("没有映射的 kernel.* 事件不进轨迹（只进操作记录）", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "kernel.unknown", detail: "x" }));
    expect(G.TRACE).toEqual([]);
    expect(G.OPS.length).toBe(1);
  });

  it("clarify / suggest / CONFLICT 直接改会话状态", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "suggest.ready", suggestions: [{ title: "s" }] }));
    es.send(ev({ seq: 2, kind: "node.completed", node: "CONFLICT", conflicts: [{ kind: "k" }] }));
    expect(G.S.state.suggestions.length).toBe(1);
    expect(G.S.state.conflicts.length).toBe(1);
  });

  it("prompts.ready 只认 opening 那一槽（一轮的追问走 /chat 的响应）", () => {
    const es = open();
    G.PROMPTS = [];
    es.send(ev({ seq: 1, kind: "prompts.ready", slot: "followup", questions: [{ text: "a" }] }));
    expect(G.PROMPTS).toEqual([]);
    es.send(ev({ seq: 2, kind: "prompts.ready", slot: "opening", questions: [{ text: "b" }] }));
    expect(G.PROMPTS.map((q: any) => q.text)).toEqual(["b"]);
  });

  it("session.renamed 就地改三处显示，不重拉列表", () => {
    const es = open();
    G.SESSION_LIST = [{ id: "s1", title: "旧" }];
    es.send(ev({ seq: 1, kind: "session.renamed", title: "新名字" }));
    expect(G.S.title).toBe("新名字");
    expect(G.SESSION_LIST[0].title).toBe("新名字");
  });

  it("重连时会关掉上一条流", () => {
    const first = open();
    const second = open();
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });
});
