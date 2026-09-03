/**
 * OntoCopilot Live Browser Runtime.
 *
 * Reader (`web_preview.ts`) intentionally never executes third-party code.  This module is the
 * complementary surface: an isolated, anonymous Chromium context whose pixels are returned to the
 * same-origin UI.  The remote page is never placed in an iframe and its DOM/JS never crosses the
 * application origin.
 *
 * Two independent network gates are deliberate:
 *  1. request interception validates every navigation, redirect and subresource before Chromium
 *     may issue it and rejects unsafe methods/schemes;
 *  2. the local forward proxy resolves again, rejects mixed public/private answers and pins the TCP
 *     connection to a validated address.  The second gate closes the DNS-rebinding gap between a
 *     policy lookup and Chromium's own resolver.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";

import puppeteer from "puppeteer-core";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  HTTPRequest,
  KeyInput,
  MouseButton,
  Page,
  WebWorker,
} from "puppeteer-core";

import {
  defaultWebHostResolver,
  publicResolvedAddress,
  type ResolvedAddress,
  type WebHostResolver,
} from "./web_preview.js";
import {
  LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS,
  LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPH_CHARS,
  LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
  LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION,
  type LiveBrowserRawDocument,
} from "./live_browser_snapshot.js";

export const LIVE_BROWSER_SCHEMA_VERSION = "ontocopilot.live-browser/1" as const;
export const LIVE_BROWSER_DEFAULT_WIDTH = 1280;
export const LIVE_BROWSER_DEFAULT_HEIGHT = 800;
export const LIVE_BROWSER_MIN_WIDTH = 480;
export const LIVE_BROWSER_MIN_HEIGHT = 320;
export const LIVE_BROWSER_MAX_WIDTH = 1920;
export const LIVE_BROWSER_MAX_HEIGHT = 1440;
export const LIVE_BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
export const LIVE_BROWSER_CAPTURE_TIMEOUT_MS = 8_000;
export const LIVE_BROWSER_PROVIDER_OPEN_TIMEOUT_MS = 50_000;
export const LIVE_BROWSER_RUNTIME_OPEN_TIMEOUT_MS = 55_000;
export const LIVE_BROWSER_ACTION_TIMEOUT_MS = 12_000;
export const LIVE_BROWSER_NAVIGATION_ACTION_TIMEOUT_MS = 42_000;
export const LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS = 5_000;
export const LIVE_BROWSER_PROXY_TIMEOUT_MS = 30_000;
export const LIVE_BROWSER_RESPONSE_MAX_BYTES = 24_000_000;
export const LIVE_BROWSER_TUNNEL_MAX_BYTES = 64_000_000;
export const LIVE_BROWSER_TAB_MAX_BYTES = 96_000_000;
export const LIVE_BROWSER_TAB_MAX_REQUESTS = 512;
export const LIVE_BROWSER_TAB_MAX_WORKERS = 8;
export const LIVE_BROWSER_POST_MAX_BYTES = 256_000;
export const LIVE_BROWSER_DATA_URL_MAX_CHARS = 1_500_000;
export const LIVE_BROWSER_TUNNEL_MAX_LIFETIME_MS = 2 * 60_000;
export const LIVE_BROWSER_IDLE_TTL_MS = 10 * 60_000;
export const LIVE_BROWSER_MAX_TABS = 12;
export const LIVE_BROWSER_MAX_GLOBAL_TABS = 48;

/** Per-document network accounting. A stale generation can never spend the next page's budget. */
export class LiveBrowserNavigationBudget {
  generation = 0;
  requestCount = 0;
  receivedBytes = 0;
  exceeded = false;

  begin(): number {
    this.generation += 1;
    this.requestCount = 0;
    this.receivedBytes = 0;
    this.exceeded = false;
    return this.generation;
  }

  accountRequest(generation: number): "allowed" | "exceeded" | "stale" {
    if (generation !== this.generation) return "stale";
    this.requestCount += 1;
    return !this.exceeded && this.requestCount <= LIVE_BROWSER_TAB_MAX_REQUESTS ? "allowed" : "exceeded";
  }

  accountBytes(value: number, generation: number): "allowed" | "exceeded" | "stale" {
    if (generation !== this.generation) return "stale";
    this.receivedBytes += Math.max(0, Number.isFinite(value) ? value : 0);
    return !this.exceeded && this.receivedBytes <= LIVE_BROWSER_TAB_MAX_BYTES ? "allowed" : "exceeded";
  }

  exhaust(): void { this.exceeded = true; }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);
const SAFE_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROXY_METHODS = new Set([...SAFE_READ_METHODS, "POST"]);
const SAFE_KEY_INPUTS = new Set<KeyInput>([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Escape",
  "Home",
  "PageDown",
  "PageUp",
  "Tab",
]);

export class LiveBrowserError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveBrowserError";
    this.code = code;
    this.status = status;
  }
}

interface LiveBrowserDeadlineHooks<T> {
  readonly onTimeout?: () => void | Promise<void>;
  readonly onLateResolve?: (value: T) => void | Promise<void>;
}

/**
 * Reject on wall-clock time even when a browser/driver promise never settles. Late successful
 * resources are handed to a cleanup hook instead of becoming orphan tabs.
 */
function withLiveBrowserDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  error: () => LiveBrowserError,
  hooks: LiveBrowserDeadlineHooks<T> = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      timedOut = true;
      try {
        const cleanup = hooks.onTimeout?.();
        if (cleanup) void Promise.resolve(cleanup).catch(() => undefined);
      } catch { /* deadline must still reject */ }
      reject(error());
    }, Math.max(1, timeoutMs));
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    operation.then((value) => {
      if (timedOut) {
        try {
          const cleanup = hooks.onLateResolve?.(value);
          if (cleanup) void Promise.resolve(cleanup).catch(() => undefined);
        } catch { /* late resources are already unreachable */ }
        return;
      }
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    }, (reason: unknown) => {
      if (timedOut || finished) return;
      finished = true;
      clearTimeout(timer);
      reject(reason);
    });
  });
}

export interface LiveBrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface LiveBrowserCapabilities {
  readonly available: boolean;
  readonly reason?: string;
  readonly features: readonly string[];
}

export interface LiveBrowserState {
  readonly schemaVersion: typeof LIVE_BROWSER_SCHEMA_VERSION;
  readonly browserSessionId: string;
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface LiveBrowserSnapshot {
  readonly state: LiveBrowserState;
  readonly png: Uint8Array;
}

export interface LiveBrowserOpenOptions {
  readonly browserSessionId: string;
  readonly url: string;
  readonly viewport: LiveBrowserViewport;
  readonly signal?: AbortSignal;
}

export interface LiveBrowserTabHandle {
  readonly browserSessionId: string;
  state(): LiveBrowserState;
  frame(): Uint8Array;
  navigate(url: string): Promise<LiveBrowserSnapshot>;
  back(): Promise<LiveBrowserSnapshot>;
  forward(): Promise<LiveBrowserSnapshot>;
  reload(): Promise<LiveBrowserSnapshot>;
  click(x: number, y: number, button?: MouseButton): Promise<LiveBrowserSnapshot>;
  scroll(deltaX: number, deltaY: number): Promise<LiveBrowserSnapshot>;
  typeText(text: string): Promise<LiveBrowserSnapshot>;
  pressKey(key: KeyInput): Promise<LiveBrowserSnapshot>;
  screenshot(): Promise<LiveBrowserSnapshot>;
  /** Extract bounded visible text from exactly the frame version the caller currently displays. */
  snapshotDocument(expected: { readonly seq: number; readonly url: string }): Promise<LiveBrowserRawDocument>;
  close(): Promise<void>;
}

export interface LiveBrowserProvider {
  capabilities(): LiveBrowserCapabilities;
  open(options: LiveBrowserOpenOptions): Promise<LiveBrowserTabHandle>;
  shutdown(): Promise<void>;
}

function blockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, "");
  return BLOCKED_HOSTS.has(name)
    || name.endsWith(".localhost")
    || name.endsWith(".local")
    || name.endsWith(".internal");
}

/** Reject Chromium internal/error documents before they can be serialized as a successful frame. */
export function assertLiveBrowserCommittedPage(urlValue: string, detail?: string): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    url = new URL("about:blank");
  }
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  const valid = /^https?:$/u.test(url.protocol)
    && !url.username
    && !url.password
    && (!url.port || ["80", "443"].includes(url.port))
    && Boolean(url.hostname)
    && !blockedHostname(url.hostname)
    && (isIP(literal) === 0 || publicResolvedAddress(literal));
  if (valid) return;
  const message = String(detail ?? "").trim() || "Chromium 未能提交可显示的公网网页";
  const timedOut = /timeout|timed out|超时/iu.test(message);
  throw new LiveBrowserError(
    timedOut ? "browser_navigation_timeout" : "browser_navigation_failed",
    message,
    timedOut ? 504 : 502,
  );
}

