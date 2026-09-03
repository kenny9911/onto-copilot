/**
 * Executable handlers for the frozen FDE engagement DAG.
 *
 * The extraction DAG remains the expensive, mature implementation of document
 * understanding.  This module turns its result into the *product* workflow: every
 * FDE stage is executed and checkpointed by `kernel/scheduler.ts`'s Scheduler.
 * Professional stages run as a hybrid: deterministic projections guarantee row
 * coverage and stable identities, while a role-specific model fills the semantic
 * gaps.  `finalize` is the trust boundary that merges those findings without
 * allowing a model to delete source rows or forge release-gate metrics.
 *
 * The important boundaries are executable, not descriptive:
 *
 * * `INTERVIEW` raises `HumanInputRequired` while the durable backlog contains
 *   pending questions, then resumes once those questions are resolved;
 * * `CANONICALIZE` builds and validates the exact OntologyPackage revision;
 * * `REVIEW` and `EXPORT` expose hard metrics consumed by `GateSpec` before
 *   any server-side artifact writer is called.
 */

import type { SkippedReview } from "./canonical.js";
import {
  buildPackage,
  canonicalId,
  PackageEvidenceIndex,
  pyStr,
  pyStrip,
  validatePackage,
} from "./canonical.js";
import { cmpCodePoint } from "./difflib.js";
import type { OIR } from "./oir.js";
import { isReleaseAcceptanceAuthority } from "./release_authority.js";
import {
  DecisionLedger,
  Question,
  QuestionBacklog,
  QuestionPriority,
  QuestionStatus,
  validateAnswerAgainst,
} from "./questions.js";
import { defaultAgents, renderSystem, TOOL_SCOPES } from "../kernel/agents.js";
import {
  Critic,
  type CriticContext,
  type Finding,
  Severity,
  type Verdict,
  makeFinding,
  makeVerdict,
} from "../kernel/critic.js";
import { NodeFailure } from "../kernel/errors.js";
import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import { NodeHandler, type RunContext } from "../kernel/loop.js";
import { defaultLibrary } from "../kernel/skills.js";
import type { ToolCallCtx } from "../kernel/tools.js";

type Dict = Record<string, unknown>;

const PENDING: ReadonlySet<string> = new Set<string>([
  QuestionStatus.OPEN,
  QuestionStatus.ASSIGNED,
  QuestionStatus.BLOCKED,
]);

const EXPECTED_ARTIFACTS: readonly string[] = [
  "ontology.package.json",
  "ontology-package.schema.json",
  "data-objects.json",
  "actions.json",
  "events.json",
  "rules.json",
  "questions.json",
  "decision-proposals.json",
  "decision-application.json",
  "requirements.json",
  "architecture.json",
  "acceptance-test-plan.json",
  "human-acceptance.json",
  "模板_v1.xlsx",
  "oir.json",
];

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════
/** `isinstance(x, Mapping)` —— 数组不是 Mapping。 */
function isMapping(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function get(d: unknown, k: string): unknown {
  return isMapping(d) ? d[k] : undefined;
}

/** Python 真值。`0` / `""` / `[]` / `{}` / `None` / `False` 全假。 */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return Number.isNaN(v) ? true : v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isMapping(v)) return Object.keys(v).length > 0;
  return true;
}

/** `for x in (v or ())` —— 只在这里用于"列表字段可能缺失"，非列表按 Python 语义迭代。 */
function iterOf(v: unknown): unknown[] {
  if (!truthy(v)) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  if (isMapping(v)) return Object.keys(v);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

/** `len(v or ())`：dict 数键、list 数元素、str 数码点。 */
function pyLen(v: unknown): number {
  if (!truthy(v)) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return [...v].length;
  if (isMapping(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${typeof v}' has no len()`);
}

/** `s.split(sep, maxsplit)` —— JS 的 `split(sep, n)` 是**截断**而不是限制切分次数。 */
function pySplit(s: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < maxsplit; i += 1) {
    const at = rest.indexOf(sep);
    if (at < 0) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  out.push(rest);
  return out;
}

/** `str.removeprefix(p)`。 */
function removePrefix(s: string, p: string): string {
  return s.startsWith(p) ? s.slice(p.length) : s;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  const ctor = (v as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? typeof v;
}

/** 有 `toDict()` 的活对象。 */
function hasToDict(v: unknown): v is { toDict(): Dict } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toDict?: unknown }).toDict === "function"
  );
}

function asDict(value: unknown): Dict {
  if (value === null || value === undefined) return {};
  // JS class instances also satisfy the broad object check used by isMapping(),
  // unlike Python where OIR is not a Mapping.  Prefer the explicit serializer or
  // a live OIR would expose Map buckets that every projection reads as empty.
  if (hasToDict(value)) return value.toDict();
  if (isMapping(value)) return { ...value };
  throw new TypeError(`expected mapping/to_dict object, got ${pyTypeName(value)}`);
}

function valueOf(value: unknown, dflt: unknown = ""): unknown {
  if (isMapping(value) && "value" in value) return value["value"];
  return value === null || value === undefined ? dflt : value;
}

/**
 * Return stable human-readable evidence references already present in OIR.
 *
 * Engagement projections are not a second source of truth, so they retain the
 * upstream cite rather than minting a new evidence identity.  Canonicalization
 * later turns those references into package-owned `ev.*` IDs.
 */
function evidenceIds(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!isMapping(value)) continue;
    for (const evidence of iterOf(value["evidence"])) {
      if (!isMapping(evidence)) continue;
      let ref = pyStrip(pyStr(truthy(evidence["cite"]) ? evidence["cite"] : ""));
      if (ref === "") {
        const name = pyStr(
          truthy(evidence["file_name"])
            ? evidence["file_name"]
            : truthy(evidence["fileName"])
              ? evidence["fileName"]
              : "",
        );
        // `f"{name}#{locator}"` 里的 locator 是个 dict —— Python 会印成
        // `{'kind': 'raw', 'ref': 'x'}`（单引号、`: ` 分隔），不是 JSON。
        // 这个串会进产物、被人点回原文，形态错了就对不上。
        const locator = truthy(evidence["locator"]) ? evidence["locator"] : {};
        ref = name !== "" ? `${name}#${pyStr(locator)}` : "";
      }
      if (ref !== "" && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

/** `sorted(backlog.questions.values(), key=(created_at, id))` —— 末位按码点序。 */
function questionRows(backlog: QuestionBacklog): Question[] {
  return [...backlog.questions.values()].sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return cmpCodePoint(a.id, b.id);
  });
}

function clipCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${[...text].slice(0, limit).join("")}\n〔基线过长，余下行仍会由确定性合并保留〕`;
}

function jsonPreview(value: unknown, limit = 18_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = pyStr(value);
  }
  return clipCodePoints(text, limit);
}

interface SeedCoverage {
  readonly path: string;
  readonly total: number;
  readonly included: number;
  readonly omitted: number;
}

/**
 * Keep model context valid JSON and bounded.  Finalize always recomputes the
 * complete deterministic seed, so omitted rows are coverage metadata—not rows a
 * model is allowed to delete.  The agent can page through OIR/evidence tools when
 * an omitted tail matters.
 */
function boundedModelSeed(
  value: unknown,
  path: string,
  coverage: SeedCoverage[],
  arrayCap = 30,
): unknown {
  if (Array.isArray(value)) {
    const included = Math.min(value.length, arrayCap);
    if (included < value.length) {
      coverage.push({
        path,
        total: value.length,
        included,
        omitted: value.length - included,
      });
    }
    return value
      .slice(0, included)
      .map((item, index) => boundedModelSeed(item, `${path}/${index}`, coverage, arrayCap));
  }
  if (isMapping(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        boundedModelSeed(child, `${path}/${key}`, coverage, arrayCap),
      ]),
    );
  }
  if (typeof value === "string" && [...value].length > 1_200) {
    return clipCodePoints(value, 1_200);
  }
  return value;
}

function stringList(value: unknown): string[] {
  const out: string[] = [];
  for (const item of iterOf(value)) {
    const text = pyStrip(pyStr(item));
    if (text !== "" && !out.includes(text)) out.push(text);
  }
  return out;
}

function unionStrings(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const item of stringList(value)) if (!out.includes(item)) out.push(item);
  }
  return out;
}

function mappingRows(value: unknown): Dict[] {
  return iterOf(value).filter(isMapping).map((row) => ({ ...row }));
}

function collectEvidenceRefs(
  value: unknown,
  out: Set<string>,
  seen = new Set<object>(),
): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) collectEvidenceRefs(item, out, seen);
    return;
  }
  if (!isMapping(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  const cite = nonEmptyString(value["cite"]);
  if (cite !== null) out.add(cite);
  for (const key of ["evidence_ids", "evidenceIds"] as const) {
    for (const ref of stringList(value[key])) out.add(ref);
  }
  for (const child of Object.values(value)) collectEvidenceRefs(child, out, seen);
}

function nonEmptyString(value: unknown): string | null {
  const text = pyStrip(pyStr(value ?? ""));
  return text === "" || text === "None" ? null : text;
}

function evidenceValueNorm(value: unknown): string {
  return pyStrip(pyStr(value ?? ""))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function firstString(row: Dict, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(row[key]);
    if (value !== null) return value;
  }
  return null;
}

function rowId(row: Dict, fallbackPrefix: string): string {
  return firstString(
    row,
    "id",
    "rid",
    "decision_id",
    "requirement_id",
    "component_id",
    "test_case_id",
  ) ??
    `${fallbackPrefix}.${sha256Hex(JSON.stringify(row)).slice(0, 20)}`;
}

function mergeRowsById(
  baseline: unknown,
  proposed: unknown,
  prefix: string,
  acceptNew: (row: Dict) => boolean = () => true,
  acceptUpdate: (old: Dict, row: Dict) => boolean = () => true,
): Dict[] {
  const rows = new Map<string, Dict>();
  for (const row of mappingRows(baseline)) rows.set(rowId(row, prefix), row);
  for (const row of mappingRows(proposed)) {
    const id = rowId(row, prefix);
    const old = rows.get(id);
    if (old !== undefined) {
      if (acceptUpdate(old, row)) rows.set(id, { ...old, ...row, id: old["id"] ?? id });
    }
    else if (acceptNew(row)) rows.set(id, { ...row, id: row["id"] ?? id });
  }
  return [...rows.values()];
}

function decisionId(row: Dict): string | null {
  return firstString(row, "id", "decisionId", "decision_id");
}

function decisionAffectedIds(row: Dict): string[] {
  return unionStrings(row["affectedIds"], row["affected_ids"], row["changed"]);
}

function decisionQuestionId(row: Dict): string | null {
  return firstString(row, "questionId", "question_id", "target_rid");
}

function targetIdOf(row: Dict): string | null {
  const target = isMapping(row["target"]) ? row["target"] : {};
  return firstString(target, "entity_id", "entityId", "id", "rid") ??
    firstString(row, "target_id", "targetId", "entity_id", "entityId");
}

function targetFieldOf(row: Dict): string | null {
  const target = isMapping(row["target"]) ? row["target"] : {};
  return firstString(target, "field", "path", "property") ??
    firstString(row, "target_field", "targetField", "field_path", "field", "path");
}

function targetTypeOf(row: Dict): string | null {
  const target = isMapping(row["target"]) ? row["target"] : {};
  return firstString(target, "entity_type", "entityType", "type") ??
    firstString(row, "target_type", "targetType", "target_kind", "entity_type", "entityType");
}

function decisionTargetKind(value: string): string {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
  const aliases: Readonly<Record<string, string>> = {
    OBJECTTYPE: "OBJECT",
    OBJECT_TYPE: "OBJECT",
    PROPERTYTYPE: "PROPERTY",
    PROPERTY_TYPE: "PROPERTY",
    LINKTYPE: "LINK",
    LINK_TYPE: "LINK",
    ACTIONTYPE: "ACTION",
    ACTION_TYPE: "ACTION",
    EVENTTYPE: "EVENT",
    EVENT_TYPE: "EVENT",
    BUSINESSRULE: "RULE",
    BUSINESS_RULE: "RULE",
    PROCESSSTEP: "PROCESS_STEP",
    PROCESS_NODE: "PROCESS_STEP",
    DATAOBJECT: "DATA_OBJECT",
  };
  const allowed = new Set([
    "OBJECT", "PROPERTY", "LINK", "ACTION", "EVENT", "RULE", "PROCESS",
    "PROCESS_STEP", "DATA_OBJECT", "ERP_MAPPING", "REQUIREMENT",
    "INTEGRATION_CONTRACT", "TEST_CASE", "OTHER",
  ]);
  return allowed.has(raw) ? raw : aliases[raw] ?? "OTHER";
}

function decisionOperation(value: string | null): string {
  const operation = value?.toUpperCase() ?? "REPLACE";
  return ["ADD", "REPLACE", "REMOVE", "LINK", "UNLINK"].includes(operation)
    ? operation
    : "REPLACE";
}

function structuredQuestions(runtime: EngagementRuntimeInput, values: unknown = []): Dict[] {
  const requested = new Set(stringList(values));
  const rows = runtime.pending().filter((question) =>
    requested.size === 0 || requested.has(question.id),
  );
  return rows.map((question) => {
    const schema = question.answerSchema;
    const schemaType = nonEmptyString(schema["type"])?.toLowerCase() ?? "string";
    const enumValues = stringList(schema["enum"]);
    const answerKind =
      enumValues.length > 0
        ? "SINGLE_CHOICE"
        : schemaType === "number"
          ? "NUMBER"
          : schemaType === "integer"
            ? "INTEGER"
            : schemaType === "boolean"
              ? "BOOLEAN"
              : "TEXT";
    return {
      id: question.id,
      text: question.text || question.id,
      audience_role: question.audienceRole || "业务负责人",
      priority: String(question.priority).toUpperCase(),
      answer_kind: answerKind,
      options: answerKind === "SINGLE_CHOICE" ? enumValues : [],
      blocked_ids: [...question.blockedArtifacts],
      evidence_ids: [...question.evidenceIds],
    };
  });
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function errorLabel(exc: unknown): string {
  if (exc instanceof Error) return `${exc.constructor.name || exc.name}: ${exc.message}`;
  return `${typeof exc}: ${String(exc)}`;
}

interface EngagementToolSpec {
  readonly name: string;
  render(): string;
}

export interface EngagementToolRegistry {
  call(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolCallCtx,
    opts: { scope: string },
  ): Promise<unknown>;
  forScope?(scope: string): readonly { readonly spec: EngagementToolSpec }[];
}

export interface EngagementHandlerOptions {
  /** Initial paid build enables semantic analysis; offline resume keeps deterministic replay. */
  readonly modelAnalysis?: boolean;
  /** Engagement-specific registry built after OIR exists. */
  readonly tools?: EngagementToolRegistry | null;
  /** Previously finalized semantic outputs, reused by paid-run-free HITL revisions. */
  readonly replayOutputs?: Readonly<Record<string, unknown>> | null;
}

const PROFESSIONAL_NODE_BY_AGENT: Readonly<Record<string, string>> = {
  fde_interviewer: "INTAKE",
  process_modeler: "PROCESS",
  erp_mapper: "ERP_MAP",
  rule_engineer: "RULES",
  data_steward: "DATA_OBJECTS",
  decision_integrator: "DECISION_PROPOSAL",
  requirements_engineer: "REQUIREMENTS",
  solution_architect: "ARCHITECTURE",
  acceptance_test_engineer: "TEST_PLAN",
  delivery_reviewer: "REVIEW",
};

/**
 * Defense in depth: the central registry enforces TOOL_SCOPES, and professional
 * handlers apply the same table again when rendering a catalog and dispatching.
 * The scope comes from AgentSpec, never from a model-authored action.
 */
const PROFESSIONAL_TOOLS: Readonly<Record<string, readonly string[]>> = TOOL_SCOPES;

// ══════════════════════════════════════════════════════════════════
//  Runtime 输入
// ══════════════════════════════════════════════════════════════════
export interface EngagementRuntimeInputInit {
  sessionId: string;
  project: string;
  oir: OIR | Dict;
  flow?: unknown;
  backlog?: QuestionBacklog | Dict;
  decisions?: DecisionLedger | readonly unknown[] | Dict;
  corpus?: Dict;
  artifactRevision?: number;
  generatedAt?: string;
  releaseDownloadable?: boolean;
  skippedReviews?: readonly SkippedReview[] | (() => readonly SkippedReview[]) | undefined;
  /** Exact citations present in the read-only EvidenceIndex available to agents. */
  evidenceRefs?: readonly string[] | undefined;
  /** Full source records keyed by cite; keeps canonical Evidence resolvable. */
  evidenceRecords?: readonly Dict[] | undefined;
  /** 已有客户材料时即使解析成零切片也要 fail closed；默认从 corpus.files 推断。 */
  materialEvidenceRequired?: boolean | undefined;
}

/** Materialized inputs for one engagement execution/replay. */
export class EngagementRuntimeInput {
  readonly sessionId: string;
  readonly project: string;
  readonly oir: OIR | Dict;
  readonly flow: unknown;
  readonly backlog: QuestionBacklog;
  readonly decisions: DecisionLedger | readonly unknown[] | Dict;
  readonly corpus: Dict;
  readonly artifactRevision: number;
  readonly generatedAt: string;
  readonly releaseDownloadable: boolean;
  /** 本次运行没有跑的评审（`Budget.skippedReviews()`）。空 = 全跑了。 */
  private readonly skippedReviewsSource: () => readonly SkippedReview[];
  readonly evidenceRefs: ReadonlySet<string>;
  readonly evidenceRecords: readonly Dict[];
  readonly materialEvidenceRequired: boolean;
  private readonly evidenceTextByRef: ReadonlyMap<string, string>;

  // 默认值写在构造函数体里而不是 class field —— 见 CONTRACT §1。
  constructor(init: EngagementRuntimeInputInit) {
    this.sessionId = init.sessionId;
    this.project = init.project;
    this.oir = init.oir;
    const skippedReviews = init.skippedReviews;
    this.skippedReviewsSource =
      typeof skippedReviews === "function"
        ? skippedReviews
        : () => skippedReviews ?? [];
    this.flow = init.flow ?? null;
    // Materialise once.  GAP mutates this live backlog before INTERVIEW; rebuilding
    // from a Dict on every accessor would make model-discovered questions disappear.
    this.backlog =
      init.backlog instanceof QuestionBacklog
        ? init.backlog
        : QuestionBacklog.fromDict(init.backlog ?? {});
    this.decisions = init.decisions ?? new DecisionLedger();
    this.corpus = { ...(init.corpus ?? {}) };
    this.artifactRevision = init.artifactRevision ?? 0;
    this.generatedAt = init.generatedAt ?? "1970-01-01T00:00:00+00:00";
    this.releaseDownloadable = init.releaseDownloadable ?? true;
    this.evidenceRecords = mappingRows(init.evidenceRecords ?? []);
    this.materialEvidenceRequired = init.materialEvidenceRequired ?? (
      mappingRows(this.corpus["files"]).length > 0 || Number(this.corpus["chunks"] ?? 0) > 0
    );
    // 只有 EvidenceIndex 明确交进来的引用才有资格给模型结论背书。OIR/Flow/问题
    // 台账里的 cite 本身也可能来自模型；把它们反向收进 trusted set 会形成
    // “模型写一个 cite → runtime 再认证它”的自证循环。
    const refs = new Set<string>(stringList(init.evidenceRefs ?? []));
    const textByRef = new Map<string, string>();
    for (const row of this.evidenceRecords) {
      const cite = nonEmptyString(row["cite"]);
      if (cite === null) continue;
      refs.add(cite);
      const text = firstString(row, "text", "snippet", "render", "摘录") ?? "";
      if (text !== "" && !textByRef.has(cite)) textByRef.set(cite, text);
    }
    this.evidenceRefs = refs;
    this.evidenceTextByRef = textByRef;
  }

  get skippedReviews(): readonly SkippedReview[] {
    const unique = new Map<string, SkippedReview>();
    for (const row of this.skippedReviewsSource()) {
      unique.set(`${row.what}\u0000${row.why}\u0000${row.level}\u0000${row.label}`, row);
    }
    return [...unique.values()];
  }

  verifiedEvidence(value: unknown): string[] {
    return stringList(value).filter((ref) => this.evidenceRefs.has(ref));
  }

  /**
   * 引用存在不等于引用支持这个字段。这里采用保守的逐字核验：拟写入的具体值
   * 必须能在对应 EvidenceIndex 原文里找到。需要归纳/改写的内容保留为候选或问题，
   * 不能自动升级成“材料明确写了”。
   */
  evidenceSupporting(value: unknown, refs: unknown): string[] {
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => evidenceValueNorm(item))
      .filter((item) => item !== "");
    if (values.length === 0) return [];
    return this.verifiedEvidence(refs).filter((ref) => {
      const source = evidenceValueNorm(this.evidenceTextByRef.get(ref) ?? "");
      return source !== "" && values.every((item) => source.includes(item));
    });
  }

  oirDict(): Dict {
    return asDict(this.oir);
  }

  flowDict(): Dict {
    return asDict(this.flow);
  }

  questionBacklog(): QuestionBacklog {
    return this.backlog;
  }

  decisionRows(): Dict[] {
    if (this.decisions instanceof DecisionLedger) {
      return this.decisions.decisions.map((d) => d.toDict());
    }
    let raw: unknown = this.decisions;
    if (isMapping(raw)) raw = truthy(raw["decisions"]) ? raw["decisions"] : [];
    return iterOf(raw).map((row) => asDict(row));
  }

  /** Formal release sign-off is control-plane evidence, not a business-model decision. */
  businessDecisionRows(): Dict[] {
    const signoffPrefix = humanAcceptanceQuestionPrefix(this.sessionId);
    return this.decisionRows().filter(
      (row) => !(decisionQuestionId(row) ?? "").startsWith(signoffPrefix),
    );
  }

  /** All unresolved interview work, including non-release gaps. */
  pending(): Question[] {
    return questionRows(this.questionBacklog()).filter((q) => PENDING.has(q.status));
  }

  /**
   * Unresolved questions that are allowed to suspend formal delivery.
   *
   * A real discovery workbook can contain hundreds of ordinary open questions.
   * They remain visible in the package and make it an explicit draft, but only a
   * question declared `blocking` (priority or blocked artifact) stops the DAG.
   * Deferred/cancelled questions are intentionally not blockers.
   */
  blockers(): Question[] {
    return this.pending().filter((q) => q.blocking);
  }
}

// ══════════════════════════════════════════════════════════════════
//  Handlers
// ══════════════════════════════════════════════════════════════════
/** Deterministic coverage + role-specific semantic reasoning. */
abstract class ProfessionalProjection extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;
  readonly modelAnalysis: boolean;
  readonly tools: EngagementToolRegistry | null;
  readonly agentName: string;
  readonly toolScope: string;
  readonly role: string;
  readonly replayOutput: Dict | null;

  constructor(
    runtime: EngagementRuntimeInput,
    agentName: string,
    opts: EngagementHandlerOptions = {},
  ) {
    super();
    this.runtime = runtime;
    const agent = defaultAgents().get(agentName);
    this.agentName = agentName;
    this.role = agent.role;
    this.toolScope = agent.toolScope;
    this.modelAnalysis = opts.modelAnalysis ?? false;
    this.tools = opts.tools ?? null;
    const replay = opts.replayOutputs?.[PROFESSIONAL_NODE_BY_AGENT[agentName] ?? ""];
    this.replayOutput = isMapping(replay) ? replay : null;
    this.schema = agent.outputSchema;
    const skills = defaultLibrary();
    const rendered = renderSystem(agent, skills);
    const fullSkills = skills.load([...agent.skills], { budgetTokens: 12_000 });
    const catalog = this.toolCatalog();
    this.system = [rendered, fullSkills, catalog].filter((part) => part !== "").join("\n\n");
  }

  override task(inputs: Dict): string {
    if (!this.modelAnalysis) return "把成熟抽取结果投影为本节点的稳定 FDE 交付契约。";
    return (
      `${this.role}。请对确定性基线中的 UNKNOWN、空槽和跨产物语义进行独立分析。\n` +
      "规则：稳定 ID、原始名称、已有证据和结构边不可改；没有材料依据就保留 UNKNOWN/空值，" +
      "并在 questions/gaps 中提出问题。coverage 只说明上下文中省略了多少行；需要时用只读工具分页查询。" +
      "最终合并器会保留基线中你未复述的全部行，输出仍须遵循本节点 schema，不要输出 coverage 包装。\n\n" +
      `## 确定性基线 / 分析目标\n${jsonPreview(this.analysisSeed(inputs))}`
    );
  }

  override query(_inputs: Dict): string {
    return `${this.role}：查找材料中能填补未知项、验证跨产物一致性的证据`;
  }

  override skipModel(inputs: Dict): unknown {
    if (this.modelAnalysis) return null;
    const seed = this.project(inputs);
    return this.replayOutput === null
      ? seed
      : this.mergeDraft(seed, this.replayOutput, inputs);
  }

  override async dispatch(action: Dict, ctx: RunContext): Promise<unknown> {
    const tool = nonEmptyString(action["tool"]) ?? "";
    const allowed = new Set(PROFESSIONAL_TOOLS[this.toolScope] ?? []);
    if (!allowed.has(tool)) {
      return {
        error: `作用域 ${this.toolScope} 不允许工具 ${tool || "(空)"}`,
        allowed: [...allowed].sort(cmpCodePoint),
      };
    }
    const tools = this.tools ?? this.toolsFromBus(ctx);
    if (tools === null) return { error: "本节点没有可用工具" };
    const args = isMapping(action["args"]) ? action["args"] : {};
    try {
      return await tools.call(tool, args, ctx as unknown as ToolCallCtx, {
        scope: this.toolScope,
      });
    } catch (exc) {
      // A bad read is an observation for the agent, not a failed workflow node.
      return { error: errorLabel(exc) };
    }
  }

  override finalize(draft: unknown, inputs: Dict): Dict {
    return this.mergeDraft(this.project(inputs), isMapping(draft) ? draft : {}, inputs);
  }

  protected analysisSeed(inputs: Dict): Dict {
    const coverage: SeedCoverage[] = [];
    const seed = boundedModelSeed(this.project(inputs), "$", coverage);
    return {
      seed,
      coverage,
    };
  }

  protected abstract mergeDraft(seed: Dict, draft: Dict, inputs: Dict): Dict;

  private toolsFromBus(ctx: RunContext): EngagementToolRegistry | null {
    const bus = ctx.bus as unknown as { read?(key: string): unknown };
    const value = typeof bus.read === "function" ? bus.read("_tools") : null;
    return value !== null && typeof value === "object"
      ? (value as EngagementToolRegistry)
      : null;
  }

  private toolCatalog(): string {
    const allowed = new Set(PROFESSIONAL_TOOLS[this.toolScope] ?? []);
    if (allowed.size === 0) return "";
    const rows = this.tools?.forScope?.(this.toolScope) ?? [];
    const rendered = rows
      .filter((tool) => allowed.has(tool.spec.name))
      .map((tool) => tool.spec.render());
    if (rendered.length > 0) return `## 本节点可用只读工具\n${rendered.join("\n\n")}`;
    return `## 本节点允许的只读工具\n${[...allowed].sort(cmpCodePoint).join("、")}`;
  }

  abstract project(inputs: Dict): Dict;
}

