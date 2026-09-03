import { randomUUID } from "node:crypto";

import type { Store } from "../store/engine.js";
import {
  insertDocumentSecurityAudit,
  makeDocumentSecurityAuditEvent,
  type DocumentAuditAction,
  type DocumentSecurityAuditEvent,
  type DocumentSecurityAuditRepository,
} from "./audit.js";
import type { DocumentScope } from "./types.js";
import { GLOBAL_LIBRARY_PROJECT_ID } from "./types.js";

export type AclSubjectType = "principal" | "group";
export type AclEffect = "allow" | "deny";
export type AclPermission = "read" | "write" | "manage_acl";
export type AclScopeType = "project" | "document" | "version" | "chunk";

export interface AclPrincipal {
  readonly id: string;
  readonly groupIds: readonly string[];
}

export interface AclSubject {
  readonly type: AclSubjectType;
  readonly id: string;
}

export interface AclResource {
  readonly scopeType: AclScopeType;
  readonly documentId?: string;
  readonly versionId?: string;
  readonly chunkId?: string;
}

export interface AclRuleSeed {
  readonly id: string;
  readonly subject: AclSubject;
  readonly effect: AclEffect;
  readonly permission: AclPermission;
  readonly resource: AclResource;
}

export interface AclRule extends AclRuleSeed {
  readonly changedRevision: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface AclSnapshot {
  readonly boundary: DocumentScope;
  readonly revision: number;
  readonly rules: readonly AclRule[];
}

export interface ReplaceAclRulesInput {
  readonly boundary: DocumentScope;
  readonly expectedRevision: number;
  readonly rules: readonly AclRuleSeed[];
  readonly actorId: string;
  readonly eventId?: string;
  readonly occurredAt?: string;
}

export interface DocumentAclRepository {
  snapshot(boundary: DocumentScope): Promise<AclSnapshot>;
  replaceRules(input: ReplaceAclRulesInput): Promise<AclSnapshot>;
}

export class AclRevisionConflict extends Error {
  readonly code = "ACL_REVISION_CONFLICT" as const;
  readonly status = 409;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`ACL 已变化（期望 revision=${expectedRevision}，当前 revision=${actualRevision}）`);
    this.name = "AclRevisionConflict";
    Object.setPrototypeOf(this, AclRevisionConflict.prototype);
  }
}

/** 不区分不存在和无权，调用方对 HTTP 一律映射 404。 */
export class DocumentNotFoundOrForbidden extends Error {
  readonly code = "NOT_FOUND_OR_FORBIDDEN" as const;
  readonly status = 404;

  constructor(message = "没有找到这份文档，或你无权访问") {
    super(message);
    this.name = "DocumentNotFoundOrForbidden";
    Object.setPrototypeOf(this, DocumentNotFoundOrForbidden.prototype);
  }
}

const SAFE_ID = /^[\p{L}\p{N}_.:@/-]{1,256}$/u;
const SUBJECT_TYPES = new Set<AclSubjectType>(["principal", "group"]);
const EFFECTS = new Set<AclEffect>(["allow", "deny"]);
const PERMISSIONS = new Set<AclPermission>(["read", "write", "manage_acl"]);

function id(value: string, field: string): string {
  const clean = value.trim();
  if (!SAFE_ID.test(clean)) throw new Error(`${field} 不是安全标识符`);
  return clean;
}

function boundary(input: DocumentScope): DocumentScope {
  return { projectId: id(input.projectId, "projectId"), owner: id(input.owner, "owner") };
}

function resourceId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  if (!clean || clean.length > 1024 || /[\p{Cc}\p{Cs}]/u.test(clean)) {
    throw new Error(`${field} 不是安全资源标识符`);
  }
  return clean;
}

export function validateAclResource(resource: AclResource): AclResource {
  const documentId = resourceId(resource.documentId, "documentId");
  const versionId = resourceId(resource.versionId, "versionId");
  const chunkId = resourceId(resource.chunkId, "chunkId");
  const valid =
    (resource.scopeType === "project" && !documentId && !versionId && !chunkId) ||
    (resource.scopeType === "document" && !!documentId && !versionId && !chunkId) ||
    (resource.scopeType === "version" && !!documentId && !!versionId && !chunkId) ||
    (resource.scopeType === "chunk" && !!documentId && !!versionId && !!chunkId);
  if (!valid) throw new Error(`ACL ${resource.scopeType} 作用域的 id 形状不合法`);
  return {
    scopeType: resource.scopeType,
    ...(documentId === undefined ? {} : { documentId }),
    ...(versionId === undefined ? {} : { versionId }),
    ...(chunkId === undefined ? {} : { chunkId }),
  };
}

