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

export interface S3ObjectVersion {
  readonly key: string;
  readonly versionId: string;
  readonly etag: string;
  readonly size: number;
  readonly lastModified: string;
  readonly isLatest: boolean;
  readonly deleteMarker?: boolean;
  readonly contentType?: string;
  readonly sha256?: string;
}

export interface S3ConnectorClient {
  listVersions(input: {
    readonly credentialRef: string;
    readonly bucket: string;
    readonly prefix: string;
    readonly keyMarker?: string;
    readonly versionIdMarker?: string;
    readonly limit: number;
  }): Promise<{
    readonly versions: readonly S3ObjectVersion[];
    readonly nextKeyMarker?: string;
    readonly nextVersionIdMarker?: string;
  }>;
  getObject(input: {
    readonly credentialRef: string;
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }): Promise<{ readonly version: S3ObjectVersion; readonly bytes: Uint8Array }>;
  getAcl(input: {
    readonly credentialRef: string;
    readonly bucket: string;
    readonly key: string;
    readonly versionId?: string;
  }): Promise<readonly ConnectorAclEntry[]>;
}

function cfg(binding: ConnectorBinding): { bucket: string; prefix: string } {
  const bucket = cleanSourceText(binding.source["bucket"] ?? "", "S3 bucket", 255);
  const prefix = (binding.source["prefix"] ?? "").trim().replace(/^\/+|\/+$/gu, "");
  if (prefix.split("/").some((part) => part === "..") || prefix.includes("\u0000")) {
    throw new ConnectorError("INVALID_BINDING", "S3 prefix 无效");
  }
  return { bucket, prefix };
}

function safeKey(prefix: string, key: string): string {
  const value = cleanSourceText(key, "S3 key", 4_096).replace(/^\/+/, "");
  if ((prefix && value !== prefix && !value.startsWith(`${prefix}/`)) || value.split("/").includes("..")) {
    throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "S3 对象不在已配置前缀中");
  }
  return value;
}

function item(prefix: string, value: S3ObjectVersion): ConnectorSourceItem {
  const key = safeKey(prefix, value.key);
  return {
    externalId: key,
    sourceVersion: cleanSourceText(value.versionId, "S3 versionId", 1_024),
    name: key.split("/").at(-1) ?? key,
    path: key,
    mediaType: value.contentType ?? "application/octet-stream",
    sizeBytes: Math.max(0, Number(value.size) || 0),
    modifiedAt: value.lastModified,
    etag: value.etag,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256.toLowerCase() }),
    metadata: { provider: "s3", isLatest: String(value.isLatest) },
  };
}

export class S3Connector implements DocumentSourceConnector {
  readonly kind = "s3" as const;

  constructor(private readonly client: S3ConnectorClient) {}

  async scan(binding: ConnectorBinding, cursor: string | undefined, limit: number): Promise<ConnectorChangePage> {
    assertBinding(binding, this.kind);
    const config = cfg(binding);
    const state = decodeConnectorCursor(cursor, this.kind, binding.id, binding.configRevision);
    const page = await this.client.listVersions({
      credentialRef: binding.credentialRef,
      ...config,
      ...(state["key"] === undefined ? {} : { keyMarker: state["key"] }),
      ...(state["version"] === undefined ? {} : { versionIdMarker: state["version"] }),
      limit: safeLimit(limit),
    }).catch(() => {
      throw new ConnectorError("SOURCE_UNAVAILABLE", "S3 同步失败", true);
    });
    const changes = page.versions.map((value) => ({
      kind: value.deleteMarker === true ? "delete" as const : "upsert" as const,
      item: item(config.prefix, value),
    }));
    const hasMore = page.nextKeyMarker !== undefined;
    const nextCursor = hasMore
      ? encodeConnectorCursor(this.kind, binding.id, binding.configRevision, {
          key: page.nextKeyMarker ?? "",
          version: page.nextVersionIdMarker ?? "",
        })
      : null;
    return { changes, nextCursor, hasMore };
  }

  async read(binding: ConnectorBinding, externalId: string, sourceVersion: string): Promise<ConnectorReadResult> {
    assertBinding(binding, this.kind);
    const config = cfg(binding);
    const key = safeKey(config.prefix, externalId);
    const result = await this.client.getObject({
      credentialRef: binding.credentialRef,
      bucket: config.bucket,
      key,
      versionId: cleanSourceText(sourceVersion, "S3 versionId", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 S3 对象");
    });
    const current = item(config.prefix, result.version);
    if (current.sourceVersion !== sourceVersion) {
      throw new ConnectorError("SOURCE_CHANGED", "S3 对象版本已经变化，请重新同步");
    }
    return verifiedRead(current, result.bytes, current.sha256);
  }

  async readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]> {
    assertBinding(binding, this.kind);
    const config = cfg(binding);
    return this.client.getAcl({
      credentialRef: binding.credentialRef,
      bucket: config.bucket,
      key: safeKey(config.prefix, externalId),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取 S3 对象权限");
    });
  }
}
