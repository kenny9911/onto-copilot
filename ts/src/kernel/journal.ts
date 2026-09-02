/**
 * 事件日志与 blob 存储的持久化 —— 移植自 Python 侧 `kernel/journal.py`，
 * 落盘字节由 golden/journal.json 钉住。
 *
 * 两套实现：
 *   - InMemory* —— 测试与单机 demo。
 *   - File* —— 本地开发；jsonl 追加 + 内容寻址目录。
 *
 * 生产替换成 Postgres（事件元数据）+ S3（blob），接口不变。
 *
 * ── 相对 Python 的两处架构改动（见契约 §2.1）──────────────────────────
 *
 * **1. `append()` 只入队，落盘在后台**。Python 的 `append` 是同步 write+flush；
 * Node 上 `appendFileSync` 会阻塞唯一的事件循环线程，而一次 Run 有几百上千条事件。
 * 所以：`append()` 同步序列化 + 入队后立即返回，`flush(): Promise<void>` 显式等落盘。
 * seq 的原子性是重放的地基（那在 Recorder 里，仍然同步）；落盘的**时机**不是。
 *
 * 序列化本身留在同步路径里：payload 里混进不可序列化的东西时，错误要炸在 emit
 * 的调用点上，而不是几毫秒后从一个没人看的后台任务里冒出来。
 *
 * **2. BlobStore 的 put/get 返回 Promise**。blob 动辄几百 KB（LLM 全文、代码输出），
 * `writeFileSync` 一次就是毫秒级卡顿。put 保持 `await` 而不是学 journal 做 fire-and-forget
 * 还有一个正确性上的理由：**blob 必须先于指向它的事件落盘**，否则崩溃后会读到一条
 * 指着不存在的 blob 的 NODE_COMPLETED。`await put()` 天然给出这个顺序。
 *
 * ── 关于锁 ────────────────────────────────────────────────────────
 * Python 侧的 `threading.Lock` 在这里一律没有对应物：JS 没有抢占式线程，
 * 任意两个 `await` 之间的代码不会被打断。**但 Lock 的第二个作用（把并发写序列化成
 * 一个有序的追加流）仍然需要**，这里由"单一 drain 循环 + FIFO 队列"提供。
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { eventFromDict, eventToDict, type Event } from "./events.js";
import { contentRef } from "./ids.js";
// 与 ids.ts 共用同一份 CPython 数字记号 —— 各写一份就是给分叉留门（已经分叉过一次）。
import { pyFloatRepr } from "./pyfmt.js";

// ══════════════════════════════════════════════════════════════════
//  Python json.dumps 的移植
// ══════════════════════════════════════════════════════════════════
/*
 * 这一层不是"顺手写的序列化"，它是这个模块的**全部价值**：
 *
 *   - jsonl 的一行是 `json.dumps(ev.to_dict(), ensure_ascii=False)`
 *     —— 不排序、默认分隔符 `", "` / `": "`。
 *   - blob 的 ref 是 `json.dumps(obj, ensure_ascii=False, default=str)` 的**内容哈希**，
 *     多一个空格 ref 就全变，Python 时代写下的 blob 一个都找不回来。
 *
 * 所以既不能用 `JSON.stringify`（紧凑分隔符），也不能用 `ids.ts` 的 `canonicalJson`
 * （sort_keys + 紧凑）。数字格式化的规则与 canonicalJson 同源，但**不能复用** ——
 * 那个函数没导出内部原语，而 ids.ts 不是本 track 的文件。重复的是二十行，
 * 代价可控；跨文件去改别人的文件才是真风险。
 */

/** 循环引用/不可序列化时抛这个，消息里带路径，便于定位是 payload 的哪一支。 */
class JsonDumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonDumpError";
    Object.setPrototypeOf(this, JsonDumpError.prototype);
  }
}


