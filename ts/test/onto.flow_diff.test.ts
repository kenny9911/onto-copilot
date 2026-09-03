/**
 * 参考图 ↔ 实证图 diff（第 1 层收官件）。
 *
 * flow_sketch 的价值主张是「拿去跟业务方对，让他指着说我们这儿不是这样」
 * （flow_sketch.ts:5-9）—— 但材料跑出实证图之后，一直没有任何工具能把两张图
 * 叠起来。这份差异清单本身就是下一场访谈的提纲：
 *  · 仅参考图有 —— 通识里有、材料里没证据：是材料缺了，还是贵司流程里没有？
 *  · 仅实证图有 —— 客户特色环节，值得确认用途；
 *  · 名字相近 —— 疑似同一环节、叫法不同（口径对齐的素材）；
 *  · 顺序差异 —— 两边都有的环节之间，衔接方向对不上。
 *
 * 两张图的 rid 体系完全不同（sketch 自造、实证按材料编号），匹配只能靠**名字**：
 * 先精确匹配（归一化空白），剩下的按 SequenceMatcher 相似度贪心配对 ——
 * 全部确定性，阈值写在结果里，不神秘。
 */
import { describe, expect, it } from "vitest";

import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  makeFlowEdge,
  makeFlowNode,
} from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";
import { diffFlowGraphs } from "../src/onto/flow_diff.js";

function graph(
  nodes: [string, NodeKind, string][],
  edges: [string, string][],
): FlowGraph {
  const g = new FlowGraph();
  for (const [rid, kind, label] of nodes) {
    g.nodes.set(rid, makeFlowNode({ rid, kind, label: inferred(label) }));
  }
  edges.forEach(([s, t], i) => {
    g.edges.set(`E${i}`, makeFlowEdge({ rid: `E${i}`, source: s, target: t, kind: EdgeKind.FLOW }));
  });
  return g;
}

/** 参考图：需求提报 → 审批(action) → 供应商审核 */
function sketchSide(): FlowGraph {
  return graph(
    [
      ["A1", NodeKind.ACTION, "需求提报"],
      ["B1", NodeKind.ACTION, "审批"],
      ["C1", NodeKind.ACTION, "供应商审核"],
    ],
    [["A1", "B1"], ["B1", "C1"]],
  );
}

/** 实证图：提交采购申请 → 审批(gateway)，供应商审批 → 审批 */
function realSide(): FlowGraph {
  return graph(
    [
      ["B2", NodeKind.GATEWAY, "审批"],
      ["C2", NodeKind.ACTION, "供应商审批"],
      ["D2", NodeKind.ACTION, "提交采购申请"],
    ],
    [["D2", "B2"], ["C2", "B2"]],
  );
}

describe("diffFlowGraphs", () => {
  it("四类差异各归各位：精确配对、相近配对、两侧独有", () => {
    const d = diffFlowGraphs(sketchSide(), realSide());
    expect(d.matched).toHaveLength(2);
    const exact = d.matched.find((m) => m.exact)!;
    expect(exact.left).toBe("审批");
    expect(exact.right).toBe("审批");
    // 同名不同类型：参考图当普通动作画的，材料里是分叉点 —— 要点名
    expect(exact.kindDiff).toEqual({ left: NodeKind.ACTION, right: NodeKind.GATEWAY });
    const fuzzy = d.matched.find((m) => !m.exact)!;
    expect(fuzzy.left).toBe("供应商审核");
    expect(fuzzy.right).toBe("供应商审批");
    expect(fuzzy.similarity).toBeCloseTo(0.8, 5);
    expect(d.leftOnly).toEqual(["需求提报"]);
    expect(d.rightOnly).toEqual(["提交采购申请"]);
  });

  it("顺序差异只在配对成功的子图上比：方向反了要两边各记一条", () => {
    const d = diffFlowGraphs(sketchSide(), realSide());
    // 参考图 审批→供应商审核；实证图是 供应商审批→审批（方向相反）
    expect(d.edgeOnlyLeft).toEqual([{ from: "审批", to: "供应商审核", label: "" }]);
    expect(d.edgeOnlyRight).toEqual([{ from: "供应商审批", to: "审批", label: "" }]);
  });

  it("相似度阈值可调：抬高阈值后相近对拆成两侧独有", () => {
    const d = diffFlowGraphs(sketchSide(), realSide(), { simThreshold: 0.9 });
    expect(d.matched).toHaveLength(1);
    expect(d.leftOnly).toContain("供应商审核");
    expect(d.rightOnly).toContain("供应商审批");
  });

  it("空图不炸：一边为空时全进另一边的独有清单", () => {
    const d = diffFlowGraphs(new FlowGraph(), realSide());
    expect(d.matched).toEqual([]);
    expect(d.leftOnly).toEqual([]);
    expect(d.rightOnly).toEqual(["审批", "供应商审批", "提交采购申请"]);
  });

  it("同名多个节点按插入序贪心配对，不重复占用", () => {
    const left = graph(
      [["a1", NodeKind.ACTION, "审批"], ["a2", NodeKind.ACTION, "审批"]],
      [],
    );
    const right = graph([["b1", NodeKind.ACTION, "审批"]], []);
    const d = diffFlowGraphs(left, right);
    expect(d.matched).toHaveLength(1);
    expect(d.leftOnly).toEqual(["审批"]);
  });
});
