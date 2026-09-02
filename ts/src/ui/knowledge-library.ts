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

export interface KnowledgeDocument {
  id: string;
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

export interface KnowledgeSearchHit {
  evidence_ref: string;
  cite: string;
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
  promote(sessionId: string, input: PromoteKnowledgeInput): Promise<KnowledgeMutationResult>;
  update(sessionId: string, documentId: string, input: UpdateKnowledgeInput): Promise<KnowledgeMutationResult>;
  adopt(sessionId: string, documentId: string, versionId: string, expectedRevision: number): Promise<KnowledgeMutationResult>;
  archive(sessionId: string, documentId: string, archived: boolean, expectedRevision: number): Promise<KnowledgeMutationResult>;
  attach(sessionId: string, documentId: string, versionId: string, role?: KnowledgeAttachmentRole): Promise<KnowledgeMutationResult>;
  detach(sessionId: string, documentId: string): Promise<KnowledgeMutationResult>;
}

function route(sessionId: string, suffix = ""): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/documents${suffix}`;
}

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

export const knowledgeLibraryApi: KnowledgeLibraryApi = {
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

  async promote(sessionId, input) {
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
    return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/attach")), {
      method: "POST",
      body: JSON.stringify({ version_id: versionId, role }),
    });
  },

  async detach(sessionId, documentId) {
    return await request<KnowledgeMutationResult>(route(sessionId, documentSuffix(documentId, "/attach")), {
      method: "DELETE",
    });
  },
};

