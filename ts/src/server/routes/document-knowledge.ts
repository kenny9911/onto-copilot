/** OntoDocument 版本差异、影响分析与项目 Wiki 的 HTTP 边界。 */

import type { Context, Hono } from "hono";

import { DocumentNotFoundOrForbidden } from "../../document/acl.js";
import type {
  DocumentChange,
  DocumentVersionDiff,
} from "../../document/diff.js";
import {
  analyzeDocumentImpact,
  type AnswerDependencySource,
  type DocumentImpactReport,
  type ImpactSources,
  type ModelArtifactDependencySource,
} from "../../document/impact.js";
import {
  DocumentError,
  type DocumentManifestEntry,
  type DocumentOpenResult,
  type DocumentScope,
} from "../../document/types.js";
import {
  WIKI_CLAIM_KINDS,
  type ObsidianVaultBundle,
  type WikiActor,
  type WikiClaim,
  type WikiClaimKind,
  type WikiPage,
} from "../../document/wiki.js";
import type {
  StoredWikiPage,
  WikiPageRevision,
} from "../../document/wiki_repository.js";
import type {
  AddWikiDraftCommand,
  ChangeWikiPageStatusCommand,
  ConfirmWikiClaimCommand,
  CreateWikiPageCommand,
  EditWikiDraftCommand,
  UpdateWikiPageCommand,
  WikiPageService,
} from "../../document/wiki_service.js";
import { buildZip } from "../../onto/bundle.js";
import type { AppEnv } from "../app.js";
import { sessAsync } from "../session.js";
import type { ProjectDirectory } from "./document_scope.js";
import { repoProjectDirectory, resolveProjectScope } from "./document_scope.js";
import { apiError, jsonBody } from "./sessions.js";

export interface DocumentDiffPort {
  list(scope: DocumentScope): Promise<readonly {
    readonly id: string;
    readonly adoptedVersionId: string | null;
  }[]>;
  versionDiff(
    scope: DocumentScope,
    documentId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<DocumentVersionDiff>;
  open(
    scope: DocumentScope,
    input: { readonly evidenceRef: string },
  ): Promise<DocumentOpenResult>;
}

export interface DocumentKnowledgeRouteSession {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  /** 已从耐久 session_state hydrate 的当前快照。 */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface DocumentKnowledgeRouteDeps {
  readonly documents: DocumentDiffPort;
  readonly wiki: Pick<
    WikiPageService,
    | "listPages"
    | "getPage"
    | "history"
    | "createPage"
    | "updatePage"
    | "addDraft"
    | "editDraft"
    | "removeDraft"
    | "confirmClaim"
    | "archivePage"
    | "restorePage"
    | "renderMarkdown"
    | "buildObsidianVault"
  >;
  readonly sessionById?: (sid: string) => Promise<DocumentKnowledgeRouteSession>;
  /** 项目目录。生产默认落在仓储上；HTTP 测试注入桩。 */
  readonly projects?: ProjectDirectory;
}

interface KnowledgeScope {
  readonly scope: DocumentScope;
  readonly source: DocumentKnowledgeRouteSession;
  readonly actor: WikiActor & { readonly kind: "human" };
  readonly projectAutoCreated: boolean;
  readonly projectName: string;
}

const AUTHORITY_FIELDS = new Set([
  "actor",
  "actor_id",
  "actorId",
  "author",
  "confirmation",
  "confirmed",
  "owner",
  "owner_id",
  "ownerId",
  "principal",
  "project",
  "project_id",
  "projectId",
  "state",
  "status",
  "created_by",
  "createdBy",
  "updated_by",
  "updatedBy",
  "path",
  "file_path",
  "filePath",
  "destination",
  "output_path",
  "outputPath",
]);

const ANSWER_STATE_KEYS = [
  "answers",
  "_answers",
  "decisions",
  "_decisions",
  "answer_history",
  "review_decisions",
  "question_backlog",
  "_dialogue",
] as const;

const MODEL_STATE_KEYS = [
  "_oir",
  "oir",
  "_flow",
  "flow",
  "ontology",
  "ontology_package",
  "draft_ontology_package",
  "engagement",
  "requirements",
  "rules",
  "audit",
] as const;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function requiredText(value: unknown, label: string, max = 2_048): string {
  if (typeof value !== "string") throw apiError(400, `${label}必须是文字`);
  const clean = value.trim();
  if (!clean || clean.includes("\u0000") || [...clean].length > max) {
    throw apiError(400, `${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`);
  }
  return clean;
}

function optionalText(value: unknown, label: string, max = 2_048): string | undefined {
  return value === undefined ? undefined : requiredText(value, label, max);
}

function opaqueId(value: unknown, label: string): string {
  const clean = requiredText(value, label);
  if (clean === "." || clean === ".." || clean.includes("/") || clean.includes("\\")) {
    throw apiError(404, `没有这个${label}`);
  }
  return clean;
}

function assertNoAuthorityFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoAuthorityFields(item);
    return;
  }
  const row = record(value);
  if (row === null) return;
  for (const [key, child] of Object.entries(row)) {
    if (AUTHORITY_FIELDS.has(key)) {
      throw apiError(400, `请不要提交 ${key}；项目、操作者和确认状态由服务端确定。`);
    }
    assertNoAuthorityFields(child);
  }
}

