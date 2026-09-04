/**
 * OntoDocument 的会话入口。
 *
 * 这里刻意没有 `/api/projects/:pid/...` 的写接口：projectId、owner 和 sessionId
 * 都从已经鉴权的 Session/请求上下文派生，浏览器和模型不能通过改一个参数越过
 * 项目边界。客户端提升材料时也只提交会话文件名；真正的 relPath 由服务端从
 * `Session.files` 解析，绝不接受任意文件系统路径。
 */

import type { Context, Hono } from "hono";

import {
  AclRevisionConflict,
  DocumentNotFoundOrForbidden,
  type AclRuleSeed,
  type AclSnapshot,
} from "../../document/acl.js";
import type { DocumentSecurityAuditEvent } from "../../document/audit.js";
import { DocumentJobFacadeError } from "../../document/job_facade.js";
import {
  DocumentJobError,
  type DocumentJobKind,
  type DocumentJobListOptions,
  type DocumentJobRecord,
  type DocumentJobStatus,
  type EnqueueDocumentJobInput,
} from "../../document/jobs.js";
import type {
  ContinueDocumentSearchInput,
  DocumentOperations,
  StartDocumentSearchInput,
  StartDocumentSearchResult,
} from "../../document/operations.js";
import {
  HybridSearchError,
  SnapshotSearchCoordinatorError,
  type CoordinatedSearchSnapshotPage,
} from "../../document/search_orchestration.js";
import { SearchSnapshotError } from "../../document/search_snapshot.js";
import {
  DocumentError,
  globalLibraryScope,
  type AttachDocumentInput,
  type DocumentAttachment,
  type DocumentFolder,
  type DocumentListOptions,
  type DocumentMetadataPatch,
  type DocumentOpenResult,
  type DocumentReadResult,
  type DocumentScope,
  type DocumentSearchOptions,
  type DocumentSearchResult,
  type DocumentSourceClass,
  type DocumentSummary,
  type DocumentVersion,
  type PromoteResult,
  type PromoteSessionFileInput,
  type SessionDocumentScope,
} from "../../document/types.js";
import type { AppEnv } from "../app.js";
import { root, sessAsync } from "../session.js";
import type { ProjectDirectory } from "./document_scope.js";
import { repoProjectDirectory, resolveGlobalScope, resolveProjectScope } from "./document_scope.js";
import { apiError, relativeToRoot } from "./sessions.js";

export interface DocumentServicePort {
  list(scope: DocumentScope, options?: DocumentListOptions): Promise<readonly DocumentSummary[]>;
  listAttachments(
    scope: DocumentScope,
    session: SessionDocumentScope,
  ): Promise<readonly DocumentAttachment[]>;
  history(scope: DocumentScope, documentId: string): Promise<readonly DocumentVersion[]>;
  promoteSessionFile(scope: DocumentScope, input: PromoteSessionFileInput): Promise<PromoteResult>;
  search(scope: DocumentScope, options: DocumentSearchOptions): Promise<DocumentSearchResult>;
  searchLayered(
    scopes: readonly DocumentScope[],
    options: DocumentSearchOptions,
  ): Promise<DocumentSearchResult>;
  open(
    scope: DocumentScope,
    options: { readonly evidenceRef: string },
  ): Promise<DocumentOpenResult>;
  listFolders(scope: DocumentScope): Promise<readonly DocumentFolder[]>;
  createFolder(scope: DocumentScope, path: string): Promise<readonly DocumentFolder[]>;
  deleteFolder(scope: DocumentScope, path: string): Promise<{ readonly movedDocuments: number }>;
  renameFolder(scope: DocumentScope, from: string, to: string): Promise<{ readonly folders: number }>;
  moveDocument(scope: DocumentScope, documentId: string, folderPath: string): Promise<DocumentSummary>;
  publishToGlobal(
    scope: DocumentScope,
    documentId: string,
    options?: { readonly versionId?: string },
  ): Promise<PromoteResult>;
  read(
    scope: DocumentScope,
    documentId: string,
    options?: {
      readonly versionId?: string;
      readonly offset?: number;
      readonly limit?: number;
    },
  ): Promise<DocumentReadResult>;
  updateMetadata(
    scope: DocumentScope,
    documentId: string,
    patch: DocumentMetadataPatch,
  ): Promise<DocumentSummary>;
  adopt(
    scope: DocumentScope,
    documentId: string,
    input: { readonly versionId: string; readonly expectedRevision: number },
  ): Promise<DocumentSummary>;
  archive(
    scope: DocumentScope,
    documentId: string,
    input: { readonly archived: boolean; readonly expectedRevision: number },
  ): Promise<DocumentSummary>;
  attach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    input: AttachDocumentInput,
  ): Promise<DocumentAttachment>;
  detach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
  ): Promise<boolean>;
  aclSnapshot(scope: DocumentScope): Promise<AclSnapshot>;
  replaceAclRules(
    scope: DocumentScope,
    input: { readonly expectedRevision: number; readonly rules: readonly AclRuleSeed[] },
  ): Promise<AclSnapshot>;
  securityAudit(
    scope: DocumentScope,
    limit?: number,
  ): Promise<readonly DocumentSecurityAuditEvent[]>;
}

export interface DocumentRouteSession {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly files: readonly {
    readonly name: string;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

export interface DocumentRouteDeps {
  readonly documents: DocumentServicePort;
  readonly operations?: Pick<
    DocumentOperations,
    "enqueueJob" | "listJobs" | "getJob" | "cancelJob" | "startSearch" | "continueSearch"
  >;
  /** 测试缝；生产默认走会 hydrate 的 sessAsync。 */
  readonly sessionById?: (sid: string) => Promise<DocumentRouteSession>;
  /** 项目目录。生产默认落在仓储上；HTTP 测试注入桩，避免起整套 store。 */
  readonly projects?: ProjectDirectory;
}

interface RouteScope {
  readonly scope: DocumentScope;
  readonly session: SessionDocumentScope;
  readonly source: DocumentRouteSession;
  /** 本次调用背后的真人；写操作的 created_by 用它，不用 scope.owner。 */
  readonly actorId: string;
  /** 本次顺手建了默认项目 —— 必须透给前端，见 document_scope.ts 的第 2 条纪律。 */
  readonly projectAutoCreated: boolean;
  readonly projectName: string;
}

const BOUNDARY_FIELDS = new Set([
  "owner",
  "owner_id",
  "ownerId",
  "principal",
  "principal_id",
  "principalId",
  "actor",
  "actor_id",
  "actorId",
  "project",
  "project_id",
  "projectId",
  "session",
  "session_id",
  "sessionId",
  "path",
  "file_path",
  "filePath",
  "rel_path",
  "relPath",
  "source_path",
  "sourcePath",
]);

const SENSITIVE_FIELD_PARTS = new Set([
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "url",
  "urls",
  "uri",
  "uris",
  "path",
  "paths",
  "project",
  "projects",
  "owner",
  "owners",
  "actor",
  "actors",
  "principal",
  "principals",
]);

const SOURCE_CLASSES: ReadonlySet<string> = new Set([
  "session_upload",
  "generated",
  "external",
  "imported",
]);

function field(body: Readonly<Record<string, unknown>>, ...names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(body, name)) return body[name];
  }
  return undefined;
}

