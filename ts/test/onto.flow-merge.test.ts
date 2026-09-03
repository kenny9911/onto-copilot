/**
 * 多策略合流 —— 两条策略都出了图，怎么并。
 *
 * 设计评审点名的前置：现有 `diffFlowGraphs` 返回的是**标签串不是 rid**，
 * 唯一暴露的差异维度是 `kindDiff`。所以「evidence 取并集」和
 * 「执行者不同 / 分支条件不同 → 冲突」都无法基于它实现。
 *
 * 这里加的是 rid 级、逐字段的配对结果，`sketch.diff` 的既有用法不变。
 *
 * 合流的纪律只有一条：**冲突不静默合并**。两条策略对同一个环节说了不同的话，
 * 那是要问业务方的事，不是系统挑一个的事。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { extracted, inferred, makeProvenance } from "../src/onto/oir.js";
import { mergeFlowGraphs } from "../src/onto/flow_merge.js";

function prov(file: string, ref: string) {
  return makeProvenance("f", file, { kind: "raw", ref }, { snippet: ref });
}

function node(g: FlowGraph, rid: string, label: string, opts: {
  actor?: string; ev?: ReturnType<typeof prov>;
} = {}) {
  return g.addNode(makeFlowNode({
    rid, kind: NodeKind.ACTION,
    label: opts.ev ? extracted(label, opts.ev) : inferred(label),
    actor: opts.actor === undefined ? inferred("") : inferred(opts.actor),
  }));
}

describe("mergeFlowGraphs", () => {
  it("两边都有同一个环节 —— 合成一个，出处取并集", () => {
    const a = new FlowGraph(); node(a, "fn_1", "提交采购申请", { ev: prov("制度.docx", "第3节") });
    const b = new FlowGraph(); node(b, "fn_x", "提交采购申请", { ev: prov("流程.pptx", "第2页") });

    const m = mergeFlowGraphs([
      { strategy: "S2", graph: a },
      { strategy: "S4", graph: b },
    ]);

    expect(m.graph.nodes.size).toBe(1);
    const only = [...m.graph.nodes.values()][0]!;
    expect(only.label.evidence).toHaveLength(2);
    expect(m.conflicts).toHaveLength(0);
  });

  it("只有一边有的环节 —— 保留，并记下它来自哪条策略", () => {
    const a = new FlowGraph(); node(a, "fn_1", "提交采购申请");
    const b = new FlowGraph(); node(b, "fn_x", "供应商资质年审");

    const m = mergeFlowGraphs([
      { strategy: "S2", graph: a },
      { strategy: "S4", graph: b },
    ]);

    expect(m.graph.nodes.size).toBe(2);
    expect(m.sources.get("供应商资质年审")).toEqual(["S4"]);
  });

  it("★ 配上了但执行者不同 —— 不合并成一个说法，出一条冲突", () => {
    const a = new FlowGraph(); node(a, "fn_1", "审批采购申请", { actor: "部门负责人" });
    const b = new FlowGraph(); node(b, "fn_x", "审批采购申请", { actor: "总经理" });

    const m = mergeFlowGraphs([
      { strategy: "S2", graph: a },
      { strategy: "S4", graph: b },
    ]);

    expect(m.conflicts).toHaveLength(1);
    expect(m.conflicts[0]?.field).toBe("actor");
    expect(m.conflicts[0]?.left).toBe("部门负责人");
    expect(m.conflicts[0]?.right).toBe("总经理");
  });

  it("冲突要说清是哪两条策略在打架 —— 否则没法判谁更可信", () => {
    const a = new FlowGraph(); node(a, "fn_1", "审批采购申请", { actor: "部门负责人" });
    const b = new FlowGraph(); node(b, "fn_x", "审批采购申请", { actor: "总经理" });

    const m = mergeFlowGraphs([
      { strategy: "S2", graph: a },
      { strategy: "S4", graph: b },
    ]);

    expect(m.conflicts[0]?.strategies).toEqual(["S2", "S4"]);
  });

  it("一方没填执行者不算冲突 —— 那是缺信息，不是两种说法", () => {
    const a = new FlowGraph(); node(a, "fn_1", "审批采购申请", { actor: "部门负责人" });
    const b = new FlowGraph(); node(b, "fn_x", "审批采购申请");

    const m = mergeFlowGraphs([
      { strategy: "S2", graph: a },
      { strategy: "S4", graph: b },
    ]);

    expect(m.conflicts).toHaveLength(0);
    // 有值的那个赢：缺信息的一方不该把已知的信息抹掉
    expect([...m.graph.nodes.values()][0]?.actor.value).toBe("部门负责人");
  });

  it("保真度高的策略排前面 —— 同名环节以它的说法为准", () => {
    const a = new FlowGraph(); node(a, "fn_1", "提交申请");
    const b = new FlowGraph(); node(b, "fn_x", "提交申请");

    const m = mergeFlowGraphs([
      { strategy: "S4", graph: b },
      { strategy: "S1", graph: a },
    ]);

    // S1（BPMN 直读）保真度最高，应当排到前面
    expect(m.order).toEqual(["S1", "S4"]);
  });

  it("只有一条策略时原样返回", () => {
    const a = new FlowGraph(); node(a, "fn_1", "提交申请");

    const m = mergeFlowGraphs([{ strategy: "S2", graph: a }]);

    expect(m.graph.nodes.size).toBe(1);
    expect(m.conflicts).toHaveLength(0);
  });

  it("一条都没有时给空图，不抛", () => {
    expect(mergeFlowGraphs([]).graph.nodes.size).toBe(0);
  });
});
