/**
 * Agent Loop 运行时 —— DAG 节点内部的执行引擎。
 *
 * 节点是**上下文作用域边界**（TDP, arXiv:2604.11378）：节点内部转 20 轮产生的中间
 * 推理不会泄漏到下游，只有结构化产出和一份 digest 会流下去。这是控制上下文膨胀
 * 的主力手段。
 *
 * 五种模式对应架构文档 §4.2.1。选哪种由 {@link NodeSpec} 声明，不由模型自己决定
 * —— 让模型选自己的执行模式会让行为不可预测，而 FDE 场景需要可预测性。
 *
 * ── 这一版相对 Python 的三处结构性差异（都是被迫的，不是设计改动）──────────
 *
 * 1. **协作方全是「局部最小类型」**（`Loop*` 前缀）。gateway / recorder / panel /
 *    bus / context manager / working set / scratchpad 与本模块同一波迁移，这里只
 *    声明本模块**真正调到**的成员。Python 那边它们本来就是鸭子类型接进来的，所以
 *    这不是新增约束。每个端口都按已落地的真身对齐过（`Scratchpad.append` 是位置
 *    参数、`digest()`/`stats()` 返回具名接口这两处都照做了），真类可以直接塞进来；
 *    等这一波稳定后应收敛成 `import type`，收敛不需要改调用点。
 *    （tools.ts 的 `ToolCallCtx`、scheduler.ts 的 `AgentLoopLike` 走的是同一条路。）
 *
 * 2. **Scratchpad 由外部注入**（`newScratchpad`）。Python 的 `run()` 内部直接
 *    `Scratchpad(budget_tokens=...)`。跨 track 硬绑一个构造调用会让本模块的测试
 *    连带依赖 memory/short_term 的实现，所以改成构造时注入一个工厂 ——
 *    唯一的语义差别是「谁来 new」，`tokens // 2` 这个参数仍由本模块算。
 *    调用方写 `newScratchpad: (t) => new Scratchpad({ budgetTokens: t })` 即可。
 *
 * 3. **`metrics_from` 没有在这里再导出。** Python 的 `__all__` 里带着它（它属于
 *    critic.py，loop.py 只是转手），critic.ts 落地后由调用方直接从那边取。
 *
 * 取消语义见 CONTRACT §2.2：Node 上没有真正的任务取消，这里**不**用 `Promise.race`
 * 假装实现 `asyncio` 的那一套。
 */

import type { Budget } from "./budget.js";
import { Difficulty, NodeMode, type NodeSpec } from "./dag.js";
import { BudgetExhausted, HumanInputRequired, NodeFailure, pyRepr } from "./errors.js";
import { EventKind } from "./events.js";
import { fingerprint } from "./ids.js";
import { QuotaExhausted } from "./llm.js";
import { pyJsonDumps } from "./journal.js";
import { estTokens } from "./memory/types.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义的小工具
// ══════════════════════════════════════════════════════════════════

/** Python 的 `s[:n]` 按**码点**切，JS 的 `slice` 按 UTF-16 码元切 ——
 * 中文没事，emoji / CJK 扩展 B 会被切出半个代理对。 */
function pySlice(s: string, n: number): string {
  // 码点数 <= 码元数，所以码元数不超 n 时一定不需要截断（快路径，避免展开数组：
  // 这里的输入可能是 20000 字的产物 JSON，每轮 critic 都要走一遍）
  if (s.length <= n) return s;
  return [...s].slice(0, n).join("");
}

/** Python 的真值判断：空串 / 0 / 空 list / 空 dict 全是假。JS 里它们都是真。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把协作方返回的**具名接口**摊成 `Record<string, unknown>`。
 *
 * TS 的隐式索引签名只对匿名对象类型成立，`interface Digest {…}` 拿不到，所以
 * `digest()` / `stats()` 的返回值不能直接当 Record 用。摊一层是真摊（运行时确实
 * 复制出一个普通对象），断言只是补上类型系统看不见的那半步。
 */
function asRecord(o: object): Record<string, unknown> {
  return { ...o } as Record<string, unknown>;
}

/** `d.get(k, fallback)`：**键存在但值为 null 时返回 null**，不退回默认值。
 * `?? fallback` 在那种情况下会给出和 Python 不一样的结果。 */
function pyGet(d: Record<string, unknown>, k: string, fallback: unknown): unknown {
  return Object.hasOwn(d, k) ? d[k] : fallback;
}

function pyNumberStr(x: number): string {
  // Python 的 str(float) 对这三个有专名，json.dumps 那套（会抛）在这里不适用
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  // 整数 → "42"；非整数 → CPython `repr(float)` 的记号（1e-05 而不是 0.00001）
  return pyJsonDumps(x);
}

/** Python 的 `repr()`。字符串那一档复用 errors.ts 的 `pyRepr`（引号策略与
 * 非 ASCII 转义已经做到零差异，重写必踩）。 */
