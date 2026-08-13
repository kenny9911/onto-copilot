/**
 * server 段 E（对话与对话侧动作工具）的行为钉。
 *
 * 这一段没有 golden —— 它的"事实"是 `server.py` 4513–6196 的源码本身（一整节
 * HTTP + 副作用，导不出确定性向量）。所以断言取的是**逐字对照 Python 原件**的
 * 那些串与分支：
 *
 * * 每个工具的**作用域**（RW 绝不能漏进 chat）与**危险等级**（EXTERNAL 才要确认）；
 * * 每一条 `{"error": …}` 的**原文**（它是给模型看的自纠信号，不是兜底）；
 * * `/chat` 响应体的**字段名**（前端是现成的，改一个字就静默瞎掉）；
 * * 租约、取消、回滚这三处只在并发下才暴露的路径。
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { DialogueMemory, Speaker } from "../src/kernel/memory/dialogue.js";
import { OIR } from "../src/onto/oir.js";
import { FlowGraph } from "../src/onto/flow.js";
import { AsyncLock, RunCancelled } from "../src/server/pipeline/types.js";
import type { RunHandle, SessionLike as PipelineSessionLike } from "../src/server/pipeline/types.js";
import type { Repo } from "../src/store/repo/protocol.js";
import type { SessionEvent } from "../src/session_events.js";

import {
  askBack,
  chatClaimed,
  chatDocsBrief,
  chatRoute,
  contextBrief,
  converseTools,
  isBusy,
  outcome,
  parserFor,
  reason,
  reconcileOnBoot,
  replayPending,
  say,
  withSessionMutation,
} from "../src/server/dialogue.js";
import { dialogueOf, publishTurn, TABLE_MEMORY_CAP } from "../src/server/dialogue/memory.js";
import { formatPercent0, pyJsonIndent, pyRound } from "../src/server/dialogue/pyutil.js";
import type {
  ChatRunLike,
  ConverseTurnLike,
  DialogueDeps,
  IntentMatchLike,
  SessionLike,
} from "../src/server/dialogue/ports.js";

// ══════════════════════════════════════════════════════════════════
//  假件
// ══════════════════════════════════════════════════════════════════

function makeSession(over: Partial<SessionLike> = {}): SessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-dlg-"));
  const s: SessionLike = {
    id: over.id ?? "s1",
    title: "新建会话",
    project: "",
    projectId: "",
    created: 1700000000,
    files: [],
    status: "idle",
    error: "",
    dir,
    events: [],
    state: {},
    stateVersion: 0,
    owner: "",
    buildLeaseOwner: "",
    mutationLeaseOwner: "",
    buildLock: new AsyncLock(),
    chatTask: null,
    runTask: null,
    lang: "zh",
    emit(kind, payload = {}) {
      // hub 把 `kind` 写在展开**之后** —— 事件类型不会被 payload 里同名的 kind
      // 顶掉（`human.recorded` 的 payload 就带一个 `kind: "oir"`）。
      const ev = { ...payload, kind } as unknown as SessionEvent;
      (s.events as unknown[]).push(ev);
      return ev;
    },
    async emitDurable(kind, payload = {}) {
      return s.emit(kind, payload);
    },
  } as SessionLike;
  Object.assign(s, over);
  return s;
}

/** 只实现这一段真的会碰到的仓储方法；碰到没实现的就抛，免得静默走空路。 */
function makeRepo(over: Partial<Repo> = {}): Repo {
  const base = {
    async getSession() {
      return null;
    },
    async listSessions() {
      return [];
    },
    async reapExpiredBuildLease() {
      return false;
    },
    async claimChatLease() {
      return true;
    },
    async renewChatLease() {
      return true;
    },
    async releaseChatLease() {
      return true;
    },
    async claimMutationLease() {
      return true;
    },
    async renewMutationLease() {
      return true;
    },
    async releaseMutationLease() {
      return true;
    },
    async loadState() {
      return {};
    },
  };
  return new Proxy({ ...base, ...over } as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      return () => {
        throw new Error(`fake repo：没实现 ${k}`);
      };
    },
  }) as unknown as Repo;
}

function fakeTurn(over: Partial<ConverseTurnLike> = {}): ConverseTurnLike {
  return {
    answer: "好了",
    citations: [],
    followup: "",
    nextQuestions: [],
    steps: [],
    findings: [],
    usd: 0,
    toDict: () => ({}),
    ...over,
  };
}

interface DepsOver extends Partial<DialogueDeps> {
  turn?: ConverseTurnLike;
}

function makeDeps(over: DepsOver = {}): DialogueDeps {
  const gw = {
    rec: null,
    async call() {
      return { data: { reply: "措辞后的话" } };
    },
  };
  const run: ChatRunLike = {
    repoRunId: "r1",
    recorderRunId: "chat_s1_reason_abc",
    gw,
    smart: null,
    fail: () => undefined,
  };
  const deps: DialogueDeps = {
    getRepo: () => makeRepo(),
    now: () => 1700000000,
    workerId: "worker-test",
    chatLeaseTtl: 30,
    chatHeartbeatInterval: 1000,
    mutationLeaseTtl: 30,
    mutationHeartbeatInterval: 1000,
    newToken: () => "tok",
    sessAsync: async () => makeSession(),
    refreshFilesProjection: async () => undefined,
    restoreDialogue: async () => undefined,
    persist: async () => undefined,
    autoTitle: async () => undefined,
    persistedKeys: ["oir", "flow"],
    persistedPrivateKeys: ["_flow_versions"],
    persistedPrivateDocKeys: ["_chunks"],
    chatUsdCap: () => 5,
    modelOverrides: () => ({}),
    budgetCappedText: ({ spent, cap }) => `到顶了：${spent}/${cap}`,
    modelSpecFor: () => null,
    ensureCatalog: async () => null,
    makeParser: () => ({
      parse: () => ({
        matches: [{ intent: "ask", confidence: 0.5, slots: {}, span: "" }],
        toDict: () => ({ text: "x" }),
      }),
    }),
    unknownIntent: "unknown",
    makeAgent: () => ({
      run: async () => over.turn ?? fakeTurn(),
    }),
    chatSystem: "CHAT",
    chatRun: async (_s, _o, body) => await body(run),
    builtinRegistry: () => new ToolRegistry(),
    preparse: async () => undefined,
    claimAndStartBuild: async () => "started",
    recompile: async () => undefined,
    rewriteFlowArtifacts: () => undefined,
    questionBacklog: () => ({
      questions: new Map(),
      nextBatch: () => [],
      stats: () => ({}),
    }),
    answerDomainQuestion: async () => ({
      decision: { id: "d1" },
      created: true,
      pending: null,
      status: "answered",
    }),
    rememberDecision: async () => undefined,
    materialTable: async () => ["f.xlsx", "Sheet1", ["A"], [["1"]], {}] as const,
    exportDoc: async () => [null, { error: "没有可导出的内容" }],
    exportApi: {
      FORMATS: ["xlsx", "docx", "pdf", "md", "csv"],
      resolveFormat: (f) => (f === "excel" ? "xlsx" : ["xlsx", "md"].includes(f) ? f : ""),
      render: async () => [new Uint8Array([1, 2, 3]), { ext: ".xlsx", label: "Excel" }],
      safeName: (t, ext) => `${t}${ext}`,
    },
    applyFlowEdit: () => "改好了",
    tablesInText: () => [],
    settleFollowups: () => [{ text: "接下来？" }],
    followupPrompts: () => [{ text: "启发式" }],
    asked: () => [],
    traceAux: () => undefined,
  };
  const { turn: _turn, ...rest } = over;
  return { ...deps, ...rest };
}

