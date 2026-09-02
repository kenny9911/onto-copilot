import { describe, expect, it } from "vitest";

import { buildFdeReviewReadModel } from "../src/review/fde-read-model.js";

function question(id: string, text: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    text,
    status: "open",
    priority: "normal",
    sourceKind: "open_question",
    blockedArtifacts: [],
    ...patch,
  };
}

describe("FDE / Ontology review read model", () => {
  it("把逐对象 schema lint 合成批次，同时保留所有权威 question id", () => {
    const rows = [
      ...Array.from({ length: 175 }, (_, index) => question(
        `pk-${index}`,
        `Object${index}: 未声明主键`,
        { priority: "blocking", sourceKind: "conflict", sourceRef: `cf_missing_required_${index}` },
      )),
      ...Array.from({ length: 175 }, (_, index) => question(
        `orphan-${index}`,
        `Object${index} 与任何对象都没有关系，可能是遗漏`,
        { priority: "blocking", sourceKind: "conflict", sourceRef: `cf_orphan_${index}` },
      )),
      ...Array.from({ length: 5 }, (_, index) => question(
        `name-${index}`,
        `TERM${index}: 疑似未登记缩写`,
        { priority: "blocking", sourceKind: "conflict", sourceRef: `cf_naming_violation_${index}` },
      )),
      question("event-1", "订单审批后由哪个 Action 发布事件，哪些系统消费？"),
    ];

    const model = buildFdeReviewReadModel(rows);

    expect(model.summary).toMatchObject({
      originalQuestions: 356,
      visibleItems: 4,
      businessQuestions: 1,
      diagnosticQuestions: 355,
      diagnosticBatches: 3,
      diagnosticItems: 3,
    });
    const primaryKeys = model.items.find((item) => item.id === "batch:missing_primary_key")!;
    expect(primaryKeys).toMatchObject({
      mode: "batch",
      level: "diagnostic",
      domain: "schema_quality",
      authority: { blocking: 175, active: 175 },
    });
    expect(primaryKeys.questionIds).toHaveLength(175);
    expect(new Set(model.items.flatMap((item) => item.questionIds)).size).toBe(356);
  });

  it("按 FDE 决策域补齐 why / impact / expectedAnswer，不改原 priority/status", () => {
    const model = buildFdeReviewReadModel([
      question("action", "撤销采购订单的补偿 Action 是什么？", { priority: "normal" }),
      question("role", "谁能审批超出预算的采购订单？", { priority: "normal" }),
      question("state", "已审批订单修改后进入什么状态？", { priority: "high" }),
      question("data", "采购订单金额字段的业务口径是什么？", { status: "answered" }),
    ]);

    expect(model.items.map((item) => [item.primaryQuestionId, item.domain, item.level]))
      .toEqual(expect.arrayContaining([
        ["action", "exception_compensation", "important"],
        ["role", "role_permission", "important"],
        ["state", "state_transition", "important"],
        ["data", "data_responsibility", "completeness"],
      ]));
    for (const item of model.items) {
      expect(item.why).not.toBe("");
      expect(item.impact).not.toBe("");
      expect(item.expectedAnswer).not.toBe("");
    }
    const role = model.items.find((item) => item.primaryQuestionId === "role")!;
    expect(role.questions[0]).toMatchObject({ status: "open", priority: "normal" });
  });

  it("识别 normalized UI question 的 raw sourceRef，且已回答 lint 仍留在批次内", () => {
    const model = buildFdeReviewReadModel([{
      id: "pk",
      text: "PurchaseOrder: 未声明主键",
      status: "answered",
      priority: "blocking",
      options: [],
      applies: [],
      raw: { sourceKind: "conflict", sourceRef: "cf_missing_required_123" },
    }]);
    expect(model.items[0]).toMatchObject({
      id: "batch:missing_primary_key",
      status: "answered",
      authority: { active: 0, answered: 1, blocking: 1 },
    });
  });

  it("把 Link 与 Workflow 编排作为一等 Ontology 契约域", () => {
    const model = buildFdeReviewReadModel([
      question("link", "采购订单与供应商的 Link 是多对一还是多对多，join key 是什么？"),
      question("workflow", "审批 Workflow 的并行网关何时汇合，超时 Timer 和失败终点是什么？"),
    ]);
    expect(model.items.map((item) => [item.primaryQuestionId, item.domain, item.level]))
      .toEqual(expect.arrayContaining([
        ["link", "link_contract", "important"],
        ["workflow", "workflow_orchestration", "important"],
      ]));
    expect(model.groups.find((group) => group.id === "link_contract")).toMatchObject({
      label: "Link 关系契约",
      labelEn: "Link contract",
    });
    expect(model.items.every((item) => item.expectedAnswerEn.length > 0)).toBe(true);
  });

  it("把聚合技术告警改写成 FDE 可回答决策，但保留权威原文", () => {
    const model = buildFdeReviewReadModel([
      question("api-gap", "170 个对象没有任何 ActionType；OpenAPI 里没有可用端点", {
        priority: "blocking", sourceKind: "conflict",
      }),
    ]);
    const item = model.items[0]!;
    expect(item).toMatchObject({
      domain: "integration_ownership",
      level: "blocking",
      title: expect.stringContaining("哪些由现有系统/API 写入"),
      titleEn: expect.stringContaining("read-only or out of scope"),
      expectedAnswer: expect.stringContaining("owning system"),
    });
    expect(item.questions[0]?.text).toBe("170 个对象没有任何 ActionType；OpenAPI 里没有可用端点");
  });
});