export class IntakeHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "fde_interviewer", opts);
  }

  project(_inputs: Dict): Dict {
    const backlog = this.runtime.questionBacklog();
    const systems = new Map<string, Dict>();
    for (const action of iterOf(this.runtime.oirDict()["actions"])) {
      const endpointRaw = valueOf(get(action, "sourceEndpoint"), null);
      const endpoint = truthy(endpointRaw) ? endpointRaw : {};
      if (!isMapping(endpoint)) continue;
      const raw = pyStrip(
        pyStr(
          truthy(endpoint["url"]) ? endpoint["url"] : truthy(endpoint["path"]) ? endpoint["path"] : "",
        ),
      );
      if (raw !== "") {
        const head = pySplit(raw, "//", 1).at(-1) as string;
        const key = pySplit(head, "/", 1)[0] || raw;
        if (!systems.has(key)) {
          systems.set(key, { id: `sys.${key}`, name: key, authority: "UNKNOWN" });
        }
      }
    }
    const questions: Dict[] = [];
    for (const q of questionRows(backlog)) {
      questions.push({
        id: q.id,
        text: q.text || q.id,
        audience_role: q.audienceRole || "业务负责人",
        owner_user_id: q.ownerUserId || null,
        priority: removePrefix(pyStr(q.priority).toUpperCase(), "QUESTIONPRIORITY."),
        answer_schema: interviewerAnswerSchema(q.answerSchema),
        blocked_artifacts: [...q.blockedArtifacts],
        evidence_ids: [...q.evidenceIds],
      });
    }
    return {
      engagement: {
        objective: this.runtime.project || `会话 ${this.runtime.sessionId} 业务梳理`,
        in_scope: ["AS-IS 流程", "OntologyPackage v1", "待澄清问题与决策"],
        out_of_scope: [],
        stakeholders: [],
        systems: [...systems.values()],
        acceptance_criteria: [
          "OntologyPackage v1 引用完整性通过",
          "发布前 REVIEW 与 EXPORT 硬门通过",
        ],
      },
      findings: [],
      questions,
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const baseEngagement = isMapping(seed["engagement"]) ? seed["engagement"] : {};
    const modelEngagement = isMapping(draft["engagement"]) ? draft["engagement"] : {};

    const systems = new Map<string, Dict>();
    for (const row of mappingRows(baseEngagement["systems"])) {
      const id = nonEmptyString(row["id"]);
      if (id !== null) systems.set(id, row);
    }
    for (const row of mappingRows(modelEngagement["systems"])) {
      const id = nonEmptyString(row["id"]);
      if (id === null) continue;
      const old = systems.get(id);
      if (old === undefined) {
        systems.set(id, row);
        continue;
      }
      systems.set(id, {
        ...old,
        authority:
          old["authority"] === "UNKNOWN" && nonEmptyString(row["authority"]) !== null
            ? row["authority"]
            : old["authority"],
      });
    }

    const stakeholders = mappingRows(modelEngagement["stakeholders"]);
    const findings = mappingRows(draft["findings"]).filter((row) => {
      row["evidence_ids"] = this.runtime.verifiedEvidence(row["evidence_ids"]);
      const status = nonEmptyString(row["epistemic_status"]);
      // A FACT without a source is not a fact.  Retain it as an explicit assumption.
      if (status === "FACT" && stringList(row["evidence_ids"]).length === 0) {
        row["epistemic_status"] = "ASSUMPTION";
      }
      return nonEmptyString(row["statement"]) !== null;
    });

    const modelQuestions = mappingRows(draft["questions"]).map((row) => ({
      ...row,
      evidence_ids: this.runtime.verifiedEvidence(row["evidence_ids"]),
    }));
    const questions = [...mappingRows(seed["questions"]), ...modelQuestions];
    return {
      engagement: {
        ...baseEngagement,
        out_of_scope: unionStrings(
          baseEngagement["out_of_scope"],
          modelEngagement["out_of_scope"],
        ),
        stakeholders,
        systems: [...systems.values()],
        acceptance_criteria: unionStrings(
          baseEngagement["acceptance_criteria"],
          modelEngagement["acceptance_criteria"],
        ),
      },
      findings,
      questions,
    };
  }
}

export class ProcessHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "process_modeler", opts);
  }

  project(_inputs: Dict): Dict {
    const flow = this.runtime.flowDict();
    const steps: Dict[] = [];
    for (const node of iterOf(flow["nodes"])) {
      const label = get(node, "label");
      const actor = pyStr(truthy(valueOf(get(node, "actor"))) ? valueOf(get(node, "actor")) : "待确认");
      const objects = [...iterOf(get(node, "objects"))];
      steps.push({
        id: pyStr(truthy(get(node, "rid")) ? get(node, "rid") : truthy(get(node, "id")) ? get(node, "id") : ""),
        name: pyStr(
          truthy(valueOf(label))
            ? valueOf(label)
            : truthy(get(node, "rid"))
              ? get(node, "rid")
              : "未命名步骤",
        ),
        actor_role: actor,
        trigger: null,
        precondition: null,
        input_data_ids: [...objects],
        output_data_ids: [...objects],
        system_ids: truthy(get(node, "endpoint")) ? [pyStr(get(node, "endpoint"))] : [],
        evidence_ids: evidenceIds(label, get(node, "actor")),
      });
    }
    const edges = iterOf(flow["edges"]).map((edge) => ({
      id: pyStr(truthy(get(edge, "rid")) ? get(edge, "rid") : truthy(get(edge, "id")) ? get(edge, "id") : ""),
      from: pyStr(truthy(get(edge, "from")) ? get(edge, "from") : ""),
      to: pyStr(truthy(get(edge, "to")) ? get(edge, "to") : ""),
      kind: edgeKind(get(edge, "kind")),
      event_or_condition: pyStr(truthy(get(edge, "label")) ? get(edge, "label") : ""),
    }));
    return {
      process_id: `proc.${this.runtime.sessionId}`,
      perspective: "AS_IS",
      steps,
      edges,
      gaps: this.runtime.pending().map((q) => q.id),
      // This is the auditable hand-off from the mature EXTRACT composite.
      source: "mature_extract_composite",
      oir_stats: oirStats(this.runtime.oirDict()),
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const modelSteps = new Map<string, Dict>();
    for (const row of mappingRows(draft["steps"])) {
      const id = nonEmptyString(row["id"]);
      if (id !== null && !modelSteps.has(id)) modelSteps.set(id, row);
    }
    const steps = mappingRows(seed["steps"]).map((base) => {
      const id = nonEmptyString(base["id"]) ?? "";
      const model = modelSteps.get(id);
      if (model === undefined) return base;
      const allowedObjects = new Set(
        unionStrings(base["input_data_ids"], base["output_data_ids"]),
      );
      const keepRefs = (value: unknown, fallback: unknown): string[] => {
        const refs = stringList(value).filter((ref) => allowedObjects.has(ref));
        return refs.length > 0 ? refs : stringList(fallback);
      };
      const baselineActor = nonEmptyString(base["actor_role"]);
      const modelActor = nonEmptyString(model["actor_role"]);
      const claimedEvidence = model["analysis_evidence_ids"] ?? model["evidence_ids"];
      const actorEvidence = modelActor === null
        ? []
        : this.runtime.evidenceSupporting(modelActor, claimedEvidence);
      const modelTrigger = nonEmptyString(model["trigger"]);
      const triggerEvidence = modelTrigger === null
        ? []
        : this.runtime.evidenceSupporting(modelTrigger, claimedEvidence);
      const modelPrecondition = nonEmptyString(model["precondition"]);
      const preconditionEvidence = modelPrecondition === null
        ? []
        : this.runtime.evidenceSupporting(modelPrecondition, claimedEvidence);
      const analysisEvidence = unionStrings(
        actorEvidence,
        triggerEvidence,
        preconditionEvidence,
      );
      return {
        ...base,
        actor_role:
          actorEvidence.length > 0 &&
          (baselineActor === null || baselineActor === "待确认") &&
          modelActor !== null
            ? modelActor
            : base["actor_role"],
        trigger: triggerEvidence.length > 0
          ? base["trigger"] ?? modelTrigger
          : base["trigger"],
        precondition: preconditionEvidence.length > 0
          ? base["precondition"] ?? modelPrecondition
          : base["precondition"],
        // Canonical object references are structural IDs, not words that a source
        // snippet can support. Keep the mature extractor's bindings unchanged.
        input_data_ids: keepRefs(base["input_data_ids"], base["input_data_ids"]),
        output_data_ids: keepRefs(base["output_data_ids"], base["output_data_ids"]),
        analysis_evidence_ids: analysisEvidence,
        // Stable structure and provenance remain owned by the source projection.
        id: base["id"],
        name: base["name"],
        system_ids: base["system_ids"],
        evidence_ids: base["evidence_ids"],
      };
    });

    const modelEdges = new Map<string, Dict>();
    for (const row of mappingRows(draft["edges"])) {
      const id = nonEmptyString(row["id"]);
      if (id !== null && !modelEdges.has(id)) modelEdges.set(id, row);
    }
    const edges = mappingRows(seed["edges"]).map((base) => {
      const model = modelEdges.get(nonEmptyString(base["id"]) ?? "");
      if (model === undefined) return base;
      const current = nonEmptyString(base["event_or_condition"]);
      const proposed = nonEmptyString(model["event_or_condition"]);
      const evidence = proposed === null
        ? []
        : this.runtime.evidenceSupporting(
          proposed,
          model["analysis_evidence_ids"] ?? model["evidence_ids"],
        );
      return {
        ...base,
        event_or_condition:
          current === null && evidence.length > 0
            ? (proposed ?? "")
            : base["event_or_condition"],
      };
    });
    return {
      ...seed,
      steps,
      edges,
      gaps: unionStrings(seed["gaps"], draft["gaps"]),
    };
  }
}