/** Parse, resolve and reject an URL if any answer is not a public address. */
export async function validatedLiveBrowserUrl(
  value: string,
  resolver: WebHostResolver = defaultWebHostResolver,
): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new LiveBrowserError("invalid_url", "请输入完整的 http(s) 网页地址", 422, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LiveBrowserError("blocked_scheme", "Live Browser 只允许 http(s) 公网地址", 403);
  }
  if (url.username || url.password) {
    throw new LiveBrowserError("blocked_credentials", "网页地址不能包含账号或密码", 403);
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new LiveBrowserError("blocked_port", "Live Browser 只允许标准 Web 端口 80/443", 403);
  }
  if (!url.hostname || blockedHostname(url.hostname)) {
    throw new LiveBrowserError("blocked_host", "Live Browser 已阻止本机、内网或 metadata 地址", 403);
  }
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(url.hostname);
  } catch (error) {
    throw new LiveBrowserError("dns_failed", `无法解析网页域名 ${url.hostname}`, 502, { cause: error });
  }
  if (addresses.length === 0) {
    throw new LiveBrowserError("dns_failed", `网页域名 ${url.hostname} 没有可用地址`, 502);
  }
  // Split-horizon/mixed DNS must fail closed. Picking only the public row would let a later lookup
  // choose the private answer and reintroduce SSRF.
  if (addresses.some((row) => !publicResolvedAddress(row.address))) {
    throw new LiveBrowserError("blocked_address", "Live Browser 已阻止本机、私网、保留网段或 metadata 地址", 403);
  }
  url.hash = "";
  return { url, addresses };
}

export interface LiveBrowserRequestPolicyInput {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly navigation: boolean;
  readonly topLevelUrl: string;
  readonly bodyBytes?: number;
}

export interface LiveBrowserNavigationProbe {
  readonly url: string;
  readonly readyState: string;
  readonly hasVisibleContent: boolean;
}

/**
 * Puppeteer can time out while a dynamic page keeps long-lived requests open even though Chromium
 * has already committed and painted a usable document.  Only that narrow case is a soft timeout;
 * blank/error documents and every non-timeout failure remain visible to the user.
 */
export function isSoftLiveBrowserNavigationTimeout(
  error: unknown,
  probe: LiveBrowserNavigationProbe,
): boolean {
  if (!(error instanceof Error) || error.name !== "TimeoutError") return false;
  let parsed: URL;
  try {
    parsed = new URL(probe.url);
  } catch {
    return false;
  }
  return /^https?:$/u.test(parsed.protocol)
    && ["interactive", "complete"].includes(probe.readyState)
    && probe.hasVisibleContent;
}

function boundedPostBodyBytes(
  headers: Readonly<Record<string, unknown>>,
  postData: string | undefined,
): number {
  const rawLength = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "content-length")?.[1];
  const declared = rawLength === undefined ? undefined : Number(rawLength);
  if (declared !== undefined && (!Number.isFinite(declared) || declared < 0)) {
    throw new LiveBrowserError("invalid_post_length", "匿名网页 POST 的 Content-Length 无效", 403);
  }
  // CDP may omit Blob/ArrayBuffer/streaming bodies. Missing both a decoded body and a trustworthy
  // Content-Length is unknown, not zero, and must fail closed.
  if (postData === undefined && declared === undefined) {
    throw new LiveBrowserError("unknown_post_length", "匿名网页 POST 的请求体大小无法核验", 403);
  }
  return Math.max(declared ?? 0, postData === undefined ? 0 : Buffer.byteLength(postData));
}

/**
 * Compatibility policy for a rendered page.
 *
 * Anonymous SPAs commonly use GraphQL POST, EventSource, dedicated workers and same-origin blob
 * modules merely to render public content. Those are allowed within tight limits. Navigational
 * POST, native form submission, credential UI and every non-public network connection remain
 * blocked. WebSocket stays disabled until it can be accounted per tab rather than only per tunnel.
 */
export async function validateLiveBrowserRequest(
  input: LiveBrowserRequestPolicyInput,
  resolver: WebHostResolver = defaultWebHostResolver,
): Promise<void> {
  const method = input.method.toUpperCase();
  if (input.resourceType === "websocket") {
    throw new LiveBrowserError("blocked_websocket", "Live Browser 匿名预览暂不启用 WebSocket", 403);
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch (error) {
    throw new LiveBrowserError("invalid_url", "网页请求地址无效", 422, { cause: error });
  }

  if (parsed.protocol === "data:") {
    if (input.navigation || method !== "GET" || input.url.length > LIVE_BROWSER_DATA_URL_MAX_CHARS) {
      throw new LiveBrowserError("blocked_local_resource", "已阻止过大或可导航的 data: 资源", 403);
    }
    return;
  }
  if (parsed.protocol === "blob:") {
    if (input.navigation || method !== "GET") {
      throw new LiveBrowserError("blocked_local_resource", "已阻止可导航的 blob: 资源", 403);
    }
    let creator: URL;
    let top: URL;
    try {
      creator = new URL(input.url.slice("blob:".length));
      top = new URL(input.topLevelUrl);
    } catch (error) {
      throw new LiveBrowserError("blocked_local_resource", "blob: 资源没有可核验的网页来源", 403, { cause: error });
    }
    if (!/^https?:$/u.test(creator.protocol) || creator.origin !== top.origin) {
      throw new LiveBrowserError("blocked_local_resource", "blob: 资源不属于当前公开网页", 403);
    }
    return;
  }

  if (SAFE_READ_METHODS.has(method)) {
    await validatedLiveBrowserUrl(input.url, resolver);
    return;
  }
  if (method === "POST" && !input.navigation && ["xhr", "fetch"].includes(input.resourceType)) {
    if (!Number.isFinite(input.bodyBytes) || (input.bodyBytes ?? 0) < 0
      || (input.bodyBytes ?? 0) > LIVE_BROWSER_POST_MAX_BYTES) {
      throw new LiveBrowserError(
        "post_too_large",
        `匿名网页 POST 超过 ${LIVE_BROWSER_POST_MAX_BYTES} 字节限制`,
        403,
      );
    }
    let top: URL;
    try {
      top = new URL(input.topLevelUrl);
    } catch (error) {
      throw new LiveBrowserError(
        "blocked_cross_origin_post",
        "匿名网页 POST 没有可核验的顶层网页来源",
        403,
        { cause: error },
      );
    }
    // CORS protects response reads, not the outbound side effect.  Keeping anonymous SPA POSTs
    // same-origin prevents a public page from turning the renderer into an arbitrary-site relay.
    if (!/^https?:$/u.test(top.protocol) || parsed.origin !== top.origin) {
      throw new LiveBrowserError(
        "blocked_cross_origin_post",
        "Live Browser 已阻止跨站匿名 POST；仅允许当前网页同源的渲染请求",
        403,
      );
    }
    await validatedLiveBrowserUrl(input.url, resolver);
    return;
  }
  throw new LiveBrowserError("blocked_method", `Live Browser 已阻止 ${method} 请求`, 403);
}

function proxyError(socket: Duplex, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\n` +
      "Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  }
}

function stripHopByHop(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if ([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ].includes(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

export interface LiveBrowserUpstreamProxy {
  /** Always a canonical loopback literal; never a remotely resolved host. */
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  /** Precomputed Basic header. It is never included in errors, logs or browser-visible state. */
  readonly authorization?: string;
}

export interface LiveBrowserProxyOptions {
  /** undefined = auto-discover, null = force direct, string = validate this endpoint. */
  readonly upstreamProxy?: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly readMacProxy?: () => string;
}

function loopbackProxyHost(hostname: string): "127.0.0.1" | "::1" | null {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (normalized === "::1") return "::1";
  if (normalized === "localhost" || normalized === "localhost.localdomain") return "127.0.0.1";
  if (isIP(normalized) === 4 && normalized.startsWith("127.")) return "127.0.0.1";
  return null;
}

/**
 * Only a loopback plain-HTTP proxy can become part of the trusted local egress boundary. Remote
 * corporate proxies and TLS proxy URLs are deliberately ignored: their DNS and certificate
 * semantics would weaken the pinning contract implemented below.
 */
export function parseLiveBrowserUpstreamProxy(value: string): LiveBrowserUpstreamProxy | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" || url.pathname !== "/" || url.search || url.hash) return null;
  const host = loopbackProxyHost(url.hostname);
  const port = Number(url.port || "80");
  if (host === null || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  let authorization: string | undefined;
  if (url.username || url.password) {
    try {
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (/[\r\n\u0000]/u.test(username) || /[\r\n\u0000]/u.test(password)) return null;
      authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
    } catch { return null; }
  }
  return { host, port, ...(authorization ? { authorization } : {}) };
}

function macProxyEndpoint(output: string): string | null {
  const rows = new Map<string, string>();
  for (const line of String(output).split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match) rows.set(match[1]!, match[2]!);
  }
  for (const prefix of ["HTTPS", "HTTP"] as const) {
    if (rows.get(`${prefix}Enable`) !== "1") continue;
    const host = rows.get(`${prefix}Proxy`) ?? "";
    const port = rows.get(`${prefix}Port`) ?? "";
    const parsed = parseLiveBrowserUpstreamProxy(`http://${host}:${port}`);
    if (parsed) return `http://${parsed.host === "::1" ? "[::1]" : parsed.host}:${parsed.port}`;
  }
  return null;
}

/** Resolve the trusted local egress proxy once when the Live Browser proxy starts. */
export function discoverLiveBrowserUpstreamProxy(
  options: Omit<LiveBrowserProxyOptions, "upstreamProxy"> = {},
): LiveBrowserUpstreamProxy | null {
  const env = options.env ?? process.env;
  const explicit = String(env["ONTOCOPILOT_BROWSER_UPSTREAM_PROXY"] ?? "").trim();
  if (explicit) {
    const parsed = parseLiveBrowserUpstreamProxy(explicit);
    if (!parsed) {
      throw new LiveBrowserError(
        "invalid_upstream_proxy",
        "ONTOCOPILOT_BROWSER_UPSTREAM_PROXY 必须是本机 loopback 的 http:// 代理地址",
        503,
      );
    }
    return parsed;
  }
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const) {
    const parsed = parseLiveBrowserUpstreamProxy(String(env[name] ?? ""));
    if (parsed) return parsed;
  }
  if ((options.platform ?? process.platform) !== "darwin") return null;
  let output = "";
  try {
    output = options.readMacProxy
      ? options.readMacProxy()
      : execFileSync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      });
  } catch { return null; }
  const endpoint = macProxyEndpoint(output);
  return endpoint ? parseLiveBrowserUpstreamProxy(endpoint) : null;
}

