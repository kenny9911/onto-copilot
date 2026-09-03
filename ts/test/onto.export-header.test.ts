/**
 * 文稿的文档头。
 *
 * 2026-08-25 用户要求「对我们生成的所有的文稿都好好设计」。盘点下来，
 * **没有任何一份导出件带文档头** —— 全部出处信息只有 `note` 那一个字符串。
 * 一份交到业务方手上的确认稿，看不出：是谁生成的、什么时候、基于哪一版模型、
 * 依据是客户材料还是通用假设、用了哪些材料、填完往哪回传。
 * 这些恰恰是收件人第一时间要问的，而它们全都在系统里有答案。
 *
 * 两条纪律：
 *  · **不传 meta 就与现在逐字节相同** —— golden/onto.export.json 钉着字节，
 *    文档头必须是加法，不能是改法；
 *  · **时间由调用方传入**，不许模块内部读时钟 —— 那会打破「同样输入同样字节」
 *    （export.ts 的 ZIP_EPOCH 就是为这条存在的）。
 */

import { describe, expect, it } from "vitest";

import { makeExportDoc, docHeaderBlocks, toMarkdown, toXlsx } from "../src/onto/export.js";

const META = {
  purpose: "请业务方逐行确认流程环节",
  audience: "采购监督部门 / 业务负责人",
  generatedAt: "2026-08-25 19:30",
  basis: "通用假设（尚未绑定客户材料）",
  materials: ["采购全链路执行偏差三级预警场景方案.xlsx"],
  revision: "第 3 版",
  releaseState: "DRAFT",
  returnTo: "填完这份表回传给 FDE，或直接回复本对话",
};

describe("docHeaderBlocks", () => {
  it("产出一张两列表：每一项都是收件人第一时间会问的", () => {
    const blocks = docHeaderBlocks(META);
    const table = blocks.find((b) => b.kind === "table")!;
    const rows = (table as unknown as { rows: string[][] }).rows;
    const flat = rows.map((r) => r.join("｜")).join("\n");
    for (const want of ["用途", "给谁看", "生成时间", "依据", "模型版本", "发布状态", "材料", "回传"]) {
      expect(flat, `文档头缺「${want}」`).toContain(want);
    }
    expect(flat).toContain("2026-08-25 19:30");
    expect(flat).toContain("采购全链路执行偏差三级预警场景方案.xlsx");
  });

  it("缺项就不占行 —— 空着的格子比没有这一行更让人犯嘀咕", () => {
    const blocks = docHeaderBlocks({ purpose: "只有用途" });
    const rows = (blocks.find((b) => b.kind === "table") as unknown as { rows: string[][] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toContain("用途");
  });

  it("一项都没有就一个块都不产 —— 不许出现一张空的文档头表", () => {
    expect(docHeaderBlocks({})).toEqual([]);
  });

  it("多份材料列成一行，不是每份一行（文档头是索引不是清单）", () => {
    const blocks = docHeaderBlocks({ materials: ["a.xlsx", "b.docx", "c.pdf"] });
    const rows = (blocks.find((b) => b.kind === "table") as unknown as { rows: string[][] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toContain("a.xlsx");
    expect(rows[0]![1]).toContain("c.pdf");
  });
});

describe("makeExportDoc(meta)", () => {
  it("给了 meta 就把文档头排在正文最前", () => {
    const doc = makeExportDoc({ title: "业务确认稿", blocks: [], meta: META });
    const md = new TextDecoder().decode(toMarkdown(doc));
    expect(md).toContain("业务确认稿");
    expect(md).toContain("请业务方逐行确认流程环节");
    // 文档头在标题之后、正文之前
    expect(md.indexOf("请业务方逐行确认")).toBeGreaterThan(md.indexOf("业务确认稿"));
  });

  it("**不给 meta 就与现在逐字节相同** —— 文档头是加法不是改法", () => {
    const bare = makeExportDoc({ title: "清单", blocks: [], note: "n" });
    // 空 meta 也不许多出任何字节（一项都没有 → 一个块都不产）
    const emptyMeta = makeExportDoc({ title: "清单", blocks: [], note: "n", meta: {} });
    expect(toMarkdown(emptyMeta)).toEqual(toMarkdown(bare));
    expect(toXlsx(emptyMeta)).toEqual(toXlsx(bare));
  });

  it("tables getter 不把文档头算成内容表 —— 回执里的「表格行数」不该被它污染", () => {
    const doc = makeExportDoc({ title: "t", blocks: [], meta: META });
    expect(doc.tables.filter((b) => (b as unknown as { docHeader?: boolean }).docHeader !== true))
      .toHaveLength(0);
  });
});
