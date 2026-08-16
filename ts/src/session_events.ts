/**
 * 会话事件的耐久化发布 —— 移植自 `session_events.py`，形态由
 * golden/session_events.json 钉住。
 *
 * `Session.emit` **故意是同步的**：领域代码在各种回调里发事件，把整条栈改成 async
 * 换不来任何业务价值。但「耐久」本身是异步的。这个模块把两者接起来，且**绝不让
 * 一个临时的进程内序号漏到 SSE 上**：
 *
 *   * 同步 emit 追加一份 pending projection，并入队一次写；
 *   * 一个 worker 串行化所有写；
 *   * 只有仓储返回的 EventRow 会广播给订阅者；
 *   * 关停前把队列排空，然后才关仓储。
 *
 * 因此不可避免的崩溃窗口只剩「已进队列、尚未 commit」这一段。不存在
 * 「已送达但不耐久」的假窗口：界面可见性发生在 commit 之后。
 *
 * ── 为什么 projection 是**可变对象**（全仓唯一的例外）─────────────────
 *
 * 别的 DTO 都是 `readonly interface` + 工厂。这里不行：调用方拿到的那份 dict
 * 会被 worker **原地回填**成仓储返回的权威形态（`clear()` + `update()`）。
 * `emit_durable()` 的整个契约就建立在这上面 —— 表格下载链接和 chat turn 关联
 * 拿的都是同一个对象上后来才出现的 seq。换成不可变对象，调用方手里的引用会永远
 * 停在 `seq = -3`，下载链接指向一个不存在的序号。
 *
 * ── 与 Python 的差异（每条都在 deviations 里报了）───────────────────
 *
 * 1. Python 按 event loop 分状态（WeakKeyDictionary）—— 那是给「一个进程里跑很多
 *    个 loop 的 pytest」用的。Node 一个进程只有一个 loop（worker_threads 各有各的
 *    隔离世界，不会共享同一个 hub 实例），所以这里就是**每个 hub 一份状态**。
 * 2. `asyncio.shield` / `task.cancel()` 没有对等物，见约定 §2.2：不假装有取消。
 *    Python 的 shutdown 在排空后 cancel worker；这里排空后 worker 自己就结束了。
 * 3. `logging` 换成 `console.error`，消息串逐字一致（`str(exc)`，**不带类名**）。
 */

import { eventRowAsSse } from "./store/types.js";
import type { EventRow, JsonObject, JsonValue } from "./store/types.js";

import { randomUUID } from "node:crypto";

// ══════════════════════════════════════════════════════════════════
//  对外形态
// ══════════════════════════════════════════════════════════════════

/** 一条会话事件的线上形态。**可变**，理由见文件头。 */
export type SessionEvent = Record<string, JsonValue>;

/** SSE 订阅者。对应 Python 的 `asyncio.Queue.put_nowait` —— 无界、不阻塞、不 await。 */
export interface EventSubscriber {
  putNowait(event: SessionEvent): void;
}

/** hub 只碰 Session 的这三样东西（对应 Python 的 `_EventSession` Protocol）。 */
export interface EventSession {
  readonly id: string;
  /** 进程内投影列表。hub 会 push、排序、删重复项，所以数组本身必须可变。 */
  readonly events: SessionEvent[];
  readonly subscribers: EventSubscriber[];
}

/** hub 只用仓储的这两个方法（对应 Python 的 `_EventRepo` Protocol）。 */
export interface EventRepo {
  /** 返回 null/undefined = 这个会话没落过库，走 local-only 兼容路径。 */
  getSession(sid: string): Promise<unknown>;
  /**
   * Python 侧 `event_id` 是 keyword-only；TS 没有关键字参数，退化成第四个位置
   * 参数。它是**幂等键**：重试撞上同一个 id 必须回原来那行，不能再发一个号。
   */
  appendEvent(sid: string, kind: string, payload: JsonObject, eventId?: string): Promise<EventRow>;
}