function pinnedAuthority(address: ResolvedAddress, port: number): string {
  return `${address.family === 6 ? `[${address.address}]` : address.address}:${port}`;
}

function originAuthority(url: URL, port: number): string {
  return `${url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname}:${port}`;
}

/** Local-only forward proxy that pins every destination before direct or trusted-proxy egress. */
export class SafeLiveBrowserProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private listenUrl = "";
  private readonly sockets = new Set<Duplex>();
  private readonly requests = new Set<ClientRequest>();
  private generation = 0;
  private upstream: LiveBrowserUpstreamProxy | null | undefined;

  constructor(
    private readonly resolver: WebHostResolver = defaultWebHostResolver,
    private readonly options: LiveBrowserProxyOptions = {},
  ) {}

  async start(): Promise<string> {
    if (this.server !== null) return this.listenUrl;
    if (this.upstream === undefined) {
      if (this.options.upstreamProxy === null) this.upstream = null;
      else if (this.options.upstreamProxy !== undefined) {
        this.upstream = parseLiveBrowserUpstreamProxy(this.options.upstreamProxy);
        if (!this.upstream) {
          throw new LiveBrowserError("invalid_upstream_proxy", "Live Browser 上游代理配置无效", 503);
        }
      } else this.upstream = discoverLiveBrowserUpstreamProxy(this.options);
    }
    const server = createServer((request, response) => {
      void this.forwardHttp(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(error instanceof LiveBrowserError ? error.status : 502);
        response.end(error instanceof Error ? error.message : "Live Browser proxy error");
      });
    });
    server.on("connect", (request, socket, head) => {
      void this.forwardConnect(request, socket, head).catch((error: unknown) => {
        const status = error instanceof LiveBrowserError ? error.status : 502;
        proxyError(socket, status, error instanceof Error ? error.message : "Live Browser proxy error");
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo | null;
    if (address === null) {
      server.close();
      throw new LiveBrowserError("proxy_unavailable", "无法启动 Live Browser 安全代理", 503);
    }
    this.server = server;
    this.listenUrl = `http://127.0.0.1:${address.port}`;
    return this.listenUrl;
  }

  private trackSocket(socket: ReturnType<typeof netConnect>): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(LIVE_BROWSER_PROXY_TIMEOUT_MS, () => socket.destroy());
  }

  /**
   * Open a byte stream to one already-validated IP. When a trusted local HTTP proxy is active,
   * CONNECT names the pinned IP while Host preserves the original authority for policy/audit. The
   * TLS ClientHello still comes from Chromium (or node:https for absolute HTTPS proxy requests),
   * so SNI and certificate validation remain bound to the original hostname.
   */
  private async connectPinned(
    target: { readonly url: URL; readonly addresses: readonly ResolvedAddress[] },
    port: number,
  ): Promise<ReturnType<typeof netConnect>> {
    const address = target.addresses[0];
    if (!address) throw new LiveBrowserError("dns_failed", "代理目标没有可用地址", 502);
    const proxy = this.upstream;
    const socket = proxy
      ? netConnect({ host: proxy.host, port: proxy.port })
      : netConnect({ host: address.address, port });
    this.trackSocket(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      if (!proxy) return socket;

      const headers = [
        `CONNECT ${pinnedAuthority(address, port)} HTTP/1.1`,
        `Host: ${originAuthority(target.url, port)}`,
        "Proxy-Connection: keep-alive",
        ...(proxy.authorization ? [`Proxy-Authorization: ${proxy.authorization}`] : []),
        "",
        "",
      ];
      socket.write(headers.join("\r\n"));
      await new Promise<void>((resolve, reject) => {
        let received = Buffer.alloc(0);
        const cleanup = (): void => {
          socket.off("data", onData);
          socket.off("error", onError);
          socket.off("end", onEnd);
        };
        const fail = (): void => {
          cleanup();
          reject(new LiveBrowserError(
            "upstream_proxy_failed",
            "Live Browser 本机上游代理未能建立公网连接",
            502,
          ));
        };
        const onError = (): void => fail();
        const onEnd = (): void => fail();
        const onData = (chunk: Buffer): void => {
          received = Buffer.concat([received, chunk]);
          if (received.byteLength > 16 * 1_024) { fail(); return; }
          const boundary = received.indexOf("\r\n\r\n");
          if (boundary < 0) return;
          const head = received.subarray(0, boundary).toString("latin1");
          const status = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/u.exec(head)?.[1] ?? "";
          if (!/^2\d\d$/u.test(status)) { fail(); return; }
          cleanup();
          const remainder = received.subarray(boundary + 4);
          if (remainder.byteLength > 0) socket.unshift(remainder);
          resolve();
        };
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("end", onEnd);
      });
      return socket;
    } catch (error) {
      socket.destroy();
      if (error instanceof LiveBrowserError) throw error;
      throw new LiveBrowserError(
        proxy ? "upstream_proxy_failed" : "proxy_connect_failed",
        proxy ? "Live Browser 无法连接本机上游代理" : "Live Browser 无法连接已验证的公网地址",
        502,
      );
    }
  }

  private async forwardConnect(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const generation = this.generation;
    const authority = String(request.url ?? "").trim();
    if (!authority) throw new LiveBrowserError("invalid_proxy_target", "缺少代理目标", 400);
    const target = await validatedLiveBrowserUrl(`https://${authority}`, this.resolver);
    if (generation !== this.generation || this.server === null || socket.destroyed) {
      throw new LiveBrowserError("proxy_closed", "Live Browser 安全代理已经关闭", 503);
    }
    const port = Number(target.url.port || "443");
    const upstream = await this.connectPinned(target, port);
    const lifetime = setTimeout(() => {
      upstream.destroy(new Error("Live Browser tunnel lifetime exceeded"));
      socket.destroy();
    }, LIVE_BROWSER_TUNNEL_MAX_LIFETIME_MS);
    lifetime.unref();
    upstream.once("close", () => clearTimeout(lifetime));
    socket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: OntoCopilot-LiveBrowser\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    // HTTPS is an intentionally blind TLS tunnel so certificate/SNI validation remains Chromium's
    // job. Count encrypted upstream bytes on the tunnel itself; this covers HTTP/2 multiplexed CSS,
    // JS, media and WebSocket attempts that the plain-HTTP response limiter cannot see.
    let tunnelBytes = 0;
    const accountTunnelBytes = (chunk: Buffer): void => {
      tunnelBytes += chunk.byteLength;
      if (tunnelBytes > LIVE_BROWSER_TUNNEL_MAX_BYTES) {
        this.sockets.delete(upstream);
        upstream.destroy(new Error("Live Browser tunnel exceeded byte limit"));
        socket.destroy();
      }
    };
    // Count both directions: encrypted downloads as well as a compromised worker trying to turn
    // the browser into an unbounded upload relay.
    upstream.on("data", accountTunnelBytes);
    socket.on("data", accountTunnelBytes);
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.once("close", () => { if (!socket.destroyed) socket.destroy(); });
    socket.once("close", () => { if (!upstream.destroyed) upstream.destroy(); });
  }

  private async forwardHttp(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const generation = this.generation;
    const method = String(request.method ?? "GET").toUpperCase();
    if (!PROXY_METHODS.has(method)) {
      throw new LiveBrowserError("blocked_method", `Live Browser 已阻止 ${method} 请求`, 403);
    }
    const declaredBodyBytes = Number(request.headers["content-length"] ?? "0");
    if (method === "POST" && (!Number.isFinite(declaredBodyBytes)
      || declaredBodyBytes < 0 || declaredBodyBytes > LIVE_BROWSER_POST_MAX_BYTES)) {
      throw new LiveBrowserError("post_too_large", "匿名网页 POST 超过字节限制", 413);
    }
    const target = await validatedLiveBrowserUrl(String(request.url ?? ""), this.resolver);
    if (generation !== this.generation || this.server === null || request.destroyed) {
      throw new LiveBrowserError("proxy_closed", "Live Browser 安全代理已经关闭", 503);
    }
    const address = target.addresses[0];
    if (!address) throw new LiveBrowserError("dns_failed", "代理目标没有可用地址", 502);
    const headers = stripHopByHop(request.headers);
    headers["host"] = target.url.host;
    // A CONNECT tunnel belongs to exactly one origin request. Never let node's global Agent pool
    // retain or cross-reuse it after the response finishes.
    headers["connection"] = "close";
    // This browser is anonymous by contract. No caller can smuggle credentials through the proxy.
    delete headers["authorization"];
    delete headers["proxy-authorization"];
    const port = Number(target.url.port || (target.url.protocol === "https:" ? "443" : "80"));
    const tunnel = await this.connectPinned(target, port);
    const applicationSocket = target.url.protocol === "https:"
      ? tlsConnect({ socket: tunnel, servername: target.url.hostname })
      : tunnel;
    if (applicationSocket !== tunnel) {
      this.sockets.add(applicationSocket);
      applicationSocket.once("close", () => this.sockets.delete(applicationSocket));
    }
    const requestAgent = target.url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: false })
      : new HttpAgent({ keepAlive: false });
    requestAgent.createConnection = () => applicationSocket;
    await new Promise<void>((resolve, reject) => {
      let upstream: ClientRequest;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        requestAgent.destroy();
        if (error) reject(error);
        else resolve();
      };
      try {
        upstream = (target.url.protocol === "https:" ? httpsRequest : httpRequest)({
          protocol: target.url.protocol,
          hostname: target.url.hostname,
          port,
          path: `${target.url.pathname}${target.url.search}`,
          method,
          headers,
          agent: requestAgent,
          servername: target.url.protocol === "https:" ? target.url.hostname : undefined,
          timeout: LIVE_BROWSER_PROXY_TIMEOUT_MS,
        }, (upstreamResponse) => {
        const responseHeaders = stripHopByHop(upstreamResponse.headers);
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        let bytes = 0;
        upstreamResponse.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > LIVE_BROWSER_RESPONSE_MAX_BYTES) {
            upstreamResponse.destroy(new Error("Live Browser resource exceeded byte limit"));
            response.destroy();
          }
        });
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => finish());
        upstreamResponse.once("error", finish);
        });
      } catch (error) {
        applicationSocket.destroy();
        throw error;
      }
      this.requests.add(upstream);
      upstream.once("close", () => this.requests.delete(upstream));
      request.once("aborted", () => upstream.destroy(new Error("Live Browser client aborted request")));
      response.once("close", () => {
        if (!response.writableEnded) upstream.destroy(new Error("Live Browser client closed response"));
      });
      let requestBytes = 0;
      request.on("data", (chunk: Buffer) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > LIVE_BROWSER_POST_MAX_BYTES) {
          upstream.destroy(new Error("Live Browser POST exceeded byte limit"));
          if (response.headersSent) response.destroy();
          else {
            response.writeHead(413);
            response.end("Live Browser POST exceeded byte limit");
          }
        }
      });
      upstream.once("timeout", () => upstream.destroy(new Error("Live Browser proxy timeout")));
      upstream.once("error", finish);
      request.pipe(upstream);
    });
  }

  async close(): Promise<void> {
    this.generation += 1;
    const server = this.server;
    this.server = null;
    this.listenUrl = "";
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const request of this.requests) request.destroy();
    this.requests.clear();
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function executable(path: string): boolean {
  try {
    return existsSync(path) && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

export function liveBrowserChromePath(): string | null {
  const configured = (process.env["ONTOCOPILOT_CHROME_PATH"] ?? "").trim();
  if (configured) return executable(configured) ? configured : null;
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    : process.platform === "win32"
      ? [
        `${process.env["PROGRAMFILES"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env["PROGRAMFILES(X86)"] ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(executable) ?? null;
}

function viewport(input: Partial<LiveBrowserViewport> | undefined): LiveBrowserViewport {
  const rawWidth = Number(input?.width ?? LIVE_BROWSER_DEFAULT_WIDTH);
  const rawHeight = Number(input?.height ?? LIVE_BROWSER_DEFAULT_HEIGHT);
  if (!Number.isInteger(rawWidth) || rawWidth < LIVE_BROWSER_MIN_WIDTH || rawWidth > LIVE_BROWSER_MAX_WIDTH
    || !Number.isInteger(rawHeight) || rawHeight < LIVE_BROWSER_MIN_HEIGHT || rawHeight > LIVE_BROWSER_MAX_HEIGHT) {
    throw new LiveBrowserError(
      "invalid_viewport",
      `viewport 必须在 ${LIVE_BROWSER_MIN_WIDTH}×${LIVE_BROWSER_MIN_HEIGHT} 到 ` +
        `${LIVE_BROWSER_MAX_WIDTH}×${LIVE_BROWSER_MAX_HEIGHT} 之间`,
      422,
    );
  }
  return { width: rawWidth, height: rawHeight };
}

class ChromiumTab implements LiveBrowserTabHandle {
  private png = new Uint8Array();
  private current: LiveBrowserState;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();
  private lastError = "";
  private readonly networkBudget = new LiveBrowserNavigationBudget();
  private readonly requestGenerations = new Map<string, number>();
  private readonly puppeteerRequestGenerations = new WeakMap<HTTPRequest, number>();
  private readonly workers = new Set<WebWorker>();

  constructor(
    readonly browserSessionId: string,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly resolver: WebHostResolver,
    private readonly viewportSize: LiveBrowserViewport,
  ) {
    this.current = {
      schemaVersion: LIVE_BROWSER_SCHEMA_VERSION,
      browserSessionId,
      url: "about:blank",
      title: "",
      width: viewportSize.width,
      height: viewportSize.height,
      seq: 0,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      updatedAt: new Date().toISOString(),
    };
  }

  async installSafety(): Promise<void> {
    await this.page.setBypassServiceWorker(true);
    await this.page.setCacheEnabled(false);
    await this.page.setRequestInterception(true);
    await this.cdp.send("Network.enable");
    await this.cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
    await this.cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
    await this.context.clearPermissionOverrides();
    await this.page.evaluateOnNewDocument(() => {
      const root = globalThis as unknown as Record<string, unknown>;
      const blocked = class {
        constructor() { throw new Error("Blocked by OntoCopilot Live Browser policy"); }
      };
      // WebSocket remains disabled until sockets can be budgeted per tab. Dedicated Worker and
      // EventSource stay available for public SPA rendering; worker fetches receive their own CDP
      // policy below.
      try { Object.defineProperty(root, "WebSocket", { configurable: false, value: blocked }); } catch { /* fail closed at CDP */ }
      try { Object.defineProperty(root, "SharedWorker", { configurable: false, value: blocked }); } catch { /* request gate remains */ }
      try { Object.defineProperty(root, "WebTransport", { configurable: false, value: blocked }); } catch { /* proxy remains */ }
      try { Object.defineProperty(root, "RTCPeerConnection", { configurable: false, value: blocked }); } catch { /* launch policy remains */ }
      try { Object.defineProperty(root, "webkitRTCPeerConnection", { configurable: false, value: blocked }); } catch { /* launch policy remains */ }
      try { Object.defineProperty(root, "PaymentRequest", { configurable: false, value: blocked }); } catch { /* permission policy remains */ }
      try { Object.defineProperty(root, "PublicKeyCredential", { configurable: false, value: blocked }); } catch { /* credentials guard remains */ }
      try { Object.defineProperty(root, "PasswordCredential", { configurable: false, value: blocked }); } catch { /* credentials guard remains */ }
      try { Object.defineProperty(root, "FederatedCredential", { configurable: false, value: blocked }); } catch { /* credentials guard remains */ }
      try { Object.defineProperty(root, "showOpenFilePicker", { configurable: false, value: blocked }); } catch { /* filechooser guard remains */ }
      try { Object.defineProperty(root, "showSaveFilePicker", { configurable: false, value: blocked }); } catch { /* download guard remains */ }
      try { Object.defineProperty(root, "showDirectoryPicker", { configurable: false, value: blocked }); } catch { /* filechooser guard remains */ }
      try { Object.defineProperty(root, "open", { configurable: false, value: () => null }); } catch { /* popup handler remains */ }
      const nav = root["navigator"] as Record<string, unknown> | undefined;
      if (nav) {
        try { Object.defineProperty(nav, "serviceWorker", { configurable: false, get: () => undefined }); } catch { /* bypass remains */ }
        try { Object.defineProperty(nav, "clipboard", { configurable: false, get: () => undefined }); } catch { /* permission deny remains */ }
        try { Object.defineProperty(nav, "credentials", { configurable: false, get: () => undefined }); } catch { /* login UI remains blocked */ }
      }
      const doc = root["document"] as {
        addEventListener?: (
          name: string,
          listener: (event: { preventDefault(): void; stopImmediatePropagation(): void }) => void,
          capture?: boolean,
        ) => void;
      } | undefined;
      const stopSubmission = (event: { preventDefault(): void; stopImmediatePropagation(): void }): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      doc?.addEventListener?.("submit", stopSubmission, true);
      doc?.addEventListener?.("auxclick", stopSubmission, true);
      const form = root["HTMLFormElement"] as { prototype?: Record<string, unknown> } | undefined;
      if (form?.prototype) {
        const blockedSubmit = (): never => { throw new Error("Form submission is disabled in Live Browser preview"); };
        try { Object.defineProperty(form.prototype, "submit", { configurable: false, value: blockedSubmit }); } catch { /* method gate remains */ }
        try { Object.defineProperty(form.prototype, "requestSubmit", { configurable: false, value: blockedSubmit }); } catch { /* method gate remains */ }
      }
    });
    this.cdp.on("Network.requestWillBeSent", (event) => {
      this.requestGenerations.set(event.requestId, this.networkBudget.generation);
    });
    this.cdp.on("Network.dataReceived", (event) => {
      const generation = this.requestGenerations.get(event.requestId);
      if (generation !== undefined) {
        this.accountReceivedBytes(Number(event.encodedDataLength || event.dataLength || 0), generation);
      }
    });
    const forgetRequest = (event: { requestId: string }): void => {
      this.requestGenerations.delete(event.requestId);
    };
    this.cdp.on("Network.loadingFinished", forgetRequest);
    this.cdp.on("Network.loadingFailed", forgetRequest);
    this.page.on("popup", (popup) => { if (popup !== null) void popup.close().catch(() => undefined); });
    this.page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => undefined); });
    this.page.on("filechooser", (chooser) => {
      const fileChooser = chooser as { accept(paths: string[]): Promise<void> };
      void fileChooser.accept([]).catch(() => undefined);
    });
    this.page.on("request", (request) => {
      const generation = this.networkBudget.generation;
      this.puppeteerRequestGenerations.set(request, generation);
      void this.authorizeRequest(request, generation);
    });
    this.page.on("workercreated", (worker) => {
      if (this.workers.size >= LIVE_BROWSER_TAB_MAX_WORKERS) {
        this.lastError = `Live Browser 页面超过 ${LIVE_BROWSER_TAB_MAX_WORKERS} 个 Worker，已停止额外 Worker`;
        void worker.close().catch(() => undefined);
        return;
      }
      this.workers.add(worker);
      void this.installWorkerSafety(worker);
    });
    this.page.on("workerdestroyed", (worker) => { this.workers.delete(worker); });
    this.page.on("requestfailed", (request) => {
      if (this.puppeteerRequestGenerations.get(request) === this.networkBudget.generation
        && request.isNavigationRequest() && !this.lastError) {
        this.lastError = request.failure()?.errorText ?? "网页导航失败";
      }
    });
  }

  private exhaustBudget(message: string): void {
    if (!this.networkBudget.exceeded) this.lastError = message;
    this.networkBudget.exhaust();
    void this.cdp.send("Page.stopLoading").catch(() => undefined);
  }

  /** Shared across the page target and every dedicated-worker target in this tab. */
  private accountRequest(generation = this.networkBudget.generation): boolean {
    const result = this.networkBudget.accountRequest(generation);
    if (result === "stale") return false;
    if (result === "allowed") return true;
    this.exhaustBudget(`Live Browser 页面超过 ${LIVE_BROWSER_TAB_MAX_REQUESTS} 个网络请求，已停止加载`);
    return false;
  }

  /** Shared across the page target and every dedicated-worker target in this tab. */
  private accountReceivedBytes(value: number, generation = this.networkBudget.generation): boolean {
    const result = this.networkBudget.accountBytes(value, generation);
    if (result === "stale" || result === "allowed") return true;
    this.exhaustBudget("Live Browser 页面超过网络字节配额，已停止加载");
    return false;
  }

  private async authorizeRequest(request: HTTPRequest, generation: number): Promise<void> {
    try {
      if (!this.accountRequest(generation)) {
        await request.abort("blockedbyclient");
        return;
      }
      const method = request.method().toUpperCase();
      const headers = request.headers();
      if (headers["authorization"] || headers["proxy-authorization"]) {
        throw new LiveBrowserError("blocked_credentials", "匿名 Live Browser 不发送 Authorization", 403);
      }
      const postData = method === "POST"
        ? await request.fetchPostData().catch(() => request.postData())
        : undefined;
      const bodyBytes = method === "POST" ? boundedPostBodyBytes(headers, postData) : undefined;
      await validateLiveBrowserRequest({
        url: request.url(),
        method,
        resourceType: request.resourceType(),
        navigation: request.isNavigationRequest(),
        topLevelUrl: this.page.url(),
        ...(bodyBytes !== undefined ? { bodyBytes } : {}),
      }, this.resolver);
      if (generation !== this.networkBudget.generation) {
        await request.abort("blockedbyclient");
        return;
      }
      await request.continue();
    } catch (error) {
      if (request.isNavigationRequest()) {
        this.lastError = error instanceof Error ? error.message : "已阻止不安全的网页导航";
      }
      await request.abort("blockedbyclient").catch(() => undefined);
    }
  }

  private async installWorkerSafety(worker: WebWorker): Promise<void> {
    const client = worker.client;
    const workerGeneration = this.networkBudget.generation;
    try {
      await client.send("Network.enable");
      await client.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
      await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      client.on("Network.dataReceived", (event) => {
        if (!this.accountReceivedBytes(
          Number(event.encodedDataLength || event.dataLength || 0),
          workerGeneration,
        )) {
          void worker.close().catch(() => undefined);
        }
      });
      client.on("Fetch.requestPaused", (event) => {
        void (async () => {
          try {
            if (!this.accountRequest(workerGeneration)) {
              throw new LiveBrowserError("request_budget_exceeded", "Worker 网络请求超过页面共享配额", 403);
            }
            const method = String(event.request.method ?? "GET").toUpperCase();
            const headers = event.request.headers ?? {};
            if (Object.keys(headers).some((name) => ["authorization", "proxy-authorization"].includes(name.toLowerCase()))) {
              throw new LiveBrowserError("blocked_credentials", "匿名 Worker 不发送 Authorization", 403);
            }
            await validateLiveBrowserRequest({
              url: event.request.url,
              method,
              resourceType: String(event.resourceType ?? "fetch").toLowerCase(),
              navigation: false,
              topLevelUrl: this.page.url(),
              ...(method === "POST" ? {
                bodyBytes: boundedPostBodyBytes(
                  headers,
                  typeof event.request.postData === "string" ? event.request.postData : undefined,
                ),
              } : {}),
            }, this.resolver);
            if (workerGeneration !== this.networkBudget.generation) {
              throw new LiveBrowserError("stale_navigation", "Worker 属于已结束的网页导航", 409);
            }
            await client.send("Fetch.continueRequest", { requestId: event.requestId });
          } catch {
            await client.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            }).catch(() => undefined);
          }
        })();
      });
      await worker.evaluate(() => {
        const root = globalThis as unknown as Record<string, unknown>;
        const blocked = class {
          constructor() { throw new Error("Blocked by OntoCopilot Live Browser policy"); }
        };
        for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "Worker", "SharedWorker"]) {
          try { Object.defineProperty(root, name, { configurable: false, value: blocked }); } catch { /* CDP/proxy remain */ }
        }
      });
    } catch (error) {
      this.lastError = error instanceof Error ? `Worker 安全策略失败：${error.message}` : "Worker 安全策略失败";
      await worker.close().catch(() => undefined);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new LiveBrowserError("browser_closed", "Live Browser 页面已经关闭", 410);
  }

  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    this.assertOpen();
    let release = (): void => undefined;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.assertOpen();
      return await body();
    } finally {
      release();
    }
  }

  private async settleBriefly(): Promise<void> {
    await this.page.waitForNetworkIdle({ idleTime: 250, timeout: 1_500 }).catch(() => undefined);
  }

  /** Stop the old document before assigning a fresh request/byte budget to the next top-level page. */
  private async beginNavigation(): Promise<void> {
    await this.cdp.send("Page.stopLoading").catch(() => undefined);
    this.networkBudget.begin();
    this.requestGenerations.clear();
    const staleWorkers = [...this.workers];
    this.workers.clear();
    await Promise.all(staleWorkers.map((worker) => worker.close().catch(() => undefined)));
  }

  private async captureUnbounded(loading = false): Promise<LiveBrowserSnapshot> {
    assertLiveBrowserCommittedPage(this.page.url(), this.lastError);
    const [title, history] = await Promise.all([
      this.page.title().catch(() => ""),
      this.cdp.send("Page.getNavigationHistory").catch(() => ({ currentIndex: 0, entries: [] })),
    ]);
    const bytes = await this.page.screenshot({ type: "png", encoding: "binary", optimizeForSpeed: true });
    this.assertOpen();
    const committedUrl = this.page.url();
    assertLiveBrowserCommittedPage(committedUrl, this.lastError);
    this.png = new Uint8Array(bytes);
    const currentIndex = Number(history.currentIndex ?? 0);
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const safeHistoryEntry = (entry: unknown): boolean => {
      const value = entry !== null && typeof entry === "object" && "url" in entry
        ? String((entry as { url?: unknown }).url ?? "")
        : "";
      return value.startsWith("http://") || value.startsWith("https://");
    };
    const error = this.lastError.trim();
    this.current = {
      schemaVersion: LIVE_BROWSER_SCHEMA_VERSION,
      browserSessionId: this.browserSessionId,
      url: committedUrl,
      title,
      width: this.viewportSize.width,
      height: this.viewportSize.height,
      seq: this.current.seq + 1,
      canGoBack: entries.slice(0, Math.max(0, currentIndex)).some(safeHistoryEntry),
      canGoForward: entries.slice(currentIndex + 1).some(safeHistoryEntry),
      loading,
      ...(error ? { error } : {}),
      updatedAt: new Date().toISOString(),
    };
    return { state: this.current, png: this.png };
  }

  private async capture(loading = false): Promise<LiveBrowserSnapshot> {
    return await withLiveBrowserDeadline(
      this.captureUnbounded(loading),
      LIVE_BROWSER_CAPTURE_TIMEOUT_MS,
      () => new LiveBrowserError(
        "browser_capture_timeout",
        `Chromium 画面生成超过 ${Math.round(LIVE_BROWSER_CAPTURE_TIMEOUT_MS / 1_000)} 秒，已关闭该隔离页面，请重试`,
        504,
      ),
      { onTimeout: () => this.close() },
    );
  }

  private async navigationTimeoutIsSoft(error: unknown): Promise<boolean> {
    if (!(error instanceof Error) || error.name !== "TimeoutError") return false;
    const probe = await Promise.race([
      this.page.evaluate(() => ({
        readyState: document.readyState,
        hasVisibleContent: Boolean(
          document.title.trim()
          || document.body?.innerText?.trim(),
        ),
      })).catch(() => null),
      new Promise<null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 750);
        timeout.unref();
      }),
    ]);
    return probe !== null && isSoftLiveBrowserNavigationTimeout(error, {
      url: this.page.url(),
      readyState: probe.readyState,
      hasVisibleContent: probe.hasVisibleContent,
    });
  }

  private async nav(action: () => Promise<unknown>): Promise<LiveBrowserSnapshot> {
    return await this.exclusive(async () => {
      await this.beginNavigation();
      this.lastError = "";
      try {
        await action();
      } catch (error) {
        if (await this.navigationTimeoutIsSoft(error)) this.lastError = "";
        else this.lastError = error instanceof Error ? error.message : "网页导航失败";
      }
      assertLiveBrowserCommittedPage(this.page.url(), this.lastError);
      await this.settleBriefly();
      return await this.capture(false);
    });
  }

  state(): LiveBrowserState {
    this.assertOpen();
    return this.current;
  }

  frame(): Uint8Array {
    this.assertOpen();
    return this.png.slice();
  }

  async navigate(value: string): Promise<LiveBrowserSnapshot> {
    const { url } = await validatedLiveBrowserUrl(value, this.resolver);
    return await this.nav(() => this.page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: LIVE_BROWSER_NAVIGATION_TIMEOUT_MS,
    }));
  }

  async back(): Promise<LiveBrowserSnapshot> {
    if (!this.current.canGoBack) throw new LiveBrowserError("no_history", "没有可返回的 Live Browser 历史页面", 409);
    return await this.nav(() => this.page.goBack({ waitUntil: "domcontentloaded", timeout: LIVE_BROWSER_NAVIGATION_TIMEOUT_MS }));
  }

  async forward(): Promise<LiveBrowserSnapshot> {
    if (!this.current.canGoForward) throw new LiveBrowserError("no_history", "没有可前进的 Live Browser 历史页面", 409);
    return await this.nav(() => this.page.goForward({ waitUntil: "domcontentloaded", timeout: LIVE_BROWSER_NAVIGATION_TIMEOUT_MS }));
  }

  async reload(): Promise<LiveBrowserSnapshot> {
    return await this.nav(() => this.page.reload({ waitUntil: "domcontentloaded", timeout: LIVE_BROWSER_NAVIGATION_TIMEOUT_MS }));
  }

  async click(x: number, y: number, button: MouseButton = "left"): Promise<LiveBrowserSnapshot> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
      || x > this.viewportSize.width || y > this.viewportSize.height) {
      throw new LiveBrowserError("invalid_pointer", "点击坐标超出 Live Browser 画面", 422);
    }
    if (!["left", "middle", "right"].includes(button)) {
      throw new LiveBrowserError("invalid_pointer", "不支持这个鼠标按钮", 422);
    }
    return await this.exclusive(async () => {
      this.lastError = "";
      const isSubmit = await this.page.evaluate((point) => {
        const node = document.elementFromPoint(point.x, point.y);
        type ClosestNode = { closest?: (selector: string) => ClosestNode | null };
        const candidate = node as unknown as ClosestNode | null;
        if (typeof candidate?.closest !== "function") return false;
        if (candidate.closest("button[type=submit], input[type=submit], input[type=image]") !== null) return true;
        // A button without type is submit only when it belongs to a form. Outside a form it is
        // commonly a menu/accordion control and must remain usable in an actual browser preview.
        const implicit = candidate.closest("button:not([type]), button[type='']");
        return implicit !== null && typeof implicit.closest === "function" && implicit.closest("form") !== null;
      }, { x, y }).catch(() => false);
      if (isSubmit) {
        throw new LiveBrowserError("blocked_submit", "Live Browser 预览模式禁止提交表单", 403);
      }
      let navigates = false;
      if (button === "left") {
        // A browser workbench has one controlled tab per resource. Safe target=_blank anchors
        // therefore navigate that tab instead of opening an untracked popup; the resulting request
        // still passes the existing URL/DNS/proxy gates. window.open remains blocked.
        navigates = await this.page.evaluate((point) => {
          type AnchorLike = {
            closest?: (selector: string) => AnchorLike | null;
            href?: string;
            target?: string;
            hasAttribute?: (name: string) => boolean;
          };
          const candidate = document.elementFromPoint(point.x, point.y) as unknown as AnchorLike | null;
          const anchor = candidate?.closest?.("a[href]");
          if (!anchor || anchor.hasAttribute?.("download")) return false;
          try {
            const url = new URL(String(anchor.href ?? ""));
            const safe = (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
            if (safe && String(anchor.target ?? "").toLowerCase() === "_blank") {
              anchor.target = "_self";
            }
            return safe;
          } catch { /* leave malformed/unsafe links under the popup-deny policy */ }
          return false;
        }, { x, y }).catch(() => false);
      }
      if (navigates) await this.beginNavigation();
      await this.page.mouse.click(x, y, { button });
      await this.settleBriefly();
      return await this.capture(false);
    });
  }

  async scroll(deltaX: number, deltaY: number): Promise<LiveBrowserSnapshot> {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)
      || Math.abs(deltaX) > 10_000 || Math.abs(deltaY) > 10_000) {
      throw new LiveBrowserError("invalid_scroll", "滚动距离必须在 ±10000 像素内", 422);
    }
    return await this.exclusive(async () => {
      this.lastError = "";
      await this.page.mouse.wheel({ deltaX, deltaY });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await this.capture(false);
    });
  }

  private async editableTarget(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const node = document.activeElement as unknown as {
        disabled?: boolean;
        getAttribute?: (name: string) => string | null;
        isContentEditable?: boolean;
        readOnly?: boolean;
        tagName?: string;
        type?: string;
      } | null;
      if (!node || node.getAttribute?.("aria-disabled") === "true") return false;
      if (node.isContentEditable) return true;
      const tag = String(node.tagName ?? "").toUpperCase();
      if (tag === "TEXTAREA") return !node.disabled && !node.readOnly;
      if (tag !== "INPUT" || node.disabled || node.readOnly) return false;
      const kind = String(node.type ?? "text").toLowerCase();
      return ["text", "search", "email", "url", "tel", "number"].includes(kind);
    }).catch(() => false);
  }

  async typeText(value: string): Promise<LiveBrowserSnapshot> {
    const text = String(value);
    if (!text || [...text].length > 2_000 || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(text)) {
      throw new LiveBrowserError("invalid_text", "输入文本不能为空、不能含控制字符，且最多 2000 字符", 422);
    }
    return await this.exclusive(async () => {
      if (!await this.editableTarget()) {
        throw new LiveBrowserError("not_editable", "请先点击普通文本输入框；密码与提交控件不可输入", 409);
      }
      this.lastError = "";
      await this.page.keyboard.type(text, { delay: 4 });
      return await this.capture(false);
    });
  }

  async pressKey(key: KeyInput): Promise<LiveBrowserSnapshot> {
    if (!SAFE_KEY_INPUTS.has(key)) {
      throw new LiveBrowserError("blocked_key", "Live Browser 预览模式禁止 Enter、快捷键与提交按键", 403);
    }
    return await this.exclusive(async () => {
      if (["Backspace", "Delete"].includes(key) && !await this.editableTarget()) {
        throw new LiveBrowserError("not_editable", "当前焦点不是可编辑文本框", 409);
      }
      this.lastError = "";
      await this.page.keyboard.press(key);
      return await this.capture(false);
    });
  }

  async screenshot(): Promise<LiveBrowserSnapshot> {
    return await this.exclusive(() => this.capture(false));
  }

  async snapshotDocument(
    expected: { readonly seq: number; readonly url: string },
  ): Promise<LiveBrowserRawDocument> {
    return await this.exclusive(async () => {
      const before = this.current;
      if (!Number.isSafeInteger(expected.seq) || expected.seq < 1
        || before.seq !== expected.seq || before.url !== expected.url
        || this.page.url() !== expected.url) {
        throw new LiveBrowserError(
          "stale_frame",
          "网页已经变化，请等待当前画面刷新后再总结",
          409,
        );
      }
      if (before.loading) {
        throw new LiveBrowserError("page_loading", "网页仍在加载，请稍后再总结", 409);
      }
      const extracted = await this.page.evaluate((limits) => {
        type ElementLike = {
          closest(selector: string): ElementLike | null;
          getBoundingClientRect(): { width: number; height: number; top: number };
          innerText?: string;
        };
        const root = globalThis as unknown as {
          document: {
            body?: { innerText?: string };
            querySelectorAll(selector: string): Iterable<ElementLike>;
            title?: string;
          };
          getComputedStyle(node: ElementLike): {
            display?: string;
            visibility?: string;
            opacity?: string;
          };
          location: { href: string };
          scrollY?: number;
        };
        const normalize = (value: unknown, max: number): string => {
          const compact = String(value ?? "")
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
            .replace(/[\t\r ]+/gu, " ")
            .replace(/ *\n+ */gu, "\n")
            .trim();
          return [...compact].slice(0, max).join("");
        };
        const rows: Array<{ text: string; ordinal: number; y?: number }> = [];
        const seen = new Set<string>();
        let used = 0;
        const add = (value: unknown, ordinal: number, y?: number): void => {
          if (rows.length >= limits.maxParagraphs || used >= limits.maxTextChars) return;
          let text = normalize(value, limits.maxParagraphChars);
          if (!text || seen.has(text)) return;
          const remaining = limits.maxTextChars - used;
          if ([...text].length > remaining) text = [...text].slice(0, remaining).join("");
          if (!text) return;
          seen.add(text);
          rows.push({ text, ordinal, ...(Number.isFinite(y) ? { y: Math.max(0, Math.round(y ?? 0)) } : {}) });
          used += [...text].length;
        };
        const excluded = "script,style,noscript,template,svg,canvas,nav,header,footer,aside,form,dialog,[aria-hidden='true']";
        const selectors = "main h1,main h2,main h3,main h4,main h5,main h6,main p,main li,main blockquote,main pre,main dt,main dd,main td,main th," +
          "article h1,article h2,article h3,article h4,article h5,article h6,article p,article li,article blockquote,article pre,article dt,article dd,article td,article th," +
          "[role='main'] h1,[role='main'] h2,[role='main'] h3,[role='main'] p,[role='main'] li," +
          "body>h1,body>h2,body>h3,body>p";
        let ordinal = 0;
        for (const node of root.document.querySelectorAll(selectors)) {
          const currentOrdinal = ordinal++;
          if (node.closest(excluded)) continue;
          const style = root.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden"
            || Number(style.opacity ?? "1") === 0 || rect.width <= 0 || rect.height <= 0) continue;
          add(node.innerText, currentOrdinal, rect.top + Number(root.scrollY ?? 0));
        }
        // Client-rendered applications often use only div/span.  innerText has already applied
        // layout visibility; the server still normalizes, deduplicates and caps every line again.
        if (rows.length < 2) {
          for (const line of String(root.document.body?.innerText ?? "").split(/\n+/u)) {
            add(line, ordinal++);
            if (rows.length >= limits.maxParagraphs || used >= limits.maxTextChars) break;
          }
        }
        return {
          url: root.location.href,
          title: normalize(root.document.title, limits.maxTitleChars),
          paragraphs: rows,
        };
      }, {
        maxParagraphs: LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS,
        maxParagraphChars: LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPH_CHARS,
        maxTextChars: LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
        maxTitleChars: 240,
      });
      if (this.current.seq !== before.seq || this.current.url !== before.url
        || this.page.url() !== before.url || extracted.url !== before.url) {
        throw new LiveBrowserError(
          "stale_frame",
          "正文提取期间网页发生变化，请等待当前画面刷新后再总结",
          409,
        );
      }
      return {
        schemaVersion: LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION,
        browserSessionId: this.browserSessionId,
        seq: before.seq,
        url: extracted.url,
        title: extracted.title,
        paragraphs: extracted.paragraphs,
        capturedAt: new Date().toISOString(),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

export class ChromiumLiveBrowserProvider implements LiveBrowserProvider {
  private readonly proxy: SafeLiveBrowserProxy;
  private browser: Browser | null = null;
  private starting: Promise<Browser> | null = null;
  private readonly openingContexts = new Set<BrowserContext>();
  private generation = 0;

  constructor(private readonly resolver: WebHostResolver = defaultWebHostResolver) {
    this.proxy = new SafeLiveBrowserProxy(resolver);
  }

  capabilities(): LiveBrowserCapabilities {
    const chrome = liveBrowserChromePath();
    return chrome
      ? {
        available: true,
        features: [
          "navigate", "back", "forward", "reload", "screenshot", "dom-snapshot", "click", "scroll", "type",
          "dedicated-worker", "event-source", "anonymous-graphql-post",
        ],
      }
      : {
        available: false,
        reason: process.env["ONTOCOPILOT_CHROME_PATH"]
          ? "ONTOCOPILOT_CHROME_PATH 指向的浏览器不可执行"
          : "服务器没有找到 Google Chrome、Chromium 或 Microsoft Edge",
        features: [],
      };
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.starting !== null) return await this.starting;
    const generation = this.generation;
    this.starting = (async () => {
      const path = liveBrowserChromePath();
      if (!path) throw new LiveBrowserError("browser_unavailable", this.capabilities().reason ?? "Live Browser 不可用", 503);
      const proxyUrl = await this.proxy.start();
      const browser = await puppeteer.launch({
        executablePath: path,
        headless: true,
        args: [
          `--proxy-server=${proxyUrl}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-background-networking",
          "--disable-breakpad",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--disable-features=AutofillServerCommunication,FedCm,MediaRouter,OptimizationHints,Translate,WebPayments",
          "--disable-geolocation",
          "--disable-notifications",
          "--disable-quic",
          "--disable-sync",
          "--deny-permission-prompts",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--metrics-recording-only",
          "--no-default-browser-check",
          "--no-first-run",
          "--renderer-process-limit=8",
          "--js-flags=--max-old-space-size=256",
        ],
      });
      browser.once("disconnected", () => {
        if (this.browser === browser) this.browser = null;
      });
      if (generation !== this.generation) {
        await browser.close().catch(() => undefined);
        throw new LiveBrowserError("browser_shutdown", "Live Browser 正在关闭，请稍后重试", 503);
      }
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.starting;
    } catch (error) {
      await this.proxy.close();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async open(options: LiveBrowserOpenOptions): Promise<LiveBrowserTabHandle> {
    const controller = new AbortController();
    let context: BrowserContext | null = null;
    let transferred = false;
    const assertNotCancelled = (): void => {
      if (controller.signal.aborted) {
        throw new LiveBrowserError("browser_open_cancelled", "Live Browser 页面创建已取消", 409);
      }
    };
    const closeOpeningContext = (): void => {
      if (context !== null) void context.close().catch(() => undefined);
    };
    const callerAbort = (): void => {
      controller.abort(options.signal?.reason);
      closeOpeningContext();
    };
    if (options.signal?.aborted) callerAbort();
    else options.signal?.addEventListener("abort", callerAbort, { once: true });
    const operation = (async (): Promise<LiveBrowserTabHandle> => {
      try {
        assertNotCancelled();
        const target = await validatedLiveBrowserUrl(options.url, this.resolver);
        assertNotCancelled();
        const browser = await this.ensureBrowser();
        assertNotCancelled();
        context = await browser.createBrowserContext();
        this.openingContexts.add(context);
        assertNotCancelled();
        const page = await context.newPage();
        assertNotCancelled();
        await page.setViewport({ width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: 1 });
        const cdp = await page.createCDPSession();
        const tab = new ChromiumTab(
          options.browserSessionId,
          context,
          page,
          cdp,
          this.resolver,
          options.viewport,
        );
        await tab.installSafety();
        await tab.navigate(target.url.toString());
        assertNotCancelled();
        assertLiveBrowserCommittedPage(tab.state().url, tab.state().error);
        transferred = true;
        this.openingContexts.delete(context);
        return tab;
      } catch (error) {
        closeOpeningContext();
        throw error;
      } finally {
        if (!transferred && context !== null) this.openingContexts.delete(context);
      }
    })();
    try {
      return await withLiveBrowserDeadline(
        operation,
        LIVE_BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
        () => new LiveBrowserError(
          "browser_open_timeout",
          `隔离浏览器在 ${Math.round(LIVE_BROWSER_PROVIDER_OPEN_TIMEOUT_MS / 1_000)} 秒内未能打开网页，请重试`,
          504,
        ),
        {
          onTimeout: () => {
            controller.abort(new Error("Live Browser provider open deadline exceeded"));
            closeOpeningContext();
          },
          onLateResolve: (tab) => tab.close(),
        },
      );
    } finally {
      options.signal?.removeEventListener("abort", callerAbort);
    }
  }

  private async closeBrowserBounded(browser: Browser): Promise<void> {
    let child: ReturnType<Browser["process"]> = null;
    try { child = browser.process(); } catch { /* browser may already be disconnected */ }
    let closing: Promise<void>;
    try { closing = browser.close(); } catch { closing = Promise.resolve(); }
    await withLiveBrowserDeadline(
      closing,
      LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS,
      () => new LiveBrowserError("browser_shutdown_timeout", "隔离 Chromium 关闭超时", 504),
      {
        onTimeout: () => {
          try { child?.kill("SIGKILL"); } catch { /* process already exited */ }
        },
      },
    ).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.generation += 1;
    const starting = this.starting;
    const browser = this.browser;
    this.browser = null;
    for (const context of this.openingContexts) void context.close().catch(() => undefined);
    this.openingContexts.clear();
    const proxyClosing = withLiveBrowserDeadline(
      this.proxy.close(),
      LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS,
      () => new LiveBrowserError("proxy_shutdown_timeout", "Live Browser 安全代理关闭超时", 504),
    ).catch(() => undefined);
    const browserClosing = browser === null ? Promise.resolve() : this.closeBrowserBounded(browser);
    const startingClosing = starting === null
      ? Promise.resolve()
      : withLiveBrowserDeadline(
        starting,
        LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS,
        () => new LiveBrowserError("browser_launch_shutdown_timeout", "Chromium 启动任务未能及时结束", 504),
        { onLateResolve: (lateBrowser) => this.closeBrowserBounded(lateBrowser) },
      ).then(async (launched) => {
        if (launched !== browser) await this.closeBrowserBounded(launched);
      }).catch(() => undefined);
    await Promise.all([proxyClosing, browserClosing, startingClosing]);
  }
}

