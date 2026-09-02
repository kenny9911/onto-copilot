/**
 * 扫描件与 PDF 解析 —— 用视觉模型做 OCR。
 *
 * 扫描件是本体建模里最难的一类材料：ER 图、手绘表格、拍照的纸质台账。传统 OCR
 * 只出文字流，丢掉版式和框线关系；而 ER 图里**框与框之间的连线就是 LinkType**，
 * 丢了关系就等于什么都没读到。
 *
 * 所以这里让视觉模型直接输出**结构化的版式结果**：文本块、表格、实体框、连线，
 * 每项带归一化 bbox。bbox 让每条断言都能点回图上的确切位置 —— 与其它格式一样，
 * 没有 locator 的结论在这个产品里没有价值。
 *
 * **能力是硬要求，不做降级。** 没有具备 VISION 的模型时直接报错，而不是退回到
 * "凭文件名猜内容" —— 后者会产出一份看起来正常、实际全是编的结果。
 *
 * ── TS 侧的两处结构性差异（见 notes，不是随手改的）────────────────
 *
 * 1. **没有 `_downscale`。** Python 用 PIL 把长边压到 `MAX_EDGE` 再统一转 PNG；
 *    Node 侧没有对等物，图片原样送出（PDF 那条路按 zoom 渲染）。
 *    后果只是**更贵**，不是更错。
 * 2. **没有同步 `parse` 抛错那一条。** `base.ts` 的 `Parser.parse` 本身就是
 *    async（它的文件头解释了为什么），Python 那个"同步入口不支持"的护栏
 *    在这边没有对应的坑可挡。
 *
 * PDF→图**在本进程内**做（`onto/render.ts`，pdfjs + @napi-rs/canvas）。它替掉的是
 * pymupdf：同一份 PDF 两边渲染出的页数与每页像素尺寸逐页相等，理由与取整规则
 * 写在 `render.ts` 的文件头。
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { Capability, LookupError as NoCapableModel } from "../../kernel/catalog.js";
import { formatFixed0 } from "../../kernel/errors.js";
import {
  type PdfPages,
  type PdfTextPages,
  pdfToPngs,
  pdfToTextPages,
} from "../render.js";
import type { ParsedDoc } from "./base.js";
import { Parser, makeChunk, makeFinding, makeParsedDoc } from "./base.js";
import { pyFloat, pyMax, pyMin, pyStrip } from "./doc/pycompat.js";
import { RULE_HINTS, headingOf, splitSections } from "./text.js";

/**
 * 送进模型前的长边上限。再大不会更准，只会更贵 —— 当前一代视觉模型的
 * 有效分辨率大约到这个量级。
 *
 * TS 侧**没有**执行这个缩放（没有 PIL 对等物），保留常量是因为 PDF 那条路的
 * 渲染倍率最终要按它对齐。
 */
export const MAX_EDGE = 2000;

/**
 * 一页 OCR 的输出预算。一张上百节点的业务流程图，光 blocks + relations 就要
 * 一两万 token；8000 会让输出在中途被截断，然后 schema 校验报「JSON 不完整」，
 * 重试同样的预算再撞两次，整份材料就废了。会思考的模型还要再吃掉一部分预算。
 */
export const OCR_MAX_TOKENS = 24_000;

/**
 * 单页识别的时间上限。
 *
 * **这是"每次识别图片都失败"的真凶。** 实测同一张上百节点的流程图：
 *     claude-opus-4.8   287s  114 blocks / 14 relations
 *     gemini-3.5-flash  152s   44 blocks / 34 relations
 *     gpt-5.4-mini       19s   89 blocks /  0 relations
 * 而上限是 150s —— 于是**每一次都在正常出结果的途中被掐掉**。更糟的是取消不写
 * effect.failed，日志里只剩一条没有结局的 requested，看上去像"卡住了"而不是
 * "被我们自己杀了"。
 *
 * 现在给足余量（最慢的一档 287s + 网络抖动），但仍然有上限 —— 无限等就是界面上
 * 永远的"解析中"。
 */
export const OCR_TIMEOUT_MS = 600_000;

/**
 * 优先用来做识别的模型（按序，缺的自动跳过）。
 *
 * 同一张上百节点的流程图实测：
 *     gemini-3.5-flash  152s   44 blocks / **34 relations**
 *     claude-opus-4.8   287s  114 blocks /   14 relations
 *     gpt-5.4-mini       19s   89 blocks /    0 relations
 * 按通用的"质量优先"会挑 opus —— 最贵最慢，**连线却只有一半**。而对流程图来说
 * 连线（谁触发谁）就是核心信息，缺了它这张图只是一堆孤立的框。所以这里按
 * **这个任务上的实测表现**排，而不是按模型的通用档位。
 */
