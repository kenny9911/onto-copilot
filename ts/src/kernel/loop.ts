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
import { BudgetExhausted, NodeFailure, pyRepr } from "./errors.js";
import { EventKind } from "./events.js";
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
  nextAttempt(nodeId: string): number;
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
}

/** 节点执行引擎。 */
export class AgentLoop {
  gw: LoopGateway;
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
  }

  // ── 入口 ────────────────────────────────────────────────────
  async run(
    node: NodeSpec,
    opts: { working: LoopWorkingSet; deps: readonly string[]; runId: string },
  ): Promise<NodeResult> {
    const { working, deps, runId } = opts;
    // `dict.get` 而不是属性访问：`handlers["constructor"]` 在 JS 里会摸到原型链上的函数
    const base = Object.hasOwn(this.handlers, node.handler)
      ? this.handlers[node.handler]
      : undefined;
    if (base === undefined) {
      throw new NodeFailure(node.id, `未注册的 handler: ${pyRepr(node.handler)}`, false);
    }
    const handler = base.forNode(node.id);

    const attempt = this.rec.nextAttempt(node.id);
    this.rec.emit(EventKind.NODE_ENTERED, {
      nodeId: node.id,
      payload: { mode: node.mode, attempt, handler: node.handler },
    });

    // Python 是 `node.difficulty or self._route(...)`；Difficulty 的取值全是非空串，
    // 所以那个 `or` 等价于 `is None` 判断
    const difficulty = node.difficulty ?? this.route(node, working, deps);
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
    });

    const pad = this.newScratchpad(Math.floor(node.budget.tokens / 2));
    const skipped = handler.skipModel(inputs);
    let draft: unknown;
    let iters: number;
    if (skipped !== null && skipped !== undefined) {
      draft = skipped;
      iters = 0;
    } else {
      [draft, iters] = await this.produce(node, handler, inputs, rctx, pad, difficulty);
    }
    // 规则产出在这里并进来 —— 必须**先于** critic，否则 critic 判的不是节点
    // 的真实产出，会对"模型没抽但规则已经抽了"的东西报缺失。
    draft = handler.finalize(draft, inputs);

    // ── Critic 环 ────────────────────────────────────────────
    const rounds = this.gw.criticRoundsFor(difficulty, node.criticRounds);
    let verdicts: LoopVerdict[] = [];
    let done = 0;
    if (node.critics.length > 0 && rounds !== 0) {
      [draft, verdicts, done] = await this.critique(
        node,
        handler,
        inputs,
        draft,
        difficulty,
        rounds,
        pad,
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
  ): Promise<[unknown, number]> {
    if (node.mode === NodeMode.DETERMINISTIC) {
      return [await handler.execute(inputs, rctx), 0];
    }

    if (node.mode === NodeMode.HITL) {
      const requestId = `${node.id}:hitl`;
      // Python 这里传的是 `human_request(inputs, inputs)` —— 此刻还没有 draft，
      // 两个位置都塞 inputs。照抄，别"顺手修成 None"：handler 覆盖版读的是第一个参数。
      const answer = await this.rec.askHuman(
        node.id,
        requestId,
        handler.humanRequest(inputs, inputs),
      );
      return [answer, 0];
    }

    const ctxText = this.context(node, handler, inputs, rctx);

    if (node.mode === NodeMode.SINGLE_SHOT) {
      const comp = await this.gw.call(node.id, ctxText, {
        system: handler.system,
        difficulty,
        schema: handler.schema,
        maxTokens: Math.min(node.budget.tokens, 16_000),
      });
      return [hasSchema(handler) ? comp.data : comp.text, 1];
    }

    return await this.iterate(node, handler, rctx, pad, difficulty, ctxText);
  }

  /** REACT / PLAN_EXECUTE / CODEACT 的共用循环骨架。 */
  private async iterate(
    node: NodeSpec,
    handler: NodeHandler,
    rctx: RunContext,
    pad: LoopScratchpad,
    difficulty: Difficulty,
    ctxText: string,
  ): Promise<[unknown, number]> {
    const maxIters = Math.min(node.budget.iterations, this.gw.iterationsFor(difficulty));
    let steps: unknown[] | null = null;

    if (node.mode === NodeMode.PLAN_EXECUTE) {
      const plan = await this.gw.call(node.id, `${ctxText}\n\n先出一份可执行的分步计划。`, {
        system: handler.system,
        difficulty,
        schema: PLAN_SCHEMA,
        key: "plan",
      });
      const pd = isRecord(plan.data) ? plan.data : {};
      const raw = pyGet(pd, "steps", []);
      steps = Array.isArray(raw) ? raw : [];
      this.rec.emit(EventKind.PLAN_CREATED, { nodeId: node.id, payload: { steps } });
    }

    let i = 0;
    while (i < maxIters) {
      if (this.budget.mustHalt()) {
        throw new NodeFailure(node.id, "预算耗尽，已保存 checkpoint", false);
      }

      const prompt = AgentLoop.stepPrompt(ctxText, pad, steps);
      const comp = await this.gw.call(node.id, prompt, {
        system: handler.system,
        difficulty,
        schema: STEP_SCHEMA,
        key: `step:${i}`,
      });
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
      const obs = await handler.dispatch(withArgs, rctx);
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

    const final = await this.gw.call(
      node.id,
      `${ctxText}\n\n## 本节点已完成的工作\n${pad.render()}\n\n据此给出最终产出。`,
      {
        system: handler.system,
        difficulty,
        schema: handler.schema,
        key: "final",
        maxTokens: Math.min(node.budget.tokens, 16_000),
      },
    );
    return [hasSchema(handler) ? final.data : final.text, i];
  }

  // ── 评审 ────────────────────────────────────────────────────
  private async critique(
    node: NodeSpec,
    handler: NodeHandler,
    inputs: Record<string, unknown>,
    draft0: unknown,
    difficulty: Difficulty,
    rounds: number,
    pad: LoopScratchpad,
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
      verdicts = await this.panel.judge(draft, node.critics, cctx, {
        allowLlm: this.budget.allowLlmCritic(),
      });
      done = r + 1;
      if (verdicts.every((v) => v.passed)) break;

      // Reflexion：把教训写进本 Run 的记忆，后续节点自动规避同类错误
      for (const v of verdicts) {
        for (const f of v.findings) this.cm.reflect(`${v.lens}/${f.code}: ${f.claim}`);
      }

      const comp = await this.gw.call(node.id, refinePrompt(draft, verdicts), {
        difficulty,
        schema: handler.schema,
        key: `refine:${r}`,
      });
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
        verdicts = await this.panel.judge(draft, node.critics, cctx, {
          allowLlm: this.budget.allowLlmCritic(),
        });
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
