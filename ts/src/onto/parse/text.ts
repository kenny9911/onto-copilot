/**
 * 文本类材料 —— docx / md / txt。移植自 `onto/parse/text.py`。
 *
 * 流程说明文档的价值集中在**规则句**里："一个执行计划可拆入多个采购包"这一句
 * 直接决定 LinkType 的基数。所以切片按**标题层级**分段而不是按固定长度切 ——
 * 固定长度会把一条规则切成两半，两半都失去意义。
 *
 * docx 里的表格单独抽出来，它们通常是字段清单，比正文更结构化。
 *
 * ── docx 的原料从哪来（与 Python 的结构性差异）────────────────────
 *
 * python-docx 做的三件事在 JS 侧没有等价物，而且**都不是**"差不多就行"的东西：
 *   · `p.style.name` 要把 styleId 顺着 styles.xml 解析成显示名，还要认本地化的
 *     "标题 2" —— 分段全靠它，认错了整篇的切片边界就错了；
 *   · `row.cells` 会把合并单元格按跨度展开（真实 Word 表格几乎必有合并）；
 *   · `core_properties` 是 metadata_leak 那条 finding 的唯一来源。
 * mammoth 这类库把 docx 转成 HTML，样式名和 core.xml 在转换里就丢了，
 * 拿它顶上等于**静默改变切片边界**，正是这一层最该避免的失败。
 *
 * 所以 DocxParser 只吃**已经抽好的原料**（`DocxContent`），抽取过程由调用方注入。
 * 抽取器要交出的形状就是 `DocxContent`：`{paragraphs, tables, core}` —— 三样都不能
 * 少（少了 core 就没有 metadata_leak，少了样式名分段就错）。切段策略（软上限、
 * 规则线索、面包屑）留在这里 —— 它是与 TextParser 共用的、属于解析层的判断，
 * 不该跟着 docx 抽取一起搬走。
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { pySplitlines, pyStrip } from "../../kernel/config.js";
import type { Chunk, ParsedDoc } from "./base.js";
import {
  Parser,
  cpLen,
  cpSlice,
  makeChunk,
  makeFinding,
  makeParsedDoc,
  readTextGuess,
} from "./base.js";

/** 一个切片的软上限（字符）。超了就在句号处切开，不硬切。 */
export const SECTION_SOFT_LIMIT = 1200;

// ── 正则的两处移植（照抄会错，别偷懒）──────────────────────────────
//
// 1. Python 的 `\s` == `str.isspace()` 的 29 个码点，与 JS 的 `\s` **两个方向**
//    都有差：Python 独有 \x1c-\x1f 和 \x85，JS 独有 U+FEFF(BOM)。BOM 那条是真会
//    走到的 —— `﻿# 标题` 用 JS 的 \s 会被当成标题，Python 不会（golden 钉着）。
//    这个集合与 `kernel/config.ts` 里 golden 钉住的 PY_SPACE 是同一份（那边没导出）。
// 2. Python 的 `\d` == `\p{Nd}`（认全角 `１２`、天城文数字），JS 的 `\d` 只认
//    ASCII。中文 Word 里 `１.２ 标题` 这种编号是常见写法，用 JS 的 \d 会漏掉。
const S = "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000";
const D = "\\p{Nd}";

// Python 的 `\b` 认**汉字是词字符**（`\w` 是 Unicode 的），JS 的 `\w` 只有 ASCII。
// 后果是 `订单each订单` 在 Python 下不命中 `\beach\b`、在 JS 下命中 —— 规则标签
// 会凭空多出来。所以每个 `\b` 都换成 Unicode 版的前后瞻。
const WB = "(?<![\\p{L}\\p{N}_])";
const WE = "(?![\\p{L}\\p{N}_])";

/**
 * 建模相关的规则句特征。命中的切片打 rule 标签，检索时（tag boost）优先。
 *
 * **领域无关 + 双语**：Copilot 面向很多业务域和语言，线索只认"建模语义"（基数、
 * 约束、关系、键、口径），不夹带 含税/不含税 这种某个域独有的词 —— 那是例子不是
 * 规则线索。漏标不致命：rule 只是加权项，不是硬门禁。
 */
