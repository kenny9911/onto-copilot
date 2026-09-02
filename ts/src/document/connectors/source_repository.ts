import type { Conn, Store } from "../../store/engine.js";
import {
  ConnectorError,
  type ConnectorBinding,
  type ConnectorClassification,
  type ConnectorKind,
} from "./types.js";
import type {
  ConnectorBindingRepository,
  ConnectorSyncState,
} from "./sync.js";

export interface ConnectorSourceScope {
  readonly projectId: string;
  readonly owner: string;
}

export type ConnectorSourceStatus = "idle" | "syncing" | "error" | "archived";

export interface ConnectorSourceRecord {
  readonly id: string;
  readonly scope: ConnectorSourceScope;
  readonly provider: ConnectorKind;
  readonly name: string;
  readonly rootOrPrefix: string;
  readonly credentialRef: string;
  readonly tags: readonly string[];
  readonly classification: ConnectorClassification;
  readonly enabled: boolean;
  readonly revision: number;
  /** 内部同步状态；HTTP 视图不得回传 cursor 原文。 */
  readonly cursor: string | null;
  readonly status: ConnectorSourceStatus;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  /** 只允许安全错误码和固定文案，绝不保存上游原始异常。 */
  readonly lastError: string | null;
}

export interface CreateConnectorSourceRecord {
  readonly id: string;
  readonly scope: ConnectorSourceScope;
  readonly provider: ConnectorKind;
  readonly name: string;
  readonly rootOrPrefix: string;
  readonly credentialRef: string;
  readonly tags: readonly string[];
  readonly classification: ConnectorClassification;
  readonly enabled: boolean;
  readonly actorId: string;
  readonly at: string;
}

export interface ConnectorSourcePatch {
  readonly provider?: ConnectorKind;
  readonly name?: string;
  readonly rootOrPrefix?: string;
  readonly credentialRef?: string;
  readonly tags?: readonly string[];
  readonly classification?: ConnectorClassification;
  readonly enabled?: boolean;
}

export interface UpdateConnectorSourceRecord {
  readonly scope: ConnectorSourceScope;
  readonly id: string;
  readonly expectedRevision: number;
  readonly patch: ConnectorSourcePatch;
  readonly actorId: string;
  readonly at: string;
}

export type ConnectorLifecycleAction = "enable" | "disable" | "archive" | "restore";

export interface ChangeConnectorLifecycle {
  readonly scope: ConnectorSourceScope;
  readonly id: string;
  readonly expectedRevision: number;
  readonly action: ConnectorLifecycleAction;
  readonly actorId: string;
  readonly at: string;
}

export class ConnectorSourceRepositoryError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "REVISION_CONFLICT" | "DUPLICATE" | "BUSY" | "INVALID_STATE",
    message: string,
    readonly actualRevision?: number,
  ) {
    super(message);
    this.name = "ConnectorSourceRepositoryError";
    Object.setPrototypeOf(this, ConnectorSourceRepositoryError.prototype);
  }
}

export interface ConnectorSourceRepository extends ConnectorBindingRepository {
  listSources(scope: ConnectorSourceScope, includeArchived?: boolean): Promise<readonly ConnectorSourceRecord[]>;
  getSource(scope: ConnectorSourceScope, id: string): Promise<ConnectorSourceRecord | null>;
  createSource(input: CreateConnectorSourceRecord): Promise<ConnectorSourceRecord>;
  updateSource(input: UpdateConnectorSourceRecord): Promise<ConnectorSourceRecord>;
  changeLifecycle(input: ChangeConnectorLifecycle): Promise<ConnectorSourceRecord>;
  beginSync(scope: ConnectorSourceScope, id: string, expectedRevision: number, at: string): Promise<ConnectorSourceRecord>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const scopeKey = (scope: ConnectorSourceScope): string => `${scope.projectId}\u0000${scope.owner}`;

function sourceKey(scope: ConnectorSourceScope, id: string): string {
  return `${scopeKey(scope)}\u0000${id}`;
}

function configEqual(a: ConnectorSourceRecord, b: CreateConnectorSourceRecord): boolean {
  return a.provider === b.provider &&
    a.name === b.name &&
    a.rootOrPrefix === b.rootOrPrefix &&
    a.credentialRef === b.credentialRef &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags) &&
    a.classification === b.classification &&
    a.enabled === b.enabled;
}

