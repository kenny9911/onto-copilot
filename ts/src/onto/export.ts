/**
 * 把对话里的一段内容落成可下载的文件（md / csv / xlsx / docx / pdf）。
 * 移植自 `src/ontocopilot/onto/export.py`，由 `golden/onto.export.json` 钉住。
 *
 * FDE 在聊天里问出了一张 192 行的待澄清问题表，下一句是"把这个转成 excel 给我"。
 * 交付包（`bundle.ts`）解决不了这件事 —— 那是把**整个会话的产物**打成一个 zip，
 * 而他要的是**刚刚那一份东西**，按他指定的格式。
 *
 * 所以这里的输入不是会话，是一份 {@link ExportDoc}：一个标题 + 一串有序的块
 * （标题/正文/表格/代码）。谁去组装这个 doc 是调用方的事（服务端从产物、从材料、
 * 从上一张表、从上一条回答都能组装），这个模块只负责把它写成字节。
 *
 * 和 `bundle.ts` 同一条规矩：**纯函数、不 import server**，所以能脱离服务单测。
 * （唯一的例外是 {@link ExportDependencyMissing}，见下面「PDF」一节的说明。）
 *
 * 三个踩过的坑，写在这里免得下次再踩：
 *
 * 1. **PDF 的中文不是字体路径问题。** PyMuPDF 自带 MuPDF 的 Droid Sans Fallback，
 *    `Story` 在空 CSS 下就会自动回退，中文能画也能被复制出来 —— 不需要装字体、
 *    不需要 pymupdf-fonts，更不要硬编码 `/System/Library/Fonts/PingFang.ttc`
 *    （那台 macOS 上根本没有这个路径）。
 * 2. **但一定要 `subset_fonts()`。** 不做子集化，一页中文 PDF 是 3.6 MB（整个回退
 *    字体被嵌进去）；做了是 27 KB，中文照样能提取。差 130 倍。
 * 3. **docx 的中文要设 `w:eastAsia`。** 只写 `w:ascii`/`w:hAnsi` 的话，Word 打开时
 *    中文会被替换成别的字体。设在 Normal 样式上一次搞定。
 *
 * ── TS 侧与 Python 的三处分叉（都在 divergences 里报了）────────────────────
 *
 * **xlsx / docx 是手写 OOXML，不借第三方库。** Python 侧用 openpyxl / python-docx，
 * 两者在 TS 上都没有对等物（exceljs 只覆盖 xlsx，而且它的写接口是 async ——
 * `server/routes/artifacts.ts` 的 `ExportModule.render` 是**同步**签名，改成 async
 * 就得动那边的文件）。手写反而拿到两样更值钱的东西：
 *
 *   · **同步**：`render()` 与 Python 一样是同步函数，两个调用点都能直接用；
 *   · **字节确定**：zip 成员的时间戳、压缩参数、XML 排布全在自己手里。openpyxl 的
 *     `save()` 会用当前时间覆盖 `properties.modified`、zip 成员 mtime 也取当前时间
 *     （`tools/export_golden.py` 为此专门写了一个 `_freeze_xlsx`）。这里从一开始
 *     就钉死在 {@link ZIP_EPOCH}，同样的输入永远产出同样的字节 —— 不然每次导出的
 *     diff 全是噪声，"文件变了吗"这个问题就再也答不了。
 *
 * **PDF 走注册点。** Python 那边用 pymupdf 的 Story 排版 HTML；TS 侧还没有对等的
 * 排版器（`onto/render.ts` 只做栅格化，不做 HTML→PDF 的分页排版）。`doc_to_html` +
 * {@link PDF_CSS}（Story 的全部输入）逐字移植过来了，渲染器由
 * {@link registerPdfRenderer} 注入。没注入时 `render(doc,"pdf")` 抛
 * {@link ExportDependencyMissing} —— 与 Python 侧 `import pymupdf` 抛 ImportError
 * 落在同一条分支上，对话工具会回一句"这台机器上导不出 pdf"，而不是"写 pdf 失败"。
 */

import { deflateRawSync, crc32 } from "node:zlib";

// `ValueError` 全仓只有一份，在 kernel/errors.ts（约定：两份同名类 = 两个类身份，
// `instanceof` 会漏掉其中一份且不报错）。
import { ValueError } from "../kernel/errors.js";

// 唯一一处 import server：`ExportDependencyMissing` 定义在 `server/dialogue/ports.ts`
// （那边的注释写明了「由 export 段显式抛这个类来保住分支」）。**不在这里再定义一份**
// —— 两份同名类是两个类身份，`instanceof` 会漏掉其中一份且不报错，症状是"某台机器
// 上导不出 pdf"被报成"写 pdf 失败"。ports.ts 的运行时依赖为空（全是 import type），
// 所以这条 import 既不成环也不拖进 server 的其它东西。
import { ExportDependencyMissing } from "../server/dialogue/ports.js";

export { ExportDependencyMissing };

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/**
 * Python `str` 模式下 `\s` 的字符集。
 *
 * **不能直接用 JS 的 `\s`**：两边是有差集的 —— Python 认 U+0085(NEL) 与
 * U+001C~U+001F，JS 不认；JS 认 U+FEFF(BOM)，Python 不认。markdown 的每一条
 * 判据（标题、分隔线、列表、表格行）都以 `^\s*` 开头，差一个字符就是"这一行
 * 是不是标题"变了。golden 的 `nel_and_bom_whitespace` 用例钉着这两侧。
 */
const PY_SPACE =
  " \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** 与 {@link PY_SPACE} 同一份集合，供 strip/rstrip 用（正则里逐字符跑更绕）。 */
const PY_SPACE_SET: ReadonlySet<string> = new Set(
  [
    0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0, 0x1680, 0x2000,
    0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
    0x2029, 0x202f, 0x205f, 0x3000,
  ].map((cp) => String.fromCodePoint(cp)),
);

/** Python 的 `str.strip()`（无参）。JS 的 `trim()` 会多剥 U+FEFF、少剥 U+0085。 */
function pyStrip(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && PY_SPACE_SET.has(s[i]!)) i += 1;
  while (j > i && PY_SPACE_SET.has(s[j - 1]!)) j -= 1;
  return s.slice(i, j);
}

/** Python 的 `str.rstrip()`（无参）。 */
function pyRstrip(s: string): string {
  let j = s.length;
  while (j > 0 && PY_SPACE_SET.has(s[j - 1]!)) j -= 1;
  return s.slice(0, j);
}

/** Python 的 `str.strip(chars)`。 */
function pyStripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  let i = 0;
  let j = s.length;
  while (i < j && set.has(s[i]!)) i += 1;
  while (j > i && set.has(s[j - 1]!)) j -= 1;
  return s.slice(i, j);
}

/** Python 的 `len(s)`：按**码点**数，不是 UTF-16 码元。列宽和截断都靠它。 */
function pyLen(s: string): number {
  return [...s].length;
}