export const RULE_HINTS = new RegExp(
  "一个|每个|多个|至少|最多|必须|不得|应当|需要"
    + "|由.{0,8}(生成|产生|创建|拆分|合并|触发|派生)"
    + "|对应|关联|引用|属于|一对多|多对多|一对一|唯一|主键|外键|默认|枚举|取值|口径|为准"
    + `|${WB}each${WE}|${WB}every${WE}|${WB}at least${WE}|${WB}at most${WE}`
    + `|${WB}exactly one${WE}|${WB}multiple${WE}|${WB}many${WE}`
    + `|${WB}must${WE}|${WB}shall${WE}|${WB}cannot${WE}|${WB}required${WE}`
    + `|${WB}optional${WE}|${WB}mandatory${WE}`
    + `|${WB}references?${WE}|${WB}belongs? to${WE}|${WB}associated${WE}`
    + `|${WB}one-to-many${WE}|${WB}many-to-many${WE}`
    + `|${WB}unique${WE}|${WB}primary key${WE}|${WB}foreign key${WE}`,
  "iu",
);

const HEADING = new RegExp(
  `^[${S}]*(#{1,6}[${S}]+|第[一二三四五六七八九十百]+[章节条]`
    + `|${D}+(\\.${D}+)*[、.${S}]|[一二三四五六七八九十]+[、.])[${S}]*`,
  "u",
);

/** 标题层级号（Heading N / 标题 N），拿不到就退回按编号深度推断。 */
const HEADING_LVL = new RegExp(`(?:heading|标题)[${S}]*(${D})`, "iu");
const NUM_PREFIX = new RegExp(`^[${S}]*(${D}+(?:\\.${D}+)*)`, "u");
const SECTION_CN = new RegExp(`^[${S}]*第[一二三四五六七八九十百]+节`, "u");
const ND_ONE = /\p{Nd}/u;

/**
 * Python `int("２")` == 2 —— JS 的 `Number("２")` 是 NaN。
 *
 * Nd 的每个块内 0–9 连续且块首是 0，所以往回数到"上一个码点不是 Nd"为止，
 * 数出来的就是它的值。对全部 390 个 Nd 码点成立，不只是全角那一段。
 */
function pyDigitValue(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  for (let v = 0; v < 10; v++) {
    const prev = cp - v - 1;
    if (prev < 0 || !ND_ONE.test(String.fromCodePoint(prev))) return v;
  }
  return 0;
}

/**
 * 标题判定：Word 的 Heading 样式、本地化的"标题"样式，或编号/井号格式。
 *
 * 材料来自很多业务域、很多语言，样式名不能只认英文 `heading`。
 */
export function isHeading(style: string | null, text: string): boolean {
  const s = (style ?? "").toLowerCase();
  return s.startsWith("heading") || (style ?? "").includes("标题") || HEADING.test(text);
}

/** 标题层级：优先按样式号（Heading 2 → 2），否则按编号深度（`3.2.1` → 3）。 */
export function headingLevel(style: string | null, text: string): number {
  const m = HEADING_LVL.exec(style ?? "");
  if (m) return pyDigitValue(m[1] as string);
  const n = NUM_PREFIX.exec(text);
  if (n) return (n[1] as string).split(".").length - 1 + 1;
  if (SECTION_CN.test(text)) return 2;
  return 1;
}

// ══════════════════════════════════════════════════════════════════
//  解析器
// ══════════════════════════════════════════════════════════════════

/** md / txt / 兜底。 */
export class TextParser extends Parser {
  override readonly kind = "text";
  override readonly extensions = [".md", ".txt", ".markdown", ".rst"];

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileName = basename(path);
    const doc = makeParsedDoc({ fileId: opts.fileId, fileName, kind: this.kind });
    const [text, enc] = await readTextGuess(path);
    if (enc !== "utf-8") doc.findings.push(makeFinding("encoding_guess", `按 ${enc} 解码`, {}));
    const blocks = splitSections(text).map((b): [string, string] => [headingOf(b), b]);
    emit(doc, blocks, opts.fileId, fileName, "para");
    // len(text) 是码点数：emoji 在 JS 的 .length 下会翻倍，chars 就成了假的
    doc.structured = { sections: blocks.length, chars: cpLen(text) };
    return doc;
  }
}

