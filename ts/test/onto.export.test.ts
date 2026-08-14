/**
 * `onto/export.ts` + `onto/template_plan.ts` —— 对着 `golden/onto.export.json` 跑。
 *
 * golden 是 Python 真跑出来的**完整产物**（块列表、md/csv 的全部字节、xlsx/docx
 * 读回来的逐格 dump、提示词全文），所以这里几乎不手写期望值：手写的期望值是对
 * Python 行为的猜测，golden 是它的事实。
 *
 * 手写的只有三类，都是 Python 侧覆盖不到、而 TS 侧有风险的：
 *   1. **确定性**（同样输入两次导出字节必须相同）—— Python 侧靠 `_freeze_xlsx`
 *      事后重写，TS 侧是从写的时候就钉死，得有人验。
 *   2. **产物真能被另一个实现读回来** —— xlsx 手写 OOXML，用 exceljs（一个独立
 *      的读侧实现）打开它；docx 拆包看 XML。
 *   3. **PDF 的缺席分支**：没接线时抛 `ExportDependencyMissing` 而不是别的错。
 */

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  ExportDependencyMissing,
  FORMATS,
  SPECS,
  ValueError,
  blocksFromMarkdown,
  docToHtml,
  makeBlock,
  makeExportDoc,
  registerPdfRenderer,
  render,
  resolveFormat,
  safeName,
  tableBlock,
  toXlsx,
} from "../src/onto/export.js";
import type { Block, ExportDoc } from "../src/onto/export.js";
import type { ExportModule } from "../src/server/routes/artifacts.js";
import type { ExportApi } from "../src/server/dialogue/ports.js";
import { applyPlan, planPrompt } from "../src/onto/template_plan.js";
import { TemplateSpec } from "../src/onto/template.js";

const requireCjs = createRequire(import.meta.url);
type ExcelJsModule = typeof import("exceljs");
const ExcelJS = requireCjs("exceljs") as ExcelJsModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, "..", "..", "golden", "onto.export.json"), "utf8"),
) as Golden;

interface BlockDump {
  kind: string;
  text: string;
  level: number;
  items: [number, string, string][];
  columns: string[];
  rows: unknown[][];
}
interface DocDump {
  title: string;
  note: string;
  blocks: BlockDump[];
}
interface CellDump {
  v: string | number | boolean | null;
  t: string;
}
interface SheetDump {
  title: string;
  max_row: number;
  max_column: number;
  dimensions: string;
  freeze_panes: string | null;
  auto_filter: string | null;
  widths: Record<string, number>;
  cells: CellDump[][];
}
interface XlsxDump {
  sheetnames: string[];
  sheets: SheetDump[];
}
interface DocxDump {
  east_asia: string;
  ascii_font: string;
  paragraphs: { style: string; text: string }[];
  tables: string[][][];
}
interface Golden {
  blocks: Record<string, BlockDump[]>;
  md_cases: Record<string, string>;
  docs: Record<string, DocDump>;
  markdown: Record<string, string>;
  csv: Record<string, string>;
  html: Record<string, string>;
  xlsx: Record<string, XlsxDump>;
  docx: Record<string, DocxDump>;
  specs: Record<string, { ext: string; media_type: string; label: string }>;
  formats: string[];
  resolve_format: [string, string][];
  safe_name: [string, string, string][];
  safe_name_fallback: string;
  template_plan: {
    spec_before: Record<string, unknown>;
    edits: Record<string, unknown>[];
    applied: string[];
    rejected: Record<string, unknown>[];
    spec_after: Record<string, unknown>;
    applied_empty: string[];
    prompt: string;
    prompt_empty: string;
  };
}

function dumpBlock(b: Block): BlockDump {
  return {
    kind: b.kind,
    text: b.text,
    level: b.level,
    items: b.items.map((x) => [x[0], x[1], x[2]]),
    columns: [...b.columns],
    rows: b.rows.map((r) => [...r]),
  };
}

