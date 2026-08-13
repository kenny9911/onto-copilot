/**
 * FDE 访谈中的统一 Question / Decision / Revision 领域契约。
 * 移植自 `src/ontocopilot/onto/questions.py`，由 `golden/questions.json` 钉住。
 *
 * 现有产品有两套问题：OIR `OpenQuestion` 与 conflict 澄清卡。本模块不删除它们，
 * 而是提供一个稳定的兼容层，把两者投影进同一份 `QuestionBacklog`。答案不会
 * 直接覆盖问题文本，而是 append-only 地写进 `DecisionLedger`；修改则表示为
 * 基于明确版本的 `PatchSet` / `Revision`。
 *
 * 模块只含纯领域逻辑，不依赖 HTTP 框架、数据库或模型，因而可以在 API、Agent DAG、
 * CLI 与测试里共同使用。持久化 DTO 在 `store/repo`，两层通过 `toDict/fromDict`
 * 的 JSON 契约解耦。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`_now()` 是秒不是毫秒**（`time.time()`）。写成 `Date.now()` 会让
 *     `created_at` 差三个数量级，而 `next_batch` 和 `to_dict` 都按它排序 ——
 *     排序一漂，交给顾问的清单顺序就变了。见 `timeSource`。
 *  2. **排序基准是 code point**（Python `sorted`），不是 UTF-16 code unit。
 *     `sorted(affected_ids)` 进指纹、`next_batch` 的末位 tie-break 是 `q.id`。
 *  3. **`str()` / `repr()` 的形态**。校验失败的消息里有 `{kinds}`（list 的 str）
 *     和 `{const!r}`（repr）—— 这些串会原样发给用户和写进日志。见 `pyReprAny`。
 *  4. **`len(str)` 是 code point 数**：`minLength` / `maxLength` 校验的是字数，
 *     按 UTF-16 数会让一串中文/emoji 凭空变长一倍。
 *  5. **Python 的 `int` 与 `float` 在 JS 里是同一种数**。`{"type":"integer"}`
 *     的校验只能退化成 `Number.isInteger`：Python 会拒绝 `3.0`，TS 不会。
 *     这条无法在 JS 里修 —— JSON 往返本来就把 `3.0` 塌成 `3`。
 *  6. **异常没有 `ValueError` 这层祖先**。Python 侧四个领域异常都继承 ValueError，
 *     `_as_status` 里 `except ValueError` 同时接住枚举解析错误和它们。TS 侧
 *     用 `ValueError` 基类把这层还原出来，不然 catch 的范围会悄悄变。
 */

import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import { pyRepr } from "../kernel/errors.js";
import { type OpenQuestion as OirOpenQuestion, questionToDict } from "./oir.js";

export const SCHEMA_VERSION = "1.0.0";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的 `\s`（str 模式）= Unicode White_Space ∪ U+001C–U+001F。
 * 与 `gaps.ts` 里的同名常量重复了一份 —— 依赖方向不该是 questions → gaps。 */
const PY_S = "[\\p{White_Space}\\x1c-\\x1f]";
const PY_LSTRIP_RE = new RegExp(`^${PY_S}+`, "u");
const PY_RSTRIP_RE = new RegExp(`${PY_S}+$`, "u");

/** `str.strip()`。 */
function pyStrip(s: string): string {
  return s.replace(PY_LSTRIP_RE, "").replace(PY_RSTRIP_RE, "");
}

/** Python 的真值判断：`[]` / `{}` / `""` / `0` 全是假。整个 from_dict 里的
 * `x or y or z` 链条都靠它 —— 按 JS 语义写，`{}` 和 `[]` 会变成"有值"。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number" && Number.isNaN(v)) return true; // Python: bool(nan) is True
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** JSON 意义上的"字典"。Python 侧判的是 `isinstance(x, Mapping)`，list 不算。 */
function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `len(s)` —— Python 数 code point。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** Python `sorted()` 的字符串比较：按 code point，不是 UTF-16 code unit。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/**
 * Python 的 `str(x)`。
 *
 * **已知且无法在 JS 里修的分叉**：Python 的 `str(1.0)` 是 `"1.0"`，JS 里 1 与 1.0
 * 是同一个值，只能给 `"1"`。这条路径上的数都来自 JSON（`1.0` 在 parse 时就塌成
 * 整数了），所以实际影响面是"手写一个整数值的 float 再打印"这一种。
 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (typeof v === "string") return v;
  return pyReprAny(v);
}

/**
 * Python 的 `repr(x)`，够用的子集（None / bool / 数 / str / list / dict）。
 *
 * 校验失败的消息里有三处 —— `{kinds}`（list 的 str，与 repr 同形）、
 * `{const!r}`、`{enum!r}`。这些串会原样返回给调用方并写进日志，形态不能漂。
 * 字符串走 `errors.ts` 的 `pyRepr`（单双引号与转义规则已做到零差异）。
 */
function pyReprAny(v: unknown): string {
  if (typeof v === "string") return pyRepr(v);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return pyStr(v);
  if (Array.isArray(v)) return `[${v.map(pyReprAny).join(", ")}]`;
  if (isMapping(v)) {
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyReprAny(x)}`).join(", ")}}`;
  }
  return String(v);
}

/** Python 的 `float(x)`。不可转换时抛 —— 绝不静默变成 NaN 混进 information_gain。 */
function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = pyStrip(v);
    if (t !== "") {
      const n = Number(t);
      if (!Number.isNaN(n) || /^[+-]?nan$/i.test(t)) return n;
    }
  }
  throw new TypeError(`float() 接不了 ${JSON.stringify(v)}`);
}

/** Python 的 `int(x)`：float 向零截断，str 必须是整数字面量。 */
function pyInt(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = pyStrip(v);
    if (/^[+-]?[0-9]+$/.test(t)) return Number(t);
  }
  throw new TypeError(`int() 接不了 ${JSON.stringify(v)}`);
}

/** `d.get(k)` —— 键不存在给 None；TS 侧统一成 undefined，判真时等价。 */
function get(d: Record<string, unknown>, k: string): unknown {
  return d[k];
}

/** `d.get(k, default)` —— 只有**键缺失**才给默认值；键在但值是 None 就给 None。 */
function getOr(d: Record<string, unknown>, k: string, dflt: unknown): unknown {
  return Object.hasOwn(d, k) ? d[k] : dflt;
}

/** `list(x or [])`，元素照原样。 */
function pyListOr(v: unknown): unknown[] {
  if (!pyTruthy(v)) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v]; // Python 的 list(str) 拆成单字符
  if (isMapping(v)) return Object.keys(v); // list(dict) 是键
  throw new TypeError(`list() 接不了 ${JSON.stringify(v)}`);
}

function pyStrListOr(v: unknown): string[] {
  return pyListOr(v).map(pyStr);
}

/**
 * `time.time()` —— **秒**。
 *
 * 留成可替换的钩子：golden 导出脚本靠 monkeypatch `time.time` 冻结时间，
 * TS 侧要对得上就得有同一个开关。默认实现不缓存，与 Python 一致。
 */
export const timeSource: { now(): number } = { now: () => Date.now() / 1000 };

function now(): number {
  return timeSource.now();
}

/** `now or _now()` —— 注意 `now=0` 在两边都落回当前时间。 */
function nowOr(v: number | null | undefined): number {
  return v ? v : now();
}

/** `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",",":"))`。
 *
 * 与 Python 的两处差别都在"不该出现的输入"上：Python 有 `default=str` 兜底、
 * 允许 NaN/Infinity，`kernel/ids.ts` 的实现直接抛。指纹输入必须是纯数据，
 * 静默把一个对象序列化成 `[object Object]` 比崩掉恶劣得多。 */
function canonical(value: unknown): string {
  return canonicalJson(value);
}

