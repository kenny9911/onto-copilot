import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentJobRecord } from "../src/document/jobs.js";
import type {
  StartDocumentSearchResult,
} from "../src/document/operations.js";
import type { CoordinatedSearchSnapshotPage } from "../src/document/search_orchestration.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";
import {
  registerDocumentRoutes,
  type DocumentRouteSession,
  type DocumentServicePort,
} from "../src/server/routes/documents.js";
import { stubProjectDirectory } from "./helpers/project_directory.js";

const JOB: DocumentJobRecord = {
  id: "job-1",
  projectId: "project-1",
  owner: "u1",
  documentId: "doc-1",
  versionId: "ver-1",
  kind: "ocr",
  idempotencyKey: "ocr-v1",
  requestSha256: "r".repeat(64),
  sourceSha256: "s".repeat(64),
  expectedIndexRevision: "idx-1",
  input: { language: "zh-CN" },
  status: "succeeded",
  attempts: 1,
  maxAttempts: 2,
  availableAt: "2026-09-02T00:00:00.000Z",
  leaseOwner: null,
  leaseToken: null,
  leaseExpiresAt: null,
  result: {
    type: "onto_document_parse_candidate",
    parsedDoc: { chunks: [{ render: "不应通过 HTTP 返回的候选原文" }] },
  },
  resultSha256: "c".repeat(64),
  lastError: "/private/workspace/secret.pdf parser exploded",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:01:00.000Z",
  startedAt: "2026-09-02T00:00:01.000Z",
  completedAt: "2026-09-02T00:01:00.000Z",
};

const HIT = {
  evidenceRef: "odoc.v1.ref",
  displayCite: "采购规则（v1，line=1）",
  level: "project" as const,
  documentId: "doc-1",
  versionId: "ver-1",
  versionNo: 1,
  documentTitle: "采购规则",
  fileName: "rules.txt",
  chunkId: "chunk-1",
  locator: { line: 1 },
  text: "采购申请需要审批",
  textSha256: "t".repeat(64),
  score: 0.02,
  coverage: { matchedTerms: ["审批"], missingTerms: [], queryTerms: 1, ratio: 1 },
};

const PAGE: CoordinatedSearchSnapshotPage = {
  snapshotId: "snapshot-1",
  manifestSha256: "m".repeat(64),
  aclRevision: 3,
  totalItems: 1,
  querySha256: "q".repeat(64),
  hits: [HIT],
  nextCursor: null,
  expiresAt: "2026-09-02T01:00:00.000Z",
};

const STARTED: StartDocumentSearchResult = {
  search: {
    query: "审批",
    hits: [HIT],
    total: 1,
    searchedVersions: ["ver-1"],
    coverage: HIT.coverage,
  },
  ranking: {
    query: "审批",
    mode: "lexical_only",
    method: "rrf",
    evidenceAvailable: true,
    semantic: { configured: false, applied: false, backend: null, scoredCandidates: 0 },
    hits: [{
      ...HIT,
      ranking: {
        method: "rrf",
        rrfK: 60,
        fusedScore: 0.02,
        lexical: { rank: 1, rawScore: 1, weight: 1, contribution: 0.02 },
        semantic: null,
      },
    }],
  },
  snapshot: {
    id: "snapshot-1",
    projectId: "project-1",
    owner: "u1",
    sessionId: null,
    querySha256: "q".repeat(64),
    manifest: [],
    manifestSha256: "m".repeat(64),
    aclRevision: 3,
    status: "active",
    invalidatedReason: "",
    totalItems: 1,
    expiresAt: PAGE.expiresAt,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
  page: PAGE,
};

class FakeOperations {
  readonly enqueueJob = vi.fn(async () => JOB);
  readonly listJobs = vi.fn(async () => ({ items: [JOB], offset: 0, nextOffset: null }));
  readonly getJob = vi.fn(async () => JOB);
  readonly cancelJob = vi.fn(async () => ({ ...JOB, status: "cancelled" as const }));
  readonly startSearch = vi.fn(async () => STARTED);
  readonly continueSearch = vi.fn(async () => PAGE);
}

let app: Hono<AppEnv>;
let operations: FakeOperations;
let actor: RequestUser;

const session: DocumentRouteSession = {
  id: "s1",
  projectId: "project-1",
  owner: "u1",
  files: [],
};

beforeEach(() => {
  actor = { id: "u1", role: "user" };
  operations = new FakeOperations();
  app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("user", actor);
    await next();
  });
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  });
  registerDocumentRoutes(app, {
    documents: {} as DocumentServicePort,
    operations,
    projects: stubProjectDirectory(),
    sessionById: async (sid) => {
      if (sid !== session.id) throw new HTTPException(404, { message: "没有会话" });
      return session;
    },
  });
});