/** golden 里的 doc dump → TS 的 ExportDoc（服务端组装的形态由别的段负责）。 */
function docFromDump(d: DocDump): ExportDoc {
  return makeExportDoc({
    title: d.title,
    note: d.note,
    blocks: d.blocks.map((b) =>
      makeBlock(b.kind, {
        text: b.text,
        level: b.level,
        items: b.items.map((x) => [x[0], x[1], x[2]] as const),
        columns: b.columns,
        rows: b.rows,
      }),
    ),
  });
}

const DOC_NAMES = ["table_doc", "injection", "collide", "prose_only", "typed"] as const;

// ══════════════════════════════════════════════════════════════════
//  markdown → 块
// ══════════════════════════════════════════════════════════════════
describe("blocksFromMarkdown", () => {
  for (const name of Object.keys(GOLDEN.blocks)) {
    it(`与 Python 一致：${name}`, () => {
      const got = blocksFromMarkdown(GOLDEN.md_cases[name]!).map(dumpBlock);
      expect(got).toEqual(GOLDEN.blocks[name]);
    });
  }

  it("三条正则的 Python 语义（照抄字面量就会红）", () => {
    // `\d` 是整个 Nd 类 —— 阿拉伯-印度数字也是有序列表的序号
    const arabic = blocksFromMarkdown("٣. 阿拉伯-印度数字序号\n")[0]!;
    expect(arabic.items[0]![1]).toBe("٣.");
    // `\w` 含汉字 —— 汉字紧邻时那对星号不成立，正文里要留着它们
    expect(blocksFromMarkdown("前*不是斜体*后\n")[0]!.text).toBe("前*不是斜体*后");
    expect(blocksFromMarkdown("空格 *是斜体* 空格\n")[0]!.text).toBe("空格 是斜体 空格");
    // `\s` 认 U+0085 不认 U+FEFF
    expect(blocksFromMarkdown("# 标题\n")[0]!.kind).toBe("heading");
    expect(blocksFromMarkdown("﻿# 标题\n")[0]!.kind).toBe("para");
  });
});

