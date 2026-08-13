/**
 * 仓储层接口 —— 移植自 `store/repo.py` 的 `class Repo(Protocol)`（363–526 行）。
 *
 * **这里只有签名，没有实现。** `MemoryRepo` 与 `PgRepo` 两份实现都照这份写，
 * 所以签名一旦定错就是两份实现一起返工 —— 改这个文件之前先想清楚。
 *
 * ── 形状：接口 + 两个实现，不是模块级函数 ─────────────────────────────
 *
 * 模块级函数没法在没有数据库的时候被换掉，而"没有数据库时照常工作"是硬要求，
 * 所以可替换性必须在类型里，不能靠改模块导出。两个实现：
 *   * `PgRepo`     —— Drizzle，跑 Postgres（测试里也跑 SQLite）；
 *   * `MemoryRepo` —— 就是一堆 Map，包了一层同样的接口。
 *
 * ── 事务边界：一次业务动作一个事务，由仓储方法自己开 ──────────────────
 *
 * 路由不持有连接、不显式 begin/commit。理由是这个服务里真正需要跨方法原子性的
 * 只有一处 ——「改完 OIR 之后把 oir/conflicts/questions/suggestions 一起落库」，
 * 而它本来就该是**一个**方法（`saveState`），不是四个调用凑出来的事务。
 * 把边界画在方法上，就没有"忘了 commit"这种 bug 可写。
 * 真正需要跨方法原子的场合走 `atomic`。
 *
 * **一致性靠 state_version。** 每次 `saveState` 在同一事务里
 * `UPDATE session SET state_version = state_version + 1 ... RETURNING`（行锁），
 * 所有写入的行都带上这个新版本号。这样就不可能出现
 * "磁盘上的 oir 是新的、/state 拿到的 state.oir 是旧的"。
 *
 * ── Python → TS 的签名映射规则（两个实现必须照同一套写）──────────────
 *
 * 1. **无默认值的形参 → 位置参数**，顺序与 Python 一致；
 *    **有默认值的形参（不论是否 keyword-only）→ 统一进最后一个 `opts` 对象**。
 *    这样 `list_sessions(owner=x)`（跳过 limit）在 TS 侧写成 `listSessions({owner})`，
 *    不会出现 `listSessions(undefined, {owner})` 这种占位空洞。
 * 2. `opts` 的字段名用 **camelCase**（`askedRids` / `expectedVersion` / `fromStatuses`）。
 *    Row DTO 的字段保持 snake_case 是因为它们对着库列和线上 JSON，`opts` 不落地，
 *    所以跟内核其余部分一致用 camelCase。
 * 3. `opts` 里**缺席 / `undefined` / `null` 三者等价**，一律回落到 Python 的默认值。
 *    Python 默认值是 `None` 的字段类型写成 `T | null | undefined`，
 *    默认值是具体值（`""` / `0` / `false`）的写成 `T | undefined`。
 * 4. `opts` 整体可省（`opts?`）当且仅当**它的字段全都有默认值**；
 *    只要有一个是 keyword-only 且无默认（`claimBuildLease` 的 owner/now/ttl…），
 *    `opts` 就是必填的。
 * 5. 返回 `None` 表示"没有" → 返回 **`null`**（不是 `undefined`），与 types.ts 一致。
 * 6. `Sequence[T]` / `Iterable[T]` 入参 → `readonly T[]`；返回的 `list[T]` → `T[]`
 *    （Python 那边返回的是可变新列表，调用方会就地排序）。
 * 7. `dict[str, Any]` → `JsonObject`，`Any` → `JsonValue`。这些值全都要落到
 *    jsonb / TEXT 列里，不是任意对象。
 */

import type {
  AuthSessionRow,
  DecisionRecordRow,
  DecisionRow,
  EventRow,
  FileRow,
  JsonObject,
  JsonValue,
  ProjectMemoryRow,
  ProjectRow,
  QuestionRow,
  RevisionRow,
  SessionRow,
  SettingRow,
  UsageRow,
  UserRow,
} from "../types.js";

/** 用户名（或 id）已存在。两个实现都抛它，路由层统一映射成 409。
 * **不要重新定义** —— 定义在 `store/types.ts`，这里只是转出来方便实现侧一处 import。 */
export { DuplicateUsername } from "../types.js";

// ══════════════════════════════════════════════════════════════════
//  opts 形状
// ══════════════════════════════════════════════════════════════════

export interface ListSessionsOpts {
  /** Python 默认 100。 */
  readonly limit?: number | undefined;
  /** `null`/缺席 = 不过滤；`""` = 只看无归属的那批（**和 null 不是一回事**）。 */
  readonly owner?: string | null | undefined;
}