function validatePrincipal(input: AclPrincipal): AclPrincipal {
  return {
    id: id(input.id, "principalId"),
    groupIds: [...new Set(input.groupIds.map((groupId) => id(groupId, "groupId")))].sort(),
  };
}

function validateRuleSeed(input: AclRuleSeed): AclRuleSeed {
  if (!SUBJECT_TYPES.has(input.subject.type)) throw new Error("ACL subject.type 不合法");
  if (!EFFECTS.has(input.effect)) throw new Error("ACL effect 不合法");
  if (!PERMISSIONS.has(input.permission)) throw new Error("ACL permission 不合法");
  return {
    id: id(input.id, "ruleId"),
    subject: { type: input.subject.type, id: id(input.subject.id, "subjectId") },
    effect: input.effect,
    permission: input.permission,
    resource: validateAclResource(input.resource),
  };
}

function validateReplace(input: ReplaceAclRulesInput): ReplaceAclRulesInput {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error("expectedRevision 必须是非负整数");
  }
  const rules = input.rules.map(validateRuleSeed);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("ACL 规则 id 重复");
  return {
    ...input,
    boundary: boundary(input.boundary),
    actorId: id(input.actorId, "actorId"),
    ...(input.eventId === undefined ? {} : { eventId: id(input.eventId, "eventId") }),
    rules,
  };
}

function cloneRule(rule: AclRule): AclRule {
  return { ...rule, subject: { ...rule.subject }, resource: { ...rule.resource } };
}

function cloneSnapshot(snapshot: AclSnapshot): AclSnapshot {
  return {
    boundary: { ...snapshot.boundary },
    revision: snapshot.revision,
    rules: snapshot.rules.map(cloneRule),
  };
}

const keyOf = (scope: DocumentScope): string => `${scope.projectId}\u0000${scope.owner}`;

export class MemoryDocumentAclRepository implements DocumentAclRepository {
  private readonly snapshots = new Map<string, AclSnapshot>();

  constructor(private readonly audit: DocumentSecurityAuditRepository) {}

  async snapshot(input: DocumentScope): Promise<AclSnapshot> {
    const clean = boundary(input);
    const found = this.snapshots.get(keyOf(clean));
    return found === undefined
      ? { boundary: clean, revision: 0, rules: [] }
      : cloneSnapshot(found);
  }

  async replaceRules(raw: ReplaceAclRulesInput): Promise<AclSnapshot> {
    const input = validateReplace(raw);
    const before = await this.snapshot(input.boundary);
    if (before.revision !== input.expectedRevision) {
      throw new AclRevisionConflict(input.expectedRevision, before.revision);
    }
    const nextRevision = before.revision + 1;
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const next: AclSnapshot = {
      boundary: { ...input.boundary },
      revision: nextRevision,
      rules: input.rules.map((rule) => ({
        ...rule,
        subject: { ...rule.subject },
        resource: { ...rule.resource },
        changedRevision: nextRevision,
        createdBy: input.actorId,
        createdAt: occurredAt,
      })),
    };
    const changedRuleIds = [...new Set([
      ...before.rules.map((rule) => rule.id),
      ...input.rules.map((rule) => rule.id),
    ])].sort();
    const event = makeDocumentSecurityAuditEvent({
      id: input.eventId ?? `acl_${randomUUID()}`,
      boundary: input.boundary,
      actorType: "principal",
      actorId: input.actorId,
      action: "acl.change",
      decision: "changed",
      resource: { scopeType: "project" },
      aclRevision: nextRevision,
      matchedRuleIds: changedRuleIds,
      detail: { changedRuleCount: changedRuleIds.length },
      occurredAt,
    });
    this.snapshots.set(keyOf(input.boundary), next);
    try {
      await this.audit.append(event);
    } catch (error) {
      if (before.revision === 0 && before.rules.length === 0) this.snapshots.delete(keyOf(input.boundary));
      else this.snapshots.set(keyOf(input.boundary), before);
      throw error;
    }
    return cloneSnapshot(next);
  }
}

