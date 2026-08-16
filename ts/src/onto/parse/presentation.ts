/**
 * PowerPoint `.pptx` -> 按页的正文、表格、备注与可追溯证据。
 *
 * Python 原件先试 `python-pptx`，失败或缺包时退回内置的 OOXML ZIP/XML 读取器。
 * **TS 侧没有 `python-pptx` 的对等物**，所以只实现那条兜底路径 —— 但那条 finding
 * 照样发：它的后半句（"复杂 SmartArt/图表不会被当作已解析内容"）在这边同样成立，
 * 而"降级是显式 finding，不把只读到一部分伪装成成功"正是这个解析器的立身之本。
 *
 * ── 这个文件里最值钱的两条 ──────────────────────────────────────
 *
 * 1. **页码按 `p:sldIdLst` 的关系顺序，不是 `slideN.xml` 的 N。**
 *    OOXML 允许 `slide2.xml` 排在第一页。猜 N 的话，"第 1 页"指向的是物理第一片，
 *    而人看到的第一页是另一张 —— 每一条溯源都错位一整页。
 * 2. **文本框按文档顺序发切片。** 顺序乱了，材料的语义就乱了（同一页里"前提"
 *    和"结论"两个框换个位置，读出来就是反的）。所以 `iter()` 的文档序是硬约束，
 *    不能为了"先发标题"之类的直觉去重排。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { pyRepr } from "../../kernel/errors.js";
import type { Finding, ParsedDoc } from "./base.js";
import { Parser, makeChunk, makeFinding, makeParsedDoc } from "./base.js";
import { pyInt, pyNormalizeSpaces, pySplitlines, pyStrip } from "./doc/pycompat.js";
import type { XElement } from "./doc/xmlet.js";
import {
  childrenNamed,
  descendants,
  firstDescendant,
  fromString,
  iterElements,
  itertext,
  localName,
} from "./doc/xmlet.js";
import { BadZipFile, ZipArchive, ZipMemberMissing, hasDtdMarker } from "./doc/ziplite.js";

const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Python 的 `\d` 认全角数字，JS 的不认。OOXML 部件名里出现全角数字属于病态输入，
// 不为它增加复杂度（见 notes 的已知差异）。
const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

/**
 * 建模相关的规则句特征。命中的切片打 `rule` 标签，检索时（tag boost）优先。
 *
 * **领域无关 + 双语**：Copilot 面向很多业务域和语言，线索只认"建模语义"（基数、
 * 约束、关系、键、口径），不夹带 含税/不含税 这种某个域独有的词 —— 那是例子不是
 * 规则线索。漏标不致命：rule 只是加权项，不是硬门禁。
 *
 * **它的家在 `text.ts`**（Python 侧 `presentation.py` 是 `from .text import _RULE_HINTS`）。
 * text.ts 还没落地，这里先放一份逐字相同的副本；text.ts 一到就该删掉这份改成
 * import —— 两份正则各自漂移的话，同一句话在 pptx 里打了 rule、在 docx 里没打，
 * 而没人会想到去比对两个正则。
 */
const RULE_HINTS = new RegExp(
  "一个|每个|多个|至少|最多|必须|不得|应当|需要"
  + "|由.{0,8}(生成|产生|创建|拆分|合并|触发|派生)"
  + "|对应|关联|引用|属于|一对多|多对多|一对一|唯一|主键|外键|默认|枚举|取值|口径|为准"
  + "|\\beach\\b|\\bevery\\b|\\bat least\\b|\\bat most\\b|\\bexactly one\\b|\\bmultiple\\b|\\bmany\\b"
  + "|\\bmust\\b|\\bshall\\b|\\bcannot\\b|\\brequired\\b|\\boptional\\b|\\bmandatory\\b"
  + "|\\breferences?\\b|\\bbelongs? to\\b|\\bassociated\\b|\\bone-to-many\\b|\\bmany-to-many\\b"
  + "|\\bunique\\b|\\bprimary key\\b|\\bforeign key\\b",
  "i",
);

/** Python 那条 `ImportError` 分支的文案，逐字照搬 —— 见文件头。 */
const FALLBACK_MESSAGE =
  "未安装 python-pptx，已使用内置 OOXML 兜底解析正文、表格和备注；"
  + "复杂 SmartArt/图表不会被当作已解析内容。";

