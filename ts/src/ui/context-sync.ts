/**
 * 聊天主界面 ⇄ 五区项目上下文栏的轻量同步协议。
 *
 * 本模块只做三件事：
 * 1. 把侧栏里已经落地的有意义操作收口成稳定 ContextChangeReceipt；
 * 2. 给 React / 旧命令式代码提供同一份可订阅 store 与 CustomEvent 桥；
 * 3. 把一条回执安全地引用进 #cin，并把相同引用广播回侧栏。
 *
 * 它不写后端、不碰 #stream/#pbody 结构，也不把回执伪装成 dialogue turn。聊天区可在
 * <Stream> 的 <ChatChips/> 前订阅 recent receipts 画一条轻量提示；侧栏可订阅
 * activeReference 聚焦模型、问题或证据。这样两边仍各自拥有自己的 DOM。
 */

import { G } from "./state.js";

export const CONTEXT_CHANGE_SCHEMA = "ontocopilot.context-change/1" as const;
export const CONTEXT_FOCUS_SCHEMA = "ontocopilot.context-focus/1" as const;
export const CANVAS_NODE_REFERENCE_SCHEMA = "ontocopilot.canvas-node-reference/1" as const;
export const GENERIC_SCENARIO_DRAFT_SCHEMA = "ontocopilot.generic-scenario-draft/1" as const;

/** UI → store 的请求事件；store → UI 的通知事件刻意分名，避免事件回环。 */
export const CONTEXT_CHANGE_REQUEST_EVENT = "ontocopilot:context-change-request";
export const CONTEXT_CHANGE_EVENT = "ontocopilot:context-change";
export const CONTEXT_FOCUS_REQUEST_EVENT = "ontocopilot:context-focus-request";
export const CONTEXT_FOCUS_EVENT = "ontocopilot:context-focus";

export type ContextChangeType =
  | "review.answer"
  | "review.assign"
  | "review.status"
  | "model.select"
  | "model.confirm"
  | "evidence.locate"
  | "delivery.select"
  | "delivery.export"
  | "context.update";

export type ContextSyncSection = "project" | "evidence" | "model" | "review" | "delivery";
export type ContextChangeOrigin = "sidebar" | "chat" | "system";
export type ContextFocusSource = "chat" | "receipt" | "sidebar" | "system";

export interface ContextReferences {
  entityIds: readonly string[];
  questionIds: readonly string[];
  evidenceIds: readonly string[];
  artifactIds: readonly string[];
  canvasNodeIds: readonly string[];
}

export interface ContextChangeReceipt {
  schemaVersion: typeof CONTEXT_CHANGE_SCHEMA;
  id: string;
  sessionId: string;
  type: ContextChangeType;
  section: ContextSyncSection;
  origin: ContextChangeOrigin;
  title: string;
  summary: string;
  refs: ContextReferences;
  revision: string;
  createdAt: string;
}

export interface ContextChangeInput {
  type: ContextChangeType | string;
  title: unknown;
  summary?: unknown;
  section?: ContextSyncSection | string;
  origin?: ContextChangeOrigin | string;
  refs?: Partial<Record<keyof ContextReferences, unknown>> | null;
  /** 简单调用点可传单个引用，不必先造 refs 对象。 */
  entityIds?: unknown;
  questionIds?: unknown;
  evidenceIds?: unknown;
  artifactIds?: unknown;
  canvasNodeIds?: unknown;
  sessionId?: unknown;
  revision?: unknown;
  createdAt?: string | number | Date;
}

export interface ContextFocusReference {
  schemaVersion: typeof CONTEXT_FOCUS_SCHEMA;
  id: string;
  sessionId: string;
  source: ContextFocusSource;
  section: ContextSyncSection;
  label: string;
  receiptId: string;
  refs: ContextReferences;
  createdAt: string;
}

export interface ContextFocusInput {
  source?: ContextFocusSource | string;
  section?: ContextSyncSection | string;
  label?: unknown;
  receiptId?: unknown;
  refs?: Partial<Record<keyof ContextReferences, unknown>> | null;
  entityIds?: unknown;
  questionIds?: unknown;
  evidenceIds?: unknown;
  artifactIds?: unknown;
  canvasNodeIds?: unknown;
  sessionId?: unknown;
  createdAt?: string | number | Date;
}

export type CanvasNodeType = "ontology" | "workflow" | "action" | "event" | "object" | "rule" | "unknown";

export interface CanvasNodeReferenceInput {
  id?: unknown;
  nodeId?: unknown;
  type?: unknown;
  nodeType?: unknown;
  kind?: unknown;
  label?: unknown;
  title?: unknown;
  sessionId?: unknown;
  revision?: unknown;
  refs?: Partial<Record<keyof ContextReferences, unknown>> | null;
  entityIds?: unknown;
  questionIds?: unknown;
  evidenceIds?: unknown;
  artifactIds?: unknown;
  canvasNodeIds?: unknown;
}

