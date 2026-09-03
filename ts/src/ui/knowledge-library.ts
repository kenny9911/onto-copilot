/**
 * OntoDocument 的浏览器 API 合同。
 *
 * 项目、账号和会话边界全部由 URL 中的当前会话交给服务端派生；这个客户端从不
 * 接受 projectId / owner，更不会接受本地文件路径。这样即使 UI 参数被篡改，也不
 * 会把一份文档写到另一个项目里。
 */

import { API } from "./dom.js";

export type KnowledgeSourceClass = "session_upload" | "generated" | "external" | "imported";
export type KnowledgeDocumentStatus = "active" | "archived";
export type KnowledgeParseStatus = "ready" | "degraded";
export type KnowledgeAttachmentRole = "reference" | "primary";

export interface KnowledgeFolder {
  path: string;
  created_at: string;
}

export interface KnowledgeDocument {
  id: string;
  /** 所在文件夹。空串 = 根目录。 */
  folder_path?: string;
  title: string;
  logical_name: string;
  source_class: KnowledgeSourceClass;
  tags: string[];
  status: KnowledgeDocumentStatus;
  current_version_id: string;
  adopted_version_id: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentVersion {
  id: string;
  document_id: string;
  version_no: number;
  file_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  doc_kind: string;
  parse_status: KnowledgeParseStatus;
  parser_name: string;
  parser_version: string;
  index_revision: string;
  chunk_count: number;
  created_by: string;
  created_at: string;
}

export interface KnowledgeAttachment {
  document_id: string;
  version_id: string;
  role: KnowledgeAttachmentRole;
  attached_by: string;
  attached_at: string;
}

export interface KnowledgeCoverage {
  matchedTerms: string[];
  missingTerms: string[];
  queryTerms: number;
  ratio: number;
}

export type KnowledgeLevel = "global" | "project";

export interface KnowledgeSearchHit {
  evidence_ref: string;
  cite: string;
  /** 这段来自总库还是项目库。缺省按项目库处理（后端旧版本没有这个字段）。 */
  level?: KnowledgeLevel;
  /** 同一段正文在另一层也存在时，这里写着那一层。 */
  also_in_level?: KnowledgeLevel | null;
  document_id: string;
  version_id: string;
  version_no: number;
  document_title: string;
  file_name: string;
  chunk_id: string;
  locator: Record<string, unknown>;
  text: string;
  text_sha256: string;
  score: number;
  coverage: KnowledgeCoverage;
}

export interface KnowledgeSearchResult {
  query: string;
  hits: KnowledgeSearchHit[];
  searched_versions: string[];
  coverage: KnowledgeCoverage;
}

export interface KnowledgeOpenResult extends KnowledgeSearchHit {
  raw: unknown;
  context: string;
  tags: string[];
}

export interface KnowledgeListResult {
  documents: KnowledgeDocument[];
  attachments: KnowledgeAttachment[];
}

/** 打开一份材料按原文顺序读的结果。 */
export interface KnowledgeReadResult {
  document: KnowledgeDocument;
  version: KnowledgeDocumentVersion;
  level: KnowledgeLevel;
  /** 段落复用检索命中的形状，所以每段天生带 evidence_ref 和引用文案。 */
  chunks: KnowledgeSearchHit[];
  /** 这一版一共多少段 —— 用来如实说「第 1-50 段，共 213 段」。 */
  total: number;
  offset: number;
}

export interface KnowledgeMutationResult {
  ok: boolean;
  message: string;
  document?: KnowledgeDocument;
  version?: KnowledgeDocumentVersion;
  attachment?: KnowledgeAttachment;
  deduplicated?: boolean;
  detached?: boolean;
}

export interface PromoteKnowledgeInput {
  session_file_name: string;
  target_document_id?: string;
  base_version_id?: string;
  title?: string;
  logical_name?: string;
  classification?: KnowledgeSourceClass;
  tags?: string[];
}

export interface UpdateKnowledgeInput {
  expected_revision: number;
  title?: string;
  logical_name?: string;
  classification?: KnowledgeSourceClass;
  tags?: string[];
}

export interface KnowledgeLibraryApi {
  list(sessionId: string, includeArchived?: boolean): Promise<KnowledgeListResult>;
  history(sessionId: string, documentId: string): Promise<KnowledgeDocumentVersion[]>;
  search(sessionId: string, query: string, attachedOnly?: boolean): Promise<KnowledgeSearchResult>;
  open(sessionId: string, evidenceRef: string): Promise<KnowledgeOpenResult>;
  /** 不需要关键词，直接打开读。 */
  read(
    sessionId: string,
    documentId: string,
    opts?: { versionId?: string; offset?: number; limit?: number },
  ): Promise<KnowledgeReadResult>;
  promote(sessionId: string, input: PromoteKnowledgeInput): Promise<KnowledgeMutationResult>;
  update(sessionId: string, documentId: string, input: UpdateKnowledgeInput): Promise<KnowledgeMutationResult>;
  adopt(sessionId: string, documentId: string, versionId: string, expectedRevision: number): Promise<KnowledgeMutationResult>;
  archive(sessionId: string, documentId: string, archived: boolean, expectedRevision: number): Promise<KnowledgeMutationResult>;
  attach(sessionId: string, documentId: string, versionId: string, role?: KnowledgeAttachmentRole): Promise<KnowledgeMutationResult>;
  detach(sessionId: string, documentId: string): Promise<KnowledgeMutationResult>;
  /** 设为通用知识：把这份项目材料复制进公共知识库。人点的动作。 */
  publish(sessionId: string, documentId: string, versionId?: string): Promise<KnowledgeMutationResult>;
  listFolders(sessionId: string): Promise<KnowledgeFolder[]>;
  createFolder(sessionId: string, path: string): Promise<KnowledgeFolder[]>;
  renameFolder(sessionId: string, from: string, to: string): Promise<KnowledgeMutationResult>;
  deleteFolder(sessionId: string, path: string): Promise<KnowledgeMutationResult>;
  moveDocument(sessionId: string, documentId: string, folderPath: string): Promise<KnowledgeMutationResult>;
}

/** 会话作用域的基址：项目知识库。 */
function sessionRoute(sessionId: string, suffix = ""): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/documents${suffix}`;
}

/**
 * 公共知识库的基址：**不带会话**。
 *
 * 产品要求：不选项目也能打开知识库。所以这条路径里没有 sessionId ——
 * 参数保留只是为了和会话版共用同一个 API 形状，调用方传什么都会被忽略。
 */
function globalRoute(_sessionId: string, suffix = ""): string {
  return `${API}/api/knowledge/documents${suffix}`;
}

type RouteFn = (sessionId: string, suffix?: string) => string;

function detailFromBody(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["detail", "error", "message"]) {
      if (typeof parsed[key] === "string" && parsed[key]) return String(parsed[key]);
    }
  } catch { /* plain-text response */ }
  return body.slice(0, 320) || fallback;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 2_000);
    const error = new Error(detailFromBody(body, "知识库暂时没有完成这次操作，请稍后重试。")) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return await response.json() as T;
}

function documentSuffix(documentId: string, tail = ""): string {
  return `/${encodeURIComponent(documentId)}${tail}`;
}

/** 公共库里不成立的操作：它们的语义要么依赖「本次会话上传的文件」，要么依赖
 *  「本次会话固定了哪一版」。与其静默失败，不如当场说清楚。 */
function notInGlobal(what: string): never {
  throw new Error(`公共知识库不支持${what}：它属于某个会话的语义。请在项目知识库里操作。`);
}

function createKnowledgeApi(route: RouteFn, scope: "session" | "global"): KnowledgeLibraryApi {
  return {
    async list(sessionId, includeArchived = false) {
      const query = includeArchived ? "?include_archived=true" : "";
      return await request<KnowledgeListResult>(route(sessionId, query));
    },

    async history(sessionId, documentId) {
      const result = await request<{ versions: KnowledgeDocumentVersion[] }>(
        route(sessionId, documentSuffix(documentId, "/history")),
      );
      return result.versions || [];
    },

    async search(sessionId, query, attachedOnly = false) {
      const params = new URLSearchParams({ q: query, limit: "30" });
      if (attachedOnly) params.set("attached_only", "true");
      return await request<KnowledgeSearchResult>(route(sessionId, `/search?${params.toString()}`));
    },

    async open(sessionId, evidenceRef) {
      const result = await request<{ evidence: KnowledgeOpenResult }>(
        route(sessionId, `/evidence/${encodeURIComponent(evidenceRef)}/open`),
      );
      return result.evidence;
    },

    async read(sessionId, documentId, opts = {}) {
      const params = new URLSearchParams();
      if (opts.versionId) params.set("version_id", opts.versionId);
      if (opts.offset !== undefined) params.set("offset", String(opts.offset));
      if (opts.limit !== undefined) params.set("limit", String(opts.limit));
      const query = params.toString();
      return await request<KnowledgeReadResult>(
        route(sessionId, documentSuffix(documentId, `/content${query ? `?${query}` : ""}`)),
      );
    },

    async publish(sessionId, documentId, versionId) {
      if (scope === "global") notInGlobal("设为通用知识");
      return await request<KnowledgeMutationResult>(
        route(sessionId, documentSuffix(documentId, "/publish")),
        { method: "POST", body: JSON.stringify(versionId ? { version_id: versionId } : {}) },
      );
    },

    async listFolders(sessionId) {
      const r = await request<{ folders: KnowledgeFolder[] }>(route(sessionId, "/folders"));
      return r.folders;
    },

    async createFolder(sessionId, path) {
      const r = await request<{ folders: KnowledgeFolder[] }>(route(sessionId, "/folders"), {
        method: "POST", body: JSON.stringify({ folder: path }),
      });
      return r.folders;
    },

    async renameFolder(sessionId, from, to) {
      if (scope === "global") notInGlobal("重命名文件夹");
      return await request<KnowledgeMutationResult>(route(sessionId, "/folders"), {
        method: "PATCH", body: JSON.stringify({ from, to }),
      });
    },

    async deleteFolder(sessionId, path) {
      if (scope === "global") notInGlobal("删除文件夹");
      return await request<KnowledgeMutationResult>(
        route(sessionId, `/folders?folder=${encodeURIComponent(path)}`), { method: "DELETE" },
      );
    },

    async moveDocument(sessionId, documentId, folderPath) {
      return await request<KnowledgeMutationResult>(
        route(sessionId, documentSuffix(documentId, "/folder")),
        { method: "PATCH", body: JSON.stringify({ folder: folderPath }) },
      );
    },

    async promote(sessionId, input) {
      if (scope === "global") notInGlobal("从会话文件入库");
      return await request<KnowledgeMutationResult>(route(sessionId, "/promote"), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async update(sessionId, documentId, input) {
      return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId)), {
        method: "PATCH",
        body: JSON.stringify(input),
      });
    },

    async adopt(sessionId, documentId, versionId, expectedRevision) {
      return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/adopt")), {
        method: "PATCH",
        body: JSON.stringify({ version_id: versionId, expected_revision: expectedRevision }),
      });
    },

    async archive(sessionId, documentId, archived, expectedRevision) {
      return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/archive")), {
        method: "PATCH",
        body: JSON.stringify({ archived, expected_revision: expectedRevision }),
      });
    },

    async attach(sessionId, documentId, versionId, role = "reference") {
      if (scope === "global") notInGlobal("「用于本次分析」");
      return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/attach")), {
        method: "POST",
        body: JSON.stringify({ version_id: versionId, role }),
      });
    },

    async detach(sessionId, documentId) {
      if (scope === "global") notInGlobal("取消本次使用");
      return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/attach")), {
        method: "DELETE",
      });
    },
  };
}

export const knowledgeLibraryApi: KnowledgeLibraryApi = createKnowledgeApi(sessionRoute, "session");

/** 公共知识库客户端。侧栏那颗按钮不再需要「先打开一个已归入项目的会话」。 */
export const knowledgeGlobalApi: KnowledgeLibraryApi = createKnowledgeApi(globalRoute, "global");


