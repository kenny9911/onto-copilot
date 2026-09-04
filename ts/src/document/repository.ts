import type { ParsedDoc } from "../onto/parse/base.js";
import { sha256Hex } from "../kernel/ids.js";
import type { Conn, Store } from "../store/engine.js";
import type { DocumentFolder } from "./types.js";
import {
  DocumentConflict,
  DocumentError,
  DocumentNotFound,
  type DocumentAttachment,
  type DocumentAttachmentRole,
  type DocumentMetadataPatch,
  type DocumentScope,
  type DocumentSourceClass,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentVersion,
  type SessionDocumentScope,
  type StoredDocumentChunk,
  type StoredDocumentVersion,
} from "./types.js";

export interface NewDocumentSeed {
  readonly id: string;
  readonly title: string;
  readonly logicalName: string;
  readonly sourceClass: DocumentSourceClass;
  readonly tags: readonly string[];
  readonly createdBy: string;
  readonly createdAt: string;
  /** 落在哪个文件夹。缺省是根目录。 */
  readonly folderPath?: string;
}

export interface NewVersionSeed {
  readonly id: string;
  readonly documentId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly relPath: string;
  readonly docKind: string;
  readonly parsedDoc: ParsedDoc;
  readonly parseStatus: "ready" | "degraded";
  readonly parserName: string;
  readonly parserVersion: string;
  readonly indexRevision: string;
  readonly chunkCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CommitVersionInput {
  readonly scope: DocumentScope;
  readonly documentId: string;
  /** 仅新建逻辑文档时存在。 */
  readonly newDocument?: NewDocumentSeed;
  /** 给已有文档追加版本时必须存在，并在事务提交那一刻继续等于 currentVersionId。 */
  readonly baseVersionId?: string;
  readonly version: NewVersionSeed;
  readonly chunks: readonly StoredDocumentChunk[];
}

export interface CommitVersionResult {
  readonly document: DocumentSummary;
  readonly version: StoredDocumentVersion;
  readonly deduplicated: boolean;
}

export interface SearchChunkCandidate {
  readonly document: DocumentSummary;
  readonly version: DocumentVersion;
  readonly chunk: StoredDocumentChunk;
}

export interface DocumentRepository {
  list(scope: DocumentScope, includeArchived: boolean): Promise<DocumentSummary[]>;
  get(scope: DocumentScope, documentId: string): Promise<DocumentSummary | null>;
  history(scope: DocumentScope, documentId: string): Promise<DocumentVersion[]>;
  getVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<StoredDocumentVersion | null>;
  findVersionBySha(
    scope: DocumentScope,
    documentId: string,
    sha256: string,
  ): Promise<StoredDocumentVersion | null>;
  /**
   * 整个 scope 里有没有哪一份**在架**材料的**当前版**正是这段字节。
   *
   * 和 findVersionBySha 的区别是不指定 documentId —— 它回答的是「这份内容进过这个
   * 库没有」，而不是「这份文档有没有这一版」。入库时没给目标文档就要用它，
   * 否则同一个文件点两次会长出两份一模一样的文档（实测过）。
   *
   * 只看当前版：一份材料**历史上**某一版和新文件相同，不代表现在还是；那种情况
   * 应该走「加为新版本」，不是去重。归档的也不算 —— 归档意味着人说过「这份先收
   * 起来」，再传一次是重新拿它出来用，不该静默指回一份看不见的东西。
   */
  findActiveDocumentByCurrentSha(
    scope: DocumentScope,
    sha256: string,
  ): Promise<DocumentSummary | null>;
  commitVersion(input: CommitVersionInput): Promise<CommitVersionResult>;
  updateMetadata(
    scope: DocumentScope,
    documentId: string,
    patch: DocumentMetadataPatch,
  ): Promise<DocumentSummary>;
  adopt(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<DocumentSummary>;
  archive(
    scope: DocumentScope,
    documentId: string,
    archived: boolean,
    expectedRevision: number,
  ): Promise<DocumentSummary>;
  attach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
    role: DocumentAttachmentRole,
    attachedBy: string,
    attachedAt: string,
  ): Promise<DocumentAttachment>;
  detach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<boolean>;
  listAttachments(
    scope: DocumentScope,
    session: SessionDocumentScope,
  ): Promise<DocumentAttachment[]>;
  chunksForSearch(
    scope: DocumentScope,
    opts: {
      readonly documentIds?: readonly string[];
      readonly sessionId?: string;
    },
  ): Promise<SearchChunkCandidate[]>;
  getChunk(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    chunkId: string,
  ): Promise<SearchChunkCandidate | null>;
  /**
   * 按原文顺序取一个版本的切片 —— 「打开一份材料读」用的。
   *
   * 在此之前整个知识库只有两条读路径：`chunksForSearch`（要关键词）和 `getChunk`
   * （要一个已经拿到的 evidence_ref）。也就是说**存进去的文件根本没有打开入口**，
   * 用户只能靠猜关键词去搜自己刚传的东西。这是「知识库看不懂、用不起来」最直接的一条。
   *
   * 返回 total 是为了让阅读器如实说「第 1-50 段，共 213 段」，而不是默默截断。
   */
  listFolders(scope: DocumentScope): Promise<DocumentFolder[]>;
  createFolder(scope: DocumentScope, path: string, createdBy: string, createdAt: string): Promise<DocumentFolder>;
  /** 删掉文件夹本身及其所有子文件夹；里面的文档挪到 `moveTo`（默认根目录），不删。 */
  deleteFolder(scope: DocumentScope, path: string, moveTo: string): Promise<number>;
  /** 重命名 = 连同所有子文件夹与其中文档的路径前缀一起改。 */
  renameFolder(scope: DocumentScope, from: string, to: string): Promise<number>;
  moveDocument(scope: DocumentScope, documentId: string, folderPath: string): Promise<DocumentSummary>;
  chunksOfVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    opts?: { readonly offset?: number; readonly limit?: number },
  ): Promise<{ readonly chunks: SearchChunkCandidate[]; readonly total: number }>;
}

// ══════════════════════════════════════════════════════════════════
// 共享的不可变快照工具
// ══════════════════════════════════════════════════════════════════

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function cloneDocument(row: DocumentSummary): DocumentSummary {
  return { ...row, tags: [...row.tags] };
}

function cloneVersion(row: StoredDocumentVersion): StoredDocumentVersion {
  return { ...row, parsedDoc: cloneJson(row.parsedDoc) };
}

function cloneAttachment(row: DocumentAttachment): DocumentAttachment {
  return { ...row };
}

function cloneChunk(row: StoredDocumentChunk): StoredDocumentChunk {
  return {
    ...row,
    locator: cloneJson(row.locator),
    raw: cloneJson(row.raw),
    tags: [...row.tags],
  };
}

function assertScope(scope: DocumentScope): void {
  if (!scope.projectId.trim() || !scope.owner.trim()) {
    throw new DocumentError(
      "INVALID_ARGUMENT",
      "项目知识库必须绑定已鉴权的 projectId 和 owner",
      400,
    );
  }
}

