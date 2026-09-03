/**
 * Canonical Ontology Package（产品契约）
 *
 * `canonical.ts` 是与 Python golden 对齐的 legacy 归一层，不能为了新 UI 契约直接
 * 改形状。本模块在它之上建立 `ontocopilot.ontology-package/1`：把 OIR / FlowGraph
 * 编译为 DataObject、Link、Action、Event、Workflow 与 Integration 的具体 JSON。
 *
 * 两条硬约束：
 * - 只从输入里的显式字段和显式流程边建立关系；不从名称猜角色、系统或数据库；
 * - 缺失信息一律写成 `unknown`，同时生成可追踪 gap + question，不用空串伪装完整。
 *
 * 这里产出的永远是 DRAFT snapshot。正式发布仍必须走 engagement REVIEW/EXPORT 与
 * `writeCanonicalArtifacts` 的 Release Gate；本模块没有写文件或推进 revision 的能力。
 */

import {
  ONTOLOGY_PACKAGE_JSON_SCHEMA as LEGACY_SCHEMA,
  PackageEvidenceIndex,
  buildPackage,
  canonicalId,
  pyJsonDumps,
  pyValue,
  type BuildPackageOptions,
  type PackageSource,
} from "./canonical.js";
import { sha256Hex } from "../kernel/ids.js";

export const ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION = "ontocopilot.ontology-package/1" as const;
export const ONTOLOGY_PACKAGE_V1_SCHEMA_ID =
  "https://schemas.ontocopilot.dev/ontology-package/1/schema.json" as const;
export const ONTOLOGY_PACKAGE_UNKNOWN = "unknown" as const;
export const ONTOLOGY_PACKAGE_RELEASE_STATE = "DRAFT" as const;

export type OntologyPackageUnknown = typeof ONTOLOGY_PACKAGE_UNKNOWN;
export type OntologyEntityStatus =
  | "candidate"
  | "proposed"
  | "confirmed"
  | "rejected"
  | "draft_from_api"
  | "unknown";
export type OntologyBindingKind = "role" | "system" | "platform" | "api" | "database";

export interface OntologyBinding {
  readonly kind: OntologyBindingKind;
  /**
   * `assumed` 与 `unknown` 是**两件不同的事**，以前被压成了一件：
   *   · `unknown`  —— 没人说过（该问业务方"请提供"）
   *   · `assumed`  —— 按行业通识先填的（该问"请确认"，答起来便宜得多）
   * 通用模板的全部价值就在 `assumed` 上；一律降级成 `unknown` 的话，
   * 通用模板与空模板在 schema 上没有任何区别。
   */
  readonly status: "known" | "partial" | "unknown" | "assumed" | "confirmed_none" | "not_applicable";
  readonly value: string;
  /** 精确到输入字段；unknown 不伪造来源。 */
  readonly source: string;
  readonly evidenceIds: readonly string[];
  readonly gapId: string | null;
  readonly questionId: string | null;
}

export interface OntologyApiBinding extends OntologyBinding {
  readonly kind: "api";
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
}

export interface OntologyDatabaseBinding extends OntologyBinding {
  readonly kind: "database";
  readonly database: string;
  readonly schema: string;
  readonly table: string;
}

export interface OntologyIntegrationBindings {
  readonly role: OntologyBinding;
  readonly system: OntologyBinding;
  readonly platform: OntologyBinding;
  readonly api: OntologyApiBinding;
  readonly database: OntologyDatabaseBinding;
}