async function callTool(
  s: SessionLike,
  deps: DialogueDeps,
  name: string,
  args: Record<string, unknown> = {},
  opts: { approved?: boolean; scope?: string } = {},
): Promise<Record<string, unknown>> {
  const reg = converseTools(s, deps);
  const ctx = { approved: opts.approved ?? true, pending: [] };
  const out = await reg.call(name, args, ctx, { scope: opts.scope ?? "converse" });
  return out as Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

describe("pyutil", () => {
  it("round 是 half-even，不是 JS 的 half-up", () => {
    // Python: round(0.125, 2) == 0.12（末位取偶），round(0.135, 2) == 0.14
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(0.375, 2)).toBe(0.38);
    expect(pyRound(2.5, 0)).toBe(2);
    expect(pyRound(3.5, 0)).toBe(4);
    expect(pyRound(-0.125, 2)).toBe(-0.12);
    expect(pyRound(1, 2)).toBe(1);
  });

  it("format(x, '.0%') 的形态", () => {
    expect(formatPercent0(0.5)).toBe("50%");
    expect(formatPercent0(1)).toBe("100%");
    expect(formatPercent0(0.855)).toBe("86%");
    expect(formatPercent0(0)).toBe("0%");
  });

  it("json.dumps(indent=1, ensure_ascii=False)：中文不转义、缩进 1 空格", () => {
    expect(pyJsonIndent({ 动作: "oir.add", n: 2 }, 1)).toBe('{\n "动作": "oir.add",\n "n": 2\n}');
    expect(pyJsonIndent({}, 1)).toBe("{}");
    expect(pyJsonIndent([], 1)).toBe("[]");
  });
});

// ══════════════════════════════════════════════════════════════════
//  作用域与危险等级 —— 这一节是安全边界，不是风格
// ══════════════════════════════════════════════════════════════════

/** Python `_converse_tools` 里 RW=("converse",) 的那一批。 */
const RW_TOOLS = [
  "question.answer",
  "decision.record",
  "suggestion.apply",
  "oir.undo",
  "oir.add",
  "oir.edit",
  "build.start",
  "flow.edit",
  "flow.undo",
  "flow.preview",
  "template.edit",
  "template.undo",
  "template.recompile",
];

/** RO=("converse","chat")，两个模式都给。 */
const RO_TOOLS = [
  "material.list",
  "template.query",
  "ui.table",
  "question.next",
  "export.file",
  "material.parse",
  "material.inspect",
  "material.rows",
  "session.status",
  "flow.query",
  "flow.issues",
];

/** `danger=Danger.EXTERNAL` 的那一批 —— `requiresApproval` 只认这一档。 */
const EXTERNAL_TOOLS = [
  "question.answer",
  "suggestion.apply",
  "oir.add",
  "oir.edit",
  "flow.edit",
  "template.edit",
  "template.recompile",
];

