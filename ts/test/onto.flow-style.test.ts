import { describe, expect, it } from "vitest";

import {
  paletteFor,
  resolveDiagramStyle,
  toSvg,
} from "../src/onto/diagram.js";
import { contrastRatio } from "../src/onto/flow_style.js";
import { flowFromDict, type FlowGraph } from "../src/onto/flow.js";

function sequential(labels: readonly string[] = ["提出申请", "检查资料", "审批申请", "完成归档"]): FlowGraph {
  return flowFromDict({
    stages: [{ key: "s1", title: "申请与审批" }],
    nodes: labels.map((label, index) => ({
      rid: `fn_${index}`,
      kind: index === labels.length - 1 ? "terminal" : "action",
      code: `N-${index}`,
      label: { value: label },
      stage: "s1",
    })),
    edges: labels.slice(1).map((_, index) => ({
      rid: `fe_${index}`,
      from: `fn_${index}`,
      to: `fn_${index + 1}`,
      kind: "flow",
      label: "",
    })),
  });
}

function branching(): FlowGraph {
  return flowFromDict({
    stages: [
      { key: "intake", title: "需求受理" },
      { key: "review", title: "并行评审" },
    ],
    nodes: [
      { rid: "start", kind: "action", label: { value: "提交采购申请" }, stage: "intake" },
      { rid: "gate", kind: "gateway", label: { value: "需要哪些评审" }, stage: "review" },
      { rid: "budget", kind: "action", label: { value: "预算评审" }, stage: "review" },
      { rid: "legal", kind: "action", label: { value: "法务评审" }, stage: "review" },
      { rid: "security", kind: "action", label: { value: "安全评审" }, stage: "review" },
      { rid: "done", kind: "terminal", label: { value: "评审完成" }, stage: "review" },
    ],
    edges: [
      { rid: "e0", from: "start", to: "gate", kind: "flow", label: "" },
      { rid: "e1", from: "gate", to: "budget", kind: "conditional", label: "涉及预算" },
      { rid: "e2", from: "gate", to: "legal", kind: "conditional", label: "涉及合同" },
      { rid: "e3", from: "gate", to: "security", kind: "conditional", label: "涉及数据" },
      { rid: "e4", from: "budget", to: "done", kind: "flow", label: "" },
      { rid: "e5", from: "legal", to: "done", kind: "flow", label: "" },
      { rid: "e6", from: "security", to: "done", kind: "flow", label: "" },
    ],
  });
}

describe("流程图 auto 视觉策略", () => {
  it("同一语义与标题跨调用稳定；语义变化会产生新的主题", () => {
    const graph = sequential();
    const first = resolveDiagramStyle(graph, { title: "采购审批" });
    const second = resolveDiagramStyle(graph, { title: "采购审批" });
    const renamed = resolveDiagramStyle(graph, { title: "费用审批" });

    expect(second).toEqual(first);
    expect(renamed.theme.id).not.toBe(first.theme.id);
    expect(renamed.palette.actionFill).not.toBe(first.palette.actionFill);
  });

  it("依据拓扑选择方向，并依据标签、分支与边密度调整尺寸和间距", () => {
    const straight = resolveDiagramStyle(sequential(), { title: "顺序流程" });
    const branched = resolveDiagramStyle(branching(), { title: "并行流程" });
    const longLabel = resolveDiagramStyle(
      sequential(["填写跨公司跨组织采购审批申请并补充全部附件", "审批", "完成"]),
      { title: "长标签流程" },
    );

    expect(straight.layout.direction).toBe("LR");
    expect(branched.layout.direction).toBe("TB");
    expect(branched.metrics.branchCount).toBe(1);
    expect(branched.layout.gapY).toBeGreaterThan(straight.layout.gapY);
    expect(longLabel.layout.nodeWidth).toBeGreaterThan(straight.layout.nodeWidth);
    expect(longLabel.layout.nodeHeight).toBeGreaterThanOrEqual(straight.layout.nodeHeight);
    expect(branched.layout.columns).toBe(branched.metrics.maxParallel);
    expect(branched.layout.density).toBe(Number(branched.metrics.edgeDensity.toFixed(3)));
  });

  it("语义色不是固定模板，并保证所有节点文字至少达到 WCAG AA 对比度", () => {
    const graph = branching();
    const style = resolveDiagramStyle(graph, { title: "采购审批" });
    const fills = [
      style.palette.actionFill,
      style.palette.eventFill,
      style.palette.gatewayFill,
      style.palette.terminalFill,
      style.palette.externalFill,
      style.palette.band,
    ];

    expect(style.theme.stageAccents).toHaveLength(2);
    expect(new Set(style.theme.stageAccents).size).toBe(2);
    expect(Math.min(...fills.map((fill) => contrastRatio(style.palette.ink, fill)))).toBeGreaterThanOrEqual(4.5);
    expect(style.theme.minimumTextContrast).toBeGreaterThanOrEqual(4.5);
  });

  it("paletteFor(auto) 作为标记传入后，toSvg 用真实图和标题复用同一份 style", () => {
    const graph = branching();
    const title = "通用采购审批";
    const style = resolveDiagramStyle(graph, { title });
    const svg = toSvg(graph, { title, palette: paletteFor("auto") });

    expect(svg).toContain(`data-style="${style.theme.id}"`);
    expect(svg).toContain(`data-layout-direction="${style.layout.direction}"`);
    expect(svg).toContain(`width="${style.layout.nodeWidth}"`);
    expect(svg).toContain(`fill="${style.palette.canvas}"`);
  });

  it("显式 classic 继续生成旧布局，不携带 auto 元数据", () => {
    const graph = sequential();
    const legacy = toSvg(graph, { palette: paletteFor("classic") });

    expect(legacy).toBe(toSvg(graph));
    expect(legacy).not.toContain("data-style=");
    expect(legacy).toContain('width="168"');
  });
});