// ══════════════════════════════════════════════════════════════════
//  模板问题按家族折叠
//
//  2026-08-25 用户实拍的真实会话（3b06cae04490）：136 条问题里 78 条是三个模板
//  家族按对象逐条展开 —— 27 条「业务负责人角色是什么」、26 条「与任何对象都没有
//  关系」、25 条「system of record 是什么」。逐条问是把机器的空槽表原样倒给人：
//  一屏拉不完，且答案本该是**一张表一次给**（哪些对象归哪个来源系统、谁负责）。
//  「与任何对象都没有关系」早就折成批次了，另外两个家族一直漏在外面。
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  批次只收 lint，不许把真决策吞进去
//
//  2026-08-25 真库审计（d53cb63f7e18 / fc58b72e91bd 两个会话）：
//  field_schema_lint 的**文案分支**（/字段.+(缺失|未声明|类型|格式)/）在 208 条
//  成员里贡献了 6 条，而这 6 条没有一条是真的字段 lint ——
//    · 3 条 blocking 的「口径不一致」（cf_semantic_divergence，最高价值的业务决策）
//    · 1 条「是否同一业务对象，合并不可逆」
//    · 2 条 high 的专业分析结论（agent_analysis）
//  被吞进批次的代价是被硬判成 diagnostic：blocking 从摘要里消失，人就看不见了。
//  批次的判据必须是**来源**（这条是不是逐行 lint），不是文案里有没有「字段」二字。
// ══════════════════════════════════════════════════════════════════
describe("批次的判据是来源，不是文案", () => {
  const conflictQ = (id: string, text_: string, ref: string, patch: Record<string, unknown> = {}) =>
    question(id, text_, { sourceKind: "conflict", sourceRef: ref, priority: "blocking", ...patch });

  it("真 lint（sourceRef 带 missing_required）照收", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      conflictQ(`f-${i}`, `Object${i}.字段 未声明类型`, `cf_missing_required_${i}`));
    const m = buildFdeReviewReadModel(rows);
    const batch = m.items.find((x) => x.id === "batch:field_schema_lint")!;
    expect(batch.questionIds).toHaveLength(12);
  });

  it("口径不一致是业务决策，不是字段 lint —— 必须单独成条且保住 blocking", () => {
    const rows = [
      conflictQ("d1", "「物料编码」口径不一致（2 种口径、涉及 3 处）：差在这几处：主数据的关键属性之一…字段格式不同",
        "cf_semantic_divergence_0f11b"),
      ...Array.from({ length: 12 }, (_, i) =>
        conflictQ(`f-${i}`, `Object${i}.字段 未声明类型`, `cf_missing_required_${i}`)),
    ];
    const m = buildFdeReviewReadModel(rows);
    const batch = m.items.find((x) => x.id === "batch:field_schema_lint")!;
    expect(batch.questionIds).not.toContain("d1");
    const solo = m.items.find((x) => x.questionIds.includes("d1"))!;
    expect(solo.mode).toBe("question");
    expect(solo.level).toBe("blocking");
  });

  it("专业分析结论（agent_analysis）永远不进批次 —— 它是人要逐条答的", () => {
    const rows = [
      question("a1", "【交易类对象业务键缺失，阻塞主键/唯一性规则落地】采购申请…请分别提供各自的编号字段名称及格式规则",
        { sourceKind: "agent_analysis", sourceRef: "DATA_OBJECTS", priority: "high" }),
      ...Array.from({ length: 12 }, (_, i) =>
        conflictQ(`f-${i}`, `Object${i}.字段 未声明类型`, `cf_missing_required_${i}`)),
    ];
    const m = buildFdeReviewReadModel(rows);
    const batch = m.items.find((x) => x.id === "batch:field_schema_lint")!;
    expect(batch.questionIds).not.toContain("a1");
    expect(m.items.find((x) => x.questionIds.includes("a1"))!.mode).toBe("question");
  });
});

describe("空槽模板问题折成批次", () => {
  const slots = (n: number, kind: "systemofrecord" | "ownerrole", label: string) =>
    Array.from({ length: n }, (_, i) => question(
      `${kind}-${i}`,
      label.replace("<obj>", `do.对象${i}`),
      { sourceKind: "conflict", sourceRef: `oq_missing_${kind}_dataobject_do_对象${i}` },
    ));

  it("system of record 与业务负责人各自折成一条，并保住全部 question id", () => {
    const rows = [
      ...slots(25, "systemofrecord", "DataObject <obj> 的 system of record 是什么？"),
      ...slots(27, "ownerrole", "DataObject <obj> 的业务负责人角色是什么？"),
      question("biz-1", "采购退货走哪条流程？"),
    ];
    const model = buildFdeReviewReadModel(rows);

    const sor = model.items.find((item) => item.id === "batch:missing_system_of_record")!;
    expect(sor).toMatchObject({ mode: "batch", level: "diagnostic" });
    expect(sor.questionIds).toHaveLength(25);
    expect(sor.title).toContain("25");
    expect(sor.expectedAnswer).toContain("来源系统");

    const owner = model.items.find((item) => item.id === "batch:missing_owner_role")!;
    expect(owner.questionIds).toHaveLength(27);
    expect(owner.title).toContain("27");

    // 52 条模板问题折成 2 条，业务问题原样留在一级页 —— 队列从 53 条降到 3 条。
    expect(model.summary.visibleItems).toBe(3);
    expect(new Set(model.items.flatMap((item) => item.questionIds)).size).toBe(53);
  });

  it("真业务问题不会被误折（含「负责人」二字的开放问题仍单独成条）", () => {
    const model = buildFdeReviewReadModel([
      question("biz-1", "采购订单的业务负责人在系统里怎么维护？走 HR 主数据还是手填？"),
    ]);
    expect(model.items).toHaveLength(1);
    expect(model.items[0]!.mode).toBe("question");
  });
});
