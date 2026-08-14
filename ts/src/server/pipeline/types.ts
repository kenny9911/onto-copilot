/**
 * server 段 D（流水线）的边界类型 —— `server.py` 2030–4513 行用到的那些。
 *
 * ══════════════════════════════════════════════════════════════════
 *  为什么这里有一个「端口」对象，而不是一路 import
 * ══════════════════════════════════════════════════════════════════
 *
 * Python 侧 `server.py` 是**一个 7051 行的模块**，`_run_pipeline` 直接调同模块里
 * 的 `_gateways` / `_ensure_catalog` / `_project_memory`，以及 `onto.pipeline`、
 * `onto.engagement*`、`onto.flow_extract`、`kernel.agents/skills/catalog` 这十几个
 * 模块。TS 侧这些东西分属**别的 agent 的 track**，有的还没落地。
 *
 * 两条路：(a) 直接 import 一个还不存在的文件 —— 编译不过，而且把「我这一段对不对」
 * 和「别人写完没有」绑死；(b) 把它们收进一个显式的 {@link PipelineDeps}。选 (b)。
 *
 * **这不是 DI 框架**（CONTRACT §10 禁的是给 FastAPI `Depends()` 造一套 DI）。它就是
 * 一个普通的参数对象，接线的人在 `server/app.ts` 里填一次。等那些模块落地了，把
 * 对应字段换成 `import` 的直连即可 —— 每个字段都标了它在 Python 侧的出处。
 *
 * ══════════════════════════════════════════════════════════════════
 *  取消：Node 上没有 `Task.cancel()`（CONTRACT §2.2），所以不假装有
 * ══════════════════════════════════════════════════════════════════
 *
 * Python 的 `s.run_task.cancel()` 会在协程的**下一个 await 点**抛
 * `CancelledError`，`_run_pipeline` 的 `except asyncio.CancelledError` 因此一定
 * 接得到。JS 里没有任何办法从外部让一个正在跑的 async 函数停下。
 *
 * 这里给的是和 `kernel/scheduler.ts` 同一档的**协作式**取消：
 *   · {@link RunHandle.abort} 打信号；
 *   · `_run_pipeline` 在每个原本会 raise 的位置显式 `check()`，抛
 *     {@link RunCancelled}（它就是 `asyncio.CancelledError` 的对等物）；
 *   · 已经发出去的模型调用不会消失，钱照花。
 *
 * `RunCancelled` **不是** `Error` 家族里会被 `except Exception` 吃掉的那种：
 * Python 里 `CancelledError` 继承 `BaseException`，所以 `except Exception` 天然
 * 漏过它。JS 没有这一层，因此每一个对应 `except Exception` 的 `catch (e)`
 * **必须**先 `if (e instanceof RunCancelled) throw e;`。漏一处的症状是「用户点了
 * 停止，会话却被标成 failed 并写了一次不该写的检查点」。
 */

import type { Budget } from "../../kernel/budget.js";
import type { AgentBus } from "../../kernel/bus/bus.js";
import type { Recorder } from "../../kernel/recorder.js";
import type { ParsedDoc, ParserRegistry } from "../../onto/parse/base.js";
import type { Repo } from "../../store/repo/protocol.js";
import type { SessionEvent } from "../../session_events.js";

// ══════════════════════════════════════════════════════════════════
//  会话
// ══════════════════════════════════════════════════════════════════

/** 一份材料在 `Session.files` 里的形态（`_upload_once` 写的那个 dict）。 */
export type MaterialFile = Record<string, unknown> & { readonly name: string };

/**
 * `server.py` 的 `Session` dataclass，**只列本段用得到的成员**。
 *
 * 声明成结构化接口而不是 import 具体类：`Session` 归 server 段 A，六个 agent
 * 并行时它还不存在。字段名按 CONTRACT §1 用 camelCase（线上形态才是 snake_case）。
 */
export interface SessionLike {
  readonly id: string;
  title: string;
  project: string;
  projectId: string;
  readonly created: number;
  files: MaterialFile[];
  status: string;
  error: string;
  /** `workspace/<id>/` 的绝对路径（Python 侧是 `Session.dir` 这个 property）。 */
  readonly dir: string;
  /** 进程内事件投影。DurableEventHub 会原地改它，所以必须可变。 */
  readonly events: SessionEvent[];
  state: Record<string, unknown>;
  stateVersion: number;
  owner: string;
  buildLeaseOwner: string;
  mutationLeaseOwner: string;
  /** build 的「检查状态 → 占位 → 创建任务」必须原子。 */
  readonly buildLock: AsyncLockLike;
  /** 当前在跑的对话轮 / 梳理任务的句柄。运行时对象，**不落库**。 */
  chatTask: RunHandle | null;
  runTask: RunHandle | null;
  emit(kind: string, payload?: Record<string, unknown>): SessionEvent;
}