function digest(prefix: string, value: unknown, size = 20): string {
  return `${prefix}_${sha256Hex(canonical(value)).slice(0, size)}`;
}

// ══════════════════════════════════════════════════════════════════
//  枚举
// ══════════════════════════════════════════════════════════════════

export const QuestionStatus = {
  OPEN: "open",
  ASSIGNED: "assigned",
  BLOCKED: "blocked",
  ANSWERED: "answered",
  DEFERRED: "deferred",
  CANCELLED: "cancelled",
} as const;
export type QuestionStatus = (typeof QuestionStatus)[keyof typeof QuestionStatus];

export const QuestionPriority = {
  BLOCKING: "blocking",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
} as const;
export type QuestionPriority = (typeof QuestionPriority)[keyof typeof QuestionPriority];

export const RevisionStatus = {
  PROPOSED: "proposed",
  APPLIED: "applied",
  REJECTED: "rejected",
  ROLLED_BACK: "rolled_back",
} as const;
export type RevisionStatus = (typeof RevisionStatus)[keyof typeof RevisionStatus];

// ══════════════════════════════════════════════════════════════════
//  异常
// ══════════════════════════════════════════════════════════════════

// ValueError 收在 kernel/errors.ts —— 两份同名类就是两个类身份，
// `instanceof` 会漏掉其中一份且不报错。这里只 re-export，保住本模块的公开 API。
import { ValueError } from "../kernel/errors.js";
export { ValueError };

/**
 * Python `KeyError` 的替身。
 *
 * `backlog.questions[qid]` 缺键时 Python 抛的就是它，而 `str(e)` **只有键的 repr**
 * （`'没有这个问题'`），不带 "KeyError:" 前缀 —— 这条消息会顺着 API 冒到用户面前，
 * 形态不能自己发明。
 */
export class KeyError extends Error {
  constructor(readonly key: string) {
    super(pyRepr(key));
    this.name = "KeyError";
    Object.setPrototypeOf(this, KeyError.prototype);
  }
}

/** 问题状态转换不合法。 */
export class QuestionTransitionError extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "QuestionTransitionError";
    Object.setPrototypeOf(this, QuestionTransitionError.prototype);
  }
}

/** 回答不符合问题的 `answerSchema`。 */
export class AnswerValidationError extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "AnswerValidationError";
    Object.setPrototypeOf(this, AnswerValidationError.prototype);
  }
}

/** 同一幂等键被用于不同的业务动作。 */
export class IdempotencyConflict extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflict";
    Object.setPrototypeOf(this, IdempotencyConflict.prototype);
  }
}

/** PatchSet 的 base revision 不是当前 revision。 */
export class RevisionConflict extends ValueError {
  constructor(message: string) {
    super(message);
    this.name = "RevisionConflict";
    Object.setPrototypeOf(this, RevisionConflict.prototype);
  }
}

/** `QuestionStatus(v)` 的等价物：未知值抛 ValueError。别用 `as` 断言 ——
 * 那是把校验删掉，而 `_as_status` 的整条回退链就建立在"它会抛"上面。 */
export function parseQuestionStatus(v: unknown): QuestionStatus {
  const s = pyStr(v);
  for (const x of Object.values(QuestionStatus)) if (x === s) return x;
  throw new ValueError(`'${s}' is not a valid QuestionStatus`);
}

export function parseQuestionPriority(v: unknown): QuestionPriority {
  const s = pyStr(v);
  for (const x of Object.values(QuestionPriority)) if (x === s) return x;
  throw new ValueError(`'${s}' is not a valid QuestionPriority`);
}

export function parseRevisionStatus(v: unknown): RevisionStatus {
  const s = pyStr(v);
  for (const x of Object.values(RevisionStatus)) if (x === s) return x;
  throw new ValueError(`'${s}' is not a valid RevisionStatus`);
}

const TRANSITIONS: Readonly<Record<QuestionStatus, ReadonlySet<QuestionStatus>>> = {
  [QuestionStatus.OPEN]: new Set<QuestionStatus>([
    QuestionStatus.ASSIGNED,
    QuestionStatus.BLOCKED,
    QuestionStatus.ANSWERED,
    QuestionStatus.DEFERRED,
    QuestionStatus.CANCELLED,
  ]),
  [QuestionStatus.ASSIGNED]: new Set<QuestionStatus>([
    QuestionStatus.OPEN,
    QuestionStatus.BLOCKED,
    QuestionStatus.ANSWERED,
    QuestionStatus.DEFERRED,
    QuestionStatus.CANCELLED,
  ]),
  [QuestionStatus.BLOCKED]: new Set<QuestionStatus>([
    QuestionStatus.OPEN,
    QuestionStatus.ASSIGNED,
    QuestionStatus.DEFERRED,
    QuestionStatus.CANCELLED,
  ]),
  // 答案被判无效、依赖事实变化时允许显式 reopen；历史 Decision 仍保留。
  [QuestionStatus.ANSWERED]: new Set<QuestionStatus>([
    QuestionStatus.OPEN,
    QuestionStatus.CANCELLED,
  ]),
  [QuestionStatus.DEFERRED]: new Set<QuestionStatus>([
    QuestionStatus.OPEN,
    QuestionStatus.ASSIGNED,
    QuestionStatus.CANCELLED,
  ]),
  [QuestionStatus.CANCELLED]: new Set<QuestionStatus>([QuestionStatus.OPEN]),
};

// ══════════════════════════════════════════════════════════════════
//  兼容层的取值规则
// ══════════════════════════════════════════════════════════════════

/** 读取 `Assertion.to_dict()` 或普通 JSON 的值。 */
function valueOf(raw: unknown): unknown {
  return isMapping(raw) && Object.hasOwn(raw, "value") ? raw["value"] : raw;
}

/** 用 `Map` 而不是普通对象：`aliases["toString"]` 在 JS 里会命中
 * `Object.prototype`，把一个函数当成状态返回 —— Python 的 dict 没有这层原型。 */
const ALIASES = new Map<string, QuestionStatus>([
  ["candidate", QuestionStatus.OPEN],
  ["confirmed", QuestionStatus.ANSWERED],
  ["rejected", QuestionStatus.CANCELLED],
]);

function asStatus(
  raw: unknown,
  opts: { answered?: boolean; owner?: string } = {},
): QuestionStatus {
  if (opts.answered) return QuestionStatus.ANSWERED;
  let status: QuestionStatus;
  try {
    // 注意两个分支取的不是同一个串：别名查表用小写，枚举解析用**原样**的
    // `raw or "open"` —— 所以 `"OPEN"` 走的是"解析失败回落 OPEN"那条路。
    const alias = ALIASES.get(pyStr(pyTruthy(raw) ? raw : "").toLowerCase());
    status = alias ?? parseQuestionStatus(pyStr(pyTruthy(raw) ? raw : "open"));
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    status = QuestionStatus.OPEN;
  }
  // 只有遗留 OpenQuestion（没有显式生命周期）才用 owner 推断 ASSIGNED；统一契约
  // 的显式 `status=open` 必须 round-trip 原样保留。
  const missing = raw === null || raw === undefined || raw === "";
  if (missing && status === QuestionStatus.OPEN && pyTruthy(opts.owner)) {
    return QuestionStatus.ASSIGNED;
  }
  return status;
}

function asPriority(raw: unknown, opts: { blocking?: boolean } = {}): QuestionPriority {
  if (opts.blocking) return QuestionPriority.BLOCKING;
  try {
    return parseQuestionPriority(pyStr(pyTruthy(raw) ? raw : "normal").toLowerCase());
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    return QuestionPriority.NORMAL;
  }
}

// ══════════════════════════════════════════════════════════════════
//  Question
// ══════════════════════════════════════════════════════════════════

