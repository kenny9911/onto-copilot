/**
 * 安全网页读取与 FDE 可引用 reader snapshot。
 *
 * 这里不是浏览器代理：不执行/回传第三方脚本，不携带 cookie、Authorization、
 * Referer，也不把任意网页 HTML 以内联方式交给前端。每一跳先解析 DNS 并拒绝任一
 * 非公网地址；默认 transport 再把连接钉在已经验过的 IP 上，避免校验后 DNS rebinding。
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { pdfToTextPages, type PdfTextPages } from "../onto/render.js";
import { publicWebUrl } from "./web_search.js";

export const WEB_PAGE_SCHEMA_VERSION = "ontocopilot.web-page/1" as const;
export const WEB_PAGE_MAX_BYTES = 1_500_000;
/** PDF 是二进制材料，通常比网页正文大；仍给每次抓取设置硬上限，避免下载炸弹。 */
export const WEB_PDF_MAX_BYTES = 12_000_000;
// Documentation portals and born-digital PDFs can have a slow first byte even
// when the eventual payload is small. Keep a hard wall-clock deadline, but give
// those sources enough time to reach the response headers.
export const WEB_PAGE_TIMEOUT_MS = 30_000;
export const WEB_PDF_TIMEOUT_MS = 45_000;
export const WEB_PAGE_MAX_REDIRECTS = 4;
export const WEB_PAGE_MAX_PARAGRAPHS = 120;
export const WEB_PAGE_MAX_TEXT_CHARS = 120_000;
/**
 * GitHub 的网页入口在部分企业网络中不可达，但同一份公开 README 仍可经官方 API
 * 安全读取。主入口只等一个短窗口，然后才使用这个只读降级源，避免一次打开卡满
 * 整个通用网页 deadline。
 */
export const WEB_GITHUB_PRIMARY_TIMEOUT_MS = 8_000;
export const WEB_PREVIEW_CACHE_TTL_MS = 2 * 60_000;
export const WEB_PREVIEW_CACHE_CAP = 64;

const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
]);

export const WEB_PDF_MAX_PAGES = 20;

export type WebPageStatus = "live" | "snapshot" | "blocked";

export interface WebPageParagraph {
  readonly citationId: string;
  readonly index: number;
  readonly text: string;
  readonly pageNumber?: number;
}

export interface WebPageCitation extends WebPageParagraph {
  readonly url: string;
  readonly title: string;
}

export interface WebPageEmbed {
  readonly allowed: boolean;
  readonly url?: string;
  readonly reason?: string;
}

export interface WebPdfResource {
  readonly kind: "pdf";
  readonly mimeType: "application/pdf";
  readonly filename: string;
  readonly byteLength: number;
  readonly textStatus: "available" | "partial" | "unavailable";
  readonly extractedPages: number;
  readonly textPages: number;
  readonly totalPages?: number;
  readonly truncated: boolean;
  readonly reason?: string;
}

export interface WebPageSnapshot {
  readonly schemaVersion: typeof WEB_PAGE_SCHEMA_VERSION;
  readonly id: string;
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly status: WebPageStatus;
  readonly fetchedAt: string;
  readonly digest: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly paragraphs: readonly WebPageParagraph[];
  readonly citations: readonly WebPageCitation[];
  readonly embed: WebPageEmbed;
  /**
   * 下载后的同一份不可变二进制资源。领域对象不带本地 URL；会话 route 在 wire
   * 边界追加同源 previewUrl，前端绝不能退回去 iframe `finalUrl`。
   */
  readonly resource?: WebPdfResource;
  readonly blockedReason?: string;
  readonly httpStatus?: number;
  readonly untrusted: true;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebHostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface WebTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface WebTransportRequest {
  readonly addresses: readonly ResolvedAddress[];
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly pdfMaxBytes?: number;
  /** 只允许 service 选择静态 Accept；不会透传用户 header/cookie/token。 */
  readonly accept?: string;
}

export type WebPreviewTransport = (
  url: URL,
  request: WebTransportRequest,
) => Promise<WebTransportResponse>;

export interface WebPreviewServiceOptions {
  readonly resolver?: WebHostResolver;
  readonly transport?: WebPreviewTransport;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pdfTimeoutMs?: number;
  readonly maxBytes?: number;
  readonly pdfMaxBytes?: number;
  readonly maxRedirects?: number;
  readonly pdfMaxPages?: number;
  readonly pdfTextExtractor?: (
    bytes: Uint8Array,
    options: { maxPages: number },
  ) => Promise<PdfTextPages>;
  readonly cacheTtlMs?: number;
  readonly cacheCap?: number;
}

export interface WebPreviewOpenResult {
  readonly page: WebPageSnapshot;
  /** 仅供 route 原子落盘；不会序列化进 session state。 */
  readonly resourceBytes?: Uint8Array;
}

export class WebPreviewError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebPreviewError";
    this.code = code;
  }
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pageId(url: string, version: string): string {
  // URL 是逻辑身份，digest 是不可变版本。同 URL 刷新出不同正文必须保留两个 pageId，
  // 否则旧 AssetMemory 的 snapshotEndpoint 会悄悄读到新字节。
  return `page_${sha(`${url}\u0000${version}`).slice(0, 24)}`;
}

