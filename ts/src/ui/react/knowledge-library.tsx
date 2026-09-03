import {
  useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement,
} from "react";

import { fmtSize } from "../dom.js";
import {
  knowledgeGlobalApi,
  knowledgeLibraryApi,
  type KnowledgeAttachment,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
  type KnowledgeLibraryApi,
  type KnowledgeMutationResult,
  type KnowledgeOpenResult,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
  type KnowledgeSourceClass,
  type UpdateKnowledgeInput,
} from "../knowledge-library.js";
import { prefillComposer } from "../context-sync.js";
import { useUi } from "./store.js";

export interface KnowledgeSessionFile {
  name: string;
  state?: string;
  issue?: string;
}

export interface KnowledgeLibraryProps {
  sessionId: string;
  sessionFiles: KnowledgeSessionFile[];
  /** 公共库（不依赖会话/项目）还是项目库。决定打到哪一组接口。 */
  level?: "global" | "project";
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

interface DocumentPreviewProps {
  sessionId: string;
  onClose: () => void;
  /** 从 Library 传下来，测试才能注入桩；阅读器要用它取正文。 */
  api: Pick<KnowledgeLibraryApi, "read">;
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
  /** 公共库里的材料不需要再「设为通用知识」，所以这个是可选的。 */
  onPublish?: (() => Promise<void>) | undefined;
}

/**
 * 就地读一份材料的正文。
 *
 * 这是「知识库看不懂」最直接的那一条：在此之前，存进去的文件**没有任何打开入口**
 * —— 只有 search（要关键词）和 evidence/:ref/open（要一个已经拿到的引用）。
 * 用户刚传完一份 40 页的材料想知道里面有什么，只能靠猜关键词。
 *
 * 每一段都带「引用到对话」：段落复用的就是检索命中的形状，自带 evidence_ref
 * 和引用文案，所以读到哪一段就能把哪一段原样送进对话，中间不丢出处。
 */
/** 搜索结果占据预览区：找东西和读东西是同一个位置，不额外开一块。 */
function SearchPane({ result, openedEvidence, evidenceError, lang, onOpen, onClear }: {
  result: KnowledgeSearchResult;
  openedEvidence: KnowledgeOpenResult | null;
  evidenceError: string;
  lang: string;
  onOpen: (evidenceRef: string) => void;
  onClear: () => void;
}): ReactElement {
  const total = (result as { total?: number }).total ?? result.hits.length;
  return <>
    <header className="od-preview-head">
      <div>
        <strong>{result.hits.length
          ? words(`找到 ${total} 处`, `${total} passages`, lang)
          : words("没有找到可直接支持这项内容的材料", "No material directly supports this", lang)}</strong>
        {result.coverage?.missingTerms?.length
          ? <small>{words("未命中：", "Not found: ", lang)}{result.coverage.missingTerms.join("、")}</small>
          : null}
      </div>
      <button type="button" className="od-link" onClick={onClear}>{words("清除搜索", "Clear", lang)}</button>
    </header>
    {!result.hits.length ? <p className="od-no-evidence">{words(
      "搜索只返回能定位到文件版本和原文位置的片段。这不代表业务上一定不存在，只表示当前知识库没有证据。",
      "Search only returns passages tied to a file version and location; a miss is not proof the fact is false.",
      lang,
    )}</p> : <div className="od-hit-list">
      {result.hits.map((hit) => <button type="button" className="od-hit" key={hit.evidence_ref}
        onClick={() => onOpen(hit.evidence_ref)}>
        <span>
          <strong>{hit.document_title} · v{hit.version_no}</strong>
          {hit.level === "global" ? <span className="od-badge current">{words("总库", "Shared", lang)}</span> : null}
          {hit.also_in_level === "global"
            ? <span className="od-badge current">{words("总库也有", "Also shared", lang)}</span> : null}
          <small>{hit.cite}</small>
        </span>
        <p>{hit.text}</p>
      </button>)}
    </div>}
    {evidenceError ? <div className="od-inline-error">{evidenceError}</div> : null}
    {openedEvidence ? <article className="od-open-evidence">
      <div><strong>{openedEvidence.document_title} · v{openedEvidence.version_no}</strong><span>{openedEvidence.cite}</span></div>
      {openedEvidence.context ? <p className="od-evidence-context">{openedEvidence.context}</p> : null}
      <blockquote>{openedEvidence.text}</blockquote>
      {/* 原文校验值是可追溯链条的一环：它证明这段字和库里那一版逐字节一致。
          改版时差点弄丢，测试把它钉住了。 */}
      <small title={openedEvidence.text_sha256}>
        {words("原文校验值", "Source text checksum", lang)}：{shortId(openedEvidence.text_sha256)}
      </small>
      <button type="button" className="od-link" onClick={() => {
        prefillComposer(`关于「${openedEvidence.cite}」这一段：\n\n${openedEvidence.text}\n\n`, { mode: "insert" });
      }}>{words("引用到对话", "Quote in chat", lang)}</button>
    </article> : null}
  </>;
}

function DocumentReader({ sessionId, documentId, versionId, lang, api = knowledgeLibraryApi }: {
  sessionId: string;
  documentId: string;
  versionId?: string;
  lang: string;
  api?: Pick<KnowledgeLibraryApi, "read">;
}): ReactElement {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [chunks, setChunks] = useState<KnowledgeSearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [more, setMore] = useState(false);

  const load = useCallback(async (offset: number) => {
    setMore(true);
    try {
      const page = await api.read(sessionId, documentId, {
        ...(versionId === undefined ? {} : { versionId }),
        offset,
        limit: PAGE,
      });
      setChunks((prev) => (offset === 0 ? page.chunks : [...prev, ...page.chunks]));
      setTotal(page.total);
      setState("ready");
      setError("");
    } catch (exc) {
      setState("error");
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setMore(false);
    }
  }, [api, documentId, sessionId, versionId]);

  useEffect(() => { void load(0); }, [load]);

  if (state === "loading") {
    return <div className="od-library-loading">{words("正在读取正文…", "Loading content…", lang)}</div>;
  }
  if (state === "error") {
    return <div className="od-inline-error">{error}</div>;
  }
  if (total === 0) {
    return <div className="od-library-empty">
      {words(
        "这一版还没有读出可核验的正文。它可能是扫描件，需要先做识别。",
        "No verifiable text has been read from this version yet.",
        lang,
      )}
    </div>;
  }

  return <div className="od-reader">
    <div className="od-eyebrow">
      {/* 不把截断伪装成全部 —— 后端给了 total 就要说出来。 */}
      {words(
        `第 1–${chunks.length} 段，共 ${total} 段`,
        `Paragraphs 1–${chunks.length} of ${total}`,
        lang,
      )}
    </div>
    {chunks.map((chunk) => <div className="od-reader-chunk" key={chunk.evidence_ref}>
      <div className="od-evidence-context">
        {chunk.cite}
        {chunk.level === "global"
          ? <span className="od-badge current">{words("总库", "Shared", lang)}</span>
          : null}
      </div>
      <p className="od-reader-text">{chunk.text}</p>
      <button type="button" className="od-link" onClick={() => {
        // 预填而不是直接发送：用户没审过的话不该替他调用模型。
        // 这条纪律和右侧上下文栏的十来个引用按钮一致（context-sync.ts 的注释）。
        prefillComposer(`关于「${chunk.cite}」这一段：\n\n${chunk.text}\n\n`, { mode: "insert" });
      }}>{words("引用到对话", "Quote in chat", lang)}</button>
    </div>)}
    {chunks.length < total ? <button type="button" className="act" disabled={more}
      onClick={() => void load(chunks.length)}>
      {more
        ? words("正在读取…", "Loading…", lang)
        : words(`继续读（还有 ${total - chunks.length} 段）`, `Read more (${total - chunks.length} left)`, lang)}
    </button> : null}
  </div>;
}

const PAGE = 50;

function DocumentPreview({
  sessionId, api, onClose, document, versions, attachment, sessionFiles, busy, lang,
  onUpdate, onArchive, onAttach, onDetach, onAdopt, onAddVersion, onPublish,
}: DocumentPreviewProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const pinnedVersion = versions?.find((item) => item.id === attachment?.version_id);
  const adoptedVersion = versions?.find((item) => item.id === document.adopted_version_id);
  const currentVersion = versions?.find((item) => item.id === document.current_version_id);
  const version = pinnedVersion || adoptedVersion || currentVersion;
  const hasUnadoptedVersion = Boolean(document.adopted_version_id
    && document.current_version_id !== document.adopted_version_id);
  const isBusy = busy.startsWith(`${document.id}:`);

  return <>
    <header className="od-preview-head">
      <div>
        <strong>{document.title}</strong>
        <small>
          {version
            ? `v${version.version_no} · ${versionParseStatusLabel(version, lang)}`
            : words("读取版本…", "Loading version…", lang)}
          {hasUnadoptedVersion && currentVersion
            ? words(` · 最新上传 v${currentVersion.version_no}`, ` · latest v${currentVersion.version_no}`, lang)
            : ""}
          {` · ${words("更新于", "Updated", lang)} ${when(document.updated_at, lang)}`}
        </small>
      </div>
      {/* 操作作用于**当前选中的文件** —— 文件管理器就是这么做的，
          不需要每一行都挂一排按钮。 */}
      <div className="od-preview-acts">
        {document.status === "archived" ? <span className="od-badge archived">{words("已归档", "Archived", lang)}</span> : null}
        {attachment ? <span className="od-badge attached">{words("本次在用", "In use", lang)}</span> : null}
        <button type="button" className="od-link" disabled={isBusy}
          onClick={() => { setEditing((v) => !v); setExpanded(false); }}>{words("编辑", "Edit", lang)}</button>
        <button type="button" className="od-link" disabled={isBusy}
          onClick={() => { setExpanded((v) => !v); setEditing(false); }}>{words("版本", "Versions", lang)}</button>
        <button type="button" className="od-link" disabled={isBusy} onClick={() => void onArchive()}>
          {document.status === "archived" ? words("恢复", "Restore", lang) : words("归档", "Archive", lang)}
        </button>
        {/* 设为通用知识：把这份材料复制进公共知识库，其他项目也能检索到。
            必须是人点的 —— AI 只能建议。公共库是共享的，让它自动生长会变成垃圾场。 */}
        {onPublish ? <button type="button" className="od-link" disabled={isBusy}
          title={words("复制到公共知识库，其他项目也能检索到", "Copy into the shared library", lang)}
          onClick={() => void onPublish()}>{words("设为通用知识", "Make shared", lang)}</button> : null}
        <button type="button" className="od-link" onClick={onClose}>{words("关闭", "Close", lang)}</button>
      </div>
    </header>

    {editing ? <MetadataEditor document={document} busy={isBusy} lang={lang}
      onCancel={() => setEditing(false)} onSave={onUpdate} /> : null}

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

    {/* 默认就是正文。打开一份材料最常想干的事是读它。 */}
    {!editing && !expanded ? <DocumentReader
      sessionId={sessionId}
      api={api}
      documentId={document.id}
      {...(version === undefined ? {} : { versionId: version.id })}
      lang={lang}
    /> : null}
  </>;
}

/**
 * 项目知识库管理面板。
 *
 * 所有写操作都从明确按钮发起。组件不会因为打开页面、搜索或切换会话就自动采用版
 * 本、挂载材料或归档内容；这些动作会改变项目事实或分析输入，必须可见、可追溯。
 */
export function KnowledgeLibrary({
  sessionId, sessionFiles, level = "project", api = level === "global" ? knowledgeGlobalApi : knowledgeLibraryApi,
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
  /** 当前在右侧预览的文档。文件树 + 预览是这一页的主界面。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 收起的分组。默认全展开 —— 材料不多，先让人看见东西。 */
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
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

  // 按标签分组成文件夹。标签是这个产品里材料本来就有的语义（采购/制度/台账…），
  // 用它当文件夹，比按上传时间或文件类型分更贴近「我在找什么」。
  // 没有标签的归「未分类」，永远排在最后。
  const UNFILED = words("未分类", "Untagged", lang);
  const folders = new Map<string, KnowledgeDocument[]>();
  for (const item of documents) {
    const keys = item.tags.length ? item.tags : [UNFILED];
    for (const key of keys) {
      const bucket = folders.get(key);
      if (bucket) bucket.push(item);
      else folders.set(key, [item]);
    }
  }
  const folderNames = [...folders.keys()].sort((a, b) => {
    if (a === UNFILED) return 1;
    if (b === UNFILED) return -1;
    return a.localeCompare(b, "zh-Hans-CN");
  });
  const selected = documents.find((item) => item.id === selectedId) ?? null;

  return <section className="od-library od-fm" aria-label={words("知识库", "Knowledge library", lang)}>
    <div className="od-explorer">
      {/* 左边：文件树。图标条 + 分组 + 文件，没有别的。 */}
      <aside className="od-tree" aria-label={words("材料目录", "Material tree", lang)}>
        <div className="od-tree-bar">
          {level === "global" ? null : sessionFiles.length ? <>
            <select className="od-tree-pick" aria-label={words("选择要添加的文件", "Choose a file to add", lang)}
              value={selectedUpload} onChange={(event) => setSelectedUpload(event.target.value)}>
              {sessionFiles.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}
            </select>
            <button type="button" title={words("把这份文件加入知识库", "Add this file", lang)}
              disabled={Boolean(busy) || !selectedUpload}
              onClick={() => void runMutation("promote:new", async () => await api.promote(sessionId, { session_file_name: selectedUpload }))}>＋</button>
          </> : <button type="button" title={words("上传材料", "Upload material", lang)}
            onClick={() => document.getElementById("picker")?.click()}>＋</button>}
          <button type="button" title={words("全部收起", "Collapse all", lang)}
            onClick={() => setClosedFolders(new Set(folderNames))}>⌄</button>
          <button type="button" title={words("刷新", "Refresh", lang)}
            disabled={status === "loading" || Boolean(busy)} onClick={() => void refresh()}>↻</button>
          <label className="od-tree-archived" title={words("显示已归档", "Show archived", lang)}>
            <input type="checkbox" checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)} />
          </label>
        </div>