export class ERPMapHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "erp_mapper", opts);
  }

  project(inputs: Dict): Dict {
    const process = truthy(inputs["PROCESS"]) ? inputs["PROCESS"] : {};
    const landscape = new Map<string, Dict>();
    const mappings: Dict[] = [];
    for (const step of iterOf(get(process, "steps"))) {
      const stepEvidence = stringList(get(step, "evidence_ids"));
      for (const rawSystem of iterOf(get(step, "system_ids"))) {
        const raw = pyStrip(pyStr(rawSystem));
        if (raw === "") continue;
        const head = pySplit(raw, "//", 1).at(-1) as string;
        const name = pySplit(head, "/", 1)[0] || raw;
        const sid = `sys.${name}`;
        if (!landscape.has(sid)) {
          landscape.set(sid, {
            system_id: sid,
            // A hostname/path identifies a system endpoint, not an ERP product.
            // Keep product unknown until the ERP agent finds explicit evidence.
            product: null,
            version: null,
            module: null,
            org_scope: null,
            evidence_ids: stepEvidence,
          });
        } else {
          const current = landscape.get(sid)!;
          current["evidence_ids"] = unionStrings(current["evidence_ids"], stepEvidence);
        }
        mappings.push({
          // Python 是 `step["id"]`，缺键直接 KeyError。照抄地炸。
          process_step_id: mustGet(step, "id"),
          system_id: sid,
          implementation_kind: "UNKNOWN",
          target_refs: [raw],
          confidence: 0.5,
          evidence_ids: stepEvidence,
        });
      }
    }
    const questions = this.runtime
      .pending()
      .filter(
        (q) => q.audienceRole.toLowerCase().includes("erp") || q.audienceRole.includes("顾问"),
      )
      .map((q) => q.id);
    return { landscape: [...landscape.values()], mappings, questions };
  }

  protected mergeDraft(seed: Dict, draft: Dict, inputs: Dict): Dict {
    const landscape = new Map<string, Dict>();
    for (const row of mappingRows(seed["landscape"])) {
      const id = nonEmptyString(row["system_id"]);
      if (id !== null) landscape.set(id, row);
    }
    for (const row of mappingRows(draft["landscape"])) {
      const id = nonEmptyString(row["system_id"]);
      if (id === null) continue;
      const old = landscape.get(id);
      const claimedEvidence = row["analysis_evidence_ids"] ?? row["evidence_ids"];
      const supportedField = (field: string): [unknown, string[]] => {
        const value = row[field];
        return [value, this.runtime.evidenceSupporting(value, claimedEvidence)];
      };
      const [product, productEvidence] = supportedField("product");
      const [version, versionEvidence] = supportedField("version");
      const [moduleName, moduleEvidence] = supportedField("module");
      const [orgScope, orgEvidence] = supportedField("org_scope");
      const evidence = unionStrings(productEvidence, versionEvidence, moduleEvidence, orgEvidence);
      if (old === undefined) {
        const identityEvidence = this.runtime.evidenceSupporting(id, claimedEvidence);
        if (identityEvidence.length > 0 && evidence.length > 0) {
          landscape.set(id, {
            system_id: id,
            product: productEvidence.length > 0 ? product : null,
            version: versionEvidence.length > 0 ? version : null,
            module: moduleEvidence.length > 0 ? moduleName : null,
            org_scope: orgEvidence.length > 0 ? orgScope : null,
            evidence_ids: unionStrings(identityEvidence, evidence),
            analysis_evidence_ids: unionStrings(identityEvidence, evidence),
          });
        }
      }
      else {
        if (evidence.length === 0) continue;
        landscape.set(id, {
          ...old,
          product: productEvidence.length > 0
            ? nonEmptyString(product) ?? old["product"]
            : old["product"],
          version: versionEvidence.length > 0
            ? nonEmptyString(version) ?? old["version"]
            : old["version"],
          module: moduleEvidence.length > 0
            ? nonEmptyString(moduleName) ?? old["module"]
            : old["module"],
          org_scope: orgEvidence.length > 0
            ? nonEmptyString(orgScope) ?? old["org_scope"]
            : old["org_scope"],
          evidence_ids: unionStrings(old["evidence_ids"], evidence),
          analysis_evidence_ids: evidence,
        });
      }
    }

    const processIds = new Set(
      mappingRows(get(inputs["PROCESS"], "steps"))
        .map((row) => nonEmptyString(row["id"]))
        .filter((id): id is string => id !== null),
    );
    const keyed = new Map<string, Dict>();
    const keyOf = (row: Dict): string =>
      `${nonEmptyString(row["process_step_id"]) ?? ""}\u0000${nonEmptyString(row["system_id"]) ?? ""}`;
    for (const row of mappingRows(seed["mappings"])) keyed.set(keyOf(row), row);
    for (const row of mappingRows(draft["mappings"])) {
      const step = nonEmptyString(row["process_step_id"]);
      const system = nonEmptyString(row["system_id"]);
      if (step === null || system === null || !processIds.has(step)) continue;
      const key = keyOf(row);
      const old = keyed.get(key);
      const claimedEvidence = row["analysis_evidence_ids"] ?? row["evidence_ids"];
      const kindEvidence = this.runtime.evidenceSupporting(row["implementation_kind"], claimedEvidence);
      const targetEvidence = this.runtime.evidenceSupporting(row["target_refs"], claimedEvidence);
      const analysisEvidence = unionStrings(kindEvidence, targetEvidence);
      if (old === undefined) {
        if (kindEvidence.length === 0 || targetEvidence.length === 0 || !landscape.has(system)) continue;
        keyed.set(key, {
          ...row,
          confidence: numberInRange(row["confidence"], 0, 1, 0.5),
          evidence_ids: analysisEvidence,
          analysis_evidence_ids: analysisEvidence,
        });
        continue;
      }
      if (analysisEvidence.length === 0) continue;
      keyed.set(key, {
        ...old,
        implementation_kind:
          old["implementation_kind"] === "UNKNOWN" &&
          kindEvidence.length > 0 &&
          nonEmptyString(row["implementation_kind"]) !== null
            ? row["implementation_kind"]
            : old["implementation_kind"],
        target_refs: targetEvidence.length > 0
          ? unionStrings(old["target_refs"], row["target_refs"])
          : old["target_refs"],
        confidence: numberInRange(row["confidence"], 0, 1, Number(old["confidence"] ?? 0.5)),
        evidence_ids: unionStrings(
          old["evidence_ids"],
          analysisEvidence,
        ),
        analysis_evidence_ids: analysisEvidence,
      });
    }
    return {
      landscape: [...landscape.values()],
      mappings: [...keyed.values()],
      questions: unionStrings(seed["questions"], draft["questions"]),
    };
  }
}

export class RulesHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "rule_engineer", opts);
  }

  project(_inputs: Dict): Dict {
    const rows: Dict[] = [];
    for (const rule of iterOf(this.runtime.oirDict()["rules"])) {
      const statement = pyStrip(
        pyStr(truthy(valueOf(get(rule, "statement"))) ? valueOf(get(rule, "statement")) : ""),
      );
      if (statement === "") continue;
      const rawKind = pyStr(
        truthy(valueOf(get(rule, "ruleKind"))) ? valueOf(get(rule, "ruleKind")) : "OTHER",
      ).toUpperCase();
      const kind = ["VALIDATION", "PROCESS", "AUTHORITY", "CALCULATION", "DERIVATION"].includes(
        rawKind,
      )
        ? rawKind
        : "VALIDATION";
      rows.push({
        id: pyStr(truthy(get(rule, "rid")) ? get(rule, "rid") : ""),
        kind,
        trigger_event_id: null,
        applies_to_ids: [...iterOf(get(rule, "appliesTo"))],
        // Preserve the source statement.  Compilation into an executable
        // expression remains explicit instead of inventing business logic.
        condition: statement,
        effect: statement,
        exceptions: [],
        evidence_ids: evidenceIds(get(rule, "statement"), get(rule, "ruleKind")),
        test_cases: [],
      });
    }
    const questions = this.runtime
      .pending()
      .filter((q) => q.sourceKind === "rule" || q.sourceKind === "conflict")
      .map((q) => q.id);
    return { rules: rows, conflicts: [], questions };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const modelRules = new Map<string, Dict>();
    for (const row of mappingRows(draft["rules"])) {
      const id = nonEmptyString(row["id"]);
      if (id !== null && !modelRules.has(id)) modelRules.set(id, row);
    }
    const rules = mappingRows(seed["rules"]).map((base) => {
      const model = modelRules.get(nonEmptyString(base["id"]) ?? "");
      if (model === undefined) return base;
      const claimedEvidence = model["analysis_evidence_ids"] ?? model["evidence_ids"];
      const conditionEvidence = this.runtime.evidenceSupporting(model["condition"], claimedEvidence);
      const effectEvidence = this.runtime.evidenceSupporting(model["effect"], claimedEvidence);
      const exceptionEvidence = this.runtime.evidenceSupporting(model["exceptions"], claimedEvidence);
      const analysisEvidence = unionStrings(conditionEvidence, effectEvidence, exceptionEvidence);
      if (analysisEvidence.length === 0) return base;
      return {
        ...base,
        // Rule kind and event IDs are normalized structure, not literal source values.
        kind: base["kind"],
        trigger_event_id: base["trigger_event_id"],
        condition: conditionEvidence.length > 0
          ? nonEmptyString(model["condition"]) ?? base["condition"]
          : base["condition"],
        effect: effectEvidence.length > 0
          ? nonEmptyString(model["effect"]) ?? base["effect"]
          : base["effect"],
        exceptions: exceptionEvidence.length > 0
          ? unionStrings(base["exceptions"], model["exceptions"])
          : base["exceptions"],
        // Generated tests remain in the dedicated acceptance stage; they are not
        // material facts and must not hitch a ride on a row-level citation.
        test_cases: base["test_cases"],
        // Scope and source evidence cannot be replaced by a generated response.
        id: base["id"],
        applies_to_ids: base["applies_to_ids"],
        evidence_ids: unionStrings(
          base["evidence_ids"],
          analysisEvidence,
        ),
        analysis_evidence_ids: analysisEvidence,
      };
    });
    return {
      rules,
      conflicts: unionStrings(seed["conflicts"], draft["conflicts"]),
      questions: unionStrings(seed["questions"], draft["questions"]),
    };
  }
}

export class DataObjectsHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "data_steward", opts);
  }

  project(_inputs: Dict): Dict {
    const rows: Dict[] = [];
    for (const obj of iterOf(this.runtime.oirDict()["objects"])) {
      const name = pyStr(
        truthy(valueOf(get(obj, "displayName")))
          ? valueOf(get(obj, "displayName"))
          : truthy(valueOf(get(obj, "apiName")))
            ? valueOf(get(obj, "apiName"))
            : "",
      );
      rows.push({
        id: pyStr(truthy(get(obj, "rid")) ? get(obj, "rid") : ""),
        name: name || pyStr(truthy(get(obj, "rid")) ? get(obj, "rid") : "未命名对象"),
        classification: classification(name),
        business_keys: [...iterOf(valueOf(get(obj, "primaryKey"), []))],
        system_of_record: null,
        owner_role: null,
        lifecycle_states: [],
        sensitivity: "UNKNOWN",
        evidence_ids: evidenceIds(get(obj, "apiName"), get(obj, "displayName")),
      });
    }
    const questions = this.runtime
      .pending()
      .filter((q) => q.sourceKind === "data_object" || q.sourceKind === "open_question")
      .map((q) => q.id);
    return { data_objects: rows, quality_rules: [], questions };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const modelObjects = new Map<string, Dict>();
    for (const row of mappingRows(draft["data_objects"])) {
      const id = nonEmptyString(row["id"]);
      if (id !== null && !modelObjects.has(id)) modelObjects.set(id, row);
    }
    const dataObjects = mappingRows(seed["data_objects"]).map((base) => {
      const model = modelObjects.get(nonEmptyString(base["id"]) ?? "");
      if (model === undefined) return base;
      const claimedEvidence = model["analysis_evidence_ids"] ?? model["evidence_ids"];
      const sorEvidence = this.runtime.evidenceSupporting(model["system_of_record"], claimedEvidence);
      const ownerEvidence = this.runtime.evidenceSupporting(model["owner_role"], claimedEvidence);
      const lifecycleEvidence = this.runtime.evidenceSupporting(model["lifecycle_states"], claimedEvidence);
      const sensitivityEvidence = this.runtime.evidenceSupporting(model["sensitivity"], claimedEvidence);
      const analysisEvidence = unionStrings(
        sorEvidence,
        ownerEvidence,
        lifecycleEvidence,
        sensitivityEvidence,
      );
      if (analysisEvidence.length === 0) return base;
      return {
        ...base,
        classification: base["classification"],
        system_of_record: sorEvidence.length > 0
          ? base["system_of_record"] ?? model["system_of_record"] ?? null
          : base["system_of_record"],
        owner_role: ownerEvidence.length > 0
          ? base["owner_role"] ?? model["owner_role"] ?? null
          : base["owner_role"],
        lifecycle_states: lifecycleEvidence.length > 0
          ? unionStrings(base["lifecycle_states"], model["lifecycle_states"])
          : base["lifecycle_states"],
        sensitivity:
          sensitivityEvidence.length > 0 &&
          base["sensitivity"] === "UNKNOWN" && nonEmptyString(model["sensitivity"]) !== null
            ? model["sensitivity"]
            : base["sensitivity"],
        id: base["id"],
        name: base["name"],
        business_keys: base["business_keys"],
        evidence_ids: unionStrings(
          base["evidence_ids"],
          analysisEvidence,
        ),
        analysis_evidence_ids: analysisEvidence,
      };
    });
    const objectIds = new Set(dataObjects.map((row) => nonEmptyString(row["id"])).filter(Boolean));
    const qualityRules = mappingRows(draft["quality_rules"]).filter((row) => {
      const id = nonEmptyString(row["id"]);
      const target = nonEmptyString(row["data_object_id"]);
      const claimedEvidence = row["analysis_evidence_ids"] ?? row["evidence_ids"];
      const expressionEvidence = this.runtime.evidenceSupporting(row["expression"], claimedEvidence);
      const dimensionEvidence = this.runtime.evidenceSupporting(row["dimension"], claimedEvidence);
      const thresholdEvidence = row["threshold"] === null || row["threshold"] === undefined
        ? expressionEvidence
        : this.runtime.evidenceSupporting(row["threshold"], claimedEvidence);
      const evidence = unionStrings(expressionEvidence, dimensionEvidence, thresholdEvidence);
      row["evidence_ids"] = evidence;
      row["analysis_evidence_ids"] = evidence;
      return id !== null && target !== null && objectIds.has(target) &&
        expressionEvidence.length > 0 && dimensionEvidence.length > 0 && thresholdEvidence.length > 0;
    });
    return {
      data_objects: dataObjects,
      quality_rules: qualityRules,
      questions: unionStrings(seed["questions"], draft["questions"]),
    };
  }
}

