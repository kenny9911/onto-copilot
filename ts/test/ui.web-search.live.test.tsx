// @vitest-environment happy-dom
/**
 * 网络来源事件必须随着 SSE 当场进入状态，但运行中只作为候选；助手回答落地后才把
 * 同一轮候选聚合成一张最多 5 条的来源卡。不能依赖刷新或重新打开会话。
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connect } from "../src/ui/sse.js";
import { G } from "../src/ui/state.js";
import { Stream } from "../src/ui/react/stream.js";
import { FakeEventSource, shell } from "./ui.react.env.js";

const sourceEvent = {
  seq: 2,
  ts: 150,
  kind: "web.sources",
  query: "采购监督流程",
  total: 1,
  results: [{
    source_id: "web_live",
    title: "实时到达的网络资料",
    url: "https://example.com/reference",
    domain: "example.com",
    snippet: "不刷新页面也应立即看见这张来源卡。",
    content_status: "snippet_only",
  }],
};

beforeEach(() => {
  shell();
  G.S = {
    id: "s1", title: "T", mode: "work", status: "done", files: 1,
    state: { dialogue: { turns: [{ speaker: "user", ts: 100, text: "帮我查一下" }] } },
    events: [],
  };
  G.LANG = "zh";
  G.PENDING = [];
  G.STEPS = [];
  G.TRACE = [];
  G.OPS = [];
  G.Q_BACKLOG = [];
  G.THINKING = true;
  G.CHAT_ABORT = null;
  G.NEEDS_CONFIRM = false;
  G.PROMPTS = [];
  G.FOLLOWUPS = [];
  G.QUOTA = null;
  G.ANSWERS = {};
  G.SEEN_SID = null;
  G.SEEN_BUBBLES = 0;
});

afterEach(() => {
  G.ES?.close();
  G.ES = null;
  cleanup();
});

describe("web.sources 运行时投影", () => {
  it("SSE 到达后实时持久化候选，但回答落地前不把中间清单铺进聊天", async () => {
    const box = document.getElementById("stream")!;
    render(<Stream />, { container: box });
    connect();
    const es = FakeEventSource.last!;

    act(() => { es.send(sourceEvent); });

    await waitFor(() => {
      expect(G.S.events).toContainEqual(expect.objectContaining({ kind: "web.sources", seq: 2 }));
    });
    expect(box.querySelector(".web-sources-card")).toBeNull();
    expect(box.textContent).not.toContain("实时到达的网络资料");
    // 没有本轮 chat.step 边界时只说「思考中」，不能误拿上一轮候选数做进度。
    expect(box.textContent).toContain("思考中");
  });

  it("已完成回答的聚合卡在自动重连和历史重放期间不消失", async () => {
    const box = document.getElementById("stream")!;
    G.S.events = [sourceEvent];
    G.S.state.dialogue.turns.push({
      speaker: "assistant", ts: 200, text: "结论见 WEB[web_live]。",
    });
    G.THINKING = false;
    render(<Stream />, { container: box });
    expect(box.textContent).toContain("实时到达的网络资料");

    connect();
    const es = FakeEventSource.last!;
    // EventSource 重连固定 since=0：reset 后历史 chat.turn 会先于 web.sources 重放。
    // 已经在屏幕上的有效来源不能在这段窗口里被擦掉；历史事件按 seq 去重即可。
    act(() => {
      es.send({ kind: "stream.reset", seq: -1, ts: 0 });
      es.send({
        seq: 0, ts: 100, kind: "chat.turn",
        turn: { speaker: "user", ts: 100, text: "帮我查一下" },
      });
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(box.textContent).toContain("实时到达的网络资料");
  });

  it("助手落地后一次性聚合成一张卡，并只展示选优后的最多五条", async () => {
    const box = document.getElementById("stream")!;
    render(<Stream />, { container: box });
    connect();
    const es = FakeEventSource.last!;

    act(() => {
      es.send(sourceEvent);
      es.send({
        ...sourceEvent,
        seq: 3,
        ts: 160,
        query: "采购监督规范",
        total: 6,
        results: Array.from({ length: 5 }, (_, index) => ({
          ...sourceEvent.results[0],
          source_id: `web_live_${index + 2}`,
          title: `候选来源 ${index + 2}`,
          url: `https://example.org/reference-${index + 2}`,
          domain: "example.org",
        })),
      });
    });
    await waitFor(() => expect(G.S.events.filter((ev: any) => ev.kind === "web.sources")).toHaveLength(2));
    expect(box.querySelectorAll(".web-sources-card")).toHaveLength(0);
    expect(box.textContent).not.toContain("候选来源 2");

    act(() => {
      es.send({
        seq: 4, ts: 200, kind: "chat.turn",
        turn: {
          speaker: "assistant", ts: 200,
          text: "结论见 WEB[web_live_6]、WEB[web_live_5]、WEB[web_live_4]、" +
            "WEB[web_live_3] 与 WEB[web_live_2]。",
        },
      });
    });

    await waitFor(() => {
      expect(box.querySelectorAll(".web-sources-card")).toHaveLength(1);
      expect(box.querySelectorAll(".web-source-item")).toHaveLength(5);
      expect(box.textContent).toContain("候选来源 6");
      expect(box.textContent).toContain("候选来源 2");
      expect(box.textContent).not.toContain("实时到达的网络资料");
    });
  });
});
