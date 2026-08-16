/**
 * Recorder —— 持久化执行的核心。移植自 Python 侧 `kernel/recorder.py`。
 *
 * **规则**：工作流代码必须是确定性的；一切非确定性（LLM 调用、工具调用、时间、
 * 随机、网络）都必须包在 `effect()` 里。首次执行时结果写入日志，重放时直接
 * 读回，不重新调用、不重新付费。
 *
 * 恢复粒度是两级：
 *
 *   1. **节点级** —— 历史里有 `NODE_COMPLETED` 的节点整个跳过，直接恢复产出。
 *   2. **effect 级** —— 崩在半路的节点会重跑，但它已完成的 effect 从历史读回。
 *      所以第 47 轮崩溃是从第 47 轮继续，不是从头。
 *
 * effect 的键是 `(node_id, 序号)`，**不是全局 seq** —— 并行节点的全局顺序在两
 * 次运行间不保证一致，按节点命名空间才稳定。节点内如果有并发 effect（比如四个
 * critic 视角同时跑），调用方必须显式传 `key`，否则计数器顺序不稳。
 *
 * ── 相对 Python 的四处改动 ──────────────────────────────────────────
 *
 * **1. 没有 `asyncio.Lock`。** Python 用锁保护"取计数器 → 登记 inflight"这段临界区；
 * JS 没有抢占式线程，两个 `await` 之间的代码不会被打断，而那段临界区里一个 await
 * 都没有 —— 锁在这里是纯粹的噪声。**但这不是"JS 没有竞态"**：`await` 之后的一切
 * 都可能与别的 effect 交错，所以 single-flight 那套记账一行都不能省。
 *
 * **2. `completeNode` / `nodeOutput` 变成 async。** journal.ts 的 BlobStore 是异步的
 * （见那边的文件头：blob 动辄几百 KB，同步写就是毫秒级卡顿），put/get 都要 await。
 *
 * **3. `emit()` 仍是同步的**，但 journal 的落盘是后台的（契约 §2.1）。
 * 后果要说清楚：Python 的 `append` 同步 write 到 OS 缓冲，进程崩掉日志还在；
 * TS 侧进程崩掉会丢掉尚未 drain 的队列。**Run 收尾与节点边界必须 `await
 * journal.flush()`** —— 这是调度器那一层的责任，Recorder 自己不 flush
 * （每个 effect 都等一次磁盘会把整条链路串行化在 IO 上）。
 *
 * **4. 不假装有取消。** Python 那边等待者用 `asyncio.shield(fut)` 包着，防的是
 * "等待者被取消时连带取消正在执行的副作用"。JS 没有任务取消（契约 §2.2），
 * `await promise` 本身就没有这个问题，shield 没有对应物也不需要发明一个。
 */

import { DeterminismViolation, HumanInputRequired, pyRepr } from "./errors.js";
import { EventKind, makeEvent, nowMs, type Event } from "./events.js";
import { fingerprint } from "./ids.js";
import { pyJsonDumps, type BlobStore, type Journal } from "./journal.js";
import { pyFloatRepr } from "./pyfmt.js";

/** payload 超过这个**码位数**就落 BlobStore，事件里只留 ref。 */
export const INLINE_LIMIT = 2048;

/** 重放索引里的一条 effect 记录。 */
interface EffectRecord {
  readonly fp: string;
  readonly ref: string | null;
  /** 小结果直接内联在事件 payload 里；落了 blob 的这里是 undefined。 */
  readonly inline: unknown;
}

/** 同进程 single-flight 的一格。 */
interface Inflight {
  readonly fp: string;
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export interface EmitOptions {
  readonly nodeId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly ref?: string | null;
}

/** 真正干活的可调用对象。返回 Promise 就 await，否则当同步结果用。 */
export type EffectFn = () => unknown;

export interface EffectOptions {
  /** 节点内并发 effect 必须显式传，否则计数器顺序不稳定。 */
  readonly key?: string | null;
}

export interface RecorderOptions {
  readonly resume?: boolean;
}

/** `inspect.isawaitable` 的 JS 对应物。 */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as PromiseLike<unknown>).then === "function"
  );
}

/**
 * `pyJsonDumps` 抛出的序列化错误（循环引用 / 非有限数）。
 *
 * journal.ts 没导出那个类（它不是本 track 的文件，不能去改），所以按 `name` 认。
 * 认错的代价只是"本该走 blob 的东西抛了出来"，不会静默写错数据。
 */
