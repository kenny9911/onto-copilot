import { sha256Hex } from "../../kernel/ids.js";

export type ConnectorKind =
  | "sharepoint"
  | "webdav"
  | "s3"
  | "confluence"
  | "datahub"
  | "openmetadata";

export type ConnectorChangeKind = "upsert" | "delete" | "acl";
export type ConnectorAclSubjectKind = "user" | "group" | "everyone";
export type ConnectorAclEffect = "allow" | "deny";
export type ConnectorClassification = "public" | "internal" | "confidential" | "restricted";

/**
 * 可以持久化和展示的连接信息。凭据只保存引用，真实 token/secret 由运行环境注入，
 * 绝不能出现在模型参数、事件正文或这个对象里。
 */
export interface ConnectorBinding {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ConnectorKind;
  readonly displayName: string;
  readonly credentialRef: string;
  readonly source: Readonly<Record<string, string>>;
  /** 传给文档 sink 的受控项目元数据；适配器不得据此改变上游请求。 */
  readonly tags?: readonly string[];
  readonly classification?: ConnectorClassification;
  readonly configRevision: number;
  readonly enabled: boolean;
}

export interface ConnectorAclEntry {
  readonly subjectKind: ConnectorAclSubjectKind;
  readonly subjectId: string;
  readonly effect: ConnectorAclEffect;
  readonly permissions: readonly ("read" | "write" | "manage")[];
}

export interface ConnectorSourceItem {
  /** 上游系统内不会因改名而变化的身份。 */
  readonly externalId: string;
  /** 上游精确版本；没有版本号的来源使用不可变 etag。 */
  readonly sourceVersion: string;
  readonly name: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly etag: string;
  readonly sha256?: string;
  readonly webUrl?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ConnectorChange {
  readonly kind: ConnectorChangeKind;
  readonly item: ConnectorSourceItem;
  /** ACL 变更与内容变更可以同批返回；缺席表示需要 readAcl 再取。 */
  readonly acl?: readonly ConnectorAclEntry[];
}

export interface ConnectorChangePage {
  readonly changes: readonly ConnectorChange[];
  /** 由适配器生成的 opaque cursor；调用方不得解析或拼接。 */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConnectorReadResult {
  readonly item: ConnectorSourceItem;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface DocumentSourceConnector {
  readonly kind: ConnectorKind;
  scan(binding: ConnectorBinding, cursor: string | undefined, limit: number): Promise<ConnectorChangePage>;
  read(binding: ConnectorBinding, externalId: string, sourceVersion: string): Promise<ConnectorReadResult>;
  readAcl(binding: ConnectorBinding, externalId: string): Promise<readonly ConnectorAclEntry[]>;
}

export class ConnectorError extends Error {
  constructor(
    readonly code:
      | "INVALID_BINDING"
      | "INVALID_CURSOR"
      | "NOT_FOUND_OR_FORBIDDEN"
      | "SOURCE_CHANGED"
      | "SOURCE_UNAVAILABLE"
      | "INTEGRITY_ERROR",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ConnectorError";
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }
}

export function assertBinding(binding: ConnectorBinding, kind: ConnectorKind): void {
  if (
    binding.kind !== kind ||
    !binding.id.trim() ||
    !binding.projectId.trim() ||
    !binding.displayName.trim() ||
    !binding.credentialRef.trim() ||
    !Number.isSafeInteger(binding.configRevision) ||
    binding.configRevision < 1
  ) {
    throw new ConnectorError("INVALID_BINDING", "连接器配置无效");
  }
}

export function safeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ConnectorError("INVALID_BINDING", "每页数量必须在 1—500 之间");
  }
  return limit;
}

export function cleanSourceText(value: string, label: string, max = 2_048): string {
  const clean = value.normalize("NFKC").trim();
  if (!clean || clean.includes("\u0000") || [...clean].length > max) {
    throw new ConnectorError("SOURCE_UNAVAILABLE", `${label}无效`);
  }
  return clean;
}

export function verifiedRead(
  item: ConnectorSourceItem,
  bytes: Uint8Array,
  declaredSha256?: string,
): ConnectorReadResult {
  const digest = sha256Hex(bytes);
  if (declaredSha256 !== undefined && declaredSha256.toLowerCase() !== digest) {
    throw new ConnectorError("INTEGRITY_ERROR", "上游返回内容与声明的 SHA-256 不一致");
  }
  return { item, bytes, sha256: digest };
}
