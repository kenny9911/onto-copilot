/**
 * FDE 右侧上下文浏览器的只读聚合接口。
 *
 * 这层不再把 `state.oir` / `state.flow` / `question_backlog` 原样扔给前端：
 * 原始投影适合持久化，却会迫使每个 UI 视图各自重新拼对象、证据、问题与产物。
 * 这里把同一 revision 的事实收拢成五个稳定域：项目、证据、模型、审阅、交付。
 *
 * 约束：
 * - 不调用模型，不触发编译，不写仓储；
 * - Question / Decision / Revision 从 repo 读取，避免多 worker 下展示旧投影；
 * - 所有下载链接都只指向已经存在的下载路由，不宣称尚未实现的格式转换。
 */

import type { Hono } from "hono";

import { sha256Hex } from "../../kernel/ids.js";
import { QuestionBacklog, QuestionStatus } from "../../onto/questions.js";
import {
  buildFdeReviewReadModel,
  type FdeReviewReadModel,
} from "../../review/fde-read-model.js";
import type { AppEnv } from "../app.js";
import { materialFileList, type MaterialFileView } from "../material_status.js";
import {
  currentRepo,
  refreshFilesProjection,
  sessAsync,
  type Session,
  type SessionBrief,
} from "../session.js";
import { decisionFromRow, questionBacklog, questionPayload } from "./questions.js";
import { draftOntologyArtifactViews, hasDraftOntologySource } from "./ontology-draft.js";

export const CONTEXT_SCHEMA_VERSION = "ontocopilot.context/1" as const;

export interface ContextEvidenceRecord {
  readonly id: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly cite: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly snippet: string;
  readonly extractor: string;
  readonly confidence: number | null;
  readonly sourceUrl: string;
  readonly relatedIds: string[];
}

export interface ContextRelation {
  readonly id: string;
  readonly kind: string;
  readonly relationship: string;
}

export interface ContextModelItem {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly apiName: string;
  readonly description: string;
  readonly status: string;
  readonly origin: string;
  readonly confidence: number | null;
  readonly grounded: boolean;
  readonly inferred: boolean;
  readonly evidenceIds: string[];
  readonly conflictIds: string[];
  readonly questionIds: string[];
  readonly related: ContextRelation[];
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ContextReviewQueueItem {
  readonly id: string;
  readonly kind: "question" | "conflict" | "inference";
  readonly title: string;
  readonly status: string;
  readonly priority: string;
  readonly blocking: boolean;
  readonly owner: string;
  readonly audience: string;
  readonly reason: string;
  readonly subjectIds: string[];
  readonly evidenceIds: string[];
}

export interface ContextReadModel {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly project: {
    readonly session: SessionBrief;
    readonly stage: string;
    readonly revision: {
      readonly label: string;
      readonly model: number;
      readonly review: number;
      readonly state: number;
    };
    readonly releaseState: string;
    readonly provenance: {
      readonly kind: "material" | "generic" | "mixed" | "ungrounded" | "none";
      readonly grounded: boolean;
      readonly draft: boolean;
    };
    readonly nextAction: {
      readonly kind: string;
      readonly label: string;
      readonly target: "project" | "evidence" | "model" | "review" | "delivery";
    };
    readonly activity: ReadonlyArray<Readonly<Record<string, unknown>>>;
  };
  readonly evidence: {
    readonly materials: ReadonlyArray<MaterialFileView & {
      readonly id: string;
      readonly sourceUrl: string;
      readonly evidenceIds: string[];
    }>;
    readonly records: ContextEvidenceRecord[];
    readonly counts: {
      readonly materials: number;
      readonly parsed: number;
      readonly attention: number;
      readonly records: number;
      readonly groundedMaterials: number;
    };
  };
  readonly model: {
    readonly revision: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly groups: Readonly<Record<string, string[]>>;
    readonly items: ContextModelItem[];
  };
  readonly review: {
    readonly revision: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly nextBatch: string[];
    /** FDE 访谈/建模视图；questions 仍是完整且可写回的权威 Question 投影。 */
    readonly workbench: FdeReviewReadModel;
    readonly questions: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly conflicts: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly inferences: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly queue: ContextReviewQueueItem[];
  };
  readonly delivery: {
    readonly revision: number;
    readonly releaseState: string;
    readonly blockedBy: string[];
    readonly artifacts: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly formats: string[];
    readonly bundle: {
      readonly available: boolean;
      readonly url: string;
    };
  };
}

type Dict = Record<string, unknown>;

const ACTIVE_QUESTION_STATUSES = new Set<string>([
  QuestionStatus.OPEN,
  QuestionStatus.ASSIGNED,
  QuestionStatus.BLOCKED,
]);
const TERMINAL_QUESTION_STATUSES = new Set<string>([
  QuestionStatus.ANSWERED,
  QuestionStatus.CANCELLED,
]);

/** 注册函数由 `serve.ts` 的装配层调用；本文件不自行改全局 app。 */
export function registerContextRoutes(app: Hono<AppEnv>): void {
  app.get("/api/sessions/:sid/context", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    // 与 `/state` 一样在读之前刷新材料投影，冷 worker 也能返回权威文件列表。
    await refreshFilesProjection(s);
    return c.json(await buildContextReadModel(s));
  });
}