export interface DurableEventHubOptions {
  /** 单条事件最多尝试几次落库（下界 1）。Python 默认 5。 */
  readonly maxAttempts?: number;
  /**
   * epoch 秒（== Python `time.time()`）。可注入**只**为了测试：ESM 的导出是只读
   * 绑定，没有 Python 那种改模块命名空间的 monkeypatch，而 golden 里的 `ts` 是
   * 真会被前端读到的字段，不能因为不可控就从断言里删掉。
   */
  readonly now?: () => number;
  /** 事件的幂等 id（== Python `uuid.uuid4().hex`）。同上，可注入只为测试。 */
  readonly newEventId?: () => string;
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

/**
 * Python `int(x)` —— **向零截断**，不是四舍五入，而且字符串只接受整数字面量。
 *
 * 排序键和 `_next_local_seq` 都从 `int(e.get("seq", -1))` 走。历史事件里的 seq
 * 可能是字符串（老的导出包）或浮点（JSON 往返过的），照抄 Python 的强制转换，
 * 别用 `Number(v)` —— 那会让 `"3.5"` 静默变成 3.5，排序基准就带上小数了。
 */
function pyInt(v: JsonValue | undefined): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`int() 收到 ${String(v)}`);
    return Math.trunc(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0; // Python 里 bool 是 int 的子类
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^[+-]?[0-9]+$/.test(t)) throw new Error(`int() 无法解析 ${JSON.stringify(v)}`);
    return Number(t);
  }
  throw new Error(`int() 不接受 ${JSON.stringify(v)}`);
}

/** `int(e.get("seq", -1))` —— **键不存在**才回落到 -1；值是 0 时照样用 0。 */
function seqOf(event: SessionEvent): number {
  return pyInt("seq" in event ? event["seq"] : -1);
}

/**
 * Python 的 `d.clear(); d.update(src)` —— **原地**换掉全部键值。
 *
 * 必须是原地：调用方（`emit_durable`、chat turn 关联、表格下载）手里就是这个引用。
 * 先删干净再赋值，键序因此完全等于 src 的插入序。
 */
function clearAndUpdate(target: SessionEvent, source: SessionEvent): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

/** Python `str(exc)` —— 只有消息，**没有类名**。日志那行用的是这个。 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Python `f"{type(e).__name__}: {e}"` —— 事件里的 `error` 字段用的是这个。
 *
 * 取 `constructor.name` 而不是 `err.name`：前者才是 `type(e).__name__` 的对等物。
 * 本仓的异常类都会把 `this.name` 设成类名（两者一致），但没设的子类上
 * `err.name` 会退化成基类的 "Error"，把最有诊断价值的那半截丢掉。
 * 代价是打包器若开了 name mangling 会拿到混淆名 —— 这个后端不过打包器。
 */
function errLabel(err: unknown): string {
  if (err instanceof Error) {
    const cls = err.constructor?.name || err.name || "Error";
    return `${cls}: ${err.message}`;
  }
  // JS 允许 throw 任何值，Python 不允许 —— 没有对等形态，兜底成可读的一行。
  return `${typeof err}: ${String(err)}`;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function makeDeferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  // **必须在创建时就挂 catch。** 绝大多数发事件的地方不等收据，落库彻底失败时
  // 这个 promise 就是无人处理的 rejection —— Node 默认直接杀进程。Python 侧那行
  // `item.done.exception()` 只是压掉一条 warning，语义完全不同（约定 §2.1）。
  // 挂 catch 不影响后来者：`await d.promise` 照样能拿到异常。
  promise.catch(() => undefined);
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve(value) {
      d.settled = true;
      res(value);
    },
    reject(error) {
      d.settled = true;
      rej(error);
    },
  };
  return d;
}

// ══════════════════════════════════════════════════════════════════
//  内部状态
// ══════════════════════════════════════════════════════════════════

interface Pending {
  readonly session: EventSession;
  readonly repo: EventRepo;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly eventId: string;
  readonly projection: SessionEvent;
  readonly done: Deferred<number>;
}

interface HubState {
  readonly queue: Pending[];
  worker: Promise<void> | null;
  /** 正在 commit 一条（已出队但还没写完）。flush 要连它一起等。 */
  inFlight: boolean;
  /** 队列彻底排空时兑现。对应 Python `queue.join()` 的等待方。 */
  idle: Deferred<void> | null;
  /**
   * 收据表。Python 用 `id(projection)` 当键；这里直接拿对象当键 —— 同样是恒等
   * 语义，还免掉了「对象被回收后 id 复用」这一类问题。
   */
  readonly receipts: Map<SessionEvent, Deferred<number>>;
}