export const OCR_PREFER_MODELS: readonly string[] = [
  "google/gemini-3.5-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
];

/** PDF 渲染倍率。2.0 对应约 144 DPI，中文小字够认。 */
export const PDF_ZOOM = 2.0;

/** 需要的模型能力。catalog.ts 已落地，用它的枚举 —— 写成 `readonly string[]`
 * 的话 `SmartGateway` 结构上就不满足下面那个端口，接线处只能靠 `as` 把类型
 * 对不上这件事藏起来。 */
export const OCR_NEEDS: readonly Capability[] = [Capability.VISION, Capability.STRUCTURED];

export const OCR_SCHEMA = {
  type: "object",
  required: ["blocks", "tables", "relations"],
  properties: {
    blocks: {
      type: "array",
      description: "页面上的文本块，按阅读顺序",
      items: {
        type: "object",
        required: ["text", "bbox", "kind"],
        properties: {
          text: { type: "string" },
          kind: {
            type: "string",
            enum: ["title", "entity_box", "field", "note", "paragraph"],
          },
          bbox: {
            type: "array", items: { type: "number" },
            description: "归一化 [x0,y0,x1,y1]，取值 0~1",
          },
        },
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object",
        required: ["rows", "bbox"],
        properties: {
          caption: { type: "string" },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
          bbox: { type: "array", items: { type: "number" } },
        },
      },
    },
    relations: {
      type: "array",
      description: "实体框之间的连线。ER 图里这些就是 LinkType。",
      items: {
        type: "object",
        required: ["from_entity", "to_entity"],
        properties: {
          from_entity: { type: "string" },
          to_entity: { type: "string" },
          label: { type: "string", description: "线上的标注，如 1:N" },
        },
      },
    },
  },
} as const;

export const OCR_SYSTEM = `你是版式识别器。把图片里的内容原样读出来，输出结构化结果。

规则：
- **原样转录**，不要翻译、不要补全、不要纠正你认为写错的地方。看不清的字用 ⿰ 代替。
- bbox 用归一化坐标 [x0,y0,x1,y1]，左上为原点，取值 0~1。
- ER 图里的方框是 entity_box，框内字段是 field，框之间的连线进 relations。
- 连线上的基数标注（1:N、1..*、多对多）一定要读进 relations.label —— 那是建模的关键信息。
- 表格进 tables，第一行按表头处理。
- 图里没有的东西一个字都不要加。`;

/** 网关调用的返回。真身是 `kernel/catalog.py` 的 `Completion`，这里只用 `data`。 */
export interface VisionCompletion {
  readonly data?: unknown;
}

/**
 * `SmartGateway` 里本模块用到的那一个方法。
 *
 * 写成结构化接口而不是 import 具体类：catalog 还没移植，而这个解析器只需要
 * "按能力选型并调用"这一件事。catalog.ts 落地后 `SmartGateway` 天然满足它。
 */
export interface VisionGateway {
  call(nodeId: string, prompt: string, opts: {
    needs: readonly string[];
    preferModels: readonly string[];
    prefer: string;
    system: string;
    // 与 llm.ts 的 CallOptions 同口径 —— `unknown` 会让 SmartGateway 赋不进来。
    schema: Record<string, unknown> | null;
    maxTokens: number;
    images: readonly string[];
    key: string;
  }): Promise<VisionCompletion>;
}

// 「网关上没有满足能力要求的模型」== catalog.require 抛的 LookupError，
// **是同一件事**，所以用同一个类。各写一份的话 `instanceof NoCapableModel`
// 对 catalog 抛出来的那个恒为 false —— 症状不是崩溃，是 vision 把「网关上
// 没有视觉模型」降级成一句泛泛的「视觉识别失败」，用户照着这句话永远查不到
// 该去网关上开一个带视觉的模型，扫描件内容就一直不进产物。
export { NoCapableModel };

/** 单页识别超时。== Python 的 `asyncio.TimeoutError`。 */
export class VisionTimeout extends Error {
  constructor(message = "vision call timed out") {
    super(message);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, VisionTimeout.prototype);
  }
}

