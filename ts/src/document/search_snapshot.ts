import { randomUUID } from "node:crypto";

import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { Conn, Store } from "../store/engine.js";
import type { DocumentRepository } from "./repository.js";
import type { DocumentScope } from "./types.js";

export type SearchSnapshotStatus = "active" | "invalidated";
export type SearchSnapshotErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "CURSOR_INVALID"
  | "EXPIRED"
  | "INVALIDATED"
  | "ACL_CHANGED"
  | "INDEX_CHANGED";

export class SearchSnapshotError extends Error {
  constructor(
    readonly code: SearchSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchSnapshotError";
    Object.setPrototypeOf(this, SearchSnapshotError.prototype);
  }
}

export interface SearchSnapshotManifestEntry {
  readonly documentId: string;
  readonly versionId: string;
  readonly indexRevision: string;
  readonly aclRevision: number;
}

export interface SearchSnapshotRecord {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly sessionId: string | null;
  readonly querySha256: string;
  readonly manifest: readonly SearchSnapshotManifestEntry[];
  readonly manifestSha256: string;
  readonly aclRevision: number;
  readonly status: SearchSnapshotStatus;
  readonly invalidatedReason: string;
  readonly totalItems: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SearchSnapshotItem {
  readonly snapshotId: string;
  readonly ordinal: number;
  readonly documentId: string;
  readonly versionId: string;
  readonly chunkId: string;
  readonly indexRevision: string;
  readonly aclRevision: number;
  readonly score: number;
  readonly textSha256: string;
}

export interface NewSearchSnapshot {
  readonly record: SearchSnapshotRecord;
  readonly items: readonly SearchSnapshotItem[];
}

export interface DocumentSearchSnapshotRepository {
  currentAclRevision(scope: DocumentScope): Promise<number>;
  create(input: NewSearchSnapshot): Promise<SearchSnapshotRecord>;
  get(scope: DocumentScope, snapshotId: string): Promise<SearchSnapshotRecord | null>;
  page(
    scope: DocumentScope,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<SearchSnapshotItem[]>;
  invalidate(
    scope: DocumentScope,
    snapshotId: string,
    reason: string,
    now: string,
  ): Promise<SearchSnapshotRecord | null>;
  invalidateVersion(scope: DocumentScope, versionId: string, reason: string, now: string): Promise<number>;
  invalidateScope(scope: DocumentScope, reason: string, now: string): Promise<number>;
  invalidateExpired(now: string): Promise<number>;
}

export type LiveAclRevision = (scope: DocumentScope) => number | Promise<number>;

function assertScope(scope: DocumentScope): void {
  if (!scope.projectId.trim() || !scope.owner.trim()) {
    throw new SearchSnapshotError("INVALID_ARGUMENT", "搜索快照必须绑定已鉴权的项目和用户");
  }
}

function clean(value: string, label: string, max = 2_048): string {
  const result = value.trim();
  if (!result || result.includes("\u0000") || [...result].length > max) {
    throw new SearchSnapshotError("INVALID_ARGUMENT", `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`);
  }
  return result;
}

function cloneRecord(row: SearchSnapshotRecord): SearchSnapshotRecord {
  return { ...row, manifest: row.manifest.map((item) => ({ ...item })) };
}

function cloneItem(row: SearchSnapshotItem): SearchSnapshotItem {
  return { ...row };
}

function scopeKey(scope: DocumentScope): string {
  return `${scope.projectId}\u0000${scope.owner}`;
}

function inScope(scope: DocumentScope, row: SearchSnapshotRecord): boolean {
  return row.projectId === scope.projectId && row.owner === scope.owner;
}

/** 无数据库部署的退化实现；还可在测试里显式推进 ACL revision。 */
export class MemoryDocumentSearchSnapshotRepository implements DocumentSearchSnapshotRepository {
  private readonly snapshots = new Map<string, SearchSnapshotRecord>();
  private readonly items = new Map<string, SearchSnapshotItem[]>();
  private readonly acl = new Map<string, number>();

  constructor(
    private readonly liveAclRevision?: LiveAclRevision,
  ) {}

  setAclRevision(scope: DocumentScope, revision: number): void {
    assertScope(scope);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new SearchSnapshotError("INVALID_ARGUMENT", "ACL revision 必须是非负整数");
    }
    this.acl.set(scopeKey(scope), revision);
  }