export interface SetStatusOpts {
  readonly error?: string | undefined;
}

export interface ClaimSessionStatusOpts {
  readonly fromStatuses: readonly string[];
  readonly toStatus: string;
  readonly error?: string | undefined;
}

export interface ClaimBuildLeaseOpts {
  readonly owner: string;
  readonly now: number;
  readonly ttl: number;
  readonly fromStatuses: readonly string[];
  /** Python 默认 "queued"。 */
  readonly toStatus?: string | undefined;
  readonly error?: string | undefined;
}

export interface LeaseRenewOpts {
  readonly owner: string;
  readonly now: number;
  readonly ttl: number;
}

export interface SetBuildStatusOpts {
  readonly owner: string;
  readonly now: number;
  readonly status: string;
  readonly error?: string | undefined;
}

export interface LeaseOwnerOpts {
  readonly owner: string;
}

export interface NowOpts {
  readonly now: number;
}

export interface ReapBuildLeaseOpts {
  readonly now: number;
  readonly error: string;
}

export interface ClaimMutationLeaseOpts {
  readonly owner: string;
  readonly kind: string;
  readonly now: number;
  readonly ttl: number;
}

/** `saveState` 家族共有的三个可省项。
 *
 * `conflicts` 为 `null`/缺席 = **这次不动冲突表**（不是"清空冲突"）——
 * 传 `[]` 才是清空。这个区分是 Python 侧 `if conflicts is not None` 那一行的语义，
 * 折叠掉它会让"只存 docs 的那几条路径"顺手把整代冲突抹掉。 */
export interface SaveStateOpts {
  readonly conflicts?: readonly JsonObject[] | null | undefined;
  /** Python 默认 `()`。顺序有意义 —— 下标就是 `_ask_rank`。 */
  readonly askedRids?: readonly string[] | undefined;
  /** 给出即变成 compare-and-swap：版本对不上返回 `null`，一个字都不写。 */
  readonly expectedVersion?: number | null | undefined;
}

export interface SaveBuildStateOpts extends SaveStateOpts {
  readonly owner: string;
  readonly now: number;
  readonly status: string;
  readonly error?: string | undefined;
}

export interface SaveChatStateOpts extends SaveStateOpts {
  readonly owner: string;
  readonly now: number;
}

export interface SaveMutationStateOpts extends SaveStateOpts {
  readonly owner: string;
  readonly now: number;
  readonly status: string;
  readonly error?: string | undefined;
  readonly chatOwner?: string | undefined;
}

export interface LoadStateOpts {
  /** `null`/缺席 = 全部键。 */
  readonly keys?: readonly string[] | null | undefined;
  /** Python 默认 **true**（注意：这一个的默认不是 false）。 */
  readonly includeDerived?: boolean | undefined;
}

export interface ListDecisionsOpts {
  readonly activeOnly?: boolean | undefined;
}

export interface ExpectedVersionOpts {
  readonly expectedVersion?: number | null | undefined;
}

export interface ListQuestionsOpts {
  /** `null`/缺席 = 不按状态过滤。 */
  readonly statuses?: readonly string[] | null | undefined;
}

export interface FinalizeDecisionOpts {
  readonly status: string;
  readonly error?: string | undefined;
}

export interface FinalizeRevisionOpts {
  readonly status: string;
}

export interface AppendEventOpts {
  /** "" = 这条事件没有幂等身份（0007 之前的老形态）。 */
  readonly eventId?: string | undefined;
}

export interface ReadEventsOpts {
  /** Python 默认 0 = 从头读。 */
  readonly since?: number | undefined;
}

export interface FinishRunOpts {
  readonly status: string;
  readonly error?: string | undefined;
  readonly budget?: JsonObject | null | undefined;
}

/** `updateUser` 的部分更新。**字段缺席 / `null` = 这一列不动**，
 * 不是"把这一列置空" —— Python 侧每个参数默认 `None` 且逐个 `if x is not None`，
 * 两个实现都必须保持这个语义，否则一次改密码会顺手把 role 和 prefs 清掉。 */
export interface UpdateUserOpts {
  readonly role?: string | null | undefined;
  readonly active?: boolean | null | undefined;
  readonly passwordHash?: string | null | undefined;
  readonly prefs?: JsonObject | null | undefined;
  readonly displayName?: string | null | undefined;
}

export interface UsageSinceOpts {
  /** `null`/缺席 = 不按归属过滤。 */
  readonly owner?: string | null | undefined;
  /** Python 默认 5000。 */
  readonly limit?: number | undefined;
}

