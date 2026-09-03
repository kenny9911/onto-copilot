/**
 * 第 2 层「二轮编辑动词」流程侧：set_kind / unbind_objects / rename_stage /
 * reorder_stages 四个新动词，外加两处已知伤的修复：
 *
 *  · A6：set_branch_label 以前 `hit[0]!` 只改第一条平行边**且不吭声** ——
 *    第二条永远贴不上标签。修后：优先给没有标签的那条贴；全都有标签时明说；
 *    多条无标签视为重复边，全部贴上并说明。
 *  · A11：bind_objects 以前先 push 再查 missed —— 部分成功违反文件头
 *    「被拒之后图一个字节都没动」的承诺。修后：先全部解析，有一个对不上就
 *    整条拒绝、图不动。
 *
 * 新动词的共同纪律：抽错类型不再需要 remove+add（那会丢出处）；泳道改名
 * key 保持稳定（节点引用的是 key）；重排必须给全量排列，缺一个都不落。
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
import { extracted, inferred, makeProvenance } from "../src/onto/oir.js";
import { applyFlowEdit, FlowEditError } from "../src/onto/flow_edit.js";

function fixture(): FlowGraph {
  const g = new FlowGraph();
  g.stages.set("s1", makeStage({ key: "s1", title: "阶段一", order: 0 }));
  g.stages.set("s2", makeStage({ key: "s2", title: "阶段二", order: 1 }));
  g.stages.set("s3", makeStage({ key: "s3", title: "阶段三", order: 2 }));
  const ns = [
    makeFlowNode({ rid: "n1", kind: NodeKind.ACTION, label: inferred("提交申请"), stage: "s1", objects: ["do.po", "do.supplier"] }),
    makeFlowNode({ rid: "g1", kind: NodeKind.GATEWAY, label: inferred("审批") }),
    makeFlowNode({ rid: "n2", kind: NodeKind.ACTION, label: inferred("下单") }),
    makeFlowNode({ rid: "n3", kind: NodeKind.ACTION, label: inferred("归档") }),
  ];
  for (const n of ns) g.nodes.set(n.rid, n);
  g.edges.set("E1", makeFlowEdge({ rid: "E1", source: "g1", target: "n2", kind: EdgeKind.CONDITIONAL, label: "通过" }));
  g.edges.set("E2", makeFlowEdge({ rid: "E2", source: "g1", target: "n2" })); // 平行、无标签
  g.edges.set("E3", makeFlowEdge({ rid: "E3", source: "n1", target: "g1" }));
  return g;
}

const CTX = {
  source: "user" as const,
  resolveObject: (name: string): string =>
    ({ 采购订单: "do.po", 供应商: "do.supplier" })[name] ?? "",
};

describe("set_kind —— 抽错类型不再需要删了重建", () => {
  it("action → event，出处与连边都还在", () => {
    const g = fixture();
    const note = applyFlowEdit(g, "set_kind", { node: "归档", kind: "event" }, CTX);
    expect(note).toContain("归档");
    expect(g.nodes.get("n3")!.kind).toBe(NodeKind.EVENT);
  });

  it("不认识的 kind 拒绝", () => {
    expect(() => applyFlowEdit(fixture(), "set_kind", { node: "归档", kind: "whatever" }, CTX))
      .toThrow(FlowEditError);
  });
});

describe("unbind_objects —— bind 的反向操作（A4 缺口）", () => {
  it("解绑指定对象，别的不动", () => {
    const g = fixture();
    applyFlowEdit(g, "unbind_objects", { node: "提交申请", objects: ["采购订单"] }, CTX);
    expect(g.nodes.get("n1")!.objects).toEqual(["do.supplier"]);
  });

  it("名字对不上整条拒绝，图不动", () => {
    const g = fixture();
    expect(() =>
      applyFlowEdit(g, "unbind_objects", { node: "提交申请", objects: ["采购订单", "不存在"] }, CTX),
    ).toThrow(FlowEditError);
    expect(g.nodes.get("n1")!.objects).toEqual(["do.po", "do.supplier"]);
  });
});

describe("rename_stage / reorder_stages —— 泳道终于能改（A2 缺口）", () => {
  it("改名只动 title，key 稳定（节点引用的是 key）", () => {
    const g = fixture();
    applyFlowEdit(g, "rename_stage", { stage: "阶段一", title: "计划与申请" }, CTX);
    expect(g.stages.get("s1")!.title).toBe("计划与申请");
    expect(g.nodes.get("n1")!.stage).toBe("s1");
  });

  it("重排必须给全量排列 —— 缺一个都不落", () => {
    const g = fixture();
    applyFlowEdit(g, "reorder_stages", { order: ["阶段三", "阶段一", "阶段二"] }, CTX);
    expect(g.stages.get("s3")!.order).toBe(0);
    expect(g.stages.get("s1")!.order).toBe(1);
    expect(g.stages.get("s2")!.order).toBe(2);
    expect(() => applyFlowEdit(g, "reorder_stages", { order: ["阶段一"] }, CTX))
      .toThrow(FlowEditError);
  });
});

describe("set_branch_label 修复（A6：以前静默只改第一条平行边）", () => {
  it("有平行边时优先给没标签的那条贴，不动已有标签的", () => {
    const g = fixture();
    const note = applyFlowEdit(g, "set_branch_label", { source: "审批", target: "下单", label: "驳回" }, CTX);
    expect(g.edges.get("E1")!.label).toBe("通过"); // 原有标签不被覆盖
    expect(g.edges.get("E2")!.label).toBe("驳回");
    expect(note).toContain("平行");
  });

  it("全都已有标签时明说，不静默覆盖第一条", () => {
    const g = fixture();
    g.edges.get("E2")!.label = "加急";
    expect(() =>
      applyFlowEdit(g, "set_branch_label", { source: "审批", target: "下单", label: "驳回" }, CTX),
    ).toThrow(/通过|加急/);
  });
});

describe("bind_objects 原子性修复（A11）", () => {
  it("有一个名字对不上就整条拒绝，已解析的也不落", () => {
    const g = fixture();
    expect(() =>
      applyFlowEdit(g, "bind_objects", { node: "下单", objects: ["采购订单", "不存在"] }, CTX),
    ).toThrow(FlowEditError);
    expect(g.nodes.get("n2")!.objects).toEqual([]);
  });
});

const MAT = makeProvenance("f1", "采购.docx", { para: 1 }, { snippet: "归档", extractor: "docling", confidence: 0.8 });

describe("set_node_status —— 流程侧终于有评审状态（A10 复活）", () => {
  it("标 rejected，字段真的落进节点", () => {
    const g = fixture();
    const note = applyFlowEdit(g, "set_node_status", { node: "归档", status: "rejected" }, CTX);
    expect(g.nodes.get("n3")!.status).toBe("rejected");
    expect(note).toContain("rejected");
  });

  it("不认识的 status 拒绝", () => {
    expect(() => applyFlowEdit(fixture(), "set_node_status", { node: "归档", status: "whatever" }, CTX))
      .toThrow(FlowEditError);
  });
});

describe("删除的出处守卫（A9，与 OIR 侧对称）", () => {
  it("材料抽出来的环节不许硬删 —— 指路 set_node_status(rejected)", () => {
    const g = fixture();
    g.nodes.set("gr", makeFlowNode({ rid: "gr", kind: NodeKind.ACTION, label: extracted("材料环节", MAT) }));
    expect(() => applyFlowEdit(g, "remove_node", { node: "材料环节" }, CTX))
      .toThrow(/set_node_status/);
    expect(g.nodes.has("gr")).toBe(true);
  });

  it("人工/无依据的环节照删（无连边时也无需 confirm）", () => {
    const g = fixture();
    applyFlowEdit(g, "remove_node", { node: "归档" }, CTX);
    expect(g.nodes.has("n3")).toBe(false);
  });

  it("disconnect 碰到有材料依据的边也拦", () => {
    const g = fixture();
    g.edges.get("E3")!.evidence.push(MAT);
    expect(() => applyFlowEdit(g, "disconnect", { source: "提交申请", target: "审批" }, CTX))
      .toThrow(/证据|依据/);
    expect(g.edges.has("E3")).toBe(true);
  });
});

describe("破坏性编辑先看影响（C4）", () => {
  it("删有连边的环节：不带 confirm 拒绝并列影响；confirm=true 才落", () => {
    const g = fixture();
    expect(() => applyFlowEdit(g, "remove_node", { node: "审批" }, CTX)).toThrow(/confirm/);
    expect(g.nodes.has("g1")).toBe(true);
    const note = applyFlowEdit(g, "remove_node", { node: "审批", confirm: true }, CTX);
    expect(g.nodes.has("g1")).toBe(false);
    expect(note).toContain("边");
  });
});

describe("set_workflow / remove_workflow（A3：非 BPMN 图的 workflows 终于有入口）", () => {
  it("建一条业务流：entry/exits 解析成节点 rid", () => {
    const g = fixture();
    const note = applyFlowEdit(
      g, "set_workflow",
      { workflow: "main", title: "采购主流程", entry: "提交申请", exits: ["下单"] }, CTX,
    );
    const w = g.workflows.get("main")!;
    expect(w.entry).toBe("n1");
    expect(w.exits).toEqual(["n2"]);
    expect(note).toContain("采购主流程");
  });

  it("exits 指不到就拒绝，不落半条", () => {
    const g = fixture();
    expect(() => applyFlowEdit(
      g, "set_workflow",
      { workflow: "m", title: "x", entry: "提交申请", exits: ["不存在"] }, CTX,
    )).toThrow(FlowEditError);
    expect(g.workflows.size).toBe(0);
  });

  it("remove_workflow 删得掉（结构元数据，无出处顾虑）", () => {
    const g = fixture();
    applyFlowEdit(g, "set_workflow", { workflow: "m", title: "x", entry: "提交申请", exits: ["下单"] }, CTX);
    applyFlowEdit(g, "remove_workflow", { workflow: "m" }, CTX);
    expect(g.workflows.size).toBe(0);
  });
});

describe("bind_auto —— 自动绑定的手动触发口", () => {
  it("有通道时报数量；没接通道明说", () => {
    const g = fixture();
    const note = applyFlowEdit(g, "bind_auto", {}, { ...CTX, autoBind: () => 7 });
    expect(note).toContain("7");
    expect(() => applyFlowEdit(g, "bind_auto", {}, CTX)).toThrow(FlowEditError);
  });
});

describe("set_edge_kind（A5：补偿边/跨系统边终于人工建得出来）", () => {
  it("单边直接改；kind 校验", () => {
    const g = fixture();
    const note = applyFlowEdit(g, "set_edge_kind", { source: "提交申请", target: "审批", kind: "external" }, CTX);
    expect(g.edges.get("E3")!.kind).toBe(EdgeKind.EXTERNAL);
    expect(note).toContain("external");
    expect(() => applyFlowEdit(g, "set_edge_kind", { source: "提交申请", target: "审批", kind: "nope" }, CTX))
      .toThrow(FlowEditError);
  });

  it("平行边必须用 label 指认；不给就报错列出标签（A6 同款纪律）", () => {
    const g = fixture(); // 审批→下单 有 E1(通过) 与 E2(无标签) 两条
    expect(() => applyFlowEdit(g, "set_edge_kind", { source: "审批", target: "下单", kind: "compensate" }, CTX))
      .toThrow(/通过/);
    applyFlowEdit(g, "set_edge_kind", { source: "审批", target: "下单", kind: "compensate", label: "通过" }, CTX);
    expect(g.edges.get("E1")!.kind).toBe(EdgeKind.COMPENSATE);
    expect(g.edges.get("E2")!.kind).toBe(EdgeKind.FLOW); // 没被指认的不动
  });
});
