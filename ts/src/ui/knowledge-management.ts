/** OntoDocument 独立管理页的浏览器 API 合同。项目、账号和操作者一律由会话派生。 */

import { API } from "./dom.js";
import type {
  KnowledgeDocument,
  KnowledgeDocumentVersion,
} from "./knowledge-library.js";

export type WikiClaimKind =
  | "MATERIAL_FACT"
  | "HUMAN_DECISION"
  | "INFERENCE"
  | "GENERAL_GUIDANCE"
  | "CONTESTED"
  | "STALE";

export interface WikiClaimView {
  id: string;
  kind: WikiClaimKind;
  subject: string;
  statement: string;
  evidence_refs: string[];
  state: "draft" | "confirmed";
  author: { kind: "human" | "ai"; id: string };
  created_at: string;
  confirmation: null | {
    actor: { kind: "human"; id: string };
    evidence_refs: string[];
    confirmed_at: string;
  };
  supersedes_claim_id: string | null;
}

export interface WikiStoredPageView {
  page: {
    id: string;
    title: string;
    summary: string;
    tags: string[];
    claims: WikiClaimView[];
    updated_at: string;
  };
  status: "active" | "archived";
  revision: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export interface WikiDraftInput {
  kind: WikiClaimKind;
  subject: string;
  statement: string;
  evidence_refs: string[];
}

export interface DocumentDiffView {
  document_id: string;
  from_version_id: string;
  to_version_id: string;
  from_version_no: number | null;
  to_version_no: number | null;
  summary: Record<"chunks" | "tables" | "fields", {
    added: number; removed: number; modified: number; unchanged: number;
  }>;
  changes: Record<"chunks" | "tables" | "fields", Array<{
    id: string; kind: "added" | "removed" | "modified"; key: string; changedParts?: string[];
  }>>;
  has_changes: boolean;
  fingerprint: string;
}

export interface DocumentImpactView {
  document_id: string;
  from_version_id: string;
  to_version_id: string;
  consumers: Array<{
    consumerId: string;
    consumerKind: "answer" | "manifest" | "model_artifact" | "wiki_claim";
    label: string;
    status: "stale_candidate" | "unaffected" | "unresolved";
    reasons: Array<{ message: string }>;
  }>;
  stale_candidates: DocumentImpactView["consumers"];
  unresolved: DocumentImpactView["consumers"];
  fingerprint: string;
  notice: string;
}

export interface DocumentJobView {
  id: string;
  document_id: string;
  version_id: string;
  kind: "parse" | "ocr";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  candidate_ready: boolean;
  result_sha256: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorSourceView {
  id: string;
  provider: "sharepoint" | "webdav" | "s3" | "confluence" | "datahub" | "openmetadata";
  name: string;
  root_or_prefix: string;
  credential_ref: string;
  tags: string[];
  classification: "public" | "internal" | "confidential" | "restricted";
  enabled: boolean;
  revision: number;
  status: "idle" | "syncing" | "error" | "archived";
  has_cursor: boolean;
  created_at: string;
  updated_at: string;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_error: string;
}

export interface ConnectorSyncView {
  source_id: string;
  pages: number;
  upserted: number;
  deleted: number;
  acl_updated: number;
  complete: boolean;
  has_next_cursor: boolean;
  started_at: string;
  completed_at: string;
}

export interface AclRuleView {
  id: string;
  subject: { type: "principal" | "group"; id: string };
  effect: "allow" | "deny";
  permission: "read" | "write" | "manage_acl";
  resource: {
    scope_type: "project" | "document" | "version" | "chunk";
    document_id?: string;
    version_id?: string;
    chunk_id?: string;
  };
  changed_revision: number;
  created_by: string;
  created_at: string;
}

export interface AclSnapshotView { revision: number; rules: AclRuleView[] }

export interface AuditEventView {
  action: string;
  decision: "allow" | "deny";
  scope_type: string;
  document_id?: string;
  version_id?: string;
  chunk_id?: string;
  acl_revision: number;
  query_sha256?: string;
  candidate_count?: number;
  allowed_count?: number;
  denied_count?: number;
  changed_rule_count?: number;
}

export interface KnowledgeManagementApi {
  listDocuments(sessionId: string): Promise<KnowledgeDocument[]>;
  history(sessionId: string, documentId: string): Promise<KnowledgeDocumentVersion[]>;
  diff(sessionId: string, documentId: string, fromVersionId: string, toVersionId: string): Promise<DocumentDiffView>;
  impact(sessionId: string, documentId: string, fromVersionId: string, toVersionId: string): Promise<DocumentImpactView>;

