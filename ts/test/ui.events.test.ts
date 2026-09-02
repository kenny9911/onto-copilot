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
  G.THINKING = false;
  G.CHAT_ABORT = null;
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
  const source = (id: string, url: string, over: Record<string, unknown> = {}) => ({
    source_id: id,
    title: `来源 ${id}`,
    url,
    domain: new URL(url).hostname,
    snippet: `摘要 ${id}`,
    content_status: "snippet_only",
    ...over,
  });

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

  it("助手回答落地前，web.sources 留在事件状态里但不展示中间候选卡", () => {
    const event = {
      seq: 1, ts: 150, kind: "web.sources", query: "检索中",
      results: [source("candidate", "https://example.com/candidate")],
    };
    G.S.events = [event];
    G.THINKING = true;

    const items = timeline([user(100, "查一下")]);

    expect(items.filter((item: any) => item.ev?.kind === "web.sources")).toHaveLength(0);
    expect(G.S.events).toEqual([event]);
  });

  it("停止或失败且没有助手回答时，候选按用户轮聚合成兜底卡而不是永久隐藏", () => {
    G.S.events = [
      {
        seq: 1, ts: 130, kind: "web.sources", query: "第一批",
        results: [source("a", "https://example.com/a")],
      },
      {
        seq: 2, ts: 150, kind: "web.sources", query: "第二批",
        results: [source("b", "https://example.com/b")],
      },
    ];
    G.THINKING = false;
    G.CHAT_ABORT = null;

    const cards = timeline([user(100, "查一下")])
      .filter((item: any) => item.ev?.kind === "web.sources");

    expect(cards).toHaveLength(1);
    expect(cards[0]!.ev.results.map((row: any) => row.source_id)).toEqual(["a", "b"]);
  });

  it("新一轮开始时只隐藏新候选，不让历史失败轮的兜底来源卡闪退", () => {
    G.S.events = [
      {
        seq: 1, ts: 150, kind: "web.sources", query: "上一轮",
        results: [source("old", "https://example.com/old")],
      },
      {
        seq: 2, ts: 350, kind: "web.sources", query: "当前轮",
        results: [source("active", "https://example.com/active")],
      },
    ];
    G.THINKING = true;

    const cards = timeline([user(100, "上一问"), user(300, "当前问题")])
      .filter((item: any) => item.ev?.kind === "web.sources");

    expect(cards).toHaveLength(1);
    expect(cards[0]!.ev.results.map((row: any) => row.source_id)).toEqual(["old"]);
  });

  it("同一助手轮的多次网络搜索合成一张卡，引用过的来源优先", () => {
    G.S.events = [
      {
        seq: 1, ts: 130, kind: "web.sources", query: "第一次搜索", search_id: "search-1", total: 2,
        results: [
          source("a", "https://example.com/a"),
          source("b", "https://example.com/b"),
        ],
      },
      {
        seq: 2, ts: 150, kind: "web.sources", query: "第二次搜索", search_id: "search-2", total: 2,
        results: [
          source("c", "https://example.com/c"),
          source("a", "https://example.com/a", {
            snippet: "读取后的正文摘要", content_status: "fetched",
          }),
        ],
      },
    ];
    const items = timeline([user(100, "查一下"), asst(200, "先看 WEB[c]，再核对 WEB[a]。")]);
    const cards = items.filter((item: any) => item.ev?.kind === "web.sources");

    expect(cards).toHaveLength(1);
    expect(cards[0]!.key).toBe(200);
    expect(cards[0]!.ev.results.map((row: any) => row.source_id)).toEqual(["c", "a", "b"]);
    expect(cards[0]!.ev.results.find((row: any) => row.source_id === "a")).toMatchObject({
      snippet: "读取后的正文摘要",
      content_status: "fetched",
    });
    expect(cards[0]!.ev.citation_ids).toEqual(["c", "a"]);
    expect(cards[0]!.ev.total).toBe(3);
  });

  it("同 URL 即使来源编号不同也只留一条，正文读取版本覆盖搜索摘要", () => {
    G.S.events = [
      {
        seq: 1, ts: 130, kind: "web.sources", query: "搜索", search_id: "search-1",
        results: [
          source("search-id", "https://example.com/article#overview"),
          source("other", "https://example.com/other"),
        ],
      },
      {
        seq: 2, ts: 150, kind: "web.sources", query: "正文", search_id: "read_read-id",
        results: [source("read-id", "https://example.com/article", {
          snippet: "正文内容", content_status: "fetched",
        })],
      },
    ];
    const card = timeline([user(100, "查"), asst(200, "依据 WEB[read-id]")])
      .find((item: any) => item.ev?.kind === "web.sources")!;

    expect(card.ev.results).toHaveLength(2);
    expect(card.ev.results[0]).toMatchObject({
      source_id: "read-id",
      snippet: "正文内容",
      content_status: "fetched",
    });
    expect(card.ev.citation_ids).toEqual(["read-id"]);
  });

  it("不同助手轮的网络来源各自成卡，不跨轮合并", () => {
    G.S.events = [
      { seq: 1, ts: 150, kind: "web.sources", results: [source("a", "https://example.com/a")] },
      { seq: 2, ts: 350, kind: "web.sources", results: [source("b", "https://example.com/b")] },
    ];
    const cards = timeline([
      user(100, "第一问"), asst(200, "第一答 WEB[a]"),
      user(300, "第二问"), asst(400, "第二答 WEB[b]"),
    ]).filter((item: any) => item.ev?.kind === "web.sources");

    expect(cards).toHaveLength(2);
    expect(cards.map((item: any) => item.key)).toEqual([200, 400]);
    expect(cards.map((item: any) => item.ev.results[0].source_id)).toEqual(["a", "b"]);
  });
});

