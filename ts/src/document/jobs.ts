import { randomUUID } from "node:crypto";

import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { Conn, Store } from "../store/engine.js";
import type { DocumentRepository } from "./repository.js";
import type { DocumentScope, StoredDocumentVersion } from "./types.js";

export type DocumentJobKind = "parse" | "ocr";
export type DocumentJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DocumentJobErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "LEASE_LOST"
  | "TARGET_CHANGED";

export class DocumentJobError extends Error {
  constructor(
    readonly code: DocumentJobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentJobError";
    Object.setPrototypeOf(this, DocumentJobError.prototype);
  }
}

export class DocumentJobWorkerError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "DocumentJobWorkerError";
    Object.setPrototypeOf(this, DocumentJobWorkerError.prototype);
  }
}

export interface DocumentJobRecord {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly kind: DocumentJobKind;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly sourceSha256: string;
  readonly expectedIndexRevision: string;
  readonly input: unknown;
  readonly status: DocumentJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly result: unknown;
  readonly resultSha256: string;
  readonly lastError: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface NewDocumentJob {
  readonly id: string;
  readonly scope: DocumentScope;
  readonly documentId: string;
  readonly versionId: string;
  readonly kind: DocumentJobKind;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly sourceSha256: string;
  readonly expectedIndexRevision: string;
  readonly input: unknown;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface DocumentJobFailureUpdate {
  readonly error: string;
  /** null 表示永久失败；否则回到 queued，并在该时刻之后才能重新领取。 */
  readonly retryAt: string | null;
}

export interface DocumentJobListOptions {
  readonly status?: DocumentJobStatus;
  readonly kind?: DocumentJobKind;
  readonly documentId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DocumentJobRepository {
  enqueue(input: NewDocumentJob): Promise<DocumentJobRecord>;
  get(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null>;
  list(scope: DocumentScope, options?: DocumentJobListOptions): Promise<DocumentJobRecord[]>;
  claim(input: {
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null>;
  heartbeat(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null>;
  succeed(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly result: unknown;
    readonly resultSha256: string;
  }): Promise<DocumentJobRecord | null>;
  fail(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly failure: DocumentJobFailureUpdate;
  }): Promise<DocumentJobRecord | null>;
  cancel(scope: DocumentScope, jobId: string, now: string): Promise<DocumentJobRecord | null>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneJob(row: DocumentJobRecord): DocumentJobRecord {
  return { ...row, input: clone(row.input), result: clone(row.result) };
}

function assertScope(scope: DocumentScope): void {
  if (!scope.projectId.trim() || !scope.owner.trim()) {
    throw new DocumentJobError("INVALID_ARGUMENT", "文档任务必须绑定已鉴权的项目和用户");
  }
}

function text(value: string, label: string, max = 512): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.includes("\u0000") || [...cleaned].length > max) {
    throw new DocumentJobError("INVALID_ARGUMENT", `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`);
  }
  return cleaned;
}

function iso(value: string, label: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new DocumentJobError("INVALID_ARGUMENT", `${label}不是有效时间`);
  return new Date(time).toISOString();
}

function jsonDigest(value: unknown, label: string): string {
  try {
    return sha256Hex(canonicalJson(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DocumentJobError("INVALID_ARGUMENT", `${label}必须是可持久化的 JSON 数据：${detail}`);
  }
}

function scopeKey(scope: DocumentScope, suffix: string): string {
  return `${scope.projectId}\u0000${scope.owner}\u0000${suffix}`;
}

function jobScope(row: DocumentJobRecord): DocumentScope {
  return { projectId: row.projectId, owner: row.owner };
}

interface NormalizedJobListOptions {
  readonly status?: DocumentJobStatus;
  readonly kind?: DocumentJobKind;
  readonly documentId?: string;
  readonly limit: number;
  readonly offset: number;
}

function normalizedListOptions(options: DocumentJobListOptions = {}): NormalizedJobListOptions {
  if (
    options.status !== undefined &&
    options.status !== "queued" &&
    options.status !== "running" &&
    options.status !== "succeeded" &&
    options.status !== "failed" &&
    options.status !== "cancelled"
  ) {
    throw new DocumentJobError("INVALID_ARGUMENT", "任务状态过滤条件无效");
  }
  if (options.kind !== undefined && options.kind !== "parse" && options.kind !== "ocr") {
    throw new DocumentJobError("INVALID_ARGUMENT", "任务类型过滤条件只能是 parse 或 ocr");
  }
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  // facade 为了判断下一页会读取 limit+1，因此仓储上限为 101；面向用户的上限仍为 100。
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
    throw new DocumentJobError("INVALID_ARGUMENT", "limit 必须是 1 到 101 的整数");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new DocumentJobError("INVALID_ARGUMENT", "offset 必须是 0 到 1000000 的整数");
  }
  const documentId = options.documentId === undefined
    ? undefined
    : text(options.documentId, "文档 ID", 2_048);
  return {
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(documentId === undefined ? {} : { documentId }),
    limit,
    offset,
  };
}

function leaseStillOwned(row: DocumentJobRecord, token: string, now: string): boolean {
  return (
    row.status === "running" &&
    row.leaseToken === token &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > now
  );
}

/** 无数据库部署的显式退化实现；生产 SQLite/Postgres 使用下面的 SQL 仓储。 */
export class MemoryDocumentJobRepository implements DocumentJobRepository {
  private readonly jobs = new Map<string, DocumentJobRecord>();
  private readonly byIdempotency = new Map<string, string>();

  async enqueue(input: NewDocumentJob): Promise<DocumentJobRecord> {
    assertScope(input.scope);
    const key = scopeKey(input.scope, input.idempotencyKey);
    const existingId = this.byIdempotency.get(key);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId)!;
      if (existing.requestSha256 !== input.requestSha256) {
        throw new DocumentJobError(
          "IDEMPOTENCY_CONFLICT",
          "这个任务幂等键已经用于另一组输入，请换一个幂等键",
        );
      }
      return cloneJob(existing);
    }
    if (this.jobs.has(input.id)) throw new DocumentJobError("IDEMPOTENCY_CONFLICT", "任务 ID 已存在");
    const row: DocumentJobRecord = {
      id: input.id,
      projectId: input.scope.projectId,
      owner: input.scope.owner,
      documentId: input.documentId,
      versionId: input.versionId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      requestSha256: input.requestSha256,
      sourceSha256: input.sourceSha256,
      expectedIndexRevision: input.expectedIndexRevision,
      input: clone(input.input),
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      availableAt: input.availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      result: {},
      resultSha256: "",
      lastError: "",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.jobs.set(row.id, row);
    this.byIdempotency.set(key, row.id);
    return cloneJob(row);
  }

  async get(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    assertScope(scope);
    const row = this.jobs.get(jobId);
    return row?.projectId === scope.projectId && row.owner === scope.owner ? cloneJob(row) : null;
  }

  async list(
    scope: DocumentScope,
    options: DocumentJobListOptions = {},
  ): Promise<DocumentJobRecord[]> {
    assertScope(scope);
    const normalized = normalizedListOptions(options);
    return [...this.jobs.values()]
      .filter(
        (row) =>
          row.projectId === scope.projectId &&
          row.owner === scope.owner &&
          (normalized.status === undefined || row.status === normalized.status) &&
          (normalized.kind === undefined || row.kind === normalized.kind) &&
          (normalized.documentId === undefined || row.documentId === normalized.documentId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(normalized.offset, normalized.offset + normalized.limit)
      .map(cloneJob);
  }

  async claim(input: {
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null> {
    for (const row of this.jobs.values()) {
      if (
        row.status === "running" &&
        row.leaseExpiresAt !== null &&
        row.leaseExpiresAt <= input.now &&
        row.attempts >= row.maxAttempts
      ) {
        this.jobs.set(row.id, {
          ...row,
          status: "failed",
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: row.lastError || "任务租约过期，且重试次数已经用完",
          completedAt: input.now,
          updatedAt: input.now,
        });
      }
    }
    const eligible = [...this.jobs.values()]
      .filter(
        (row) =>
          row.attempts < row.maxAttempts &&
          ((row.status === "queued" && row.availableAt <= input.now) ||
            (row.status === "running" &&
              row.leaseExpiresAt !== null &&
              row.leaseExpiresAt <= input.now)),
      )
      .sort(
        (a, b) =>
          a.availableAt.localeCompare(b.availableAt) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const row = eligible[0];
    if (row === undefined) return null;
    const claimed: DocumentJobRecord = {
      ...row,
      status: "running",
      attempts: row.attempts + 1,
      leaseOwner: input.workerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      startedAt: row.startedAt ?? input.now,
      completedAt: null,
      updatedAt: input.now,
    };
    this.jobs.set(row.id, claimed);
    return cloneJob(claimed);
  }

  async heartbeat(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null> {
    const row = this.jobs.get(input.jobId);
    if (row === undefined || !leaseStillOwned(row, input.leaseToken, input.now)) return null;
    const next = { ...row, leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now };
    this.jobs.set(row.id, next);
    return cloneJob(next);
  }

  async succeed(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly result: unknown;
    readonly resultSha256: string;
  }): Promise<DocumentJobRecord | null> {
    const row = this.jobs.get(input.jobId);
    if (row === undefined || !leaseStillOwned(row, input.leaseToken, input.now)) return null;
    const next: DocumentJobRecord = {
      ...row,
      status: "succeeded",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      result: clone(input.result),
      resultSha256: input.resultSha256,
      lastError: "",
      completedAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.set(row.id, next);
    return cloneJob(next);
  }

  async fail(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly failure: DocumentJobFailureUpdate;
  }): Promise<DocumentJobRecord | null> {
    const row = this.jobs.get(input.jobId);
    if (row === undefined || !leaseStillOwned(row, input.leaseToken, input.now)) return null;
    const retry = input.failure.retryAt !== null && row.attempts < row.maxAttempts;
    const next: DocumentJobRecord = {
      ...row,
      status: retry ? "queued" : "failed",
      availableAt: retry ? input.failure.retryAt! : row.availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: input.failure.error,
      completedAt: retry ? null : input.now,
      updatedAt: input.now,
    };
    this.jobs.set(row.id, next);
    return cloneJob(next);
  }

  async cancel(scope: DocumentScope, jobId: string, now: string): Promise<DocumentJobRecord | null> {
    const row = await this.get(scope, jobId);
    if (row === null) return null;
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") return row;
    const next: DocumentJobRecord = {
      ...row,
      status: "cancelled",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, next);
    return cloneJob(next);
  }
}

type DbRow = Record<string, unknown>;

const JOB_COLUMNS =
  "id,project_id,owner,document_id,version_id,kind,idempotency_key,request_sha256," +
  "source_sha256,expected_index_revision,input,status,attempts,max_attempts,available_at," +
  "lease_owner,lease_token,lease_expires_at,result,result_sha256,last_error,created_at,updated_at," +
  "started_at,completed_at";

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value);
  const parsed = new Date(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/u.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function rowJob(row: DbRow): DocumentJobRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    owner: String(row["owner"]),
    documentId: String(row["document_id"]),
    versionId: String(row["version_id"]),
    kind: String(row["kind"]) as DocumentJobKind,
    idempotencyKey: String(row["idempotency_key"]),
    requestSha256: String(row["request_sha256"]),
    sourceSha256: String(row["source_sha256"]),
    expectedIndexRevision: String(row["expected_index_revision"]),
    input: jsonValue(row["input"]),
    status: String(row["status"]) as DocumentJobStatus,
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    availableAt: dateText(row["available_at"])!,
    leaseOwner: row["lease_owner"] === null ? null : String(row["lease_owner"]),
    leaseToken: row["lease_token"] === null ? null : String(row["lease_token"]),
    leaseExpiresAt: dateText(row["lease_expires_at"]),
    result: jsonValue(row["result"]),
    resultSha256: String(row["result_sha256"]),
    lastError: String(row["last_error"]),
    createdAt: dateText(row["created_at"])!,
    updatedAt: dateText(row["updated_at"])!,
    startedAt: dateText(row["started_at"]),
    completedAt: dateText(row["completed_at"]),
  };
}

async function selectJob(conn: Conn, clause: string, params: readonly (string | number)[]): Promise<DocumentJobRecord | null> {
  const rows = await conn.all<DbRow>(`SELECT ${JOB_COLUMNS} FROM onto_document_job WHERE ${clause}`, params);
  return rows[0] === undefined ? null : rowJob(rows[0]);
}

export class SqlDocumentJobRepository implements DocumentJobRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlDocumentJobRepository 需要启用数据库的 Store");
  }

  private get engine() {
    return this.store.engine!;
  }

  private byIdempotency(input: NewDocumentJob): Promise<DocumentJobRecord | null> {
    return this.engine.connect((conn) =>
      selectJob(conn, "project_id=? AND owner=? AND idempotency_key=?", [
        input.scope.projectId,
        input.scope.owner,
        input.idempotencyKey,
      ]),
    );
  }

  async enqueue(input: NewDocumentJob): Promise<DocumentJobRecord> {
    assertScope(input.scope);
    const existing = await this.byIdempotency(input);
    if (existing !== null) return this.sameRequest(existing, input);
    try {
      return await this.engine.begin(async (conn) => {
        await conn.exec(
          "INSERT INTO onto_document_job " +
            `(${JOB_COLUMNS}) VALUES (${JOB_COLUMNS.split(",").map(() => "?").join(",")})`,
          [
            input.id,
            input.scope.projectId,
            input.scope.owner,
            input.documentId,
            input.versionId,
            input.kind,
            input.idempotencyKey,
            input.requestSha256,
            input.sourceSha256,
            input.expectedIndexRevision,
            jsonText(input.input),
            "queued",
            0,
            input.maxAttempts,
            input.availableAt,
            null,
            null,
            null,
            jsonText({}),
            "",
            "",
            input.createdAt,
            input.createdAt,
            null,
            null,
          ],
        );
        return (await selectJob(conn, "id=?", [input.id]))!;
      });
    } catch (error) {
      const raced = await this.byIdempotency(input);
      if (raced !== null) return this.sameRequest(raced, input);
      throw error;
    }
  }

  private sameRequest(existing: DocumentJobRecord, input: NewDocumentJob): DocumentJobRecord {
    if (existing.requestSha256 !== input.requestSha256) {
      throw new DocumentJobError(
        "IDEMPOTENCY_CONFLICT",
        "这个任务幂等键已经用于另一组输入，请换一个幂等键",
      );
    }
    return existing;
  }

  async get(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    assertScope(scope);
    return this.engine.connect((conn) =>
      selectJob(conn, "id=? AND project_id=? AND owner=?", [jobId, scope.projectId, scope.owner]),
    );
  }

  async list(
    scope: DocumentScope,
    options: DocumentJobListOptions = {},
  ): Promise<DocumentJobRecord[]> {
    assertScope(scope);
    const normalized = normalizedListOptions(options);
    const clauses = ["project_id=?", "owner=?"];
    const params: Array<string | number> = [scope.projectId, scope.owner];
    if (normalized.status !== undefined) {
      clauses.push("status=?");
      params.push(normalized.status);
    }
    if (normalized.kind !== undefined) {
      clauses.push("kind=?");
      params.push(normalized.kind);
    }
    if (normalized.documentId !== undefined) {
      clauses.push("document_id=?");
      params.push(normalized.documentId);
    }
    params.push(normalized.limit, normalized.offset);
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        `SELECT ${JOB_COLUMNS} FROM onto_document_job WHERE ${clauses.join(" AND ")} ` +
          "ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
        params,
      );
      return rows.map(rowJob);
    });
  }

  async claim(input: {
    readonly workerId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null> {
    return this.engine.begin(async (conn) => {
      await conn.exec(
        "UPDATE onto_document_job SET status='failed',lease_owner=NULL,lease_token=NULL," +
          "lease_expires_at=NULL,last_error=CASE WHEN last_error='' THEN ? ELSE last_error END," +
          "completed_at=?,updated_at=? WHERE status='running' AND lease_expires_at<=? " +
          "AND attempts>=max_attempts",
        ["任务租约过期，且重试次数已经用完", input.now, input.now, input.now],
      );
      const eligible =
        "((status='queued' AND available_at<=?) OR " +
        "(status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)) " +
        "AND attempts<max_attempts";
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_job SET status='running',attempts=attempts+1,lease_owner=?," +
          "lease_token=?,lease_expires_at=?,started_at=COALESCE(started_at,?),completed_at=NULL," +
          "updated_at=? WHERE id=(SELECT id FROM onto_document_job WHERE " +
          eligible +
          " ORDER BY available_at ASC,created_at ASC,id ASC LIMIT 1) AND " +
          eligible +
          ` RETURNING ${JOB_COLUMNS}`,
        [
          input.workerId,
          input.leaseToken,
          input.leaseExpiresAt,
          input.now,
          input.now,
          input.now,
          input.now,
          input.now,
          input.now,
        ],
      );
      return rows[0] === undefined ? null : rowJob(rows[0]);
    });
  }

  async heartbeat(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
  }): Promise<DocumentJobRecord | null> {
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_job SET lease_expires_at=?,updated_at=? WHERE id=? " +
          "AND status='running' AND lease_token=? AND lease_expires_at>? " +
          `RETURNING ${JOB_COLUMNS}`,
        [input.leaseExpiresAt, input.now, input.jobId, input.leaseToken, input.now],
      );
      return rows[0] === undefined ? null : rowJob(rows[0]);
    });
  }

  async succeed(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly result: unknown;
    readonly resultSha256: string;
  }): Promise<DocumentJobRecord | null> {
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_job SET status='succeeded',lease_owner=NULL,lease_token=NULL," +
          "lease_expires_at=NULL,result=?,result_sha256=?,last_error='',completed_at=?,updated_at=? " +
          "WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>? " +
          `RETURNING ${JOB_COLUMNS}`,
        [
          jsonText(input.result),
          input.resultSha256,
          input.now,
          input.now,
          input.jobId,
          input.leaseToken,
          input.now,
        ],
      );
      return rows[0] === undefined ? null : rowJob(rows[0]);
    });
  }

  async fail(input: {
    readonly jobId: string;
    readonly leaseToken: string;
    readonly now: string;
    readonly failure: DocumentJobFailureUpdate;
  }): Promise<DocumentJobRecord | null> {
    return this.engine.begin(async (conn) => {
      const current = await selectJob(
        conn,
        "id=? AND status='running' AND lease_token=? AND lease_expires_at>?",
        [input.jobId, input.leaseToken, input.now],
      );
      if (current === null) return null;
      const retry = input.failure.retryAt !== null && current.attempts < current.maxAttempts;
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_job SET status=?,available_at=?,lease_owner=NULL,lease_token=NULL," +
          "lease_expires_at=NULL,last_error=?,completed_at=?,updated_at=? WHERE id=? " +
          "AND status='running' AND lease_token=? AND lease_expires_at>? " +
          `RETURNING ${JOB_COLUMNS}`,
        [
          retry ? "queued" : "failed",
          retry ? input.failure.retryAt! : current.availableAt,
          input.failure.error,
          retry ? null : input.now,
          input.now,
          input.jobId,
          input.leaseToken,
          input.now,
        ],
      );
      return rows[0] === undefined ? null : rowJob(rows[0]);
    });
  }

  async cancel(scope: DocumentScope, jobId: string, now: string): Promise<DocumentJobRecord | null> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const current = await selectJob(conn, "id=? AND project_id=? AND owner=?", [
        jobId,
        scope.projectId,
        scope.owner,
      ]);
      if (current === null) return null;
      if (current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
        return current;
      }
      const rows = await conn.all<DbRow>(
        "UPDATE onto_document_job SET status='cancelled',lease_owner=NULL,lease_token=NULL," +
          "lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=? AND project_id=? AND owner=? " +
          `RETURNING ${JOB_COLUMNS}`,
        [now, now, jobId, scope.projectId, scope.owner],
      );
      return rows[0] === undefined ? null : rowJob(rows[0]);
    });
  }
}

