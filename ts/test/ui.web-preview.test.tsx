// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WebPreviewBase, {
  WEB_PREVIEW_API,
  LIVE_BROWSER_API,
  WEB_PREVIEW_HISTORY_MAX_BYTES,
  WEB_PREVIEW_HISTORY_MAX_ENTRIES,
  createWebPreviewHttpClient,
  createLiveBrowserHttpClient,
  normalizeLiveBrowserFrameUrl,
  normalizePdfPreviewUrl,
  normalizeSafeWebUrl,
  normalizeWebPreviewHistoryState,
  pageChatPayload,
  summaryChatPayload,
  type WebPreviewClient,
  type LiveBrowserClient,
  type LiveBrowserFrame,
  type WebPreviewHistoryState,
  type WebPreviewMaterialReceipt,
  type WebPreviewPage,
  type WebPreviewProps,
  type WebPreviewSummary,
  type WebPreviewTarget,
} from "../src/ui/react/web-preview.js";

/** Most legacy assertions target Reader details explicitly; opt them into Reader while the product default is Live. */
function WebPreview(props: WebPreviewProps) {
  return <WebPreviewBase initialSurface="reader" {...props} />;
}

const PAGE: WebPreviewPage = {
  id: "page-1",
  url: "https://help.sap.com/purchase",
  finalUrl: "https://help.sap.com/purchase",
  title: "Manage Purchase Requisitions",
  status: "snapshot",
  fetchedAt: "2026-08-28T14:32:00.000Z",
  digest: "sha256:page-v1",
  contentType: "text/html",
  language: "en",
  siteName: "SAP Help Portal",
  embed: { allowed: false, reason: "X-Frame-Options blocks embedding" },
  paragraphs: [
    { id: "p-1", heading: "Approval Process", level: 2, text: "Create and submit a purchase requisition.", citationIds: ["cite-1"] },
    { id: "p-2", heading: "Budget Availability", level: 2, text: "Unavailable budget can block submission.", citationIds: ["cite-2"] },
  ],
  citations: [
    { id: "cite-1", label: "Approval Process", paragraphIds: ["p-1"] },
    { id: "cite-2", label: "Budget Availability", paragraphIds: ["p-2"] },
  ],
};

const TRANSLATED_PAGE: WebPreviewPage = {
  ...PAGE,
  paragraphs: [
    { ...PAGE.paragraphs[0]!, translatedText: "创建并提交采购申请。" },
    { ...PAGE.paragraphs[1]!, translatedText: "预算不足可能阻止提交。" },
  ],
};

const PAGE_B: WebPreviewPage = {
  ...PAGE,
  id: "page-2",
  url: "https://example.com/policy",
  finalUrl: "https://example.com/policy",
  title: "Purchase Policy",
  digest: "sha256:page-v2",
  paragraphs: [{ id: "p-b", text: "Policy B", citationIds: ["cite-b"] }],
  citations: [{ id: "cite-b", label: "Policy B", paragraphIds: ["p-b"] }],
};

const BLOCKED_PAGE: WebPreviewPage = {
  ...PAGE,
  id: "page-blocked",
  finalUrl: "",
  title: "https://help.sap.com/protected",
  status: "blocked",
  digest: "",
  contentType: "",
  blockedReason: "http_status",
  embed: { allowed: false, reason: "网页返回 HTTP 403" },
  paragraphs: [],
  citations: [],
};

const PDF_PAGE: WebPreviewPage = {
  ...PAGE,
  id: "page-pdf",
  url: "https://example.com/policy.pdf",
  finalUrl: "https://example.com/policy.pdf",
  title: "Purchase Policy.pdf",
  digest: "sha256:pdf-v1",
  contentType: "application/pdf",
  resource: {
    kind: "pdf", mimeType: "application/pdf", filename: "Purchase Policy.pdf", textStatus: "available",
    extractedPages: 8, totalPages: 8, truncated: false,
    previewUrl: "/api/sessions/s-1/web/pages/page-pdf/content",
  },
};