/**
 * 从一个已 hydrate 的 Session 构建纯 JSON read model。
 *
 * 导出这个函数不是为了再造 service 层，而是让契约测试能直接钉住聚合语义；
 * route 本身只有 hydrate + refresh + json 三步。
 */
export async function buildContextReadModel(s: Session): Promise<ContextReadModel> {
  const repo = currentRepo();
  const [storedQuestions, storedDecisions, revisions] = await Promise.all([
    repo.listQuestions(s.id),
    repo.listDecisionsV1(s.id),
    repo.listRevisions(s.id),
  ]);

  // 只读地复现 questions route 的权威优先级，不调用 loadQuestionDomain（后者会回写
  // s.state 的 projection）。这样 GET /context 连内存态都不偷偷推进。
  const backlog =
    storedQuestions.length > 0
      ? QuestionBacklog.fromDict(storedQuestions.map((row) => row.doc))
      : questionBacklog(s);
  const decisions = storedDecisions
    .filter((row) => row.metadata["status"] !== "failed")
    .map((row) => decisionFromRow(row));
  const superseded = new Set(
    decisions.filter((decision) => decision.supersedes !== null).map((decision) =>
      String(decision.supersedes)),
  );
  const activeDecisions = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    if (!superseded.has(decision.id)) activeDecisions.set(decision.questionId, decision);
  }
  const questions = [...backlog.questions.values()].map((question) =>
    questionPayload(question, activeDecisions.get(question.id) ?? null),
  );
  const questionStats = backlog.stats();
  const nextBatch = backlog.nextBatch({ limit: 5 }).map((question) => question.id);

  const oir = asDict(s.state["oir"]);
  const flow = asDict(s.state["flow"]);
  const rawConflicts = asRows(s.state["conflicts"]).map(asDict);
  const registry = new EvidenceRegistry(s.id);
  const model = buildModel(oir, flow, rawConflicts, questions, registry);
  const review = buildReview(
    questions,
    questionStats,
    nextBatch,
    rawConflicts,
    model.items,
    registry,
  );

  const modelRevision = positiveInt(s.state["artifact_revision"]);
  const reviewRevision = revisions.reduce((max, row) => Math.max(max, row.ordinal), 0);
  const activeQuestions = questions.filter((question) =>
    ACTIVE_QUESTION_STATUSES.has(text(question["status"])),
  );
  const blockingQuestions = activeQuestions.filter(questionIsBlocking);
  const artifacts = artifactViews(s);
  // 虚拟 DRAFT JSON 可预览/下载，但不是 Release Gate 产物，绝不能据此开放 bundle
  // 或把项目阶段推进到 delivery/complete。
  const physicalArtifactCount = artifacts.filter((artifact) => artifact["virtual"] !== true).length;
  const storedReleaseState = text(s.state["release_state"]).toUpperCase();
  const releaseState =
    activeQuestions.length === 0 && storedReleaseState === "RELEASED" ? "RELEASED" : "DRAFT";

  const records = registry.values();
  const materials = materialFileList(s).map((material) => {
    const evidenceIds = records
      .filter((record) => record.fileName === material.name)
      .map((record) => record.id);
    return {
      ...material,
      id: `material:${sha256Hex(material.name).slice(0, 12)}`,
      sourceUrl: sourceUrl(s.id, material.name),
      evidenceIds,
    };
  });
  const formats = [...new Set(artifacts.map((artifact) => text(artifact["format"])).filter(Boolean))]
    .sort(compareCodePoint);
  const stage = projectStage(s, model.items.length, activeQuestions.length, physicalArtifactCount,
    releaseState);

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    project: {
      session: s.brief(),
      stage,
      revision: {
        label: modelRevision > 0 ? `r${modelRevision}` : "draft",
        model: modelRevision,
        review: reviewRevision,
        state: s.stateVersion,
      },
      releaseState,
      provenance: contextProvenance(s, flow, model.items),
      nextAction: nextAction(
        s,
        model.items.length,
        activeQuestions.length,
        blockingQuestions.length,
        physicalArtifactCount,
        releaseState,
      ),
      activity: [...revisions]
        .sort((a, b) => b.ordinal - a.ordinal)
        .slice(0, 8)
        .map((row) => ({
          id: row.id,
          revision: row.ordinal,
          kind: row.kind,
          status: row.status,
          actor: row.actor,
          created: row.created,
          changedIds: [...row.changed_ids],
          invalidatedArtifacts: [...row.invalidated_artifacts],
        })),
    },
    evidence: {
      materials,
      records,
      counts: {
        materials: materials.length,
        parsed: materials.filter((material) => material.state === "parsed").length,
        attention: materials.filter((material) =>
          material.state !== "parsed" && material.state !== "unread").length,
        records: records.length,
        groundedMaterials: new Set(records.map((record) => record.fileName).filter(Boolean)).size,
      },
    },
    model: {
      revision: modelRevision,
      counts: model.counts,
      groups: model.groups,
      items: model.items,
    },
    review: {
      revision: reviewRevision,
      counts: review.counts,
      nextBatch,
      workbench: buildFdeReviewReadModel(questions),
      questions,
      conflicts: review.conflicts,
      inferences: review.inferences,
      queue: review.queue,
    },
    delivery: {
      revision: modelRevision,
      releaseState,
      blockedBy: blockingQuestions.map((question) => text(question["id"])),
      artifacts,
      formats,
      bundle: {
        available: physicalArtifactCount > 0 && blockingQuestions.length === 0 &&
          releaseState === "RELEASED",
        url: `/api/sessions/${encodeURIComponent(s.id)}/bundle`,
      },
    },
  };
}