function assertSessionScope(scope: DocumentScope, session: SessionDocumentScope): void {
  assertScope(scope);
  if (
    !session.sessionId.trim() ||
    session.projectId !== scope.projectId ||
    session.owner !== scope.owner
  ) {
    throw new DocumentError("FORBIDDEN", "会话不属于当前项目知识库", 404);
  }
}

function validateCommit(input: CommitVersionInput): void {
  if (
    !input.documentId ||
    input.version.documentId !== input.documentId ||
    input.newDocument?.id !== (input.newDocument === undefined ? undefined : input.documentId)
  ) {
    throw new DocumentError("INTEGRITY_ERROR", "文档与版本的 id 不一致", 409);
  }
  if (!/^[a-f0-9]{64}$/u.test(input.version.sha256)) {
    throw new DocumentError("INTEGRITY_ERROR", "版本 SHA-256 不是 64 位小写十六进制", 409);
  }
  if (
    input.version.parsedDoc.file_id !== input.version.id ||
    input.version.chunkCount !== input.chunks.length ||
    input.version.parsedDoc.chunks.length !== input.chunks.length
  ) {
    throw new DocumentError("INTEGRITY_ERROR", "ParsedDoc、版本与检索切片的数量或 file_id 不一致", 409);
  }
  const parsed = new Map(input.version.parsedDoc.chunks.map((c) => [c.chunk_id, c]));
  if (parsed.size !== input.version.parsedDoc.chunks.length) {
    throw new DocumentError("INTEGRITY_ERROR", "ParsedDoc 含重复 chunk_id", 409);
  }
  const seen = new Set<string>();
  for (const chunk of input.chunks) {
    const source = parsed.get(chunk.chunkId);
    if (
      chunk.documentId !== input.documentId ||
      chunk.versionId !== input.version.id ||
      seen.has(chunk.chunkId) ||
      source === undefined ||
      source.file_id !== input.version.id ||
      source.render !== chunk.render ||
      sha256Hex(chunk.render) !== chunk.textSha256
    ) {
      throw new DocumentError("INTEGRITY_ERROR", `版本切片 ${chunk.chunkId} 与 ParsedDoc 不一致`, 409);
    }
    seen.add(chunk.chunkId);
  }
}

function versionPublic(v: StoredDocumentVersion): DocumentVersion {
  const { parsedDoc: _parsedDoc, ...row } = v;
  return row;
}

function conflictRevision(expected: number, actual: number): never {
  throw new DocumentConflict(
    "REVISION_CONFLICT",
    `文档已经被别人修改（期望 revision=${expected}，当前 revision=${actual}）`,
    { expectedRevision: expected, actualRevision: actual },
  );
}

function conflictBase(expected: string | undefined, actual: string): never {
  throw new DocumentConflict(
    "BASE_VERSION_CONFLICT",
    `文档已经有更新版本（提交基线 ${expected ?? "<未提供>"}，当前版本 ${actual}）`,
    { expectedBaseVersionId: expected ?? null, actualVersionId: actual },
  );
}

// ══════════════════════════════════════════════════════════════════
// 内存实现
// ══════════════════════════════════════════════════════════════════

export class MemoryDocumentRepository implements DocumentRepository {
  private readonly folders = new Map<string, DocumentFolder>();
  private readonly documents = new Map<string, DocumentSummary>();
  private readonly versions = new Map<string, StoredDocumentVersion>();
  private readonly chunks = new Map<string, StoredDocumentChunk>();
  private readonly attachments = new Map<string, DocumentAttachment>();

  private scoped(scope: DocumentScope, documentId: string): DocumentSummary | null {
    assertScope(scope);
    const row = this.documents.get(documentId);
    return row?.projectId === scope.projectId && row.owner === scope.owner ? row : null;
  }

  async list(scope: DocumentScope, includeArchived: boolean): Promise<DocumentSummary[]> {
    assertScope(scope);
    return [...this.documents.values()]
      .filter(
        (d) =>
          d.projectId === scope.projectId &&
          d.owner === scope.owner &&
          (includeArchived || d.status === "active"),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(cloneDocument);
  }

  async get(scope: DocumentScope, documentId: string): Promise<DocumentSummary | null> {
    const row = this.scoped(scope, documentId);
    return row === null ? null : cloneDocument(row);
  }

  async history(scope: DocumentScope, documentId: string): Promise<DocumentVersion[]> {
    if (this.scoped(scope, documentId) === null) throw new DocumentNotFound();
    return [...this.versions.values()]
      .filter((v) => v.documentId === documentId)
      .sort((a, b) => b.versionNo - a.versionNo)
      .map((v) => versionPublic(cloneVersion(v)));
  }

  async getVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<StoredDocumentVersion | null> {
    if (this.scoped(scope, documentId) === null) return null;
    const row = this.versions.get(versionId);
    return row?.documentId === documentId ? cloneVersion(row) : null;
  }

  async findVersionBySha(
    scope: DocumentScope,
    documentId: string,
    sha256: string,
  ): Promise<StoredDocumentVersion | null> {
    if (this.scoped(scope, documentId) === null) return null;
    const row = [...this.versions.values()].find(
      (v) => v.documentId === documentId && v.sha256 === sha256,
    );
    return row === undefined ? null : cloneVersion(row);
  }

  async findActiveDocumentByCurrentSha(
    scope: DocumentScope,
    sha256: string,
  ): Promise<DocumentSummary | null> {
    assertScope(scope);
    for (const doc of this.documents.values()) {
      if (doc.projectId !== scope.projectId || doc.owner !== scope.owner) continue;
      if (doc.status !== "active") continue;
      if (doc.currentVersionId === "") continue;
      const version = this.versions.get(doc.currentVersionId);
      if (version !== undefined && version.sha256 === sha256) return cloneDocument(doc);
    }
    return null;
  }

  async commitVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    assertScope(input.scope);
    validateCommit(input);
    const existing = this.scoped(input.scope, input.documentId);
    let versionNo = 1;
    if (existing !== null) {
      if (input.newDocument !== undefined) {
        throw new DocumentError("INTEGRITY_ERROR", "文档 id 已存在", 409);
      }
      if (input.baseVersionId !== existing.currentVersionId) {
        conflictBase(input.baseVersionId, existing.currentVersionId);
      }
      const same = [...this.versions.values()].find(
        (v) => v.documentId === input.documentId && v.sha256 === input.version.sha256,
      );
      if (same !== undefined) {
        return {
          document: cloneDocument(existing),
          version: cloneVersion(same),
          deduplicated: true,
        };
      }
      versionNo = Math.max(
        0,
        ...[...this.versions.values()]
          .filter((v) => v.documentId === input.documentId)
          .map((v) => v.versionNo),
      ) + 1;
    } else if (input.newDocument === undefined) {
      throw new DocumentNotFound();
    }

    if (this.versions.has(input.version.id)) {
      throw new DocumentError("INTEGRITY_ERROR", "版本 id 已存在", 409);
    }
    for (const c of input.chunks) {
      if (this.chunks.has(`${c.versionId}\u0000${c.chunkId}`)) {
        throw new DocumentError("INTEGRITY_ERROR", `重复的文档切片 ${c.chunkId}`, 409);
      }
    }
    const version: StoredDocumentVersion = { ...input.version, versionNo };
    this.versions.set(version.id, cloneVersion(version));
    for (const c of input.chunks) {
      const key = `${c.versionId}\u0000${c.chunkId}`;
      this.chunks.set(key, cloneChunk(c));
    }

    const document: DocumentSummary =
      existing === null
        ? {
            id: input.newDocument!.id,
            projectId: input.scope.projectId,
            owner: input.scope.owner,
            title: input.newDocument!.title,
            logicalName: input.newDocument!.logicalName,
            sourceClass: input.newDocument!.sourceClass,
            tags: [...input.newDocument!.tags],
            status: "active",
            currentVersionId: version.id,
            adoptedVersionId: version.id,
            revision: 1,
            createdBy: input.newDocument!.createdBy,
            createdAt: input.newDocument!.createdAt,
            updatedAt: version.createdAt,
            // 新文档默认落在根目录；入库之后再移动到某个文件夹。
            folderPath: input.newDocument!.folderPath ?? "",
          }
        : {
            ...existing,
            currentVersionId: version.id,
            revision: existing.revision + 1,
            updatedAt: version.createdAt,
          };
    this.documents.set(document.id, cloneDocument(document));
    return { document: cloneDocument(document), version: cloneVersion(version), deduplicated: false };
  }