export interface ListProjectsOpts {
  readonly owner?: string | null | undefined;
}

export interface DeleteProjectMemoryOpts {
  /** `null`/缺席 = 删这个项目的**全部**记忆；给出列表则只删这几条键。 */
  readonly keys?: readonly string[] | null | undefined;
}

/** `atomic` 作用域里交出来的东西。PgRepo 给的是一个连接/事务句柄，
 * MemoryRepo 给的是它自己 —— 对应 Python 的 `AsyncIterator[Any]`，
 * 所以这里就是 `unknown`：调用方不该对它做类型假设。 */
export type AtomicScope = unknown;

// ══════════════════════════════════════════════════════════════════
//  接口
// ══════════════════════════════════════════════════════════════════

/** 会话仓储。**所有方法都是一个完整事务**（除 `atomic` 作用域内）。 */
export interface Repo {
  /** "memory" | "postgresql" | "sqlite"。 */
  readonly mode: string;

  // ── 会话 ───────────────────────────────────────────────────────
  createSession(row: SessionRow): Promise<SessionRow>;
  getSession(sid: string): Promise<SessionRow | null>;
  listSessions(opts?: ListSessionsOpts): Promise<SessionRow[]>;
  /** 只写 title 这一列，**不动 state_version**。 */
  renameSession(sid: string, title: string): Promise<boolean>;
  setStatus(sid: string, status: string, opts?: SetStatusOpts): Promise<void>;
  /** 状态仍在允许集合时才更新；同一会话的并发调用只有一个能成功。 */
  claimSessionStatus(sid: string, opts: ClaimSessionStatusOpts): Promise<boolean>;
  claimBuildLease(sid: string, opts: ClaimBuildLeaseOpts): Promise<boolean>;
  renewBuildLease(sid: string, opts: LeaseRenewOpts): Promise<boolean>;
  /** 只在这一次调用**仍持有活着的租约**时才改状态。 */
  setBuildStatus(sid: string, opts: SetBuildStatusOpts): Promise<boolean>;
  releaseBuildLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean>;
  /** 一个事务里同时置 stopped 并给当前租约打上取消标记。 */
  requestBuildCancel(sid: string, opts: NowOpts): Promise<boolean>;
  /** 先原子地**消费掉**过期租约，再把这次 build 标失败。
   *
   * 那条带条件的 DELETE 就是与 `renewBuildLease` 的仲裁点：谁先写谁赢、另一方能看见。
   * 只是"读一下旧的过期时间"的回收器，会覆盖掉同时提交的心跳。 */
  reapExpiredBuildLease(sid: string, opts: ReapBuildLeaseOpts): Promise<boolean>;
  /** 用一次原子 upsert 抢下"不存在或已过期"的 chat 租约。 */
  claimChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean>;
  renewChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean>;
  releaseChatLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean>;
  requestChatCancel(sid: string, opts: NowOpts): Promise<boolean>;
  claimMutationLease(sid: string, opts: ClaimMutationLeaseOpts): Promise<boolean>;
  renewMutationLease(sid: string, opts: LeaseRenewOpts): Promise<boolean>;
  releaseMutationLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean>;
  deleteSession(sid: string): Promise<boolean>;
  /** 把 owner 为 `frm` 的会话改判给 `to`，返回改了几行。 */
  reassignSessions(frm: string, to: string): Promise<number>;
  reassignProjects(frm: string, to: string): Promise<number>;

  // ── 文件 ───────────────────────────────────────────────────────
  addFiles(sid: string, files: readonly FileRow[]): Promise<FileRow[]>;
  listFiles(sid: string): Promise<FileRow[]>;
  removeFile(sid: string, name: string): Promise<boolean>;

  // ── 状态与冲突 ─────────────────────────────────────────────────
  /** **唯一**的状态写入口：state 文档 + 整代冲突一起落，版本号一起推进。
   * 返回新的 state_version；`expectedVersion` 对不上返回 `null`（没写任何东西）。 */
  saveState(sid: string, docs: JsonObject, opts?: SaveStateOpts): Promise<number | null>;
  /** 只为**仍然活着的那次 build 调用**做检查点（状态 + state 一起）。 */
  saveBuildState(
    sid: string,
    docs: JsonObject,
    opts: SaveBuildStateOpts,
  ): Promise<number | null>;
  /** 只在这一次 chat 调用仍持有活租约时落库。 */
  saveChatState(sid: string, docs: JsonObject, opts: SaveChatStateOpts): Promise<number | null>;
  saveMutationState(
    sid: string,
    docs: JsonObject,
    opts: SaveMutationStateOpts,
  ): Promise<number | null>;
  loadState(sid: string, opts?: LoadStateOpts): Promise<JsonObject>;
  listConflicts(sid: string): Promise<JsonObject[]>;
  getConflict(sid: string, rid: string): Promise<JsonObject | null>;