/**
 * **已知且被钉住的分叉**：JS 里 `1` 与 `1.0` 是同一个值。Python 内存里值为整数的
 * float（confidence=1.0、1e16）落盘是 `"1.0"` / `"1e+16"`，TS 侧只能给 `"1"` /
 * `"10000000000000000"`。两边表示的是同一个 double，只是记号不同 —— JSON 读回来
 * 一模一样，所以**重放不受影响**，受影响的只有"拿 Python 时代的 .jsonl 做字节比对"。
 * golden 里把这一条钉成已知差异（见 test 的 known_divergence 一节），不绕过。
 */
function pyNumber(x: number): string {
  if (!Number.isFinite(x)) {
    // Python 的 json.dumps 默认会写出裸的 NaN / Infinity —— 那不是合法 JSON，
    // `JSON.parse` 读不回来。也就是说照抄 Python 会写出一份 TS 自己都重放不了的
    // 日志，而且要等到几百条事件之后崩在 read() 里才发现。当场拒绝。
    throw new JsonDumpError(`json.dumps: 不接受非有限数 ${String(x)}`);
  }
  return Number.isInteger(x) ? (Object.is(x, -0) ? "-0.0" : String(x)) : pyFloatRepr(x);
}

/** ensure_ascii=False：只转义引号、反斜杠和控制字符，非 ASCII 原样保留 —— 与
 * `JSON.stringify` 对字符串的行为逐字节一致（落单代理除外，那种串两边都是坏数据）。 */
function pyString(s: string): string {
  return JSON.stringify(s);
}

/** dict 的键：Python 允许 str/int/float/bool/None 当键并按这套规则转成字符串。
 * 普通对象的键本来就是 string，这条只在 payload 里塞了 `Map` 时才用得上。 */
function pyKey(k: unknown): string {
  if (typeof k === "string") return k;
  if (typeof k === "number") return pyNumber(k);
  if (typeof k === "bigint") return k.toString();
  if (typeof k === "boolean") return k ? "true" : "false";
  if (k === null) return "null";
  throw new JsonDumpError(`json.dumps: 键不能是 ${typeof k}`);
}

/** JS 独有的三种"没有值"：Python 的 dict 里根本装不下它们。按 `JSON.stringify` 的
 * 老规矩处理 —— 对象里整个键消失，数组里变 null。**不静默转成 null 塞进对象**，
 * 那会让日志里凭空多出一堆 `"x": null`。 */
function isAbsent(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function dump(v: unknown, fallback: ((v: unknown) => string) | null, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNumber(v);
  // bigint 就是 Python 的任意精度 int —— 超过 2^53 的整数只有走它才不丢精度
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return pyString(v);

  if (typeof v === "object") {
    // Python 是 check_circular=True → ValueError。这里不查的话是爆栈（RangeError），
    // 而爆栈发生在 append 的同步路径上，整个进程一起完蛋。
    if (seen.has(v)) throw new JsonDumpError("json.dumps: 检测到循环引用");
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const items = v.map((x) => (isAbsent(x) ? "null" : dump(x, fallback, seen)));
        return `[${items.join(", ")}]`;
      }
      if (!(v instanceof Map) && !isPlainObject(v)) {
        // Date / class 实例这类：Python 侧同样落到 default 钩子上。没有钩子就抛，
        // 别把它当成"属性为空的普通对象"序列化成 `{}` —— 那是静默丢数据。
        if (fallback === null) {
          const tag = Object.prototype.toString.call(v);
          throw new JsonDumpError(`json.dumps: 不可序列化的对象 ${tag}`);
        }
        return pyString(fallback(v));
      }
      // 键序 = 插入序，与 Python dict 一致，**但有一个例外**：形如 "0" / "12" 的
      // 整数样式键会被 V8 提到最前面（对象的固有行为，不是这里能修的）。payload
      // 的键要么是标识符要么是中文，撞不上；真需要数字键请传 Map。
      const entries: [unknown, unknown][] =
        v instanceof Map ? [...v.entries()] : Object.entries(v as Record<string, unknown>);
      const parts: string[] = [];
      for (const [k, val] of entries) {
        if (isAbsent(val)) continue;
        parts.push(`${pyString(pyKey(k))}: ${dump(val, fallback, seen)}`);
      }
      return `{${parts.join(", ")}}`;
    } finally {
      // 出了这一支就放开：同一个对象在**兄弟**位置出现两次是合法的（Python 也允许），
      // 只有祖先链上的重复才是环。
      seen.delete(v);
    }
  }

  if (fallback === null) throw new JsonDumpError(`json.dumps: 不接受 ${typeof v}`);
  return pyString(fallback(v));
}

