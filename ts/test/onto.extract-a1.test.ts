/**
 * A1：抽取 schema 补齐后的落库行为。
 *
 * 三条纪律贯穿所有断言：
 *   1. **schema 有坑位、落库就要接住** —— 只声明不落，模型填了也是白填
 *      （add_batch 那次事故的根因）；
 *   2. **新字段一律可选发射** —— 老数据一个键都不多，golden 钉的是旧字节；
 *   3. **声明的胜过猜的** —— 材料里标了主键就用它（extracted 带出处），
 *      「apiName 以 id 结尾」的启发式只做兜底（inferred）。
 */
import { describe, expect, it } from "vitest";

import { buildOir } from "../src/onto/pipeline.js";

const val = (a: any) => (a && typeof a === "object" && "value" in a ? a.value : a);
const SRC = { source_file: "x.xlsx", source_locator: "x.xlsx!S!R2-1" };

describe("对象：主键与分类", () => {
  it("**声明主键胜过启发式**，解析成属性 rid、origin=extracted", () => {
    const oir = buildOir({
      objects: [{ api_name: "PurchaseOrder", display_name: "采购订单",
        primary_key: ["orderNo"], classification: "DOCUMENT", ...SRC }],
      properties: [
        { parent_api_name: "PurchaseOrder", api_name: "orderNo", ...SRC },
        // 干扰项：以 id 结尾 —— 启发式会挑它，声明主键必须压过
        { parent_api_name: "PurchaseOrder", api_name: "supplierId", ...SRC },
      ],
      links: [],
    }, null, {});
    const o = [...oir.objects.values()][0]!;
    expect(val(o.primaryKey)).toEqual(["pt_purchaseorder_orderno"]);
    expect(o.primaryKey.origin).toBe("extracted");
    expect(val(o.classification)).toBe("DOCUMENT");
  });

  it("没声明时启发式兜底不变（inferred —— 它就是猜的）", () => {
    const oir = buildOir({
      objects: [{ api_name: "A", display_name: "甲", ...SRC }],
      properties: [{ parent_api_name: "A", api_name: "recordId", ...SRC }],
      links: [],
    }, null, {});
    const o = [...oir.objects.values()][0]!;
    expect(val(o.primaryKey)).toEqual(["pt_a_recordid"]);
    expect(o.primaryKey.origin).toBe("inferred");
  });

  it("**复合主键解析不全就不写** —— 写一半比不写更误导", () => {
    const oir = buildOir({
      objects: [{ api_name: "Detail", display_name: "明细",
        primary_key: ["reportId", "不存在的字段"], ...SRC }],
      properties: [{ parent_api_name: "Detail", api_name: "reportId", ...SRC }],
      links: [],
    }, null, {});
    const o = [...oir.objects.values()][0]!;
    // 落回启发式：reportId 以 id 结尾
    expect(o.primaryKey.origin).toBe("inferred");
  });

  it("不给分类时 toDict 里没有 classification 键（老字节原样）", () => {
    const oir = buildOir({
      objects: [{ api_name: "A", display_name: "甲", ...SRC }], properties: [], links: [],
    }, null, {});
    expect("classification" in (oir.toDict() as any).objects[0]).toBe(false);
  });
});

describe("属性：值域与语义类型", () => {
  it("value_domain / semantic_type 落库且带出处", () => {
    const oir = buildOir({
      objects: [{ api_name: "A", display_name: "甲", ...SRC }],
      properties: [{ parent_api_name: "A", api_name: "status", base_type: "ENUM",
        value_domain: ["草稿", "待审", "已批准"], semantic_type: "状态", ...SRC }],
      links: [],
    }, null, {});
    const p = [...oir.properties.values()][0]!;
    expect(val(p.valueDomain)).toEqual(["草稿", "待审", "已批准"]);
    expect(val(p.semanticType)).toBe("状态");
    expect(p.valueDomain.origin).toBe("extracted");
  });
});