  async currentAclRevision(scope: DocumentScope): Promise<number> {
    assertScope(scope);
    if (this.liveAclRevision !== undefined) {
      const revision = await this.liveAclRevision(scope);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new SearchSnapshotError("ACL_CHANGED", "实时 ACL revision 无效，已拒绝读取快照");
      }
      return revision;
    }
    return this.acl.get(scopeKey(scope)) ?? 0;
  }

  async create(input: NewSearchSnapshot): Promise<SearchSnapshotRecord> {
    const scope = { projectId: input.record.projectId, owner: input.record.owner };
    assertScope(scope);
    if ((await this.currentAclRevision(scope)) !== input.record.aclRevision) {
      throw new SearchSnapshotError("ACL_CHANGED", "创建搜索快照时项目权限发生了变化，请重新搜索");
    }
    if (this.snapshots.has(input.record.id)) {
      throw new SearchSnapshotError("INVALID_ARGUMENT", "搜索快照 ID 已存在");
    }
    this.snapshots.set(input.record.id, cloneRecord(input.record));
    this.items.set(input.record.id, input.items.map(cloneItem));
    return cloneRecord(input.record);
  }

  async get(scope: DocumentScope, snapshotId: string): Promise<SearchSnapshotRecord | null> {
    assertScope(scope);
    const row = this.snapshots.get(snapshotId);
    return row !== undefined && inScope(scope, row) ? cloneRecord(row) : null;
  }

  async page(
    scope: DocumentScope,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<SearchSnapshotItem[]> {
    if ((await this.get(scope, snapshotId)) === null) return [];
    return (this.items.get(snapshotId) ?? []).slice(offset, offset + limit).map(cloneItem);
  }

  async invalidate(
    scope: DocumentScope,
    snapshotId: string,
    reason: string,
    now: string,
  ): Promise<SearchSnapshotRecord | null> {
    const row = await this.get(scope, snapshotId);
    if (row === null) return null;
    if (row.status === "invalidated") return row;
    const next = { ...row, status: "invalidated" as const, invalidatedReason: reason, updatedAt: now };
    this.snapshots.set(snapshotId, next);
    return cloneRecord(next);
  }

  async invalidateVersion(
    scope: DocumentScope,
    versionId: string,
    reason: string,
    now: string,
  ): Promise<number> {
    let count = 0;
    for (const row of this.snapshots.values()) {
      if (
        inScope(scope, row) &&
        row.status === "active" &&
        row.manifest.some((entry) => entry.versionId === versionId)
      ) {
        await this.invalidate(scope, row.id, reason, now);
        count += 1;
      }
    }
    return count;
  }

  async invalidateScope(scope: DocumentScope, reason: string, now: string): Promise<number> {
    let count = 0;
    for (const row of this.snapshots.values()) {
      if (inScope(scope, row) && row.status === "active") {
        await this.invalidate(scope, row.id, reason, now);
        count += 1;
      }
    }
    return count;
  }

  async invalidateExpired(now: string): Promise<number> {
    let count = 0;
    for (const row of this.snapshots.values()) {
      if (row.status === "active" && row.expiresAt <= now) {
        await this.invalidate(
          { projectId: row.projectId, owner: row.owner },
          row.id,
          "expired",
          now,
        );
        count += 1;
      }
    }
    return count;
  }
}

type DbRow = Record<string, unknown>;

const SNAPSHOT_COLUMNS =
  "id,project_id,owner,session_id,query_sha256,manifest,manifest_sha256,acl_revision,status," +
  "invalidated_reason,total_items,expires_at,created_at,updated_at";
const ITEM_COLUMNS =
  "snapshot_id,ordinal,document_id,version_id,chunk_id,index_revision,acl_revision,score,text_sha256";

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return value === null || value === undefined ? fallback : (value as T);
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? "");
  const parsed = new Date(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/u.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function rowSnapshot(row: DbRow): SearchSnapshotRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    owner: String(row["owner"]),
    sessionId: row["session_id"] === null ? null : String(row["session_id"]),
    querySha256: String(row["query_sha256"]),
    manifest: jsonValue<readonly SearchSnapshotManifestEntry[]>(row["manifest"], []).map((entry) => ({
      documentId: String(entry.documentId),
      versionId: String(entry.versionId),
      indexRevision: String(entry.indexRevision),
      aclRevision: Number(entry.aclRevision),
    })),
    manifestSha256: String(row["manifest_sha256"]),
    aclRevision: Number(row["acl_revision"]),
    status: String(row["status"]) as SearchSnapshotStatus,
    invalidatedReason: String(row["invalidated_reason"]),
    totalItems: Number(row["total_items"]),
    expiresAt: dateText(row["expires_at"]),
    createdAt: dateText(row["created_at"]),
    updatedAt: dateText(row["updated_at"]),
  };
}

