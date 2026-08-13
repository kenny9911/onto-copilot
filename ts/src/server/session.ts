/**
 * 会话对象与它的进程内注册表 —— 移植自 `server.py` 第 125~271 / 424~526 行。
 *
 * 状态全部落在磁盘与库上（`workspace/<id>/`），内存里只放句柄 —— 这样进程重启后
 * 产物还在，事件日志也还能重放。这个模块是 server 段的**地基**：另外五段都从这里
 * 取 `Session` / `sess()` / `sessAsync()` / 三个租约的 TTL。
 *
 * ── 与 Python 的分叉（都在 divergences 里报了）─────────────────────────────
 *
 * 1. `asyncio.Lock` 没有对等物 → 本文件的 {@link AsyncLock}（FIFO，与 asyncio 一致）。
 * 2. `asyncio.Task` 没有取消（约定 §2.2）→ {@link CancellableTask} 是**协作式**的：
 *    `cancel()` 只 abort 一个 signal，被取消的那一侧必须自己检查。不假装有抢占式取消。
 * 3. Python 的模块级 `ROOT` / `_BUILD_LEASE_TTL` 等是可重绑的全局；ESM 的导出是只读
 *    绑定，所以这里一律走 `root()` / `buildLeaseTtl()` 这样的取值函数。
 * 4. `_hydrate` 住在 server.py 第 1763 行（别的段），本文件只留注册点
 *    {@link registerHydrator} 与它需要的 single-flight 工具 {@link withHydrateLock}。
 */

import { HTTPException } from "hono/http-exception";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { fingerprint, sha256Hex } from "../kernel/ids.js";
import { SESSION_EVENTS } from "../session_events.js";
import type { EventRepo, EventSubscriber, SessionEvent } from "../session_events.js";
import { getRepo, workspaceRoot } from "../store/deps.js";
import type { Repo } from "../store/repo/protocol.js";
import type { JsonObject } from "../store/types.js";

// ══════════════════════════════════════════════════════════════════
//  进程身份与落盘根
// ══════════════════════════════════════════════════════════════════

/** 这个 worker 的身份。租约的持有者写它，多副本靠它区分。 */
export const WORKER_ID = `worker-${randomUUID().replace(/-/g, "")}`;

// 与 store 使用同一份配置源。模块级初值覆盖普通 env 启动；lifespan 在加载
// `.env` 后还会刷新一次，避免数据库落在配置目录、材料却落在 cwd/workspace。
let _root = workspaceRoot();

/** 材料与产物的落盘根。**取值函数**而不是导出常量，理由见文件头分叉 3。 */
export function root(): string {
  return _root;
}

/** lifespan 载完 `.env` 后重算一次。别的地方不要调。 */
export function refreshRoot(): string {
  _root = workspaceRoot();
  return _root;
}

// ══════════════════════════════════════════════════════════════════
//  三个租约的 TTL
// ══════════════════════════════════════════════════════════════════

/** 环境变量里的 TTL 读坏了也不许让模块导入失败 —— 照抄 Python 的三个 `_configured_*`。 */
function configuredTtl(envName: string, fallback: number): number {
  const raw = process.env[envName];
  // Python 是 `float(os.getenv(name, "30"))`：变量缺席用默认串。空串在 Python 侧
  // 会抛 ValueError 从而落到 except 分支，两边结果都是 fallback。
  const text = raw === undefined ? String(fallback) : raw;
  const v = Number(text);
  // `Number("")` 是 0、`Number("  ")` 也是 0，而 Python 的 float("") 抛错。显式挡掉
  // 空白串，否则一个手滑写空的环境变量会静默把 TTL 压到下界 5s。
  if (text.trim() === "" || !Number.isFinite(v)) return fallback;
  return Math.max(5.0, v);
}

let _buildLeaseTtl = configuredTtl("ONTOCOPILOT_BUILD_LEASE_TTL", 30);
let _buildHeartbeatInterval = Math.min(_buildLeaseTtl / 3, 10.0);
let _chatLeaseTtl = configuredTtl("ONTOCOPILOT_CHAT_LEASE_TTL", 30);
let _chatHeartbeatInterval = Math.min(_chatLeaseTtl / 3, 5.0);
const _mutationLeaseTtl = configuredTtl("ONTOCOPILOT_MUTATION_LEASE_TTL", 30);
const _mutationHeartbeatInterval = Math.min(_mutationLeaseTtl / 3, 5.0);