export interface QuestionInit {
  id: string;
  text: string;
  status?: QuestionStatus;
  ownerUserId?: string;
  audienceRole?: string;
  answerSchema?: Record<string, unknown>;
  priority?: QuestionPriority;
  dependencies?: readonly string[];
  blockedArtifacts?: readonly string[];
  sourceKind?: string;
  sourceRef?: string;
  why?: string;
  options?: readonly unknown[];
  evidenceIds?: readonly string[];
  scopeRefs?: readonly string[];
  group?: string;
  code?: string;
  informationGain?: number;
  blastRadius?: number;
  createdAt?: number;
  updatedAt?: number;
  version?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 一条可路由、可回答、可追踪产物阻塞关系的问题。
 *
 * 是 class 而不是 interface：它有真正的状态机行为（transition / assign），
 * 而且 `QuestionBacklog.add` 就是原地改它的 status / owner。
 */
export class Question {
  id: string;
  text: string;
  status: QuestionStatus;
  ownerUserId: string;
  audienceRole: string;
  answerSchema: Record<string, unknown>;
  priority: QuestionPriority;
  dependencies: string[];
  blockedArtifacts: string[];
  sourceKind: string;
  sourceRef: string;
  why: string;
  options: unknown[];
  evidenceIds: string[];
  scopeRefs: string[];
  group: string;
  code: string;
  informationGain: number;
  blastRadius: number;
  createdAt: number;
  updatedAt: number;
  version: number;
  metadata: Record<string, unknown>;

  constructor(init: QuestionInit) {
    this.id = init.id;
    this.text = init.text;
    this.status = init.status ?? QuestionStatus.OPEN;
    this.ownerUserId = init.ownerUserId ?? "";
    this.audienceRole = init.audienceRole ?? "";
    // Python 的 `default_factory=lambda: {"type":"string"}` —— 每个实例一份新的，
    // 共享同一个对象的话，一处改 schema 会串到所有默认问题上。
    this.answerSchema = init.answerSchema ? { ...init.answerSchema } : { type: "string" };
    this.priority = init.priority ?? QuestionPriority.NORMAL;
    this.dependencies = [...(init.dependencies ?? [])];
    this.blockedArtifacts = [...(init.blockedArtifacts ?? [])];
    this.sourceKind = init.sourceKind ?? "manual";
    this.sourceRef = init.sourceRef ?? "";
    this.why = init.why ?? "";
    this.options = [...(init.options ?? [])];
    this.evidenceIds = [...(init.evidenceIds ?? [])];
    this.scopeRefs = [...(init.scopeRefs ?? [])];
    this.group = init.group ?? "";
    this.code = init.code ?? "";
    this.informationGain = init.informationGain ?? 0.0;
    this.blastRadius = init.blastRadius ?? 0;
    this.createdAt = init.createdAt ?? now();
    this.updatedAt = init.updatedAt ?? now();
    this.version = init.version ?? 0;
    this.metadata = { ...(init.metadata ?? {}) };
  }

  get terminal(): boolean {
    return this.status === QuestionStatus.ANSWERED || this.status === QuestionStatus.CANCELLED;
  }

  get blocking(): boolean {
    return this.priority === QuestionPriority.BLOCKING || this.blockedArtifacts.length > 0;
  }

  /** 依赖都已关闭且自身可进入访谈批次。 */
  ready(resolvedQuestionIds: Iterable<string>): boolean {
    if (this.status !== QuestionStatus.OPEN && this.status !== QuestionStatus.ASSIGNED) {
      return false;
    }
    const resolved = new Set(resolvedQuestionIds);
    return this.dependencies.every((d) => resolved.has(d));
  }

  transition(target: QuestionStatus | string, opts: { now?: number | null } = {}): void {
    const t = parseQuestionStatus(target);
    if (t === this.status) return;
    if (!TRANSITIONS[this.status].has(t)) {
      throw new QuestionTransitionError(`问题 ${this.id} 不能从 ${this.status} 转为 ${t}`);
    }
    if (t === QuestionStatus.ASSIGNED && !this.ownerUserId) {
      throw new QuestionTransitionError(`问题 ${this.id} 分派前必须指定 owner_user_id`);
    }
    this.status = t;
    this.updatedAt = nowOr(opts.now);
    this.version += 1;
  }

  assign(
    ownerUserId: string,
    opts: { audienceRole?: string | null; now?: number | null } = {},
  ): void {
    const owner = pyStrip(ownerUserId);
    if (!owner) throw new ValueError("owner_user_id 不能为空");
    if (this.status === QuestionStatus.ANSWERED || this.status === QuestionStatus.CANCELLED) {
      throw new QuestionTransitionError(`终态问题 ${this.id} 不能直接分派，请先 reopen`);
    }
    this.ownerUserId = owner;
    // `is not None` —— 显式传空串是"清掉角色"，不传才是"别动"。
    if (opts.audienceRole !== null && opts.audienceRole !== undefined) {
      this.audienceRole = pyStrip(opts.audienceRole);
    }
    if (this.status !== QuestionStatus.ASSIGNED) {
      this.transition(QuestionStatus.ASSIGNED, { now: opts.now ?? null });
    } else {
      this.updatedAt = nowOr(opts.now);
      this.version += 1;
    }
  }

  validateAnswer(answer: unknown): void {
    validateAnswerAgainst(answer, this.answerSchema, "$answer");
  }

  toDict(): Record<string, unknown> {
    return {
      $schema: "ontocopilot.question/1",
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      text: this.text,
      status: this.status,
      ownerUserId: this.ownerUserId,
      audienceRole: this.audienceRole,
      answerSchema: this.answerSchema,
      priority: this.priority,
      dependencies: this.dependencies,
      blockedArtifacts: this.blockedArtifacts,
      sourceKind: this.sourceKind,
      sourceRef: this.sourceRef,
      why: this.why,
      options: this.options,
      evidenceIds: this.evidenceIds,
      scopeRefs: this.scopeRefs,
      group: this.group,
      code: this.code,
      informationGain: this.informationGain,
      blastRadius: this.blastRadius,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this.version,
      metadata: this.metadata,
    };
  }

  /** `dataclasses.replace(q)` —— 逐字段浅拷贝。 */
  clone(): Question {
    return new Question({
      id: this.id,
      text: this.text,
      status: this.status,
      ownerUserId: this.ownerUserId,
      audienceRole: this.audienceRole,
      answerSchema: this.answerSchema,
      priority: this.priority,
      dependencies: this.dependencies,
      blockedArtifacts: this.blockedArtifacts,
      sourceKind: this.sourceKind,
      sourceRef: this.sourceRef,
      why: this.why,
      options: this.options,
      evidenceIds: this.evidenceIds,
      scopeRefs: this.scopeRefs,
      group: this.group,
      code: this.code,
      informationGain: this.informationGain,
      blastRadius: this.blastRadius,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this.version,
      metadata: this.metadata,
    });
  }

