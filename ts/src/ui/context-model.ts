/**
 * OntoCopilot 右侧「项目上下文」的数据适配层。
 *
 * 这里刻意没有 DOM、fetch 或全局状态依赖。新 `/context` 聚合接口与旧
 * `/state` 快照可以并存一段时间，组件只认本文导出的稳定 view model；服务端字段
 * 在迁移期间缺失、改名或混入异常值，也只会退回空值，不会把整个侧栏画崩。
 */

import {
  plainQuestionCopy,
  plainQuestionRole,
  plainQuestionSource,
  plainQuestionWhy,
  plainUserFacingCopy,
} from "../onto/plain_language.js";

export type ContextSection = "project" | "evidence" | "model" | "review" | "delivery" | "runtime";

export const CONTEXT_SECTIONS: readonly ContextSection[] = [
  "project", "evidence", "model", "review", "delivery", "runtime",
];

export const OLD_TAB_TO_SECTION: Readonly<Record<string, ContextSection>> = Object.freeze({
  mat: "evidence",
  ent: "model",
  flow: "model",
  cf: "review",
  q: "review",
  art: "delivery",
  think: "runtime",
});

/** 新 section 原样通过；未知值退回项目总览。 */
export function contextSectionForTab(tab: unknown): ContextSection {
  const key = cleanText(tab).toLocaleLowerCase();
  if ((CONTEXT_SECTIONS as readonly string[]).includes(key)) return key as ContextSection;
  return OLD_TAB_TO_SECTION[key] ?? "project";
}

export type ModelKind =
  | "object"
  | "property"
  | "link"
  | "action"
  | "rule"
  | "process"
  | "event"
  | "gateway"
  | "terminal"
  | "external";

export const MODEL_KINDS: readonly ModelKind[] = [
  "object", "property", "link", "action", "rule", "process", "event",
  "gateway", "terminal", "external",
];

export type ModelKindFilter = "all" | ModelKind;
export type RelationDirection = "in" | "out" | "related";
export type ReviewStatus = "open" | "assigned" | "blocked" | "answered" | "deferred" | "cancelled";
export type ReleaseState = "BLOCKED" | "DRAFT" | "RELEASED";

export interface ContextEvidenceRef {
  id: string;
  fileName: string;
  cite: string;
  locator: Record<string, unknown>;
  snippet: string;
  extractor: string;
  confidence: number | null;
  sourceIds: string[];
}

export interface ContextMaterial {
  id: string;
  name: string;
  status: string;
  kind: string;
  chunks: number;
  issue: string;
  evidenceCount: number;
  parsed: boolean;
}

export interface EvidenceViewModel {
  materials: ContextMaterial[];
  references: ContextEvidenceRef[];
  parsedCount: number;
  pendingCount: number;
  problemCount: number;
}

export interface ContextAttribute {
  key: string;
  label: string;
  value: string;
}

export interface ContextRelation {
  id: string;
  kind: ModelKind | "edge";
  label: string;
  targetId: string;
  targetName: string;
  direction: RelationDirection;
  meta: string;
}

export interface EntityPendingItem {
  id: string;
  type: "question" | "conflict" | "inference";
  title: string;
  status: string;
  priority: string;
}

export interface ModelEntity {
  id: string;
  kind: ModelKind;
  name: string;
  apiName: string;
  description: string;
  code: string;
  status: string;
  stage: string;
  confidence: number | null;
  grounded: boolean;
  aliases: string[];
  attributes: ContextAttribute[];
  relations: ContextRelation[];
  evidence: ContextEvidenceRef[];
  pending: EntityPendingItem[];
}

export type ModelKindCounts = Record<ModelKind, number>;

export interface ModelViewModel {
  revision: string;
  entities: ModelEntity[];
  counts: ModelKindCounts;
  groundedCount: number;
  inferredCount: number;
}

export interface ReviewOption {
  id: string;
  label: string;
  rationale: string;
}

export interface ContextQuestion {
  id: string;
  type: "question";
  title: string;
  status: ReviewStatus;
  priority: string;
  blocking: boolean;
  answer: string;
  owner: string;
  role: string;
  why: string;
  impact: string;
  source: string;
  code: string;
  appliesTo: string[];
  blockedArtifacts: string[];
  options: ReviewOption[];
  evidence: ContextEvidenceRef[];
  revision: string;
}

export interface ContextConflict {
  id: string;
  type: "conflict";
  title: string;
  kind: string;
  status: ReviewStatus;
  priority: string;
  blocking: boolean;
  handling: string;
  owner: string;
  subjects: string[];
  evidence: ContextEvidenceRef[];
  options: ReviewOption[];
}

export interface ContextInference {
  id: string;
  type: "inference";
  title: string;
  status: string;
  priority: string;
  blocking: false;
  reason: string;
  subjects: string[];
  evidence: ContextEvidenceRef[];
}

export type ContextReviewItem = ContextQuestion | ContextConflict | ContextInference;

export interface ReviewViewModel {
  questions: ContextQuestion[];
  conflicts: ContextConflict[];
  inferences: ContextInference[];
  items: ContextReviewItem[];
  nextIds: string[];
  openCount: number;
  answeredCount: number;
  blockerCount: number;
  inferredCount: number;
}

export interface DeliveryArtifact {
  id: string;
  name: string;
  format: string;
  kind: string;
  status: string;
  size: number | null;
  revision: string;
  downloadPath: string;
  blockedBy: string[];
}

export interface DeliveryViewModel {
  artifacts: DeliveryArtifact[];
  formats: string[];
  releaseState: ReleaseState;
  blockerCount: number;
  revision: string;
}

export interface ProjectCounts {
  materials: number;
  evidence: number;
  objects: number;
  properties: number;
  links: number;
  actions: number;
  rules: number;
  processes: number;
  events: number;
  questions: number;
  conflicts: number;
  blockers: number;
  artifacts: number;
}

export interface ProjectViewModel {
  id: string;
  title: string;
  status: string;
  mode: string;
  stage: string;
  revision: string;
  releaseState: ReleaseState;
  nextAction: string;
  counts: ProjectCounts;
}

export interface ContextViewModel {
  version: 1;
  project: ProjectViewModel;
  evidence: EvidenceViewModel;
  model: ModelViewModel;
  review: ReviewViewModel;
  delivery: DeliveryViewModel;
}

export interface ModelFilterOptions {
  query?: string;
  kind?: ModelKindFilter | string;
}

export interface ContextSearchResults {
  materials: ContextMaterial[];
  evidence: ContextEvidenceRef[];
  entities: ModelEntity[];
  review: ContextReviewItem[];
  artifacts: DeliveryArtifact[];
}

type Dict = Record<string, unknown>;

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Dict {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value instanceof Set) return [...value.values()];
  return [];
}

function firstRecord(...values: unknown[]): Dict {
  for (const value of values) if (isRecord(value)) return value;
  return {};
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    const rows = array(value);
    if (rows.length > 0 || Array.isArray(value) || value instanceof Map || value instanceof Set) return rows;
  }
  return [];
}

function unwrap(value: unknown): unknown {
  const row = record(value);
  return Object.prototype.hasOwnProperty.call(row, "value") ? row["value"] : value;
}

function cleanText(value: unknown): string {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") return String(raw);
  return "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function cleanNumber(value: unknown): number | null {
  const raw = unwrap(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const out = Number(raw);
  return Number.isFinite(out) ? out : null;
}

function count(value: unknown): number {
  return Math.max(0, Math.trunc(cleanNumber(value) ?? 0));
}

function bool(value: unknown, fallback = false): boolean {
  const raw = unwrap(value);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const key = raw.trim().toLocaleLowerCase();
    if (["true", "yes", "1", "grounded", "parsed", "ready"].includes(key)) return true;
    if (["false", "no", "0", "inferred", "unparsed"].includes(key)) return false;
  }
  return fallback;
}

