// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WebSourcesCard } from "../src/ui/react/web-search.js";
import { parseWebSourcesEvent, safeWebText } from "../src/ui/web-search.js";

afterEach(() => cleanup());

const source = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `src-${i}`,
  title: `资料 ${i}`,
  url: `https://example${i}.com/article`,
  domain: `example${i}.com`,
  site_name: `站点 ${i}`,
  snippet: `摘要 ${i}`,
  content_status: "snippet_only",
  ...extra,
});

describe("parseWebSourcesEvent", () => {
  it("只让 http(s) URL 进入卡片，并拒绝带凭证的链接", () => {
    const parsed = parseWebSourcesEvent({
      kind: "web.sources",
      results: [
        source(1, { url: "javascript:alert(1)" }),
        source(2, { url: "data:text/html,<script>alert(1)</script>" }),
        source(3, { url: "https://user:secret@example.com/private" }),
        source(4, { url: "https://safe.example/report?q=1" }),
      ],
    });
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0]?.id).toBe("src-4");
    expect(parsed?.results[0]?.url).toBe("https://safe.example/report?q=1");
  });

  it("去掉控制字符并按 Unicode code point 安全截断不可信文本", () => {
    const title = `伪装\u202e标题\u0000${"😀".repeat(220)}`;
    const snippet = `第一行\n${"摘".repeat(900)}`;
    const parsed = parseWebSourcesEvent({
      kind: "web.sources",
      query: `q${"问".repeat(400)}`,
      results: [source(1, { title, snippet })],
    });
    const item = parsed!.results[0]!;
    expect(Array.from(item.title)).toHaveLength(180);
    expect(Array.from(item.snippet)).toHaveLength(600);
    expect(Array.from(parsed!.query).length).toBeLessThanOrEqual(240);
    expect(item.title).not.toMatch(/[\u0000\u202e]/);
    expect(item.snippet).not.toContain("\n");
    expect(safeWebText("A😀B", 2)).toBe("A😀");
  });

  it("残缺事件不抛错：丢掉缺 id/URL 的行，标题和域名可从安全 URL 补齐", () => {
    expect(parseWebSourcesEvent(null)).toBeNull();
    expect(parseWebSourcesEvent({ kind: "other", results: [source(1)] })).toBeNull();
    expect(parseWebSourcesEvent({ kind: "web.sources", results: [{ id: "x" }] })).toBeNull();

    const parsed = parseWebSourcesEvent({
      kind: "web.sources",
      results: [
        { title: "无 id", url: "https://drop.example/a" },
        { id: "kept", url: "https://docs.example/path" },
      ],
    });
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0]).toMatchObject({
      id: "kept",
      title: "docs.example",
      domain: "docs.example",
      siteName: "docs.example",
      contentStatus: "snippet_only",
    });
  });

  it("展示域名只从真实 URL 推导，并去掉重复 id 或 URL", () => {
    const parsed = parseWebSourcesEvent({
      kind: "web.sources",
      results: [
        source(1, { domain: "trusted.example", url: "https://actual.example/a" }),
        source(1, { url: "https://duplicate-id.example/b" }),
        source(3, { url: "https://actual.example/a" }),
      ],
    });
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0]?.domain).toBe("actual.example");
  });

  it("最多保留五条并明确标记截断", () => {
    const parsed = parseWebSourcesEvent({
      kind: "web.sources",
      total: 8,
      results: Array.from({ length: 8 }, (_, i) => source(i + 1)),
    });
    expect(parsed?.results).toHaveLength(5);
    expect(parsed?.total).toBe(8);
    expect(parsed?.truncated).toBe(true);
  });
});

describe("<WebSourcesCard>", () => {
  it("用 section/list/article 语义渲染安全来源，并可在工作台或外部打开", () => {
    let opened: unknown = null;
    const capture = (event: Event): void => { opened = (event as CustomEvent).detail; };
    window.addEventListener("oc:workbench-open", capture, { once: true });
    const view = render(<WebSourcesCard ev={{
      kind: "web.sources",
      query: "退货退款行业流程",
      total: 10,
      results: [source(1, { content_status: "fetched", published_at: "2026-08-20" })],
    }} />);
    const section = view.container.querySelector("section.web-sources-card")!;
    expect(section.getAttribute("aria-label")).toContain("退货退款行业流程");
    expect(section.querySelectorAll("ol > li > article")).toHaveLength(1);

    const internal = section.querySelector("button.web-source-link") as HTMLButtonElement;
    fireEvent.click(internal);
    expect(opened).toMatchObject({
      kind: "web",
      url: "https://example1.com/article",
      title: "资料 1",
    });
    const link = section.querySelector("a.web-source-external")!;
    expect(link.getAttribute("href")).toBe("https://example1.com/article");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    expect(link.getAttribute("aria-label")).toContain("在新窗口打开");
    expect(section.textContent).toContain("已读取正文");
    expect(section.textContent).toContain("外部资料用于行业参考");
    expect(section.textContent).not.toContain("搜索：退货退款行业流程");
    expect(section.textContent).not.toContain("1 条参考");
    expect(section.textContent).not.toContain("从 10 条候选中");
    expect(section.querySelector(".web-source-number")?.textContent).toBe("01");
    expect(section.querySelector(".web-source-domain")?.textContent).toBe("example1.com");
    expect(section.querySelector(".web-source-snippet")?.textContent).toBe("摘要 1");
  });

  it("默认只显示三条，可用原生按钮展开到五条并保持 ARIA 关系", () => {
    const view = render(<WebSourcesCard ev={{
      kind: "web.sources",
      total: 5,
      results: Array.from({ length: 5 }, (_, i) => source(i + 1)),
    }} />);
    const list = view.container.querySelector("ol.web-source-list")!;
    const button = view.getByRole("button", { name: "再看 2 条" });

    expect(list.querySelectorAll("article")).toHaveLength(3);
    expect(view.container.textContent).not.toContain("显示 3 / 5 条参考");
    expect(view.container.textContent).not.toContain("5 条参考");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(list.id);

    fireEvent.click(button);
    expect(list.querySelectorAll("article")).toHaveLength(5);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("收起");

    fireEvent.click(button);
    expect(list.querySelectorAll("article")).toHaveLength(3);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("正文已引用的来源即使超过三条也直接渲染，保证编号可以定位", () => {
    const ids = Array.from({ length: 5 }, (_, i) => `src-${i + 1}`);
    const view = render(<WebSourcesCard ev={{
      kind: "web.sources",
      citation_ids: ids,
      total: 5,
      results: Array.from({ length: 5 }, (_, i) => source(i + 1)),
    }} />);
    expect(view.container.querySelectorAll("article.web-source-article")).toHaveLength(5);
    expect(view.queryByRole("button", { name: /展开全部/ })).toBeNull();
    expect(view.container.querySelector('[data-source-id="src-5"]')).not.toBeNull();
  });

  it("恶意标题和摘要始终只是文本，不会生成脚本或行内事件处理器", () => {
    const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const view = render(<WebSourcesCard ev={{
      kind: "web.sources",
      results: [source(1, { title: evil, snippet: evil })],
    }} />);
    expect(view.container.querySelector("img,script")).toBeNull();
    expect(view.container.querySelector("[onerror]")).toBeNull();
    expect(view.container.textContent).toContain(evil);
  });

  it("没有有效来源时不渲染空卡", () => {
    const view = render(<WebSourcesCard ev={{
      kind: "web.sources",
      results: [{ id: "bad", title: "坏链接", url: "javascript:alert(1)" }],
    }} />);
    expect(view.container.firstChild).toBeNull();
  });
});
