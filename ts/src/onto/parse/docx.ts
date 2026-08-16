/**
 * DOCX OOXML → {@link DocxContent}。
 *
 * 这里复用 PPTX 已经在生产使用的 ZIP/XML 读取器，不经过 HTML 中转：段落样式、
 * 合并单元格和 core properties 都会保留，正好对应 `DocxParser` 的三项输入契约。
 */

import { readFile } from "node:fs/promises";

import type {
  DocxContent,
  DocxCoreProps,
  DocxParagraph,
  DocxTable,
} from "./text.js";
import type { XElement } from "./doc/xmlet.js";
import {
  childrenNamed,
  descendants,
  firstDescendant,
  fromString,
  itertext,
  localName,
} from "./doc/xmlet.js";
import { BadZipFile, ZipArchive, ZipMemberMissing, hasDtdMarker } from "./doc/ziplite.js";

const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

interface ParagraphStyles {
  readonly names: ReadonlyMap<string, string>;
  readonly defaultName: string;
}

/** 读取真实 DOCX 所需的段落、表格和元数据原料。 */
export async function extractDocxContent(path: string): Promise<DocxContent> {
  let archive: ZipArchive;
  try {
    archive = ZipArchive.open(await readFile(path));
  } catch (error) {
    throw new Error(`不是可读取的 DOCX OOXML 包：${errorText(error)}`, { cause: error });
  }

  const infos = archive.infolist();
  const total = infos.reduce((sum, info) => sum + info.fileSize, 0);
  if (infos.some((info) => info.fileSize > MAX_MEMBER_BYTES) || total > MAX_TOTAL_BYTES) {
    throw new Error("DOCX 解压后体积超过安全上限，已拒绝解析");
  }

  const names = archive.nameSet();
  const document = readXml(archive, "word/document.xml");
  const styles = names.has("word/styles.xml")
    ? paragraphStyles(readXml(archive, "word/styles.xml"))
    : emptyStyles();
  const core = names.has("docProps/core.xml")
    ? coreProperties(readXml(archive, "docProps/core.xml"))
    : emptyCore();

  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  const body = firstDescendant(document, "body");
  if (body === null) throw new Error("DOCX 的 word/document.xml 缺少 w:body");
  collectBlocks(body, styles, paragraphs, tables);
  return { paragraphs, tables, core };
}

function readXml(archive: ZipArchive, part: string): XElement {
  let data: Buffer;
  try {
    data = archive.read(part);
  } catch (error) {
    throw new Error(`无法读取 DOCX OOXML part ${part}：${errorText(error)}`, { cause: error });
  }
  if (hasDtdMarker(data)) {
    throw new Error(`无法解析 DOCX OOXML part ${part}：含 DTD/ENTITY 声明`);
  }
  try {
    return fromString(data);
  } catch (error) {
    throw new Error(`无法解析 DOCX OOXML part ${part}：${errorText(error)}`, { cause: error });
  }
}

/**
 * Word 允许正文块藏在 content control / customXml 里；递归穿过这些容器，但遇到
 * 段落或表格即停止，避免把表格单元格里的段落重复算进 document.paragraphs。
 */
function collectBlocks(
  node: XElement,
  styles: ParagraphStyles,
  paragraphs: DocxParagraph[],
  tables: DocxTable[],
): void {
  for (const child of node.children) {
    const local = localName(child.tag);
    if (local === "p") {
      paragraphs.push({ text: paragraphText(child), style: paragraphStyle(child, styles) });
    } else if (local === "tbl") {
      tables.push(tableRows(child));
    } else {
      collectBlocks(child, styles, paragraphs, tables);
    }
  }
}

function paragraphStyles(root: XElement): ParagraphStyles {
  const names = new Map<string, string>();
  let defaultName = "Normal";
  for (const style of descendants(root, "style")) {
    if (attr(style, "type") !== "paragraph") continue;
    const styleId = attr(style, "styleId");
    if (!styleId) continue;
    const rawName = attr(childrenNamed(style, "name")[0], "val") || styleId;
    const displayName = canonicalStyleName(rawName);
    names.set(styleId, displayName);
    if (["1", "true", "on"].includes(attr(style, "default"))) defaultName = displayName;
  }
  return { names, defaultName };
}

function emptyStyles(): ParagraphStyles {
  return { names: new Map(), defaultName: "Normal" };
}

/** python-docx 会把 OOXML 内置名 `heading 2` 暴露为显示名 `Heading 2`。 */
function canonicalStyleName(name: string): string {
  const heading = /^heading\s*([1-9])$/iu.exec(name);
  return heading ? `Heading ${heading[1] as string}` : name;
}

