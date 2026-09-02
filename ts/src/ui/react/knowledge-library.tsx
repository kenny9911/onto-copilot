import {
  useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement,
} from "react";

import { fmtSize } from "../dom.js";
import {
  knowledgeLibraryApi,
  type KnowledgeAttachment,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
  type KnowledgeLibraryApi,
  type KnowledgeMutationResult,
  type KnowledgeOpenResult,
  type KnowledgeSearchResult,
  type KnowledgeSourceClass,
  type UpdateKnowledgeInput,
} from "../knowledge-library.js";
import { useUi } from "./store.js";

export interface KnowledgeSessionFile {
  name: string;
  state?: string;
  issue?: string;
}

export interface KnowledgeLibraryProps {
  sessionId: string;
  sessionFiles: KnowledgeSessionFile[];
  api?: KnowledgeLibraryApi;
}

type Histories = Record<string, KnowledgeDocumentVersion[] | null | undefined>;

const SOURCE_LABELS: Record<KnowledgeSourceClass, [string, string]> = {
  session_upload: ["会话上传", "Session upload"],
  generated: ["系统生成", "Generated"],
  external: ["外部文件", "External"],
  imported: ["导入文件", "Imported"],
};

function words(zh: string, en: string, lang: string): string {
  return lang === "en" ? en : zh;
}

export function splitKnowledgeTags(value: string): string[] {
  return [...new Set(value.split(/[,，;；\n]/u).map((tag) => tag.trim()).filter(Boolean))];
}

export function sourceClassLabel(value: KnowledgeSourceClass, lang = "zh"): string {
  return SOURCE_LABELS[value]?.[lang === "en" ? 1 : 0] || value;
}

export function parseStatusLabel(value: string, lang = "zh"): string {
  if (value === "ready") return words("已读入", "Parsed", lang);
  if (value === "degraded") return words("只读入一部分", "Partially parsed", lang);
  return words("解析状态未知", "Parse status unknown", lang);
}

function versionParseStatusLabel(version: KnowledgeDocumentVersion, lang: string): string {
  if (version.chunk_count === 0) {
    return words("尚未读到可搜索正文", "No searchable text yet", lang);
  }
  return parseStatusLabel(version.parse_status, lang);
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function when(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value || words("时间未知", "Unknown time", lang);
  return date.toLocaleString(lang === "en" ? "en-US" : "zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function errorMessage(error: unknown, lang: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return words("知识库没有完成这次操作，请稍后重试。", "The library could not complete this action. Try again.", lang);
}

function attachedVersion(
  documentId: string,
  attachments: readonly KnowledgeAttachment[],
): KnowledgeAttachment | undefined {
  return attachments.find((item) => item.document_id === documentId);
}

interface MetadataEditorProps {
  document: KnowledgeDocument;
  busy: boolean;
  lang: string;
  onCancel: () => void;
  onSave: (input: UpdateKnowledgeInput) => Promise<void>;
}

function MetadataEditor({ document, busy, lang, onCancel, onSave }: MetadataEditorProps): ReactElement {
  const [title, setTitle] = useState(document.title);
  const [logicalName, setLogicalName] = useState(document.logical_name);
  const [classification, setClassification] = useState<KnowledgeSourceClass>(document.source_class);
  const [tags, setTags] = useState(document.tags.join("，"));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void onSave({
      expected_revision: document.revision,
      title: title.trim(),
      logical_name: logicalName.trim(),
      classification,
      tags: splitKnowledgeTags(tags),
    });
  };

  return <form className="od-editor" onSubmit={submit} aria-label={words("编辑文档信息", "Edit document details", lang)}>
    <label>
      <span>{words("显示标题", "Title", lang)}</span>
      <input value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} />
    </label>
    <label>
      <span>{words("业务名称", "Business name", lang)}</span>
      <input value={logicalName} maxLength={200} required onChange={(event) => setLogicalName(event.target.value)} />
    </label>
    <label>
      <span>{words("来源", "Source", lang)}</span>
      <select value={classification} onChange={(event) => setClassification(event.target.value as KnowledgeSourceClass)}>
        {(Object.keys(SOURCE_LABELS) as KnowledgeSourceClass[]).map((value) => (
          <option key={value} value={value}>{sourceClassLabel(value, lang)}</option>
        ))}
      </select>
    </label>
    <label className="od-editor-wide">
      <span>{words("标签（用逗号分开）", "Tags (comma separated)", lang)}</span>
      <input value={tags} maxLength={1_000} onChange={(event) => setTags(event.target.value)} />
    </label>
    <div className="od-editor-actions">
      <button type="button" className="act" disabled={busy} onClick={onCancel}>{words("取消", "Cancel", lang)}</button>
      <button type="submit" className="act pri" disabled={busy}>{busy ? words("正在保存…", "Saving…", lang) : words("保存", "Save", lang)}</button>
    </div>
  </form>;
}

