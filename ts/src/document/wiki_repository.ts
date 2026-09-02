import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import type { Conn, Store } from "../store/engine.js";
import {
  DocumentConflict,
  DocumentError,
  DocumentNotFound,
  type DocumentScope,
} from "./types.js";
import {
  createWikiPage,
  type WikiActor,
  type WikiClaim,
  type WikiPage,
} from "./wiki.js";

export type WikiPageStatus = "active" | "archived";
export type WikiRevisionAction = "create" | "edit" | "confirm_claim" | "archive" | "restore";

export interface StoredWikiPage {
  readonly page: WikiPage;
  readonly owner: string;
  readonly status: WikiPageStatus;
  readonly revision: number;
  readonly createdBy: WikiActor;
  readonly createdAt: string;
  readonly updatedBy: WikiActor;
  readonly updatedAt: string;
}

export interface WikiPageRevision {
  readonly page: WikiPage;
  readonly owner: string;
  readonly status: WikiPageStatus;
  readonly revision: number;
  readonly action: WikiRevisionAction;
  readonly actor: WikiActor;
  readonly recordedAt: string;
  readonly contentSha256: string;
}

export interface CreateStoredWikiPageInput {
  readonly scope: DocumentScope;
  readonly page: WikiPage;
  readonly actor: WikiActor;
  readonly createdAt: string;
}

export interface CommitWikiPageInput {
  readonly scope: DocumentScope;
  readonly pageId: string;
  readonly expectedRevision: number;
  readonly page: WikiPage;
  readonly status: WikiPageStatus;
  readonly action: Exclude<WikiRevisionAction, "create">;
  readonly actor: WikiActor;
  readonly recordedAt: string;
}

export interface WikiPageRepository {
  list(scope: DocumentScope, includeArchived: boolean): Promise<StoredWikiPage[]>;
  get(scope: DocumentScope, pageId: string): Promise<StoredWikiPage | null>;
  history(scope: DocumentScope, pageId: string): Promise<WikiPageRevision[]>;
  create(input: CreateStoredWikiPageInput): Promise<StoredWikiPage>;
  commit(input: CommitWikiPageInput): Promise<StoredWikiPage>;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function cloneActor(actor: WikiActor): WikiActor {
  return actor.name === undefined
    ? { kind: actor.kind, id: actor.id }
    : { kind: actor.kind, id: actor.id, name: actor.name };
}

function cloneStored(value: StoredWikiPage): StoredWikiPage {
  return {
    ...value,
    page: cloneJson(value.page),
    createdBy: cloneActor(value.createdBy),
    updatedBy: cloneActor(value.updatedBy),
  };
}

function cloneRevision(value: WikiPageRevision): WikiPageRevision {
  return { ...value, page: cloneJson(value.page), actor: cloneActor(value.actor) };
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string") {
    throw new DocumentError("INVALID_ARGUMENT", `${label}必须是文字`, 400);
  }
  const out = value.trim();
  if (!out || out.includes("\u0000") || [...out].length > max) {
    throw new DocumentError("INVALID_ARGUMENT", `${label}无效`, 400);
  }
  return out;
}

function isoTime(value: unknown, label: string): string {
  const raw = text(value, label, 64);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new DocumentError("INVALID_ARGUMENT", `${label}不是有效时间`, 400);
  }
  return new Date(parsed).toISOString();
}

function actorValue(actor: WikiActor): WikiActor {
  if (actor === null || typeof actor !== "object" || (actor.kind !== "ai" && actor.kind !== "human")) {
    throw new DocumentError("INVALID_ARGUMENT", "Wiki 操作者无效", 400);
  }
  const id = text(actor.id, "actor.id", 160);
  const name = actor.name?.trim();
  if (name) text(name, "actor.name", 160);
  // 审计身份只持久化稳定的 kind + id；显示名可变，不参与历史快照身份。
  return { kind: actor.kind, id };
}

function assertScope(scope: DocumentScope): void {
  text(scope.projectId, "projectId");
  text(scope.owner, "owner");
}

