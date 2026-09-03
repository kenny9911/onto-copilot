/** OntoDocument HTTP 边界：会话派生权限、不可变版本与可读回执。 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AclRevisionConflict,
  DocumentNotFoundOrForbidden,
  type AclSnapshot,
} from "../src/document/acl.js";
import type { DocumentSecurityAuditEvent } from "../src/document/audit.js";
import {
  DocumentConflict,
  DocumentForbidden,
  type DocumentAttachment,
  type DocumentOpenResult,
  type DocumentReadResult,
  type DocumentSearchResult,
  type DocumentSummary,
  type DocumentVersion,
  type PromoteResult,
} from "../src/document/types.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";
import type {
  DocumentRouteSession,
  DocumentServicePort,
} from "../src/server/routes/documents.js";
import type { StubProjectDirectory } from "./helpers/project_directory.js";
import { stubProjectDirectory } from "./helpers/project_directory.js";

const ROOT = join(tmpdir(), `ontocopilot-documents-route-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { refreshRoot } = await import("../src/server/session.js");
const { registerDocumentRoutes } = await import("../src/server/routes/documents.js");

const SUMMARY: DocumentSummary = {
  id: "doc-1",
  projectId: "project-1",
  owner: "u1",
  title: "采购流程",
  logicalName: "采购流程.md",
  sourceClass: "session_upload",
  tags: ["采购"],
  status: "active",
  currentVersionId: "ver-2",
  adoptedVersionId: "ver-1",
  revision: 3,
  createdBy: "u1",
  createdAt: "2026-09-01T01:00:00.000Z",
  updatedAt: "2026-09-01T02:00:00.000Z",
  folderPath: "",
};

const VERSION: DocumentVersion = {
  id: "ver-2",
  documentId: "doc-1",
  versionNo: 2,
  fileName: "采购流程.md",
  mediaType: "text/markdown",
  sizeBytes: 32,
  sha256: "abc",
  relPath: "projects/project-1/documents/doc-1/ver-2/original/采购流程.md",
  docKind: "text",
  parseStatus: "ready",
  parserName: "text",
  parserVersion: "1",
  indexRevision: "idx-2",
  chunkCount: 1,
  createdBy: "u1",
  createdAt: "2026-09-01T02:00:00.000Z",
};

const ATTACHMENT: DocumentAttachment = {
  sessionId: "s1",
  projectId: "project-1",
  owner: "u1",
  documentId: "doc-1",
  versionId: "ver-2",
  role: "reference",
  attachedBy: "u1",
  attachedAt: "2026-09-01T03:00:00.000Z",
};

const SEARCH: DocumentSearchResult = {
  query: "审批",
  hits: [{
    evidenceRef: "odoc:doc-1:ver-2:chunk-1",
    displayCite: "采购流程.md · 第 2 段",
    level: "project" as const,
    documentId: "doc-1",
    versionId: "ver-2",
    versionNo: 2,
    documentTitle: "采购流程",
    fileName: "采购流程.md",
    chunkId: "chunk-1",
    locator: { paragraph: 2 },
    text: "采购申请由部门负责人审批。",
    textSha256: "text-sha",
    score: 4.2,
    coverage: { matchedTerms: ["审批"], missingTerms: [], queryTerms: 1, ratio: 1 },
  }],
  total: 1,
  searchedVersions: ["ver-2"],
  coverage: { matchedTerms: ["审批"], missingTerms: [], queryTerms: 1, ratio: 1 },
};

const READ: DocumentReadResult = {
  document: SUMMARY,
  version: VERSION,
  level: "project",
  // 每段都自带 evidence_ref 和引用文案 —— 阅读器里的「引用到对话」靠的就是这个。
  chunks: SEARCH.hits,
  total: 213,
  offset: 0,
};

const OPEN: DocumentOpenResult = {
  ...SEARCH.hits[0]!,
  raw: { paragraph: "采购申请由部门负责人审批。" },
  context: "审批流程",
  tags: ["paragraph"],
};

class FakeDocumentService implements DocumentServicePort {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  updateError: Error | null = null;
  aclError: Error | null = null;

  async list(...args: Parameters<DocumentServicePort["list"]>): Promise<readonly DocumentSummary[]> {
    this.calls.push({ method: "list", args });
    return [SUMMARY];
  }

  async listAttachments(
    ...args: Parameters<DocumentServicePort["listAttachments"]>
  ): Promise<readonly DocumentAttachment[]> {
    this.calls.push({ method: "listAttachments", args });
    return [ATTACHMENT];
  }

  async history(...args: Parameters<DocumentServicePort["history"]>): Promise<readonly DocumentVersion[]> {
    this.calls.push({ method: "history", args });
    return [VERSION];
  }

  async promoteSessionFile(
    ...args: Parameters<DocumentServicePort["promoteSessionFile"]>
  ): Promise<{ document: DocumentSummary; version: DocumentVersion; deduplicated: boolean }> {
    this.calls.push({ method: "promoteSessionFile", args });
    return { document: SUMMARY, version: VERSION, deduplicated: false };
  }

  async search(...args: Parameters<DocumentServicePort["search"]>): Promise<DocumentSearchResult> {
    this.calls.push({ method: "search", args });
    return SEARCH;
  }

  async searchLayered(
    ...args: Parameters<DocumentServicePort["searchLayered"]>
  ): Promise<DocumentSearchResult> {
    this.calls.push({ method: "searchLayered", args });
    return SEARCH;
  }

  async open(...args: Parameters<DocumentServicePort["open"]>): Promise<DocumentOpenResult> {
    this.calls.push({ method: "open", args });
    return OPEN;
  }

  async read(...args: Parameters<DocumentServicePort["read"]>): Promise<DocumentReadResult> {
    this.calls.push({ method: "read", args });
    return READ;
  }

  async listFolders(...args: Parameters<DocumentServicePort["listFolders"]>) {
    this.calls.push({ method: "listFolders", args });
    return [{ path: "制度", createdBy: "u1", createdAt: "2026-09-03T00:00:00.000Z" }];
  }

  async createFolder(...args: Parameters<DocumentServicePort["createFolder"]>) {
    this.calls.push({ method: "createFolder", args });
    return [{ path: String(args[1]), createdBy: "u1", createdAt: "2026-09-03T00:00:00.000Z" }];
  }

  async deleteFolder(...args: Parameters<DocumentServicePort["deleteFolder"]>) {
    this.calls.push({ method: "deleteFolder", args });
    return { movedDocuments: 2 };
  }

  async renameFolder(...args: Parameters<DocumentServicePort["renameFolder"]>) {
    this.calls.push({ method: "renameFolder", args });
    return { folders: 1 };
  }

  async moveDocument(...args: Parameters<DocumentServicePort["moveDocument"]>) {
    this.calls.push({ method: "moveDocument", args });
    return { ...SUMMARY, folderPath: String(args[2]) };
  }

  async publishToGlobal(
    ...args: Parameters<DocumentServicePort["publishToGlobal"]>
  ): Promise<PromoteResult> {
    this.calls.push({ method: "publishToGlobal", args });
    return { document: SUMMARY, version: VERSION, deduplicated: false };
  }

  async updateMetadata(
    ...args: Parameters<DocumentServicePort["updateMetadata"]>
  ): Promise<DocumentSummary> {
    this.calls.push({ method: "updateMetadata", args });
    if (this.updateError !== null) throw this.updateError;
    return SUMMARY;
  }

  async adopt(...args: Parameters<DocumentServicePort["adopt"]>): Promise<DocumentSummary> {
    this.calls.push({ method: "adopt", args });
    return { ...SUMMARY, adoptedVersionId: "ver-2", revision: 4 };
  }

  async archive(...args: Parameters<DocumentServicePort["archive"]>): Promise<DocumentSummary> {
    this.calls.push({ method: "archive", args });
    return { ...SUMMARY, status: "archived", revision: 4 };
  }

  async attach(...args: Parameters<DocumentServicePort["attach"]>): Promise<DocumentAttachment> {
    this.calls.push({ method: "attach", args });
    return ATTACHMENT;
  }

  async detach(...args: Parameters<DocumentServicePort["detach"]>): Promise<boolean> {
    this.calls.push({ method: "detach", args });
    return true;
  }

  async aclSnapshot(...args: Parameters<DocumentServicePort["aclSnapshot"]>): Promise<AclSnapshot> {
    this.calls.push({ method: "aclSnapshot", args });
    if (this.aclError !== null) throw this.aclError;
    return {
      boundary: { projectId: "project-1", owner: "u1", actorId: "u1" },
      revision: 0,
      rules: [],
    };
  }

  async replaceAclRules(
    ...args: Parameters<DocumentServicePort["replaceAclRules"]>
  ): Promise<AclSnapshot> {
    this.calls.push({ method: "replaceAclRules", args });
    if (this.aclError !== null) throw this.aclError;
    return {
      boundary: { projectId: "project-1", owner: "u1", actorId: "u1" },
      revision: 1,
      rules: args[1].rules.map((rule) => ({
        ...rule,
        changedRevision: 1,
        createdBy: "u1",
        createdAt: "2026-09-01T04:00:00.000Z",
      })),
    };
  }

  async securityAudit(
    ...args: Parameters<DocumentServicePort["securityAudit"]>
  ): Promise<readonly DocumentSecurityAuditEvent[]> {
    this.calls.push({ method: "securityAudit", args });
    if (this.aclError !== null) throw this.aclError;
    return [{
      id: "audit-secret-id",
      projectId: "project-1",
      owner: "u1",
      actorType: "principal",
      actorId: "u1",
      action: "search.filter",
      decision: "allow",
      scopeType: "project",
      aclRevision: 3,
      matchedRuleIds: ["internal-rule"],
      detail: {
        requestId: "request-secret",
        sessionId: "s1",
        querySha256: "a".repeat(64),
        candidateCount: 5,
        allowedCount: 3,
        deniedCount: 2,
      },
      occurredAt: "2026-09-01T04:00:00.000Z",
    }];
  }
}

let actor: RequestUser | null;
let app: Hono<AppEnv>;
let documents: FakeDocumentService;
let sessions: Map<string, DocumentRouteSession>;
let projects: StubProjectDirectory;

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  actor = { id: "u1", role: "user" };
  documents = new FakeDocumentService();
  projects = stubProjectDirectory();
  const materialPath = join(ROOT, "s1", "materials", "采购流程.md");
  mkdirSync(join(ROOT, "s1", "materials"), { recursive: true });
  writeFileSync(materialPath, "采购申请由部门负责人审批。");
  sessions = new Map([
    ["s1", {
      id: "s1",
      projectId: "project-1",
      owner: "u1",
      files: [{ name: "采购流程.md", path: materialPath, size: 32, sha256: "abc" }],
    }],
    ["orphan", { id: "orphan", projectId: "", owner: "u1", files: [] }],
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
  registerDocumentRoutes(app, {
    documents,
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

describe("OntoDocument 路由安全边界", () => {
  it("列表的 owner、project 与 session 全部来自当前会话和请求", async () => {
    const response = await app.request("/api/sessions/s1/documents?include_archived=true");
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.documents[0]).toMatchObject({
      id: "doc-1",
      logical_name: "采购流程.md",
      current_version_id: "ver-2",
      adopted_version_id: "ver-1",
    });
    expect(payload.attachments[0]).toMatchObject({ document_id: "doc-1", version_id: "ver-2" });
    expect(documents.calls).toEqual([
      {
        method: "list",
        args: [{ projectId: "project-1", owner: "u1", actorId: "u1" }, { includeArchived: true }],
      },
      {
        method: "listAttachments",
        args: [
          { projectId: "project-1", owner: "u1", actorId: "u1" },
          // SessionDocumentScope 是 `{...scope, sessionId}`，所以它也带上了 actorId。
          { sessionId: "s1", projectId: "project-1", owner: "u1", actorId: "u1" },
        ],
      },
    ]);
  });

  it.each(["project_id=other", "owner=u2", "path=/etc/passwd"])(
    "不接受客户端覆盖安全边界：%s",
    async (query) => {
      const response = await app.request(`/api/sessions/s1/documents?${query}`);
      expect(response.status).toBe(400);
      expect((await json(response)).detail).toContain("当前会话自动确定");
      expect(documents.calls).toHaveLength(0);
    },
  );

  it.each([
    "/api/sessions/s1/documents?debug=1",
    "/api/sessions/s1/documents/acl?debug=1",
    "/api/sessions/s1/documents/audit?debug=1",
    "/api/sessions/s1/documents/search?q=%E5%AE%A1%E6%89%B9&debug=1",
    "/api/sessions/s1/documents/doc-1/history?debug=1",
    "/api/sessions/s1/documents/evidence/odoc.v1.ref/open?debug=1",
    "/api/sessions/s1/documents/doc-1/attach?debug=1",
  ])("所有读取和取消关联接口都 fail-closed 拒绝未知 query：%s", async (url) => {
    const response = await app.request(url, url.includes("/attach?") ? { method: "DELETE" } : undefined);
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain("不支持的");
    expect(documents.calls).toHaveLength(0);
  });

  it.each(["accessToken", "service_url", "sourcePath", "principalId", "credentials"])(
    "敏感 query 名称会在进入业务层前被拒绝：%s",
    async (key) => {
      const response = await app.request(
        `/api/sessions/s1/documents?${encodeURIComponent(key)}=attacker`,
      );
      expect(response.status).toBe(400);
      expect((await json(response)).detail).toContain("当前会话自动确定");
      expect(documents.calls).toHaveLength(0);
    },
  );

  it.each([
    {
      name: "入库",
      url: "/api/sessions/s1/documents/promote",
      method: "POST",
      body: { session_file_name: "采购流程.md", unexpected: true },
    },
    {
      name: "信息修改",
      url: "/api/sessions/s1/documents/doc-1",
      method: "PATCH",
      body: { expected_revision: 3, title: "采购", unexpected: true },
    },
    {
      name: "版本采用",
      url: "/api/sessions/s1/documents/doc-1/adopt",
      method: "PATCH",
      body: { expected_revision: 3, version_id: "ver-2", unexpected: true },
    },
    {
      name: "归档",
      url: "/api/sessions/s1/documents/doc-1/archive",
      method: "PATCH",
      body: { expected_revision: 3, archived: true, unexpected: true },
    },
    {
      name: "关联",
      url: "/api/sessions/s1/documents/doc-1/attach",
      method: "POST",
      body: { version_id: "ver-2", unexpected: true },
    },
    {
      name: "取消关联",
      url: "/api/sessions/s1/documents/doc-1/attach",
      method: "DELETE",
      body: { unexpected: true },
    },
  ])("$name 接口拒绝未知 body 字段", async ({ url, method, body }) => {
    const response = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain("不支持的");
    expect(documents.calls).toHaveLength(0);
  });

  it.each(["clientSecret", "apiToken", "credentials", "callbackURL", "ownerID", "filePath"])(
    "任意深度的敏感 body 字段都被拒绝：%s",
    async (key) => {
      const response = await app.request("/api/sessions/s1/documents/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_file_name: "采购流程.md",
          extension: { nested: [{ [key]: "attacker" }] },
        }),
      });
      expect(response.status).toBe(400);
      expect((await json(response)).detail).toContain(key);
      expect(documents.calls).toHaveLength(0);
    },
  );

  it("写接口也拒绝所有 query 参数", async () => {
    const response = await app.request("/api/sessions/s1/documents/doc-1/archive?dry_run=true", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 3, archived: true }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain("不支持的归档参数");
    expect(documents.calls).toHaveLength(0);
  });

  it("畸形或非对象 JSON 不会被当成空 body 放行业务操作", async () => {
    for (const body of ["{broken", "[]", "null"]) {
      const response = await app.request("/api/sessions/s1/documents/doc-1/attach", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(documents.calls).toHaveLength(0);
  });

  it("别人的会话与不存在的会话一样返回 404", async () => {
    actor = { id: "u2", role: "user" };
    const response = await app.request("/api/sessions/s1/documents");
    expect(response.status).toBe(404);
    expect(documents.calls).toHaveLength(0);
  });

  it("能按原文顺序打开一份材料读，且如实说明这是第几段、一共多少段", async () => {
    // 在这条路由之前，知识库里存进去的文件**没有任何打开入口**：只有 search（要关键词）
    // 和 evidence/:ref/open（要一个已经拿到的引用）。用户刚传完一份 40 页的材料想看看
    // 里面有什么，只能靠猜关键词——这是「知识库看不懂、用不起来」最直接的一条。
    const response = await app.request(
      "/api/sessions/s1/documents/doc-1/content?offset=0&limit=50",
    );
    expect(response.status).toBe(200);
    const payload = await json(response);

    expect(payload.document).toMatchObject({ id: "doc-1" });
    expect(payload.level).toBe("project");
    // 不默默截断：界面要能说「第 1-1 段，共 213 段」。
    expect(payload.total).toBe(213);
    expect(payload.offset).toBe(0);
    // 每段都带 evidence_ref 和引用文案，阅读器里的「引用到对话」直接用它。
    expect(payload.chunks[0]).toMatchObject({
      evidence_ref: "odoc:doc-1:ver-2:chunk-1",
      level: "project",
    });
    expect(payload.chunks[0]).toHaveProperty("cite");
    // 版本正文不外发存储路径。
    expect(JSON.stringify(payload)).not.toContain("rel_path");

    expect(documents.calls.at(-1)).toMatchObject({
      method: "read",
      args: [
        { projectId: "project-1", owner: "u1", actorId: "u1" },
        "doc-1",
        { offset: 0, limit: 50 },
      ],
    });
  });

  it("不传版本时读采用版；读正文的边界字段一律拒绝", async () => {
    await app.request("/api/sessions/s1/documents/doc-1/content");
    // versionId 缺省交给服务层决定（采用版优先，退到最新版），路由不替它猜。
    expect(documents.calls.at(-1)!.args[2]).toEqual({ offset: 0, limit: 100 });

    for (const q of ["project_id=other", "owner=u2", "path=/etc/passwd"]) {
      const denied = await app.request(`/api/sessions/s1/documents/doc-1/content?${q}`);
      expect(denied.status).toBe(400);
    }
  });

  it("会话未归项目时惰性落到默认项目，并把这件事报给前端", async () => {
    // 旧契约是 409「请先选择一个项目」。真实库里 33/42 个会话 project_id 为空，
    // 那等于知识库对大多数会话根本不存在 —— 修好构建之后错误只会从 404 变成 409，
    // 看起来像没修好。改成惰性归入 owner 的默认项目。
    const response = await app.request("/api/sessions/orphan/documents");
    expect(response.status).toBe(200);
    expect(projects.assigned.get("orphan")).toBe("auto-1");
    expect(projects.projects.get("auto-1")).toMatchObject({ name: "我的材料", owner: "u1" });
    // 默认值可以，不告诉人不可以。
    expect((await json(response)).project).toMatchObject({
      auto_created: true,
      name: "我的材料",
    });
  });
});

describe("OntoDocument ACL API", () => {
  it("GET 只用鉴权会话派生 scope，不回传项目 owner 边界", async () => {
    const response = await app.request("/api/sessions/s1/documents/acl");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ revision: 0, rules: [] });
    expect(documents.calls).toEqual([{
      method: "aclSnapshot",
      args: [{ projectId: "project-1", owner: "u1", actorId: "u1" }],
    }]);
  });

  it("PUT 做全量 CAS 替换，principal 只能来自鉴权上下文", async () => {
    const response = await app.request("/api/sessions/s1/documents/acl", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: 0,
        rules: [{
          id: "deny_doc_2",
          subject: { type: "principal", id: "u2" },
          effect: "deny",
          permission: "read",
          resource: { scope_type: "document", document_id: "doc-2" },
        }],
      }),
    });
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload).toMatchObject({ ok: true, revision: 1 });
    expect(payload).not.toHaveProperty("owner");
    expect(payload).not.toHaveProperty("project_id");
    expect(documents.calls).toEqual([{
      method: "replaceAclRules",
      args: [
        { projectId: "project-1", owner: "u1", actorId: "u1" },
        {
          expectedRevision: 0,
          rules: [{
            id: "deny_doc_2",
            subject: { type: "principal", id: "u2" },
            effect: "deny",
            permission: "read",
            resource: { scopeType: "document", documentId: "doc-2" },
          }],
        },
      ],
    }]);
    expect(JSON.stringify(documents.calls)).not.toContain("principalId");
  });

  it.each([
    { owner: "u2", expected_revision: 0, rules: [] },
    { expected_revision: 0, rules: [{ principal_id: "u2" }] },
    { expected_revision: 0, rules: [{ subject: { actorId: "u2" } }] },
    { expected_revision: 0, rules: [{ resource: { projectId: "other" } }] },
  ])("拒绝 body 任意深度注入 owner/project/principal/actor：$owner", async (body) => {
    const response = await app.request("/api/sessions/s1/documents/acl", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(documents.calls).toHaveLength(0);
  });

  it("ACL 规则、主体和资源也使用严格字段白名单", async () => {
    const response = await app.request("/api/sessions/s1/documents/acl", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: 0,
        rules: [{
          id: "deny_doc_2",
          subject: { type: "principal", id: "u2", note: "unexpected" },
          effect: "deny",
          permission: "read",
          resource: { scope_type: "document", document_id: "doc-2" },
        }],
      }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain("不支持的权限主体字段：note");
    expect(documents.calls).toHaveLength(0);
  });

  it("ACL CAS 冲突是人话 409，不会变成 500", async () => {
    documents.aclError = new AclRevisionConflict(1, 2);
    const response = await app.request("/api/sessions/s1/documents/acl", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, rules: [] }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).detail).toContain("系统没有覆盖对方的设置");
  });

  it("底层 ACL 的无权/不存在合并错误统一映射 404", async () => {
    documents.aclError = new DocumentNotFoundOrForbidden();
    const response = await app.request("/api/sessions/s1/documents/acl");
    expect(response.status).toBe(404);
    expect((await json(response)).detail).toContain("没有找到这份项目文档");
  });

  it("安全审计只返回裁决、资源 ID、revision、计数和 query hash", async () => {
    const response = await app.request("/api/sessions/s1/documents/audit?limit=20");
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload).toEqual({
      events: [{
        action: "search.filter",
        decision: "allow",
        scope_type: "project",
        acl_revision: 3,
        query_sha256: "a".repeat(64),
        candidate_count: 5,
        allowed_count: 3,
        denied_count: 2,
      }],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("project-1");
    expect(serialized).not.toContain("u1");
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("internal-rule");
    expect(documents.calls).toEqual([{
      method: "securityAudit",
      args: [{ projectId: "project-1", owner: "u1", actorId: "u1" }, 20],
    }]);
  });

  it("无权查看安全审计统一 404，limit 超界在调用领域层前返回 400", async () => {
    documents.aclError = new DocumentNotFoundOrForbidden();
    const denied = await app.request("/api/sessions/s1/documents/audit");
    expect(denied.status).toBe(404);
    expect((await json(denied)).detail).toContain("没有找到这份项目文档");

    documents.calls.splice(0);
    documents.aclError = null;
    const invalid = await app.request("/api/sessions/s1/documents/audit?limit=201");
    expect(invalid.status).toBe(400);
    expect(documents.calls).toHaveLength(0);
  });
});

describe("材料提升和版本并发控制", () => {
  it("客户端只交文件名，服务端解析安全相对路径后再提升入库", async () => {
    const response = await app.request("/api/sessions/s1/documents/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_file_name: "采购流程.md",
        title: "采购审批流程",
        classification: "会话材料",
        tags: ["采购", "采购"],
      }),
    });
    expect(response.status).toBe(201);
    expect((await json(response)).message).toBe("已把「采购流程.md」保存到项目知识库。");
    const call = documents.calls.find((item) => item.method === "promoteSessionFile")!;
    expect(call.args[0]).toEqual({ projectId: "project-1", owner: "u1", actorId: "u1" });
    expect(call.args[1]).toMatchObject({
      source: {
        sessionId: "s1",
        name: "采购流程.md",
        relPath: "s1/materials/采购流程.md",
        sizeBytes: 32,
        sha256: "abc",
      },
      title: "采购审批流程",
      sourceClass: "session_upload",
      tags: ["采购"],
      createdBy: "u1",
    });
    expect(JSON.stringify(call.args)).not.toContain(ROOT);
  });

  it.each([
    { session_file_name: "采购流程.md", project_id: "other" },
    { session_file_name: "采购流程.md", owner: "u2" },
    { session_file_name: "采购流程.md", path: "/etc/passwd" },
  ])("拒绝 body 里的项目、账号和路径：$project_id$owner$path", async (body) => {
    const response = await app.request("/api/sessions/s1/documents/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(documents.calls).toHaveLength(0);
  });

  it("给已有文档追加版本必须带 base_version_id", async () => {
    const response = await app.request("/api/sessions/s1/documents/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_file_name: "采购流程.md", target_document_id: "doc-1" }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).detail).toContain("避免覆盖别人刚上传的版本");
  });

  it("OCC 冲突返回人话 409，明确说明系统没有覆盖", async () => {
    documents.updateError = new DocumentConflict("REVISION_CONFLICT", "stale");
    const response = await app.request("/api/sessions/s1/documents/doc-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 2, title: "新版标题" }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).detail).toBe(
      "这份文档刚刚被其他人修改过。请刷新后再提交，系统没有覆盖对方的修改。",
    );
  });

  it("领域层拒绝访问时仍统一成 404，不暴露文档是否存在", async () => {
    documents.updateError = new DocumentForbidden();
    const response = await app.request("/api/sessions/s1/documents/doc-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 3, title: "新版标题" }),
    });
    expect(response.status).toBe(404);
    expect((await json(response)).detail).toContain("没有找到这份项目文档");
  });
});

describe("检索、打开与手动管理", () => {
  it("搜索可以选择只查本会话固定版本，并返回可回读的证据引用", async () => {
    const response = await app.request(
      "/api/sessions/s1/documents/search?q=%E5%AE%A1%E6%89%B9&limit=5&attached_only=true",
    );
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.hits[0]).toMatchObject({
      evidence_ref: "odoc:doc-1:ver-2:chunk-1",
      cite: "采购流程.md · 第 2 段",
      text: "采购申请由部门负责人审批。",
      text_sha256: "text-sha",
    });
    // 勾了「只搜本次固定的版本」就只查项目层 —— 那是会话语义，公共库里没有这回事。
    expect(documents.calls[0]).toEqual({
      method: "searchLayered",
      args: [
        [{ projectId: "project-1", owner: "u1", actorId: "u1" }],
        { query: "审批", limit: 5, sessionId: "s1" },
      ],
    });
  });

  it("不勾「只搜本次固定的版本」时两层一起搜，项目库在前", async () => {
    const response = await app.request("/api/sessions/s1/documents/search?q=%E5%AE%A1%E6%89%B9");
    expect(response.status).toBe(200);
    // 页面和模型必须看见同一批材料：模型走 searchLayered，页面也得走，
    // 否则界面永远看不到公共库的材料，而模型看得到 —— 两边说的话就不一致了。
    expect(documents.calls.at(-1)).toEqual({
      method: "searchLayered",
      args: [
        [
          { projectId: "project-1", owner: "u1", actorId: "u1" },
          { projectId: "__global__", owner: "__global__", actorId: "u1" },
        ],
        { query: "审批" },
      ],
    });
  });

  it("按 evidence_ref 打开精确原文，而不是接收文件路径", async () => {
    const response = await app.request(
      "/api/sessions/s1/documents/evidence/odoc%3Adoc-1%3Aver-2%3Achunk-1/open",
    );
    expect(response.status).toBe(200);
    const payload = await json(response);
    expect(payload.evidence).toMatchObject({
      document_id: "doc-1",
      version_id: "ver-2",
      locator: { paragraph: 2 },
      text: "采购申请由部门负责人审批。",
    });
    expect(payload.evidence).not.toHaveProperty("raw");
    expect(documents.calls[0]).toEqual({
      method: "open",
      args: [
        { projectId: "project-1", owner: "u1", actorId: "u1" },
        { evidenceRef: "odoc:doc-1:ver-2:chunk-1" },
      ],
    });
  });

  it("版本历史不暴露存储路径", async () => {
    const response = await app.request("/api/sessions/s1/documents/doc-1/history");
    const payload = await json(response);
    expect(payload.versions[0]).toMatchObject({ id: "ver-2", version_no: 2, chunk_count: 1 });
    expect(payload.versions[0]).not.toHaveProperty("rel_path");
  });

  it("采用版本、归档、关联和取消关联都给出操作后果", async () => {
    const adopt = await app.request("/api/sessions/s1/documents/doc-1/adopt", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: "ver-2", expected_revision: 3 }),
    });
    expect((await json(adopt)).message).toContain("已有会话仍继续使用原来关联的版本");

    const archive = await app.request("/api/sessions/s1/documents/doc-1/archive", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true, expected_revision: 3 }),
    });
    expect((await json(archive)).message).toContain("历史版本和已有引用仍会保留");

    const attach = await app.request("/api/sessions/s1/documents/doc-1/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: "ver-2", role: "reference" }),
    });
    expect(attach.status).toBe(201);
    expect((await json(attach)).message).toContain("不会自动换成别的版本");

    const detach = await app.request("/api/sessions/s1/documents/doc-1/attach", { method: "DELETE" });
    expect((await json(detach)).message).toContain("知识库里的文档没有被删除");

    expect(documents.calls.map((item) => item.method)).toEqual([
      "adopt",
      "archive",
      "attach",
      "detach",
    ]);
  });
});
