/** FDE 右侧上下文聚合接口：五域 read model 与只读语义。 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  Question,
  QuestionBacklog,
  QuestionPriority,
  QuestionStatus,
} from "../src/onto/questions.js";
import type { AppEnv } from "../src/server/app.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { setRepoForTests } from "../src/store/deps.js";
import {
  makeFileRow,
  makeRevisionRow,
  makeSessionRow,
  questionRowFromDomain,
  type JsonObject,
} from "../src/store/types.js";

// session.ts 在 import 时读取 workspace；因此 route 与 session 都在设 env 后动态导入。
const ROOT = join(tmpdir(), `ontocopilot-context-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const {
  Session,
  SESSIONS,
  refreshRoot,
  registerHydrator,
} = await import("../src/server/session.js");
const {
  CONTEXT_SCHEMA_VERSION,
  registerContextRoutes,
} = await import("../src/server/routes/context.js");
type SessionT = InstanceType<typeof Session>;

let repo: MemoryRepo;
let app: Hono<AppEnv>;

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
  registerHydrator(async (sid: string) => {
    throw new HTTPException(404, { message: `没有会话 ${sid}` });
  });
});

afterAll(() => {
  registerHydrator(null);
  setRepoForTests(null);
  SESSIONS.clear();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  repo = new MemoryRepo();
  setRepoForTests(repo);
  SESSIONS.clear();
  app = new Hono<AppEnv>();
  app.onError((err) => {
    if (err instanceof HTTPException) {
      if (err.res !== undefined) return err.getResponse();
      return Response.json({ detail: err.message }, { status: err.status });
    }
    return Response.json({ detail: err instanceof Error ? err.message : String(err) }, { status: 500 });
  });
  registerContextRoutes(app);
});

async function makeSession(
  id: string,
  init: ConstructorParameters<typeof Session>[1] = {},
): Promise<SessionT> {
  await repo.createSession(makeSessionRow({
    id,
    title: init.title ?? "新建会话",
    project: init.project ?? "",
    project_id: init.projectId ?? "",
    status: init.status ?? "idle",
    created: init.created ?? 0,
    state_version: init.stateVersion ?? 0,
  }));
  const s = new Session(id, init);
  SESSIONS.set(id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

function backlog(...questions: Question[]): QuestionBacklog {
  const bag = new QuestionBacklog();
  for (const question of questions) bag.add(question, { preserveLifecycle: false });
  return bag;
}

function assertion(value: unknown, evidence: readonly unknown[] = [], origin = "extracted") {
  return { value, origin, confidence: origin === "inferred" ? 0.4 : 0.9, evidence };
}

describe("GET /api/sessions/:sid/context", () => {
  it("把材料、模型、审阅与交付聚合成同一个前端 read model", async () => {
    const evidence = {
      file_id: "file-procurement",
      file_name: "采购流程.docx",
      locator: { page: 4, paragraph: 2 },
      snippet: "采购订单提交后由部门负责人审批。",
      extractor: "document",
      confidence: 0.92,
      cite: "采购流程.docx · 第 4 页",
    };
    const question = new Question({
      id: "q-tax",
      text: "订单金额是含税还是不含税？",
      status: QuestionStatus.OPEN,
      priority: QuestionPriority.BLOCKING,
      blockedArtifacts: ["ontology.package.json"],
      sourceKind: "conflict",
      sourceRef: "cf-tax",
      scopeRefs: ["obj-po"],
      audienceRole: "财务",
      why: "口径会影响订单金额字段",
      createdAt: 1,
      updatedAt: 1,
    });
    const s = await makeSession("ctx-1", {
      title: "采购订单梳理",
      project: "供应链项目",
      projectId: "project-1",
      status: "done",
      stateVersion: 4,
    });
    await repo.addFiles(s.id, [
      makeFileRow({
        name: "采购流程.docx",
        rel_path: `${s.id}/materials/采购流程.docx`,
        size: 4096,
        sha256: "abc",
      }),
    ]);
    s.state["_chunks"] = { "采购流程.docx": [{ cite: "p4" }] };
    s.state["question_backlog"] = backlog(question).toDict();
    s.state["artifact_revision"] = 12;
    s.state["release_state"] = "RELEASED";
    s.state["artifacts"] = ["ontology.package.json", "流程图.svg", "问题清单.xlsx"];
    s.state["oir"] = {
      objects: [
        {
          rid: "obj-po",
          kind: "ObjectType",
          apiName: assertion("PurchaseOrder", [evidence]),
          displayName: assertion("采购订单", [evidence]),
          description: assertion("记录采购、审批与履约状态", [evidence]),
          primaryKey: assertion(["prop-po-no"], [evidence]),
          properties: ["prop-po-no"],
          aliases: ["订单"],
          owner: "采购部",
          status: "confirmed",
          conflicts: ["cf-tax"],
        },
        {
          rid: "obj-supplier",
          kind: "ObjectType",
          apiName: assertion("Supplier", [evidence]),
          displayName: assertion("供应商", [evidence]),
          description: assertion("供应商主数据", [evidence]),
          primaryKey: assertion(["supplierId"], [evidence]),
          properties: [],
          aliases: [],
          owner: null,
          status: "confirmed",
          conflicts: [],
        },
      ],
      properties: [
        {
          rid: "prop-po-no",
          parent: "obj-po",
          kind: "PropertyType",
          apiName: assertion("orderNumber", [evidence]),
          displayName: assertion("订单编号", [evidence]),
          baseType: assertion("STRING", [evidence]),
          definition: assertion("采购订单的唯一编号", [evidence]),
          semanticType: assertion(null, [evidence]),
          unit: assertion(null, [evidence]),
          valueDomain: assertion(null, [evidence]),
          required: assertion(true, [evidence]),
          owner: "采购部",
          status: "confirmed",
          conflicts: [],
        },
      ],
      links: [
        {
          rid: "link-po-supplier",
          kind: "LinkType",
          apiName: assertion("supplier", [evidence]),
          from: "obj-po",
          to: "obj-supplier",
          cardinality: assertion("MANY_TO_ONE", [evidence]),
          joinKey: assertion({ supplierId: "supplierId" }, [evidence]),
          status: "confirmed",
          conflicts: [],
        },
      ],
      actions: [
        {
          rid: "act-place-order",
          kind: "ActionType",
          apiName: assertion("placeOrder", [], "inferred"),
          appliesTo: ["obj-po"],
          parameters: assertion([], [], "inferred"),
          effects: assertion(["订单进入待审批"], [], "inferred"),
          sourceEndpoint: assertion(null, [], "inferred"),
          status: "draft_from_api",
        },
      ],
      rules: [
        {
          rid: "rule-approval",
          kind: "BusinessRule",
          statement: assertion("金额超过十万元需要部门负责人审批", [evidence]),
          ruleKind: assertion("AUTHORITY", [evidence]),
          appliesTo: ["obj-po"],
          actor: assertion("部门负责人", [evidence]),
          status: "confirmed",
        },
      ],
      questions: [],
      stats: {},
    };
    s.state["flow"] = {
      stages: [{ key: "approval", title: "审批", subtitle: "", order: 1 }],
      workflows: [{
        key: "wf-approval",
        title: "采购订单审批流程",
        entry: "node-submit",
        exits: ["node-approved"],
        description: "订单从提交到审批通过",
      }],
      nodes: [
        {
          rid: "node-submit",
          kind: "action",
          code: "ACT-PO-SUBMIT",
          label: assertion("提交订单", [evidence]),
          stage: "approval",
          actor: assertion("采购员", [evidence]),
          objects: ["obj-po"],
          endpoint: "",
          status: "confirmed",
          grounded: true,
        },
        {
          rid: "node-approved",
          kind: "event",
          code: "EVT-PO-APPROVED",
          label: assertion("订单已审批", [], "inferred"),
          stage: "approval",
          actor: assertion("", [], "inferred"),
          objects: ["obj-po"],
          endpoint: "",
          status: "candidate",
          grounded: false,
        },
      ],
      edges: [{
        rid: "edge-submit-approved",
        from: "node-submit",
        to: "node-approved",
        kind: "flow",
        label: "",
        grounded: true,
        evidence: [evidence],
      }],
      stats: { inferred_edges: 0 },
    };
    s.state["conflicts"] = [{
      rid: "cf-tax",
      kind: "semantic_divergence",
      subjects: ["obj-po"],
      summary: "订单金额含税口径不一致",
      handling: "ask_user",
      evidence: [evidence],
      options: [{ id: "net", label: "不含税", evidence: [evidence], effect: {} }],
      owner: "财务",
      detector: "rule",
    }];
    await repo.recordRevision(s.id, makeRevisionRow({
      id: "rev-3",
      ordinal: 3,
      parent_id: null,
      kind: "question.answer",
      status: "applied",
      doc: {},
      changed_ids: ["obj-po"],
      invalidated_artifacts: ["ontology.package.json"],
      actor: "fde",
      created: 10,
    }));

    const beforeState = JSON.stringify(s.state);
    const response = await app.request(`/api/sessions/${s.id}/context`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;

    expect(body.schemaVersion).toBe(CONTEXT_SCHEMA_VERSION);
    expect(Object.keys(body)).toEqual([
      "schemaVersion", "project", "evidence", "model", "review", "delivery",
    ]);
    expect(body.project).toMatchObject({
      stage: "review",
      releaseState: "DRAFT",
      revision: { label: "r12", model: 12, review: 3, state: 4 },
      nextAction: { kind: "resolve_blockers", target: "review" },
    });
    expect(body.project.activity[0]).toMatchObject({ id: "rev-3", revision: 3 });

    expect(body.evidence.materials).toEqual([
      expect.objectContaining({
        name: "采购流程.docx",
        size: 4096,
        chunks: 1,
        state: "parsed",
        sourceUrl: `/api/sessions/${s.id}/source?file=${encodeURIComponent("采购流程.docx")}`,
      }),
    ]);
    // 同一出处在对象、字段、流程与冲突中反复出现，registry 只保留一份。
    expect(body.evidence.records).toHaveLength(1);
    expect(body.evidence.records[0].relatedIds).toContain("obj-po");
    expect(body.evidence.counts).toMatchObject({ materials: 1, parsed: 1, records: 1 });

    expect(body.model.counts).toMatchObject({
      objects: 2,
      properties: 1,
      links: 1,
      actions: 1,
      rules: 1,
      processes: 1,
      processSteps: 1,
      events: 1,
      total: 9,
    });
    const purchaseOrder = body.model.items.find((item: any) => item.id === "obj-po");
    expect(purchaseOrder).toMatchObject({
      type: "object",
      label: "采购订单",
      apiName: "PurchaseOrder",
      grounded: true,
      data: { propertyIds: ["prop-po-no"] },
    });
    expect(purchaseOrder.related).toEqual(expect.arrayContaining([
      { id: "link-po-supplier", kind: "link", relationship: "outgoing" },
      { id: "wf-approval", kind: "process", relationship: "participates_in" },
    ]));

    expect(body.review.nextBatch).toEqual(["q-tax"]);
    expect(body.review.workbench).toMatchObject({
      schemaVersion: "ontocopilot.fde-review/1",
      summary: { originalQuestions: 1, visibleItems: 1 },
    });
    expect(body.review.workbench.items[0]).toMatchObject({
      primaryQuestionId: "q-tax",
      domain: "rule_threshold",
    });
    expect(body.review.counts).toMatchObject({
      questions: 1,
      blockingQuestions: 1,
      conflicts: 1,
      openConflicts: 1,
    });
    expect(body.review.queue).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "q-tax", kind: "question", blocking: true }),
      expect.objectContaining({ id: "cf-tax", kind: "conflict", blocking: true }),
      expect.objectContaining({ id: "inference:node-approved", kind: "inference" }),
    ]));

    expect(body.delivery).toMatchObject({
      revision: 12,
      releaseState: "DRAFT",
      blockedBy: ["q-tax"],
      formats: ["json", "svg", "xlsx"],
      bundle: { available: false, url: `/api/sessions/${s.id}/bundle` },
    });
    expect(body.delivery.artifacts.find((item: any) => item.name === "流程图.svg"))
      .toMatchObject({ kind: "process", format: "svg", previewable: true });

    // GET 聚合不回写 question / decision projection，也不修改现有业务 state。
    expect(JSON.stringify(s.state)).toBe(beforeState);
  });

  it("优先读取 repo 中的权威问题，而不是旧的 session projection", async () => {
    const s = await makeSession("ctx-authority", { status: "done" });
    const stale = new Question({ id: "q-stale", text: "旧问题", createdAt: 1, updatedAt: 1 });
    const live = new Question({
      id: "q-live",
      text: "仓储里的问题",
      priority: QuestionPriority.HIGH,
      createdAt: 2,
      updatedAt: 2,
    });
    s.state["question_backlog"] = backlog(stale).toDict();
    await repo.upsertQuestions(s.id, [
      questionRowFromDomain({ toDict: () => live.toDict() as JsonObject }),
    ]);

    const response = await app.request(`/api/sessions/${s.id}/context`);
    const body = await response.json() as Record<string, any>;
    expect(body.review.questions.map((question: any) => question.id)).toEqual(["q-live"]);
    expect(body.review.queue[0]).toMatchObject({ id: "q-live", title: "仓储里的问题" });
    expect((s.state["question_backlog"] as Record<string, any>).questions[0].id).toBe("q-stale");
  });

  it("空会话仍返回完整五域契约，并把下一步指向材料", async () => {
    const s = await makeSession("ctx-empty");
    const response = await app.request(`/api/sessions/${s.id}/context`);
    const body = await response.json() as Record<string, any>;

    expect(body.project).toMatchObject({
      stage: "intake",
      revision: { label: "draft", model: 0, review: 0 },
      nextAction: { kind: "add_material", target: "evidence" },
    });
    expect(body.evidence.materials).toEqual([]);
    expect(body.model).toMatchObject({ counts: { total: 0 }, items: [] });
    expect(body.review).toMatchObject({ counts: { queue: 0 }, queue: [] });
    expect(body.delivery).toMatchObject({ artifacts: [], formats: [], bundle: { available: false } });
  });

  it("沿用现有 HTTPException 错误约定", async () => {
    const response = await app.request("/api/sessions/not-found/context");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "没有会话 not-found" });
  });
});
