/**
 * 受控的公网资料检索。
 *
 * 这里刻意把“搜索提供商”和“任意 URL 抓取”分开：服务端只会访问两个固定的
 * HTTPS API；`read()` 也只接受本实例此前由 `search()` 签发并登记的 source_id，
 * 不接受 URL。网页标题、摘要和正文都是不可信外部数据，调用方不得把它们当成
 * 指令，也不得自动提升为客户事实。
 */

import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
export const BING_RSS_ENDPOINT = "https://www.bing.com/search";
export const BING_GLOBAL_RSS_ENDPOINT = "https://global.bing.com/search";

export const WEB_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
export const WEB_REQUEST_TIMEOUT_MS = 12_000;
export const WEB_MAX_RESULTS = 8;
export const WEB_MAX_QUERY_CHARS = 500;
export const WEB_MAX_TITLE_CHARS = 240;
export const WEB_MAX_SNIPPET_CHARS = 900;
export const WEB_MAX_CONTENT_CHARS = 12_000;
export const WEB_MAX_PROVIDER_REDIRECTS = 3;

const WEB_MAX_PROVIDER_CANDIDATES = WEB_MAX_RESULTS * 2;

/**
 * `global` 请求海外/英文资料（Bing fallback 固定英文/美国市场）；`regional` 保留
 * 提供商按部署地区选择市场。查询词不在服务端翻译，调用方在 global 模式应传入
 * 英文查询，避免服务端擅自改写专有名词。
 */
export type WebSearchScope = "global" | "regional";

export type WebContentStatus = "fetched" | "snippet_only" | "blocked";
export type WebSearchProvider = "tavily" | "bing";

/** 所有字符串均来自外部网页，必须作为不可信数据展示/引用。 */
export interface WebSearchResult {
  source_id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  published_at: string | null;
  retrieved_at: string;
  content_status: WebContentStatus;
}

export interface WebSearchResponse {
  query: string;
  search_id: string;
  results: WebSearchResult[];
  provider: WebSearchProvider;
  scope: WebSearchScope;
  retrieved_at: string;
}

export interface WebReadResponse extends WebSearchResult {
  /** 正文仍是不可信网页数据；此标记供工具适配层强制带入模型上下文。 */
  untrusted: true;
  content: string;
}

export interface WebSearchOptions {
  maxResults?: number;
  /** 默认 global；regional 用于明确需要本地语言/本地区结果的检索。 */
  scope?: WebSearchScope;
}

export type WebFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSearchServiceOptions {
  fetch?: WebFetch;
  /** `undefined` 读环境变量；`null` 明确关闭 Tavily，便于部署和测试 Bing fallback。 */
  apiKey?: string | null;
  now?: () => number;
  idFactory?: () => string;
  timeoutMs?: number;
  responseLimitBytes?: number;
  cacheTtlMs?: number;
  maxKnownSources?: number;
}

export class WebSearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebSearchError";
    this.code = code;
  }
}

interface ProviderResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/**
 * 常见国家顶级域下的公共二级后缀。Node URL 不带 Public Suffix List；这里用一条
 * 保守规则覆盖企业检索最常见的 `co.uk`、`com.cn` 等形态，其余域名取末两段。
 * 目的只是结果多样化，不用于安全或所有权判定。
 */
const COMMON_CCTLD_PUBLIC_SECOND_LEVELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gov",
  "mil",
  "net",
  "ne",
  "nom",
  "or",
  "org",
]);

function registrableDomain(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(normalized)) return normalized;
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) return normalized;
  const topLevel = labels.at(-1) ?? "";
  const secondLevel = labels.at(-2) ?? "";
  const publicSuffixParts = topLevel.length === 2 &&
      COMMON_CCTLD_PUBLIC_SECOND_LEVELS.has(secondLevel)
    ? 2
    : 1;
  const firstRegistrable = Math.max(0, labels.length - publicSuffixParts - 1);
  return labels.slice(firstRegistrable).join(".");
}