  listWikiPages(sessionId: string, includeArchived?: boolean): Promise<WikiStoredPageView[]>;
  createWikiPage(sessionId: string, input: { title: string; summary?: string; tags?: string[] }): Promise<WikiStoredPageView>;
  updateWikiPage(sessionId: string, pageId: string, revision: number, input: { title?: string; summary?: string; tags?: string[] }): Promise<WikiStoredPageView>;
  changeWikiPageStatus(sessionId: string, pageId: string, revision: number, action: "archive" | "restore"): Promise<WikiStoredPageView>;
  addWikiDraft(sessionId: string, pageId: string, revision: number, input: WikiDraftInput): Promise<WikiStoredPageView>;
  editWikiDraft(sessionId: string, pageId: string, claimId: string, revision: number, input: WikiDraftInput): Promise<WikiStoredPageView>;
  removeWikiDraft(sessionId: string, pageId: string, claimId: string, revision: number): Promise<WikiStoredPageView>;
  confirmWikiClaim(sessionId: string, pageId: string, claimId: string, revision: number, evidenceRefs: string[]): Promise<WikiStoredPageView>;
  wikiMarkdownUrl(sessionId: string, pageId: string): string;
  obsidianUrl(sessionId: string, includeArchived?: boolean): string;

  listJobs(sessionId: string): Promise<DocumentJobView[]>;
  createJob(sessionId: string, input: { document_id: string; version_id: string; kind: "parse" | "ocr"; idempotency_key: string }): Promise<DocumentJobView>;
  cancelJob(sessionId: string, jobId: string): Promise<DocumentJobView>;

  listConnectors(sessionId: string, includeArchived?: boolean): Promise<ConnectorSourceView[]>;
  createConnector(sessionId: string, input: {
    request_id: string; provider: ConnectorSourceView["provider"]; name: string;
    root_or_prefix: string; credential_ref: string; classification: ConnectorSourceView["classification"];
  }): Promise<ConnectorSourceView>;
  updateConnector(sessionId: string, sourceId: string, revision: number, input: Partial<Pick<ConnectorSourceView,
    "provider" | "name" | "root_or_prefix" | "credential_ref" | "classification" | "enabled">>): Promise<ConnectorSourceView>;
  changeConnectorStatus(sessionId: string, sourceId: string, revision: number, action: "enable" | "disable" | "archive" | "restore"): Promise<ConnectorSourceView>;
  syncConnector(sessionId: string, sourceId: string, revision: number): Promise<ConnectorSyncView>;

  acl(sessionId: string): Promise<AclSnapshotView>;
  replaceAcl(sessionId: string, revision: number, rules: AclRuleView[]): Promise<AclSnapshotView>;
  audit(sessionId: string): Promise<AuditEventView[]>;
}

function route(sessionId: string, tail = ""): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/documents${tail}`;
}

function connectorRoute(sessionId: string, tail = ""): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/document-connectors${tail}`;
}

function tail(id: string): string { return encodeURIComponent(id); }

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
    const raw = (await response.text()).slice(0, 2_000);
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      detail = String(parsed["detail"] ?? parsed["message"] ?? parsed["error"] ?? raw);
    } catch { /* plain text */ }
    const error = new Error(detail || "知识库没有完成这次操作，请稍后重试。");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return await response.json() as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function versionParams(from: string, to: string): string {
  return new URLSearchParams({ from_version_id: from, to_version_id: to }).toString();
}

