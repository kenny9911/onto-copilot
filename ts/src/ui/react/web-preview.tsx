import {
  useEffect, useId, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
  type ReactElement, type ReactNode, type WheelEvent as ReactWheelEvent,
} from "react";

import { prefillComposer } from "../context-sync.js";

/**
 * Web Preview deliberately consumes a text snapshot instead of injecting fetched HTML.
 * External markup never enters `dangerouslySetInnerHTML`; the server remains responsible
 * for SSRF policy, redirect validation, extraction and snapshot persistence.
 */
export type WebPreviewPageStatus = "live" | "snapshot" | "blocked";
export type WebPreviewLoadState = "idle" | "loading" | "ready" | "error";
export type WebPreviewLanguageMode = "original" | "zh" | "bilingual";
/** @deprecated The web workbench is now always Live; retained only for harmless caller compatibility. */
export type WebPreviewSurface = "reader" | "live";
export type WebPreviewTextStatus = "available" | "partial" | "unavailable";

export interface WebPreviewPdfResource {
  kind: "pdf";
  mimeType: "application/pdf";
  filename: string;
  textStatus: WebPreviewTextStatus;
  extractedPages: number;
  totalPages?: number;
  truncated: boolean;
  reason?: string;
  /** Same-origin session endpoint; never substitute an external URL here. */
  previewUrl?: string;
}

export interface WebPreviewCitation {
  id: string;
  label?: string;
  url?: string;
  quote?: string;
  paragraphIds?: string[];
}

export interface WebPreviewParagraph {
  id: string;
  text: string;
  translatedText?: string;
  heading?: string;
  level?: number;
  citationIds?: string[];
}

/** Wire shape returned by GET/POST `/web/pages`. */
export interface WebPreviewPage {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  status: WebPreviewPageStatus;
  fetchedAt: string;
  digest: string;
  contentType: string;
  language?: string;
  siteName?: string;
  blockedReason?: string;
  resource?: WebPreviewPdfResource;
  /** Server-authoritative iframe policy after redirects/CSP/X-Frame checks. */
  embed?: {
    allowed: boolean;
    url?: string;
    reason?: string;
  };
  paragraphs: WebPreviewParagraph[];
  citations: WebPreviewCitation[];
}

export interface WebPreviewSummaryBullet {
  id?: string;
  text: string;
  citationIds: string[];
}

export interface WebPreviewBasedOn {
  pageId: string;
  digest: string;
  fetchedAt: string;
}

/** Wire shape returned by POST `/summarize`; freshness is anchored to `basedOn.digest`. */
export interface WebPreviewSummary {
  id?: string;
  basedOn: string | WebPreviewBasedOn;
  /** Compatibility projection added by the route; domain `basedOn` remains structured. */
  basedOnDigest?: string;
  generatedAt?: string;
  language?: string;
  bullets: WebPreviewSummaryBullet[];
}

export interface WebPreviewMaterialReceipt {
  id: string;
  name: string;
  savedAt: string;
  pageId: string;
  digest: string;
}

export interface WebPreviewTarget {
  url: string;
  pageId?: string;
}

/** 只保存浏览器定位，不保存页面正文、分析结果或任意服务端对象。 */
export interface WebPreviewHistoryState {
  entries: WebPreviewTarget[];
  index: number;
}

export const WEB_PREVIEW_HISTORY_MAX_ENTRIES = 24;
export const WEB_PREVIEW_HISTORY_MAX_BYTES = 16_384;

export interface WebPreviewOpenRequest {
  sessionId: string;
  url: string;
  signal?: AbortSignal;
}

export interface WebPreviewPageRequest {
  sessionId: string;
  pageId: string;
  signal?: AbortSignal;
}

export interface WebPreviewLiveSnapshotRequest {
  sessionId: string;
  browserSessionId: string;
  seq: number;
  url: string;
  signal?: AbortSignal;
}

export interface WebPreviewTranslateRequest extends WebPreviewPageRequest {
  mode: Exclude<WebPreviewLanguageMode, "original">;
}

export interface WebPreviewSummarizeRequest extends WebPreviewPageRequest {
  language?: string;
  focus?: string;
}

export interface WebPreviewClient {
  open(request: WebPreviewOpenRequest): Promise<WebPreviewPage>;
  snapshotLive(request: WebPreviewLiveSnapshotRequest): Promise<WebPreviewPage>;
  get(request: WebPreviewPageRequest): Promise<WebPreviewPage>;
  translate(request: WebPreviewTranslateRequest): Promise<WebPreviewPage>;
  summarize(request: WebPreviewSummarizeRequest): Promise<WebPreviewSummary>;
  save(request: WebPreviewPageRequest): Promise<WebPreviewMaterialReceipt>;
}

export interface LiveBrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface LiveBrowserCapabilities {
  available: boolean;
  reason?: string;
  features: string[];
}

/**
 * The live renderer returns browser pixels through a same-origin image route.
 * It never returns third-party markup for the UI to inject or frame directly.
 */
export interface LiveBrowserFrame {
  browserSessionId: string;
  url: string;
  title: string;
  frameUrl: string;
  width: number;
  height: number;
  seq: number;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
  updatedAt: string;
}

export interface LiveBrowserBaseRequest {
  sessionId: string;
  browserSessionId: string;
  signal?: AbortSignal;
}

export interface LiveBrowserOpenRequest {
  sessionId: string;
  url: string;
  viewport?: LiveBrowserViewport;
  signal?: AbortSignal;
}

export interface LiveBrowserNavigateRequest extends LiveBrowserBaseRequest { url: string }
export interface LiveBrowserPointerRequest extends LiveBrowserBaseRequest {
  x: number;
  y: number;
  action: "click";
}
export interface LiveBrowserScrollRequest extends LiveBrowserBaseRequest { deltaX: number; deltaY: number }
export interface LiveBrowserKeyRequest extends LiveBrowserBaseRequest { key?: string; text?: string }

export interface LiveBrowserClient {
  capabilities(request: { sessionId: string; signal?: AbortSignal }): Promise<LiveBrowserCapabilities>;
  open(request: LiveBrowserOpenRequest): Promise<LiveBrowserFrame>;
  get(request: LiveBrowserBaseRequest): Promise<LiveBrowserFrame>;
  navigate(request: LiveBrowserNavigateRequest): Promise<LiveBrowserFrame>;
  back(request: LiveBrowserBaseRequest): Promise<LiveBrowserFrame>;
  forward(request: LiveBrowserBaseRequest): Promise<LiveBrowserFrame>;
  reload(request: LiveBrowserBaseRequest): Promise<LiveBrowserFrame>;
  screenshot(request: LiveBrowserBaseRequest): Promise<LiveBrowserFrame>;
  pointer(request: LiveBrowserPointerRequest): Promise<LiveBrowserFrame>;
  scroll(request: LiveBrowserScrollRequest): Promise<LiveBrowserFrame>;
  key(request: LiveBrowserKeyRequest): Promise<LiveBrowserFrame>;
  close(request: LiveBrowserBaseRequest): Promise<void>;
}

export interface WebPreviewChatPayload {
  kind: "page" | "summary";
  pageId: string;
  title: string;
  url: string;
  digest: string;
  citationIds: string[];
  text: string;
}

export interface WebPreviewProps {
  sessionId: string;
  target: WebPreviewTarget;
  /** Inject in tests or when the workbench owns caching. Defaults to the HTTP contract below. */
  client?: WebPreviewClient;
  /** Injectable isolated-browser transport. `null` explicitly disables live browsing. */
  liveBrowserClient?: LiveBrowserClient | null;
  initialPage?: WebPreviewPage | null;
  initialSummary?: WebPreviewSummary | null;
  locale?: "zh" | "en";
  /** @deprecated Ignored. Ordinary web resources always render Live Browser. */
  initialSurface?: WebPreviewSurface;
  /** Hidden workbench tabs stay mounted but must not own a browser runtime. */
  active?: boolean;
  initialHistoryState?: WebPreviewHistoryState | null;
  onHistoryStateChange?: (state: WebPreviewHistoryState) => void;
  summaryFocus?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onNavigate?: (url: string) => void;
  onPageChange?: (page: WebPreviewPage) => void;
  onLivePageChange?: (frame: LiveBrowserFrame) => void;
  /** @deprecated Ignored. There is no surface switch in the UI. */
  onSurfaceChange?: (surface: WebPreviewSurface) => void;
  onCitation?: (citation: WebPreviewCitation, page: WebPreviewPage) => void;
  onSendToChat?: (payload: WebPreviewChatPayload) => void | Promise<void>;
  onMaterialSaved?: (receipt: WebPreviewMaterialReceipt, page: WebPreviewPage) => void;
  /** Optional workbench hooks; standalone mode falls back to the composer and global material picker. */
  onRequestPasteContent?: (target: WebPreviewTarget) => void;
  onRequestUpload?: (target: WebPreviewTarget) => void;
  className?: string;
}

export const WEB_PREVIEW_API = Object.freeze({
  pages(sessionId: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/web/pages`;
  },
  page(sessionId: string, pageId: string): string {
    return `${WEB_PREVIEW_API.pages(sessionId)}/${encodeURIComponent(pageId)}`;
  },
  liveSnapshots(sessionId: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/web/live-snapshots`;
  },
  translate(sessionId: string, pageId: string): string {
    return `${WEB_PREVIEW_API.page(sessionId, pageId)}/translate`;
  },
  summarize(sessionId: string, pageId: string): string {
    return `${WEB_PREVIEW_API.page(sessionId, pageId)}/summarize`;
  },
  save(sessionId: string, pageId: string): string {
    return `${WEB_PREVIEW_API.page(sessionId, pageId)}/save`;
  },
});