export function buildDocumentJobRepository(store: Store): DocumentJobRepository {
  return store.mode === "memory"
    ? new MemoryDocumentJobRepository()
    : new SqlDocumentJobRepository(store);
}

export interface EnqueueDocumentJobInput {
  readonly documentId: string;
  readonly versionId: string;
  readonly kind: DocumentJobKind;
  readonly idempotencyKey: string;
  readonly input?: unknown;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

export interface DocumentJobQueueOptions {
  readonly repository: DocumentJobRepository;
  readonly documents: DocumentRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** 负责 exact-version 校验和幂等请求指纹；仓储只负责原子状态转换。 */
export class DocumentJobQueue {
  readonly repository: DocumentJobRepository;
  readonly documents: DocumentRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: DocumentJobQueueOptions) {
    this.repository = options.repository;
    this.documents = options.documents;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `djob_${randomUUID().replaceAll("-", "")}`);
  }

  async enqueue(scope: DocumentScope, input: EnqueueDocumentJobInput): Promise<DocumentJobRecord> {
    assertScope(scope);
    const documentId = text(input.documentId, "文档 ID", 2_048);
    const versionId = text(input.versionId, "版本 ID", 2_048);
    const idempotencyKey = text(input.idempotencyKey, "幂等键", 512);
    if (input.kind !== "parse" && input.kind !== "ocr") {
      throw new DocumentJobError("INVALID_ARGUMENT", "任务类型只能是 parse 或 ocr");
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new DocumentJobError("INVALID_ARGUMENT", "maxAttempts 必须是 1 到 20 的整数");
    }
    const version = await this.documents.getVersion(scope, documentId, versionId);
    if (version === null) {
      throw new DocumentJobError("NOT_FOUND", "没有找到这个项目中的精确文档版本");
    }
    const payload = input.input ?? {};
    jsonDigest(payload, "任务输入");
    const createdAt = this.now().toISOString();
    const requestedAvailableAt = input.availableAt === undefined
      ? null
      : iso(input.availableAt, "可执行时间");
    const request = {
      project_id: scope.projectId,
      owner: scope.owner,
      document_id: documentId,
      version_id: versionId,
      kind: input.kind,
      source_sha256: version.sha256,
      expected_index_revision: version.indexRevision,
      max_attempts: maxAttempts,
      requested_available_at: requestedAvailableAt,
      input: payload,
    };
    return this.repository.enqueue({
      id: this.newId(),
      scope,
      documentId,
      versionId,
      kind: input.kind,
      idempotencyKey,
      requestSha256: sha256Hex(canonicalJson(request)),
      sourceSha256: version.sha256,
      expectedIndexRevision: version.indexRevision,
      input: payload,
      maxAttempts,
      availableAt: requestedAvailableAt ?? createdAt,
      createdAt,
    });
  }