// ══════════════════════════════════════════════════════════════════
//  取消
// ══════════════════════════════════════════════════════════════════

/** `asyncio.CancelledError` 的对等物。见文件头：**每个 `catch` 都要放它过去**。 */
export class RunCancelled extends Error {
  constructor(message = "run cancelled") {
    super(message);
    this.name = "RunCancelled";
    Object.setPrototypeOf(this, RunCancelled.prototype);
  }
}

/** `e` 是取消信号吗。名字是判据的一部分：跨 realm（vitest 的模块隔离）时
 *  `instanceof` 会假阴性，而这条判断一旦假阴性就会把「用户停止」记成 failed。 */
export function isCancelled(e: unknown): boolean {
  return e instanceof RunCancelled || (e instanceof Error && e.name === "RunCancelled");
}

/**
 * `asyncio.Task` 的**弱**等价物：能 await、能打取消信号、能问「结束了没」。
 *
 * Python 的 `task.cancel()` 返回是否真的送达；这里 `abort()` 只是打信号，
 * 是否停下来取决于被取消方查不查。`done` 与 Python 的 `task.done()` 同义。
 */
export interface RunHandle {
  readonly promise: Promise<void>;
  readonly signal: AbortSignal;
  /** Python `task.done()`。 */
  done(): boolean;
  /** Python `task.cancel()`。幂等。 */
  abort(): void;
}

/** 把一个已经在跑的 promise 包成 {@link RunHandle}。 */
export function makeRunHandle(
  body: (signal: AbortSignal) => Promise<void>,
  controller: AbortController = new AbortController(),
): RunHandle {
  let finished = false;
  // `await Promise.resolve()` 对应 `asyncio.create_task` 的「本轮不跑」：Python 的
  // task 要等事件循环下一次调度才开始，而 async 函数体在 JS 里是**同步**跑到第一个
  // await 的。少这一步的后果很具体：`_claim_and_start_build` 还握着 build_lock 时，
  // 管线的开头几行就已经在改 `s.status` 了。
  const promise = (async () => {
    await Promise.resolve();
    await body(controller.signal);
  })().finally(() => {
    finished = true;
  });
  // 无人 await 的 rejected promise 在 Node 里会触发 unhandledRejection 杀进程
  // （CONTRACT §2.1 记的就是这条）。调用方通常会 await，这里再兜一层。
  promise.catch(() => undefined);
  return {
    promise,
    signal: controller.signal,
    done: () => finished,
    abort: () => {
      controller.abort();
    },
  };
}

/** 信号已经 abort 就抛 {@link RunCancelled} —— 对应 Python 在 await 点抛的那一下。 */
export function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new RunCancelled();
}

// ══════════════════════════════════════════════════════════════════
//  锁
// ══════════════════════════════════════════════════════════════════

/** `asyncio.Lock`。`acquire()` 返回释放函数，配 `try/finally` 用。 */
export interface AsyncLockLike {
  acquire(): Promise<() => void>;
}

/** FIFO 的 `asyncio.Lock`：release 时把所有权**直接交给**下一个等待者，
 *  而不是先置空再让新来的抢 —— 后者会让并发 build 的判定顺序不确定。 */
export class AsyncLock implements AsyncLockLike {
  private locked = false;
  private readonly waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) this.locked = true;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return; // 幂等：finally 放一次，别的路径再放不会解锁两次
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.locked = false;
      else next();
    };
  }
}

/** `async with lock:` 的糖。 */
export async function withLock<T>(lock: AsyncLockLike, body: () => Promise<T>): Promise<T> {
  const release = await lock.acquire();
  try {
    return await body();
  } finally {
    release();
  }
}

// ══════════════════════════════════════════════════════════════════
//  端口
// ══════════════════════════════════════════════════════════════════

/** `_gateways()` 的返回四元组（`server.py:729`）。 */
export interface Gateways {
  /** `OpenAICompatBackend`；收尾要 `aclose()`。 */
  readonly backend: { aclose(): Promise<void> } | null;
  /** `ModelGateway` —— 只用到它的 `.rec`。 */
  readonly gw: { readonly rec: Recorder };
  /** `SmartGateway`，交给视觉解析器。 */
  readonly smart: unknown;
  readonly budget: Budget;
}

/** `ModelCatalog`，只用到 `by_capability()`。 */
export interface CatalogLike {
  byCapability(): Record<string, string[]>;
}

