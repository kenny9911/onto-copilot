/**
 * HTML→PDF 排版器：**按主机上真有什么来接**。
 *
 * `onto/export.ts` 早就留好了注册点（`registerPdfRenderer`），但生产进程从没接过 ——
 * 于是用户说「改成 pdf 版本」时，模型只能回一句「我无法直接为您输出 .pdf」，
 * 再教他自己用 Word 另存为（2026-08-25 用户实拍）。
 *
 * 不引新依赖：无头浏览器（Chrome/Edge/Chromium）几乎每台机器都有，而且它吃的正是
 * 我们现成的 `docToHtml(doc)` + `PDF_CSS`，中文字体、表格、内嵌图片全都不用自己实现。
 * 实测这台机器：冷启动 6.0s、热 2.2s，输出 %PDF-1.4。
 *
 * 三条纪律：
 *  · **有就接、没有就诚实说没有** —— 检测不到引擎时不许假装能导（availableFormats 里不出现 pdf）；
 *  · **不阻塞事件循环** —— 排版要几秒，走异步子进程，不用 execFileSync；
 *  · **临时文件用完就删**，包括失败路径。
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { detectPdfEngine, pdfEngineArgs } from "../src/server/glue/pdf.js";

describe("detectPdfEngine", () => {
  it("按候选表逐个探，返回第一个真实存在的可执行文件", () => {
    const seen: string[] = [];
    const engine = detectPdfEngine({
      exists: (p) => { seen.push(p); return p === "/opt/fake/chromium"; },
      which: () => null,
      env: {},
    });
    expect(engine?.path).toBe("/opt/fake/chromium");
    expect(seen.length).toBeGreaterThan(1);   // 真的逐个探过
  });

  it("PATH 上的也算（Linux 上 chromium 通常不在固定路径）", () => {
    const engine = detectPdfEngine({
      exists: () => false,
      which: (cmd) => (cmd === "chromium-browser" ? "/usr/bin/chromium-browser" : null),
      env: {},
    });
    expect(engine?.path).toBe("/usr/bin/chromium-browser");
  });

  it("环境变量指定的优先于一切 —— 部署方要能自己指", () => {
    const engine = detectPdfEngine({
      exists: (p) => p === "/custom/my-chrome" || p === "/opt/fake/chromium",
      which: () => null,
      env: { ONTOCOPILOT_PDF_ENGINE: "/custom/my-chrome" },
    });
    expect(engine?.path).toBe("/custom/my-chrome");
  });

  it("环境变量指到一个不存在的路径 → 当没配（不许因为配错就整台机器导不出）", () => {
    const engine = detectPdfEngine({
      exists: (p) => p === "/opt/fake/chromium",
      which: () => null,
      env: { ONTOCOPILOT_PDF_ENGINE: "/nope/missing" },
    });
    expect(engine?.path).toBe("/opt/fake/chromium");
  });

  it("一个都没有 → null，调用方据此把 pdf 从可用格式里去掉", () => {
    expect(detectPdfEngine({ exists: () => false, which: () => null, env: {} })).toBeNull();
  });

  it("参数里必须有无头与「不要页眉页脚」—— 页眉会把打印时间盖在正文上", () => {
    const args = pdfEngineArgs("/in.html", "/out.pdf");
    expect(args).toContain("--headless");
    expect(args.some((a) => a.startsWith("--print-to-pdf="))).toBe(true);
    expect(args).toContain("--print-to-pdf-no-header");
    // file:// 前缀不能少，否则 Chrome 当成搜索词
    expect(args.some((a) => a.startsWith("file://"))).toBe(true);
  });
});

describe("renderPdfWith（真跑一次本机引擎）", () => {
  it("中文表格能排出合法 PDF；临时文件用完即删", async () => {
    const engine = detectPdfEngine();
    if (engine === null) {
      // 这台机器上确实没有引擎 —— 那本条无从验证，但**不能**因此假绿：
      // 断言「没有引擎时 pdf 不在可用格式里」，这同样是本模块的契约。
      const { availableFormats } = await import("../src/onto/export.js");
      expect(availableFormats()).not.toContain("pdf");
      return;
    }
    const { renderPdfWith, pdfTempFiles } = await import("../src/server/glue/pdf.js");
    const html = "<h1>采购过程监督详细流程业务确认稿</h1>"
      + "<table><tr><th>阶段</th><th>环节</th></tr><tr><td>阶段一｜监督计划与立项</td><td>制定年度计划</td></tr></table>";
    const bytes = await renderPdfWith(engine, html, "table{border-collapse:collapse}td,th{border:1px solid #999}");
    expect(bytes.length).toBeGreaterThan(1000);
    // %PDF 魔数
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    for (const f of pdfTempFiles()) expect(existsSync(f)).toBe(false);
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════
//  接进导出栈
//
//  注册点 registerPdfRenderer 是**同步**的（`(html, css) => Uint8Array`），而排版要
//  起一个子进程、跑两秒 —— 同步做等于把整台服务卡住两秒。所以另开一条异步路径：
//  renderAsync 用它，其余格式照旧走同步 render（golden 钉着那条）。
// ══════════════════════════════════════════════════════════════════
describe("异步排版接线", () => {
  it("注册异步排版器后 pdf 进入可用格式；解除后立刻退出", async () => {
    const ex = await import("../src/onto/export.js");
    expect(ex.availableFormats()).not.toContain("pdf");
    ex.registerPdfRendererAsync(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    try {
      expect(ex.availableFormats()).toContain("pdf");
      expect(ex.unavailableFormats()).not.toContain("pdf");
    } finally {
      ex.registerPdfRendererAsync(null);
    }
    expect(ex.availableFormats()).not.toContain("pdf");
  });

  it("renderAsync 出 pdf 字节；同步 render 对 pdf 明说要走异步口", async () => {
    const ex = await import("../src/onto/export.js");
    const doc = ex.makeExportDoc({ title: "确认稿", blocks: [] });
    ex.registerPdfRendererAsync(async (html: string) => {
      expect(html).toContain("确认稿");           // 拿到的是排好的 HTML
      return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    });
    try {
      const [bytes, spec] = await ex.renderAsync(doc, "pdf");
      expect(spec.ext).toBe("pdf");
      expect(String.fromCharCode(...bytes)).toBe("%PDF-");
      // 同步口不能悄悄回落成别的格式，也不能假装成功
      expect(() => ex.render(doc, "pdf")).toThrowError(/异步/u);
    } finally {
      ex.registerPdfRendererAsync(null);
    }
  });

  it("其余格式走 renderAsync 也照旧（它只是同步 render 的外壳）", async () => {
    const ex = await import("../src/onto/export.js");
    const doc = ex.makeExportDoc({ title: "清单", blocks: [] });
    const [bytes, spec] = await ex.renderAsync(doc, "md");
    expect(spec.ext).toBe("md");
    expect(new TextDecoder().decode(bytes)).toContain("清单");
  });
});