describe("工具作用域", () => {
  const s = makeSession();
  const reg = converseTools(s, makeDeps());
  const inChat = new Set(reg.forScope("chat").map((t) => t.spec.name));
  const inConverse = new Set(reg.forScope("converse").map((t) => t.spec.name));

  it("改产物的工具一个都不进 chat 作用域", () => {
    // tools.ts 的 register() 里记着那条真实事故：scopes 默认 ["*"] 会把工具发给
    // 每一个作用域。这里逐个点名，漏一个就是把写权限发给了聊天模式。
    for (const name of RW_TOOLS) {
      expect(inChat.has(name), `${name} 不该出现在 chat 作用域`).toBe(false);
      expect(inConverse.has(name), `${name} 应该在 converse 作用域`).toBe(true);
    }
  });

  it("只读工具两个模式都给", () => {
    for (const name of RO_TOOLS) {
      expect(inChat.has(name), `${name} 应该在 chat 作用域`).toBe(true);
      expect(inConverse.has(name), `${name} 应该在 converse 作用域`).toBe(true);
    }
  });

  it("chat 作用域拿不到任何工具时也不会 fail-open", () => {
    // get() 走的是 forScope 白名单：不在名单里就抛 ToolDenied，而不是照样执行。
    expect(() => reg.get("oir.add", "chat")).toThrow(/作用域 'chat' 里没有工具 'oir\.add'/);
  });

  it("EXTERNAL 与 requiresApproval 一一对应", () => {
    const external = [...inConverse]
      .map((n) => reg.get(n, "converse").spec)
      .filter((sp) => sp.danger === Danger.EXTERNAL)
      .map((sp) => sp.name)
      .sort();
    expect(external).toEqual([...EXTERNAL_TOOLS].sort());
    for (const n of external) expect(reg.get(n, "converse").spec.requiresApproval).toBe(true);
  });

  it("build.start 是 WRITE_LOCAL —— 梳理不该再弹一次确认", () => {
    expect(reg.get("build.start", "converse").spec.danger).toBe(Danger.WRITE_LOCAL);
    expect(reg.get("build.start", "converse").spec.requiresApproval).toBe(false);
  });

  it("未批准时 EXTERNAL 被闸门拦下，并把动作记进 pending 供重放", async () => {
    const sess = makeSession();
    const reg2 = converseTools(sess, makeDeps());
    const pending: { tool: string; args: Record<string, unknown> }[] = [];
    await expect(
      reg2.call("suggestion.apply", { index: 1, accept: true }, { approved: false, pending }, {
        scope: "converse",
      }),
    ).rejects.toThrow(/要用户确认后才能执行/);
    expect(pending).toEqual([{ tool: "suggestion.apply", args: { index: 1, accept: true } }]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  失败文案 —— 逐字对照 Python
// ══════════════════════════════════════════════════════════════════

describe("工具的失败回执", () => {
  let s: SessionLike;
  let deps: DialogueDeps;
  beforeEach(() => {
    s = makeSession();
    deps = makeDeps();
  });

  it("template.query：还没有模板", async () => {
    expect(await callTool(s, deps, "template.query")).toEqual({
      error: "还没有模板。跑完一轮梳理才会生成。",
    });
  });

  it("ui.table：没有产物时要指路去 material.rows，而不是让模型去抄片段", async () => {
    const out = await callTool(s, deps, "ui.table", { kind: "objects" });
    expect(out["error"]).toBe("还没有 objects —— 这里列的是**梳理产出的**东西，而梳理还没跑过。");
    expect(String(out["下一步"])).toContain("material.rows");
  });

  it("material.parse：没有材料 / 正在跑", async () => {
    expect(await callTool(s, deps, "material.parse")).toEqual({ error: "还没有材料。" });
    s.files = [{ name: "a.csv", size: 1, path: "", sha256: "" }];
    s.status = "extracting";
    expect(await callTool(s, deps, "material.parse")).toEqual({
      error: "梳理正在跑，它自己会解析。",
    });
  });

  it("material.inspect：找不到材料时把现有的按 Python list repr 报回去", async () => {
    expect(await callTool(s, deps, "material.inspect", { file: "x" })).toEqual({
      error: "没有材料「x」。现有：（还没上传）",
    });
    s.state["_chunks"] = { "b.csv": [], "a.csv": [] };
    expect(await callTool(s, deps, "material.inspect", { file: "x" })).toEqual({
      error: "没有材料「x」。现有：['a.csv', 'b.csv']",
    });
  });

  it("material.inspect：百分号编码的中文名要能命中（模型爱这么传）", async () => {
    s.state["_chunks"] = { "访谈记录.xlsx": [{ text: "abc", cite: "p1" }] };
    const out = await callTool(s, deps, "material.inspect", {
      file: encodeURIComponent("访谈记录.xlsx"),
    });
    expect(out["文件"]).toBe("访谈记录.xlsx");
  });

  it("suggestion.apply：序号越界的原文", async () => {
    expect(await callTool(s, deps, "suggestion.apply", { index: 1, accept: true })).toEqual({
      error: "没有第 1 条建议，现在共 0 条",
    });
  });

  it("suggestion.apply：跑着的时候采纳会被静默覆盖，所以拒绝", async () => {
    s.status = "parsing";
    expect(await callTool(s, deps, "suggestion.apply", { index: 1, accept: true })).toEqual({
      error: "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。",
    });
  });

  it("oir.add / oir.edit：没有产物、以及跑着的时候", async () => {
    expect(await callTool(s, deps, "oir.add", { op: "add_object_type" })).toEqual({
      error: "还没有产物，先跑一轮梳理。",
    });
    s.state["_oir"] = new OIR();
    s.status = "queued";
    expect(await callTool(s, deps, "oir.edit", { op: "set_status" })).toEqual({
      error: "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。",
    });
  });

  it("oir.undo / flow.undo / template.undo：没有版本可退", async () => {
    expect(await callTool(s, deps, "oir.undo")).toEqual({ error: "没有可撤销的本体编辑。" });
    expect(await callTool(s, deps, "flow.undo")).toEqual({ error: "没有可撤销的流程图编辑。" });
    expect(await callTool(s, deps, "template.undo")).toEqual({ error: "没有可撤销的编辑。" });
  });

  it("flow.query / flow.issues / flow.edit：还没有流程图", async () => {
    expect(String((await callTool(s, deps, "flow.query"))["error"])).toBe(
      "还没有流程图。材料里要有「触发条件/输入/输出」这类结构化的流程说明才抽得出来",
    );
    expect(await callTool(s, deps, "flow.issues")).toEqual({ error: "还没有流程图" });
    expect(await callTool(s, deps, "flow.edit", { op: "add_node" })).toEqual({
      error: "还没有流程图。材料里要有结构化的流程说明才抽得出来。",
    });
  });

  it("template.recompile：没有产物 / 正在跑", async () => {
    expect(await callTool(s, deps, "template.recompile")).toEqual({ error: "还没有产物" });
    s.state["_oir"] = new OIR();
    s.status = "parsing";
    expect(await callTool(s, deps, "template.recompile")).toEqual({
      error: "梳理正在跑，这时候重出模板会覆盖掉正在生成的产物。等它跑完再说。",
    });
  });

  it("export.file：不认识的格式要把可用格式列出来", async () => {
    expect(await callTool(s, deps, "export.file", { format: "zip" })).toEqual({
      error: "不支持的格式「zip」。可用：xlsx/docx/pdf/md/csv",
    });
  });

  it("export.file：口语别名要先规范化再判，enum 卡在处理器之前就错了", async () => {
    // format 的 schema 刻意**不写 enum** —— 写死五个会让合法的 "excel" 在
    // resolve_format 有机会规范化之前就被工具契约拒掉。
    const out = await callTool(s, deps, "export.file", { format: "excel" });
    expect(out).toEqual({ error: "没有可导出的内容" }); // 走到了 exportDoc，说明没被 enum 拦
  });

  it("material.rows：多张工作表要问、读不出行要如实说", async () => {
    const { MultiSheet, NoRows } = await import("../src/server/pipeline/tables.js");
    const multi = makeDeps({
      materialTable: async () => {
        throw new MultiSheet({ 表一: 3, 表二: 5 });
      },
    });
    expect(await callTool(s, multi, "material.rows", { file: "a.xlsx" })).toEqual({
      多张工作表: { 表一: 3, 表二: 5 },
      下一步: "传 sheet=表名 再调一次；用户没指定就先问他要哪张。",
    });
    const none = makeDeps({
      materialTable: async () => {
        throw new NoRows("没有材料「x」。现有：[]");
      },
    });
    expect(await callTool(s, none, "material.rows", { file: "x" })).toEqual({
      error: "没有材料「x」。现有：[]",
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  build.start 的 outcome 分支
// ══════════════════════════════════════════════════════════════════

describe("build.start", () => {
  it("抢不到租约但状态其实是 idle 时会重试一次，而不是谎报「已经在跑」", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      claimAndStartBuild: async () => {
        seen.push("call");
        return seen.length === 1 ? "idle" : "started";
      },
    });
    const s = makeSession();
    expect(await callTool(s, deps, "build.start")).toEqual({
      已启动: true,
      材料份数: 0,
      说明: "过程会在推理轨迹里逐步显示",
    });
    expect(seen).toHaveLength(2);
  });

  it("每个 outcome 的回执逐字", async () => {
    const s = makeSession();
    const mk = (o: string) => makeDeps({ claimAndStartBuild: async () => o });
    expect(await callTool(s, mk("no_files"), "build.start")).toEqual({ error: "还没有材料" });
    expect(await callTool(s, mk("missing"), "build.start")).toEqual({
      error: "这个会话已经不存在了",
    });
    expect(await callTool(s, mk("awaiting_answer"), "build.start")).toEqual({
      error: "当前正在等待业务回答；请先处理问题清单。",
    });
    expect(await callTool(s, mk("parsing"), "build.start")).toEqual({
      error: "已经在跑了（状态：parsing），不用重复启动。",
      说明: "过程在推理轨迹里逐步显示；跑完会有产物。",
    });
    const weird = await callTool(s, mk("weird"), "build.start");
    expect(weird["error"]).toBe("没能启动，会话状态是「weird」。");
    // 这句必须在 —— 启动不了时模型的默认行为是手写一份 Action/Event 交差。
    expect(String(weird["**不要自己编产物**"])).toContain("绝不能手写一份 Action/Event");
  });

  it("flow.preview 的四个分支", async () => {
    const s = makeSession();
    const mk = (o: string) => makeDeps({ claimAndStartBuild: async () => o });
    expect(await callTool(s, mk("no_files"), "flow.preview")).toEqual({
      error: "还没有材料，先上传。",
    });
    expect(await callTool(s, mk("parsing"), "flow.preview")).toEqual({ error: "已经在跑了。" });
    expect(await callTool(s, mk("started"), "flow.preview")).toEqual({
      已启动: "免费流程预览",
      说明: "只解析 + 出流程图，跳过付费抽取；过程在推理轨迹里显示。",
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  懒解析：索引与 OIR 都按调用时取
// ══════════════════════════════════════════════════════════════════

describe("_LazyOIR / _LazyIndex", () => {
  it("回合中途才出现的 OIR，同一轮里就能查到", () => {
    const s = makeSession();
    let captured: { oir: unknown; evidence: unknown } | null = null;
    const deps = makeDeps({
      builtinRegistry: (o) => {
        captured = o as { oir: unknown; evidence: unknown };
        return new ToolRegistry();
      },
    });
    converseTools(s, deps); // 工具集在回合开始时装配
    const oirProxy = captured!.oir as { stats(): Record<string, number> };
    // 这一刻还没有产物
    expect(() => oirProxy.stats()).toThrow("还没有产物（没跑过梳理），查不了本体。");
    // 这一轮中间梳理跑完了
    s.state["_oir"] = new OIR();
    expect(oirProxy.stats()["objects"]).toBe(0);
  });

  it("没有索引时检索回空数组而不是崩", () => {
    const s = makeSession();
    let captured: { evidence: { search(): unknown; size(): number } } | null = null;
    const deps = makeDeps({
      builtinRegistry: (o) => {
        captured = o as never;
        return new ToolRegistry();
      },
    });
    converseTools(s, deps);
    expect(captured!.evidence.search()).toEqual([]);
    expect(captured!.evidence.size()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  对话记忆
// ══════════════════════════════════════════════════════════════════

describe("对话记忆", () => {
  it("_dialogue 放在私有 key 下，不进 /state 的公开部分", () => {
    const s = makeSession();
    const dm = dialogueOf(s);
    expect(dm).toBeInstanceOf(DialogueMemory);
    expect(dialogueOf(s)).toBe(dm); // 同一份
    expect(Object.keys(s.state).filter((k) => !k.startsWith("_"))).toEqual([]);
  });

  it("publishTurn 发 chat.turn，confidence 按 Python round(x, 2)", () => {
    const s = makeSession();
    publishTurn(s, makeDeps(), Speaker.USER, "你好", { intent: "greet", confidence: 0.8567 });
    const ev = s.events.at(-1) as Record<string, Record<string, unknown>>;
    expect(ev["kind"]).toBe("chat.turn");
    expect(ev["turn"]!["confidence"]).toBe(0.86);
    expect(ev["turn"]!["speaker"]).toBe("user");
  });

  it("助手那一轮**在压缩之前**把表记下来，且按标题去重、封顶", () => {
    const s = makeSession();
    let n = 0;
    const deps = makeDeps({
      tablesInText: () => [{ title: `t${n++ % 3}`, rows: [] }],
    });
    for (let i = 0; i < 40; i++) publishTurn(s, deps, Speaker.ASSISTANT, `第${i}张表`);
    const kept = s.state["_tables"] as Record<string, unknown>[];
    // 三个标题轮流出现 → 去重后只剩 3 条，远没到封顶
    expect(kept.map((x) => x["title"])).toEqual(["t1", "t2", "t0"]);
    expect(kept.length).toBeLessThanOrEqual(TABLE_MEMORY_CAP);
  });

  it("用户那一轮不记表", () => {
    const s = makeSession();
    const deps = makeDeps({ tablesInText: () => [{ title: "t", rows: [] }] });
    publishTurn(s, deps, Speaker.USER, "| a |\n|---|\n| 1 |");
    expect(s.state["_tables"]).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  上下文摘要
// ══════════════════════════════════════════════════════════════════

describe("contextBrief", () => {
  it("材料清单带上「读进来多少段」，没识别的要点出来", () => {
    const s = makeSession();
    s.files = [
      { name: "a.csv", size: 1, path: "", sha256: "" },
      { name: "b.png", size: 1, path: "", sha256: "" },
    ];
    s.state["_chunks"] = { "a.csv": [{}, {}] };
    expect(contextBrief(s)).toBe("材料：a.csv（2 段）、b.png（0 段，尚未识别内容）");
  });

  it("没材料时明说没上传，而不是留一行空白", () => {
    expect(contextBrief(makeSession())).toBe("材料：（还没上传）");
  });

  it("产物统计、已拍板、待拍板、建议都在", () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 3 } };
    s.state["questions"] = [{}, {}];
    s.state["suggestions"] = [{ title: "拆表" }];
    const dm = dialogueOf(s);
    dm.decide("caliber", "口径按财务口径", {});
    const out = contextBrief(s);
    expect(out).toContain("当前产物：objects=3");
    expect(out).toContain("待拍板 2 个");
    expect(out).toContain("待处理建议：1.拆表");
    expect(out).toContain("已拍板：");
  });
});

describe("chatDocsBrief", () => {
  it("截到 cap 之后要留一句「其余略」，不能悄悄断掉", () => {
    const s = makeSession();
    s.state["_chunks"] = { "a.txt": [{ text: "字".repeat(1500) }, { text: "乙".repeat(1500) }] };
    const out = chatDocsBrief(s, { cap: 1500 });
    expect(out).toContain("…（其余略；要完整梳理请点「转成工作会话」）");
    // 单段也按 1200 code point 截
    expect(out).not.toContain("字".repeat(1201));
  });
});

// ══════════════════════════════════════════════════════════════════
//  措辞
// ══════════════════════════════════════════════════════════════════

describe("say", () => {
  it("模型不可用时退回 fallback —— 说得难听总比不说话强", async () => {
    const s = makeSession();
    const deps = makeDeps({
      chatRun: async () => {
        throw new Error("gateway down");
      },
    });
    expect(await say(s, deps, outcome("x", "备用措辞"), "他说的")).toBe("备用措辞");
  });

  it("**取消不是失败**：必须原样上抛，不能被当成措辞失败吞掉", async () => {
    const s = makeSession();
    const deps = makeDeps({
      chatRun: async () => {
        throw new RunCancelled();
      },
    });
    await expect(say(s, deps, outcome("x", "备用"), "他说的")).rejects.toBeInstanceOf(RunCancelled);
  });

  it("verbatim 的回复一字不差", async () => {
    const s = makeSession();
    let called = false;
    const deps = makeDeps({
      chatRun: async () => {
        called = true;
        return null as never;
      },
    });
    const oc = { ...outcome("quote", "原文如此"), verbatim: true };
    expect(await say(s, deps, oc, "引用")).toBe("原文如此");
    expect(called).toBe(false);
  });

  it("模型给了话就用模型的", async () => {
    const s = makeSession();
    expect(await say(s, makeDeps(), outcome("x", "备用"), "他说的")).toBe("措辞后的话");
  });
});

describe("askBack", () => {
  it("adopt_which 时把现有建议列出来", () => {
    const s = makeSession();
    s.state["suggestions"] = [{ title: "拆表" }, { title: "并列" }];
    const m: IntentMatchLike = { intent: "unknown", confidence: 0, slots: { hint: "adopt_which" }, span: "" };
    expect(askBack(s, m)).toBe("你是要采纳哪一条？现在有：1. 拆表；2. 并列");
    s.state["suggestions"] = [];
    expect(askBack(s, m)).toBe("现在还没有建议可以采纳。");
  });

  it("判不出意图时给的是 outcome（事实+备用措辞），不是一句成品", () => {
    const s = makeSession();
    const m: IntentMatchLike = { intent: "unknown", confidence: 0, slots: {}, span: "咕咕" };
    const out = askBack(s, m) as Record<string, unknown>;
    expect(out["kind"]).toBe("not_understood");
    expect((out["facts"] as Record<string, unknown>)["没听懂的原话"]).toBe("咕咕");
  });
});

// ══════════════════════════════════════════════════════════════════
//  重放
// ══════════════════════════════════════════════════════════════════

describe("replayPending", () => {
  it("工具回 error 时如实说，且不再走一次措辞", async () => {
    const s = makeSession();
    const deps = makeDeps();
    const out = await replayPending(s, deps, {
      tool: "suggestion.apply",
      args: { index: 9, accept: true },
    });
    expect(out).toBe("没执行成功：没有第 9 条建议，现在共 0 条");
  });

  it("工具抛异常时带上类名 —— 模型据此才学得会自纠", async () => {
    const s = makeSession();
    const out = await replayPending(s, makeDeps(), { tool: "不存在的工具", args: {} });
    expect(out).toMatch(/^执行「不存在的工具」时出错了：ToolDenied: /);
  });

  it("取消要原样上抛", async () => {
    const s = makeSession();
    const deps = makeDeps({
      chatRun: async () => {
        throw new RunCancelled();
      },
    });
    await expect(replayPending(s, deps, { tool: "x", args: {} })).rejects.toBeInstanceOf(
      RunCancelled,
    );
  });

  it("成功时把结果交给措辞", async () => {
    const s = makeSession();
    s.state["suggestions"] = [{ id: "sg1", title: "拆表", impact: "低" }];
    const out = await replayPending(s, makeDeps(), {
      tool: "suggestion.apply",
      args: { index: 1, accept: false },
    });
    expect(out).toBe("措辞后的话");
    // 否决也要记一条决定
    expect(dialogueOf(s).activeDecisions().map((d) => d.statement)).toEqual(["否决：拆表"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  预算闸
// ══════════════════════════════════════════════════════════════════

describe("reason 的对话预算闸", () => {
  it("超上限直接 429，并发一条 budget.capped 让常驻提醒条亮起来", async () => {
    const s = makeSession();
    s.state["_chat_usd"] = 9;
    const deps = makeDeps({ chatUsdCap: () => 5 });
    await expect(reason(s, deps, "问点什么")).rejects.toMatchObject({ status: 429 });
    const ev = s.events.at(-1) as Record<string, unknown>;
    expect(ev["kind"]).toBe("budget.capped");
    expect(ev["scope"]).toBe("chat");
    // 铁律 C4：这条文案里不许出现充值/余额
    expect(String(ev["message"])).not.toMatch(/充值|余额/);
  });

  it("闸在开 Run 之前 —— 被拒的请求不该留下一条失败的 chat invocation", async () => {
    const s = makeSession();
    s.state["_chat_usd"] = 9;
    let opened = false;
    const deps = makeDeps({
      chatUsdCap: () => 5,
      chatRun: async (_s, _o, body) => {
        opened = true;
        return await body(null as never);
      },
    });
    await expect(reason(s, deps, "x")).rejects.toMatchObject({ status: 429 });
    expect(opened).toBe(false);
  });

  it("对话花的钱跨轮累计", async () => {
    const s = makeSession();
    s.state["_chat_usd"] = 0.03;
    const deps = makeDeps({ turn: fakeTurn({ usd: 0.05 }) });
    await reason(s, deps, "问");
    expect(s.state["_chat_usd"]).toBeCloseTo(0.08, 10);
  });

  it("被闸门拦下的高危动作**全部**留下来，不是只留第一个", async () => {
    const s = makeSession();
    const deps = makeDeps({
      makeAgent: () => ({
        run: async (_t, o) => {
          const ctx = o.ctx as { pending: { tool: string; args: Record<string, unknown> }[] };
          ctx.pending.push({ tool: "oir.add", args: {} }, { tool: "flow.edit", args: {} });
          return fakeTurn();
        },
      }),
    });
    await reason(s, deps, "改两处");
    expect(s.state["_pending_actions"]).toHaveLength(2);
    expect((s.state["_pending_action"] as Record<string, unknown>)["tool"]).toBe("oir.add");
  });
});

// ══════════════════════════════════════════════════════════════════
//  /chat 的 HTTP 契约
// ══════════════════════════════════════════════════════════════════

describe("chatRoute", () => {
  it("抢不到聊天租约 → 409，文案逐字", async () => {
    const s = makeSession();
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ claimChatLease: async () => false }),
    });
    await expect(chatRoute("s1", { text: "hi" }, deps)).rejects.toMatchObject({
      status: 409,
      message: "这个会话已有一轮对话正在处理，请等它结束或先停止。",
    });
  });

  it("空话 → 400「说点什么」", async () => {
    const s = makeSession();
    s.state["mode"] = "chat"; // 走无 mutation 租约那条，隔离掉别的
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
    });
    await expect(chatRoute("s1", { text: "   " }, deps)).rejects.toMatchObject({
      status: 400,
      message: "说点什么",
    });
  });

  it("租约在 finally 里一定归还，哪怕这轮抛了", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const released: string[] = [];
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () =>
        makeRepo({
          getSession: async () => row(s),
          releaseChatLease: async (_sid, o) => {
            released.push(o.owner);
            return true;
          },
        }),
    });
    await expect(chatRoute("s1", { text: "" }, deps)).rejects.toBeTruthy();
    expect(released).toEqual(["worker-test:chat:tok"]);
  });

  it("正常一轮的响应字段名逐字（前端认这些键）", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
      turn: fakeTurn({ answer: "共 3 个对象", citations: ["a.xlsx p1"], followup: "口径谁定" }),
    });
    const out = await chatRoute("s1", { text: "有几个对象" }, deps);
    expect(Object.keys(out).sort()).toEqual(
      ["followups", "intents", "needs_confirm", "reply", "usd"].sort(),
    );
    expect(out["reply"]).toBe("共 3 个对象\n\n依据：◧ a.xlsx p1\n\n（我不确定的一点：口径谁定）");
    expect(out["needs_confirm"]).toBe(false);
  });

  it("回答为空时兜一句「收到。」，不返回空串", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
      turn: fakeTurn({ answer: "" }),
    });
    expect((await chatRoute("s1", { text: "嗯" }, deps))["reply"]).toBe("收到。");
  });

  it("确认门挡下的那一轮 needs_confirm=true —— 靠拒绝语的子串", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
      turn: fakeTurn({ steps: [{ observation: "oir.add 会改变产物…要用户确认后才能执行。" }] }),
    });
    expect((await chatRoute("s1", { text: "加个对象" }, deps))["needs_confirm"]).toBe(true);
  });

  it("lang=en 时会话语言切成 en", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
    });
    await chatRoute("s1", { text: "hi", lang: "en-US" }, deps);
    expect(s.lang).toBe("en");
  });
});

describe("确认后的重放", () => {
  it("直接重放，不重新推理；逐个回执；重放完清空 pending", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    s.state["suggestions"] = [{ id: "a", title: "甲" }, { id: "b", title: "乙" }];
    s.state["_pending_actions"] = [
      { tool: "suggestion.apply", args: { index: 1, accept: false } },
      { tool: "suggestion.apply", args: { index: 9, accept: false } },
    ];
    let reasoned = false;
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
      makeAgent: () => ({
        run: async () => {
          reasoned = true;
          return fakeTurn();
        },
      }),
    });
    const out = await chatRoute("s1", { text: "确认", confirm: true }, deps);
    expect(reasoned).toBe(false);
    expect(out["replayed"]).toBe(true);
    expect(out["needs_confirm"]).toBe(false);
    // 两件事都要说，不能只报第一件
    expect(String(out["reply"])).toBe("措辞后的话\n\n没执行成功：没有第 9 条建议，现在共 2 条");
    expect(s.state["_pending_actions"]).toEqual([]);
    expect(s.state["_pending_action"]).toBeNull();
  });

  it("旧形态的单个 _pending_action 也能重放", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    s.state["_pending_action"] = { tool: "suggestion.apply", args: { index: 1, accept: false } };
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
    });
    const out = await chatRoute("s1", { text: "确认", confirm: true }, deps);
    expect(out["replayed"]).toBe(true);
  });

  it("没有 pending 时 confirm 照常走推理，不走重放", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
    });
    const out = await chatRoute("s1", { text: "确认", confirm: true }, deps);
    expect(out["replayed"]).toBeUndefined();
    expect(out["intents"]).toBeTruthy();
  });
});