function rowItem(row: DbRow): SearchSnapshotItem {
  return {
    snapshotId: String(row["snapshot_id"]),
    ordinal: Number(row["ordinal"]),
    documentId: String(row["document_id"]),
    versionId: String(row["version_id"]),
    chunkId: String(row["chunk_id"]),
    indexRevision: String(row["index_revision"]),
    aclRevision: Number(row["acl_revision"]),
    score: Number(row["score"]),
    textSha256: String(row["text_sha256"]),
  };
}

async function selectSnapshot(
  conn: Conn,
  scope: DocumentScope,
  snapshotId: string,
): Promise<SearchSnapshotRecord | null> {
  const rows = await conn.all<DbRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM onto_document_search_snapshot ` +
      "WHERE id=? AND project_id=? AND owner=?",
    [snapshotId, scope.projectId, scope.owner],
  );
  return rows[0] === undefined ? null : rowSnapshot(rows[0]);
}

export class SqlDocumentSearchSnapshotRepository implements DocumentSearchSnapshotRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) {
      throw new Error("SqlDocumentSearchSnapshotRepository 需要启用数据库的 Store");
    }
  }

  private get engine() {
    return this.store.engine!;
  }

  async currentAclRevision(scope: DocumentScope): Promise<number> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const value = await conn.scalar(
        "SELECT revision FROM onto_document_acl_state WHERE project_id=? AND owner=?",
        [scope.projectId, scope.owner],
      );
      return Math.trunc(Number(value ?? 0));
    });
  }

  async create(input: NewSearchSnapshot): Promise<SearchSnapshotRecord> {
    const scope = { projectId: input.record.projectId, owner: input.record.owner };
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const revision = await conn.scalar(
        "SELECT revision FROM onto_document_acl_state WHERE project_id=? AND owner=?",
        [scope.projectId, scope.owner],
      );
      if (Math.trunc(Number(revision ?? 0)) !== input.record.aclRevision) {
        throw new SearchSnapshotError("ACL_CHANGED", "创建搜索快照时项目权限发生了变化，请重新搜索");
      }
      const r = input.record;
      await conn.exec(
        "INSERT INTO onto_document_search_snapshot " +
          `(${SNAPSHOT_COLUMNS}) VALUES (${SNAPSHOT_COLUMNS.split(",").map(() => "?").join(",")})`,
        [
          r.id,
          r.projectId,
          r.owner,
          r.sessionId,
          r.querySha256,
          jsonText(r.manifest),
          r.manifestSha256,
          r.aclRevision,
          r.status,
          r.invalidatedReason,
          r.totalItems,
          r.expiresAt,
          r.createdAt,
          r.updatedAt,
        ],
      );
      for (const item of input.items) {
        await conn.exec(
          "INSERT INTO onto_document_search_snapshot_item " +
            `(${ITEM_COLUMNS}) VALUES (${ITEM_COLUMNS.split(",").map(() => "?").join(",")})`,
          [
            item.snapshotId,
            item.ordinal,
            item.documentId,
            item.versionId,
            item.chunkId,
            item.indexRevision,
            item.aclRevision,
            item.score,
            item.textSha256,
          ],
        );
      }
      return (await selectSnapshot(conn, scope, r.id))!;
    });
  }

  async get(scope: DocumentScope, snapshotId: string): Promise<SearchSnapshotRecord | null> {
    assertScope(scope);
    return this.engine.connect((conn) => selectSnapshot(conn, scope, snapshotId));
  }

  async page(
    scope: DocumentScope,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<SearchSnapshotItem[]> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      if ((await selectSnapshot(conn, scope, snapshotId)) === null) return [];
      const rows = await conn.all<DbRow>(
        `SELECT ${ITEM_COLUMNS} FROM onto_document_search_snapshot_item ` +
          "WHERE snapshot_id=? AND ordinal>=? ORDER BY ordinal ASC LIMIT ?",
        [snapshotId, offset, limit],
      );
      return rows.map(rowItem);
    });
  }

  async invalidate(
    scope: DocumentScope,
    snapshotId: string,
    reason: string,
    now: string,
  ): Promise<SearchSnapshotRecord | null> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_search_snapshot SET status='invalidated',invalidated_reason=?,updated_at=? " +
          "WHERE id=? AND project_id=? AND owner=? AND status='active' " +
          `RETURNING ${SNAPSHOT_COLUMNS}`,
        [reason, now, snapshotId, scope.projectId, scope.owner],
      );
      return rows[0] === undefined ? selectSnapshot(conn, scope, snapshotId) : rowSnapshot(rows[0]);
    });
  }

  async invalidateVersion(
    scope: DocumentScope,
    versionId: string,
    reason: string,
    now: string,
  ): Promise<number> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<{ id: string }>(
        "UPDATE onto_document_search_snapshot SET status='invalidated',invalidated_reason=?,updated_at=? " +
          "WHERE project_id=? AND owner=? AND status='active' AND id IN " +
          "(SELECT snapshot_id FROM onto_document_search_snapshot_item WHERE version_id=?) RETURNING id",
        [reason, now, scope.projectId, scope.owner, versionId],
      );
      return rows.length;
    });
  }

  async invalidateScope(scope: DocumentScope, reason: string, now: string): Promise<number> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<{ id: string }>(
        "UPDATE onto_document_search_snapshot SET status='invalidated',invalidated_reason=?,updated_at=? " +
          "WHERE project_id=? AND owner=? AND status='active' RETURNING id",
        [reason, now, scope.projectId, scope.owner],
      );
      return rows.length;
    });
  }

  async invalidateExpired(now: string): Promise<number> {
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<{ id: string }>(
        "UPDATE onto_document_search_snapshot SET status='invalidated',invalidated_reason='expired'," +
          "updated_at=? WHERE status='active' AND expires_at<=? RETURNING id",
        [now, now],
      );
      return rows.length;
    });
  }
}

export function buildDocumentSearchSnapshotRepository(
  store: Store,
  liveAclRevision?: LiveAclRevision,
): DocumentSearchSnapshotRepository {
  return store.mode === "memory"
    ? new MemoryDocumentSearchSnapshotRepository(liveAclRevision)
    : new SqlDocumentSearchSnapshotRepository(store);
}

export interface CreateSearchSnapshotPin {
  readonly documentId: string;
  readonly versionId: string;
  readonly indexRevision: string;
}

export interface CreateSearchSnapshotItem {
  readonly documentId: string;
  readonly versionId: string;
  readonly chunkId: string;
  readonly score: number;
}

export interface CreateSearchSnapshotInput {
  readonly query: string;
  readonly pins: readonly CreateSearchSnapshotPin[];
  readonly items: readonly CreateSearchSnapshotItem[];
  readonly sessionId?: string;
  readonly ttlMs?: number;
}

export interface ReadSearchSnapshotPageInput {
  readonly snapshotId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchSnapshotPage {
  readonly snapshotId: string;
  readonly manifestSha256: string;
  readonly aclRevision: number;
  readonly totalItems: number;
  readonly items: readonly SearchSnapshotItem[];
  readonly nextCursor: string | null;
  readonly expiresAt: string;
}

export interface DocumentSearchSnapshotServiceOptions {
  readonly repository: DocumentSearchSnapshotRepository;
  readonly documents: DocumentRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface CursorEnvelope {
  readonly v: 1;
  readonly snapshot: string;
  readonly offset: number;
  readonly manifest: string;
}

function encodeCursor(value: CursorEnvelope): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorEnvelope {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    if (
      parsed.v !== 1 ||
      typeof parsed.snapshot !== "string" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset! < 0 ||
      typeof parsed.manifest !== "string"
    ) {
      throw new Error("shape");
    }
    return parsed as CursorEnvelope;
  } catch {
    throw new SearchSnapshotError("CURSOR_INVALID", "搜索翻页游标无效，请重新搜索");
  }
}

/** 固定 exact version/index/ACL revision，并提供稳定、可失效的分页游标。 */
export class DocumentSearchSnapshotService {
  private readonly repository: DocumentSearchSnapshotRepository;
  private readonly documents: DocumentRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: DocumentSearchSnapshotServiceOptions) {
    this.repository = options.repository;
    this.documents = options.documents;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `dss_${randomUUID().replaceAll("-", "")}`);
  }

  async create(scope: DocumentScope, input: CreateSearchSnapshotInput): Promise<SearchSnapshotRecord> {
    assertScope(scope);
    const query = clean(input.query, "搜索内容", 4_000);
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
      throw new SearchSnapshotError("INVALID_ARGUMENT", "ttlMs 必须在 1 秒到 24 小时之间");
    }
    if (input.pins.length > 2_000 || input.items.length > 10_000) {
      throw new SearchSnapshotError("INVALID_ARGUMENT", "一次快照最多固定 2000 个版本和 10000 条命中");
    }
    const aclRevision = await this.repository.currentAclRevision(scope);
    const manifest: SearchSnapshotManifestEntry[] = [];
    const pinByVersion = new Map<string, SearchSnapshotManifestEntry>();
    for (const raw of input.pins) {
      const documentId = clean(raw.documentId, "文档 ID");
      const versionId = clean(raw.versionId, "版本 ID");
      const indexRevision = clean(raw.indexRevision, "索引版本", 512);
      if (pinByVersion.has(versionId)) {
        throw new SearchSnapshotError("INVALID_ARGUMENT", `版本 ${versionId} 在快照清单中重复`);
      }
      const version = await this.documents.getVersion(scope, documentId, versionId);
      if (version === null || version.indexRevision !== indexRevision) {
        throw new SearchSnapshotError("INDEX_CHANGED", "创建快照前文档版本或索引已经变化，请重新搜索");
      }
      const pin = { documentId, versionId, indexRevision, aclRevision };
      manifest.push(pin);
      pinByVersion.set(versionId, pin);
    }
    manifest.sort(
      (a, b) => a.documentId.localeCompare(b.documentId) || a.versionId.localeCompare(b.versionId),
    );

    const snapshotId = this.newId();
    const items: SearchSnapshotItem[] = [];
    const seen = new Set<string>();
    for (let ordinal = 0; ordinal < input.items.length; ordinal += 1) {
      const raw = input.items[ordinal]!;
      const documentId = clean(raw.documentId, "命中文档 ID");
      const versionId = clean(raw.versionId, "命中版本 ID");
      const chunkId = clean(raw.chunkId, "命中切片 ID", 4_096);
      if (!Number.isFinite(raw.score)) {
        throw new SearchSnapshotError("INVALID_ARGUMENT", "搜索命中分数必须是有限数");
      }
      const pin = pinByVersion.get(versionId);
      if (pin === undefined || pin.documentId !== documentId) {
        throw new SearchSnapshotError("INVALID_ARGUMENT", "搜索命中没有对应的精确版本清单");
      }
      const key = `${versionId}\u0000${chunkId}`;
      if (seen.has(key)) throw new SearchSnapshotError("INVALID_ARGUMENT", "同一切片不能重复进入搜索快照");
      seen.add(key);
      const source = await this.documents.getChunk(scope, documentId, versionId, chunkId);
      if (source === null || source.version.indexRevision !== pin.indexRevision) {
        throw new SearchSnapshotError("INDEX_CHANGED", "搜索命中指向的切片或索引已经变化，请重新搜索");
      }
      items.push({
        snapshotId,
        ordinal,
        documentId,
        versionId,
        chunkId,
        indexRevision: pin.indexRevision,
        aclRevision,
        score: raw.score,
        textSha256: source.chunk.textSha256,
      });
    }

    const created = this.now();
    const manifestSha256 = sha256Hex(canonicalJson(manifest));
    const record: SearchSnapshotRecord = {
      id: snapshotId,
      projectId: scope.projectId,
      owner: scope.owner,
      sessionId: input.sessionId === undefined ? null : clean(input.sessionId, "会话 ID", 512),
      querySha256: sha256Hex(query),
      manifest,
      manifestSha256,
      aclRevision,
      status: "active",
      invalidatedReason: "",
      totalItems: items.length,
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
    };
    return this.repository.create({ record, items });
  }

  async page(scope: DocumentScope, input: ReadSearchSnapshotPageInput): Promise<SearchSnapshotPage> {
    assertScope(scope);
    const snapshotId = clean(input.snapshotId, "搜索快照 ID");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SearchSnapshotError("INVALID_ARGUMENT", "limit 必须是 1 到 100 的整数");
    }
    const record = await this.repository.get(scope, snapshotId);
    if (record === null) throw new SearchSnapshotError("NOT_FOUND", "没有找到这个搜索快照");
    if (record.status !== "active") {
      throw new SearchSnapshotError("INVALIDATED", "这个搜索结果已经失效，请重新搜索");
    }
    const now = this.now().toISOString();
    if (record.expiresAt <= now) {
      await this.repository.invalidate(scope, snapshotId, "expired", now);
      throw new SearchSnapshotError("EXPIRED", "这个搜索结果已经过期，请重新搜索");
    }
    const currentAcl = await this.repository.currentAclRevision(scope);
    if (currentAcl !== record.aclRevision) {
      await this.repository.invalidate(scope, snapshotId, "acl_revision_changed", now);
      throw new SearchSnapshotError("ACL_CHANGED", "项目权限已经变化，请重新搜索");
    }
    for (const pin of record.manifest) {
      const version = await this.documents.getVersion(scope, pin.documentId, pin.versionId);
      if (version === null || version.indexRevision !== pin.indexRevision) {
        await this.repository.invalidate(scope, snapshotId, "version_or_index_changed", now);
        throw new SearchSnapshotError("INDEX_CHANGED", "文档版本或索引已经变化，请重新搜索");
      }
    }

    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      if (
        cursor.snapshot !== snapshotId ||
        cursor.manifest !== record.manifestSha256 ||
        cursor.offset > record.totalItems
      ) {
        throw new SearchSnapshotError("CURSOR_INVALID", "搜索翻页游标不属于当前结果，请重新搜索");
      }
      offset = cursor.offset;
    }
    const items = await this.repository.page(scope, snapshotId, offset, limit);
    const expectedItems = Math.min(limit, Math.max(0, record.totalItems - offset));
    if (items.length !== expectedItems) {
      await this.repository.invalidate(scope, snapshotId, "snapshot_items_missing", now);
      throw new SearchSnapshotError("INDEX_CHANGED", "搜索快照内容不完整，请重新搜索");
    }
    for (const item of items) {
      const pin = record.manifest.find((entry) => entry.versionId === item.versionId);
      const source = await this.documents.getChunk(
        scope,
        item.documentId,
        item.versionId,
        item.chunkId,
      );
      if (
        pin === undefined ||
        pin.documentId !== item.documentId ||
        pin.indexRevision !== item.indexRevision ||
        item.aclRevision !== record.aclRevision ||
        source === null ||
        source.version.indexRevision !== item.indexRevision ||
        source.chunk.textSha256 !== item.textSha256
      ) {
        await this.repository.invalidate(scope, snapshotId, "snapshot_item_mismatch", now);
        throw new SearchSnapshotError("INDEX_CHANGED", "搜索快照内容校验失败，请重新搜索");
      }
    }
    // ACL 可在读取 items 的窗口中改变；返回 cursor 前再查一次，撤权必须 fail closed。
    if ((await this.repository.currentAclRevision(scope)) !== record.aclRevision) {
      await this.repository.invalidate(scope, snapshotId, "acl_revision_changed", this.now().toISOString());
      throw new SearchSnapshotError("ACL_CHANGED", "项目权限已经变化，请重新搜索");
    }
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < record.totalItems
      ? encodeCursor({ v: 1, snapshot: snapshotId, offset: nextOffset, manifest: record.manifestSha256 })
      : null;
    return {
      snapshotId,
      manifestSha256: record.manifestSha256,
      aclRevision: record.aclRevision,
      totalItems: record.totalItems,
      items,
      nextCursor,
      expiresAt: record.expiresAt,
    };
  }

  async invalidateVersion(scope: DocumentScope, versionId: string, reason = "version_invalidated"): Promise<number> {
    return this.repository.invalidateVersion(
      scope,
      clean(versionId, "版本 ID"),
      clean(reason, "失效原因", 512),
      this.now().toISOString(),
    );
  }

  async invalidateScope(scope: DocumentScope, reason = "scope_invalidated"): Promise<number> {
    return this.repository.invalidateScope(
      scope,
      clean(reason, "失效原因", 512),
      this.now().toISOString(),
    );
  }

  invalidateExpired(): Promise<number> {
    return this.repository.invalidateExpired(this.now().toISOString());
  }
}