function clipped(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  return [...text].length <= max ? text : `${[...text].slice(0, Math.max(0, max - 1)).join("")}…`;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    copy: "©", reg: "®", ndash: "–", mdash: "—", hellip: "…",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (entity.startsWith("#")) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function htmlText(value: string): string {
  return clipped(decodeEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")), 4_000);
}

function htmlTitle(html: string, fallback: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return clipped(match ? htmlText(match[1] ?? "") : fallback, 240) || fallback;
}

function titleFromText(text: string, fallback: string): string {
  const first = text.split(/\r?\n/u)
    .map((line) => clipped(line.replace(/^\s{0,3}#{1,6}\s+/u, ""), 240))
    .find(Boolean);
  return first || fallback;
}

function cleanHtml(html: string): string {
  return html
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas)\b[\s\S]*?<\/\1>/gi, " ");
}

function htmlBlocks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const blocks = /<(h[1-6]|p|li|blockquote|pre|dt|dd|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(blocks)) {
    const text = htmlText(match[2] ?? "");
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
    // 先给 primary-content 候选多一点空间，再由 boundedParagraphs 做最终硬限制。
    if (out.length >= WEB_PAGE_MAX_PARAGRAPHS * 2) break;
  }
  return out;
}

function htmlTagRegions(html: string, tag: "article" | "main"): string[] {
  const regions: string[] = [];
  // article/main 是语义化且域名无关的正文信号。只抽服务端静态 HTML，不执行 DOM、
  // script 或 selector，第三方内容无法借这里获得代码执行能力。
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "giu");
  for (const match of html.matchAll(pattern)) {
    if (match[1]) regions.push(match[1]);
    if (regions.length >= 16) break;
  }
  return regions;
}

function tagAttribute(tag: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const quoted = new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(tag)?.[2];
  const bare = new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, "iu").exec(tag)?.[1];
  return decodeEntities(quoted ?? bare ?? "");
}

function htmlMetadataParagraphs(html: string): string[] {
  const out: string[] = [];
  const add = (value: unknown): void => {
    const normalized = clipped(value, 4_000);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const key = (tagAttribute(tag, "name") || tagAttribute(tag, "property")).toLowerCase();
    if (["description", "og:description", "twitter:description"].includes(key)) {
      add(tagAttribute(tag, "content"));
    }
    if (out.length >= 8) break;
  }

  // 静态 JSON-LD 是很多文档站/新闻站在 JS shell 中留下的唯一正文。这里只 JSON.parse
  // 并读取标准文本字段；不 eval、不解析 URL，也不执行脚本。遍历深度/节点/字符均受限。
  let scripts = 0;
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    scripts += 1;
    if (scripts > 8) break;
    const raw = (match[1] ?? "").trim();
    if (!raw || raw.length > 250_000) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      let visited = 0;
      const walk = (value: unknown, depth: number): void => {
        if (depth > 5 || visited >= 200 || out.length >= 24) return;
        visited += 1;
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 40)) walk(item, depth + 1);
          return;
        }
        if (value === null || typeof value !== "object") return;
        const row = value as Record<string, unknown>;
        for (const key of ["headline", "description", "articleBody", "text"] as const) {
          if (typeof row[key] === "string") add(row[key]);
        }
        for (const [key, child] of Object.entries(row)) {
          if (!["headline", "description", "articleBody", "text"].includes(key)) walk(child, depth + 1);
        }
      };
      walk(parsed, 0);
    } catch {
      // 非法 JSON-LD 不是整页失败条件；继续使用语义 HTML/meta 快照。
    }
  }
  return out;
}

function extractHtmlParagraphs(html: string): string[] {
  const metadata = htmlMetadataParagraphs(html);
  const clean = cleanHtml(html);
  const score = (rows: readonly string[]): number => rows.reduce((sum, row) => sum + row.length, 0);
  const ranked = (tag: "article" | "main"): string[][] => htmlTagRegions(clean, tag)
    .map((region) => htmlBlocks(region))
    .filter((blocks) => blocks.length > 0)
    .sort((left, right) => score(right) - score(left));
  const article = ranked("article")[0];
  const main = ranked("main")[0];
  // article 嵌套在 main 时，main 的分数天然更大，但前面常夹着 GitHub/文档站导航。
  // 有实质内容的 article 应优先；很短的卡片 article 才回退到 main。
  const selected = article && score(article) >= 64
    ? article
    : main ?? article ?? htmlBlocks(clean);
  const combined = [...selected];
  // primary content 优先；只有 shell 很薄时才把 metadata 放到前面，防止导航文本挤占
  // 120 段配额。正文充分时 metadata 只作末尾补充并去重。
  const selectedChars = selected.reduce((sum, row) => sum + row.length, 0);
  const ordered = selectedChars < 240 ? [...metadata, ...combined] : [...combined, ...metadata];
  const unique = [...new Set(ordered)].slice(0, WEB_PAGE_MAX_PARAGRAPHS);
  if (unique.length > 0) return unique;
  const text = htmlText(clean);
  return text ? [text] : [];
}

function textParagraphs(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/(?:\r?\n){2,}/u)) {
    const value = clipped(block, 4_000);
    if (value && value !== out.at(-1)) out.push(value);
    if (out.length >= WEB_PAGE_MAX_PARAGRAPHS) break;
  }
  if (out.length === 0) {
    const one = clipped(text, 4_000);
    if (one) out.push(one);
  }
  return out;
}