  /** 兼容统一契约、OIR OpenQuestion 与 clarify.Question 的字典。 */
  static fromDict(raw: Record<string, unknown>): Question {
    const textRaw = getOr(raw, "text", getOr(raw, "title", getOr(raw, "summary", "")));
    const tv = valueOf(textRaw);
    const text = pyStr(pyTruthy(tv) ? tv : "");
    const answer = valueOf(get(raw, "answer"));
    // `answer not in (None, "", [], {})` —— 注意 `0` 和 `False` 算"已回答"。
    const answered = !(
      answer === null ||
      answer === undefined ||
      answer === "" ||
      (Array.isArray(answer) && answer.length === 0) ||
      (isMapping(answer) && Object.keys(answer).length === 0)
    );
    const firstTruthy = (...vals: unknown[]): unknown => {
      for (const v of vals) if (pyTruthy(v)) return v;
      return vals[vals.length - 1];
    };
    const sourceRef = pyStr(
      firstTruthy(
        get(raw, "sourceRef"),
        get(raw, "conflict_rid"),
        get(raw, "conflictRid"),
        get(raw, "rid"),
        "",
      ),
    );
    const sourceKind = pyStr(
      pyTruthy(get(raw, "sourceKind"))
        ? get(raw, "sourceKind")
        : pyTruthy(get(raw, "conflict_rid")) || pyTruthy(get(raw, "conflictRid"))
          ? "conflict"
          : pyTruthy(get(raw, "rid"))
            ? "open_question"
            : "manual",
    );
    let qid = pyStr(firstTruthy(get(raw, "id"), get(raw, "rid"), ""));
    if (!qid) qid = digest("q", { source: sourceRef, text });
    const owner = pyStr(firstTruthy(get(raw, "ownerUserId"), get(raw, "owner"), ""));
    const statusRaw = get(raw, "status");
    let status = asStatus(statusRaw, { answered, owner });
    // OIR OpenQuestion 的 `status=CANDIDATE` 是建模置信状态，不是任务状态；
    // 有 owner 时在统一队列里应解释成已分派。
    if (
      sourceKind === "open_question" &&
      pyTruthy(owner) &&
      pyStr(pyTruthy(statusRaw) ? statusRaw : "").toLowerCase() === "candidate"
    ) {
      status = QuestionStatus.ASSIGNED;
    }
    const opts = pyListOr(get(raw, "options"));
    let answerSchema: Record<string, unknown> = {};
    const rawSchema = firstTruthy(get(raw, "answerSchema"), get(raw, "answer_schema"), {});
    if (isMapping(rawSchema)) answerSchema = { ...rawSchema };
    if (Object.keys(answerSchema).length === 0) {
      // conflict card 的 option 回答是 option id；普通 OpenQuestion 默认为文本。
      if (opts.length > 0 && sourceKind === "conflict") {
        const ids = opts.map((x) => (isMapping(x) ? pyStr(get(x, "id")) : pyStr(x)));
        answerSchema = { type: "string", enum: ids };
      } else {
        answerSchema = { type: "string" };
      }
    }
    let evidenceIds = pyStrListOr(
      firstTruthy(get(raw, "evidenceIds"), get(raw, "evidence_ids"), []),
    );
    if (evidenceIds.length === 0 && isMapping(textRaw)) {
      for (const ev of pyListOr(get(textRaw, "evidence"))) {
        if (isMapping(ev)) {
          evidenceIds.push(
            pyStr(firstTruthy(get(ev, "id"), get(ev, "cite"), get(ev, "file_id"), "")),
          );
        }
      }
      evidenceIds = evidenceIds.filter((x) => x !== "");
    }
    const blocked = pyStrListOr(
      firstTruthy(get(raw, "blockedArtifacts"), get(raw, "blocked_artifacts"), []),
    );
    return new Question({
      id: qid,
      text,
      status,
      ownerUserId: owner,
      audienceRole: pyStr(
        firstTruthy(get(raw, "audienceRole"), get(raw, "audience_role"), ""),
      ),
      answerSchema,
      priority: asPriority(get(raw, "priority"), { blocking: blocked.length > 0 }),
      dependencies: pyStrListOr(get(raw, "dependencies")),
      blockedArtifacts: blocked,
      sourceKind,
      sourceRef,
      why: pyStr(pyTruthy(get(raw, "why")) ? get(raw, "why") : ""),
      options: opts,
      evidenceIds,
      scopeRefs: pyStrListOr(
        firstTruthy(get(raw, "scopeRefs"), get(raw, "scope_refs"), get(raw, "appliesTo"), []),
      ),
      group: pyStr(pyTruthy(get(raw, "group")) ? get(raw, "group") : ""),
      code: pyStr(pyTruthy(get(raw, "code")) ? get(raw, "code") : ""),
      informationGain: pyFloat(
        firstTruthy(get(raw, "informationGain"), get(raw, "score"), 0),
      ),
      blastRadius: pyInt(firstTruthy(get(raw, "blastRadius"), get(raw, "impact_count"), 0)),
      createdAt: pyFloat(firstTruthy(get(raw, "createdAt"), get(raw, "created_at"), now())),
      updatedAt: pyFloat(firstTruthy(get(raw, "updatedAt"), get(raw, "updated_at"), now())),
      version: pyInt(pyTruthy(get(raw, "version")) ? get(raw, "version") : 0),
      metadata: isMapping(get(raw, "metadata")) ? { ...(get(raw, "metadata") as object) } : {},
    });
  }

  /**
   * Python 侧是 `isinstance / hasattr("to_dict") / isinstance(Mapping)` 三级。
   *
   * **一处必须交代的移植分叉**：OIR 的 `OpenQuestion` 在 Python 侧是带 `to_dict()`
   * 的 dataclass，走的是第二级；TS 侧它是纯数据 interface（`oir.ts` 的选择），
   * 没有方法可 duck-type。直接当普通字典读会读到 camelCase 的 `Assertion` 对象，
   * 而 `evidenceIds` 那段找的是 `to_dict()` 才有的 `cite` / `file_id` 键 ——
   * 证据 id 会静默变成空。所以这里加一条**按形状识别 OIR OpenQuestion**的分支，
   * 识别到就先过 `questionToDict` 再读，与 Python 的第二级等价。
   */
  static fromLegacy(raw: unknown): Question {
    if (raw instanceof Question) return raw.clone();
    if (
      isMapping(raw) &&
      typeof (raw as { toDict?: unknown }).toDict === "function"
    ) {
      return Question.fromDict(
        (raw as { toDict: () => Record<string, unknown> }).toDict(),
      );
    }
    if (isOirOpenQuestion(raw)) {
      return Question.fromDict(questionToDict(raw as unknown as OirOpenQuestion));
    }
    if (isMapping(raw)) return Question.fromDict(raw);
    throw new TypeError(`无法转换为 Question: ${pyTypeName(raw)}`);
  }
}

/** `type(x).__name__` 的够用近似 —— 只出现在一条 TypeError 消息里。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  switch (typeof v) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "function":
      return "function";
    default:
      return (v as object).constructor?.name ?? "object";
  }
}

// ── OIR OpenQuestion 的形状识别（见 fromLegacy 的说明）──────────────

interface OirAssertionLike {
  value: unknown;
  origin: unknown;
  evidence: unknown;
  confidence: unknown;
}

function isAssertionLike(v: unknown): v is OirAssertionLike {
  return (
    isMapping(v) &&
    Object.hasOwn(v, "value") &&
    Object.hasOwn(v, "origin") &&
    Object.hasOwn(v, "evidence") &&
    Object.hasOwn(v, "confidence")
  );
}

function isOirOpenQuestion(v: unknown): v is Record<string, unknown> {
  return (
    isMapping(v) &&
    typeof v["rid"] === "string" &&
    typeof v["askedBy"] === "string" &&
    isAssertionLike(v["text"]) &&
    isAssertionLike(v["answer"])
  );
}

// ══════════════════════════════════════════════════════════════════
//  Decision
// ══════════════════════════════════════════════════════════════════

export interface DecisionInit {
  id: string;
  questionId: string;
  answer: unknown;
  actor: string;
  actorRole?: string;
  authority?: string;
  sourceTurn?: string;
  affectedIds?: readonly string[];
  supersedes?: string | null;
  revision?: number | null;
  idempotencyKey?: string;
  rationale?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

/** 一次经校验后生效的回答；旧决定永不删除，只通过 supersedes 失效。 */
export class Decision {
  id: string;
  questionId: string;
  answer: unknown;
  actor: string;
  actorRole: string;
  authority: string;
  sourceTurn: string;
  affectedIds: string[];
  supersedes: string | null;
  revision: number | null;
  idempotencyKey: string;
  rationale: string;
  createdAt: number;
  metadata: Record<string, unknown>;