        <form className="od-tree-search" onSubmit={(event) => void submitSearch(event)} role="search">
          <input type="search" value={query} maxLength={2_000}
            placeholder={words("搜索原文…", "Search text…", lang)}
            aria-label={words("搜索材料内容", "Search material", lang)}
            onChange={(event) => setQuery(event.target.value)} />
        </form>

        {status === "error" ? <div className="od-library-error">
          <strong>{words("知识库暂时不可用", "Library unavailable", lang)}</strong>
          <p>{loadError}</p>
          <button type="button" className="act" onClick={() => void refresh()}>{words("再试一次", "Try again", lang)}</button>
        </div> : status === "loading" && documents.length === 0
          ? <div className="od-library-loading">{words("读取中…", "Loading…", lang)}</div>
          : documents.length === 0 ? <div className="od-library-empty">
            <strong>{level === "global"
              ? words("公共知识库还是空的", "The shared library is empty", lang)
              : words("这个项目还没有材料", "No material yet", lang)}</strong>
            <p>{level === "global"
              ? words("这里放跨项目通用的东西：行业标准、通用制度、模板。", "Cross-project material lives here.", lang)
              : words("用左上角的 ＋ 把材料加进来。", "Use ＋ above to add material.", lang)}</p>
          </div> : <div className="od-tree-body" role="tree">
            {folderNames.map((name) => {
              const closed = closedFolders.has(name);
              const items = folders.get(name) ?? [];
              return <div className="od-folder" key={name}>
                <button type="button" className="od-folder-head" aria-expanded={!closed}
                  onClick={() => setClosedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name); else next.add(name);
                    return next;
                  })}>
                  <span className="od-folder-caret" aria-hidden="true">{closed ? "›" : "⌄"}</span>
                  <span className="od-folder-name">{name}</span>
                  <span className="od-folder-n">{items.length}</span>
                </button>
                {closed ? null : <div className="od-folder-body" role="group">
                  {items.map((item) => <button type="button" key={item.id}
                    className={`od-file${item.id === selectedId ? " on" : ""}${item.status === "archived" ? " archived" : ""}`}
                    onClick={() => setSelectedId(item.id)}>
                    <span className="od-file-name">{item.title}</span>
                    {attachedVersion(item.id, attachments)
                      ? <span className="od-file-dot" title={words("本次分析在用", "In use this run", lang)} /> : null}
                  </button>)}
                </div>}
              </div>;
            })}
          </div>}
        <div className="od-fm-status">
          <span>{status === "ready"
            ? words(`${documents.length} 份材料`, `${documents.length} files`, lang)
            : ""}</span>
        </div>
      </aside>

      {/* 右边：预览。点树里任意一份材料，正文就在这里，每段带出处、能引用到对话。 */}
      <div className="od-preview-pane">
        {searchResult ? <SearchPane
          result={searchResult}
          openedEvidence={openedEvidence}
          evidenceError={evidenceError}
          lang={lang}
          onOpen={(ref: string) => void openEvidence(ref)}
          onClear={() => { setQuery(""); setSearchResult(null); }}
        /> : selected ? <DocumentPreview
          key={selected.id}
          sessionId={sessionId}
          api={api}
          onClose={() => setSelectedId(null)}
          document={selected}
          versions={histories[selected.id]}
          attachment={attachedVersion(selected.id, attachments)}
          sessionFiles={sessionFiles}
          busy={busy}
          lang={lang}
          onUpdate={async (input) => await runMutation(`${selected.id}:metadata`, async () => await api.update(sessionId, selected.id, input))}
          onArchive={async () => await runMutation(`${selected.id}:archive`, async () => await api.archive(
            sessionId, selected.id, selected.status !== "archived", selected.revision,
          ))}
          onAttach={async (version) => await runMutation(`${selected.id}:attach`, async () => await api.attach(
            sessionId, selected.id, version.id,
          ))}
          onDetach={async () => await runMutation(`${selected.id}:detach`, async () => await api.detach(sessionId, selected.id))}
          onAdopt={async (version) => await runMutation(`${selected.id}:adopt`, async () => await api.adopt(
            sessionId, selected.id, version.id, selected.revision,
          ))}
          onAddVersion={async (fileName) => await runMutation(`${selected.id}:version`, async () => await api.promote(sessionId, {
            session_file_name: fileName,
            target_document_id: selected.id,
            base_version_id: selected.current_version_id,
          }))}
          {...(level === "global" ? {} : {
            onPublish: async () => await runMutation(`${selected.id}:publish`,
              async () => await api.publish(sessionId, selected.id)),
          })}
        /> : <div className="od-preview-idle">
          {words("在左边选一份材料，正文就显示在这里。", "Pick a file on the left to read it here.", lang)}
        </div>}
        <div className="od-feedback" aria-live="polite">
          {notice ? <div className="od-notice">{notice}</div> : null}
          {mutationError ? <div className="od-inline-error">{mutationError}</div> : null}
        </div>
      </div>
    </div>
  </section>;
}

export default KnowledgeLibrary;