function boundedParagraphs(values: readonly string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const value of values) {
    const remaining = WEB_PAGE_MAX_TEXT_CHARS - total;
    if (remaining <= 0) break;
    const next = clipped(value, Math.min(4_000, remaining));
    if (!next) continue;
    out.push(next);
    total += [...next].length;
  }
  return out;
}

function contentType(headers: Headers, body: Uint8Array): { mediaType: string; charset: string } {
  const raw = headers.get("content-type") ?? "";
  const [media = "", ...params] = raw.split(";");
  let type = media.trim().toLowerCase();
  const charset = params
    .map((part) => /^\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(part)?.[1] ?? "")
    .find(Boolean) || "utf-8";
  // 缺 header 或通用 octet-stream 时，只认文件头窗口起始处的 PDF 签名；普通二进制
  // 即便中间偶然出现 `%PDF-` 也不会命中。无 header 的 PDF 仍按较小网页下载上限收取。
  if ((!type || type === "application/octet-stream" || type === "binary/octet-stream") && pdfSignature(body)) {
    type = "application/pdf";
  } else if (!type) {
    // 缺 content-type 时只对白名单文本做保守 sniff；二进制绝不猜成 HTML。
    const head = new TextDecoder("utf-8", { fatal: false }).decode(body.slice(0, 512)).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(head)) type = "text/html";
    else if (body.slice(0, 512).every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32)) {
      type = "text/plain";
    }
  }
  return { mediaType: type, charset };
}

function declaredMediaType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function pdfSignature(body: Uint8Array): boolean {
  // ISO 32000 允许签名前有少量注释/空白；只在很小的头部窗口内找，不能把任意
  // 二进制里偶然出现的 `%PDF-` 当成 PDF。
  const head = new TextDecoder("latin1").decode(body.slice(0, 1_024));
  return /^\s*(?:%[^\r\n]*[\r\n]+\s*)*%PDF-/u.test(head);
}

function safePdfFilename(headers: Headers, final: URL): string {
  const disposition = headers.get("content-disposition") ?? "";
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  const quoted = /filename\s*=\s*"([^"]+)"/iu.exec(disposition)?.[1]
    ?? /filename\s*=\s*([^;\s]+)/iu.exec(disposition)?.[1];
  let candidate = "";
  try { candidate = encoded ? decodeURIComponent(encoded) : (quoted ?? ""); } catch { candidate = quoted ?? ""; }
  if (!candidate) {
    const leaf = final.pathname.split("/").filter(Boolean).at(-1) ?? "";
    try { candidate = decodeURIComponent(leaf); } catch { candidate = leaf; }
  }
  candidate = clipped(candidate.replace(/[\\/]/gu, "_").replace(/[\u0000-\u001f\u007f]/gu, ""), 180);
  if (!candidate) candidate = `${final.hostname}.pdf`;
  if (!/\.pdf$/iu.test(candidate)) candidate = `${candidate}.pdf`;
  return candidate;
}

function decodedBody(
  headers: Headers,
  body: Uint8Array,
  maxBytes: number,
): Uint8Array {
  const raw = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!raw || raw === "identity") return body;
  // 多层编码极少见且容易造成解压链炸弹；只接受一个主流、确定的内容编码。Node 的
  // maxOutputLength 在分配前/解压中强制限制解码后大小，压缩体本身也已被 transport
  // 的 maxBytes 限制，二者缺一不可。
  if (raw.includes(",")) {
    throw new WebPreviewError("unsupported_content_encoding", `不支持多层网页压缩：${clipped(raw, 80)}`);
  }
  try {
    const input = Buffer.from(body);
    const options = { maxOutputLength: maxBytes };
    let decoded: Buffer;
    if (raw === "gzip" || raw === "x-gzip") decoded = gunzipSync(input, options);
    else if (raw === "deflate") decoded = inflateSync(input, options);
    else if (raw === "br") decoded = brotliDecompressSync(input, options);
    else {
      throw new WebPreviewError(
        "unsupported_content_encoding",
        `不支持的网页压缩格式：${clipped(raw, 80)}`,
      );
    }
    if (decoded.byteLength > maxBytes) {
      throw new WebPreviewError("too_large", `解压后的资源超过 ${maxBytes} 字节限制`);
    }
    return new Uint8Array(decoded);
  } catch (error) {
    if (error instanceof WebPreviewError) throw error;
    const tooLarge = error instanceof Error
      && (error.message.includes("maxOutputLength") || error.message.includes("larger than"));
    throw new WebPreviewError(
      tooLarge ? "too_large" : "invalid_content_encoding",
      tooLarge ? `解压后的资源超过 ${maxBytes} 字节限制` : `网页压缩内容损坏（${raw}）`,
      { cause: error },
    );
  }
}

function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

function metaCsp(html: string): string {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/http-equiv\s*=\s*["']?content-security-policy/i.test(tag)) continue;
    const content = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2]
      ?? /content\s*=\s*([^\s>]+)/i.exec(tag)?.[1]
      ?? "";
    if (content) return decodeEntities(content);
  }
  return "";
}

/**
 * 嵌入默认拒绝。缺 header 不等于允许：站点可在下游/CDN、脚本或浏览器策略中继续
 * 拒绝。只有显式 `frame-ancestors *` 才标 allowed；网页本体仍始终保留 reader 快照。
 */