export class GapHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "合并专业节点发现的缺口并按阻塞性排序。";
  }

  override execute(inputs: Dict, _ctx: RunContext): Promise<Dict> {
    const backlog = this.runtime.questionBacklog();
    const added = this.collectAgentQuestions(inputs, backlog);
    const out: Dict = {
      contract: "QuestionBacklog",
      questions: backlog.toDict()["questions"],
      pending: this.runtime.pending().map((q) => q.id),
      next_batch: backlog.nextBatch({ limit: 5 }).map((q) => q.id),
      stats: backlog.stats(),
      // `sorted(inputs)` —— 对 dict 排序就是对**键**排序。
      sources: Object.keys(inputs).sort(cmpCodePoint),
    };
    // Keep the compatibility projection byte-for-byte stable when no model added work.
    if (added > 0) out["agent_added"] = added;
    return Promise.resolve(out);
  }

  private collectAgentQuestions(inputs: Dict, backlog: QuestionBacklog): number {
    const existingText = new Set(
      [...backlog.questions.values()].map((q) => normaliseQuestionText(q.text)),
    );
    const generatedAt = Date.parse(this.runtime.generatedAt);
    const createdAt = Number.isFinite(generatedAt) ? generatedAt / 1000 : 0;
    let added = 0;

    const addCandidate = (raw: unknown, sourceNode: string, audience: string): void => {
      if (typeof raw === "string" && backlog.questions.has(raw)) return;
      const row = isMapping(raw) ? raw : {};
      const text = nonEmptyString(isMapping(raw) ? raw["text"] : raw);
      if (text === null) return;
      const normal = normaliseQuestionText(text);
      if (normal === "" || existingText.has(normal)) return;

      const evidence = this.runtime.verifiedEvidence(row["evidence_ids"]);
      const requested = nonEmptyString(row["priority"])?.toUpperCase() ?? "HIGH";
      // Agent-discovered questions currently have no deterministic field-level
      // answer applier.  They may mark a package DRAFT, but must not become a hard
      // release blocker that an "ANSWERED" status could clear without changing
      // the underlying ERP/rule/governance value.
      const priority =
        requested === "LOW"
          ? QuestionPriority.LOW
          : requested === "NORMAL"
            ? QuestionPriority.NORMAL
            : QuestionPriority.HIGH;
      const id = `q.agent.${sha256Hex(`${sourceNode}\u0000${normal}`).slice(0, 20)}`;
      backlog.add(
        new Question({
          id,
          text,
          audienceRole: nonEmptyString(row["audience_role"]) ?? audience,
          answerSchema: candidateAnswerSchema(row["answer_schema"]),
          priority,
          // Model output may name a filename or UI artifact here.  Blocking is
          // represented by priority; canonical refs are never guessed.
          blockedArtifacts: [],
          evidenceIds: evidence,
          sourceKind: "agent_analysis",
          sourceRef: sourceNode,
          why:
            nonEmptyString(row["why"]) ??
            `由 ${sourceNode} 独立分析发现，需由相应业务角色确认`,
          group: professionalQuestionGroup(sourceNode),
          code: `AGENT_${sourceNode}_GAP`,
          createdAt,
          updatedAt: createdAt,
          metadata: { agentGenerated: true, sourceNode },
        }),
        { preserveLifecycle: true },
      );
      existingText.add(normal);
      added += 1;
    };

    for (const row of mappingRows(get(inputs["INTAKE"], "questions"))) {
      // Existing projected rows carry real backlog IDs and are already present.
      if (backlog.questions.has(nonEmptyString(row["id"]) ?? "")) continue;
      addCandidate(row, "INTAKE", "业务负责人");
    }
    for (const [node, field, audience] of [
      ["PROCESS", "gaps", "流程负责人"],
      ["ERP_MAP", "questions", "ERP顾问"],
      ["RULES", "conflicts", "业务规则负责人"],
      ["RULES", "questions", "业务规则负责人"],
      ["DATA_OBJECTS", "questions", "数据负责人"],
    ] as const) {
      for (const raw of iterOf(get(inputs[node], field))) addCandidate(raw, node, audience);
    }
    return added;
  }
}

function normaliseQuestionText(text: string): string {
  return pyStrip(text).toLowerCase().replace(/[\s\u3000]+/gu, " ").replace(/[？?。！!]+$/u, "");
}

function professionalQuestionGroup(node: string): string {
  return {
    INTAKE: "访谈范围",
    PROCESS: "流程语义",
    ERP_MAP: "ERP 映射",
    RULES: "业务规则",
    DATA_OBJECTS: "数据治理",
  }[node] ?? "专业分析";
}

function candidateAnswerSchema(value: unknown): Dict {
  if (!isMapping(value)) return { type: "string" };
  // Existing backlog questions already carry real JSON Schema and must round-trip.
  if (nonEmptyString(value["type"]) !== null) return { ...value };
  const kind = nonEmptyString(value["kind"])?.toUpperCase() ?? "TEXT";
  const type =
    kind === "NUMBER"
      ? "number"
      : kind === "INTEGER"
        ? "integer"
        : kind === "BOOLEAN"
          ? "boolean"
          : "string";
  const out: Dict = { type };
  const options = stringList(value["options"]);
  if (kind === "SINGLE_CHOICE" && options.length > 0) out["enum"] = options;
  return out;
}

function interviewerAnswerSchema(value: unknown): Dict {
  if (!isMapping(value)) return { kind: "TEXT", options: [] };
  const options = stringList(value["enum"] ?? value["options"]);
  const raw = nonEmptyString(value["type"])?.toLowerCase() ?? "string";
  const kind =
    options.length > 0
      ? "SINGLE_CHOICE"
      : raw === "number"
        ? "NUMBER"
        : raw === "integer"
          ? "INTEGER"
          : raw === "boolean"
            ? "BOOLEAN"
            : "TEXT";
  return { kind, options: kind === "SINGLE_CHOICE" ? options : [] };
}

export class InterviewHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "等待 FDE 通过 Question/Decision 工作台完成阻塞决策。";
  }

  override skipModel(_inputs: Dict): unknown {
    if (this.runtime.blockers().length > 0) return null;
    return {
      contract: "DecisionLedger",
      decisions: this.runtime.decisionRows(),
      resolved: true,
      // `resolved` only closes the interview backlog.  Formal release is owned
      // exclusively by HUMAN_ACCEPTANCE later in the v3 DAG.
      releaseState: "DRAFT",
    };
  }

  override humanRequest(_draft: unknown, _inputs: Dict): Dict {
    const blockers = this.runtime.blockers();
    const batch = blockers.slice(0, 5);
    return {
      contract: "QuestionBacklog",
      questions: batch.map((q) => q.toDict()),
      pending: blockers.length,
      unresolved: this.runtime.pending().length,
      action: "answer_questions",
    };
  }
}

/**
 * 「这次梳理没有任何人工拍板记录」——推导出来的一条 SkippedReview。
 *
 * 为什么必须有它：`InterviewHandler.skipModel` 在 `blockers().length === 0` 时
 * 返回非 null，于是 `AgentLoop.produce()` 里的 `askHuman` 不可达。而 BLOCKING
 * 的唯一来源是"材料里检出了冲突"—— **一份内部自洽、写得干净的制度文档就能让
 * 零个人类看过这次交付**，而 DAG 上显示 INTERVIEW 已完成。这比写出互相矛盾的
 * 文档容易得多，所以它不是边角情况。
 *
 * 为什么是**推导**而不是让 InterviewHandler 往 runtime 上累加：重放时已完成的
 * 节点整个跳过（`Recorder.nodeIsComplete`），INTERVIEW 不会重跑，累加上去的标记
 * 会在续跑的产物里凭空消失。从 `decisionRows()` 推则无状态、可重放、连造两次
 * 结果一致。
 *
 * 措辞只说"没有拍板记录"，不说"人没看过"——我们能证明的只有前者。
 */
function humanReviewGap(runtime: EngagementRuntimeInput): SkippedReview[] {
  if (runtime.decisionRows().length > 0) return [];
  return [
    {
      what: "human_review",
      why: "本次 INTERVIEW 没有业务事实拍板记录；这与下游正式 release acceptance 是两个独立控制点",
      level: 0,
      label: "无业务事实拍板记录",
    },
  ];
}

/**
 * Translate durable human decisions into a read-only change proposal.  This node
 * never owns mutation authority: even a fully targeted proposal remains a proposal
 * until a domain-specific applier with optimistic concurrency exists.
 */
export class DecisionProposalHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "decision_integrator", opts);
  }

  project(_inputs: Dict): Dict {
    const assessments: Dict[] = [];
    const proposals: Dict[] = [];
    const unresolved: Dict[] = [];
    for (const decision of this.runtime.businessDecisionRows()) {
      const id = decisionId(decision) ?? `decision.${sha256Hex(JSON.stringify(decision)).slice(0, 20)}`;
      const affected = decisionAffectedIds(decision);
      const metadata = isMapping(decision["metadata"]) ? decision["metadata"] : {};
      const answer = isMapping(decision["answer"]) ? decision["answer"] : {};
      const target = isMapping(metadata["target"])
        ? metadata["target"]
        : isMapping(answer["target"])
          ? answer["target"]
          : {};
      const entityId = targetIdOf({ target });
      const entityType = targetTypeOf({ target });
      const field = targetFieldOf({ target });
      const targetIsDeclared =
        entityId !== null && entityType !== null && field !== null && affected.includes(entityId);
      const supersedes = firstString(decision, "supersedes");
      assessments.push({
        decision_id: id,
        state: targetIsDeclared ? "APPLICABLE" : "AMBIGUOUS",
        summary: `决定 ${id}：${pyStr(decision["answer"] ?? "")}`,
        target_ids: affected,
        supersedes_decision_ids: supersedes === null ? [] : [supersedes],
        evidence_ids: this.runtime.verifiedEvidence(
          isMapping(decision["metadata"]) ? decision["metadata"]["evidence_ids"] : [],
        ),
        rationale: targetIsDeclared
          ? "决定携带可验证的 typed target；仅形成候选 patch"
          : "决定没有同时给出 entity_type/entity_id/field，或 entity_id 未列入 affectedIds",
      });
      if (!targetIsDeclared) {
        unresolved.push({
          id: `unresolved.${sha256Hex(`${id}\u0000MISSING_TARGET`).slice(0, 20)}`,
          decision_id: id,
          code: "MISSING_TARGET",
          message: "决定尚未绑定可验证的 entity_type/entity_id/field；禁止写入",
          owner_role: firstString(decision, "actorRole", "actor_role") ?? "业务决策负责人",
          blocked_artifact_ids: ["decision-application.json"],
          evidence_ids: [],
        });
        continue;
      }
      proposals.push({
        id: `patch.${sha256Hex(`${id}\u0000${entityType}\u0000${entityId}\u0000${field}`).slice(0, 20)}`,
        decision_id: id,
        operation: decisionOperation(
          firstString(metadata, "operation") ?? firstString(answer, "operation"),
        ),
        target_kind: decisionTargetKind(entityType),
        target_id: entityId,
        field_path: field,
        before_summary: null,
        after_summary: pyStr(
          Object.hasOwn(answer, "value") ? answer["value"] : decision["answer"],
        ),
        preconditions: [`artifact revision == ${this.runtime.artifactRevision}`],
        affected_ids: affected,
        risk: "MEDIUM",
        evidence_ids: [],
      });
    }
    return {
      base_revision: this.runtime.artifactRevision,
      decision_assessments: assessments,
      patch_proposals: proposals,
      unresolved_items: unresolved,
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const known = new Set(
      this.runtime.businessDecisionRows()
        .map((row) => decisionId(row))
        .filter((id): id is string => id !== null),
    );
    const proposals = new Map<string, Dict>();
    for (const row of mappingRows(seed["patch_proposals"])) proposals.set(rowId(row, "patch"), row);
    for (const row of mappingRows(draft["patch_proposals"])) {
      const linked = firstString(row, "decision_id", "decisionId");
      if (linked === null || !known.has(linked)) continue;
      const id = rowId(row, "patch");
      proposals.set(id, {
        ...row,
        id,
        decision_id: linked,
      });
    }
    return {
      base_revision: this.runtime.artifactRevision,
      decision_assessments: mergeRowsById(
        seed["decision_assessments"],
        draft["decision_assessments"],
        "decision-assessment",
        (row) => {
          const id = firstString(row, "decision_id", "decisionId");
          return id !== null && known.has(id);
        },
      ),
      patch_proposals: [...proposals.values()],
      unresolved_items: mergeRowsById(
        seed["unresolved_items"],
        draft["unresolved_items"],
        "decision-unresolved",
      ),
    };
  }
}

function stableTargetIds(runtime: EngagementRuntimeInput): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const bucket of [
    "objects",
    "properties",
    "links",
    "actions",
    "events",
    "rules",
    "questions",
  ]) {
    for (const row of mappingRows(runtime.oirDict()[bucket])) {
      const id = firstString(row, "rid", "id");
      if (id !== null) ids.add(id);
    }
  }
  for (const bucket of ["nodes", "edges"]) {
    for (const row of mappingRows(runtime.flowDict()[bucket])) {
      const id = firstString(row, "rid", "id");
      if (id !== null) ids.add(id);
    }
  }
  for (const question of runtime.questionBacklog().questions.values()) ids.add(question.id);
  return ids;
}

/**
 * Fail-closed validator for decision proposals.  It deliberately performs zero
 * mutations and reports zero applied changes: validation is not application.
 */
export class DecisionApplicationHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "确定性校验决定 patch 的版本、来源和 typed target；不执行任何写入。";
  }

  override execute(inputs: Dict, _ctx: RunContext): Promise<Dict> {
    const proposal = isMapping(inputs["DECISION_PROPOSAL"]) ? inputs["DECISION_PROPOSAL"] : {};
    const baseRevision = Number(proposal["base_revision"]);
    const baseRevisionMatches = baseRevision === this.runtime.artifactRevision;
    const knownTargets = stableTargetIds(this.runtime);
    const decisions = new Map<string, Dict>();
    for (const row of this.runtime.businessDecisionRows()) {
      const id = decisionId(row);
      if (id !== null) decisions.set(id, row);
    }
    const validated: Dict[] = [];
    const rejected: Dict[] = [];
    let untargeted = 0;
    let claimedApplied = 0;
    const represented = new Set<string>();

    for (const patch of mappingRows(proposal["patch_proposals"])) {
      const id = rowId(patch, "patch");
      const linked = firstString(patch, "decision_id", "decisionId");
      const entityId = targetIdOf(patch);
      const entityType = targetTypeOf(patch);
      const field = targetFieldOf(patch);
      const status = firstString(patch, "status")?.toUpperCase() ?? "PROPOSED";
      if (patch["applied"] === true || status === "APPLIED") claimedApplied += 1;
      const reasons: string[] = [];
      if (!baseRevisionMatches) reasons.push("BASE_REVISION_MISMATCH");
      if (linked === null || !decisions.has(linked)) reasons.push("UNKNOWN_DECISION");
      if (entityId === null || entityType === null || field === null) {
        untargeted += 1;
        reasons.push("TYPED_TARGET_REQUIRED");
      } else if (!knownTargets.has(entityId)) {
        reasons.push("UNKNOWN_TARGET_ID");
      }
      const source = linked === null ? undefined : decisions.get(linked);
      if (
        source !== undefined &&
        entityId !== null &&
        !decisionAffectedIds(source).includes(entityId)
      ) {
        reasons.push("TARGET_NOT_AUTHORIZED_BY_DECISION");
      }
      if (patch["applied"] === true || status === "APPLIED") reasons.push("AGENT_CLAIMED_APPLIED");
      if (reasons.length > 0) {
        rejected.push({ id, decision_id: linked, reasons, proposal: patch });
        continue;
      }
      represented.add(linked as string);
      validated.push({
        ...patch,
        id,
        decision_id: linked,
        target: { entity_type: entityType, entity_id: entityId, field },
        base_revision: this.runtime.artifactRevision,
        status: "VALIDATED_NOT_APPLIED",
      });
    }

    const unapplied = this.runtime.businessDecisionRows()
      .filter((row) => {
        const id = decisionId(row);
        return id === null || !represented.has(id);
      })
      .map((row) => ({
        decision_id: decisionId(row),
        question_id: decisionQuestionId(row),
        reason: "NO_APPLIER_COMMIT",
      }));
    const safe =
      baseRevisionMatches && rejected.length === 0 && untargeted === 0 && claimedApplied === 0;
    return Promise.resolve({
      contract: "DecisionApplicationValidation.v1",
      base_revision: this.runtime.artifactRevision,
      proposed_base_revision: Number.isFinite(baseRevision) ? baseRevision : null,
      base_revision_matches: baseRevisionMatches,
      status:
        validated.length > 0
          ? "VALIDATED_NOT_APPLIED"
          : unapplied.length > 0
            ? "UNAPPLIED"
            : "NO_CHANGES",
      safe_to_continue: safe,
      validated_patches: validated,
      rejected_patches: rejected,
      unapplied_decisions: unapplied,
      validated_count: validated.length,
      rejected_count: rejected.length,
      unapplied_count: unapplied.length,
      untargeted_write_count: untargeted,
      claimed_applied_count: claimedApplied,
      mutation_count: 0,
      applied_changes: [],
      applied: false,
    });
  }
}