async function payload(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

describe("OntoDocument job HTTP", () => {
  it("只接收 exact document/version 与安全选项，身份和路径来自服务端", async () => {
    const response = await app.request("/api/sessions/s1/documents/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_id: "doc-1",
        version_id: "ver-1",
        kind: "ocr",
        idempotency_key: "ocr-v1",
        options: { language: "zh-CN", pages: [1] },
      }),
    });
    expect(response.status).toBe(202);
    expect(operations.enqueueJob).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      {
        documentId: "doc-1",
        versionId: "ver-1",
        kind: "ocr",
        idempotencyKey: "ocr-v1",
        input: { language: "zh-CN", pages: [1] },
        maxAttempts: 2,
      },
    );
    const body = await payload(response);
    expect(body.job).toMatchObject({ candidate_ready: true, result_sha256: "c".repeat(64) });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("候选原文");
    expect(serialized).not.toContain("result_candidate");
    expect(serialized).not.toContain("private/workspace");
    expect(serialized).not.toContain("project-1");
    expect(serialized).not.toContain('"owner"');
  });

  it.each([
    { owner: "u2" },
    { options: { projectId: "other" } },
    { options: { path: "/etc/passwd" } },
    { options: { url: "https://attacker.invalid/file" } },
    { options: { nested: { token: "secret" } } },
  ])("拒绝任务参数注入：%j", async (injected) => {
    const response = await app.request("/api/sessions/s1/documents/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document_id: "doc-1",
        version_id: "ver-1",
        kind: "parse",
        idempotency_key: "parse-v1",
        ...injected,
      }),
    });
    expect(response.status).toBe(400);
    expect(operations.enqueueJob).not.toHaveBeenCalled();
  });

  it("list/get/cancel 只使用会话 scope，且没有 run/commit HTTP 出口", async () => {
    const list = await app.request(
      "/api/sessions/s1/documents/jobs?status=succeeded&kind=ocr&document_id=doc-1&limit=20&offset=0",
    );
    expect(list.status).toBe(200);
    expect(operations.listJobs).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      { status: "succeeded", kind: "ocr", documentId: "doc-1", limit: 20, offset: 0 },
    );
    expect((await payload(list)).jobs[0]).toMatchObject({ id: "job-1", candidate_ready: true });

    expect((await app.request("/api/sessions/s1/documents/jobs/job-1")).status).toBe(200);
    expect((await app.request("/api/sessions/s1/documents/jobs/job-1", { method: "DELETE" })).status).toBe(200);
    expect(operations.getJob).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      "job-1",
    );
    expect(operations.cancelJob).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      "job-1",
    );
    expect((await app.request("/api/sessions/s1/documents/jobs/job-1/run", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/sessions/s1/documents/jobs/job-1/commit", { method: "POST" })).status).toBe(404);
  });
});

describe("OntoDocument snapshot search HTTP", () => {
  it("初次搜索固定快照并如实说明 lexical_only，续页必须提交原查询", async () => {
    const initial = await app.request("/api/sessions/s1/documents/search-snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "审批", attached_only: true, limit: 50, page_size: 10 }),
    });
    expect(initial.status).toBe(200);
    expect(operations.startSearch).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      {
        options: { query: "审批", limit: 50, sessionId: "s1" },
        pageSize: 10,
      },
    );
    expect(await payload(initial)).toMatchObject({
      mode: "lexical_only",
      method: "rrf",
      semantic: { configured: false, applied: false, backend: null },
      snapshot: { id: "snapshot-1", acl_revision: 3, total_items: 1 },
      evidence_available: true,
    });

    const next = await app.request(
      "/api/sessions/s1/documents/search-snapshots/snapshot-1/page",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "审批", cursor: "opaque-cursor", limit: 10 }),
      },
    );
    expect(next.status).toBe(200);
    expect(operations.continueSearch).toHaveBeenCalledWith(
      { projectId: "project-1", owner: "u1", actorId: "u1" },
      { snapshotId: "snapshot-1", query: "审批", cursor: "opaque-cursor", limit: 10 },
    );
  });

  it("空命中保留检索范围，并明确不能据此断言文件或事实不存在", async () => {
    operations.startSearch.mockResolvedValueOnce({
      search: {
        query: "没有匹配",
        hits: [],
        total: 0,
        searchedVersions: ["ver-1"],
        coverage: { matchedTerms: [], missingTerms: ["没有匹配"], queryTerms: 1, ratio: 0 },
      },
      ranking: {
        query: "没有匹配",
        mode: "lexical_only",
        method: "rrf",
        evidenceAvailable: false,
        semantic: { configured: false, applied: false, backend: null, scoredCandidates: 0 },
        hits: [],
      },
      snapshot: null,
      page: null,
    });
    const response = await app.request("/api/sessions/s1/documents/search-snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "没有匹配" }),
    });
    expect(response.status).toBe(200);
    const body = await payload(response);
    expect(body).toMatchObject({
      snapshot: null,
      hits: [],
      evidence_available: false,
      searched_versions: ["ver-1"],
    });
    expect(body.message).toContain("不表示文件或业务事实不存在");
  });
});