  constructor(init: DecisionInit) {
    this.id = init.id;
    this.questionId = init.questionId;
    this.answer = init.answer;
    this.actor = init.actor;
    this.actorRole = init.actorRole ?? "";
    this.authority = init.authority ?? "";
    this.sourceTurn = init.sourceTurn ?? "";
    this.affectedIds = [...(init.affectedIds ?? [])];
    this.supersedes = init.supersedes ?? null;
    this.revision = init.revision ?? null;
    this.idempotencyKey = init.idempotencyKey ?? "";
    this.rationale = init.rationale ?? "";
    this.createdAt = init.createdAt ?? now();
    this.metadata = { ...(init.metadata ?? {}) };
  }

  /** 幂等比较不含服务器分配的 id/time/revision/supersedes。 */
  semanticPayload(): Record<string, unknown> {
    return {
      questionId: this.questionId,
      answer: this.answer,
      actor: this.actor,
      actorRole: this.actorRole,
      authority: this.authority,
      sourceTurn: this.sourceTurn,
      affectedIds: [...this.affectedIds].sort(cmpCodePoint),
      rationale: this.rationale,
    };
  }

  get fingerprint(): string {
    return sha256Hex(canonical(this.semanticPayload()));
  }

  toDict(): Record<string, unknown> {
    return {
      $schema: "ontocopilot.decision/1",
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      questionId: this.questionId,
      answer: this.answer,
      actor: this.actor,
      actorRole: this.actorRole,
      authority: this.authority,
      sourceTurn: this.sourceTurn,
      affectedIds: this.affectedIds,
      supersedes: this.supersedes,
      revision: this.revision,
      idempotencyKey: this.idempotencyKey,
      rationale: this.rationale,
      createdAt: this.createdAt,
      metadata: this.metadata,
    };
  }

  static fromDict(raw: Record<string, unknown>): Decision {
    const firstTruthy = (...vals: unknown[]): unknown => {
      for (const v of vals) if (pyTruthy(v)) return v;
      return vals[vals.length - 1];
    };
    const qid = pyStr(
      firstTruthy(get(raw, "questionId"), get(raw, "question_id"), get(raw, "target_rid"), ""),
    );
    // `raw.get("answer", raw.get("option_id", raw.get("statement")))` —— 按**键存在**
    // 逐层回退，不是按真值：显式写着 `answer: null` 就是 null，不会滑到 option_id。
    const answer = getOr(raw, "answer", getOr(raw, "option_id", get(raw, "statement")));
    let did = pyStr(firstTruthy(get(raw, "id"), get(raw, "decisionId"), ""));
    if (!did) {
      did = digest("dec", {
        question: qid,
        answer,
        actor: getOr(raw, "actor", "user"),
      });
    }
    const rev = get(raw, "revision");
    return new Decision({
      id: did,
      questionId: qid,
      answer,
      actor: pyStr(pyTruthy(get(raw, "actor")) ? get(raw, "actor") : "user"),
      actorRole: pyStr(firstTruthy(get(raw, "actorRole"), get(raw, "actor_role"), "")),
      authority: pyStr(pyTruthy(get(raw, "authority")) ? get(raw, "authority") : ""),
      sourceTurn: pyStr(firstTruthy(get(raw, "sourceTurn"), get(raw, "source_turn"), "")),
      affectedIds: pyStrListOr(
        firstTruthy(
          get(raw, "affectedIds"),
          get(raw, "affected_ids"),
          get(raw, "changed"),
          [],
        ),
      ),
      supersedes: (get(raw, "supersedes") as string | null | undefined) ?? null,
      // Python 是 `revision=raw.get("revision")` —— **没有 int() 转换**，
      // 存进来什么就是什么。这里同样原样透传，不"顺手"规整成整数。
      revision: (rev as number | null | undefined) ?? null,
      idempotencyKey: pyStr(
        firstTruthy(get(raw, "idempotencyKey"), get(raw, "idempotency_key"), ""),
      ),
      rationale: pyStr(firstTruthy(get(raw, "rationale"), get(raw, "note"), "")),
      createdAt: pyFloat(firstTruthy(get(raw, "createdAt"), get(raw, "ts"), now())),
      metadata: isMapping(get(raw, "metadata")) ? { ...(get(raw, "metadata") as object) } : {},
    });
  }
}

export class DecisionLedger {
  decisions: Decision[];

  constructor(decisions: readonly Decision[] = []) {
    this.decisions = [...decisions];
    const ids = this.decisions.map((d) => d.id);
    if (ids.length !== new Set(ids).size) throw new ValueError("Decision id 重复");
    const idem = this.decisions.filter((d) => d.idempotencyKey).map((d) => d.idempotencyKey);
    if (idem.length !== new Set(idem).size) throw new ValueError("Decision idempotencyKey 重复");
  }

  activeFor(questionId: string): Decision | null {
    const superseded = new Set(
      this.decisions.filter((d) => d.supersedes).map((d) => d.supersedes as string),
    );
    for (let i = this.decisions.length - 1; i >= 0; i--) {
      const d = this.decisions[i]!;
      if (d.questionId === questionId && !superseded.has(d.id)) return d;
    }
    return null;
  }

  /** 记录决定，返回 `[decision, created]`；重复请求返回原记录。 */
  record(decision: Decision): [Decision, boolean] {
    if (decision.idempotencyKey) {
      const prior = this.decisions.find((d) => d.idempotencyKey === decision.idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== decision.fingerprint) {
          throw new IdempotencyConflict(
            `幂等键 ${pyRepr(decision.idempotencyKey)} 已用于另一份回答`,
          );
        }
        return [prior, false];
      }
    }
    const prior = this.activeFor(decision.questionId);
    if (prior && prior.fingerprint === decision.fingerprint) return [prior, false];
    if (prior) decision.supersedes = prior.id;
    if (!decision.id) decision.id = digest("dec", decision.semanticPayload());
    if (this.decisions.some((d) => d.id === decision.id)) {
      throw new IdempotencyConflict(`Decision id ${pyRepr(decision.id)} 已存在但内容不同`);
    }
    this.decisions.push(decision);
    return [decision, true];
  }

  toDict(): Record<string, unknown> {
    return {
      $schema: "ontocopilot.decision-ledger/1",
      schemaVersion: SCHEMA_VERSION,
      decisions: this.decisions.map((d) => d.toDict()),
    };
  }

  static fromDict(raw: Record<string, unknown> | readonly unknown[]): DecisionLedger {
    // Python 是 `isinstance(raw, Sequence)` —— **dict 不是 Sequence，str 是**。
    const rows = Array.isArray(raw) ? raw : pyListOr(get(raw as Record<string, unknown>, "decisions"));
    return new DecisionLedger(
      rows.map((x) => {
        if (!isMapping(x)) throw new TypeError(`decisions 里不是对象：${JSON.stringify(x)}`);
        return Decision.fromDict(x);
      }),
    );
  }
}

// ══════════════════════════════════════════════════════════════════
//  Backlog
// ══════════════════════════════════════════════════════════════════

export class QuestionBacklog {
  /** 用 `Map` 而不是普通对象：问题 id 可能是纯数字串（conflict 的编号），
   * 而 JS 普通对象会把整数样式的键重排到最前，`to_dict()` 的顺序就漂了。 */
  questions: Map<string, Question>;

  constructor(questions?: Map<string, Question> | Record<string, Question>) {
    this.questions =
      questions instanceof Map
        ? new Map(questions)
        : new Map(Object.entries(questions ?? {}));
  }

