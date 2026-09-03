import { canonicalJson, sha256Hex } from "../../kernel/ids.js";
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
  type ConnectorKind,
  type ConnectorReadResult,
  type ConnectorSourceItem,
  type DocumentSourceConnector,
} from "./types.js";

export interface CatalogEntity {
  readonly urn: string;
  readonly version: string;
  readonly name: string;
  readonly entityType: string;
  readonly modifiedAt: string;
  readonly description?: string;
  readonly owners?: readonly string[];
  readonly glossaryTerms?: readonly string[];
  readonly fields?: readonly { readonly name: string; readonly type: string; readonly description?: string }[];
  readonly deleted?: boolean;
  readonly webUrl?: string;
}

export interface DataCatalogClient {
  changes(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly domain?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{ readonly entities: readonly CatalogEntity[]; readonly nextCursor?: string }>;
  entity(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly urn: string;
    readonly version: string;
  }): Promise<CatalogEntity>;
  acl(input: {
    readonly credentialRef: string;
    readonly endpointAlias: string;
    readonly urn: string;
  }): Promise<readonly ConnectorAclEntry[]>;
}

function markdown(entity: CatalogEntity): string {
  const lines = [
    `# ${entity.name}`,
    "",
    `- 资产类型：${entity.entityType}`,
    `- 稳定标识：${entity.urn}`,
    `- 来源版本：${entity.version}`,
  ];
  if (entity.description?.trim()) lines.push("", entity.description.trim());
  if ((entity.owners?.length ?? 0) > 0) lines.push("", `## 负责人\n\n${entity.owners!.map((v) => `- ${v}`).join("\n")}`);
  if ((entity.glossaryTerms?.length ?? 0) > 0) lines.push("", `## 术语\n\n${entity.glossaryTerms!.map((v) => `- ${v}`).join("\n")}`);
  if ((entity.fields?.length ?? 0) > 0) {
    lines.push("", "## 字段", "", "| 字段 | 类型 | 说明 |", "|---|---|---|");
    for (const field of entity.fields ?? []) {
      lines.push(`| ${field.name.replaceAll("|", "\\|")} | ${field.type.replaceAll("|", "\\|")} | ${(field.description ?? "").replaceAll("|", "\\|")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function item(kind: "datahub" | "openmetadata", value: CatalogEntity): ConnectorSourceItem {
  const body = markdown(value);
  const base: ConnectorSourceItem = {
    externalId: cleanSourceText(value.urn, "数据目录资产标识", 4_096),
    sourceVersion: cleanSourceText(value.version, "数据目录版本", 1_024),
    name: `${cleanSourceText(value.name, "数据目录资产名", 512)}.md`,
    path: `${value.entityType}/${sha256Hex(value.urn).slice(0, 24)}.md`,
    mediaType: "text/markdown",
    sizeBytes: Buffer.byteLength(body),
    modifiedAt: value.modifiedAt,
    etag: sha256Hex(canonicalJson(value)),
    sha256: sha256Hex(body),
    metadata: { provider: kind, entityType: value.entityType, urn: value.urn },
  };
  return value.webUrl === undefined ? base : { ...base, webUrl: value.webUrl };
}

export class DataCatalogConnector implements DocumentSourceConnector {
  readonly kind: ConnectorKind;

  constructor(
    kind: "datahub" | "openmetadata",
    private readonly client: DataCatalogClient,
  ) {
    this.kind = kind;
  }

  private config(binding: ConnectorBinding): { endpointAlias: string; domain?: string } {
    const endpointAlias = cleanSourceText(binding.source["endpointAlias"] ?? "", "数据目录端点别名", 256);
    const domain = binding.source["domain"]?.trim();
    return { endpointAlias, ...(domain ? { domain } : {}) };
  }

  async scan(binding: ConnectorBinding, cursor: string | undefined, limit: number): Promise<ConnectorChangePage> {
    assertBinding(binding, this.kind);
    const state = decodeConnectorCursor(cursor, this.kind, binding.id, binding.configRevision);
    const page = await this.client.changes({
      credentialRef: binding.credentialRef,
      ...this.config(binding),
      ...(state["cursor"] === undefined ? {} : { cursor: state["cursor"] }),
      limit: safeLimit(limit),
    }).catch(() => {
      throw new ConnectorError("SOURCE_UNAVAILABLE", "数据目录同步失败", true);
    });
    return {
      changes: page.entities.map((entity) => ({
        kind: entity.deleted === true ? "delete" as const : "upsert" as const,
        item: item(this.kind as "datahub" | "openmetadata", entity),
      })),
      nextCursor: page.nextCursor === undefined ? null
        : encodeConnectorCursor(this.kind, binding.id, binding.configRevision, { cursor: page.nextCursor }),
      hasMore: page.nextCursor !== undefined,
    };
  }

  async read(binding: ConnectorBinding, externalId: string, sourceVersion: string): Promise<ConnectorReadResult> {
    assertBinding(binding, this.kind);
    const entity = await this.client.entity({
      credentialRef: binding.credentialRef,
      endpointAlias: this.config(binding).endpointAlias,
      urn: cleanSourceText(externalId, "数据目录资产标识", 4_096),
      version: cleanSourceText(sourceVersion, "数据目录版本", 1_024),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取数据目录资产");
    });
    const current = item(this.kind as "datahub" | "openmetadata", entity);
    if (current.sourceVersion !== sourceVersion) {
      throw new ConnectorError("SOURCE_CHANGED", "数据目录资产版本已经变化，请重新同步");
    }
    return verifiedRead(current, Buffer.from(markdown(entity), "utf8"), current.sha256);
  }

  async readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]> {
    assertBinding(binding, this.kind);
    return this.client.acl({
      credentialRef: binding.credentialRef,
      endpointAlias: this.config(binding).endpointAlias,
      urn: cleanSourceText(externalId, "数据目录资产标识", 4_096),
    }).catch(() => {
      throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "无法读取数据目录权限");
    });
  }
}
