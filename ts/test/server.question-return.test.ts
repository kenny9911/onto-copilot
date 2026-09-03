/**
 * 访谈包回传（R4）：业务顾问填完「您的回答」传回来，逐条对回台账。
 *
 * 纯函数部分（嗅探/解析）直接测；路由级的分流与幂等由 artifacts 侧用例盖。
 */
import { describe, expect, it } from "vitest";

import { EXPORT_HEADERS, parseQuestionReturn, sniffQuestionReturn } from "../src/server/routes/questions.js";
import { QuestionBacklog } from "../src/onto/questions.js";

const KIT_HEAD = ["问题ID", "问题", "为什么问", "期望获得的答案", "您的回答（请填写）", "例外与备注"];

function backlog(): QuestionBacklog {
  return QuestionBacklog.fromDict({
    questions: [
      { id: "q-1", text: "审批金额含税吗？", status: "open" },
      { id: "q-2", text: "谁能作废？", status: "answered" },
    ],
  });
}

describe("访谈包回传件", () => {
  it("嗅探：问题ID + 您的回答 两列齐了才算；模板回传件不误伤", () => {
    expect(sniffQuestionReturn([{ rows: [KIT_HEAD] }])).toBe(true);
    // 模板回传件的表头长别的样子
    expect(sniffQuestionReturn([{ rows: [["对象", "字段", "口径", "示例"]] }])).toBe(false);
    expect(sniffQuestionReturn([{ rows: [] }])).toBe(false);
  });

  it("**业务方在顶上加标题行是常态** —— 表头允许出现在前 8 行", () => {
    const rows = [
      ["XX 公司报销流程访谈记录"],
      ["填写人：王会计　日期：2026-08-18"],
      KIT_HEAD,
      ["q-1", "审批金额含税吗？", "", "", "不含税", "劳务费除外"],
    ];
    expect(sniffQuestionReturn([{ rows }])).toBe(true);
    const parsed = parseQuestionReturn([{ rows }], backlog());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ qid: "q-1", answer: "不含税", note: "劳务费除外", match: "open" });
  });

  it("三类行都逐条给判定：open / already_answered / not_found —— 一格都不静默丢", () => {
    const rows = [
      KIT_HEAD,
      ["q-1", "", "", "", "不含税", ""],
      ["q-2", "", "", "", "总监", ""],          // 已答过
      ["q-99", "", "", "", "随便", ""],          // 对不上号
      ["q-1", "", "", "", "重复行", ""],          // 同 ID 只取第一条
      ["", "", "", "", "没有ID", ""],             // 没 ID 跳过
      ["q-x", "", "", "", "", ""],                // 没答案跳过
    ];
    const parsed = parseQuestionReturn([{ rows }], backlog());
    expect(parsed.map((r) => [r.qid, r.match])).toEqual([
      ["q-1", "open"],
      ["q-2", "already_answered"],
      ["q-99", "not_found"],
    ]);
    // open 行还带原题文本，预审时 FDE 能对着看
    expect(parsed[0]!.text).toBe("审批金额含税吗？");
  });
});

// ── 问题清单.xlsx 与回传闭环（发现 1 的修复）────────────────────────
//
// 界面「问题清单 XLSX」按钮给的那份文件以前**没有回答列**：FDE 顺手发给业务方、
// 对方填在旁边传回来，嗅探认不出（缺「您的回答」列），落进模板审核分支报损伤。
// 修法是把回传载体两列铺进导出表头 —— 从此界面上任何一份问题清单都是合法回传件。
describe("问题清单.xlsx 即回传件", () => {
  it("导出表头自带「您的回答」载体列，嗅探直接认", () => {
    expect(EXPORT_HEADERS).toContain("您的回答（请填写）");
    expect(EXPORT_HEADERS).toContain("例外与备注");
    expect(sniffQuestionReturn([{ rows: [[...EXPORT_HEADERS]] }])).toBe(true);
  });

  it("按导出列序填答案，解析能对回台账", () => {
    const row = [1, "审批金额含税吗？", "open", "high", "业务负责人", "",
      "口径不明", "", "", "q-1", "不含税", "劳务费除外"];
    const parsed = parseQuestionReturn(
      [{ rows: [[...EXPORT_HEADERS], row] }], backlog(),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      qid: "q-1", answer: "不含税", note: "劳务费除外", match: "open",
    });
  });
});