export function embedPolicy(headers: Headers, html: string, finalUrl: string): WebPageEmbed {
  const disposition = (headers.get("content-disposition") ?? "").trim();
  if (/^attachment(?:;|$)/i.test(disposition)) {
    return { allowed: false, reason: `Content-Disposition: ${clipped(disposition, 120)}` };
  }
  const xfo = (headers.get("x-frame-options") ?? "").trim();
  if (xfo) return { allowed: false, reason: `X-Frame-Options: ${clipped(xfo, 120)}` };
  const csp = (headers.get("content-security-policy") ?? "").trim() || metaCsp(html);
  if (!csp) return { allowed: false, reason: "站点未明确声明允许第三方嵌入" };
  const directive = csp.split(";").map((part) => part.trim())
    .find((part) => /^frame-ancestors(?:\s|$)/i.test(part));
  if (!directive) return { allowed: false, reason: "CSP 未明确声明 frame-ancestors" };
  const values = directive.replace(/^frame-ancestors\s*/i, "").trim().split(/\s+/u);
  if (values.length === 1 && values[0] === "*") return { allowed: true, url: finalUrl };
  return { allowed: false, reason: `CSP: ${clipped(directive, 180)}` };
}

function ipv4Public(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = -1, b = -1, c = -1] = parts;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Value(address: string): bigint | null {
  let raw = address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  const lastColon = raw.lastIndexOf(":");
  const tail = lastColon >= 0 ? raw.slice(lastColon + 1) : raw;
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    raw = `${raw.slice(0, lastColon + 1)}` +
      `${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:` +
      `${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6Public(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null || value === 0n || value === 1n) return false;
  // IPv4-mapped / IPv4-compatible 写成 hex（::ffff:7f00:1）时，上面的 dotted-tail
  // 快路不会命中；仍按嵌入 IPv4 判，不能把 loopback 伪装成普通 IPv6。
  if (value >> 32n === 0xffffn || value >> 32n === 0n) {
    const v4 = Number(value & 0xffffffffn);
    return ipv4Public(
      `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`,
    );
  }
  const prefix = (bits: number): bigint => value >> BigInt(128 - bits);
  if (prefix(7) === (0xfc00n << 112n) >> 121n) return false;
  if (prefix(10) === (0xfe80n << 112n) >> 118n) return false;
  if (prefix(10) === (0xfec0n << 112n) >> 118n) return false;
  if (prefix(8) === 0xffn) return false;
  if (prefix(32) === 0x20010db8n) return false;
  return true;
}

export function publicResolvedAddress(address: string): boolean {
  const kind = isIP(address);
  return kind === 4 ? ipv4Public(address) : kind === 6 ? ipv6Public(address) : false;
}

export const defaultWebHostResolver: WebHostResolver = async (hostname) => {
  const direct = isIP(hostname);
  if (direct === 4 || direct === 6) return [{ address: hostname, family: direct }];
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family === 6 ? 6 : 4 }));
};

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((item) => out.append(name, item));
    else if (value !== undefined) out.set(name, String(value));
  }
  return out;
}

async function requestPinnedAddress(
  url: URL,
  options: WebTransportRequest,
  pinned: ResolvedAddress,
  timeoutMs: number,
): Promise<WebTransportResponse> {
  const lookup: LookupFunction = (_hostname, _lookupOptions, callback) => {
    callback(null, pinned.address, pinned.family);
  };
  return await new Promise<WebTransportResponse>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      reject(error);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname,
      // Node 22 may enable Happy Eyeballs when family is left at 0 and call a
      // custom lookup with `{ all: true }`.  This transport intentionally
      // pins one already-validated address, so advertise that address family
      // explicitly instead of letting the client reinterpret our one-result
      // lookup as an all-address lookup.
      family: pinned.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      lookup,
      servername: url.protocol === "https:" ? url.hostname : undefined,
      headers: {
        accept: options.accept
          // 越来越多文档站为 AI/reader 提供无脚本 Markdown negotiation。优先它可
          // 显著减少 JS shell、导航噪声和流量；不支持的站点仍按标准 q 值返回 HTML。
          ?? "text/markdown, text/html;q=0.95, application/xhtml+xml;q=0.9, " +
            "application/pdf;q=0.85, text/plain;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        // 使用普通只读浏览器 UA 提高文档站/CDN 兼容性，同时保留产品标识。绝不发送
        // 用户浏览器 cookie、Authorization、Referer 或其它会话 header。
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 OntoCopilot-WebPreview/1.1",
      },
    }, (response) => {
      const headers = responseHeaders(response.headers);
      const responseLimit = declaredMediaType(headers) === "application/pdf"
        ? Math.max(options.maxBytes, options.pdfMaxBytes ?? options.maxBytes)
        : options.maxBytes;
      const declared = Number(headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > responseLimit) {
        response.destroy();
        finishError(new WebPreviewError("too_large", `资源超过 ${responseLimit} 字节限制`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > responseLimit) {
          response.destroy(new WebPreviewError("too_large", `资源超过 ${responseLimit} 字节限制`));
          return;
        }
        chunks.push(bytes);
      });
      response.on("error", finishError);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        resolve({
          status: response.statusCode ?? 0,
          headers,
          body: Uint8Array.from(Buffer.concat(chunks)),
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new WebPreviewError("timeout", "网页读取超时"));
    });
    // setTimeout 是“socket 空闲超时”，持续滴一字节可以永不触发；另设墙钟硬截止。
    deadline = setTimeout(() => {
      request.destroy(new WebPreviewError("timeout", "网页读取超时"));
    }, timeoutMs);
    if (settled) clearTimeout(deadline);
    request.on("error", (error) => {
      finishError(error instanceof WebPreviewError
        ? error
        : new WebPreviewError("fetch_failed", "网页读取失败", { cause: error }));
    });
    request.end();
  });
}

/**
 * 默认 transport：每次连接仍钉在已经验过的 IP 上，Host/SNI 保留原公网域名。
 * DNS 返回多个公网地址时在同一个总 deadline 内依次尝试，避免第一个坏 IPv6/CDN
 * 节点让整页失败；绝不会在这里重新解析 DNS 或尝试未校验地址。
 */
export const pinnedNodeWebTransport: WebPreviewTransport = async (url, options) => {
  if (options.addresses.length === 0) {
    throw new WebPreviewError("dns_failed", "域名没有可用的公网地址");
  }
  const startedAt = Date.now();
  let lastError: unknown;
  for (let index = 0; index < options.addresses.length; index += 1) {
    const pinned = options.addresses[index];
    if (!pinned) continue;
    const elapsed = Date.now() - startedAt;
    const remaining = options.timeoutMs - elapsed;
    if (remaining <= 0) break;
    const attemptsLeft = options.addresses.length - index;
    // 前面的坏地址只占等份窗口，最后一个地址可使用全部剩余时间。
    const attemptTimeout = attemptsLeft === 1
      ? remaining
      : Math.max(250, Math.floor(remaining / attemptsLeft));
    try {
      return await requestPinnedAddress(url, options, pinned, attemptTimeout);
    } catch (error) {
      lastError = error;
      // 内容/大小问题与地址无关，换 IP 不能修复，也不应重复下载。
      if (error instanceof WebPreviewError
        && ["too_large", "unsupported_content_encoding", "invalid_content_encoding"].includes(error.code)) {
        throw error;
      }
    }
  }
  if (Date.now() - startedAt >= options.timeoutMs) {
    throw new WebPreviewError("timeout", "网页读取超时", {
      cause: lastError instanceof Error ? lastError : undefined,
    });
  }
  throw lastError instanceof WebPreviewError
    ? lastError
    : new WebPreviewError("fetch_failed", "所有公网地址均无法连接", {
      cause: lastError instanceof Error ? lastError : undefined,
    });
};

function blockedSnapshot(requested: string, reason: string, code: string, now: number): WebPageSnapshot {
  let normalized = requested.trim();
  try { normalized = new URL(normalized).toString(); } catch { /* 保留用户输入供界面解释 */ }
  return {
    schemaVersion: WEB_PAGE_SCHEMA_VERSION,
    id: pageId(normalized || requested, `blocked:${code}`),
    url: normalized,
    finalUrl: "",
    title: normalized || "无法打开的网页",
    status: "blocked",
    fetchedAt: new Date(now).toISOString(),
    digest: "",
    contentType: "",
    byteLength: 0,
    paragraphs: [],
    citations: [],
    embed: { allowed: false, reason },
    blockedReason: code,
    untrusted: true,
  };
}

interface ReaderAlternative {
  readonly fetchUrl: URL;
  readonly displayUrl: URL;
  readonly accept: string;
  readonly mediaType: "text/markdown";
}

function githubReadmeAlternative(url: URL): ReaderAlternative | undefined {
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  // 只将仓库首页映射到官方只读 README API；issues/settings/blob 等页面语义不同，
  // 不能悄悄拿 README 冒充用户打开的页面。
  if (parts.length !== 2) return undefined;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(parts[0] ?? "");
    repo = decodeURIComponent(parts[1] ?? "").replace(/\.git$/iu, "");
  } catch {
    return undefined;
  }
  if (!/^[a-z0-9_.-]{1,100}$/iu.test(owner) || !/^[a-z0-9_.-]{1,100}$/iu.test(repo)) {
    return undefined;
  }
  return {
    fetchUrl: new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`),
    displayUrl: url,
    accept: "application/vnd.github.raw+json, text/markdown;q=0.9, text/plain;q=0.8",
    mediaType: "text/markdown",
  };
}