/** build 执行租约（秒）。抢占语义：过期后别的 worker 可以接管同一个会话的 build。 */
export function buildLeaseTtl(): number {
  return _buildLeaseTtl;
}
/** build 租约的续期间隔。TTL 的 1/3、且不超过 10s —— 一次网络抖动不该丢租约。 */
export function buildHeartbeatInterval(): number {
  return _buildHeartbeatInterval;
}
/** chat 接管租约（秒）。 */
export function chatLeaseTtl(): number {
  return _chatLeaseTtl;
}
export function chatHeartbeatInterval(): number {
  return _chatHeartbeatInterval;
}
/** Question / Audit / chat 结构性编辑共用的跨 worker 变更租约（秒）。 */
export function mutationLeaseTtl(): number {
  return _mutationLeaseTtl;
}
export function mutationHeartbeatInterval(): number {
  return _mutationHeartbeatInterval;
}

/**
 * lifespan 载完 `.env` 后重算租约 TTL。
 *
 * **只刷 build 与 chat，不刷 mutation** —— 照抄 Python：`_lifespan` 的 `global`
 * 声明里根本没有 `_MUTATION_LEASE_TTL`，所以变更租约的 TTL 永远停在**导入时刻**
 * 读到的值。写进 `.env`（而不是导出到进程环境）的 `ONTOCOPILOT_MUTATION_LEASE_TTL`
 * 因此不生效。这是原件的行为，不是这里的疏漏；要改是迁移之后另开一件事。
 */
export function refreshLeaseTtls(): void {
  _buildLeaseTtl = configuredTtl("ONTOCOPILOT_BUILD_LEASE_TTL", 30);
  _buildHeartbeatInterval = Math.min(_buildLeaseTtl / 3, 10.0);
  _chatLeaseTtl = configuredTtl("ONTOCOPILOT_CHAT_LEASE_TTL", 30);
  _chatHeartbeatInterval = Math.min(_chatLeaseTtl / 3, 5.0);
}

// ══════════════════════════════════════════════════════════════════
//  asyncio 的两样东西在 Node 上的等价物
// ══════════════════════════════════════════════════════════════════

/**
 * `asyncio.Lock` 的等价物：**FIFO**、可重入检测靠调用方自觉（asyncio.Lock 同样
 * 不可重入，同一协程二次 acquire 就是死锁）。
 *
 * 为什么必须 FIFO 而不是"谁抢到算谁的"：Question 转态与 Revision 发号靠这把锁
 * 收口成临界区，乱序会让两个并发编辑拿到同一个号。
 */