/**
 * Live graph 的来源契约。当前材料抽取图可以从 grounded/evidence 确定来源；将来无材料
 * 通用草案只需写 `flow.provenance="generic"`（或同名 state 字段），无需另造投影。
 */
export function contextProvenance(
  s: Session,
  flow: Readonly<Record<string, unknown>>,
  items: readonly ContextModelItem[],
): ContextReadModel["project"]["provenance"] {
  const explicit = text(
    flow["provenance"] ?? s.state["flow_provenance"] ?? s.state["provenance"],
  ).toLowerCase();
  const generic = explicit.includes("generic") || explicit.includes("sketch") ||
    explicit.includes("通用");
  if (generic) return { kind: "generic", grounded: false, draft: true };

  const graphItems = items.filter((item) => [
    "process", "process_step", "event", "gateway", "terminal", "external", "action",
  ].includes(item.type));
  if (graphItems.length === 0) return { kind: "none", grounded: false, draft: true };
  const grounded = graphItems.filter((item) => item.grounded).length;
  if (grounded === graphItems.length) return { kind: "material", grounded: true, draft: false };
  if (grounded === 0) return { kind: "ungrounded", grounded: false, draft: true };
  return { kind: "mixed", grounded: false, draft: true };
}

class EvidenceRegistry {
  private readonly rows = new Map<string, ContextEvidenceRecord>();

  constructor(private readonly sessionId: string) {}

  collect(raw: unknown, relatedId: string): string[] {
    const ids: string[] = [];
    const visited = new Set<object>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      if (visited.has(value)) return;
      visited.add(value);
      const row = value as Dict;
      if (looksLikeEvidence(row)) {
        const record = this.upsert(row);
        if (!record.relatedIds.includes(relatedId)) record.relatedIds.push(relatedId);
        if (!ids.includes(record.id)) ids.push(record.id);
        return;
      }
      for (const child of Object.values(row)) walk(child);
    };
    walk(raw);
    return ids;
  }

  values(): ContextEvidenceRecord[] {
    return [...this.rows.values()];
  }

  private upsert(raw: Dict): ContextEvidenceRecord {
    const fileId = text(raw["file_id"] ?? raw["fileId"]);
    const fileName = text(raw["file_name"] ?? raw["fileName"]);
    const locator = asDict(raw["locator"]);
    const snippet = text(raw["snippet"]);
    const cite = text(raw["cite"]) || fileName;
    const id = `ev_${sha256Hex(JSON.stringify([fileId, fileName, locator, snippet, cite])).slice(0, 16)}`;
    const current = this.rows.get(id);
    if (current !== undefined) return current;
    const confidence = finiteNumber(raw["confidence"]);
    const record: ContextEvidenceRecord = {
      id,
      fileId,
      fileName,
      cite,
      locator,
      snippet,
      extractor: text(raw["extractor"]),
      confidence,
      sourceUrl: fileName ? sourceUrl(this.sessionId, fileName) : "",
      relatedIds: [],
    };
    this.rows.set(id, record);
    return record;
  }
}