/** `onto.pipeline.segment_corpus` 出来的一段。 */
export interface SegmentLike {
  readonly key: string;
  readonly label: string;
  readonly fileName: string;
  readonly chunkIds: readonly string[];
}

/** `finish()` 的返回。字段名照 Python 的 dict 键，**不要改** —— 事件载荷直接用它。 */
export interface FinishResult {
  readonly conflicts: ConflictLike[];
  readonly align: Record<string, unknown>;
  readonly merged: unknown;
  readonly uncertain: unknown;
  readonly auto_repaired: unknown;
  /** `onto/clarify.ts` 的 `ClarificationSet`。**纯数据** —— 摘要走
   *  `clarificationSummary(cs)`，不是 `cs.summary()`。 */
  readonly clarify: { readonly questions: unknown[] };
  /** `onto/gaps.ts` 的 `Gap`。**纯数据** —— 转问题走 `gapToQuestion(g)`。 */
  readonly align_gaps?: readonly unknown[];
  readonly suggestions?: unknown[];
}

/**
 * `onto/conflict.ts` 的 `Conflict`。**纯数据，没有 `toDict()` 方法** ——
 * 按约定 §1 纯数据 dataclass 移植成 interface + 自由函数，序列化走
 * `conflictToDict(c)`。
 *
 * 这里原本声明了 `toDict(): …`，与真身对不上。`serve.ts` 接线时用 `seam()`
 * 把类型强转过去，于是 tsc 一路放行，直到真跑流水线才炸
 * `TypeError: c.toDict is not a function` —— 5700 个单测全绿也发现不了，
 * 因为两边各自都自洽，错的是接缝。
 */
export interface ConflictLike {
  readonly rid: string;
  readonly kind: unknown;
}

export interface QuestionLike {
  readonly rid: string;
  readonly group?: string;
}

/** `onto.oir.OIR`，只列本段碰的成员。 */
export interface OirLike {
  readonly questions: Map<string, QuestionLike> | Record<string, QuestionLike>;
  readonly actions: readonly unknown[];
  addQuestion(q: QuestionLike): void;
  stats(): Record<string, unknown>;
  toDict(): Record<string, unknown>;
}

/** `kernel.memory.context.ContextManager` 里本段用到的两样。 */
export interface ContextManagerLike {
  readonly reflections: readonly string[];
  reflect(text: string): void;
}

/** `kernel.memory.project.ProjectMemory`。 */
export interface ProjectMemoryLike {
  readonly store: unknown;
  authoritative(): readonly { readonly content: string }[];
}

/** `kernel.memory.dialogue.DialogueMemory` 里本段用到的部分。 */
export interface DialogueLike {
  readonly turns: readonly { readonly speaker: unknown; readonly text: string; readonly ts: number }[];
  activeDecisions(): readonly { readonly kind: unknown; render(): string }[];
}

/**
 * 本段对外部世界的全部依赖。每个字段都标了 Python 侧的出处。
 *
 * 落地一个就把对应字段换成直连 import；在此之前它们由 `server/app.ts` 接线。
 */
export interface PipelineDeps {
  // ── 进程级配置（server.py 125–161）────────────────────────────
  /** `get_repo()`。每次调用取当前 repo —— lifespan 会换实例。 */
  readonly repo: () => Repo;
  /** `_WORKER_ID`。 */
  readonly workerId: string;
  /** `time.time()`，epoch 秒。可注入只为测试。 */
  readonly now: () => number;
  /** `_BUILD_LEASE_TTL`（lifespan 里会重算，所以是函数）。 */
  readonly buildLeaseTtl: () => number;
  /** `_BUILD_HEARTBEAT_INTERVAL`。 */
  readonly buildHeartbeatInterval: () => number;
  /** `uuid.uuid4().hex`。可注入只为测试。 */
  readonly newToken: () => string;

