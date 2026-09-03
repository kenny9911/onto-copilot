import { describe, expect, it } from "vitest";

import {
  buildContextViewModel,
  contextSectionForTab,
  filterModelEntities,
  findModelEntity,
  normalizeModelKind,
  searchContext,
} from "../src/ui/context-model.js";

const evidence = (cite: string, snippet: string) => ({
  file_id: "f1",
  file_name: "材料.xlsx",
  locator: { kind: "range", sheet: "实体梳理", rows: [2, 2] },
  cite,
  snippet,
  extractor: "rule",
  confidence: 0.94,
});

const assertion = (value: unknown, cite = "") => ({
  value,
  origin: cite ? "extracted" : "inferred",
  confidence: cite ? 0.8 : 0.4,
  evidence: cite ? [evidence(cite, String(value))] : [],
});

function legacySnapshot(): Record<string, unknown> {
  return {
    id: "s_procurement",
    title: "采购业务梳理",
    status: "done",
    mode: "work",
    state_version: 12,
    filelist: [
      { id: "f1", name: "材料.xlsx", state: "parsed", chunks: 32 },
      { id: "f2", name: "访谈纪要.docx", state: "failed", issue: "文件损坏" },
    ],
    state: {
      oir: {
        objects: [
          {
            rid: "ot_po",
            kind: "ObjectType",
            apiName: assertion("PurchaseOrder", "材料.xlsx!实体梳理!R2-2"),
            displayName: assertion("采购订单", "材料.xlsx!实体梳理!R2-2"),
            description: assertion("记录采购需求、审批与履约状态"),
            primaryKey: assertion(["pt_po_id"]),
            properties: ["pt_amount"],
            aliases: ["PO"],
            status: "confirmed",
            conflicts: ["cf_amount"],
          },
          {
            rid: "ot_supplier",
            kind: "ObjectType",
            apiName: assertion("Supplier", "材料.xlsx!实体梳理!R3-3"),
            displayName: assertion("供应商", "材料.xlsx!实体梳理!R3-3"),
            properties: [],
            aliases: [],
            status: "candidate",
            conflicts: [],
          },
        ],
        properties: [{
          rid: "pt_amount",
          parent: "ot_po",
          apiName: assertion("amount", "材料.xlsx!实体梳理!R4-4"),
          displayName: assertion("订单金额", "材料.xlsx!实体梳理!R4-4"),
          baseType: assertion("DECIMAL"),
          definition: assertion("含税总额"),
          required: assertion(true),
          status: "candidate",
        }],
        links: [{
          rid: "lt_po_supplier",
          apiName: assertion("supplier", "材料.xlsx!实体梳理!R5-5"),
          from: "ot_po",
          to: "ot_supplier",
          cardinality: assertion("MANY_TO_ONE"),
          status: "candidate",
        }],
        actions: [{
          rid: "at_submit_po",
          apiName: assertion("submitPurchaseOrder", "材料.xlsx!实体梳理!R6-6"),
          appliesTo: ["ot_po"],
          effects: assertion(["状态变为待审批"]),
          status: "candidate",
        }],
        rules: [{
          rid: "br_credit",
          statement: assertion("订单金额不得超过供应商授信额度", "材料.xlsx!实体梳理!R7-7"),
          ruleKind: assertion("VALIDATION"),
          appliesTo: ["ot_po"],
          actor: assertion("采购专员"),
          status: "candidate",
        }],
        questions: [{
          rid: "q_tax",
          text: assertion("采购订单金额是否含税？", "材料.xlsx!实体梳理!R8-8"),
          answer: assertion(""),
          options: ["含税", "不含税"],
          appliesTo: ["ot_po"],
          askedBy: "customer",
          blocking: true,
          status: "candidate",
        }],
        stats: { objects: 2, properties: 1, links: 1, actions: 1, rules: 1 },
      },
      flow: {
        stages: [{ key: "approval", title: "审批阶段", order: 1 }],
        workflows: [{ key: "wf_po", title: "采购订单审批", entry: "fn_submit", exits: ["fn_approved"] }],
        nodes: [
          {
            rid: "fn_submit",
            kind: "action",
            code: "ACT-PO-SUBMIT",
            label: assertion("提交采购订单", "材料.xlsx!实体梳理!R9-9"),
            stage: "approval",
            actor: assertion("采购专员"),
            objects: ["ot_po"],
            grounded: true,
            status: "candidate",
          },
          {
            rid: "fn_approved",
            kind: "event",
            code: "EVT-PO-APPROVED",
            label: assertion("采购订单已审批"),
            stage: "approval",
            actor: assertion(""),
            objects: ["ot_po"],
            grounded: false,
            status: "candidate",
          },
        ],
        edges: [{ rid: "fe_submit_approved", from: "fn_submit", to: "fn_approved", label: "通过", grounded: false }],
        stats: { workflows: 1, actions: 1, events: 1, inferred_edges: 1 },
      },
      conflicts: [{
        rid: "cf_amount",
        kind: "semantic_divergence",
        subjects: ["ot_po", "pt_amount"],
        summary: "订单金额存在含税与不含税两种口径",
        handling: "ask_user",
        evidence: [evidence("材料.xlsx!实体梳理!R10-10", "含税金额")],
        options: [{ id: "taxed", label: "采用含税口径", rationale: "财务报表使用" }],
      }],
      // 与 OIR 问题并存；适配层必须合并，而不是二选一。
      questions: [{
        id: "q_owner",
        text: "谁负责审批采购订单？",
        status: "answered",
        answer: "业务负责人",
        applies_to: ["ot_po"],
      }],
      artifacts: ["ontology.json", "流程图.svg", "访谈清单.xlsx"],
      release_state: "RELEASED",
    },
  };
}

