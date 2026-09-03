import {
  useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode,
} from "react";

import { sendChat } from "../chat.js";
import {
  GENERIC_SCENARIO_DRAFT_SCHEMA,
  contextReferenceFromCanvasNode,
  contextSyncStore,
  focusCanvasNodeReference,
  prefillComposer,
  sendContextToChat,
} from "../context-sync.js";
import { API } from "../dom.js";
import {
  loadQuestions, normalizeQuestion, qDefer, qReopen, qSaveMetaWith, qSubmitWith,
} from "../questions.js";
import {
  buildFdeReviewReadModel,
  type FdeReviewItem,
  type FdeReviewLevel,
  type FdeReviewReadModel,
} from "../../review/fde-read-model.js";
import { groupDeliveryArtifacts } from "../delivery-group.js";
import { togglePreview } from "../layout.js";
import { loadSource, openSource } from "../preview.js";
import { G as STATE, Q_BUSY } from "../state.js";
import { BundleLink } from "./bundle.js";
import { Markdown } from "./markdown.js";
import { RuntimePanel } from "./runtime.js";
import { bumpUi, setUi, useUi } from "./store.js";
import WebPreview, {
  normalizeSafeWebUrl as normalizeWebPreviewUrl,
  normalizeWebPreviewHistoryState,
  type LiveBrowserFrame,
  type WebPreviewHistoryState,
  type WebPreviewMaterialReceipt,
  type WebPreviewPage,
} from "./web-preview.js";
import {
  WORKBENCH_OPEN_EVENT,
  WORKBENCH_TAB_ID,
  WorkbenchTabShell,
  normalizeWorkbenchTarget,
  useWorkbenchTabs,
  type WorkbenchResourceTab,
  type WorkbenchResourceTarget,
} from "./workbench-tabs.js";

export type ContextSection = "project" | "evidence" | "model" | "review" | "delivery" | "runtime";
type ModelKind = "object" | "process" | "rule" | "action" | "event";

export interface ContextSidebarData {
  revision?: string | number | null;
  oir?: Record<string, any> | null;
  flow?: Record<string, any> | null;
  /** `flow.sketch` 的独立参考命名空间；只用于画布预览，绝不计入正式模型。 */
  sketch?: Record<string, any> | null;
  questions?: any[] | null;
  artifacts?: Array<string | Record<string, any>> | null;
  evidence?: any[] | null;
}

export interface ContextSidebarProps {
  /** The backend-normalized read model can be supplied by the mounting wrapper. */
  context?: ContextSidebarData | null;
  initialSection?: ContextSection;
  onSectionChange?: (section: ContextSection) => void;
}

interface EvidenceRef {
  file: string;
  cite: string;
  snippet: string;
  confidence?: number;
}

interface RelationRef {
  label: string;
  meta: string;
  targetId?: string;
}

/** 对象的一条属性。**口径（definition）是 FDE 最要核对的东西** —— 以前整个
 *  sidebar 只有「属性 3」这个数字，属性名、类型、口径一个都看不到。 */
interface AttrRef {
  name: string;
  api: string;
  type: string;
  definition: string;
  required: boolean;
  /** inferred=模型凭通识猜的；extracted=从材料抽的；confirmed=人拍过板的。
   *  实测真实库里 100% 是 inferred，而界面上只显示 candidate —— 看不出该不该信。 */
  origin: string;
}

/** 一处「差什么」。**label 是缺口本身，prompt 是补它的那句话** ——
 *  只报缺不给下一步，等于把活推回给人。 */
interface GapRef {
  label: string;
  prompt: string;
}

interface ModelItem {
  id: string;
  kind: ModelKind;
  label: string;
  api: string;
  description: string;
  status: string;
  evidence: EvidenceRef[];
  relations: RelationRef[];
  attributes: AttrRef[];
  gaps: GapRef[];
  pending: any[];
  facts: Array<[string, string]>;
  searchText: string;
}

type ViewerType = "material" | "evidence" | "artifact" | "graph";
type ViewerFormat = "image" | "markdown" | "text" | "table" | "document" | "pdf" | "graph" | "unknown";

export interface ContextViewerTarget {
  id: string;
  type: ViewerType;
  title: string;
  format: ViewerFormat;
  extension: string;
  url: string;
  downloadUrl: string;
  sourceLabel: string;
  fileName: string;
  cite: string;
  snippet: string;
  flow?: Record<string, any>;
  oir?: Record<string, any>;
  /** 通用知识生成的参考草图。它不是 Flow、Ontology 或交付产物。 */
  sketch?: Record<string, any>;
  selectedId?: string;
  /** 画布该落在哪个模式。对象要「对象关系」，其余走「工作流」。 */
  graphMode?: "workflow" | "objects";
}

function workbenchTargetFromViewer(target: ContextViewerTarget): WorkbenchResourceTarget<ContextViewerTarget> {
  const persistedViewer = {
    id: target.id,
    type: target.type,
    title: target.title,
    format: target.format,
    extension: target.extension,
    url: target.url,
    downloadUrl: target.downloadUrl,
    sourceLabel: target.sourceLabel,
    fileName: target.fileName,
    cite: target.cite,
    snippet: target.snippet,
    ...(target.selectedId ? { selectedId: target.selectedId } : {}),
    ...(target.graphMode ? { graphMode: target.graphMode } : {}),
  };
  return {
    kind: target.type === "graph" ? "context" : "file",
    key: `${target.type}:${target.id}`,
    id: target.id,
    title: target.title,
    ...(target.url ? { url: target.url } : {}),
    // Flow/OIR/sketch 大对象只活在当前 mount 的 viewer 中。刷新所需的轻量定位信息
    // 单独存进 viewState，恢复时再绑定当前会话的最新模型，避免 localStorage 冻结旧模型。
    viewState: { viewer: persistedViewer },
    viewer: target,
  };
}

function viewerFromWorkbenchTarget(
  target: WorkbenchResourceTarget<ContextViewerTarget>,
  current: { flow: Record<string, any>; oir: Record<string, any>; sketch: Record<string, any> },
): ContextViewerTarget | null {
  if (target.viewer) return target.viewer;
  const raw = target.viewState?.viewer;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const saved = raw as Record<string, any>;
  const type = text(saved.type) as ViewerType;
  if (!(["material", "evidence", "artifact", "graph"] as string[]).includes(type)) return null;
  const format = text(saved.format, "unknown") as ViewerFormat;
  const restored: ContextViewerTarget = {
    id: text(saved.id, target.id || ""),
    type,
    title: text(saved.title, target.title),
    format,
    extension: text(saved.extension),
    url: text(saved.url, target.url || ""),
    downloadUrl: text(saved.downloadUrl),
    sourceLabel: text(saved.sourceLabel),
    fileName: text(saved.fileName),
    cite: text(saved.cite),
    snippet: text(saved.snippet),
  };
  const selectedId = text(saved.selectedId);
  if (selectedId) restored.selectedId = selectedId;
  if (saved.graphMode === "workflow" || saved.graphMode === "objects") restored.graphMode = saved.graphMode;
  if (type === "graph") {
    restored.flow = current.flow;
    restored.oir = current.oir;
    restored.sketch = current.sketch;
  }
  return restored.id ? restored : null;
}

interface ViewerSheet {
  name: string;
  columns: string[];
  rows: string[][];
}

interface ViewerPayload {
  status: "idle" | "loading" | "ready" | "error";
  text: string;
  sheets: ViewerSheet[];
  chunks: any[];
  findings: any[];
  error: string;
  meta: any;
}

interface CanvasNode {
  id: string;
  label: string;
  code: string;
  kind: string;
  stage: string;
  grounded: boolean;
  evidence: EvidenceRef[];
  pending: any[];
  raw: any;
  x: number;
  y: number;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  grounded: boolean;
}

/** 仅影响浏览器里的画布坐标，不写入 Flow / Ontology。 */
export type CanvasLayoutDirection = "TB" | "LR";

const NAV: Array<[ContextSection, string, string]> = [
  ["project", "项目", "Project"],
  ["evidence", "文件", "Files"],
  ["model", "模型", "Model"],
  ["review", "审阅", "Review"],
  ["delivery", "交付", "Delivery"],
  ["runtime", "运行", "Runtime"],
];

const MODEL_KINDS: readonly ModelKind[] = ["object", "process", "rule", "action", "event"];

/** 节点盒模型：CSS 里的 .ctx-graph-node 宽高与连线端口位置必须用同一组常量。 */
const NODE_WIDTH = 168;
const NODE_HEIGHT = 62;
const NODE_PORT_Y = 31;
const NODE_PORT_X = 84;
const CANVAS_LAYOUT_STORAGE_PREFIX = "oc_graph_layout:";

function canvasLayoutKey(sessionId: string): string {
  return `${CANVAS_LAYOUT_STORAGE_PREFIX}${sessionId || "local"}`;
}

/**
 * 没有保存偏好时，按**容器形状**挑一个能看的方向。
 *
 * LR 严格横向推进（不折行 —— 折行会产生绕回的连线，读起来像回退）。这在宽扁的
 * 全屏画布上是对的，但右侧栏是**窄而高**的：一条 11 环节的线性流程在 LR 下是
 * 2308×46 的横条（50:1），塞进 500×820 的侧栏只能缩到 20% —— 全看见、全读不出，
 * 而 60% 的可读下限又会把它钳住只显示入口那一段。实测同一份图 TB 是 168×1406，
 * 适配 55%。
 *
 * 判据就是**容器自己的长宽比**，没有写死的档位：高比宽大就走 TB，否则 LR。
 * 不用「够不够两列」这类阈值 —— 那要挑一个魔数，而侧栏宽度是用户可拖的，
 * 挑出来的数换个人用就不成立。容器更高就纵向铺，这条判据换谁都成立。
 * 量不到尺寸时回 LR，与既有行为一致 —— 不赌。
 */
export function defaultCanvasLayout(box: { width: number; height: number }): CanvasLayoutDirection {
  const { width, height } = box;
  if (width <= 0 || height <= 0) return "LR";
  return height > width ? "TB" : "LR";
}

/**
 * 布局选择是每个会话的本地视图偏好；不能混进可持久化的业务 state。
 *
 * **用户选过就永远听用户的**；只有没选过时才用 {@link defaultCanvasLayout}
 * 按容器形状挑 —— 默认值不该盖掉人的选择。
 */
export function savedCanvasLayout(
  sessionId: string,
  box?: { width: number; height: number },
): CanvasLayoutDirection {
  try {
    const saved = localStorage.getItem(canvasLayoutKey(sessionId));
    if (saved === "TB" || saved === "LR") return saved;
  } catch { /* 禁用本地存储：往下走默认判定 */ }
  return box ? defaultCanvasLayout(box) : "LR";
}

function rememberCanvasLayout(sessionId: string, direction: CanvasLayoutDirection): void {
  try { localStorage.setItem(canvasLayoutKey(sessionId), direction); }
  catch { /* 禁用本地存储时，当前挂载周期的 React state 仍然可用。 */ }
}

const KIND_LABEL: Record<ModelKind, readonly [string, string]> = {
  object: ["对象", "Object"],
  process: ["流程", "Process"],
  rule: ["规则", "Rule"],
  // **中文位不要留英文。** 这两行原来是 ["Action","Action"] / ["Event","Event"]，
  // 于是中文界面上「对象 / 流程 / 规则」三个筛选是中文、后两个突然变英文 ——
  // 看起来像没做完，而不是像术语。Ontology 圈子里 Action/Event 确实常直接说英文，
  // 但那是**口头**惯例；界面上同一排控件半中半英只会让人以为是 bug。
  // 真要保留英文术语，切到 EN 就是了 —— 这张表存在的意义正是让语言开关说了算。
  action: ["动作", "Action"],
  event: ["事件", "Event"],
};

/**
 * 跨 tab 命中数。
 *
 * 这个控件一直长得像全局搜索，实际是四个互不相干的本页筛选 —— FDE 在交付页
 * 搜「采购申请」看到「还没有产物」，会判定这个项目里没有这个词，**而模型页里
 * 明明有这个对象**。上一轮先把措辞改诚实了；这一轮把它真的做成跨 tab：
 * 输入后按 tab 分组给命中数，点一下切过去并带上 query。
 *
 * 判据必须和各面板**自己**的筛选口径一致，否则下拉说有 3 条、切过去看见 0 条。
 * 所以这里复用同一批谓词（文件按名字/状态、模型按 searchText、审阅按问题文本、
 * 交付按产物名），不另写一套。
 */
function searchHits(q: string, data: {
  files: any[]; items: ModelItem[]; questions: any[]; artifacts: any[]; events: any[];
}): Array<{ section: ContextSection; label: string; count: number }> {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return [];
  const has = (...parts: unknown[]): boolean =>
    parts.map((x) => text(x).toLocaleLowerCase()).join(" ").includes(needle);
  return [
    { section: "evidence" as ContextSection, label: uiText("文件", "Files"),
      count: data.files.filter((f) => has(f.name, f.state, f.issue)).length },
    { section: "model" as ContextSection, label: uiText("模型", "Model"),
      count: data.items.filter((i) => i.searchText.toLocaleLowerCase().includes(needle)).length },
    { section: "review" as ContextSection, label: uiText("审阅", "Review"),
      count: data.questions.filter((x) => has(x.text, x.why, x.answer)).length },
    { section: "delivery" as ContextSection, label: uiText("交付", "Delivery"),
      count: data.artifacts.filter((a) => has(artifactName(a))).length },
    { section: "runtime" as ContextSection, label: uiText("运行", "Runtime"),
      count: data.events.filter((event) => {
        try { return JSON.stringify(event).toLocaleLowerCase().includes(needle); }
        catch { return has(event?.kind, event?.detail, event?.error); }
      }).length },
  ].filter((row) => row.count > 0);
}

/** 每一页的筛选提示。说清楚**这一页按什么筛**，别再承诺跨页搜索。 */
const SEARCH_HINT: Record<string, string> = {
  get evidence() { return uiText("在材料里筛文件名…", "Filter materials by name…"); },
  get model() { return uiText("在模型里筛对象、流程、规则…", "Filter objects, processes, rules…"); },
  get review() { return uiText("在待确认里筛问题…", "Filter open questions…"); },
  get delivery() { return uiText("在产物里筛文件名…", "Filter artifacts by name…"); },
  get runtime() { return uiText("筛工具、输入、输出或事件…", "Filter tools, input, output, or events…"); },
};

const STATUS_LABEL: Record<string, string> = {
  open: "待回答",
  assigned: "已分派",
  blocked: "受阻",
  answered: "已回答",
  deferred: "已延期",
  cancelled: "已取消",
};

const STATUS_LABEL_EN: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  blocked: "Blocked",
  answered: "Answered",
  deferred: "Deferred",
  cancelled: "Cancelled",
};

const PRIORITY_OPTIONS: Array<[string, string]> = [
  ["low", "低优先级"],
  ["normal", "普通优先级"],
  ["high", "高优先级"],
  ["blocking", "阻塞交付"],
];

const ROLE_OPTIONS = ["", "业务负责人", "流程负责人", "ERP顾问", "数据负责人", "财务/法务", "FDE"];

const REVIEW_LEVEL_LABEL: Readonly<Record<FdeReviewLevel, readonly [string, string]>> = {
  blocking: ["阻塞", "Blocking"],
  important: ["重要", "Important"],
  completeness: ["完整性", "Completeness"],
  diagnostic: ["批量", "Batch"],
};

/**
 * 「记录决定 → 聊天自动反馈」的唯一出口。
 *
 * 侧栏写完 Question Ledger 之后要让对话立刻接着往下走，因此这里**会真的发送**，
 * 而不是像普通引用那样只预填。抽成可替换 seam 有两个理由：测试不需要真跑一遍
 * `render()` 那条命令式链路；将来若要改成「先预填让人过目」也只动这一处。
 */
export const contextChatBridge: { send: () => Promise<unknown> } = {
  send: async () => { await sendChat(); },
};

function uiText(zh: string, en: string): string {
  return STATE.LANG === "en" ? en : zh;
}

function reviewStatusLabel(status: string): string {
  return STATE.LANG === "en"
    ? STATUS_LABEL_EN[status] || status
    : STATUS_LABEL[status] || status;
}

function kindLabel(kind: ModelKind): string {
  const labels = KIND_LABEL[kind];
  return STATE.LANG === "en" ? labels[1] : labels[0];
}

function nodeGroundedText(node: any, evidence: EvidenceRef[]): string {
  return node?.grounded === false || evidence.length === 0
    ? uiText("待确认", "Pending")
    : uiText("有依据", "Grounded");
}

/**
 * 模型实体状态的人话。
 *
 * 原来这两处直接把 `item.status` 原样打在徽标上，于是中文界面上出现一个
 * 英文枚举词 `candidate` —— 而 `STATUS_LABEL` 那张表只覆盖**问题**的状态
 * （open/answered/…），完全没有实体状态。
 *
 * 实测真实库：775 条实体（对象/属性/关系/Action/规则）**100% 是 candidate**。
 * 所以这个徽标目前既不说人话、也不携带任何区分度 —— 但它不是天生没用：
 * 人工确认（set_status）会把它改成 confirmed。要修的是措辞，不是删掉它。
 */
const MODEL_STATUS_LABEL: Record<string, [string, string]> = {
  candidate: ["待确认", "Candidate"],
  draft: ["草稿", "Draft"],
  pending: ["待确认", "Pending"],
  inferred: ["推断", "Inferred"],
  confirmed: ["已确认", "Confirmed"],
  rejected: ["已否决", "Rejected"],
};

function modelStatusLabel(status: string): string {
  const hit = MODEL_STATUS_LABEL[status.trim().toLocaleLowerCase()];
  // 认不出的原样回显 —— 猜一个中文名会把新枚举值藏起来
  return hit === undefined ? status : uiText(hit[0], hit[1]);
}

/**
 * 这条要不要人再看一眼。
 *
 * **反过来写：只有明确可信的才放行，其余一律要复核。** 上一版是白名单
 * （candidate/draft/… 才算要复核），没命中就 false，false 渲染成
 * confirmed/绿 —— 一个信任信号在**未知输入上向"可信"那边倒**。
 * 具体代价：`proposed` 是聊天里 bind_rule / set_action_scope 自己写进去的状态，
 * 刚挂上、最该复核，却被画成绿的「已确认」；`rejected` 是人明确否掉的，同样画绿。
 *
 * `rejected` 单独一档：它不是"要复核"，是"已经判了"，绿和黄都不对。
 */
function modelRejected(status: string): boolean {
  return ["rejected", "已否决", "已拒绝"].includes(status.trim().toLocaleLowerCase());
}

function modelNeedsReview(status: string): boolean {
  if (modelRejected(status)) return false;
  return !["confirmed", "已确认", "已确定", "approved"].includes(status.trim().toLocaleLowerCase());
}

function rows(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/** 是否已经有一张真正可展示的流程图。stage 元数据本身不算流程结构。 */
function hasWorkflowStructure(value: any): boolean {
  return rows(value?.workflows).length > 0
    || rows(value?.nodes).length > 0
    || rows(value?.edges).length > 0;
}

function text(value: any, fallback = ""): string {
  const raw = value && typeof value === "object" && "value" in value ? value.value : value;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) return raw.map((x) => text(x)).filter(Boolean).join("、");
  return fallback;
}

/** 口径行的文案。值域单独出现时要**自己带标签**，不能掉成一串裸取值。 */
function attrDefinition(definition: string, domain: string): string {
  const tail = domain ? `取值：${domain}` : "";
  if (definition && tail) return `${definition}　${tail}`;
  return definition || tail;
}

/** Assertion 的 origin。取不到就当 inferred —— 宁可标"通识"让人多看一眼，
 *  也不要默认标成"材料"给人虚假的踏实感。 */
function originOf(value: any): string {
  const o = value && typeof value === "object" ? String(value.origin ?? "") : "";
  return o || "inferred";
}

/** origin 的中文名。只有三档，多的都归"通识"。 */
const ORIGIN_LABEL: Record<string, string> = {
  extracted: "材料",
  confirmed: "已确认",
  user: "已确认",
  inferred: "通识",
};

function evidenceOf(...values: any[]): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  const seen = new Set<string>();
  const add = (raw: any): void => {
    if (!raw) return;
    if (typeof raw === "string") {
      const cite = raw;
      if (!seen.has(cite)) {
        seen.add(cite);
        out.push({ file: cite.split(/[!#]/)[0] || "", cite, snippet: "" });
      }
      return;
    }
    const cite = text(raw.cite || raw.location || raw.id);
    const file = text(raw.file_name || raw.file || raw.fileName) || cite.split(/[!#]/)[0] || "";
    const snippet = text(raw.snippet || raw.quote || raw.text);
    const key = `${file}\u0000${cite}\u0000${snippet}`;
    if ((!cite && !snippet) || seen.has(key)) return;
    seen.add(key);
    const confidence = Number(raw.confidence);
    out.push({
      file,
      cite: cite || file || "材料片段",
      snippet,
      ...(Number.isFinite(confidence) ? { confidence } : {}),
    });
  };
  const walk = (value: any): void => {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value === "object" && Array.isArray(value.evidence)) {
      value.evidence.forEach(add);
      return;
    }
    add(value);
  };
  values.forEach(walk);
  return out;
}

function dedupeEvidence(items: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}\u0000${item.cite}\u0000${item.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0] || "";
  const dot = clean.lastIndexOf(".");
  return dot > -1 ? clean.slice(dot + 1).toLocaleLowerCase() : "";
}

function viewerFormat(name: string, type: ViewerType): ViewerFormat {
  if (type === "graph") return "graph";
  const extension = extensionOf(name);
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) return "image";
  if (extension === "md") return "markdown";
  if (["csv", "tsv", "xls", "xlsx"].includes(extension)) return "table";
  if (["doc", "docx"].includes(extension)) return "document";
  if (extension === "pdf") return "pdf";
  if (["txt", "json", "yaml", "yml", "xml", "sql", "ddl", "mmd", "bpmn", "log"].includes(extension)) return "text";
  return type === "material" || type === "evidence" ? "document" : "unknown";
}

function sourceUrl(sessionId: string, fileName: string): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/source?file=${encodeURIComponent(fileName)}`;
}

function previewApiUrl(sessionId: string, source: "artifact" | "material" | "model", name: string): string {
  return `${API}/api/sessions/${encodeURIComponent(sessionId)}/preview?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`;
}

function artifactUrl(sessionId: string, artifact: any): string {
  const direct = text(artifact?.downloadPath || artifact?.downloadUrl || artifact?.download_url
    || artifact?.url || artifact?.href);
  return direct || `${API}/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactName(artifact))}`;
}

function materialTarget(sessionId: string, fileName: string, cite = "", snippet = ""): ContextViewerTarget {
  const parsedUrl = sourceUrl(sessionId, fileName);
  const type: ViewerType = cite ? "evidence" : "material";
  return {
    id: `${type}:${fileName}:${cite}`,
    type,
    title: cite ? `证据 · ${fileName}` : fileName,
    format: viewerFormat(fileName, type),
    extension: extensionOf(fileName),
    url: previewApiUrl(sessionId, "material", fileName),
    downloadUrl: parsedUrl,
    sourceLabel: cite ? "材料定位" : "项目材料",
    fileName,
    cite,
    snippet,
  };
}

function artifactTarget(sessionId: string, artifact: any): ContextViewerTarget {
  const name = artifactName(artifact);
  const downloadUrl = artifactUrl(sessionId, artifact);
  return {
    id: `artifact:${text(artifact?.id, name)}`,
    type: "artifact",
    title: name || "未命名产物",
    format: viewerFormat(name, "artifact"),
    extension: extensionOf(name),
    url: previewApiUrl(sessionId, "artifact", name),
    downloadUrl,
    sourceLabel: text(artifact?.revision) ? `交付产物 · ${text(artifact.revision)}` : "交付产物",
    fileName: name,
    cite: "",
    snippet: text(artifact?.description),
  };
}

function parseDelimited(source: string, delimiter: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index] || "";
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) { row.push(cell); cell = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell); cell = "";
      if (row.some((value) => value.length > 0)) result.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.length > 0)) result.push(row);
  return result;
}

function tableFromDelimited(source: string, delimiter: string, name: string): ViewerSheet {
  const values = parseDelimited(source, delimiter).slice(0, 101);
  const width = Math.max(0, ...values.map((row) => row.length));
  const header = values.shift() || [];
  const columns = Array.from({ length: width }, (_, index) => header[index] || `列 ${index + 1}`);
  return { name, columns, rows: values.map((row) => columns.map((_, index) => row[index] || "")) };
}

function chunkSheetName(chunk: any): string {
  const explicit = text(chunk?.locator?.sheet || chunk?.locator?.section);
  if (explicit) return explicit;
  const match = text(chunk?.cite).match(/!([^!]+)!/u);
  return match?.[1] || "内容";
}

function tableFromChunks(chunks: any[]): ViewerSheet[] {
  const groups = new Map<string, any[]>();
  for (const chunk of chunks) {
    const name = chunkSheetName(chunk);
    const current = groups.get(name) || [];
    current.push(chunk);
    groups.set(name, current);
  }
  return [...groups.entries()].map(([name, sourceRows]) => {
    const parsed = sourceRows.slice(0, 100).map((chunk) => {
      const raw = text(chunk.text);
      const cells = raw.split("|").map((part) => part.trim()).filter(Boolean);
      const pairs: Array<[string, string]> = cells.map((part): [string, string] => {
        const at = part.indexOf("=");
        return at > -1 ? [part.slice(0, at).trim(), part.slice(at + 1).trim()] : ["内容", part];
      });
      return { cite: text(chunk.cite), pairs };
    });
    const columns = [...new Set(parsed.flatMap((row) => row.pairs.map(([key]) => key)))];
    if (!columns.length) columns.push("内容");
    columns.push("出处");
    return {
      name,
      columns,
      rows: parsed.map((row) => columns.map((column) => column === "出处"
        ? row.cite
        : row.pairs.find(([key]) => key === column)?.[1] || "")),
    };
  });
}

function refsFor(raw: any): string[] {
  const values = raw?.applies || raw?.appliesTo || raw?.applies_to || raw?.objects || [];
  return rows(values).map((value) => String(value)).filter(Boolean);
}

function questionMatches(q: any, refs: string[], label: string, api: string): boolean {
  const applied = refsFor(q);
  if (applied.some((value) => refs.includes(value))) return true;
  const haystack = [q?.text, q?.why, q?.impact].map((value) => text(value).toLocaleLowerCase()).join(" ");
  return [label, api].filter(Boolean).some((value) => haystack.includes(value.toLocaleLowerCase()));
}

/**
 * 缺口 → 补它的那句话。
 *
 * 实测真实库：527 个对象**全部**没有主键，121 个 Action 里 119 个没有入参。
 * 这些字段 OIR 里都有位置，只是没人填 —— 界面上却只显示一个 `candidate`，
 * 看不出差在哪。这里把「差什么」变成一句能直接发出去的指令。
 *
 * 措辞上刻意点名要什么：说「补属性」模型会敷衍两条，说「每个带类型和口径
 * （含不含税、什么时间粒度）」才问得到 FDE 真正要拿去对账的东西。
 */
function gapPrompt(label: string, kind: string): string {
  const q = `「${label}」`;
  switch (kind) {
    case "primaryKey":
      return `${q}还没有主键。哪个属性是它的唯一标识？如果现有属性里没有，就新建一个并说明为什么是它。`;
    case "properties":
      return `${q}一个属性都没有。把这张单据上的字段列全，每个写清楚：名字、类型、是否必填、`
        + `**口径**（金额含不含税、日期按什么粒度、状态有哪几个取值）。`;
    case "links":
      return `${q}还没有任何关系。它和哪些对象是主从/引用关系？每条写清楚靠哪个字段连（join key）。`;
    case "flow":
      return `${q}没有接进流程图。流程里哪些环节读写它？用 flow.edit 把那些节点绑到这个对象上。`;
    case "parameters":
      return `Action ${q}没有入参。它执行时要传什么？每个参数写名字、类型、是否必填，`
        + `再说清楚它会写这个对象的哪几个字段。`;
    case "appliesTo":
      return `Action ${q}没有绑定作用对象。它改的是哪张单据？绑上去。`;
    // ── 流程 ──────────────────────────────────────────
    case "terminal":
      return `流程${q}没有终态。跑到最后是什么结果？把终态补上（可能不止一个：`
        + `正常完成、被驳回、被取消），并连上通向它的边。`;
    case "deadEnd":
      return `流程${q}里有环节走到头就断了。把这些死端接到下一步或接到终态上；`
        + `如果它本来就该在那里结束，就补一个终态节点。`;
    case "nodeObjects":
      return `流程${q}的环节都没绑业务对象。逐个说清楚每个环节读写哪张单据 —— `
        + `流程图和 Ontology 就是靠这个连起来的。`;
    // ── 规则 ──────────────────────────────────────────
    case "ruleScope":
      return `规则${q}还没绑到任何业务对象上。它约束的是哪张单据？绑上去 —— `
        + `不绑就没法在改那个对象时把它拉出来看。`;
    case "ruleActor":
      return `规则${q}没有执行角色。这条谁来把关？`;
    case "ruleCondition":
      return `规则${q}只有一句原话，没有**可判定的条件**。把它能执行的那一半写出来`
        + `（形如 \`estimatedAmount > 50000\`）—— 有了它才能生成校验代码，`
        + `也才能跟流程网关上的分支条件对得上（现在同一个阈值在两处各写各的，`
        + `矛盾了没人发现）。写不出来就说写不出来，不要硬凑。`;
    case "ruleKind":
      return `规则${q}还没分类。它是校验（VALIDATION）、流程（PROCESS）、`
        + `权限（AUTHORITY）、还是计算口径（CALCULATION）？分类决定它下游变成什么。`;
    // ── 事件 ──────────────────────────────────────────
    case "producer":
      return `事件${q}不知道是谁产生的。哪个环节做完之后会有这个事实？把那条边连上。`;
    case "consumer":
      return `事件${q}没有下游。它发生之后触发什么？没有下游就说明它是终态事实，`
        + `那也请明说。`;
    case "payload":
      return `事件${q}没有载荷。它带着哪张单据的数据？绑上去。`;
    default:
      return `${q}还差 ${kind}，请补齐。`;
  }
}