function reprOf(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  if (v === null) return "None";
  // JS 独有的"没有值"。Python 的容器里装不下它，出现在这里语义上就是缺值。
  if (v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNumberStr(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(reprOf).join(", ")}]`;
  if (v instanceof Map) {
    return `{${[...v].map(([k, val]) => `${reprOf(k)}: ${reprOf(val)}`).join(", ")}}`;
  }
  if (isRecord(v)) {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const parts = Object.entries(v).map(([k, val]) => `${pyRepr(k)}: ${reprOf(val)}`);
      return `{${parts.join(", ")}}`;
    }
  }
  // Date / 类实例 / Set：Python 那边走的是各自的 __repr__（`<Foo object at 0x…>`
  // 这类），跨语言本来就对不上。老老实实用 JS 的 String()，别假装能复现。
  return String(v);
}

/**
 * Python 的 `str()`。
 *
 * 用在 observation 上：`str(obs)[:4000]`。handler.dispatch 返回的多半是 dict
 * （工具结果、`{"error": …}`），而 `String({a:1})` 给的是 `"[object Object]"` ——
 * 直接用 JS 的 String() 会让模型在下一步看到一句 `[object Object]`，
 * 而这条 observation 同时进 prompt、进事件日志。
 *
 * **已知分叉**：JS 里 `1` 与 `1.0` 是同一个值，Python 侧值为整数的 float 印成
 * `1.0`，这里只能给 `1`（与 ids.ts / journal.ts 钉住的是同一条语言边界）。
 * 另外整数样式的对象键会被 V8 提到最前面，Python dict 保插入序。
 */
export function pyStr(v: unknown): string {
  return typeof v === "string" ? v : reprOf(v);
}

// ══════════════════════════════════════════════════════════════════
//  协作方的局部最小类型（见文件头 1）
// ══════════════════════════════════════════════════════════════════

/** `llm.Completion` 里 loop 真正读的两个字段。 */
export interface LoopCompletion {
  readonly text: string;
  readonly data: unknown;
}

export interface LoopCallOptions {
  readonly system?: string;
  readonly difficulty?: Difficulty;
  readonly schema?: Record<string, unknown> | null;
  readonly model?: unknown;
  readonly key?: string | null;
  readonly maxTokens?: number;
  readonly images?: readonly string[] | null;
}

/** `llm.RoutingTable` —— loop 只用它挑评委的对照模型。 */
export interface LoopRouting {
  modelFor(d: Difficulty): unknown;
}

export interface LoopGateway {
  readonly routing: LoopRouting;
  call(nodeId: string, prompt: string, opts?: LoopCallOptions): Promise<LoopCompletion>;
  iterationsFor(d: Difficulty): number;
  criticRoundsFor(d: Difficulty, requested?: number | null): number;
  samplesFor(d: Difficulty): number;
}

export interface LoopRecorder {
  nextAttempt(nodeId: string, checkpointVersion?: string | null): number;
  emit(
    kind: EventKind,
    opts?: { nodeId?: string | null; payload?: Record<string, unknown>; ref?: string | null },
  ): unknown;
  askHuman(nodeId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** `critic.Finding` 里 `_refine_prompt` 与 Reflexion 真正读的三个字段。 */
export interface LoopFinding {
  readonly code: string;
  readonly claim: string;
  readonly evidenceChecked?: readonly string[];
}

export interface LoopVerdict {
  readonly lens: string;
  readonly passed: boolean;
  readonly findings: readonly LoopFinding[];
}

/**
 * `critic.CriticContext`。**七个字段全给**（哪怕 loop 只关心其中四个）——
 * Python 那边构造出来的就是一个字段齐全的 dataclass，少写两个默认值会让
 * critic.ts 落地时这个对象结构上不再是 CriticContext。
 *
 * `gateway` / `generator` 声明成 `unknown` 是刻意的：critic.ts 里它们是
 * `JudgeGateway | null` / `JudgeModelSpec | null`（那边自己的局部最小类型）。
 * 写成具体类型会让两个接口**互相都不可赋值**，于是真的 `CriticPanel` 反而当不了
 * 这里的 `LoopPanel`；收成 `unknown` 后 CriticContext → LoopCriticContext 单向成立，
 * 方法参数的双变性就够用了。
 */
export interface LoopCriticContext {
  readonly nodeId: string;
  readonly gateway: unknown;
  readonly generator: unknown;
  readonly evidenceRender: string;
  readonly facts: string;
  readonly rules: string;
  readonly samples: number;
}

export interface LoopPanel {
  validate(lenses: readonly string[], nodeId: string): void;
  judge(
    draft: unknown,
    lenses: readonly string[],
    ctx: LoopCriticContext,
    opts?: { allowLlm?: boolean },
  ): Promise<LoopVerdict[]>;
}

/**
 * `memory.context.RenderedContext`。
 *
 * `stats()` 声明成 `object` 而不是 `Record<string, unknown>`：TS 的**隐式索引签名**
 * 只对匿名对象类型成立，`interface ContextStats {…}` 这种具名接口拿不到 ——
 * 写成 Record 的话真的 ContextManager 反而当不了这里的 LoopContextManager。
 * 摊平成 Record 由 {@link asRecord} 在出口处做一次。
 */
export interface LoopRendered {
  readonly text: string;
  stats(): object;
}

/**
 * 可选字段一律显式写上 `| undefined`。`exactOptionalPropertyTypes` 下 `q?: string`
 * 与 `q?: string | undefined` **不是**一回事：前者不接受显式传进来的 `undefined`，
 * 于是 memory/context.ts 的 `AssembleOptions`（那边写了 `| undefined`）就赋不过来，
 * 真的 ContextManager 反而当不了这里的 LoopContextManager。
 */
export interface LoopAssembleOptions {
  readonly task: string;
  readonly query?: string | undefined;
  readonly working?: LoopWorkingSet | null | undefined;
  readonly deps?: readonly string[] | null | undefined;
  readonly runId?: string | undefined;
  readonly evidenceFiles?: readonly string[] | null | undefined;
  readonly evidenceTopK?: number | undefined;
  readonly budgetTokens?: number | null | undefined;
}

export interface LoopContextManager {
  assemble(opts: LoopAssembleOptions): LoopRendered;
  reflect(lesson: string): void;
}

/**
 * `memory.short_term.Scratchpad`。`size` == Python 的 `__len__`（journal.ts /
 * blackboard.ts 已经定下这个译法）。
 *
 * `append` 是**位置参数**、`digest()` 返回 `object`：两处都照着已落地的
 * `memory/short_term.ts` 对齐，那边的 `Scratchpad` 要能直接当这个端口用。
 */
export interface LoopScratchpad {
  readonly size: number;
  append(thought?: string, action?: string, observation?: string): unknown;
  overBudget(threshold?: number): boolean;
  compactToFit(threshold?: number): number;
  render(): string;
  digest(maxTokens?: number): object;
}

/** `memory.short_term.WorkingSet`。 */
export interface LoopWorkingSet {
  select(nodeIds: readonly string[]): Record<string, unknown>;
}

/** `bus.bus.AgentBus` —— loop 只从黑板取事实。 */
export interface LoopBus {
  renderFacts(pattern?: string): string;
}

// ══════════════════════════════════════════════════════════════════
//  NodeResult
// ══════════════════════════════════════════════════════════════════

export interface NodeResult {
  readonly nodeId: string;
  readonly output: unknown;
  readonly verdicts: readonly LoopVerdict[];
  readonly digest: Record<string, unknown>;
  readonly iterations: number;
  readonly criticRounds: number;
  readonly contextStats: Record<string, unknown>;
}

export type NodeResultInit = Pick<NodeResult, "nodeId" | "output"> &
  Partial<Omit<NodeResult, "nodeId" | "output">>;

export function makeNodeResult(init: NodeResultInit): NodeResult {
  return {
    nodeId: init.nodeId,
    output: init.output,
    // 集合字段每次新建，绝不共享引用
    verdicts: [...(init.verdicts ?? [])],
    digest: { ...(init.digest ?? {}) },
    iterations: init.iterations ?? 0,
    criticRounds: init.criticRounds ?? 0,
    contextStats: { ...(init.contextStats ?? {}) },
  };
}

/**
 * 对应 `NodeResult.passed` 属性。
 *
 * **空裁决集返回 true** —— 这是 Python `all([])` 的语义，照抄。注意
 * `critic.metrics_from` 里的 `all_passed` **故意不是这样**（`bool(verdicts) and …`）：
 * 那里空面板算「未经评审」而不是「无瑕疵通过」。两处判据不同是有意的，别对齐。
 */
export function nodeResultPassed(r: NodeResult): boolean {
  return r.verdicts.every((v) => v.passed);
}

// ══════════════════════════════════════════════════════════════════
//  Handler
// ══════════════════════════════════════════════════════════════════

/**
 * 领域层挂到节点上的实现。
 *
 * 内核完全不知道什么是 ObjectType —— 它只知道调 handler 的这几个钩子。
 * 这条边界守住了，换领域只需重写 handler。
 */
export class NodeHandler {
  /** 产出的 JSON Schema。给了就强制结构化输出。 */
  schema: Record<string, unknown> | null = null;
  /** 追加到 L0 系统层的领域规范。 */
  system = "";

  /** 本节点的任务描述，进上下文。 */
  task(_inputs: Record<string, unknown>): string {
    return "完成本节点任务。";
  }

  /** 证据检索与长期记忆召回用的查询串。默认复用 task。 */
  query(inputs: Record<string, unknown>): string {
    return this.task(inputs);
  }

  /** DETERMINISTIC 模式的实现。其余模式不会调到这里。 */
  execute(_inputs: Record<string, unknown>, _ctx: RunContext): Promise<unknown> {
    return Promise.reject(new Error(`${this.constructor.name} 未实现 execute()`));
  }

  /** REACT / CODEACT 模式下执行一个动作，返回 observation。 */
  dispatch(_action: Record<string, unknown>, _ctx: RunContext): Promise<unknown> {
    return Promise.reject(new Error(`${this.constructor.name} 未实现 dispatch()`));
  }

  /**
   * 规则已经把这个节点算完了吗？算完了就返回结果，一次模型都不调。
   *
   * ADR-5 在节点级的落点。有些段（一行一问的问卷、一行一实体的登记表）映射完全
   * 确定，让模型再走一遍 agent loop 只有两个后果：为零信息量的复述付钱，以及
   * **模型一定会截断**导致丢行。
   *
   * 返回 `null` 表示这个节点确实需要推理（Python 是 `None`；TS 里 `undefined`
   * 同样算「没跳过」—— 没写 return 的重写不该被当成"跳过并产出 undefined"）。
   */
  skipModel(_inputs: Record<string, unknown>): unknown {
    return null;
  }

  /**
   * 产出定稿前的确定性加工。默认原样返回。
   *
   * 用来把"规则算出来的部分"并进模型产出。放在 critic 之前，让 critic 看到的
   * 就是节点最终交出去的东西。
   */
  finalize(draft: unknown, _inputs: Record<string, unknown>): unknown {
    return draft;
  }

  /** HITL 模式下要问人什么。 */
  humanRequest(draft: unknown, _inputs: Record<string, unknown>): Record<string, unknown> {
    return { draft };
  }

  /**
   * 按节点 id 解析出实际的 handler。
   *
   * fan-out 出来的实例（`EXTRACT.s0` / `EXTRACT.s1` …）共用一个注册名，但各自要
   * 处理不同的数据。默认返回自己；需要分派的 handler 覆盖它 —— 这样"段"仍然是
   * 数据，不必为每段往注册表里塞一个条目。
   */
  forNode(_nodeId: string): NodeHandler {
    return this;
  }
}

// ══════════════════════════════════════════════════════════════════
//  RunContext
// ══════════════════════════════════════════════════════════════════

export interface RunContextInit {
  readonly runId: string;
  readonly rec: LoopRecorder;
  readonly bus: LoopBus;
  readonly gateway: LoopGateway;
  readonly budget: Budget;
  readonly ctx: LoopContextManager;
  readonly nodeId?: string;
  readonly nodeToolLimit?: number | null;
  readonly nodeToolCalls?: number;
  /** 协作式取消信号。见 AgentLoop.run 的 opts.signal 注释。 */
  readonly signal?: AbortSignal | null;
}

/** 一次 Run 的共享环境，透传给 handler。 */
export class RunContext {
  readonly runId: string;
  readonly rec: LoopRecorder;
  readonly bus: LoopBus;
  readonly gateway: LoopGateway;
  readonly budget: Budget;
  readonly ctx: LoopContextManager;
  readonly nodeId: string;
  readonly nodeToolLimit: number | null;
  nodeToolCalls: number;
  readonly signal: AbortSignal | null;

  /** 循环边界的取消检查：中止即抛 NodeFailure(retryable=false)，调度器就地定案。 */
  assertAlive(): void {
    if (this.signal?.aborted === true) {
      throw new NodeFailure(this.nodeId, "已被停止（收到取消信号）", false);
    }
  }

  constructor(init: RunContextInit) {
    this.runId = init.runId;
    this.rec = init.rec;
    this.bus = init.bus;
    this.gateway = init.gateway;
    this.budget = init.budget;
    this.ctx = init.ctx;
    this.nodeId = init.nodeId ?? "";
    this.nodeToolLimit = init.nodeToolLimit ?? null;
    this.nodeToolCalls = init.nodeToolCalls ?? 0;
    this.signal = init.signal ?? null;
  }

  /**
   * Consume one call from the current node's frozen action budget.
   *
   * The global {@link Budget} protects the whole run; `NodeBudget.toolCalls` protects
   * one node from monopolising that allowance.  Keeping both counters is intentional:
   * a twenty-call node must not become a five-hundred-call node merely because the
   * run-level budget is large.
   */
  spendToolCall(): void {
    if (this.nodeToolLimit !== null && this.nodeToolCalls >= this.nodeToolLimit) {
      throw new BudgetExhausted("node_tool_calls", this.nodeToolLimit, this.nodeToolCalls);
    }
    this.nodeToolCalls += 1;
  }
}

/**
 * Cohort 子任务的运行环境。
 *
 * 同一节点内并发跑多个子任务时，effect 键不能再靠 Recorder 的
 * (node, version, seq) 自增序 —— 并发把 seq 变成到达顺序的竞态，恢复重放
 * 会把 A 的工具结果发给 B。这里给每个子任务一个**稳定前缀**（任务文本
 * 哈希），每读一次 `toolEffectKey` 就派发一个确定的递增键；tools.ts 恰好
 * 在每次真实调用前读一次（见 ToolCallCtx.toolEffectKey —— 那个字段声明
 * 至今，就是在等这里第一个写方）。
 *
 * **读取即消费**：除 tools 层外不要读这个 getter（spread/日志都会吃掉一个键）。
 */
export class CohortRunContext extends RunContext {
  private toolSeq = 0;
  constructor(
    init: RunContextInit,
    private readonly keyPrefix: string,
  ) {
    super(init);
  }
  get toolEffectKey(): string {
    const k = `${this.keyPrefix}:t${this.toolSeq}`;
    this.toolSeq += 1;
    return k;
  }
}

// ══════════════════════════════════════════════════════════════════
//  循环
// ══════════════════════════════════════════════════════════════════

/**
 * REACT / PLAN_EXECUTE 每一步的输出契约。
 *
 * 工具参数是 **JSON 字符串**而不是嵌套 object。原因是结构化输出的 strict 模式
 * 要求每个 object 声明完整的 properties 并关掉 additionalProperties —— 而工具
 * 参数的形状因工具而异，声明不出来。写成 object 的后果是模型**一个参数都传不了**：
 * 它会反复尝试调工具、反复被拒，最后在 thought 里写"args schema 不允许传任何参数"。
 * 这正是真实材料上撞到的。
 */
export const STEP_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["thought", "action"],
  properties: {
    thought: { type: "string" },
    action: {
      type: "object",
      required: ["kind", "tool", "args_json"],
      properties: {
        kind: { type: "string", enum: ["tool", "finish"] },
        tool: { type: "string", description: "kind=finish 时填空串" },
        args_json: {
          type: "string",
          description:
            '工具参数的 JSON 对象字符串，如 {"query":"计划金额"}；' + "kind=finish 时填 {}",
        },
      },
    },
  },
};

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["goal"],
        properties: { goal: { type: "string" }, tool: { type: "string" } },
      },
    },
  },
};

// ── Cohort（节点内受限并行）─────────────────────────────────────
/**
 * 子任务提案 schema。`maxItems` 由节点的 cohort_max 决定 —— 上限写进 schema
 * 是让模型**看得见**闸，而不是提完了再被代码砍（砍完的提案彼此可能不再自洽）。
 */
export function cohortPlanSchema(cohortMax: number): Record<string, unknown> {
  return {
    type: "object",
    required: ["subtasks"],
    properties: {
      subtasks: {
        type: "array",
        minItems: 1,
        maxItems: cohortMax,
        items: {
          type: "object",
          required: ["task"],
          properties: { task: { type: "string" } },
        },
      },
    },
  };
}

/** 单个子任务的收尾契约：结论 + 出处。出处必须逐字来自**本子任务**的工具返回。 */
export const COHORT_FINDING_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["finding", "cites"],
  properties: {
    finding: { type: "string" },
    cites: { type: "array", items: { type: "string" } },
  },
};

/** cohort 开关：params.cohort_max ≥ 2 才成立（1 个"并行"任务没有意义）。 */
export function cohortMaxOf(node: NodeSpec): number | null {
  const raw = node.params["cohort_max"];
  const n = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 2 ? n : null;
}

/** 每个子任务的步数上限：params.cohort_steps ∈ [1,5]，默认 3。 */
export function cohortStepsOf(node: NodeSpec): number {
  const raw = node.params["cohort_steps"];
  const n = typeof raw === "number" ? Math.floor(raw) : Number.NaN;
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}

/** 把 `args_json` 解析成参数字典。解析不了就返回空，让工具层报缺参。 */
export function parseActionArgs(action: Record<string, unknown>): Record<string, unknown> {
  // `a or b`：args_json 是空串 / 空 dict / None 时都落到 args 上
  const first = pyGet(action, "args_json", undefined);
  const raw = pyTruthy(first) ? first : pyGet(action, "args", undefined);
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const out: unknown = JSON.parse(raw);
    return isRecord(out) ? out : {};
  } catch {
    // Python 只吞 JSONDecodeError；JSON.parse 只会抛 SyntaxError，范围一致。
    // （细微分叉：Python 的 json.loads 认 NaN/Infinity 字面量，JSON.parse 不认。）
    return {};
  }
}

/** 对应 Python 模块私有的 `_fmt_action`。导出只是为了 golden 能直接打点。 */
export function fmtAction(action: Record<string, unknown>): string {
  const args = pyJsonDumps(pyGet(action, "args", {}), { defaultStr: true });
  return `${pyStr(pyGet(action, "tool", "?"))}(${pySlice(args, 300)})`;
}

/** 对应 Python 模块私有的 `_refine_prompt`。 */
export function refinePrompt(draft: unknown, verdicts: readonly LoopVerdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    for (const f of v.findings) {
      const checked = f.evidenceChecked ?? [];
      const tail = checked.length > 0 ? `（已核对: ${checked.slice(0, 3).join("、")}）` : "";
      lines.push(`- [${v.lens}/${f.code}] ${f.claim}${tail}`);
    }
  }
  const issues = lines.join("\n");
  const body = pySlice(pyJsonDumps(draft, { defaultStr: true }), 20_000);
  return (
    "评审提出了下面这些问题，逐条修掉，其余部分保持不变。\n\n" +
    `## 评审意见\n${issues}\n\n` +
    `## 当前产物\n${body}`
  );
}