function sensitiveFieldPart(key: string): string | undefined {
  if (BOUNDARY_FIELDS.has(key)) return key;
  const parts = key
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1_$2")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const forbidden = parts.find((part) => SENSITIVE_FIELD_PARTS.has(part));
  if (forbidden !== undefined) return forbidden;
  // 常见凭据名即使没有分隔符也不能穿过边界；普通的 idempotency_key 等业务键不受影响。
  const compact = parts.join("");
  if (["apikey", "accesskey", "privatekey", "signingkey", "encryptionkey"].includes(compact)) {
    return compact;
  }
  return undefined;
}

function rejectBoundaryFields(values: Iterable<string>): void {
  const invalid = [...new Set([...values].filter((key) => sensitiveFieldPart(key) !== undefined))];
  if (invalid.length === 0) return;
  throw apiError(
    400,
    `请不要提交 ${invalid.join("、")}；项目、账号、凭据、外部地址和文件位置由当前会话自动确定。`,
  );
}

function rejectBoundaryBody(body: Readonly<Record<string, unknown>>): void {
  // 不能只检查顶层：options/metadata 等 JSON 容器可能把凭据或越权边界藏在任意深度。
  // 使用显式栈，避免恶意深层 JSON 触发调用栈溢出。
  const pending: unknown[] = [body];
  let inspected = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      inspected += value.length;
      if (inspected > 100_000) throw apiError(400, "请求字段过多");
      for (const child of value) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      inspected += 1;
      if (inspected > 100_000) throw apiError(400, "请求字段过多");
      rejectBoundaryFields([key]);
      pending.push(child);
    }
  }
}

function rejectBoundaryQuery(c: Context<AppEnv>): void {
  rejectBoundaryFields(new URL(c.req.url).searchParams.keys());
}

function requiredText(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw apiError(400, `${label}不能为空`);
  }
  const text = value.trim();
  if ([...text].length > max) throw apiError(400, `${label}不能超过 ${max} 个字`);
  if (text.includes("\u0000")) throw apiError(400, `${label}包含无效字符`);
  return text;
}

function optionalText(value: unknown, label: string, max = 512): string | undefined {
  return value === undefined ? undefined : requiredText(value, label, max);
}

function opaqueId(value: unknown, label: string): string {
  const id = requiredText(value, label, 2_048);
  // ID/证据引用都是不透明标识，不是路径。反斜杠和 `..` 一并挡住，免得未来某个
  // 仓储实现错误地把它拼进文件名后变成路径穿越。
  if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw apiError(404, `没有这份${label}`);
  }
  return id;
}

function expectedRevision(body: Readonly<Record<string, unknown>>): number {
  const raw = field(body, "expected_revision", "expectedRevision");
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    throw apiError(400, "expected_revision 必须是非负整数；请先刷新文档后再修改。");
  }
  return raw as number;
}

function tags(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw apiError(400, "tags 必须是文字数组");
  const unique = new Set<string>();
  for (const item of value) {
    const tag = requiredText(item, "标签", 80);
    unique.add(tag);
    if (unique.size > 50) throw apiError(400, "一份文档最多设置 50 个标签");
  }
  return [...unique];
}

function sourceClass(value: unknown): DocumentSourceClass | undefined {
  if (value === undefined) return undefined;
  const normalized = requiredText(value, "文档来源分类", 40);
  const aliases: Readonly<Record<string, DocumentSourceClass>> = {
    "会话材料": "session_upload",
    "临时材料": "session_upload",
    "系统生成": "generated",
    "外部文件": "external",
    "导入文件": "imported",
  };
  const resolved = aliases[normalized] ?? normalized;
  if (!SOURCE_CLASSES.has(resolved)) {
    throw apiError(400, "classification 只支持：会话材料、系统生成、外部文件、导入文件");
  }
  return resolved as DocumentSourceClass;
}

function boolQuery(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw apiError(400, `${label} 只支持 true 或 false`);
}

function limitQuery(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/u.test(value)) throw apiError(400, "limit 必须是正整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100) {
    throw apiError(400, "limit 必须在 1 到 100 之间");
  }
  return parsed;
}

function auditLimitQuery(value: string | undefined): number {
  if (value === undefined || value === "") return 100;
  if (!/^[1-9]\d*$/u.test(value)) throw apiError(400, "limit 必须是正整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 200) {
    throw apiError(400, "limit 必须在 1 到 200 之间");
  }
  return parsed;
}

/** 阅读器的每页段数。上限 500：再多一次响应就大到没人读得完，也拖慢首屏。 */
function readLimitQuery(value: string | undefined): number {
  if (value === undefined || value === "") return 100;
  if (!/^[1-9]\d*$/u.test(value)) throw apiError(400, "limit 必须是正整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 500) {
    throw apiError(400, "limit 必须在 1 到 500 之间");
  }
  return parsed;
}

function offsetQuery(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/u.test(value)) throw apiError(400, "offset 必须是非负整数");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) {
    throw apiError(400, "offset 必须在 0 到 1000000 之间");
  }
  return parsed;
}