/** Python 的 `s[:n]`：按码点切，CJK/emoji 才不会被切成半个。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python `str(x)` 在本模块用得到的那几种形态（表格格子里可能是任何东西）。 */
function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  // `None` 与"这个键不存在"在 Python 侧是同一个 str() 结果
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x)).join(", ")}]`;
  // 数字：**分不出 Python 的 `int 42` 与 `float 42.0`**（JS 只有一种数），所以
  // `str()` 的结果在 42/42.0 上必然与 Python 不同。影响面只有"表格格子里放了
  // 浮点数、又落到 str 化的兜底路径"这一种组合 —— xlsx 那条路是原样写数字的。
  return String(v);
}

/** 列表元素的 `repr()`。只覆盖表格格子里真会出现的标量。 */
function pyRepr(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyStr(v);
}

// ══════════════════════════════════════════════════════════════════
//  文档模型
// ══════════════════════════════════════════════════════════════════

/** 列表项：`(缩进层级, 序号或"", 文本)`。 */
export type ListItem = readonly [number, string, string];

/**
 * 一张要嵌进导出件的位图。
 *
 * **只收 PNG。** xlsx/docx 的 drawing 部件认的是位图，SVG 塞进去 Excel 打不开；
 * 调用方拿到 SVG 要先过 `onto/render.ts` 的 `svgToPng` 栅格化。宽高是像素，
 * 写 OOXML 时按 1px = 9525 EMU 换算。
 */
export interface BlockImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** 一个内容块。六种写法共用同一份输入，只有 `to_*` 不同。 */
export interface Block {
  /** heading | para | table | code | rule | image */
  readonly kind: string;
  readonly text: string;
  /** heading 用。 */
  readonly level: number;
  /** para 为空表示是普通段落。 */
  readonly items: readonly ListItem[];
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /** image 用；其余块是 null。 */
  readonly image: BlockImage | null;
}

/** 对应 Python `Block(kind, text="", level=1, items=[], columns=[], rows=[])`。 */
export function makeBlock(
  kind: string,
  p: Partial<Omit<Block, "kind">> = {},
): Block {
  return {
    kind,
    text: p.text ?? "",
    level: p.level ?? 1,
    // 每次新数组，别共享引用（Python 的 default_factory 同理）
    items: [...(p.items ?? [])],
    columns: [...(p.columns ?? [])],
    rows: (p.rows ?? []).map((r) => [...r]),
    image: p.image ?? null,
  };
}

/** 一张图 + 一句图注。图注同时是 xlsx 里那张 sheet 的名字。 */
export function imageBlock(image: BlockImage, caption = ""): Block {
  return makeBlock("image", { text: caption, image });
}

/** 要导出的一份东西。`tables` 是**动态属性**（Python 的 `@property`）。 */
export interface ExportDoc {
  readonly title: string;
  readonly blocks: readonly Block[];
  /** 一句话说清这份文件是从哪来的 —— 导出件脱离了对话，没有出处就是孤证。 */
  readonly note: string;
  readonly tables: readonly Block[];
}

/**
 * 文档头要回答的那几件事。**全是收件人第一时间会问的**，而答案系统里都有：
 * 一份交到业务方手上的确认稿，看不出是谁生成的、什么时候、基于哪一版模型、
 * 依据是客户材料还是通用假设、用了哪些材料、填完往哪回传 —— 那份文件就只能
 * 靠发它的人当面解释一遍。
 *
 * 每一项都可缺省：**缺项不占行**，空着的格子比没有这一行更让人犯嘀咕。
 */
export interface ExportMeta {
  /** 这份文件用来干什么。 */
  readonly purpose?: string;
  /** 给谁看/谁来填。 */
  readonly audience?: string;
  /** 生成时间。**由调用方传入** —— 模块内部读时钟会打破「同样输入同样字节」。 */
  readonly generatedAt?: string;
  /** 依据：客户材料 / 通用假设 / 两者混合。 */
  readonly basis?: string;
  /** 用到的材料。 */
  readonly materials?: readonly string[];
  /** 模型版本（revision）。 */
  readonly revision?: string;
  /** 发布状态：DRAFT / RELEASED / BLOCKED。 */
  readonly releaseState?: string;
  /** 填完往哪回传。 */
  readonly returnTo?: string;
}

/**
 * 文档头 → 块。两列表（项目/内容），排在正文最前。
 *
 * 一项都没有就一个块都不产 —— 不许出现一张空的文档头表。
 */
export function docHeaderBlocks(meta: ExportMeta): Block[] {
  const rows: string[][] = [];
  const put = (label: string, value: string | undefined): void => {
    const v = pyStrip(pyStr(value ?? ""));
    if (v && v !== "None") rows.push([label, v]);
  };
  put("用途", meta.purpose);
  put("给谁看", meta.audience);
  put("生成时间", meta.generatedAt);
  put("依据", meta.basis);
  put("模型版本", meta.revision);
  put("发布状态", meta.releaseState);
  // 材料列成一行 —— 文档头是索引不是清单，每份一行会把头撑成正文。
  put("材料", (meta.materials ?? []).join("、"));
  put("回传", meta.returnTo);
  if (rows.length === 0) return [];
  const block = makeBlock("table", { columns: ["项目", "内容"], rows });
  // 标记出来：回执里的「表格行数」按内容表算，不该被文档头污染。
  (block as unknown as Record<string, unknown>)["docHeader"] = true;
  return [block];
}

export function makeExportDoc(p: {
  title: string;
  blocks?: readonly Block[];
  note?: string;
  /** 给了就在正文最前排一张文档头；**不给则与不加这个字段之前逐字节相同**。 */
  meta?: ExportMeta;
}): ExportDoc {
  const header = p.meta === undefined ? [] : docHeaderBlocks(p.meta);
  const doc: Partial<ExportDoc> = {
    title: p.title,
    blocks: [...header, ...(p.blocks ?? [])],
    note: p.note ?? "",
  };
  // getter 而不是构造时算好：Python 侧是 `@property`，调用方（server 那两段）
  // 拿到 doc 之后还会往 blocks 里塞东西，算死了就会拿到一份过期的表清单。
  Object.defineProperty(doc, "tables", {
    get(this: ExportDoc): readonly Block[] {
      // 文档头虽然是表，但它不是内容 —— 回执里的「表格行数」与 xlsx 的分页
      // 都按内容表算。
      return this.blocks.filter(
        (b) => b.kind === "table"
          && (b as unknown as Record<string, unknown>)["docHeader"] !== true,
      );
    },
    enumerable: false,
  });
  return doc as ExportDoc;
}

/** 一张表 → 块列表（带可选小标题）。服务端最常用的就是这个。 */
export function tableBlock(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  title = "",
): Block[] {
  const out: Block[] = title ? [makeBlock("heading", { text: title, level: 2 })] : [];
  out.push(
    makeBlock("table", {
      columns: [...columns],
      rows: rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : pyStr(c)))),
    }),
  );
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  markdown → 块
// ══════════════════════════════════════════════════════════════════
// 认的语法和前端 `md()` 保持一致：代码围栏 / #..###### / 竖线表格 / 有序无序列表 /
// 分隔线 / 段落。**不是完整 CommonMark** —— 覆盖的是模型实际会写的那几种。
//
// 三处正则要按 Python 的语义写，不能照抄字面量（golden 里各有一条用例钉着）：
//   · `\s` → PY_SPACE（见上）
//   · `\d` → `\p{Nd}`：Python 的 `\d` 是整个 Nd 类，`٣. 阿拉伯数字` 也是有序列表项
//   · `\w` → `[\p{L}\p{N}_]`：Python 的 `\w` 含汉字，所以「前*不是斜体*后」里
//     那对星号**不**成立；JS 原生的 `\w` 只有 ASCII，照抄会把它当成斜体去掉星号
const FENCE = new RegExp(`^[${PY_SPACE}]*\`\`\`([\\p{L}\\p{N}_]*)[${PY_SPACE}]*$`, "u");
const HEAD = new RegExp(`^[${PY_SPACE}]*(#{1,6})[${PY_SPACE}]+(.+?)[${PY_SPACE}]*#*$`, "u");
const RULE = new RegExp(`^[${PY_SPACE}]*(?:---+|\\*\\*\\*+|___+)[${PY_SPACE}]*$`, "u");
const ITEM = new RegExp(
  `^([${PY_SPACE}]*)(\\p{Nd}+[.)]|[-*+])[${PY_SPACE}]+(.*)$`,
  "u",
);
const ROW = new RegExp(`^[${PY_SPACE}]*\\|.*\\|[${PY_SPACE}]*$`, "u");
const SEP = new RegExp(`^[${PY_SPACE}]*\\|[${PY_SPACE}:|-]+\\|[${PY_SPACE}]*$`, "u");
/** 行内标记在 docx/pdf 里没有对应表达（不做富文本），落地前先去掉，免得正文里
 *  出现裸的 `**` 和 `` ` ``。 */
