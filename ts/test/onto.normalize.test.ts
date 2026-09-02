/**
 * 语料归一 —— 表册 + 字段字典。
 *
 * 这批断言里有几条是**被真材料教出来的**（9 份采购领域材料、3816 片切片），
 * 合成 fixture 一条都测不出来：
 *
 *   * 第一版只判 `raw` 是不是字典，结果字段字典的前五名成了
 *     `bbox` / `id` / `name` / `text` / `columns`，各 307 处 —— 那是 pptx
 *     **文本框**切片的形状元数据，把真正的业务字段全挤到了后面。判据因此改成
 *     正面白名单（必须标了 table/row）。
 *   * 真材料里「业务对象」跨 6 份材料有 3 种叫法、「应用服务」跨 3 份有 4 种 ——
 *     这类跨材料口径分歧正是这一层要交付的东西，而合成 fixture 里没有。
 */
import { describe, expect, it } from "vitest";

import { normalizeCorpus, normalizedToDoc } from "../src/onto/normalize.js";
import { makeChunk, makeParsedDoc } from "../src/onto/parse/base.js";
import type { ParsedDoc } from "../src/onto/parse/base.js";

function row(
  fileId: string,
  fileName: string,
  sheet: string,
  n: number,
  raw: Record<string, string>,
  tags: string[] = ["row"],
): ReturnType<typeof makeChunk> {
  return makeChunk({
    docId: `${sheet}:r${n}`,
    fileId,
    fileName,
    locator: { kind: "range", sheet, rows: [n, n] },
    render: Object.entries(raw).map(([k, v]) => `${k}=${v}`).join(" | "),
    raw,
    order: n,
    tags,
  });
}

function doc(name: string, chunks: ReturnType<typeof makeChunk>[]): ParsedDoc {
  // makeParsedDoc 只收三个字段，chunks 要单独灌 —— 它每次给新容器，
  // 就是为了防止两份 ParsedDoc 共享同一个数组。
  const d = makeParsedDoc({ fileId: `f_${name}`, fileName: name, kind: "xlsx" });
  d.chunks.push(...chunks);
  return d;
}

describe("表册与字段字典", () => {
  const a = doc("甲.xlsx", [
    row("f1", "甲.xlsx", "采购订单", 2, { 订单号: "PO-1", 金额: "100", 供应商: "S1" }),
    row("f1", "甲.xlsx", "采购订单", 3, { 订单号: "PO-2", 金额: "200", 供应商: "S2" }),
  ]);
  const b = doc("乙.xlsx", [
    row("f2", "乙.xlsx", "订单明细", 2, { 供应商编码: "S1", 行号: "1" }),
  ]);
  const n = normalizeCorpus([a, b]);

  it("按「文件 + 容器」登记成表，行数列数都算对", () => {
    expect(n.tables.map((t) => `${t.file}|${t.container}|${t.rowCount}|${t.columns.length}`))
      .toEqual(["乙.xlsx|订单明细|1|2", "甲.xlsx|采购订单|2|3"]);
  });

  it("字段带列画像 —— 复用 profileColumn，不另写一套推断", () => {
    const amount = n.fields.find((f) => f.key === "金额");
    expect(amount).toBeDefined();
    expect(amount!.occurrences[0]!.profile).not.toBeNull();
    expect(amount!.occurrences[0]!.profile!.inferred_type).toBeTruthy();
  });

  it("**叫法不同但含义相同的字段合成一条**，并把两种叫法都留着", () => {
    // 「供应商」vs「供应商编码」：二元组交集 3/5，够。两个名字都要留在 names 里，
    // 因为归一是猜的，人要能核对。真材料里合上的正是这一类
    // （业务活动 / 业务活动编码、L3业务对象 / 业务对象 / 业务对象定义）。
    const f = n.fields.find((x) => x.names.includes("供应商") && x.names.includes("供应商编码"));
    expect(f, "供应商 / 供应商编码 应该合成一条").toBeDefined();
    expect(f!.occurrences.length).toBe(2);
  });

  it("跨材料叫法不同要**报成冲突**，不许静默合并", () => {
    const f = n.fields.find((x) => x.names.includes("供应商") && x.names.includes("供应商编码"))!;
    expect(f.conflicts.some((c) => c.includes("叫法"))).toBe(true);
  });

  // **已知局限，显式钉住而不是藏起来。**
  //
  // 短名字差一个字时二元组重叠不够：「订单号」={订单,单号}、「订单编号」=
  // {订单,单编,编号}，交集 1、并集 4，Jaccard 0.25 —— 合不上。人一眼能看出
  // 它们是同一个字段，算法看不出。
  //
  // 不为此放松阈值：**错合比漏合坏得多**。漏合的后果是字典里多一条，人一眼
  // 就能发现并手动归并；错合的后果是两个不同字段的证据被搅在一起，而且会沿着
  // 抽取链一路传下去，等发现时已经进了 Ontology。
  it("短名字的一字之差合不上 —— 已知局限，宁可漏合不可错合", () => {
    const d1 = doc("甲.xlsx", [row("f1", "甲.xlsx", "S", 2, { 订单号: "A" })]);
    const d2 = doc("乙.xlsx", [row("f2", "乙.xlsx", "T", 2, { 订单编号: "A" })]);
    const keys = normalizeCorpus([d1, d2]).fields.map((f) => f.key).sort();
    expect(keys).toEqual(["订单号", "订单编号"]);
  });

  it("含义不同的字段不许合 —— 阈值不能松到把「金额」和「行号」并一起", () => {
    const keys = n.fields.map((f) => f.key);
    const amount = n.fields.find((f) => f.names.includes("金额"))!;
    expect(amount.names).not.toContain("行号");
    expect(keys).toContain("订单号");
  });
});