function integerBody(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw apiError(400, `${label} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return value as number;
}

function booleanBody(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw apiError(400, `${label} 必须是 true 或 false`);
  return value;
}

function onlyFields(body: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw apiError(400, `不支持的${label}字段：${unknown.join("、")}`);
}

function onlyQueryFields(c: Context<AppEnv>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = [...new URL(c.req.url).searchParams.keys()].filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw apiError(400, `不支持的${label}参数：${[...new Set(unknown)].join("、")}`);
}

async function strictJsonBody(
  c: Context<AppEnv>,
  options: { readonly allowEmpty?: boolean } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const text = await c.req.text();
  if (text.trim() === "") {
    if (options.allowEmpty === true) return {};
    throw apiError(400, "请求体必须是 JSON 对象");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw apiError(400, "请求体不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw apiError(400, "请求体必须是 JSON 对象");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

const JOB_OPTION_FORBIDDEN_FIELDS = new Set([
  ...BOUNDARY_FIELDS,
  "url",
  "uri",
  "endpoint",
  "host",
  "hostname",
  "credential",
  "credential_ref",
  "credentialRef",
  "token",
  "password",
  "secret",
  "api_key",
  "apiKey",
  "user",
  "user_id",
  "userId",
  "account",
]);

function safeJobOptions(value: unknown): unknown {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw apiError(400, "options 必须是对象");
  }
  let fields = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (depth > 8) throw apiError(400, "options 最多嵌套 8 层");
    if (typeof item === "string") {
      const text = item.trim();
      if (/^(?:https?|file|s3):\/\//iu.test(text) || /^\/|^[A-Za-z]:[\\/]/u.test(text)) {
        throw apiError(400, "options 不能包含文件路径或外部 URL");
      }
      return;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") return;
    if (Array.isArray(item)) {
      if (item.length > 1_000) throw apiError(400, "options 数组最多包含 1000 项");
      for (const child of item) inspect(child, depth + 1);
      return;
    }
    if (typeof item !== "object") throw apiError(400, "options 只能包含 JSON 数据");
    for (const [key, child] of Object.entries(item)) {
      fields += 1;
      if (fields > 500) throw apiError(400, "options 字段过多");
      if (JOB_OPTION_FORBIDDEN_FIELDS.has(key)) {
        throw apiError(400, `options 不能提交 ${key}；身份、文件位置和外部来源由服务端确定。`);
      }
      inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized.length > 64 * 1_024) throw apiError(400, "options 不能超过 64KB");
  return structuredClone(value);
}

function jobKind(value: unknown): DocumentJobKind {
  if (value !== "parse" && value !== "ocr") throw apiError(400, "kind 只支持 parse 或 ocr");
  return value;
}

function jobStatusQuery(value: string | undefined): DocumentJobStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value !== "queued" &&
    value !== "running" &&
    value !== "succeeded" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw apiError(400, "status 过滤条件无效");
  }
  return value;
}

function jobKindQuery(value: string | undefined): DocumentJobKind | undefined {
  if (value === undefined || value === "") return undefined;
  return jobKind(value);
}

async function routeScope(c: Context<AppEnv>, deps: DocumentRouteDeps): Promise<RouteScope> {
  const sid = requiredText(c.req.param("sid"), "会话 ID", 256);
  const resolved = await resolveProjectScope(
    c,
    sid,
    deps.sessionById ?? sessAsync,
    deps.projects ?? repoProjectDirectory(),
  );
  return {
    scope: resolved.scope,
    session: { ...resolved.scope, sessionId: resolved.source.id },
    source: resolved.source,
    actorId: resolved.actorId,
    projectAutoCreated: resolved.projectAutoCreated,
    projectName: resolved.projectName,
  };
}

function messageOf(error: DocumentError): string {
  switch (error.code) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      return "没有找到这份项目文档。它可能已移到别的项目，或你没有访问权限。";
    case "REVISION_CONFLICT":
      return "这份文档刚刚被其他人修改过。请刷新后再提交，系统没有覆盖对方的修改。";
    case "BASE_VERSION_CONFLICT":
      return "知识库里已经有更新版本。请先查看版本历史，再决定是否继续上传。";
    case "PARSE_FAILED":
      return `文件已经收到，但没有成功读出可核验内容：${error.message}`;
    case "INTEGRITY_ERROR":
      return "这次修改无法安全保存，知识库仍保持原样。请刷新后重试。";
    case "INVALID_ARGUMENT":
      return error.message;
  }
}

async function documentCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof DocumentNotFoundOrForbidden) {
      throw apiError(
        404,
        "没有找到这份项目文档。它可能已移到别的项目，或你没有访问权限。",
      );
    }
    if (error instanceof AclRevisionConflict) {
      throw apiError(
        409,
        "权限设置刚刚被其他人修改。请刷新后再提交，系统没有覆盖对方的设置。",
      );
    }
    if (!(error instanceof DocumentError)) throw error;
    const status = error.code === "FORBIDDEN" ? 404 : error.status;
    throw apiError(status, messageOf(error));
  }
}

async function operationCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await documentCall(body);
  } catch (error) {
    if (error instanceof DocumentJobError) {
      const status = error.code === "NOT_FOUND"
        ? 404
        : error.code === "IDEMPOTENCY_CONFLICT"
          ? 409
          : error.code === "LEASE_LOST" || error.code === "TARGET_CHANGED"
            ? 409
            : 400;
      throw apiError(status, error.code === "NOT_FOUND" ? "没有找到这份文档的精确版本。" : error.message);
    }
    if (error instanceof DocumentJobFacadeError) {
      const status = error.code === "NOT_FOUND"
        ? 404
        : error.code === "INVALID_STATE" || error.code === "COMMIT_RESULT_INVALID"
          ? 409
          : error.code === "INTEGRITY_ERROR"
            ? 409
            : 400;
      throw apiError(status, error.code === "NOT_FOUND" ? "没有找到这个处理任务。" : error.message);
    }
    if (error instanceof SearchSnapshotError) {
      const status = error.code === "NOT_FOUND"
        ? 404
        : error.code === "CURSOR_INVALID" || error.code === "INVALID_ARGUMENT"
          ? 400
          : 409;
      throw apiError(status, error.message);
    }
    if (error instanceof HybridSearchError) {
      const status = error.code === "INVALID_ARGUMENT" ? 400 : 409;
      throw apiError(status, error.message);
    }
    if (error instanceof SnapshotSearchCoordinatorError) {
      const status = error.code === "INVALID_ARGUMENT" || error.code === "QUERY_MISMATCH"
        ? 400
        : error.code === "EMPTY_RESULT"
          ? 422
          : 409;
      throw apiError(status, error.message);
    }
    throw error;
  }
}

const ACL_ID = /^[\p{L}\p{N}_.:@/-]{1,256}$/u;
const ACL_AUTHORITY_FIELDS = new Set([
  "owner",
  "owner_id",
  "ownerId",
  "project",
  "project_id",
  "projectId",
  "principal",
  "principal_id",
  "principalId",
  "actor",
  "actor_id",
  "actorId",
]);

function rejectAclAuthorityFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectAclAuthorityFields(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (ACL_AUTHORITY_FIELDS.has(key)) {
      throw apiError(400, `请不要提交 ${key}；权限操作者和项目边界由当前会话自动确定。`);
    }
    rejectAclAuthorityFields(child);
  }
}

function aclId(value: unknown, label: string, max = 256): string {
  const clean = requiredText(value, label, max);
  if (!ACL_ID.test(clean)) throw apiError(400, `${label}包含不支持的字符`);
  return clean;
}

function aclRuleSeeds(value: unknown): readonly AclRuleSeed[] {
  if (!Array.isArray(value)) throw apiError(400, "rules 必须是权限规则数组");
  if (value.length > 1_000) throw apiError(400, "一次最多设置 1000 条权限规则");
  const rules = value.map((raw, index): AclRuleSeed => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw apiError(400, `第 ${index + 1} 条权限规则必须是对象`);
    }
    const rule = raw as Readonly<Record<string, unknown>>;
    onlyFields(rule, new Set(["id", "subject", "effect", "permission", "resource"]), "权限规则");
    const subjectRaw = rule["subject"];
    const resourceRaw = rule["resource"];
    if (typeof subjectRaw !== "object" || subjectRaw === null || Array.isArray(subjectRaw)) {
      throw apiError(400, `第 ${index + 1} 条规则缺少 subject`);
    }
    if (typeof resourceRaw !== "object" || resourceRaw === null || Array.isArray(resourceRaw)) {
      throw apiError(400, `第 ${index + 1} 条规则缺少 resource`);
    }
    const subject = subjectRaw as Readonly<Record<string, unknown>>;
    const resource = resourceRaw as Readonly<Record<string, unknown>>;
    onlyFields(subject, new Set(["type", "id"]), "权限主体");
    onlyFields(
      resource,
      new Set([
        "scope_type",
        "scopeType",
        "document_id",
        "documentId",
        "version_id",
        "versionId",
        "chunk_id",
        "chunkId",
      ]),
      "权限资源",
    );
    const subjectType = requiredText(subject["type"], "subject.type", 32);
    if (subjectType !== "principal" && subjectType !== "group") {
      throw apiError(400, "subject.type 只支持 principal 或 group");
    }
    const effect = requiredText(rule["effect"], "effect", 32);
    if (effect !== "allow" && effect !== "deny") {
      throw apiError(400, "effect 只支持 allow 或 deny");
    }
    const permission = requiredText(rule["permission"], "permission", 32);
    if (permission !== "read" && permission !== "write" && permission !== "manage_acl") {
      throw apiError(400, "permission 只支持 read、write 或 manage_acl");
    }
    const scopeType = requiredText(
      field(resource, "scope_type", "scopeType"),
      "resource.scope_type",
      32,
    );
    if (!["project", "document", "version", "chunk"].includes(scopeType)) {
      throw apiError(400, "resource.scope_type 只支持 project、document、version 或 chunk");
    }
    const documentId = optionalText(field(resource, "document_id", "documentId"), "文档 ID", 2_048);
    const versionId = optionalText(field(resource, "version_id", "versionId"), "版本 ID", 2_048);
    const chunkId = optionalText(field(resource, "chunk_id", "chunkId"), "切片 ID", 2_048);
    const validShape =
      (scopeType === "project" && documentId === undefined && versionId === undefined && chunkId === undefined) ||
      (scopeType === "document" && documentId !== undefined && versionId === undefined && chunkId === undefined) ||
      (scopeType === "version" && documentId !== undefined && versionId !== undefined && chunkId === undefined) ||
      (scopeType === "chunk" && documentId !== undefined && versionId !== undefined && chunkId !== undefined);
    if (!validShape) throw apiError(400, `${scopeType} 权限规则的资源 ID 不完整或多余`);
    return {
      id: aclId(rule["id"], "规则 ID"),
      subject: { type: subjectType, id: aclId(subject["id"], "subject.id") },
      effect,
      permission,
      resource: {
        scopeType,
        ...(documentId === undefined ? {} : { documentId }),
        ...(versionId === undefined ? {} : { versionId }),
        ...(chunkId === undefined ? {} : { chunkId }),
      },
    };
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw apiError(400, "权限规则 ID 不能重复");
  }
  return rules;
}

function aclView(snapshot: AclSnapshot): Record<string, unknown> {
  return {
    revision: snapshot.revision,
    rules: snapshot.rules.map((rule) => ({
      id: rule.id,
      subject: rule.subject,
      effect: rule.effect,
      permission: rule.permission,
      resource: {
        scope_type: rule.resource.scopeType,
        ...(rule.resource.documentId === undefined ? {} : { document_id: rule.resource.documentId }),
        ...(rule.resource.versionId === undefined ? {} : { version_id: rule.resource.versionId }),
        ...(rule.resource.chunkId === undefined ? {} : { chunk_id: rule.resource.chunkId }),
      },
      changed_revision: rule.changedRevision,
      created_by: rule.createdBy,
      created_at: rule.createdAt,
    })),
  };
}

function securityAuditView(events: readonly DocumentSecurityAuditEvent[]): Record<string, unknown> {
  return {
    events: events.map((event) => ({
      action: event.action,
      decision: event.decision,
      scope_type: event.scopeType,
      ...(event.documentId === undefined ? {} : { document_id: event.documentId }),
      ...(event.versionId === undefined ? {} : { version_id: event.versionId }),
      ...(event.chunkId === undefined ? {} : { chunk_id: event.chunkId }),
      acl_revision: event.aclRevision,
      ...(event.detail.querySha256 === undefined ? {} : { query_sha256: event.detail.querySha256 }),
      ...(event.detail.candidateCount === undefined ? {} : { candidate_count: event.detail.candidateCount }),
      ...(event.detail.allowedCount === undefined ? {} : { allowed_count: event.detail.allowedCount }),
      ...(event.detail.deniedCount === undefined ? {} : { denied_count: event.detail.deniedCount }),
      ...(event.detail.changedRuleCount === undefined
        ? {}
        : { changed_rule_count: event.detail.changedRuleCount }),
    })),
  };
}

function folderView(folder: DocumentFolder): Record<string, unknown> {
  return { path: folder.path, created_at: folder.createdAt };
}

function documentView(document: DocumentSummary): Record<string, unknown> {
  return {
    folder_path: document.folderPath,
    id: document.id,
    title: document.title,
    logical_name: document.logicalName,
    source_class: document.sourceClass,
    tags: document.tags,
    status: document.status,
    current_version_id: document.currentVersionId,
    adopted_version_id: document.adoptedVersionId,
    revision: document.revision,
    created_by: document.createdBy,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

function versionView(version: DocumentVersion): Record<string, unknown> {
  return {
    id: version.id,
    document_id: version.documentId,
    version_no: version.versionNo,
    file_name: version.fileName,
    media_type: version.mediaType,
    size_bytes: version.sizeBytes,
    sha256: version.sha256,
    doc_kind: version.docKind,
    parse_status: version.parseStatus,
    parser_name: version.parserName,
    parser_version: version.parserVersion,
    index_revision: version.indexRevision,
    chunk_count: version.chunkCount,
    created_by: version.createdBy,
    created_at: version.createdAt,
  };
}

function attachmentView(attachment: DocumentAttachment): Record<string, unknown> {
  return {
    document_id: attachment.documentId,
    version_id: attachment.versionId,
    role: attachment.role,
    attached_by: attachment.attachedBy,
    attached_at: attachment.attachedAt,
  };
}

function searchHitView(hit: DocumentSearchResult["hits"][number]): Record<string, unknown> {
  return {
    evidence_ref: hit.evidenceRef,
    cite: hit.displayCite,
    // 这条命中来自总库还是项目库。界面和模型都必须能分辨 ——
    // 把一份行业通用制度当成这个客户自己的规定，是这个产品最不能出的错。
    level: hit.level,
    // 这段在另一层也有（设为通用知识是复制）。界面用它显示「总库也有」。
    also_in_level: hit.alsoInLevel ?? null,
    document_id: hit.documentId,
    version_id: hit.versionId,
    version_no: hit.versionNo,
    document_title: hit.documentTitle,
    file_name: hit.fileName,
    chunk_id: hit.chunkId,
    locator: hit.locator,
    text: hit.text,
    text_sha256: hit.textSha256,
    score: hit.score,
    coverage: hit.coverage,
  };
}

function searchView(result: DocumentSearchResult): Record<string, unknown> {
  return {
    query: result.query,
    hits: result.hits.map(searchHitView),
    // 截断前的总数。界面写「找到 N 处材料片段」时必须用它，
    // 否则超过 limit 那一刻这句话就是假的。
    total: result.total,
    searched_versions: result.searchedVersions,
    coverage: result.coverage,
  };
}

function safeJobFailure(job: DocumentJobRecord): string {
  if (job.status !== "failed") return "";
  return job.kind === "ocr"
    ? "识别没有完成；源版本没有修改。请检查文件是否清晰、格式是否受支持后重新提交。"
    : "解析没有完成；源版本没有修改。请检查文件格式后重新提交。";
}

function jobView(job: DocumentJobRecord): Record<string, unknown> {
  const candidateReady =
    job.status === "succeeded" &&
    typeof job.result === "object" &&
    job.result !== null &&
    !Array.isArray(job.result) &&
    (job.result as { readonly type?: unknown }).type === "onto_document_parse_candidate";
  return {
    id: job.id,
    document_id: job.documentId,
    version_id: job.versionId,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    candidate_ready: candidateReady,
    result_sha256: candidateReady ? job.resultSha256 : "",
    last_error: safeJobFailure(job),
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
  };
}

function snapshotView(
  page: CoordinatedSearchSnapshotPage,
): Record<string, unknown> {
  return {
    id: page.snapshotId,
    manifest_sha256: page.manifestSha256,
    acl_revision: page.aclRevision,
    total_items: page.totalItems,
    expires_at: page.expiresAt,
  };
}

function startedSearchView(result: StartDocumentSearchResult): Record<string, unknown> {
  if (result.snapshot === null || result.page === null) {
    return {
      query: result.search.query,
      mode: result.ranking.mode,
      method: result.ranking.method,
      semantic: result.ranking.semantic,
      snapshot: null,
      hits: [],
      next_cursor: null,
      evidence_available: false,
      searched_versions: result.search.searchedVersions,
      coverage: result.search.coverage,
      message:
        "在本次检索范围内没有找到匹配段落。这不表示文件或业务事实不存在；" +
        "可以换一个说法、扩大检索范围，或先检查材料是否已成功解析。",
    };
  }
  return {
    query: result.search.query,
    mode: result.ranking.mode,
    method: result.ranking.method,
    semantic: result.ranking.semantic,
    snapshot: snapshotView(result.page),
    hits: result.page.hits.map(searchHitView),
    next_cursor: result.page.nextCursor,
    evidence_available: result.page.hits.length > 0,
    searched_versions: result.search.searchedVersions,
    coverage: result.search.coverage,
    message: `已固定 ${result.page.totalItems} 条可核验材料证据；继续翻页不会切换到别的版本。`,
  };
}

function continuedSearchView(page: CoordinatedSearchSnapshotPage): Record<string, unknown> {
  return {
    snapshot: snapshotView(page),
    query_sha256: page.querySha256,
    hits: page.hits.map(searchHitView),
    next_cursor: page.nextCursor,
    evidence_available: page.hits.length > 0,
  };
}

function openView(result: DocumentOpenResult): Record<string, unknown> {
  return {
    ...searchHitView(result),
    context: result.context,
    tags: result.tags,
  };
}

function registerDocumentOperationRoutes(
  app: Hono<AppEnv>,
  deps: DocumentRouteDeps,
  operations: NonNullable<DocumentRouteDeps["operations"]>,
): void {
  app.post("/api/sessions/:sid/documents/jobs", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "任务创建");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set([
        "document_id",
        "documentId",
        "version_id",
        "versionId",
        "kind",
        "idempotency_key",
        "idempotencyKey",
        "options",
      ]),
      "任务",
    );
    const { scope } = await routeScope(c, deps);
    const kind = jobKind(body["kind"]);
    const input: EnqueueDocumentJobInput = {
      documentId: opaqueId(field(body, "document_id", "documentId"), "文档"),
      versionId: opaqueId(field(body, "version_id", "versionId"), "版本"),
      kind,
      idempotencyKey: requiredText(
        field(body, "idempotency_key", "idempotencyKey"),
        "idempotency_key",
        512,
      ),
      input: safeJobOptions(body["options"]),
      // OCR 会产生模型费用，HTTP 不允许把重试次数任意调大。
      maxAttempts: kind === "ocr" ? 2 : 3,
    };
    const job = await operationCall(async () => await operations.enqueueJob(scope, input));
    return c.json({
      ok: true,
      message: kind === "ocr"
        ? "已加入识别队列。处理结果只是候选内容，不会自动替换或采用原文档版本。"
        : "已加入解析队列。处理结果只是候选内容，不会自动替换或采用原文档版本。",
      job: jobView(job),
    }, 202);
  });

  app.get("/api/sessions/:sid/documents/jobs", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["status", "kind", "document_id", "limit", "offset"]), "任务列表");
    const { scope } = await routeScope(c, deps);
    const status = jobStatusQuery(c.req.query("status"));
    const kind = jobKindQuery(c.req.query("kind"));
    const rawDocumentId = c.req.query("document_id");
    const documentId = rawDocumentId === undefined || rawDocumentId === ""
      ? undefined
      : opaqueId(rawDocumentId, "文档");
    const limit = limitQuery(c.req.query("limit"));
    const offset = offsetQuery(c.req.query("offset"));
    const options: DocumentJobListOptions = {
      ...(status === undefined ? {} : { status }),
      ...(kind === undefined ? {} : { kind }),
      ...(documentId === undefined ? {} : { documentId }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    };
    const page = await operationCall(async () => await operations.listJobs(scope, options));
    return c.json({
      jobs: page.items.map(jobView),
      offset: page.offset,
      next_offset: page.nextOffset,
    });
  });

  app.get("/api/sessions/:sid/documents/jobs/:jobId", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "任务");
    const { scope } = await routeScope(c, deps);
    const jobId = opaqueId(c.req.param("jobId"), "任务");
    const job = await operationCall(async () => await operations.getJob(scope, jobId));
    if (job === null) throw apiError(404, "没有找到这个处理任务。");
    return c.json({ job: jobView(job) });
  });

  app.delete("/api/sessions/:sid/documents/jobs/:jobId", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "任务");
    const body = await strictJsonBody(c, { allowEmpty: true });
    rejectBoundaryBody(body);
    onlyFields(body, new Set(), "任务取消");
    const { scope } = await routeScope(c, deps);
    const jobId = opaqueId(c.req.param("jobId"), "任务");
    const job = await operationCall(async () => await operations.cancelJob(scope, jobId));
    if (job === null) throw apiError(404, "没有找到这个处理任务。");
    return c.json({
      ok: true,
      message: job.status === "cancelled"
        ? "已取消处理任务；源文档版本没有修改。"
        : "任务已经结束，系统没有改写它的最终状态，也没有自动采用候选结果。",
      job: jobView(job),
    });
  });

  app.post("/api/sessions/:sid/documents/search-snapshots", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "搜索");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set([
        "query",
        "limit",
        "document_ids",
        "documentIds",
        "attached_only",
        "attachedOnly",
        "page_size",
        "pageSize",
        "ttl_ms",
        "ttlMs",
      ]),
      "搜索",
    );
    const { scope, session } = await routeScope(c, deps);
    const rawIds = field(body, "document_ids", "documentIds");
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      throw apiError(400, "document_ids 必须是文档 ID 数组");
    }
    const documentIds = (rawIds as readonly unknown[] | undefined)?.map((id) => opaqueId(id, "文档"));
    if ((documentIds?.length ?? 0) > 100) throw apiError(400, "一次最多筛选 100 份文档");
    const attachedOnly = booleanBody(field(body, "attached_only", "attachedOnly"), "attached_only");
    const limit = integerBody(body["limit"], "limit", 1, 100);
    const pageSize = integerBody(field(body, "page_size", "pageSize"), "page_size", 1, 100);
    const ttlMs = integerBody(field(body, "ttl_ms", "ttlMs"), "ttl_ms", 1_000, 24 * 60 * 60_000);
    const options: DocumentSearchOptions = {
      query: requiredText(body["query"], "搜索内容", 2_000),
      ...(limit === undefined ? {} : { limit }),
      ...(documentIds === undefined || documentIds.length === 0 ? {} : { documentIds }),
      ...(attachedOnly === true ? { sessionId: session.sessionId } : {}),
    };
    const input: StartDocumentSearchInput = {
      options,
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    };
    const result = await operationCall(async () => await operations.startSearch(scope, input));
    return c.json(startedSearchView(result));
  });

  app.post("/api/sessions/:sid/documents/search-snapshots/:snapshotId/page", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "搜索续页");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(body, new Set(["query", "cursor", "limit"]), "搜索续页");
    const { scope } = await routeScope(c, deps);
    const cursor = optionalText(body["cursor"], "cursor", 16_384);
    const limit = integerBody(body["limit"], "limit", 1, 100);
    const input: ContinueDocumentSearchInput = {
      snapshotId: opaqueId(c.req.param("snapshotId"), "搜索快照"),
      query: requiredText(body["query"], "搜索内容", 2_000),
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    };
    const page = await operationCall(async () => await operations.continueSearch(scope, input));
    return c.json(continuedSearchView(page));
  });
}

export function registerDocumentRoutes(app: Hono<AppEnv>, deps: DocumentRouteDeps): void {
  if (deps.operations !== undefined) registerDocumentOperationRoutes(app, deps, deps.operations);

  app.get("/api/sessions/:sid/documents/acl", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "权限");
    const { scope } = await routeScope(c, deps);
    const snapshot = await documentCall(async () => await deps.documents.aclSnapshot(scope));
    return c.json(aclView(snapshot));
  });

  app.put("/api/sessions/:sid/documents/acl", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "权限更新");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    rejectAclAuthorityFields(body);
    const allowedFields = new Set(["expected_revision", "expectedRevision", "rules"]);
    const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unknown.length > 0) throw apiError(400, `不支持的权限字段：${unknown.join("、")}`);
    const { scope } = await routeScope(c, deps);
    const snapshot = await documentCall(async () => await deps.documents.replaceAclRules(scope, {
      expectedRevision: expectedRevision(body),
      rules: aclRuleSeeds(body["rules"]),
    }));
    return c.json({
      ok: true,
      message: "权限设置已更新。新的读取和搜索请求会立即按这版规则执行。",
      ...aclView(snapshot),
    });
  });

  app.get("/api/sessions/:sid/documents/audit", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["limit"]), "审计");
    const { scope } = await routeScope(c, deps);
    const events = await documentCall(async () =>
      await deps.documents.securityAudit(scope, auditLimitQuery(c.req.query("limit"))),
    );
    return c.json(securityAuditView(events));
  });

  app.get("/api/sessions/:sid/documents", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["include_archived"]), "文档列表");
    const resolved = await routeScope(c, deps);
    const { scope, session } = resolved;
    const includeArchived = boolQuery(c.req.query("include_archived"), "include_archived");
    const [documents, attachments] = await documentCall(async () =>
      await Promise.all([
        deps.documents.list(scope, { includeArchived }),
        deps.documents.listAttachments(scope, session),
      ]),
    );
    return c.json({
      documents: documents.map(documentView),
      attachments: attachments.map(attachmentView),
      // 会话是被本次调用顺手归入项目的话，必须让页面能说出来。
      // 「系统可以有默认行为，不可以有不可见的归属决定」——document_scope.ts 第 2 条。
      // 注意这里**不**外发 project id：边界字段一律不回传（见 BOUNDARY_FIELDS）。
      project: { name: resolved.projectName, auto_created: resolved.projectAutoCreated },
    });
  });

  app.post("/api/sessions/:sid/documents/promote", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "文档入库");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set([
        "session_file_name",
        "sessionFileName",
        "target_document_id",
        "targetDocumentId",
        "base_version_id",
        "baseVersionId",
        "title",
        "logical_name",
        "logicalName",
        "classification",
        "source_class",
        "sourceClass",
        "tags",
      ]),
      "文档入库",
    );
    const { scope, source } = await routeScope(c, deps);
    const sessionFileName = requiredText(
      field(body, "session_file_name", "sessionFileName"),
      "session_file_name",
      512,
    );
    const file = source.files.find((candidate) => candidate.name === sessionFileName);
    if (file === undefined) {
      throw apiError(404, `当前会话里没有「${sessionFileName}」，请先上传文件。`);
    }
    const documentId = optionalText(field(body, "target_document_id", "targetDocumentId"), "文档 ID");
    const baseVersionId = optionalText(field(body, "base_version_id", "baseVersionId"), "基础版本 ID");
    if (documentId !== undefined && baseVersionId === undefined) {
      throw apiError(400, "给已有文档上传新版本时，必须提供 base_version_id，避免覆盖别人刚上传的版本。");
    }
    if (documentId === undefined && baseVersionId !== undefined) {
      throw apiError(400, "base_version_id 只能用于已有文档的新版本。");
    }
    const title = optionalText(body["title"], "标题", 200);
    const logicalName = optionalText(field(body, "logical_name", "logicalName"), "文档名称", 200);
    const classification = sourceClass(field(body, "classification", "source_class", "sourceClass"));
    const documentTags = tags(body["tags"]);
    const input: PromoteSessionFileInput = {
      source: {
        sessionId: source.id,
        name: file.name,
        relPath: relativeToRoot(root(), file.path),
        sizeBytes: file.size,
        ...(file.sha256 ? { sha256: file.sha256 } : {}),
      },
      ...(documentId === undefined ? {} : { documentId }),
      ...(baseVersionId === undefined ? {} : { baseVersionId }),
      ...(title === undefined ? {} : { title }),
      ...(logicalName === undefined ? {} : { logicalName }),
      ...(classification === undefined ? {} : { sourceClass: classification }),
      ...(documentTags === undefined ? {} : { tags: documentTags }),
      createdBy: scope.owner,
    } as PromoteSessionFileInput;
    const result = await documentCall(async () =>
      await deps.documents.promoteSessionFile(scope, input),
    );
    const message = result.deduplicated
      ? `「${file.name}」的内容和库里的「${result.document.title}」逐字节相同，没有再存一份；` +
        "要看它请打开那一份。"
      : documentId === undefined
        ? `已把「${file.name}」保存到项目知识库。`
        : `已把「${file.name}」保存为新版本；采用哪个版本仍由你确认。`;
    return c.json({
      ok: true,
      message,
      document: documentView(result.document),
      version: versionView(result.version),
      deduplicated: result.deduplicated,
    }, result.deduplicated ? 200 : 201);
  });

  app.get("/api/sessions/:sid/documents/search", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(
      c,
      new Set(["q", "document_id", "limit", "attached_only"]),
      "文档搜索",
    );
    const { scope, session } = await routeScope(c, deps);
    const query = requiredText(c.req.query("q"), "搜索内容", 2_000);
    const rawDocumentIds = new URL(c.req.url).searchParams.getAll("document_id");
    if (rawDocumentIds.length > 100) throw apiError(400, "一次最多筛选 100 份文档");
    const documentIds = rawDocumentIds.map((id) => opaqueId(id, "文档"));
    const limit = limitQuery(c.req.query("limit"));
    const options: DocumentSearchOptions = {
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(documentIds.length === 0 ? {} : { documentIds }),
      ...(boolQuery(c.req.query("attached_only"), "attached_only")
        ? { sessionId: session.sessionId }
        : {}),
    };
    // 两层一起搜：项目库 + 公共库并成一份语料，只打一次分。页面上的每条命中都带
    // level，总库来的那条会显示「总库」——不这么做的话，界面永远看不到公共材料，
    // 而模型（走 searchLayered）看得到，两边说的话就不一致了。
    // 「只搜本次固定的版本」是会话语义，勾了它就只查项目层。
    const layered = options.sessionId === undefined
      ? [scope, globalLibraryScope(scope.actorId ?? scope.owner)]
      : [scope];
    const result = await documentCall(async () => await deps.documents.searchLayered(layered, options));
    return c.json(searchView(result));
  });

  app.get("/api/sessions/:sid/documents/:documentId/history", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "版本历史");
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versions = await documentCall(async () => await deps.documents.history(scope, documentId));
    return c.json({ document_id: documentId, versions: versions.map(versionView) });
  });

  /**
   * 打开一份材料，按原文顺序读。
   *
   * 这条路由此前**不存在** —— 知识库只有 `search`（要关键词）和
   * `evidence/:ref/open`（要一个已经拿到的引用）。用户刚存进去一份材料，
   * 想知道里面有什么，只能靠猜关键词。这是「知识库看不懂」最直接的一条。
   */
  /**
   * 「设为通用知识」：把一份项目材料复制进公共知识库。
   *
   * POST 而不是 PATCH：它产生的是公共库里的一份新文档，不是改这一份的属性。
   * 必须是人点的 —— 没有任何自动调用点，AI 只能建议。公共库是跨项目共享的，
   * 让它自动生长，三个月后就是垃圾场。
   */
  // ── 文件夹 ──────────────────────────────────────────────────────
  app.get("/api/sessions/:sid/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "文件夹");
    const { scope } = await routeScope(c, deps);
    const folders = await documentCall(async () => await deps.documents.listFolders(scope));
    return c.json({ folders: folders.map(folderView) });
  });

  app.post("/api/sessions/:sid/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = await routeScope(c, deps);
    const made = await documentCall(async () => await deps.documents.createFolder(
      scope,
      requiredText(field(body, "folder"), "文件夹路径", 400),
    ));
    return c.json({ ok: true, folders: made.map(folderView) }, 201);
  });

  app.patch("/api/sessions/:sid/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = await routeScope(c, deps);
    const result = await documentCall(async () => await deps.documents.renameFolder(
      scope,
      requiredText(field(body, "from"), "原文件夹路径", 400),
      requiredText(field(body, "to"), "新文件夹路径", 400),
    ));
    return c.json({ ok: true, message: "已重命名，里面的子文件夹和材料都跟着走了。", ...result });
  });

  app.delete("/api/sessions/:sid/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["folder"]), "删除文件夹");
    const { scope } = await routeScope(c, deps);
    const result = await documentCall(async () => await deps.documents.deleteFolder(
      scope,
      requiredText(c.req.query("folder"), "文件夹路径", 400),
    ));
    return c.json({
      ok: true,
      // 删文件夹不删材料 —— 这句话必须让用户看见，否则没人敢点。
      message: `文件夹已删除；里面的 ${result.movedDocuments} 份材料移到了根目录，没有删除。`,
      ...result,
    });
  });

  app.patch("/api/sessions/:sid/documents/:documentId/folder", async (c) => {
    rejectBoundaryQuery(c);
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const folderPath = String(field(body, "folder") ?? "");
    const document = await documentCall(async () =>
      await deps.documents.moveDocument(scope, documentId, folderPath));
    return c.json({
      ok: true,
      message: folderPath ? `已移动到「${folderPath}」。` : "已移动到根目录。",
      document: documentView(document),
    });
  });

  app.post("/api/sessions/:sid/documents/:documentId/publish", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "设为通用知识");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versionId = optionalText(field(body, "version_id", "versionId"), "版本 ID", 2_048);
    const result = await documentCall(async () => await deps.documents.publishToGlobal(
      scope,
      documentId,
      ...(versionId === undefined ? [] : [{ versionId }]),
    ));
    return c.json({
      ok: true,
      message: result.deduplicated
        ? "公共知识库里已经有同样内容的材料，没有重复添加。"
        : `已把「${result.document.title}」设为通用知识，其他项目也能检索到它。`,
      document: documentView(result.document),
      version: versionView(result.version),
      deduplicated: result.deduplicated,
    }, result.deduplicated ? 200 : 201);
  });

  app.get("/api/sessions/:sid/documents/:documentId/content", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["version_id", "offset", "limit"]), "材料正文");
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versionId = c.req.query("version_id");
    const result = await documentCall(async () => await deps.documents.read(scope, documentId, {
      ...(versionId === undefined || versionId === "" ? {} : { versionId: opaqueId(versionId, "版本") }),
      offset: offsetQuery(c.req.query("offset")) ?? 0,
      limit: readLimitQuery(c.req.query("limit")),
    }));
    return c.json({
      document: documentView(result.document),
      version: versionView(result.version),
      level: result.level,
      chunks: result.chunks.map(searchHitView),
      // 如实说「第 offset+1 到 offset+chunks.length 段，共 total 段」，
      // 不把截断伪装成全部 —— 和检索那边的 total 同一条纪律。
      total: result.total,
      offset: result.offset,
    });
  });

  app.get("/api/sessions/:sid/documents/evidence/:ref/open", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "证据打开");
    const { scope } = await routeScope(c, deps);
    const evidenceRef = opaqueId(c.req.param("ref"), "证据");
    const result = await documentCall(async () =>
      await deps.documents.open(scope, { evidenceRef }),
    );
    return c.json({ evidence: openView(result) });
  });

  app.patch("/api/sessions/:sid/documents/:documentId", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "文档信息更新");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set([
        "expected_revision",
        "expectedRevision",
        "title",
        "logical_name",
        "logicalName",
        "classification",
        "source_class",
        "sourceClass",
        "tags",
      ]),
      "文档信息",
    );
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const title = optionalText(body["title"], "标题", 200);
    const logicalName = optionalText(field(body, "logical_name", "logicalName"), "文档名称", 200);
    const classification = sourceClass(field(body, "classification", "source_class", "sourceClass"));
    const documentTags = tags(body["tags"]);
    if (title === undefined && logicalName === undefined && classification === undefined && documentTags === undefined) {
      throw apiError(400, "没有需要更新的文档信息");
    }
    const patch: DocumentMetadataPatch = {
      expectedRevision: expectedRevision(body),
      ...(title === undefined ? {} : { title }),
      ...(logicalName === undefined ? {} : { logicalName }),
      ...(classification === undefined ? {} : { sourceClass: classification }),
      ...(documentTags === undefined ? {} : { tags: documentTags }),
    };
    const document = await documentCall(async () =>
      await deps.documents.updateMetadata(scope, documentId, patch),
    );
    return c.json({ ok: true, message: "文档信息已更新。", document: documentView(document) });
  });

  app.patch("/api/sessions/:sid/documents/:documentId/adopt", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "版本采用");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set(["version_id", "versionId", "expected_revision", "expectedRevision"]),
      "版本采用",
    );
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versionId = opaqueId(field(body, "version_id", "versionId"), "版本");
    const document = await documentCall(async () =>
      await deps.documents.adopt(scope, documentId, {
        versionId,
        expectedRevision: expectedRevision(body),
      }),
    );
    return c.json({
      ok: true,
      message: "已采用这个版本。已有会话仍继续使用原来关联的版本，不会被静默替换。",
      document: documentView(document),
    });
  });

  app.patch("/api/sessions/:sid/documents/:documentId/archive", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "归档");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(
      body,
      new Set(["archived", "expected_revision", "expectedRevision"]),
      "归档",
    );
    const { scope } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    if (typeof body["archived"] !== "boolean") throw apiError(400, "archived 必须是 true 或 false");
    const archived = body["archived"];
    const document = await documentCall(async () =>
      await deps.documents.archive(scope, documentId, {
        archived,
        expectedRevision: expectedRevision(body),
      }),
    );
    return c.json({
      ok: true,
      message: archived
        ? "已归档这份文档。历史版本和已有引用仍会保留。"
        : "已恢复这份文档。",
      document: documentView(document),
    });
  });

  app.post("/api/sessions/:sid/documents/:documentId/attach", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "会话关联");
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    onlyFields(body, new Set(["version_id", "versionId", "role"]), "会话关联");
    const { scope, session } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versionId = opaqueId(field(body, "version_id", "versionId"), "版本");
    const roleValue = field(body, "role");
    if (roleValue !== undefined && roleValue !== "reference" && roleValue !== "primary") {
      throw apiError(400, "role 只支持 reference 或 primary");
    }
    const attachment = await documentCall(async () =>
      await deps.documents.attach(scope, session, {
        documentId,
        versionId,
        ...(roleValue === undefined ? {} : { role: roleValue }),
        attachedBy: scope.owner,
      }),
    );
    return c.json({
      ok: true,
      message: "已把这个固定版本加入本次分析。OntoCopilot 不会自动换成别的版本。",
      attachment: attachmentView(attachment),
    }, 201);
  });

  app.delete("/api/sessions/:sid/documents/:documentId/attach", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "取消关联");
    const body = await strictJsonBody(c, { allowEmpty: true });
    rejectBoundaryBody(body);
    onlyFields(body, new Set(), "取消关联");
    const { scope, session } = await routeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const detached = await documentCall(async () =>
      await deps.documents.detach(scope, session, documentId),
    );
    return c.json({
      ok: true,
      detached,
      message: detached
        ? "已从本次分析中移除；知识库里的文档没有被删除。"
        : "本次分析原本就没有使用这份文档，知识库内容没有变化。",
    });
  });
}

/**
 * 公共知识库（总库）的 HTTP 入口 —— **不经过任何会话**。
 *
 * 产品要求（2026-09-02）：「知识库应该可以直接去访问的，应该有一个总的知识库。」
 * 在此之前所有 43 条知识库路由都挂在 `/api/sessions/:sid/documents`，侧栏那颗按钮
 * 在会话没归项目时是**禁用**的，提示写着「请先打开一个已归入项目的会话」——
 * 也就是说想看一眼公共材料，得先建会话、再把会话归进某个项目。
 *
 * 这里只挂**读与整理**这一组。刻意不挂的两类：
 *   - promote-from-session-file：它的输入就是「本次会话上传的文件」，没有会话无从谈起；
 *   - attach / detach / manifest：它们的语义是「**本次会话**固定了哪一版」，
 *     那是真实的 per-session 概念，不是可以抹掉的耦合。
 * 「把一份项目材料设为通用知识」是另一条显式的人工动作，单独做，不混在这里。
 */
export function registerGlobalKnowledgeRoutes(app: Hono<AppEnv>, deps: DocumentRouteDeps): void {
  app.get("/api/knowledge/documents", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["include_archived"]), "公共知识库");
    const { scope } = resolveGlobalScope(c);
    const includeArchived = boolQuery(c.req.query("include_archived"), "include_archived");
    const documents = await documentCall(async () => await deps.documents.list(scope, { includeArchived }));
    return c.json({
      documents: documents.map(documentView),
      // 公共库不属于任何会话，所以没有「本次固定了哪一版」这回事。
      attachments: [],
      level: "global",
    });
  });

  app.get("/api/knowledge/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "文件夹");
    const { scope } = resolveGlobalScope(c);
    const folders = await documentCall(async () => await deps.documents.listFolders(scope));
    return c.json({ folders: folders.map(folderView) });
  });

  app.post("/api/knowledge/documents/folders", async (c) => {
    rejectBoundaryQuery(c);
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = resolveGlobalScope(c);
    const made = await documentCall(async () => await deps.documents.createFolder(
      scope,
      requiredText(field(body, "folder"), "文件夹路径", 400),
    ));
    return c.json({ ok: true, folders: made.map(folderView) }, 201);
  });

  app.patch("/api/knowledge/documents/:documentId/folder", async (c) => {
    rejectBoundaryQuery(c);
    const body = await strictJsonBody(c);
    rejectBoundaryBody(body);
    const { scope } = resolveGlobalScope(c);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const folderPath = String(field(body, "folder") ?? "");
    const document = await documentCall(async () =>
      await deps.documents.moveDocument(scope, documentId, folderPath));
    return c.json({ ok: true, document: documentView(document) });
  });

  app.get("/api/knowledge/documents/search", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["q", "document_id", "limit"]), "公共知识库搜索");
    const { scope } = resolveGlobalScope(c);
    const query = requiredText(c.req.query("q"), "搜索内容", 2_000);
    const rawDocumentIds = new URL(c.req.url).searchParams.getAll("document_id");
    if (rawDocumentIds.length > 100) throw apiError(400, "一次最多筛选 100 份文档");
    const documentIds = rawDocumentIds.map((id) => opaqueId(id, "文档"));
    const limit = limitQuery(c.req.query("limit"));
    const result = await documentCall(async () => await deps.documents.search(scope, {
      query,
      ...(limit === undefined ? {} : { limit }),
      ...(documentIds.length === 0 ? {} : { documentIds }),
    }));
    return c.json(searchView(result));
  });

  app.get("/api/knowledge/documents/evidence/:ref/open", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "证据打开");
    const { scope } = resolveGlobalScope(c);
    const evidenceRef = opaqueId(c.req.param("ref"), "证据引用");
    const evidence = await documentCall(async () => await deps.documents.open(scope, { evidenceRef }));
    return c.json({ evidence: openView(evidence) });
  });

  app.get("/api/knowledge/documents/:documentId/content", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(["version_id", "offset", "limit"]), "材料正文");
    const { scope } = resolveGlobalScope(c);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versionId = c.req.query("version_id");
    const result = await documentCall(async () => await deps.documents.read(scope, documentId, {
      ...(versionId === undefined || versionId === "" ? {} : { versionId: opaqueId(versionId, "版本") }),
      offset: offsetQuery(c.req.query("offset")) ?? 0,
      limit: readLimitQuery(c.req.query("limit")),
    }));
    return c.json({
      document: documentView(result.document),
      version: versionView(result.version),
      level: result.level,
      chunks: result.chunks.map(searchHitView),
      total: result.total,
      offset: result.offset,
    });
  });

  app.get("/api/knowledge/documents/:documentId/history", async (c) => {
    rejectBoundaryQuery(c);
    onlyQueryFields(c, new Set(), "版本历史");
    const { scope } = resolveGlobalScope(c);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versions = await documentCall(async () => await deps.documents.history(scope, documentId));
    return c.json({ document_id: documentId, versions: versions.map(versionView) });
  });
}
