import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../kernel/ids.js";
import { defaultRegistry } from "../onto/parse/index.js";
import { makeFinding, makeParsedDoc, type ParsedDoc } from "../onto/parse/base.js";
import {
  DocumentAclController,
  DocumentNotFoundOrForbidden,
  MemoryDocumentAclRepository,
  type AclPrincipal,
  type AclResource,
  type AclRuleSeed,
  type AclSnapshot,
} from "./acl.js";
import {
  MemoryDocumentSecurityAuditRepository,
  type DocumentSecurityAuditEvent,
} from "./audit.js";
import { diffDocumentVersions, type DocumentVersionDiff } from "./diff.js";
import type { DocumentRepository, SearchChunkCandidate } from "./repository.js";
import {
  DocumentConflict,
  DocumentError,
  DocumentNotFound,
  levelOf,
  type AttachDocumentInput,
  type AttachedDocumentBundle,
  type AttachedParsedDoc,
  type DocumentAttachment,
  type DocumentListOptions,
  type DocumentManifestEntry,
  type DocumentMetadataPatch,
  type DocumentOpenResult,
  type DocumentReadResult,
  type DocumentScope,
  type DocumentSearchHit,
  type DocumentSearchOptions,
  type DocumentSearchResult,
  type DocumentSourceClass,
  type DocumentSummary,
  type DocumentVersion,
  type KnowledgeLevel,
  type PromoteResult,
  type PromoteSessionFileInput,
  type SearchCoverage,
  type SessionDocumentScope,
  type StoredDocumentChunk,
} from "./types.js";

export interface DocumentParser {
  parse(path: string, opts: { readonly fileId: string }): Promise<ParsedDoc>;
}

export interface DocumentServiceOptions {
  readonly repository: DocumentRepository;
  readonly workspaceRoot: string;
  readonly parser?: DocumentParser;
  /** 生产由 deps 注入 SQL ACL；窄单测默认使用同规则的内存实现。 */
  readonly acl?: DocumentAclController;
  readonly newId?: (kind: "document" | "version") => string;
  readonly now?: () => string;
}

const SOURCE_CLASSES: ReadonlySet<DocumentSourceClass> = new Set([
  "session_upload",
  "generated",
  "external",
  "imported",
]);

function principalOf(scope: DocumentScope): AclPrincipal {
  // 当前认证层只提供稳定的账号 id；组声明不能由 HTTP/model body 注入。
  // 主体是**发起调用的人**，不是项目 owner —— 取 owner 会让 acl.ts:445 的
  // `project_owner` 捷径恒真，规则永远轮不到执行。缺省退回 owner 是为了兼容
  // 还没接 actorId 的内部调用点，它们的行为与今天完全一致。
  return { id: scope.actorId ?? scope.owner, groupIds: [] };
}

function resourceKey(resource: AclResource): string {
  return [
    resource.scopeType,
    resource.documentId ?? "",
    resource.versionId ?? "",
    resource.chunkId ?? "",
  ].join("\u0000");
}