describe("hasCard：哪些事件值得单独占一张卡片", () => {
  it("大多数事件只进推理轨迹，只有需要人读全文的才升级成卡片", () => {
    for (const k of ["parse.failed", "human.recorded", "artifact.ready", "asset.recalled", "audit.applied",
                     "ui.table", "export.ready", "web.sources", "run.failed", "session.restored"]) {
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

// ══════════════════════════════════════════════════════════════════
//  question.answered 的详情一直是空的
//
//  确凿的键名对不上：服务端发的是 `{question, decision, pending, affected}`
//  （server/routes/questions.ts:869-874），渲染器读的是
//  `ev.question_id || ev.qid` —— **两个都不存在**。于是操作记录和推理轨迹里
//  每一条「答复问题」都渲染成空白详情。
//
//  这不是显示不好看：回答是这个产品里最重的一次人工输入，它在时间线上
//  留下的是一行没有内容的灰条。
// ══════════════════════════════════════════════════════════════════

describe("question.answered 的详情", () => {
  it("读服务端真正发出来的键（question），不是不存在的 question_id", () => {
    expect(evDetail({ kind: "question.answered", question: "q_pk_choice" })).toContain("q_pk_choice");
  });

  it("**拍板内容优先于问题 id** —— 人要看的是「定了什么」不是「哪条问题」", () => {
    const d = evDetail({
      kind: "question.answered",
      question: "q_pk_choice",
      label: "主键用 poNo",
      changed: ["ot_po", "pt_po_no"],
    });
    expect(d).toContain("主键用 poNo");
  });

  it("带上受影响数量 —— 「改了 2 处」是决定要不要点开的依据", () => {
    const d = evDetail({
      kind: "question.answered",
      question: "q1",
      label: "主键用 poNo",
      changed: ["ot_po", "pt_po_no"],
    });
    expect(d).toContain("2");
  });

  it("老事件（只有 question_id）仍然认 —— 历史会话的时间线不能因此变空", () => {
    expect(evDetail({ kind: "question.answered", question_id: "q_old" })).toContain("q_old");
  });
});
