// @vitest-environment happy-dom
/**
 * 工作流画布的显式方向契约。
 *
 * 右栏可以很窄，但“左到右”不能因此退化成所有节点 x=44 的竖排；画布 world
 * 可以超出 viewport，由缩放和平移负责浏览。TB 同理必须严格沿 y 推进。
 */
import { describe, expect, it } from "vitest";

import {
  defaultCanvasLayout, graphRows, savedCanvasLayout,
} from "../src/ui/react/context-sidebar.js";

/** 造一条 n 步的线性流程（每步一个节点，前后相连）—— 最常见的业务流程形状。 */
function linearFlow(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    rid: `fn_${i}`,
    kind: i % 2 === 0 ? "action" : "event",
    code: `ACT-${i}`,
    stage: `s${Math.floor(i / 3) + 1}`,
    label: { value: `第${i + 1}步`, origin: "inferred", evidence: [], confidence: 0.4 },
    actor: { value: "", origin: "inferred", evidence: [], confidence: 0.4 },
    objects: [], endpoint: "", status: "candidate",
  }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    rid: `fe_${i}`, from: `fn_${i}`, to: `fn_${i + 1}`,
    kind: "flow", label: "", grounded: false, evidence: [],
  }));
  return { stages: [], workflows: [], nodes, edges, stats: {} };
}

function bbox(nodes: { x: number; y: number }[]) {
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  // 节点尺寸约 168×46（见 context-sidebar 的 NODE_ 常量）
  return {
    w: Math.max(...xs) - Math.min(...xs) + 168,
    h: Math.max(...ys) - Math.min(...ys) + 46,
    rows: new Set(ys).size,
    cols: new Set(xs).size,
  };
}

describe("graphRows 的布局形状", () => {
  it("LR 在窄栏仍严格横向推进，不按 columns 折回单列", () => {
    const g = graphRows(linearFlow(11), null, "workflow", [], null, 1, "LR");
    const xs = g.nodes.map((node) => node.x);
    expect(new Set(xs).size).toBe(11);
    expect(xs.slice(0, 6)).toEqual([...xs.slice(0, 6)].sort((a, b) => a - b));
    expect(bbox(g.nodes).rows).toBe(1);
  });

  it("LR 坐标不依赖 viewport 列数，窄栏只改变浏览方式", () => {
    const narrow = graphRows(linearFlow(11), null, "workflow", [], null, 1, "LR").nodes;
    const wide = graphRows(linearFlow(11), null, "workflow", [], null, 8, "LR").nodes;
    expect(narrow.map(({ x, y }) => [x, y])).toEqual(wide.map(({ x, y }) => [x, y]));
  });

  it("TB 严格纵向推进，主链前几步 y 单调增加", () => {
    const g = graphRows(linearFlow(11), null, "workflow", [], null, 1, "TB");
    const ys = g.nodes.map((node) => node.y);
    expect(new Set(ys).size).toBe(11);
    expect(ys.slice(0, 6)).toEqual([...ys.slice(0, 6)].sort((a, b) => a - b));
    expect(bbox(g.nodes).cols).toBe(1);
  });

  it("分叉结构不受影响：同层多个节点仍然并排在同一列", () => {
    const flow = linearFlow(3);
    // 再挂一个和第 2 步同层的分支
    flow.nodes.push({
      rid: "fn_branch", kind: "action", code: "ACT-B", stage: "s1",
      label: { value: "并行分支", origin: "inferred", evidence: [], confidence: 0.4 },
      actor: { value: "", origin: "inferred", evidence: [], confidence: 0.4 },
      objects: [], endpoint: "", status: "candidate",
    });
    flow.edges.push({
      rid: "fe_b", from: "fn_0", to: "fn_branch",
      kind: "flow", label: "", grounded: false, evidence: [],
    });

    const g = graphRows(flow, null, "workflow", [], null, 4);
    const branch = g.nodes.find((n) => n.label === "并行分支")!;
    const step2 = g.nodes.find((n) => n.label === "第2步")!;

    expect(branch.x, "同层应当同列").toBe(step2.x);
    expect(branch.y, "同层不同行").not.toBe(step2.y);
  });
});

/**
 * 默认排列方向 —— 用户实报「这个图像没有画出来」的**剩余**根因。
 *
 * LR 的语义是对的（严格横向推进，不折行 —— 折行会产生绕回的连线）。
 * 问题出在**默认值**：`savedCanvasLayout` 在没有保存偏好时一律回 "LR"，
 * 而右侧栏是窄而高的容器。实测那份 11 环节的真实流程：
 *
 *     LR → 包围盒 2308×46（50:1），侧栏适配只有 20%
 *     TB → 包围盒 168×1406（0.12:1），侧栏适配 55%
 *
 * 20% 意味着「全看见、全读不出」，而代码里 60% 的可读下限会把它钳住、
 * 只显示入口那一段 —— 症状就是一条细横带加一大片空白。
 *
 * 所以：**用户选过就永远听用户的**；没选过时按容器形状挑一个能看的默认。
 */
describe("默认排列方向", () => {
  it("窄高容器（侧栏）默认 TB —— 横条在这里读不出来", () => {
    expect(defaultCanvasLayout({ width: 500, height: 820 })).toBe("TB");
  });

  it("宽扁容器（全屏画布）默认 LR —— 流程本来就该从左往右读", () => {
    expect(defaultCanvasLayout({ width: 1400, height: 700 })).toBe("LR");
  });

  it("量不到尺寸时回 LR —— 与既有行为一致，不赌", () => {
    expect(defaultCanvasLayout({ width: 0, height: 0 })).toBe("LR");
  });

  it("★ 用户选过就听用户的 —— 默认值永远不该盖掉人的选择", () => {
    localStorage.setItem("oc_graph_layout:sess-1", "LR");
    // 即使是窄栏（默认会挑 TB），保存过的 LR 也必须赢
    expect(savedCanvasLayout("sess-1", { width: 500, height: 820 })).toBe("LR");
    localStorage.removeItem("oc_graph_layout:sess-1");
  });

  it("没选过时，savedCanvasLayout 用容器形状挑", () => {
    expect(savedCanvasLayout("sess-never", { width: 500, height: 820 })).toBe("TB");
  });
});