export interface VisionParserOptions {
  /** `quality` 或 `cost`。整本扫描件 PDF 用 `cost`（几十页 × 旗舰模型会很贵），
   *  关键的 ER 图用 `quality`。 */
  prefer?: string;
  /** PDF 最多处理多少页。超出的页会在 findings 里明说 —— **不静默截断**。 */
  maxPages?: number;
  nodeId?: string;
  /** 每页开始/结束回调一次。一页要几分钟，不报进度的话界面上就是几分钟的
   *  死寂，用户分不清在识别还是又挂了。 */
  onProgress?: (message: string) => void;
  /** PDF→图的执行者。不传就用本进程的 {@link pdfToPngs}。留这个口子是为了
   *  让测试不必造一份真 PDF —— 不是为了再挂一个远端渲染服务。 */
  renderPdf?: PdfPageRenderer;
  /** PDF 文本层读取器。电子 PDF 先走它，只有空白页才回退视觉 OCR。 */
  extractPdfText?: PdfTextExtractor;
}

/** `pdfToPngs` 的形状。== `render.ts` 那一个，写成端口只为可注入。 */
export type PdfPageRenderer = (
  data: Uint8Array,
  opts: { maxPages?: number; zoom?: number },
) => Promise<PdfPages>;

export type PdfTextExtractor = (
  data: Uint8Array,
  opts: { maxPages?: number },
) => Promise<PdfTextPages>;

/** 扫描件 / 图片 / PDF。 */
export class VisionParser extends Parser {
  override readonly kind = "scan";
  override readonly extensions = [
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
  ];

  readonly prefer: string;
  readonly maxPages: number;
  readonly nodeId: string;
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly renderPdf: PdfPageRenderer | undefined;
  private readonly extractPdfText: PdfTextExtractor | undefined;

  constructor(
    readonly gateway: VisionGateway | null = null,
    opts: VisionParserOptions = {},
  ) {
    super();
    this.prefer = opts.prefer ?? "quality";
    this.maxPages = opts.maxPages ?? 20;
    this.nodeId = opts.nodeId ?? "PARSE.scan";
    this.onProgress = opts.onProgress;
    this.renderPdf = opts.renderPdf;
    this.extractPdfText = opts.extractPdfText;
  }

