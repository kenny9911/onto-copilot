import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import { makeChunk, makeParsedDoc } from "../src/onto/parse/base.js";
import { Store } from "../src/store/engine.js";
import {
  DocumentJobQueue,
  DocumentJobRunner,
  DocumentJobWorkerError,
  SqlDocumentJobRepository,
} from "../src/document/jobs.js";
import { SqlDocumentRepository, type DocumentRepository } from "../src/document/repository.js";
import {
  DocumentSearchSnapshotService,
  SqlDocumentSearchSnapshotRepository,
} from "../src/document/search_snapshot.js";
import type { DocumentScope, StoredDocumentChunk } from "../src/document/types.js";

const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

class Clock {
  constructor(private value: number) {}

  readonly now = (): Date => new Date(this.value);

  advance(ms: number): void {
    this.value += ms;
  }
}

async function sqlStore(): Promise<Store> {
  const store = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
  stores.push(store);
  return store;
}

interface SeedResult {
  readonly documentId: string;
  readonly versionId: string;
  readonly indexRevision: string;
  readonly chunkIds: readonly string[];
}

async function seedVersion(
  repository: DocumentRepository,
  scope: DocumentScope,
  input: {
    readonly documentId?: string;
    readonly versionId?: string;
    readonly baseVersionId?: string;
    readonly indexRevision?: string;
    readonly texts?: readonly string[];
  } = {},
): Promise<SeedResult> {
  const documentId = input.documentId ?? "doc_rules";
  const versionId = input.versionId ?? "ver_rules_1";
  const indexRevision = input.indexRevision ?? "index-r1";
  const texts = input.texts ?? ["采购申请必须填写需求日期", "金额超过十万元需要总经理审批"];
  const parsed = makeParsedDoc({ fileId: versionId, fileName: "采购规则.txt", kind: "text" });
  parsed.chunks.push(
    ...texts.map((render, order) =>
      makeChunk({
        docId: `line-${order + 1}`,
        fileId: versionId,
        fileName: "采购规则.txt",
        locator: { line: order + 1 },
        render,
        raw: { render },
        order,
        tags: ["rule"],
      }),
    ),
  );
  const chunks: StoredDocumentChunk[] = parsed.chunks.map((chunk, order) => ({
    documentId,
    versionId,
    chunkId: chunk.chunk_id,
    order,
    locator: chunk.locator as Readonly<Record<string, unknown>>,
    render: chunk.render,
    raw: chunk.raw,
    tags: chunk.tags,
    context: chunk.context ?? "",
    textSha256: sha256Hex(chunk.render),
  }));
  await repository.commitVersion({
    scope,
    documentId,
    ...(input.baseVersionId === undefined
      ? {
          newDocument: {
            id: documentId,
            title: "采购规则",
            logicalName: "采购规则",
            sourceClass: "imported" as const,
            tags: ["采购"],
            createdBy: scope.owner,
            createdAt: "2026-09-02T00:00:00.000Z",
          },
        }
      : { baseVersionId: input.baseVersionId }),
    version: {
      id: versionId,
      documentId,
      fileName: "采购规则.txt",
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(texts.join("\n")),
      sha256: sha256Hex(texts.join("\n")),
      relPath: `projects/p/documents/${documentId}/${versionId}/original/采购规则.txt`,
      docKind: "text",
      parsedDoc: parsed,
      parseStatus: "ready",
      parserName: "fixture",
      parserVersion: "1",
      indexRevision,
      chunkCount: chunks.length,
      createdBy: scope.owner,
      createdAt: input.baseVersionId === undefined
        ? "2026-09-02T00:00:00.000Z"
        : "2026-09-02T00:01:00.000Z",
    },
    chunks,
  });
  return { documentId, versionId, indexRevision, chunkIds: chunks.map((chunk) => chunk.chunkId) };
}