const INLINE = /\*\*(.+?)\*\*|`(.+?)`|(?<![*\p{L}\p{N}_])\*([^*\n]+)\*(?![*\p{L}\p{N}_])/gu;

function plain(s: string): string {
  return pyStrip(
    s.replace(INLINE, (_m, g1: string | undefined, g2: string | undefined, g3: string | undefined) =>
      // Python 是 `m.group(1) or m.group(2) or m.group(3) or ""`
      (g1 || g2 || g3) ?? "",
    ),
  );
}

function cells(line: string): string[] {
  return pyStripChars(pyStrip(line), "|")
    .split("|")
    .map((c) => pyStrip(c));
}

/** 把一段 markdown 切成块。回答（模型写的 markdown）走这条路。 */
export function blocksFromMarkdown(text: string): Block[] {
  const lines = (text || "").split("\n");
  const out: Block[] = [];
  let buf: string[] = [];
  let items: ListItem[] = [];

  const flush = (): void => {
    if (items.length > 0) {
      out.push(makeBlock("para", { items }));
      items = [];
    }
    if (buf.length > 0) {
      const body = pyStrip(buf.join("\n"));
      if (body) out.push(makeBlock("para", { text: plain(body) }));
      buf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;

    if (FENCE.test(ln)) {
      // 代码块：原样保留，不做行内处理
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      out.push(makeBlock("code", { text: body.join("\n") }));
      i += 1;
      continue;
    }

    if (ROW.test(ln) && i + 1 < lines.length && SEP.test(lines[i + 1]!)) {
      flush();
      const head = cells(ln);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && ROW.test(lines[i]!)) {
        body.push(cells(lines[i]!).map((c) => plain(c)));
        i += 1;
      }
      out.push(makeBlock("table", { columns: head.map((c) => plain(c)), rows: body }));
      continue;
    }

    const mh = HEAD.exec(ln);
    if (mh !== null) {
      flush();
      out.push(makeBlock("heading", { text: plain(mh[2]!), level: mh[1]!.length }));
      i += 1;
      continue;
    }

    if (RULE.test(ln)) {
      flush();
      out.push(makeBlock("rule"));
      i += 1;
      continue;
    }

    const mi = ITEM.exec(ln);
    if (mi !== null) {
      if (buf.length > 0) {
        // 段落先收尾，列表另起一块
        const body = pyStrip(buf.join("\n"));
        if (body) out.push(makeBlock("para", { text: plain(body) }));
        buf = [];
      }
      const body = plain(mi[3]!);
      if (body) {
        // 只有标记没内容的行不算一条
        const depth = Math.floor(pyLen(mi[1]!.replace(/\t/g, "    ")) / 2);
        const marker = /^\p{Nd}/u.test(mi[2]!) ? mi[2]! : "";
        items.push([depth, marker, body]);
      }
      i += 1;
      continue;
    }

    if (!pyStrip(ln)) {
      if (buf.length > 0) flush();
      i += 1;
      continue;
    }

    if (items.length > 0) flush(); // 列表被普通正文打断
    buf.push(ln);
    i += 1;
  }

  flush();
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  markdown
// ══════════════════════════════════════════════════════════════════
export function toMarkdown(doc: ExportDoc): Uint8Array {
  const out: string[] = [`# ${doc.title}`, ""];
  if (doc.note) out.push(`> ${doc.note}`, "");
  for (const b of doc.blocks) {
    if (b.kind === "heading") {
      out.push("#".repeat(Math.max(2, Math.min(6, b.level + 1))) + " " + b.text, "");
    } else if (b.kind === "rule") {
      out.push("---", "");
    } else if (b.kind === "code") {
      out.push("```", b.text, "```", "");
    } else if (b.kind === "image") {
      // data URI 而不是外链：导出件离开对话之后没有服务器给它取图，
      // 写个相对路径等于交出去一个坏掉的图。
      if (b.image !== null) out.push(`![${b.text || "图"}](${dataUri(b.image)})`, "");
      if (b.text) out.push(`*${b.text}*`, "");
    } else if (b.kind === "table") {
      out.push("| " + b.columns.join(" | ") + " |");
      out.push("| " + b.columns.map(() => "---").join(" | ") + " |");
      for (const r of b.rows) {
        // 竖线和换行会把表格结构撑破，落地时替换掉
        out.push(
          "| " +
            r.map((c) => pyStr(c).replace(/\|/g, "丨").replace(/\n/g, "<br>")).join(" | ") +
            " |",
        );
      }
      out.push("");
    } else if (b.items.length > 0) {
      for (const [depth, marker, txt] of b.items) {
        out.push("  ".repeat(depth) + (marker ? `${marker} ` : "- ") + txt);
      }
      out.push("");
    } else if (b.text) {
      out.push(b.text, "");
    }
  }
  return utf8(pyRstrip(out.join("\n")));
}

// ══════════════════════════════════════════════════════════════════
//  csv
// ══════════════════════════════════════════════════════════════════

/**
 * Python `csv.writer` 的 excel 方言：`,` 分隔、`"` 引号、双写转义、
 * 行尾 `\r\n`、QUOTE_MINIMAL。
 *
 * 有一条**只有一行一列时才出现**的规矩：整行只有一个空字段时要写成 `""`，
 * 否则读回来是"空行"而不是"一行一个空串"。`_csv.c` 里那个 `rec_len == 0 &&
 * num_fields == 1` 分支就是它。
 */
function csvRow(fields: readonly string[]): string {
  const parts = fields.map((f) => {
    const needQuote =
      f.includes(",") ||
      f.includes('"') ||
      f.includes("\r") ||
      f.includes("\n") ||
      (f === "" && fields.length === 1);
    return needQuote ? `"${f.replace(/"/g, '""')}"` : f;
  });
  return parts.join(",") + "\r\n";
}

/** 只导表格。没有表就退化成一列正文 —— 空文件比一句解释更让人困惑。 */
export function toCsv(doc: ExportDoc): Uint8Array {
  let buf = "";
  const tables = doc.tables;
  if (tables.length > 0) {
    tables.forEach((b, n) => {
      if (n) buf += csvRow([]);
      buf += csvRow(b.columns.map((c) => csvSafe(c)));
      for (const r of b.rows) buf += csvRow(r.map((c) => csvSafe(c)));
    });
  } else {
    buf += csvRow([csvSafe(doc.title)]);
    for (const b of doc.blocks) {
      for (const line of flatten(b)) buf += csvRow([csvSafe(line)]);
    }
  }
  // BOM：Excel 打开无 BOM 的 UTF-8 csv 会把中文显示成乱码，而"导出的中文是乱码"
  // 是最容易被当成系统坏了的一种失败。
  return concat([new Uint8Array([0xef, 0xbb, 0xbf]), utf8(buf)]);
}

/** csv 里以这些字符开头的格子，Excel/Sheets 打开时会当成公式求值。 */
const CSV_TRIGGER = ["=", "+", "-", "@", "\t", "\r"];

/**
 * csv 没有 xlsx 那种"这格是文本"的类型位，只能靠前缀。
 *
 * 加一个单引号 —— 在 csv 这条路上它是**必要**的（xlsx 那边靠单元格类型就够，
 * 所以那边反而不该加，加了 Excel 会原样显示出来）。不做这一步的后果：一份客户
 * 给的表里一格 `=HYPERLINK("http://x?"&A1)`，FDE 导成 csv、双击打开，
 * Excel 就把隔壁格子的内容发出去了；而代码还特意加了 BOM 让 Excel 乐意打开它。
 */
function csvSafe(v: unknown): string {
  const s = v === null || v === undefined ? "" : pyStr(v);
  // Python 是 `s[:1]`，按码点取第一个字符
  const first = [...s].slice(0, 1).join("");
  return CSV_TRIGGER.includes(first) ? "'" + s : s;
}

/** 块 → 纯文本行。csv/兜底路径用。 */
function flatten(b: Block): string[] {
  if (b.kind === "table") {
    return [b.columns.join(" | "), ...b.rows.map((r) => r.map((c) => pyStr(c)).join(" | "))];
  }
  if (b.items.length > 0) {
    return b.items.map(([d, m, t]) => "  ".repeat(d) + (m ? `${m} ` : "· ") + t);
  }
  if (b.kind === "rule") return ["—".repeat(20)];
  if (b.kind === "image") {
    // csv 装不下图。**留一行说明**：静默丢掉的话，用户拿到的 csv 与他刚才看到的
    // 内容不一致，而没有任何地方告诉他少了什么。
    return [`［图：${b.text || "未命名"}　csv 放不下图片，请用 xlsx/docx/md］`];
  }
  return b.text ? [b.text] : [];
}

/** PNG → data URI。md / html 两条路共用。 */
function dataUri(image: BlockImage): string {
  return `data:image/png;base64,${Buffer.from(image.png).toString("base64")}`;
}

// ══════════════════════════════════════════════════════════════════
//  zip（xlsx / docx 共用）
// ══════════════════════════════════════════════════════════════════

/**
 * zip 成员的时间戳一律钉在 2026-01-01 00:00:00。
 *
 * 与 `tools/export_golden.py` 的 `_freeze_xlsx` 同一个常量、同一个理由：产物是
 * 按**文件字节**寻址的（`file_id`），字节漂一次，下游每条 provenance 都跟着漂，
 * diff 全是噪声。这里从写的时候就钉死，不必事后重写整包。
 */
const ZIP_EPOCH = { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
const DOS_TIME = (ZIP_EPOCH.hour << 11) | (ZIP_EPOCH.minute << 5) | (ZIP_EPOCH.second >> 1);
const DOS_DATE = ((ZIP_EPOCH.year - 1980) << 9) | (ZIP_EPOCH.month << 5) | ZIP_EPOCH.day;

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * 最小 zip 写入器（deflate、无数据描述符、无 zip64）。
 *
 * 自己写而不是拉一个库：这一层要的性质只有两条 —— **确定性**与**同步**，
 * 而现成的 zip 库要么带自己的时间戳默认值，要么只给 stream/Promise 接口。
 */
function zipBytes(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = utf8(e.name);
    const comp = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data) >>> 0;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0, true); // flags（成员名全是 ASCII，不置 UTF-8 位）
    lh.setUint16(8, 8, true); // deflate
    lh.setUint16(10, DOS_TIME, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, comp);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); // version made by
    ch.setUint16(6, 20, true); // version needed
    ch.setUint16(8, 0, true);
    ch.setUint16(10, 8, true);
    ch.setUint16(12, DOS_TIME, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);

    offset += 30 + name.length + comp.length;
  }

  const central = concat(centrals);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, central.length, true);
  eocd.setUint32(16, offset, true);
  return concat([...locals, central, new Uint8Array(eocd.buffer)]);
}

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** XML 文本转义。属性与正文共用一份 —— 少一处就是一份打不开的文件。 */
function xesc(v: unknown): string {
  return pyStr(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 不允许的控制字符：内容是**别人给的**，一个 \x07 就能让整份文件
    // 打不开，而报错信息只会说"文件已损坏"。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ══════════════════════════════════════════════════════════════════
//  xlsx
// ══════════════════════════════════════════════════════════════════

/** 列号 → 列字母（openpyxl 的 `get_column_letter`）。 */
function columnLetter(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = n % 26 || 26;
    out = String.fromCharCode(64 + rem) + out;
    n = (n - rem) / 26;
  }
  return out;
}

/** 一格：null 表示空格子（openpyxl 的 `None`，写出来是没有值的格）。 */
type XlsxValue = string | number | boolean | null;

interface XlsxSheet {
  title: string;
  rows: XlsxValue[][];
  /** 列号（1 起）→ 宽度。 */
  widths: Map<number, number>;
  freeze: boolean;
  autoFilter: boolean;
  /** 第一行是表头（加粗+底色+边框）。 */
  headerRow: boolean;
  /** 首格用大号加粗（说明页的标题行）。 */
  titleCell: boolean;
  /** 这张 sheet 上锚一张图（图专用页）。 */
  image: BlockImage | null;
}

/** 1 像素 = 9525 EMU。OOXML 的 drawing 只认 EMU。 */
const EMU_PER_PX = 9525;

/**
 * 表格一张一个 sheet；正文另开一个「说明」sheet。
 *
 * 表和正文分开放，是因为它们的用法不同：表要被筛选/透视/粘进别的表，正文只是
 * 看一眼。把正文塞在表上面，会让第一行不是表头，Excel 的筛选和冻结全都不对。
 */
export function toXlsx(doc: ExportDoc): Uint8Array {
  const sheets: XlsxSheet[] = [];
  const tables = doc.tables;
  const used = new Set<string>();

  tables.forEach((b, n) => {
    const title = sheetTitle(tableTitle(doc, b) || doc.title || "表", n, used);
    const rows: XlsxValue[][] = [b.columns.map((c) => c)];
    for (const r of b.rows) rows.push(r.map((v) => cellValue(v)));
    const widths = new Map<number, number>();
    // 列宽按内容估，但封顶 —— 一条 200 字的澄清问题会把列拉到屏幕外
    b.columns.forEach((name, idx) => {
      const lens = [pyLen(pyStr(name))];
      for (const r of b.rows) {
        if (idx < r.length) lens.push(pyLen(pyStr(r[idx])));
      }
      const width = Math.max(...lens);
      widths.set(idx + 1, Math.min(60, Math.max(10, width + 2)));
    });
    sheets.push({
      title,
      rows,
      widths,
      freeze: true,
      autoFilter: true,
      headerRow: true,
      titleCell: false,
      image: null,
    });
  });

  // 图单独成页。压在表上面会让第一行不再是表头，冻结与筛选跟着一起失效；
  // 而 FDE 要的恰恰是"表能筛、图能看"两件事同时成立。
  for (const b of doc.blocks) {
    if (b.kind !== "image" || b.image === null) continue;
    sheets.push({
      title: sheetTitle(b.text || "图", sheets.length, used),
      rows: b.text ? [[b.text]] : [[]],
      widths: new Map(),
      freeze: false,
      autoFilter: false,
      headerRow: false,
      titleCell: Boolean(b.text),
      image: b.image,
    });
  }

  const prose: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind !== "table" && b.kind !== "image") prose.push(...flatten(b));
  }
  if (prose.length > 0 || tables.length === 0) {
    const rows: XlsxValue[][] = [[doc.title]];
    if (doc.note) rows.push([doc.note]);
    rows.push([]); // `ws.append([])`：一个空行
    for (const ln of prose) rows.push([ln]);
    sheets.push({
      title: tables.length > 0 ? "说明" : sliceCodePoints(doc.title, 28) || "内容",
      rows,
      widths: new Map([[1, 100]]),
      freeze: false,
      autoFilter: false,
      headerRow: false,
      titleCell: true,
      image: null,
    });
  }

  return zipBytes(xlsxParts(sheets));
}

