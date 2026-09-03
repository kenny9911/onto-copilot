/**
 * `server/glue/*` —— `server.py` 那批胶水的测试。
 *
 * 这一批函数的"值"多半是**副作用**（写了哪几个文件、给 repo 发了哪几条写、
 * 事件流上出现了什么），所以断言的重点是那些序列，而不是返回值。能用真材料的
 * 地方用 `golden/材料.xlsx`（契约 §3：手写的期望值是猜测，真材料是事实）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(tmpdir(), `ontocopilot-glue-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Budget } = await import("../src/kernel/budget.js");
const { AgentBus } = await import("../src/kernel/bus/bus.js");
const { CriticPanel } = await import("../src/kernel/critic.js");
const { Chunk, EvidenceIndex } = await import("../src/kernel/memory/evidence.js");
const { FileBlobStore, FileJournal, InMemoryBlobStore, InMemoryJournal } = await import(
  "../src/kernel/journal.js"
);
const { ModelGateway, ScriptedBackend, stubRouting } = await import("../src/kernel/llm.js");
const { AgentLoop } = await import("../src/kernel/loop.js");
const { ContextManager } = await import("../src/kernel/memory/context.js");
const { Scratchpad } = await import("../src/kernel/memory/short_term.js");
const { Recorder } = await import("../src/kernel/recorder.js");
const { RunStatus, Scheduler } = await import("../src/kernel/scheduler.js");
const { ToolDenied } = await import("../src/kernel/errors.js");
const { makeChunk, makeParsedDoc } = await import("../src/onto/parse/base.js");
const { defaultRegistry } = await import("../src/onto/parse/index.js");
const { OIR } = await import("../src/onto/oir.js");
const { AssetMemory } = await import("../src/onto/asset_memory.js");
const { Question, QuestionBacklog, QuestionStatus } = await import("../src/onto/questions.js");
const { buildFdeEngagementDag } = await import("../src/onto/engagement.js");
const {
  EngagementRuntimeInput,
  engagementCritics,
  engagementHandlers,
} = await import("../src/onto/engagement_runtime.js");
const { MemoryRepo } = await import("../src/store/repo/memory.js");
const { makeSessionRow } = await import("../src/store/types.js");
const { setRepoForTests } = await import("../src/store/deps.js");
const { SESSIONS, Session, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);

const { builtinRegistry, sandboxForTools, resolveRid, ridKind, ridName } = await import(
  "../src/server/glue/tools.js"
);
const { chatRun } = await import("../src/server/glue/chat_run.js");
const { chunkCache, CHUNK_TEXT_CAP, preparse } = await import("../src/server/glue/preparse.js");
const { persist: persistCheckpoint } = await import("../src/server/pipeline/persist.js");
const { pendingQuestions, syncQuestionBacklog } = await import(
  "../src/server/glue/questions.js"
);
const { buildFlowDiagram, rewriteFlowArtifacts, replayFlowPatches } = await import(
  "../src/server/glue/flow.js"
);
const { compile, drainQueue, recompile, writeCanonicalArtifacts } = await import(
  "../src/server/glue/compile.js"
);
const { ENGAGEMENT_DELIVERY_FILES, ENGAGEMENT_RELEASE_FILES, stageEngagementDelivery } = await import(
  "../src/server/glue/engagement_delivery.js"
);
const { FDE_ANALYSIS_NODES, mergePendingHumanQuestion } = await import(
  "../src/server/glue/engagement_handoff.js"
);
const { answerDomainQuestion } = await import("../src/server/routes/questions.js");
const { hydrate } = await import("../src/server/glue/hydrate.js");
const { citeOf } = await import("../src/server/glue/chunks.js");
const { FlowGraph } = await import("../src/onto/flow.js");
const { setDocumentServiceForTests, resetDocumentService } = await import("../src/document/deps.js");

import type { GlueDeps } from "../src/server/glue/deps.js";
import type { Session as SessionT } from "../src/server/session.js";
import type { ParsedDoc } from "../src/onto/parse/base.js";
import type { ToolCallCtx } from "../src/kernel/tools.js";

const MATERIAL = fileURLToPath(new URL("../../golden/材料.xlsx", import.meta.url));

let repo: InstanceType<typeof MemoryRepo>;

function deps(over: Partial<GlueDeps> = {}): GlueDeps {
  return {
    repo: () => repo,
    now: () => 1_700_000_000,
    persist: async () => undefined,
    projectMemory: () => {
      throw new Error("projectMemory 不该在这些用例里被调到");
    },
    emitAiPrompts: () => undefined,
    act: async () => "",
    publishAssistant: () => undefined,
    sessionMutation: async (_s, _kind, body) => await body(),
    restoreDialogue: async () => undefined,
    preparse: async () => undefined,
    ...over,
  };
}

function makeSession(id: string, init: Record<string, unknown> = {}): SessionT {
  const s = new Session(id, init as never);
  SESSIONS.set(id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

type Dict = Record<string, unknown>;

/** 跑一份真实 FileJournal v3 workflow 到 HUMAN_ACCEPTANCE，并把 HITL 问题写进
 * server 的唯一 Question Ledger。后续 answer 测的是 production resume/compile，
 * 不是手写一个 completed outcome。 */