interface SlideText {
  id: string;
  name: string;
  text: string;
  bbox: number[];
}

interface SlideTable {
  index: number;
  columns: string[];
  rows: number;
  data: string[][];
}

interface SlideData {
  number: number;
  title: string;
  texts: SlideText[];
  tables: SlideTable[];
  notes: string;
}

/** 提取每页文本框、表格行、演讲者备注和 Office 元数据。 */
export class PptxParser extends Parser {
  override readonly kind = "pptx";
  override readonly extensions = [".pptx", ".pptm", ".ppsx"];

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const doc = await parseOoxml(path, opts.fileId);
    doc.findings.unshift(
      makeFinding("parser_fallback", FALLBACK_MESSAGE, { kind: "package", path: "/" }),
    );
    return doc;
  }
}

export async function parseOoxml(path: string, fileId: string): Promise<ParsedDoc> {
  const fileName = basename(path);
  const doc = makeParsedDoc({ fileId, fileName, kind: "pptx" });

  let archive: ZipArchive;
  try {
    archive = ZipArchive.open(await readFile(path));
  } catch (e) {
    doc.findings.push(makeFinding(
      "parse_failed", `不是可读取的 PPTX OOXML 包：${zipErrorText(e)}`,
      { kind: "package", path: "/" }, "warn"));
    return doc;
  }

  const infos = archive.infolist();
  const total = infos.reduce((sum, info) => sum + info.fileSize, 0);
  // 闸门按**解压后**大小：按压缩后大小算的话，zip 炸弹恰好从这里穿过去。
  if (infos.some((info) => info.fileSize > MAX_MEMBER_BYTES) || total > MAX_TOTAL_BYTES) {
    doc.findings.push(makeFinding(
      "file_too_large", "PPTX 解压后体积超过安全上限，已拒绝解析",
      { kind: "package", path: "/" }, "warn"));
    return doc;
  }

  const names = archive.nameSet();
  ooxmlMetadata(doc, archive, names);
  const slideParts = orderedSlideParts(archive, names);
  const slides: SlideData[] = [];
  let order = 0;

  for (const [index, part] of slideParts.entries()) {
    const page = index + 1;
    const root = readXml(archive, part, doc.findings);
    if (root === null) continue;
    const slide: SlideData = { number: page, title: "", texts: [], tables: [], notes: "" };

    const titleCandidates: string[] = [];
    for (const [shapeIndex, shape] of descendants(root, "sp").entries()) {
      const shapeNo = shapeIndex + 1;
      const texts = descendants(shape, "t").map((node) => cleanText(itertext(node)));
      const text = cleanText(texts.filter((t) => t).join("\n"));
      if (!text) continue;
      const [shapeId, shapeName] = shapeIdentity(shape, shapeNo);
      const bbox = shapeBbox(shape);
      const placeholder = firstDescendant(shape, "ph");
      const placeholderType = placeholder !== null ? (placeholder.attrib["type"] ?? "") : "";
      if (placeholderType === "title" || placeholderType === "ctrTitle") {
        titleCandidates.push(text);
      }
      slide.texts.push({ id: shapeId, name: shapeName, text, bbox });
    }

    slide.title = titleCandidates[0] ?? (slide.texts[0]?.text ?? "");
    for (const shapeData of slide.texts) {
      doc.chunks.push(makeChunk({
        docId: `slide:${page}:shape:${shapeData.id}`,
        fileId, fileName,
        locator: {
          kind: "page", page, bbox: shapeData.bbox,
          shape_id: shapeData.id, shape: shapeData.name,
        },
        render: slideRender(page, slide.title, shapeData.text),
        raw: shapeData, order, tags: textTags("slide_text", shapeData.text),
      }));
      order += 1;
    }

    for (const [tableIndex, table] of descendants(root, "tbl").entries()) {
      const rows: string[][] = [];
      for (const row of childrenNamed(table, "tr")) {
        rows.push(childrenNamed(row, "tc").map((cell) => cleanText(
          descendants(cell, "t").map((t) => itertext(t)).join(" "))));
      }
      const tableData = tableFrom(tableIndex + 1, rows);
      slide.tables.push(tableData);
      order = emitTable(doc, {
        fileId, fileName, page, table: tableData, bbox: [0, 0, 0, 0],
        shapeId: `table-${tableIndex + 1}`, order,
      });
    }

    const notesPartName = notesPart(archive, names, part);
    const notesRoot = notesPartName ? readXml(archive, notesPartName, doc.findings) : null;
    if (notesRoot !== null) {
      const notes = notesText(notesRoot);
      if (notes) {
        slide.notes = notes;
        doc.chunks.push(makeChunk({
          docId: `slide:${page}:notes`, fileId, fileName,
          locator: {
            kind: "page", page, bbox: [0, 0, 0, 0], notes: true, part: notesPartName,
          },
          render: `PPT 第 ${page} 页演讲者备注：${notes}`,
          raw: { notes }, order, tags: textTags("speaker_notes", notes),
        }));
        order += 1;
      }
    }
    slides.push(slide);
  }

  doc.structured = { slides, slide_count: slides.length };
  if (slideParts.length === 0) {
    doc.findings.push(makeFinding(
      "empty_presentation", "PPTX 包中没有 slide part",
      { kind: "package", path: "/ppt/slides" }, "warn"));
  }
  return doc;
}