export interface AgentLoopOptions {
  readonly gateway: LoopGateway;
  readonly ctxManager: LoopContextManager;
  readonly panel: LoopPanel;
  readonly bus: LoopBus;
  readonly recorder: LoopRecorder;
  readonly budget: Budget;
  readonly handlers: Record<string, NodeHandler>;
  /** 见文件头 2：Python 是在 `run()` 里直接 new Scratchpad 的。 */
  readonly newScratchpad: (budgetTokens: number) => LoopScratchpad;
  /** 相位计时的时钟（毫秒）。可注入 —— 测试要能钉住 profile 数字。默认 Date.now。 */
  readonly now?: () => number;
}

/**
 * §6.1 节点相位剖面：**单活跃相位**计时（produce/critique 内部确实串行 ——
 * 这个前提在 loop 内成立）。残差全部归 overhead，让**各桶之和恒等于节点墙钟**：
 * 拿去画饼图不需要任何解释。
 *
 * **走普通事件、不进 effect**：profile 没有 request，塞进指纹空间只会注入
 * 永不复用的键；resume 时已完成节点整个被 checkpoint 跳过，也不存在重复计费。
 * usd 只统计本层直接可见的 gw.call（sampling/critic_refine）；critic_judge 的
 * 钱在 panel 内部，v1 只记次数 —— 部分可见的钱如实标注比装作全知强。
 */
