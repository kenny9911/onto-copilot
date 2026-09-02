/**
 * 就绪度评估：够不够、差哪块、去问谁。
 *
 * 全部纯规则 —— 这批用例同时钉住"零模型调用"这个性质：assessReadiness 是纯函数，
 * 连异步都没有。
 */
import { describe, expect, it } from "vitest";

import { assessReadiness } from "../src/onto/readiness.js";

const chunk = (text: string, tags: string[] = []) => ({ text, tags });

describe("assessReadiness", () => {
  it("六要素都有信号 → READY（DDL + 口径 + 外键 + OpenAPI + 流程文档 + 制度）", () => {
    const report = assessReadiness(
      [{ name: "a.sql" }, { name: "api.json" }, { name: "制度.docx" }],
      {
        "a.sql": [
          chunk("CREATE TABLE po", ["schema", "table"]),
          chunk("amount DECIMAL", ["column"]),
          chunk("FOREIGN KEY", ["fk"]),
        ],
        "api.json": [chunk("POST /po", ["endpoint", "write"])],
        "制度.docx": [
          chunk("报销流程分四个环节，先提交后审批"),
          chunk("单笔超过 5000 元必须总监加签"),
        ],
      },
    );
    expect(report.verdict).toBe("READY");
    expect(report.supplements.flatMap((s) => s.items).join()).not.toContain("必补");
  });

  it("只传一张纯数据表 → PARTIAL，补料清单点名流程文档缺失并说清找谁要", () => {
    const report = assessReadiness(
      [{ name: "订单.xlsx" }],
      {
        "订单.xlsx": [
          chunk("订单表", ["table"]),
          chunk("订单号|金额", ["column"]),
          chunk("PO-1|100", ["row"]),
        ],
      },
    );
    expect(report.verdict).toBe("PARTIAL");
    const flow = report.dimensions.find((d) => d.key === "flow")!;
    expect(flow.score).toBe(0);
    expect(flow.missing).toContain("流程文档");
    expect(flow.askWho).toContain("流程负责人");
    // 可以先抽的部分要说出来 —— PARTIAL 不是"什么都别做"
    expect(report.extractableNow).toContain("数据对象");
    // 补料清单按角色分组，且必补/最好补分级
    const items = report.supplements.flatMap((s) => s.items).join("\n");
    expect(items).toContain("【必补】业务流程");
  });

  it("什么都没传 → NOT_ENOUGH；传了但没解析（零切片）同样 NOT_ENOUGH", () => {
    expect(assessReadiness([], {}).verdict).toBe("NOT_ENOUGH");
    expect(assessReadiness([{ name: "a.docx" }], {}).verdict).toBe("NOT_ENOUGH");
  });

  it("正文提及只算弱信号 —— 一句「我们有审批流程」不等于有流程文档", () => {
    const report = assessReadiness(
      [{ name: "备忘.docx" }],
      { "备忘.docx": [chunk("我们的报销流程是先提交后审批"), chunk("需要总监审批的场景很多")] },
    );
    const flow = report.dimensions.find((d) => d.key === "flow")!;
    expect(flow.score).toBe(1); // 弱信号：能抽，但要提醒补正式文档
    expect(flow.missing).toBeTruthy();
  });
});

describe("图片 OCR 的正文信号（真实现场修复）", () => {
  it("**OCR 切片的流程词要算弱信号** —— 用户传流程图图片，六维不能全判「没有」", () => {
    // 复刻真实库 00f679b01086 的形状：PNG OCR 出 74 段，tags 全是 ocr+title/paragraph
    const chunks = {
      "流程图.png": [
        { text: "〔title〕2.2 按业务流程匹配需求进行说明", tags: ["ocr", "title"] },
        { text: "〔paragraph〕采购需求计划流程", tags: ["ocr", "paragraph"] },
        { text: "〔paragraph〕采购执行计划流程", tags: ["ocr", "paragraph"] },
        { text: "〔paragraph〕提交采购申请后由部门负责人审批", tags: ["ocr", "note"] },
      ],
    };
    const r = assessReadiness([{ name: "流程图.png" }], chunks);
    const flow = r.dimensions.find((d) => d.key === "flow")!;
    const actions = r.dimensions.find((d) => d.key === "actions")!;
    expect(flow.score).toBe(1);       // 弱信号，不是零
    expect(actions.score).toBe(1);    // 「提交/审批」动词句同样要看见
    expect(r.verdict).not.toBe("NOT_ENOUGH");
  });

  it("结构化标签的切片仍然不算正文 —— 表格行不是散文", () => {
    const chunks = {
      "表.xlsx": [{ text: "流程 节点 环节", tags: ["table", "row"] }],
    };
    const r = assessReadiness([{ name: "表.xlsx" }], chunks);
    const flow = r.dimensions.find((d) => d.key === "flow")!;
    // table 行里的「流程」两个字不构成流程描述信号
    expect(flow.signals.every((sig) => !sig.includes("正文流程描述"))).toBe(true);
  });
});