type DbRow = Readonly<Record<string, unknown>>;

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowRule(row: DbRow): AclRule {
  return {
    id: String(row["id"]),
    subject: {
      type: String(row["subject_type"]) as AclSubjectType,
      id: String(row["subject_id"]),
    },
    effect: String(row["effect"]) as AclEffect,
    permission: String(row["permission"]) as AclPermission,
    resource: validateAclResource({
      scopeType: String(row["scope_type"]) as AclScopeType,
      ...(row["document_id"] === null ? {} : { documentId: String(row["document_id"]) }),
      ...(row["version_id"] === null ? {} : { versionId: String(row["version_id"]) }),
      ...(row["chunk_id"] === null ? {} : { chunkId: String(row["chunk_id"]) }),
    }),
    changedRevision: Number(row["changed_revision"]),
    createdBy: String(row["created_by"]),
    createdAt: dateText(row["created_at"]),
  };
}

const RULE_COLUMNS =
  "id,subject_type,subject_id,effect,permission,scope_type,document_id,version_id,chunk_id," +
  "changed_revision,created_by,created_at";

export class SqlDocumentAclRepository implements DocumentAclRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlDocumentAclRepository 需要数据库 Store");
  }

  async snapshot(input: DocumentScope): Promise<AclSnapshot> {
    const clean = boundary(input);
    return this.store.engine!.begin(async (conn) => {
      const revision = Number(
        (await conn.scalar(
          "SELECT revision FROM onto_document_acl_state WHERE project_id=? AND owner=?",
          [clean.projectId, clean.owner],
        )) ?? 0,
      );
      const rows = await conn.all<DbRow>(
        `SELECT ${RULE_COLUMNS} FROM onto_document_acl_rule ` +
          "WHERE project_id=? AND owner=? ORDER BY id",
        [clean.projectId, clean.owner],
      );
      return { boundary: clean, revision, rules: rows.map(rowRule) };
    });
  }

  async replaceRules(raw: ReplaceAclRulesInput): Promise<AclSnapshot> {
    const input = validateReplace(raw);
    return this.store.engine!.begin(async (conn) => {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      await conn.exec(
        "INSERT INTO onto_document_acl_state (project_id,owner,revision,updated_by,updated_at) " +
          "VALUES (?,?,0,?,?) ON CONFLICT(project_id,owner) DO NOTHING",
        [input.boundary.projectId, input.boundary.owner, input.actorId, occurredAt],
      );
      const advanced = await conn.all<DbRow>(
        "UPDATE onto_document_acl_state SET revision=revision+1,updated_by=?,updated_at=? " +
          "WHERE project_id=? AND owner=? AND revision=? RETURNING revision",
        [
          input.actorId,
          occurredAt,
          input.boundary.projectId,
          input.boundary.owner,
          input.expectedRevision,
        ],
      );
      if (advanced[0] === undefined) {
        const actual = Number(
          (await conn.scalar(
            "SELECT revision FROM onto_document_acl_state WHERE project_id=? AND owner=?",
            [input.boundary.projectId, input.boundary.owner],
          )) ?? 0,
        );
        throw new AclRevisionConflict(input.expectedRevision, actual);
      }
      const nextRevision = Number(advanced[0]["revision"]);
      const previousRuleRows = await conn.all<DbRow>(
        "SELECT id FROM onto_document_acl_rule WHERE project_id=? AND owner=?",
        [input.boundary.projectId, input.boundary.owner],
      );
      await conn.exec(
        "DELETE FROM onto_document_acl_rule WHERE project_id=? AND owner=?",
        [input.boundary.projectId, input.boundary.owner],
      );
      for (const rule of input.rules) {
        await conn.exec(
          "INSERT INTO onto_document_acl_rule " +
            "(project_id,owner,id,subject_type,subject_id,effect,permission,scope_type," +
            "document_id,version_id,chunk_id,changed_revision,created_by,created_at) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            input.boundary.projectId,
            input.boundary.owner,
            rule.id,
            rule.subject.type,
            rule.subject.id,
            rule.effect,
            rule.permission,
            rule.resource.scopeType,
            rule.resource.documentId ?? null,
            rule.resource.versionId ?? null,
            rule.resource.chunkId ?? null,
            nextRevision,
            input.actorId,
            occurredAt,
          ],
        );
      }
      const event = makeDocumentSecurityAuditEvent({
        id: input.eventId ?? `acl_${randomUUID()}`,
        boundary: input.boundary,
        actorType: "principal",
        actorId: input.actorId,
        action: "acl.change",
        decision: "changed",
        resource: { scopeType: "project" },
        aclRevision: nextRevision,
        matchedRuleIds: [...new Set([
          ...previousRuleRows.map((row) => String(row["id"])),
          ...input.rules.map((rule) => rule.id),
        ])].sort(),
        detail: {
          changedRuleCount: new Set([
            ...previousRuleRows.map((row) => String(row["id"])),
            ...input.rules.map((rule) => rule.id),
          ]).size,
        },
        occurredAt,
      });
      await insertDocumentSecurityAudit(conn, event);
      return {
        boundary: { ...input.boundary },
        revision: nextRevision,
        rules: input.rules.map((rule) => ({
          ...rule,
          subject: { ...rule.subject },
          resource: { ...rule.resource },
          changedRevision: nextRevision,
          createdBy: input.actorId,
          createdAt: occurredAt,
        })),
      };
    });
  }
}

