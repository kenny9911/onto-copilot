/**
 * 对象 ↔ 流程节点的自动绑定（C2 的前置）：实测真实库 11 个流程节点的 objects
 * 全部为空 —— 本体与流程之间的桥根本没搭，impact.trace 想看流程也连不过去。
 *
 * 绑定规则（确定性、零模型）：只补**空**的（不碰人工绑过的）；对象的
 * displayName / 别名（≥2 字）作为子串出现在节点 label 里即命中；一个节点
 * 最多绑 3 个，按名字长度降序取（长名更具体）。
 *
 * flowDependents 是 impact.trace 的流程侧一半：给一组对象 rid，返回绑着它们的节点。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { OIR, inferred, makeObjectType } from "../src/onto/oir.js";
import { autoBindObjects, flowDependents } from "../src/onto/flow_link.js";

function world(): { g: FlowGraph; oir: OIR } {
  const oir = new OIR();
  oir.objects.set("do.po", makeObjectType({ rid: "do.po", apiName: inferred("po"), displayName: inferred("采购订单") }));
  oir.objects.set("do.req", makeObjectType({ rid: "do.req", apiName: inferred("req"), displayName: inferred("请购单"), aliases: ["采购申请"] }));
  oir.objects.set("do.sup", makeObjectType({ rid: "do.sup", apiName: inferred("sup"), displayName: inferred("供应商") }));
  const g = new FlowGraph();
  g.nodes.set("n1", makeFlowNode({ rid: "n1", kind: NodeKind.ACTION, label: inferred("提交采购申请") }));
  g.nodes.set("n2", makeFlowNode({ rid: "n2", kind: NodeKind.ACTION, label: inferred("生成采购订单并通知供应商") }));
  g.nodes.set("n3", makeFlowNode({ rid: "n3", kind: NodeKind.ACTION, label: inferred("归档"), objects: ["do.sup"] }));
  return { g, oir };
}

describe("autoBindObjects", () => {
  it("按名字/别名命中，只补空的，返回新增绑定数", () => {
    const { g, oir } = world();
    const n = autoBindObjects(g, oir);
    expect(g.nodes.get("n1")!.objects).toEqual(["do.req"]); // 别名「采购申请」命中
    expect(g.nodes.get("n2")!.objects.sort()).toEqual(["do.po", "do.sup"]);
    expect(g.nodes.get("n3")!.objects).toEqual(["do.sup"]); // 已绑过，不动
    expect(n).toBe(3);
  });

  it("幂等：再跑一遍零新增", () => {
    const { g, oir } = world();
    autoBindObjects(g, oir);
    expect(autoBindObjects(g, oir)).toBe(0);
  });
});

describe("flowDependents", () => {
  it("给对象 rid 返回绑着它的流程节点", () => {
    const { g, oir } = world();
    autoBindObjects(g, oir);
    expect(flowDependents(g, ["do.sup"]).map((x) => x.rid).sort()).toEqual(["n2", "n3"]);
    expect(flowDependents(g, ["do.req"]).map((x) => x.label)).toEqual(["提交采购申请"]);
  });
});