export interface OntologyAttributeV1 {
  readonly id: string;
  readonly legacyId: string;
  readonly apiName: string;
  readonly displayName: string;
  readonly dataType: string;
  readonly definition: string;
  readonly required: boolean;
  readonly semanticType: string;
  readonly unit: string;
  readonly valueDomain: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface OntologyDataObjectV1 {
  readonly kind: "DataObject";
  readonly id: string;
  readonly legacyId: string;
  readonly apiName: string;
  readonly displayName: string;
  readonly description: string;
  readonly classification: string;
  readonly status: OntologyEntityStatus;
  readonly primaryKeyAttributeIds: readonly string[];
  readonly attributes: readonly OntologyAttributeV1[];
  readonly ownerRole: OntologyBinding;
  readonly systemOfRecord: OntologyBinding;
  readonly evidenceIds: readonly string[];
}

export interface OntologyJoinBindingV1 {
  readonly status: "known" | "unknown";
  readonly value: Readonly<Record<string, string>> | OntologyPackageUnknown;
  readonly evidenceIds: readonly string[];
  readonly gapId: string | null;
  readonly questionId: string | null;
}

export interface OntologyLinkV1 {
  readonly kind: "Link";
  readonly id: string;
  readonly legacyId: string;
  readonly apiName: string;
  readonly sourceDataObjectId: string;
  readonly targetDataObjectId: string;
  readonly cardinality: string;
  readonly join: OntologyJoinBindingV1;
  readonly status: OntologyEntityStatus;
  readonly evidenceIds: readonly string[];
}

export interface OntologyActionV1 {
  readonly kind: "Action";
  readonly id: string;
  readonly legacyId: string;
  readonly name: string;
  readonly status: OntologyEntityStatus;
  readonly relatedDataObjectIds: readonly string[];
  readonly parameters: readonly Readonly<Record<string, unknown>>[];
  readonly effects: readonly string[];
  readonly sourceProcessNodeIds: readonly string[];
  readonly emitsEventIds: readonly string[];
  readonly consumesEventIds: readonly string[];
  readonly bindings: OntologyIntegrationBindings;
  readonly evidenceIds: readonly string[];
}

export interface OntologyBoundParticipantV1 {
  readonly actionId: string;
  readonly bindings: OntologyIntegrationBindings;
}

export interface OntologyEventV1 {
  readonly kind: "Event";
  readonly id: string;
  readonly legacyId: string;
  readonly name: string;
  readonly status: OntologyEntityStatus;
  readonly payloadDataObjectIds: readonly string[];
  readonly sourceProcessNodeIds: readonly string[];
  readonly producerState: "known" | "unknown" | "confirmed_none" | "not_applicable";
  /** 所有显式 Action→Event 边；绝不 last-write-wins。 */
  readonly producers: readonly OntologyBoundParticipantV1[];
  /** 兼容旧消费者：等于 producers[0]，没有 publisher 时为 unknown participant。 */
  readonly producer: OntologyBoundParticipantV1;
  readonly consumerState: "known" | "unknown" | "confirmed_none" | "not_applicable";
  readonly consumers: readonly OntologyBoundParticipantV1[];
  readonly evidenceIds: readonly string[];
}

export interface OntologyProcessNodeV1 {
  readonly kind: "ProcessNode";
  readonly id: string;
  readonly legacyId: string;
  readonly nodeKind: string;
  readonly name: string;
  readonly code: string;
  readonly stageId: string;
  readonly semanticRef: string;
  readonly dataObjectIds: readonly string[];
  readonly actorRole: OntologyBinding;
  readonly evidenceIds: readonly string[];
}

export interface OntologyProcessEdgeV1 {
  readonly kind: "ProcessEdge";
  readonly id: string;
  readonly legacyId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeKind: string;
  readonly condition: string;
  readonly evidenceIds: readonly string[];
}

export interface OntologyWorkflowV1 {
  readonly kind: "Workflow";
  readonly id: string;
  readonly legacyId: string;
  readonly name: string;
  readonly description: string;
  readonly entryNodeId: string;
  readonly exitNodeIds: readonly string[];
  readonly nodeIds: readonly string[];
  readonly actionIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface OntologyRuleV1 {
  readonly kind: "Rule";
  readonly id: string;
  readonly legacyId: string;
  readonly statement: string;
  readonly ruleKind: string;
  readonly dataObjectIds: readonly string[];
  readonly actorRole: OntologyBinding;
  readonly status: OntologyEntityStatus;
  readonly evidenceIds: readonly string[];
}

export interface OntologyIntegrationV1 extends OntologyIntegrationBindings {
  readonly kind: "Integration";
  readonly id: string;
  readonly actionId: string;
  readonly evidenceIds: readonly string[];
}

export interface OntologyRoleV1 {
  readonly id: string;
  readonly name: string;
}

export interface OntologySystemV1 {
  readonly id: string;
  readonly name: string;
}

export interface OntologyEvidenceV1 {
  readonly id: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly snippet: string;
  readonly extractor: string;
  readonly confidence: number;
  readonly cite: string;
}

export interface OntologyGapV1 {
  readonly id: string;
  readonly code: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly field: string;
  readonly message: string;
  readonly status: "open" | "resolved" | "confirmed_none" | "not_applicable";
  readonly questionId: string;
  readonly resolutionValue: unknown;
  readonly sourceDecisionId: string | null;
}

export interface OntologyQuestionV1 {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly origin: "source" | "generated_gap";
  readonly targetEntityType: string;
  readonly targetEntityId: string;
  readonly targetField: string;
  readonly ownerRoleId: string;
  readonly evidenceIds: readonly string[];
  readonly gapId: string | null;
  readonly resolutionValue: unknown;
  readonly sourceDecisionId: string | null;
}

export interface OntologyPackageValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface OntologyPackageValidation {
  readonly status: "valid" | "valid_with_gaps" | "invalid";
  readonly schemaVersion: typeof ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION;
  readonly legacyCanonicalPassed: boolean;
  readonly errors: readonly OntologyPackageValidationIssue[];
  readonly warnings: readonly OntologyPackageValidationIssue[];
  readonly gapCount: number;
  readonly openGapCount: number;
  readonly resolvedGapCount: number;
}

export interface OntologyPackageV1 {
  readonly $schema: typeof ONTOLOGY_PACKAGE_V1_SCHEMA_ID;
  readonly schemaVersion: typeof ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION;
  readonly packageId: string;
  readonly revision: number;
  readonly baseRevision: number | null;
  readonly generatedAt: string;
  readonly releaseState: typeof ONTOLOGY_PACKAGE_RELEASE_STATE;
  readonly publishable: false;
  readonly source: {
    readonly oir: boolean;
    readonly flow: boolean;
    readonly legacySchemaId: string;
    /**
     * **渐进式契约。** 一份 assumed 都没有时仍然是 `missing_is_unknown` ——
     * 与从前逐字节相同，已经在消费 v1 的下游不受任何影响。只有真的带了通用假设
     * 的包才升成 `generic_assumed`，而那种包以前根本产不出来（通用模板一律
     * 落成 unknown），**不存在"老包突然变形"的情况**。
     */
    readonly assumptionPolicy: "missing_is_unknown" | "generic_assumed";
  };
  readonly dataObjects: readonly OntologyDataObjectV1[];
  readonly links: readonly OntologyLinkV1[];
  readonly actions: readonly OntologyActionV1[];
  readonly events: readonly OntologyEventV1[];
  readonly processNodes: readonly OntologyProcessNodeV1[];
  readonly processEdges: readonly OntologyProcessEdgeV1[];
  readonly workflows: readonly OntologyWorkflowV1[];
  readonly rules: readonly OntologyRuleV1[];
  readonly integrations: readonly OntologyIntegrationV1[];
  readonly roles: readonly OntologyRoleV1[];
  readonly systems: readonly OntologySystemV1[];
  readonly questions: readonly OntologyQuestionV1[];
  readonly gaps: readonly OntologyGapV1[];
  readonly evidence: readonly OntologyEvidenceV1[];
  readonly validation: OntologyPackageValidation;
}

export interface CompileOntologyPackageV1Options extends BuildPackageOptions {
  /** `buildPackage` 的 backlog/questions 原样透传。 */
  readonly sessionId?: string;
}

type Dict = Record<string, unknown>;

const stringSchema = { type: "string" } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;
const bindingRequired = [
  "kind", "status", "value", "source", "evidenceIds", "gapId", "questionId",
] as const;
const bindingProperties = {
  kind: { enum: ["role", "system", "platform", "api", "database"] },
  status: { enum: ["known", "partial", "unknown", "assumed", "confirmed_none", "not_applicable"] },
  value: stringSchema,
  source: stringSchema,
  evidenceIds: stringArraySchema,
  gapId: { type: ["string", "null"] },
  questionId: { type: ["string", "null"] },
} as const;
const entityStatusSchema = {
  enum: ["candidate", "proposed", "confirmed", "rejected", "draft_from_api", "unknown"],
} as const;

/**
 * 与导出的 TypeScript 类型一一对应的 JSON Schema。和 legacy schema 的
 * `items: {type:"object"}` 不同，这里会校验每个核心实体和交叉引用字段的具体形状。
 */
export const ONTOLOGY_PACKAGE_V1_JSON_SCHEMA: Readonly<Dict> = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: ONTOLOGY_PACKAGE_V1_SCHEMA_ID,
  title: "OntoCopilot Canonical Ontology Package v1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema", "schemaVersion", "packageId", "revision", "baseRevision", "generatedAt",
    "releaseState", "publishable", "source", "dataObjects", "links", "actions", "events",
    "processNodes", "processEdges", "workflows", "rules", "integrations", "roles", "systems", "questions", "gaps",
    "evidence", "validation",
  ],
  properties: {
    $schema: { const: ONTOLOGY_PACKAGE_V1_SCHEMA_ID },
    schemaVersion: { const: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION },
    packageId: { type: "string", minLength: 1 },
    revision: { type: "integer", minimum: 1 },
    baseRevision: { type: ["integer", "null"], minimum: 1 },
    generatedAt: { type: "string", format: "date-time" },
    releaseState: { const: ONTOLOGY_PACKAGE_RELEASE_STATE },
    publishable: { const: false },
    source: {
      type: "object", additionalProperties: false,
      required: ["oir", "flow", "legacySchemaId", "assumptionPolicy"],
      properties: {
        oir: { type: "boolean" }, flow: { type: "boolean" }, legacySchemaId: stringSchema,
        assumptionPolicy: { enum: ["missing_is_unknown", "generic_assumed"] },
      },
    },
    dataObjects: { type: "array", items: { $ref: "#/$defs/dataObject" } },
    links: { type: "array", items: { $ref: "#/$defs/link" } },
    actions: { type: "array", items: { $ref: "#/$defs/action" } },
    events: { type: "array", items: { $ref: "#/$defs/event" } },
    processNodes: { type: "array", items: { $ref: "#/$defs/processNode" } },
    processEdges: { type: "array", items: { $ref: "#/$defs/processEdge" } },
    workflows: { type: "array", items: { $ref: "#/$defs/workflow" } },
    rules: { type: "array", items: { $ref: "#/$defs/rule" } },
    integrations: { type: "array", items: { $ref: "#/$defs/integration" } },
    roles: { type: "array", items: { $ref: "#/$defs/named" } },
    systems: { type: "array", items: { $ref: "#/$defs/named" } },
    questions: { type: "array", items: { $ref: "#/$defs/question" } },
    gaps: { type: "array", items: { $ref: "#/$defs/gap" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    validation: { $ref: "#/$defs/validation" },
  },
  $defs: {
    jsonValue: {
      oneOf: [
        { type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string" },
        { type: "array", items: { $ref: "#/$defs/jsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/jsonValue" } },
      ],
    },
    binding: {
      type: "object", additionalProperties: false, required: bindingRequired,
      properties: bindingProperties,
    },
    roleBinding: {
      type: "object", additionalProperties: false, required: bindingRequired,
      properties: { ...bindingProperties, kind: { const: "role" } },
    },
    systemBinding: {
      type: "object", additionalProperties: false, required: bindingRequired,
      properties: { ...bindingProperties, kind: { const: "system" } },
    },
    platformBinding: {
      type: "object", additionalProperties: false, required: bindingRequired,
      properties: { ...bindingProperties, kind: { const: "platform" } },
    },
    apiBinding: {
      type: "object", additionalProperties: false,
      required: [...bindingRequired, "method", "path", "operationId"],
      properties: {
        ...bindingProperties,
        kind: { const: "api" },
        method: stringSchema, path: stringSchema, operationId: stringSchema,
      },
    },
    databaseBinding: {
      type: "object", additionalProperties: false,
      required: [...bindingRequired, "database", "schema", "table"],
      properties: {
        ...bindingProperties,
        kind: { const: "database" },
        database: stringSchema, schema: stringSchema, table: stringSchema,
      },
    },
    bindings: {
      type: "object", additionalProperties: false,
      required: ["role", "system", "platform", "api", "database"],
      properties: {
        role: { $ref: "#/$defs/roleBinding" }, system: { $ref: "#/$defs/systemBinding" },
        platform: { $ref: "#/$defs/platformBinding" }, api: { $ref: "#/$defs/apiBinding" },
        database: { $ref: "#/$defs/databaseBinding" },
      },
    },
    attribute: {
      type: "object", additionalProperties: false,
      required: ["id", "legacyId", "apiName", "displayName", "dataType", "definition",
        "required", "semanticType", "unit", "valueDomain", "evidenceIds"],
      properties: {
        id: stringSchema, legacyId: stringSchema, apiName: stringSchema,
        displayName: stringSchema, dataType: stringSchema, definition: stringSchema,
        required: { type: "boolean" }, semanticType: stringSchema, unit: stringSchema,
        valueDomain: stringArraySchema, evidenceIds: stringArraySchema,
      },
    },
    dataObject: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "apiName", "displayName", "description",
        "classification", "status", "primaryKeyAttributeIds", "attributes", "ownerRole",
        "systemOfRecord", "evidenceIds"],
      properties: {
        kind: { const: "DataObject" }, id: stringSchema, legacyId: stringSchema,
        apiName: stringSchema, displayName: stringSchema, description: stringSchema,
        classification: stringSchema, status: entityStatusSchema,
        primaryKeyAttributeIds: stringArraySchema,
        attributes: { type: "array", items: { $ref: "#/$defs/attribute" } },
        ownerRole: { $ref: "#/$defs/roleBinding" },
        systemOfRecord: { $ref: "#/$defs/systemBinding" }, evidenceIds: stringArraySchema,
      },
    },
    join: {
      type: "object", additionalProperties: false,
      required: ["status", "value", "evidenceIds", "gapId", "questionId"],
      properties: {
        status: { enum: ["known", "unknown"] },
        value: { oneOf: [{ const: ONTOLOGY_PACKAGE_UNKNOWN }, {
          type: "object", additionalProperties: { type: "string" },
        }] },
        evidenceIds: stringArraySchema, gapId: { type: ["string", "null"] },
        questionId: { type: ["string", "null"] },
      },
    },
    link: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "apiName", "sourceDataObjectId",
        "targetDataObjectId", "cardinality", "join", "status", "evidenceIds"],
      properties: {
        kind: { const: "Link" }, id: stringSchema, legacyId: stringSchema,
        apiName: stringSchema, sourceDataObjectId: stringSchema,
        targetDataObjectId: stringSchema, cardinality: stringSchema,
        join: { $ref: "#/$defs/join" }, status: entityStatusSchema, evidenceIds: stringArraySchema,
      },
    },
    action: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "name", "status", "relatedDataObjectIds",
        "parameters", "effects", "sourceProcessNodeIds", "emitsEventIds",
        "consumesEventIds", "bindings", "evidenceIds"],
      properties: {
        kind: { const: "Action" }, id: stringSchema, legacyId: stringSchema,
        name: stringSchema, status: entityStatusSchema, relatedDataObjectIds: stringArraySchema,
        parameters: { type: "array", items: { type: "object" } }, effects: stringArraySchema,
        sourceProcessNodeIds: stringArraySchema, emitsEventIds: stringArraySchema,
        consumesEventIds: stringArraySchema, bindings: { $ref: "#/$defs/bindings" },
        evidenceIds: stringArraySchema,
      },
    },
    participant: {
      type: "object", additionalProperties: false, required: ["actionId", "bindings"],
      properties: { actionId: stringSchema, bindings: { $ref: "#/$defs/bindings" } },
    },
    event: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "name", "status", "payloadDataObjectIds",
        "sourceProcessNodeIds", "producerState", "producers", "producer", "consumerState",
        "consumers", "evidenceIds"],
      properties: {
        kind: { const: "Event" }, id: stringSchema, legacyId: stringSchema,
        name: stringSchema, status: entityStatusSchema, payloadDataObjectIds: stringArraySchema,
        sourceProcessNodeIds: stringArraySchema, producer: { $ref: "#/$defs/participant" },
        producerState: { enum: ["known", "unknown", "confirmed_none", "not_applicable"] },
        producers: { type: "array", items: { $ref: "#/$defs/participant" } },
        consumerState: { enum: ["known", "unknown", "confirmed_none", "not_applicable"] },
        consumers: { type: "array", items: { $ref: "#/$defs/participant" } },
        evidenceIds: stringArraySchema,
      },
    },
    processNode: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "nodeKind", "name", "code", "stageId",
        "semanticRef", "dataObjectIds", "actorRole", "evidenceIds"],
      properties: {
        kind: { const: "ProcessNode" }, id: stringSchema, legacyId: stringSchema,
        nodeKind: stringSchema, name: stringSchema, code: stringSchema, stageId: stringSchema,
        semanticRef: stringSchema, dataObjectIds: stringArraySchema,
        actorRole: { $ref: "#/$defs/roleBinding" }, evidenceIds: stringArraySchema,
      },
    },
    processEdge: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "fromNodeId", "toNodeId", "edgeKind",
        "condition", "evidenceIds"],
      properties: {
        kind: { const: "ProcessEdge" }, id: stringSchema, legacyId: stringSchema,
        fromNodeId: stringSchema, toNodeId: stringSchema, edgeKind: stringSchema,
        condition: stringSchema, evidenceIds: stringArraySchema,
      },
    },
    workflow: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "name", "description", "entryNodeId",
        "exitNodeIds", "nodeIds", "actionIds", "eventIds", "edgeIds", "evidenceIds"],
      properties: {
        kind: { const: "Workflow" }, id: stringSchema, legacyId: stringSchema,
        name: stringSchema, description: stringSchema, entryNodeId: stringSchema,
        exitNodeIds: stringArraySchema, nodeIds: stringArraySchema, actionIds: stringArraySchema,
        eventIds: stringArraySchema, edgeIds: stringArraySchema, evidenceIds: stringArraySchema,
      },
    },
    rule: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "legacyId", "statement", "ruleKind", "dataObjectIds",
        "actorRole", "status", "evidenceIds"],
      properties: {
        kind: { const: "Rule" }, id: stringSchema, legacyId: stringSchema,
        statement: stringSchema, ruleKind: stringSchema, dataObjectIds: stringArraySchema,
        actorRole: { $ref: "#/$defs/roleBinding" }, status: entityStatusSchema,
        evidenceIds: stringArraySchema,
      },
    },
    integration: {
      type: "object", additionalProperties: false,
      required: ["kind", "id", "actionId", "role", "system", "platform", "api",
        "database", "evidenceIds"],
      properties: {
        kind: { const: "Integration" }, id: stringSchema, actionId: stringSchema,
        role: { $ref: "#/$defs/roleBinding" }, system: { $ref: "#/$defs/systemBinding" },
        platform: { $ref: "#/$defs/platformBinding" }, api: { $ref: "#/$defs/apiBinding" },
        database: { $ref: "#/$defs/databaseBinding" }, evidenceIds: stringArraySchema,
      },
    },
    named: {
      type: "object", additionalProperties: false, required: ["id", "name"],
      properties: { id: stringSchema, name: stringSchema },
    },
    question: {
      type: "object", additionalProperties: false,
      required: ["id", "text", "status", "origin", "targetEntityType", "targetEntityId",
        "targetField", "ownerRoleId", "evidenceIds", "gapId", "resolutionValue",
        "sourceDecisionId"],
      properties: {
        id: stringSchema, text: stringSchema, status: stringSchema,
        origin: { enum: ["source", "generated_gap"] }, targetEntityType: stringSchema,
        targetEntityId: stringSchema, targetField: stringSchema, ownerRoleId: stringSchema,
        evidenceIds: stringArraySchema, gapId: { type: ["string", "null"] },
        resolutionValue: { $ref: "#/$defs/jsonValue" },
        sourceDecisionId: { type: ["string", "null"] },
      },
    },
    gap: {
      type: "object", additionalProperties: false,
      required: ["id", "code", "entityType", "entityId", "field", "message", "status",
        "questionId", "resolutionValue", "sourceDecisionId"],
      properties: {
        id: stringSchema, code: stringSchema, entityType: stringSchema, entityId: stringSchema,
        field: stringSchema, message: stringSchema,
        status: { enum: ["open", "resolved", "confirmed_none", "not_applicable"] },
        questionId: stringSchema, resolutionValue: { $ref: "#/$defs/jsonValue" },
        sourceDecisionId: { type: ["string", "null"] },
      },
    },
    evidence: {
      type: "object", additionalProperties: false,
      required: ["id", "fileId", "fileName", "locator", "snippet", "extractor",
        "confidence", "cite"],
      properties: {
        id: stringSchema, fileId: stringSchema, fileName: stringSchema,
        locator: { type: "object" }, snippet: stringSchema, extractor: stringSchema,
        confidence: { type: "number", minimum: 0, maximum: 1 }, cite: stringSchema,
      },
    },
    issue: {
      type: "object", additionalProperties: false,
      required: ["code", "path", "message", "severity"],
      properties: {
        code: stringSchema, path: stringSchema, message: stringSchema,
        severity: { enum: ["error", "warning"] },
      },
    },
    validation: {
      type: "object", additionalProperties: false,
      required: ["status", "schemaVersion", "legacyCanonicalPassed", "errors", "warnings",
        "gapCount", "openGapCount", "resolvedGapCount"],
      properties: {
        status: { enum: ["valid", "valid_with_gaps", "invalid"] },
        schemaVersion: { const: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION },
        legacyCanonicalPassed: { type: "boolean" },
        errors: { type: "array", items: { $ref: "#/$defs/issue" } },
        warnings: { type: "array", items: { $ref: "#/$defs/issue" } },
        gapCount: { type: "integer", minimum: 0 },
        openGapCount: { type: "integer", minimum: 0 },
        resolvedGapCount: { type: "integer", minimum: 0 },
      },
    },
  },
});

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Dict[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sourceDict(source: PackageSource): Dict {
  if (source === null || source === undefined) return {};
  const candidate = source as { toDict?: unknown };
  if (typeof candidate.toDict === "function") {
    return (candidate as { toDict(): Dict }).toDict();
  }
  return source as Dict;
}

function valueOf(value: unknown): unknown {
  return pyValue(value, null);
}

function text(value: unknown): string {
  const raw = valueOf(value);
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  return "";
}

function textOrUnknown(value: unknown): string {
  return text(value) || ONTOLOGY_PACKAGE_UNKNOWN;
}

function stringList(value: unknown): string[] {
  const raw = valueOf(value);
  if (!Array.isArray(raw)) return [];
  return unique(raw.map(text).filter(Boolean));
}

function recordList(value: unknown): Dict[] {
  const raw = valueOf(value);
  return Array.isArray(raw) ? raw.filter(isRecord).map((item) => ({ ...item })) : [];
}

function recordValue(value: unknown): Dict | null {
  const raw = valueOf(value);
  return isRecord(raw) ? raw : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoint);
}

function appendUnique(map: Map<string, string[]>, key: string, value: string): void {
  if (!key || !value) return;
  const bucket = map.get(key) ?? [];
  if (!bucket.includes(value)) bucket.push(value);
  map.set(key, bucket);
}

