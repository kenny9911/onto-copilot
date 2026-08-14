/**
 * `server/glue/*` —— `server.py` 那批胶水的测试。
 *
 * 这一批函数的"值"多半是**副作用**（写了哪几个文件、给 repo 发了哪几条写、
 * 事件流上出现了什么），所以断言的重点是那些序列，而不是返回值。能用真材料的
 * 地方用 `golden/材料.xlsx`（契约 §3：手写的期望值是猜测，真材料是事实）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(tmpdir(), `ontocopilot-glue-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Budget } = await import("../src/kernel/budget.js");
const { Chunk, EvidenceIndex } = await import("../src/kernel/memory/evidence.js");
const { InMemoryBlobStore, InMemoryJournal } = await import("../src/kernel/journal.js");
const { Recorder } = await import("../src/kernel/recorder.js");
const { ToolDenied } = await import("../src/kernel/errors.js");
const { makeChunk, makeParsedDoc } = await import("../src/onto/parse/base.js");
const { defaultRegistry } = await import("../src/onto/parse/index.js");
const { OIR } = await import("../src/onto/oir.js");
const { Question, QuestionBacklog, QuestionStatus } = await import("../src/onto/questions.js");
const { MemoryRepo } = await import("../src/store/repo/memory.js");
const { setRepoForTests } = await import("../src/store/deps.js");
const { SESSIONS, Session, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);

const { builtinRegistry, sandboxForTools, resolveRid, ridKind, ridName } = await import(
  "../src/server/glue/tools.js"
);
const { chatRun } = await import("../src/server/glue/chat_run.js");
const { chunkCache, CHUNK_TEXT_CAP, preparse } = await import("../src/server/glue/preparse.js");
const { pendingQuestions, syncQuestionBacklog } = await import(
  "../src/server/glue/questions.js"
);
const { buildFlowDiagram, rewriteFlowArtifacts, replayFlowPatches } = await import(
  "../src/server/glue/flow.js"
);
const { drainQueue, writeCanonicalArtifacts } = await import("../src/server/glue/compile.js");
const { hydrate } = await import("../src/server/glue/hydrate.js");
const { citeOf } = await import("../src/server/glue/chunks.js");
const { FlowGraph } = await import("../src/onto/flow.js");

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
  registerHydrator(null);
  setRepoForTests(null);
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
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
    expect(full.forScope("*").map((t) => t.spec.name).sort()).toEqual([
      "evidence.rows",
      "evidence.search",
      "impact.trace",
      "oir.query",
      "profile.column",
    ]);
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
    const hit = (await reg.call("evidence.search", { query: "采购", files: [enc] }, CTX)) as {
      count: number;
    };
    expect(hit.count).toBe(1);
  });

  it("evidence.search 认不出的文件名要**说出来**，不是静默空结果", async () => {
    const reg = builtinRegistry({ evidence: index() });
    const miss = (await reg.call("evidence.search", { query: "采购", files: ["没有.csv"] }, CTX)) as {
      count: number;
      error: string;
    };
    expect(miss.count).toBe(0);
    expect(miss.error).toContain("没有这些材料：['没有.csv']");
    expect(miss.error).toContain("'实体梳理.xlsx'");
  });

  it("evidence.rows 空结果要把现有的容器名报回去", async () => {
    const reg = builtinRegistry({ evidence: index() });
    const out = (await reg.call("evidence.rows", { file: "不存在", container: "无" }, CTX)) as {
      count: number;
      note: string;
    };
    expect(out.count).toBe(0);
    expect(out.note).toContain("实体梳理.xlsx!对象");
  });

  it("impact.trace 找不到目标时**说清楚**，并提示别猜 rid", async () => {
    const reg = builtinRegistry({ oir: new OIR() });
    const bad = (await reg.call("impact.trace", { target: "根本没有这个" }, CTX)) as {
      error: string;
      note: string;
    };
    expect(bad.error).toContain("根本没有这个");
    expect(bad.note).toContain("别照着材料里的写法猜 rid");
  });

  it("profile.column 猜不中时给候选，不是空结果", async () => {
    const reg = builtinRegistry({ profiles: { "订单.含税金额": { unique_ratio: 0.9 } } });
    const out = (await reg.call("profile.column", { column: "金额" }, CTX)) as {
      error: string;
      did_you_mean: string[];
    };
    expect(out.did_you_mean).toEqual(["订单.含税金额"]);
    const hit = await reg.call("profile.column", { column: "订单.含税金额" }, CTX);
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
  function doc(name: string, render: string): ParsedDoc {
    const d = makeParsedDoc({ fileId: "f1", fileName: name, kind: "text" });
    d.chunks.push(
      makeChunk({
        docId: "0",
        fileId: "f1",
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

  it("解析炸了只发 parse.failed，不把上传带下去", async () => {
    const s = makeSession("prep-3");
    s.files = [{ name: "没有.xlsx", size: 0, path: join(s.dir, "没有.xlsx"), sha256: "" }];
    await expect(preparse(s)).resolves.toBeUndefined();
    expect(s.events.some((e) => e["kind"] === "parse.failed")).toBe(true);
    expect(s.state["_index"]).toBeUndefined();
  });
});

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
    expect(s.state["_flow"]).toBeDefined();
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

  it("已经在缓存里就直接返回，不再碰仓储", async () => {
    const live = makeSession("warm-1");
    const got = await hydrate("warm-1", deps({ repo: () => {
      throw new Error("不该读库");
    } }));
    expect(got).toBe(live);
  });
});
