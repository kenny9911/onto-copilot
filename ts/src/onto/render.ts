/**
 * 栅格化 —— PDF → PNG、SVG → PNG，**全在本进程内**。
 *
 * 这两件事以前由 pymupdf 在一个 Python 辅助进程里做，现在全在本进程：PDF 走
 * `pdfjs-dist` + `@napi-rs/canvas`，SVG 走 `@resvg/resvg-js`。跨进程那条路连同
 * 那个进程一起没有了。
 *
 * ── 三条必须钉住的行为（都是拿 pymupdf 对照跑出来的）────────────────
 *
 * 1. **位图尺寸向上取整，不是截断。** MuPDF 的 `fz_round_rect` 把页矩形扩成包含
 *    它的整数矩形（x0 floor、x1 ceil），所以 595.276pt × zoom2 = 1190.552 → **1191**。
 *    pdfjs 自带的 `canvasFactory.create(viewport.width, ...)` 走的是截断 → 1190。
 *    差一像素不会让人一眼看出来，但它会让"同一份 PDF 两个宿主渲染结果一致"这句话
 *    变成假的，而这正是这次替换唯一能验的东西。所以这里显式 `Math.ceil`。
 *
 * 2. **白底。** pymupdf 的 `get_pixmap()` 默认不带 alpha（白底）；pdfjs 的画布
 *    默认也用 `#ffffff` 填底（`canvas.mjs` 的 `beginDrawing`）。两边碰巧一致，
 *    但别把它当"反正都一样"—— 一旦谁传了 `background`，送进视觉模型的就是一张
 *    透明底的图，模型看到的是黑底白字。
 *
 * 3. **没有嵌入字体的中文 PDF 要自己兜字库。** MuPDF 自带 CJK 兜底字体，
 *    pdfjs 没有：它把 PDF 里的 BaseFont 名（比如 `Heiti`）原样写进
 *    `ctx.font`，交给画布的系统字体匹配。macOS 上 `Heiti` 会被模糊匹配到
 *    **繁体**的 `Heiti TC`，于是「采购申请审批」渲染成「采⊠申⊠⊠批」——
 *    购/请/审 三个简体独有字变成豆腐块。而豆腐块进视觉模型 = OCR 读出错字，
 *    这份材料后面所有断言都跟着错。{@link installCjkFallback} 就是补这一刀。
 *
 * ── 一处**优于** pymupdf 的地方（见 divergences）──────────────────
 *
 * MuPDF 的 SVG 渲染器不认 `marker-end` 和 `stroke-dasharray`（Python 侧那条
 * `test_mupdf_drops_markers_and_dashes_when_rasterising_svg` 钉的就是这个缺口）。
 * `diagram.ts` 恰恰用箭头表方向、用虚线表「这条顺序是系统推断的」—— 过 pymupdf
 * 转成 PNG 后这两层编码全没了，推断边和有据可依的边长得一模一样。resvg 两样都画。
 */

import { createRequire } from "node:module";

/**
 * 渲染失败 —— **业务错误**，不是部署问题。
 *
 * 畸形 SVG 是"输入不对"，用户该改的是输入，不是去重启什么东西。渲染搬进本进程
 * 之后已经没有"进程没起来"这种失败了，但这个区分仍然要留在类型上 —— 上层
 * （`dialogue/tools.ts` 的流程图导出）要靠它决定跟用户怎么说。
 */
export class RenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RenderError";
    if (options?.cause !== undefined) this.cause = options.cause;
    // 目标是 ES2023、原生 class 本不需要这行；但构建目标一旦降级，
    // `instanceof RenderError` 会**静默**失效，所有 catch 分支一起失灵。
    Object.setPrototypeOf(this, RenderError.prototype);
  }
}

export interface PngImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

// ══════════════════════════════════════════════════════════════════
//  中文兜底字库
// ══════════════════════════════════════════════════════════════════

/**
 * 兜底 CJK 字族的候选（按序取第一个装了的）。
 *
 * MuPDF 把 CJK 兜底字体**编译进了自己**，所以它在哪台机器上都能出中文；
 * pdfjs / resvg 都只认系统字库。这份名单覆盖 macOS 开发机与常见的 Linux 镜像；
 * 一个都没有的机器上中文会出豆腐块 —— 那是部署缺字体，不是代码缺逻辑，
 * 所以这里**不静默造一个假字体**，让它以肉眼可见的方式坏掉。
 */
export const CJK_FALLBACK_FAMILIES: readonly string[] = [
  "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN",
  "WenQuanYi Zen Hei", "WenQuanYi Micro Hei", "Microsoft YaHei", "SimHei", "SimSun",
  "Hiragino Sans GB", "PingFang SC", "Songti SC", "Heiti SC", "STHeiti",
];

