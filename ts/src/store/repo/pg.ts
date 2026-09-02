/**
 * 仓储的数据库实现 —— 移植自 `store/repo.py` 的 `class PgRepo`（1409–3214 行）。
 *
 * 名字沿用 Python 的 `PgRepo`（不是 `SqlRepo`）：它同时服务 Postgres 与 SQLite，
 * 改名会让两边的日志、错误消息、文档互相对不上。
 *
 * ── 双方言：Python 靠 SQLAlchemy 的 with_variant，TS 靠 Drizzle 的两套表 ──────
 *
 * Python 侧一份 Core 语句编译到两个方言，唯一显式分叉的是 upsert 的 import
 * （`sqlalchemy.dialects.{postgresql,sqlite}.insert`）。TS 侧 Drizzle 的
 * `onConflictDoUpdate` 在两个方言上**签名一致**，所以那一处分叉在这里消失了；
 * 真正剩下的方言差异只有三类，全部收在本文件顶部的编解码器里：
 *
 *   1. **tstz 列**（见 CONTRACT §7.2）。Postgres 上是 timestamptz，驱动收 `Date`；
 *      SQLite 上 SQLAlchemy 存的是 **ISO 文本** `'YYYY-MM-DD HH:MM:SS.ffffff'`
 *      （UTC 墙上时间、6 位微秒、**不带时区后缀**）。这里照存同一种文本，
 *      Python 时代那份 `.db` 才读得出来。读写都走 `tstzOut` / `tstzEpoch`。
 *   2. **JSON 列**。PG 是 jsonb，SQLite 是 TEXT + 应用层 dumps/loads。
 *      Drizzle 的列声明（`jsonb()` / `text({mode:"json"})`）已经把这层吃掉了，
 *      所以本文件里 JSON 列的读写就是普通 JS 值 —— 这正是 schema.ts 那份
 *      「一份中立 spec、两个生成器」的红利。字节层面的差异见文末 §分叉 2。
 *   3. **`SELECT … FOR UPDATE`**。SQLAlchemy 的 `with_for_update()` 在 SQLite 上
 *      渲染为空（方言不支持就静默丢掉），Drizzle 的 sqlite builder 干脆没有这个
 *      方法。相关的三处（`reapExpiredBuildLease` / `claimChatLease` /
 *      `recordDecisionV1` / `appendRevision`）都标了 `PG-FOR-UPDATE` 注释，
 *      接 PG 驱动时必须逐处补上 —— SQLite 上它本来就是无操作，行为与 Python 一致。
 *
 * ── 事务与并发：正确性在 SQL 层，不在这里 ──────────────────────────────────
 *
 * 三个租约（build / chat / mutation）、`next_decision_ordinal` / `next_event_seq`
 * / `next_run_ordinal` 三个计数器、`session_event.event_id` 的幂等 —— 这些的正确
 * 性靠的是**带条件的单条写语句 + 事务边界**，不是先读后判。Python 原件里那几段
 * 英文注释记的就是踩过的坑（"A no-op UPDATE is the common arbitration primitive"、
 * "SQLite ignores FOR UPDATE"），逐条迁过来了，别按"读起来更清楚"重排。
 *
 * ── 已知分叉（对 Python 原件）────────────────────────────────────────────
 *
 * 1. **入参不被就地修改。** Python 的 `record_decision` / `record_decision_v1` /
 *    `append_revision` / `save_question` 直接改传进来的 dataclass（`d.ordinal = …`），
 *    调用方即使不看返回值也能拿到新字段。TS 的 Row DTO 是 `readonly interface`
 *    （types.ts 的决定），所以这里一律**返回新对象**。两边都 `return row`，
 *    按返回值用的调用点行为相同；靠副作用的调用点在 TS 侧必须改成用返回值。
 * 2. **JSON 列的存储字节不同。** SQLAlchemy 用 `json.dumps` 默认参数
 *    （分隔符 `", "` / `": "`、`ensure_ascii=True`），Drizzle 用 `JSON.stringify`
 *    （紧凑、UTF-8 原样）。**读没有影响**（`JSON.parse` 两种都吃，所以 Python 时代
 *    的库照读），只影响两处：库文件的字节 diff，以及下面第 3 条。
 * 3. **`recordDecision` 里按 `scope_refs` 找旧决定改在应用侧比。** Python 写的是
 *    `t.decision.c.scope_refs == (d.scope_refs or [])` —— 那在 PG 上是 jsonb 语义
 *    相等，在 SQLite 上退化成**文本相等**，于是它本来就是一条两个方言解释不同的
 *    判据；叠加第 2 条（TS 与 Python 写出的文本不同）会让跨版本的行彻底匹配不上。
 *    这里改成取出候选行在 JS 里逐元素比 —— 等于 PG 的语义，且不受序列化形态影响。
 *    仍在同一个事务里，原子性不变。
 * 4. **`KeyError` 没有对等物。** `finalizeDecisionV1` / `finalizeRevision` 找不到行
 *    时 Python 抛 `KeyError`，这里抛消息逐字相同的 `Error`。
 * 5. **`atomic()` 里不能再调本类的其它方法。** 每个方法自己 `engine.begin()`，
 *    而 engine 明确禁止嵌套借用（会抛一条说得清的错，不是死锁）。Python 侧同样
 *    没有"作用域内复用连接"的实现（docstring 说了但没做），且全仓没有调用点。
 */

import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { pyRepr } from "../../kernel/errors.js";
import { contentRef } from "../../kernel/ids.js";
import { pyJsonDumps } from "../../kernel/journal.js";
import { IdempotencyConflict, RevisionConflict, ValueError } from "../../onto/questions.js";
import { DERIVED_KEYS, EVENT_INLINE_LIMIT } from "../const.js";
import type { Conn, Engine } from "../engine.js";
import { sqliteTables as t } from "../schema.js";
import {
  DuplicateUsername,
  emptyToNull,
  makeAuthSessionRow,
  makeDecisionRecordRow,
  makeDecisionRow,
  makeFileRow,
  makeProjectMemoryRow,
  makeProjectRow,
  makeQuestionRow,
  makeRevisionRow,
  makeSessionRow,
  makeSettingRow,
  makeUsageRow,
  makeUserRow,
  nullToEmpty,
  validateUsageRow,
} from "../types.js";
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
//  时间列的编解码 —— CONTRACT §7.2
// ══════════════════════════════════════════════════════════════════

/** 一行库里读出来的东西。Drizzle 在这套「中立 spec 生成表」的路径上推不出逐列类型
 * （schema.ts 文件头的形态决策），所以统一按 `unknown` 取、显式收窄 —— 与 Python
 * 侧的 `_session_row(r)` 是同一层。 */
type Rec = Record<string, unknown>;

/** SQLAlchemy 的 SQLite DATETIME 存储格式：`'%Y-%m-%d %H:%M:%S.%f'`，UTC 墙上时间，
 * 微秒**恒为 6 位**，没有 `T`、没有时区后缀。实测（TZ=Asia/Shanghai）：
 * `datetime.fromtimestamp(1700000000.5, UTC)` → `'2023-11-14 22:13:20.500000'`。
 *
 * 微秒从 epoch 直接算而不是过 `Date`：`Date` 只有毫秒精度，而 `time.time()` 给的是
 * 微秒 —— 过一次 Date 就把 `ts` 的低三位磨掉了，落库的文本与 Python 不同。 */
