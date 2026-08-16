/**
 * DAG 调度器 —— 依赖一就绪就开跑，不搞人为的阶段屏障。移植自 `kernel/scheduler.py`。
 *
 * **流水线是默认，屏障是例外**：节点依赖具体上游就是流水线（某个文件解析慢不
 * 阻塞其它文件的抽取），依赖 `EXTRACT.*` 通配才形成同步屏障。整份 DAG 里真正
 * 需要等齐的只有两处 —— 实体对齐（要全局视野才能聚类）和澄清排序（要看到全部
 * 冲突才能选 top-3）。
 *
 * 崩溃恢复是两级的：历史里有 `NODE_COMPLETED` 的节点整个跳过；崩在半路的节点
 * 重跑，但它已完成的 effect 从日志读回（见 recorder）。
 *
 * ══════════════════════════════════════════════════════════════════
 *  取消：Node 上没有真正的任务取消，所以这里**不假装有**（CONTRACT §2.2）
 * ══════════════════════════════════════════════════════════════════
 *
 * Python 侧 `task.cancel()` 会在协程的下一个 await 点抛 `CancelledError`，节点
 * 真的会停下来。JS 的 Promise 一旦创建就没有对等物 —— 没有任何办法从外部让
 * 一个正在跑的 async 函数停下。所以这一层给出的是**两条不同强度的承诺**，
 * 分开写清楚，免得有人把弱的那条当强的用：
 *
 *   1. **硬承诺（不依赖任何人配合）：结果隔离。** Run 一旦定案（失败 / 挂起 /
 *      预算耗尽），还在跑的节点**无论最后成功与否，产出都不会被采纳** ——
 *      不写 `working`、不进 `RunOutcome.results`、**尤其不会调
 *      `rec.completeNode`**。最后一条是关键：`NODE_COMPLETED` 是崩溃恢复的
 *      判据，一个属于已失败 Run 的节点若被记成已完成，下次 resume 会直接跳过
 *      它并把那份没人审过的产出当成事实。这条靠结构保证 —— 提交的动作全在
 *      调度循环里，而调度循环已经 return 了，没有别的路径能写到那三处。
 *
 *   2. **软承诺（要节点配合）：`AbortSignal`。** 每个节点拿到一个 signal，
 *      Run 定案时 abort。愿意听的（HTTP 客户端、循环里查 signal 的 handler）
 *      会早点停下，省下真金白银的 token；不听的**会一直跑到自己结束**。
 *      本层自己唯一会查 signal 的地方是「刚拿到信号量 permit 时」——
 *      还在排队的节点因此可以一次模型调用都不发。注意这个检查也有个关不掉的
 *      窗口：permit 是在**失败节点自己的 finally**里交出去的，比调度循环观察到
 *      那次失败早一个微任务，所以紧挨着它的那一个等待者照样会开跑。想把它也
 *      堵上就只能给交接加人为延迟 —— 那是用时序魔法伪装成取消。
 *
 * 所以「取消之后正在跑的节点会怎样」的老实答案是：
 *   · 它可能继续跑到完，CPU、网络请求、已经发出去的模型调用都不会消失；
 *   · 它在网关那边花掉的钱照样花掉。`RunOutcome.budget` 是**定案那一刻**的
 *     快照，之后落账的花费不在里面 —— 快照会少算，别拿它当最终账单；
 *   · 它仍可能往 journal 里写事件（比如它自己的 GATE_EVALUATED），事件流的
 *     尾巴上因此可能出现 RUN_FAILED 之后的节点事件。Python 侧也有这个窗口，
 *     只是窄得多。重放不受影响：这些事件都不是 NODE_COMPLETED。
 *
 * 顺带的两个实现约束：
 *   · 每个在飞的 promise 在创建时就挂了 handler（包装函数**永不 reject**），
 *     被放弃的节点抛错不会触发 `unhandledRejection` 把进程打死（CONTRACT §2.1
 *     里 journal 那条同理）；
 *   · 信号量的 permit 在节点函数返回时释放，和 Python 同步 —— 被放弃的工作
 *     不再占坑。代价是它继续跑时真实并发可能短暂超过 concurrency。
 *
 * ══════════════════════════════════════════════════════════════════
 *  依赖：能 import 的一律 import，只有三处留结构化接口
 * ══════════════════════════════════════════════════════════════════
 *
 * `critic`（Decision / Gate / GateResult）、`llm`（QuotaExhausted）、
 * `memory/short_term`（WorkingSet）全部直接 import —— 同一个语义留两份实现
 * 迟早漂成两种行为，而且没人会发现。**异常与 gate 的分派因此是按类型的**
 * （`instanceof QuotaExhausted` / `instanceof Gate`），和 Python 的 isinstance 一致。
 *
 * 只有 `AgentLoop` / `Recorder` / `AgentBus` 留结构化接口（`*Like`）：
 *   · 它们是**有依赖的大对象**（网关、上下文管理器、blob store），测试里必须能换；
 *   · loop.ts / recorder.ts / bus.ts 自己也是这么对下游声明的（`LoopRecorder`
 *     / `LoopWorkingSet`），两边口径一致；
 *   · 真类是结构化兼容的 —— 测试里有一条编译期断言钉住这件事，接线时不需要 cast。
 *
 * `NodeResultLike.verdicts` 用的是**松口径**的 {@link VerdictLike} 而不是
 * `critic.Verdict`：loop.ts 把 `NodeResult.verdicts` 声明成 `LoopVerdict`
 * （findings 只有 code/claim，没有 severity），用严口径会让真的 `AgentLoop`
 * 结构上不满足 {@link AgentLoopLike}，接线处只能靠 `as` 把这条分叉藏起来。
 */

