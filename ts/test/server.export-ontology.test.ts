/**
 * source=ontology：整份模型成文。
 *
 * JSON 形态早就有（oir.json + /ontology/draft 的 8 个视图）；这里补的是**人读的
 * 成文版** —— 发给业务方看的不是 schema，是"模型说了什么、哪些是假设、还差什么"。
 * 三样东西必须同处一份文件：溯源横幅、流程图、待确认清单。
 */
import { describe, expect, it } from "vitest";

import { exportDoc } from "../src/server/glue/export_doc.js";
import { toMarkdown } from "../src/onto/export.js";
import { FlowGraph } from "../src/onto/flow.js";
import { applyFlowEdit } from "../src/onto/flow_edit.js";
import { toMermaid } from "../src/onto/diagram.js";
import { buildOir } from "../src/onto/pipeline.js";
// 别名：本文件第 23 行已有一个叫 OIR 的 fixture 常量（一份 OIR 字面量），
// 直接 import 同名类会把它遮蔽掉，让既有用例安静地拿到一个类而不是数据。
import { OIR as OirClass, extracted, makeObjectType, makeProvenance, makeRid } from "../src/onto/oir.js";
import type { SessionLike } from "../src/server/pipeline/types.js";

function sess(state: Record<string, unknown>): SessionLike {
  return { id: "s1", state, files: [], emit: () => ({}) } as unknown as SessionLike;
}

const OIR = {
  objects: [
    { displayName: { value: "报销单" }, apiName: { value: "ExpenseReport" }, description: { value: "费用单据" }, status: "candidate" },
  ],
  properties: [
    { parent: "ExpenseReport", displayName: { value: "金额" }, apiName: { value: "amount" }, status: "candidate" },
  ],
  rules: [{ statement: { value: "超 5000 需总监加签" }, apiName: { value: "r1" }, status: "candidate" }],
};

const DEPS = {
  repo: () => { throw new Error("这条路不该碰 repo"); },
  dialogue: () => { throw new Error("这条路不该碰 dialogue"); },
  registry: () => { throw new Error("这条路不该碰 registry"); },
  toMermaid: (g: unknown) => toMermaid(g as FlowGraph),
} as unknown as Parameters<typeof exportDoc>[1];

describe("export.file source=ontology", () => {
  it("对象/属性/规则/流程/待确认问题全在一份 md 里，通用草案带来源横幅", async () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", {
      stages: [{ key: "s1", title: "阶段一" }],
      nodes: [
        { key: "n1", kind: "action", label: "提交报销单", stage: "s1" },
        { key: "n2", kind: "event", label: "报销单已提交", stage: "s1" },
      ],
      edges: [{ from: "n1", to: "n2" }],
    });
    const s = sess({
      oir: OIR,
      _flow: g,
      draft_provenance: { kind: "generic", grounded: false },
      question_backlog: { questions: [
        { id: "q1", text: "金额口径含税吗？", status: "open", priority: "blocking", audience_role: "财务" },
      ] },
    });

    const [doc, receipt] = await exportDoc(s, DEPS, "ontology", "", "");
    expect(doc).not.toBeNull();
    expect(receipt).toEqual({});
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");

    expect(md).toContain("generic_assumption");        // 溯源横幅在正文里
    expect(md).toContain("不得作为客户事实引用");
    expect(md).toContain("# Ontology 草案（通用假设，待验证）");
    expect(md).toContain("数据对象（1）");
    expect(md).toContain("ExpenseReport");
    expect(md).toContain("超 5000 需总监加签");
    expect(md).toContain("```");                        // mermaid 源码块
    expect(md).toContain("提交报销单");
    expect(md).toContain("待确认问题（1）");
    expect(md).toContain("金额口径含税吗？");
  });

  it("模型为空时说清楚该先做什么，不产出一份空文件", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "ontology", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["error"])).toContain("模型是空的");
    expect(String(receipt["下一步"])).toContain("draft.initialize");
  });

  it("材料驱动（非通用草案）的横幅不冒充假设，也不许反过来冒充事实", async () => {
    const s = sess({ oir: OIR, release_state: "DRAFT" });
    const [doc] = await exportDoc(s, DEPS, "ontology", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("由客户材料梳理产出");
    expect(md).not.toContain("generic_assumption");
  });
});