describe("contextSectionForTab", () => {
  it("把旧七 tab 归并到项目工作区与运行检查器，且新 section 原样通过", () => {
    expect(contextSectionForTab("mat")).toBe("evidence");
    expect(contextSectionForTab("ent")).toBe("model");
    expect(contextSectionForTab("flow")).toBe("model");
    expect(contextSectionForTab("cf")).toBe("review");
    expect(contextSectionForTab("q")).toBe("review");
    expect(contextSectionForTab("art")).toBe("delivery");
    expect(contextSectionForTab("think")).toBe("runtime");
    expect(contextSectionForTab("runtime")).toBe("runtime");
    expect(contextSectionForTab(" DELIVERY ")).toBe("delivery");
    expect(contextSectionForTab("从未见过")).toBe("project");
  });
});

describe("buildContextViewModel：旧 /state 快照", () => {
  it("生成项目、证据、模型、审阅、交付五个稳定视图", () => {
    const view = buildContextViewModel(legacySnapshot());

    expect(view.version).toBe(1);
    expect(view.project).toMatchObject({
      id: "s_procurement",
      title: "采购业务梳理",
      status: "done",
      mode: "work",
      revision: "12",
      releaseState: "BLOCKED", // 服务端虽写 RELEASED，有阻塞项仍 fail closed。
    });
    expect(view.project.counts).toMatchObject({
      materials: 2,
      objects: 2,
      properties: 1,
      links: 1,
      actions: 2, // OIR ActionType + 流程 action 节点
      rules: 1,
      processes: 1,
      events: 1,
      questions: 2,
      conflicts: 1,
      artifacts: 3,
    });

    expect(view.evidence.materials).toHaveLength(2);
    expect(view.evidence).toMatchObject({ parsedCount: 1, pendingCount: 0, problemCount: 1 });
    expect(view.evidence.references.some((item) => item.cite === "材料.xlsx!实体梳理!R2-2")).toBe(true);
    expect(view.evidence.materials[0]!.evidenceCount).toBeGreaterThan(0);

    expect(view.review.questions.map((item) => item.id)).toEqual(["q_owner", "q_tax"]);
    expect(view.review.questions.find((item) => item.id === "q_owner")!.status).toBe("answered");
    expect(view.review.conflicts[0]).toMatchObject({ id: "cf_amount", blocking: true });
    expect(view.review.blockerCount).toBe(2);
    expect(view.delivery.formats).toEqual(["json", "svg", "xlsx"]);
    expect(view.delivery.releaseState).toBe("BLOCKED");
  });

  it("对象详情带显式关系、证据与待确认项", () => {
    const view = buildContextViewModel(legacySnapshot());
    const order = findModelEntity(view, "PurchaseOrder");
    expect(order).not.toBeNull();
    expect(order).toMatchObject({
      id: "ot_po",
      kind: "object",
      name: "采购订单",
      apiName: "PurchaseOrder",
      status: "confirmed",
      grounded: true,
    });
    expect(order!.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "property", targetId: "pt_amount" }),
      expect.objectContaining({ kind: "link", targetId: "ot_supplier", direction: "out" }),
      expect.objectContaining({ kind: "action", targetId: "at_submit_po" }),
      expect.objectContaining({ kind: "rule", targetId: "br_credit" }),
      expect.objectContaining({ kind: "process", targetId: "wf_po" }),
    ]));
    expect(order!.pending.map((item) => item.id)).toEqual(expect.arrayContaining(["q_tax", "cf_amount"]));
    expect(order!.evidence[0]!.sourceIds).toContain("ot_po");

    const inferredEvent = findModelEntity(view, "EVT-PO-APPROVED");
    expect(inferredEvent).not.toBeNull();
    expect(inferredEvent!.grounded).toBe(false);
    expect(inferredEvent!.pending).toContainEqual(expect.objectContaining({
      id: "inference:fn_approved",
      type: "inference",
    }));
    expect(inferredEvent!.relations).toContainEqual(expect.objectContaining({
      targetId: "fn_submit",
      direction: "in",
      meta: "推断关系",
    }));
  });
});

