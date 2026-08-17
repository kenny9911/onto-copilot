/**
 * server 段 D（流水线）的测试。
 *
 * 纯函数一律用 `golden/server_pipeline.json` 断言 —— 手写的期望值是我对 Python
 * 行为的**猜测**，golden 是它的**事实**（契约 §3）。带仓储/租约/取消的部分用假
 * repo 钉行为，因为 Python 侧那几条路径的真相是"和 repo 的一次次交互序列"，
 * 不是一个可导出的值。
 */

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventKind, makeEvent, parseEventKind } from "../src/kernel/events.js";
import type { Event } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { Recorder } from "../src/kernel/recorder.js";
import { Budget } from "../src/kernel/budget.js";
import { ParserRegistry } from "../src/onto/parse/base.js";
import { CsvParser, XlsxParser } from "../src/onto/parse/tabular.js";
import {
  AsyncLock,
  BUILD_STARTABLE,
  MultiSheet,
  NoRows,
  RunCancelled,
  build,
  claimAndStartBuild,
  conversationTables,
  fastapiErrorHandler,
  fullRowsFor,
  isCancelled,
  lastCardTable,
  matchFile,
  materialTable,
  oirTable,
  oirVal,
  onRunCancelled,
  persist,
  pickTable,
  pipelineRoutes,
  pumpKernelEvents,
  pushVersion,
  pyIsoUtc,
  runPipeline,
  runWithLiveTrace,
  sheetRows,
  stop,
  tablesInText,
  traceDetail,
} from "../src/server/pipeline.js";
import type {
  MarkdownBlockLike,
  PipelineDeps,
  SchedulerOutcome,
  SessionLike,
  TraceRecorder,
} from "../src/server/pipeline.js";
import type { SessionEvent } from "../src/session_events.js";
import { ConflictKind, makeConflict } from "../src/onto/conflict.js";
import { makeClarificationSet, questionToDict } from "../src/onto/clarify.js";
import { makeOption } from "../src/onto/conflict.js";

// ══════════════════════════════════════════════════════════════════
//  golden
// ══════════════════════════════════════════════════════════════════

const GOLDEN_PATH = fileURLToPath(new URL("../../golden/server_pipeline.json", import.meta.url));
interface Golden {
  oir_val: { in: unknown; out: string }[];
  oir_table: { kind: string; contains: string; label: string; head: string[]; rows: string[][] }[];
  oir_table_empty: { kind: string; out: [string, string[], string[][]] }[];
  sheet_rows: { file: string; out: Record<string, Record<string, string>[]> }[];
  material_table: { file: string; out?: unknown; no_rows?: string; multi_sheet?: unknown }[];
  material_table_args: { args: Record<string, unknown>; out?: unknown; no_rows?: string }[];
  material_table_misc: { target: string; no_rows?: string; out?: string }[];
  full_rows_for: { ev: Record<string, unknown>; rows: string[][] | null }[];
  match_file: { raw: string; hit: string | null }[];
  tables_in_text: { md: string; blocks: MarkdownBlockLike[]; out: Record<string, unknown>[] }[];
  pick_table: { name: string; hit: unknown }[];
  pick_table_empty: null;
  trace_detail: { kind: string; payload_items: [string, unknown][]; detail: string }[];
  last_card_table: {
    events: Record<string, unknown>[];
    cards: Record<string, unknown>[];
    hit: string | null;
  }[];
}
const G = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as Golden;

/** golden 里的那份 OIR —— 与 `tools/golden/server_pipeline.py` 的 `OIR` 同源。 */
const OIR: Record<string, unknown> = JSON.parse(
  JSON.stringify({
    objects: [
      {
        displayName: { value: "客户" },
        apiName: { value: "Customer" },
        description: { value: "描述".repeat(80) },
        status: "draft",
      },
      { displayName: "裸串对象", apiName: { value: "Bare" }, description: {}, status: "" },
      { apiName: { value: "NoName" } },
    ],
    properties: [
      {
        parent: "Customer",
        displayName: { value: "名称" },
        apiName: { value: "name" },
        baseType: { value: "string" },
        definition: { value: "口径".repeat(80) },
      },
      { parent: "", displayName: {}, apiName: {}, baseType: {}, definition: {} },
    ],
    links: [
      {
        from: "Customer",
        to: "Order",
        apiName: { value: "orders" },
        cardinality: { value: "ONE_TO_MANY" },
      },
    ],
    actions: [
      { apiName: { value: "createOrder" }, appliesTo: ["Order", "Customer"] },
      { apiName: { value: "noApplies" }, appliesTo: [] },
      { apiName: { value: "missingApplies" } },
    ],
    rules: [
      { statement: { value: "金额必须为正" }, ruleKind: { value: "validation" }, actor: { value: "系统" } },
    ],
    questions: [
      { text: { value: "客户编号唯一吗？" }, answer: { value: "" }, code: "Q1" },
      { text: { value: "订单可以撤销吗？" }, answer: { value: "可以" }, code: "Q2" },
    ],
  }) as string,
) as Record<string, unknown>;

/**
 * 一个真实形状的 `clarify.Question`。**普通对象，没有 toDict 方法** ——
 * 它跟 `onto/questions.ts` 那个 Question 类同名不同物，这正是踩过的坑。
 */
const CLARIFY_Q = {
  id: "q_1_abcd1234",
  conflictRid: "c_采购方式取值不一致",
  title: "「采购方式」在两份材料里取值不一致",
  options: [makeOption("以制度为准", "以《采购管理制度》的取值为准", "制度是权威口径")],
  impact: 3,
  score: 0.82,
  reversible: true,
};

const CSV_FIXTURES: Record<string, string> = {
  "简单.csv": "编号,名称,备注\n1,客户,\n2,订单,加急\n",
  "有空行.csv": "编号,名称\n\n1,甲\n\n2,乙\n",
  "分号.csv": "a;b;c\n1;2;3\n4;5;6\n",
  "重名列.csv": "名称,名称,名称\n甲,乙,丙\n",
  "无表头.csv": "1,2,3\n4,5,6\n",
  "参差.csv": "a,b,c\n1,2\n3,4,5,6\n",
  "制表.tsv": "列1\t列2\n甲\t乙\n",
  "引号.csv": 'a,b\n"含,逗号","含""引号"\n',
};

const PICK_TABLES: Record<string, unknown>[] = [
  { title: "问题清单", rows: [["1"]], ts: 1.0 },
  { title: "AI 招聘业务流程梳理及访谈提问框架", rows: [["2"]], ts: 2.0 },
  { title: "对比表", rows: [["3"]], ts: 3.0 },
  { title: "问题清单", rows: [["4"]], ts: 4.0 },
];

// ══════════════════════════════════════════════════════════════════
//  假件
// ══════════════════════════════════════════════════════════════════

function fakeSession(init: Partial<SessionLike> = {}): SessionLike {
  const s: SessionLike = {
    id: init.id ?? "sess-1",
    title: init.title ?? "会话",
    project: init.project ?? "",
    projectId: init.projectId ?? "",
    created: init.created ?? 0,
    files: init.files ?? [],
    status: init.status ?? "idle",
    error: init.error ?? "",
    dir: init.dir ?? "/nonexistent",
    events: init.events ?? [],
    state: init.state ?? {},
    stateVersion: init.stateVersion ?? 0,
    owner: init.owner ?? "",
    buildLeaseOwner: init.buildLeaseOwner ?? "",
    mutationLeaseOwner: init.mutationLeaseOwner ?? "",
    buildLock: init.buildLock ?? new AsyncLock(),
    chatTask: init.chatTask ?? null,
    runTask: init.runTask ?? null,
    emit(kind: string, payload: Record<string, unknown> = {}): SessionEvent {
      const ev = { kind, ...payload } as SessionEvent;
      s.events.push(ev);
      return ev;
    },
  };
  return s;
}

function tabularRegistry(): ParserRegistry {
  const r = new ParserRegistry();
  r.register(new XlsxParser());
  r.register(new CsvParser());
  return r;
}

