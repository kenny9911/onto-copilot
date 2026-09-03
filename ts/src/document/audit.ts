import { randomUUID } from "node:crypto";

import type { Conn, Store } from "../store/engine.js";
import type { DocumentScope } from "./types.js";

export type DocumentAuditActorType = "principal" | "service";
export type DocumentAuditDecision = "allow" | "deny" | "changed";
export type DocumentAuditScopeType = "project" | "document" | "version" | "chunk";
export type DocumentAuditAction =
  | "acl.change"
  | "search.filter"
  | "document.read"
  | "version.read"
  | "chunk.read";

/** 审计详情只允许不可逆摘要和计数；这里有意不提供 message/text/query/content 字段。 */
export interface DocumentAuditDetail {
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly querySha256?: string;
  readonly candidateCount?: number;
  readonly allowedCount?: number;
  readonly deniedCount?: number;
  readonly changedRuleCount?: number;
}

export interface DocumentAuditResource {
  readonly scopeType: DocumentAuditScopeType;
  readonly documentId?: string;
  readonly versionId?: string;
  readonly chunkId?: string;
}

export interface DocumentSecurityAuditEvent extends DocumentAuditResource {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly actorType: DocumentAuditActorType;
  readonly actorId: string;
  readonly action: DocumentAuditAction;
  readonly decision: DocumentAuditDecision;
  readonly aclRevision: number;
  readonly matchedRuleIds: readonly string[];
  readonly detail: Readonly<DocumentAuditDetail>;
  readonly occurredAt: string;
}

export interface NewDocumentSecurityAuditEvent {
  readonly id?: string;
  readonly boundary: DocumentScope;
  readonly actorType: DocumentAuditActorType;
  readonly actorId: string;
  readonly action: DocumentAuditAction;
  readonly decision: DocumentAuditDecision;
  readonly resource: DocumentAuditResource;
  readonly aclRevision: number;
  readonly matchedRuleIds?: readonly string[];
  readonly detail?: Readonly<DocumentAuditDetail>;
  readonly occurredAt?: string;
}

export interface DocumentSecurityAuditRepository {
  append(event: DocumentSecurityAuditEvent): Promise<void>;
  list(boundary: DocumentScope, limit?: number): Promise<DocumentSecurityAuditEvent[]>;
}

const SAFE_ID = /^[\p{L}\p{N}_.:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTOR_TYPES = new Set<DocumentAuditActorType>(["principal", "service"]);
const ACTIONS = new Set<DocumentAuditAction>([
  "acl.change",
  "search.filter",
  "document.read",
  "version.read",
  "chunk.read",
]);
const DECISIONS = new Set<DocumentAuditDecision>(["allow", "deny", "changed"]);

function requiredId(value: string, field: string): string {
  const clean = value.trim();
  if (!SAFE_ID.test(clean)) throw new Error(`${field} 不是安全标识符`);
  return clean;
}

function optionalId(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requiredId(value, field);
}

/** chunk_id 会包含工作表名/SQL 标识符；允许可打印 Unicode 与空格，但拒绝控制字符。 */
function opaqueResourceId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(clean)) {
    throw new Error(`${field} 不是安全资源标识符`);
  }
  return clean;
}