function boundedText(value: unknown, maxChars: number): string {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function htmlToText(value: unknown, maxChars: number): string {
  const withoutMarkup = String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return boundedText(decodeXmlEntities(withoutMarkup), maxChars);
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : whole;
    }
    if (entity.startsWith("#")) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function normalizedDate(value: unknown): string | null {
  const text = boundedText(value, 120);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  const a = octets[0];
  const b = octets[1];
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function ipv6BigInt(address: string): bigint | null {
  let text = address.toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  let embedded: string[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : text;
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const nums = tail.split(".").map(Number);
    embedded = [
      (((nums[0] ?? 0) << 8) | (nums[1] ?? 0)).toString(16),
      (((nums[2] ?? 0) << 8) | (nums[3] ?? 0)).toString(16),
    ];
    text = `${text.slice(0, lastColon + 1)}${embedded.join(":")}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((acc, part) => (acc << 16n) | BigInt(`0x${part}`), 0n);
}

function prefixMatches(value: bigint, prefix: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
}

function ipv6IsPublic(address: string): boolean {
  const value = ipv6BigInt(address);
  if (value === null) return false;
  // unspecified / loopback, ULA, link-local, multicast, documentation range
  if (value === 0n || value === 1n) return false;
  if (prefixMatches(value, 0xfc00n << 112n, 7)) return false;
  if (prefixMatches(value, 0xfe80n << 112n, 10)) return false;
  if (prefixMatches(value, 0xff00n << 112n, 8)) return false;
  if (prefixMatches(value, 0x20010db8n << 96n, 32)) return false;

  // IPv4-mapped IPv6: public-ness follows the embedded IPv4 address.
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return ipv4IsPublic(
      `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
    );
  }
  return true;
}

/**
 * 只接受可公开引用的普通网页 URL。这里不会对这个 URL 直接 fetch；它只可能被
 * 发送给固定的 Tavily extract API，因此 DNS rebinding 不能触达 OntoCopilot 内网。
 */
export function publicWebUrl(value: unknown): URL | null {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost") return null;
  if (/\.(?:localhost|local|internal|home|lan)$/.test(hostname)) return null;

  const ipKind = isIP(hostname);
  if (ipKind === 4 && !ipv4IsPublic(hostname)) return null;
  if (ipKind === 6 && !ipv6IsPublic(hostname)) return null;
  // 裸的单标签主机通常是内网别名；公网域名至少含一个点（IPv6 已在上面处理）。
  if (ipKind === 0 && !hostname.includes(".")) return null;

  url.hash = "";
  return url;
}

function xmlTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return match?.[1] ?? "";
}

function parseBingRss(xml: string): ProviderResult[] {
  const results: ProviderResult[] = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const match of xml.matchAll(itemPattern)) {
    const block = match[1] ?? "";
    results.push({
      title: htmlToText(xmlTag(block, "title"), WEB_MAX_TITLE_CHARS),
      url: boundedText(decodeXmlEntities(xmlTag(block, "link")), 2_048),
      snippet: htmlToText(xmlTag(block, "description"), WEB_MAX_SNIPPET_CHARS),
      publishedAt: normalizedDate(decodeXmlEntities(xmlTag(block, "pubDate"))),
    });
  }
  return results;
}

function parseTavilySearch(value: unknown): ProviderResult[] {
  if (typeof value !== "object" || value === null) return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((item): ProviderResult => {
    const row = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return {
      title: boundedText(row["title"], WEB_MAX_TITLE_CHARS),
      url: boundedText(row["url"], 2_048),
      snippet: htmlToText(row["content"], WEB_MAX_SNIPPET_CHARS),
      publishedAt: normalizedDate(row["published_date"] ?? row["published_at"]),
    };
  });
}

function bingSearchUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (!(hostname === "bing.com" || hostname.endsWith(".bing.com"))) return null;
  if (url.pathname !== "/search") return null;
  return url;
}

/** Bing 会按访问地区把 www.bing.com 重定向到 cn.bing.com 等区域域名。 */
function trustedProviderRedirect(current: string, location: string): string | null {
  const currentUrl = bingSearchUrl(current);
  if (!currentUrl) return null;
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  const trustedNext = bingSearchUrl(next.toString());
  if (!trustedNext) return null;
  // 地区跳转不能覆盖或丢掉我们签发的 query / market 参数，否则 global 会悄悄退回
  // 部署地区市场，regional 也可能变成一条没有原查询词的空搜索。
  for (const [name, value] of currentUrl.searchParams) {
    trustedNext.searchParams.set(name, value);
  }
  return trustedNext.toString();
}

