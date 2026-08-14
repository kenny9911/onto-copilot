/**
 * presentation / bpmn / vision 的 golden 校验。
 *
 * 期望值**全部**来自 `golden/parse.doc.json`（由 `tools/golden/parse_doc.py` 从
 * Python 原件真跑出来）。这里不写一个手算的 render 文案、不写一条手抄的 locator ——
 * 手抄的是我对 Python 的猜测，golden 是它的事实。
 *
 * 输入也来自 golden：三份 `.pptx` 是真的 zip（TS 侧连 zip 读取一起验），BPMN 是
 * 原文 XML，视觉件是一张真 PNG。
 *
 * ── 三处**故意**不逐字比的地方，各自钉住分叉的确切形状 ──────────────
 *
 * 1. `pptx.notzip` / `bpmn.malformed` 的 **message 与 line/column**：错误文案出自
 *    zlib / expat / 本仓自写扫描器，跨引擎不可能一致。比 kind / severity / locator
 *    的骨架，外加"位置确实是数字"。
 * 2. `PptxParser.parse` 插的那条 `parser_fallback`：TS 侧永远走 OOXML 路径，
 *    所以这条 finding 恒定出现（Python 只在缺 python-pptx 时出现，而本仓的 .venv
 *    正好缺）。golden 里的 `python_pptx_available` 记录了导出时的环境。
 * 3. vision 的进度文案里那个秒数：每次都不一样，golden 里已抹成 `<秒>`。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { docStats } from "../src/onto/parse/base.js";
import type { Chunk, Finding, ParsedDoc } from "../src/onto/parse/base.js";
import { BpmnParser } from "../src/onto/parse/bpmn.js";
import { pyFloat, pySplitlines, pySplitWhitespace } from "../src/onto/parse/doc/pycompat.js";
import { fromString, itertext, localName, namespaceOf } from "../src/onto/parse/doc/xmlet.js";
import { PptxParser, parseOoxml } from "../src/onto/parse/presentation.js";
import type { VisionCompletion, VisionGateway } from "../src/onto/parse/vision.js";
import {
  NoCapableModel,
  PDF_ZOOM,
  VisionParser,
  VisionTimeout,
  normalizeBbox,
  renderPages,
} from "../src/onto/parse/vision.js";

const GOLDEN = join(import.meta.dirname, "..", "..", "golden");

interface GoldenDoc {
  file_id: string;
  file_name: string;
  kind: string;
  meta: Record<string, unknown>;
  structured: Record<string, unknown>;
  findings: Array<{
    kind: string;
    message: string;
    locator: Record<string, unknown>;
    severity: string;
  }>;
  chunks: Array<Record<string, unknown>>;
  stats: Record<string, unknown>;
}

interface GoldenFile {
  python_pptx_available: boolean;
  pptx: Record<string, { file: string; ooxml: GoldenDoc; parse: GoldenDoc }>;
  bpmn: Record<string, {
    file: string; xml: string; accepts: boolean; doc: GoldenDoc;
  }>;
  vision: Record<string, GoldenDoc & {
    progress: string[];
    gateway_calls: Array<Record<string, unknown>>;
  }>;
  bbox: Array<{ raw: unknown; out: number[] }>;
  accepts: { pptx: Record<string, boolean>; bpmn: Record<string, boolean> };
}

const golden = JSON.parse(
  readFileSync(join(GOLDEN, "parse.doc.json"), "utf8"),
) as GoldenFile;

/** ParsedDoc → 与 golden 完全同形的纯 JSON。 */
function shape(doc: ParsedDoc): Omit<GoldenDoc, "stats"> & { stats: Record<string, unknown> } {
  return {
    file_id: doc.file_id,
    file_name: doc.file_name,
    kind: doc.kind,
    meta: doc.meta,
    structured: doc.structured,
    findings: doc.findings.map((f: Finding) => ({
      kind: f.kind, message: f.message,
      locator: f.locator as Record<string, unknown>, severity: f.severity,
    })),
    chunks: doc.chunks.map((c: Chunk) => ({
      chunk_id: c.chunk_id, file_id: c.file_id, file_name: c.file_name,
      locator: c.locator, render: c.render, raw: c.raw,
      order: c.order, tags: c.tags, context: c.context,
    })),
    stats: docStats(doc),
  };
}

