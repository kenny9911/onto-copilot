import { describe, expect, it, vi } from "vitest";

import {
  ConfluenceConnector,
  ConnectorError,
  ConnectorRegistry,
  ConnectorSyncService,
  DataCatalogConnector,
  MemoryConnectorBindingRepository,
  S3Connector,
  SharePointConnector,
  WebDavConnector,
  type ConnectorBinding,
} from "../src/document/connectors/index.js";

const binding = (
  kind: ConnectorBinding["kind"],
  source: Readonly<Record<string, string>>,
): ConnectorBinding => ({
  id: `conn_${kind}`,
  projectId: "project_A",
  kind,
  displayName: kind,
  credentialRef: `secret://${kind}/project_A`,
  source,
  configRevision: 3,
  enabled: true,
});

describe("OntoDocument connectors", () => {
  it("SharePoint delta cursor 固定 binding/revision，读取固定版本并同步 ACL", async () => {
    const client = {
      delta: vi.fn(async () => ({
        items: [{
          id: "item_1", name: "采购规则.docx", parentPath: "/drive/root:/采购", size: 12,
          lastModifiedAt: "2026-09-02T00:00:00Z", eTag: "etag-1", cTag: "v1",
          mimeType: "application/docx",
        }],
        nextToken: "page-2",
      })),
      read: vi.fn(async () => ({
        item: {
          id: "item_1", name: "采购规则.docx", parentPath: "/drive/root:/采购", size: 3,
          lastModifiedAt: "2026-09-02T00:00:00Z", eTag: "etag-1", cTag: "v1",
          mimeType: "application/docx",
        },
        bytes: new Uint8Array([1, 2, 3]),
      })),
      permissions: vi.fn(async () => [{
        subjectKind: "group" as const, subjectId: "采购项目组", roles: ["read"],
      }]),
    };
    const connector = new SharePointConnector(client);
    const cfg = binding("sharepoint", { driveId: "drive_1", rootItemId: "root_1" });
    const first = await connector.scan(cfg, undefined, 50);
    expect(first).toMatchObject({ hasMore: true, changes: [{ kind: "upsert" }] });
    expect(first.changes[0]?.item).toMatchObject({ externalId: "item_1", sourceVersion: "v1" });
    expect(first.nextCursor).not.toContain("page-2");
    await connector.scan(cfg, first.nextCursor ?? undefined, 50);
    expect(client.delta).toHaveBeenLastCalledWith(expect.objectContaining({ pageToken: "page-2" }));
    await expect(connector.scan({ ...cfg, configRevision: 4 }, first.nextCursor ?? undefined, 50))
      .rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(await connector.read(cfg, "item_1", "v1")).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(await connector.readAcl(cfg, "item_1")).toEqual([{
      subjectKind: "group", subjectId: "采购项目组", effect: "allow", permissions: ["read"],
    }]);
  });

  it("SharePoint 上游已换版时拒绝把新正文冒充旧版", async () => {
    const connector = new SharePointConnector({
      delta: vi.fn(),
      read: vi.fn(async () => ({
        item: {
          id: "i", name: "x.txt", parentPath: "/", size: 1,
          lastModifiedAt: "now", eTag: "e2", cTag: "v2", mimeType: "text/plain",
        },
        bytes: new Uint8Array([1]),
      })),
      permissions: vi.fn(),
    });
    await expect(connector.read(binding("sharepoint", { driveId: "d" }), "i", "v1"))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("WebDAV 只允许配置根目录内 href，并使用 sync-token", async () => {
    const client = {
      sync: vi.fn(async () => ({
        changes: [{
          href: "/projects/a/rule.txt", resourceId: "rid-1", name: "rule.txt", etag: "e1",
          contentType: "text/plain", size: 4, modifiedAt: "now",
        }],
        syncToken: "sync-1",
      })),
      read: vi.fn(async () => Buffer.from("rule")),
      acl: vi.fn(async () => []),
    };
    const connector = new WebDavConnector(client);
    const cfg = binding("webdav", { endpointAlias: "customer-dav", rootPath: "/projects/a" });
    const page = await connector.scan(cfg, undefined, 20);
    expect(page.changes[0]?.item).toMatchObject({ externalId: "/projects/a/rule.txt" });
    expect(await connector.read(cfg, "/projects/a/rule.txt", "e1")).toMatchObject({ sha256: expect.any(String) });
    await expect(connector.read(cfg, "/projects/b/secret.txt", "e1"))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("S3 枚举不可变 versionId；读取和删除标记不会退化到 latest", async () => {
    const client = {
      listVersions: vi.fn(async () => ({
        versions: [
          { key: "project/a.docx", versionId: "v2", etag: "e2", size: 2, lastModified: "now", isLatest: true },
          { key: "project/old.docx", versionId: "del-1", etag: "d", size: 0, lastModified: "now", isLatest: true, deleteMarker: true },
        ],
      })),
      getObject: vi.fn(async () => ({
        version: { key: "project/a.docx", versionId: "v2", etag: "e2", size: 2, lastModified: "now", isLatest: true },
        bytes: new Uint8Array([4, 2]),
      })),
      getAcl: vi.fn(async () => []),
    };
    const connector = new S3Connector(client);
    const cfg = binding("s3", { bucket: "customer-bucket", prefix: "project" });
    expect((await connector.scan(cfg, undefined, 100)).changes.map((v) => v.kind)).toEqual(["upsert", "delete"]);
    await connector.read(cfg, "project/a.docx", "v2");
    expect(client.getObject).toHaveBeenCalledWith(expect.objectContaining({ versionId: "v2" }));
    await expect(connector.read(cfg, "another/secret", "v1"))
      .rejects.toMatchObject({ code: "NOT_FOUND_OR_FORBIDDEN" });
  });

  it("Confluence 与数据目录生成可追溯的确定版本虚拟文档", async () => {
    const confluence = new ConfluenceConnector({
      changes: vi.fn(async () => ({ pages: [{
        contentId: "42", title: "采购流程", spaceKey: "ERP", version: 3, modifiedAt: "now",
      }] })),
      exportPage: vi.fn(async () => ({
        page: { contentId: "42", title: "采购流程", spaceKey: "ERP", version: 3, modifiedAt: "now" },
        storageHtml: "<h1>采购流程</h1>",
      })),
      permissions: vi.fn(async () => []),
    });
    const cBinding = binding("confluence", { siteAlias: "customer-wiki", spaceKey: "ERP" });
    expect((await confluence.scan(cBinding, undefined, 20)).changes[0]?.item.sourceVersion).toBe("3");
    expect(new TextDecoder().decode((await confluence.read(cBinding, "42", "3")).bytes)).toContain("采购流程");

    const entity = {
      urn: "urn:li:dataset:purchase", version: "9", name: "采购订单", entityType: "dataset",
      modifiedAt: "now", description: "采购订单主表", fields: [{ name: "amount", type: "decimal" }],
    };
    const catalog = new DataCatalogConnector("datahub", {
      changes: vi.fn(async () => ({ entities: [entity] })),
      entity: vi.fn(async () => entity),
      acl: vi.fn(async () => []),
    });
    const dBinding = binding("datahub", { endpointAlias: "customer-datahub", domain: "采购" });
    const hit = (await catalog.scan(dBinding, undefined, 20)).changes[0]?.item;
    expect(hit).toMatchObject({ sourceVersion: "9", mediaType: "text/markdown" });
    const body = new TextDecoder().decode((await catalog.read(dBinding, entity.urn, "9")).bytes);
    expect(body).toContain("| amount | decimal |");
  });

  it("registry 拒绝重复注册，cursor 和错误不泄露 credentialRef", async () => {
    const connector = new DataCatalogConnector("openmetadata", {
      changes: vi.fn(async () => { throw new Error("upstream failed"); }),
      entity: vi.fn(), acl: vi.fn(),
    });
    const registry = new ConnectorRegistry().register(connector);
    expect(registry.kinds()).toEqual(["openmetadata"]);
    expect(() => registry.register(connector)).toThrow(ConnectorError);
    const secret = "secret://must-not-leak";
    await expect(connector.scan({
      ...binding("openmetadata", { endpointAlias: "metadata" }), credentialRef: secret,
    }, undefined, 10)).rejects.not.toThrow(secret);
  });

  it("同步服务逐页提交 cursor；半页失败不越过失败变更", async () => {
    const cfg = binding("openmetadata", { endpointAlias: "metadata" });
    const repo = new MemoryConnectorBindingRepository();
    await repo.save(cfg);
    const scan = vi.fn()
      .mockResolvedValueOnce({
        changes: [{
          kind: "upsert",
          item: {
            externalId: "urn:1", sourceVersion: "v1", name: "a.md", path: "a.md",
            mediaType: "text/markdown", sizeBytes: 1, modifiedAt: "now", etag: "e1", metadata: {},
          },
          acl: [],
        }],
        nextCursor: "cursor-2",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        changes: [{
          kind: "upsert",
          item: {
            externalId: "urn:2", sourceVersion: "v1", name: "b.md", path: "b.md",
            mediaType: "text/markdown", sizeBytes: 1, modifiedAt: "now", etag: "e2", metadata: {},
          },
          acl: [],
        }],
        nextCursor: null,
        hasMore: false,
      });
    const connector = {
      kind: "openmetadata" as const,
      scan,
      read: vi.fn(async (_binding: unknown, externalId: string) => ({
        item: {
          externalId, sourceVersion: "v1", name: `${externalId}.md`, path: `${externalId}.md`,
          mediaType: "text/markdown", sizeBytes: 1, modifiedAt: "now", etag: externalId, metadata: {},
        },
        bytes: new Uint8Array([1]),
        sha256: "a".repeat(64),
      })),
      readAcl: vi.fn(async () => []),
    };
    const sink = {
      upsert: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("db unavailable")),
      remove: vi.fn(),
      updateAcl: vi.fn(),
    };
    const service = new ConnectorSyncService(
      repo,
      new ConnectorRegistry().register(connector),
      sink,
      () => "2026-09-02T00:00:00.000Z",
    );
    await expect(service.sync(cfg.id)).rejects.toThrow("db unavailable");
    expect(scan.mock.calls[0]?.[1]).toBeUndefined();
    expect(scan.mock.calls[1]?.[1]).toBe("cursor-2");
    expect((await repo.state(cfg.id)).cursor).toBe("cursor-2");
    expect((await repo.state(cfg.id)).lastError).toContain("SOURCE_UNAVAILABLE");
    expect(sink.upsert.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[a-f0-9]{64}$/u);
  });
});