function defaultId(kind: "document" | "version"): string {
  const prefix = kind === "document" ? "doc" : "dv";
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function safeScope(scope: DocumentScope): void {
  if (!scope.projectId.trim() || !scope.owner.trim()) {
    throw new DocumentError(
      "INVALID_ARGUMENT",
      "项目知识库只能从已鉴权的项目会话中使用",
      400,
    );
  }
}

function safeSession(session: SessionDocumentScope): void {
  safeScope(session);
  if (!session.sessionId.trim()) {
    throw new DocumentError("INVALID_ARGUMENT", "缺少已鉴权的会话 ID", 400);
  }
}

function cleanText(value: string | undefined, fallback: string, label: string, max: number): string {
  const text = (value ?? fallback).trim();
  if (!text || text.includes("\u0000") || [...text].length > max) {
    throw new DocumentError("INVALID_ARGUMENT", `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`, 400);
  }
  return text;
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return [];
  const out = new Set<string>();
  for (const item of tags) {
    const tag = cleanText(item, "", "标签", 80);
    out.add(tag);
    if (out.size > 50) throw new DocumentError("INVALID_ARGUMENT", "一份文档最多设置 50 个标签", 400);
  }
  return [...out];
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeSegment(value: string, prefix: string): string {
  if (/^[A-Za-z0-9._-]{1,160}$/u.test(value) && value !== "." && value !== "..") return value;
  return `${prefix}_${sha256Hex(value).slice(0, 24)}`;
}

function safeFileName(name: string): string {
  const base = basename(name).replace(/[\u0000-\u001f\u007f]/gu, "_").trim();
  if (!base || base === "." || base === "..") return "document.bin";
  return [...base].slice(0, 220).join("");
}

function mediaType(name: string): string {
  const known: Readonly<Record<string, string>> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".sql": "application/sql",
    ".ddl": "application/sql",
    ".bpmn": "application/xml",
    ".xml": "application/xml",
    ".md": "text/markdown",
    ".txt": "text/plain",
  };
  return known[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 项目知识库领域服务。所有文件路径都由 workspaceRoot + 服务端 FileRow 解析；
 * 对外没有“传一个任意 path 让我读取”的方法。
 */
export class DocumentService {
  private readonly repository: DocumentRepository;
  private readonly workspaceRoot: string;
  private readonly parser: DocumentParser;
  private readonly acl: DocumentAclController;
  private readonly newId: (kind: "document" | "version") => string;
  private readonly now: () => string;

  constructor(options: DocumentServiceOptions) {
    this.repository = options.repository;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.parser = options.parser ?? defaultRegistry();
    if (options.acl === undefined) {
      const audit = new MemoryDocumentSecurityAuditRepository();
      this.acl = new DocumentAclController(new MemoryDocumentAclRepository(audit), audit);
    } else {
      this.acl = options.acl;
    }
    this.newId = options.newId ?? defaultId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(
    scope: DocumentScope,
    options: DocumentListOptions = {},
  ): Promise<readonly DocumentSummary[]> {
    safeScope(scope);
    const documents = await this.repository.list(scope, options.includeArchived === true);
    const plan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      documents.map((document) => ({ scopeType: "document", documentId: document.id })),
    );
    const allowed = new Set(plan.allowedTargets.map(resourceKey));
    const result = documents.filter((document) =>
      allowed.has(resourceKey({ scopeType: "document", documentId: document.id })),
    );
    await this.assertAclRevision(scope, plan.aclRevision);
    return result;
  }

  async history(scope: DocumentScope, documentId: string): Promise<readonly DocumentVersion[]> {
    safeScope(scope);
    const cleanId = cleanText(documentId, "", "文档 ID", 2_048);
    const documentAuthorization = await this.guardAcl(() => this.acl.authorizeRead(
      scope,
      principalOf(scope),
      { scopeType: "document", documentId: cleanId },
    ));
    const versions = await this.repository.history(scope, cleanId);
    const plan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      versions.map((version) => ({
        scopeType: "version",
        documentId: cleanId,
        versionId: version.id,
      })),
    );
    const allowed = new Set(plan.allowedTargets.map(resourceKey));
    const result = versions.filter((version) => allowed.has(resourceKey({
      scopeType: "version",
      documentId: cleanId,
      versionId: version.id,
    })));
    if (documentAuthorization.aclRevision !== plan.aclRevision) throw new DocumentNotFound();
    await this.assertAclRevision(scope, plan.aclRevision);
    return result;
  }

  /**
   * 打开一份材料，按原文顺序读。
   *
   * 在此之前，知识库里**存进去的文件根本没有打开入口**：只有 `search`（要关键词）
   * 和 `open`（要一个已经拿到的 evidence_ref）。用户刚传完一份 40 页的材料，
   * 想知道里面有什么，只能靠猜关键词——这是「知识库看不懂、用不起来」最直接的一条。
   *
   * ACL 与 search 走同一套两级裁决：先按 version 决定这一版能不能进，
   * 再按 chunk 逐段过滤，最后重新核对 ACL revision。**不因为「用户能看这份文档」
   * 就顺带把整版正文交出去。**
   */
  async read(
    scope: DocumentScope,
    documentId: string,
    options: {
      readonly versionId?: string;
      readonly offset?: number;
      readonly limit?: number;
    } = {},
  ): Promise<DocumentReadResult> {
    safeScope(scope);
    const cleanId = cleanText(documentId, "", "文档 ID", 2_048);
    const document = await this.guardAcl(() => this.acl.readAuthorized(
      scope,
      principalOf(scope),
      { scopeType: "document", documentId: cleanId },
      async () => await this.repository.get(scope, cleanId),
    ));
    if (document === null) throw new DocumentNotFound();
    // 不传 versionId 就读「采用版」；采用版没设过时退到最新版 —— 和检索的默认口径
    // 一致（repository 的 COALESCE(adopted,current)），否则「搜到的」和「读到的」
    // 会是两个不同的版本，那是最难查的一类不一致。
    const versionId = options.versionId === undefined || options.versionId === ""
      ? document.adoptedVersionId ?? document.currentVersionId
      : cleanText(options.versionId, "", "版本 ID", 2_048);
    const versionAuth = await this.guardAcl(() => this.acl.authorizeRead(
      scope,
      principalOf(scope),
      { scopeType: "version", documentId: cleanId, versionId },
    ));
    const page = await this.repository.chunksOfVersion(scope, cleanId, versionId, {
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (page.chunks.length === 0 && page.total === 0) {
      // 版本存在但一段都读不出来，和「没有这一版」是两件事；调用方靠 total=0 分辨。
      const stored = await this.repository.getVersion(scope, cleanId, versionId);
      if (stored === null) throw new DocumentNotFound("没有找到这一版材料");
      // 完整 ParsedDoc 永不越过服务边界 —— 和 promote/commit 两处同一个写法。
      const { parsedDoc: _parsedDoc, ...version } = stored;
      return {
        document,
        version,
        level: levelOf(scope),
        chunks: [],
        total: 0,
        offset: Math.max(0, Math.trunc(options.offset ?? 0)),
      };
    }
    const chunkPlan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      page.chunks.map((candidate) => ({
        scopeType: "chunk",
        documentId: cleanId,
        versionId,
        chunkId: candidate.chunk.chunkId,
      })),
    );
    const allowed = new Set(chunkPlan.allowedTargets.map(resourceKey));
    const level = levelOf(scope);
    const chunks = page.chunks
      .filter((candidate) => allowed.has(resourceKey({
        scopeType: "chunk",
        documentId: cleanId,
        versionId,
        chunkId: candidate.chunk.chunkId,
      })))
      // score=1 / coverage 空：阅读不是检索，这里没有「相关性」可言，
      // 借用 hit 形状只是为了让每一段自带 evidenceRef 和引用文案。
      .map((candidate) => hitOf(
        candidate,
        1,
        { matchedTerms: [], missingTerms: [], queryTerms: 0, ratio: 1 },
        level,
      ));
    if (versionAuth.aclRevision !== chunkPlan.aclRevision) throw new DocumentNotFound();
    await this.assertAclRevision(scope, chunkPlan.aclRevision);
    return {
      document,
      version: page.chunks[0]!.version,
      level,
      chunks,
      total: page.total,
      offset: Math.max(0, Math.trunc(options.offset ?? 0)),
    };
  }

  /**
   * 比较同一逻辑文档的两个不可变版本。
   *
   * 两个版本逐个重新经过 ACL 裁决，不能因为用户能看文档或其中一个版本，就顺带
   * 读取另一个版本。返回值仅含确定性差异投影；完整 ParsedDoc 永不越过服务边界。
   */
  async versionDiff(
    scope: DocumentScope,
    documentId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<DocumentVersionDiff> {
    safeScope(scope);
    const cleanDocumentId = cleanText(documentId, "", "文档 ID", 2_048);
    const cleanFromVersionId = cleanText(fromVersionId, "", "起点版本 ID", 2_048);
    const cleanToVersionId = cleanText(toVersionId, "", "终点版本 ID", 2_048);
    const [before, after] = await Promise.all([
      this.guardAcl(() => this.acl.readAuthorized(
        scope,
        principalOf(scope),
        {
          scopeType: "version",
          documentId: cleanDocumentId,
          versionId: cleanFromVersionId,
        },
        () => this.repository.getVersion(scope, cleanDocumentId, cleanFromVersionId),
      )),
      this.guardAcl(() => this.acl.readAuthorized(
        scope,
        principalOf(scope),
        {
          scopeType: "version",
          documentId: cleanDocumentId,
          versionId: cleanToVersionId,
        },
        () => this.repository.getVersion(scope, cleanDocumentId, cleanToVersionId),
      )),
    ]);
    const result = diffDocumentVersions(
      {
        documentId: cleanDocumentId,
        versionId: before.id,
        versionNo: before.versionNo,
        parsedDoc: before.parsedDoc,
      },
      {
        documentId: cleanDocumentId,
        versionId: after.id,
        versionNo: after.versionNo,
        parsedDoc: after.parsedDoc,
      },
    );
    // 解析和比较可能耗时；返回任何差异内容前，用精确版本再取一次最新 ACL。
    // 这不是事务级锁，但会封住最明显的“加载后撤权、仍把结果返回”窗口。
    const finalAuthorizations = await Promise.all([
      this.guardAcl(() => this.acl.authorizeRead(
        scope,
        principalOf(scope),
        { scopeType: "version", documentId: cleanDocumentId, versionId: cleanFromVersionId },
      )),
      this.guardAcl(() => this.acl.authorizeRead(
        scope,
        principalOf(scope),
        { scopeType: "version", documentId: cleanDocumentId, versionId: cleanToVersionId },
      )),
    ]);
    const finalRevision = finalAuthorizations[0]!.aclRevision;
    if (finalAuthorizations.some((authorization) => authorization.aclRevision !== finalRevision)) {
      throw new DocumentNotFound();
    }
    await this.assertAclRevision(scope, finalRevision);
    return result;
  }

  async promoteSessionFile(
    scope: DocumentScope,
    input: PromoteSessionFileInput,
  ): Promise<PromoteResult> {
    safeScope(scope);
    const source = input.source;
    const sessionId = cleanText(source.sessionId, "", "会话 ID", 256);
    const sourceName = cleanText(source.name, "", "文件名", 512);
    const requestedDocumentId = input.documentId?.trim();
    const existingId = requestedDocumentId === undefined || requestedDocumentId === ""
      ? undefined
      : cleanText(requestedDocumentId, "", "文档 ID", 2_048);
    await this.guardAcl(() => this.acl.authorizeWrite(
      scope,
      principalOf(scope),
      existingId === undefined
        ? { scopeType: "project" }
        : { scopeType: "document", documentId: existingId },
    ));
    if (!source.relPath || isAbsolute(source.relPath) || source.relPath.includes("\u0000")) {
      throw new DocumentError("INVALID_ARGUMENT", "服务端文件清单里的相对路径无效", 400);
    }
    if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) {
      throw new DocumentError("INVALID_ARGUMENT", "服务端文件清单里的大小无效", 400);
    }

    const root = await realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
    const sessionDir = resolve(root, sessionId);
    if (!pathInside(root, sessionDir)) {
      throw new DocumentError("FORBIDDEN", "会话目录不在 workspace 中", 404);
    }
    const declaredPath = resolve(root, source.relPath);
    if (!pathInside(sessionDir, declaredPath)) {
      throw new DocumentError("FORBIDDEN", "这份文件不属于当前会话", 404);
    }
    let sourcePath: string;
    try {
      sourcePath = await realpath(declaredPath);
    } catch {
      throw new DocumentNotFound(`当前会话里没有「${sourceName}」`);
    }
    const realSessionDir = await realpath(sessionDir).catch(() => sessionDir);
    if (!pathInside(realSessionDir, sourcePath) || basename(sourcePath) !== sourceName) {
      throw new DocumentError("FORBIDDEN", "文件清单与会话目录不一致", 404);
    }
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new DocumentError("INVALID_ARGUMENT", "知识库只接收普通文件", 400);
    const bytes = await readFile(sourcePath);
    const afterRead = await stat(sourcePath);
    if (
      bytes.byteLength !== source.sizeBytes ||
      info.size !== source.sizeBytes ||
      afterRead.size !== info.size ||
      afterRead.mtimeMs !== info.mtimeMs ||
      afterRead.ctimeMs !== info.ctimeMs
    ) {
      throw new DocumentError("INTEGRITY_ERROR", "文件在保存到知识库前发生了变化，请刷新后重试", 409);
    }
    const digest = sha256Hex(bytes);
    if (source.sha256 && source.sha256.toLowerCase() !== digest) {
      throw new DocumentError("INTEGRITY_ERROR", "文件内容与服务端清单的 SHA-256 不一致", 409);
    }

    let existing: DocumentSummary | null = null;
    if (existingId !== undefined && existingId !== "") {
      existing = await this.repository.get(scope, existingId);
      if (existing === null) throw new DocumentNotFound();
      if (existing.status !== "active") {
        throw new DocumentError("INVALID_ARGUMENT", "归档文档不能追加版本；请先恢复它", 409);
      }
      if (!input.baseVersionId || input.baseVersionId !== existing.currentVersionId) {
        throw new DocumentConflict(
          "BASE_VERSION_CONFLICT",
          "知识库里已经有更新版本，请先刷新版本历史",
          {
            expectedBaseVersionId: input.baseVersionId ?? null,
            actualVersionId: existing.currentVersionId,
          },
        );
      }
      const same = await this.repository.findVersionBySha(scope, existing.id, digest);
      if (same !== null) {
        const { parsedDoc: _parsedDoc, ...version } = same;
        return { document: existing, version, deduplicated: true };
      }
    } else if (input.baseVersionId !== undefined) {
      throw new DocumentError("INVALID_ARGUMENT", "新文档不能指定 baseVersionId", 400);
    }

    const documentId = existing?.id ?? this.newId("document");
    const versionId = this.newId("version");
    const createdAt = this.now();
    const projectDir = safeSegment(scope.projectId, "project");
    const versionDir = join(
      root,
      "projects",
      projectDir,
      "documents",
      safeSegment(documentId, "document"),
      safeSegment(versionId, "version"),
    );
    const destination = join(versionDir, "original", safeFileName(sourceName));
    await mkdir(dirname(destination), { recursive: true });
    let persisted = false;
    try {
      // `wx` 是不可变版本的最后一道保险：随机 id 即使意外碰撞，也只能失败，绝不能
      // 像 POSIX rename 那样把已有版本原文件原子覆盖掉。
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      // 不解析会话里的可变文件，而解析刚刚落下的不可变快照，堵住 hash 与解析内容
      // 之间的 TOCTOU 窗口。
      let parsed: ParsedDoc;
      try {
        parsed = await this.parser.parse(destination, { fileId: versionId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 文件主库和解析器不是同一个真相层。解析器暂时不认识格式、损坏或缺少 OCR
        // 时，仍要先保住已经通过 SHA 校验的不可变原件；否则用户会误以为文件已进
        // 项目库，实际却什么都没留下。零切片的 degraded 版本不会被 AI 当成证据，
        // 后续可从“处理任务”明确重试或换 OCR/解析器。
        parsed = makeParsedDoc({ fileId: versionId, fileName: sourceName, kind: "unknown" });
        parsed.findings.push(makeFinding(
          "parse_failed",
          `原文件已保存，但暂时没有读出可搜索正文：${detail}`.slice(0, 2_000),
          { file: sourceName },
          "warn",
        ));
        parsed.meta = { ingestion: "stored_unparsed" };
      }
      let normalized: ParsedDoc;
      try {
        normalized = normalizeParsedDoc(parsed, versionId, sourceName);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        normalized = makeParsedDoc({ fileId: versionId, fileName: sourceName, kind: "unknown" });
        normalized.findings.push(makeFinding(
          "parse_result_invalid",
          `原文件已保存，但解析结果没有通过完整性检查：${detail}`.slice(0, 2_000),
          { file: sourceName },
          "warn",
        ));
        normalized.meta = { ingestion: "stored_unparsed" };
      }
      const chunks = chunksOf(documentId, versionId, normalized);
      const parserName = cleanText(input.parserName, "default-registry", "解析器名称", 120);
      const parserVersion = cleanText(input.parserVersion, "1", "解析器版本", 120);
      const indexRevision = sha256Hex(
        canonicalJson({
          parser_name: parserName,
          parser_version: parserVersion,
          chunks: chunks.map((c) => ({
            id: c.chunkId,
            locator: c.locator,
            text_sha256: c.textSha256,
          })),
        }),
      ).slice(0, 32);
      const relativePath = relative(root, destination).split(sep).join("/");
      if (relativePath.startsWith("../") || isAbsolute(relativePath)) {
        throw new DocumentError("INTEGRITY_ERROR", "知识库文件没有落在 workspace 内", 500);
      }
      const sourceClass = input.sourceClass ?? "session_upload";
      if (!SOURCE_CLASSES.has(sourceClass)) {
        throw new DocumentError("INVALID_ARGUMENT", "不支持的文档来源分类", 400);
      }
      // 图片、纯扫描 PDF 在不触发付费视觉模型的入库阶段可能得到 0 个切片，并带
      // vision_pending/info。它们绝不能显示成“已读入”：零正文和任何降级发现都只
      // 能标为 degraded，后续问答会因无证据 fail closed。
      const parseStatus = normalized.chunks.length === 0 || normalized.findings.some(
        (f) => f.severity === "warn" || f.kind === "vision_pending" || f.kind === "page_limit",
      )
        ? "degraded"
        : "ready";
      const title = cleanText(input.title, sourceName, "标题", 200);
      const logicalName = cleanText(
        input.logicalName,
        basename(sourceName, extname(sourceName)) || sourceName,
        "文档名称",
        200,
      );
      const committed = await this.repository.commitVersion({
        scope,
        documentId,
        ...(existing === null
          ? {
              newDocument: {
                id: documentId,
                title,
                logicalName,
                sourceClass,
                tags: cleanTags(input.tags),
                createdBy: cleanText(input.createdBy, scope.owner, "创建人", 256),
                createdAt,
              },
            }
          : {}),
        ...(existing === null ? {} : { baseVersionId: input.baseVersionId! }),
        version: {
          id: versionId,
          documentId,
          fileName: sourceName,
          mediaType: cleanText(input.mediaType, mediaType(sourceName), "媒体类型", 160),
          sizeBytes: bytes.byteLength,
          sha256: digest,
          relPath: relativePath,
          docKind: normalized.kind,
          parsedDoc: normalized,
          parseStatus,
          parserName,
          parserVersion,
          indexRevision,
          chunkCount: chunks.length,
          createdBy: cleanText(input.createdBy, scope.owner, "创建人", 256),
          createdAt,
        },
        chunks,
      });
      persisted = !committed.deduplicated;
      if (committed.deduplicated) await rm(versionDir, { recursive: true, force: true });
      const { parsedDoc: _parsedDoc, ...version } = committed.version;
      return { document: committed.document, version, deduplicated: committed.deduplicated };
    } finally {
      if (!persisted) {
        // 只清理由本次随机 versionId 创建的精确目录，不碰 document/project 父目录。
        await rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async search(scope: DocumentScope, options: DocumentSearchOptions): Promise<DocumentSearchResult> {
    safeScope(scope);
    const query = cleanText(options.query, "", "搜索内容", 2_000);
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DocumentError("INVALID_ARGUMENT", "limit 必须在 1 到 100 之间", 400);
    }
    const requestedIds = options.documentIds?.map((id) => cleanText(id, "", "文档 ID", 2_048));
    const documentFilter = requestedIds === undefined ? null : new Set(requestedIds);
    const selected = options.sessionId === undefined
      ? (await this.repository.list(scope, false))
          .filter((row) => documentFilter === null || documentFilter.has(row.id))
          .map((row) => ({ documentId: row.id, versionId: row.adoptedVersionId ?? row.currentVersionId }))
      : (await this.repository.listAttachments(scope, {
          sessionId: cleanText(options.sessionId, "", "会话 ID", 256),
          projectId: scope.projectId,
          owner: scope.owner,
        }))
          .filter((row) => documentFilter === null || documentFilter.has(row.documentId))
          .map((row) => ({ documentId: row.documentId, versionId: row.versionId }));
    // 文本、标题、标签都不能先进入召回再做结果过滤。这里只把不含正文的资源 ID
    // 交给 ACL，得到精确版本白名单后，仓储查询才会真正读取 chunk。
    const plan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      selected.map((row) => ({
        scopeType: "version",
        documentId: row.documentId,
        versionId: row.versionId,
      })),
      {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        querySha256: sha256Hex(query),
      },
    );
    const allowed = new Set(plan.allowedTargets.map(resourceKey));
    const allowedSelected = selected.filter((row) => allowed.has(resourceKey({
      scopeType: "version",
      documentId: row.documentId,
      versionId: row.versionId,
    })));
    const allowedDocumentIds = [...new Set(allowedSelected.map((row) => row.documentId))];
    const selectedVersions = allowedSelected.map((row) => row.versionId);
    const recalled = await this.repository.chunksForSearch(scope, {
      // 空数组必须原样传下去；省略它会退化成“检索整个项目”。
      documentIds: allowedDocumentIds,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
    // version 白名单负责“哪些文档可以进入召回”；chunk 白名单再负责“召回出的
    // 哪些段落可以进入打分/响应”。这样 chunk 级显式 deny 也不会把正文返回给调用方。
    const chunkPlan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      recalled.map((candidate) => ({
        scopeType: "chunk",
        documentId: candidate.document.id,
        versionId: candidate.version.id,
        chunkId: candidate.chunk.chunkId,
      })),
      {
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        querySha256: sha256Hex(query),
      },
    );
    const allowedChunks = new Set(chunkPlan.allowedTargets.map(resourceKey));
    const candidates = recalled.filter((candidate) => allowedChunks.has(resourceKey({
      scopeType: "chunk",
      documentId: candidate.document.id,
      versionId: candidate.version.id,
      chunkId: candidate.chunk.chunkId,
    })));
    const level = levelOf(scope);
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) {
      throw new DocumentError("INVALID_ARGUMENT", "搜索内容没有可检索的文字", 400);
    }
    const corpus = candidates.map((candidate) => ({
      candidate,
      terms: tokenize(
        `${candidate.document.title} ${candidate.document.logicalName} ${candidate.document.tags.join(" ")} ` +
          `${candidate.chunk.context} ${candidate.chunk.render}`,
      ),
    }));
    const avgLength = corpus.length === 0
      ? 1
      : corpus.reduce((sum, row) => sum + row.terms.length, 0) / corpus.length;
    const df = new Map<string, number>();
    for (const row of corpus) {
      for (const term of new Set(row.terms)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const scored: DocumentSearchHit[] = [];
    for (const row of corpus) {
      const counts = new Map<string, number>();
      for (const term of row.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      const coverage = coverageOf(queryTerms, new Set(row.terms));
      if (coverage.matchedTerms.length === 0) continue;
      let score = 0;
      for (const term of queryTerms) {
        const tf = counts.get(term) ?? 0;
        if (tf === 0) continue;
        const present = df.get(term) ?? 0;
        const idf = Math.log(1 + (corpus.length - present + 0.5) / (present + 0.5));
        const denom = tf + 1.2 * (1 - 0.75 + (0.75 * row.terms.length) / avgLength);
        score += idf * ((tf * 2.2) / denom);
      }
      // 词覆盖是“这段材料能否回答问题”的透明信号；只做轻微加权，不伪装成置信度。
      score *= 0.5 + coverage.ratio * 0.5;
      scored.push(hitOf(row.candidate, Number(score.toFixed(6)), coverage, level));
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.documentId.localeCompare(b.documentId) ||
        a.versionNo - b.versionNo ||
        a.chunkId.localeCompare(b.chunkId),
    );
    const hits = scored.slice(0, limit);
    // 覆盖率必须按**全部命中**算，不是按截断后剩下的那些算。
    // 旧写法用 `hits`，于是一个只在被丢弃命中里出现过的词会被报成「未命中」——
    // 在一个把「没搜到 ≠ 材料里没有」写进文案的产品里，这是最不该出的那类谎。
    const matched = new Set(scored.flatMap((hit) => hit.coverage.matchedTerms));
    await this.assertAclRevision(scope, chunkPlan.aclRevision);
    return {
      query,
      hits,
      // 截断前的总数。界面上写「找到 N 处材料片段」，没有这个数那句话在超过
      // limit 时就是假的。
      total: scored.length,
      // 即使某个版本还没有可搜索正文，也要如实说明它属于本次范围；否则空命中会
      // 把“选中了但没读到”伪装成“没有这份文档”。
      searchedVersions: [...new Set(selectedVersions)].sort(),
      coverage: coverageOf(queryTerms, matched),
    };
  }

  async open(
    scope: DocumentScope,
    options: { readonly evidenceRef: string },
  ): Promise<DocumentOpenResult> {
    safeScope(scope);
    const decoded = decodeEvidenceRef(options.evidenceRef);
    if (decoded === null) throw new DocumentNotFound("没有找到这条知识库证据");
    const resource: AclResource = {
      scopeType: "chunk",
      documentId: decoded.documentId,
      versionId: decoded.versionId,
      chunkId: decoded.chunkId,
    };
    const candidate = await this.guardAcl(() => this.acl.readAuthorized(
      scope,
      principalOf(scope),
      resource,
      () => this.repository.getChunk(
        scope,
        decoded.documentId,
        decoded.versionId,
        decoded.chunkId,
      ),
    ));
    const actual = sha256Hex(candidate.chunk.render);
    if (actual !== candidate.chunk.textSha256) {
      throw new DocumentError("INTEGRITY_ERROR", "证据正文的校验值不一致，已拒绝返回", 500);
    }
    // search 命中和首次读取都不是长期授权票据；真正构造返回值前再加载最新 ACL。
    await this.guardAcl(() => this.acl.authorizeRead(scope, principalOf(scope), resource));
    return {
      ...hitOf(candidate, 1, { matchedTerms: [], missingTerms: [], queryTerms: 0, ratio: 1 }, levelOf(scope)),
      raw: structuredClone(candidate.chunk.raw),
      context: candidate.chunk.context,
      tags: [...candidate.chunk.tags],
    };
  }

  async updateMetadata(
    scope: DocumentScope,
    documentId: string,
    patch: DocumentMetadataPatch,
  ): Promise<DocumentSummary> {
    safeScope(scope);
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0) {
      throw new DocumentError("INVALID_ARGUMENT", "expectedRevision 必须是非负整数", 400);
    }
    if (
      patch.title === undefined &&
      patch.logicalName === undefined &&
      patch.sourceClass === undefined &&
      patch.tags === undefined
    ) {
      throw new DocumentError("INVALID_ARGUMENT", "没有需要更新的文档信息", 400);
    }
    if (patch.sourceClass !== undefined && !SOURCE_CLASSES.has(patch.sourceClass)) {
      throw new DocumentError("INVALID_ARGUMENT", "不支持的文档来源分类", 400);
    }
    const cleanId = cleanText(documentId, "", "文档 ID", 2_048);
    await this.guardAcl(() => this.acl.authorizeWrite(
      scope,
      principalOf(scope),
      { scopeType: "document", documentId: cleanId },
    ));
    return this.repository.updateMetadata(scope, cleanId, {
      expectedRevision: patch.expectedRevision,
      ...(patch.title === undefined ? {} : { title: cleanText(patch.title, "", "标题", 200) }),
      ...(patch.logicalName === undefined
        ? {}
        : { logicalName: cleanText(patch.logicalName, "", "文档名称", 200) }),
      ...(patch.sourceClass === undefined ? {} : { sourceClass: patch.sourceClass }),
      ...(patch.tags === undefined ? {} : { tags: cleanTags(patch.tags) }),
    });
  }

  async adopt(
    scope: DocumentScope,
    documentId: string,
    input: { readonly versionId: string; readonly expectedRevision: number },
  ): Promise<DocumentSummary> {
    safeScope(scope);
    const cleanDocumentId = cleanText(documentId, "", "文档 ID", 2_048);
    const cleanVersionId = cleanText(input.versionId, "", "版本 ID", 2_048);
    await this.guardAcl(() => this.acl.authorizeWrite(
      scope,
      principalOf(scope),
      { scopeType: "version", documentId: cleanDocumentId, versionId: cleanVersionId },
    ));
    return this.repository.adopt(
      scope,
      cleanDocumentId,
      cleanVersionId,
      input.expectedRevision,
    );
  }

  async archive(
    scope: DocumentScope,
    documentId: string,
    input: { readonly archived: boolean; readonly expectedRevision: number },
  ): Promise<DocumentSummary> {
    safeScope(scope);
    const cleanDocumentId = cleanText(documentId, "", "文档 ID", 2_048);
    await this.guardAcl(() => this.acl.authorizeWrite(
      scope,
      principalOf(scope),
      { scopeType: "document", documentId: cleanDocumentId },
    ));
    return this.repository.archive(
      scope,
      cleanDocumentId,
      input.archived,
      input.expectedRevision,
    );
  }

  async attach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    input: AttachDocumentInput,
  ): Promise<DocumentAttachment> {
    safeSession(session);
    if (scope.projectId !== session.projectId || scope.owner !== session.owner) {
      throw new DocumentError("FORBIDDEN", "会话不属于当前项目知识库", 404);
    }
    const documentId = cleanText(input.documentId, "", "文档 ID", 2_048);
    const versionId = cleanText(input.versionId, "", "版本 ID", 2_048);
    // attach 会让 Harness 随后读到该固定版本，因此挂载前按版本重新鉴权。
    await this.guardAcl(() => this.acl.authorizeRead(
      scope,
      principalOf(scope),
      { scopeType: "version", documentId, versionId },
      { sessionId: session.sessionId },
    ));
    return this.repository.attach(
      scope,
      session,
      documentId,
      versionId,
      input.role ?? "reference",
      cleanText(input.attachedBy, scope.owner, "操作人", 256),
      this.now(),
    );
  }

  async detach(
    scope: DocumentScope,
    session: SessionDocumentScope,
    documentId: string,
  ): Promise<boolean> {
    safeScope(scope);
    safeSession(session);
    if (scope.projectId !== session.projectId || scope.owner !== session.owner) {
      throw new DocumentError("FORBIDDEN", "会话不属于当前项目知识库", 404);
    }
    const cleanDocumentId = cleanText(documentId, "", "文档 ID", 2_048);
    const attachment = (await this.repository.listAttachments(scope, session))
      .find((item) => item.documentId === cleanDocumentId);
    if (attachment === undefined) return false;
    const resource: AclResource = {
      scopeType: "version",
      documentId: cleanDocumentId,
      versionId: attachment.versionId,
    };
    // 解除的是会话本地引用，不改写项目文档，所以要求精确版本 read，而不是借用
    // document.write。鉴权紧贴条件 DELETE；若并发换成另一版本，仓储不会误删。
    await this.guardAcl(() => this.acl.authorizeRead(
      scope,
      principalOf(scope),
      resource,
      { sessionId: session.sessionId },
    ));
    return this.repository.detach(
      scope,
      session,
      cleanDocumentId,
      attachment.versionId,
    );
  }

  async listAttachments(
    scope: DocumentScope,
    session: SessionDocumentScope,
  ): Promise<readonly DocumentAttachment[]> {
    safeSession(session);
    const attachments = await this.repository.listAttachments(scope, session);
    const plan = await this.acl.filterSearchTargets(
      scope,
      principalOf(scope),
      attachments.map((attachment) => ({
        scopeType: "version",
        documentId: attachment.documentId,
        versionId: attachment.versionId,
      })),
      { sessionId: session.sessionId },
    );
    const allowed = new Set(plan.allowedTargets.map(resourceKey));
    const result = attachments.filter((attachment) => allowed.has(resourceKey({
      scopeType: "version",
      documentId: attachment.documentId,
      versionId: attachment.versionId,
    })));
    await this.assertAclRevision(scope, plan.aclRevision);
    return result;
  }

  /** 详细读法供 UI/API；dangling attachment 一律报错，不静默少读一份材料。 */
  async loadAttached(session: SessionDocumentScope): Promise<AttachedParsedDoc[]> {
    safeSession(session);
    const scope: DocumentScope = { projectId: session.projectId, owner: session.owner };
    const attachments = await this.repository.listAttachments(scope, session);
    const out: AttachedParsedDoc[] = [];
    for (const attachment of attachments) {
      // 列表/搜索时的裁决不是长期票据。即使附件早已挂载，Harness 每次真正加载
      // ParsedDoc 前仍重新取 ACL 快照，撤权后不会继续把旧材料喂给模型。
      await this.guardAcl(() => this.acl.authorizeRead(
        scope,
        principalOf(scope),
        {
          scopeType: "version",
          documentId: attachment.documentId,
          versionId: attachment.versionId,
        },
        { sessionId: session.sessionId },
      ));
      const [document, version] = await Promise.all([
        this.repository.get(scope, attachment.documentId),
        this.repository.getVersion(scope, attachment.documentId, attachment.versionId),
      ]);
      if (document === null || version === null) {
        throw new DocumentError(
          "INTEGRITY_ERROR",
          `会话挂载 ${attachment.documentId}/${attachment.versionId} 已失去对应版本`,
          500,
        );
      }
      // ParsedDoc 可能很大；加载完成后、克隆/返回给 Harness 前再按固定版本验权。
      const authorization = await this.guardAcl(() => this.acl.authorizeRead(
        scope,
        principalOf(scope),
        {
          scopeType: "version",
          documentId: attachment.documentId,
          versionId: attachment.versionId,
        },
        { sessionId: session.sessionId },
      ));
      const { parsedDoc, ...publicVersion } = version;
      out.push({
        document,
        version: publicVersion,
        attachment,
        parsedDoc: structuredClone(parsedDoc),
        manifest: {
          projectId: session.projectId,
          documentId: document.id,
          versionId: version.id,
          contentSha256: version.sha256,
          parserVersion: version.parserVersion,
          indexRevision: version.indexRevision,
          aclRevision: authorization.aclRevision,
        },
      });
    }
    if (out.length > 0) {
      const finalRevision = await this.acl.currentRevision(scope);
      if (out.some((item) => item.manifest.aclRevision !== finalRevision)) {
        throw new DocumentNotFound();
      }
    }
    return out;
  }

  /** 返回 ACL 管理快照；项目边界和 actor 都只能来自已鉴权 scope。 */
  async aclSnapshot(scope: DocumentScope): Promise<AclSnapshot> {
    safeScope(scope);
    return this.guardAcl(() => this.acl.snapshotForManagement(scope, principalOf(scope)));
  }

  /** 全量 CAS 替换，避免增删多条规则时出现半套权限。 */
  async replaceAclRules(
    scope: DocumentScope,
    input: { readonly expectedRevision: number; readonly rules: readonly AclRuleSeed[] },
  ): Promise<AclSnapshot> {
    safeScope(scope);
    try {
      return await this.acl.replaceRules(principalOf(scope), {
        boundary: scope,
        expectedRevision: input.expectedRevision,
        rules: input.rules,
      });
    } catch (error) {
      if (error instanceof DocumentNotFoundOrForbidden) throw new DocumentNotFound();
      throw error;
    }
  }

  /** 只允许 ACL 管理者读取结构化安全审计；事件模型本身不含正文和原始 query。 */
  async securityAudit(
    scope: DocumentScope,
    limit = 100,
  ): Promise<readonly DocumentSecurityAuditEvent[]> {
    safeScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new DocumentError("INVALID_ARGUMENT", "limit 必须在 1 到 200 之间", 400);
    }
    return this.guardAcl(() => this.acl.securityAudit(scope, principalOf(scope), limit));
  }

  async manifest(session: SessionDocumentScope): Promise<DocumentManifestEntry[]> {
    return (await this.loadAttached(session)).map((item) => ({
      project_id: session.projectId,
      document_id: item.document.id,
      version_id: item.version.id,
      sha256: item.version.sha256,
      index_revision: item.version.indexRevision,
      acl_revision: item.manifest.aclRevision,
      title: item.document.title,
      file_name: item.version.fileName,
      version_no: item.version.versionNo,
      parse_status: item.version.parseStatus,
      parser_version: item.version.parserVersion,
    }));
  }

  async loadAttachedParsedDocs(session: SessionDocumentScope): Promise<AttachedDocumentBundle> {
    const attached = await this.loadAttached(session);
    return {
      // EvidenceIndex 的 cite 默认由 file_name + locator 组成。若仍用原文件名，两个
      // 不可变版本（甚至两份同名逻辑文档）会得到同一个 cite，发布门会把它们的原文
      // 合在一起，错误版本就可能给结论背书。Harness 输入因此使用可解析的固定版本
      // 前缀；manifest/UI 仍显示原文件名。
      documents: attached.map((item) => pinnedParsedDoc(item)),
      manifest: attached.map((item) => ({
        project_id: session.projectId,
        document_id: item.document.id,
        version_id: item.version.id,
        sha256: item.version.sha256,
        index_revision: item.version.indexRevision,
        acl_revision: item.manifest.aclRevision,
        title: item.document.title,
        file_name: item.version.fileName,
        version_no: item.version.versionNo,
        parse_status: item.version.parseStatus,
        parser_version: item.version.parserVersion,
      })),
    };
  }

  private async guardAcl<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DocumentNotFoundOrForbidden) throw new DocumentNotFound();
      throw error;
    }
  }

  private async assertAclRevision(scope: DocumentScope, expectedRevision: number): Promise<void> {
    if ((await this.acl.currentRevision(scope)) !== expectedRevision) {
      throw new DocumentNotFound();
    }
  }
}

function pinnedParsedDoc(item: AttachedParsedDoc): ParsedDoc {
  const source = structuredClone(item.parsedDoc);
  const pinnedName = `DOC[${item.document.id}@${item.version.id}] ${item.version.fileName}`;
  return {
    ...source,
    file_name: pinnedName,
    chunks: source.chunks.map((chunk) => ({
      ...chunk,
      file_name: pinnedName,
      locator: {
        ...chunk.locator,
        _document_id: item.document.id,
        _version_id: item.version.id,
        _chunk_id: chunk.chunk_id,
      },
    })),
    meta: {
      ...(source.meta ?? {}),
      ontodocument: {
        document_id: item.document.id,
        version_id: item.version.id,
        version_no: item.version.versionNo,
        original_file_name: item.version.fileName,
      },
    },
  };
}

function normalizeParsedDoc(parsed: ParsedDoc, versionId: string, sourceName: string): ParsedDoc {
  const seen = new Set<string>();
  const chunks = parsed.chunks.map((chunk) => {
    if (!chunk.chunk_id || seen.has(chunk.chunk_id)) {
      throw new DocumentError("PARSE_FAILED", "解析器生成了空白或重复的 chunk_id", 422);
    }
    if (chunk.file_id !== versionId) {
      throw new DocumentError("PARSE_FAILED", "解析器返回的 file_id 与固定版本不一致", 422);
    }
    if (typeof chunk.locator !== "object" || chunk.locator === null || Array.isArray(chunk.locator)) {
      throw new DocumentError("PARSE_FAILED", `切片 ${chunk.chunk_id} 没有可核验的 locator`, 422);
    }
    seen.add(chunk.chunk_id);
    return {
      ...chunk,
      file_name: sourceName,
      raw: chunk.raw ?? null,
      tags: [...chunk.tags],
      locator: structuredClone(chunk.locator),
    };
  });
  return {
    file_id: versionId,
    file_name: sourceName,
    kind: parsed.kind,
    chunks,
    structured: structuredClone(parsed.structured),
    findings: structuredClone(parsed.findings),
    meta: structuredClone(parsed.meta),
  };
}

function chunksOf(documentId: string, versionId: string, doc: ParsedDoc): StoredDocumentChunk[] {
  return doc.chunks.map((chunk) => ({
    documentId,
    versionId,
    chunkId: chunk.chunk_id,
    order: chunk.order,
    locator: structuredClone(chunk.locator),
    render: chunk.render,
    raw: structuredClone(chunk.raw),
    tags: [...chunk.tags],
    context: chunk.context,
    textSha256: sha256Hex(chunk.render),
  }));
}

function tokenize(input: string): string[] {
  const normalized = input.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
    const token = match[0];
    if (/^[a-z0-9_]+$/u.test(token)) {
      if (token.length > 1) out.push(token);
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) out.push(chars[0]!);
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i]! + chars[i + 1]!);
  }
  return out;
}

