/**
 * 问题清单 —— `server.py` 4075–4497 的移植（七条路由）。
 *
 * | 方法 | 路径 | 干什么 |
 * |---|---|---|
 * | GET   | `/api/sessions/{sid}/questions`                | 列出整份 backlog + 下一批 |
 * | PATCH | `/api/sessions/{sid}/questions/{qid}`          | 改负责人/角色/优先级/状态 |
 * | POST  | `/api/sessions/{sid}/questions/{qid}/reopen`   | 把终态问题重新打开 |
 * | POST  | `/api/sessions/{sid}/questions/{qid}/answer`   | 记一条 Decision 并回写 OIR |
 * | GET   | `/api/sessions/{sid}/questions/export`         | 下载 xlsx / md / json |
 * | GET   | `/api/sessions/{sid}/revisions`                | 版本流水 |
 * | POST  | `/api/sessions/{sid}/answer`                   | 旧 conflict API 的兼容入口 |
 *
 * ## 这一段是「给 ERP 顾问填的问题清单」的回传闭环
 *
 * 交付物（`问题清单.xlsx`）做得出来但答不回来，等于半条链路是断的：顾问在表上
 * 写了口径，系统里的 OIR 却一个字都没变。所以这里每一条路由的终点都是
 * **耐久记录**（Question 行、Decision 行、Revision 行），不是内存里的 `s.state`。
 *
 * ## 三件必须照抄、抄错了不会当场报错的事
 *
 * ### 1. 双重加锁的顺序
 *
 * `_session_mutation(s, kind)` 在**外**、`s.question_lock` 在**内**
 * （server.py:4091 / 4176 / 4205）。反过来就是两个请求各持一半的经典死锁：
 * A 拿着 question_lock 等 mutation lease，B 拿着 lease 等 question_lock。
 * 租约有 TTL 所以最终会解开 —— 但解开的方式是一次超时 500，而不是一次正确的写。
 *
 * ### 2. `/answer` 的幂等来自库，不来自代码
 *
 * `store/schema.ts` 的 `decision_live_answer_uq`（一条冲突同时只能有一个生效答复）
 * 加上 `record_decision_v1` 的幂等键，让重复提交**天然**返回同一条 Decision。
 * 因此副作用（`applyDecision` / OpenQuestion 回写）只能发生在
 * `created === true` 的那一次上：先 mutate 再判重，网络重试会把同一个决定应用两次。
 *
 * ### 3. 下载的两个头
 *
 * `Content-Type` 与 `Content-Disposition` 写错不会有异常、不会有测试变红 ——
 * 只会让顾问存下来的文件叫 `download.bin`、或者中文名变成一串问号。
 * `contentDisposition` 直接复用 `artifacts.ts` 那一份（Python 侧也是同一个
 * `_content_disposition`），**不要**在这里再写一个。
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pyRepr } from "../../kernel/errors.js";
import { RunStatus } from "../../kernel/scheduler.js";
import { applyDecision } from "../../onto/clarify.js";
import type { Conflict } from "../../onto/conflict.js";
import { cmpCodePoint } from "../../onto/difflib.js";
import { byUser, type OIR } from "../../onto/oir.js";
import {
  Decision,
  IdempotencyConflict,
  KeyError,
  PatchSet,
  Question,
  QuestionBacklog,
  QuestionPriority,
  QuestionStatus,
  Revision,
  RevisionConflict,
  RevisionStatus,
  ValueError,
} from "../../onto/questions.js";
import {
  decisionRecordRowFromDomain,
  questionRowFromDomain,
  revisionRowFromDomain,
  type DecisionRecordRow,
  type JsonObject,
  type JsonValue,
} from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { currentRepo, sessAsync, type Session } from "../session.js";
import { contentDisposition } from "./artifacts.js";
import { pyJsonIndent } from "../dialogue/pyutil.js";
import { intParsingError, jsonObjectBody, pydanticInt, raise422 } from "../http422.js";

// exceljs 是 CJS（同 `onto/template.ts` 的说明）：具名 import 在运行时直接
// SyntaxError，createRequire 才两边都对。
const requireCjs = createRequire(import.meta.url);
type ExcelJsModule = typeof import("exceljs");
const ExcelJS = requireCjs("exceljs") as ExcelJsModule;

// ══════════════════════════════════════════════════════════════════
//  外部接线
// ══════════════════════════════════════════════════════════════════

/** 这一段用到的、住在别的段落里的服务端零件。 */
export interface QuestionDeps {
  /** `_persist(s)`：一次检查点。 */
  readonly persist: (s: Session) => Promise<void>;
  /**
   * `async with _session_mutation(s, kind)`：跨 worker 的耐久变更租约。
   *
   * 回调形 —— 进入/退出的成对性由签名保证。**它必须在 `questionLock` 之外**，
   * 见文件头第 1 条。
   */
  readonly sessionMutation: <T>(s: Session, kind: string, body: () => Promise<T>) => Promise<T>;
  /** `_recompile(s, preserve_question_rows=True)`：确定性重算，零模型调用。 */
  readonly recompile: (s: Session, opts: { preserveQuestionRows: boolean }) => Promise<void>;
  /** `_sync_question_backlog(s, ...)`：把 OIR 问题与 conflict cards 合成唯一 backlog。 */
  readonly syncQuestionBacklog: (
    s: Session,
    opts?: { clarification?: readonly unknown[]; conflicts?: readonly unknown[] },
  ) => Promise<QuestionBacklog>;
  /** `time.time()`。测试里钉住 `updated_at`。 */
  readonly now?: () => number;
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。`[]` / `{}` / `""` / `0` 在 Python 里是假，JS 里前两个是真。
 * 注意 `NaN` 在 Python 里是**真**（`bool(float("nan")) is True`），别用 `Boolean(v)`。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return true; // 0 已在上面挡掉；NaN 与 Python 一样算真
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** Python 的 `RuntimeError`。`kernel/errors.ts` 没有这一个（那边只有领域异常），
 * 而 `_answer_domain_question_once` 的 fail-closed 判据抛的正是它 —— 类名会原样
 * 落进 Decision 的 `metadata.error`，审计里看得见。 */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
    Object.setPrototypeOf(this, RuntimeError.prototype);
  }
}

