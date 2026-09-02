import type { ParsedDoc } from "../onto/parse/base.js";

/**
 * OntoDocument 的项目级安全边界。调用方只能从已鉴权的 Session/Project 派生它，
 * 绝不能把模型或 HTTP body 里的 projectId/owner 原样传进来。
 */
export interface DocumentScope {
  readonly projectId: string;
  /**
   * **存储边界** —— 项目的 owner，不是发起调用的人。
   *
   * 知识库是项目资产：同一个项目下的人必须看到同一个库。这个字段进每一条 WHERE，
   * 所以它一旦取成当前登录者，「项目知识库」就退化成一个挂着项目牌子的私人文件夹。
   * ACL 侧一直用的是这个含义 —— acl.ts:445 那条命中理由就叫 `project_owner`。
   */
  readonly owner: string;
  /**
   * **鉴权主体** —— 真正发起这次调用的人；缺省时退回 `owner`。
   *
   * 必须和 `owner` 分开：`principalOf`（service.ts:70）拿它去和 ACL 的
   * `boundary.owner` 比。两者合一时 `principal.id === boundary.owner` 恒成立，
   * ACL 的 `project_owner` 捷径永远命中，整套规则形同虚设 —— 今天正是如此。
   * 分开之后，项目 owner 仍走捷径，其他人才真的落到规则上。
   */
  readonly actorId?: string;
}

/** 已由服务端加载并校验过的会话身份。 */
export interface SessionDocumentScope extends DocumentScope {
  readonly sessionId: string;
}

/**
 * 知识库层级。
 *
 * - `global` 总知识库：一个部署一个，直接访问，不依赖会话也不依赖项目。
 *   装跨项目复用的东西 —— 行业标准、通用制度、模板、历史沉淀。
 * - `project` 项目知识库：装这个项目自己的材料。
 *
 * 两级必须在**每一条命中**上可分辨。把一份行业通用制度当成这个客户自己的规定，
 * 是这个产品最不能出的错 —— 它整套价值就建立在「业务结论 → 支撑片段 → 文件版本」
 * 这条链上，链的第一环认错了层级，后面全部白做。
 */
export type KnowledgeLevel = "global" | "project";

/**
 * 总知识库的保留存储边界。
 *
 * 复用同一套表，不新建 schema：真项目 id 是 `shortId()` 出来的 12 位十六进制
 * （`routes/sessions.ts` 的 randomUUID 去横杠取 12 位），撞不上这两个值 ——
 * 和侧栏那个 `__unfiled__` 哨兵是同一个手法。
 *
 * `owner` 用部署级常量而不是某个人：总库是**共享**的，这也正是 ACL 第一次真正
 * 承担职责的地方 —— `principalOf` 现在用 `actorId` 而不是 `owner`，规则才能真的命中。
 */
export const GLOBAL_LIBRARY_PROJECT_ID = "__global__";
export const GLOBAL_LIBRARY_OWNER = "__global__";

/** 总知识库的作用域。`actorId` 仍是发起调用的真人，用于 ACL 裁决。 */
export function globalLibraryScope(actorId: string): DocumentScope {
  return {
    projectId: GLOBAL_LIBRARY_PROJECT_ID,
    owner: GLOBAL_LIBRARY_OWNER,
    actorId,
  };
}

/** 一个作用域落在哪一层。 */
export function levelOf(scope: { readonly projectId: string }): KnowledgeLevel {
  return scope.projectId === GLOBAL_LIBRARY_PROJECT_ID ? "global" : "project";
}

/** 层级的中文说法。命中卡片、引用文案、模型看到的工具结果都用它，保持一致。 */
export function levelLabel(level: KnowledgeLevel): string {
  return level === "global" ? "总库" : "项目库";
}

export type DocumentStatus = "active" | "archived";
export type DocumentSourceClass = "session_upload" | "generated" | "external" | "imported";
export type DocumentParseStatus = "ready" | "degraded";
export type DocumentAttachmentRole = "reference" | "primary";

export type DocumentErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "REVISION_CONFLICT"
  | "BASE_VERSION_CONFLICT"
  | "INTEGRITY_ERROR"
  | "PARSE_FAILED";

export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocumentError";
    Object.setPrototypeOf(this, DocumentError.prototype);
  }
}

export class DocumentNotFound extends DocumentError {
  constructor(message = "没有找到这份项目文档") {
    super("NOT_FOUND", message, 404);
    this.name = "DocumentNotFound";
    Object.setPrototypeOf(this, DocumentNotFound.prototype);
  }
}

export class DocumentForbidden extends DocumentError {
  constructor(message = "无权访问这份项目文档") {
    // 对外仍用 404，避免用 id 探测别的项目/用户是否有这份文档。
    super("FORBIDDEN", message, 404);
    this.name = "DocumentForbidden";
    Object.setPrototypeOf(this, DocumentForbidden.prototype);
  }
}

export class DocumentConflict extends DocumentError {
  constructor(
    code: "REVISION_CONFLICT" | "BASE_VERSION_CONFLICT",
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, 409, details);
    this.name = "DocumentConflict";
    Object.setPrototypeOf(this, DocumentConflict.prototype);
  }
}