function buildModel(
  oir: Dict,
  flow: Dict,
  conflicts: readonly Dict[],
  questions: readonly Dict[],
  registry: EvidenceRegistry,
): { items: ContextModelItem[]; counts: Record<string, number>; groups: Record<string, string[]> } {
  const objects = asRows(oir["objects"]).map(asDict);
  const properties = asRows(oir["properties"]).map(asDict);
  const links = asRows(oir["links"]).map(asDict);
  const actions = asRows(oir["actions"]).map(asDict);
  const rules = asRows(oir["rules"]).map(asDict);
  const workflows = asRows(flow["workflows"]).map(asDict);
  const nodes = asRows(flow["nodes"]).map(asDict);
  const edges = asRows(flow["edges"]).map(asDict);
  const propertiesByParent = groupBy(properties, (property) => text(property["parent"]));
  const conflictsBySubject = groupByMany(conflicts, (conflict) => stringList(conflict["subjects"]));
  const questionsByScope = groupByMany(questions, (question) => stringList(question["scopeRefs"]));
  const nodesById = new Map(nodes.map((node) => [text(node["rid"]), node]));
  const workflowNodes = new Map(
    workflows.map((workflow) => [text(workflow["key"]), reachableWorkflowNodes(workflow, nodesById,
      edges)]),
  );
  const items: ContextModelItem[] = [];

  const add = (base: Omit<ContextModelItem, "evidenceIds" | "grounded" | "inferred"> & {
    readonly evidenceSource: unknown;
    readonly groundedHint?: boolean;
  }): void => {
    const evidenceIds = registry.collect(base.evidenceSource, base.id);
    const grounded = base.groundedHint ?? evidenceIds.length > 0;
    const inferred = base.origin === "inferred" || !grounded;
    items.push({
      id: base.id,
      type: base.type,
      label: base.label,
      apiName: base.apiName,
      description: base.description,
      status: base.status,
      origin: base.origin,
      confidence: base.confidence,
      grounded,
      inferred,
      evidenceIds,
      conflictIds: [...base.conflictIds],
      questionIds: [...base.questionIds],
      related: [...base.related],
      data: base.data,
    });
  };

  for (const object of objects) {
    const id = text(object["rid"]);
    const objectProperties = propertiesByParent.get(id) ?? [];
    const related: ContextRelation[] = [
      ...objectProperties.map((property) => relation(property, "property", "has_property")),
      ...links
        .filter((link) => text(link["from"]) === id || text(link["to"]) === id)
        .map((link) => relation(link, "link", text(link["from"]) === id ? "outgoing" : "incoming")),
      ...actions.filter((action) => stringList(action["appliesTo"]).includes(id))
        .map((action) => relation(action, "action", "applies_to")),
      ...rules.filter((rule) => stringList(rule["appliesTo"]).includes(id))
        .map((rule) => relation(rule, "rule", "constrains")),
    ];
    for (const workflow of workflows) {
      const key = text(workflow["key"]);
      const memberNodes = workflowNodes.get(key) ?? [];
      if (memberNodes.some((node) => stringList(node["objects"]).includes(id))) {
        related.push({ id: key, kind: "process", relationship: "participates_in" });
      }
    }
    const display = asDict(object["displayName"]);
    const apiName = valueText(object["apiName"]);
    add({
      id,
      type: "object",
      label: valueText(display) || apiName || id,
      apiName,
      description: valueText(object["description"]),
      status: text(object["status"]),
      origin: assertionOrigin(display),
      confidence: assertionConfidence(display),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related,
      data: {
        aliases: stringList(object["aliases"]),
        owner: nullableText(object["owner"]),
        primaryKey: stringList(valueOf(object["primaryKey"])),
        propertyIds: idsOf(objectProperties, "rid"),
      },
      evidenceSource: [object, ...objectProperties],
    });
  }

  for (const property of properties) {
    const id = text(property["rid"]);
    const display = asDict(property["displayName"]);
    add({
      id,
      type: "property",
      label: valueText(display) || valueText(property["apiName"]) || id,
      apiName: valueText(property["apiName"]),
      description: valueText(property["definition"]),
      status: text(property["status"]),
      origin: assertionOrigin(display),
      confidence: assertionConfidence(display),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related: [{ id: text(property["parent"]), kind: "object", relationship: "belongs_to" }],
      data: {
        parentId: text(property["parent"]),
        baseType: valueOf(property["baseType"]),
        semanticType: valueOf(property["semanticType"]),
        unit: valueOf(property["unit"]),
        required: valueOf(property["required"]),
        valueDomain: valueOf(property["valueDomain"]),
      },
      evidenceSource: property,
    });
  }

  for (const link of links) {
    const id = text(link["rid"]);
    const assertion = asDict(link["apiName"]);
    add({
      id,
      type: "link",
      label: valueText(assertion) || `${text(link["from"])} → ${text(link["to"])}`,
      apiName: valueText(assertion),
      description: "",
      status: text(link["status"]),
      origin: assertionOrigin(assertion),
      confidence: assertionConfidence(assertion),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related: [
        { id: text(link["from"]), kind: "object", relationship: "from" },
        { id: text(link["to"]), kind: "object", relationship: "to" },
      ],
      data: {
        from: text(link["from"]),
        to: text(link["to"]),
        cardinality: valueOf(link["cardinality"]),
        joinKey: valueOf(link["joinKey"]),
      },
      evidenceSource: link,
    });
  }

  for (const action of actions) {
    const id = text(action["rid"]);
    const assertion = asDict(action["apiName"]);
    const targets = stringList(action["appliesTo"]);
    add({
      id,
      type: "action",
      label: valueText(assertion) || id,
      apiName: valueText(assertion),
      description: stringList(valueOf(action["effects"])).join("；"),
      status: text(action["status"]),
      origin: assertionOrigin(assertion),
      confidence: assertionConfidence(assertion),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related: targets.map((target) => ({ id: target, kind: "object", relationship: "applies_to" })),
      data: {
        appliesTo: targets,
        parameters: valueOf(action["parameters"]),
        effects: valueOf(action["effects"]),
        sourceEndpoint: valueOf(action["sourceEndpoint"]),
      },
      evidenceSource: action,
    });
  }

  for (const rule of rules) {
    const id = text(rule["rid"]);
    const assertion = asDict(rule["statement"]);
    const targets = stringList(rule["appliesTo"]);
    add({
      id,
      type: "rule",
      label: valueText(assertion) || id,
      apiName: "",
      description: valueText(rule["actor"]),
      status: text(rule["status"]),
      origin: assertionOrigin(assertion),
      confidence: assertionConfidence(assertion),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related: targets.map((target) => ({ id: target, kind: "object", relationship: "constrains" })),
      data: {
        ruleKind: valueOf(rule["ruleKind"]),
        appliesTo: targets,
        actor: valueOf(rule["actor"]),
      },
      evidenceSource: rule,
    });
  }

  for (const workflow of workflows) {
    const id = text(workflow["key"]);
    const memberNodes = workflowNodes.get(id) ?? [];
    add({
      id,
      type: "process",
      label: text(workflow["title"]) || id,
      apiName: id,
      description: text(workflow["description"]),
      status: processStatus(memberNodes),
      origin: processOrigin(memberNodes),
      confidence: average(memberNodes.map((node) => assertionConfidence(asDict(node["label"])))),
      conflictIds: [],
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related: memberNodes.map((node) => ({
        id: text(node["rid"]),
        kind: nodeItemType(text(node["kind"])),
        relationship: "contains",
      })),
      data: {
        entry: text(workflow["entry"]),
        exits: stringList(workflow["exits"]),
        nodeIds: idsOf(memberNodes, "rid"),
      },
      evidenceSource: memberNodes,
    });
  }

  for (const node of nodes) {
    const id = text(node["rid"]);
    const assertion = asDict(node["label"]);
    const objectIds = stringList(node["objects"]);
    const related: ContextRelation[] = objectIds.map((objectId) => ({
      id: objectId,
      kind: "object",
      relationship: "uses",
    }));
    for (const workflow of workflows) {
      const key = text(workflow["key"]);
      if ((workflowNodes.get(key) ?? []).some((member) => text(member["rid"]) === id)) {
        related.push({ id: key, kind: "process", relationship: "belongs_to" });
      }
    }
    add({
      id,
      type: nodeItemType(text(node["kind"])),
      label: valueText(assertion) || text(node["code"]) || id,
      apiName: text(node["code"]),
      description: valueText(node["actor"]),
      status: text(node["status"]),
      origin: assertionOrigin(assertion),
      confidence: assertionConfidence(assertion),
      conflictIds: idsOf(conflictsBySubject.get(id) ?? [], "rid"),
      questionIds: idsOf(questionsByScope.get(id) ?? [], "id"),
      related,
      data: {
        nodeKind: text(node["kind"]),
        stage: text(node["stage"]),
        actor: valueOf(node["actor"]),
        objectIds,
        endpoint: text(node["endpoint"]),
      },
      evidenceSource: node,
      ...(typeof node["grounded"] === "boolean" ? { groundedHint: node["grounded"] } : {}),
    });
  }

  const groups: Record<string, string[]> = {
    all: items.map((item) => item.id),
    objects: items.filter((item) => item.type === "object").map((item) => item.id),
    properties: items.filter((item) => item.type === "property").map((item) => item.id),
    links: items.filter((item) => item.type === "link").map((item) => item.id),
    actions: items.filter((item) => item.type === "action").map((item) => item.id),
    rules: items.filter((item) => item.type === "rule").map((item) => item.id),
    processes: items.filter((item) => item.type === "process").map((item) => item.id),
    processSteps: items.filter((item) => item.type === "process_step").map((item) => item.id),
    events: items.filter((item) => item.type === "event").map((item) => item.id),
  };
  const counts: Record<string, number> = {
    total: items.length,
    objects: groups["objects"]?.length ?? 0,
    properties: groups["properties"]?.length ?? 0,
    links: groups["links"]?.length ?? 0,
    actions: groups["actions"]?.length ?? 0,
    rules: groups["rules"]?.length ?? 0,
    processes: groups["processes"]?.length ?? 0,
    processSteps: groups["processSteps"]?.length ?? 0,
    events: groups["events"]?.length ?? 0,
    inferred: items.filter((item) => item.inferred).length,
    grounded: items.filter((item) => item.grounded).length,
  };
  return { items, counts, groups };
}

