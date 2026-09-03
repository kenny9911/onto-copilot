/**
 * OntoDocument 项目来源管理 API。
 *
 * 这些写接口只供人工知识库页面调用，不注册为模型工具。project/owner/actor 全部从
 * 已鉴权会话派生；body/query 中出现边界字段、secret/token/password、URL 或本机 path
 * 字段都会在进入服务前拒绝。
 */

import type { Context, Hono } from "hono";

import {
  ConnectorManagementError,
  type ConnectorManagementIdentity,
  type ConnectorSyncOptions,
  type CreateConnectorSourceInput,
  type UpdateConnectorSourceInput,
} from "../../document/connectors/source_service.js";
import type {
  ConnectorLifecycleAction,
  ConnectorSourceRecord,
} from "../../document/connectors/source_repository.js";
import type { ConnectorSyncReport } from "../../document/connectors/sync.js";
import type { ConnectorClassification, ConnectorKind } from "../../document/connectors/types.js";
import type { AppEnv } from "../app.js";
import type { ProjectDirectory } from "./document_scope.js";
import { repoProjectDirectory, resolveProjectScope } from "./document_scope.js";
import { sessAsync } from "../session.js";
import { apiError, jsonBody } from "./sessions.js";

export interface ConnectorManagementPort {
  list(identity: ConnectorManagementIdentity, includeArchived?: boolean): Promise<readonly ConnectorSourceRecord[]>;
  get(identity: ConnectorManagementIdentity, id: string): Promise<ConnectorSourceRecord>;
  create(identity: ConnectorManagementIdentity, input: CreateConnectorSourceInput): Promise<ConnectorSourceRecord>;
  update(identity: ConnectorManagementIdentity, id: string, input: UpdateConnectorSourceInput): Promise<ConnectorSourceRecord>;
  lifecycle(
    identity: ConnectorManagementIdentity,
    id: string,
    action: ConnectorLifecycleAction,
    expectedRevision: number,
  ): Promise<ConnectorSourceRecord>;
  syncNow(
    identity: ConnectorManagementIdentity,
    id: string,
    options: ConnectorSyncOptions,
  ): Promise<ConnectorSyncReport>;
}

export interface ConnectorRouteSession {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
}

export interface DocumentConnectorRouteDeps {
  readonly connectors: ConnectorManagementPort;
  readonly sessionById?: (sid: string) => Promise<ConnectorRouteSession>;
  /** 项目目录。生产默认落在仓储上；HTTP 测试注入桩。 */
  readonly projects?: ProjectDirectory;
}

const AUTHORITY_FIELDS = new Set([
  "project",
  "project_id",
  "projectId",
  "owner",
  "owner_id",
  "ownerId",
  "actor",
  "actor_id",
  "actorId",
  "principal",
  "principal_id",
  "principalId",
  "session",
  "session_id",
  "sessionId",
]);
const SECRET_OR_ENDPOINT_FIELDS = new Set([
  "secret",
  "client_secret",
  "clientSecret",
  "token",
  "access_token",
  "accessToken",
  "password",
  "url",
  "endpoint",
  "endpoint_url",
  "endpointUrl",
  "base_url",
  "baseUrl",
  "path",
  "file_path",
  "filePath",
  "local_path",
  "localPath",
]);

const CREATE_FIELDS = new Set([
  "request_id",
  "requestId",
  "provider",
  "name",
  "root_or_prefix",
  "rootOrPrefix",
  "credential_ref",
  "credentialRef",
  "tags",
  "classification",
  "enabled",
]);
const UPDATE_FIELDS = new Set([
  "expected_revision",
  "expectedRevision",
  "provider",
  "name",
  "root_or_prefix",
  "rootOrPrefix",
  "credential_ref",
  "credentialRef",
  "tags",
  "classification",
  "enabled",
]);
const REVISION_FIELDS = new Set(["expected_revision", "expectedRevision"]);
const SYNC_FIELDS = new Set([
  ...REVISION_FIELDS,
  "page_size",
  "pageSize",
  "max_pages",
  "maxPages",
]);
const PROVIDERS: ReadonlySet<string> = new Set([
  "sharepoint",
  "webdav",
  "s3",
  "confluence",
  "datahub",
  "openmetadata",
]);
const CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function requiredText(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || !value.trim()) throw apiError(400, `${label}不能为空`);
  const out = value.trim();
  if ([...out].length > max || /[\p{Cc}\p{Cs}]/u.test(out)) throw apiError(400, `${label}无效`);
  return out;
}