  add(question: Question, opts: { preserveLifecycle?: boolean } = {}): Question {
    const preserve = opts.preserveLifecycle ?? true;
    const old = this.questions.get(question.id);
    if (old && preserve) {
      // 重跑挖掘只能更新描述性字段，不能抹掉人的分派/关闭状态。
      question.status = old.status;
      question.ownerUserId = old.ownerUserId;
      question.audienceRole = old.audienceRole || question.audienceRole;
      question.createdAt = old.createdAt;
      question.version = old.version;
    }
    this.questions.set(question.id, question);
    return question;
  }

  assign(
    questionId: string,
    ownerUserId: string,
    opts: { audienceRole?: string | null; now?: number | null } = {},
  ): Question {
    const q = this.mustGet(questionId);
    q.assign(ownerUserId, opts);
    return q;
  }

  transition(
    questionId: string,
    target: QuestionStatus | string,
    opts: { now?: number | null } = {},
  ): Question {
    const q = this.mustGet(questionId);
    q.transition(target, opts);
    return q;
  }

  /** Python 是 `self.questions[question_id]`，缺键直接 KeyError。照抄地炸。 */
  private mustGet(questionId: string): Question {
    const q = this.questions.get(questionId);
    if (!q) throw new KeyError(questionId);
    return q;
  }

  nextBatch(
    opts: { limit?: number; audienceRole?: string | null; ownerUserId?: string | null } = {},
  ): Question[] {
    const limit = opts.limit ?? 5;
    const resolved = new Set(
      [...this.questions.values()].filter((q) => q.terminal).map((q) => q.id),
    );
    let rows = [...this.questions.values()].filter((q) => q.ready(resolved));
    if (opts.audienceRole !== null && opts.audienceRole !== undefined) {
      rows = rows.filter((q) => !q.audienceRole || q.audienceRole === opts.audienceRole);
    }
    if (opts.ownerUserId !== null && opts.ownerUserId !== undefined) {
      rows = rows.filter((q) => !q.ownerUserId || q.ownerUserId === opts.ownerUserId);
    }
    const weights: Record<QuestionPriority, number> = {
      [QuestionPriority.BLOCKING]: 4,
      [QuestionPriority.HIGH]: 3,
      [QuestionPriority.NORMAL]: 2,
      [QuestionPriority.LOW]: 1,
    };
    // Python 的 key 是四元组 `(-w, -(gain*max(1,blast)), created_at, id)`，
    // 逐位比较；末位是 id 的 **code point** 序。
    rows.sort((a, b) => {
      const ka: [number, number, number, string] = [
        -weights[a.priority],
        -(a.informationGain * Math.max(1, a.blastRadius)),
        a.createdAt,
        a.id,
      ];
      const kb: [number, number, number, string] = [
        -weights[b.priority],
        -(b.informationGain * Math.max(1, b.blastRadius)),
        b.createdAt,
        b.id,
      ];
      for (let i = 0; i < 3; i++) {
        const x = ka[i] as number;
        const y = kb[i] as number;
        if (x < y) return -1;
        if (x > y) return 1;
      }
      return cmpCodePoint(ka[3], kb[3]);
    });
    return rows.slice(0, Math.max(0, limit));
  }

  toDict(): Record<string, unknown> {
    const rows = [...this.questions.values()].sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return cmpCodePoint(a.id, b.id);
    });
    return {
      $schema: "ontocopilot.question-backlog/1",
      schemaVersion: SCHEMA_VERSION,
      questions: rows.map((q) => q.toDict()),
      stats: this.stats(),
    };
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of Object.values(QuestionStatus)) out[s] = 0;
    for (const q of this.questions.values()) out[q.status] = (out[q.status] ?? 0) + 1;
    out["total"] = this.questions.size;
    out["blockingOpen"] = [...this.questions.values()].filter(
      (q) => q.blocking && !q.terminal,
    ).length;
    return out;
  }

  static fromDict(raw: Record<string, unknown> | readonly unknown[]): QuestionBacklog {
    const rows = Array.isArray(raw)
      ? raw
      : pyListOr(get(raw as Record<string, unknown>, "questions"));
    const bag = new QuestionBacklog();
    for (const item of rows) bag.add(Question.fromLegacy(item), { preserveLifecycle: false });
    return bag;
  }
}

/** 把三种遗留来源合成统一 Backlog；同源问题不会因重跑丢 lifecycle。 */
export function buildQuestionBacklog(
  opts: {
    openQuestions?: Iterable<unknown>;
    clarificationQuestions?: Iterable<unknown>;
    conflicts?: Iterable<unknown>;
    existing?: QuestionBacklog | Record<string, unknown> | readonly unknown[] | null;
  } = {},
): QuestionBacklog {
  const existing = opts.existing;
  const backlog =
    existing instanceof QuestionBacklog
      ? existing
      : QuestionBacklog.fromDict(pyTruthy(existing) ? (existing as Record<string, unknown>) : []);
  const byConflict = new Map<string, Question>();
  for (const item of opts.clarificationQuestions ?? []) {
    const q = Question.fromLegacy(item);
    q.sourceKind = "conflict";
    q.sourceRef = q.sourceRef || q.id;
    q.priority = QuestionPriority.BLOCKING;
    byConflict.set(q.sourceRef, q);
    backlog.add(q);
  }
  // 原始 conflict 只补齐 clarification 没覆盖的 ask_user 问题。
  for (const item of opts.conflicts ?? []) {
    let raw: Record<string, unknown>;
    if (isMapping(item) && typeof (item as { toDict?: unknown }).toDict === "function") {
      raw = (item as { toDict: () => Record<string, unknown> }).toDict();
    } else if (isMapping(item)) {
      raw = { ...item };
    } else {
      throw new TypeError(`conflicts 里不是对象：${JSON.stringify(item)}`);
    }
    const handling = pyStr(pyTruthy(get(raw, "handling")) ? get(raw, "handling") : "");
    if (handling && handling !== "ask_user") continue;
    const ref = pyStr(
      pyTruthy(get(raw, "rid")) ? get(raw, "rid") : pyTruthy(get(raw, "id")) ? get(raw, "id") : "",
    );
    if (byConflict.has(ref)) continue;
    const title = pyTruthy(get(raw, "summary"))
      ? get(raw, "summary")
      : pyTruthy(get(raw, "title"))
        ? get(raw, "title")
        : "";
    backlog.add(
      Question.fromDict({
        ...raw,
        id: digest("q", { conflict: ref }),
        conflict_rid: ref,
        title,
        priority: "blocking",
      }),
    );
  }
  for (const item of opts.openQuestions ?? []) backlog.add(Question.fromLegacy(item));
  return backlog;
}

/** 校验回答、幂等记 Decision、关闭问题；适合作为 API/Agent 的领域入口。 */
export function answerQuestion(
  backlog: QuestionBacklog,
  ledger: DecisionLedger,
  questionId: string,
  answer: unknown,
  opts: {
    actor: string;
    actorRole?: string;
    authority?: string;
    sourceTurn?: string;
    idempotencyKey: string;
    affectedIds?: readonly string[];
    revision?: number | null;
    rationale?: string;
    now?: number | null;
  },
): [Decision, boolean] {
  const q = backlog.questions.get(questionId);
  if (!q) throw new KeyError(questionId);
  q.validateAnswer(answer);
  if (!pyStrip(opts.idempotencyKey)) throw new ValueError("回答必须提供 idempotency_key");
  const decision = new Decision({
    id: "",
    questionId,
    answer,
    actor: opts.actor,
    actorRole: opts.actorRole ?? "",
    authority: opts.authority ?? "",
    sourceTurn: opts.sourceTurn ?? "",
    // `list(affected_ids or q.blocked_artifacts)` —— 空数组落回问题阻塞的产物。
    affectedIds: pyTruthy(opts.affectedIds) ? [...opts.affectedIds!] : [...q.blockedArtifacts],
    revision: opts.revision ?? null,
    idempotencyKey: opts.idempotencyKey,
    rationale: opts.rationale ?? "",
    createdAt: nowOr(opts.now),
  });
  const [recorded, created] = ledger.record(decision);
  if (q.status !== QuestionStatus.ANSWERED) {
    q.transition(QuestionStatus.ANSWERED, { now: opts.now ?? null });
  }
  return [recorded, created];
}