describe("buildContextViewModel：新 /context 聚合响应", () => {
  it("识别 context 五区、统一实体形态，并保留服务端详情", () => {
    const view = buildContextViewModel({
      context: {
        session: { id: "s2", title: "模型 r12", status: "done" },
        project: { stage: "模型确认", nextAction: "确认供应商基数" },
        evidence: {
          materials: [{ id: "m1", name: "schema.json", status: "ready", evidence_count: 1 }],
          references: [{ id: "ev1", fileName: "schema.json", cite: "schema.json#/PurchaseOrder" }],
        },
        model: {
          revision: "r12",
          counts: { rules: 9 },
          entities: [
            {
              id: "po",
              kind: "DataObject",
              displayName: "采购订单",
              apiName: "PurchaseOrder",
              grounded: true,
              relations: [{ id: "l1", kind: "link", targetId: "supplier", label: "供应商", cardinality: "多对一" }],
              pending: [{ id: "p1", type: "question", title: "确认基数", status: "open", priority: "high" }],
            },
            { id: "supplier", kind: "ObjectType", displayName: "供应商", apiName: "Supplier", grounded: true },
          ],
        },
        review: {
          questions: [{ id: "q1", text: "已确认了吗？", status: "answered", answer: "是" }],
          nextBatch: ["q1"],
        },
        delivery: {
          releaseState: "RELEASED",
          revision: "d7",
          artifacts: [{ id: "a1", name: "OntologyPackage.json", format: "json", url: "/download/a1" }],
        },
      },
    });

    expect(view.project).toMatchObject({
      id: "s2",
      title: "模型 r12",
      stage: "模型确认",
      revision: "r12",
      releaseState: "RELEASED",
      nextAction: "确认供应商基数",
    });
    expect(view.model.counts).toMatchObject({ object: 2, rule: 9 });
    expect(findModelEntity(view.model, "po")!.relations).toContainEqual(expect.objectContaining({
      targetId: "supplier",
      meta: "多对一",
    }));
    expect(findModelEntity(view.model, "po")!.pending).toContainEqual(expect.objectContaining({ id: "p1" }));
    expect(view.review.nextIds).toEqual(["q1"]);
    expect(view.delivery.artifacts[0]).toMatchObject({
      id: "a1",
      name: "OntologyPackage.json",
      downloadPath: "/download/a1",
    });
  });

  it("直接兼容后端 ontocopilot.context/1 的 items / records / project.session 契约", () => {
    const view = buildContextViewModel({
      schemaVersion: "ontocopilot.context/1",
      project: {
        session: { id: "ctx-1", title: "采购订单梳理", status: "done", mode: "work" },
        stage: "review",
        revision: { label: "r12", model: 12, review: 3, state: 4 },
        releaseState: "DRAFT",
        nextAction: { kind: "resolve_blockers", label: "处理 1 个阻塞问题", target: "review" },
      },
      evidence: {
        materials: [{ id: "m1", name: "采购流程.docx", state: "parsed", chunks: 7, evidenceIds: ["ev1"] }],
        records: [{
          id: "ev1",
          fileId: "f1",
          fileName: "采购流程.docx",
          cite: "采购流程.docx · 第 4 页",
          locator: { page: 4 },
          snippet: "采购订单提交后由部门负责人审批。",
          extractor: "document",
          confidence: 0.92,
          relatedIds: ["obj-po", "q-tax"],
        }],
      },
      model: {
        revision: 12,
        counts: { objects: 2, processes: 1, processSteps: 1, rules: 9, inferred: 1, grounded: 3 },
        items: [
          {
            id: "obj-po",
            type: "object",
            label: "采购订单",
            apiName: "PurchaseOrder",
            description: "记录采购、审批与履约状态",
            status: "confirmed",
            origin: "extracted",
            confidence: 0.9,
            grounded: true,
            inferred: false,
            evidenceIds: ["ev1"],
            conflictIds: ["cf-tax"],
            questionIds: ["q-tax"],
            related: [{ id: "wf-approval", kind: "process", relationship: "participates_in" }],
            data: { aliases: ["订单"], owner: "采购部", primaryKey: ["orderNumber"] },
          },
          {
            id: "wf-approval",
            type: "process",
            label: "采购订单审批流程",
            apiName: "wf-approval",
            description: "订单从提交到审批通过",
            status: "candidate",
            origin: "inferred",
            confidence: 0.4,
            grounded: false,
            inferred: true,
            evidenceIds: [],
            conflictIds: [],
            questionIds: [],
            related: [{ id: "obj-po", kind: "object", relationship: "contains" }],
            data: { entry: "node-submit", exits: ["node-approved"] },
          },
        ],
      },
      review: {
        revision: 3,
        nextBatch: ["q-tax"],
        questions: [{
          id: "q-tax",
          text: "订单金额是含税还是不含税？",
          status: "open",
          priority: "blocking",
          scopeRefs: ["obj-po"],
          blockedArtifacts: ["ontology.package.json"],
        }],
        conflicts: [{
          id: "cf-tax",
          kind: "semantic_divergence",
          summary: "订单金额含税口径不一致",
          status: "open",
          handling: "ask_user",
          subjectIds: ["obj-po"],
          evidenceIds: ["ev1"],
        }],
        inferences: [{ id: "wf-approval", label: "采购订单审批流程", status: "candidate", reason: "missing_evidence" }],
        queue: [{
          id: "inference:wf-approval",
          kind: "inference",
          title: "采购订单审批流程",
          status: "needs_review",
          subjectIds: ["wf-approval"],
          evidenceIds: [],
        }],
      },
      delivery: {
        revision: 12,
        releaseState: "DRAFT",
        blockedBy: ["q-tax"],
        formats: ["json", "svg"],
        artifacts: [{
          id: "a1", name: "ontology.package.json", kind: "ontology", format: "json",
          downloadUrl: "/api/sessions/ctx-1/artifacts/ontology.package.json",
        }],
      },
    });

    expect(view.project).toMatchObject({
      id: "ctx-1",
      title: "采购订单梳理",
      stage: "review",
      revision: "r12",
      nextAction: "处理 1 个阻塞问题",
      releaseState: "BLOCKED",
    });
    expect(view.evidence).toMatchObject({ parsedCount: 1, problemCount: 0 });
    expect(view.evidence.references[0]).toMatchObject({ id: "ev1", fileName: "采购流程.docx" });
    const order = findModelEntity(view, "obj-po")!;
    expect(order.name).toBe("采购订单");
    expect(order.attributes).toContainEqual({ key: "owner", label: "owner", value: "采购部" });
    expect(order.evidence[0]).toMatchObject({ id: "ev1", sourceIds: expect.arrayContaining(["obj-po", "q-tax"]) });
    expect(order.relations).toContainEqual(expect.objectContaining({ targetId: "wf-approval", meta: "participates_in" }));
    expect(order.pending.map((item) => item.id)).toEqual(expect.arrayContaining(["q-tax", "cf-tax"]));
    expect(view.review.inferences).toContainEqual(expect.objectContaining({ id: "inference:wf-approval" }));
    expect(findModelEntity(view, "wf-approval")!.pending).toContainEqual(expect.objectContaining({
      id: "inference:wf-approval",
    }));
    expect(view.delivery.formats).toEqual(["json", "svg"]);
    expect(view.delivery.artifacts[0]!.downloadPath).toContain("/api/sessions/ctx-1/artifacts/");
  });
});

