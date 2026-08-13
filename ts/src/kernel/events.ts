/**
 * 事件模型 —— 内核里发生的一切都是事件。移植自 Python 侧 `kernel/events.py`，
 * 由 golden/events.json 钉住（27 种 kind + 4 条往返样本的确切字节）。
 *
 * 三个用途，一套数据：
 *   1. **持久化执行**：崩溃后按事件重放到崩溃点，不重跑已完成的节点，也不重新
 *      为已完成的 LLM 调用付费。
 *   2. **可观测**：UI 的推理轨迹是事件流的投影，零额外埋点。
 *   3. **回归测试**：录真实 Run 的事件当 fixture，改代码后重放验证行为不变。
 *
 * 纪律（见架构文档 §4.7）：LLM 与工具调用的结果**首次执行时写入日志，重放时
 * 直接读回**。事件本身只存小 payload，大内容（完整响应、代码输出、切片）进
 * BlobStore，事件里放 contentRef。
 *
 * 为什么 EventKind 不用 TS `enum`：事件要 JSON 往返，TS enum 是运行时对象，
 * 序列化形态与 Python StrEnum 不一致。const object + union 才能让 `kind` 在
 * 类型上是字面量、在运行时就是那个字符串。
 */

/** 事件类型。**声明顺序即 golden `kinds` 的顺序**，加新种类只许追加在分组末尾。 */
export const EventKind = {
  // ── Run 生命周期 ──
  RUN_STARTED: "run.started",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  RUN_SUSPENDED: "run.suspended", // 等人工决策
  RUN_RESUMED: "run.resumed",

  // ── 节点 ──
  NODE_ENTERED: "node.entered",
  NODE_COMPLETED: "node.completed",
  NODE_FAILED: "node.failed",
  NODE_SKIPPED: "node.skipped",

  // ── Agent Loop 内部（→ UI 推理轨迹）──
  PLAN_CREATED: "trace.plan",
  PLAN_REVISED: "trace.plan_revised",
  THOUGHT: "trace.thought",
  OBSERVATION: "trace.observation",

  // ── Effect：一切非确定性的东西 ──
  EFFECT_REQUESTED: "effect.requested",
  EFFECT_COMPLETED: "effect.completed",
  EFFECT_FAILED: "effect.failed",

  // ── 评审 ──
  CRITIC_VERDICT: "critic.verdict",
  GATE_EVALUATED: "gate.evaluated",

  // ── 人在环 ──
  HUMAN_REQUESTED: "human.requested",
  HUMAN_RECORDED: "human.recorded",

  // ── Agent 间通信 ──
  BLACKBOARD_WRITE: "bus.blackboard_write",
  MESSAGE_SENT: "bus.message",

  // ── 记忆 ──
  MEMORY_PROMOTED: "memory.promoted", // 短期 → 长期
  MEMORY_EVICTED: "memory.evicted",
  CONTEXT_COMPACTED: "memory.compacted",

  // ── 预算 ──
  BUDGET_SPENT: "budget.spent",
  DEGRADED: "budget.degraded",
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/** 与 Python `list(EventKind)` 同序 —— 键全是非整数字符串，V8 保插入序。 */
export const EVENT_KINDS: readonly EventKind[] = Object.values(EventKind);

const KIND_VALUES: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

/**
 * 对应 Python 的 `EventKind(value)` —— 未知值**抛错**，不静默放行。
 *
 * 日志是重放的唯一输入；一个拼错的 kind 如果被 `as EventKind` 蒙混过关，
 * 错误会在几百条事件之后才以"节点莫名其妙没执行"的形式暴露出来。
 */
export function parseEventKind(v: unknown): EventKind {
  if (typeof v === "string" && KIND_VALUES.has(v)) return v as EventKind;
  throw new Error(`未知的 EventKind: ${JSON.stringify(v)}`);
}

/** 重放时用于恢复 effect 结果的事件类型。 */
export const REPLAYABLE: ReadonlySet<EventKind> = new Set<EventKind>([
  EventKind.EFFECT_COMPLETED,
  EventKind.HUMAN_RECORDED,
]);

/**
 * 一条不可变的事件记录。
 *
 * `seq` 在 Run 内单调递增，是日志的规范顺序。`tsMs` 只用于展示和排障 ——
 * **工作流逻辑绝不能读它**，否则重放会产生不同结果。
 *
 * `nodeId` / `ref` 用 `null` 而不是可选属性：Python 侧是 `str | None`，
 * 而"字段缺失"与"字段为 None"在 `toDict` 的省略规则里是同一件事，多留一种
 * 表示只会让下游多写一个分支。
 */
export interface Event {
  readonly runId: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly nodeId: string | null;
  readonly payload: Record<string, unknown>;
  readonly ref: string | null; // 大内容的 BlobStore 引用
  readonly tsMs: number;
}

export interface EventInit {
  readonly runId: string;
  readonly seq: number;
  readonly kind: EventKind;
  readonly nodeId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly ref?: string | null;
  readonly tsMs?: number;
}

/**
 * 造一条事件。默认值写在这里而不是类字段上（见契约 §1）。
 *
 * payload **总是复制一份**：Python 只有 `default_factory=dict` 那个默认值是新的，
 * 显式传进去的 dict 是共享引用 —— 调用方之后改它，已经"写进日志"的事件会跟着变。
 * 那是个 footgun，不是被依赖的行为（recorder.emit 传完就不再碰），所以这里一律复制。
 * 注意是**浅**复制，跟 Python 的 `frozen=True` 一样只保一层。
 */
export function makeEvent(p: EventInit): Event {
  return Object.freeze({
    runId: p.runId,
    seq: p.seq,
    kind: p.kind,
    nodeId: p.nodeId ?? null,
    payload: { ...(p.payload ?? {}) },
    ref: p.ref ?? null,
    tsMs: p.tsMs ?? 0,
  });
}

/** 事件的线上形态（jsonl 的一行就是它的 JSON）。字段名保持 snake_case。 */
export interface EventDict {
  readonly run_id: string;
  readonly seq: number;
  readonly kind: string;
  readonly ts_ms: number;
  readonly node_id?: string;
  readonly payload?: Record<string, unknown>;
  readonly ref?: string;
}

/**
 * 序列化。**省略规则决定 jsonl 的字节形状，照抄 Python，一个条件都不许"优化"**：
 *   - `nodeId` 为 null 才省略 —— 空串 `""` 要写出来（Python 判的是 `is not None`）
 *   - `payload` 为空对象才省略 —— Python 判的是 dict 的真值性
 *   - `ref` 为 null 才省略 —— 同 nodeId，空串要写
 *
 * 写成 `if (e.nodeId)` 会把空串一起吞掉，日志少一个字段、重放时 node_id 变 null，
 * 而且只在极少数空串场景下发作。
 *
 * 键的插入顺序也照抄（run_id, seq, kind, ts_ms, node_id, payload, ref）：
 * Python 的 `json.dumps` 默认不排序，落盘字节直接跟着 dict 顺序走。
 */
export function eventToDict(e: Event): EventDict {
  const d: {
    run_id: string;
    seq: number;
    kind: string;
    ts_ms: number;
    node_id?: string;
    payload?: Record<string, unknown>;
    ref?: string;
  } = {
    run_id: e.runId,
    seq: e.seq,
    kind: e.kind,
    ts_ms: e.tsMs,
  };
  if (e.nodeId !== null) d.node_id = e.nodeId;
  if (Object.keys(e.payload).length > 0) d.payload = e.payload;
  if (e.ref !== null) d.ref = e.ref;
  return d;
}

/**
 * 反序列化。入参是 `unknown` 而不是某个具体形状 —— 它真实的来源是 jsonl 的一行
 * `JSON.parse` 结果，谁也不能事先保证它长什么样。
 *
 * `kind` 走 `parseEventKind` 校验；缺 `run_id` / `seq` 直接抛
 * （Python 是 `d["run_id"]` 的 KeyError，这里给条能读的错误信息）。
 *
 * 与 Python 的一处**有意收紧**：Python 不校验值类型，一个 `seq: "3"` 会一路
 * 带进内存，直到某处比较大小时才炸；这里当场拒绝。日志是外部输入，越早拒越好。
 */
export function eventFromDict(raw: unknown): Event {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`事件不是对象: ${JSON.stringify(raw)}`);
  }
  const d = raw as Readonly<Record<string, unknown>>;

  const runId = d["run_id"];
  if (typeof runId !== "string") throw new Error(`事件缺少 run_id: ${JSON.stringify(d)}`);
  const seq = d["seq"];
  if (typeof seq !== "number") throw new Error(`事件的 seq 不是数字: ${JSON.stringify(d)}`);

  const nodeId = d["node_id"];
  if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
    throw new Error(`事件的 node_id 不是字符串: ${JSON.stringify(d)}`);
  }
  const ref = d["ref"];
  if (ref !== undefined && ref !== null && typeof ref !== "string") {
    throw new Error(`事件的 ref 不是字符串: ${JSON.stringify(d)}`);
  }

  // Python 是 `d.get("payload") or {}`：缺失、null、空 dict 都归一成新的空 dict。
  const rawPayload = d["payload"];
  if (rawPayload !== undefined && rawPayload !== null) {
    if (typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      throw new Error(`事件的 payload 不是对象: ${JSON.stringify(d)}`);
    }
  }
  const payload = (rawPayload ?? {}) as Record<string, unknown>;

  // Python 是 `d.get("ts_ms", 0)`，只有键缺失才回退；显式 null 会原样留下 None。
  // TS 侧 tsMs 类型是 number，null 无处安放 —— 一并当作缺失回退到 0。
  const tsMs = d["ts_ms"];
  if (tsMs !== undefined && tsMs !== null && typeof tsMs !== "number") {
    throw new Error(`事件的 ts_ms 不是数字: ${JSON.stringify(d)}`);
  }

  return makeEvent({
    runId,
    seq,
    kind: parseEventKind(d["kind"]),
    nodeId: nodeId ?? null,
    payload,
    ref: ref ?? null,
    tsMs: tsMs ?? 0,
  });
}

/**
 * 墙钟毫秒。**只允许事件记录用**，业务逻辑要时间必须走 Recorder.now()。
 *
 * Python 是 `int(time.time() * 1000)`（向零截断），`Date.now()` 本来就是整数毫秒，
 * 正的时间戳上两者等价。
 */
export function nowMs(): number {
  return Date.now();
}