export interface AclDecision {
  readonly allowed: boolean;
  readonly revision: number;
  readonly matchedRuleIds: readonly string[];
  readonly reason:
    | "explicit_deny"
    | "explicit_allow"
    | "project_owner"
    /** 总知识库的默认姿态；见 resolveAcl 里那段说明。 */
    | "global_library_default"
    | "no_matching_allow";
}

function subjectMatches(rule: AclRule, principal: AclPrincipal): boolean {
  return rule.subject.type === "principal"
    ? rule.subject.id === principal.id
    : principal.groupIds.includes(rule.subject.id);
}

function resourceMatches(rule: AclResource, resource: AclResource): boolean {
  if (rule.scopeType === "project") return true;
  if (resource.scopeType === "project" || rule.documentId !== resource.documentId) return false;
  if (rule.scopeType === "document") return true;
  if (resource.scopeType === "document" || rule.versionId !== resource.versionId) return false;
  if (rule.scopeType === "version") return true;
  return resource.scopeType === "chunk" && rule.chunkId === resource.chunkId;
}

export function evaluateAcl(
  snapshot: AclSnapshot,
  rawPrincipal: AclPrincipal,
  rawResource: AclResource,
  permission: AclPermission,
): AclDecision {
  const principal = validatePrincipal(rawPrincipal);
  const resource = validateAclResource(rawResource);
  const matching = snapshot.rules.filter(
    (rule) =>
      rule.permission === permission &&
      subjectMatches(rule, principal) &&
      resourceMatches(rule.resource, resource),
  );
  const matchedRuleIds = matching.map((rule) => rule.id).sort();
  if (matching.some((rule) => rule.effect === "deny")) {
    return { allowed: false, revision: snapshot.revision, matchedRuleIds, reason: "explicit_deny" };
  }
  if (matching.some((rule) => rule.effect === "allow")) {
    return { allowed: true, revision: snapshot.revision, matchedRuleIds, reason: "explicit_allow" };
  }
  if (principal.id === snapshot.boundary.owner) {
    return { allowed: true, revision: snapshot.revision, matchedRuleIds, reason: "project_owner" };
  }
  if (snapshot.boundary.projectId === GLOBAL_LIBRARY_PROJECT_ID) {
    // 总知识库的默认姿态。
    //
    // 它跨账号共享，所以边界 owner 是部署级常量 `__global__` —— 没有人等于它，
    // 上面那条 `project_owner` 捷径永远不会命中。没有这一段，全新部署里**谁也写不进
    // 总库、也谁都改不了它的规则**（manage_acl 同样落到 no_matching_allow），
    // 这是个死锁而不是安全性。
    //
    // 今天的姿态：**已鉴权用户可读可写**。写入总库的「显式性」由产品动作保证
    // （人点「设为通用知识」，AI 只能建议），不由权限层保证 —— 这和既有纪律一致。
    // 显式 deny 规则仍然优先（上面先判 deny），所以可以随时收紧到某个人或某个组。
    //
    // 接入宿主身份系统后应收紧为：所有人可读，管理员可写 —— 那需要
    // `AclPrincipal.groupIds` 真的带上角色，今天它恒为空数组（service.ts:70 的注释
    // 说明了原因：组声明不能由 HTTP/model body 注入）。
    //
    // 用独立的 reason 而不是复用 project_owner：安全审计里必须能一眼看出这条放行
    // 来自默认姿态，而不是来自某个人真的是 owner。
    return {
      allowed: true,
      revision: snapshot.revision,
      matchedRuleIds,
      reason: "global_library_default",
    };
  }
  return { allowed: false, revision: snapshot.revision, matchedRuleIds, reason: "no_matching_allow" };
}

export interface SearchAclPlan {
  readonly aclRevision: number;
  readonly allowedTargets: readonly AclResource[];
}