import { DegradeLevel, degradeLabel } from "./budget.js";
import type { Budget } from "./budget.js";
import { Decision, Gate } from "./critic.js";
import type { GateResult } from "./critic.js";
import type { Dag, GateSpec, NodeSpec } from "./dag.js";
import { BudgetExhausted, HumanInputRequired, NodeFailure, pyRepr } from "./errors.js";
import { EventKind } from "./events.js";
import { QuotaExhausted } from "./llm.js";
import { WorkingSet } from "./memory/short_term.js";

export { Decision };
export type { GateResult };

// ══════════════════════════════════════════════════════════════════
//  Python 原语的对齐层
// ══════════════════════════════════════════════════════════════════

/**
 * Python str 的空白集：比 JS 的 `\s` 多 \x1c-\x1f 与 \x85，少 ﻿(U+FEFF)。
 * gate 表达式来自 DAG 定义（人写的 YAML / 代码），削掉的是哪几个字符会直接
 * 决定 `"all_passed == true\x85"` 这种串是过还是抛。
 */
const PY_SPACE =
  "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680" +
  "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

/** `str.strip()`。 */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/**
 * Python str 比较按 code point；JS 的 `<` 与 `Array.sort()` 按 UTF-16 code unit。
 * 节点 id 里出现代理对（emoji 文件名扇出）时两套基准分叉，而 ready 集合的排序
 * 决定了节点的启动顺序 —— 顺序一漂，重放就废。
 *
 * dag.ts 里有同一份逻辑（那边没导出）。为一个私有排序基准去改不属于本 track
 * 的文件不划算，等 errors/utils 层收拢时再合并。
 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/** `sorted(xs)` 的等价物：新数组 + code point 序。 */
function sortedCp(xs: Iterable<string>): string[] {
  return [...xs].sort(codePointCompare);
}

