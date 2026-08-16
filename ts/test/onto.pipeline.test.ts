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

  it("CoverageCritic 在 LINKS 缺失时炸 KeyError（Python 侧同样炸，照迁不修）", async () => {
    const c = g.coverage_links_keyerror;
    const seg = new Segment({
      key: "s0", label: "两列标识符", fileName: "x.xlsx",
      chunkIds: c.rows.map((_r: unknown, i: number) => `c${i}`),
      shape: inferShape(c.rows),
    });
    expect(c.python_error).toBe("KeyError");
    await expect(
      new CoverageCritic([seg], null).judge(c.draft, makeCriticContext({ nodeId: "EXTRACT.s0" })),
    ).rejects.toThrow(/KeyError/);
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