// ══════════════════════════════════════════════════════════════════
//  Patch / Revision
// ══════════════════════════════════════════════════════════════════

const PATCH_OPS: readonly string[] = ["add", "remove", "replace", "move", "copy", "test"];

/** 一条 JSON Patch 操作。参数保持 Python 的位置顺序 —— 生产与测试里都是位置调用。 */
export class PatchOp {
  readonly op: string;
  readonly path: string;
  readonly value: unknown;
  readonly fromPath: string;
  readonly targetIds: readonly string[];

  constructor(
    op: string,
    path: string,
    value: unknown = null,
    fromPath = "",
    targetIds: readonly string[] = [],
  ) {
    if (!PATCH_OPS.includes(op)) throw new ValueError(`不支持的 patch op: ${op}`);
    if (!path.startsWith("/")) throw new ValueError("PatchOp.path 必须是 JSON Pointer");
    if ((op === "move" || op === "copy") && !fromPath.startsWith("/")) {
      throw new ValueError(`${op} 必须提供 from_path`);
    }
    this.op = op;
    this.path = path;
    this.value = value;
    this.fromPath = fromPath;
    this.targetIds = [...targetIds];
  }

  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = { op: this.op, path: this.path };
    if (this.op !== "remove") out["value"] = this.value;
    if (this.fromPath) out["from"] = this.fromPath;
    if (this.targetIds.length > 0) out["targetIds"] = [...this.targetIds];
    return out;
  }

  static fromDict(raw: Record<string, unknown>): PatchOp {
    // `raw["op"]` / `raw["path"]` 是下标不是 get —— 缺键当场 KeyError。
    if (!Object.hasOwn(raw, "op")) throw new Error("KeyError: 'op'");
    if (!Object.hasOwn(raw, "path")) throw new Error("KeyError: 'path'");
    const from = pyTruthy(get(raw, "from"))
      ? get(raw, "from")
      : pyTruthy(get(raw, "from_path"))
        ? get(raw, "from_path")
        : "";
    const targets = pyTruthy(get(raw, "targetIds"))
      ? get(raw, "targetIds")
      : pyTruthy(get(raw, "target_ids"))
        ? get(raw, "target_ids")
        : [];
    return new PatchOp(
      pyStr(raw["op"]),
      pyStr(raw["path"]),
      get(raw, "value") ?? null,
      pyStr(from),
      pyStrListOr(targets),
    );
  }
}

export interface PatchSetInit {
  id: string;
  baseRevision: number;
  ops: readonly PatchOp[];
  affectedIds?: readonly string[];
  blockedArtifacts?: readonly string[];
  idempotencyKey?: string;
  actor?: string;
  reason?: string;
  createdAt?: number;
}

export class PatchSet {
  id: string;
  baseRevision: number;
  ops: PatchOp[];
  affectedIds: string[];
  blockedArtifacts: string[];
  idempotencyKey: string;
  actor: string;
  reason: string;
  createdAt: number;

  constructor(init: PatchSetInit) {
    this.id = init.id;
    this.baseRevision = init.baseRevision;
    this.ops = [...init.ops];
    this.affectedIds = [...(init.affectedIds ?? [])];
    this.blockedArtifacts = [...(init.blockedArtifacts ?? [])];
    this.idempotencyKey = init.idempotencyKey ?? "";
    this.actor = init.actor ?? "agent";
    this.reason = init.reason ?? "";
    this.createdAt = init.createdAt ?? now();
  }

  get fingerprint(): string {
    return sha256Hex(
      canonical({
        baseRevision: this.baseRevision,
        ops: this.ops.map((op) => op.toDict()),
        affectedIds: [...this.affectedIds].sort(cmpCodePoint),
      }),
    );
  }

  requireBase(currentRevision: number): void {
    if (this.baseRevision !== currentRevision) {
      throw new RevisionConflict(
        `PatchSet ${this.id} 基于 revision ${this.baseRevision}，` +
          `当前已是 ${currentRevision}`,
      );
    }
  }

  toDict(): Record<string, unknown> {
    return {
      $schema: "ontocopilot.patch-set/1",
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      baseRevision: this.baseRevision,
      ops: this.ops.map((op) => op.toDict()),
      affectedIds: this.affectedIds,
      blockedArtifacts: this.blockedArtifacts,
      idempotencyKey: this.idempotencyKey,
      actor: this.actor,
      reason: this.reason,
      createdAt: this.createdAt,
      fingerprint: this.fingerprint,
    };
  }

  static fromDict(raw: Record<string, unknown>): PatchSet {
    const ops = pyListOr(get(raw, "ops")).map((x) => {
      if (!isMapping(x)) throw new TypeError(`ops 里不是对象：${JSON.stringify(x)}`);
      return PatchOp.fromDict(x);
    });
    const first = (...vals: unknown[]): unknown => {
      for (const v of vals) if (pyTruthy(v)) return v;
      return vals[vals.length - 1];
    };
    return new PatchSet({
      id: pyTruthy(get(raw, "id")) ? pyStr(get(raw, "id")) : digest("patch", pyListOr(get(raw, "ops"))),
      baseRevision: pyInt(first(get(raw, "baseRevision"), get(raw, "base_revision"), 0)),
      ops,
      affectedIds: pyStrListOr(first(get(raw, "affectedIds"), get(raw, "affected_ids"), [])),
      blockedArtifacts: pyStrListOr(
        first(get(raw, "blockedArtifacts"), get(raw, "blocked_artifacts"), []),
      ),
      idempotencyKey: pyStr(
        first(get(raw, "idempotencyKey"), get(raw, "idempotency_key"), ""),
      ),
      actor: pyStr(pyTruthy(get(raw, "actor")) ? get(raw, "actor") : "agent"),
      reason: pyStr(pyTruthy(get(raw, "reason")) ? get(raw, "reason") : ""),
      createdAt: pyFloat(first(get(raw, "createdAt"), get(raw, "created_at"), now())),
    });
  }
}

export interface RevisionInit {
  id: string;
  ordinal: number;
  parentId: string | null;
  kind: string;
  status: RevisionStatus;
  patchSet?: PatchSet | null;
  changedIds?: readonly string[];
  invalidatedArtifacts?: readonly string[];
  actor?: string;
  sourceTurn?: string;
  snapshotHash?: string;
  createdAt?: number;
}

export class Revision {
  id: string;
  ordinal: number;
  parentId: string | null;
  kind: string;
  status: RevisionStatus;
  patchSet: PatchSet | null;
  changedIds: string[];
  invalidatedArtifacts: string[];
  actor: string;
  sourceTurn: string;
  snapshotHash: string;
  createdAt: number;

  constructor(init: RevisionInit) {
    this.id = init.id;
    this.ordinal = init.ordinal;
    this.parentId = init.parentId;
    this.kind = init.kind;
    this.status = init.status;
    this.patchSet = init.patchSet ?? null;
    this.changedIds = [...(init.changedIds ?? [])];
    this.invalidatedArtifacts = [...(init.invalidatedArtifacts ?? [])];
    this.actor = init.actor ?? "agent";
    this.sourceTurn = init.sourceTurn ?? "";
    this.snapshotHash = init.snapshotHash ?? "";
    this.createdAt = init.createdAt ?? now();
  }