function buildReview(
  questions: readonly Dict[],
  questionStats: Readonly<Record<string, number>>,
  nextBatch: readonly string[],
  rawConflicts: readonly Dict[],
  modelItems: readonly ContextModelItem[],
  registry: EvidenceRegistry,
): {
  counts: Record<string, number>;
  conflicts: Dict[];
  inferences: Dict[];
  queue: ContextReviewQueueItem[];
} {
  const terminalConflictIds = new Set(
    questions
      .filter((question) => TERMINAL_QUESTION_STATUSES.has(text(question["status"])))
      .filter((question) => text(question["sourceKind"]) === "conflict")
      .map((question) => text(question["sourceRef"])),
  );
  const conflicts = rawConflicts.map((raw) => {
    const id = text(raw["rid"]);
    return {
      id,
      kind: text(raw["kind"]),
      summary: text(raw["summary"]),
      status: terminalConflictIds.has(id) ? "resolved" : "open",
      handling: text(raw["handling"]),
      owner: nullableText(raw["owner"]),
      subjectIds: stringList(raw["subjects"]),
      evidenceIds: registry.collect(raw["evidence"], id),
      options: asRows(raw["options"]),
    };
  });
  const inferences = modelItems
    .filter((item) => item.inferred)
    .map((item) => ({
      id: item.id,
      kind: item.type,
      label: item.label,
      status: item.status,
      reason: item.evidenceIds.length === 0 ? "missing_evidence" : "inferred_origin",
      evidenceIds: [...item.evidenceIds],
    }));

  const queue: ContextReviewQueueItem[] = [];
  for (const question of questions) {
    const status = text(question["status"]);
    if (TERMINAL_QUESTION_STATUSES.has(status)) continue;
    queue.push({
      id: text(question["id"]),
      kind: "question",
      title: text(question["text"]),
      status,
      priority: text(question["priority"]) || "normal",
      blocking: questionIsBlocking(question),
      owner: text(question["ownerUserId"]),
      audience: text(question["audienceRole"]),
      reason: text(question["why"]),
      subjectIds: stringList(question["scopeRefs"]),
      evidenceIds: stringList(question["evidenceIds"]),
    });
  }
  for (const conflict of conflicts) {
    if (conflict["status"] !== "open") continue;
    queue.push({
      id: text(conflict["id"]),
      kind: "conflict",
      title: text(conflict["summary"]),
      status: "open",
      priority: "high",
      blocking: text(conflict["handling"]) === "ask_user",
      owner: text(conflict["owner"]),
      audience: "",
      reason: text(conflict["kind"]),
      subjectIds: stringList(conflict["subjectIds"]),
      evidenceIds: stringList(conflict["evidenceIds"]),
    });
  }
  for (const inference of inferences) {
    queue.push({
      id: `inference:${text(inference["id"])}`,
      kind: "inference",
      title: text(inference["label"]),
      status: "needs_review",
      priority: "normal",
      blocking: false,
      owner: "",
      audience: "",
      reason: text(inference["reason"]),
      subjectIds: [text(inference["id"])],
      evidenceIds: stringList(inference["evidenceIds"]),
    });
  }
  queue.sort((a, b) => {
    const aw = a.blocking ? 0 : a.kind === "question" ? 1 : a.kind === "conflict" ? 2 : 3;
    const bw = b.blocking ? 0 : b.kind === "question" ? 1 : b.kind === "conflict" ? 2 : 3;
    return aw - bw || compareCodePoint(a.id, b.id);
  });
  return {
    counts: {
      questions: questionStats["total"] ?? questions.length,
      openQuestions: questions.filter((question) =>
        !TERMINAL_QUESTION_STATUSES.has(text(question["status"]))).length,
      blockingQuestions: questions.filter((question) =>
        !TERMINAL_QUESTION_STATUSES.has(text(question["status"])) && questionIsBlocking(question))
        .length,
      conflicts: conflicts.length,
      openConflicts: conflicts.filter((conflict) => conflict["status"] === "open").length,
      inferences: inferences.length,
      queue: queue.length,
      nextBatch: nextBatch.length,
    },
    conflicts,
    inferences,
    queue,
  };
}

