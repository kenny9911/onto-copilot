/**
 * 仓储层的传输对象 —— 移植自 `store/repo.py` 顶部的那批 `@dataclass(slots=True)`。
 *
 * 全是 `readonly interface` + 工厂函数，不是 class：这些东西要 JSON 往返
 * （落库、进 SSE、进导出包），class 会带上原型和方法，序列化形态就不是数据了。
 * Python 那边挂在 dataclass 上的方法（`brief()` / `as_sse()` / `public()` /
 * `validate()` …）在这里是**同名的自由函数**，行为逐字保留。
 *
 * ── `""` 与 `NULL` 的双表示（这份文件存在的第一个理由）────────────────────
 *
 * 内存实现用 `""` 表示"没有"，库里用 `NULL`。Python 侧的做法是写入时
 * `x or None`、读出时 `r["x"] or ""`，**散在二十多个调用点上手写**。漏一处的
 * 症状分两种，都很难查：
 *   * 漏了写入侧 → `owner = ''` 的行进了库，按 owner 过滤时它既不属于任何人、
 *     也不在"无归属"那一档里，凭空消失；
 *   * 漏了读出侧 → DTO 里冒出 `null`，而前端只判一种空值，界面上就是空白。
 * 所以这里把它固化成 `emptyToNull` / `nullToEmpty` 两个函数 + 一张
 * `EMPTY_AS_NULL` 清单，调用点只许用它们，别再各写各的。
 */

import { TABLE_SPECS } from "./schema.js";
// Python 的 UsageRow.validate() 抛 ValueError，不是裸 Error。上层按类型分派，
// 抛错类不对会让「输入非法」被当成「内部炸了」。
import { ValueError } from "../kernel/errors.js";

// ══════════════════════════════════════════════════════════════════
//  JSON 值
// ══════════════════════════════════════════════════════════════════

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { readonly [k: string]: JsonValue };

// ══════════════════════════════════════════════════════════════════
//  "" ↔ NULL
// ══════════════════════════════════════════════════════════════════

/** 真的会做 `""` ↔ `NULL` 折叠的列。**只有这几列** —— 别看见一个可空 text 就往
 * 里加：`conflict.owner` / `revision_record.parent_id` / `decision_record.supersedes`
 * / `kernel_event.node_id` / `*.ref` 的 NULL 是"真的没有"，DTO 里也保持 null，
 * 折叠成 `""` 会把"没有父版本"和"父版本是空串"混成一件事。
 *
 * 清单不是文档，是断言的输入：测试逐条校验它们在 schema 里确实是**可空的 text**。 */
export const EMPTY_AS_NULL = [
  "session.owner",
  "session.project_id",
  "project.owner",
  "session_event.event_id",
] as const satisfies readonly `${keyof typeof TABLE_SPECS}.${string}`[];

/** 写库方向：`""`（以及 undefined/null）→ `NULL`。
 * 对应 Python 的 `x or None` —— 按**假值**判断，不是只判 `""`，两边一致。 */
export function emptyToNull(v: string | null | undefined): string | null {
  return v ? v : null;
}

