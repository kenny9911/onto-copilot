/**
 * ER 图（T4）：对客户讲 Ontology 最需要的那张图。
 */
import { describe, expect, it } from "vitest";

import { toErMermaid } from "../src/onto/diagram_er.js";
import { buildOir } from "../src/onto/pipeline.js";

const SRC = { source_file: "x.xlsx", source_locator: "x.xlsx!S!R2-1" };
const oir = () => buildOir({
  objects: [
    { api_name: "PurchaseOrder", display_name: "采购订单", primary_key: ["orderNo"], ...SRC },
    { api_name: "Supplier", display_name: "供应商", ...SRC },
  ],
  properties: [
    { parent_api_name: "PurchaseOrder", api_name: "orderNo", base_type: "STRING",
      definition: "唯一单号", required: true, ...SRC },
    { parent_api_name: "PurchaseOrder", api_name: "status", base_type: "ENUM",
      value_domain: ["草稿", "待审", "已批准"], ...SRC },
    { parent_api_name: "Supplier", api_name: "name", base_type: "STRING", ...SRC },
  ],
  links: [{ api_name: "po_supplier", from_api_name: "Supplier", to_api_name: "PurchaseOrder",
    cardinality: "ONE_TO_MANY", join_key: { from_property: "id", to_property: "supplierId" }, ...SRC }],
  events: [{ api_name: "OrderApproved", display_name: "订单已批准",
    payload_objects: ["PurchaseOrder"], ...SRC }],
});

describe("toErMermaid", () => {
  it("实体带中文别名、属性带类型、主键标 PK、值域进注释", () => {
    const mmd = toErMermaid(oir());
    expect(mmd).toContain("erDiagram");
    expect(mmd).toContain('PurchaseOrder["采购订单"]');
    expect(mmd).toContain("STRING orderNo PK");
    expect(mmd).toContain("唯一单号");
    // **值域是讲解时最常被问的** —— 没口径时用它当注释
    expect(mmd).toContain("取值 草稿/待审/已批准");
  });

  it("关系按基数转记号，join_key 当边标签", () => {
    const mmd = toErMermaid(oir());
    expect(mmd).toContain("Supplier ||--o{ PurchaseOrder");
    expect(mmd).toContain("id=supplierId");
  });

  it("事件用弱关系连到载荷对象 —— Action 是行为不进 ER 图", () => {
    const mmd = toErMermaid(oir());
    expect(mmd).toContain('OrderApproved["订单已批准"] }o..o{ PurchaseOrder : "载荷"');
  });

  it("only 过滤时**悬空关系不画** —— 画到图外的线比不画更误导", () => {
    const mmd = toErMermaid(oir(), { only: ["PurchaseOrder"] });
    expect(mmd).toContain("PurchaseOrder");
    expect(mmd).not.toContain("Supplier ||--o{");
  });

  it("属性超上限收进「还有 N 个」——图是拿来讲的，不是拿来读全表的", () => {
    const mmd = toErMermaid(oir(), { maxAttrs: 1 });
    expect(mmd).toContain('_more "还有 1 个属性"');
  });

  it("对象名里的怪字符不炸 mermaid 语法", () => {
    const dirty = buildOir({
      objects: [{ api_name: "订单[主]", display_name: '带"引号"', ...SRC }],
      properties: [], links: [],
    }, null, {});
    const mmd = toErMermaid(dirty);
    expect(mmd).not.toContain("[主]");   // 实体名被转义
    expect(mmd).not.toContain('""');     // 标签引号被换成单引号
  });
});