/**
 * 「这份流程图算几条流程」——**只能有一个算法**。
 *
 * 修的是一个实测能复现的矛盾：同一个会话，项目页写「流程 0」、模型页写「流程 5」。
 * 项目页原来算的是 `flow.stats?.workflows ?? (workflows.length || stages.length)`，
 * 两个坑叠在一起：
 *   ① `flow.workflows` 这个容器在非 BPMN 路径上**恒为空**，于是 `stats.workflows` 恒为 0；
 *   ② `??` 只对 null/undefined 兜底，**不对 0 兜底** —— 后面那截 `||` 链根本走不到。
 * 而模型页走的是另一套（有 workflows 用它，没有就退到 stages），所以数出 5。
 *
 * 两处各写各的必然分叉。抽出来一处，两边都用它。
 */
/**
 * 发布状态。**同一个事实只能有一个公式。**
 *
 * 修的是又一处两套算法：项目页写
 * `blockers ? BLOCKED : active ? DRAFT : (status==="done" ? RELEASED : DRAFT)`，
 * 交付页少了最后那道 `status==="done"` 的闸 —— 于是没有阻塞问题、也没有开放问题、
 * 但会话还没跑完的那一刻，**项目页写 DRAFT，交付页同一秒写 RELEASED**。
 *
 * 取严的那一套：对"能交付了"这件事宁可少说，不可多说 ——
 * 界面上写着 RELEASED 而实际下载闸门不放行，比写 DRAFT 更坑人。
 */
function releaseState(questions: any[], sessionStatus: string): "BLOCKED" | "DRAFT" | "RELEASED" {
  const active = questions.filter((q) => ["open", "assigned", "blocked"].includes(q.status));
  const blockers = active.filter((q) => q.priority === "blocking" || rows(q.blockedArtifacts).length);
  if (blockers.length) return "BLOCKED";
  if (active.length) return "DRAFT";
  return sessionStatus === "done" ? "RELEASED" : "DRAFT";
}

function processCount(flow: any): number {
  const workflows = rows(flow?.workflows);
  return workflows.length > 0 ? workflows.length : rows(flow?.stages).length;
}

function modelItems(oir: any, flow: any, questions: any[]): ModelItem[] {
  const objects = rows(oir?.objects);
  const properties = rows(oir?.properties);
  const links = rows(oir?.links);
  const actions = rows(oir?.actions);
  const rules = rows(oir?.rules);
  const flowNodes = rows(flow?.nodes);
  const semanticEvents = rows(oir?.events);
  const events = semanticEvents.length
    ? semanticEvents
    : flowNodes.filter((node) => text(node.kind || node.type).toLocaleLowerCase() === "event");
  const objectByRef = new Map<string, string>();
  for (const object of objects) {
    const label = text(object.displayName) || text(object.apiName) || text(object.rid, "未命名对象");
    for (const ref of [object.rid, text(object.apiName), text(object.displayName)].filter(Boolean)) {
      objectByRef.set(String(ref), label);
    }
  }
  const objectLabel = (ref: any): string => objectByRef.get(String(ref)) || String(ref || "未命名对象");
  const actionByRef = new Map<string, string>();
  for (const action of actions) {
    const label = text(action.displayName) || text(action.name) || text(action.apiName) || text(action.rid || action.id);
    for (const ref of [action.rid, action.id, text(action.apiName), text(action.displayName), text(action.name)].filter(Boolean)) {
      actionByRef.set(String(ref), label || String(ref));
    }
  }
  const actionLabel = (ref: any): string => actionByRef.get(String(ref)) || String(ref || uiText("未命名 Action", "Unnamed Action"));
  const items: ModelItem[] = [];

  objects.forEach((object, index) => {
    const label = text(object.displayName) || text(object.apiName) || `未命名对象 ${index + 1}`;
    const api = text(object.apiName) || text(object.rid);
    const refs = [text(object.rid), api, label].filter(Boolean);
    const props = properties.filter((property) => refs.includes(text(property.parent)));
    const connected = links.filter((link) => refs.includes(text(link.from)) || refs.includes(text(link.to)));
    const objectActions = actions.filter((action) => refsFor(action).some((ref) => refs.includes(ref)));
    const processNodes = flowNodes.filter((node) => refsFor(node).some((ref) => refs.includes(ref)));
    const relations: RelationRef[] = connected.map((link) => {
      const from = text(link.from), to = text(link.to);
      const target = refs.includes(from) ? to : from;
      return {
        label: objectLabel(target),
        meta: text(link.cardinality, "关联对象"),
        targetId: String(target || ""),
      };
    });
    objectActions.forEach((action) => relations.push({
      label: text(action.apiName, text(action.rid, uiText("未命名动作", "Unnamed action"))),
      meta: kindLabel("action"),
      targetId: text(action.rid),
    }));
    processNodes.slice(0, 8).forEach((node) => relations.push({
      label: text(node.label, text(node.code, "流程节点")),
      meta: "流程节点",
      targetId: text(node.rid),
    }));
    const evidence = dedupeEvidence([
      ...evidenceOf(object.displayName, object.apiName, object.description, object.primaryKey),
      ...props.flatMap((property) => evidenceOf(property.displayName, property.apiName, property.definition)),
    ]);
    const pending = questions.filter((q) => questionMatches(q, refs, label, api));
    const description = text(object.description) || (props.length
      ? `包含 ${props.length} 个已识别属性。`
      : "尚未从材料中提取对象说明。");
    const attributes: AttrRef[] = props.map((property) => ({
      name: text(property.displayName) || text(property.apiName) || "未命名属性",
      api: text(property.apiName),
      type: text(property.baseType, "STRING"),
      // 值域并进口径里显示 —— 「草稿/待审/已批准」这种取值表比一句描述有用得多。
      // 用 join 拼是错的：没有 definition 时会掉成一串裸取值，看不出那是值域。
      definition: attrDefinition(text(property.definition), text(property.valueDomain)),
      required: text(property.required) === "true",
      origin: originOf(property.apiName),
    }));
    const gaps: GapRef[] = [];
    if (text(object.primaryKey) === "") gaps.push({ label: uiText("无主键", "no primary key"), prompt: gapPrompt(label, "primaryKey") });
    if (props.length === 0) gaps.push({ label: uiText("无属性", "no attributes"), prompt: gapPrompt(label, "properties") });
    if (connected.length === 0) gaps.push({ label: uiText("无关系", "no relations"), prompt: gapPrompt(label, "links") });
    if (processNodes.length === 0) gaps.push({ label: uiText("未接入流程", "not in any flow"), prompt: gapPrompt(label, "flow") });
    // facts 只留**缺口芯片没覆盖的那些维度**。三对原来是完全重复的
    // （属性 0／无属性、关联对象 0／无关系、流程节点 0／未接入流程），
    // 两行首屏最贵的位置说同一件事两遍，而唯一不重复的「Actions」反而没有芯片。
    // 有缺口时数字让位给芯片（芯片能点、能补），没缺口时数字才有意义（多少条）。
    const factIf = (label: string, n: number, covered: boolean): Array<[string, string]> =>
      covered ? [] : [[label, String(n)]];
    const facts: Array<[string, string]> = [
      ...factIf("属性", props.length, props.length === 0),
      ...factIf("关联对象", connected.length, connected.length === 0),
      // Actions 没有对应芯片（"对象没有 Action"不一定是缺陷 —— 主数据/参考数据
      // 本来就没人对它做动作，为它加芯片会在正当情况上制造噪音）。但它同样
      // 不该以「Actions 0」的形态单独占一整行 —— 零就是没有，关联区已经说明白了。
      ...factIf("Actions", objectActions.length, objectActions.length === 0),
      ...factIf("流程节点", processNodes.length, processNodes.length === 0),
    ];
    items.push({
      id: text(object.rid) || `object:${api || index}`,
      kind: "object",
      label,
      api,
      description,
      status: text(object.status, evidence.length ? "有依据" : "待确认"),
      evidence,
      relations,
      pending,
      facts,
      searchText: [label, api, description, ...props.map((p) => `${text(p.displayName)} ${text(p.apiName)}`)].join(" "),
      attributes,
      gaps,
    });
  });

  const workflowRows = rows(flow?.workflows);
  // 与 processCount 同一套判据：有 workflows 用它，没有就退到 stages
  const processRows = workflowRows.length > 0 ? workflowRows : rows(flow?.stages);
  processRows.forEach((process, index) => {
    const label = text(process.title) || text(process.label) || `未命名流程 ${index + 1}`;
    const api = text(process.key) || text(process.rid) || `process:${index}`;
    const stageKey = text(process.key);
    const entryRefs = [text(process.entry), ...rows(process.exits).map(String)].filter(Boolean);
    const scopedNodes = workflowRows.length
      ? flowNodes.filter((node) => entryRefs.includes(text(node.rid)))
      : flowNodes.filter((node) => text(node.stage) === stageKey);
    const usefulNodes = scopedNodes.length ? scopedNodes : (workflowRows.length ? [] : flowNodes);
    const objectRefs = [...new Set(usefulNodes.flatMap((node) => refsFor(node)))];
    const evidence = dedupeEvidence([
      ...usefulNodes.flatMap((node) => evidenceOf(node.label, node.actor, node.evidence)),
      ...rows(flow?.edges)
        .filter((edge) => entryRefs.includes(text(edge.from)) || entryRefs.includes(text(edge.to)))
        .flatMap((edge) => evidenceOf(edge.evidence)),
    ]);
    const refs = [api, label, ...entryRefs];
    const pending = questions.filter((q) => questionMatches(q, refs, label, api));
    const inferred = usefulNodes.filter((node) => node.grounded === false).length;
    // 真正能指导动作的数字后端早就算好了，只是从没上过屏：
    // 实测 bafd0dd05e69 是 terminals:0 / dead_ends:2 —— 这张流程图没有终态、有两个死端。
    // 而屏幕上那三个数字里，「无直接依据节点」恒等于「节点」（grounded 全 false）、
    // 「业务对象」恒为 0，等于两个常量加一个重复。
    const fstats = flow?.stats ?? {};
    const terminals = Number(fstats.terminals ?? usefulNodes.filter(
      (n) => text(n.kind ?? n.type).toLocaleLowerCase() === "terminal").length);
    const deadEnds = Number(fstats.dead_ends ?? 0);
    const processGaps: GapRef[] = [];
    if (usefulNodes.length > 0 && terminals === 0) {
      processGaps.push({ label: uiText("无终态", "no terminal"), prompt: gapPrompt(label, "terminal") });
    }
    if (deadEnds > 0) {
      processGaps.push({
        label: uiText(`${deadEnds} 个死端`, `${deadEnds} dead ends`),
        prompt: gapPrompt(label, "deadEnd"),
      });
    }
    if (usefulNodes.length > 0 && objectRefs.length === 0) {
      processGaps.push({ label: uiText("节点未绑对象", "nodes unbound"), prompt: gapPrompt(label, "nodeObjects") });
    }
    items.push({
      id: `process:${api}`,
      kind: "process",
      label,
      api,
      description: text(process.description || process.subtitle) || (usefulNodes.length
        ? `包含 ${usefulNodes.length} 个流程节点。`
        : "流程边界已识别，节点仍需补充或确认。"),
      status: inferred ? "待确认" : (evidence.length ? "有依据" : "草稿"),
      evidence,
      relations: objectRefs.map((ref) => ({ label: objectLabel(ref), meta: "业务对象", targetId: ref })),
      pending,
      // 恒为常量的两个换成 flow.stats 里真的会变的判定量。
      // 「无直接依据节点」在 100% 未接地时不占位（那是已知的全局状态，不是这条流程的特征）。
      facts: [
        ["节点", String(usefulNodes.length)],
        ["终态", String(terminals)],
        ...(inferred > 0 && inferred < usefulNodes.length
          ? [["无直接依据节点", String(inferred)] as [string, string]] : []),
      ],
      searchText: [label, api, text(process.description), ...usefulNodes.map((node) => text(node.label))].join(" "),
      attributes: [],
      gaps: processGaps,
    });
  });

  rules.forEach((rule, index) => {
    const label = text(rule.statement) || `未命名规则 ${index + 1}`;
    const api = text(rule.rid) || `rule:${index}`;
    const objectRefs = refsFor(rule);
    const evidence = evidenceOf(rule.statement, rule.ruleKind, rule.actor);
    const pending = questions.filter((q) => questionMatches(q, [api, ...objectRefs], label, api));
    // **只报有路可走的缺口。** 「无可判定条件」和「未分类」也确实是真缺
    // （40/40 条规则只有一句自由文本），但 OIR 没有条件字段、ruleKind 也不在
    // EDITABLE 里 —— 报了也补不了。指着不存在的能力比不报更糟，那是今天刚学的一课。
    const ruleGaps: GapRef[] = [];
    if (objectRefs.length === 0) {
      ruleGaps.push({ label: uiText("未绑对象", "not scoped"), prompt: gapPrompt(label, "ruleScope") });
    }
    if (!text(rule.actor) && ["AUTHORITY", "PROCESS"].includes(text(rule.ruleKind).toUpperCase())) {
      ruleGaps.push({ label: uiText("无执行角色", "no actor"), prompt: gapPrompt(label, "ruleActor") });
    }
    // 这两条以前故意不报 —— OIR 没有条件字段、ruleKind 也不在 EDITABLE 里，
    // 报了也补不了。现在两条路都通了（BusinessRule.condition + EDITABLE.kind），
    // 才把它们放出来。**先有能力，再有提示。**
    if (!text(rule.condition)) {
      ruleGaps.push({ label: uiText("无可判定条件", "not judgeable"), prompt: gapPrompt(label, "ruleCondition") });
    }
    if (!text(rule.ruleKind) || text(rule.ruleKind).toUpperCase() === "OTHER") {
      ruleGaps.push({ label: uiText("未分类", "unclassified"), prompt: gapPrompt(label, "ruleKind") });
    }
    items.push({
      id: api,
      kind: "rule",
      label,
      api,
      description: [text(rule.ruleKind), text(rule.actor) && `执行角色：${text(rule.actor)}`].filter(Boolean).join(" · ")
        || "规则分类和执行角色仍需补充。",
      status: text(rule.status, evidence.length ? "有依据" : "待确认"),
      evidence,
      relations: objectRefs.map((ref) => ({ label: objectLabel(ref), meta: "约束对象", targetId: ref })),
      pending,
      facts: [
        ["规则类型", text(rule.ruleKind, "未分类")],
        ...(text(rule.actor) ? [["执行角色", text(rule.actor)] as [string, string]] : []),
        ...(text(rule.condition) ? [["判定条件", text(rule.condition)] as [string, string]] : []),
      ],
      searchText: [label, api, text(rule.ruleKind), text(rule.actor), ...objectRefs].join(" "),
      attributes: [],
      gaps: ruleGaps,
    });
  });

  actions.forEach((action, index) => {
    const label = text(action.displayName) || text(action.apiName) || `未命名 Action ${index + 1}`;
    const api = text(action.apiName) || text(action.rid) || `action:${index}`;
    const objectRefs = refsFor(action);
    const effects = rows(action.effects?.value ?? action.effects).map(String).filter(Boolean);
    const endpoint = action.sourceEndpoint?.value ?? action.sourceEndpoint;
    const endpointLabel = endpoint && typeof endpoint === "object"
      ? [text(endpoint.method), text(endpoint.path || endpoint.url)].filter(Boolean).join(" ")
      : text(endpoint);
    const evidence = evidenceOf(action.apiName, action.effects, action.parameters, action.sourceEndpoint);
    const params = rows(action.parameters?.value ?? action.parameters);
    const actionGaps: GapRef[] = [];
    if (params.length === 0) actionGaps.push({ label: uiText("缺入参", "no parameters"), prompt: gapPrompt(label, "parameters") });
    if (objectRefs.length === 0) actionGaps.push({ label: uiText("未绑定对象", "not bound to an object"), prompt: gapPrompt(label, "appliesTo") });
    const pending = questions.filter((q) => questionMatches(q, [api, ...objectRefs], label, api));
    items.push({
      id: text(action.rid) || `action:${api}`,
      kind: "action",
      label,
      api,
      description: effects.length ? effects.join("；") : (endpointLabel || uiText("这个动作的效果和调用入口仍需补充。", "Effects and entry point still missing.")),
      status: text(action.status, evidence.length ? "有依据" : "待确认"),
      evidence,
      relations: objectRefs.map((ref) => ({ label: objectLabel(ref), meta: "作用对象", targetId: ref })),
      pending,
      facts: [["作用对象", String(objectRefs.length)], [uiText("效果", "Effects"), String(effects.length)], ["来源接口", endpointLabel || "未识别"]],
      searchText: [label, api, endpointLabel, ...effects, ...objectRefs].join(" "),
      attributes: [],
      gaps: actionGaps,
    });
  });

  // ── 流程边是关系的第一来源 ────────────────────────────────
  // Event 详情原来只读 `producerAction` 这个语义字段：sketch/adopt 建出来的事件
  // 没有它，于是画布上边明明在、右栏却写「生产 Action：未识别」。边就是关系，
  // 从边上推 —— 这不是猜，是把已经存在的事实读出来。
  const nodeByRid = new Map(flowNodes.map((node) => [text(node.rid ?? node.id), node]));
  const flowEdges = rows(flow?.edges);
  const edgeProducerOf = (eventRid: string): string => {
    for (const edge of flowEdges) {
      if (text(edge.to ?? edge.target) !== eventRid) continue;
      const src = nodeByRid.get(text(edge.from ?? edge.source));
      if (src && ["action", "external"].includes(text(src.kind ?? src.type).toLocaleLowerCase())) {
        return text(src.label) || text(src.code);
      }
    }
    return "";
  };
  const edgeConsumersOf = (eventRid: string): string[] => {
    const out: string[] = [];
    for (const edge of flowEdges) {
      if (text(edge.from ?? edge.source) !== eventRid) continue;
      const dst = nodeByRid.get(text(edge.to ?? edge.target));
      if (dst && ["action", "external"].includes(text(dst.kind ?? dst.type).toLocaleLowerCase())) {
        const label = text(dst.label) || text(dst.code);
        if (label && !out.includes(label)) out.push(label);
      }
    }
    return out;
  };

  // 模型页的 Action 计数原来只数 oir.actions：通用草案的 action 全是流程节点，
  // 于是右栏写着「Action 0」而画布上明明站着七个 —— 和 Event 的兜底同一个待遇。
  if (actions.length === 0) {
    flowNodes
      .filter((node) => ["action", "external"].includes(text(node.kind ?? node.type).toLocaleLowerCase()))
      .forEach((node, index) => {
        const label = text(node.label) || text(node.code) || `${uiText("未命名 Action", "Unnamed Action")} ${index + 1}`;
        const api = text(node.code) || text(node.rid ?? node.id) || `flow-action:${index}`;
        const rid = text(node.rid ?? node.id);
        const evidence = evidenceOf(node.label, node.actor, node.evidence);
        // 这一条是从流程节点兜底出来的：模型里根本没有对应的 ActionType，
        // 所以缺口不是"缺入参"，是"还没进模型"。说准了人才知道该做什么。
        const actionGaps: GapRef[] = [{
          label: uiText("仅在流程图里", "flow-only"),
          prompt: `流程节点「${label}」还没有对应的 Action。把它建进模型：`
            + `写清楚执行角色、前置条件、入参，以及它作用在哪个业务对象上。`,
        }];
        const emits = flowEdges
          .filter((edge) => text(edge.from ?? edge.source) === rid)
          .map((edge) => nodeByRid.get(text(edge.to ?? edge.target)))
          .filter((dst) => dst && text(dst.kind ?? dst.type).toLocaleLowerCase() === "event")
          .map((dst) => text(dst!.label) || text(dst!.code))
          .filter(Boolean);
        items.push({
          id: rid || api,
          kind: "action",
          label,
          api,
          description: text(node.actor)
            ? uiText(`执行角色：${text(node.actor)}`, `Actor: ${text(node.actor)}`)
            : uiText("来自流程草案；契约细节（参数、前置条件、effects）待补。", "From the flow draft; contract details still needed."),
          status: text(node.status, nodeGroundedText(node, evidence)),
          evidence,
          relations: emits.map((name) => ({ label: name, meta: uiText("产生事件", "Emits event"), targetId: name })),
          pending: questions.filter((q) => questionMatches(q, [rid, api, label], label, api)),
          facts: [
            [uiText("执行角色", "Actor"), text(node.actor) || uiText("未指定", "Unset")],
            [uiText("产生事件", "Emits"), String(emits.length)],
            [uiText("所属阶段", "Stage"), text(node.stage) || uiText("未分阶段", "Unstaged")],
          ],
          searchText: [label, api, text(node.actor), ...emits].join(" "),
          attributes: [],
          gaps: actionGaps,
        });
      });
  }

  events.forEach((event, index) => {
    const label = text(event.displayName) || text(event.name) || text(event.label)
      || text(event.apiName) || text(event.code) || `${uiText("未命名 Event", "Unnamed Event")} ${index + 1}`;
    const api = text(event.apiName) || text(event.id) || text(event.rid) || text(event.code) || `event:${index}`;
    const objectRefs = [...new Set([
      ...refsFor(event),
      ...rows(event.objectIds).map(String),
      text(event.payload?.dataObject),
    ].filter(Boolean))];
    const evtRid = text(event.rid ?? event.id);
    const producer = text(event.producerAction) || edgeProducerOf(evtRid);
    const semanticConsumers = rows(event.consumers).map(String).filter(Boolean);
    const consumers = semanticConsumers.length > 0 ? semanticConsumers : edgeConsumersOf(evtRid);
    const evidence = evidenceOf(event.displayName, event.name, event.label, event.assertion, event.evidence);
    const refs = [api, label, producer, ...consumers, ...objectRefs].filter(Boolean);
    const pending = questions.filter((q) => questionMatches(q, refs, label, api));
    const eventGaps: GapRef[] = [];
    if (!producer) eventGaps.push({ label: uiText("无生产者", "no producer"), prompt: gapPrompt(label, "producer") });
    if (consumers.length === 0) eventGaps.push({ label: uiText("无下游", "no consumer"), prompt: gapPrompt(label, "consumer") });
    if (objectRefs.length === 0) eventGaps.push({ label: uiText("无载荷", "no payload"), prompt: gapPrompt(label, "payload") });
    const relations: RelationRef[] = [];
    if (producer) relations.push({ label: actionLabel(producer), meta: uiText("产生此事件", "Produces event"), targetId: producer });
    consumers.forEach((consumer) => relations.push({ label: actionLabel(consumer), meta: uiText("消费此事件", "Consumes event"), targetId: consumer }));
    objectRefs.forEach((ref) => relations.push({ label: objectLabel(ref), meta: uiText("事件载荷", "Event payload"), targetId: ref }));
    const description = text(event.description) || text(event.resultingState)
      || (producer ? uiText(`由 ${actionLabel(producer)} 产生。`, `Produced by ${actionLabel(producer)}.`)
        : uiText("事件生产者、载荷与消费者仍需补充。", "Producer, payload, and consumers still need confirmation."));
    items.push({
      id: api,
      kind: "event",
      label,
      api,
      description,
      status: text(event.status, evidence.length ? uiText("有依据", "Grounded") : uiText("待确认", "Pending")),
      evidence,
      relations,
      pending,
      // 三个「未识别 / 0 / 0」全都由缺口芯片承担了，facts 只留真有值的
      facts: [
        ...(producer ? [[uiText("生产 Action", "Producer Action"), actionLabel(producer)] as [string, string]] : []),
        ...(consumers.length ? [[uiText("消费 Actions", "Consumer Actions"), String(consumers.length)] as [string, string]] : []),
        ...(objectRefs.length ? [[uiText("载荷对象", "Payload objects"), String(objectRefs.length)] as [string, string]] : []),
      ],
      searchText: [label, api, description, producer, ...consumers, ...objectRefs].join(" "),
      attributes: [],
      gaps: eventGaps,
    });
  });

  return items;
}

