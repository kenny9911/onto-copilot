/**
 * flow / flow_link / flow_bpmn 的 golden 校验。
 *
 * 三份 golden：
 *   - `golden/pipeline.flow.json` —— 真材料（材料.xlsx）跑出来的那张流程图；
 *   - `golden/pipeline.oir.json`  —— 同一份材料的 OIR（7 对象 / 6 行动）；
 *   - `golden/flow.json`          —— 由 `tools/golden/flow.py` 导出，把上面两份
 *     当输入端到端跑一遍（还原 → 体检 → 主干 → 挂接口 → 缺口 → 接口视角建图），
 *     再补上真材料没覆盖到的形态：网关/终态/外部节点、编号撞号、BPMN 泳道与
 *     悬空引用、只有接口清单时的建图。
 *
 * 期望值一律来自 golden，不手写 —— 手写的是我对 Python 行为的猜测。少数几条
 * 断言是 TS 侧独有的风险（Map 的插入序、code point 切片、浅拷贝语义），
 * 它们在 Python 侧无从表达，单独标注。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  codeFor,
  domainCode,
  edgeGrounded,
  flowFromDict,
  makeFlowNode,
  nodeGrounded,
  parseEdgeKind,
  parseNodeKind,
  type FlowNode,
} from "../src/onto/flow.js";
import { flowFromBpmnDocs, type BpmnDocLike } from "../src/onto/flow_bpmn.js";
import {
  attachEndpoints,
  canonicalVerb,
  coverageGaps,
  flowFromActions,
  linkReportSummary,
  subjectOf,
  type Gap,
  type LinkReport,
} from "../src/onto/flow_link.js";
import {
  extracted,
  inferred,
  makeProvenance,
  oirFromDict,
  provToDict,
  type OIR,
  type Provenance,
} from "../src/onto/oir.js";

type Dict = Record<string, unknown>;

const readGolden = (name: string): Dict =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as Dict;

const G = readGolden("flow.json");
const PIPELINE_FLOW = readGolden("pipeline.flow.json");
const PIPELINE_OIR = readGolden("pipeline.oir.json");

const sec = (k: string): Dict => G[k] as Dict;

// ══════════════════════════════════════════════════════════════════
//  驱动：与 tools/golden/flow.py 里的 _build / _Doc 一一对应
// ══════════════════════════════════════════════════════════════════

const KINDS: Record<string, NodeKind> = {
  action: NodeKind.ACTION,
  event: NodeKind.EVENT,
  gateway: NodeKind.GATEWAY,
  terminal: NodeKind.TERMINAL,
  external: NodeKind.EXTERNAL,
};

function provOf(d: Dict): Provenance {
  return makeProvenance(
    d["file_id"] as string,
    d["file_name"] as string,
    d["locator"] as Dict,
    {
      snippet: d["snippet"] as string,
      extractor: d["extractor"] as string,
      confidence: d["confidence"] as number,
    },
  );
}

interface NodeSpec {
  rid: string;
  kind: string;
  label: string;
  stage: string;
  grounded: boolean;
  objects?: string[];
}
type EdgeSpec = [string, string, string, string, boolean];

function buildGraph(spec: Dict, prov: Provenance): FlowGraph {
  const g = new FlowGraph();
  for (const n of spec["nodes"] as NodeSpec[]) {
    const label = n.grounded ? extracted(n.label, prov) : inferred(n.label);
    g.addNode(
      makeFlowNode({
        rid: n.rid,
        kind: KINDS[n.kind] as NodeKind,
        label,
        stage: n.stage,
        objects: [...(n.objects ?? [])],
      }),
    );
  }
  for (const [src, dst, kind, label, grounded] of spec["edges"] as EdgeSpec[]) {
    g.connect(src, dst, {
      kind: parseEdgeKind(kind),
      label,
      evidence: grounded ? [prov] : [],
    });
  }
  return g;
}

function health(g: FlowGraph): Dict {
  const rids = (ns: FlowNode[]): string[] => ns.map((n) => n.rid);
  const byStage: Dict = {};
  for (const [k, v] of g.byStage()) byStage[k] = rids(v);
  const outEdges: Dict = {};
  const inEdges: Dict = {};
  const codes: Dict = {};
  for (const [rid, n] of g.nodes) {
    outEdges[rid] = g.outEdges(rid).map((e) => e.rid);
    inEdges[rid] = g.inEdges(rid).map((e) => e.rid);
    codes[rid] = n.code;
  }
  return {
    dangling: rids(g.dangling()),
    dead_ends: rids(g.deadEnds()),
    unlabeled_branches: rids(g.unlabeledBranches()),
    actions_without_events: rids(g.actionsWithoutEvents()),
    by_stage: byStage,
    out_edges: outEdges,
    in_edges: inEdges,
    codes,
  };
}

/** LinkReport → golden 里那个 JSON 形状。 */
function reportDict(r: LinkReport): Dict {
  return {
    matched: Object.fromEntries(r.matched),
    unmatched_nodes: r.unmatchedNodes.map((t) => [...t]),
    unresolved_nodes: r.unresolvedNodes.map((t) => [...t]),
    used_actions: [...r.usedActions].sort(),
    summary: linkReportSummary(r),
  };
}