  // ── 同模块、但属于别的 server 段 ─────────────────────────────
  /** `_sess_async`（段 A）。 */
  readonly sessAsync: (sid: string) => Promise<SessionLike>;
  /** `_refresh_files_projection`（段 A，server.py:439）。 */
  readonly refreshFilesProjection: (s: SessionLike) => Promise<void>;
  /** `_run_id_for`（段 A，server.py:488）—— 语料指纹，语料变了 id 就变。 */
  readonly runIdFor: (s: SessionLike) => string;
  /** `_gateways`（段 A，server.py:729）。 */
  readonly gateways: (
    dir: string,
    runId: string,
    opts: { resume: boolean; sessionId: string; kind: string; owner: string },
  ) => Gateways;
  /** `_ensure_catalog`（段 A，server.py:457）。 */
  readonly ensureCatalog: () => Promise<CatalogLike>;
  /** `_CATALOG or ModelCatalog()` —— **接线方负责那个 `or`**，这里拿到的一定不是
   *  null（Python 那行的语义是"没发现过就用内置目录"，不是"没有目录"）。 */
  readonly catalog: () => CatalogLike;
  /** `_warn_low_balance`（段 A，server.py:760）。 */
  readonly warnLowBalance: (s: SessionLike) => Promise<void>;
  /** `_money_failure`（段 A，server.py:777）→ `[signal, detail]`。 */
  readonly moneyFailure: (e: unknown) => readonly [string, string];
  /** `appconfig.usd_cap()`。 */
  readonly usdCap: () => number;
  /** `_project_memory`（段 A，server.py:1239）。 */
  readonly projectMemory: (pid: string) => Promise<ProjectMemoryLike>;
  /** `_remember_run_lessons`（段 A，server.py:1349）。 */
  readonly rememberRunLessons: (
    s: SessionLike,
    lessons: readonly string[],
    opts: { runId: string; pm?: ProjectMemoryLike | null },
  ) => Promise<void>;
  /** `_chunk_cache`（段 A，server.py:1671）。 */
  readonly chunkCache: (docs: readonly ParsedDoc[]) => Record<string, unknown>;
  /** `s_state_dialogue`（段 A，server.py:1971）。 */
  readonly stateDialogue: (s: SessionLike) => DialogueLike | null;
  /** `_dialogue`（段 F，server.py:4515）。 */
  readonly dialogue: (s: SessionLike) => DialogueLike;
  /** `_emit_ai_prompts`（段 F，server.py:6357）。 */
  readonly emitAiPrompts: (s: SessionLike, opts: { slot: string }) => Promise<void>;
  /** `_persist_decisions`（本段 3338，但依赖 store.repo.DecisionRow 的领域对象）。 */
  readonly persistDecisions: (s: SessionLike, dm: unknown) => Promise<void>;

  // ── 尚未移植的 onto / kernel 模块 ────────────────────────────
  /** `onto.parse.default_registry(...)`。 */
  readonly registry: (opts: {
    visionGateway?: unknown;
    visionProgress?: (msg: string) => void;
  }) => ParserRegistry;
  /** `onto.parse.build_index`。 */
  readonly buildIndex: (docs: readonly ParsedDoc[]) => EvidenceIndexLike;
  /** `onto.parse.collect_endpoints`。 */
  readonly collectEndpoints: (docs: readonly ParsedDoc[]) => unknown[];
  /** `onto.parse.collect_profiles`。 */
  readonly collectProfiles: (docs: readonly ParsedDoc[]) => unknown;
  /** `onto.parse.corpus_summary`。 */
  readonly corpusSummary: (docs: readonly ParsedDoc[]) => Record<string, unknown>;
  /** `onto.pipeline.segment_corpus`。 */
  readonly segmentCorpus: (index: EvidenceIndexLike, docs: readonly ParsedDoc[]) => SegmentLike[];
  /** `onto.pipeline.build_dag`。 */
  readonly buildDag: (segments: readonly SegmentLike[]) => unknown;
  /** `onto.pipeline.build_oir`。 */
  readonly buildOir: (
    merged: Record<string, unknown>,
    index: EvidenceIndexLike,
    dropped: Record<string, unknown>,
  ) => OirLike;
  /** `onto.pipeline.finish`。 */
  readonly finish: (
    oir: OirLike,
    opts: { endpoints: unknown; profiles: unknown; project: string },
  ) => FinishResult;
  /** `onto.gaps.mine_questions`。 */
  readonly mineQuestions: (
    oir: OirLike,
    opts: { docs: readonly ParsedDoc[]; chunks: unknown; extra: unknown[]; extraGaps: unknown[] },
  ) => QuestionLike[];
  /** `onto.export.blocks_from_markdown`（`_tables_in_text` 用）。 */
  readonly blocksFromMarkdown: (text: string) => readonly MarkdownBlockLike[];

  /** 装配 Harness 的那一坨（`kernel.agents/skills/sandbox/tools` + `onto.pipeline`
   *  的 handlers/critics）。**整块注入**：它们只在 `_run_pipeline` 内部一处协同出现，
   *  逐个拆成端口只会让接线更容易漏。 */
  readonly harness: HarnessPort;