function ooxmlMetadata(doc: ParsedDoc, archive: ZipArchive, names: Set<string>): void {
  const part = "docProps/core.xml";
  if (!names.has(part)) return;
  const root = readXml(archive, part, doc.findings);
  if (root === null) return;
  const wanted = new Set(["creator", "lastModifiedBy", "modified", "title"]);
  const raw = new Map<string, string>();
  for (const node of iterElements(root)) {
    const local = localName(node.tag);
    // 后出现的覆盖先出现的 —— Python 的字典推导就是这个语义。
    if (wanted.has(local)) raw.set(local, cleanText(itertext(node)));
  }
  const meta: Record<string, string> = {
    creator: raw.get("creator") ?? "",
    last_modified_by: raw.get("lastModifiedBy") ?? "",
    modified: raw.get("modified") ?? "",
    title: raw.get("title") ?? "",
  };
  for (const [key, value] of Object.entries(meta)) {
    if (value) doc.meta[key] = value;
  }
  metadataFinding(doc, meta);
}

function metadataFinding(doc: ParsedDoc, meta: Record<string, string>): void {
  const leaked = Object.entries(meta)
    .filter(([key, value]) => (key === "creator" || key === "last_modified_by") && value);
  if (leaked.length > 0) {
    doc.findings.push(makeFinding(
      "metadata_leak",
      "演示文稿元数据里带着作者信息（"
      + leaked.map(([key, value]) => `${key}=${value}`).join("；")
      + "），对外发布前建议清理。",
      { kind: "meta", field: "docProps/core.xml" }, "warn"));
  }
}

function emitTable(doc: ParsedDoc, args: {
  fileId: string; fileName: string; page: number; table: SlideTable;
  bbox: number[]; shapeId: string; order: number;
}): number {
  const { fileId, fileName, page, table, bbox, shapeId } = args;
  let order = args.order;
  const columns = table.columns;
  if (columns.length > 0) {
    doc.chunks.push(makeChunk({
      docId: `slide:${page}:table:${table.index}:schema`, fileId, fileName,
      locator: {
        kind: "page", page, bbox, shape_id: shapeId, table: table.index, row: 1,
      },
      render: `PPT 第 ${page} 页表格 ${table.index} 列：`
        + columns.filter((value) => value).join("、"),
      raw: { columns }, order, tags: ["pptx", "table", "schema"],
    }));
    order += 1;
  }
  for (const [bodyIndex, row] of table.data.entries()) {
    const rowNo = bodyIndex + 2;
    const pairs = row
      .map((value, index) => {
        const column = columns[index];
        return { label: index < columns.length && column ? column : `C${index + 1}`, value };
      })
      .filter((pair) => pair.value)
      .map((pair) => `${pair.label}=${pair.value}`);
    if (pairs.length === 0) continue;
    const render = `PPT 第 ${page} 页表格 ${table.index} 第 ${rowNo} 行：` + pairs.join(" | ");
    doc.chunks.push(makeChunk({
      docId: `slide:${page}:table:${table.index}:row:${rowNo}`, fileId, fileName,
      locator: {
        kind: "page", page, bbox, shape_id: shapeId, table: table.index, row: rowNo,
      },
      render, raw: { row, columns }, order, tags: textTags("table", render),
    }));
    order += 1;
  }
  return order;
}