/** 读库方向：`NULL` → `""`。对应 Python 的 `r["x"] or ""`。 */
export function nullToEmpty(v: string | null | undefined): string {
  return v ? v : "";
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

/** `d["k"]` —— 键不在就抛，别静默给 undefined。 */
function req(d: JsonObject, k: string): JsonValue {
  if (!(k in d)) throw new Error(`缺少必需字段 ${k}`);
  return d[k]!;
}

/** `d.get(k, dflt)` —— 只在**键不存在**时回落。值本身是 null/""/0 时照原样返回，
 * 所以不能写成 `d[k] ?? dflt`（那会把显式的 null 也吞掉，与 Python 分叉）。 */
function getOr<T extends JsonValue>(d: JsonObject, k: string, dflt: T): JsonValue | T {
  return k in d ? d[k]! : dflt;
}

/** `x or dflt` —— 按假值回落（`""` / `0` / `[]` / `{}` 里 Python 只有前三种是假，
 * 空 dict/list 在 Python 里**也是假**；JS 里 `[]`/`{}` 是真。这个函数只用在
 * Python 写 `or []` / `or {}` 的位置，那里两边结果相同，所以按 JS 的真值判即可。 */
function str(v: JsonValue | undefined, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

/** Python `int(x)` —— **向零截断**，不是四舍五入。`int(3.9) == 3`，
 * 而 `Number("3.9")` 是 3.9：直接用 Number 会让 version/ordinal 带上小数。 */
function pyInt(v: JsonValue | undefined, dflt = 0): number {
  if (v === null || v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`int() 收到非数值 ${JSON.stringify(v)}`);
  return Math.trunc(n);
}

/** Python `float(x)`。非数值在 Python 里抛 ValueError，这里也抛 —— `Number()`
 * 默认给 NaN，那个 NaN 会一路飘进库里（时间戳变 NULL/NaN），比抛出难查得多。 */
function pyFloat(v: JsonValue | undefined, dflt = 0): number {
  if (v === null || v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`float() 收到非数值 ${JSON.stringify(v)}`);
  return n;
}

/** `list(x or [])` —— 每次新数组，绝不共享引用。 */
function strList(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function jsonList(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? [...v] : [];
}

/** `dict(x or {})` —— 每次新对象。 */
function jsonObj(v: JsonValue | undefined): JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {};
}

// ══════════════════════════════════════════════════════════════════
//  会话
// ══════════════════════════════════════════════════════════════════

/** 会话元数据。字段和 `Session.brief()`（server.py:115-118）一一对应。
 *
 * `created` 是 **epoch 秒**，而库里 `session.created_at` 是 timestamptz ——
 * 转换在仓储层做，DTO 只认数字（前端也只认数字）。 */
export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly status: string;
  readonly error: string;
  readonly created: number;
  readonly state_version: number;
  /** 归属账号 id。"" = 无归属（旧会话/开放模式），强制鉴权下对所有人隐藏。 */
  readonly owner: string;
  /** 所属项目文件夹（project.id）。"" = 未归类。**和上面的 project 不是一回事**：
   * project 是印在交付物上的客户项目名，这里是侧栏分组。 */
  readonly project_id: string;
}

export function makeSessionRow(p: Pick<SessionRow, "id"> & Partial<SessionRow>): SessionRow {
  return {
    id: p.id,
    title: p.title ?? "新建会话",
    project: p.project ?? "",
    status: p.status ?? "idle",
    error: p.error ?? "",
    created: p.created ?? 0,
    state_version: p.state_version ?? 0,
    owner: p.owner ?? "",
    project_id: p.project_id ?? "",
  };
}

export function sessionBrief(r: SessionRow, files = 0): JsonObject {
  return {
    id: r.id,
    title: r.title,
    project: r.project,
    status: r.status,
    files,
    created: r.created,
    error: r.error,
    project_id: r.project_id,
  };
}

// ══════════════════════════════════════════════════════════════════
//  文件与事件
// ══════════════════════════════════════════════════════════════════

export interface FileRow {
  readonly name: string;
  readonly rel_path: string;
  readonly size: number;
  readonly sha256: string;
}

export function makeFileRow(
  p: Pick<FileRow, "name" | "rel_path" | "size"> & Partial<FileRow>,
): FileRow {
  return { name: p.name, rel_path: p.rel_path, size: p.size, sha256: p.sha256 ?? "" };
}

export interface EventRow {
  readonly seq: number;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly ts: number;
  /** "" = 这条事件是幂等身份出现之前写的（0007 之前）。库里那列是可空的 —— 见
   * `EMPTY_AS_NULL`。 */
  readonly event_id: string;
}

export function makeEventRow(
  p: Pick<EventRow, "seq" | "kind" | "ts"> & Partial<EventRow>,
): EventRow {
  return {
    seq: p.seq,
    kind: p.kind,
    payload: { ...(p.payload ?? {}) },
    ts: p.ts,
    event_id: p.event_id ?? "",
  };
}

/** 还原成 `Session.emit` 产出的那个扁平 dict（server.py:109）。
 *
 * 展开顺序照抄 Python：`{seq, ts, **payload, kind}` —— payload 里同名的 seq/ts
 * **会盖掉**外层的，而 kind 排在最后所以永远是行上的 kind。别"顺手"调成先展开
 * payload：那会让 payload.kind 赢，SSE 的事件类型就跟库里的对不上了。 */
export function eventRowAsSse(r: EventRow): JsonObject {
  const out: Record<string, JsonValue> = { seq: r.seq, ts: r.ts, ...r.payload, kind: r.kind };
  if (r.event_id) out["eventId"] = r.event_id;
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  人的决定（legacy decision，按 ordinal）
// ══════════════════════════════════════════════════════════════════

export interface DecisionRow {
  readonly ordinal: number;
  readonly kind: string;
  readonly statement: string;
  readonly scope_refs: readonly string[];
  readonly turn_index: number;
  /** 同会话内另一条的 ordinal；null = 这条还生效。 */
  readonly superseded_by: number | null;
  readonly target_rid: string;
  readonly option_id: string;
  readonly changed: readonly JsonValue[];
  readonly note: string;
  readonly ts: number;
}

export function makeDecisionRow(
  p: Pick<DecisionRow, "ordinal" | "kind"> & Partial<DecisionRow>,
): DecisionRow {
  return {
    ordinal: p.ordinal,
    kind: p.kind,
    statement: p.statement ?? "",
    scope_refs: [...(p.scope_refs ?? [])],
    turn_index: p.turn_index ?? -1,
    superseded_by: p.superseded_by ?? null,
    target_rid: p.target_rid ?? "",
    option_id: p.option_id ?? "",
    changed: [...(p.changed ?? [])],
    note: p.note ?? "",
    ts: p.ts ?? 0,
  };
}

export function decisionIsActive(r: DecisionRow): boolean {
  return r.superseded_by === null;
}

/** 喂给 `DialogueMemory.fromDict`（dialogue.py:305）的形状。
 * 它读的键正好是 kind / statement / scope_refs / turn / ts / superseded_by。 */
export function decisionToDialogueDict(r: DecisionRow): JsonObject {
  return {
    kind: r.kind,
    statement: r.statement,
    scope_refs: [...r.scope_refs],
    turn: r.turn_index,
    ts: r.ts,
    superseded_by: r.superseded_by,
  };
}

// ══════════════════════════════════════════════════════════════════
//  统一 Question / Decision / Revision
// ══════════════════════════════════════════════════════════════════

/** 领域侧的最小形状 —— `onto/question.ts` / `onto/decision.ts` 还没落地。
 * 这两个函数只用到 `toDict()`（外加 decision 的 `fingerprint`），所以先按最小
 * 接口解耦；对方落地后把这里换成真正的领域类型即可，调用签名不变。 */
export interface HasToDict {
  toDict(): JsonObject;
}
export interface HasFingerprint extends HasToDict {
  readonly fingerprint: string;
}

/** 统一问题表的持久化 DTO；`doc` 是完整领域契约。 */
export interface QuestionRow {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly owner_user_id: string;
  readonly audience_role: string;
  readonly answer_schema: JsonObject;
  readonly priority: string;
  readonly dependencies: readonly string[];
  readonly blocked_artifacts: readonly string[];
  readonly source_kind: string;
  readonly source_ref: string;
  readonly doc: JsonObject;
  readonly version: number;
  readonly created: number;
  readonly updated: number;
}

export function makeQuestionRow(
  p: Pick<QuestionRow, "id" | "text"> & Partial<QuestionRow>,
): QuestionRow {
  return {
    id: p.id,
    text: p.text,
    status: p.status ?? "open",
    owner_user_id: p.owner_user_id ?? "",
    audience_role: p.audience_role ?? "",
    answer_schema: { ...(p.answer_schema ?? {}) },
    priority: p.priority ?? "normal",
    dependencies: [...(p.dependencies ?? [])],
    blocked_artifacts: [...(p.blocked_artifacts ?? [])],
    source_kind: p.source_kind ?? "manual",
    source_ref: p.source_ref ?? "",
    doc: { ...(p.doc ?? {}) },
    version: p.version ?? 0,
    created: p.created ?? 0,
    updated: p.updated ?? 0,
  };
}

export function questionRowFromDomain(question: HasToDict): QuestionRow {
  const d = question.toDict();
  return {
    id: String(req(d, "id")),
    text: String(req(d, "text")),
    status: String(req(d, "status")),
    owner_user_id: str(getOr(d, "ownerUserId", "")),
    audience_role: str(getOr(d, "audienceRole", "")),
    answer_schema: jsonObj(d["answerSchema"]),
    priority: str(getOr(d, "priority", "normal"), "normal"),
    dependencies: strList(d["dependencies"]),
    blocked_artifacts: strList(d["blockedArtifacts"]),
    source_kind: str(getOr(d, "sourceKind", "manual"), "manual"),
    source_ref: str(getOr(d, "sourceRef", "")),
    doc: d,
    version: pyInt(d["version"]),
    created: pyFloat(d["createdAt"]),
    updated: pyFloat(d["updatedAt"]),
  };
}

/** 统一 DecisionLedger 的 append-only 行。 */
export interface DecisionRecordRow {
  readonly id: string;
  readonly question_id: string;
  readonly answer: JsonValue;
  readonly actor: string;
  readonly actor_role: string;
  readonly authority: string;
  readonly source_turn: string;
  readonly affected_ids: readonly string[];
  readonly supersedes: string | null;
  readonly revision: number | null;
  readonly idempotency_key: string;
  readonly semantic_hash: string;
  readonly rationale: string;
  readonly metadata: JsonObject;
  readonly created: number;
}

export function makeDecisionRecordRow(
  p: Pick<DecisionRecordRow, "id" | "question_id" | "answer" | "actor"> &
    Partial<DecisionRecordRow>,
): DecisionRecordRow {
  return {
    id: p.id,
    question_id: p.question_id,
    answer: p.answer,
    actor: p.actor,
    actor_role: p.actor_role ?? "",
    authority: p.authority ?? "",
    source_turn: p.source_turn ?? "",
    affected_ids: [...(p.affected_ids ?? [])],
    supersedes: p.supersedes ?? null,
    revision: p.revision ?? null,
    idempotency_key: p.idempotency_key ?? "",
    semantic_hash: p.semantic_hash ?? "",
    rationale: p.rationale ?? "",
    metadata: { ...(p.metadata ?? {}) },
    created: p.created ?? 0,
  };
}

export function decisionRecordRowFromDomain(decision: HasFingerprint): DecisionRecordRow {
  const d = decision.toDict();
  const supersedes = getOr(d, "supersedes", null);
  const revision = getOr(d, "revision", null);
  return {
    id: String(req(d, "id")),
    question_id: String(req(d, "questionId")),
    answer: getOr(d, "answer", null),
    actor: str(getOr(d, "actor", "user"), "user"),
    actor_role: str(getOr(d, "actorRole", "")),
    authority: str(getOr(d, "authority", "")),
    source_turn: str(getOr(d, "sourceTurn", "")),
    affected_ids: strList(d["affectedIds"]),
    supersedes: supersedes === null ? null : String(supersedes),
    revision: revision === null ? null : pyInt(revision),
    idempotency_key: str(getOr(d, "idempotencyKey", "")),
    // 不是从 dict 里取的 —— 指纹是领域对象算出来的属性，to_dict() 里没有它。
    semantic_hash: decision.fingerprint,
    rationale: str(getOr(d, "rationale", "")),
    metadata: jsonObj(d["metadata"]),
    created: pyFloat(d["createdAt"]),
  };
}

/** 一次 proposed/applied/rejected/rolled_back 的耐久版本记录。 */
export interface RevisionRow {
  readonly id: string;
  readonly ordinal: number;
  /** null = 根版本。**不折叠成 ""** —— "没有父版本"和"父版本 id 是空串"不是一回事。 */
  readonly parent_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly doc: JsonObject;
  readonly patch_set: JsonObject | null;
  readonly changed_ids: readonly string[];
  readonly invalidated_artifacts: readonly string[];
  readonly actor: string;
  readonly source_turn: string;
  readonly snapshot_hash: string;
  readonly idempotency_key: string;
  readonly created: number;
}

export function makeRevisionRow(
  p: Pick<RevisionRow, "id" | "ordinal" | "parent_id" | "kind" | "status" | "doc"> &
    Partial<RevisionRow>,
): RevisionRow {
  return {
    id: p.id,
    ordinal: p.ordinal,
    parent_id: p.parent_id,
    kind: p.kind,
    status: p.status,
    doc: { ...p.doc },
    patch_set: p.patch_set ?? null,
    changed_ids: [...(p.changed_ids ?? [])],
    invalidated_artifacts: [...(p.invalidated_artifacts ?? [])],
    actor: p.actor ?? "agent",
    source_turn: p.source_turn ?? "",
    snapshot_hash: p.snapshot_hash ?? "",
    idempotency_key: p.idempotency_key ?? "",
    created: p.created ?? 0,
  };
}

export function revisionRowFromDomain(revision: HasToDict, idempotencyKey = ""): RevisionRow {
  const d = revision.toDict();
  const parent = getOr(d, "parentId", null);
  const patch = getOr(d, "patchSet", null);
  return {
    id: String(req(d, "id")),
    ordinal: pyInt(req(d, "ordinal")),
    parent_id: parent === null ? null : String(parent),
    kind: str(getOr(d, "kind", "edit"), "edit"),
    status: str(getOr(d, "status", "proposed"), "proposed"),
    doc: d,
    patch_set: patch === null ? null : jsonObj(patch),
    changed_ids: strList(d["changedIds"]),
    invalidated_artifacts: strList(d["invalidatedArtifacts"]),
    actor: str(getOr(d, "actor", "agent"), "agent"),
    source_turn: str(getOr(d, "sourceTurn", "")),
    snapshot_hash: str(getOr(d, "snapshotHash", "")),
    idempotency_key: idempotencyKey,
    created: pyFloat(d["createdAt"]),
  };
}

// ══════════════════════════════════════════════════════════════════
//  用量
// ══════════════════════════════════════════════════════════════════

/** 一次模型调用的用量流水。**跨会话、跨重启的唯一账本。**
 *
 * `tok_*` 是**实际打给模型那几次的总和**（schema 重试、截断加预算重试都算），
 * `attempts` 说明打了几次 —— 一次调用重试三回就是三份 token 的钱，只记最后
 * 一次等于把账做小。`usd_source` 区分网关回的真实账单和本地价目表的估算：
 * 很多经网关发现的模型价目是编的（catalog 里统一填 2.0/8.0），估出来的金额
 * 看着精确、其实是错的，界面据此决定敢不敢把它当钱显示。 */
export interface UsageRow {
  readonly id: string;
  readonly ts: number;
  /** 'YYYY-MM-DD'（UTC），写入时算好 */
  readonly day: string;
  readonly model: string;
  readonly owner: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly node_id: string;
  /** build | chat | aux */
  readonly kind: string;
  readonly effort: string;
  readonly tok_in: number;
  readonly tok_out: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly usd: number;
  /** gateway | estimated */
  readonly usd_source: string;
  readonly attempts: number;
  /** ok | failed */
  readonly status: string;
}

export function makeUsageRow(
  p: Pick<UsageRow, "id" | "ts" | "day" | "model"> & Partial<UsageRow>,
): UsageRow {
  return {
    id: p.id,
    ts: p.ts,
    day: p.day,
    model: p.model,
    owner: p.owner ?? "",
    session_id: p.session_id ?? "",
    run_id: p.run_id ?? "",
    node_id: p.node_id ?? "",
    kind: p.kind ?? "build",
    effort: p.effort ?? "",
    tok_in: p.tok_in ?? 0,
    tok_out: p.tok_out ?? 0,
    cache_read: p.cache_read ?? 0,
    cache_write: p.cache_write ?? 0,
    usd: p.usd ?? 0,
    usd_source: p.usd_source ?? "estimated",
    attempts: p.attempts ?? 1,
    status: p.status ?? "ok",
  };
}

export function usageTotal(r: UsageRow): number {
  return r.tok_in + r.tok_out + r.cache_read + r.cache_write;
}

/** 两个仓储实现落库**之前**都要过这一关 —— 库里的 CHECK 只在 Postgres 上兜底，
 * MemoryRepo 那条路没有任何 CHECK，靠这个函数把契约拉平。 */
export function validateUsageRow(r: UsageRow): void {
  if (!r.id || !r.model) throw new ValueError("usage id/model 不能为空");
  if (!["build", "chat", "aux"].includes(r.kind)) throw new ValueError(`usage kind 不支持: ${r.kind}`);
  if (Math.min(r.tok_in, r.tok_out, r.cache_read, r.cache_write) < 0) {
    throw new ValueError("usage token 不能为负数");
  }
  if (r.usd < 0) throw new ValueError("usage usd 不能为负数");
  if (!["gateway", "estimated"].includes(r.usd_source)) {
    throw new ValueError(`usage usd_source 不支持: ${r.usd_source}`);
  }
  if (r.attempts < 1) throw new ValueError("usage attempts 必须至少为 1");
  if (!["ok", "failed"].includes(r.status)) throw new ValueError(`usage status 不支持: ${r.status}`);
}

// ══════════════════════════════════════════════════════════════════
//  账号
// ══════════════════════════════════════════════════════════════════

/** 账号。`password_hash` 只进不出 —— `userPublic()` 绝不带它。 */
export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  /** admin | user */
  readonly role: string;
  readonly active: boolean;
  readonly prefs: JsonObject;
  readonly created: number;
  /** 称呼用的名字，原样保留大小写与空格。空串 = 没填（管理员/CLI 建的号、
   * 迁移前的老账号），展示时回落到 username。 */
  readonly display_name: string;
}

export function makeUserRow(
  p: Pick<UserRow, "id" | "username" | "password_hash"> & Partial<UserRow>,
): UserRow {
  return {
    id: p.id,
    username: p.username,
    password_hash: p.password_hash,
    role: p.role ?? "user",
    active: p.active ?? true,
    prefs: { ...(p.prefs ?? {}) },
    created: p.created ?? 0,
    display_name: p.display_name ?? "",
  };
}

/** 给列表/管理页看的安全投影。**永不含 password_hash。** */
export function userPublic(r: UserRow): JsonObject {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    active: r.active,
    created: r.created,
    display_name: r.display_name,
  };
}