export interface CanvasNodeReference {
  schemaVersion: typeof CANVAS_NODE_REFERENCE_SCHEMA;
  id: string;
  sessionId: string;
  section: "model";
  nodeId: string;
  nodeType: CanvasNodeType;
  label: string;
  revision: string;
  refs: ContextReferences;
}

export type GenericDraftOutputType = "Ontology" | "Workflow" | "Action" | "Event";

export interface GenericScenarioDraftInput {
  schemaVersion?: typeof GENERIC_SCENARIO_DRAFT_SCHEMA;
  scenario: unknown;
  outputType: GenericDraftOutputType | string;
  assumptions?: readonly unknown[];
  validationFocus?: readonly unknown[];
  refs?: Partial<Record<keyof ContextReferences, unknown>> | null;
  entityIds?: unknown;
  questionIds?: unknown;
  evidenceIds?: unknown;
  artifactIds?: unknown;
  canvasNodeIds?: unknown;
}

export interface ContextSyncSnapshot {
  readonly version: number;
  /** 时间正序；呈现最近 N 条时用 selectRecentContextReceipts。 */
  readonly receipts: readonly ContextChangeReceipt[];
  readonly dismissedIds: readonly string[];
  readonly activeReference: ContextFocusReference | null;
}

export type ContextSyncStoreEvent =
  | { readonly kind: "receipt.published"; readonly receipt: ContextChangeReceipt }
  | { readonly kind: "receipt.dismissed"; readonly receiptId: string }
  | { readonly kind: "reference.focused"; readonly reference: ContextFocusReference }
  | { readonly kind: "reference.cleared" };

export interface ContextSyncStore {
  getSnapshot(): ContextSyncSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: ContextSyncStoreEvent) => void): () => void;
  publish(input: ContextChangeInput): ContextChangeReceipt;
  getReceipt(id: unknown): ContextChangeReceipt | null;
  dismissReceipt(id: unknown): boolean;
  clearReceipts(sessionId?: unknown): void;
  focus(input: ContextFocusInput): ContextFocusReference;
  focusReceipt(receiptId: unknown, source?: ContextFocusSource): ContextFocusReference | null;
  clearFocus(): void;
}

export interface ContextSyncStoreOptions {
  capacity?: number;
  now?: () => number;
  getSessionId?: () => unknown;
  getRevision?: () => unknown;
}

const CHANGE_TYPES = new Set<ContextChangeType>([
  "review.answer", "review.assign", "review.status",
  "model.select", "model.confirm", "evidence.locate",
  "delivery.select", "delivery.export", "context.update",
]);

const SECTIONS = new Set<ContextSyncSection>(["project", "evidence", "model", "review", "delivery"]);
const ORIGINS = new Set<ContextChangeOrigin>(["sidebar", "chat", "system"]);
const FOCUS_SOURCES = new Set<ContextFocusSource>(["chat", "receipt", "sidebar", "system"]);

const TYPE_SECTION: Readonly<Record<ContextChangeType, ContextSyncSection>> = Object.freeze({
  "review.answer": "review",
  "review.assign": "review",
  "review.status": "review",
  "model.select": "model",
  "model.confirm": "model",
  "evidence.locate": "evidence",
  "delivery.select": "delivery",
  "delivery.export": "delivery",
  "context.update": "project",
});

