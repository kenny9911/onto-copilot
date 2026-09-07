import {
  useCallback, useEffect, useRef, useState,
  type DragEvent, type FormEvent, type ReactElement,
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
  type KnowledgeFolder,
  type KnowledgeSearchHit,
  type KnowledgeSearchResult,
  type KnowledgeSourceClass,
  type UpdateKnowledgeInput,
} from "../knowledge-library.js";
import { prefillComposer } from "../context-sync.js";
import {
  askArchive, askAttach, askIngestAll, askOrganize, askRemember, askSearch,
} from "../copilot-asks.js";
import { onKnowledgeChanged } from "../knowledge-events.js";
import {
  KnowledgeInbox, pendingSessionFiles, type InboxOutcome,
} from "./knowledge-inbox.js";
import { openKnowledgeChat } from "./knowledge-chat-lane.js";
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
  onMove?: ((folderPath: string) => Promise<void>) | undefined;
  folderOptions: readonly string[];
  level: "global" | "project";
  /** 拿同一份原件用现在这版解析器再读一遍。读不出正文时才有意义。 */
  onReparse?: (() => Promise<void>) | undefined;
  /** 把一句话预填进输入框（不发送）。见 KnowledgeLibrary 里的 askCopilot。 */
  onAsk: (text: string) => void;
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
/**
 * 把一段原文交给 Copilot 时该说的话。
 *
 * **必须带 evidence_ref。** 之前只拼了「关于『引用文案』这一段：正文」——
 * 模型侧的 `document.open` 要的是一个精确的 evidence_ref（见 document_tools.ts
 * 里那个工具的描述），拿不到就只能自己重搜一遍去猜用户指的是哪一段。
 * 于是「材料事实有出处」这条链，恰好断在人把材料交给模型的那一刻。
 *
 * **也必须带层级。** 公共知识库装的是行业通用参考，项目库装的是这家客户自己的
 * 规定。把前者当成后者，是这个产品最不能出的错（routes/documents.ts:853 的注释
 * 原话）。而这句话是人交给模型的原文，模型除了这段字什么也看不到 —— 层级不写在
 * 这里，它就丢在这里了。界面上那枚 8.3px 的灰徽章救不了它：模型读不到 CSS。
 */
function quoteForComposer(
  cite: string,
  text: string,
  evidenceRef: string,
  level?: string,
): string {
  const provenance = level === "global"
    ? "这一段来自**公共知识库**：行业通用参考，不是这个客户自己的规定，别当成客户事实用。\n"
    : "";
  return `关于「${cite}」这一段：\n\n${text}\n\n${provenance}` +
    `（这段的证据引用是 ${evidenceRef}，需要核对原文时用 document.open 打开它。）\n`;
}

/** 树里的一行文件。缩进跟着层数走。 */
/**
 * 树里的一行文件。
 *
 * **不是 `<button>` 而是带 `role="treeitem"` 的 div**：HTML 不允许 button 套 button，
 * 而这一行上要挂「⋯」菜单（拖拽在触屏上根本不发 dragstart，键盘更没有 —— 拖不是
 * 唯一的路，那条路必须存在）。而且 `role="tree"` / `role="group"` 里今天一个
 * `treeitem` 都没有，辅助技术读到的是一堆按钮而不是一棵树。
 *
 * 拖拽刻意**不做在途态、不做撤销、不做重试**。归类的正确反馈只有一个：行已经在
 * 新位置上了；想撤销就再拖回去。这是它和「归档」「设为通用参考」的根本区别 ——
 * 后两者才需要确认与撤销，而 folder_path 不进检索语料、不进流水线，
 * 改了不影响任何输出。给它配一整套「这事有后果」的道具，会让人误判轻重。
 */
function FileRow({ item, depth, selectedId, attachments, lang, onPick, onDragStart, onMenu }: {
  item: KnowledgeDocument;
  depth: number;
  selectedId: string | null;
  attachments: KnowledgeAttachment[];
  lang: string;
  onPick: () => void;
  onDragStart?: ((event: DragEvent) => void) | undefined;
  /** 触屏与键盘那条路。拖不到的时候用它。 */
  onMenu?: (() => void) | undefined;
}): ReactElement {
  return <div
    role="treeitem"
    aria-selected={item.id === selectedId}
    tabIndex={0}
    draggable={onDragStart !== undefined}
    onDragStart={onDragStart}
    className={`od-file${item.id === selectedId ? " on" : ""}${item.status === "archived" ? " archived" : ""}`}
    style={{ paddingLeft: `${27 + depth * 14}px` }}
    onClick={onPick}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(); }
    }}>
    <span className="od-file-name">{item.title}</span>
    {/* 原来这里是一个 6px 的圆点，含义只写在 title 里 —— 触屏上永远看不到，
        鼠标上也要先猜到"这个点可能是有意思的"才会去悬停。
        「本次在用」是这一页最重要的状态（它决定这一轮分析真的读了什么），
        不该是全页最小、最沉默的那个东西。 */}
    {attachedVersion(item.id, attachments)
      ? <span className="od-file-flag">{words("本次在用", "In use", lang)}</span> : null}
    {onMenu ? <button type="button" className="od-file-menu"
      title={words("移到别的文件夹", "Move to another folder", lang)}
      onClick={(event) => { event.stopPropagation(); onMenu(); }}>⋯</button> : null}
  </div>;
}

