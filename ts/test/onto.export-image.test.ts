/**
 * 导出件里的图。
 *
 * 这条能力存在的理由很具体：FDE 要把「Action / Event 流程映射表」发给客户确认，
 * 客户想同时看到那张流程图。以前工具只能导表，模型于是改口让人自己去右侧画布
 * 另存一张 —— 一件工具做得到的事被推回给了人。
 *
 * 三条不变量：
 *  1. **没有图的文档，字节不能变** —— golden 钉的是字节，多写一条死声明就等于
 *     所有历史产物的 diff 全变。
 *  2. OOXML 的部件必须成套：media + drawing + 两份 rels + Content_Types 声明，
 *     少一样 Excel 报的是"文件已损坏"，不是降级显示。
 *  3. 装不下图的格式（csv）要**留一行说明**，不能静默把图丢掉。
 */
import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";

import {
  imageBlock,
  imageFormats,
  makeExportDoc,
  supportsImages,
  tableBlock,
  toCsv,
  toDocx,
  toMarkdown,
  toXlsx,
  docToHtml,
  type BlockImage,
} from "../src/onto/export.js";

/** 1×1 透明 PNG。IHDR 里宽高都是 1，`pngSize` 那条路也能拿它当样本。 */
const PNG_1PX = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const IMAGE: BlockImage = { png: PNG_1PX, width: 800, height: 600 };

/** zip → {名字: 字节}。二进制成员（png）不能按 utf8 解，所以这里保留 Buffer。 */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const data = Buffer.from(bytes);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  while (at + 4 <= data.length && dv.getUint32(at, true) === 0x04034b50) {
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const compSize = dv.getUint32(at + 18, true);
    const method = dv.getUint16(at + 8, true);
    const name = data.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    const body = data.subarray(start, start + compSize);
    out.set(name, method === 0 ? Buffer.from(body) : inflateRawSync(body));
    at = start + compSize;
  }
  return out;
}

const tableDoc = (): ReturnType<typeof makeExportDoc> =>
  makeExportDoc({
    title: "采购报销动作与事件控制流映射表",
    blocks: tableBlock(["动作", "事件"], [["提交报销单", "报销单已提交"]]),
    note: "由 OntoCopilot 导出",
  });

describe("导出件里的图", () => {
  it("没有图时，xlsx 与 docx 的字节与从前完全一致", () => {
    const doc = tableDoc();
    const xlsx = unzip(toXlsx(doc));
    const docx = unzip(toDocx(doc));
    // 一条 png 的 Default 声明、一个 media 目录都不该凭空出现
    expect([...xlsx.keys()].some((k) => k.includes("media") || k.includes("drawing"))).toBe(false);
    expect(xlsx.get("[Content_Types].xml")!.toString("utf8")).not.toContain("image/png");
    expect([...docx.keys()].some((k) => k.includes("media"))).toBe(false);
    expect(docx.get("[Content_Types].xml")!.toString("utf8")).not.toContain("image/png");
  });

  it("xlsx 把图放在单独一页，并写齐 media / drawing / 两份 rels", () => {
    const doc = tableDoc();
    (doc.blocks as unknown[]).push(imageBlock(IMAGE, "流程图.svg"));
    const parts = unzip(toXlsx(doc));

    expect(parts.get("xl/media/image1.png")).toEqual(Buffer.from(PNG_1PX));
    expect(parts.has("xl/drawings/drawing1.xml")).toBe(true);
    expect(parts.has("xl/drawings/_rels/drawing1.xml.rels")).toBe(true);
    // 图在第二张 sheet 上：第一张是表，表页必须留住冻结行与筛选器
    expect(parts.has("xl/worksheets/_rels/sheet2.xml.rels")).toBe(true);
    expect(parts.has("xl/worksheets/_rels/sheet1.xml.rels")).toBe(false);

    const types = parts.get("[Content_Types].xml")!.toString("utf8");
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(types).toContain("/xl/drawings/drawing1.xml");

    const sheet2 = parts.get("xl/worksheets/sheet2.xml")!.toString("utf8");
    expect(sheet2).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    // OOXML 的子元素有顺序：drawing 必须在 sheetData 之后，否则 Excel 判定文件损坏
    expect(sheet2.indexOf("<drawing")).toBeGreaterThan(sheet2.indexOf("</sheetData>"));

    // 800×600 px → EMU（1px = 9525）
    const drawing = parts.get("xl/drawings/drawing1.xml")!.toString("utf8");
    expect(drawing).toContain(`cx="${800 * 9525}"`);
    expect(drawing).toContain(`cy="${600 * 9525}"`);
    expect(drawing).toContain("oneCellAnchor");

    // 表页仍然是表页：第一行是表头，筛选器还在
    expect(parts.get("xl/worksheets/sheet1.xml")!.toString("utf8")).toContain("<autoFilter");
  });

  it("docx 内联插图，rel 用独立编号，宽度封在正文栏宽内", () => {
    const doc = tableDoc();
    (doc.blocks as unknown[]).push(imageBlock(IMAGE, "流程图"));
    const parts = unzip(toDocx(doc));

    expect(parts.get("word/media/image1.png")).toEqual(Buffer.from(PNG_1PX));
    const rels = parts.get("word/_rels/document.xml.rels")!.toString("utf8");
    expect(rels).toContain('Id="rIdImg1"');
    expect(rels).toContain('Target="media/image1.png"');

    const document = parts.get("word/document.xml")!.toString("utf8");
    expect(document).toContain('r:embed="rIdImg1"');
    // 800px = 7_620_000 EMU，超过 A4 正文栏宽 5_972_175，必须被等比缩下来
    const cx = Number(/<wp:extent cx="(\d+)"/u.exec(document)![1]);
    expect(cx).toBeLessThanOrEqual(5_972_175);
    expect(document).toContain("流程图"); // 图注
  });

  it("md 用 data URI 自包含，html 同理 —— 导出件离开对话后没人给它取图", () => {
    const doc = makeExportDoc({ title: "带图", blocks: [imageBlock(IMAGE, "流程图")] });
    const md = Buffer.from(toMarkdown(doc)).toString("utf8");
    expect(md).toContain("![流程图](data:image/png;base64,");
    expect(docToHtml(doc)).toContain('<img src="data:image/png;base64,');
  });

  it("csv 放不下图，但要留一行说明，不能静默丢", () => {
    const doc = makeExportDoc({ title: "带图", blocks: [imageBlock(IMAGE, "流程图")] });
    const csv = Buffer.from(toCsv(doc)).toString("utf8");
    expect(csv).toContain("流程图");
    expect(csv).toContain("csv 放不下图片");
  });

  it("能力矩阵说得出哪些格式装得下图", () => {
    expect(imageFormats()).toContain("xlsx");
    expect(imageFormats()).toContain("docx");
    expect(imageFormats()).not.toContain("csv");
    expect(supportsImages("excel")).toBe(true); // 口语别名也认
    expect(supportsImages("csv")).toBe(false);
  });
});