describe("export.file source=sketch —— 生成前的确认稿", () => {
  it("每个环节和连线都带可填写的确认栏，横幅写明非客户事实", async () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", {
      stages: [{ key: "s1", title: "阶段一｜申请" }],
      nodes: [
        { key: "n1", kind: "action", label: "提交报销单", stage: "s1", actor: "员工" },
        { key: "n2", kind: "event", label: "报销单已提交", stage: "s1" },
      ],
      edges: [{ from: "n1", to: "n2", label: "提交成功" }],
    }, { source: "generic_assumption" });
    const s = sess({ sketch: { domain: "采购报销", graph: g.toDict() }, _sketch: g });

    const [doc] = await exportDoc(s, DEPS, "sketch", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");

    expect(md).toContain("确认稿");
    expect(md).toContain("非贵司事实");
    expect(md).toContain("确认（保留/修改/删除）");   // 环节确认栏
    expect(md).toContain("修改意见");
    expect(md).toContain("提交报销单");
    expect(md).toContain("员工");                     // 执行角色进表
    expect(md).toContain("对吗？（是/否）");          // 连线确认栏
    expect(md).toContain("提交成功");                 // 分支条件
    expect(md).toContain("```");                      // mermaid

    // ── 2026-08-25：整行都要有，不是只有条件那一格 ──────────────────
    // 已交付给客户的那份确认稿（workspace/f6fca93bd618/exports/…docx）里，
    // 「顺序与分支」32 行的**从/到两列全空**：读侧取的是 e["source"]/e["target"]，
    // 而 FlowGraph.edgeToDict 写出来的键是 from/to（真库 32/32 条边零 source 键）。
    // 取到 undefined → pyStr(undefined) 给空串 → 整列安静地变空，没有任何报错。
    // 上一版这条用例只断言了 label 存在，而 label 在坏行「|  |  | 提交成功 |」里
    // 照样出现 —— 断言恒真，bug 因此活了下来。
    expect(md).toContain("| 提交报销单 | 报销单已提交 | 提交成功 |");
    // 专杀「条件在、端点空」这个恰好骗过旧断言的形态
    expect(md).not.toMatch(/\|\s*\|\s*\|\s*提交成功/u);
  });

  it("确认稿带文档头：收件人不用问就知道这是什么、谁给的、依据是什么、怎么回传", async () => {
    // 2026-08-25 用户：「对我们生成的所有的文稿都好好设计」。盘点下来所有导出件
    // 都没有文档头 —— 一份发给业务方逐行确认的表，看不出依据是客户材料还是通用
    // 假设、基于哪一版模型、填完往哪送。这些答案系统里全都有。
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", {
      stages: [{ key: "s1", title: "阶段一" }],
      nodes: [{ key: "n1", kind: "action", label: "提交报销单", stage: "s1" }],
      edges: [],
    }, { source: "generic_assumption" });
    const s = sess({
      sketch: { domain: "采购报销", graph: g.toDict() },
      _sketch: g,
      artifact_revision: 3,
    });
    (s as unknown as Record<string, unknown>)["files"] = [{ name: "采购制度.xlsx" }];

    const [doc] = await exportDoc(s, { ...DEPS, now: () => 1787649000 }, "sketch", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("用途");
    expect(md).toContain("给谁看");
    expect(md).toContain("依据");
    expect(md).toContain("通用假设");            // 这份就是通用假设，不能含糊
    expect(md).toContain("回传");
    expect(md).toContain("2026");                // 生成时间
    // 文档头排在正文之前
    expect(md.indexOf("用途")).toBeLessThan(md.indexOf("环节清单"));
  });

  it("没画过图 → 指路 flow.sketch，不产出空稿", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "sketch", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["下一步"])).toContain("flow.sketch");
  });
});