/** `str(x)`。`None` → `"None"`，其余按 JS 的 String()（两边对这一段的取值域一致）。 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** `"…".strip()`。 */
function pyStrip(s: string): string {
  return s.trim();
}

/** `body.get(a, body.get(b, …))` —— 按**键存在**逐层回退，不是按真值。 */
function getChain(body: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) return body[k];
  }
  return undefined;
}

/** `x if x is not None else undefined` 的读法：Python 里没这个键与值为 None 不同，
 * 但这一段所有调用点都只区分 "是不是 None"，所以统一折叠成 `undefined`。 */
function orNull(v: unknown): unknown {
  return v === undefined ? null : v;
}

// ══════════════════════════════════════════════════════════════════
//  领域读写（server.py 3291 / 3936 / 3947 / 3975 / 3999 / 4009 / 4033）
// ══════════════════════════════════════════════════════════════════

/** `_question_backlog`（server.py:3291）。只读 `s.state`，不碰库。 */
export function questionBacklog(s: Session): QuestionBacklog {
  const raw = s.state["question_backlog"];
  return QuestionBacklog.fromDict(
    (pyTruthy(raw) ? raw : { questions: [] }) as Record<string, unknown>,
  );
}

/** `_question_payload`（server.py:3936）。 */
export function questionPayload(
  q: Question,
  active: Decision | null = null,
): Record<string, unknown> {
  const data = q.toDict();
  if (active !== null) {
    data["activeDecision"] = active.toDict();
    data["answer"] = active.answer;
  } else {
    data["activeDecision"] = null;
    data["answer"] = null;
  }
  return data;
}

/** `_decision_from_row`（server.py:4209）。 */
export function decisionFromRow(row: DecisionRecordRow): Decision {
  return Decision.fromDict({
    id: row.id,
    questionId: row.question_id,
    answer: row.answer,
    actor: row.actor,
    actorRole: row.actor_role,
    authority: row.authority,
    sourceTurn: row.source_turn,
    affectedIds: [...row.affected_ids],
    supersedes: row.supersedes,
    revision: row.revision,
    idempotencyKey: row.idempotency_key,
    rationale: row.rationale,
    createdAt: row.created,
    metadata: { ...row.metadata },
  });
}

/**
 * `_load_question_domain`（server.py:3947）。
 *
 * repo 是并发写的权威状态；state 只是渲染缓存。每次 mutation 后虽然会同步，
 * 但多 worker/另一个请求的 CAS 更新不会自动进本进程内存。
 */
export async function loadQuestionDomain(
  s: Session,
): Promise<[QuestionBacklog, Map<string, Decision>]> {
  const repo = currentRepo();
  const rowsQ = await repo.listQuestions(s.id);
  const backlog =
    rowsQ.length > 0
      ? QuestionBacklog.fromDict(rowsQ.map((r) => r.doc as Record<string, unknown>))
      : questionBacklog(s);
  s.state["question_backlog"] = backlog.toDict();
  const rows = await repo.listDecisionsV1(s.id);
  const decisions = rows
    .filter((r) => r.metadata["status"] !== "failed")
    .map((r) => decisionFromRow(r));
  const superseded = new Set(
    decisions.filter((d) => pyTruthy(d.supersedes)).map((d) => d.supersedes as string),
  );
  const active = new Map<string, Decision>();
  for (const d of decisions) {
    if (!superseded.has(d.id)) active.set(d.questionId, d);
  }
  // Decision rows are the durable ledger.  Refreshing this projection before an
  // engagement resume prevents one worker from publishing a package that omits a
  // decision finalized by another worker milliseconds earlier.
  s.state["decision_ledger"] = decisions.map((d) => d.toDict());
  return [backlog, active];
}

/**
 * `_refresh_authoritative_question_state`（server.py:3975）。
 *
 * Reload repo-owned interview state and project answers onto the live OIR.
 */
export async function refreshAuthoritativeQuestionState(
  s: Session,
): Promise<[QuestionBacklog, Map<string, Decision>]> {
  const [backlog, active] = await loadQuestionDomain(s);
  const oir = s.state["_oir"] as OIR | null | undefined;
  if (oir !== null && oir !== undefined) {
    for (const [qid, decision] of active) {
      const q = backlog.questions.get(qid);
      if (q === undefined || q.sourceKind !== "open_question") continue;
      const oq = oir.questions.get(q.sourceRef || q.id);
      if (oq !== undefined) {
        oq.answer = byUser(
          pyStr(pyTruthy(decision.rationale) ? decision.rationale : decision.answer),
          `Question Decision ${decision.id}`,
        );
      }
    }
    s.state["oir"] = oir.toDict();
  }
  await writeQuestionExports(s, backlog);
  return [backlog, active];
}

/** `_expected_version`（server.py:3999）。`int(raw)` 的语义照抄：数字截断、
 * 数字串可以、`"1.5"` 不行、别的类型 400。 */
export function expectedVersionOf(body: Record<string, unknown>): number | null {
  const raw = getChain(body, ["expected_revision", "expectedRevision"]);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new HTTPException(400, { message: "expected_revision 必须是整数" });
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^[+-]?\d+$/.test(t)) {
      throw new HTTPException(400, { message: "expected_revision 必须是整数" });
    }
    return Number.parseInt(t, 10);
  }
  throw new HTTPException(400, { message: "expected_revision 必须是整数" });
}