function onlyFields(
  body: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  assertNoAuthorityFields(body);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw apiError(400, `${label}不支持字段：${unknown.join("、")}`);
}

function rejectAuthorityQuery(c: Context<AppEnv>): void {
  const bad = [...new URL(c.req.url).searchParams.keys()].filter((key) => AUTHORITY_FIELDS.has(key));
  if (bad.length > 0) {
    throw apiError(400, `请不要提交 ${bad.join("、")}；项目和操作者由当前会话确定。`);
  }
}

function booleanQuery(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw apiError(400, `${label} 只支持 true 或 false`);
}

function positiveRevision(body: Readonly<Record<string, unknown>>): number {
  const value = body["expected_revision"] ?? body["expectedRevision"];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw apiError(400, "expected_revision 必须是正整数；请先刷新页面后再修改。");
  }
  return value as number;
}

function stringList(
  value: unknown,
  label: string,
  options: { readonly required?: boolean; readonly max?: number } = {},
): readonly string[] | undefined {
  if (value === undefined) {
    if (options.required === true) throw apiError(400, `${label}不能为空`);
    return undefined;
  }
  if (!Array.isArray(value)) throw apiError(400, `${label}必须是文字数组`);
  const out = new Set<string>();
  for (const item of value) {
    out.add(requiredText(item, label, 2_048));
    if (out.size > (options.max ?? 100)) throw apiError(400, `${label}项目过多`);
  }
  if (options.required === true && out.size === 0) throw apiError(400, `${label}不能为空`);
  return [...out];
}

function claimKind(value: unknown): WikiClaimKind {
  const clean = requiredText(value, "声明类型", 64);
  if (!(WIKI_CLAIM_KINDS as readonly string[]).includes(clean)) {
    throw apiError(400, `声明类型只支持：${WIKI_CLAIM_KINDS.join("、")}`);
  }
  return clean as WikiClaimKind;
}

function optionalClaimKind(value: unknown): WikiClaimKind | undefined {
  return value === undefined ? undefined : claimKind(value);
}

function draftSpec(value: unknown, label = "draft", allowRevision = false): {
  readonly kind: WikiClaimKind;
  readonly subject: string;
  readonly statement: string;
  readonly evidenceRefs?: readonly string[];
  readonly supersedesClaimId?: string;
} {
  const row = record(value);
  if (row === null) throw apiError(400, `${label}必须是对象`);
  onlyFields(
    row,
    new Set([
      "kind",
      "subject",
      "statement",
      "evidence_refs",
      "evidenceRefs",
      "supersedes_claim_id",
      "supersedesClaimId",
      ...(allowRevision ? ["expected_revision", "expectedRevision"] : []),
    ]),
    label,
  );
  const evidenceRefs = stringList(row["evidence_refs"] ?? row["evidenceRefs"], "evidence_refs");
  const supersedesClaimId = optionalText(
    row["supersedes_claim_id"] ?? row["supersedesClaimId"],
    "supersedes_claim_id",
    256,
  );
  return {
    kind: claimKind(row["kind"]),
    subject: requiredText(row["subject"], "声明主题", 300),
    statement: requiredText(row["statement"], "声明正文", 8_000),
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
    ...(supersedesClaimId === undefined ? {} : { supersedesClaimId }),
  };
}