class PhaseClock {
  private readonly t0: number;
  private readonly ms = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private readonly usd = new Map<string, number>();
  constructor(private readonly now: () => number) {
    this.t0 = now();
  }
  async in<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const s = this.now();
    try {
      return await fn();
    } finally {
      this.ms.set(phase, (this.ms.get(phase) ?? 0) + (this.now() - s));
    }
  }
  inSync<T>(phase: string, fn: () => T): T {
    const s = this.now();
    try {
      return fn();
    } finally {
      this.ms.set(phase, (this.ms.get(phase) ?? 0) + (this.now() - s));
    }
  }
  hit(phase: string, usd?: unknown): void {
    this.calls.set(phase, (this.calls.get(phase) ?? 0) + 1);
    if (typeof usd === "number" && Number.isFinite(usd)) {
      this.usd.set(phase, (this.usd.get(phase) ?? 0) + usd);
    }
  }
  snapshot(): Record<string, unknown> {
    const wallclock = this.now() - this.t0;
    let sum = 0;
    const phases: Record<string, number> = {};
    for (const [k, v] of this.ms) {
      phases[k] = v;
      sum += v;
    }
    phases["overhead"] = Math.max(0, wallclock - sum);
    return {
      wallclock_ms: wallclock,
      phases_ms: phases,
      calls: Object.fromEntries(this.calls),
      ...(this.usd.size > 0 ? { usd_visible: Object.fromEntries(this.usd) } : {}),
    };
  }
}

/** 节点执行引擎。 */
export class AgentLoop {
  gw: LoopGateway;
  /** 相位计时时钟。 */
  nowMs: () => number;
  cm: LoopContextManager;
  /** 可写：测试与调度器会整体换掉评审面板（Python 侧同样是普通属性）。 */
  panel: LoopPanel;
  bus: LoopBus;
  rec: LoopRecorder;
  budget: Budget;
  handlers: Record<string, NodeHandler>;
  newScratchpad: (budgetTokens: number) => LoopScratchpad;

  constructor(o: AgentLoopOptions) {
    this.gw = o.gateway;
    this.cm = o.ctxManager;
    this.panel = o.panel;
    this.bus = o.bus;
    this.rec = o.recorder;
    this.budget = o.budget;
    this.handlers = o.handlers;
    this.newScratchpad = o.newScratchpad;
    this.nowMs = o.now ?? Date.now;
  }