function paragraphStyle(paragraph: XElement, styles: ParagraphStyles): string {
  const properties = childrenNamed(paragraph, "pPr")[0];
  const styleId = attr(childrenNamed(properties ?? emptyElement(), "pStyle")[0], "val");
  return styleId ? (styles.names.get(styleId) ?? canonicalStyleName(styleId)) : styles.defaultName;
}

function paragraphText(paragraph: XElement): string {
  const out: string[] = [];
  collectVisibleText(paragraph, out);
  return out.join("");
}

function collectVisibleText(node: XElement, out: string[]): void {
  const local = localName(node.tag);
  // python-docx 的 Paragraph.text 不把修订删除内容和字段指令当正文。
  if (["del", "moveFrom", "delText", "instrText", "pPr", "rPr"].includes(local)) return;
  if (local === "t") {
    out.push(itertext(node));
    return;
  }
  if (local === "tab" || local === "ptab") {
    out.push("\t");
    return;
  }
  if (local === "br" || local === "cr") {
    out.push("\n");
    return;
  }
  if (local === "noBreakHyphen") {
    out.push("\u2011");
    return;
  }
  if (local === "softHyphen") {
    out.push("\u00ad");
    return;
  }
  for (const child of node.children) collectVisibleText(child, out);
}

function tableRows(table: XElement): DocxTable {
  const rows: string[][] = [];
  // grid column → the text of the vertically merged cell that started above.
  const vertical = new Map<number, string>();
  for (const row of childrenNamed(table, "tr")) {
    const values: string[] = [];
    const rowProperties = childrenNamed(row, "trPr")[0];
    let column = nonnegativeInt(
      attr(childrenNamed(rowProperties ?? emptyElement(), "gridBefore")[0], "val"),
      0,
    );
    for (const cell of childrenNamed(row, "tc")) {
      const properties = childrenNamed(cell, "tcPr")[0];
      const span = Math.max(1, nonnegativeInt(
        attr(childrenNamed(properties ?? emptyElement(), "gridSpan")[0], "val"), 1));
      const merge = childrenNamed(properties ?? emptyElement(), "vMerge")[0];
      const mergeMode = merge === undefined ? null : (attr(merge, "val") || "continue");
      const ownText = cellText(cell);

      for (let offset = 0; offset < span; offset++) {
        const gridColumn = column + offset;
        let value = ownText;
        if (mergeMode === "continue") value = vertical.get(gridColumn) ?? ownText;
        values.push(value);
        if (mergeMode === "restart") vertical.set(gridColumn, ownText);
        else if (mergeMode === null) vertical.delete(gridColumn);
      }
      column += span;
    }
    rows.push(values);
  }
  return rows;
}

function cellText(cell: XElement): string {
  const paragraphs: string[] = [];
  collectCellParagraphs(cell, paragraphs);
  return paragraphs.join("\n");
}

function collectCellParagraphs(node: XElement, paragraphs: string[]): void {
  for (const child of node.children) {
    const local = localName(child.tag);
    if (local === "p") paragraphs.push(paragraphText(child));
    else if (local !== "tbl") collectCellParagraphs(child, paragraphs);
  }
}

function coreProperties(root: XElement): DocxCoreProps {
  const value = (name: string): string | null => {
    const node = descendants(root, name)[0];
    return node === undefined ? null : itertext(node);
  };
  const modified = value("modified");
  return {
    creator: value("creator"),
    last_modified_by: value("lastModifiedBy"),
    modified: modified ? pythonDatetimeString(modified) : modified,
    title: value("title"),
  };
}

function emptyCore(): DocxCoreProps {
  return { creator: null, last_modified_by: null, modified: null, title: null };
}

/** `str(datetime)` used by the Python parser: `T` becomes a space and UTC is `+00:00`. */
function pythonDatetimeString(value: string): string {
  return value.trim().replace("T", " ").replace(/Z$/iu, "+00:00");
}

/** OOXML 的 w:val / w:type 等属性会被 XML 读取器展开命名空间，按 local name 取。 */
function attr(element: XElement | undefined, name: string): string {
  if (element === undefined) return "";
  for (const [key, value] of Object.entries(element.attrib)) {
    if (localName(key) === name) return value;
  }
  return "";
}

function nonnegativeInt(raw: string, fallback: number): number {
  if (!/^\d+$/u.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** 只为了在可选父节点缺失时复用 childrenNamed；不会进入最终树。 */
function emptyElement(): XElement {
  return { tag: "", attrib: {}, text: null, tail: null, children: [] };
}

function errorText(error: unknown): string {
  if (error instanceof BadZipFile) return error.message;
  if (error instanceof ZipMemberMissing) return error.message;
  return error instanceof Error ? error.message : String(error);
}