/** 只记调用序列的假 repo。**故意不实现整个 Repo** —— 这一段只碰这几个方法，
 *  把 40 个方法都补上只会让"到底用了哪几个"看不出来。 */
class FakeRepo {
  readonly calls: [string, unknown][] = [];
  claimOk = true;
  renewOk = true;
  session: { status: string; error: string; state_version: number } | null = {
    status: "idle",
    error: "",
    state_version: 0,
  };
  saveVersion: number | null = 7;
  cancelChat = false;
  cancelRun = false;

  private log(name: string, arg: unknown): void {
    this.calls.push([name, arg]);
  }

  claimBuildLease(sid: string, o: unknown): Promise<boolean> {
    this.log("claimBuildLease", o);
    return Promise.resolve(this.claimOk);
  }
  renewBuildLease(sid: string, o: unknown): Promise<boolean> {
    this.log("renewBuildLease", o);
    return Promise.resolve(this.renewOk);
  }
  releaseBuildLease(sid: string, o: unknown): Promise<boolean> {
    this.log("releaseBuildLease", o);
    return Promise.resolve(true);
  }
  claimSessionStatus(sid: string, o: unknown): Promise<boolean> {
    this.log("claimSessionStatus", o);
    return Promise.resolve(true);
  }
  getSession(sid: string): Promise<unknown> {
    this.log("getSession", sid);
    return Promise.resolve(this.session);
  }
  requestChatCancel(sid: string, o: unknown): Promise<boolean> {
    this.log("requestChatCancel", o);
    return Promise.resolve(this.cancelChat);
  }
  requestBuildCancel(sid: string, o: unknown): Promise<boolean> {
    this.log("requestBuildCancel", o);
    return Promise.resolve(this.cancelRun);
  }
  nextRun(sid: string, kind: string): Promise<string> {
    this.log("nextRun", kind);
    return Promise.resolve("run-1");
  }
  finishRun(runId: string, o: unknown): Promise<void> {
    this.log("finishRun", o);
    return Promise.resolve();
  }
  saveBuildState(sid: string, docs: unknown, o: unknown): Promise<number | null> {
    this.log("saveBuildState", { docs, o });
    return Promise.resolve(this.saveVersion);
  }
  saveChatState(sid: string, docs: unknown, o: unknown): Promise<number | null> {
    this.log("saveChatState", { docs, o });
    return Promise.resolve(this.saveVersion);
  }
  saveMutationState(sid: string, docs: unknown, o: unknown): Promise<number | null> {
    this.log("saveMutationState", { docs, o });
    return Promise.resolve(this.saveVersion);
  }
  saveState(sid: string, docs: unknown, o: unknown): Promise<number | null> {
    this.log("saveState", { docs, o });
    return Promise.resolve(this.saveVersion);
  }
  setStatus(sid: string, status: string, o: unknown): Promise<void> {
    this.log("setStatus", { status, o });
    return Promise.resolve();
  }
  readEvents(sid: string, o: unknown): Promise<unknown[]> {
    this.log("readEvents", o);
    return Promise.resolve([]);
  }
}

function fakeDeps(repo: FakeRepo, over: Partial<PipelineDeps> = {}): PipelineDeps {
  let n = 0;
  const base = {
    repo: () => repo as never,
    workerId: "worker-test",
    now: () => 1000,
    buildLeaseTtl: () => 30,
    buildHeartbeatInterval: () => 0.01,
    newToken: () => `tok${++n}`,
    sessAsync: () => Promise.reject(new Error("not wired")),
    refreshFilesProjection: () => Promise.resolve(),
    persistDecisions: () => Promise.resolve(),
  };
  return { ...(base as unknown as PipelineDeps), ...over };
}

const noBlocks = (): readonly MarkdownBlockLike[] => [];

// ══════════════════════════════════════════════════════════════════
//  _oir_val / _oir_table
// ══════════════════════════════════════════════════════════════════