export const LIVE_BROWSER_API = Object.freeze({
  root(sessionId: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/live-browser`;
  },
  capabilities(sessionId: string): string {
    return `${LIVE_BROWSER_API.root(sessionId)}/capabilities`;
  },
  sessions(sessionId: string): string {
    return `${LIVE_BROWSER_API.root(sessionId)}/sessions`;
  },
  session(sessionId: string, browserSessionId: string): string {
    return `${LIVE_BROWSER_API.sessions(sessionId)}/${encodeURIComponent(browserSessionId)}`;
  },
  action(sessionId: string, browserSessionId: string, action: string): string {
    return `${LIVE_BROWSER_API.session(sessionId, browserSessionId)}/${action}`;
  },
});

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class WebPreviewHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "WebPreviewHttpError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export interface WebPreviewHttpClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function unwrap<T>(value: unknown, key: string): T {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key] as T;
  }
  return value as T;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** HTTP 是运行时边界，不能因为服务端一次残缺响应把整个右栏 React 树卸掉。 */
function pageFromWire(value: unknown): WebPreviewPage {
  const row = objectValue(value);
  if (!row || typeof row.id !== "string" || typeof row.url !== "string"
    || typeof row.title !== "string" || !Array.isArray(row.paragraphs) || !Array.isArray(row.citations)) {
    throw new Error("网页服务返回了无法识别的页面格式");
  }
  if (row.resource !== undefined && row.resource !== null) {
    const resource = objectValue(row.resource);
    const totalPagesValid = resource?.totalPages === undefined
      || (typeof resource.totalPages === "number" && Number.isInteger(resource.totalPages) && resource.totalPages >= 0);
    if (!resource || resource.kind !== "pdf" || resource.mimeType !== "application/pdf"
      || typeof resource.filename !== "string"
      || !["available", "partial", "unavailable"].includes(String(resource.textStatus ?? ""))
      || typeof resource.extractedPages !== "number" || !Number.isInteger(resource.extractedPages)
      || resource.extractedPages < 0 || !totalPagesValid || typeof resource.truncated !== "boolean"
      || (resource.reason !== undefined && typeof resource.reason !== "string")
      || (resource.previewUrl !== undefined && normalizePdfPreviewUrl(resource.previewUrl) === null)) {
      throw new Error("网页服务返回了无法识别的 PDF 资源格式");
    }
  }
  return row as unknown as WebPreviewPage;
}

function summaryFromWire(value: unknown): WebPreviewSummary {
  const row = objectValue(value);
  if (!row || !Array.isArray(row.bullets)) throw new Error("网页服务返回了无法识别的总结格式");
  return row as unknown as WebPreviewSummary;
}

function materialFromWire(value: unknown): WebPreviewMaterialReceipt {
  const row = objectValue(value);
  if (!row || typeof row.id !== "string" || typeof row.pageId !== "string" || typeof row.digest !== "string") {
    throw new Error("网页服务返回了无法识别的材料回执");
  }
  return row as unknown as WebPreviewMaterialReceipt;
}

async function jsonRequest<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, { credentials: "same-origin", ...init });
  if (!response.ok) {
    let message = String(response.statusText || `HTTP ${response.status}`);
    let code: string | undefined;
    try {
      const body = objectValue(await response.json());
      const nested = objectValue(body?.error);
      const candidate = body?.detail ?? nested?.message ?? body?.message
        ?? (typeof body?.error === "string" ? body.error : undefined);
      const candidateCode = body?.code ?? nested?.code;
      if (typeof candidate === "string" && candidate.trim()) message = candidate.trim();
      if (typeof candidateCode === "string" && candidateCode.trim()) code = candidateCode.trim();
    } catch { /* keep the status */ }
    throw new WebPreviewHttpError(response.status, message, code);
  }
  return await response.json() as T;
}

function jsonInit(method: "POST", body: Record<string, unknown>, signal?: AbortSignal): RequestInit {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal !== undefined) init.signal = signal;
  return init;
}

function getInit(signal?: AbortSignal): RequestInit {
  const init: RequestInit = { method: "GET" };
  if (signal !== undefined) init.signal = signal;
  return init;
}

/**
 * Default client aligned with the server contract owned by the web-preview route:
 *
 * - POST `/api/sessions/:sid/web/pages` `{url}`
 * - POST `/api/sessions/:sid/web/live-snapshots` `{browserSessionId, seq, url}`
 * - GET  `/api/sessions/:sid/web/pages/:pageId`
 * - POST `.../:pageId/translate` `{mode}`
 * - POST `.../:pageId/summarize` `{language?, focus?}`
 * - POST `.../:pageId/save` `{}`
 */
export function createWebPreviewHttpClient(options: WebPreviewHttpClientOptions = {}): WebPreviewClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = String(options.baseUrl ?? "").replace(/\/$/u, "");
  const path = (value: string): string => `${base}${value}`;
  return {
    async open(request) {
      const result = await jsonRequest<unknown>(fetchImpl, path(WEB_PREVIEW_API.pages(request.sessionId)),
        jsonInit("POST", { url: request.url }, request.signal));
      return pageFromWire(unwrap<unknown>(result, "page"));
    },
    async snapshotLive(request) {
      const result = await jsonRequest<unknown>(fetchImpl,
        path(WEB_PREVIEW_API.liveSnapshots(request.sessionId)),
        jsonInit("POST", {
          browserSessionId: request.browserSessionId,
          seq: request.seq,
          url: request.url,
        }, request.signal));
      return pageFromWire(unwrap<unknown>(result, "page"));
    },
    async get(request) {
      const result = await jsonRequest<unknown>(fetchImpl,
        path(WEB_PREVIEW_API.page(request.sessionId, request.pageId)), getInit(request.signal));
      return pageFromWire(unwrap<unknown>(result, "page"));
    },
    async translate(request) {
      const result = await jsonRequest<unknown>(fetchImpl,
        path(WEB_PREVIEW_API.translate(request.sessionId, request.pageId)),
        jsonInit("POST", { mode: request.mode }, request.signal));
      return pageFromWire(unwrap<unknown>(result, "page"));
    },
    async summarize(request) {
      const body: Record<string, unknown> = {};
      if (request.language !== undefined) body.language = request.language;
      if (request.focus !== undefined) body.focus = request.focus;
      const result = await jsonRequest<unknown>(fetchImpl,
        path(WEB_PREVIEW_API.summarize(request.sessionId, request.pageId)),
        jsonInit("POST", body, request.signal));
      return summaryFromWire(unwrap<unknown>(result, "summary"));
    },
    async save(request) {
      const result = await jsonRequest<unknown>(fetchImpl,
        path(WEB_PREVIEW_API.save(request.sessionId, request.pageId)),
        jsonInit("POST", {}, request.signal));
      return materialFromWire(unwrap<unknown>(result, "material"));
    },
  };
}

function capabilityFromWire(value: unknown): LiveBrowserCapabilities {
  const row = objectValue(value);
  if (!row || typeof row.available !== "boolean") {
    throw new Error("浏览器服务返回了无法识别的能力信息");
  }
  const features = Array.isArray(row.features)
    ? row.features.filter((feature): feature is string => typeof feature === "string")
    : objectValue(row.features)
      ? Object.entries(objectValue(row.features)!).filter(([, enabled]) => enabled === true).map(([feature]) => feature)
      : [];
  const result: LiveBrowserCapabilities = { available: row.available, features };
  if (typeof row.reason === "string" && row.reason.trim()) result.reason = row.reason.trim();
  return result;
}

/** Only the session-scoped renderer route may be consumed as live browser pixels. */
export function normalizeLiveBrowserFrameUrl(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!/^\/api\/sessions\/[^/]+\/live-browser\/sessions\/browser_[a-f0-9]{24}\/frame(?:\?[^#]*)?$/u.test(raw)) return null;
  return raw;
}

function liveFrameFromWire(
  value: unknown,
  expectedSessionId: string,
  expectedBrowserSessionId?: string,
): LiveBrowserFrame {
  const row = objectValue(value);
  if (!row || typeof row.browserSessionId !== "string" || !/^browser_[a-f0-9]{24}$/u.test(row.browserSessionId)
    || typeof row.url !== "string" || normalizeSafeWebUrl(row.url) === null
    || typeof row.title !== "string" || normalizeLiveBrowserFrameUrl(row.frameUrl) === null
    || typeof row.width !== "number" || !Number.isInteger(row.width) || row.width < 1
    || typeof row.height !== "number" || !Number.isInteger(row.height) || row.height < 1
    || typeof row.seq !== "number" || !Number.isInteger(row.seq) || row.seq < 0
    || typeof row.canGoBack !== "boolean" || typeof row.canGoForward !== "boolean"
    || typeof row.loading !== "boolean" || typeof row.updatedAt !== "string"
    || (row.error !== undefined && typeof row.error !== "string")) {
    throw new Error("浏览器服务返回了无法识别的画面信息");
  }
  if (expectedBrowserSessionId !== undefined && row.browserSessionId !== expectedBrowserSessionId) {
    throw new Error("浏览器服务返回了不属于当前浏览会话的画面");
  }
  const frameUrl = new URL(String(row.frameUrl), "https://ontocopilot.invalid");
  const expectedPath = `${LIVE_BROWSER_API.session(expectedSessionId, row.browserSessionId)}/frame`;
  if (frameUrl.origin !== "https://ontocopilot.invalid" || frameUrl.pathname !== expectedPath
    || frameUrl.searchParams.get("seq") !== String(row.seq)
    || [...frameUrl.searchParams.keys()].some((key) => key !== "seq")) {
    throw new Error("浏览器服务返回了不属于当前会话的画面地址");
  }
  return row as unknown as LiveBrowserFrame;
}

/** HTTP adapter for the isolated browser runtime. All pixels stay on same-origin routes. */
export function createLiveBrowserHttpClient(options: WebPreviewHttpClientOptions = {}): LiveBrowserClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = String(options.baseUrl ?? "").replace(/\/$/u, "");
  const path = (value: string): string => `${base}${value}`;
  const browser = async (url: string, init: RequestInit, expectedSessionId: string,
    expectedBrowserSessionId?: string): Promise<LiveBrowserFrame> => {
    const result = await jsonRequest<unknown>(fetchImpl, path(url), init);
    return liveFrameFromWire(unwrap<unknown>(result, "browser"), expectedSessionId, expectedBrowserSessionId);
  };
  const action = (request: LiveBrowserBaseRequest, name: string, body: Record<string, unknown> = {}) =>
    browser(LIVE_BROWSER_API.action(request.sessionId, request.browserSessionId, name),
      jsonInit("POST", body, request.signal), request.sessionId, request.browserSessionId);
  return {
    async capabilities(request) {
      const result = await jsonRequest<unknown>(fetchImpl, path(LIVE_BROWSER_API.capabilities(request.sessionId)),
        getInit(request.signal));
      return capabilityFromWire(unwrap<unknown>(result, "capabilities"));
    },
    async open(request) {
      const body: Record<string, unknown> = { url: request.url };
      if (request.viewport !== undefined) body.viewport = request.viewport;
      return browser(LIVE_BROWSER_API.sessions(request.sessionId), jsonInit("POST", body, request.signal), request.sessionId);
    },
    async get(request) {
      return browser(LIVE_BROWSER_API.session(request.sessionId, request.browserSessionId), getInit(request.signal),
        request.sessionId, request.browserSessionId);
    },
    async navigate(request) { return action(request, "navigate", { url: request.url }); },
    async back(request) { return action(request, "back"); },
    async forward(request) { return action(request, "forward"); },
    async reload(request) { return action(request, "reload"); },
    async screenshot(request) { return action(request, "screenshot"); },
    async pointer(request) {
      return action(request, "pointer", { x: request.x, y: request.y, action: request.action });
    },
    async scroll(request) { return action(request, "scroll", { deltaX: request.deltaX, deltaY: request.deltaY }); },
    async key(request) {
      const body: Record<string, unknown> = {};
      if (request.text !== undefined) body.text = request.text;
      if (request.key !== undefined) body.key = request.key;
      return action(request, "key", body);
    },
    async close(request) {
      const init: RequestInit = { method: "DELETE", credentials: "same-origin", keepalive: true };
      if (request.signal !== undefined) init.signal = request.signal;
      const response = await fetchImpl(path(LIVE_BROWSER_API.session(request.sessionId, request.browserSessionId)), init);
      if (!response.ok && response.status !== 404) {
        throw new WebPreviewHttpError(response.status, String(response.statusText || `HTTP ${response.status}`));
      }
    },
  };
}

/**
 * UI protocol check only. Redirect targets and private-network access must be checked again
 * by the server, where DNS resolution and redirect chains are observable.
 */
export function normalizeSafeWebUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function historyEntry(input: unknown): WebPreviewTarget | null {
  const row = objectValue(input);
  if (!row) return null;
  const url = normalizeSafeWebUrl(row.url);
  if (!url) return null;
  const pageId = typeof row.pageId === "string" ? row.pageId.trim() : "";
  const safePageId = pageId && pageId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(pageId)
    ? pageId : "";
  return { url, ...(safePageId ? { pageId: safePageId } : {}) };
}

function historyBytes(state: WebPreviewHistoryState): number {
  const json = JSON.stringify(state);
  try { return new TextEncoder().encode(json).byteLength; }
  catch { return json.length * 2; }
}

/**
 * 浏览历史是 localStorage 合同的一部分，所以在 UI 边界再次限形、限条数、限字节。
 * 当前项和尽可能多的后退项优先保留；任何额外字段都会在这里被投影掉。
 */
export function normalizeWebPreviewHistoryState(
  input: unknown,
  fallback: WebPreviewTarget,
): WebPreviewHistoryState {
  const row = objectValue(input);
  const rawEntries = Array.isArray(row?.entries) ? row.entries.slice(0, 128) : [];
  let entries = rawEntries.map(historyEntry).filter((entry): entry is WebPreviewTarget => entry !== null);
  const fallbackEntry = historyEntry(fallback);
  if (entries.length === 0 && fallbackEntry) entries = [fallbackEntry];
  if (entries.length === 0) return { entries: [], index: 0 };

  const rawIndex = Number(row?.index);
  let index = Number.isFinite(rawIndex)
    ? Math.max(0, Math.min(entries.length - 1, Math.trunc(rawIndex)))
    : entries.length - 1;
  if (entries.length > WEB_PREVIEW_HISTORY_MAX_ENTRIES) {
    let start = Math.max(0, index - (WEB_PREVIEW_HISTORY_MAX_ENTRIES - 1));
    start = Math.min(start, entries.length - WEB_PREVIEW_HISTORY_MAX_ENTRIES);
    entries = entries.slice(start, start + WEB_PREVIEW_HISTORY_MAX_ENTRIES);
    index -= start;
  }
  let state = { entries, index };
  while (state.entries.length > 1 && historyBytes(state) > WEB_PREVIEW_HISTORY_MAX_BYTES) {
    if (state.index < state.entries.length - 1) {
      state = { entries: state.entries.slice(0, -1), index: state.index };
    } else {
      state = { entries: state.entries.slice(1), index: state.index - 1 };
    }
  }
  return state;
}

/** Only the server-owned, session-scoped PDF content route may enter `<object data>`. */
export function normalizePdfPreviewUrl(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!/^\/api\/sessions\/[^/]+\/web\/pages\/[^/]+\/content(?:[?#].*)?$/u.test(raw)) return null;
  return raw;
}

function displayHost(value: string): string {
  try { return new URL(value).host; }
  catch { return value; }
}

function displayProtocol(value: string): string {
  const safe = normalizeSafeWebUrl(value);
  if (!safe) return "WEB";
  try { return new URL(safe).protocol.replace(":", "").toLocaleUpperCase(); }
  catch { return "WEB"; }
}

function timeLabel(value: string, locale: "zh" | "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(date);
  } catch { return value; }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function citationMap(page: WebPreviewPage): Map<string, { citation: WebPreviewCitation; index: number }> {
  return new Map(page.citations.map((citation, index) => [citation.id, { citation, index: index + 1 }]));
}

export function pageChatPayload(page: WebPreviewPage): WebPreviewChatPayload {
  const citationIds = unique(page.paragraphs.flatMap((paragraph) => paragraph.citationIds ?? []));
  const text = [
    `请参考当前网页「${page.title}」继续分析。`,
    `来源：${page.finalUrl || page.url}`,
    `网页快照：${page.id} · ${page.digest}`,
    citationIds.length ? `引用：${citationIds.join("、")}` : "",
  ].filter(Boolean).join("\n");
  return {
    kind: "page", pageId: page.id, title: page.title, url: page.finalUrl || page.url,
    digest: page.digest, citationIds, text,
  };
}

export function summaryChatPayload(page: WebPreviewPage, summary: WebPreviewSummary): WebPreviewChatPayload {
  const citationIds = unique(summary.bullets.flatMap((bullet) => bullet.citationIds));
  const positions = citationMap(page);
  const bullets = summary.bullets.map((bullet) => {
    const refs = bullet.citationIds.map((id) => positions.get(id)?.index)
      .filter((value): value is number => value !== undefined).map((value) => `[${value}]`).join("");
    return `- ${bullet.text}${refs ? ` ${refs}` : ""}`;
  });
  const text = [
    `网页 AI 总结：${page.title}`,
    `来源：${page.finalUrl || page.url}`,
    ...bullets,
    `基于快照：${summaryDigest(summary)}`,
  ].join("\n");
  return {
    kind: "summary", pageId: page.id, title: page.title, url: page.finalUrl || page.url,
    digest: page.digest, citationIds, text,
  };
}

function summaryDigest(summary: WebPreviewSummary): string {
  if (summary.basedOnDigest) return summary.basedOnDigest;
  return typeof summary.basedOn === "string" ? summary.basedOn : summary.basedOn.digest;
}

const ZH = {
  back: "后退", forward: "前进", refresh: "刷新", address: "网页地址", open: "打开",
  backShort: "←", forwardShort: "→", refreshShort: "↻", externalShort: "↗", more: "⋯",
  moreActions: "更多网页操作", summary: "AI 总结", summarizing: "正在总结…",
  citeChat: "引用到对话", save: "存为材料", saving: "正在保存…", saved: "已存为材料",
  external: "打开外部", retry: "重试", loading: "正在安全读取网页…", invalid: "请输入安全的 HTTP 或 HTTPS 网页地址。",
  noSnapshot: "这个网页暂时没有可阅读的正文快照。", sendSummary: "发送到聊天",
  summaryStale: "网页快照已更新，请重新生成总结。",
  summaryFailed: "AI 总结失败，请稍后重试。", saveFailed: "没有保存成功，请稍后重试。",
  openFailed: "网页读取失败。", emptySummary: "当前网页没有可总结的正文。", citation: "引用",
  pdf: "PDF", pdfTextUnavailable: "PDF 可以预览，但当前没有可供翻译或总结的抽取文本。",
  pdfPreviewUnavailable: "PDF 预览尚不可用。", pdfPreview: "查看 PDF",
  failureReason: "失败原因", failureCode: "诊断码", openBrowser: "在浏览器打开",
  pasteContent: "粘贴网页正文", uploadMaterial: "上传文件", alternativeLead: "仍无法读取？可改用：",
  pastePrompt: "自动读取这个网页失败。请基于我接下来粘贴的网页正文继续分析：",
  uploadPrompt: "自动读取这个网页失败。请点击聊天框的“添加材料”上传网页导出文件或 PDF：",
  failDenied: "站点拒绝了读取请求", failMissing: "网页不存在或已移动", failLimited: "站点暂时限制访问",
  failRemote: "目标站点暂时不可用", failTimeout: "站点响应超时", failNetwork: "无法连接到目标站点",
  failDns: "找不到网页所在站点", failRedirect: "网页重定向无法完成", failSecurity: "此地址无法安全读取",
  failUnsupported: "这种内容暂不能按网页读取", failTooLarge: "网页内容超过读取限制",
  failEmpty: "没有提取到可阅读正文", failInvalidPdf: "PDF 文件无效或不完整",
  hintDenied: "该页面可能需要登录，或禁止自动读取。", hintRetry: "请检查地址后重试，也可以直接在浏览器中打开。",
  hintAlternative: "你仍可粘贴正文，或上传网页导出文件、PDF 继续处理。",
  liveStarting: "正在启动隔离浏览器…", liveUnavailable: "浏览器引擎暂不可用",
  liveUnavailableDetail: "当前无法渲染真实网页画面。请重试，或在外部浏览器打开。",
  liveRetry: "重试浏览", liveActionFailed: "浏览器操作失败",
  liveSafety: "隔离浏览 · 暂不支持登录、密码、付款、上传、下载或表单提交",
  liveLoadingPage: "网页正在加载…", liveKeyboardBlocked: "为避免误提交，当前不发送 Enter 或组合快捷键。",
  liveFrameInvalid: "浏览器返回了不安全的画面地址。",
};

const EN: typeof ZH = {
  back: "Back", forward: "Forward", refresh: "Refresh", address: "Web address", open: "Open",
  backShort: "←", forwardShort: "→", refreshShort: "↻", externalShort: "↗", more: "⋯",
  moreActions: "More page actions", summary: "AI summary", summarizing: "Summarizing…",
  citeChat: "Cite in chat", save: "Save as material", saving: "Saving…", saved: "Saved as material",
  external: "Open external", retry: "Retry", loading: "Reading the page safely…", invalid: "Enter a safe HTTP or HTTPS web address.",
  noSnapshot: "No readable page snapshot is available yet.", sendSummary: "Send to chat",
  summaryStale: "The page snapshot changed. Regenerate the summary.",
  summaryFailed: "AI summary failed. Try again.", saveFailed: "Could not save the material. Try again.",
  openFailed: "Could not read this web page.",
  emptySummary: "This page has no readable content to summarize.", citation: "Citation",
  pdf: "PDF", pdfTextUnavailable: "The PDF can be previewed, but extracted text is unavailable for translation or summary.",
  pdfPreviewUnavailable: "PDF preview is unavailable.", pdfPreview: "View PDF",
  failureReason: "Reason", failureCode: "Diagnostic code", openBrowser: "Open in browser",
  pasteContent: "Paste page text", uploadMaterial: "Upload file", alternativeLead: "Still blocked? Use:",
  pastePrompt: "Automatic reading failed. Continue from the page text I paste next:",
  uploadPrompt: "Automatic reading failed. Use Add materials in the chat composer to upload an exported page or PDF:",
  failDenied: "The site refused the read request", failMissing: "The page is missing or moved", failLimited: "The site is rate limiting access",
  failRemote: "The destination site is unavailable", failTimeout: "The site took too long to respond", failNetwork: "Could not connect to the site",
  failDns: "Could not find the site", failRedirect: "The page redirect could not be completed", failSecurity: "This address cannot be read safely",
  failUnsupported: "This content cannot be read as a web page", failTooLarge: "The page exceeds the reading limit",
  failEmpty: "No readable page text was found", failInvalidPdf: "The PDF is invalid or incomplete",
  hintDenied: "The page may require a sign-in or block automated reading.", hintRetry: "Check the address and retry, or open it directly in your browser.",
  hintAlternative: "You can still paste the text or upload an exported page or PDF.",
  liveStarting: "Starting an isolated browser…", liveUnavailable: "Browser engine unavailable",
  liveUnavailableDetail: "The live page cannot be rendered right now. Retry or open it in your external browser.",
  liveRetry: "Retry browser", liveActionFailed: "Browser action failed",
  liveSafety: "Isolated browsing · sign-in, passwords, payments, upload, download, and form submission are not supported yet",
  liveLoadingPage: "Loading page…", liveKeyboardBlocked: "Enter and shortcut combinations are not sent, preventing accidental submission.",
  liveFrameInvalid: "The browser returned an unsafe frame address.",
};

export interface WebPreviewFailureCause {
  reason: string;
  code?: string;
  status?: number;
}

interface WebPreviewFailureDescription {
  title: string;
  detail: string;
  hint: string;
  code: string;
}

function boundedFailureText(value: unknown, fallback: string): string {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, 800);
}

function failureCause(error: unknown, fallback: string): WebPreviewFailureCause {
  if (error instanceof WebPreviewHttpError) {
    const cause: WebPreviewFailureCause = {
      reason: boundedFailureText(error.message, fallback),
      status: error.status,
    };
    if (error.code !== undefined) cause.code = error.code;
    return cause;
  }
  return { reason: boundedFailureText(error instanceof Error ? error.message : error, fallback) };
}

function pageFailureCause(page: WebPreviewPage, fallback: string): WebPreviewFailureCause {
  const cause: WebPreviewFailureCause = {
    reason: boundedFailureText(page.embed?.reason || page.blockedReason, fallback),
  };
  if (page.blockedReason) cause.code = page.blockedReason;
  return cause;
}

function describeFailure(cause: WebPreviewFailureCause, copy: typeof ZH): WebPreviewFailureDescription {
  const reason = boundedFailureText(cause.reason, copy.openFailed);
  const code = String(cause.code ?? "").trim().toLocaleLowerCase();
  const statusMatch = /\bhttp\s+(\d{3})\b/iu.exec(reason);
  const status = cause.status ?? (statusMatch ? Number(statusMatch[1]) : undefined);
  const diagnostic = code || (status !== undefined ? `http_${status}` : "read_failed");
  let title = copy.openFailed;
  let hint = copy.hintRetry;

  if (status === 401 || status === 403) {
    title = copy.failDenied;
    hint = copy.hintDenied;
  } else if (status === 404 || status === 410) title = copy.failMissing;
  else if (status === 429) title = copy.failLimited;
  else if (status !== undefined && status >= 500) title = copy.failRemote;
  else if (code.includes("timeout") || /timed?\s*out|超时/iu.test(reason)) title = copy.failTimeout;
  else if (code.includes("dns")) title = copy.failDns;
  else if (code.includes("redirect")) title = copy.failRedirect;
  else if (["invalid_url", "invalid_or_private_url", "private_address"].includes(code)) title = copy.failSecurity;
  else if (code.includes("unsupported")) {
    title = copy.failUnsupported;
    hint = copy.hintAlternative;
  } else if (code === "too_large") {
    title = copy.failTooLarge;
    hint = copy.hintAlternative;
  } else if (code === "empty_page" || /没有可读取的正文|no readable/iu.test(reason)) {
    title = copy.failEmpty;
    hint = copy.hintAlternative;
  } else if (code === "invalid_pdf") {
    title = copy.failInvalidPdf;
    hint = copy.hintAlternative;
  } else if (code.includes("fetch") || /network|连接|failed to fetch/iu.test(reason)) title = copy.failNetwork;

  const hasStatus = status !== undefined && new RegExp(`(?:HTTP\\s*)?${status}`, "iu").test(reason);
  const detail = status !== undefined && !hasStatus ? `HTTP ${status} · ${reason}` : reason;
  return { title, detail, hint, code: diagnostic };
}

/** Self-contained hooks; the parent workbench may override any `oc-web-preview-*` class. */
export const WEB_PREVIEW_CSS = `
.oc-web-preview{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg,#1a1a18);color:var(--ink,#ece9e2);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);container-type:inline-size}
.oc-web-preview *{box-sizing:border-box}.oc-web-preview button,.oc-web-preview input,.oc-web-preview select{font:inherit}
.oc-web-preview button{color:inherit}.oc-web-preview button:focus-visible,.oc-web-preview input:focus-visible,.oc-web-preview select:focus-visible,.oc-web-preview a:focus-visible{outline:2px solid var(--accent,#4fae7f);outline-offset:2px}
.oc-web-preview-browser{flex:none;border-bottom:1px solid var(--line,#3a382f);background:var(--panel,#242320)}
.oc-web-preview-nav{display:flex;align-items:center;gap:4px;min-width:0;padding:6px 8px}
.oc-web-preview-nav-group{display:flex;align-items:center;gap:2px;flex:none}
.oc-web-preview-nav-button,.oc-web-preview-action,.oc-web-preview-cite{min-height:30px;border:1px solid var(--line,#3a382f);border-radius:7px;background:var(--bg,#1a1a18);padding:5px 9px;font-size:12px;line-height:1.2;cursor:pointer;white-space:nowrap;text-decoration:none}
.oc-web-preview-nav-button{display:inline-flex;min-width:28px;align-items:center;justify-content:center;padding:5px 7px;border-color:transparent;background:transparent;color:var(--ink-2,#c3beb4);font-size:15px;line-height:1}
.oc-web-preview-nav-button:hover,.oc-web-preview-action:hover,.oc-web-preview-cite:hover{border-color:var(--accent-line,#35543f);background:var(--accent-tint,#1f3229);color:var(--accent,#4fae7f)}
.oc-web-preview-nav-button:disabled,.oc-web-preview-action:disabled{cursor:not-allowed;opacity:.42}
.oc-web-preview-address{flex:1;min-width:0;display:flex;align-items:center;gap:6px;border:1px solid var(--line,#3a382f);border-radius:7px;background:var(--bg,#1a1a18);padding:0 8px}
.oc-web-preview-address:focus-within{border-color:var(--accent-line,#35543f)}
.oc-web-preview-address-lock{font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--accent,#4fae7f);letter-spacing:.05em}
.oc-web-preview-address input{width:100%;min-width:0;height:29px;border:0;outline:0;background:transparent;color:var(--ink,#ece9e2);font-size:12px;text-overflow:ellipsis}
.oc-web-preview-more{position:relative;flex:none}.oc-web-preview-more-menu{position:absolute;z-index:30;top:calc(100% + 5px);right:0;min-width:176px;padding:5px;border:1px solid var(--line,#3a382f);border-radius:9px;background:var(--panel,#242320);box-shadow:0 14px 34px rgba(0,0,0,.32)}
.oc-web-preview-more-item{display:flex;width:100%;min-height:32px;align-items:center;border:0;border-radius:6px;background:transparent;color:var(--ink-2,#c3beb4);padding:7px 9px;text-align:left;text-decoration:none;font-size:12px;cursor:pointer}.oc-web-preview-more-item:hover,.oc-web-preview-more-item:focus-visible{background:var(--accent-tint,#1f3229);color:var(--accent,#4fae7f)}.oc-web-preview-more-item:disabled{cursor:not-allowed;opacity:.45}
.oc-web-preview-summary-trigger{flex:none;min-height:29px}
.oc-web-preview-action-primary{border-color:var(--accent-line,#35543f);background:var(--accent,#4fae7f);color:#0d1c14!important}
.oc-web-preview-action-primary:hover{background:var(--accent,#4fae7f);filter:brightness(1.08)}
.oc-web-preview-status{flex:1;min-width:0;overflow:hidden;color:var(--ink-3,#78746a);font-size:11px;line-height:1.3;text-overflow:ellipsis;white-space:nowrap}.oc-web-preview-status:empty{display:none}
.oc-web-preview-error{color:var(--danger,#d15c54)}
.oc-web-preview-main{flex:1;min-height:0;overflow:auto;padding:12px;background:var(--panel-soft,#201f1c)}
.oc-web-preview-summary{max-width:920px;margin:0 auto 12px;border:1px solid var(--line,#3a382f);border-radius:10px;background:var(--panel,#242320);overflow:hidden}
.oc-web-preview-summary-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px}
.oc-web-preview-summary-title{font-size:13px;font-weight:650}.oc-web-preview-summary-meta{margin-left:6px;color:var(--ink-3,#78746a);font-size:11px;font-weight:400}
.oc-web-preview-summary-source{display:block;max-width:min(68cqi,680px);margin-top:3px;overflow:hidden;color:var(--ink-3,#78746a);font-size:10px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.oc-web-preview-summary-body{padding:0 14px 12px;border-top:1px solid var(--line-soft,#2c2b26)}
.oc-web-preview-summary-body .oc-web-preview-state{min-height:116px}
.oc-web-preview-summary-list{margin:10px 0;padding-left:20px}.oc-web-preview-summary-list li{margin:8px 0;color:var(--ink-2,#c3beb4);font-size:13px;line-height:1.65}
.oc-web-preview-summary-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:10px}
.oc-web-preview-cite{min-height:0;border-color:#d8d4c9;background:#f4f1e9;color:#2f6b4f;padding:2px 5px;font-size:10px}
.oc-web-preview-notice{max-width:920px;margin:0 auto 10px;border:1px solid var(--line,#3a382f);border-radius:8px;background:var(--panel,#242320);padding:9px 11px;color:var(--ink-2,#c3beb4);font-size:12px;line-height:1.5}
.oc-live-browser{position:relative;width:100%;height:100%;min-height:420px;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line,#3a382f);border-radius:9px;background:#11110f}
.oc-live-browser-stage{position:relative;flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;background:#fff;outline:0;cursor:default}
.oc-live-browser-stage:focus-visible{outline:2px solid var(--accent,#4fae7f);outline-offset:-2px}
.oc-live-browser-frame{display:block;max-width:100%;max-height:100%;width:auto;height:auto;user-select:none;-webkit-user-drag:none}
.oc-live-browser-overlay{position:absolute;inset:0;display:grid;place-items:center;background:color-mix(in srgb,#fff 74%,transparent);color:#353531;font-size:12px;pointer-events:none}
.oc-live-browser-footer{min-height:30px;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--line-soft,#2c2b26);background:var(--panel,#242320);color:var(--ink-3,#78746a);font-size:10px;line-height:1.35}
.oc-live-browser-footer-status{margin-left:auto;color:var(--ink-2,#c3beb4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oc-live-browser-recovery{display:flex;justify-content:center;gap:7px;flex-wrap:wrap}
.oc-web-preview-pdf{display:block;width:100%;height:100%;min-height:480px;border:1px solid var(--line,#3a382f);border-radius:9px;background:#fff}
.oc-web-preview-state{min-height:320px;display:grid;place-items:center;text-align:center;color:var(--ink-2,#c3beb4)}
.oc-web-preview-state-inner{max-width:360px}.oc-web-preview-state h3{margin:0 0 7px;color:var(--ink,#ece9e2);font-size:15px}.oc-web-preview-state p{margin:0 0 13px;font-size:12px;line-height:1.55}
.oc-web-preview-failure{width:min(100%,480px);max-width:none;text-align:left}.oc-web-preview-failure-head{display:flex;align-items:flex-start;gap:10px}.oc-web-preview-failure-mark{display:grid;flex:none;width:24px;height:24px;place-items:center;border:1px solid color-mix(in srgb,var(--danger,#d15c54) 55%,transparent);border-radius:7px;background:color-mix(in srgb,var(--danger,#d15c54) 12%,transparent);color:var(--danger,#d15c54);font-size:13px;font-weight:700}.oc-web-preview-failure h3{margin:2px 0 5px}.oc-web-preview-failure-hint{color:var(--ink-3,#78746a)}
.oc-web-preview-failure-reason{margin:12px 0;border:1px solid var(--line,#3a382f);border-radius:8px;background:var(--bg,#1a1a18);padding:9px 10px}.oc-web-preview-failure-reason-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;color:var(--ink-3,#78746a);font-size:10px}.oc-web-preview-failure-reason code{font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--ink-3,#78746a)}.oc-web-preview-failure-reason p{margin:0;color:var(--ink-2,#c3beb4);overflow-wrap:anywhere}
.oc-web-preview-failure-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.oc-web-preview-failure-alt{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:13px;padding-top:12px;border-top:1px solid var(--line-soft,#2c2b26);color:var(--ink-3,#78746a);font-size:11px}.oc-web-preview-failure-alt .oc-web-preview-action{min-height:27px;padding:4px 7px}
.oc-web-preview-skeleton{width:min(100%,680px)}.oc-web-preview-skeleton span{display:block;height:12px;margin:12px 0;border-radius:4px;background:var(--line,#3a382f)}.oc-web-preview-skeleton span:nth-child(2){width:82%}.oc-web-preview-skeleton span:nth-child(3){width:91%}.oc-web-preview-skeleton span:nth-child(4){width:68%}
@container (max-width:520px){.oc-web-preview-nav{gap:2px;padding:5px 6px}.oc-web-preview-nav-button{padding:4px 5px}.oc-web-preview-address{padding:0 6px}.oc-web-preview-address-lock{display:none}.oc-web-preview-summary-trigger{padding-inline:7px}.oc-web-preview-main{padding:8px}.oc-web-preview-summary-actions{justify-content:stretch}.oc-web-preview-summary-actions .oc-web-preview-action{flex:1}.oc-live-browser-footer{align-items:flex-start;flex-direction:column}.oc-live-browser-footer-status{margin-left:0;max-width:100%}}
@container (max-width:390px){.oc-web-preview-status:not(:empty){order:2;flex-basis:100%}.oc-web-preview-more-menu{position:fixed;top:auto;right:8px;left:8px}.oc-web-preview-failure-actions .oc-web-preview-action{flex:1;text-align:center}.oc-web-preview-failure-alt{align-items:stretch}.oc-web-preview-failure-alt>span{flex-basis:100%}.oc-web-preview-failure-alt .oc-web-preview-action{flex:1}}
`;

function WebPreviewStyles(): ReactElement {
  return <style data-oc-web-preview-styles="true">{WEB_PREVIEW_CSS}</style>;
}

function LoadingState({ label }: { label: string }): ReactElement {
  return <div className="oc-web-preview-state" role="status" aria-live="polite">
    <div className="oc-web-preview-state-inner oc-web-preview-skeleton">
      <p>{label}</p><span /><span /><span /><span />
    </div>
  </div>;
}

function ErrorState({ title, detail, retryLabel, onRetry }: {
  title: string; detail: string; retryLabel: string; onRetry: () => void;
}): ReactElement {
  return <div className="oc-web-preview-state" role="alert">
    <div className="oc-web-preview-state-inner"><h3>{title}</h3><p>{detail}</p>
      <button type="button" className="oc-web-preview-action" onClick={onRetry}>{retryLabel}</button>
    </div>
  </div>;
}

function PageFailureState({ failure, copy, externalUrl, onRetry, onPaste, onUpload }: {
  failure: WebPreviewFailureDescription;
  copy: typeof ZH;
  externalUrl: string | null;
  onRetry: () => void;
  onPaste: () => void;
  onUpload: () => void;
}): ReactElement {
  return <div className="oc-web-preview-state" role="alert" data-error-code={failure.code}>
    <div className="oc-web-preview-state-inner oc-web-preview-failure">
      <div className="oc-web-preview-failure-head">
        <span className="oc-web-preview-failure-mark" aria-hidden="true">!</span>
        <div><h3>{failure.title}</h3><p className="oc-web-preview-failure-hint">{failure.hint}</p></div>
      </div>
      <div className="oc-web-preview-failure-reason">
        <div className="oc-web-preview-failure-reason-label"><span>{copy.failureReason}</span>
          <code title={copy.failureCode}>{failure.code}</code></div>
        <p>{failure.detail}</p>
      </div>
      <div className="oc-web-preview-failure-actions">
        <button type="button" className="oc-web-preview-action oc-web-preview-action-primary"
          onClick={onRetry}>↻ {copy.retry}</button>
        {externalUrl ? <a className="oc-web-preview-action" href={externalUrl} target="_blank"
          rel="noopener noreferrer">↗ {copy.openBrowser}</a> : null}
      </div>
      <div className="oc-web-preview-failure-alt"><span>{copy.alternativeLead}</span>
        <button type="button" className="oc-web-preview-action" onClick={onPaste}>{copy.pasteContent}</button>
        <button type="button" className="oc-web-preview-action" onClick={onUpload}>{copy.uploadMaterial}</button>
      </div>
    </div>
  </div>;
}

interface LiveBrowserCanvasProps {
  sessionId: string;
  frame: LiveBrowserFrame | null;
  state: WebPreviewLoadState;
  error: string;
  actionPending: boolean;
  locale: "zh" | "en";
  externalUrl: string | null;
  onRetry: () => void;
  onPointer: (x: number, y: number) => void;
  onScroll: (deltaX: number, deltaY: number) => void;
  onKey: (request: Pick<LiveBrowserKeyRequest, "key" | "text">) => void;
}

function LiveBrowserCanvas({
  sessionId, frame, state, error, actionPending, locale, externalUrl, onRetry, onPointer, onScroll, onKey,
}: LiveBrowserCanvasProps): ReactElement {
  const copy = locale === "zh" ? ZH : EN;
  const [inputNotice, setInputNotice] = useState("");
  let frameUrl: string | null = null;
  if (frame) {
    try {
      frameUrl = liveFrameFromWire(frame, sessionId, frame.browserSessionId).frameUrl;
    } catch { frameUrl = null; }
  }

  if (state === "loading" || state === "idle") return <LoadingState label={copy.liveStarting} />;
  if (state === "error" || !frame || !frameUrl) {
    const detail = error || (!frameUrl && frame ? copy.liveFrameInvalid : copy.liveUnavailableDetail);
    return <div className="oc-web-preview-state" role="alert">
      <div className="oc-web-preview-state-inner">
        <h3>{copy.liveUnavailable}</h3><p>{detail}</p>
        <div className="oc-live-browser-recovery">
          <button type="button" className="oc-web-preview-action oc-web-preview-action-primary"
            onClick={onRetry}>{copy.liveRetry}</button>
          {externalUrl ? <a className="oc-web-preview-action" href={externalUrl} target="_blank"
            rel="noopener noreferrer">{copy.external}</a> : null}
        </div>
      </div>
    </div>;
  }

  const clickFrame = (event: ReactMouseEvent<HTMLImageElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || actionPending) return;
    const x = Math.max(0, Math.min(frame.width - 1,
      Math.round((event.clientX - rect.left) * frame.width / rect.width)));
    const y = Math.max(0, Math.min(frame.height - 1,
      Math.round((event.clientY - rect.top) * frame.height / rect.height)));
    event.currentTarget.parentElement?.focus();
    onPointer(x, y);
  };
  const scrollFrame = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (actionPending) return;
    event.preventDefault();
    onScroll(Math.round(event.deltaX), Math.round(event.deltaY));
  };
  const keyFrame = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (actionPending) return;
    if (event.key === "Enter" || event.metaKey || event.ctrlKey || event.altKey) {
      event.preventDefault();
      setInputNotice(copy.liveKeyboardBlocked);
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      setInputNotice("");
      onKey({ text: event.key });
      return;
    }
    if (["Backspace", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Home", "End", "PageUp", "PageDown"]
      .includes(event.key)) {
      event.preventDefault();
      setInputNotice("");
      onKey({ key: event.key });
    }
  };

  return <section className="oc-live-browser" aria-label={frame.title || frame.url}>
    <div className="oc-live-browser-stage" role="application" tabIndex={0}
      aria-label={locale === "zh" ? "交互式网页画面" : "Interactive web page"}
      onWheel={scrollFrame} onKeyDown={keyFrame}>
      <img className="oc-live-browser-frame" src={frameUrl} width={frame.width} height={frame.height}
        alt={locale === "zh" ? `${frame.title || displayHost(frame.url)} 的实时网页画面` : `Live view of ${frame.title || displayHost(frame.url)}`}
        draggable={false} referrerPolicy="no-referrer" onClick={clickFrame} />
      {frame.loading || actionPending ? <div className="oc-live-browser-overlay" role="status">
        {frame.loading ? copy.liveLoadingPage : "…"}
      </div> : null}
    </div>
    <footer className="oc-live-browser-footer">
      <span>{copy.liveSafety}</span>
      <span className="oc-live-browser-footer-status" role="status" aria-live="polite">
        {inputNotice || frame.error || ""}
      </span>
    </footer>
  </section>;
}

function SummaryPanel({ page, summary, state, error, open, locale, onToggle, onRetry, onLocate, onSend }: {
  page: WebPreviewPage;
  summary: WebPreviewSummary | null;
  state: WebPreviewLoadState;
  error: string;
  open: boolean;
  locale: "zh" | "en";
  onToggle: () => void;
  onRetry: () => void;
  onLocate: (citationId: string) => void;
  onSend: () => void;
}): ReactElement {
  const c = locale === "zh" ? ZH : EN;
  const panelId = useId();
  const citations = citationMap(page);
  const stale = summary !== null && summaryDigest(summary) !== page.digest;
  return <section className="oc-web-preview-summary" aria-label={c.summary}>
    <header className="oc-web-preview-summary-head">
      <div className="oc-web-preview-summary-title">{c.summary}
        {summary?.generatedAt ? <span className="oc-web-preview-summary-meta">· {timeLabel(summary.generatedAt, locale)}</span> : null}
        <a className="oc-web-preview-summary-source" href={page.finalUrl || page.url}
          target="_blank" rel="noopener noreferrer">{page.finalUrl || page.url}</a>
      </div>
      <button type="button" className="oc-web-preview-action" aria-expanded={open} aria-controls={panelId}
        onClick={onToggle}>{open ? (locale === "zh" ? "收起" : "Collapse") : (locale === "zh" ? "展开" : "Expand")}</button>
    </header>
    {open ? <div className="oc-web-preview-summary-body" id={panelId}>
      {state === "loading" ? <LoadingState label={c.summarizing} /> : null}
      {state === "error" ? <ErrorState title={c.summaryFailed} detail={error} retryLabel={c.retry} onRetry={onRetry} /> : null}
      {state === "ready" && stale ? <div className="oc-web-preview-notice">{c.summaryStale}</div> : null}
      {state === "ready" && summary && !stale ? <>
        <ul className="oc-web-preview-summary-list">
          {summary.bullets.map((bullet, bulletIndex) => <li key={bullet.id || `${bulletIndex}:${bullet.text}`}>{bullet.text}{" "}
            {bullet.citationIds.map((citationId) => {
              const entry = citations.get(citationId);
              return entry ? <button type="button" className="oc-web-preview-cite" key={citationId}
                aria-label={`${c.citation} ${entry.index}`} onClick={() => onLocate(citationId)}>[{entry.index}]</button> : null;
            })}
          </li>)}
        </ul>
        <div className="oc-web-preview-summary-actions">
          <button type="button" className="oc-web-preview-action oc-web-preview-action-primary" onClick={onSend}>{c.sendSummary}</button>
        </div>
      </> : null}
      {state === "ready" && summary?.bullets.length === 0 ? <div className="oc-web-preview-notice">{c.emptySummary}</div> : null}
    </div> : null}
  </section>;
}

export default function WebPreview({
  sessionId, target, client: suppliedClient, liveBrowserClient: suppliedLiveBrowserClient,
  initialPage = null, initialSummary = null,
  locale = "zh", active = true, initialHistoryState = null,
  onHistoryStateChange, summaryFocus,
  canGoBack, canGoForward, onBack, onForward, onNavigate, onPageChange, onLivePageChange,
  onCitation, onSendToChat, onMaterialSaved, onRequestPasteContent, onRequestUpload, className = "",
}: WebPreviewProps): ReactElement {
  const copy = locale === "zh" ? ZH : EN;
  const client = useMemo(() => suppliedClient ?? createWebPreviewHttpClient(), [suppliedClient]);
  const liveClient = useMemo(() => suppliedLiveBrowserClient === undefined
    ? createLiveBrowserHttpClient() : suppliedLiveBrowserClient, [suppliedLiveBrowserClient]);
  const propTargetKey = `${target.pageId ?? ""}\u0000${target.url}`;
  const lastPropTargetKey = useRef(propTargetKey);
  // The workbench parent reflects every loaded immutable pageId back into the
  // tab target.  That acknowledgement is not a new navigation and must not
  // create a duplicate browser-history entry (otherwise one Back click appears
  // to do nothing).  Keep the exact key of the page we just emitted so the
  // prop-sync effect can replace the current entry instead of appending it.
  const emittedPageTargetKey = useRef("");
  const initialHistory = useRef<WebPreviewHistoryState | null>(null);
  if (initialHistory.current === null) {
    initialHistory.current = normalizeWebPreviewHistoryState(initialHistoryState, target);
  }
  const [historyState, setHistoryState] = useState<WebPreviewHistoryState>(initialHistory.current);
  const history = historyState.entries;
  const historyIndex = historyState.index;
  const request = history[historyIndex] ?? target;
  const requestKey = `${request.pageId ?? ""}\u0000${request.url}`;
  const [address, setAddress] = useState(target.url);
  const [page, setPage] = useState<WebPreviewPage | null>(initialPage);
  const [loadState, setLoadState] = useState<WebPreviewLoadState>(initialPage ? "ready" : "loading");
  const [loadError, setLoadError] = useState<WebPreviewFailureCause | null>(null);
  const [retry, setRetry] = useState(0);
  const [liveState, setLiveState] = useState<WebPreviewLoadState>("idle");
  const [liveFrame, setLiveFrame] = useState<LiveBrowserFrame | null>(null);
  const [liveError, setLiveError] = useState("");
  const [liveRetry, setLiveRetry] = useState(0);
  const [liveActionPending, setLiveActionPending] = useState(false);
  const [liveActionError, setLiveActionError] = useState("");
  const [summary, setSummary] = useState<WebPreviewSummary | null>(initialSummary);
  const [summaryPage, setSummaryPage] = useState<WebPreviewPage | null>(initialSummary ? initialPage : null);
  const [summaryOpen, setSummaryOpen] = useState(initialSummary !== null);
  const [summaryState, setSummaryState] = useState<WebPreviewLoadState>(initialSummary ? "ready" : "idle");
  const [summaryError, setSummaryError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const historyChangeRef = useRef(onHistoryStateChange);
  const livePageChangeRef = useRef(onLivePageChange);
  const emittedLiveFrameRef = useRef("");
  const liveFrameRef = useRef<LiveBrowserFrame | null>(liveFrame);
  const liveOperationRef = useRef<Promise<void>>(Promise.resolve());
  const liveSnapshotPendingRef = useRef(false);
  const pdfResource = page?.resource?.kind === "pdf" ? page.resource : null;
  const isPdf = pdfResource !== null;
  const externalHistory = onBack !== undefined || onForward !== undefined;
  const effectiveCanGoBack = externalHistory ? (canGoBack ?? onBack !== undefined) : historyIndex > 0;
  const effectiveCanGoForward = externalHistory
    ? (canGoForward ?? onForward !== undefined) : historyIndex < history.length - 1;

  useEffect(() => { historyChangeRef.current = onHistoryStateChange; }, [onHistoryStateChange]);
  useEffect(() => { livePageChangeRef.current = onLivePageChange; }, [onLivePageChange]);
  useEffect(() => { historyChangeRef.current?.(historyState); }, [historyState]);

  const publishLiveFrame = (nextFrame: LiveBrowserFrame): void => {
    const key = `${nextFrame.browserSessionId}\u0000${nextFrame.url}\u0000${nextFrame.title}\u0000${nextFrame.seq}`;
    if (emittedLiveFrameRef.current === key) return;
    emittedLiveFrameRef.current = key;
    livePageChangeRef.current?.(nextFrame);
  };

  const acceptLiveFrame = (nextFrame: LiveBrowserFrame): void => {
    liveFrameRef.current = nextFrame;
    setLiveFrame(nextFrame);
    setLiveState("ready");
    setLiveError("");
    setLiveActionError("");
    publishLiveFrame(nextFrame);
    if (document.activeElement !== addressInputRef.current) setAddress(nextFrame.url);
  };

  /** Browser actions, refresh screenshots and DOM freezing share one client-side order. */
  const queueLiveOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const run = liveOperationRef.current.then(operation, operation);
    liveOperationRef.current = run.then(() => undefined, () => undefined);
    return run;
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!moreRef.current?.contains(event.target as any)) setMoreOpen(false);
    };
    const onKeyDown = (event: Event): void => {
      if ((event as Event & { readonly key?: string }).key !== "Escape") return;
      event.preventDefault();
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  useEffect(() => { setMoreOpen(false); }, [requestKey]);

  const focusMoreItem = (position: "first" | "last" | "next" | "previous"): void => {
    const items = Array.from(moreMenuRef.current?.querySelectorAll("[role=menuitem]:not([disabled])") ?? []) as any[];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    let index = 0;
    if (position === "last") index = items.length - 1;
    else if (position === "next") index = current < 0 ? 0 : (current + 1) % items.length;
    else if (position === "previous") index = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    items[index]?.focus();
  };

  const openMoreFromKeyboard = (): void => {
    setMoreOpen(true);
    queueMicrotask(() => focusMoreItem("first"));
  };

  /** Prop changes are real parent navigation; internal address/history changes must not snap back to the initial prop. */
  useEffect(() => {
    if (lastPropTargetKey.current === propTargetKey) return;
    lastPropTargetKey.current = propTargetKey;
    setAddress(target.url);
    if (!externalHistory && emittedPageTargetKey.current === propTargetKey) {
      emittedPageTargetKey.current = "";
      setHistoryState((current) => normalizeWebPreviewHistoryState({
        entries: current.entries.map((item, index) => index === current.index ? target : item),
        index: current.index,
      }, target));
      return;
    }
    if (externalHistory) {
      setHistoryState(normalizeWebPreviewHistoryState({ entries: [target], index: 0 }, target));
      return;
    }
    setHistoryState((current) => {
      const entries = [...current.entries.slice(0, current.index + 1), target];
      return normalizeWebPreviewHistoryState({ entries, index: entries.length - 1 }, target);
    });
  }, [externalHistory, propTargetKey, target]);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    // POST /web/pages returns a pageId. Replacing the current URL entry with that
    // durable id must not trigger a duplicate GET or clear its summary.
    if (page !== null && request.pageId !== undefined && request.pageId === page.id) {
      setAddress(page.finalUrl || page.url);
      setLoadState("ready");
      return () => { current = false; controller.abort(); };
    }
    setLoadError(null);
    setSaveState("idle");
    setSaveError("");

    const initialMatches = initialPage !== null && (
      (request.pageId !== undefined && initialPage.id === request.pageId)
      || (request.pageId === undefined && (initialPage.url === request.url || initialPage.finalUrl === request.url))
    );
    if (initialMatches && retry === 0) {
      setPage(initialPage);
      setSummary(initialSummary);
      setSummaryPage(initialSummary ? initialPage : null);
      setSummaryState(initialSummary ? "ready" : "idle");
      setSummaryOpen(initialSummary !== null);
      setAddress(initialPage.finalUrl || initialPage.url);
      setLoadState("ready");
      if (request.pageId === undefined) {
        const entry = { pageId: initialPage.id, url: initialPage.finalUrl || initialPage.url };
        setHistoryState((current) => normalizeWebPreviewHistoryState({
          entries: current.entries.map((item, index) => index === current.index ? entry : item),
          index: current.index,
        }, entry));
      }
      return () => { current = false; controller.abort(); };
    }
    setSummary(null);
    setSummaryPage(null);
    setSummaryState("idle");
    setSummaryOpen(false);
    setPage(null);
    setAddress(request.url);
    setLoadState("loading");
    const load = request.pageId
      ? client.get({ sessionId, pageId: request.pageId, signal: controller.signal })
      : client.open({ sessionId, url: request.url, signal: controller.signal });
    void load.then((nextPage) => {
      if (!current) return;
      setPage(nextPage);
      setAddress(nextPage.finalUrl || nextPage.url);
      setLoadState("ready");
      const entry = { pageId: nextPage.id, url: nextPage.finalUrl || nextPage.url };
      setHistoryState((current) => normalizeWebPreviewHistoryState({
        entries: current.entries.map((item, index) => index === current.index ? entry : item),
        index: current.index,
      }, entry));
      emittedPageTargetKey.current = `${nextPage.id}\u0000${nextPage.finalUrl || nextPage.url}`;
      onPageChange?.(nextPage);
    }).catch((error: unknown) => {
      if (!current || controller.signal.aborted) return;
      setLoadState("error");
      setLoadError(failureCause(error, copy.openFailed));
    });
    return () => { current = false; controller.abort(); };
  }, [client, historyIndex, initialPage, initialSummary,
    request.pageId, request.url, retry, sessionId]);

  useEffect(() => {
    let alive = true;
    let openedSessionId = "";
    const controller = new AbortController();
    if (!active || isPdf) return () => { controller.abort(); };
    if (!liveClient) {
      liveFrameRef.current = null;
      setLiveFrame(null);
      setLiveState("error");
      setLiveError(copy.liveUnavailableDetail);
      return () => { controller.abort(); };
    }
    const safeUrl = normalizeSafeWebUrl(request.url);
    if (!safeUrl) {
      liveFrameRef.current = null;
      setLiveFrame(null);
      setLiveState("error");
      setLiveError(copy.invalid);
      return () => { controller.abort(); };
    }
    liveFrameRef.current = null;
    setLiveFrame(null);
    setLiveState("loading");
    setLiveError("");
    setLiveActionError("");
    const bounds = mainRef.current?.getBoundingClientRect();
    const viewport: LiveBrowserViewport = {
      width: Math.max(640, Math.min(1_600, Math.round(bounds?.width || 1_280))),
      height: Math.max(480, Math.min(1_200, Math.round(bounds?.height || 900))),
    };
    void (async () => {
      try {
        const capabilities = await liveClient.capabilities({ sessionId, signal: controller.signal });
        if (!alive) return;
        if (!capabilities.available) throw new Error(capabilities.reason || copy.liveUnavailableDetail);
        const nextFrame = await liveClient.open({ sessionId, url: safeUrl, viewport, signal: controller.signal });
        if (!alive) {
          void liveClient.close({ sessionId, browserSessionId: nextFrame.browserSessionId }).catch(() => undefined);
          return;
        }
        openedSessionId = nextFrame.browserSessionId;
        acceptLiveFrame(nextFrame);
      } catch (error: unknown) {
        if (!alive || controller.signal.aborted) return;
        liveFrameRef.current = null;
        setLiveFrame(null);
        setLiveState("error");
        setLiveError(boundedFailureText(error instanceof Error ? error.message : error, copy.liveUnavailableDetail));
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (openedSessionId) {
        void liveClient.close({ sessionId, browserSessionId: openedSessionId }).catch(() => undefined);
      }
    };
  }, [active, copy.invalid, copy.liveUnavailableDetail, isPdf, liveClient, liveRetry, request.url, sessionId]);

  useEffect(() => {
    const browserSessionId = liveFrame?.browserSessionId;
    if (!active || !liveClient || !browserSessionId || isPdf) return;
    let polling = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let cycle = 0;
    const poll = (): void => {
      // Fast while a SPA is likely to be hydrating, then back off to keep active-tab bandwidth
      // bounded. Hidden workbench/browser tabs perform no screenshot work at all.
      const delay = cycle < 5 ? 1_200 : cycle < 12 ? 3_000 : 8_000;
      timeout = setTimeout(() => {
        if (typeof document !== "undefined" && document.hidden) {
          if (polling) poll();
          return;
        }
        cycle += 1;
        void queueLiveOperation(async () => {
          if (!polling || liveSnapshotPendingRef.current) return;
          const current = liveFrameRef.current;
          if (!current || current.browserSessionId !== browserSessionId) return;
          const nextFrame = await liveClient.screenshot({
            sessionId, browserSessionId, signal: controller.signal,
          });
          if (polling) acceptLiveFrame(nextFrame);
        }).catch((error: unknown) => {
          if (!polling || controller.signal.aborted) return;
          setLiveActionError(boundedFailureText(error instanceof Error ? error.message : error, copy.liveActionFailed));
        }).finally(() => {
          if (polling) poll();
        });
      }, delay);
    };
    poll();
    return () => {
      polling = false;
      controller.abort();
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [active, copy.liveActionFailed, isPdf, liveClient, liveFrame?.browserSessionId, sessionId]);

  const currentDocumentUrl = (): string | null => normalizeSafeWebUrl(
    isPdf ? (page?.finalUrl || page?.url || request.url) : (liveFrame?.url || request.url),
  );

  const ensureCurrentSnapshot = async (): Promise<WebPreviewPage> => {
    if (!isPdf) {
      // Freeze the DOM of the exact Chromium frame the user currently sees.  Re-fetching the URL
      // here would miss client-rendered SPA content and could summarize a different navigation.
      // Pause new screenshot polls and join their operation queue; if one was already in flight,
      // use the freshly published seq/URL rather than a stale React render closure.
      liveSnapshotPendingRef.current = true;
      try {
        return await queueLiveOperation(async () => {
          const current = liveFrameRef.current;
          if (!current) throw new Error(copy.liveLoadingPage);
          const url = normalizeSafeWebUrl(current.url);
          if (!url) throw new Error(copy.invalid);
          const nextPage = await client.snapshotLive({
            sessionId,
            browserSessionId: current.browserSessionId,
            seq: current.seq,
            url,
          });
          setPage(nextPage);
          return nextPage;
        });
      } finally {
        liveSnapshotPendingRef.current = false;
      }
    }
    const url = currentDocumentUrl();
    if (!url) throw new Error(copy.invalid);
    const existingUrl = page ? normalizeSafeWebUrl(page.finalUrl || page.url) : null;
    if (page && existingUrl === url) return page;
    const nextPage = await client.open({ sessionId, url });
    setPage(nextPage);
    return nextPage;
  };

  useEffect(() => {
    if (!summaryPage || isPdf || !liveFrame?.url) return;
    const currentUrl = normalizeSafeWebUrl(liveFrame.url);
    const summarizedUrl = normalizeSafeWebUrl(summaryPage.finalUrl || summaryPage.url);
    if (currentUrl && summarizedUrl !== currentUrl) {
      setSummary(null);
      setSummaryPage(null);
      setSummaryOpen(false);
      setSummaryState("idle");
      setSummaryError("");
    }
  }, [isPdf, liveFrame?.url, summaryPage]);

  useEffect(() => {
    if (!liveFrame?.url) return;
    setSaveState("idle");
    setSaveError("");
  }, [liveFrame?.url]);

  const loadSummary = async (): Promise<void> => {
    if (summaryState === "loading") return;
    setSummaryOpen(true);
    setSummaryState("loading");
    setSummaryError("");
    try {
      const sourcePage = await ensureCurrentSnapshot();
      setSummaryPage(sourcePage);
      const summarizeRequest: WebPreviewSummarizeRequest = { sessionId, pageId: sourcePage.id };
      summarizeRequest.language = locale === "zh" ? "zh-CN" : "en";
      if (summaryFocus !== undefined) summarizeRequest.focus = summaryFocus;
      const nextSummary = await client.summarize(summarizeRequest);
      setSummary(nextSummary);
      setSummaryState("ready");
    } catch (error: unknown) {
      setSummaryState("error");
      setSummaryError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleSummary = (): void => {
    if (!summaryOpen && summary === null && summaryState !== "loading") void loadSummary();
    else setSummaryOpen((value) => !value);
  };

  const locateCitation = (citationId: string): void => {
    const sourcePage = summaryPage;
    if (!sourcePage || !citationId) return;
    const found = sourcePage.citations.find((citation) => citation.id === citationId);
    if (!found) return;
    onCitation?.(found, sourcePage);
  };

  const sendPayload = async (payload: WebPreviewChatPayload): Promise<void> => {
    if (onSendToChat) await onSendToChat(payload);
    else prefillComposer(payload.text);
  };

  const saveMaterial = async (): Promise<void> => {
    if (saveState === "saving") return;
    setSaveState("saving");
    setSaveError("");
    try {
      const sourcePage = await ensureCurrentSnapshot();
      const receipt = await client.save({ sessionId, pageId: sourcePage.id });
      setSaveState("saved");
      onMaterialSaved?.(receipt, sourcePage);
    } catch (error: unknown) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const citeCurrentPage = async (): Promise<void> => {
    try { await sendPayload(pageChatPayload(await ensureCurrentSnapshot())); }
    catch (error: unknown) {
      setSaveState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const runLiveAction = async (operation: () => Promise<LiveBrowserFrame>): Promise<void> => {
    if (liveActionPending) return;
    setLiveActionPending(true);
    setLiveActionError("");
    try { await queueLiveOperation(async () => acceptLiveFrame(await operation())); }
    catch (error: unknown) {
      setLiveActionError(boundedFailureText(error instanceof Error ? error.message : error, copy.liveActionFailed));
    } finally { setLiveActionPending(false); }
  };

  const submitAddress = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const safe = normalizeSafeWebUrl(address);
    if (!safe) {
      setPage(null);
      setLoadState("error");
      setLoadError({ reason: copy.invalid, code: "invalid_url" });
      return;
    }
    if (!isPdf && liveClient && liveFrame) {
      void runLiveAction(() => liveClient.navigate({
        sessionId, browserSessionId: liveFrame.browserSessionId, url: safe,
      }));
      return;
    }
    onNavigate?.(safe);
    setHistoryState((current) => {
      const entry = { url: safe };
      const active = current.entries[current.index];
      // Re-opening the current URL is a retry/refresh, not a new place in the
      // browsing history. Replacing the blocked pageId also prevents Back from
      // landing on a stale timeout snapshot after a successful retry.
      if (active && normalizeSafeWebUrl(active.url) === safe) {
        const entries = current.entries.map((item, index) => index === current.index ? entry : item);
        return normalizeWebPreviewHistoryState({ entries, index: current.index }, entry);
      }
      const entries = [...current.entries.slice(0, current.index + 1), entry];
      return normalizeWebPreviewHistoryState({ entries, index: entries.length - 1 }, entry);
    });
  };

  const reload = (): void => {
    if (!isPdf && liveClient && liveFrame) {
      void runLiveAction(() => liveClient.reload({ sessionId, browserSessionId: liveFrame.browserSessionId }));
      return;
    }
    const entry = { url: page ? page.finalUrl || page.url : request.url };
    setHistoryState((current) => normalizeWebPreviewHistoryState({
      entries: current.entries.map((item, index) => index === current.index ? entry : item),
      index: current.index,
    }, entry));
    setRetry((value) => value + 1);
  };

  const goBack = (): void => {
    if (!isPdf && liveClient && liveFrame) {
      void runLiveAction(() => liveClient.back({ sessionId, browserSessionId: liveFrame.browserSessionId }));
      return;
    }
    if (externalHistory) { onBack?.(); return; }
    setHistoryState((current) => ({ ...current, index: Math.max(0, current.index - 1) }));
  };

  const goForward = (): void => {
    if (!isPdf && liveClient && liveFrame) {
      void runLiveAction(() => liveClient.forward({ sessionId, browserSessionId: liveFrame.browserSessionId }));
      return;
    }
    if (externalHistory) { onForward?.(); return; }
    setHistoryState((current) => ({
      ...current,
      index: Math.min(current.entries.length - 1, current.index + 1),
    }));
  };

  const livePointer = (x: number, y: number): void => {
    if (!liveClient || !liveFrame) return;
    void runLiveAction(() => liveClient.pointer({
      sessionId, browserSessionId: liveFrame.browserSessionId, x, y, action: "click",
    }));
  };
  const liveScroll = (deltaX: number, deltaY: number): void => {
    if (!liveClient || !liveFrame) return;
    void runLiveAction(() => liveClient.scroll({
      sessionId, browserSessionId: liveFrame.browserSessionId, deltaX, deltaY,
    }));
  };
  const liveKey = (input: Pick<LiveBrowserKeyRequest, "key" | "text">): void => {
    if (!liveClient || !liveFrame) return;
    void runLiveAction(() => liveClient.key({
      sessionId, browserSessionId: liveFrame.browserSessionId, ...input,
    }));
  };

  const liveSurface = !isPdf;
  const externalUrl = normalizeSafeWebUrl(liveSurface && liveFrame ? liveFrame.url
    : loadState === "error" ? address : page ? page.finalUrl || page.url : request.url);
  const failureExternalUrl = normalizeSafeWebUrl(address);
  const fallbackTarget: WebPreviewTarget = {
    url: failureExternalUrl || request.url,
    ...(page?.id ? { pageId: page.id } : request.pageId ? { pageId: request.pageId } : {}),
  };
  const requestPasteContent = (): void => {
    if (onRequestPasteContent) { onRequestPasteContent(fallbackTarget); return; }
    prefillComposer(`${copy.pastePrompt}\n${failureExternalUrl || request.url}\n\n`, { mode: "replace" });
  };
  const requestUpload = (): void => {
    if (onRequestUpload) { onRequestUpload(fallbackTarget); return; }
    const picker = document.getElementById("picker") as (HTMLElement & { click?: () => void }) | null;
    if (typeof picker?.click === "function") picker.click();
    else prefillComposer(`${copy.uploadPrompt}\n${failureExternalUrl || request.url}`, { mode: "replace" });
  };
  const pdfPreviewUrl = normalizePdfPreviewUrl(pdfResource?.previewUrl);
  const hasReadableText = Boolean(page?.paragraphs.length)
    && (!pdfResource || pdfResource.textStatus !== "unavailable");
  const statusMessage = liveSurface && liveActionError ? `${copy.liveActionFailed} · ${liveActionError}`
    : summaryState === "error" ? `${copy.summaryFailed} ${summaryError}`
    : saveState === "saving" ? copy.saving
    : saveState === "saved" ? copy.saved
    : saveState === "error" ? `${copy.saveFailed} ${saveError}`
    : pdfResource?.textStatus === "unavailable" ? copy.pdfTextUnavailable
    : pdfResource && (pdfResource.textStatus === "partial" || pdfResource.truncated)
      ? (locale === "zh"
        ? `已抽取 ${pdfResource.extractedPages}${pdfResource.totalPages === undefined ? "" : `/${pdfResource.totalPages}`} 页文本${pdfResource.truncated ? " · 已截断" : ""}`
        : `Extracted ${pdfResource.extractedPages}${pdfResource.totalPages === undefined ? "" : `/${pdfResource.totalPages}`} pages${pdfResource.truncated ? " · truncated" : ""}`)
    : "";

  const retryOpen = reload;
  const requestFailure = describeFailure(loadError ?? { reason: copy.openFailed }, copy);
  const emptyPageFailure = page
    ? describeFailure(pageFailureCause(page, copy.noSnapshot), copy)
    : describeFailure({ reason: copy.noSnapshot, code: "empty_page" }, copy);

  let content: ReactNode;
  if (liveSurface) content = <>
    {summaryPage && (summaryOpen || summary) ? <SummaryPanel page={summaryPage} summary={summary} state={summaryState}
      error={summaryError} open={summaryOpen} locale={locale} onToggle={toggleSummary}
      onRetry={() => { void loadSummary(); }} onLocate={locateCitation}
      onSend={() => { if (summary) void sendPayload(summaryChatPayload(summaryPage, summary)); }} /> : null}
    <LiveBrowserCanvas sessionId={sessionId} frame={liveFrame} state={liveState} error={liveError}
      actionPending={liveActionPending} locale={locale} externalUrl={externalUrl}
      onRetry={() => setLiveRetry((value) => value + 1)}
      onPointer={livePointer} onScroll={liveScroll} onKey={liveKey} />
  </>;
  else if (loadState === "loading" || loadState === "idle") content = <LoadingState label={copy.loading} />;
  else if (loadState === "error") content = <PageFailureState failure={requestFailure} copy={copy}
    externalUrl={failureExternalUrl} onRetry={retryOpen} onPaste={requestPasteContent} onUpload={requestUpload} />;
  else if (!page) content = <PageFailureState failure={emptyPageFailure} copy={copy}
    externalUrl={failureExternalUrl} onRetry={retryOpen} onPaste={requestPasteContent} onUpload={requestUpload} />;
  else if (isPdf && pdfPreviewUrl) content = <>
    {summaryPage && (summaryOpen || summary) ? <SummaryPanel page={summaryPage} summary={summary} state={summaryState}
      error={summaryError} open={summaryOpen} locale={locale} onToggle={toggleSummary}
      onRetry={() => { void loadSummary(); }} onLocate={locateCitation}
      onSend={() => { if (summary) void sendPayload(summaryChatPayload(summaryPage, summary)); }} /> : null}
    <object className="oc-web-preview-pdf"
    data={pdfPreviewUrl} type="application/pdf" aria-label={page.title}>
    <a className="oc-web-preview-action" href={pdfPreviewUrl} target="_blank" rel="noreferrer">{copy.pdfPreview}</a>
    </object>
  </>;
  else if (isPdf) content = <div className="oc-web-preview-state">
    <div className="oc-web-preview-state-inner"><h3>{copy.pdfPreviewUnavailable}</h3>
      <p>{pdfResource?.reason || copy.pdfPreviewUnavailable}</p>
    </div>
  </div>;
  else content = null;

  return <section className={`oc-web-preview ${className}`.trim()} data-load-state={loadState}
    data-page-status={page?.status ?? ""} data-surface={isPdf ? "pdf" : "live"}>
    <WebPreviewStyles />
    <header className="oc-web-preview-browser">
      <form className="oc-web-preview-nav" onSubmit={submitAddress}>
        <div className="oc-web-preview-nav-group">
          <button type="button" className="oc-web-preview-nav-button"
            disabled={liveSurface ? !liveFrame?.canGoBack || liveActionPending : !effectiveCanGoBack}
            onClick={goBack} aria-label={copy.back} title={copy.back}>{copy.backShort}</button>
          <button type="button" className="oc-web-preview-nav-button"
            disabled={liveSurface ? !liveFrame?.canGoForward || liveActionPending : !effectiveCanGoForward}
            onClick={goForward} aria-label={copy.forward} title={copy.forward}>{copy.forwardShort}</button>
          <button type="button" className="oc-web-preview-nav-button"
            disabled={liveSurface && (!liveFrame || liveActionPending)} onClick={reload}
            aria-label={copy.refresh} title={copy.refresh}>{copy.refreshShort}</button>
        </div>
        <label className="oc-web-preview-address">
          <span className="oc-web-preview-address-lock" aria-hidden="true">{displayProtocol(address)}</span>
          <input ref={addressInputRef} aria-label={copy.address} value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <button type="button" className="oc-web-preview-action oc-web-preview-action-primary oc-web-preview-summary-trigger"
          disabled={isPdf ? !page || !hasReadableText : !liveFrame} aria-expanded={summaryOpen}
          onClick={toggleSummary}>
          {summaryState === "loading" ? copy.summarizing : copy.summary}
        </button>
        <div className="oc-web-preview-more" ref={moreRef}>
          <button ref={moreButtonRef} type="button" className="oc-web-preview-nav-button"
            aria-label={copy.moreActions} title={copy.moreActions} aria-haspopup="menu" aria-expanded={moreOpen}
            aria-controls="oc-web-preview-more-menu" onClick={() => setMoreOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              openMoreFromKeyboard();
            }}>{copy.more}</button>
          {moreOpen ? <div ref={moreMenuRef} className="oc-web-preview-more-menu" id="oc-web-preview-more-menu"
            role="menu" aria-label={copy.moreActions} onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); focusMoreItem("next"); }
              else if (event.key === "ArrowUp") { event.preventDefault(); focusMoreItem("previous"); }
              else if (event.key === "Home") { event.preventDefault(); focusMoreItem("first"); }
              else if (event.key === "End") { event.preventDefault(); focusMoreItem("last"); }
            }}>
            <button type="button" role="menuitem" className="oc-web-preview-more-item" disabled={!page && !liveFrame}
              onClick={() => { setMoreOpen(false); void citeCurrentPage(); }}>{copy.citeChat}</button>
            <button type="button" role="menuitem" className="oc-web-preview-more-item"
              disabled={(!page && !liveFrame) || saveState === "saving" || saveState === "saved"}
              onClick={() => { setMoreOpen(false); void saveMaterial(); }}>
              {saveState === "saving" ? copy.saving : saveState === "saved" ? copy.saved : copy.save}
            </button>
            {externalUrl ? <a role="menuitem" className="oc-web-preview-more-item" href={externalUrl}
              target="_blank" rel="noopener noreferrer" onClick={() => setMoreOpen(false)}>{copy.external}</a> : null}
          </div> : null}
        </div>
      </form>
      {statusMessage ? <div className={`oc-web-preview-status ${saveState === "error" || summaryState === "error" ? "oc-web-preview-error" : ""}`}
        role="status" aria-live="polite" title={statusMessage}>{statusMessage}</div> : null}
    </header>
    <div className="oc-web-preview-main" ref={mainRef}>{content}</div>
  </section>;
}