function fallbackEligible(error: unknown): boolean {
  if (!(error instanceof WebPreviewError)) return true;
  return [
    "timeout",
    "fetch_failed",
    "dns_failed",
    "too_large",
    "empty_page",
    "access_denied",
    "rate_limited",
    "upstream_unavailable",
    "unsupported_content_type",
    "unsupported_content_encoding",
    "invalid_content_encoding",
  ].includes(error.code);
}

function cloneOpenResult(result: WebPreviewOpenResult): WebPreviewOpenResult {
  return {
    page: structuredClone(result.page),
    ...(result.resourceBytes !== undefined
      ? { resourceBytes: new Uint8Array(result.resourceBytes) }
      : {}),
  };
}

export class WebPreviewService {
  readonly #resolver: WebHostResolver;
  readonly #transport: WebPreviewTransport;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #pdfTimeoutMs: number;
  readonly #maxBytes: number;
  readonly #pdfMaxBytes: number;
  readonly #maxRedirects: number;
  readonly #pdfMaxPages: number;
  readonly #pdfTextExtractor: NonNullable<WebPreviewServiceOptions["pdfTextExtractor"]>;
  readonly #cacheTtlMs: number;
  readonly #cacheCap: number;
  readonly #cache = new Map<string, { readonly expiresAt: number; readonly result: WebPreviewOpenResult }>();