function gapDict(gp: Gap): Dict {
  return {
    text: gp.text,
    group: gp.group,
    kind: gp.kind,
    weight: gp.weight,
    options: gp.options,
    applies_to: gp.appliesTo,
    prov: gp.prov === null ? null : provToDict(gp.prov),
  };
}

// ══════════════════════════════════════════════════════════════════
//  1. 编号
// ══════════════════════════════════════════════════════════════════
describe("编号 —— 规则生成，不让模型编", () => {
  it("domainCode 逐条对上 golden（顺序即优先级）", () => {
    for (const [text, want] of G["domain_code"] as Array<[string, string]>) {
      expect([text, domainCode(text)]).toEqual([text, want]);
    }
  });

  it("codeFor 覆盖动词/事件/哈希兜底/撞号", () => {
    for (const c of G["code_for"] as Array<Dict>) {
      const got = codeFor(KINDS[c["kind"] as string] as NodeKind, c["label"] as string, {
        stageHint: c["stage_hint"] as string,
        taken: new Set(c["taken"] as string[]),
      });
      expect([c["label"], c["taken"], got]).toEqual([c["label"], c["taken"], c["out"]]);
    }
  });

  it("taken 省略时不查集合，直接给基础编号", () => {
    expect(codeFor(NodeKind.ACTION, "编制集采计划")).toBe(G["code_for_taken_none"]);
  });

  it("哈希兜底是内容哈希 —— 同一个标签两次必须同号", () => {
    // Python 的 hash() 带进程随机盐，用它两版图的 diff 会全红。这条是 TS 侧
    // 的回归护栏：同进程内两次调用相同不足以证明，但换标签必须换号。
    const a = codeFor(NodeKind.EVENT, "一段没有状态词的说明");
    const b = codeFor(NodeKind.EVENT, "一段没有状态词的说明");
    const c = codeFor(NodeKind.EVENT, "另一段没有状态词的说明");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("parseNodeKind / parseEdgeKind 对未知值抛错，不静默断言", () => {
    expect(parseNodeKind("action")).toBe(NodeKind.ACTION);
    expect(parseEdgeKind("cond")).toBe(EdgeKind.CONDITIONAL);
    expect(() => parseNodeKind("nope")).toThrow(RangeError);
    expect(() => parseEdgeKind("nope")).toThrow(RangeError);
    expect(() => parseNodeKind(null)).toThrow(RangeError);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 动词归一 / 宿主提取
// ══════════════════════════════════════════════════════════════════
describe("动词归一 —— 接错比不接糟得多", () => {
  it("canonicalVerb 逐条对上 golden", () => {
    for (const [text, want] of G["canonical_verb"] as Array<[string, string]>) {
      expect([text, canonicalVerb(text)]).toEqual([text, want]);
    }
  });

  it("subjectOf 逐条对上 golden", () => {
    for (const [text, want] of G["subject"] as Array<[string, string]>) {
      expect([text, subjectOf(text)]).toEqual([text, want]);
    }
  });

  it("英文只看驼峰第一段 —— queryPoApproveHistory 是查询不是审批", () => {
    // golden 里已经钉了，这里单独留一条：这是最容易被"顺手优化"成全串扫描的
    // 一处，扫全串会把查审批历史的接口挂到审批环节上。
    expect(canonicalVerb("queryPoApproveHistory")).toBe("QUERY");
    expect(canonicalVerb("approvePbp")).toBe("APPROVE");
  });

  it("非字符串输入走 Python 的 `str(x or \"\")`", () => {
    expect(canonicalVerb(null)).toBe("");
    expect(canonicalVerb(undefined)).toBe("");
    expect(canonicalVerb(0)).toBe("");
    expect(canonicalVerb(false)).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. 合成图：构建 / 体检 / 主干
// ══════════════════════════════════════════════════════════════════
describe("图的构建与体检", () => {
  const build = sec("build");
  const prov = provOf(build["prov"] as Dict);
  const spec = build["spec"] as Dict;

  it("add_node / connect 的产物逐字段对上 golden", () => {
    expect(buildGraph(spec, prov).toDict()).toEqual(build["graph"]);
  });

  it("体检四件套 + 泳道分组 + 编号对上 golden", () => {
    expect(health(buildGraph(spec, prov))).toEqual(build["health"]);
  });

  it("mainPath 砍掉推断边与只连推断边的节点", () => {
    expect(buildGraph(spec, prov).mainPath().toDict()).toEqual(build["main_path"]);
  });

  it("mainPath 返回新图，不动原图", () => {
    // TS 侧独有的风险：Map 是引用类型，写成 `sub.nodes = this.nodes` 会让
    // "完整图仍然可查"这个承诺当场失效。
    const g = buildGraph(spec, prov);
    const before = g.toDict();
    const sub = g.mainPath();
    sub.nodes.delete([...sub.nodes.keys()][0] as string);
    sub.stages.clear();
    expect(g.toDict()).toEqual(before);
  });

  it("同名节点撞号后拿到 -2 后缀", () => {
    const g = buildGraph(spec, prov);
    const codes = [...g.nodes.values()].map((n) => n.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("edgeToDict 只印前三条证据", () => {
    // Python 是 `self.evidence[:3]`，产物是给人看的，第四条之后没人翻。
    const g = new FlowGraph();
    g.connect("a", "b", { evidence: [prov, prov, prov, prov] });
    const [e] = g.toDict()["edges"] as Dict[];
    expect((e?.["evidence"] as unknown[]).length).toBe(3);
    expect(e?.["grounded"]).toBe(true);
  });

  it("connect 的 rid 由 (from, to, label) 决定 —— 同一条边两次是同一个 rid", () => {
    const g = new FlowGraph();
    const a = g.connect("x", "y", { label: "通过" });
    const b = g.connect("x", "y", { label: "通过" });
    const c = g.connect("x", "y", { label: "驳回" });
    expect(a.rid).toBe(b.rid);
    expect(a.rid).not.toBe(c.rid);
    expect(g.edges.size).toBe(2);
  });

  it("nodeGrounded / edgeGrounded 看的是有没有证据", () => {
    const g = buildGraph(spec, prov);
    const n1 = g.nodes.get("n1") as FlowNode;
    const n7 = g.nodes.get("n7") as FlowNode;
    expect(nodeGrounded(n1)).toBe(true);
    expect(nodeGrounded(n7)).toBe(false);
    expect(g.outEdges("n1").every(edgeGrounded)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. flowFromDict
// ══════════════════════════════════════════════════════════════════
describe("flowFromDict —— 重启之后要还原得回来", () => {
  it("脏输入逐例对上 golden", () => {
    for (const c of G["from_dict"] as Dict[]) {
      const got = flowFromDict(c["data"] as Dict).toDict();
      expect([c["name"], got]).toEqual([c["name"], c["out"]]);
    }
  });

  it("status 现在存得住 —— A10 修复：评审状态是 set_node_status/删除守卫的地基", () => {
    // 原本「照实迁」自 Python（to_dict 印、from_dict 不读，一次往返归零）。
    // Python 侧已退役，这个死字段挡住了流程侧的 rejected 软删路径，故有意翻转。
    const g = flowFromDict({
      nodes: [{ rid: "a", kind: "action", label: { value: "x" }, status: "confirmed" }],
    });
    expect((g.nodes.get("a") as FlowNode).status).toBe("confirmed");
    // 没写 status 的老数据照旧落 candidate
    const g2 = flowFromDict({ nodes: [{ rid: "b", kind: "action", label: { value: "y" } }] });
    expect((g2.nodes.get("b") as FlowNode).status).toBe("candidate");
  });

  it("缺 rid / 缺 kind 当场炸，不静默丢行", () => {
    expect(() => flowFromDict({ nodes: [{ kind: "action" }] })).toThrow(/KeyError/);
    expect(() => flowFromDict({ nodes: [{ rid: "a" }] })).toThrow(/KeyError/);
    expect(() => flowFromDict({ edges: [{ from: "a", to: "b", kind: "flow" }] })).toThrow(
      /KeyError/,
    );
    expect(() => flowFromDict({ stages: [{ title: "x" }] })).toThrow(/KeyError/);
    expect(() => flowFromDict({ workflows: [{ title: "x" }] })).toThrow(/KeyError/);
  });

  it("evidence 里混进非对象当场炸，不凭空捏造出处", () => {
    expect(() =>
      flowFromDict({
        nodes: [{ rid: "a", kind: "action", label: { value: "x", evidence: ["不是对象"] } }],
      }),
    ).toThrow(TypeError);
  });

  it("order 不是整数字面量时抛错，不静默变 NaN", () => {
    // NaN 的 order 会让泳道排序变成实现细节 —— 两次运行的泳道顺序可能不同。
    expect(() => flowFromDict({ stages: [{ key: "s", order: "三" }] })).toThrow();
    expect(() => flowFromDict({ stages: [{ key: "s", order: null }] })).toThrow();
    const g = flowFromDict({ stages: [{ key: "s", order: "7" }] });
    expect(g.stages.get("s")?.order).toBe(7);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. 真材料端到端
// ══════════════════════════════════════════════════════════════════
describe("真材料（材料.xlsx）跑出来的那张图", () => {
  const P = sec("pipeline");

  it("还原 → 再序列化，与 golden 逐字段相等", () => {
    expect(flowFromDict(PIPELINE_FLOW).toDict()).toEqual(P["roundtrip"]);
  });

  it("体检结果对上 golden", () => {
    expect(health(flowFromDict(PIPELINE_FLOW))).toEqual(P["health"]);
  });

  it("主干视图对上 golden", () => {
    expect(flowFromDict(PIPELINE_FLOW).mainPath().toDict()).toEqual(P["main_path"]);
  });

  it("attachEndpoints：接上的接口、缺口、就地改完的图都对上 golden", () => {
    const oir = oirFromDict(PIPELINE_OIR);
    const g = flowFromDict(PIPELINE_FLOW);
    const report = attachEndpoints(g, oir);
    const want = P["attach"] as Dict;
    expect(reportDict(report)).toEqual({
      matched: want["matched"],
      unmatched_nodes: want["unmatched_nodes"],
      unresolved_nodes: want["unresolved_nodes"],
      used_actions: want["used_actions"],
      summary: want["summary"],
    });
    expect(g.toDict()).toEqual(want["graph"]);
  });

  it("coverageGaps：两类缺口的措辞一个字都不能漂", () => {
    const oir = oirFromDict(PIPELINE_OIR);
    const g = flowFromDict(PIPELINE_FLOW);
    const report = attachEndpoints(g, oir);
    expect(coverageGaps(report, oir).map(gapDict)).toEqual(P["gaps"]);
  });

  it("maxPerNode=1 只标第一个接口", () => {
    const oir = oirFromDict(PIPELINE_OIR);
    const g = flowFromDict(PIPELINE_FLOW);
    const report = attachEndpoints(g, oir, { maxPerNode: 1 });
    const endpoints: Dict = {};
    for (const [rid, n] of g.nodes) endpoints[rid] = n.endpoint;
    expect({
      matched: Object.fromEntries(report.matched),
      endpoints,
    }).toEqual(P["attach_max1"]);
  });

  it("perKind=1 时补一条「另有 N 个」的兜底问题", () => {
    const oir = oirFromDict(PIPELINE_OIR);
    const g = flowFromDict(PIPELINE_FLOW);
    const report = attachEndpoints(g, oir, { maxPerNode: 1 });
    expect(coverageGaps(report, oir, { perKind: 1 }).map(gapDict)).toEqual(
      P["gaps_per_kind_1"],
    );
  });

  it("flowFromActions 在真材料上的产物对上 golden", () => {
    const oir = oirFromDict(PIPELINE_OIR);
    expect(flowFromActions(oir, { fileName: "材料.xlsx" }).toDict()).toEqual(
      P["flow_from_actions"],
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. attachEndpoints 的分支覆盖
// ══════════════════════════════════════════════════════════════════
describe("从 action 反推：宿主与动词两级都要命中", () => {
  const L = sec("link");
  const buildLink = (): { oir: OIR; g: FlowGraph } => ({
    oir: oirFromDict(L["oir"] as Dict),
    g: buildGraph(L["spec"] as Dict, provOf((sec("build"))["prov"] as Dict)),
  });

  it("精确 / 别名 / 唯一包含 / 歧义 / 有宿主没动词，五条路都对上 golden", () => {
    const { oir, g } = buildLink();
    const report = attachEndpoints(g, oir);
    expect(reportDict(report)).toEqual({
      matched: L["matched"],
      unmatched_nodes: L["unmatched_nodes"],
      unresolved_nodes: L["unresolved_nodes"],
      used_actions: L["used_actions"],
      summary: L["summary"],
    });
    expect(g.toDict()).toEqual(L["graph"]);
  });

  it("同一环节多个接口用 U+3000 连接并截断到 maxPerNode", () => {
    const { oir, g } = buildLink();
    attachEndpoints(g, oir);
    const ep = (g.nodes.get("L1") as FlowNode).endpoint;
    expect(ep.split("　").length).toBe(3);
    expect(ep).toContain("　");
  });

  it("maxPerNode=1 的接口与 objects 都对上 golden", () => {
    const { oir, g } = buildLink();
    const report = attachEndpoints(g, oir, { maxPerNode: 1 });
    const endpoints: Dict = {};
    const objects: Dict = {};
    for (const [rid, n] of g.nodes) {
      endpoints[rid] = n.endpoint;
      objects[rid] = n.objects;
    }
    expect({
      matched: Object.fromEntries(report.matched),
      endpoints,
      objects,
    }).toEqual(L["max1"]);
  });

  it("缺口问题里出现的是中文动词，不是内部动词码", () => {
    const { oir, g } = buildLink();
    const report = attachEndpoints(g, oir);
    const gaps = coverageGaps(report, oir);
    expect(gaps.map(gapDict)).toEqual(L["gaps"]);
    for (const gp of gaps) {
      expect(gp.text).not.toMatch(/CREATE|CANCEL|APPROVE|QUERY/);
    }
  });

  it("非 ACTION 节点一律不碰", () => {
    const { oir, g } = buildLink();
    attachEndpoints(g, oir);
    const evt = g.nodes.get("L8") as FlowNode;
    expect(evt.endpoint).toBe("");
    expect(evt.objects).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. 接口视角建图
// ══════════════════════════════════════════════════════════════════
describe("只有接口清单时的草图", () => {
  const S = sec("synth");
  const synthOir = (): OIR => oirFromDict(G["synth_oir"] as Dict);

  it("泳道、生命周期顺序、推断边全部对上 golden", () => {
    expect(flowFromActions(synthOir(), { fileName: "接口清单.xlsx" }).toDict()).toEqual(
      S["flow_from_actions"],
    );
  });

  it("maxLanes 截断发生在「泳道够不够格」之前", () => {
    expect(
      flowFromActions(synthOir(), { fileName: "接口清单.xlsx", maxLanes: 1 }).toDict(),
    ).toEqual(S["flow_from_actions_max_lanes_1"]);
  });

  it("边一律是推断的（虚线）—— 顺序是猜的就必须看得出来", () => {
    const g = flowFromActions(synthOir(), { fileName: "接口清单.xlsx" });
    const ordering = [...g.edges.values()].filter((e) => e.kind === EdgeKind.INFERRED);
    expect(ordering.length).toBeGreaterThan(0);
    for (const e of ordering) {
      expect(edgeGrounded(e)).toBe(false);
      expect(e.label).toBe("推断顺序");
    }
    // ACTION → EVENT 那条相反：它直接来自接口清单里的一行，有出处。
    for (const e of [...g.edges.values()].filter((x) => x.kind === EdgeKind.FLOW)) {
      expect(edgeGrounded(e)).toBe(true);
    }
  });

  it("查询接口不进图", () => {
    const g = flowFromActions(synthOir(), { fileName: "接口清单.xlsx" });
    for (const n of g.nodes.values()) {
      expect(n.label.value).not.toContain("查询");
    }
  });

  it("在草图上再挂一次接口 + 缺口，都对上 golden", () => {
    const oir = synthOir();
    const g = flowFromActions(oir, { fileName: "接口清单.xlsx" });
    const report = attachEndpoints(g, oir);
    const want = S["attach"] as Dict;
    expect(reportDict(report)).toEqual({
      matched: want["matched"],
      unmatched_nodes: want["unmatched_nodes"],
      unresolved_nodes: want["unresolved_nodes"],
      used_actions: want["used_actions"],
      summary: want["summary"],
    });
    expect(g.toDict()).toEqual(want["graph"]);
    expect(coverageGaps(report, oir).map(gapDict)).toEqual(S["gaps"]);
    expect(coverageGaps(report, oir, { perKind: 2 }).map(gapDict)).toEqual(
      S["gaps_per_kind_2"],
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  8. BPMN
// ══════════════════════════════════════════════════════════════════
describe("BPMN 无损搬运", () => {
  const B = sec("bpmn");
  const docs = (): BpmnDocLike[] => B["docs"] as unknown as BpmnDocLike[];

  it("泳道、网关、终态、悬空引用全部对上 golden", () => {
    const g = flowFromBpmnDocs(docs());
    expect(g).not.toBeNull();
    expect((g as FlowGraph).toDict()).toEqual(B["graph"]);
  });

  it("体检结果（含自动生成的编号）对上 golden", () => {
    expect(health(flowFromBpmnDocs(docs()) as FlowGraph)).toEqual(B["health"]);
  });

  it("没有 BPMN 文档 / 没有节点时返回 null", () => {
    // golden 里钉的是 Python 侧同样两次返回 None。
    expect([G["bpmn_none"], G["bpmn_empty_structured"]]).toEqual([true, true]);
    expect(flowFromBpmnDocs([])).toBeNull();
    expect(flowFromBpmnDocs([docs()[0] as BpmnDocLike])).toBeNull();
    expect(flowFromBpmnDocs([docs()[1] as BpmnDocLike])).toBeNull();
  });

  it("显式写了 lanes: null 的节点当场炸 —— 照实迁那处缺兜底", () => {
    const bad = sec("bpmn_raises");
    expect(() => flowFromBpmnDocs(bad["docs"] as unknown as BpmnDocLike[])).toThrow(
      TypeError,
    );
    expect(bad["error"]).toBe("TypeError");
  });

  it("sequenceFlow 指向不存在的节点时跳过，不伪造节点", () => {
    const g = flowFromBpmnDocs(docs()) as FlowGraph;
    for (const e of g.edges.values()) {
      expect(g.nodes.has(e.source)).toBe(true);
      expect(g.nodes.has(e.target)).toBe(true);
    }
  });

  it("每条边都带 XML 出处 —— 点回原文是这个模块存在的理由", () => {
    const g = flowFromBpmnDocs(docs()) as FlowGraph;
    for (const e of g.edges.values()) {
      expect(edgeGrounded(e)).toBe(true);
      expect(e.evidence[0]?.locator["kind"]).toBe("xml");
      expect(e.evidence[0]?.extractor).toBe("bpmn");
    }
    for (const n of g.nodes.values()) expect(nodeGrounded(n)).toBe(true);
  });
});