/**
 * Python `json.dumps(obj, ensure_ascii=False)` —— **默认分隔符 `", "` / `": "`，不排序**。
 *
 * `defaultStr: true` 对应 `default=str`（`BlobStore.put_json` 用的那一档）：
 * 不可序列化的东西转成 `str(obj)` 再当字符串写进去，而不是抛。
 */
export function pyJsonDumps(obj: unknown, opts?: { readonly defaultStr?: boolean }): string {
  const fallback = opts?.defaultStr === true ? (v: unknown) => String(v) : null;
  // 顶层的 undefined：Python 没有对应物。JSON.stringify 返回 undefined（不是字符串），
  // 那个返回值一路传下去会写出字面量 "undefined" 的坏行，所以这里直接拒绝。
  if (isAbsent(obj)) {
    if (fallback === null) throw new JsonDumpError(`json.dumps: 不接受顶层 ${typeof obj}`);
    return pyString(fallback(obj));
  }
  return dump(obj, fallback, new Set());
}

/** 一条事件的落盘形态（**不含**换行）—— 与 `journal.py:144` 逐字一致。 */
export function eventLine(event: Event): string {
  return pyJsonDumps(eventToDict(event));
}

// ══════════════════════════════════════════════════════════════════
//  BlobStore
// ══════════════════════════════════════════════════════════════════

/** blob 不存在。Python 侧抛的是 `KeyError(f"blob 不存在: {ref}")`，消息照抄；
 * 换成具名类是因为 JS 没有 KeyError，而"找不到 blob"必须能和别的错误分开来 catch。 */
export class BlobNotFound extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(`blob 不存在: ${ref}`);
    this.ref = ref;
    this.name = "BlobNotFound";
    Object.setPrototypeOf(this, BlobNotFound.prototype);
  }
}

/** 内容寻址存储。同样的内容写多次只占一份，天然幂等。 */
export abstract class BlobStore {
  abstract put(data: Uint8Array | string): Promise<string>;
  abstract get(ref: string): Promise<Uint8Array>;

  putJson(obj: unknown): Promise<string> {
    return this.put(pyJsonDumps(obj, { defaultStr: true }));
  }

  async getJson(ref: string): Promise<unknown> {
    // fatal:true 对齐 Python：`json.loads(bytes)` 遇到非法 UTF-8 是抛，
    // 而 TextDecoder 默认会把坏字节替换成 U+FFFD 再让 JSON.parse 报一个
    // 完全看不出病根的语法错误。
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.get(ref)));
  }
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

export class InMemoryBlobStore extends BlobStore {
  private readonly d = new Map<string, Uint8Array>();

  override put(data: Uint8Array | string): Promise<string> {
    const raw = toBytes(data);
    const ref = contentRef(raw);
    // setdefault 语义：内容寻址下重复写的是同一串字节，先到的那份留着就行
    if (!this.d.has(ref)) this.d.set(ref, raw);
    return Promise.resolve(ref);
  }

  override get(ref: string): Promise<Uint8Array> {
    const raw = this.d.get(ref);
    if (raw === undefined) return Promise.reject(new BlobNotFound(ref));
    return Promise.resolve(raw);
  }