function normalizedPage(page: WikiPage, scope: DocumentScope, pageId?: string): WikiPage {
  try {
    const out = createWikiPage({
      id: page.id,
      projectId: page.projectId,
      title: page.title,
      summary: page.summary,
      tags: page.tags,
      claims: page.claims,
      updatedAt: page.updatedAt,
    });
    if (out.projectId !== scope.projectId || (pageId !== undefined && out.id !== pageId)) {
      throw new DocumentError("FORBIDDEN", "Wiki 页面不属于当前项目", 404);
    }
    return out;
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : "Wiki 页面无效",
      400,
    );
  }
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function claimCore(claim: WikiClaim): unknown {
  return {
    id: claim.id,
    projectId: claim.projectId,
    kind: claim.kind,
    subject: claim.subject,
    statement: claim.statement,
    evidenceRefs: claim.evidenceRefs,
    author: claim.author,
    createdAt: claim.createdAt,
    supersedesClaimId: claim.supersedesClaimId,
  };
}

function claimMap(page: WikiPage): Map<string, WikiClaim> {
  return new Map(page.claims.map((claim) => [claim.id, claim]));
}

function assertNewDrafts(page: WikiPage, actor: WikiActor): void {
  for (const claim of page.claims) {
    if (claim.state !== "draft" || claim.confirmation !== null) {
      throw new DocumentError(
        "INVALID_ARGUMENT",
        "新页面里的声明必须先保存为草稿，不能绕过人工确认",
        400,
      );
    }
    if (claim.author.kind !== actor.kind || claim.author.id !== actor.id) {
      throw new DocumentError("INVALID_ARGUMENT", "声明起草者必须是本次操作者", 400);
    }
  }
}

function assertConfirmedClaimsImmutable(before: WikiPage, after: WikiPage): void {
  const next = claimMap(after);
  for (const oldClaim of before.claims) {
    if (oldClaim.state !== "confirmed") continue;
    const candidate = next.get(oldClaim.id);
    if (candidate === undefined || !same(candidate, oldClaim)) {
      throw new DocumentError(
        "INVALID_ARGUMENT",
        "人工确认过的声明不可改写或删除；请新增 contested/stale 草稿并引用旧声明",
        400,
      );
    }
  }
}

function assertEditTransition(
  current: StoredWikiPage,
  page: WikiPage,
  status: WikiPageStatus,
  actor: WikiActor,
): void {
  if (current.status !== "active") {
    throw new DocumentError("INVALID_ARGUMENT", "页面已归档；请先恢复再修改", 400);
  }
  if (status !== current.status) {
    throw new DocumentError("INVALID_ARGUMENT", "归档状态必须走 archive/restore 操作", 400);
  }
  assertConfirmedClaimsImmutable(current.page, page);
  const oldClaims = claimMap(current.page);
  for (const claim of page.claims) {
    const old = oldClaims.get(claim.id);
    if (old?.state === "confirmed") continue;
    if (claim.state !== "draft" || claim.confirmation !== null) {
      throw new DocumentError("INVALID_ARGUMENT", "确认声明必须走人工 confirm_claim 操作", 400);
    }
    if (old === undefined && (claim.author.kind !== actor.kind || claim.author.id !== actor.id)) {
      throw new DocumentError("INVALID_ARGUMENT", "新增草稿的起草者必须是本次操作者", 400);
    }
  }
  if (actor.kind === "ai") {
    if (
      current.page.title !== page.title ||
      current.page.summary !== page.summary ||
      !same(current.page.tags, page.tags)
    ) {
      throw new DocumentError("FORBIDDEN", "AI 只能创建或编辑草稿声明，不能改页面元数据", 403);
    }
  }
}