describe("停止", () => {
  it("用户点停止 → (已停止) + stopped:true，并落一轮助手发言", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s) }),
      makeAgent: () => ({
        run: async () => {
          // 模拟一轮转很久的推理：由 /stop 打断
          s.chatTask?.abort();
          await new Promise((r) => setTimeout(r, 50));
          return fakeTurn();
        },
      }),
    });
    const out = await chatRoute("s1", { text: "跑一下" }, deps);
    expect(out).toMatchObject({ reply: "（已停止）", stopped: true, needs_confirm: false });
    const kinds = s.events.map((e) => (e as Record<string, unknown>)["kind"]);
    expect(kinds.filter((k) => k === "chat.turn")).toHaveLength(2); // 用户 + （已停止）
  });

  it("聊天租约丢了 → 不追加陈旧轮次、不落库，只回一个纯函数算出来的提示", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    let persisted = 0;
    const deps = makeDeps({
      sessAsync: async () => s,
      chatHeartbeatInterval: 0.01,
      persist: async () => {
        persisted += 1;
      },
      getRepo: () =>
        makeRepo({
          getSession: async () => row(s),
          renewChatLease: async () => false, // 心跳续不上 = 别人抢走了
        }),
      makeAgent: () => ({
        run: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return fakeTurn();
        },
      }),
    });
    const out = await chatRoute("s1", { text: "跑一下" }, deps);
    expect(out).toMatchObject({ reply: "（已停止）", stopped: true });
    expect(out["followups"]).toEqual([{ text: "启发式" }]);
    expect(persisted).toBe(0);
    // 只有用户那一轮，没有陈旧的「（已停止）」助手轮次
    const turns = s.events.filter((e) => (e as Record<string, unknown>)["kind"] === "chat.turn");
    expect(turns).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  投影刷新与 mutation 租约