/** Python `f"{list_of_str}"` —— 元素走 repr。复用 errors.ts 的 `pyRepr`，
 *  同一个格式化留两份实现迟早漂成两种错误文本，而且没人会发现。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/**
 * Python `type(x).__name__`。
 *
 * 优先 `constructor.name` 而不是 `err.name`：前者才是「类名」，后者是可以被
 * 任意赋值的实例字段（DOMException 就是 constructor.name="DOMException" 而
 * name="AbortError"）。errors.ts 的九个类两者相同，分歧只出现在外来异常上。
 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") {
    if (Object.getPrototypeOf(v) === Object.prototype) return "dict";
    const name = (v as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === "string" && name !== "") return name;
    if (v instanceof Error) return v.name;
    return "object";
  }
  return typeof v;
}

/** Python `str(exc)` —— 只有消息，没有类名前缀（JS 的 `String(err)` 会带上）。 */
function pyStr(v: unknown): string {
  if (v instanceof Error) return v.message;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** 只认自有键 —— Python 的 `in dict` 不看原型链，而 JS 的 `in` 会把
 *  `"toString"` / `"constructor"` 也算进去，那会让 gate 表达式读到根本不存在的
 *  「指标」并返回一个函数。 */
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** `isinstance(x, dict)` 的近似：普通对象。数组、null、类实例都不算。 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

// ══════════════════════════════════════════════════════════════════
//  ports —— 只给那三个「有依赖的大对象」，见文件头
// ══════════════════════════════════════════════════════════════════

/** `critic.Finding` 里调度器用得到的部分。`severity` 是可选的：loop.ts 的
 *  `LoopFinding` 类型上没有这个字段（运行期有），见文件头最后一段。 */
export interface FindingLike {
  readonly severity?: string;
  readonly code: string;
}

/** `critic.Verdict` 里调度器用得到的部分。`high` 是 Python 侧的计算属性，
 *  这里照它的定义从 findings 现算，不依赖对方存不存这个字段。 */
export interface VerdictLike {
  readonly lens: string;
  readonly passed: boolean;
  readonly findings: readonly FindingLike[];
}

/** `loop.NodeResult` 里调度器用得到的部分。 */
export interface NodeResultLike {
  readonly output: unknown;
  readonly verdicts?: readonly VerdictLike[];
  readonly digest?: Record<string, unknown>;
}

/** `loop.AgentLoop`。`signal` 是本 track 加的（Python 没有）——
 *  见文件头「软承诺」：实现方可以完全忽略它。 */
export interface AgentLoopLike {
  run(
    node: NodeSpec,
    opts: {
      readonly working: WorkingSet;
      readonly deps: string[];
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<NodeResultLike>;
}

/** `recorder.Recorder`。emit 之外的几个方法在 TS 侧可能是异步的
 *  （blob 落盘走 Promise），所以返回值一律允许 `Promise`，调用点 await。 */
export interface RecorderLike {
  // 字段口径与 recorder.ts 的 `EmitOptions` 逐字对齐（`string | null` 而不是
  // `string`）—— 差一个 null 就会让真的 Recorder 结构上不满足 critic 的
  // `EventSink`，而老式 Gate 正是拿这个 rec 去发事件的。
  emit(
    kind: EventKind,
    opts?: {
      readonly nodeId?: string | null;
      readonly payload?: Record<string, unknown>;
      readonly ref?: string | null;
    },
  ): unknown;
  nodeIsComplete(nodeId: string): boolean;
  nodeOutput(nodeId: string): unknown;
  completeNode(nodeId: string, output: unknown): void | Promise<void>;
  /** 历史里有答案就返回答案，否则发 HUMAN_REQUESTED 并抛 {@link HumanInputRequired}。 */
  askHuman(nodeId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** `bus.AgentBus` 里调度器用得到的部分。 */
export interface BusLike {
  broadcast(opts: {
    readonly frm: string;
    readonly topic: string;
    readonly payload?: Record<string, unknown>;
  }): unknown;
}

/**
 * `critic.metricsFrom` 的松口径版本。
 *
 * **不是重写**：算法与 critic.ts 的那份逐行一致，测试里有一条用例拿两者对跑
 * 同一批 verdict 断言结果相等（drift 会当场红）。之所以不能直接调它 ——
 * 它要的是严口径的 `critic.Verdict`，而调度器拿到的是 `loop.NodeResult.verdicts`
 * （类型上是 `LoopVerdict`，没有 severity），见文件头最后一段。
 *
 * 空 panel 是「未评审」而不是「无病呻吟地通过」：没有任何 verdict 时
 * `all_passed` 必须是 false，否则 `all_passed == true` 这道门对一个根本没跑过
 * critic 的节点会直接放行。
 */
export function metricsFromVerdicts(verdicts: readonly VerdictLike[]): Record<string, unknown> {
  const byLens: Record<string, boolean> = {};
  const highByLens: Record<string, number> = {};
  const findingsByLens: Record<string, number> = {};
  const codes = new Set<string>();
  let high = 0;
  let total = 0;
  for (const v of verdicts) {
    const vHigh = v.findings.filter((f) => f.severity === "high").length;
    byLens[v.lens] = v.passed;
    highByLens[v.lens] = vHigh;
    findingsByLens[v.lens] = v.findings.length;
    high += vHigh;
    total += v.findings.length;
    for (const f of v.findings) codes.add(f.code);
  }
  return {
    review_count: verdicts.length,
    all_passed: verdicts.length > 0 && verdicts.every((v) => v.passed),
    high_findings: high,
    total_findings: total,
    by_lens: byLens,
    high_by_lens: highByLens,
    findings_by_lens: findingsByLens,
    codes: sortedCp(codes),
  };
}

/**
 * `llm.QuotaExhausted` 的识别 —— **按类型**，和 Python 的
 * `except QuotaExhausted` 一样（子类照接）。
 *
 * 留一个可注入的口子（{@link SchedulerOptions.isQuotaExhausted}）是给这种情形：
 * 网关实现被包了一层、欠费信号以别的异常类型冒出来。默认永远是类型判据。
 */
export function isQuotaExhausted(e: unknown): boolean {
  return e instanceof QuotaExhausted;
}

// ══════════════════════════════════════════════════════════════════
//  Run 结果
// ══════════════════════════════════════════════════════════════════

export const RunStatus = {
  COMPLETED: "completed",
  SUSPENDED: "suspended", // 等人工决策
  FAILED: "failed",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

const RUN_STATUSES = new Set<string>(Object.values(RunStatus));

/** 对应 Python `RunStatus(value)` —— 未知值抛错，不做 `as` 断言。 */
export function parseRunStatus(value: string): RunStatus {
  if (!RUN_STATUSES.has(value)) throw new Error(`未知的 RunStatus: ${pyRepr(value)}`);
  return value as RunStatus;
}

export interface RunOutcome {
  readonly status: RunStatus;
  readonly outputs: Record<string, unknown>;
  readonly results: Record<string, NodeResultLike>;
  readonly pendingHuman: Record<string, unknown> | null;
  readonly error: string;
  readonly skipped: string[];
  /** 实际总是 `budget.snapshot()` 的 dict 形态；Python 的 dataclass
   *  默认值是 `{}`，照抄以免出现一个「一定有 level 字段」的假承诺。
   *  注意它是**定案那一刻**的快照，见文件头关于取消的说明。 */
  readonly budget: Readonly<Record<string, unknown>>;
}

/** dataclass 的默认值走工厂里的显式常量 —— 别用 class field 默认值。 */
export function makeRunOutcome(init: Partial<RunOutcome> & Pick<RunOutcome, "status">): RunOutcome {
  return {
    status: init.status,
    outputs: { ...(init.outputs ?? {}) },
    results: { ...(init.results ?? {}) },
    pendingHuman: init.pendingHuman ?? null,
    error: init.error ?? "",
    skipped: [...(init.skipped ?? [])],
    budget: init.budget ?? {},
  };
}

/** Python 侧是 `RunOutcome.ok` 属性。做成函数是为了让 RunOutcome 保持纯数据
 *  （能 JSON 往返），属性形态会在序列化时多出一个字段。 */
export function runOutcomeOk(outcome: RunOutcome): boolean {
  return outcome.status === RunStatus.COMPLETED;
}

/** `dict(working.outputs)`。 */
function outputsCopy(ws: WorkingSet): Record<string, unknown> {
  return { ...ws.outputs };
}

// ══════════════════════════════════════════════════════════════════
//  并发原语
// ══════════════════════════════════════════════════════════════════

/**
 * `asyncio.Semaphore` 的等价物：FIFO，release 时把 permit **直接交给**下一个
 * 等待者而不是先还回计数 —— 后者会让新来的调用插队，节点启动顺序不再确定。
 */
class Semaphore {
  private permits: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) this.permits -= 1;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return; // 幂等：finally 里放一次，别的路径再放不会多出 permit
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.permits += 1;
      else next();
    };
  }
}

/** 节点墙钟到点。对应 Python 里 `asyncio.timeout` 抛的内建 `TimeoutError`。 */
class NodeTimeout extends Error {
  constructor() {
    super("node wallclock deadline exceeded");
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, NodeTimeout.prototype);
  }
}

/** Python 的 `except TimeoutError` 也会接住 loop 内部抛出来的 TimeoutError
 *  （3.11 起 asyncio.TimeoutError 就是内建的那个），所以这里按名字一起认。 */
function isTimeout(e: unknown): boolean {
  return e instanceof NodeTimeout || (e instanceof Error && e.name === "TimeoutError");
}

/** Run 已定案，节点连开始都不必了。只在包装层内部流通，不会外泄。 */
const ABANDONED = Symbol("scheduler.abandoned");

/**
 * `async with asyncio.timeout(remaining)` 的**弱**等价物：到点就让外层拿到
 * TimeoutError，但**里面那个 promise 停不下来**（见文件头）。
 *
 * `p.then(ok, err)` 在这里同时起了「挂 handler」的作用：即使外层已经因超时
 * 定案，里面稍后的 reject 也算被处理过，不会触发 unhandledRejection。
 *
 * **定时器故意不 unref。** 代价是：被放弃却还在跑的节点会把进程多留住最多一个
 * 节点墙钟（默认 300s）。换来的是另一头：`loop.run` 卡在一个永远不会来的事件上
 * 时（socket 断了、await 了一个没人 resolve 的 promise），进程本来会因为无事可做
 * 而直接退出、调用方连 RunOutcome 都拿不到；留着这个定时器，那种情况会走成一条
 * 干净的「超过节点墙钟上限」失败。要交付一个结论，不要交付一次静默退出。
 */
function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NodeTimeout()), Math.max(0, seconds * 1000));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

