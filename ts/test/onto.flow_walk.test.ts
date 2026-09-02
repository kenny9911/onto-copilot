/**
 * 流程走查（第 1 层工作坊套件）：业务方验证流程的方式不是看图，是**走场景**——
 * 「50 万以上的采购单走到哪一步会怎样？」「驳回之后回到哪里？」
 *
 * 此前只有静态体检（dangling / deadEnds / unlabeledBranches），动态能力为零：
 * 布局算法遇到环只是「剩下的全塞最后一层」且不报告；一个从入口走不到但内部连通
 * 的子图，dangling 查不出来。这里钉四件事：
 *  · 概览必须报出**连通分量**（图裂成几块）与**回退环**（驳回重编是常态，不是病灶）；
 *  · 路径枚举的截断必须**显式**（no silent caps —— 截了不说，读的人会当成全量）；
 *  · 单步走查在分叉处**停下来列选项**，不替业务方做决定；
 *  · 每条路径都说清有几跳是推断边（虚线）—— 没依据的路径不能当成材料事实转述。
 */
import { describe, expect, it } from "vitest";

import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  makeFlowEdge,
  makeFlowNode,
  makeStage,
} from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";
import {
  enumeratePaths,
  resolveFlowNode,
  traceFlow,
  walkOverview,
} from "../src/onto/flow_walk.js";

/**
 * 采购审批夹具：
 *
 *   提交请购单 → 请购单已提交 → [金额审批] ──通过──→ 生成采购订单 → 订单已生成(终)
 *                     │                └──驳回──→ 修改请购单 ──→ [金额审批]（回退环）
 *                     └──→ 抄送备案（断头：有入无出、非终态）
 *
 *   孤岛分量：归档 → 已归档（内部连通，但与主干不相连）
 */
function fixture(): FlowGraph {
  const g = new FlowGraph();
  g.stages.set("s1", makeStage({ key: "s1", title: "阶段一" }));
  const nodes = [
    makeFlowNode({ rid: "n.start", kind: NodeKind.ACTION, label: inferred("提交请购单"), stage: "s1", actor: inferred("申请人") }),
    makeFlowNode({ rid: "e.submitted", kind: NodeKind.EVENT, label: inferred("请购单已提交"), stage: "s1" }),
    makeFlowNode({ rid: "g.approve", kind: NodeKind.GATEWAY, label: inferred("金额审批"), stage: "s1" }),
    makeFlowNode({ rid: "n.po", kind: NodeKind.ACTION, label: inferred("生成采购订单"), stage: "s1" }),
    makeFlowNode({ rid: "t.done", kind: NodeKind.TERMINAL, label: inferred("订单已生成"), stage: "s1" }),
    makeFlowNode({ rid: "n.revise", kind: NodeKind.ACTION, label: inferred("修改请购单"), stage: "s1" }),
    makeFlowNode({ rid: "n.cc", kind: NodeKind.ACTION, label: inferred("抄送备案"), stage: "s1" }),
    makeFlowNode({ rid: "n.arch", kind: NodeKind.ACTION, label: inferred("归档"), stage: "s1" }),
    makeFlowNode({ rid: "e.arch", kind: NodeKind.EVENT, label: inferred("已归档"), stage: "s1" }),
  ];
  for (const n of nodes) g.nodes.set(n.rid, n);
  const edges = [
    makeFlowEdge({ rid: "E1", source: "n.start", target: "e.submitted" }),
    makeFlowEdge({ rid: "E2", source: "e.submitted", target: "g.approve" }),
    makeFlowEdge({ rid: "E3", source: "g.approve", target: "n.po", kind: EdgeKind.CONDITIONAL, label: "通过" }),
    makeFlowEdge({ rid: "E4", source: "n.po", target: "t.done" }),
    makeFlowEdge({ rid: "E5", source: "g.approve", target: "n.revise", kind: EdgeKind.CONDITIONAL, label: "驳回" }),
    makeFlowEdge({ rid: "E6", source: "n.revise", target: "g.approve" }),
    makeFlowEdge({ rid: "E7", source: "e.submitted", target: "n.cc" }),
    makeFlowEdge({ rid: "E8", source: "n.arch", target: "e.arch" }),
  ];
  for (const e of edges) g.edges.set(e.rid, e);
  return g;
}

