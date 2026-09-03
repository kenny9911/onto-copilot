import { decodeConnectorCursor, encodeConnectorCursor } from "./cursor.js";
import {
  ConnectorError,
  assertBinding,
  cleanSourceText,
  safeLimit,
  verifiedRead,
  type ConnectorAclEntry,
  type ConnectorBinding,
  type ConnectorChangePage,
  type ConnectorReadResult,
  type ConnectorSourceItem,
  type DocumentSourceConnector,
} from "./types.js";

export interface WebDavChange {
  readonly href: string;
  readonly resourceId: string;
  readonly name: string;
  readonly etag: string;
  readonly contentType: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly deleted?: boolean;
  readonly collection?: boolean;
}

export interface WebDavClient {
  sync(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly rootPath: string;
    readonly syncToken?: string;
    readonly pageToken?: string;
    readonly limit: number;
  }): Promise<{ readonly changes: readonly WebDavChange[]; readonly syncToken?: string; readonly nextToken?: string }>;
  read(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly href: string;
    readonly etag: string;
  }): Promise<Uint8Array>;
  acl(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly href: string;
  }): Promise<readonly ConnectorAclEntry[]>;
}

function conf(binding: ConnectorBinding): { endpointAlias: string; rootPath: string } {
  const endpointAlias = cleanSourceText(binding.source["endpointAlias"] ?? "", "WebDAV 端点别名", 256);
  const rootPath = cleanSourceText(binding.source["rootPath"] ?? "/", "WebDAV 根目录", 2_048);
  if (!rootPath.startsWith("/") || rootPath.includes("..")) {
    throw new ConnectorError("INVALID_BINDING", "WebDAV 根目录必须是规范化绝对路径");
  }
  return { endpointAlias, rootPath: rootPath.replace(/\/$/u, "") || "/" };
}

function safeHref(rootPath: string, href: string): string {
  const value = cleanSourceText(href, "WebDAV href", 4_096);
  if (!value.startsWith(rootPath === "/" ? "/" : `${rootPath}/`) && value !== rootPath) {
    throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "WebDAV 文件不在已配置目录中");
  }
  if (value.split("/").some((part) => part === "..")) {
    throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "WebDAV 路径无效");
  }
  return value;
}

function toItem(rootPath: string, value: WebDavChange): ConnectorSourceItem {
  const href = safeHref(rootPath, value.href);
  return {
    // WebDAV resource-id 并非所有服务端都稳定提供；规范化 href 是读取时可复用的身份，
    // resource-id 仍保留在 metadata 中用于服务端支持时做改名跟踪。
    externalId: href,
    sourceVersion: cleanSourceText(value.etag, "WebDAV eTag", 1_024),
    name: cleanSourceText(value.name, "WebDAV 文件名", 512),
    path: href,
    mediaType: value.contentType || "application/octet-stream",
    sizeBytes: Math.max(0, Number(value.size) || 0),
    modifiedAt: value.modifiedAt,
    etag: value.etag,
    metadata: { provider: "webdav", href, resourceId: value.resourceId },
  };
}

export class WebDavConnector implements DocumentSourceConnector {
  readonly kind = "webdav" as const;

  constructor(private readonly client: WebDavClient) {}

  async scan(binding: ConnectorBinding, cursor: string | undefined, limit: number): Promise<ConnectorChangePage> {
    assertBinding(binding, this.kind);
    const cfg = conf(binding);
    const state = decodeConnectorCursor(cursor, this.kind, binding.id, binding.configRevision);
    const page = await this.client.sync({
      credentialRef: binding.credentialRef,
      ...cfg,
      ...(state["sync"] === undefined ? {} : { syncToken: state["sync"] }),
      ...(state["page"] === undefined ? {} : { pageToken: state["page"] }),
      limit: safeLimit(limit),
    }).catch(() => {
      throw new ConnectorError("SOURCE_UNAVAILABLE", "WebDAV 同步失败", true);
    });
    const changes = page.changes.filter((row) => row.collection !== true).map((row) => ({
      kind: row.deleted === true ? "delete" as const : "upsert" as const,
      item: toItem(cfg.rootPath, row),
    }));
    const stateOut: Record<string, string> = {};
    if (page.nextToken !== undefined) {
      if (state["sync"] !== undefined) stateOut["sync"] = state["sync"];
      stateOut["page"] = page.nextToken;
    } else if (page.syncToken !== undefined) {
      stateOut["sync"] = page.syncToken;
    }
    return {
      changes,
      nextCursor: Object.keys(stateOut).length === 0 ? null
        : encodeConnectorCursor(this.kind, binding.id, binding.configRevision, stateOut),
      hasMore: page.nextToken !== undefined,
    };
  }

  async read(binding: ConnectorBinding, externalId: string, sourceVersion: string): Promise<ConnectorReadResult> {
    assertBinding(binding, this.kind);
    const cfg = conf(binding);
    const href = safeHref(cfg.rootPath, cleanSourceText(externalId, "WebDAV href", 4_096));
    const item: ConnectorSourceItem = {
      externalId: href,
      sourceVersion,
      name: href.split("/").at(-1) ?? "document",
      path: href,
      mediaType: "application/octet-stream",
      sizeBytes: 0,
      modifiedAt: "",
      etag: sourceVersion,
      metadata: { provider: "webdav", href },
    };
    const bytes = await this.client.read({
      credentialRef: binding.credentialRef,
      endpointAlias: cfg.endpointAlias,
      href,
      etag: cleanSourceText(sourceVersion, "WebDAV eTag", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 WebDAV 文件");
    });
    return verifiedRead(item, bytes);
  }

  async readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]> {
    assertBinding(binding, this.kind);
    const cfg = conf(binding);
    return this.client.acl({
      credentialRef: binding.credentialRef,
      endpointAlias: cfg.endpointAlias,
      href: safeHref(cfg.rootPath, externalId),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 WebDAV 权限");
    });
  }
}
