/**
 * 第 2 层「二轮编辑动词」首批：merge_objects / set_status_batch / dependents 补规则。
 *
 * merge 是 FDE 二轮最高频的意图（两个抽重了的对象合并），此前走不通：remove 被
 * 出处守卫拦（材料抽出来的不能硬删——那条守卫防的是**丢证据**），remove+add 又
 * 真的丢证据。merge 的全部契约就是「证据一条不丢」：
 *   · 被并对象的断言证据**并集**进幸存者；
 *   · 被并对象的名字记进幸存者 aliases——老名字仍然能找到它；
 *   · 属性迁移；同 api_name 的属性合并证据后去重；
 *   · 关系端点改写；并出来的自环丢弃（并且要说）；
 *   · Action/Rule 的 appliesTo 改写去重；
 *   · 主键：幸存者没有而被并者有 → 收养。
 * 有了这些，删除守卫对 merge 不适用是**有原则的例外**，不是放宽。
 */
import { describe, expect, it } from "vitest";

import {
  BaseType,
  OIR,
  Status,
  extracted,
  inferred,
  makeActionType,
  makeBusinessRule,
  makeLinkType,
  makeObjectType,
  makePropertyType,
  makeProvenance,
} from "../src/onto/oir.js";
import { applyOirEdit, OIREditError } from "../src/onto/oir_edit.js";

const P1 = makeProvenance("f1", "材料A.xlsx", { row: 3 }, { snippet: "采购订单", extractor: "rule", confidence: 0.9 });
const P2 = makeProvenance("f2", "材料B.docx", { para: 7 }, { snippet: "订单", extractor: "rule", confidence: 0.9 });
const P3 = makeProvenance("f2", "材料B.docx", { para: 9 }, { snippet: "金额", extractor: "rule", confidence: 0.9 });

function fixture(): OIR {
  const oir = new OIR();
  const A = makeObjectType({ rid: "do.po", apiName: extracted("purchaseOrder", P1), displayName: extracted("采购订单", P1) });
  const B = makeObjectType({
    rid: "do.order", apiName: extracted("order", P2), displayName: extracted("订单", P2),
    primaryKey: extracted(["orderNo"], P2),
  });
  const C = makeObjectType({ rid: "do.supplier", apiName: inferred("supplier"), displayName: inferred("供应商") });
  const pA1 = makePropertyType({ rid: "attr.po.amount", parent: "do.po", apiName: extracted("amount", P1), displayName: extracted("金额", P1), baseType: inferred(BaseType.DECIMAL) });
  const pB1 = makePropertyType({ rid: "attr.order.amount", parent: "do.order", apiName: extracted("amount", P3), displayName: extracted("金额", P3), baseType: inferred(BaseType.DECIMAL) });
  const pB2 = makePropertyType({ rid: "attr.order.no", parent: "do.order", apiName: extracted("orderNo", P2), displayName: extracted("单号", P2), baseType: inferred(BaseType.STRING) });
  A.properties.push(pA1.rid);
  B.properties.push(pB1.rid, pB2.rid);
  for (const o of [A, B, C]) oir.objects.set(o.rid, o);
  for (const p of [pA1, pB1, pB2]) oir.properties.set(p.rid, p);
  oir.links.set("rel.b_c", makeLinkType({
    rid: "rel.b_c", apiName: inferred("orderSupplier"), source: "do.order", target: "do.supplier",
    cardinality: inferred("N:1" as never),
  }));
  oir.links.set("rel.a_b", makeLinkType({
    rid: "rel.a_b", apiName: inferred("poOrder"), source: "do.po", target: "do.order",
    cardinality: inferred("1:1" as never),
  }));
  oir.actions.set("act.approve", makeActionType({ rid: "act.approve", apiName: inferred("approve"), appliesTo: ["do.order"] }));
  oir.rules.set("rule.limit", makeBusinessRule({
    rid: "rule.limit", statement: extracted("超 5 万需总监加签", P2), appliesTo: ["do.order", "do.supplier"],
  }));
  return oir;
}