/**
 * openpyxl 只接受标量；别的原样 str 化。
 *
 * **公式那一层在这里就断掉了**：openpyxl 看到以 `=` 开头的字符串会写成公式
 * （`data_type='f'`），所以 Python 侧有一个 `_detext()` 扫全页把它降回文本 ——
 * 以前只扫了数据行，漏掉表头和说明页，而表头正是列名、恰恰来自那份外来表格。
 * TS 侧写的是内联字符串（`t="inlineStr"`），**从来不产生公式**，所以那一遍扫描
 * 没有对应件。这不是省了一步，是把同一个不变量挪到了更早的位置。
 */
function cellValue(v: unknown): XlsxValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return pyStr(v);
}

/** 表格前面紧挨着的那个小标题就是它的名字。 */
function tableTitle(doc: ExportDoc, b: Block): string {
  let prev = "";
  for (const x of doc.blocks) {
    if (x === b) return prev;
    prev = x.kind === "heading" ? x.text : prev;
  }
  return "";
}

const BAD_SHEET = /[\\/*?:[\]]/g;

/** Excel 的表名规矩很硬：≤31 字符、不能有 `\/*?:[]`、不能重名。踩中就存不出文件。 */
function sheetTitle(name: string, n: number, used: Set<string>): string {
  let t = pyStrip(name || "").replace(BAD_SHEET, "-") || `表${n + 1}`;
  t = sliceCodePoints(t, 31) || `表${n + 1}`;
  const base = t;
  let i = 2;
  while (used.has(t.toLowerCase())) {
    const suffix = `(${i})`;
    t = sliceCodePoints(base, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(t.toLowerCase());
  return t;
}

/** 样式表里各格式的下标，与 {@link STYLES_XML} 的 `cellXfs` 顺序一一对应。 */
const S_DEFAULT = 0;
const S_HEADER = 1;
const S_BODY = 2;
const S_TITLE = 3;
const S_WRAP = 4;

const STYLES_XML =
  XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="13"/><name val="Calibri"/></font>' +
  "</fonts>" +
  // 前两格是 OOXML 规定的保留项（none / gray125），业务色从第三格起
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="00EFEDE8"/><bgColor indexed="64"/></patternFill></fill>' +
  "</fills>" +
  '<borders count="2">' +
  "<border><left/><right/><top/><bottom/><diagonal/></border>" +
  '<border><left style="thin"><color rgb="00D8D5CE"/></left>' +
  '<right style="thin"><color rgb="00D8D5CE"/></right>' +
  '<top style="thin"><color rgb="00D8D5CE"/></top>' +
  '<bottom style="thin"><color rgb="00D8D5CE"/></bottom><diagonal/></border>' +
  "</borders>" +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

function sheetXml(sh: XlsxSheet): string {
  const maxCol = Math.max(1, ...sh.rows.map((r) => r.length));
  const maxRow = Math.max(1, sh.rows.length);
  const dim = `A1:${columnLetter(maxCol)}${maxRow}`;

  const cols =
    sh.widths.size === 0
      ? ""
      : "<cols>" +
        [...sh.widths.entries()]
          .map(([i, w]) => `<col min="${i}" max="${i}" width="${w}" customWidth="1"/>`)
          .join("") +
        "</cols>";

  const body = sh.rows
    .map((row, r) => {
      const cellsXml = row
        .map((v, c) => {
          if (v === null) return "";
          const ref = `${columnLetter(c + 1)}${r + 1}`;
          const style = sh.titleCell && r === 0 && c === 0
            ? S_TITLE
            : sh.headerRow
              ? r === 0
                ? S_HEADER
                : S_BODY
              : sh.widths.size > 0
                ? S_WRAP
                : S_DEFAULT;
          if (typeof v === "number") return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
          if (typeof v === "boolean") {
            return `<c r="${ref}" s="${style}" t="b"><v>${v ? 1 : 0}</v></c>`;
          }
          // 内联字符串：不建共享表，也就永远不会被当成公式（见 cellValue 的说明）
          return (
            `<c r="${ref}" s="${style}" t="inlineStr">` +
            `<is><t xml:space="preserve">${xesc(v)}</t></is></c>`
          );
        })
        .join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    })
    .join("");

  const views = sh.freeze
    ? '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  // OOXML 对子元素**有顺序要求**：autoFilter 必须排在 sheetData 之后，
  // 而 drawing 排在两者之后。顺序错了 Excel 直接报"文件已损坏"，不是降级显示。
  const rNs = sh.image === null
    ? ""
    : ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return (
    XML_DECL +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${rNs}>` +
    `<dimension ref="${dim}"/>${views}<sheetFormatPr defaultRowHeight="15"/>` +
    `${cols}<sheetData>${body}</sheetData>` +
    (sh.autoFilter ? `<autoFilter ref="${dim}"/>` : "") +
    (sh.image === null ? "" : '<drawing r:id="rId1"/>') +
    "</worksheet>"
  );
}

/**
 * 一张图的 drawing 部件。
 *
 * 用 oneCellAnchor（锚一个角 + 显式尺寸），不用 twoCellAnchor：后者的尺寸由两个
 * 单元格的位置算出来，行高列宽一变图就被拉扁。图注占了第 1 行，所以从第 2 行锚起。
 */
function drawingXml(image: BlockImage, anchorRow: number): string {
  const cx = Math.max(1, Math.round(image.width * EMU_PER_PX));
  const cy = Math.max(1, Math.round(image.height * EMU_PER_PX));
  return (
    XML_DECL +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    "<xdr:oneCellAnchor>" +
    `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${anchorRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    "<xdr:pic><xdr:nvPicPr>" +
    '<xdr:cNvPr id="1" name="Picture 1"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>' +
    "</xdr:nvPicPr><xdr:blipFill>" +
    '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>' +
    "<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>" +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
    "</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>"
  );
}

function xlsxParts(sheets: readonly XlsxSheet[]): ZipEntry[] {
  const n = sheets.length;
  // 哪几张 sheet 带图 —— drawing/media 的编号跟着这个下标走，中间没有空号。
  const drawn = sheets
    .map((sh, i) => ({ sh, i }))
    .filter((x): x is { sh: XlsxSheet & { image: BlockImage }; i: number } => x.sh.image !== null);
  const types =
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_s, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
          'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    // Default 只在真有图时才写：没有图却声明 png 扩展名是死条目，
    // 而 golden 钉的是**字节**，多一条就等于所有旧产物的 diff 全变。
    (drawn.length === 0 ? "" : '<Default Extension="png" ContentType="image/png"/>') +
    drawn
      .map(
        (_x, k) =>
          `<Override PartName="/xl/drawings/drawing${k + 1}.xml" ` +
          'ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>',
      )
      .join("") +
    "</Types>";

  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";

  const workbook =
    XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map((s, i) => `<sheet name="${xesc(s.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";

  const wbRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" ` +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
          `Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${n + 1}" ` +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
    'Target="styles.xml"/></Relationships>';

  return [
    { name: "[Content_Types].xml", data: utf8(types) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "docProps/core.xml", data: utf8(coreXml()) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(wbRels) },
    { name: "xl/styles.xml", data: utf8(STYLES_XML) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: utf8(sheetXml(s)),
    })),
    ...drawn.flatMap(({ sh, i }, k) => [
      {
        name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        data: utf8(
          XML_DECL +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${k + 1}.xml"/>` +
            "</Relationships>",
        ),
      },
      {
        name: `xl/drawings/drawing${k + 1}.xml`,
        data: utf8(drawingXml(sh.image, sh.titleCell ? 2 : 0)),
      },
      {
        name: `xl/drawings/_rels/drawing${k + 1}.xml.rels`,
        data: utf8(
          XML_DECL +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${k + 1}.png"/>` +
            "</Relationships>",
        ),
      },
      { name: `xl/media/image${k + 1}.png`, data: sh.image.png },
    ]),
  ];
}

/** 创建/修改时间钉死（见 {@link ZIP_EPOCH}）：它是"同样输入同样字节"的另一半。 */
function coreXml(): string {
  const stamp = "2026-01-01T00:00:00Z";
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:creator>OntoCopilot</dc:creator><cp:lastModifiedBy>OntoCopilot</cp:lastModifiedBy>" +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

// ══════════════════════════════════════════════════════════════════
//  docx
// ══════════════════════════════════════════════════════════════════

/** Word 里靠谱的中文字体：优先微软雅黑（Windows/Office 必有），macOS 上 Word 会
 *  自己回退。设在 Normal 样式上，全篇继承。 */
const EAST_ASIA = "Microsoft YaHei";

/** 用得到的样式 id → 显示名。读回来的 `p.style.name` 就是右边这一列。 */
const DOCX_STYLES: ReadonlyArray<readonly [string, string]> = [
  ["Title", "Title"],
  ["Heading1", "heading 1"],
  ["Heading2", "heading 2"],
  ["Heading3", "heading 3"],
  ["Heading4", "heading 4"],
  ["ListBullet", "List Bullet"],
  ["ListBullet2", "List Bullet 2"],
  ["ListBullet3", "List Bullet 3"],
  ["ListNumber", "List Number"],
  ["ListNumber2", "List Number 2"],
  ["ListNumber3", "List Number 3"],
  ["TableGrid", "Table Grid"],
];
const DOCX_STYLE_IDS = new Set(DOCX_STYLES.map(([id]) => id));

/**
 * 一段的运行内容。
 *
 * `\n` → `<w:br/>`、`\t` → `<w:tab/>` 是 python-docx 的 `Run.text` setter 的行为
 * （`_RunContentAppender`），**不是**把换行原样塞进 `<w:t>`。差别是代码块在 Word
 * 里到底是多行还是挤成一行。
 */
function runXml(text: string, rpr = ""): string {
  const parts: string[] = [];
  let buf = "";
  const flushText = (): void => {
    if (buf !== "") {
      parts.push(`<w:t xml:space="preserve">${xesc(buf)}</w:t>`);
      buf = "";
    }
  };
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      flushText();
      parts.push("<w:br/>");
    } else if (ch === "\t") {
      flushText();
      parts.push("<w:tab/>");
    } else {
      buf += ch;
    }
  }
  flushText();
  return `<w:r>${rpr}${parts.join("")}</w:r>`;
}

function paraXml(text: string, opts: { style?: string; rpr?: string } = {}): string {
  const ppr = opts.style !== undefined ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  return `<w:p>${ppr}${text === "" ? "" : runXml(text, opts.rpr ?? "")}</w:p>`;
}

export function toDocx(doc: ExportDoc): Uint8Array {
  const body: string[] = [];
  const images: BlockImage[] = [];

  body.push(paraXml(doc.title, { style: "Title" }));
  if (doc.note) {
    // 9pt 斜体：出处那一行不该抢正文的注意力
    body.push(paraXml(doc.note, { rpr: "<w:rPr><w:i/><w:sz w:val=\"18\"/></w:rPr>" }));
  }

  for (const b of doc.blocks) {
    if (b.kind === "heading") {
      body.push(paraXml(b.text, { style: `Heading${Math.max(1, Math.min(4, b.level))}` }));
    } else if (b.kind === "rule") {
      body.push(paraXml("—".repeat(30)));
    } else if (b.kind === "code") {
      body.push(
        paraXml(b.text, {
          rpr: '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr>',
        }),
      );
    } else if (b.kind === "table") {
      if (b.columns.length === 0) continue;
      body.push(tableXml(b));
    } else if (b.kind === "image") {
      if (b.image === null) continue;
      images.push(b.image);
      body.push(imageParaXml(b.image, images.length));
      // 图注走 9pt 斜体，和出处那一行同一个视觉层级
      if (b.text) body.push(paraXml(b.text, { rpr: '<w:rPr><w:i/><w:sz w:val="18"/></w:rPr>' }));
    } else if (b.items.length > 0) {
      for (const [depth, marker, txt] of b.items) {
        const style = marker ? "ListNumber" : "ListBullet";
        // Word 内置样式只到三级；再深就退回同一级，别让它抛 KeyError
        const lvl = Math.min(depth, 2);
        const name = lvl === 0 ? style : `${style}${lvl + 1}`;
        body.push(
          DOCX_STYLE_IDS.has(name)
            ? paraXml(txt, { style: name })
            : paraXml("    ".repeat(depth) + "· " + txt),
        );
      }
    } else if (b.text) {
      body.push(paraXml(b.text));
    }
  }

  const document =
    XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join("")}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
    'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';

  return zipBytes(docxParts(document, images));
}

/**
 * 一张内联图。
 *
 * 宽度封在正文栏宽（A4 减两侧 1 英寸页边距 = 6.27in ≈ 5972175 EMU）以内并等比缩：
 * 一张 1600px 宽的流程图按原尺寸插进去，Word 里会有一半在页面外。
 */
function imageParaXml(image: BlockImage, index: number): string {
  const MAX_EMU = 5_972_175;
  const raw = Math.max(1, Math.round(image.width * EMU_PER_PX));
  const scale = raw > MAX_EMU ? MAX_EMU / raw : 1;
  const cx = Math.max(1, Math.round(raw * scale));
  const cy = Math.max(1, Math.round(image.height * EMU_PER_PX * scale));
  const id = index + 100;
  return (
    "<w:p><w:r><w:drawing>" +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${index}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${index}"/>` +
    "<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>" +
    '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    `r:embed="rIdImg${index}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
  );
}

function tableXml(b: Block): string {
  const n = b.columns.length;
  const grid = `<w:tblGrid>${"<w:gridCol/>".repeat(n)}</w:tblGrid>`;
  const cell = (text: string, bold: boolean): string =>
    '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>' +
    paraXml(text, bold ? { rpr: "<w:rPr><w:b/></w:rPr>" } : {}) +
    "</w:tc>";
  const head = `<w:tr>${b.columns.map((c) => cell(pyStr(c), true)).join("")}</w:tr>`;
  const rows = b.rows
    .map((r) => {
      const tcs: string[] = [];
      for (let i = 0; i < n; i += 1) tcs.push(cell(i < r.length ? pyStr(r[i]) : "", false));
      return `<w:tr>${tcs.join("")}</w:tr>`;
    })
    .join("");
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    "</w:tblPr>" +
    grid +
    head +
    rows +
    "</w:tbl>"
  );
}