export class RequirementsHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "requirements_engineer", opts);
  }

  project(inputs: Dict): Dict {
    const requirements: Dict[] = [];
    for (const rule of mappingRows(get(inputs["RULES"], "rules"))) {
      const sourceId = firstString(rule, "id") ?? "unknown-rule";
      const statement = firstString(rule, "effect", "condition") ?? sourceId;
      const evidence = stringList(rule["evidence_ids"]);
      requirements.push({
        id: `req.${sha256Hex(`rule\u0000${sourceId}`).slice(0, 20)}`,
        title: clipCodePoints(statement, 120),
        type: "CONTROL",
        statement,
        confirmation_status: "CANDIDATE",
        priority: "UNSET",
        owner_role: null,
        stakeholder_roles: [],
        acceptance_criteria: [`在适用条件下可观察到：${statement}`],
        depends_on_ids: [],
        related_artifact_ids: [sourceId],
        evidence_ids: evidence,
      });
    }
    for (const step of mappingRows(get(inputs["PROCESS"], "steps"))) {
      const sourceId = firstString(step, "id") ?? "unknown-step";
      const stepName = firstString(step, "name") ?? sourceId;
      const evidence = stringList(step["evidence_ids"]);
      requirements.push({
        id: `req.${sha256Hex(`process\u0000${sourceId}`).slice(0, 20)}`,
        title: `支持流程步骤：${stepName}`,
        type: "FUNCTIONAL",
        statement: `系统应支持流程步骤：${stepName}`,
        confirmation_status: "CANDIDATE",
        priority: "UNSET",
        owner_role: firstString(step, "actor_role"),
        stakeholder_roles: firstString(step, "actor_role") === null
          ? []
          : [firstString(step, "actor_role") as string],
        acceptance_criteria: [`能够按 AS-IS 流程执行并观察到“${stepName}”的结果`],
        depends_on_ids: [],
        related_artifact_ids: [sourceId],
        evidence_ids: evidence,
      });
    }
    return {
      requirements,
      coverage_assessments: requirements.map((requirement) => ({
        requirement_id: requirement["id"],
        status: "UNKNOWN",
        capability_ids: [],
        rationale: "确定性基线没有足够证据证明当前能力覆盖，交由 Requirements Agent 评估",
        downstream_impact: "未完成覆盖评估前，架构 disposition 与验收范围保持候选状态",
        evidence_ids: requirement["evidence_ids"],
      })),
      questions: structuredQuestions(this.runtime),
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const grounded = (row: Dict): boolean => {
      const refs = this.runtime.verifiedEvidence(row["analysis_evidence_ids"] ?? row["evidence_ids"]);
      if (refs.length > 0) row["analysis_evidence_ids"] = refs;
      return refs.length > 0;
    };
    const requirements = mergeRowsById(
      seed["requirements"],
      draft["requirements"],
      "req",
      // A model-authored requirement is a proposal, not a material fact. Until
      // claim-level evidence is available, keep it in questions instead of the
      // release candidate.
      () => false,
      (_old, row) => grounded(row),
    );
    const baselineById = new Map(
      mappingRows(seed["requirements"]).map((row) => [rowId(row, "req"), row]),
    );
    for (const row of requirements) {
      const base = baselineById.get(rowId(row, "req"));
      if (base === undefined) continue;
      // Confirmation and priority are human decisions. A professional agent may
      // suggest acceptance wording, but it cannot promote CANDIDATE to CONFIRMED
      // or UNSET to MUST by repeating a real (possibly unrelated) cite.
      for (const key of [
        "id", "title", "type", "statement", "confirmation_status", "priority",
        "related_artifact_ids", "evidence_ids",
      ]) row[key] = base[key];
    }
    return {
      requirements,
      // FIT/GAP is a downstream assessment, not an extractive material field.
      // Keep UNKNOWN until a deterministic capability check or a bound human
      // decision exists; a row-level citation cannot prove coverage.
      coverage_assessments: mappingRows(seed["coverage_assessments"]),
      questions: mergeRowsById(seed["questions"], draft["questions"], "requirement-question"),
    };
  }
}

export class ArchitectureHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "solution_architect", opts);
  }

  project(inputs: Dict): Dict {
    const components = mappingRows(get(inputs["ERP_MAP"], "landscape")).map((system) => ({
      id: firstString(system, "system_id") ?? rowId(system, "component"),
      name: firstString(system, "product", "system_id") ?? "Unknown system",
      kind: "EXISTING_SYSTEM",
      status: stringList(system["evidence_ids"]).length > 0 ? "EXISTING" : "UNKNOWN",
      responsibility: "支撑已识别流程步骤；具体边界待架构确认",
      system_id: firstString(system, "system_id"),
      requirement_ids: [],
      evidence_ids: stringList(system["evidence_ids"]),
    }));
    const dispositions = mappingRows(get(inputs["REQUIREMENTS"], "coverage_assessments")).map(
      (coverage) => {
        const requirementId = firstString(coverage, "requirement_id") ?? "unknown-requirement";
        const fit = firstString(coverage, "status") ?? "UNKNOWN";
        return {
          id: `fitgap.${sha256Hex(requirementId).slice(0, 20)}`,
          requirement_id: requirementId,
          fit: ["FIT", "PARTIAL_FIT", "GAP", "UNKNOWN"].includes(fit) ? fit : "UNKNOWN",
          proposed_disposition: fit === "FIT" ? "REUSE" : "UNKNOWN",
          component_ids: stringList(coverage["capability_ids"]).filter((id) =>
            components.some((component) => component.id === id),
          ),
          rationale: firstString(coverage, "rationale") ?? "当前覆盖证据不足，保持 UNKNOWN",
          constraints: [],
          impact_summary:
            firstString(coverage, "downstream_impact") ?? "需在方案评审中确认下游影响",
          evidence_ids: stringList(coverage["evidence_ids"]),
        };
      },
    );
    const risks: Dict[] = [];
    const outstanding =
      Number(get(inputs["DECISION_APPLY"], "validated_count") ?? 0) +
      Number(get(inputs["DECISION_APPLY"], "unapplied_count") ?? 0);
    if (outstanding > 0) {
      risks.push({
        id: "risk.unapplied-decisions",
        epistemic_status: "FACT",
        severity: "HIGH",
        statement: `${outstanding} 条决定变更尚未由领域 applier 提交，架构不得假定已生效`,
        mitigation_candidate: "在实施阶段通过有乐观锁的领域 applier 提交并复验影响",
        owner_role: "solution_architect",
        related_ids: ["DECISION_APPLY"],
        evidence_ids: [],
      });
    }
    return {
      components,
      fit_gap_dispositions: dispositions,
      integration_contracts: [],
      risks,
      questions: mergeRowsById(
        structuredQuestions(this.runtime),
        get(inputs["REQUIREMENTS"], "questions"),
        "architecture-question",
      ),
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    return {
      // These rows describe solution decisions, not verbatim material facts.
      // A model may discuss them as candidates, but it cannot mutate the release
      // candidate until a decision is explicitly bound and applied.
      components: mappingRows(seed["components"]),
      fit_gap_dispositions: mappingRows(seed["fit_gap_dispositions"]),
      integration_contracts: mappingRows(seed["integration_contracts"]),
      risks: mappingRows(seed["risks"]),
      questions: mergeRowsById(seed["questions"], draft["questions"], "architecture-question"),
    };
  }
}

export class AcceptanceTestHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "acceptance_test_engineer", opts);
  }

  project(inputs: Dict): Dict {
    const testCases: Dict[] = [];
    const ruleIds = new Set(
      mappingRows(get(inputs["RULES"], "rules"))
        .map((row) => firstString(row, "id"))
        .filter((id): id is string => id !== null),
    );
    const processIds = new Set(
      mappingRows(get(inputs["PROCESS"], "steps"))
        .map((row) => firstString(row, "id"))
        .filter((id): id is string => id !== null),
    );
    const contracts = mappingRows(get(inputs["ARCHITECTURE"], "integration_contracts"));
    for (const requirement of mappingRows(get(inputs["REQUIREMENTS"], "requirements"))) {
      const requirementId = firstString(requirement, "id") ?? rowId(requirement, "req");
      const criteria = stringList(requirement["acceptance_criteria"]);
      const related = stringList(requirement["related_artifact_ids"]);
      const requirementPriority = firstString(requirement, "priority") ?? "UNSET";
      testCases.push({
        id: `uat.${sha256Hex(requirementId).slice(0, 20)}`,
        title: `验收 ${firstString(requirement, "statement") ?? requirementId}`,
        kind: requirement["type"] === "CONTROL" ? "BUSINESS_RULE" : "BUSINESS_SCENARIO",
        priority:
          requirementPriority === "MUST"
            ? "BLOCKING"
            : requirementPriority === "SHOULD"
              ? "HIGH"
              : requirementPriority === "COULD"
                ? "LOW"
                : "NORMAL",
        status: criteria.length > 0 ? "READY_FOR_REVIEW" : "BLOCKED",
        requirement_ids: [requirementId],
        rule_ids: related.filter((id) => ruleIds.has(id)),
        process_step_ids: related.filter((id) => processIds.has(id)),
        integration_contract_ids: contracts
          .filter((row) => stringList(row["requirement_ids"]).includes(requirementId))
          .map((row) => firstString(row, "id"))
          .filter((id): id is string => id !== null),
        preconditions: [],
        given: [{ field: "requirement_id", value: requirementId }],
        when: `执行业务场景：${firstString(requirement, "statement") ?? requirementId}`,
        then: criteria,
        test_data_requirements: [],
        evidence_ids: stringList(requirement["evidence_ids"]),
        automation_candidate: false,
      });
    }
    const covered = new Set(
      testCases.flatMap((row) => stringList(row["requirement_ids"])),
    );
    const requirementIds = mappingRows(get(inputs["REQUIREMENTS"], "requirements"))
      .map((row) => firstString(row, "id"))
      .filter((id): id is string => id !== null);
    const gaps = requirementIds.filter((id) => !covered.has(id));
    const coverageGaps: Dict[] = gaps.map((id) => ({
      id: `uat-gap.${sha256Hex(`missing\u0000${id}`).slice(0, 20)}`,
      type: "MISSING_TEST",
      message: `需求 ${id} 没有验收测试`,
      owner_role: "acceptance_test_engineer",
      blocked_test_case_ids: [],
      related_requirement_ids: [id],
      evidence_ids: [],
    }));
    for (const testCase of testCases.filter((row) => stringList(row["then"]).length === 0)) {
      coverageGaps.push({
        id: `uat-gap.${sha256Hex(`expected\u0000${testCase["id"]}`).slice(0, 20)}`,
        type: "MISSING_EXPECTED_RESULT",
        message: `测试 ${testCase["id"]} 缺少来自需求的可观察预期结果`,
        owner_role: "requirements_engineer",
        blocked_test_case_ids: [testCase["id"]],
        related_requirement_ids: testCase["requirement_ids"],
        evidence_ids: testCase["evidence_ids"],
      });
    }
    return {
      test_cases: testCases,
      traceability: requirementIds.map((id) => ({
        requirement_id: id,
        test_case_ids: testCases
          .filter((row) => stringList(row["requirement_ids"]).includes(id))
          .map((row) => row["id"]),
        coverage: testCases.some(
          (row) =>
            stringList(row["requirement_ids"]).includes(id) && row["status"] !== "BLOCKED",
        )
          ? "COVERED"
          : "BLOCKED",
        evidence_ids:
          mappingRows(get(inputs["REQUIREMENTS"], "requirements")).find(
            (row) => firstString(row, "id") === id,
          )?.["evidence_ids"] ?? [],
      })),
      coverage_gaps: coverageGaps,
      readiness: {
        recommendation:
          coverageGaps.length === 0 ? "READY_FOR_HUMAN_REVIEW" : "NOT_READY",
        blocking_gap_ids: coverageGaps.map((row) => row["id"]),
        rationale:
          requirementIds.length === 0
            ? ["当前范围没有可验收需求，按确定性 N/A 进入人工复核"]
            : coverageGaps.length === 0
              ? [`${requirementIds.length} 条需求均有可观察验收测试`]
              : [`仍有 ${coverageGaps.length} 个阻塞覆盖缺口`],
      },
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const requirementIds = new Set(
      mappingRows(seed["traceability"])
        .map((row) => firstString(row, "requirement_id"))
        .filter((id): id is string => id !== null),
    );
    // Model-authored tests are useful proposals, but accepting them here would
    // let a fabricated happy-path test turn a requirement from BLOCKED to COVERED.
    // The deterministic baseline remains authoritative for the release gate.
    const cases = mappingRows(seed["test_cases"]);
    const covered = new Set(cases.flatMap((row) => stringList(row["requirement_ids"])));
    const gaps: Dict[] = [...requirementIds]
      .filter((id) => !covered.has(id))
      .map((id) => ({
        id: `uat-gap.${sha256Hex(`missing\u0000${id}`).slice(0, 20)}`,
        type: "MISSING_TEST",
        message: `需求 ${id} 没有验收测试`,
        owner_role: "acceptance_test_engineer",
        blocked_test_case_ids: [],
        related_requirement_ids: [id],
        evidence_ids: [],
      }));
    for (const testCase of cases.filter((row) => stringList(row["then"]).length === 0)) {
      gaps.push({
        id: `uat-gap.${sha256Hex(`expected\u0000${testCase["id"]}`).slice(0, 20)}`,
        type: "MISSING_EXPECTED_RESULT",
        message: `测试 ${testCase["id"]} 缺少可观察预期结果`,
        owner_role: "requirements_engineer",
        blocked_test_case_ids: [testCase["id"]],
        related_requirement_ids: stringList(testCase["requirement_ids"]),
        evidence_ids: stringList(testCase["evidence_ids"]),
      });
    }
    return {
      test_cases: cases,
      traceability: [...requirementIds].map((id) => ({
        requirement_id: id,
        test_case_ids: cases
          .filter((row) => stringList(row["requirement_ids"]).includes(id))
          .map((row) => row["id"]),
        coverage: cases.some(
          (row) => stringList(row["requirement_ids"]).includes(id) && row["status"] !== "BLOCKED",
        )
          ? "COVERED"
          : "BLOCKED",
        evidence_ids: unionStrings(
          ...cases
            .filter((row) => stringList(row["requirement_ids"]).includes(id))
            .map((row) => row["evidence_ids"]),
        ),
      })),
      coverage_gaps: gaps,
      readiness: {
        recommendation: gaps.length === 0 ? "READY_FOR_HUMAN_REVIEW" : "NOT_READY",
        blocking_gap_ids: gaps.map((row) => row["id"]),
        rationale:
          requirementIds.size === 0
            ? ["当前范围没有可验收需求，按确定性 N/A 进入人工复核"]
            : gaps.length === 0
              ? [`${requirementIds.size} 条需求均有可观察验收测试`]
              : [`仍有 ${gaps.length} 个阻塞覆盖缺口`],
      },
    };
  }
}

/**
 * Deterministically apply the whitelisted parts of professional analysis to the
 * canonical package.  Generated text never owns canonical IDs or references;
 * adapters resolve them against the package and silently leave an unknown value
 * as a question instead of minting a dangling reference.
 */
