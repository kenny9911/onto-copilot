import { sha256Hex } from "../../kernel/ids.js";
import { ConnectorError, type ConnectorClassification, type ConnectorKind } from "./types.js";
import {
  ConnectorSyncService,
  type ConnectorSyncReport,
} from "./sync.js";
import {
  ConnectorSourceRepositoryError,
  type ConnectorLifecycleAction,
  type ConnectorSourcePatch,
  type ConnectorSourceRecord,
  type ConnectorSourceRepository,
  type ConnectorSourceScope,
} from "./source_repository.js";

const PROVIDERS = new Set<ConnectorKind>([
  "sharepoint",
  "webdav",
  "s3",
  "confluence",
  "datahub",
  "openmetadata",
]);
const CLASSIFICATIONS = new Set<ConnectorClassification>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const CREDENTIAL_REF = /^(?:(?:credential|secret|vault|keychain):\/\/[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,510}|cred_[A-Za-z0-9][A-Za-z0-9_.:-]{0,250})$/u;
const LOCAL_ROOT = /^(?:~(?:\/|$)|[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|etc|opt|Volumes)(?:\/|$))/iu;

export class ConnectorManagementError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "NOT_FOUND_OR_FORBIDDEN"
      | "REVISION_CONFLICT"
      | "DUPLICATE"
      | "BUSY"
      | "INVALID_STATE"
      | "SERVICE_UNAVAILABLE"
      | "SYNC_FAILED",
    message: string,
    readonly status: number,
    readonly actualRevision?: number,
  ) {
    super(message);
    this.name = "ConnectorManagementError";
    Object.setPrototypeOf(this, ConnectorManagementError.prototype);
  }
}

export interface ConnectorManagementIdentity {
  readonly scope: ConnectorSourceScope;
  readonly actorId: string;
}

export interface CreateConnectorSourceInput {
  /** 浏览器为一次人工动作生成；服务据此派生稳定 id，让超时重试不会重复创建。 */
  readonly requestId: string;
  readonly provider: ConnectorKind;
  readonly name: string;
  readonly rootOrPrefix: string;
  readonly credentialRef: string;
  readonly tags?: readonly string[];
  readonly classification?: ConnectorClassification;
  readonly enabled?: boolean;
}

export interface UpdateConnectorSourceInput {
  readonly expectedRevision: number;
  readonly provider?: ConnectorKind;
  readonly name?: string;
  readonly rootOrPrefix?: string;
  readonly credentialRef?: string;
  readonly tags?: readonly string[];
  readonly classification?: ConnectorClassification;
  readonly enabled?: boolean;
}

export interface ConnectorSyncOptions {
  readonly expectedRevision: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new ConnectorManagementError("INVALID_ARGUMENT", `${label}必须是文字`, 400);
  }
  const out = value.normalize("NFKC").trim();
  if (!out || [...out].length > max || /[\p{Cc}\p{Cs}]/u.test(out)) {
    throw new ConnectorManagementError("INVALID_ARGUMENT", `${label}无效`, 400);
  }
  return out;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      `${label}必须是 ${min} 到 ${max} 之间的整数`,
      400,
    );
  }
  return value as number;
}

function scopeValue(identity: ConnectorManagementIdentity): ConnectorManagementIdentity {
  return {
    scope: {
      projectId: text(identity.scope.projectId, "projectId", 256),
      owner: text(identity.scope.owner, "owner", 256),
    },
    actorId: text(identity.actorId, "actorId", 256),
  };
}

function providerValue(value: unknown): ConnectorKind {
  if (typeof value !== "string" || !PROVIDERS.has(value as ConnectorKind)) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      "provider 只支持 SharePoint、WebDAV、S3、Confluence、DataHub 或 OpenMetadata",
      400,
    );
  }
  return value as ConnectorKind;
}

function classificationValue(value: unknown): ConnectorClassification {
  if (typeof value !== "string" || !CLASSIFICATIONS.has(value as ConnectorClassification)) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      "classification 只支持 public、internal、confidential 或 restricted",
      400,
    );
  }
  return value as ConnectorClassification;
}

function tagsValue(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConnectorManagementError("INVALID_ARGUMENT", "tags 必须是文字数组", 400);
  }
  const out = new Set<string>();
  for (const valueItem of value) {
    out.add(text(valueItem, "标签", 80));
    if (out.size > 50) {
      throw new ConnectorManagementError("INVALID_ARGUMENT", "最多设置 50 个标签", 400);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function credentialRefValue(value: unknown): string {
  const out = text(value, "credential_ref", 512);
  if (!CREDENTIAL_REF.test(out)) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      "credential_ref 必须引用已批准的凭据项，不能提交 URL、token、secret 或 password",
      400,
    );
  }
  return out;
}

function decodedPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConnectorManagementError("INVALID_ARGUMENT", "root_or_prefix 包含无效转义", 400);
  }
}