function assertConfirmTransition(current: StoredWikiPage, page: WikiPage, actor: WikiActor): void {
  if (actor.kind !== "human") {
    throw new DocumentError("FORBIDDEN", "只有真人可以确认 Wiki 声明", 403);
  }
  if (
    current.status !== "active" ||
    current.page.title !== page.title ||
    current.page.summary !== page.summary ||
    !same(current.page.tags, page.tags)
  ) {
    throw new DocumentError("INVALID_ARGUMENT", "确认声明时不能同时修改页面或归档状态", 400);
  }
  const before = claimMap(current.page);
  const after = claimMap(page);
  if (before.size !== after.size) {
    throw new DocumentError("INVALID_ARGUMENT", "确认声明时不能同时增删声明", 400);
  }
  let confirmed = 0;
  for (const [id, oldClaim] of before) {
    const next = after.get(id);
    if (next === undefined) {
      throw new DocumentError("INVALID_ARGUMENT", "确认声明时不能同时增删声明", 400);
    }
    if (same(oldClaim, next)) continue;
    const confirmation = next.confirmation;
    if (
      oldClaim.state !== "draft" ||
      next.state !== "confirmed" ||
      confirmation === null ||
      confirmation.actor.kind !== "human" ||
      confirmation.actor.id !== actor.id ||
      confirmation.evidenceRefs.length === 0 ||
      !same(claimCore(oldClaim), claimCore(next))
    ) {
      throw new DocumentError("INVALID_ARGUMENT", "确认操作只能把一条原有草稿转为人工确认", 400);
    }
    confirmed += 1;
  }
  if (confirmed !== 1) {
    throw new DocumentError("INVALID_ARGUMENT", "每次确认必须且只能确认一条草稿声明", 400);
  }
}

function assertStatusTransition(
  current: StoredWikiPage,
  page: WikiPage,
  status: WikiPageStatus,
  action: "archive" | "restore",
  actor: WikiActor,
): void {
  if (actor.kind !== "human") {
    throw new DocumentError("FORBIDDEN", "只有真人可以归档或恢复 Wiki 页面", 403);
  }
  if (!same({ ...current.page, updatedAt: page.updatedAt }, page)) {
    throw new DocumentError("INVALID_ARGUMENT", "归档或恢复时不能同时改写页面内容", 400);
  }
  const expectedBefore = action === "archive" ? "active" : "archived";
  const expectedAfter = action === "archive" ? "archived" : "active";
  if (current.status !== expectedBefore || status !== expectedAfter) {
    throw new DocumentError("INVALID_ARGUMENT", action === "archive" ? "页面已经归档" : "页面没有归档", 400);
  }
}

function validateCreate(input: CreateStoredWikiPageInput): {
  page: WikiPage;
  actor: WikiActor;
  at: string;
} {
  assertScope(input.scope);
  const actor = actorValue(input.actor);
  const at = isoTime(input.createdAt, "createdAt");
  const page = normalizedPage(input.page, input.scope);
  if (page.updatedAt !== at) {
    throw new DocumentError("INVALID_ARGUMENT", "页面 updatedAt 必须等于创建审计时间", 400);
  }
  assertNewDrafts(page, actor);
  return { page, actor, at };
}

function validateCommit(current: StoredWikiPage, input: CommitWikiPageInput): {
  page: WikiPage;
  actor: WikiActor;
  at: string;
} {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw new DocumentError("INVALID_ARGUMENT", "expectedRevision 必须是正整数", 400);
  }
  if (current.revision !== input.expectedRevision) {
    throw new DocumentConflict(
      "REVISION_CONFLICT",
      `Wiki 页面已经被别人修改（期望 revision=${input.expectedRevision}，当前 revision=${current.revision}）`,
      { expectedRevision: input.expectedRevision, actualRevision: current.revision },
    );
  }
  const actor = actorValue(input.actor);
  const at = isoTime(input.recordedAt, "recordedAt");
  const page = normalizedPage(input.page, input.scope, input.pageId);
  if (page.updatedAt !== at) {
    throw new DocumentError("INVALID_ARGUMENT", "页面 updatedAt 必须等于修订审计时间", 400);
  }
  if (input.action === "edit") assertEditTransition(current, page, input.status, actor);
  else if (input.action === "confirm_claim") {
    if (input.status !== current.status) {
      throw new DocumentError("INVALID_ARGUMENT", "确认声明时不能同时归档页面", 400);
    }
    assertConfirmTransition(current, page, actor);
  } else {
    assertStatusTransition(current, page, input.status, input.action, actor);
  }
  return { page, actor, at };
}

function revisionHash(input: {
  readonly page: WikiPage;
  readonly owner: string;
  readonly status: WikiPageStatus;
  readonly revision: number;
  readonly action: WikiRevisionAction;
  readonly actor: WikiActor;
  readonly recordedAt: string;
}): string {
  return sha256Hex(canonicalJson({
    page: input.page,
    owner: input.owner,
    status: input.status,
    revision: input.revision,
    action: input.action,
    actor: { kind: input.actor.kind, id: input.actor.id },
    recordedAt: input.recordedAt,
  }));
}