type Settled =
  | { readonly ok: true; readonly value: NodeResultLike }
  | { readonly ok: false; readonly error: unknown };

interface Inflight {
  readonly nid: string;
  readonly abort: AbortController;
  /** 永不 reject —— 失败被收进 `settled`。 */
  done: Promise<void>;
  settled: Settled | null;
}

// ══════════════════════════════════════════════════════════════════
//  Scheduler
// ══════════════════════════════════════════════════════════════════

/** 并发节点数上限的默认值 —— 再高通常是被模型端限流卡住，而不是被本地 CPU 卡住。 */
export const DEFAULT_CONCURRENCY = 8;

export interface SchedulerOptions {
  /** 并发节点数上限。 */
  readonly concurrency?: number;
  /** 欠费判据。默认 `e instanceof QuotaExhausted`，见 {@link isQuotaExhausted}。 */
  readonly isQuotaExhausted?: (e: unknown) => boolean;
}

export class Scheduler {
  readonly dag: Dag;
  readonly loop: AgentLoopLike;
  readonly rec: RecorderLike;
  readonly bus: BusLike;
  readonly budget: Budget;

  private readonly sem: Semaphore;
  private readonly isQuota: (e: unknown) => boolean;

  private level: DegradeLevel = DegradeLevel.NONE;
  private runDeadline: number | null = null;
  private wallclockMark: number | null = null;

  constructor(
    dag: Dag,
    loop: AgentLoopLike,
    recorder: RecorderLike,
    bus: BusLike,
    budget: Budget,
    options: SchedulerOptions = {},
  ) {
    if (!dag.frozen) {
      // Python 抛的是裸 RuntimeError（不是 HarnessError 家族），照搬成 Error：
      // 全仓没有任何地方按类型 catch 它，它就是一条 fail-fast 的编程错误。
      throw new Error(
        "DAG 未冻结就交给调度器执行。冻结是安全边界 —— " +
          "必须在读取任何材料内容之前完成（见架构文档 §4.5.1）。",
      );
    }
    this.dag = dag;
    this.loop = loop;
    this.rec = recorder;
    this.bus = bus;
    this.budget = budget;
    this.sem = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.isQuota = options.isQuotaExhausted ?? isQuotaExhausted;
  }

  /**
   * 单调时钟，秒。对应 `asyncio.get_running_loop().time()`。
   *
   * **不做成可注入的**：`withTimeout` 用的是真的 `setTimeout`，注入一个假时钟
   * 只会让「记账用的时间」和「定时器用的时间」分家 —— 那种测试通过了也不说明
   * 生产上对。要测超时就用真的短 sleep，跟 Python 侧的测试一样。
   */
  private nowS(): number {
    return performance.now() / 1000;
  }

  /** `budget.snapshot()` 的 dict 形态。BudgetSnapshot 是 interface（没有索引
   *  签名），所以到 `Record<string, unknown>` 要过一次展开。 */
  private snap(): Record<string, unknown> {
    return { ...this.budget.snapshot() };
  }

