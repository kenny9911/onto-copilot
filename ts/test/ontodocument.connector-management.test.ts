import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorManagementError,
  ConnectorManagementService,
  ConnectorRegistry,
  ConnectorSyncService,
  MemoryConnectorSourceRepository,
  SqlConnectorSourceRepository,
  type ConnectorSourceRepository,
  type DocumentSourceConnector,
} from "../src/document/connectors/index.js";
import { Store } from "../src/store/engine.js";

const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

const alice = {
  scope: { projectId: "project_A", owner: "alice" },
  actorId: "alice",
} as const;

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 2, 8, 0, tick++)).toISOString();
}

function inertSync(repo: ConnectorSourceRepository, now = clock()): ConnectorSyncService {
  return new ConnectorSyncService(repo, new ConnectorRegistry(), {
    async upsert() {},
    async remove() {},
    async updateAcl() {},
  }, now);
}

async function repository(kind: "memory" | "sqlite"): Promise<ConnectorSourceRepository> {
  if (kind === "memory") return new MemoryConnectorSourceRepository();
  const store = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
  stores.push(store);
  return new SqlConnectorSourceRepository(store);
}

for (const backend of ["memory", "sqlite"] as const) {
  describe(`OntoDocument connector management · ${backend}`, () => {
    it("项目/owner 隔离，创建与更新可幂等重试，CAS 不覆盖并发修改", async () => {
      const repo = await repository(backend);
      const now = clock();
      const service = new ConnectorManagementService(repo, inertSync(repo, now), now);
      const input = {
        requestId: "browser-action-1",
        provider: "s3" as const,
        name: "采购制度库",
        rootOrPrefix: "customer-bucket/purchase",
        credentialRef: "credential://project-a/s3-reader",
        tags: ["制度", "采购", "制度"],
        classification: "confidential" as const,
      };
      const created = await service.create(alice, input);
      const retried = await service.create(alice, input);
      expect(retried).toEqual(created);
      expect(created).toMatchObject({
        revision: 1,
        enabled: true,
        tags: ["采购", "制度"],
        scope: alice.scope,
      });
      expect(await service.list({ ...alice, scope: { ...alice.scope, owner: "bob" } })).toEqual([]);
      expect(await service.list({ ...alice, scope: { projectId: "project_B", owner: "alice" } })).toEqual([]);

      const updated = await service.update(alice, created.id, {
        expectedRevision: 1,
        name: "采购制度与流程",
      });
      expect(updated).toMatchObject({ revision: 2, name: "采购制度与流程", cursor: null });
      await expect(service.update(alice, created.id, {
        expectedRevision: 1,
        classification: "restricted",
      })).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
        status: 409,
        actualRevision: 2,
      });
      const idempotentRetry = await service.update(alice, created.id, {
        expectedRevision: 1,
        name: "采购制度与流程",
      });
      expect(idempotentRetry.revision).toBe(2);

      await expect(service.create(alice, {
        ...input,
        requestId: "another-action",
        name: "重复目录",
      })).rejects.toMatchObject({ code: "DUPLICATE", status: 409 });
    });

    it("启停、归档和恢复都需要 revision；恢复后不会意外自动同步", async () => {
      const repo = await repository(backend);
      const now = clock();
      const service = new ConnectorManagementService(repo, inertSync(repo, now), now);
      const created = await service.create(alice, {
        requestId: "lifecycle",
        provider: "confluence",
        name: "业务 Wiki",
        rootOrPrefix: "PROCUREMENT",
        credentialRef: "vault://project-a/confluence",
      });
      const disabled = await service.lifecycle(alice, created.id, "disable", 1);
      expect(disabled).toMatchObject({ enabled: false, revision: 2, status: "idle" });
      const enabled = await service.lifecycle(alice, created.id, "enable", 2);
      expect(enabled).toMatchObject({ enabled: true, revision: 3 });
      const archived = await service.lifecycle(alice, created.id, "archive", 3);
      expect(archived).toMatchObject({ enabled: false, revision: 4, status: "archived" });
      expect(await service.list(alice)).toEqual([]);
      expect(await service.list(alice, true)).toHaveLength(1);
      await expect(service.lifecycle(alice, created.id, "enable", 4))
        .rejects.toMatchObject({ code: "INVALID_STATE" });
      const restored = await service.lifecycle(alice, created.id, "restore", 4);
      expect(restored).toMatchObject({ enabled: false, revision: 5, status: "idle" });
    });
  });
}