function artifactViews(s: Session): Dict[] {
  const physical = asRows(s.state["artifacts"])
    .map(text)
    .filter(Boolean)
    .sort(compareCodePoint)
    .map((name) => {
      const format = extensionOf(name);
      return {
        id: `artifact:${sha256Hex(name).slice(0, 12)}`,
        name,
        kind: artifactKind(name, format),
        format,
        previewable: ["md", "json", "svg", "png", "pdf", "csv", "xlsx"].includes(format),
        downloadUrl: `/api/sessions/${encodeURIComponent(s.id)}/artifacts/${encodeURIComponent(name)}`,
      };
    });
  if (!hasDraftOntologySource(s)) return physical;
  const physicalNames = new Set(physical.map((item) => text(item["name"])));
  return [
    ...physical,
    ...draftOntologyArtifactViews(s.id)
      .filter((item) => !physicalNames.has(item.name))
      .map((item) => ({ ...item })),
  ];
}

function projectStage(
  s: Session,
  modelItems: number,
  activeQuestions: number,
  artifacts: number,
  releaseState: string,
): string {
  if (s.files.length === 0) return "intake";
  if (["queued", "parsing", "extracting"].includes(s.status)) return "modeling";
  if (activeQuestions > 0 || s.status === "awaiting_answer") return "review";
  if (modelItems === 0) return "modeling";
  if (releaseState === "RELEASED") return "complete";
  if (artifacts > 0) return "delivery";
  return "modeling";
}