export function applyProfessionalAnalysis(
  pkg: Dict,
  inputs: Dict,
  allowedEvidence?: ReadonlySet<string>,
  evidenceRecords: readonly Dict[] = [],
): Dict {
  const processes = mappingRows(pkg["processes"]);
  const packageRules = mappingRows(pkg["rules"]);
  const packageObjects = mappingRows(pkg["dataObjects"]);
  const roles = mappingRows(pkg["roles"]);
  const systems = mappingRows(pkg["systems"]);
  const roleById = new Map(roles.map((row) => [String(row["id"] ?? ""), row]));
  const systemById = new Map(systems.map((row) => [String(row["id"] ?? ""), row]));
  const knownEvidence = new Set<string>(allowedEvidence ?? []);
  collectEvidenceRefs(pkg["evidence"], knownEvidence);
  const verifiedCites = (value: unknown): string[] =>
    stringList(value).filter((ref) => knownEvidence.has(ref));
  const packageEvidence = new PackageEvidenceIndex();
  const evidenceIdByCite = new Map<string, string>();
  const resolvableEvidence = (row: Dict): boolean => {
    const fileId = nonEmptyString(row["fileId"] ?? row["file_id"]);
    const fileName = nonEmptyString(row["fileName"] ?? row["file_name"]);
    const snippet = nonEmptyString(row["snippet"]);
    const locator = row["locator"];
    return (
      fileId !== null &&
      fileName !== null &&
      snippet !== null &&
      isMapping(locator) &&
      Object.keys(locator).length > 0
    );
  };
  for (const row of mappingRows(pkg["evidence"])) {
    const id = nonEmptyString(row["id"]);
    if (id !== null) {
      packageEvidence.items.set(id, row);
      const cite = nonEmptyString(row["cite"]);
      if (cite !== null && resolvableEvidence(row) && !evidenceIdByCite.has(cite)) {
        evidenceIdByCite.set(cite, id);
      }
    }
  }
  const sourceEvidenceByCite = new Map<string, Dict>();
  for (const row of mappingRows(evidenceRecords)) {
    const cite = nonEmptyString(row["cite"]);
    if (cite !== null && !sourceEvidenceByCite.has(cite)) sourceEvidenceByCite.set(cite, row);
  }
  const canonicalEvidence = (value: unknown): string[] => {
    const out: string[] = [];
    for (const ref of verifiedCites(value)) {
      let id = evidenceIdByCite.get(ref) ?? null;
      if (id === null && ref.startsWith("ev.")) {
        const existing = packageEvidence.items.get(ref);
        if (existing !== undefined && resolvableEvidence(existing)) id = ref;
      }
      if (id === null) {
        const source = sourceEvidenceByCite.get(ref);
        // Never manufacture an empty locator/snippet merely because the model
        // emitted a syntactically valid cite.  Reuse package Evidence or import
        // the real EvidenceIndex record; otherwise the semantic delta stays unsupported.
        if (source !== undefined && resolvableEvidence(source)) {
          id = packageEvidence.add(source);
          evidenceIdByCite.set(ref, id);
        }
      }
      if (id !== null && !out.includes(id)) out.push(id);
    }
    return out;
  };
  const evidenceText = (ref: string): string => {
    const source = sourceEvidenceByCite.get(ref);
    if (source !== undefined) {
      return firstString(source, "text", "snippet", "render", "摘录") ?? "";
    }
    const id = evidenceIdByCite.get(ref);
    const packaged = id === undefined ? undefined : packageEvidence.items.get(id);
    return packaged === undefined ? "" : nonEmptyString(packaged["snippet"]) ?? "";
  };
  const evidenceSupporting = (value: unknown, refs: unknown): string[] => {
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => evidenceValueNorm(item))
      .filter((item) => item !== "");
    if (values.length === 0) return [];
    return verifiedCites(refs).filter((ref) => {
      const source = evidenceValueNorm(evidenceText(ref));
      return source !== "" && values.every((item) => source.includes(item));
    });
  };
  const canonicalEvidenceFor = (value: unknown, refs: unknown): string[] =>
    canonicalEvidence(evidenceSupporting(value, refs));
  const collisionSafeId = (
    prefix: string,
    name: string,
    byId: ReadonlyMap<string, Dict>,
  ): string => {
    const base = canonicalId(prefix, name);
    const occupied = byId.get(base);
    if (occupied === undefined || nonEmptyString(occupied["name"]) === name) return base;
    return `${base}.${sha256Hex(name).slice(0, 10)}`;
  };

  const ensureRole = (value: unknown, supported: boolean): string | null => {
    const name = nonEmptyString(value);
    if (name === null || name === "待确认") return null;
    const direct = roleById.get(name);
    if (direct !== undefined) return String(direct["id"]);
    const named = roles.find((row) => nonEmptyString(row["name"]) === name);
    if (named !== undefined) return String(named["id"]);
    if (!supported) return null;
    const id = name.startsWith("role.") ? name : collisionSafeId("role", name, roleById);
    if (!roleById.has(id)) {
      const row = { id, name };
      roles.push(row);
      roleById.set(id, row);
    }
    return id;
  };

  const ensureSystem = (value: unknown, nameValue: unknown, supported: boolean): string | null => {
    const raw = nonEmptyString(value);
    const name = nonEmptyString(nameValue) ?? raw;
    if (raw !== null && systemById.has(raw)) return raw;
    const named = systems.find((row) => {
      const n = nonEmptyString(row["name"]);
      return (raw !== null && n === raw) || (name !== null && n === name);
    });
    if (named !== undefined) return String(named["id"]);
    if (!supported || name === null) return null;
    const id =
      raw !== null && raw.startsWith("sys.")
        ? raw
        : collisionSafeId("sys", name, systemById);
    if (!systemById.has(id)) {
      const row = { id, name };
      systems.push(row);
      systemById.set(id, row);
    }
    return id;
  };

  const process = isMapping(inputs["PROCESS"]) ? inputs["PROCESS"] : {};
  const processSteps = new Map(
    mappingRows(process["steps"])
      .map((row) => [nonEmptyString(row["id"]), row] as const)
      .filter((entry): entry is readonly [string, Dict] => entry[0] !== null),
  );
  for (const processRow of processes) {
    const nodes = mappingRows(processRow["nodes"]);
    for (const node of nodes) {
      const step = processSteps.get(nonEmptyString(node["legacyId"]) ?? "");
      if (step === undefined) continue;
      const claimedEvidence = step["analysis_evidence_ids"];
      const actorEvidence = canonicalEvidenceFor(step["actor_role"], claimedEvidence);
      const triggerEvidence = canonicalEvidenceFor(step["trigger"], claimedEvidence);
      const preconditionEvidence = canonicalEvidenceFor(step["precondition"], claimedEvidence);
      const evidence = unionStrings(actorEvidence, triggerEvidence, preconditionEvidence);
      if (evidence.length === 0) continue;
      const role = ensureRole(step["actor_role"], actorEvidence.length > 0);
      if (role !== null && (node["actorRole"] === null || node["actorRole"] === undefined)) {
        node["actorRole"] = role;
      }
      const trigger = nonEmptyString(step["trigger"]);
      const precondition = nonEmptyString(step["precondition"]);
      if (trigger !== null && triggerEvidence.length > 0) node["trigger"] = trigger;
      if (precondition !== null && preconditionEvidence.length > 0) {
        node["precondition"] = precondition;
      }
      node["analysisEvidenceIds"] = evidence;
    }
    processRow["nodes"] = nodes;
  }

  const erp = isMapping(inputs["ERP_MAP"]) ? inputs["ERP_MAP"] : {};
  const landscape = new Map<string, Dict>();
  for (const row of mappingRows(erp["landscape"])) {
    const id = nonEmptyString(row["system_id"]);
    if (id !== null) landscape.set(id, row);
  }
  const processNodeByLegacy = new Map<string, Dict>();
  for (const processRow of processes) {
    // PROCESS enrichment above has already installed a mutable node array on
    // the package.  Do not pass it through mappingRows() again: that helper
    // deliberately clones rows, so ERP details would be written to detached
    // copies and disappear from the canonical package.
    const nodes = Array.isArray(processRow["nodes"])
      ? (processRow["nodes"] as unknown[]).filter(isMapping)
      : [];
    for (const node of nodes) {
      const legacy = nonEmptyString(node["legacyId"]);
      if (legacy !== null) processNodeByLegacy.set(legacy, node);
    }
  }
  for (const mapping of mappingRows(erp["mappings"])) {
    const claimedEvidence = mapping["analysis_evidence_ids"];
    const kindEvidence = canonicalEvidenceFor(mapping["implementation_kind"], claimedEvidence);
    const targetRefs = stringList(mapping["target_refs"]);
    const targetEvidence = targetRefs.length === 0
      ? kindEvidence
      : canonicalEvidenceFor(targetRefs, claimedEvidence);
    const evidence = unionStrings(kindEvidence, targetEvidence);
    if (kindEvidence.length === 0 || targetEvidence.length === 0) continue;
    const rawSystem = nonEmptyString(mapping["system_id"]);
    const detail = rawSystem !== null ? landscape.get(rawSystem) : undefined;
    const detailClaimed = detail?.["analysis_evidence_ids"];
    const productEvidence = canonicalEvidenceFor(detail?.["product"], detailClaimed);
    const systemId = ensureSystem(
      rawSystem,
      detail?.["product"] ?? rawSystem,
      productEvidence.length > 0,
    );
    const node = processNodeByLegacy.get(nonEmptyString(mapping["process_step_id"]) ?? "");
    if (systemId === null || node === undefined) continue;
    const system = systemById.get(systemId);
    if (
      system !== undefined &&
      detail !== undefined &&
      productEvidence.length > 0
    ) {
      for (const [from, to] of [
        ["product", "product"],
        ["version", "version"],
        ["module", "module"],
        ["org_scope", "orgScope"],
      ] as const) {
        const value = nonEmptyString(detail[from]);
        const fieldEvidence = canonicalEvidenceFor(detail[from], detailClaimed);
        if (value !== null && fieldEvidence.length > 0) system[to] = value;
      }
    }
    const rows = mappingRows(node["erpMappings"]);
    const item: Dict = {
      systemId,
      implementationKind: mapping["implementation_kind"] ?? "UNKNOWN",
      targetRefs,
      confidence: numberInRange(mapping["confidence"], 0, 1, 0.5),
      evidenceIds: evidence,
    };
    const key = `${systemId}\u0000${JSON.stringify(item["targetRefs"])}`;
    if (!rows.some((row) => `${row["systemId"]}\u0000${JSON.stringify(row["targetRefs"] ?? [])}` === key)) {
      rows.push(item);
    }
    node["erpMappings"] = rows;
  }

  const ruleAnalysis = new Map<string, Dict>();
  for (const row of mappingRows(get(inputs["RULES"], "rules"))) {
    const id = nonEmptyString(row["id"]);
    if (id !== null) ruleAnalysis.set(id, row);
  }
  for (const rule of packageRules) {
    const analysis = ruleAnalysis.get(nonEmptyString(rule["legacyId"]) ?? "");
    if (analysis === undefined) continue;
    const claimedEvidence = analysis["analysis_evidence_ids"];
    const conditionEvidence = canonicalEvidenceFor(analysis["condition"], claimedEvidence);
    const effectEvidence = canonicalEvidenceFor(analysis["effect"], claimedEvidence);
    const exceptions = stringList(analysis["exceptions"]);
    const exceptionEvidence = exceptions.length === 0
      ? []
      : canonicalEvidenceFor(exceptions, claimedEvidence);
    const evidence = unionStrings(conditionEvidence, effectEvidence, exceptionEvidence);
    if (evidence.length === 0) continue;
    const condition = nonEmptyString(analysis["condition"]);
    const effect = nonEmptyString(analysis["effect"]);
    if (
      condition !== null &&
      conditionEvidence.length > 0 &&
      condition !== nonEmptyString(rule["rawStatement"])
    ) {
      rule["normalizedExpression"] = condition;
      rule["compileStatus"] = "semantically_analyzed";
    }
    if (effect !== null && effectEvidence.length > 0) {
      rule["outcome"] = {
        ...(isMapping(rule["outcome"]) ? rule["outcome"] : {}),
        semanticEffect: effect,
      };
    }
    if (exceptionEvidence.length > 0) rule["exceptions"] = exceptions;
    // Generated test cases and trigger bindings are proposals, not literal
    // material fields. The dedicated acceptance/decision stages own them.
    rule["analysisEvidenceIds"] = evidence;
  }

  const dataAnalysis = new Map<string, Dict>();
  for (const row of mappingRows(get(inputs["DATA_OBJECTS"], "data_objects"))) {
    const id = nonEmptyString(row["id"]);
    if (id !== null) dataAnalysis.set(id, row);
  }
  const qualityByObject = new Map<string, Dict[]>();
  for (const quality of mappingRows(get(inputs["DATA_OBJECTS"], "quality_rules"))) {
    const target = nonEmptyString(quality["data_object_id"]);
    if (target === null) continue;
    const bucket = qualityByObject.get(target) ?? [];
    bucket.push(quality);
    qualityByObject.set(target, bucket);
  }
  const sensitivity: Readonly<Record<string, string>> = {
    PUBLIC: "public",
    INTERNAL: "internal",
    CONFIDENTIAL: "confidential",
    RESTRICTED: "restricted",
  };
  for (const object of packageObjects) {
    const legacy = nonEmptyString(object["legacyId"]) ?? "";
    const analysis = dataAnalysis.get(legacy);
    if (analysis === undefined) continue;
    const claimedEvidence = analysis["analysis_evidence_ids"];
    const lifecycle = stringList(analysis["lifecycle_states"]);
    const lifecycleEvidence = lifecycle.length === 0
      ? []
      : canonicalEvidenceFor(lifecycle, claimedEvidence);
    const sensitivityEvidence = canonicalEvidenceFor(analysis["sensitivity"], claimedEvidence);
    const systemEvidence = canonicalEvidenceFor(analysis["system_of_record"], claimedEvidence);
    const ownerEvidence = canonicalEvidenceFor(analysis["owner_role"], claimedEvidence);
    const evidence = unionStrings(
      lifecycleEvidence,
      sensitivityEvidence,
      systemEvidence,
      ownerEvidence,
    );
    if (evidence.length === 0) continue;
    if (lifecycleEvidence.length > 0) object["lifecycleStates"] = lifecycle;
    const level = nonEmptyString(analysis["sensitivity"])?.toUpperCase() ?? "UNKNOWN";
    if (
      sensitivityEvidence.length > 0 &&
      level !== "UNKNOWN" &&
      sensitivity[level] !== undefined
    ) {
      object["sensitivity"] = sensitivity[level];
    }
    const systemId = ensureSystem(
      analysis["system_of_record"],
      analysis["system_of_record"],
      systemEvidence.length > 0,
    );
    if (systemId !== null && systemEvidence.length > 0) object["systemOfRecord"] = systemId;
    const roleId = ensureRole(analysis["owner_role"], ownerEvidence.length > 0);
    if (roleId !== null) object["ownerRole"] = roleId;
    const quality = (qualityByObject.get(legacy) ?? [])
      .map((row) => {
        const refs = row["analysis_evidence_ids"];
        const expressionEvidence = canonicalEvidenceFor(row["expression"], refs);
        const dimensionEvidence = canonicalEvidenceFor(row["dimension"], refs);
        const thresholdEvidence = row["threshold"] === null || row["threshold"] === undefined
          ? expressionEvidence
          : canonicalEvidenceFor(row["threshold"], refs);
        return {
          ...row,
          evidenceIds: unionStrings(expressionEvidence, dimensionEvidence, thresholdEvidence),
          evidence_supported:
            expressionEvidence.length > 0 &&
            dimensionEvidence.length > 0 &&
            thresholdEvidence.length > 0,
        };
      })
      .filter((row) => row["evidence_supported"] === true)
      .map(({ evidence_supported: _supported, ...row }) => row);
    if (quality.length > 0) object["qualityRules"] = quality;
    object["analysisEvidenceIds"] = evidence;
  }

  pkg["processes"] = processes;
  pkg["rules"] = packageRules;
  pkg["dataObjects"] = packageObjects;
  pkg["roles"] = roles;
  pkg["systems"] = systems;
  pkg["evidence"] = [...packageEvidence.items.values()];
  return pkg;
}

export class CanonicalizeHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "构建并验证 OntologyPackage v1。";
  }

  override async execute(inputs: Dict, ctx: RunContext): Promise<Dict> {
    const current = Math.trunc(this.runtime.artifactRevision);
    const skipped = [...this.runtime.skippedReviews, ...humanReviewGap(this.runtime)];
    const pkg = buildPackage(
      this.runtime.oir as Dict,
      (this.runtime.flow ?? null) as Dict | null,
      {
        packageId: `pkg.${this.runtime.sessionId}`,
        revision: current + 1,
        baseRevision: current || null,
        generatedAt: this.runtime.generatedAt,
        decisions: this.runtime.businessDecisionRows(),
        backlog: this.runtime.questionBacklog(),
        // 降级过、或者根本没人拍过板，都让产物自己说出来。
        skippedReviews: skipped,
      },
    );
    // 复验一遍拿 findings 做失败文案。**必须把 skippedReviews 一起带上** ——
    // 下面 `data["validation"] = report.toDict()` 会整个覆盖 buildPackage 装好的
    // 那份，漏传这里等于把标记又冲掉，而且冲得悄无声息。
    const report = validatePackage(pkg, skipped);
    if (!report.passed) {
      const summary = report.findings
        .filter((f) => f.severity === "error")
        .map((f) => `${f.code}@${f.path}: ${f.message}`)
        .join("; ");
      throw new NodeFailure(ctx.nodeId, `OntologyPackage v1 校验失败：${summary}`, false);
    }
    const data = applyProfessionalAnalysis(
      pkg.toDict(),
      inputs,
      this.runtime.evidenceRefs,
      this.runtime.evidenceRecords,
    );
    const enrichedReport = validatePackage(data, skipped);
    if (!enrichedReport.passed) {
      const summary = enrichedReport.findings
        .filter((f) => f.severity === "error")
        .map((f) => `${f.code}@${f.path}: ${f.message}`)
        .join("; ");
      throw new NodeFailure(ctx.nodeId, `专业分析合并后 OntologyPackage v1 校验失败：${summary}`, false);
    }
    data["validation"] = enrichedReport.toDict();
    return await Promise.resolve(data);
  }
}

export class ReviewHandler extends ProfessionalProjection {
  constructor(runtime: EngagementRuntimeInput, opts: EngagementHandlerOptions = {}) {
    super(runtime, "delivery_reviewer", opts);
  }

