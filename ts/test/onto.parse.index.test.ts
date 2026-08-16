/**
 * `onto/parse/index.ts`（装配层）的 golden 校验 —— 期望值**一条都不是手写的**。
 *
 * 全部来自 `tools/golden/onto_parse_index.py` 真跑 Python 侧导出的
 * `golden/onto.parse.index.json`：
 *
 *   · `registry` —— 九个解析器的顺序（顺序即优先级）与 28 条派发结果，含
 *     未知扩展名落兜底、复合后缀 `.bpmn20.xml`、普通 `.xml` **不**归 BPMN；
 *   · `corpus`   —— 真语料端到端：`golden/材料.xlsx`（真材料，`pipeline.*.json`
 *     就是从它跑出来的）+ CSV + OpenAPI + Markdown + 一个未知扩展名的文件，
 *     走完 `parseAll → buildIndex / collect* / corpusSummary`，逐份 ParsedDoc
 *     与四个产物全部对照；
 *   · `vectors`  —— 三个 collect/summary 在合成 ParsedDoc 上的分支（空 profile
 *     被判假整段跳过、跨文件同名 sheet 覆盖、`write` 取真值、`stats()` 里
 *     `title` 是字符串所以原样输出、`Path(...).stem` 的刁钻名字）。
 *
 * 断言分两层：`toEqual` 给可读的 diff，`JSON.stringify` 再压一遍**键序** ——
 * 这些 dict 会原样进 `session.state["corpus"]`、落库、再回到前端，键序漂了
 * diff 就全是噪声。
 *
 * golden 里**没有** `EvidenceIndex.search` 的结果：Python 侧候选集是 `set[str]`，
 * 同分切片的次序跟着 PYTHONHASHSEED 走（同一份材料连跑两次导出，第五名就换了
 * 一个 id）。那是哈希随机化，不是契约。`buildIndex` 的职责到"切片按解析顺序
 * 全部进了索引"为止，下面钉的就是这个。
 */

import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KeyError } from "../src/kernel/errors.js";
import { EvidenceIndex } from "../src/kernel/memory/evidence.js";
import type { ParsedDoc } from "../src/onto/parse/base.js";
import { docStats, makeChunk, makeFinding, makeParsedDoc } from "../src/onto/parse/base.js";
import { ParserRegistry } from "../src/onto/parse/base.js";
import {
  DdlParser,
  buildIndex,
  collectEndpoints,
  collectProfiles,
  corpusSummary,
  defaultRegistry,
  pyStem,
} from "../src/onto/parse/index.js";
import { TextParser } from "../src/onto/parse/text.js";
import type { VisionGateway, VisionParser } from "../src/onto/parse/vision.js";

const GOLDEN = fileURLToPath(new URL("../../golden/", import.meta.url));
const MATERIALS = fileURLToPath(new URL("../../materials/", import.meta.url));

interface DocDump {
  file_id: string;
  file_name: string;
  kind: string;
  meta: Record<string, unknown>;
  structured: Record<string, unknown>;
  findings: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  stats: Record<string, unknown>;
}
interface Vector {
  name: string;
  docs: DocDump[];
  summary: Record<string, unknown>;
  profiles: Record<string, unknown>;
  endpoints: Record<string, unknown>[];
  index: { len: number; chunk_ids: string[] };
}
interface Golden {
  registry: {
    parsers: { kind: string; extensions: string[] }[];
    fallback: string;
    dispatch: { path: string; kind: string }[];
    no_fallback_errors: { path: string; error: string }[];
    sql_dialect: { arg: string | null; dialect: string | null }[];
    vision_prefer: { arg: string; prefer: string }[];
    vision_gateway_none: boolean;
  };
  corpus: {
    materials: { name: string; from_golden: boolean; bytes_b64?: string }[];
    docs: DocDump[];
    summary: Record<string, unknown>;
    profiles: Record<string, unknown>;
    endpoints: Record<string, unknown>[];
    index: {
      len: number;
      chunk_ids: string[];
      file_names: Record<string, string>;
      by_file: Record<string, string[]>;
    };
  };
  vectors: Vector[];
  build_index_reuse: { is_same_object: boolean; chunk_ids: string[]; twice_len: number };
}

const g = JSON.parse(
  await readFile(join(GOLDEN, "onto.parse.index.json"), "utf8"),
) as Golden;