interface VersionListProps {
  document: KnowledgeDocument;
  versions: KnowledgeDocumentVersion[] | null | undefined;
  attachment: KnowledgeAttachment | undefined;
  sessionFiles: KnowledgeSessionFile[];
  busy: string;
  lang: string;
  onAttach: (version: KnowledgeDocumentVersion) => Promise<void>;
  onDetach: () => Promise<void>;
  onAdopt: (version: KnowledgeDocumentVersion) => Promise<void>;
  onAddVersion: (fileName: string) => Promise<void>;
}

function VersionList({
  document, versions, attachment, sessionFiles, busy, lang,
  onAttach, onDetach, onAdopt, onAddVersion,
}: VersionListProps): ReactElement {
  const [fileName, setFileName] = useState(sessionFiles[0]?.name || "");
  useEffect(() => {
    if (!sessionFiles.some((file) => file.name === fileName)) setFileName(sessionFiles[0]?.name || "");
  }, [fileName, sessionFiles]);

  return <div className="od-version-area">
    {versions === undefined ? <div className="od-inline-state">{words("正在读取版本记录…", "Loading version history…", lang)}</div>
      : versions === null ? <div className="od-inline-error">{words("版本记录暂时读不到；文档本身没有丢失。", "Version history is temporarily unavailable; the document is safe.", lang)}</div>
        : versions.length === 0 ? <div className="od-inline-state">{words("还没有可用版本。", "No versions are available.", lang)}</div>
          : <ol className="od-version-list">
            {versions.map((version) => {
              const adopted = document.adopted_version_id === version.id;
              const current = document.current_version_id === version.id;
              const inRun = attachment?.version_id === version.id;
              return <li className="od-version" key={version.id}>
                <div className="od-version-main">
                  <div className="od-version-name">
                    <strong>v{version.version_no} · {version.file_name}</strong>
                    {adopted ? <span className="od-badge adopted">{words("项目采用版", "Adopted", lang)}</span> : null}
                    {current ? <span className="od-badge current">{words("最新上传", "Latest upload", lang)}</span> : null}
                    {inRun ? <span className="od-badge attached">{words("本次分析在用", "Used in this run", lang)}</span> : null}
                  </div>
                  <div className="od-version-meta">
                    <span className={`od-parse ${version.parse_status}`}>{versionParseStatusLabel(version, lang)}</span>
                    <span>{version.chunk_count} {words("个可检索片段", "searchable chunks", lang)}</span>
                    <span>{fmtSize(version.size_bytes)}</span>
                    <span>{when(version.created_at, lang)}</span>
                    <span title={version.sha256}>SHA {shortId(version.sha256)}</span>
                  </div>
                </div>
                <div className="od-version-actions">
                  {inRun
                    ? <button type="button" className="act" disabled={Boolean(busy)} onClick={() => void onDetach()}>{words("移出本次分析", "Remove from run", lang)}</button>
                    : <button type="button" className="act" disabled={Boolean(busy)} onClick={() => void onAttach(version)}>{words("用于本次分析", "Use in this run", lang)}</button>}
                  {!adopted ? <button type="button" className="act" disabled={Boolean(busy)} onClick={() => void onAdopt(version)}>{words("设为项目采用版", "Set as adopted", lang)}</button> : null}
                </div>
              </li>;
            })}
          </ol>}

    <form className="od-add-version" onSubmit={(event) => {
      event.preventDefault();
      if (fileName) void onAddVersion(fileName);
    }}>
      <div>
        <strong>{words("从本次上传材料增加新版本", "Add a version from this session", lang)}</strong>
        <small>{words("新版本不会自动替换项目采用版，也不会改掉正在运行的分析。", "A new version will not silently replace the adopted or running version.", lang)}</small>
      </div>
      {sessionFiles.length ? <>
        <select aria-label={words("选择本次上传文件", "Choose an uploaded file", lang)} value={fileName} onChange={(event) => setFileName(event.target.value)}>
          {sessionFiles.map((file) => <option value={file.name} key={file.name}>{file.name}</option>)}
        </select>
        <button type="submit" className="act" disabled={Boolean(busy) || !fileName}>{words("保存为新版本", "Save as new version", lang)}</button>
      </> : <span className="od-muted">{words("本次会话还没有上传文件。", "No file has been uploaded in this session.", lang)}</span>}
    </form>
  </div>;
}