  async run(runId: string, opts: { readonly seed?: Record<string, unknown> } = {}): Promise<RunOutcome> {
    this.wallclockMark = this.nowS();
    this.runDeadline = this.wallclockMark + this.budget.remaining("wallclock_s");
    this.rec.emit(EventKind.RUN_STARTED, { payload: { dag: this.dag.name } });

    const working = new WorkingSet();
    const seed = opts.seed ?? {};
    for (const [k, v] of Object.entries(seed)) working.put(k, v);

    const results: Record<string, NodeResultLike> = {};
    const skipped: string[] = [];
    const done = new Set<string>(Object.keys(seed));
    const pending = new Set<string>(this.dag.nodes.keys());
    const running = new Set<Inflight>();
    /** 已结束、等待调度循环收割的节点，按**实际结束顺序**排队。 */
    const finishedQueue: Inflight[] = [];

    // 先把历史里已完成的节点恢复出来，不重跑也不重新付费
    for (const nid of this.dag.topoOrder()) {
      if (this.rec.nodeIsComplete(nid)) {
        working.put(nid, await this.rec.nodeOutput(nid));
        done.add(nid);
        pending.delete(nid);
        skipped.push(nid);
      }
    }
    if (skipped.length > 0) {
      this.rec.emit(EventKind.RUN_RESUMED, { payload: { restored: [...skipped] } });
    }

    /** Run 定案：请求所有在飞节点停下（软承诺），调度循环随即 return，
     *  它们的产出再也无法被采纳（硬承诺）。 */
    const abandonAll = (): void => {
      for (const inf of running) inf.abort.abort();
    };

    while (pending.size > 0 || running.size > 0) {
      this.accountWallclock();
      try {
        this.budget.check("wallclock_s");
      } catch (exc) {
        if (!(exc instanceof BudgetExhausted)) throw exc;
        abandonAll();
        return this.fail(results, skipped, pyStr(exc));
      }
      this.maybeDegrade();

      const ready = sortedCp(
        [...pending].filter((n) => this.dag.resolveDeps(n).every((d) => done.has(d))),
      );
      for (const nid of ready) {
        pending.delete(nid);
        running.add(this.start(nid, working, runId, finishedQueue));
      }

      if (running.size === 0) {
        const stuck = sortedCp(pending);
        return this.fail(results, skipped, `依赖无法满足，卡住的节点: ${pyReprList(stuck)}`);
      }

      const finished = await waitFirstCompleted(running, finishedQueue);
      this.accountWallclock();
      for (const inf of finished) {
        running.delete(inf);
        const settled = inf.settled!;
        if (!settled.ok) {
          const exc = settled.error;
          if (exc instanceof HumanInputRequired) {
            abandonAll();
            this.rec.emit(EventKind.RUN_SUSPENDED, {
              payload: { node: exc.nodeId, request_id: exc.requestId },
            });
            return makeRunOutcome({
              status: RunStatus.SUSPENDED,
              outputs: outputsCopy(working),
              results,
              skipped,
              pendingHuman: { node: exc.nodeId, request_id: exc.requestId, ...exc.payload },
              budget: this.snap(),
            });
          }
          if (exc instanceof NodeFailure || exc instanceof BudgetExhausted) {
            abandonAll();
            return this.fail(results, skipped, pyStr(exc));
          }
          // Python 侧这里没有 except 分支，异常直接从 run() 冒出去。照搬 ——
          // `_runNode` 的出口只有 NodeFailure / HumanInputRequired 两种，走到
          // 这儿说明有人绕过了那层包装，吞掉只会让 bug 更难找。
          throw exc;
        }

        results[inf.nid] = settled.value;
        working.put(inf.nid, settled.value.output, settled.value.digest);
        await this.rec.completeNode(inf.nid, settled.value.output);
        done.add(inf.nid);
      }
    }

    this.rec.emit(EventKind.RUN_COMPLETED, {
      payload: {
        nodes: Object.keys(results).length,
        restored: skipped.length,
        budget: this.snap(),
      },
    });
    return makeRunOutcome({
      status: RunStatus.COMPLETED,
      outputs: outputsCopy(working),
      results,
      skipped,
      budget: this.snap(),
    });
  }

  // ── 单节点 ──────────────────────────────────────────────────

  /** 起一个节点。包装层**永不 reject**，结果同步写进 `settled` 再入队。 */
  private start(
    nid: string,
    working: WorkingSet,
    runId: string,
    queue: Inflight[],
  ): Inflight {
    const inflight: Inflight = {
      nid,
      abort: new AbortController(),
      done: Promise.resolve(),
      settled: null,
    };
    inflight.done = this.runNode(nid, working, runId, inflight.abort.signal).then(
      (value) => {
        inflight.settled = { ok: true, value };
        queue.push(inflight);
      },
      (error: unknown) => {
        inflight.settled = { ok: false, error };
        queue.push(inflight);
      },
    );
    return inflight;
  }