function tableFrom(index: number, rows: string[][]): SlideTable {
  const clean = rows
    .map((row) => row.map((value) => cleanText(value)))
    .filter((row) => row.some((value) => value));
  return {
    index,
    columns: clean[0] ?? [],
    rows: Math.max(0, clean.length - 1),
    data: clean.slice(1),
  };
}

function slideRender(page: number, title: string, text: string): string {
  const heading = title && title !== text ? `〔${title}〕\n` : "";
  return `PPT 第 ${page} 页\n${heading}${text}`;
}

function textTags(kind: string, text: string): string[] {
  return RULE_HINTS.test(text) ? ["pptx", kind, "rule"] : ["pptx", kind];
}

/** == `_read_xml`：读不出/解析不了都只是一条 finding，不能让整份材料失败。 */
function readXml(archive: ZipArchive, part: string, findings: Finding[]): XElement | null {
  try {
    const data = archive.read(part);
    if (hasDtdMarker(data)) throw new Error("含 DTD/ENTITY 声明");
    return fromString(data);
  } catch (e) {
    findings.push(makeFinding(
      "unparsed_part", `无法解析 OOXML part ${part}：${memberErrorText(e)}`,
      { kind: "package", path: `/${part}` }, "warn"));
    return null;
  }
}

function safeFromString(data: Buffer): XElement {
  if (hasDtdMarker(data)) throw new Error("含 DTD/ENTITY 声明");
  return fromString(data);
}

/** Python 的 `str(KeyError(msg))` 会**再套一层引号**，finding 文案里看得见。 */
function memberErrorText(e: unknown): string {
  if (e instanceof ZipMemberMissing) return pyRepr(e.message);
  return e instanceof Error ? e.message : String(e);
}