/** 登录会话。主键是令牌的 sha256（`token_hash`），不是令牌本身。 */
export interface AuthSessionRow {
  readonly token_hash: string;
  readonly user_id: string;
  readonly created: number;
  readonly last_seen: number;
  readonly expires: number;
}

export function makeAuthSessionRow(
  p: Pick<AuthSessionRow, "token_hash" | "user_id"> & Partial<AuthSessionRow>,
): AuthSessionRow {
  return {
    token_hash: p.token_hash,
    user_id: p.user_id,
    created: p.created ?? 0,
    last_seen: p.last_seen ?? 0,
    expires: p.expires ?? 0,
  };
}

/** 一条全局应用设置。`value` 是任意 JSON 可序列化值。 */
export interface SettingRow {
  readonly key: string;
  readonly value: JsonValue;
  readonly updated: number;
}

export function makeSettingRow(
  p: Pick<SettingRow, "key" | "value"> & Partial<SettingRow>,
): SettingRow {
  return { key: p.key, value: p.value, updated: p.updated ?? 0 };
}

// ══════════════════════════════════════════════════════════════════
//  项目文件夹
// ══════════════════════════════════════════════════════════════════

/** 一个项目文件夹。`owner` 为 "" = 无归属（开放模式建的）。
 *
 * `prefs` 是项目级偏好的预留位（命名规范/受众/问多少），这轮恒为 `{}`。 */