interface DocumentCardProps {
  document: KnowledgeDocument;
  versions: KnowledgeDocumentVersion[] | null | undefined;
  attachment: KnowledgeAttachment | undefined;
  sessionFiles: KnowledgeSessionFile[];
  busy: string;
  lang: string;
  onUpdate: (input: UpdateKnowledgeInput) => Promise<void>;
  onArchive: () => Promise<void>;
  onAttach: (version: KnowledgeDocumentVersion) => Promise<void>;
  onDetach: () => Promise<void>;
  onAdopt: (version: KnowledgeDocumentVersion) => Promise<void>;
  onAddVersion: (fileName: string) => Promise<void>;
}

function DocumentCard({
  document, versions, attachment, sessionFiles, busy, lang,
  onUpdate, onArchive, onAttach, onDetach, onAdopt, onAddVersion,
}: DocumentCardProps): ReactElement {
  const [expanded, setExpanded] = useState(Boolean(attachment));
  const [editing, setEditing] = useState(false);
  const pinnedVersion = versions?.find((item) => item.id === attachment?.version_id);
  const adoptedVersion = versions?.find((item) => item.id === document.adopted_version_id);
  const currentVersion = versions?.find((item) => item.id === document.current_version_id);
  const version = pinnedVersion || adoptedVersion || currentVersion;
  const hasUnadoptedVersion = Boolean(document.adopted_version_id
    && document.current_version_id !== document.adopted_version_id);
  const isBusy = busy.startsWith(`${document.id}:`);

  return <article className={`od-document ${document.status} ${attachment ? "attached" : ""}`}>
    <div className="od-document-head">
      <button type="button" className="od-document-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="od-disclosure" aria-hidden="true">{expanded ? "−" : "+"}</span>
        <span className="od-document-copy">
          <span className="od-document-title">
            <strong>{document.title}</strong>
            {document.status === "archived" ? <span className="od-badge archived">{words("已归档", "Archived", lang)}</span> : null}
            {attachment ? <span className="od-badge attached">{words("本次分析已固定版本", "Version pinned for this run", lang)}</span> : null}
            {hasUnadoptedVersion ? <span className="od-badge pending">{words("有新版本待决定", "New version pending", lang)}</span> : null}
          </span>
          <span className="od-document-meta">
            {sourceClassLabel(document.source_class, lang)}
            {version ? ` · ${attachment
              ? words(`本次使用 v${version.version_no}`, `Run uses v${version.version_no}`, lang)
              : words(`项目采用版 v${version.version_no}`, `Adopted v${version.version_no}`, lang)} · ${versionParseStatusLabel(version, lang)}`
              : ` · ${words("正在读取版本信息", "Loading version details", lang)}`}
            {hasUnadoptedVersion && currentVersion ? words(` · 最新上传 v${currentVersion.version_no}`, ` · latest upload v${currentVersion.version_no}`, lang) : ""}
          </span>
        </span>
      </button>
      <div className="od-document-actions">
        <button type="button" className="act" disabled={isBusy} onClick={() => setEditing((value) => !value)}>{words("编辑", "Edit", lang)}</button>
      </div>
    </div>

    {document.tags.length ? <div className="od-tags" aria-label={words("文档标签", "Document tags", lang)}>
      {document.tags.map((tag) => <span key={tag}>{tag}</span>)}
    </div> : null}

    {editing ? <MetadataEditor document={document} busy={isBusy} lang={lang} onCancel={() => setEditing(false)}
      onSave={onUpdate} /> : null}

    {expanded ? <VersionList
      document={document}
      versions={versions}
      attachment={attachment}
      sessionFiles={sessionFiles}
      busy={busy}
      lang={lang}
      onAttach={onAttach}
      onDetach={onDetach}
      onAdopt={onAdopt}
      onAddVersion={onAddVersion}
    /> : null}

    <div className="od-document-foot">
      <span>{words("更新于", "Updated", lang)} {when(document.updated_at, lang)}</span>
      <button type="button" className="od-link" disabled={isBusy} onClick={() => void onArchive()}>{document.status === "archived" ? words("恢复文档", "Restore", lang) : words("归档（保留历史）", "Archive (keep history)", lang)}</button>
    </div>
  </article>;
}