describe("walkOverview —— 一眼看清图的骨架", () => {
  it("起点、终点、断头、连通分量、回退环、入口走不到的部分，各归各位", () => {
    const o = walkOverview(fixture());
    expect(o.entries).toEqual(["提交请购单", "归档"]);
    expect(o.entriesOnCycle).toBe(false);
    expect(o.terminals).toEqual(["订单已生成"]);
    expect(o.deadEnds).toContain("抄送备案");
    expect(o.components).toBe(2);
    // 回退环：金额审批 → 修改请购单 → 金额审批
    expect(o.cycles.length).toBe(1);
    expect(o.cycles[0]).toContain("金额审批");
    expect(o.cycles[0]).toContain("修改请购单");
    // 每个分量都有自己的入口 → 没有「从任何入口都走不到」的部分
    expect(o.unreachable).toEqual([]);
  });

  it("没有出口的死环要被报成 unreachable —— 那是一段永远走不进去的流程", () => {
    const g = new FlowGraph();
    for (const rid of ["a", "b"]) {
      g.nodes.set(rid, makeFlowNode({ rid, kind: NodeKind.ACTION, label: inferred(rid.toUpperCase()) }));
    }
    g.edges.set("E1", makeFlowEdge({ rid: "E1", source: "a", target: "b" }));
    g.edges.set("E2", makeFlowEdge({ rid: "E2", source: "b", target: "a" }));
    const o = walkOverview(g);
    expect(o.entries).toEqual([]);
    expect(o.unreachable.sort()).toEqual(["A", "B"]);
  });

  it("流程头部在回退环上（真实会话 424ef360 的形状）：起点退到环上入口，不误报走不进去", () => {
    // 提交 → 已提交 → 审批 ──驳回──→ 提交（头三步成环），审批 ──通过──→ 结束(终)
    // 没有入度 0 的节点，但整条流程显然能走 —— 起点该是环上的「提交」。
    const g = new FlowGraph();
    const ns = [
      makeFlowNode({ rid: "a", kind: NodeKind.ACTION, label: inferred("提交") }),
      makeFlowNode({ rid: "b", kind: NodeKind.EVENT, label: inferred("已提交") }),
      makeFlowNode({ rid: "c", kind: NodeKind.GATEWAY, label: inferred("审批") }),
      makeFlowNode({ rid: "t", kind: NodeKind.TERMINAL, label: inferred("结束") }),
    ];
    for (const n of ns) g.nodes.set(n.rid, n);
    const es = [
      makeFlowEdge({ rid: "E1", source: "a", target: "b" }),
      makeFlowEdge({ rid: "E2", source: "b", target: "c" }),
      makeFlowEdge({ rid: "E3", source: "c", target: "a", kind: EdgeKind.CONDITIONAL, label: "驳回" }),
      makeFlowEdge({ rid: "E4", source: "c", target: "t", kind: EdgeKind.CONDITIONAL, label: "通过" }),
    ];
    for (const e of es) g.edges.set(e.rid, e);
    const o = walkOverview(g);
    expect(o.entries).toEqual(["提交"]);
    expect(o.entriesOnCycle).toBe(true);
    expect(o.unreachable).toEqual([]);
    expect(o.terminals).toEqual(["结束"]);
  });
});

describe("enumeratePaths —— 从起点数清所有走法", () => {
  it("三条路径三种结局：走到终态 / 断头 / 回到走过的节点（环）", () => {
    const got = enumeratePaths(fixture(), "n.start");
    expect(got.truncated).toBe(false);
    const byEnd = new Map(got.paths.map((p) => [p.end, p.nodes.join("→")]));
    expect(byEnd.get("terminal")).toBe("提交请购单→请购单已提交→金额审批→生成采购订单→订单已生成");
    expect(byEnd.get("dead_end")).toBe("提交请购单→请购单已提交→抄送备案");
    expect(byEnd.get("loop_back")).toBe("提交请购单→请购单已提交→金额审批→修改请购单");
    expect(got.paths).toHaveLength(3);
  });

  it("截断必须显式 —— 上限 1 条时 truncated=true，不装作只有一条", () => {
    const got = enumeratePaths(fixture(), "n.start", { maxPaths: 1 });
    expect(got.paths).toHaveLength(1);
    expect(got.truncated).toBe(true);
  });
});

describe("traceFlow —— 拿一张单走一遍", () => {
  it("任何多出边都停下来列选项 —— 单令牌走查不替业务方猜「主路」", () => {
    // 请购单已提交 有两条无标签出边（→审批、→抄送）：第一处分岔就该停
    const got = traceFlow(fixture(), "n.start", {});
    expect(got.stopped).toBe("fork");
    expect(got.steps.map((s) => s.label)).toEqual(["提交请购单", "请购单已提交"]);
    // 边没有条件标签时，选项落到目标节点名上 —— 总得有个能指认的名字
    expect((got.options ?? []).map((o) => o.target).sort()).toEqual(["抄送备案", "金额审批"]);
  });

  it("网关的选项带条件标签 —— 「通过/驳回」正是要拿去问业务方的词", () => {
    const got = traceFlow(fixture(), "g.approve", {});
    expect(got.stopped).toBe("fork");
    expect((got.options ?? []).map((o) => o.label).sort()).toEqual(["通过", "驳回"]);
  });

  it("给全选择走到底，并数清有几跳是推断边", () => {
    const got = traceFlow(fixture(), "n.start", {
      请购单已提交: "金额审批",
      金额审批: "通过",
    });
    expect(got.stopped).toBe("terminal");
    expect(got.steps.map((s) => s.label)).toEqual([
      "提交请购单", "请购单已提交", "金额审批", "生成采购订单", "订单已生成",
    ]);
    // 夹具的边全部零 evidence —— 4 跳全是推断
    expect(got.ungroundedHops).toBe(4);
  });

  it("选驳回会闭环：回到走过的节点就停，说明这是个环", () => {
    const got = traceFlow(fixture(), "n.start", {
      请购单已提交: "金额审批",
      金额审批: "驳回",
    });
    expect(got.stopped).toBe("loop");
    expect(got.steps.map((s) => s.label)).toEqual([
      "提交请购单", "请购单已提交", "金额审批", "修改请购单",
    ]);
  });
});

describe("resolveFlowNode —— 名字/编号/rid 都能指到节点", () => {
  it("按 label 精确命中；找不到给出候选而不是空手而归", () => {
    const g = fixture();
    expect(resolveFlowNode(g, "金额审批")!.rid).toBe("g.approve");
    expect(resolveFlowNode(g, "g.approve")!.rid).toBe("g.approve");
    expect(resolveFlowNode(g, "不存在的环节")).toBeNull();
  });
});