  // ── 人的决定（legacy decision，按 ordinal）──────────────────────
  recordDecision(sid: string, d: DecisionRow): Promise<DecisionRow>;
  listDecisions(sid: string, opts?: ListDecisionsOpts): Promise<DecisionRow[]>;
  answeredRids(sid: string): Promise<Set<string>>;

  // ── 统一 Question / Decision / Revision ────────────────────────
  upsertQuestions(sid: string, rows: readonly QuestionRow[]): Promise<QuestionRow[]>;
  saveQuestion(sid: string, row: QuestionRow, opts?: ExpectedVersionOpts): Promise<QuestionRow>;
  listQuestions(sid: string, opts?: ListQuestionsOpts): Promise<QuestionRow[]>;
  getQuestion(sid: string, qid: string): Promise<QuestionRow | null>;
  /** 返回 `[行, 是否新建]` —— `false` 表示命中幂等键，返回的是原来那行。 */
  recordDecisionV1(sid: string, row: DecisionRecordRow): Promise<readonly [DecisionRecordRow, boolean]>;
  finalizeDecisionV1(
    sid: string,
    decisionId: string,
    opts: FinalizeDecisionOpts,
  ): Promise<DecisionRecordRow>;
  listDecisionsV1(sid: string): Promise<DecisionRecordRow[]>;
  /** 按调用方给定的 id/ordinal 写入。 */
  recordRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]>;
  /** 原子分配下一 ordinal 并写 Revision，**幂等键优先于发号**。 */
  appendRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]>;
  finalizeRevision(sid: string, revisionId: string, opts: FinalizeRevisionOpts): Promise<RevisionRow>;
  listRevisions(sid: string): Promise<RevisionRow[]>;

  // ── 事件 ───────────────────────────────────────────────────────
  appendEvent(
    sid: string,
    kind: string,
    payload: JsonObject,
    opts?: AppendEventOpts,
  ): Promise<EventRow>;
  readEvents(sid: string, opts?: ReadEventsOpts): Promise<EventRow[]>;
  countEvents(sid: string): Promise<number>;

  // ── Run ────────────────────────────────────────────────────────
  /** 分配一个**每次 Run 独立**的 id。会话 id 不是 run id —— 同一会话第二次 build
   * 会把 seq 从 0 重来撞进同一份日志，而 (run_id, seq) 上有唯一约束。 */
  nextRun(sid: string, kind: string): Promise<string>;
  finishRun(runId: string, opts: FinishRunOpts): Promise<void>;

  // ── 账号与登录会话（鉴权层）—— 顶层表，不随建模会话级联 ─────────
  createUser(row: UserRow): Promise<UserRow>;
  getUser(uid: string): Promise<UserRow | null>;
  getUserByUsername(username: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  countUsers(): Promise<number>;
  updateUser(uid: string, opts?: UpdateUserOpts): Promise<UserRow | null>;
  deleteUser(uid: string): Promise<boolean>;

  // ── 用量 ───────────────────────────────────────────────────────
  addUsage(row: UsageRow): Promise<void>;
  usageSince(since: number, opts?: UsageSinceOpts): Promise<UsageRow[]>;

  createAuthSession(row: AuthSessionRow): Promise<AuthSessionRow>;
  getAuthSession(tokenHash: string): Promise<AuthSessionRow | null>;
  deleteAuthSession(tokenHash: string): Promise<boolean>;
  deleteUserAuthSessions(uid: string): Promise<number>;
  pruneAuthSessions(opts: NowOpts): Promise<number>;

  // ── 项目文件夹与项目记忆 ───────────────────────────────────────
  //  顶层，不随会话级联 —— 会话删了，项目和它的记忆还在。
  listProjects(opts?: ListProjectsOpts): Promise<ProjectRow[]>;
  createProject(row: ProjectRow): Promise<ProjectRow>;
  getProject(pid: string): Promise<ProjectRow | null>;
  renameProject(pid: string, name: string): Promise<boolean>;
  /** 返回被释放（掉回未归类）的会话数 —— 删项目**不删会话**。 */
  deleteProject(pid: string): Promise<number>;
  /** projectId 传 `null` 或 `""` 都是「移出项目」。 */
  assignSession(sid: string, projectId: string | null): Promise<boolean>;
  listProjectMemory(pid: string): Promise<ProjectMemoryRow[]>;
  upsertProjectMemory(rows: readonly ProjectMemoryRow[]): Promise<number>;
  deleteProjectMemory(pid: string, opts?: DeleteProjectMemoryOpts): Promise<number>;

  // ── 全局应用设置（顶层，不随会话级联）─────────────────────────
  getSetting(key: string): Promise<JsonValue | null>;
  setSetting(key: string, value: JsonValue): Promise<void>;
  listSettings(): Promise<SettingRow[]>;
  deleteSetting(key: string): Promise<boolean>;

  // ── 跨方法事务 ─────────────────────────────────────────────────
  /** 显式事务作用域。**与 Python 的形状不同**：那边是 `async with repo.atomic()`
   * 的异步上下文管理器，JS 没有对等物，所以改成回调式 —— 作用域的进出由这个方法
   * 负责，回调抛出即回滚。两个实现必须一致。
   *
   * MemoryRepo 交出的是它自己，且**内存里没有事务、也不假装有**：半途异常会留下
   * 部分写入。这是内存模式的代价，不是需要被抹平的差异 —— 假装有事务会让人在内存
   * 模式下写出依赖回滚的代码，切到 Postgres 才发现语义对不上。 */
  atomic<T>(fn: (scope: AtomicScope) => Promise<T>): Promise<T>;
}