// ══════════════════════════════════════════════════════════════════
//  markdown / csv / html
// ══════════════════════════════════════════════════════════════════
describe("落成字节", () => {
  for (const name of DOC_NAMES) {
    const doc = (): ExportDoc => docFromDump(GOLDEN.docs[name]!);

    it(`markdown 逐字节一致：${name}`, () => {
      const [data, spec] = render(doc(), "md");
      expect(Buffer.from(data).toString("utf8")).toBe(GOLDEN.markdown[name]);
      expect(spec.ext).toBe("md");
    });

    it(`csv 逐字节一致（含 BOM 与 CRLF）：${name}`, () => {
      const [data] = render(doc(), "csv");
      expect(Buffer.from(data).toString("base64")).toBe(GOLDEN.csv[name]);
    });

    it(`doc_to_html 逐字一致：${name}`, () => {
      expect(docToHtml(doc())).toBe(GOLDEN.html[name]);
    });
  }

  it("csv 带 BOM —— 没有它 Excel 打开中文是乱码，而那会被当成系统坏了", () => {
    const [data] = render(docFromDump(GOLDEN.docs["table_doc"]!), "csv");
    expect([...data.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("csv 里每一格公式触发字符都被前缀单引号挡住", () => {
    const [data] = render(docFromDump(GOLDEN.docs["injection"]!), "csv");
    const body = Buffer.from(data.slice(3)).toString("utf8");
    for (const line of body.split("\r\n")) {
      for (const cell of line.split(",")) {
        expect(cell.replace(/^"|"$/g, "").startsWith("=")).toBe(false);
        expect(cell.replace(/^"|"$/g, "").startsWith("+")).toBe(false);
        expect(cell.replace(/^"|"$/g, "").startsWith("@")).toBe(false);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  xlsx
// ══════════════════════════════════════════════════════════════════

/** exceljs 读回来的一页，折成 golden 的形状。 */
async function readXlsx(data: Uint8Array): Promise<XlsxDump> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  const sheets: SheetDump[] = wb.worksheets.map((ws) => {
    const maxRow = ws.rowCount;
    const maxCol = ws.columnCount;
    const cells: CellDump[][] = [];
    for (let r = 1; r <= maxRow; r += 1) {
      const row: CellDump[] = [];
      for (let c = 1; c <= maxCol; c += 1) {
        const v = ws.getCell(r, c).value;
        // openpyxl 的空格子是 `{"v": null, "t": "n"}`；exceljs 给 null
        row.push(
          v === null || v === undefined
            ? { v: null, t: "n" }
            : typeof v === "number"
              ? { v, t: "n" }
              : typeof v === "boolean"
                ? { v, t: "b" }
                : { v: String(v), t: "s" },
        );
      }
      cells.push(row);
    }
    const widths: Record<string, number> = {};
    for (let c = 1; c <= maxCol; c += 1) {
      const w = ws.getColumn(c).width;
      if (w !== undefined) widths[ws.getColumn(c).letter] = w;
    }
    const view = ws.views[0];
    return {
      title: ws.name,
      max_row: maxRow,
      max_column: maxCol,
      dimensions: `A1:${ws.getColumn(maxCol).letter}${maxRow}`,
      freeze_panes:
        view !== undefined && view.state === "frozen" ? `A${(view.ySplit ?? 0) + 1}` : null,
      auto_filter: (ws.autoFilter as string | undefined) ?? null,
      widths,
      cells,
    };
  });
  return { sheetnames: wb.worksheets.map((w) => w.name), sheets };
}

describe("xlsx", () => {
  for (const name of DOC_NAMES) {
    it(`语义与 openpyxl 的产物一致：${name}`, async () => {
      const want = GOLDEN.xlsx[name]!;
      const got = await readXlsx(toXlsx(docFromDump(GOLDEN.docs[name]!)));
      expect(got.sheetnames).toEqual(want.sheetnames);
      want.sheets.forEach((ws, i) => {
        const gs = got.sheets[i]!;
        expect(gs.title).toBe(ws.title);
        expect(gs.max_row).toBe(ws.max_row);
        expect(gs.max_column).toBe(ws.max_column);
        expect(gs.dimensions).toBe(ws.dimensions);
        expect(gs.freeze_panes).toBe(ws.freeze_panes);
        expect(gs.auto_filter).toBe(ws.auto_filter);
        expect(gs.widths).toEqual(ws.widths);
        expect(gs.cells).toEqual(ws.cells);
      });
    });
  }

  it("看起来像公式的一格仍然是文本 —— 也没被加上单引号", async () => {
    const got = await readXlsx(toXlsx(docFromDump(GOLDEN.docs["table_doc"]!)));
    const flat = got.sheets.flatMap((s) => s.cells.flat());
    const cell = flat.find((c) => typeof c.v === "string" && c.v.startsWith("=SUM"));
    expect(cell).toBeDefined();
    expect(cell!.t).toBe("s");
    expect(cell!.v).toBe("=SUM(A1) 会不会被当成公式");
  });

  it("整页扫，一格不漏：表头和说明页也不许留下公式", async () => {
    const got = await readXlsx(toXlsx(docFromDump(GOLDEN.docs["injection"]!)));
    for (const s of got.sheets) {
      for (const c of s.cells.flat()) {
        // t === "f" 是 openpyxl 的公式类型位；这条路根本不产生公式
        expect(c.t).not.toBe("f");
      }
    }
  });

  it("表名过了 Excel 的三条硬规矩", async () => {
    const got = await readXlsx(toXlsx(docFromDump(GOLDEN.docs["collide"]!)));
    expect(new Set(got.sheetnames).size).toBe(got.sheetnames.length);
    for (const n of got.sheetnames) {
      expect([...n].length).toBeLessThanOrEqual(31);
      expect(/[\\/*?:[\]]/.test(n)).toBe(false);
    }
  });

  it("同样的输入 → 同样的字节（不然每次导出的 diff 全是噪声）", () => {
    const a = toXlsx(docFromDump(GOLDEN.docs["table_doc"]!));
    const b = toXlsx(docFromDump(GOLDEN.docs["table_doc"]!));
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    // 时间戳真的被钉住了（zip 成员的 DOS 日期 = 2026-01-01）
    expect(new DataView(a.buffer, a.byteOffset).getUint16(12, true)).toBe(
      ((2026 - 1980) << 9) | (1 << 5) | 1,
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  docx
// ══════════════════════════════════════════════════════════════════

/** 拆包读 XML。docx 没有 TS 侧的读实现，所以直接看 XML —— 也正因为如此，
 *  这些断言盯的是**结构**（段落顺序、样式 id、表格矩阵），不是字节。 */
function unzip(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 4 <= data.length && dv.getUint32(at, true) === 0x04034b50) {
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const compSize = dv.getUint32(at + 18, true);
    const name = Buffer.from(data.slice(at + 30, at + 30 + nameLen)).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    const body = data.slice(start, start + compSize);
    out.set(name, inflateRawSync(Buffer.from(body)).toString("utf8"));
    at = start + compSize;
  }
  return out;
}

/** `<w:p>` → (styleId, 纯文本)，与 python-docx 的 `p.style.name` / `p.text` 对应。
 *  只走文档级的段落（表格里的不算），与 `Document.paragraphs` 同一个口径。 */
function docxParagraphs(xml: string): { style: string; text: string }[] {
  const bodyOnly = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, "");
  const out: { style: string; text: string }[] = [];
  for (const m of bodyOnly.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1]!;
    const style = /<w:pStyle w:val="([^"]+)"\/>/.exec(inner)?.[1] ?? "Normal";
    const text = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((t) => unxesc(t[1]!))
      .join("");
    out.push({ style, text });
  }
  return out;
}

function unxesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** golden 里的样式**显示名** → 本实现写的样式 id。 */
const STYLE_ID: Readonly<Record<string, string>> = {
  Normal: "Normal",
  Title: "Title",
  "heading 1": "Heading1",
  "heading 2": "Heading2",
  "heading 3": "Heading3",
  "heading 4": "Heading4",
  "Heading 1": "Heading1",
  "Heading 2": "Heading2",
  "Heading 3": "Heading3",
  "Heading 4": "Heading4",
  "List Bullet": "ListBullet",
  "List Bullet 2": "ListBullet2",
  "List Bullet 3": "ListBullet3",
  "List Number": "ListNumber",
  "List Number 2": "ListNumber2",
  "List Number 3": "ListNumber3",
};

describe("docx", () => {
  for (const name of DOC_NAMES) {
    it(`段落与表格和 python-docx 的产物一致：${name}`, () => {
      const want = GOLDEN.docx[name]!;
      const [data] = render(docFromDump(GOLDEN.docs[name]!), "docx");
      const parts = unzip(data);
      const doc = parts.get("word/document.xml")!;

      expect(docxParagraphs(doc)).toEqual(
        want.paragraphs.map((p) => ({ style: STYLE_ID[p.style] ?? p.style, text: p.text })),
      );

      const tables = [...doc.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((m) =>
        [...m[1]!.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map((r) =>
          [...r[1]!.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) =>
            [...c[1]!.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => unxesc(t[1]!)).join(""),
          ),
        ),
      );
      expect(tables).toEqual(want.tables);
    });
  }

  it("Normal 样式带 w:eastAsia —— 不设它 Word 会把中文换成别的字体", () => {
    const [data] = render(docFromDump(GOLDEN.docs["table_doc"]!), "docx");
    const styles = unzip(data).get("word/styles.xml")!;
    expect(styles).toContain(`w:eastAsia="${GOLDEN.docx["table_doc"]!.east_asia}"`);
    expect(styles).toContain(`w:ascii="${GOLDEN.docx["table_doc"]!.ascii_font}"`);
  });

  it("代码块里的换行是 <w:br/>，不是塞进 <w:t> 的裸换行", () => {
    const doc = makeExportDoc({ title: "t", blocks: [makeBlock("code", { text: "a\nb\tc" })] });
    const xml = unzip(render(doc, "docx")[0]).get("word/document.xml")!;
    expect(xml).toContain("<w:br/>");
    expect(xml).toContain("<w:tab/>");
  });

  it("同样的输入 → 同样的字节", () => {
    const doc = (): ExportDoc => docFromDump(GOLDEN.docs["table_doc"]!);
    expect(Buffer.from(render(doc(), "docx")[0]).toString("hex")).toBe(
      Buffer.from(render(doc(), "docx")[0]).toString("hex"),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  pdf（未接线的那条分支）
// ══════════════════════════════════════════════════════════════════
describe("pdf", () => {
  afterEach(() => registerPdfRenderer(null));

  it("没接排版器时抛 ExportDependencyMissing —— 对话工具据此回「这台机器上导不出 pdf」", () => {
    const doc = docFromDump(GOLDEN.docs["table_doc"]!);
    expect(() => render(doc, "pdf")).toThrow(ExportDependencyMissing);
  });

  it("接上渲染器之后走的是 doc_to_html + PDF_CSS", () => {
    let seen = "";
    registerPdfRenderer((html) => {
      seen = html;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    });
    const doc = docFromDump(GOLDEN.docs["table_doc"]!);
    const [data, spec] = render(doc, "pdf");
    expect(seen).toBe(GOLDEN.html["table_doc"]);
    expect(spec.media_type).toBe("application/pdf");
    expect(Buffer.from(data).toString("latin1")).toBe("%PDF");
  });
});

// ══════════════════════════════════════════════════════════════════
//  格式名 / 文件名
// ══════════════════════════════════════════════════════════════════
describe("格式与文件名", () => {
  it("格式表与 Python 一致", () => {
    expect([...FORMATS]).toEqual(GOLDEN.formats);
    for (const [k, want] of Object.entries(GOLDEN.specs)) {
      const spec = SPECS[k]!;
      expect([spec.ext, spec.media_type, spec.label]).toEqual([
        want.ext,
        want.media_type,
        want.label,
      ]);
    }
  });

  it("用户嘴里说的词都映射得上", () => {
    for (const [said, want] of GOLDEN.resolve_format) {
      expect([said, resolveFormat(said)]).toEqual([said, want]);
    }
  });

  it("认不出的格式是拒绝，不是猜一个", () => {
    expect(resolveFormat("pptx")).toBe("");
    expect(() => render(makeExportDoc({ title: "x" }), "pptx")).toThrow(ValueError);
    expect(() => render(makeExportDoc({ title: "x" }), "pptx")).toThrow(
      "不支持的格式「pptx」。可用：md/csv/xlsx/docx/pdf",
    );
  });

  it("文件名与 Python 逐字一致（这是路径穿越的唯一入口）", () => {
    for (const [title, ext, want] of GOLDEN.safe_name) {
      expect([title, safeName(title, ext)]).toEqual([title, want]);
      expect(want).not.toContain("/");
      expect(want).not.toContain("\\");
      expect(want.startsWith(".")).toBe(false);
    }
    expect(safeName("", "md", { fallback: "兜底" })).toBe(GOLDEN.safe_name_fallback);
  });
});

// ══════════════════════════════════════════════════════════════════
//  tableBlock / ExportDoc.tables
// ══════════════════════════════════════════════════════════════════
describe("文档模型", () => {
  it("tableBlock 把 None 折成空串、别的 str 化", () => {
    const blocks = tableBlock(["a", "b"], [[null, 1], [true, ["x"]]], "标题");
    expect(blocks[0]!.kind).toBe("heading");
    expect(blocks[1]!.rows).toEqual([
      ["", "1"],
      ["True", "['x']"],
    ]);
  });

  it("tables 是动态属性 —— 组装方后塞的表也要看得见", () => {
    const doc = makeExportDoc({ title: "t" });
    expect(doc.tables).toEqual([]);
    (doc.blocks as Block[]).push(...tableBlock(["a"], [["1"]]));
    expect(doc.tables.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  两个消费方的接缝
// ══════════════════════════════════════════════════════════════════
describe("接缝", () => {
  it("能填进 artifacts 的 ExportModule（**同步** render）与 dialogue 的 ExportApi", () => {
    // 编译期断言：这两个接口是 server 两段**已经落地**的调用面。artifacts 那边的
    // `render` 是同步签名 —— 这正是 xlsx/docx 手写 OOXML 而不用 exceljs（只有
    // async 写接口）的原因。真装配在 serve.ts，这里只钉住形状。
    const artifacts: ExportModule = {
      resolveFormat,
      tableBlock: (columns, rows, title) => tableBlock(columns, rows, title ?? ""),
      makeDoc: (p) => makeExportDoc({ ...p, blocks: p.blocks as Block[] }),
      render: (doc, fmt) => render(doc as ExportDoc, fmt),
      safeName,
    };
    const dialogue: ExportApi = {
      FORMATS,
      resolveFormat,
      render: async (doc, fmt) => render(doc as unknown as ExportDoc, fmt),
      safeName,
    };
    expect(artifacts.resolveFormat("excel")).toBe("xlsx");
    expect(dialogue.FORMATS).toEqual(GOLDEN.formats);
  });
});

// ══════════════════════════════════════════════════════════════════
//  template_plan
// ══════════════════════════════════════════════════════════════════
describe("template_plan", () => {
  const G = GOLDEN.template_plan;

  it("提示词逐字一致（含 stats 的 Python dict repr）", () => {
    expect(
      planPrompt({
        project: "集采平台",
        stats: { objects: 12, properties: 40 },
        sheets: TemplateSpec.fromDict(G.spec_before).sheets.map((sh) => ({
          name: sh.name,
          rows: sh.rows.length,
          columns: [...sh.columns],
        })),
        vocabulary: ["集采", "采购包", "供应商", ...Array.from({ length: 45 }, (_v, i) => `词${i}`)],
        openQuestions: Array.from({ length: 12 }, (_v, i) => `第 ${i} 个待澄清问题？`),
      }),
    ).toBe(G.prompt);
  });

  it("什么都没有时也拼得出提示词（空段整段不出现）", () => {
    expect(
      planPrompt({ project: "", stats: {}, sheets: [], vocabulary: [], openQuestions: [] }),
    ).toBe(G.prompt_empty);
  });

  it("逐条独立：一条违规只丢那一条，其余照常应用", () => {
    const spec = TemplateSpec.fromDict(G.spec_before);
    const [applied, rejected] = applyPlan(spec, G.edits);
    expect(applied).toEqual(G.applied);
    expect(rejected.map((r) => r["why_rejected"])).toEqual(
      G.rejected.map((r) => r["why_rejected"]),
    );
    // 被拒的条目原样带回，模型要靠它知道自己提的是哪一条
    expect(rejected.map(({ why_rejected: _w, ...rest }) => rest)).toEqual(
      G.rejected.map(({ why_rejected: _w, ...rest }) => rest),
    );
    // 剩下的 spec 与 Python 侧一模一样（没有半应用的中间态）
    expect(spec.toDict()).toEqual(G.spec_after);
  });

  it("edits 为空/缺席时不炸", () => {
    const spec = TemplateSpec.fromDict(G.spec_before);
    expect(applyPlan(spec, [])[0]).toEqual(G.applied_empty);
    expect(applyPlan(spec, null)[0]).toEqual([]);
    expect(spec.toDict()).toEqual(G.spec_before);
  });
});