function revisionOf(G: any, context?: ContextSidebarData | null): string {
  const value = context?.revision ?? G.S?.state?.ontology_package?.revision
    ?? G.S?.state?.artifact_revision ?? G.S?.state_version ?? G.S?.revision
    ?? G.S?.state?.revision?.id;
  if (value === undefined || value === null || value === "") return "当前快照";
  const raw = String(value).trim();
  if (!raw || ["0", "draft", "current", "当前快照"].includes(raw.toLocaleLowerCase())) return "当前快照";
  return `r${raw.replace(/^r/i, "")}`;
}

function sectionFromTab(tab: string): ContextSection | null {
  const map: Record<string, ContextSection> = {
    project: "project", evidence: "evidence", model: "model", review: "review", delivery: "delivery", runtime: "runtime",
    mat: "evidence", ent: "model", flow: "model", cf: "review", q: "review", art: "delivery", think: "runtime",
  };
  return map[tab] || null;
}

/**
 * 「询问此 X」。
 *
 * 三处都改了：
 *   ① `replace` → `insert`：上一版点一下就把人**半句没打完的话冲掉**，
 *      而「先打好问题、再点按钮挂上引用」正是最自然的用法；
 *   ② 文案不再是一行元数据（原来长这样：`引用画布节点「采购申请」（object；
 *      revision 1；node ot_a）`）—— 那不是一个问题，没有问号，发出去等于什么都没问，
 *      而且把 `ot_a` 这种内部 rid 和 `object` 这个英文枚举露给了业务向的用户；
 *   ③ 用 kindLabel 说人话，别管业务对象叫「画布节点」。
 *
 * 仍然调 focusCanvasNodeReference —— 画布高亮那个副作用是要的，只是不再把
 * 那行引用当成给人看的文案。
 */
function activateComposer(item: ModelItem): void {
  const reference = contextReferenceFromCanvasNode({
    nodeId: item.id,
    nodeType: item.kind,
    label: item.label,
    entityIds: [item.id],
    questionIds: item.pending.map((pending) => text(pending.id)).filter(Boolean),
    evidenceIds: item.evidence.map((evidence) => evidence.cite).filter(Boolean),
  });
  focusCanvasNodeReference(reference);
  const what = kindLabel(item.kind);
  const name = item.api && item.api !== item.label ? `${item.label}（${item.api}）` : item.label;
  prefillComposer(`关于${what}「${name}」，我想确认：`, { mode: "insert" });
}

function EvidenceButtons({ evidence, limit = 5, onOpen }: {
  evidence: EvidenceRef[];
  limit?: number;
  onOpen?: (evidence: EvidenceRef) => void;
}): ReactElement {
  if (!evidence.length) return <div className="ctx-empty-inline">暂无可定位的直接证据</div>;
  return <div className="ctx-evidence-list">
    {evidence.slice(0, limit).map((item, index) => (
      <button
        type="button"
        className="ctx-evidence"
        key={`${item.file}:${item.cite}:${index}`}
        onClick={() => {
          if (onOpen) onOpen(item);
          else void openSource(item.file, item.cite);
        }}
      >
        <span className="ctx-evidence-cite">查看出处 · {item.cite}</span>
        {item.snippet ? <span className="ctx-evidence-snippet">{item.snippet}</span> : null}
      </button>
    ))}
  </div>;
}

function SidebarEmpty({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <div className="ctx-empty" role="status">
    <div className="ctx-empty-label">{label}</div>
    <div className="ctx-empty-copy">{children}</div>
  </div>;
}

/** 一格能放下的最大长度：再长就把整行撑开，表也就不是表了。 */
const JSON_CELL_MAX = 160;
/** 一张表最多画多少行 —— 超出的在表名里说清楚，不假装全在这里。 */
const JSON_ROW_MAX = 500;

/** 一格的显示形态：标量原样；标量数组用顿号连；其余压成紧凑 JSON。 */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, JSON_CELL_MAX);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const flat = value.every((item) => item === null || typeof item !== "object");
    const s = flat ? value.map((item) => String(item ?? "")).join(", ") : JSON.stringify(value);
    return String(s).slice(0, JSON_CELL_MAX);
  }
  return JSON.stringify(value).slice(0, JSON_CELL_MAX);
}

function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0
    && value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

function sheetFromRows(name: string, rows_: Record<string, unknown>[]): ViewerSheet {
  // 列取并集、顺序按首次出现 —— 后面的行多带一个字段时不能把它丢掉。
  const columns: string[] = [];
  for (const row of rows_) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const shown = rows_.slice(0, JSON_ROW_MAX);
  return {
    name: rows_.length > shown.length ? `${name}（前 ${shown.length} / 共 ${rows_.length} 行）` : name,
    columns,
    rows: shown.map((row) => columns.map((column) => jsonCell(row[column]))),
  };
}

/**
 * 结构化 JSON → 可看的表。
 *
 * 产物里的 JSON（数据字典、问题清单）本来就是表：`{tables:[…], fields:[…]}`。
 * 以前一律 `JSON.stringify(value, null, 2)` 塞进正文 —— 用户在交付页看到的是
 * 一堵字符串墙（2026-08-25 用户截图）。这里只认**确定是表**的那一部分：顶层
 * 对象数组，或对象里值为对象数组的那些键。其余（标量、标量数组、嵌套对象）
 * 不硬凑成表，仍按原样的 JSON 正文看 —— 那才是它们的诚实形态。
 */
export function sheetsFromJson(value: unknown): ViewerSheet[] {
  if (isRowArray(value)) return [sheetFromRows("data", value)];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const out: ViewerSheet[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isRowArray(item)) out.push(sheetFromRows(key, item));
  }
  return out;
}

function ViewerTable({ sheet }: { sheet: ViewerSheet }): ReactElement {
  return <section className="ctx-viewer-sheet">
    <div className="ctx-section-title">{sheet.name} · {sheet.rows.length} {uiText("行", "rows")}</div>
    <div className="ctx-viewer-table-wrap" tabIndex={0}
      aria-label={uiText(`${sheet.name} 表格，可横向和纵向滚动`, `${sheet.name} table, scroll horizontally and vertically`)}>
      <table className="ctx-viewer-table">
        <thead><tr>{sheet.columns.map((column, index) => <th key={`${column}:${index}`}>{column}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex}>
          {sheet.columns.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] || ""}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

/** @internal 导出仅供测试：布局是"看起来对不对"的东西，但**交叉数**和
 *  **环上的节点有没有被丢掉**是可量化的，值得钉住。 */
export function graphRows(
  flow: any, oir: any, mode: "workflow" | "objects", questions: any[], remote: any = null, columns = 4,
  direction: CanvasLayoutDirection = "LR",
): {
  nodes: CanvasNode[]; edges: CanvasEdge[];
} {
  // Workflow 画布只展示真正进入 FlowGraph 的节点。`ontologyActions/events` 是模型
  // 全量目录，里面可能有上百个尚未映射到任何 workflow 的候选项；把它们直接并入
  // 画布会让“适配”缩到个位数百分比，而且视觉上会误导为这些 Action 已经串进流程。
  // 只有在后端尚未形成 FlowGraph nodes 时，才用全量 Ontology 项作为草案降级视图。
  const remoteFlowNodes = rows(remote?.nodes);
  const remoteGraphNodes = remoteFlowNodes.length > 0
    ? remoteFlowNodes
    : [...rows(remote?.ontologyActions), ...rows(remote?.events)];
  const seenRemoteIds = new Set<string>();
  const distinctRemoteNodes = remoteGraphNodes.filter((node, index) => {
    const id = text(node?.id || node?.rid || node?.code || node?.apiName, `remote:${index}`);
    if (seenRemoteIds.has(id)) return false;
    seenRemoteIds.add(id);
    return true;
  });
  const hasRemoteGraph = distinctRemoteNodes.length > 0 || rows(remote?.workflows).length > 0 || rows(remote?.edges).length > 0;
  const graphFlow = mode === "workflow" && hasRemoteGraph
    ? { workflows: rows(remote.workflows), nodes: distinctRemoteNodes, edges: rows(remote.edges) }
    : flow;
  const remoteEvidence = new Map(rows(remote?.evidence).map((item) => [text(item.id), item]));
  const questionsById = new Map(questions.map((question) => [text(question.id), question]));
  const rawNodes: CanvasNode[] = [];
  const rawEdges: CanvasEdge[] = [];
  if (mode === "objects") {
    rows(oir?.objects).forEach((object, index) => {
      const id = text(object.rid || object.apiName, `object:${index}`);
      const label = text(object.displayName || object.apiName, `对象 ${index + 1}`);
      const refs = [id, text(object.apiName), label].filter(Boolean);
      rawNodes.push({
        id,
        label,
        code: text(object.apiName),
        kind: "object",
        stage: "对象关系",
        grounded: evidenceOf(object.displayName, object.apiName, object.description).length > 0,
        evidence: evidenceOf(object.displayName, object.apiName, object.description),
        pending: questions.filter((question) => questionMatches(question, refs, label, text(object.apiName))),
        raw: object,
        x: 0,
        y: 0,
      });
    });
    rows(oir?.links).forEach((link, index) => rawEdges.push({
      id: text(link.rid, `link:${index}`),
      source: text(link.from),
      target: text(link.to),
      label: text(link.apiName || link.cardinality, "关联"),
      kind: "link",
      grounded: evidenceOf(link.apiName, link.cardinality, link.joinKey).length > 0,
    }));
  } else {
    rows(graphFlow?.workflows).forEach((workflow, index) => {
      const key = text(workflow.key || workflow.id || workflow.rid, `workflow:${index}`);
      const id = `workflow:${key}`;
      rawNodes.push({
        id,
        label: text(workflow.title, `Workflow ${index + 1}`),
        code: key,
        kind: "workflow",
        stage: "Workflow",
        grounded: true,
        evidence: evidenceOf(workflow.evidence, rows(workflow.evidenceIds).map((evId) => remoteEvidence.get(text(evId)))),
        pending: [...rows(workflow.questionIds).map((questionId) => questionsById.get(text(questionId))).filter(Boolean),
          ...questions.filter((question) => questionMatches(question, [key, id], text(workflow.title), key))],
        raw: workflow,
        x: 0,
        y: 0,
      });
      const entry = text(workflow.entry);
      if (entry) rawEdges.push({
        id: `${id}:${entry}`,
        source: id,
        target: entry,
        label: "入口",
        kind: "workflow",
        grounded: true,
      });
    });
    rows(graphFlow?.nodes).forEach((node, index) => {
      const id = text(node.id || node.rid || node.code || node.apiName, `node:${index}`);
      const label = text(node.label || node.code || node.apiName, `节点 ${index + 1}`);
      const refs = [id, text(node.code || node.apiName), ...refsFor(node),
        ...rows(node.objectIds), ...rows(node.relatedIds)].map(String).filter(Boolean);
      const evidence = evidenceOf(node.label, node.actor, node.evidence,
        rows(node.evidenceIds).map((evId) => remoteEvidence.get(text(evId))));
      rawNodes.push({
        id,
        label,
        code: text(node.code || node.apiName),
        kind: text(node.kind || node.type, "action").toLocaleLowerCase(),
        stage: text(node.stage, ["action", "event"].includes(text(node.kind || node.type).toLocaleLowerCase()) ? "Ontology" : "未分阶段"),
        grounded: node.grounded === undefined ? evidence.length > 0 : Boolean(node.grounded),
        evidence,
        pending: [...rows(node.questionIds).map((questionId) => questionsById.get(text(questionId))).filter(Boolean),
          ...questions.filter((question) => questionMatches(question, refs, label, text(node.code)))],
        raw: node,
        x: 0,
        y: 0,
      });
    });
    rows(graphFlow?.edges).forEach((edge, index) => rawEdges.push({
      id: text(edge.id || edge.rid, `edge:${index}`),
      source: text(edge.from || edge.source),
      target: text(edge.to || edge.target),
      label: text(edge.label),
      kind: text(edge.kind || edge.type, "flow"),
      grounded: edge.grounded === undefined ? evidenceOf(edge.evidence).length > 0 : Boolean(edge.grounded),
    }));
    rows(graphFlow?.nodes).forEach((node, nodeIndex) => {
      const source = text(node.id || node.rid || node.code || node.apiName, `node:${nodeIndex}`);
      rows(node.relatedIds).forEach((relatedId, relatedIndex) => rawEdges.push({
        id: `relation:${source}:${text(relatedId)}:${relatedIndex}`,
        source,
        target: text(relatedId),
        label: "关联",
        kind: "relation",
        grounded: Boolean(node.grounded),
      }));
    });
  }

  const byReference = new Map<string, string>();
  for (const node of rawNodes) {
    for (const value of [node.id, node.code, node.label, text(node.raw?.apiName), text(node.raw?.id), text(node.raw?.rid)].filter(Boolean)) {
      if (!byReference.has(value)) byReference.set(value, node.id);
    }
  }
  const edges = rawEdges.map((edge) => ({
    ...edge,
    source: byReference.get(edge.source) || edge.source,
    target: byReference.get(edge.target) || edge.target,
  })).filter((edge) => byReference.has(edge.source) || rawNodes.some((node) => node.id === edge.source))
    .filter((edge) => byReference.has(edge.target) || rawNodes.some((node) => node.id === edge.target));

  const nodeIds = new Set(rawNodes.map((node) => node.id));
  const real = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const connectedIds = new Set<string>();
  for (const e of real) { connectedIds.add(e.source); connectedIds.add(e.target); }

  // ── 分层布局 ────────────────────────────────────────────────
  //
  // 以前这里是「Kahn 拓扑排序 + stage 决定纵坐标」，三处出问题：
  //
  //  1. **遇到环就停。** 业务流程里「驳回 → 重新提交」是常态，环上的节点永远
  //     入度不为零，于是全被当成孤儿丢进底部网格 —— 画布上一半的流程散在下面，
  //     和主干断开。这是"太嘈杂"最主要的来源。
  //  2. **stage 直接进 y 坐标。** 阶段是业务分组，不是流程位置；让它决定纵坐标
  //     会把一条流转的相邻两步甩到相隔一两百像素，边只能斜着长距离穿过去。
  //  3. **同层内按遭遇顺序摆。** 没有任何减少交叉的处理，边自然乱成一片。
  //
  // 现在按 Sugiyama 的三步来：断环 → 定层 → 层内排序（重心法）。全是确定性的，
  // 同一份流程每次画出来一模一样。

  // 第一步：断环。DFS 找回边，**只在定层时忽略它们**，画布上照样画出来 ——
  // 回路是真实存在的业务事实，不能因为不好排版就不显示。
  const out = new Map<string, string[]>();
  for (const e of real) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const back = new Set<string>();
  const state = new Map<string, number>(); // 0=未访问 1=在栈上 2=完成
  const dfs = (id: string): void => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      const st = state.get(t) ?? 0;
      if (st === 1) back.add(`${id}\u0000${t}`);   // 指回栈上的节点 = 回边
      else if (st === 0) dfs(t);
    }
    state.set(id, 2);
  };
  // 从入度小的开始 DFS，让"真正的起点"先定下来，回边判定才稳定。
  //
  // 并列时按**节点在原列表里的顺序**，不是按 id 码点序。纯回路（提交→审批→驳回
  // →修改→提交）里每个节点入度都是 1，没有天然起点；按码点序挑的话「修改」会
  // 因为汉字编码碰巧最小而被排到最左边，读起来像是流程从"修改"开始的。
  // 抽取器是按流程顺序吐节点的，那个顺序比码点序有意义得多。
  const indeg = new Map(rawNodes.map((n) => [n.id, 0]));
  for (const e of real) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const docOrder = new Map(rawNodes.map((n, i) => [n.id, i]));
  const roots = rawNodes.map((n) => n.id)
    .sort((a, b) => (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0)
      || (docOrder.get(a) ?? 0) - (docOrder.get(b) ?? 0));
  for (const id of roots) if ((state.get(id) ?? 0) === 0) dfs(id);
  const fwd = real.filter((e) => !back.has(`${e.source}\u0000${e.target}`));

  // 第二步：定层 —— 最长路径。**每个节点都有层**，不再有"排不进去"的。
  const fwdOut = new Map<string, string[]>();
  const fwdIn = new Map<string, string[]>();
  for (const e of fwd) {
    fwdOut.set(e.source, [...(fwdOut.get(e.source) ?? []), e.target]);
    fwdIn.set(e.target, [...(fwdIn.get(e.target) ?? []), e.source]);
  }
  const rank = new Map<string, number>();
  const rankOf = (id: string, seen: Set<string>): number => {
    const got = rank.get(id);
    if (got !== undefined) return got;
    if (seen.has(id)) return 0;              // 断环之后不该发生，兜底防栈溢出
    seen.add(id);
    const ins = fwdIn.get(id) ?? [];
    const r = ins.length === 0 ? 0 : Math.max(...ins.map((p) => rankOf(p, seen) + 1));
    rank.set(id, r);
    return r;
  };
  for (const n of rawNodes) rankOf(n.id, new Set());

  // 第三步：层内排序 —— 重心法。初值按 stage 分组（同阶段的挨在一起读着顺），
  // 然后来回扫几遍，把每个节点挪到它邻居的平均位置附近。交叉数因此大幅下降，
  // 而且这是纯确定性的：同样的图每次得到同样的顺序。
  const stageOrder = [...new Set(rawNodes.map((n) => n.stage))];
  const byRank = new Map<number, string[]>();
  for (const n of [...rawNodes].sort((a, b) => {
    const sa = stageOrder.indexOf(a.stage), sb = stageOrder.indexOf(b.stage);
    return sa - sb || (a.id < b.id ? -1 : 1);
  })) {
    const r = rank.get(n.id) ?? 0;
    byRank.set(r, [...(byRank.get(r) ?? []), n.id]);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const posIn = new Map<string, number>();
  const reindex = (): void => {
    for (const r of ranks) (byRank.get(r) ?? []).forEach((id, k) => posIn.set(id, k));
  };
  reindex();
  const bary = (id: string, nbrs: Map<string, string[]>): number => {
    const list = nbrs.get(id) ?? [];
    if (!list.length) return posIn.get(id) ?? 0;
    return list.reduce((acc, x) => acc + (posIn.get(x) ?? 0), 0) / list.length;
  };
  // 四轮足够收敛；再多只是抖动。向下一轮 + 向上一轮为一组。
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const order = sweep % 2 === 0 ? ranks : [...ranks].reverse();
    const nbrs = sweep % 2 === 0 ? fwdIn : fwdOut;
    for (const r of order) {
      const list = [...(byRank.get(r) ?? [])];
      const score = new Map(list.map((id) => [id, bary(id, nbrs)]));
      // 并列时按原位置，保证稳定 —— 不然同一份图两次画出来不一样。
      list.sort((a, b) => (score.get(a)! - score.get(b)!)
        || ((posIn.get(a) ?? 0) - (posIn.get(b) ?? 0)));
      byRank.set(r, list);
    }
    reindex();
  }

  // 第四步：落坐标。方向只改变投影轴，不改节点、边、层级或业务 state：
  // LR 是「层 → 横轴、层内序 → 纵轴」，TB 则把两根轴对调。
  const COL = 214;
  const ROW = 92;
  const positioned = new Map<string, CanvasNode>();

  if (direction === "TB") {
    // 上到下模式优先服务右侧栏：同一层的并行节点横排；太多时按可用宽度换行，
    // 下一层一定排在上一层的完整包围盒之后，所以所有前向边都保持向下。
    const laneColumns = Math.max(1, columns);
    const maxLanes = Math.max(1, ...ranks.map((r) => Math.min(laneColumns, (byRank.get(r) ?? []).length)));
    let layerTop = 44;
    for (const r of ranks) {
      const list = byRank.get(r) ?? [];
      const rowCount = Math.max(1, Math.ceil(list.length / laneColumns));
      list.forEach((id, index) => {
        const node = rawNodes.find((candidate) => candidate.id === id);
        if (!node) return;
        const row = Math.floor(index / laneColumns);
        const rowSize = Math.min(laneColumns, list.length - row * laneColumns);
        const rowPad = ((maxLanes - rowSize) * COL) / 2;
        positioned.set(id, {
          ...node,
          x: 44 + rowPad + (index % laneColumns) * COL,
          y: layerTop + row * ROW,
        });
      });
      // 额外 44px 留给纵向贝塞尔边与标签，避免箭头贴住下一层节点。
      layerTop += rowCount * ROW + 44;
    }
  } else {
    // LR 是用户明确选择的阅读方向，不能因为侧栏窄就把每一层折回到 x=44；
    // 那会让一个 38 步主链看起来仍是竖排。world 可以远宽于 viewport，首次展示
    // 保持可读比例并从入口开始，用户可平移或点「适配」查看全貌。
    const tallest = Math.max(1, ...ranks.map((r) => (byRank.get(r) ?? []).length));
    ranks.forEach((r, index) => {
      const list = byRank.get(r) ?? [];
      const pad = ((tallest - list.length) * ROW) / 2;
      list.forEach((id, k) => {
        const node = rawNodes.find((n) => n.id === id);
        if (node) {
          positioned.set(id, {
            ...node,
            x: 44 + index * COL,
            y: 50 + pad + k * ROW,
          });
        }
      });
    });
  }

  // 一条边都没有的节点单独放到下面 —— 它们和流程没有关系，混在层里只会挤乱它。
  const overflowNodes = rawNodes.filter((n) => !connectedIds.has(n.id));
  for (const n of overflowNodes) positioned.delete(n.id);
  const layeredBottom = Math.max(0, ...[...positioned.values()].map((node) => node.y + NODE_HEIGHT));
  const orphanStart = layeredBottom ? layeredBottom + 54 : 50;
  // 列数跟着视口走。写死 4 列时，一条 434px 的右栏要塞下 4×214px，只能缩到 44%
  // 才看得全 —— 于是节点小到读不出字，而画布上下还空着一大片。
  const orphanColumns = Math.max(1, Math.min(columns, overflowNodes.length));
  overflowNodes.forEach((node, index) => {
    positioned.set(node.id, {
      ...node,
      x: 44 + (index % orphanColumns) * COL,
      y: orphanStart + Math.floor(index / orphanColumns) * 104,
    });
  });
  const nodes = rawNodes.map((node) => positioned.get(node.id) || node);
  return { nodes, edges };
}