interface RuntimeEntry {
  readonly sessionId: string;
  readonly tab: LiveBrowserTabHandle;
  lastUsed: number;
}

export interface LiveBrowserRuntimeOptions {
  readonly provider?: LiveBrowserProvider;
  readonly now?: () => number;
  readonly idleTtlMs?: number;
  readonly maxTabs?: number;
  readonly maxGlobalTabs?: number;
  readonly providerOpenTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  readonly navigationActionTimeoutMs?: number;
  readonly startReaper?: boolean;
}

export interface LiveBrowserActionOptions {
  readonly kind?: "interaction" | "navigation";
}

/** Session-scoped registry, serialization owner and TTL cleanup boundary. */
export class LiveBrowserRuntime {
  private readonly provider: LiveBrowserProvider;
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly maxTabs: number;
  private readonly maxGlobalTabs: number;
  private readonly providerOpenTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly navigationActionTimeoutMs: number;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly reservations = new Map<string, number>();
  private globalReservations = 0;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private readonly reaperEnabled: boolean;
  private generation = 0;
  private readonly sessionGenerations = new Map<string, number>();
  private readonly closedSessions = new Set<string>();
  private readonly pendingOpens = new Map<Promise<void>, {
    readonly sessionId: string;
    readonly abort: () => void;
  }>();
  private shuttingDown = false;