export const knowledgeManagementApi: KnowledgeManagementApi = {
  async listDocuments(sessionId) {
    return (await request<{ documents: KnowledgeDocument[] }>(route(sessionId))).documents || [];
  },
  async history(sessionId, documentId) {
    return (await request<{ versions: KnowledgeDocumentVersion[] }>(route(sessionId, `/${tail(documentId)}/history`))).versions || [];
  },
  async diff(sessionId, documentId, fromVersionId, toVersionId) {
    return (await request<{ diff: DocumentDiffView }>(route(sessionId, `/${tail(documentId)}/diff?${versionParams(fromVersionId, toVersionId)}`))).diff;
  },
  async impact(sessionId, documentId, fromVersionId, toVersionId) {
    return (await request<{ impact: DocumentImpactView }>(route(sessionId, `/${tail(documentId)}/impact?${versionParams(fromVersionId, toVersionId)}`))).impact;
  },

  async listWikiPages(sessionId, includeArchived = false) {
    const query = includeArchived ? "?include_archived=true" : "";
    return (await request<{ pages: WikiStoredPageView[] }>(route(sessionId, `/wiki/pages${query}`))).pages || [];
  },
  async createWikiPage(sessionId, input) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, "/wiki/pages"), json("POST", input))).page;
  },
  async updateWikiPage(sessionId, pageId, revision, input) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}`),
      json("PATCH", { expected_revision: revision, ...input }))).page;
  },
  async changeWikiPageStatus(sessionId, pageId, revision, action) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}/${action}`),
      json("POST", { expected_revision: revision }))).page;
  },
  async addWikiDraft(sessionId, pageId, revision, input) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}/claims`),
      json("POST", { expected_revision: revision, ...input }))).page;
  },
  async editWikiDraft(sessionId, pageId, claimId, revision, input) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}/claims/${tail(claimId)}`),
      json("PATCH", { expected_revision: revision, ...input }))).page;
  },
  async removeWikiDraft(sessionId, pageId, claimId, revision) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}/claims/${tail(claimId)}`),
      json("DELETE", { expected_revision: revision }))).page;
  },
  async confirmWikiClaim(sessionId, pageId, claimId, revision, evidenceRefs) {
    return (await request<{ page: WikiStoredPageView }>(route(sessionId, `/wiki/pages/${tail(pageId)}/claims/${tail(claimId)}/confirm`),
      json("POST", { expected_revision: revision, evidence_refs: evidenceRefs }))).page;
  },
  wikiMarkdownUrl(sessionId, pageId) { return route(sessionId, `/wiki/pages/${tail(pageId)}/export.md`); },
  obsidianUrl(sessionId, includeArchived = false) {
    return route(sessionId, `/wiki/export/obsidian.zip${includeArchived ? "?include_archived=true" : ""}`);
  },

  async listJobs(sessionId) {
    return (await request<{ jobs: DocumentJobView[] }>(route(sessionId, "/jobs?limit=100"))).jobs || [];
  },
  async createJob(sessionId, input) {
    return (await request<{ job: DocumentJobView }>(route(sessionId, "/jobs"), json("POST", input))).job;
  },
  async cancelJob(sessionId, jobId) {
    return (await request<{ job: DocumentJobView }>(route(sessionId, `/jobs/${tail(jobId)}`), { method: "DELETE" })).job;
  },

  async listConnectors(sessionId, includeArchived = false) {
    const query = includeArchived ? "?include_archived=true" : "";
    return (await request<{ sources: ConnectorSourceView[] }>(connectorRoute(sessionId, query))).sources || [];
  },
  async createConnector(sessionId, input) {
    return (await request<{ source: ConnectorSourceView }>(connectorRoute(sessionId), json("POST", input))).source;
  },
  async updateConnector(sessionId, sourceId, revision, input) {
    return (await request<{ source: ConnectorSourceView }>(connectorRoute(sessionId, `/${tail(sourceId)}`),
      json("PATCH", { expected_revision: revision, ...input }))).source;
  },
  async changeConnectorStatus(sessionId, sourceId, revision, action) {
    return (await request<{ source: ConnectorSourceView }>(connectorRoute(sessionId, `/${tail(sourceId)}/${action}`),
      json("POST", { expected_revision: revision }))).source;
  },
  async syncConnector(sessionId, sourceId, revision) {
    return (await request<{ sync: ConnectorSyncView }>(connectorRoute(sessionId, `/${tail(sourceId)}/sync`),
      json("POST", { expected_revision: revision }))).sync;
  },

  async acl(sessionId) { return await request<AclSnapshotView>(route(sessionId, "/acl")); },
  async replaceAcl(sessionId, revision, rules) {
    const cleanRules = rules.map(({ changed_revision: _changed, created_by: _by, created_at: _at, ...rule }) => rule);
    return await request<AclSnapshotView>(route(sessionId, "/acl"),
      json("PUT", { expected_revision: revision, rules: cleanRules }));
  },
  async audit(sessionId) {
    return (await request<{ events: AuditEventView[] }>(route(sessionId, "/audit?limit=200"))).events || [];
  },
};

export function newManagementRequestId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