function revisionOf(
  stored: StoredWikiPage,
  action: WikiRevisionAction,
  actor: WikiActor,
  recordedAt: string,
): WikiPageRevision {
  const base = {
    page: cloneJson(stored.page),
    owner: stored.owner,
    status: stored.status,
    revision: stored.revision,
    action,
    actor: cloneActor(actor),
    recordedAt,
  };
  return { ...base, contentSha256: revisionHash(base) };
}

function scopedKey(scope: DocumentScope, pageId: string): string {
  return `${scope.projectId}\u0000${scope.owner}\u0000${pageId}`;
}

export class MemoryWikiPageRepository implements WikiPageRepository {
  private readonly pages = new Map<string, StoredWikiPage>();
  private readonly revisions = new Map<string, WikiPageRevision[]>();

  async list(scope: DocumentScope, includeArchived: boolean): Promise<StoredWikiPage[]> {
    assertScope(scope);
    return [...this.pages.values()]
      .filter((item) =>
        item.page.projectId === scope.projectId &&
        item.owner === scope.owner &&
        (includeArchived || item.status === "active"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.page.id.localeCompare(b.page.id))
      .map(cloneStored);
  }

  async get(scope: DocumentScope, pageId: string): Promise<StoredWikiPage | null> {
    assertScope(scope);
    const item = this.pages.get(scopedKey(scope, text(pageId, "pageId")));
    return item === undefined ? null : cloneStored(item);
  }

  async history(scope: DocumentScope, pageId: string): Promise<WikiPageRevision[]> {
    assertScope(scope);
    const key = scopedKey(scope, text(pageId, "pageId"));
    if (!this.pages.has(key)) throw new DocumentNotFound("没有找到这个 Wiki 页面");
    return (this.revisions.get(key) ?? []).map(cloneRevision);
  }

  async create(input: CreateStoredWikiPageInput): Promise<StoredWikiPage> {
    const { page, actor, at } = validateCreate(input);
    const key = scopedKey(input.scope, page.id);
    if (this.pages.has(key)) {
      throw new DocumentError("INTEGRITY_ERROR", "同名 Wiki 页面 ID 已存在", 409);
    }
    const stored: StoredWikiPage = {
      page,
      owner: input.scope.owner,
      status: "active",
      revision: 1,
      createdBy: actor,
      createdAt: at,
      updatedBy: actor,
      updatedAt: at,
    };
    this.pages.set(key, cloneStored(stored));
    this.revisions.set(key, [revisionOf(stored, "create", actor, at)]);
    return cloneStored(stored);
  }

  async commit(input: CommitWikiPageInput): Promise<StoredWikiPage> {
    assertScope(input.scope);
    const key = scopedKey(input.scope, text(input.pageId, "pageId"));
    const current = this.pages.get(key);
    if (current === undefined) throw new DocumentNotFound("没有找到这个 Wiki 页面");
    const { page, actor, at } = validateCommit(current, input);
    const stored: StoredWikiPage = {
      ...current,
      page,
      status: input.status,
      revision: current.revision + 1,
      updatedBy: actor,
      updatedAt: at,
    };
    this.pages.set(key, cloneStored(stored));
    this.revisions.set(key, [
      ...(this.revisions.get(key) ?? []),
      revisionOf(stored, input.action, actor, at),
    ]);
    return cloneStored(stored);
  }
}

type DbRow = Record<string, unknown>;

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value === null || value === undefined ? fallback : value as T;
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? "");
  const parsed = new Date(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/u.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function rowActor(kind: unknown, id: unknown): WikiActor {
  return actorValue({ kind: String(kind) as WikiActor["kind"], id: String(id) });
}

function rowPage(row: DbRow): StoredWikiPage {
  const updatedAt = dateText(row["updated_at"]);
  const page = normalizedPage(createWikiPage({
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    title: String(row["title"]),
    summary: String(row["summary"]),
    tags: jsonValue<readonly string[]>(row["tags"], []),
    claims: jsonValue<readonly WikiClaim[]>(row["claims"], []),
    updatedAt,
  }), { projectId: String(row["project_id"]), owner: String(row["owner"]) });
  return {
    page,
    owner: String(row["owner"]),
    status: String(row["status"]) as WikiPageStatus,
    revision: Number(row["revision"]),
    createdBy: rowActor(row["created_by_kind"], row["created_by_id"]),
    createdAt: dateText(row["created_at"]),
    updatedBy: rowActor(row["updated_by_kind"], row["updated_by_id"]),
    updatedAt,
  };
}

function rowRevision(row: DbRow): WikiPageRevision {
  const recordedAt = dateText(row["recorded_at"]);
  const page = createWikiPage({
    id: String(row["page_id"]),
    projectId: String(row["project_id"]),
    title: String(row["title"]),
    summary: String(row["summary"]),
    tags: jsonValue<readonly string[]>(row["tags"], []),
    claims: jsonValue<readonly WikiClaim[]>(row["claims"], []),
    updatedAt: recordedAt,
  });
  const base = {
    page,
    owner: String(row["owner"]),
    status: String(row["status"]) as WikiPageStatus,
    revision: Number(row["revision"]),
    action: String(row["action"]) as WikiRevisionAction,
    actor: rowActor(row["actor_kind"], row["actor_id"]),
    recordedAt,
  };
  const expected = revisionHash(base);
  const actual = String(row["content_sha256"]);
  if (expected !== actual) {
    throw new DocumentError("INTEGRITY_ERROR", "Wiki 历史快照摘要校验失败", 409);
  }
  return { ...base, contentSha256: actual };
}

const PAGE_COLUMNS =
  "project_id,owner,id,title,summary,tags,claims,status,revision,created_by_kind,created_by_id," +
  "created_at,updated_by_kind,updated_by_id,updated_at";
const REVISION_COLUMNS =
  "project_id,owner,page_id,revision,title,summary,tags,claims,status,action,actor_kind,actor_id," +
  "recorded_at,content_sha256";

export class SqlWikiPageRepository implements WikiPageRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlWikiPageRepository 需要启用数据库的 Store");
  }

  private get engine() {
    return this.store.engine!;
  }

  private async pageIn(conn: Conn, scope: DocumentScope, pageId: string): Promise<StoredWikiPage | null> {
    const rows = await conn.all<DbRow>(
      `SELECT ${PAGE_COLUMNS} FROM onto_document_wiki_page ` +
        "WHERE project_id=? AND owner=? AND id=?",
      [scope.projectId, scope.owner, pageId],
    );
    return rows[0] === undefined ? null : rowPage(rows[0]);
  }

  async list(scope: DocumentScope, includeArchived: boolean): Promise<StoredWikiPage[]> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        `SELECT ${PAGE_COLUMNS} FROM onto_document_wiki_page WHERE project_id=? AND owner=?` +
          (includeArchived ? "" : " AND status='active'") +
          " ORDER BY updated_at DESC,id ASC",
        [scope.projectId, scope.owner],
      );
      return rows.map(rowPage);
    });
  }

  async get(scope: DocumentScope, pageId: string): Promise<StoredWikiPage | null> {
    assertScope(scope);
    return this.engine.connect((conn) => this.pageIn(conn, scope, text(pageId, "pageId")));
  }

  async history(scope: DocumentScope, pageId: string): Promise<WikiPageRevision[]> {
    assertScope(scope);
    const id = text(pageId, "pageId");
    return this.engine.connect(async (conn) => {
      if ((await this.pageIn(conn, scope, id)) === null) {
        throw new DocumentNotFound("没有找到这个 Wiki 页面");
      }
      const rows = await conn.all<DbRow>(
        `SELECT ${REVISION_COLUMNS} FROM onto_document_wiki_page_revision ` +
          "WHERE project_id=? AND owner=? AND page_id=? ORDER BY revision ASC",
        [scope.projectId, scope.owner, id],
      );
      return rows.map(rowRevision);
    });
  }

  async create(input: CreateStoredWikiPageInput): Promise<StoredWikiPage> {
    const { page, actor, at } = validateCreate(input);
    try {
      return await this.engine.begin(async (conn) => {
        if ((await this.pageIn(conn, input.scope, page.id)) !== null) {
          throw new DocumentError("INTEGRITY_ERROR", "同名 Wiki 页面 ID 已存在", 409);
        }
        await conn.exec(
          "INSERT INTO onto_document_wiki_page " +
            "(project_id,owner,id,title,summary,tags,claims,status,revision,created_by_kind,created_by_id," +
            "created_at,updated_by_kind,updated_by_id,updated_at) " +
            "VALUES (?,?,?,?,?,?,?,'active',1,?,?,?,?,?,?)",
          [
            input.scope.projectId,
            input.scope.owner,
            page.id,
            page.title,
            page.summary,
            jsonText(page.tags),
            jsonText(page.claims),
            actor.kind,
            actor.id,
            at,
            actor.kind,
            actor.id,
            at,
          ],
        );
        const stored = (await this.pageIn(conn, input.scope, page.id))!;
        await this.insertRevision(conn, revisionOf(stored, "create", actor, at));
        return stored;
      });
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      const existing = await this.get(input.scope, page.id);
      if (existing !== null) {
        throw new DocumentError("INTEGRITY_ERROR", "同名 Wiki 页面 ID 已存在", 409);
      }
      throw new DocumentError("INTEGRITY_ERROR", "保存 Wiki 页面失败", 409);
    }
  }

  async commit(input: CommitWikiPageInput): Promise<StoredWikiPage> {
    assertScope(input.scope);
    try {
      return await this.engine.begin(async (conn) => {
        const current = await this.pageIn(conn, input.scope, text(input.pageId, "pageId"));
        if (current === null) throw new DocumentNotFound("没有找到这个 Wiki 页面");
        const { page, actor, at } = validateCommit(current, input);
        const rows = await conn.all<DbRow>(
          `UPDATE onto_document_wiki_page SET title=?,summary=?,tags=?,claims=?,status=?,` +
            `revision=revision+1,updated_by_kind=?,updated_by_id=?,updated_at=? ` +
            `WHERE project_id=? AND owner=? AND id=? AND revision=? RETURNING ${PAGE_COLUMNS}`,
          [
            page.title,
            page.summary,
            jsonText(page.tags),
            jsonText(page.claims),
            input.status,
            actor.kind,
            actor.id,
            at,
            input.scope.projectId,
            input.scope.owner,
            input.pageId,
            input.expectedRevision,
          ],
        );
        if (rows[0] === undefined) {
          const actual = await this.pageIn(conn, input.scope, input.pageId);
          throw new DocumentConflict(
            "REVISION_CONFLICT",
            `Wiki 页面已经被别人修改（期望 revision=${input.expectedRevision}，当前 revision=${actual?.revision ?? "?"}）`,
            { expectedRevision: input.expectedRevision, actualRevision: actual?.revision ?? null },
          );
        }
        const stored = rowPage(rows[0]);
        await this.insertRevision(conn, revisionOf(stored, input.action, actor, at));
        return stored;
      });
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      const current = await this.get(input.scope, input.pageId);
      if (current !== null && current.revision !== input.expectedRevision) {
        throw new DocumentConflict(
          "REVISION_CONFLICT",
          `Wiki 页面已经被别人修改（期望 revision=${input.expectedRevision}，当前 revision=${current.revision}）`,
          { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        );
      }
      throw new DocumentError("INTEGRITY_ERROR", "保存 Wiki 修订失败", 409);
    }
  }

  private async insertRevision(conn: Conn, revision: WikiPageRevision): Promise<void> {
    await conn.exec(
      "INSERT INTO onto_document_wiki_page_revision " +
        "(project_id,owner,page_id,revision,title,summary,tags,claims,status,action,actor_kind,actor_id," +
        "recorded_at,content_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        revision.page.projectId,
        revision.owner,
        revision.page.id,
        revision.revision,
        revision.page.title,
        revision.page.summary,
        jsonText(revision.page.tags),
        jsonText(revision.page.claims),
        revision.status,
        revision.action,
        revision.actor.kind,
        revision.actor.id,
        revision.recordedAt,
        revision.contentSha256,
      ],
    );
  }
}