function safeSegments(value: string): void {
  const decoded = decodedPath(value);
  if (
    value.includes("://") ||
    /^file:/iu.test(value) ||
    value.includes("\\") ||
    LOCAL_ROOT.test(decoded) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      "root_or_prefix 只能填写已批准连接内的远端目录，不能填写 URL 或本机路径",
      400,
    );
  }
}

function rootValue(provider: ConnectorKind, raw: unknown): string {
  const root = text(raw, "root_or_prefix", 2_048);
  safeSegments(root);
  if (provider === "webdav") {
    if (!root.startsWith("/") || root.startsWith("//")) {
      throw new ConnectorManagementError(
        "INVALID_ARGUMENT",
        "WebDAV root_or_prefix 必须是连接内的绝对目录，例如 /projects/purchase",
        400,
      );
    }
    return root.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
  }
  if (root.startsWith("/")) {
    throw new ConnectorManagementError("INVALID_ARGUMENT", "root_or_prefix 不能是本机绝对路径", 400);
  }
  if (provider === "s3") {
    const [bucket, ...parts] = root.split("/");
    if (
      bucket === undefined ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      bucket.includes("..")
    ) {
      throw new ConnectorManagementError(
        "INVALID_ARGUMENT",
        "S3 root_or_prefix 必须是 bucket 或 bucket/prefix",
        400,
      );
    }
    return [bucket, ...parts.filter(Boolean)].join("/");
  }
  if (provider === "confluence" && root.includes("/")) {
    throw new ConnectorManagementError(
      "INVALID_ARGUMENT",
      "Confluence root_or_prefix 只填写 space key",
      400,
    );
  }
  return root.replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
}

function boolValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConnectorManagementError("INVALID_ARGUMENT", `${label}必须是 true 或 false`, 400);
  }
  return value;
}

function repositoryError(error: ConnectorSourceRepositoryError): ConnectorManagementError {
  switch (error.code) {
    case "NOT_FOUND":
      return new ConnectorManagementError(
        "NOT_FOUND_OR_FORBIDDEN",
        "没有找到这个项目来源，或你无权访问",
        404,
      );
    case "REVISION_CONFLICT":
      return new ConnectorManagementError(
        "REVISION_CONFLICT",
        "这个来源刚被其他人修改。请刷新后再提交，系统没有覆盖对方的修改。",
        409,
        error.actualRevision,
      );
    case "DUPLICATE":
      return new ConnectorManagementError("DUPLICATE", error.message, 409);
    case "BUSY":
      return new ConnectorManagementError("BUSY", "这个来源正在同步，请稍后再修改。", 409);
    case "INVALID_STATE":
      return new ConnectorManagementError("INVALID_STATE", error.message, 409);
  }
}

async function repoCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ConnectorManagementError) throw error;
    if (error instanceof ConnectorSourceRepositoryError) throw repositoryError(error);
    throw new ConnectorManagementError(
      "SERVICE_UNAVAILABLE",
      "项目来源暂时无法访问，请稍后重试。",
      503,
    );
  }
}

function safeSyncFailure(error: unknown): string {
  return error instanceof ConnectorError ? `${error.code}: 外部来源同步失败` :
    "SOURCE_UNAVAILABLE: 外部来源同步失败";
}

export class ConnectorManagementService {
  constructor(
    private readonly repository: ConnectorSourceRepository,
    private readonly sync: ConnectorSyncService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly runtimeReady = true,
  ) {}

  async list(
    rawIdentity: ConnectorManagementIdentity,
    includeArchived = false,
  ): Promise<readonly ConnectorSourceRecord[]> {
    const identity = scopeValue(rawIdentity);
    return repoCall(() => this.repository.listSources(identity.scope, includeArchived));
  }

  async get(
    rawIdentity: ConnectorManagementIdentity,
    rawId: string,
  ): Promise<ConnectorSourceRecord> {
    const identity = scopeValue(rawIdentity);
    const id = text(rawId, "来源 ID", 256);
    const found = await repoCall(() => this.repository.getSource(identity.scope, id));
    if (found === null) {
      throw new ConnectorManagementError(
        "NOT_FOUND_OR_FORBIDDEN",
        "没有找到这个项目来源，或你无权访问",
        404,
      );
    }
    return found;
  }

  async create(
    rawIdentity: ConnectorManagementIdentity,
    input: CreateConnectorSourceInput,
  ): Promise<ConnectorSourceRecord> {
    const identity = scopeValue(rawIdentity);
    const requestId = text(input.requestId, "request_id", 256);
    const provider = providerValue(input.provider);
    const at = this.now();
    return repoCall(() => this.repository.createSource({
      id: `odcs_${sha256Hex([
        "ontodocument-connector-source-v1",
        identity.scope.projectId,
        identity.scope.owner,
        requestId,
      ].join("\n")).slice(0, 32)}`,
      scope: identity.scope,
      provider,
      name: text(input.name, "来源名称", 160),
      rootOrPrefix: rootValue(provider, input.rootOrPrefix),
      credentialRef: credentialRefValue(input.credentialRef),
      tags: tagsValue(input.tags),
      classification: input.classification === undefined
        ? "internal"
        : classificationValue(input.classification),
      enabled: input.enabled === undefined ? true : boolValue(input.enabled, "enabled"),
      actorId: identity.actorId,
      at,
    }));
  }