function coverageOf(queryTerms: readonly string[], available: ReadonlySet<string>): SearchCoverage {
  const unique = [...new Set(queryTerms)];
  const matchedTerms = unique.filter((term) => available.has(term));
  const missingTerms = unique.filter((term) => !available.has(term));
  return {
    matchedTerms,
    missingTerms,
    queryTerms: unique.length,
    ratio: unique.length === 0 ? 1 : Number((matchedTerms.length / unique.length).toFixed(6)),
  };
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded && encodePart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function evidenceRef(candidate: SearchChunkCandidate): string {
  return `odoc.v1.${encodePart(candidate.document.id)}.${encodePart(candidate.version.id)}.${encodePart(candidate.chunk.chunkId)}`;
}

function decodeEvidenceRef(
  value: string,
): { readonly documentId: string; readonly versionId: string; readonly chunkId: string } | null {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== "odoc" || parts[1] !== "v1") return null;
  const documentId = decodePart(parts[2]!);
  const versionId = decodePart(parts[3]!);
  const chunkId = decodePart(parts[4]!);
  return documentId === null || versionId === null || chunkId === null
    ? null
    : { documentId, versionId, chunkId };
}

function cite(candidate: SearchChunkCandidate, level: KnowledgeLevel): string {
  const locator = candidate.chunk.locator;
  const preferred = ["sheet", "section", "page", "row", "cell", "path", "line", "paragraph"];
  const details: string[] = [];
  for (const key of preferred) {
    if (Object.hasOwn(locator, key) && locator[key] !== null && locator[key] !== "") {
      details.push(`${key}=${String(locator[key])}`);
    }
  }
  const suffix = details.length > 0 ? details.join("，") : canonicalJson(locator);
  // 总库的片段必须在引用里就说清楚。FDE 读到一句带引用的结论时，
  // 「这是行业通用做法」和「这是这个客户自己的规定」是两件完全不同的事。
  // 项目库不加前缀 —— 默认语境就是这个项目，加了反而是噪音。
  const prefix = level === "global" ? "总库 " : "";
  return `${candidate.document.title}（${prefix}v${candidate.version.versionNo}，${suffix || `chunk=${candidate.chunk.chunkId}`}）`;
}

function hitOf(
  candidate: SearchChunkCandidate,
  score: number,
  coverage: SearchCoverage,
  level: KnowledgeLevel,
): DocumentSearchHit {
  const actual = sha256Hex(candidate.chunk.render);
  if (actual !== candidate.chunk.textSha256) {
    throw new DocumentError("INTEGRITY_ERROR", "检索切片的正文校验值不一致", 500);
  }
  return {
    evidenceRef: evidenceRef(candidate),
    displayCite: cite(candidate, level),
    level,
    documentId: candidate.document.id,
    versionId: candidate.version.id,
    versionNo: candidate.version.versionNo,
    documentTitle: candidate.document.title,
    fileName: candidate.version.fileName,
    chunkId: candidate.chunk.chunkId,
    locator: structuredClone(candidate.chunk.locator),
    text: candidate.chunk.render,
    textSha256: candidate.chunk.textSha256,
    score,
    coverage,
  };
}