  private async runNode(
    nid: string,
    working: WorkingSet,
    runId: string,
    signal: AbortSignal,
  ): Promise<NodeResultLike> {
    const spec = this.dag.get(nid);
    const deps = this.dag.resolveDeps(nid);
    let last: unknown = null;
    // 截止时刻在**抢信号量之前**就定了（Python 同）：排队等 permit 的时间算在
    // 节点头上，一个排在长队后面的节点可能还没开跑就已经超时。这是原件的行为，
    // 不是笔误 —— 节点墙钟的语义是「从被调度算起」，改成从开跑算起会让整份 DAG
    // 的时间上界失去意义。
    const nodeDeadline = this.nowS() + spec.budget.wallclockS;

    const release = await this.sem.acquire();
    try {
      // 排队期间 Run 可能已经定案。Python 侧等信号量的任务被 cancel 后连协程体
      // 都不会进，这里手工对齐 —— 这是「取消」唯一能真正省下钱的地方。
      if (signal.aborted) throw ABANDONED;

      for (let attempt = 0; attempt <= spec.retries; attempt += 1) {
        try {
          let remaining = nodeDeadline - this.nowS();
          if (this.runDeadline !== null) {
            remaining = Math.min(remaining, this.runDeadline - this.nowS());
          }
          if (remaining <= 0) throw new NodeTimeout();
          const result = await withTimeout(
            this.loop.run(spec, { working, deps, runId, signal }),
            remaining,
          );
          await this.applyGate(nid, result);
          return result;
        } catch (exc) {
          if (exc === ABANDONED) throw exc;
          if (isTimeout(exc)) {
            last = new NodeFailure(nid, `超过节点墙钟上限 ${spec.budget.wallclockS}s`, false);
            break;
          }
          if (exc instanceof HumanInputRequired) throw exc; // 不是失败，是等人 —— 直接上抛让 Run 挂起
          if (this.isQuota(exc)) {
            // 网关账户没钱了。这不是"这次不巧"，重跑多少遍都一样，所以
            // **一次都不重试**就定案。代价不是几秒退避：EXTRACT 是按
            // segment 扇出的贵活（onto/pipeline.py 里 retries=1），走到
            // 下面那条兜底分支的话，每个分片都要再白跑一整次节点执行 ——
            // 用户为一个必然失败的结果多等好几分钟。
            // 不能像 HumanInputRequired 那样裸抛：外层只接
            // NodeFailure / BudgetExhausted，裸抛会直接穿透 RunOutcome 契约。
            last = exc;
            break;
          }
          if (exc instanceof NodeFailure) {
            last = exc;
            if (!exc.retryable || attempt >= spec.retries) break;
          } else {
            // 记账后统一转成 NodeFailure
            last = exc;
            if (attempt >= spec.retries) break;
          }
        }
        this.rec.emit(EventKind.NODE_FAILED, {
          nodeId: nid,
          payload: {
            attempt,
            error: `${pyTypeName(last)}: ${pyStr(last)}`,
            will_retry: attempt < spec.retries,
          },
        });
      }
    } finally {
      release();
    }

    // `cause` 是 Python `raise ... from last` 的等价物，把真异常挂进异常链。
    // **上层判"是不是欠费"要靠它** —— 光看这条消息文本是靠不住的（异常类型名
    // 会被 str 掉，见 server 侧的 `_signal_of`：类型优先、文本兜底，而文本兜底
    // 之所以还必须留着，是因为 RunOutcome.error 到最后只剩一个字符串，链在那儿
    // 就断了）。
    const failure = new NodeFailure(nid, `${pyTypeName(last)}: ${pyStr(last)}`, false);
    failure.cause = last;
    throw failure;
  }

  /** 真实流逝的 Run 时间只记一次，与节点并发数无关。 */
  private accountWallclock(): void {
    if (this.wallclockMark === null) return;
    const now = this.nowS();
    const elapsed = Math.max(0.0, now - this.wallclockMark);
    if (elapsed) this.budget.spend({ wallclock_s: elapsed });
    this.wallclockMark = now;
  }

  // ── 质量门 ──────────────────────────────────────────────────