function isJsonDumpError(e: unknown): boolean {
  return e instanceof Error && e.name === "JsonDumpError";
}

/**
 * `len(s) > limit`，其中 len 数的是**码位**（Python 的 `len(str)`），
 * 而 JS 的 `.length` 数的是 UTF-16 码元 —— emoji 之类的星平面字符一个顶两个。
 *
 * 只在跨 INLINE_LIMIT 的判定上需要精确值，所以数到超了就停：
 * 一个几 MB 的结果不该为了求个长度再遍历一遍。
 */
function exceedsCodePoints(s: string, limit: number): boolean {
  if (s.length <= limit) return false; // 码位数 ≤ 码元数，不可能超
  let n = 0;
  for (const _ of s) {
    n += 1;
    if (n > limit) return true;
  }
  return false;
}

/**
 * Python `repr(value)`（容器与标量）。`_digest` 里的 `str(v)` 对非字符串就是它。
 *
 * 为什么要还原 Python 的写法而不是随手 `JSON.stringify`：这段字符串直接进事件
 * 日志，是人排障时唯一看得到的请求摘要。`{'tool': 'sql', 'args': {...}}` 和
 * `{"tool":"sql",...}` 对机器等价，对"拿 Python 时代的日志做比对"不等价。
 *
 * **已知分叉（与 ids.ts / journal.ts 同一族，且只剩这一条）**：JS 分不出 `1` 与
 * `1.0`，值为整数的 float 这边只能印成 `1`。记号阈值那条已经由 `pyFloatRepr`
 * 抹平（`1e-05` 而不是 `0.00001`）。摘要只进日志、不进指纹，所以分叉不影响重放；
 * golden 里把它钉成 known_divergence 而不是绕过。
 */
function pyReprValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  // 整数走 int 的印法（`str(10000)` == "10000"），非整数才是 float 的 repr ——
  // 这正是"1.0 印成 1"那条分叉的落点，没有别的选择。
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return pyRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  if (v instanceof Map) {
    return `{${[...v.entries()].map(([k, x]) => `${pyReprValue(k)}: ${pyReprValue(x)}`).join(", ")}}`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{${entries.map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`).join(", ")}}`;
  }
  return String(v);
}

/** Python `str(v)` —— 字符串是它自己，其余走 repr。 */
function pyStr(v: unknown): string {
  return typeof v === "string" ? v : pyReprValue(v);
}

/**
 * 请求摘要 —— 事件日志里不存全量请求（可能是几十万 token 的 prompt），
 * 全量内容通过 fp 和 blob 关联。
 *
 * Python 侧是模块私有的 `_digest`，这里导出只为 golden 测试能直接打它。
 * 截断按**码位**切（`[...s]`），CJK 与 emoji 才不会被切半个。
 */
export function digestRequest(
  request: Record<string, unknown>,
  limit = 400,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(request)) {
    const s = pyStr(v);
    const cps = [...s];
    out[k] = cps.length <= limit ? s : cps.slice(0, limit).join("") + `…(+${cps.length - limit})`;
  }
  return out;
}

/** 一个 Run 的事件记录器 + 重放器。 */
export class Recorder {
  readonly runId: string;
  readonly journal: Journal;
  readonly blobs: BlobStore;

  private seq = 0;
  /** node_id → 下一个 effect 序号 */
  private readonly counters = new Map<string, number>();
  /**
   * 同进程 single-flight：同一显式 key 并发调用时，第二个等第一个的结果，
   * 绝不再执行一遍副作用。持久多 worker 还需 DB claim / provider idempotency
   * key；这层先封住单 worker 最常见的竞态。
   */
  private readonly inflight = new Map<string, Inflight>();

  // ── 重放索引 ──
  private readonly effects = new Map<string, EffectRecord>();
  /** node_id → 产出 ref（null 表示产出是 None） */
  private readonly completedNodes = new Map<string, string | null>();
  /** request_id → 答案 */
  private readonly humans = new Map<string, unknown>();
  /** node_id → 已尝试次数 */
  private readonly attempts = new Map<string, number>();

  constructor(runId: string, journal: Journal, blobs: BlobStore, opts: RecorderOptions = {}) {
    this.runId = runId;
    this.journal = journal;
    this.blobs = blobs;
    if (opts.resume === true) this.loadHistory();
  }

