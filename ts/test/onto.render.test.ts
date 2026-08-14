/**
 * 栅格化 —— PDF→PNG / SVG→PNG。
 *
 * 这一层替掉的是 pymupdf，所以测试只盯**与它对得上的那几件事**：
 *
 *   · 页数和每页的像素尺寸（`tools/golden/` 之外唯一能逐字比的东西 ——
 *     像素级不比，抗锯齿两套栅格化器本来就不同）；
 *   · 中文不出豆腐块。这条不能靠"看着像"来验：豆腐块每个都长一样，所以
 *     **两段不同的中文渲染出的图必须不同** —— 全是豆腐块时它们会一模一样。
 *     （Python 侧那条 `test_svg_rendering_draws_real_chinese_glyphs_not_tofu`
 *     用的就是这个判据，这里照搬。）
 *   · 畸形输入是业务错误（`RenderError`），不是渲染器崩溃。
 */

import { describe, expect, it } from "vitest";

import {
  PDF_DEFAULT_ZOOM,
  RenderError,
  SVG_MAX_ZOOM,
  cjkFallbackFamily,
  installCjkFallback,
  pdfToPngs,
  pdfToTextPages,
  substituteFamily,
  svgToPng,
} from "../src/onto/render.js";

// ══════════════════════════════════════════════════════════════════
//  最小 PDF：自己拼，不引 golden
// ══════════════════════════════════════════════════════════════════

/**
 * 拼一份 N 页的 PDF，页尺寸由调用方给（**故意带小数** —— 取整规则就是靠它验的）。
 *
 * 手写 xref 而不是找个库：这份 fixture 唯一的作用是给渲染器一份**尺寸确定**的
 * 输入，多引一个依赖只会让"到底谁决定了尺寸"这件事更难说清。
 */