  constructor(options: LiveBrowserRuntimeOptions = {}) {
    this.provider = options.provider ?? new ChromiumLiveBrowserProvider();
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? LIVE_BROWSER_IDLE_TTL_MS;
    this.maxTabs = options.maxTabs ?? LIVE_BROWSER_MAX_TABS;
    this.maxGlobalTabs = options.maxGlobalTabs ?? LIVE_BROWSER_MAX_GLOBAL_TABS;
    this.providerOpenTimeoutMs = options.providerOpenTimeoutMs ?? LIVE_BROWSER_RUNTIME_OPEN_TIMEOUT_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? LIVE_BROWSER_ACTION_TIMEOUT_MS;
    this.navigationActionTimeoutMs = options.navigationActionTimeoutMs
      ?? LIVE_BROWSER_NAVIGATION_ACTION_TIMEOUT_MS;
    this.reaperEnabled = options.startReaper !== false;
    this.ensureReaper();
  }

  private ensureReaper(): void {
    if (!this.reaperEnabled || this.reaper !== null) return;
    this.reaper = setInterval(() => { void this.closeExpired(); }, Math.min(60_000, this.idleTtlMs));
    this.reaper.unref();
  }

  capabilities(): LiveBrowserCapabilities {
    return this.provider.capabilities();
  }