  // ── 历史加载 ─────────────────────────────────────────────────
  private loadHistory(): void {
    for (const ev of this.journal.read(this.runId)) {
      this.seq = Math.max(this.seq, ev.seq + 1);
      switch (ev.kind) {
        case EventKind.EFFECT_COMPLETED: {
          const key = requireString(ev, "key");
          // 只认第一次记录：同 key 的重复写入意味着重试，应复用首次结果
          if (!this.effects.has(key)) {
            this.effects.set(key, {
              fp: requireString(ev, "fp"),
              ref: ev.ref,
              inline: ev.payload["result"],
            });
          }
          break;
        }
        case EventKind.NODE_COMPLETED:
          this.completedNodes.set(ev.nodeId ?? "", ev.ref);
          break;
        case EventKind.NODE_ENTERED: {
          const nid = ev.nodeId ?? "";
          const raw = ev.payload["attempt"] ?? 0;
          // Python 是 `payload.get("attempt", 0) + 1`：缺失回退 0，值不是数就 TypeError。
          // 日志是外部输入，这里也当场拒绝而不是让 NaN 一路传下去。
          if (typeof raw !== "number") {
            throw new TypeError(`node.entered 的 attempt 不是数字: ${JSON.stringify(raw)}`);
          }
          this.attempts.set(nid, Math.max(this.attempts.get(nid) ?? 0, raw + 1));
          break;
        }
        case EventKind.HUMAN_RECORDED:
          // `payload.get("answer")` 缺字段是 None。TS 侧归一成 null 而不是留着
          // undefined：undefined 落盘时整个键会消失（见 journal.ts），
          // flush 前后 read 到的东西就不一样了。
          this.humans.set(requireString(ev, "request_id"), ev.payload["answer"] ?? null);
          break;
        default:
          break;
      }
    }
  }

  // ── 事件发射 ─────────────────────────────────────────────────
  /**
   * 同步分配 seq、组装事件、交给 journal 入队。**落盘可能在之后才发生**
   * （契约 §2.1）：seq 的原子性是重放的地基，必须同步；落盘的时机不是。
   */
  emit(kind: EventKind, opts: EmitOptions = {}): Event {
    const seq = this.seq;
    this.seq += 1;
    const ev = makeEvent({
      runId: this.runId,
      seq,
      kind,
      nodeId: opts.nodeId ?? null,
      payload: opts.payload ?? {},
      ref: opts.ref ?? null,
      tsMs: nowMs(),
    });
    this.journal.append(ev);
    return ev;
  }

  /** 小结果内联进事件，大结果落 blob。 */
  private async store(value: unknown): Promise<[Record<string, unknown> | null, string | null]> {
    let tooBig: boolean;
    try {
      tooBig = exceedsCodePoints(pyJsonDumps(value, { defaultStr: true }), INLINE_LIMIT);
    } catch (e) {
      // Python 是 `except (TypeError, ValueError): size = INLINE_LIMIT + 1` ——
      // 序列化不了就当"太大"往 blob 走。注意那边随后的 put_json 会用同一个
      // 序列化器再抛一次，所以"吞掉"只是推迟，不是掩盖；这里保持同样的形状。
      if (!isJsonDumpError(e)) throw e;
      tooBig = true;
    }
    if (!tooBig) return [{ result: value }, null];
    return [null, await this.blobs.putJson(value)];
  }

  private async load(rec: EffectRecord): Promise<unknown> {
    if (rec.ref !== null && rec.ref !== "") return await this.blobs.getJson(rec.ref);
    return rec.inline;
  }

  // ── 节点级 checkpoint ────────────────────────────────────────
  nodeIsComplete(nodeId: string): boolean {
    return this.completedNodes.has(nodeId);
  }

  /** Python 侧是同步的；这里 async 只因为 BlobStore 是异步的（见文件头 §2）。 */
  async nodeOutput(nodeId: string): Promise<unknown> {
    if (!this.completedNodes.has(nodeId)) {
      // Python 是 `self._completed_nodes[node_id]` 的 KeyError。
      throw new Error(`节点未完成: ${pyRepr(nodeId)}`);
    }
    const ref = this.completedNodes.get(nodeId) ?? null;
    return ref !== null && ref !== "" ? await this.blobs.getJson(ref) : null;
  }

  nextAttempt(nodeId: string): number {
    const n = this.attempts.get(nodeId) ?? 0;
    this.attempts.set(nodeId, n + 1);
    return n;
  }