export class AsyncLock {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.locked = false;
      return;
    }
    // 直接把锁交给队首，不经过 locked=false —— 中间那一瞬如果放开，
    // 后到的 acquire() 会插队拿走，FIFO 就断了。
    next();
  }

  /** `async with lock:` 的等价物。异常路径也必须放锁，所以只暴露这一个安全用法。 */
  async run<T>(body: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await body();
    } finally {
      this.release();
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

/**
 * `asyncio.Task` 的**协作式**替身。
 *
 * 约定 §2.2：Node 没有真正的任务取消，这里不假装有。`cancel()` 只是 abort 一个
 * `AbortSignal`；被取消方（模型调用、管线循环）要自己在检查点上看 `signal.aborted`
 * 并退出。停止按钮因此**不是立刻生效**的 —— 这是事实，不要在 UI 上说成是。
 */
export interface CancellableTask {
  readonly promise: Promise<unknown>;
  readonly signal: AbortSignal;
  /** 已经结束（正常或异常）。 */
  readonly done: boolean;
  /** 请求取消。可重复调用。 */
  cancel(): void;
}

/** 起一个可协作取消的后台任务。**promise 上已经挂了 catch**，见约定 §2.1。 */
export function spawnCancellable(
  body: (signal: AbortSignal) => Promise<unknown>,
): CancellableTask {
  const ac = new AbortController();
  const task = {
    signal: ac.signal,
    done: false,
    cancel(): void {
      if (!ac.signal.aborted) ac.abort();
    },
  } as { signal: AbortSignal; done: boolean; cancel(): void; promise: Promise<unknown> };
  const promise = (async () => body(ac.signal))().finally(() => {
    task.done = true;
  });
  // 无人 await 的 rejected promise 在 Node 上直接杀进程（约定 §2.1）。挂 catch 不
  // 影响后来者：`await t.promise` 照样拿得到异常。
  promise.catch(() => undefined);
  task.promise = promise;
  return task;
}

// ══════════════════════════════════════════════════════════════════
//  会话
// ══════════════════════════════════════════════════════════════════

/** `Session.files` 里的一条。**进程内投影**，权威在 `session_file` 表。 */
export interface SessionFile {
  name: string;
  size: number;
  /** 绝对路径（`root()` + `rel_path`）。库里存的是相对路径。 */
  path: string;
  sha256: string;
}

/** `Session.brief()` 的线上形态。字段名是前端契约，一个字都不能改。 */
export interface SessionBrief {
  id: string;
  title: string;
  project: string;
  project_id: string;
  status: string;
  files: number;
  mode: string;
  created: number;
  error: string;
}

/** 少数保留状态投影的内容事件 —— 兼容迁移前的会话（Python server.py:3153）。 */
export const CARD_EVENT_KINDS: readonly string[] = ["ui.table", "export.ready"];
export const CARD_EVENT_CAP = 12;

/**
 * 一次建模会话。
 *
 * 状态全部落在磁盘上（`workspace/<id>/`），内存里只放句柄 —— 这样进程重启
 * 后产物还在，事件日志也还能重放。
 *
 * 字段名转成 camelCase（约定：字段 camelCase，线上形态 snake_case）；`brief()`
 * 吐出去的键仍逐字等于 Python。
 */
export class Session {
  readonly id: string;
  title = "新建会话";
  /** 印在 xlsx / 交付包文件名上的**客户项目名**。改它会改产物。 */
  project = "";
  /**
   * 侧栏项目文件夹（project.id）。""=未归类。**和上面的 project 不是一回事**：
   * project 是印在 xlsx/交付包文件名上的客户项目名，改它会改产物；这一列只管
   * 分组和「同项目的会话共享哪份记忆」。两者并存，谁也不顶替谁。
   */
  projectId = "";
  created: number = Date.now() / 1000;
  files: SessionFile[] = [];
  /** idle | parsing | extracting | awaiting_answer | done | failed | stopped */
  status = "idle";
  /** SSE 订阅者的队列。断线重连时按 seq 补发，见 /stream。 */
  subscribers: EventSubscriber[] = [];
  events: SessionEvent[] = [];
  state: Record<string, unknown> = {};
  error = "";
  /**
   * 最近一次装入/写入的 durable projection 版本。多 worker 的 Session 缓存
   * 不是事实源；chat 抢到仓储租约后用它判断是否必须先刷新再执行下一轮。
   */
  stateVersion = 0;
  /**
   * 当前请求选的界面语言（zh/en）。请求时捕获，供**后台管线**读取 —— 管线跑在
   * 非请求作用域、读不到 cookie/请求，只能靠 Session 传递（与鉴权/配置同一套手法）。
   */
  lang = "zh";
  /**
   * 归属账号 id（app_user.id），与库里的 session.owner 一致。用量流水要按账号
   * 记，而记账发生在**非请求作用域**的后台管线里 —— 和 lang 同一个理由。
   */
  owner = "";
  /** 正在跑的对话轮 / 梳理任务的句柄 —— 停止按钮据此 cancel。运行时对象，**不落库**。 */
  chatTask: CancellableTask | null = null;
  runTask: CancellableTask | null = null;
  /**
   * 每次 build 独有的 lease token。不能只用进程 id：同一 worker 停掉旧任务后
   * 立刻重跑时，旧任务的 finally 否则会误删新任务的 lease（ABA）。
   */
  buildLeaseOwner = "";
  /**
   * Question/Audit/chat 结构性编辑共用一把跨 worker 的耐久租约。
   * token 是**单次调用作用域**的，绝不写进 session_state。
   */
  mutationLeaseOwner = "";
  /**
   * Question/Decision 并发锁。Decision claim 在 repo 内是原子的；这把锁
   * 还将 OIR 回写、Question 转态、Revision 发号收口为一个进程内临界区。
   */
  readonly questionLock = new AsyncLock();
  /**
   * build 的「检查状态 → 占位 → 创建任务」必须原子。否则同一 event loop
   * 两个并发 POST 都可能在后台任务真正把状态改成 parsing 前越过检查。
   */
  readonly buildLock = new AsyncLock();

  constructor(id: string, init: Partial<Omit<Session, "id">> = {}) {
    this.id = id;
    // 默认值写在 field 上、再在这里按需覆盖。**不要**改成 `Object.assign(this, init)`：
    // 那会让调用方一个笔误（`projectid`）静默长出一个野字段。
    if (init.title !== undefined) this.title = init.title;
    if (init.project !== undefined) this.project = init.project;
    if (init.projectId !== undefined) this.projectId = init.projectId;
    if (init.created !== undefined) this.created = init.created;
    if (init.files !== undefined) this.files = [...init.files];
    if (init.status !== undefined) this.status = init.status;
    if (init.state !== undefined) this.state = { ...init.state };
    if (init.error !== undefined) this.error = init.error;
    if (init.stateVersion !== undefined) this.stateVersion = init.stateVersion;
    if (init.lang !== undefined) this.lang = init.lang;
    if (init.owner !== undefined) this.owner = init.owner;
  }

  /** 这个会话的落盘目录。`root()` 会在 lifespan 里被刷新，所以每次现算。 */
  get dir(): string {
    return join(_root, this.id);
  }

  /**
   * 发一条事件。
   *
   * 保持同步接口，但不再发一个 `events.length` 临时序号给 SSE。运行在服务
   * event loop 时，DurableEventHub 串行 append；仓储返回的 seq 才会广播，并
   * 原地回填这个 projection。没有运行时/仓储的纯领域调用保持 local-only。
   *
   * Python 侧 `kind` 是**位置限定**参数（`/`）：payload 里带 `kind` 字段是很自然的
   * 写法（冲突类型、产物类型都叫 kind）。TS 这边 payload 是个显式对象，天然不会
   * 与形参撞名 —— 但 hub 仍把 `kind` 写在展开之后，事件类型不会被 payload 顶掉。
   */
  emit(kind: string, payload: JsonObject = {}): SessionEvent {
    let ev: SessionEvent;
    try {
      const repo = asEventRepo(currentRepo());
      ev = SESSION_EVENTS.enqueue(this, repo, kind, payload);
    } catch {
      // Python 捕的是 `(RuntimeError, LookupError)` —— 「仓储没起来 / 不在运行时里」。
      // TS 侧 `getRepo()` 抛的就是那个 RuntimeError 的对等物；捕全部是因为这条路
      // 的唯一目的是"发不出去就退回 local-only"，而发事件本身绝不能把调用方带下去。
      ev = SESSION_EVENTS.emitEphemeral(this, kind, payload);
    }
    // 少数内容事件继续保留状态投影，兼容迁移前的会话；新会话的权威历史始终是
    // session_event，hydrate 不会重复灌这份 cards。
    if (CARD_EVENT_KINDS.includes(kind)) {
      let cards = this.state["_cards"];
      if (!Array.isArray(cards)) {
        cards = [];
        this.state["_cards"] = cards;
      }
      const list = cards as SessionEvent[];
      list.push(ev);
      // Python 是 `del cards[:-CAP]` —— 原地删头部，留最后 CAP 条。必须原地：
      // 换成重新赋值会把别处已经拿到的引用留在旧数组上。
      if (list.length > CARD_EVENT_CAP) list.splice(0, list.length - CARD_EVENT_CAP);
    }
    return ev;
  }

  /**
   * 发一条事件并等到 projection 拿到权威 seq。
   *
   * 绝大多数遥测用同步的 {@link emit} 就够；把序号**立刻当成 API 契约**暴露出去的
   * 调用方（表格下载链接、chat turn 关联）用这个。
   */
  async emitDurable(kind: string, payload: JsonObject = {}): Promise<SessionEvent> {
    const event = this.emit(kind, payload);
    await SESSION_EVENTS.waitSeq(event);
    return event;
  }

  brief(): SessionBrief {
    return {
      id: this.id,
      title: this.title,
      project: this.project,
      project_id: this.projectId,
      status: this.status,
      files: this.files.length,
      mode: typeof this.state["mode"] === "string" ? (this.state["mode"] as string) : "work",
      created: this.created,
      error: this.error,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  进程内注册表
// ══════════════════════════════════════════════════════════════════

export const SESSIONS = new Map<string, Session>();

/**
 * 首次恢复要跨多个 await 读取 repo / 材料 / OIR；同一进程里若两个请求同时
 * 打开冷会话，不能各造一份 Session 后互相覆盖。锁按 sid 分片，避免恢复 A 会话时
 * 阻塞完全无关的 B 会话。
 */
export const HYDRATE_LOCKS = new Map<string, AsyncLock>();
/**
 * 进入 single-flight（含正在等锁）的协程数。不能只看 `lock.isLocked` 后删：
 * release 与 waiter 真正恢复之间有一个调度缝隙，第三个请求会在缝隙里另建一把锁。
 */
export const HYDRATE_USERS = new Map<string, number>();

/**
 * `_hydrate` 的 single-flight 外壳（server.py:1763 的 try/finally 那一段）。
 *
 * 恢复本身住在别的段；把这段引用计数留在这里，是因为它记录的是一次真实事故的
 * 修法 —— 只看锁是否空闲就删锁，会在 release 与 waiter 恢复之间的缝隙里让第三个
 * 请求另建一把锁，于是两个"single-flight"同时跑，同一个会话被恢复两次。
 */
export async function withHydrateLock<T>(sid: string, body: () => Promise<T>): Promise<T> {
  let lock = HYDRATE_LOCKS.get(sid);
  if (lock === undefined) {
    lock = new AsyncLock();
    HYDRATE_LOCKS.set(sid, lock);
  }
  const held = lock;
  HYDRATE_USERS.set(sid, (HYDRATE_USERS.get(sid) ?? 0) + 1);
  try {
    return await held.run(body);
  } finally {
    const users = (HYDRATE_USERS.get(sid) ?? 1) - 1;
    if (users) {
      HYDRATE_USERS.set(sid, users);
    } else {
      HYDRATE_USERS.delete(sid);
      if (HYDRATE_LOCKS.get(sid) === held) HYDRATE_LOCKS.delete(sid);
    }
  }
}

/** `_hydrate` 的注册点 —— 见文件头分叉 4。 */
export type Hydrator = (sid: string) => Promise<Session>;
let _hydrate: Hydrator | null = null;

export function registerHydrator(fn: Hydrator | null): void {
  _hydrate = fn;
}

/**
 * 取活着的会话。**不做恢复** —— 恢复要 await，这个函数是同步的。
 *
 * 需要恢复的路由用 {@link sessAsync}。
 */
export function sess(sid: string): Session {
  const s = SESSIONS.get(sid);
  if (s === undefined) {
    throw new HTTPException(404, { message: `没有会话 ${sid}（可能需要先打开它）` });
  }
  return s;
}

/** 取会话；首次恢复按 sid single-flight，所有等待者拿到同一个对象。 */
export async function sessAsync(sid: string): Promise<Session> {
  const cached = SESSIONS.get(sid);
  if (cached !== undefined) return cached;
  if (_hydrate === null) {
    // 显式失败。回落成 404 会把"接线漏了"伪装成"会话不存在"，而后者用户改不动。
    throw new Error("会话恢复未接线：先调 registerHydrator()");
  }
  return await _hydrate(sid);
}

/** 仓储句柄。`store/deps.ts` 的 `Repo` 还是占位类型，这里收口成协议类型。 */
export function currentRepo(): Repo {
  return getRepo() as Repo;
}

/**
 * `Repo` → `EventRepo` 的形状适配。
 *
 * hub 那边 `appendEvent` 的第四个参数是**裸的 eventId**（Python 的 keyword-only
 * 参数退化来的），仓储协议那边是 `{ eventId }` 选项对象。差一层壳而已，但**必须
 * 转**：直接把 Repo 塞进去会让 eventId 落到 opts 的位置上、被仓储当成 undefined，
 * 于是幂等键全丢 —— 一次重试就会重复插一条事件。
 *
 * 用 WeakMap 缓存：每次 emit 新建一个对象没有正确性问题，但 emit 是热路径。
 */
const EVENT_REPO_ADAPTERS = new WeakMap<object, EventRepo>();

export function asEventRepo(r: Repo): EventRepo {
  const cached = EVENT_REPO_ADAPTERS.get(r);
  if (cached !== undefined) return cached;
  const adapter: EventRepo = {
    getSession: (sid) => r.getSession(sid),
    appendEvent: (sid, kind, payload, eventId) =>
      r.appendEvent(sid, kind, payload, { eventId }),
  };
  EVENT_REPO_ADAPTERS.set(r, adapter);
  return adapter;
}

// ══════════════════════════════════════════════════════════════════
//  材料投影与 Run id
// ══════════════════════════════════════════════════════════════════

/**
 * 用仓储权威覆盖这个 worker 的材料清单。
 *
 * `Session.files` 是**有意**做成进程内投影的。变更/构建租约把写者串起来了，但它
 * 不会魔法般刷新另一个在上传发生**之前**就缓存了会话的 worker。所以每一次拿到
 * 租约的结构性操作，都要先重新装一遍这张小表，再去判断"有没有材料 / 该解析哪些"。
 */
export async function refreshFilesProjection(s: Session): Promise<void> {
  const rows = await currentRepo().listFiles(s.id);
  s.files = rows.map((row) => ({
    name: row.name,
    size: row.size,
    path: join(_root, row.rel_path),
    sha256: row.sha256,
  }));
}

/** Python 的字符串比较是按**码点**；JS 的 `<` 是按 UTF-16 码元。星光面字符上不同。 */
function cmpCodepoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return x.length - y.length;
}

/**
 * 这次梳理的 Run id：会话 + **语料指纹**。
 *
 * 以前固定用 `run_<sid>`，且 Recorder 不开 resume —— 于是进程一崩，上一轮已经
 * 付费跑完的模型调用全部作废，重跑从头再花一遍钱。
 *
 * 指纹进 id 是为了让 resume **安全**：同一批材料重跑 → 同一个 id → 命中日志里
 * 已完成的 effect，直接读回不重花钱；材料一变（加了/删了文件）→ 新 id → 干净的
 * 新日志，不会拿旧提示的结果去冒充新语料的答案（那正是 DeterminismViolation
 * 要防的）。
 */
export function runIdFor(s: Session): string {
  // 文件名 + 大小不是内容指纹：两个同名、同字节数但内容不同的 CSV 会误命中
  // 上一轮模型 effect。上传时会写 sha256；旧会话没有时在这里补算一次，保证迁移
  // 前创建的项目也不会复用错误结果。
  const sig: Array<readonly [string, string]> = [];
  for (const f of s.files) {
    let digest = String(f.sha256 ?? "");
    if (!digest) {
      try {
        digest = sha256Hex(readFileSync(f.path));
      } catch {
        // Python 捕的是 OSError（文件没了、权限不对）。回落成一个**稳定但明显不同**
        // 的标记：它必须随文件名和大小变化，否则两个都缺失的文件会撞成同一个指纹。
        digest = `missing:${f.name}:${Math.trunc(Number(f.size) || 0)}`;
      }
      f.sha256 = digest;
    }
    sig.push([f.name, digest]);
  }
  sig.sort((a, b) => cmpCodepoints(a[0], b[0]) || cmpCodepoints(a[1], b[1]));
  return `run_${s.id}_${fingerprint(sig).slice(0, 8)}`;
}

/**
 * chat 侧一次操作的**可重放 effect 命名空间**。
 *
 * 仓储 Run 回答的是"当前跑的是哪一次调用"，两次一模一样的请求也必须给两个 id；
 * Recorder 回答的是"哪些 effect 可以安全重放"，需要的正好是相反的性质：同一会话
 * 里语义输入相同就映射到同一份日志。两个 id 分开，才不会既冒出一堆孤儿
 * `chat_<uuid>` 日志、又丢掉 resume 命中。
 */
export function chatRecorderRunId(
  s: Session,
  o: { kind: string; semanticInput: unknown },
): string {
  return `chat_${s.id}_${o.kind}_${fingerprint(o.semanticInput).slice(0, 16)}`;
}

/** lifespan 里的 `ROOT.mkdir(parents=True, exist_ok=True)`。 */
export function ensureRootDir(): void {
  mkdirSync(resolve(_root), { recursive: true });
}