  project(inputs: Dict): Dict {
    const pkg: Dict = (truthy(inputs["CANONICALIZE"]) ? inputs["CANONICALIZE"] : {}) as Dict;
    const report = validatePackage(pkg);
    const blockers: Dict[] = report.findings
      .filter((f) => f.severity === "error")
      .map((f) => ({
        code: f.code,
        message: f.message,
        owner_role: "delivery_reviewer",
        artifact_ids: ["ontology.package.json"],
      }));
    const blockersOpen = this.runtime.blockers();
    if (blockersOpen.length > 0) {
      blockers.push({
        code: "OPEN_BLOCKING_QUESTIONS",
        message: `仍有 ${blockersOpen.length} 个阻塞问题未处理`,
        owner_role: "fde_interviewer",
        artifact_ids: ["questions.json"],
      });
    }
    if (!this.runtime.releaseDownloadable) {
      blockers.push({
        code: "ARTIFACT_TARGET_UNAVAILABLE",
        message: "交付目录当前不可写，无法生成可下载产物",
        owner_role: "delivery_reviewer",
        artifact_ids: [...EXPECTED_ARTIFACTS],
      });
    }
    const decisionApplication = isMapping(inputs["DECISION_APPLY"])
      ? inputs["DECISION_APPLY"]
      : {};
    if (
      decisionApplication["safe_to_continue"] !== true ||
      Number(decisionApplication["mutation_count"] ?? -1) !== 0 ||
      Number(decisionApplication["claimed_applied_count"] ?? -1) !== 0
    ) {
      blockers.push({
        code: "DECISION_APPLICATION_UNSAFE",
        message: "决定应用校验未证明为零写入，或存在 agent 自报已应用的变更",
        owner_role: "decision_integrator",
        artifact_ids: ["decision-application.json"],
      });
    }
    const coverageGaps = mappingRows(get(inputs["TEST_PLAN"], "coverage_gaps"));
    if (coverageGaps.length > 0) {
      blockers.push({
        code: "ACCEPTANCE_COVERAGE_GAP",
        message: `${coverageGaps.length} 条需求没有验收测试追溯`,
        owner_role: "acceptance_test_engineer",
        artifact_ids: ["requirements.json", "acceptance-test-plan.json"],
      });
    }
    const [checked, ungrounded] = traceability(pkg);
    const grounding = materialGroundingReport(
      pkg,
      this.runtime.evidenceRecords,
      this.runtime.materialEvidenceRequired,
    );
    if (!grounding.passed) {
      blockers.push({
        code: "MATERIAL_GROUNDING_FAILED",
        message: `${grounding.issues.length} 条材料事实没有可核验的原文支持`,
        owner_role: "delivery_reviewer",
        artifact_ids: ["ontology.package.json"],
      });
    }
    const valid = report.passed;
    const artifactChecks = EXPECTED_ARTIFACTS.map((artifact) => ({
      artifact_id: artifact,
      schema_valid: valid,
      downloadable: Boolean(this.runtime.releaseDownloadable),
    }));
    const unresolvedQuestions = this.runtime.pending();
    const releaseState = "DRAFT";
    const warnings =
      unresolvedQuestions.length > 0
        ? [`${unresolvedQuestions.length} 个非阻塞问题尚待澄清，交付件标记为 DRAFT`]
        : [];
    warnings.push("正式发布仍需 HUMAN_ACCEPTANCE 对精确 package revision 签字");
    const outstandingDecisionChanges =
      Number(decisionApplication["validated_count"] ?? 0) +
      Number(decisionApplication["unapplied_count"] ?? 0);
    const unresolvedDecisionProposals = mappingRows(
      get(inputs["DECISION_PROPOSAL"], "unresolved_items"),
    ).length;
    if (outstandingDecisionChanges > 0) {
      warnings.push(
        `${outstandingDecisionChanges} 条决定变更尚未提交到业务模型；` +
        "VALIDATED_NOT_APPLIED 只表示候选 patch 通过静态校验，不表示已生效",
      );
    }
    if (unresolvedDecisionProposals > 0) {
      warnings.push(
        `${unresolvedDecisionProposals} 条 decision proposal unresolved item 保留在候选交付中`,
      );
    }
    if (ungrounded.length > 0) {
      warnings.push(`${ungrounded.length} 条推断断言没有材料证据`);
    }
    return {
      verdict: blockers.length === 0 ? "PASS" : "BLOCKED",
      blockers,
      warnings,
      releaseState,
      traceability: { checked, unresolved: ungrounded.slice(0, 100) },
      grounding,
      artifact_checks: artifactChecks,
      blocker_count: blockers.length,
      schema_valid: valid,
    };
  }

  protected override analysisSeed(inputs: Dict): Dict {
    return {
      deterministic_review: this.project(inputs),
      professional_outputs: Object.fromEntries(
        [
          "INTAKE",
          "PROCESS",
          "ERP_MAP",
          "RULES",
          "DATA_OBJECTS",
          "GAP",
          "DECISION_PROPOSAL",
          "DECISION_APPLY",
          "REQUIREMENTS",
          "ARCHITECTURE",
          "TEST_PLAN",
        ]
          .filter((key) => isMapping(inputs[key]))
          .map((key) => [key, inputs[key]]),
      ),
      canonical_validation: get(inputs["CANONICALIZE"], "validation") ?? {},
    };
  }

  protected mergeDraft(seed: Dict, draft: Dict, _inputs: Dict): Dict {
    const blockerKey = (row: Dict): string =>
      `${nonEmptyString(row["code"]) ?? ""}\u0000${nonEmptyString(row["message"]) ?? ""}`;
    const blockers = new Map<string, Dict>();
    for (const row of mappingRows(seed["blockers"])) blockers.set(blockerKey(row), row);
    for (const row of mappingRows(draft["blockers"])) {
      const code = nonEmptyString(row["code"]);
      const message = nonEmptyString(row["message"]);
      if (code === null || message === null) continue;
      const artifacts = stringList(row["artifact_ids"]).filter((id) =>
        EXPECTED_ARTIFACTS.includes(id),
      );
      const safe: Dict = {
        code,
        message,
        owner_role: nonEmptyString(row["owner_role"]) ?? "delivery_reviewer",
        artifact_ids: artifacts.length > 0 ? artifacts : ["ontology.package.json"],
      };
      blockers.set(blockerKey(safe), safe);
    }

    const unresolved = unionStrings(
      get(seed["traceability"], "unresolved"),
      get(draft["traceability"], "unresolved"),
    ).slice(0, 100);
    const rows = [...blockers.values()];
    return {
      ...seed,
      // Gate-critical measurements remain deterministic and fail closed.
      verdict: rows.length === 0 ? "PASS" : "BLOCKED",
      blockers: rows,
      warnings: unionStrings(seed["warnings"], draft["warnings"]),
      traceability: {
        checked: Number(get(seed["traceability"], "checked") ?? 0),
        unresolved,
      },
      grounding: seed["grounding"],
      artifact_checks: seed["artifact_checks"],
      blocker_count: rows.length,
      schema_valid: seed["schema_valid"],
      releaseState: seed["releaseState"],
    };
  }
}

function humanAcceptanceQuestionPrefix(sessionId: string): string {
  return `q.acceptance.${sha256Hex(sessionId).slice(0, 12)}.`;
}

/** Stable DecisionLedger question bound to one exact release-candidate digest. */
export function humanAcceptanceQuestionId(
  sessionId: string,
  binding: { readonly packageDigest: string; readonly reviewDigest: string; readonly revision: number },
): string {
  const digest = sha256Hex(
    `${binding.packageDigest}\u0000${binding.reviewDigest}\u0000${binding.revision}`,
  ).slice(0, 20);
  return `${humanAcceptanceQuestionPrefix(sessionId)}${digest}`;
}

interface ReleaseBinding {
  readonly packageId: string;
  readonly revision: number;
  readonly packageDigest: string;
  readonly reviewDigest: string;
  readonly reviewPassed: boolean;
}

function releaseBinding(inputs: Dict): ReleaseBinding {
  const pkg = isMapping(inputs["CANONICALIZE"]) ? inputs["CANONICALIZE"] : {};
  const review = isMapping(inputs["REVIEW"]) ? inputs["REVIEW"] : {};
  const packageId = firstString(pkg, "packageId") ?? "";
  const revision = Number(pkg["revision"] ?? 0);
  const reviewPassed =
    review["verdict"] === "PASS" && Number(review["blocker_count"] ?? -1) === 0;
  // "package_digest" is the release-candidate digest for compatibility: it binds
  // not only OntologyPackage, but every v3 delivery artifact reviewed and signed.
  const packageDigest = sha256Hex(JSON.stringify({
    CANONICALIZE: pkg,
    DECISION_PROPOSAL: inputs["DECISION_PROPOSAL"] ?? null,
    DECISION_APPLY: inputs["DECISION_APPLY"] ?? null,
    REQUIREMENTS: inputs["REQUIREMENTS"] ?? null,
    ARCHITECTURE: inputs["ARCHITECTURE"] ?? null,
    TEST_PLAN: inputs["TEST_PLAN"] ?? null,
    REVIEW: review,
  }));
  const reviewDigest = sha256Hex(JSON.stringify({
    packageId,
    revision,
    verdict: review["verdict"] ?? null,
    blocker_count: review["blocker_count"] ?? null,
    schema_valid: review["schema_valid"] ?? null,
    artifact_checks: review["artifact_checks"] ?? null,
    warnings: review["warnings"] ?? null,
    decision_application: inputs["DECISION_APPLY"] ?? null,
  }));
  return { packageId, revision, packageDigest, reviewDigest, reviewPassed };
}

/**
 * Mandatory formal sign-off.  Absence of blockers never synthesizes approval:
 * without an exact DecisionLedger record (or a Recorder HITL answer), skipModel
 * returns null and Scheduler suspends at HUMAN_ACCEPTANCE.
 */
export class HumanAcceptanceHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;
  /**
   * AgentLoop always calls finalize after skipModel.  Keep the originating
   * ledger row in an unforgeable, handler-local side channel so finalize can
   * distinguish that path from model/HITL input without trusting a JSON flag.
   */
  private readonly durableSources = new WeakMap<object, Dict>();

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "等待有权限的验收人对已通过 REVIEW 的精确 package revision 正式签字。";
  }

  override skipModel(inputs: Dict): unknown {
    const durable = this.durableDecision(inputs);
    if (durable === null) return null;
    const normalized = this.normalise(durable, inputs, true);
    this.durableSources.set(normalized, durable);
    return normalized;
  }

  override humanRequest(_draft: unknown, inputs: Dict): Dict {
    const binding = releaseBinding(inputs);
    const questionId = humanAcceptanceQuestionId(this.runtime.sessionId, binding);
    const decisionApplication = isMapping(inputs["DECISION_APPLY"])
      ? inputs["DECISION_APPLY"]
      : {};
    const outstandingDecisionChanges =
      Number(decisionApplication["validated_count"] ?? 0) +
      Number(decisionApplication["unapplied_count"] ?? 0);
    const unresolvedDecisionProposals = mappingRows(
      get(inputs["DECISION_PROPOSAL"], "unresolved_items"),
    ).length;
    const generatedAtMs = Date.parse(this.runtime.generatedAt);
    const questionTime = Number.isFinite(generatedAtMs) ? generatedAtMs / 1000 : 1;
    return {
      contract: "HumanAcceptanceRequest.v1",
      question: {
        $schema: "ontocopilot.question/1",
        schemaVersion: "1.0.0",
        id: questionId,
        text: "是否正式验收并发布当前交付候选？",
        status: "open",
        ownerUserId: "",
        audienceRole: "业务验收负责人",
        answerSchema: { type: "string", enum: ["APPROVE", "REJECT"] },
        priority: "blocking",
        dependencies: [],
        blockedArtifacts: [...EXPECTED_ARTIFACTS],
        sourceKind: "release_acceptance",
        sourceRef: questionId,
        why: "REVIEW 已通过；仍须由有权验收人对精确 release candidate 正式签字",
        options: [
          { id: "APPROVE", label: "验收并发布" },
          { id: "REJECT", label: "拒绝发布" },
        ],
        evidenceIds: [],
        scopeRefs: [binding.packageId],
        group: "正式验收",
        code: "HUMAN_RELEASE_ACCEPTANCE",
        informationGain: 1,
        blastRadius: EXPECTED_ARTIFACTS.length,
        createdAt: questionTime,
        updatedAt: questionTime,
        version: 0,
        metadata: {
          package_id: binding.packageId,
          revision: binding.revision,
          package_digest: binding.packageDigest,
          review_digest: binding.reviewDigest,
          outstanding_decision_changes: outstandingDecisionChanges,
          unresolved_decision_proposals: unresolvedDecisionProposals,
          decision_application_status: decisionApplication["status"] ?? "UNKNOWN",
          warning:
            outstandingDecisionChanges > 0
              ? `${outstandingDecisionChanges} 条决定变更尚未提交到业务模型；签字接受的是当前候选包，不代表这些变更已生效`
              : "无待提交决定变更",
        },
      },
      binding: {
        package_id: binding.packageId,
        revision: binding.revision,
        package_digest: binding.packageDigest,
        review_digest: binding.reviewDigest,
      },
      review_passed: binding.reviewPassed,
      outstanding_decision_changes: outstandingDecisionChanges,
      unresolved_decision_proposals: unresolvedDecisionProposals,
      action: "record_human_acceptance",
      durable_store: "DecisionLedger",
    };
  }

  override finalize(draft: unknown, inputs: Dict): Dict {
    // HITL drafts are not durable signatures.  A formal acceptance becomes
    // authoritative only after question.answer has written it to DecisionLedger
    // and a resumed run finds the exact release-bound question id there.
    const source = isMapping(draft) ? draft : {};
    const durable = this.durableSources.get(source);
    return this.normalise(durable ?? source, inputs, durable !== undefined);
  }

  private durableDecision(inputs: Dict): Dict | null {
    const expectedQuestionId = humanAcceptanceQuestionId(
      this.runtime.sessionId,
      releaseBinding(inputs),
    );
    const rows = this.runtime.decisionRows();
    const superseded = new Set(
      rows.map((row) => firstString(row, "supersedes")).filter((id): id is string => id !== null),
    );
    const active = rows.filter(
      (row) => decisionQuestionId(row) === expectedQuestionId &&
        decisionId(row) !== null &&
        !superseded.has(decisionId(row) as string),
    );
    return active.at(-1) ?? null;
  }

  private normalise(source: Dict, inputs: Dict, fromLedger: boolean): Dict {
    const binding = releaseBinding(inputs);
    const expectedQuestionId = humanAcceptanceQuestionId(this.runtime.sessionId, binding);
    const answer = isMapping(source["answer"]) ? source["answer"] : source;
    const rawDecision =
      firstString(answer, "decision", "status") ??
      (typeof source["answer"] === "string" ? nonEmptyString(source["answer"]) : null) ??
      firstString(source, "decision", "status");
    const decision = rawDecision?.toUpperCase() ?? "MISSING";
    const actor = firstString(answer, "actor") ?? firstString(source, "actor") ?? "";
    const actorRole =
      firstString(answer, "actor_role", "actorRole") ??
      firstString(source, "actorRole", "actor_role") ??
      "";
    const authority = firstString(answer, "authority") ?? firstString(source, "authority") ?? "";
    const signedAtValue =
      answer["signed_at"] ?? answer["signedAt"] ?? source["createdAt"] ?? source["signed_at"];
    const signedAt = nonEmptyString(signedAtValue) ?? "";
    const sourceQuestionId = decisionQuestionId(source);
    const packageBound = fromLedger && sourceQuestionId === expectedQuestionId;
    const decisionApplication = isMapping(inputs["DECISION_APPLY"])
      ? inputs["DECISION_APPLY"]
      : {};
    const outstandingDecisionChanges =
      Number(decisionApplication["validated_count"] ?? 0) +
      Number(decisionApplication["unapplied_count"] ?? 0);
    const unresolvedDecisionProposals = mappingRows(
      get(inputs["DECISION_PROPOSAL"], "unresolved_items"),
    ).length;
    const signed =
      fromLedger &&
      (decision === "APPROVE" || decision === "REJECT") &&
      actor !== "" &&
      actorRole !== "" &&
      isReleaseAcceptanceAuthority(authority) &&
      signedAt !== "";
    return {
      contract: "HumanAcceptance.v1",
      question_id: expectedQuestionId,
      decision_id: fromLedger ? decisionId(source) : firstString(source, "decision_id", "decisionId"),
      decision,
      signed,
      actor,
      actor_role: actorRole,
      authority,
      signed_at: signedAt,
      rationale:
        firstString(answer, "rationale") ?? firstString(source, "rationale", "note") ?? "",
      package_id: binding.packageId,
      revision: binding.revision,
      package_digest: binding.packageDigest,
      review_digest: binding.reviewDigest,
      package_bound: packageBound,
      review_passed: binding.reviewPassed,
      decision_recorded: signed && packageBound && binding.reviewPassed,
      outstanding_decision_changes: outstandingDecisionChanges,
      unresolved_decision_proposals: unresolvedDecisionProposals,
      decision_application_acknowledgement:
        outstandingDecisionChanges > 0
          ? "签字接受当前候选包；不把 VALIDATED_NOT_APPLIED 或未路由决定描述为已生效"
          : "当前没有待提交决定变更",
      releaseState:
        signed && decision === "APPROVE" && packageBound && binding.reviewPassed
          ? "RELEASED"
          : "DRAFT",
    };
  }
}