/** 一组命中。分层展示要用两次，所以抽出来 —— 抄第二遍必然会漂。 */
function HitGroup({ hits, lang, onOpen }: {
  hits: readonly KnowledgeSearchHit[];
  lang: string;
  onOpen: (evidenceRef: string) => void;
}): ReactElement {
  return <div className="od-hit-list">
    {hits.map((hit) => <button type="button" className="od-hit" key={hit.evidence_ref}
      onClick={() => onOpen(hit.evidence_ref)}>
      <span>
        <strong>{hit.document_title} · v{hit.version_no}</strong>
        {/* 「这一段公共库也有一份」仍然值得说：它意味着这条不是客户独有的做法。
            但它是补充信息，不是分层本身 —— 分层已经由分组承担了。 */}
        {hit.also_in_level === "global"
          ? <span className="od-hit-also">{words("通用参考里也有同一段", "Also in shared reference", lang)}</span> : null}
        <small>{hit.cite}</small>
      </span>
      <p>{hit.text}</p>
    </button>)}
  </div>;
}

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
  const sharedHits = result.hits.filter((hit) => hit.level === "global");
  const ownHits = result.hits.filter((hit) => hit.level !== "global");
  return <>
    <header className="od-preview-head">
      <div>
        <strong>{result.hits.length
          ? words(`找到 ${total} 处`, `${total} passages`, lang)
          : words("没有找到可直接支持这项内容的材料", "No material directly supports this", lang)}</strong>
        {result.coverage?.missingTerms?.length
          ? <small>{words("未命中：", "Not found: ", lang)}{result.coverage.missingTerms.join("、")}</small>
          : null}
        {/* 「公共库也一起搜了」这件事，界面上从前一个字都没有。 */}
        <small>{words("项目材料和公共知识库一起搜。", "Searches both this project and the shared library.", lang)}</small>
      </div>
      <button type="button" className="od-link" onClick={onClear}>{words("清除搜索", "Clear", lang)}</button>
    </header>
    {!result.hits.length ? <p className="od-no-evidence">{words(
      "搜索只返回能定位到文件版本和原文位置的片段。这不代表业务上一定不存在，只表示当前知识库没有证据。",
      "Search only returns passages tied to a file version and location; a miss is not proof the fact is false.",
      lang,
    )}</p> : <>
      {/* 命中按层分成两组，不靠每行一枚小徽章。
          这一页的检索是**跨层并集**（service.ts 的 searchLayered），而界面从来没
          说过这件事 —— 用户在"当前项目"这四个字下面看到的结果里，混着公共库的
          行业通用做法，唯一的区别是一枚 8.3px 的灰点。把这家客户的规定和行业通用
          参考弄混，是这个产品最不能出的错。所以：客户材料在前、不打标签（默认就是
          客户事实），行业通用参考单独一组、默认折叠、--warn 系配色。 */}
      <HitGroup hits={ownHits} lang={lang} onOpen={onOpen} />
      {sharedHits.length ? <details className="od-hit-shared">
        <summary>
          {words(`另有 ${sharedHits.length} 处来自通用参考`, `${sharedHits.length} more from shared reference`, lang)}
          <span>{words("行业通用参考，不是这个客户的规定", "Cross-project reference, not this client’s rules", lang)}</span>
        </summary>
        <HitGroup hits={sharedHits} lang={lang} onOpen={onOpen} />
      </details> : null}
    </>}
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
        prefillComposer(quoteForComposer(
          openedEvidence.cite, openedEvidence.text, openedEvidence.evidence_ref, openedEvidence.level,
        ), { mode: "insert" });
      }}>{words("引用到对话", "Quote in chat", lang)}</button>
    </article> : null}
  </>;
}

