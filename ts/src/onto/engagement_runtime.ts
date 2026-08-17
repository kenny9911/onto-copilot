/**
 * Executable handlers for the frozen FDE engagement DAG.
 *
 * The extraction DAG remains the expensive, mature implementation of document
 * understanding.  This module turns its result into the *product* workflow: every
 * FDE stage is executed and checkpointed by `kernel/scheduler.ts`'s Scheduler
 * without paying a second time for the same evidence.  Agent-shaped stages use
 * `skipModel` to produce deterministic, schema-shaped projections from OIR and
 * Flow; deployments can replace one handler at a time with a model-backed version
 * without changing the frozen topology.
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
import { buildPackage, pyStr, pyStrip, validatePackage } from "./canonical.js";
import { cmpCodePoint } from "./difflib.js";
import type { OIR } from "./oir.js";
import { DecisionLedger, type Question, QuestionBacklog, QuestionStatus } from "./questions.js";
import { defaultAgents } from "../kernel/agents.js";
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
import { NodeHandler, type RunContext } from "../kernel/loop.js";

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
  // 顺序照 Python：先认 Mapping 再认 to_dict —— 反过来的话，既是 Mapping 又带
  // to_dict 的对象会走另一条分支，产出的字典形状就变了。
  if (isMapping(value)) return { ...value };
  if (hasToDict(value)) return value.toDict();
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
  skippedReviews?: readonly SkippedReview[] | undefined;
}

/** Materialized inputs for one engagement execution/replay. */
export class EngagementRuntimeInput {
  readonly sessionId: string;
  readonly project: string;
  readonly oir: OIR | Dict;
  readonly flow: unknown;
  readonly backlog: QuestionBacklog | Dict;
  readonly decisions: DecisionLedger | readonly unknown[] | Dict;
  readonly corpus: Dict;
  readonly artifactRevision: number;
  readonly generatedAt: string;
  readonly releaseDownloadable: boolean;
  /** 本次运行没有跑的评审（`Budget.skippedReviews()`）。空 = 全跑了。 */
  readonly skippedReviews: readonly SkippedReview[];

  // 默认值写在构造函数体里而不是 class field —— 见 CONTRACT §1。
  constructor(init: EngagementRuntimeInputInit) {
    this.sessionId = init.sessionId;
    this.project = init.project;
    this.oir = init.oir;
    this.skippedReviews = [...(init.skippedReviews ?? [])];
    this.flow = init.flow ?? null;
    this.backlog = init.backlog ?? new QuestionBacklog();
    this.decisions = init.decisions ?? new DecisionLedger();
    this.corpus = { ...(init.corpus ?? {}) };
    this.artifactRevision = init.artifactRevision ?? 0;
    this.generatedAt = init.generatedAt ?? "1970-01-01T00:00:00+00:00";
    this.releaseDownloadable = init.releaseDownloadable ?? true;
  }

  oirDict(): Dict {
    return asDict(this.oir);
  }

  flowDict(): Dict {
    return asDict(this.flow);
  }

  questionBacklog(): QuestionBacklog {
    if (this.backlog instanceof QuestionBacklog) return this.backlog;
    return QuestionBacklog.fromDict(this.backlog);
  }

  decisionRows(): Dict[] {
    if (this.decisions instanceof DecisionLedger) {
      return this.decisions.decisions.map((d) => d.toDict());
    }
    let raw: unknown = this.decisions;
    if (isMapping(raw)) raw = truthy(raw["decisions"]) ? raw["decisions"] : [];
    return iterOf(raw).map((row) => asDict(row));
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
/** A model-shaped node whose current production path is deterministic. */
abstract class StaticProjection extends NodeHandler {
  readonly runtime: EngagementRuntimeInput;

  constructor(runtime: EngagementRuntimeInput, agentName: string) {
    super();
    this.runtime = runtime;
    const agent = defaultAgents().get(agentName);
    this.schema = agent.outputSchema;
    this.system = agent.system;
  }

  override task(_inputs: Dict): string {
    return "把成熟抽取结果投影为本节点的稳定 FDE 交付契约。";
  }

  override skipModel(inputs: Dict): unknown {
    return this.project(inputs);
  }

  abstract project(inputs: Dict): Dict;
}

export class IntakeHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "fde_interviewer");
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
        answer_schema: { ...(truthy(q.answerSchema) ? q.answerSchema : { type: "string" }) },
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
}

export class ProcessHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "process_modeler");
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
}