  // ── 入口 ────────────────────────────────────────────────────
  async run(
    node: NodeSpec,
    opts: {
      working: LoopWorkingSet;
      deps: readonly string[];
      runId: string;
      checkpointVersion?: string | null;
      /**
       * 协作式取消。Scheduler 一直在传它（AgentLoopLike 也声明了），此前这里
       * 不收 —— 停止键按下后循环照跑到自然结束，钱照烧。取消只在**循环边界**查：
       * 正在飞的那次 HTTP 不截（截了也退不了款），下一步不再发。中止的表达是
       * NodeFailure(retryable=false) —— 调度器现有分支就地定案，零重试白烧。
       */
      signal?: AbortSignal;
    },
  ): Promise<NodeResult> {
    const { working, deps, runId } = opts;
    if (opts.signal?.aborted === true) {
      throw new NodeFailure(node.id, "已被停止（收到取消信号）", false);
    }
    const checkpointVersion = opts.checkpointVersion ?? null;
    // `dict.get` 而不是属性访问：`handlers["constructor"]` 在 JS 里会摸到原型链上的函数
    const base = Object.hasOwn(this.handlers, node.handler)
      ? this.handlers[node.handler]
      : undefined;
    if (base === undefined) {
      throw new NodeFailure(node.id, `未注册的 handler: ${pyRepr(node.handler)}`, false);
    }
    const handler = base.forNode(node.id);

    const attempt = this.rec.nextAttempt(node.id, checkpointVersion);
    this.rec.emit(EventKind.NODE_ENTERED, {
      nodeId: node.id,
      payload: {
        mode: node.mode,
        attempt,
        handler: node.handler,
        ...(checkpointVersion === null ? {} : { checkpoint_version: checkpointVersion }),
      },
    });

    // Python 是 `node.difficulty or self._route(...)`；Difficulty 的取值全是非空串，
    // 所以那个 `or` 等价于 `is None` 判断
    const difficulty = node.difficulty ?? this.route(node, working, deps);
    // CODEACT 的降级披露。CODEACT 与 REACT 共用同一个循环骨架，唯一该有的差别
    // 是动作空间里的 code.exec —— 而那个工具被环境开关 + 沙箱探活双重闸住，
    // 默认部署下根本不在。此时节点仍标着 mode=codeact 跑完：模型被系统提示
    // 要求"生成代码在沙箱跑"，实际没有执行器，只能靠读文本硬猜 —— 产物降档，
    // 而事件日志里 mode 照写 codeact，排查的人会以为代码路径真的跑过。
    // **贴牌运行必须变成可见事实**（与降级标记进产物是同一条纪律，见 730882f）。
    if (node.mode === NodeMode.CODEACT) {
      const reg = (this.bus as { read?: (k: string) => unknown }).read?.("_tools") as
        { forScope?: (s: string) => { spec: { name?: string } }[] } | null;
      const names = reg?.forScope?.("*")?.map((t) => pyStr(t.spec.name ?? "")) ?? [];
      if (!names.includes("code.exec")) {
        this.rec.emit(EventKind.DEGRADED, {
          nodeId: node.id,
          payload: {
            reason: "CODEACT_NO_SANDBOX",
            detail: "节点声明为 codeact，但动作空间里没有 code.exec（沙箱未启用）——按 react 降档运行",
          },
        });
      }
    }
    const inputs = working.select(deps);
    // Configuration is part of the frozen control plane.  Validate it before the
    // handler or model performs work, not only when/if the critic round is reached
    // (budget degradation can otherwise hide a misspelling).
    this.panel.validate(node.critics, node.id);
    const rctx = new RunContext({
      runId,
      rec: this.rec,
      bus: this.bus,
      gateway: this.gw,
      budget: this.budget,
      ctx: this.cm,
      nodeId: node.id,
      nodeToolLimit: node.budget.toolCalls,
      signal: opts.signal ?? null,
    });

    const pad = this.newScratchpad(Math.floor(node.budget.tokens / 2));
    const clock = new PhaseClock(this.nowMs);
    const skipped = handler.skipModel(inputs);
    let draft: unknown;
    let iters: number;
    if (skipped !== null && skipped !== undefined) {
      draft = skipped;
      iters = 0;
    } else {
      [draft, iters] = await this.produce(node, handler, inputs, rctx, pad, difficulty, clock);
    }
    // 规则产出在这里并进来 —— 必须**先于** critic，否则 critic 判的不是节点
    // 的真实产出，会对"模型没抽但规则已经抽了"的东西报缺失。
    draft = clock.inSync("finalize", () => handler.finalize(draft, inputs));

    // ── Critic 环 ────────────────────────────────────────────
    const rounds = this.gw.criticRoundsFor(difficulty, node.criticRounds);
    let verdicts: LoopVerdict[] = [];
    let done = 0;
    if (node.critics.length > 0 && rounds !== 0) {
      [draft, verdicts, done] = await this.critique(
        clock,
        node,
        handler,
        inputs,
        draft,
        difficulty,
        rounds,
        pad,
        rctx,
      );
    }

    // Gate enforcement deliberately lives in Scheduler's pre-commit boundary:
    // `node.gate` must be evaluated after this result exists, but before the output
    // enters WorkingSet or receives NODE_COMPLETED.  Keeping the loop side-effect free
    // also lets Scheduler support both serializable GateSpec and legacy runtime Gate.

    const rendered = this.cm.assemble({
      task: handler.task(inputs),
      query: handler.query(inputs),
      working,
      deps,
      runId,
      evidenceTopK: node.scope.evidenceTopK,
    });
    // §6.1：钱和时间花在哪个相位 —— 此前只有节点级 usd，答不出「$90 花在哪个阶段」
    this.rec.emit(EventKind.NODE_PROFILE, { nodeId: node.id, payload: clock.snapshot() });
    return makeNodeResult({
      nodeId: node.id,
      output: draft,
      verdicts,
      digest: asRecord(pad.digest()),
      iterations: iters,
      criticRounds: done,
      contextStats: asRecord(rendered.stats()),
    });
  }

  // ── 产出 ────────────────────────────────────────────────────
  private async produce(
    node: NodeSpec,
    handler: NodeHandler,
    inputs: Record<string, unknown>,
    rctx: RunContext,
    pad: LoopScratchpad,
    difficulty: Difficulty,
    clock: PhaseClock,
  ): Promise<[unknown, number]> {
    if (node.mode === NodeMode.DETERMINISTIC) {
      return [await clock.in("execute", () => handler.execute(inputs, rctx)), 0];
    }

    if (node.mode === NodeMode.HITL) {
      const requestId = `${node.id}:hitl`;
      // Python 这里传的是 `human_request(inputs, inputs)` —— 此刻还没有 draft，
      // 两个位置都塞 inputs。照抄，别"顺手修成 None"：handler 覆盖版读的是第一个参数。
      // human_wait 单独成桶：等人可能是几天，混进 overhead 会让剖面没法读；
      // 算 SLA 时把这一桶从分母里剔掉。
      const answer = await clock.in("human_wait", () =>
        this.rec.askHuman(node.id, requestId, handler.humanRequest(inputs, inputs)),
      );
      return [answer, 0];
    }

    const ctxText = clock.inSync("materialize", () => this.context(node, handler, inputs, rctx));

    if (node.mode === NodeMode.SINGLE_SHOT) {
      const comp = await clock.in("sampling", () => this.gw.call(node.id, ctxText, {
        system: handler.system,
        difficulty,
        schema: handler.schema,
        maxTokens: Math.min(node.budget.tokens, 16_000),
      }));
      clock.hit("sampling", (comp as { usage?: { usd?: unknown } }).usage?.usd);
      return [hasSchema(handler) ? comp.data : comp.text, 1];
    }

    return await this.iterate(node, handler, rctx, pad, difficulty, ctxText, clock);
  }