  // ── 本段之外的产物写入（依赖 flow_extract / template / canonical）──
  /** `_build_flow_diagram`（本段 3643，依赖未移植的 `onto.flow_extract`）。 */
  readonly buildFlowDiagram: (s: SessionLike, docs: readonly ParsedDoc[]) => Promise<void>;
  /** `_link_flow_to_api`（本段 3796）。 */
  readonly linkFlowToApi: (s: SessionLike, oir: OirLike) => unknown[];
  /** `_replay_oir_patches`（本段 3582）。 */
  readonly replayOirPatches: (s: SessionLike, oir: OirLike) => Record<string, unknown>[];
  /** `_sync_question_backlog`（本段 3302，写 xlsx 要 exceljs）。 */
  readonly syncQuestionBacklog: (
    s: SessionLike,
    opts: { oir?: OirLike | null; clarification?: unknown; conflicts?: unknown },
  ) => Promise<unknown>;
  /** `_pending_questions`（本段 3296）。 */
  readonly pendingQuestions: (s: SessionLike) => readonly unknown[];
  /** `_compile`（本段 3825）。 */
  readonly compile: (s: SessionLike, opts: { leaseOwner: string }) => Promise<void>;
}

/** `_run_pipeline` 装配 Harness 那一段的整块端口。 */
export interface HarnessPort {
  /** `ONTOCOPILOT_ENABLE_CODEACT` + `default_sandbox(production=True)` +
   *  `builtin_registry(...)`，返回写进黑板 `_tools` 的那个对象。
   *
   *  **async，而 Python 那行是同步的**：`default_sandbox` 只是挑一个本机运行时，
   *  而 TS 侧沙箱住在 Python sidecar（约定 §2.3），要探一次它的 `/health` 才知道
   *  有没有。探测发生在装配工具之前，探不到就等于没有沙箱 —— 于是 `code.exec`
   *  **不进动作空间**，而不是进了之后每次调用都失败。 */
  buildTools(opts: { evidence: EvidenceIndexLike; profiles: unknown }): Promise<unknown>;
  /** `default_agents()["extractor"].render_system(skills) + "\n\n" + skills.load(...)`。 */
  extractorSystem(): string;
  /** `ContextManager(system=…, evidence=…, budget_tokens=90_000, long_term=…)`。 */
  makeContext(opts: {
    system: string;
    evidence: EvidenceIndexLike;
    longTerm: unknown;
  }): ContextManagerLike;
  /** `AgentLoop(...) + Scheduler(...)`，抽取那一档。返回可直接 `run(runId)` 的东西。 */
  makeExtractRun(opts: {
    gw: Gateways["gw"];
    ctx: ContextManagerLike;
    bus: AgentBus;
    budget: Budget;
    segments: readonly SegmentLike[];
    index: EvidenceIndexLike;
    dag: unknown;
  }): { run(runId: string): Promise<SchedulerOutcome> };
  /** `build_fde_engagement_dag()`。 */
  engagementDag(): { readonly name: string; describe(): unknown };
  /** engagement 那一档的 `EngagementRuntimeInput + AgentLoop + Scheduler`。 */
  makeEngagementRun(opts: {
    gw: Gateways["gw"];
    ctx: ContextManagerLike;
    bus: AgentBus;
    budget: Budget;
    runtime: EngagementRuntimeInputLike;
    dag: { readonly name: string };
  }): { run(runId: string): Promise<SchedulerOutcome> };
}

/** `EngagementRuntimeInput` 的字段。**键名照 Python 的构造参数**。 */
export interface EngagementRuntimeInputLike {
  readonly sessionId: string;
  readonly project: string;
  readonly oir: OirLike;
  readonly flow: unknown;
  readonly backlog: unknown;
  readonly decisions: unknown[];
  readonly corpus: Record<string, unknown>;
  readonly artifactRevision: number;
  readonly generatedAt: string;
  readonly releaseDownloadable: boolean;
}

/** `kernel.scheduler.RunOutcome` 的结构口径（直接兼容 `scheduler.ts` 的 RunOutcome）。 */
export interface SchedulerOutcome {
  readonly status: string;
  readonly outputs: Record<string, unknown>;
  readonly results: Record<string, unknown>;
  readonly pendingHuman: Record<string, unknown> | null;
  readonly error: string;
  readonly skipped: readonly string[];
}

/** `onto.parse.build_index()` 出来的证据索引，只列本段用到的。 */
export interface EvidenceIndexLike {
  readonly length: number;
  allChunks(): unknown;
}

/** `onto.export.Block`。 */
export interface MarkdownBlockLike {
  readonly kind: string;
  readonly text?: string;
  readonly columns?: readonly string[];
  readonly rows?: readonly (readonly string[])[];
}
