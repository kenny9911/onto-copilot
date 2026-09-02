import { describe, expect, it, vi } from "vitest";

import {
  BING_GLOBAL_RSS_ENDPOINT,
  BING_RSS_ENDPOINT,
  TAVILY_EXTRACT_ENDPOINT,
  TAVILY_SEARCH_ENDPOINT,
  WEB_MAX_CONTENT_CHARS,
  WebSearchError,
  WebSearchService,
  publicWebUrl,
  type WebFetch,
} from "../src/server/web_search.js";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("WebSearchService", () => {
  it("有 Tavily key 时只请求固定 search endpoint、忽略 provider answer 并过滤危险 URL", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input, init) => {
      expect(String(input)).toBe(TAVILY_SEARCH_ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["include_answer"]).toBe(false);
      expect(body["include_raw_content"]).toBe(false);
      expect(body["max_results"]).toBe(16);
      // Tavily 当前请求契约没有经过本项目验证的 market/locale 参数，不能猜字段。
      expect(body).not.toHaveProperty("country");
      expect(body).not.toHaveProperty("language");
      expect(body).not.toHaveProperty("locale");
      return jsonResponse({
        answer: "这段 provider 生成的答案绝不能进入结果",
        results: [
          {
            title: "Returns & refunds guide",
            url: "https://docs.example.com/returns#overview",
            content: "A <b>useful</b> returns workflow.",
            published_date: "2025-01-02",
          },
          { title: "loopback", url: "http://127.0.0.1/admin", content: "secret" },
          { title: "private", url: "http://10.0.0.8/", content: "secret" },
          { title: "credentials", url: "https://u:p@example.com/", content: "secret" },
          { title: "port", url: "https://example.com:8443/", content: "secret" },
        ],
      });
    });
    const service = new WebSearchService({
      fetch: fetchMock,
      apiKey: "secret-key",
      now: () => Date.parse("2026-08-25T00:00:00Z"),
      idFactory: () => "search-one",
    });

    const response = await service.search("return workflow", { maxResults: 8 });

    expect(response).toMatchObject({
      query: "return workflow",
      search_id: "ws_search-one",
      provider: "tavily",
      scope: "global",
      retrieved_at: "2026-08-25T00:00:00.000Z",
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toEqual({
      source_id: expect.stringMatching(/^web_[a-f0-9]{16}$/),
      title: "Returns & refunds guide",
      url: "https://docs.example.com/returns",
      domain: "docs.example.com",
      snippet: "A useful returns workflow.",
      published_at: "2025-01-02T00:00:00.000Z",
      retrieved_at: "2026-08-25T00:00:00.000Z",
      content_status: "snippet_only",
    });
    expect(JSON.stringify(response)).not.toContain("provider 生成");
  });

  it("无配置时默认走 Bing global：固定英文/美国市场并解析 XML", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe(BING_GLOBAL_RSS_ENDPOINT);
      expect(url.searchParams.get("q")).toBe("跨境电商 退货");
      expect(url.searchParams.get("format")).toBe("rss");
      expect(url.searchParams.get("count")).toBe("6");
      expect(url.searchParams.get("mkt")).toBe("en-US");
      expect(url.searchParams.get("cc")).toBe("US");
      expect(url.searchParams.get("setlang")).toBe("en-US");
      expect(new Headers(init?.headers).get("accept-language")).toBe("en-US,en;q=0.9");
      return new Response(`<?xml version="1.0"?><rss><channel>
        <item>
          <title><![CDATA[Returns &amp; Refunds]]></title>
          <link>https://merchant.example.org/help/returns</link>
          <description><![CDATA[<b>Evidence</b> for the refund process.]]></description>
          <pubDate>Mon, 24 Aug 2026 12:00:00 GMT</pubDate>
        </item>
      </channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
    });
    const service = new WebSearchService({
      fetch: fetchMock,
      apiKey: null,
      now: () => Date.parse("2026-08-25T00:00:00Z"),
      idFactory: () => "bing-search",
    });

    const response = await service.search("跨境电商 退货", { maxResults: 3 });

    expect(response.provider).toBe("bing");
    expect(response.scope).toBe("global");
    expect(response.results).toEqual([
      expect.objectContaining({
        title: "Returns & Refunds",
        url: "https://merchant.example.org/help/returns",
        domain: "merchant.example.org",
        snippet: "Evidence for the refund process.",
        published_at: "2026-08-24T12:00:00.000Z",
        content_status: "snippet_only",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("regional 保留部署地区行为，不注入 global 市场参数或语言头", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(`${url.origin}${url.pathname}`).toBe(BING_RSS_ENDPOINT);
      expect(url.searchParams.get("q")).toBe("采购报销流程");
      expect(url.searchParams.get("count")).toBe("4");
      expect(url.searchParams.has("mkt")).toBe(false);
      expect(url.searchParams.has("cc")).toBe(false);
      expect(url.searchParams.has("setlang")).toBe(false);
      expect(new Headers(init?.headers).get("accept-language")).toBeNull();
      return new Response(`<rss><channel><item><title>本地结果</title>
        <link>https://example.cn/guide</link><description>区域资料</description>
        </item></channel></rss>`);
    });
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null });

    const response = await service.search("采购报销流程", { maxResults: 2, scope: "regional" });

    expect(response.scope).toBe("regional");
    expect(response.results[0]?.title).toBe("本地结果");
  });

  it("只跟随 Bing 自己的地区重定向，拒绝把固定 provider 变成 SSRF 跳板", async () => {
    const rss = `<rss><channel><item><title>Regional result</title>
      <link>https://example.com/result</link><description>Evidence</description>
      </item></channel></rss>`;
    const regionalFetch = vi.fn<WebFetch>(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      const url = new URL(String(input));
      if (url.hostname === "www.bing.com") {
        return new Response(null, {
          status: 302,
          headers: { location: `https://cn.bing.com${url.pathname}${url.search}` },
        });
      }
      expect(url.hostname).toBe("cn.bing.com");
      return new Response(rss);
    });
    const service = new WebSearchService({ fetch: regionalFetch, apiKey: null });
    const response = await service.search("regional redirect", { scope: "regional" });
    expect(response.results[0]?.title).toBe("Regional result");
    expect(regionalFetch).toHaveBeenCalledTimes(2);

    const unsafe = new WebSearchService({
      apiKey: null,
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }),
    });
    await expect(unsafe.search("unsafe redirect")).rejects.toMatchObject({
      code: "unsafe_provider_redirect",
    });
  });

  it("read 在网络请求前拒绝未知 source_id，且无 Tavily 时只返回已登记摘要", async () => {
    const fetchMock = vi.fn<WebFetch>(async () => new Response(`
      <rss><channel><item><title>Guide</title><link>https://example.com/guide</link>
      <description>Trusted only as external evidence.</description></item></channel></rss>`));
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null, idFactory: () => "x" });

    await expect(service.read("web_arbitrary_url_or_guess")).rejects.toMatchObject({
      code: "unknown_source",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const searched = await service.search("guide");
    const source = searched.results[0];
    expect(source).toBeDefined();
    const read = await service.read(source?.source_id ?? "");
    expect(read).toMatchObject({
      source_id: source?.source_id,
      content_status: "snippet_only",
      content: "Trusted only as external evidence.",
      untrusted: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("可从会话状态恢复来源，但会重新拒绝伪造 ID 与私网 URL", async () => {
    const fetchMock = vi.fn<WebFetch>();
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null });
    const restored = service.restoreSources([
      {
        source_id: "web_0123456789abcdef",
        title: "Persisted guide",
        url: "https://docs.example.com/returns",
        snippet: "Persisted snippet",
        retrieved_at: "2026-08-25T00:00:00Z",
        content_status: "snippet_only",
      },
      { source_id: "web_fedcba9876543210", url: "http://127.0.0.1/admin" },
      { source_id: "not-signed", url: "https://example.com/forged" },
    ]);

    expect(restored).toBe(1);
    await expect(service.read("web_fedcba9876543210")).rejects.toMatchObject({ code: "unknown_source" });
    const read = await service.read("web_0123456789abcdef");
    expect(read).toMatchObject({ content: "Persisted snippet", untrusted: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Tavily extract 只接收已搜索 source URL，正文限长且标成不可信", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input, init) => {
      if (String(input) === TAVILY_SEARCH_ENDPOINT) {
        return jsonResponse({
          results: [{ title: "Guide", url: "https://example.com/guide", content: "summary" }],
        });
      }
      expect(String(input)).toBe(TAVILY_EXTRACT_ENDPOINT);
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      expect(body.urls).toEqual(["https://example.com/guide"]);
      return jsonResponse({
        results: [{ url: "https://example.com/guide", raw_content: "x".repeat(20_000) }],
      });
    });
    const service = new WebSearchService({
      fetch: fetchMock,
      apiKey: "key",
      idFactory: () => "extract",
    });
    const searched = await service.search("guide");
    const sourceId = searched.results[0]?.source_id;
    expect(sourceId).toBeDefined();

    const read = await service.read(sourceId ?? "");

    expect(read.content_status).toBe("fetched");
    expect(read.untrusted).toBe(true);
    expect(read.content.length).toBeLessThanOrEqual(WEB_MAX_CONTENT_CHARS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await service.read(sourceId ?? "");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("相同并发 search 去重，随后命中缓存", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<WebFetch>(async () => {
      await gate;
      return new Response(`<rss><channel><item><title>A</title><link>https://a.example/x</link>
        <description>S</description></item></channel></rss>`);
    });
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null, idFactory: () => "same" });

    const first = service.search("same query");
    const second = service.search("same query");
    release?.();
    const [a, b] = await Promise.all([first, second]);
    const cached = await service.search("same query");

    expect(a).toEqual(b);
    expect(cached).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("缓存按 global / regional 隔离，相同 query 不会跨市场复用", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const url = new URL(String(input));
      seen.push(url.searchParams.get("mkt") ?? "regional");
      return new Response(`<rss><channel><item><title>A</title>
        <link>https://example.com/a</link><description>S</description></item></channel></rss>`);
    });
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null });

    await service.search("same query", { scope: "global" });
    await service.search("same query", { scope: "regional" });
    await service.search("same query", { scope: "global" });

    expect(seen).toEqual(["en-US", "regional"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("候选放大后按可注册域去重，兼顾普通域、co.uk 与 com.cn", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("count")).toBe("8");
      return new Response(`<rss><channel>
        <item><title>Baidu encyclopedia</title><link>https://baike.baidu.com/item/x</link><description>1</description></item>
        <item><title>Baidu B2B</title><link>https://b2b.baidu.com/x</link><description>2</description></item>
        <item><title>UK news</title><link>https://news.example.co.uk/x</link><description>3</description></item>
        <item><title>UK docs</title><link>https://docs.example.co.uk/y</link><description>4</description></item>
        <item><title>CN vendor A</title><link>https://a.vendor.com.cn/x</link><description>5</description></item>
        <item><title>CN vendor B</title><link>https://b.vendor.com.cn/y</link><description>6</description></item>
        <item><title>Independent</title><link>https://independent.org/x</link><description>7</description></item>
        <item><title>Another</title><link>https://another.net/x</link><description>8</description></item>
      </channel></rss>`);
    });
    const service = new WebSearchService({ fetch: fetchMock, apiKey: null });

    const response = await service.search("expense controls", { maxResults: 4 });

    expect(response.results.map((row) => row.title)).toEqual([
      "Baidu encyclopedia",
      "UK news",
      "CN vendor A",
      "Independent",
    ]);
    expect(response.results.map((row) => row.domain)).not.toContain("b2b.baidu.com");
    expect(response.results.map((row) => row.domain)).not.toContain("docs.example.co.uk");
    expect(response.results.map((row) => row.domain)).not.toContain("b.vendor.com.cn");
  });

  it("regional 在唯一主域不足时用其余唯一 URL 回填，global 不回填同品牌子站", async () => {
    const rss = `<rss><channel>
      <item><title>Baidu A</title><link>https://baike.baidu.com/a</link><description>1</description></item>
      <item><title>Baidu B</title><link>https://b2b.baidu.com/b</link><description>2</description></item>
      <item><title>Example A</title><link>https://docs.example.com/a</link><description>3</description></item>
      <item><title>Example B</title><link>https://news.example.com/b</link><description>4</description></item>
    </channel></rss>`;
    const service = new WebSearchService({
      fetch: vi.fn<WebFetch>(async () => new Response(rss)),
      apiKey: null,
      cacheTtlMs: 0,
    });

    const global = await service.search("controls", { maxResults: 4, scope: "global" });
    const regional = await service.search("controls", { maxResults: 4, scope: "regional" });

    expect(global.results.map((row) => row.title)).toEqual(["Baidu A", "Example A"]);
    expect(regional.results.map((row) => row.title)).toEqual([
      "Baidu A",
      "Example A",
      "Baidu B",
      "Example B",
    ]);
  });

  it("声明或实际响应超过限制时失败", async () => {
    const declared = new WebSearchService({
      apiKey: null,
      responseLimitBytes: 16,
      fetch: async () => new Response("small", { headers: { "content-length": "17" } }),
    });
    await expect(declared.search("too large")).rejects.toMatchObject({ code: "response_too_large" });

    const streamed = new WebSearchService({
      apiKey: null,
      responseLimitBytes: 4,
      fetch: async () => new Response("12345"),
    });
    await expect(streamed.search("too large")).rejects.toBeInstanceOf(WebSearchError);
  });
});

describe("publicWebUrl", () => {
  it.each([
    "http://localhost/x",
    "http://service.internal/x",
    "http://10.0.0.1/x",
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/x",
    "http://[fc00::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "https://user:pass@example.com/x",
    "https://example.com:8443/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("拒绝危险或异常 URL：%s", (url) => {
    expect(publicWebUrl(url)).toBeNull();
  });

  it.each([
    "https://example.com/path#fragment",
    "http://example.org:80/path",
    "https://8.8.8.8/dns-query",
    "https://[2606:4700:4700::1111]/",
  ])("接受普通公网 URL：%s", (url) => {
    expect(publicWebUrl(url)).not.toBeNull();
  });
});