function natural(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负整数`);
  return value;
}

function validateResource(resource: DocumentAuditResource): DocumentAuditResource {
  const documentId = opaqueResourceId(resource.documentId, "documentId");
  const versionId = opaqueResourceId(resource.versionId, "versionId");
  const chunkId = opaqueResourceId(resource.chunkId, "chunkId");
  const valid =
    (resource.scopeType === "project" && !documentId && !versionId && !chunkId) ||
    (resource.scopeType === "document" && !!documentId && !versionId && !chunkId) ||
    (resource.scopeType === "version" && !!documentId && !!versionId && !chunkId) ||
    (resource.scopeType === "chunk" && !!documentId && !!versionId && !!chunkId);
  if (!valid) throw new Error(`审计资源 ${resource.scopeType} 的 id 形状不合法`);
  return {
    scopeType: resource.scopeType,
    ...(documentId === undefined ? {} : { documentId }),
    ...(versionId === undefined ? {} : { versionId }),
    ...(chunkId === undefined ? {} : { chunkId }),
  };
}

function safeDetail(input: Readonly<DocumentAuditDetail> | undefined): DocumentAuditDetail {
  if (input === undefined) return {};
  if (input.querySha256 !== undefined && !SHA256.test(input.querySha256)) {
    throw new Error("querySha256 必须是 64 位小写十六进制摘要");
  }
  const pairs: Array<readonly [keyof DocumentAuditDetail, string | number | undefined]> = [
    ["requestId", optionalId(input.requestId, "requestId")],
    ["sessionId", optionalId(input.sessionId, "sessionId")],
    ["querySha256", input.querySha256],
    ["candidateCount", natural(input.candidateCount, "candidateCount")],
    ["allowedCount", natural(input.allowedCount, "allowedCount")],
    ["deniedCount", natural(input.deniedCount, "deniedCount")],
    ["changedRuleCount", natural(input.changedRuleCount, "changedRuleCount")],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => value !== undefined));
}

export function makeDocumentSecurityAuditEvent(
  input: NewDocumentSecurityAuditEvent,
): DocumentSecurityAuditEvent {
  if (!ACTOR_TYPES.has(input.actorType)) throw new Error("actorType 不合法");
  if (!ACTIONS.has(input.action)) throw new Error("action 不合法");
  if (!DECISIONS.has(input.decision)) throw new Error("decision 不合法");
  if (!Number.isSafeInteger(input.aclRevision) || input.aclRevision < 0) {
    throw new Error("aclRevision 必须是非负整数");
  }
  const resource = validateResource(input.resource);
  const event: DocumentSecurityAuditEvent = {
    id: requiredId(input.id ?? `dsa_${randomUUID()}`, "eventId"),
    projectId: requiredId(input.boundary.projectId, "projectId"),
    owner: requiredId(input.boundary.owner, "owner"),
    actorType: input.actorType,
    actorId: requiredId(input.actorId, "actorId"),
    action: input.action,
    decision: input.decision,
    ...resource,
    aclRevision: input.aclRevision,
    matchedRuleIds: [...new Set(input.matchedRuleIds ?? [])]
      .map((id) => requiredId(id, "matchedRuleId"))
      .sort(),
    detail: safeDetail(input.detail),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error("occurredAt 不是合法时间");
  return event;
}

function cloneEvent(event: DocumentSecurityAuditEvent): DocumentSecurityAuditEvent {
  return {
    ...event,
    matchedRuleIds: [...event.matchedRuleIds],
    detail: { ...event.detail },
  };
}

export class MemoryDocumentSecurityAuditRepository implements DocumentSecurityAuditRepository {
  private readonly events = new Map<string, DocumentSecurityAuditEvent>();

  async append(event: DocumentSecurityAuditEvent): Promise<void> {
    if (this.events.has(event.id)) throw new Error(`审计事件 id 已存在: ${event.id}`);
    // 重新走构造器，防止调用方用类型断言塞入正文键或错误资源形状。
    const checked = makeDocumentSecurityAuditEvent({
      id: event.id,
      boundary: { projectId: event.projectId, owner: event.owner },
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      decision: event.decision,
      resource: event,
      aclRevision: event.aclRevision,
      matchedRuleIds: event.matchedRuleIds,
      detail: event.detail,
      occurredAt: event.occurredAt,
    });
    this.events.set(event.id, checked);
  }

  async list(boundary: DocumentScope, limit = 100): Promise<DocumentSecurityAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit 必须在 1..1000");
    return [...this.events.values()]
      .filter((event) => event.projectId === boundary.projectId && event.owner === boundary.owner)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(cloneEvent);
  }
}

type DbRow = Readonly<Record<string, unknown>>;

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function rowEvent(row: DbRow): DocumentSecurityAuditEvent {
  return makeDocumentSecurityAuditEvent({
    id: String(row["id"]),
    boundary: { projectId: String(row["project_id"]), owner: String(row["owner"]) },
    actorType: String(row["actor_type"]) as DocumentAuditActorType,
    actorId: String(row["actor_id"]),
    action: String(row["action"]) as DocumentAuditAction,
    decision: String(row["decision"]) as DocumentAuditDecision,
    resource: {
      scopeType: String(row["scope_type"]) as DocumentAuditScopeType,
      ...(row["document_id"] === null ? {} : { documentId: String(row["document_id"]) }),
      ...(row["version_id"] === null ? {} : { versionId: String(row["version_id"]) }),
      ...(row["chunk_id"] === null ? {} : { chunkId: String(row["chunk_id"]) }),
    },
    aclRevision: Number(row["acl_revision"]),
    matchedRuleIds: json<readonly string[]>(row["matched_rule_ids"], []),
    detail: json<DocumentAuditDetail>(row["detail"], {}),
    occurredAt: row["occurred_at"] instanceof Date
      ? row["occurred_at"].toISOString()
      : String(row["occurred_at"]),
  });
}

export async function insertDocumentSecurityAudit(
  conn: Conn,
  event: DocumentSecurityAuditEvent,
): Promise<void> {
  const checked = makeDocumentSecurityAuditEvent({
    id: event.id,
    boundary: { projectId: event.projectId, owner: event.owner },
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    decision: event.decision,
    resource: event,
    aclRevision: event.aclRevision,
    matchedRuleIds: event.matchedRuleIds,
    detail: event.detail,
    occurredAt: event.occurredAt,
  });
  await conn.exec(
    "INSERT INTO onto_document_security_audit " +
      "(id,project_id,owner,actor_type,actor_id,action,decision,scope_type,document_id," +
      "version_id,chunk_id,acl_revision,matched_rule_ids,detail,occurred_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      checked.id,
      checked.projectId,
      checked.owner,
      checked.actorType,
      checked.actorId,
      checked.action,
      checked.decision,
      checked.scopeType,
      checked.documentId ?? null,
      checked.versionId ?? null,
      checked.chunkId ?? null,
      checked.aclRevision,
      JSON.stringify(checked.matchedRuleIds),
      JSON.stringify(checked.detail),
      checked.occurredAt,
    ],
  );
}

export class SqlDocumentSecurityAuditRepository implements DocumentSecurityAuditRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlDocumentSecurityAuditRepository 需要数据库 Store");
  }

  async append(event: DocumentSecurityAuditEvent): Promise<void> {
    await this.store.engine!.begin((conn) => insertDocumentSecurityAudit(conn, event));
  }

  async list(boundary: DocumentScope, limit = 100): Promise<DocumentSecurityAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit 必须在 1..1000");
    return this.store.engine!.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        "SELECT id,project_id,owner,actor_type,actor_id,action,decision,scope_type,document_id," +
          "version_id,chunk_id,acl_revision,matched_rule_ids,detail,occurred_at " +
          "FROM onto_document_security_audit WHERE project_id=? AND owner=? " +
          "ORDER BY occurred_at DESC,id DESC LIMIT ?",
        [boundary.projectId, boundary.owner, limit],
      );
      return rows.map(rowEvent);
    });
  }
}

/** 与 Store 的显式持久化选路保持一致；纯内存模式不能误装 SQL 仓储。 */
export function buildDocumentSecurityAuditRepository(
  store: Store,
): DocumentSecurityAuditRepository {
  return store.mode === "memory"
    ? new MemoryDocumentSecurityAuditRepository()
    : new SqlDocumentSecurityAuditRepository(store);
}