let cjkFamilyCache: string | null | undefined;

/**
 * 这台机器上可用的 CJK 字族名，一个都没有回 `null`。
 *
 * 结果**缓存**：枚举系统字库要扫盘，而一次解析要渲染几十页。
 */
export function cjkFallbackFamily(): string | null {
  if (cjkFamilyCache !== undefined) return cjkFamilyCache;
  cjkFamilyCache = null;
  try {
    // 动态 require：`@napi-rs/canvas` 是原生模块，装载它要几十毫秒 + 一次 dlopen。
    // 上传一份 xlsx 的路径根本不渲染任何东西，不该为它付这笔钱。
    const { GlobalFonts } = requireCanvas();
    const installed = new Set(GlobalFonts.families.map((f) => f.family));
    cjkFamilyCache = CJK_FALLBACK_FAMILIES.find((f) => installed.has(f)) ?? null;
  } catch {
    // 取不到字体表就当没有兜底 —— 渲染照跑，只是中文可能出豆腐块。
    cjkFamilyCache = null;
  }
  return cjkFamilyCache;
}

/**
 * 给一个画布上下文装上"字族不认识就换兜底 CJK 字体"的钩子。
 *
 * 为什么是改 `ctx.font` 而不是注册字体别名：pdfjs 写进 `ctx.font` 的字族名来自
 * **PDF 里的 BaseFont**，每份文件都可能不一样（Heiti / SimSun / STSong / 某个
 * 内部代号…），没法预先一个个注册。而 pdfjs 只有在字体**没内嵌**时才会走
 * `ctx.font` 这条路（内嵌字体是按 path 画的），所以这个钩子影响到的**恰好**是
 * "本来就要靠替换字体来显示"的那一类 —— 与 MuPDF 的替换策略是同一件事。
 *
 * 已装在系统里的字族原样放行（`Helvetica` 这种要保住原来的字形和字宽）。
 */
export function installCjkFallback(ctx: object): void {
  const fallback = cjkFallbackFamily();
  if (fallback === null) return;
  const proto = Object.getPrototypeOf(ctx) as object | null;
  const desc = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, "font");
  // 拿不到访问器就安静地不装 —— 兜底字体是加分项，不该让整条渲染因此失败。
  if (desc?.get === undefined || desc.set === undefined) return;
  const get = desc.get;
  const set = desc.set;
  const canvas = requireCanvas();
  Object.defineProperty(ctx, "font", {
    configurable: true,
    get(this: object): unknown {
      return get.call(this);
    },
    set(this: object, value: unknown): void {
      set.call(this, substituteFamily(String(value), fallback, (name) =>
        canvas.GlobalFonts.has(name)));
    },
  });
}

/**
 * `"normal normal 22px \"Heiti\", monospace"` → `"normal normal 22px \"兜底\""`。
 *
 * 系统里有这个字族（`has()` 为真）就原样返回。解析不出字族名的也原样返回 ——
 * 猜错了改坏一张图，不如什么都不做。
 */