/**
 * 未知扩展名的安全兜底。
 *
 * 真文本即使叫 `.log/.conf/.parquet` 也照常读取；明显二进制则明确报 unsupported。
 * 以前 latin-1 对任意字节都能“解码成功”，ZIP、旧 Office、真正的 Parquet 因此会
 * 变成一堆乱码 chunks，系统还把它当解析成功 —— 比直接失败更危险。
 */
export class FallbackTextParser extends TextParser {
  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const raw = await readFile(path);
    if (!looksBinary(raw)) return await super.parse(path, opts);

    const fileName = basename(path);
    const doc = makeParsedDoc({ fileId: opts.fileId, fileName, kind: "unsupported" });
    const ext = extname(fileName).toLowerCase() || "（无扩展名）";
    doc.findings.push(makeFinding(
      "unsupported",
      `${fileName} 是未识别的二进制格式 ${ext}，没有把乱码伪装成已解析内容。`
      + "请转换为 PDF、DOCX、PPTX、XLSX、CSV、图片或纯文本后重试。",
      {},
      "warn",
    ));
    doc.structured = { bytes: raw.byteLength };
    return doc;
  }
}

/** 头部魔数 + 控制字符比例；只用于“未知扩展名”，已知格式仍由专用解析器判断。 */
function looksBinary(raw: Uint8Array): boolean {
  const head = raw.subarray(0, Math.min(raw.byteLength, 8192));
  if (head.length === 0) return false;
  const starts = (...bytes: number[]): boolean =>
    bytes.every((value, index) => head[index] === value);
  if (
    starts(0x50, 0x4b, 0x03, 0x04) // ZIP / OOXML / ODF
    || starts(0x25, 0x50, 0x44, 0x46) // PDF
    || starts(0xd0, 0xcf, 0x11, 0xe0) // OLE：旧版 Office
    || starts(0x89, 0x50, 0x4e, 0x47) // PNG
    || starts(0xff, 0xd8, 0xff) // JPEG
    || starts(0x50, 0x41, 0x52, 0x31) // Parquet
  ) return true;

  let controls = 0;
  for (const byte of head) {
    if ((byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte)) || byte === 0x7f) {
      controls += 1;
    }
  }
  return controls / head.length > 0.02;
}

/** python-docx 抽出来的一个段落。`style` 是**解析后的显示名**（"Heading 2" / "标题 2"）。 */
export interface DocxParagraph {
  readonly text: string;
  readonly style: string | null;
}

/** docProps/core.xml。`modified` 已经在抽取侧 `str()` 过 —— `str(datetime)` 的
 *  格式属于 Python，留在 Python 算，这边只做"非空就报泄漏"的判断。 */
export interface DocxCoreProps {
  readonly creator: string | null;
  readonly last_modified_by: string | null;
  readonly modified: string | null;
  readonly title: string | null;
}

/** 表格：行 → 单元格文本（合并单元格已按跨度展开，与 `row.cells` 一致）。 */
export type DocxTable = readonly (readonly string[])[];

export interface DocxContent {
  readonly paragraphs: readonly DocxParagraph[];
  readonly tables: readonly DocxTable[];
  readonly core: DocxCoreProps;
}

/** 抽取器：路径 → 原料。测试实现喂 golden。 */
export type DocxExtractor = (path: string) => Promise<DocxContent>;

export class DocxParser extends Parser {
  override readonly kind = "docx";
  override readonly extensions = [".docx"];

  /** **不给默认抽取器**：没有抽取器就该在装配时炸，而不是在用户传了 docx 之后
   *  以"这份材料没有内容"的形态出现 —— 后者正是"静默少一个来源"。 */
  constructor(private readonly extract: DocxExtractor) {
    super();
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const content = await this.extract(path);
    return parseDocxContent(content, { fileId: opts.fileId, fileName: basename(path) });
  }
}