function docxParts(document: string, images: readonly BlockImage[] = []): ZipEntry[] {
  const types =
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    (images.length === 0 ? "" : '<Default Extension="png" ContentType="image/png"/>') +
    "</Types>";

  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";

  const docRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    // 图的 rId 用 rIdImgN 而不是接着数：document.xml 里那串 r:embed 是在
    // 组装正文时写死的，跟着 styles/numbering 的编号走会在加块时错位。
    images
      .map(
        (_img, i) =>
          `<Relationship Id="rIdImg${i + 1}" ` +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
          `Target="media/image${i + 1}.png"/>`,
      )
      .join("") +
    "</Relationships>";

  return [
    { name: "[Content_Types].xml", data: utf8(types) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "docProps/core.xml", data: utf8(coreXml()) },
    { name: "word/document.xml", data: utf8(document) },
    { name: "word/_rels/document.xml.rels", data: utf8(docRels) },
    { name: "word/styles.xml", data: utf8(stylesXml()) },
    { name: "word/numbering.xml", data: utf8(NUMBERING_XML) },
    ...images.map((img, i) => ({ name: `word/media/image${i + 1}.png`, data: img.png })),
  ];
}

function stylesXml(): string {
  const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  // 关键的一行在 rFonts 上：不设 w:eastAsia，Word 打开时中文会被换成别的字体。
  // 10.5pt = 21 half-points。
  const normalRpr =
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="${EAST_ASIA}"/>` +
    '<w:sz w:val="21"/></w:rPr>';
  const heading = (id: string, name: string, size: number, before: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    '<w:basedOn w:val="Normal"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="60"/><w:outlineLvl w:val="${
      id === "Title" ? 0 : Number(id.slice(-1)) - 1
    }"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const listStyle = (id: string, name: string, numId: number, ilvl: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
    `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>` +
    `<w:ind w:left="${360 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:style>`;

  return (
    XML_DECL +
    `<w:styles xmlns:w="${w}">` +
    `<w:docDefaults><w:rPrDefault>${normalRpr}</w:rPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    `<w:name w:val="Normal"/><w:qFormat/>${normalRpr}</w:style>` +
    heading("Title", "Title", 40, 0) +
    heading("Heading1", "heading 1", 32, 240) +
    heading("Heading2", "heading 2", 28, 200) +
    heading("Heading3", "heading 3", 24, 180) +
    heading("Heading4", "heading 4", 22, 160) +
    listStyle("ListBullet", "List Bullet", 1, 0) +
    listStyle("ListBullet2", "List Bullet 2", 1, 1) +
    listStyle("ListBullet3", "List Bullet 3", 1, 2) +
    listStyle("ListNumber", "List Number", 2, 0) +
    listStyle("ListNumber2", "List Number 2", 2, 1) +
    listStyle("ListNumber3", "List Number 3", 2, 2) +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
    "<w:tblPr><w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
      .join("") +
    "</w:tblBorders></w:tblPr></w:style>" +
    "</w:styles>"
  );
}

/** 两套编号：1 = 项目符号，2 = 阿拉伯数字。三级足够 —— 更深的层级在 toDocx 里
 *  已经被折回第三级。 */
const NUMBERING_XML = (() => {
  const lvl = (i: number, fmt: string, text: string): string =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
    `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${360 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  return (
    XML_DECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0">' +
    [0, 1, 2].map((i) => lvl(i, "bullet", "•")).join("") +
    "</w:abstractNum>" +
    '<w:abstractNum w:abstractNumId="1">' +
    [0, 1, 2].map((i) => lvl(i, "decimal", `%${i + 1}.`)).join("") +
    "</w:abstractNum>" +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>"
  );
})();

// ══════════════════════════════════════════════════════════════════
//  pdf
// ══════════════════════════════════════════════════════════════════
export const PDF_CSS = `
* { font-family: sans-serif; }
h1 { font-size: 17px; margin: 0 0 10px 0; }
h2 { font-size: 13.5px; margin: 14px 0 5px 0; }
h3, h4, h5, h6 { font-size: 12px; margin: 11px 0 4px 0; }
p  { font-size: 10px; margin: 0 0 7px 0; line-height: 1.5; }
.note { font-size: 8.5px; color: #666; margin-bottom: 12px; }
li { font-size: 10px; margin-bottom: 3px; }
pre { font-family: monospace; font-size: 8.5px; background: #f4f2ee; padding: 6px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 12px 0; }
th { font-size: 9px; text-align: left; background: #efede8;
     border: 1px solid #d8d5ce; padding: 3px 5px; }
td { font-size: 9px; border: 1px solid #d8d5ce; padding: 3px 5px; vertical-align: top; }
`;

function esc(s: unknown): string {
  return pyStr(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 块 → HTML。PDF 走这条路（Story 吃 HTML），也方便单测看结构。 */
export function docToHtml(doc: ExportDoc): string {
  const out: string[] = [`<h1>${esc(doc.title)}</h1>`];
  if (doc.note) out.push(`<p class="note">${esc(doc.note)}</p>`);
  for (const b of doc.blocks) {
    if (b.kind === "heading") {
      const lvl = Math.max(2, Math.min(6, b.level + 1));
      out.push(`<h${lvl}>${esc(b.text)}</h${lvl}>`);
    } else if (b.kind === "rule") {
      out.push("<hr/>");
    } else if (b.kind === "code") {
      out.push(`<pre>${esc(b.text)}</pre>`);
    } else if (b.kind === "image") {
      if (b.image !== null) out.push(`<p><img src="${dataUri(b.image)}" alt="${esc(b.text)}"/></p>`);
      if (b.text) out.push(`<p class="note">${esc(b.text)}</p>`);
    } else if (b.kind === "table") {
      out.push("<table><tr>" + b.columns.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>");
      for (const r of b.rows) {
        out.push("<tr>" + r.map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>");
      }
      out.push("</table>");
    } else if (b.items.length > 0) {
      // 缩进用 margin 表达：Story 对嵌套 ul/ol 的支持不稳，扁平列表更可靠
      out.push("<ul>");
      for (const [depth, marker, txt] of b.items) {
        const pad = depth * 16;
        const lead = marker ? `${esc(marker)} ` : "";
        out.push(`<li style="margin-left:${pad}px">${lead}${esc(txt)}</li>`);
      }
      out.push("</ul>");
    } else if (b.text) {
      out.push(`<p>${esc(b.text)}</p>`);
    }
  }
  return out.join("\n");
}

/** HTML + CSS → PDF 字节。实现由部署方注入，见文件头。 */
export type PdfRenderer = (html: string, css: string) => Uint8Array;

let _pdfRenderer: PdfRenderer | null = null;

/** HTML + CSS → PDF 字节（异步）。真实排版器都是子进程，见 server/glue/pdf.ts。 */
export type PdfRendererAsync = (html: string, css: string) => Promise<Uint8Array>;

let _pdfRendererAsync: PdfRendererAsync | null = null;

/** HTML→PDF 排版器的接线点。传 null 解除（测试里用）。 */
export function registerPdfRenderer(fn: PdfRenderer | null): void {
  _pdfRenderer = fn;
}

/**
 * 异步排版器的接线点。
 *
 * **为什么要有异步这一路**：真实的排版器是起一个无头浏览器子进程，实测热启动
 * 2.2 秒。同步做等于把整台服务卡住两秒 —— 而这条服务是单线程的，那两秒里所有人的
 * 请求都在排队等一个人导 PDF。同步注册点保留原样（测试与老部署仍可用），
 * 生产走这一路。
 */
export function registerPdfRendererAsync(fn: PdfRendererAsync | null): void {
  _pdfRendererAsync = fn;
}

export function toPdf(doc: ExportDoc): Uint8Array {
  if (_pdfRenderer === null) {
    if (_pdfRendererAsync !== null) {
      // 明说要走异步口，不静默回落成别的格式，也不假装成功。
      throw new ExportDependencyMissing(
        "这台机器的 PDF 排版器是异步的，请走 renderAsync()（同步 render 出不了 pdf）",
      );
    }
    throw new ExportDependencyMissing(
      "PDF 需要一个 HTML→PDF 排版器，当前进程没有接线 —— " +
        "换 docx / xlsx / md，或在启动时调 registerPdfRenderer() 接一个",
    );
  }
  return _pdfRenderer(docToHtml(doc), PDF_CSS);
}

/** 这个进程有没有 pdf 排版能力（同步或异步都算）。 */
function pdfReady(): boolean {
  return _pdfRenderer !== null || _pdfRendererAsync !== null;
}

// ══════════════════════════════════════════════════════════════════
//  格式表
// ══════════════════════════════════════════════════════════════════
export interface ExportSpec {
  readonly ext: string;
  /** 线上形态（HTTP 头），保持 snake_case。 */
  readonly media_type: string;
  readonly label: string;
  readonly write: (doc: ExportDoc) => Uint8Array;
}

export const SPECS: Readonly<Record<string, ExportSpec>> = {
  md: { ext: "md", media_type: "text/markdown; charset=utf-8", label: "Markdown", write: toMarkdown },
  csv: { ext: "csv", media_type: "text/csv; charset=utf-8", label: "CSV", write: toCsv },
  xlsx: {
    ext: "xlsx",
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel",
    write: toXlsx,
  },
  docx: {
    ext: "docx",
    media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
    write: toDocx,
  },
  pdf: { ext: "pdf", media_type: "application/pdf", label: "PDF", write: toPdf },
};

/** 别名：用户嘴里说的和格式名往往不是一个词（"excel"、"表格"、"word"、"文档"）。 */
const ALIAS: Readonly<Record<string, string>> = {
  excel: "xlsx",
  xls: "xlsx",
  表格: "xlsx",
  spreadsheet: "xlsx",
  word: "docx",
  doc: "docx",
  文档: "docx",
  markdown: "md",
  文本: "md",
  txt: "md",
};

export const FORMATS: readonly string[] = Object.keys(SPECS);

/**
 * 这个进程**真的**导得出哪几种。
 *
 * 与 {@link FORMATS} 的区别是产品性的，不是技术性的：`FORMATS` 是格式表的全集，
 * 用于**解析**用户说的格式名；这个函数是运行时能力，用于**宣传**。
 *
 * 两者必须分开。pdf 需要外部排版器（`registerPdfRenderer`），生产进程至今没接过 ——
 * 如果宣传口径直接用 `FORMATS`，模型会照单全收地对用户说「给你导成 PDF」，
 * 用户点了才发现导不出来：一轮白跑加一次失信。
 *
 * 反过来也不能靠「把 pdf 从 SPECS 里删掉」来实现诚实 —— 删了之后
 * `resolveFormat("pdf")` 返回空，用户问 PDF 拿到的是泛泛的「不支持的格式」，
 * 比现在那句具体的「这台机器上没接排版器」更差。**照常能解析，只是不宣传。**
 */
export function availableFormats(): string[] {
  return FORMATS.filter((f) => f !== "pdf" || pdfReady());
}

/**
 * 装得下图片的格式。
 *
 * 与 {@link availableFormats} 同一条规矩：**能力要说得出**。csv 是纯文本、
 * 没有嵌图的位置；pdf 走 HTML 那条路（data URI），排版器接上了就能带图。
 * 模型据此决定是"照办"还是"先说清这个格式放不下图"，而不是导完让用户自己发现。
 */
export function imageFormats(): string[] {
  return availableFormats().filter((f) => f !== "csv");
}

export function supportsImages(fmt: string): boolean {
  const key = resolveFormat(fmt);
  return key !== "" && imageFormats().includes(key);
}

/** 格式表里有、但这个进程当前给不出来的。**要说得出，不能从清单里静默消失。** */
export function unavailableFormats(): string[] {
  return FORMATS.filter((f) => !availableFormats().includes(f));
}

export function resolveFormat(fmt: string): string {
  // Python 是 `.strip().lower().lstrip(".")`
  let f = pyStrip(fmt || "").toLowerCase();
  f = f.replace(/^\.+/, "");
  return f in SPECS ? f : (ALIAS[f] ?? "");
}

/** 写成字节。未知格式抛 ValueError（调用方转成给模型的回执）。 */
export function render(doc: ExportDoc, fmt: string): [Uint8Array, ExportSpec] {
  const key = resolveFormat(fmt);
  if (!key) {
    throw new ValueError(`不支持的格式「${fmt}」。可用：${Object.keys(SPECS).join("/")}`);
  }
  const spec = SPECS[key]!;
  return [spec.write(doc), spec];
}

/**
 * 异步口。**pdf 走这里，其余格式只是同步 render 的外壳。**
 *
 * 端口层（`server/dialogue/ports.ts` 的 ExportApiLike.render）本来就声明成 Promise，
 * 所以接线处换成这一个函数即可，调用方一行不用改。
 */
export async function renderAsync(
  doc: ExportDoc,
  fmt: string,
): Promise<[Uint8Array, ExportSpec]> {
  const key = resolveFormat(fmt);
  if (!key) {
    throw new ValueError(`不支持的格式「${fmt}」。可用：${Object.keys(SPECS).join("/")}`);
  }
  if (key === "pdf" && _pdfRendererAsync !== null) {
    return [await _pdfRendererAsync(docToHtml(doc), PDF_CSS), SPECS[key]!];
  }
  return render(doc, key);
}

/** 文件名里不能出现的字符（跨 Windows/macOS 取并集），外加控制字符。 */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const WS_RUN = new RegExp(`[${PY_SPACE}]+`, "gu");

/** 标题 → 文件名。**这也是路径穿越的唯一入口**，所以在这里就把分隔符干掉。 */
export function safeName(title: string, ext: string, opts: { fallback?: string } = {}): string {
  const fallback = opts.fallback ?? "导出";
  let t = pyStripChars(pyStrip(title || "").replace(BAD_NAME, "_"), ". ");
  t = pyStrip(sliceCodePoints(t.replace(WS_RUN, " "), 80)) || fallback;
  if (t === "." || t === "..") t = fallback;
  return `${t}.${ext}`;
}

export { ValueError };