// ══════════════════════════════════════════════════════════════════

function row(s: SessionLike, over: Record<string, unknown> = {}) {
  return {
    id: s.id,
    title: s.title,
    project: s.project,
    project_id: s.projectId,
    status: s.status,
    error: s.error,
    created: s.created,
    state_version: s.stateVersion,
    owner: s.owner,
    ...over,
  } as never;
}

describe("withSessionMutation", () => {
  it("抢不到 mutation 租约 → 409", async () => {
    const s = makeSession();
    const deps = makeDeps({ getRepo: () => makeRepo({ claimMutationLease: async () => false }) });
    await expect(
      withSessionMutation(s, deps, "chat.structural", {}, async () => 1),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("body 抛错时把租约里那份快照原样恢复（活对象也要恢复，不能只浅拷贝）", async () => {
    const s = makeSession();
    const oir = new OIR();
    s.state["_oir"] = oir;
    s.state["plain"] = { a: 1 };
    const deps = makeDeps({ getRepo: () => makeRepo({ getSession: async () => row(s) }) });
    await expect(
      withSessionMutation(s, deps, "chat.structural", {}, async () => {
        // 就地改活对象 + 改普通字段：两者都必须被回滚
        (s.state["plain"] as Record<string, number>)["a"] = 99;
        s.state["新加的"] = true;
        throw new Error("守卫拒绝");
      }),
    ).rejects.toThrow("守卫拒绝");
    expect((s.state["plain"] as Record<string, number>)["a"]).toBe(1);
    expect(s.state["新加的"]).toBeUndefined();
    // 深拷贝要保住原型，否则恢复回去的 OIR 连 stats() 都不是函数
    expect(s.state["_oir"]).toBeInstanceOf(OIR);
  });

  it("state_version 前进了说明别人已经提交，以库为准而不是回滚", async () => {
    const s = makeSession();
    let calls = 0;
    const deps = makeDeps({
      getRepo: () =>
        makeRepo({
          // 第一次（claim 后刷新）拿到同版本；出错后再查已经前进 —— 说明
          // 有一步 durable saga 提交了，这时候回滚就是把别人提交的 Decision 抹掉。
          getSession: async () => row(s, { state_version: calls++ === 0 ? 0 : 7 }),
          loadState: async () => ({}),
        }),
    });
    await expect(
      withSessionMutation(s, deps, "chat.structural", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // 走的是 hydrate 分支：stateVersion 被置 -1 后重新拉库
    expect(s.stateVersion).toBe(7);
  });

  it("租约总要归还", async () => {
    const s = makeSession();
    const released: string[] = [];
    const deps = makeDeps({
      getRepo: () =>
        makeRepo({
          getSession: async () => row(s),
          releaseMutationLease: async (_sid, o) => {
            released.push(o.owner);
            return true;
          },
        }),
    });
    await withSessionMutation(s, deps, "chat.structural", { chatOwner: "own-1" }, async () => 1);
    expect(released).toEqual(["own-1"]);
    expect(s.mutationLeaseOwner).toBe(""); // 归还后不留在会话上
  });
});

describe("refreshChatProjection（经 chatRoute 观察）", () => {
  it("版本没变的快路上也要把标题接过来 —— 改名不推进 state_version", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => row(s, { title: "客户改的名字" }) }),
    });
    await chatRoute("s1", { text: "hi" }, deps);
    expect(s.title).toBe("客户改的名字");
  });

  it("会话没了 → 404", async () => {
    const s = makeSession();
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () => makeRepo({ getSession: async () => null }),
    });
    await expect(chatRoute("s1", { text: "hi" }, deps)).rejects.toMatchObject({
      status: 404,
      message: "没有会话 s1",
    });
  });

  it("库里的 OIR 文档坏了 → 409，而不是带着半个产物继续这一轮", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    const deps = makeDeps({
      sessAsync: async () => s,
      getRepo: () =>
        makeRepo({
          getSession: async () => row(s, { state_version: 3 }),
          loadState: async () => ({ oir: { objects: [{ 没有必填字段: 1 }] } }),
        }),
    });
    await expect(chatRoute("s1", { text: "hi" }, deps)).rejects.toMatchObject({ status: 409 });
  });
});