  get(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    return this.repository.get(scope, text(jobId, "任务 ID", 2_048));
  }

  cancel(scope: DocumentScope, jobId: string): Promise<DocumentJobRecord | null> {
    return this.repository.cancel(scope, text(jobId, "任务 ID", 2_048), this.now().toISOString());
  }
}

export interface DocumentJobWorkerContext {
  readonly job: DocumentJobRecord;
  readonly version: StoredDocumentVersion;
  /** 返回 false 表示租约已丢；worker 应立即停止，不要再提交外部结果。 */
  heartbeat(): Promise<boolean>;
}

export interface DocumentJobWorkerResult {
  readonly output: unknown;
}

export interface DocumentJobWorker {
  run(context: DocumentJobWorkerContext): Promise<DocumentJobWorkerResult>;
}

export interface DocumentJobRunnerOptions {
  readonly queue: DocumentJobQueue;
  readonly workers?: Partial<Record<DocumentJobKind, DocumentJobWorker>>;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly newLeaseToken?: () => string;
  readonly retryDelayMs?: (attempt: number, error: unknown) => number;
}

export type DocumentJobRunOutcome =
  | { readonly state: "idle" }
  | { readonly state: "succeeded" | "retrying" | "failed"; readonly job: DocumentJobRecord }
  | { readonly state: "lease_lost"; readonly jobId: string };