function opaqueId(value: unknown): string {
  const out = requiredText(value, "来源 ID", 256);
  if (out.includes("/") || out.includes("\\") || out === "." || out === "..") {
    throw apiError(404, "没有找到这个项目来源");
  }
  return out;
}

function bodyField(body: Readonly<Record<string, unknown>>, ...names: readonly string[]): unknown {
  for (const name of names) if (Object.hasOwn(body, name)) return body[name];
  return undefined;
}

function rejectNestedUnsafe(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectNestedUnsafe);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY_FIELDS.has(key)) {
      throw apiError(400, `请不要提交 ${key}；项目和操作者由当前会话自动确定。`);
    }
    if (SECRET_OR_ENDPOINT_FIELDS.has(key)) {
      throw apiError(400, `请不要提交 ${key}；页面只能选择 credential_ref 和远端根目录。`);
    }
    rejectNestedUnsafe(child);
  }
}

function strictBody(body: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): void {
  rejectNestedUnsafe(body);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw apiError(400, `不支持字段：${unknown.join("、")}`);
}

function expectedRevision(body: Readonly<Record<string, unknown>>): number {
  const value = bodyField(body, "expected_revision", "expectedRevision");
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw apiError(400, "expected_revision 必须是正整数；请先刷新来源后再修改。");
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw apiError(400, `${label} 必须是 1 到 ${max} 之间的整数`);
  }
  return value as number;
}

function optionalBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw apiError(400, `${label} 必须是 true 或 false`);
  return value;
}

function optionalTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw apiError(400, "tags 必须是文字数组");
  }
  return value as readonly string[];
}

function includeArchived(c: Context<AppEnv>): boolean {
  const params = new URL(c.req.url).searchParams;
  for (const key of params.keys()) {
    if (AUTHORITY_FIELDS.has(key)) throw apiError(400, `请不要提交 ${key}；项目由当前会话确定。`);
    if (key !== "include_archived") throw apiError(400, `不支持查询参数：${key}`);
  }
  const value = params.get("include_archived");
  if (value === null || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw apiError(400, "include_archived 只支持 true 或 false");
}

async function routeIdentity(
  c: Context<AppEnv>,
  deps: DocumentConnectorRouteDeps,
): Promise<ConnectorManagementIdentity> {
  const sid = requiredText(c.req.param("sid"), "会话 ID", 256);
  const resolved = await resolveProjectScope(
    c,
    sid,
    deps.sessionById ?? sessAsync,
    deps.projects ?? repoProjectDirectory(),
  );
  if (!resolved.actorId) throw apiError(403, "无法确认当前操作者，请重新登录");
  return { scope: resolved.scope, actorId: resolved.actorId };
}

async function connectorCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (!(error instanceof ConnectorManagementError)) throw error;
    throw apiError(error.status, error.message);
  }
}

function sourceView(row: ConnectorSourceRecord): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    root_or_prefix: row.rootOrPrefix,
    credential_ref: row.credentialRef,
    tags: row.tags,
    classification: row.classification,
    enabled: row.enabled,
    revision: row.revision,
    status: row.status,
    has_cursor: row.cursor !== null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_started_at: row.lastStartedAt,
    last_completed_at: row.lastCompletedAt,
    last_error: row.lastError,
  };
}

function syncView(report: ConnectorSyncReport): Record<string, unknown> {
  return {
    source_id: report.bindingId,
    pages: report.pages,
    upserted: report.upserted,
    deleted: report.deleted,
    acl_updated: report.aclUpdated,
    complete: report.complete,
    has_next_cursor: report.nextCursor !== null,
    started_at: report.startedAt,
    completed_at: report.completedAt,
  };
}

function provider(value: unknown): ConnectorKind {
  const out = requiredText(value, "provider", 32);
  if (!PROVIDERS.has(out)) {
    throw apiError(400, "provider 只支持 sharepoint、webdav、s3、confluence、datahub 或 openmetadata");
  }
  return out as ConnectorKind;
}

function classification(value: unknown): ConnectorClassification | undefined {
  if (value === undefined) return undefined;
  const out = requiredText(value, "classification", 32);
  if (!CLASSIFICATIONS.has(out)) {
    throw apiError(400, "classification 只支持 public、internal、confidential 或 restricted");
  }
  return out as ConnectorClassification;
}

