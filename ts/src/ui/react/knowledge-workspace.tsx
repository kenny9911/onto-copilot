import {
  useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement, type ReactNode,
} from "react";

import type { KnowledgeDocument, KnowledgeDocumentVersion } from "../knowledge-library.js";
import {
  knowledgeManagementApi,
  newManagementRequestId,
  type AclRuleView,
  type AclSnapshotView,
  type AuditEventView,
  type ConnectorSourceView,
  type DocumentDiffView,
  type DocumentImpactView,
  type DocumentJobView,
  type KnowledgeManagementApi,
  type WikiClaimKind,
  type WikiClaimView,
  type WikiDraftInput,
  type WikiStoredPageView,
} from "../knowledge-management.js";
import { KnowledgeLibrary, type KnowledgeSessionFile } from "./knowledge-library.js";

export type KnowledgeWorkspaceSection = "files" | "wiki" | "jobs" | "sources" | "access";

const TABS: Array<{ id: KnowledgeWorkspaceSection; label: string; note: string }> = [
  { id: "files", label: "文件", note: "版本、原文搜索与影响" },
  { id: "wiki", label: "项目 Wiki", note: "草稿和已确认知识" },
  { id: "jobs", label: "处理任务", note: "解析与 OCR" },
  { id: "sources", label: "数据源", note: "外部文件同步" },
  { id: "access", label: "权限审计", note: "访问规则与记录" },
];

const CLAIM_KINDS: Array<{ value: WikiClaimKind; label: string }> = [
  { value: "MATERIAL_FACT", label: "材料事实" },
  { value: "HUMAN_DECISION", label: "人工决定" },
  { value: "INFERENCE", label: "待验证推断" },
  { value: "GENERAL_GUIDANCE", label: "通用参考" },
  { value: "CONTESTED", label: "存在争议" },
  { value: "STALE", label: "可能已过期" },
];

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "这项操作没有完成，请稍后重试。";
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/[\n,，;；]/u).map((item) => item.trim()).filter(Boolean))];
}

function when(value: string | null | undefined): string {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value;
}