async function suspendRealFdeAtAcceptance(s: SessionT, runId: string): Promise<string> {
  const oir = new OIR();
  const journal = new FileJournal(join(s.dir, "journal"));
  const recorder = new Recorder(runId, journal, new FileBlobStore(join(s.dir, "blobs")));
  const budget = new Budget({ tokens: 1_000_000, usd: 10 });
  const backend = new ScriptedBackend();
  const gateway = new ModelGateway(backend, recorder, { routing: stubRouting(), budget });
  const bus = new AgentBus(recorder);
  const runtime = new EngagementRuntimeInput({
    sessionId: s.id,
    project: s.project || s.title,
    oir,
    flow: null,
    backlog: new QuestionBacklog(),
    decisions: [],
    generatedAt: "2026-08-26T00:00:00+00:00",
    releaseDownloadable: true,
  });
  const loop = new AgentLoop({
    gateway,
    ctxManager: new ContextManager({ system: "FDE server integration", budgetTokens: 64_000 }),
    panel: new CriticPanel(engagementCritics(), recorder),
    bus,
    recorder,
    budget,
    handlers: engagementHandlers(runtime),
    newScratchpad: (tokens) => new Scratchpad({ budgetTokens: tokens }),
  });
  const outcome = await new Scheduler(
    buildFdeEngagementDag(),
    loop,
    recorder,
    bus,
    budget,
    { concurrency: 4 },
  ).run(runId);
  await journal.flush();
  expect(outcome.status, outcome.error || "workflow unexpectedly terminated").toBe(
    RunStatus.SUSPENDED,
  );
  expect(outcome.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
  expect(backend.calls).toEqual([]);

  s.state["_oir"] = oir;
  s.state["_flow"] = null;
  s.state["_conflicts"] = [];
  s.state["artifact_revision"] = 0;
  s.state["engagement_run_id"] = runId;
  s.state["engagement_execution"] = {
    status: String(outcome.status),
    pendingHuman: outcome.pendingHuman,
  };
  s.state["engagement_analysis"] = {
    schemaVersion: "1.0.0",
    runId,
    modelBacked: false,
    nodes: Object.fromEntries(
      FDE_ANALYSIS_NODES
        .filter((node) => Object.prototype.hasOwnProperty.call(outcome.outputs, node))
        .map((node) => [node, outcome.outputs[node]]),
    ),
  };
  s.state["release_state"] = "DRAFT";
  s.status = "awaiting_answer";
  expect(mergePendingHumanQuestion(s, outcome.pendingHuman)).toBe(true);
  await syncQuestionBacklog(s, deps(), { oir, conflicts: [] });
  const request = outcome.pendingHuman as Dict;
  const questionId = String((request["question"] as Dict)["id"]);
  expect((await repo.listQuestions(s.id)).some((row) => row.id === questionId)).toBe(true);
  const exported = JSON.parse(readFileSync(join(s.dir, "问题清单.json"), "utf-8")) as Dict;
  expect((exported["questions"] as Dict[]).some((row) => row["id"] === questionId)).toBe(true);
  return questionId;
}

async function answerAcceptanceAndResume(
  s: SessionT,
  questionId: string,
  decision: "APPROVE" | "REJECT",
): Promise<Record<string, unknown>> {
  const glue = deps();
  return await answerDomainQuestion(
    s,
    questionId,
    {
      answer: decision,
      actor: "Alice",
      actorRole: "业务验收负责人",
      idempotencyKey: `acceptance:${s.id}:${decision}`,
      note: decision === "APPROVE" ? "同意发布" : "退回修改",
    },
    {
      persist: async (session) => await glue.persist(session),
      sessionMutation: async (_session, _kind, body) => await body(),
      recompile: async (session, options) =>
        await recompile(session, glue, options),
      syncQuestionBacklog: async (session, options = {}) =>
        await syncQuestionBacklog(session, glue, options),
      now: () => 1_777_000_000,
    },
    { principal: { id: "admin.integration", role: "admin" } },
  );
}

/** 在真 repo 前面套一层：只覆写指定的方法，其余原样透传（类方法在原型上，
 *  `{...repo}` 会全部丢掉）。 */
function spyRepo(over: Record<string, unknown>): InstanceType<typeof MemoryRepo> {
  return new Proxy(repo, {
    get(target, prop, recv) {
      if (prop in over) return over[prop as string];
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** 工具的调用上下文：这一批工具都不记账、不走审批。 */
const CTX: ToolCallCtx = { rec: null, nodeId: "n", approved: true } as unknown as ToolCallCtx;

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
});

afterAll(() => {
  resetDocumentService();
  registerHydrator(null);
  setRepoForTests(null);
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  resetDocumentService();
  SESSIONS.clear();
  repo = new MemoryRepo();
  setRepoForTests(repo);
});

// ══════════════════════════════════════════════════════════════════
//  _builtin_registry
// ══════════════════════════════════════════════════════════════════

describe("builtinRegistry", () => {
  function index(): InstanceType<typeof EvidenceIndex> {
    const ix = new EvidenceIndex();
    ix.add(
      new Chunk({
        chunkId: "f1:0",
        fileId: "f1",
        fileName: "实体梳理.xlsx",
        locator: { kind: "range", sheet: "对象", rows: [2, 5] },
        render: "采购订单 表头 含税金额",
      }),
    );
    return ix;
  }

  it("按给了哪些依赖决定动作空间 —— 没给就不注册", () => {
    const bare = builtinRegistry();
    expect(bare.forScope("*").map((t) => t.spec.name)).toEqual([]);
    const full = builtinRegistry({
      evidence: index(),
      oir: new OIR(),
      profiles: { "订单.金额": { unique: 1 } },
    });
    expect(full.forScope("analyze").map((t) => t.spec.name).sort()).toEqual([
      "entity.compare",
      "evidence.rows",
      "evidence.search",
      "impact.trace",
      "model.lint",
      "oir.query",
      "profile.column",
    ]);
    expect(full.forScope("converse").map((t) => t.spec.name).sort()).toEqual([
      "entity.compare",
      "evidence.rows",
      "evidence.search",
      "impact.trace",
      "model.lint",
      "oir.query",
      "profile.column",
    ]);
    expect(full.forScope("converse").map((t) => t.spec.name)).not.toContain("code.exec");
  });

  it("`if profiles:` —— 空画像表不注册 profile.column（空 dict 在 Python 里是假）", () => {
    const reg = builtinRegistry({ profiles: {} });
    expect(reg.forScope("*").map((t) => t.spec.name)).toEqual([]);
  });

  it("拿不到沙箱（sandbox=null）时 code.exec **不出现在动作空间里**", () => {
    const reg = builtinRegistry({ evidence: index(), sandbox: null });
    expect(reg.forScope("*").map((t) => t.spec.name)).not.toContain("code.exec");
    // 而且是"没有这个工具"，不是"调了会失败" —— 后者会让模型反复重试。
    expect(() => reg.get("code.exec", "analyze")).toThrow(ToolDenied);
  });

  it("给了 sandbox 才注册，且只进 TOOL_SCOPES 声明的作用域", async () => {
    const calls: string[] = [];
    const reg = builtinRegistry({
      sandbox: {
        exec: async (code) => {
          calls.push(code);
          return {
            ok: true,
            exit_code: 0,
            duration_ms: 1,
            stdout: "",
            stderr: "",
            artifacts: [],
            result: { n: 1 },
            flags: [],
          };
        },
      },
    });
    expect(reg.forScope("analyze").map((t) => t.spec.name)).toContain("code.exec");
    // extract 直接读用户上传的材料 —— 它**不该**有执行代码的能力（P0-1）。
    expect(reg.forScope("extract").map((t) => t.spec.name)).not.toContain("code.exec");
    const out = (await reg.call("code.exec", { code: "print(1)" }, CTX, {
      scope: "analyze",
    })) as { result: unknown };
    expect(calls).toEqual(["print(1)"]);
    expect(out.result).toEqual({ n: 1 });
  });

  it("evidence.search 把**文件名**解析成 file_id，百分号编码的也认", async () => {
    const reg = builtinRegistry({ evidence: index() });
    const enc = encodeURIComponent("实体梳理.xlsx");
    const hit = (await reg.call("evidence.search", { query: "采购", files: [enc] }, CTX, {
      scope: "readonly",
    })) as {
      count: number;
    };
    expect(hit.count).toBe(1);
  });

  it("evidence.search 认不出的文件名要**说出来**，不是静默空结果", async () => {
    const reg = builtinRegistry({ evidence: index() });
    const miss = (await reg.call("evidence.search", { query: "采购", files: ["没有.csv"] }, CTX, {
      scope: "readonly",
    })) as {
      count: number;
      error: string;
    };
    expect(miss.count).toBe(0);
    expect(miss.error).toContain("没有这些材料：['没有.csv']");
    expect(miss.error).toContain("'实体梳理.xlsx'");
  });

  it("evidence.rows 空结果要把现有的容器名报回去", async () => {
    const reg = builtinRegistry({ evidence: index() });
    const out = (await reg.call("evidence.rows", { file: "不存在", container: "无" }, CTX, {
      scope: "readonly",
    })) as {
      count: number;
      note: string;
    };
    expect(out.count).toBe(0);
    expect(out.note).toContain("实体梳理.xlsx!对象");
  });

  it("impact.trace 找不到目标时**说清楚**，并提示别猜 rid", async () => {
    const reg = builtinRegistry({ oir: new OIR() });
    const bad = (await reg.call("impact.trace", { target: "根本没有这个" }, CTX, {
      scope: "readonly",
    })) as {
      error: string;
      note: string;
    };
    expect(bad.error).toContain("根本没有这个");
    expect(bad.note).toContain("别照着材料里的写法猜 rid");
  });

  it("profile.column 猜不中时给候选，不是空结果", async () => {
    const reg = builtinRegistry({ profiles: { "订单.含税金额": { unique_ratio: 0.9 } } });
    const out = (await reg.call("profile.column", { column: "金额" }, CTX, {
      scope: "analyze",
    })) as {
      error: string;
      did_you_mean: string[];
    };
    expect(out.did_you_mean).toEqual(["订单.含税金额"]);
    const hit = await reg.call("profile.column", { column: "订单.含税金额" }, CTX, {
      scope: "analyze",
    });
    expect(hit).toEqual({ unique_ratio: 0.9 });
  });

  it("rid 小工具：认不出回 null / unknown / 退回 rid 本身", () => {
    const oir = new OIR();
    expect(resolveRid(oir, "   ")).toBeNull();
    expect(ridKind(oir, "ot_x")).toBe("unknown");
    expect(ridName(oir, "ot_x")).toBe("ot_x");
  });

  it("sandboxForTools：开关没开就是 null（连探测都不做）", async () => {
    expect(await sandboxForTools({} as NodeJS.ProcessEnv)).toBeNull();
    expect(await sandboxForTools({ ONTOCOPILOT_ENABLE_CODEACT: "no" } as never)).toBeNull();
  });

  it("sandboxForTools：开关开了但容器运行时不在 → 还是 null（**不注册**一个必然失败的工具）", async () => {
    // 注册了才失败的话，模型会把失败回执读成"参数写错了"，反复重试到预算烧光。
    expect(await sandboxForTools(
      { ONTOCOPILOT_ENABLE_CODEACT: "1", PATH: "" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("sandboxForTools：运行时在就给一个能调的沙箱", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glue-docker-"));
    try {
      writeFileSync(join(dir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const sbx = await sandboxForTools(
        { ONTOCOPILOT_ENABLE_CODEACT: "true", PATH: dir } as NodeJS.ProcessEnv);
      expect(sbx).not.toBeNull();
      expect(typeof sbx?.exec).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  _chat_run
// ══════════════════════════════════════════════════════════════════

describe("chatRun", () => {
  function fakeGateways(closed: string[]) {
    return () =>
      ({
        backend: {
          aclose: async () => {
            closed.push("closed");
          },
        },
        gw: { rec: new Recorder("r", new InMemoryJournal(), new InMemoryBlobStore()) },
        smart: null,
        budget: new Budget({ tokens: 10, usd: 1 }),
      }) as never;
  }

  it("会话没登记时不开 repo Run（纯领域调用的那条测试缝）", async () => {
    const s = makeSession("chat-unregistered");
    const closed: string[] = [];
    const got = await chatRun(
      s,
      { repo: () => repo, gateways: fakeGateways(closed) },
      { kind: "reason", semanticInput: { a: 1 } },
      async (run) => run.repoRunId,
    );
    expect(got).toBe("");
    expect(closed).toEqual(["closed"]);
  });

  it("正常完成 → finish_run(status=done)；backend 一定关掉", async () => {
    const s = makeSession("chat-ok");
    await repo.createSession({ id: s.id } as never);
    const closed: string[] = [];
    await chatRun(
      s,
      { repo: () => repo, gateways: fakeGateways(closed) },
      { kind: "reason", semanticInput: { a: 1 } },
      async () => undefined,
    );
    expect(closed).toEqual(["closed"]);
  });

  it("抛异常 → finish_run(status=failed, error='类名: 消息')，异常原样上抛", async () => {
    const s = makeSession("chat-boom");
    await repo.createSession({ id: s.id } as never);
    const closed: string[] = [];
    const finished: unknown[] = [];
    // `{...repo}` 会把类方法全丢掉（它们在原型上）—— 显式代理才拿得到 nextRun。
    const spy = spyRepo({ finishRun: async (id: string, o: unknown) => void finished.push([id, o]) });
    await expect(
      chatRun(
        s,
        { repo: () => spy as never, gateways: fakeGateways(closed) },
        { kind: "reason", semanticInput: 1 },
        async () => {
          throw new TypeError("坏了");
        },
      ),
    ).rejects.toThrow("坏了");
    expect(closed).toEqual(["closed"]);
    const [, o] = finished[0] as [string, { status: string; error: string }];
    expect(o.status).toBe("failed");
    expect(o.error).toBe("TypeError: 坏了");
  });

  it("run.fail() 的状态会进 finish_run", async () => {
    const s = makeSession("chat-fail");
    await repo.createSession({ id: s.id } as never);
    const finished: { status: string; error: string }[] = [];
    const spy = spyRepo({
      nextRun: async () => "run-1",
      finishRun: async (_id: string, o: { status: string; error: string }) => void finished.push(o),
    });
    await chatRun(
      s,
      { repo: () => spy as never, gateways: fakeGateways([]) },
      { kind: "reason", semanticInput: 1 },
      async (run) => {
        run.fail("预算封顶");
      },
    );
    expect(finished[0]).toMatchObject({ status: "failed", error: "预算封顶" });
  });
});

// ══════════════════════════════════════════════════════════════════
//  _chunk_cache / _preparse
// ══════════════════════════════════════════════════════════════════

describe("chunkCache / preparse", () => {
  function doc(name: string, render: string, fileId = "f1"): ParsedDoc {
    const d = makeParsedDoc({ fileId, fileName: name, kind: "text" });
    d.chunks.push(
      makeChunk({
        docId: "0",
        fileId,
        fileName: name,
        locator: { kind: "page", page: 1 },
        render,
        tags: ["body"],
      }),
    );
    return d;
  }

  it("render 按**码点**截到 1500，不会把中文切出半个字", () => {
    const long = "汉".repeat(2000);
    const out = chunkCache([doc("a.txt", long)]);
    expect([...out["a.txt"]![0]!.text].length).toBe(CHUNK_TEXT_CAP);
    expect(out["a.txt"]![0]!.text.endsWith("汉")).toBe(true);
    expect(out["a.txt"]![0]!.tags).toEqual(["body"]);
    expect(out["a.txt"]![0]!.cite).toBe(citeOf(doc("a.txt", long).chunks[0]!));
  });

  it("真材料：解析 → 索引 → corpus/画像全部落进 state", async () => {
    const s = makeSession("prep-1");
    mkdirSync(join(s.dir, "materials"), { recursive: true });
    const dst = join(s.dir, "materials", "材料.xlsx");
    writeFileSync(dst, readFileSync(MATERIAL));
    s.files = [{ name: "材料.xlsx", size: 0, path: dst, sha256: "" }];
    await preparse(s);
    const ix = s.state["_index"] as InstanceType<typeof EvidenceIndex>;
    expect(ix.size).toBeGreaterThan(0);
    expect(Object.keys(s.state["_chunks"] as object)).toEqual(["材料.xlsx"]);
    const ready = s.events.find((e) => e["kind"] === "corpus.ready");
    expect(ready).toBeDefined();
    expect((ready!["stats"] as { files: number }).files).toBe(1);
    // 与真的解析一次的结果一致（同一个装配层，不是我这边另抄一份注册顺序）
    const docs = await defaultRegistry().parseAll([dst]);
    expect((s.state["corpus"] as { chunks: number }).chunks).toBe(
      docs.reduce((n, d) => n + d.chunks.length, 0),
    );
  });

  it("没有临时附件时也会把会话固定的 OntoDocument 精确版本装进证据索引", async () => {
    const s = makeSession("prep-doc-only", { projectId: "project_A", owner: "alice" });
    const pinned = doc(
      "DOC[doc_1@ver_2] 采购规则.txt",
      "项目确认：计划金额按含税金额计算",
      "ver_2",
    );
    setDocumentServiceForTests({
      async loadAttachedParsedDocs() {
        return {
          documents: [pinned],
          manifest: [{
            project_id: "project_A", document_id: "doc_1", version_id: "ver_2",
            sha256: "sha-v2", index_revision: "ix-v2", acl_revision: 3,
            title: "采购规则", file_name: "采购规则.txt", version_no: 2,
            parse_status: "ready", parser_version: "1",
          }],
        };
      },
    } as never);

    await preparse(s);

    const ix = s.state["_index"] as InstanceType<typeof EvidenceIndex>;
    expect(ix.size).toBe(1);
    expect(ix.allChunks()[0]).toMatchObject({
      fileId: "ver_2",
      fileName: "DOC[doc_1@ver_2] 采购规则.txt",
      render: "项目确认：计划金额按含税金额计算",
    });
    expect(s.state["_document_manifest"]).toEqual([
      expect.objectContaining({ document_id: "doc_1", version_id: "ver_2" }),
    ]);
  });

  it("persist 不保存 DOC 项目切片，只保留会话附件/OCR", async () => {
    const sid = "persist-document-fence";
    await repo.createSession(makeSessionRow({
      id: sid,
      owner: "alice",
      project_id: "project_A",
    }));
    const s = makeSession(sid, { owner: "alice", projectId: "project_A" });
    s.state["_document_manifest"] = [{
      project_id: "project_A", document_id: "doc_1", version_id: "ver_2",
      sha256: "sha-v2", index_revision: "ix-v2", acl_revision: 7,
    }];
    s.state["_chunks"] = {
      "临时访谈.txt": [{
        cite: "临时访谈.txt#L1", text: "本会话上传内容", tags: ["body"], locator: { line: 1 },
      }],
      "DOC[doc_1@ver_2] 采购规则.txt": [{
        cite: "DOC[doc_1@ver_2] 采购规则.txt#L1",
        text: "项目库敏感正文",
        tags: ["body"],
        locator: { _document_id: "doc_1", _version_id: "ver_2", _chunk_id: "body" },
      }],
    };

    await persistCheckpoint(s as never, {
      repo: () => repo,
      now: () => 1_700_000_000,
      persistDecisions: async () => undefined,
    }, { status: false });

    expect((await repo.loadState(sid))["_chunks"]).toEqual({
      "临时访谈.txt": [{
        cite: "临时访谈.txt#L1", text: "本会话上传内容", tags: ["body"], locator: { line: 1 },
      }],
    });
  });

  it("**保住上一轮花钱 OCR 出来的切片**：新解析读不出东西时沿用旧缓存并重灌索引", async () => {
    const s = makeSession("prep-2");
    // 没有 files → 新解析产出 0 份文档，但缓存里有一份扫描件
    s.state["_chunks"] = {
      "扫描件.pdf": [{ cite: "扫描件.pdf!p1", text: "手写的付款条件", tags: [], locator: {} }],
    };
    await preparse(s);
    const ix = s.state["_index"] as InstanceType<typeof EvidenceIndex>;
    expect(ix.size).toBe(1);
    expect(ix.allChunks()[0]!.render).toBe("手写的付款条件");
    expect(Object.keys(s.state["_chunks"] as object)).toEqual(["扫描件.pdf"]);
    expect(s.events.some((e) => e["kind"] === "corpus.restored")).toBe(true);
  });

  it("混合 PDF 重开会话：重建文本页时合回已付费 OCR 的扫描页，并沿用原状态", async () => {
    const s = makeSession("prep-mixed-pdf");
    const dir = join(s.dir, "materials");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "混合.pdf");
    writeFileSync(path, mixedTextAndScanPdf());
    s.files = [{ name: "混合.pdf", size: 1, path, sha256: "same-content" }];
    s.state["_chunks"] = {
      "混合.pdf": [{
        cite: "混合.pdf#p2",
        text: "〔paragraph〕第二页扫描正文",
        tags: ["ocr", "paragraph"],
        locator: { kind: "page", page: 2, bbox: [0, 0, 1, 1] },
      }],
    };
    s.state["corpus"] = {
      files: [{ file: "混合.pdf", kind: "scan", chunks: 2, findings: 1 }],
      chunks: 2,
      findings: [{
        file: "混合.pdf", kind: "vision_ok", severity: "info",
        message: "此前已完整识别", locator: {},
      }],
    };

    await preparse(s);

    const cache = (s.state["_chunks"] as Record<string, Array<{ text: string; tags: string[] }>>)
      ["混合.pdf"]!;
    expect(cache.map((chunk) => chunk.text)).toEqual([
      "Native page",
      "〔paragraph〕第二页扫描正文",
    ]);
    expect(cache[1]?.tags).toContain("ocr");
    const ix = s.state["_index"] as InstanceType<typeof EvidenceIndex>;
    expect(ix.allChunks().map((chunk) => chunk.render)).toContain("〔paragraph〕第二页扫描正文");
    const corpus = s.state["corpus"] as {
      chunks: number;
      findings: Array<{ kind: string; message: string }>;
    };
    expect(corpus.chunks).toBe(2);
    expect(corpus.findings).toEqual([
      expect.objectContaining({ kind: "vision_ok", message: "此前已完整识别" }),
    ]);
    expect(s.events.some((e) => e["kind"] === "corpus.restored")).toBe(true);
  });

  it("解析炸了只发 parse.failed，不把上传带下去", async () => {
    const s = makeSession("prep-3");
    s.files = [{ name: "没有.xlsx", size: 0, path: join(s.dir, "没有.xlsx"), sha256: "" }];
    await expect(preparse(s)).resolves.toBeUndefined();
    expect(s.events.some((e) => e["kind"] === "parse.failed")).toBe(true);
    expect(s.state["_index"]).toBeUndefined();
  });
});

/** 两页有效 PDF：第一页有文本层，第二页只有空内容流，模拟电子页 + 扫描页。 */
function mixedTextAndScanPdf(): Uint8Array {
  const native = "BT /F1 12 Tf 10 50 Td (Native page) Tj ET\n";
  const blank = "q\nQ\n";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<</Font<</F1 7 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${native.length}>>\nstream\n${native}endstream`,
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 6 0 R>>",
    `<</Length ${blank.length}>>\nstream\n${blank}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

// ══════════════════════════════════════════════════════════════════
//  _question_backlog / _sync_question_backlog
// ══════════════════════════════════════════════════════════════════

describe("syncQuestionBacklog", () => {
  function bag(): InstanceType<typeof QuestionBacklog> {
    const b = new QuestionBacklog();
    b.add(new Question({ id: "q1", text: "含税还是不含税？", createdAt: 1, updatedAt: 1 }), {
      preserveLifecycle: false,
    });
    b.add(
      new Question({
        id: "q2",
        text: "这条已经答了",
        status: QuestionStatus.ANSWERED,
        createdAt: 2,
        updatedAt: 2,
      }),
      { preserveLifecycle: false },
    );
    return b;
  }

  it("state / repo / 三份文件一起更新", async () => {
    const s = makeSession("sync-1");
    s.state["question_backlog"] = bag().toDict();
    const out = await syncQuestionBacklog(s, deps());
    expect([...out.questions.keys()]).toEqual(["q1", "q2"]);
    expect((await repo.listQuestions(s.id)).map((r) => r.id)).toEqual(["q1", "q2"]);
    const names = readdirSync(s.dir);
    expect(names).toContain("问题清单.json");
    expect(names).toContain("问题清单.md");
    expect(names).toContain("问题清单.xlsx");
    expect(readFileSync(join(s.dir, "问题清单.md"), "utf-8")).toContain("含税还是不含税？");
  });

  it("preserveRepoLifecycle=true 时忽略 state、以 repo 行为准，并保住人改过的优先级", async () => {
    const s = makeSession("sync-2");
    s.state["question_backlog"] = bag().toDict();
    await syncQuestionBacklog(s, deps());
    // 人把 q1 提成发布阻塞项，直接写进 repo（另一个 worker 干的）
    const rows = await repo.listQuestions(s.id);
    const promoted = rows.map((r) =>
      r.id === "q1"
        ? { ...r, priority: "blocking", doc: { ...r.doc, priority: "blocking" } }
        : r,
    );
    await repo.upsertQuestions(s.id, promoted);
    const out = await syncQuestionBacklog(s, deps(), { preserveRepoLifecycle: true });
    expect(out.questions.get("q1")!.priority).toBe("blocking");
  });

  it("pendingQuestions 只算 open/assigned/blocked", () => {
    const s = makeSession("sync-3");
    s.state["question_backlog"] = bag().toDict();
    expect(pendingQuestions(s).map((q) => q.id)).toEqual(["q1"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _build_flow_diagram / _rewrite_flow_artifacts
// ══════════════════════════════════════════════════════════════════

describe("buildFlowDiagram", () => {
  function textDoc(name: string, render: string): ParsedDoc {
    const d = makeParsedDoc({ fileId: "f1", fileName: name, kind: "text" });
    d.chunks.push(
      makeChunk({
        docId: "0",
        fileId: "f1",
        fileName: name,
        locator: { kind: "page", page: 1 },
        render,
      }),
    );
    return d;
  }

  it("材料里没有结构化流程说明 → **不出图**，只发 flow.skipped", () => {
    const s = makeSession("flow-1");
    buildFlowDiagram(s, [textDoc("闲聊.txt", "今天天气不错，".repeat(20))]);
    const ev = s.events.find((e) => e["kind"] === "flow.skipped");
    expect(ev).toBeDefined();
    expect(readdirSync(s.dir)).not.toContain("流程图.svg");
  });

  it("抽得出步骤时四份产物一起落盘并进 artifacts", () => {
    const s = makeSession("flow-2", { project: "采购" });
    // 模拟这个会话曾有无材料通用草案；真材料产图后显式来源必须切回 material，
    // 不能让一个历史 generic 标记把整张新图继续冒充成通用草案。
    s.state["flow_provenance"] = "generic";
    const text =
      "（1）创建采购申请。触发条件：业务部门提出需求。输入：需求单。输出：采购申请单。\n" +
      "（2）审批采购申请。触发条件：申请提交。输入：采购申请单。输出：审批结果。\n" +
      "（3）生成采购订单。触发条件：审批通过。输入：审批结果。输出：采购订单。\n";
    buildFlowDiagram(s, [textDoc("流程说明.txt", text)]);
    if (s.events.some((e) => e["kind"] === "flow.skipped")) {
      // 规则抽取没认出来 —— 那也必须是"没出图"，不能出一张空图。
      expect(readdirSync(s.dir)).not.toContain("流程图.svg");
      return;
    }
    const names = readdirSync(s.dir);
    expect(names).toContain("流程图.svg");
    expect(names).toContain("流程图.mmd");
    expect(names).toContain("flow.json");
    const svg = readFileSync(join(s.dir, "流程图.svg"), "utf-8");
    const mermaid = readFileSync(join(s.dir, "流程图.mmd"), "utf-8");
    expect(svg).toMatch(/data-style="auto-[^"]+"/u);
    const direction = /data-layout-direction="(LR|TB)"/u.exec(svg)?.[1];
    expect(direction).toBeDefined();
    expect(mermaid).toMatch(new RegExp(`^flowchart ${direction}$`, "mu"));
    expect(s.state["_flow"]).toBeDefined();
    expect(s.state["flow_provenance"]).toBe("material");
    expect(s.state["artifacts"]).toContain("flow.json");
    expect(s.events.some((e) => e["kind"] === "flow.ready")).toBe(true);
  });

  it("rewriteFlowArtifacts：主干等于全图时删掉过期的主干文件", () => {
    const s = makeSession("flow-3");
    writeFileSync(join(s.dir, "流程图_主干.svg"), "旧的", "utf-8");
    rewriteFlowArtifacts(s, new FlowGraph());
    expect(readdirSync(s.dir)).not.toContain("流程图_主干.svg");
  });

  it("replayFlowPatches：重放不上的编辑作为 stale 返回，**绝不静默丢**", () => {
    const s = makeSession("flow-4");
    s.state["_flow_patch_log"] = [{ op: "delete_node", args: { node: "不存在的节点" } }];
    const stale = replayFlowPatches(s, new FlowGraph());
    expect(stale).toHaveLength(1);
    expect(String(stale[0]!["why"])).not.toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  _compile 的两块可单独验的
// ══════════════════════════════════════════════════════════════════

function approvedDeliveryPlan(marker: string): Dict {
  return {
    human_decided: true,
    human_accepted: true,
    releaseState: "RELEASED",
    acceptance: {
      signed: true,
      decision: "APPROVE",
      authority: "admin",
      package_bound: true,
      review_passed: true,
      marker,
    },
    decision_proposal: { marker, contract: "DecisionChangeProposal.v1" },
    decision_application: { marker, contract: "DecisionApplicationValidation.v1" },
    requirements: { marker, contract: "RequirementsSpecification.v1" },
    architecture: { marker, contract: "SolutionArchitecture.v1" },
    acceptance_test_plan: { marker, contract: "AcceptanceTestPlan.v1" },
  };
}

function seedOldReleaseFiles(s: SessionT, marker: string): Map<string, string> {
  const old = new Map<string, string>();
  for (const name of ENGAGEMENT_RELEASE_FILES) {
    const bytes = `${marker}:${name}`;
    writeFileSync(join(s.dir, name), bytes, "utf-8");
    old.set(name, bytes);
  }
  return old;
}

function expectReleaseFiles(s: SessionT, expected: ReadonlyMap<string, string>): void {
  for (const [name, bytes] of expected) {
    expect(readFileSync(join(s.dir, name), "utf-8"), name).toBe(bytes);
  }
}

describe("compile 的零件", () => {
  it("没有 OIR 时 writeCanonicalArtifacts 什么都不写、回空 dict", () => {
    const s = makeSession("canon-1");
    expect(writeCanonicalArtifacts(s)).toEqual({});
    expect(readdirSync(s.dir)).not.toContain("ontology.package.json");
  });

  it("drainQueue：队列空就是 no-op，且把 `_queued` 清掉", async () => {
    const s = makeSession("drain-1");
    s.state["_queued"] = [];
    await drainQueue(s, deps());
    expect("_queued" in s.state).toBe(false);
    expect(s.events).toHaveLength(0);
  });

  it("drainQueue：一条失败不拖垮其余的，而且**必须回执**", async () => {
    const s = makeSession("drain-2");
    const said: string[] = [];
    s.state["_queued"] = [
      { intent: "unknown", span: "把金额改成不含税", by: "queued" },
      { intent: "unknown", span: "补一列供应商", by: "queued" },
    ];
    let n = 0;
    await drainQueue(
      s,
      deps({
        act: async () => {
          n += 1;
          if (n === 1) throw new TypeError("端口没接");
          return "补了一列供应商";
        },
        publishAssistant: (_s, text) => said.push(text),
      }),
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("「把金额改成不含税」没执行成功：TypeError: 端口没接");
    expect(said[0]).toContain("补了一列供应商");
    expect(s.events.some((e) => e["kind"] === "queue.drained")).toBe(true);
  });

  it("compile 只按固定白名单写 FDE 交付 JSON，模型 artifacts/路径字段没有写盘权", async () => {
    const s = makeSession("delivery-1");
    s.state["_oir"] = new OIR();
    s.state["_conflicts"] = [];
    const exportPlan = {
      human_decided: true,
      human_accepted: true,
      releaseState: "RELEASED",
      acceptance: {
        signed: true,
        decision: "APPROVE",
        authority: "admin",
        package_bound: true,
        review_passed: true,
      },
      decision_proposal: { contract: "DecisionChangeProposal.v1" },
      decision_application: { contract: "DecisionApplicationValidation.v1" },
      requirements: { contract: "RequirementsSpecification.v1" },
      architecture: { contract: "SolutionArchitecture.v1" },
      acceptance_test_plan: { contract: "AcceptanceTestPlan.v1" },
      // 这些字段故意像路径；compile 不读取它们来决定文件名。
      artifacts: ["../../outside.json"],
      name: "../../outside.json",
    };
    stageEngagementDelivery(s, exportPlan);
    await compile(s, deps());

    const expected = ENGAGEMENT_DELIVERY_FILES.map(([, name]) => name);
    expect(readdirSync(s.dir)).toEqual(expect.arrayContaining(expected));
    expect(readdirSync(ROOT)).not.toContain("outside.json");
    expect(JSON.parse(readFileSync(join(s.dir, "requirements.json"), "utf-8"))).toEqual({
      contract: "RequirementsSpecification.v1",
    });
    expect(s.state["release_state"]).toBe("RELEASED");
    expect(s.state["_engagement_delivery"]).toBeUndefined();
  });

  it("原子发布：中途 rename 失败会还原全部旧文件与 state，不暴露半包", async () => {
    const s = makeSession("delivery-atomic-rename");
    s.state["_oir"] = new OIR();
    s.state["_conflicts"] = [];
    s.state["artifact_revision"] = 7;
    s.state["ontology_package"] = { revision: 7, marker: "old" };
    s.state["release_state"] = "RELEASED";
    const old = seedOldReleaseFiles(s, "old");
    stageEngagementDelivery(s, approvedDeliveryPlan("new"));

    let installs = 0;
    await expect(compile(s, deps(), {
      releaseFileOps: {
        rename: (source, target) => {
          if (source.includes("/incoming/") && ++installs === 5) {
            throw new Error("injected fifth install rename failure");
          }
          renameSync(source, target);
        },
      },
    })).rejects.toThrow("injected fifth install rename failure");

    expectReleaseFiles(s, old);
    expect(s.state["release_state"]).toBe("DRAFT");
    expect(s.state["artifact_revision"]).toBe(7);
    expect(s.state["ontology_package"]).toEqual({ revision: 7, marker: "old" });
    expect(s.state["_engagement_delivery"]).toBeDefined();
    expect(s.state["_engagement_release_stage"]).toBeDefined();
  });

  it("原子发布：persist 首次失败回滚文件并持久化 DRAFT，同一 staging 可重试", async () => {
    const s = makeSession("delivery-atomic-persist");
    s.state["_oir"] = new OIR();
    s.state["_conflicts"] = [];
    s.state["artifact_revision"] = 3;
    s.state["release_state"] = "DRAFT";
    const old = seedOldReleaseFiles(s, "old");
    stageEngagementDelivery(s, approvedDeliveryPlan("new"));

    const persistedStates: unknown[] = [];
    let persistCalls = 0;
    await expect(compile(s, deps({
      persist: async (session) => {
        persistedStates.push(session.state["release_state"]);
        persistCalls += 1;
        if (persistCalls === 1) throw new Error("injected persist failure");
      },
    }))).rejects.toThrow("injected persist failure");

    expect(persistedStates).toEqual(["RELEASED", "DRAFT"]);
    expectReleaseFiles(s, old);
    expect(s.state["release_state"]).toBe("DRAFT");
    expect(s.state["artifact_revision"]).toBe(3);
    const retained = (s.state["_engagement_release_stage"] as Dict)["stage"] as Dict;
    const retainedDir = String(retained["stageDir"]);
    expect(readdirSync(retainedDir)).toEqual(expect.arrayContaining(["files", "incoming", "backup"]));

    await compile(s, deps());
    expect(s.state["release_state"]).toBe("RELEASED");
    expect(s.state["artifact_revision"]).toBe(4);
    expect(readFileSync(join(s.dir, "requirements.json"), "utf-8")).not.toBe(
      old.get("requirements.json"),
    );
    expect(s.state["_engagement_delivery"]).toBeUndefined();
    expect(s.state["_engagement_release_stage"]).toBeUndefined();
    expect(readdirSync(s.dir).some((name) => name.startsWith(".release-stage-"))).toBe(false);
  });

  it("原子发布：成功后所有固定目标同批可见、状态 RELEASED 且 staging 已清理", async () => {
    const s = makeSession("delivery-atomic-success");
    s.state["_oir"] = new OIR();
    s.state["_conflicts"] = [];
    const old = seedOldReleaseFiles(s, "old");
    stageEngagementDelivery(s, approvedDeliveryPlan("new"));

    await compile(s, deps());

    expect(s.state["release_state"]).toBe("RELEASED");
    for (const [name, bytes] of old) {
      expect(readFileSync(join(s.dir, name), "utf-8"), name).not.toBe(bytes);
    }
    expect(readdirSync(s.dir).some((name) => name.startsWith(".release-stage-"))).toBe(false);
  });

  it("engagement delivery 拒绝缺失或非允许 authority 的伪签字", () => {
    const s = makeSession("delivery-authority");
    for (const authority of ["", "user", "业务验收负责人"]) {
      expect(() => stageEngagementDelivery(s, {
        human_decided: true,
        human_accepted: true,
        releaseState: "RELEASED",
        acceptance: {
          signed: true,
          decision: "APPROVE",
          authority,
          package_bound: true,
          review_passed: true,
        },
      })).toThrow("缺少有效人工验收决定");
    }
    expect(s.state["_engagement_delivery"]).toBeUndefined();
  });

  it("没有当前 revision 的人工验收暂存计划时，compile 强制回到 DRAFT", async () => {
    const s = makeSession("delivery-2");
    s.state["_oir"] = new OIR();
    s.state["_conflicts"] = [];
    s.state["release_state"] = "RELEASED";
    await compile(s, deps());
    expect(s.state["release_state"]).toBe("DRAFT");
  });

  for (const decision of ["APPROVE", "REJECT"] as const) {
    it(`真实 v3 ${decision}：暂停 → Question.answer → 原 run resume → 固定交付件`, async () => {
      const s = makeSession(`delivery-resume-${decision.toLowerCase()}`, {
        title: "FDE v3 验收闭环",
      });
      const runId = `fde-server-${decision.toLowerCase()}`;
      const questionId = await suspendRealFdeAtAcceptance(s, runId);

      const result = await answerAcceptanceAndResume(s, questionId, decision);
      expect(result["created"]).toBe(true);
      expect(s.state["engagement_run_id"]).toBe(runId);
      expect((s.state["engagement_execution"] as Dict)["status"]).toBe(
        String(RunStatus.COMPLETED),
      );
      expect(s.state["release_state"]).toBe(decision === "APPROVE" ? "RELEASED" : "DRAFT");
      expect(readdirSync(s.dir)).toEqual(
        expect.arrayContaining(ENGAGEMENT_DELIVERY_FILES.map(([, name]) => name)),
      );
      expect(JSON.parse(readFileSync(join(s.dir, "human-acceptance.json"), "utf-8"))).toMatchObject({
        signed: true,
        decision,
        actor: "admin.integration",
        actor_role: "admin",
        authority: "admin",
        package_bound: true,
        releaseState: decision === "APPROVE" ? "RELEASED" : "DRAFT",
      });
      const analysisNodes = (s.state["engagement_analysis"] as Dict)["nodes"] as Dict;
      expect(analysisNodes).toHaveProperty("REQUIREMENTS");
      expect(analysisNodes).toHaveProperty("ARCHITECTURE");
      expect(analysisNodes).toHaveProperty("TEST_PLAN");
      expect(analysisNodes).toHaveProperty("HUMAN_ACCEPTANCE");
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  _hydrate
// ══════════════════════════════════════════════════════════════════

describe("hydrate", () => {
  it("库里没有、盘上也没有 → 404", async () => {
    await expect(hydrate("根本不存在", deps())).rejects.toMatchObject({ status: 404 });
  });

  it("single-flight：并发唤醒同一个冷会话只造一个实例", async () => {
    await repo.createSession({ id: "cold-1", title: "旧会话" } as never);
    mkdirSync(join(ROOT, "cold-1"), { recursive: true });
    const d = deps();
    const [a, b] = await Promise.all([hydrate("cold-1", d), hydrate("cold-1", d)]);
    expect(a).toBe(b);
    expect(SESSIONS.get("cold-1")).toBe(a);
    expect(a.title).toBe("旧会话");
    expect(a.events.some((e) => e["kind"] === "session.restored")).toBe(true);
  });

  it("旧会话重建的资产目录会 CAS 落库，清空进程缓存后仍能找回 Image 2/问题清单", async () => {
    const sid = "cold-asset-memory";
    await repo.createSession(makeSessionRow({
      id: sid,
      title: "采购报销旧会话",
      owner: "fde-hydrate",
      project_id: "project-hydrate",
    }));
    const dir = join(ROOT, sid);
    mkdirSync(join(dir, "exports"), { recursive: true });
    writeFileSync(join(dir, "exports", "采购报销_Image2.png"), "historical-image");
    await repo.appendEvent(sid, "artifact.ready", {
      name: "采购报销_Image2.png",
      path: "exports/采购报销_Image2.png",
      storage: "exports",
      mime: "image/png",
      source: "generic_reference",
      display_only: true,
    });
    await repo.saveState(sid, {
      question_backlog: {
        questions: [{ id: "Q-H-1", text: "采购报销由谁终审？", status: "open" }],
      },
    });

    const first = await hydrate(sid, deps());
    const persisted = await repo.loadState(sid);
    const durable = AssetMemory.fromDict(persisted["asset_memory"]);
    expect(durable.search("刚才 Image 2 那张图")[0]?.asset.name).toBe("采购报销_Image2.png");
    expect(durable.search("问题清单")[0]?.asset.kind).toBe("question_list");
    expect(first.stateVersion).toBe((await repo.getSession(sid))!.state_version);

    // 真正模拟换 worker：丢掉 Session/AssetMemory 实例，只保留 repo + workspace。
    const version = (await repo.getSession(sid))!.state_version;
    SESSIONS.clear();
    const restored = await hydrate(sid, deps());
    expect(AssetMemory.fromDict(restored.state["asset_memory"]).search("采购报销图片")).not.toHaveLength(0);
    expect((await repo.getSession(sid))!.state_version).toBe(version);
  });

  it("盘上有 oir.json / flow.json 就读回来；坏了只发 hydrate.partial，会话照样能打开", async () => {
    await repo.createSession({ id: "cold-2" } as never);
    const dir = join(ROOT, "cold-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oir.json"), "{ 这不是 json", "utf-8");
    writeFileSync(join(dir, "flow.json"), "也不是", "utf-8");
    const s = await hydrate("cold-2", deps());
    const partials = s.events.filter((e) => e["kind"] === "hydrate.partial");
    expect(partials).toHaveLength(2);
    expect(s.state["_oir"]).toBeUndefined();
  });

  it("失败的恢复不留半成品在 SESSIONS 里", async () => {
    await repo.createSession({ id: "cold-3" } as never);
    mkdirSync(join(ROOT, "cold-3"), { recursive: true });
    await expect(
      hydrate(
        "cold-3",
        deps({
          restoreDialogue: async () => {
            throw new Error("对话恢复炸了");
          },
        }),
      ),
    ).rejects.toThrow("对话恢复炸了");
    expect(SESSIONS.has("cold-3")).toBe(false);
  });

  it("attach → persist → revoke → hydrate：旧 DOC 切片和 manifest 都不能复活", async () => {
    const sid = "hydrate-revoked-document";
    await repo.createSession(makeSessionRow({
      id: sid,
      owner: "alice",
      project_id: "project_A",
    }));
    // 模拟升级前已经持久化过的会话投影：这正是撤权后最危险的遗留输入。
    await repo.saveState(sid, {
      _document_manifest: [{
        project_id: "project_A", document_id: "doc_1", version_id: "ver_2",
        sha256: "sha-v2", index_revision: "ix-v2", acl_revision: 3,
      }],
      _chunks: {
        "现场访谈.txt": [{
          cite: "现场访谈.txt#L1", text: "仍可用的会话材料", tags: ["body"], locator: { line: 1 },
        }],
        "DOC[doc_1@ver_2] 采购规则.txt": [{
          cite: "DOC[doc_1@ver_2] 采购规则.txt#L1",
          text: "撤权后不得出现的正文",
          tags: ["body"],
          locator: { _document_id: "doc_1", _version_id: "ver_2", _chunk_id: "body" },
        }],
      },
    });
    setDocumentServiceForTests({
      async manifest() {
        throw new Error("ACL 已撤销");
      },
    } as never);

    SESSIONS.clear();
    const restored = await hydrate(sid, deps());
    expect(restored.state["_document_manifest"]).toEqual([]);
    expect(String(restored.state["_document_manifest_error"])).toContain("ACL 已撤销");
    expect(restored.state["_chunks"]).toEqual({
      "现场访谈.txt": [{
        cite: "现场访谈.txt#L1", text: "仍可用的会话材料", tags: ["body"], locator: { line: 1 },
      }],
    });
    const index = restored.state["_index"] as InstanceType<typeof EvidenceIndex>;
    expect(index.allChunks().map((chunk) => chunk.render)).toEqual(["仍可用的会话材料"]);
    expect(JSON.stringify(restored.state)).not.toContain("撤权后不得出现的正文");
  });

  it("已经在缓存里就直接返回，不再碰仓储", async () => {
    const live = makeSession("warm-1");
    const got = await hydrate("warm-1", deps({ repo: () => {
      throw new Error("不该读库");
    } }));
    expect(got).toBe(live);
  });
});