  /** REACT / PLAN_EXECUTE / CODEACT 的共用循环骨架。 */
  private async iterate(
    node: NodeSpec,
    handler: NodeHandler,
    rctx: RunContext,
    pad: LoopScratchpad,
    difficulty: Difficulty,
    ctxText: string,
    clock: PhaseClock,
  ): Promise<[unknown, number]> {
    const maxIters = Math.min(node.budget.iterations, this.gw.iterationsFor(difficulty));
    let steps: unknown[] | null = null;

    if (node.mode === NodeMode.PLAN_EXECUTE) {
      const cohortMax = cohortMaxOf(node);
      if (cohortMax !== null) {
        const cohortOut = await this.runCohort(
          node, handler, rctx, pad, difficulty, ctxText, clock, cohortMax,
        );
        // 提案为空时退回经典单线 plan-execute —— 空提案不该把节点打死。
        if (cohortOut !== null) return cohortOut;
      }
      const plan = await clock.in("sampling", () => this.gw.call(node.id, `${ctxText}\n\n先出一份可执行的分步计划。`, {
        system: handler.system,
        difficulty,
        schema: PLAN_SCHEMA,
        key: "plan",
      }));
      clock.hit("sampling", (plan as { usage?: { usd?: unknown } }).usage?.usd);
      const pd = isRecord(plan.data) ? plan.data : {};
      const raw = pyGet(pd, "steps", []);
      steps = Array.isArray(raw) ? raw : [];
      this.rec.emit(EventKind.PLAN_CREATED, { nodeId: node.id, payload: { steps } });
    }

    let i = 0;
    while (i < maxIters) {
      rctx.assertAlive();
      if (this.budget.mustHalt()) {
        throw new NodeFailure(node.id, "预算耗尽，已保存 checkpoint", false);
      }

      const prompt = AgentLoop.stepPrompt(ctxText, pad, steps);
      const comp = await clock.in("sampling", () => this.gw.call(node.id, prompt, {
        system: handler.system,
        difficulty,
        schema: STEP_SCHEMA,
        key: `step:${i}`,
      }));
      clock.hit("sampling", (comp as { usage?: { usd?: unknown } }).usage?.usd);
      const step = isRecord(comp.data) ? comp.data : {};
      // STEP_SCHEMA 保证 thought 是字符串（网关校验不过会抛，半成品到不了这里）；
      // 兜底成空串只是为了别让一次坏输出把整个节点炸掉
      const rawThought = pyGet(step, "thought", "");
      const thought = typeof rawThought === "string" ? rawThought : "";
      const rawAction = pyGet(step, "action", {});
      const action = isRecord(rawAction) ? rawAction : {};
      this.rec.emit(EventKind.THOUGHT, {
        nodeId: node.id,
        payload: { text: pySlice(thought, 800) },
      });
      i += 1;

      if (pyGet(action, "kind", undefined) === "finish") {
        pad.append(thought, "finish");
        break;
      }

      // 展开顺序照抄 Python 的 `{**action, "args": …}`：args 若已存在则原位覆盖
      const withArgs: Record<string, unknown> = { ...action, args: parseActionArgs(action) };
      const obs = await clock.in("tool_io", () => handler.dispatch(withArgs, rctx));
      clock.hit("tool_io");
      const obsText = pySlice(pyStr(obs), 4000);
      pad.append(thought, fmtAction(withArgs), obsText);
      this.rec.emit(EventKind.OBSERVATION, {
        nodeId: node.id,
        payload: { tool: pyGet(withArgs, "tool", ""), summary: pySlice(obsText, 400) },
      });
      if (pad.overBudget()) {
        const n = pad.compactToFit();
        this.rec.emit(EventKind.CONTEXT_COMPACTED, {
          nodeId: node.id,
          payload: { compactions: n },
        });
      }
    }

    const final = await clock.in("sampling", () => this.gw.call(
      node.id,
      `${ctxText}\n\n## 本节点已完成的工作\n${pad.render()}\n\n据此给出最终产出。`,
      {
        system: handler.system,
        difficulty,
        schema: handler.schema,
        key: "final",
        maxTokens: Math.min(node.budget.tokens, 16_000),
      },
    ));
    clock.hit("sampling", (final as { usage?: { usd?: unknown } }).usage?.usd);
    return [hasSchema(handler) ? final.data : final.text, i];
  }

