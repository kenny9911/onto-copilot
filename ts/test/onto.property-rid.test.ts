/**
 * 属性 rid 里不能有段内数组下标（B4）。
 *
 * 真实库里直接看得到抽取产的形态：`pt_person_name_0`、`pt_organization_org_name_1`
 * ——尾巴那个数字是该段 properties 数组的位置。而模板回传是按 `(rid, 字段)`
 * 匹配的（onto/audit.ts 的 ridFieldKey），于是这条链是：
 * 补料 → 重跑抽取 → 模型输出顺序一变 → rid 变 →
 * **业务顾问填好的那份模板一格都对不上，而且不报错。**
 *
 * id 里嵌「这次恰好排第几」，等于把稳定标识绑在了模型的心情上。
 */
import { describe, expect, it } from "vitest";

import { buildOir } from "../src/onto/pipeline.js";

const P = (parent: string, api: string, extra: Record<string, unknown> = {}) =>
  ({ parent_api_name: parent, api_name: api, ...extra });

const data = (properties: Record<string, unknown>[]) => ({
  objects: [{ api_name: "PurchaseOrder", display_name: "采购订单" }],
  properties,
  links: [],
});

describe("属性 rid", () => {
  it("**rid 只由 (父对象, apiName) 决定** —— 换个顺序抽出来必须还是同一个 rid", () => {
    const a = buildOir(data([P("PurchaseOrder", "orderNo"), P("PurchaseOrder", "amount")]), null, {});
    const b = buildOir(data([P("PurchaseOrder", "amount"), P("PurchaseOrder", "orderNo")]), null, {});
    const rids = (o: any) => [...o.properties.keys()].sort();
    expect(rids(a)).toEqual(rids(b));
    // 而且里面没有下标尾巴
    expect(rids(a).every((r: string) => !/_\d+$/u.test(r))).toBe(true);
  });

  it("rid 认得出是谁的哪个字段 —— 回传匹配靠的就是它", () => {
    const oir = buildOir(data([P("PurchaseOrder", "orderNo")]), null, {});
    expect([...oir.properties.keys()]).toEqual(["pt_purchaseorder_orderno"]);
  });

  it("**同名字段撞车要记账，不静默跳过** —— 以前靠下标错开，等于把重复藏起来", () => {
    const dropped: Record<string, unknown> = {};
    const oir = buildOir(
      data([P("PurchaseOrder", "amount", { definition: "含税" }),
        P("PurchaseOrder", "amount", { definition: "不含税" })]),
      null, dropped,
    );
    expect(oir.properties.size).toBe(1);
    expect(dropped["properties"]).toBe(1);
    expect(dropped["property_dupes"]).toEqual(["PurchaseOrder.amount"]);
  });

  it("不撞就不出 property_dupes 这个键 —— 每份统计都挂个空数组只会更难看出问题", () => {
    const dropped: Record<string, unknown> = {};
    buildOir(data([P("PurchaseOrder", "orderNo")]), null, dropped);
    expect("property_dupes" in dropped).toBe(false);
  });

  it("不同对象上的同名字段互不影响", () => {
    const oir = buildOir({
      objects: [{ api_name: "A" }, { api_name: "B" }],
      properties: [P("A", "code"), P("B", "code")],
      links: [],
    }, null, {});
    expect(oir.properties.size).toBe(2);
  });
});