/**
 * 单次领取执行器。没有内建外部 OCR 客户端：生产环境按 kind 注入 worker，测试可以注入
 * 纯确定性 worker。任务产物只写 job.result，不会就地篡改不可变 document_version。
 */
export class DocumentJobRunner {
  private readonly queue: DocumentJobQueue;
  private readonly workers: Partial<Record<DocumentJobKind, DocumentJobWorker>>;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly newLeaseToken: () => string;
  private readonly retryDelayMs: (attempt: number, error: unknown) => number;

  constructor(options: DocumentJobRunnerOptions) {
    this.queue = options.queue;
    this.workers = options.workers ?? {};
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 3_600_000) {
      throw new DocumentJobError("INVALID_ARGUMENT", "leaseMs 必须在 1 秒到 1 小时之间");
    }
    this.now = options.now ?? (() => new Date());
    this.newLeaseToken = options.newLeaseToken ?? (() => randomUUID().replaceAll("-", ""));
    this.retryDelayMs =
      options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1)));
  }

  async runOne(workerId: string): Promise<DocumentJobRunOutcome> {
    const worker = text(workerId, "worker ID", 256);
    const claimedAt = this.now();
    const leaseToken = this.newLeaseToken();
    const claimed = await this.queue.repository.claim({
      workerId: worker,
      leaseToken,
      now: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseMs).toISOString(),
    });
    if (claimed === null) return { state: "idle" };

    try {
      const scope = jobScope(claimed);
      const version = await this.queue.documents.getVersion(
        scope,
        claimed.documentId,
        claimed.versionId,
      );
      if (
        version === null ||
        version.sha256 !== claimed.sourceSha256 ||
        version.indexRevision !== claimed.expectedIndexRevision
      ) {
        throw new DocumentJobWorkerError(
          "任务绑定的文档版本、内容摘要或索引版本已经不一致；为避免处理错材料，任务已停止",
          false,
        );
      }
      const implementation = this.workers[claimed.kind];
      if (implementation === undefined) {
        throw new DocumentJobWorkerError(
          `没有配置 ${claimed.kind === "ocr" ? "OCR" : "解析"} worker，任务未执行`,
          false,
        );
      }
      const result = await implementation.run({
        job: claimed,
        version,
        heartbeat: async () => {
          const now = this.now();
          const renewed = await this.queue.repository.heartbeat({
            jobId: claimed.id,
            leaseToken,
            now: now.toISOString(),
            leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
          });
          return renewed !== null;
        },
      });
      const resultSha256 = jsonDigest(result.output, "任务结果");
      const finished = await this.queue.repository.succeed({
        jobId: claimed.id,
        leaseToken,
        now: this.now().toISOString(),
        result: result.output,
        resultSha256,
      });
      return finished === null
        ? { state: "lease_lost", jobId: claimed.id }
        : { state: "succeeded", job: finished };
    } catch (error) {
      const retryable = error instanceof DocumentJobWorkerError
        ? error.retryable
        : !(error instanceof DocumentJobError);
      const message = error instanceof Error ? error.message : String(error);
      const now = this.now();
      const delay = this.retryDelayMs(claimed.attempts, error);
      const retryAtMs = now.getTime() + delay;
      const delayValid =
        Number.isFinite(delay) &&
        delay >= 0 &&
        delay <= 7 * 24 * 60 * 60_000 &&
        Number.isFinite(retryAtMs);
      const failed = await this.queue.repository.fail({
        jobId: claimed.id,
        leaseToken,
        now: now.toISOString(),
        failure: {
          error: [...(delayValid ? message : `${message}；retryDelayMs 返回值无效`)]
            .slice(0, 4_000)
            .join(""),
          retryAt: retryable && delayValid ? new Date(retryAtMs).toISOString() : null,
        },
      });
      if (failed === null) return { state: "lease_lost", jobId: claimed.id };
      return { state: failed.status === "queued" ? "retrying" : "failed", job: failed };
    }
  }
}
