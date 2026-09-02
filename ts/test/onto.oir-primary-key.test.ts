/**
 * 主键的写入口（A8 的一块）。
 *
 * 起因：右栏挂着一枚「无主键」的补齐芯片，点了会预填一句指令 ——
 * 而在这之前，**模型无论怎么答都落不了盘**：schema 里有 `primaryKey`、
 * 抽取侧不产出、`add_object_type` 不收、`EDITABLE` 也没有它。
 * 实测真实库 527 个对象主键全空。
 * 和 flow.edit 缺 bind_objects 是同一个毛病：界面指着一个不存在的能力。
 */
import { describe, expect, it } from "vitest";

import { OIR, makeObjectType, inferred } from "../src/onto/oir.js";
import { applyOirEdit } from "../src/onto/oir_edit.js";

const val = (a: any) => (a && typeof a === "object" && "value" in a ? a.value : a);

describe("新建对象时带主键", () => {
  it("单主键和复合主键都收，落成断言而不是裸值", () => {
    const oir = new OIR();
    const note = applyOirEdit(oir, "add_object_type",
      { api_name: "PurchaseRequisition", display_name: "采购申请", primary_key: ["requisitionId"] });
    expect(note).toContain("主键 requisitionId");
    const o = [...oir.objects.values()][0]!;
    expect(val(o.primaryKey)).toEqual(["requisitionId"]);
    // 是人工口述，不能标成从材料抽的
    expect((o.primaryKey as any).origin).not.toBe("extracted");

    const oir2 = new OIR();
    applyOirEdit(oir2, "add_object_type",
      { api_name: "ExpenseDetail", primary_key: ["reportId", "lineNo"] });
    expect(val([...oir2.objects.values()][0]!.primaryKey)).toEqual(["reportId", "lineNo"]);
  });

  it("不给主键时行为不变 —— 老调用一个字节都不受影响", () => {
    const oir = new OIR();
    const note = applyOirEdit(oir, "add_object_type", { api_name: "Supplier" });
    expect(note).not.toContain("主键");
    expect(val([...oir.objects.values()][0]!.primaryKey)).toEqual([]);
  });
});

describe("给已存在的对象补主键", () => {
  /** **主路是这条** —— 真实库里的对象绝大多数是抽取建的，不会再走 add_object_type。 */
  const seeded = (): OIR => {
    const oir = new OIR();
    oir.addObject(makeObjectType({
      rid: "ot_pr", apiName: inferred("PurchaseRequisition"), displayName: inferred("采购申请"),
    }));
    return oir;
  };

  it("edit_assertion field=primary_key 能补上", () => {
    const oir = seeded();
    applyOirEdit(oir, "edit_assertion",
      { target: "采购申请", field: "primary_key", value: ["requisitionId"] });
    expect(val(oir.objects.get("ot_pr")!.primaryKey)).toEqual(["requisitionId"]);
  });

  it("给裸字符串也接 —— 单主键是最常见的情况，不该逼人写数组", () => {
    const oir = seeded();
    applyOirEdit(oir, "edit_assertion",
      { target: "采购申请", field: "primary_key", value: "requisitionId" });
    expect(val(oir.objects.get("ot_pr")!.primaryKey)).toEqual(["requisitionId"]);
  });

  it("primary_key 在可改字段表里 —— 报错文案会把它列出来", async () => {
    const { OIR_EDITABLE_FIELDS } = await import("../src/onto/oir_edit.js");
    expect([...OIR_EDITABLE_FIELDS]).toContain("primary_key");
  });
});
