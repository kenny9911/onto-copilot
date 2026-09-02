import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import { makeChunk, makeParsedDoc, type ParsedDoc } from "../src/onto/parse/base.js";
import {
  DocumentAclController,
  DocumentNotFoundOrForbidden,
  MemoryDocumentAclRepository,
} from "../src/document/acl.js";
import { MemoryDocumentSecurityAuditRepository } from "../src/document/audit.js";
import {
  DocumentJobFacade,
  type CommitDerivedVersionInput,
} from "../src/document/job_facade.js";
import { documentJobAuthorizationGuard } from "../src/document/operations.js";
import {
  MemoryDocumentJobRepository,
  SqlDocumentJobRepository,
  type DocumentJobRepository,
  type NewDocumentJob,
} from "../src/document/jobs.js";
import {
  MemoryDocumentRepository,
  SqlDocumentRepository,
  type DocumentRepository,
} from "../src/document/repository.js";
import {
  DocumentSearchSnapshotService,
  MemoryDocumentSearchSnapshotRepository,
} from "../src/document/search_snapshot.js";
import {
  HybridDocumentSearch,
  SnapshotSearchCoordinator,
  type SemanticScoreRequest,
} from "../src/document/search_orchestration.js";
import { buildDocumentOperations } from "../src/document/operations_deps.js";
import { DocumentService } from "../src/document/service.js";
import type {
  DocumentScope,
  DocumentSearchHit,
  StoredDocumentChunk,
} from "../src/document/types.js";
import { Store } from "../src/store/engine.js";

const temporaryRoots: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface SeededVersion {
  readonly documentId: string;
  readonly versionId: string;
  readonly relPath: string;
  readonly content: string;
  readonly parsedDoc: ParsedDoc;
}