const EMPTY_REFS: ContextReferences = Object.freeze({
  entityIds: Object.freeze([]),
  questionIds: Object.freeze([]),
  evidenceIds: Object.freeze([]),
  artifactIds: Object.freeze([]),
  canvasNodeIds: Object.freeze([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (isRecord(value) && "value" in value) return text(value["value"]);
  return "";
}

function truncate(value: unknown, max: number): string {
  const chars = [...text(value)];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return value === null || value === undefined || value === "" ? [] : [value];
}

function ids(...rawValues: unknown[]): readonly string[] {
  const out = new Set<string>();
  for (const rawValue of rawValues) {
    for (const value of values(rawValue)) {
      const id = truncate(value, 160);
      if (id) out.add(id);
      if (out.size >= 80) break;
    }
    if (out.size >= 80) break;
  }
  return Object.freeze([...out].sort(compareCodePoint));
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function referencesOf(input: {
  refs?: Partial<Record<keyof ContextReferences, unknown>> | null;
  entityIds?: unknown;
  questionIds?: unknown;
  evidenceIds?: unknown;
  artifactIds?: unknown;
  canvasNodeIds?: unknown;
}, inherited: ContextReferences = EMPTY_REFS): ContextReferences {
  const refs = input.refs ?? {};
  return Object.freeze({
    entityIds: ids(inherited.entityIds, refs.entityIds, input.entityIds),
    questionIds: ids(inherited.questionIds, refs.questionIds, input.questionIds),
    evidenceIds: ids(inherited.evidenceIds, refs.evidenceIds, input.evidenceIds),
    artifactIds: ids(inherited.artifactIds, refs.artifactIds, input.artifactIds),
    canvasNodeIds: ids(inherited.canvasNodeIds, refs.canvasNodeIds, input.canvasNodeIds),
  });
}

function changeType(value: unknown): ContextChangeType {
  const key = text(value).toLocaleLowerCase() as ContextChangeType;
  return CHANGE_TYPES.has(key) ? key : "context.update";
}

function sectionOf(value: unknown, fallback: ContextSyncSection): ContextSyncSection {
  const key = text(value).toLocaleLowerCase() as ContextSyncSection;
  return SECTIONS.has(key) ? key : fallback;
}

function originOf(value: unknown): ContextChangeOrigin {
  const key = text(value).toLocaleLowerCase() as ContextChangeOrigin;
  return ORIGINS.has(key) ? key : "sidebar";
}

function focusSourceOf(value: unknown): ContextFocusSource {
  const key = text(value).toLocaleLowerCase() as ContextFocusSource;
  return FOCUS_SOURCES.has(key) ? key : "sidebar";
}

function isoTime(value: unknown, fallbackMs: number): string {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value);
  else if (typeof value === "string" && value.trim()) date = new Date(value);
  else date = new Date(fallbackMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallbackMs).toISOString();
}

/** 32-bit FNV-1a；这里只要稳定锚点，不承担安全校验。 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function receiptId(data: Omit<ContextChangeReceipt, "schemaVersion" | "id">): string {
  const canonical = JSON.stringify([
    data.sessionId, data.type, data.section, data.origin, data.title, data.summary,
    data.refs.entityIds, data.refs.questionIds, data.refs.evidenceIds, data.refs.artifactIds,
    data.refs.canvasNodeIds,
    data.revision, data.createdAt,
  ]);
  return `ctxr_${stableHash(canonical)}`;
}

function focusId(data: Omit<ContextFocusReference, "schemaVersion" | "id">): string {
  const canonical = JSON.stringify([
    data.sessionId, data.source, data.section, data.label, data.receiptId,
    data.refs.entityIds, data.refs.questionIds, data.refs.evidenceIds, data.refs.artifactIds,
    data.refs.canvasNodeIds,
    data.createdAt,
  ]);
  return `ctxf_${stableHash(canonical)}`;
}

/** 从现有 /state 或 /context 会话形态读取 revision；未知就明确写 current。 */
export function contextRevisionOf(session: unknown): string {
  const root = isRecord(session) ? session : {};
  const state = isRecord(root["state"]) ? root["state"] : {};
  const ontology = isRecord(state["ontology_package"]) ? state["ontology_package"] : {};
  const revision = isRecord(state["revision"]) ? state["revision"] : {};
  const project = isRecord(root["project"]) ? root["project"] : {};
  const projectRevision = isRecord(project["revision"]) ? project["revision"] : {};
  return truncate(
    projectRevision["label"] ?? projectRevision["model"] ?? ontology["revision"]
      ?? state["artifact_revision"] ?? root["state_version"] ?? root["stateVersion"]
      ?? root["revision"] ?? revision["id"] ?? revision["revision"] ?? "current",
    100,
  ) || "current";
}

export interface CanvasNodeReferenceOptions {
  sessionId?: unknown;
  revision?: unknown;
}

function canvasNodeType(value: unknown): CanvasNodeType {
  const key = text(value).toLocaleLowerCase().replace(/[\s_-]+/gu, "");
  if (["ontology", "ontologytype", "ontologyobject"].includes(key)) return "ontology";
  if (["workflow", "process", "flow"].includes(key)) return "workflow";
  if (["action", "actiontype", "processstep", "task"].includes(key)) return "action";
  if (["event", "eventtype"].includes(key)) return "event";
  if (["object", "objecttype", "dataobject"].includes(key)) return "object";
  if (["rule", "businessrule"].includes(key)) return "rule";
  return "unknown";
}

/** Canvas 节点在 sidebar/chat 两边共用的稳定引用，不把整份节点 data 塞进事件。 */
export function contextReferenceFromCanvasNode(
  input: CanvasNodeReferenceInput,
  options: CanvasNodeReferenceOptions = {},
): CanvasNodeReference {
  const type = canvasNodeType(input.nodeType ?? input.type ?? input.kind);
  const label = truncate(input.label ?? input.title, 180) || "未命名画布节点";
  const rawId = truncate(input.nodeId ?? input.id, 180);
  const nodeId = rawId || `node_${stableHash(JSON.stringify([type, label]))}`;
  const sessionId = truncate(input.sessionId ?? options.sessionId ?? G.S?.id, 160);
  const revision = truncate(input.revision ?? options.revision ?? contextRevisionOf(G.S), 100) || "current";
  const refs = referencesOf({ ...input, canvasNodeIds: [nodeId] });
  const id = `canvas:${type}:${nodeId}`;
  return Object.freeze({
    schemaVersion: CANVAS_NODE_REFERENCE_SCHEMA,
    id,
    sessionId,
    section: "model",
    nodeId,
    nodeType: type,
    label,
    revision,
    refs,
  });
}

/** 画布节点点击后让侧栏聚焦；同一引用也可交给 prefillComposer 进入聊天。 */
export function focusCanvasNodeReference(
  reference: CanvasNodeReference,
  source: ContextFocusSource = "sidebar",
  store: ContextSyncStore = contextSyncStore,
): ContextFocusReference {
  return store.focus({
    source,
    section: "model",
    label: reference.label,
    sessionId: reference.sessionId,
    refs: reference.refs,
  });
}

export function canvasNodeCitation(reference: CanvasNodeReference): string {
  return `引用画布节点「${reference.label}」（${reference.nodeType}；revision ${reference.revision}；node ${reference.nodeId}）`;
}

function draftOutputType(value: unknown): GenericDraftOutputType {
  const key = text(value).toLocaleLowerCase();
  if (key === "workflow" || key === "flow" || key === "process") return "Workflow";
  if (key === "action" || key === "actiontype") return "Action";
  if (key === "event" || key === "eventtype") return "Event";
  return "Ontology";
}

function promptLines(value: readonly unknown[] | undefined, max = 12): string[] {
  if (value === undefined) return [];
  const out: string[] = [];
  for (const item of value) {
    const line = truncate(item, 240);
    if (line && !out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

function referencePromptLine(refs: ContextReferences): string {
  const parts: string[] = [];
  if (refs.canvasNodeIds.length) parts.push(`画布节点=${refs.canvasNodeIds.join(", ")}`);
  if (refs.entityIds.length) parts.push(`实体=${refs.entityIds.join(", ")}`);
  if (refs.questionIds.length) parts.push(`问题=${refs.questionIds.join(", ")}`);
  if (refs.artifactIds.length) parts.push(`产物=${refs.artifactIds.join(", ")}`);
  return parts.join("；");
}

/**
 * “通用场景生成草案”的标准聊天 prompt。核心约束始终写进 prompt，而不是依赖模型
 * 猜测：没有客户材料、只能产出假设、每条关键假设都必须列验证问题。
 */
export function genericScenarioDraftPrompt(input: GenericScenarioDraftInput): string {
  const scenario = truncate(input.scenario, 1_200) || "（尚未描述场景）";
  const outputType = draftOutputType(input.outputType);
  const assumptions = promptLines(input.assumptions);
  const validation = promptLines(input.validationFocus);
  const refs = referencesOf(input);
  const lines = [
    `请基于以下通用业务场景生成一份 ${outputType} 草案。`,
    `通用场景：${scenario}`,
    `输出类型：${outputType}`,
    "材料状态：当前没有可直接引用的客户材料；以下内容不得表述为客户事实。",
    "工作要求：",
    "1. 将所有业务对象、流程、动作、事件和规则标记为“待验证假设”。",
    "2. 区分通用行业经验、从场景推导的假设，以及仍然未知的信息。",
    "3. 为每条关键假设给出需要向业务方确认的问题与验收条件。",
    "4. 不编造证据、客户系统名、字段口径、负责人或已确认状态。",
  ];
  if (assumptions.length) lines.push("已知假设：", ...assumptions.map((item) => `- ${item}`));
  if (validation.length) lines.push("优先验证：", ...validation.map((item) => `- ${item}`));
  const refLine = referencePromptLine(refs);
  if (refLine) lines.push(`当前工作区引用（仅作定位，不代表证据）：${refLine}`);
  lines.push(`请先输出 ${outputType} 草案，再单列“假设与待验证问题”。`);
  return lines.join("\n");
}

function freezeReceipt(receipt: ContextChangeReceipt): ContextChangeReceipt {
  return Object.freeze({ ...receipt, refs: referencesOf({ refs: receipt.refs }) });
}

function freezeReference(reference: ContextFocusReference): ContextFocusReference {
  return Object.freeze({ ...reference, refs: referencesOf({ refs: reference.refs }) });
}

function freezeSnapshot(
  version: number,
  receipts: readonly ContextChangeReceipt[],
  dismissed: ReadonlySet<string>,
  activeReference: ContextFocusReference | null,
): ContextSyncSnapshot {
  return Object.freeze({
    version,
    receipts: Object.freeze([...receipts]),
    dismissedIds: Object.freeze([...dismissed].sort(compareCodePoint)),
    activeReference,
  });
}

/**
 * 造一个隔离 store。React 可直接用
 * `useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)`。
 */
export function createContextSyncStore(options: ContextSyncStoreOptions = {}): ContextSyncStore {
  const capacity = Math.max(1, Math.min(500, Math.trunc(options.capacity ?? 80)));
  const now = options.now ?? (() => Date.now());
  const getSessionId = options.getSessionId ?? (() => "");
  const getRevision = options.getRevision ?? (() => "current");
  let receipts: ContextChangeReceipt[] = [];
  const dismissed = new Set<string>();
  let activeReference: ContextFocusReference | null = null;
  let version = 0;
  let snapshot = freezeSnapshot(version, receipts, dismissed, activeReference);
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: ContextSyncStoreEvent) => void>();

  const emit = (event: ContextSyncStoreEvent): void => {
    version += 1;
    snapshot = freezeSnapshot(version, receipts, dismissed, activeReference);
    for (const listener of [...listeners]) listener();
    for (const listener of [...eventListeners]) listener(event);
  };

  const store: ContextSyncStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => { eventListeners.delete(listener); };
    },
    publish(input) {
      const type = changeType(input.type);
      const createdAt = isoTime(input.createdAt, now());
      const data: Omit<ContextChangeReceipt, "schemaVersion" | "id"> = {
        sessionId: truncate(input.sessionId ?? getSessionId(), 160),
        type,
        section: sectionOf(input.section, TYPE_SECTION[type]),
        origin: originOf(input.origin),
        title: truncate(input.title, 180) || "上下文已更新",
        summary: truncate(input.summary, 800),
        refs: referencesOf(input),
        revision: truncate(input.revision ?? getRevision(), 100) || "current",
        createdAt,
      };
      const id = receiptId(data);
      const existing = receipts.find((receipt) => receipt.id === id);
      if (existing !== undefined) return existing;
      const receipt = freezeReceipt({ schemaVersion: CONTEXT_CHANGE_SCHEMA, id, ...data });
      receipts = [...receipts, receipt].slice(-capacity);
      const kept = new Set(receipts.map((item) => item.id));
      for (const dismissedId of [...dismissed]) if (!kept.has(dismissedId)) dismissed.delete(dismissedId);
      emit({ kind: "receipt.published", receipt });
      return receipt;
    },
    getReceipt(id) {
      const key = text(id);
      return receipts.find((receipt) => receipt.id === key) ?? null;
    },
    dismissReceipt(id) {
      const key = text(id);
      if (!receipts.some((receipt) => receipt.id === key) || dismissed.has(key)) return false;
      dismissed.add(key);
      emit({ kind: "receipt.dismissed", receiptId: key });
      return true;
    },
    clearReceipts(sessionId) {
      const sid = text(sessionId);
      const before = receipts.length;
      receipts = sid ? receipts.filter((receipt) => receipt.sessionId !== sid) : [];
      if (receipts.length === before) return;
      const kept = new Set(receipts.map((receipt) => receipt.id));
      for (const dismissedId of [...dismissed]) if (!kept.has(dismissedId)) dismissed.delete(dismissedId);
      if (activeReference !== null && (!sid || activeReference.sessionId === sid)) activeReference = null;
      emit({ kind: "reference.cleared" });
    },
    focus(input) {
      const source = focusSourceOf(input.source);
      const receiptIdValue = truncate(input.receiptId, 160);
      const receipt = receiptIdValue ? store.getReceipt(receiptIdValue) : null;
      const createdAt = isoTime(input.createdAt, now());
      const data: Omit<ContextFocusReference, "schemaVersion" | "id"> = {
        sessionId: truncate(input.sessionId ?? receipt?.sessionId ?? getSessionId(), 160),
        source,
        section: sectionOf(input.section, receipt?.section ?? "project"),
        label: truncate(input.label ?? receipt?.title, 180) || "上下文引用",
        receiptId: receipt?.id ?? receiptIdValue,
        refs: referencesOf(input, receipt?.refs ?? EMPTY_REFS),
        createdAt,
      };
      const reference = freezeReference({ schemaVersion: CONTEXT_FOCUS_SCHEMA, id: focusId(data), ...data });
      activeReference = reference;
      emit({ kind: "reference.focused", reference });
      return reference;
    },
    focusReceipt(receiptIdValue, source = "receipt") {
      const receipt = store.getReceipt(receiptIdValue);
      if (receipt === null) return null;
      return store.focus({
        source,
        section: receipt.section,
        label: receipt.title,
        receiptId: receipt.id,
        refs: receipt.refs,
        sessionId: receipt.sessionId,
      });
    },
    clearFocus() {
      if (activeReference === null) return;
      activeReference = null;
      emit({ kind: "reference.cleared" });
    },
  };
  return store;
}

/** 生产单例：只读 G 获取当前 session/revision，不向 G 写任何同步状态。 */
export const contextSyncStore = createContextSyncStore({
  getSessionId: () => G.S?.id ?? "",
  getRevision: () => contextRevisionOf(G.S),
});

export interface RecentReceiptOptions {
  sessionId?: unknown;
  limit?: number;
  includeDismissed?: boolean;
  newestFirst?: boolean;
}

/** 会话隔离的纯 selector；聊天区默认取最新、未关闭的 3 条。 */
export function selectRecentContextReceipts(
  snapshot: ContextSyncSnapshot,
  options: RecentReceiptOptions = {},
): ContextChangeReceipt[] {
  const sessionId = text(options.sessionId);
  const dismissed = new Set(snapshot.dismissedIds);
  let rows = snapshot.receipts.filter((receipt) =>
    (!sessionId || receipt.sessionId === sessionId)
    && (options.includeDismissed === true || !dismissed.has(receipt.id)),
  );
  if (options.newestFirst !== false) rows = [...rows].reverse();
  const limit = Math.max(0, Math.trunc(options.limit ?? 3));
  return rows.slice(0, limit);
}

/** 给聊天输入框的人类可读引用，不把内部 JSON 或整份详情塞进 prompt。 */
export function contextReceiptCitation(receipt: ContextChangeReceipt): string {
  const refs: string[] = [];
  if (receipt.refs.entityIds.length) refs.push(`实体 ${receipt.refs.entityIds.slice(0, 3).join("、")}`);
  if (receipt.refs.questionIds.length) refs.push(`问题 ${receipt.refs.questionIds.slice(0, 3).join("、")}`);
  if (receipt.refs.evidenceIds.length) refs.push(`证据 ${receipt.refs.evidenceIds.slice(0, 3).join("、")}`);
  if (receipt.refs.artifactIds.length) refs.push(`产物 ${receipt.refs.artifactIds.slice(0, 3).join("、")}`);
  if (receipt.refs.canvasNodeIds.length) refs.push(`画布节点 ${receipt.refs.canvasNodeIds.slice(0, 3).join("、")}`);
  const meta = [receipt.revision && `revision ${receipt.revision}`, ...refs].filter(Boolean).join("；");
  const header = `引用上下文「${receipt.title}」${meta ? `（${meta}）` : ""}`;
  return receipt.summary ? `${header}\n${receipt.summary}` : header;
}

interface ComposerLike {
  value: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  focus?: () => void;
  dispatchEvent?: (event: Event) => boolean;
}

interface DocumentLike {
  getElementById(id: string): unknown;
}

export interface ComposerQuoteOptions {
  document?: DocumentLike;
  composerId?: string;
  store?: ContextSyncStore;
  /** 默认同时广播 source=chat 的 focus，让侧栏立即知道用户刚引用了什么。 */
  focusSidebar?: boolean;
}

export interface ComposerQuoteResult {
  inserted: boolean;
  text: string;
  reference: ContextFocusReference | null;
}

export type ContextComposerPayload =
  | string
  | ContextChangeReceipt
  | CanvasNodeReference
  | GenericScenarioDraftInput;

export interface ComposerPrefillOptions extends ComposerQuoteOptions {
  mode?: "insert" | "replace";
}

export interface ComposerPrefillResult extends ComposerQuoteResult {
  prepared: boolean;
}

export interface SendContextToChatOptions extends ComposerPrefillOptions {
  /** 注入现有 sendChat；未传时只预填，绝不替用户自动发送。 */
  send?: () => unknown | Promise<unknown>;
}

export interface SendContextToChatResult extends ComposerPrefillResult {
  sent: boolean;
}

function browserDocument(): DocumentLike | undefined {
  const doc = (globalThis as unknown as { document?: DocumentLike }).document;
  return doc && typeof doc.getElementById === "function" ? doc : undefined;
}

function payloadText(payload: ContextComposerPayload): string {
  if (typeof payload === "string") return truncate(payload, 4_000);
  if (payload.schemaVersion === CONTEXT_CHANGE_SCHEMA) return contextReceiptCitation(payload);
  if (payload.schemaVersion === CANVAS_NODE_REFERENCE_SCHEMA) return canvasNodeCitation(payload);
  return genericScenarioDraftPrompt(payload);
}

function focusComposerPayload(
  payload: ContextComposerPayload,
  store: ContextSyncStore,
): ContextFocusReference | null {
  if (typeof payload === "string") return null;
  if (payload.schemaVersion === CONTEXT_CHANGE_SCHEMA) return store.focusReceipt(payload.id, "chat");
  if (payload.schemaVersion === CANVAS_NODE_REFERENCE_SCHEMA) {
    return focusCanvasNodeReference(payload, "chat", store);
  }
  return store.focus({
    source: "chat",
    section: "model",
    label: `通用场景草案：${truncate(payload.scenario, 100) || "未命名场景"}`,
    refs: referencesOf(payload),
  });
}

/** 通用预填入口：receipt、canvas ref、通用场景草案与普通文本走同一条 composer 路。 */
export function prefillComposer(
  payload: ContextComposerPayload,
  options: ComposerPrefillOptions = {},
): ComposerPrefillResult {
  const content = payloadText(payload);
  const doc = options.document ?? browserDocument();
  const raw = doc?.getElementById(options.composerId ?? "cin");
  if (typeof raw !== "object" || raw === null) {
    return { prepared: false, inserted: false, text: content, reference: null };
  }
  const composer = raw as unknown as ComposerLike;
  if (typeof composer.value !== "string") {
    return { prepared: false, inserted: false, text: content, reference: null };
  }
  let inserted = false;
  if (options.mode === "replace") {
    if (composer.value !== content) {
      composer.value = content;
      composer.selectionStart = content.length;
      composer.selectionEnd = content.length;
      inserted = true;
    }
  } else if (!composer.value.includes(content)) {
    const current = composer.value;
    const start = typeof composer.selectionStart === "number" ? composer.selectionStart : current.length;
    const end = typeof composer.selectionEnd === "number" ? composer.selectionEnd : start;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const left = before && !before.endsWith("\n") ? "\n\n" : "";
    const right = after && !after.startsWith("\n") ? "\n\n" : "";
    composer.value = `${before}${left}${content}${right}${after}`;
    const cursor = before.length + left.length + content.length;
    composer.selectionStart = cursor;
    composer.selectionEnd = cursor;
    inserted = true;
  }
  if (inserted) {
    const EventCtor = (globalThis as unknown as { Event?: new (type: string, init?: { bubbles?: boolean }) => Event }).Event;
    if (typeof composer.dispatchEvent === "function" && EventCtor !== undefined) {
      composer.dispatchEvent(new EventCtor("input", { bubbles: true }));
    }
  }
  composer.focus?.();
  const reference = options.focusSidebar === false
    ? null : focusComposerPayload(payload, options.store ?? contextSyncStore);
  return { prepared: true, inserted, text: content, reference };
}

/**
 * 把上下文送到聊天。默认只预填；调用方显式注入 `send: sendChat` 才会立即发送，
 * 避免一个“查看/引用”按钮在用户没审阅 prompt 时就触发模型调用。
 */
/**
 * 侧栏动作 → 聊天。
 *
 * **草稿要还回去。** 发送必须走 #cin（`sendChat()` 从那儿读），而 `mode:"replace"`
 * 会把用户半句没打完的话冲掉、连同这次发送一起没了。以前的做法是让他自认倒霉；
 * 现在的做法是：**存下来 → 换成要发的内容 → 发 → 原样放回去**。
 *
 * 自动发送这件事本身不动 —— `contextChatBridge` 上的注释写得很清楚：侧栏写完
 * Question Ledger 之后要让对话立刻接着走，那是有意的。有问题的从来只是「顺手
 * 把人的草稿吃掉」这一条。
 */
export async function sendContextToChat(
  payload: ContextComposerPayload,
  options: SendContextToChatOptions = {},
): Promise<SendContextToChatResult> {
  const doc = options.document ?? browserDocument();
  const composer = doc?.getElementById(options.composerId ?? "cin") as unknown as ComposerLike | null;
  const draft = typeof composer?.value === "string" ? composer.value : "";

  const prepared = prefillComposer(payload, options);
  if (!prepared.prepared || options.send === undefined) return { ...prepared, sent: false };
  try {
    await options.send();
  } finally {
    // 无论发成没发成都要还 —— 发失败还把草稿吃了是最糟的组合。
    // 发送成功时 sendChat 已经清空了 #cin，这里把草稿填回去；
    // 发送失败时 #cin 里是我们刚塞的内容，同样该还原成他的草稿。
    if (draft !== "" && composer && typeof composer.value === "string") {
      composer.value = draft;
      composer.selectionStart = draft.length;
      composer.selectionEnd = draft.length;
      composer.dispatchEvent?.(new Event("input", { bubbles: true }));
    }
  }
  return { ...prepared, sent: true };
}

/** 一键引用进 #cin；发标准 input 事件，现有 autoGrow/paintSendBtn 会自然接管。 */
export function quoteContextReceiptToComposer(
  receipt: ContextChangeReceipt,
  options: ComposerQuoteOptions = {},
): ComposerQuoteResult {
  const { inserted, text: citation, reference } = prefillComposer(receipt, options);
  return { inserted, text: citation, reference };
}

/** 任意聊天引用（例如 turn.refs 或消息里的对象 chip）广播给侧栏。 */
export function focusChatContext(
  input: Omit<ContextFocusInput, "source">,
  store: ContextSyncStore = contextSyncStore,
): ContextFocusReference {
  return store.focus({ ...input, source: "chat" });
}

type DetailEvent<T> = Event & { readonly detail: T };

function makeDetailEvent<T>(type: string, detail: T): DetailEvent<T> {
  const CustomEventCtor = (globalThis as unknown as {
    CustomEvent?: new <D>(event: string, init: { detail: D }) => DetailEvent<D>;
  }).CustomEvent;
  if (CustomEventCtor !== undefined) return new CustomEventCtor(type, { detail });
  const EventCtor = (globalThis as unknown as { Event: new (event: string) => Event }).Event;
  const event = new EventCtor(type) as DetailEvent<T>;
  Object.defineProperty(event, "detail", { configurable: false, enumerable: true, value: detail });
  return event;
}

function eventDetail(event: Event): unknown {
  return (event as Event & { detail?: unknown }).detail;
}

function eventTargetOrNull(value: unknown): EventTarget | null {
  if (value instanceof EventTarget) return value;
  if (value !== null && typeof value === "object") {
    const row = value as { addEventListener?: unknown; dispatchEvent?: unknown };
    if (typeof row.addEventListener === "function" && typeof row.dispatchEvent === "function") {
      return value as EventTarget;
    }
  }
  return null;
}

function browserEventTarget(): EventTarget | null {
  return eventTargetOrNull((globalThis as unknown as { window?: unknown }).window);
}

export function dispatchContextChangeRequest(
  input: ContextChangeInput,
  target: EventTarget | null = browserEventTarget(),
): boolean {
  return target?.dispatchEvent(makeDetailEvent(CONTEXT_CHANGE_REQUEST_EVENT, input)) ?? false;
}

export function dispatchContextFocusRequest(
  input: ContextFocusInput,
  target: EventTarget | null = browserEventTarget(),
): boolean {
  return target?.dispatchEvent(makeDetailEvent(CONTEXT_FOCUS_REQUEST_EVENT, input)) ?? false;
}

interface BridgeEntry { refs: number; stop: () => void }
const BRIDGES = new WeakMap<EventTarget, Map<ContextSyncStore, BridgeEntry>>();

/**
 * 把 CustomEvent 请求接进 store，并把 store 通知广播回同一 target。幂等且引用计数，
 * StrictMode 两次 effect setup 不会注册两套监听器。
 */
export function installContextSyncBridge(
  target: EventTarget | null = browserEventTarget(),
  store: ContextSyncStore = contextSyncStore,
): () => void {
  if (target === null) return () => {};
  let stores = BRIDGES.get(target);
  if (stores === undefined) {
    stores = new Map();
    BRIDGES.set(target, stores);
  }
  const old = stores.get(store);
  if (old !== undefined) {
    old.refs += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      old.refs -= 1;
      if (old.refs === 0) {
        old.stop();
        stores!.delete(store);
      }
    };
  }

  const onChangeRequest = (event: Event): void => {
    const detail = eventDetail(event);
    if (!isRecord(detail)) return;
    const input = isRecord(detail["change"]) ? detail["change"] : detail;
    store.publish(input as unknown as ContextChangeInput);
  };
  const onFocusRequest = (event: Event): void => {
    const detail = eventDetail(event);
    if (!isRecord(detail)) return;
    const input = isRecord(detail["focus"]) ? detail["focus"] : detail;
    store.focus(input as unknown as ContextFocusInput);
  };
  target.addEventListener(CONTEXT_CHANGE_REQUEST_EVENT, onChangeRequest);
  target.addEventListener(CONTEXT_FOCUS_REQUEST_EVENT, onFocusRequest);
  const offEvents = store.subscribeEvents((event) => {
    if (event.kind === "receipt.published") {
      target.dispatchEvent(makeDetailEvent(CONTEXT_CHANGE_EVENT, event.receipt));
    } else if (event.kind === "reference.focused") {
      target.dispatchEvent(makeDetailEvent(CONTEXT_FOCUS_EVENT, event.reference));
    }
  });
  const entry: BridgeEntry = {
    refs: 1,
    stop: () => {
      target.removeEventListener(CONTEXT_CHANGE_REQUEST_EVENT, onChangeRequest);
      target.removeEventListener(CONTEXT_FOCUS_REQUEST_EVENT, onFocusRequest);
      offEvents();
    },
  };
  stores.set(store, entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.refs -= 1;
    if (entry.refs === 0) {
      entry.stop();
      stores!.delete(store);
    }
  };
}