  constructor(options: WebPreviewServiceOptions = {}) {
    this.#resolver = options.resolver ?? defaultWebHostResolver;
    this.#transport = options.transport ?? pinnedNodeWebTransport;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? WEB_PAGE_TIMEOUT_MS);
    this.#pdfTimeoutMs = Math.max(
      this.#timeoutMs,
      options.pdfTimeoutMs
        ?? (options.timeoutMs === undefined ? WEB_PDF_TIMEOUT_MS : this.#timeoutMs),
    );
    this.#maxBytes = Math.max(1, options.maxBytes ?? WEB_PAGE_MAX_BYTES);
    this.#pdfMaxBytes = Math.max(this.#maxBytes, options.pdfMaxBytes ?? WEB_PDF_MAX_BYTES);
    this.#maxRedirects = Math.max(0, options.maxRedirects ?? WEB_PAGE_MAX_REDIRECTS);
    this.#pdfMaxPages = Math.max(1, Math.trunc(options.pdfMaxPages ?? WEB_PDF_MAX_PAGES));
    this.#pdfTextExtractor = options.pdfTextExtractor ?? pdfToTextPages;
    this.#cacheTtlMs = Math.max(0, Math.trunc(options.cacheTtlMs ?? WEB_PREVIEW_CACHE_TTL_MS));
    this.#cacheCap = Math.max(0, Math.trunc(options.cacheCap ?? WEB_PREVIEW_CACHE_CAP));
  }

  async open(rawUrl: string): Promise<WebPageSnapshot> {
    return (await this.openWithResource(rawUrl)).page;
  }