  /**
   * PLAN_EXECUTE 的第二形态：**受限 Cohort**（§3，P1）。
   *
   * 外层图纹丝不动 —— 这里只是把一个节点内部的分析拆成至多 cohort_max 个
   * **互不依赖、只读**的并行子任务。每个子任务：自己的 CohortRunContext
   * （分摊后的工具额度 + 稳定 effect 键前缀）→ 至多 cohort_steps 步工具
   * 核实 → 一份"结论 + 逐字出处"的收尾。出处必须能在**本子任务自己的**
   * 工具返回里找到（converse.checkGrounding 同款判据），找不到的在合并时
   * 明标"不可采信"，不静默删除也不采信。
   *
   * 合并是**确定性代码**，不是又一次模型调用；真正的综合交给经典 final
   * （key 同为 "final"），critics 照常在外层把关。四类运行级异常
   * （QuotaExhausted / BudgetExhausted / HumanInputRequired / NodeFailure）
   * 从子任务里**原样穿透**，与 scheduler 的定案语义对齐；其余异常只算
   * 单个子任务失败，全军覆没才算节点失败。
   *
   * 返回 null = 提案为空，调用方退回经典路径。
   */
  private async runCohort(
    node: NodeSpec,
    handler: NodeHandler,
    rctx: RunContext,
    pad: LoopScratchpad,
    difficulty: Difficulty,
    ctxText: string,
    clock: PhaseClock,
    cohortMax: number,
  ): Promise<[unknown, number] | null> {
    const plan = await clock.in("sampling", () => this.gw.call(
      node.id,
      `${ctxText}\n\n把本节点要做的分析拆成至多 ${cohortMax} 个互不依赖、可并行的子任务。` +
        `每个子任务用一句话说清：要查什么、要回答什么。拆不出并行就只给 1 个。`,
      { system: handler.system, difficulty, schema: cohortPlanSchema(cohortMax), key: "cohort:plan" },
    ));
    clock.hit("sampling", (plan as { usage?: { usd?: unknown } }).usage?.usd);
    const pd = isRecord(plan.data) ? plan.data : {};
    const rawTasks = pyGet(pd, "subtasks", []);
    const tasks = (Array.isArray(rawTasks) ? rawTasks : [])
      .map((x) => (isRecord(x) ? pyStr(pyGet(x, "task", "")) : ""))
      .map((x) => x.trim())
      .filter((x) => x !== "")
      .slice(0, cohortMax); // schema 之外的第二道闸（老网关/宽松后端不认 maxItems）
    if (tasks.length === 0) return null;

    // 稳定键：任务**文本**哈希，不是数组下标 —— 恢复时提案顺序变了也命中同
    // 一份历史。同文重复靠出现序号消歧（同文子任务本就可互换，序号是稳定的）。
    const seen = new Map<string, number>();
    const keyed = tasks.map((task) => {
      const h = fingerprint(task);
      const n = seen.get(h) ?? 0;
      seen.set(h, n + 1);
      return { task, base: n === 0 ? `cohort:${h}` : `cohort:${h}:${n}` };
    });

    this.rec.emit(EventKind.PLAN_CREATED, {
      nodeId: node.id,
      payload: {
        steps: keyed.map((k) => ({ goal: k.task })),
        cohort: true,
        cohort_max: cohortMax,
        cohort_tasks: keyed.length,
      },
    });

    // 工具额度分摊：节点的冻结额度均分给子任务，至少 1 —— 并行不放大总额。
    const subLimit =
      rctx.nodeToolLimit === null ? null : Math.max(1, Math.floor(rctx.nodeToolLimit / keyed.length));

    interface CohortCite {
      readonly text: string;
      readonly grounded: boolean;
    }
    interface CohortResult {
      readonly task: string;
      readonly status: "ok" | "failed";
      readonly finding?: string;
      readonly cites?: readonly CohortCite[];
      readonly error?: string;
      readonly steps: number;
    }

    const stepsMax = cohortStepsOf(node);
    const runOne = async (task: string, base: string, idx: number): Promise<CohortResult> => {
      const subCtx = new CohortRunContext(
        {
          runId: rctx.runId,
          rec: this.rec,
          bus: this.bus,
          gateway: this.gw,
          budget: this.budget,
          ctx: this.cm,
          nodeId: node.id,
          nodeToolLimit: subLimit,
          signal: rctx.signal,
        },
        base,
      );
      const obsLog: string[] = [];
      const lines: string[] = [];
      let steps = 0;
      for (let j = 0; j < stepsMax; j++) {
        subCtx.assertAlive();
        if (this.budget.mustHalt()) {
          throw new NodeFailure(node.id, "预算耗尽，已保存 checkpoint", false);
        }
        const prompt =
          `${ctxText}\n\n## 你的并行子任务\n${task}\n` +
          (lines.length > 0 ? `\n## 已做步骤\n${lines.join("\n")}\n` : "") +
          `\n用工具核实；足够下结论就 finish。`;
        const comp = await clock.in("sampling", () => this.gw.call(node.id, prompt, {
          system: handler.system,
          difficulty,
          schema: STEP_SCHEMA,
          key: `${base}:step:${j}`,
        }));
        clock.hit("sampling", (comp as { usage?: { usd?: unknown } }).usage?.usd);
        const step = isRecord(comp.data) ? comp.data : {};
        const rawThought = pyGet(step, "thought", "");
        const thought = typeof rawThought === "string" ? rawThought : "";
        const rawAction = pyGet(step, "action", {});
        const action = isRecord(rawAction) ? rawAction : {};
        this.rec.emit(EventKind.THOUGHT, {
          nodeId: node.id,
          payload: { text: pySlice(thought, 800), cohort_task: idx },
        });
        steps += 1;
        if (pyGet(action, "kind", undefined) === "finish") break;
        const withArgs: Record<string, unknown> = { ...action, args: parseActionArgs(action) };
        const obs = await clock.in("tool_io", () => handler.dispatch(withArgs, subCtx));
        clock.hit("tool_io");
        const obsText = pySlice(pyStr(obs), 4000);
        obsLog.push(obsText);
        lines.push(`- ${thought} → ${fmtAction(withArgs)} → ${pySlice(obsText, 800)}`);
        this.rec.emit(EventKind.OBSERVATION, {
          nodeId: node.id,
          payload: {
            tool: pyGet(withArgs, "tool", ""),
            summary: pySlice(obsText, 400),
            cohort_task: idx,
          },
        });
      }
      const fin = await clock.in("sampling", () => this.gw.call(
        node.id,
        `${ctxText}\n\n## 你的并行子任务\n${task}\n\n## 你做过的步骤与工具返回\n` +
          `${lines.join("\n") || "（没有做任何工具调用）"}\n\n` +
          `给出子任务结论。cites 必须逐字摘自上面工具返回的原文；工具没返回过的不许引，查不到就说查不到。`,
        {
          system: handler.system,
          difficulty,
          schema: COHORT_FINDING_SCHEMA,
          key: `${base}:final`,
          maxTokens: Math.min(node.budget.tokens, 8_000),
        },
      ));
      clock.hit("sampling", (fin as { usage?: { usd?: unknown } }).usage?.usd);
      const fd = isRecord(fin.data) ? fin.data : {};
      const blob = obsLog.join("\n");
      const rawCites = pyGet(fd, "cites", []);
      const cites: CohortCite[] = (Array.isArray(rawCites) ? rawCites : [])
        .map((c) => pyStr(c).trim())
        .filter((c) => c !== "")
        .map((text) => ({ text, grounded: blob.includes(text) }));
      return { task, status: "ok", finding: pyStr(pyGet(fd, "finding", "")), cites, steps };
    };

    const settled = await Promise.allSettled(keyed.map((k, i) => runOne(k.task, k.base, i)));

    // 四类运行级异常原样穿透（与 scheduler 的定案分类对齐）。扫描顺序即优先级：
    // 欠费 > 预算 > 要人 > 取消/节点级失败 —— 同时出现时报最"硬"的那个。
    for (const cls of [QuotaExhausted, BudgetExhausted, HumanInputRequired, NodeFailure]) {
      for (const s of settled) {
        if (s.status === "rejected" && s.reason instanceof cls) throw s.reason;
      }
    }

    const results: CohortResult[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : { task: keyed[i]!.task, status: "failed", error: pyStr(s.reason), steps: 0 },
    );
    const okCount = results.filter((r) => r.status === "ok").length;
    if (okCount === 0) {
      const first = results.find((r) => r.error !== undefined);
      throw new NodeFailure(
        node.id,
        `cohort 全部 ${keyed.length} 个子任务失败：${pySlice(first?.error ?? "", 400)}`,
        true,
      );
    }

    // 确定性合并进 pad：结论逐条落盘，未落地的出处**明标**，不删也不采信。
    let stepsTotal = 0;
    for (const [i, r] of results.entries()) {
      stepsTotal += r.steps;
      if (r.status === "ok") {
        const citesLine = (r.cites ?? [])
          .map((c) =>
            c.grounded
              ? `「${pySlice(c.text, 120)}」`
              : `「${pySlice(c.text, 120)}」（未在工具返回中找到，不可采信）`,
          )
          .join("；");
        pad.append(
          `[子任务${i + 1}] ${r.task}`,
          "cohort",
          pySlice(`${r.finding ?? ""}\n出处：${citesLine || "（无出处 —— 结论未落地）"}`, 2000),
        );
      } else {
        pad.append(`[子任务${i + 1}] ${r.task}`, "cohort", `子任务失败：${pySlice(r.error ?? "", 400)}`);
      }
    }

    // 标准收尾：与经典路径同一个 "final" 键与 handler schema，critics 在外层照常把关。
    const final = await clock.in("sampling", () => this.gw.call(
      node.id,
      `${ctxText}\n\n## 并行子任务结论\n${pad.render()}\n\n` +
        `据此给出最终产出。标注「未在工具返回中找到」的出处不可采信，不要写进结论。`,
      {
        system: handler.system,
        difficulty,
        schema: handler.schema,
        key: "final",
        maxTokens: Math.min(node.budget.tokens, 16_000),
      },
    ));
    clock.hit("sampling", (final as { usage?: { usd?: unknown } }).usage?.usd);
    return [hasSchema(handler) ? final.data : final.text, stepsTotal];
  }