function upsertPage(pages: WikiStoredPageView[], next: WikiStoredPageView): WikiStoredPageView[] {
  const found = pages.some((item) => item.page.id === next.page.id);
  return (found ? pages.map((item) => item.page.id === next.page.id ? next : item) : [next, ...pages])
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function InlineState({ children, error = false }: { children: ReactNode; error?: boolean }): ReactElement {
  return <div className={error ? "odm-inline-error" : "odm-inline-state"}>{children}</div>;
}

function VersionReviewPanel({ sessionId, api }: {
  sessionId: string; api: KnowledgeManagementApi;
}): ReactElement {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [versions, setVersions] = useState<KnowledgeDocumentVersion[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diff, setDiff] = useState<DocumentDiffView | null>(null);
  const [impact, setImpact] = useState<DocumentImpactView | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void api.listDocuments(sessionId).then((rows) => {
      if (!alive) return;
      setDocuments(rows);
      setDocumentId((current) => current || rows[0]?.id || "");
      setError("");
    }).catch((reason) => { if (alive) setError(errorText(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, sessionId]);

  useEffect(() => {
    if (!documentId) { setVersions([]); return; }
    let alive = true;
    setDiff(null); setImpact(null);
    void api.history(sessionId, documentId).then((rows) => {
      if (!alive) return;
      const ordered = [...rows].sort((a, b) => a.version_no - b.version_no);
      setVersions(ordered);
      setFromId(ordered.length > 1 ? ordered[ordered.length - 2]!.id : ordered[0]?.id || "");
      setToId(ordered[ordered.length - 1]?.id || "");
      setError("");
    }).catch((reason) => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; };
  }, [api, documentId, sessionId]);

  const compare = async (): Promise<void> => {
    if (!documentId || !fromId || !toId || fromId === toId) return;
    setBusy(true); setError("");
    try {
      const [nextDiff, nextImpact] = await Promise.all([
        api.diff(sessionId, documentId, fromId, toId),
        api.impact(sessionId, documentId, fromId, toId),
      ]);
      setDiff(nextDiff); setImpact(nextImpact);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const changeCount = (scope: "chunks" | "tables" | "fields"): number => {
    const row = diff?.summary[scope];
    return row ? row.added + row.removed + row.modified : 0;
  };

  return <section className="odm-card odm-version-review" aria-label="版本变化与影响">
    <header className="odm-card-head">
      <div><h3>版本变化与影响</h3><p>只比较知识库里保存的两个固定版本；结果不会自动修改回答、模型或 Wiki。</p></div>
    </header>
    {loading ? <InlineState>正在读取版本…</InlineState> : documents.length === 0
      ? <InlineState>先保存一份项目文件，之后才能比较版本。</InlineState>
      : <div className="odm-compare-controls">
          <label><span>文件</span><select value={documentId} onChange={(event) => setDocumentId(event.target.value)}>
            {documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>
          <label><span>原版本</span><select value={fromId} onChange={(event) => setFromId(event.target.value)}>
            {versions.map((item) => <option key={item.id} value={item.id}>v{item.version_no} · {item.file_name}</option>)}
          </select></label>
          <label><span>新版本</span><select value={toId} onChange={(event) => setToId(event.target.value)}>
            {versions.map((item) => <option key={item.id} value={item.id}>v{item.version_no} · {item.file_name}</option>)}
          </select></label>
          <button type="button" className="act pri" disabled={busy || versions.length < 2 || fromId === toId}
            onClick={() => void compare()}>{busy ? "正在比较…" : "比较并检查影响"}</button>
        </div>}
    {versions.length === 1 ? <InlineState>这份文件目前只有一个版本，还不能比较。</InlineState> : null}
    {error ? <InlineState error>{error}</InlineState> : null}
    {diff ? <div className="odm-diff-result">
      <div className="odm-metrics">
        <span><strong>{changeCount("chunks")}</strong>处正文变化</span>
        <span><strong>{changeCount("tables")}</strong>张表变化</span>
        <span><strong>{changeCount("fields")}</strong>个字段变化</span>
        <span><strong>{impact?.stale_candidates.length ?? 0}</strong>项建议复核</span>
      </div>
      <p className={diff.has_changes ? "odm-review-warning" : "odm-safe-note"}>
        {diff.has_changes ? "发现版本差异。下方只列出可能受影响的内容，需要人工复核。" : "两个固定版本没有检测到内容变化。"}
      </p>
      {impact?.stale_candidates.map((item) => <article className="odm-impact-row" key={item.consumerId}>
        <strong>{item.label}</strong><span>建议复核</span>
        {item.reasons.map((reason, index) => <p key={index}>{reason.message}</p>)}
      </article>)}
      {impact?.unresolved.map((item) => <article className="odm-impact-row unresolved" key={item.consumerId}>
        <strong>{item.label}</strong><span>暂时无法判断</span>
      </article>)}
      <small>{impact?.notice}</small>
    </div> : null}
  </section>;
}

function WikiPageEditor({ initial, submitLabel, onCancel, onSubmit }: {
  initial?: WikiStoredPageView;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: { title: string; summary: string; tags: string[] }) => Promise<void>;
}): ReactElement {
  const [title, setTitle] = useState(initial?.page.title || "");
  const [summary, setSummary] = useState(initial?.page.summary || "");
  const [tags, setTags] = useState(initial?.page.tags.join("，") || "");
  return <form className="odm-form" onSubmit={(event) => {
    event.preventDefault();
    void onSubmit({ title: title.trim(), summary: summary.trim(), tags: splitLines(tags) });
  }}>
    <label><span>页面标题</span><input required maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="wide"><span>页面摘要</span><textarea maxLength={2_000} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
    <label className="wide"><span>标签（逗号分开）</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
    <div className="odm-form-actions"><button type="button" className="act" onClick={onCancel}>取消</button>
      <button type="submit" className="act pri">{submitLabel}</button></div>
  </form>;
}

function WikiClaimEditor({ initial, submitLabel, onCancel, onSubmit }: {
  initial?: WikiClaimView;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (value: WikiDraftInput) => Promise<void>;
}): ReactElement {
  const [kind, setKind] = useState<WikiClaimKind>(initial?.kind || "MATERIAL_FACT");
  const [subject, setSubject] = useState(initial?.subject || "");
  const [statement, setStatement] = useState(initial?.statement || "");
  const [evidence, setEvidence] = useState(initial?.evidence_refs.join("\n") || "");
  return <form className="odm-form odm-claim-editor" onSubmit={(event) => {
    event.preventDefault();
    void onSubmit({ kind, subject: subject.trim(), statement: statement.trim(), evidence_refs: splitLines(evidence) });
  }}>
    <label><span>知识类型</span><select value={kind} onChange={(event) => setKind(event.target.value as WikiClaimKind)}>
      {CLAIM_KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>
    <label><span>主题</span><input required maxLength={300} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label className="wide"><span>内容</span><textarea required maxLength={8_000} value={statement} onChange={(event) => setStatement(event.target.value)} /></label>
    <label className="wide"><span>证据引用（每行一条）</span><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)}
      placeholder="从文件搜索结果复制 evidence_ref；没有证据的内容只能保留为草稿" /></label>
    <div className="odm-form-actions"><button type="button" className="act" onClick={onCancel}>取消</button>
      <button type="submit" className="act pri">{submitLabel}</button></div>
  </form>;
}

function WikiPanel({ sessionId, api }: { sessionId: string; api: KnowledgeManagementApi }): ReactElement {
  const [pages, setPages] = useState<WikiStoredPageView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [mode, setMode] = useState<"none" | "create" | "edit-page" | "add-claim">("none");
  const [editClaimId, setEditClaimId] = useState("");
  const [confirmClaimId, setConfirmClaimId] = useState("");
  const [confirmEvidence, setConfirmEvidence] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = pages.find((item) => item.page.id === selectedId) || pages[0] || null;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true); setError("");
    try {
      const rows = await api.listWikiPages(sessionId, includeArchived);
      setPages(rows);
      setSelectedId((current) => rows.some((item) => item.page.id === current) ? current : rows[0]?.page.id || "");
    } catch (reason) { setError(errorText(reason)); }
    finally { setLoading(false); }
  }, [api, includeArchived, sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = async (operation: () => Promise<WikiStoredPageView>, message: string): Promise<void> => {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await operation();
      setPages((current) => upsertPage(current, next));
      setSelectedId(next.page.id); setMode("none"); setEditClaimId(""); setConfirmClaimId("");
      setNotice(message);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  return <section className="odm-section" aria-label="项目 Wiki">
    <div className="odm-boundary">
      <strong>AI 只能提交草稿，不能替人确认</strong>
      <span>带“人工已确认”的知识必须由真人点击确认，并至少保留一条可打开的材料证据。</span>
    </div>
    <div className="odm-toolbar">
      <label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> 显示已归档页面</label>
      <a className="act" href={api.obsidianUrl(sessionId, includeArchived)}>导出 Obsidian</a>
      <button type="button" className="act" onClick={() => void refresh()}>刷新</button>
      <button type="button" className="act pri" onClick={() => setMode("create")}>新建 Wiki 页面</button>
    </div>
    {notice ? <div className="odm-notice" aria-live="polite">{notice}</div> : null}
    {error ? <InlineState error>{error}</InlineState> : null}
    {mode === "create" ? <WikiPageEditor submitLabel={busy ? "正在创建…" : "创建页面"} onCancel={() => setMode("none")}
      onSubmit={async (input) => await mutate(() => api.createWikiPage(sessionId, input), "Wiki 页面已创建。")} /> : null}
    {loading ? <InlineState>正在读取项目 Wiki…</InlineState> : <div className="odm-wiki-grid">
      <aside className="odm-wiki-list" aria-label="Wiki 页面列表">
        {pages.length === 0 ? <InlineState>项目 Wiki 还是空的。可以新建页面，再逐条加入有出处的知识。</InlineState> : pages.map((item) =>
          <button type="button" className={selected?.page.id === item.page.id ? "on" : ""} key={item.page.id}
            onClick={() => { setSelectedId(item.page.id); setMode("none"); }}>
            <strong>{item.page.title}</strong><span>{item.page.claims.length} 条知识 · {item.status === "archived" ? "已归档" : "使用中"}</span>
          </button>)}
      </aside>
      {selected ? <article className="odm-wiki-page">
        <header><div><h3>{selected.page.title}</h3><p>{selected.page.summary || "还没有页面摘要。"}</p>
          <small>{selected.page.tags.join(" · ") || "没有标签"}</small></div>
          <div className="odm-actions">
            <a className="act" href={api.wikiMarkdownUrl(sessionId, selected.page.id)}>导出 Markdown</a>
            <button type="button" className="act" onClick={() => setMode("edit-page")}>编辑页面信息</button>
            <button type="button" className="act" disabled={busy} onClick={() => void mutate(
              () => api.changeWikiPageStatus(sessionId, selected.page.id, selected.revision,
                selected.status === "archived" ? "restore" : "archive"),
              selected.status === "archived" ? "页面已恢复。" : "页面已归档；历史仍被保留。",
            )}>{selected.status === "archived" ? "恢复页面" : "归档页面"}</button>
          </div></header>
        {mode === "edit-page" ? <WikiPageEditor initial={selected} submitLabel="保存页面信息" onCancel={() => setMode("none")}
          onSubmit={async (input) => await mutate(() => api.updateWikiPage(sessionId, selected.page.id, selected.revision, input), "页面信息已更新。")} /> : null}
        <div className="odm-claims-head"><h4>页面知识</h4><button type="button" className="act pri" onClick={() => setMode("add-claim")}>新增草稿</button></div>
        {mode === "add-claim" ? <WikiClaimEditor submitLabel="保存为待确认草稿" onCancel={() => setMode("none")}
          onSubmit={async (input) => await mutate(() => api.addWikiDraft(sessionId, selected.page.id, selected.revision, input), "草稿已保存，尚未成为已确认知识。")} /> : null}
        <div className="odm-claim-list">
          {selected.page.claims.length === 0 ? <InlineState>这个页面还没有知识条目。</InlineState> : selected.page.claims.map((claim) => {
            const editing = editClaimId === claim.id;
            const confirming = confirmClaimId === claim.id;
            return <section className={`odm-claim ${claim.state}`} key={claim.id}>
              <header><div><strong>{claim.subject}</strong><span>{CLAIM_KINDS.find((item) => item.value === claim.kind)?.label}</span></div>
                <span className={`odm-claim-state ${claim.state}`}>
                  {claim.state === "confirmed" ? "人工已确认" : claim.author.kind === "ai" ? "AI 草稿 · 待人工确认" : "人工草稿 · 待确认"}
                </span></header>
              <p>{claim.statement}</p>
              <div className="odm-evidence-refs">{claim.evidence_refs.length
                ? claim.evidence_refs.map((ref) => <code key={ref}>{ref}</code>)
                : <em>没有材料证据，不能确认</em>}</div>
              {claim.state === "draft" ? <div className="odm-actions">
                <button type="button" className="act" onClick={() => { setEditClaimId(claim.id); setConfirmClaimId(""); }}>编辑草稿</button>
                <button type="button" className="act" onClick={() => { setConfirmClaimId(claim.id); setEditClaimId(""); setConfirmEvidence(claim.evidence_refs.join("\n")); }}>审阅并确认</button>
                <button type="button" className="act danger" onClick={() => void mutate(
                  () => api.removeWikiDraft(sessionId, selected.page.id, claim.id, selected.revision), "草稿已删除。",
                )}>删除草稿</button>
              </div> : <small>确认时间：{when(claim.confirmation?.confirmed_at)} · 确认证据不会被草稿覆盖</small>}
              {editing ? <WikiClaimEditor initial={claim} submitLabel="保存草稿修改" onCancel={() => setEditClaimId("")}
                onSubmit={async (input) => await mutate(() => api.editWikiDraft(sessionId, selected.page.id, claim.id, selected.revision, input), "草稿已更新，仍需人工确认。")} /> : null}
              {confirming ? <form className="odm-confirm" onSubmit={(event) => {
                event.preventDefault();
                const refs = splitLines(confirmEvidence);
                if (refs.length) void mutate(() => api.confirmWikiClaim(sessionId, selected.page.id, claim.id, selected.revision, refs), "这条知识已由当前用户确认。");
              }}><label><span>本次确认依据（至少一条）</span><textarea required value={confirmEvidence} onChange={(event) => setConfirmEvidence(event.target.value)} /></label>
                <div><button type="button" className="act" onClick={() => setConfirmClaimId("")}>取消</button>
                  <button type="submit" className="act pri" disabled={splitLines(confirmEvidence).length === 0}>确认这是项目知识</button></div>
              </form> : null}
            </section>;
          })}
        </div>
      </article> : null}
    </div>}
  </section>;
}

const JOB_STATUS: Record<DocumentJobView["status"], string> = {
  queued: "等待处理", running: "处理中", succeeded: "处理完成", failed: "处理失败", cancelled: "已取消",
};

function JobsPanel({ sessionId, api }: { sessionId: string; api: KnowledgeManagementApi }): ReactElement {
  const [jobs, setJobs] = useState<DocumentJobView[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [documentId, setDocumentId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [kind, setKind] = useState<"parse" | "ocr">("parse");
  const [cancelId, setCancelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const [nextJobs, nextDocs] = await Promise.all([api.listJobs(sessionId), api.listDocuments(sessionId)]);
      setJobs(nextJobs); setDocuments(nextDocs);
      const first = nextDocs[0];
      setDocumentId((current) => current || first?.id || "");
      setVersionId((current) => current || first?.adopted_version_id || first?.current_version_id || "");
    } catch (reason) { setError(errorText(reason)); }
  }, [api, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const chooseDocument = (id: string): void => {
    setDocumentId(id);
    const row = documents.find((item) => item.id === id);
    setVersionId(row?.adopted_version_id || row?.current_version_id || "");
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!documentId || !versionId) return;
    setBusy(true); setError("");
    try {
      const job = await api.createJob(sessionId, {
        document_id: documentId, version_id: versionId, kind,
        idempotency_key: newManagementRequestId(`${kind}-${versionId.slice(0, 24)}`),
      });
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setShowForm(false); setNotice("处理任务已创建。完成后只会生成候选结果，不会自动替换项目采用版。");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  return <section className="odm-section" aria-label="处理任务">
    <div className="odm-boundary"><strong>后台处理不等于采纳</strong><span>解析和 OCR 只生成可核验候选；不会静默替换文件、采用新版或写入 Wiki。</span></div>
    <div className="odm-toolbar"><button type="button" className="act" onClick={() => void refresh()}>刷新任务</button>
      <button type="button" className="act pri" onClick={() => setShowForm(true)}>新建处理任务</button></div>
    {showForm ? <form className="odm-form" onSubmit={(event) => void create(event)}>
      <label><span>文件</span><select required value={documentId} onChange={(event) => chooseDocument(event.target.value)}>
        {documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label><span>固定版本</span><input required value={versionId} onChange={(event) => setVersionId(event.target.value)} /></label>
      <label><span>处理方式</span><select value={kind} onChange={(event) => setKind(event.target.value as "parse" | "ocr")}>
        <option value="parse">重新解析正文</option><option value="ocr">OCR 识别扫描件</option></select></label>
      <div className="odm-form-actions"><button type="button" className="act" onClick={() => setShowForm(false)}>取消</button>
        <button type="submit" className="act pri" disabled={busy || !versionId}>{busy ? "正在创建…" : "确认创建任务"}</button></div>
    </form> : null}
    {notice ? <div className="odm-notice">{notice}</div> : null}
    {error ? <InlineState error>{error}</InlineState> : null}
    <div className="odm-job-list">{jobs.length === 0 && !error ? <InlineState>目前没有处理任务。</InlineState> : jobs.map((job) =>
      <article className="odm-job" key={job.id}><header><strong>{job.kind === "ocr" ? "OCR 识别" : "正文解析"}</strong>
        <span className={`odm-job-status ${job.status}`}>{JOB_STATUS[job.status]}</span></header>
        <p>文件 {job.document_id} · 版本 {job.version_id}</p>
        <small>尝试 {job.attempts}/{job.max_attempts} · 更新于 {when(job.updated_at)}</small>
        {job.last_error ? <div className="odm-inline-error">{job.last_error}</div> : null}
        {job.candidate_ready ? <div className="odm-safe-note">已有候选结果，等待后续人工检查和采纳。</div> : null}
        {job.status === "queued" || job.status === "running" ? <div className="odm-actions">
          {cancelId === job.id ? <><span>确定取消这个任务？</span><button type="button" className="act" onClick={() => setCancelId("")}>保留任务</button>
            <button type="button" className="act danger" onClick={() => void (async () => {
              setBusy(true);
              try { const next = await api.cancelJob(sessionId, job.id); setJobs((current) => current.map((item) => item.id === job.id ? next : item)); }
              catch (reason) { setError(errorText(reason)); } finally { setBusy(false); setCancelId(""); }
            })()}>确认取消</button></> : <button type="button" className="act" onClick={() => setCancelId(job.id)}>取消任务</button>}
        </div> : null}
      </article>)}</div>
  </section>;
}

const PROVIDERS: Array<{ value: ConnectorSourceView["provider"]; label: string }> = [
  { value: "sharepoint", label: "SharePoint" }, { value: "webdav", label: "WebDAV" },
  { value: "s3", label: "S3" }, { value: "confluence", label: "Confluence" },
  { value: "datahub", label: "DataHub" }, { value: "openmetadata", label: "OpenMetadata" },
];

function SourceEditor({ source, onCancel, onSubmit }: {
  source: ConnectorSourceView;
  onCancel: () => void;
  onSubmit: (input: Partial<Pick<ConnectorSourceView,
    "provider" | "name" | "root_or_prefix" | "credential_ref" | "classification">>) => Promise<void>;
}): ReactElement {
  const [provider, setProvider] = useState(source.provider);
  const [name, setName] = useState(source.name);
  const [root, setRoot] = useState(source.root_or_prefix);
  const [credentialRef, setCredentialRef] = useState(source.credential_ref);
  const [classification, setClassification] = useState(source.classification);
  return <form className="odm-form" onSubmit={(event) => {
    event.preventDefault();
    void onSubmit({ provider, name: name.trim(), root_or_prefix: root.trim(), credential_ref: credentialRef.trim(), classification });
  }}>
    <label><span>类型</span><select value={provider} onChange={(event) => setProvider(event.target.value as ConnectorSourceView["provider"])}>
      {PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    <label><span>显示名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><span>远端根目录或前缀</span><input required value={root} onChange={(event) => setRoot(event.target.value)} /></label>
    <label><span>凭据引用</span><input required value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} /></label>
    <label><span>密级</span><select value={classification} onChange={(event) => setClassification(event.target.value as ConnectorSourceView["classification"])}>
      <option value="public">公开</option><option value="internal">内部</option><option value="confidential">机密</option><option value="restricted">严格受限</option></select></label>
    <div className="odm-form-actions"><button type="button" className="act" onClick={onCancel}>取消</button>
      <button type="submit" className="act pri">保存数据源设置</button></div>
  </form>;
}

function SourcesPanel({ sessionId, api }: { sessionId: string; api: KnowledgeManagementApi }): ReactElement {
  const [sources, setSources] = useState<ConnectorSourceView[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState<ConnectorSourceView["provider"]>("sharepoint");
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [classification, setClassification] = useState<ConnectorSourceView["classification"]>("internal");
  const [editId, setEditId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setError("");
    try { setSources(await api.listConnectors(sessionId, true)); setLoadFailed(false); }
    catch (reason) { setError(errorText(reason)); setLoadFailed(true); }
  }, [api, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const lifecycle = async (source: ConnectorSourceView, action: "enable" | "disable" | "archive" | "restore"): Promise<void> => {
    setBusy(source.id); setError("");
    try {
      const next = await api.changeConnectorStatus(sessionId, source.id, source.revision, action);
      setSources((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(""); }
  };

  return <section className="odm-section" aria-label="项目数据源">
    <div className="odm-boundary"><strong>这里只保存凭据引用，不接收密码或 Token</strong>
      <span>真实凭据由运行环境管理；AI 和浏览器响应都看不到密钥、服务地址或本机路径。</span></div>
    <div className="odm-toolbar"><button type="button" className="act" onClick={() => void refresh()}>刷新数据源</button>
      <button type="button" className="act pri" onClick={() => setShowForm(true)}>添加数据源</button></div>
    {showForm ? <form className="odm-form" onSubmit={(event) => void (async () => {
      event.preventDefault(); setBusy("create"); setError("");
      try {
        const source = await api.createConnector(sessionId, {
          request_id: newManagementRequestId("source"), provider, name: name.trim(), root_or_prefix: root.trim(),
          credential_ref: credentialRef.trim(), classification,
        });
        setSources((current) => [source, ...current]); setShowForm(false); setNotice("数据源已添加；只有点击同步后才会读取远端变化。");
      } catch (reason) { setError(errorText(reason)); } finally { setBusy(""); }
    })()}>
      <label><span>类型</span><select value={provider} onChange={(event) => setProvider(event.target.value as ConnectorSourceView["provider"])}>
        {PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label><span>显示名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>远端根目录或前缀</span><input required value={root} onChange={(event) => setRoot(event.target.value)} /></label>
      <label><span>凭据引用</span><input required value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} placeholder="例如 vault://team/sharepoint" /></label>
      <label><span>密级</span><select value={classification} onChange={(event) => setClassification(event.target.value as ConnectorSourceView["classification"])}>
        <option value="public">公开</option><option value="internal">内部</option><option value="confidential">机密</option><option value="restricted">严格受限</option></select></label>
      <div className="odm-form-actions"><button type="button" className="act" onClick={() => setShowForm(false)}>取消</button>
        <button type="submit" className="act pri" disabled={busy === "create"}>确认添加</button></div>
    </form> : null}
    {notice ? <div className="odm-notice">{notice}</div> : null}
    {loadFailed ? <div className="odm-unavailable"><strong>数据源管理暂时不可用</strong><p>{error}</p><small>这不代表已有数据源或文件被删除；可能只是服务端尚未启用该模块。</small></div>
      : error ? <InlineState error>{error}</InlineState> : null}
    <div className="odm-source-list">{sources.map((source) => <article className="odm-source" key={source.id}>
      <header><div><strong>{source.name}</strong><span>{PROVIDERS.find((item) => item.value === source.provider)?.label} · {source.classification}</span></div>
        <span className={source.status === "error" ? "error" : source.enabled ? "enabled" : "disabled"}>{source.status === "archived" ? "已归档" : source.status === "syncing" ? "同步中" : source.status === "error" ? "同步异常" : source.enabled ? "已启用" : "已停用"}</span></header>
      <p>{source.root_or_prefix}</p><small>凭据引用：{source.credential_ref} · 上次完成：{when(source.last_completed_at)}</small>
      {source.last_error ? <InlineState error>{source.last_error}</InlineState> : null}
      <div className="odm-actions">
        {source.status !== "archived" ? <>
          <button type="button" className="act" disabled={busy === source.id || source.status === "syncing"}
            onClick={() => setEditId(source.id)}>编辑设置</button>
          <button type="button" className="act pri" disabled={busy === source.id || !source.enabled || source.status === "syncing"} onClick={() => void (async () => {
            setBusy(source.id); setError("");
            try {
              const report = await api.syncConnector(sessionId, source.id, source.revision);
              setNotice(`同步完成：新增或更新 ${report.upserted} 项，删除 ${report.deleted} 项，权限更新 ${report.acl_updated} 项。`);
              await refresh();
            } catch (reason) {
              if ((reason as Error & { status?: number })?.status === 503) {
                setError("");
                setNotice(errorText(reason));
              } else setError(errorText(reason));
            } finally { setBusy(""); }
          })()}>立即同步</button>
          <button type="button" className="act" disabled={busy === source.id} onClick={() => void lifecycle(source, source.enabled ? "disable" : "enable")}>
            {source.enabled ? "停用" : "启用"}</button>
          <button type="button" className="act danger" disabled={busy === source.id} onClick={() => void lifecycle(source, "archive")}>归档</button>
        </> : <button type="button" className="act" onClick={() => void lifecycle(source, "restore")}>恢复</button>}
      </div>
      {editId === source.id ? <SourceEditor source={source} onCancel={() => setEditId("")} onSubmit={async (input) => {
        setBusy(source.id); setError("");
        try {
          const next = await api.updateConnector(sessionId, source.id, source.revision, input);
          setSources((current) => current.map((item) => item.id === next.id ? next : item));
          setEditId(""); setNotice("数据源设置已更新；远端内容仍要由你点击同步后读取。");
        } catch (reason) { setError(errorText(reason)); } finally { setBusy(""); }
      }} /> : null}
    </article>)}</div>
  </section>;
}

function cleanAclRule(rule: AclRuleView, index: number): AclRuleView {
  const scope = rule.resource.scope_type;
  return {
    ...rule,
    id: rule.id || `rule-${index + 1}`,
    resource: {
      scope_type: scope,
      ...(scope === "document" || scope === "version" || scope === "chunk" ? { document_id: rule.resource.document_id || "" } : {}),
      ...(scope === "version" || scope === "chunk" ? { version_id: rule.resource.version_id || "" } : {}),
      ...(scope === "chunk" ? { chunk_id: rule.resource.chunk_id || "" } : {}),
    },
  };
}

function AccessPanel({ sessionId, api }: { sessionId: string; api: KnowledgeManagementApi }): ReactElement {
  const [acl, setAcl] = useState<AclSnapshotView | null>(null);
  const [rules, setRules] = useState<AclRuleView[]>([]);
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const [nextAcl, nextEvents] = await Promise.all([api.acl(sessionId), api.audit(sessionId)]);
      setAcl(nextAcl); setRules(nextAcl.rules.map(cleanAclRule)); setEvents(nextEvents);
    } catch (reason) { setError(errorText(reason)); }
  }, [api, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const update = (index: number, operation: (rule: AclRuleView) => AclRuleView): void => {
    setRules((current) => current.map((rule, row) => row === index ? cleanAclRule(operation(rule), row) : rule));
  };

  return <section className="odm-section" aria-label="权限与审计">
    <div className="odm-boundary"><strong>权限修改只接受人工按钮提交</strong><span>搜索、打开原文和 AI 调用都使用同一版规则。当前版本以项目所属账号为访问边界；用户组共享需要宿主身份系统接入后才能启用。</span></div>
    <div className="odm-toolbar"><button type="button" className="act" onClick={() => void refresh()}>刷新权限和记录</button>
      {!editing ? <button type="button" className="act pri" disabled={!acl} onClick={() => setEditing(true)}>编辑权限</button> : null}</div>
    {notice ? <div className="odm-notice">{notice}</div> : null}{error ? <InlineState error>{error}</InlineState> : null}
    <section className="odm-card"><header className="odm-card-head"><div><h3>访问规则</h3><p>当前修订版：{acl?.revision ?? "—"}</p></div></header>
      {editing ? <form onSubmit={(event) => void (async () => {
        event.preventDefault(); if (!acl) return; setBusy(true); setError("");
        try {
          const next = await api.replaceAcl(sessionId, acl.revision, rules.map(cleanAclRule));
          setAcl(next); setRules(next.rules.map(cleanAclRule)); setEditing(false); setNotice("权限设置已更新，新的读取和搜索会立即使用这版规则。");
        } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
      })()}>
        <div className="odm-acl-editor">{rules.map((rule, index) => <div className="odm-acl-rule" key={`${rule.id}-${index}`}>
          <label><span>规则 ID</span><input required value={rule.id} onChange={(event) => update(index, (row) => ({ ...row, id: event.target.value }))} /></label>
          <label><span>对象</span>{rule.subject.type === "group"
            ? <input value="用户组（由宿主身份系统管理）" disabled />
            : <select value="principal" aria-label="权限对象" disabled><option value="principal">用户</option></select>}</label>
          <label><span>{rule.subject.type === "group" ? "用户组 ID" : "用户 ID"}</span><input required disabled={rule.subject.type === "group"} value={rule.subject.id} onChange={(event) => update(index, (row) => ({ ...row, subject: { ...row.subject, id: event.target.value } }))} /></label>
          <label><span>效果</span><select value={rule.effect} onChange={(event) => update(index, (row) => ({ ...row, effect: event.target.value as "allow" | "deny" }))}>
            <option value="allow">允许</option><option value="deny">拒绝</option></select></label>
          <label><span>权限</span><select value={rule.permission} onChange={(event) => update(index, (row) => ({ ...row, permission: event.target.value as AclRuleView["permission"] }))}>
            <option value="read">读取</option><option value="write">管理文件</option><option value="manage_acl">管理权限</option></select></label>
          <label><span>范围</span><select value={rule.resource.scope_type} onChange={(event) => update(index, (row) => ({ ...row, resource: { scope_type: event.target.value as AclRuleView["resource"]["scope_type"] } }))}>
            <option value="project">整个项目</option><option value="document">一份文档</option><option value="version">一个版本</option><option value="chunk">一个原文片段</option></select></label>
          {rule.resource.scope_type !== "project" ? <label><span>文档 ID</span><input required value={rule.resource.document_id || ""} onChange={(event) => update(index, (row) => ({ ...row, resource: { ...row.resource, document_id: event.target.value } }))} /></label> : null}
          {rule.resource.scope_type === "version" || rule.resource.scope_type === "chunk" ? <label><span>版本 ID</span><input required value={rule.resource.version_id || ""} onChange={(event) => update(index, (row) => ({ ...row, resource: { ...row.resource, version_id: event.target.value } }))} /></label> : null}
          {rule.resource.scope_type === "chunk" ? <label><span>片段 ID</span><input required value={rule.resource.chunk_id || ""} onChange={(event) => update(index, (row) => ({ ...row, resource: { ...row.resource, chunk_id: event.target.value } }))} /></label> : null}
          <button type="button" className="act danger" onClick={() => setRules((current) => current.filter((_, row) => row !== index))}>移除这条规则</button>
        </div>)}</div>
        <div className="odm-form-actions"><button type="button" className="act" onClick={() => { setEditing(false); setRules((acl?.rules ?? []).map(cleanAclRule)); }}>取消修改</button>
          <button type="button" className="act" onClick={() => setRules((current) => [...current, {
            id: `rule-${current.length + 1}`, subject: { type: "principal", id: "" }, effect: "allow", permission: "read",
            resource: { scope_type: "project" }, changed_revision: acl?.revision ?? 0, created_by: "", created_at: "",
          }])}>添加规则</button><button type="submit" className="act pri" disabled={busy}>确认保存权限</button></div>
      </form> : <div className="odm-acl-list">{rules.length === 0 ? <InlineState>当前没有额外访问规则。</InlineState> : rules.map((rule) => <div key={rule.id}>
        <strong>{rule.effect === "allow" ? "允许" : "拒绝"} {rule.subject.type === "group" ? "用户组" : "用户"} {rule.subject.id}</strong>
        <span>{rule.permission === "read" ? "读取" : rule.permission === "write" ? "管理文件" : "管理权限"} · {rule.resource.scope_type}</span>
      </div>)}</div>}
    </section>
    <section className="odm-card"><header className="odm-card-head"><div><h3>最近的安全记录</h3><p>这里只展示系统实际执行的允许/拒绝决定，不由模型概括。</p></div></header>
      <div className="odm-audit-list">{events.length === 0 ? <InlineState>目前没有安全记录。</InlineState> : events.map((event, index) => <div key={`${event.action}-${index}`}>
        <span className={event.decision === "deny" ? "deny" : "allow"}>{event.decision === "deny" ? "已拒绝" : "已允许"}</span>
        <strong>{event.action}</strong><small>{event.scope_type} · ACL r{event.acl_revision}
          {event.allowed_count === undefined ? "" : ` · 允许 ${event.allowed_count}`}
          {event.denied_count === undefined ? "" : ` · 拒绝 ${event.denied_count}`}</small>
      </div>)}</div>
    </section>
  </section>;
}

export interface KnowledgeWorkspaceProps {
  sessionId: string;
  sessionFiles: KnowledgeSessionFile[];
  api?: KnowledgeManagementApi;
}

export function KnowledgeWorkspace({ sessionId, sessionFiles, api = knowledgeManagementApi }: KnowledgeWorkspaceProps): ReactElement {
  const [section, setSection] = useState<KnowledgeWorkspaceSection>("files");
  const body = useMemo(() => {
    if (section === "files") return <div className="odm-files">
      <KnowledgeLibrary sessionId={sessionId} sessionFiles={sessionFiles} />
      <VersionReviewPanel sessionId={sessionId} api={api} />
    </div>;
    if (section === "wiki") return <WikiPanel sessionId={sessionId} api={api} />;
    if (section === "jobs") return <JobsPanel sessionId={sessionId} api={api} />;
    if (section === "sources") return <SourcesPanel sessionId={sessionId} api={api} />;
    return <AccessPanel sessionId={sessionId} api={api} />;
  }, [api, section, sessionFiles, sessionId]);

  return <div className="odm-workspace">
    <nav className="odm-tabs" aria-label="项目知识库管理分区" role="tablist">
      {TABS.map((tab) => <button type="button" role="tab" id={`odm-tab-${tab.id}`}
        aria-controls="odm-active-panel" key={tab.id} aria-selected={section === tab.id}
        className={section === tab.id ? "on" : ""} onClick={() => setSection(tab.id)}>
        <strong>{tab.label}</strong><small>{tab.note}</small>
      </button>)}
    </nav>
    <div className="odm-panel" id="odm-active-panel" role="tabpanel" aria-labelledby={`odm-tab-${section}`}>{body}</div>
  </div>;
}

export default KnowledgeWorkspace;