  async completeNode(nodeId: string, output: unknown): Promise<void> {
    // blob 必须先于指向它的事件落盘，否则崩溃后会读到一条指着不存在的 blob 的
    // NODE_COMPLETED（journal.ts 文件头记着这条）。await 天然给出这个顺序。
    const ref = await this.blobs.putJson(output);
    this.completedNodes.set(nodeId, ref);
    this.emit(EventKind.NODE_COMPLETED, { nodeId, ref });
  }

  // ── effect ───────────────────────────────────────────────────
  /**
   * 执行一次非确定性动作，或从历史读回。
   *
   * @param nodeId 所属节点，决定 effect 的命名空间。
   * @param kind 动作类型（`llm.call` / `tool.exec` / `clock.now` …），
   *   只进指纹和日志，不影响调度。
   * @param request 请求内容。**会被指纹化**，重放时不一致即报 {@link DeterminismViolation}。
   * @param fn 真正干活的可调用对象，同步异步均可。
   * @param opts.key 节点内并发 effect 必须显式传，否则计数器顺序不稳定。
   *
   * 返回 `unknown` 而不是泛型 `T`：重放路径返回的是 JSON 往返之后的值
   * （Date、class 实例、undefined 全都变了形），给它一个泛型只是把谎写进类型里。
   */
  async effect(
    nodeId: string,
    kind: string,
    request: Record<string, unknown>,
    fn: EffectFn,
    opts: EffectOptions = {},
  ): Promise<unknown> {
    // ── 临界区（无 await，天然原子；见文件头 §1）──
    const key = opts.key ?? null;
    let ekey: string;
    if (key === null) {
      const idx = this.counters.get(nodeId) ?? 0;
      this.counters.set(nodeId, idx + 1);
      ekey = `${nodeId}#${idx}`;
    } else {
      ekey = `${nodeId}#${key}`;
    }
    const recorded = this.effects.get(ekey);

    const fp = fingerprint({ kind, request });
    const pending = this.inflight.get(ekey);
    let waiting: Promise<unknown> | null = null;
    if (recorded === undefined && pending === undefined) {
      this.inflight.set(ekey, newInflight(fp)); // 本次调用是领导者
    } else if (pending !== undefined) {
      // 注意这一支在"历史里有记录 + 同时还有 inflight"时也会跑（Python 的 elif
      // 链就是这个顺序）：先按 inflight 的指纹判，两条判据的报错参数不一样。
      if (pending.fp !== fp) throw new DeterminismViolation(ekey, pending.fp, fp);
      waiting = pending.promise;
    }
    // ── 临界区结束 ──

    if (recorded !== undefined) {
      if (recorded.fp !== fp) throw new DeterminismViolation(ekey, recorded.fp, fp);
      return await this.load(recorded);
    }
    // 走到这里 waiting 非空 ⟺ 上面进的是 elif 那支（有人正在跑同一个 key）。
    // 反过来 waiting 为空就必然是领导者 —— recorded 非空的情况刚刚已经返回了。
    if (waiting !== null) return await waiting;

    this.emit(EventKind.EFFECT_REQUESTED, {
      nodeId,
      payload: { key: ekey, kind, fp, request: digestRequest(request) },
    });
    let result: unknown;
    try {
      const raw = fn();
      result = isThenable(raw) ? await raw : raw;
    } catch (exc) {
      // Python 这里捕的是 BaseException（CancelledError 不在 Exception 之下）：
      // 领导者被取消时若不清掉 single-flight，同 key 的等待者会永久挂住。
      // JS 的 catch 本来就抓一切，注释留着是因为**理由**没变：清理后原样重抛。
      this.emit(EventKind.EFFECT_FAILED, {
        nodeId,
        payload: { key: ekey, kind, error: errorLabel(exc) },
      });
      const inflight = this.inflight.get(ekey);
      this.inflight.delete(ekey);
      // reject 前那个 promise 上已经挂了空 catch（见 newInflight）——
      // 没有等待者时它是一个 rejected 但"已处理"的 promise，不会掀翻进程。
      inflight?.reject(exc);
      throw exc;
    }

    const [stored, ref] = await this.store(result);
    // 键序照抄 Python：result 在前，key/kind/fp 在后 —— 落盘字节跟着插入序走。
    const payload: Record<string, unknown> = { ...(stored ?? {}), key: ekey, kind, fp };
    this.emit(EventKind.EFFECT_COMPLETED, { nodeId, payload, ref });
    this.effects.set(ekey, { fp, ref, inline: payload["result"] });
    const inflight = this.inflight.get(ekey);
    this.inflight.delete(ekey);
    inflight?.resolve(result);
    return result;
  }