describe("筛选、详情与跨区搜索", () => {
  it("类型别名、关系/证据/待确认全文都可筛", () => {
    const view = buildContextViewModel(legacySnapshot());
    expect(normalizeModelKind("ObjectType")).toBe("object");
    expect(normalizeModelKind("workflows")).toBe("process");
    expect(filterModelEntities(view.model, { kind: "objects" })).toHaveLength(2);
    expect(filterModelEntities(view.model, { kind: "不存在" })).toEqual([]);

    const supplierMatches = filterModelEntities(view.model, { kind: "object", query: "供应商" });
    expect(supplierMatches.map((item) => item.id)).toEqual(expect.arrayContaining(["ot_po", "ot_supplier"]));
    expect(filterModelEntities(view.model, { query: "采购订单金额是否含税" }).map((item) => item.id)).toContain("ot_po");
    expect(findModelEntity(view.model.entities, "submitPurchaseOrder")!.id).toBe("at_submit_po");
    expect(findModelEntity(view, "没有这个实体")).toBeNull();
  });

  it("全局搜索覆盖材料、证据、模型、审阅与产物", () => {
    const view = buildContextViewModel(legacySnapshot());
    expect(searchContext(view, "文件损坏").materials[0]!.name).toBe("访谈纪要.docx");
    expect(searchContext(view, "R10-10").evidence[0]!.cite).toContain("R10-10");
    expect(searchContext(view, "授信额度").entities.map((item) => item.id)).toContain("br_credit");
    expect(searchContext(view, "业务负责人").review.map((item) => item.id)).toContain("q_owner");
    expect(searchContext(view, "svg").artifacts[0]!.name).toBe("流程图.svg");
  });
});

