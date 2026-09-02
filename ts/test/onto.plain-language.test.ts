import { describe, expect, it } from "vitest";

import {
  plainQuestionCopy,
  plainQuestionPriority,
  plainQuestionStatus,
  plainQuestionTableTitle,
  plainQuestionWhy,
  plainConversationCopy,
  plainUserFacingCopy,
  stripQuestionProtocolFromAnswer,
} from "../src/onto/plain_language.js";
import { CHAT_SYSTEM, PLAIN_LANGUAGE_GUIDE, SYSTEM } from "../src/onto/converse.js";

describe("面向用户的问题文案", () => {
  it("拆掉截图中的路由标签，同时保留审计元数据", () => {
    const copy = plainQuestionCopy(
      "[高][ERP顾问][blocked:sys_metaerp] 请确认 MetaERP 系统的具体版本及实施组织范围" +
      " | answer:TEXT | evidence:场景2_数字化员工的智能作业实践.docx#p1",
    );
    expect(copy).toMatchObject({
      text: "请确认 MetaERP 系统的具体版本及实施组织范围",
      priority: "high",
      audienceRole: "ERP顾问",
      blockedArtifact: "sys_metaerp",
      answerFormat: "TEXT",
      evidenceRef: "场景2_数字化员工的智能作业实践.docx#p1",
      hadMachineMarkup: true,
    });
  });

  it("带中文的 rule ID 也不会出现在业务问题里", () => {
    const copy = plainQuestionCopy(
      "[业务部门][rule.br_价格偏差_20_软预警并要求补充说明] 当价格偏离历史均价20%时，怎么处理？ | expected:TEXT",
    );
    expect(copy.text).toBe("当价格偏离历史均价20%时，怎么处理？");
    expect(copy.audienceRole).toBe("业务部门");
    expect(copy.answerFormat).toBe("TEXT");
  });

  it("业务正文里的合法方括号不被误删", () => {
    const copy = plainQuestionCopy("[供应商]是否包括临时供应商？");
    expect(copy.text).toBe("[供应商] 是否包括临时供应商？");
    expect(copy.hadMachineMarkup).toBe(false);
  });

  it("自由回答里即使模型照抄了紧凑协议，落地前也会清理", () => {
    const answer = stripQuestionProtocolFromAnswer(
      "先确认两件事：\n1. [中][ERP顾问][blocked:sys.erp] 客户使用哪个版本？ | answer:TEXT | evidence:a#p1",
    );
    expect(answer).toContain("1. 客户使用哪个版本？");
    expect(answer).not.toMatch(/blocked:|answer:|evidence:/u);
  });

  it("状态、优先级、自动 why 和机器视角标题都翻成人话", () => {
    expect(plainQuestionStatus("open")).toBe("待回答");
    expect(plainQuestionPriority("high")).toBe("优先确认");
    expect(plainQuestionWhy("由 ERP_MAP 独立分析发现，需由相应业务角色确认", "ERP顾问"))
      .toBe("材料里的系统信息没有说明清楚，需要请ERP顾问确认。");
    expect(plainQuestionTableTitle("阻碍系统自动抽取的关键待澄清问题（部分展示）", 62))
      .toBe("需要优先确认的问题（部分展示）");
  });

  it("把截图里的英文缩写和顾问腔换成日常中文", () => {
    const chat = plainUserFacingCopy(
      "**Non-Obvious 问题**：intercompany 的 Transfer Pricing 怎么处理？LT 是否晚于 Need-by Date？存在物理现实割裂。",
    );
    expect(chat).toContain("容易漏掉但会影响上线的问题");
    expect(chat).toContain("跨公司的内部交易定价怎么处理");
    expect(chat).toContain("预计运输时间是否晚于最晚到货日");
    expect(chat).toContain("实际执行与系统规则不一致");
    expect(chat).not.toMatch(/Non-Obvious|intercompany|Transfer Pricing|\bLT\b|Need-by Date|物理现实割裂/u);
    expect(plainUserFacingCopy("**3 个对象没有任何 ActionType**")).toBe("3 个对象没有任何业务操作");
  });

  it("解释可以说人话，但材料原文和技术标识必须逐字保留", () => {
    const chat = plainUserFacingCopy([
      "材料原文：LT 晚于 Need-by Date，字段名是 apiName。",
      "> 原文引用：intercompany 使用 Transfer Pricing。",
      "接口字段 `apiName` 不应被改写。",
      "解释：LT 晚于 Need-by Date 时，需要检查 intercompany 的 Transfer Pricing。",
      "```json",
      '{"apiName":"Need-by Date","kind":"ActionType"}',
      "```",
    ].join("\n"));

    expect(chat).toContain("材料原文：LT 晚于 Need-by Date，字段名是 apiName。");
    expect(chat).toContain("> 原文引用：intercompany 使用 Transfer Pricing。");
    expect(chat).toContain("`apiName`");
    expect(chat).toContain('{"apiName":"Need-by Date","kind":"ActionType"}');
    expect(chat).toContain("解释：预计运输时间晚于最晚到货日时，需要检查跨公司的内部交易定价。");
  });

  it("聊天收尾不改写客户未加引号的正式名称", () => {
    const answer = plainConversationCopy(
      "客户使用本体管理系统，接口字段 apiName 的原值是 Need-by Date，LT 是材料里的正式列名。",
    );
    expect(answer).toBe(
      "客户使用本体管理系统，接口字段 apiName 的原值是 Need-by Date，LT 是材料里的正式列名。",
    );
  });
});

describe("对话提示的易懂表达契约", () => {
  it("工作和聊天模式共用同一套先结论、人话、隐藏内部协议的规则", () => {
    for (const prompt of [PLAIN_LANGUAGE_GUIDE, SYSTEM, CHAT_SYSTEM]) {
      expect(prompt).toContain("第一段直接回答");
      expect(prompt).toContain("用常用中文");
      expect(prompt).toContain("blocked:*");
      expect(prompt).toContain("复杂问题拆开问");
    }
    expect(SYSTEM).toContain("先短后长");
    expect(SYSTEM).not.toContain("判断不了长短时**偏详细**");
  });
});