export class ExportHandler extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput) {
    super();
    this.runtime = runtime;
  }

  override task(_inputs: Dict): string {
    return "形成通过门禁后的交付提交计划；实际写盘由服务提交边界执行。";
  }

  override execute(inputs: Dict, _ctx: RunContext): Promise<Dict> {
    const review: Dict = (truthy(inputs["REVIEW"]) ? inputs["REVIEW"] : {}) as Dict;
    const pkg: Dict = (truthy(inputs["CANONICALIZE"]) ? inputs["CANONICALIZE"] : {}) as Dict;
    const acceptance: Dict = (truthy(inputs["HUMAN_ACCEPTANCE"])
      ? inputs["HUMAN_ACCEPTANCE"]
      : {}) as Dict;
    const report = validatePackage(pkg);
    // EXPORT 独立复算，不能只相信上游 REVIEW JSON。这样即使旧会话或外部调用
    // 塞入了一个伪造的 PASS，也不能把无材料依据的事实发布出去。
    const grounding = materialGroundingReport(
      pkg,
      this.runtime.evidenceRecords,
      this.runtime.materialEvidenceRequired,
    );
    const artifactChecks = iterOf(review["artifact_checks"]);
    const downloadable =
      artifactChecks.length > 0 && artifactChecks.every((item) => truthy(get(item, "downloadable")));
    return Promise.resolve({
      review_passed: review["verdict"] === "PASS" && grounding.passed,
      human_decided:
        acceptance["decision_recorded"] === true &&
        acceptance["package_bound"] === true &&
        acceptance["review_passed"] === true,
      human_accepted:
        acceptance["signed"] === true &&
        acceptance["decision"] === "APPROVE" &&
        acceptance["package_bound"] === true &&
        acceptance["review_passed"] === true,
      schema_valid: report.passed && truthy(review["schema_valid"]),
      grounding_passed: grounding.passed,
      grounding,
      downloadable,
      releaseState:
        acceptance["releaseState"] === "RELEASED" && grounding.passed ? "RELEASED" : "DRAFT",
      warnings: [...iterOf(review["warnings"])],
      formats: ["json", "xlsx", "md", "mermaid"],
      artifacts: artifactChecks.map((item) => get(item, "artifact_id") ?? null),
      acceptance,
      decision_proposal: inputs["DECISION_PROPOSAL"] ?? {},
      decision_application: inputs["DECISION_APPLY"] ?? {},
      requirements: inputs["REQUIREMENTS"] ?? {},
      architecture: inputs["ARCHITECTURE"] ?? {},
      acceptance_test_plan: inputs["TEST_PLAN"] ?? {},
      // Server commits this exact validated payload only after Scheduler has
      // applied the EXPORT gate.
      package: pkg,
    });
  }
}

/** `d[k]` —— 缺键炸，不静默给 undefined。 */
function mustGet(d: unknown, k: string): unknown {
  if (!isMapping(d) || !(k in d)) throw new Error(`KeyError: ${JSON.stringify(k)}`);
  return d[k];
}

// ══════════════════════════════════════════════════════════════════
//  Critics
// ══════════════════════════════════════════════════════════════════
const NODE_TO_AGENT: Readonly<Record<string, string>> = {
  INTAKE: "fde_interviewer",
  PROCESS: "process_modeler",
  ERP_MAP: "erp_mapper",
  RULES: "rule_engineer",
  DATA_OBJECTS: "data_steward",
  DECISION_PROPOSAL: "decision_integrator",
  REQUIREMENTS: "requirements_engineer",
  ARCHITECTURE: "solution_architect",
  TEST_PLAN: "acceptance_test_engineer",
  REVIEW: "delivery_reviewer",
};

/** Cheap output-contract critic for deterministic engagement projections. */
export class ContractCritic extends Critic {
  override name = "schema";
  override readonly needsLlm = false;

  judge(draft: unknown, ctx: CriticContext): Promise<Verdict> {
    const findings: Finding[] = [];
    if (!isMapping(draft)) {
      findings.push(
        makeFinding({
          severity: Severity.HIGH,
          code: "OUTPUT_NOT_OBJECT",
          target: ctx.nodeId,
          claim: "节点没有返回 JSON object",
          verifier: "rule:engagement-contract",
        }),
      );
    } else {
      const agentName = Object.prototype.hasOwnProperty.call(NODE_TO_AGENT, ctx.nodeId)
        ? NODE_TO_AGENT[ctx.nodeId]
        : undefined;
      if (agentName !== undefined) {
        const schema = defaultAgents().get(agentName).outputSchema ?? {};
        const missing = iterOf(get(schema, "required"))
          .map((k) => pyStr(k))
          .filter((k) => !(k in draft));
        if (missing.length > 0) {
          findings.push(
            makeFinding({
              severity: Severity.HIGH,
              code: "OUTPUT_REQUIRED_MISSING",
              target: ctx.nodeId,
              claim: `输出缺少必填字段：${missing.join(", ")}`,
              verifier: "rule:engagement-contract",
            }),
          );
        }
        try {
          validateAnswerAgainst(draft, schema, "$output");
        } catch (exc) {
          findings.push(
            makeFinding({
              severity: Severity.HIGH,
              code: "OUTPUT_SCHEMA_INVALID",
              target: ctx.nodeId,
              claim: errorLabel(exc),
              verifier: "rule:engagement-recursive-schema",
            }),
          );
        }
      }
    }
    return Promise.resolve(
      makeVerdict({
        lens: this.name,
        passed: !findings.some((f) => f.severity === Severity.HIGH),
        findings,
        note: "确定性输出契约检查",
      }),
    );
  }
}

/** Surface explicitly labelled inferences; they are not material facts. */
export class EngagementProvenanceCritic extends Critic {
  override name = "provenance";
  override readonly needsLlm = false;

  judge(draft: unknown, ctx: CriticContext): Promise<Verdict> {
    const findings: Finding[] = [];
    if (ctx.nodeId === "REVIEW" && isMapping(draft)) {
      const trace = truthy(draft["traceability"]) ? draft["traceability"] : {};
      const unresolvedRaw = get(trace, "unresolved");
      const unresolved = iterOf(truthy(unresolvedRaw) ? unresolvedRaw : []);
      if (unresolved.length > 0) {
        findings.push(
          makeFinding({
            severity: Severity.MEDIUM,
            code: "INFERRED_WITHOUT_EVIDENCE",
            target: "OntologyPackage.v1",
            claim: `${unresolved.length} 条推断断言没有材料证据，已明确标为推测`,
            evidenceChecked: unresolved.slice(0, 10).map((item) => pyStr(item)),
            verifier: "rule:canonical-traceability",
          }),
        );
      }
    }
    return Promise.resolve(
      makeVerdict({ lens: this.name, passed: true, findings, note: "确定性溯源检查" }),
    );
  }
}

// ══════════════════════════════════════════════════════════════════
//  注册表
// ══════════════════════════════════════════════════════════════════
/** Build the exact handler registry referenced by `buildFdeEngagementDag`. */
export function engagementHandlers(
  runtime: EngagementRuntimeInput,
  opts: EngagementHandlerOptions = {},
): Record<string, NodeHandler> {
  return {
    "agent.fde_interviewer": new IntakeHandler(runtime, opts),
    "agent.process_modeler": new ProcessHandler(runtime, opts),
    "agent.erp_mapper": new ERPMapHandler(runtime, opts),
    "agent.rule_engineer": new RulesHandler(runtime, opts),
    "agent.data_steward": new DataObjectsHandler(runtime, opts),
    "engagement.collect_gaps": new GapHandler(runtime),
    "engagement.interview": new InterviewHandler(runtime),
    "agent.decision_integrator": new DecisionProposalHandler(runtime, opts),
    "engagement.validate_decision_application": new DecisionApplicationHandler(runtime),
    "agent.requirements_engineer": new RequirementsHandler(runtime, opts),
    "agent.solution_architect": new ArchitectureHandler(runtime, opts),
    "agent.acceptance_test_engineer": new AcceptanceTestHandler(runtime, opts),
    "engagement.canonicalize": new CanonicalizeHandler(runtime),
    "agent.delivery_reviewer": new ReviewHandler(runtime, opts),
    "engagement.human_acceptance": new HumanAcceptanceHandler(runtime),
    "engagement.export": new ExportHandler(runtime),
  };
}

export function engagementCritics(): Record<string, Critic> {
  return { schema: new ContractCritic(), provenance: new EngagementProvenanceCritic() };
}

// ══════════════════════════════════════════════════════════════════
//  纯函数
// ══════════════════════════════════════════════════════════════════
export function edgeKind(value: unknown): string {
  const raw = pyStr(truthy(value) ? value : "").toLowerCase();
  if (raw.includes("exception") || raw.includes("异常")) return "EXCEPTION";
  if (raw.includes("timeout") || raw.includes("超时")) return "TIMEOUT";
  if (raw.includes("cancel") || raw.includes("取消")) return "CANCEL";
  if (raw.includes("condition") || raw.includes("gateway") || raw.includes("条件")) {
    return "CONDITIONAL";
  }
  return "SEQUENCE";
}

export function classification(name: string): string {
  const lowered = name.toLowerCase();
  if (["主数据", "供应商", "物料", "master"].some((w) => lowered.includes(w))) {
    return "MASTER_DATA";
  }
  if (["文档", "附件", "document"].some((w) => lowered.includes(w))) return "DOCUMENT";
  if (["交易", "订单", "申请", "transaction", "order"].some((w) => lowered.includes(w))) {
    return "TRANSACTION";
  }
  return "BUSINESS_OBJECT";
}

export function oirStats(oir: Dict): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["objects", "properties", "links", "actions", "rules", "questions"]) {
    out[key] = pyLen(oir[key]);
  }
  return out;
}

export interface MaterialGroundingIssue {
  readonly code:
    | "MATERIAL_EVIDENCE_MISSING"
    | "MATERIAL_EVIDENCE_UNRESOLVED"
    | "MATERIAL_EVIDENCE_NOT_SUPPORTING_CLAIM";
  readonly path: string;
  readonly evidenceIds: readonly string[];
  readonly claim: string;
}

export interface MaterialGroundingReport {
  /** 没有实际 EvidenceIndex 记录时保持兼容；一旦有材料就强制 fail closed。 */
  readonly enforced: boolean;
  readonly passed: boolean;
  readonly checked: number;
  readonly issues: readonly MaterialGroundingIssue[];
}

function materialSourceText(row: Dict): string {
  return firstString(row, "text", "snippet", "render", "摘录") ?? "";
}

function materialLocatorKey(row: Dict): string {
  const fileId = firstString(row, "fileId", "file_id") ?? "";
  const fileName = firstString(row, "fileName", "file_name") ?? "";
  const locator = isMapping(row["locator"]) ? row["locator"] : {};
  if (!fileId && !fileName && Object.keys(locator).length === 0) return "";
  return canonicalJson({ fileId, fileName, locator });
}

function materialClaimLabels(row: Dict): string[] {
  const out: string[] = [];
  // 这些都是 canonical 记录中面向业务的“主张本体”。只需一项在原文出现即可；
  // id/kind/status 等派生字段不拿来做语义匹配，避免把确定性归一化误判成幻觉。
  for (const key of ["displayName", "name", "statement", "text", "apiName"] as const) {
    const raw = firstString(row, key);
    if (raw === null) continue;
    const label = evidenceValueNorm(raw);
    const hasHan = [...label].some((char) => /\p{Script=Han}/u.test(char));
    if (label.length < (hasHan ? 2 : 4) || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

function materialLabelSupported(body: string, label: string): boolean {
  if (body.includes(label)) return true;
  // 中文动作名常由材料中的主宾语做确定性语序归一：
  // “采购申请由申请人提交” → “提交采购申请”。它不是新增事实。允许字符顺序
  // 变化，但要求至少 4 个不同汉字且 80% 以上都在原文出现；英文/数字仍须逐字。
  const labelHan = [...new Set([...label].filter((char) => /\p{Script=Han}/u.test(char)))];
  if (labelHan.length < 4) return false;
  const bodyHan = new Set([...body].filter((char) => /\p{Script=Han}/u.test(char)));
  const overlap = labelHan.filter((char) => bodyHan.has(char)).length;
  return overlap / labelHan.length >= 0.8;
}

/**
 * 发布前的确定性材料事实门禁。
 *
 * `EXTRACTED` 不是“模型觉得像”，而是“材料明确写了”。因此它必须同时满足：
 * 1) assertion 指向包内真实 Evidence；2) 该 Evidence 能反查到本轮 EvidenceIndex
 * 原文；3) 原文提到了这条 canonical 记录的业务名称/陈述。任何一层失败都阻止
 * REVIEW 和 EXPORT。`INFERRED` 可以保留，但必须继续以推测状态展示。
 */
export function materialGroundingReport(
  pkg: Dict,
  evidenceRecords: readonly Dict[] = [],
  evidenceRequired = false,
): MaterialGroundingReport {
  const sources = mappingRows(evidenceRecords).filter((row) => materialSourceText(row) !== "");
  if (sources.length === 0) {
    if (!evidenceRequired) return { enforced: false, passed: true, checked: 0, issues: [] };
    return {
      enforced: true,
      passed: false,
      checked: 0,
      issues: [{
        code: "MATERIAL_EVIDENCE_MISSING",
        path: "/",
        evidenceIds: [],
        claim: "已上传材料，但没有读到可核验的原文切片",
      }],
    };
  }

  const sourceByCite = new Map<string, string[]>();
  const sourceByLocator = new Map<string, string[]>();
  for (const source of sources) {
    const text = materialSourceText(source);
    const cite = firstString(source, "cite", "出处");
    if (cite !== null) sourceByCite.set(cite, [...(sourceByCite.get(cite) ?? []), text]);
    const locator = materialLocatorKey(source);
    if (locator !== "") {
      sourceByLocator.set(locator, [...(sourceByLocator.get(locator) ?? []), text]);
    }
  }

  const evidenceById = new Map(
    mappingRows(pkg["evidence"])
      .map((row) => [firstString(row, "id"), row] as const)
      .filter((entry): entry is readonly [string, Dict] => entry[0] !== null),
  );
  const sourceForEvidence = (evidence: Dict): string[] => {
    const cite = firstString(evidence, "cite");
    if (cite !== null && sourceByCite.has(cite)) return sourceByCite.get(cite)!;
    const locator = materialLocatorKey(evidence);
    if (locator !== "" && sourceByLocator.has(locator)) return sourceByLocator.get(locator)!;
    return [];
  };

  let checked = 0;
  const issues: MaterialGroundingIssue[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}/${index}`));
      return;
    }
    if (!isMapping(value)) return;

    const assertion = value["assertion"];
    if (
      isMapping(assertion) &&
      pyStr(assertion["origin"] ?? "").toUpperCase() === "EXTRACTED"
    ) {
      checked += 1;
      const evidenceIds = stringList(assertion["evidenceIds"]);
      const claim =
        firstString(value, "displayName", "name", "statement", "text", "apiName") ?? path;
      if (evidenceIds.length === 0) {
        issues.push({
          code: "MATERIAL_EVIDENCE_MISSING",
          path: path || "/",
          evidenceIds,
          claim,
        });
      } else {
        const resolvedTexts: string[] = [];
        for (const id of evidenceIds) {
          const evidence = evidenceById.get(id);
          if (evidence === undefined) continue;
          for (const text of sourceForEvidence(evidence)) {
            const packagedSnippet = firstString(evidence, "snippet");
            if (
              packagedSnippet !== null &&
              !evidenceValueNorm(text).includes(evidenceValueNorm(packagedSnippet))
            ) continue;
            if (!resolvedTexts.includes(text)) resolvedTexts.push(text);
          }
        }
        if (resolvedTexts.length === 0) {
          issues.push({
            code: "MATERIAL_EVIDENCE_UNRESOLVED",
            path: path || "/",
            evidenceIds,
            claim,
          });
        } else {
          const labels = materialClaimLabels(value);
          const supported =
            labels.length === 0 ||
            resolvedTexts.some((text) => {
              const body = evidenceValueNorm(text);
              return labels.some((label) => materialLabelSupported(body, label));
            });
          if (!supported) {
            issues.push({
              code: "MATERIAL_EVIDENCE_NOT_SUPPORTING_CLAIM",
              path: path || "/",
              evidenceIds,
              claim,
            });
          }
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "assertion" || key === "validation" || key === "evidence") continue;
      walk(child, `${path}/${key}`);
    }
  };
  walk(pkg, "");
  return { enforced: true, passed: issues.length === 0, checked, issues };
}

export function traceability(pkg: Dict): [number, string[]] {
  let checked = 0;
  const unresolved: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (isMapping(value)) {
      const assertion = value["assertion"];
      if (isMapping(assertion)) {
        checked += 1;
        if (
          pyStr(truthy(assertion["origin"]) ? assertion["origin"] : "").toUpperCase() ===
            "INFERRED" &&
          !truthy(assertion["evidenceIds"])
        ) {
          unresolved.push(path || "/");
        }
      }
      // 键序即 Python dict 的插入序。**整数样式的键会被 V8 排到最前** ——
      // 包里的键全是标识符样式的字符串，命中不了这条，但换成动态键要留神。
      for (const [key, child] of Object.entries(value)) {
        if (key !== "assertion" && key !== "validation") walk(child, `${path}/${key}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}/${index}`));
    }
  };

  walk(pkg, "");
  return [checked, unresolved];
}

export { EXPECTED_ARTIFACTS };