function patchResult(current: ConnectorSourceRecord, patch: ConnectorSourcePatch): ConnectorSourceRecord {
  const configChanged = patch.provider !== undefined || patch.rootOrPrefix !== undefined ||
    patch.credentialRef !== undefined || patch.name !== undefined || patch.tags !== undefined ||
    patch.classification !== undefined || patch.enabled !== undefined;
  return {
    ...current,
    ...(patch.provider === undefined ? {} : { provider: patch.provider }),
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.rootOrPrefix === undefined ? {} : { rootOrPrefix: patch.rootOrPrefix }),
    ...(patch.credentialRef === undefined ? {} : { credentialRef: patch.credentialRef }),
    ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
    ...(patch.classification === undefined ? {} : { classification: patch.classification }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(configChanged ? { cursor: null, status: "idle" as const, lastError: null } : {}),
  };
}

function samePatch(current: ConnectorSourceRecord, input: UpdateConnectorSourceRecord): boolean {
  const wanted = patchResult(current, input.patch);
  return wanted.provider === current.provider && wanted.name === current.name &&
    wanted.rootOrPrefix === current.rootOrPrefix && wanted.credentialRef === current.credentialRef &&
    JSON.stringify(wanted.tags) === JSON.stringify(current.tags) &&
    wanted.classification === current.classification && wanted.enabled === current.enabled;
}

function lifecycleTarget(
  current: ConnectorSourceRecord,
  action: ConnectorLifecycleAction,
): Pick<ConnectorSourceRecord, "enabled" | "status" | "lastError"> {
  if (action === "archive") return { enabled: false, status: "archived", lastError: null };
  if (action === "restore") return { enabled: false, status: "idle", lastError: null };
  if (current.status === "archived") {
    throw new ConnectorSourceRepositoryError("INVALID_STATE", "来源已归档，请先恢复");
  }
  return action === "enable"
    ? { enabled: true, status: "idle", lastError: null }
    : { enabled: false, status: "idle", lastError: null };
}

function sameLifecycle(current: ConnectorSourceRecord, action: ConnectorLifecycleAction): boolean {
  if (action === "archive") return current.status === "archived" && !current.enabled;
  if (action === "restore") return current.status === "idle" && !current.enabled;
  if (current.status === "archived") return false;
  return action === "enable" ? current.enabled : !current.enabled;
}

function sourceConfig(record: ConnectorSourceRecord): Readonly<Record<string, string>> {
  const root = record.rootOrPrefix;
  switch (record.provider) {
    case "sharepoint": {
      const [driveId, ...rest] = root.split("/");
      const rootItemId = rest.join("/");
      return { driveId: driveId ?? "", ...(rootItemId ? { rootItemId } : {}) };
    }
    case "webdav":
      return { endpointAlias: record.credentialRef, rootPath: root };
    case "s3": {
      const [bucket, ...rest] = root.split("/");
      return { bucket: bucket ?? "", prefix: rest.join("/") };
    }
    case "confluence":
      return { siteAlias: record.credentialRef, spaceKey: root };
    case "datahub":
    case "openmetadata":
      return { endpointAlias: record.credentialRef, ...(root ? { domain: root } : {}) };
  }
}

export function connectorBindingOf(record: ConnectorSourceRecord): ConnectorBinding {
  return {
    id: record.id,
    projectId: record.scope.projectId,
    kind: record.provider,
    displayName: record.name,
    credentialRef: record.credentialRef,
    source: sourceConfig(record),
    tags: [...record.tags],
    classification: record.classification,
    configRevision: record.revision,
    enabled: record.enabled && record.status !== "archived",
  };
}

function safeFailure(message: string): string {
  const code = /^([A-Z_]{3,64}):/u.exec(message)?.[1] ?? "SOURCE_UNAVAILABLE";
  return `${code}: 外部来源同步失败`;
}