// ══════════════════════════════════════════════════════════════════
//  方法名清单（结构性测试的输入）
// ══════════════════════════════════════════════════════════════════

/** `Repo` 的全部方法名，顺序与 Python 原件一致。
 *
 * 接口在运行时是不存在的，所以想让"漏了一个方法"立刻变红就必须有一份**运行时可见**
 * 的清单。下面那两个类型别名把它和 `keyof Repo` 双向钉死：多写一个或少写一个都在
 * tsc 阶段报错；`store.repo.protocol.test.ts` 再把它和 Python 原件解析出来的名字比对。 */
export const REPO_METHOD_NAMES = [
  "createSession",
  "getSession",
  "listSessions",
  "renameSession",
  "setStatus",
  "claimSessionStatus",
  "claimBuildLease",
  "renewBuildLease",
  "setBuildStatus",
  "releaseBuildLease",
  "requestBuildCancel",
  "reapExpiredBuildLease",
  "claimChatLease",
  "renewChatLease",
  "releaseChatLease",
  "requestChatCancel",
  "claimMutationLease",
  "renewMutationLease",
  "releaseMutationLease",
  "deleteSession",
  "reassignSessions",
  "reassignProjects",
  "addFiles",
  "listFiles",
  "removeFile",
  "saveState",
  "saveBuildState",
  "saveChatState",
  "saveMutationState",
  "loadState",
  "listConflicts",
  "getConflict",
  "recordDecision",
  "listDecisions",
  "answeredRids",
  "upsertQuestions",
  "saveQuestion",
  "listQuestions",
  "getQuestion",
  "recordDecisionV1",
  "finalizeDecisionV1",
  "listDecisionsV1",
  "recordRevision",
  "appendRevision",
  "finalizeRevision",
  "listRevisions",
  "appendEvent",
  "readEvents",
  "countEvents",
  "nextRun",
  "finishRun",
  "createUser",
  "getUser",
  "getUserByUsername",
  "listUsers",
  "countUsers",
  "updateUser",
  "deleteUser",
  "addUsage",
  "usageSince",
  "createAuthSession",
  "getAuthSession",
  "deleteAuthSession",
  "deleteUserAuthSessions",
  "pruneAuthSessions",
  "listProjects",
  "createProject",
  "getProject",
  "renameProject",
  "deleteProject",
  "assignSession",
  "listProjectMemory",
  "upsertProjectMemory",
  "deleteProjectMemory",
  "getSetting",
  "setSetting",
  "listSettings",
  "deleteSetting",
  "atomic",
] as const;

export type RepoMethodName = (typeof REPO_METHOD_NAMES)[number];

/** 编译期双向穷尽：`Repo` 有而清单没有 → `_MissingFromList` 非 never → 赋值报错。 */
type _MissingFromList = Exclude<Exclude<keyof Repo, "mode">, RepoMethodName>;
type _ExtraInList = Exclude<RepoMethodName, keyof Repo>;
const _exhaustive: [_MissingFromList, _ExtraInList] extends [never, never] ? true : never = true;
void _exhaustive;