/** `_save_question_domain`（server.py:4009）。 */
export async function saveQuestionDomain(
  s: Session,
  q: Question,
  opts: { expected: number | null; deps: QuestionDeps },
): Promise<void> {
  const { expected, deps } = opts;
  const now = deps.now ?? (() => Date.now() / 1000);
  if (expected !== null && q.version !== expected) {
    throw new HTTPException(409, {
      message: `问题已更新：预期 version ${expected}，实际 ${q.version}`,
    });
  }
  if (expected === null) {
    // 无 CAS 的服务端内部写也只推进一个 revision；一个 PATCH 改三个字段不是
    // 三次业务动作。调用方领域方法可能已经各自 +1，这里统一收口。
    const current = await currentRepo().getQuestion(s.id, q.id);
    const base = current !== null ? current.version : q.version;
    q.version = base + 1;
    q.updatedAt = now();
  }
  const row = questionRowFromDomain(asDoc(q));
  let saved;
  try {
    saved = await currentRepo().saveQuestion(s.id, row, { expectedVersion: expected });
  } catch (exc) {
    if (exc instanceof RevisionConflict) {
      throw new HTTPException(409, { message: exc.message });
    }
    throw exc;
  }
  q.version = saved.version;
  q.updatedAt = saved.updated;
  const backlog = questionBacklog(s);
  backlog.questions.set(q.id, q);
  s.state["question_backlog"] = backlog.toDict();
  await writeQuestionExports(s, backlog);
  await deps.persist(s);
}

/** `问题清单.xlsx` 的表头与列宽（server.py:4060/4068）。 */
const EXPORT_HEADERS: readonly string[] = [
  "编号",
  "问题",
  "状态",
  "优先级",
  "回答对象",
  "负责人",
  "为什么问",
  "依赖问题",
  "阻塞产物",
  "问题ID",
];
const EXPORT_WIDTHS: readonly number[] = [8, 52, 13, 12, 18, 18, 36, 24, 32, 28];

/**
 * `_write_question_exports`（server.py:4033）：问题清单三格式始终同源生成；
 * 下载路由也复用这三份字节。
 *
 * **与 Python 的一处实现差异**：Python 侧是同步函数，这里是 async —— exceljs 的
 * `wb.xlsx.writeFile` 只有 Promise 接口。所有调用点本来就在 async 函数里。
 */
export async function writeQuestionExports(s: Session, backlog: QuestionBacklog): Promise<void> {
  // Python 侧 `s.dir` 在建会话时就已经建好；这里补一次幂等的 mkdir，免得一条
  // 「专门用来产出文件」的路由死在 ENOENT 上。
  mkdirSync(s.dir, { recursive: true });

  // key=(priority != BLOCKING, created_at, id)：阻塞项排最前。
  const sorted = [...backlog.questions.values()].sort((a, b) => {
    const ba = a.priority !== QuestionPriority.BLOCKING ? 1 : 0;
    const bb = b.priority !== QuestionPriority.BLOCKING ? 1 : 0;
    if (ba !== bb) return ba - bb;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return cmpCodePoint(a.id, b.id);
  });
  const rows = sorted.map((q) => questionPayload(q));

  writeFileSync(
    join(s.dir, "问题清单.json"),
    pyJsonIndent({ schemaVersion: "1.0.0", questions: rows, summary: backlog.stats() }, 2),
    "utf8",
  );

  // md 走的是 **插入序**（`backlog.questions.values()`），不是上面那份排序 ——
  // 照抄，别"顺手统一"：两份文件的编号会因此对不上，而顾问是按编号沟通的。
  const all = [...backlog.questions.values()];
  const unclosed = all.filter((q) => !q.terminal).length;
  const lines: string[] = [
    `# ${s.project || s.title} · 待澄清问题`,
    "",
    `共 ${rows.length} 条，未关闭 ${unclosed} 条。`,
    "",
  ];
  all.forEach((q, i) => {
    lines.push(
      `## ${i + 1}. ${q.text}`,
      "",
      `- 状态：${q.status}`,
      `- 优先级：${q.priority}`,
      `- 回答对象：${q.audienceRole || "待分派"}`,
      `- 负责人：${q.ownerUserId || "待分派"}`,
    );
    if (pyTruthy(q.why)) lines.push(`- 为什么问：${q.why}`);
    if (q.blockedArtifacts.length > 0) {
      lines.push(`- 阻塞产物：${q.blockedArtifacts.join("、")}`);
    }
    lines.push("");
  });
  writeFileSync(join(s.dir, "问题清单.md"), lines.join("\n"), "utf8");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("待澄清问题");
  ws.addRow([...EXPORT_HEADERS]);
  all.forEach((q, i) => {
    // openpyxl 的 `value=""` 落盘就是一个没有值的格；写成空串会让 ISBLANK /
    // COUNTA 的结果变掉，而业务方的表里常有这类公式。
    const values: (string | number | null)[] = [
      i + 1,
      q.text,
      String(q.status),
      String(q.priority),
      q.audienceRole,
      q.ownerUserId,
      q.why,
      q.dependencies.join("、"),
      q.blockedArtifacts.join("、"),
      q.id,
    ];
    ws.addRow(values.map((v) => (v === "" ? null : v)));
  });
  // freeze_panes = "A2"：只冻结表头那一行。
  ws.views = [{ state: "frozen", ySplit: 1 }];
  // auto_filter.ref = ws.dimensions —— openpyxl 的 dimensions 是真实占用区间。
  ws.autoFilter = `A1:${columnLetter(EXPORT_HEADERS.length)}${all.length + 1}`;
  EXPORT_WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  await wb.xlsx.writeFile(join(s.dir, "问题清单.xlsx"));

  s.state["artifacts"] = readdirSync(s.dir)
    .filter((n) => statSync(join(s.dir, n)).isFile())
    .sort(cmpCodePoint);
}