function extractedContent(value: unknown, expectedUrl: string): string {
  if (typeof value !== "object" || value === null) return "";
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return "";
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const resultUrl = publicWebUrl(row["url"]);
    if (!resultUrl || resultUrl.toString() !== expectedUrl) continue;
    const content = htmlToText(row["raw_content"] ?? row["content"], WEB_MAX_CONTENT_CHARS);
    if (content) return content;
  }
  return "";
}

function cloneResult(result: WebSearchResult): WebSearchResult {
  return { ...result };
}

function cloneSearch(response: WebSearchResponse): WebSearchResponse {
  return { ...response, results: response.results.map(cloneResult) };
}

export class WebSearchService {
  readonly #fetch: WebFetch;
  readonly #apiKey: string;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #timeoutMs: number;
  readonly #responseLimitBytes: number;
  readonly #cacheTtlMs: number;
  readonly #maxKnownSources: number;
  readonly #searchCache = new Map<string, CacheEntry<WebSearchResponse>>();
  readonly #readCache = new Map<string, CacheEntry<WebReadResponse>>();
  readonly #searchInflight = new Map<string, Promise<WebSearchResponse>>();
  readonly #readInflight = new Map<string, Promise<WebReadResponse>>();
  readonly #knownSources = new Map<string, WebSearchResult>();

  constructor(options: WebSearchServiceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiKey = boundedText(
      options.apiKey === undefined ? process.env["TAVILY_API_KEY"] : options.apiKey,
      512,
    );
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? WEB_REQUEST_TIMEOUT_MS);
    this.#responseLimitBytes = Math.max(1, options.responseLimitBytes ?? WEB_RESPONSE_LIMIT_BYTES);
    this.#cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10 * 60_000);
    this.#maxKnownSources = Math.max(8, options.maxKnownSources ?? 500);
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
    const normalizedQuery = boundedText(query, WEB_MAX_QUERY_CHARS);
    if (!normalizedQuery) throw new WebSearchError("invalid_query", "搜索词不能为空");
    const maxResults = Math.min(WEB_MAX_RESULTS, Math.max(1, Math.trunc(options.maxResults ?? 5)));
    const scope: WebSearchScope = options.scope === "regional" ? "regional" : "global";
    const provider: WebSearchProvider = this.#apiKey ? "tavily" : "bing";
    const key = `${provider}\u0000${scope}\u0000${maxResults}\u0000${normalizedQuery.toLocaleLowerCase()}`;
    const cached = this.#searchCache.get(key);
    if (cached && cached.expiresAt > this.#now()) {
      this.#remember(cached.value.results);
      return cloneSearch(cached.value);
    }