/**
 * 项目知识库管理面板。
 *
 * 所有写操作都从明确按钮发起。组件不会因为打开页面、搜索或切换会话就自动采用版
 * 本、挂载材料或归档内容；这些动作会改变项目事实或分析输入，必须可见、可追溯。
 */
export function KnowledgeLibrary({
  sessionId, sessionFiles, api = knowledgeLibraryApi,
}: KnowledgeLibraryProps): ReactElement {
  const ui = useUi();
  const lang = ui.LANG || "zh";
  const [includeArchived, setIncludeArchived] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [attachments, setAttachments] = useState<KnowledgeAttachment[]>([]);
  const [histories, setHistories] = useState<Histories>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [selectedUpload, setSelectedUpload] = useState(sessionFiles[0]?.name || "");
  const [query, setQuery] = useState("");
  const [attachedOnly, setAttachedOnly] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [openedEvidence, setOpenedEvidence] = useState<KnowledgeOpenResult | null>(null);
  const [evidenceError, setEvidenceError] = useState("");
  const loadSequence = useRef(0);

  useEffect(() => {
    if (!sessionFiles.some((file) => file.name === selectedUpload)) {
      setSelectedUpload(sessionFiles[0]?.name || "");
    }
  }, [selectedUpload, sessionFiles]);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    setStatus("loading");
    setLoadError("");
    try {
      const snapshot = await api.list(sessionId, includeArchived);
      if (sequence !== loadSequence.current) return;
      setDocuments(snapshot.documents || []);
      setAttachments(snapshot.attachments || []);
      setHistories(Object.fromEntries((snapshot.documents || []).map((document) => [document.id, undefined])));
      setStatus("ready");

      const rows = await Promise.all((snapshot.documents || []).map(async (document) => {
        try {
          return [document.id, await api.history(sessionId, document.id)] as const;
        } catch {
          return [document.id, null] as const;
        }
      }));
      if (sequence === loadSequence.current) setHistories(Object.fromEntries(rows));
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setStatus("error");
      setLoadError(errorMessage(error, lang));
    }
  }, [api, includeArchived, lang, sessionId]);

  useEffect(() => {
    void refresh();
    return () => { loadSequence.current += 1; };
  }, [refresh]);

  const runMutation = useCallback(async (
    key: string,
    operation: () => Promise<KnowledgeMutationResult>,
  ): Promise<void> => {
    setBusy(key);
    setNotice("");
    setMutationError("");
    try {
      const result = await operation();
      setNotice(result.message || words("知识库已更新。", "The library was updated.", lang));
      await refresh();
    } catch (error) {
      setMutationError(errorMessage(error, lang));
    } finally {
      setBusy("");
    }
  }, [lang, refresh]);

  const submitSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const normalized = query.trim();
    setOpenedEvidence(null);
    setEvidenceError("");
    if (!normalized) {
      setSearchResult(null);
      return;
    }
    setSearching(true);
    setMutationError("");
    try {
      setSearchResult(await api.search(sessionId, normalized, attachedOnly));
    } catch (error) {
      setMutationError(errorMessage(error, lang));
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  };

  const openEvidence = async (evidenceRef: string): Promise<void> => {
    setEvidenceError("");
    try {
      setOpenedEvidence(await api.open(sessionId, evidenceRef));
    } catch (error) {
      setOpenedEvidence(null);
      setEvidenceError(errorMessage(error, lang));
    }
  };

  return <section className="od-library" aria-label={words("项目知识库", "Project knowledge library", lang)}>
    <header className="od-library-head">
      <div>
        <span className="od-eyebrow">OntoDocument</span>
        <h3>{words("项目知识库", "Project knowledge library", lang)}</h3>
        <p>{words(
          "长期保留项目文件和版本；本次分析只使用你明确加入的固定版本。",
          "Keep project files and versions; this run only uses versions you explicitly pin.",
          lang,
        )}</p>
      </div>
      <button type="button" className="act" disabled={status === "loading" || Boolean(busy)} onClick={() => void refresh()}>{words("刷新", "Refresh", lang)}</button>
    </header>

    <div className="od-trust-note">
      <strong>{words("材料事实有出处", "Material facts have sources", lang)}</strong>
      <span>{words(
        "搜索只返回能定位到文件版本和原文位置的片段。没有命中时，OntoCopilot 不应把推测写成材料结论。",
        "Search only returns passages tied to a file version and location. A miss must not become a material claim.",
        lang,
      )}</span>
    </div>

    <form className="od-search" onSubmit={(event) => void submitSearch(event)}>
      <label>
        <span>{words("搜索项目文件内容", "Search project file contents", lang)}</span>
        <input type="search" value={query} maxLength={2_000} placeholder={words("例如：计划金额怎么计算", "For example: how is planned amount calculated?", lang)} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="od-check"><input type="checkbox" checked={attachedOnly} onChange={(event) => setAttachedOnly(event.target.checked)} /> {words("只搜本次分析正在使用的版本", "Only versions used in this run", lang)}</label>
      <button type="submit" className="act pri" disabled={searching}>{searching ? words("正在查材料…", "Searching…", lang) : words("搜索原文", "Search source text", lang)}</button>
    </form>

    {searchResult ? <section className="od-search-results" aria-label={words("知识库搜索结果", "Library search results", lang)}>
      <div className="od-results-head">
        <strong>{searchResult.hits.length
          ? words(`找到 ${searchResult.hits.length} 处材料片段`, `${searchResult.hits.length} source passages found`, lang)
          : words("没有找到可直接支持这项内容的材料", "No material directly supports this", lang)}</strong>
        {searchResult.coverage?.missingTerms?.length ? <span>{words("未命中：", "Not found: ", lang)}{searchResult.coverage.missingTerms.join("、")}</span> : null}
      </div>
      {!searchResult.hits.length ? <p className="od-no-evidence">{words(
        "这不代表业务上一定不存在，只表示当前知识库没有证据。请补充材料或向业务方确认。",
        "This does not prove the business fact is false; it means the current library has no evidence. Add material or ask the business owner.",
        lang,
      )}</p> : <div className="od-hit-list">
        {searchResult.hits.map((hit) => <button type="button" className="od-hit" key={hit.evidence_ref} onClick={() => void openEvidence(hit.evidence_ref)}>
          <span><strong>{hit.document_title} · v{hit.version_no}</strong><small>{hit.cite}</small></span>
          <p>{hit.text}</p>
          <i aria-hidden="true">{words("查看定位", "Open source", lang)} →</i>
        </button>)}
      </div>}
      {evidenceError ? <div className="od-inline-error">{evidenceError}</div> : null}
      {openedEvidence ? <article className="od-open-evidence">
        <div><strong>{openedEvidence.document_title} · v{openedEvidence.version_no}</strong><span>{openedEvidence.cite}</span></div>
        {openedEvidence.context ? <p className="od-evidence-context">{openedEvidence.context}</p> : null}
        <blockquote>{openedEvidence.text}</blockquote>
        <small title={openedEvidence.text_sha256}>{words("原文校验值", "Source text checksum", lang)}：{shortId(openedEvidence.text_sha256)}</small>
      </article> : null}
    </section> : null}

    <div className="od-promote">
      <div>
        <strong>{words("把本次上传文件保存到项目库", "Save an uploaded file to the project", lang)}</strong>
        <small>{words("原文件仍留在本次会话；项目库会保存一个可追溯版本。", "The session file stays in place; the project receives a traceable version.", lang)}</small>
      </div>
      {sessionFiles.length ? <>
        <select aria-label={words("选择要保存的上传文件", "Choose an uploaded file to save", lang)} value={selectedUpload} onChange={(event) => setSelectedUpload(event.target.value)}>
          {sessionFiles.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}
        </select>
        <button type="button" className="act" disabled={Boolean(busy) || !selectedUpload} onClick={() => void runMutation(
          "promote:new",
          async () => await api.promote(sessionId, { session_file_name: selectedUpload }),
        )}>{busy === "promote:new" ? words("正在保存…", "Saving…", lang) : words("保存到项目库", "Save to project", lang)}</button>
      </> : <button type="button" className="act" onClick={() => document.getElementById("picker")?.click()}>{words("先上传文件", "Upload a file first", lang)}</button>}
    </div>

    <div className="od-library-controls">
      <span>{status === "ready" ? words(`${documents.length} 份项目文档 · ${attachments.length} 份用于本次分析`, `${documents.length} project documents · ${attachments.length} used in this run`, lang) : words("正在读取项目知识库…", "Loading project library…", lang)}</span>
      <label className="od-check"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> {words("显示已归档", "Show archived", lang)}</label>
    </div>

    <div className="od-feedback" aria-live="polite">
      {notice ? <div className="od-notice">{notice}</div> : null}
      {mutationError ? <div className="od-inline-error">{mutationError}</div> : null}
    </div>

    {status === "error" ? <div className="od-library-error">
      <strong>{words("项目知识库暂时不可用", "Project library is temporarily unavailable", lang)}</strong>
      <p>{loadError}</p>
      <button type="button" className="act" onClick={() => void refresh()}>{words("再试一次", "Try again", lang)}</button>
      <small>{words("本次会话里已上传的材料仍可在下方查看和使用。", "Files already uploaded to this session remain available below.", lang)}</small>
    </div> : status === "loading" && documents.length === 0 ? <div className="od-library-loading">{words("正在读取项目文件和固定版本…", "Loading project files and pinned versions…", lang)}</div>
      : documents.length === 0 ? <div className="od-library-empty">
        <strong>{words("这个项目还没有长期保存的文件", "No files have been saved to this project yet", lang)}</strong>
        <p>{sessionFiles.length
          ? words("从上面的本次上传文件中选一份保存。保存后，其他会话也能检索和使用它。", "Choose an uploaded file above. Other sessions can search and use it after it is saved.", lang)
          : words("先上传一份业务材料，再把它保存到项目知识库。", "Upload business material, then save it to the project library.", lang)}</p>
      </div> : <div className="od-document-list">
        {documents.map((item) => {
          return <DocumentCard
            key={item.id}
            document={item}
            versions={histories[item.id]}
            attachment={attachedVersion(item.id, attachments)}
            sessionFiles={sessionFiles}
            busy={busy}
            lang={lang}
            onUpdate={async (input) => await runMutation(`${item.id}:metadata`, async () => await api.update(sessionId, item.id, input))}
            onArchive={async () => await runMutation(`${item.id}:archive`, async () => await api.archive(
              sessionId, item.id, item.status !== "archived", item.revision,
            ))}
            onAttach={async (version) => await runMutation(`${item.id}:attach`, async () => await api.attach(
              sessionId, item.id, version.id,
            ))}
            onDetach={async () => await runMutation(`${item.id}:detach`, async () => await api.detach(sessionId, item.id))}
            onAdopt={async (version) => await runMutation(`${item.id}:adopt`, async () => await api.adopt(
              sessionId, item.id, version.id, item.revision,
            ))}
            onAddVersion={async (fileName) => await runMutation(`${item.id}:version`, async () => await api.promote(sessionId, {
              session_file_name: fileName,
              target_document_id: item.id,
              base_version_id: item.current_version_id,
            }))}
          />;
        })}
      </div>}

    <footer className="od-boundary-note">{words(
      "归档不会删除原文件或历史版本。采用版属于项目；“用于本次分析”只影响当前会话。",
      "Archiving keeps originals and history. Adoption is project-wide; “use in this run” only affects this session.",
      lang,
    )}</footer>
  </section>;
}

export default KnowledgeLibrary;