  private key(sessionId: string, browserSessionId: string): string {
    return `${sessionId}\u0000${browserSessionId}`;
  }

  private entry(sessionId: string, browserSessionId: string): RuntimeEntry {
    const entry = this.entries.get(this.key(sessionId, browserSessionId));
    if (!entry) throw new LiveBrowserError("browser_not_found", "没有这个 Live Browser 页面", 404);
    entry.lastUsed = this.now();
    return entry;
  }

  async open(
    sessionId: string,
    url: string,
    inputViewport?: Partial<LiveBrowserViewport>,
  ): Promise<LiveBrowserSnapshot> {
    if (this.shuttingDown) throw new LiveBrowserError("browser_shutdown", "Live Browser 正在关闭，请稍后重试", 503);
    if (this.closedSessions.has(sessionId)) {
      throw new LiveBrowserError("browser_cancelled", "会话已经关闭，不能再打开 Live Browser 页面", 409);
    }
    this.ensureReaper();
    const activeForSession = [...this.entries.values()].filter((entry) => entry.sessionId === sessionId).length;
    const reservedForSession = this.reservations.get(sessionId) ?? 0;
    if (activeForSession + reservedForSession >= this.maxTabs) {
      throw new LiveBrowserError("too_many_tabs", `每个会话最多打开 ${this.maxTabs} 个 Live Browser 页面`, 409);
    }
    if (this.entries.size + this.globalReservations >= this.maxGlobalTabs) {
      throw new LiveBrowserError("browser_capacity", "Live Browser 运行时已达到全局页面上限", 503);
    }
    this.reservations.set(sessionId, reservedForSession + 1);
    this.globalReservations += 1;
    const generation = this.generation;
    const sessionGeneration = this.sessionGenerations.get(sessionId) ?? 0;
    let finishPending = (): void => undefined;
    const pending = new Promise<void>((resolve) => { finishPending = resolve; });
    const openController = new AbortController();
    this.pendingOpens.set(pending, { sessionId, abort: () => openController.abort() });
    try {
      const browserSessionId = `browser_${randomUUID().replace(/-/gu, "").slice(0, 24)}`;
      const tab = await withLiveBrowserDeadline(
        this.provider.open({
          browserSessionId,
          url,
          viewport: viewport(inputViewport),
          signal: openController.signal,
        }),
        this.providerOpenTimeoutMs,
        () => new LiveBrowserError(
          "browser_provider_timeout",
          `浏览器引擎在 ${Math.ceil(this.providerOpenTimeoutMs / 1_000)} 秒内没有响应，请重试`,
          504,
        ),
        {
          onTimeout: () => openController.abort(),
          onLateResolve: (lateTab) => lateTab.close(),
        },
      );
      try {
        if (this.shuttingDown || this.closedSessions.has(sessionId) || generation !== this.generation
          || sessionGeneration !== (this.sessionGenerations.get(sessionId) ?? 0)) {
          throw new LiveBrowserError("browser_cancelled", "会话已关闭，Live Browser 页面未保留", 409);
        }
        const state = tab.state();
        assertLiveBrowserCommittedPage(state.url, state.error);
        this.entries.set(this.key(sessionId, browserSessionId), { sessionId, tab, lastUsed: this.now() });
        return { state, png: tab.frame() };
      } catch (error) {
        void tab.close().catch(() => undefined);
        throw error;
      }
    } finally {
      const remaining = (this.reservations.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) this.reservations.delete(sessionId);
      else this.reservations.set(sessionId, remaining);
      this.globalReservations = Math.max(0, this.globalReservations - 1);
      this.pendingOpens.delete(pending);
      finishPending();
    }
  }