export function tstzText(sec: number): string {
  const totalUs = Math.round(sec * 1e6);
  const whole = Math.floor(totalUs / 1e6);
  const us = totalUs - whole * 1e6;
  const d = new Date(whole * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(us, 6)}`
  );
}

const TSTZ_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/;

/** tstz 列 → epoch 秒。
 *
 * **按 UTC 解析。** 这是与 Python 的一处刻意分叉，理由见文件尾的注释块：Python 写
 * 进去的是 UTC 墙上时间，但 SQLAlchemy 的 SQLite 结果处理器还回来的是**朴素**
 * datetime，`.timestamp()` 于是按**本地时区**解释 —— 实测 TZ=Asia/Shanghai 下
 * 写 1700000000.5 读出来是 1699971200.5，差整整 8 小时。那是 Python 侧的缺陷而不是
 * 契约：按 UTC 解析才能原样往返，且在 TZ=UTC（容器里的常态、golden 的口径）下两边
 * 逐位相同。 */
export function tstzEpoch(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (v instanceof Date) return v.getTime() / 1000;
  // PG 驱动接上之后 timestamptz 回的是 Date；数字只可能来自被别的工具改过的库，
  // 按 epoch 秒收下比抛出更有用（Python 那边会直接崩在 .timestamp() 上）。
  if (typeof v === "number") return v;
  const m = TSTZ_RE.exec(String(v));
  if (m === null) throw new Error(`无法解析时间列: ${JSON.stringify(v)}`);
  const [, y, mo, d, hh, mm, ss, frac] = m;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  // 小数位不足 6 位要右补零（CURRENT_TIMESTAMP 默认值干脆一位都没有）。
  const us = frac === undefined ? 0 : Number(frac.padEnd(6, "0").slice(0, 6));
  return base / 1000 + us / 1e6;
}

/** `time.time()`。 */
function nowSec(): number {
  return Date.now() / 1000;
}

// ══════════════════════════════════════════════════════════════════
//  取列的小工具
// ══════════════════════════════════════════════════════════════════

function asRec(r: unknown): Rec {
  return r as Rec;
}

/** NOT NULL 的 text 列。 */
function txt(r: Rec, k: string): string {
  const v = r[k];
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/** 可空 text 列 → `""`（Python 的 `r["x"] or ""`）。 */
function txtOrEmpty(r: Rec, k: string): string {
  return nullToEmpty(r[k] as string | null | undefined);
}

/** 可空 text 列 → `null`（`conflict.owner` / `revision_record.parent_id` 这种
 * "真的没有"的列，见 types.ts 的 EMPTY_AS_NULL 说明）。 */
function txtOrNull(r: Rec, k: string): string | null {
  const v = r[k];
  return typeof v === "string" ? v : null;
}

function int(r: Rec, k: string): number {
  const v = r[k];
  return v === null || v === undefined ? 0 : Math.trunc(Number(v));
}

function intOrNull(r: Rec, k: string): number | null {
  const v = r[k];
  return v === null || v === undefined ? null : Math.trunc(Number(v));
}

function flt(r: Rec, k: string): number {
  const v = r[k];
  return v === null || v === undefined ? 0 : Number(v);
}

function bool(r: Rec, k: string): boolean {
  return Boolean(r[k]);
}

/** JSON 列 → 对象（`dict(r["x"] or {})`）。 */
function jsonObj(v: unknown): JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as JsonObject) } : {};
}

/** JSON 列 → 字符串数组（`list(r["x"] or [])`）。 */
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function jsonList(v: unknown): JsonValue[] {
  return Array.isArray(v) ? [...(v as JsonValue[])] : [];
}

/** `c.get(k, dflt)`，且只接受字符串 —— 非字符串落进 TEXT 列在 SQLite 上会变成
 * 另一种存储类型，那种畸形输入不值得原样搬。 */
function getStr(c: JsonObject, k: string, dflt = ""): string {
  const v = c[k];
  return typeof v === "string" ? v : dflt;
}

/** `c["k"]` —— 缺键在 Python 侧是 KeyError，这里也当场抛。 */
function reqStr(c: JsonObject, k: string): string {
  const v = c[k];
  if (typeof v !== "string") throw new Error(`冲突记录缺少必需字段 ${k}`);
  return v;
}

/** 整数唯一化并保序（Python `tuple(dict.fromkeys(xs))`）。 */
function dedup(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** SQLAlchemy 的 IntegrityError 对应物。Python 侧 `create_user` / `claimChatLease`
 * 捕的是整个 IntegrityError（UNIQUE / CHECK / NOT NULL / FK 都算），这里按驱动的
 * 消息判同一个范围：node:sqlite 是 `"… constraint failed: …"`，PG 是
 * `"duplicate key value violates unique constraint"` 之类的 23xxx 类。 */
function isIntegrityError(e: unknown): boolean {
  // Drizzle 把驱动的错误包成 `DrizzleQueryError: Failed query: …`，真正的
  // "UNIQUE constraint failed: app_user.username" 只在 `cause` 上。**只看最外层
  // 那条消息，判据永远为假** —— 于是重名注册不会变成 409 而是 500，而且两个 repo
  // 实现的行为从此分叉。所以顺着 cause 链一路看下去。
  for (let cur: unknown = e, depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/constraint failed/i.test(msg) || /violates .*constraint/i.test(msg)) return true;
    cur = cur instanceof Error ? (cur.cause as unknown) : null;
  }
  return false;
}

function arrayEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 一次 INSERT 塞太多行会撞 SQLite 的绑定变量上限（SQLITE_MAX_VARIABLE_NUMBER）。
 * Python 侧走的是 executemany（一行一条语句），没有这个上限；这里分批发。 */
function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const CONFLICT_CHUNK = 100;

/** 正在跑的 build 的三种公开状态。Python 侧这个元组出现了五次，抄错一次就是
 * "租约还活着但状态机认为它结束了"。 */
const BUILD_ACTIVE = ["queued", "parsing", "extracting"] as const;

// ══════════════════════════════════════════════════════════════════
//  行 → DTO
// ══════════════════════════════════════════════════════════════════

function sessionRow(r: Rec): SessionRow {
  return makeSessionRow({
    id: txt(r, "id"),
    title: txt(r, "title"),
    project: txt(r, "project"),
    status: txt(r, "status"),
    error: txt(r, "error"),
    created: tstzEpoch(r["created_at"]),
    state_version: int(r, "state_version"),
    owner: txtOrEmpty(r, "owner"),
    project_id: txtOrEmpty(r, "project_id"), // NULL ↔ ""（未归类）
  });
}

function projectRow(r: Rec): ProjectRow {
  return makeProjectRow({
    id: txt(r, "id"),
    name: txt(r, "name"),
    owner: txtOrEmpty(r, "owner"), // NULL ↔ ""
    prefs: jsonObj(r["prefs"]),
    sort_order: int(r, "sort_order"),
  });
}

function projectMemoryRow(r: Rec): ProjectMemoryRow {
  return makeProjectMemoryRow({
    project_id: txt(r, "project_id"),
    key: txt(r, "key"),
    tier: txt(r, "tier"),
    kind: txt(r, "kind"),
    content: txt(r, "content"),
    confidence: flt(r, "confidence"),
    support: strList(r["support"]),
    tags: strList(r["tags"]),
    origin_session: txtOrEmpty(r, "origin_session"),
    origin_files: strList(r["origin_files"]),
    contested_by: strList(r["contested_by"]),
    hit_runs: strList(r["hit_runs"]),
    use_count: int(r, "use_count"),
    created_run: txtOrEmpty(r, "created_run"),
    last_used_run: txtOrEmpty(r, "last_used_run"),
  });
}

function questionRow(r: Rec): QuestionRow {
  return makeQuestionRow({
    id: txt(r, "id"),
    text: txt(r, "text"),
    status: txt(r, "status"),
    owner_user_id: txt(r, "owner_user_id"),
    audience_role: txt(r, "audience_role"),
    answer_schema: jsonObj(r["answer_schema"]),
    priority: txt(r, "priority"),
    dependencies: strList(r["dependencies"]),
    blocked_artifacts: strList(r["blocked_artifacts"]),
    source_kind: txt(r, "source_kind"),
    source_ref: txt(r, "source_ref"),
    doc: jsonObj(r["doc"]),
    version: int(r, "version"),
    created: tstzEpoch(r["created_at"]),
    updated: tstzEpoch(r["updated_at"]),
  });
}

function decisionRecordRow(r: Rec): DecisionRecordRow {
  return makeDecisionRecordRow({
    id: txt(r, "id"),
    question_id: txt(r, "question_id"),
    answer: (r["answer"] ?? null) as JsonValue,
    actor: txt(r, "actor"),
    actor_role: txt(r, "actor_role"),
    authority: txt(r, "authority"),
    source_turn: txt(r, "source_turn"),
    affected_ids: strList(r["affected_ids"]),
    supersedes: txtOrNull(r, "supersedes"),
    revision: intOrNull(r, "revision"),
    idempotency_key: txt(r, "idempotency_key"),
    semantic_hash: txt(r, "semantic_hash"),
    rationale: txt(r, "rationale"),
    metadata: jsonObj(r["metadata"]),
    created: tstzEpoch(r["created_at"]),
  });
}

function revisionRow(r: Rec): RevisionRow {
  const patch = r["patch_set"];
  return makeRevisionRow({
    id: txt(r, "id"),
    ordinal: int(r, "ordinal"),
    parent_id: txtOrNull(r, "parent_id"),
    kind: txt(r, "kind"),
    status: txt(r, "status"),
    doc: jsonObj(r["doc"]),
    patch_set: patch === null || patch === undefined ? null : jsonObj(patch),
    changed_ids: strList(r["changed_ids"]),
    invalidated_artifacts: strList(r["invalidated_artifacts"]),
    actor: txt(r, "actor"),
    source_turn: txt(r, "source_turn"),
    snapshot_hash: txt(r, "snapshot_hash"),
    idempotency_key: txt(r, "idempotency_key"),
    created: tstzEpoch(r["created_at"]),
  });
}

function userRow(r: Rec): UserRow {
  return makeUserRow({
    id: txt(r, "id"),
    username: txt(r, "username"),
    password_hash: txt(r, "password_hash"),
    role: txt(r, "role"),
    active: bool(r, "active"),
    prefs: jsonObj(r["prefs"]),
    created: tstzEpoch(r["created_at"]),
    display_name: txtOrEmpty(r, "display_name"),
  });
}

function usageRow(r: Rec): UsageRow {
  return makeUsageRow({
    id: txt(r, "id"),
    ts: flt(r, "ts"),
    day: txt(r, "day"),
    model: txt(r, "model"),
    owner: txtOrEmpty(r, "owner"),
    session_id: txtOrEmpty(r, "session_id"),
    run_id: txtOrEmpty(r, "run_id"),
    node_id: txtOrEmpty(r, "node_id"),
    kind: txt(r, "kind"),
    effort: txtOrEmpty(r, "effort"),
    tok_in: int(r, "tok_in"),
    tok_out: int(r, "tok_out"),
    cache_read: int(r, "cache_read"),
    cache_write: int(r, "cache_write"),
    usd: flt(r, "usd"),
    usd_source: txt(r, "usd_source"),
    attempts: int(r, "attempts"),
    status: txt(r, "status"),
  });
}

function authRow(r: Rec): AuthSessionRow {
  return makeAuthSessionRow({
    token_hash: txt(r, "token_hash"),
    user_id: txt(r, "user_id"),
    created: tstzEpoch(r["created_at"]),
    last_seen: tstzEpoch(r["last_seen_at"]),
    expires: tstzEpoch(r["expires_at"]),
  });
}

/** 当前有效的 Decision = 没有被同问题的另一行 `supersedes` 指向的那条。
 *
 * `failed` 是副作用没有生效的审计记录，既不能成为 active Decision，也不能靠
 * `supersedes` 把上一个成功决定从链上拿掉。
 *
 * **导出是给 MemoryRepo 复用的**：Python 侧 `_active_decision_v1` 是模块级私有函数，
 * 两个实现共用同一份；TS 侧两个实现在两个文件里，各抄一份就是给分叉留门。 */
export function activeDecisionV1(
  rows: readonly DecisionRecordRow[],
  questionId: string,
): DecisionRecordRow | null {
  const live = rows.filter((r) => r.metadata["status"] !== "failed");
  const superseded = new Set(live.map((r) => r.supersedes).filter((x): x is string => Boolean(x)));
  for (let i = live.length - 1; i >= 0; i--) {
    const r = live[i]!;
    if (r.question_id === questionId && !superseded.has(r.id)) return r;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  PgRepo
// ══════════════════════════════════════════════════════════════════

export class PgRepo implements Repo {
  /** `"postgresql"` | `"sqlite"` —— 与 Python 侧 `engine.dialect.name` 同名同值。
   * **注意它与 `Store.mode`（`"postgres"`）不是一个词**，见 engine.ts 的说明。 */
  readonly mode: string;

  private readonly pg: boolean;

  constructor(private readonly engine: Engine) {
    this.mode = engine.dialect;
    this.pg = engine.dialect === "postgresql";
  }

  // ── 连接 ─────────────────────────────────────────────────────
  async atomic<T>(fn: (scope: AtomicScope) => Promise<T>): Promise<T> {
    return this.engine.begin(async (conn) => fn(conn));
  }

  /** tstz 列的写入值。 */
  private tstz(sec: number): unknown {
    return this.pg ? new Date(Math.round(sec * 1000)) : tstzText(sec);
  }

  // ── 会话 ─────────────────────────────────────────────────────
  async createSession(row: SessionRow): Promise<SessionRow> {
    const created = row.created || nowSec();
    const out = makeSessionRow({ ...row, created });
    // created_at 必须写调用方给的时间，不能一律 now()。
    // 交给 server_default 的后果是：MemoryRepo 按 row.created 排序、PgRepo 按
    // now() 排序，同一份输入两个实现给出不同顺序 —— 而且只在生产上才看得见。
    await this.engine.begin(async (conn) => {
      await conn.db.insert(t.session).values({
        id: out.id,
        title: out.title,
        project: out.project,
        status: out.status,
        error: out.error,
        state_version: 0,
        next_event_seq: 0,
        next_run_ordinal: 0,
        owner: emptyToNull(out.owner), // "" → NULL（无归属）
        project_id: emptyToNull(out.project_id), // "" → NULL（未归类）
        created_at: this.tstz(created),
        updated_at: this.tstz(created),
      });
    });
    return out;
  }

  async getSession(sid: string): Promise<SessionRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.session).where(eq(t.session.id, sid)),
    );
    const r = rows[0];
    return r === undefined ? null : sessionRow(asRec(r));
  }

  async listSessions(opts?: ListSessionsOpts): Promise<SessionRow[]> {
    const limit = opts?.limit ?? 100;
    const owner = opts?.owner ?? null;
    const rows = await this.engine.connect(async (conn) => {
      const q = conn.db.select().from(t.session).$dynamic();
      // 只看归属自己的；NULL(无归属)天然被排除
      if (owner !== null) q.where(eq(t.session.owner, owner));
      return q.orderBy(desc(t.session.created_at)).limit(limit);
    });
    return rows.map((r) => sessionRow(asRec(r)));
  }

  /** 只写 title。**故意不碰 state_version。**
   *
   * state_version 是状态文档（oir/flow/dialogue…）的 CAS 令牌：正在跑的 build
   * 和 chat 都拿着自己那份期望值去提交。改个名字和那些文档毫无关系，跟着 +1
   * 的话，用户在侧栏上改个标题就会让另一台 worker 正在收尾的梳理提交 409，
   * 几分钟的活白干。
   *
   * updated_at 显式写：`touch_updated_at` 触发器只有 Postgres 的迁移里有
   * （CONTRACT §7.3：TS 侧照样不补），和 `renameProject` 同一个理由。 */
  async renameSession(sid: string, title: string): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.session)
        .set({ title, updated_at: this.tstz(nowSec()) })
        .where(eq(t.session.id, sid))
        .returning({ id: t.session.id }),
    );
    return rows.length > 0;
  }

  async reassignSessions(frm: string, to: string): Promise<number> {
    // 无归属在库里是 NULL，在内存里是 ""，两边都要认 —— 只匹配其中一种，
    // 换个 repo 实现就会漏掉一半会话。
    const cond = frm
      ? eq(t.session.owner, frm)
      : or(isNull(t.session.owner), eq(t.session.owner, ""));
    const rows = await this.engine.begin(async (conn) =>
      conn.db.update(t.session).set({ owner: to }).where(cond).returning({ id: t.session.id }),
    );
    return rows.length;
  }

  async reassignProjects(frm: string, to: string): Promise<number> {
    // 与 reassignSessions 同一套 NULL/"" 双认判据 —— 项目和会话必须一起被认领，
    // 只认领会话的后果是会话还在、分组名没了，全掉回「未归类」。
    const cond = frm
      ? eq(t.project.owner, frm)
      : or(isNull(t.project.owner), eq(t.project.owner, ""));
    const rows = await this.engine.begin(async (conn) =>
      conn.db.update(t.project).set({ owner: to }).where(cond).returning({ id: t.project.id }),
    );
    return rows.length;
  }

  async setStatus(sid: string, status: string, opts?: SetStatusOpts): Promise<void> {
    const error = opts?.error ?? "";
    await this.engine.begin(async (conn) => {
      await conn.db.update(t.session).set({ status, error }).where(eq(t.session.id, sid));
    });
  }

  /** 用单条条件 UPDATE 完成 CAS；进程锁不能替代这个事务边界。 */
  async claimSessionStatus(sid: string, opts: ClaimSessionStatusOpts): Promise<boolean> {
    const allowed = dedup(opts.fromStatuses);
    if (allowed.length === 0) return false;
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.session)
        .set({ status: opts.toStatus, error: opts.error ?? "" })
        .where(and(eq(t.session.id, sid), inArray(t.session.status, allowed)))
        .returning({ id: t.session.id }),
    );
    return rows.length === 1;
  }

  /** Claim build state and lease in one transaction across all workers. */
  async claimBuildLease(sid: string, opts: ClaimBuildLeaseOpts): Promise<boolean> {
    const { owner, now, ttl } = opts;
    const allowed = dedup(opts.fromStatuses);
    if (!owner || ttl <= 0) throw new ValueError("build lease owner 不能为空且 ttl 必须大于 0");
    if (allowed.length === 0) return false;
    return this.engine.begin(async (conn) => {
      // A no-op UPDATE is the common arbitration primitive for both databases:
      // PostgreSQL locks this session row, while SQLite takes its database write
      // lock before reading the status.  ``SELECT .. FOR UPDATE`` is silently
      // ignored by SQLite and allowed two independent workers to both observe
      // ``idle`` and overwrite the lease owner.
      const cur = await conn.db
        .update(t.session)
        .set({ state_version: sql`${t.session.state_version}` })
        .where(eq(t.session.id, sid))
        .returning({ status: t.session.status });
      const currentStatus = cur[0] === undefined ? null : txt(asRec(cur[0]), "status");
      if (currentStatus === null || !allowed.includes(currentStatus)) return false;
      // An expired mutation is abandoned and may be consumed.  A live domain
      // writer keeps build from changing status in this same transaction.
      await conn.db
        .delete(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), lte(t.mutation_lease.expires_at, now)));
      const liveMutation = await conn.db
        .select({ id: t.mutation_lease.session_id })
        .from(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), gt(t.mutation_lease.expires_at, now)));
      if (liveMutation.length > 0) return false;
      // A live lease with a startable public status is inconsistent but must
      // still fail closed.  Only an expired owner may be replaced.
      await conn.db
        .delete(t.build_lease)
        .where(and(eq(t.build_lease.session_id, sid), lte(t.build_lease.expires_at, now)));
      const liveBuild = await conn.db
        .select({ id: t.build_lease.session_id })
        .from(t.build_lease)
        .where(eq(t.build_lease.session_id, sid));
      if (liveBuild.length > 0) return false;
      await conn.db.insert(t.build_lease).values({
        session_id: sid,
        owner,
        acquired_at: now,
        heartbeat_at: now,
        expires_at: now + ttl,
        cancel_requested_at: null,
      });
      await conn.db
        .update(t.session)
        .set({ status: opts.toStatus ?? "queued", error: opts.error ?? "" })
        .where(eq(t.session.id, sid));
      return true;
    });
  }

  async renewBuildLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now, ttl } = opts;
    if (ttl <= 0) throw new ValueError("build lease ttl 必须大于 0");
    const active = sql`exists (select 1 from ${t.session} where ${and(
      eq(t.session.id, sid),
      inArray(t.session.status, [...BUILD_ACTIVE]),
    )})`;
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.build_lease)
        .set({ heartbeat_at: now, expires_at: now + ttl })
        .where(
          and(
            eq(t.build_lease.session_id, sid),
            eq(t.build_lease.owner, owner),
            isNull(t.build_lease.cancel_requested_at),
            active,
          ),
        )
        .returning({ id: t.build_lease.session_id }),
    );
    return rows.length === 1;
  }

  /** Update status only while this exact invocation still owns a live lease. */
  async setBuildStatus(sid: string, opts: SetBuildStatusOpts): Promise<boolean> {
    const { owner, now, status } = opts;
    const ownsLiveLease = sql`exists (select 1 from ${t.build_lease} where ${and(
      eq(t.build_lease.session_id, sid),
      eq(t.build_lease.owner, owner),
      isNull(t.build_lease.cancel_requested_at),
      gt(t.build_lease.expires_at, now),
    )})`;
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.session)
        .set({ status, error: opts.error ?? "" })
        .where(
          and(eq(t.session.id, sid), inArray(t.session.status, [...BUILD_ACTIVE]), ownsLiveLease),
        )
        .returning({ id: t.session.id }),
    );
    return rows.length === 1;
  }

  async releaseBuildLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.build_lease)
        .where(and(eq(t.build_lease.session_id, sid), eq(t.build_lease.owner, opts.owner)))
        .returning({ id: t.build_lease.session_id }),
    );
    return rows.length === 1;
  }

  /** Set stopped and mark the current lease cancelled in one transaction. */
  async requestBuildCancel(sid: string, opts: NowOpts): Promise<boolean> {
    return this.engine.begin(async (conn) => {
      const stopped = await conn.db
        .update(t.session)
        .set({ status: "stopped", error: "" })
        .where(and(eq(t.session.id, sid), inArray(t.session.status, [...BUILD_ACTIVE])))
        .returning({ id: t.session.id });
      if (stopped.length === 0) return false;
      await conn.db
        .update(t.build_lease)
        .set({ cancel_requested_at: opts.now })
        .where(eq(t.build_lease.session_id, sid));
      return true;
    });
  }

  /** Atomically consume an expired lease before marking its build failed.
   *
   * The guarded DELETE is the arbitration point with ``renewBuildLease``:
   * whichever write wins is observed by the other.  A reaper that merely read an
   * old expiry could otherwise overwrite a heartbeat that committed meanwhile. */
  async reapExpiredBuildLease(sid: string, opts: ReapBuildLeaseOpts): Promise<boolean> {
    const { now, error } = opts;
    return this.engine.begin(async (conn) => {
      // All build lifecycle mutations take the parent session before the lease.
      // Keeping that lock order avoids a Postgres deadlock with
      // requestBuildCancel (session -> lease), while the guarded DELETE below
      // remains the renewal/reap arbitration point.
      // PG-FOR-UPDATE：接 PG 驱动时这条 SELECT 要加 `FOR UPDATE`（SQLite 上无操作）。
      const cur = await conn.db
        .select({ status: t.session.status })
        .from(t.session)
        .where(eq(t.session.id, sid));
      const currentStatus = cur[0] === undefined ? null : txt(asRec(cur[0]), "status");
      if (currentStatus === null || !BUILD_ACTIVE.includes(currentStatus as "queued")) return false;
      const consumed = await conn.db
        .delete(t.build_lease)
        .where(and(eq(t.build_lease.session_id, sid), lte(t.build_lease.expires_at, now)))
        .returning({ id: t.build_lease.session_id });
      if (consumed.length === 0) {
        // No row means either a legacy running session (safe to reconcile) or
        // a live lease.  Distinguish them inside this same transaction.
        const hasLive = await conn.db
          .select({ id: t.build_lease.session_id })
          .from(t.build_lease)
          .where(eq(t.build_lease.session_id, sid));
        if (hasLive.length > 0) return false;
      }
      const updated = await conn.db
        .update(t.session)
        .set({ status: "failed", error })
        .where(and(eq(t.session.id, sid), inArray(t.session.status, [...BUILD_ACTIVE])))
        .returning({ id: t.session.id });
      return updated.length > 0;
    });
  }

  /** Claim an absent/expired session chat lease with one atomic upsert. */
  async claimChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now, ttl } = opts;
    if (!owner || ttl <= 0) throw new ValueError("chat lease owner 不能为空且 ttl 必须大于 0");
    const values = {
      session_id: sid,
      owner,
      acquired_at: now,
      heartbeat_at: now,
      expires_at: now + ttl,
      cancel_requested_at: null,
    };
    return this.engine.begin(async (conn) => {
      // PG-FOR-UPDATE：接 PG 驱动时这条 SELECT 要加 `FOR UPDATE`。
      const st = await conn.db
        .select({ status: t.session.status })
        .from(t.session)
        .where(eq(t.session.id, sid));
      if (st[0] === undefined) return false;
      await conn.db
        .delete(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), lte(t.mutation_lease.expires_at, now)));
      const liveMutation = await conn.db
        .select({ id: t.mutation_lease.session_id })
        .from(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), gt(t.mutation_lease.expires_at, now)));
      if (liveMutation.length > 0) return false;
      try {
        const claimed = await conn.db
          .insert(t.chat_lease)
          .values(values)
          .onConflictDoUpdate({
            target: t.chat_lease.session_id,
            set: {
              owner: values.owner,
              acquired_at: values.acquired_at,
              heartbeat_at: values.heartbeat_at,
              expires_at: values.expires_at,
              cancel_requested_at: values.cancel_requested_at,
            },
            where: lte(t.chat_lease.expires_at, now),
          })
          .returning({ owner: t.chat_lease.owner });
        return claimed[0] !== undefined && txt(asRec(claimed[0]), "owner") === owner;
      } catch (e) {
        // Missing session is a normal false claim.  Preserve genuine DB errors;
        // checking parent first would introduce a TOCTOU with session deletion.
        if (isIntegrityError(e)) return false;
        throw e;
      }
    });
  }

  async renewChatLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now, ttl } = opts;
    if (ttl <= 0) throw new ValueError("chat lease ttl 必须大于 0");
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.chat_lease)
        .set({ heartbeat_at: now, expires_at: now + ttl })
        .where(
          and(
            eq(t.chat_lease.session_id, sid),
            eq(t.chat_lease.owner, owner),
            isNull(t.chat_lease.cancel_requested_at),
            gt(t.chat_lease.expires_at, now),
          ),
        )
        .returning({ id: t.chat_lease.session_id }),
    );
    return rows.length === 1;
  }

  async releaseChatLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.chat_lease)
        .where(and(eq(t.chat_lease.session_id, sid), eq(t.chat_lease.owner, opts.owner)))
        .returning({ id: t.chat_lease.session_id }),
    );
    return rows.length === 1;
  }

  async requestChatCancel(sid: string, opts: NowOpts): Promise<boolean> {
    const { now } = opts;
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.chat_lease)
        .set({ cancel_requested_at: now })
        .where(
          and(
            eq(t.chat_lease.session_id, sid),
            gt(t.chat_lease.expires_at, now),
            isNull(t.chat_lease.cancel_requested_at),
          ),
        )
        .returning({ id: t.chat_lease.session_id }),
    );
    return rows.length === 1;
  }

  /** Claim a domain mutation after locking the parent session row. */
  async claimMutationLease(sid: string, opts: ClaimMutationLeaseOpts): Promise<boolean> {
    const { owner, kind, now, ttl } = opts;
    if (!owner || !kind || ttl <= 0) {
      throw new ValueError("mutation lease owner/kind 不能为空且 ttl 必须大于 0");
    }
    return this.engine.begin(async (conn) => {
      // See ``claimBuildLease``: this must be a write, not FOR UPDATE, so two
      // aiosqlite connections cannot both pass their precondition snapshot.
      const cur = await conn.db
        .update(t.session)
        .set({ state_version: sql`${t.session.state_version}` })
        .where(eq(t.session.id, sid))
        .returning({ status: t.session.status });
      const status = cur[0] === undefined ? null : txt(asRec(cur[0]), "status");
      if (status === null || BUILD_ACTIVE.includes(status as "queued")) return false;
      const liveBuild = await conn.db
        .select({ id: t.build_lease.session_id })
        .from(t.build_lease)
        .where(
          and(
            eq(t.build_lease.session_id, sid),
            gt(t.build_lease.expires_at, now),
            isNull(t.build_lease.cancel_requested_at),
          ),
        );
      if (liveBuild.length > 0) return false;
      const liveOtherChat = await conn.db
        .select({ id: t.chat_lease.session_id })
        .from(t.chat_lease)
        .where(
          and(
            eq(t.chat_lease.session_id, sid),
            ne(t.chat_lease.owner, owner),
            gt(t.chat_lease.expires_at, now),
            isNull(t.chat_lease.cancel_requested_at),
          ),
        );
      if (liveOtherChat.length > 0) return false;
      await conn.db
        .delete(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), lte(t.mutation_lease.expires_at, now)));
      const exists = await conn.db
        .select({ id: t.mutation_lease.session_id })
        .from(t.mutation_lease)
        .where(eq(t.mutation_lease.session_id, sid));
      if (exists.length > 0) return false;
      await conn.db.insert(t.mutation_lease).values({
        session_id: sid,
        owner,
        kind,
        acquired_at: now,
        heartbeat_at: now,
        expires_at: now + ttl,
      });
      return true;
    });
  }

  async renewMutationLease(sid: string, opts: LeaseRenewOpts): Promise<boolean> {
    const { owner, now, ttl } = opts;
    if (ttl <= 0) throw new ValueError("mutation lease ttl 必须大于 0");
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.mutation_lease)
        .set({ heartbeat_at: now, expires_at: now + ttl })
        .where(
          and(
            eq(t.mutation_lease.session_id, sid),
            eq(t.mutation_lease.owner, owner),
            gt(t.mutation_lease.expires_at, now),
          ),
        )
        .returning({ id: t.mutation_lease.session_id }),
    );
    return rows.length === 1;
  }

  async releaseMutationLease(sid: string, opts: LeaseOwnerOpts): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.mutation_lease)
        .where(and(eq(t.mutation_lease.session_id, sid), eq(t.mutation_lease.owner, opts.owner)))
        .returning({ id: t.mutation_lease.session_id }),
    );
    return rows.length === 1;
  }

  /** 删会话。子表靠 ON DELETE CASCADE 跟着走。
   *
   * 显式删子表而不是只信赖 CASCADE 是没必要的重复，但**依赖 CASCADE 就必须
   * 确认外键真的声明了它** —— 没声明的话这里删完，子表里全是指向不存在会话的
   * 孤儿行，而且要等到下一次 JOIN 才会暴露。 */
  async deleteSession(sid: string): Promise<boolean> {
    return this.engine.begin(async (conn) => {
      // SQLite 测试默认不启用 foreign_keys；显式删除三张新领域表，避免行为
      // 和 Postgres 的 ON DELETE CASCADE 分叉。
      await conn.db.delete(t.decision_record).where(eq(t.decision_record.session_id, sid));
      await conn.db.delete(t.revision_record).where(eq(t.revision_record.session_id, sid));
      await conn.db.delete(t.question_item).where(eq(t.question_item.session_id, sid));
      const gone = await conn.db
        .delete(t.session)
        .where(eq(t.session.id, sid))
        .returning({ id: t.session.id });
      return gone.length > 0;
    });
  }

  // ── 文件 ─────────────────────────────────────────────────────
  async addFiles(sid: string, files: readonly FileRow[]): Promise<FileRow[]> {
    await this.engine.begin(async (conn) => {
      for (const f of files) {
        await conn.db
          .insert(t.session_file)
          .values({
            session_id: sid,
            name: f.name,
            rel_path: f.rel_path,
            size_bytes: f.size,
            sha256: f.sha256,
          })
          .onConflictDoUpdate({
            target: [t.session_file.session_id, t.session_file.name],
            set: { rel_path: f.rel_path, size_bytes: f.size, sha256: f.sha256 },
          });
      }
    });
    return this.listFiles(sid);
  }

  async listFiles(sid: string): Promise<FileRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select()
        .from(t.session_file)
        .where(eq(t.session_file.session_id, sid))
        .orderBy(asc(t.session_file.uploaded_at), asc(t.session_file.name)),
    );
    return rows.map((raw) => {
      const r = asRec(raw);
      return makeFileRow({
        name: txt(r, "name"),
        rel_path: txt(r, "rel_path"),
        size: int(r, "size_bytes"),
        sha256: txt(r, "sha256"),
      });
    });
  }

  /** 撤掉一份材料。返回是否真的删到了 —— 删不存在的不是错误，但要如实回答。 */
  async removeFile(sid: string, name: string): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.session_file)
        .where(and(eq(t.session_file.session_id, sid), eq(t.session_file.name, name)))
        .returning({ name: t.session_file.name }),
    );
    return rows.length > 0;
  }

  // ── 状态 ─────────────────────────────────────────────────────

  /** `saveState` 家族共用的后半段：state 文档逐键 upsert + 整代冲突替换。
   *
   * Python 侧这段在四个方法里各写了一遍（逐字相同）。抽出来是为了让
   * "`conflicts is None` 表示不动冲突表、`[]` 才是清空" 这条只存在一处 ——
   * 四份手抄里漏掉一处的症状是"只存 docs 的那条路径顺手把整代冲突抹掉"。 */
  private async writeDocs(
    conn: Conn,
    sid: string,
    docs: JsonObject,
    ver: number,
    opts: SaveStateOpts,
  ): Promise<void> {
    for (const [key, doc] of Object.entries(docs)) {
      const derived = DERIVED_KEYS.has(key);
      await conn.db
        .insert(t.session_state)
        .values({ session_id: sid, key, doc, version: ver, derived })
        .onConflictDoUpdate({
          target: [t.session_state.session_id, t.session_state.key],
          set: { doc, version: ver, derived },
        });
    }
    const conflicts = opts.conflicts ?? null;
    if (conflicts === null) return;
    // 整代替换。人的决定在 decision 表里，不受影响 —— 这就是把
    // answered 从 s.state 挪走的意义。
    await conn.db.delete(t.conflict).where(eq(t.conflict.session_id, sid));
    const ranks = new Map<string, number>();
    (opts.askedRids ?? []).forEach((rid, i) => {
      if (!ranks.has(rid)) ranks.set(rid, i);
    });
    const rows = conflicts.map((c) => {
      const rid = reqStr(c, "rid");
      const subjects = c["subjects"];
      const owner = c["owner"];
      return {
        session_id: sid,
        rid,
        kind: reqStr(c, "kind"),
        handling: reqStr(c, "handling"),
        summary: getStr(c, "summary"),
        subjects: Array.isArray(subjects) && subjects.length > 0 ? subjects : [],
        detector: getStr(c, "detector", "rule"),
        owner: typeof owner === "string" ? owner : null,
        doc: c,
        asked: ranks.has(rid),
        ask_rank: ranks.get(rid) ?? null,
        version: ver,
      };
    });
    // 464 条一次 executemany —— 逐条 INSERT 是 464 次 round-trip。
    for (const part of chunk(rows, CONFLICT_CHUNK)) {
      await conn.db.insert(t.conflict).values(part);
    }
  }

  /** 一次 mutation 一个事务：state 文档 + 整代冲突一起落，版本号一起推进。
   *
   * 这是**唯一**的状态写入口。s.state["oir"] 与 s.state["_oir"] 的漂移就来自
   * "有的路径刷、有的路径不刷"，只留一个入口才能从结构上杜绝。 */
  async saveState(sid: string, docs: JsonObject, opts?: SaveStateOpts): Promise<number | null> {
    const o = opts ?? {};
    return this.engine.begin(async (conn) => {
      // 行锁 + 自增：并发的两次 saveState 拿到不同版本号，后者可见前者。
      // ``expectedVersion`` turns this into compare-and-swap.  PostgreSQL
      // serializes concurrent UPDATEs on the row and rechecks the predicate;
      // SQLite serializes writers, so exactly one stale snapshot can commit.
      const where: (SQL | undefined)[] = [eq(t.session.id, sid)];
      const ev = o.expectedVersion ?? null;
      if (ev !== null) where.push(eq(t.session.state_version, ev));
      const got = await conn.db
        .update(t.session)
        .set({ state_version: sql`${t.session.state_version} + 1` })
        .where(and(...where))
        .returning({ v: t.session.state_version });
      if (got[0] === undefined) return null;
      const ver = int(asRec(got[0]), "v");
      await this.writeDocs(conn, sid, docs, ver, o);
      return ver;
    });
  }

  /** Commit a domain projection only for the live invocation owner. */
  async saveMutationState(
    sid: string,
    docs: JsonObject,
    opts: SaveMutationStateOpts,
  ): Promise<number | null> {
    const { owner, now } = opts;
    return this.engine.begin(async (conn) => {
      const ownsLiveLease = sql`exists (select 1 from ${t.mutation_lease} where ${and(
        eq(t.mutation_lease.session_id, sid),
        eq(t.mutation_lease.owner, owner),
        gt(t.mutation_lease.expires_at, now),
      )})`;
      const where: (SQL | undefined)[] = [eq(t.session.id, sid), ownsLiveLease];
      if (opts.chatOwner) {
        const ownsLiveChat = sql`exists (select 1 from ${t.chat_lease} where ${and(
          eq(t.chat_lease.session_id, sid),
          eq(t.chat_lease.owner, opts.chatOwner),
          isNull(t.chat_lease.cancel_requested_at),
          gt(t.chat_lease.expires_at, now),
        )})`;
        where.push(ownsLiveChat);
      }
      const ev = opts.expectedVersion ?? null;
      if (ev !== null) where.push(eq(t.session.state_version, ev));
      const got = await conn.db
        .update(t.session)
        .set({
          status: opts.status,
          error: opts.error ?? "",
          state_version: sql`${t.session.state_version} + 1`,
        })
        .where(and(...where))
        .returning({ v: t.session.state_version });
      if (got[0] === undefined) return null;
      const ver = int(asRec(got[0]), "v");
      await this.writeDocs(conn, sid, docs, ver, opts);
      return ver;
    });
  }

  /** Atomically fence and persist one build checkpoint.
   *
   * Status, state documents and the conflict generation share the same transaction;
   * a stopped/stale invocation therefore cannot write documents and only then learn
   * that it lost ownership. */
  async saveBuildState(
    sid: string,
    docs: JsonObject,
    opts: SaveBuildStateOpts,
  ): Promise<number | null> {
    const { owner, now } = opts;
    return this.engine.begin(async (conn) => {
      const ownsLiveLease = sql`exists (select 1 from ${t.build_lease} where ${and(
        eq(t.build_lease.session_id, sid),
        eq(t.build_lease.owner, owner),
        isNull(t.build_lease.cancel_requested_at),
        gt(t.build_lease.expires_at, now),
      )})`;
      const where: (SQL | undefined)[] = [
        eq(t.session.id, sid),
        inArray(t.session.status, [...BUILD_ACTIVE]),
        ownsLiveLease,
      ];
      const ev = opts.expectedVersion ?? null;
      if (ev !== null) where.push(eq(t.session.state_version, ev));
      const got = await conn.db
        .update(t.session)
        .set({
          status: opts.status,
          error: opts.error ?? "",
          state_version: sql`${t.session.state_version} + 1`,
        })
        .where(and(...where))
        .returning({ v: t.session.state_version });
      if (got[0] === undefined) return null;
      const ver = int(asRec(got[0]), "v");
      await this.writeDocs(conn, sid, docs, ver, opts);
      return ver;
    });
  }

  /** Atomically fence and persist one chat mutation.
   *
   * Checking the lease and advancing ``state_version`` happen in the same
   * transaction.  A chat coroutine that outlived its lease (expiry, takeover or
   * durable ``/stop``) therefore cannot overwrite the next worker's projection. */
  async saveChatState(
    sid: string,
    docs: JsonObject,
    opts: SaveChatStateOpts,
  ): Promise<number | null> {
    const { owner, now } = opts;
    return this.engine.begin(async (conn) => {
      const ownsLiveLease = sql`exists (select 1 from ${t.chat_lease} where ${and(
        eq(t.chat_lease.session_id, sid),
        eq(t.chat_lease.owner, owner),
        isNull(t.chat_lease.cancel_requested_at),
        gt(t.chat_lease.expires_at, now),
      )})`;
      const where: (SQL | undefined)[] = [eq(t.session.id, sid), ownsLiveLease];
      const ev = opts.expectedVersion ?? null;
      if (ev !== null) where.push(eq(t.session.state_version, ev));
      const got = await conn.db
        .update(t.session)
        .set({ state_version: sql`${t.session.state_version} + 1` })
        .where(and(...where))
        .returning({ v: t.session.state_version });
      if (got[0] === undefined) return null;
      const ver = int(asRec(got[0]), "v");
      await this.writeDocs(conn, sid, docs, ver, opts);
      return ver;
    });
  }

  async loadState(sid: string, opts?: LoadStateOpts): Promise<JsonObject> {
    const keys = opts?.keys ?? null;
    const includeDerived = opts?.includeDerived ?? true;
    // `key IN ()` 在 SQLAlchemy 那边渲染成恒假，这里显式短路（drizzle 的
    // `inArray(col, [])` 不保证同样的渲染）。
    if (keys !== null && keys.length === 0) return {};
    const rows = await this.engine.connect(async (conn) => {
      const where: (SQL | undefined)[] = [eq(t.session_state.session_id, sid)];
      if (keys !== null) where.push(inArray(t.session_state.key, [...keys]));
      if (!includeDerived) where.push(eq(t.session_state.derived, false));
      return conn.db
        .select({ key: t.session_state.key, doc: t.session_state.doc })
        .from(t.session_state)
        .where(and(...where));
    });
    const out: Record<string, JsonValue> = {};
    for (const raw of rows) {
      const r = asRec(raw);
      out[txt(r, "key")] = (r["doc"] ?? null) as JsonValue;
    }
    return out;
  }

  async listConflicts(sid: string): Promise<JsonObject[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select({ doc: t.conflict.doc, rid: t.conflict.rid })
        .from(t.conflict)
        .where(eq(t.conflict.session_id, sid))
        // `.nulls_last()`：SQLite 默认 NULL 排在最前，PG 默认排在最后 —— 不写死
        // 就是两个方言两种顺序。SQLite 3.30+ / PG 都支持 NULLS LAST 语法。
        .orderBy(sql`${t.conflict.ask_rank} nulls last`, asc(t.conflict.rid)),
    );
    return rows.map((raw) => jsonObj(asRec(raw)["doc"]));
  }

  async getConflict(sid: string, rid: string): Promise<JsonObject | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select({ doc: t.conflict.doc })
        .from(t.conflict)
        .where(and(eq(t.conflict.session_id, sid), eq(t.conflict.rid, rid))),
    );
    return rows[0] === undefined ? null : jsonObj(asRec(rows[0])["doc"]);
  }

  // ── 决定 ─────────────────────────────────────────────────────

  /** append-only。推翻旧决定与写入新决定必须在同一事务里 ——
   * 否则 `decision_live_answer_uq` 会在中间态上炸。 */
  async recordDecision(sid: string, d: DecisionRow): Promise<DecisionRow> {
    const ts = d.ts || nowSec();
    return this.engine.begin(async (conn) => {
      // 发号走 session 上的计数器（行锁），不是 MAX(ordinal)+1：
      //   * 不加锁的 MAX+1 在并发下会重号，撞 decision 的主键；
      //   * `SELECT max(...) FOR UPDATE` 在 Postgres 上直接报
      //     "FOR UPDATE is not allowed with aggregate functions"。
      // 和 next_event_seq / next_run_ordinal 是同一套手法。
      const got = await conn.db
        .update(t.session)
        .set({ next_decision_ordinal: sql`${t.session.next_decision_ordinal} + 1` })
        .where(eq(t.session.id, sid))
        .returning({ n: t.session.next_decision_ordinal });
      if (got[0] === undefined) throw new Error(`没有会话 ${sid}`);
      const ordinal = int(asRec(got[0]), "n") - 1;
      const out = makeDecisionRow({ ...d, ordinal, ts });

      if (d.kind === "answer") {
        await conn.db
          .update(t.decision)
          .set({ superseded_by: ordinal })
          .where(
            and(
              eq(t.decision.session_id, sid),
              isNull(t.decision.superseded_by),
              eq(t.decision.kind, d.kind),
              eq(t.decision.target_rid, d.target_rid),
            ),
          );
      } else {
        // 见文件头 §分叉 3：scope_refs 的相等判据放在应用侧，不发给数据库。
        const cands = await conn.db
          .select({ ordinal: t.decision.ordinal, scope_refs: t.decision.scope_refs })
          .from(t.decision)
          .where(
            and(
              eq(t.decision.session_id, sid),
              isNull(t.decision.superseded_by),
              eq(t.decision.kind, d.kind),
            ),
          );
        const want = [...d.scope_refs];
        const hit = cands
          .map((raw) => asRec(raw))
          .filter((r) => arrayEq(strList(r["scope_refs"]), want))
          .map((r) => int(r, "ordinal"));
        if (hit.length > 0) {
          await conn.db
            .update(t.decision)
            .set({ superseded_by: ordinal })
            .where(and(eq(t.decision.session_id, sid), inArray(t.decision.ordinal, hit)));
        }
      }

      await conn.db.insert(t.decision).values({
        session_id: sid,
        ordinal,
        kind: out.kind,
        statement: out.statement,
        scope_refs: [...out.scope_refs],
        turn_index: out.turn_index,
        superseded_by: null,
        target_rid: out.target_rid,
        option_id: out.option_id,
        changed: [...out.changed],
        note: out.note,
        ts: out.ts,
      });
      return out;
    });
  }

  async listDecisions(sid: string, opts?: ListDecisionsOpts): Promise<DecisionRow[]> {
    const activeOnly = opts?.activeOnly ?? false;
    const rows = await this.engine.connect(async (conn) => {
      const where: (SQL | undefined)[] = [eq(t.decision.session_id, sid)];
      if (activeOnly) where.push(isNull(t.decision.superseded_by));
      return conn.db
        .select()
        .from(t.decision)
        .where(and(...where))
        .orderBy(asc(t.decision.ordinal));
    });
    return rows.map((raw) => {
      const r = asRec(raw);
      return makeDecisionRow({
        ordinal: int(r, "ordinal"),
        kind: txt(r, "kind"),
        statement: txt(r, "statement"),
        scope_refs: strList(r["scope_refs"]),
        turn_index: int(r, "turn_index"),
        superseded_by: intOrNull(r, "superseded_by"),
        target_rid: txt(r, "target_rid"),
        option_id: txt(r, "option_id"),
        changed: jsonList(r["changed"]),
        note: txt(r, "note"),
        ts: flt(r, "ts"),
      });
    });
  }

  async answeredRids(sid: string): Promise<Set<string>> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select({ rid: t.decision.target_rid })
        .from(t.decision)
        .where(
          and(
            eq(t.decision.session_id, sid),
            eq(t.decision.kind, "answer"),
            isNull(t.decision.superseded_by),
            ne(t.decision.target_rid, ""),
          ),
        ),
    );
    return new Set(rows.map((raw) => txt(asRec(raw), "rid")));
  }

  // ── Question / Decision / Revision v1 ──────────────────────
  async upsertQuestions(sid: string, rows: readonly QuestionRow[]): Promise<QuestionRow[]> {
    await this.engine.begin(async (conn) => {
      for (const row of rows) {
        const now = nowSec();
        const created = this.tstz(row.created || now);
        const updated = this.tstz(row.updated || now);
        const mutable = {
          text: row.text,
          status: row.status,
          owner_user_id: row.owner_user_id,
          audience_role: row.audience_role,
          answer_schema: row.answer_schema,
          priority: row.priority,
          dependencies: [...row.dependencies],
          blocked_artifacts: [...row.blocked_artifacts],
          source_kind: row.source_kind,
          source_ref: row.source_ref,
          doc: row.doc,
          version: row.version,
          updated_at: updated,
        };
        await conn.db
          .insert(t.question_item)
          .values({ session_id: sid, id: row.id, created_at: created, ...mutable })
          .onConflictDoUpdate({
            target: [t.question_item.session_id, t.question_item.id],
            set: mutable,
          });
      }
    });
    return this.listQuestions(sid);
  }

  /** 单行 CAS；问题工作台不能用 bulk upsert 覆盖并发人工回答。 */
  async saveQuestion(
    sid: string,
    row: QuestionRow,
    opts?: ExpectedVersionOpts,
  ): Promise<QuestionRow> {
    const expected = opts?.expectedVersion ?? null;
    const now = nowSec();
    const base = {
      text: row.text,
      status: row.status,
      owner_user_id: row.owner_user_id,
      audience_role: row.audience_role,
      answer_schema: row.answer_schema,
      priority: row.priority,
      dependencies: [...row.dependencies],
      blocked_artifacts: [...row.blocked_artifacts],
      source_kind: row.source_kind,
      source_ref: row.source_ref,
    };
    return this.engine.begin(async (conn) => {
      const key = and(eq(t.question_item.session_id, sid), eq(t.question_item.id, row.id));
      if (expected === null) {
        const existing = await conn.db
          .select({ version: t.question_item.version })
          .from(t.question_item)
          .where(key);
        const values = {
          ...base,
          doc: row.doc,
          updated_at: this.tstz(row.updated || now),
        };
        if (existing[0] === undefined) {
          await conn.db.insert(t.question_item).values({
            session_id: sid,
            id: row.id,
            version: row.version,
            created_at: this.tstz(row.created || now),
            ...values,
          });
        } else {
          await conn.db
            .update(t.question_item)
            .set({ version: row.version, ...values })
            .where(key);
        }
        return row;
      }
      const version = expected + 1;
      const updated = row.updated || now;
      const doc: JsonObject = { ...row.doc, version, updatedAt: updated };
      const out = makeQuestionRow({ ...row, version, updated, doc });
      const result = await conn.db
        .update(t.question_item)
        .set({
          ...base,
          doc,
          updated_at: this.tstz(updated),
          version,
        })
        .where(and(key, eq(t.question_item.version, expected)))
        .returning({ id: t.question_item.id });
      if (result.length === 0) {
        const actualRows = await conn.db
          .select({ version: t.question_item.version })
          .from(t.question_item)
          .where(key);
        const actual = actualRows[0] === undefined ? null : int(asRec(actualRows[0]), "version");
        throw new RevisionConflict(
          `问题 ${row.id} 预期 version ${expected}，实际是 ${actual === null ? "None" : actual}`,
        );
      }
      return out;
    });
  }

  async listQuestions(sid: string, opts?: ListQuestionsOpts): Promise<QuestionRow[]> {
    const statuses = opts?.statuses ?? null;
    if (statuses !== null && statuses.length === 0) return [];
    const rows = await this.engine.connect(async (conn) => {
      const where: (SQL | undefined)[] = [eq(t.question_item.session_id, sid)];
      if (statuses !== null) where.push(inArray(t.question_item.status, [...statuses]));
      return conn.db
        .select()
        .from(t.question_item)
        .where(and(...where))
        .orderBy(asc(t.question_item.created_at), asc(t.question_item.id));
    });
    return rows.map((raw) => questionRow(asRec(raw)));
  }

  async getQuestion(sid: string, qid: string): Promise<QuestionRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select()
        .from(t.question_item)
        .where(and(eq(t.question_item.session_id, sid), eq(t.question_item.id, qid))),
    );
    return rows[0] === undefined ? null : questionRow(asRec(rows[0]));
  }

  async recordDecisionV1(
    sid: string,
    row: DecisionRecordRow,
  ): Promise<readonly [DecisionRecordRow, boolean]> {
    if (!row.idempotency_key) throw new ValueError("Decision 必须提供 idempotency_key");
    return this.engine.begin(async (conn) => {
      // Postgres 上按 session 串行化 claim，避免两个 worker 同时看到
      // "无 active decision" 后插入同一内容哈希主键。SQLite 会忽略
      // FOR UPDATE，其写事务仍会串行化。
      // PG-FOR-UPDATE：接 PG 驱动时这条 SELECT 要加 `FOR UPDATE`。
      await conn.db.select({ id: t.session.id }).from(t.session).where(eq(t.session.id, sid));
      const existing = await conn.db
        .select()
        .from(t.decision_record)
        .where(
          and(
            eq(t.decision_record.session_id, sid),
            eq(t.decision_record.idempotency_key, row.idempotency_key),
          ),
        );
      if (existing[0] !== undefined) {
        const prior = decisionRecordRow(asRec(existing[0]));
        if (prior.semantic_hash !== row.semantic_hash) {
          // `{key!r}` == Python 的 repr(str)，复用 errors.ts 那份（已做到零差异）。
          throw new IdempotencyConflict(`幂等键 ${pyRepr(row.idempotency_key)} 已用于另一份回答`);
        }
        return [prior, false] as const;
      }

      // 当前有效记录 = 没有被同问题的另一行 supersedes 指向的记录。
      const rows = await conn.db
        .select()
        .from(t.decision_record)
        .where(
          and(
            eq(t.decision_record.session_id, sid),
            eq(t.decision_record.question_id, row.question_id),
          ),
        )
        .orderBy(asc(t.decision_record.created_at));
      const priorRows = rows.map((raw) => decisionRecordRow(asRec(raw)));
      const active = activeDecisionV1(priorRows, row.question_id);
      if (active !== null && active.semantic_hash === row.semantic_hash) {
        return [active, false] as const;
      }
      const out = makeDecisionRecordRow({
        ...row,
        supersedes: active !== null ? active.id : row.supersedes,
        created: row.created || nowSec(),
      });
      await conn.db.insert(t.decision_record).values({
        session_id: sid,
        id: out.id,
        question_id: out.question_id,
        answer: out.answer,
        actor: out.actor,
        actor_role: out.actor_role,
        authority: out.authority,
        source_turn: out.source_turn,
        affected_ids: [...out.affected_ids],
        supersedes: out.supersedes,
        revision: out.revision,
        idempotency_key: out.idempotency_key,
        semantic_hash: out.semantic_hash,
        rationale: out.rationale,
        metadata: out.metadata,
        created_at: this.tstz(out.created),
      });
      return [out, true] as const;
    });
  }

  async finalizeDecisionV1(
    sid: string,
    decisionId: string,
    opts: FinalizeDecisionOpts,
  ): Promise<DecisionRecordRow> {
    const { status } = opts;
    const error = opts.error ?? "";
    if (status !== "applied" && status !== "failed") {
      throw new ValueError(`不支持的 Decision 终态: ${status}`);
    }
    return this.engine.begin(async (conn) => {
      const key = and(eq(t.decision_record.session_id, sid), eq(t.decision_record.id, decisionId));
      // PG-FOR-UPDATE：接 PG 驱动时这条 SELECT 要加 `FOR UPDATE`。
      const raw = await conn.db.select().from(t.decision_record).where(key);
      if (raw[0] === undefined) throw new Error(`没有 Decision ${decisionId}`);
      const row = decisionRecordRow(asRec(raw[0]));
      const current = String(row.metadata["status"] || "applied");
      if ((current === "applied" || current === "failed") && current !== status) {
        throw new ValueError(`Decision ${decisionId} 已是 ${current}，不能改为 ${status}`);
      }
      const metadata: Record<string, JsonValue> = { ...row.metadata, status };
      if (error) metadata["error"] = error;
      else delete metadata["error"];
      // updated_at 未单独加列；终态时间放 metadata，保持 append-only 表主结构。
      metadata["finalizedAt"] = nowSec();
      await conn.db.update(t.decision_record).set({ metadata }).where(key);
      return makeDecisionRecordRow({ ...row, metadata });
    });
  }

  async listDecisionsV1(sid: string): Promise<DecisionRecordRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select()
        .from(t.decision_record)
        .where(eq(t.decision_record.session_id, sid))
        .orderBy(asc(t.decision_record.created_at), asc(t.decision_record.id)),
    );
    return rows.map((raw) => decisionRecordRow(asRec(raw)));
  }

  async recordRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]> {
    return this.engine.begin(async (conn) => {
      if (row.idempotency_key) {
        const existing = await conn.db
          .select()
          .from(t.revision_record)
          .where(
            and(
              eq(t.revision_record.session_id, sid),
              eq(t.revision_record.idempotency_key, row.idempotency_key),
            ),
          );
        if (existing[0] !== undefined) {
          const prior = revisionRow(asRec(existing[0]));
          if (JSON.stringify(prior.doc) !== JSON.stringify(row.doc)) {
            throw new IdempotencyConflict(`幂等键 ${pyRepr(row.idempotency_key)} 已用于另一个 revision`);
          }
          return [prior, false] as const;
        }
      }
      const out = makeRevisionRow({ ...row, created: row.created || nowSec() });
      await this.insertRevision(conn, sid, out);
      return [out, true] as const;
    });
  }

  /** Postgres/SQLite 统一的原子 Revision 发号。 */
  async appendRevision(sid: string, row: RevisionRow): Promise<readonly [RevisionRow, boolean]> {
    return this.engine.begin(async (conn) => {
      // 与 Decision claim 使用同一 session 行串行化，不用 MAX+1 竞态。
      // PG-FOR-UPDATE：接 PG 驱动时这条 SELECT 要加 `FOR UPDATE`。
      await conn.db.select({ id: t.session.id }).from(t.session).where(eq(t.session.id, sid));
      if (row.idempotency_key) {
        const existing = await conn.db
          .select()
          .from(t.revision_record)
          .where(
            and(
              eq(t.revision_record.session_id, sid),
              eq(t.revision_record.idempotency_key, row.idempotency_key),
            ),
          );
        if (existing[0] !== undefined) return [revisionRow(asRec(existing[0])), false] as const;
      }
      const prior = await conn.db
        .select({ id: t.revision_record.id, ordinal: t.revision_record.ordinal })
        .from(t.revision_record)
        .where(eq(t.revision_record.session_id, sid))
        .orderBy(desc(t.revision_record.ordinal))
        .limit(1);
      const p = prior[0] === undefined ? null : asRec(prior[0]);
      const ordinal = p === null ? 1 : int(p, "ordinal") + 1;
      const parent = p === null ? null : txt(p, "id");
      const id = `rev.${ordinal}`;
      const doc: JsonObject = { ...row.doc, id, ordinal, parentId: parent };
      const out = makeRevisionRow({
        ...row,
        id,
        ordinal,
        parent_id: parent,
        doc,
        created: row.created || nowSec(),
      });
      await this.insertRevision(conn, sid, out);
      return [out, true] as const;
    });
  }

  private async insertRevision(conn: Conn, sid: string, row: RevisionRow): Promise<void> {
    await conn.db.insert(t.revision_record).values({
      session_id: sid,
      id: row.id,
      ordinal: row.ordinal,
      parent_id: row.parent_id,
      kind: row.kind,
      status: row.status,
      patch_set: row.patch_set,
      changed_ids: [...row.changed_ids],
      invalidated_artifacts: [...row.invalidated_artifacts],
      actor: row.actor,
      source_turn: row.source_turn,
      snapshot_hash: row.snapshot_hash,
      idempotency_key: row.idempotency_key,
      doc: row.doc,
      created_at: this.tstz(row.created),
    });
  }

  /** Atomically move ``proposed`` to one terminal artifact state. */
  async finalizeRevision(
    sid: string,
    revisionId: string,
    opts: FinalizeRevisionOpts,
  ): Promise<RevisionRow> {
    const { status } = opts;
    if (status !== "applied" && status !== "rejected" && status !== "rolled_back") {
      throw new ValueError(`不支持的 Revision 终态: ${status}`);
    }
    return this.engine.begin(async (conn) => {
      const key = and(eq(t.revision_record.session_id, sid), eq(t.revision_record.id, revisionId));
      const raw = await conn.db.select().from(t.revision_record).where(key);
      if (raw[0] === undefined) throw new Error(`没有 Revision ${revisionId}`);
      const row = revisionRow(asRec(raw[0]));
      const terminalDoc: JsonObject = { ...row.doc, status };
      const updated = await conn.db
        .update(t.revision_record)
        .set({ status, doc: terminalDoc })
        .where(and(key, eq(t.revision_record.status, "proposed")))
        .returning();
      if (updated[0] !== undefined) return revisionRow(asRec(updated[0]));

      // SQLite ignores ``FOR UPDATE``.  The guarded UPDATE above is the actual
      // arbitration point, so two terminal writers cannot both succeed.  Read
      // back the winner to make same-status retries idempotent and reject a
      // conflicting terminal transition.
      const current = await conn.db.select().from(t.revision_record).where(key);
      if (current[0] === undefined) throw new Error(`没有 Revision ${revisionId}`);
      const terminal = revisionRow(asRec(current[0]));
      if (terminal.status !== status) {
        throw new ValueError(`Revision ${revisionId} 已是 ${terminal.status}，不能改为 ${status}`);
      }
      return terminal;
    });
  }

  async listRevisions(sid: string): Promise<RevisionRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select()
        .from(t.revision_record)
        .where(eq(t.revision_record.session_id, sid))
        .orderBy(asc(t.revision_record.ordinal)),
    );
    return rows.map((raw) => revisionRow(asRec(raw)));
  }

  // ── 事件 ─────────────────────────────────────────────────────

  /** 发号 + 落行一个事务。seq 由 session.next_event_seq 的行锁保证唯一 ——
   * `len(self.events)`（server.py:109）在多 worker 下必然重号。 */
  async appendEvent(
    sid: string,
    kind: string,
    payload: JsonObject,
    opts?: AppendEventOpts,
  ): Promise<EventRow> {
    const eventId = opts?.eventId ?? "";
    let blobRef: string | null = null;
    // `json.dumps(payload, ensure_ascii=False, default=str)` 的对应物 —— 用
    // journal.ts 那份 Python 记号的 dumps 而不是 JSON.stringify：字节数决定要不要
    // 落 blob，而 blob 的 ref 是这段字节的 sha256，两边必须逐字节相同。
    const raw = pyJsonDumps(payload, { defaultStr: true });
    const rawBytes = Buffer.from(raw, "utf8");
    // The row returned to the publisher is also the live SSE projection.  Keep
    // that projection in the same JSON-normalised shape that ``readEvents``
    // will reconstruct after a reconnect; only the database representation may
    // be replaced by a blob reference.
    const committedPayload = JSON.parse(raw) as JsonObject;
    let storedPayload: JsonObject = committedPayload;
    if (rawBytes.length > EVENT_INLINE_LIMIT) {
      // 大 payload 落 blob。单条 node.completed node=CONFLICT 实测 235 KB，
      // 而那份内容 conflict 表里已经有了 —— 事件流不该是第二个副本。
      blobRef = await this.putBlob(rawBytes);
      storedPayload = { _ref: blobRef, _bytes: rawBytes.length };
    }
    const ts = nowSec();
    return this.engine.begin(async (conn) => {
      // Lock the owning session before checking event_id.  This serialises
      // same-session producers on both PostgreSQL and SQLite; a retry can
      // observe a just-committed original before allocating another seq.
      await conn.db
        .update(t.session)
        .set({ next_event_seq: sql`${t.session.next_event_seq}` })
        .where(eq(t.session.id, sid));
      if (eventId) {
        const prior = await conn.db
          .select()
          .from(t.session_event)
          .where(eq(t.session_event.event_id, eventId));
        if (prior[0] !== undefined) {
          const r = asRec(prior[0]);
          const ref = txtOrNull(r, "ref");
          const priorPayload =
            ref === null
              ? jsonObj(r["payload"])
              : (JSON.parse(Buffer.from(await this.getBlob(conn, ref)).toString("utf8")) as JsonObject);
          return {
            seq: int(r, "seq"),
            kind: txt(r, "kind"),
            payload: priorPayload,
            ts: flt(r, "ts"),
            event_id: txtOrEmpty(r, "event_id"),
          };
        }
      }
      // **计数器可能落在已提交行的后面，这时不能信它。** 一旦如此，分配出来
      // 的 seq 会撞 UNIQUE 约束，而重试永远撞同一个号 —— 这个会话从此再也
      // 写不进任何事件，界面上表现为"消息要刷新才出现"。历史上文件库跑在
      // StaticPool 上（见 engine.py）就把计数器搅回去过，这些会话即使换了
      // 连接池也还是坏的。所以从**表里的真实最大值**兜一次底，顺手把计数器
      // 修回来 —— 自愈比一条修数据的 SQL 可靠，因为没人会记得去跑那条 SQL。
      const usedRows = await conn.db
        .select({ m: sql<number | null>`max(${t.session_event.seq})` })
        .from(t.session_event)
        .where(eq(t.session_event.session_id, sid));
      const usedRaw = usedRows[0] === undefined ? null : asRec(usedRows[0])["m"];
      const used = usedRaw === null || usedRaw === undefined ? null : Math.trunc(Number(usedRaw));
      const nxtRows = await conn.db
        .select({ n: t.session.next_event_seq })
        .from(t.session)
        .where(eq(t.session.id, sid));
      if (nxtRows[0] === undefined) throw new Error(`没有会话 ${sid}`);
      const nxt = int(asRec(nxtRows[0]), "n");
      const seq = Math.max(nxt, used === null ? 0 : used + 1);
      await conn.db
        .update(t.session)
        .set({ next_event_seq: seq + 1 })
        .where(eq(t.session.id, sid));
      await conn.db.insert(t.session_event).values({
        session_id: sid,
        seq,
        kind,
        payload: storedPayload,
        ref: blobRef,
        ts,
        event_id: emptyToNull(eventId),
      });
      return { seq, kind, payload: committedPayload, ts, event_id: eventId };
    });
  }

  async readEvents(sid: string, opts?: ReadEventsOpts): Promise<EventRow[]> {
    const since = opts?.since ?? 0;
    const limit = opts?.limit;
    return this.engine.connect(async (conn) => {
      const q = conn.db
        .select()
        .from(t.session_event)
        .where(and(eq(t.session_event.session_id, sid), gte(t.session_event.seq, since)))
        .orderBy(asc(t.session_event.seq))
        .$dynamic();
      // 不传 limit 时**一句 limit 都不拼**，SQL 与加这个字段之前逐字相同。
      const rows = await (limit === undefined ? q : q.limit(limit));
      const out: EventRow[] = [];
      for (const raw of rows) {
        const r = asRec(raw);
        const ref = txtOrNull(r, "ref");
        const payload =
          ref === null
            ? jsonObj(r["payload"])
            : (JSON.parse(Buffer.from(await this.getBlob(conn, ref)).toString("utf8")) as JsonObject);
        out.push({
          seq: int(r, "seq"),
          kind: txt(r, "kind"),
          payload,
          ts: flt(r, "ts"),
          event_id: txtOrEmpty(r, "event_id"),
        });
      }
      return out;
    });
  }

  async countEvents(sid: string): Promise<number> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select({ c: sql<number>`count(*)` })
        .from(t.session_event)
        .where(eq(t.session_event.session_id, sid)),
    );
    return rows[0] === undefined ? 0 : int(asRec(rows[0]), "c");
  }

  // ── blob ─────────────────────────────────────────────────────
  private async putBlob(raw: Uint8Array): Promise<string> {
    const ref = contentRef(raw); // == ids.content_ref
    await this.engine.begin(async (conn) => {
      await conn.db
        .insert(t.blob)
        .values({ ref, data: raw, size_bytes: raw.length })
        .onConflictDoNothing({ target: t.blob.ref });
    });
    return ref;
  }

  private async getBlob(conn: Conn, ref: string): Promise<Uint8Array> {
    const rows = await conn.db.select({ data: t.blob.data }).from(t.blob).where(eq(t.blob.ref, ref));
    const v = rows[0] === undefined ? null : asRec(rows[0])["data"];
    if (v === null || v === undefined) throw new Error(`blob 不存在: ${ref}`);
    return v as Uint8Array;
  }

  // ── Run ──────────────────────────────────────────────────────

  /** 分配一个**每次 Run 独立**的 id。
   *
   * `f"run_{s.id}"`（server.py:271）不行 —— 会话 id 不是 run id，同一会话第二次
   * build 会把 seq 从 0 重来撞进同一份日志。(run_id, seq) 上有唯一约束之后那会
   * 直接插入失败，所以这个方法是搬库的**前置条件**，不是可选项。 */
  async nextRun(sid: string, kind: string): Promise<string> {
    return this.engine.begin(async (conn) => {
      const got = await conn.db
        .update(t.session)
        .set({ next_run_ordinal: sql`${t.session.next_run_ordinal} + 1` })
        .where(eq(t.session.id, sid))
        .returning({ n: t.session.next_run_ordinal });
      if (got[0] === undefined) throw new Error(`没有会话 ${sid}`);
      const n = int(asRec(got[0]), "n") - 1;
      const rid = `${sid}.${n}`;
      await conn.db
        .insert(t.run)
        .values({ id: rid, session_id: sid, ordinal: n, kind, status: "running" });
      return rid;
    });
  }

  async finishRun(runId: string, opts: FinishRunOpts): Promise<void> {
    await this.engine.begin(async (conn) => {
      await conn.db
        .update(t.run)
        .set({
          status: opts.status,
          error: opts.error ?? "",
          budget: opts.budget ?? {},
          // `sa.func.now()`：SQLite 上渲染成 CURRENT_TIMESTAMP，PG 上等价于 now()。
          ended_at: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(t.run.id, runId));
    });
  }

  // ── 账号 ─────────────────────────────────────────────────────
  async createUser(row: UserRow): Promise<UserRow> {
    const created = row.created || nowSec();
    const out = makeUserRow({ ...row, created });
    const ts = this.tstz(created);
    try {
      await this.engine.begin(async (conn) => {
        await conn.db.insert(t.app_user).values({
          id: out.id,
          username: out.username,
          display_name: out.display_name,
          password_hash: out.password_hash,
          role: out.role,
          active: out.active,
          prefs: out.prefs,
          created_at: ts,
          updated_at: ts,
        });
      });
    } catch (e) {
      // 用户名 UNIQUE 或 id 主键冲突 —— 和 MemoryRepo 抛同一种异常，
      // 路由层才能统一映射成 409（否则两个实现行为分叉，测试还测不到）。
      if (isIntegrityError(e)) throw new DuplicateUsername(`用户名或 id 已存在: ${out.username}`);
      throw e;
    }
    return out;
  }

  async getUser(uid: string): Promise<UserRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.app_user).where(eq(t.app_user.id, uid)),
    );
    return rows[0] === undefined ? null : userRow(asRec(rows[0]));
  }

  async getUserByUsername(username: string): Promise<UserRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.app_user).where(eq(t.app_user.username, username)),
    );
    return rows[0] === undefined ? null : userRow(asRec(rows[0]));
  }

  async listUsers(): Promise<UserRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.app_user).orderBy(asc(t.app_user.created_at)),
    );
    return rows.map((raw) => userRow(asRec(raw)));
  }

  async countUsers(): Promise<number> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select({ c: sql<number>`count(*)` }).from(t.app_user),
    );
    return rows[0] === undefined ? 0 : int(asRec(rows[0]), "c");
  }

  async updateUser(uid: string, opts?: UpdateUserOpts): Promise<UserRow | null> {
    const vals: Record<string, unknown> = {};
    // 逐个 `if x is not None`：缺席 / null = **这一列不动**，不是置空。
    // 折叠掉这个区分的后果是一次改密码顺手把 role 和 prefs 清掉。
    if (opts?.role !== undefined && opts.role !== null) vals["role"] = opts.role;
    if (opts?.active !== undefined && opts.active !== null) vals["active"] = opts.active;
    if (opts?.passwordHash !== undefined && opts.passwordHash !== null) {
      vals["password_hash"] = opts.passwordHash;
    }
    if (opts?.prefs !== undefined && opts.prefs !== null) vals["prefs"] = opts.prefs;
    if (opts?.displayName !== undefined && opts.displayName !== null) {
      vals["display_name"] = opts.displayName;
    }
    if (Object.keys(vals).length > 0) {
      await this.engine.begin(async (conn) => {
        await conn.db.update(t.app_user).set(vals).where(eq(t.app_user.id, uid));
      });
    }
    return this.getUser(uid);
  }

  async deleteUser(uid: string): Promise<boolean> {
    return this.engine.begin(async (conn) => {
      // 显式先删登录会话再删账号：SQLite 默认不强制外键，不能只靠 CASCADE。
      await conn.db.delete(t.auth_session).where(eq(t.auth_session.user_id, uid));
      const gone = await conn.db
        .delete(t.app_user)
        .where(eq(t.app_user.id, uid))
        .returning({ id: t.app_user.id });
      return gone.length > 0;
    });
  }

  // ── 登录会话 ─────────────────────────────────────────────────
  async createAuthSession(row: AuthSessionRow): Promise<AuthSessionRow> {
    const created = row.created || nowSec();
    const lastSeen = row.last_seen || created;
    const out = makeAuthSessionRow({ ...row, created, last_seen: lastSeen });
    await this.engine.begin(async (conn) => {
      await conn.db.insert(t.auth_session).values({
        token_hash: out.token_hash,
        user_id: out.user_id,
        created_at: this.tstz(out.created),
        last_seen_at: this.tstz(out.last_seen),
        expires_at: this.tstz(out.expires),
      });
    });
    return out;
  }

  async getAuthSession(tokenHash: string): Promise<AuthSessionRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.auth_session).where(eq(t.auth_session.token_hash, tokenHash)),
    );
    return rows[0] === undefined ? null : authRow(asRec(rows[0]));
  }

  async deleteAuthSession(tokenHash: string): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.auth_session)
        .where(eq(t.auth_session.token_hash, tokenHash))
        .returning({ h: t.auth_session.token_hash }),
    );
    return rows.length > 0;
  }

  async deleteUserAuthSessions(uid: string): Promise<number> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.auth_session)
        .where(eq(t.auth_session.user_id, uid))
        .returning({ h: t.auth_session.token_hash }),
    );
    return rows.length;
  }

  async pruneAuthSessions(opts: NowOpts): Promise<number> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .delete(t.auth_session)
        .where(lte(t.auth_session.expires_at, this.tstz(opts.now)))
        .returning({ h: t.auth_session.token_hash }),
    );
    return rows.length;
  }

  // ── 模型用量流水 ─────────────────────────────────────────────
  async addUsage(row: UsageRow): Promise<void> {
    validateUsageRow(row);
    await this.engine.begin(async (conn) => {
      await conn.db.insert(t.llm_usage).values({
        id: row.id,
        ts: row.ts,
        day: row.day,
        owner: row.owner || "",
        session_id: row.session_id || "",
        run_id: row.run_id || "",
        node_id: row.node_id || "",
        kind: row.kind,
        model: row.model,
        effort: row.effort || "",
        tok_in: row.tok_in,
        tok_out: row.tok_out,
        cache_read: row.cache_read,
        cache_write: row.cache_write,
        usd: row.usd,
        usd_source: row.usd_source,
        attempts: row.attempts,
        status: row.status,
      });
    });
  }

  async usageSince(since: number, opts?: UsageSinceOpts): Promise<UsageRow[]> {
    const limit = opts?.limit ?? 5000;
    const owner = opts?.owner ?? null;
    if (limit <= 0) return [];
    const rows = await this.engine.connect(async (conn) => {
      const where: (SQL | undefined)[] = [gte(t.llm_usage.ts, since)];
      if (owner !== null) {
        // 空归属在库里是 ''、在内存实现里可能是 None —— 两边都认，否则换个
        // repo 实现就静默少掉一半行（session.owner 上踩过同一个坑）
        where.push(
          owner ? eq(t.llm_usage.owner, owner) : or(eq(t.llm_usage.owner, ""), isNull(t.llm_usage.owner)),
        );
      }
      return conn.db
        .select()
        .from(t.llm_usage)
        .where(and(...where))
        .orderBy(desc(t.llm_usage.ts))
        .limit(limit);
    });
    return rows.map((raw) => usageRow(asRec(raw)));
  }

  // ── 项目 ─────────────────────────────────────────────────────
  async listProjects(opts?: ListProjectsOpts): Promise<ProjectRow[]> {
    const owner = opts?.owner ?? null;
    const rows = await this.engine.connect(async (conn) => {
      const q = conn.db.select().from(t.project).$dynamic();
      // 只看归属自己的；NULL(无归属)被排除
      if (owner !== null) q.where(eq(t.project.owner, owner));
      return q.orderBy(asc(t.project.sort_order), asc(t.project.created_at));
    });
    return rows.map((raw) => projectRow(asRec(raw)));
  }

  async createProject(row: ProjectRow): Promise<ProjectRow> {
    const now = this.tstz(nowSec());
    await this.engine.begin(async (conn) => {
      await conn.db.insert(t.project).values({
        id: row.id,
        name: row.name,
        owner: emptyToNull(row.owner), // "" → NULL（无归属）
        prefs: row.prefs, // 无 server_default，总是显式写
        sort_order: row.sort_order,
        created_at: now,
        updated_at: now,
      });
    });
    return row;
  }

  async getProject(pid: string): Promise<ProjectRow | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select().from(t.project).where(eq(t.project.id, pid)),
    );
    return rows[0] === undefined ? null : projectRow(asRec(rows[0]));
  }

  /** updated_at 显式写：`touch_updated_at` 触发器只有 Postgres 的迁移里有，
   * SQLite 上指望它就等于这一列永远停在创建时刻。 */
  async renameProject(pid: string, name: string): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.project)
        .set({ name, updated_at: this.tstz(nowSec()) })
        .where(eq(t.project.id, pid))
        .returning({ id: t.project.id }),
    );
    return rows.length > 0;
  }

  /** 删项目：成员会话掉回未归类，项目记忆一起删掉。返回释放了几个会话。
   *
   * 一个事务三步，且**不靠外键级联** —— project 上根本没有指过来的外键。次序是先
   * 松开会话再删记忆最后删项目：同一个事务里其实无所谓，但读起来是「先把还要用的
   * 东西摘出来，再扔容器」，和内存实现一致。 */
  async deleteProject(pid: string): Promise<number> {
    return this.engine.begin(async (conn) => {
      const released = await conn.db
        .update(t.session)
        .set({ project_id: null })
        .where(eq(t.session.project_id, pid))
        .returning({ id: t.session.id });
      await conn.db.delete(t.project_memory).where(eq(t.project_memory.project_id, pid));
      await conn.db.delete(t.project).where(eq(t.project.id, pid));
      return released.length;
    });
  }

  async assignSession(sid: string, projectId: string | null): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db
        .update(t.session)
        .set({ project_id: emptyToNull(projectId) }) // null/"" → NULL（移出项目）
        .where(eq(t.session.id, sid))
        .returning({ id: t.session.id }),
    );
    return rows.length > 0;
  }

  async listProjectMemory(pid: string): Promise<ProjectMemoryRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db
        .select()
        .from(t.project_memory)
        .where(eq(t.project_memory.project_id, pid))
        .orderBy(asc(t.project_memory.key)),
    );
    return rows.map((raw) => projectMemoryRow(asRec(raw)));
  }

  async upsertProjectMemory(rows: readonly ProjectMemoryRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const now = this.tstz(nowSec());
    await this.engine.begin(async (conn) => {
      for (const row of rows) {
        const mutable = {
          tier: row.tier,
          kind: row.kind,
          content: row.content,
          confidence: row.confidence,
          support: [...row.support],
          tags: [...row.tags],
          origin_session: row.origin_session,
          origin_files: [...row.origin_files],
          contested_by: [...row.contested_by],
          hit_runs: [...row.hit_runs],
          use_count: row.use_count,
          created_run: row.created_run,
          last_used_run: row.last_used_run,
          updated_at: now,
        };
        await conn.db
          .insert(t.project_memory)
          .values({ project_id: row.project_id, key: row.key, ...mutable })
          .onConflictDoUpdate({
            target: [t.project_memory.project_id, t.project_memory.key],
            set: mutable,
          });
      }
    });
    return rows.length;
  }

  async deleteProjectMemory(pid: string, opts?: DeleteProjectMemoryOpts): Promise<number> {
    const keys = opts?.keys ?? null;
    // null = 整个项目的记忆全清；[] = 一条都不删
    if (keys !== null && keys.length === 0) return 0;
    const rows = await this.engine.begin(async (conn) => {
      const where: (SQL | undefined)[] = [eq(t.project_memory.project_id, pid)];
      if (keys !== null) where.push(inArray(t.project_memory.key, [...keys]));
      return conn.db
        .delete(t.project_memory)
        .where(and(...where))
        .returning({ key: t.project_memory.key });
    });
    return rows.length;
  }

  // ── 设置 ─────────────────────────────────────────────────────
  async getSetting(key: string): Promise<JsonValue | null> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select({ value: t.app_setting.value }).from(t.app_setting).where(eq(t.app_setting.key, key)),
    );
    return rows[0] === undefined ? null : ((asRec(rows[0])["value"] ?? null) as JsonValue);
  }

  async setSetting(key: string, value: JsonValue): Promise<void> {
    await this.engine.begin(async (conn) => {
      await conn.db
        .insert(t.app_setting)
        .values({ key, value })
        .onConflictDoUpdate({ target: t.app_setting.key, set: { value } });
    });
  }

  async listSettings(): Promise<SettingRow[]> {
    const rows = await this.engine.connect(async (conn) =>
      conn.db.select({ key: t.app_setting.key, value: t.app_setting.value }).from(t.app_setting),
    );
    return rows.map((raw) => {
      const r = asRec(raw);
      return makeSettingRow({ key: txt(r, "key"), value: (r["value"] ?? null) as JsonValue });
    });
  }

  async deleteSetting(key: string): Promise<boolean> {
    const rows = await this.engine.begin(async (conn) =>
      conn.db.delete(t.app_setting).where(eq(t.app_setting.key, key)).returning({ k: t.app_setting.key }),
    );
    return rows.length > 0;
  }
}