export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly prefs: JsonObject;
  readonly sort_order: number;
}

export function makeProjectRow(
  p: Pick<ProjectRow, "id" | "name"> & Partial<ProjectRow>,
): ProjectRow {
  return {
    id: p.id,
    name: p.name,
    owner: p.owner ?? "",
    prefs: { ...(p.prefs ?? {}) },
    sort_order: p.sort_order ?? 0,
  };
}

/** 一条项目记忆。字段与 `project_memory` 的列一一对应。
 *
 * `tier` 只有两种取值，库里有 CHECK 兜着：`authoritative` 是人拍板的约定，
 * `reference` 是模型推断的教训。这一层只负责**如实存取**这个标记 —— 「参考档
 * 永不晋升」是记忆内核的判据，不在仓储里执行，但仓储绝不能把它弄丢或改写。 */
export interface ProjectMemoryRow {
  readonly project_id: string;
  readonly key: string;
  readonly tier: string;
  readonly kind: string;
  readonly content: string;
  readonly confidence: number;
  readonly support: readonly string[];
  readonly tags: readonly string[];
  /** 这条记忆是在哪个会话里形成的（reference 档进 prompt 时要逐行标出来） */
  readonly origin_session: string;
  /** 这条记忆读的是哪几份材料（换会话换材料时据此再降一档权重） */
  readonly origin_files: readonly string[];
  readonly contested_by: readonly string[];
  readonly hit_runs: readonly string[];
  readonly use_count: number;
  readonly created_run: string;
  readonly last_used_run: string;
}

export function makeProjectMemoryRow(
  p: Pick<ProjectMemoryRow, "project_id" | "key" | "tier" | "kind" | "content"> &
    Partial<ProjectMemoryRow>,
): ProjectMemoryRow {
  return {
    project_id: p.project_id,
    key: p.key,
    tier: p.tier,
    kind: p.kind,
    content: p.content,
    confidence: p.confidence ?? 0.5,
    support: [...(p.support ?? [])],
    tags: [...(p.tags ?? [])],
    origin_session: p.origin_session ?? "",
    origin_files: [...(p.origin_files ?? [])],
    contested_by: [...(p.contested_by ?? [])],
    hit_runs: [...(p.hit_runs ?? [])],
    use_count: p.use_count ?? 0,
    created_run: p.created_run ?? "",
    last_used_run: p.last_used_run ?? "",
  };
}

// ══════════════════════════════════════════════════════════════════
//  错误
// ══════════════════════════════════════════════════════════════════

/** 用户名（或 id）已存在。两个实现都抛它，路由层统一映射成 409。 */
export class DuplicateUsername extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateUsername";
    Object.setPrototypeOf(this, DuplicateUsername.prototype); // 保住 instanceof
  }
}