function newState(): HubState {
  return { queue: [], worker: null, inFlight: false, idle: null, receipts: new Map() };
}

/** `max((seq for seq in ... if seq >= 0), default=-1) + 1` —— 本地序号发号器。 */
function nextLocalSeq(session: EventSession): number {
  let best = -1;
  for (const e of session.events) {
    const s = seqOf(e);
    if (s >= 0 && s > best) best = s;
  }
  return best + 1;
}

/**
 * 把仓储确认过的形态回填进 projection，并广播。
 *
 * 排序键照抄 Python：`(seq < 0, seq if seq >= 0 else -seq)` —— 非负的在前按 seq
 * 升序，未落库的负号排在后面按 |seq| 升序（也就是 emission 先后）。
 * `Array.prototype.sort` 自 ES2019 起规范保证稳定，与 Python 的 sort 一致。
 */
function publishCommitted(
  session: EventSession,
  projection: SessionEvent,
  row: EventRow,
): void {
  const committed: SessionEvent = { ...eventRowAsSse(row) };
  clearAndUpdate(projection, committed);
  // 另一个本地 SSE 订阅者可能已经从仓储轮询里缓存过同一条了。一个 durable seq
  // 只留一份 projection。
  //
  // Python 那边是 `session.events.remove(dup)`，按**值相等**删第一个匹配项；这里
  // 按恒等删。只有「与 projection 内容完全相等的重复项排在 projection 后面」时
  // 两者才会删掉不同的对象，而那种情况下留下来的两个 dict 内容一模一样，值层面
  // 不可观测（commit 之后没有任何人再改 projection）。
  const duplicates = session.events.filter(
    (e) => e !== projection && e["seq"] === row.seq,
  );
  for (const dup of duplicates) {
    const i = session.events.indexOf(dup);
    if (i >= 0) session.events.splice(i, 1);
  }
  session.events.sort((a, b) => {
    const sa = seqOf(a);
    const sb = seqOf(b);
    const na = sa < 0 ? 1 : 0;
    const nb = sb < 0 ? 1 : 0;
    if (na !== nb) return na - nb;
    return (sa >= 0 ? sa : -sa) - (sb >= 0 ? sb : -sb);
  });
  // 这次队列通知只是**唤醒提示**。SSE 永远先按游标读仓储再发，所以一次唤醒既不会
  // 造成重复，也不会暴露未 commit 的 payload。
  for (const subscriber of [...session.subscribers]) subscriber.putNowait(committed);
}

// ══════════════════════════════════════════════════════════════════
//  DurableEventHub
// ══════════════════════════════════════════════════════════════════

/**
 * 进程级有序事件发布器。
 *
 * 一个 ASGI worker 只有一个 loop，因此它所有会话的事件共用同一个 FIFO 写入者 ——
 * 顺序是跨会话全局的，这正是审计日志需要的性质。
 */
export class DurableEventHub {
  private state: HubState | null = null;
  /** `itertools.count(1)`：projection 的临时序号取它的**负数**。 */
  private pendingSeq = 0;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly newEventId: () => string;

  constructor(options: DurableEventHubOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.now = options.now ?? (() => Date.now() / 1000);
    this.newEventId = options.newEventId ?? (() => randomUUID().replace(/-/g, ""));
  }

