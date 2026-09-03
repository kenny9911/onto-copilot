/**
 * 按执行者分泳道的渲染。
 *
 * `FlowNode.actor` 一路被收集、存储、要求模型填写、还被 critic 检查 ——
 * **两个 emitter 都不画它**。泳道图的数据早就齐了，只是从来没画过。
 *
 * 三条来自设计评审的约束：
 *
 * 1. **新函数、新产物**，`toSvg` 逐字节不动。那 28 张 golden SVG 记录的是
 *    Python 的输出，而生成器已经不在仓库里 —— 从 TS 侧重生成会把跨语言
 *    一致性测试改写成"TS 自证"。
 * 2. **actor 要清洗**：真实库 `fdaced8ca9df` 的 actor 带尾随换行
 *    （`"采购计划员\n"`），不 trim 会把同一个角色劈成两条道。
 * 3. **不进 structureDefects**：那是硬门禁，缺 actor 就拒绝出图会让每一张
 *    sketch 消失（event/gateway 天然没有 actor）。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";
import { toLaneSvg } from "../src/onto/diagram_lanes.js";

function g(nodes: [string, string, string][]): FlowGraph {
  const graph = new FlowGraph();
  for (const [rid, label, actor] of nodes) {
    graph.addNode(makeFlowNode({
      rid, kind: NodeKind.ACTION, label: inferred(label), actor: inferred(actor),
    }));
  }
  return graph;
}

describe("toLaneSvg", () => {
  it("每个执行者一条道，道上写他的名字", () => {
    const svg = toLaneSvg(g([
      ["fn_1", "提交申请", "采购员"],
      ["fn_2", "审批", "部门负责人"],
    ]));

    expect(svg).toContain("采购员");
    expect(svg).toContain("部门负责人");
  });

  it("★ actor 带尾随换行时不劈成两条道 —— 真实库里就是这样存的", () => {
    const svg = toLaneSvg(g([
      ["fn_1", "编制计划", "采购计划员\n"],
      ["fn_2", "复核计划", "采购计划员"],
    ]));

    // 同一个角色只出现一条道
    const lanes = svg.match(/class="lane-title"/gu) ?? [];
    expect(lanes).toHaveLength(1);
  });

  it("没有执行者的节点归入「未指定」道，不丢", () => {
    const svg = toLaneSvg(g([
      ["fn_1", "提交申请", "采购员"],
      ["fn_2", "系统自动校验", ""],
    ]));

    expect(svg).toContain("未指定");
    expect(svg).toContain("系统自动校验");
  });

  it("所有节点都没有执行者时给出可读的空态，不出一张只有一条道的假图", () => {
    const svg = toLaneSvg(g([["fn_1", "甲", ""], ["fn_2", "乙", ""]]));

    expect(svg).toMatch(/没有.*执行者|未标注执行者/u);
  });

  it("空图不抛", () => {
    expect(() => toLaneSvg(new FlowGraph())).not.toThrow();
  });

  it("出的是合法 SVG", () => {
    const svg = toLaneSvg(g([["fn_1", "提交申请", "采购员"]]));

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("节点标签会被转义 —— 材料里出现 < 不能把图打碎", () => {
    const svg = toLaneSvg(g([["fn_1", "金额 < 5万", "采购员"]]));

    expect(svg).toContain("&lt;");
    expect(svg).not.toContain("金额 < 5万");
  });
});