describe("关系：MANY_TO_ONE 与 join_key", () => {
  it("**MANY_TO_ONE 对调两端**落成 ONE_TO_MANY —— 与对话路径同一个语义", () => {
    const oir = buildOir({
      objects: [{ api_name: "Order", display_name: "订单", ...SRC },
        { api_name: "Supplier", display_name: "供应商", ...SRC }],
      properties: [],
      links: [{ api_name: "order_supplier", from_api_name: "Order", to_api_name: "Supplier",
        cardinality: "MANY_TO_ONE",
        join_key: { from_property: "supplierId", to_property: "id" }, ...SRC }],
    }, null, {});
    const l = [...oir.links.values()][0]!;
    // 多个 Order 对一个 Supplier → Supplier 一对多 Order
    expect(l.source).toBe("ot_supplier");
    expect(l.target).toBe("ot_order");
    expect(val(l.cardinality)).toBe("ONE_TO_MANY");
    // join_key 跟着换边：{对方列: 本表列}
    expect(val(l.joinKey)).toEqual({ id: "supplierId" });
  });

  it("join_key 落成 {from: to} 映射，不翻转时原样", () => {
    const oir = buildOir({
      objects: [{ api_name: "H", display_name: "头", ...SRC }, { api_name: "L", display_name: "行", ...SRC }],
      properties: [],
      links: [{ api_name: "h_l", from_api_name: "H", to_api_name: "L", cardinality: "ONE_TO_MANY",
        join_key: { from_property: "planId", to_property: "planId" }, ...SRC }],
    }, null, {});
    expect(val([...oir.links.values()][0]!.joinKey)).toEqual({ planId: "planId" });
  });
});

describe("动作与事件两个新桶", () => {
  const DATA = {
    objects: [{ api_name: "PurchaseRequisition", display_name: "采购申请", ...SRC }],
    properties: [],
    links: [],
    actions: [{ api_name: "SubmitRequisition", applies_to: "PurchaseRequisition",
      actor: "申请人", preconditions: ["草稿状态"], effects: ["进入审批流"],
      object: "PurchaseRequisition", ...SRC }],
    events: [{ api_name: "RequisitionSubmitted", display_name: "采购申请已提交",
      emitted_by: "SubmitRequisition", payload_objects: ["PurchaseRequisition"], ...SRC }],
  };

  it("**Action 不再出厂即空壳**：actor/preconditions/effects 从抽取直接落", () => {
    const oir = buildOir(DATA, null, {});
    const a = [...oir.actions.values()][0]!;
    expect(val(a.actor)).toBe("申请人");
    expect(val(a.preconditions)).toEqual(["草稿状态"]);
    expect(val(a.effects)).toEqual(["进入审批流"]);
    expect(a.actor.origin).toBe("extracted");
  });

  it("**事件成为 OIR 一等公民**：emitted_by 解析成 Action rid、payload 解析成对象 rid", () => {
    const oir = buildOir(DATA, null, {});
    expect(oir.events.size).toBe(1);
    const e = [...oir.events.values()][0]!;
    expect(val(e.displayName)).toBe("采购申请已提交");
    expect(e.emittedBy).toEqual(["at_submitrequisition"]);
    expect(e.payload).toEqual(["ot_purchaserequisition"]);
    // 序列化键与右栏读法对齐
    const d = (oir.toDict() as any).events[0];
    expect(d.producerAction).toBe("at_submitrequisition");
    expect(d.objectIds).toEqual(["ot_purchaserequisition"]);
  });

  it("emitted_by 认不出时存原样 —— 宁可粗也不丢", () => {
    const oir = buildOir({
      ...DATA, actions: [],
      events: [{ api_name: "X", display_name: "已发生", emitted_by: "UnknownAction", ...SRC }],
    }, null, {});
    expect([...oir.events.values()][0]!.emittedBy).toEqual(["UnknownAction"]);
  });

  it("**没有事件时 toDict/stats 一个键都不多** —— 老会话字节原样", () => {
    const oir = buildOir({ objects: [], properties: [], links: [] }, null, {});
    expect("events" in (oir.toDict() as any)).toBe(false);
    expect("events" in oir.stats()).toBe(false);
  });
});

describe("规则桶（以前被 strictify 静默截掉的那类）", () => {
  it("表格段抽出的规则直接进 OIR，condition 一并落", () => {
    const oir = buildOir({
      objects: [{ api_name: "PurchaseRequisition", display_name: "采购申请", ...SRC }],
      properties: [], links: [],
      rules: [{ statement: "预估金额超过 50,000 元需总经理二级审批", kind: "AUTHORITY",
        actor: "总经理", applies_to: ["PurchaseRequisition"],
        condition: "estimatedAmount > 50000", ...SRC }],
    }, null, {});
    const r = [...oir.rules.values()][0]!;
    expect(val(r.condition)).toBe("estimatedAmount > 50000");
    expect(r.appliesTo).toEqual(["ot_purchaserequisition"]);
  });
});
