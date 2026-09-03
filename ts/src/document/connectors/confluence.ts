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

export interface ConfluencePageChange {
  readonly contentId: string;
  readonly title: string;
  readonly spaceKey: string;
  readonly version: number;
  readonly modifiedAt: string;
  readonly webUrl?: string;
  readonly deleted?: boolean;
}

export interface ConfluenceClient {
  changes(input: {
    readonly credentialRef: string;
    readonly siteAlias: string;
    readonly spaceKey: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{ readonly pages: readonly ConfluencePageChange[]; readonly nextCursor?: string }>;
  exportPage(input: {
    readonly credentialRef: string;
    readonly siteAlias: string;
    readonly contentId: string;
    readonly version: number;
  }): Promise<{ readonly page: ConfluencePageChange; readonly storageHtml: string }>;
  permissions(input: {
    readonly credentialRef: string;
    readonly siteAlias: string;
    readonly contentId: string;
  }): Promise<readonly ConnectorAclEntry[]>;
}

function config(binding: ConnectorBinding): { siteAlias: string; spaceKey: string } {
  return {
    siteAlias: cleanSourceText(binding.source["siteAlias"] ?? "", "Confluence 站点别名", 256),
    spaceKey: cleanSourceText(binding.source["spaceKey"] ?? "", "Confluence spaceKey", 256),
  };
}

function sourceItem(value: ConfluencePageChange): ConnectorSourceItem {
  const item: ConnectorSourceItem = {
    externalId: cleanSourceText(value.contentId, "Confluence contentId", 1_024),
    sourceVersion: String(value.version),
    name: `${cleanSourceText(value.title, "Confluence 标题", 512)}.html`,
    path: `${value.spaceKey}/${value.contentId}`,
    mediaType: "text/html",
    sizeBytes: 0,
    modifiedAt: value.modifiedAt,
    etag: `${value.contentId}:${value.version}`,
    metadata: { provider: "confluence", spaceKey: value.spaceKey },
  };
  return value.webUrl === undefined ? item : { ...item, webUrl: value.webUrl };
}

export class ConfluenceConnector implements DocumentSourceConnector {
  readonly kind = "confluence" as const;

  constructor(private readonly client: ConfluenceClient) {}

  async scan(binding: ConnectorBinding, cursor: string | undefined, limit: number): Promise<ConnectorChangePage> {
    assertBinding(binding, this.kind);
    const cfg = config(binding);
    const state = decodeConnectorCursor(cursor, this.kind, binding.id, binding.configRevision);
    const page = await this.client.changes({
      credentialRef: binding.credentialRef,
      ...cfg,
      ...(state["cursor"] === undefined ? {} : { cursor: state["cursor"] }),
      limit: safeLimit(limit),
    }).catch(() => {
      throw new ConnectorError("SOURCE_UNAVAILABLE", "Confluence 同步失败", true);
    });
    return {
      changes: page.pages.map((value) => ({
        kind: value.deleted === true ? "delete" as const : "upsert" as const,
        item: sourceItem(value),
      })),
      nextCursor: page.nextCursor === undefined ? null
        : encodeConnectorCursor(this.kind, binding.id, binding.configRevision, { cursor: page.nextCursor }),
      hasMore: page.nextCursor !== undefined,
    };
  }

  async read(binding: ConnectorBinding, externalId: string, sourceVersion: string): Promise<ConnectorReadResult> {
    assertBinding(binding, this.kind);
    const cfg = config(binding);
    const version = Number(sourceVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ConnectorError("INVALID_BINDING", "Confluence 版本无效");
    }
    const result = await this.client.exportPage({
      credentialRef: binding.credentialRef,
      siteAlias: cfg.siteAlias,
      contentId: cleanSourceText(externalId, "Confluence contentId", 1_024),
      version,
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 Confluence 页面");
    });
    const current = sourceItem(result.page);
    if (current.sourceVersion !== sourceVersion) {
      throw new ConnectorError("SOURCE_CHANGED", "Confluence 页面版本已经变化，请重新同步");
    }
    return verifiedRead(current, Buffer.from(result.storageHtml, "utf8"));
  }

  async readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]> {
    assertBinding(binding, this.kind);
    const cfg = config(binding);
    return this.client.permissions({
      credentialRef: binding.credentialRef,
      siteAlias: cfg.siteAlias,
      contentId: cleanSourceText(externalId, "Confluence contentId", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 Confluence 权限");
    });
  }
}