/** 纯函数版：原料 → ParsedDoc。切段逻辑全在这里，测试直接喂 golden 的原料。 */
export function parseDocxContent(
  content: DocxContent,
  opts: { fileId: string; fileName: string },
): ParsedDoc {
  const { fileId, fileName } = opts;
  const doc = makeParsedDoc({ fileId, fileName, kind: "docx" });

  const core = content.core;
  // Python 的 `if v` 同时滤掉 None 和空串；顺序是 creator → last_modified_by
  // → modified → title，泄漏消息按这个顺序拼。
  const meta: [string, string][] = [];
  for (const [k, v] of [
    ["creator", core.creator],
    ["last_modified_by", core.last_modified_by],
    ["modified", core.modified],
    ["title", core.title],
  ] as const) {
    if (v) meta.push([k, v]);
  }
  for (const [k, v] of meta) doc.meta[k] = v;
  const leaked = meta.filter(([k]) => k === "creator" || k === "last_modified_by");
  if (leaked.length > 0) {
    doc.findings.push(
      makeFinding(
        "metadata_leak",
        "文档元数据里带着作者信息（"
          + leaked.map(([k, v]) => `${k}=${v}`).join("；")
          + "），对外发布前建议清理。",
        { kind: "meta", field: "docProps/core.xml" },
        "warn",
      ),
    );
  }

  // 正文：按标题层级聚段。current 记的是**标题面包屑**（H1 > H2 > H3），
  // 不是最近一级标题 —— 规则句脱离它所属的流程层级就容易误读。
  const stack: [number, string][] = [];
  let current = "";
  let buf: string[] = [];
  const blocks: [string, string][] = [];
  for (const p of content.paragraphs) {
    const t = pyStrip(p.text ?? "");
    if (!t) continue;
    if (isHeading(p.style, t)) {
      if (buf.length > 0) {
        blocks.push([current, buf.join("\n")]);
        buf = [];
      }
      const lvl = headingLevel(p.style, t);
      while (stack.length > 0 && (stack[stack.length - 1] as [number, string])[0] >= lvl) {
        stack.pop();
      }
      stack.push([lvl, t]);
      current = stack.map(([, x]) => x).join(" > ");
    } else {
      buf.push(t);
      if (sumCpLen(buf) > SECTION_SOFT_LIMIT) {
        blocks.push([current, buf.join("\n")]);
        buf = [];
      }
    }
  }
  if (buf.length > 0) blocks.push([current, buf.join("\n")]);
  let order = emit(doc, blocks, fileId, fileName, "para");

  // 表格单独抽 —— 通常是字段清单，比正文更结构化
  const tables: Record<string, unknown>[] = [];
  for (const [ti, tbl] of content.tables.entries()) {
    const rows = tbl
      .map((r) => r.map((c) => pyStrip(c)))
      .filter((r) => r.some((c) => c !== ""));
    if (rows.length === 0) continue;
    const header = rows[0] as string[];
    const body = rows.slice(1);
    tables.push({ index: ti, columns: header, rows: body.length });
    for (const [ri, row] of body.entries()) {
      // **必须给 raw，形状是 {列名: 值}。**
      //
      // 漏了它不会报错，只会静默降级：`Segment.rows()` 判的是
      // `isPlainDict(c.raw)`，而 makeChunk 的默认是 `raw: null` —— null 直接出局。
      // 后果是整份 docx 的表格行对规则层**完全不可见**：rows 为空 → inferShape
      // 走「行数 < 3」分支 → 无 rowUnit、无 yields、structuralExtract 抽 0 条 →
      // 每一段的全部内容都当散文喂给模型。一次真实事故里这是 1553 个切片。
      //
      // 形状要与 tabular.ts 的表格行**逐字一致**（classifyColumns 对两边一视同仁），
      // 别自创 {row, columns} 那种 —— 那会让列分类器拿到两列数组当输入。
      // 空表头用 `C{n}` 兜底，与 presentation.ts 的表格行同一套规则。
      //
      // **不能直接拿表头当键**：真实 docx 的表头常有多个空格子，而 raw 是字典 ——
      // 两个空列名会撞成同一个键，后一个把前一个的值覆盖掉，那一列的数据就
      // 静默消失了。render 是字符串、不在乎重名，所以两边规则本来就不必相同：
      // 前者是显示，后者是数据，数据要的是键唯一。
      //
      // 也不能跳过空列名 —— 跳过同样是丢值，而且会让各行的键集不一致，
      // classifyColumns 的列填充率就算错了。
      const raw: Record<string, string> = {};
      for (let i = 0; i < Math.min(header.length, row.length); i += 1) {
        const name = header[i] as string;
        raw[name === "" ? `C${i + 1}` : name] = row[i] as string;
      }
      doc.chunks.push(
        makeChunk({
          docId: `t${ti}r${ri}`,
          fileId,
          fileName,
          // page 用的是**原始**表序号 +1（被丢掉的空表也占号），locator 要能对回
          // 原文档的第几张表，不能按过滤后的序号重排。
          locator: { kind: "page", page: ti + 1, bbox: [0, 0, 0, 0], table: ti, row: ri + 1 },
          render: row
            .map((v, i) => (i < header.length && v ? `${header[i] as string}=${v}` : ""))
            .filter((s) => s !== "")
            .join(" | "),
          raw,
          order,
          tags: ["table"],
        }),
      );
      order += 1;
    }
  }

  doc.structured = { sections: blocks.length, tables };
  return doc;
}