  /** 对应 Python 的 `__len__`。
   * 注意 Python 那边有个坑：空的 InMemoryBlobStore 因为有 `__len__` 而是 falsy，
   * `blobs or InMemoryBlobStore()` 会把共享实例换掉（tests/test_orchestration.py:273
   * 记着这条事故）。JS 的对象恒为真值，这个坑在 TS 侧不存在。 */
  get size(): number {
    return this.d.size;
  }
}

/** 落盘 tmp 名的进程内计数器，见 FileBlobStore.put。 */
let tmpSeq = 0;

/** 按 ref 前两位分桶，避免单目录文件数爆炸。 */
export class FileBlobStore extends BlobStore {
  readonly root: string;

  constructor(root: string) {
    super();
    this.root = root;
    // 构造里同步建目录：只发生一次，且换成异步就得给所有调用点加 await
    mkdirSync(this.root, { recursive: true });
  }

  /** `ref.split(":", 1)[-1]` —— 只切**第一个**冒号，没有冒号就是整串。 */
  pathFor(ref: string): string {
    const i = ref.indexOf(":");
    const digest = i === -1 ? ref : ref.slice(i + 1);
    return join(this.root, digest.slice(0, 2), digest);
  }

  override async put(data: Uint8Array | string): Promise<string> {
    const raw = toBytes(data);
    const ref = contentRef(raw);
    const p = this.pathFor(ref);
    if (await exists(p)) return ref;
    await mkdir(dirname(p), { recursive: true });
    // 先写 tmp 再 rename：原子落盘，避免读到半截文件。
    //
    // tmp 名带唯一后缀，Python 那边是固定的 `<digest>.tmp`。**不是美化**：同一份
    // 内容并发 put 两次时，两个写入者会写同一个 tmp，先完成的把它 rename 走，
    // 后完成的 rename 拿到 ENOENT 直接抛。Python 侧同样有这个洞，只是那边的调用
    // 基本是顺序的；Node 上并发 await 才是常态，撞上只是时间问题。
    const tmp = `${p}.${process.pid}.${(tmpSeq += 1)}.tmp`;
    await writeFile(tmp, raw);
    await rename(tmp, p);
    return ref;
  }

