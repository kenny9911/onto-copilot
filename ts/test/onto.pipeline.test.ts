/**
 * onto/pipeline 的 golden 校验 —— 期望值**一条都不是手写的**。
 *
 * 两批 golden：
 *
 * 1. **端到端**：`golden/材料.xlsx`（主导出器合成的真实业务材料）走完
 *    解析 → 建索引 → `segmentCorpus` → `structuralExtract` → `buildOir`
 *    → `mineQuestions` → `finish`，逐字节比 `golden/pipeline.segments.json`
 *    / `pipeline.oir.json` / `pipeline.template.json` / `pipeline.stats.json`。
 *    这条链路是产品的主干，任何一环漂了都会在 OIR 的 provenance 上显形
 *    （`file_id` 是对文件字节寻址的）。
 *    `pipeline.flow.json` **不比** —— 它来自 `onto/flow_extract`，本轮没有移植。
 *
 * 2. **模块向量**：`tools/golden/onto_pipeline.py` 真跑 Python 侧导出的
 *    `golden/onto.pipeline.json`。覆盖端到端跑不到的那些分支 ——
 *    `_looks_like_prose` / `outstanding` / `_host_names` / `_resolve_host` /
 *    `_prov` / `_preview_names` / `ExtractSegment.task()` 的整段中文长文 /
 *    `CoverageCritic` 的每一条 finding / `build_dag().describe()` /
 *    `build_oir` 的丢弃统计 / `finish()` 的全部键。
 *
 * 断言分两层：`toEqual` 给可读的 diff，`JSON.stringify` 再压一遍**键序** ——
 * OIR 的键序会原样进产物、进 journal，顺序漂了就不是同一份产物。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { makeCriticContext } from "../src/kernel/critic.js";
import { Chunk as EvChunk, EvidenceIndex } from "../src/kernel/memory/evidence.js";
import {
  clarificationSummary,
  questionToDict as clarifyQuestionToDict,
} from "../src/onto/clarify.js";
import { conflictToDict } from "../src/onto/conflict.js";
import { mineQuestions } from "../src/onto/gaps.js";
import { OIR, oirFromDict } from "../src/onto/oir.js";
import { contentFileId } from "../src/onto/parse/base.js";
import type { ParsedDoc } from "../src/onto/parse/base.js";
import { XlsxParser } from "../src/onto/parse/tabular.js";
import {
  ASK,
  CHECKED_YIELDS,
  CoverageCritic,
  ExtractSegment,
  HarvestQuestions,
  MergeSegments,
  MIN_SEGMENT,
  MineRules,
  Segment,
  SEGMENT_CHUNKS,
  SegmentRouter,
  buildDag,
  buildOir,
  finish,
  handlersFor,
  hostNames,
  isDataRow,
  looksLikeProse,
  outstanding,
  previewNames,
  prov,
  provenanceCritic,
  resolveHost,
  segmentCorpus,
  windowShape,
  type AgentSpecLike,
  type ChunkLike,
  type SegmentDoc,
  type SegmentIndex,
} from "../src/onto/pipeline.js";
import { inferShape, structuralExtract, type Yield } from "../src/onto/shape.js";
import type { TemplateSpec } from "../src/onto/template.js";

const GOLDEN = fileURLToPath(new URL("../../golden/", import.meta.url));

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(GOLDEN + name, "utf8"));
}

/** `default_agents().get("extractor")` 的替身。`task()` 一个字都不读它 ——
 * agent 只贡献 `schema` / `system`，所以向量里不需要真的 agents 模块。 */
const STUB_AGENT: AgentSpecLike = { outputSchema: null };

/** 客户材料里真实存在的形状：一列「答复」整列空着等人填。**输入**是可以手写的，
 * 期望值才不行。 */
const SURVEY_ROWS = [...Array(16).keys()].map((i) => ({
  节点: i === 0 ? "（1）编制集采计划" : "",
  编号: String(i + 1),
  澄清问题: [
    "什么情况下使用集采，什么情况下使用普通采购？",
    "集采计划具体包括哪些内容？列出全部字段",
    "集采计划到底是在系统里编的，还是线下用 Excel 编好只把结果录进来？",
    "这项工作什么时候启动？固定周期做，还是看到框架快到期了才做？",
    "编制时主要依据什么具体数据？从哪里获取？",
    "收集是指各单位先上报、再由集采部门汇总吗？",
    "审批需要几级？分别是谁？",
    "驳回之后走什么流程？",
  ][i % 8]!,
  参考选项: ["① 全线下，系统只存结果 ② 系统里编 ③ 线下编、系统里审",
    "① 固定周期 ② 框架到期前 ③ 人工发起", ""][i % 3]!,
  答复: "",
}));

/** 散文段的形状原型：整段以长文本为主，出的是业务规则不是实体清单。 */
const PROSE_ROWS = [...Array(8).keys()].map((i) => ({
  col1: `采购计划员职责第 ${i} 条：负责依据采购需求计划编制采购执行计划，`
    + "并负责集采计划收集及复核编制、采购包创建分配及调整",
}));

// ══════════════════════════════════════════════════════════════════
//  1. 端到端：材料.xlsx → OIR / 模板
// ══════════════════════════════════════════════════════════════════

interface EndToEnd {
  doc: ParsedDoc;
  index: EvidenceIndex;
  segments: Segment[];
  oir: OIR;
  spec: TemplateSpec;
}

/**
 * 复刻 `tools/export_golden.py::export_pipeline`。
 *
 * **顺序要紧**：导出器是先跑 `finish(oir)` 再写 `pipeline.oir.json` 的，而
 * `finish` 会**就地改写** OIR（把冲突 rid 挂到各实体的 `conflicts` 上、自动修
 * 命名、合并同义对象）。先比 OIR 再 finish 会得到一份 conflicts 全空的 OIR。
 */
async function runPipeline(): Promise<EndToEnd> {
  const path = GOLDEN + "材料.xlsx";
  const doc = await new XlsxParser().parse(path, { fileId: await contentFileId(path) });
  const index = new EvidenceIndex();
  for (const c of doc.chunks) {
    // 解析层的 Chunk 是 snake_case 的 interface，索引里的是 camelCase 的 class
    // （Python 侧是同一个 dataclass，TS 侧还没合并）。这里显式搬一次。
    index.add(new EvChunk({
      chunkId: c.chunk_id, fileId: c.file_id, fileName: c.file_name,
      locator: c.locator as Record<string, unknown>, render: c.render,
      raw: c.raw, order: c.order, tags: c.tags, context: c.context,
    }));
  }
  const segments = segmentCorpus(index, [doc as unknown as SegmentDoc]);
  const merged: Record<string, unknown[]> = {
    objects: [], properties: [], links: [], actions: [], rules: [], questions: [],
  };
  for (const s of segments) {
    const [rows, cites] = s.rows(index);
    const pre = structuralExtract(
      rows, cites, s.shape, s.carryIn) as unknown as Record<string, unknown[]>;
    for (const k of Object.keys(merged)) merged[k]!.push(...(pre[k] ?? []));
  }
  const oir = buildOir(merged, index);
  for (const q of mineQuestions(oir, {
    docs: [doc],
    // gaps 那边读的是解析层的 snake_case 切片；索引里存的是 camelCase 的 class。
    chunks: index.allChunks().map((c) => ({
      file_id: c.fileId, file_name: c.fileName, locator: c.locator, render: c.render,
    })),
  })) {
    if (!oir.questions.has(q.rid)) oir.addQuestion(q);
  }
  const spec = finish(oir, { project: "golden" }).template_spec;
  return { doc, index, segments, oir, spec };
}