const PDF_NO_TEXT: WebPreviewPage = {
  ...PDF_PAGE,
  id: "page-pdf-scan",
  digest: "sha256:pdf-scan",
  paragraphs: [],
  citations: [],
  resource: {
    kind: "pdf", mimeType: "application/pdf", filename: "Scan.pdf", textStatus: "unavailable",
    extractedPages: 0, totalPages: 3, truncated: false, reason: "扫描件没有可提取文字",
    previewUrl: "/api/sessions/s-1/web/pages/page-pdf-scan/content",
  },
};

const SUMMARY: WebPreviewSummary = {
  id: "summary-1",
  basedOn: { pageId: PAGE.id, digest: PAGE.digest, fetchedAt: PAGE.fetchedAt },
  basedOnDigest: PAGE.digest,
  generatedAt: "2026-08-28T14:34:00.000Z",
  language: "zh-CN",
  bullets: [
    { id: "b-1", text: "采购申请需要提交审批。", citationIds: ["cite-1"] },
    { id: "b-2", text: "预算不足时系统可能阻止提交。", citationIds: ["cite-2"] },
  ],
};

const RECEIPT: WebPreviewMaterialReceipt = {
  id: "material-1", name: "SAP · Manage Purchase Requisitions", savedAt: "2026-08-28T14:35:00.000Z",
  pageId: PAGE.id, digest: PAGE.digest,
};

const LIVE_BROWSER_ID = "browser_0123456789abcdef01234567";
const LIVE_FRAME: LiveBrowserFrame = {
  browserSessionId: LIVE_BROWSER_ID,
  url: PAGE.url,
  title: PAGE.title,
  frameUrl: `/api/sessions/s-1/live-browser/sessions/${LIVE_BROWSER_ID}/frame?seq=1`,
  width: 1280,
  height: 720,
  seq: 1,
  canGoBack: true,
  canGoForward: false,
  loading: false,
  updatedAt: "2026-08-31T14:00:00.000Z",
};

function fakeClient(patch: Partial<WebPreviewClient> = {}): WebPreviewClient {
  return {
    open: async () => PAGE,
    snapshotLive: async () => PAGE,
    get: async () => PAGE,
    translate: async () => TRANSLATED_PAGE,
    summarize: async () => SUMMARY,
    save: async () => RECEIPT,
    ...patch,
  };
}

function fakeLiveClient(patch: Partial<LiveBrowserClient> = {}): LiveBrowserClient {
  return {
    capabilities: async () => ({ available: true, features: ["pointer", "scroll", "key"] }),
    open: async () => LIVE_FRAME,
    get: async () => LIVE_FRAME,
    navigate: async () => LIVE_FRAME,
    back: async () => LIVE_FRAME,
    forward: async () => LIVE_FRAME,
    reload: async () => LIVE_FRAME,
    screenshot: async () => LIVE_FRAME,
    pointer: async () => LIVE_FRAME,
    scroll: async () => LIVE_FRAME,
    key: async () => LIVE_FRAME,
    close: async () => undefined,
    ...patch,
  };
}

function liveFrameAt(seq: number, patch: Partial<LiveBrowserFrame> = {}): LiveBrowserFrame {
  return {
    ...LIVE_FRAME,
    seq,
    frameUrl: `/api/sessions/s-1/live-browser/sessions/${LIVE_BROWSER_ID}/frame?seq=${seq}`,
    ...patch,
  };
}

function httpResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  document.body.innerHTML = '<textarea id="cin"></textarea>';
  const happy = (window as any).happyDOM;
  if (happy?.settings) happy.settings.disableIframePageLoading = true;
  const ElementCtor = (globalThis as any).HTMLElement;
  Object.defineProperty(ElementCtor.prototype, "scrollIntoView", {
    configurable: true, value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Web Preview HTTP contract", () => {
  it("uses the agreed session-scoped page, translate, summarize and save routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const payloads: unknown[] = [
      { page: PAGE }, { page: PAGE_B }, { page: PAGE }, { page: TRANSLATED_PAGE }, { summary: SUMMARY }, { material: RECEIPT },
    ];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return httpResponse(payloads.shift());
    });
    const client = createWebPreviewHttpClient({ baseUrl: "https://onto.local/", fetchImpl });

    await client.open({ sessionId: "s/1", url: PAGE.url });
    await client.snapshotLive({
      sessionId: "s/1", browserSessionId: LIVE_BROWSER_ID, seq: 2, url: PAGE_B.url,
    });
    await client.get({ sessionId: "s/1", pageId: PAGE.id });
    await client.translate({ sessionId: "s/1", pageId: PAGE.id, mode: "bilingual" });
    await client.summarize({ sessionId: "s/1", pageId: PAGE.id, language: "zh-CN", focus: "预算" });
    await client.save({ sessionId: "s/1", pageId: PAGE.id });

    expect(calls.map((call) => call.url)).toEqual([
      "https://onto.local/api/sessions/s%2F1/web/pages",
      "https://onto.local/api/sessions/s%2F1/web/live-snapshots",
      "https://onto.local/api/sessions/s%2F1/web/pages/page-1",
      "https://onto.local/api/sessions/s%2F1/web/pages/page-1/translate",
      "https://onto.local/api/sessions/s%2F1/web/pages/page-1/summarize",
      "https://onto.local/api/sessions/s%2F1/web/pages/page-1/save",
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: PAGE.url });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      browserSessionId: LIVE_BROWSER_ID, seq: 2, url: PAGE_B.url,
    });
    expect(calls[2]!.init.method).toBe("GET");
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ mode: "bilingual" });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ language: "zh-CN", focus: "预算" });
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({});
  });

  it("keeps API path construction stable and encodes identifiers", () => {
    expect(WEB_PREVIEW_API.translate("会话/1", "page?#1"))
      .toBe("/api/sessions/%E4%BC%9A%E8%AF%9D%2F1/web/pages/page%3F%231/translate");
  });

  it("uses the isolated live-browser routes and accepts only same-origin frame images", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const httpFrame: LiveBrowserFrame = {
      ...LIVE_FRAME,
      frameUrl: `/api/sessions/s%2F1/live-browser/sessions/${LIVE_BROWSER_ID}/frame?seq=1`,
    };
    const payloads: unknown[] = [
      { capabilities: { available: true, features: ["pointer"] } },
      { browser: httpFrame },
      { browser: httpFrame },
      {},
    ];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return httpResponse(payloads.shift(), init.method === "DELETE" ? 204 : 200);
    });
    const client = createLiveBrowserHttpClient({ baseUrl: "https://onto.local", fetchImpl });
    await client.capabilities({ sessionId: "s/1" });
    await client.open({ sessionId: "s/1", url: PAGE.url, viewport: { width: 1280, height: 720 } });
    await client.pointer({ sessionId: "s/1", browserSessionId: LIVE_BROWSER_ID, x: 50, y: 60, action: "click" });
    await client.close({ sessionId: "s/1", browserSessionId: LIVE_BROWSER_ID });

    expect(calls.map((call) => call.url)).toEqual([
      "https://onto.local/api/sessions/s%2F1/live-browser/capabilities",
      "https://onto.local/api/sessions/s%2F1/live-browser/sessions",
      `https://onto.local/api/sessions/s%2F1/live-browser/sessions/${LIVE_BROWSER_ID}/pointer`,
      `https://onto.local/api/sessions/s%2F1/live-browser/sessions/${LIVE_BROWSER_ID}`,
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      url: PAGE.url, viewport: { width: 1280, height: 720 },
    });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ x: 50, y: 60, action: "click" });
    expect(calls[3]!.init.method).toBe("DELETE");
    expect(calls[3]!.init.keepalive).toBe(true);
    expect(LIVE_BROWSER_API.session("s/1", LIVE_BROWSER_ID))
      .toBe(`/api/sessions/s%2F1/live-browser/sessions/${LIVE_BROWSER_ID}`);
    expect(normalizeLiveBrowserFrameUrl(LIVE_FRAME.frameUrl)).toBe(LIVE_FRAME.frameUrl);
    expect(normalizeLiveBrowserFrameUrl("https://help.sap.com/frame.png")).toBeNull();
  });

  it("rejects a same-origin frame that belongs to another session or has a mismatched sequence", async () => {
    const wrongSession = createLiveBrowserHttpClient({
      fetchImpl: async () => httpResponse({ browser: {
        ...LIVE_FRAME,
        frameUrl: `/api/sessions/other/live-browser/sessions/${LIVE_BROWSER_ID}/frame?seq=1`,
      } }),
    });
    await expect(wrongSession.open({ sessionId: "s-1", url: PAGE.url }))
      .rejects.toThrow("不属于当前会话");

    const wrongSequence = createLiveBrowserHttpClient({
      fetchImpl: async () => httpResponse({ browser: {
        ...LIVE_FRAME,
        frameUrl: `/api/sessions/s-1/live-browser/sessions/${LIVE_BROWSER_ID}/frame?seq=99`,
      } }),
    });
    await expect(wrongSequence.open({ sessionId: "s-1", url: PAGE.url }))
      .rejects.toThrow("不属于当前会话");
  });

  it("accepts only credential-free HTTP(S) URLs and normalizes a bare host to HTTPS", () => {
    expect(normalizeSafeWebUrl("help.sap.com/docs")).toBe("https://help.sap.com/docs");
    expect(normalizeSafeWebUrl("https://help.sap.com/docs")).toBe("https://help.sap.com/docs");
    expect(normalizeSafeWebUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSafeWebUrl("data:text/html,test")).toBeNull();
    expect(normalizeSafeWebUrl("https://user:secret@example.com/")).toBeNull();
  });

  it("bounds persisted history by entries and bytes and strips every field except pageId/url", () => {
    const raw = {
      index: 39,
      entries: Array.from({ length: 40 }, (_, index) => ({
        pageId: `page-${index}`,
        url: `https://example.com/${index}?q=${"x".repeat(900)}`,
        paragraphs: [{ text: "绝不能进入 localStorage" }],
        secret: "hidden",
      })),
    };
    const normalized = normalizeWebPreviewHistoryState(raw, { url: PAGE.url, pageId: PAGE.id });
    expect(normalized.entries.length).toBeLessThanOrEqual(WEB_PREVIEW_HISTORY_MAX_ENTRIES);
    expect(new TextEncoder().encode(JSON.stringify(normalized)).byteLength)
      .toBeLessThanOrEqual(WEB_PREVIEW_HISTORY_MAX_BYTES);
    expect(normalized.entries.at(-1)).toEqual({ pageId: "page-39", url: expect.stringContaining("/39?") });
    expect(JSON.stringify(normalized)).not.toContain("paragraphs");
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });

  it("allows only the same-origin session PDF content route for embedded PDF data", () => {
    expect(normalizePdfPreviewUrl("/api/sessions/s-1/web/pages/page-pdf/content"))
      .toBe("/api/sessions/s-1/web/pages/page-pdf/content");
    expect(normalizePdfPreviewUrl("https://example.com/policy.pdf")).toBeNull();
    expect(normalizePdfPreviewUrl("//example.com/policy.pdf")).toBeNull();
    expect(normalizePdfPreviewUrl("/api/files/policy.pdf")).toBeNull();
  });

  it("validates PDF wire status and accepts an omitted totalPages", async () => {
    const invalidClient = createWebPreviewHttpClient({
      fetchImpl: async () => httpResponse({ page: {
        ...PDF_PAGE, resource: { ...PDF_PAGE.resource!, textStatus: "ready" },
      } }),
    });
    await expect(invalidClient.open({ sessionId: "s-1", url: PDF_PAGE.url }))
      .rejects.toThrow("PDF 资源格式");

    const { totalPages: _totalPages, ...withoutTotal } = PDF_PAGE.resource!;
    const validClient = createWebPreviewHttpClient({
      fetchImpl: async () => httpResponse({ page: { ...PDF_PAGE, resource: withoutTotal } }),
    });
    const page = await validClient.open({ sessionId: "s-1", url: PDF_PAGE.url });
    expect(page.resource?.textStatus).toBe("available");
    expect(page.resource?.totalPages).toBeUndefined();
  });

  it("preserves HTTP status, diagnostic code and server detail for the failure UI", async () => {
    const client = createWebPreviewHttpClient({
      fetchImpl: async () => httpResponse({ detail: "站点暂时限制访问", code: "rate_limited" }, 429),
    });
    await expect(client.open({ sessionId: "s-1", url: PAGE.url })).rejects.toMatchObject({
      name: "WebPreviewHttpError", status: 429, code: "rate_limited", message: "站点暂时限制访问",
    });
  });
});