function WorkflowCanvas({ target, graphData, questions, onEvidence, onReview }: {
  target: ContextViewerTarget;
  graphData?: any;
  questions: any[];
  onEvidence: (evidence: EvidenceRef) => void;
  onReview: (id: string) => void;
}): ReactElement {
  // 打开的是一个对象，就该落在「对象关系」模式 —— 停在工作流模式等于给了他
  // 一张跟他选的东西无关的图，还得自己在几十个节点里找。
  const [mode, setMode] = useState<"workflow" | "objects">(
    text(target.graphMode) === "objects" ? "objects" : "workflow");
  const sessionId = text(STATE.S?.id, "local");
  const [layoutDirection, setLayoutDirection] = useState<CanvasLayoutDirection>(
    () => savedCanvasLayout(sessionId));
  // 用户显式选过方向没有？没选过的话，等量到视口尺寸后按容器形状定一次默认。
  // 存的是"挂载时有没有偏好"，不是每帧去读 —— 用户点了方向按钮之后
  // rememberCanvasLayout 会写进 localStorage，这里必须不再插手。
  const hadSavedLayoutRef = useRef<boolean | null>(null);
  if (hadSavedLayoutRef.current === null) {
    try { hadSavedLayoutRef.current = localStorage.getItem(canvasLayoutKey(sessionId)) !== null; }
    catch { hadSavedLayoutRef.current = true; } // 读不到就当作有，别自作主张
  }
  const autoDirectionRef = useRef(false);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 18, y: 18 });
  const [selectedId, setSelectedId] = useState(target.selectedId || "");
  const [full, setFull] = useState(false);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [drafts, setDrafts] = useState<CanvasEdge[]>([]);
  const [linking, setLinking] = useState<{ source: string; x: number; y: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const nodeDragRef = useRef<{ id: string; x: number; y: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const linkRef = useRef("");
  const skipClickRef = useRef(false);
  const fittedKeyRef = useRef("");
  const [viewWidth, setViewWidth] = useState(0);
  const columns = Math.max(1, Math.min(4, Math.floor((viewWidth || 760) / 214)));
  const sketchGraph = target.sketch?.graph && typeof target.sketch.graph === "object"
    ? target.sketch.graph
    : {};
  // `flow.sketch` 有意不写 state.flow。正式流程为空时仍应让用户看见刚生成的
  // 结构，但只能作为只读参考层：不挂 evidence/question，不开放画布连线，也不
  // 改模型计数。等 draft.adopt 明确转正后，下一次 state 快照自然切回正式 Flow。
  const referencePreview = mode === "workflow"
    && !hasWorkflowStructure(target.flow)
    && hasWorkflowStructure(sketchGraph);
  const builtGraph = graphRows(
    target.flow || {}, target.oir || {}, mode, questions,
    referencePreview ? sketchGraph : graphData, columns, layoutDirection,
  );
  const graph = referencePreview ? {
    nodes: builtGraph.nodes.map((node) => ({
      ...node, grounded: false, evidence: [], pending: [],
    })),
    edges: builtGraph.edges.map((edge) => ({ ...edge, grounded: false })),
  } : builtGraph;
  const kinds = [...new Set(graph.nodes.map((node) => node.kind))];
  // 布局仍由拓扑决定；手工拖动只叠加一层位移，因此重新计算图不会把人摆好的位置冲掉。
  const placed = graph.nodes.map((node) => {
    const offset = offsets[node.id];
    return offset ? { ...node, x: node.x + offset.x, y: node.y + offset.y } : node;
  });
  const nodes = placed.filter((node) => !hiddenKinds.has(node.kind));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const draftEdges = referencePreview
    ? []
    : drafts.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const drawnEdges = [...edges, ...draftEdges];
  const width = Math.max(760, ...nodes.map((node) => node.x + 220));
  const height = Math.max(460, ...nodes.map((node) => node.y + 120));
  const selected = placed.find((node) => node.id === selectedId) || null;
  const labelOf = (id: string): string => placed.find((node) => node.id === id)?.label || id;

  const switchMode = (next: "workflow" | "objects"): void => {
    setMode(next);
    if (!selectedId) return;
    // 新模式下还画得出这个节点就留着；画不出才清 —— 保住"从右栏带进来的那一个"
    const nextGraph = graphRows(
      target.flow || {}, target.oir || {}, next, questions, graphData, columns, layoutDirection);
    if (!nextGraph.nodes.some((node) => node.id === selectedId)) setSelectedId("");
  };

  const switchLayout = (next: CanvasLayoutDirection): void => {
    if (next === layoutDirection) return;
    rememberCanvasLayout(sessionId, next);
    setLayoutDirection(next);
    // 拖拽偏移基于旧坐标系；方向改变后清掉视图偏移才能得到一张干净的自动排版。
    // drafts 只存端点 id，与坐标无关，继续保留。
    setOffsets({});
    linkRef.current = "";
    setLinking(null);
    fittedKeyRef.current = "";
  };

  const layoutSessionRef = useRef(sessionId);
  useEffect(() => {
    if (layoutSessionRef.current === sessionId) return;
    layoutSessionRef.current = sessionId;
    setLayoutDirection(savedCanvasLayout(sessionId));
    setOffsets({});
    fittedKeyRef.current = "";
  }, [sessionId]);

  // target 换了（右栏又点了一项）就跟着换选中项，而不是停在上一次那个
  const lastTargetSelection = useRef(target.selectedId || "");
  useEffect(() => {
    const next = target.selectedId || "";
    if (next === lastTargetSelection.current) return;
    lastTargetSelection.current = next;
    if (next) setSelectedId(next);
  }, [target.selectedId]);
  const layoutKey = `${mode}:${layoutDirection}:${graph.nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join("|")}`;

  /**
   * 适配算的是**节点真实的包围盒**，不是 world 的尺寸。world 为了留出拖拽空间
   * 带了 220/120 的边距和 760×460 的下限；拿它去适配，一张 810×166 的图会被当成
   * 906×460 来缩 —— 结果是横向刚好、纵向空掉八成，字还小到读不出来。
   */
  function fit(options: { minZoom?: number; keepReadable?: boolean } = {}): boolean {
    const viewport = viewportRef.current;
    if (!viewport) return false;
    const box = viewport as any;
    const viewportWidth = Number(box.clientWidth || 0);
    const viewportHeight = Number(box.clientHeight || 0);
    if (viewportWidth < 40 || viewportHeight < 40 || !nodes.length) return false;
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const contentWidth = Math.max(1, Math.max(...nodes.map((node) => node.x + NODE_WIDTH)) - left);
    const contentHeight = Math.max(1, Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) - top);
    const natural = Math.min((viewportWidth - 40) / contentWidth, (viewportHeight - 40) / contentHeight);
    const minZoom = Math.max(.03, options.minZoom ?? .03);
    const next = Math.min(1, Math.max(minZoom, natural));
    if (!Number.isFinite(next) || next <= 0) return false;
    setZoom(next);
    if (options.keepReadable && natural < minZoom) {
      const focus = nodes.find((node) => node.id === selectedId);
      // 侧栏里把十几个节点硬塞成 20% 等于“全看见、全读不出”。首次展示保住
      // 60% 可读比例：从流程入口开始，若用户是从某个对象点进来的则居中那一项。
      setPan({
        x: focus
          ? viewportWidth / 2 - (focus.x + NODE_WIDTH / 2) * next
          : 18 - left * next,
        y: focus
          ? viewportHeight / 2 - (focus.y + NODE_HEIGHT / 2) * next
          : (viewportHeight - contentHeight * next) / 2 - top * next,
      });
    } else {
      setPan({
        x: (viewportWidth - contentWidth * next) / 2 - left * next,
        y: (viewportHeight - contentHeight * next) / 2 - top * next,
      });
    }
    return true;
  }

  useEffect(() => {
    const canvas: any = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(1, (globalThis as any).devicePixelRatio || 1);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const drawing: any = canvas.getContext("2d");
    if (!drawing) return;
    drawing.scale(ratio, ratio);
    drawing.clearRect(0, 0, width, height);
    // 颜色从主题变量读，读不到再退回内置值 —— 深色主题下写死的灰会糊在背景里。
    const themed = (name: string, fallback: string): string => {
      const compute = (globalThis as any).getComputedStyle;
      if (typeof compute !== "function" || !viewportRef.current) return fallback;
      return String(compute(viewportRef.current).getPropertyValue(name) || "").trim() || fallback;
    };
    const solid = themed("--ink-3", "#8d938e");
    const guess = themed("--warn", "#b88a31");
    const proposed = themed("--accent", "#c2683c");
    const link = (x1: number, y1: number, x2: number, y2: number, color: string, dash: number[]): void => {
      const vertical = layoutDirection === "TB";
      const delta = vertical ? y2 - y1 : x2 - x1;
      const sign = delta < 0 ? -1 : 1;
      const curve = Math.max(36, Math.abs(delta) * .42);
      drawing.beginPath();
      drawing.moveTo(x1, y1);
      if (vertical) drawing.bezierCurveTo(x1, y1 + curve * sign, x2, y2 - curve * sign, x2, y2);
      else drawing.bezierCurveTo(x1 + curve * sign, y1, x2 - curve * sign, y2, x2, y2);
      drawing.strokeStyle = color;
      drawing.lineWidth = 1.3;
      drawing.setLineDash(dash);
      drawing.stroke();
      drawing.setLineDash([]);
      drawing.beginPath();
      drawing.moveTo(x2, y2);
      if (vertical) {
        drawing.lineTo(x2 - 4, y2 - 8 * sign);
        drawing.lineTo(x2 + 4, y2 - 8 * sign);
      } else {
        drawing.lineTo(x2 - 8 * sign, y2 - 4);
        drawing.lineTo(x2 - 8 * sign, y2 + 4);
      }
      drawing.closePath();
      drawing.fillStyle = color;
      drawing.fill();
    };
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of drawnEdges) {
      const source = byId.get(edge.source), targetNode = byId.get(edge.target);
      if (!source || !targetNode) continue;
      const x1 = layoutDirection === "TB" ? source.x + NODE_PORT_X : source.x + NODE_WIDTH;
      const y1 = layoutDirection === "TB" ? source.y + NODE_HEIGHT : source.y + NODE_PORT_Y;
      const x2 = layoutDirection === "TB" ? targetNode.x + NODE_PORT_X : targetNode.x;
      const y2 = layoutDirection === "TB" ? targetNode.y : targetNode.y + NODE_PORT_Y;
      const color = edge.kind === "draft" ? proposed : edge.grounded ? solid : guess;
      link(x1, y1, x2, y2, color, edge.grounded && edge.kind !== "draft" ? [] : [6, 5]);
      if (edge.label) {
        drawing.font = "11px sans-serif";
        drawing.fillStyle = color;
        drawing.fillText(edge.label.slice(0, 24), (x1 + x2) / 2, (y1 + y2) / 2 - 6);
      }
    }
    if (linking) {
      const source = byId.get(linking.source);
      if (source) link(
        layoutDirection === "TB" ? source.x + NODE_PORT_X : source.x + NODE_WIDTH,
        layoutDirection === "TB" ? source.y + NODE_HEIGHT : source.y + NODE_PORT_Y,
        linking.x, linking.y, proposed, [4, 4]);
    }
  }, [nodes.map((node) => `${node.id}:${node.x}:${node.y}`).join("|"),
    drawnEdges.map((edge) => edge.id).join("|"), linking, width, height, layoutDirection]);

  // 进出全屏后视口尺寸完全变了，所以 full 是适配键的一部分 —— 用一个单独的
  // effect 去清 fittedKeyRef 不行：effect 按声明顺序跑，清空发生在这次适配之后，
  // 全屏就会停在小窗时算出来的比例上。
  const fitKey = `${layoutKey}:${full}`;
  useEffect(() => {
    if (!graph.nodes.length || fittedKeyRef.current === fitKey) return;
    let active = true;
    const attempt = (): void => {
      if (!active) return;
      const measured = Number((viewportRef.current as any)?.clientWidth || 0);
      if (measured > 0) setViewWidth(measured);
      // 没保存过偏好时，按量到的**容器形状**定一次方向（只定一次）。
      // 侧栏窄而高：LR 会把线性流程排成 2308×46 的横条，适配只有 20% ——
      // 全看见、全读不出，正是"图没画出来"的症状。
      if (!hadSavedLayoutRef.current && !autoDirectionRef.current && measured > 0) {
        const h = Number((viewportRef.current as any)?.clientHeight || 0);
        if (h > 0) {
          autoDirectionRef.current = true;
          setLayoutDirection(defaultCanvasLayout({ width: measured, height: h }));
        }
      }
      if (fit({ minZoom: full ? .03 : .6, keepReadable: !full })) fittedKeyRef.current = fitKey;
    };
    const raf = (globalThis as any).requestAnimationFrame;
    const cancelRaf = (globalThis as any).cancelAnimationFrame;
    const frame = typeof raf === "function" ? raf(attempt) : (globalThis as any).setTimeout?.(attempt, 0);
    const Observer = (globalThis as any).ResizeObserver;
    const observer = typeof Observer === "function" ? new Observer(attempt) : null;
    if (viewportRef.current) observer?.observe(viewportRef.current);
    return () => {
      active = false;
      observer?.disconnect();
      if (typeof cancelRaf === "function" && typeof frame === "number") cancelRaf(frame);
      else if (typeof (globalThis as any).clearTimeout === "function") (globalThis as any).clearTimeout(frame);
    };
  }, [fitKey, width, height]);

  useEffect(() => {
    if (!full) return;
    const escape = (event: any): void => { if (event.key === "Escape") setFull(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [full]);

  const toggleKind = (kind: string): void => {
    const next = new Set(hiddenKinds);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    setHiddenKinds(next);
  };
  const toWorld = (event: any): { x: number; y: number } => {
    const box = viewportRef.current?.getBoundingClientRect?.();
    return {
      x: ((event.clientX || 0) - (box?.left || 0) - pan.x) / zoom,
      y: ((event.clientY || 0) - (box?.top || 0) - pan.y) / zoom,
    };
  };
  const startPan = (event: any): void => {
    if ((event.target as any)?.closest?.("button, .ctx-graph-node")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    (event.currentTarget as any).setPointerCapture?.(event.pointerId);
  };
  const movePan = (event: any): void => {
    if (linkRef.current) {
      const point = toWorld(event);
      setLinking((current) => (current ? { ...current, x: point.x, y: point.y } : current));
      return;
    }
    const start = dragRef.current;
    if (!start) return;
    setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
  };
  const endPointer = (): void => {
    dragRef.current = null;
    nodeDragRef.current = null;
    linkRef.current = "";
    setLinking(null);
  };
  const selectNode = (node: CanvasNode): void => {
    setSelectedId(node.id);
    focusCanvasNodeReference(contextReferenceFromCanvasNode({
      nodeId: node.id,
      nodeType: node.kind,
      label: node.label,
      entityIds: [...refsFor(node.raw), ...rows(node.raw?.objectIds), ...rows(node.raw?.relatedIds)],
      questionIds: node.pending.map((pending) => text(pending.id)).filter(Boolean),
      evidenceIds: node.evidence.map((evidence) => evidence.cite).filter(Boolean),
    }));
  };
  const startNodeDrag = (event: any, node: CanvasNode): void => {
    if ((event.target as any)?.classList?.contains?.("ctx-graph-port")) return;
    event.stopPropagation?.();
    const offset = offsets[node.id] || { x: 0, y: 0 };
    nodeDragRef.current = {
      id: node.id, x: event.clientX, y: event.clientY, baseX: offset.x, baseY: offset.y, moved: false,
    };
    (event.currentTarget as any)?.setPointerCapture?.(event.pointerId);
  };
  const moveNodeDrag = (event: any): void => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    const dx = ((event.clientX || 0) - drag.x) / zoom;
    const dy = ((event.clientY || 0) - drag.y) / zoom;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    setOffsets((current) => ({ ...current, [drag.id]: { x: drag.baseX + dx, y: drag.baseY + dy } }));
  };
  /**
   * 手工连线只产生一条**本地草案**并广播一条回执：画布没有写 Ontology 的权限，
   * 假装写进去了才是真正的谎。要落库仍然要走对话与 Question Ledger。
   */
  const addDraftLink = (sourceId: string, node: CanvasNode): void => {
    const source = placed.find((candidate) => candidate.id === sourceId);
    if (!source || source.id === node.id) return;
    const id = `draft:${sourceId}:${node.id}`;
    if (drafts.some((edge) => edge.id === id)) return;
    setDrafts((current) => [...current, {
      id, source: sourceId, target: node.id, kind: "draft", grounded: false,
      label: uiText("待确认", "Proposed"),
    }]);
    contextSyncStore.publish({
      type: "model.confirm",
      title: uiText(`新增关联建议：${source.label} → ${node.label}`, `Proposed link: ${source.label} → ${node.label}`),
      summary: uiText("画布手动连线，尚未写入 Ontology；请确认方向、基数与依据。",
        "Drawn on the canvas and not yet written to the Ontology; confirm direction, cardinality, and evidence."),
      canvasNodeIds: [sourceId, node.id],
    });
  };
  const endNodeDrag = (event: any, node: CanvasNode): void => {
    const source = linkRef.current;
    if (source && source !== node.id) {
      event.stopPropagation?.();
      addDraftLink(source, node);
      skipClickRef.current = true;
    }
    linkRef.current = "";
    setLinking(null);
    const drag = nodeDragRef.current;
    nodeDragRef.current = null;
    if (drag?.moved) skipClickRef.current = true;
  };
  const startLink = (event: any, node: CanvasNode): void => {
    event.stopPropagation?.();
    event.preventDefault?.();
    linkRef.current = node.id;
    setLinking({
      source: node.id,
      x: layoutDirection === "TB" ? node.x + NODE_PORT_X : node.x + NODE_WIDTH + 30,
      y: layoutDirection === "TB" ? node.y + NODE_HEIGHT + 30 : node.y + NODE_PORT_Y,
    });
  };
  const sendDraftsToChat = (): void => {
    const lines = drafts.map((edge) => `- ${labelOf(edge.source)} → ${labelOf(edge.target)}`);
    void sendContextToChat([
      uiText("我在工作流画布上手工连了以下关联，请确认是否成立：", "I drew these links on the workflow canvas; please confirm whether they hold:"),
      ...lines,
      uiText("请给出方向、基数、连接键与依据；成立的请更新模型，不成立的说明原因。",
        "Provide direction, cardinality, join key, and evidence; update the model for the valid ones and explain the rest."),
    ].join("\n"), {
      send: contextChatBridge.send, mode: "replace", focusSidebar: false,
    }).catch(() => { /* 对话没接上不影响画布上的草案 */ });
  };
  const adoptReferenceDraft = (): void => {
    const domain = text(target.sketch?.domain, uiText("当前业务场景", "the current business scenario"));
    prefillComposer([
      uiText(
        `请调用 draft.adopt，将右侧画布中的「${domain}」通用参考流程图转为正式 DRAFT。`,
        `Call draft.adopt to convert the generic “${domain}” reference shown on the right canvas into a formal DRAFT.`,
      ),
      uiText(
        "请沿用当前草图的阶段、节点和连线，不要重新生成；保留 generic_assumption / 非客户证据标记。转正后再更新右侧正式工作流画布。",
        "Reuse the current stages, nodes, and edges without regenerating them; retain the generic_assumption / non-customer-evidence marker, then update the formal workflow canvas.",
      ),
    ].join("\n"), { mode: "replace" });
  };

  if (!graph.nodes.length) return <SidebarEmpty label="WORKFLOW">
    {uiText("当前 Ontology 尚未形成可展示的 Workflow、Action、Event 或对象关系。", "This Ontology does not yet contain a viewable Workflow, Action, Event, or object relationship.")}
    <button type="button" className="act pri ctx-empty-action" onClick={() => {
      prefillComposer({
        schemaVersion: GENERIC_SCENARIO_DRAFT_SCHEMA,
        scenario: "",
        outputType: "Ontology",
      }, { mode: "replace" });
    }}>{uiText("从通用场景生成草案", "Draft from a generic scenario")}</button>
  </SidebarEmpty>;

  return <div
    className={`ctx-graph${full ? " ctx-graph-full" : ""}${referencePreview ? " ctx-graph-reference" : ""}`}
    data-reference-preview={referencePreview ? "true" : undefined}
    data-layout-direction={layoutDirection}
  >
    {referencePreview ? <section className="ctx-notice ctx-graph-notice ctx-sketch-reference-notice" role="status">
      <div className="ctx-graph-inspector-meta">
        <span className="ctx-badge warning">{uiText("通用参考", "Generic reference")}</span>
        <span className="ctx-badge warning">{uiText("未转正", "Not adopted")}</span>
        <span className="ctx-badge warning">{uiText("非客户证据", "Not customer evidence")}</span>
      </div>
      <p>{uiText(
        "这是模型通用知识生成的只读参考草图，仅供访谈核对；它尚未进入正式 Ontology、模型计数或交付产物。",
        "This read-only reference was generated from general model knowledge for interview validation. It is not part of the formal Ontology, model counts, or deliverables.",
      )}</p>
      <button type="button" className="act pri ctx-sketch-adopt" onClick={adoptReferenceDraft}>
        {uiText("转为 DRAFT", "Adopt as DRAFT")}
      </button>
    </section> : null}
    <div className="ctx-graph-toolbar">
      <div className="ctx-graph-switch" role="group" aria-label={uiText("画布视图", "Canvas view")}>
        {/* 切模式时**只在新模式下这个 id 不存在时才清空**。上一版无条件
            setSelectedId("")，于是从右栏带进来的选中项在切到「对象关系」的
            那一下当场被清掉 —— 而对象只在这个模式下才画得出来。 */}
        <button type="button" className={mode === "workflow" ? "on" : ""} onClick={() => switchMode("workflow")}>{uiText("工作流", "Workflow")}</button>
        <button type="button" className={mode === "objects" ? "on" : ""}
          disabled={referencePreview && rows(target.oir?.objects).length === 0}
          onClick={() => switchMode("objects")}>{uiText("对象关系", "Object relations")}</button>
      </div>
      <div className="ctx-graph-switch ctx-graph-direction" role="group"
        aria-label={uiText("排列方向", "Layout direction")}>
        <button type="button" className={layoutDirection === "TB" ? "on" : ""}
          aria-pressed={layoutDirection === "TB"}
          title={uiText("按流程顺序从上到下排列", "Arrange the process from top to bottom")}
          onClick={() => switchLayout("TB")}>{uiText("上到下", "Top to bottom")}</button>
        <button type="button" className={layoutDirection === "LR" ? "on" : ""}
          aria-pressed={layoutDirection === "LR"}
          title={uiText("按流程顺序从左到右排列", "Arrange the process from left to right")}
          onClick={() => switchLayout("LR")}>{uiText("左到右", "Left to right")}</button>
      </div>
      <div className="ctx-graph-zoom" role="group" aria-label={uiText("画布缩放", "Canvas zoom")}>
        <button type="button" onClick={() => setZoom(Math.max(.1, zoom - .15))}>{uiText("缩小", "Zoom out")}</button>
        <button type="button" onClick={() => { fit(); }}>{uiText("适配", "Fit")}</button>
        <button type="button" onClick={() => setZoom(Math.min(2, zoom + .15))}>{uiText("放大", "Zoom in")}</button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <div className="ctx-graph-zoom" role="group" aria-label={uiText("画布布局", "Canvas layout")}>
        <button type="button" disabled={!Object.keys(offsets).length}
          onClick={() => setOffsets({})}>{uiText("整理", "Reset layout")}</button>
        <button type="button" className="ctx-graph-fullscreen"
          onClick={() => setFull((open) => !open)}>{full ? uiText("退出全屏", "Exit full screen") : uiText("全屏", "Full screen")}</button>
      </div>
    </div>
    <div className="ctx-graph-layers" role="group" aria-label={uiText("图层筛选", "Layer filters")}>
      {kinds.map((kind) => <button type="button" className={hiddenKinds.has(kind) ? "" : "on"} key={kind} onClick={() => toggleKind(kind)}>
        <i className={`ctx-graph-swatch ${kind}`} aria-hidden="true"></i>{kind}
      </button>)}
    </div>
    {!edges.length && nodes.length > 1 ? <div className="ctx-notice ctx-graph-notice">
      {referencePreview
        ? uiText(
          `这份通用参考草图有 ${nodes.length} 个节点，但没有流程边；请先在访谈中核对，不会在只读预览里写入关联。`,
          `This generic reference has ${nodes.length} nodes but no flow edges. Validate it in the interview; the read-only preview will not write links.`,
        )
        : uiText(
          `这 ${nodes.length} 个节点之间还没有任何编排关系：Ontology 里只有 Action / Event 清单，没有流程边。可以从节点右侧端口手工连线提出建议，或在对话里要求补全编排。`,
          `These ${nodes.length} nodes have no orchestration between them — the Ontology holds Actions/Events but no flow edges. Drag from a node's right port to propose a link, or ask in chat to complete the orchestration.`,
        )}
    </div> : null}
    {draftEdges.length ? <div className="ctx-graph-drafts">
      <span className="ctx-graph-drafts-label">{uiText("待确认连线", "Proposed links")}</span>
      {draftEdges.map((edge) => <span className="ctx-graph-draft" key={edge.id}>
        {labelOf(edge.source)} → {labelOf(edge.target)}
        <button type="button" aria-label={uiText("删除待确认连线", "Remove proposed link")}
          onClick={() => setDrafts((current) => current.filter((item) => item.id !== edge.id))}>×</button>
      </span>)}
      <button type="button" className="ctx-inline-action" onClick={sendDraftsToChat}>{uiText("送去对话确认", "Confirm in chat")}</button>
    </div> : null}
    <div
      ref={viewportRef}
      className="ctx-graph-viewport"
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      title={referencePreview
        ? uiText("只读参考：拖动平移，滚轮缩放", "Read-only reference: drag to pan and use the wheel to zoom")
        : uiText("拖动平移，滚轮缩放；拖节点摆位；从输出端口拖出连线",
          "Drag to pan, wheel to zoom; drag nodes to arrange; drag from the output port to link")}
      onWheel={(event) => {
        // 滚轮默认缩放，但**绝不抢一次本来能生效的滚动**：只有外层确实滚不动
        // （或用户按住 Ctrl/⌘ 明确要缩放）时才吞掉它。以前是无条件 preventDefault，
        // 于是鼠标一停在画布上，整条侧栏就卡住不动。
        const outer = (event.currentTarget as any)?.closest?.(".ctx-body");
        const outerScrolls = Boolean(outer) && outer.scrollHeight > outer.clientHeight;
        if (outerScrolls && !event.ctrlKey && !event.metaKey && !full) return;
        event.preventDefault();
        setZoom(Math.max(.1, Math.min(2, zoom + (event.deltaY < 0 ? .1 : -.1))));
      }}
    >
      <div className="ctx-graph-world" style={{ width, height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <canvas ref={canvasRef} className="ctx-graph-edges" aria-hidden="true" />
        {nodes.map((node) => <div
          role="button"
          tabIndex={0}
          aria-pressed={selectedId === node.id}
          data-node-id={node.id}
          className={`ctx-graph-node ${node.kind} ${node.grounded ? "grounded" : "inferred"} ${selectedId === node.id ? "on" : ""}`}
          style={{ left: node.x, top: node.y }}
          key={node.id}
          onPointerDown={referencePreview ? undefined : (event) => startNodeDrag(event, node)}
          onPointerMove={referencePreview ? undefined : moveNodeDrag}
          onPointerUp={referencePreview ? undefined : (event) => endNodeDrag(event, node)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectNode(node);
          }}
          onClick={() => {
            if (skipClickRef.current) { skipClickRef.current = false; return; }
            selectNode(node);
          }}
        >
          <span className="ctx-graph-node-kind">{node.kind}</span>
          <strong>{node.label}</strong>
          <small>{node.code || node.stage}</small>
          {node.pending.length ? <span className="ctx-graph-node-flag"
            title={uiText(`${node.pending.length} 个待确认问题`, `${node.pending.length} open questions`)}>{node.pending.length}</span> : null}
          <span className="ctx-graph-port in" aria-hidden="true"></span>
          {!referencePreview ? <span
            className="ctx-graph-port out"
            role="button"
            aria-label={uiText(`从 ${node.label} 拖出关联`, `Draw a link from ${node.label}`)}
            title={uiText("拖到另一个节点建立关联", "Drag onto another node to link")}
            onPointerDown={(event) => startLink(event, node)}
          ></span> : null}
        </div>)}
      </div>
    </div>
    {selected ? <aside className="ctx-graph-inspector">
      <div className="ctx-eyebrow">{selected.kind}</div>
      <div className="ctx-detail-title">{selected.label}</div>
      <div className="ctx-detail-api">{selected.code || selected.id}</div>
      <div className="ctx-graph-inspector-meta">
        <span className={`ctx-badge ${selected.grounded ? "confirmed" : "warning"}`}>
          {referencePreview
            ? uiText("通用参考 · 非客户证据", "Generic reference · not customer evidence")
            : selected.grounded ? uiText("有直接依据", "Grounded") : uiText("系统推断", "Inferred")}
        </span>
        <span className="ctx-badge">{selected.stage}</span>
      </div>
      {text(selected.raw?.actor) ? <p className="ctx-description">{uiText("执行角色", "Actor")}: {text(selected.raw.actor)}</p> : null}
      <div className="ctx-actions">
        {selected.evidence[0] ? <button type="button" className="act" onClick={() => onEvidence(selected.evidence[0]!)}>{uiText("查看证据", "View evidence")}</button> : null}
        {selected.pending[0] ? <button type="button" className="act" onClick={() => onReview(text(selected.pending[0].id))}>{uiText("打开审阅", "Open review")}</button> : null}
      </div>
    </aside> : null}
  </div>;
}

/**
 * 正文预览 + **定位到那一条出处**。
 *
 * 「想确认一条断言的出处，从右栏几步能看到原文」—— 以前的答案是：
 * 一步打开，然后自己肉眼在整份文档里找那一句（一个 32 片段的 docx 就是 32 段）。
 * 而定位能力一直在仓库里活着：`ui/preview.ts:65-66` 的 openSource 就是
 * `querySelector([data-cite])` → `scrollIntoView({block:"center"})` → 加描边。
 * 新的 ContextViewer 没接它，把整份材料倒进 440px 一栏就完了。
 *
 * 这里按 **chunk** 渲染而不是把 text 拼成一坨：chunk 自带 cite，
 * 有了锚点才谈得上定位。没有 chunk 时退回按空行切段（老行为）。
 */
function ViewerProse({ chunks, body, cite, className }: {
  chunks: any[];
  body: string;
  cite: string;
  className: string;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const paragraphs = chunks.length > 0
    ? chunks.map((chunk, index) => ({ cite: text(chunk.cite), text: text(chunk.text), key: text(chunk.cite) || index }))
    : body.split(/\n{2,}/u).filter(Boolean).map((paragraph, index) => ({ cite: "", text: paragraph, key: index }));

  useEffect(() => {
    if (!cite) return;
    const host = hostRef.current;
    if (!host) return;
    // 属性选择器要转义 —— cite 里有 `!` 和 `-`，还可能有引号
    const escape = (globalThis as any).CSS?.escape ?? ((v: string) => v.replace(/["\\]/gu, "\\$&"));
    const hit = host.querySelector(`[data-cite="${escape(cite)}"]`);
    if (!hit) return;
    hit.scrollIntoView({ block: "center" });
    hit.classList.add("ctx-cite-hit");
  }, [cite, paragraphs.length]);

  return <div className={className} ref={hostRef}>
    {paragraphs.map((paragraph) => (
      <p key={paragraph.key} {...(paragraph.cite ? { "data-cite": paragraph.cite } : {})}>{paragraph.text}</p>
    ))}
  </div>;
}

export function ContextViewer({ target, questions, onBack, onEvidence, onReview }: {
  target: ContextViewerTarget;
  questions: any[];
  onBack: () => void;
  onEvidence: (evidence: EvidenceRef) => void;
  onReview: (id: string) => void;
}): ReactElement {
  const [payload, setPayload] = useState<ViewerPayload>({
    status: "idle",
    text: "",
    sheets: [],
    chunks: [],
    findings: [],
    error: "",
    meta: null,
  });

  useEffect(() => {
    let current = true;
    const ready = (patch: Partial<ViewerPayload>): void => {
      if (!current) return;
      setPayload({ status: "ready", text: "", sheets: [], chunks: [], findings: [], error: "", meta: null, ...patch });
    };
    const cachedFallback = async (): Promise<void> => {
      if (target.type === "material" || target.type === "evidence") {
        await loadSource(target.fileName);
        const source = STATE.SRC[target.fileName] || {};
        const chunks = rows(source.chunks);
        ready({
          text: chunks.map((chunk) => text(chunk.text)).filter(Boolean).join("\n\n"),
          sheets: target.format === "table" ? tableFromChunks(chunks) : [],
          chunks,
          findings: rows(source.findings),
          error: text(source.error),
        });
        return;
      }
      if (target.format === "graph" || target.format === "image" || target.format === "pdf") {
        ready({});
        return;
      }
      // 注意：这里是**统一预览接口失败之后**的回落路径。二进制表格/文档在浏览器
      // 里没法自己解，只能说明情况 —— 但服务端现在会直读表格（routes/preview.ts
      // 的 readSheets），所以正常情况下走不到这一支。
      if (["xlsx", "xls", "docx", "doc"].includes(target.extension)) {
        ready({ meta: { notice: "统一预览接口暂不可用；为避免在浏览器中重复解析，请下载原文件查看。" } });
        return;
      }
      const response: any = await fetch(target.downloadUrl || target.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let source = await response.text();
      if (target.extension === "json") {
        try { source = JSON.stringify(JSON.parse(source), null, 2); } catch { /* 原样显示不合法 JSON */ }
      }
      const sheets = target.extension === "csv"
        ? [tableFromDelimited(source, ",", target.title)]
        : target.extension === "tsv" ? [tableFromDelimited(source, "\t", target.title)] : [];
      ready({ text: source, sheets });
    };
    const load = async (): Promise<void> => {
      setPayload({ status: "loading", text: "", sheets: [], chunks: [], findings: [], error: "", meta: null });
      try {
        const response: any = await fetch(target.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const metadata = await response.json();
        if (metadata?.schemaVersion !== "ontocopilot.preview/1") throw new Error("preview-api-unavailable");
        const kind = text(metadata.previewKind);
        const data = metadata.data || {};
        if (kind === "spreadsheet") {
          const sheets = rows(data.groups).map((group, groupIndex): ViewerSheet => {
            const sourceRows = rows(group.rows);
            const columns = [...new Set(sourceRows.flatMap((row) => Object.keys(row.cells || {})))];
            if (!columns.length) columns.push("内容");
            columns.push("出处");
            return {
              name: text(group.name, `Sheet ${groupIndex + 1}`),
              columns,
              rows: sourceRows.map((row) => columns.map((column) => column === "出处"
                ? text(row.cite)
                : text((row.cells || {})[column], column === "内容" ? text(row.text) : ""))),
            };
          });
          ready({ sheets, findings: rows(data.findings), meta: metadata });
          return;
        }
        if (kind === "document") {
          const groups = rows(data.groups);
          const source = groups.flatMap((group) => rows(group.rows).map((row) => text(row.text))).filter(Boolean).join("\n\n");
          ready({ text: source, findings: rows(data.findings), meta: metadata });
          return;
        }
        if (kind === "markdown") {
          ready({ text: text(data.text), meta: metadata });
          return;
        }
        if (kind === "json") {
          let rendered = text(data.text);
          if (!rendered && data.value !== undefined) {
            try { rendered = JSON.stringify(data.value, null, 2); } catch { rendered = String(data.value); }
          }
          // 结构化 JSON（数据字典、问题清单）本来就是表，先按表画；认不出表的
          // 部分仍回落到 JSON 正文 —— 不硬凑，也不再一律拍成字符串墙。
          ready({ text: rendered, sheets: sheetsFromJson(data.value), meta: metadata });
          return;
        }
        ready({ meta: metadata });
      } catch (error: any) {
        try { await cachedFallback(); }
        catch (fallbackError: any) {
          if (current) setPayload({
            status: "error", text: "", sheets: [], chunks: [], findings: [], meta: null,
            error: text(fallbackError?.message || error?.message || fallbackError || error, "预览失败"),
          });
        }
      }
    };
    void load();
    return () => { current = false; };
  }, [target.id, target.url, target.format, target.fileName, target.extension]);

  const remoteKind = text(payload.meta?.previewKind);
  const effectiveKind = remoteKind || target.format;
  // PNG/SVG 只允许使用后端安全内嵌端点；下载 URL 不能直接进入 img src。
  const inlineUrl = text(payload.meta?.inlineUrl);
  const downloadUrl = text(payload.meta?.downloadUrl) || target.downloadUrl;
  const openUrl = inlineUrl || downloadUrl || target.url;
  let content: ReactNode;
  if (effectiveKind === "graph") content = <WorkflowCanvas target={target} graphData={payload.meta?.data}
    questions={questions} onEvidence={onEvidence} onReview={onReview} />;
  else if (effectiveKind === "image" && inlineUrl) content = <div className="ctx-viewer-image-wrap"><img className="ctx-viewer-image" src={inlineUrl} alt={target.title} /></div>;
  else if (effectiveKind === "image") content = <div className="ctx-warning">{text(payload.meta?.notice, "图片未通过安全内嵌检查，请下载后查看。")}</div>;
  else if (effectiveKind === "pdf") content = <object className="ctx-viewer-pdf" data={downloadUrl} type="application/pdf"><a href={downloadUrl} target="_blank" rel="noreferrer">在新窗口打开 PDF</a></object>;
  else if (payload.status === "loading" || payload.status === "idle") content = <SidebarEmpty label="LOADING">{uiText("正在准备预览…", "Preparing preview…")}</SidebarEmpty>;
  else if (payload.status === "error") content = <div className="ctx-viewer-error"><div className="ctx-warning">{payload.error}</div><p>仍可下载原文件或在新窗口打开。</p></div>;
  else if (payload.sheets.length) content = <div className="ctx-viewer-sheets">{payload.sheets.map((sheet, index) => <ViewerTable sheet={sheet} key={`${sheet.name}:${index}`} />)}</div>;
  else if (effectiveKind === "markdown") content = <Markdown text={payload.text} className="mdbody ctx-viewer-markdown" />;
  else if (effectiveKind === "document") content = <>
    {payload.findings.map((finding, index) => <div className="ctx-warning" key={index}>{text(finding.message || finding)}</div>)}
    {target.snippet ? <blockquote className="ctx-viewer-snippet">{target.snippet}</blockquote> : null}
    <ViewerProse chunks={payload.chunks} body={payload.text} cite={target.cite} className="ctx-viewer-document" />
  </>;
  // 纯文本也要定位。上一版这一支连 snippet 都不画 —— 同一件事在 document 上有、
  // 在 text 上没有，用户不会知道自己撞上了哪一支。
  else if (payload.text) content = <>
    {target.snippet ? <blockquote className="ctx-viewer-snippet">{target.snippet}</blockquote> : null}
    <ViewerProse chunks={payload.chunks} body={payload.text} cite={target.cite} className="ctx-viewer-text" />
  </>;
  else content = <div className="ctx-viewer-download-only">
    {payload.meta?.notice ? <div className="ctx-notice">{text(payload.meta.notice)}</div> : null}
    <pre className="ctx-viewer-code">{"该格式暂时没有可内嵌的内容；请下载原文件查看。"}</pre>
  </div>;

  return <div className="ctx-viewer" data-viewer-type={target.type}>
    <header className="ctx-viewer-head">
      <button type="button" className="ctx-viewer-back" onClick={onBack}>{uiText("返回", "Back")}</button>
      <div className="ctx-viewer-heading">
        <div className="ctx-viewer-title">{target.title}</div>
        <div className="ctx-viewer-locator">{[target.sourceLabel, target.cite].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="ctx-viewer-actions">
        {openUrl ? <a className="act" href={openUrl} target="_blank" rel="noreferrer">{uiText("新开", "Open")}</a> : null}
        {downloadUrl ? <a className="act" href={downloadUrl} download onClick={() => {
          if (target.type === "artifact" || target.type === "graph") {
            contextSyncStore.publish({
              type: "delivery.export",
              title: `下载：${target.title}`,
              summary: target.sourceLabel,
              artifactIds: target.type === "artifact" ? [target.id.replace(/^artifact:/u, "")] : [],
            });
          } else {
            contextSyncStore.focus({
              source: "sidebar",
              section: "evidence",
              label: target.title,
              evidenceIds: [target.cite || target.id],
            });
          }
        }}>{target.type === "material" || target.type === "evidence" ? uiText("下载解析数据", "Download parsed data") : uiText("下载", "Download")}</a> : null}
      </div>
    </header>
    <div className="ctx-viewer-content">
      {payload.meta?.notice && effectiveKind !== "image" && effectiveKind !== "download"
        ? <div className="ctx-notice ctx-viewer-notice">{text(payload.meta.notice)}</div> : null}
      {content}
    </div>
  </div>;
}

function ProjectPanel({ questions, onNavigate }: {
  questions: any[];
  onNavigate: (section: ContextSection) => void;
}): ReactElement {
  const G = useUi();
  const oir = G.S?.state?.oir || {};
  const flow = G.S?.state?.flow || {};
  const fileCount = rows(G.S?.filelist).length;
  const objectCount = Number(oir.stats?.objects ?? rows(oir.objects).length);
  const workflowCount = processCount(flow);
  const modelCount = objectCount + workflowCount;
  const artifactCount = rows(G.S?.state?.artifacts).length;
  const hasMaterials = fileCount > 0;
  const hasModel = modelCount > 0;
  const active = questions.filter((question) => ["open", "assigned", "blocked"].includes(question.status));
  const blockers = active.filter((question) => question.priority === "blocking" || rows(question.blockedArtifacts).length);
  const release = releaseState(questions, text(G.S?.status));
  const sessionEmpty = !hasMaterials && !hasModel && artifactCount === 0;
  const revision = revisionOf(G, null);
  const phase = G.THINKING
    ? uiText("正在运行", "Running")
    : blockers.length ? uiText("等待关键决策", "Waiting for key decisions")
      : active.length ? uiText("待业务确认", "Awaiting review")
        : artifactCount ? uiText("交付已就绪", "Ready to deliver")
          : hasModel ? uiText("模型整理中", "Model in progress")
            : hasMaterials ? uiText("材料已就绪", "Files ready") : uiText("待开始", "Not started");

  const stageRows: Array<{
    key: ContextSection; label: string; count: number; state: "done" | "current" | "pending";
  }> = [
    { key: "evidence", label: uiText("资料", "Files"), count: fileCount,
      state: hasMaterials ? "done" : "current" },
    { key: "model", label: uiText("模型", "Model"), count: modelCount,
      state: hasModel ? "done" : hasMaterials ? "current" : "pending" },
    { key: "review", label: uiText("审阅", "Review"), count: active.length,
      state: hasModel && !active.length ? "done" : hasModel ? "current" : "pending" },
    { key: "delivery", label: uiText("交付", "Delivery"), count: artifactCount,
      state: artifactCount ? "done" : hasModel && !active.length ? "current" : "pending" },
  ];

  const genericDraft = (): void => {
    prefillComposer({
      schemaVersion: GENERIC_SCENARIO_DRAFT_SCHEMA,
      scenario: "",
      outputType: "Ontology",
    }, { mode: "replace" });
  };
  const next: { eyebrow: string; title: string; copy: string; label?: string; section?: ContextSection } = !hasMaterials
    ? {
        eyebrow: uiText("建立输入", "Establish input"),
        title: uiText("先提供业务材料，或描述一个业务场景", "Add business material or describe a scenario"),
        copy: uiText("建议上传流程文档、字段表或需求说明；没有材料时也可以先生成一份通用草案。", "Upload process documents, field tables, or requirements; you can also start from a generic draft."),
      }
    : blockers.length
      ? {
          eyebrow: uiText("优先处理", "Priority"),
          title: uiText(`${blockers.length} 个关键问题正在阻塞交付`, `${blockers.length} blocking questions hold delivery`),
          copy: text(blockers[0]?.text, uiText("先确认阻塞口径，再继续生成下游产物。", "Resolve blocking definitions before generating downstream artifacts.")),
          label: uiText("进入审阅", "Open review"), section: "review" as ContextSection,
        }
      : active.length
        ? {
            eyebrow: uiText("等待确认", "Awaiting confirmation"),
            title: uiText(`还有 ${active.length} 个业务问题待确认`, `${active.length} business questions remain`),
            copy: uiText("集中完成这一批确认，模型与交付物会随结论更新。", "Complete this review batch so the model and artifacts can update."),
            label: uiText("继续审阅", "Continue review"), section: "review" as ContextSection,
          }
        : artifactCount
          ? {
              eyebrow: uiText("本轮完成", "Ready"),
              title: uiText("模型与交付物已就绪", "Model and deliverables are ready"),
              copy: uiText(`当前有 ${artifactCount} 份产物，可进入交付区核对并下载。`, `${artifactCount} artifacts are ready to review and download.`),
              label: uiText("查看交付", "View delivery"), section: "delivery" as ContextSection,
            }
          : hasModel
            ? {
                eyebrow: uiText("继续完善", "Continue"),
                title: uiText("模型骨架已形成，继续核对对象与流程", "The model skeleton is ready for validation"),
                copy: uiText("检查对象、关系、规则和流程中的缺口，再进入业务审阅。", "Inspect gaps in objects, relations, rules, and processes before review."),
                label: uiText("打开模型", "Open model"), section: "model" as ContextSection,
              }
            : {
                eyebrow: uiText("开始梳理", "Start modeling"),
                title: uiText(`${fileCount} 份材料已经就绪`, `${fileCount} files are ready`),
                copy: uiText("从材料中识别业务对象、流程、规则和待确认口径。", "Extract business objects, processes, rules, and open definitions from the files."),
                label: uiText("查看材料", "View files"), section: "evidence" as ContextSection,
              };

  const workspaces = [
    { section: "evidence" as ContextSection, label: uiText("文件", "Files"), value: fileCount,
      copy: uiText("已解析的业务材料", "Parsed business materials") },
    { section: "model" as ContextSection, label: uiText("模型", "Model"), value: modelCount,
      copy: uiText(`${objectCount} 对象 · ${workflowCount} 流程`, `${objectCount} objects · ${workflowCount} processes`) },
    { section: "review" as ContextSection, label: uiText("审阅", "Review"), value: active.length,
      copy: blockers.length ? uiText(`${blockers.length} 个阻塞`, `${blockers.length} blocking`) : uiText("待业务确认", "Awaiting decisions") },
    { section: "delivery" as ContextSection, label: uiText("交付", "Delivery"), value: artifactCount,
      copy: uiText("可核对与下载的产物", "Artifacts to review and download") },
  ];
  const activities = rows(G.OPS).slice(-3).reverse();
  const activityTime = (value: unknown): string => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    const date = new Date(n < 1_000_000_000_000 ? n * 1_000 : n);
    return date.toLocaleTimeString(STATE.LANG === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  return <div className="ctx-project ctx-project-dashboard">
    <section className="ctx-project-hero">
      <div className="ctx-project-hero-top">
        <div>
          <div className="ctx-eyebrow">{uiText("项目概况", "Project overview")}</div>
          <div className="ctx-detail-title">{text(G.S?.title || G.S?.name, uiText("未命名项目", "Untitled project"))}</div>
        </div>
        <span className={`ctx-project-phase ${G.THINKING ? "running" : ""}`}><i />{phase}</span>
      </div>
      <div className="ctx-project-meta">
        <span>{revision}</span><span>·</span><span className={`ctx-badge ${release.toLocaleLowerCase()}`}>{release}</span>
      </div>
      <div className="ctx-project-stage" aria-label={uiText("项目阶段", "Project stages")}>
        {stageRows.map((stage, index) => <button type="button" key={stage.key}
          className={`ctx-project-stage-item ${stage.state}`} onClick={() => onNavigate(stage.key)}>
          <span className="ctx-project-stage-mark">{stage.state === "done" ? "✓" : index + 1}</span>
          <span><strong>{stage.label}</strong><small>{stage.count}</small></span>
        </button>)}
      </div>
    </section>

    <section className="ctx-project-next">
      <div className="ctx-project-next-copy">
        <div className="ctx-eyebrow">{next.eyebrow}</div>
        <strong>{next.title}</strong>
        <p>{next.copy}</p>
      </div>
      <div className="ctx-project-next-actions">
        {!hasMaterials ? <>
          <button type="button" className="act pri" onClick={() => document.getElementById("picker")?.click()}>{uiText("上传材料", "Upload files")}</button>
          <button type="button" className="act ctx-empty-action" onClick={genericDraft}>{uiText("从通用场景生成草案", "Draft from a generic scenario")}</button>
        </> : next.section ? <button type="button" className="act pri" onClick={() => onNavigate(next.section!)}>{next.label}</button> : null}
      </div>
    </section>

    {!sessionEmpty ? <section className="ctx-section ctx-project-workspace-section">
      <div className="ctx-section-title">{uiText("工作区", "Workspace")}</div>
      <div className="ctx-project-workspaces">
        {workspaces.map((workspace) => <button type="button" key={workspace.section} className="ctx-project-workspace"
          onClick={() => onNavigate(workspace.section)}>
          <span className="ctx-project-workspace-label">{workspace.label}</span>
          <strong>{workspace.value}</strong>
          <small>{workspace.copy}</small>
          <i aria-hidden="true">→</i>
        </button>)}
      </div>
      <div className="ctx-project-counts" aria-label={uiText("模型构成", "Model composition")}>
        <div className="ctx-stat"><strong>{objectCount}</strong><span>{uiText("对象", "Objects")}</span></div>
        <div className="ctx-stat"><strong>{workflowCount}</strong><span>{uiText("流程", "Processes")}</span></div>
      </div>
    </section> : null}

    {blockers.length ? <section className="ctx-section ctx-project-blockers">
      <div className="ctx-project-section-head">
        <div className="ctx-section-title">{uiText("关键阻塞", "Key blockers")} <span className="ctx-count">{blockers.length}</span></div>
        <button type="button" className="ctx-inline-action" onClick={() => onNavigate("review")}>{uiText("全部审阅", "Review all")}</button>
      </div>
      <div className="ctx-project-blocker-list">
        {blockers.slice(0, 3).map((question: any, index: number) => <button type="button" key={text(question.id) || index}
          className="ctx-project-blocker" onClick={() => onNavigate("review")}>
          <span className="ctx-project-blocker-dot" />
          <span><strong>{text(question.text, uiText("待确认问题", "Open question"))}</strong>
            <small>{text(question.audienceRole || question.role || question.owner, uiText("待分派", "Unassigned"))}</small></span>
          <i aria-hidden="true">›</i>
        </button>)}
      </div>
    </section> : null}

    {activities.length ? <section className="ctx-section ctx-project-activity">
      <div className="ctx-project-section-head">
        <div className="ctx-section-title">{uiText("最近更新", "Recent updates")}</div>
        <button type="button" className="ctx-inline-action" onClick={() => onNavigate("runtime")}>{uiText("查看运行记录", "View runtime")}</button>
      </div>
      <div className="ctx-activity">
        {activities.map((event: any, index: number) => <div className="ctx-project-activity-row"
          key={text(event.id || event.seq) || index}>
          <span className={`ctx-runtime-dot ${text(event.tag, "neutral")}`} />
          <span><strong>{text(event.label || event.title || event.kind, uiText("系统更新", "System update"))}</strong>
            {event.detail ? <small>{text(event.detail)}</small> : null}</span>
          <time>{activityTime(event.ts || event.at || event.created_at || event.time)}</time>
        </div>)}
      </div>
    </section> : null}
  </div>;
}

interface WebMaterialRef {
  id: string;
  pageId: string;
  title: string;
  url: string;
  digest: string;
  savedAt: string;
}

function webMaterialsFromState(value: unknown): WebMaterialRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const assets = rows((value as Record<string, any>).assets);
  const out = new Map<string, WebMaterialRef>();
  for (const asset of assets) {
    const metadata = asset?.metadata && typeof asset.metadata === "object" ? asset.metadata : {};
    if (text(asset?.kind) !== "reference" || text(asset?.source) !== "web.preview") continue;
    if (text(asset?.status) === "superseded") continue;
    const pageId = text(metadata.pageId);
    const url = text(metadata.finalUrl || metadata.url || asset?.uri);
    if (!pageId || !url) continue;
    const digest = text(metadata.digest || asset?.contentDigest);
    const row: WebMaterialRef = {
      id: text(asset?.id, `${pageId}:${digest}`),
      pageId,
      title: text(metadata.title || asset?.name, url),
      url,
      digest,
      savedAt: text(metadata.fetchedAt),
    };
    out.set(`${pageId}:${digest}`, row);
  }
  return [...out.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function EvidencePanel({ query, onOpen }: {
  query: string;
  onOpen: (target: ContextViewerTarget) => void;
}): ReactElement {
  const G = useUi();
  const all = rows(G.S?.filelist);
  const webMaterials = webMaterialsFromState(G.S?.state?.asset_memory);
  const files = all.filter((file) => !query
    || `${text(file.name)} ${text(file.state)} ${text(file.issue)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const web = webMaterials.filter((item) => !query
    || `${item.title} ${item.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selected = G.FILE ? G.SRC[G.FILE] : null;
  const back = G.CONTEXT_BACK;
  const backLabel: Record<string, string> = { project: "项目", model: "模型", review: "审阅", delivery: "交付" };
  return <div className="ctx-evidence-panel">
    {back ? <button type="button" className="ctx-context-back" onClick={() => {
      setUi({ TAB: back, CONTEXT_BACK: null });
    }}>返回{backLabel[back] || "上一视图"}</button> : null}
    <section className="od-session-section" aria-label={uiText("本次会话附件", "Current session files")}>
      <div className="od-session-head">
        <div>
          <span className="od-eyebrow">SESSION</span>
          <h3>{uiText("本次会话附件", "Current session files")}</h3>
          <p>{uiText("只属于当前会话。项目长期材料请到左侧入口打开“项目知识库”管理。", "These files belong to this session. Use the Project knowledge library entry in the left sidebar for long-term project materials.")}</p>
        </div>
        <button type="button" className="act" onClick={() => document.getElementById("picker")?.click()}>{uiText("上传材料", "Upload files")}</button>
      </div>
    {all.length || webMaterials.length ? <div className="ctx-panel-summary">
      {all.length} {uiText("份上传材料", "uploaded files")} · {webMaterials.length} {uiText("份网页材料", "web materials")} · {all.filter((file) => file.state === "parsed").length} {uiText("份已解析", "parsed")}
    </div> : null}
    {!files.length && !web.length ? <SidebarEmpty label="EVIDENCE">
      {all.length || webMaterials.length ? uiText("没有匹配的材料", "No files match this search")
        : <button type="button" className="act ctx-empty-action"
          onClick={() => document.getElementById("picker")?.click()}>{uiText("上传材料", "Upload files")}</button>}
    </SidebarEmpty> : <div className="ctx-file-list">
      {web.map((item) => <button type="button" className="ctx-file ctx-web-material" key={item.id}
        onClick={() => window.dispatchEvent(new CustomEvent(WORKBENCH_OPEN_EVENT, { detail: {
          kind: "web",
          key: `web-material:${item.pageId}:${item.digest}`,
          pageId: item.pageId,
          url: item.url,
          title: item.title,
          viewState: { digest: item.digest, saved: true },
        } }))}>
        <span className="ctx-file-name">{item.title}</span>
        <span className="ctx-file-meta">{uiText("网页材料", "Web material")} · {item.savedAt || item.url}</span>
      </button>)}
      {files.map((file, index) => (
        <button
          type="button"
          className={`ctx-file ${text(file.name) === G.FILE ? "on" : ""}`}
          key={text(file.name) || index}
          onClick={() => {
            const name = text(file.name);
            setUi({ FILE: name });
            onOpen(materialTarget(G.S.id, name));
          }}
        >
          <span className="ctx-file-name">{text(file.name, "未命名材料")}</span>
          <span className="ctx-file-meta">{text(file.state, "unread")} · {Number(file.chunks || 0)} 个片段</span>
          {file.issue ? <span className="ctx-file-issue">{text(file.issue)}</span> : null}
        </button>
      ))}
    </div>}
    {G.FILE && files.some((file) => text(file.name) === G.FILE) ? <section className="ctx-source">
      <div className="ctx-section-title">{G.FILE}</div>
      {!selected ? <div className="ctx-empty-inline">{uiText("正在读取材料…", "Loading…")}</div>
        : selected.error ? <div className="ctx-warning">读取失败：{text(selected.error)}</div>
          : <div className="ctx-source-rows">
            {rows(selected.findings).map((finding, index) => (
              <div className="ctx-warning" key={index}>{text(finding.message || finding)}</div>
            ))}
            {rows(selected.chunks).slice(0, 100).map((chunk, index) => (
              <button
                type="button"
                className="ctx-source-row"
                data-cite={text(chunk.cite)}
                key={text(chunk.cite) || index}
                onClick={() => onOpen(materialTarget(G.S.id, G.FILE || "", text(chunk.cite), text(chunk.text)))}
              >
                <span className="ctx-source-cite">{text(chunk.cite, `片段 ${index + 1}`)}</span>
                <span className="ctx-source-copy">{text(chunk.text).slice(0, 420)}</span>
              </button>
            ))}
          </div>}
    </section> : null}
    </section>
  </div>;
}

/**
 * 「这条不对」的修正指令。
 *
 * 缺口芯片答的是「差什么」，这里答的是**「哪里不对」** —— 而后者才是 FDE
 * 核对模型时真正的产出。以前他扫到「预估金额 / DECIMAL / 不含税」发现口径错了，
 * 界面到此为止：得把手移到输入框，**把对象名、属性名、要改的字段全部重敲一遍**
 * （敲错一个字模型就改到别的对象上），发出去，等一轮，再滚回来重新找到这个对象、
 * 重新展开属性表。**核对的产物一定是修正，而这个产品把修正做成了重新打字。**
 *
 * 所以这句话要替他把上下文写全（对象、apiName、现在的类型和口径），
 * 光标停在冒号后面 —— 他只补结论。
 */
function attrFixPrompt(objectLabel: string, a: AttrRef): string {
  const now = [
    `类型 ${a.type}`,
    a.definition ? `口径「${a.definition}」` : "没有口径",
    a.required ? "必填" : "非必填",
  ].join("、");
  const name = a.api && a.api !== a.name ? `${a.api}（${a.name}）` : a.name;
  return `「${objectLabel}」的 ${name} 现在写着：${now}。这里不对，正确的是：`;
}

/**
 * 属性表。
 *
 * 以前这里什么都没有 —— 对象详情只有「属性 3」一个数字，属性名、类型、口径
 * 全 sidebar 一处都看不到。数据一直就在 `oir.properties` 里，只是没人渲染。
 *
 * 列的取舍：名字 + 类型 + **口径**。口径是 FDE 拿去跟客户对账的东西
 * （「金额」含不含税、「日期」按自然月还是账期），比 API 名值钱得多。
 * 默认只铺 6 行 —— 侧栏是用来扫的，不是用来读全表的；真要看全表去画布。
 */
function AttributeTable({ item }: { item: ModelItem }): ReactElement {
  const [open, setOpen] = useState(false);
  const attrs = item.attributes;
  const shown = open ? attrs : attrs.slice(0, 6);
  return <section className="ctx-section">
    <div className="ctx-section-title">
      {uiText("属性", "Attributes")}
      {attrs.length ? <span className="ctx-count">{attrs.length}</span> : null}
    </div>
    {attrs.length === 0
      // 空态要说**下一步怎么办**，不是只说"没有"。零属性是这个产品最常见的
      // 状态，把它写成一句可执行的话，比一句"暂无"有用。
      ? <div className="ctx-empty-inline">
          {uiText("还没有识别出属性。上传含字段表的材料，或直接在聊天里说要补哪些字段。",
            "No attributes yet. Upload a material with a field table, or say which fields to add.")}
        </div>
      : <>
          <div className="ctx-rows ctx-attrs">
            {shown.map((a) => (
              <button
                type="button"
                className="ctx-row ctx-attr"
                key={a.api || a.name}
                title={uiText("这条不对？点一下把修正指令填进输入框", "Wrong? Click to draft a correction")}
                aria-label={uiText(`修正 ${a.name}`, `Correct ${a.name}`)}
                onClick={() => prefillComposer(attrFixPrompt(item.label, a), { mode: "insert" })}
              >
                <span className="ctx-attr-main">
                  <b>{a.name}</b>
                  <code>{a.type}</code>
                  {a.definition ? <em>{a.definition}</em> : null}
                </span>
                <small>
                  {a.required ? uiText("必填", "required") : ""}
                  {a.required ? " · " : ""}
                  {ORIGIN_LABEL[a.origin] ?? ORIGIN_LABEL["inferred"]}
                </small>
              </button>
            ))}
          </div>
          {attrs.length > 6 ? <button type="button" className="ctx-inline-action"
            onClick={() => setOpen((v) => !v)}>
            {open ? uiText("收起", "Collapse")
              : uiText(`还有 ${attrs.length - 6} 条`, `${attrs.length - 6} more`)}
          </button> : null}
        </>}
  </section>;
}

function ModelDetail({ item, onOpenEvidence, onOpenGraph }: {
  item: ModelItem;
  onOpenEvidence: (evidence: EvidenceRef) => void;
  onOpenGraph: (item?: ModelItem) => void;
}): ReactElement {
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const longDescription = item.description.length > 360;
  return <article className="ctx-detail">
    <header className="ctx-detail-header">
      <div>
        <div className="ctx-eyebrow">{uiText("模型", "Model")} / {kindLabel(item.kind)}</div>
        <div className="ctx-detail-title">{item.label}</div>
        {item.api ? <div className="ctx-detail-api">{item.api}</div> : null}
      </div>
      <span className={`ctx-badge ${modelRejected(item.status) ? "rejected" : modelNeedsReview(item.status) ? "warning" : "confirmed"}`}>{modelStatusLabel(item.status)}</span>
    </header>
    <p className={`ctx-description ${longDescription && !descriptionOpen ? "clamped" : ""}`}>{item.description}</p>
    {longDescription ? <button type="button" className="ctx-inline-action"
      onClick={() => setDescriptionOpen((open) => !open)}>{descriptionOpen ? "收起完整说明" : "展开完整说明"}</button> : null}
    {item.facts.length ? <div className="ctx-facts">
      {item.facts.map(([label, value]) => <div className="ctx-fact" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div> : null}
    {item.gaps.length ? <div className="ctx-gaps">
      {item.gaps.map((gap) => (
        // 点一下就把补齐指令填进输入框 —— 报缺不给下一步等于把活推回给人。
        <button type="button" className="ctx-gap" key={gap.label}
          title={gap.prompt}
          onClick={() => prefillComposer(gap.prompt, { mode: "insert" })}>
          {gap.label}
        </button>
      ))}
    </div> : null}
    {item.kind === "object" ? <AttributeTable item={item} /> : null}
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("关联", "Relations")}</div>
      {item.relations.length ? <div className="ctx-rows">
        {item.relations.slice(0, 20).map((relation, index) => (
          <div className="ctx-row" key={`${relation.label}:${relation.meta}:${index}`}>
            <span>{relation.label}</span><small>{relation.meta}</small>
          </div>
        ))}
      </div> : <div className="ctx-empty-inline">{uiText(
        "还没有任何关联。它和哪些对象、哪些环节有关系？在下面说一句就能建。",
        "No relations yet. Say which objects or steps it connects to and they will be created.",
      )}</div>}
    </section>
    {/* **待确认在证据前面。** 实测 evidence 100% 为空，于是「证据」这一节在每个
        对象上都只是一条占位灰字，却稳稳挡在待办前面 —— FDE 要滚过属性表 +
        最多 20 行关联 + 一行永远没用的灰字，才看到今天真正要动的东西。 */}
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("待确认", "Pending review")}</div>
      {item.pending.length ? <div className="ctx-rows">
        {item.pending.slice(0, 8).map((question, index) => (
          <div className="ctx-row ctx-row-warning" key={text(question.id) || index}>
            <span>{text(question.text, "未命名问题")}</span>
            <small>{STATUS_LABEL[text(question.status)] || text(question.status, "待回答")}</small>
          </div>
        ))}
      </div> : <div className="ctx-empty-inline">{uiText(
        "这一项上没有开放问题。发现口径不对就在下面直接说，会记成一条决定。",
        "No open questions here. If a definition looks wrong, say so below — it becomes a decision.",
      )}</div>}
    </section>
    {/* 证据为空时不占一整节 —— 它在这个产品里是常态，不是异常 */}
    {item.evidence.length ? <section className="ctx-section">
      <div className="ctx-section-title">{uiText("证据", "Evidence")}</div>
      <EvidenceButtons evidence={item.evidence} onOpen={onOpenEvidence} />
    </section> : <div className="ctx-empty-inline ctx-evidence-none">{uiText(
      "没有可定位的原文出处 —— 这一项是推断出来的，确认前最好回材料里核一下。",
      "No locatable source — this item is inferred; check it against the materials before confirming.",
    )}</div>}
    <footer className="ctx-sticky-actions">
      <button type="button" className="act" onClick={() => activateComposer(item)}>{uiText(`询问此${kindLabel(item.kind)}`, `Ask about this ${kindLabel(item.kind)}`)}</button>
      <button type="button" className="act pri" onClick={() => onOpenGraph(item)}>{uiText("在画布中打开", "Open in canvas")}</button>
    </footer>
  </article>;
}

function ModelPanel({
  items, query, focusId, selectedId, onSelect, kind, onKindChange,
  onOpenEvidence, onOpenGraph, onFocusConsumed,
}: {
  items: ModelItem[];
  query: string;
  focusId?: string;
  /** 受控：状态住在 ContextSidebar 上，viewer 顶掉本面板时不会被销毁。 */
  selectedId: string;
  onSelect: (id: string) => void;
  kind: ModelKind | "all" | "todo";
  onKindChange: (kind: ModelKind | "all" | "todo") => void;
  onOpenEvidence: (evidence: EvidenceRef) => void;
  onOpenGraph: (item?: ModelItem) => void;
  onFocusConsumed?: () => void;
}): ReactElement {
  const setKind = onKindChange;
  const setSelectedId = onSelect;
  const consumedFocusId = useRef("");
  useEffect(() => {
    if (!focusId) {
      consumedFocusId.current = "";
      return;
    }
    if (consumedFocusId.current === focusId) return;
    if (!items.some((item) => item.id === focusId)) return;
    consumedFocusId.current = focusId;
    setKind("all");
    setSelectedId(focusId);
    onFocusConsumed?.();
  }, [focusId, items, onFocusConsumed]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matched = items.filter((item) =>
    (kind === "all" || kind === "todo" || item.kind === kind)
    && (kind !== "todo" || item.gaps.length > 0)
    && (!normalizedQuery || item.searchText.toLocaleLowerCase().includes(normalizedQuery)));
  // **默认按「建得有多实」排，只有「待补全」那一档按缺口排。**
  //
  // 上一版一律按 gaps.length 降序 —— 而空壳恰好缺得最多。线上实测：对象组第一屏
  // 全是解析噪声（一 / 二 / 规则名称 / 业务对象），采购申请、采购订单、验收这些
  // 真建了模的被挤到最末。「最需要补」被当成了「最该先看」，可 FDE 打开模型页
  // 是来看模型的；要工作队列时他会去点「待补全」，那一档保持缺口优先。
  //
  // 截断本身可以留，但截掉的必须是"已经没问题的那些"—— 上一版按插入顺序硬切
  // 80 条，于是 202 个对象的会话里规则/Action/Event 一行都到不了。
  // 同分保持原顺序（稳定排序），免得每次渲染都跳。
  const substance = (item: ModelItem): number =>
    item.attributes.length + item.relations.length + item.evidence.length + item.facts.length;
  const filtered = kind === "todo"
    ? matched.map((item, i) => [item, i] as const)
      .sort((a, b) => (b[0].gaps.length - a[0].gaps.length) || (a[1] - b[1]))
      .map(([item]) => item)
    : kind === "all"
      ? matched.map((item, i) => [item, i] as const)
        .sort((a, b) => (substance(b[0]) - substance(a[0])) || (a[1] - b[1]))
        .map(([item]) => item)
      : matched;
  // **截断按组算，不按全局算。** 全局切前 80 条时，200 个对象的会话里规则/Action/
  // Event 一行都到不了 —— 那是这条截断当初要解决的问题，而全局排序只是把它换了个
  // 触发条件。每类各留 40 条，各自说自己被截了多少。
  const PER_KIND_CAP = 40;
  const visible = filtered;
  const selected = filtered.find((item) => item.id === selectedId) || filtered[0] || null;
  const counts = (target: ModelKind): number => items.filter((item) => item.kind === target).length;
  const todoCount = items.filter((item) => item.gaps.length > 0).length;
  // 按**当前列表**判，不是按全部 items：不同 kind 的 status 是各自推导出来的
  // （流程是「待确认/草稿/有依据」，对象是 OIR 原值），混在一起永远不会全同。
  // 判据要落在"用户此刻这一列看到的是不是同一个词"上。
  const allSameStatus = visible.length > 1
    && visible.every((item) => item.status === visible[0]!.status);
  // **按类型分组，共有缺口按组说一次。**
  //
  // 49 条平铺、每条挂一个「4」的缺口徽章，是 2026-08-25 用户说的「杂乱无顺序」
  // 的主要来源。两处判断：
  //  · 分组 —— 对象/流程/规则/动作/事件本来就是不同的东西，混在一列里扫不出结构；
  //  · 共有缺口按**同类**算 —— 线上实测：28 个对象全缺主键/属性/关系/流程，
  //    但混进 20 条规则之后「全体共有」为空，于是 42 行各自重复「无主键、无属性 +2」，
  //    比原来的数字更吵。同类之间的共同点才叫共同点，说一次就够。
  const groupsOfVisible: Array<{
    kind: ModelKind;
    items: ModelItem[];
    common: string[];
    commonCounts?: Map<string, number>;
    /** 这一类**筛选后**的总数（可能大于展示出来的 items）。 */
    total: number;
  }> = [];
  for (const item of visible) {
    let g = groupsOfVisible.find((x) => x.kind === item.kind);
    if (g === undefined) {
      g = { kind: item.kind, items: [], common: [], total: 0 };
      groupsOfVisible.push(g);
    }
    g.total += 1;
    if (g.items.length < PER_KIND_CAP) g.items.push(item);
  }
  for (const g of groupsOfVisible) {
    if (g.items.length < 2) { g.common = []; continue; }
    // **判据是「绝大多数」，不是「全体」。** 线上实测：28 个对象里 22 个挂着
    // 同一个标「无主键、无属性 +1」—— 只按全体共有去重，规律仍被重复 22 遍。
    // 一条规律该在组头说一次，行上留给「这条和同类不一样在哪」。
    const counts = new Map<string, number>();
    for (const item of g.items) {
      for (const label of new Set(item.gaps.map((x) => x.label))) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    // 过半即算规律。判据不是「几乎全体」而是「超过一半」—— 一个标只要挂在半数以上
    // 的行上就已经是墙纸，再精确的比例也不改变它不再有区分度这件事。
    // 实测：28 个对象里「无属性」占 22（78.6%），卡在 80% 线下就会继续重复 22 遍。
    const floor = Math.max(2, Math.floor(g.items.length / 2) + 1);
    // 保持 gaps 的原始顺序（modelItems 里是按重要性排的），只挑够格的
    g.common = g.items[0]!.gaps.map((x) => x.label)
      .concat([...counts.keys()])
      .filter((label, i, arr) => arr.indexOf(label) === i)
      .filter((label) => (counts.get(label) ?? 0) >= floor);
    g.commonCounts = counts;
  }
  /** 这一项区别于**同类其它项**的缺口 —— 共有的已经在组头说过了。 */
  const distinctGaps = (item: ModelItem): string[] => {
    const common = new Set(groupsOfVisible.find((g) => g.kind === item.kind)?.common ?? []);
    return item.gaps.map((x) => x.label).filter((label) => !common.has(label));
  };
  return <div className="ctx-model-panel">
    <div className="ctx-model-toolbar">
      <div className="ctx-filters" role="group" aria-label={uiText("模型类型筛选", "Model type filters")}>
        <button type="button" className={`ctx-filter ${kind === "all" ? "on" : ""}`} onClick={() => setKind("all")}>{uiText("全部", "All")} {items.length}</button>
        {MODEL_KINDS.map((value) => (
          <button type="button" className={`ctx-filter ${kind === value ? "on" : ""}`} key={value} onClick={() => setKind(value)}>
            {kindLabel(value)} {counts(value)}
          </button>
        ))}
        {/* FDE 的工作队列。缺口在 modelItems 里早就逐项算好了，之前只在详情里画 ——
            「哪些对象缺主键」只能一条一条点开看，而答案是 527/527 全缺。 */}
        {todoCount > 0 ? <button type="button" className={`ctx-filter todo ${kind === "todo" ? "on" : ""}`}
          onClick={() => setKind("todo")}>{uiText("待补全", "To fill")} {todoCount}</button> : null}
      </div>
      <button type="button" className="act ctx-graph-open" onClick={() => onOpenGraph()}>{uiText("工作流画布", "Workflow canvas")}</button>
    </div>
    {!filtered.length ? <SidebarEmpty label="MODEL">
      {/* **整份模型为空 ≠ 筛选没匹配上。** 上一版两种处境同一句话，
          于是新会话里 FDE 会去改筛选，而他真正该做的是传材料 ——
          画布在完全相同的处境下给的是「从通用场景生成草案」按钮，同一个 App 两种待遇。 */}
      {items.length === 0
        ? <>
          <div>{uiText("还没有模型。传材料让它梳理，或先从通用场景要一份草案。",
            "No model yet. Upload materials, or start from a generic scenario draft.")}</div>
          <button type="button" className="act pri ctx-empty-action" onClick={() => {
            prefillComposer({
              schemaVersion: GENERIC_SCENARIO_DRAFT_SCHEMA, scenario: "", outputType: "Ontology",
            }, { mode: "replace" });
          }}>{uiText("从通用场景生成草案", "Draft from a generic scenario")}</button>
        </>
        : uiText(`这个筛选下没有 —— 全部 ${items.length} 项里换一档看看`,
          `Nothing under this filter — try another of the ${items.length} items`)}
    </SidebarEmpty>
      : <div className="ctx-model-grid">
        <div className="ctx-model-list" role="listbox" aria-label="模型项">
          {groupsOfVisible.map((group) => <section className="ctx-model-group" key={group.kind}>
            {/* 组头：这一类有几个。只有一组时也留着 —— 它同时是共有缺口那句话的落点。 */}
            <header className="ctx-model-group-head">
              <strong>{kindLabel(group.kind)}</strong>
              <span>{group.total}</span>
            </header>
            {group.common.length ? <div className="ctx-common-gaps">
              {/* **如实报比例**：9/10 不能说成「全部」。规律要可信才有人看。 */}
              {group.common.map((label) => {
                const n = group.commonCounts?.get(label) ?? group.items.length;
                return n >= group.items.length
                  ? uiText(`全部${label}`, `all ${label}`)
                  : uiText(`${n}/${group.items.length} ${label}`, `${n}/${group.items.length} ${label}`);
              }).join(" · ")}
            </div> : null}
          {group.items.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={selected?.id === item.id}
              className={`ctx-model-item ${selected?.id === item.id ? "on" : ""}`}
              key={`${item.kind}:${item.id}`}
              onClick={() => setSelectedId(item.id)}
            >
              <span className="ctx-kind">{kindLabel(item.kind)}</span>
              <span className="ctx-item-main">
                <strong>{item.label}</strong>
                <small>{item.api || item.description}</small>
              </span>
              {/* 写成词，不是数字：「无主键」一眼看得懂，「1」还要去猜。
                  多于两项时只列前两项，其余用 +N —— 一行放不下四个词。 */}
              {distinctGaps(item).length ? <span className="ctx-item-gaps"
                title={item.gaps.map((g) => g.label).join("、")}>
                {distinctGaps(item).slice(0, 2).join("、")}
                {distinctGaps(item).length > 2 ? ` +${distinctGaps(item).length - 2}` : ""}
              </span> : null}
              {/* 全库同值时状态不占位 —— 实测 775 条实体 100% 是 candidate，
                  一整列同一个词等于一列空白，还挤掉了真正有区分度的缺口数。 */}
              {allSameStatus ? null : <span className={`ctx-status ${modelRejected(item.status) ? "rejected" : modelNeedsReview(item.status) ? "warning" : ""}`}>{modelStatusLabel(item.status)}</span>}
            </button>
          ))}
          {group.total > group.items.length ? <div className="ctx-list-cap">
            {uiText(`另有 ${group.total - group.items.length} 项，用搜索定位`,
              `${group.total - group.items.length} more — use search to narrow`)}
          </div> : null}
          </section>)}
        </div>
        {selected ? <ModelDetail item={selected} key={selected.id}
          onOpenEvidence={onOpenEvidence} onOpenGraph={onOpenGraph} /> : null}
      </div>}
  </div>;
}

interface ReviewDraft { owner: string; role: string; priority: string; answer: string; option: string }

/** 详情里的填写按「会话+问题」存一份：详情组件按 revision remount（内容变了要重置），
 *  但「返回队列再进来」「跑批拒写后 SSE 刷新」这两种 remount 不该吃掉没提交的字。
 *  记录决定成功后清掉；问题已终态时忽略存货，不让旧草稿盖住真答案。
 *  **键里必须带会话 id** —— 否则 A 会话写了一半的结论会显示在 B 会话的同 id 问题下。 */
export const REVIEW_DRAFTS = new Map<string, ReviewDraft>();

/** 审阅的二级导航位置也存模块级：打开/关闭证据查看器会让 ReviewPanel 换挂载位置
 *  （React 按位置对账 → remount），不记住的话「从详情查证据、关掉」会被踢回队列根部。
 *
 *  `sid` 是隔离键：批次 id（batch:missing_primary_key 之类）在**每个会话里都一样**，
 *  不按会话隔离的话，换会话会直接落进那个会话的同名批次详情页。 */
export const REVIEW_NAV = { sid: "", selectedId: "", drillQuestionId: "" };

/** 草稿键。会话没开时用空串 —— 那种情况下也不会有详情可填。 */
function draftKey(qid: string): string {
  return `${text(STATE.S?.id)}:${qid}`;
}

interface ImpactRef {
  id: string;
  label: string;
  kind: string;
  target: "model" | "artifact";
}

/**
 * 影响范围只能由问题自己声明的 applies / blockedArtifacts 推出来。
 * 找不到对应模型项时保留原始引用而不是丢掉 —— 编一条看起来合理的影响，
 * 比什么都不显示更糟。
 */
function impactRefs(q: any, index: Map<string, ModelItem>, artifacts: any[]): ImpactRef[] {
  const out: ImpactRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ImpactRef): void => {
    const key = `${ref.target}\u0000${ref.label}`;
    if (!ref.label || seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const raw of rows(q.applies)) {
    const ref = text(raw);
    const item = index.get(ref);
    if (item) push({ id: item.id, label: item.label, kind: kindLabel(item.kind), target: "model" });
    else push({ id: ref, label: ref, kind: uiText("引用", "Ref"), target: "model" });
  }
  const known = new Set(artifacts.map((artifact) => artifactName(artifact)));
  for (const raw of rows(q.blockedArtifacts)) {
    const name = text(raw);
    push({
      id: name,
      label: name,
      kind: known.has(name) ? uiText("产物", "Artifact") : uiText("阻塞产物", "Blocked"),
      target: "artifact",
    });
  }
  return out;
}

/** 面板上要有一个可以口头引用的编号；后端给了 code 就用它，否则按队列位置生成。 */
function questionCode(q: any, index: number): string {
  const explicit = text(q?.code);
  if (explicit) return explicit;
  const digits = text(q?.id).match(/(\d+)(?!.*\d)/u)?.[1];
  return `Q-${(digits || String(index + 1)).padStart(3, "0")}`;
}

function decisionFeedback(code: string, question: string, conclusion: string, impact: ImpactRef[]): string {
  const scope = impact.slice(0, 6).map((ref) => ref.label).join("、");
  return STATE.LANG === "en"
    ? [
      `I recorded decision ${code} for "${question}": ${conclusion}`,
      scope ? `Impacted scope: ${scope}` : "",
      "Please update the affected objects, processes, rules, and artifacts, then list any new questions this decision raises.",
    ].filter(Boolean).join("\n")
    : [
      `我已记录决定 ${code}「${question}」：${conclusion}`,
      scope ? `受影响范围：${scope}` : "",
      "请据此更新受影响的对象、流程、规则与产物，并列出这条决定新引出的待确认问题。",
    ].filter(Boolean).join("\n");
}

function ImpactList({ impact, onOpen }: {
  impact: ImpactRef[];
  onOpen: (ref: ImpactRef) => void;
}): ReactElement {
  return <div className="ctx-impact-list">
    {impact.slice(0, 12).map((ref) => <button
      type="button"
      className="ctx-impact-row"
      key={`${ref.target}:${ref.label}`}
      onClick={() => onOpen(ref)}
    >
      <span className="ctx-kind">{ref.kind}</span>
      <span className="ctx-impact-label">{ref.label}</span>
      <span className="ctx-review-chevron" aria-hidden="true">›</span>
    </button>)}
  </div>;
}

/** 证据对照：同一个口径在不同材料里长什么样，两栏并排，而不是折叠成一串链接。 */
function EvidenceCompare({ evidence, onOpen }: {
  evidence: EvidenceRef[];
  onOpen: (evidence: EvidenceRef) => void;
}): ReactElement {
  return <div className="ctx-evidence-compare">
    {evidence.slice(0, 4).map((item, index) => <button
      type="button"
      className="ctx-evidence-card"
      key={`${item.file}:${item.cite}:${index}`}
      onClick={() => onOpen(item)}
    >
      <span className="ctx-evidence-card-head">{item.file || item.cite}</span>
      <span className="ctx-evidence-card-cite">{item.cite}</span>
      {item.snippet ? <span className="ctx-evidence-card-body">{item.snippet}</span> : null}
    </button>)}
  </div>;
}

function ReviewQuestionDetail({ q, reviewItem, sourceIndex, code, impact, onOpenEvidence, onOpenImpact }: {
  q: any;
  reviewItem: FdeReviewItem;
  sourceIndex: number;
  code: string;
  impact: ImpactRef[];
  onOpenEvidence: (evidence: EvidenceRef) => void;
  onOpenImpact: (ref: ImpactRef) => void;
}): ReactElement {
  useUi();
  const done = ["answered", "cancelled"].includes(q.status);
  const [draft, setDraft] = useState<ReviewDraft>(() => (!done && REVIEW_DRAFTS.get(draftKey(text(q.id)))) || {
    owner: text(q.owner),
    role: text(q.role),
    priority: text(q.priority, "normal"),
    answer: text(q.answer),
    option: rows(q.options).find((option) => text(option.label) === text(q.answer))?.id || "",
  });
  const [assignOpen, setAssignOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const busy = Q_BUSY.has(q.id);
  const needsReopen = ["deferred", "blocked"].includes(q.status);
  const ledgerWritable = sourceIndex >= 0 && STATE.Q_API;
  const legacyConflictWritable = sourceIndex >= 0 && !STATE.Q_API && Boolean(q.conflictRid) && rows(q.options).length > 0;
  const canAnswer = ledgerWritable || legacyConflictWritable;
  const locked = busy || done || needsReopen || !canAnswer;
  const options = rows(q.options);
  const expected = uiText(reviewItem.expectedAnswer, reviewItem.expectedAnswerEn);
  const evidence = evidenceOf(q.evidence);
  const put = (patch: Partial<ReviewDraft>): void => {
    const next = { ...draft, ...patch };
    REVIEW_DRAFTS.set(draftKey(text(q.id)), next);
    setDraft(next);
  };
  const call = async (fn: () => Promise<unknown>, receipt: {
    type: "review.answer" | "review.assign" | "review.status";
    title: string;
    summary: string;
  }, succeeded: (before: any, after: any) => boolean, feedback?: () => string): Promise<void> => {
    const before = STATE.Q_BACKLOG.find((item: any) => text(item.id) === text(q.id));
    await fn();
    bumpUi();
    const after = STATE.Q_BACKLOG.find((item: any) => text(item.id) === text(q.id));
    // questions.ts 的兼容包装会吞掉失败并提示用户；只有投影确实改变才产生“已更新”回执。
    if (!succeeded(before, after)) return;
    if (receipt.type === "review.answer") REVIEW_DRAFTS.delete(draftKey(text(q.id)));
    contextSyncStore.publish({
      ...receipt,
      questionIds: [q.id],
      entityIds: rows(q.applies),
      evidenceIds: evidenceOf(q.evidence).map((evidence_) => evidence_.cite),
    });
    if (!feedback) return;
    // 决定已经落进 Ledger 之后才让对话接着往下走。聊天这一步失败不能回滚决定，
    // 因此只吞掉异常，不把它冒泡成“没保存”。
    try {
      await sendContextToChat(feedback(), {
        send: contextChatBridge.send,
        mode: "replace",
        focusSidebar: false,
      });
    } catch { /* 对话没接上不影响已经写入的决定 */ }
  };
  const submit = (): void => {
    const conclusion = draft.answer.trim()
      || text(options.find((option) => text(option.id) === draft.option)?.label);
    void call(
      () => qSubmitWith(sourceIndex, draft.answer.trim(), draft.option),
      { type: "review.answer", title: `已确认：${text(q.text)}`, summary: conclusion },
      (before, after) => text(after?.status) === "answered" && text(before?.status) !== "answered",
      () => decisionFeedback(code, uiText(reviewItem.title, reviewItem.titleEn), conclusion, impact),
    );
  };
  return <article className="ctx-review-detail">
    <div className="ctx-review-crumb">{uiText("问题", "Question")} / {code}</div>
    <div className="ctx-detail-title">{uiText(reviewItem.title, reviewItem.titleEn)}</div>
    <div className="ctx-review-meta">
      <span className={`ctx-review-level ${reviewItem.level}`}>{uiText(...REVIEW_LEVEL_LABEL[reviewItem.level])}</span>
      {text(q.role) ? <span className="ctx-review-role">{text(q.role)}</span> : null}
      {text(q.status, "open") === "open" ? null
        : <span className={`ctx-badge ${text(q.status)}`}>{reviewStatusLabel(text(q.status, "open"))}</span>}
    </div>
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("为什么要确认", "Why confirm this")}</div>
      <p className="ctx-description">{text(q.why) || uiText(reviewItem.why, reviewItem.whyEn)}</p>
    </section>
    {evidence.length ? <section className="ctx-section">
      <div className="ctx-section-title">{uiText("证据对照", "Evidence")}</div>
      <EvidenceCompare evidence={evidence} onOpen={onOpenEvidence} />
    </section> : null}
    {impact.length ? <section className="ctx-section">
      <div className="ctx-section-title">{uiText("影响范围", "Impacted scope")}</div>
      <ImpactList impact={impact} onOpen={onOpenImpact} />
    </section> : null}
    {reviewItem.title !== text(q.text) ? <div className="ctx-notice">
      {uiText("原始检测：", "Source finding: ")}{text(q.text)}
    </div> : null}
    {!ledgerWritable ? <div className="ctx-notice">
      {legacyConflictWritable
        ? uiText("兼容模式：只能提交已有冲突选项。", "Compatibility mode: only existing conflict options can be submitted.")
        : uiText("只读：这条问题没有可写的 Question Ledger 记录。", "Read-only: this question has no writable ledger record.")}
    </div> : null}
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("结论", "Decision")}</div>
      <textarea
        className="qanswer ctx-review-answer"
        aria-label={uiText("问题答案", "Answer")}
        placeholder={expected}
        value={draft.answer}
        disabled={locked}
        onChange={(event) => put({ answer: event.target.value })}
      />
      <div className="ctx-review-tools">
        <button type="button" className="ctx-inline-action"
          title={uiText("展开这条问题「答成什么样才算数」", "Show what a complete answer must cover")}
          onClick={() => setGuideOpen((open) => !open)}>{uiText("应答要求", "What a good answer contains")}</button>
        <button type="button" className="ctx-inline-action" disabled={busy || !ledgerWritable}
          title={uiText("指定谁来答这条、按什么角色答、有多急；不改变问题结论",
            "Set who answers this, in which role, and how urgent; does not record a conclusion")}
          onClick={() => setAssignOpen((open) => !open)}>{uiText("分派", "Assign")}</button>
      </div>
      {/* 三个写库动作各自的后果写在这里。以前界面上一个字都没有，用户只能靠猜
          （2026-08-25 用户原话：「分派、延期、记录都是什么？」）。 */}
      <p className="ctx-description ctx-review-legend">{uiText(
        "分派＝指定谁来答（不产生结论）；延期＝挂起并记下原因，之后可恢复；记录决定＝把结论写进决策台账并触发相关产物重算。",
        "Assign = choose who answers (no conclusion recorded). Defer = park it with a reason, resumable later. Record decision = write the conclusion into the decision ledger and recompute affected artifacts.",
      )}</p>
      {guideOpen ? <p className="ctx-description ctx-review-guide">{expected}</p> : null}
      {assignOpen ? <div className="ctx-field-grid">
        <input aria-label={uiText("负责人", "Owner")} className="qinput" placeholder={uiText("负责人", "Owner")} value={draft.owner}
          disabled={busy || !ledgerWritable} onChange={(event) => put({ owner: event.target.value })} />
        <select aria-label={uiText("应答角色", "Audience role")} className="qselect" value={draft.role}
          disabled={busy || !ledgerWritable} onChange={(event) => put({ role: event.target.value })}>
          {[...new Set([...ROLE_OPTIONS, draft.role])].map((role) => <option key={role} value={role}>{role || uiText("应答角色", "Audience role")}</option>)}
        </select>
        <select aria-label={uiText("优先级", "Priority")} className="qselect" value={draft.priority}
          disabled={busy || !ledgerWritable} onChange={(event) => put({ priority: event.target.value })}>
          {PRIORITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className="act" disabled={busy || !ledgerWritable}
          onClick={() => { void call(
            () => qSaveMetaWith(sourceIndex, draft),
            { type: "review.assign", title: `已分派：${text(q.text)}`, summary: [draft.owner, draft.role, draft.priority].filter(Boolean).join(" · ") },
            (before, after) => Boolean(after)
              && text(after.owner) === draft.owner.trim()
              && text(after.role) === draft.role
              && text(after.priority, "normal") === (draft.priority || "normal")
              && (text(before?.owner) !== draft.owner.trim()
                || text(before?.role) !== draft.role
                || text(before?.priority, "normal") !== (draft.priority || "normal")
                || text(before?.revision) !== text(after.revision)),
          ); }}>{uiText("保存分派", "Save assignment")}</button>
      </div> : null}
    </section>
    <footer className="ctx-sticky-actions">
      {done
        ? <button type="button" className="act" disabled={busy || !ledgerWritable} onClick={() => { void call(
          () => qReopen(sourceIndex),
          { type: "review.status", title: `重新打开：${text(q.text)}`, summary: "问题已恢复为待处理" },
          (before, after) => ["open", "assigned"].includes(text(after?.status))
            && !["open", "assigned"].includes(text(before?.status)),
        ); }}>{uiText("重新打开", "Reopen")}</button>
        : needsReopen
          ? <button type="button" className="act pri" disabled={busy || !ledgerWritable} onClick={() => { void call(
            () => qReopen(sourceIndex),
            { type: "review.status", title: `恢复待答：${text(q.text)}`, summary: "问题已恢复为待回答" },
            (before, after) => ["open", "assigned"].includes(text(after?.status))
              && !["open", "assigned"].includes(text(before?.status)),
          ); }}>{uiText("恢复待答", "Resume")}</button>
          : <>
            <div className="ctx-review-options" role="group" aria-label={uiText("参考选项", "Answer options")}>
              {options.map((option, index) => {
                const id = text(option.id, String(index));
                return <button
                  type="button"
                  className={`ctx-option ${draft.option === id ? "on" : ""}`}
                  key={id}
                  disabled={locked}
                  onClick={() => put({ option: draft.option === id ? "" : id })}
                >{text(option.label)}</button>;
              })}
            </div>
            <button type="button" className="act" disabled={busy || !ledgerWritable}
              onClick={() => { void call(
                () => qDefer(sourceIndex),
                { type: "review.status", title: `延期：${text(q.text)}`, summary: "等待相关业务人员确认" },
                (before, after) => text(after?.status) === "deferred" && text(before?.status) !== "deferred",
              ); }}
              title={uiText("挂起这条并记下原因（会问你原因），之后可以恢复待答",
                "Park this question with a reason (you will be asked for one); resumable later")}
            >{uiText("延期", "Defer")}</button>
            <button type="button" className="act pri" disabled={busy || !canAnswer} onClick={submit}
              title={uiText("把上面的结论写进决策台账，并触发受影响产物重算",
                "Write the conclusion above into the decision ledger and recompute affected artifacts")}
            >
              {busy ? uiText("保存中…", "Saving…") : uiText("记录决定", "Record decision")}
            </button>
          </>}
    </footer>
  </article>;
}

function ReviewBatchDetail({ item, onOpenQuestion }: {
  item: FdeReviewItem;
  onOpenQuestion: (questionId: string) => void;
}): ReactElement {
  return <article className="ctx-review-detail ctx-review-batch-detail">
    <div className="ctx-review-crumb">{uiText("批次", "Batch")} / {uiText(item.domainLabel, item.domainLabelEn)}</div>
    <div className="ctx-detail-title">{uiText(item.title, item.titleEn)}</div>
    <div className="ctx-review-meta">
      <span className={`ctx-review-level ${item.level}`}>{uiText(...REVIEW_LEVEL_LABEL[item.level])}</span>
      <span className="ctx-badge">{item.authority.active}/{item.questionIds.length} {uiText("待处理", "active")}</span>
      {item.authority.blocking > 0 ? <span className="ctx-badge warning">{item.authority.blocking} {uiText("阻塞", "blocking")}</span> : null}
    </div>
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("为什么合并", "Why this is batched")}</div>
      <p className="ctx-description">{uiText(item.why, item.whyEn)}</p>
    </section>
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("期望获得的答案", "Expected answer")}</div>
      <p className="ctx-description">{uiText(item.expectedAnswer, item.expectedAnswerEn)}</p>
    </section>
    <div className="ctx-notice">{uiText(
      "批次仅用于聚合与排序，不合并 Decision，也不改变任何原始问题的状态。",
      "This batch only groups and ranks questions; it merges no Decision and changes no source status.",
    )}</div>
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("原始问题", "Source questions")}</div>
      <div className="ctx-review-batch-members">
        {item.questions.map((question, index) => <button
          type="button"
          className="ctx-review-batch-member"
          key={question.id}
          onClick={() => onOpenQuestion(question.id)}
        >
          <span>{index + 1}</span>
          <strong>{question.text}</strong>
          <small>{reviewStatusLabel(question.status)}</small>
        </button>)}
      </div>
    </section>
  </article>;
}

type ReviewFilter = "blocking" | "important" | "completeness" | "diagnostic" | "answered" | "all";

function initialReviewFilter(workbench: FdeReviewReadModel): ReviewFilter {
  if (workbench.summary.blockingItems > 0) return "blocking";
  if (workbench.summary.importantItems > 0) return "important";
  if (workbench.summary.completenessItems > 0) return "completeness";
  if (workbench.summary.diagnosticItems > 0) return "diagnostic";
  if (workbench.summary.answeredQuestions > 0) return "answered";
  return "all";
}

function ReviewPanel({
  questions, workbench, query, focusId, modelIndex, artifacts, onOpenEvidence, onOpenImpact, onFocusConsumed,
  directory = false,
}: {
  questions: any[];
  workbench: FdeReviewReadModel;
  query: string;
  focusId?: string;
  modelIndex: Map<string, ModelItem>;
  artifacts: any[];
  onOpenEvidence: (evidence: EvidenceRef) => void;
  onOpenImpact: (ref: ImpactRef) => void;
  onFocusConsumed?: () => void;
  /** 查看器分栏里的目录列：永远显示队列（详情由查看器占据主区），不做二级切换。 */
  directory?: boolean;
}): ReactElement {
  const G = useUi();
  const [filter, setFilter] = useState<ReviewFilter>(() => initialReviewFilter(workbench));
  // 换会话就从队列开始。**复位靠挂载点上的 key**（见 ContextSidebar 里两处
  // `<ReviewPanel key={…}>`）：本地 state 是 useState 初值、只在挂载时读一次，
  // 在 render 里改模块级变量根本改不动它 —— 那样写出来的「复位」是空转，而且
  // 只有在测试里顺手 cleanup() 重挂载时才显得像是生效了。
  const sid = text(G.S?.id);
  if (REVIEW_NAV.sid !== sid) { REVIEW_NAV.sid = sid; REVIEW_NAV.selectedId = ""; REVIEW_NAV.drillQuestionId = ""; }
  const [selectedId, setSelectedIdRaw] = useState(REVIEW_NAV.selectedId);
  const [drillQuestionId, setDrillQuestionIdRaw] = useState(REVIEW_NAV.drillQuestionId);
  const setSelectedId = (value: string): void => { REVIEW_NAV.selectedId = value; setSelectedIdRaw(value); };
  const setDrillQuestionId = (value: string): void => { REVIEW_NAV.drillQuestionId = value; setDrillQuestionIdRaw(value); };
  const consumedFocusId = useRef("");
  useEffect(() => {
    if (!focusId) {
      consumedFocusId.current = "";
      return;
    }
    if (consumedFocusId.current === focusId) return;
    const item = workbench.items.find((candidate) => candidate.questionIds.includes(focusId));
    if (!item) return;
    consumedFocusId.current = focusId;
    setFilter("all");
    setSelectedId(item.id);
    setDrillQuestionId(item.mode === "batch" ? focusId : "");
    onFocusConsumed?.();
  }, [focusId, onFocusConsumed, workbench.items]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = workbench.items.filter((item) => {
    // “已处理”只表示原问题均为 answered/cancelled；deferred 仍是待跟进，不能冒充完成。
    if (filter === "answered" && item.authority.answered !== item.questionIds.length) return false;
    if (["blocking", "important", "completeness", "diagnostic"].includes(filter)
      && (item.level !== filter || item.authority.active === 0)) return false;
    return !normalizedQuery || item.searchText.includes(normalizedQuery);
  });
  // 两级导航：不自动展开第一条 —— 一级只有队列，点了才进详情（窄侧栏里队列+详情
  // 堆一屏是 2026-08-25 用户点名的拥挤问题）。目录列除外：查看器占着主区，
  // 目录列固定当队列用，选中态留着等查看器关掉后回到详情。
  const selected = directory ? null : filtered.find((item) => item.id === selectedId) || null;
  const selectedQuestionId = selected?.mode === "question" ? selected.primaryQuestionId : drillQuestionId;
  const selectedQuestion = selectedQuestionId
    ? questions.find((question) => text(question.id) === selectedQuestionId) ?? null
    : null;
  const selectedSourceIndex = selectedQuestion
    ? G.Q_BACKLOG.findIndex((item: any) => text(item.id) === text(selectedQuestion.id))
    : -1;
  const reload = async (): Promise<void> => { await loadQuestions(); bumpUi(); };
  const levelCount = (level: FdeReviewLevel): number => workbench.items
    .filter((item) => item.level === level && item.authority.active > 0).length;
  const visibleGroups = workbench.groups.map((group) => ({
    ...group,
    items: filtered.filter((item) => item.domain === group.id),
  })).filter((group) => group.items.length > 0);
  const codes = new Map(questions.map((question, index) => [text(question.id), questionCode(question, index)]));
  const queueMeta = (item: FdeReviewItem): string => item.mode === "batch"
    ? uiText(`${item.questionIds.length} 条 · ${item.domainLabel}`, `${item.questionIds.length} items · ${item.domainLabelEn}`)
    : [uiText(item.domainLabel, item.domainLabelEn), item.status === "open" ? "" : reviewStatusLabel(item.status)]
      .filter(Boolean).join(" · ");
  const FILTERS: Array<[ReviewFilter, string, string, number | null]> = [
    ["blocking", "阻塞", "Blocking", levelCount("blocking")],
    ["important", "重要", "Important", levelCount("important")],
    ["completeness", "完整性", "Completeness", levelCount("completeness")],
    ["diagnostic", "批量", "Batch", levelCount("diagnostic")],
    ["answered", "已处理", "Resolved", null],
    ["all", "全部", "All", workbench.summary.visibleItems],
  ];
  const backToQueue = (): void => { setSelectedId(""); setDrillQuestionId(""); };
  return <div className="ctx-review-panel">
    <div className="ctx-review-grid">
      {selected ? null : <div className="ctx-review-queue">
        <header className="ctx-review-queue-head">
          <strong>{uiText("审阅队列", "Review queue")}</strong>
          <button type="button" className="ctx-head-action" onClick={() => { void reload(); }}>{uiText("刷新", "Refresh")}</button>
        </header>
        <div className="ctx-filters" role="group" aria-label={uiText("审阅筛选", "Review filters")}>
          {FILTERS.map(([key, zh, en, count]) => <button
            type="button"
            className={`ctx-filter ${filter === key ? "on" : ""}`}
            key={key}
            onClick={() => { setFilter(key); setDrillQuestionId(""); }}
          >{uiText(zh, en)}{count === null ? "" : ` ${count}`}</button>)}
        </div>
        {/* 「一条问题都没有」和「这个筛选下没有」是两件事：前者要么还没跑过检查、
            要么已经全部处理完，两种都该说清楚，而不是让人去改筛选。 */}
        {!filtered.length ? <SidebarEmpty label="REVIEW">{questions.length === 0
          ? uiText("还没有待确认问题。让它先跑一轮检查，或者直接问「现在模型有什么问题」。",
            "No questions yet. Run a check, or just ask what is wrong with the model.")
          : uiText(`这个筛选下没有 —— 全部 ${questions.length} 条里换一档看看`,
            `Nothing under this filter — try another of the ${questions.length} questions`)}</SidebarEmpty>
          : <div className="ctx-review-list" role="listbox" aria-label={uiText("FDE 审阅队列", "FDE review queue")}>
            {visibleGroups.map((group) => <section className="ctx-review-domain" key={group.id}>
              <header>
                <strong>{uiText(group.label, group.labelEn)}</strong>
                <span>{group.questionCount}</span>
              </header>
              {group.items.map((item) => <button
                type="button"
                role="option"
                aria-selected={selectedId === item.id}
                className={`ctx-review-item ${selectedId === item.id ? "on" : ""}`}
                key={item.id}
                onClick={() => { setSelectedId(item.id); setDrillQuestionId(""); }}
              >
                <span className={`ctx-review-dot ${item.level}`} aria-hidden="true"></span>
                <span className="ctx-review-item-copy">
                  <strong>{uiText(item.title, item.titleEn)}</strong>
                  <small>{queueMeta(item)}</small>
                </span>
                <span className="ctx-review-chevron" aria-hidden="true">›</span>
              </button>)}
            </section>)}
          </div>}
      </div>}
      {selectedQuestion && selected ? <div className="ctx-review-detail-wrap">
        {selected.mode === "batch"
          ? <button type="button" className="ctx-context-back"
            onClick={() => setDrillQuestionId("")}>{uiText("返回批次", "Back to batch")}</button>
          : <button type="button" className="ctx-context-back ctx-review-back"
            onClick={backToQueue}>‹ {uiText("返回审阅队列", "Back to review queue")}</button>}
        <ReviewQuestionDetail
          key={`${selectedQuestion.id}:${selectedQuestion.revision ?? ""}:${selectedQuestion.answer ?? ""}`}
          q={selectedQuestion}
          reviewItem={selected}
          sourceIndex={selectedSourceIndex}
          code={codes.get(text(selectedQuestion.id)) || questionCode(selectedQuestion, 0)}
          impact={impactRefs(selectedQuestion, modelIndex, artifacts)}
          onOpenEvidence={onOpenEvidence}
          onOpenImpact={onOpenImpact}
        />
      </div> : selected ? <div className="ctx-review-detail-wrap">
        <button type="button" className="ctx-context-back ctx-review-back"
          onClick={backToQueue}>‹ {uiText("返回审阅队列", "Back to review queue")}</button>
        <ReviewBatchDetail item={selected} onOpenQuestion={setDrillQuestionId} />
      </div> : null}
    </div>
  </div>;
}

function artifactName(artifact: any): string {
  return text(artifact?.name || artifact?.filename || artifact?.file || artifact);
}

/** 一行产物。分组视图与搜索视图共用 —— 两处各写一份迟早漂开。 */
function ArtifactRow({ sid, artifact, onOpen }: {
  sid: string;
  artifact: any;
  onOpen: (target: ContextViewerTarget) => void;
}): ReactElement {
  const name = artifactName(artifact);
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : "FILE";
  return <button type="button" className="ctx-artifact" onClick={() => onOpen(artifactTarget(sid, artifact))}>
    <span className="ctx-kind">{extension}</span>
    <span className="ctx-item-main">
      <strong>{name || "未命名产物"}</strong>
      <small>{text(artifact?.description || artifact?.status, "当前会话产物")}</small>
    </span>
    <span className="ctx-download-label">{uiText("预览", "Preview")}</span>
  </button>;
}

/**
 * P3：按产物类型措辞的迭代开场白。类型只影响**说法**（流程说"调整节点/分支"，
 * 清单说"增删改条目"），路由与执行都交给模型 —— 它有 oir.edit/flow.edit/
 * template.edit 与重导工具，比在 UI 里硬编一套动作分派可靠。
 */
export function iteratePrompt(title: string): string {
  if (/流程|flow/iu.test(title)) {
    return `我想调整流程「${title}」：（说明要改的节点、连线或分支；改完请重新生成流程图与相关文档）`;
  }
  if (/问题|清单|questions/iu.test(title)) {
    return `我想更新「${title}」：（说明要增删改哪些条目；改完请重新导出）`;
  }
  if (/模板|template/iu.test(title)) {
    return `我想调整模板「${title}」：（说明要改的列/字段或填写规则；改完请重新导出）`;
  }
  return `我想迭代「${title}」的内容：（说明要改什么；请先改模型再重新导出这份文档）`;
}

function DeliveryPanel({ artifacts, questions, query, onOpen }: {
  artifacts: any[];
  questions: any[];
  query: string;
  onOpen: (target: ContextViewerTarget) => void;
}): ReactElement {
  const G = useUi();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const searching = query.trim() !== "";
  const filtered = artifacts.filter((artifact) => !query || artifactName(artifact).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const groups = groupDeliveryArtifacts(filtered);
  const active = questions.filter((q) => ["open", "assigned", "blocked"].includes(text(q.status)));
  const blockers = active.filter((q) => text(q.priority) === "blocking" || rows(q.blockedArtifacts).length);
  const release = releaseState(questions, text(G.S?.status));
  const sid = encodeURIComponent(G.S.id);
  return <div className="ctx-delivery-panel">
    <section className="ctx-hero-card">
      <div className="ctx-hero-row">
        <div className="ctx-detail-title">{release}</div>
        {blockers.length ? <span className="ctx-badge warning">{blockers.length} {uiText("个阻塞", "blocking")}</span>
          : active.length ? <span className="ctx-badge">{active.length} {uiText("个待确认", "open")}</span> : null}
      </div>
      <div className="ctx-actions">
        {release === "BLOCKED"
          ? <span className="act disabled" aria-disabled="true">交付包 · BLOCKED</span>
          : <span onClickCapture={() => contextSyncStore.publish({
            type: "delivery.export",
            title: "下载交付包",
            summary: release === "DRAFT" ? "交付包包含待澄清项，已标记为草稿" : "正式交付包",
            artifactIds: ["bundle"],
          })}><BundleLink label="下载交付包" className="act pri" /></span>}
        {G.Q_API ? ["xlsx", "md", "json"].map((format) => <a
          className="act" download key={format}
          href={`${API}/api/sessions/${sid}/questions/export?format=${format}`}
          onClick={() => contextSyncStore.publish({
            type: "delivery.export",
            title: `导出问题清单 ${format.toUpperCase()}`,
            summary: `${questions.length} 个问题`,
            artifactIds: [`questions.${format}`],
          })}
        >{uiText("问题清单", "Questions")} {format.toUpperCase()}</a>) : null}
      </div>
    </section>
    <section className="ctx-section">
      <div className="ctx-section-title">{uiText("产物", "Artifacts")}</div>
      {/* 空态要说**差什么才能生成**，不是只说没有 */}
      {!filtered.length ? <SidebarEmpty label="DELIVERY">{artifacts.length === 0
        ? (blockers.length
          ? uiText(`还没有产物。先把 ${blockers.length} 个阻塞问题处理掉，再生成交付包。`,
            `No artifacts yet. Resolve the ${blockers.length} blocking questions first.`)
          : uiText("还没有产物。模型梳理完之后，在下面说「生成交付包」就能出。",
            "No artifacts yet. Once the model is in shape, ask for the delivery bundle below."))
        : uiText("这个筛选下没有产物 —— 清空搜索看全部",
          "No artifacts under this filter — clear the search to see all")}</SidebarEmpty>
        : searching
          // 搜索时不分组：人已经知道自己在找什么，这时分组只会多一层要展开的壳。
          ? <div className="ctx-delivery-list">
            {filtered.map((artifact, index) => <ArtifactRow key={artifactName(artifact) || index}
              sid={G.S.id} artifact={artifact} onOpen={onOpen} />)}
          </div>
          : <div className="ctx-delivery-list">
            {groups.documents.map((doc) => <div className="ctx-delivery-doc" key={doc.title}>
              <div className="ctx-delivery-doc-main">
                <strong className="ctx-delivery-doc-title">{doc.title}</strong>
                <small>{uiText("交给业务方的文档", "For the business side")}</small>
              </div>
              <div className="ctx-delivery-formats">
                {doc.formats.map((format) => <button
                  type="button"
                  className="ctx-format"
                  key={format.name}
                  title={uiText(`预览 ${format.name}`, `Preview ${format.name}`)}
                  onClick={() => onOpen(artifactTarget(G.S.id, format.artifact))}
                >{format.ext}</button>)}
                {/* P3 产物迭代：每份文档都能"改了再出"。入口只是预填一句按
                    类型措辞的话（走对话与模型权限）——产物是模型的投影，
                    迭代改的是模型，改完重导，文件跟着版本走。 */}
                <button
                  type="button"
                  className="ctx-format ctx-iterate"
                  title={uiText(`迭代「${doc.title}」`, `Iterate ${doc.title}`)}
                  onClick={() => prefillComposer(iteratePrompt(doc.title), { mode: "replace" })}
                >{uiText("迭代", "Iterate")}</button>
              </div>
            </div>)}
            {/* 机器视图默认收起来，但**必须说清有多少个** —— 折叠是收纳，
                不是让人以为产物变少了。展开后每个照样可点。 */}
            {groups.snapshots.length ? <>
              <button type="button" className="ctx-snapshot-toggle"
                aria-expanded={snapshotsOpen}
                onClick={() => setSnapshotsOpen((open) => !open)}
              >{snapshotsOpen ? "▾" : "▸"} {uiText(
                `模型快照 · ${groups.snapshots.length} 个机器视图`,
                `Model snapshot · ${groups.snapshots.length} machine views`)}</button>
              {snapshotsOpen ? groups.snapshots.map((snapshot) => <ArtifactRow key={artifactName(snapshot)}
                sid={G.S.id} artifact={snapshot} onOpen={onOpen} />) : null}
            </> : null}
          </div>}
    </section>
  </div>;
}

export function ContextSidebar({
  context = null,
  initialSection = "model",
  onSectionChange,
}: ContextSidebarProps = {}): ReactElement {
  const G = useUi();
  const resourceTabs = useWorkbenchTabs<ContextViewerTarget>(text(G.S?.id));
  const [section, setSection] = useState<ContextSection>(() => sectionFromTab(G.TAB)?.startsWith("model")
    ? "model"
    : initialSection);
  const [query, setQuery] = useState("");
  const [reviewFocusId, setReviewFocusId] = useState("");
  const [modelFocusId, setModelFocusId] = useState("");
  // **选中项和类型筛选必须活在 viewer 外面。**
  // 右栏默认 440px，而 split 视图要 ≥680px 才启用 —— 对绝大多数用户，
  // 打开一条证据或画布走的是「viewer 顶掉 body」这一支，ModelPanel 整个 unmount，
  // 它的 useState 全部销毁。而「看断言 → 翻出处 → 回来接着核对下一条」
  // 正是 FDE 的标准动作：以前每翻一次出处，就丢一次位置和筛选。
  const [modelSelectedId, setModelSelectedId] = useState("");
  const [modelKind, setModelKind] = useState<ModelKind | "all" | "todo">("all");
  const previousTab = useRef(G.TAB);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (G.TAB === previousTab.current) return;
    previousTab.current = G.TAB;
    const mapped = sectionFromTab(G.TAB);
    if (mapped) setSection(mapped);
  }, [G.TAB]);

  useEffect(() => {
    if (section !== "review" || !G.S) return;
    let active = true;
    void loadQuestions().then(() => { if (active) bumpUi(); });
    return () => { active = false; };
  }, [G.S?.id, section]);

  useEffect(() => {
    const focusSearch = (event: any): void => {
      if (!(event.metaKey || event.ctrlKey) || String(event.key).toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // 网页搜索、聊天引用或未来的文件选择器都走同一条 UI 事件合同。tab store 不知道
  // 后端怎样抓网页；它只接收一个可序列化资源 target，并负责去重与恢复。
  useEffect(() => {
    const openResource = (event: any): void => {
      const target = normalizeWorkbenchTarget<ContextViewerTarget>(event?.detail);
      if (target) resourceTabs.open(target);
    };
    window.addEventListener(WORKBENCH_OPEN_EVENT, openResource);
    return () => window.removeEventListener(WORKBENCH_OPEN_EVENT, openResource);
  }, [resourceTabs.open]);

  const activate = (next: ContextSection): void => {
    setSection(next);
    STATE.TAB = next;
    STATE.CONTEXT_BACK = null;
    previousTab.current = next;
    bumpUi();
    onSectionChange?.(next);
  };

  const state = G.S?.state || {};
  const rawOir = context?.oir || state.oir || {};
  const oir = useMemo(() => (rows(rawOir.events).length || !rows(state.ontology_package?.events).length
    ? rawOir
    : { ...rawOir, events: state.ontology_package.events }), [rawOir, state.ontology_package]);
  const flow = context?.flow || state.flow || {};
  const sketch = context?.sketch || state.sketch || {};
  const rawQuestions = context?.questions?.length
    ? context.questions
    : G.Q_BACKLOG.length
      ? G.Q_BACKLOG
      : [...rows(oir.questions), ...rows(state.questions), ...rows(state.conflicts)];
  const questions = rawQuestions.map((question, index) => question?.applies && question?.options
    ? question
    : normalizeQuestion(question, question?.source || `context:${index}`));
  // 每次都从 live ledger 投影重建：/context 提供首次快照，回答/延期/重新打开后
  // G.Q_BACKLOG 会覆盖它。纯 helper 不写 Question，因此不会产生第二套状态机。
  const reviewWorkbench = buildFdeReviewReadModel(questions);
  const artifacts = context?.artifacts || rows(state.artifacts);
  const revision = revisionOf(G, context);
  // 模型目录只算一次：模型页要用它渲染列表，审阅页要用它把 applies 解析成
  // 可跳转的影响范围。两处各算一遍会在几百个对象时明显拖慢输入框。
  const items = useMemo(() => modelItems(oir, flow, questions), [oir, flow, questions]);
  const modelIndex = useMemo(() => {
    const index = new Map<string, ModelItem>();
    for (const item of items) {
      for (const ref of [item.id, item.api, item.label].filter(Boolean)) {
        if (!index.has(ref)) index.set(ref, item);
      }
    }
    return index;
  }, [items]);
  const openTarget = (target: ContextViewerTarget): void => {
    resourceTabs.open(workbenchTargetFromViewer(target));
    if (target.type === "artifact") {
      contextSyncStore.focus({
        source: "sidebar",
        section: "delivery",
        label: target.title,
        artifactIds: [target.id.replace(/^artifact:/u, "")],
      });
    } else if (target.type === "material" || target.type === "evidence") {
      contextSyncStore.focus({
        source: "sidebar",
        section: "evidence",
        label: target.title,
        evidenceIds: [target.cite || target.id],
      });
    } else {
      contextSyncStore.focus({
        source: "sidebar",
        section: "model",
        label: target.title,
        canvasNodeIds: target.selectedId ? [target.selectedId] : [],
      });
    }
  };
  const openEvidence = (evidence: EvidenceRef): void => {
    const fileName = evidence.file || evidence.cite.split(/[!#]/u)[0] || "";
    if (!fileName) return;
    openTarget(materialTarget(G.S.id, fileName, evidence.cite, evidence.snippet));
  };
  const openGraph = (item?: ModelItem): void => {
    const graphArtifact = artifacts.find((artifact) => /(?:流程|flow|workflow).*(?:\.svg|\.png)$/iu.test(artifactName(artifact)))
      || artifacts.find((artifact) => /\.svg$|\.png$/iu.test(artifactName(artifact)));
    const downloadUrl = graphArtifact ? artifactUrl(G.S.id, graphArtifact) : "";
    openTarget({
      id: `graph:${revision}:${item?.id || "all"}`,
      type: "graph",
      title: item ? `${item.label} · 工作流画布` : "Ontology 工作流画布",
      format: "graph",
      extension: graphArtifact ? extensionOf(artifactName(graphArtifact)) : "",
      url: previewApiUrl(G.S.id, "model", "flow"),
      downloadUrl,
      sourceLabel: item ? `模型定位 · ${item.api || item.id}` : "",
      fileName: graphArtifact ? artifactName(graphArtifact) : "",
      cite: "",
      snippet: "",
      flow,
      oir,
      // 只把独立的 sketch 命名空间带给查看器；modelItems / 项目计数 / artifacts
      // 仍然只接收上面的正式 flow，因此参考图出现也不会制造“已有模型”的假象。
      sketch,
      // 流程项在右栏叫 `process:${key}`，画布节点叫 `workflow:${key}` —— 前缀就对不上，
      // 于是选中永远命不中。统一成画布那一套。
      ...(item ? {
        selectedId: item.kind === "process" ? item.id.replace(/^process:/u, "workflow:") : item.id,
        graphMode: item.kind === "object" ? "objects" as const : "workflow" as const,
      } : {}),
    });
  };
  const openReview = (id: string): void => {
    resourceTabs.activate(WORKBENCH_TAB_ID);
    setReviewFocusId(id);
    setSection("review");
    STATE.TAB = "review";
    previousTab.current = "review";
    bumpUi();
  };

  const openImpact = (ref: ImpactRef): void => {
    if (ref.target === "artifact") {
      const artifact = artifacts.find((candidate) => artifactName(candidate) === ref.label);
      if (artifact) openTarget(artifactTarget(G.S.id, artifact));
      return;
    }
    const item = modelIndex.get(ref.id) || modelIndex.get(ref.label);
    if (!item) return;
    setModelFocusId(item.id);
    setSection("model");
    STATE.TAB = "model";
    previousTab.current = "model";
    bumpUi();
  };

  const hits = searchHits(query, {
    files: rows(G.S?.filelist), items, questions, artifacts, events: rows(G.S?.events),
  });

  let body: ReactNode;
  if (!G.S) body = <SidebarEmpty label="CONTEXT">{uiText("打开一个会话后显示项目上下文", "Open a session to see the project context")}</SidebarEmpty>;
  else if (section === "project") body = <ProjectPanel questions={questions} onNavigate={activate} />;
  else if (section === "evidence") body = <EvidencePanel query={query} onOpen={openTarget} />;
  else if (section === "model") body = <ModelPanel items={items} query={query} focusId={modelFocusId}
    selectedId={modelSelectedId} onSelect={setModelSelectedId}
    kind={modelKind} onKindChange={setModelKind}
    onFocusConsumed={() => setModelFocusId("")} onOpenEvidence={openEvidence} onOpenGraph={openGraph} />;
  else if (section === "review") body = <ReviewPanel key={text(G.S?.id)}
    questions={questions} workbench={reviewWorkbench} query={query}
    focusId={reviewFocusId} modelIndex={modelIndex} artifacts={artifacts}
    onFocusConsumed={() => setReviewFocusId("")} onOpenEvidence={openEvidence} onOpenImpact={openImpact} />;
  else if (section === "delivery") body = <DeliveryPanel artifacts={artifacts} questions={questions} query={query} onOpen={openTarget} />;
  else body = <RuntimePanel query={query} />;

  const resourceActive = resourceTabs.state.activeId !== WORKBENCH_TAB_ID;
  const workbenchPage = <div className="ctx-sidebar" data-section={section} data-viewer={resourceActive ? "1" : ""}>
    <div className="ctx-sidebar-head">
      <div>
        <div className="ctx-sidebar-title">{section === "runtime"
          ? uiText("运行详情", "Runtime details")
          : uiText("项目上下文", "Project context")}</div>
      </div>
      <div className="ctx-sidebar-tools">
        <button type="button" className="ctx-head-action" onClick={togglePreview}>{uiText("收起", "Collapse")}</button>
      </div>
    </div>
    {/* **诚实的本页筛选，不是全局搜索。**
        它长得像全局搜索（固定在 tab 栏上方、占一整行、带 ⌘K），实际上 query
        只传给四个面板，各家匹配口径还完全不同：交付页只按产物文件名过滤、
        文件页按文件名/状态、模型页按 searchText、审阅页按问题文本，而项目页
        根本不收它。FDE 在交付页搜「采购申请」看到「还没有产物」，会判定这个
        项目里没有这个词 —— 而模型页里明明有这个对象。
        做成真的跨 tab 是另一件事（要一个带分组命中数的下拉）；在那之前，
        **控件必须说清楚自己是什么**，并且在不收它的页面上不出现。 */}
    <div className="ctx-search-wrap">
      <label className="ctx-search">
        <span className="ctx-visually-hidden">{uiText("搜索项目上下文", "Search project context")}</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={section === "project"
            ? uiText("搜文件、对象、待确认、产物…", "Search files, model, review, artifacts…")
            : (SEARCH_HINT[section] ?? uiText("在本页筛选…", "Filter this page…"))}
        />
        <span className="ctx-search-shortcut" aria-hidden="true">⌘K</span>
      </label>
      {/* 按 tab 分组给命中数 —— 「这个词在这个项目里到底有没有」现在一眼能答，
          而且**不用挨个 tab 试**。当前页那一档也列出来（标 on），
          否则用户会以为"这一页没命中"。 */}
      {hits.length > 0 ? <div className="ctx-search-hits" role="listbox"
        aria-label={uiText("按分区的命中数", "Hits by section")}>
        {hits.map((hit) => (
          <button type="button" key={hit.section}
            className={`ctx-search-hit ${section === hit.section ? "on" : ""}`}
            onClick={() => activate(hit.section)}>
            {hit.label} <b>{hit.count}</b>
          </button>
        ))}
      </div> : null}
      {query.trim() && hits.length === 0 ? <div className="ctx-search-hits">
        <span className="ctx-search-none">{uiText("这个项目里没有匹配的内容", "Nothing in this project matches")}</span>
      </div> : null}
    </div>
    <nav className="ctx-nav" aria-label={uiText("项目上下文导航", "Project context navigation")} role="tablist">
      {NAV.map(([key, zh, en]) => <button
        type="button"
        role="tab"
        aria-selected={section === key}
        className={`ctx-nav-item ${section === key ? "on" : ""}`}
        key={key}
        onClick={() => activate(key)}
      >{uiText(zh, en)}</button>)}
    </nav>
    <div className="ctx-body" role="tabpanel">{body}</div>
  </div>;

  const renderWorkbenchResource = (
    target: WorkbenchResourceTarget<ContextViewerTarget>,
    tab: WorkbenchResourceTab<ContextViewerTarget>,
  ): ReactNode => {
    if (target.kind === "web" && target.url && G.S?.id) {
      const webUrl = target.url;
      const restoredLiveUrl = normalizeWebPreviewUrl(target.viewState?.liveUrl);
      const currentWebUrl = restoredLiveUrl || webUrl;
      const currentPageId = currentWebUrl === webUrl ? target.pageId : undefined;
      const historyState = normalizeWebPreviewHistoryState(target.viewState?.webHistory, {
        url: currentWebUrl,
        ...(currentPageId ? { pageId: currentPageId } : {}),
      });
      const updatePage = (page: WebPreviewPage): void => {
        resourceTabs.updateWithoutActivate(tab.id, {
          pageId: page.id,
          url: page.finalUrl || page.url || webUrl,
          title: page.title || target.title,
          viewState: {
            digest: page.digest,
            fetchedAt: page.fetchedAt,
            status: page.status,
          },
        });
      };
      const markSaved = (receipt: WebPreviewMaterialReceipt, page: WebPreviewPage): void => {
        resourceTabs.updateWithoutActivate(tab.id, {
          pageId: page.id,
          title: page.title || target.title,
          viewState: {
            digest: page.digest,
            savedAssetId: receipt.id,
            savedAt: receipt.savedAt,
          },
        });
        // `save` commits the canonical AssetMemory on the server.  Pull only
        // that durable projection back into the current UI snapshot so the
        // existing「文件」page can show the new webpage immediately, without
        // making the FDE reload or reopen the conversation.  Guard the sid in
        // case the user switches sessions while this small refresh is in
        // flight; a late response must never leak assets across sessions.
        const savedSid = text(G.S?.id);
        void fetch(`${API}/api/sessions/${encodeURIComponent(savedSid)}/state`, {
          credentials: "same-origin",
        }).then(async (response) => {
          if (!response.ok) return;
          const snapshot = await response.json() as Record<string, any>;
          if (text(G.S?.id) !== savedSid) return;
          const assetMemory = snapshot?.state?.asset_memory;
          if (!assetMemory || typeof assetMemory !== "object") return;
          G.S.state = G.S.state && typeof G.S.state === "object" ? G.S.state : {};
          G.S.state.asset_memory = assetMemory;
          bumpUi();
        }).catch(() => { /* save succeeded; the next normal state refresh will reconcile */ });
      };
      const updateHistory = (next: WebPreviewHistoryState): void => {
        resourceTabs.updateWithoutActivate(tab.id, { viewState: { webHistory: next } });
      };
      const updateLivePage = (frame: LiveBrowserFrame): void => {
        resourceTabs.updateWithoutActivate(tab.id, {
          title: frame.title || target.title,
          viewState: {
            liveUrl: frame.url,
            liveTitle: frame.title,
            liveSeq: frame.seq,
            liveUpdatedAt: frame.updatedAt,
          },
        });
      };
      return <WebPreview
        sessionId={text(G.S.id)}
        target={{ url: currentWebUrl, ...(currentPageId ? { pageId: currentPageId } : {}) }}
        active={resourceTabs.state.activeId === tab.id}
        initialHistoryState={historyState}
        onHistoryStateChange={updateHistory}
        onPageChange={updatePage}
        onLivePageChange={updateLivePage}
        onMaterialSaved={markSaved}
      />;
    }

    const viewerTarget = viewerFromWorkbenchTarget(target, { flow, oir, sketch });
    if (viewerTarget) return <ContextViewer target={viewerTarget} questions={questions}
      onBack={() => resourceTabs.activate(WORKBENCH_TAB_ID)}
      onEvidence={openEvidence} onReview={openReview} />;

    return <div className="wb-resource-unavailable">
      <div className="ctx-empty-label">{target.kind === "web" ? "WEB" : "RESOURCE"}</div>
      <strong>{target.title}</strong>
      <p>{uiText(
        "这份资源的定位信息已经恢复，但当前会话还没有可渲染的内容。",
        "This resource tab was restored, but the current session has no renderable content for it.",
      )}</p>
      {target.url ? <a className="act" href={target.url} target="_blank" rel="noreferrer">
        {uiText("在外部打开", "Open externally")}
      </a> : null}
    </div>;
  };

  return <WorkbenchTabShell
    controller={resourceTabs}
    workbench={workbenchPage}
    renderResource={renderWorkbenchResource} />;
}

export default ContextSidebar;