  // ── 确定性的时间与随机 ────────────────────────────────────────
  /** 当前毫秒时间戳。走 effect，所以重放时返回首次执行的那个时刻。 */
  async now(nodeId: string): Promise<number> {
    return (await this.effect(nodeId, "clock.now", {}, nowMs)) as number;
  }

  /** `[0, n)` 随机整数。同样记账，重放可复现。 */
  async rand(nodeId: string, n: number): Promise<number> {
    return (await this.effect(nodeId, "clock.rand", { n }, () => {
      // Python 的 random.randrange(0) 抛 ValueError；照抄消息，别让 rand(0)
      // 悄悄返回 0 —— 那个 0 会被记进日志，之后每次重放都理直气壮地还给你。
      if (!Number.isInteger(n) || n <= 0) throw new RangeError("empty range for randrange()");
      return Math.floor(Math.random() * n);
    })) as number;
  }

  // ── 人在环 ───────────────────────────────────────────────────
  /**
   * 请求人工决策。
   *
   * 历史里已有答案就直接返回；否则发出请求并抛 {@link HumanInputRequired}，
   * 由调度器挂起整个 Run。人答完后 API 把 `HUMAN_RECORDED` 写进日志再重新触发，
   * 重放走到这里就能拿到答案。
   */
  async askHuman(
    nodeId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    // Python 侧这个方法是 async 但一次 await 都没有。保持 async：调用点全是
    // `await rec.ask_human(...)`，改成同步会让所有调用点跟着变形。
    if (this.humans.has(requestId)) return this.humans.get(requestId);
    this.emit(EventKind.HUMAN_REQUESTED, {
      nodeId,
      payload: { request_id: requestId, ...payload },
    });
    throw new HumanInputRequired(nodeId, requestId, payload);
  }

  /** 外部（API 层）写入人工决策。 */
  recordHumanAnswer(nodeId: string, requestId: string, answer: unknown): void {
    // undefined 归一成 null（== Python 的 None）：见 loadHistory 里的同一条理由。
    const value = answer ?? null;
    this.humans.set(requestId, value);
    this.emit(EventKind.HUMAN_RECORDED, {
      nodeId,
      payload: { request_id: requestId, answer: value },
    });
  }
}

/**
 * 建一格 single-flight。
 *
 * **`promise.catch(() => {})` 这行不能删**：无人 await 的 rejected promise 在 Node 里
 * 会触发 `unhandledRejection` 直接杀进程 —— 而"领导者失败、恰好没有等待者"是完全
 * 正常的一条路径（绝大多数 effect 根本没有并发调用者）。挂上空 catch 之后 promise
 * 算"已处理"，真正的等待者照样能 await 到那个 rejection。
 *
 * Python 侧对应的是 `pending_fut.exception()` —— 那行只是压掉一条 warning，
 * 语义完全不同，别照着它的"无所谓"来理解这里。
 */
function newInflight(fp: string): Inflight {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { fp, promise, resolve, reject };
}

/**
 * `f"{type(exc).__name__}: {exc}"`。
 *
 * 取的是**类名**而不是 `e.name`：子类忘了设 `name` 时 `e.name` 会退回 "Error"，
 * 而 Python 那边给的是子类名。JS 还能 throw 任意值（Python 只能抛 BaseException），
 * 那种情况退化成 `typeof`，至少不会写出 "undefined: undefined"。
 */
function errorLabel(e: unknown): string {
  if (e instanceof Error) {
    const cls = e.constructor.name;
    return `${cls === "" ? e.name : cls}: ${e.message}`;
  }
  return `${typeof e}: ${String(e)}`;
}

/** 从事件 payload 里取必须存在的字符串字段。Python 那边是 `payload["key"]` 的 KeyError。 */
function requireString(ev: Event, field: string): string {
  const v = ev.payload[field];
  if (typeof v !== "string") {
    throw new TypeError(`${ev.kind} 缺少字段 ${pyRepr(field)}: ${JSON.stringify(ev.payload)}`);
  }
  return v;
}