function DocumentReader({
  sessionId, documentId, documentTitle, versionId, lang, level,
  onReparse, reparsing = false, api = knowledgeLibraryApi,
}: {
  sessionId: string;
  documentId: string;
  /** 只用来看扩展名：读不出正文时要按格式说实话，不能一律说「可能是扫描件」。 */
  documentTitle: string;
  versionId?: string;
  lang: string;
  /** 这份材料属于哪一层。公共库的正文要长得不一样 —— 见下面那条横条的注释。 */
  level: "global" | "project";
  onReparse?: (() => Promise<void>) | undefined;
  reparsing?: boolean;
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
    // 读不出正文时**别猜原因**。
    //
    // 原来这里不管什么文件都说「它可能是扫描件，需要先做识别」。用户点开一个
    // .json 看到这句话 —— 一个纯文本格式，永远不可能是扫描件。这不只是文案难看：
    // 它把人引向一条根本不存在的路（去哪儿"做识别"？），而真正的原因
    // （入库那天的解析器读不了这个形状）一个字都没说。
    //
    // 只按扩展名分两类，因为前端手上确切知道的就这么多：
    //   · 文本类格式（json/csv/md/…）—— 扫描件的说法在这里是错的；
    //   · 图片和 PDF —— 扫描件确实是最常见的原因。
    // 不确定的一律说「没读出来」，不编原因。
    const ext = (documentTitle.split(".").pop() ?? "").toLowerCase();
    const textual = TEXTUAL_EXTENSIONS.has(ext);
    const scannable = SCANNABLE_EXTENSIONS.has(ext);
    return <div className="od-library-empty">
      <strong>{words("这一版没有读出可检索的正文。", "No searchable text in this version.", lang)}</strong>
      <p>{textual
        ? words(
          `这是一个 ${ext} 文件，内容本身是文本 —— 读不出来通常是入库那天的解析器不认识它的结构。`
            + "解析器后来改好过，可以重新解析一次试试：原件一个字节都不动，只是换现在这版解析器再读一遍，结果存成新的一版。",
          `A ${ext} file is text; this usually means the parser at ingest time did not understand its shape.`,
          lang,
        )
        : scannable
          ? words(
            "这类文件如果是扫描件或纯图片，需要先做文字识别才能读出正文。",
            "If this is a scan or image, it needs OCR before text can be read.",
            lang,
          )
          : words(
            "没有读出内容。可以重新解析一次看看，或者确认这个格式是不是当前支持的。",
            "No content was read. Try re-parsing, or check whether this format is supported.",
            lang,
          )}</p>
      {onReparse ? <button type="button" className="act" disabled={reparsing}
        onClick={() => { void onReparse(); }}>
        {reparsing
          ? words("正在重新解析…", "Re-parsing…", lang)
          : words("重新解析这份材料", "Re-parse this file", lang)}
      </button> : null}
    </div>;
  }

  return <div className="od-reader">
    {/* 层级条：常驻，不是徽章。
        在此之前，「这段是行业通用参考还是这家客户的规定」全部的可见表现，是版本列表
        里那枚 .od-badge.current —— 8.3px、灰底灰字，而且和「最新上传」共用同一个 class。
        后端在 routes/documents.ts:853 用注释点名这是「这个产品最不能出的错」，界面
        却把它渲染成全页最小、最中性的一个东西。读一份公共库材料时，这条横条从头
        到尾都在，用 --warn 系配色，因为它要说的不是"这里有个属性"，
        而是"你正在读的东西不是这个客户说的"。 */}
    {level === "global" ? <div className="od-level-bar" role="note">
      <strong>{words("通用参考", "Shared reference", lang)}</strong>
      <span>{words(
        "行业通用参考，不是这个客户自己的规定。引用到对话时会带上这句话。",
        "Cross-project reference material — not this client’s own rules.",
        lang,
      )}</span>
    </div> : null}
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
          ? <span className="od-badge current">{words("通用参考", "Shared reference", lang)}</span>
          : null}
      </div>
      <p className="od-reader-text">{chunk.text}</p>
      <button type="button" className="od-link" onClick={() => {
        // 预填而不是直接发送：用户没审过的话不该替他调用模型。
        // 这条纪律和右侧上下文栏的十来个引用按钮一致（context-sync.ts 的注释）。
        prefillComposer(quoteForComposer(
          chunk.cite, chunk.text, chunk.evidence_ref, chunk.level ?? level,
        ), { mode: "insert" });
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

/** 内容本身是文字的格式 —— 对这些说「可能是扫描件」是错的。 */
const TEXTUAL_EXTENSIONS = new Set([
  "json", "csv", "tsv", "md", "markdown", "txt", "yaml", "yml", "xml", "html", "htm",
  "sql", "ddl", "log", "ini", "toml", "properties",
]);
/** 这些确实可能是扫描件／纯图片，需要先做文字识别。 */
const SCANNABLE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]);

const PAGE = 50;

