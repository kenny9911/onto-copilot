/**
 * FDE delivery read tools.
 *
 * These tools deliberately project only durable Decisions/Revisions and the
 * professional engagement outputs already present in session state.  They do
 * not call a model, synthesize missing artifacts, apply a Decision, or record a
 * human signature.  In particular, `signoff.package` prepares a review packet;
 * it is not a sign-off endpoint.
 */

import { Danger } from "../../kernel/tools.js";
import type { ManagedToolRegistrar } from "../../catalog/tools.js";
import type { DialogueDeps, SessionLike } from "./ports.js";

type Dict = Record<string, unknown>;

const RO = ["converse", "chat"] as const;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

function record(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

function rows(value: unknown): Dict[] {
  return Array.isArray(value) ? value.filter((item): item is Dict =>
    item !== null && typeof item === "object" && !Array.isArray(item)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function finiteInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function limitOf(value: unknown): number {
  return Math.max(1, Math.min(MAX_LIMIT, finiteInt(value, DEFAULT_LIMIT)));
}

function analysisNodes(s: SessionLike): Dict {
  return record(record(s.state["engagement_analysis"])["nodes"]);
}

function analysisMissing(s: SessionLike): Dict | null {
  if (Object.keys(analysisNodes(s)).length > 0) return null;
  return {
    status: "NOT_AVAILABLE",
    items: [],
    note:
      "还没有 FDE Engagement 专业分析产物。空结果表示无产物可查，不表示需求、架构或测试已确认不存在。",
  };
}

function questionRows(s: SessionLike, deps: DialogueDeps): Dict[] {
  return [...deps.questionBacklog(s).questions.values()].map((q) => q.toDict());
}

interface RequirementView {
  readonly ref: string;
  readonly kind: string;
  readonly statement: string;
  readonly source_node: string;
  readonly status: string;
  readonly evidence_ids: readonly string[];
  readonly linked_ids: readonly string[];
  readonly requirement_type?: string;
  readonly raw: Dict;
}

function makeRequirement(
  ref: string,
  kind: string,
  statement: unknown,
  sourceNode: string,
  raw: Dict = {},
): RequirementView {
  const linked = new Set<string>();
  for (const key of [
    "dependencies",
    "blockedArtifacts",
    "blocked_artifacts",
    "scopeRefs",
    "scope_refs",
    "applies_to_ids",
    "target_refs",
    "source_refs",
    "depends_on_ids",
    "related_artifact_ids",
    "capability_ids",
    "blocked_ids",
    "component_ids",
    "requirement_ids",
    "related_requirement_ids",
    "test_case_ids",
    "blocked_test_case_ids",
  ]) {
    for (const item of strings(raw[key])) linked.add(item);
  }
  for (const key of [
    "sourceRef", "source_ref", "process_step_id", "data_object_id", "trigger_event_id",
    "requirement_id", "component_id", "decision_id", "target_id",
  ]) {
    const item = text(raw[key]);
    if (item) linked.add(item);
  }
  return {
    ref,
    kind,
    statement: text(statement),
    source_node: sourceNode,
    status: text(raw["confirmation_status"] ?? raw["status"]) || "DECLARED",
    evidence_ids: strings(raw["evidence_ids"] ?? raw["evidenceIds"]),
    linked_ids: [...linked],
    raw,
  };
}

function requirements(s: SessionLike, deps: DialogueDeps): RequirementView[] {
  const nodes = analysisNodes(s);
  const canonical = record(nodes["REQUIREMENTS"]);
  if (Object.hasOwn(nodes, "REQUIREMENTS")) {
    const out: RequirementView[] = [];
    rows(canonical["requirements"]).forEach((item, index) => {
      const view = makeRequirement(
        text(item["id"]) || `REQUIREMENTS.requirements[${index}]`,
        "requirement",
        item["statement"],
        "REQUIREMENTS",
        item,
      );
      out.push({ ...view, requirement_type: text(item["type"]) || "UNKNOWN" });
    });
    rows(canonical["coverage_assessments"]).forEach((item, index) => out.push(makeRequirement(
      text(item["id"]) || `REQUIREMENTS.coverage_assessments[${index}]`,
      "coverage_assessment",
      item["statement"] ?? item["scope"] ?? item["status"],
      "REQUIREMENTS",
      item,
    )));
    const canonicalQuestions = Array.isArray(canonical["questions"])
      ? canonical["questions"] as unknown[]
      : [];
    canonicalQuestions.forEach((item, index) => {
      const raw = record(item);
      out.push(makeRequirement(
        text(raw["id"]) || `REQUIREMENTS.questions[${index}]`,
        "question",
        Object.keys(raw).length > 0 ? raw["text"] ?? raw["statement"] : item,
        "REQUIREMENTS",
        raw,
      ));
    });
    // The unified backlog owns lifecycle and routing.  Keep those rows even when
    // the canonical REQUIREMENTS projection exists; dedupe by stable ref.
    const seen = new Set(out.map((item) => item.ref));
    for (const item of questionRows(s, deps)) {
      const ref = text(item["id"]);
      if (seen.has(ref)) continue;
      out.push(makeRequirement(ref, "question", item["text"], "QUESTION_BACKLOG", item));
    }
    return out;
  }

  const intake = record(nodes["INTAKE"]);
  const engagement = record(intake["engagement"]);
  const out: RequirementView[] = [];

  for (const [key, kind] of [
    ["in_scope", "scope_in"],
    ["out_of_scope", "scope_out"],
    ["acceptance_criteria", "acceptance_criterion"],
  ] as const) {
    const values = Array.isArray(engagement[key]) ? engagement[key] as unknown[] : [];
    values.forEach((value, index) => out.push(makeRequirement(
      `INTAKE.engagement.${key}[${index}]`, kind, value, "INTAKE",
    )));
  }
  rows(intake["findings"]).forEach((item, index) => out.push(makeRequirement(
    text(item["id"]) || `INTAKE.findings[${index}]`,
    "finding",
    item["statement"],
    "INTAKE",
    item,
  )));

  const rules = record(nodes["RULES"]);
  rows(rules["rules"]).forEach((item, index) => out.push(makeRequirement(
    text(item["id"]) || `RULES.rules[${index}]`,
    "business_rule",
    `${text(item["condition"])} => ${text(item["effect"])}`,
    "RULES",
    item,
  )));

  const data = record(nodes["DATA_OBJECTS"]);
  rows(data["quality_rules"]).forEach((item, index) => out.push(makeRequirement(
    text(item["id"]) || `DATA_OBJECTS.quality_rules[${index}]`,
    "quality_rule",
    item["expression"],
    "DATA_OBJECTS",
    item,
  )));

  for (const item of questionRows(s, deps)) {
    out.push(makeRequirement(
      text(item["id"]),
      "question",
      item["text"],
      "QUESTION_BACKLOG",
      item,
    ));
  }
  return out;
}

interface TraceRow {
  readonly ref: string;
  readonly node: string;
  readonly collection: string;
  readonly item: Dict;
}

function traceRows(s: SessionLike, deps: DialogueDeps): TraceRow[] {
  const out: TraceRow[] = [];
  const nodes = analysisNodes(s);
  for (const [node, value] of Object.entries(nodes)) {
    const body = record(value);
    for (const [collection, valueRows] of Object.entries(body)) {
      rows(valueRows).forEach((item, index) => {
        out.push({
          ref: text(item["id"] ?? item["system_id"] ?? item["process_id"]) || `${node}.${collection}[${index}]`,
          node,
          collection,
          item,
        });
      });
    }
  }
  questionRows(s, deps).forEach((item, index) => out.push({
    ref: text(item["id"]) || `QUESTION_BACKLOG.questions[${index}]`,
    node: "QUESTION_BACKLOG",
    collection: "questions",
    item,
  }));
  return out;
}

const LINK_KEYS = new Set([
  "dependencies",
  "blockedArtifacts",
  "blocked_artifacts",
  "scopeRefs",
  "scope_refs",
  "applies_to_ids",
    "target_refs",
    "source_refs",
    "depends_on_ids",
    "related_artifact_ids",
    "capability_ids",
    "blocked_ids",
    "component_ids",
  "requirement_ids",
  "related_requirement_ids",
  "rule_ids",
    "process_step_ids",
    "integration_contract_ids",
  "test_case_ids",
  "blocked_test_case_ids",
    "payload_object_ids",
    "related_ids",
  "evidence_ids",
  "evidenceIds",
  "sourceRef",
  "source_ref",
  "process_step_id",
  "system_id",
  "data_object_id",
  "trigger_event_id",
  "requirement_id",
  "component_id",
  "producer_component_id",
  "consumer_component_id",
]);

function linkedValues(item: Dict): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(item)) {
    if (!LINK_KEYS.has(key)) continue;
    if (typeof value === "string" && value) out.add(value);
    for (const child of strings(value)) out.add(child);
  }
  return [...out];
}

function conflictRows(s: SessionLike): Dict[] {
  const live = s.state["_conflicts"];
  if (Array.isArray(live)) return live.map(record);
  return rows(s.state["conflicts"]);
}

/** Prefer the workflow-owned proposal/application contracts when present. */
function workflowDecisionPreview(s: SessionLike, args: Dict): Dict | null {
  const nodes = analysisNodes(s);
  if (!Object.hasOwn(nodes, "DECISION_PROPOSAL")) return null;
  const proposal = record(nodes["DECISION_PROPOSAL"]);
  const application = record(nodes["DECISION_APPLY"]);
  const wantQuestion = text(args["question_id"]);
  const wantDecision = text(args["decision_id"]);
  const wantPatch = text(args["patch_id"]);
  if (!wantQuestion && !wantDecision && !wantPatch) {
    return {
      status: "SELECTOR_REQUIRED",
      auto_applied: false,
      available_decision_ids: rows(proposal["decision_assessments"])
        .map((item) => text(item["decision_id"])).filter(Boolean).slice(0, 100),
      available_patch_ids: rows(proposal["patch_proposals"])
        .map((item) => text(item["id"])).filter(Boolean).slice(0, 100),
      note: "请传 question_id、decision_id 或 patch_id；未选择时不会猜。",
    };
  }
  const assessments = rows(proposal["decision_assessments"]).filter((item) =>
    (!wantQuestion || text(item["question_id"]) === wantQuestion) &&
    (!wantDecision || text(item["decision_id"]) === wantDecision)).slice(0, DEFAULT_LIMIT);
  const decisionIds = new Set([
    ...assessments.map((item) => text(item["decision_id"])),
    ...(wantDecision ? [wantDecision] : []),
  ].filter(Boolean));
  const patches = rows(proposal["patch_proposals"]).filter((item) =>
    (!wantPatch || text(item["id"]) === wantPatch) &&
    (decisionIds.size === 0 || decisionIds.has(text(item["decision_id"])))).slice(0, DEFAULT_LIMIT);
  const selectedPatchIds = new Set(patches.map((item) => text(item["id"])).filter(Boolean));
  const validated = rows(application["validated_patches"]).filter((item) =>
    selectedPatchIds.has(text(item["id"]))).slice(0, DEFAULT_LIMIT);
  const rejected = rows(application["rejected_patches"]).filter((item) =>
    selectedPatchIds.has(text(item["id"]))).slice(0, DEFAULT_LIMIT);
  const unresolved = rows(proposal["unresolved_items"]).filter((item) =>
    decisionIds.size === 0 || decisionIds.has(text(item["decision_id"]))).slice(0, DEFAULT_LIMIT);
  return {
    status: assessments.length > 0 || patches.length > 0 || unresolved.length > 0
      ? "PREVIEW_ONLY"
      : "NOT_FOUND",
    contract: "DecisionChangeProposal.v1",
    base_revision: proposal["base_revision"] ?? null,
    decision_assessments: assessments,
    patch_proposals: patches,
    unresolved_items: unresolved,
    application_validation: Object.keys(application).length > 0 ? {
      contract: application["contract"] ?? "DecisionApplicationValidation.v1",
      status: application["status"] ?? "UNKNOWN",
      validated_patches: validated,
      rejected_patches: rejected,
      mutation_count: application["mutation_count"] ?? null,
      applied: application["applied"] ?? false,
      applied_changes: application["applied_changes"] ?? [],
    } : { status: "NOT_AVAILABLE" },
    auto_applied: false,
    apply_guard:
      "DECISION_PROPOSAL/DECISION_APPLY 只形成与校验候选变更；当前 workflow 明确 mutation_count=0，不能声称业务模型已经改动。",
  };
}

function decisionPreview(s: SessionLike, deps: DialogueDeps, args: Dict): Dict {
  const workflow = workflowDecisionPreview(s, args);
  if (workflow !== null) return workflow;
  const qid = text(args["question_id"]).trim();
  if (!qid) {
    return {
      status: "SELECTOR_REQUIRED",
      auto_applied: false,
      note: "旧会话没有 DECISION_PROPOSAL；请传 question_id 才能从 QuestionBacklog 兼容预览。",
    };
  }
  const q = deps.questionBacklog(s).questions.get(qid);
  if (q === undefined) {
    return {
      status: "NOT_FOUND",
      question_id: qid,
      available_question_ids: [...deps.questionBacklog(s).questions.keys()].slice(0, 100),
      auto_applied: false,
    };
  }
  const raw = q.toDict();
  const sourceKind = text(raw["sourceKind"] ?? raw["source_kind"]);
  const sourceRef = text(raw["sourceRef"] ?? raw["source_ref"]);
  const optionId = text(args["option_id"] ?? args["answer"]);
  const base: Dict = {
    status: "PREVIEW_ONLY",
    question_id: qid,
    question_version: raw["version"] ?? null,
    question_status: raw["status"] ?? null,
    source_kind: sourceKind,
    source_ref: sourceRef,
    base_revision: finiteInt(s.state["artifact_revision"], 0),
    answer_schema: raw["answerSchema"] ?? raw["answer_schema"] ?? {},
    blocked_artifacts: strings(raw["blockedArtifacts"] ?? raw["blocked_artifacts"]),
    auto_applied: false,
    apply_guard:
      "本工具不会写 Decision 或应用补丁。只有用户明确回答后才能调用 question.answer。",
  };

  if (sourceKind !== "conflict" && !sourceRef.startsWith("cf_")) {
    return {
      ...base,
      effect_status: "NO_DETERMINISTIC_FIELD_PATCH",
      patch_ops: [],
      affected_ids: [],
      note:
        "这类问题没有可预演的冲突 effect；回答会进入 Decision Ledger，但不能据此声称字段将自动改动。",
    };
  }

  const conflict = conflictRows(s).find((item) => text(item["rid"]) === sourceRef);
  if (conflict === undefined) {
    return {
      ...base,
      effect_status: "SOURCE_CONFLICT_NOT_AVAILABLE",
      patch_ops: [],
      affected_ids: [],
      note: "源冲突已不存在或尚未载入；无法预览，不得把空补丁解释成无影响。",
    };
  }
  const options = rows(conflict["options"]);
  if (!optionId) {
    return {
      ...base,
      effect_status: "OPTION_REQUIRED",
      options: options.map((item) => ({ id: item["id"], label: item["label"] })),
      patch_ops: [],
      affected_ids: [],
    };
  }
  const option = options.find((item) => text(item["id"]) === optionId);
  if (option === undefined) {
    return {
      ...base,
      effect_status: "OPTION_NOT_FOUND",
      requested_option: optionId,
      options: options.map((item) => ({ id: item["id"], label: item["label"] })),
      patch_ops: [],
      affected_ids: [],
    };
  }
  const effect = record(option["effect"]);
  const subjects = strings(conflict["subjects"]);
  let affected: string[] = [];
  if (strings(effect["split"]).length > 0) affected = strings(effect["split"]);
  else if (text(effect["unify_to"])) affected = subjects.filter((id) => id !== text(effect["unify_to"]));
  else if (effect["set_base_type"] !== undefined) affected = subjects;
  return {
    ...base,
    effect_status: "DETERMINISTIC_EFFECT_FOUND",
    selected_option: { id: option["id"], label: option["label"], rationale: option["rationale"] },
    patch_ops: Object.keys(effect).length > 0 ? [effect] : [],
    affected_ids: affected,
    evidence: Array.isArray(option["evidence"]) ? option["evidence"] : [],
  };
}

function ruleRows(s: SessionLike): Dict[] {
  return rows(record(analysisNodes(s)["RULES"])["rules"]);
}

function acceptanceCoverage(s: SessionLike): Dict {
  const nodes = analysisNodes(s);
  const testPlan = record(nodes["TEST_PLAN"]);
  if (Object.hasOwn(nodes, "TEST_PLAN")) {
    const tests = rows(testPlan["test_cases"]);
    const traceability = rows(testPlan["traceability"]);
    const gaps = rows(testPlan["coverage_gaps"]);
    const requirementIds = [...new Set([
      ...rows(record(nodes["REQUIREMENTS"])["requirements"])
        .map((item) => text(item["id"])).filter(Boolean),
      ...traceability.map((item) => text(item["requirement_id"])).filter(Boolean),
    ])];
    const coverageOf = (item: Dict): string => {
      const explicit = text(item["coverage"]);
      if (explicit) return explicit;
      return strings(item["test_case_ids"]).length > 0 ? "COVERED" : "UNCOVERED";
    };
    const covered = new Set(traceability
      .filter((item) => coverageOf(item) === "COVERED")
      .map((item) => text(item["requirement_id"])).filter(Boolean));
    const kinds = Object.fromEntries(
      [
        "BUSINESS_SCENARIO", "BUSINESS_RULE", "INTEGRATION", "DATA_QUALITY",
        "AUTHORIZATION", "SOD", "NEGATIVE", "REGRESSION",
      ].map((kind) => [
        kind,
        tests.filter((item) => text(item["kind"]) === kind).length,
      ]),
    );
    return {
      status: "AVAILABLE",
      source_node: "TEST_PLAN",
      requirement_test_design_coverage: {
        total_requirements: requirementIds.length,
        covered_requirements: covered.size,
        coverage_pct:
          requirementIds.length > 0
            ? Math.round((covered.size / requirementIds.length) * 10000) / 100
            : null,
        coverage_gaps: gaps,
        by_status: Object.fromEntries(["COVERED", "PARTIAL", "UNCOVERED", "BLOCKED"].map((status) => [
          status,
          traceability.filter((item) => coverageOf(item) === status).length,
        ])),
      },
      test_case_design: {
        total: tests.length,
        by_kind: kinds,
        statuses: Object.fromEntries([...new Set(tests.map((item) => text(item["status"]) || "UNKNOWN"))]
          .map((status) => [status, tests.filter((item) => (text(item["status"]) || "UNKNOWN") === status).length])),
      },
      traceability,
      workflow_readiness: testPlan["readiness"] ?? {},
      execution: { status: "NOT_EXECUTED", passed: null },
      boundary:
        "TEST_PLAN 的 READY_FOR_REVIEW/coverage_pct 只表示验收测试设计与需求追溯已准备，不表示测试已运行或通过。",
    };
  }
  const rules = ruleRows(s);
  const criteria = Array.isArray(record(record(nodes["INTAKE"])["engagement"])["acceptance_criteria"])
    ? record(record(nodes["INTAKE"])["engagement"])["acceptance_criteria"] as unknown[]
    : [];
  const kinds = ["POSITIVE", "BOUNDARY", "NEGATIVE", "EXCEPTION"];
  const withTests = rules.filter((rule) => rows(rule["test_cases"]).length > 0);
  const byKind = Object.fromEntries(kinds.map((kind) => [
    kind,
    rules.filter((rule) => rows(rule["test_cases"]).some((test) => text(test["kind"]) === kind)).length,
  ]));
  return {
    status: Object.keys(nodes).length > 0 ? "AVAILABLE" : "NOT_AVAILABLE",
    rule_test_design_coverage: {
      total_rules: rules.length,
      rules_with_tests: withTests.length,
      coverage_pct: rules.length > 0 ? Math.round((withTests.length / rules.length) * 10000) / 100 : null,
      rules_without_tests: rules.filter((rule) => rows(rule["test_cases"]).length === 0)
        .map((rule) => text(rule["id"])),
      rules_without_evidence: rules.filter((rule) => strings(rule["evidence_ids"]).length === 0)
        .map((rule) => text(rule["id"])),
      rules_covered_by_kind: byKind,
    },
    acceptance_criteria: {
      total: criteria.length,
      criteria: criteria.map((criterion, index) => ({
        ref: `INTAKE.engagement.acceptance_criteria[${index}]`,
        statement: criterion,
        explicit_test_links: [],
      })),
      linkage_status: criteria.length > 0 ? "NOT_MODELED" : "NOT_AVAILABLE",
    },
    boundary:
      "coverage_pct 只表示规则是否设计了至少一个测试，不表示测试已执行或验收标准已被测试覆盖。当前契约没有 acceptance criterion → test 的显式链接。",
  };
}

function packageValidation(s: SessionLike): "PASS" | "FAIL" | "UNKNOWN" {
  const validation = record(record(s.state["ontology_package"])["validation"]);
  if (validation["passed"] === true) return "PASS";
  if (validation["passed"] === false) return "FAIL";
  const review = record(analysisNodes(s)["REVIEW"]);
  if (review["schema_valid"] === true) return "PASS";
  if (review["schema_valid"] === false) return "FAIL";
  return "UNKNOWN";
}

/** Register the eight catalog-managed, read-only FDE delivery tools. */
export function registerFdeDialogueTools(
  reg: ManagedToolRegistrar,
  s: SessionLike,
  deps: DialogueDeps,
): void {
  reg.fn(
    {
      name: "decision.patch.preview",
      description:
        "在回答统一问题之前，预览该选项已有的确定性 conflict effect、预计受影响 ID、" +
        "基准 revision 与证据。它永远只读，不会记录 Decision，也不会调用 question.answer。",
      schema: {
        type: "object",
        properties: {
          question_id: { type: "string", minLength: 1, maxLength: 160 },
          decision_id: { type: "string", minLength: 1, maxLength: 160 },
          patch_id: { type: "string", minLength: 1, maxLength: 160 },
          option_id: { type: "string", maxLength: 240, description: "冲突选项 id；不传则只列可选项" },
          answer: { type: ["string", "number", "boolean", "null"], description: "非枚举回答，仅用于说明预览边界" },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => decisionPreview(s, deps, args),
  );

  reg.fn(
    {
      name: "decision.patch.query",
      description:
        "查询统一 Decision Ledger 与 Revision Ledger 中已经耐久记录的 Decision、" +
        "PatchSet 和状态。只读历史事实；空结果不能解释成从未有人决策。",
      schema: {
        type: "object",
        properties: {
          decision_id: { type: "string", maxLength: 160 },
          patch_id: { type: "string", maxLength: 160 },
          question_id: { type: "string", maxLength: 160 },
          status: { type: "string", maxLength: 64, description: "claimed / applied / failed 等" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    async (args) => {
      const repo = deps.getRepo();
      const [decisions, revisions] = await Promise.all([
        repo.listDecisionsV1(s.id),
        repo.listRevisions(s.id),
      ]);
      const wantDecision = text(args["decision_id"]);
      const wantPatch = text(args["patch_id"]);
      const wantQuestion = text(args["question_id"]);
      const wantStatus = text(args["status"]);
      const cap = limitOf(args["limit"]);
      const filtered = decisions.filter((decision) =>
        (!wantDecision || decision.id === wantDecision) &&
        (!wantPatch || `patch.${decision.id}` === wantPatch) &&
        (!wantQuestion || decision.question_id === wantQuestion) &&
        (!wantStatus || text(decision.metadata["status"]) === wantStatus));
      const items = filtered.slice(0, cap).map((decision) => {
        const expectedPatchId = `patch.${decision.id}`;
        const revision = revisions.find((row) =>
          text(record(row.patch_set)["id"]) === expectedPatchId ||
          text(record(record(row.doc)["patchSet"])["id"]) === expectedPatchId);
        return {
          decision_id: decision.id,
          question_id: decision.question_id,
          answer: decision.answer,
          actor: decision.actor,
          authority: decision.authority,
          status: decision.metadata["status"] ?? "UNKNOWN",
          affected_ids: [...decision.affected_ids],
          rationale: decision.rationale,
          created: decision.created,
          revision: revision === undefined ? null : {
            id: revision.id,
            ordinal: revision.ordinal,
            status: revision.status,
            changed_ids: [...revision.changed_ids],
            invalidated_artifacts: [...revision.invalidated_artifacts],
            patch_set: revision.patch_set,
          },
        };
      });
      const nodes = analysisNodes(s);
      const proposal = record(nodes["DECISION_PROPOSAL"]);
      const application = record(nodes["DECISION_APPLY"]);
      const workflowAssessments = rows(proposal["decision_assessments"]).filter((item) =>
        (!wantDecision || text(item["decision_id"]) === wantDecision) &&
        (!wantQuestion || text(item["question_id"]) === wantQuestion));
      const workflowDecisionIds = new Set([
        ...workflowAssessments.map((item) => text(item["decision_id"])),
        ...filtered.map((item) => item.id),
      ].filter(Boolean));
      const workflowPatches = rows(proposal["patch_proposals"]).filter((item) =>
        (!wantPatch || text(item["id"]) === wantPatch) &&
        (!wantDecision || text(item["decision_id"]) === wantDecision) &&
        (!wantQuestion || workflowDecisionIds.has(text(item["decision_id"]))));
      const workflowPatchIds = new Set(workflowPatches.map((item) => text(item["id"])).filter(Boolean));
      const hasWorkflowSelector = Boolean(wantPatch || wantDecision || wantQuestion);
      const applicationView = Object.keys(application).length > 0 ? {
        contract: application["contract"] ?? "DecisionApplicationValidation.v1",
        status: application["status"] ?? "UNKNOWN",
        safe_to_continue: application["safe_to_continue"] ?? null,
        mutation_count: application["mutation_count"] ?? null,
        applied: application["applied"] ?? false,
        applied_changes: Array.isArray(application["applied_changes"])
          ? (application["applied_changes"] as unknown[]).slice(0, cap)
          : [],
        validated_patches: rows(application["validated_patches"])
          .filter((item) => !hasWorkflowSelector || workflowPatchIds.has(text(item["id"])))
          .slice(0, cap),
        rejected_patches: rows(application["rejected_patches"])
          .filter((item) => !hasWorkflowSelector || workflowPatchIds.has(text(item["id"])))
          .slice(0, cap),
        unapplied_decisions: rows(application["unapplied_decisions"])
          .filter((item) => !hasWorkflowSelector || workflowDecisionIds.has(text(item["decision_id"])))
          .slice(0, cap),
      } : null;
      return {
        status:
          decisions.length > 0 || revisions.length > 0 || Object.keys(proposal).length > 0
            ? "AVAILABLE"
            : "NOT_AVAILABLE",
        total_decisions: decisions.length,
        matched: filtered.length,
        returned: items.length,
        truncated: filtered.length > items.length,
        items,
        workflow_projection: Object.keys(proposal).length > 0 ? {
          contract: "DecisionChangeProposal.v1",
          base_revision: proposal["base_revision"] ?? null,
          decision_assessments: workflowAssessments.slice(0, cap),
          patch_proposals: workflowPatches.slice(0, cap),
          unresolved_items: rows(proposal["unresolved_items"]).filter((item) =>
            !wantDecision || text(item["decision_id"]) === wantDecision).slice(0, cap),
          application_validation: applicationView,
        } : null,
        auto_applied: false,
        note:
          decisions.length === 0 && revisions.length === 0
            ? "Decision/Revision 台账目前无记录；这不是对历史决策不存在的证明，旧会话可能尚未接入统一台账。"
            : "这里只回放已记录事实，不应用或重放任何补丁。",
      };
    },
  );

  reg.fn(
    {
      name: "requirements.query",
      description:
        "查询 FDE Engagement 已产出的范围、验收标准、业务规则、数据质量规则与统一问题。" +
        "结果保留来源节点和证据 ID，不从材料或对话中临时编造需求。",
      schema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["requirement", "coverage_assessment", "scope_in", "scope_out", "acceptance_criterion", "finding", "business_rule", "quality_rule", "question"],
          },
          contains: { type: "string", maxLength: 240 },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const missing = analysisMissing(s);
      if (missing !== null) return missing;
      const wantKind = text(args["kind"]);
      const needle = text(args["contains"]).toLocaleLowerCase();
      const all = requirements(s, deps);
      const matched = all.filter((item) =>
        (!wantKind || item.kind === wantKind) &&
        (!needle || `${item.ref}\n${item.statement}`.toLocaleLowerCase().includes(needle)));
      const selected = matched.slice(0, limitOf(args["limit"]));
      return {
        status: "AVAILABLE",
        total: all.length,
        matched: matched.length,
        returned: selected.length,
        truncated: selected.length < matched.length,
        items: selected.map(({ raw, ...item }) => ({
          ...item,
          title: raw["title"] ?? null,
          confirmation_status:
            item.kind === "requirement" ? raw["confirmation_status"] ?? item.status : null,
          priority: raw["priority"] ?? null,
          owner_role: raw["owner_role"] ?? null,
          acceptance_criteria: Array.isArray(raw["acceptance_criteria"])
            ? raw["acceptance_criteria"]
            : [],
          coverage_status: raw["status"] ?? null,
          rationale: raw["rationale"] ?? null,
        })),
      };
    },
  );

  reg.fn(
    {
      name: "requirements.trace",
      description:
        "按 requirements.query 返回的精确 ref，追踪它显式声明的证据、依赖、受阻产物、" +
        "流程/系统/数据对象引用和反向引用。不做名称相似度推断。",
      schema: {
        type: "object",
        required: ["requirement_ref"],
        properties: { requirement_ref: { type: "string", minLength: 1, maxLength: 240 } },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const missing = analysisMissing(s);
      if (missing !== null) return missing;
      const ref = text(args["requirement_ref"]);
      const req = requirements(s, deps).find((item) => item.ref === ref);
      if (req === undefined) {
        return {
          status: "NOT_FOUND",
          requirement_ref: ref,
          available_refs: requirements(s, deps).map((item) => item.ref).slice(0, 100),
          note: "只接受 requirements.query 返回的精确 ref；没有做模糊匹配。",
        };
      }
      const allRows = traceRows(s, deps);
      const outgoing = new Set([...req.evidence_ids, ...req.linked_ids]);
      const incoming = allRows.filter((row) => linkedValues(row.item).includes(ref));
      const resolved = allRows.filter((row) => outgoing.has(row.ref));
      const unresolved = [...outgoing].filter((id) =>
        !resolved.some((row) => row.ref === id) && !id.startsWith("EVID[") && !id.startsWith("WEB["));
      return {
        status: "AVAILABLE",
        requirement: {
          ref: req.ref,
          kind: req.kind,
          statement: req.statement,
          source_node: req.source_node,
          status: req.status,
          requirement_type: req.requirement_type ?? null,
          confirmation_status: req.raw["confirmation_status"] ?? req.status,
          acceptance_criteria: Array.isArray(req.raw["acceptance_criteria"])
            ? req.raw["acceptance_criteria"]
            : [],
        },
        evidence_ids: req.evidence_ids,
        outgoing_refs: [...outgoing],
        resolved_targets: resolved.map((row) => ({ ref: row.ref, node: row.node, collection: row.collection })),
        incoming_refs: incoming.map((row) => ({ ref: row.ref, node: row.node, collection: row.collection })),
        unresolved_refs: unresolved,
        trace_status:
          req.evidence_ids.length === 0 && req.linked_ids.length === 0 && incoming.length === 0
            ? "UNTRACED"
            : unresolved.length > 0 ? "PARTIAL" : "TRACED",
      };
    },
  );

  reg.fn(
    {
      name: "architecture.query",
      description:
        "优先查询 ARCHITECTURE 产物中的候选组件、fit-gap 处置、集成契约、风险与问题；" +
        "旧会话回退 ERP_MAP/PROCESS/DATA_OBJECTS。只返回显式字段，UNKNOWN 保持 UNKNOWN。",
      schema: {
        type: "object",
        properties: {
          component_id: { type: "string", maxLength: 160 },
          system_id: { type: "string", maxLength: 160 },
          requirement_id: { type: "string", maxLength: 160 },
          fit: { type: "string", enum: ["FIT", "PARTIAL_FIT", "GAP", "UNKNOWN"] },
          process_step_id: { type: "string", maxLength: 160 },
          disposition: { type: "string", maxLength: 80, description: "ARCHITECTURE fit-gap disposition" },
          implementation_kind: {
            type: "string",
            enum: ["STANDARD", "CONFIGURATION", "ENHANCEMENT", "CUSTOM", "EXTERNAL", "UNKNOWN"],
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const missing = analysisMissing(s);
      if (missing !== null) return missing;
      const nodes = analysisNodes(s);
      const architecture = record(nodes["ARCHITECTURE"]);
      if (Object.hasOwn(nodes, "ARCHITECTURE")) {
        const wantComponent = text(args["component_id"] ?? args["system_id"]);
        const wantRequirement = text(args["requirement_id"]);
        const wantFit = text(args["fit"]);
        const wantStep = text(args["process_step_id"]);
        const wantKind = text(args["disposition"] ?? args["implementation_kind"]);
        const cap = limitOf(args["limit"]);
        const components = rows(architecture["components"]).filter((item) =>
          (!wantComponent || text(item["id"]) === wantComponent || text(item["system_id"]) === wantComponent) &&
          (!wantRequirement || strings(item["requirement_ids"]).includes(wantRequirement)));
        const dispositions = rows(architecture["fit_gap_dispositions"]).filter((item) =>
          (!wantComponent || strings(item["component_ids"]).includes(wantComponent) || text(item["component_id"]) === wantComponent) &&
          (!wantRequirement || text(item["requirement_id"]) === wantRequirement) &&
          (!wantStep || text(item["process_step_id"]) === wantStep) &&
          (!wantFit || text(item["fit"]) === wantFit) &&
          (!wantKind || text(item["proposed_disposition"] ?? item["disposition"]) === wantKind));
        const contracts = rows(architecture["integration_contracts"]).filter((item) =>
          (!wantComponent || [
              text(item["component_id"]),
              text(item["producer_component_id"]),
              text(item["consumer_component_id"]),
            ].includes(wantComponent)) &&
          (!wantRequirement || strings(item["requirement_ids"]).includes(wantRequirement)));
        const risks = rows(architecture["risks"]);
        return {
          status: "AVAILABLE",
          source_node: "ARCHITECTURE",
          counts: {
            components: components.length,
            fit_gap_dispositions: dispositions.length,
            integration_contracts: contracts.length,
            risks: risks.length,
          },
          components: components.slice(0, cap),
          fit_gap_dispositions: dispositions.slice(0, cap),
          integration_contracts: contracts.slice(0, cap),
          risks: risks.slice(0, cap),
          questions: Array.isArray(architecture["questions"])
            ? (architecture["questions"] as unknown[]).slice(0, cap)
            : [],
          explicit_unknowns: [
            ...components.filter((item) =>
              !text(item["responsibility"]) || strings(item["evidence_ids"] ?? item["analysis_evidence_ids"]).length === 0)
              .map((item) => ({ kind: "component_detail_or_evidence", ref: item["id"] })),
            ...dispositions.filter((item) =>
              text(item["proposed_disposition"] ?? item["disposition"]) === "UNKNOWN" ||
              text(item["fit"]) === "UNKNOWN")
              .map((item) => ({ kind: "fit_gap_disposition", ref: item["id"] })),
            ...contracts.filter((item) => text(item["evidence_status"]) !== "EVIDENCED_CANDIDATE")
              .map((item) => ({ kind: "integration_evidence", ref: item["id"] })),
          ].slice(0, cap),
          boundary:
            "优先返回 ARCHITECTURE 节点的候选架构与 fit-gap 处置；DRAFT/UNKNOWN 不得说成已批准目标架构。",
        };
      }
      const erp = record(nodes["ERP_MAP"]);
      const data = record(nodes["DATA_OBJECTS"]);
      const process = record(nodes["PROCESS"]);
      const wantSystem = text(args["system_id"]);
      const wantStep = text(args["process_step_id"]);
      const wantKind = text(args["disposition"] ?? args["implementation_kind"]);
      const cap = limitOf(args["limit"]);
      const systems = rows(erp["landscape"]).filter((item) =>
        !wantSystem || text(item["system_id"]) === wantSystem);
      const mappings = rows(erp["mappings"]).filter((item) =>
        (!wantSystem || text(item["system_id"]) === wantSystem) &&
        (!wantStep || text(item["process_step_id"]) === wantStep) &&
        (!wantKind || text(item["implementation_kind"]) === wantKind));
      const dataObjects = rows(data["data_objects"]).filter((item) =>
        !wantSystem || text(item["system_of_record"]) === wantSystem);
      const mappedSteps = new Set(mappings.map((item) => text(item["process_step_id"])).filter(Boolean));
      const processSteps = rows(process["steps"]);
      return {
        source_node: "ERP_MAP_FALLBACK",
        status: Object.keys(erp).length > 0 || Object.keys(data).length > 0 ? "AVAILABLE" : "NOT_AVAILABLE",
        counts: {
          systems: systems.length,
          mappings: mappings.length,
          data_objects: dataObjects.length,
          process_steps: processSteps.length,
        },
        systems: systems.slice(0, cap),
        mappings: mappings.slice(0, cap),
        data_objects: dataObjects.slice(0, cap).map((item) => ({
          id: item["id"],
          name: item["name"],
          system_of_record: item["system_of_record"],
          owner_role: item["owner_role"],
          sensitivity: item["sensitivity"],
          evidence_ids: item["evidence_ids"],
        })),
        explicit_unknowns: [
          ...systems.filter((item) => ["product", "version", "module", "org_scope"]
            .some((key) => item[key] === null || item[key] === undefined || text(item[key]) === "UNKNOWN"))
            .map((item) => ({ kind: "system_detail", ref: item["system_id"] })),
          ...mappings.filter((item) => text(item["implementation_kind"]) === "UNKNOWN")
            .map((item) => ({ kind: "implementation_kind", ref: item["process_step_id"] })),
          ...processSteps.filter((item) => !mappedSteps.has(text(item["id"])))
            .map((item) => ({ kind: "unmapped_process_step", ref: item["id"] })),
        ].slice(0, cap),
        boundary: "这是一份 AS-IS 映射投影，不是目标架构建议；缺字段保持 UNKNOWN。",
      };
    },
  );

  reg.fn(
    {
      name: "acceptance.test.query",
      description:
        "优先查询 TEST_PLAN 已设计的验收用例、需求引用与准备状态；旧会话回退 RULES 用例。" +
        "这些都是测试设计，不是测试执行结果。",
      schema: {
        type: "object",
        properties: {
          test_case_id: { type: "string", maxLength: 160 },
          requirement_id: { type: "string", maxLength: 160 },
          rule_id: { type: "string", maxLength: 160 },
          kind: {
            type: "string",
            enum: [
              "POSITIVE", "BOUNDARY", "NEGATIVE", "EXCEPTION",
              "BUSINESS_SCENARIO", "BUSINESS_RULE", "INTEGRATION", "DATA_QUALITY",
              "AUTHORIZATION", "SOD", "REGRESSION",
            ],
          },
          status: { type: "string", enum: ["DRAFT", "READY_FOR_REVIEW", "BLOCKED"] },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const missing = analysisMissing(s);
      if (missing !== null) return missing;
      const nodes = analysisNodes(s);
      const testPlan = record(nodes["TEST_PLAN"]);
      if (Object.hasOwn(nodes, "TEST_PLAN")) {
        const wantId = text(args["test_case_id"]);
        const wantRequirement = text(args["requirement_id"]);
        const wantKind = text(args["kind"]);
        const wantStatus = text(args["status"]);
        const all = rows(testPlan["test_cases"]).filter((item) =>
          (!wantId || text(item["id"]) === wantId) &&
          (!wantRequirement || strings(item["requirement_ids"]).includes(wantRequirement)) &&
          (!wantKind || text(item["kind"]) === wantKind) &&
          (!wantStatus || text(item["status"]) === wantStatus));
        const selected = all.slice(0, limitOf(args["limit"])).map((item) => ({
          ...item,
          execution_status: "NOT_EXECUTED",
        }));
        return {
          status: "AVAILABLE",
          source_node: "TEST_PLAN",
          matched: all.length,
          returned: selected.length,
          truncated: selected.length < all.length,
          tests: selected,
          readiness: testPlan["readiness"] ?? {},
          coverage_gaps: rows(testPlan["coverage_gaps"]),
          boundary:
            "TEST_PLAN 只证明测试设计存在；即使 status=READY_FOR_REVIEW，也没有运行测试，execution_status 固定为 NOT_EXECUTED。",
        };
      }
      const wantRule = text(args["rule_id"]);
      const wantKind = text(args["kind"]);
      const all: Dict[] = [];
      for (const rule of ruleRows(s)) {
        const rid = text(rule["id"]);
        if (wantRule && rid !== wantRule) continue;
        rows(rule["test_cases"]).forEach((test, index) => {
          if (wantKind && text(test["kind"]) !== wantKind) return;
          all.push({
            test_ref: `${rid}#test[${index}]`,
            rule_id: rid,
            kind: test["kind"],
            given: test["given"],
            expected: test["expected"],
            rule_evidence_ids: rule["evidence_ids"],
            execution_status: "NOT_EXECUTED",
          });
        });
      }
      const selected = all.slice(0, limitOf(args["limit"]));
      return {
        status: "AVAILABLE",
        matched: all.length,
        returned: selected.length,
        truncated: selected.length < all.length,
        tests: selected,
        boundary: "NOT_EXECUTED 表示当前产物只含测试设计；本工具不会运行测试或伪造通过结果。",
      };
    },
  );

  reg.fn(
    {
      name: "acceptance.coverage",
      description:
        "优先统计 TEST_PLAN 的需求追溯、测试设计覆盖和 coverage gaps；旧会话回退规则用例。" +
        "不把设计覆盖率或 READY_FOR_REVIEW 冒充执行通过率。",
      schema: { type: "object", properties: {} },
      danger: Danger.READ,
      scopes: RO,
    },
    () => acceptanceCoverage(s),
  );

  reg.fn(
    {
      name: "signoff.package",
      description:
        "准备当前 revision 的人工签署审阅包：Review verdict、schema 校验、阻塞问题、" +
        "测试设计覆盖、已生成产物和待填写签署字段。只读，不记录签名或替人接受风险。",
      schema: { type: "object", properties: {} },
      danger: Danger.READ,
      scopes: RO,
    },
    async () => {
      const nodes = analysisNodes(s);
      const review = record(nodes["REVIEW"]);
      const workflowAcceptance = record(nodes["HUMAN_ACCEPTANCE"]);
      const execution = record(s.state["engagement_execution"]);
      const pendingHuman = record(execution["pendingHuman"]);
      const packageState = record(s.state["ontology_package"]);
      const questions = questionRows(s, deps);
      const blocking = questions.filter((item) =>
        (text(item["priority"]).toLowerCase().includes("blocking") ||
          strings(item["blockedArtifacts"] ?? item["blocked_artifacts"]).length > 0) &&
        !["answered", "cancelled"].includes(text(item["status"]).toLowerCase()));
      const decisions = await deps.getRepo().listDecisionsV1(s.id);
      const reviewVerdict = text(review["verdict"]) || "UNKNOWN";
      const validation = packageValidation(s);
      const revision = finiteInt(packageState["revision"] ?? s.state["artifact_revision"], 0);
      const knownBlocker = reviewVerdict === "BLOCKED" || validation === "FAIL" || blocking.length > 0;
      const unknown = reviewVerdict === "UNKNOWN" || validation === "UNKNOWN" || revision <= 0;
      const acceptanceSigned = workflowAcceptance["signed"] === true;
      const acceptanceDecision = text(workflowAcceptance["decision"]).toUpperCase();
      const acceptanceBound = workflowAcceptance["package_bound"] === true;
      const acceptanceReviewPassed = workflowAcceptance["review_passed"] === true;
      const accepted =
        acceptanceSigned && acceptanceDecision === "APPROVE" && acceptanceBound && acceptanceReviewPassed;
      const rejected = acceptanceSigned && acceptanceDecision === "REJECT";
      const readiness = accepted
        ? "HUMAN_ACCEPTED"
        : rejected ? "HUMAN_REJECTED"
          : knownBlocker ? "BLOCKED"
            : unknown ? "INCOMPLETE" : "READY_FOR_HUMAN_REVIEW";
      return {
        readiness,
        revision: revision > 0 ? revision : null,
        release_state: s.state["release_state"] ?? "UNKNOWN",
        checks: {
          professional_review: reviewVerdict,
          schema_validation: validation,
          blocking_questions: blocking.length === 0 ? "CLEAR" : "BLOCKED",
          artifact_revision: revision > 0 ? "PRESENT" : "MISSING",
          human_acceptance: accepted
            ? "APPROVED_AND_PACKAGE_BOUND"
            : rejected ? "REJECTED"
              : acceptanceSigned ? "SIGNED_BUT_NOT_RELEASABLE" : "PENDING",
        },
        blockers: rows(review["blockers"]),
        warnings: Array.isArray(review["warnings"]) ? review["warnings"] : [],
        blocking_questions: blocking.map((item) => ({
          id: item["id"], text: item["text"], owner: item["ownerUserId"],
        })),
        artifacts: Array.isArray(s.state["artifacts"]) ? s.state["artifacts"] : [],
        artifact_checks: rows(review["artifact_checks"]),
        acceptance: acceptanceCoverage(s),
        decision_ledger: {
          total: decisions.length,
          failed: decisions.filter((item) => text(item.metadata["status"]) === "failed").length,
        },
        human_signoff: Object.keys(workflowAcceptance).length > 0 ? {
          required: true,
          status: acceptanceSigned ? "RECORDED" : "INVALID_OR_INCOMPLETE",
          decision_id: workflowAcceptance["decision_id"] ?? null,
          reviewer: workflowAcceptance["actor"] ?? null,
          reviewer_role: workflowAcceptance["actor_role"] ?? null,
          decision: workflowAcceptance["decision"] ?? null,
          rationale: workflowAcceptance["rationale"] ?? "",
          accepted_risks: [],
          package_id: workflowAcceptance["package_id"] ?? null,
          revision: workflowAcceptance["revision"] ?? null,
          review_digest: workflowAcceptance["review_digest"] ?? null,
          package_bound: workflowAcceptance["package_bound"] ?? false,
          timestamp: workflowAcceptance["signed_at"] ?? null,
        } : {
          required: true,
          status: "NOT_RECORDED",
          reviewer: null,
          decision: null,
          accepted_risks: [],
          revision: revision > 0 ? revision : null,
          timestamp: null,
        },
        human_acceptance_request:
          text(pendingHuman["node"]) === "HUMAN_ACCEPTANCE" ? pendingHuman : null,
        boundary:
          "本工具只查询 workflow 的 HUMAN_ACCEPTANCE 或准备审阅包，不保存签名。" +
          "READY_FOR_HUMAN_REVIEW 不表示已签署；HUMAN_ACCEPTED 也只在已有签名与精确 package/review binding 全部成立时返回。",
      };
    },
  );
}