export interface DocumentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly title: string;
  readonly logicalName: string;
  readonly sourceClass: DocumentSourceClass;
  readonly tags: readonly string[];
  readonly status: DocumentStatus;
  /** 最新写入的版本；它不等于“已采用版本”。 */
  readonly currentVersionId: string;
  /** 人工采用的版本。新文档的首版自动采用，后续版本不会静默顶替。 */
  readonly adoptedVersionId: string | null;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** 相对 workspace 根；库里永远不持久化绝对路径。 */
  readonly relPath: string;
  readonly docKind: string;
  readonly parseStatus: DocumentParseStatus;
  readonly parserName: string;
  readonly parserVersion: string;
  readonly indexRevision: string;
  readonly chunkCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** 仓储内部使用；full ParsedDoc 是不可变版本的一部分，不由 list/history 默认外发。 */
export interface StoredDocumentVersion extends DocumentVersion {
  readonly parsedDoc: ParsedDoc;
}

export interface StoredDocumentChunk {
  readonly documentId: string;
  readonly versionId: string;
  readonly chunkId: string;
  readonly order: number;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly render: string;
  readonly raw: unknown;
  readonly tags: readonly string[];
  readonly context: string;
  readonly textSha256: string;
}

export interface DocumentAttachment {
  readonly sessionId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly role: DocumentAttachmentRole;
  readonly attachedBy: string;
  readonly attachedAt: string;
}

/** 当前 session_file 表的一行经服务端加载后的窄形状；没有任意 absolute path。 */
export interface ResolvedSessionFile {
  readonly sessionId: string;
  readonly name: string;
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface PromoteSessionFileInput {
  readonly source: ResolvedSessionFile;
  /** 缺席表示创建新文档；存在表示给指定文档追加不可变版本。 */
  readonly documentId?: string;
  /** 追加版本必须传，并且必须等于提交时的 currentVersionId。 */
  readonly baseVersionId?: string;
  readonly title?: string;
  readonly logicalName?: string;
  readonly sourceClass?: DocumentSourceClass;
  readonly tags?: readonly string[];
  readonly mediaType?: string;
  readonly parserName?: string;
  readonly parserVersion?: string;
  readonly createdBy?: string;
}

export interface PromoteResult {
  readonly document: DocumentSummary;
  readonly version: DocumentVersion;
  /** 同一文档已有相同 SHA 时不创建版本、不重复解析与复制。 */
  readonly deduplicated: boolean;
}

export interface DocumentSearchOptions {
  readonly query: string;
  readonly limit?: number;
  readonly documentIds?: readonly string[];
  /** 存在时只检索该会话精确挂载的版本；不存在时用项目的 adopted/current 版本。 */
  readonly sessionId?: string;
}

export interface SearchCoverage {
  readonly matchedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly queryTerms: number;
  readonly ratio: number;
}

export interface DocumentSearchHit {
  readonly evidenceRef: string;
  readonly displayCite: string;
  /**
   * 这条命中来自哪一层。**必须逐条带**，不能靠调用方从作用域反推 —— 两级合并之后
   * 一次结果里同时有总库和项目库的片段，反推会把行业通用制度说成客户自己的规定。
   */
  readonly level: KnowledgeLevel;
  readonly documentId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly documentTitle: string;
  readonly fileName: string;
  readonly chunkId: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly textSha256: string;
  readonly score: number;
  readonly coverage: SearchCoverage;
}

export interface DocumentSearchResult {
  readonly query: string;
  readonly hits: readonly DocumentSearchHit[];
  /**
   * 截断前命中的片段总数。
   *
   * `hits` 被 `limit` 截过，而界面上写的是「找到 N 处材料片段」。不给这个数，
   * 那句话在超过 limit 时就是假的 —— 一个把「材料事实有出处」当卖点的产品，
   * 不能在计数上说谎。
   */
  readonly total: number;
  readonly searchedVersions: readonly string[];
  readonly coverage: SearchCoverage;
}

export interface DocumentOpenResult extends DocumentSearchHit {
  readonly raw: unknown;
  readonly context: string;
  readonly tags: readonly string[];
}

export interface AttachedParsedDoc {
  readonly document: DocumentSummary;
  readonly version: DocumentVersion;
  readonly attachment: DocumentAttachment;
  readonly parsedDoc: ParsedDoc;
  /** 进入 build/chat 语义输入，防止重放到旧版本或旧索引。 */
  readonly manifest: {
    readonly projectId: string;
    readonly documentId: string;
    readonly versionId: string;
    readonly contentSha256: string;
    readonly parserVersion: string;
    readonly indexRevision: string;
    /** 本次真正读取版本时重新裁决得到的 ACL revision，不是文档 metadata revision。 */
    readonly aclRevision: number;
  };
}

/** Harness/build 固定语义输入的最小清单；字段名是日志/重放里的线上形态。 */
export interface DocumentManifestEntry {
  readonly project_id: string;
  readonly document_id: string;
  readonly version_id: string;
  readonly sha256: string;
  readonly index_revision: string;
  readonly acl_revision: number;
  readonly title: string;
  readonly file_name: string;
  readonly version_no: number;
  readonly parse_status: DocumentParseStatus;
  readonly parser_version: string;
}

export interface AttachedDocumentBundle {
  readonly documents: ParsedDoc[];
  readonly manifest: DocumentManifestEntry[];
}

export interface DocumentMetadataPatch {
  readonly expectedRevision: number;
  readonly title?: string;
  readonly logicalName?: string;
  readonly sourceClass?: DocumentSourceClass;
  readonly tags?: readonly string[];
}

export interface DocumentListOptions {
  readonly includeArchived?: boolean;
}

export interface AttachDocumentInput {
  readonly documentId: string;
  readonly versionId: string;
  readonly role?: DocumentAttachmentRole;
  readonly attachedBy?: string;
}
