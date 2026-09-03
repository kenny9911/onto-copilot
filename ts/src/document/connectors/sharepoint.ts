import { decodeConnectorCursor, encodeConnectorCursor } from "./cursor.js";
import {
  ConnectorError,
  assertBinding,
  cleanSourceText,
  safeLimit,
  verifiedRead,
  type ConnectorAclEntry,
  type ConnectorBinding,
  type ConnectorChange,
  type ConnectorChangePage,
  type ConnectorReadResult,
  type ConnectorSourceItem,
  type DocumentSourceConnector,
} from "./types.js";

export interface SharePointDriveItem {
  readonly id: string;
  readonly name: string;
  readonly parentPath: string;
  readonly size: number;
  readonly lastModifiedAt: string;
  readonly eTag: string;
  readonly cTag?: string;
  readonly mimeType: string;
  readonly webUrl?: string;
  readonly sha256?: string;
  readonly isFolder?: boolean;
  readonly deleted?: boolean;
}

export interface SharePointDeltaPage {
  readonly items: readonly SharePointDriveItem[];
  readonly nextToken?: string;
  readonly deltaToken?: string;
}

export interface SharePointPermission {
  readonly subjectKind: "user" | "group" | "everyone";
  readonly subjectId: string;
  readonly roles: readonly string[];
  readonly denied?: boolean;
}

/** Graph HTTP 和 OAuth 由宿主实现；适配器永远拿不到可持久化 token。 */
export interface SharePointGraphClient {
  delta(input: {
    readonly credentialRef: string;
    readonly driveId: string;
    readonly rootItemId?: string;
    readonly deltaToken?: string;
    readonly pageToken?: string;
    readonly limit: number;
  }): Promise<SharePointDeltaPage>;
  read(input: {
    readonly credentialRef: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly sourceVersion: string;
  }): Promise<{ readonly item: SharePointDriveItem; readonly bytes: Uint8Array }>;
  permissions(input: {
    readonly credentialRef: string;
    readonly driveId: string;
    readonly itemId: string;
  }): Promise<readonly SharePointPermission[]>;
}

function driveId(binding: ConnectorBinding): string {
  return cleanSourceText(binding.source["driveId"] ?? "", "SharePoint driveId", 512);
}

function toItem(value: SharePointDriveItem): ConnectorSourceItem {
  const version = cleanSourceText(value.cTag ?? value.eTag, "SharePoint 版本", 1_024);
  const base: ConnectorSourceItem = {
    externalId: cleanSourceText(value.id, "SharePoint itemId", 1_024),
    sourceVersion: version,
    name: cleanSourceText(value.name, "SharePoint 文件名", 512),
    path: `${value.parentPath.replace(/\/$/u, "")}/${value.name}`,
    mediaType: value.mimeType || "application/octet-stream",
    sizeBytes: Math.max(0, Number(value.size) || 0),
    modifiedAt: value.lastModifiedAt,
    etag: cleanSourceText(value.eTag, "SharePoint eTag", 1_024),
    metadata: { provider: "sharepoint" },
  };
  return {
    ...base,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256.toLowerCase() }),
    ...(value.webUrl === undefined ? {} : { webUrl: value.webUrl }),
  };
}

function acl(values: readonly SharePointPermission[]): ConnectorAclEntry[] {
  return values.map((value) => ({
    subjectKind: value.subjectKind,
    subjectId: cleanSourceText(value.subjectId || "everyone", "SharePoint 权限主体", 1_024),
    effect: value.denied === true ? "deny" : "allow",
    permissions: value.roles.some((role) => /owner|manage|full control/iu.test(role))
      ? ["read", "write", "manage"]
      : value.roles.some((role) => /write|edit/iu.test(role))
        ? ["read", "write"]
        : ["read"],
  }));
}

export class SharePointConnector implements DocumentSourceConnector {
  readonly kind = "sharepoint" as const;

  constructor(private readonly client: SharePointGraphClient) {}

  async scan(
    binding: ConnectorBinding,
    cursor: string | undefined,
    limit: number,
  ): Promise<ConnectorChangePage> {
    assertBinding(binding, this.kind);
    const state = decodeConnectorCursor(cursor, this.kind, binding.id, binding.configRevision);
    const rootItemId = binding.source["rootItemId"];
    const page = await this.client.delta({
      credentialRef: binding.credentialRef,
      driveId: driveId(binding),
      ...(rootItemId === undefined ? {} : { rootItemId }),
      ...(state["delta"] === undefined ? {} : { deltaToken: state["delta"] }),
      ...(state["page"] === undefined ? {} : { pageToken: state["page"] }),
      limit: safeLimit(limit),
    }).catch(() => {
      throw new ConnectorError("SOURCE_UNAVAILABLE", "SharePoint 同步失败", true);
    });
    const changes: ConnectorChange[] = page.items
      .filter((item) => item.isFolder !== true)
      .map((item) => ({ kind: item.deleted === true ? "delete" : "upsert", item: toItem(item) }));
    const nextState: Record<string, string> = {};
    if (page.nextToken !== undefined) {
      if (state["delta"] !== undefined) nextState["delta"] = state["delta"];
      nextState["page"] = page.nextToken;
    } else if (page.deltaToken !== undefined) {
      nextState["delta"] = page.deltaToken;
    }
    return {
      changes,
      nextCursor: Object.keys(nextState).length === 0
        ? null
        : encodeConnectorCursor(this.kind, binding.id, binding.configRevision, nextState),
      hasMore: page.nextToken !== undefined,
    };
  }

  async read(
    binding: ConnectorBinding,
    externalId: string,
    sourceVersion: string,
  ): Promise<ConnectorReadResult> {
    assertBinding(binding, this.kind);
    const result = await this.client.read({
      credentialRef: binding.credentialRef,
      driveId: driveId(binding),
      itemId: cleanSourceText(externalId, "SharePoint itemId", 1_024),
      sourceVersion: cleanSourceText(sourceVersion, "SharePoint 版本", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 SharePoint 文件");
    });
    const item = toItem(result.item);
    if (item.sourceVersion !== sourceVersion) {
      throw new ConnectorError("SOURCE_CHANGED", "SharePoint 文件版本已经变化，请重新同步");
    }
    return verifiedRead(item, result.bytes, item.sha256);
  }

  async readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]> {
    assertBinding(binding, this.kind);
    const values = await this.client.permissions({
      credentialRef: binding.credentialRef,
      driveId: driveId(binding),
      itemId: cleanSourceText(externalId, "SharePoint itemId", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 SharePoint 权限");
    });
    return acl(values);
  }
}