describe("reconcileOnBoot", () => {
  it("只回收状态还停在跑步中的那些", async () => {
    const reaped: string[] = [];
    const deps = makeDeps({
      getRepo: () =>
        makeRepo({
          listSessions: async () =>
            [
              { id: "a", status: "parsing" },
              { id: "b", status: "done" },
              { id: "c", status: "queued" },
              { id: "d", status: "extracting" },
            ] as never,
          reapExpiredBuildLease: async (sid, o) => {
            reaped.push(sid);
            expect(o.error).toContain("不重复花钱");
            return true;
          },
        }),
    });
    await reconcileOnBoot(deps);
    expect(reaped).toEqual(["a", "c", "d"]);
  });

  it("对账失败不该挡住启动", async () => {
    const deps = makeDeps({
      getRepo: () =>
        makeRepo({
          listSessions: async () => {
            throw new Error("db down");
          },
        }),
    });
    await expect(reconcileOnBoot(deps)).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  改产物的工具：真的改了，而且说清改了什么
// ══════════════════════════════════════════════════════════════════

describe("改产物的工具", () => {
  it("oir.add 落地后写 oir.json、记一条 CORRECTION、发两条事件", async () => {
    const s = makeSession();
    s.state["_oir"] = new OIR();
    const out = await callTool(s, makeDeps(), "oir.add", {
      op: "add_object_type",
      api_name: "PurchaseOrder",
      display_name: "采购单",
    });
    expect(String(out["已改"])).toContain("采购单");
    expect(JSON.parse(readFileSync(join(s.dir, "oir.json"), "utf8"))["objects"]).toHaveLength(1);
    const kinds = s.events.map((e) => (e as Record<string, unknown>)["kind"]);
    expect(kinds).toEqual(["oir.edited", "human.recorded"]);
    expect(dialogueOf(s).activeDecisions().map((d) => d.kind)).toEqual(["correction"]);
    expect((s.state["_oir_patch_log"] as unknown[]).length).toBe(1);
  });

  it("oir 编辑被拒时版本栈与补丁日志都要弹回去", async () => {
    const s = makeSession();
    s.state["_oir"] = new OIR();
    const out = await callTool(s, makeDeps(), "oir.edit", { op: "set_status", target: "没这个" });
    expect(out["改动"]).toBe("无（这次编辑没做）");
    expect(s.state["_oir_versions"]).toEqual([]);
    expect(s.state["_oir_patch_log"]).toEqual([]);
  });

  it("oir.undo 回到上一版并把补丁日志的尾一起弹", async () => {
    const s = makeSession();
    s.state["_oir"] = new OIR();
    await callTool(s, makeDeps(), "oir.add", { op: "add_object_type", api_name: "A" });
    const out = await callTool(s, makeDeps(), "oir.undo");
    expect(out["已撤销"]).toBe(true);
    expect((s.state["_oir"] as OIR).objects.size).toBe(0);
    expect(s.state["_oir_patch_log"]).toEqual([]);
  });

  it("decision.record：quote 找不到时只在本会话生效", async () => {
    const s = makeSession();
    s.projectId = "p1";
    dialogueOf(s).say(Speaker.USER, "口径就按财务口径来");
    const ok = await callTool(s, makeDeps(), "decision.record", {
      kind: "caliber",
      statement: "按财务口径",
      quote: "口径就按财务口径来",
    });
    expect(String(ok["生效范围"])).toContain("同项目的其它会话也会看到");
    expect(ok["只在本会话生效"]).toBeUndefined();

    const bad = await callTool(s, makeDeps(), "decision.record", {
      kind: "caliber",
      statement: "编的",
      quote: "他从来没说过这句",
    });
    expect(String(bad["只在本会话生效"])).toContain("跨项目生效的约定必须指得出他说的是哪句");
  });

  it("flow.edit 被守卫拒绝时回滚版本与补丁日志", async () => {
    const s = makeSession();
    s.state["_flow"] = new FlowGraph();
    const { FlowEditError } = await import("../src/server/dialogue/ports.js");
    const deps = makeDeps({
      applyFlowEdit: () => {
        throw new FlowEditError("没有节点「X」。");
      },
    });
    const out = await callTool(s, deps, "flow.edit", { op: "rename_node", node: "X" });
    expect(out).toEqual({ error: "没有节点「X」。", 改动: "无（这次编辑没做）" });
    expect(s.state["_flow_versions"]).toEqual([]);
    expect(s.state["_flow_patch_log"]).toEqual([]);
  });

  it("template.edit：守卫拒绝的原文原样转述，并回滚", async () => {
    const s = makeSession();
    writeFileSync(
      join(s.dir, "template.spec.json"),
      JSON.stringify({ round: 1, sheets: [{ name: "对象", guide: "", columns: ["名"], rows: [] }] }),
      "utf8",
    );
    const out = await callTool(s, makeDeps(), "template.edit", {
      op: "drop_column",
      sheet: "对象",
      column: "名",
    });
    expect(String(out["error"])).toContain("只剩这一列了");
    expect(out["改动"]).toBe("无（守卫拒绝了这次编辑）");
    expect(s.state["_tpl_versions"]).toEqual([]);
    expect(s.state["_tpl_patch_log"]).toEqual([]);
  });

  it("question.answer 把幂等键按轮次+问题+答案指纹生成", async () => {
    const s = makeSession();
    let seen: Record<string, unknown> = {};
    const deps = makeDeps({
      answerDomainQuestion: async (_s, _q, b) => {
        seen = b;
        return { decision: { id: "d9" }, created: true, pending: null, status: "answered" };
      },
    });
    const reg = converseTools(s, deps);
    const out = (await reg.call(
      "question.answer",
      { question_id: "q1", answer: "是" },
      { approved: true, pending: [], turnId: "turn-7" } as never,
      { scope: "converse" },
    )) as Record<string, unknown>;
    expect(out["已记录"]).toBe("d9");
    expect(String(seen["idempotencyKey"])).toMatch(/^chat:turn-7:q1:[0-9a-f]{12}$/);
    // option_id 空串要变成 null，不是空串
    expect(seen["option_id"]).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  杂项
// ══════════════════════════════════════════════════════════════════

describe("isBusy", () => {
  it("只有这三种算在跑", () => {
    for (const st of ["queued", "parsing", "extracting"]) {
      expect(isBusy(makeSession({ status: st }))).toBe(true);
    }
    for (const st of ["idle", "done", "failed", "stopped", "awaiting_answer"]) {
      expect(isBusy(makeSession({ status: st }))).toBe(false);
    }
  });
});

describe("parserFor", () => {
  it("问题/建议的序号映射来自当前状态，不写死", () => {
    const s = makeSession();
    s.state["questions"] = [{ conflict_rid: "c1" }, { conflict_rid: "c2" }];
    s.state["suggestions"] = [{ id: "sg1" }];
    let got: Record<string, string[]> = {};
    const deps = makeDeps({
      makeParser: (o) => {
        got = o as unknown as Record<string, string[]>;
        return { parse: () => ({ matches: [], toDict: () => ({}) }) };
      },
    });
    parserFor(s, deps);
    expect(got["questionIds"]).toEqual(["c1", "c2"]);
    expect(got["suggestionIds"]).toEqual(["sg1"]);
  });
});

describe("chatClaimed 的意图提示", () => {
  it("hint 里排掉 UNKNOWN，百分比按 Python 的 .0% 格式", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    let ctxSeen = "";
    const deps = makeDeps({
      makeParser: () => ({
        parse: () => ({
          matches: [
            { intent: "adopt", confidence: 0.855, slots: { index: 3 }, span: "" },
            { intent: "unknown", confidence: 0.1, slots: {}, span: "" },
          ],
          toDict: () => ({}),
        }),
      }),
      makeAgent: () => ({
        run: async (_t, o) => {
          ctxSeen = o.context ?? "";
          return fakeTurn();
        },
      }),
    });
    await chatClaimed(s, deps, { text: "采纳第三条" }, { chatOwner: "o" });
    expect(ctxSeen).toContain('规则层对这句话的初步判断（仅供参考，你可以不同意）：adopt(86%, {"index": 3})');
    expect(ctxSeen).not.toContain("unknown");
  });
});

/** 让 vitest 别把 pipeline 的 RunHandle 类型当没用过（也顺手钉一下形状）。 */
describe("chatTask 的形态", () => {
  it("跑的时候挂上、结束时清掉", async () => {
    const s = makeSession();
    s.state["mode"] = "chat";
    let handleDuring: RunHandle | null = null;
    const deps = makeDeps({
      makeAgent: () => ({
        run: async () => {
          handleDuring = s.chatTask;
          return fakeTurn();
        },
      }),
    });
    await chatClaimed(s, deps, { text: "x" }, { chatOwner: "o" });
    expect(handleDuring).not.toBeNull();
    expect(s.chatTask).toBeNull();
  });
});

/** `PipelineSessionLike` 只是用来确认我这份 SessionLike 是它的超集。 */
const _typeCheck: PipelineSessionLike = makeSession();
void _typeCheck;