/** 列号 → 列字母（openpyxl 的 `chr(64 + i)` 只覆盖 A–Z，这里做全）。 */
function columnLetter(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = n % 26 || 26;
    out = String.fromCharCode(64 + rem) + out;
    n = (n - rem) / 26;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  PATCH / reopen 的实现体
// ══════════════════════════════════════════════════════════════════

const PENDING_STATUSES: ReadonlySet<string> = new Set([
  QuestionStatus.OPEN,
  QuestionStatus.ASSIGNED,
  QuestionStatus.BLOCKED,
]);

/** `_question_update_once`（server.py:4096）。 */
export async function questionUpdateOnce(
  s: Session,
  qid: string,
  body: Record<string, unknown>,
  deps: QuestionDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? (() => Date.now() / 1000);
  const [backlog] = await loadQuestionDomain(s);
  const q = backlog.questions.get(qid);
  if (q === undefined) throw new HTTPException(404, { message: `没有问题 ${qid}` });
  const expected = expectedVersionOf(body);
  const originalVersion = q.version;
  if (expected !== null && q.version !== expected) {
    throw new HTTPException(409, {
      message: `问题已更新：预期 version ${expected}，实际 ${q.version}`,
    });
  }
  const ownerRaw = orNull(getChain(body, ["ownerUserId", "owner_user_id"]));
  const role = orNull(getChain(body, ["audienceRole", "audience_role"]));
  const priority = orNull(body["priority"]);
  const status = orNull(body["status"]);
  const touched = ["ownerUserId", "owner_user_id", "audienceRole", "audience_role", "priority", "status"];
  if (!touched.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    throw new HTTPException(400, { message: "没有可更新的 Question 字段" });
  }
  let targetStatus: QuestionStatus | null = null;
  if (status !== null) {
    try {
      targetStatus = parseStatus(pyStr(status));
    } catch {
      throw new HTTPException(400, { message: `不支持的问题状态 ${pyStr(status)}` });
    }
    if (targetStatus === QuestionStatus.ANSWERED) {
      throw new HTTPException(400, { message: "answered 必须通过 /answer 记录 Decision" });
    }
  }
  if (ownerRaw !== null) {
    const owner = pyStrip(pyStr(ownerRaw));
    if (pyTruthy(owner)) {
      q.assign(owner, { audienceRole: pyStr(pyTruthy(role) ? role : q.audienceRole) });
    } else {
      q.ownerUserId = "";
      if (q.status === QuestionStatus.ASSIGNED) q.transition(QuestionStatus.OPEN);
    }
  } else if (role !== null) {
    q.audienceRole = pyStrip(pyStr(role));
    q.version += 1;
    q.updatedAt = now();
  }
  if (priority !== null) {
    const rawPriority = pyStr(priority).toLowerCase();
    // 早期前端曾用 medium；稳定领域契约是
    // blocking/high/normal/low。在 API 边界上兼容旧值，库内只存 normal。
    try {
      q.priority = parsePriority(rawPriority === "medium" ? "normal" : rawPriority);
    } catch {
      throw new HTTPException(400, { message: `不支持的优先级 ${pyStr(priority)}` });
    }
    q.version += 1;
    q.updatedAt = now();
  }
  if (status !== null && targetStatus !== q.status) {
    try {
      q.transition(targetStatus as QuestionStatus);
    } catch (exc) {
      if (exc instanceof ValueError) throw new HTTPException(400, { message: exc.message });
      throw exc;
    }
  }
  // repo CAS 负责只加一次版本；领域对象上多字段修改只算一个 revision。
  q.version = expected !== null ? expected : originalVersion;
  await saveQuestionDomain(s, q, { expected, deps });
  // Closing/reopening the last blocker is semantically the same release boundary
  // as answering it.  Reload from repo first so a concurrent worker cannot leave
  // the durable backlog fully closed while every local copy still saw one open.
  let [authoritative, active] = await refreshAuthoritativeQuestionState(s);
  if (
    status !== null &&
    (targetStatus === QuestionStatus.DEFERRED || targetStatus === QuestionStatus.CANCELLED) &&
    s.state["_oir"] !== null &&
    s.state["_oir"] !== undefined
  ) {
    await deps.recompile(s, { preserveQuestionRows: true });
    [authoritative, active] = await refreshAuthoritativeQuestionState(s);
  }
  const pending = [...authoritative.questions.values()].filter((x) =>
    PENDING_STATUSES.has(x.status),
  ).length;
  s.status = pending ? "awaiting_answer" : "done";
  await deps.persist(s);
  const row = authoritative.questions.get(q.id);
  if (row === undefined) throw new KeyError(q.id); // Python 是 `authoritative.questions[q.id]`
  return {
    question: questionPayload(row, active.get(q.id) ?? null),
    summary: authoritative.stats(),
    status: s.status,
  };
}

/** `_question_reopen_once`（server.py:4180）。 */
export async function questionReopenOnce(
  s: Session,
  qid: string,
  body: Record<string, unknown>,
  deps: QuestionDeps,
): Promise<Record<string, unknown>> {
  const [backlog] = await loadQuestionDomain(s);
  const q = backlog.questions.get(qid);
  if (q === undefined) throw new HTTPException(404, { message: `没有问题 ${qid}` });
  const expected = expectedVersionOf(body);
  const originalVersion = q.version;
  try {
    q.transition(QuestionStatus.OPEN);
  } catch (exc) {
    if (exc instanceof ValueError) throw new HTTPException(400, { message: exc.message });
    throw exc;
  }
  q.version = expected !== null ? expected : originalVersion;
  await saveQuestionDomain(s, q, { expected, deps });
  s.status = "awaiting_answer";
  await deps.persist(s);
  return { question: questionPayload(q), status: s.status };
}

// ══════════════════════════════════════════════════════════════════
//  /answer 的实现体
// ══════════════════════════════════════════════════════════════════

/**
 * `_predict_decision_effect`（server.py:4221）：在回写前计算 Decision fingerprint
 * 需要的 affectedIds。
 *
 * 这只做纯读投影，不调 `applyDecision`；因此 repo 可以先原子 claim Decision，
 * 重试只有一个请求能得到 `created === true` 并执行副作用。
 */
export function predictDecisionEffect(
  q: Question,
  target: Conflict | null,
  optionId: string,
): string[] {
  if (target === null) return [...q.blockedArtifacts];
  const option = target.options.find((o) => o.id === optionId);
  if (option === undefined) {
    throw new HTTPException(422, {
      message: `冲突 ${target.rid} 没有选项 ${pyRepr(optionId)}`,
    });
  }
  const effect = option.effect;
  if (pyTruthy(effect["split"])) return [...(effect["split"] as string[])];
  const targetRid = effect["unify_to"];
  if (pyTruthy(targetRid)) return target.subjects.filter((rid) => rid !== targetRid);
  if (pyTruthy(effect["set_base_type"])) return [...target.subjects];
  return [];
}

/**
 * `_recover_applied_answer_release`（server.py:4240）。
 *
 * Finish the durable release boundary for an already-applied Decision.
 *
 * The Decision claim/finalize, Question lifecycle update and engagement
 * checkpoint deliberately live in separate durable records.  A worker can die
 * after the first two commits and before INTERVIEW is resumed.  Retrying the
 * same idempotency key must therefore do more than echo the old Decision: it
 * reloads repo-owned interview state and, when no release blocker remains,
 * resumes (or migrates) the deterministic engagement journal.
 *
 * A completed engagement with an on-disk package is left untouched, so normal
 * network retries do not mint artifact revisions.  Ordinary non-blocking open
 * questions still keep the session in `awaiting_answer` while the DRAFT
 * package remains downloadable.
 */
export async function recoverAppliedAnswerRelease(
  s: Session,
  deps: QuestionDeps,
): Promise<[QuestionBacklog, Map<string, Decision>, number]> {
  let [authoritative, active] = await refreshAuthoritativeQuestionState(s);
  let pendingRows = [...authoritative.questions.values()].filter((q) =>
    PENDING_STATUSES.has(q.status),
  );
  const releaseBlockers = pendingRows.filter((q) => q.blocking);
  const execution = pyTruthy(s.state["engagement_execution"])
    ? (s.state["engagement_execution"] as Record<string, unknown>)
    : {};
  const releaseCheckpointComplete =
    pyStr(pyTruthy(execution["status"]) ? execution["status"] : "") === String(RunStatus.COMPLETED) &&
    pyTruthy(s.state["ontology_package"]) &&
    isFile(join(s.dir, "ontology.package.json"));
  if (
    s.state["_oir"] !== null &&
    s.state["_oir"] !== undefined &&
    releaseBlockers.length === 0 &&
    !releaseCheckpointComplete
  ) {
    await deps.recompile(s, { preserveQuestionRows: true });
    [authoritative, active] = await refreshAuthoritativeQuestionState(s);
    pendingRows = [...authoritative.questions.values()].filter((q) =>
      PENDING_STATUSES.has(q.status),
    );
  }
  const pending = pendingRows.length;
  s.status = pending ? "awaiting_answer" : "done";
  await deps.persist(s);
  return [authoritative, active, pending];
}

/** `_answer_domain_question_once`（server.py:4290）。 */
export async function answerDomainQuestionOnce(
  s: Session,
  qid: string,
  body: Record<string, unknown>,
  deps: QuestionDeps,
): Promise<Record<string, unknown>> {
  const repo = currentRepo();
  const [backlog] = await loadQuestionDomain(s);
  const q = backlog.questions.get(qid);
  if (q === undefined) throw new HTTPException(404, { message: `没有问题 ${qid}` });
  const expected = expectedVersionOf(body);
  const originalVersion = q.version;
  if (expected !== null && q.version !== expected) {
    throw new HTTPException(409, {
      message: `问题已更新：预期 version ${expected}，实际 ${q.version}`,
    });
  }
  const answerValue = getChain(body, ["answer", "option_id", "answerText"]) ?? null;
  if (answerValue === null || answerValue === "") {
    throw new HTTPException(400, { message: "answer 不能为空" });
  }
  // 非 conflict 的 enum UI 可能提交 option id；其 schema 已声明 enum，可直接校验。
  try {
    q.validateAnswer(answerValue);
  } catch (exc) {
    throw new HTTPException(422, { message: excMessage(exc) });
  }
  const idem = pyStrip(pyStr(pyTruthy(getChain(body, ["idempotencyKey", "idempotency_key"])) ? getChain(body, ["idempotencyKey", "idempotency_key"]) : ""));
  if (!idem) throw new HTTPException(400, { message: "idempotencyKey 必填" });

  const actor = pyStr(pyTruthy(body["actor"]) ? body["actor"] : "fde");
  const actorRole = pyStr(pyTruthy(body["actorRole"]) ? body["actorRole"] : q.audienceRole);
  const authority = pyStr(pyTruthy(body["authority"]) ? body["authority"] : "");
  const sourceTurn = pyStr(pyTruthy(body["sourceTurn"]) ? body["sourceTurn"] : "");
  const rationale = pyStr(
    pyTruthy(body["answerText"]) ? body["answerText"] : pyTruthy(body["note"]) ? body["note"] : "",
  );

  // 先查幂等记录。副作用（applyDecision / OpenQuestion 回写）只能发生在新请求上；
  // 如果先 mutate 再去 repo 判重，网络重试会把同一决定应用两次。
  const previous =
    (await repo.listDecisionsV1(s.id)).find((r) => r.idempotency_key === idem) ?? null;
  if (previous !== null) {
    const probe = new Decision({
      id: "",
      questionId: q.id,
      answer: answerValue,
      actor,
      actorRole,
      authority,
      sourceTurn,
      affectedIds: [...previous.affected_ids],
      idempotencyKey: idem,
      rationale,
    });
    if (previous.semantic_hash !== probe.fingerprint) {
      throw new HTTPException(409, { message: `幂等键 ${pyRepr(idem)} 已用于另一份回答` });
    }
    return await echoPrior(s, q, previous, deps);
  }
  // 已成功记录的幂等重放在任何状态下都可以恢复；但新回答只允许
  // OPEN/ASSIGNED。这一校验必须早于 Decision claim、OIR 回写和 Revision，
  // 否则 deferred/blocked 问题会出现"HTTP 失败但副作用已提交"。
  if (q.status !== QuestionStatus.OPEN && q.status !== QuestionStatus.ASSIGNED) {
    throw new HTTPException(409, {
      message: `问题当前状态为 ${q.status}，不能直接回答；请先重新打开。`,
    });
  }
  let target: Conflict | null = null;
  const optionId = pyStr(pyTruthy(body["option_id"]) ? body["option_id"] : answerValue);
  if (q.sourceKind === "conflict" || q.sourceRef.startsWith("cf_")) {
    const conflicts = (pyTruthy(s.state["_conflicts"]) ? s.state["_conflicts"] : []) as Conflict[];
    target = conflicts.find((c) => c.rid === q.sourceRef) ?? null;
    if (target === null) {
      throw new HTTPException(409, { message: `冲突 ${q.sourceRef} 尚未恢复，不能应用回答` });
    }
  }
  const affectedIds = predictDecisionEffect(q, target, optionId);
  const decision = new Decision({
    id: "",
    questionId: q.id,
    answer: answerValue,
    actor,
    actorRole,
    authority,
    sourceTurn,
    affectedIds,
    revision: pyIntOr0(s.state["artifact_revision"]) + 1,
    idempotencyKey: idem,
    rationale,
  });
  decision.id = `dec_${decision.fingerprint.slice(0, 20)}`;
  decision.metadata["status"] = "claimed";
  let stored: DecisionRecordRow;
  let created: boolean;
  try {
    [stored, created] = await repo.recordDecisionV1(
      s.id,
      decisionRecordRowFromDomain({ ...asDoc(decision), fingerprint: decision.fingerprint }),
    );
  } catch (exc) {
    if (exc instanceof IdempotencyConflict) {
      throw new HTTPException(409, { message: exc.message });
    }
    throw exc;
  }
  if (!created) return await echoPrior(s, q, stored, deps);

  // 只有取得 claim 的请求才能执行 OIR 副作用。回写失败不删
  // Decision，而是终结为 failed，审计能看到"人回答过但没有生效"。
  let applied: Record<string, unknown> | null = null;
  try {
    if (target !== null) {
      const oir = s.state["_oir"] as OIR;
      const result = applyDecision(oir, target, optionId, { note: rationale });
      applied = { ...result } as unknown as Record<string, unknown>;
      // 预计受影响对象与实际不符时 fail closed，避免指纹/审计说谎。
      const actual = [...result.changed];
      if (!sameSorted(actual, decision.affectedIds)) {
        throw new RuntimeError(
          `Decision effect 预计 ${pyReprList(decision.affectedIds)} ` +
            `与实际 ${pyReprList(actual)} 不一致`,
        );
      }
    }
    const oir = s.state["_oir"] as OIR | null | undefined;
    if (q.sourceKind === "open_question" && oir !== null && oir !== undefined) {
      const oq = oir.questions.get(q.sourceRef || q.id);
      if (oq !== undefined) {
        oq.answer = byUser(
          pyStr(pyTruthy(body["answerText"]) ? body["answerText"] : answerValue),
          `Question Decision ${decision.id}`,
        );
      }
    }
  } catch (exc) {
    // 副作用失败必须耐久标记后才向上报错
    await repo.finalizeDecisionV1(s.id, decision.id, {
      status: "failed",
      error: `${excName(exc)}: ${excMessage(exc)}`,
    });
    throw new HTTPException(422, {
      message: `回答已记录，但回写 Ontology 失败：${excMessage(exc)}`,
    });
  }
  const finalized = await repo.finalizeDecisionV1(s.id, decision.id, { status: "applied" });
  decision.metadata = { ...finalized.metadata };
  q.transition(QuestionStatus.ANSWERED);
  q.version = expected !== null ? expected : originalVersion;
  await saveQuestionDomain(s, q, { expected, deps });
  const liveOir = s.state["_oir"] as OIR | null | undefined;
  s.state["oir"] =
    liveOir !== null && liveOir !== undefined ? liveOir.toDict() : s.state["oir"] ?? null;
  if (q.sourceRef.startsWith("cf_")) {
    const answered = new Set(
      Array.isArray(s.state["answered"]) ? (s.state["answered"] as string[]) : [],
    );
    answered.add(q.sourceRef);
    s.state["answered"] = [...answered].sort(cmpCodePoint);
  }
  // 回答本身形成一个耐久 revision，供工作台查看与 artifact lineage 引用。
  // id/ordinal 只是 placeholder，repo.appendRevision 持有 session 锁发号。
  const rev = new Revision({
    id: "rev.pending",
    ordinal: 0,
    parentId: null,
    kind: "question_answer",
    status: RevisionStatus.APPLIED,
    patchSet: new PatchSet({
      id: `patch.${decision.id}`,
      baseRevision: 0,
      ops: [],
      affectedIds: decision.affectedIds,
      idempotencyKey: idem,
      actor: decision.actor,
      reason: decision.rationale,
    }),
    changedIds: decision.affectedIds,
    invalidatedArtifacts: q.blockedArtifacts,
    actor: decision.actor,
    sourceTurn: decision.sourceTurn,
  });
  await repo.appendRevision(s.id, revisionRowFromDomain(asDoc(rev), `answer:${idem}`));
  // Question/Decision rows—not this worker's Session cache—are authoritative.
  // This reload also projects another worker's just-finalized answer back into the
  // latest OIR before deterministic finish/canonicalization runs.
  let [authoritative, active] = await refreshAuthoritativeQuestionState(s);
  if (s.state["_oir"] !== null && s.state["_oir"] !== undefined) {
    await deps.recompile(s, { preserveQuestionRows: true });
    [authoritative, active] = await refreshAuthoritativeQuestionState(s);
  }
  const pending = [...authoritative.questions.values()].filter((row) =>
    PENDING_STATUSES.has(row.status),
  ).length;
  s.status = pending ? "awaiting_answer" : "done";
  await deps.persist(s);
  s.emit("question.answered", {
    question: q.id,
    decision: decision.id,
    pending,
    affected: decision.affectedIds as unknown as JsonValue,
  });
  const row = authoritative.questions.get(q.id);
  if (row === undefined) throw new KeyError(q.id);
  return {
    decision: decision.toDict(),
    created: true,
    question: questionPayload(row, active.get(q.id) ?? decision),
    pending,
    status: s.status,
    applied,
  };
}

/**
 * 幂等重放的公共出口：把已存在的 Decision 原样回显，并补完那次未走完的
 * release boundary。**返回的 `created` 恒为 false**，调用方据此知道自己没有
 * 执行任何副作用。
 */
async function echoPrior(
  s: Session,
  q: Question,
  storedRow: DecisionRecordRow,
  deps: QuestionDeps,
): Promise<Record<string, unknown>> {
  const effectStatus = pyStr(
    pyTruthy(storedRow.metadata["status"]) ? storedRow.metadata["status"] : "applied",
  );
  if (effectStatus === "failed") {
    const err = pyTruthy(storedRow.metadata["error"]) ? storedRow.metadata["error"] : "未知错误";
    throw new HTTPException(409, { message: `上次回答回写失败：${pyStr(err)}` });
  }
  if (effectStatus === "claimed") {
    throw new HTTPException(409, { message: "这个回答正在由另一个请求应用，请稍后刷新" });
  }
  const prior = decisionFromRow(storedRow);
  const [authoritative, active, pending] = await recoverAppliedAnswerRelease(s, deps);
  return {
    decision: prior.toDict(),
    created: false,
    question: questionPayload(authoritative.questions.get(q.id) ?? q, active.get(q.id) ?? prior),
    pending,
    status: s.status,
    applied: null,
  };
}

/**
 * `_answer_domain_question`（server.py:4199）。
 *
 * **双重加锁的顺序照抄**：`_session_mutation` 在外、`question_lock` 在内。
 * `mutationClaimed` 表示调用方（chat 工具那条路）已经持有 mutation 租约，
 * 这时只加 question_lock —— 再抢一次租约会被自己挡在 409 上。
 */
export async function answerDomainQuestion(
  s: Session,
  qid: string,
  body: Record<string, unknown>,
  deps: QuestionDeps,
  opts: { mutationClaimed?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (opts.mutationClaimed === true) {
    return await s.questionLock.run(async () => await answerDomainQuestionOnce(s, qid, body, deps));
  }
  return await deps.sessionMutation(
    s,
    "question.answer",
    async () =>
      await s.questionLock.run(async () => await answerDomainQuestionOnce(s, qid, body, deps)),
  );
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/** `QuestionStatus(value)`：未知值抛。 */
function parseStatus(v: string): QuestionStatus {
  const all = Object.values(QuestionStatus) as string[];
  if (!all.includes(v)) throw new ValueError(`未知的 QuestionStatus: ${pyRepr(v)}`);
  return v as QuestionStatus;
}

/** `QuestionPriority(value)`：未知值抛。 */
function parsePriority(v: string): QuestionPriority {
  const all = Object.values(QuestionPriority) as string[];
  if (!all.includes(v)) throw new ValueError(`未知的 QuestionPriority: ${pyRepr(v)}`);
  return v as QuestionPriority;
}

/** `int(x or 0)`。 */
function pyIntOr0(v: unknown): number {
  if (!pyTruthy(v)) return 0;
  if (typeof v === "number") return Math.trunc(v);
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

/** `type(exc).__name__`。 */
function excName(exc: unknown): string {
  if (exc instanceof Error) return exc.constructor.name;
  return "Exception";
}

/** `str(exc)`。 */
function excMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python `f"{list}"` —— `['a', 'b']`。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map((x) => pyRepr(x)).join(", ")}]`;
}

/** `sorted(a) != sorted(b)` 的否定。 */
function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort(cmpCodePoint);
  const y = [...b].sort(cmpCodePoint);
  return x.every((v, i) => v === y[i]);
}

/**
 * 领域对象的 `toDict()` 声明成 `Record<string, unknown>`，而 `store/types.ts` 的
 * `HasToDict` 要 `JsonObject`。内容本来就是纯 JSON，这里只抹掉这层名义差异
 * （与 `artifacts.ts:811` 同一个接缝、同一个理由）。
 */
function asDoc<T extends { toDict(): Record<string, unknown> }>(v: T): { toDict(): JsonObject } {
  return { toDict: () => v.toDict() as JsonObject };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** FastAPI 的 `limit: int = 0`：非整数一律 422（载荷形状见 `http422.ts`）。 */
function queryInt(raw: string | undefined, dflt: number, key: string): number {
  if (raw === undefined) return dflt;
  const v = pydanticInt(raw);
  if (v === null) raise422(intParsingError(["query", key], raw));
  return v;
}

/** `body: dict`。空体/坏 JSON/非对象各是一种 pydantic 错误，见 `jsonObjectBody`。 */
async function jsonBody(c: { req: { text: () => Promise<string> } }): Promise<
  Record<string, unknown>
> {
  return await jsonObjectBody(c);
}

/** `body: dict | None = None` —— reopen 那条允许空体。 */
async function optionalJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const raw = await c.req.json();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════
//  路由
// ══════════════════════════════════════════════════════════════════

const EXPORT_NAMES: Readonly<Record<string, string>> = {
  xlsx: "问题清单.xlsx",
  md: "问题清单.md",
  json: "问题清单.json",
};

const EXPORT_MEDIA: Readonly<Record<string, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
};

export function registerQuestionRoutes(app: Hono<AppEnv>, deps: QuestionDeps): void {
  // ── 列表 ────────────────────────────────────────────────────────
  //
  // **`export` 必须先注册**：Hono 与 FastAPI 一样是先到先匹配，`/questions/:qid`
  // 会把 `/questions/export` 也吃掉。Python 侧靠 `questions_export` 的装饰器
  // 位置解决（它在 4460、`question_update` 在 4088 —— 但 PATCH 与 GET 方法不同
  // 所以不冲突）。这里的 GET 只有列表和导出两条，顺序无歧义，仍显式写在前面。
  app.get("/api/sessions/:sid/questions/export", async (c) => {
    const sid = c.req.param("sid");
    const format = c.req.query("format") ?? "xlsx";
    const s = await sessAsync(sid);
    const backlog = questionBacklog(s);
    await writeQuestionExports(s, backlog);
    const fmt = format.toLowerCase();
    const name = EXPORT_NAMES[fmt];
    if (name === undefined) {
      throw new HTTPException(400, { message: "format 只支持 xlsx、md、json" });
    }
    const p = join(s.dir, name);
    const data = readFileSync(p);
    return c.body(new Uint8Array(data).buffer as ArrayBuffer, 200, {
      "Content-Type": EXPORT_MEDIA[fmt] as string,
      "Content-Disposition": contentDisposition(name),
    });
  });

  app.get("/api/sessions/:sid/questions", async (c) => {
    const sid = c.req.param("sid");
    const limit = queryInt(c.req.query("limit"), 0, "limit");
    const s = await sessAsync(sid);
    if (
      !pyTruthy(s.state["question_backlog"]) &&
      s.state["_oir"] !== null &&
      s.state["_oir"] !== undefined
    ) {
      await deps.syncQuestionBacklog(s);
    }
    const [backlog, active] = await loadQuestionDomain(s);
    const batch = backlog.nextBatch({ limit: Math.max(1, Math.min(limit || 5, 50)) });
    const rows = [...backlog.questions.values()].map((q) =>
      questionPayload(q, active.get(q.id) ?? null),
    );
    const versions = [...backlog.questions.values()].map((q) => q.version);
    return c.json({
      questions: rows,
      summary: backlog.stats(),
      nextBatch: batch.map((q) => q.id),
      revision: versions.length > 0 ? Math.max(...versions) : 0,
    });
  });

  // ── 改负责人 / 角色 / 优先级 / 状态 ─────────────────────────────
  app.patch("/api/sessions/:sid/questions/:qid", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const qid = c.req.param("qid");
    const body = await jsonBody(c);
    // 双重加锁：mutation 租约在外，question_lock 在内（server.py:4091）。
    return c.json(
      await deps.sessionMutation(
        s,
        "question.update",
        async () => await s.questionLock.run(async () => await questionUpdateOnce(s, qid, body, deps)),
      ),
    );
  });

  // ── 重新打开 ────────────────────────────────────────────────────
  app.post("/api/sessions/:sid/questions/:qid/reopen", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const qid = c.req.param("qid");
    const body = await optionalJsonBody(c);
    return c.json(
      await deps.sessionMutation(
        s,
        "question.reopen",
        async () => await s.questionLock.run(async () => await questionReopenOnce(s, qid, body, deps)),
      ),
    );
  });

  // ── 回答 ────────────────────────────────────────────────────────
  app.post("/api/sessions/:sid/questions/:qid/answer", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const qid = c.req.param("qid");
    const body = await jsonBody(c);
    return c.json((await answerDomainQuestion(s, qid, body, deps)) as JsonObject);
  });

  // ── 版本流水 ────────────────────────────────────────────────────
  app.get("/api/sessions/:sid/revisions", async (c) => {
    const sid = c.req.param("sid");
    await sessAsync(sid);
    const rows = await currentRepo().listRevisions(sid);
    const ordinals = rows.map((r) => r.ordinal);
    return c.json({
      revisions: rows.map((r) => r.doc),
      count: rows.length,
      current: ordinals.length > 0 ? Math.max(...ordinals) : 0,
    });
  });

  // ── 旧 conflict API 的兼容入口 ──────────────────────────────────
  /** 内部复用统一 Decision Ledger 幂等路径 —— 不要在这里另开一条写路。 */
  app.post("/api/sessions/:sid/answer", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const body = await jsonBody(c);
    const conflictRid = pyStr(pyTruthy(body["conflict_rid"]) ? body["conflict_rid"] : "");
    let backlog = questionBacklog(s);
    let q = [...backlog.questions.values()].find((x) => x.sourceRef === conflictRid) ?? null;
    if (q === null) {
      // 历史会话尚未建立统一 backlog 时即时迁移。
      backlog = await deps.syncQuestionBacklog(s, {
        clarification: (pyTruthy(s.state["questions"]) ? s.state["questions"] : []) as unknown[],
        conflicts: (pyTruthy(s.state["_conflicts"]) ? s.state["_conflicts"] : []) as unknown[],
      });
      q = [...backlog.questions.values()].find((x) => x.sourceRef === conflictRid) ?? null;
    }
    if (q === null) throw new HTTPException(404, { message: `没有冲突 ${conflictRid}` });
    const compat: Record<string, unknown> = { ...body };
    compat["answer"] = body["option_id"] ?? null;
    compat["answerText"] = Object.prototype.hasOwnProperty.call(body, "note") ? body["note"] : "";
    if (!Object.prototype.hasOwnProperty.call(compat, "actor")) compat["actor"] = "fde";
    // 旧调用方没有幂等头，以 session+conflict+option 生成稳定键；相同回答天然重放。
    if (!Object.prototype.hasOwnProperty.call(compat, "idempotencyKey")) {
      const opt = Object.prototype.hasOwnProperty.call(body, "option_id")
        ? pyStr(body["option_id"])
        : "";
      compat["idempotencyKey"] = `legacy:${s.id}:${conflictRid}:${opt}`;
    }
    return c.json((await answerDomainQuestion(s, q.id, compat, deps)) as JsonObject);
  });
}