  /**
   * 在提交节点产出**之前**就地判门。
   *
   * `NodeSpec.gate` 是可序列化的 `GateSpec`；早期调用方也直接传可执行的 `Gate`。
   * 两种都支持，历史上的类型分裂就此收口而不必改那些调用方。非 PASS 的结果
   * 永远到不了 `completeNode`，也到不了任何下游节点。
   */
  private async applyGate(nid: string, result: NodeResultLike): Promise<void> {
    // 运行期可能是 Gate 对象，而 dag.ts 的静态类型只有 GateSpec —— 这正是上面
    // 说的那次类型分裂，用 unknown 接住再分派。
    const gate: unknown = this.dag.get(nid).gate;
    if (gate === null || gate === undefined) return;

    let metrics = metricsFromVerdicts(result.verdicts ?? []);
    if (isPlainRecord(result.output)) {
      // 领域 handler 可能在结构化产出里给出确定性的质量测量（例如
      // `completeness.required_fill_rate`）。把这些路径也放进来，同时保留内核
      // 自己的评审键不被覆盖。
      const domain: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result.output)) {
        if (!hasOwn(metrics, k)) domain[k] = v;
      }
      metrics = { ...domain, ...metrics, output: result.output };
    }

    if (gate instanceof Gate) {
      // 老式可执行 Gate：它自己会发 GATE_EVALUATED，这里不再补发
      const decision = gate.evaluate(metrics, this.rec, nid);
      await this.enforceGateDecision(nid, gate.name, decision, result);
      return;
    }

    if (!isGateSpecLike(gate)) {
      throw new NodeFailure(nid, `不支持的 gate 配置: ${pyTypeName(gate)}`, false);
    }

    const kind = pyStrip(gate.kind).toLowerCase();
    if (kind !== "auto" && kind !== "hitl") {
      throw new NodeFailure(nid, `未知 gate kind: ${pyRepr(gate.kind)}`, false);
    }

    const failed = gate.require.filter((expr) => !requirementPasses(expr, metrics, nid));
    if (kind === "auto") {
      const decision: GateResult = {
        decision: failed.length === 0 ? Decision.PASS : Decision.ABORT,
        reason: failed.length === 0 ? "全部硬门通过" : `未通过: ${pyReprList(failed)}`,
        detail: { failed },
      };
      emitGate(this.rec, nid, "auto", decision, failed);
      await this.enforceGateDecision(nid, "auto", decision, result);
      return;
    }

    const requestId = `${nid}:gate`;
    const answer = await this.rec.askHuman(nid, requestId, {
      kind: "gate",
      gate: "hitl",
      failed,
      metrics,
      output: result.output,
      actions: ["pass", "revise", "abort"],
    });
    const choice = pyStrip(pyStr(answerField(answer, "decision"))).toLowerCase();
    const mapped = HITL_CHOICES[choice];
    if (mapped === undefined) {
      throw new NodeFailure(nid, `HITL gate 收到无效决策: ${pyRepr(choice)}`, false);
    }
    const decision: GateResult = {
      decision: mapped,
      reason: `人工决策: ${choice}`,
      detail: { failed },
    };
    emitGate(this.rec, nid, "hitl", decision, failed);
    await this.enforceGateDecision(nid, "hitl", decision, result);
  }

  private async enforceGateDecision(
    nid: string,
    name: string,
    result: GateResult,
    nodeResult: NodeResultLike,
  ): Promise<void> {
    if (result.decision === Decision.PASS) return;
    if (result.decision === Decision.ASK_USER) {
      const requestId = `${nid}:gate`;
      const answer = await this.rec.askHuman(nid, requestId, {
        kind: "gate",
        gate: name,
        reason: result.reason,
        detail: result.detail,
        output: nodeResult.output,
        actions: ["pass", "revise", "abort"],
      });
      const choice = pyStrip(pyStr(answerField(answer, "decision"))).toLowerCase();
      const failed = pyList(result.detail["failed"]);
      if (choice === "pass" || choice === "approve") {
        emitGate(
          this.rec,
          nid,
          name,
          { decision: Decision.PASS, reason: "人工决策: pass", detail: result.detail },
          failed,
        );
        return;
      }
      const retryable = choice === "revise";
      const final = retryable ? Decision.REVISE : Decision.ABORT;
      emitGate(
        this.rec,
        nid,
        name,
        {
          decision: final,
          reason: `人工决策: ${choice || "无效"}`,
          detail: result.detail,
        },
        failed,
      );
      throw new NodeFailure(nid, `质量门「${name}」人工决策: ${choice || "无效"}`, retryable);
    }
    if (result.decision === Decision.REVISE || result.decision === Decision.AUTO_REPAIR) {
      throw new NodeFailure(nid, `质量门「${name}」要求重做：${result.reason}`, true);
    }
    throw new NodeFailure(nid, `质量门「${name}」未通过：${result.reason}`, false);
  }

  // ── 降级 ────────────────────────────────────────────────────

  /** 预算降级必须对用户可见 —— 悄悄降级再交付未审产物比失败更糟。 */
  private maybeDegrade(): void {
    const lvl = this.budget.currentLevel();
    if (lvl <= this.level) return;
    this.level = lvl;
    // 键序照抄 Python 的字面量 `{"level":…, "label":…, **snapshot}`：level / label
    // 在前，snapshot 的 level 覆盖值但**不改位置**。写成对象字面量 + spread 的话
    // tsc 会报 TS2783（重复键），所以用 Object.assign —— 它的覆盖语义与 Python
    // 的 `**` 完全一致（同名键保留原位、取新值）。
    const payload: Record<string, unknown> = { level: lvl, label: degradeLabel(lvl) };
    Object.assign(payload, this.budget.snapshot());
    this.rec.emit(EventKind.DEGRADED, { payload });
    this.bus.broadcast({
      frm: "scheduler",
      topic: "budget/degrade",
      payload: { level: lvl, label: degradeLabel(lvl) },
    });
  }

  private fail(
    results: Record<string, NodeResultLike>,
    skipped: string[],
    msg: string,
  ): RunOutcome {
    this.rec.emit(EventKind.RUN_FAILED, { payload: { error: msg } });
    return makeRunOutcome({
      status: RunStatus.FAILED,
      results,
      skipped,
      error: msg,
      budget: this.snap(),
    });
  }
}

/**
 * `asyncio.wait(..., FIRST_COMPLETED)` 的等价物：返回**这一轮里已经结束的全部**
 * 节点（可能不止一个），按结束顺序。
 *
 * Python 那边 `finished` 是个 set，迭代顺序不定；这里是确定的结束顺序 ——
 * 差别只在同一批里既有成功又有失败时，谁先被记进 results。确定 > 不定。
 */
async function waitFirstCompleted(
  running: ReadonlySet<Inflight>,
  queue: Inflight[],
): Promise<Inflight[]> {
  // 队列非空说明上一轮调度期间又有节点结束了，直接收割，不必再等一次
  if (queue.length === 0) await Promise.race([...running].map((i) => i.done));
  return queue.splice(0, queue.length);
}

const HITL_CHOICES: Readonly<Record<string, Decision>> = {
  pass: Decision.PASS,
  approve: Decision.PASS,
  revise: Decision.REVISE,
  abort: Decision.ABORT,
  round_trip: Decision.ROUND_TRIP,
};

/** `str((answer or {}).get("decision", ""))` —— answer 可能是 None / 非 dict。 */
function answerField(answer: unknown, key: string): unknown {
  if (isPlainRecord(answer) && hasOwn(answer, key)) return answer[key];
  return "";
}

/** Python `list(x)`：list 拷贝、str 拆成**字符**（是的，Python 就是这么干的）、
 *  其余（含 `.get("failed", ())` 那个空 tuple 默认值）给空。元素原样保留 —— 这批
 *  值会原样进事件 payload。 */
