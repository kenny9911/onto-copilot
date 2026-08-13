/**
 * 内存实现 —— 移植自 `store/repo.py` 的 `class MemoryRepo`（532–1403 行）。
 *
 * **这是没配 DATABASE_URL 时真正跑的那条路**，不是"测试替身"：绝大多数开发与演示
 * 部署走的就是它。它错了，产品在默认配置下就是错的。
 *
 * 行为刻意和 Postgres 版**一模一样**（同样的 state_version 递增、同样的 answered
 * 去重、同样的 seq 发号），这样同一套用例可以原样跑两遍。不一样的只有一点：
 * 进程退出即消失 —— 这正是它的定位。
 *
 * ── 与 Python 原件的三处形状差异（都在 track 报告里登记过）────────────────
 *
 * 1. **不持有 `asyncio.Lock`。** Python 侧每个临界区都套 `self._session_locks[sid]`，
 *    因为 CPython 的 await 点会让出协程调度权。这里逐条核对过：MemoryRepo 的每一个
 *    临界区**内部一个 await 都没有**，而 JS 的 async 函数体在遇到第一个 await 之前
 *    是同步执行的 —— 所以"发号 + 追加"本来就落在同一个不可分割的同步片段里，
 *    锁没有任何东西可以保护。**这条是"没有 await"换来的**：以后谁在临界区里加了
 *    await（比如把 `now()` 换成异步时间源），就必须把锁补回来。
 * 2. **DTO 是 readonly interface，不是可变 dataclass。** Python 的
 *    `row.created = row.created or time.time()` 直接改调用方交进来的对象、再把同一个
 *    对象存下来，于是调用方手里的引用会跟着后续的 rename/setStatus 一起变。这里改成
 *    **写时复制**：容器里换成新对象，之前返回出去的引用保持旧值。这与 PgRepo 一致
 *    （那边读出来的本来就是一次性快照），所以是**减少**两个实现之间的分叉。
 * 3. **`atomic` 是回调式**，见 protocol.ts —— JS 没有异步上下文管理器。
 */

import { pyRepr } from "../../kernel/errors.js";
import {
  IdempotencyConflict,
  KeyError,
  RevisionConflict,
  ValueError,
} from "../../onto/questions.js";
import { DERIVED_KEYS } from "../const.js";
import {
  DuplicateUsername,
  decisionIsActive,
  makeEventRow,
  validateUsageRow,
  type AuthSessionRow,
  type DecisionRecordRow,
  type DecisionRow,
  type EventRow,
  type FileRow,
  type JsonObject,
  type JsonValue,
  type ProjectMemoryRow,
  type ProjectRow,
  type QuestionRow,
  type RevisionRow,
  type SessionRow,
  type SettingRow,
  type UsageRow,
  type UserRow,
} from "../types.js";
import type {
  AppendEventOpts,
  AtomicScope,
  ClaimBuildLeaseOpts,
  ClaimMutationLeaseOpts,
  ClaimSessionStatusOpts,
  DeleteProjectMemoryOpts,
  ExpectedVersionOpts,
  FinalizeDecisionOpts,
  FinalizeRevisionOpts,
  FinishRunOpts,
  LeaseOwnerOpts,
  LeaseRenewOpts,
  ListDecisionsOpts,
  ListProjectsOpts,
  ListQuestionsOpts,
  ListSessionsOpts,
  LoadStateOpts,
  NowOpts,
  ReadEventsOpts,
  ReapBuildLeaseOpts,
  Repo,
  SaveBuildStateOpts,
  SaveChatStateOpts,
  SaveMutationStateOpts,
  SaveStateOpts,
  SetBuildStatusOpts,
  SetStatusOpts,
  UpdateUserOpts,
  UsageSinceOpts,
} from "./protocol.js";

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/** `time.time()` —— epoch **秒**（浮点）。
 *
 * 做成可替换的对象是为了让测试能钉住"created 为 0 时才回落到当前时间"这类分支，
 * 而不是靠 `expect(x).toBeGreaterThan(0)` 这种约等于没断言的写法。 */
export const repoTimeSource: { now(): number } = { now: () => Date.now() / 1000 };

function now(): number {
  return repoTimeSource.now();
}

/** Python `sorted()` 的字符串基准是 **Unicode 码位**；JS 的 `<` 是 UTF-16 码元。
 * 两者只在"BMP 私用区/CJK兼容区(U+E000–U+FFFF)"对上"增补平面字符(U+10000+)"时
 * 分叉 —— 后者的代理对首字节是 D800–DFFF，按码元比会排到前面去。会话/问题的 id
 * 里出现 emoji 并不稀奇，所以这里一律走码位。 */
export function cmpCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i]!.codePointAt(0)!;
    const y = cb[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length === cb.length ? 0 : ca.length < cb.length ? -1 : 1;
}

/** 数字比较器。**不要**写成 `a - b`：Infinity - Infinity 是 NaN，
 * 而 `Array.sort` 拿到 NaN 的行为是未定义的（实测会静默乱序）。 */
function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Python `dict == dict` / `list == list` 的深比较：对象比键集合（与顺序无关），
 * 数组比顺序。`record_revision` 的幂等冲突判据就是它，浅比较会把"同一份 doc 重放"
 * 误判成"同一个幂等键被用于另一个 revision"。 */
export function deepEqualJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualJson(x, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqualJson(a[k], b[k]));
}

/** `dict.setdefault(k, factory())`。 */
function setdefault<K, V>(m: Map<K, V>, k: K, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    v = make();
    m.set(k, v);
  }
  return v;
}

/** `{k: v for k, v in c.items() if not k.startswith("_")}` —— 把 `_asked` / `_ask_rank`
 * / `_version` 这些内部标记摘掉再交出去。 */
function strip(c: JsonObject): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

/** `opts` 里「缺席 / undefined / null」三者等价（protocol.ts 规则 3）。 */
function absent<T>(v: T | null | undefined): v is null | undefined {
  return v === null || v === undefined;
}

/** build 流水线"仍在跑"的三个状态。Python 侧五处判断逐字用的同一个集合。 */
const LIVE_BUILD_STATUSES: ReadonlySet<string> = new Set(["queued", "parsing", "extracting"]);