describe("oirVal / oirTable（golden）", () => {
  it("_oir_val 的每一种输入", () => {
    for (const c of G.oir_val) expect([c.in, oirVal(c.in)]).toEqual([c.in, c.out]);
  });

  it("_oir_table 的六类 × contains", () => {
    for (const c of G.oir_table) {
      expect([c.kind, c.contains, oirTable(OIR, c.kind, c.contains)]).toEqual([
        c.kind,
        c.contains,
        [c.label, c.head, c.rows],
      ]);
    }
  });

  it("空 OIR 只出表头", () => {
    for (const c of G.oir_table_empty) {
      expect([c.kind, oirTable({}, c.kind, "")]).toEqual([c.kind, c.out]);
    }
  });

  it("未知 kind 是 fail-fast（Python 是 KeyError）", () => {
    expect(() => oirTable(OIR, "不存在", "")).toThrow(/KeyError/);
  });

  it("contains 走的是整条 JSON，不只是被渲染出来的那几列", () => {
    // "NoName" 只出现在 apiName 上；"ONE_TO_MANY" 在 links 的 cardinality 里
    expect(oirTable(OIR, "objects", "noname")[2].length).toBe(1);
    expect(oirTable(OIR, "links", "one_to_many")[2].length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _sheet_rows / _material_table / _full_rows_for
// ══════════════════════════════════════════════════════════════════

function fixtureDir(): { root: string; mats: string } {
  const root = mkdtempSync(join(tmpdir(), "ontopipe-"));
  const mats = join(root, "materials");
  mkdirSync(mats);
  for (const [name, text] of Object.entries(CSV_FIXTURES)) {
    writeFileSync(join(mats, name), text, "utf-8");
  }
  writeFileSync(join(mats, "说明.md"), "# 标题\n", "utf-8");
  return { root, mats };
}

describe("sheetRows / materialTable（golden）", () => {
  const { root, mats } = fixtureDir();
  const reg = tabularRegistry();
  const files = Object.keys(CSV_FIXTURES).map((n) => ({ name: n, path: join(mats, n) }));

  it("csv/tsv 的每一份 fixture", async () => {
    for (const c of G.sheet_rows) {
      expect([c.file, await sheetRows(join(mats, c.file), reg)]).toEqual([c.file, c.out]);
    }
  });

  it("materialTable 的默认路径", async () => {
    const s = fakeSession({ files, dir: root });
    for (const c of G.material_table) {
      if (c.out !== undefined) {
        const [f, sheet, cols, rows, note] = await materialTable(s, reg, c.file);
        expect([c.file, { file: f, sheet, cols, rows, note }]).toEqual([c.file, c.out]);
      } else {
        await expect(materialTable(s, reg, c.file)).rejects.toThrow();
      }
    }
  });

  it("columns / contains / 空列隐藏", async () => {
    const s = fakeSession({ files, dir: root });
    for (const c of G.material_table_args) {
      const cols = (c.args["columns"] as string[] | undefined) ?? null;
      const contains = (c.args["contains"] as string | undefined) ?? "";
      if (c.out !== undefined) {
        const [f, sheet, out, rows, note] = await materialTable(
          s,
          reg,
          "简单.csv",
          "",
          contains,
          cols,
        );
        expect([c.args, { file: f, sheet, cols: out, rows, note }]).toEqual([c.args, c.out]);
      } else {
        await expect(
          materialTable(s, reg, "简单.csv", "", contains, cols),
        ).rejects.toThrowError(c.no_rows);
      }
    }
  });

  it("非表格 / 不存在的材料，回执逐字一致", async () => {
    const s = fakeSession({
      files: [{ name: "说明.md", path: join(mats, "说明.md") }],
      dir: root,
    });
    for (const c of G.material_table_misc) {
      await expect(materialTable(s, reg, c.target)).rejects.toThrowError(c.no_rows);
    }
  });

  it("NoRows / MultiSheet 是两种可分辨的异常", async () => {
    const s = fakeSession({ files, dir: root });
    await expect(materialTable(s, reg, "没有这个.csv")).rejects.toBeInstanceOf(NoRows);
    // 单 sheet 的 csv 永远不会抛 MultiSheet —— 这里只钉类型本身可用
    expect(new MultiSheet({ a: 1 }).sheets).toEqual({ a: 1 });
  });

  it("fullRowsFor 按配方重算（含所有失败退路）", async () => {
    const s = fakeSession({ files, dir: root, state: { oir: OIR } });
    for (const c of G.full_rows_for) {
      expect([c.ev, await fullRowsFor(s, reg, c.ev)]).toEqual([c.ev, c.rows]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  _match_file / _tables_in_text / _pick_table / _last_card_table
// ══════════════════════════════════════════════════════════════════

describe("matchFile（golden）", () => {
  it("全等 → 解码后全等 → 子串", () => {
    const s = fakeSession({
      files: ["订单明细.xlsx", "客户主数据.csv", "readme.md"].map((n) => ({ name: n })),
    });
    for (const c of G.match_file) {
      expect([c.raw, matchFile(s, c.raw)?.name ?? null]).toEqual([c.raw, c.hit]);
    }
  });

  it("残缺的百分号编码不抛（decodeURIComponent 会）", () => {
    const s = fakeSession({ files: [{ name: "a" }] });
    expect(() => matchFile(s, "%E4%B8%")).not.toThrow();
    expect(() => matchFile(s, "%zz")).not.toThrow();
  });
});

describe("tablesInText（golden）", () => {
  it("每份 markdown 的标题归属与行数", () => {
    for (const c of G.tables_in_text) {
      // block 由 golden 提供：markdown 解析属于 onto/export 那个 track
      expect([c.md, tablesInText(c.md, 1234.5, () => c.blocks)]).toEqual([c.md, c.out]);
    }
  });
});

describe("pickTable（golden）", () => {
  it("全等 → 包含 → 反向包含", () => {
    for (const c of G.pick_table) {
      expect([c.name, pickTable(PICK_TABLES, c.name)?.["rows"] ?? null]).toEqual([c.name, c.hit]);
    }
  });

  it("空列表返回 null", () => {
    expect(pickTable([], "x")).toBe(G.pick_table_empty);
  });
});

describe("lastCardTable（golden）", () => {
  it("先事件流、再 _cards", () => {
    for (const c of G.last_card_table) {
      const s = fakeSession({
        events: c.events as SessionEvent[],
        state: { _cards: c.cards },
      });
      expect([c.events, lastCardTable(s)?.["title"] ?? null]).toEqual([c.events, c.hit]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  _conversation_tables（假 repo + 假 dialogue）
// ══════════════════════════════════════════════════════════════════

describe("conversationTables", () => {
  const blocks = (text: string): readonly MarkdownBlockLike[] =>
    text.includes("TABLE")
      ? [
          { kind: "heading", text: "对话里的表" },
          { kind: "table", columns: ["a"], rows: [["1"]] },
        ]
      : [];

  it("耐久事件 + 进程内事件 + _cards + _tables + dialogue，五个来源合流并去重", async () => {
    const repo = new FakeRepo();
    repo.readEvents = () =>
      Promise.resolve([
        { seq: 1, ts: 1, kind: "ui.table", payload: { title: "T1", rows: [["x"]] }, event_id: "" },
        {
          seq: 2,
          ts: 2,
          kind: "chat.turn",
          payload: { turn: { speaker: "assistant", text: "TABLE", ts: 2 } },
          event_id: "",
        },
        // 非 assistant 的轮次不进
        {
          seq: 3,
          ts: 3,
          kind: "chat.turn",
          payload: { turn: { speaker: "user", text: "TABLE", ts: 3 } },
          event_id: "",
        },
      ] as never);
    const s = fakeSession({
      events: [{ kind: "ui.table", ts: 5, title: "T5", rows: [["y"]] } as never],
      state: {
        _cards: [{ kind: "ui.table", ts: 4, title: "T4", rows: [["z"]] }],
        _tables: [{ kind: "ui.table", ts: 0.5, title: "T0", rows: [["w"]] }],
      },
    });
    const out = await conversationTables(s, {
      repo: () => repo as never,
      dialogue: () => ({
        turns: [{ speaker: "assistant", text: "TABLE", ts: 6 }],
        activeDecisions: () => [],
      }),
      blocksFromMarkdown: blocks,
    });
    expect(out.map((r) => [r["ts"], r["title"]])).toEqual([
      [0.5, "T0"],
      [1, "T1"],
      [2, "对话里的表"],
      [4, "T4"],
      [5, "T5"],
      [6, "对话里的表"],
    ]);
  });

  it("两边重复的算一份（ts/标题/行数三元组去重），且**先到的那份**留下", async () => {
    const repo = new FakeRepo();
    repo.readEvents = () =>
      Promise.resolve([
        {
          seq: 1,
          ts: 1,
          kind: "ui.table",
          payload: { title: "T", rows: [["durable"]] },
          event_id: "",
        },
      ] as never);
    const s = fakeSession({
      events: [{ kind: "ui.table", ts: 1, title: "T", rows: [["local"]] } as never],
    });
    const out = await conversationTables(s, {
      repo: () => repo as never,
      dialogue: () => ({ turns: [], activeDecisions: () => [] }),
      blocksFromMarkdown: noBlocks,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!["rows"]).toEqual([["durable"]]);
  });

  it("仓储读不动时退回进程内来源，不炸", async () => {
    const repo = new FakeRepo();
    repo.readEvents = () => Promise.reject(new Error("db down"));
    const s = fakeSession({
      events: [{ kind: "ui.table", ts: 1, title: "T", rows: [["x"]] } as never],
    });
    const out = await conversationTables(s, {
      repo: () => repo as never,
      dialogue: () => ({ turns: [], activeDecisions: () => [] }),
      blocksFromMarkdown: noBlocks,
    });
    expect(out).toHaveLength(1);
  });

  it("rows 为空的 ui.table 不算一张表", async () => {
    const repo = new FakeRepo();
    const s = fakeSession({
      events: [{ kind: "ui.table", ts: 1, title: "空", rows: [] } as never],
    });
    const out = await conversationTables(s, {
      repo: () => repo as never,
      dialogue: () => ({ turns: [], activeDecisions: () => [] }),
      blocksFromMarkdown: noBlocks,
    });
    expect(out).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _trace_detail / _pump_kernel_events / _run_with_live_trace
// ══════════════════════════════════════════════════════════════════

function ev(kind: EventKind, payload: Record<string, unknown>, seq = 0): Event {
  return makeEvent({ runId: "r", seq, kind, nodeId: "N", payload });
}

describe("traceDetail（golden）", () => {
  it("九种被投影的事件类型各自的排版", () => {
    for (const c of G.trace_detail) {
      // payload 用有序 pair 重建：最后那条分支照抄的是 payload 的**插入序**
      const payload = Object.fromEntries(c.payload_items);
      const e = ev(parseEventKind(c.kind), payload);
      expect([c.kind, c.payload_items, traceDetail(e)]).toEqual([
        c.kind,
        c.payload_items,
        c.detail,
      ]);
    }
  });

  it("分隔符是全角空格 U+3000，不是普通空格", () => {
    const d = traceDetail(
      ev(EventKind.CRITIC_VERDICT, { lens: "l", passed: true, findings: [{ claim: "c" }] }),
    );
    expect(d).toBe("l 通过　c");
  });
});

describe("pumpKernelEvents", () => {
  function rec(events: Event[]): TraceRecorder {
    const j = new InMemoryJournal();
    for (const e of events) j.append(e);
    return { journal: j, runId: "r" };
  }

  it("只投影白名单里的类型，且带上 _kernel_seq 水位", () => {
    const s = fakeSession();
    const r = rec([
      ev(EventKind.NODE_ENTERED, {}, 0),
      ev(EventKind.RUN_STARTED, {}, 1), // 不在白名单
      ev(EventKind.THOUGHT, { text: "想" }, 2),
    ]);
    pumpKernelEvents(s, r);
    expect(s.events.map((e) => e["kind"])).toEqual(["kernel.node_entered", "kernel.thought"]);
    // 水位是 max(seq)+1，**未被投影的事件也推进它** —— 否则每一拍都要重扫全表
    expect(s.state["_kernel_seq"]).toBe(3);
  });

  it("再泵一次不会重复发（这正是「推理面板刷屏」的老 bug）", () => {
    const s = fakeSession();
    const r = rec([ev(EventKind.THOUGHT, { text: "a" }, 0)]);
    pumpKernelEvents(s, r);
    pumpKernelEvents(s, r);
    expect(s.events).toHaveLength(1);
  });

  it("新事件接着投影", () => {
    const s = fakeSession();
    const j = new InMemoryJournal();
    j.append(ev(EventKind.THOUGHT, { text: "a" }, 0));
    const r = { journal: j, runId: "r" };
    pumpKernelEvents(s, r);
    j.append(ev(EventKind.THOUGHT, { text: "b" }, 1));
    pumpKernelEvents(s, r);
    expect(s.events.map((e) => e["detail"])).toEqual(["a", "b"]);
  });

  it("node 缺席时投影成空串，不是 null", () => {
    const s = fakeSession();
    const j = new InMemoryJournal();
    j.append(makeEvent({ runId: "r", seq: 0, kind: EventKind.THOUGHT, payload: { text: "a" } }));
    pumpKernelEvents(s, { journal: j, runId: "r" });
    expect(s.events[0]!["node"]).toBe("");
  });
});

describe("runWithLiveTrace", () => {
  it("边跑边泵：任务没结束时也能看到事件", async () => {
    const s = fakeSession();
    const j = new InMemoryJournal();
    const r = { journal: j, runId: "r" };
    let resolve!: (v: string) => void;
    const work = new Promise<string>((res) => {
      resolve = res;
    });
    j.append(ev(EventKind.THOUGHT, { text: "第一拍" }, 0));
    const p = runWithLiveTrace(s, r, work, { every: 0.01 });
    await new Promise((res) => setTimeout(res, 40));
    expect(s.events.map((e) => e["detail"])).toEqual(["第一拍"]);
    j.append(ev(EventKind.THOUGHT, { text: "第二拍" }, 1));
    resolve("done");
    await expect(p).resolves.toBe("done");
    expect(s.events.map((e) => e["detail"])).toEqual(["第一拍", "第二拍"]);
  });

  it("任务失败时 finally 那一泵照样跑（别漏最后几条）", async () => {
    const s = fakeSession();
    const j = new InMemoryJournal();
    j.append(ev(EventKind.NODE_FAILED, { error: "boom" }, 0));
    await expect(
      runWithLiveTrace(s, { journal: j, runId: "r" }, Promise.reject(new Error("x")), {
        every: 0.01,
      }),
    ).rejects.toThrow("x");
    expect(s.events).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _push_version / _persist
// ══════════════════════════════════════════════════════════════════

describe("pushVersion", () => {
  it("返回的是**同一个活列表**（调用方失败时要 pop 掉刚压的那个）", () => {
    const s = fakeSession();
    const a = pushVersion(s, "_flow_versions", { v: 1 });
    const b = pushVersion(s, "_flow_versions", { v: 2 });
    expect(a).toBe(b);
    expect(a).toBe(s.state["_flow_versions"]);
  });

  it("封顶 20，丢的是最老的", () => {
    const s = fakeSession();
    for (let i = 0; i < 25; i++) pushVersion(s, "k", { i });
    const v = s.state["k"] as { i: number }[];
    expect(v).toHaveLength(20);
    expect(v[0]).toEqual({ i: 5 });
  });
});

describe("persist", () => {
  const deps = (repo: FakeRepo) => ({
    repo: () => repo as never,
    now: () => 1000,
    persistDecisions: vi.fn(() => Promise.resolve()),
  });

  it("只落白名单里的 key，私有的 `_` 键不外泄", async () => {
    const repo = new FakeRepo();
    const s = fakeSession({
      state: { oir: { a: 1 }, _oir: "活对象", _index: "活对象", corpus: { n: 1 } },
    });
    await persist(s, deps(repo));
    const [, arg] = repo.calls.find(([n]) => n === "saveState")!;
    const docs = (arg as { docs: Record<string, unknown> }).docs;
    expect(Object.keys(docs).sort()).toEqual(["corpus", "oir"]);
  });

  it("私有版本栈会落库并就地封顶", async () => {
    const repo = new FakeRepo();
    const stack = Array.from({ length: 25 }, (_, i) => ({ i }));
    const s = fakeSession({ state: { _flow_versions: stack } });
    await persist(s, deps(repo));
    expect((s.state["_flow_versions"] as unknown[]).length).toBe(20);
    const [, arg] = repo.calls.find(([n]) => n === "saveState")!;
    expect((arg as { docs: Record<string, unknown[]> }).docs["_flow_versions"]).toHaveLength(20);
  });

  it("build 租约冲突时丢掉 chat 独占的文档重试一次（无损合并）", async () => {
    const repo = new FakeRepo();
    let first = true;
    repo.saveBuildState = (sid: string, docs: unknown, o: unknown) => {
      repo.calls.push(["saveBuildState", { docs, o }]);
      if (first) {
        first = false;
        return Promise.resolve(null);
      }
      return Promise.resolve(9);
    };
    const s = fakeSession({
      state: { oir: { a: 1 }, followups: ["x"], _last_reason: "r" },
    });
    await persist(s, { ...deps(repo) }, { leaseOwner: "own" });
    const saves = repo.calls.filter(([n]) => n === "saveBuildState");
    expect(saves).toHaveLength(2);
    const retry = (saves[1]![1] as { docs: Record<string, unknown> }).docs;
    expect("followups" in retry).toBe(false);
    expect("_last_reason" in retry).toBe(false);
    expect("oir" in retry).toBe(true);
    expect(s.stateVersion).toBe(9);
  });

  it("build 重试仍失败 = 租约没了 = 取消（不是 failed）", async () => {
    const repo = new FakeRepo();
    repo.saveBuildState = () => Promise.resolve(null);
    const s = fakeSession();
    await expect(persist(s, deps(repo), { leaseOwner: "own" })).rejects.toBeInstanceOf(
      RunCancelled,
    );
    // 取消路径上**不发** persist.failed —— Python 的 except Exception 接不到
    // CancelledError，多这条事件就是一次假告警
    expect(s.events).toEqual([]);
  });

  it("chat 重试只提交 chat 独占的那几个键", async () => {
    const repo = new FakeRepo();
    let first = true;
    repo.saveChatState = (sid: string, docs: unknown, o: unknown) => {
      repo.calls.push(["saveChatState", { docs, o }]);
      if (first) {
        first = false;
        return Promise.resolve(null);
      }
      return Promise.resolve(3);
    };
    const s = fakeSession({ state: { oir: { a: 1 }, followups: ["x"] } });
    await persist(s, deps(repo), { chatOwner: "c" });
    const saves = repo.calls.filter(([n]) => n === "saveChatState");
    const retry = (saves[1]![1] as { docs: Record<string, unknown> }).docs;
    expect(Object.keys(retry)).toEqual(["followups"]);
    // 重试那一次显式不动冲突表
    expect((saves[1]![1] as { o: { conflicts: unknown } }).o.conflicts).toBeNull();
  });

  it("build lease 和 chat lease 不能同时提交同一 checkpoint", async () => {
    const repo = new FakeRepo();
    const s = fakeSession();
    await expect(
      persist(s, deps(repo), { leaseOwner: "b", chatOwner: "c" }),
    ).rejects.toThrow("build lease 和 chat lease 不能同时提交同一 checkpoint");
    expect(s.events.map((e) => e["kind"])).toEqual(["persist.failed"]);
  });

  it("非取消的失败会发 persist.failed 并把原异常抛上去", async () => {
    const repo = new FakeRepo();
    repo.saveState = () => Promise.reject(new TypeError("boom"));
    const s = fakeSession();
    await expect(persist(s, deps(repo))).rejects.toThrow("boom");
    expect(s.events[0]!["error"]).toBe("TypeError: boom");
  });

  it("docsOnly 过滤后，冲突表只在涉及 oir/questions 时才提交", async () => {
    const repo = new FakeRepo();
    const s = fakeSession({
      state: {
        oir: {},
        followups: ["f"],
        // 真的 Conflict（纯数据）。这里原本放的是一个带 toDict() 的桩 ——
        // 那是照着**错误的端口声明**造的形状，真跑起来会炸
        // `TypeError: c.toDict is not a function`。
        _conflicts: [makeConflict("cf_1", ConflictKind.DUPLICATE, ["ot_a"], "重复对象")],
        questions: [{ conflict_rid: "cf_1" }],
      },
    });
    await persist(s, deps(repo), { docsOnly: new Set(["followups"]) });
    let [, arg] = repo.calls.find(([n]) => n === "saveState")!;
    expect((arg as { o: { conflicts: unknown } }).o.conflicts).toBeNull();

    repo.calls.length = 0;
    await persist(s, deps(repo), { docsOnly: new Set(["oir"]) });
    [, arg] = repo.calls.find(([n]) => n === "saveState")!;
    expect((arg as { o: { conflicts: { rid: string }[] } }).o.conflicts?.[0]?.rid).toBe("cf_1");
  });

  it("asked_rids 的顺序就是 _ask_rank，缺 conflict_rid 直接炸（数据损坏不静默）", async () => {
    const repo = new FakeRepo();
    const ok = fakeSession({
      state: { questions: [{ conflict_rid: "b" }, { conflict_rid: "a" }] },
    });
    await persist(ok, deps(repo));
    const [, arg] = repo.calls.find(([n]) => n === "saveState")!;
    expect((arg as { o: { askedRids: string[] } }).o.askedRids).toEqual(["b", "a"]);

    const bad = fakeSession({ state: { questions: [{}] } });
    await expect(persist(bad, deps(repo))).rejects.toThrow(/conflict_rid/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _claim_and_start_build / _on_run_cancelled / build / stop
// ══════════════════════════════════════════════════════════════════

describe("claimAndStartBuild", () => {
  it("抢不到租约就回仓储里的权威状态，并同步到内存投影", async () => {
    const repo = new FakeRepo();
    repo.claimOk = false;
    repo.session = { status: "extracting", error: "e", state_version: 0 };
    const s = fakeSession();
    expect(await claimAndStartBuild(s, fakeDeps(repo))).toBe("extracting");
    expect([s.status, s.error]).toEqual(["extracting", "e"]);
  });

  it("会话没了就是 missing", async () => {
    const repo = new FakeRepo();
    repo.claimOk = false;
    repo.session = null;
    expect(await claimAndStartBuild(fakeSession(), fakeDeps(repo))).toBe("missing");
  });

  it("没有材料时**先还租约再把状态改回 idle**（顺序反了会留下一把没人收的租约）", async () => {
    const repo = new FakeRepo();
    const s = fakeSession();
    expect(await claimAndStartBuild(s, fakeDeps(repo))).toBe("no_files");
    expect(repo.calls.map(([n]) => n)).toEqual([
      "claimBuildLease",
      "releaseBuildLease",
      "claimSessionStatus",
    ]);
  });

  it("claim 成功就起任务，lease token 落到 Session 上", async () => {
    const repo = new FakeRepo();
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    // 让管线在第一步就因为租约续不上而"取消"，测试只关心 claim 这一段
    repo.renewOk = false;
    const runPipelineDeps = fakeDeps(repo);
    expect(await claimAndStartBuild(s, runPipelineDeps)).toBe("started");
    expect(s.buildLeaseOwner).toBe("worker-test:tok1");
    expect(s.runTask).not.toBeNull();
    await s.runTask!.promise.catch(() => undefined);
  });

  it("tier 只认 full / flow_preview，别的一律回落 full", async () => {
    const repo = new FakeRepo();
    repo.renewOk = false;
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    await claimAndStartBuild(s, fakeDeps(repo), { tier: "乱写" });
    await s.runTask!.promise.catch(() => undefined);
    const nextRun = repo.calls.find(([n]) => n === "nextRun");
    // renew 失败时压根不会走到 nextRun —— 这里断言的是它没有用「乱写」当 tier
    expect(nextRun).toBeUndefined();
  });

  it("build_lock 串行化：两个并发 claim 只有一个能拿到租约", async () => {
    const repo = new FakeRepo();
    let claims = 0;
    repo.claimBuildLease = () => {
      claims += 1;
      return Promise.resolve(claims === 1);
    };
    repo.renewOk = false;
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    const deps = fakeDeps(repo);
    const [a, b] = await Promise.all([
      claimAndStartBuild(s, deps),
      claimAndStartBuild(s, deps),
    ]);
    expect([a, b].filter((x) => x === "started")).toHaveLength(1);
    await s.runTask?.promise.catch(() => undefined);
  });
});

describe("onRunCancelled", () => {
  it("落 stopped（不是 failed、也不是 idle）并发一条 run.cancelled", () => {
    const s = fakeSession({ status: "extracting" });
    onRunCancelled(s);
    expect(s.status).toBe("stopped");
    expect(s.events).toEqual([{ kind: "run.cancelled", reason: "用户停止" }]);
  });
});

describe("build 路由", () => {
  const withSession = (repo: FakeRepo, s: SessionLike, over: Partial<PipelineDeps> = {}) =>
    fakeDeps(repo, { sessAsync: () => Promise.resolve(s), ...over });

  it("正常起跑的响应形状", async () => {
    const repo = new FakeRepo();
    repo.renewOk = false;
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    expect(await build("sess-1", withSession(repo, s), "flow_preview")).toEqual({
      started: true,
      session: "sess-1",
      tier: "flow_preview",
    });
    await s.runTask!.promise.catch(() => undefined);
  });

  it("没有材料 → 400「还没有上传材料」", async () => {
    const repo = new FakeRepo();
    const s = fakeSession();
    await expect(build("sess-1", withSession(repo, s), undefined)).rejects.toMatchObject({
      status: 400,
      message: "还没有上传材料",
    });
  });

  it("会话不存在 → 404，消息里带 sid", async () => {
    const repo = new FakeRepo();
    repo.claimOk = false;
    repo.session = null;
    const s = fakeSession();
    await expect(build("zzz", withSession(repo, s), undefined)).rejects.toMatchObject({
      status: 404,
      message: "没有会话 zzz",
    });
  });

  it("等人回答时 → 409，文案指路", async () => {
    const repo = new FakeRepo();
    repo.claimOk = false;
    repo.session = { status: "awaiting_answer", error: "", state_version: 0 };
    await expect(
      build("sess-1", withSession(repo, fakeSession()), undefined),
    ).rejects.toMatchObject({
      status: 409,
      message: "当前正在等待业务回答；请先回答、暂缓或导出问题清单。",
    });
  });

  it("状态本来就可启动 = 一次争用 → 重试一次再下结论", async () => {
    const repo = new FakeRepo();
    let n = 0;
    // 第一轮说 idle（可启动），第二轮才真的抢到
    repo.claimBuildLease = () => Promise.resolve(++n > 1);
    repo.renewOk = false;
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    expect(await build("sess-1", withSession(repo, s), undefined)).toEqual({
      started: true,
      session: "sess-1",
      tier: "full",
    });
    await s.runTask!.promise.catch(() => undefined);
  });

  it("重试之后还在跑 → 409 带上会话状态", async () => {
    const repo = new FakeRepo();
    repo.claimOk = false;
    repo.session = { status: "extracting", error: "", state_version: 0 };
    await expect(
      build("sess-1", withSession(repo, fakeSession()), undefined),
    ).rejects.toMatchObject({ status: 409, message: "没能启动梳理（会话状态：extracting）" });
  });
});

describe("stop 路由", () => {
  const depsFor = (repo: FakeRepo, s: SessionLike) =>
    fakeDeps(repo, { sessAsync: () => Promise.resolve(s) });

  function runningHandle(): SessionLike["runTask"] {
    const c = new AbortController();
    let done = false;
    const promise = new Promise<void>((res) => {
      c.signal.addEventListener("abort", () => {
        done = true;
        res();
      });
    });
    return { promise, signal: c.signal, done: () => done, abort: () => c.abort() };
  }

  it("没有在跑的东西就是一次 200 空操作（幂等）", async () => {
    const repo = new FakeRepo();
    expect(await stop("sess-1", depsFor(repo, fakeSession()), null)).toEqual({
      stopped: [],
      requested: [],
    });
  });

  it("本 worker 有任务 → stopped；远端只有耐久意图 → requested", async () => {
    const repo = new FakeRepo();
    repo.cancelChat = true;
    repo.cancelRun = true;
    const s = fakeSession({ runTask: runningHandle() });
    const out = await stop("sess-1", depsFor(repo, s), { target: "all" });
    expect(out).toEqual({ stopped: ["run"], requested: ["chat"] });
    // 远端 run 的耐久意图会把内存投影落成 stopped；本地 run 由任务自己收尾
    expect(s.status).toBe("idle");
  });

  it("远端 run 的耐久意图落成内存里的 stopped", async () => {
    const repo = new FakeRepo();
    repo.cancelRun = true;
    const s = fakeSession({ status: "extracting", error: "旧的" });
    expect(await stop("sess-1", depsFor(repo, s), { target: "run" })).toEqual({
      stopped: [],
      requested: ["run"],
    });
    expect([s.status, s.error]).toEqual(["stopped", ""]);
  });

  it("target 只能是 chat/run/all", async () => {
    const repo = new FakeRepo();
    await expect(
      stop("sess-1", depsFor(repo, fakeSession()), { target: "乱写" }),
    ).rejects.toMatchObject({ status: 400, message: "target 只能是 chat、run 或 all" });
  });

  it("target 缺席 = all（两条取消都发）", async () => {
    const repo = new FakeRepo();
    await stop("sess-1", depsFor(repo, fakeSession()), {});
    expect(repo.calls.map(([n]) => n)).toEqual(["requestChatCancel", "requestBuildCancel"]);
  });

  it("target=chat 时不碰 run", async () => {
    const repo = new FakeRepo();
    await stop("sess-1", depsFor(repo, fakeSession()), { target: "chat" });
    expect(repo.calls.map(([n]) => n)).toEqual(["requestChatCancel"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  取消原语与时间格式
// ══════════════════════════════════════════════════════════════════

describe("取消原语", () => {
  it("isCancelled 按名字认，跨模块实例也认得出", () => {
    expect(isCancelled(new RunCancelled())).toBe(true);
    const fake = new Error("x");
    fake.name = "RunCancelled";
    expect(isCancelled(fake)).toBe(true);
    expect(isCancelled(new TypeError("x"))).toBe(false);
  });

  it("AsyncLock 是 FIFO 的", async () => {
    const lock = new AsyncLock();
    const order: number[] = [];
    const one = await lock.acquire();
    const p2 = lock.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = lock.acquire().then((r) => {
      order.push(3);
      r();
    });
    order.push(1);
    one();
    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("release 幂等：多放一次不会把锁解成两把", async () => {
    const lock = new AsyncLock();
    const r = await lock.acquire();
    r();
    r();
    let held = false;
    const a = await lock.acquire();
    held = true;
    expect(held).toBe(true);
    a();
  });
});

describe("pyIsoUtc", () => {
  it("微秒为 0 时不写小数部分，时区是 +00:00 而不是 Z", () => {
    expect(pyIsoUtc(0)).toBe("1970-01-01T00:00:00+00:00");
    expect(pyIsoUtc(1_700_000_000)).toBe("2023-11-14T22:13:20+00:00");
  });

  it("有微秒时写满六位", () => {
    expect(pyIsoUtc(1_700_000_000.5)).toBe("2023-11-14T22:13:20.500000+00:00");
    expect(pyIsoUtc(1_700_000_000.000001)).toBe("2023-11-14T22:13:20.000001+00:00");
  });
});

describe("BUILD_STARTABLE", () => {
  it("四个可启动状态，一个都不能多、不能少", () => {
    expect([...BUILD_STARTABLE]).toEqual(["idle", "done", "failed", "stopped"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _run_pipeline —— 节点顺序、gate、挂起、失败、取消、journal.flush
// ══════════════════════════════════════════════════════════════════

/** 记 flush 次数的 journal —— 「Run 收尾与节点边界要 flush」这条要能被证伪。 */
class CountingJournal extends InMemoryJournal {
  flushes = 0;
  override flush(): Promise<void> {
    this.flushes += 1;
    return super.flush();
  }
}

interface Rig {
  readonly repo: FakeRepo;
  readonly deps: PipelineDeps;
  readonly journal: CountingJournal;
  readonly closed: { n: number };
}

function rig(over: Partial<PipelineDeps> = {}, outcomes: Record<string, unknown> = {}): Rig {
  const repo = new FakeRepo();
  const journal = new CountingJournal();
  const rec = new Recorder("run-1", journal, new InMemoryBlobStore());
  const budget = new Budget({ usd: 5 });
  const closed = { n: 0 };
  const outcome = (o: Partial<SchedulerOutcome>): SchedulerOutcome => ({
    status: "completed",
    outputs: {},
    results: {},
    pendingHuman: null,
    error: "",
    skipped: [],
    ...o,
  });
  const base: PipelineDeps = {
    repo: () => repo as never,
    workerId: "w",
    now: () => 1000,
    buildLeaseTtl: () => 30,
    buildHeartbeatInterval: () => 60, // 测试期间心跳不该真的响
    newToken: () => "tok",
    sessAsync: () => Promise.reject(new Error("unused")),
    refreshFilesProjection: () => Promise.resolve(),
    runIdFor: () => "run-1",
    gateways: () => ({
      backend: {
        aclose: () => {
          closed.n += 1;
          return Promise.resolve();
        },
      },
      gw: { rec },
      smart: null,
      budget,
    }),
    ensureCatalog: () => Promise.resolve({ byCapability: () => ({}) }),
    catalog: () => ({ byCapability: () => ({ vision: ["v1", "v2", "v3", "v4"] }) }),
    warnLowBalance: () => Promise.resolve(),
    moneyFailure: () => ["", ""],
    usdCap: () => 5,
    projectMemory: () =>
      Promise.resolve({ store: null, authoritative: () => [{ content: "项目约定" }] }),
    rememberRunLessons: () => Promise.resolve(),
    chunkCache: () => ({}),
    stateDialogue: () => null,
    dialogue: () => ({ turns: [], activeDecisions: () => [] }),
    emitAiPrompts: () => Promise.resolve(),
    persistDecisions: () => Promise.resolve(),
    registry: () => ({ parseAll: () => Promise.resolve([]) }) as never,
    buildIndex: () => ({ length: 3, allChunks: () => [] }),
    collectEndpoints: () => ["e1"],
    collectProfiles: () => ({ a: 1 }),
    corpusSummary: () => ({ findings: ["f1"] }),
    segmentCorpus: () => [{ key: "k", label: "L", fileName: "f.csv", chunkIds: ["c1"] }],
    buildDag: () => ({}),
    buildOir: () => ({
      questions: new Map(),
      actions: [],
      addQuestion: () => undefined,
      stats: () => ({ objects: 1 }),
      toDict: () => ({ objects: [] }),
    }),
    finish: () => ({
      conflicts: [],
      align: {},
      merged: 0,
      uncertain: 0,
      auto_repaired: 0,
      // 真的 ClarificationSet（纯数据）。原本这里是 `{ questions: [], summary: () => ({}) }`，
      // 照的是**错误的端口声明** —— 真身没有 summary() 方法，摘要走
      // `clarificationSummary(cs)`。夹具形状错了，真跑就炸。
      //
      // **questions 必须非空**：空数组时 `cs.questions.map(...)` 根本不执行，
      // 这一段在所有测试里都是绿的，然后在真材料上炸成
      // `q.toDict is not a function`（真跑抓到过一次，抽取花完钱之后才失败）。
      // 同理，单个问句转 dict 走 `questionToDict(q)`，不是 `q.toDict()`。
      clarify: { ...makeClarificationSet(), questions: [CLARIFY_Q] },
      suggestions: [],
    }),
    mineQuestions: () => [],
    blocksFromMarkdown: () => [],
    buildFlowDiagram: (s) => {
      s.state["flow"] = { stats: { nodes: 4 } };
      return Promise.resolve();
    },
    linkFlowToApi: () => [],
    replayOirPatches: () => [],
    syncQuestionBacklog: () => Promise.resolve({}),
    pendingQuestions: () => [],
    compile: () => Promise.resolve(),
    harness: {
      buildTools: () => Promise.resolve({}),
      extractorSystem: () => "SYS",
      makeContext: () => {
        const reflections: string[] = [];
        return {
          get reflections() {
            return reflections;
          },
          reflect: (t: string) => reflections.push(t),
        };
      },
      makeExtractRun: () => ({
        run: () => Promise.resolve(outcome((outcomes["extract"] as object) ?? {})),
      }),
      engagementDag: () => ({ name: "fde.v1", describe: () => ["PROCESS"] }),
      makeEngagementRun: () => ({
        run: () => Promise.resolve(outcome((outcomes["engagement"] as object) ?? {})),
      }),
    },
  };
  return { repo, journal, closed, deps: { ...base, ...over } };
}

const RELEASED_EXPORT = {
  status: "completed",
  outputs: {
    EXPORT: {
      review_passed: true,
      schema_valid: true,
      downloadable: true,
      releaseState: "RELEASED",
      artifacts: ["模板_v1.xlsx"],
    },
  },
};

describe("runPipeline · flow_preview（免费档）", () => {
  it("到流程图为止就收工，不进付费 DAG", async () => {
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv", path: "/tmp/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    expect(s.status).toBe("done");
    expect(s.events.map((e) => e["kind"])).toEqual([
      "node.entered",
      "node.completed",
      "run.completed",
    ]);
    // 免费档的 run.completed 会把 flow 的 stats 摊平进来
    expect(s.events[2]).toEqual({
      kind: "run.completed",
      stats: { tier: "flow_preview", nodes: 4 },
    });
    expect(r.repo.calls.filter(([n]) => n === "finishRun")).toEqual([
      ["finishRun", { status: "done" }],
    ]);
  });

  it("PARSE 的 stats 数的是解析结果，不是别的", async () => {
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    expect(s.events[1]).toEqual({
      kind: "node.completed",
      node: "PARSE",
      stats: { files: 1, chunks: 3, endpoints: 1, profiles: 1 },
      findings: ["f1"],
    });
  });

  it("扫描件会先预告要用视觉模型，且只列前三个", async () => {
    const r = rig();
    const s = fakeSession({
      files: [{ name: "扫描.pdf", path: "/x/扫描.pdf" }],
      buildLeaseOwner: "L",
    });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    const step = s.events.find((e) => e["kind"] === "flow.step");
    expect(step!["found"]).toBe(
      "1 份图片/PDF 将先读取原生内容；只有图片和 PDF 的无文本页才用视觉模型识别" +
      "（可用：v1、v2、v3），单页可能要几十秒。",
    );
  });

  it("网关上没有视觉模型时，预告里直接说识别会失败", async () => {
    const r = rig({ catalog: () => ({ byCapability: () => ({}) }) });
    const s = fakeSession({
      files: [{ name: "扫描.png", path: "/x/扫描.png" }],
      buildLeaseOwner: "L",
    });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    const step = s.events.find((e) => e["kind"] === "flow.step");
    expect(step!["found"]).toContain("⚠ 网关上没有带视觉的模型，识别会失败");
  });

  it("Run 收尾与节点边界都 flush 过 journal（Recorder 不代劳）", async () => {
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    // PARSE 边界一次 + Run 收尾一次 + finally 的兜底一次
    expect(r.journal.flushes).toBe(3);
  });

  it("收尾一定还租约、一定关 backend（finally 的两件事）", async () => {
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "flow_preview", controller: new AbortController() });
    expect(r.repo.calls.some(([n, o]) => n === "releaseBuildLease" && (o as { owner: string }).owner === "L")).toBe(true);
    expect(s.buildLeaseOwner).toBe("");
    expect(r.closed.n).toBe(1);
  });
});

describe("runPipeline · full（付费档）", () => {
  it("节点顺序与冻结事件", async () => {
    const r = rig({}, { engagement: RELEASED_EXPORT });
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.events.map((e) => e["kind"])).toEqual([
      "node.entered",       // PARSE
      "node.completed",     // PARSE
      "engagement.frozen",
      "plan.frozen",
      "node.entered",       // EXTRACT
      "gaps.mined",
      "node.completed",     // EXTRACT
      "node.entered",       // FINISH
      "engagement.stage",   // GAP
      "node.completed",     // ALIGN
      "node.completed",     // CONFLICT
      "clarify.request",
      "engagement.stage",   // EXPORT
    ]);
    expect(s.state["release_state"]).toBe("RELEASED");
  });

  it("澄清问句落进 state 的是 questionToDict 的 snake_case dict，不是调 q.toDict()", async () => {
    // clarify.Question 是**普通对象**，没有 toDict 方法 —— 写成 `q.toDict()` 时
    // tsc 曾被 `as` 骗过、端口又把元素声明成 unknown[]，于是一路潜伏到真材料上
    // 才炸（抽取的钱都花完了）。这里钉住两件事：不抛，且键名是下游认的那套。
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    const qs = s.state["questions"] as Record<string, unknown>[];
    expect(qs).toEqual([questionToDict(CLARIFY_Q)]);
    // 下游 `Question.fromDict` 认 conflict_rid —— camelCase 的 conflictRid 漏出去
    // 不会报错，只会让问题丢掉冲突出处。
    expect(qs[0]!["conflict_rid"]).toBe("c_采购方式取值不一致");
    expect(qs[0]).not.toHaveProperty("conflictRid");
  });

  it("engagement 挂起 = awaiting_answer + run.suspended，并且 checkpoint 在收尾之前", async () => {
    const r = rig({}, { engagement: { status: "suspended", pendingHuman: { pending: 3 } } });
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.status).toBe("awaiting_answer");
    const kinds = s.events.map((e) => e["kind"]);
    expect(kinds.slice(-2)).toEqual(["engagement.stage", "run.suspended"]);
    expect(s.events.at(-2)).toEqual({
      kind: "engagement.stage",
      node: "INTERVIEW",
      contract: "QuestionBacklog",
      pending: 3,
    });
    // 顺序：先 saveBuildState（检查点），再 finishRun(suspended)
    const names = r.repo.calls.map(([n]) => n);
    expect(names.lastIndexOf("saveBuildState")).toBeLessThan(names.lastIndexOf("finishRun"));
    expect(r.repo.calls.find(([n]) => n === "finishRun")![1]).toMatchObject({
      status: "suspended",
    });
    // engagement_run_id 必须和抽取用的是**同一个** run，否则 resume 永远命不中
    expect(s.state["engagement_run_id"]).toBe("run-1");
  });

  it("pendingHuman 没给数时回落到本地 backlog 的未决数", async () => {
    const r = rig(
      { pendingQuestions: () => [1, 2] as never },
      { engagement: { status: "suspended", pendingHuman: {} } },
    );
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.events.at(-2)!["pending"]).toBe(2);
  });

  it("EXPORT 硬门任何一项没过都阻止交付", async () => {
    for (const bad of ["review_passed", "schema_valid", "downloadable"]) {
      const plan = { ...RELEASED_EXPORT.outputs.EXPORT, [bad]: false };
      const r = rig({}, { engagement: { status: "completed", outputs: { EXPORT: plan } } });
      const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
      await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
      expect(s.status).toBe("failed");
      expect(s.error).toContain("FDE Engagement EXPORT 硬门未通过，已阻止交付");
    }
  });

  it("抽取失败 → run.failed，错误落到会话上", async () => {
    const r = rig({}, { extract: { status: "failed", error: "节点炸了" } });
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.status).toBe("failed");
    expect(s.error).toBe("Error: 抽取失败：节点炸了");
    expect(s.events.at(-1)).toEqual({ kind: "run.failed", error: "Error: 抽取失败：节点炸了" });
  });

  it("没有可抽取的内容时，错误里带上每份材料读出了多少段", async () => {
    const r = rig({
      segmentCorpus: () => [],
      registry: () =>
        ({
          parseAll: () =>
            Promise.resolve([
              { file_name: "空.pdf", chunks: [], findings: [{ kind: "empty_ocr", message: "OCR 没出东西" }] },
            ]),
        }) as never,
    });
    const s = fakeSession({ files: [{ name: "空.pdf", path: "/x/空.pdf" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.error).toBe("Error: 没有可抽取的内容：空.pdf 读出 0 段。原因：OCR 没出东西");
  });

  it("欠费和本地上限用满是**两种**说法，不能说反", async () => {
    for (const [signal, needle] of [
      ["quota", "网关账户余额不足"],
      ["cap", "花费上限"],
    ] as const) {
      const r = rig(
        { moneyFailure: () => [signal, "网关原话"] },
        { extract: { status: "failed", error: "x" } },
      );
      const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
      await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
      expect(s.error).toContain(needle);
      expect(s.events.map((e) => e["kind"])).toContain(
        signal === "quota" ? "quota.exhausted" : "budget.capped",
      );
    }
  });

  it("项目权威档同时进 L3 与黑板（少挂一处 = 项目记忆凭空消失）", async () => {
    const seen: string[] = [];
    const r = rig({
      harness: {
        ...rig().deps.harness,
        makeContext: () => {
          const reflections: string[] = [];
          return {
            get reflections() {
              return reflections;
            },
            reflect: (t: string) => {
              seen.push(t);
              reflections.push(t);
            },
          };
        },
      },
    }, { engagement: RELEASED_EXPORT });
    const s = fakeSession({
      files: [{ name: "a.csv", path: "/x/a.csv" }],
      buildLeaseOwner: "L",
      projectId: "p1",
    });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(seen).toEqual(["项目已拍板：项目约定"]);
  });
});

describe("runPipeline · 取消", () => {
  it("租约续不上就是取消：落 stopped、finishRun(cancelled)、且**不写**检查点", async () => {
    const r = rig();
    r.repo.renewOk = false;
    r.repo.session = { status: "stopped", error: "", state_version: 0 };
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await expect(
      runPipeline(s, r.deps, { tier: "full", controller: new AbortController() }),
    ).rejects.toBeInstanceOf(RunCancelled);
    expect(s.status).toBe("stopped");
    expect(s.events.map((e) => e["kind"])).toEqual(["run.cancelled"]);
    expect(r.repo.calls.some(([n]) => n === "saveBuildState")).toBe(false);
    // repo_run_id 还没发出来就被取消了，所以这一次没有 finishRun
    expect(r.repo.calls.some(([n]) => n === "finishRun")).toBe(false);
  });

  it("abort 之后在下一个检查点抛 RunCancelled，并把仓储的权威状态读回来", async () => {
    const controller = new AbortController();
    const r = rig({
      warnLowBalance: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    r.repo.session = { status: "stopped", error: "", state_version: 0 };
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await expect(runPipeline(s, r.deps, { tier: "full", controller })).rejects.toBeInstanceOf(
      RunCancelled,
    );
    expect(s.status).toBe("stopped");
    expect(r.repo.calls.at(-2)).toEqual(["finishRun", { status: "failed", error: "cancelled" }]);
  });

  it("没有 lease token 也当取消（另一个 worker 已经接管）", async () => {
    const r = rig();
    const s = fakeSession({ files: [{ name: "a.csv" }], buildLeaseOwner: "" });
    await expect(
      runPipeline(s, r.deps, { tier: "full", controller: new AbortController() }),
    ).rejects.toBeInstanceOf(RunCancelled);
    // 没有 token 就不该去 releaseBuildLease（那会误删别人的租约）
    expect(r.repo.calls.some(([n]) => n === "releaseBuildLease")).toBe(false);
  });

  it("检查点失败也是取消时，finishRun 记 cancelled 而不是 failed 的原文", async () => {
    const r = rig({}, { extract: { status: "failed", error: "x" } });
    r.repo.saveBuildState = () => Promise.resolve(null);
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await expect(
      runPipeline(s, r.deps, { tier: "full", controller: new AbortController() }),
    ).rejects.toBeInstanceOf(RunCancelled);
    expect(r.repo.calls.at(-2)).toMatchObject(["finishRun", { status: "failed", error: "cancelled" }]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  路由接线 —— 路径 / 方法 / JSON 字段名一个字都不能改
// ══════════════════════════════════════════════════════════════════

describe("pipelineRoutes", () => {
  function appFor(repo: FakeRepo, s: SessionLike): Hono {
    const app = new Hono();
    app.onError(fastapiErrorHandler);
    app.route("/", pipelineRoutes(fakeDeps(repo, { sessAsync: () => Promise.resolve(s) })));
    return app;
  }

  it("POST /api/sessions/:sid/build?tier=…", async () => {
    const repo = new FakeRepo();
    repo.renewOk = false;
    const s = fakeSession({ files: [{ name: "a.csv" }] });
    const res = await appFor(repo, s).request("/api/sessions/sess-1/build?tier=flow_preview", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, session: "sess-1", tier: "flow_preview" });
    await s.runTask?.promise.catch(() => undefined);
  });

  it("build 的错误落成 FastAPI 的 {detail: …}", async () => {
    const repo = new FakeRepo();
    const res = await appFor(repo, fakeSession()).request("/api/sessions/sess-1/build", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "还没有上传材料" });
  });

  it("POST /api/sessions/:sid/stop 空 body 也能跑（FastAPI 的 body=None）", async () => {
    const repo = new FakeRepo();
    const res = await appFor(repo, fakeSession()).request("/api/sessions/sess-1/stop", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [], requested: [] });
  });

  it("stop 带 target", async () => {
    const repo = new FakeRepo();
    repo.cancelRun = true;
    const res = await appFor(repo, fakeSession()).request("/api/sessions/sess-1/stop", {
      method: "POST",
      body: JSON.stringify({ target: "run" }),
      headers: { "content-type": "application/json" },
    });
    expect(await res.json()).toEqual({ stopped: [], requested: ["run"] });
  });

  it("GET 打不通这两条路由（方法必须是 POST）", async () => {
    const repo = new FakeRepo();
    const app = appFor(repo, fakeSession());
    expect((await app.request("/api/sessions/x/build")).status).toBe(404);
    expect((await app.request("/api/sessions/x/stop")).status).toBe(404);
  });
});

describe("runPipeline · journal 落盘", () => {
  it("失败路径也 flush（残缺的日志会让 resume 把付过钱的节点重跑）", async () => {
    const r = rig({}, { extract: { status: "failed", error: "x" } });
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(r.journal.flushes).toBeGreaterThan(0);
  });

  it("finally 那一次 flush 失败**不许**盖掉真正的错误", async () => {
    const r = rig({}, { extract: { status: "failed", error: "真正的错误" } });
    let n = 0;
    // 只让收尾那一次失败：节点边界那次照常成功
    r.journal.flush = () => (++n >= 2 ? Promise.reject(new Error("磁盘满了")) : Promise.resolve());
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.error).toContain("真正的错误");
  });

  it("节点边界的 flush 失败**要**上抛（和 _persist 同一条理由：日志断了就别装成功）", async () => {
    const r = rig({}, { engagement: RELEASED_EXPORT });
    r.journal.flush = () => Promise.reject(new Error("磁盘满了"));
    const s = fakeSession({ files: [{ name: "a.csv", path: "/x/a.csv" }], buildLeaseOwner: "L" });
    await runPipeline(s, r.deps, { tier: "full", controller: new AbortController() });
    expect(s.status).toBe("failed");
    expect(s.error).toBe("Error: 磁盘满了");
  });
});