/** 独立注册；由服务启动层显式接到 app。 */
export function registerDocumentConnectorRoutes(
  app: Hono<AppEnv>,
  deps: DocumentConnectorRouteDeps,
): void {
  app.get("/api/sessions/:sid/document-connectors", async (c) => {
    const identity = await routeIdentity(c, deps);
    const rows = await connectorCall(() => deps.connectors.list(identity, includeArchived(c)));
    return c.json({ sources: rows.map(sourceView) });
  });

  app.post("/api/sessions/:sid/document-connectors", async (c) => {
    const body = await jsonBody(c);
    strictBody(body, CREATE_FIELDS);
    const identity = await routeIdentity(c, deps);
    const row = await connectorCall(() => deps.connectors.create(identity, {
      requestId: requiredText(bodyField(body, "request_id", "requestId"), "request_id", 256),
      provider: provider(body["provider"]),
      name: requiredText(body["name"], "来源名称", 160),
      rootOrPrefix: requiredText(bodyField(body, "root_or_prefix", "rootOrPrefix"), "root_or_prefix", 2_048),
      credentialRef: requiredText(bodyField(body, "credential_ref", "credentialRef"), "credential_ref", 512),
      ...(optionalTags(body["tags"]) === undefined ? {} : { tags: optionalTags(body["tags"])! }),
      ...(classification(body["classification"]) === undefined
        ? {}
        : { classification: classification(body["classification"])! }),
      ...(optionalBool(body["enabled"], "enabled") === undefined
        ? {}
        : { enabled: optionalBool(body["enabled"], "enabled")! }),
    }));
    return c.json({ source: sourceView(row) }, 201);
  });

  app.get("/api/sessions/:sid/document-connectors/:sourceId/status", async (c) => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].length > 0) throw apiError(400, "status 不接受查询参数");
    const identity = await routeIdentity(c, deps);
    const row = await connectorCall(() => deps.connectors.get(identity, opaqueId(c.req.param("sourceId"))));
    return c.json({ source: sourceView(row) });
  });

  app.patch("/api/sessions/:sid/document-connectors/:sourceId", async (c) => {
    const body = await jsonBody(c);
    strictBody(body, UPDATE_FIELDS);
    const identity = await routeIdentity(c, deps);
    const input: UpdateConnectorSourceInput = {
      expectedRevision: expectedRevision(body),
      ...(body["provider"] === undefined ? {} : { provider: provider(body["provider"]) }),
      ...(body["name"] === undefined ? {} : { name: requiredText(body["name"], "来源名称", 160) }),
      ...(bodyField(body, "root_or_prefix", "rootOrPrefix") === undefined
        ? {}
        : { rootOrPrefix: requiredText(bodyField(body, "root_or_prefix", "rootOrPrefix"), "root_or_prefix", 2_048) }),
      ...(bodyField(body, "credential_ref", "credentialRef") === undefined
        ? {}
        : { credentialRef: requiredText(bodyField(body, "credential_ref", "credentialRef"), "credential_ref", 512) }),
      ...(optionalTags(body["tags"]) === undefined ? {} : { tags: optionalTags(body["tags"])! }),
      ...(classification(body["classification"]) === undefined
        ? {}
        : { classification: classification(body["classification"])! }),
      ...(optionalBool(body["enabled"], "enabled") === undefined
        ? {}
        : { enabled: optionalBool(body["enabled"], "enabled")! }),
    };
    const row = await connectorCall(() => deps.connectors.update(
      identity,
      opaqueId(c.req.param("sourceId")),
      input,
    ));
    return c.json({ source: sourceView(row) });
  });

  for (const action of ["enable", "disable", "archive", "restore"] as const) {
    app.post(`/api/sessions/:sid/document-connectors/:sourceId/${action}`, async (c) => {
      const body = await jsonBody(c);
      strictBody(body, REVISION_FIELDS);
      const identity = await routeIdentity(c, deps);
      const row = await connectorCall(() => deps.connectors.lifecycle(
        identity,
        opaqueId(c.req.param("sourceId")),
        action,
        expectedRevision(body),
      ));
      return c.json({ source: sourceView(row) });
    });
  }

  app.post("/api/sessions/:sid/document-connectors/:sourceId/sync", async (c) => {
    const body = await jsonBody(c);
    strictBody(body, SYNC_FIELDS);
    const identity = await routeIdentity(c, deps);
    const pageSize = optionalInteger(bodyField(body, "page_size", "pageSize"), "page_size", 500);
    const maxPages = optionalInteger(bodyField(body, "max_pages", "maxPages"), "max_pages", 1_000);
    const report = await connectorCall(() => deps.connectors.syncNow(
      identity,
      opaqueId(c.req.param("sourceId")),
      {
        expectedRevision: expectedRevision(body),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(maxPages === undefined ? {} : { maxPages }),
      },
    ));
    return c.json({ sync: syncView(report) });
  });
}