describe("merge_objects", () => {
  it("证据一条不丢：并集进幸存者，老名字记为别名，被并对象消失", () => {
    const oir = fixture();
    const note = applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "订单" }, { source: "user" });
    expect(note).toContain("并入");
    expect(oir.objects.has("do.order")).toBe(false);
    const A = oir.objects.get("do.po")!;
    expect(A.aliases).toContain("订单");
    expect(A.aliases).toContain("order");
    // displayName 证据并集：P1 + P2
    expect(A.displayName.evidence).toHaveLength(2);
    // 主键收养：A 原本没有
    expect(A.primaryKey.value).toEqual(["orderNo"]);
  });

  it("属性迁移；同 api_name 合并证据后去重", () => {
    const oir = fixture();
    applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "订单" }, { source: "user" });
    const A = oir.objects.get("do.po")!;
    // pB2（orderNo）迁移过来；pB1（amount）与 pA1 同名 → 合并证据后删除
    expect(oir.properties.get("attr.order.no")!.parent).toBe("do.po");
    expect(A.properties).toContain("attr.order.no");
    expect(oir.properties.has("attr.order.amount")).toBe(false);
    const pA1 = oir.properties.get("attr.po.amount")!;
    expect(pA1.displayName.evidence).toHaveLength(2); // P1 + P3
  });

  it("关系端点改写；并出来的自环丢弃并写进回执", () => {
    const oir = fixture();
    const note = applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "订单" }, { source: "user" });
    expect(oir.links.get("rel.b_c")!.source).toBe("do.po");
    expect(oir.links.has("rel.a_b")).toBe(false); // A→B 并成 A→A，自环
    expect(note).toContain("自环");
  });

  it("Action / Rule 的 appliesTo 改写并去重", () => {
    const oir = fixture();
    applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "订单" }, { source: "user" });
    expect(oir.actions.get("act.approve")!.appliesTo).toEqual(["do.po"]);
    expect(oir.rules.get("rule.limit")!.appliesTo).toEqual(["do.po", "do.supplier"]);
  });

  it("并自己、并不存在的：拒绝且一个字节不变（原子性由 trial 副本保证）", () => {
    const oir = fixture();
    const before = JSON.stringify(oir.toDict());
    expect(() => applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "采购订单" }, { source: "user" }))
      .toThrow(OIREditError);
    expect(() => applyOirEdit(oir, "merge_objects", { into: "采购订单", from: "不存在" }, { source: "user" }))
      .toThrow();
    expect(JSON.stringify(oir.toDict())).toBe(before);
  });
});

describe("set_status_batch", () => {
  it("一次落一批拍板：对象与规则混着标 confirmed", () => {
    const oir = fixture();
    const note = applyOirEdit(
      oir, "set_status_batch",
      { targets: ["采购订单", "rule.limit"], status: "confirmed" }, { source: "user" },
    );
    expect(note).toContain("2");
    expect(oir.objects.get("do.po")!.status).toBe(Status.CONFIRMED);
    expect(oir.rules.get("rule.limit")!.status).toBe(Status.CONFIRMED);
  });

  it("有一个指不到就整批不落 —— 半批落地比失败更糟", () => {
    const oir = fixture();
    const before = JSON.stringify(oir.toDict());
    expect(() => applyOirEdit(
      oir, "set_status_batch",
      { targets: ["采购订单", "不存在的东西"], status: "confirmed" }, { source: "user" },
    )).toThrow();
    expect(JSON.stringify(oir.toDict())).toBe(before);
  });
});

describe("dependents 补规则（影响分析 C1 缺口）", () => {
  it("「改这个对象会波及哪些规则」现在答得出来", () => {
    const oir = fixture();
    expect(oir.dependents("do.order")).toContain("rule.limit");
  });
});

describe("rename 带引用传播（B2 缺口）", () => {
  it("属性改 api_name：父对象 primaryKey 里的旧名跟着走", () => {
    const oir = fixture();
    applyOirEdit(
      oir, "edit_assertion",
      { target: "attr.order.no", field: "api_name", value: "soNo" }, { source: "user" },
    );
    expect(oir.properties.get("attr.order.no")!.apiName.value).toBe("soNo");
    expect(oir.objects.get("do.order")!.primaryKey.value).toEqual(["soNo"]);
  });

  it("对象改名：旧名记为别名，按旧名还能找到它", () => {
    const oir = fixture();
    applyOirEdit(
      oir, "edit_assertion",
      { target: "采购订单", field: "display_name", value: "采购订单头" }, { source: "user" },
    );
    const A = oir.objects.get("do.po")!;
    expect(A.displayName.value).toBe("采购订单头");
    expect(A.aliases).toContain("采购订单");
    // findObject 认别名 —— 改名之后旧称呼不失联
    const again = applyOirEdit(
      oir, "edit_assertion",
      { target: "采购订单", field: "description", value: "采购订单头表" }, { source: "user" },
    );
    expect(again).toContain("采购订单头");
  });
});

describe("破坏性编辑先看影响（C4，OIR 侧）", () => {
  it("remove_object_type 有波及时要 confirm，波及清单先给；confirm=true 才级联", () => {
    const oir = fixture();
    applyOirEdit(oir, "add_object_type", { api_name: "draftThing", display_name: "草稿对象" }, { source: "user" });
    applyOirEdit(oir, "add_property", { object: "草稿对象", api_name: "code", display_name: "编码" }, { source: "user" });
    expect(() => applyOirEdit(oir, "remove_object_type", { target: "草稿对象" }, { source: "user" }))
      .toThrow(/confirm/);
    expect(oir.objects.size).toBe(4);
    const note = applyOirEdit(
      oir, "remove_object_type", { target: "草稿对象", confirm: true }, { source: "user" },
    );
    expect(note).toContain("删掉");
    expect(oir.objects.size).toBe(3);
  });

  it("没有任何波及的对象删除不需要 confirm", () => {
    const oir = fixture();
    applyOirEdit(oir, "add_object_type", { api_name: "lonely", display_name: "孤零对象" }, { source: "user" });
    applyOirEdit(oir, "remove_object_type", { target: "孤零对象" }, { source: "user" });
    expect(oir.objects.has("do.lonely") || [...oir.objects.values()].some((o) => o.apiName.value === "lonely")).toBe(false);
  });
});
