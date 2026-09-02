/**
 * 工作流画布的分层布局。
 *
 * 布局好不好看没法断言，但有两件事是可量化的，而且都是用户报的「太嘈杂」的
 * 直接来源：
 *
 *   1. **环上的节点不能被丢掉。** 老实现用 Kahn 拓扑排序定层，遇到环就停 ——
 *      而业务流程里「驳回 → 重新提交」是常态，环上的节点入度永远不为零，
 *      于是全被当成孤儿甩到画布底部的网格里，和主干断开。
 *   2. **边的交叉数。** 老实现让 stage（业务分组）决定纵坐标、层内按遭遇顺序摆，
 *      没有任何减少交叉的处理。新实现用重心法排序。
 */
import "./ui.env.js";

import { describe, expect, it } from "vitest";

import { graphRows } from "../src/ui/react/context-sidebar.js";

/** 造一份流程图。`edges` 是 [from, to] 对。 */
function flowOf(
  nodes: { id: string; kind?: string; stage?: string }[],
  edges: [string, string][],
): unknown {
  return {
    nodes: nodes.map((n) => ({
      rid: n.id, id: n.id, label: n.id, kind: n.kind ?? "action", stage: n.stage ?? "",
    })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, source: from, target: to, label: "" })),
  };
}

const render = (flow: unknown): { nodes: any[]; edges: any[] } =>
  graphRows(flow, {}, "workflow", [], null, 4) as never;

/** 两条直线段是否相交 —— 用来数边的交叉。 */
function crosses(a: any, b: any, at: Map<string, any>): boolean {
  const p1 = at.get(a.source), q1 = at.get(a.target);
  const p2 = at.get(b.source), q2 = at.get(b.target);
  if (!p1 || !q1 || !p2 || !q2) return false;
  if (new Set([a.source, a.target, b.source, b.target]).size < 4) return false;
  const d = (o: any, p: any, q: any) =>
    Math.sign((p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x));
  return d(p1, q1, p2) !== d(p1, q1, q2) && d(p2, q2, p1) !== d(p2, q2, q1);
}