describe("哪些切片算数据行", () => {
  it("**pptx 文本框不算** —— 它的 raw 是 {id,name,text,bbox} 形状元数据", () => {
    // 这一条是真材料教的：不挡的话字段字典前五名会变成 bbox/id/name/text，
    // 各 307 处，真正的业务字段全被挤到后面。
    const d = doc("演示.pptx", [
      row("f3", "演示.pptx", "", 1, { id: "7", name: "TextBox 3", text: "标题", bbox: "0,0" },
        ["pptx", "slide_text"]),
      row("f3", "演示.pptx", "", 2, { 字段: "plan_amount", 口径: "含税" }, ["pptx", "table"]),
    ]);
    const n = normalizeCorpus([d]);
    const keys = n.fields.map((f) => f.key);
    expect(keys).toContain("字段");
    for (const noise of ["bbox", "id", "name", "text"]) {
      expect(keys, `${noise} 不该出现在字段字典里`).not.toContain(noise);
    }
  });

  it("表头切片（schema）不算 —— 形状像行，语义是列定义", () => {
    const d = doc("演示.pptx", [
      row("f4", "演示.pptx", "", 1, { columns: "a,b,c" }, ["pptx", "table", "schema"]),
    ]);
    expect(normalizeCorpus([d]).fields).toEqual([]);
  });

  it("没打过 table/row 标签的一律不算 —— 白名单，最坏是漏不是脏", () => {
    const d = doc("说明.docx", [
      row("f5", "说明.docx", "", 1, { 随便: "什么" }, ["para"]),
    ]);
    expect(normalizeCorpus([d]).fields).toEqual([]);
    expect(normalizeCorpus([d]).coverage.proseChunks).toBe(1);
  });
});

describe("确定性", () => {
  const d = doc("甲.xlsx", [
    row("f1", "甲.xlsx", "S", 2, { 甲: "1", 乙: "2" }),
    row("f1", "甲.xlsx", "S", 3, { 甲: "3", 乙: "4" }),
  ]);
  it("同样的输入两次跑出**逐字段相同**的字典 —— 零模型调用", () => {
    expect(normalizeCorpus([d])).toEqual(normalizeCorpus([d]));
  });

  it("导出成两张表：表册总览 + 字段字典，且 note 里写明归一是猜的", () => {
    const ex = normalizedToDoc(normalizeCorpus([d]));
    expect(ex.blocks.map((b) => b.text)).toEqual(["表册总览", "字段字典"]);
    expect(ex.note).toContain("请核对");
  });
});
