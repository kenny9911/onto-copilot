/**
 * B5：finalize 的去重与嫁接。
 *
 * 两个病一起修：① 裸 api_name 撞键 —— 不同对象上的同名字段被当"重复"丢掉；
 * ② 同键相遇时模型那份被整条丢弃 —— 而这一段专门跑一轮模型就是为了拿口径，
 * outstanding() 注释承诺的「由 finalize() 合并（规则侧权威）」从没兑现过。
 *
 * 直接喂 `_pre`（prefilled 的缓存位）——列型判定是 shape 的责任，
 * 这条测试不该和它的分类阈值耦合。
 */
import { describe, expect, it } from "vitest";

import { ExtractSegment, Segment } from "../src/onto/pipeline.js";
import { inferShape } from "../src/onto/shape.js";

const RULE_PROPS = [
  { parent_api_name: "PurchaseOrder", api_name: "amount", display_name: "金额",
    base_type: "DECIMAL", required: true, definition: "", _origin: "rule",
    source_file: "x.xlsx", source_locator: "x!R2" },
  { parent_api_name: "PurchaseOrder", api_name: "orderNo", display_name: "订单编号",
    base_type: "STRING", required: true, definition: "", _origin: "rule",
    source_file: "x.xlsx", source_locator: "x!R3" },
];

function handler(): ExtractSegment {
  const segment = new Segment({
    key: "s0", label: "字段表", fileName: "x.xlsx", chunkIds: [],
    shape: inferShape([]),
  });
  const h = new ExtractSegment(segment, { get: () => null } as never,
    { outputSchema: null } as never, "sys");
  (h as unknown as { _pre: unknown })._pre = {
    objects: [], properties: RULE_PROPS.map((x) => ({ ...x })), links: [], actions: [], questions: [],
  };
  return h;
}

describe("finalize", () => {
  it("**嫁接口径**：规则行没有 definition、模型有 → 并进规则行，且不出现两条同名", () => {
    const out = handler().finalize({
      objects: [], links: [], actions: [],
      properties: [{
        parent_api_name: "PurchaseOrder", api_name: "amount",
        definition: "不含税，按下单时点汇率", base_type: "STRING", unit: "元",
      }],
    }, {}) as Record<string, unknown[]>;
    const props = out["properties"] as Record<string, unknown>[];
    const amount = props.filter((x) => String(x["api_name"]) === "amount");
    expect(amount).toHaveLength(1);
    // 口径嫁接进规则行
    expect(amount[0]!["definition"]).toBe("不含税，按下单时点汇率");
    expect(amount[0]!["unit"]).toBe("元");
    // 规则侧权威字段不被模型覆盖（表格里写的是 DECIMAL，模型说 STRING 不算数）
    expect(amount[0]!["base_type"]).toBe("DECIMAL");
    expect(amount[0]!["_origin"]).toBe("rule");
  });

  it("**不同宿主的同名字段不撞键**：Supplier.amount 不因 PurchaseOrder.amount 存在而被丢", () => {
    const out = handler().finalize({
      objects: [], links: [], actions: [],
      properties: [{ parent_api_name: "Supplier", api_name: "amount", definition: "供应商侧口径" }],
    }, {}) as Record<string, unknown[]>;
    const props = out["properties"] as Record<string, unknown>[];
    const suppliers = props.filter((x) => String(x["parent_api_name"]) === "Supplier");
    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]!["definition"]).toBe("供应商侧口径");
    // 规则那两条也都在
    expect(props).toHaveLength(3);
  });

  it("对象/行动仍按裸 api_name 去重 —— 它们没有宿主一说", () => {
    const h = handler();
    (h as unknown as { _pre: { objects: unknown[] } })._pre.objects = [
      { api_name: "PurchaseOrder", _origin: "rule" },
    ];
    const out = h.finalize({
      properties: [], links: [], actions: [],
      objects: [{ api_name: "purchaseorder", description: "模型重复抽的" }],
    }, {}) as Record<string, unknown[]>;
    expect(out["objects"]).toHaveLength(1);
  });
});
