/**
 * `web.sources` 持久事件在进入 React 之前的窄化层。
 *
 * 网络搜索结果是不可信输入：服务端、历史会话，甚至搜索结果本身都可能给出残缺或
 * 恶意字段。视图只消费这里产出的纯文本与 http(s) URL，避免每张卡各写一套宽松判断。
 */

export const WEB_SOURCE_LIMIT = 5;
export const WEB_SOURCE_COLLAPSED_LIMIT = 3;

const TEXT_LIMITS = {
  query: 240,
  id: 120,
  title: 180,
  domain: 120,
  siteName: 120,
  snippet: 600,
  date: 64,
  language: 32,
  evidenceRef: 160,
} as const;

export type WebContentStatus = "fetched" | "snippet_only" | "blocked";

export interface WebSourceItem {
  id: string;
  title: string;
  url: string;
  domain: string;
  siteName: string;
  snippet: string;
  contentStatus: WebContentStatus;
  publishedAt?: string;
  retrievedAt?: string;
  language?: string;
  evidenceRef?: string;
}

export interface WebSourcesCardData {
  query: string;
  searchId: string;
  results: WebSourceItem[];
  citationIds: string[];
  total: number;
  truncated: boolean;
}

/**
 * 把任意值收成单行安全文本，并按 Unicode code point 截断。
 *
 * React 会负责 HTML 转义；这里额外去掉控制字符与双向文本控制符，防止来源标题用
 * 隐形字符伪装域名。按 code point 切，不会留下半个 UTF-16 surrogate。
 */
export function safeWebText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, Math.max(0, max)).join("");
}

/** 只允许无凭证的 http(s) 链接；其余协议和畸形 URL 都不进入 DOM。 */
export function safeWebUrl(value: unknown): string | null {
  const raw = safeWebText(value, 2_048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function optionalText(value: unknown, max: number): string | undefined {
  const text = safeWebText(value, max);
  return text || undefined;
}

function statusOf(value: unknown): WebContentStatus {
  if (value === "fetched" || value === "blocked") return value;
  return "snippet_only";
}

function itemOf(value: unknown, index: number): WebSourceItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const url = safeWebUrl(row.url);
  if (!url) return null;

  const parsed = new URL(url);
  const id = safeWebText(row.id ?? row.source_id, TEXT_LIMITS.id);
  // source id 是后续 `web.read` 的唯一引用。缺 id 的结果不能冒充可引用证据。
  if (!id) return null;

  // 域名是用户判断链接去向的安全锚点，必须从真正的 href 推导，不能相信事件里一份
  // 可伪造的 `domain` 文案（evil.example 自称 docs.shopify.com 会直接误导人）。
  const domain = safeWebText(parsed.hostname, TEXT_LIMITS.domain);
  const title = safeWebText(row.title, TEXT_LIMITS.title) || domain || `来源 ${index + 1}`;
  const siteName = safeWebText(row.site_name ?? row.siteName, TEXT_LIMITS.siteName) || domain;
  const result: WebSourceItem = {
    id,
    title,
    url,
    domain,
    siteName,
    snippet: safeWebText(row.snippet ?? row.excerpt ?? row.content, TEXT_LIMITS.snippet),
    contentStatus: statusOf(row.content_status ?? row.contentStatus),
  };

  const publishedAt = optionalText(row.published_at ?? row.publishedAt, TEXT_LIMITS.date);
  const retrievedAt = optionalText(row.retrieved_at ?? row.retrievedAt, TEXT_LIMITS.date);
  const language = optionalText(row.language, TEXT_LIMITS.language);
  const evidenceRef = optionalText(row.evidence_ref ?? row.evidenceRef, TEXT_LIMITS.evidenceRef);
  if (publishedAt !== undefined) result.publishedAt = publishedAt;
  if (retrievedAt !== undefined) result.retrievedAt = retrievedAt;
  if (language !== undefined) result.language = language;
  if (evidenceRef !== undefined) result.evidenceRef = evidenceRef;
  return result;
}

/**
 * 校验并规范化一条 `web.sources` durable event。没有任何有效来源时返回 `null`，让
 * 时间线跳过空卡；最多保留五条，既限制 DOM 体积，也让回答正文仍是阅读主线。
 */
export function parseWebSourcesEvent(event: unknown): WebSourcesCardData | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const ev = event as Record<string, unknown>;
  if (ev.kind !== "web.sources") return null;

  const raw = Array.isArray(ev.results) ? ev.results : Array.isArray(ev.sources) ? ev.sources : [];
  const parsed = raw.map(itemOf).filter((item): item is WebSourceItem => item !== null);
  // 搜索提供方偶尔会用不同 tracking URL 重复同一条，也可能错误复用 source id。
  // 卡片里的编号和后续 web.read 都要求一对一，因此两者任一重复都只保留第一条。
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const valid = parsed.filter(item => {
    if (seenIds.has(item.id) || seenUrls.has(item.url)) return false;
    seenIds.add(item.id);
    seenUrls.add(item.url);
    return true;
  });
  if (!valid.length) return null;

  const results = valid.slice(0, WEB_SOURCE_LIMIT);
  const validIds = new Set(results.map(item => item.id));
  const citationIds = (Array.isArray(ev.citation_ids) ? ev.citation_ids : [])
    .map(value => safeWebText(value, TEXT_LIMITS.id))
    .filter((id, index, all) => validIds.has(id) && all.indexOf(id) === index);
  const declaredTotal = Number(ev.total);
  const total = Number.isSafeInteger(declaredTotal) && declaredTotal >= 0
    ? Math.max(declaredTotal, results.length)
    : valid.length;
  return {
    query: safeWebText(ev.query, TEXT_LIMITS.query),
    searchId: safeWebText(ev.search_id ?? ev.searchId, TEXT_LIMITS.id),
    results,
    citationIds,
    total,
    truncated: ev.truncated === true || valid.length > results.length || total > results.length,
  };
}