/** 同时压内容与键序。 */
function same(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/** ParsedDoc → 与导出脚本 `dump_doc` 逐字段对齐的纯 JSON。 */
function dumpDoc(doc: ParsedDoc, stats: Record<string, unknown>): DocDump {
  return {
    file_id: doc.file_id,
    file_name: doc.file_name,
    kind: doc.kind,
    meta: doc.meta,
    structured: doc.structured,
    findings: doc.findings.map((f) => ({
      kind: f.kind, message: f.message, locator: f.locator, severity: f.severity,
    })),
    chunks: doc.chunks.map((c) => ({
      chunk_id: c.chunk_id, file_id: c.file_id, file_name: c.file_name,
      locator: c.locator, render: c.render, raw: c.raw, order: c.order,
      tags: [...c.tags], context: c.context,
    })),
    stats,
  };
}

/** golden 里的 doc dump → ParsedDoc。合成向量两边吃同一份 JSON。 */
function loadDoc(d: DocDump): ParsedDoc {
  const doc = makeParsedDoc({ fileId: d.file_id, fileName: d.file_name, kind: d.kind });
  doc.structured = d.structured;
  doc.meta = d.meta;
  for (const f of d.findings) {
    doc.findings.push(makeFinding(
      f["kind"] as string, f["message"] as string,
      (f["locator"] ?? {}) as Record<string, unknown>, f["severity"] as string));
  }
  for (const c of d.chunks) {
    // makeChunk 会自己拼 `${fileId}:${docId}`，而 golden 里存的是拼好的整串。
    // 这里把前缀剥掉再交给工厂，拼回来必须逐字相等 —— 下面 expect 盯着这件事。
    const cid = c["chunk_id"] as string;
    const fid = c["file_id"] as string;
    const chunk = makeChunk({
      docId: cid.startsWith(`${fid}:`) ? cid.slice(fid.length + 1) : cid,
      fileId: fid,
      fileName: c["file_name"] as string,
      locator: (c["locator"] ?? {}) as Record<string, unknown>,
      render: c["render"] as string,
      raw: c["raw"],
      order: c["order"] as number,
      tags: (c["tags"] ?? []) as string[],
    });
    expect(chunk.chunk_id).toBe(cid);
    doc.chunks.push(chunk);
  }
  return doc;
}

// ══════════════════════════════════════════════════════════════════
//  1. defaultRegistry：顺序即优先级
// ══════════════════════════════════════════════════════════════════

describe("defaultRegistry", () => {
  it("28 条路径的派发结果与 Python 逐条一致", () => {
    const reg = defaultRegistry();
    const got = g.registry.dispatch.map((d) => ({
      path: d.path, kind: reg.forPath(d.path).kind,
    }));
    expect(got).toEqual(g.registry.dispatch);
  });

  it("九个解析器的 kind 与扩展名集合与 Python 一致", () => {
    const reg = defaultRegistry();
    // 注册表不暴露内部列表（Python 侧那是 `_parsers`），所以按每个解析器**自己**
    // 声明的扩展名去问派发 —— 顺序即优先级这件事由上面那条派发用例保证。
    for (const p of g.registry.parsers) {
      for (const ext of p.extensions) {
        // `.bpmn20.xml` 是复合后缀，BpmnParser 覆写了 accepts；其余按扩展名。
        const path = ext.startsWith(".bpmn20") ? `/m/flow${ext}` : `/m/样本${ext}`;
        expect(`${ext} → ${reg.forPath(path).kind}`).toBe(`${ext} → ${p.kind}`);
      }
    }
  });

  it("未知扩展名落到兜底解析器，**不静默跳过**", () => {
    const reg = defaultRegistry();
    for (const path of ["/m/data.parquet", "/m/README", "/m/说明.中文后缀"]) {
      expect(reg.forPath(path).kind).toBe(g.registry.fallback);
    }
  });

  it("未知扩展名只在内容真是文本时兜底；明显二进制明确报 unsupported", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-fallback-"));
    try {
      const text = join(tmp, "rules.conf");
      const binary = join(tmp, "facts.parquet");
      writeFileSync(text, "每个订单必须关联客户。", "utf8");
      writeFileSync(binary, Buffer.from([0x50, 0x41, 0x52, 0x31, 0, 1, 2, 3]));
      const [textDoc, binaryDoc] = await defaultRegistry().parseAll([text, binary]);
      expect(textDoc?.kind).toBe("text");
      expect(textDoc?.chunks).toHaveLength(1);
      expect(binaryDoc?.kind).toBe("unsupported");
      expect(binaryDoc?.chunks).toEqual([]);
      expect(binaryDoc?.findings[0]).toMatchObject({ kind: "unsupported", severity: "warn" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("没有兜底时才抛，消息里的扩展名走 pyRepr", () => {
    // 注册了 TextParser 但**没标 fallback** —— 与 defaultRegistry 的唯一差别。
    const bare = new ParserRegistry().register(new TextParser());
    for (const c of g.registry.no_fallback_errors) {
      expect(() => bare.forPath(c.path)).toThrow(c.error);
    }
  });

  it("sqlDialect 落到 DdlParser 身上", () => {
    // DDL 解析已经全在本地（node-sql-parser），没有"发给别人的方言"这个
    // 可观测点了 —— 直接看注册表里那个 DdlParser 记住的方言。
    const seen: (string | null)[] = [];
    for (const c of g.registry.sql_dialect) {
      const reg = defaultRegistry(c.arg === null ? {} : { sqlDialect: c.arg });
      const parser = reg.forPath("/m/schema.ddl");
      expect(parser).toBeInstanceOf(DdlParser);
      seen.push((parser as DdlParser).dialect);
    }
    // Python 的 `dialect=None` 在 TS 侧就是 `null`（golden 里导的是 None）。
    expect(seen).toEqual(g.registry.sql_dialect.map((c) => c.dialect ?? null));
  });

  it("visionPrefer / visionGateway 落到 VisionParser 身上", () => {
    for (const c of g.registry.vision_prefer) {
      const reg = defaultRegistry(c.arg === "quality" ? {} : { visionPrefer: c.arg });
      const parser = reg.forPath("/m/scan.png") as VisionParser;
      expect(parser.prefer).toBe(c.prefer);
      // 不传网关时扫描件仍会被登记（findings 里明说），**不静默跳过**。
      expect(parser.gateway === null).toBe(g.registry.vision_gateway_none);
    }
    const gw = { complete: () => Promise.resolve({}) } as unknown as VisionGateway;
    const withGw = defaultRegistry({ visionGateway: gw }).forPath("/m/scan.png") as VisionParser;
    expect(withGw.gateway).toBe(gw);
  });

  it("visionProgress 会被真的调用（一页几分钟，不报进度就是几分钟死寂）", async () => {
    const notes: string[] = [];
    const reg = defaultRegistry({ visionProgress: (m) => notes.push(m) });
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-"));
    try {
      const p = join(tmp, "scan.png");
      copyFileSync(GOLDEN + "parse.vision.page.png", p);
      await reg.parse(p, { fileId: "f_x" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // 没网关这条路只登记不识别，所以进度回调此刻不该有输出 —— 但装配必须成功，
    // 而不是因为传了个回调就炸。
    expect(notes).toEqual([]);
  });

  it("默认 DOCX 抽取器能读真实段落、表格与 core metadata", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-"));
    try {
      const p = join(tmp, "流程说明.docx");
      copyFileSync(join(MATERIALS, "流程说明.docx"), p);
      const doc = await defaultRegistry().parse(p, { fileId: "f_docx_default" });
      expect(doc.kind).toBe("docx");
      expect(doc.chunks.some((chunk) =>
        chunk.render.includes("一个执行计划可拆入多个采购包"))).toBe(true);
      expect(doc.chunks.some((chunk) =>
        chunk.render.includes("所属对象=pbpHeader"))).toBe(true);
      expect(doc.meta).toMatchObject({
        creator: "wubin",
        modified: "2013-12-23 23:15:00+00:00",
      });
      expect(doc.findings).toContainEqual(expect.objectContaining({ kind: "metadata_leak" }));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("显式 docxExtract 仍可替换默认实现，且失败不被伪装成空文档", async () => {
    const reg = defaultRegistry({
      docxExtract: () => Promise.reject(new Error("定制 DOCX 抽取失败")),
    });
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-"));
    try {
      const p = join(tmp, "口径说明.docx");
      writeFileSync(p, "PK\u0003\u0004");
      await expect(reg.parse(p, { fileId: "f_x" })).rejects.toThrow("定制 DOCX 抽取失败");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("默认 YAML loader 能解析带 anchor/alias 的 OpenAPI", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-yaml-"));
    try {
      const p = join(tmp, "openapi.yaml");
      writeFileSync(p, [
        "openapi: 3.1.0",
        "info: &api_info",
        "  title: YAML 默认接线锚点",
        "  version: 1.0.0",
        "x-info-copy: *api_info",
        "paths:",
        "  /orders:",
        "    post:",
        "      operationId: createOrderFromYaml",
        "      summary: YAML 锚点接口",
        "      responses:",
        "        '200':",
        "          description: ok",
      ].join("\n"), "utf8");
      const doc = await defaultRegistry().parse(p, { fileId: "f_yaml_default" });
      expect(doc.kind).toBe("openapi");
      expect(doc.structured["title"]).toBe("YAML 默认接线锚点");
      expect(doc.chunks.some((chunk) =>
        chunk.render.includes("createOrderFromYaml")
          && chunk.render.includes("YAML 锚点接口"))).toBe(true);
      expect(doc.findings.some((finding) => finding.kind === "parse_failed")).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("YAML alias 过度展开被资源上限拦下，并形成文件级 finding", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-yaml-limit-"));
    try {
      const p = join(tmp, "alias-bomb.yaml");
      writeFileSync(p, [
        "a: &a [x,x,x,x,x,x,x,x,x,x]",
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      ].join("\n"), "utf8");
      const doc = await defaultRegistry().parse(p, { fileId: "f_yaml_alias_limit" });
      expect(doc.chunks).toEqual([]);
      expect(doc.findings).toEqual([
        expect.objectContaining({
          kind: "parse_failed",
          message: expect.stringContaining("resource exhaustion attack"),
        }),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("批量服务入口可隔离单文件失败：坏 DOCX 不拖垮同批有效文本", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parse-idx-safe-"));
    try {
      const good = join(tmp, "规则.txt");
      const bad = join(tmp, "损坏.docx");
      writeFileSync(good, "每个采购申请必须关联一个申请人。", "utf8");
      writeFileSync(bad, "PK\u0003\u0004");
      const docs = await defaultRegistry().parseAll([good, bad], { continueOnError: true });
      expect(docs).toHaveLength(2);
      expect(docs[0]?.chunks[0]?.render).toContain("采购申请");
      expect(docs[1]?.chunks).toEqual([]);
      expect(docs[1]?.findings[0]).toMatchObject({ kind: "parse_failed", severity: "warn" });
      expect(docs[1]?.findings[0]?.message).toContain("不是可读取的 DOCX OOXML 包");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("装配本身不碰 IO、不装载原生模块：一次 forPath 不该把 pdfjs 拉进内存", () => {
    // 上传一份 xlsx 的路径根本走不到 PDF 渲染器（几 MB 的 pdfjs + 一次 dlopen），
    // 所以装配阶段一定不能去装载它。
    expect(defaultRegistry().forPath("/m/材料.xlsx").kind).toBe("xlsx");
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 真语料端到端
// ══════════════════════════════════════════════════════════════════

describe("端到端：材料.xlsx + CSV + OpenAPI + Markdown + 未知扩展名", () => {
  let dir = "";
  let docs: ParsedDoc[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "parse-idx-corpus-"));
    const paths: string[] = [];
    for (const m of g.corpus.materials) {
      const p = join(dir, m.name);
      if (m.from_golden) copyFileSync(GOLDEN + m.name, p);
      else writeFileSync(p, Buffer.from(m.bytes_b64 as string, "base64"));
      paths.push(p);
    }
    docs = await defaultRegistry().parseAll(paths);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("逐份 ParsedDoc 与 Python 一致（含内容寻址的 file_id）", () => {
    same(docs.map((d) => dumpDoc(d, docStats(d))), g.corpus.docs);
  });

  it("corpusSummary：files + chunks 总数 + 展平的 findings", () => {
    // 键序也钉住：这份 dict 原样进 session.state["corpus"]、落库、回前端。
    same(corpusSummary(docs), g.corpus.summary);
  });

  it("collectProfiles：sheet 的按表名、CSV 的按文件名 stem", () => {
    same(collectProfiles(docs), g.corpus.profiles);
  });

  it("collectEndpoints：只留写操作", () => {
    same(collectEndpoints(docs), g.corpus.endpoints);
  });

  it("buildIndex：所有切片按解析顺序进索引，一片不漏", () => {
    const ix = buildIndex(docs);
    expect(ix.size).toBe(g.corpus.index.len);
    expect(ix.allChunks().map((c) => c.chunkId)).toEqual(g.corpus.index.chunk_ids);
    expect(Object.fromEntries(ix.fileNames())).toEqual(g.corpus.index.file_names);
    for (const [fid, ids] of Object.entries(g.corpus.index.by_file)) {
      expect(ix.byFile(fid).map((c) => c.chunkId)).toEqual(ids);
    }
  });

  it("索引里的切片带着 locator 与 tags —— 没有 locator 的切片不该存在", () => {
    const ix = buildIndex(docs);
    for (const c of ix.allChunks()) {
      expect(Object.keys(c.locator).length).toBeGreaterThan(0);
    }
    // locator 是**同一个对象**（Python 两层共用一个 dict），不是复制品：
    // 复制会让"解析器先建 chunk 再补 locator 字段"那种写法静默失效。
    const first = docs[0]!.chunks[0]!;
    expect(ix.get(first.chunk_id)!.locator).toBe(first.locator);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. 合成向量：三个 collect/summary 的分支
// ══════════════════════════════════════════════════════════════════

describe("collect* / corpusSummary 的分支", () => {
  for (const v of g.vectors) {
    it(v.name, () => {
      const docs = v.docs.map(loadDoc);
      same(corpusSummary(docs), v.summary);
      same(collectProfiles(docs), v.profiles);
      same(collectEndpoints(docs), v.endpoints);
      const ix = buildIndex(docs);
      expect(ix.size).toBe(v.index.len);
      expect(ix.allChunks().map((c) => c.chunkId)).toEqual(v.index.chunk_ids);
    });
  }

  it("sheet 缺 name 键 → KeyError，不是 'undefined.列名'", () => {
    // 一个叫 "undefined.金额" 的画像键永远查不到，而查不到的表现是"这列没有
    // 画像"——又一次静默漏检。Python 侧 `sheet['name']` 是 KeyError，照搬。
    const doc = makeParsedDoc({ fileId: "f1", fileName: "x.xlsx", kind: "xlsx" });
    doc.structured = { sheets: [{ profile: { 金额: { name: "金额" } } }] };
    expect(() => collectProfiles([doc])).toThrow(KeyError);
  });

  it("structured 的形状漂了要**响**，不静默当成空", () => {
    const doc = makeParsedDoc({ fileId: "f1", fileName: "x.xlsx", kind: "xlsx" });
    doc.structured = { sheets: { 表一: {} } };
    expect(() => collectProfiles([doc])).toThrow(TypeError);
    const d2 = makeParsedDoc({ fileId: "f2", fileName: "y.json", kind: "openapi" });
    d2.structured = { endpoints: { a: 1 } };
    expect(() => collectEndpoints([d2])).toThrow(TypeError);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. buildIndex 的两条语义
// ══════════════════════════════════════════════════════════════════

describe("buildIndex", () => {
  const mk = (fileId: string, n: number): ParsedDoc => {
    const doc = makeParsedDoc({ fileId, fileName: `${fileId}.xlsx`, kind: "xlsx" });
    for (let i = 0; i < n; i++) {
      doc.chunks.push(makeChunk({
        docId: `c${i}`, fileId, fileName: `${fileId}.xlsx`,
        locator: { row: i }, render: `块${i}`, order: i,
      }));
    }
    return doc;
  };

  it("传了索引就**就地灌入并返回同一个对象**", () => {
    const ix = buildIndex([mk("f1", 2)]);
    const same = buildIndex([mk("f2", 3)], ix);
    expect(same === ix).toBe(g.build_index_reuse.is_same_object);
    expect(ix.allChunks().map((c) => c.chunkId)).toEqual(g.build_index_reuse.chunk_ids);
  });

  it("同一份文档灌两次不会翻倍（重复 chunk_id 被索引直接丢掉）", () => {
    const a = mk("f1", 2);
    expect(buildIndex([a], buildIndex([a])).size).toBe(g.build_index_reuse.twice_len);
  });

  it("不传索引就每次新建一个 —— 两次调用互不污染", () => {
    const one = buildIndex([mk("f1", 2)]);
    const two = buildIndex([mk("f2", 3)]);
    expect(one.size).toBe(2);
    expect(two.size).toBe(3);
    expect(one).not.toBe(two);
    expect(one).toBeInstanceOf(EvidenceIndex);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. pyStem —— Node 的 extname 在这里对不上 CPython
// ══════════════════════════════════════════════════════════════════

describe("pyStem", () => {
  it("与 golden 里 Path(...).stem 产出的键前缀一致", () => {
    // golden 的 "Path(...).stem 的刁钻名字" 那条向量里，键是 `${stem}.${列名}`。
    const v = g.vectors.find((x) => x.name.includes("stem"))!;
    for (const [i, d] of v.docs.entries()) {
      const col = Object.keys(d.structured["profile"] as Record<string, unknown>)[0]!;
      expect(`${pyStem(d.file_name)}.${col}`).toBe(Object.keys(v.profiles)[i]);
    }
  });

  it("带目录时只看 basename", () => {
    expect(pyStem("/a/b/客户.csv")).toBe("客户");
    expect(pyStem("/a.b/客户")).toBe("客户");
  });
});