/** `_active_decision_v1`（repo.py:3122）。 */
function activeDecisionV1(
  rows: readonly DecisionRecordRow[],
  questionId: string,
): DecisionRecordRow | null {
  // failed 是副作用没有生效的审计记录，既不能成为 active
  // Decision，也不能靠 supersedes 把上一个成功决定从链上拿掉。
  const live = rows.filter((r) => r.metadata["status"] !== "failed");
  const superseded = new Set(live.map((r) => r.supersedes).filter((s): s is string => !!s));
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i]!;
    if (r.question_id === questionId && !superseded.has(r.id)) return r;
  }
  return null;
}

/** `{**c, "_asked": ..., "_ask_rank": ..., "_version": ...}` —— 一整代冲突的重建。
 *
 * `asked_rids` 的**下标就是 `_ask_rank`**，所以顺序有意义；不在里面的排名是 `null`
 * 而不是"排在最后"，这两者在前端是不同的展示分支。 */
function rebuildConflicts(
  conflicts: readonly JsonObject[],
  askedRids: readonly string[],
  version: number,
): Map<string, JsonObject> {
  const ranks = new Map<string, number>();
  askedRids.forEach((r, i) => {
    // Python 的 dict 推导：后出现的同名键覆盖值、但保持首次出现的位置。
    ranks.set(r, i);
  });
  const out = new Map<string, JsonObject>();
  for (const c of conflicts) {
    const raw = c["rid"];
    if (raw === undefined) throw new KeyError("rid"); // Python: c["rid"] 缺键即 KeyError
    const rid = String(raw);
    const merged: Record<string, JsonValue> = { ...c };
    merged["_asked"] = ranks.has(rid);
    merged["_ask_rank"] = ranks.get(rid) ?? null;
    merged["_version"] = version;
    out.set(rid, merged);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  内部容器
// ══════════════════════════════════════════════════════════════════

/** build / chat 租约。**不落库、不序列化**，所以用 camelCase。 */
interface Lease {
  owner: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  cancelRequestedAt: number | null;
}

/** mutation 租约比上面两个多一个 kind、少一个取消标记（Python 侧就是这样）。 */
interface MutationLease {
  owner: string;
  kind: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

interface RunRec {
  sessionId: string;
  ordinal: number;
  kind: string;
  status: string;
  error?: string;
  budget?: JsonObject;
}

// ══════════════════════════════════════════════════════════════════
//  MemoryRepo
// ══════════════════════════════════════════════════════════════════

export class MemoryRepo implements Repo {
  readonly mode = "memory";

  // 每一个容器都用 Map 而不是普通对象：JS 的普通对象会把"看起来像整数"的键
  // （"0" / "12"）排到所有字符串键前面，而 Python 的 dict 一律保插入序。
  // 会话 id / 文件名 / 设置键都可能长成那样，一旦发生就是 list_* 顺序静默漂移。
  private readonly sessions = new Map<string, SessionRow>();
  private readonly files = new Map<string, Map<string, FileRow>>();
  private readonly state = new Map<string, Map<string, JsonValue>>();
  private readonly conflicts = new Map<string, Map<string, JsonObject>>();
  private readonly decisions = new Map<string, DecisionRow[]>();
  private readonly questionsV1 = new Map<string, Map<string, QuestionRow>>();
  private readonly decisionsV1 = new Map<string, DecisionRecordRow[]>();
  private readonly revisions = new Map<string, RevisionRow[]>();
  private readonly eventsBag = new Map<string, EventRow[]>();
  private readonly runs = new Map<string, RunRec>();

  // 账号、登录会话、全局设置。**顶层**，与建模会话无关 —— 故意不进
  // deleteSession 的清理列表（那是按建模会话清的，扫到这里会误删账号/设置）。
  private readonly users = new Map<string, UserRow>();
  private readonly auth = new Map<string, AuthSessionRow>();
  private readonly settings = new Map<string, JsonValue>();

  // 项目文件夹与项目记忆。也是**顶层**的 —— 项目记忆的全部意义就是比单个会话
  // 活得久，所以同样不进 deleteSession 的清理列表（它按会话 id 逐个 pop，
  // 而这两个容器是按 project id 存的，扫进去只会误删同名的项目）。
  private readonly projects = new Map<string, ProjectRow>();
  private readonly projectMemory = new Map<string, Map<string, ProjectMemoryRow>>();

  // 模型用量流水。同样是顶层的 —— 会话删了，账还得在。
  private readonly usage: UsageRow[] = [];

  private readonly buildLeases = new Map<string, Lease>();
  private readonly chatLeases = new Map<string, Lease>();
  private readonly mutationLeases = new Map<string, MutationLease>();

  // ── 会话 ───────────────────────────────────────────────────────

  async createSession(row: SessionRow): Promise<SessionRow> {
    if (this.sessions.has(row.id)) throw new KeyError(`会话已存在: ${row.id}`);
    const out: SessionRow = { ...row, created: row.created || now() };
    this.sessions.set(out.id, out);
    setdefault(this.files, out.id, () => new Map());
    setdefault(this.state, out.id, () => new Map());
    setdefault(this.conflicts, out.id, () => new Map());
    setdefault(this.decisions, out.id, () => []);
    setdefault(this.questionsV1, out.id, () => new Map());
    setdefault(this.decisionsV1, out.id, () => []);
    setdefault(this.revisions, out.id, () => []);
    setdefault(this.eventsBag, out.id, () => []);
    return out;
  }

  async getSession(sid: string): Promise<SessionRow | null> {
    return this.sessions.get(sid) ?? null;
  }

  async listSessions(opts?: ListSessionsOpts): Promise<SessionRow[]> {
    const limit = opts?.limit ?? 100;
    const owner = opts?.owner;
    let rows = [...this.sessions.values()];
    // owner 给了就只看归属它的；无归属（""）天然被排除 —— 传 "" 反过来就是
    // "只看无归属的那批"，与 null（不过滤）不是一回事。
    if (!absent(owner)) rows = rows.filter((s) => s.owner === owner);
    rows.sort((a, b) => cmpNum(-a.created, -b.created));
    return rows.slice(0, limit);
  }

  async renameSession(sid: string, title: string): Promise<boolean> {
    const s = this.sessions.get(sid);
    if (s === undefined) return false;
    this.sessions.set(sid, { ...s, title });
    return true;
  }

  async reassignSessions(frm: string, to: string): Promise<number> {
    let n = 0;
    for (const [sid, s] of [...this.sessions]) {
      if ((s.owner || "") === frm) {
        this.sessions.set(sid, { ...s, owner: to });
        n += 1;
      }
    }
    return n;
  }

  async reassignProjects(frm: string, to: string): Promise<number> {
    let n = 0;
    for (const [pid, p] of [...this.projects]) {
      if ((p.owner || "") === frm) {
        this.projects.set(pid, { ...p, owner: to });
        n += 1;
      }
    }
    return n;
  }

  async setStatus(sid: string, status: string, opts?: SetStatusOpts): Promise<void> {
    const s = this.sessions.get(sid);
    if (s === undefined) throw new KeyError(sid); // Python: self._sessions[sid]
    this.sessions.set(sid, { ...s, status, error: opts?.error ?? "" });
  }

  /** 状态仍在允许集合时才更新；同一会话的并发调用只有一个能成功。 */
  async claimSessionStatus(sid: string, opts: ClaimSessionStatusOpts): Promise<boolean> {
    const row = this.sessions.get(sid);
    if (row === undefined || !new Set(opts.fromStatuses).has(row.status)) return false;
    this.sessions.set(sid, { ...row, status: opts.toStatus, error: opts.error ?? "" });
    return true;
  }

  /** 一次原子动作里同时拿下会话状态与那条"与进程无关"的 build 租约。 */
  async claimBuildLease(sid: string, opts: ClaimBuildLeaseOpts): Promise<boolean> {
    const { owner, now: ts, ttl, fromStatuses } = opts;
    if (!owner || ttl <= 0) throw new ValueError("build lease owner 不能为空且 ttl 必须大于 0");
    const row = this.sessions.get(sid);
    if (row === undefined || !new Set(fromStatuses).has(row.status)) return false;
    const mutation = this.mutationLeases.get(sid);
    if (mutation !== undefined && mutation.expiresAt > ts) return false;
    this.sessions.set(sid, {
      ...row,
      status: opts.toStatus ?? "queued",
      error: opts.error ?? "",
    });
    this.buildLeases.set(sid, {
      owner,
      acquiredAt: ts,
      heartbeatAt: ts,
      expiresAt: ts + ttl,
      cancelRequestedAt: null,
    });
    return true;
  }

  async renewBuildLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now: ts, ttl } = opts;
    if (ttl <= 0) throw new ValueError("build lease ttl 必须大于 0");
    const row = this.sessions.get(sid);
    const lease = this.buildLeases.get(sid);
    if (
      row === undefined ||
      !LIVE_BUILD_STATUSES.has(row.status) ||
      lease === undefined ||
      lease.owner !== owner ||
      lease.cancelRequestedAt !== null
    ) {
      return false;
    }
    lease.heartbeatAt = ts;
    lease.expiresAt = ts + ttl;
    return true;
  }

  /** 用调用者身份、过期时间与取消意图三重围栏挡住一次流水线状态写入。 */
  async setBuildStatus(sid: string, opts: SetBuildStatusOpts): Promise<boolean> {
    const { owner, now: ts, status } = opts;
    const row = this.sessions.get(sid);
    const lease = this.buildLeases.get(sid);
    if (
      row === undefined ||
      !LIVE_BUILD_STATUSES.has(row.status) ||
      lease === undefined ||
      lease.owner !== owner ||
      lease.cancelRequestedAt !== null ||
      lease.expiresAt <= ts
    ) {
      return false;
    }
    this.sessions.set(sid, { ...row, status, error: opts.error ?? "" });
    return true;
  }

  async releaseBuildLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const lease = this.buildLeases.get(sid);
    if (lease === undefined || lease.owner !== opts.owner) return false;
    this.buildLeases.delete(sid);
    return true;
  }

  /** 落一个"协作式取消"的意图，同时把对外可见的状态停掉。 */
  async requestBuildCancel(sid: string, opts: NowOpts): Promise<boolean> {
    const row = this.sessions.get(sid);
    if (row === undefined || !LIVE_BUILD_STATUSES.has(row.status)) return false;
    this.sessions.set(sid, { ...row, status: "stopped", error: "" });
    const lease = this.buildLeases.get(sid);
    if (lease !== undefined) lease.cancelRequestedAt = opts.now;
    return true;
  }

  async reapExpiredBuildLease(sid: string, opts: ReapBuildLeaseOpts): Promise<boolean> {
    const row = this.sessions.get(sid);
    const lease = this.buildLeases.get(sid);
    // 注意 lease 为空也算"该回收"：租约没了但状态还卡在 queued/parsing/extracting，
    // 正是进程猝死留下的那种孤儿，必须能被判失败。
    if (
      row === undefined ||
      !LIVE_BUILD_STATUSES.has(row.status) ||
      (lease !== undefined && lease.expiresAt > opts.now)
    ) {
      return false;
    }
    this.sessions.set(sid, { ...row, status: "failed", error: opts.error });
    this.buildLeases.delete(sid);
    return true;
  }

  async claimChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now: ts, ttl } = opts;
    if (!owner || ttl <= 0) throw new ValueError("chat lease owner 不能为空且 ttl 必须大于 0");
    if (!this.sessions.has(sid)) return false;
    const mutation = this.mutationLeases.get(sid);
    if (mutation !== undefined && mutation.expiresAt > ts) return false;
    const lease = this.chatLeases.get(sid);
    if (lease !== undefined && lease.expiresAt > ts) return false;
    this.chatLeases.set(sid, {
      owner,
      acquiredAt: ts,
      heartbeatAt: ts,
      expiresAt: ts + ttl,
      cancelRequestedAt: null,
    });
    return true;
  }

  async renewChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now: ts, ttl } = opts;
    if (ttl <= 0) throw new ValueError("chat lease ttl 必须大于 0");
    const lease = this.chatLeases.get(sid);
    if (
      lease === undefined ||
      lease.owner !== owner ||
      lease.cancelRequestedAt !== null ||
      lease.expiresAt <= ts
    ) {
      return false;
    }
    lease.heartbeatAt = ts;
    lease.expiresAt = ts + ttl;
    return true;
  }

  async releaseChatLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const lease = this.chatLeases.get(sid);
    if (lease === undefined || lease.owner !== opts.owner) return false;
    this.chatLeases.delete(sid);
    return true;
  }

  async requestChatCancel(sid: string, opts: NowOpts): Promise<boolean> {
    const lease = this.chatLeases.get(sid);
    if (
      lease === undefined ||
      lease.expiresAt <= opts.now ||
      lease.cancelRequestedAt !== null
    ) {
      return false;
    }
    lease.cancelRequestedAt = opts.now;
    return true;
  }

  async claimMutationLease(sid: string, opts: ClaimMutationLeaseOpts): Promise<boolean> {
    const { owner, kind, now: ts, ttl } = opts;
    if (!owner || !kind || ttl <= 0) {
      throw new ValueError("mutation lease owner/kind 不能为空且 ttl 必须大于 0");
    }
    const row = this.sessions.get(sid);
    if (row === undefined || LIVE_BUILD_STATUSES.has(row.status)) return false;
    const build = this.buildLeases.get(sid);
    if (build !== undefined && build.expiresAt > ts) return false;
    const chat = this.chatLeases.get(sid);
    // 同一个 owner 的 chat 租约不挡自己 —— 改写本来就是从对话里发起的。
    if (chat !== undefined && chat.owner !== owner && chat.expiresAt > ts) return false;
    const current = this.mutationLeases.get(sid);
    if (current !== undefined && current.expiresAt > ts) return false;
    this.mutationLeases.set(sid, {
      owner,
      kind,
      acquiredAt: ts,
      heartbeatAt: ts,
      expiresAt: ts + ttl,
    });
    return true;
  }

  async renewMutationLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now: ts, ttl } = opts;
    if (ttl <= 0) throw new ValueError("mutation lease ttl 必须大于 0");
    const lease = this.mutationLeases.get(sid);
    if (lease === undefined || lease.owner !== owner || lease.expiresAt <= ts) return false;
    lease.heartbeatAt = ts;
    lease.expiresAt = ts + ttl;
    return true;
  }

  async releaseMutationLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const lease = this.mutationLeases.get(sid);
    if (lease === undefined || lease.owner !== opts.owner) return false;
    this.mutationLeases.delete(sid);
    return true;
  }

  /** 删掉一个会话的**全部**痕迹。返回它本来在不在。
   *
   * 删干净很重要：留下孤儿状态或孤儿事件的话，下次建一个同 id 的会话会莫名其妙地
   * 继承它们。id 是随机的所以概率低，但低概率的脏数据最难查。
   *
   * **清理列表里绝不能加 `projects` / `projectMemory` / `users` / `auth` /
   * `settings` / `usage`。** 那六个是按别的主键（project id / 用户 id / 设置键）存的
   * 顶层容器，而这个循环是拿 **session id** 去 pop —— 一旦 session id 撞上某个
   * project id，删会话会顺手抹掉一个项目连同它的全部记忆。 */
  async deleteSession(sid: string): Promise<boolean> {
    if (!this.sessions.has(sid)) return false;
    this.sessions.delete(sid);
    this.files.delete(sid);
    this.state.delete(sid);
    this.conflicts.delete(sid);
    this.decisions.delete(sid);
    this.questionsV1.delete(sid);
    this.decisionsV1.delete(sid);
    this.revisions.delete(sid);
    this.eventsBag.delete(sid);
    for (const [runId, run] of [...this.runs]) {
      if (run.sessionId === sid) this.runs.delete(runId);
    }
    this.buildLeases.delete(sid);
    this.chatLeases.delete(sid);
    this.mutationLeases.delete(sid);
    return true;
  }

  // ── 文件 ───────────────────────────────────────────────────────

  async addFiles(sid: string, files: readonly FileRow[]): Promise<FileRow[]> {
    const bag = setdefault(this.files, sid, () => new Map<string, FileRow>());
    for (const f of files) {
      bag.set(f.name, f); // 同名覆盖，和 PG 的 ON CONFLICT DO UPDATE 一致
    }
    return [...bag.values()];
  }

  async listFiles(sid: string): Promise<FileRow[]> {
    return [...(this.files.get(sid)?.values() ?? [])];
  }

  /** 撤掉一份材料。返回是否真的删到了 —— 删不存在的不是错误，但要如实回答。 */
  async removeFile(sid: string, name: string): Promise<boolean> {
    return this.files.get(sid)?.delete(name) ?? false;
  }

  // ── 状态与冲突 ─────────────────────────────────────────────────

  async saveState(sid: string, docs: JsonObject, opts?: SaveStateOpts): Promise<number | null> {
    const s = this.sessions.get(sid);
    if (s === undefined) throw new KeyError(sid); // Python: self._sessions[sid]
    const expected = opts?.expectedVersion;
    if (!absent(expected) && s.state_version !== expected) return null;
    const version = s.state_version + 1;
    this.sessions.set(sid, { ...s, state_version: version });
    this.mergeDocs(sid, docs);
    this.maybeRebuildConflicts(sid, opts, version);
    return version;
  }

  /** 只为**仍然活着的那次 build 调用**做检查点（状态 + state 一起）。 */
  async saveBuildState(
    sid: string,
    docs: JsonObject,
    opts: SaveBuildStateOpts,
  ): Promise<number | null> {
    const { owner, now: ts, status } = opts;
    const row = this.sessions.get(sid);
    const lease = this.buildLeases.get(sid);
    const expected = opts.expectedVersion;
    if (
      row === undefined ||
      !LIVE_BUILD_STATUSES.has(row.status) ||
      lease === undefined ||
      lease.owner !== owner ||
      lease.cancelRequestedAt !== null ||
      lease.expiresAt <= ts ||
      (!absent(expected) && row.state_version !== expected)
    ) {
      return null;
    }
    const version = row.state_version + 1;
    this.sessions.set(sid, { ...row, status, error: opts.error ?? "", state_version: version });
    this.mergeDocs(sid, docs);
    this.maybeRebuildConflicts(sid, opts, version);
    return version;
  }

  /** 只在这一次 chat 调用仍持有活租约时落库。 */
  async saveChatState(
    sid: string,
    docs: JsonObject,
    opts: SaveChatStateOpts,
  ): Promise<number | null> {
    const { owner, now: ts } = opts;
    const row = this.sessions.get(sid);
    const lease = this.chatLeases.get(sid);
    const expected = opts.expectedVersion;
    if (
      row === undefined ||
      lease === undefined ||
      lease.owner !== owner ||
      lease.cancelRequestedAt !== null ||
      lease.expiresAt <= ts ||
      (!absent(expected) && row.state_version !== expected)
    ) {
      return null;
    }
    // 注意 chat 这条路**不动 status** —— 对话不是流水线，改状态会把 build 的
    // 状态机搅乱。
    const version = row.state_version + 1;
    this.sessions.set(sid, { ...row, state_version: version });
    this.mergeDocs(sid, docs);
    this.maybeRebuildConflicts(sid, opts, version);
    return version;
  }

  async saveMutationState(
    sid: string,
    docs: JsonObject,
    opts: SaveMutationStateOpts,
  ): Promise<number | null> {
    const { owner, now: ts, status } = opts;
    const chatOwner = opts.chatOwner ?? "";
    const row = this.sessions.get(sid);
    const lease = this.mutationLeases.get(sid);
    const chat = chatOwner ? this.chatLeases.get(sid) : undefined;
    const expected = opts.expectedVersion;
    if (
      row === undefined ||
      lease === undefined ||
      lease.owner !== owner ||
      lease.expiresAt <= ts ||
      (!!chatOwner &&
        (chat === undefined ||
          chat.owner !== chatOwner ||
          chat.cancelRequestedAt !== null ||
          chat.expiresAt <= ts)) ||
      (!absent(expected) && row.state_version !== expected)
    ) {
      return null;
    }
    const version = row.state_version + 1;
    this.sessions.set(sid, { ...row, status, error: opts.error ?? "", state_version: version });
    this.mergeDocs(sid, docs);
    this.maybeRebuildConflicts(sid, opts, version);
    return version;
  }

  /** `self._state.setdefault(sid, {}).update(docs)` —— 是**合并**不是替换。 */
  private mergeDocs(sid: string, docs: JsonObject): void {
    const bag = setdefault(this.state, sid, () => new Map<string, JsonValue>());
    for (const [k, v] of Object.entries(docs)) bag.set(k, v);
  }

  /** `if conflicts is not None` —— `null`/缺席是"这次不动冲突表"，
   * 传 `[]` 才是"这一代没有冲突"。折叠掉这个区分会让只存 docs 的那几条路径
   * 顺手把整代冲突抹掉。 */
  private maybeRebuildConflicts(sid: string, opts: SaveStateOpts | undefined, version: number): void {
    const conflicts = opts?.conflicts;
    if (absent(conflicts)) return;
    this.conflicts.set(sid, rebuildConflicts(conflicts, opts?.askedRids ?? [], version));
  }

  /** 读回 state 文档。
   *
   * **一处 JS 平台差异，抹不平也不该假装抹平**：返回值的类型是普通对象，而 JS 的
   * 普通对象会把"看起来像整数"的键（`"2"` / `"10"`）排到所有字符串键前面。存储侧
   * 用 Map 保住了插入序，但一交给 `JsonObject` 就会被重排。Python 的 dict 不会。
   * 这不影响任何按键取值的调用方，只影响把整份 state 直接 JSON 序列化后的键序 ——
   * 而 PgRepo 在 TS 上有同样的行为，所以两个实现之间仍然一致。 */
  async loadState(sid: string, opts?: LoadStateOpts): Promise<JsonObject> {
    const keys = opts?.keys;
    const includeDerived = opts?.includeDerived ?? true;
    const want = absent(keys) ? null : new Set(keys);
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of this.state.get(sid) ?? []) {
      if (want !== null && !want.has(k)) continue;
      if (!includeDerived && DERIVED_KEYS.has(k)) continue;
      out[k] = v;
    }
    return out;
  }

  async listConflicts(sid: string): Promise<JsonObject[]> {
    return [...(this.conflicts.get(sid)?.values() ?? [])].map(strip);
  }

  async getConflict(sid: string, rid: string): Promise<JsonObject | null> {
    const c = this.conflicts.get(sid)?.get(rid);
    // Python 写的是 `_strip(c) if c else None` —— 空 dict 也走 None 这一支。
    if (c === undefined || Object.keys(c).length === 0) return null;
    return strip(c);
  }

  // ── 人的决定（legacy decision，按 ordinal）──────────────────────

  async recordDecision(sid: string, d: DecisionRow): Promise<DecisionRow> {
    const bag = setdefault(this.decisions, sid, () => []);
    // 发号用**计数器**（这里就是"已写入条数"），不是 max(ordinal)+1。
    // PG 那边同理走 session.next_decision_ordinal 的行锁自增，因为
    // `SELECT max(...) FOR UPDATE` 在 Postgres 上直接报
    // "FOR UPDATE is not allowed with aggregate functions"，而不加锁的 MAX+1
    // 在并发下会重号、撞 decision 的主键。两边必须是同一套手法。
    const ordinal = bag.length;
    const row: DecisionRow = { ...d, ordinal, ts: d.ts || now() };
    const scope = [...row.scope_refs].sort(cmpCodePoint);
    for (let i = 0; i < bag.length; i++) {
      const old = bag[i]!;
      if (!decisionIsActive(old)) continue;
      // 和 DialogueMemory.decide（dialogue.py:203-208）同一条规则：
      // 同类型 + 同作用域 = 后者推翻前者。ANSWER 额外按 target_rid 收敛，
      // 这就是 PG 那条部分唯一索引 decision_live_answer_uq 的等价物 ——
      // 也正是它让"同一个 rid 重复回答"天然幂等。
      const sameScope = eqStrList([...old.scope_refs].sort(cmpCodePoint), scope);
      if (
        old.kind === row.kind &&
        ((row.kind === "answer" && old.target_rid === row.target_rid) ||
          (row.kind !== "answer" && sameScope))
      ) {
        bag[i] = { ...old, superseded_by: ordinal };
      }
    }
    bag.push(row);
    return row;
  }

  async listDecisions(sid: string, opts?: ListDecisionsOpts): Promise<DecisionRow[]> {
    const bag = this.decisions.get(sid) ?? [];
    return opts?.activeOnly ? bag.filter(decisionIsActive) : [...bag];
  }

  async answeredRids(sid: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const d of this.decisions.get(sid) ?? []) {
      if (d.kind === "answer" && decisionIsActive(d) && d.target_rid) out.add(d.target_rid);
    }
    return out;
  }

  // ── 统一 Question / Decision / Revision ────────────────────────

  async upsertQuestions(sid: string, rows: readonly QuestionRow[]): Promise<QuestionRow[]> {
    const ts = now();
    const bag = setdefault(this.questionsV1, sid, () => new Map<string, QuestionRow>());
    for (const row of rows) {
      const old = bag.get(row.id);
      bag.set(row.id, {
        ...row,
        created: row.created || (old ? old.created : ts),
        updated: row.updated || ts,
      });
    }
    return [...bag.values()];
  }

  /** 保存一次人工问题变更；有 expectedVersion 时执行乐观锁 CAS。 */
  async saveQuestion(
    sid: string,
    row: QuestionRow,
    opts?: ExpectedVersionOpts,
  ): Promise<QuestionRow> {
    const expected = opts?.expectedVersion;
    const bag = setdefault(this.questionsV1, sid, () => new Map<string, QuestionRow>());
    const old = bag.get(row.id);
    if (!absent(expected) && (old === undefined || old.version !== expected)) {
      const actual = old === undefined ? "None" : String(old.version);
      throw new RevisionConflict(`问题 ${row.id} 预期 version ${expected}，实际是 ${actual}`);
    }
    const created = old !== undefined ? row.created || old.created : row.created;
    const updated = row.updated || now();
    let out: QuestionRow = { ...row, created, updated };
    if (!absent(expected)) {
      const version = expected + 1;
      // doc 是问题的完整领域契约，version/updatedAt 必须跟着列一起走，
      // 否则下一次 CAS 会拿 doc 里的旧 version 去比，永远对不上。
      out = { ...out, version, doc: { ...out.doc, version, updatedAt: updated } };
    }
    bag.set(out.id, out);
    return out;
  }

  async listQuestions(sid: string, opts?: ListQuestionsOpts): Promise<QuestionRow[]> {
    const statuses = opts?.statuses;
    let rows = [...(this.questionsV1.get(sid)?.values() ?? [])];
    if (!absent(statuses)) {
      const want = new Set(statuses);
      rows = rows.filter((r) => want.has(r.status));
    }
    rows.sort((a, b) => cmpNum(a.created, b.created) || cmpCodePoint(a.id, b.id));
    return rows;
  }

  async getQuestion(sid: string, qid: string): Promise<QuestionRow | null> {
    return this.questionsV1.get(sid)?.get(qid) ?? null;
  }

  async recordDecisionV1(
    sid: string,
    row: DecisionRecordRow,
  ): Promise<readonly [DecisionRecordRow, boolean]> {
    if (!row.idempotency_key) throw new ValueError("Decision 必须提供 idempotency_key");
    const bag = setdefault(this.decisionsV1, sid, () => []);
    const old = bag.find((x) => x.idempotency_key === row.idempotency_key);
    if (old !== undefined) {
      if (old.semantic_hash !== row.semantic_hash) {
        throw new IdempotencyConflict(`幂等键 ${pyRepr(row.idempotency_key)} 已用于另一份回答`);
      }
      return [old, false] as const;
    }
    // created 在 active 判定**之前**取，跟 Python 逐行一致：那边的
    // `row.created = row.created or time.time()` 就写在早退之前。看着无所谓，但它
    // 决定了时钟被消费几次 —— 假时钟下这一步错位，后面每一个自动时间戳全偏。
    const created = row.created || now();
    const active = activeDecisionV1(bag, row.question_id);
    // 同一个问题、同一份语义 = 重复提交，返回原来那条（这就是"重复回答天然幂等"）。
    if (active !== null && active.semantic_hash === row.semantic_hash) {
      return [active, false] as const;
    }
    const out: DecisionRecordRow = {
      ...row,
      created,
      supersedes: active !== null ? active.id : row.supersedes,
    };
    bag.push(out);
    return [out, true] as const;
  }

  /** 将预先 claim 的 Decision 终结为 applied/failed。
   *
   * 只允许单向 `claimed -> applied|failed`；重放相同终态是幂等的，
   * 但不允许把已成功的决定改成失败（或反过来）。 */
  async finalizeDecisionV1(
    sid: string,
    decisionId: string,
    opts: FinalizeDecisionOpts,
  ): Promise<DecisionRecordRow> {
    const { status } = opts;
    if (status !== "applied" && status !== "failed") {
      throw new ValueError(`不支持的 Decision 终态: ${status}`);
    }
    const bag = this.decisionsV1.get(sid) ?? [];
    const i = bag.findIndex((x) => x.id === decisionId);
    if (i < 0) throw new KeyError(`没有 Decision ${decisionId}`);
    const row = bag[i]!;
    // 没有 status 的旧记录按 applied 算 —— 它们是 claim 机制上线之前写的，
    // 那时候能落库就等于已生效。
    const raw = row.metadata["status"];
    const current = raw ? String(raw) : "applied";
    if ((current === "applied" || current === "failed") && current !== status) {
      throw new ValueError(`Decision ${decisionId} 已是 ${current}，不能改为 ${status}`);
    }
    const metadata: Record<string, JsonValue> = { ...row.metadata, status };
    if (opts.error) metadata["error"] = opts.error;
    else delete metadata["error"];
    const out: DecisionRecordRow = { ...row, metadata };
    bag[i] = out;
    return out;
  }

  async listDecisionsV1(sid: string): Promise<DecisionRecordRow[]> {
    return [...(this.decisionsV1.get(sid) ?? [])];
  }

  async recordRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]> {
    const bag = setdefault(this.revisions, sid, () => []);
    if (row.idempotency_key) {
      const old = bag.find((x) => x.idempotency_key === row.idempotency_key);
      if (old !== undefined) {
        if (!deepEqualJson(old.doc, row.doc)) {
          throw new IdempotencyConflict(
            `幂等键 ${pyRepr(row.idempotency_key)} 已用于另一个 revision`,
          );
        }
        return [old, false] as const;
      }
    }
    if (bag.some((x) => x.id === row.id || x.ordinal === row.ordinal)) {
      throw new ValueError(`Revision id/ordinal 已存在: ${row.id}/${row.ordinal}`);
    }
    const out: RevisionRow = { ...row, created: row.created || now() };
    bag.push(out);
    bag.sort((a, b) => cmpNum(a.ordinal, b.ordinal));
    return [out, true] as const;
  }

  /** 原子分配下一 ordinal 并写 Revision，**幂等键优先于发号**。 */
  async appendRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]> {
    const bag = setdefault(this.revisions, sid, () => []);
    if (row.idempotency_key) {
      const old = bag.find((x) => x.idempotency_key === row.idempotency_key);
      // 自动分配的 id/ordinal/parent 不属于请求语义，相同 key 就返回原行；
      // 上层 Decision claim 已防止异义重用。
      if (old !== undefined) return [old, false] as const;
    }
    const ordinal = (bag.length > 0 ? Math.max(...bag.map((x) => x.ordinal)) : 0) + 1;
    // `max(bag, key=...)` 在并列时返回**第一个**，所以这里必须严格大于才换人。
    let parent: string | null = null;
    if (bag.length > 0) {
      let best = bag[0]!;
      for (const x of bag) if (x.ordinal > best.ordinal) best = x;
      parent = best.id;
    }
    const id = `rev.${ordinal}`;
    const out: RevisionRow = {
      ...row,
      id,
      ordinal,
      parent_id: parent,
      doc: { ...row.doc, id, ordinal, parentId: parent },
      created: row.created || now(),
    };
    bag.push(out);
    bag.sort((a, b) => cmpNum(a.ordinal, b.ordinal));
    return [out, true] as const;
  }

  /** 把一次提议中的版本恰好终结一次。 */
  async finalizeRevision(
    sid: string,
    revisionId: string,
    opts: FinalizeRevisionOpts,
  ): Promise<RevisionRow> {
    const { status } = opts;
    if (status !== "applied" && status !== "rejected" && status !== "rolled_back") {
      throw new ValueError(`不支持的 Revision 终态: ${status}`);
    }
    const bag = this.revisions.get(sid) ?? [];
    const i = bag.findIndex((x) => x.id === revisionId);
    if (i < 0) throw new KeyError(`没有 Revision ${revisionId}`);
    const row = bag[i]!;
    // 重放同一个终态是幂等的；换一个终态就是并发写，必须炸。
    if (row.status !== "proposed" && row.status !== status) {
      throw new ValueError(`Revision ${revisionId} 已是 ${row.status}，不能改为 ${status}`);
    }
    const out: RevisionRow = { ...row, status, doc: { ...row.doc, status } };
    bag[i] = out;
    return out;
  }

  async listRevisions(sid: string): Promise<RevisionRow[]> {
    return [...(this.revisions.get(sid) ?? [])];
  }

  // ── 事件 ───────────────────────────────────────────────────────

  async appendEvent(
    sid: string,
    kind: string,
    payload: JsonObject,
    opts?: AppendEventOpts,
  ): Promise<EventRow> {
    // MemoryRepo 会被并发的请求任务与后台任务共用。发号与追加落在同一个同步片段里
    // （这中间一个 await 都没有），等价于 PgRepo 那把行锁。
    const eventId = opts?.eventId ?? "";
    const bag = setdefault(this.eventsBag, sid, () => []);
    if (eventId) {
      // session_event.event_id 上的唯一约束 = 重发同一条事件天然幂等，
      // 返回**原来那条**（seq 不变），而不是写一条 seq 更大的重复事件。
      const old = bag.find((e) => e.event_id === eventId);
      if (old !== undefined) return old;
    }
    const ev = makeEventRow({ seq: bag.length, kind, payload, ts: now(), event_id: eventId });
    bag.push(ev);
    return ev;
  }

  async readEvents(sid: string, opts?: ReadEventsOpts): Promise<EventRow[]> {
    // Array.slice 与 Python 的列表切片在负数起点上语义相同（都从尾部数），
    // 越界也同样给空数组 —— 这里可以直接对应，不需要额外夹紧。
    return (this.eventsBag.get(sid) ?? []).slice(opts?.since ?? 0);
  }

  async countEvents(sid: string): Promise<number> {
    return (this.eventsBag.get(sid) ?? []).length;
  }

  // ── Run ────────────────────────────────────────────────────────

  async nextRun(sid: string, kind: string): Promise<string> {
    let n = 0;
    for (const r of this.runs.values()) if (r.sessionId === sid) n += 1;
    const rid = `${sid}.${n}`;
    this.runs.set(rid, { sessionId: sid, ordinal: n, kind, status: "running" });
    return rid;
  }

  async finishRun(runId: string, opts: FinishRunOpts): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new KeyError(runId); // Python: self._runs[run_id] |= ...
    run.status = opts.status;
    run.error = opts.error ?? "";
    run.budget = absent(opts.budget) ? {} : opts.budget;
  }

  // ── 账号 ───────────────────────────────────────────────────────

  async createUser(row: UserRow): Promise<UserRow> {
    if (this.users.has(row.id)) throw new DuplicateUsername(`用户 id 已存在: ${row.id}`);
    for (const u of this.users.values()) {
      if (u.username === row.username) {
        throw new DuplicateUsername(`用户名已存在: ${row.username}`);
      }
    }
    const out: UserRow = { ...row, created: row.created || now() };
    this.users.set(out.id, out);
    return out;
  }

  async getUser(uid: string): Promise<UserRow | null> {
    return this.users.get(uid) ?? null;
  }

  async getUserByUsername(username: string): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.username === username) return u;
    return null;
  }

  async listUsers(): Promise<UserRow[]> {
    return [...this.users.values()].sort((a, b) => cmpNum(a.created, b.created));
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async updateUser(uid: string, opts?: UpdateUserOpts): Promise<UserRow | null> {
    const u = this.users.get(uid);
    if (u === undefined) return null;
    // 逐个 `if x is not None` —— 缺席的字段一列都不动。折叠成一次整体覆盖的话，
    // 一次改密码会顺手把 role 和 prefs 清掉。
    const role = opts?.role;
    const active = opts?.active;
    const passwordHash = opts?.passwordHash;
    const prefs = opts?.prefs;
    const displayName = opts?.displayName;
    const out: UserRow = {
      ...u,
      ...(absent(role) ? {} : { role }),
      ...(absent(active) ? {} : { active }),
      ...(absent(passwordHash) ? {} : { password_hash: passwordHash }),
      ...(absent(prefs) ? {} : { prefs: { ...prefs } }),
      ...(absent(displayName) ? {} : { display_name: displayName }),
    };
    this.users.set(uid, out);
    return out;
  }

  async deleteUser(uid: string): Promise<boolean> {
    if (!this.users.has(uid)) return false;
    // 手动级联登录会话 == ON DELETE CASCADE。**绝不**把 users/auth 加进
    // deleteSession 的清理列表 —— 那是按建模会话清的，会误删所有账号。
    for (const [th, a] of [...this.auth]) {
      if (a.user_id === uid) this.auth.delete(th);
    }
    this.users.delete(uid);
    return true;
  }

  // ── 模型用量流水 ───────────────────────────────────────────────

  async addUsage(row: UsageRow): Promise<void> {
    validateUsageRow(row);
    this.usage.push(row);
  }

  async usageSince(since: number, opts?: UsageSinceOpts): Promise<UsageRow[]> {
    const limit = opts?.limit ?? 5000;
    const owner = opts?.owner;
    if (limit <= 0) return [];
    const rows = this.usage.filter(
      (r) => r.ts >= since && (absent(owner) || (r.owner || "") === owner),
    );
    // 新的在前：截断时先丢最老的那批，而不是把最近发生的事情丢掉
    rows.sort((a, b) => cmpNum(-a.ts, -b.ts));
    return rows.slice(0, limit);
  }

  // ── 登录会话 ───────────────────────────────────────────────────

  async createAuthSession(row: AuthSessionRow): Promise<AuthSessionRow> {
    const created = row.created || now();
    const out: AuthSessionRow = { ...row, created, last_seen: row.last_seen || created };
    this.auth.set(out.token_hash, out);
    return out;
  }

  async getAuthSession(tokenHash: string): Promise<AuthSessionRow | null> {
    return this.auth.get(tokenHash) ?? null;
  }

  async deleteAuthSession(tokenHash: string): Promise<boolean> {
    return this.auth.delete(tokenHash);
  }

  async deleteUserAuthSessions(uid: string): Promise<number> {
    let n = 0;
    for (const [t, a] of [...this.auth]) {
      if (a.user_id === uid) {
        this.auth.delete(t);
        n += 1;
      }
    }
    return n;
  }

  async pruneAuthSessions(opts: NowOpts): Promise<number> {
    let n = 0;
    for (const [t, a] of [...this.auth]) {
      // `a.expires and ...` —— expires 为 0 表示"不过期"，不能被当成早已过期。
      if (a.expires && a.expires <= opts.now) {
        this.auth.delete(t);
        n += 1;
      }
    }
    return n;
  }

  // ── 项目文件夹与项目记忆 ───────────────────────────────────────

  async listProjects(opts?: ListProjectsOpts): Promise<ProjectRow[]> {
    const owner = opts?.owner;
    let rows = [...this.projects.values()];
    if (!absent(owner)) rows = rows.filter((p) => p.owner === owner);
    // Array.sort 自 ES2019 起保证稳定：sort_order 相同时保持插入（= 创建）顺序，
    // 与 PG 那边「sort_order, created_at」的次序一致。
    rows.sort((a, b) => cmpNum(a.sort_order, b.sort_order));
    return rows;
  }

  async createProject(row: ProjectRow): Promise<ProjectRow> {
    if (this.projects.has(row.id)) throw new KeyError(`项目已存在: ${row.id}`);
    this.projects.set(row.id, row);
    setdefault(this.projectMemory, row.id, () => new Map());
    return row;
  }

  async getProject(pid: string): Promise<ProjectRow | null> {
    return this.projects.get(pid) ?? null;
  }

  async renameProject(pid: string, name: string): Promise<boolean> {
    const p = this.projects.get(pid);
    if (p === undefined) return false;
    this.projects.set(pid, { ...p, name });
    return true;
  }

  /** 删项目：成员会话掉回未归类，项目记忆一起删掉。返回释放了几个会话。
   *
   * 顺序是刻意的 —— 先松开会话，再删记忆，最后删项目本身。反过来的话，中途出错会
   * 留下指向已不存在项目的会话（内存模式没有事务，见 `atomic`）。 */
  async deleteProject(pid: string): Promise<number> {
    let released = 0;
    for (const [sid, s] of [...this.sessions]) {
      if (s.project_id === pid) {
        this.sessions.set(sid, { ...s, project_id: "" });
        released += 1;
      }
    }
    this.projectMemory.delete(pid);
    this.projects.delete(pid);
    return released;
  }

  async assignSession(sid: string, projectId: string | null): Promise<boolean> {
    const s = this.sessions.get(sid);
    if (s === undefined) return false;
    this.sessions.set(sid, { ...s, project_id: projectId || "" }); // null/"" 都是「移出项目」
    return true;
  }

  async listProjectMemory(pid: string): Promise<ProjectMemoryRow[]> {
    return [...(this.projectMemory.get(pid)?.values() ?? [])].sort((a, b) =>
      cmpCodePoint(a.key, b.key),
    );
  }

  async upsertProjectMemory(rows: readonly ProjectMemoryRow[]): Promise<number> {
    for (const row of rows) {
      setdefault(this.projectMemory, row.project_id, () => new Map<string, ProjectMemoryRow>()).set(
        row.key,
        row,
      );
    }
    return rows.length;
  }

  async deleteProjectMemory(pid: string, opts?: DeleteProjectMemoryOpts): Promise<number> {
    const bag = this.projectMemory.get(pid);
    if (bag === undefined || bag.size === 0) return 0;
    const keys = opts?.keys;
    if (absent(keys)) {
      // null = 整个项目的记忆全清
      const n = bag.size;
      bag.clear();
      return n;
    }
    let n = 0;
    for (const k of keys) if (bag.delete(k)) n += 1;
    return n;
  }

  // ── 全局应用设置 ───────────────────────────────────────────────

  async getSetting(key: string): Promise<JsonValue | null> {
    // 键不存在与"值就是 null"在这一层不可区分 —— Python 侧 `dict.get` 也是这样，
    // 调用方要区分就得走 listSettings。
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: JsonValue): Promise<void> {
    this.settings.set(key, value);
  }

  async listSettings(): Promise<SettingRow[]> {
    return [...this.settings].map(([key, value]) => ({ key, value, updated: 0 }));
  }

  async deleteSetting(key: string): Promise<boolean> {
    return this.settings.delete(key);
  }

  // ── 跨方法事务 ─────────────────────────────────────────────────

  /** 内存里没有事务。**不假装有** —— 半途异常会留下部分写入。
   *
   * 这正是内存模式的代价，而不是需要被抹平的差异：假装有事务会让人在内存模式下
   * 写出依赖回滚的代码，切到 Postgres 才发现语义对不上。 */
  async atomic<T>(fn: (scope: AtomicScope) => Promise<T>): Promise<T> {
    return await fn(this);
  }
}

/** 两个已排序字符串列表的相等判定（`sorted(a) == sorted(b)`）。 */
function eqStrList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