export function substituteFamily(
  font: string,
  fallback: string,
  installed: (family: string) => boolean,
): string {
  // 字号与字族之间必有空格；字族列表从第一个字族起到行尾。
  const m = /^(.*?\d(?:\.\d+)?(?:px|pt|em|rem|%)\s+)(.+)$/.exec(font);
  if (m === null) return font;
  const first = (m[2] ?? "").split(",")[0]?.trim() ?? "";
  const family = first.replace(/^["']|["']$/g, "");
  if (family === "" || installed(family)) return font;
  return `${m[1] ?? ""}"${fallback}"`;
}

// ══════════════════════════════════════════════════════════════════
//  SVG → PNG
// ══════════════════════════════════════════════════════════════════

/** zoom 的上下限。见 {@link svgToPng}。 */
export const SVG_MIN_ZOOM = 0.1;
export const SVG_MAX_ZOOM = 8.0;
export const SVG_DEFAULT_ZOOM = 2.0;

/**
 * 一张 SVG → PNG。
 *
 * zoom **必须夹在 [0.1, 8]**：它直接乘进画布边长，像素数是
 * 它的平方 —— 一个 4000×3000 的图配 zoom=20 就是 70 亿像素。SVG 的尺寸和 zoom
 * 都来自调用方，所以这里必须有天花板；8 倍已经远超任何印刷需求。
 *
 * 畸形 SVG 抛 {@link RenderError}，**不是**让 resvg 那个 panic 冒到上面去 ——
 * 上层要能把"输入不对"和"渲染器坏了"分开说。
 */
export function svgToPng(svg: string, opts: { zoom?: number } = {}): PngImage {
  const raw = opts.zoom ?? SVG_DEFAULT_ZOOM;
  // NaN 落到默认值：`Math.min(8, Math.max(0.1, NaN))` 是 NaN，会一路传进 resvg
  // 变成一张 0×0 的图。
  const zoom = Number.isFinite(raw)
    ? Math.min(SVG_MAX_ZOOM, Math.max(SVG_MIN_ZOOM, raw))
    : SVG_DEFAULT_ZOOM;
  const { Resvg } = requireResvg();
  const family = cjkFallbackFamily();
  try {
    const img = new Resvg(svg, {
      fitTo: { mode: "zoom", value: zoom },
      font: {
        loadSystemFonts: true,
        // `diagram.ts` 出的图写的是 `font-family="-apple-system,PingFang SC,…"`。
        // 这几个名字在 Linux 镜像里一个都不存在，resvg 会退到它自己的默认
        // （Times New Roman）—— 那个字体没有汉字，整张流程图的中文全成豆腐块。
        ...(family === null ? {} : { defaultFontFamily: family }),
      },
      // 渲染器的日志不该出现在服务端的 stdout 里（那里跑的是业务日志）。
      logLevel: "off",
    }).render();
    return { png: img.asPng(), width: img.width, height: img.height };
  } catch (e) {
    throw new RenderError(`SVG 渲染失败: ${errText(e)}`, { cause: e });
  }
}

// ══════════════════════════════════════════════════════════════════
//  PDF → PNG
// ══════════════════════════════════════════════════════════════════

export interface PdfPages {
  /** 每页一张 PNG 的 base64（不带 data URI 前缀）。 */
  readonly pages: readonly string[];
  /** 还有没渲染的页 —— **不静默截断**，调用方要把这件事说出来。 */
  readonly truncated: boolean;
}

/** PDF 文本层的一页。扫描页的 `text` 为空，调用方据此决定是否走视觉 OCR。 */
export interface PdfTextPage {
  readonly page: number;
  readonly text: string;
}

export interface PdfTextPages {
  readonly pages: readonly PdfTextPage[];
  readonly totalPages: number;
  /** 还有没读取的页 —— 与图片渲染一样，绝不静默截断。 */
  readonly truncated: boolean;
}

export const PDF_DEFAULT_MAX_PAGES = 20;
export const PDF_DEFAULT_ZOOM = 2.0;

/**
 * PDF 每页渲染成 PNG。返回 base64，调用方自己决定落盘还是直接喂视觉模型
 * （与被替掉的 `/pdf/render` 逐字段同形，所以上面那层是一行改动）。
 */
export async function pdfToPngs(
  data: Uint8Array,
  opts: { maxPages?: number; zoom?: number } = {},
): Promise<PdfPages> {
  const maxPages = opts.maxPages ?? PDF_DEFAULT_MAX_PAGES;
  const zoom = opts.zoom ?? PDF_DEFAULT_ZOOM;
  const { task, doc } = await openPdf(data);

  try {
    const pages: string[] = [];
    const total = doc.numPages;
    for (let pno = 1; pno <= Math.min(total, maxPages); pno += 1) {
      const page = await doc.getPage(pno);
      try {
        const viewport = page.getViewport({ scale: zoom });
        // ceil 而不是 pdfjs 自己那套截断 —— 见文件头 1。
        const { canvas, context } = (doc.canvasFactory as CanvasFactoryLike).create(
          Math.ceil(viewport.width), Math.ceil(viewport.height));
        installCjkFallback(context as object);
        await page.render({ canvasContext: context, viewport, canvas }).promise;
        pages.push(toPngBase64(canvas));
      } finally {
        // 一页几十 MB 的位图。几十页不 cleanup 就是几个 G。
        page.cleanup();
      }
    }
    return { pages, truncated: pages.length < total };
  } finally {
    await task.destroy();
  }
}

/**
 * 直接读取 born-digital PDF 的文本层。
 *
 * 这条路不调模型：合同、制度、电子发票等本来就带可检索文字的 PDF 应该先走它；
 * 只有返回空文本的页才需要栅格化后交给视觉 OCR。过去把所有 PDF 都当扫描件，既慢、
 * 又贵，还会把本来精确的字符重新识别错。
 */
export async function pdfToTextPages(
  data: Uint8Array,
  opts: { maxPages?: number } = {},
): Promise<PdfTextPages> {
  const maxPages = opts.maxPages ?? PDF_DEFAULT_MAX_PAGES;
  const { task, doc } = await openPdf(data);
  try {
    const pages: PdfTextPage[] = [];
    const totalPages = doc.numPages;
    for (let pno = 1; pno <= Math.min(totalPages, maxPages); pno += 1) {
      const page = await doc.getPage(pno);
      try {
        const content = await page.getTextContent();
        pages.push({ page: pno, text: joinPdfText(content.items) });
      } finally {
        page.cleanup();
      }
    }
    return { pages, totalPages, truncated: pages.length < totalPages };
  } finally {
    await task.destroy();
  }
}

// ══════════════════════════════════════════════════════════════════
//  装载
// ══════════════════════════════════════════════════════════════════

const nodeRequire = createRequire(import.meta.url);

/**
 * `doc.canvasFactory` 的形状。pdfjs 的 .d.ts 把它标成 `Object`（它在 Node 上
 * 是内部的 `NodeCanvasFactory`，走 `@napi-rs/canvas`），所以这里自己写一份。
 */
interface CanvasFactoryLike {
  create(width: number, height: number): {
    // pdfjs 的 `render()` 参数把 canvas 标成 DOM 的 `HTMLCanvasElement`；
    // Node 上真身是 skia 的画布，两者只在这一处相遇。
    canvas: HTMLCanvasElement;
    context: unknown;
  };
}

type CanvasModule = typeof import("@napi-rs/canvas");
type ResvgModule = typeof import("@resvg/resvg-js");
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfLoadingTask = ReturnType<PdfjsModule["getDocument"]>;
type PdfDocument = Awaited<PdfLoadingTask["promise"]>;

function requireCanvas(): CanvasModule {
  return nodeRequire("@napi-rs/canvas") as CanvasModule;
}

function requireResvg(): ResvgModule {
  return nodeRequire("@resvg/resvg-js") as ResvgModule;
}

let pdfjsCache: Promise<PdfjsModule> | undefined;

/**
 * pdfjs 的 **legacy** 构建，懒装载。
 *
 * legacy 而不是默认构建：默认构建假定浏览器（`DOMMatrix`、`structuredClone` 的
 * 某些形态、顶层 `document`），在 Node 上会在渲染到一半时炸。
 *
 * 懒装载是因为它有几 MB —— 一次上传 xlsx 的请求不该为一个用不到的 PDF 渲染器
 * 付启动时间。
 */
function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsCache ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsCache;
}

/** 打开 PDF 的唯一边界：统一二进制形态、资源 URL与错误类型。 */
async function openPdf(data: Uint8Array): Promise<{
  task: PdfLoadingTask;
  doc: PdfDocument;
}> {
  const pdfjs = await loadPdfjs();
  const assets = pdfjsAssetRoot();
  let task: PdfLoadingTask | undefined;
  try {
    task = pdfjs.getDocument({
      // 必须显式造一份**原生 Uint8Array**，不能只写 `data.slice()`：
      // `fs.readFile()` 返回的 Buffer 虽然在类型上继承 Uint8Array，但它的 slice()
      // 仍然是 Buffer，而 pdfjs 6 会在运行时拒绝 Buffer。真实上传路径因此会报
      // "Please provide binary data as Uint8Array"，只有单测里手造的 Uint8Array 能过。
      // 同时这也是一份拷贝：pdfjs 会 transfer/改写传入内存，不能毁掉调用方字节。
      data: new Uint8Array(data),
      // 标准字体与 CMap 同时服务于渲染和文本层字符映射。
      standardFontDataUrl: `${assets}standard_fonts/`,
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      verbosity: 0,
    });
    return { task, doc: await task.promise };
  } catch (e) {
    // getDocument 的参数校验是同步抛，文档读取是 task.promise 异步拒绝；两条都要
    // 收成同一种业务错误，否则前端会时而看到中文、时而看到 pdfjs 的内部英文。
    if (task !== undefined) {
      try {
        await task.destroy();
      } catch {
        // 打开都失败了，清理失败不能盖掉真正原因。
      }
    }
    throw new RenderError(`PDF 打不开: ${errText(e)}`, { cause: e });
  }
}

/** pdfjs 的 TextItem 流 → 保留显式换行的可检索文本。 */
function joinPdfText(items: readonly unknown[]): string {
  let out = "";
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as { str?: unknown; hasEOL?: unknown };
    if (typeof item.str !== "string") continue; // TextMarkedContent 没有 str
    const text = item.str;
    if (text !== "" && out !== "" && !/[\s]$/u.test(out) && !/^[\s]/u.test(text)) out += " ";
    out += text;
    if (item.hasEOL === true && !out.endsWith("\n")) out += "\n";
  }
  return out
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

/** 装好的 pdfjs 包目录（末尾带 `/`）—— 字体与 cmap 都在它下面。 */
function pdfjsAssetRoot(): string {
  return nodeRequire.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");
}

/** `@napi-rs/canvas` 的画布 → PNG 字节。pdfjs 的类型里 canvas 是 `unknown` 形状。 */
function toPngBase64(canvas: unknown): string {
  const buf = (canvas as { toBuffer(mime: "image/png"): Buffer }).toBuffer("image/png");
  return buf.toString("base64");
}

/** `str(exc)`：错误消息，非 Error 也要给出点东西。 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