describe("export.file source=interview_kit —— 一键访谈包", () => {
  const backlogState = {
    question_backlog: {
      questions: [
        { id: "q-1", text: "审批金额含税吗？", status: "open", priority: "blocking",
          audience_role: "财务", why: "两份材料口径不一" },
        { id: "q-2", text: "谁有权作废报销单？", status: "open", priority: "high",
          audience_role: "流程负责人", why: "材料没写" },
        { id: "q-3", text: "已答过的", status: "answered", audience_role: "财务" },
      ],
    },
  };

  it("按受访角色分组，每题带为什么问/期望答案/可填写的回答栏；已答过的不进包", async () => {
    const [doc] = await exportDoc(sess(backlogState), DEPS, "interview_kit", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");

    expect(md).toContain("财务（1 题）");
    expect(md).toContain("流程负责人（1 题）");
    expect(md).toContain("审批金额含税吗？");
    expect(md).toContain("两份材料口径不一");        // 为什么问
    expect(md).toContain("您的回答（请填写）");       // 回传载体
    expect(md).toContain("问题ID");                   // 回传匹配键
    expect(md).not.toContain("已答过的");             // terminal 不进包
    expect(md).toContain("期望获得的答案");
  });

  it("没有待确认问题 → 指路，不产出空包", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "interview_kit", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["下一步"])).toContain("readiness.report");
  });
});

describe("export.file source=memory —— 会话记忆文档", () => {
  const withLog = (log: unknown[]) => sess({ memory_log: log });

  it("**按依据分栏** —— 混在一起记等于没记", async () => {
    const [doc] = await exportDoc(withLog([
      { seq: 1, kind: "decision", what: "金额一律按不含税", basis: "user", tool: "decision.record" },
      { seq: 2, kind: "edit", what: "补了采购申请的三个属性", basis: "generic_assumption", tool: "oir.add" },
      { seq: 3, kind: "canvas", what: "把下单环节绑到采购订单上", basis: "user", tool: "flow.bind_objects" },
    ]), DEPS, "memory", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("人明说的（2 条）");
    expect(md).toContain("凭通识补的（1 条）");
    // 人明说的排在前面 —— 那是唯一能拿去跟客户说「这条是你们定的」的部分
    expect(md.indexOf("人明说的")).toBeLessThan(md.indexOf("凭通识补的"));
    expect(md).toContain("金额一律按不含税");
    expect(md).toContain("把下单环节绑到采购订单上");
  });

  it("**有假设就在开头把话说明白** —— 交付前要逐条确认", async () => {
    const [doc, receipt] = await exportDoc(withLog([
      { seq: 1, kind: "draft", what: "转正了通用参考图", basis: "generic_assumption", tool: "draft.adopt" },
    ]), DEPS, "memory", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("没有客户材料依据");
    expect(receipt["凭通识补的"]).toBe(1);
  });

  it("全是人明说的就不出那句警告 —— 没话时闭嘴", async () => {
    const [doc] = await exportDoc(withLog([
      { seq: 1, kind: "decision", what: "口径定了", basis: "user", tool: "decision.record" },
    ]), DEPS, "memory", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).not.toContain("没有客户材料依据");
  });

  it("还没有记忆时指路，不产出空文档", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "memory", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["下一步"])).toContain("自动记一条");
  });
});