  /**
   * route 使用这个入口拿到 PDF 原始字节并立刻落到会话私有目录。公开领域 snapshot
   * 只存 digest/文本/元数据，绝不把多 MB base64 塞进 session JSON。
   */
  async openWithResource(rawUrl: string): Promise<WebPreviewOpenResult> {
    const requested = publicWebUrl(rawUrl);
    if (!requested) return {
      page: blockedSnapshot(rawUrl, "只允许普通公网 HTTP/HTTPS 网页", "invalid_or_private_url", this.#now()),
    };
    const original = requested.toString();
    const cached = this.#cache.get(original);
    if (cached && cached.expiresAt > Date.now()) {
      // Map insertion order doubles as a bounded LRU; cache never stores blocked pages or PDF bytes.
      this.#cache.delete(original);
      this.#cache.set(original, cached);
      return cloneOpenResult(cached.result);
    }
    if (cached) this.#cache.delete(original);
    const alternative = githubReadmeAlternative(requested);
    try {
      let opened: WebPreviewOpenResult;
      try {
        opened = await this.#openFrom(original, requested, {
          timeoutMs: alternative
            ? Math.min(this.#timeoutMs, WEB_GITHUB_PRIMARY_TIMEOUT_MS)
            : this.#likelyPdfUrl(requested) ? this.#pdfTimeoutMs : this.#timeoutMs,
        });
      } catch (primaryError) {
        if (!alternative || !fallbackEligible(primaryError)) throw primaryError;
        try {
          opened = await this.#openFrom(original, alternative.fetchUrl, {
            timeoutMs: this.#timeoutMs,
            accept: alternative.accept,
            displayUrl: alternative.displayUrl,
            mediaType: alternative.mediaType,
          });
        } catch (fallbackError) {
          const fallbackCode = fallbackError instanceof WebPreviewError
            ? fallbackError.code
            : "fetch_failed";
          const primaryReason = primaryError instanceof Error ? primaryError.message : "网页入口读取失败";
          const fallbackReason = fallbackError instanceof Error ? fallbackError.message : "安全阅读源读取失败";
          throw new WebPreviewError(
            fallbackCode,
            `网页入口不可达（${clipped(primaryReason, 180)}）；官方安全阅读源也失败（${clipped(fallbackReason, 180)}）`,
            { cause: fallbackError instanceof Error ? fallbackError : undefined },
          );
        }
      }
      if (this.#cacheTtlMs > 0 && this.#cacheCap > 0
        && opened.page.status !== "blocked" && opened.page.resource?.kind !== "pdf") {
        this.#cache.delete(original);
        this.#cache.set(original, {
          expiresAt: Date.now() + this.#cacheTtlMs,
          result: cloneOpenResult(opened),
        });
        while (this.#cache.size > this.#cacheCap) {
          const oldest = this.#cache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#cache.delete(oldest);
        }
      }
      return opened;
    } catch (error) {
      const code = error instanceof WebPreviewError ? error.code : "fetch_failed";
      const reason = error instanceof Error ? error.message : "网页读取失败";
      return { page: blockedSnapshot(original, reason, code, this.#now()) };
    }
  }

  #likelyPdfUrl(url: URL): boolean {
    const path = url.pathname.toLowerCase();
    return path.endsWith(".pdf") || path.startsWith("/pdf/")
      || url.searchParams.get("format")?.toLowerCase() === "pdf";
  }

  async #openFrom(
    original: string,
    start: URL,
    options: {
      readonly timeoutMs: number;
      readonly accept?: string;
      readonly displayUrl?: URL;
      readonly mediaType?: string;
    },
  ): Promise<WebPreviewOpenResult> {
    let current = start;
    const startedAt = Date.now();
    for (let redirects = 0; redirects <= this.#maxRedirects; redirects += 1) {
      const elapsed = Date.now() - startedAt;
      const remaining = options.timeoutMs - elapsed;
      if (remaining <= 0) throw new WebPreviewError("timeout", "网页读取超时");
      const addresses = await this.#resolvePublic(current);
      const response = await this.#transport(current, {
        addresses,
        timeoutMs: remaining,
        maxBytes: this.#maxBytes,
        pdfMaxBytes: this.#pdfMaxBytes,
        ...(options.accept ? { accept: options.accept } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= this.#maxRedirects) {
          throw new WebPreviewError("redirect_limit", "网页重定向次数过多");
        }
        const location = response.headers.get("location");
        if (!location) throw new WebPreviewError("redirect_missing", "网页重定向缺少目标地址");
        const next = publicWebUrl(new URL(location, current).toString());
        if (!next) throw new WebPreviewError("redirect_blocked", "网页重定向到了非公网地址");
        current = next;
        continue;
      }
      return await this.#snapshot(original, current, response, {
        ...(options.displayUrl ? { displayUrl: options.displayUrl } : {}),
        ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      });
    }
    throw new WebPreviewError("redirect_limit", "网页重定向次数过多");
  }

  async #resolvePublic(url: URL): Promise<readonly ResolvedAddress[]> {
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolver(url.hostname);
    } catch (error) {
      throw new WebPreviewError("dns_failed", "域名解析失败", { cause: error });
    }
    if (addresses.length === 0) throw new WebPreviewError("dns_failed", "域名没有可用地址");
    // 多地址主机只要混入一个内网/保留地址就整页拒绝；不能让轮询顺序决定是否越界。
    if (addresses.some((item) => !publicResolvedAddress(item.address))) {
      throw new WebPreviewError("private_address", "域名解析到了私网或保留地址");
    }
    return addresses;
  }

  async #snapshot(
    original: string,
    final: URL,
    response: WebTransportResponse,
    options: { readonly displayUrl?: URL; readonly mediaType?: string } = {},
  ): Promise<WebPreviewOpenResult> {
    if (response.status < 200 || response.status >= 300) {
      const retryAfter = clipped(response.headers.get("retry-after") ?? "", 80);
      const suffix = retryAfter ? `；Retry-After: ${retryAfter}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new WebPreviewError("access_denied", `站点拒绝服务器读取（HTTP ${response.status}）`);
      }
      if (response.status === 429) {
        throw new WebPreviewError("rate_limited", `站点请求频率受限（HTTP 429）${suffix}`);
      }
      if (response.status === 404 || response.status === 410) {
        throw new WebPreviewError("not_found", `网页不存在或已经删除（HTTP ${response.status}）`);
      }
      if (response.status >= 500) {
        throw new WebPreviewError(
          "upstream_unavailable",
          `站点暂时不可用（HTTP ${response.status}）${suffix}`,
        );
      }
      throw new WebPreviewError("http_status", `网页返回 HTTP ${response.status}`);
    }
    const declaredType = declaredMediaType(response.headers);
    if (options.mediaType && declaredType
      && !["text/plain", "text/markdown", "application/octet-stream"].includes(declaredType)
      && !declaredType.startsWith("application/vnd.github.raw")) {
      throw new WebPreviewError(
        "unsupported_content_type",
        `官方安全阅读源返回了非文本类型：${declaredType}`,
      );
    }
    const encodedLimit = declaredType === "application/pdf" ? this.#pdfMaxBytes : this.#maxBytes;
    if (response.body.byteLength > encodedLimit) {
      throw new WebPreviewError("too_large", `压缩资源超过 ${encodedLimit} 字节限制`);
    }
    const body = decodedBody(response.headers, response.body, encodedLimit);
    const normalizedHeaders = new Headers(response.headers);
    normalizedHeaders.delete("content-encoding");
    normalizedHeaders.delete("content-length");
    if (options.mediaType) normalizedHeaders.set("content-type", `${options.mediaType}; charset=utf-8`);
    const type = contentType(normalizedHeaders, body);
    // 只有上游明确声明 application/pdf 才能使用较大的 PDF 下载额度；签名 sniff
    // 纠正的缺/错 header 仍受 1.5MB 网页额度约束，不能借 sniff 扩大下载面。
    const limit = type.mediaType === "application/pdf"
      && declaredType === "application/pdf"
      ? this.#pdfMaxBytes
      : this.#maxBytes;
    if (body.byteLength > limit) {
      throw new WebPreviewError("too_large", `资源超过 ${limit} 字节限制`);
    }
    if (type.mediaType === "application/pdf") {
      return await this.#pdfSnapshot(original, final, {
        ...response,
        headers: normalizedHeaders,
        body,
      });
    }
    if (!ALLOWED_CONTENT_TYPES.has(type.mediaType)) {
      throw new WebPreviewError("unsupported_content_type", `不支持的网页类型：${type.mediaType || "unknown"}`);
    }
    const raw = decodeBody(body, type.charset);
    const html = type.mediaType === "text/html" || type.mediaType === "application/xhtml+xml";
    const digest = sha(body);
    const id = pageId(original, digest);
    const displayUrl = options.displayUrl ?? final;
    const title = html ? htmlTitle(raw, displayUrl.hostname) : titleFromText(raw, displayUrl.hostname);
    const values = boundedParagraphs(html ? extractHtmlParagraphs(raw) : textParagraphs(raw));
    if (values.length === 0) throw new WebPreviewError("empty_page", "网页没有可读取的正文");
    const citations: WebPageCitation[] = values.map((text, index) => ({
      citationId: `${id}@${digest.slice(0, 12)}:p${index + 1}`,
      index,
      text,
      url: displayUrl.toString(),
      title,
    }));
    const embed = html
      ? embedPolicy(normalizedHeaders, raw, displayUrl.toString())
      : { allowed: false, reason: "纯文本快照不可作为网页嵌入" };
    return { page: {
      schemaVersion: WEB_PAGE_SCHEMA_VERSION,
      id,
      url: original,
      finalUrl: displayUrl.toString(),
      title,
      status: embed.allowed ? "live" : "snapshot",
      fetchedAt: new Date(this.#now()).toISOString(),
      digest,
      contentType: type.mediaType,
      byteLength: body.byteLength,
      paragraphs: citations.map(({ citationId, index, text }) => ({ citationId, index, text })),
      citations,
      embed,
      httpStatus: response.status,
      untrusted: true,
    } };
  }

  async #pdfSnapshot(
    original: string,
    final: URL,
    response: WebTransportResponse,
  ): Promise<WebPreviewOpenResult> {
    if (!pdfSignature(response.body)) {
      throw new WebPreviewError("invalid_pdf", "服务器声明为 PDF，但文件签名无效");
    }
    const digest = sha(response.body);
    const id = pageId(original, digest);
    const filename = safePdfFilename(response.headers, final);
    let paragraphs: WebPageParagraph[] = [];
    let extractedPages = 0;
    let textPages = 0;
    let totalPages: number | undefined;
    let truncated = false;
    let textStatus: WebPdfResource["textStatus"] = "unavailable";
    let reason = "PDF 没有可读取的文本层；可以预览原文件，但总结前需要 OCR。";
    try {
      const parsed = await this.#pdfTextExtractor(new Uint8Array(response.body), {
        maxPages: this.#pdfMaxPages,
      });
      extractedPages = parsed.pages.length;
      totalPages = parsed.totalPages;
      truncated = parsed.truncated;
      const values: Array<{ text: string; pageNumber: number }> = [];
      for (const page of parsed.pages) {
        const blocks = textParagraphs(page.text);
        if (blocks.length > 0) textPages += 1;
        for (const value of blocks) values.push({ text: value, pageNumber: page.page });
      }
      const bounded = boundedParagraphs(values.map((value) => value.text));
      paragraphs = bounded.map((value, index) => ({
        citationId: `${id}@${digest.slice(0, 12)}:pdf${values[index]?.pageNumber ?? index + 1}-${index + 1}`,
        // PDF 的证据定位首先是页码；同页拆成多个文本块时 index 可以重复，但
        // pageNumber + citationId 仍唯一且可回到原页。
        index: Math.max(0, (values[index]?.pageNumber ?? index + 1) - 1),
        text: value,
        pageNumber: values[index]?.pageNumber ?? index + 1,
      }));
      if (paragraphs.length > 0) {
        const missingTextPages = parsed.pages.length - textPages;
        textStatus = parsed.truncated || missingTextPages > 0 ? "partial" : "available";
        reason = parsed.truncated
          ? `PDF 共 ${parsed.totalPages} 页；安全阅读快照只提取前 ${parsed.pages.length} 页。`
          : missingTextPages > 0
            ? `${missingTextPages} 页没有可读取的文本层；这些页面可能是扫描件。`
            : "";
      }
    } catch {
      // 原始字节已通过签名与大小校验，文本层损坏不应让本地 PDF 预览一起消失。
      reason = "PDF 可预览，但文本层读取失败；当前不能翻译或总结。";
    }
    const citations: WebPageCitation[] = paragraphs.map((paragraph) => ({
      ...paragraph,
      url: final.toString(),
      title: filename,
    }));
    const resource: WebPdfResource = {
      kind: "pdf",
      mimeType: "application/pdf",
      filename,
      byteLength: response.body.byteLength,
      textStatus,
      extractedPages,
      textPages,
      ...(totalPages !== undefined ? { totalPages } : {}),
      truncated,
      ...(reason ? { reason } : {}),
    };
    return {
      page: {
        schemaVersion: WEB_PAGE_SCHEMA_VERSION,
        id,
        url: original,
        finalUrl: final.toString(),
        title: filename,
        status: "snapshot",
        fetchedAt: new Date(this.#now()).toISOString(),
        digest,
        contentType: "application/pdf",
        byteLength: response.body.byteLength,
        paragraphs,
        citations,
        embed: { allowed: false, reason: "PDF 使用同源的不可变安全快照预览" },
        resource,
        httpStatus: response.status,
        untrusted: true,
      },
      resourceBytes: new Uint8Array(response.body),
    };
  }
}
