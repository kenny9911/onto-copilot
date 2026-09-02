/**
 * 「他说的那张表」到底是哪一张。
 *
 * 真实事故：屏幕上那张表叫「采购报销工作流控制链路（Action 与 Event 映射）」，
 * 模型转述成「采购报销通用Action与Event流程映射表」去导 —— 字面一个字都对不上，
 * 指的却是同一张。旧的三档匹配（全等/包含/反包含）全部落空，于是一次导出变成
 * 「猜名字 → 失败 → 读候选 → 再猜」，白烧一轮对话。
 */
import { describe, expect, it } from "vitest";

import { pickTable, titleSimilarity } from "../src/server/pipeline/tables.js";

const t = (title: string): Record<string, unknown> => ({ title, columns: ["a"], rows: [["1"]] });

const CONVERSATION = [
  t("通用采购报销流程待确认差异点与验证问题"),
  t("通用采购报销动作与状态规则设计框架"),
  t("当前已登记的数据对象列表"),
  t("采购报销通用 Ontology 实体与关系草案"),
  t("采购报销工作流控制链路（Action 与 Event 映射）"),
];

describe("表名解析", () => {
  it("模型自己转述的名字也能落到同一张表上", () => {
    const hit = pickTable(CONVERSATION, "采购报销通用Action与Event流程映射表");
    expect(hit?.["title"]).toBe("采购报销工作流控制链路（Action 与 Event 映射）");
  });

  it("全等/包含仍然优先，模糊匹配只在前几档落空时兜底", () => {
    expect(pickTable(CONVERSATION, "当前已登记的数据对象列表")?.["title"])
      .toBe("当前已登记的数据对象列表");
    expect(pickTable(CONVERSATION, "数据对象")?.["title"]).toBe("当前已登记的数据对象列表");
  });

  it("**不乱认**：完全无关的名字仍然返回 null，而不是硬塞一张最像的给用户", () => {
    expect(pickTable(CONVERSATION, "供应商准入评估打分表")).toBeNull();
    expect(pickTable(CONVERSATION, "季度营收")).toBeNull();
  });

  // ── 2026-08-25 实拍事故 ────────────────────────────────────────
  // 用户让它把「补料与提问框架」导成 Excel，拿到的却是一张 1 行的业务规则表
  // （列名「规则/类别/角色」）。原因：同一个会话里每张表的标题都以话题前缀
  // 「采购过程监督流程」开头，模糊分被这个共同前缀顶过了 0.34 的线 ——
  // 实测请求名对「业务规则草案」0.457、对「业务对象草案」0.400、
  // 对「属性定义草案」0.400，三张全过线，于是"最像的那张"纯属排序噪声。
  // 判据必须要求**明显胜出**：几张挨得很近时，那是名字没说清，该问，不该猜。
  const TOPIC_PREFIXED = [
    t("采购过程监督流程 - 业务对象草案（待验证假设）"),
    t("采购过程监督流程 - 属性定义草案（待验证假设）"),
    t("采购过程监督流程 - 业务规则草案（待验证假设）"),
  ];

  it("同话题的几张表分数挨在一起时判「说不准」，不硬塞最像的那张", () => {
    expect(pickTable(TOPIC_PREFIXED, "采购过程监督流程数据与规则补料提问框架")).toBeNull();
  });

  it("话题前缀不该带信息量：表真的在场时，要认出「补料与提问框架」那一张", () => {
    // 事故的另一半：即便正确的表已经在对话里，它也只得 0.389，输给共享前缀的
    // 「业务规则草案」0.457 —— 因为「采购/过程/监督/流程」这些字组在**每张表**里
    // 都有，纯前缀却贡献了大部分分数。按候选集给字组加权（越多张表共有的越不算数），
    // 「补料」「提问」「框架」这些只此一家的字组才是真正的判据。
    const withReal = [...TOPIC_PREFIXED, t("采购监督业务 Ontology 补料与提问框架")];
    expect(pickTable(withReal, "采购过程监督流程数据与规则补料提问框架")?.["title"])
      .toBe("采购监督业务 Ontology 补料与提问框架");
  });

  it("真正指名道姓的仍然认得出 —— 拉开差距才算数", () => {
    expect(pickTable(TOPIC_PREFIXED, "采购过程监督流程业务规则草案")?.["title"])
      .toBe("采购过程监督流程 - 业务规则草案（待验证假设）");
    // 原有那条「转述也能认出」的能力不能被这道闸误伤（见本文件第一条用例）
    expect(pickTable(CONVERSATION, "采购报销通用Action与Event流程映射表")?.["title"])
      .toBe("采购报销工作流控制链路（Action 与 Event 映射）");
  });

  it("不给名字就是最后一张；一张都没有时是 null", () => {
    expect(pickTable(CONVERSATION, "")?.["title"]).toBe("采购报销工作流控制链路（Action 与 Event 映射）");
    expect(pickTable([], "随便")).toBeNull();
  });

  it("相似度对括号、全半角、连接词不敏感", () => {
    expect(titleSimilarity("采购报销工作流控制链路（Action 与 Event 映射）",
      "采购报销工作流控制链路 Action Event 映射")).toBeGreaterThan(0.8);
    expect(titleSimilarity("季度营收", "采购报销工作流控制链路")).toBeLessThan(0.2);
  });
});