function nextAction(
  s: Session,
  modelItems: number,
  activeQuestions: number,
  blockers: number,
  artifacts: number,
  releaseState: string,
): ContextReadModel["project"]["nextAction"] {
  if (s.files.length === 0) {
    return { kind: "add_material", label: "添加业务材料", target: "evidence" };
  }
  if (["queued", "parsing", "extracting"].includes(s.status)) {
    return { kind: "monitor_modeling", label: "查看梳理进度", target: "project" };
  }
  if (blockers > 0) {
    return { kind: "resolve_blockers", label: `处理 ${blockers} 个阻塞问题`, target: "review" };
  }
  if (activeQuestions > 0) {
    return { kind: "answer_questions", label: `处理 ${activeQuestions} 个待确认项`, target: "review" };
  }
  if (modelItems === 0) {
    return { kind: "build_model", label: "开始业务建模", target: "model" };
  }
  if (artifacts === 0) {
    return { kind: "generate_delivery", label: "生成交付产物", target: "delivery" };
  }
  if (releaseState !== "RELEASED") {
    return { kind: "review_delivery", label: "检查并发布交付物", target: "delivery" };
  }
  return { kind: "ready", label: "交付已就绪", target: "delivery" };
}

function reachableWorkflowNodes(
  workflow: Dict,
  nodes: ReadonlyMap<string, Dict>,
  edges: readonly Dict[],
): Dict[] {
  const entry = text(workflow["entry"]);
  if (!entry || !nodes.has(entry)) return [];
  const exits = new Set(stringList(workflow["exits"]));
  const outgoing = groupBy(edges, (edge) => text(edge["from"]));
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (exits.has(current)) continue;
    for (const edge of outgoing.get(current) ?? []) {
      const target = text(edge["to"]);
      if (target && !visited.has(target)) queue.push(target);
    }
  }
  return [...visited].map((id) => nodes.get(id)).filter((node): node is Dict => node !== undefined);
}