function crossings(g: { nodes: any[]; edges: any[] }): number {
  const at = new Map(g.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  let n = 0;
  for (let i = 0; i < g.edges.length; i += 1) {
    for (let j = i + 1; j < g.edges.length; j += 1) {
      if (crosses(g.edges[i], g.edges[j], at)) n += 1;
    }
  }
  return n;
}

describe("分层：每个节点都有位置", () => {
  it("**带回路的流程，环上的节点不许被甩到孤儿区**", () => {
    // 提交 → 审批 → 驳回 → 改 → 回到提交。这是最常见的业务回路。
    const g = render(flowOf(
      [{ id: "提交" }, { id: "审批" }, { id: "驳回" }, { id: "修改" }, { id: "通过" }],
      [["提交", "审批"], ["审批", "驳回"], ["驳回", "修改"], ["修改", "提交"], ["审批", "通过"]],
    ));
    // 孤儿区在主体下方；环上的节点必须和主干在同一片区域，不能掉到最下面一排。
    const ys = new Map(g.nodes.map((n: any) => [n.id, n.y]));
    const main = Math.max(ys.get("提交")!, ys.get("审批")!);
    for (const id of ["驳回", "修改"]) {
      expect(ys.get(id)!, `${id} 在环上，不该被丢进孤儿区`).toBeLessThan(main + 400);
    }
  });

  it("流程沿横轴推进：后继节点的 x 严格大于前驱", () => {
    const g = render(flowOf(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [["A", "B"], ["B", "C"]],
    ));
    const x = new Map(g.nodes.map((n: any) => [n.id, n.x]));
    expect(x.get("A")!).toBeLessThan(x.get("B")!);
    expect(x.get("B")!).toBeLessThan(x.get("C")!);
  });

  it("同一层的节点 x 相同 —— 层是层，不是斜坡", () => {
    const g = render(flowOf(
      [{ id: "起" }, { id: "甲" }, { id: "乙" }, { id: "丙" }],
      [["起", "甲"], ["起", "乙"], ["起", "丙"]],
    ));
    const x = new Map(g.nodes.map((n: any) => [n.id, n.x]));
    expect(new Set([x.get("甲"), x.get("乙"), x.get("丙")]).size).toBe(1);
  });

  it("**stage 不再决定纵坐标** —— 它是业务分组，不是流程位置", () => {
    // 同一条链上的相邻两步分属不同 stage：老实现会把它们在纵向拉开一两百像素，
    // 边只能斜着长距离穿过去。现在它们该在同一条水平线附近。
    const g = render(flowOf(
      [{ id: "A", stage: "一" }, { id: "B", stage: "二" }, { id: "C", stage: "三" }],
      [["A", "B"], ["B", "C"]],
    ));
    const y = new Map(g.nodes.map((n: any) => [n.id, n.y]));
    expect(Math.abs(y.get("A")! - y.get("B")!)).toBeLessThan(10);
    expect(Math.abs(y.get("B")! - y.get("C")!)).toBeLessThan(10);
  });
});

describe("层内排序减少交叉", () => {
  it("**交叉的两条边会被理顺**", () => {
    // 故意把邻接写成交叉的顺序：A→D、B→C。若层内按遭遇顺序（A,B / C,D）摆，
    // 这两条边必然交叉；重心法应该把 C、D 换个位置。
    const g = render(flowOf(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [["A", "D"], ["B", "C"]],
    ));
    expect(crossings(g)).toBe(0);
  });

  it("多入多出的图里交叉数保持在低位", () => {
    const g = render(flowOf(
      [{ id: "s" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "x" }, { id: "y" }, { id: "z" }],
      [["s", "a"], ["s", "b"], ["s", "c"],
       ["a", "z"], ["b", "y"], ["c", "x"]],
    ));
    // 这张图理论上可以做到零交叉（把 x,y,z 按 c,b,a 的顺序摆）。
    expect(crossings(g)).toBe(0);
  });
});

describe("确定性", () => {
  it("同一份流程两次布局**逐坐标相同** —— 否则每次刷新画布都在跳", () => {
    const f = flowOf(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"]],
    );
    const a = render(f).nodes.map((n: any) => `${n.id}:${n.x}:${n.y}`);
    const b = render(f).nodes.map((n: any) => `${n.id}:${n.x}:${n.y}`);
    expect(a).toEqual(b);
  });

  it("一条边都没有的节点单独放在下方，不挤进流程层", () => {
    const g = render(flowOf(
      [{ id: "A" }, { id: "B" }, { id: "孤" }],
      [["A", "B"]],
    ));
    const y = new Map(g.nodes.map((n: any) => [n.id, n.y]));
    expect(y.get("孤")!).toBeGreaterThan(Math.max(y.get("A")!, y.get("B")!));
  });
});

describe("用户可切换的流程方向", () => {
  const directional = flowOf(
    [{ id: "申请" }, { id: "审批" }, { id: "补充审批" }, { id: "完成" }],
    [["申请", "审批"], ["申请", "补充审批"], ["审批", "完成"], ["补充审批", "完成"]],
  );

  it("TB：层级沿纵轴推进，同层并行节点横向展开", () => {
    const g = graphRows(directional, {}, "workflow", [], null, 4, "TB");
    const at = new Map(g.nodes.map((node: any) => [node.id, node]));
    expect(at.get("申请").y).toBeLessThan(at.get("审批").y);
    expect(at.get("审批").y).toBe(at.get("补充审批").y);
    expect(at.get("审批").x).not.toBe(at.get("补充审批").x);
    expect(at.get("审批").y).toBeLessThan(at.get("完成").y);
  });

  it("LR：层级沿横轴推进，同层并行节点纵向展开", () => {
    const g = graphRows(directional, {}, "workflow", [], null, 4, "LR");
    const at = new Map(g.nodes.map((node: any) => [node.id, node]));
    expect(at.get("申请").x).toBeLessThan(at.get("审批").x);
    expect(at.get("审批").x).toBe(at.get("补充审批").x);
    expect(at.get("审批").y).not.toBe(at.get("补充审批").y);
    expect(at.get("审批").x).toBeLessThan(at.get("完成").x);
  });

  it("切换方向只重排坐标，不改变 canonical 节点与边", () => {
    const topDown = graphRows(directional, {}, "workflow", [], null, 4, "TB");
    const leftRight = graphRows(directional, {}, "workflow", [], null, 4, "LR");
    expect(topDown.nodes.map((node) => node.id)).toEqual(leftRight.nodes.map((node) => node.id));
    expect(topDown.edges).toEqual(leftRight.edges);
  });
});