describe("OntoDocument 持久化任务", () => {
  it("按 exact version 入队，同幂等请求只保存一次，重建仓储后仍可读取", async () => {
    const store = await sqlStore();
    const documents = new SqlDocumentRepository(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const seeded = await seedVersion(documents, scope);
    const clock = new Clock(Date.parse("2026-09-02T01:00:00.000Z"));
    let id = 0;
    const queue = new DocumentJobQueue({
      repository: new SqlDocumentJobRepository(store),
      documents,
      now: clock.now,
      newId: () => `job_${++id}`,
    });

    const first = await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "ocr",
      idempotencyKey: "ocr:rules:v1",
      input: { language: "zh-CN", pages: [1, 2] },
    });
    const duplicate = await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "ocr",
      idempotencyKey: "ocr:rules:v1",
      input: { pages: [1, 2], language: "zh-CN" },
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.sourceSha256).toBe(sha256Hex("采购申请必须填写需求日期\n金额超过十万元需要总经理审批"));
    expect(duplicate.expectedIndexRevision).toBe(seeded.indexRevision);
    expect(id).toBe(2); // 第二个候选 ID 被生成，但唯一幂等行仍只有一条。

    await expect(
      queue.enqueue(scope, {
        documentId: seeded.documentId,
        versionId: seeded.versionId,
        kind: "ocr",
        idempotencyKey: "ocr:rules:v1",
        input: { language: "en" },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await new SqlDocumentJobRepository(store).get(scope, first.id)).toMatchObject({
      id: first.id,
      versionId: seeded.versionId,
      status: "queued",
    });
    expect(
      await new SqlDocumentJobRepository(store).get(
        { projectId: "project_B", owner: "alice" },
        first.id,
      ),
    ).toBeNull();
    await expect(
      queue.enqueue(scope, {
        documentId: seeded.documentId,
        versionId: "ver_missing",
        kind: "parse",
        idempotencyKey: "missing",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("租约可续期和过期重领；旧 worker 与耗尽重试的 worker 都不能错误回写", async () => {
    const store = await sqlStore();
    const documents = new SqlDocumentRepository(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const seeded = await seedVersion(documents, scope);
    const clock = new Clock(Date.parse("2026-09-02T02:00:00.000Z"));
    const repository = new SqlDocumentJobRepository(store);
    const queue = new DocumentJobQueue({ repository, documents, now: clock.now, newId: () => "job_lease" });
    await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:lease",
      maxAttempts: 2,
    });

    const firstNow = clock.now().toISOString();
    const first = await repository.claim({
      workerId: "worker-1",
      leaseToken: "lease-1",
      now: firstNow,
      leaseExpiresAt: new Date(clock.now().getTime() + 1_000).toISOString(),
    });
    expect(first).toMatchObject({ attempts: 1, status: "running", leaseOwner: "worker-1" });
    clock.advance(500);
    expect(
      await repository.heartbeat({
        jobId: first!.id,
        leaseToken: "lease-1",
        now: clock.now().toISOString(),
        leaseExpiresAt: new Date(clock.now().getTime() + 1_500).toISOString(),
      }),
    ).toMatchObject({ leaseOwner: "worker-1" });
    expect(
      await repository.claim({
        workerId: "worker-2",
        leaseToken: "lease-2-early",
        now: clock.now().toISOString(),
        leaseExpiresAt: new Date(clock.now().getTime() + 1_000).toISOString(),
      }),
    ).toBeNull();

    clock.advance(1_501);
    const second = await repository.claim({
      workerId: "worker-2",
      leaseToken: "lease-2",
      now: clock.now().toISOString(),
      leaseExpiresAt: new Date(clock.now().getTime() + 1_000).toISOString(),
    });
    expect(second).toMatchObject({ attempts: 2, status: "running", leaseOwner: "worker-2" });
    expect(
      await repository.succeed({
        jobId: first!.id,
        leaseToken: "lease-1",
        now: clock.now().toISOString(),
        result: { stale: true },
        resultSha256: sha256Hex("stale"),
      }),
    ).toBeNull();
    const exhausted = await repository.fail({
      jobId: second!.id,
      leaseToken: "lease-2",
      now: clock.now().toISOString(),
      failure: {
        error: "still broken",
        retryAt: new Date(clock.now().getTime() + 1_000).toISOString(),
      },
    });
    expect(exhausted).toMatchObject({ status: "failed", attempts: 2, lastError: "still broken" });
  });

  it("runner 使用可注入 worker，按确定性退避重试；没有 OCR 实现时明确失败", async () => {
    const store = await sqlStore();
    const documents = new SqlDocumentRepository(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const seeded = await seedVersion(documents, scope);
    const clock = new Clock(Date.parse("2026-09-02T03:00:00.000Z"));
    const repository = new SqlDocumentJobRepository(store);
    let id = 0;
    const queue = new DocumentJobQueue({
      repository,
      documents,
      now: clock.now,
      newId: () => `job_runner_${++id}`,
    });
    await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "parse",
      idempotencyKey: "parse:runner",
      maxAttempts: 2,
    });
    let calls = 0;
    const runner = new DocumentJobRunner({
      queue,
      now: clock.now,
      leaseMs: 5_000,
      newLeaseToken: () => `token_${calls}`,
      retryDelayMs: () => 1_000,
      workers: {
        parse: {
          async run(context) {
            calls += 1;
            expect(context.version.id).toBe(seeded.versionId);
            expect(await context.heartbeat()).toBe(true);
            if (calls === 1) throw new DocumentJobWorkerError("temporary parser outage", true);
            return { output: { chunks: context.version.chunkCount, engine: "fixture" } };
          },
        },
      },
    });
    expect(await runner.runOne("worker-A")).toMatchObject({ state: "retrying" });
    clock.advance(999);
    expect(await runner.runOne("worker-A")).toEqual({ state: "idle" });
    clock.advance(1);
    const done = await runner.runOne("worker-A");
    expect(done).toMatchObject({
      state: "succeeded",
      job: { attempts: 2, status: "succeeded", result: { chunks: 2, engine: "fixture" } },
    });
    if (done.state === "succeeded") expect(done.job.resultSha256).toMatch(/^[a-f0-9]{64}$/u);

    await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "ocr",
      idempotencyKey: "ocr:no-worker",
      maxAttempts: 3,
    });
    const noOcr = await runner.runOne("worker-A");
    expect(noOcr).toMatchObject({
      state: "failed",
      job: { status: "failed", attempts: 1 },
    });
    if (noOcr.state === "failed") expect(noOcr.job.lastError).toContain("没有配置 OCR worker");

    await queue.enqueue(scope, {
      documentId: seeded.documentId,
      versionId: seeded.versionId,
      kind: "ocr",
      idempotencyKey: "ocr:fixture-worker",
    });
    const injectedOcr = new DocumentJobRunner({
      queue,
      now: clock.now,
      leaseMs: 5_000,
      newLeaseToken: () => "ocr-token",
      workers: {
        ocr: {
          async run(context) {
            expect(await context.heartbeat()).toBe(true);
            return {
              output: {
                engine: "deterministic-test-ocr",
                exactVersion: context.version.id,
                sourceSha256: context.job.sourceSha256,
              },
            };
          },
        },
      },
    });
    expect(await injectedOcr.runOne("worker-OCR")).toMatchObject({
      state: "succeeded",
      job: {
        kind: "ocr",
        result: { engine: "deterministic-test-ocr", exactVersion: seeded.versionId },
      },
    });
  });
});

describe("OntoDocument 搜索快照", () => {
  it("固定 version/index/ACL，游标跨仓储实例稳定；新版本不会静默替换旧快照", async () => {
    const store = await sqlStore();
    const documents = new SqlDocumentRepository(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const seeded = await seedVersion(documents, scope, {
      texts: ["规则一", "规则二", "规则三"],
    });
    await store.engine!.connect((conn) =>
      conn.exec(
        "INSERT INTO onto_document_acl_state (project_id,owner,revision,updated_by,updated_at) " +
          "VALUES (?,?,?,?,?)",
        [scope.projectId, scope.owner, 7, scope.owner, "2026-09-02T04:00:00.000Z"],
      ),
    );
    const clock = new Clock(Date.parse("2026-09-02T04:00:00.000Z"));
    const repository = new SqlDocumentSearchSnapshotRepository(store);
    const service = new DocumentSearchSnapshotService({
      repository,
      documents,
      now: clock.now,
      newId: () => "snapshot_fixed",
    });
    const snapshot = await service.create(scope, {
      query: "采购审批规则",
      pins: [
        {
          documentId: seeded.documentId,
          versionId: seeded.versionId,
          indexRevision: seeded.indexRevision,
        },
      ],
      items: seeded.chunkIds.map((chunkId, score) => ({
        documentId: seeded.documentId,
        versionId: seeded.versionId,
        chunkId,
        score: 10 - score,
      })),
      ttlMs: 60_000,
    });
    expect(snapshot).toMatchObject({ aclRevision: 7, totalItems: 3, status: "active" });
    expect(snapshot.querySha256).not.toContain("采购");

    const first = await service.page(scope, { snapshotId: snapshot.id, limit: 2 });
    expect(first.items.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(first.nextCursor).not.toBeNull();

    // 创建一个新 current version；快照继续固定旧版本，不会跟着 latest 漂移。
    await seedVersion(documents, scope, {
      documentId: seeded.documentId,
      versionId: "ver_rules_2",
      baseVersionId: seeded.versionId,
      indexRevision: "index-r2",
      texts: ["全新的规则"],
    });
    const restarted = new DocumentSearchSnapshotService({
      repository: new SqlDocumentSearchSnapshotRepository(store),
      documents: new SqlDocumentRepository(store),
      now: clock.now,
    });
    const second = await restarted.page(scope, {
      snapshotId: snapshot.id,
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.items.map((item) => [item.versionId, item.ordinal])).toEqual([
      [seeded.versionId, 2],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("ACL revision、index revision 与 TTL 任一变化都会持久化失效并拒绝旧 cursor", async () => {
    const store = await sqlStore();
    const documents = new SqlDocumentRepository(store);
    const scope = { projectId: "project_A", owner: "alice" };
    const seeded = await seedVersion(documents, scope);
    await store.engine!.connect((conn) =>
      conn.exec(
        "INSERT INTO onto_document_acl_state (project_id,owner,revision,updated_by,updated_at) " +
          "VALUES (?,?,?,?,?)",
        [scope.projectId, scope.owner, 1, scope.owner, "2026-09-02T05:00:00.000Z"],
      ),
    );
    const clock = new Clock(Date.parse("2026-09-02T05:00:00.000Z"));
    let id = 0;
    const repository = new SqlDocumentSearchSnapshotRepository(store);
    const service = new DocumentSearchSnapshotService({
      repository,
      documents,
      now: clock.now,
      newId: () => `snapshot_guard_${++id}`,
    });
    const create = (ttlMs = 60_000) =>
      service.create(scope, {
        query: "审批",
        pins: [
          {
            documentId: seeded.documentId,
            versionId: seeded.versionId,
            indexRevision: seeded.indexRevision,
          },
        ],
        items: seeded.chunkIds.map((chunkId, score) => ({
          documentId: seeded.documentId,
          versionId: seeded.versionId,
          chunkId,
          score,
        })),
        ttlMs,
      });

    const aclSnapshot = await create();
    const page = await service.page(scope, { snapshotId: aclSnapshot.id, limit: 1 });
    await store.engine!.connect((conn) =>
      conn.exec(
        "UPDATE onto_document_acl_state SET revision=revision+1,updated_at=? " +
          "WHERE project_id=? AND owner=?",
        [clock.now().toISOString(), scope.projectId, scope.owner],
      ),
    );
    await expect(
      service.page(scope, { snapshotId: aclSnapshot.id, cursor: page.nextCursor!, limit: 1 }),
    ).rejects.toMatchObject({ code: "ACL_CHANGED" });
    expect(await repository.get(scope, aclSnapshot.id)).toMatchObject({
      status: "invalidated",
      invalidatedReason: "acl_revision_changed",
    });

    // 新快照固定新 ACL revision；人为模拟索引损坏/重建，必须 fail closed。
    const indexSnapshot = await create();
    await store.engine!.connect((conn) =>
      conn.exec("UPDATE onto_document_version SET index_revision=? WHERE id=?", [
        "index-rebuilt",
        seeded.versionId,
      ]),
    );
    await expect(service.page(scope, { snapshotId: indexSnapshot.id })).rejects.toMatchObject({
      code: "INDEX_CHANGED",
    });
    expect(await repository.get(scope, indexSnapshot.id)).toMatchObject({ status: "invalidated" });

    // 恢复 fixture 索引后单独验证 TTL；到达 expires_at 的边界即过期。
    await store.engine!.connect((conn) =>
      conn.exec("UPDATE onto_document_version SET index_revision=? WHERE id=?", [
        seeded.indexRevision,
        seeded.versionId,
      ]),
    );
    const expiring = await create(1_000);
    clock.advance(1_000);
    await expect(service.page(scope, { snapshotId: expiring.id })).rejects.toMatchObject({
      code: "EXPIRED",
    });
    expect(await repository.get(scope, expiring.id)).toMatchObject({
      status: "invalidated",
      invalidatedReason: "expired",
    });
  });
});