export class MemoryConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly sources = new Map<string, ConnectorSourceRecord>();

  async listSources(scope: ConnectorSourceScope, includeArchived = false): Promise<readonly ConnectorSourceRecord[]> {
    return [...this.sources.values()]
      .filter((row) => row.scope.projectId === scope.projectId && row.scope.owner === scope.owner &&
        (includeArchived || row.status !== "archived"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async getSource(scope: ConnectorSourceScope, id: string): Promise<ConnectorSourceRecord | null> {
    const row = this.sources.get(sourceKey(scope, id));
    return row === undefined ? null : clone(row);
  }

  async createSource(input: CreateConnectorSourceRecord): Promise<ConnectorSourceRecord> {
    const key = sourceKey(input.scope, input.id);
    const existing = this.sources.get(key);
    if (existing !== undefined) {
      if (configEqual(existing, input)) return clone(existing);
      throw new ConnectorSourceRepositoryError("DUPLICATE", "同一个创建请求对应了不同配置");
    }
    if ([...this.sources.values()].some((row) => row.scope.projectId === input.scope.projectId &&
      row.scope.owner === input.scope.owner && row.provider === input.provider &&
      row.rootOrPrefix === input.rootOrPrefix)) {
      throw new ConnectorSourceRepositoryError("DUPLICATE", "这个远端目录已经加入项目");
    }
    const row: ConnectorSourceRecord = {
      id: input.id,
      scope: { ...input.scope },
      provider: input.provider,
      name: input.name,
      rootOrPrefix: input.rootOrPrefix,
      credentialRef: input.credentialRef,
      tags: [...input.tags],
      classification: input.classification,
      enabled: input.enabled,
      revision: 1,
      cursor: null,
      status: "idle",
      createdBy: input.actorId,
      updatedBy: input.actorId,
      createdAt: input.at,
      updatedAt: input.at,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
    };
    this.sources.set(key, row);
    return clone(row);
  }

  async updateSource(input: UpdateConnectorSourceRecord): Promise<ConnectorSourceRecord> {
    const key = sourceKey(input.scope, input.id);
    const current = this.sources.get(key);
    if (current === undefined) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
    if (current.status === "archived") {
      throw new ConnectorSourceRepositoryError("INVALID_STATE", "来源已归档，请先恢复");
    }
    if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
    if (current.revision !== input.expectedRevision) {
      if (current.revision === input.expectedRevision + 1 && samePatch(current, input)) return clone(current);
      throw new ConnectorSourceRepositoryError(
        "REVISION_CONFLICT",
        "来源配置刚被其他人修改",
        current.revision,
      );
    }
    const wanted = patchResult(current, input.patch);
    if ([...this.sources.values()].some((row) => row.id !== current.id &&
      row.scope.projectId === input.scope.projectId && row.scope.owner === input.scope.owner &&
      row.provider === wanted.provider && row.rootOrPrefix === wanted.rootOrPrefix)) {
      throw new ConnectorSourceRepositoryError("DUPLICATE", "这个远端目录已经加入项目");
    }
    const next: ConnectorSourceRecord = {
      ...wanted,
      revision: current.revision + 1,
      updatedBy: input.actorId,
      updatedAt: input.at,
    };
    this.sources.set(key, next);
    return clone(next);
  }

  async changeLifecycle(input: ChangeConnectorLifecycle): Promise<ConnectorSourceRecord> {
    const key = sourceKey(input.scope, input.id);
    const current = this.sources.get(key);
    if (current === undefined) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
    if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
    if (current.revision !== input.expectedRevision) {
      if (current.revision === input.expectedRevision + 1 && sameLifecycle(current, input.action)) {
        return clone(current);
      }
      throw new ConnectorSourceRepositoryError(
        "REVISION_CONFLICT",
        "来源配置刚被其他人修改",
        current.revision,
      );
    }
    const target = lifecycleTarget(current, input.action);
    const next = {
      ...current,
      ...target,
      revision: current.revision + 1,
      updatedBy: input.actorId,
      updatedAt: input.at,
    };
    this.sources.set(key, next);
    return clone(next);
  }

  async beginSync(
    scope: ConnectorSourceScope,
    id: string,
    expectedRevision: number,
    at: string,
  ): Promise<ConnectorSourceRecord> {
    const key = sourceKey(scope, id);
    const current = this.sources.get(key);
    if (current === undefined) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
    if (current.revision !== expectedRevision) {
      throw new ConnectorSourceRepositoryError("REVISION_CONFLICT", "来源配置刚被修改", current.revision);
    }
    if (!current.enabled || current.status === "archived") {
      throw new ConnectorSourceRepositoryError("INVALID_STATE", "来源没有启用");
    }
    if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
    const next = { ...current, status: "syncing" as const, lastStartedAt: at, updatedAt: at, lastError: null };
    this.sources.set(key, next);
    return clone(next);
  }

  async get(bindingId: string): Promise<ConnectorBinding | null> {
    const row = [...this.sources.values()].find((source) => source.id === bindingId);
    return row === undefined ? null : connectorBindingOf(row);
  }

  async list(projectId: string): Promise<readonly ConnectorBinding[]> {
    return [...this.sources.values()]
      .filter((row) => row.scope.projectId === projectId)
      .map(connectorBindingOf);
  }

  async save(binding: ConnectorBinding, expectedRevision?: number): Promise<ConnectorBinding> {
    const current = [...this.sources.values()].find((row) => row.id === binding.id);
    if (current === undefined) {
      throw new ConnectorError("INVALID_BINDING", "受管来源必须通过管理服务创建");
    }
    if (expectedRevision !== current.revision) {
      throw new ConnectorError("SOURCE_CHANGED", "连接器配置刚被修改，请刷新后重试");
    }
    return connectorBindingOf(current);
  }

  async state(bindingId: string): Promise<ConnectorSyncState> {
    const row = [...this.sources.values()].find((source) => source.id === bindingId);
    if (row === undefined) throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "连接器不存在");
    return {
      bindingId,
      cursor: row.cursor,
      revision: row.revision,
      lastStartedAt: row.lastStartedAt,
      lastCompletedAt: row.lastCompletedAt,
      lastError: row.lastError,
    };
  }

  async commitCursor(
    bindingId: string,
    expectedRevision: number,
    cursor: string | null,
    completedAt: string,
    continueSync = false,
  ): Promise<ConnectorSyncState> {
    const entry = [...this.sources.entries()].find(([, row]) => row.id === bindingId);
    if (entry === undefined) throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "连接器不存在");
    const [key, row] = entry;
    if (row.revision !== expectedRevision) throw new ConnectorError("SOURCE_CHANGED", "连接器配置已变化");
    const next = {
      ...row,
      cursor,
      status: continueSync ? "syncing" as const : "idle" as const,
      lastCompletedAt: completedAt,
      updatedAt: completedAt,
      lastError: null,
    };
    this.sources.set(key, next);
    return {
      bindingId,
      cursor,
      revision: row.revision,
      lastStartedAt: next.lastStartedAt,
      lastCompletedAt: completedAt,
      lastError: null,
    };
  }

  async recordFailure(
    bindingId: string,
    expectedRevision: number,
    startedAt: string,
    message: string,
  ): Promise<void> {
    const entry = [...this.sources.entries()].find(([, row]) => row.id === bindingId);
    if (entry === undefined) return;
    const [key, row] = entry;
    if (row.revision !== expectedRevision) return;
    this.sources.set(key, {
      ...row,
      status: "error",
      lastStartedAt: startedAt,
      updatedAt: startedAt,
      lastError: safeFailure(message),
    });
  }
}

