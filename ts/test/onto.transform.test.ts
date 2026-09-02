/**
 * 声明式数据整理：动词有限、行数有账、整批事务。
 */
import { describe, expect, it } from "vitest";

import { applyTransform, coerceValue, TransformError } from "../src/onto/transform.js";

const T = {
  columns: ["订单号", "金额（元）", "状态", "供应商ID"],
  rows: [
    ["PO-1", "￥1,234.50", "已审批", "S1"],
    ["PO-2", "2000", "", "S2"],
    ["PO-2", "2000", "", "S2"],        // 重复行
    ["PO-3", "三千", "已审批", "S9"],   // 金额规不上
  ],
};

describe("applyTransform", () => {
  it("完整管道：改名→规整→去重→过滤，每一步都有行数账", () => {
    const r = applyTransform(T, [
      { op: "rename", map: { "金额（元）": "金额" } },
      { op: "coerce", column: "金额", type: "DECIMAL" },
      { op: "dedupe", by: ["订单号"] },
      { op: "filter", column: "状态", not_empty: true },
    ]);
    expect(r.columns).toEqual(["订单号", "金额", "状态", "供应商ID"]);
    // ￥1,234.50 → 1234.50；PO-2 去重掉一行；空状态过滤掉一行
    expect(r.rows.map((x) => x[0])).toEqual(["PO-1", "PO-3"]);
    expect(r.rows[0]![1]).toBe("1234.50");
    // 行数账：4 步各一条，坏行/丢行都有数
    expect(r.accounts).toHaveLength(4);
    expect(r.accounts[1]).toMatchObject({ op: "coerce", affected: 1 });
    expect(r.accounts[1]!.note).toContain("三千");   // 坏行样例点名
    expect(r.accounts[2]).toMatchObject({ op: "dedupe", affected: 1 });
    expect(r.accounts[3]).toMatchObject({ op: "filter", affected: 1 });
  });

  it("**coerce 不丢行** —— 规不上的保留原值；要删行必须用显式 filter", () => {
    const r = applyTransform(T, [{ op: "coerce", column: "金额（元）", type: "DECIMAL" }]);
    expect(r.rows).toHaveLength(4);
    expect(r.rows[3]![1]).toBe("三千"); // 原值还在
  });

  it("**整批事务** —— 第 2 步列名写错，第 1 步也不落（调用方数据原样）", () => {
    expect(() =>
      applyTransform(T, [
        { op: "rename", map: { "金额（元）": "金额" } },
        { op: "select", columns: ["订单号", "根本没有的列"] },
      ]),
    ).toThrow(/steps\[1\]（select）：没有列「根本没有的列」。现有列：订单号、金额/u);
    expect(T.rows[0]![1]).toBe("￥1,234.50"); // 输入没被改
  });

  it("join：左连、命中账、未命中留空、撞名列加前缀", () => {
    const suppliers = {
      columns: ["ID", "供应商名", "状态"],
      rows: [["S1", "宏发", "在册"], ["S2", "国泰", "在册"]],
    };
    const r = applyTransform(
      { columns: ["订单号", "供应商ID", "状态"], rows: [["PO-1", "S1", "已审批"], ["PO-9", "S404", "已审批"]] },
      [{ op: "join", with: "供应商.xlsx", on: { "供应商ID": "ID" } }],
      () => suppliers,
    );
    expect(r.columns).toEqual(["订单号", "供应商ID", "状态", "供应商名", "供应商.xlsx.状态"]);
    expect(r.rows[0]).toEqual(["PO-1", "S1", "已审批", "宏发", "在册"]);
    expect(r.rows[1]).toEqual(["PO-9", "S404", "已审批", "", ""]); // 未命中留空，不丢行
    expect(r.accounts[0]!.note).toContain("命中 1/2");
  });

  it("不认识的动词 → 一句人话带全量动词表，不是崩", () => {
    expect(() => applyTransform(T, [{ op: "pivot" }])).toThrow(/不认识的动词「pivot」。可用：/u);
  });
});

describe("coerceValue", () => {
  it.each([
    ["￥1,234.50", "DECIMAL", "1234.50"],
    ["2026年8月18日", "DATE", "2026-08-18"],
    ["2026/8/1", "DATE", "2026-08-01"],
    ["是", "BOOLEAN", "true"],
    ["3.5", "INTEGER", null],   // 不悄悄截断
    ["", "DECIMAL", ""],        // 空是缺数据，不是坏数据
    ["三千", "DECIMAL", null],
  ])("%s → %s = %s", (raw, type, want) => {
    expect(coerceValue(raw, type)).toBe(want);
  });
});