// ══════════════════════════════════════════════════════════════════
//  切段
// ══════════════════════════════════════════════════════════════════

function sumCpLen(buf: readonly string[]): number {
  let n = 0;
  for (const x of buf) n += cpLen(x);
  return n;
}

/** 码点下标版的 `str.rfind` —— UTF-16 下标会在有 emoji 时把"过半没过半"算错。 */
function cpRfind(s: string, needle: string): number {
  const u16 = s.lastIndexOf(needle);
  return u16 < 0 ? -1 : cpLen(s.slice(0, u16));
}

export function splitSections(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  // pySplitlines 而不是 split("\n")：CRLF 的 \r 会留在行尾（进而进 render 和
  // token 流），\x0b \x0c   这些 Python 认、JS 不认的分隔符也会整段粘在一起。
  for (const line of pySplitlines(text)) {
    if (HEADING.test(line) && buf.length > 0) {
      out.push(pyStrip(buf.join("\n")));
      buf = [];
    }
    buf.push(line);
    if (sumCpLen(buf) > SECTION_SOFT_LIMIT) {
      const joined = buf.join("\n");
      const cps = [...joined];
      const cut = Math.max(cpRfind(joined, "。"), cpRfind(joined, "\n\n"));
      if (cut > Math.floor(cps.length / 2)) {
        // 在句号处切，不把规则句劈成两半
        out.push(pyStrip(cps.slice(0, cut + 1).join("")));
        buf = [cps.slice(cut + 1).join("")];
      } else {
        out.push(pyStrip(joined));
        buf = [];
      }
    }
  }
  if (buf.length > 0 && pyStrip(buf.join("\n")) !== "") out.push(pyStrip(buf.join("\n")));
  return out.filter((b) => b !== "");
}

export function headingOf(block: string): string {
  const stripped = pyStrip(block);
  const first = stripped ? (pySplitlines(stripped)[0] as string) : "";
  // first[:60] 按码点切 —— 一行 emoji 标题在 UTF-16 下会被砍成一半长度
  return HEADING.test(first) ? cpSlice(first, 0, 60) : "";
}

function emit(
  doc: ParsedDoc,
  blocks: readonly (readonly [string, string])[],
  fileId: string,
  fileName: string,
  kind: string,
): number {
  let order = 0;
  for (const [heading, body] of blocks) {
    if (!pyStrip(body)) continue;
    const isRule = RULE_HINTS.test(body);
    const chunk: Chunk = makeChunk({
      docId: `s${order}`,
      fileId,
      fileName,
      locator: {
        kind: "page",
        page: 1,
        bbox: [0, 0, 0, 0],
        section: heading || `§${order + 1}`,
      },
      render: (heading ? `〔${heading}〕\n` : "") + body,
      order,
      tags: isRule ? [kind, "rule"] : [kind],
    });
    doc.chunks.push(chunk);
    order += 1;
  }
  return order;
}