describe("export.file source=sample_kit —— 数据样例回传模板", () => {
  const withOir = () => {
    const live = buildOir({
      objects: [{ api_name: "PurchaseOrder", display_name: "采购订单",
        source_file: "x.xlsx", source_locator: "x!R1" }],
      properties: [
        { parent_api_name: "PurchaseOrder", api_name: "orderNo", display_name: "订单编号",
          source_file: "x.xlsx", source_locator: "x!R2" },
        { parent_api_name: "PurchaseOrder", api_name: "amount", display_name: "金额",
          source_file: "x.xlsx", source_locator: "x!R3" },
      ],
      links: [],
    }, null, {});
    return sess({ _oir: live });
  };

  it("每个对象一张空表：表头是属性中文名、隐藏列放 rid、5 行空行", async () => {
    const [doc] = await exportDoc(withOir(), DEPS, "sample_kit", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("采购订单（请在下方贴 5 行真实数据）");
    expect(md).toContain("订单编号");
    expect(md).toContain("_rid（勿改）");
    expect(md).toContain("ot_purchaseorder");
    // **不需要业务方会术语** —— 导语说清楚了自动推导
    expect(md).toContain("不需要填任何术语");
    expect(md).toContain("脱敏");
  });

  it("零属性的对象也出表 —— 让业务方按自家系统列字段名，正是要补的信息", async () => {
    const live = buildOir({
      objects: [{ api_name: "Supplier", display_name: "供应商",
        source_file: "x.xlsx", source_locator: "x!R1" }],
      properties: [], links: [],
    }, null, {});
    const [doc] = await exportDoc(sess({ _oir: live }), DEPS, "sample_kit", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("供应商");
    expect(md).toContain("字段名请按贵司系统列在这一行");
  });

  it("还没有对象时指路，不产出空模板", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "sample_kit", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["下一步"])).toContain("先梳理出对象");
  });
});

// ══════════════════════════════════════════════════════════════════
//  export.file source=changelog —— 会议简报（第 1 层工作坊套件）
//
//  每周向客户汇报的核心素材是「上次会议以来改了什么、谁拍的板、还差什么」。
//  台账三来源同处一份：revision 行（问答 / 对话编辑 —— 后者能出现在这儿，
//  靠的正是 dialogue_edit revision 那条线）、已生效口径约定、问题概况。
// ══════════════════════════════════════════════════════════════════

function chRow(ordinal: number, kind: string, reason: string, created: number) {
  return {
    id: `rev.${ordinal}`, ordinal, parent_id: null, kind, status: "applied",
    doc: {}, patch_set: { reason, idempotencyKey: `k${ordinal}` },
    changed_ids: ["x"], invalidated_artifacts: [], actor: "user", source_turn: "",
    snapshot_hash: `h${ordinal}`, idempotency_key: `k${ordinal}`, created,
  };
}

function chDeps(revs: unknown[], decisions: string[]) {
  return {
    repo: () => ({ listRevisions: async () => revs }),
    dialogue: () => ({ activeDecisions: () => decisions.map((d) => ({ render: () => d })) }),
    registry: () => { throw new Error("这条路不该碰 registry"); },
  } as unknown as Parameters<typeof exportDoc>[1];
}