describe("端到端：材料.xlsx", () => {
  let e2e: EndToEnd;

  beforeAll(async () => {
    e2e = await runPipeline();
  });

  it("segment_corpus 的分段、形状与继承值", async () => {
    const want = await readJson("pipeline.segments.json");
    const got = e2e.segments.map((s) => ({
      key: s.key, label: s.label, chunks: s.chunkIds.length,
      shape: s.shape.toDict(), carry_in: s.carryIn,
    }));
    expect(got).toEqual(want);
    // 键序也要一样：形状字典会原样进 journal 与事件载荷
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  });

  it("build_oir + mine_questions + finish 之后的整份 OIR", async () => {
    const want = await readJson("pipeline.oir.json");
    const got = e2e.oir.toDict();
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  });

  it("finish() 编出来的模板", async () => {
    const want = await readJson("pipeline.template.json");
    const got = e2e.spec.toDict();
    expect(got).toEqual(want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  });

  it("统计口径（flow 那一档来自未移植的 flow_extract，不比）", async () => {
    const want = await readJson("pipeline.stats.json");
    expect(e2e.oir.stats()).toEqual(want.oir);
    expect(e2e.spec.stats()).toEqual(want.template);
  });

  it("OIR 能从自己的 to_dict 原样还原", async () => {
    const want = await readJson("pipeline.oir.json");
    expect(oirFromDict(want).toDict()).toEqual(want);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 模块向量
// ══════════════════════════════════════════════════════════════════

/**
 * `_RowIdx` 的 TS 对应物。**渲染串由 golden 直接给出** —— Python 的
 * `str(dict)`（单引号、`': '` 分隔）在 JS 里没有对等物，而它会原样进 task 正文。
 */
class RenderIdx implements SegmentIndex {
  constructor(
    private readonly rows: readonly Record<string, unknown>[],
    private readonly cites: readonly string[],
    private readonly renders: readonly string[],
  ) {}

  get(cid: string): ChunkLike | null {
    const m = /^c(\d+)$/.exec(cid);
    if (m === null) return null;
    const i = Number(m[1]);
    const row = this.rows[i];
    if (row === undefined) return null;
    return {
      raw: row, render: this.renders[i] ?? "", tags: ["row"],
      cite: () => this.cites[i] ?? "",
    };
  }
}

function segOf(
  rows: readonly Record<string, unknown>[],
  key: string,
  label: string,
): Segment {
  return new Segment({
    key, label, fileName: "x.xlsx",
    chunkIds: rows.map((_r, i) => `c${i}`),
    shape: inferShape(rows),
  });
}

describe("模块向量（tools/golden/onto_pipeline.py）", () => {
  let g: any;

  beforeAll(async () => {
    g = await readJson("onto.pipeline.json");
  });

  it("常量", () => {
    expect(SEGMENT_CHUNKS).toBe(g.consts.SEGMENT_CHUNKS);
    expect(MIN_SEGMENT).toBe(g.consts.MIN_SEGMENT);
    expect([...CHECKED_YIELDS]).toEqual(g.consts.CHECKED_YIELDS);
    expect(ASK).toEqual(g.consts.ASK);
    expect(JSON.stringify(ASK)).toBe(JSON.stringify(g.consts.ASK));
  });

  it("_looks_like_prose", () => {
    for (const c of g.looks_like_prose) {
      expect([c.in, looksLikeProse(c.in)]).toEqual([c.in, c.out]);
    }
  });

  it("_is_data_row", () => {
    for (const c of g.is_data_row) {
      expect([c.tags, isDataRow({ tags: c.tags })]).toEqual([c.tags, c.out]);
    }
  });

  it("_preview_names", () => {
    for (const c of g.preview_names) {
      expect(previewNames(c.items, c.limit)).toBe(c.out);
    }
  });

  it("_host_names", () => {
    for (const c of g.host_names) {
      expect(hostNames(c.pre)).toEqual(c.out);
    }
  });

  it("_resolve_host", () => {
    for (const c of g.resolve_host) {
      const got = resolveHost(
        c.action,
        new Map(Object.entries(c.by_api)),
        new Map(Object.entries(c.by_display)),
        new Map(Object.entries(c.by_group)),
      );
      expect([c.note, got]).toEqual([c.note, c.out]);
    }
  });

  it("outstanding", () => {
    for (const c of g.outstanding) {
      const shape = inferShape(c.rows);
      expect([c.note, outstanding(shape, c.have)]).toEqual([c.note, c.out]);
    }
  });

  it("_window_shape 只改行数，其余沿用整张表", () => {
    for (const c of g.window_shape) {
      const whole = inferShape(c.rows);
      expect(windowShape(whole, c.part_rows).toDict()).toEqual(c.out);
    }
  });

  it("_prov", () => {
    const index = new EvidenceIndex();
    for (const c of g.prov.chunks) {
      index.add(new EvChunk({
        chunkId: c.chunk_id, fileId: c.file_id, fileName: c.file_name,
        locator: c.locator, render: c.render, raw: c.raw, order: c.order, tags: c.tags,
      }));
    }
    for (const c of g.prov.cases) {
      const got = prov(c.item, c.with_index ? index : null);
      expect([c.note, got]).toEqual([c.note, {
        fileId: c.out.file_id, fileName: c.out.file_name, locator: c.out.locator,
        snippet: c.out.snippet, extractor: c.out.extractor, confidence: c.out.confidence,
      }]);
    }
  });

  it("Segment.rows / Segment.render", () => {
    for (const c of g.segment_render) {
      const idx = new RenderIdx(c.rows, c.cites, c.renders);
      const seg = new Segment({
        key: c.key, label: c.label, fileName: c.file_name, chunkIds: c.chunk_ids,
      });
      const [rows, cites] = seg.rows(idx);
      expect(rows).toEqual(c.out_rows);
      expect(cites).toEqual(c.out_cites);
      expect(seg.render(idx, c.limit)).toBe(c.out_render);
    }
  });

  it("segment_corpus 在合成材料上的分段", () => {
    for (const c of g.segment_corpus) {
      const index = new EvidenceIndex();
      for (const ch of c.chunks) {
        index.add(new EvChunk({
          chunkId: ch.chunk_id, fileId: ch.file_id, fileName: ch.file_name,
          locator: ch.locator, render: ch.render, raw: ch.raw, order: ch.order,
          tags: ch.tags,
        }));
      }
      const doc: SegmentDoc = {
        file_name: c.file_name,
        chunks: c.chunks.map((ch: any) => ({
          chunk_id: ch.chunk_id, locator: ch.locator, tags: ch.tags,
        })),
      };
      const got = segmentCorpus(index, [doc]).map((s) => ({
        key: s.key, label: s.label, file_name: s.fileName,
        chunk_ids: s.chunkIds, shape: s.shape.toDict(), carry_in: s.carryIn,
      }));
      expect([c.note, got]).toEqual([c.note, c.out]);
    }
  });

  // ── 分页碎段的合并 ───────────────────────────────────────────
  //
  // 一次真实事故：一份 155 页的 pptx，分组键是 `p{页码}`、每页恰好 6~7 片，
  // **刚好越过 MIN_SEGMENT=6**，于是 155 页各自成段（全库 219 段）。每段只装
  // 6~7 片而节点额度是 45 —— 装了七分之一却付了七倍固定开销，队列排到后面的
  // 段连模型都没调到就被墙钟判死。
  //
  // 判据分两层，缺一层都会走偏：
  //   * 只对**页码派生**的键提高阈值 —— sheet/object/section 是真容器，
  //     哪怕只有几片也值得单独看；"第 107 页"不是容器，只是一次分页。
  //   * 只在同文件有**两个以上**装不满的分页时才合 —— 只有一个的时候合并
  //     一个节点都省不下，却把 `p4` 这种标签换成了「其它」，纯损失。
  describe("分页碎段合并", () => {
    const pageChunk = (id: string, page: number) => ({
      chunk_id: id, locator: { kind: "page", page }, tags: ["para"],
    });
    const seg = (chunks: { chunk_id: string; locator: unknown; tags: string[] }[]) =>
      segmentCorpus(
        new RenderIdx([], chunks.map((c) => c.chunk_id), chunks.map(() => "x")) as never,
        [{ file_name: "幻灯片.pptx", chunks } as unknown as SegmentDoc],
      );

    it("**多个装不满的分页合并成一段**，而不是每页一个节点", () => {
      // 6 页 × 每页 7 片 = 42 片。全部 < MIN_PAGE_SEGMENT(15)，且不止一个 → 合并
      const chunks = [];
      for (let p = 1; p <= 6; p += 1) {
        for (let i = 0; i < 7; i += 1) chunks.push(pageChunk(`c${p}_${i}`, p));
      }
      const out = seg(chunks);
      expect(out.length).toBe(1);
      expect(out[0]!.label).toBe("其它");
      expect(out[0]!.chunkIds.length).toBe(42);
    });

    it("**只有一个小分页时保住它的标签** —— 合并一个节点都省不下", () => {
      const out = seg([1, 2, 3, 4, 5, 6].map((i) => pageChunk(`c${i}`, 4)));
      expect(out.length).toBe(1);
      expect(out[0]!.label).toBe("p4");
    });

    it("装得满的分页保留自己的标签 —— 阈值判的是「填不填得满」", () => {
      const chunks = [];
      for (let i = 0; i < 20; i += 1) chunks.push(pageChunk(`a${i}`, 1));
      for (let i = 0; i < 20; i += 1) chunks.push(pageChunk(`b${i}`, 2));
      const labels = seg(chunks).map((x) => x.label).sort();
      expect(labels).toEqual(["p1", "p2"]);
    });
  });

  it("ExtractSegment.wants() 与 task() 的整段正文", () => {
    for (const c of g.extract_task) {
      const idx = new RenderIdx(c.rows, c.cites, c.renders);
      const seg = segOf(c.rows, c.key, c.label);
      const h = new ExtractSegment(seg, idx, STUB_AGENT, "");
      expect([c.note, h.wants()]).toEqual([c.note, c.wants]);
      expect(h.task({})).toBe(c.task);
      expect(h.query({})).toBe(c.query);
      // 契约闭合：critic 判缺的每一类，任务描述里都点名要过
      for (const y of h.wants() as Yield[]) expect(c.task).toContain(ASK[y]);
    }
  });

  it("ExtractSegment.finalize() 合并规则侧与模型侧", () => {
    for (const c of g.finalize) {
      const idx = new RenderIdx(c.rows, c.cites, c.renders);
      const h = new ExtractSegment(segOf(c.rows, "s0", c.label), idx, STUB_AGENT, "");
      const got = h.finalize(c.draft, {});
      expect([c.note, got]).toEqual([c.note, c.out]);
      expect(JSON.stringify(got)).toBe(JSON.stringify(c.out));
    }
  });

  it("MineRules / HarvestQuestions / MergeSegments", async () => {
    const mine = g.mine_rules;
    const mi = new RenderIdx(mine.rows, mine.cites, mine.renders);
    const mh = new MineRules(segOf(mine.rows, "s0", mine.label), mi, STUB_AGENT, "sys");
    expect(mh.task({})).toBe(mine.task);
    expect(mh.query({})).toBe(mine.query);

    const hq = g.harvest;
    const hi = new RenderIdx(hq.rows, hq.cites, hq.renders);
    const hh = new HarvestQuestions(segOf(hq.rows, "s0", hq.label), hi);
    expect(hh.task({})).toBe(hq.task);
    expect(hh.skipModel({})).toEqual(hq.skip_model);
    expect(hh.schema).toBeNull();

    const merged = await new MergeSegments(hi).execute(g.merge.inputs, null as never);
    expect(merged).toEqual(g.merge.out);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(g.merge.out));
  });

  it("CoverageCritic 的每一条 finding", async () => {
    for (const c of g.coverage) {
      const seg = new Segment({
        key: c.key, label: c.label, fileName: "x.xlsx",
        chunkIds: c.rows.map((_r: unknown, i: number) => `c${i}`),
        shape: inferShape(c.rows),
      });
      const critic = new CoverageCritic([seg], null);
      const v = await critic.judge(c.draft, makeCriticContext({ nodeId: c.node_id }));
      expect([c.note, {
        lens: v.lens, passed: v.passed, note: v.note,
        findings: v.findings.map((f) => ({
          severity: f.severity, code: f.code, target: f.target, claim: f.claim,
          evidence_checked: [...f.evidenceChecked], proposed_fix: f.proposedFix,
          verifier: f.verifier,
        })),
      }]).toEqual([c.note, c.out]);
    }
  });

  // 这条以前钉的是**相反**的行为：「LINKS 缺失时炸 KeyError（Python 侧同样炸，照迁不修）」。
  //
  // 「照迁不修」在移植期是对的 —— 一边迁一边修 bug，就分不清哪处差异是移植错误、
  // 哪处是有意改动。但那条规则**有前提：存在一个还在跑的 Python 对照实现**。
  // 59346fa「删掉 Python 源码树，仓库归零 .py」之后，对照方没有了：
  // `tools/golden/onto_pipeline.py` 只剩一个 __pycache__。
  // 为了跟一个已经删掉的实现保持一致而留着一个崩溃，那不叫权衡，就是崩溃。
  //
  // 而且这个崩溃是**后来才变得可达的**：`YIELD_CN` 那句取值原本是死代码 ——
  // LINKS 不在 CHECKED_YIELDS 里，`outstanding()` 永远返回不了它。后来有人特意把
  // LINKS 加进 CHECKED_YIELDS（还写了四行注释说明为什么），这一句就活了，而
  // `Partial<Record<…>>` 的类型没拦住。现在 YIELD_CN 是完整 Record，编译期会拦。
  //
  // 用的还是同一个 golden 向量 —— 那是一张「主键/外键/类型」表，
  // 恰恰是现实里最常见的关系定义材料。
  // 这一条钉的是上一条的**另一半**。补了 YIELD_CN 之后崩溃变成了"永远失败"：
  // check() 从来不读 draft.links，outstanding() 收到的 have.links 恒为 undefined，
  // 于是任何形状带 LINKS 的段都被判「一条关系都没抽到」—— 抽得好好的那份也一样，
  // 精炼循环还会反复重试。崩是响的，"永远失败"是闷的，闷的那种更贵。
  it("**抽到了关系就不能判缺**（漏读 links 桶会让这一类恒判失败，比崩更难发现）", async () => {
    const c = g.coverage_links_keyerror;
    const seg = new Segment({
      key: "s0", label: "两列标识符", fileName: "x.xlsx",
      chunkIds: c.rows.map((_r: unknown, i: number) => `c${i}`),
      shape: inferShape(c.rows),
    });
    expect(c.shape_yields).toContain("links");

    // 同一个向量，只把 links 桶填上 —— 这一段就不该再有 LINKS_MISSING
    const withLinks = {
      ...c.draft,
      links: [{ api_name: "A_B", from_api_name: "a", to_api_name: "b", cardinality: "ONE_TO_MANY" }],
    };
    const v = await new CoverageCritic([seg], null)
      .judge(withLinks, makeCriticContext({ nodeId: "EXTRACT.s0" }));
    expect(v.findings.filter((f) => f.code === "LINKS_MISSING")).toHaveLength(0);
  });

  it("CoverageCritic 在 LINKS 缺失时报 finding，不再炸 KeyError", async () => {
    const c = g.coverage_links_keyerror;
    const seg = new Segment({
      key: "s0", label: "两列标识符", fileName: "x.xlsx",
      chunkIds: c.rows.map((_r: unknown, i: number) => `c${i}`),
      shape: inferShape(c.rows),
    });
    // 向量本身没变：这一段的形状确实"本该抽出关系"，而 draft 里一条都没有
    expect(c.shape_yields).toContain("links");
    expect(c.python_error).toBe("KeyError"); // 历史记录，留着说明这里改了什么

    const v = await new CoverageCritic([seg], null)
      .judge(c.draft, makeCriticContext({ nodeId: "EXTRACT.s0" }));

    expect(v.passed).toBe(false);
    const links = v.findings.filter((f) => f.code === "LINKS_MISSING");
    expect(links).toHaveLength(1);
    // 文案里要有「关系」两个字 —— 这正是原来 YIELD_CN 缺的那一条
    expect(links[0]!.claim).toContain("关系");
    expect(links[0]!.severity).toBe("high");
  });

  it("provenance_critic", async () => {
    for (const c of g.provenance) {
      const v = await provenanceCritic().judge(c.draft, makeCriticContext({ nodeId: "N" }));
      expect([c.note, {
        lens: v.lens, passed: v.passed, note: v.note,
        findings: v.findings.map((f) => ({
          severity: f.severity, code: f.code, target: f.target, claim: f.claim,
          verifier: f.verifier,
        })),
      }]).toEqual([c.note, c.out]);
    }
  });

  it("_SegmentRouter：形状挑 handler、散文段拿 rule_miner 的 system", () => {
    const r = g.segment_router;
    const rows = [{ 编码: "a" }, { 编码: "b" }, { 编码: "c" }];
    const segs = [segOf(rows, "s0", "表"), segOf(PROSE_ROWS, "s1", "散文"),
      segOf(SURVEY_ROWS, "s2", "问卷")];
    expect(segs.map((s) => s.shape.rowUnit)).toEqual(r.row_units);

    const router = new SegmentRouter(segs, new RenderIdx([], [], []), STUB_AGENT, "sys");
    const cls: Record<string, string> = {};
    for (const s of segs) cls[s.key] = router.forNode(`EXTRACT.${s.key}`).constructor.name;
    expect(cls).toEqual(r.handlers);
    // 散文段的 system 来自 rule_miner 自己 —— 逐字节对 Python 那份提示词
    expect((router.forNode("EXTRACT.s1") as MineRules).system).toBe(r.rule_miner_system);
    expect((router.forNode("EXTRACT.s0") as ExtractSegment).system).toBe(r.extractor_system_arg);
    // 找不到的段是 KeyError，不是静默返回自己 —— 静默会让整段材料悄悄丢掉
    expect(() => router.forNode("EXTRACT.s9")).toThrow(r.missing_key_error);
  });

  it("dispatch 回给模型的错误文案", () => {
    // `f"{type(exc).__name__}: {exc}"` 的四种形态由 golden 钉住；
    // 真正的调用路径见下面「TS 侧独有的风险」那一节。
    expect(g.dispatch.map((c: any) => c.out.error)).toEqual([
      "TypeError: 参数不对", "KeyError: 'evidence.rows'", "ToolDenied: 没权限",
      "本节点没有可用工具",
    ]);
  });

  it("build_dag 展开出来的拓扑", () => {
    const segs = g.build_dag.keys.map((k: string) => new Segment({
      key: k, label: k, fileName: "x.xlsx", chunkIds: [],
    }));
    expect(buildDag(segs).describe()).toEqual(g.build_dag.describe);
  });

  it("build_oir 的每一条分支 + 丢弃统计", () => {
    for (const c of g.build_oir) {
      const dropped: Record<string, unknown> = {};
      const oir = buildOir(c.data, null, dropped);
      expect([c.note, oir.toDict()]).toEqual([c.note, c.out]);
      expect(JSON.stringify(oir.toDict())).toBe(JSON.stringify(c.out));
      expect(dropped).toEqual(c.dropped);
    }
  });

  it("finish() 的全部键", () => {
    for (const c of g.finish) {
      const oir = oirFromDict(c.oir);
      const res = finish(oir, { maxQuestions: c.max_questions, project: c.project });
      const cs = res.clarify;
      expect([c.note, {
        align: res.align,
        merged: res.merged,
        uncertain: res.uncertain,
        align_gaps: res.align_gaps.map((x) => ({
          text: x.text, group: x.group, kind: x.kind,
          prov: x.prov === null ? null : {
            file_id: x.prov.fileId, file_name: x.prov.fileName,
            locator: x.prov.locator, snippet: x.prov.snippet,
            extractor: x.prov.extractor, confidence: x.prov.confidence,
          },
          options: x.options, applies_to: x.appliesTo, weight: x.weight,
        })),
        conflicts: res.conflicts.map(conflictToDict),
        auto_repaired: res.auto_repaired,
        clarify: {
          summary: clarificationSummary(cs),
          questions: cs.questions.map(clarifyQuestionToDict),
          auto_repairable: cs.autoRepairable.map((x) => x.rid),
          deferred_to_template: cs.deferredToTemplate.map((x) => x.rid),
          round_trip: cs.roundTrip.map((x) => x.rid),
          hints: cs.hints.map((x) => x.rid),
          stopped_because: cs.stoppedBecause,
        },
        suggestions: res.suggestions,
        template_spec: res.template_spec.toDict(),
      }]).toEqual([c.note, c.out]);
      // finish() 会**就地改写** OIR（自动修冲突、合并同义对象）
      expect(oir.toDict()).toEqual(c.oir_after);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. TS 侧独有的风险（Python 没覆盖，但语言边界在这里）
// ══════════════════════════════════════════════════════════════════

describe("TS 侧独有的风险", () => {
  /** `ctx.bus.read("_tools")` 那条路：`LoopBus` 只声明了 `renderFacts`，
   * 黑板读取是运行时收窄的，所以这一段没有类型保护，只能靠用例。 */
  const busCtx = (tools: unknown): never =>
    ({ bus: { read: (k: string) => (k === "_tools" ? tools : null) } }) as never;

  it("dispatch：没有工具时回一句话，不是抛异常", async () => {
    const rows = [{ 编码: "a" }, { 编码: "b" }, { 编码: "c" }];
    const idx = new RenderIdx(rows, ["c1", "c2", "c3"], ["a", "b", "c"]);
    const h = new ExtractSegment(segOf(rows, "s0", "表"), idx, STUB_AGENT, "");
    expect(await h.dispatch({ tool: "evidence.search" }, busCtx(null)))
      .toEqual({ error: "本节点没有可用工具" });
  });

  it("dispatch：工具抛异常时把 `类名: 消息` 回给模型，不中断整个节点", async () => {
    const rows = [{ 编码: "a" }, { 编码: "b" }, { 编码: "c" }];
    const idx = new RenderIdx(rows, ["c1", "c2", "c3"], ["a", "b", "c"]);
    const seen: unknown[] = [];
    const tools = {
      call: (name: string, args: unknown, _c: unknown, opts: { scope?: string }) => {
        seen.push([name, args, opts.scope]);
        if (name === "boom") return Promise.reject(new TypeError("参数不对"));
        return Promise.resolve({ ok: name });
      },
    };
    const h = new ExtractSegment(segOf(rows, "s0", "表"), idx, STUB_AGENT, "");
    // args 缺失时补空 dict；scope 恒为 "extract"
    expect(await h.dispatch({ tool: "evidence.search" }, busCtx(tools)))
      .toEqual({ ok: "evidence.search" });
    expect(seen).toEqual([["evidence.search", {}, "extract"]]);
    expect(await h.dispatch({ tool: "boom", args: { q: 1 } }, busCtx(tools)))
      .toEqual({ error: "TypeError: 参数不对" });
    // tool 缺失时 Python 传的是空串（`action.get("tool","")`），不是 "None"
    await h.dispatch({}, busCtx(tools));
    expect(seen[2]).toEqual(["", {}, "extract"]);

    const m = new MineRules(segOf(rows, "s0", "表"), idx, STUB_AGENT, "");
    expect(await m.dispatch({ tool: "boom" }, busCtx(tools)))
      .toEqual({ error: "TypeError: 参数不对" });
  });

  it("handlers_for 注册的两个名字", () => {
    const h = handlersFor([], new RenderIdx([], [], []), STUB_AGENT, "");
    expect(Object.keys(h).sort()).toEqual(["extract", "merge"]);
    expect(h["merge"]).toBeInstanceOf(MergeSegments);
  });

  it("码点切片：rid 里的中文不能被切出半个字", () => {
    // stmt[:40] 进 rid。JS 的 slice 按 UTF-16 码元，emoji 会被劈成孤儿代理对，
    // slug 出来的字节就不是同一份。
    const stmt = "🐍".repeat(30) + "尾巴";
    const a = buildOir({ objects: [], rules: [{ statement: stmt }] });
    const b = buildOir({ objects: [], rules: [{ statement: stmt }] });
    const rid = [...a.rules.keys()][0]!;
    expect([...b.rules.keys()][0]).toBe(rid);
    // 没有孤儿代理对
    expect(rid).toBe(rid.normalize("NFC"));
    expect([...rid].every((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp < 0xd800 || cp > 0xdfff;
    })).toBe(true);
  });

  it("_cite_index 缓存挂在索引对象上，两个索引互不串味", () => {
    const mk = (fileName: string): EvidenceIndex => {
      const ix = new EvidenceIndex();
      ix.add(new EvChunk({
        chunkId: "c1", fileId: "f1", fileName,
        locator: { kind: "range", sheet: "S", rows: [2, 2] },
        render: "行内容", raw: { a: 1 }, order: 0, tags: ["row"],
      }));
      return ix;
    };
    const item = { source_locator: "a.xlsx!S!R2-2", _origin: "rule" };
    expect(prov(item, mk("a.xlsx")).fileName).toBe("a.xlsx");
    // 第二个索引里没有这个 cite —— 缓存若按 id() 复用就会错命中
    expect(prov(item, mk("b.xlsx")).locator).toEqual({ kind: "raw", ref: "a.xlsx!S!R2-2" });
  });

  // ── 2026-08-25 真库审计（3b06cae04490）──────────────────────────
  // 27 个对象里 24 个的 locator.kind 是 raw、confidence 0.6、snippet 就是它**自己
  // 的名字** —— 也就是「证据 = 它自己」。它们共用同一个解析不出来的 cite
  // `…xlsx#固定规则驱动!R1-26`：分隔符是 #（索引里是 !）、行范围是整段（索引里
  // 是逐行 R2-2）。而 provenanceCritic 只判 source_locator 非空，字段有值就放行。
  it("cite 的分隔符与单行范围写法不同也要认出来 —— 别退化成「证据是它自己」", () => {
    const ix = new EvidenceIndex();
    ix.add(new EvChunk({
      chunkId: "c1", fileId: "f1", fileName: "采购.xlsx",
      locator: { kind: "range", sheet: "固定规则驱动", rows: [12, 12] },
      render: "R12 的原文", raw: {}, order: 0, tags: ["row"],
    }));
    // 模型常写成「R12」而索引里是「R12-12」
    expect(prov({ source_locator: "采购.xlsx!固定规则驱动!R12" }, ix).locator)
      .toEqual({ kind: "range", sheet: "固定规则驱动", rows: [12, 12] });
    // 也常把文件与表之间的分隔符写成 #
    expect(prov({ source_locator: "采购.xlsx#固定规则驱动!R12-12" }, ix).locator)
      .toEqual({ kind: "range", sheet: "固定规则驱动", rows: [12, 12] });
    // 真解析不出来的仍然如实回落成 raw（不许硬认一个）
    expect(prov({ source_locator: "采购.xlsx!别的表!R3-3" }, ix).locator["kind"]).toBe("raw");
  });

  it("解析不出出处要**说出来**，不能靠「字段非空」放行", async () => {
    const ix = new EvidenceIndex();
    ix.add(new EvChunk({
      chunkId: "c1", fileId: "f1", fileName: "采购.xlsx",
      locator: { kind: "range", sheet: "S", rows: [2, 2] },
      render: "行内容", raw: {}, order: 0, tags: ["row"],
    }));
    const draft = {
      objects: [
        { api_name: "good", source_locator: "采购.xlsx!S!R2-2" },
        { api_name: "ungrounded", source_locator: "采购.xlsx#固定规则驱动!R1-26" },
      ],
    };
    const v = await provenanceCritic(ix).judge(draft, makeCriticContext({ nodeId: "N" }));
    const codes = v.findings.map((f) => f.code);
    expect(codes).toContain("EVIDENCE_UNRESOLVED");
    expect(v.findings.find((f) => f.code === "EVIDENCE_UNRESOLVED")?.target).toBe("ungrounded");
    // 有真实材料索引时解析不到就必须打回；否则会被包装成“证据=条目自己”。
    expect(v.findings.find((f) => f.code === "EVIDENCE_UNRESOLVED")?.severity).toBe("high");
  });

  it("真实但无关的出处不能给模型主张背书，也不能进入实证 OIR", async () => {
    const ix = new EvidenceIndex();
    ix.add(new EvChunk({
      chunkId: "c1",
      fileId: "f1",
      fileName: "流程.md",
      locator: { kind: "page", page: 2 },
      render: "采购申请由申请人提交。",
      raw: {},
      order: 0,
      tags: ["page"],
    }));
    const draft = {
      objects: [{
        api_name: "SAPSystem",
        display_name: "SAP S/4HANA",
        source_file: "流程.md",
        source_locator: "流程.md#p2",
      }],
      properties: [],
      links: [],
    };
    const verdict = await provenanceCritic(ix).judge(
      draft,
      makeCriticContext({ nodeId: "EXTRACT.test" }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_NOT_SUPPORTING_CLAIM", severity: "high" }),
    ]));
    const dropped: Record<string, unknown> = {};
    expect(buildOir(draft, ix, dropped).objects.size).toBe(0);
    expect(dropped["ungrounded"]).toBe(1);
  });

  it("真实出处只给原文出现的字段背书，不能替同一行里的虚构细节洗白", () => {
    const ix = new EvidenceIndex();
    const addPage = (page: number, render: string): void => ix.add(new EvChunk({
      chunkId: `c${page}`,
      fileId: "f1",
      fileName: "模型.md",
      locator: { kind: "page", page },
      render,
      raw: {},
      order: page,
      tags: ["page"],
    }));
    addPage(1, "业务对象：采购申请；字段：requestId、金额。");
    addPage(2, "业务对象：采购订单。");
    addPage(3, "动作：提交采购申请；对象：采购申请。");
    addPage(4, "规则：采购申请提交后进入部门复核。");
    addPage(5, "事件：采购申请已提交。");
    addPage(6, "关系：采购申请关联采购订单。");

    const oir = buildOir({
      objects: [
        {
          api_name: "PurchaseRequest",
          display_name: "采购申请",
          description: "董事长专用的火星采购单",
          classification: "绝密主数据",
          primary_key: ["secretId"],
          source_locator: "模型.md#p1",
        },
        {
          api_name: "PurchaseOrder",
          display_name: "采购订单",
          source_locator: "模型.md#p2",
        },
      ],
      properties: [{
        parent_api_name: "采购申请",
        api_name: "amount",
        display_name: "金额",
        base_type: "DECIMAL",
        definition: "含火星税的一亿元预算",
        unit: "火星币",
        semantic_type: "TOP_SECRET",
        value_domain: ["一亿元"],
        source_locator: "模型.md#p1",
      }],
      links: [{
        api_name: "requestToOrder",
        from_api_name: "采购申请",
        to_api_name: "采购订单",
        cardinality: "ONE_TO_MANY",
        join_key: { from_property: "secretId", to_property: "marsId" },
        source_locator: "模型.md#p6",
      }],
      actions: [{
        api_name: "submitPurchaseRequest",
        display_name: "提交采购申请",
        object_display: "采购申请",
        actor: "董事长",
        preconditions: ["金额超过一亿元"],
        effects: ["采购申请状态改为已提交"],
        endpoint: "/mars/purchase/submit",
        source_locator: "模型.md#p3",
      }],
      rules: [{
        statement: "采购申请提交后进入部门复核。",
        kind: "PROCESS",
        applies_to: ["采购申请"],
        actor: "董事长",
        condition: "amount > 100000000",
        source_locator: "模型.md#p4",
      }],
      events: [{
        api_name: "PurchaseRequestSubmitted",
        display_name: "采购申请已提交",
        emitted_by: "approveOnMars",
        payload_objects: ["火星采购单"],
        source_locator: "模型.md#p5",
      }],
    }, ix);

    const request = [...oir.objects.values()].find((o) => o.displayName.value === "采购申请")!;
    expect(request.apiName.origin).toBe("inferred");
    expect(request.displayName.origin).toBe("extracted");
    expect(request.description).toMatchObject({
      value: "董事长专用的火星采购单", origin: "inferred", evidence: [],
    });
    expect(request.classification.origin).toBe("inferred");
    expect(request.primaryKey).toMatchObject({ value: [], origin: "inferred" });

    const property = [...oir.properties.values()][0]!;
    expect(property.displayName.origin).toBe("extracted");
    expect(property.definition.origin).toBe("inferred");
    expect(property.unit.origin).toBe("inferred");
    expect(property.semanticType.origin).toBe("inferred");
    expect(property.valueDomain.origin).toBe("inferred");

    const link = [...oir.links.values()][0]!;
    expect(link.cardinality.origin).toBe("inferred");
    expect(link.joinKey.origin).toBe("inferred");

    const action = [...oir.actions.values()][0]!;
    expect(action.appliesTo).toEqual([request.rid]);
    expect(action.actor.origin).toBe("inferred");
    expect(action.preconditions.origin).toBe("inferred");
    expect(action.effects.origin).toBe("inferred");
    expect(action.sourceEndpoint.origin).toBe("inferred");

    const rule = [...oir.rules.values()][0]!;
    expect(rule.statement.origin).toBe("extracted");
    expect(rule.kind.origin).toBe("inferred");
    expect(rule.appliesTo).toEqual([request.rid]);
    expect(rule.actor.origin).toBe("inferred");
    expect(rule.condition.origin).toBe("inferred");

    const event = [...oir.events.values()][0]!;
    expect(event.displayName.origin).toBe("extracted");
    expect(event.emittedBy).toEqual([]);
    expect(event.payload).toEqual([]);
  });

  it("动作、事件和规则与对象一样受材料出处硬门约束", async () => {
    const ix = new EvidenceIndex();
    ix.add(new EvChunk({
      chunkId: "c1",
      fileId: "f1",
      fileName: "流程.md",
      locator: { kind: "page", page: 1 },
      render: "采购申请由申请人提交。",
      raw: {},
      order: 0,
      tags: ["page"],
    }));
    const verdict = await provenanceCritic(ix).judge({
      actions: [{ api_name: "approveMars", source_locator: "流程.md#p99" }],
      events: [{ api_name: "MarsArrived", source_locator: "流程.md#p99" }],
      rules: [{ statement: "金额超过一亿元时冻结预算", source_locator: "流程.md#p99" }],
    }, makeCriticContext({ nodeId: "EXTRACT.test" }));
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.filter((finding) => finding.code === "EVIDENCE_UNRESOLVED"))
      .toHaveLength(3);
  });

  it("不给索引时行为不变（老部署 / 单测）", async () => {
    const v = await provenanceCritic().judge(
      { objects: [{ api_name: "x", source_locator: "谁知道呢" }] },
      makeCriticContext({ nodeId: "N" }),
    );
    expect(v.findings).toEqual([]);
  });

  it("没有 tags 的切片一律归 main（Python 的运算符优先级）", () => {
    const index = new EvidenceIndex();
    const chunks = [...Array(8).keys()].map((i) => new EvChunk({
      chunkId: `c${i}`, fileId: "f1", fileName: "x.xlsx",
      locator: { kind: "range", sheet: "实体", rows: [i + 2, i + 2] },
      render: `行${i}`, raw: { 编码: `po${i}` }, order: i, tags: [],
    }));
    for (const c of chunks) index.add(c);
    const doc: SegmentDoc = {
      file_name: "x.xlsx",
      chunks: chunks.map((c) => ({ chunk_id: c.chunkId, locator: c.locator, tags: c.tags })),
    };
    // locator 里明明写着 sheet=实体，但 tags 是空的 —— 条件表达式绑得最松，
    // 整个 or 链根本没被求值。
    expect(segmentCorpus(index, [doc]).map((s) => s.label)).toEqual(["main"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  关系两端按显示名/别名解析（E2E 案发：39 条中文名关系整批 lost）
// ══════════════════════════════════════════════════════════════════
describe("buildOir · 关系两端认显示名", () => {
  const mk = (links: Record<string, unknown>[]) => ({
    objects: [
      { api_name: "supplierMaster", display_name: "供应商主数据",
        source_file: "a.xlsx", source_locator: "a.xlsx!S#r2" },
      { api_name: "purchaseInfoRecord", display_name: "采购信息记录",
        source_file: "a.xlsx", source_locator: "a.xlsx!S#r3" },
    ],
    properties: [], links,
  });

  it("中文显示名两端 → 解析到对象 rid，不再进 lost", () => {
    const dropped: Record<string, unknown> = {};
    const oir = buildOir(mk([{
      api_name: "供应商主数据_采购信息记录",
      from_api_name: "供应商主数据", to_api_name: "采购信息记录",
      cardinality: "ONE_TO_MANY",
      source_file: "b.xlsx", source_locator: "b.xlsx!关联#r2", _origin: "rule",
    }]), null, dropped);
    expect(oir.links.size).toBe(1);
    const l = [...oir.links.values()][0]!;
    expect(l.source).toBe("ot_suppliermaster");
    expect(l.target).toBe("ot_purchaseinforecord");
    expect((dropped["links"] ?? 0)).toBe(0);
  });

  it("api_name 命中仍然优先；真正对不上的照旧记账", () => {
    const dropped: Record<string, unknown> = {};
    const oir = buildOir(mk([
      { api_name: "l1", from_api_name: "supplierMaster",
        to_api_name: "purchaseInfoRecord", cardinality: "ONE_TO_ONE",
        source_file: "b.xlsx", source_locator: "b!#1" },
      { api_name: "l2", from_api_name: "不存在的对象", to_api_name: "采购信息记录",
        cardinality: "ONE_TO_MANY", source_file: "b.xlsx", source_locator: "b!#2" },
    ]), null, dropped);
    expect(oir.links.size).toBe(1);
    expect(dropped["links"]).toBe(1);
    expect(dropped["link_endpoints"]).toContain("不存在的对象");
  });

  it("MANY_TO_ONE 在显示名解析下同样对调方向", () => {
    const oir = buildOir(mk([{
      api_name: "cfg", from_api_name: "采购信息记录", to_api_name: "供应商主数据",
      cardinality: "MANY_TO_ONE",
      source_file: "b.xlsx", source_locator: "b!#3", _origin: "rule",
    }]), null, {});
    const l = [...oir.links.values()][0]!;
    expect(l.source).toBe("ot_suppliermaster");   // 翻转后 1 端在前
    expect(l.cardinality.value).toBe("ONE_TO_MANY");
  });
});

// ══════════════════════════════════════════════════════════════════
//  登记表缺行点名（36 行漏 3 行、0.8 阈值放行的案发路径）
// ══════════════════════════════════════════════════════════════════
describe("CoverageCritic · 登记表缺行按名称列点名", () => {
  it("91.7% 覆盖也要报，且 claim 里点名缺的行", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      L1数据域: "采购管理",
      L2数据子域: i < 6 ? "采购主数据" : "采购执行",
      L3业务对象: ["采购组织","采购品类","供应商主数据","采购申请","采购订单","采购合同",
        "物料凭证","供应商发票","货源清单","违约索赔单","监造计划","质量通知"][i]!,
      业务对象定义: "企业内负责采购业务的组织单元，含描述、结构及分配关系等完整定义文本",
      目前实现系统: i % 2 ? "SAP" : "ECP",
    }));
    const doc = { chunks: rows.map((r, i) => ({
      chunk_id: `c${i}`, file_id: "f1", file_name: "清单.xlsx",
      locator: { kind: "cell", sheet: "S", row: i + 2 }, render: JSON.stringify(r),
      raw: r, order: i, tags: ["row"], context: "",
    })) };
    const index = new EvidenceIndex();
    for (const c of doc.chunks) {
      index.add(new EvChunk({
        chunkId: c.chunk_id, fileId: c.file_id, fileName: c.file_name,
        locator: c.locator as Record<string, unknown>, render: c.render,
        raw: c.raw, order: c.order, tags: c.tags, context: c.context,
      }));
    }
    const segs = segmentCorpus(index, [doc as unknown as SegmentDoc]);
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    const critic = new CoverageCritic([seg], index);
    // 模型抽了 9 个、漏了尾部 3 行
    const draft = { objects: rows.slice(0, 9).map((r) => ({
      api_name: `obj${r["L3业务对象"]}`, display_name: r["L3业务对象"],
    })), properties: [], links: [], actions: [] };
    const verdict = await critic.judge(draft, { nodeId: `EXTRACT.${seg.key}` } as never);
    const dropped = verdict.findings.find((f) => f.code === "ROWS_DROPPED");
    expect(dropped).toBeDefined();
    expect(dropped!.claim).toContain("违约索赔单");
    expect(dropped!.claim).toContain("监造计划");
    expect(dropped!.claim).toContain("质量通知");
    expect(dropped!.proposedFix?.hint).toContain("其余已抽出的不要动");
  });

  // ── 2026-08-25 实拍事故（3b06cae04490）的形状 ──────────────────
  // 那张 sheet 是三张叠在一起的子表：横幅行（整行合并成一个值）、子表头行、
  // 以及同一个业务对象横跨多行。旧判据两处都错：
  //  ① 点名清单把横幅行/序号行当成「漏掉的对象」念给模型 —— journal seq 78 的
  //     hint 里赫然写着「把这些行补进来：业务对象、…、二、规则体系明细…」，
  //     模型第一轮抽了 2 个（正确的是 7 个），被两轮 refine 逼到 26 个 =
  //     26 行 × 一行一对象，`do.一` / `do.三` / `do.业务对象` 就是这么来的；
  //  ② 分母拿**行数**比**实体数**：采购计划占 3 行、执行偏差占 2 行，
  //     7 个对象永远够不到 26 × 0.8，清单清干净了也照样 HIGH，
  //     hint 退化成「逐行过一遍，不要跳行」—— 模型还是会编。
  const noisyRows = () => [
    // 横幅行：整行合并 → 各列同值
    { 名称: "一、业务对象与查询依据", 说明: "一、业务对象与查询依据", 系统: "一、业务对象与查询依据" },
    { 名称: "采购计划", 说明: "采购计划的主数据", 系统: "ERP" },
    { 名称: "采购计划", 说明: "采购计划的行项", 系统: "ERP" },
    { 名称: "采购计划", 说明: "采购计划的变更", 系统: "ERP" },
    { 名称: "采购申请", 说明: "请购单", 系统: "ERP" },
    { 名称: "采购订单", 说明: "订单", 系统: "ERP" },
    { 名称: "发运", 说明: "发货", 系统: "SRM" },
    { 名称: "验收", 说明: "到货验收", 系统: "SRM" },
    { 名称: "执行偏差", 说明: "系统计算对象", 系统: "-" },
    { 名称: "执行偏差", 说明: "偏差明细", 系统: "-" },
    // 第二张子表的横幅行 + 子表头行
    { 名称: "二、规则体系明细", 说明: "二、规则体系明细", 系统: "二、规则体系明细" },
    { 名称: "规则名称", 说明: "说明", 系统: "系统" },
    { 名称: "节点进度自动同步", 说明: "规则", 系统: "ERP" },
  ];
  const criticFor = (rows: Record<string, unknown>[]) => {
    const doc = { chunks: rows.map((r, i) => ({
      chunk_id: `n${i}`, file_id: "f1", file_name: "方案.xlsx",
      locator: { kind: "cell", sheet: "固定规则驱动", row: i + 2 }, render: JSON.stringify(r),
      raw: r, order: i, tags: ["row"], context: "",
    })) };
    const index = new EvidenceIndex();
    for (const c of doc.chunks) {
      index.add(new EvChunk({
        chunkId: c.chunk_id, fileId: c.file_id, fileName: c.file_name,
        locator: c.locator as Record<string, unknown>, render: c.render,
        raw: c.raw, order: c.order, tags: c.tags, context: c.context,
      }));
    }
    const segs = segmentCorpus(index, [doc as unknown as SegmentDoc]);
    return { critic: new CoverageCritic(segs, index), seg: segs[0]! };
  };

  it("横幅行、子表头行、序号行不许被当成「漏掉的对象」念给模型", async () => {
    const { critic, seg } = criticFor(noisyRows());
    // 模型抽出了**正确的**那 7 个业务对象
    const names = ["采购计划", "采购申请", "采购订单", "发运", "验收", "执行偏差", "节点进度自动同步"];
    const draft = { objects: names.map((n) => ({ api_name: n, display_name: n })), properties: [], links: [], actions: [] };
    const verdict = await critic.judge(draft, { nodeId: `EXTRACT.${seg.key}` } as never);
    const dropped = verdict.findings.find((f) => f.code === "ROWS_DROPPED");
    const said = `${dropped?.claim ?? ""} ${dropped?.proposedFix?.hint ?? ""}`;
    for (const junk of ["一、业务对象与查询依据", "二、规则体系明细", "规则名称"]) {
      expect(said, `不该点名「${junk}」`).not.toContain(junk);
    }
  });

  it("同一个对象横跨多行时，分母要用**去重后的实体数**，不是行数", async () => {
    const { critic, seg } = criticFor(noisyRows());
    const names = ["采购计划", "采购申请", "采购订单", "发运", "验收", "执行偏差", "节点进度自动同步"];
    const draft = { objects: names.map((n) => ({ api_name: n, display_name: n })), properties: [], links: [], actions: [] };
    const verdict = await critic.judge(draft, { nodeId: `EXTRACT.${seg.key}` } as never);
    // 该抽的都抽到了 —— 不许再报「漏了 N 行」把模型逼去编
    expect(verdict.findings.find((f) => f.code === "ROWS_DROPPED")).toBeUndefined();
  });

  it("真漏了照样报 —— 这道闸不是被关掉了", async () => {
    const { critic, seg } = criticFor(noisyRows());
    const names = ["采购计划", "发运"];   // 只抽了 2 个，真漏
    const draft = { objects: names.map((n) => ({ api_name: n, display_name: n })), properties: [], links: [], actions: [] };
    const verdict = await critic.judge(draft, { nodeId: `EXTRACT.${seg.key}` } as never);
    const dropped = verdict.findings.find((f) => f.code === "ROWS_DROPPED");
    expect(dropped).toBeDefined();
    expect(dropped!.claim).toContain("采购申请");
  });

  it("全部抽到（含包含式命名差异）→ 不报", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      L1数据域: "采购管理",
      L2数据子域: i < 5 ? "主数据" : "执行",
      L3业务对象: `对象甲乙${i}`,
      业务对象定义: "定义文本相当长，超过三十个字符以确保该列被识别成散文说明列而不是名称",
      目前实现系统: i % 2 ? "SAP" : "ECP",
    }));
    const doc = { chunks: rows.map((r, i) => ({
      chunk_id: `c${i}`, file_id: "f1", file_name: "清单.xlsx",
      locator: { kind: "cell", sheet: "S", row: i + 2 }, render: JSON.stringify(r),
      raw: r, order: i, tags: ["row"], context: "",
    })) };
    const index = new EvidenceIndex();
    for (const c of doc.chunks) {
      index.add(new EvChunk({
        chunkId: c.chunk_id, fileId: c.file_id, fileName: c.file_name,
        locator: c.locator as Record<string, unknown>, render: c.render,
        raw: c.raw, order: c.order, tags: c.tags, context: c.context,
      }));
    }
    const segs = segmentCorpus(index, [doc as unknown as SegmentDoc]);
    const seg = segs[0]!;
    const critic = new CoverageCritic([seg], index);
    const draft = { objects: rows.map((r, i) => ({
      api_name: `obj${i}`, display_name: `${r["L3业务对象"]}（补充）`,
    })), properties: [], links: [], actions: [] };
    const verdict = await critic.judge(draft, { nodeId: `EXTRACT.${seg.key}` } as never);
    expect(verdict.findings.filter((f) => f.code === "ROWS_DROPPED")).toEqual([]);
  });
});