  // ── 评审 ────────────────────────────────────────────────────
  private async critique(
    clock: PhaseClock,
    node: NodeSpec,
    handler: NodeHandler,
    inputs: Record<string, unknown>,
    draft0: unknown,
    difficulty: Difficulty,
    rounds: number,
    pad: LoopScratchpad,
    rctx: RunContext,
  ): Promise<[unknown, LoopVerdict[], number]> {
    let draft = draft0;
    const generator = this.gw.routing.modelFor(difficulty);
    const cctx: LoopCriticContext = {
      nodeId: node.id,
      gateway: this.gw,
      generator,
      evidenceRender: "",
      facts: this.bus.renderFacts(node.scope.blackboardPattern),
      rules: "",
      samples: this.gw.samplesFor(difficulty),
    };
    let verdicts: LoopVerdict[] = [];
    let done = 0;

    for (let r = 0; r < rounds; r++) {
      rctx.assertAlive();
      verdicts = await clock.in("critic_judge", () => this.panel.judge(draft, node.critics, cctx, {
        allowLlm: this.budget.allowLlmCritic(),
      }));
      clock.hit("critic_judge");
      done = r + 1;
      if (verdicts.every((v) => v.passed)) break;

      // Reflexion：把教训写进本 Run 的记忆，后续节点自动规避同类错误
      for (const v of verdicts) {
        for (const f of v.findings) this.cm.reflect(`${v.lens}/${f.code}: ${f.claim}`);
      }

      const comp = await clock.in("critic_refine", () => this.gw.call(node.id, refinePrompt(draft, verdicts), {
        // Refinement is still the same domain agent.  Dropping its role/tool safety
        // system here lets a critic retry escape the constraints enforced on the
        // initial draft.
        system: handler.system,
        difficulty,
        schema: handler.schema,
        key: `refine:${r}`,
      }));
      clock.hit("critic_refine", (comp as { usage?: { usd?: unknown } }).usage?.usd);
      if (comp.data !== null && comp.data !== undefined) {
        // 修订产物同样要过 finalize。模型重出的那版 JSON 里只有它这次改的
        // 东西 —— 规则逐行抽好的部分（一段 45 行行动表的全部 action）不在
        // 里面，直接赋值就等于把它们删了。真实事故：168 行接口全部消失，
        // 而 critic 下一轮报的是「一个行动都没有」，看着像模型没抽。
        draft = handler.finalize(comp.data, inputs);
      }
      pad.append("", `refine#${r}`, `按 ${verdicts.length} 条评审意见修订`);

      // A refinement creates a new artifact.  Previously the last refinement was
      // returned with the verdict for its predecessor, so a regression introduced
      // on that last write could be committed without ever being reviewed.
      if (r === rounds - 1) {
        verdicts = await clock.in("critic_judge", () => this.panel.judge(draft, node.critics, cctx, {
          allowLlm: this.budget.allowLlmCritic(),
        }));
        clock.hit("critic_judge");
      }
    }

    return [draft, verdicts, done];
  }

  // ── 辅助 ────────────────────────────────────────────────────
  private context(
    node: NodeSpec,
    handler: NodeHandler,
    inputs: Record<string, unknown>,
    rctx: RunContext,
  ): string {
    const files = node.scope.evidenceFiles;
    const rendered = this.cm.assemble({
      task: handler.task(inputs),
      query: handler.query(inputs),
      runId: rctx.runId,
      evidenceTopK: node.scope.evidenceTopK,
      budgetTokens: node.budget.tokens,
      // `list(x or ()) or None`：null 和空列表都要落回 null
      evidenceFiles: files !== null && files.length > 0 ? [...files] : null,
    });
    const facts = this.bus.renderFacts(node.scope.blackboardPattern);
    let body = rendered.text;
    if (facts) body += `\n\n## 共享事实（黑板）\n${facts}`;
    if (Object.keys(inputs).length > 0) {
      body += `\n\n## 本节点输入\n${pySlice(pyJsonDumps(inputs, { defaultStr: true }), 12_000)}`;
    }
    return body;
  }

  /** 对应 Python 的 `_step_prompt` staticmethod。 */
  static stepPrompt(
    ctxText: string,
    pad: LoopScratchpad,
    steps: readonly unknown[] | null,
  ): string {
    const parts = [ctxText];
    if (steps !== null && steps.length > 0) {
      const plan = steps
        .map((s, i) => `${i + 1}. ${pyStr(isRecord(s) ? pyGet(s, "goal", "") : "")}`)
        .join("\n");
      parts.push(`## 计划\n${plan}`);
    }
    if (pad.size > 0) parts.push(`## 已做过的\n${pad.render()}`);
    parts.push("给出下一步：需要用工具就 kind=tool，已经够了就 kind=finish。");
    return parts.join("\n\n");
  }

  /**
   * 难度路由（DAAO 式）。输入规模 + 历史失败率决定档位。
   *
   * 刻意保持廉价 —— 路由本身花钱就本末倒置了。
   */
  route(node: NodeSpec, working: LoopWorkingSet, deps: readonly string[]): Difficulty {
    const size = estTokens(pyJsonDumps(working.select(deps), { defaultStr: true }));
    if (node.critics.length >= 3) return Difficulty.CRITICAL; // 挂了三个以上视角，说明这步不能错
    if (size > 40_000) return Difficulty.HIGH;
    if (size > 4_000) return Difficulty.MEDIUM;
    return Difficulty.LOW;
  }
}

/**
 * Python 的 `if handler.schema:` 是**真值**判断，而空 dict 在 Python 里是假。
 * 直接写 `handler.schema !== null` 会让 `schema = {}` 的 handler 走进结构化分支、
 * 拿到 `comp.data` 而不是 `comp.text` —— 一个字都不用改就能让产物换一种类型。
 */
function hasSchema(handler: NodeHandler): boolean {
  return handler.schema !== null && Object.keys(handler.schema).length > 0;
}