function stringList(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  const values = Array.isArray(value) || value instanceof Set ? [...value as Iterable<unknown>] : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const text = cleanText(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function normalizedKey(value: unknown): string {
  return cleanText(value).toLocaleLowerCase();
}

function assertionConfidence(value: unknown): number | null {
  const row = record(value);
  return cleanNumber(row["confidence"]);
}

function assertionOrigin(value: unknown): string {
  return cleanText(record(value)["origin"]);
}

function slug(value: string): string {
  const out = value.trim().replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}._:#-]+/gu, "-");
  return out.replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 120) || "unknown";
}

function stableId(prefix: string, ...candidates: unknown[]): string {
  const text = candidates.map(cleanText).filter(Boolean).join("|");
  return `${prefix}:${slug(text || "unknown")}`;
}

function evidenceKey(ref: ContextEvidenceRef): string {
  return ref.cite || `${ref.fileName}|${JSON.stringify(ref.locator)}|${ref.snippet}` || ref.id;
}

function fileNameFromCite(cite: string): string {
  const at = cite.search(/[!#]/u);
  return at > 0 ? cite.slice(0, at) : "";
}

function normalizeEvidence(value: unknown, fallbackId: string, sourceId: string): ContextEvidenceRef | null {
  if (typeof value === "string" || typeof value === "number") {
    const cite = cleanText(value);
    if (!cite) return null;
    return {
      id: stableId("evidence", cite),
      fileName: fileNameFromCite(cite),
      cite,
      locator: {},
      snippet: "",
      extractor: "",
      confidence: null,
      sourceIds: sourceId ? [sourceId] : [],
    };
  }
  const row = record(value);
  if (Object.keys(row).length === 0) return null;
  const locator = record(row["locator"]);
  const cite = firstText(row["cite"], row["location"], row["ref"], row["uri"]);
  const fileName = firstText(row["fileName"], row["file_name"], row["file"], fileNameFromCite(cite));
  const snippet = firstText(row["snippet"], row["quote"], row["text"]);
  const rawId = firstText(row["id"], row["evidenceId"], row["evidence_id"]);
  if (!cite && !fileName && !snippet && !rawId) return null;
  return {
    id: rawId || stableId("evidence", cite, `${fileName}|${JSON.stringify(locator)}|${snippet}`, fallbackId),
    fileName,
    cite: cite || fileName,
    locator: { ...locator },
    snippet,
    extractor: firstText(row["extractor"], row["source"]),
    confidence: cleanNumber(row["confidence"]),
    sourceIds: [...new Set([...(sourceId ? [sourceId] : []),
      ...stringList(row["relatedIds"] ?? row["related_ids"] ?? row["sourceIds"] ?? row["source_ids"])])],
  };
}

function evidenceValues(value: unknown, depth = 0, seen = new Set<unknown>()): unknown[] {
  if (depth > 5 || value === null || value === undefined || seen.has(value)) return [];
  if (typeof value !== "object") return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => evidenceValues(item, depth + 1, seen));
  const row = record(value);
  const out: unknown[] = [];
  for (const key of ["evidence", "citations", "evidenceRefs", "evidence_refs"]) {
    out.push(...array(row[key]));
  }
  for (const [key, child] of Object.entries(row)) {
    if (["evidence", "citations", "evidenceRefs", "evidence_refs", "locator", "raw"].includes(key)) continue;
    if (isRecord(child) || Array.isArray(child)) out.push(...evidenceValues(child, depth + 1, seen));
  }
  return out;
}

function collectEvidence(value: unknown, sourceId: string): ContextEvidenceRef[] {
  const map = new Map<string, ContextEvidenceRef>();
  evidenceValues(value).forEach((raw, index) => {
    const ref = normalizeEvidence(raw, `${sourceId}:${index}`, sourceId);
    if (ref === null) return;
    const key = evidenceKey(ref);
    const old = map.get(key);
    if (old === undefined) map.set(key, ref);
    else if (sourceId && !old.sourceIds.includes(sourceId)) old.sourceIds.push(sourceId);
  });
  return [...map.values()];
}

function mergeEvidence(target: Map<string, ContextEvidenceRef>, refs: readonly ContextEvidenceRef[]): void {
  for (const ref of refs) {
    const key = evidenceKey(ref);
    const old = target.get(key);
    if (old === undefined) {
      target.set(key, { ...ref, locator: { ...ref.locator }, sourceIds: [...ref.sourceIds] });
      continue;
    }
    for (const id of ref.sourceIds) if (!old.sourceIds.includes(id)) old.sourceIds.push(id);
    if (!old.snippet && ref.snippet) old.snippet = ref.snippet;
    if (!old.fileName && ref.fileName) old.fileName = ref.fileName;
    if (old.confidence === null && ref.confidence !== null) old.confidence = ref.confidence;
  }
}

function attachEvidenceById(
  target: ContextEvidenceRef[],
  ids: unknown,
  refsById: ReadonlyMap<string, ContextEvidenceRef>,
  sourceId: string,
): void {
  for (const id of stringList(ids)) {
    const found = refsById.get(id);
    if (found === undefined) continue;
    const ref: ContextEvidenceRef = {
      ...found,
      locator: { ...found.locator },
      sourceIds: [...new Set([...found.sourceIds, ...(sourceId ? [sourceId] : [])])],
    };
    if (!target.some((item) => evidenceKey(item) === evidenceKey(ref))) target.push(ref);
  }
}

function optionsOf(value: unknown): ReviewOption[] {
  return array(value).map((item, index): ReviewOption => {
    if (!isRecord(item)) return { id: String(index), label: cleanText(item), rationale: "" };
    return {
      id: firstText(item["id"], String(index)),
      label: firstText(item["label"], item["value"], item["text"]),
      rationale: firstText(item["rationale"], item["reason"]),
    };
  }).filter((item) => item.label.length > 0);
}

function questionStatus(raw: Dict, answer: string): ReviewStatus {
  let status = firstText(raw["status"], raw["lifecycle"]).toLocaleLowerCase().replace(/^status\./u, "");
  const explicit = ["open", "assigned", "blocked", "answered", "deferred", "cancelled"].includes(status);
  if (!explicit && answer) status = "answered";
  else if (["confirmed", "resolved", "closed"].includes(status)) status = "answered";
  else if (["rejected", "canceled"].includes(status)) status = "cancelled";
  else if (!explicit) status = "open";
  return status as ReviewStatus;
}

function normalizeQuestion(rawValue: unknown, index: number): ContextQuestion {
  const raw = record(rawValue);
  const decision = firstRecord(raw["activeDecision"], raw["active_decision"], raw["decision"]);
  const answer = firstText(raw["answer"], decision["answer"]);
  const rawTitle = firstText(raw["text"], raw["title"], raw["question"], raw["q"], "（未命名问题）");
  const copy = plainQuestionCopy(rawTitle);
  const title = plainUserFacingCopy(copy.text) || "（未命名问题）";
  const id = firstText(raw["id"], raw["rid"], raw["questionId"], raw["question_id"], raw["conflictRid"], raw["conflict_rid"])
    || stableId("question", title, String(index));
  const impactN = count(raw["blastRadius"] ?? raw["blast_radius"] ?? raw["impactCount"] ?? raw["impact_count"]);
  const priority = firstText(raw["priority"], raw["severity"]).toLocaleLowerCase()
    || copy.priority
    || (bool(raw["blocking"]) || raw["reversible"] === false || impactN >= 10 ? "high" : "normal");
  const status = questionStatus(raw, answer);
  const blockedArtifacts = stringList(raw["blockedArtifacts"] ?? raw["blocked_artifacts"]);
  const applies = raw["appliesTo"] ?? raw["applies_to"] ?? raw["scopeRefs"] ?? raw["scope_refs"]
    ?? raw["subjects"] ?? raw["subjectIds"] ?? raw["subject_ids"] ?? raw["entityIds"] ?? raw["entity_ids"];
  return {
    id,
    type: "question",
    title,
    status,
    priority,
    blocking: ["open", "assigned", "blocked"].includes(status)
      && (bool(raw["blocking"]) || ["high", "blocking", "critical"].includes(priority) || blockedArtifacts.length > 0),
    answer,
    owner: firstText(raw["ownerUserId"], raw["owner_user_id"], raw["owner"]),
    role: plainQuestionRole(firstText(
      raw["audienceRole"], raw["audience_role"], raw["role"], raw["audience"], copy.audienceRole, raw["askedBy"],
    )),
    why: plainQuestionWhy(
      firstText(raw["why"], raw["rationale"], raw["group"], raw["reason"]),
      firstText(raw["audienceRole"], raw["audience_role"], raw["role"], copy.audienceRole),
    ),
    impact: plainUserFacingCopy(firstText(raw["impact"], raw["impactSummary"], impactN ? `涉及 ${impactN} 项` : "")),
    source: plainQuestionSource(firstText(raw["sourceKind"], raw["source_kind"], raw["source"], raw["askedBy"], "system")),
    code: firstText(raw["code"]),
    appliesTo: stringList(applies),
    blockedArtifacts,
    options: optionsOf(raw["options"]),
    evidence: collectEvidence(raw, id),
    revision: firstText(raw["revision"], raw["version"], raw["updatedAt"], raw["updated_at"]),
  };
}

function normalizeConflict(rawValue: unknown, index: number): ContextConflict {
  const raw = record(rawValue);
  const kind = firstText(raw["kind"], raw["type"], "conflict");
  const title = plainUserFacingCopy(firstText(raw["summary"], raw["title"], raw["text"], kind, "（未命名冲突）"));
  const id = firstText(raw["id"], raw["rid"], raw["conflictId"], raw["conflict_id"])
    || stableId("conflict", kind, title, String(index));
  const handling = firstText(raw["handling"], raw["resolution"], "ask_user").toLocaleLowerCase();
  const rawStatus = firstText(raw["status"]).toLocaleLowerCase();
  const status: ReviewStatus = ["resolved", "answered", "confirmed", "closed"].includes(rawStatus)
    ? "answered"
    : ["cancelled", "canceled", "rejected"].includes(rawStatus)
      ? "cancelled"
      : rawStatus === "deferred" ? "deferred" : rawStatus === "blocked" ? "blocked" : "open";
  const priority = firstText(raw["priority"], raw["severity"])
    || (["ask_user", "round_trip"].includes(handling) ? "high" : "normal");
  return {
    id,
    type: "conflict",
    title,
    kind,
    status,
    priority,
    blocking: status !== "answered" && status !== "cancelled" && ["ask_user", "round_trip"].includes(handling),
    handling,
    owner: firstText(raw["owner"]),
    subjects: stringList(raw["subjects"] ?? raw["subjectIds"] ?? raw["subject_ids"] ?? raw["appliesTo"] ?? raw["applies_to"]),
    evidence: collectEvidence(raw, id),
    options: optionsOf(raw["options"]),
  };
}

function normalizeInference(rawValue: unknown, index: number): ContextInference {
  const raw = record(rawValue);
  const rawId = firstText(raw["id"], raw["rid"], raw["subjectId"], raw["subject_id"]);
  const subjectIds = stringList(raw["subjectIds"] ?? raw["subject_ids"] ?? raw["subjects"] ?? rawId);
  const id = rawId.startsWith("inference:")
    ? rawId : `inference:${rawId || stableId("item", firstText(raw["label"], raw["title"]), String(index)).slice(5)}`;
  return {
    id,
    type: "inference",
    title: plainUserFacingCopy(firstText(raw["title"], raw["label"], raw["text"], "系统推断项")),
    status: firstText(raw["status"], "needs_review").toLocaleLowerCase(),
    priority: firstText(raw["priority"], "normal").toLocaleLowerCase(),
    blocking: false,
    reason: firstText(raw["reason"], "missing_evidence"),
    subjects: subjectIds,
    evidence: collectEvidence(raw, id),
  };
}

function reviewRows(root: Dict, context: Dict, state: Dict): {
  questionValues: unknown[];
  conflictValues: unknown[];
  inferenceValues: unknown[];
  nextValues: unknown[];
} {
  const review = firstRecord(context["review"], root["review"]);
  const backlog = firstRecord(review["questionBacklog"], review["question_backlog"], context["questionBacklog"], state["question_backlog"]);
  const questionValues = firstArray(
    review["questions"], backlog["questions"], context["questions"], root["questions"], state["questions"],
  );
  const conflictValues = firstArray(
    review["conflicts"], context["conflicts"], root["conflicts"], state["conflicts"], state["_conflicts"],
  );
  const queue = array(review["queue"]);
  const inferenceValues = [
    ...firstArray(review["inferences"], context["inferences"]),
    ...queue.filter((item) => firstText(record(item)["kind"], record(item)["type"]) === "inference"),
  ];
  const nextValues = firstArray(review["nextBatch"], review["next_batch"], context["nextBatch"], root["nextBatch"]);
  return { questionValues, conflictValues, inferenceValues, nextValues };
}

function dedupeQuestions(values: readonly unknown[]): ContextQuestion[] {
  const out: ContextQuestion[] = [];
  const byId = new Set<string>();
  const byTitle = new Set<string>();
  values.forEach((raw, index) => {
    const item = normalizeQuestion(raw, index);
    const title = normalizedKey(item.title);
    if (byId.has(item.id) || (title && byTitle.has(title))) return;
    byId.add(item.id);
    if (title) byTitle.add(title);
    out.push(item);
  });
  return out;
}

function dedupeConflicts(values: readonly unknown[]): ContextConflict[] {
  const out: ContextConflict[] = [];
  const seen = new Set<string>();
  values.forEach((raw, index) => {
    const item = normalizeConflict(raw, index);
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  });
  return out;
}

function dedupeInferences(values: readonly unknown[]): ContextInference[] {
  const out: ContextInference[] = [];
  const seen = new Set<string>();
  values.forEach((raw, index) => {
    const item = normalizeInference(raw, index);
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  });
  return out;
}

function attribute(key: string, label: string, value: unknown): ContextAttribute | null {
  const text = Array.isArray(unwrap(value)) ? stringList(unwrap(value)).join("、") : cleanText(value);
  return text ? { key, label, value: text } : null;
}

function attributes(rows: Array<ContextAttribute | null>): ContextAttribute[] {
  return rows.filter((row): row is ContextAttribute => row !== null);
}

const KIND_ALIASES: Readonly<Record<string, ModelKind>> = Object.freeze({
  object: "object", objects: "object", objecttype: "object", dataobject: "object", dataobjects: "object",
  property: "property", properties: "property", propertytype: "property", field: "property", fields: "property",
  link: "link", links: "link", linktype: "link", relation: "link", relations: "link",
  action: "action", actions: "action", actiontype: "action", task: "action",
  processstep: "action", processsteps: "action",
  rule: "rule", rules: "rule", businessrule: "rule",
  process: "process", processes: "process", workflow: "process", workflows: "process", stage: "process",
  event: "event", events: "event",
  gateway: "gateway", decision: "gateway",
  terminal: "terminal", end: "terminal",
  external: "external", system: "external",
});

export function normalizeModelKind(value: unknown): ModelKind | null {
  const key = normalizedKey(value).replace(/[\s_-]+/gu, "");
  return KIND_ALIASES[key] ?? null;
}

function baseEntity(raw: Dict, index: number, kind: ModelKind, prefix: string): ModelEntity {
  const data = record(raw["data"]);
  const apiName = firstText(raw["apiName"], raw["api_name"], raw["code"], raw["key"]);
  const name = firstText(
    raw["displayName"], raw["display_name"], raw["name"], raw["title"], raw["label"],
    kind === "rule" ? raw["statement"] : "", apiName, `${kind} ${index + 1}`,
  );
  const id = firstText(raw["id"], raw["rid"], raw["key"], raw["entityId"], raw["entity_id"])
    || stableId(prefix, apiName, name, String(index));
  const evidence = collectEvidence(raw, id);
  const explicitGrounded = raw["grounded"];
  return {
    id,
    kind,
    name,
    apiName,
    description: firstText(raw["description"], raw["definition"], raw["summary"]),
    code: firstText(raw["code"]),
    status: firstText(raw["status"], "candidate").toLocaleLowerCase(),
    stage: firstText(raw["stage"], raw["stageKey"], raw["stage_key"], data["stage"]),
    confidence: cleanNumber(raw["confidence"]) ?? assertionConfidence(raw["displayName"] ?? raw["label"] ?? raw["apiName"]),
    grounded: explicitGrounded === undefined
      ? evidence.length > 0 || assertionOrigin(raw["displayName"] ?? raw["label"] ?? raw["apiName"]) === "extracted"
      : bool(explicitGrounded),
    aliases: stringList(raw["aliases"] ?? data["aliases"]),
    attributes: [],
    relations: [],
    evidence,
    pending: [],
  };
}

interface EntityBuild {
  entity: ModelEntity;
  raw: Dict;
  origin: "oir" | "flow" | "direct";
}

function oirEntity(rawValue: unknown, index: number, kind: ModelKind): EntityBuild {
  const raw = record(rawValue);
  const entity = baseEntity(raw, index, kind, kind);
  if (kind === "object") {
    entity.attributes = attributes([
      attribute("primaryKey", "主键", raw["primaryKey"] ?? raw["primary_key"]),
      attribute("aliases", "别名", raw["aliases"]),
      attribute("owner", "负责人", raw["owner"]),
      attribute("properties", "属性", `${array(raw["properties"]).length}`),
    ]);
  } else if (kind === "property") {
    entity.attributes = attributes([
      attribute("baseType", "类型", raw["baseType"] ?? raw["base_type"]),
      attribute("definition", "口径", raw["definition"]),
      attribute("semanticType", "语义类型", raw["semanticType"] ?? raw["semantic_type"]),
      attribute("unit", "单位", raw["unit"]),
      attribute("required", "必填", unwrap(raw["required"]) === true ? "是" : unwrap(raw["required"]) === false ? "否" : ""),
      attribute("owner", "负责人", raw["owner"]),
    ]);
    if (!entity.description) entity.description = cleanText(raw["definition"]);
  } else if (kind === "link") {
    entity.attributes = attributes([
      attribute("cardinality", "基数", raw["cardinality"]),
      attribute("joinKey", "连接键", JSON.stringify(unwrap(raw["joinKey"] ?? raw["join_key"]) ?? "")),
    ]);
  } else if (kind === "action") {
    entity.attributes = attributes([
      attribute("appliesTo", "作用对象", raw["appliesTo"] ?? raw["applies_to"]),
      attribute("effects", "效果", raw["effects"]),
      attribute("endpoint", "端点", firstRecord(unwrap(raw["sourceEndpoint"] ?? raw["source_endpoint"]))["path"]),
    ]);
    if (!entity.description) entity.description = cleanText(raw["effects"]);
  } else if (kind === "rule") {
    entity.attributes = attributes([
      attribute("ruleKind", "规则类型", raw["ruleKind"] ?? raw["rule_kind"]),
      attribute("actor", "角色", raw["actor"]),
      attribute("appliesTo", "作用对象", raw["appliesTo"] ?? raw["applies_to"]),
    ]);
    if (!entity.description) entity.description = cleanText(raw["statement"]);
  }
  return { entity, raw, origin: "oir" };
}

function flowNodeEntity(rawValue: unknown, index: number): EntityBuild | null {
  const raw = record(rawValue);
  const kind = normalizeModelKind(raw["kind"]);
  if (kind === null || kind === "object" || kind === "property" || kind === "link" || kind === "rule") return null;
  const entity = baseEntity(raw, index, kind, "flow");
  entity.attributes = attributes([
    attribute("actor", "角色", raw["actor"]),
    attribute("objects", "业务对象", raw["objects"]),
    attribute("endpoint", "端点", raw["endpoint"]),
    attribute("stage", "阶段", raw["stage"]),
  ]);
  return { entity, raw, origin: "flow" };
}

function processEntity(rawValue: unknown, index: number, stageFallback: boolean): EntityBuild {
  const raw = record(rawValue);
  const entity = baseEntity(raw, index, "process", stageFallback ? "stage" : "workflow");
  entity.attributes = attributes([
    attribute("entry", "入口", raw["entry"]),
    attribute("exits", "出口", raw["exits"]),
    attribute("subtitle", "说明", raw["subtitle"]),
  ]);
  if (!entity.description) entity.description = firstText(raw["description"], raw["subtitle"]);
  return { entity, raw, origin: "flow" };
}

function directEntity(rawValue: unknown, index: number, impliedKind = ""): EntityBuild | null {
  const raw = record(rawValue);
  const kind = normalizeModelKind(raw["kind"] ?? raw["type"] ?? impliedKind);
  if (kind === null) return null;
  const entity = baseEntity(raw, index, kind, "entity");
  entity.attributes = array(raw["attributes"]).map((item, attrIndex) => {
    const row = record(item);
    const key = firstText(row["key"], String(attrIndex));
    return {
      key,
      label: firstText(row["label"], key),
      value: firstText(row["value"]),
    };
  }).filter((item) => item.value.length > 0);
  if (entity.attributes.length === 0) {
    entity.attributes = Object.entries(record(raw["data"])).map(([key, value]) => {
      let rendered = cleanText(value);
      if (!rendered && value !== null && value !== undefined) {
        try { rendered = JSON.stringify(value); } catch { rendered = ""; }
      }
      return { key, label: key, value: rendered };
    }).filter((item) => item.value.length > 0);
  }
  entity.pending = array(raw["pending"]).map((item, pendingIndex): EntityPendingItem => {
    const row = record(item);
    const rawType = firstText(row["type"], row["kind"]).toLocaleLowerCase();
    const type: EntityPendingItem["type"] = rawType === "conflict" || rawType === "inference"
      ? rawType : "question";
    const title = firstText(row["title"], row["text"], row["summary"], "待确认项");
    return {
      id: firstText(row["id"], row["rid"]) || stableId(type, title, String(pendingIndex)),
      type,
      title,
      status: firstText(row["status"], "open").toLocaleLowerCase(),
      priority: firstText(row["priority"], row["severity"], "normal").toLocaleLowerCase(),
    };
  });
  return { entity, raw, origin: "direct" };
}

function uniqueBuilds(rows: readonly EntityBuild[]): EntityBuild[] {
  const out: EntityBuild[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.entity.kind}:${row.entity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function entityBuilds(context: Dict, state: Dict): { builds: EntityBuild[]; flow: Dict; direct: boolean } {
  const model = firstRecord(context["model"]);
  const oir = firstRecord(model["oir"], context["oir"], state["oir"]);
  const flow = firstRecord(model["flow"], context["flow"], state["flow"]);
  const directValues = firstArray(model["entities"], model["items"], context["entities"], context["items"]);
  const builds: EntityBuild[] = [];

  if (directValues.length > 0) {
    directValues.forEach((raw, index) => {
      const row = directEntity(raw, index);
      if (row !== null) builds.push(row);
    });
  } else {
    const specs: ReadonlyArray<readonly [string, ModelKind]> = [
      ["objects", "object"], ["properties", "property"], ["links", "link"],
      ["actions", "action"], ["rules", "rule"],
    ];
    for (const [key, kind] of specs) {
      array(oir[key]).forEach((raw, index) => builds.push(oirEntity(raw, index, kind)));
    }
    const workflows = array(flow["workflows"]);
    const processRows = workflows.length > 0 ? workflows : array(flow["stages"]);
    processRows.forEach((raw, index) => builds.push(processEntity(raw, index, workflows.length === 0)));
    array(flow["nodes"]).forEach((raw, index) => {
      const row = flowNodeEntity(raw, index);
      if (row !== null) builds.push(row);
    });
  }

  // 聚合接口也可按类型分桶而不是给统一 entities。
  if (directValues.length === 0 && Object.keys(oir).length === 0 && Object.keys(flow).length === 0) {
    const buckets: ReadonlyArray<readonly [string, string]> = [
      ["objects", "object"], ["properties", "property"], ["links", "link"], ["actions", "action"],
      ["rules", "rule"], ["processes", "process"], ["workflows", "process"], ["events", "event"],
    ];
    for (const [key, kind] of buckets) {
      array(model[key]).forEach((raw, index) => {
        const row = directEntity(raw, index, kind);
        if (row !== null) builds.push(row);
      });
    }
  }
  return { builds: uniqueBuilds(builds), flow, direct: directValues.length > 0 };
}

function addRelation(entity: ModelEntity, relation: ContextRelation): void {
  const key = `${relation.id}|${relation.targetId}|${relation.direction}`;
  if (!entity.relations.some((item) => `${item.id}|${item.targetId}|${item.direction}` === key)) {
    entity.relations.push(relation);
  }
}

function entityReferenceIndex(builds: readonly EntityBuild[]): Map<string, EntityBuild> {
  const index = new Map<string, EntityBuild>();
  for (const build of builds) {
    for (const key of [build.entity.id, build.entity.apiName, build.entity.name, build.entity.code]) {
      const normalized = normalizedKey(key);
      if (normalized && !index.has(normalized)) index.set(normalized, build);
    }
  }
  return index;
}

function resolveEntity(index: Map<string, EntityBuild>, value: unknown): EntityBuild | undefined {
  return index.get(normalizedKey(value));
}

function relation(
  id: string,
  kind: ModelKind | "edge",
  label: string,
  target: ModelEntity,
  direction: RelationDirection,
  meta = "",
): ContextRelation {
  return { id, kind, label, targetId: target.id, targetName: target.name, direction, meta };
}

function attachDirectRelations(build: EntityBuild, index: Map<string, EntityBuild>): void {
  for (const [relIndex, rawValue] of firstArray(build.raw["relations"], build.raw["related"]).entries()) {
    const raw = record(rawValue);
    const target = resolveEntity(index, raw["targetId"] ?? raw["target_id"] ?? raw["target"] ?? raw["id"]);
    if (target === undefined) continue;
    const directionRaw = firstText(raw["direction"]);
    const direction: RelationDirection = directionRaw === "in" || directionRaw === "out" ? directionRaw : "related";
    const kind = normalizeModelKind(raw["kind"] ?? raw["type"]) ?? target.entity.kind;
    addRelation(build.entity, relation(
      firstText(raw["id"], `${build.entity.id}:relation:${relIndex}`),
      kind,
      firstText(raw["label"], raw["relationship"], target.entity.name),
      target.entity,
      direction,
      firstText(raw["meta"], raw["cardinality"], raw["relationship"]),
    ));
  }
}

function attachOirRelations(builds: readonly EntityBuild[], index: Map<string, EntityBuild>): void {
  for (const build of builds) {
    const { entity, raw } = build;
    if (build.origin === "direct") {
      attachDirectRelations(build, index);
      continue;
    }
    if (entity.kind === "object") {
      for (const ref of stringList(raw["properties"])) {
        const property = resolveEntity(index, ref);
        if (property === undefined || property.entity.kind !== "property") continue;
        addRelation(entity, relation(property.entity.id, "property", property.entity.name, property.entity, "out"));
        addRelation(property.entity, relation(`${property.entity.id}:parent`, "object", "所属对象", entity, "in"));
      }
    } else if (entity.kind === "property") {
      const parent = resolveEntity(index, raw["parent"]);
      if (parent !== undefined) {
        addRelation(entity, relation(`${entity.id}:parent`, "object", "所属对象", parent.entity, "in"));
        addRelation(parent.entity, relation(entity.id, "property", entity.name, entity, "out"));
      }
    } else if (entity.kind === "link") {
      const source = resolveEntity(index, raw["from"] ?? raw["source"]);
      const target = resolveEntity(index, raw["to"] ?? raw["target"]);
      const cardinality = cleanText(raw["cardinality"]);
      if (source !== undefined) addRelation(entity, relation(`${entity.id}:from`, "object", "起点", source.entity, "in", cardinality));
      if (target !== undefined) addRelation(entity, relation(`${entity.id}:to`, "object", "终点", target.entity, "out", cardinality));
      if (source !== undefined && target !== undefined) {
        addRelation(source.entity, relation(entity.id, "link", entity.name, target.entity, "out", cardinality));
        addRelation(target.entity, relation(entity.id, "link", entity.name, source.entity, "in", cardinality));
      }
    } else if (entity.kind === "action" || entity.kind === "rule") {
      for (const ref of stringList(raw["appliesTo"] ?? raw["applies_to"] ?? raw["objects"])) {
        const target = resolveEntity(index, ref);
        if (target === undefined) continue;
        addRelation(entity, relation(`${entity.id}:${target.entity.id}`, "object", "作用对象", target.entity, "related"));
        addRelation(target.entity, relation(entity.id, entity.kind, entity.name, entity, "related"));
      }
    } else if (["event", "gateway", "terminal", "external"].includes(entity.kind)) {
      for (const ref of stringList(raw["objects"])) {
        const target = resolveEntity(index, ref);
        if (target === undefined) continue;
        addRelation(entity, relation(`${entity.id}:${target.entity.id}`, "object", "业务对象", target.entity, "related"));
        addRelation(target.entity, relation(entity.id, entity.kind, entity.name, entity, "related"));
      }
    }
  }
}

function attachFlowRelations(builds: readonly EntityBuild[], flow: Dict, index: Map<string, EntityBuild>): void {
  for (const rawValue of array(flow["edges"])) {
    const raw = record(rawValue);
    const source = resolveEntity(index, raw["from"] ?? raw["source"]);
    const target = resolveEntity(index, raw["to"] ?? raw["target"]);
    if (source === undefined || target === undefined) continue;
    const id = firstText(raw["id"], raw["rid"], `${source.entity.id}:${target.entity.id}`);
    const label = firstText(raw["label"], "下一步");
    const meta = bool(raw["grounded"], array(raw["evidence"]).length > 0) ? "" : "推断关系";
    addRelation(source.entity, relation(id, "edge", label, target.entity, "out", meta));
    addRelation(target.entity, relation(id, "edge", label, source.entity, "in", meta));
  }
  for (const build of builds.filter((row) => row.entity.kind === "process")) {
    const refs = [build.raw["entry"], ...array(build.raw["exits"])];
    if (!firstText(build.raw["entry"]) && build.raw["key"] !== undefined) {
      for (const node of builds.filter((row) => row.entity.stage === cleanText(build.raw["key"]))) refs.push(node.entity.id);
    }
    for (const ref of refs) {
      const target = resolveEntity(index, ref);
      if (target === undefined || target.entity.id === build.entity.id) continue;
      addRelation(build.entity, relation(`${build.entity.id}:${target.entity.id}`, target.entity.kind, target.entity.name, target.entity, "related"));
      addRelation(target.entity, relation(`${build.entity.id}:${target.entity.id}`, "process", build.entity.name, build.entity, "related"));
      for (const objectRef of stringList(target.raw["objects"])) {
        const object = resolveEntity(index, objectRef);
        if (object === undefined || object.entity.kind !== "object") continue;
        addRelation(build.entity, relation(`${build.entity.id}:${object.entity.id}`, "object", object.entity.name, object.entity, "related"));
        addRelation(object.entity, relation(build.entity.id, "process", build.entity.name, build.entity, "related"));
      }
    }
  }
}

function pendingItem(item: ContextReviewItem): EntityPendingItem {
  return { id: item.id, type: item.type, title: item.title, status: item.status, priority: item.priority };
}

function addPending(entity: ModelEntity, item: EntityPendingItem): void {
  if (!entity.pending.some((row) => row.id === item.id && row.type === item.type)) entity.pending.push(item);
}

function attachReviewPending(
  builds: readonly EntityBuild[],
  questions: readonly ContextQuestion[],
  conflicts: readonly ContextConflict[],
  inferences: readonly ContextInference[],
  index: Map<string, EntityBuild>,
): void {
  for (const conflict of conflicts) {
    for (const subject of conflict.subjects) {
      const target = resolveEntity(index, subject);
      if (target !== undefined) addPending(target.entity, pendingItem(conflict));
    }
  }
  const conflictsById = new Map(conflicts.map((item) => [item.id, item]));
  const questionsById = new Map(questions.map((item) => [item.id, item]));
  const inferencesById = new Map(inferences.map((item) => [item.id, item]));
  for (const build of builds) {
    for (const conflictId of stringList(build.raw["conflicts"] ?? build.raw["conflictIds"] ?? build.raw["conflict_ids"])) {
      const conflict = conflictsById.get(conflictId);
      if (conflict !== undefined) addPending(build.entity, pendingItem(conflict));
    }
    for (const questionId of stringList(build.raw["questionIds"] ?? build.raw["question_ids"])) {
      const question = questionsById.get(questionId);
      if (question !== undefined) addPending(build.entity, pendingItem(question));
    }
  }
  for (const question of questions) {
    for (const ref of question.appliesTo) {
      const target = resolveEntity(index, ref);
      if (target !== undefined) addPending(target.entity, pendingItem(question));
    }
  }
  for (const inference of inferences) {
    for (const ref of inference.subjects) {
      const target = resolveEntity(index, ref);
      if (target !== undefined) addPending(target.entity, pendingItem(inference));
    }
  }
  for (const build of builds) {
    if (build.entity.grounded) continue;
    const id = `inference:${build.entity.id}`;
    const inference = inferencesById.get(id);
    addPending(build.entity, inference === undefined ? {
      id,
      type: "inference",
      title: "系统推断，缺少直接材料依据",
      status: "open",
      priority: "normal",
    } : pendingItem(inference));
  }
}

function emptyKindCounts(): ModelKindCounts {
  return {
    object: 0, property: 0, link: 0, action: 0, rule: 0, process: 0, event: 0,
    gateway: 0, terminal: 0, external: 0,
  };
}

function materialKind(name: string, explicit: string): string {
  if (explicit) return explicit.toLocaleLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()!.toLocaleLowerCase() : "";
  if (["xlsx", "xls", "csv", "tsv"].includes(ext)) return "spreadsheet";
  if (["doc", "docx", "md", "txt"].includes(ext)) return "document";
  if (ext === "pdf") return "pdf";
  if (["json", "yaml", "yml", "xml"].includes(ext)) return "structured";
  if (["sql", "ddl"].includes(ext)) return "schema";
  if (["bpmn", "mmd"].includes(ext)) return "process";
  return ext || "file";
}

function materialRows(root: Dict, context: Dict, state: Dict): unknown[] {
  const evidence = firstRecord(context["evidence"]);
  return firstArray(evidence["materials"], evidence["files"], context["filelist"], root["filelist"], state["filelist"]);
}

function normalizeMaterials(values: readonly unknown[], refs: readonly ContextEvidenceRef[]): ContextMaterial[] {
  const refCounts = new Map<string, number>();
  for (const ref of refs) if (ref.fileName) refCounts.set(ref.fileName, (refCounts.get(ref.fileName) ?? 0) + 1);
  const out: ContextMaterial[] = [];
  const seen = new Set<string>();
  values.forEach((rawValue, index) => {
    const raw = record(rawValue);
    const name = typeof rawValue === "string" ? rawValue : firstText(raw["name"], raw["fileName"], raw["file_name"], raw["title"]);
    if (!name || seen.has(name)) return;
    seen.add(name);
    const status = firstText(raw["status"], raw["state"], "unread").toLocaleLowerCase();
    out.push({
      id: firstText(raw["id"], raw["fileId"], raw["file_id"]) || stableId("material", name, String(index)),
      name,
      status,
      kind: materialKind(name, firstText(raw["kind"], raw["type"])),
      chunks: count(raw["chunks"] ?? raw["chunkCount"] ?? raw["chunk_count"]),
      issue: firstText(raw["issue"], raw["error"], raw["message"]),
      evidenceCount: count(raw["evidenceCount"] ?? raw["evidence_count"])
        || stringList(raw["evidenceIds"] ?? raw["evidence_ids"]).length || (refCounts.get(name) ?? 0),
      parsed: status === "parsed" || status === "ready" || bool(raw["parsed"]),
    });
  });
  return out;
}

function artifactKind(name: string, explicit: string): string {
  if (explicit) return explicit.toLocaleLowerCase();
  const key = name.toLocaleLowerCase();
  // 括起来是为了**不让源码里出现「斜杠 + bundle」那串字符**：
  // ui.contracts.workbench.test.ts 的 Bundle 下载门禁是源码级子串扫描，
  // 裸的正则字面量会被它当成一条真 href 误报，于是那道门禁长期挂红 ——
  // 挂久了就没人看了。加个非捕获组，行为完全不变。
  if (/(?:bundle|package|交付包)/u.test(key)) return "package";
  if (/ontology|oir|本体/u.test(key)) return "ontology";
  if (/flow|流程|diagram|\.svg$|\.png$/u.test(key)) return "diagram";
  if (/\.xlsx?$|\.csv$|\.tsv$/u.test(key)) return "spreadsheet";
  if (/\.pdf$|\.docx?$|\.md$/u.test(key)) return "document";
  if (/\.json$|\.ya?ml$|\.bpmn$|\.mmd$/u.test(key)) return "data";
  return "other";
}

function artifactRows(root: Dict, context: Dict, state: Dict): unknown[] {
  const delivery = firstRecord(context["delivery"]);
  return firstArray(delivery["artifacts"], delivery["files"], context["artifacts"], root["artifacts"], state["artifacts"]);
}

function normalizeArtifacts(
  values: readonly unknown[],
  questions: readonly ContextQuestion[],
): DeliveryArtifact[] {
  const out: DeliveryArtifact[] = [];
  const seen = new Set<string>();
  values.forEach((rawValue, index) => {
    const raw = record(rawValue);
    const name = typeof rawValue === "string" ? rawValue : firstText(raw["name"], raw["fileName"], raw["file_name"], raw["title"]);
    if (!name || seen.has(name)) return;
    seen.add(name);
    const format = firstText(raw["format"], name.includes(".") ? name.split(".").pop() : "").toLocaleLowerCase();
    const blockedBy = questions.filter((question) =>
      question.status !== "answered" && question.status !== "cancelled"
      && question.blockedArtifacts.some((item) => normalizedKey(item) === normalizedKey(name)),
    ).map((question) => question.id);
    out.push({
      id: firstText(raw["id"], raw["artifactId"], raw["artifact_id"]) || stableId("artifact", name, String(index)),
      name,
      format,
      kind: artifactKind(name, firstText(raw["kind"], raw["type"])),
      status: blockedBy.length > 0 ? "blocked" : firstText(raw["status"], "ready").toLocaleLowerCase(),
      size: cleanNumber(raw["size"] ?? raw["bytes"]),
      revision: firstText(raw["revision"], raw["version"]),
      downloadPath: firstText(raw["downloadPath"], raw["download_path"], raw["downloadUrl"], raw["download_url"], raw["url"], raw["href"]),
      blockedBy,
    });
  });
  return out;
}

function explicitRevision(root: Dict, context: Dict, state: Dict): string {
  const project = firstRecord(context["project"]);
  const model = firstRecord(context["model"]);
  const delivery = firstRecord(context["delivery"]);
  const ontologyPackage = firstRecord(state["ontology_package"], context["ontologyPackage"], context["ontology_package"]);
  const revision = firstRecord(state["revision"], context["revision"]);
  const projectRevision = firstRecord(project["revision"]);
  return firstText(
    projectRevision["label"], projectRevision["model"], project["revision"],
    model["revision"], delivery["revision"], ontologyPackage["revision"],
    state["artifact_revision"], root["state_version"], root["revision"], revision["id"], revision["revision"],
  );
}

function releaseStateOf(
  root: Dict,
  context: Dict,
  state: Dict,
  blockerCount: number,
  openCount: number,
  status: string,
): ReleaseState {
  if (blockerCount > 0) return "BLOCKED";
  const delivery = firstRecord(context["delivery"]);
  const raw = firstText(
    delivery["releaseState"], delivery["release_state"], context["releaseState"],
    state["release_state"], root["release_state"],
  ).toLocaleUpperCase();
  if (raw === "BLOCKED" || raw === "DRAFT" || raw === "RELEASED") {
    if (raw === "RELEASED" && openCount > 0) return "DRAFT";
    return raw;
  }
  if (openCount > 0) return "DRAFT";
  return ["done", "completed", "released"].includes(status.toLocaleLowerCase()) ? "RELEASED" : "DRAFT";
}

function nextActionOf(
  explicit: unknown,
  materials: readonly ContextMaterial[],
  review: ReviewViewModel,
  model: ModelViewModel,
  artifacts: readonly DeliveryArtifact[],
): string {
  const direct = cleanText(explicit);
  if (direct) return direct;
  const blocker = review.items.find((item) => item.blocking);
  if (blocker !== undefined) return `确认：${blocker.title}`;
  const problem = materials.find((item) => ["failed", "unsupported", "partial"].includes(item.status));
  if (problem !== undefined) return `处理材料：${problem.name}`;
  const pending = materials.find((item) => !item.parsed);
  if (pending !== undefined) return `等待材料解析：${pending.name}`;
  const open = review.questions.find((item) => ["open", "assigned", "blocked"].includes(item.status));
  if (open !== undefined) return `回答：${open.title}`;
  if (model.inferredCount > 0) return `确认 ${model.inferredCount} 个缺少直接依据的模型项`;
  if (model.entities.length > 0 && artifacts.length === 0) return "生成交付产物";
  return "当前没有待办";
}

/**
 * 把新聚合响应或旧会话快照收口成五个稳定视图。
 *
 * 支持的旧形态：`{id,title,filelist,state:{oir,flow,conflicts,artifacts,questions}}`。
 * 支持的新形态：顶层或 `context` 下的 `project/evidence/model/review/delivery`。
 */
export function buildContextViewModel(input: unknown): ContextViewModel {
  const root = record(input);
  const context = firstRecord(root["context"], root["data"], root);
  const projectSource = firstRecord(context["project"]);
  const session = firstRecord(context["session"], root["session"], projectSource["session"], root);
  const state = firstRecord(context["state"], root["state"], session["state"]);
  const { questionValues, conflictValues, inferenceValues, nextValues } = reviewRows(root, context, state);
  const oir = firstRecord(firstRecord(context["model"])["oir"], context["oir"], state["oir"]);
  const oirQuestions = array(oir["questions"]);
  const questions = dedupeQuestions([...questionValues, ...oirQuestions]);
  const conflicts = dedupeConflicts(conflictValues);
  const inferences = dedupeInferences(inferenceValues);

  const { builds, flow } = entityBuilds(context, state);
  const index = entityReferenceIndex(builds);
  attachOirRelations(builds, index);
  attachFlowRelations(builds, flow, index);

  const allEvidence = new Map<string, ContextEvidenceRef>();
  const explicitEvidence = firstRecord(context["evidence"]);
  firstArray(explicitEvidence["references"], explicitEvidence["records"], explicitEvidence["items"], context["references"]).forEach((raw, i) => {
    const ref = normalizeEvidence(raw, `context:${i}`, "");
    if (ref !== null) mergeEvidence(allEvidence, [ref]);
  });
  const evidenceById = new Map([...allEvidence.values()].map((ref) => [ref.id, ref]));
  for (const build of builds) {
    attachEvidenceById(build.entity.evidence, build.raw["evidenceIds"] ?? build.raw["evidence_ids"], evidenceById, build.entity.id);
  }
  const rawQuestions = new Map(questionValues.map((raw) => {
    const row = record(raw);
    return [firstText(row["id"], row["rid"], row["questionId"], row["question_id"]), row] as const;
  }));
  for (const question of questions) {
    const raw = rawQuestions.get(question.id) ?? {};
    attachEvidenceById(question.evidence, raw["evidenceIds"] ?? raw["evidence_ids"], evidenceById, question.id);
  }
  const rawConflicts = new Map(conflictValues.map((raw) => {
    const row = record(raw);
    return [firstText(row["id"], row["rid"], row["conflictId"], row["conflict_id"]), row] as const;
  }));
  for (const conflict of conflicts) {
    const raw = rawConflicts.get(conflict.id) ?? {};
    attachEvidenceById(conflict.evidence, raw["evidenceIds"] ?? raw["evidence_ids"], evidenceById, conflict.id);
  }
  inferenceValues.forEach((raw, rawIndex) => {
    const normalized = normalizeInference(raw, rawIndex);
    const inference = inferences.find((item) => item.id === normalized.id);
    if (inference !== undefined) {
      const row = record(raw);
      attachEvidenceById(inference.evidence, row["evidenceIds"] ?? row["evidence_ids"], evidenceById, inference.id);
    }
  });
  attachReviewPending(builds, questions, conflicts, inferences, index);
  for (const build of builds) mergeEvidence(allEvidence, build.entity.evidence);
  for (const question of questions) mergeEvidence(allEvidence, question.evidence);
  for (const conflict of conflicts) mergeEvidence(allEvidence, conflict.evidence);
  for (const inference of inferences) mergeEvidence(allEvidence, inference.evidence);
  for (const raw of array(flow["edges"])) mergeEvidence(allEvidence, collectEvidence(raw, firstText(record(raw)["rid"], record(raw)["id"], "flow-edge")));
  const references = [...allEvidence.values()];
  const materials = normalizeMaterials(materialRows(root, context, state), references);

  const counts = emptyKindCounts();
  for (const build of builds) counts[build.entity.kind] += 1;
  const modelSource = firstRecord(context["model"]);
  const reportedCounts = firstRecord(modelSource["counts"], modelSource["stats"], oir["stats"]);
  const countAliases: Readonly<Record<ModelKind, readonly string[]>> = {
    object: ["object", "objects"], property: ["property", "properties"], link: ["link", "links"],
    action: ["action", "actions"], rule: ["rule", "rules"], process: ["process", "processes", "workflows"],
    event: ["event", "events"], gateway: ["gateway", "gateways"], terminal: ["terminal", "terminals"],
    external: ["external", "externals"],
  };
  for (const kind of MODEL_KINDS) {
    if (counts[kind] > 0) continue;
    counts[kind] = count(countAliases[kind].map((key) => reportedCounts[key]).find((value) => value !== undefined));
  }
  const inferredCount = builds.filter((build) => !build.entity.grounded).length;
  const modelRevision = explicitRevision(root, context, state);
  const model: ModelViewModel = {
    revision: modelRevision,
    entities: builds.map((build) => build.entity),
    counts,
    groundedCount: builds.length - inferredCount,
    inferredCount,
  };

  const openItems = [...questions, ...conflicts, ...inferences].filter((item) =>
    item.status !== "answered" && item.status !== "cancelled" && item.status !== "deferred",
  );
  const blockerCount = openItems.filter((item) => item.blocking).length;
  const nextIds = nextValues.map((item) => {
    if (isRecord(item)) return firstText(item["id"], item["rid"], item["questionId"], item["question_id"]);
    return cleanText(item);
  }).filter(Boolean);
  const review: ReviewViewModel = {
    questions,
    conflicts,
    inferences,
    items: [...questions, ...conflicts, ...inferences],
    nextIds,
    openCount: openItems.length,
    answeredCount: questions.filter((item) => item.status === "answered").length
      + conflicts.filter((item) => item.status === "answered").length,
    blockerCount,
    inferredCount: inferences.length || inferredCount,
  };

  const artifacts = normalizeArtifacts(artifactRows(root, context, state), questions);
  const status = firstText(projectSource["status"], session["status"], root["status"], "idle");
  const releaseState = releaseStateOf(root, context, state, blockerCount, review.openCount, status);
  const deliverySource = firstRecord(context["delivery"]);
  const deliveryRevision = firstText(deliverySource["revision"], modelRevision);
  const delivery: DeliveryViewModel = {
    artifacts,
    formats: [...new Set([
      ...artifacts.map((item) => item.format),
      ...stringList(deliverySource["formats"]),
    ].filter(Boolean))].sort(),
    releaseState,
    blockerCount,
    revision: deliveryRevision,
  };

  const evidence: EvidenceViewModel = {
    materials,
    references,
    parsedCount: materials.filter((item) => item.parsed).length,
    pendingCount: materials.filter((item) => !item.parsed && !["failed", "unsupported"].includes(item.status)).length,
    problemCount: materials.filter((item) => ["failed", "unsupported", "partial"].includes(item.status)).length,
  };

  const projectCounts: ProjectCounts = {
    materials: materials.length,
    evidence: references.length,
    objects: counts.object,
    properties: counts.property,
    links: counts.link,
    actions: counts.action,
    rules: counts.rule,
    processes: counts.process,
    events: counts.event,
    questions: questions.length,
    conflicts: conflicts.length,
    blockers: blockerCount,
    artifacts: artifacts.length,
  };
  const project: ProjectViewModel = {
    id: firstText(projectSource["id"], session["id"], root["id"]),
    title: firstText(projectSource["title"], projectSource["name"], session["title"], root["title"], "未命名项目"),
    status,
    mode: firstText(projectSource["mode"], session["mode"], root["mode"], "work"),
    stage: firstText(projectSource["stage"], state["stage"], firstRecord(state["engagement"])["stage"]),
    revision: modelRevision,
    releaseState,
    nextAction: nextActionOf(
      firstText(firstRecord(projectSource["nextAction"], projectSource["next_action"])["label"],
        projectSource["nextAction"], projectSource["next_action"]),
      materials, review, model, artifacts,
    ),
    counts: projectCounts,
  };

  return { version: 1, project, evidence, model, review, delivery };
}

/** 按类型与全文查询筛模型。查询覆盖详情里的关系、证据与待确认项。 */
export function filterModelEntities(
  value: ModelViewModel | readonly ModelEntity[],
  options: ModelFilterOptions = {},
): ModelEntity[] {
  const entities: readonly ModelEntity[] = Array.isArray(value)
    ? value as readonly ModelEntity[]
    : (value as ModelViewModel).entities;
  const kind = options.kind === undefined || normalizedKey(options.kind) === "all"
    ? null : normalizeModelKind(options.kind);
  if (options.kind !== undefined && normalizedKey(options.kind) !== "all" && kind === null) return [];
  const query = normalizedKey(options.query);
  return entities.filter((entity) => {
    if (kind !== null && entity.kind !== kind) return false;
    if (!query) return true;
    const haystack = [
      entity.id, entity.kind, entity.name, entity.apiName, entity.description, entity.code, entity.status,
      entity.stage, ...entity.aliases,
      ...entity.attributes.flatMap((item) => [item.key, item.label, item.value]),
      ...entity.relations.flatMap((item) => [item.label, item.targetId, item.targetName, item.meta]),
      ...entity.evidence.flatMap((item) => [item.fileName, item.cite, item.snippet, item.extractor]),
      ...entity.pending.flatMap((item) => [item.title, item.status, item.priority]),
    ].join("\n").toLocaleLowerCase();
    return haystack.includes(query);
  });
}

/** 按 id / apiName / code 精确找详情；名称只作为最后一级精确兜底。 */
export function findModelEntity(
  value: ContextViewModel | ModelViewModel | readonly ModelEntity[],
  reference: unknown,
): ModelEntity | null {
  let entities: readonly ModelEntity[];
  if (Array.isArray(value)) entities = value as readonly ModelEntity[];
  else if ("model" in value && "project" in value) entities = (value as ContextViewModel).model.entities;
  else entities = (value as ModelViewModel).entities;
  const key = normalizedKey(reference);
  if (!key) return null;
  return entities.find((entity) =>
    [entity.id, entity.apiName, entity.code, entity.name].some((item) => normalizedKey(item) === key),
  ) ?? null;
}

/** 跨五个视图搜索，给全局搜索框使用。空查询返回所有行。 */
export function searchContext(view: ContextViewModel, query: unknown): ContextSearchResults {
  const key = normalizedKey(query);
  const matches = (...parts: unknown[]): boolean => !key || parts.map(cleanText).join("\n").toLocaleLowerCase().includes(key);
  return {
    materials: view.evidence.materials.filter((item) => matches(item.name, item.kind, item.status, item.issue)),
    evidence: view.evidence.references.filter((item) => matches(item.fileName, item.cite, item.snippet, item.extractor)),
    entities: filterModelEntities(view.model, { query: key }),
    review: view.review.items.filter((item) => {
      const extra = item.type === "question"
        ? [item.owner, item.role, item.why, item.impact, item.answer, item.source, item.code,
          ...item.appliesTo, ...item.options.flatMap((option) => [option.label, option.rationale])]
        : item.type === "conflict"
          ? [item.kind, item.handling, ...item.subjects]
          : [item.reason, ...item.subjects];
      return matches(item.id, item.title, item.status, item.priority, ...extra);
    }),
    artifacts: view.delivery.artifacts.filter((item) => matches(item.name, item.format, item.kind, item.status, item.revision)),
  };
}
