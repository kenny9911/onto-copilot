/**
 * Immutable, bounded text snapshots extracted from the already-rendered Live Browser page.
 *
 * The Chromium side is allowed to return only plain strings/numbers.  This module applies a
 * second, server-side normalization pass and turns those values into the same WebPageSnapshot
 * contract used by summaries, citations, AssetMemory and restart recovery.  Raw HTML, scripts,
 * attributes, cookies and storage never cross this boundary.
 */

import { createHash } from "node:crypto";

import {
  WEB_PAGE_SCHEMA_VERSION,
  type WebPageCitation,
  type WebPageParagraph,
  type WebPageSnapshot,
} from "./web_preview.js";

export const LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION = "ontocopilot.live-browser-text/1" as const;
export const LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS = 120;
export const LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS = 60_000;
export const LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPH_CHARS = 4_000;
export const LIVE_BROWSER_SNAPSHOT_MAX_TITLE_CHARS = 240;

export interface LiveBrowserRawParagraph {
  readonly text: string;
  /** Stable only inside this extraction; it deliberately is not a CSS selector. */
  readonly ordinal: number;
  readonly y?: number;
}

export interface LiveBrowserRawDocument {
  readonly schemaVersion: typeof LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION;
  readonly browserSessionId: string;
  readonly seq: number;
  readonly url: string;
  readonly title: string;
  readonly paragraphs: readonly LiveBrowserRawParagraph[];
  readonly capturedAt: string;
}

export interface LiveBrowserParagraphLocator {
  readonly kind: "live-dom-ordinal";
  readonly browserSessionId: string;
  readonly seq: number;
  readonly ordinal: number;
  readonly y?: number;
}

export interface LiveBrowserSnapshotParagraph extends WebPageParagraph {
  readonly liveLocator: LiveBrowserParagraphLocator;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: unknown, max: number): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[\t\r ]+/gu, " ")
    .replace(/ *\n+ */gu, "\n")
    .trim();
  const points = [...normalized];
  return points.length <= max ? normalized : points.slice(0, max).join("");
}

function publicHttpUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("Live Browser 正文快照没有有效的当前 URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Live Browser 正文快照只接受无凭证的 http(s) 当前 URL");
  }
  return url.toString();
}

/**
 * Normalize twice (inside Chromium and here), deduplicate adjacent/identical boilerplate, and
 * enforce both paragraph and total-code-point ceilings before any value reaches session state.
 */
export function boundedLiveBrowserParagraphs(
  rows: readonly LiveBrowserRawParagraph[],
): Array<{ text: string; ordinal: number; y?: number }> {
  const out: Array<{ text: string; ordinal: number; y?: number }> = [];
  const seen = new Set<string>();
  let used = 0;
  for (const [fallbackOrdinal, row] of rows.entries()) {
    if (out.length >= LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS
      || used >= LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS) break;
    let value = clean(row?.text, LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPH_CHARS);
    if (!value || seen.has(value)) continue;
    const remaining = LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS - used;
    if ([...value].length > remaining) value = [...value].slice(0, remaining).join("");
    if (!value) break;
    seen.add(value);
    const ordinal = Number.isSafeInteger(row?.ordinal) && row.ordinal >= 0
      ? row.ordinal
      : fallbackOrdinal;
    const rawY = Number(row?.y);
    out.push({
      text: value,
      ordinal,
      ...(Number.isFinite(rawY) ? { y: Math.max(0, Math.round(rawY)) } : {}),
    });
    used += [...value].length;
  }
  return out;
}

/** Build the immutable WebPreview snapshot consumed by the existing summary pipeline. */
export function liveBrowserDocumentPage(document: LiveBrowserRawDocument): WebPageSnapshot {
  const url = publicHttpUrl(document.url);
  const title = clean(document.title, LIVE_BROWSER_SNAPSHOT_MAX_TITLE_CHARS)
    || new URL(url).hostname;
  const rows = boundedLiveBrowserParagraphs(document.paragraphs);
  if (rows.length === 0) throw new Error("当前网页没有可总结的可见正文");

  // Only normalized evidence is versioned. Browser/tab identity and seq bind the capture request,
  // but must not make identical visible content produce duplicate immutable page versions.
  const digest = sha(JSON.stringify({ url, title, paragraphs: rows.map((row) => row.text) }));
  const id = `page_${sha(`${url}\u0000${digest}`).slice(0, 24)}`;
  const paragraphs: LiveBrowserSnapshotParagraph[] = rows.map((row, index) => {
    const citationId = `web:${id}:p${index + 1}`;
    return {
      citationId,
      index,
      text: row.text,
      liveLocator: {
        kind: "live-dom-ordinal",
        browserSessionId: document.browserSessionId,
        seq: document.seq,
        ordinal: row.ordinal,
        ...(row.y !== undefined ? { y: row.y } : {}),
      },
    };
  });
  const citations: WebPageCitation[] = paragraphs.map((paragraph) => ({
    citationId: paragraph.citationId,
    index: paragraph.index,
    text: paragraph.text,
    url,
    title,
  }));
  const byteLength = Buffer.byteLength(rows.map((row) => row.text).join("\n\n"), "utf8");
  return {
    schemaVersion: WEB_PAGE_SCHEMA_VERSION,
    id,
    url,
    finalUrl: url,
    title,
    status: "snapshot",
    fetchedAt: document.capturedAt,
    digest,
    contentType: "text/plain; source=live-dom",
    byteLength,
    paragraphs,
    citations,
    embed: { allowed: false, reason: "Live Browser 可见正文的不可变安全快照" },
    untrusted: true,
  };
}