function makePdf(sizes: readonly (readonly [number, number])[]): Uint8Array {
  const objs: string[] = [];
  const pageIds = sizes.map((_, i) => 3 + i * 2);
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push(`<</Type/Pages/Kids[${pageIds.map((n) => `${n} 0 R`).join(" ")}]/Count ${sizes.length}>>`);
  sizes.forEach(([w, h], i) => {
    const content = `BT /F1 24 Tf 40 ${h - 60} Td (Page ${i + 1}) Tj ET\n`
      + `2 w 30 30 ${w - 60} ${h - 120} re S`;
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Contents ${pageIds[i]! + 1} 0 R`
      + `/Resources<</Font<</F1 ${3 + sizes.length * 2} 0 R>>>>>>`);
    objs.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  });
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** PNG 的 IHDR 里就写着宽高 —— 不解码整张图也能读出来。 */
function pngSize(b64: string): { width: number; height: number } {
  const buf = Buffer.from(b64, "base64");
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const CJK = cjkFallbackFamily();

// ══════════════════════════════════════════════════════════════════
//  PDF → PNG
// ══════════════════════════════════════════════════════════════════

describe("pdfToPngs", () => {
  it("页数与像素尺寸：向上取整，与 pymupdf 的 fz_round_rect 同口径", async () => {
    // 595.276 × 2 = 1190.552。pymupdf 给 1191（round_rect 扩成包含矩形），
    // 而 pdfjs 自带的 canvasFactory 会截断成 1190 —— 差的这一像素就是
    // "两个宿主渲染同一份 PDF 结果一致"这句话的真假。
    const { pages, truncated } = await pdfToPngs(
      makePdf([[595.276, 841.89], [612, 792]]), { zoom: PDF_DEFAULT_ZOOM });
    expect(pages).toHaveLength(2);
    expect(truncated).toBe(false);
    expect(pngSize(pages[0]!)).toEqual({ width: 1191, height: 1684 });
    expect(pngSize(pages[1]!)).toEqual({ width: 1224, height: 1584 });
  });

  it("zoom 直接乘进尺寸", async () => {
    const one = await pdfToPngs(makePdf([[300, 200]]), { zoom: 1 });
    const three = await pdfToPngs(makePdf([[300, 200]]), { zoom: 3 });
    expect(pngSize(one.pages[0]!)).toEqual({ width: 300, height: 200 });
    expect(pngSize(three.pages[0]!)).toEqual({ width: 900, height: 600 });
  });

  it("超出 maxPages 的页不渲染，且 truncated 说出来 —— 不静默截断", async () => {
    const r = await pdfToPngs(makePdf([[300, 200], [300, 200], [300, 200]]), { maxPages: 2 });
    expect(r.pages).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("传进去的字节不被就地改写 —— 上传那条路后面还要拿它算哈希", async () => {
    const bytes = makePdf([[300, 200]]);
    const before = Buffer.from(bytes).toString("base64");
    await pdfToPngs(bytes);
    expect(Buffer.from(bytes).toString("base64")).toBe(before);
  });

  it("接受 fs.readFile 返回的 Buffer —— 真实上传路径不能只在类型层伪装成 Uint8Array", async () => {
    // Node 的 Buffer 在类型上继承 Uint8Array，但 pdfjs 6 会在运行时明确拒绝它。
    // renderPages() 正是把 fs.readFile() 的结果传到这里，所以这不是边角输入，
    // 而是每一份落盘 PDF 的真实形态。
    const bytes = Buffer.from(makePdf([[300, 200]]));
    const { pages, truncated } = await pdfToPngs(bytes);
    expect(pages).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(pngSize(pages[0]!)).toEqual({ width: 600, height: 400 });
  });

  it("不是 PDF 就抛 RenderError（业务错误，不是渲染器崩了）", async () => {
    await expect(pdfToPngs(new TextEncoder().encode("这根本不是 PDF"))).rejects.toThrow(RenderError);
  });
});

describe("pdfToTextPages", () => {
  it("直接读取 PDF 文本层并保留页码，电子文档不必重新走 OCR", async () => {
    const result = await pdfToTextPages(makePdf([[300, 200], [300, 200]]));
    expect(result.pages.map((p) => ({ page: p.page, text: p.text }))).toEqual([
      { page: 1, text: "Page 1" },
      { page: 2, text: "Page 2" },
    ]);
    expect(result.totalPages).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("文本层入口同样接受 fs.readFile 的 Buffer，并显式报告页数截断", async () => {
    const result = await pdfToTextPages(
      Buffer.from(makePdf([[300, 200], [300, 200]])),
      { maxPages: 1 },
    );
    expect(result.pages).toEqual([{ page: 1, text: "Page 1" }]);
    expect(result.totalPages).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  SVG → PNG
// ══════════════════════════════════════════════════════════════════

const svg = (body: string, w = 360, h = 120) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" `
  + `font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif">`
  + `<rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;

describe("svgToPng", () => {
  it("出一张真的 PNG，尺寸 = SVG 尺寸 × zoom", () => {
    const out = svgToPng(svg('<text x="20" y="60" font-size="20" fill="#111">Purchase</text>'), {
      zoom: 2,
    });
    expect(Buffer.from(out.png).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([out.width, out.height]).toEqual([720, 240]);
  });

  it("zoom 有天花板 —— 像素数是它的平方，SVG 尺寸又来自调用方", () => {
    const huge = svgToPng(svg("<circle cx='30' cy='30' r='10'/>"), { zoom: 1000 });
    expect(huge.width).toBe(360 * SVG_MAX_ZOOM);
    // NaN 不能一路传进渲染器（那会出一张 0×0 的图）
    expect(svgToPng(svg(""), { zoom: Number.NaN }).width).toBe(720);
  });

  it.runIf(CJK !== null)("中文画的是真字形，不是豆腐块", () => {
    // 豆腐块每个都长一样 —— 所以"两段不同的中文渲染出的图不同"才是有效判据。
    const a = svgToPng(svg('<text x="20" y="60" font-size="24" fill="#111">采购申请</text>'));
    const b = svgToPng(svg('<text x="20" y="60" font-size="24" fill="#111">验收付款</text>'));
    expect(Buffer.from(a.png).equals(Buffer.from(b.png))).toBe(false);
    // 白底上必须真有黑像素落下去
    expect(a.png.length).toBeGreaterThan(svgToPng(svg("")).png.length);
  });

  it("箭头和虚线**不会**在栅格化时丢掉（pymupdf 会丢，这里是唯一的行为改善）", () => {
    const defs = '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
      + 'markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/>'
      + "</marker></defs>";
    const line = '<path d="M20,60 L300,60" stroke="#333" stroke-width="2"{extra}/>';
    const plain = svgToPng(svg(line.replace("{extra}", "")));
    const arrow = svgToPng(svg(defs + line.replace("{extra}", ' marker-end="url(#a)"')));
    const dashed = svgToPng(svg(line.replace("{extra}", ' stroke-dasharray="8 6"')));
    // `diagram.ts` 用箭头表方向、用虚线表"这条顺序是系统推断的"。两者在位图上
    // 与实线不可区分的话，推断边和有据可依的边就长得一样了。
    expect(Buffer.from(arrow.png).equals(Buffer.from(plain.png))).toBe(false);
    expect(Buffer.from(dashed.png).equals(Buffer.from(plain.png))).toBe(false);
  });

  it("畸形 SVG 抛 RenderError —— 输入不对，不是渲染器坏了", () => {
    expect(() => svgToPng("这根本不是 SVG")).toThrow(RenderError);
    expect(() => svgToPng("这根本不是 SVG")).toThrow(/SVG 渲染失败/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  没内嵌字体的中文 PDF：字族替换
// ══════════════════════════════════════════════════════════════════

describe("substituteFamily", () => {
  const installed = (name: string) => name === "Helvetica";

  it("系统里有的字族原样放行 —— 字形和字宽都要保住", () => {
    expect(substituteFamily('normal normal 22px "Helvetica", monospace', "宋", installed))
      .toBe('normal normal 22px "Helvetica", monospace');
  });

  it("认不出的字族换成兜底 CJK —— macOS 上 Heiti 会被模糊匹配到繁体 Heiti TC，"
    + "简体独有字（购/请/审）就成了豆腐块", () => {
    expect(substituteFamily('normal normal 22px "Heiti", monospace', "宋", installed))
      .toBe('normal normal 22px "宋"');
  });

  it.runIf(CJK !== null)("钩子装在 ctx.font 的访问器上：读回来的是**替换后**的值", () => {
    // pdfjs 是拿 `ctx.font = ...` 交代字体的，所以钩子必须落在这个访问器上；
    // 落在别处（比如包一层 fillText）就拦不住它。
    class FakeCtx {
      _font = "";
      get font(): string { return this._font; }
      set font(v: string) { this._font = v; }
    }
    const ctx = new FakeCtx();
    installCjkFallback(ctx);
    ctx.font = 'normal normal 22px "绝不存在的字族XYZ", monospace';
    expect(ctx.font).toBe(`normal normal 22px "${CJK ?? ""}"`);
  });

  it("解析不出字族的字符串原样返回 —— 猜错了改坏一张图，不如什么都不做", () => {
    expect(substituteFamily("10px", "宋", installed)).toBe("10px");
    expect(substituteFamily("", "宋", installed)).toBe("");
  });
});