async function knowledgeScope(
  c: Context<AppEnv>,
  deps: DocumentKnowledgeRouteDeps,
): Promise<KnowledgeScope> {
  const sid = requiredText(c.req.param("sid"), "会话 ID", 256);
  const resolved = await resolveProjectScope(
    c,
    sid,
    deps.sessionById ?? sessAsync,
    deps.projects ?? repoProjectDirectory(),
  );
  return {
    scope: resolved.scope,
    source: resolved.source,
    // HTTP 写入口始终代表当前真人用户；请求体没有 actor 通道。
    // 注意 actor 用的是 actorId（真人），不是 scope.owner（项目 owner）——
    // 「谁在何时确认」这条链上写错人，比写错项目更难发现。
    actor: { kind: "human", id: resolved.actorId },
    projectAutoCreated: resolved.projectAutoCreated,
    projectName: resolved.projectName,
  };
}

async function knowledgeCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DocumentNotFoundOrForbidden) {
      throw apiError(404, "没有找到这项知识库内容，或你没有访问权限。");
    }
    if (!(error instanceof DocumentError)) throw error;
    const status = error.code === "FORBIDDEN" || error.code === "NOT_FOUND" ? 404 : error.status;
    throw apiError(status, error.message);
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stateItems(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function sourceId(prefix: string, value: unknown, index: number): string {
  const row = record(value);
  const explicit = row === null
    ? ""
    : textValue(row["id"] ?? row["question_id"] ?? row["questionId"] ?? row["decision_id"] ?? row["decisionId"]);
  return explicit ? `${prefix}:${explicit}` : `${prefix}:${index + 1}`;
}

function answerSources(state: Readonly<Record<string, unknown>>): AnswerDependencySource[] {
  const out: AnswerDependencySource[] = [];
  for (const key of ANSWER_STATE_KEYS) {
    for (const [index, payload] of stateItems(state[key]).entries()) {
      out.push({ id: sourceId(`session-answer:${key}`, payload, index), payload });
    }
  }
  return out;
}

function manifestEntry(value: unknown, projectId: string): DocumentManifestEntry | null {
  const row = record(value);
  if (row === null || textValue(row["project_id"]) !== projectId) return null;
  const documentId = textValue(row["document_id"]);
  const versionId = textValue(row["version_id"]);
  if (!documentId || !versionId) return null;
  const parseStatus = row["parse_status"] === "degraded" ? "degraded" : "ready";
  return {
    project_id: projectId,
    document_id: documentId,
    version_id: versionId,
    sha256: textValue(row["sha256"]),
    index_revision: textValue(row["index_revision"]),
    acl_revision: Number.isSafeInteger(row["acl_revision"]) ? row["acl_revision"] as number : 0,
    title: textValue(row["title"]),
    file_name: textValue(row["file_name"]),
    version_no: Number.isSafeInteger(row["version_no"]) ? row["version_no"] as number : 0,
    parse_status: parseStatus,
    parser_version: textValue(row["parser_version"]),
  };
}

function artifactSources(state: Readonly<Record<string, unknown>>): ModelArtifactDependencySource[] {
  const keys = new Set<string>(MODEL_STATE_KEYS);
  for (const key of Object.keys(state)) {
    if (/(?:^|_)(?:oir|flow|ontology|model|package|requirements|rules)(?:_|$)/iu.test(key)) keys.add(key);
  }
  return [...keys]
    .sort()
    .filter((key) => state[key] !== undefined && state[key] !== null)
    .map((key) => ({ id: `session-artifact:${key}`, artifactKind: key, payload: state[key] }));
}

async function impactSources(
  scope: DocumentScope,
  source: DocumentKnowledgeRouteSession,
  wiki: DocumentKnowledgeRouteDeps["wiki"],
): Promise<ImpactSources> {
  const manifest = stateItems(source.state["_document_manifest"])
    .map((item) => manifestEntry(item, scope.projectId))
    .filter((item): item is DocumentManifestEntry => item !== null);
  const pages = await wiki.listPages(scope, true);
  return {
    answers: answerSources(source.state),
    manifests: manifest.length === 0 ? [] : [{ id: `session-manifest:${source.id}`, entries: manifest }],
    artifacts: artifactSources(source.state),
    wikiClaims: pages.flatMap((page) => page.page.claims.map((claim) => ({
      id: `wiki-claim:${page.page.id}:${claim.id}`,
      payload: claim,
    }))),
  };
}

function diffView(diff: DocumentVersionDiff): Record<string, unknown> {
  return {
    document_id: diff.documentId,
    from_version_id: diff.fromVersionId,
    to_version_id: diff.toVersionId,
    from_version_no: diff.fromVersionNo,
    to_version_no: diff.toVersionNo,
    summary: diff.summary,
    changes: {
      chunks: diff.chunks.map((change) => safeDiffChange(
        change,
        (snapshot) => ({
          key: snapshot.key,
          chunk_id: snapshot.chunkId,
          order: snapshot.order,
          locator: snapshot.locator,
          text: snapshot.render,
          tags: snapshot.tags,
          context: snapshot.context,
          fingerprint: snapshot.fingerprint,
        }),
        new Set(["raw"]),
      )),
      tables: diff.tables.map((change) => safeDiffChange(
        change,
        (snapshot) => ({
          key: snapshot.key,
          name: snapshot.name,
          source_kind: snapshot.sourceKind,
          field_order: snapshot.fieldOrder,
          field_fingerprints: snapshot.fieldFingerprints,
          fingerprint: snapshot.fingerprint,
        }),
        new Set(["metadata"]),
      )),
      fields: diff.fields.map((change) => safeDiffChange(
        change,
        (snapshot) => ({
          key: snapshot.key,
          table_key: snapshot.tableKey,
          name: snapshot.name,
          fingerprint: snapshot.fingerprint,
        }),
        new Set(["definition"]),
      )),
    },
    inventory: diff.inventory,
    has_changes: diff.hasChanges,
    fingerprint: diff.fingerprint,
  };
}

function safeDiffChange<T>(
  change: DocumentChange<T>,
  snapshotView: (snapshot: T) => Record<string, unknown>,
  hiddenParts: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    id: change.id,
    scope: change.scope,
    kind: change.kind,
    key: change.key,
    before: change.before === null ? null : snapshotView(change.before),
    after: change.after === null ? null : snapshotView(change.after),
    changed_parts: change.changedParts.filter((part) => !hiddenParts.has(part)),
  };
}