  /**
   * 入队一条事件，返回它**可变的、pending 的**进程内投影。
   *
   * 注意这里**不通知订阅者** —— 负数 seq 绝不上 SSE。
   */
  enqueue(
    session: EventSession,
    repo: EventRepo,
    kind: string,
    payload: JsonObject,
  ): SessionEvent {
    const state = (this.state ??= newState());
    this.pendingSeq += 1;
    // 负数是**明示的临时值**，永远不会经 SSE 发出去。它的用处是让同步的进程内
    // 消费者能区分不同的 emission，而唯一权威的非负 seq 由仓储发。
    //
    // 键序：payload 里若已有 seq/ts/kind/eventId，键**留在 payload 的位置上、只换
    // 值**（JS 与 Python 在这点上一致，golden 里逐条钉着）。`kind` 写在展开之后，
    // 所以事件类型永远是形参那个，不会被 payload 里同名字段顶掉。
    const projection: SessionEvent = {
      seq: -this.pendingSeq,
      ts: this.now(),
      ...payload,
      kind,
    };
    const eventId = this.newEventId();
    projection["eventId"] = eventId;
    session.events.push(projection);
    const done = makeDeferred<number>();
    state.receipts.set(projection, done);
    state.queue.push({
      session,
      repo,
      kind,
      // emit 后调用方可能继续改同一个 rows/step dict；审计日志必须冻结在
      // emission 边界，不能等 worker 真正 append 时才看到后来版本。
      // 用 structuredClone 而不是 JSON 往返：后者会把 undefined 静默吃掉、把
      // 环状引用变成抛错，与 copy.deepcopy 的行为差得更远。
      payload: structuredClone(payload),
      eventId,
      projection,
      done,
    });
    if (state.worker === null) {
      // Python 是 `loop.create_task(...)`：enqueue 返回时 worker 一步都还没跑。
      // JS 的 async 函数体是**同步**开始执行的，直接 `void this.run(state)` 会在
      // enqueue 里就把 repo.getSession 打出去——调用方连 projection 都还没拿到。
      // 挂到微任务上，把"下一次调度才开始"这件事对齐。
      state.worker = Promise.resolve().then(() => this.run(state));
    }
    return projection;
  }

  /**
   * 没有仓储/运行时可用时的本地兼容路径。
   *
   * 这里是**实例方法**而不是 Python 那样的 `@staticmethod`：Python 的静态方法能从
   * 实例上调（`SESSION_EVENTS.emit_ephemeral(...)`，server.py:235 就是这么调的），
   * TS 的 static 成员在实例上根本不存在，照抄会让唯一的调用点变成 undefined。
   */
  emitEphemeral(session: EventSession, kind: string, payload: JsonObject): SessionEvent {
    const ev: SessionEvent = { seq: nextLocalSeq(session), ts: this.now(), ...payload, kind };
    session.events.push(ev);
    for (const subscriber of [...session.subscribers]) subscriber.putNowait(ev);
    return ev;
  }

  /** 解析 `enqueue` 返回的事件对应的仓储序号。 */
  async waitSeq(event: SessionEvent): Promise<number> {
    const seq = seqOf(event);
    if (seq >= 0) return seq;
    const receipt = this.state?.receipts.get(event);
    if (receipt === undefined) {
      // 本地事件，或收据已经结清并被摘掉了。
      return seqOf(event);
    }
    // Python 是 `await asyncio.shield(receipt)`（保护被等的 future 不被调用方的
    // 取消波及）。Node 没有取消，约定 §2.2 明确不许假装有，所以直接 await。
    return await receipt.promise;
  }

  /** 取当前收据但不等它。 */
  receipt(event: SessionEvent): Promise<number> | null {
    return this.state?.receipts.get(event)?.promise ?? null;
  }

  /** 等到已入队的事件全部处理完（对应 `queue.join()`）。 */
  async flush(): Promise<void> {
    const state = this.state;
    if (state === null) return;
    // while 而不是 if：等的过程中可能又有新事件入队，join 的语义是等到**真的**空。
    while (state.queue.length > 0 || state.inFlight) {
      state.idle ??= makeDeferred<void>();
      await state.idle.promise;
    }
  }

  /** 排空并停掉写入者。关仓储之前必须先调它，否则关停尾部会丢审计。 */
  async shutdown(): Promise<void> {
    const state = this.state;
    if (state === null) return;
    await this.flush();
    // Python 在这里 cancel worker；Node 没有取消（§2.2）。排空之后 worker 自己
    // 就退出了，这里 await 只是把「排空到 worker 真正结束」之间那个缝隙合上：
    // 万一 flush 返回后又有人 enqueue，等它写完比丢掉它好。
    const worker = state.worker;
    if (worker !== null) await worker;
    state.worker = null;
    // 丢弃状态（含收据表）。此后再 enqueue 会重开一份，但 pendingSeq 挂在 hub 上
    // 继续递增 —— 与 Python 一致。
    if (this.state === state) this.state = null;
  }