type DbRow = Record<string, unknown>;

const COLUMNS =
  "id,project_id,owner,provider,name,root_or_prefix,credential_ref,tags,classification,enabled," +
  "revision,cursor,status,created_by,updated_by,created_at,updated_at,last_started_at," +
  "last_completed_at,last_error";

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function tagsValue(value: unknown): readonly string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.map(String) : [];
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? "");
  const parsed = new Date(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/u.test(raw)
    ? raw
    : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function nullableDate(value: unknown): string | null {
  return value === null || value === undefined ? null : dateText(value);
}

function rowSource(row: DbRow): ConnectorSourceRecord {
  return {
    id: String(row["id"]),
    scope: { projectId: String(row["project_id"]), owner: String(row["owner"]) },
    provider: String(row["provider"]) as ConnectorKind,
    name: String(row["name"]),
    rootOrPrefix: String(row["root_or_prefix"]),
    credentialRef: String(row["credential_ref"]),
    tags: tagsValue(row["tags"]),
    classification: String(row["classification"]) as ConnectorClassification,
    enabled: row["enabled"] === true || row["enabled"] === 1 || row["enabled"] === 1n,
    revision: Number(row["revision"]),
    cursor: row["cursor"] === null || row["cursor"] === undefined ? null : String(row["cursor"]),
    status: String(row["status"]) as ConnectorSourceStatus,
    createdBy: String(row["created_by"]),
    updatedBy: String(row["updated_by"]),
    createdAt: dateText(row["created_at"]),
    updatedAt: dateText(row["updated_at"]),
    lastStartedAt: nullableDate(row["last_started_at"]),
    lastCompletedAt: nullableDate(row["last_completed_at"]),
    lastError: row["last_error"] === null || row["last_error"] === undefined
      ? null
      : String(row["last_error"]),
  };
}

export class SqlConnectorSourceRepository implements ConnectorSourceRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlConnectorSourceRepository 需要启用数据库的 Store");
  }

  private get engine() {
    return this.store.engine!;
  }

  private async sourceIn(conn: Conn, scope: ConnectorSourceScope, id: string): Promise<ConnectorSourceRecord | null> {
    const rows = await conn.all<DbRow>(
      `SELECT ${COLUMNS} FROM onto_document_connector_source ` +
        "WHERE project_id=? AND owner=? AND id=?",
      [scope.projectId, scope.owner, id],
    );
    return rows[0] === undefined ? null : rowSource(rows[0]);
  }

  private async sourceById(conn: Conn, id: string): Promise<ConnectorSourceRecord | null> {
    const rows = await conn.all<DbRow>(
      `SELECT ${COLUMNS} FROM onto_document_connector_source WHERE id=?`,
      [id],
    );
    return rows[0] === undefined ? null : rowSource(rows[0]);
  }

  async listSources(scope: ConnectorSourceScope, includeArchived = false): Promise<readonly ConnectorSourceRecord[]> {
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        `SELECT ${COLUMNS} FROM onto_document_connector_source ` +
          "WHERE project_id=? AND owner=?" + (includeArchived ? "" : " AND status<>'archived'") +
          " ORDER BY updated_at DESC,id ASC",
        [scope.projectId, scope.owner],
      );
      return rows.map(rowSource);
    });
  }

  async getSource(scope: ConnectorSourceScope, id: string): Promise<ConnectorSourceRecord | null> {
    return this.engine.connect((conn) => this.sourceIn(conn, scope, id));
  }

  async createSource(input: CreateConnectorSourceRecord): Promise<ConnectorSourceRecord> {
    try {
      return await this.engine.begin(async (conn) => {
        const existing = await this.sourceIn(conn, input.scope, input.id);
        if (existing !== null) {
          if (configEqual(existing, input)) return existing;
          throw new ConnectorSourceRepositoryError("DUPLICATE", "同一个创建请求对应了不同配置");
        }
        await conn.exec(
          "INSERT INTO onto_document_connector_source " +
            "(id,project_id,owner,provider,name,root_or_prefix,credential_ref,tags,classification," +
            "enabled,revision,cursor,status,created_by,updated_by,created_at,updated_at," +
            "last_started_at,last_completed_at,last_error) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,1,NULL,'idle',?,?,?,?,NULL,NULL,NULL)",
          [
            input.id,
            input.scope.projectId,
            input.scope.owner,
            input.provider,
            input.name,
            input.rootOrPrefix,
            input.credentialRef,
            jsonText(input.tags),
            input.classification,
            input.enabled ? 1 : 0,
            input.actorId,
            input.actorId,
            input.at,
            input.at,
          ],
        );
        return (await this.sourceIn(conn, input.scope, input.id))!;
      });
    } catch (error) {
      if (error instanceof ConnectorSourceRepositoryError) throw error;
      const existing = await this.getSource(input.scope, input.id);
      if (existing !== null && configEqual(existing, input)) return existing;
      throw new ConnectorSourceRepositoryError("DUPLICATE", "这个远端目录已经加入项目");
    }
  }

  async updateSource(input: UpdateConnectorSourceRecord): Promise<ConnectorSourceRecord> {
    return this.engine.begin(async (conn) => {
      const current = await this.sourceIn(conn, input.scope, input.id);
      if (current === null) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
      if (current.status === "archived") {
        throw new ConnectorSourceRepositoryError("INVALID_STATE", "来源已归档，请先恢复");
      }
      if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
      if (current.revision !== input.expectedRevision) {
        if (current.revision === input.expectedRevision + 1 && samePatch(current, input)) return current;
        throw new ConnectorSourceRepositoryError(
          "REVISION_CONFLICT",
          "来源配置刚被其他人修改",
          current.revision,
        );
      }
      const wanted = patchResult(current, input.patch);
      let rows: DbRow[];
      try {
        rows = await conn.all<DbRow>(
          `UPDATE onto_document_connector_source SET provider=?,name=?,root_or_prefix=?,` +
            `credential_ref=?,tags=?,classification=?,enabled=?,revision=revision+1,cursor=NULL,` +
            `status='idle',updated_by=?,updated_at=?,last_error=NULL ` +
            `WHERE project_id=? AND owner=? AND id=? AND revision=? AND status<>'syncing' ` +
            `RETURNING ${COLUMNS}`,
          [
            wanted.provider,
            wanted.name,
            wanted.rootOrPrefix,
            wanted.credentialRef,
            jsonText(wanted.tags),
            wanted.classification,
            wanted.enabled ? 1 : 0,
            input.actorId,
            input.at,
            input.scope.projectId,
            input.scope.owner,
            input.id,
            input.expectedRevision,
          ],
        );
      } catch {
        throw new ConnectorSourceRepositoryError("DUPLICATE", "这个远端目录已经加入项目");
      }
      if (rows[0] === undefined) {
        const actual = await this.sourceIn(conn, input.scope, input.id);
        throw new ConnectorSourceRepositoryError(
          actual?.status === "syncing" ? "BUSY" : "REVISION_CONFLICT",
          actual?.status === "syncing" ? "来源正在同步" : "来源配置刚被其他人修改",
          actual?.revision,
        );
      }
      return rowSource(rows[0]);
    });
  }

  async changeLifecycle(input: ChangeConnectorLifecycle): Promise<ConnectorSourceRecord> {
    return this.engine.begin(async (conn) => {
      const current = await this.sourceIn(conn, input.scope, input.id);
      if (current === null) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
      if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
      if (current.revision !== input.expectedRevision) {
        if (current.revision === input.expectedRevision + 1 && sameLifecycle(current, input.action)) return current;
        throw new ConnectorSourceRepositoryError(
          "REVISION_CONFLICT",
          "来源配置刚被其他人修改",
          current.revision,
        );
      }
      const target = lifecycleTarget(current, input.action);
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document_connector_source SET enabled=?,status=?,revision=revision+1,` +
          `updated_by=?,updated_at=?,last_error=? WHERE project_id=? AND owner=? AND id=? ` +
          `AND revision=? AND status<>'syncing' RETURNING ${COLUMNS}`,
        [
          target.enabled ? 1 : 0,
          target.status,
          input.actorId,
          input.at,
          target.lastError,
          input.scope.projectId,
          input.scope.owner,
          input.id,
          input.expectedRevision,
        ],
      );
      if (rows[0] === undefined) {
        const actual = await this.sourceIn(conn, input.scope, input.id);
        throw new ConnectorSourceRepositoryError(
          actual?.status === "syncing" ? "BUSY" : "REVISION_CONFLICT",
          actual?.status === "syncing" ? "来源正在同步" : "来源配置刚被其他人修改",
          actual?.revision,
        );
      }
      return rowSource(rows[0]);
    });
  }

  async beginSync(
    scope: ConnectorSourceScope,
    id: string,
    expectedRevision: number,
    at: string,
  ): Promise<ConnectorSourceRecord> {
    return this.engine.begin(async (conn) => {
      const current = await this.sourceIn(conn, scope, id);
      if (current === null) throw new ConnectorSourceRepositoryError("NOT_FOUND", "来源不存在");
      if (current.revision !== expectedRevision) {
        throw new ConnectorSourceRepositoryError("REVISION_CONFLICT", "来源配置刚被修改", current.revision);
      }
      if (!current.enabled || current.status === "archived") {
        throw new ConnectorSourceRepositoryError("INVALID_STATE", "来源没有启用");
      }
      if (current.status === "syncing") throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document_connector_source SET status='syncing',last_started_at=?,` +
          `updated_at=?,last_error=NULL WHERE project_id=? AND owner=? AND id=? AND revision=? ` +
          `AND enabled=? AND status<>'archived' AND status<>'syncing' RETURNING ${COLUMNS}`,
        [at, at, scope.projectId, scope.owner, id, expectedRevision, 1],
      );
      if (rows[0] === undefined) throw new ConnectorSourceRepositoryError("BUSY", "来源正在同步");
      return rowSource(rows[0]);
    });
  }

  async get(bindingId: string): Promise<ConnectorBinding | null> {
    return this.engine.connect(async (conn) => {
      const row = await this.sourceById(conn, bindingId);
      return row === null ? null : connectorBindingOf(row);
    });
  }

  async list(projectId: string): Promise<readonly ConnectorBinding[]> {
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        `SELECT ${COLUMNS} FROM onto_document_connector_source WHERE project_id=? ORDER BY id`,
        [projectId],
      );
      return rows.map(rowSource).map(connectorBindingOf);
    });
  }

  async save(binding: ConnectorBinding, expectedRevision?: number): Promise<ConnectorBinding> {
    const current = await this.get(binding.id);
    if (current === null) throw new ConnectorError("INVALID_BINDING", "受管来源必须通过管理服务创建");
    if (expectedRevision !== current.configRevision) {
      throw new ConnectorError("SOURCE_CHANGED", "连接器配置刚被修改，请刷新后重试");
    }
    return current;
  }

  async state(bindingId: string): Promise<ConnectorSyncState> {
    return this.engine.connect(async (conn) => {
      const row = await this.sourceById(conn, bindingId);
      if (row === null) throw new ConnectorError("NOT_FOUND_OR_FORBIDDEN", "连接器不存在");
      return {
        bindingId,
        cursor: row.cursor,
        revision: row.revision,
        lastStartedAt: row.lastStartedAt,
        lastCompletedAt: row.lastCompletedAt,
        lastError: row.lastError,
      };
    });
  }

  async commitCursor(
    bindingId: string,
    expectedRevision: number,
    cursor: string | null,
    completedAt: string,
    continueSync = false,
  ): Promise<ConnectorSyncState> {
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document_connector_source SET cursor=?,status=?,last_completed_at=?,` +
          `updated_at=?,last_error=NULL WHERE id=? AND revision=? RETURNING ${COLUMNS}`,
        [cursor, continueSync ? "syncing" : "idle", completedAt, completedAt, bindingId, expectedRevision],
      );
      if (rows[0] === undefined) throw new ConnectorError("SOURCE_CHANGED", "连接器配置已变化");
      const row = rowSource(rows[0]);
      return {
        bindingId,
        cursor: row.cursor,
        revision: row.revision,
        lastStartedAt: row.lastStartedAt,
        lastCompletedAt: row.lastCompletedAt,
        lastError: row.lastError,
      };
    });
  }

  async recordFailure(
    bindingId: string,
    expectedRevision: number,
    startedAt: string,
    message: string,
  ): Promise<void> {
    await this.engine.begin(async (conn) => {
      await conn.exec(
        "UPDATE onto_document_connector_source SET status='error',last_started_at=?,updated_at=?," +
          "last_error=? WHERE id=? AND revision=?",
        [startedAt, startedAt, safeFailure(message), bindingId, expectedRevision],
      );
    });
  }
}

export function buildConnectorSourceRepository(store: Store): ConnectorSourceRepository {
  return store.engine === null
    ? new MemoryConnectorSourceRepository()
    : new SqlConnectorSourceRepository(store);
}