  async update(
    rawIdentity: ConnectorManagementIdentity,
    rawId: string,
    input: UpdateConnectorSourceInput,
  ): Promise<ConnectorSourceRecord> {
    const identity = scopeValue(rawIdentity);
    const id = text(rawId, "来源 ID", 256);
    const expectedRevision = integer(input.expectedRevision, "expected_revision", 1, Number.MAX_SAFE_INTEGER);
    const current = await this.get(identity, id);
    const provider = input.provider === undefined ? current.provider : providerValue(input.provider);
    const patch: ConnectorSourcePatch = {
      ...(input.provider === undefined ? {} : { provider }),
      ...(input.name === undefined ? {} : { name: text(input.name, "来源名称", 160) }),
      ...(input.rootOrPrefix === undefined && input.provider === undefined
        ? {}
        : { rootOrPrefix: rootValue(provider, input.rootOrPrefix ?? current.rootOrPrefix) }),
      ...(input.credentialRef === undefined
        ? {}
        : { credentialRef: credentialRefValue(input.credentialRef) }),
      ...(input.tags === undefined ? {} : { tags: tagsValue(input.tags) }),
      ...(input.classification === undefined
        ? {}
        : { classification: classificationValue(input.classification) }),
      ...(input.enabled === undefined ? {} : { enabled: boolValue(input.enabled, "enabled") }),
    };
    if (Object.keys(patch).length === 0) {
      throw new ConnectorManagementError("INVALID_ARGUMENT", "请至少提交一个要修改的字段", 400);
    }
    return repoCall(() => this.repository.updateSource({
      scope: identity.scope,
      id,
      expectedRevision,
      patch,
      actorId: identity.actorId,
      at: this.now(),
    }));
  }

  async lifecycle(
    rawIdentity: ConnectorManagementIdentity,
    rawId: string,
    action: ConnectorLifecycleAction,
    expectedRevision: number,
  ): Promise<ConnectorSourceRecord> {
    const identity = scopeValue(rawIdentity);
    const id = text(rawId, "来源 ID", 256);
    return repoCall(() => this.repository.changeLifecycle({
      scope: identity.scope,
      id,
      action,
      expectedRevision: integer(expectedRevision, "expected_revision", 1, Number.MAX_SAFE_INTEGER),
      actorId: identity.actorId,
      at: this.now(),
    }));
  }

  async syncNow(
    rawIdentity: ConnectorManagementIdentity,
    rawId: string,
    options: ConnectorSyncOptions,
  ): Promise<ConnectorSyncReport> {
    const identity = scopeValue(rawIdentity);
    const id = text(rawId, "来源 ID", 256);
    const revision = integer(options.expectedRevision, "expected_revision", 1, Number.MAX_SAFE_INTEGER);
    if (!this.runtimeReady) {
      // 先做项目边界内的存在性检查；不存在与越权仍统一 404，不能借 503 探测来源 ID。
      await this.get(identity, id);
      // 配置管理与远端客户端装配是两件事。允许先保存配置，但绝不能把“已保存”说成
      // “已同步”，也不应把状态改成 error 误导用户去重填凭据。
      throw new ConnectorManagementError(
        "INVALID_STATE",
        "连接器运行时未配置。来源设置已经保存，但现在还不能同步，请联系管理员完成连接器接入。",
        503,
      );
    }
    const pageSize = options.pageSize === undefined ? undefined :
      integer(options.pageSize, "page_size", 1, 500);
    const maxPages = options.maxPages === undefined ? undefined :
      integer(options.maxPages, "max_pages", 1, 1_000);
    const startedAt = this.now();
    await repoCall(() => this.repository.beginSync(identity.scope, id, revision, startedAt));
    try {
      return await this.sync.sync(id, {
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(maxPages === undefined ? {} : { maxPages }),
      });
    } catch (error) {
      // ConnectorSyncService 会处理扫描期错误；registry/config 解析若在 try 之前失败，
      // 这里补写同一个安全错误。重复 UPDATE 是幂等的，且 revision 已变化时自动失效。
      await this.repository.recordFailure(id, revision, startedAt, safeSyncFailure(error)).catch(() => {});
      throw new ConnectorManagementError(
        "SYNC_FAILED",
        "这次同步没有完成。已保留上次成功位置，请检查连接和凭据后重试。",
        502,
      );
    }
  }
}