describe("OntoDocument connector safety and sync", () => {
  it("运行时未装配时明确说配置已保存但不能同步，不伪装成同步成功", async () => {
    const repo = new MemoryConnectorSourceRepository();
    const now = clock();
    const service = new ConnectorManagementService(repo, inertSync(repo, now), now, false);
    const source = await service.create(alice, {
      requestId: "runtime-missing",
      provider: "s3",
      name: "待接入来源",
      rootOrPrefix: "safe-bucket/purchase",
      credentialRef: "credential://project-a/s3",
    });
    await expect(service.syncNow(alice, source.id, { expectedRevision: 1 })).rejects.toMatchObject({
      code: "INVALID_STATE",
      status: 503,
      message: expect.stringContaining("运行时未配置"),
    });
    expect(await service.get(alice, source.id)).toMatchObject({ status: "idle", cursor: null });
  });

  it("拒绝秘密、URL、遍历和本机路径，只接受批准凭据引用", async () => {
    const repo = new MemoryConnectorSourceRepository();
    const service = new ConnectorManagementService(repo, inertSync(repo));
    const base = {
      requestId: "unsafe",
      provider: "s3" as const,
      name: "不安全来源",
      rootOrPrefix: "bucket-safe/prefix",
      credentialRef: "credential://project-a/reader",
    };
    await expect(service.create(alice, { ...base, credentialRef: "https://host?token=secret" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.create(alice, { ...base, rootOrPrefix: "file:///etc/passwd" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.create(alice, { ...base, rootOrPrefix: "bucket-safe/%2e%2e/secret" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.create(alice, {
      ...base,
      provider: "webdav",
      rootOrPrefix: "/Users/alice/customer",
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(JSON.stringify(await service.list(alice))).not.toContain("token");
  });

  it("按精确 sourceVersion 写入、保留上游 ACL；成功页才推进 cursor", async () => {
    const repo = new MemoryConnectorSourceRepository();
    const scan = vi.fn(async () => ({
      changes: [{
        kind: "upsert" as const,
        item: {
          externalId: "urn:purchase",
          sourceVersion: "version-7",
          name: "采购订单.md",
          path: "purchase/order",
          mediaType: "text/markdown",
          sizeBytes: 4,
          modifiedAt: "2026-09-02T00:00:00Z",
          etag: "etag-7",
          metadata: { provider: "openmetadata" },
        },
        acl: [{
          subjectKind: "group" as const,
          subjectId: "procurement",
          effect: "allow" as const,
          permissions: ["read" as const],
        }],
      }],
      nextCursor: "opaque-page-2",
      hasMore: false,
    }));
    const connector: DocumentSourceConnector = {
      kind: "openmetadata",
      scan,
      async read(_binding, externalId, sourceVersion) {
        return {
          item: {
            externalId,
            sourceVersion,
            name: "采购订单.md",
            path: "purchase/order",
            mediaType: "text/markdown",
            sizeBytes: 4,
            modifiedAt: "2026-09-02T00:00:00Z",
            etag: "etag-7",
            metadata: { provider: "openmetadata" },
          },
          bytes: new Uint8Array([1, 2, 3, 4]),
          sha256: "a".repeat(64),
        };
      },
      async readAcl() {
        throw new Error("inline ACL 应该优先使用");
      },
    };
    const sink = {
      upsert: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      updateAcl: vi.fn(async () => {}),
    };
    const now = clock();
    const sync = new ConnectorSyncService(
      repo,
      new ConnectorRegistry().register(connector),
      sink,
      now,
    );
    const service = new ConnectorManagementService(repo, sync, now);
    const source = await service.create(alice, {
      requestId: "sync-one",
      provider: "openmetadata",
      name: "数据目录",
      rootOrPrefix: "采购域",
      credentialRef: "secret://project-a/openmetadata",
      tags: ["主数据"],
      classification: "restricted",
    });
    const report = await service.syncNow(alice, source.id, { expectedRevision: 1 });
    expect(report).toMatchObject({ pages: 1, upserted: 1, complete: true });
    expect(sink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          tags: ["主数据"],
          classification: "restricted",
          configRevision: 1,
        }),
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({ item: expect.objectContaining({ sourceVersion: "version-7" }) }),
      [expect.objectContaining({ subjectId: "procurement", permissions: ["read"] })],
    );
    const status = await service.get(alice, source.id);
    expect(status).toMatchObject({ cursor: "opaque-page-2", status: "idle", lastError: null });
  });

  it("同步错误不把凭据或上游异常写库/回传，失败页的 cursor 不前进", async () => {
    const repo = new MemoryConnectorSourceRepository();
    const connector: DocumentSourceConnector = {
      kind: "datahub",
      async scan() {
        throw new Error("token=super-secret password=hunter2");
      },
      async read() {
        throw new Error("not reached");
      },
      async readAcl() {
        return [];
      },
    };
    const now = clock();
    const sync = new ConnectorSyncService(
      repo,
      new ConnectorRegistry().register(connector),
      { async upsert() {}, async remove() {}, async updateAcl() {} },
      now,
    );
    const service = new ConnectorManagementService(repo, sync, now);
    const source = await service.create(alice, {
      requestId: "sync-error",
      provider: "datahub",
      name: "数据目录",
      rootOrPrefix: "采购域",
      credentialRef: "secret://project-a/datahub",
    });
    let error: unknown;
    try {
      await service.syncNow(alice, source.id, { expectedRevision: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConnectorManagementError);
    expect(String(error)).not.toContain("super-secret");
    expect(String(error)).not.toContain("hunter2");
    const status = await service.get(alice, source.id);
    expect(status.cursor).toBeNull();
    expect(status.status).toBe("error");
    expect(status.lastError).toBe("SOURCE_UNAVAILABLE: 外部来源同步失败");
    expect(JSON.stringify(status)).not.toContain("super-secret");
    expect(JSON.stringify(status)).not.toContain("hunter2");
  });

  it("多页同步只保留最后一页完整成功后的 cursor，失败页可安全重放", async () => {
    const repo = new MemoryConnectorSourceRepository();
    let sourceId = "";
    const item = (id: string) => ({
      externalId: id,
      sourceVersion: "v1",
      name: `${id}.md`,
      path: `${id}.md`,
      mediaType: "text/markdown",
      sizeBytes: 1,
      modifiedAt: "2026-09-02T00:00:00Z",
      etag: `etag-${id}`,
      metadata: { provider: "openmetadata" },
    });
    const scan = vi.fn()
      .mockResolvedValueOnce({
        changes: [{ kind: "upsert", item: item("first"), acl: [] }],
        nextCursor: "after-first-page",
        hasMore: true,
      })
      .mockImplementationOnce(async () => {
        expect((await repo.getSource(alice.scope, sourceId))?.status).toBe("syncing");
        return {
          changes: [{ kind: "upsert" as const, item: item("second"), acl: [] }],
          nextCursor: "after-failed-page",
          hasMore: true,
        };
      });
    const connector: DocumentSourceConnector = {
      kind: "openmetadata",
      scan,
      async read(_binding, externalId) {
        return { item: item(externalId), bytes: new Uint8Array([1]), sha256: "a".repeat(64) };
      },
      async readAcl() { return []; },
    };
    const sink = {
      upsert: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("write failed")),
      remove: vi.fn(),
      updateAcl: vi.fn(),
    };
    const now = clock();
    const service = new ConnectorManagementService(
      repo,
      new ConnectorSyncService(repo, new ConnectorRegistry().register(connector), sink, now),
      now,
    );
    const source = await service.create(alice, {
      requestId: "page-cursor",
      provider: "openmetadata",
      name: "分页目录",
      rootOrPrefix: "采购域",
      credentialRef: "credential://project-a/openmetadata",
    });
    sourceId = source.id;
    await expect(service.syncNow(alice, source.id, { expectedRevision: 1 }))
      .rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(scan.mock.calls[0]?.[1]).toBeUndefined();
    expect(scan.mock.calls[1]?.[1]).toBe("after-first-page");
    expect(await service.get(alice, source.id)).toMatchObject({
      cursor: "after-first-page",
      status: "error",
    });
    expect(JSON.stringify(await service.get(alice, source.id))).not.toContain("after-failed-page");
  });
});