  private note(message: string): void {
    if (this.onProgress === undefined) return;
    try {
      this.onProgress(message);
    } catch {
      // 报进度失败不该影响识别。Python 那里是 `except Exception` + 显式 return，
      // 理由一样：进度回调明确是 best-effort。
    }
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileId = opts.fileId;
    const fileName = basename(path);
    const doc = makeParsedDoc({ fileId, fileName, kind: this.kind });
    const isPdf = extname(path).toLowerCase() === ".pdf";
    let order = 0;
    let pdfText: PdfTextPages | null = null;
    const nativeTextPages = new Set<number>();

    // 电子 PDF 先读它本来就有的文本层。合同、制度、电子发票不需要先画成图片再
    // 让模型猜一遍字符；那样既多花钱，也会把精确文字重新 OCR 错。混合 PDF 则只
    // 把没有文本层的页留给下面的视觉回退。
    if (isPdf) {
      try {
        const extract = this.extractPdfText ?? pdfToTextPages;
        pdfText = await extract(await readFile(path), { maxPages: this.maxPages });
      } catch (e) {
        doc.findings.push(makeFinding(
          "parse_failed",
          `${fileName} 无法读取：${errorText(e)}`,
          {},
          "warn",
        ));
        return doc;
      }

      for (const page of pdfText.pages) {
        const text = pyStrip(page.text);
        if (text === "") continue;
        nativeTextPages.add(page.page);
        for (const block of splitSections(text)) {
          const heading = headingOf(block);
          doc.chunks.push(makeChunk({
            docId: `p${page.page}text${order}`,
            fileId,
            fileName,
            locator: {
              kind: "page",
              page: page.page,
              bbox: [0, 0, 1, 1],
              section: heading || `§${order + 1}`,
            },
            render: (heading ? `〔${heading}〕\n` : "") + block,
            raw: { source: "pdf_text_layer", text: block },
            order,
            tags: RULE_HINTS.test(block) ? ["pdf", "text", "rule"] : ["pdf", "text"],
          }));
          order += 1;
        }
      }

      if (nativeTextPages.size > 0) {
        doc.findings.push(makeFinding(
          "pdf_text_ok",
          `已直接读取 ${fileName} 的 ${nativeTextPages.size} 页文本层，无需重复 OCR`,
          {},
          "info",
        ));
      }
      if (pdfText.truncated) {
        doc.findings.push(makeFinding(
          "page_limit", `只读取了前 ${this.maxPages} 页，其余未处理`, {}, "warn"));
      }

      // 本次允许处理的页都有文本层：零模型调用即可完成。
      if (pdfText.pages.length > 0 && nativeTextPages.size === pdfText.pages.length) {
        doc.structured = {
          pages: pdfText.pages.length,
          total_pages: pdfText.totalPages,
          text_pages: nativeTextPages.size,
          ocr_pages: 0,
          relations: [],
          blocks: doc.chunks.length,
        };
        return doc;
      }
    }

    if (this.gateway === null) {
      // 上传时这条路是**故意**不带视觉网关的：识别要调模型、要花钱，不该由
      // "拖了个文件进来"触发，留到梳理时做。以前这里一律报"没有配置视觉网关"，
      // 读起来像配置坏了 —— 用户会去查网关，而其实什么都没坏，只是还没到时候。
      doc.findings.push(makeFinding(
        "vision_pending",
        isPdf
          ? `${fileName} 有 ${Math.max(0, (pdfText?.pages.length ?? 0) - nativeTextPages.size)}`
            + " 页没有可读文本层，要用视觉模型识别。**点「开始梳理」时才会识别**。"
          : `${fileName} 是图片/扫描件，要用视觉模型识别。**点「开始梳理」时`
            + `才会识别**（识别要调模型），现在只登记了文件、还没读内容。`,
        {}, "info"));
      if (isPdf) {
        doc.structured = {
          pages: pdfText?.pages.length ?? 0,
          total_pages: pdfText?.totalPages ?? 0,
          text_pages: nativeTextPages.size,
          ocr_pages: 0,
          relations: [],
          blocks: doc.chunks.length,
        };
      }
      return doc;
    }

    const renderedPages = await renderPages(path, {
      maxPages: this.maxPages,
      ...(this.renderPdf === undefined ? {} : { renderPdf: this.renderPdf }),
    });
    if (!isPdf && renderedPages.length === this.maxPages) {
      doc.findings.push(makeFinding(
        "page_limit", `只识别了前 ${this.maxPages} 页，其余未处理`, {}, "warn"));
    }

    const pages = renderedPages
      .map((dataUri, pageIndex) => ({ pno: pageIndex + 1, dataUri }))
      .filter((page) => !nativeTextPages.has(page.pno));
    const allRelations: Array<Record<string, unknown>> = [];
    let ocrCompletedPages = 0;
    this.note(`开始识别 ${fileName}（${pages.length} 页）。`
      + `密集的图一页可能要 2–5 分钟，请等它跑完。`);

    for (const { pno, dataUri } of pages) {
      const t0 = performance.now();
      this.note(`正在识别第 ${pno}/${renderedPages.length} 页…`);
      // 视觉调用必须**有超时、且失败不炸整条 build**。否则网关上没有可用视觉模型
      // （require 抛错）或调用卡住时，PARSE 会一直挂在这里 —— 界面上就是「一直
      // 正在梳理」，而根因（没有视觉模型）被埋在一个永不返回的 await 里。
      let comp: VisionCompletion;
      try {
        comp = await withTimeout(
          this.gateway.call(this.nodeId, `识别第 ${pno} 页的全部内容。`, {
            needs: OCR_NEEDS,
            preferModels: OCR_PREFER_MODELS,
            prefer: this.prefer,
            system: OCR_SYSTEM,
            schema: OCR_SCHEMA,
            maxTokens: OCR_MAX_TOKENS,
            images: [dataUri],
            key: `ocr:p${pno}`,
          }),
          OCR_TIMEOUT_MS);
      } catch (e) {
        const why = e instanceof NoCapableModel
          ? "网关上没有可用的视觉模型"
          : e instanceof VisionTimeout
            ? "视觉识别超时"
            : `视觉识别失败（${typeName(e)}）`;
        doc.findings.push(makeFinding(
          "vision_failed",
          `扫描件第 ${pno} 页${why}。请在网关上确认有带视觉的模型`
          + `（gemini-* / gpt-4o / claude-3 等），这份材料的内容没有进入产物。`,
          {}, "warn"));
        break; // 一页就失败，后面多半也一样 —— 别把超时乘以页数
      }

      const page = asRecord(comp.data);
      const blocks = asArray(page["blocks"]);
      const tables = asArray(page["tables"]);
      const relations = asArray(page["relations"]);
      ocrCompletedPages += 1;
      this.note(
        `第 ${pno} 页识别完成（${formatFixed0((performance.now() - t0) / 1000)} 秒）：`
        + `${blocks.length} 个文本块、${tables.length} 张表、${relations.length} 条连线`);

      for (const raw of blocks) {
        const b = asRecord(raw);
        // `(b.get("text") or "").strip()`：Python 的真值判断，`0` / `false` 也算空。
        const text = pyStrip(pyTruthy(b["text"]) ? pyStr(b["text"]) : "");
        if (!text) continue;
        // `.get(k, default)` 只在**键不存在**时给默认值；键在但为 null 时给 null。
        const kindPresent = "kind" in b;
        doc.chunks.push(makeChunk({
          docId: `p${pno}b${order}`, fileId, fileName,
          locator: {
            kind: "page", page: pno, bbox: normalizeBbox(b["bbox"]),
            role: kindPresent ? b["kind"] : "",
          },
          render: `〔${kindPresent ? pyStr(b["kind"]) : "text"}〕${text}`,
          raw, order,
          tags: ["ocr", kindPresent ? pyStr(b["kind"]) : "paragraph"],
        }));
        order += 1;
      }

      for (const [ti, rawTable] of tables.entries()) {
        const t = asRecord(rawTable);
        const rows = asArray(t["rows"]);
        if (rows.length === 0) continue;
        // **raw 必须是 {列名: 值} 扁平字典（B9）。** 上一版存的是
        // `{header, row}` 嵌套原样 —— classifyColumns 对它 Object.entries 后
        // 得到两"列"叫 header 和 row、值是数组：列分类全掉进兜底，
        // 形状被误判成「一行一实体」，模型对着不存在的行数较劲。
        // pptx 表格那边（presentation.ts）早修成扁平了，这里是同族的漏网：
        // **拍照/扫描的字段表走的就是这条路**。表头缺格用 C{n} 兜底名，
        // 与 pptx/CSV 同一条规矩。
        const header = asArray(rows[0]);
        for (const [ri, rawRow] of rows.slice(1).entries()) {
          const row = asArray(rawRow);
          const flat: Record<string, string> = {};
          row.forEach((value, i) => {
            const name = i < header.length && pyTruthy(header[i]) ? pyStr(header[i]) : `C${i + 1}`;
            flat[name] = pyStr(value);
          });
          doc.chunks.push(makeChunk({
            docId: `p${pno}t${ti}r${ri}`, fileId, fileName,
            locator: {
              kind: "page", page: pno, bbox: normalizeBbox(t["bbox"]),
              table: ti, row: ri + 1,
            },
            render: row
              .map((value, i) => ({ value, i }))
              .filter((cell) => cell.i < header.length && pyTruthy(cell.value))
              .map((cell) => `${pyStr(header[cell.i])}=${pyStr(cell.value)}`)
              .join(" | "),
            // tag 用 row（数据行），不是 table —— isDataRow 不挡、readiness 计得进
            raw: flat, order, tags: ["ocr", "row"],
          }));
          order += 1;
        }
      }

      for (const rawRelation of relations) {
        const r = asRecord(rawRelation);
        const labelRaw = "label" in r ? r["label"] : "";
        const label = pyStr(labelRaw);
        allRelations.push({ ...r, page: pno });
        doc.chunks.push(makeChunk({
          docId: `p${pno}rel${order}`, fileId, fileName,
          locator: { kind: "page", page: pno, bbox: [0, 0, 1, 1] },
          render: `〔关系〕${pyStr(r["from_entity"])} —${label}— ${pyStr(r["to_entity"])}`
            + (pyTruthy(labelRaw) ? "　（图中标注的基数，可作 LinkType 依据）" : ""),
          raw: rawRelation, order, tags: ["ocr", "relation", "rule"],
        }));
        order += 1;
      }
    }

    doc.structured = isPdf
      ? {
          pages: pdfText?.pages.length ?? renderedPages.length,
          total_pages: pdfText?.totalPages ?? renderedPages.length,
          text_pages: nativeTextPages.size,
          ocr_pages: ocrCompletedPages,
          relations: allRelations,
          blocks: doc.chunks.length,
        }
      : {
          pages: renderedPages.length,
          relations: allRelations,
          blocks: doc.chunks.filter((c) => c.tags.includes("ocr")).length,
        };
    if (doc.chunks.length === 0) {
      doc.findings.push(makeFinding(
        "empty_ocr", "视觉模型没有从这份材料里读出任何内容", {}, "warn"));
    } else if (ocrCompletedPages > 0) {
      // **识别成功也要明说。** 只在失败时说话，用户看到的是一片沉默 ——
      // 分不清"读出来了"和"又卡住了"。
      doc.findings.push(makeFinding(
        "vision_ok",
        `已识别 ${fileName}：${ocrCompletedPages} 页、${doc.chunks.length} 段内容`
        + (allRelations.length > 0 ? `、${allRelations.length} 条连线关系` : ""),
        {}, "info"));
    }
    return doc;
  }
}