function impactView(report: DocumentImpactReport): Record<string, unknown> {
  return {
    document_id: report.documentId,
    from_version_id: report.fromVersionId,
    to_version_id: report.toVersionId,
    consumers: report.consumers,
    stale_candidates: report.staleCandidates,
    unresolved: report.unresolved,
    reverse_dependencies: report.reverseDependencies,
    fingerprint: report.fingerprint,
    notice: "这里只标记需要复核的候选项，不会自动修改回答、模型产物或 Wiki。",
  };
}

function claimView(claim: WikiClaim): Record<string, unknown> {
  return {
    id: claim.id,
    kind: claim.kind,
    subject: claim.subject,
    statement: claim.statement,
    evidence_refs: claim.evidenceRefs,
    state: claim.state,
    author: claim.author,
    created_at: claim.createdAt,
    confirmation: claim.confirmation === null
      ? null
      : {
          actor: claim.confirmation.actor,
          evidence_refs: claim.confirmation.evidenceRefs,
          confirmed_at: claim.confirmation.confirmedAt,
        },
    supersedes_claim_id: claim.supersedesClaimId,
  };
}

function pageView(page: WikiPage): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    summary: page.summary,
    tags: page.tags,
    claims: page.claims.map(claimView),
    updated_at: page.updatedAt,
  };
}

function storedPageView(stored: StoredWikiPage): Record<string, unknown> {
  return {
    page: pageView(stored.page),
    status: stored.status,
    revision: stored.revision,
    created_by: stored.createdBy,
    created_at: stored.createdAt,
    updated_by: stored.updatedBy,
    updated_at: stored.updatedAt,
  };
}

function revisionView(revision: WikiPageRevision): Record<string, unknown> {
  return {
    revision: revision.revision,
    action: revision.action,
    status: revision.status,
    actor: revision.actor,
    recorded_at: revision.recordedAt,
    content_sha256: revision.contentSha256,
    page: pageView(revision.page),
  };
}