  override async get(ref: string): Promise<Uint8Array> {
    try {
      return await readFile(this.pathFor(ref));
    } catch (e) {
      if (isNotFound(e)) throw new BlobNotFound(ref);
      throw e; // 权限/IO 错误不能伪装成"不存在" —— 那会让上层以为该重算
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  Journal
// ══════════════════════════════════════════════════════════════════

/** append-only 事件日志。永不修改、永不删除 —— 审计要求。 */
export abstract class Journal {
  /** 同步分配位置并入队，落盘可能在之后才发生（见文件头 §2.1）。
   * 序列化在这里同步做，所以坏 payload 当场抛在调用点上。 */
  abstract append(event: Event): void;

  /** 惰性迭代。返回的是生成器，**第一次 next() 才真正读** —— 与 Python 的
   * 生成器同语义（`read()` 本身不做任何事）。 */
  abstract read(runId: string): IterableIterator<Event>;

  /** 等待此前 `append` 的事件全部落盘。落盘失败在这里抛出来。 */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  lastSeq(runId: string): number {
    let seq = -1;
    for (const ev of this.read(runId)) seq = ev.seq;
    return seq;
  }
}

export class InMemoryJournal extends Journal {
  private readonly runs = new Map<string, Event[]>();

  override append(event: Event): void {
    const list = this.runs.get(event.runId);
    if (list === undefined) this.runs.set(event.runId, [event]);
    else list.push(event);
  }

  override *read(runId: string): IterableIterator<Event> {
    // 拷一份再迭代：调用方常在遍历历史的同时继续追加新事件
    const snapshot = [...(this.runs.get(runId) ?? [])];
    yield* snapshot;
  }

  override lastSeq(runId: string): number {
    const evs = this.runs.get(runId);
    return evs === undefined || evs.length === 0 ? -1 : evs[evs.length - 1]!.seq;
  }
}

interface Pending {
  readonly runId: string;
  readonly line: string; // 已含结尾换行
}

export interface FileJournalOptions {
  /**
   * 后台落盘失败的上报口。默认打 stderr —— 事件日志静默少几行是审计事故，
   * 不能因为"没人 await 后台任务"就把错误吃掉。`flush()` 也会把它们抛出来。
   */
  readonly onError?: (err: Error) => void;
}

/** 每个 Run 一个 jsonl 文件。 */
export class FileJournal extends Journal {
  readonly root: string;

  private readonly queue: Pending[] = [];
  /** runId → 已**确认**落盘的字节数。read() 只认这个长度以内的内容，见 read() 的注释。 */
  private readonly committed = new Map<string, number>();
  private readonly errors: Error[] = [];
  private readonly onError: (err: Error) => void;
  private scheduled = false;
  private pumping = false;
  private tail: Promise<void> | null = null;

  constructor(root: string, opts: FileJournalOptions = {}) {
    super();
    this.root = root;
    this.onError =
      opts.onError ??
      ((err) => {
        console.error(`[journal] 落盘失败: ${err.message}`);
      });
    mkdirSync(this.root, { recursive: true });
  }

  pathFor(runId: string): string {
    return join(this.root, `${runId}.jsonl`);
  }

  override append(event: Event): void {
    const line = eventLine(event) + "\n";
    // 首次见到这个 run 就记下文件现有大小：本进程之前写的（或上一次进程留下的）
    // 都算已提交，之后的增量由 drain 自己记账。
    if (!this.committed.has(event.runId)) {
      this.committed.set(event.runId, this.fileSize(event.runId));
    }
    this.queue.push({ runId: event.runId, line });
    this.schedule();
  }

  override async flush(): Promise<void> {
    // drain 期间可能又有新事件入队，所以循环到队列真的空为止
    while (this.queue.length > 0 || this.pumping) {
      this.pump(); // 不等 setImmediate，flush 是"现在就要"
      if (this.tail !== null) await this.tail;
    }
    const errs = this.errors.splice(0); // 取走：同一批错误不重复抛第二次
    if (errs.length === 1) throw errs[0];
    if (errs.length > 1) throw new AggregateError(errs, `journal 落盘失败 ${errs.length} 批`);
  }

  /**
   * 读回一个 Run 的全部事件（**含尚未落盘的**）。
   *
   * "含尚未落盘的"不是便利功能，是正确性：`append` 改成异步之后，
   * `append(); read()` 这个在 Python 下天经地义的序列如果读不到刚写的事件，
   * 就会以"重放少了几步"的形式在很远的地方发作。
   *
   * 文件只读到 `committed` 字节为止：`appendFile` 的字节在它的 Promise resolve
   * **之前**就已经对读者可见（write 完成、close 还没回来），那个窗口里队列还没
   * 出队，直接拼就会读出两份。按已确认字节数截断把这个窗口封死了。
   */
  override *read(runId: string): IterableIterator<Event> {
    const raw = this.readFile(runId);
    // 本实例没写过这个 run → 整个文件都算已提交（新进程 resume 走的就是这一支）。
    // 反过来，本实例写过、同时**别的进程**也在往同一个 run 追加时，对方的字节会被
    // 这条截断规则挡在外面 —— Python 侧本来也没有跨进程写者的保证（它只有个进程内锁）。
    const limit = this.committed.get(runId) ?? raw.length;
    const text = raw.subarray(0, limit).toString("utf8");
    const pending = this.queue.filter((p) => p.runId === runId).map((p) => p.line);
    // 队列里的行也走一遍"序列化→反序列化"，这样 flush 前后 read() 的结果完全相同
    // （payload 里的 Map、大整数这些在落盘时会被规整，不能只有一边规整）。
    // 文件行与内存行分开走：**文件的最后一行**允许是撕裂的半行 —— 进程在
    // append 中途被杀、或读者恰好赶在写者落笔一半时（committed 记账挡住了
    // 本实例的窗口，挡不住上一个进程留下的尾巴）。WAL 语义：没写完的尾行等于
    // 从未提交，静默丢弃。**中间行**撕裂是真损坏，照抛；内存队列里的行由本
    // 进程刚序列化，坏了就是代码 bug，也照抛。
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i += 1) {
      const s = fileLines[i]!.trim();
      if (s === "") continue;
      let ev: Event;
      try {
        ev = eventFromDict(JSON.parse(s));
      } catch (exc) {
        const isTail = fileLines.slice(i + 1).every((l) => l.trim() === "");
        if (isTail && exc instanceof SyntaxError) break;
        throw exc;
      }
      yield ev;
    }
    for (const line of pending) {
      const s = line.trim();
      if (s !== "") yield eventFromDict(JSON.parse(s));
    }
  }

  private readFile(runId: string): Buffer {
    try {
      return readFileSync(this.pathFor(runId));
    } catch (e) {
      if (isNotFound(e)) return Buffer.alloc(0);
      throw e;
    }
  }

  private fileSize(runId: string): number {
    try {
      return statSync(this.pathFor(runId)).size;
    } catch {
      return 0;
    }
  }

  private schedule(): void {
    if (this.scheduled || this.pumping) return;
    this.scheduled = true;
    // setImmediate 而不是立刻开写：一个 tick 里 emit 的十几条事件会被并成一次
    // appendFile。flush() 不等这个定时器，它直接 pump()。
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping || this.queue.length === 0) return;
    this.pumping = true;
    // **必须挂 .catch()**：无人 await 的 rejected promise 在 Node 里会触发
    // unhandledRejection 直接杀进程。（Python 侧那句 `pending_fut.exception()`
    // 只是压掉一条 warning，语义完全不同 —— 别照着它的"无所谓"来理解这一行。）
    // catch 之后 tail 永不 reject，flush 的错误统一从 this.errors 出。
    this.tail = this.drainLoop().catch((e: unknown) => {
      this.record(asError(e));
    });
  }

  private async drainLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        // 同一个 run 的连续若干条并成一次 appendFile；跨 run 就断开，
        // 保证每个文件内部严格 FIFO。
        const runId = this.queue[0]!.runId;
        let n = 1;
        while (n < this.queue.length && this.queue[n]!.runId === runId) n += 1;
        const batch = this.queue.slice(0, n);
        const text = batch.map((p) => p.line).join("");
        try {
          await appendFile(this.pathFor(runId), text, { encoding: "utf8" });
          this.committed.set(runId, (this.committed.get(runId) ?? 0) + Buffer.byteLength(text));
        } catch (e) {
          // 失败的这一批**丢掉**：留在队列里就是死循环，还会把后面所有事件堵死。
          // 代价是日志有洞，所以必须响亮地报出去（onError + flush 抛）。
          this.record(asError(e));
          // 磁盘上可能留了半截行（ENOSPC 写到一半）。重新对齐字节数，让后续记账
          // 不至于越错越远；那半截行会在 read() 里炸出 JSON 语法错 —— 与 Python
          // 侧的表现一致，比静默跳过一行强。
          try {
            this.committed.set(runId, statSync(this.pathFor(runId)).size);
          } catch {
            this.committed.delete(runId);
          }
        }
        // **出队必须在写完之后**：写进行中时读者要能从队列里看到这些事件（见 read()）
        this.queue.splice(0, n);
      }
    } finally {
      this.pumping = false;
    }
  }

  private record(err: Error): void {
    this.errors.push(err);
    try {
      this.onError(err);
    } catch {
      // 上报口自己炸了不能再往上冒：这里已经在后台任务里，抛出去就是 unhandledRejection
    }
  }
}

// ── 小工具 ─────────────────────────────────────────────────────────

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