describe("T1 五个新动词", () => {
  it("union：按**列名**对齐并表 —— 按位置对齐在列序不同的月表上会串列", () => {
    const jan = { columns: ["订单号", "金额"], rows: [["PO-1", "100"]] };
    const feb = { columns: ["金额", "订单号", "备注"], rows: [["200", "PO-2", "急"]] };
    const r = applyTransform(jan, [{ op: "union", with: "2月.xlsx" }], () => feb);
    expect(r.rows).toEqual([["PO-1", "100"], ["PO-2", "200"]]);
    // 对方多出的列被丢弃要**记账**
    expect(r.accounts[0]!.note).toContain("备注");
  });

  it("union：对方缺列补空并点名", () => {
    const a = { columns: ["订单号", "金额", "状态"], rows: [["PO-1", "100", "已审批"]] };
    const b = { columns: ["订单号", "金额"], rows: [["PO-2", "200"]] };
    const r = applyTransform(a, [{ op: "union", with: "b.xlsx" }], () => b);
    expect(r.rows[1]).toEqual(["PO-2", "200", ""]);
    expect(r.accounts[0]!.note).toContain("状态");
  });

  it("unpivot：横表转长表 —— 行=部门、列=月份的矩阵进不了建模", () => {
    const wide = { columns: ["部门", "1月", "2月"], rows: [["采购部", "10", "20"], ["财务部", "5", "8"]] };
    const r = applyTransform(wide, [{ op: "unpivot", keep: ["部门"], name_to: "月份", value_to: "金额" }]);
    expect(r.columns).toEqual(["部门", "月份", "金额"]);
    expect(r.rows).toEqual([
      ["采购部", "1月", "10"], ["采购部", "2月", "20"],
      ["财务部", "1月", "5"], ["财务部", "2月", "8"],
    ]);
  });

  it("split：拆复合列，段数对不上的进坏行账、保留能拆出的部分", () => {
    const t = { columns: ["地区", "金额"], rows: [["广东/深圳/南山", "1"], ["北京/朝阳", "2"]] };
    const r = applyTransform(t, [{ op: "split", column: "地区", separator: "/", into: ["省", "市", "区"] }]);
    expect(r.columns).toEqual(["省", "市", "区", "金额"]);
    expect(r.rows[0]).toEqual(["广东", "深圳", "南山", "1"]);
    expect(r.rows[1]).toEqual(["北京", "朝阳", "", "2"]);
    expect(r.accounts[0]!).toMatchObject({ affected: 1 });
    expect(r.accounts[0]!.note).toContain("北京/朝阳");
  });

  it("aggregate sum：规不上数字的值不进和、进坏行账 —— 不许悄悄把「三千」当 0 又不说", () => {
    const t = { columns: ["部门", "金额"], rows: [["采购", "100"], ["采购", "￥1,900"], ["采购", "三千"], ["财务", "50"]] };
    const r = applyTransform(t, [{ op: "aggregate", by: ["部门"], column: "金额", fn: "sum" }]);
    expect(r.columns).toEqual(["部门", "金额_sum"]);
    expect(r.rows).toEqual([["采购", "2000"], ["财务", "50"]]);
    expect(r.accounts[0]!).toMatchObject({ affected: 1 });
  });

  it("merge_header：两级表头并入列名并删掉那一行 —— 解析层只认单行表头的补救", () => {
    const t = {
      columns: ["部门", "金额", "金额2"],
      rows: [["", "含税", "不含税"], ["采购", "100", "90"]],
    };
    const r = applyTransform(t, [{ op: "merge_header" }]);
    expect(r.columns).toEqual(["部门", "金额·含税", "金额2·不含税"]);
    expect(r.rows).toEqual([["采购", "100", "90"]]);
  });

  it("新动词同样事务性：union 的表读不到时整批不落", () => {
    const t = { columns: ["a"], rows: [["1"]] };
    expect(() => applyTransform(t, [
      { op: "rename", map: { a: "b" } },
      { op: "union", with: "x.xlsx" },
    ])).toThrow(/没有提供第二张表的读取通道/u);
    expect(t.columns).toEqual(["a"]);
  });
});
