import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { ConnectorManagementError } from "../src/document/connectors/source_service.js";
import type { ConnectorSourceRecord } from "../src/document/connectors/source_repository.js";
import type { ConnectorSyncReport } from "../src/document/connectors/sync.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";
import {
  registerDocumentConnectorRoutes,
  type ConnectorManagementPort,
  type ConnectorRouteSession,
} from "../src/server/routes/document-connectors.js";
import type { StubProjectDirectory } from "./helpers/project_directory.js";
import { stubProjectDirectory } from "./helpers/project_directory.js";

const SOURCE: ConnectorSourceRecord = {
  id: "odcs_source_1",
  // ConnectorSourceScope 不是 DocumentScope —— 它没有 actorId 这个字段。
  scope: { projectId: "project-1", owner: "u1" },
  provider: "s3",
  name: "采购制度库",
  rootOrPrefix: "customer-bucket/purchase",
  credentialRef: "credential://project-1/s3-reader",
  tags: ["采购"],
  classification: "confidential",
  enabled: true,
  revision: 3,
  cursor: "opaque-secret-cursor",
  status: "idle",
  createdBy: "u1",
  updatedBy: "u1",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T01:00:00.000Z",
  lastStartedAt: "2026-09-02T01:00:00.000Z",
  lastCompletedAt: "2026-09-02T01:00:01.000Z",
  lastError: null,
};

const REPORT: ConnectorSyncReport = {
  bindingId: SOURCE.id,
  pages: 2,
  upserted: 4,
  deleted: 1,
  aclUpdated: 2,
  nextCursor: "opaque-next-cursor",
  complete: false,
  startedAt: "2026-09-02T01:00:00.000Z",
  completedAt: "2026-09-02T01:00:02.000Z",
};

class FakeConnectorManagement implements ConnectorManagementPort {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  error: Error | null = null;

  private result<T>(value: T): T {
    if (this.error !== null) throw this.error;
    return value;
  }

  async list(...args: Parameters<ConnectorManagementPort["list"]>): Promise<readonly ConnectorSourceRecord[]> {
    this.calls.push({ method: "list", args });
    return this.result([SOURCE]);
  }

  async get(...args: Parameters<ConnectorManagementPort["get"]>): Promise<ConnectorSourceRecord> {
    this.calls.push({ method: "get", args });
    return this.result(SOURCE);
  }

  async create(...args: Parameters<ConnectorManagementPort["create"]>): Promise<ConnectorSourceRecord> {
    this.calls.push({ method: "create", args });
    return this.result(SOURCE);
  }

  async update(...args: Parameters<ConnectorManagementPort["update"]>): Promise<ConnectorSourceRecord> {
    this.calls.push({ method: "update", args });
    return this.result({ ...SOURCE, revision: 4 });
  }

  async lifecycle(...args: Parameters<ConnectorManagementPort["lifecycle"]>): Promise<ConnectorSourceRecord> {
    this.calls.push({ method: "lifecycle", args });
    return this.result({ ...SOURCE, revision: 4 });
  }

  async syncNow(...args: Parameters<ConnectorManagementPort["syncNow"]>): Promise<ConnectorSyncReport> {
    this.calls.push({ method: "syncNow", args });
    return this.result(REPORT);
  }
}

let app: Hono<AppEnv>;
let actor: RequestUser | null;
let connectors: FakeConnectorManagement;
let sessions: Map<string, ConnectorRouteSession>;
let projects: StubProjectDirectory;

beforeEach(() => {
  actor = { id: "u1", role: "user" };
  connectors = new FakeConnectorManagement();
  projects = stubProjectDirectory();
  sessions = new Map([
    ["s1", { id: "s1", projectId: "project-1", owner: "u1" }],
    ["orphan", { id: "orphan", projectId: "", owner: "u1" }],
  ]);
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", actor);
    await next();
  });
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  });
  registerDocumentConnectorRoutes(app, {
    connectors,
    projects,
    sessionById: async (sid) => {
      const session = sessions.get(sid);
      if (session === undefined) throw new HTTPException(404, { message: `没有会话 ${sid}` });
      return session;
    },
  });
});

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

