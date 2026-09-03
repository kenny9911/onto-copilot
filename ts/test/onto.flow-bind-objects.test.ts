/**
 * flow.edit bind_objects（A7 第一块）。
 *
 * 起因：右栏的「未接入流程」补齐提示写着「用 flow.edit 把那些节点绑到这个对象上」，
 * 而 flow.edit 的七个 op 里**没有一个碰得到 `FlowNode.objects`** —— 指着一个
 * 不存在的能力。实测真实库 11 个流程节点的 objects 全是 `[]`，
 * 右栏「流程节点 0」就是这么来的。
 */
import { describe, expect, it } from "vitest";

import { FlowEditError, applyFlowEdit } from "../src/onto/flow_edit.js";
import { flowFromDict } from "../src/onto/flow.js";

const graph = () => flowFromDict({
  stages: [{ key: "s1", title: "阶段一" }],
  nodes: [
    { rid: "fn_submit", kind: "action", code: "ACT-1", label: { value: "提交采购申请" }, stage: "s1", objects: [] },
    { rid: "fn_done", kind: "event", code: "EV-1", label: { value: "采购申请已提交" }, stage: "s1", objects: [] },
  ],
  edges: [],
});

/** 「采购申请」「PurchaseRequisition」都指向同一个 rid；别的名字解析不出来。 */
const resolveObject = (name: string): string =>
  ["采购申请", "PurchaseRequisition", "ot_pr"].includes(name) ? "ot_pr" : "";

describe("bind_objects", () => {
  it("中文名和 apiName 都能绑，**落盘一律存 rid**", () => {
    const g = graph();
    const note = applyFlowEdit(g, "bind_objects",
      { node: "提交采购申请", objects: ["采购申请"] }, { resolveObject });
    expect(note).toContain("提交采购申请");
    expect(g.nodes.get("fn_submit")!.objects).toEqual(["ot_pr"]);

    const g2 = graph();
    applyFlowEdit(g2, "bind_objects",
      { node: "提交采购申请", objects: ["PurchaseRequisition"] }, { resolveObject });
    // 存的是 rid 不是原样名字 —— 消费方（右栏计数、canonical）按 rid 比
    expect(g2.nodes.get("fn_submit")!.objects).toEqual(["ot_pr"]);
  });

  it("**名字对不上要点名报错，不静默跳过** —— 静默跳过会让人以为绑上了", () => {
    const g = graph();
    expect(() => applyFlowEdit(g, "bind_objects",
      { node: "提交采购申请", objects: ["采购申请", "根本没有的对象"] }, { resolveObject }))
      .toThrow(/模型里没有这些对象：根本没有的对象/u);
  });

  it("整条报错时不留半绑状态", () => {
    const g = graph();
    try {
      applyFlowEdit(g, "bind_objects",
        { node: "提交采购申请", objects: ["不存在"] }, { resolveObject });
    } catch { /* 预期 */ }
    // 这一条里唯一的名字就解析不出来，所以节点必须原样
    expect(g.nodes.get("fn_submit")!.objects).toEqual([]);
  });

  it("重复绑同一个对象不会绑两遍", () => {
    const g = graph();
    applyFlowEdit(g, "bind_objects", { node: "提交采购申请", objects: ["采购申请"] }, { resolveObject });
    const note = applyFlowEdit(g, "bind_objects", { node: "提交采购申请", objects: ["采购申请"] }, { resolveObject });
    expect(g.nodes.get("fn_submit")!.objects).toEqual(["ot_pr"]);
    expect(note).toContain("本来就绑着");
  });

  it("事件节点也能绑 —— 事件带的是哪张单据的数据，同样要说清楚", () => {
    const g = graph();
    applyFlowEdit(g, "bind_objects", { node: "采购申请已提交", objects: ["采购申请"] }, { resolveObject });
    expect(g.nodes.get("fn_done")!.objects).toEqual(["ot_pr"]);
  });

  it("objects 空 / 没接解析通道，都要给人话而不是崩", () => {
    expect(() => applyFlowEdit(graph(), "bind_objects",
      { node: "提交采购申请", objects: [] }, { resolveObject }))
      .toThrow(FlowEditError);
    expect(() => applyFlowEdit(graph(), "bind_objects",
      { node: "提交采购申请", objects: ["采购申请"] }, {}))
      .toThrow(/没有接对象名解析通道/u);
  });

  it("bind_objects 在 op 表里 —— 右栏的补齐提示指的就是它，不能是空头支票", async () => {
    const { FLOW_EDIT_OPS } = await import("../src/onto/flow_edit.js");
    expect([...FLOW_EDIT_OPS]).toContain("bind_objects");
  });
});