  toDict(): Record<string, unknown> {
    return {
      $schema: "ontocopilot.revision/1",
      schemaVersion: SCHEMA_VERSION,
      id: this.id,
      ordinal: this.ordinal,
      parentId: this.parentId,
      kind: this.kind,
      status: this.status,
      patchSet: this.patchSet ? this.patchSet.toDict() : null,
      changedIds: this.changedIds,
      invalidatedArtifacts: this.invalidatedArtifacts,
      actor: this.actor,
      sourceTurn: this.sourceTurn,
      snapshotHash: this.snapshotHash,
      createdAt: this.createdAt,
    };
  }

  static fromDict(raw: Record<string, unknown>): Revision {
    const patch = pyTruthy(get(raw, "patchSet"))
      ? get(raw, "patchSet")
      : pyTruthy(get(raw, "patch_set"))
        ? get(raw, "patch_set")
        : null;
    const first = (...vals: unknown[]): unknown => {
      for (const v of vals) if (pyTruthy(v)) return v;
      return vals[vals.length - 1];
    };
    if (!Object.hasOwn(raw, "id")) throw new Error("KeyError: 'id'");
    // `raw.get("parentId", raw.get("parent_id"))` —— 按键存在回退，且**不转 str**。
    const parent = getOr(raw, "parentId", get(raw, "parent_id"));
    return new Revision({
      id: pyStr(raw["id"]),
      ordinal: pyInt(pyTruthy(get(raw, "ordinal")) ? get(raw, "ordinal") : 0),
      parentId: (parent as string | null | undefined) ?? null,
      kind: pyStr(pyTruthy(get(raw, "kind")) ? get(raw, "kind") : "edit"),
      status: parseRevisionStatus(
        pyStr(pyTruthy(get(raw, "status")) ? get(raw, "status") : "proposed"),
      ),
      patchSet: isMapping(patch) ? PatchSet.fromDict(patch) : null,
      changedIds: pyStrListOr(first(get(raw, "changedIds"), get(raw, "changed_ids"), [])),
      invalidatedArtifacts: pyStrListOr(
        first(get(raw, "invalidatedArtifacts"), get(raw, "invalidated_artifacts"), []),
      ),
      actor: pyStr(pyTruthy(get(raw, "actor")) ? get(raw, "actor") : "agent"),
      sourceTurn: pyStr(first(get(raw, "sourceTurn"), get(raw, "source_turn"), "")),
      snapshotHash: pyStr(first(get(raw, "snapshotHash"), get(raw, "snapshot_hash"), "")),
      createdAt: pyFloat(first(get(raw, "createdAt"), get(raw, "created_at"), now())),
    });
  }
}

// ══════════════════════════════════════════════════════════════════
//  回答校验
// ══════════════════════════════════════════════════════════════════

/** `type` 关键字的判据。用 `Map` 而不是普通对象 —— 见 `ALIASES` 的说明，
 * `checks["valueOf"]` 拿到的会是 `Object.prototype.valueOf`，调用即崩。 */
const TYPE_CHECKS = new Map<string, (x: unknown) => boolean>([
  ["null", (x) => x === null || x === undefined],
  ["boolean", (x) => typeof x === "boolean"],
  // Python 分得清 int 与 float，JS 分不清 —— `3.0` 在 Python 侧会被 integer 拒掉，
  // 这里放行。JSON 往返本来就把 3.0 塌成 3，这条无法在 JS 里修。
  ["integer", (x) => typeof x === "number" && Number.isInteger(x)],
  ["number", (x) => typeof x === "number"],
  ["string", (x) => typeof x === "string"],
  ["array", (x) => Array.isArray(x)],
  ["object", (x) => isMapping(x)],
]);

/** 验证产品当前需要的 JSON Schema 子集，未知 keyword 保留给下游完整 validator。 */
function validateAnswerAgainst(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): void {
  if (Object.keys(schema).length === 0) return;
  if (Object.hasOwn(schema, "const") && !pyEq(value, schema["const"])) {
    throw new AnswerValidationError(`${path} 必须等于 ${pyReprAny(schema["const"])}`);
  }
  if (Object.hasOwn(schema, "enum")) {
    const allowed = pyListOr(schema["enum"]);
    if (!allowed.some((x) => pyEq(value, x))) {
      throw new AnswerValidationError(`${path} 必须是 ${pyReprAny(schema["enum"])} 之一`);
    }
  }
  const rawKinds = get(schema, "type");
  const kinds: unknown[] = typeof rawKinds === "string" ? [rawKinds] : pyListOr(rawKinds);
  if (kinds.length > 0 && !kinds.some((k) => (TYPE_CHECKS.get(pyStr(k)) ?? (() => true))(value))) {
    throw new AnswerValidationError(
      `${path} 类型必须是 ${pyReprAny(kinds)}，实际是 ${pyTypeName(value)}`,
    );
  }
  if (typeof value === "string") {
    // `len(value)` 数的是 code point —— 一串中文按 UTF-16 数会凭空过不了 minLength。
    if (cpLen(value) < pyInt(pyTruthy(get(schema, "minLength")) ? schema["minLength"] : 0)) {
      throw new AnswerValidationError(`${path} 太短`);
    }
    const maxLen = get(schema, "maxLength");
    if (maxLen !== null && maxLen !== undefined && cpLen(value) > pyInt(maxLen)) {
      throw new AnswerValidationError(`${path} 太长`);
    }
  }
  // Python 是 `isinstance(x,(int,float)) and not isinstance(x,bool)` —— JS 里
  // boolean 本来就不是 number，那半句不用写。
  if (typeof value === "number") {
    const min = get(schema, "minimum");
    if (min !== null && min !== undefined && value < (min as number)) {
      throw new AnswerValidationError(`${path} 不能小于 ${pyStr(min)}`);
    }
    const max = get(schema, "maximum");
    if (max !== null && max !== undefined && value > (max as number)) {
      throw new AnswerValidationError(`${path} 不能大于 ${pyStr(max)}`);
    }
  }
  if (Array.isArray(value) && isMapping(get(schema, "items"))) {
    const items = schema["items"] as Record<string, unknown>;
    value.forEach((item, i) => validateAnswerAgainst(item, items, `${path}[${i}]`));
  }
  if (isMapping(value)) {
    // `missing` 里放的是 required 的**原始元素**（不是 str 化过的）——
    // 消息里 `{missing}` 打的是 list 的 str，元素形态混进来就漂了。
    const required = pyListOr(get(schema, "required"));
    const missing = required.filter((x) => !(typeof x === "string" && Object.hasOwn(value, x)));
    if (missing.length > 0) {
      throw new AnswerValidationError(`${path} 缺少字段 ${pyReprAny(missing)}`);
    }
    const props = isMapping(get(schema, "properties"))
      ? (schema["properties"] as Record<string, unknown>)
      : {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key) && isMapping(sub)) {
        validateAnswerAgainst(value[key], sub, `${path}.${key}`);
      }
    }
  }
}

/** Python 的 `==`：`[1,2] == [1,2]` 为真，`{"a":1} == {"a":1}` 为真。
 * `value != schema["const"]` 与 `value not in schema["enum"]` 都用它。 */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Python 里 True == 1、False == 0；JS 的 === 不是。
  if (typeof a === "boolean" || typeof b === "boolean") {
    const na = typeof a === "boolean" ? (a ? 1 : 0) : a;
    const nb = typeof b === "boolean" ? (b ? 1 : 0) : b;
    if (typeof na === "number" && typeof nb === "number") return na === nb;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (isMapping(a) && isMapping(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return false;
}

export { validateAnswerAgainst };