  list(sessionId: string): LiveBrowserState[] {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.tab.state());
  }

  get(sessionId: string, browserSessionId: string): LiveBrowserSnapshot {
    const tab = this.entry(sessionId, browserSessionId).tab;
    return { state: tab.state(), png: tab.frame() };
  }

  async action(
    sessionId: string,
    browserSessionId: string,
    action: (tab: LiveBrowserTabHandle) => Promise<LiveBrowserSnapshot>,
    options: LiveBrowserActionOptions = {},
  ): Promise<LiveBrowserSnapshot> {
    const key = this.key(sessionId, browserSessionId);
    const entry = this.entry(sessionId, browserSessionId);
    try {
      const result = await withLiveBrowserDeadline(
        action(entry.tab),
        options.kind === "navigation" ? this.navigationActionTimeoutMs : this.actionTimeoutMs,
        () => new LiveBrowserError(
          "browser_action_timeout",
          `浏览器操作在 ${Math.ceil((options.kind === "navigation"
            ? this.navigationActionTimeoutMs : this.actionTimeoutMs) / 1_000)} 秒内没有响应，` +
            "该隔离页面已关闭，请重试",
          504,
        ),
        {
          onTimeout: () => {
            this.entries.delete(key);
            return entry.tab.close();
          },
          onLateResolve: () => entry.tab.close(),
        },
      );
      assertLiveBrowserCommittedPage(result.state.url, result.state.error);
      entry.lastUsed = this.now();
      return result;
    } catch (error) {
      if (error instanceof LiveBrowserError && [
        "browser_action_timeout",
        "browser_capture_timeout",
        "browser_navigation_timeout",
        "browser_navigation_failed",
        "browser_closed",
      ].includes(error.code)) {
        this.entries.delete(key);
        void entry.tab.close().catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Extract text only from the tab owned by this OntoCopilot session.  The tab implementation
   * serializes this with navigation and rejects a stale seq/URL both before and after evaluation.
   */
  async snapshotDocument(
    sessionId: string,
    browserSessionId: string,
    expected: { readonly seq: number; readonly url: string },
  ): Promise<LiveBrowserRawDocument> {
    const key = this.key(sessionId, browserSessionId);
    const entry = this.entry(sessionId, browserSessionId);
    const result = await withLiveBrowserDeadline(
      entry.tab.snapshotDocument(expected),
      this.actionTimeoutMs,
      () => new LiveBrowserError(
        "browser_snapshot_timeout",
        `网页正文提取在 ${Math.ceil(this.actionTimeoutMs / 1_000)} 秒内没有响应，该隔离页面已关闭，请重试`,
        504,
      ),
      {
        onTimeout: () => {
          this.entries.delete(key);
          return entry.tab.close();
        },
        onLateResolve: () => entry.tab.close(),
      },
    );
    entry.lastUsed = this.now();
    return result;
  }

  async close(sessionId: string, browserSessionId: string): Promise<void> {
    const key = this.key(sessionId, browserSessionId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.tab.close();
  }

  async closeSession(sessionId: string): Promise<void> {
    // Session ids are immutable/non-reusable. Tombstoning closes the small delete race between the
    // ownership read and the durable repo deletion; a late POST cannot resurrect a Chromium tab.
    this.closedSessions.add(sessionId);
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.close(sessionId, entry.tab.browserSessionId)));
    const pending = [...this.pendingOpens.entries()]
      .filter(([, row]) => row.sessionId === sessionId);
    for (const [, row] of pending) row.abort();
    await Promise.all(pending.map(([operation]) => operation));
  }

  async closeExpired(): Promise<number> {
    const cutoff = this.now() - this.idleTtlMs;
    const expired = [...this.entries.values()].filter((entry) => entry.lastUsed <= cutoff);
    await Promise.all(expired.map((entry) => this.close(entry.sessionId, entry.tab.browserSessionId)));
    return expired.length;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.generation += 1;
    if (this.reaper !== null) clearInterval(this.reaper);
    this.reaper = null;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.tab.close().catch(() => undefined)));
    for (const row of this.pendingOpens.values()) row.abort();
    await Promise.all([...this.pendingOpens.keys()]);
    try {
      await this.provider.shutdown();
    } finally {
      this.reservations.clear();
      this.globalReservations = 0;
      this.shuttingDown = false;
    }
  }
}

export const liveBrowserRuntime = new LiveBrowserRuntime();

export async function stopLiveBrowserRuntime(): Promise<void> {
  await liveBrowserRuntime.shutdown();
}