async function request(path: string, body: unknown, method = "POST"): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OntoDocument project source routes", () => {
  it("列表边界只从会话派生，响应不暴露 owner/project/cursor", async () => {
    const response = await app.request("/api/sessions/s1/document-connectors?include_archived=true");
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.sources[0]).toMatchObject({
      id: SOURCE.id,
      provider: "s3",
      root_or_prefix: "customer-bucket/purchase",
      has_cursor: true,
    });
    expect(payload.sources[0]).not.toHaveProperty("cursor");
    expect(payload.sources[0]).not.toHaveProperty("owner");
    expect(payload.sources[0]).not.toHaveProperty("project_id");
    expect(JSON.stringify(payload)).not.toContain("opaque-secret-cursor");
    expect(connectors.calls).toEqual([{
      method: "list",
      args: [{ scope: { projectId: "project-1", owner: "u1", actorId: "u1" }, actorId: "u1" }, true],
    }]);
  });

  it("创建只接收受控配置，project/owner/actor 都由当前会话确定", async () => {
    const response = await request("/api/sessions/s1/document-connectors", {
      request_id: "browser-action-1",
      provider: "s3",
      name: "采购制度库",
      root_or_prefix: "customer-bucket/purchase",
      credential_ref: "credential://project-1/s3-reader",
      tags: ["采购"],
      classification: "confidential",
      enabled: true,
    });
    expect(response.status).toBe(201);
    expect(connectors.calls).toEqual([{
      method: "create",
      args: [
        { scope: { projectId: "project-1", owner: "u1", actorId: "u1" }, actorId: "u1" },
        {
          requestId: "browser-action-1",
          provider: "s3",
          name: "采购制度库",
          rootOrPrefix: "customer-bucket/purchase",
          credentialRef: "credential://project-1/s3-reader",
          tags: ["采购"],
          classification: "confidential",
          enabled: true,
        },
      ],
    }]);
  });

  it.each([
    { project_id: "other" },
    { owner: "u2" },
    { actorId: "u2" },
    { token: "secret" },
    { password: "secret" },
    { endpoint_url: "https://evil.example" },
    { path: "/etc/passwd" },
    { config: { secret: "nested" } },
  ])("拒绝边界、秘密、URL 或本机路径字段：%o", async (injected) => {
    const response = await request("/api/sessions/s1/document-connectors", {
      request_id: "x",
      provider: "s3",
      name: "x",
      root_or_prefix: "safe-bucket/root",
      credential_ref: "credential://project/reader",
      ...injected,
    });
    expect(response.status).toBe(400);
    expect(connectors.calls).toHaveLength(0);
  });

  it("不把未知 provider/classification 交给领域层", async () => {
    const invalidProvider = await request("/api/sessions/s1/document-connectors", {
      request_id: "x",
      provider: "local-filesystem",
      name: "x",
      root_or_prefix: "/tmp",
      credential_ref: "credential://project/reader",
    });
    expect(invalidProvider.status).toBe(400);
    const invalidClassification = await request("/api/sessions/s1/document-connectors", {
      request_id: "x",
      provider: "s3",
      name: "x",
      root_or_prefix: "safe-bucket/root",
      credential_ref: "credential://project/reader",
      classification: "top-secret-custom",
    });
    expect(invalidClassification.status).toBe(400);
    expect(connectors.calls).toHaveLength(0);
  });

  it("配置、启停、归档、恢复与同步均携带 CAS revision", async () => {
    const patch = await request(`/api/sessions/s1/document-connectors/${SOURCE.id}`, {
      expected_revision: 3,
      name: "采购制度与流程",
    }, "PATCH");
    expect(patch.status).toBe(200);

    for (const action of ["enable", "disable", "archive", "restore"] as const) {
      const response = await request(
        `/api/sessions/s1/document-connectors/${SOURCE.id}/${action}`,
        { expected_revision: 3 },
      );
      expect(response.status).toBe(200);
    }

    const sync = await request(`/api/sessions/s1/document-connectors/${SOURCE.id}/sync`, {
      expected_revision: 3,
      page_size: 40,
      max_pages: 5,
    });
    expect(sync.status).toBe(200);
    const payload = await json(sync);
    expect(payload.sync).toMatchObject({
      source_id: SOURCE.id,
      pages: 2,
      acl_updated: 2,
      has_next_cursor: true,
    });
    expect(payload.sync).not.toHaveProperty("next_cursor");
    expect(JSON.stringify(payload)).not.toContain("opaque-next-cursor");
    expect(connectors.calls.at(-1)).toEqual({
      method: "syncNow",
      args: [
        { scope: { projectId: "project-1", owner: "u1", actorId: "u1" }, actorId: "u1" },
        SOURCE.id,
        { expectedRevision: 3, pageSize: 40, maxPages: 5 },
      ],
    });
  });

  it("status 只返回安全状态；同步原始错误映射成人话且不泄密", async () => {
    const status = await app.request(`/api/sessions/s1/document-connectors/${SOURCE.id}/status`);
    expect(status.status).toBe(200);
    expect(JSON.stringify(await json(status))).not.toContain("opaque-secret-cursor");

    connectors.error = new ConnectorManagementError(
      "SYNC_FAILED",
      "这次同步没有完成。已保留上次成功位置，请检查连接和凭据后重试。",
      502,
    );
    const failed = await request(`/api/sessions/s1/document-connectors/${SOURCE.id}/sync`, {
      expected_revision: 3,
    });
    expect(failed.status).toBe(502);
    expect((await json(failed)).detail).not.toContain("token");
  });

  it("运行时未配置时页面得到准确 503，不把保存配置误报成已经同步", async () => {
    connectors.error = new ConnectorManagementError(
      "INVALID_STATE",
      "连接器运行时未配置。来源设置已经保存，但现在还不能同步，请联系管理员完成连接器接入。",
      503,
    );
    const response = await request(`/api/sessions/s1/document-connectors/${SOURCE.id}/sync`, {
      expected_revision: 3,
    });
    expect(response.status).toBe(503);
    expect((await json(response)).detail).toContain("来源设置已经保存，但现在还不能同步");
  });

  it("别人的会话统一 404；未归项目的会话惰性落到默认项目而不是 409", async () => {
    actor = { id: "u2", role: "user" };
    const denied = await app.request("/api/sessions/s1/document-connectors");
    expect(denied.status).toBe(404);
    expect(connectors.calls).toHaveLength(0);

    // 真实库里 33/42 个会话 project_id 为空。这里 409 等于知识库对大多数会话
    // 根本不存在，所以改成惰性归入 owner 的默认项目 —— 见 document_scope.ts。
    actor = { id: "u1", role: "user" };
    const orphan = await app.request("/api/sessions/orphan/document-connectors");
    expect(orphan.status).toBe(200);
    expect(projects.assigned.get("orphan")).toBe("auto-1");
    expect(projects.projects.get("auto-1")).toMatchObject({ name: "我的材料", owner: "u1" });
  });
});