// ══════════════════════════════════════════════════════════════════
//  渲染
// ══════════════════════════════════════════════════════════════════

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/**
 * 把材料渲染成 base64 data URI 列表。PDF 逐页渲染，图片就是一页。
 *
 * 与 Python 的差别（见文件头 1）：不缩放、不统一转 PNG，所以 data URI 的
 * media type 按**真实扩展名**给。Python 那边一律写 `image/png` 是因为 PIL 确实
 * 重新编码过；这边照抄那个写法的话，一张 jpg 会被贴上 png 的标签送进模型。
 */
export async function renderPages(path: string, opts: {
  maxPages?: number;
  renderPdf?: PdfPageRenderer;
} = {}): Promise<string[]> {
  const maxPages = opts.maxPages ?? 20;
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") {
    const render = opts.renderPdf ?? pdfToPngs;
    const rendered = await render(await readFile(path), { maxPages, zoom: PDF_ZOOM });
    return rendered.pages.map((b64) => `data:image/png;base64,${b64}`);
  }
  const mime = IMAGE_MIME[ext] ?? "image/png";
  return [`data:${mime};base64,${(await readFile(path)).toString("base64")}`];
}

/**
 * 超时。**这不是取消**（契约 §2.2：Node 上没有真正的取消）——
 * 超时只让我们停止等待，底层那次网关调用还在跑，直到它自己结束。
 * 代价是一次泄漏的请求；收益是界面不会永远停在"解析中"。
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VisionTimeout()), ms);
        // unref：一个还没触发的定时器会让 Node 进程不肯退出，测试里表现为挂住。
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** == Python `type(exc).__name__`。 */
function typeName(e: unknown): string {
  if (e instanceof Error) return e.constructor.name;
  return typeof e;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** == Python `str(x)` / f-string 插值：`None`→"None"、`True`→"True"。
 *  模型返回的 JSON 里 `null` 很常见，写成 "null" 就与 Python 时代的产物对不上。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** == Python `if x:`。JS 的真值判断在**空数组/空对象**上与 Python 相反。 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * 归一化 bbox，坏值退回整页 —— 位置不准好过没有位置。
 *
 * **这里必须用 Python 的 min/max 语义**：`max(0.0, min(1.0, nan))` 在 Python 下
 * 是 1.0（NaN 参与比较恒为假，于是被"挤"掉），而 `Math.max(0, Math.min(1, NaN))`
 * 是 NaN。NaN 进 locator，前端画出来的高亮框就消失了。
 */
export function normalizeBbox(raw: unknown): number[] {
  try {
    // 先**整表**转换再切前 4 —— Python 的 `[...][:4]` 就是这个顺序，所以第 5 项
    // 是坏值时整条退回整页，而不是"切掉就当没看见"。
    const vals = iterablePython(raw)
      .map((x) => pyMax(0.0, pyMin(1.0, pyFloat(x))))
      .slice(0, 4);
    return vals.length === 4 ? vals : [0.0, 0.0, 1.0, 1.0];
  } catch {
    return [0.0, 0.0, 1.0, 1.0];
  }
}

/** == Python `for x in (raw or [])`：字符串按字符迭代，dict 按键迭代，
 *  不可迭代的抛（调用方接住后退回整页）。 */
function iterablePython(raw: unknown): unknown[] {
  if (raw === null || raw === undefined || raw === false || raw === 0 || raw === "") {
    return [];
  }
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return [...raw];
  if (typeof raw === "object") {
    const keys = Object.keys(raw as Record<string, unknown>);
    // `{}` 是 falsy 的 Python dict —— 上面那条 `raw or []` 已经把它变成 []。
    return keys;
  }
  throw new TypeError("object is not iterable");
}