/** JSON 往返一次：把 `undefined` 字段、Map、类实例统统压成 golden 那种纯数据形态，
 *  免得 toEqual 在"结构相同但表示不同"上给出假绿。 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ══════════════════════════════════════════════════════════════════
//  xmlet：ElementTree 语义的地基（错了上面全错，所以先单独钉住）
// ══════════════════════════════════════════════════════════════════
describe("xmlet", () => {
  it("把前缀展开成 ET 的 {uri}local 形态，并吃掉 xmlns 属性", () => {
    const root = fromString(
      '<p:sld xmlns:p="urn:p" xmlns:r="urn:r" id="1" r:id="rId7"><p:x/></p:sld>');
    expect(root.tag).toBe("{urn:p}sld");
    expect(localName(root.tag)).toBe("sld");
    expect(namespaceOf(root.tag)).toBe("urn:p");
    // 无前缀属性**不带命名空间**（ET 的规则），有前缀的才展开。
    expect(Object.keys(root.attrib)).toEqual(["id", "{urn:r}id"]);
    expect(root.children[0]?.tag).toBe("{urn:p}x");
  });

  it("默认命名空间只作用在元素上，不作用在属性上", () => {
    const root = fromString('<definitions xmlns="urn:b" id="d0"><process id="p"/></definitions>');
    expect(root.tag).toBe("{urn:b}definitions");
    expect(root.attrib["id"]).toBe("d0");
    expect(root.children[0]?.tag).toBe("{urn:b}process");
  });

  it("text / tail 与 TreeBuilder 一致（混合内容才看得出来）", () => {
    const root = fromString("<a>x<b>y</b>z<c/>w</a>");
    expect(root.text).toBe("x");
    expect(root.children[0]?.text).toBe("y");
    expect(root.children[0]?.tail).toBe("z");
    expect(root.children[1]?.tail).toBe("w");
    // itertext 含子树的 text 和子元素的 tail，但**不含自己的 tail**。
    expect(itertext(root)).toBe("xyzw");
    expect(itertext(root.children[0] as never)).toBe("y");
  });

  it("实体、字符引用、CDATA、注释都并进同一段文本", () => {
    const root = fromString("<a>1 &lt;2&gt; &#65;<!--注释--><![CDATA[&raw]]>&#x42;</a>");
    expect(root.text).toBe("1 <2> A&rawB");
  });

  it("未知实体直接抛 —— 静默丢掉等于静默丢材料", () => {
    expect(() => fromString("<a>&secret;</a>")).toThrow(/undefined entity/);
  });

  it("标签不匹配抛出带行列的 ParseError", () => {
    let position: readonly [number, number] | undefined;
    try {
      fromString("<a>\n<b></a>");
    } catch (e) {
      position = (e as { position: readonly [number, number] }).position;
    }
    expect(position?.[0]).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
//  pycompat：与 Python 不等价的那几个原语
// ══════════════════════════════════════════════════════════════════
describe("pycompat", () => {
  it("split() 认 \\x1c–\\x1f、不认 U+FEFF —— 与 JS 的 \\s 正好互补", () => {
    expect(pySplitWhitespace("a\x1fb")).toEqual(["a", "b"]);
    expect(pySplitWhitespace("a﻿b")).toEqual(["a﻿b"]);
    expect(pySplitWhitespace("  a \t b  ")).toEqual(["a", "b"]);
  });

  it("splitlines() 的断行集比 \\n 大，且 \\x1f 不在其中", () => {
    expect(pySplitlines("l1\x1cl2")).toEqual(["l1", "l2"]);
    expect(pySplitlines("l1\x85l2")).toEqual(["l1", "l2"]);
    expect(pySplitlines("a\x1fb")).toEqual(["a\x1fb"]);
    expect(pySplitlines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(pySplitlines("")).toEqual([]);
    expect(pySplitlines("\n")).toEqual([""]);
  });

  it("float() 在空串/None 上抛，在 inf/nan 上不抛 —— Number() 三条都不同", () => {
    expect(() => pyFloat("")).toThrow();
    expect(() => pyFloat(null)).toThrow();
    expect(() => pyFloat("abc")).toThrow();
    expect(pyFloat("inf")).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(pyFloat("nan"))).toBe(true);
    expect(pyFloat(" 0.25 ")).toBe(0.25);
    expect(pyFloat(true)).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  PPTX
// ══════════════════════════════════════════════════════════════════
describe("PptxParser", () => {
  it("扩展名派发与 Python 一致（.ppt 不抢、大写照收）", () => {
    for (const [ext, expected] of Object.entries(golden.accepts.pptx)) {
      expect(new PptxParser().accepts(`x${ext}`)).toBe(expected);
    }
  });

  const fullEquality = ["minimal", "reordered", "noslides", "notes_by_number"] as const;
  for (const name of fullEquality) {
    it(`${name}：OOXML 路径与 Python 逐字段相等`, async () => {
      const entry = golden.pptx[name];
      if (entry === undefined) throw new Error(`golden 缺 pptx.${name}`);
      const doc = await parseOoxml(join(GOLDEN, entry.file), `f-pptx-${name}`);
      expect(plain(shape(doc))).toEqual(entry.ooxml);
    });
  }

  it("页码跟 p:sldIdLst 的关系顺序，不是 slideN.xml 的 N", async () => {
    // 这条单拎出来：上面的整体相等一旦哪天被人"顺手放宽"，这里还会红。
    const doc = await parseOoxml(
      join(GOLDEN, "parse.pptx.reordered.pptx"), "f-pptx-reordered");
    const business = doc.chunks.find((c) => c.render.includes("业务第一页"));
    const physical = doc.chunks.find((c) => c.render.includes("物理 part 一"));
    expect(business?.locator["page"]).toBe(1);
    expect(physical?.locator["page"]).toBe(2);
  });

  it("parse() 在 OOXML 结果前插一条 parser_fallback（TS 侧恒定走这条路）", async () => {
    expect(golden.python_pptx_available).toBe(false);
    const entry = golden.pptx["minimal"];
    if (entry === undefined) throw new Error("golden 缺 pptx.minimal");
    const doc = await new PptxParser().parse(
      join(GOLDEN, entry.file), { fileId: "f-pptx-minimal" });
    expect(plain(shape(doc))).toEqual(entry.parse);
  });

  it("不是 zip 时只发一条 parse_failed —— 消息文案跨引擎不比", async () => {
    const entry = golden.pptx["notzip"];
    if (entry === undefined) throw new Error("golden 缺 pptx.notzip");
    const doc = await parseOoxml(join(GOLDEN, entry.file), "f-pptx-notzip");
    expect(doc.chunks).toEqual([]);
    expect(doc.findings.map((f) => [f.kind, f.severity, f.locator])).toEqual(
      entry.ooxml.findings.map((f) => [f.kind, f.severity, f.locator]));
    // BadZipFile 的文案在本仓的 ziplite 里是照抄 CPython 的，所以这一条能比。
    expect(doc.findings[0]?.message).toBe(entry.ooxml.findings[0]?.message);
  });
});

// ══════════════════════════════════════════════════════════════════
//  BPMN
// ══════════════════════════════════════════════════════════════════
describe("BpmnParser", () => {
  it("只认 .bpmn 与复合后缀 .bpmn20.xml，不抢普通 .xml", () => {
    for (const [name, expected] of Object.entries(golden.accepts.bpmn)) {
      expect(new BpmnParser().accepts(name)).toBe(expected);
    }
  });

  const cases = Object.keys(golden.bpmn).filter((name) => name !== "malformed");
  for (const name of cases) {
    it(`${name}：与 Python 逐字段相等`, async () => {
      const entry = golden.bpmn[name];
      if (entry === undefined) throw new Error(`golden 缺 bpmn.${name}`);
      const path = join(import.meta.dirname, "..", "..", "golden", entry.file);
      const doc = await parseFromXml(entry.xml, path, `f-bpmn-${name}`);
      expect(plain(shape(doc))).toEqual(entry.doc);
    });
  }

  it("语法错误只发 parse_failed；行列号是本仓扫描器的基准，与 expat 不同", async () => {
    const entry = golden.bpmn["malformed"];
    if (entry === undefined) throw new Error("golden 缺 bpmn.malformed");
    const doc = await parseFromXml(
      entry.xml, join(GOLDEN, entry.file), "f-bpmn-malformed");
    expect(doc.chunks).toEqual([]);
    expect(doc.structured).toEqual({});
    const finding = doc.findings[0];
    const expected = entry.doc.findings[0];
    expect([finding?.kind, finding?.severity]).toEqual([expected?.kind, expected?.severity]);
    expect(finding?.locator["kind"]).toBe("xml");
    expect(finding?.locator["pointer"]).toBe("/");
    expect(typeof finding?.locator["line"]).toBe("number");
    expect(typeof finding?.locator["column"]).toBe("number");
  });

  it("边的方向与网关类型一个都不能错 —— 画出来的流程全靠它们", async () => {
    const entry = golden.bpmn["order"];
    if (entry === undefined) throw new Error("golden 缺 bpmn.order");
    const doc = await parseFromXml(entry.xml, join(GOLDEN, entry.file), "f-bpmn-order");
    const flows = (doc.structured["sequenceFlows"] ?? []) as Array<Record<string, unknown>>;
    expect(flows.map((f) => [f["id"], f["sourceRef"], f["targetRef"]])).toEqual([
      ["f1", "start", "check-credit"],
      ["f2", "check-credit", "credit-ok"],
      ["f3", "credit-ok", "ship"],
      ["f4", "credit-ok", "done"],
    ]);
    const nodes = (doc.structured["nodes"] ?? []) as Array<Record<string, unknown>>;
    expect(nodes.find((n) => n["id"] === "credit-ok")?.["type"]).toBe("exclusiveGateway");
    // 带条件的边要打 rule 标签：那是"什么时候走这条分支"的规则来源。
    const conditional = doc.chunks.find((c) => c.render.includes("条件="));
    expect(conditional?.tags).toContain("rule");
  });

  it("指不到节点的 ref 发 finding，而不是把边悄悄丢掉", async () => {
    const entry = golden.bpmn["dangling"];
    if (entry === undefined) throw new Error("golden 缺 bpmn.dangling");
    const doc = await parseFromXml(entry.xml, join(GOLDEN, entry.file), "f-bpmn-dangling");
    const finding = doc.findings.find((f) => f.kind === "dangling_reference");
    expect(finding?.message).toContain("targetRef='missing'");
    const flows = (doc.structured["sequenceFlows"] ?? []) as unknown[];
    expect(flows).toHaveLength(1);
  });
});

/** BPMN 的输入在 golden JSON 里是文本，落到临时文件再走真的 `parse(path)`。 */
async function parseFromXml(
  xml: string, hint: string, fileId: string,
): Promise<ParsedDoc> {
  const dir = await mkdtemp(join(tmpdir(), "ontoparse-"));
  const path = join(dir, hint.slice(hint.lastIndexOf("/") + 1));
  try {
    await writeFile(path, xml, "utf8");
    return await new BpmnParser().parse(path, { fileId });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════
//  Vision
// ══════════════════════════════════════════════════════════════════
class ScriptedGateway implements VisionGateway {
  readonly seen: Array<Record<string, unknown>> = [];

  constructor(private readonly script: readonly unknown[]) {}

  async call(nodeId: string, prompt: string, opts: {
    needs: readonly string[]; preferModels: readonly string[]; prefer: string;
    system: string; schema: unknown; maxTokens: number;
    images: readonly string[]; key: string;
  }): Promise<VisionCompletion> {
    this.seen.push({
      node_id: nodeId, prompt,
      needs: [...opts.needs].sort(), prefer: opts.prefer,
      prefer_models: [...opts.preferModels], max_tokens: opts.maxTokens,
      key: opts.key, images: opts.images.length,
    });
    const item = this.script[Math.min(this.seen.length - 1, this.script.length - 1)];
    if (item instanceof Error) throw item;
    return { data: item };
  }
}

const PNG = join(GOLDEN, "parse.vision.page.png");

/** golden 里 `第 N 页识别完成（X 秒）` 的秒数已抹成 `<秒>`，这里做同样的抹除。 */
function maskSeconds(note: string): string {
  const at = note.indexOf("（");
  const close = note.indexOf("）");
  return note.includes("秒）") && at >= 0 && close >= 0
    ? `${note.slice(0, at)}（<秒>）${note.slice(close + 1)}`
    : note;
}

async function runVision(
  name: string,
  gateway: VisionGateway | null,
  opts: { maxPages?: number } = {},
): Promise<void> {
  const entry = golden.vision[name];
  if (entry === undefined) throw new Error(`golden 缺 vision.${name}`);
  const notes: string[] = [];
  const parser = new VisionParser(gateway, {
    ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
    onProgress: (m) => notes.push(m),
  });
  const doc = await parser.parse(PNG, { fileId: "f-vision" });

  const { progress, gateway_calls, ...expected } = entry;
  expect(plain(shape(doc))).toEqual(expected);
  expect(notes.map(maskSeconds)).toEqual(progress);
  if (gateway instanceof ScriptedGateway) {
    expect(plain(gateway.seen)).toEqual(gateway_calls);
  }
}

describe("VisionParser", () => {
  const okPage = golden.vision["ok"];

  it("没有网关时只登记、不识别 —— 那是「还没到时候」，不是「配置坏了」", async () => {
    await runVision("no_gateway", null);
  });

  it("识别成功：文本块 / 表格行 / 连线三类切片与 Python 逐字段相等", async () => {
    await runVision("ok", new ScriptedGateway([ocrPayload()]));
    expect(okPage).toBeDefined();
  });

  it("模型什么都没读出来时明说 empty_ocr", async () => {
    await runVision("empty", new ScriptedGateway([{}]));
  });

  it("comp.data 为 None 时按空页处理，不抛", async () => {
    await runVision("none_data", new ScriptedGateway([null]));
  });

  it("页数正好等于上限时也报 page_limit（Python 的判据就是相等）", async () => {
    await runVision("page_limit", new ScriptedGateway([ocrPayload()]), { maxPages: 1 });
  });

  it("网关没有视觉模型：登记 vision_failed 并停在这一页", async () => {
    await runVision("lookup_error", new ScriptedGateway([new NoCapableModel("no vision")]));
  });

  it("超时：区分成「视觉识别超时」而不是笼统的失败", async () => {
    await runVision("timeout", new ScriptedGateway([new VisionTimeout()]));
  });

  it("其它异常：消息里带类名，便于按名字排查", async () => {
    // Python 那边抛的是 `ValueError`，消息里的类名来自 `type(exc).__name__`；
    // TS 侧的对等物是构造函数名，所以用一个同名的类把这条钉死。
    class ValueError extends Error {}
    await runVision("other_error", new ScriptedGateway([new ValueError("boom")]));
  });

  it("bbox 归一化逐例与 Python 相等（含 NaN —— JS 的 min/max 在这里是反的）", () => {
    for (const { raw, out } of golden.bbox) {
      expect(normalizeBbox(raw)).toEqual(out);
    }
  });
});

describe("renderPages", () => {
  it("PDF 按 PDF_ZOOM 逐页渲染成 PNG（栅格化在本进程内，见 onto/render.ts）", async () => {
    const calls: Array<{ bytes: number; opts: unknown }> = [];
    const renderPdf = (pdf: Uint8Array, opts: { maxPages?: number; zoom?: number }) => {
      calls.push({ bytes: pdf.byteLength, opts });
      return Promise.resolve({ pages: ["QUJD", "REVG"], truncated: true });
    };

    const dir = await mkdtemp(join(tmpdir(), "ontoparse-pdf-"));
    try {
      const path = join(dir, "scan.pdf");
      await writeFile(path, Buffer.from("%PDF-1.4 fake"));
      const pages = await renderPages(path, { maxPages: 3, renderPdf });
      expect(pages).toEqual([
        "data:image/png;base64,QUJD", "data:image/png;base64,REVG",
      ]);
      expect(calls).toEqual([{ bytes: 13, opts: { maxPages: 3, zoom: PDF_ZOOM } }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("图片不进渲染器，且 media type 按真实扩展名给（TS 侧不重编码成 PNG）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ontoparse-img-"));
    try {
      const jpg = join(dir, "台账.jpg");
      await writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]));
      // Python 那边 PIL 一律重编码成 PNG，所以写死 image/png 是对的；这边没有
      // 重编码，照抄 image/png 就等于给一张 jpg 贴 png 的标签送进模型。
      expect(await renderPages(jpg)).toEqual(["data:image/jpeg;base64,/9j/"]);
      expect(await renderPages(PNG)).toHaveLength(1);
      expect((await renderPages(PNG))[0]?.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** golden 的 `ok` 用例喂给桩网关的那一页。与 `tools/golden/parse_doc.py` 的
 *  `OCR_PAGE` 逐字相同 —— 输入抄错的话，是在拿错的输入比对的输出。 */
function ocrPayload(): Record<string, unknown> {
  return {
    blocks: [
      { text: "客户主数据", kind: "title", bbox: [0.1, 0.05, 0.9, 0.12] },
      { text: "  ", kind: "note", bbox: [0, 0, 1, 1] },
      { text: "客户号", kind: "field", bbox: ["0.2", 0.3, 2.0, -0.5] },
      { text: "每个客户至多一个主账户", kind: "paragraph" },
    ],
    tables: [
      {
        caption: "字段表",
        rows: [["字段", "类型", "说明"], ["cust_no", "string", "主键"],
          ["name", "string", ""]],
        bbox: [0.1, 0.4, 0.9, 0.8],
      },
      { caption: "只有表头", rows: [["A", "B"]], bbox: [0, 0, 1, 1] },
      { caption: "空表", rows: [], bbox: null },
    ],
    relations: [
      { from_entity: "客户", to_entity: "账户", label: "1:N" },
      { from_entity: "账户", to_entity: "流水" },
    ],
  };
}