describe("<WebPreview> Live-only workbench", () => {
  it("ignores legacy surface state and exposes only the compact Live toolbar", async () => {
    const view = render(<WebPreviewBase sessionId="s-1" target={{ url: PAGE.url }} initialPage={PAGE}
      initialSurface="reader" client={fakeClient()} liveBrowserClient={fakeLiveClient()} />);
    await waitFor(() => expect(view.container.querySelector("img.oc-live-browser-frame")).not.toBeNull());

    expect(view.container.querySelector(".oc-web-preview")?.getAttribute("data-surface")).toBe("live");
    expect(view.queryByRole("button", { name: "阅读" })).toBeNull();
    expect(view.queryByRole("button", { name: "浏览" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "网页语言" })).toBeNull();
    expect(view.queryByRole("button", { name: "打开" })).toBeNull();
    expect(view.getByRole("textbox", { name: "网页地址" })).toBeTruthy();
    expect(view.getByRole("button", { name: "后退" })).toBeTruthy();
    expect(view.getByRole("button", { name: "前进" })).toBeTruthy();
    expect(view.getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(view.getByRole("button", { name: "AI 总结" })).toBeTruthy();
    expect(view.container.querySelector(".oc-web-preview-reader")).toBeNull();
  });

  it("summarizes the currently navigated Live URL instead of the initial Reader snapshot", async () => {
    const frameB = liveFrameAt(2, { url: PAGE_B.url, title: PAGE_B.title });
    const summaryB: WebPreviewSummary = {
      ...SUMMARY,
      id: "summary-b",
      basedOn: { pageId: PAGE_B.id, digest: PAGE_B.digest, fetchedAt: PAGE_B.fetchedAt },
      basedOnDigest: PAGE_B.digest,
      bullets: [{ id: "bullet-b", text: "当前 B 页面政策摘要。", citationIds: ["cite-b"] }],
    };
    const snapshotLive = vi.fn(async (request: { url: string }) => request.url === PAGE_B.url ? PAGE_B : PAGE);
    const summarize = vi.fn(async () => summaryB);
    const navigate = vi.fn(async () => frameB);
    const onCitation = vi.fn();
    const view = render(<WebPreviewBase sessionId="s-1" target={{ url: PAGE.url }} initialPage={PAGE}
      client={fakeClient({ snapshotLive: snapshotLive as WebPreviewClient["snapshotLive"], summarize })}
      liveBrowserClient={fakeLiveClient({ navigate })} onCitation={onCitation} />);

    await waitFor(() => expect(view.container.querySelector("img.oc-live-browser-frame")).not.toBeNull());
    fireEvent.change(view.getByRole("textbox", { name: "网页地址" }), { target: { value: PAGE_B.url } });
    fireEvent.submit(view.container.querySelector(".oc-web-preview-nav")!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE_B.url })));
    await waitFor(() => expect((view.getByRole("textbox", { name: "网页地址" }) as HTMLInputElement).value).toBe(PAGE_B.url));

    fireEvent.click(view.getByRole("button", { name: "AI 总结" }));
    await waitFor(() => expect(snapshotLive).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s-1", browserSessionId: LIVE_BROWSER_ID, seq: 2, url: PAGE_B.url,
    })));
    await waitFor(() => expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s-1", pageId: PAGE_B.id, language: "zh-CN",
    })));
    expect(view.container.querySelector(".oc-web-preview-summary-list")?.textContent).toContain("当前 B 页面政策摘要");
    expect(view.container.querySelector(".oc-web-preview-summary-source")?.textContent).toBe(PAGE_B.url);
    expect(view.container.querySelector(".oc-web-preview-reader")).toBeNull();
    expect(view.queryByRole("button", { name: "定位原文" })).toBeNull();

    fireEvent.click(view.container.querySelector(".oc-web-preview-summary-list .oc-web-preview-cite")!);
    expect(onCitation).toHaveBeenCalledWith(PAGE_B.citations[0], expect.objectContaining({ id: PAGE_B.id }));
  });

  it("refreshes a late-rendered SPA frame and freezes that exact new seq before summarizing", async () => {
    vi.useFakeTimers();
    try {
      const hydratedFrame = liveFrameAt(2, { title: "Hydrated purchase application" });
      const hydratedPage: WebPreviewPage = {
        ...PAGE_B,
        url: PAGE.url,
        finalUrl: PAGE.url,
        title: hydratedFrame.title,
      };
      const hydratedSummary: WebPreviewSummary = {
        ...SUMMARY,
        basedOn: { pageId: hydratedPage.id, digest: hydratedPage.digest, fetchedAt: hydratedPage.fetchedAt },
        basedOnDigest: hydratedPage.digest,
      };
      const screenshot = vi.fn(async () => hydratedFrame);
      const snapshotLive = vi.fn(async () => hydratedPage);
      const summarize = vi.fn(async () => hydratedSummary);
      const view = render(<WebPreviewBase sessionId="s-1" target={{ url: PAGE.url }} initialPage={PAGE}
        client={fakeClient({ snapshotLive, summarize })}
        liveBrowserClient={fakeLiveClient({ screenshot })} />);

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
      expect(screenshot).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector("img.oc-live-browser-frame")?.getAttribute("src"))
        .toContain("seq=2");

      fireEvent.click(view.getByRole("button", { name: "AI 总结" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(snapshotLive).toHaveBeenCalledWith(expect.objectContaining({
        browserSessionId: LIVE_BROWSER_ID,
        seq: 2,
        url: PAGE.url,
      }));
      expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ pageId: hydratedPage.id }));
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no Reader fallback when the browser engine is unavailable", async () => {
    const capabilities = vi.fn(async () => ({ available: false, reason: "Chromium worker is offline", features: [] }));
    const view = render(<WebPreviewBase sessionId="s-1" target={{ url: PAGE.url }} initialPage={PAGE}
      client={fakeClient()} liveBrowserClient={fakeLiveClient({ capabilities })} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("浏览器引擎暂不可用"));
    expect(view.queryByRole("button", { name: "使用阅读模式" })).toBeNull();
    expect(view.getByRole("button", { name: "重试浏览" })).toBeTruthy();
    expect(view.getByRole("link", { name: "打开外部" })).toBeTruthy();
  });

  it("keeps hidden tabs from owning a Live runtime", async () => {
    const open = vi.fn(async () => LIVE_FRAME);
    const close = vi.fn(async () => undefined);
    const live = fakeLiveClient({ open, close });
    const view = render(<>
      <WebPreviewBase sessionId="s-1" target={{ url: PAGE.url }} initialPage={PAGE}
        active client={fakeClient()} liveBrowserClient={live} />
      <WebPreviewBase sessionId="s-1" target={{ url: PAGE_B.url }} initialPage={PAGE_B}
        active={false} client={fakeClient()} liveBrowserClient={live} />
    </>);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("keeps PDFs on the same-origin PDF surface without Reader or language controls", () => {
    const view = render(<WebPreviewBase sessionId="s-1" target={{ url: PDF_PAGE.url }} initialPage={PDF_PAGE}
      client={fakeClient()} liveBrowserClient={fakeLiveClient()} />);
    expect(view.container.querySelector(".oc-web-preview")?.getAttribute("data-surface")).toBe("pdf");
    expect(view.container.querySelector("object.oc-web-preview-pdf")?.getAttribute("data"))
      .toBe("/api/sessions/s-1/web/pages/page-pdf/content");
    expect(view.queryByRole("button", { name: "阅读" })).toBeNull();
    expect(view.queryByRole("button", { name: "PDF" })).toBeNull();
    expect(view.queryByRole("combobox", { name: "网页语言" })).toBeNull();
  });
});