function registerNamedIdentity(
  items: Map<string, string>,
  prefix: string,
  identity: string,
): string {
  const existing = [...items.entries()].find(([, name]) => name === identity);
  if (existing !== undefined) return existing[0];
  const preferred = canonicalId(prefix, identity);
  const owner = items.get(preferred);
  if (owner === undefined || owner === identity) {
    items.set(preferred, identity);
    return preferred;
  }
  const digest = sha256Hex(identity);
  for (let width = 8; width <= digest.length; width += 4) {
    const candidate = `${preferred}.h${digest.slice(0, width)}`;
    const candidateOwner = items.get(candidate);
    if (candidateOwner === undefined || candidateOwner === identity) {
      items.set(candidate, identity);
      return candidate;
    }
  }
  const fallback = `${preferred}.h${digest}.${identity.length}`;
  items.set(fallback, identity);
  return fallback;
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function entityStatus(value: unknown): OntologyEntityStatus {
  const status = text(value).toLowerCase();
  if (["candidate", "proposed", "confirmed", "rejected", "draft_from_api"].includes(status)) {
    return status as OntologyEntityStatus;
  }
  return ONTOLOGY_PACKAGE_UNKNOWN;
}

function evidenceIds(assertion: unknown, index: PackageEvidenceIndex): string[] {
  const result = index.assertion(assertion);
  return stringList(result["evidenceIds"]);
}

function combinedEvidence(index: PackageEvidenceIndex, ...sources: unknown[]): string[] {
  const result = index.assertion(...sources);
  return stringList(result["evidenceIds"]);
}

function evidenceRecord(value: Dict): OntologyEvidenceV1 {
  const locator = isRecord(value["locator"]) ? value["locator"] : {};
  const confidence = Number(value["confidence"] ?? 0.5);
  return {
    id: text(value["id"]),
    fileId: text(value["fileId"] ?? value["file_id"]),
    fileName: text(value["fileName"] ?? value["file_name"]),
    locator,
    snippet: text(value["snippet"]),
    extractor: text(value["extractor"]),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    cite: text(value["cite"]),
  };
}

interface GapRef {
  readonly gapId: string;
  readonly questionId: string;
  readonly status: OntologyGapV1["status"];
  readonly resolutionValue: unknown;
  readonly sourceDecisionId: string | null;
}

interface GapResolution {
  readonly status: Exclude<OntologyGapV1["status"], "open">;
  readonly value: unknown;
  readonly decisionId: string | null;
}

interface GapResolutionIndex {
  readonly byQuestionId: ReadonlyMap<string, GapResolution>;
  readonly byGapId: ReadonlyMap<string, GapResolution>;
}

function dictLike(value: unknown): Dict | null {
  if (isRecord(value)) return value;
  const candidate = value as { toDict?: unknown } | null;
  if (candidate !== null && typeof candidate === "object" &&
      typeof candidate.toDict === "function") {
    const converted = (candidate as { toDict(): unknown }).toDict();
    return isRecord(converted) ? converted : null;
  }
  return null;
}

function resolutionMarker(value: unknown): GapResolution["status"] | null {
  const marker = text(value).toLowerCase().replaceAll("-", "_");
  if (marker === "confirmed_none") return "confirmed_none";
  if (marker === "not_applicable") return "not_applicable";
  if (marker === "resolved") return "resolved";
  return null;
}

function businessResolution(row: Dict, decisionId: string | null): GapResolution | null {
  const answer = valueOf(Object.hasOwn(row, "answer") ? row["answer"] : row["statement"]);
  const answerRecord = isRecord(answer) ? answer : null;
  const metadata = recordValue(row["metadata"]);
  const marker = resolutionMarker(
    answerRecord?.["status"] ?? answerRecord?.["resolutionStatus"] ??
    answerRecord?.["resolution_status"] ?? answerRecord?.["outcome"] ??
    metadata?.["resolutionStatus"] ?? metadata?.["resolution_status"] ??
    (typeof answer === "string" ? answer : null),
  );
  let resolutionValue: unknown = null;
  if (answerRecord !== null) {
    if (Object.hasOwn(answerRecord, "value")) resolutionValue = valueOf(answerRecord["value"]);
    else if (Object.hasOwn(answerRecord, "resolutionValue")) {
      resolutionValue = valueOf(answerRecord["resolutionValue"]);
    } else if (Object.hasOwn(answerRecord, "resolution_value")) {
      resolutionValue = valueOf(answerRecord["resolution_value"]);
    }
  } else if (marker === null && answer !== undefined && answer !== null && answer !== "") {
    resolutionValue = answer;
  }
  if (marker !== null) return { status: marker, value: resolutionValue, decisionId };
  if (answer !== undefined && answer !== null && answer !== "") {
    return { status: "resolved", value: resolutionValue, decisionId };
  }
  const questionStatus = text(row["status"]).toLowerCase();
  if (questionStatus === "answered") {
    return { status: "resolved", value: null, decisionId };
  }
  return null;
}

function inputRows(value: unknown, collectionKey: "decisions" | "questions"): Dict[] {
  if (value === null || value === undefined) return [];
  const converted = dictLike(value);
  if (converted !== null) {
    const nested = converted[collectionKey];
    if (Array.isArray(nested)) return nested.map(dictLike).filter((item): item is Dict => item !== null);
    return [converted];
  }
  if (typeof value === "string") return [];
  if (Symbol.iterator in Object(value)) {
    return [...(value as Iterable<unknown>)]
      .map(dictLike)
      .filter((item): item is Dict => item !== null);
  }
  return [];
}

function gapResolutionIndex(
  decisions: readonly unknown[],
  backlog: unknown,
): GapResolutionIndex {
  // delivery compiler 只消费已经 applied（或 legacy 没执行状态）的决定；claimed / failed
  // 都不是可交付业务事实。先过滤再算 supersedes，防止未生效的新记录吞掉旧决定。
  const accepted = decisions
    .map(dictLike)
    .filter((row): row is Dict => row !== null)
    .filter((row) => {
      const metadata = recordValue(row["metadata"]);
      const execution = text(metadata?.["status"]).toLowerCase();
      return !execution || execution === "applied";
    });
  const superseded = new Set(accepted.map((row) => text(row["supersedes"])).filter(Boolean));
  const byQuestionId = new Map<string, GapResolution>();
  const byGapId = new Map<string, GapResolution>();
  for (const row of accepted) {
    const decisionId = text(row["id"] ?? row["decisionId"] ?? row["decision_id"]) || null;
    if (decisionId !== null && superseded.has(decisionId)) continue;
    const questionId = text(row["questionId"] ?? row["question_id"] ?? row["target_rid"]);
    const resolution = businessResolution(row, decisionId);
    if (questionId && resolution !== null) byQuestionId.set(questionId, resolution);
    const gapId = text(row["gapId"] ?? row["gap_id"]);
    if (gapId && resolution !== null) byGapId.set(gapId, resolution);
  }
  for (const question of inputRows(backlog, "questions")) {
    const questionId = text(question["id"] ?? question["rid"]);
    if (!questionId || byQuestionId.has(questionId)) continue;
    const resolution = businessResolution(question, null);
    if (resolution === null) continue;
    byQuestionId.set(questionId, resolution);
    const gapId = text(question["gapId"] ?? question["gap_id"]);
    if (gapId) byGapId.set(gapId, resolution);
  }
  return { byQuestionId, byGapId };
}

class GapCollector {
  readonly gaps: OntologyGapV1[] = [];
  readonly questions: OntologyQuestionV1[] = [];
  private readonly byKey = new Map<string, GapRef>();

  constructor(private readonly resolutions: GapResolutionIndex) {}

  add(
    entityType: string,
    entityId: string,
    field: string,
    message: string,
    question: string,
    code?: string,
  ): GapRef {
    const key = `${entityType}:${entityId}:${field}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    // canonical slug 只有 40 code points；真实 session 的长 Action id + 深字段路径会
    // 大量共享同一前缀。新契约没有 legacy 兼容负担，始终追加内容 hash，避免 gap /
    // question 静默合并（这正是我们要暴露、不能吞掉的数据）。
    const digest = sha256Hex(key).slice(0, 16);
    const gapId = `${canonicalId("gap", key)}.h${digest}`;
    const questionId = `${canonicalId("q", `gap:${key}`)}.h${digest}`;
    const resolution = this.resolutions.byQuestionId.get(questionId) ??
      this.resolutions.byGapId.get(gapId) ?? null;
    const ref: GapRef = {
      gapId,
      questionId,
      status: resolution?.status ?? "open",
      resolutionValue: resolution?.value ?? null,
      sourceDecisionId: resolution?.decisionId ?? null,
    };
    this.byKey.set(key, ref);
    this.gaps.push({
      id: gapId,
      code: code ?? `MISSING_${field.replaceAll(/[^a-zA-Z0-9]+/gu, "_").toUpperCase()}`,
      entityType,
      entityId,
      field,
      message,
      status: ref.status,
      questionId,
      resolutionValue: ref.resolutionValue,
      sourceDecisionId: ref.sourceDecisionId,
    });
    this.questions.push({
      id: questionId,
      text: question,
      status: ref.status === "open" ? "open" : "answered",
      origin: "generated_gap",
      targetEntityType: entityType,
      targetEntityId: entityId,
      targetField: field,
      ownerRoleId: ONTOLOGY_PACKAGE_UNKNOWN,
      evidenceIds: [],
      gapId,
      resolutionValue: ref.resolutionValue,
      sourceDecisionId: ref.sourceDecisionId,
    });
    return ref;
  }
}

function unknownBinding(
  kind: OntologyBindingKind,
  entityType: string,
  entityId: string,
  field: string,
  collector: GapCollector,
  question: string,
): OntologyBinding {
  const gap = collector.add(
    entityType,
    entityId,
    field,
    `${entityType} ${entityId} 缺少 ${field} 的明确材料或人工确认`,
    question,
  );
  if (gap.status === "confirmed_none" || gap.status === "not_applicable") {
    return {
      kind,
      status: gap.status,
      value: "none",
      source: gap.sourceDecisionId === null ? "question_backlog" : `decision:${gap.sourceDecisionId}`,
      evidenceIds: [],
      gapId: gap.gapId,
      questionId: gap.questionId,
    };
  }
  if (gap.status === "resolved" && gap.resolutionValue !== null &&
      gap.resolutionValue !== undefined && gap.resolutionValue !== "") {
    const resolvedValue = typeof gap.resolutionValue === "string"
      ? gap.resolutionValue
      : pyJsonDumps(gap.resolutionValue, null);
    return {
      kind,
      status: "known",
      value: resolvedValue,
      source: gap.sourceDecisionId === null ? "question_backlog" : `decision:${gap.sourceDecisionId}`,
      evidenceIds: [],
      gapId: null,
      questionId: null,
    };
  }
  return {
    kind,
    status: "unknown",
    value: ONTOLOGY_PACKAGE_UNKNOWN,
    source: ONTOLOGY_PACKAGE_UNKNOWN,
    evidenceIds: [],
    gapId: gap.gapId,
    questionId: gap.questionId,
  };
}

/**
 * 行业通识先填的绑定。
 *
 * 与 `unknownBinding` 的区别不只是措辞：它**带着值**，因此下游能拿它去配审批链、
 * 生成访谈提纲；而它的 `status: "assumed"` 与空的 `evidenceIds` 一起说明这个值
 * 没有任何材料依据，必须被确认。gap 仍然照开 —— assumed 不等于已解决。
 */
/** 这份产物里有没有通用假设绑定。决定 assumptionPolicy 报哪一个。 */
function hasAssumedBinding(rows: readonly unknown[]): boolean {
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v === null || typeof v !== "object") return false;
    const row = v as Dict;
    if (row["status"] === "assumed") return true;
    return Object.values(row).some(walk);
  };
  return rows.some(walk);
}

function assumedBinding(
  kind: OntologyBindingKind,
  value: string,
  entityType: string,
  entityId: string,
  field: string,
  collector: GapCollector,
  question: string,
): OntologyBinding {
  const gap = collector.add(
    entityType,
    entityId,
    field,
    `${entityType} ${entityId} 的 ${field} 是按行业通识填的，需要业务方确认`,
    // **问法不一样，答起来的成本差一个量级。** 不知道的那类要业务方从头想
    // （"请提供"），有通识草稿的只要点个头或改一个词（"请确认"）。
    // 把两类混成同一句"请提供…"，等于把最便宜的一批问题也变贵了。
    `请确认：${question.replace(/^请?提供|？$/gu, "")} —— 我们按行业通识填的是「${value}」，对吗？`,
  );
  return {
    kind,
    status: "assumed",
    value,
    // 来源写死成 generic_assumption：**绝不冒充材料抽取**
    source: "generic_assumption",
    evidenceIds: [],
    gapId: gap.gapId,
    questionId: gap.questionId,
  };
}

function knownBinding(
  kind: OntologyBindingKind,
  value: string,
  source: string,
  refs: readonly string[],
): OntologyBinding {
  return {
    kind,
    status: "known",
    value,
    source,
    evidenceIds: unique(refs),
    gapId: null,
    questionId: null,
  };
}

function apiBinding(
  value: string,
  endpoint: Dict | null,
  source: string,
  refs: readonly string[],
  entityId: string,
  collector: GapCollector,
): OntologyApiBinding {
  const method = text(endpoint?.["method"] ?? endpoint?.["httpMethod"]);
  const path = text(
    endpoint?.["path"] ?? endpoint?.["url"] ?? endpoint?.["endpoint"] ?? value,
  );
  const operationId = text(endpoint?.["operationId"] ?? endpoint?.["operation_id"]);
  if (!value && !method && !path && !operationId) {
    const base = unknownBinding(
      "api", "Action", entityId, "bindings.api", collector,
      `Action ${entityId} 调用哪个 API（method、path、operationId）？`,
    );
    return {
      ...base,
      kind: "api",
      method: ONTOLOGY_PACKAGE_UNKNOWN,
      path: ONTOLOGY_PACKAGE_UNKNOWN,
      operationId: ONTOLOGY_PACKAGE_UNKNOWN,
    };
  }
  if (!method) {
    collector.add(
      "Action", entityId, "bindings.api.method",
      `Action ${entityId} 的 API method 未知`,
      `Action ${entityId} 的 API 使用 GET、POST、PUT、PATCH、DELETE 中的哪一种？`,
    );
  }
  if (!path) {
    collector.add(
      "Action", entityId, "bindings.api.path",
      `Action ${entityId} 的 API path 未知`,
      `Action ${entityId} 的 API path 是什么？`,
    );
  }
  if (!operationId) {
    collector.add(
      "Action", entityId, "bindings.api.operationId",
      `Action ${entityId} 的 API operationId 未知`,
      `Action ${entityId} 的 API operationId 是什么？若接口没有 operationId，请明确确认。`,
    );
  }
  const display = value || [method, path].filter(Boolean).join(" ") || operationId;
  return {
    ...knownBinding("api", display, source, refs),
    kind: "api",
    status: method && path && operationId ? "known" : "partial",
    method: method || ONTOLOGY_PACKAGE_UNKNOWN,
    path: path || ONTOLOGY_PACKAGE_UNKNOWN,
    operationId: operationId || ONTOLOGY_PACKAGE_UNKNOWN,
  };
}

function databaseBinding(
  endpoint: Dict | null,
  source: string,
  refs: readonly string[],
  entityId: string,
  collector: GapCollector,
): OntologyDatabaseBinding {
  const database = text(endpoint?.["database"] ?? endpoint?.["databaseName"] ?? endpoint?.["db"]);
  const schema = text(endpoint?.["schema"] ?? endpoint?.["databaseSchema"]);
  const table = text(endpoint?.["table"] ?? endpoint?.["dataset"] ?? endpoint?.["collection"]);
  const value = [database, schema, table].filter(Boolean).join(".");
  if (!value) {
    const base = unknownBinding(
      "database", "Action", entityId, "bindings.database", collector,
      `Action ${entityId} 读写哪个数据库、schema 或表？若不涉及数据库，请业务方明确确认。`,
    );
    return {
      ...base,
      kind: "database",
      database: ONTOLOGY_PACKAGE_UNKNOWN,
      schema: ONTOLOGY_PACKAGE_UNKNOWN,
      table: ONTOLOGY_PACKAGE_UNKNOWN,
    };
  }
  if (!database) {
    collector.add(
      "Action", entityId, "bindings.database.database",
      `Action ${entityId} 的 database 名称未知`,
      `Action ${entityId} 使用哪个 database？`,
    );
  }
  if (!schema) {
    collector.add(
      "Action", entityId, "bindings.database.schema",
      `Action ${entityId} 的 database schema 未知`,
      `Action ${entityId} 使用哪个 database schema？若不适用，请明确确认。`,
    );
  }
  if (!table) {
    collector.add(
      "Action", entityId, "bindings.database.table",
      `Action ${entityId} 的 table/dataset 未知`,
      `Action ${entityId} 读写哪个 table、collection 或 dataset？`,
    );
  }
  return {
    ...knownBinding("database", value, source, refs),
    kind: "database",
    status: database && schema && table ? "known" : "partial",
    database: database || ONTOLOGY_PACKAGE_UNKNOWN,
    schema: schema || ONTOLOGY_PACKAGE_UNKNOWN,
    table: table || ONTOLOGY_PACKAGE_UNKNOWN,
  };
}

function endpointHost(endpoint: string): string {
  if (!endpoint) return "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(endpoint)) return new URL(endpoint).host;
  } catch {
    return "";
  }
  return "";
}

function firstText(record: Dict | null, keys: readonly string[]): string {
  if (record === null) return "";
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return "";
}

interface ActionSources {
  readonly rawAction: Dict | null;
  readonly flowNodes: readonly Dict[];
}

function bindingsForAction(
  actionId: string,
  sources: ActionSources,
  index: PackageEvidenceIndex,
  collector: GapCollector,
): OntologyIntegrationBindings {
  const endpointAssertion = sources.rawAction?.["sourceEndpoint"];
  const endpointRecord = recordValue(endpointAssertion);
  const flowNode = sources.flowNodes.find((node) => text(node["endpoint"])) ??
    sources.flowNodes[0] ?? null;
  const flowEndpoint = text(flowNode?.["endpoint"]);
  const endpointText = firstText(endpointRecord, ["url", "path", "endpoint"])
    || flowEndpoint;
  const refs = combinedEvidence(
    index,
    endpointAssertion,
    sources.rawAction?.["apiName"],
    flowNode?.["label"],
    flowNode?.["actor"],
  );

  const roleText =
    sources.flowNodes.map((node) => text(node["actor"])).find(Boolean) ??
    // 流程节点没写执行角色时回落到 ActionType 自己的 actor（oir.add 新收的字段）。
    // 它在通用草案里是零证据的 —— roleBinding 会把这种自动落成 assumed，不冒充事实。
    (text(dictLike(sources.rawAction?.["actor"])?.["value"] ?? "") || "");
  // 走同一条 roleBinding：有值且有证据 → known；有值零证据 → assumed；没值 → unknown。
  // 以前这里直接 knownBinding，于是通用草案里模型按通识填的执行角色被标成
  // **status: "known" 却带着空 evidenceIds** —— 一个自相矛盾、而且会被下游当成
  // 客户事实的组合。
  const role = roleBinding(
    roleText,
    "flow.nodes[].actor",
    refs,
    "Action",
    actionId,
    "bindings.role",
    `Action ${actionId} 由哪个业务角色负责？`,
    collector,
  );

  const explicitSystem = firstText(endpointRecord, ["system", "systemName", "service"])
    || firstText(sources.rawAction, ["system", "systemName", "service"])
    || firstText(flowNode, ["system", "systemName", "service"]);
  const host = endpointHost(endpointText);
  // 相对 path 只能证明 API 路径，不能证明承载它的系统。legacy canonical 为兼容
  // 会从任意 endpoint 派生 sys.*，这里不能把那个派生标签升级成 known fact。
  const systemValue = explicitSystem || host || "";
  const systemSource = explicitSystem
    ? "explicit_action_or_endpoint_system"
    : host
      ? "derived_from_explicit_endpoint_host"
      : ONTOLOGY_PACKAGE_UNKNOWN;
  const system = systemValue
    ? knownBinding("system", systemValue, systemSource, refs)
    : unknownBinding(
      "system", "Action", actionId, "bindings.system", collector,
      `Action ${actionId} 在哪个系统或服务中执行？`,
    );

  const platformText = firstText(endpointRecord, ["platform", "platformName", "provider", "runtime"]);
  const platform = platformText
    ? knownBinding("platform", platformText, "oir.actions[].sourceEndpoint.platform", refs)
    : unknownBinding(
      "platform", "Action", actionId, "bindings.platform", collector,
      `Action ${actionId} 绑定哪个平台或运行环境？若无平台绑定，请明确确认。`,
    );

  return {
    role,
    system,
    platform,
    api: apiBinding(
      endpointText,
      endpointRecord,
      endpointRecord !== null ? "oir.actions[].sourceEndpoint" : "flow.nodes[].endpoint",
      refs,
      actionId,
      collector,
    ),
    database: databaseBinding(
      endpointRecord,
      "oir.actions[].sourceEndpoint",
      refs,
      actionId,
      collector,
    ),
  };
}

function unknownBindingsForParticipant(
  entityType: string,
  entityId: string,
  field: string,
  collector: GapCollector,
): OntologyIntegrationBindings {
  const ref = collector.add(
    entityType,
    entityId,
    field,
    `${entityType} ${entityId} 缺少 ${field} 的显式流程关系`,
    `${entityType} ${entityId} 对应的 Action 是什么？确认后才能解析角色、系统、平台、API 与数据库绑定。`,
  );
  const binding = (kind: OntologyBindingKind): OntologyBinding => {
    const closedNone = ref.status === "confirmed_none" || ref.status === "not_applicable";
    return {
      kind,
      status: closedNone ? ref.status : "unknown",
      value: closedNone ? "none" : ONTOLOGY_PACKAGE_UNKNOWN,
      source: ref.sourceDecisionId === null
        ? ONTOLOGY_PACKAGE_UNKNOWN
        : `decision:${ref.sourceDecisionId}`,
      evidenceIds: [],
      gapId: ref.gapId,
      questionId: ref.questionId,
    };
  };
  return {
    role: binding("role"),
    system: binding("system"),
    platform: binding("platform"),
    api: {
      ...binding("api"), kind: "api",
      method: ONTOLOGY_PACKAGE_UNKNOWN,
      path: ONTOLOGY_PACKAGE_UNKNOWN,
      operationId: ONTOLOGY_PACKAGE_UNKNOWN,
    },
    database: {
      ...binding("database"), kind: "database",
      database: ONTOLOGY_PACKAGE_UNKNOWN,
      schema: ONTOLOGY_PACKAGE_UNKNOWN,
      table: ONTOLOGY_PACKAGE_UNKNOWN,
    },
  };
}

function seedEvidence(index: PackageEvidenceIndex, legacy: Dict): void {
  for (const item of rows(legacy["evidence"])) {
    const id = text(item["id"]);
    if (id) index.items.set(id, { ...item });
  }
}

function valuesByLegacy(items: readonly Dict[]): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const item of items) {
    const legacyId = text(item["legacyId"] ?? item["rid"]);
    if (legacyId) out.set(legacyId, item);
  }
  return out;
}

function findRawAction(
  candidates: readonly Dict[],
  legacyAction: Dict,
): Dict | null {
  const legacyId = text(legacyAction["legacyId"]);
  return candidates.find((item) => text(item["rid"]) === legacyId) ?? candidates[0] ?? null;
}

function roleBinding(
  value: string,
  source: string,
  evidence: readonly string[],
  entityType: string,
  entityId: string,
  field: string,
  question: string,
  collector: GapCollector,
): OntologyBinding {
  if (!value) return unknownBinding("role", entityType, entityId, field, collector, question);
  // **有值但零证据 = 行业通识，不是材料事实。**
  //
  // 通用草案里的执行角色（「部门负责人」这种）是模型按通识填的：它有值、能拿去
  // 配审批链，但一条材料依据都没有。以前这里一律走 knownBinding，于是通用假设
  // 被当成"已知"发布出去；而如果为了诚实把它丢掉，通用模板就退化成空模板。
  // assumed 是这两者之间那个正确的第三态：**带着值，同时明说它待确认**。
  if (evidence.length === 0) {
    return assumedBinding("role", value, entityType, entityId, field, collector, question);
  }
  return knownBinding("role", value, source, evidence);
}

function objectRef(
  raw: unknown,
  objectIds: ReadonlyMap<string, string>,
): string {
  const legacyId = text(raw);
  return objectIds.get(legacyId) ?? ONTOLOGY_PACKAGE_UNKNOWN;
}

function reachableNodeIds(
  workflow: Dict,
  nodesById: ReadonlyMap<string, Dict>,
  outgoing: ReadonlyMap<string, readonly string[]>,
): string[] {
  const entry = text(workflow["entry"]);
  if (!entry || !nodesById.has(entry)) return [];
  const exits = new Set(stringList(workflow["exits"]));
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current) || !nodesById.has(current)) continue;
    visited.add(current);
    if (exits.has(current)) continue;
    for (const target of outgoing.get(current) ?? []) if (!visited.has(target)) queue.push(target);
  }
  return [...visited];
}

function sourceQuestions(legacy: Dict): OntologyQuestionV1[] {
  return rows(legacy["questions"]).map((question) => {
    const targets = stringList(question["blockedArtifacts"]);
    return {
      id: textOrUnknown(question["id"]),
      text: textOrUnknown(question["text"]),
      status: text(question["status"]) || "open",
      origin: "source",
      targetEntityType: targets.length > 0 ? "Entity" : ONTOLOGY_PACKAGE_UNKNOWN,
      targetEntityId: targets[0] ?? ONTOLOGY_PACKAGE_UNKNOWN,
      targetField: ONTOLOGY_PACKAGE_UNKNOWN,
      ownerRoleId: text(question["audienceRole"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      evidenceIds: stringList(question["evidenceIds"]),
      gapId: text(question["gapId"]) || null,
      resolutionValue: null,
      sourceDecisionId: null,
    };
  });
}

function detectActionAlignmentGaps(
  actions: readonly OntologyActionV1[],
  sourceKinds: ReadonlyMap<string, ReadonlySet<string>>,
  collector: GapCollector,
): void {
  for (const action of actions) {
    const kinds = sourceKinds.get(action.id) ?? new Set<string>();
    if (kinds.has("oir") && !kinds.has("flow")) {
      collector.add(
        "ActionAlignment", action.id, "flowAction",
        `OIR Action ${action.id} 没有按 legacy id 对齐到 Flow Action`,
        `OIR Action ${action.id} 是否对应某个流程节点？请按业务语义、对象与 endpoint 确认。`,
      );
    } else if (kinds.has("flow") && !kinds.has("oir")) {
      collector.add(
        "ActionAlignment", action.id, "oirAction",
        `Flow Action ${action.id} 没有按 legacy id 对齐到 OIR Action`,
        `Flow Action ${action.id} 是否对应某个 OIR ActionType？请按业务语义、对象与 endpoint 确认。`,
      );
    } else if (kinds.size === 0) {
      collector.add(
        "ActionAlignment", action.id, "source",
        `Action ${action.id} 无法定位到原始 OIR/Flow 来源`,
        `Action ${action.id} 的权威来源是什么？`,
      );
    }
  }
  const groups = new Map<string, OntologyActionV1[]>();
  for (const action of actions) {
    if (action.name === ONTOLOGY_PACKAGE_UNKNOWN) continue;
    const normalized = action.name.toLocaleLowerCase().replace(/[\s_.:/-]+/gu, "");
    if (!normalized) continue;
    const bucket = groups.get(normalized) ?? [];
    bucket.push(action);
    groups.set(normalized, bucket);
  }
  for (const candidates of groups.values()) {
    if (candidates.length < 2) continue;
    const hasOirOnly = candidates.some((item) => {
      const kinds = sourceKinds.get(item.id) ?? new Set<string>();
      return kinds.has("oir") && !kinds.has("flow");
    });
    const hasFlowOnly = candidates.some((item) => {
      const kinds = sourceKinds.get(item.id) ?? new Set<string>();
      return kinds.has("flow") && !kinds.has("oir");
    });
    if (!hasOirOnly || !hasFlowOnly) continue;
    const ids = candidates.map((item) => item.id).sort(compareCodePoint);
    collector.add(
      "ActionAlignment",
      ids[0]!,
      "candidateMerge",
      `OIR 与 Flow 中存在同名但 legacy id 不同的 Action：${ids.join("、")}`,
      `这些 Action 是否表示同一个业务动作：${ids.join("、")}？请按 endpoint、业务对象与语义确认，系统不会自动合并。`,
    );
  }
}

function scanSuspiciousLiteralEscapes(
  root: unknown,
  source: "oir" | "flow",
  packageId: string,
  collector: GapCollector,
): void {
  const seen = new Set<object>();
  let emitted = 0;
  const visit = (value: unknown, path: string): void => {
    if (emitted >= 200) return;
    const raw = valueOf(value);
    if (typeof raw === "string") {
      if (/\\[nrt]/u.test(raw)) {
        emitted += 1;
        collector.add(
          "PackageInput",
          packageId,
          `literalEscape.${source}.${path}`,
          `${source} 输入 ${path} 含有疑似未解码的 \\n/\\r/\\t 字面量`,
          `请确认 ${source} 输入 ${path} 的换行或制表符是否应清洗；编译器不会静默改写原始材料。`,
          "SUSPICIOUS_LITERAL_ESCAPE",
        );
      }
      return;
    }
    if (raw === null || typeof raw !== "object") return;
    if (seen.has(raw as object)) return;
    seen.add(raw as object);
    if (Array.isArray(raw)) {
      raw.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(raw as Dict)) {
      // Evidence snippet/cite 是原文，不参与 canonical identity；在那里报告字面换行会
      // 制造大量重复噪声。这里只审查会进入实体/关系语义的输入字段。
      if (["evidence", "locator", "snippet", "cite"].includes(key)) continue;
      visit(item, `${path}.${key}`);
    }
  };
  visit(root, "$");
}

/**
 * OIR / FlowGraph → `ontocopilot.ontology-package/1` DRAFT snapshot。
 *
 * 此函数无 I/O、无全局状态写入；同一输入和 generatedAt 会得到同一 JSON。
 */
export function compileOntologyPackageV1(
  oir: PackageSource,
  flow: PackageSource = null,
  options: CompileOntologyPackageV1Options = {},
): OntologyPackageV1 {
  const rawOir = sourceDict(oir);
  const rawFlow = sourceDict(flow);
  const suppliedDecisions = options.decisions === undefined ? [] : [...options.decisions];
  // generated gap questions live only in this richer DRAFT contract. They must not be fed into
  // the legacy package validator, whose question collection cannot contain them.
  const legacyDecisions = suppliedDecisions.filter((candidate) => {
    const row = dictLike(candidate);
    const questionId = text(row?.["questionId"] ?? row?.["question_id"]);
    return !/^q\.gap\./u.test(questionId);
  });
  const legacyPackage = buildPackage(oir, flow, { ...options, decisions: legacyDecisions });
  const legacy = legacyPackage.toDict();
  const index = new PackageEvidenceIndex();
  seedEvidence(index, legacy);
  const collector = new GapCollector(gapResolutionIndex(
    suppliedDecisions,
    options.backlog ?? options.questions,
  ));
  const packageId = textOrUnknown(legacy["packageId"]);
  scanSuspiciousLiteralEscapes(rawOir, "oir", packageId, collector);
  scanSuspiciousLiteralEscapes(rawFlow, "flow", packageId, collector);

  const legacyObjects = rows(legacy["dataObjects"]);
  const objectIds = new Map<string, string>();
  for (const item of legacyObjects) {
    const legacyId = text(item["legacyId"]);
    if (legacyId) objectIds.set(legacyId, text(item["id"]));
  }
  const rawObjects = valuesByLegacy(rows(rawOir["objects"]));
  const rawAttributes = new Map(
    rows(rawOir["properties"]).map((property) => [text(property["rid"]), property] as const),
  );

  const rolesById = new Map<string, string>();
  for (const role of rows(legacy["roles"])) rolesById.set(text(role["id"]), text(role["name"]));
  const systemsById = new Map<string, string>();

  const dataObjects: OntologyDataObjectV1[] = legacyObjects.map((item) => {
    const id = textOrUnknown(item["id"]);
    const legacyId = text(item["legacyId"]);
    const raw = rawObjects.get(legacyId) ?? {};
    const attributes: OntologyAttributeV1[] = rows(item["attributes"]).map((attribute) => {
      const rawAttribute = rawAttributes.get(text(attribute["legacyId"])) ?? {};
      const domain = valueOf(attribute["valueDomain"]);
      return {
        id: textOrUnknown(attribute["id"]),
        legacyId: text(attribute["legacyId"]),
        apiName: textOrUnknown(attribute["apiName"]),
        displayName: textOrUnknown(attribute["displayName"]),
        dataType: textOrUnknown(attribute["type"]),
        definition: textOrUnknown(attribute["definition"]),
        required: attribute["required"] === true,
        semanticType: text(attribute["semanticType"]) || ONTOLOGY_PACKAGE_UNKNOWN,
        unit: text(attribute["unit"]) || ONTOLOGY_PACKAGE_UNKNOWN,
        valueDomain: Array.isArray(domain) ? domain.map(text).filter(Boolean) : [],
        evidenceIds: combinedEvidence(
          index,
          rawAttribute["apiName"], rawAttribute["displayName"], rawAttribute["baseType"],
          rawAttribute["definition"],
        ),
      };
    });
    const primaryKeys = stringList(item["identity"] && isRecord(item["identity"])
      ? item["identity"]["keys"] : []);
    if (primaryKeys.length === 0) {
      collector.add(
        "DataObject", id, "primaryKeyAttributeIds",
        `DataObject ${id} 没有已确认的主键`,
        `DataObject ${id} 的唯一标识字段是什么？`,
      );
    }
    const ownerText = text(raw["owner"]);
    const ownerRole = roleBinding(
      ownerText,
      "oir.objects[].owner",
      combinedEvidence(index, raw["displayName"], raw["description"]),
      "DataObject", id, "ownerRole",
      `DataObject ${id} 的业务负责人角色是什么？`,
      collector,
    );
    if (ownerText) {
      registerNamedIdentity(rolesById, "role", ownerText);
    }
    return {
      kind: "DataObject",
      id,
      legacyId,
      apiName: textOrUnknown(item["apiName"]),
      displayName: textOrUnknown(item["displayName"]),
      description: text(item["description"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      classification: text(item["kind"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      status: entityStatus(item["status"]),
      primaryKeyAttributeIds: primaryKeys,
      attributes,
      ownerRole,
      systemOfRecord: unknownBinding(
        "system", "DataObject", id, "systemOfRecord", collector,
        `DataObject ${id} 的 system of record 是什么？`,
      ),
      evidenceIds: combinedEvidence(index, raw["apiName"], raw["displayName"], raw["description"]),
    };
  });
  for (const item of dataObjects) {
    if (item.systemOfRecord.status === "known") {
      registerNamedIdentity(systemsById, "sys", item.systemOfRecord.value);
    }
  }

  const links: OntologyLinkV1[] = rows(rawOir["links"]).map((raw) => {
    const legacyId = text(raw["rid"]);
    const id = canonicalId("link", legacyId, "lt_");
    const sourceId = objectRef(raw["from"], objectIds);
    const targetId = objectRef(raw["to"], objectIds);
    if (sourceId === ONTOLOGY_PACKAGE_UNKNOWN) {
      collector.add(
        "Link", id, "sourceDataObjectId", `Link ${id} 的来源对象不存在或未解析`,
        `Link ${id} 从哪个 DataObject 出发？原始引用为 ${text(raw["from"]) || "unknown"}。`,
      );
    }
    if (targetId === ONTOLOGY_PACKAGE_UNKNOWN) {
      collector.add(
        "Link", id, "targetDataObjectId", `Link ${id} 的目标对象不存在或未解析`,
        `Link ${id} 指向哪个 DataObject？原始引用为 ${text(raw["to"]) || "unknown"}。`,
      );
    }
    const joinValue = recordValue(raw["joinKey"]);
    const joinEvidence = evidenceIds(raw["joinKey"], index);
    let join: OntologyJoinBindingV1;
    if (joinValue !== null && Object.keys(joinValue).length > 0) {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(joinValue)) {
        const mapped = text(value);
        if (key && mapped) normalized[key] = mapped;
      }
      if (Object.keys(normalized).length > 0) {
        join = {
          status: "known", value: normalized, evidenceIds: joinEvidence,
          gapId: null, questionId: null,
        };
      } else {
        const ref = collector.add(
          "Link", id, "join", `Link ${id} 的 joinKey 没有可用字段映射`,
          `Link ${id} 两端分别使用哪些字段关联？`,
        );
        join = {
          status: "unknown", value: ONTOLOGY_PACKAGE_UNKNOWN, evidenceIds: joinEvidence,
          gapId: ref.gapId, questionId: ref.questionId,
        };
      }
    } else {
      const ref = collector.add(
        "Link", id, "join", `Link ${id} 缺少 joinKey`,
        `Link ${id} 两端分别使用哪些字段关联？`,
      );
      join = {
        status: "unknown", value: ONTOLOGY_PACKAGE_UNKNOWN, evidenceIds: joinEvidence,
        gapId: ref.gapId, questionId: ref.questionId,
      };
    }
    const cardinality = text(raw["cardinality"]);
    if (!cardinality) {
      collector.add(
        "Link", id, "cardinality", `Link ${id} 缺少 cardinality`,
        `Link ${id} 是一对一、一对多还是多对多？`,
      );
    }
    return {
      kind: "Link",
      id,
      legacyId,
      apiName: textOrUnknown(raw["apiName"]),
      sourceDataObjectId: sourceId,
      targetDataObjectId: targetId,
      cardinality: cardinality || ONTOLOGY_PACKAGE_UNKNOWN,
      join,
      status: entityStatus(raw["status"]),
      evidenceIds: combinedEvidence(index, raw["apiName"], raw["cardinality"], raw["joinKey"]),
    };
  });
  if (dataObjects.length > 1 && links.length === 0) {
    collector.add(
      "Package", text(legacy["packageId"]), "links",
      "存在多个 DataObject，但 OIR 没有显式 LinkType",
      "这些 DataObject 之间是否存在业务关联？若彼此独立，请明确确认。",
    );
  }

  const rawNodes = rows(rawFlow["nodes"]);
  const rawEdges = rows(rawFlow["edges"]);
  const nodesById = new Map(rawNodes.map((node) => [text(node["rid"]), node] as const));
  const outgoingNodeIds = new Map<string, string[]>();
  for (const edge of rawEdges) {
    appendUnique(outgoingNodeIds, text(edge["from"]), text(edge["to"]));
  }
  const actionIdByNode = new Map<string, string>();
  const eventIdByNode = new Map<string, string>();
  for (const node of rawNodes) {
    const legacyId = text(node["rid"]);
    const kind = text(node["kind"]).toLowerCase();
    if (kind === "action") actionIdByNode.set(legacyId, canonicalId("act", legacyId, "fn_", "at_"));
    if (kind === "event") eventIdByNode.set(legacyId, canonicalId("evt", legacyId, "fn_", "evt_"));
  }
  const producerIdsByEvent = new Map<string, string[]>();
  const consumerIdsByEvent = new Map<string, string[]>();
  const emitsByAction = new Map<string, string[]>();
  const consumesByAction = new Map<string, string[]>();
  for (const edge of rawEdges) {
    const sourceNodeId = text(edge["from"]);
    const targetNodeId = text(edge["to"]);
    const sourceActionId = actionIdByNode.get(sourceNodeId);
    const targetActionId = actionIdByNode.get(targetNodeId);
    const sourceEventId = eventIdByNode.get(sourceNodeId);
    const targetEventId = eventIdByNode.get(targetNodeId);
    if (sourceActionId !== undefined && targetEventId !== undefined) {
      appendUnique(producerIdsByEvent, targetEventId, sourceActionId);
      appendUnique(emitsByAction, sourceActionId, targetEventId);
    }
    if (sourceEventId !== undefined && targetActionId !== undefined) {
      appendUnique(consumerIdsByEvent, sourceEventId, targetActionId);
      appendUnique(consumesByAction, targetActionId, sourceEventId);
    }
  }

  const rawActionsById = new Map<string, Dict[]>();
  for (const raw of rows(rawOir["actions"])) {
    const id = canonicalId("act", text(raw["rid"]), "at_");
    const bucket = rawActionsById.get(id) ?? [];
    bucket.push(raw);
    rawActionsById.set(id, bucket);
  }
  const flowActionNodesById = new Map<string, Dict[]>();
  for (const node of rows(rawFlow["nodes"])) {
    if (text(node["kind"]).toLowerCase() !== "action") continue;
    const id = canonicalId("act", text(node["rid"]), "fn_", "at_");
    const bucket = flowActionNodesById.get(id) ?? [];
    bucket.push(node);
    flowActionNodesById.set(id, bucket);
  }
  const sourceKinds = new Map<string, ReadonlySet<string>>();
  const legacyActions = rows(legacy["actions"]);
  const eventRows = rows(legacy["events"]);

  const actions: OntologyActionV1[] = legacyActions.map((legacyAction) => {
    const id = textOrUnknown(legacyAction["id"]);
    const rawCandidates = rawActionsById.get(id) ?? [];
    const flowNodes = flowActionNodesById.get(id) ?? [];
    const rawAction = findRawAction(rawCandidates, legacyAction);
    const kinds = new Set<string>();
    if (rawCandidates.length > 0) kinds.add("oir");
    if (flowNodes.length > 0) kinds.add("flow");
    sourceKinds.set(id, kinds);
    const bindings = bindingsForAction(
      id,
      { rawAction, flowNodes },
      index,
      collector,
    );
    if (bindings.system.status === "known") {
      registerNamedIdentity(systemsById, "sys", bindings.system.value);
    }
    const name = text(legacyAction["name"]);
    if (!name) {
      collector.add(
        "Action", id, "name", `Action ${id} 缺少名称`, `Action ${id} 的业务名称是什么？`,
      );
    }
    return {
      kind: "Action",
      id,
      legacyId: text(legacyAction["legacyId"]),
      name: name || ONTOLOGY_PACKAGE_UNKNOWN,
      status: entityStatus(legacyAction["status"]),
      relatedDataObjectIds: stringList(legacyAction["relatedDataObjects"]),
      parameters: recordList(legacyAction["parameters"]),
      effects: stringList(legacyAction["effects"]),
      sourceProcessNodeIds: stringList(legacyAction["sourceProcessNodes"]),
      emitsEventIds: emitsByAction.get(id) ?? [],
      consumesEventIds: consumesByAction.get(id) ?? [],
      bindings,
      evidenceIds: combinedEvidence(
        index,
        legacyAction["assertion"], rawAction?.["apiName"], rawAction?.["effects"],
        ...flowNodes.map((node) => node["label"]),
      ),
    };
  });
  for (const action of actions) {
    if (action.emitsEventIds.length === 0) {
      collector.add(
        "Action", action.id, "emitsEventIds",
        `Action ${action.id} 没有通过显式流程边连接 emitted Event`,
        `Action ${action.id} 完成后发布什么 Event？若不发布事件，请明确确认。`,
      );
    }
  }
  detectActionAlignmentGaps(actions, sourceKinds, collector);
  const actionById = new Map(actions.map((action) => [action.id, action] as const));

  const events: OntologyEventV1[] = eventRows.map((event) => {
    const id = textOrUnknown(event["id"]);
    const producers = (producerIdsByEvent.get(id) ?? [])
      .map((producerId): OntologyBoundParticipantV1 | null => {
        const action = actionById.get(producerId);
        return action === undefined ? null : { actionId: action.id, bindings: action.bindings };
      })
      .filter((item): item is OntologyBoundParticipantV1 => item !== null);
    const producerGap = producers.length === 0
      ? collector.add(
        "Event", id, "producerAction", `Event ${id} 没有显式 producer Action`,
        `Event ${id} 由哪个 Action 发布？若它是外部起始事件，请明确确认。`,
      )
      : null;
    const producer: OntologyBoundParticipantV1 = producers[0] ?? {
      actionId: ONTOLOGY_PACKAGE_UNKNOWN,
      bindings: unknownBindingsForParticipant("Event", id, "producerAction", collector),
    };
    const consumers = (consumerIdsByEvent.get(id) ?? [])
      .map((consumerId): OntologyBoundParticipantV1 | null => {
        const action = actionById.get(consumerId);
        return action === undefined ? null : { actionId: action.id, bindings: action.bindings };
      })
      .filter((item): item is OntologyBoundParticipantV1 => item !== null);
    const consumerGap = consumers.length === 0
      ? collector.add(
        "Event", id, "consumerActions", `Event ${id} 没有显式 consumer Action`,
        `Event ${id} 由哪个后续 Action 消费？若它是终止事件，请明确确认。`,
      )
      : null;
    const payload = isRecord(event["payload"]) ? event["payload"] : {};
    const payloadId = text(payload["dataObject"]);
    return {
      kind: "Event",
      id,
      legacyId: text(event["legacyId"]),
      name: text(event["name"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      status: entityStatus(event["status"]),
      payloadDataObjectIds: payloadId ? [payloadId] : [],
      sourceProcessNodeIds: stringList(event["sourceProcessNodes"]),
      producerState: producers.length > 0
        ? "known"
        : producerGap?.status === "confirmed_none" || producerGap?.status === "not_applicable"
          ? producerGap.status
          : "unknown",
      producers,
      producer,
      consumerState: consumers.length > 0
        ? "known"
        : consumerGap?.status === "confirmed_none" || consumerGap?.status === "not_applicable"
          ? consumerGap.status
          : "unknown",
      consumers,
      evidenceIds: stringList(isRecord(event["assertion"]) ? event["assertion"]["evidenceIds"] : []),
    };
  });

  const processNodes: OntologyProcessNodeV1[] = rawNodes.map((node) => {
    const legacyId = text(node["rid"]);
    const id = canonicalId("pn", legacyId, "fn_");
    const nodeKind = text(node["kind"]).toLowerCase() || ONTOLOGY_PACKAGE_UNKNOWN;
    const semanticRef = actionIdByNode.get(legacyId) ?? eventIdByNode.get(legacyId) ??
      ONTOLOGY_PACKAGE_UNKNOWN;
    const refs = combinedEvidence(
      index, node["label"], node["actor"], node["objects"], node["endpoint"],
    );
    const dataObjectIds = stringList(node["objects"]).map((legacyObjectId) => {
      const resolved = objectIds.get(legacyObjectId);
      if (resolved !== undefined) return resolved;
      collector.add(
        "ProcessNode", id, `dataObjectIds.${legacyObjectId}`,
        `ProcessNode ${id} 引用了不存在的 DataObject ${legacyObjectId}`,
        `ProcessNode ${id} 的对象引用 ${legacyObjectId} 应对应哪个 DataObject？`,
      );
      return ONTOLOGY_PACKAGE_UNKNOWN;
    });
    const actor = text(node["actor"]);
    if (actor) registerNamedIdentity(rolesById, "role", actor);
    return {
      kind: "ProcessNode",
      id,
      legacyId,
      nodeKind,
      name: text(node["label"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      code: text(node["code"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      stageId: text(node["stage"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      semanticRef,
      dataObjectIds,
      actorRole: roleBinding(
        actor,
        "flow.nodes[].actor",
        refs,
        "ProcessNode",
        id,
        "actorRole",
        `ProcessNode ${id} 由哪个角色负责？若该节点不需要角色，请明确确认。`,
        collector,
      ),
      evidenceIds: refs,
    };
  });
  const processEdges: OntologyProcessEdgeV1[] = rawEdges.map((edge) => {
    const legacyId = text(edge["rid"]);
    const id = canonicalId("pe", legacyId, "fe_");
    const sourceLegacyId = text(edge["from"]);
    const targetLegacyId = text(edge["to"]);
    const source = nodesById.has(sourceLegacyId)
      ? canonicalId("pn", sourceLegacyId, "fn_")
      : ONTOLOGY_PACKAGE_UNKNOWN;
    const target = nodesById.has(targetLegacyId)
      ? canonicalId("pn", targetLegacyId, "fn_")
      : ONTOLOGY_PACKAGE_UNKNOWN;
    if (source === ONTOLOGY_PACKAGE_UNKNOWN) {
      collector.add(
        "ProcessEdge", id, "fromNodeId", `ProcessEdge ${id} 的来源节点不存在`,
        `ProcessEdge ${id} 从哪个 ProcessNode 出发？原始引用为 ${sourceLegacyId || "unknown"}。`,
      );
    }
    if (target === ONTOLOGY_PACKAGE_UNKNOWN) {
      collector.add(
        "ProcessEdge", id, "toNodeId", `ProcessEdge ${id} 的目标节点不存在`,
        `ProcessEdge ${id} 指向哪个 ProcessNode？原始引用为 ${targetLegacyId || "unknown"}。`,
      );
    }
    return {
      kind: "ProcessEdge",
      id,
      legacyId,
      fromNodeId: source,
      toNodeId: target,
      edgeKind: text(edge["kind"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      condition: text(edge["condition"] ?? edge["label"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      evidenceIds: combinedEvidence(index, edge["evidence"], edge["label"], edge["condition"]),
    };
  });

  const workflows: OntologyWorkflowV1[] = rows(rawFlow["workflows"]).map((workflow) => {
    const legacyId = text(workflow["key"]);
    const id = canonicalId("wf", legacyId);
    const memberLegacyIds = reachableNodeIds(workflow, nodesById, outgoingNodeIds);
    const memberSet = new Set(memberLegacyIds);
    const entry = text(workflow["entry"]);
    const exits = stringList(workflow["exits"]);
    if (!entry || !nodesById.has(entry)) {
      collector.add(
        "Workflow", id, "entryNodeId", `Workflow ${id} 缺少有效入口节点`,
        `Workflow ${id} 从哪个节点开始？`,
      );
    }
    if (exits.length === 0 || exits.some((exit) => !nodesById.has(exit))) {
      collector.add(
        "Workflow", id, "exitNodeIds", `Workflow ${id} 缺少有效退出节点`,
        `Workflow ${id} 在哪些节点结束？`,
      );
    }
    const memberEdges = rawEdges.filter((edge) =>
      memberSet.has(text(edge["from"])) && memberSet.has(text(edge["to"])),
    );
    return {
      kind: "Workflow",
      id,
      legacyId,
      name: text(workflow["title"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      description: text(workflow["description"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      entryNodeId: entry && nodesById.has(entry)
        ? canonicalId("pn", entry, "fn_") : ONTOLOGY_PACKAGE_UNKNOWN,
      exitNodeIds: exits.filter((exit) => nodesById.has(exit))
        .map((exit) => canonicalId("pn", exit, "fn_")),
      nodeIds: memberLegacyIds.map((nodeId) => canonicalId("pn", nodeId, "fn_")),
      actionIds: unique(memberLegacyIds.map((nodeId) => actionIdByNode.get(nodeId) ?? "").filter(Boolean)),
      eventIds: unique(memberLegacyIds.map((nodeId) => eventIdByNode.get(nodeId) ?? "").filter(Boolean)),
      edgeIds: memberEdges.map((edge) => canonicalId("pe", text(edge["rid"]), "fe_")),
      evidenceIds: combinedEvidence(
        index,
        ...memberLegacyIds.map((nodeId) => nodesById.get(nodeId)?.["label"]),
        ...memberEdges.map((edge) => edge["evidence"]),
      ),
    };
  });
  if (rawNodes.length > 0 && workflows.length === 0) {
    collector.add(
      "Package", text(legacy["packageId"]), "workflows",
      "FlowGraph 含节点但没有明确 Workflow 定义",
      "这些流程节点应归属于哪些 Workflow？请确认入口与退出节点。",
    );
  }

  const rules: OntologyRuleV1[] = rows(legacy["rules"]).map((rule) => {
    const id = textOrUnknown(rule["id"]);
    const actorRoleId = text(isRecord(rule["outcome"]) ? rule["outcome"]["requiredRole"] : null);
    return {
      kind: "Rule",
      id,
      legacyId: text(rule["legacyId"]),
      statement: text(rule["rawStatement"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      ruleKind: text(rule["ruleKind"]) || ONTOLOGY_PACKAGE_UNKNOWN,
      dataObjectIds: stringList(rule["scope"]),
      actorRole: roleBinding(
        actorRoleId,
        "canonical.rules[].outcome.requiredRole",
        stringList(isRecord(rule["assertion"]) ? rule["assertion"]["evidenceIds"] : []),
        "Rule", id, "actorRole", `Rule ${id} 由哪个角色负责或执行？`, collector,
      ),
      status: entityStatus(rule["status"]),
      evidenceIds: stringList(isRecord(rule["assertion"]) ? rule["assertion"]["evidenceIds"] : []),
    };
  });

  const integrations: OntologyIntegrationV1[] = actions.map((action) => ({
    kind: "Integration",
    id: canonicalId("int", action.id, "act."),
    actionId: action.id,
    ...action.bindings,
    evidenceIds: action.evidenceIds,
  }));

  const evidence = [...index.items.values()]
    .map(evidenceRecord)
    .sort((a, b) => compareCodePoint(a.id, b.id));
  const sourceQuestionRows = sourceQuestions(legacy);
  const questions = [...sourceQuestionRows, ...collector.questions]
    .filter((question, position, all) => all.findIndex((item) => item.id === question.id) === position)
    .sort((a, b) => compareCodePoint(a.id, b.id));
  const gaps = [...collector.gaps].sort((a, b) => compareCodePoint(a.id, b.id));
  const openGapCount = gaps.filter((gap) => gap.status === "open").length;

  const placeholderValidation: OntologyPackageValidation = {
    status: openGapCount > 0 ? "valid_with_gaps" : "valid",
    schemaVersion: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
    legacyCanonicalPassed: legacyPackage.validation.passed,
    errors: [],
    warnings: [],
    gapCount: gaps.length,
    openGapCount,
    resolvedGapCount: gaps.length - openGapCount,
  };
  const draft: OntologyPackageV1 = {
    $schema: ONTOLOGY_PACKAGE_V1_SCHEMA_ID,
    schemaVersion: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
    packageId: textOrUnknown(legacy["packageId"]),
    revision: Math.max(1, Math.trunc(Number(legacy["revision"] ?? 1))),
    baseRevision: typeof legacy["baseRevision"] === "number"
      ? Math.trunc(legacy["baseRevision"] as number) : null,
    generatedAt: textOrUnknown(legacy["generatedAt"]),
    releaseState: ONTOLOGY_PACKAGE_RELEASE_STATE,
    publishable: false,
    source: {
      oir: Object.keys(rawOir).length > 0,
      flow: Object.keys(rawFlow).length > 0,
      legacySchemaId: text(LEGACY_SCHEMA["$id"]),
      // 一份 assumed 都没有 → 与从前逐字节相同（下游不受影响）
      assumptionPolicy: hasAssumedBinding([...actions, ...events]) ? "generic_assumed" : "missing_is_unknown",
    },
    dataObjects,
    links,
    actions,
    events,
    processNodes,
    processEdges,
    workflows,
    rules,
    integrations,
    roles: [...rolesById.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => compareCodePoint(a.id, b.id)),
    systems: [...systemsById.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => compareCodePoint(a.id, b.id)),
    questions,
    gaps,
    evidence,
    validation: placeholderValidation,
  };
  return {
    ...draft,
    validation: validateOntologyPackageV1(draft, {
      passed: legacyPackage.validation.passed,
      findings: legacyPackage.validation.findings,
    }),
  };
}

interface LegacyValidationInput {
  readonly passed: boolean;
  readonly findings: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly severity: string;
  }[];
}

function issue(
  code: string,
  path: string,
  message: string,
  severity: "error" | "warning" = "error",
): OntologyPackageValidationIssue {
  return { code, path, message, severity };
}

/**
 * DRAFT 包的结构/引用校验。gap 是 warning；悬空的“known”引用与 legacy canonical
 * 校验失败仍是 error，并原样暴露，不因为这是预览接口就降级成通过。
 */
export function validateOntologyPackageV1(
  pkg: OntologyPackageV1,
  legacyValidation?: LegacyValidationInput,
): OntologyPackageValidation {
  const errors: OntologyPackageValidationIssue[] = [];
  const warnings: OntologyPackageValidationIssue[] = [];
  if (pkg.schemaVersion !== ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION) {
    errors.push(issue(
      "SCHEMA_VERSION",
      "/schemaVersion",
      `需要 ${ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION}，收到 ${pkg.schemaVersion}`,
    ));
  }
  if (pkg.releaseState !== "DRAFT" || pkg.publishable !== false) {
    errors.push(issue(
      "DRAFT_RELEASE_GUARD",
      "/releaseState",
      "只读 snapshot 必须保持 DRAFT 且 publishable=false",
    ));
  }

  const collections: ReadonlyArray<readonly [string, readonly { readonly id: string }[]]> = [
    ["dataObjects", pkg.dataObjects], ["links", pkg.links], ["actions", pkg.actions],
    ["events", pkg.events], ["processNodes", pkg.processNodes],
    ["processEdges", pkg.processEdges], ["workflows", pkg.workflows], ["rules", pkg.rules],
    ["integrations", pkg.integrations], ["roles", pkg.roles], ["systems", pkg.systems],
    ["questions", pkg.questions], ["gaps", pkg.gaps], ["evidence", pkg.evidence],
  ];
  const globalIds = new Map<string, string>();
  for (const [collection, items] of collections) {
    items.forEach((item, index) => {
      if (!item.id || item.id === ONTOLOGY_PACKAGE_UNKNOWN) {
        errors.push(issue("MISSING_ID", `/${collection}/${index}/id`, "实体缺少稳定 id"));
        return;
      }
      const prior = globalIds.get(item.id);
      if (prior !== undefined) {
        errors.push(issue(
          "DUPLICATE_ID", `/${collection}/${index}/id`,
          `${item.id} 已在 ${prior} 使用`,
        ));
      } else {
        globalIds.set(item.id, `/${collection}/${index}`);
      }
    });
  }

  const objectIds = new Set(pkg.dataObjects.map((item) => item.id));
  const actionIds = new Set(pkg.actions.map((item) => item.id));
  const eventIds = new Set(pkg.events.map((item) => item.id));
  const processNodeIds = new Set(pkg.processNodes.map((item) => item.id));
  const processEdgeIds = new Set(pkg.processEdges.map((item) => item.id));
  const evidenceIdsSet = new Set(pkg.evidence.map((item) => item.id));
  const questionIds = new Set(pkg.questions.map((item) => item.id));
  const gapIds = new Set(pkg.gaps.map((item) => item.id));
  const checkRef = (
    value: string,
    allowed: ReadonlySet<string>,
    path: string,
    kind: string,
  ): void => {
    if (value === ONTOLOGY_PACKAGE_UNKNOWN) return;
    if (!allowed.has(value)) errors.push(issue("DANGLING_REF", path, `${kind} 引用不存在：${value}`));
  };
  const checkEvidence = (refs: readonly string[], path: string): void => {
    refs.forEach((ref, index) => checkRef(ref, evidenceIdsSet, `${path}/${index}`, "Evidence"));
  };
  const checkEntityStatus = (status: OntologyEntityStatus, path: string): void => {
    if (!["candidate", "proposed", "confirmed", "rejected", "draft_from_api", "unknown"]
      .includes(status)) {
      errors.push(issue("ENTITY_STATUS", path, `不支持的 entity status：${status}`));
    }
  };
  const checkBinding = (
    binding: OntologyBinding,
    path: string,
    expectedKind?: OntologyBindingKind,
  ): void => {
    if (!["known", "partial", "unknown", "confirmed_none", "not_applicable"]
      .includes(binding.status)) {
      errors.push(issue("BINDING_STATUS", `${path}/status`, `不支持的 binding status：${binding.status}`));
    }
    if (expectedKind !== undefined && binding.kind !== expectedKind) {
      errors.push(issue(
        "BINDING_KIND", `${path}/kind`,
        `绑定槽位需要 ${expectedKind}，收到 ${binding.kind}`,
      ));
    }
    if (binding.status === "unknown") {
      if (binding.value !== ONTOLOGY_PACKAGE_UNKNOWN || binding.gapId === null ||
          binding.questionId === null) {
        errors.push(issue(
          "UNKNOWN_BINDING_SHAPE", path,
          "unknown binding 必须 value=unknown 且带 gapId/questionId",
        ));
      }
      if (binding.gapId !== null) checkRef(binding.gapId, gapIds, `${path}/gapId`, "Gap");
      if (binding.questionId !== null) {
        checkRef(binding.questionId, questionIds, `${path}/questionId`, "Question");
      }
    } else if (binding.status === "known" &&
        (binding.value === ONTOLOGY_PACKAGE_UNKNOWN || binding.gapId !== null ||
          binding.questionId !== null)) {
      errors.push(issue(
        "KNOWN_BINDING_SHAPE", path,
        "known binding 必须有具体 value 且不能携带 gapId/questionId",
      ));
    } else if (binding.status === "partial") {
      if (binding.value === ONTOLOGY_PACKAGE_UNKNOWN ||
          (binding.kind !== "api" && binding.kind !== "database")) {
        errors.push(issue(
          "PARTIAL_BINDING_SHAPE", path,
          "partial 只适用于至少含一个真实字段的 API/database binding",
        ));
      }
    } else if (binding.status === "confirmed_none" || binding.status === "not_applicable") {
      if (binding.value !== "none" || binding.gapId === null || binding.questionId === null) {
        errors.push(issue(
          "CLOSED_NONE_BINDING_SHAPE", path,
          `${binding.status} binding 必须 value=none 且保留 gap/question 追溯`,
        ));
      }
      if (binding.gapId !== null) checkRef(binding.gapId, gapIds, `${path}/gapId`, "Gap");
      if (binding.questionId !== null) {
        checkRef(binding.questionId, questionIds, `${path}/questionId`, "Question");
      }
    }
    checkEvidence(binding.evidenceIds, `${path}/evidenceIds`);
  };
  const checkBindings = (bindings: OntologyIntegrationBindings, path: string): void => {
    checkBinding(bindings.role, `${path}/role`, "role");
    checkBinding(bindings.system, `${path}/system`, "system");
    checkBinding(bindings.platform, `${path}/platform`, "platform");
    checkBinding(bindings.api, `${path}/api`, "api");
    checkBinding(bindings.database, `${path}/database`, "database");
    const apiParts = [bindings.api.method, bindings.api.path, bindings.api.operationId];
    const apiUnknowns = apiParts.filter((part) => part === ONTOLOGY_PACKAGE_UNKNOWN).length;
    if (bindings.api.status === "known" && apiUnknowns > 0) {
      errors.push(issue("API_BINDING_COMPLETENESS", `${path}/api`,
        "known API binding 必须包含 method/path/operationId"));
    }
    if (bindings.api.status === "partial" && (apiUnknowns === 0 || apiUnknowns === 3)) {
      errors.push(issue("API_BINDING_PARTIAL", `${path}/api`,
        "partial API binding 必须同时包含已知与未知字段"));
    }
    const dbParts = [bindings.database.database, bindings.database.schema, bindings.database.table];
    const dbUnknowns = dbParts.filter((part) => part === ONTOLOGY_PACKAGE_UNKNOWN).length;
    if (bindings.database.status === "known" && dbUnknowns > 0) {
      errors.push(issue("DATABASE_BINDING_COMPLETENESS", `${path}/database`,
        "known database binding 必须包含 database/schema/table"));
    }
    if (bindings.database.status === "partial" && (dbUnknowns === 0 || dbUnknowns === 3)) {
      errors.push(issue("DATABASE_BINDING_PARTIAL", `${path}/database`,
        "partial database binding 必须同时包含已知与未知字段"));
    }
  };

  pkg.dataObjects.forEach((item, index) => {
    checkEntityStatus(item.status, `/dataObjects/${index}/status`);
    checkBinding(item.ownerRole, `/dataObjects/${index}/ownerRole`, "role");
    checkBinding(item.systemOfRecord, `/dataObjects/${index}/systemOfRecord`, "system");
    checkEvidence(item.evidenceIds, `/dataObjects/${index}/evidenceIds`);
    const attributeIds = new Set(item.attributes.map((attribute) => attribute.id));
    item.primaryKeyAttributeIds.forEach((attributeId, keyIndex) => {
      if (!attributeIds.has(attributeId)) {
        errors.push(issue(
          "PRIMARY_KEY_REF",
          `/dataObjects/${index}/primaryKeyAttributeIds/${keyIndex}`,
          `主键属性不存在于当前 DataObject：${attributeId}`,
        ));
      }
    });
    item.attributes.forEach((attribute, attributeIndex) =>
      checkEvidence(attribute.evidenceIds,
        `/dataObjects/${index}/attributes/${attributeIndex}/evidenceIds`));
  });
  pkg.links.forEach((item, index) => {
    checkEntityStatus(item.status, `/links/${index}/status`);
    checkRef(item.sourceDataObjectId, objectIds, `/links/${index}/sourceDataObjectId`, "DataObject");
    checkRef(item.targetDataObjectId, objectIds, `/links/${index}/targetDataObjectId`, "DataObject");
    checkEvidence(item.evidenceIds, `/links/${index}/evidenceIds`);
    checkEvidence(item.join.evidenceIds, `/links/${index}/join/evidenceIds`);
    if (item.join.status === "unknown") {
      if (item.join.value !== ONTOLOGY_PACKAGE_UNKNOWN || item.join.gapId === null ||
          item.join.questionId === null) {
        errors.push(issue(
          "UNKNOWN_JOIN_SHAPE", `/links/${index}/join`,
          "unknown join 必须 value=unknown 且带 gapId/questionId",
        ));
      }
      if (item.join.gapId !== null) {
        checkRef(item.join.gapId, gapIds, `/links/${index}/join/gapId`, "Gap");
      }
      if (item.join.questionId !== null) {
        checkRef(item.join.questionId, questionIds, `/links/${index}/join/questionId`, "Question");
      }
    }
  });
  pkg.actions.forEach((item, index) => {
    checkEntityStatus(item.status, `/actions/${index}/status`);
    item.relatedDataObjectIds.forEach((ref, refIndex) =>
      checkRef(ref, objectIds, `/actions/${index}/relatedDataObjectIds/${refIndex}`, "DataObject"));
    item.emitsEventIds.forEach((ref, refIndex) =>
      checkRef(ref, eventIds, `/actions/${index}/emitsEventIds/${refIndex}`, "Event"));
    item.consumesEventIds.forEach((ref, refIndex) =>
      checkRef(ref, eventIds, `/actions/${index}/consumesEventIds/${refIndex}`, "Event"));
    item.sourceProcessNodeIds.forEach((ref, refIndex) =>
      checkRef(ref, processNodeIds, `/actions/${index}/sourceProcessNodeIds/${refIndex}`, "ProcessNode"));
    checkBindings(item.bindings, `/actions/${index}/bindings`);
    checkEvidence(item.evidenceIds, `/actions/${index}/evidenceIds`);
  });
  pkg.events.forEach((item, index) => {
    checkEntityStatus(item.status, `/events/${index}/status`);
    item.payloadDataObjectIds.forEach((ref, refIndex) =>
      checkRef(ref, objectIds, `/events/${index}/payloadDataObjectIds/${refIndex}`, "DataObject"));
    item.sourceProcessNodeIds.forEach((ref, refIndex) =>
      checkRef(ref, processNodeIds, `/events/${index}/sourceProcessNodeIds/${refIndex}`, "ProcessNode"));
    item.producers.forEach((participant, participantIndex) => {
      checkRef(participant.actionId, actionIds,
        `/events/${index}/producers/${participantIndex}/actionId`, "Action");
      checkBindings(participant.bindings,
        `/events/${index}/producers/${participantIndex}/bindings`);
    });
    if (item.producers.length > 0) {
      if (item.producerState !== "known") {
        errors.push(issue("EVENT_PRODUCER_STATE", `/events/${index}/producerState`,
          "存在 producers 时 producerState 必须为 known"));
      }
      if (item.producer.actionId !== item.producers[0]?.actionId) {
        errors.push(issue("EVENT_COMPAT_PRODUCER", `/events/${index}/producer/actionId`,
          "兼容 producer 必须等于 producers[0]"));
      }
    } else if (item.producer.actionId !== ONTOLOGY_PACKAGE_UNKNOWN) {
      errors.push(issue("EVENT_COMPAT_PRODUCER", `/events/${index}/producer/actionId`,
        "没有 producers 时兼容 producer.actionId 必须为 unknown"));
    }
    if (item.producers.length === 0 && item.producerState === "known") {
      errors.push(issue("EVENT_PRODUCER_STATE", `/events/${index}/producerState`,
        "没有 producers 时 producerState 不能为 known"));
    }
    if (item.producer.actionId !== ONTOLOGY_PACKAGE_UNKNOWN) {
      checkRef(item.producer.actionId, actionIds, `/events/${index}/producer/actionId`, "Action");
    }
    checkBindings(item.producer.bindings, `/events/${index}/producer/bindings`);
    item.consumers.forEach((participant, participantIndex) => {
      checkRef(participant.actionId, actionIds,
        `/events/${index}/consumers/${participantIndex}/actionId`, "Action");
      checkBindings(participant.bindings,
        `/events/${index}/consumers/${participantIndex}/bindings`);
    });
    if (item.consumers.length > 0 && item.consumerState !== "known") {
      errors.push(issue("EVENT_CONSUMER_STATE", `/events/${index}/consumerState`,
        "存在 consumers 时 consumerState 必须为 known"));
    }
    if (item.consumers.length === 0 && item.consumerState === "known") {
      errors.push(issue("EVENT_CONSUMER_STATE", `/events/${index}/consumerState`,
        "没有 consumers 时 consumerState 不能为 known"));
    }
    checkEvidence(item.evidenceIds, `/events/${index}/evidenceIds`);
  });
  pkg.processNodes.forEach((item, index) => {
    const semanticAllowed = item.nodeKind === "action" ? actionIds
      : item.nodeKind === "event" ? eventIds : null;
    if (semanticAllowed !== null) {
      checkRef(item.semanticRef, semanticAllowed,
        `/processNodes/${index}/semanticRef`, item.nodeKind === "action" ? "Action" : "Event");
    }
    item.dataObjectIds.forEach((ref, refIndex) =>
      checkRef(ref, objectIds, `/processNodes/${index}/dataObjectIds/${refIndex}`, "DataObject"));
    checkBinding(item.actorRole, `/processNodes/${index}/actorRole`, "role");
    checkEvidence(item.evidenceIds, `/processNodes/${index}/evidenceIds`);
  });
  pkg.processEdges.forEach((item, index) => {
    checkRef(item.fromNodeId, processNodeIds, `/processEdges/${index}/fromNodeId`, "ProcessNode");
    checkRef(item.toNodeId, processNodeIds, `/processEdges/${index}/toNodeId`, "ProcessNode");
    checkEvidence(item.evidenceIds, `/processEdges/${index}/evidenceIds`);
  });
  const eventById = new Map(pkg.events.map((event) => [event.id, event] as const));
  const actionById = new Map(pkg.actions.map((action) => [action.id, action] as const));
  pkg.actions.forEach((action, actionIndex) => {
    action.emitsEventIds.forEach((eventId, refIndex) => {
      const event = eventById.get(eventId);
      if (event !== undefined && !event.producers.some((item) => item.actionId === action.id)) {
        errors.push(issue(
          "ACTION_EVENT_RECIPROCITY",
          `/actions/${actionIndex}/emitsEventIds/${refIndex}`,
          `${action.id} emits ${eventId}，但 Event.producers 没有该 Action`,
        ));
      }
    });
    action.consumesEventIds.forEach((eventId, refIndex) => {
      const event = eventById.get(eventId);
      if (event !== undefined && !event.consumers.some((item) => item.actionId === action.id)) {
        errors.push(issue(
          "ACTION_EVENT_RECIPROCITY",
          `/actions/${actionIndex}/consumesEventIds/${refIndex}`,
          `${action.id} consumes ${eventId}，但 Event.consumers 没有该 Action`,
        ));
      }
    });
  });
  pkg.events.forEach((event, eventIndex) => {
    event.producers.forEach((participant, participantIndex) => {
      const action = actionById.get(participant.actionId);
      if (action !== undefined && !action.emitsEventIds.includes(event.id)) {
        errors.push(issue(
          "ACTION_EVENT_RECIPROCITY",
          `/events/${eventIndex}/producers/${participantIndex}/actionId`,
          `${event.id} producer ${participant.actionId} 没有反向 emits 引用`,
        ));
      }
    });
    event.consumers.forEach((participant, participantIndex) => {
      const action = actionById.get(participant.actionId);
      if (action !== undefined && !action.consumesEventIds.includes(event.id)) {
        errors.push(issue(
          "ACTION_EVENT_RECIPROCITY",
          `/events/${eventIndex}/consumers/${participantIndex}/actionId`,
          `${event.id} consumer ${participant.actionId} 没有反向 consumes 引用`,
        ));
      }
    });
  });

  const processNodeById = new Map(pkg.processNodes.map((node) => [node.id, node] as const));
  const processEdgeById = new Map(pkg.processEdges.map((edge) => [edge.id, edge] as const));
  pkg.workflows.forEach((workflow, workflowIndex) => {
    const base = `/workflows/${workflowIndex}`;
    const members = new Set(workflow.nodeIds);
    checkRef(workflow.entryNodeId, processNodeIds, `${base}/entryNodeId`, "ProcessNode");
    if (workflow.entryNodeId !== ONTOLOGY_PACKAGE_UNKNOWN && !members.has(workflow.entryNodeId)) {
      errors.push(issue("WORKFLOW_ENTRY_MEMBER", `${base}/entryNodeId`,
        "Workflow entryNodeId 必须属于 nodeIds"));
    }
    workflow.exitNodeIds.forEach((nodeId, index) => {
      checkRef(nodeId, processNodeIds, `${base}/exitNodeIds/${index}`, "ProcessNode");
      if (!members.has(nodeId)) {
        errors.push(issue("WORKFLOW_EXIT_MEMBER", `${base}/exitNodeIds/${index}`,
          "Workflow exitNodeId 必须属于 nodeIds"));
      }
    });
    workflow.nodeIds.forEach((nodeId, index) =>
      checkRef(nodeId, processNodeIds, `${base}/nodeIds/${index}`, "ProcessNode"));
    workflow.nodeIds.forEach((nodeId, index) => {
      const node = processNodeById.get(nodeId);
      if (node?.nodeKind === "action" && node.semanticRef !== ONTOLOGY_PACKAGE_UNKNOWN &&
          !workflow.actionIds.includes(node.semanticRef)) {
        errors.push(issue("WORKFLOW_NODE_ACTION", `${base}/nodeIds/${index}`,
          `Action ProcessNode ${nodeId} 的 semanticRef 不在 workflow.actionIds`));
      }
      if (node?.nodeKind === "event" && node.semanticRef !== ONTOLOGY_PACKAGE_UNKNOWN &&
          !workflow.eventIds.includes(node.semanticRef)) {
        errors.push(issue("WORKFLOW_NODE_EVENT", `${base}/nodeIds/${index}`,
          `Event ProcessNode ${nodeId} 的 semanticRef 不在 workflow.eventIds`));
      }
    });
    workflow.actionIds.forEach((actionId, index) =>
      checkRef(actionId, actionIds, `${base}/actionIds/${index}`, "Action"));
    workflow.eventIds.forEach((eventId, index) =>
      checkRef(eventId, eventIds, `${base}/eventIds/${index}`, "Event"));
    const outgoing = new Map<string, string[]>();
    workflow.edgeIds.forEach((edgeId, index) => {
      checkRef(edgeId, processEdgeIds, `${base}/edgeIds/${index}`, "ProcessEdge");
      const edge = processEdgeById.get(edgeId);
      if (edge === undefined) return;
      if (!members.has(edge.fromNodeId) || !members.has(edge.toNodeId)) {
        errors.push(issue("WORKFLOW_EDGE_MEMBER", `${base}/edgeIds/${index}`,
          `Workflow edge ${edgeId} 的两端必须属于 nodeIds`));
      }
      appendUnique(outgoing, edge.fromNodeId, edge.toNodeId);
    });
    const visited = new Set<string>();
    const queue = workflow.entryNodeId === ONTOLOGY_PACKAGE_UNKNOWN
      ? [] : [workflow.entryNodeId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current) || !members.has(current)) continue;
      visited.add(current);
      for (const target of outgoing.get(current) ?? []) if (!visited.has(target)) queue.push(target);
    }
    workflow.nodeIds.forEach((nodeId, index) => {
      if (!visited.has(nodeId)) {
        errors.push(issue("WORKFLOW_UNREACHABLE_NODE", `${base}/nodeIds/${index}`,
          `ProcessNode ${nodeId} 无法从 entryNodeId 到达`));
      }
    });
    workflow.actionIds.forEach((actionId, index) => {
      const represented = workflow.nodeIds.some((nodeId) =>
        processNodeById.get(nodeId)?.semanticRef === actionId);
      if (!represented) errors.push(issue("WORKFLOW_ACTION_MEMBER", `${base}/actionIds/${index}`,
        `Action ${actionId} 没有对应的 member ProcessNode`));
    });
    workflow.eventIds.forEach((eventId, index) => {
      const represented = workflow.nodeIds.some((nodeId) =>
        processNodeById.get(nodeId)?.semanticRef === eventId);
      if (!represented) errors.push(issue("WORKFLOW_EVENT_MEMBER", `${base}/eventIds/${index}`,
        `Event ${eventId} 没有对应的 member ProcessNode`));
      const event = eventById.get(eventId);
      if (event !== undefined) {
        for (const participant of [...event.producers, ...event.consumers]) {
          if (!workflow.actionIds.includes(participant.actionId)) {
            errors.push(issue("WORKFLOW_EVENT_PARTICIPANT", `${base}/eventIds/${index}`,
              `Event ${eventId} 的 Action participant ${participant.actionId} 不在 workflow.actionIds`));
          }
        }
      }
    });
    checkEvidence(workflow.evidenceIds, `${base}/evidenceIds`);
  });
  pkg.rules.forEach((item, index) => {
    checkEntityStatus(item.status, `/rules/${index}/status`);
    item.dataObjectIds.forEach((ref, refIndex) =>
      checkRef(ref, objectIds, `/rules/${index}/dataObjectIds/${refIndex}`, "DataObject"));
    checkBinding(item.actorRole, `/rules/${index}/actorRole`, "role");
    checkEvidence(item.evidenceIds, `/rules/${index}/evidenceIds`);
  });
  pkg.integrations.forEach((item, index) => {
    checkRef(item.actionId, actionIds, `/integrations/${index}/actionId`, "Action");
    checkBindings(item, `/integrations/${index}`);
    checkEvidence(item.evidenceIds, `/integrations/${index}/evidenceIds`);
  });
  const questionById = new Map(pkg.questions.map((question) => [question.id, question] as const));
  pkg.gaps.forEach((item, index) => {
    checkRef(item.questionId, questionIds, `/gaps/${index}/questionId`, "Question");
    const question = questionById.get(item.questionId);
    if (item.status !== "open" && question !== undefined && question.status !== "answered") {
      errors.push(issue("GAP_QUESTION_RESOLUTION", `/gaps/${index}/status`,
        "已关闭 Gap 的 Question.status 必须为 answered"));
    }
    if (item.status === "open" && item.sourceDecisionId !== null) {
      errors.push(issue("OPEN_GAP_DECISION", `/gaps/${index}/sourceDecisionId`,
        "open Gap 不应带 sourceDecisionId"));
    }
  });
  pkg.questions.forEach((item, index) => {
    if (item.gapId !== null) checkRef(item.gapId, gapIds, `/questions/${index}/gapId`, "Gap");
    checkEvidence(item.evidenceIds, `/questions/${index}/evidenceIds`);
  });

  for (const gap of pkg.gaps) {
    if (gap.status === "open") {
      warnings.push(issue(gap.code, `/gaps/${gap.id}`, gap.message, "warning"));
    }
  }
  if (legacyValidation !== undefined) {
    for (const finding of legacyValidation.findings) {
      const severity = finding.severity === "error" ? "error" : "warning";
      const target = severity === "error" ? errors : warnings;
      target.push(issue(`LEGACY_${finding.code}`, finding.path, finding.message, severity));
    }
  }
  const legacyPassed = legacyValidation?.passed ?? pkg.validation.legacyCanonicalPassed;
  const openGapCount = pkg.gaps.filter((gap) => gap.status === "open").length;
  return {
    status: errors.length > 0 ? "invalid" : warnings.length > 0 ? "valid_with_gaps" : "valid",
    schemaVersion: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
    legacyCanonicalPassed: legacyPassed,
    errors,
    warnings,
    gapCount: pkg.gaps.length,
    openGapCount,
    resolvedGapCount: pkg.gaps.length - openGapCount,
  };
}

export type OntologyPackageV1ArtifactView =
  | "package"
  | "schema"
  | "dataObjects"
  | "links"
  | "actions"
  | "events"
  | "workflows"
  | "rules"
  | "integrations"
  | "gaps"
  | "questions";

export interface OntologyPackageV1Artifact {
  readonly name: string;
  readonly view: OntologyPackageV1ArtifactView;
  readonly mediaType: "application/json";
  readonly releaseState: typeof ONTOLOGY_PACKAGE_RELEASE_STATE;
  readonly virtual: true;
  readonly document: unknown;
  readonly content: string;
}

export const ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES: Readonly<
  Record<OntologyPackageV1ArtifactView, string>
> = Object.freeze({
  package: "ontology.package.draft.json",
  schema: "ontology-package.v1.schema.json",
  dataObjects: "data-objects.draft.json",
  links: "links.draft.json",
  actions: "actions.draft.json",
  events: "events.draft.json",
  workflows: "workflows.draft.json",
  rules: "rules.draft.json",
  integrations: "integrations.draft.json",
  gaps: "gaps.draft.json",
  questions: "questions.draft.json",
});

function viewEnvelope(
  pkg: OntologyPackageV1,
  view: Exclude<OntologyPackageV1ArtifactView, "package" | "schema">,
): Dict {
  const base: Dict = {
    schemaVersion: ONTOLOGY_PACKAGE_V1_SCHEMA_VERSION,
    packageId: pkg.packageId,
    revision: pkg.revision,
    releaseState: pkg.releaseState,
    publishable: pkg.publishable,
    view,
    items: pkg[view],
    validation: pkg.validation,
  };
  if (view === "workflows") {
    // 单独下载 workflows.draft.json 时也能解析所有 node/edge 引用。
    base["processNodes"] = pkg.processNodes;
    base["processEdges"] = pkg.processEdges;
  }
  return base;
}

function documentForArtifactView(
  pkg: OntologyPackageV1,
  view: OntologyPackageV1ArtifactView,
): unknown {
  if (view === "package") return pkg;
  if (view === "schema") return ONTOLOGY_PACKAGE_V1_JSON_SCHEMA;
  return viewEnvelope(pkg, view);
}

function artifactForView(
  pkg: OntologyPackageV1,
  view: OntologyPackageV1ArtifactView,
): OntologyPackageV1Artifact {
  const document = documentForArtifactView(pkg, view);
  return Object.freeze({
    name: ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES[view],
    view,
    mediaType: "application/json" as const,
    releaseState: ONTOLOGY_PACKAGE_RELEASE_STATE,
    virtual: true as const,
    document,
    content: pyJsonDumps(document, 2) + "\n",
  });
}

/**
 * 把内存 snapshot 变成现有 artifact/export 层可消费的 name/content 接口；不落盘。
 */
export function ontologyPackageV1Artifacts(
  pkg: OntologyPackageV1,
): readonly OntologyPackageV1Artifact[] {
  return (Object.keys(ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES) as OntologyPackageV1ArtifactView[])
    .map((view) => artifactForView(pkg, view));
}

export function resolveOntologyPackageV1Artifact(
  pkg: OntologyPackageV1,
  name: unknown,
): OntologyPackageV1Artifact | null {
  const requested = typeof name === "string" ? name : "";
  const view = (Object.entries(ONTOLOGY_PACKAGE_V1_ARTIFACT_NAMES) as
    [OntologyPackageV1ArtifactView, string][])
    .find(([, artifactName]) => artifactName === requested)?.[0];
  return view === undefined ? null : artifactForView(pkg, view);
}