    const pending = this.#searchInflight.get(key);
    if (pending) return cloneSearch(await pending);
    const task = this.#searchUncached(normalizedQuery, maxResults, provider, scope);
    this.#searchInflight.set(key, task);
    try {
      const response = await task;
      this.#searchCache.set(key, { expiresAt: this.#now() + this.#cacheTtlMs, value: response });
      this.#remember(response.results);
      this.#pruneCache(this.#searchCache);
      return cloneSearch(response);
    } finally {
      this.#searchInflight.delete(key);
    }
  }

  /**
   * 读取已搜索来源。参数只有不可伪造的 source_id；未知 ID 在任何网络请求发生前失败。
   */
  async read(sourceId: string): Promise<WebReadResponse> {
    const source = this.#knownSources.get(String(sourceId));
    if (!source) {
      throw new WebSearchError("unknown_source", "只能读取本次服务已搜索到的 source_id");
    }
    const cached = this.#readCache.get(source.source_id);
    if (cached && cached.expiresAt > this.#now()) return { ...cached.value };
    const pending = this.#readInflight.get(source.source_id);
    if (pending) return { ...(await pending) };

    const task = this.#readUncached(source);
    this.#readInflight.set(source.source_id, task);
    try {
      const response = await task;
      this.#readCache.set(source.source_id, {
        expiresAt: this.#now() + this.#cacheTtlMs,
        value: response,
      });
      this.#pruneCache(this.#readCache);
      return { ...response };
    } finally {
      this.#readInflight.delete(source.source_id);
    }
  }

  /**
   * 从会话的耐久状态恢复此前签发的来源。仍逐条重验 source_id 与公网 URL；调用方
   * 不能借一条损坏的状态记录把 `read()` 退化成任意 URL 参数。
   */
  restoreSources(values: readonly unknown[]): number {
    const restored: WebSearchResult[] = [];
    for (const value of values.slice(-this.#maxKnownSources)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const sourceId = boundedText(row["source_id"], 96);
      if (!/^web_[a-f0-9]{16}$/.test(sourceId)) continue;
      const url = publicWebUrl(row["url"]);
      if (!url) continue;
      restored.push({
        source_id: sourceId,
        title: boundedText(row["title"], WEB_MAX_TITLE_CHARS) || url.hostname,
        url: url.toString(),
        domain: url.hostname.toLowerCase(),
        snippet: htmlToText(row["snippet"], WEB_MAX_SNIPPET_CHARS),
        published_at: normalizedDate(row["published_at"]),
        retrieved_at: normalizedDate(row["retrieved_at"]) ?? new Date(this.#now()).toISOString(),
        content_status: row["content_status"] === "fetched" || row["content_status"] === "blocked"
          ? row["content_status"]
          : "snippet_only",
      });
    }
    this.#remember(restored);
    return restored.length;
  }

  async #searchUncached(
    query: string,
    maxResults: number,
    provider: WebSearchProvider,
    scope: WebSearchScope,
  ): Promise<WebSearchResponse> {
    const retrievedAt = new Date(this.#now()).toISOString();
    const searchId = `ws_${this.#idFactory().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}`;
    const candidateLimit = Math.min(WEB_MAX_PROVIDER_CANDIDATES, maxResults * 2);
    let rawResults: ProviderResult[];
    if (provider === "tavily") {
      const payload = await this.#jsonRequest(TAVILY_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: candidateLimit,
          search_depth: "advanced",
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
      });
      // `answer` / provider-generated summaries are intentionally ignored.
      rawResults = parseTavilySearch(payload);
    } else {
      // `www.bing.com` 会按出口地区跳到 cn.bing.com；即使附带 mkt，RSS 仍可能把
      // 中文词典和国内聚合站排在最前。global 直接使用 Bing 的全球入口，regional
      // 才保留部署地区入口。
      const url = new URL(scope === "global" ? BING_GLOBAL_RSS_ENDPOINT : BING_RSS_ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "rss");
      url.searchParams.set("count", String(candidateLimit));
      if (scope === "global") {
        url.searchParams.set("mkt", "en-US");
        url.searchParams.set("cc", "US");
        url.searchParams.set("setlang", "en-US");
      }
      rawResults = parseBingRss(await this.#textRequest(url.toString(), {
        method: "GET",
        ...(scope === "global"
          ? { headers: { "accept-language": "en-US,en;q=0.9" } }
          : {}),
      }));
    }

    const seenUrls = new Set<string>();
    const candidates: Array<{
      raw: ProviderResult;
      url: URL;
      canonical: string;
      domainKey: string;
    }> = [];
    for (const raw of rawResults) {
      const url = publicWebUrl(raw.url);
      if (!url) continue;
      const canonical = url.toString();
      const domainKey = registrableDomain(url.hostname);
      if (seenUrls.has(canonical)) continue;
      seenUrls.add(canonical);
      candidates.push({ raw, url, canonical, domainKey });
    }

    // 第一遍每个可注册域只取一条。global 的契约就是跨站多样性，因此宁可少返回也
    // 不让同品牌子站回填；regional 偏向本地查全，域不足时才按原排名用唯一 URL 回填。
    const selected: typeof candidates = [];
    const selectedUrls = new Set<string>();
    const seenDomains = new Set<string>();
    for (const candidate of candidates) {
      if (selected.length >= maxResults) break;
      if (seenDomains.has(candidate.domainKey)) continue;
      seenDomains.add(candidate.domainKey);
      selectedUrls.add(candidate.canonical);
      selected.push(candidate);
    }
    if (scope === "regional") {
      for (const candidate of candidates) {
        if (selected.length >= maxResults) break;
        if (selectedUrls.has(candidate.canonical)) continue;
        selectedUrls.add(candidate.canonical);
        selected.push(candidate);
      }
    }

    const results: WebSearchResult[] = [];
    for (const { raw, url, canonical } of selected) {
      const sourceId = `web_${createHash("sha256")
        .update(`${searchId}\u0000${canonical}`)
        .digest("hex")
        .slice(0, 16)}`;
      results.push({
        source_id: sourceId,
        title: raw.title || url.hostname,
        url: canonical,
        domain: url.hostname.toLowerCase(),
        snippet: raw.snippet,
        published_at: raw.publishedAt,
        retrieved_at: retrievedAt,
        content_status: "snippet_only",
      });
    }
    return { query, search_id: searchId, results, provider, scope, retrieved_at: retrievedAt };
  }

  async #readUncached(source: WebSearchResult): Promise<WebReadResponse> {
    // Bing RSS fallback 已提供摘要；正文提取只经固定 Tavily API，不从 OntoCopilot
    // 进程直接访问网页，避免把搜索结果变成 SSRF 通道。
    if (!this.#apiKey) {
      return { ...source, untrusted: true, content: source.snippet };
    }
    const url = publicWebUrl(source.url);
    if (!url) {
      return { ...source, content_status: "blocked", untrusted: true, content: "" };
    }
    const payload = await this.#jsonRequest(TAVILY_EXTRACT_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        urls: [url.toString()],
        extract_depth: "basic",
        include_images: false,
      }),
    });
    const content = extractedContent(payload, url.toString());
    return {
      ...source,
      content_status: content ? "fetched" : "blocked",
      untrusted: true,
      content,
    };
  }

  #remember(results: readonly WebSearchResult[]): void {
    for (const result of results) {
      this.#knownSources.delete(result.source_id);
      this.#knownSources.set(result.source_id, cloneResult(result));
    }
    while (this.#knownSources.size > this.#maxKnownSources) {
      const oldest = this.#knownSources.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#knownSources.delete(oldest);
      this.#readCache.delete(oldest);
    }
  }

  #pruneCache<T>(cache: Map<string, CacheEntry<T>>): void {
    const now = this.#now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > 100) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async #jsonRequest(url: string, init: RequestInit): Promise<unknown> {
    const text = await this.#textRequest(url, init);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new WebSearchError("invalid_provider_response", "检索提供商返回了无效 JSON", {
        cause: error,
      });
    }
  }

  async #textRequest(url: string, init: RequestInit): Promise<string> {
    const retryable = new Set([429, 502, 503, 504]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        let requestUrl = url;
        let response: Response | undefined;
        for (let redirects = 0; redirects <= WEB_MAX_PROVIDER_REDIRECTS; redirects += 1) {
          response = await this.#fetch(requestUrl, {
            ...init,
            // 手动跟随且逐跳验域名；直接 follow 会把固定 provider 退化成 SSRF 跳板。
            redirect: "manual",
            signal: controller.signal,
            headers: {
              accept: bingSearchUrl(requestUrl)
                ? "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8"
                : "application/json",
              "user-agent": "OntoCopilot-WebResearch/1.0",
              ...init.headers,
            },
          });
          if (response.status < 300 || response.status >= 400) break;
          const next = trustedProviderRedirect(requestUrl, response.headers.get("location") ?? "");
          if (!next) {
            throw new WebSearchError(
              "unsafe_provider_redirect",
              "检索提供商返回了不安全的重定向",
            );
          }
          if (redirects === WEB_MAX_PROVIDER_REDIRECTS) {
            throw new WebSearchError("provider_redirect_loop", "检索提供商重定向次数过多");
          }
          requestUrl = next;
        }
        if (!response) throw new WebSearchError("provider_network_error", "无法连接检索提供商");
        if (!response.ok) {
          if (attempt === 0 && retryable.has(response.status)) continue;
          throw new WebSearchError(
            "provider_http_error",
            `检索提供商请求失败（HTTP ${response.status}）`,
          );
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > this.#responseLimitBytes) {
          throw new WebSearchError("response_too_large", "检索提供商响应超过 2 MiB 限制");
        }
        if (!response.body) return "";
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > this.#responseLimitBytes) {
            await reader.cancel();
            throw new WebSearchError("response_too_large", "检索提供商响应超过 2 MiB 限制");
          }
          chunks.push(part.value);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder().decode(body);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        if (controller.signal.aborted) {
          throw new WebSearchError("provider_timeout", "检索提供商请求超过 12 秒", {
            cause: error,
          });
        }
        throw new WebSearchError("provider_network_error", "无法连接检索提供商", {
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new WebSearchError("provider_http_error", "检索提供商请求失败");
  }
}

export function createWebSearchService(options: WebSearchServiceOptions = {}): WebSearchService {
  return new WebSearchService(options);
}