async function seedVersion(
  repository: DocumentRepository,
  scope: DocumentScope,
  options: { readonly relPath?: string; readonly content?: string } = {},
): Promise<SeededVersion> {
  const documentId = "doc_rules";
  const versionId = "ver_rules_1";
  const content = options.content ?? "采购申请必须填写需求日期\n金额超过十万元需要总经理审批";
  const relPath = options.relPath ?? "projects/project_A/documents/doc_rules/ver_rules_1/original/rules.txt";
  const parsedDoc = makeParsedDoc({ fileId: versionId, fileName: "rules.txt", kind: "text" });
  parsedDoc.chunks.push(
    makeChunk({
      docId: "line-1",
      fileId: versionId,
      fileName: "rules.txt",
      locator: { line: 1 },
      render: "采购申请必须填写需求日期",
      raw: { line: 1 },
      order: 0,
      tags: ["rule"],
    }),
    makeChunk({
      docId: "line-2",
      fileId: versionId,
      fileName: "rules.txt",
      locator: { line: 2 },
      render: "金额超过十万元需要总经理审批",
      raw: { line: 2 },
      order: 1,
      tags: ["rule"],
    }),
  );
  const chunks: StoredDocumentChunk[] = parsedDoc.chunks.map((chunk) => ({
    documentId,
    versionId,
    chunkId: chunk.chunk_id,
    order: chunk.order,
    locator: chunk.locator,
    render: chunk.render,
    raw: chunk.raw,
    tags: chunk.tags,
    context: chunk.context,
    textSha256: sha256Hex(chunk.render),
  }));
  await repository.commitVersion({
    scope,
    documentId,
    newDocument: {
      id: documentId,
      title: "采购规则",
      logicalName: "采购规则",
      sourceClass: "imported",
      tags: ["采购"],
      createdBy: scope.owner,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    version: {
      id: versionId,
      documentId,
      fileName: "rules.txt",
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(content),
      sha256: sha256Hex(content),
      relPath,
      docKind: "text",
      parsedDoc,
      parseStatus: "ready",
      parserName: "fixture",
      parserVersion: "1",
      indexRevision: "index-r1",
      chunkCount: chunks.length,
      createdBy: scope.owner,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    chunks,
  });
  return { documentId, versionId, relPath, content, parsedDoc };
}

function hit(id: string, score: number): DocumentSearchHit {
  const text = `材料原文 ${id}`;
  return {
    evidenceRef: `ref-${id}`,
    displayCite: `cite-${id}`,
    level: "project" as const,
    documentId: "doc",
    versionId: "version",
    versionNo: 1,
    documentTitle: "材料",
    fileName: "material.txt",
    chunkId: id,
    locator: { line: id },
    text,
    textSha256: sha256Hex(text),
    score,
    coverage: {
      matchedTerms: ["材料"],
      missingTerms: [],
      queryTerms: 1,
      ratio: 1,
    },
  };
}

describe("HybridDocumentSearch", () => {
  it("没有语义后端时明确保持 lexical_only，不伪造语义分", async () => {
    const result = await new HybridDocumentSearch().rank({
      query: "采购规则",
      bm25Hits: [hit("b", 2), hit("a", 3)],
    });
    expect(result).toMatchObject({
      mode: "lexical_only",
      evidenceAvailable: true,
      semantic: { configured: false, applied: false, backend: null, scoredCandidates: 0 },
    });
    expect(result.hits.map((item) => item.chunkId)).toEqual(["a", "b"]);
    expect(result.hits.map((item) => item.ranking.semantic)).toEqual([null, null]);
    expect(result.hits[0]!.ranking.lexical).toMatchObject({ rank: 1, rawScore: 3 });

    const empty = await new HybridDocumentSearch().rank({ query: "采购", bm25Hits: [] });
    expect(empty).toMatchObject({ evidenceAvailable: false, hits: [] });
  });

  it("用确定性 RRF 融合且保留两路原始分；后端不能生成未知证据", async () => {
    const scorer = {
      name: "fixture-semantic-v1",
      async score(request: SemanticScoreRequest) {
        return request.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          score: candidate.chunkId === "c" ? 100 : candidate.chunkId === "b" ? 50 : 1,
        }));
      },
    };
    const result = await new HybridDocumentSearch({
      semanticScorer: scorer,
      semanticWeight: 2,
      rrfK: 10,
    }).rank({
      query: "采购规则",
      bm25Hits: [hit("a", 100), hit("b", 50), hit("c", 1)],
    });
    expect(result.mode).toBe("hybrid");
    expect(result.hits.map((item) => item.chunkId)).toEqual(["c", "b", "a"]);
    expect(result.hits[0]!.ranking).toMatchObject({
      method: "rrf",
      lexical: { rank: 3, rawScore: 1 },
      semantic: { backend: "fixture-semantic-v1", rank: 1, rawScore: 100 },
    });

    const unknown = new HybridDocumentSearch({
      semanticScorer: {
        name: "bad",
        async score() {
          return [{ candidateId: "invented", score: 1 }];
        },
      },
    });
    await expect(unknown.rank({ query: "采购", bm25Hits: [hit("a", 1)] })).rejects.toMatchObject({
      code: "SEMANTIC_RESULT_INVALID",
    });
    const emptySemantic = new HybridDocumentSearch({
      semanticScorer: { name: "empty", async score() { return []; } },
    });
    await expect(
      emptySemantic.rank({ query: "采购", bm25Hits: [hit("a", 1)] }),
    ).rejects.toMatchObject({ code: "SEMANTIC_RESULT_INVALID" });
  });
});

