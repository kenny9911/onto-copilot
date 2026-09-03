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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { G, OPS_CAP, TBL_OPEN } from "../src/ui/state.js";
import { connect } from "../src/ui/sse.js";
import { timeline } from "../src/ui/events.js";
import { parseWebSourcesEvent } from "../src/ui/web-search.js";

function freshSession(): void {
  FakeEventSource.instances.length = 0;
  FakeEventSource.last = null;
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

  it("stream.reset 保留已显示的持久事件，历史重放仍按 seq 去重", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "ui.table", title: "清单", columns: ["a"], rows: [["1"]] }));
    TBL_OPEN.add(1);
    expect(G.S.events.length).toBe(1);
    expect(G.OPS.length).toBe(1);

    es.send(ev({ seq: 0, kind: "stream.reset" }));
    expect(G.S.events).toHaveLength(1);
    expect(G.OPS).toHaveLength(1);
    expect(TBL_OPEN.has(1)).toBe(true);

    // since=0 的历史回放不会复制事件或操作记录。
    es.send(ev({ seq: 1, kind: "ui.table", title: "清单", columns: ["a"], rows: [["1"]] }));
    expect(G.S.events).toHaveLength(1);
    expect(G.OPS).toHaveLength(1);
  });

  it("asset.recalled 在 SSE 历史重放/重连后仍是同一张可显示卡", () => {
    const first = open();
    const recalled = ev({
      seq: 8, kind: "asset.recalled", name: "采购报销.png", asset_kind: "image",
      mime: "image/png", preview_url: "/api/sessions/s1/memory/assets/a/preview",
      download_url: "/api/sessions/s1/memory/assets/a/download",
    });
    first.send(recalled);
    expect(timeline([]).filter((item: any) => item.ev?.kind === "asset.recalled")).toHaveLength(1);
    expect(G.OPS.filter((item: any) => item.kind === "asset.recalled")).toHaveLength(1);

    const replay = open();
    replay.send({ kind: "stream.reset", seq: -1, ts: 0 });
    replay.send(recalled);
    expect(timeline([]).filter((item: any) => item.ev?.kind === "asset.recalled")).toHaveLength(1);
    expect(G.OPS.filter((item: any) => item.kind === "asset.recalled")).toHaveLength(1);
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

  it("material.parse 发出 corpus.ready 后刷新 state，材料 chip 不停在旧状态", async () => {
    const oldFetch = globalThis.fetch;
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        id: "s1", title: "T", mode: "work", status: "done", files: 1,
        filelist: [{ name: "规则.txt", chunks: 1, state: "parsed" }],
        state: {}, followups: [],
      }),
    }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      const es = open();
      es.send(ev({ seq: 2, kind: "corpus.ready", stats: { files: 1, chunks: 1 } }));
      await vi.waitFor(() => {
        expect(G.S.filelist).toEqual([{ name: "规则.txt", chunks: 1, state: "parsed" }]);
      });
      expect(fetcher).toHaveBeenCalledWith("/api/sessions/s1/state");
    } finally {
      globalThis.fetch = oldFetch;
    }
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

  it("cohort 标注进轨迹：并行子任务的行带前缀，计划行说「启动 N 个并行分析任务」（P4）", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "kernel.plan", node: "PROCESS", detail: "查A；查B", cohort: true, cohort_tasks: 2 }));
    es.send(ev({ seq: 2, kind: "kernel.thought", detail: "想A", cohort_task: 0 }));
    es.send(ev({ seq: 3, kind: "kernel.observation", node: "PROCESS", detail: "12 行", cohort_task: 1 }));
    expect(G.TRACE[0].thought).toBe("PROCESS 启动 2 个并行分析任务：查A；查B");
    expect(G.TRACE[1].thought).toBe("[并行任务1] 想A");
    expect(G.TRACE[2].observation).toBe("[并行任务2] 12 行");
  });

  it("节点完成进轨迹并带耗时（P4）", () => {
    const es = open();
    es.send(ev({ seq: 1, kind: "kernel.node_completed", node: "PROCESS", detail: "", secs: 13 }));
    es.send(ev({ seq: 2, kind: "kernel.node_completed", node: "GAP", detail: "" }));
    expect(G.TRACE[0].observation).toBe("PROCESS 完成（13s）");
    expect(G.TRACE[1].observation).toBe("GAP 完成");
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

  it("CLOSED 后自动续传，新流的 web.sources 不刷新就进入时间线", () => {
    vi.useFakeTimers();
    try {
      const first = open();
      first.send(ev({ seq: 5, kind: "node.entered", node: "SEARCH" }));
      first.error({ closed: true });

      vi.advanceTimersByTime(500);
      const second = FakeEventSource.last!;
      expect(second).not.toBe(first);
      expect(second.url).toBe("/api/sessions/s1/stream?since=6");

      second.open();
      second.send({
        seq: 6, ts: 200, kind: "web.sources", query: "采购监督", total: 1,
        results: [{
          source_id: "web_1", title: "权威资料", url: "https://example.com/reference",
          domain: "example.com", snippet: "摘要", content_status: "fetched",
        }],
      });
      second.send({
        seq: 7, ts: 300, kind: "chat.turn",
        turn: { speaker: "assistant", text: "请看 WEB[web_1]", ts: 300 },
      });

      const card = timeline(G.S.state.dialogue.turns)
        .find((item: any) => item.ev?.kind === "web.sources")?.ev;
      expect(parseWebSourcesEvent(card)).not.toBeNull();
      expect(G.S.events.map((event: any) => event.seq)).toEqual([5, 6, 7]);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("旧流关闭后延迟到达的 message/reset 不污染新会话", () => {
    const old = open();
    G.S = { id: "s2", title: "T2", mode: "work", status: "done", files: 0, state: {}, events: [] };
    const current = open();

    // close() 之前已排进浏览器任务队列的回调仍可能在这一刻执行。
    old.send({ seq: -1, ts: 0, kind: "stream.reset" });
    old.send(ev({ seq: 99, kind: "web.sources", results: [{
      source_id: "stale", title: "旧资料", url: "https://old.example/a",
    }] }));
    expect(G.S.events).toEqual([]);

    current.send(ev({ seq: 0, kind: "node.entered", node: "CURRENT" }));
    expect(G.S.events.map((event: any) => event.seq)).toEqual([0]);
  });

  it("同一条坏流重复 error 只排一次重连，onopen 可撤销", () => {
    vi.useFakeTimers();
    try {
      const first = open();
      first.error();
      first.error();
      first.error();
      expect(FakeEventSource.instances).toHaveLength(1);

      // 原生 EventSource 自己恢复时不再额外建一条。
      first.open();
      vi.advanceTimersByTime(500);
      expect(FakeEventSource.instances).toHaveLength(1);

      first.error({ closed: true });
      first.error({ closed: true });
      vi.advanceTimersByTime(500);
      expect(FakeEventSource.instances).toHaveLength(2);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