  private async run(state: HubState): Promise<void> {
    try {
      for (;;) {
        const item = state.queue.shift();
        if (item === undefined) break;
        state.inFlight = true;
        try {
          await this.commit(item, state);
        } catch (err) {
          // commit 按设计不抛（它自己兜住了全部异常）。但订阅者的 putNowait 在
          // 失败分支里是裸调的，一个坏订阅者就能把异常带出来。Python 那边这会让
          // writer task 直接死掉：`queue.join()` 永远等不到，整个 loop 的耐久性
          // 静默停摆——正是这个模块自己在骂的那种"丢事件还不吭声"。所以这里兜一层，
          // 记一条日志继续跑。**这是有意的加固，不是翻译**（已在 deviations 里报）。
          console.error(`session-event 写入者异常，已跳过一条：error=${errText(err)}`);
        } finally {
          state.inFlight = false;
        }
      }
    } finally {
      state.worker = null;
      const idle = state.idle;
      state.idle = null;
      idle?.resolve();
    }
  }

  private async commit(item: Pending, state: HubState): Promise<void> {
    let error: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        // 单测里的 Session 常常刻意脱离持久化。保留它们历来的 local-only 行为。
        // Python 判的是 `is None`；这里 null / undefined 都算"没有" —— 只判 null
        // 的话，一个返回 undefined 的仓储会被当成"会话存在"，然后往一个不存在的
        // 会话上写事件。
        const known = await item.repo.getSession(item.session.id);
        if (known === null || known === undefined) {
          const ev = this.finaliseEphemeral(item);
          if (!item.done.settled) item.done.resolve(seqOf(ev));
          state.receipts.delete(item.projection);
          return;
        }
        const row = await item.repo.appendEvent(
          item.session.id,
          item.kind,
          item.payload,
          item.eventId,
        );
        publishCommitted(item.session, item.projection, row);
        if (!item.done.settled) item.done.resolve(row.seq);
        state.receipts.delete(item.projection);
        return;
      } catch (err) {
        // Python 这里是 `except Exception`，刻意放 `CancelledError`（BaseException）
        // 过去。Node 没有取消这一层，也就没有"必须重新抛出"的那一类；重试本身
        // 就是耐久性的边界，所以这里确实要吞下全部。
        error = err;
        if (attempt + 1 < this.maxAttempts) {
          await sleep(Math.min(0.05 * 2 ** attempt, 0.5));
        }
      }
    }

    // **一条事件彻底写不进去，必须吼出来。** 这次的 bug 里，助手的回答连续
    // 5 次撞 UNIQUE 约束、最终丢掉，而服务器日志**一个字都没有** —— 从外面
    // 看就是"模型答了、界面空着"，没有任何线索。丢事件是数据丢失，不是噪声。
    console.error(
      `session-event 落库失败，已丢弃：session=${item.session.id} ` +
        `kind=${item.kind} error=${errText(error)}`,
    );
    // 绝不假装原来那条已经送达。它的临时 projection 原样留着供诊断，另外推一条
    // 明确的本地失败信号。
    if (!item.done.settled) item.done.reject(error);
    state.receipts.delete(item.projection);
    const warning: SessionEvent = {
      seq: nextLocalSeq(item.session),
      ts: this.now(),
      kind: "event.persist_failed",
      eventKind: item.kind,
      error: errLabel(error),
    };
    item.session.events.push(warning);
    for (const subscriber of [...item.session.subscribers]) subscriber.putNowait(warning);
  }

  /** 退化成 local-only：projection 被换成一条**没有 eventId** 的本地事件。 */
  private finaliseEphemeral(item: Pending): SessionEvent {
    const ev: SessionEvent = {
      seq: nextLocalSeq(item.session),
      ts: this.now(),
      ...item.payload,
      kind: item.kind,
    };
    clearAndUpdate(item.projection, ev);
    // 与 Python 一致：广播出去的是 `ev` 这份，不是 projection —— 两个对象内容
    // 相同但互相独立。
    for (const subscriber of [...item.session.subscribers]) subscriber.putNowait(ev);
    return ev;
  }
}

export const SESSION_EVENTS = new DurableEventHub();