describe("SnapshotSearchCoordinator", () => {
  it("只接受真实 search hits，并跨页恢复完整、哈希校验后的命中", async () => {
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    await seedVersion(documents, scope);
    const search = new DocumentService({ repository: documents, workspaceRoot: "/unused" });
    const result = await search.search(scope, { query: "采购申请 金额", limit: 10 });
    expect(result.hits).toHaveLength(2);
    const snapshots = new MemoryDocumentSearchSnapshotRepository();
    snapshots.setAclRevision(scope, 0);
    const snapshotService = new DocumentSearchSnapshotService({
      repository: snapshots,
      documents,
      now: () => new Date("2026-09-02T01:00:00.000Z"),
      newId: () => "snapshot_coordinated",
    });
    const coordinator = new SnapshotSearchCoordinator({
      service: snapshotService,
      snapshots,
      documents,
    });
    const snapshot = await coordinator.create(scope, {
      query: result.query,
      hits: result.hits,
      ttlMs: 60_000,
    });
    const first = await coordinator.page(scope, {
      snapshotId: snapshot.id,
      query: result.query,
      limit: 1,
    });
    const second = await coordinator.page(scope, {
      snapshotId: snapshot.id,
      query: result.query,
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect([...first.hits, ...second.hits]).toEqual(result.hits);
    expect(second.nextCursor).toBeNull();
    expect(first.querySha256).toBe(sha256Hex(result.query));

    await expect(
      coordinator.page(scope, { snapshotId: snapshot.id, query: "另一个问题" }),
    ).rejects.toMatchObject({ code: "QUERY_MISMATCH" });
    await expect(
      coordinator.create(scope, { query: "采购", hits: [] }),
    ).rejects.toMatchObject({ code: "EMPTY_RESULT" });
    await expect(
      coordinator.create(scope, {
        query: result.query,
        hits: [{ ...result.hits[0]!, text: "伪造正文" }],
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("物化命中期间 ACL 变化时使快照失效，不返回已经撤权的正文", async () => {
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    await seedVersion(documents, scope);
    const search = new DocumentService({ repository: documents, workspaceRoot: "/unused" });
    const result = await search.search(scope, { query: "采购申请", limit: 10 });
    const snapshots = new MemoryDocumentSearchSnapshotRepository();
    snapshots.setAclRevision(scope, 0);
    const service = new DocumentSearchSnapshotService({
      repository: snapshots,
      documents,
      now: () => new Date("2026-09-02T01:00:00.000Z"),
      newId: () => "snapshot_acl_race",
    });
    const coordinator = new SnapshotSearchCoordinator({ service, snapshots, documents });
    const snapshot = await coordinator.create(scope, { query: result.query, hits: result.hits });

    const revision = vi.spyOn(snapshots, "currentAclRevision");
    revision
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    await expect(
      coordinator.page(scope, { snapshotId: snapshot.id, query: result.query }),
    ).rejects.toMatchObject({ code: "ACL_CHANGED" });
    expect((await snapshots.get(scope, snapshot.id))?.status).toBe("invalidated");
  });
});

describe("DocumentOperations 生产装配", () => {
  it("内存快照只读取 live ACL revision，不要求只读用户拥有 manage_acl", async () => {
    const store = await Store.open("");
    stores.push(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    await seedVersion(documents, scope);
    const audit = new MemoryDocumentSecurityAuditRepository();
    let auditId = 0;
    const acl = new DocumentAclController(
      new MemoryDocumentAclRepository(audit),
      audit,
      () => `audit-${++auditId}`,
      () => "2026-09-02T01:00:00.000Z",
    );
    const readRule = {
      id: "reader_can_read",
      subject: { type: "principal" as const, id: "bob" },
      effect: "allow" as const,
      permission: "read" as const,
      resource: { scopeType: "project" as const },
    };
    await acl.replaceRules(
      { id: "alice", groupIds: [] },
      { boundary: scope, expectedRevision: 0, rules: [readRule] },
    );
    await expect(
      acl.snapshotForManagement(scope, { id: "bob", groupIds: [] }),
    ).rejects.toBeInstanceOf(DocumentNotFoundOrForbidden);

    const currentRevision = vi.spyOn(acl, "currentRevision");
    const management = vi.spyOn(acl, "snapshotForManagement");
    const service = new DocumentService({ repository: documents, workspaceRoot: "/unused", acl });
    const operations = buildDocumentOperations({
      store,
      documents: service,
      repository: documents,
      acl,
      workspaceRoot: "/unused",
      resumeQueued: false,
    });
    const started = await operations.startSearch(scope, {
      options: { query: "采购申请 金额", limit: 10 },
      pageSize: 1,
      ttlMs: 60_000,
    });
    expect(started.ranking).toMatchObject({
      mode: "lexical_only",
      method: "rrf",
      semantic: { configured: false, applied: false, backend: null },
    });
    expect(started.snapshot).not.toBeNull();
    expect(started.page?.nextCursor).not.toBeNull();
    expect(currentRevision).toHaveBeenCalledWith(scope);
    // 上面的显式权限断言之后清零；快照装配本身绝不能再调用管理授权。
    expect(management).not.toHaveBeenCalled();

    await acl.replaceRules(
      { id: "alice", groupIds: [] },
      {
        boundary: scope,
        expectedRevision: 1,
        rules: [
          readRule,
          {
            id: "reader_two_can_read",
            subject: { type: "principal", id: "carol" },
            effect: "allow",
            permission: "read",
            resource: { scopeType: "project" },
          },
        ],
      },
    );
    await expect(
      operations.continueSearch(scope, {
        snapshotId: started.snapshot!.id,
        query: started.search.query,
        cursor: started.page!.nextCursor!,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "ACL_CHANGED" });
  });

  it("startSearch 只让语义评分器重排真实 BM25 候选，再固定融合顺序", async () => {
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    await seedVersion(documents, scope);
    const service = new DocumentService({ repository: documents, workspaceRoot: "/unused" });
    const lexical = await service.search(scope, { query: "采购申请 金额", limit: 10 });
    const snapshots = new MemoryDocumentSearchSnapshotRepository();
    const snapshotService = new DocumentSearchSnapshotService({
      repository: snapshots,
      documents,
      newId: () => "snapshot_hybrid_production",
    });
    const seenCandidates: string[] = [];
    const hybrid = new HybridDocumentSearch({
      semanticWeight: 10,
      semanticScorer: {
        name: "fixture-semantic",
        async score(request) {
          seenCandidates.push(...request.candidates.map((candidate) => candidate.candidateId));
          return request.candidates.map((candidate, index) => ({
            candidateId: candidate.candidateId,
            score: index === request.candidates.length - 1 ? 100 : 1,
          }));
        },
      },
    });
    const audit = new MemoryDocumentSecurityAuditRepository();
    const acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
    const operations = new (await import("../src/document/operations.js")).DocumentOperations({
      documents: service,
      acl,
      jobs: new DocumentJobFacade({
        repository: new MemoryDocumentJobRepository(),
        documents,
        workspaceRoot: "/unused",
      }),
      hybrid,
      searches: new SnapshotSearchCoordinator({
        service: snapshotService,
        snapshots,
        documents,
      }),
    });
    const result = await operations.startSearch(scope, {
      options: { query: lexical.query, limit: 10 },
      pageSize: 10,
    });
    expect(result.ranking).toMatchObject({
      mode: "hybrid",
      semantic: { configured: true, applied: true, backend: "fixture-semantic" },
    });
    expect(seenCandidates).toHaveLength(lexical.hits.length);
    expect(new Set(seenCandidates).size).toBe(lexical.hits.length);
    expect(result.page?.hits.map((item) => item.chunkId)).toEqual(
      result.ranking.hits.map((item) => item.chunkId),
    );
    expect(result.page?.hits.every((item) => lexical.hits.some(
      (source) => source.documentId === item.documentId &&
        source.versionId === item.versionId &&
        source.chunkId === item.chunkId &&
        source.textSha256 === item.textSha256,
    ))).toBe(true);
  });

  it("撤权发生在检索后、快照创建前时，不得用新 ACL revision 包装旧命中", async () => {
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    await seedVersion(documents, scope);
    const audit = new MemoryDocumentSecurityAuditRepository();
    const acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
    const service = new DocumentService({ repository: documents, workspaceRoot: "/unused", acl });
    const snapshots = new MemoryDocumentSearchSnapshotRepository(
      async (boundary) => await acl.currentRevision(boundary),
    );
    const snapshotService = new DocumentSearchSnapshotService({
      repository: snapshots,
      documents,
      newId: () => "snapshot_revoked_during_create",
    });
    const coordinator = new SnapshotSearchCoordinator({
      service: snapshotService,
      snapshots,
      documents,
    });
    const originalCreate = coordinator.create.bind(coordinator);
    vi.spyOn(coordinator, "create").mockImplementation(async (boundary, input) => {
      await acl.replaceRules(
        { id: scope.owner, groupIds: [] },
        {
          boundary: scope,
          expectedRevision: 0,
          rules: [{
            id: "deny_owner_read_mid_snapshot",
            subject: { type: "principal", id: scope.owner },
            effect: "deny",
            permission: "read",
            resource: { scopeType: "project" },
          }],
        },
      );
      return await originalCreate(boundary, input);
    });
    const operations = new (await import("../src/document/operations.js")).DocumentOperations({
      documents: service,
      acl,
      jobs: new DocumentJobFacade({
        repository: new MemoryDocumentJobRepository(),
        documents,
        workspaceRoot: "/unused",
      }),
      hybrid: new HybridDocumentSearch(),
      searches: coordinator,
    });

    await expect(operations.startSearch(scope, {
      options: { query: "采购申请 金额", limit: 10 },
    })).rejects.toBeInstanceOf(DocumentNotFoundOrForbidden);
    expect((await snapshots.get(scope, "snapshot_revoked_during_create"))?.status)
      .toBe("invalidated");
  });
});

function jobSeed(
  scope: DocumentScope,
  id: string,
  createdAt: string,
  overrides: Partial<Pick<NewDocumentJob, "kind" | "documentId">> = {},
): NewDocumentJob {
  return {
    id,
    scope,
    documentId: overrides.documentId ?? "doc_rules",
    versionId: "ver_rules_1",
    kind: overrides.kind ?? "parse",
    idempotencyKey: `key-${id}`,
    requestSha256: sha256Hex(`request-${id}`),
    sourceSha256: sha256Hex("source"),
    expectedIndexRevision: "index-r1",
    input: {},
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  };
}

async function verifyJobListing(repository: DocumentJobRepository): Promise<void> {
  const scope = { projectId: "project_A", owner: "alice" };
  const other = { projectId: "project_B", owner: "alice" };
  await repository.enqueue(jobSeed(scope, "job_1", "2026-09-02T00:00:01.000Z"));
  await repository.enqueue(jobSeed(scope, "job_2", "2026-09-02T00:00:02.000Z", { kind: "ocr" }));
  await repository.enqueue(jobSeed(scope, "job_3", "2026-09-02T00:00:03.000Z"));
  await repository.enqueue(jobSeed(other, "job_other", "2026-09-02T00:00:04.000Z"));
  expect((await repository.list(scope, { limit: 2, offset: 0 })).map((job) => job.id)).toEqual([
    "job_3",
    "job_2",
  ]);
  expect((await repository.list(scope, { limit: 2, offset: 2 })).map((job) => job.id)).toEqual([
    "job_1",
  ]);
  expect((await repository.list(scope, { kind: "ocr" })).map((job) => job.id)).toEqual(["job_2"]);
  expect(await repository.list({ projectId: "project_C", owner: "alice" })).toEqual([]);
}

describe("文档任务 list 契约", () => {
  it("Memory 与 SQL 都分页、过滤并隔离 scope", async () => {
    await verifyJobListing(new MemoryDocumentJobRepository());
    const store = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
    stores.push(store);
    await verifyJobListing(new SqlDocumentJobRepository(store));
  });
});

describe("DocumentJobFacade", () => {
  it("queued 任务在处理前被撤权时永久失败，且不会读取或解析源文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-job-revoked-"));
    temporaryRoots.push(root);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    const seeded = await seedVersion(documents, scope);
    const exactPath = join(root, seeded.relPath);
    await mkdir(dirname(exactPath), { recursive: true });
    await writeFile(exactPath, seeded.content);

    const audit = new MemoryDocumentSecurityAuditRepository();
    const acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
    const principal = { id: scope.owner, groupIds: [] as string[] };
    const resource = {
      scopeType: "version" as const,
      documentId: seeded.documentId,
      versionId: seeded.versionId,
    };
    await expect(acl.authorizeWrite(scope, principal, resource)).resolves.toBeDefined();

    const facade = new DocumentJobFacade({
      repository: new MemoryDocumentJobRepository(),
      documents,
      workspaceRoot: root,
      parser: facadeParserThatMustNotRun(),
      beforeProcess: documentJobAuthorizationGuard(acl),
      newId: () => "job_revoked",
      newLeaseToken: () => "lease-revoked",
      retryDelayMs: () => 0,
    });
    await facade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:revoked-before-run",
      maxAttempts: 3,
    });

    await acl.replaceRules(principal, {
      boundary: scope,
      expectedRevision: 0,
      rules: [{
        id: "deny_owner_write",
        subject: { type: "principal", id: scope.owner },
        effect: "deny",
        permission: "write",
        resource: { scopeType: "project" },
      }],
    });
    await expect(acl.authorizeWrite(scope, principal, resource)).rejects.toBeInstanceOf(
      DocumentNotFoundOrForbidden,
    );

    expect(await facade.run("worker-revoked")).toMatchObject({
      state: "failed",
      job: { status: "failed", attempts: 1, result: {} },
    });
  });

  it("长时间解析期间被撤权时不保存候选结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-job-mid-revoke-"));
    temporaryRoots.push(root);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    const seeded = await seedVersion(documents, scope);
    const exactPath = join(root, seeded.relPath);
    await mkdir(dirname(exactPath), { recursive: true });
    await writeFile(exactPath, seeded.content);

    const audit = new MemoryDocumentSecurityAuditRepository();
    const acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
    const principal = { id: scope.owner, groupIds: [] as string[] };
    let parserCalls = 0;
    const facade = new DocumentJobFacade({
      repository: new MemoryDocumentJobRepository(),
      documents,
      workspaceRoot: root,
      parser: {
        async parse(): Promise<ParsedDoc> {
          parserCalls += 1;
          await acl.replaceRules(principal, {
            boundary: scope,
            expectedRevision: 0,
            rules: [{
              id: "deny_owner_mid_process",
              subject: { type: "principal", id: scope.owner },
              effect: "deny",
              permission: "write",
              resource: { scopeType: "project" },
            }],
          });
          return seeded.parsedDoc;
        },
      },
      beforeProcess: documentJobAuthorizationGuard(acl),
      newId: () => "job_mid_revoke",
      newLeaseToken: () => "lease-mid-revoke",
      retryDelayMs: () => 0,
    });
    await facade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:revoked-during-run",
      maxAttempts: 3,
    });

    expect(await facade.run("worker-mid-revoke")).toMatchObject({
      state: "failed",
      job: { status: "failed", attempts: 1, result: {} },
    });
    expect(parserCalls).toBe(1);
  });

  it("无需额外 worker 配置即可用现有 registry 解析 exact relPath，OCR 则使用显式处理器", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-job-default-"));
    temporaryRoots.push(root);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    const seeded = await seedVersion(documents, scope);
    const exactPath = join(root, seeded.relPath);
    await mkdir(dirname(exactPath), { recursive: true });
    await writeFile(exactPath, seeded.content);

    let id = 0;
    const defaultFacade = new DocumentJobFacade({
      repository: new MemoryDocumentJobRepository(),
      documents,
      workspaceRoot: root,
      newId: () => `job_default_${++id}`,
      newLeaseToken: () => "lease-default",
    });
    await defaultFacade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:default-registry",
    });
    expect(await defaultFacade.run("worker-default")).toMatchObject({
      state: "succeeded",
      job: {
        result: {
          candidateKind: "parse",
          processor: { name: "default-registry", version: "1" },
        },
      },
    });

    const ocrFacade = new DocumentJobFacade({
      repository: new MemoryDocumentJobRepository(),
      documents,
      workspaceRoot: root,
      newId: () => "job_ocr",
      newLeaseToken: () => "lease-ocr",
      ocrProcessor: {
        name: "fixture-ocr",
        version: "2026.09",
        async process(context) {
          expect(context.exactPath).toBe(await realpath(exactPath));
          const parsed = makeParsedDoc({
            fileId: context.version.id,
            fileName: context.version.fileName,
            kind: "ocr-text",
          });
          parsed.chunks.push(
            makeChunk({
              docId: "ocr-page-1",
              fileId: context.version.id,
              fileName: context.version.fileName,
              locator: { page: 1 },
              render: "OCR 读取到的候选正文",
            }),
          );
          return parsed;
        },
      },
    });
    await ocrFacade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "ocr",
      idempotencyKey: "ocr:fixture",
    });
    expect(await ocrFacade.run("worker-ocr")).toMatchObject({
      state: "succeeded",
      job: {
        result: {
          candidateKind: "ocr",
          processor: { name: "fixture-ocr", version: "2026.09" },
        },
      },
    });
  });

  it("默认 parser 只产出候选，保留源版本；显式 committer 也只能创建未采用的新版本", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-job-"));
    temporaryRoots.push(root);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    const seeded = await seedVersion(documents, scope);
    const exactPath = join(root, seeded.relPath);
    await mkdir(dirname(exactPath), { recursive: true });
    await writeFile(exactPath, seeded.content);
    const jobs = new MemoryDocumentJobRepository();
    const now = () => new Date("2026-09-02T02:00:00.000Z");
    const parser = {
      async parse(path: string, options: { readonly fileId: string }) {
        expect(path).toBe(await realpath(exactPath));
        expect(await readFile(path, "utf8")).toBe(seeded.content);
        const parsed = makeParsedDoc({ fileId: options.fileId, fileName: "rules.txt", kind: "text" });
        parsed.chunks.push(
          makeChunk({
            docId: "derived-line-1",
            fileId: options.fileId,
            fileName: "rules.txt",
            locator: { line: 1 },
            render: "OCR/重新解析得到的候选正文",
          }),
        );
        return parsed;
      },
    };
    let id = 0;
    const facade = new DocumentJobFacade({
      repository: jobs,
      documents,
      workspaceRoot: root,
      parser,
      now,
      newId: () => `job_facade_${++id}`,
      newLeaseToken: () => "lease-fixed",
    });
    const queued = await facade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:derived",
    });
    expect(await facade.get({ projectId: "other", owner: "alice" }, queued.id)).toBeNull();
    expect(await facade.list(scope, { limit: 1 })).toMatchObject({
      items: [{ id: queued.id, status: "queued" }],
      nextOffset: null,
    });
    const sourceBefore = await documents.getVersion(scope, seeded.documentId, seeded.versionId);
    const outcome = await facade.run("worker-parse");
    expect(outcome).toMatchObject({
      state: "succeeded",
      job: {
        result: {
          type: "onto_document_parse_candidate",
          immutableSource: true,
          requiresNewVersion: true,
          source: { versionId: seeded.versionId },
        },
      },
    });
    expect(await documents.getVersion(scope, seeded.documentId, seeded.versionId)).toEqual(sourceBefore);
    await expect(
      facade.commitCandidate(scope, queued.id, { baseVersionId: seeded.versionId }),
    ).rejects.toMatchObject({ code: "COMMITTER_NOT_CONFIGURED" });

    let commitInput: CommitDerivedVersionInput | null = null;
    const withCommitter = new DocumentJobFacade({
      repository: jobs,
      documents,
      workspaceRoot: root,
      parser,
      now,
      committer: {
        async commitDerivedVersion(input) {
          commitInput = input;
          return {
            documentId: input.job.documentId,
            sourceVersionId: input.sourceVersion.id,
            derivedVersionId: "ver_rules_derived",
            adopted: false,
          };
        },
      },
    });
    expect(
      await withCommitter.commitCandidate(scope, queued.id, { baseVersionId: seeded.versionId }),
    ).toEqual({
      documentId: seeded.documentId,
      sourceVersionId: seeded.versionId,
      derivedVersionId: "ver_rules_derived",
      adopted: false,
    });
    expect(commitInput).toMatchObject({ adopt: false, baseVersionId: seeded.versionId });
    expect(await documents.getVersion(scope, seeded.documentId, seeded.versionId)).toEqual(sourceBefore);
  });

  it("空解析结果和文件 SHA 不一致都永久失败，不会生成伪候选", async () => {
    const root = await mkdtemp(join(tmpdir(), "ontodocument-job-fail-"));
    temporaryRoots.push(root);
    const scope = { projectId: "project_A", owner: "alice" };
    const documents = new MemoryDocumentRepository();
    const seeded = await seedVersion(documents, scope);
    const exactPath = join(root, seeded.relPath);
    await mkdir(dirname(exactPath), { recursive: true });
    await writeFile(exactPath, seeded.content);
    const jobs = new MemoryDocumentJobRepository();
    const facade = new DocumentJobFacade({
      repository: jobs,
      documents,
      workspaceRoot: root,
      parser: {
        async parse(_path, options) {
          return makeParsedDoc({ fileId: options.fileId, fileName: "rules.txt", kind: "text" });
        },
      },
      newId: () => "job_empty",
      newLeaseToken: () => "lease-empty",
      retryDelayMs: () => 0,
    });
    await facade.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:empty",
      maxAttempts: 3,
    });
    expect(await facade.run("worker-empty")).toMatchObject({
      state: "failed",
      job: { status: "failed", attempts: 1, result: {} },
    });

    const corruptJobs = new MemoryDocumentJobRepository();
    const corrupt = new DocumentJobFacade({
      repository: corruptJobs,
      documents,
      workspaceRoot: root,
      parser: facadeParserThatMustNotRun(),
      newId: () => "job_corrupt",
      newLeaseToken: () => "lease-corrupt",
    });
    await corrupt.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:corrupt",
    });
    await writeFile(exactPath, "被修改的文件");
    expect(await corrupt.run("worker-corrupt")).toMatchObject({
      state: "failed",
      job: { status: "failed", attempts: 1, result: {} },
    });
  });
});

function facadeParserThatMustNotRun() {
  return {
    async parse(): Promise<ParsedDoc> {
      throw new Error("文件校验失败后不应调用 parser");
    },
  };
}