describe("异常数据兜底", () => {
  it("null、错类型与缺字段不抛，输出形状保持完整", () => {
    expect(() => buildContextViewModel(null)).not.toThrow();
    const empty = buildContextViewModel({
      id: 0,
      state: { oir: "坏数据", flow: { nodes: [null, "bad"] }, conflicts: "bad", artifacts: [null, 7] },
      filelist: [null, { name: "", chunks: "NaN" }],
    });
    expect(empty.project).toMatchObject({ title: "未命名项目", releaseState: "DRAFT" });
    expect(empty.evidence.materials).toEqual([]);
    expect(empty.model.entities).toEqual([]);
    expect(empty.review.items).toEqual([]);
    expect(empty.delivery.artifacts).toEqual([]);
    expect(searchContext(empty, "")).toEqual({
      materials: [], evidence: [], entities: [], review: [], artifacts: [],
    });
  });

  it("无 id 的同名行仍得到确定且互不碰撞的 fallback id", () => {
    const input = { context: { model: { objects: [{ name: "对象" }, { name: "对象" }] } } };
    const first = buildContextViewModel(input);
    const second = buildContextViewModel(input);
    expect(first.model.entities.map((item) => item.id)).toEqual(second.model.entities.map((item) => item.id));
    expect(new Set(first.model.entities.map((item) => item.id)).size).toBe(2);
  });
});