export class ERPMapHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "erp_mapper");
  }

  project(inputs: Dict): Dict {
    const process = truthy(inputs["PROCESS"]) ? inputs["PROCESS"] : {};
    const landscape = new Map<string, Dict>();
    const mappings: Dict[] = [];
    for (const step of iterOf(get(process, "steps"))) {
      for (const rawSystem of iterOf(get(step, "system_ids"))) {
        const raw = pyStrip(pyStr(rawSystem));
        if (raw === "") continue;
        const head = pySplit(raw, "//", 1).at(-1) as string;
        const name = pySplit(head, "/", 1)[0] || raw;
        const sid = `sys.${name}`;
        if (!landscape.has(sid)) {
          landscape.set(sid, {
            system_id: sid,
            product: name,
            version: null,
            module: null,
            org_scope: null,
          });
        }
        mappings.push({
          // Python 是 `step["id"]`，缺键直接 KeyError。照抄地炸。
          process_step_id: mustGet(step, "id"),
          system_id: sid,
          implementation_kind: "UNKNOWN",
          target_refs: [raw],
          confidence: 0.5,
          evidence_ids: [...iterOf(get(step, "evidence_ids"))],
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
}

export class RulesHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "rule_engineer");
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
}

export class DataObjectsHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "data_steward");
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
    return Promise.resolve({
      contract: "QuestionBacklog",
      questions: backlog.toDict()["questions"],
      pending: this.runtime.pending().map((q) => q.id),
      next_batch: backlog.nextBatch({ limit: 5 }).map((q) => q.id),
      stats: backlog.stats(),
      // `sorted(inputs)` —— 对 dict 排序就是对**键**排序。
      sources: Object.keys(inputs).sort(cmpCodePoint),
    });
  }
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
      releaseState: this.runtime.pending().length > 0 ? "DRAFT" : "RELEASED",
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
      why: "本次梳理没有任何人工拍板记录：材料里没有检出待澄清的冲突，HITL 环节自动放行",
      level: 0,
      label: "未经人工确认",
    },
  ];
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

  override async execute(_inputs: Dict, ctx: RunContext): Promise<Dict> {
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
        decisions: this.runtime.decisionRows(),
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
    const data = pkg.toDict();
    data["validation"] = report.toDict();
    return await Promise.resolve(data);
  }
}

export class ReviewHandler extends StaticProjection {
  constructor(runtime: EngagementRuntimeInput) {
    super(runtime, "delivery_reviewer");
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
    const [checked, ungrounded] = traceability(pkg);
    const valid = report.passed;
    const artifactChecks = EXPECTED_ARTIFACTS.map((artifact) => ({
      artifact_id: artifact,
      schema_valid: valid,
      downloadable: Boolean(this.runtime.releaseDownloadable),
    }));
    const unresolvedQuestions = this.runtime.pending();
    const releaseState = unresolvedQuestions.length > 0 ? "DRAFT" : "RELEASED";
    const warnings =
      unresolvedQuestions.length > 0
        ? [`${unresolvedQuestions.length} 个非阻塞问题尚待澄清，交付件标记为 DRAFT`]
        : [];
    if (ungrounded.length > 0) {
      warnings.push(`${ungrounded.length} 条推断断言没有材料证据`);
    }
    return {
      verdict: blockers.length === 0 ? "PASS" : "BLOCKED",
      blockers,
      warnings,
      releaseState,
      traceability: { checked, unresolved: ungrounded.slice(0, 100) },
      artifact_checks: artifactChecks,
      blocker_count: blockers.length,
      schema_valid: valid,
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
    const report = validatePackage(pkg);
    const artifactChecks = iterOf(review["artifact_checks"]);
    const downloadable =
      artifactChecks.length > 0 && artifactChecks.every((item) => truthy(get(item, "downloadable")));
    return Promise.resolve({
      review_passed: review["verdict"] === "PASS",
      schema_valid: report.passed && truthy(review["schema_valid"]),
      downloadable,
      releaseState: truthy(review["releaseState"]) ? review["releaseState"] : "DRAFT",
      warnings: [...iterOf(review["warnings"])],
      formats: ["json", "xlsx", "md", "mermaid"],
      artifacts: artifactChecks.map((item) => get(item, "artifact_id") ?? null),
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

/** Surface ungrounded projections without inventing a release blocker. */
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
            claim: `${unresolved.length} 条推断断言没有材料证据，已在交付警告中披露`,
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
export function engagementHandlers(runtime: EngagementRuntimeInput): Record<string, NodeHandler> {
  return {
    "agent.fde_interviewer": new IntakeHandler(runtime),
    "agent.process_modeler": new ProcessHandler(runtime),
    "agent.erp_mapper": new ERPMapHandler(runtime),
    "agent.rule_engineer": new RulesHandler(runtime),
    "agent.data_steward": new DataObjectsHandler(runtime),
    "engagement.collect_gaps": new GapHandler(runtime),
    "engagement.interview": new InterviewHandler(runtime),
    "engagement.canonicalize": new CanonicalizeHandler(runtime),
    "agent.delivery_reviewer": new ReviewHandler(runtime),
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
