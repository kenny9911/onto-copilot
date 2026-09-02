/**
 * S3：图片流程图识读 → FlowGraph。
 *
 * vision 已经在产出 `structured.relations`（实测 gemini-flash 在百节点图上
 * 认出 34 条连线），但没有任何流程构建代码读它 —— 已付费的信号被扔掉。
 *
 * 评审定下的保守档：**只产 action 节点 + 边，不产 gateway/terminal**。
 * 因为 `OCR_SCHEMA.blocks.kind` 的枚举是 ER 图口径（entity_box/field/note…），
 * 没有任何流程语义可推；扩 schema 会动 PARSE 主链，不属于这一步。
 *
 * 保真度：转写客户自己画的图，记实证档；但**必须带显式说明**
 * 「识别到 N 框 M 线，可能有遗漏」—— 漏掉的线会静默变成"这两个框没关系"，
 * 是假阴性伪装成实证，必须说破。
 */
import { describe, expect, it } from "vitest";

import { flowFromVision } from "../src/onto/flow_from_vision.js";

function doc(relations: unknown[]) {
  return {
    file_id: "f9", file_name: "流程截图.png",
    structured: { relations, blocks: 12 },
  };
}

describe("flowFromVision", () => {
  it("一条连线 → 两个节点一条边，名字用图上的字", () => {
    const g = flowFromVision(doc([
      { from_entity: "提交报销申请", to_entity: "部门审批", label: "", page: 1 },
    ]))!;

    expect(g.nodes.size).toBe(2);
    expect(g.edges.size).toBe(1);
    expect([...g.nodes.values()].map((n) => n.label.value))
      .toEqual(["提交报销申请", "部门审批"]);
  });

  it("连线上的字进边标签 —— 分支条件常写在那儿", () => {
    const g = flowFromVision(doc([
      { from_entity: "金额判断", to_entity: "总经理审批", label: "超过5万", page: 1 },
    ]))!;

    expect([...g.edges.values()][0]?.label).toBe("超过5万");
  });

  it("同一个框出现在多条线里只建一个节点", () => {
    const g = flowFromVision(doc([
      { from_entity: "甲", to_entity: "乙", label: "", page: 1 },
      { from_entity: "乙", to_entity: "丙", label: "", page: 1 },
    ]))!;

    expect(g.nodes.size).toBe(3);
    expect(g.edges.size).toBe(2);
  });

  it("证据指回那一页 —— 点得回去才算实证", () => {
    const g = flowFromVision(doc([
      { from_entity: "甲", to_entity: "乙", label: "", page: 3 },
    ]))!;

    const n = [...g.nodes.values()][0]!;
    expect(n.label.origin).toBe("extracted");
    expect(n.label.evidence[0]?.fileName).toBe("流程截图.png");
    expect(n.label.evidence[0]?.locator["page"]).toBe(3);
  });

  it("保守档：一律 action，不猜 gateway/terminal", () => {
    const g = flowFromVision(doc([
      { from_entity: "金额判断", to_entity: "结束", label: "", page: 1 },
    ]))!;

    expect([...g.nodes.values()].every((n) => n.kind === "action")).toBe(true);
  });

  it("没有连线就不出图 —— 出一张空图比不出更糟", () => {
    expect(flowFromVision(doc([]))).toBeNull();
  });

  it("实体名是空串的连线丢掉，不造无名节点", () => {
    const g = flowFromVision(doc([
      { from_entity: "", to_entity: "乙", label: "", page: 1 },
      { from_entity: "甲", to_entity: "乙", label: "", page: 1 },
    ]))!;

    expect(g.nodes.size).toBe(2);
    expect(g.edges.size).toBe(1);
  });
});