function DocumentPreview({
  sessionId, api, onClose, document, versions, attachment, sessionFiles, busy, lang, level, onAsk,
  onUpdate, onArchive, onAttach, onDetach, onAdopt, onAddVersion, onPublish, onMove, onReparse,
  folderOptions,
}: DocumentPreviewProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
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
        {/* 只有真的存在第二版时才出现。7/7 文档只有 1 版时，这颗按钮的内容只能是
            「v1」—— 而 v1 已经印在副标题上了。 */}
        {(versions?.length ?? 0) > 1 ? <button type="button" className="od-link" disabled={isBusy}
          onClick={() => { setExpanded((v) => !v); setEditing(false); }}>{words("版本", "Versions", lang)}</button> : null}
        <button type="button" className="od-link" disabled={isBusy} onClick={() => void onArchive()}>
          {document.status === "archived" ? words("恢复", "Restore", lang) : words("归档", "Archive", lang)}
        </button>
        {/* 设为通用知识：把这份材料复制进公共知识库，其他项目也能检索到。
            必须是人点的 —— AI 只能建议。公共库是共享的，让它自动生长会变成垃圾场。 */}
        {onPublish ? <button type="button" className="od-link" disabled={isBusy}
          onClick={() => setConfirmPublish((on) => !on)}>{words("设为通用参考", "Make shared", lang)}</button> : null}

      </div>
    </header>

    {/* 「让 Copilot 来做」。
        它们不是上面那排按钮的重复：上面那排是**人直接改**，这里是把同一件事
        交给模型去做，好处是模型做完会连带解释、也能接着往下分析。
        每一颗都是**预填**，用户看得见自己将要说什么、也能改。 */}
    <div className="od-ask">
      <span>{words("让 Copilot：", "Ask Copilot to:", lang)}</span>
      <button type="button" className="od-link"
        onClick={() => onAsk(askSearch(document.title))}>{words("在库里找相关的", "find related material", lang)}</button>
      {attachment ? null : <button type="button" className="od-link"
        onClick={() => onAsk(askAttach(document.title))}>{words("加进本次分析", "use it in this run", lang)}</button>}
      <button type="button" className="od-link"
        onClick={() => onAsk(askRemember(document.title))}>{words("把结论记进项目知识", "remember a conclusion", lang)}</button>
      {document.status === "archived" ? null : <button type="button" className="od-link"
        onClick={() => onAsk(askArchive())}>{words("归档它", "archive it", lang)}</button>}
    </div>

    {/* 「设为通用参考」是这一屏**唯一不可逆**的动作，所以它有确认行，而拖动归类没有。
        这个权重关系以前是反的：归类（folder_path 不进检索语料、不进流水线，
        改了不影响任何输出）如果配上撤销和回执，而这一颗一键就把材料复制进跨项目
        共享的库、`service.ts` 里**根本没有 unpublish**，用户会从界面权重反推出
        一个正好相反的因果模型。
        后果三句话写全：复制不是搬走、其他项目都能检索到、撤不回来。 */}
    {confirmPublish ? <div className="od-publish-confirm" role="alert">
      <div>
        <strong>{words("把这份材料设为通用参考？", "Make this shared reference?", lang)}</strong>
        <p>{words(
          `「${document.title}」会被复制一份进通用参考库（项目里这份原样留着）。`
            + "之后所有项目都能检索到它，任何人都可能把它当成参考依据引用。",
          "It will be copied into the shared reference library and become searchable from every project.",
          lang,
        )}</p>
        <p className="od-publish-warn">{words(
          "这一步目前撤不回来 —— 系统还没有「取消通用参考」这个动作。",
          "This cannot be undone yet.",
          lang,
        )}</p>
      </div>
      <div className="od-publish-acts">
        <button type="button" className="act" disabled={isBusy}
          onClick={() => { setConfirmPublish(false); void onPublish?.(); }}>
          {words("确认设为通用参考", "Yes, make it shared", lang)}
        </button>
        <button type="button" className="od-link"
          onClick={() => setConfirmPublish(false)}>{words("先不要", "Not now", lang)}</button>
      </div>
    </div> : null}

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
      documentTitle={document.title}
      {...(version === undefined ? {} : { versionId: version.id })}
      lang={lang}
      level={level}
      {...(onReparse === undefined ? {} : { onReparse })}
      reparsing={isBusy}
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
  /**
   * 选中一份材料 = 我要读它。搜索结果和预览抢同一块地方，右栏又是 searchResult 优先，
   * 所以不清掉搜索态的话，搜过一次之后点左树只会让行变色、右边纹丝不动 ——
   * 那是最容易被当成「点了没反应＝坏了」的一种。
   */
  const pickDocument = useCallback((id: string): void => {
    setSelectedId(id);
    setSearchResult(null);
    setOpenedEvidence(null);
  }, []);
  /** 收起的分组。默认全展开 —— 材料不多，先让人看见东西。 */
  const [closedFolders, setClosedFolders] = useState<Set<string>>(new Set());
  /** 用户手工建的文件夹。空文件夹也在这里 —— 那正是「按标签推分组」做不到的。 */
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [openedEvidence, setOpenedEvidence] = useState<KnowledgeOpenResult | null>(null);
  const [evidenceError, setEvidenceError] = useState("");
  /** 逐份入库的回执。事办完了收件区就塌成一行「都齐了」，靠的是它。 */
  const [inboxOutcomes, setInboxOutcomes] = useState<InboxOutcome[]>([]);
  const [ingesting, setIngesting] = useState(false);
  /**
   * 就地建/改文件夹的那一行输入框。
   *
   * 原来用的是 `window.prompt` / `window.confirm`。它们在这个产品里有两个硬问题：
   * 一是浏览器弹窗**在页面之外**，用户看不到自己正在哪个文件夹下面建；二是
   * 「删除文件夹里的材料会怎样」这句解释被塞进一个只能读一遍的 confirm 里，
   * 而这恰恰是他不敢点那个 × 的原因。就地展开一行，两个问题一起没了。
   */
  const [draftFolder, setDraftFolder] = useState<{ kind: "new" | "rename"; base: string; value: string } | null>(null);
  /** 正在等确认删除的文件夹路径。确认词就长在那一行上，不弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 正在拖的那份材料。null = 没在拖。 */
  const [dragging, setDragging] = useState<string | null>(null);
  /** 拖到哪个文件夹上方了（"" = 根目录）。只在拖拽期间有值。 */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** 触屏/键盘那条路：点了行上的 ⋯ 之后，让他选一个目标文件夹。 */
  const [movingId, setMovingId] = useState<string | null>(null);
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
      const [snapshot, folderRows] = await Promise.all([
        api.list(sessionId, includeArchived),
        // 文件夹单独拉：空文件夹不会出现在任何文档上，只能从这里来。
        api.listFolders(sessionId).catch(() => [] as KnowledgeFolder[]),
      ]);
      if (sequence !== loadSequence.current) return;
      setFolders(folderRows);
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

  /**
   * Copilot 改了知识库 → 这一页跟着重画。
   *
   * 在此之前这个列表是一份死数据：进页面拉一次，之后除非人点「刷新」，别处发生
   * 的任何事都不会出现在这棵树里。而这一页现在旁边就摆着对话栏 —— 用户完全可能
   * 一边看着树、一边让 Copilot 把材料存进来，然后盯着一棵没动的树发呆。
   *
   * 只重拉、不做局部合并：事件里刻意不带清单（见 knowledge-events.ts 的注释），
   * 而重拉这条路上有 ACL 和作用域解析。少一次请求换一条绕过鉴权的旁路，不划算。
   */
  useEffect(() => onKnowledgeChanged(() => { void refresh(); }), [refresh]);

  /**
   * 库里有东西就先摊开第一份的正文。
   *
   * 右栏原来的默认是一句「在左边选一份材料，正文就显示在这里」—— 一整栏的空话，
   * 在最宽的那一块地方写着「你还没做够」。第一次打开这一页的人想干的事是**看看
   * 里面有什么**，不是先学会这一页的操作方式。默认铺开一份，他至少已经在读了。
   *
   * 只在「还没选过」时做，所以不会跟点击抢；换文件夹、搜索、关闭预览都不会被它
   * 拽回第一份（关闭时 selectedId 置 null，但那时 documents 没变、这个 effect
   * 不重跑）。
   */
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || selectedId !== null || documents.length === 0) return;
    autoPicked.current = true;
    setSelectedId(documents[0]!.id);
  }, [documents, selectedId]);

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

  /**
   * 一份一份地存。
   *
   * 不做成一个批量接口，是因为每一份的失败原因不一样（重名、解析不了、超限），
   * 而这里最要紧的信息恰恰是「哪一份没进去、为什么」。一个只返回
   * 「3 成功 1 失败」的批量接口给不出这个，用户只能自己一份份试。
   */
  const ingest = useCallback(async (names: readonly string[]): Promise<void> => {
    setIngesting(true);
    setMutationError("");
    setNotice("");
    const rows: InboxOutcome[] = [];
    for (const name of names) {
      try {
        const result = await api.promote(sessionId, { session_file_name: name });
        rows.push({ name, ok: true, message: result.message || "已入库" });
      } catch (error) {
        rows.push({ name, ok: false, message: errorMessage(error, lang) });
      }
      setInboxOutcomes([...rows]);
    }
    setIngesting(false);
    await refresh();
  }, [api, lang, refresh, sessionId]);

  /**
   * 把一份材料挪进某个文件夹。
   *
   * 拖完不做在途态、不做撤销条 —— 反馈就是「行已经在新位置上了」，
   * 想撤销再拖回去。见 FileRow 的注释。
   */
  const moveTo = useCallback(async (documentId: string, folderPath: string): Promise<void> => {
    setDragging(null);
    setDropTarget(null);
    setMovingId(null);
    await runMutation(`${documentId}:move`, async () => await api.moveDocument(sessionId, documentId, folderPath));
  }, [api, runMutation, sessionId]);

  /**
   * 库里所有「一段正文都没读出来」的材料。
   *
   * 解析发生在**入库那一刻**。解析器后来修好了，这些材料不会自己受益 —— 而且
   * 因为按 sha256 去重，重新上传同一个文件也只会拿回那份空的。逐份点「重新解析」
   * 是可行的，但用户手里可能一次就有六七份（现场就是），那是六七次重复劳动。
   */
  const unreadable = documents.filter((row) => {
    const history = histories[row.id];
    if (!history) return false;   // 版本还没拉到，先不说话
    const current = history.find((v) => v.id === row.current_version_id);
    return current !== undefined && current.chunk_count === 0;
  });

  const reparseAll = useCallback(async (): Promise<void> => {
    setIngesting(true);
    setMutationError("");
    setNotice("");
    const rows: InboxOutcome[] = [];
    // 串行，理由和入库那条一样：每一份的失败原因不同，逐份报出来才有用。
    for (const row of unreadable) {
      try {
        const result = await api.reparse(sessionId, row.id);
        rows.push({ name: row.title, ok: true, message: result.message || "已重新解析" });
      } catch (error) {
        rows.push({ name: row.title, ok: false, message: errorMessage(error, lang) });
      }
      setInboxOutcomes([...rows]);
    }
    setIngesting(false);
    await refresh();
  }, [api, histories, lang, refresh, sessionId, unreadable]);

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

  // 树 = 用户手工建的文件夹 ∪ 文档自己声明的 folder_path。
  //
  // 两个来源缺一不可：空文件夹只存在于前者（那正是「按标签推分组」做不到的事），
  // 而老数据的文档可能落在一个还没被显式建出来的路径上。
  const ROOT_LABEL = words("根目录", "Root", lang);
  const docsByFolder = new Map<string, KnowledgeDocument[]>();
  for (const item of documents) {
    const key = item.folder_path ?? "";
    const bucket = docsByFolder.get(key);
    if (bucket) bucket.push(item); else docsByFolder.set(key, [item]);
  }
  const allPaths = new Set<string>();
  for (const f of folders) allPaths.add(f.path);
  for (const key of docsByFolder.keys()) if (key !== "") allPaths.add(key);
  // 祖先补全：只建了「制度/采购」时，「制度」也要出现在树上。
  for (const p of [...allPaths]) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) allPaths.add(parts.slice(0, i).join("/"));
  }
  const folderNames = [...allPaths].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  const hiddenUnder = (path: string): boolean =>
    path.includes("/") && [...closedFolders].some((c) => path.startsWith(`${c}/`));
  const rootDocs = docsByFolder.get("") ?? [];

  const selected = documents.find((item) => item.id === selectedId) ?? null;

  /**
   * 把一句话预填进输入框，交给用户过目。
   *
   * **预填不发送。** 和右栏那十来个引用按钮同一条纪律（context-sync.ts）：
   * 用户没审过的话不替他调用模型。这里尤其要紧 —— 这些句子发出去会**改动知识库**。
   *
   * 说的什么话不是文案偏好：模型侧的写操作要全句匹配一道意图闸，
   * 措辞由 ui/copilot-asks.ts 统一给出，那边的注释讲了为什么。
   *
   * 顺带打开对话栏：预填了却看不见输入框，等于什么也没发生。
   */
  const askCopilot = useCallback((text: string): void => {
    openKnowledgeChat();
    prefillComposer(text, { mode: "replace", focusSidebar: false });
  }, []);

  const pending = level === "global" ? [] : pendingSessionFiles(sessionFiles, documents, histories);

  return <section className="od-library od-fm"
    onDragEnd={() => { setDragging(null); setDropTarget(null); }} aria-label={words("知识库", "Knowledge library", lang)}>
    {/* 收件区在 explorer **之上**，不在左树里面：它回答的是「我刚传的东西在哪」，
        这是第一次打开这一页的人唯一想问的问题。事办完了它自己塌成一行。 */}
    {level === "global" ? null : <KnowledgeInbox
      items={pending}
      busy={ingesting}
      outcomes={inboxOutcomes}
      onIngest={ingest}
      onUpload={() => document.getElementById("picker")?.click()}
      onDismissOutcomes={() => setInboxOutcomes([])}
      onAskCopilot={() => askCopilot(askIngestAll(pending.length))}
    />}
    <div className="od-explorer">
      {/* 左边：文件树。图标条 + 分组 + 文件，没有别的。 */}
      <aside className="od-tree" aria-label={words("材料目录", "Material tree", lang)}>
        {/* 工具条：每一颗都带中文字。
            原来这里是 ＋ / ＋▤ / ⌄ / ↻ 四个字形加一个裸复选框 —— 两个 ＋ 干的是
            完全不同的事（入库 vs 新建文件夹），含义只写在 title 里。用户的原话是
            「你设计的非常难用」，这一条是其中最直接的。
            入库整块搬去了收件区（第一屏那个带数字的主按钮），这里不再重复。 */}
        <div className="od-tree-bar">
          {level === "global" ? null : <button type="button" className="od-tree-act"
            disabled={Boolean(busy) || draftFolder !== null}
            onClick={() => setDraftFolder({ kind: "new", base: selected?.folder_path ?? "", value: "" })}>
            {words("新建文件夹", "New folder", lang)}
          </button>}

          <label className="od-tree-archived">
            <input type="checkbox" checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)} />
            <span>{words("含已归档", "Archived", lang)}</span>
          </label>
        </div>

        {/* 就地建文件夹。它长在树的上沿，而且说清了会建在哪儿 ——
            这是 window.prompt 给不了的：那个弹窗盖在页面之上，用户看不见上下文。 */}
        {draftFolder?.kind === "new" ? <form className="od-folder-draft" onSubmit={(event) => {
          event.preventDefault();
          const name = draftFolder.value.trim();
          if (!name) return;
          const full = draftFolder.base ? `${draftFolder.base}/${name}` : name;
          setDraftFolder(null);
          void runMutation("folder:new", async () => {
            await api.createFolder(sessionId, full);
            return { ok: true, message: words(`已建文件夹「${name}」`, "Folder created", lang) };
          });
        }}>
          <label>
            <span>{draftFolder.base
              ? words(`建在「${draftFolder.base}」里`, `Inside “${draftFolder.base}”`, lang)
              : words("建在根目录", "At the root", lang)}</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 这一行是点了按钮才出现的，
                焦点跟过来正是用户此刻要的；不跟过来反而要再点一次。 */}
            <input autoFocus value={draftFolder.value} maxLength={80}
              placeholder={words("文件夹名称", "Folder name", lang)}
              onChange={(event) => setDraftFolder({ ...draftFolder, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Escape") setDraftFolder(null); }} />
          </label>
          <button type="submit" className="act" disabled={!draftFolder.value.trim()}>{words("建好", "Create", lang)}</button>
          <button type="button" className="od-link" onClick={() => setDraftFolder(null)}>{words("取消", "Cancel", lang)}</button>
        </form> : null}

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
            {/* 空状态得说「下一步点哪儿」，而且指的必须是**当下真的在屏幕上**的东西。
                原来这句写「用左上角的 ＋」，而那颗 ＋ 已经不在了，且它当初和旁边的
                ＋▤ 长得一样、干的是两件事。 */}
            <p>{level === "global"
              ? words("这里放跨项目通用的东西：行业标准、通用制度、模板。项目里的材料点「设为通用知识」才会进来。",
                      "Cross-project material lives here.", lang)
              : pending.length
                ? words("上面那颗按钮会把这次会话的材料存进来。", "Use the button above to file this session’s material.", lang)
                : words("先在对话里上传文件，再回到这里把它存入知识库。", "Upload a file in the chat first, then file it here.", lang)}</p>
            {level === "global" || pending.length ? null : <button type="button" className="act"
              onClick={() => document.getElementById("picker")?.click()}>{words("上传材料", "Upload material", lang)}</button>}
          </div> : <div className="od-tree-body" role="tree">
            {folderNames.map((name) => {
              // 父级收起时，子级整支不渲染 —— 缩进靠层数，不用递归组件。
              if (hiddenUnder(name)) return null;
              const depth = name.split("/").length - 1;
              const closed = closedFolders.has(name);
              const items = docsByFolder.get(name) ?? [];
              return <div
                className={`od-folder${dropTarget === name ? " dropping" : ""}`}
                key={name}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  // 不 preventDefault 的话浏览器根本不认这是个放置目标（drop 不会触发）。
                  event.preventDefault();
                  setDropTarget(name);
                }}
                onDragLeave={() => setDropTarget((cur) => (cur === name ? null : cur))}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== null) void moveTo(dragging, name);
                }}
              >
                <button type="button" className="od-folder-head" aria-expanded={!closed}
                  style={{ paddingLeft: `${10 + depth * 14}px` }}
                  onClick={() => setClosedFolders((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name); else next.add(name);
                    return next;
                  })}>
                  <span className="od-folder-caret" aria-hidden="true">{closed ? "›" : "⌄"}</span>
                  <span className="od-folder-name">{name.slice(name.lastIndexOf("/") + 1)}</span>
                  <span className="od-folder-n">{items.length || ""}</span>
                </button>
                {/* 改名 / 删除。
                    原来是两个只在 hover 时出现的字形（✎ ×）—— 触屏上永远出不来，
                    键盘 Tab 也走不到；解释文字全在 title 里。现在它们是常驻的、
                    带中文的两颗小按钮，删除的后果就写在展开的那一行上。 */}
                {level === "global" ? null : <span className="od-folder-acts">
                  <button type="button" onClick={() => {
                    setPendingDelete(null);
                    setDraftFolder({ kind: "rename", base: name, value: name.slice(name.lastIndexOf("/") + 1) });
                  }}>{words("改名", "Rename", lang)}</button>
                  <button type="button" onClick={() => { setDraftFolder(null); setPendingDelete(name); }}>
                    {words("删除", "Delete", lang)}
                  </button>
                </span>}

                {draftFolder?.kind === "rename" && draftFolder.base === name
                  ? <form className="od-folder-draft inline" onSubmit={(event) => {
                      event.preventDefault();
                      const next = draftFolder.value.trim();
                      if (!next) return;
                      const parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
                      setDraftFolder(null);
                      void runMutation(`folder:${name}:rename`, async () =>
                        await api.renameFolder(sessionId, name, parent ? `${parent}/${next}` : next));
                    }}>
                      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 同上：点出来的行，焦点该跟过来。 */}
                      <input autoFocus value={draftFolder.value} maxLength={80}
                        aria-label={words("新名称", "New name", lang)}
                        onChange={(event) => setDraftFolder({ ...draftFolder, value: event.target.value })}
                        onKeyDown={(event) => { if (event.key === "Escape") setDraftFolder(null); }} />
                      <button type="submit" className="act" disabled={!draftFolder.value.trim()}>{words("改好", "Rename", lang)}</button>
                      <button type="button" className="od-link" onClick={() => setDraftFolder(null)}>{words("取消", "Cancel", lang)}</button>
                    </form>
                  : null}

                {pendingDelete === name ? <div className="od-folder-confirm" role="alert">
                  <span>{words(
                    `删掉这个文件夹？里面的 ${items.length} 份材料会移到根目录，一份都不会被删。`,
                    `Delete this folder? Its ${items.length} files move to the root; none are deleted.`,
                    lang,
                  )}</span>
                  <button type="button" className="act" onClick={() => {
                    setPendingDelete(null);
                    void runMutation(`folder:${name}:delete`, async () => await api.deleteFolder(sessionId, name));
                  }}>{words("删掉文件夹", "Delete folder", lang)}</button>
                  <button type="button" className="od-link" onClick={() => setPendingDelete(null)}>{words("留着", "Keep", lang)}</button>
                </div> : null}
                {closed ? null : <div className="od-folder-body" role="group">
                  {items.map((item) => <FileRow key={item.id} item={item} depth={depth + 1}
                    selectedId={selectedId} attachments={attachments} lang={lang}
                    onPick={() => pickDocument(item.id)}
                    {...(level === "global" ? {} : {
                      onDragStart: () => setDragging(item.id),
                      onMenu: () => setMovingId(item.id),
                    })} />)}
                </div>}
              </div>;
            })}
            {/* 根目录的材料垫底，不套一层假文件夹 —— 那会让「没归类」看起来像个真分组。 */}
            {rootDocs.map((item) => <FileRow key={item.id} item={item} depth={0}
              selectedId={selectedId} attachments={attachments} lang={lang}
              onPick={() => pickDocument(item.id)}
              {...(level === "global" ? {} : {
                onDragStart: () => setDragging(item.id),
                onMenu: () => setMovingId(item.id),
              })} />)}
            {/* 根目录的放置区**只在拖拽期间存在**。静止时摆一条空白区域，
                等于给这一屏又加一个平时看不懂的东西。 */}
            {dragging !== null ? <div
              className={`od-root-drop${dropTarget === "" ? " dropping" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDropTarget(""); }}
              onDragLeave={() => setDropTarget((cur) => (cur === "" ? null : cur))}
              onDrop={(event) => { event.preventDefault(); if (dragging !== null) void moveTo(dragging, ""); }}
            >{words("拖到这里＝移出文件夹", "Drop here to move to root", lang)}</div> : null}
          </div>}
        {/* 拖不到的时候走这条：触屏上 HTML5 拖拽根本不发 dragstart，键盘更没有。
            而 @media(max-width:900px) 会把 .od-explorer 压成单列 —— 窄屏是这一页的
            常见形态，不是边角情况。 */}
        {movingId !== null ? <div className="od-move-pick" role="dialog"
          aria-label={words("移到别的文件夹", "Move to another folder", lang)}>
          <span>{words("移到：", "Move to:", lang)}</span>
          <button type="button" className="od-link"
            onClick={() => void moveTo(movingId, "")}>{words("根目录", "Root", lang)}</button>
          {folderNames.map((f) => <button type="button" className="od-link" key={f}
            onClick={() => void moveTo(movingId, f)}>{f}</button>)}
          <button type="button" className="od-link"
            onClick={() => setMovingId(null)}>{words("取消", "Cancel", lang)}</button>
        </div> : null}
        <div className="od-fm-status">
          <span>{status === "ready"
            ? words(`${documents.length} 份材料`, `${documents.length} files`, lang)
            : ""}</span>
          {/* 一段正文都没读出来的材料，一次全部重解析。
              解析发生在入库那一刻，解析器修好之后这些材料不会自己受益，
              而按 sha 去重又让「重新上传」这条路走不通 —— 逐份点是可行的，
              但一次就有六七份时那是六七次重复劳动。 */}
          {unreadable.length > 0 && level !== "global" ? <button type="button" className="od-link"
            disabled={ingesting}
            title={words("这些材料入库时没读出正文，用现在的解析器再读一遍", "Re-parse files with no readable text", lang)}
            onClick={() => void reparseAll()}>
            {ingesting
              ? words("正在重新解析…", "Re-parsing…", lang)
              : words(`${unreadable.length} 份读不出正文 · 重新解析`, `${unreadable.length} unreadable · re-parse`, lang)}
          </button> : null}
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
          level={level}
          onAsk={askCopilot}
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
          folderOptions={folderNames}
          onReparse={async () => await runMutation(`${selected.id}:reparse`,
            async () => await api.reparse(sessionId, selected.id))}
          onMove={async (folderPath) => await runMutation(`${selected.id}:move`,
            async () => await api.moveDocument(sessionId, selected.id, folderPath))}
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