function versionQuery(c: Context<AppEnv>): { readonly from: string; readonly to: string } {
  rejectAuthorityQuery(c);
  return {
    from: opaqueId(c.req.query("from_version_id") ?? c.req.query("fromVersionId"), "起点版本"),
    to: opaqueId(c.req.query("to_version_id") ?? c.req.query("toVersionId"), "终点版本"),
  };
}

function toBody(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function vaultZip(bundle: ObsidianVaultBundle): Uint8Array {
  const manifest = {
    schema: "ontodocument.obsidian-export/1",
    project_id: bundle.projectId,
    generated_at: bundle.generatedAt,
    fingerprint: bundle.fingerprint,
    files: bundle.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
  return buildZip(
    // buildZip 会在包根加入 manifest/readme；Vault 固定放进 OntoDocument/，既避免
    // 与这两份说明重名，也不接受任何客户端提供的目录名。
    bundle.files.map((file) => [`OntoDocument/${file.path}`, file.content] as const),
    manifest,
    "# OntoDocument Obsidian 导出\n\n所有页面均来自当前项目 Wiki 的只读快照。\n",
  );
}

export function registerDocumentKnowledgeRoutes(
  app: Hono<AppEnv>,
  deps: DocumentKnowledgeRouteDeps,
): void {
  app.get("/api/sessions/:sid/documents/:documentId/diff", async (c) => {
    const { scope } = await knowledgeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versions = versionQuery(c);
    const diff = await knowledgeCall(() =>
      deps.documents.versionDiff(scope, documentId, versions.from, versions.to));
    return c.json({ diff: diffView(diff) });
  });

  app.get("/api/sessions/:sid/documents/:documentId/impact", async (c) => {
    const { scope, source } = await knowledgeScope(c, deps);
    const documentId = opaqueId(c.req.param("documentId"), "文档");
    const versions = versionQuery(c);
    const [diff, sources] = await knowledgeCall(() => Promise.all([
      deps.documents.versionDiff(scope, documentId, versions.from, versions.to),
      impactSources(scope, source, deps.wiki),
    ]));
    return c.json({ impact: impactView(analyzeDocumentImpact(diff, sources)) });
  });

  app.get("/api/sessions/:sid/documents/wiki/pages", async (c) => {
    rejectAuthorityQuery(c);
    const { scope } = await knowledgeScope(c, deps);
    const includeArchived = booleanQuery(c.req.query("include_archived"), "include_archived");
    const pages = await knowledgeCall(() => deps.wiki.listPages(scope, includeArchived));
    return c.json({ pages: pages.map(storedPageView) });
  });

  app.post("/api/sessions/:sid/documents/wiki/pages", async (c) => {
    const body = await jsonBody(c);
    onlyFields(body, new Set(["id", "title", "summary", "tags", "drafts"]), "创建页面");
    const { scope, actor } = await knowledgeScope(c, deps);
    const rawDrafts = body["drafts"];
    if (rawDrafts !== undefined && !Array.isArray(rawDrafts)) throw apiError(400, "drafts 必须是数组");
    if (Array.isArray(rawDrafts) && rawDrafts.length > 200) throw apiError(400, "一次最多创建 200 条草稿");
    const id = body["id"] === undefined
      ? undefined
      : opaqueId(requiredText(body["id"], "页面 ID", 256), "页面");
    const summary = optionalText(body["summary"], "页面摘要", 2_000);
    const pageTags = stringList(body["tags"], "标签", { max: 50 });
    const command: CreateWikiPageCommand = {
      ...(id === undefined ? {} : { id }),
      title: requiredText(body["title"], "页面标题", 300),
      ...(summary === undefined ? {} : { summary }),
      ...(pageTags === undefined ? {} : { tags: pageTags }),
      ...(rawDrafts === undefined
        ? {}
        : { drafts: rawDrafts.map((draft, index) => draftSpec(draft, `drafts[${index}]`)) }),
      actor,
    };
    const page = await knowledgeCall(() => deps.wiki.createPage(scope, command));
    return c.json({ ok: true, page: storedPageView(page) }, 201);
  });

  app.get("/api/sessions/:sid/documents/wiki/pages/:pageId", async (c) => {
    rejectAuthorityQuery(c);
    const { scope } = await knowledgeScope(c, deps);
    const page = await knowledgeCall(() => deps.wiki.getPage(scope, opaqueId(c.req.param("pageId"), "页面")));
    return c.json({ page: storedPageView(page) });
  });

  app.patch("/api/sessions/:sid/documents/wiki/pages/:pageId", async (c) => {
    const body = await jsonBody(c);
    onlyFields(body, new Set(["expected_revision", "expectedRevision", "title", "summary", "tags"]), "修改页面");
    const { scope, actor } = await knowledgeScope(c, deps);
    const title = optionalText(body["title"], "页面标题", 300);
    const summary = optionalText(body["summary"], "页面摘要", 2_000);
    const pageTags = stringList(body["tags"], "标签", { max: 50 });
    if (title === undefined && summary === undefined && pageTags === undefined) {
      throw apiError(400, "没有需要修改的页面信息");
    }
    const command: UpdateWikiPageCommand = {
      expectedRevision: positiveRevision(body),
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      ...(pageTags === undefined ? {} : { tags: pageTags }),
      actor,
    };
    const page = await knowledgeCall(() =>
      deps.wiki.updatePage(scope, opaqueId(c.req.param("pageId"), "页面"), command));
    return c.json({ ok: true, page: storedPageView(page) });
  });

  app.get("/api/sessions/:sid/documents/wiki/pages/:pageId/history", async (c) => {
    rejectAuthorityQuery(c);
    const { scope } = await knowledgeScope(c, deps);
    const pageId = opaqueId(c.req.param("pageId"), "页面");
    const revisions = await knowledgeCall(() => deps.wiki.history(scope, pageId));
    return c.json({ page_id: pageId, revisions: revisions.map(revisionView) });
  });

  for (const action of ["archive", "restore"] as const) {
    app.post(`/api/sessions/:sid/documents/wiki/pages/:pageId/${action}`, async (c) => {
      const body = await jsonBody(c);
      onlyFields(body, new Set(["expected_revision", "expectedRevision"]), `${action} 页面`);
      const { scope, actor } = await knowledgeScope(c, deps);
      const command: ChangeWikiPageStatusCommand = {
        expectedRevision: positiveRevision(body),
        actor,
      };
      const pageId = opaqueId(c.req.param("pageId"), "页面");
      const page = await knowledgeCall(() => action === "archive"
        ? deps.wiki.archivePage(scope, pageId, command)
        : deps.wiki.restorePage(scope, pageId, command));
      return c.json({ ok: true, page: storedPageView(page) });
    });
  }

  app.post("/api/sessions/:sid/documents/wiki/pages/:pageId/claims", async (c) => {
    const body = await jsonBody(c);
    onlyFields(
      body,
      new Set(["expected_revision", "expectedRevision", "kind", "subject", "statement", "evidence_refs", "evidenceRefs", "supersedes_claim_id", "supersedesClaimId"]),
      "新增声明",
    );
    const { scope, actor } = await knowledgeScope(c, deps);
    const draft = draftSpec(body, "声明", true);
    const command: AddWikiDraftCommand = {
      ...draft,
      expectedRevision: positiveRevision(body),
      actor,
    };
    const page = await knowledgeCall(() =>
      deps.wiki.addDraft(scope, opaqueId(c.req.param("pageId"), "页面"), command));
    return c.json({ ok: true, page: storedPageView(page) }, 201);
  });

  app.patch("/api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId", async (c) => {
    const body = await jsonBody(c);
    onlyFields(
      body,
      new Set(["expected_revision", "expectedRevision", "kind", "subject", "statement", "evidence_refs", "evidenceRefs"]),
      "修改声明",
    );
    const { scope, actor } = await knowledgeScope(c, deps);
    const kind = optionalClaimKind(body["kind"]);
    const subject = optionalText(body["subject"], "声明主题", 300);
    const statement = optionalText(body["statement"], "声明正文", 8_000);
    const evidenceRefs = stringList(body["evidence_refs"] ?? body["evidenceRefs"], "evidence_refs");
    if (kind === undefined && subject === undefined && statement === undefined && evidenceRefs === undefined) {
      throw apiError(400, "没有需要修改的声明信息");
    }
    const command: EditWikiDraftCommand = {
      claimId: opaqueId(c.req.param("claimId"), "声明"),
      expectedRevision: positiveRevision(body),
      ...(kind === undefined ? {} : { kind }),
      ...(subject === undefined ? {} : { subject }),
      ...(statement === undefined ? {} : { statement }),
      ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
      actor,
    };
    const page = await knowledgeCall(() =>
      deps.wiki.editDraft(scope, opaqueId(c.req.param("pageId"), "页面"), command));
    return c.json({ ok: true, page: storedPageView(page) });
  });

  app.delete("/api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId", async (c) => {
    const body = await jsonBody(c);
    onlyFields(body, new Set(["expected_revision", "expectedRevision"]), "删除声明");
    const { scope, actor } = await knowledgeScope(c, deps);
    const page = await knowledgeCall(() => deps.wiki.removeDraft(
      scope,
      opaqueId(c.req.param("pageId"), "页面"),
      opaqueId(c.req.param("claimId"), "声明"),
      { expectedRevision: positiveRevision(body), actor },
    ));
    return c.json({ ok: true, page: storedPageView(page) });
  });

  app.post("/api/sessions/:sid/documents/wiki/pages/:pageId/claims/:claimId/confirm", async (c) => {
    const body = await jsonBody(c);
    onlyFields(body, new Set(["expected_revision", "expectedRevision", "evidence_refs", "evidenceRefs"]), "确认声明");
    const { scope, actor } = await knowledgeScope(c, deps);
    const evidenceRefs = stringList(
      body["evidence_refs"] ?? body["evidenceRefs"],
      "evidence_refs",
      { required: true },
    )!;
    if (evidenceRefs.some((ref) => !ref.startsWith("odoc.v1."))) {
      throw apiError(400, "确认依据必须是项目知识库中可打开的原文引用");
    }
    // 引用格式正确并不代表它存在、仍可访问或仍指向同一段正文。确认前逐条重新
    // open，让版本、chunk、正文哈希和最新 ACL 共同裁决，不能让任意字符串把草稿
    // 升级为“人工已确认”。
    const openedEvidence = await knowledgeCall(() => Promise.all(
      evidenceRefs.map((evidenceRef) => deps.documents.open(scope, { evidenceRef })),
    ));
    const readableDocuments = await knowledgeCall(() => deps.documents.list(scope));
    const adoptedByDocument = new Map(readableDocuments.map((document) => [
      document.id,
      document.adoptedVersionId,
    ] as const));
    const excerptByRef = new Map(openedEvidence.map((item) => [item.evidenceRef, {
      evidenceRef: item.evidenceRef,
      text: item.text,
      versionState: adoptedByDocument.get(item.documentId) === item.versionId
        ? "adopted" as const
        : adoptedByDocument.has(item.documentId)
          ? "unadopted" as const
          : "unknown" as const,
    }] as const));
    const command: ConfirmWikiClaimCommand = {
      claimId: opaqueId(c.req.param("claimId"), "声明"),
      expectedRevision: positiveRevision(body),
      evidenceRefs,
      actor,
    };
    const page = await knowledgeCall(() =>
      deps.wiki.confirmClaim(
        scope,
        opaqueId(c.req.param("pageId"), "页面"),
        command,
        async (evidenceRef) => {
          const excerpt = excerptByRef.get(evidenceRef);
          if (excerpt === undefined) throw new DocumentNotFoundOrForbidden();
          return excerpt;
        },
      ));
    return c.json({ ok: true, page: storedPageView(page) });
  });

  app.get("/api/sessions/:sid/documents/wiki/pages/:pageId/export.md", async (c) => {
    rejectAuthorityQuery(c);
    const { scope } = await knowledgeScope(c, deps);
    const markdown = await knowledgeCall(() =>
      deps.wiki.renderMarkdown(scope, opaqueId(c.req.param("pageId"), "页面")));
    return c.body(markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "attachment; filename=OntoDocument-Wiki.md",
    });
  });

  app.get("/api/sessions/:sid/documents/wiki/export/obsidian.zip", async (c) => {
    rejectAuthorityQuery(c);
    const { scope } = await knowledgeScope(c, deps);
    const bundle = await knowledgeCall(() => deps.wiki.buildObsidianVault(scope, {
      includeArchived: booleanQuery(c.req.query("include_archived"), "include_archived"),
    }));
    return c.body(toBody(vaultZip(bundle)), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=OntoDocument-Obsidian.zip",
    });
  });
}