  async updateMetadata(
    scope: DocumentScope,
    documentId: string,
    patch: DocumentMetadataPatch,
  ): Promise<DocumentSummary> {
    const row = this.scoped(scope, documentId);
    if (row === null) throw new DocumentNotFound();
    if (row.revision !== patch.expectedRevision) conflictRevision(patch.expectedRevision, row.revision);
    const next: DocumentSummary = {
      ...row,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.logicalName === undefined ? {} : { logicalName: patch.logicalName }),
      ...(patch.sourceClass === undefined ? {} : { sourceClass: patch.sourceClass }),
      ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
      revision: row.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(documentId, cloneDocument(next));
    return cloneDocument(next);
  }

  async adopt(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<DocumentSummary> {
    const row = this.scoped(scope, documentId);
    if (row === null) throw new DocumentNotFound();
    if (row.revision !== expectedRevision) conflictRevision(expectedRevision, row.revision);
    const version = this.versions.get(versionId);
    if (version?.documentId !== documentId) throw new DocumentNotFound("没有找到这个文档版本");
    const next = {
      ...row,
      adoptedVersionId: versionId,
      revision: row.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(documentId, cloneDocument(next));
    return cloneDocument(next);
  }

  async archive(
    scope: DocumentScope,
    documentId: string,
    archived: boolean,
    expectedRevision: number,
  ): Promise<DocumentSummary> {
    const row = this.scoped(scope, documentId);
    if (row === null) throw new DocumentNotFound();
    if (row.revision !== expectedRevision) conflictRevision(expectedRevision, row.revision);
    const next = {
      ...row,
      status: (archived ? "archived" : "active") as DocumentStatus,
      revision: row.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.documents.set(documentId, cloneDocument(next));
    return cloneDocument(next);
  }

  async attach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
    role: DocumentAttachmentRole,
    attachedBy: string,
    attachedAt: string,
  ): Promise<DocumentAttachment> {
    assertSessionScope(scope, session);
    const doc = this.scoped(scope, documentId);
    if (doc === null || doc.status !== "active") throw new DocumentNotFound();
    const version = this.versions.get(versionId);
    if (version?.documentId !== documentId) throw new DocumentNotFound("没有找到这个文档版本");
    const row: DocumentAttachment = {
      sessionId: session.sessionId,
      projectId: scope.projectId,
      owner: scope.owner,
      documentId,
      versionId,
      role,
      attachedBy,
      attachedAt,
    };
    this.attachments.set(`${session.sessionId}\u0000${documentId}`, row);
    return cloneAttachment(row);
  }

  async detach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<boolean> {
    assertSessionScope(scope, session);
    const key = `${session.sessionId}\u0000${documentId}`;
    const row = this.attachments.get(key);
    if (
      row?.projectId !== scope.projectId ||
      row.owner !== scope.owner ||
      row.versionId !== versionId
    ) return false;
    return this.attachments.delete(key);
  }

  async listAttachments(
    scope: DocumentScope,
    session: SessionDocumentScope,
  ): Promise<DocumentAttachment[]> {
    assertSessionScope(scope, session);
    return [...this.attachments.values()]
      .filter(
        (a) =>
          a.sessionId === session.sessionId &&
          a.projectId === scope.projectId &&
          a.owner === scope.owner &&
          this.scoped(scope, a.documentId) !== null,
      )
      .sort((a, b) => a.attachedAt.localeCompare(b.attachedAt) || a.documentId.localeCompare(b.documentId))
      .map(cloneAttachment);
  }

  async chunksForSearch(
    scope: DocumentScope,
    opts: { readonly documentIds?: readonly string[]; readonly sessionId?: string },
  ): Promise<SearchChunkCandidate[]> {
    assertScope(scope);
    const filter = opts.documentIds === undefined ? null : new Set(opts.documentIds);
    const selected = new Map<string, DocumentSummary>();
    if (opts.sessionId !== undefined) {
      for (const a of this.attachments.values()) {
        if (
          a.sessionId === opts.sessionId &&
          a.projectId === scope.projectId &&
          a.owner === scope.owner &&
          (filter === null || filter.has(a.documentId))
        ) {
          const d = this.scoped(scope, a.documentId);
          if (d !== null) selected.set(a.versionId, d);
        }
      }
    } else {
      for (const d of this.documents.values()) {
        if (
          d.projectId === scope.projectId &&
          d.owner === scope.owner &&
          d.status === "active" &&
          (filter === null || filter.has(d.id))
        ) {
          selected.set(d.adoptedVersionId ?? d.currentVersionId, d);
        }
      }
    }
    return this.candidates(selected);
  }

  private candidates(selected: ReadonlyMap<string, DocumentSummary>): SearchChunkCandidate[] {
    const out: SearchChunkCandidate[] = [];
    for (const [versionId, doc] of selected) {
      const v = this.versions.get(versionId);
      if (v === undefined || v.documentId !== doc.id) continue;
      for (const c of this.chunks.values()) {
        if (c.versionId !== versionId || c.documentId !== doc.id) continue;
        out.push({ document: cloneDocument(doc), version: versionPublic(cloneVersion(v)), chunk: cloneChunk(c) });
      }
    }
    return out.sort(
      (a, b) =>
        a.document.id.localeCompare(b.document.id) ||
        a.version.versionNo - b.version.versionNo ||
        a.chunk.order - b.chunk.order ||
        a.chunk.chunkId.localeCompare(b.chunk.chunkId),
    );
  }

  async getChunk(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    chunkId: string,
  ): Promise<SearchChunkCandidate | null> {
    const d = this.scoped(scope, documentId);
    const v = this.versions.get(versionId);
    const c = this.chunks.get(`${versionId}\u0000${chunkId}`);
    if (d === null || v?.documentId !== documentId || c?.documentId !== documentId) return null;
    return { document: cloneDocument(d), version: versionPublic(cloneVersion(v)), chunk: cloneChunk(c) };
  }

  private folderKey(scope: DocumentScope, path: string): string {
    return `${scope.projectId}\u0000${scope.owner}\u0000${path}`;
  }

  async listFolders(scope: DocumentScope): Promise<DocumentFolder[]> {
    assertScope(scope);
    const prefix = `${scope.projectId}\u0000${scope.owner}\u0000`;
    return [...this.folders.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => ({ ...v }))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
  }

  async createFolder(
    scope: DocumentScope,
    path: string,
    createdBy: string,
    createdAt: string,
  ): Promise<DocumentFolder> {
    assertScope(scope);
    const key = this.folderKey(scope, path);
    const existing = this.folders.get(key);
    if (existing !== undefined) return { ...existing };
    const row: DocumentFolder = { path, createdBy, createdAt };
    this.folders.set(key, row);
    return { ...row };
  }

  async deleteFolder(scope: DocumentScope, path: string, moveTo: string): Promise<number> {
    assertScope(scope);
    const prefix = `${path}/`;
    let moved = 0;
    for (const [key, doc] of this.documents) {
      if (doc.projectId !== scope.projectId || doc.owner !== scope.owner) continue;
      if (doc.folderPath !== path && !doc.folderPath.startsWith(prefix)) continue;
      this.documents.set(key, { ...doc, folderPath: moveTo });
      moved += 1;
    }
    for (const key of [...this.folders.keys()]) {
      const row = this.folders.get(key)!;
      if (!key.startsWith(`${scope.projectId}\u0000${scope.owner}\u0000`)) continue;
      if (row.path === path || row.path.startsWith(prefix)) this.folders.delete(key);
    }
    return moved;
  }

  async renameFolder(scope: DocumentScope, from: string, to: string): Promise<number> {
    assertScope(scope);
    const prefix = `${from}/`;
    const rename = (p: string): string =>
      p === from ? to : p.startsWith(prefix) ? `${to}/${p.slice(prefix.length)}` : p;
    let touched = 0;
    for (const [key, doc] of this.documents) {
      if (doc.projectId !== scope.projectId || doc.owner !== scope.owner) continue;
      const next = rename(doc.folderPath);
      if (next === doc.folderPath) continue;
      this.documents.set(key, { ...doc, folderPath: next });
      touched += 1;
    }
    for (const key of [...this.folders.keys()]) {
      if (!key.startsWith(`${scope.projectId}\u0000${scope.owner}\u0000`)) continue;
      const row = this.folders.get(key)!;
      const next = rename(row.path);
      if (next === row.path) continue;
      this.folders.delete(key);
      this.folders.set(this.folderKey(scope, next), { ...row, path: next });
      touched += 1;
    }
    return touched;
  }

  async moveDocument(
    scope: DocumentScope,
    documentId: string,
    folderPath: string,
  ): Promise<DocumentSummary> {
    const d = this.scoped(scope, documentId);
    if (d === null) throw new DocumentNotFound();
    const next = { ...d, folderPath };
    this.documents.set(documentId, next);
    return cloneDocument(next);
  }

  async chunksOfVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    opts: { readonly offset?: number; readonly limit?: number } = {},
  ): Promise<{ readonly chunks: SearchChunkCandidate[]; readonly total: number }> {
    const d = this.scoped(scope, documentId);
    const v = this.versions.get(versionId);
    if (d === null || v?.documentId !== documentId) return { chunks: [], total: 0 };
    const all = [...this.chunks.values()]
      .filter((c) => c.versionId === versionId && c.documentId === documentId)
      .sort((a, b) => a.order - b.order || a.chunkId.localeCompare(b.chunkId));
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = opts.limit === undefined ? all.length : Math.max(0, Math.trunc(opts.limit));
    return {
      chunks: all.slice(offset, offset + limit).map((c) => ({
        document: cloneDocument(d),
        version: versionPublic(cloneVersion(v)),
        chunk: cloneChunk(c),
      })),
      total: all.length,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// SQL 实现（同一套参数化 SQL 经 Engine 适配 SQLite/Postgres）
// ══════════════════════════════════════════════════════════════════

type DbRow = Record<string, unknown>;

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v instanceof Map ? Object.fromEntries(v) : v)) ?? "null";
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value === null || value === undefined ? fallback : (value as T);
}

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = String(value ?? "");
  if (!raw) return "";
  const parsed = new Date(raw.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function rowDocument(r: DbRow): DocumentSummary {
  return {
    id: String(r["id"]),
    projectId: String(r["project_id"]),
    owner: String(r["owner"]),
    title: String(r["title"]),
    logicalName: String(r["logical_name"]),
    sourceClass: String(r["source_class"]) as DocumentSourceClass,
    tags: jsonValue<readonly string[]>(r["tags"], []).map(String),
    status: String(r["status"]) as DocumentStatus,
    currentVersionId: String(r["current_version_id"]),
    adoptedVersionId: r["adopted_version_id"] === null ? null : String(r["adopted_version_id"]),
    revision: Number(r["revision"]),
    createdBy: String(r["created_by"]),
    // 老库读出来是 undefined（0019 之前没这列）—— 按根目录处理。
    folderPath: String(r["folder_path"] ?? ""),
    createdAt: dateText(r["created_at"]),
    updatedAt: dateText(r["updated_at"]),
  };
}

function rowVersion(r: DbRow): StoredDocumentVersion {
  return {
    id: String(r["id"]),
    documentId: String(r["document_id"]),
    versionNo: Number(r["version_no"]),
    fileName: String(r["file_name"]),
    mediaType: String(r["media_type"]),
    sizeBytes: Number(r["size_bytes"]),
    sha256: String(r["sha256"]),
    relPath: String(r["rel_path"]),
    docKind: String(r["doc_kind"]),
    parsedDoc: jsonValue<ParsedDoc>(r["parsed_doc"], {
      file_id: "",
      file_name: "",
      kind: "",
      chunks: [],
      structured: {},
      findings: [],
      meta: {},
    }),
    parseStatus: String(r["parse_status"]) as "ready" | "degraded",
    parserName: String(r["parser_name"]),
    parserVersion: String(r["parser_version"]),
    indexRevision: String(r["index_revision"]),
    chunkCount: Number(r["chunk_count"]),
    createdBy: String(r["created_by"]),
    createdAt: dateText(r["created_at"]),
  };
}

function rowChunk(r: DbRow): StoredDocumentChunk {
  return {
    documentId: String(r["document_id"]),
    versionId: String(r["version_id"]),
    chunkId: String(r["chunk_id"]),
    order: Number(r["order_no"]),
    locator: jsonValue<Readonly<Record<string, unknown>>>(r["locator"], {}),
    render: String(r["render_text"]),
    raw: jsonValue<unknown>(r["raw_json"], null),
    tags: jsonValue<readonly string[]>(r["tags"], []).map(String),
    context: String(r["context"]),
    textSha256: String(r["text_sha256"]),
  };
}

function rowAttachment(r: DbRow): DocumentAttachment {
  return {
    sessionId: String(r["session_id"]),
    projectId: String(r["project_id"]),
    owner: String(r["owner"]),
    documentId: String(r["document_id"]),
    versionId: String(r["version_id"]),
    role: String(r["role"]) as DocumentAttachmentRole,
    attachedBy: String(r["attached_by"]),
    attachedAt: dateText(r["attached_at"]),
  };
}

const DOC_COLUMNS =
  "id,project_id,owner,title,logical_name,source_class,tags,status,current_version_id," +
  // folder_path 必须在这里 —— 少一列，rowDocument 读出来永远是空串，
  // 于是「移动到某文件夹」会报成功而材料纹丝不动。
  "adopted_version_id,revision,created_by,created_at,updated_at,folder_path";
const VERSION_COLUMNS =
  "id,document_id,version_no,file_name,media_type,size_bytes,sha256,rel_path,doc_kind," +
  "parsed_doc,parse_status,parser_name,parser_version,index_revision,chunk_count,created_by,created_at";

export class SqlDocumentRepository implements DocumentRepository {
  constructor(private readonly store: Store) {
    if (store.engine === null) throw new Error("SqlDocumentRepository 需要启用数据库的 Store");
  }

  private get engine() {
    return this.store.engine!;
  }

  private async docIn(conn: Conn, scope: DocumentScope, documentId: string): Promise<DocumentSummary | null> {
    const rows = await conn.all<DbRow>(
      `SELECT ${DOC_COLUMNS} FROM onto_document WHERE id=? AND project_id=? AND owner=?`,
      [documentId, scope.projectId, scope.owner],
    );
    return rows[0] === undefined ? null : rowDocument(rows[0]);
  }

  private async versionIn(
    conn: Conn,
    scope: DocumentScope,
    documentId: string,
    clause: "id" | "sha256",
    value: string,
  ): Promise<StoredDocumentVersion | null> {
    const rows = await conn.all<DbRow>(
      `SELECT v.${VERSION_COLUMNS.split(",").join(",v.")} FROM onto_document_version v ` +
        "JOIN onto_document d ON d.id=v.document_id " +
        `WHERE d.project_id=? AND d.owner=? AND d.id=? AND v.${clause}=?`,
      [scope.projectId, scope.owner, documentId, value],
    );
    return rows[0] === undefined ? null : rowVersion(rows[0]);
  }

  async list(scope: DocumentScope, includeArchived: boolean): Promise<DocumentSummary[]> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        `SELECT ${DOC_COLUMNS} FROM onto_document WHERE project_id=? AND owner=?` +
          (includeArchived ? "" : " AND status='active'") +
          " ORDER BY updated_at DESC,id ASC",
        [scope.projectId, scope.owner],
      );
      return rows.map(rowDocument);
    });
  }

  async get(scope: DocumentScope, documentId: string): Promise<DocumentSummary | null> {
    assertScope(scope);
    return this.engine.connect((conn) => this.docIn(conn, scope, documentId));
  }

  async history(scope: DocumentScope, documentId: string): Promise<DocumentVersion[]> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      if ((await this.docIn(conn, scope, documentId)) === null) throw new DocumentNotFound();
      const rows = await conn.all<DbRow>(
        `SELECT ${VERSION_COLUMNS} FROM onto_document_version WHERE document_id=? ORDER BY version_no DESC`,
        [documentId],
      );
      return rows.map((r) => versionPublic(rowVersion(r)));
    });
  }

  async getVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<StoredDocumentVersion | null> {
    assertScope(scope);
    return this.engine.connect((conn) => this.versionIn(conn, scope, documentId, "id", versionId));
  }

  async findVersionBySha(
    scope: DocumentScope,
    documentId: string,
    sha256: string,
  ): Promise<StoredDocumentVersion | null> {
    assertScope(scope);
    return this.engine.connect((conn) => this.versionIn(conn, scope, documentId, "sha256", sha256));
  }

  async findActiveDocumentByCurrentSha(
    scope: DocumentScope,
    sha256: string,
  ): Promise<DocumentSummary | null> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      // JOIN 挂在 current_version_id 上，不是「任意一版」—— 见接口上那段注释。
      const rows = await conn.all<DbRow>(
        `SELECT ${DOC_COLUMNS.split(",").map((c) => `d.${c}`).join(",")} FROM onto_document d ` +
          "JOIN onto_document_version v ON v.id=d.current_version_id " +
          "WHERE d.project_id=? AND d.owner=? AND d.status='active' AND v.sha256=? " +
          "ORDER BY d.created_at ASC,d.id ASC",
        [scope.projectId, scope.owner, sha256],
      );
      return rows[0] === undefined ? null : rowDocument(rows[0]);
    });
  }

  async commitVersion(input: CommitVersionInput): Promise<CommitVersionResult> {
    assertScope(input.scope);
    validateCommit(input);
    try {
      return await this.engine.begin(async (conn) => {
        const existing = await this.docIn(conn, input.scope, input.documentId);
        let versionNo = 1;
        if (existing !== null) {
          if (input.newDocument !== undefined) {
            throw new DocumentError("INTEGRITY_ERROR", "文档 id 已存在", 409);
          }
          if (input.baseVersionId !== existing.currentVersionId) {
            conflictBase(input.baseVersionId, existing.currentVersionId);
          }
          const same = await this.versionIn(
            conn,
            input.scope,
            input.documentId,
            "sha256",
            input.version.sha256,
          );
          if (same !== null) return { document: existing, version: same, deduplicated: true };
          const n = await conn.scalar(
            "SELECT COALESCE(MAX(version_no),0)+1 FROM onto_document_version WHERE document_id=?",
            [input.documentId],
          );
          versionNo = Number(n ?? 1);
        } else if (input.newDocument === undefined) {
          throw new DocumentNotFound();
        }

        const v = input.version;
        await conn.exec(
          "INSERT INTO onto_document_version " +
            "(id,document_id,version_no,file_name,media_type,size_bytes,sha256,rel_path,doc_kind," +
            "parsed_doc,parse_status,parser_name,parser_version,index_revision,chunk_count,created_by,created_at) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            v.id,
            input.documentId,
            versionNo,
            v.fileName,
            v.mediaType,
            v.sizeBytes,
            v.sha256,
            v.relPath,
            v.docKind,
            jsonText(v.parsedDoc),
            v.parseStatus,
            v.parserName,
            v.parserVersion,
            v.indexRevision,
            v.chunkCount,
            v.createdBy,
            v.createdAt,
          ],
        );
        for (const c of input.chunks) {
          await conn.exec(
            "INSERT INTO onto_document_chunk " +
              "(version_id,chunk_id,document_id,order_no,locator,render_text,raw_json,tags,context,text_sha256) " +
              "VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              c.versionId,
              c.chunkId,
              c.documentId,
              c.order,
              jsonText(c.locator),
              c.render,
              jsonText(c.raw),
              jsonText(c.tags),
              c.context,
              c.textSha256,
            ],
          );
        }

        let document: DocumentSummary;
        if (existing === null) {
          const d = input.newDocument!;
          await conn.exec(
            "INSERT INTO onto_document " +
              "(id,project_id,owner,title,logical_name,source_class,tags,status,current_version_id," +
              "adopted_version_id,revision,created_by,created_at,updated_at) " +
              "VALUES (?,?,?,?,?,?,?,'active',?,?,1,?,?,?)",
            [
              d.id,
              input.scope.projectId,
              input.scope.owner,
              d.title,
              d.logicalName,
              d.sourceClass,
              jsonText(d.tags),
              v.id,
              v.id,
              d.createdBy,
              d.createdAt,
              v.createdAt,
            ],
          );
          document = (await this.docIn(conn, input.scope, input.documentId))!;
        } else {
          const updated = await conn.all<DbRow>(
            `UPDATE onto_document SET current_version_id=?,revision=revision+1,updated_at=? ` +
              `WHERE id=? AND project_id=? AND owner=? AND current_version_id=? AND revision=? ` +
              `RETURNING ${DOC_COLUMNS}`,
            [
              v.id,
              v.createdAt,
              input.documentId,
              input.scope.projectId,
              input.scope.owner,
              input.baseVersionId!,
              existing.revision,
            ],
          );
          if (updated[0] === undefined) conflictBase(input.baseVersionId, existing.currentVersionId);
          document = rowDocument(updated[0]);
        }
        return {
          document,
          version: { ...v, versionNo },
          deduplicated: false,
        };
      });
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      // 并发追加时唯一约束可能先于条件 UPDATE 报错。事务回滚后重新读取，把它翻成
      // 稳定的 OCC/去重结果，不把数据库方言的报错文本泄露给 API。
      const current = await this.get(input.scope, input.documentId);
      if (current !== null && input.newDocument === undefined) {
        if (current.currentVersionId !== input.baseVersionId) {
          conflictBase(input.baseVersionId, current.currentVersionId);
        }
        const same = await this.findVersionBySha(
          input.scope,
          input.documentId,
          input.version.sha256,
        );
        if (same !== null) return { document: current, version: same, deduplicated: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DocumentError("INTEGRITY_ERROR", `保存文档版本失败：${message}`, 409);
    }
  }

  async updateMetadata(
    scope: DocumentScope,
    documentId: string,
    patch: DocumentMetadataPatch,
  ): Promise<DocumentSummary> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const current = await this.docIn(conn, scope, documentId);
      if (current === null) throw new DocumentNotFound();
      if (current.revision !== patch.expectedRevision) {
        conflictRevision(patch.expectedRevision, current.revision);
      }
      const title = patch.title ?? current.title;
      const logicalName = patch.logicalName ?? current.logicalName;
      const sourceClass = patch.sourceClass ?? current.sourceClass;
      const tags = patch.tags ?? current.tags;
      const now = new Date().toISOString();
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document SET title=?,logical_name=?,source_class=?,tags=?,revision=revision+1,updated_at=? ` +
          `WHERE id=? AND project_id=? AND owner=? AND revision=? RETURNING ${DOC_COLUMNS}`,
        [
          title,
          logicalName,
          sourceClass,
          jsonText(tags),
          now,
          documentId,
          scope.projectId,
          scope.owner,
          patch.expectedRevision,
        ],
      );
      if (rows[0] === undefined) conflictRevision(patch.expectedRevision, current.revision);
      return rowDocument(rows[0]);
    });
  }

  async adopt(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<DocumentSummary> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const current = await this.docIn(conn, scope, documentId);
      if (current === null) throw new DocumentNotFound();
      if (current.revision !== expectedRevision) conflictRevision(expectedRevision, current.revision);
      if ((await this.versionIn(conn, scope, documentId, "id", versionId)) === null) {
        throw new DocumentNotFound("没有找到这个文档版本");
      }
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document SET adopted_version_id=?,revision=revision+1,updated_at=? ` +
          `WHERE id=? AND project_id=? AND owner=? AND revision=? RETURNING ${DOC_COLUMNS}`,
        [versionId, new Date().toISOString(), documentId, scope.projectId, scope.owner, expectedRevision],
      );
      if (rows[0] === undefined) conflictRevision(expectedRevision, current.revision);
      return rowDocument(rows[0]);
    });
  }

  async archive(
    scope: DocumentScope,
    documentId: string,
    archived: boolean,
    expectedRevision: number,
  ): Promise<DocumentSummary> {
    assertScope(scope);
    return this.engine.begin(async (conn) => {
      const current = await this.docIn(conn, scope, documentId);
      if (current === null) throw new DocumentNotFound();
      if (current.revision !== expectedRevision) conflictRevision(expectedRevision, current.revision);
      const rows = await conn.all<DbRow>(
        `UPDATE onto_document SET status=?,revision=revision+1,updated_at=? ` +
          `WHERE id=? AND project_id=? AND owner=? AND revision=? RETURNING ${DOC_COLUMNS}`,
        [
          archived ? "archived" : "active",
          new Date().toISOString(),
          documentId,
          scope.projectId,
          scope.owner,
          expectedRevision,
        ],
      );
      if (rows[0] === undefined) conflictRevision(expectedRevision, current.revision);
      return rowDocument(rows[0]);
    });
  }

  async attach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
    role: DocumentAttachmentRole,
    attachedBy: string,
    attachedAt: string,
  ): Promise<DocumentAttachment> {
    assertSessionScope(scope, session);
    return this.engine.begin(async (conn) => {
      const d = await this.docIn(conn, scope, documentId);
      if (d === null || d.status !== "active") throw new DocumentNotFound();
      if ((await this.versionIn(conn, scope, documentId, "id", versionId)) === null) {
        throw new DocumentNotFound("没有找到这个文档版本");
      }
      await conn.exec(
        "INSERT INTO session_document " +
          "(session_id,document_id,version_id,project_id,owner,role,attached_by,attached_at) " +
          "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,document_id) DO UPDATE SET " +
          "version_id=excluded.version_id,project_id=excluded.project_id,owner=excluded.owner," +
          "role=excluded.role,attached_by=excluded.attached_by,attached_at=excluded.attached_at",
        [
          session.sessionId,
          documentId,
          versionId,
          scope.projectId,
          scope.owner,
          role,
          attachedBy,
          attachedAt,
        ],
      );
      const rows = await conn.all<DbRow>(
        "SELECT session_id,document_id,version_id,project_id,owner,role,attached_by,attached_at " +
          "FROM session_document WHERE session_id=? AND document_id=? AND project_id=? AND owner=?",
        [session.sessionId, documentId, scope.projectId, scope.owner],
      );
      return rowAttachment(rows[0]!);
    });
  }

  async detach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
    versionId: string,
  ): Promise<boolean> {
    assertSessionScope(scope, session);
    return this.engine.begin(async (conn) => {
      const rows = await conn.all<DbRow>(
        "DELETE FROM session_document WHERE session_id=? AND document_id=? AND version_id=? AND project_id=? AND owner=? " +
          "RETURNING document_id",
        [session.sessionId, documentId, versionId, scope.projectId, scope.owner],
      );
      return rows.length > 0;
    });
  }

  async listAttachments(
    scope: DocumentScope,
    session: SessionDocumentScope,
  ): Promise<DocumentAttachment[]> {
    assertSessionScope(scope, session);
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        "SELECT a.session_id,a.document_id,a.version_id,a.project_id,a.owner,a.role,a.attached_by,a.attached_at " +
          "FROM session_document a JOIN onto_document d ON d.id=a.document_id " +
          "WHERE a.session_id=? AND a.project_id=? AND a.owner=? " +
          "AND d.project_id=a.project_id AND d.owner=a.owner ORDER BY a.attached_at,a.document_id",
        [session.sessionId, scope.projectId, scope.owner],
      );
      return rows.map(rowAttachment);
    });
  }

  async chunksForSearch(
    scope: DocumentScope,
    opts: { readonly documentIds?: readonly string[]; readonly sessionId?: string },
  ): Promise<SearchChunkCandidate[]> {
    assertScope(scope);
    if (opts.documentIds?.length === 0) return [];
    return this.engine.connect(async (conn) => {
      const params: (string | number | null)[] = [scope.projectId, scope.owner];
      const requested = opts.documentIds;
      let join: string;
      let where: string;
      if (opts.sessionId !== undefined) {
        join = "JOIN session_document a ON a.document_id=d.id AND a.version_id=v.id ";
        where = "d.project_id=? AND d.owner=? AND a.project_id=d.project_id AND a.owner=d.owner AND a.session_id=?";
        params.push(opts.sessionId);
      } else {
        join = "";
        where =
          "d.project_id=? AND d.owner=? AND d.status='active' " +
          "AND v.id=COALESCE(d.adopted_version_id,d.current_version_id)";
      }
      if (requested !== undefined) {
        where += ` AND d.id IN (${requested.map(() => "?").join(",")})`;
        params.push(...requested);
      }
      const sql =
        `SELECT ${DOC_COLUMNS.split(",").map((c) => `d.${c} AS d_${c}`).join(",")},` +
        `${VERSION_COLUMNS.split(",").map((c) => `v.${c} AS v_${c}`).join(",")},` +
        "c.version_id AS c_version_id,c.chunk_id AS c_chunk_id,c.document_id AS c_document_id," +
        "c.order_no AS c_order_no,c.locator AS c_locator,c.render_text AS c_render_text," +
        "c.raw_json AS c_raw_json,c.tags AS c_tags,c.context AS c_context,c.text_sha256 AS c_text_sha256 " +
        "FROM onto_document d JOIN onto_document_version v ON v.document_id=d.id " +
        `${join}JOIN onto_document_chunk c ON c.version_id=v.id AND c.document_id=d.id WHERE ${where} ` +
        "ORDER BY d.id,v.version_no,c.order_no,c.chunk_id";
      const rows = await conn.all<DbRow>(sql, params);
      return rows.map(candidateFromJoined);
    });
  }

  async getChunk(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    chunkId: string,
  ): Promise<SearchChunkCandidate | null> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const sql =
        `SELECT ${DOC_COLUMNS.split(",").map((c) => `d.${c} AS d_${c}`).join(",")},` +
        `${VERSION_COLUMNS.split(",").map((c) => `v.${c} AS v_${c}`).join(",")},` +
        "c.version_id AS c_version_id,c.chunk_id AS c_chunk_id,c.document_id AS c_document_id," +
        "c.order_no AS c_order_no,c.locator AS c_locator,c.render_text AS c_render_text," +
        "c.raw_json AS c_raw_json,c.tags AS c_tags,c.context AS c_context,c.text_sha256 AS c_text_sha256 " +
        "FROM onto_document d JOIN onto_document_version v ON v.document_id=d.id " +
        "JOIN onto_document_chunk c ON c.version_id=v.id AND c.document_id=d.id " +
        "WHERE d.project_id=? AND d.owner=? AND d.id=? AND v.id=? AND c.chunk_id=?";
      const rows = await conn.all<DbRow>(sql, [scope.projectId, scope.owner, documentId, versionId, chunkId]);
      return rows[0] === undefined ? null : candidateFromJoined(rows[0]);
    });
  }

  async listFolders(scope: DocumentScope): Promise<DocumentFolder[]> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const rows = await conn.all<DbRow>(
        "SELECT path,created_by,created_at FROM onto_document_folder " +
          "WHERE project_id=? AND owner=? ORDER BY path",
        [scope.projectId, scope.owner],
      );
      return rows.map((r) => ({
        path: String(r["path"]),
        createdBy: String(r["created_by"]),
        createdAt: dateText(r["created_at"]),
      }));
    });
  }

  async createFolder(
    scope: DocumentScope,
    path: string,
    createdBy: string,
    createdAt: string,
  ): Promise<DocumentFolder> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const found = await conn.all<DbRow>(
        "SELECT path,created_by,created_at FROM onto_document_folder " +
          "WHERE project_id=? AND owner=? AND path=?",
        [scope.projectId, scope.owner, path],
      );
      if (found[0] !== undefined) {
        // 已存在就原样返回：建一个已经在的文件夹不是错误，是空操作。
        return {
          path,
          createdBy: String(found[0]["created_by"]),
          createdAt: dateText(found[0]["created_at"]),
        };
      }
      await conn.exec(
        "INSERT INTO onto_document_folder (project_id,owner,path,created_by,created_at) " +
          "VALUES (?,?,?,?,?)",
        [scope.projectId, scope.owner, path, createdBy, createdAt],
      );
      return { path, createdBy, createdAt };
    });
  }

  async deleteFolder(scope: DocumentScope, path: string, moveTo: string): Promise<number> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const like = `${path}/%`;
      // 先数**这次要移走的**，再移。移完再数目的地会把本来就在那儿的一并算进去，
      // 于是回执写「3 份材料移到了根目录」而实际只动了 2 份 —— 这个产品别处都在
      // 守「不把数字说大」，这里也不能例外。
      const before = await conn.all<DbRow>(
        "SELECT COUNT(*) AS n FROM onto_document WHERE project_id=? AND owner=? " +
          "AND (folder_path=? OR folder_path LIKE ?)",
        [scope.projectId, scope.owner, path, like],
      );
      const moved = before;
      // **不删文档**：删掉一个文件夹不该顺带销毁材料。
      await conn.exec(
        "UPDATE onto_document SET folder_path=? WHERE project_id=? AND owner=? " +
          "AND (folder_path=? OR folder_path LIKE ?)",
        [moveTo, scope.projectId, scope.owner, path, like],
      );
      await conn.exec(
        "DELETE FROM onto_document_folder WHERE project_id=? AND owner=? AND (path=? OR path LIKE ?)",
        [scope.projectId, scope.owner, path, like],
      );
      return Number(moved[0]?.["n"] ?? 0);
    });
  }

  async renameFolder(scope: DocumentScope, from: string, to: string): Promise<number> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      const like = `${from}/%`;
      // substr 是**1 基**且按字符数（不是字节）计。要保留的尾巴是从分隔符那一位
      // 开始的 `/子路径`，所以起点 = 前缀字符数 + 1，拼接前缀用 `to` 而不是 `to/`
      // —— 写成 `to/` + substr(…, len+1) 会多出一个斜杠，跑出来就是 `新名//子级`。
      // 用 [...from].length 而不是 from.length：后者数的是 UTF-16 码元。
      const cut = [...from].length + 1;
      // 子文件夹和其中的文档跟着一起改前缀 —— 否则改完名字，下面那一层就断了根。
      await conn.exec(
        "UPDATE onto_document SET folder_path=? WHERE project_id=? AND owner=? AND folder_path=?",
        [to, scope.projectId, scope.owner, from],
      );
      await conn.exec(
        `UPDATE onto_document SET folder_path=? || substr(folder_path,${cut}) ` +
          "WHERE project_id=? AND owner=? AND folder_path LIKE ?",
        [to, scope.projectId, scope.owner, like],
      );
      await conn.exec(
        "UPDATE onto_document_folder SET path=? WHERE project_id=? AND owner=? AND path=?",
        [to, scope.projectId, scope.owner, from],
      );
      await conn.exec(
        `UPDATE onto_document_folder SET path=? || substr(path,${cut}) ` +
          "WHERE project_id=? AND owner=? AND path LIKE ?",
        [to, scope.projectId, scope.owner, like],
      );
      const n = await conn.all<DbRow>(
        "SELECT COUNT(*) AS n FROM onto_document_folder WHERE project_id=? AND owner=? " +
          "AND (path=? OR path LIKE ?)",
        [scope.projectId, scope.owner, to, `${to}/%`],
      );
      return Number(n[0]?.["n"] ?? 0);
    });
  }

  async moveDocument(
    scope: DocumentScope,
    documentId: string,
    folderPath: string,
  ): Promise<DocumentSummary> {
    assertScope(scope);
    return this.engine.connect(async (conn) => {
      await conn.exec(
        "UPDATE onto_document SET folder_path=? WHERE id=? AND project_id=? AND owner=?",
        [folderPath, documentId, scope.projectId, scope.owner],
      );
      const rows = await conn.all<DbRow>(
        `SELECT ${DOC_COLUMNS} FROM onto_document WHERE id=? AND project_id=? AND owner=?`,
        [documentId, scope.projectId, scope.owner],
      );
      if (rows[0] === undefined) throw new DocumentNotFound();
      return rowDocument(rows[0]);
    });
  }

  async chunksOfVersion(
    scope: DocumentScope,
    documentId: string,
    versionId: string,
    opts: { readonly offset?: number; readonly limit?: number } = {},
  ): Promise<{ readonly chunks: SearchChunkCandidate[]; readonly total: number }> {
    assertScope(scope);
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.max(0, Math.trunc(opts.limit ?? 200));
    return this.engine.connect(async (conn) => {
      const bounds = [scope.projectId, scope.owner, documentId, versionId];
      // 先数一次总量：阅读器要能如实说「第 1-50 段，共 213 段」，
      // 而不是默默截断 —— 这个产品的其它地方都在守「不把截断伪装成全部」这条。
      const counted = await conn.all<DbRow>(
        "SELECT COUNT(*) AS n FROM onto_document d " +
          "JOIN onto_document_version v ON v.document_id=d.id " +
          "JOIN onto_document_chunk c ON c.version_id=v.id AND c.document_id=d.id " +
          "WHERE d.project_id=? AND d.owner=? AND d.id=? AND v.id=?",
        bounds,
      );
      const total = Number(counted[0]?.["n"] ?? 0);
      if (total === 0 || limit === 0) return { chunks: [], total };
      const sql =
        `SELECT ${DOC_COLUMNS.split(",").map((c) => `d.${c} AS d_${c}`).join(",")},` +
        `${VERSION_COLUMNS.split(",").map((c) => `v.${c} AS v_${c}`).join(",")},` +
        "c.version_id AS c_version_id,c.chunk_id AS c_chunk_id,c.document_id AS c_document_id," +
        "c.order_no AS c_order_no,c.locator AS c_locator,c.render_text AS c_render_text," +
        "c.raw_json AS c_raw_json,c.tags AS c_tags,c.context AS c_context,c.text_sha256 AS c_text_sha256 " +
        "FROM onto_document d JOIN onto_document_version v ON v.document_id=d.id " +
        "JOIN onto_document_chunk c ON c.version_id=v.id AND c.document_id=d.id " +
        "WHERE d.project_id=? AND d.owner=? AND d.id=? AND v.id=? " +
        // 走 onto_document_chunk_version_order_idx (version_id, order_no)。
        "ORDER BY c.order_no,c.chunk_id LIMIT ? OFFSET ?";
      const rows = await conn.all<DbRow>(sql, [...bounds, limit, offset]);
      return { chunks: rows.map(candidateFromJoined), total };
    });
  }
}

function prefixed(r: DbRow, prefix: string): DbRow {
  const out: DbRow = {};
  for (const [key, value] of Object.entries(r)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

function candidateFromJoined(r: DbRow): SearchChunkCandidate {
  const version = rowVersion(prefixed(r, "v_"));
  return {
    document: rowDocument(prefixed(r, "d_")),
    version: versionPublic(version),
    chunk: rowChunk({
      version_id: r["c_version_id"],
      chunk_id: r["c_chunk_id"],
      document_id: r["c_document_id"],
      order_no: r["c_order_no"],
      locator: r["c_locator"],
      render_text: r["c_render_text"],
      raw_json: r["c_raw_json"],
      tags: r["c_tags"],
      context: r["c_context"],
      text_sha256: r["c_text_sha256"],
    }),
  };
}

export function buildDocumentRepository(store: Store): DocumentRepository {
  return store.mode === "memory" ? new MemoryDocumentRepository() : new SqlDocumentRepository(store);
}