function pyList(v: unknown): unknown[] {
  if (Array.isArray(v)) return [...(v as unknown[])];
  if (typeof v === "string") return [...v];
  return [];
}

/** 可序列化的 GateSpec：`kind` 是字符串、`require` 是数组。 */
function isGateSpecLike(v: unknown): v is GateSpec {
  if (typeof v !== "object" || v === null) return false;
  const g = v as { kind?: unknown; require?: unknown };
  return typeof g.kind === "string" && Array.isArray(g.require);
}

function emitGate(
  rec: RecorderLike,
  nodeId: string,
  name: string,
  result: GateResult,
  failed: readonly unknown[],
): void {
  rec.emit(EventKind.GATE_EVALUATED, {
    nodeId,
    payload: {
      gate: name,
      decision: result.decision,
      reason: result.reason,
      failed: [...failed],
    },
  });
}

// ══════════════════════════════════════════════════════════════════
//  GateSpec 的断言小语言
// ══════════════════════════════════════════════════════════════════

/**
 * 与 Python 的 `_REQ_RE` 同形。两处刻意的差别：
 *   · `\s` 换成显式的 Python 空白集（见 {@link PY_SPACE}）；
 *   · `\d` 在 Python 的 str 模式下是 **Unicode** 的（`٣ == 3` 那种阿拉伯-印度
 *     数字也能匹配并被 `int()` 解析），JS 的 `\d` 只有 ASCII。这条分叉留着 ——
 *     补上 `\p{Nd}` 只会让正则过、`Number()` 给 NaN，错得更隐蔽。
 */
const REQ_RE = new RegExp(
  "^(?<path>[A-Za-z_][A-Za-z0-9_.-]*)" +
    `[${PY_SPACE}]*` +
    "(?<op>==|!=|>=|<=|>|<)" +
    `[${PY_SPACE}]*` +
    "(?<value>true|false|null|-?\\d+(?:\\.\\d+)?|'[^']*'|\"[^\"]*\")$",
  "iu",
);

/** 数字化：Python 的 bool 是 int 的子类，`True == 1` / `True > 0` 都成立。 */
function numify(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** Python `a == b`（b 只可能是 bool / number / str / None，由文法保证）。 */
function pyEq(a: unknown, b: boolean | number | string | null): boolean {
  if (b === null) return a === null || a === undefined;
  if (typeof b === "string") return typeof a === "string" && a === b;
  const nb = numify(b);
  const na = numify(a);
  return na !== null && nb !== null && na === nb;
}

/**
 * 刻意做小、且不可执行的 GateSpec 断言语言。
 *
 * 导出是给测试与 golden 用的（Python 侧是模块私有的 `_requirement_passes`）。
 */
export function requirementPasses(
  expression: string,
  metrics: Record<string, unknown>,
  nodeId = "gate",
): boolean {
  const match = REQ_RE.exec(pyStrip(expression));
  if (match === null || match.groups === undefined) {
    // 消息里的是**原始**表达式（未 strip），照抄 Python 的 `{expression!r}`
    throw new NodeFailure(nodeId, `不支持的 gate require 表达式: ${pyRepr(expression)}`, false);
  }

  const path = match.groups["path"]!;
  const parts = path.split(".");
  let left: unknown = metrics;
  const byLens = hasOwn(metrics, "by_lens") ? metrics["by_lens"] : {};
  const head = parts[0]!;
  if (!hasOwn(metrics, head) && isPlainRecord(byLens) && hasOwn(byLens, head)) {
    parts.shift();
    left = {
      passed: byLens[head],
      high_findings: (metrics["high_by_lens"] as Record<string, unknown>)[head],
      total_findings: (metrics["findings_by_lens"] as Record<string, unknown>)[head],
    };
  }
  for (const part of parts) {
    if (!isPlainRecord(left) || !hasOwn(left, part)) {
      throw new NodeFailure(nodeId, `gate require 引用未知指标: ${pyRepr(path)}`, false);
    }
    left = left[part];
  }

  const raw = match.groups["value"]!;
  const folded = raw.toLowerCase();
  let right: boolean | number | string | null;
  if (folded === "true") right = true;
  else if (folded === "false") right = false;
  else if (folded === "null") right = null;
  else if (raw.startsWith('"') || raw.startsWith("'")) right = raw.slice(1, -1);
  else right = Number(raw); // int/float 在 JS 里是同一个类型，见文件级说明

  const op = match.groups["op"]!;
  if (op === "==") return pyEq(left, right);
  if (op === "!=") return !pyEq(left, right);

  // 大小比较：Python 对不可比的类型抛 TypeError，JS 会静默给一个 false ——
  // 那正是最坏的一种"能跑"（`"0.9" >= 0.95` 恒 false，门永远不过，还没人报错）。
  const nl = numify(left);
  const nr = numify(right);
  let cmp: number;
  if (nl !== null && nr !== null) cmp = nl < nr ? -1 : nl > nr ? 1 : 0;
  else if (typeof left === "string" && typeof right === "string") {
    cmp = codePointCompare(left, right);
  } else {
    throw new NodeFailure(nodeId, `gate require 类型不可比较: ${pyRepr(expression)}`, false);
  }
  // NaN：Python 与 JS 一致，所有比较都 false
  if ((nl !== null && Number.isNaN(nl)) || (nr !== null && Number.isNaN(nr))) return false;
  if (op === ">=") return cmp >= 0;
  if (op === "<=") return cmp <= 0;
  if (op === ">") return cmp > 0;
  return cmp < 0;
}