describe("export.file source=changelog", () => {
  const REVS = [
    chRow(1, "question_answer", "口径：计划金额含税", 1700000100),
    chRow(2, "dialogue_edit", "改名：请购 → 采购申请", 1700000200),
  ];

  it("变更台账 + 已生效约定 + 问题概况同处一份 md", async () => {
    const s = sess({
      question_backlog: { questions: [
        { id: "q1", text: "含税吗", status: "open" },
        { id: "q2", text: "谁审批", status: "answered" },
      ] },
    });
    const [doc, receipt] = await exportDoc(
      s, chDeps(REVS, ["口径｜计划金额一律含税"]), "changelog", "", "",
    );
    expect(receipt).toEqual({});
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("共 2 条变更");
    expect(md).toContain("问答回写");
    expect(md).toContain("对话编辑");
    expect(md).toContain("改名：请购 → 采购申请");
    expect(md).toContain("口径｜计划金额一律含税");
    expect(md).toContain("待确认");
  });

  it("contains 给数字 = 只看第 N 版之后（会前只讲增量）", async () => {
    const [doc] = await exportDoc(sess({}), chDeps(REVS, []), "changelog", "1", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("改名：请购 → 采购申请");
    expect(md).not.toContain("口径：计划金额含税");
    expect(md).toContain("自第 1 版以来");
  });

  it("一条变更都没有时明说，不出一份空文件", async () => {
    const [doc, receipt] = await exportDoc(sess({}), chDeps([], []), "changelog", "", "");
    expect(doc).toBeNull();
    expect(String(receipt["error"])).toContain("还没有");
  });
});

// ══════════════════════════════════════════════════════════════════
//  4A 架构文档
//
//  用户要求 OntoCopilot「具备 ERP 四个架构的分析和结合」。四层各自成章只是四份
//  清单，**结合**发生在对齐矩阵上：一行一个流程环节，横着看它连着哪些数据对象、
//  哪个系统、哪个技术组件 —— 哪一环没有系统承载、哪一环没有数据支撑，一眼看得出。
//
//  这份文档的诚实纪律：一层空要说清是「没料」还是「有料没接住」，并写明找谁要什么。
// ══════════════════════════════════════════════════════════════════
describe("export.file source=architecture —— 4A 架构分析", () => {
  const withModel = () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", {
      stages: [{ key: "s1", title: "阶段一｜申请" }],
      nodes: [
        { key: "n1", kind: "action", label: "提交请购单", stage: "s1", actor: "采购员" },
        { key: "n2", kind: "event", label: "请购单已提交", stage: "s1" },
      ],
      edges: [{ from: "n1", to: "n2" }],
    }, { source: "user" });
    const o = new OirClass();
    const ev = makeProvenance("f1", "清单.xlsx", { kind: "range", sheet: "S", rows: [2, 2] }, { snippet: "x" });
    o.addObject(makeObjectType({
      rid: makeRid("ot", "req"),
      apiName: extracted("purchaseRequisition", ev),
      displayName: extracted("采购申请", ev),
      description: extracted("由 SAP 写入，经接口同步到 SRM", ev),
    }));
    return sess({ _oir: o, _flow: g, oir: o.toDict(), flow: g.toDict(), artifact_revision: 2 });
  };

  it("四层各一节，每节写清它回答什么问题、现在有什么、缺什么、找谁要", async () => {
    const [doc] = await exportDoc(withModel(), { ...DEPS, now: () => 1787649000 }, "architecture", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    for (const layer of ["业务架构", "应用架构", "数据架构", "技术架构"]) {
      expect(md, `缺「${layer}」这一节`).toContain(layer);
    }
    expect(md).toContain("缺什么");
    expect(md).toContain("找谁要");
    expect(md).toContain("采购员");            // A1 的角色进了文档
    expect(md).toContain("采购申请");          // A3 的对象进了文档
  });

  it("**空的那一层要说清是「没料」还是「有料没接住」** —— 两种空的下一步完全不同", async () => {
    const [doc] = await exportDoc(withModel(), { ...DEPS, now: () => 1787649000 }, "architecture", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    // 这份 fixture 里对象描述提到了 SAP/接口 → A2 是「有料没接住」
    expect(md).toContain("有料没接住");
    // A4 是真没料，要说清并劝阻凭空补
    expect(md).toContain("空得合理");
    expect(md).toContain("不要让模型凭通识补");
  });

  it("对齐矩阵在文档里，且连不上的格子写「未…」不留空", async () => {
    const [doc] = await exportDoc(withModel(), { ...DEPS, now: () => 1787649000 }, "architecture", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("四层对齐");
    expect(md).toContain("| 提交请购单 | 采购员 |");
    expect(md).toContain("未接入系统");
    expect(md).toContain("未采集");
  });

  it("带文档头（用途/给谁看/依据/回传）—— 这份是要发给客户架构负责人的", async () => {
    const [doc] = await exportDoc(withModel(), { ...DEPS, now: () => 1787649000 }, "architecture", "", "");
    const md = Buffer.from(toMarkdown(doc!)).toString("utf8");
    expect(md).toContain("用途");
    expect(md).toContain("给谁看");
    expect(md).toContain("2026");
  });

  it("整份模型为空 → 明说先梳理，不产出一份四节全空的文档", async () => {
    const [doc, receipt] = await exportDoc(sess({}), DEPS, "architecture", "", "");
    expect(doc).toBeNull();
    expect(String((receipt as Record<string, unknown>)["error"])).toContain("还没有");
  });
});