function processStatus(nodes: readonly Dict[]): string {
  if (nodes.some((node) => text(node["status"]) === "candidate")) return "candidate";
  if (nodes.some((node) => text(node["status"]) === "proposed")) return "proposed";
  if (nodes.length > 0 && nodes.every((node) => text(node["status"]) === "confirmed")) {
    return "confirmed";
  }
  return "candidate";
}

function processOrigin(nodes: readonly Dict[]): string {
  const origins = nodes.map((node) => assertionOrigin(asDict(node["label"])));
  if (origins.includes("user")) return "user";
  if (origins.includes("extracted")) return "extracted";
  return "inferred";
}

function nodeItemType(kind: string): string {
  if (kind === "action") return "process_step";
  if (["event", "gateway", "terminal", "external"].includes(kind)) return kind;
  return "process_step";
}

function relation(row: Dict, kind: string, relationship: string): ContextRelation {
  return { id: text(row["rid"] ?? row["key"]), kind, relationship };
}

function questionIsBlocking(question: Dict): boolean {
  return text(question["priority"]) === "blocking" || stringList(question["blockedArtifacts"]).length > 0;
}

function artifactKind(name: string, format: string): string {
  const lower = name.toLowerCase();
  if (format === "zip") return "bundle";
  if (lower.includes("ontology") || lower.includes("package")) return "ontology";
  if (lower.includes("flow") || lower.includes("bpmn") || ["svg", "png"].includes(format)) {
    return "process";
  }
  if (lower.includes("问题") || lower.includes("question")) return "questions";
  if (["xlsx", "xls", "csv", "tsv"].includes(format)) return "spreadsheet";
  if (["md", "pdf", "doc", "docx"].includes(format)) return "document";
  if (format === "json") return "data";
  return "file";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
}

function sourceUrl(sessionId: string, fileName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/source?file=${encodeURIComponent(fileName)}`;
}

function looksLikeEvidence(row: Dict): boolean {
  return (
    "file_name" in row || "fileName" in row || "file_id" in row || "fileId" in row ||
    ("cite" in row && ("locator" in row || "snippet" in row))
  );
}

function valueOf(raw: unknown): unknown {
  const row = asDict(raw);
  return "value" in row ? row["value"] : raw;
}

function valueText(raw: unknown): string {
  return text(valueOf(raw));
}

function assertionOrigin(assertion: Dict): string {
  return text(assertion["origin"]);
}

function assertionConfidence(assertion: Dict): number | null {
  return finiteNumber(assertion["confidence"]);
}

function average(values: readonly (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 1000) / 1000;
}

function idsOf(rows: readonly Dict[], key: string): string[] {
  return rows.map((row) => text(row[key])).filter(Boolean);
}

function groupBy(rows: readonly Dict[], keyOf: (row: Dict) => string): Map<string, Dict[]> {
  const out = new Map<string, Dict[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const current = out.get(key) ?? [];
    current.push(row);
    out.set(key, current);
  }
  return out;
}

function groupByMany(
  rows: readonly Dict[],
  keysOf: (row: Dict) => readonly string[],
): Map<string, Dict[]> {
  const out = new Map<string, Dict[]>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const current = out.get(key) ?? [];
      current.push(row);
      out.set(key, current);
    }
  }
  return out;
}

function asDict(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Dict
    : {};
}

function asRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return asRows(value).map(text).filter(Boolean);
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value: unknown): number {
  const n = finiteNumber(value);
  return n === null ? 0 : Math.max(0, Math.trunc(n));
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