function zipErrorText(e: unknown): string {
  if (e instanceof BadZipFile) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function notesPart(archive: ZipArchive, names: Set<string>, slidePart: string): string {
  const [folder, name] = posixSplit(slidePart);
  const relsPart = posixJoin(folder, "_rels", name + ".rels");
  if (names.has(relsPart)) {
    try {
      const root = fromString(archive.read(relsPart));
      for (const rel of root.children) {
        if ((rel.attrib["Type"] ?? "").endsWith("/notesSlide")) {
          const resolved = posixNormpath(posixJoin(folder, rel.attrib["Target"] ?? ""));
          if (names.has(resolved)) return resolved;
        }
      }
    } catch {
      /* 关系文件坏了不是致命错误：下面还有按编号猜的兜底。 */
    }
  }
  const match = SLIDE_RE.exec(slidePart);
  const candidate = match ? `ppt/notesSlides/notesSlide${match[1]}.xml` : "";
  return names.has(candidate) ? candidate : "";
}

/**
 * 按演示文稿关系顺序返回 slide part，而不是猜 `slideN.xml` 的 N。
 *
 * OOXML 允许 `slide2.xml` 排在第一页；人看的页码必须跟 `p:sldIdLst` 一致。
 * 缺少关系文件的非标准/极简包才退回按数字文件名排序。
 */
function orderedSlideParts(archive: ZipArchive, names: Set<string>): string[] {
  const presentation = "ppt/presentation.xml";
  const relationships = "ppt/_rels/presentation.xml.rels";
  if (names.has(presentation) && names.has(relationships)) {
    try {
      const presentationRoot = safeFromString(archive.read(presentation));
      const relationshipsRoot = safeFromString(archive.read(relationships));
      const targets = new Map<string, string>();
      for (const rel of relationshipsRoot.children) {
        if ((rel.attrib["Type"] ?? "").endsWith("/slide")) {
          targets.set(rel.attrib["Id"] ?? "", rel.attrib["Target"] ?? "");
        }
      }
      const ordered: string[] = [];
      for (const slideId of descendants(presentationRoot, "sldId")) {
        // 关系 id 是**带命名空间**的属性（`r:id`），所以判据是"展开过 + local 名为
        // id"；只按 `id` 找会命中 `p:sldId` 自己那个无命名空间的 id。
        let relationId = "";
        for (const [key, value] of Object.entries(slideId.attrib)) {
          if (key.startsWith("{") && localName(key) === "id") {
            relationId = value;
            break;
          }
        }
        const part = posixNormpath(posixJoin("ppt", targets.get(relationId) ?? ""));
        if (names.has(part)) ordered.push(part);
      }
      if (ordered.length > 0) return ordered;
    } catch {
      /* 关系链坏了就落到按编号排序 —— 有页总比没页好。 */
    }
  }
  const numbered: Array<[number, string]> = [];
  for (const name of names) {
    const match = SLIDE_RE.exec(name);
    if (match) numbered.push([Number(match[1]), name]);
  }
  return numbered.sort((a, b) => a[0] - b[0]).map(([, name]) => name);
}

function notesText(root: XElement): string {
  const skip = new Set(["sldImg", "sldNum", "hdr", "ftr", "dt"]);
  const texts: string[] = [];
  for (const shape of descendants(root, "sp")) {
    const placeholder = firstDescendant(shape, "ph");
    const placeholderType = placeholder !== null ? (placeholder.attrib["type"] ?? "") : "";
    if (skip.has(placeholderType)) continue;
    const text = cleanText(descendants(shape, "t").map((node) => itertext(node)).join("\n"));
    if (text) texts.push(text);
  }
  return cleanText(texts.join("\n"));
}

function shapeIdentity(shape: XElement, fallback: number): [string, string] {
  const cNvPr = firstDescendant(shape, "cNvPr");
  if (cNvPr === null) return [String(fallback), `shape-${fallback}`];
  return [
    cNvPr.attrib["id"] ?? String(fallback),
    cNvPr.attrib["name"] ?? `shape-${fallback}`,
  ];
}

function shapeBbox(shape: XElement): number[] {
  const xfrm = firstDescendant(shape, "xfrm");
  if (xfrm === null) return [0, 0, 0, 0];
  const off = childrenNamed(xfrm, "off")[0];
  const ext = childrenNamed(xfrm, "ext")[0];
  return [
    attrInt(off, "x"), attrInt(off, "y"), attrInt(ext, "cx"), attrInt(ext, "cy"),
  ];
}

/** 属性缺失时 Python 拿到的是 `int(0)`；存在但畸形时 `int(str)` **抛**。
 *  抛是对的 —— 一个读错的坐标会把证据指到页面上不存在的位置。 */
function attrInt(element: XElement | undefined, key: string): number {
  const raw = element?.attrib[key];
  return raw === undefined ? 0 : pyInt(raw);
}

/** == `_clean_text`：逐行压空白、丢空行、再首尾裁剪。 */
function cleanText(value: string | null | undefined): string {
  const lines = pySplitlines(value || "").map((line) => pyNormalizeSpaces(line));
  return pyStrip(lines.filter((line) => line).join("\n"));
}

// ── posixpath 的三个函数。Node 的 path.posix 在 normalize 上与 Python 不同
//    （对 "" 给 "."、对尾部斜杠的处理也不一样），所以照 CPython 抄。
function posixSplit(path: string): [string, string] {
  const at = path.lastIndexOf("/") + 1;
  const head = path.slice(0, at);
  const tail = path.slice(at);
  return [head && [...head].some((c) => c !== "/") ? head.replace(/\/+$/, "") : head, tail];
}

function posixJoin(...parts: string[]): string {
  let out = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    if (part.startsWith("/")) out = part;
    else if (out === "" || out.endsWith("/")) out += part;
    else out += "/" + part;
  }
  return out;
}

function posixNormpath(path: string): string {
  if (path === "") return ".";
  let initialSlashes = path.startsWith("/") ? 1 : 0;
  if (initialSlashes && path.startsWith("//") && !path.startsWith("///")) initialSlashes = 2;
  const comps: string[] = [];
  for (const comp of path.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp !== ".." || (!initialSlashes && comps.length === 0)
      || (comps.length > 0 && comps[comps.length - 1] === "..")) {
      comps.push(comp);
    } else if (comps.length > 0) {
      comps.pop();
    }
  }
  const joined = "/".repeat(initialSlashes) + comps.join("/");
  return joined || ".";
}