export interface AuthorizedAclRead {
  readonly aclRevision: number;
  readonly matchedRuleIds: readonly string[];
}

export class DocumentAclController {
  constructor(
    private readonly repository: DocumentAclRepository,
    private readonly audit: DocumentSecurityAuditRepository,
    private readonly newAuditId: () => string = () => `dsa_${randomUUID()}`,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 只返回项目 ACL 的版本号，不返回规则正文。搜索快照用它判断权限是否在翻页
   * 期间变化；它不是授权票据，真正读取仍必须调用 authorizeRead。
   */
  async currentRevision(rawBoundary: DocumentScope): Promise<number> {
    return (await this.repository.snapshot(boundary(rawBoundary))).revision;
  }

  /** 先按无正文 resource id 生成检索白名单；调用方只能把 allowedTargets 交给检索层。 */
  async filterSearchTargets(
    rawBoundary: DocumentScope,
    rawPrincipal: AclPrincipal,
    targets: readonly AclResource[],
    detail: { readonly requestId?: string; readonly sessionId?: string; readonly querySha256?: string } = {},
  ): Promise<SearchAclPlan> {
    const cleanBoundary = boundary(rawBoundary);
    const principal = validatePrincipal(rawPrincipal);
    const cleanTargets = targets.map(validateAclResource);
    const snapshot = await this.repository.snapshot(cleanBoundary);
    const allowedTargets = cleanTargets.filter(
      (target) => evaluateAcl(snapshot, principal, target, "read").allowed,
    );
    await this.audit.append(
      makeDocumentSecurityAuditEvent({
        id: this.newAuditId(),
        boundary: cleanBoundary,
        actorType: "principal",
        actorId: principal.id,
        action: "search.filter",
        // 没有候选文档是“搜索范围为空”，不是一次权限拒绝。
        // 否则空项目每次刷新都会在管理页产生虚假的“已拒绝”记录。
        decision: cleanTargets.length === 0 || allowedTargets.length > 0 ? "allow" : "deny",
        resource: { scopeType: "project" },
        aclRevision: snapshot.revision,
        detail: {
          ...detail,
          candidateCount: cleanTargets.length,
          allowedCount: allowedTargets.length,
          deniedCount: cleanTargets.length - allowedTargets.length,
        },
        occurredAt: this.now(),
      }),
    );
    return { aclRevision: snapshot.revision, allowedTargets: [...allowedTargets] };
  }

  /** search 命中不能当授权票据；open/read 前必须调用本方法重新加载 ACL。 */
  async authorizeRead(
    rawBoundary: DocumentScope,
    rawPrincipal: AclPrincipal,
    rawResource: AclResource,
    detail: { readonly requestId?: string; readonly sessionId?: string } = {},
  ): Promise<AuthorizedAclRead> {
    const cleanBoundary = boundary(rawBoundary);
    const principal = validatePrincipal(rawPrincipal);
    const resource = validateAclResource(rawResource);
    const snapshot = await this.repository.snapshot(cleanBoundary);
    const decision = evaluateAcl(snapshot, principal, resource, "read");
    const action: DocumentAuditAction =
      resource.scopeType === "chunk"
        ? "chunk.read"
        : resource.scopeType === "version"
          ? "version.read"
          : "document.read";
    await this.audit.append(
      makeDocumentSecurityAuditEvent({
        id: this.newAuditId(),
        boundary: cleanBoundary,
        actorType: "principal",
        actorId: principal.id,
        action,
        decision: decision.allowed ? "allow" : "deny",
        resource,
        aclRevision: snapshot.revision,
        matchedRuleIds: decision.matchedRuleIds,
        detail,
        occurredAt: this.now(),
      }),
    );
    if (!decision.allowed) throw new DocumentNotFoundOrForbidden();
    return { aclRevision: snapshot.revision, matchedRuleIds: decision.matchedRuleIds };
  }

  /**
   * 写入和 ACL 管理与读取使用同一套“deny 优先”裁决。写入动作当前不复用
   * read 审计事件，避免把一次修改伪装成读取；真正的 ACL 变更仍由仓储在同一
   * 事务内写入 `acl.change` 审计。
   */
  async authorizePermission(
    rawBoundary: DocumentScope,
    rawPrincipal: AclPrincipal,
    rawResource: AclResource,
    permission: AclPermission,
  ): Promise<AuthorizedAclRead> {
    const cleanBoundary = boundary(rawBoundary);
    const principal = validatePrincipal(rawPrincipal);
    const resource = validateAclResource(rawResource);
    const snapshot = await this.repository.snapshot(cleanBoundary);
    const decision = evaluateAcl(snapshot, principal, resource, permission);
    if (!decision.allowed) throw new DocumentNotFoundOrForbidden();
    return { aclRevision: snapshot.revision, matchedRuleIds: decision.matchedRuleIds };
  }

  async authorizeWrite(
    boundary: DocumentScope,
    principal: AclPrincipal,
    resource: AclResource,
  ): Promise<AuthorizedAclRead> {
    return this.authorizePermission(boundary, principal, resource, "write");
  }

  /** ACL 查询本身也需要 manage_acl；返回的是本次裁决所用的同一个不可变快照。 */
  async snapshotForManagement(
    rawBoundary: DocumentScope,
    rawPrincipal: AclPrincipal,
  ): Promise<AclSnapshot> {
    const cleanBoundary = boundary(rawBoundary);
    const principal = validatePrincipal(rawPrincipal);
    const snapshot = await this.repository.snapshot(cleanBoundary);
    const decision = evaluateAcl(snapshot, principal, { scopeType: "project" }, "manage_acl");
    if (!decision.allowed) throw new DocumentNotFoundOrForbidden();
    return cloneSnapshot(snapshot);
  }

  async securityAudit(
    rawBoundary: DocumentScope,
    rawPrincipal: AclPrincipal,
    limit: number,
  ): Promise<readonly DocumentSecurityAuditEvent[]> {
    const cleanBoundary = boundary(rawBoundary);
    await this.authorizePermission(
      cleanBoundary,
      rawPrincipal,
      { scopeType: "project" },
      "manage_acl",
    );
    return this.audit.list(cleanBoundary, limit);
  }

  /** 同一个出口合并“不存在”和“无权”，避免 document/chunk id 探测。 */
  async readAuthorized<T>(
    boundary: DocumentScope,
    principal: AclPrincipal,
    resource: AclResource,
    load: () => Promise<T | null>,
  ): Promise<T> {
    const authorization = await this.authorizeRead(boundary, principal, resource);
    const value = await load();
    if (value === null) throw new DocumentNotFoundOrForbidden();
    // The ACL may change while storage is loading the exact document/chunk. A
    // decision made before the await is not a durable capability: fence the
    // response with the live generation so revoked content never crosses the
    // service boundary.
    if ((await this.currentRevision(boundary)) !== authorization.aclRevision) {
      throw new DocumentNotFoundOrForbidden();
    }
    return value;
  }

  /** owner 可在空 ACL 上引导；其他人必须已获 manage_acl，显式 deny 对 owner 也优先。 */
  async replaceRules(
    rawPrincipal: AclPrincipal,
    input: Omit<ReplaceAclRulesInput, "actorId">,
  ): Promise<AclSnapshot> {
    const principal = validatePrincipal(rawPrincipal);
    const cleanBoundary = boundary(input.boundary);
    const current = await this.repository.snapshot(cleanBoundary);
    const decision = evaluateAcl(current, principal, { scopeType: "project" }, "manage_acl");
    if (!decision.allowed) {
      await this.audit.append(
        makeDocumentSecurityAuditEvent({
          id: this.newAuditId(),
          boundary: cleanBoundary,
          actorType: "principal",
          actorId: principal.id,
          action: "acl.change",
          decision: "deny",
          resource: { scopeType: "project" },
          aclRevision: current.revision,
          matchedRuleIds: decision.matchedRuleIds,
          occurredAt: this.now(),
        }),
      );
      throw new DocumentNotFoundOrForbidden();
    }
    // 授权快照必须就是调用方提交的 CAS 基线。否则调用方可猜一个“未来 revision”，
    // 在授权被并发撤销后让底层 CAS 恰好命中，从而拿旧授权覆盖新策略。
    if (input.expectedRevision !== current.revision) {
      throw new AclRevisionConflict(input.expectedRevision, current.revision);
    }
    return this.repository.replaceRules({ ...input, boundary: cleanBoundary, actorId: principal.id });
  }
}

/** ACL 与安全审计必须共享同一个审计仓储，否则 ACL 变更会丢记录。 */
export function buildDocumentAclController(
  store: Store,
  audit: DocumentSecurityAuditRepository,
): DocumentAclController {
  const repository: DocumentAclRepository = store.mode === "memory"
    ? new MemoryDocumentAclRepository(audit)
    : new SqlDocumentAclRepository(store);
  return new DocumentAclController(repository, audit);
}
