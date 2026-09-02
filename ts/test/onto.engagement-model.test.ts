/** Model-backed FDE professional analysis: coverage, tool scope and fail-closed merge. */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { AgentBus } from "../src/kernel/bus/bus.js";
import { CriticPanel } from "../src/kernel/critic.js";
import { EventKind } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import {
  ModelGateway,
  Usage,
  stubRouting,
  type GenerateArgs,
  type LLMBackend,
} from "../src/kernel/llm.js";
import { AgentLoop, type RunContext } from "../src/kernel/loop.js";
import { ContextManager } from "../src/kernel/memory/context.js";
import { Scratchpad } from "../src/kernel/memory/short_term.js";
import { Recorder } from "../src/kernel/recorder.js";
import { RunStatus, Scheduler } from "../src/kernel/scheduler.js";
import { buildFdeEngagementDag } from "../src/onto/engagement.js";
import { OIR, extracted, makeBusinessRule, makeObjectType } from "../src/onto/oir.js";
import {
  EngagementRuntimeInput,
  ExportHandler,
  RequirementsHandler,
  ReviewHandler,
  applyProfessionalAnalysis,
  engagementCritics,
  engagementHandlers,
  materialGroundingReport,
  type EngagementToolRegistry,
} from "../src/onto/engagement_runtime.js";
import { QuestionBacklog } from "../src/onto/questions.js";

type Dict = Record<string, unknown>;

function schemaSample(schema: Record<string, unknown>): unknown {
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  if (properties?.["thought"] !== undefined && properties["action"] !== undefined) {
    return {
      thought: "确定性基线足以进入最终合并",
      action: { kind: "finish", tool: "", args_json: "{}" },
    };
  }
  const type = schema["type"];
  if (Array.isArray(type)) {
    if (type.includes("null")) return null;
    return schemaSample({ ...schema, type: type[0] });
  }
  if (type === "object") {
    return Object.fromEntries(
      Object.entries(properties ?? {}).map(([key, child]) => [key, schemaSample(child)]),
    );
  }
  if (type === "array") return [];
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0) return values[0];
  if (type === "integer" || type === "number") return Number(schema["minimum"] ?? 0);
  if (type === "boolean") return false;
  return "x";
}

class SchemaBackend implements LLMBackend {
  readonly calls: GenerateArgs[] = [];

  generate(args: GenerateArgs): Promise<[string, Usage]> {
    this.calls.push(args);
    const body = JSON.stringify(schemaSample(args.schema ?? { type: "object", properties: {} }));
    return Promise.resolve([body, new Usage({ tok_in: 1, tok_out: 1 })]);
  }
}

function runtime(): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "model-test",
    project: "采购到付款",
    oir: {
      objects: [
        {
          rid: "ot_order",
          apiName: { value: "PurchaseOrder", evidence: [] },
          displayName: { value: "采购订单", evidence: [] },
          primaryKey: { value: [], evidence: [] },
        },
      ],
      rules: [
        {
          rid: "br_lock",
          statement: { value: "订单审批后不得改价", evidence: [{ cite: "制度.md!P3" }] },
          ruleKind: { value: "VALIDATION", evidence: [] },
          appliesTo: ["ot_order"],
        },
      ],
    },
    flow: {
      nodes: [
        {
          rid: "step.approve",
          label: { value: "审批订单", evidence: [{ cite: "流程.md!P2" }] },
          actor: { value: "待确认", evidence: [] },
          objects: ["ot_order"],
          endpoint: "https://erp.example/api/order",
        },
      ],
      edges: [],
    },
    backlog: new QuestionBacklog(),
    generatedAt: "2026-08-18T00:00:00+00:00",
    evidenceRefs: ["流程.md!P2", "制度.md!P3"],
    evidenceRecords: [
      {
        cite: "流程.md!P2",
        file_id: "flow",
        file_name: "流程.md",
        locator: { kind: "page", page: 2 },
        snippet: "审批订单由采购经理处理。收到审批请求后，前提是订单已提交。",
      },
      {
        cite: "制度.md!P3",
        file_id: "rule",
        file_name: "制度.md",
        locator: { kind: "page", page: 3 },
        snippet: "订单审批后不得改价。",
      },
    ],
  });
}

describe("model-backed engagement handlers", () => {
  it("生产传入活 OIR 实例时，专业 seed 不会把 Map 桶误读成空", () => {
    const oir = new OIR();
    oir.addObject(
      makeObjectType({
        rid: "ot_live",
        apiName: extracted("liveObject"),
        displayName: extracted("生产对象"),
      }),
    );
    oir.addRule(
      makeBusinessRule({ rid: "br_live", statement: extracted("生产规则必须保留") }),
    );
    const rt = new EngagementRuntimeInput({
      sessionId: "live-oir",
      project: "p",
      oir,
      backlog: new QuestionBacklog(),
    });
    const handlers = engagementHandlers(rt);
    expect((handlers["agent.data_steward"]!.skipModel({}) as Dict)["data_objects"]).toHaveLength(1);
    expect((handlers["agent.rule_engineer"]!.skipModel({}) as Dict)["rules"]).toHaveLength(1);
  });

  it("正式模式十个专业节点都进入模型；兼容/离线模式仍是零模型投影", () => {
    const rt = runtime();
    const live = engagementHandlers(rt, { modelAnalysis: true });
    const offline = engagementHandlers(rt);
    for (const key of [
      "agent.fde_interviewer",
      "agent.process_modeler",
      "agent.erp_mapper",
      "agent.rule_engineer",
      "agent.data_steward",
      "agent.decision_integrator",
      "agent.requirements_engineer",
      "agent.solution_architect",
      "agent.acceptance_test_engineer",
      "agent.delivery_reviewer",
    ]) {
      expect(live[key]!.skipModel({}), key).toBeNull();
      expect(offline[key]!.skipModel({}), key).not.toBeNull();
    }
  });

  it("正式 Engagement 经真实 AgentLoop 为十个专业节点产生模型 effect", async () => {
    const journal = new InMemoryJournal();
    const recorder = new Recorder("model-backed-run", journal, new InMemoryBlobStore());
    const backend = new SchemaBackend();
    const budget = new Budget({ tokens: 1_000_000, usd: 10 });
    const gateway = new ModelGateway(backend, recorder, { routing: stubRouting(), budget });
    const bus = new AgentBus(recorder);
    const loop = new AgentLoop({
      gateway,
      ctxManager: new ContextManager({ system: "FDE engagement", budgetTokens: 90_000 }),
      panel: new CriticPanel(engagementCritics(), recorder),
      bus,
      recorder,
      budget,
      handlers: engagementHandlers(runtime(), { modelAnalysis: true }),
      newScratchpad: (tokens) => new Scratchpad({ budgetTokens: tokens }),
    });
    const outcome = await new Scheduler(
      buildFdeEngagementDag(),
      loop,
      recorder,
      bus,
      budget,
      { concurrency: 4 },
    ).run("model-backed-run");

    expect(outcome.status).toBe(RunStatus.SUSPENDED);
    expect(outcome.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
    const modelNodes = new Set(
      [...journal.read("model-backed-run")]
        .filter(
          (event) =>
            event.kind === EventKind.EFFECT_COMPLETED && event.payload["kind"] === "llm.call",
        )
        .map((event) => event.nodeId),
    );
    expect(modelNodes).toEqual(
      new Set([
        "INTAKE",
        "PROCESS",
        "ERP_MAP",
        "RULES",
        "DATA_OBJECTS",
        "DECISION_PROPOSAL",
        "REQUIREMENTS",
        "ARCHITECTURE",
        "TEST_PLAN",
        "REVIEW",
      ]),
    );
    expect(backend.calls.length).toBeGreaterThanOrEqual(20);
  });

  it("大基线给模型的是有效、带 omitted 计数的有界目标，完整行仍由 finalize 保留", () => {
    const objects = Array.from({ length: 35 }, (_, index) => ({
      rid: `ot_${index}`,
      apiName: { value: `Object${index}`, evidence: [] },
      displayName: { value: `对象${index}`, evidence: [] },
      primaryKey: { value: [], evidence: [] },
    }));
    const rt = new EngagementRuntimeInput({
      sessionId: "bounded-seed",
      project: "p",
      oir: { objects },
      backlog: new QuestionBacklog(),
    });
    const handler = engagementHandlers(rt, { modelAnalysis: true })[
      "agent.data_steward"
    ]!;
    const task = handler.task({});
    expect(task).toContain('"omitted": 5');
    expect(task).toContain('"id": "ot_29"');
    expect(task).not.toContain('"id": "ot_30"');

    const finalized = handler.finalize({ data_objects: [], quality_rules: [], questions: [] }, {});
    expect((finalized as Dict)["data_objects"]).toHaveLength(35);
  });

  it("模型漏行或试图改稳定字段时，finalize 保住 seed，只接纳语义空槽", () => {
    const handler = engagementHandlers(runtime(), { modelAnalysis: true })[
      "agent.process_modeler"
    ]!;
    const out = handler.finalize(
      {
        process_id: "伪造",
        perspective: "TO_BE",
        steps: [
          {
            id: "step.approve",
            name: "被模型改名",
            actor_role: "采购经理",
            trigger: "收到审批请求",
            precondition: "订单已提交",
            input_data_ids: ["ot_order", "hallucinated"],
            output_data_ids: ["ot_order"],
            system_ids: ["sys.fake"],
            evidence_ids: ["流程.md!P2", "fake"],
          },
        ],
        edges: [],
        gaps: ["需要确认审批额度"],
      },
      {},
    ) as Dict;
    const step = (out["steps"] as Dict[])[0]!;
    expect(out["process_id"]).toBe("proc.model-test");
    expect(out["perspective"]).toBe("AS_IS");
    expect(step["name"]).toBe("审批订单");
    expect(step["actor_role"]).toBe("采购经理");
    expect(step["trigger"]).toBe("收到审批请求");
    expect(step["analysis_evidence_ids"]).toEqual(["流程.md!P2"]);
    expect(step["input_data_ids"]).toEqual(["ot_order"]);
    expect(step["system_ids"]).toEqual(["https://erp.example/api/order"]);
    expect(out["gaps"]).toContain("需要确认审批额度");
  });

  it("scope 来自 AgentSpec，action 伪造不了；ERP 可画像，Process 不可", async () => {
    const calls: { name: string; scope: string }[] = [];
    const tools: EngagementToolRegistry = {
      async call(name, _args, _ctx, opts) {
        calls.push({ name, scope: opts.scope });
        return { ok: true };
      },
    };
    const hs = engagementHandlers(runtime(), { modelAnalysis: true, tools });
    const ctx = {} as RunContext;
    const denied = (await hs["agent.process_modeler"]!.dispatch(
      { tool: "profile.column", scope: "erp_map", args: {} },
      ctx,
    )) as Dict;
    expect(String(denied["error"])).toContain("不允许");
    expect(calls).toEqual([]);

    await hs["agent.erp_mapper"]!.dispatch(
      { tool: "profile.column", scope: "*", args: { column: "amount" } },
      ctx,
    );
    expect(calls).toEqual([{ name: "profile.column", scope: "erp_map" }]);
  });

  it("Reviewer 的模型 PASS 不能覆盖确定性 blocker/downloadable", () => {
    const rt = new EngagementRuntimeInput({
      sessionId: "review-test",
      project: "p",
      oir: {},
      backlog: new QuestionBacklog(),
      releaseDownloadable: false,
    });
    const review = engagementHandlers(rt, { modelAnalysis: true })[
      "agent.delivery_reviewer"
    ]!;
    const out = review.finalize(
      {
        verdict: "PASS",
        blockers: [],
        warnings: [],
        traceability: { checked: 999, unresolved: [] },
        artifact_checks: [],
      },
      { CANONICALIZE: {} },
    ) as Dict;
    expect(out["verdict"]).toBe("BLOCKED");
    expect(Number(out["blocker_count"])).toBeGreaterThan(0);
    expect((out["artifact_checks"] as Dict[]).every((row) => row["downloadable"] === false)).toBe(
      true,
    );
    expect((out["traceability"] as Dict)["checked"]).toBe(0);
  });

  it("GAP 把专业新问题变成稳定 Backlog 项，而不是一次性展示文本", async () => {
    const rt = runtime();
    const gap = engagementHandlers(rt)["engagement.collect_gaps"]!;
    const first = (await gap.execute(
      {
        ERP_MAP: {
          questions: [
            {
              text: "当前 ERP 产品和版本是什么？",
              priority: "BLOCKING",
              blocked_artifacts: ["ontology.package.json"],
            },
          ],
        },
      },
      {} as RunContext,
    )) as Dict;
    const second = (await gap.execute(
      { ERP_MAP: { questions: ["当前 ERP 产品和版本是什么？"] } },
      {} as RunContext,
    )) as Dict;
    expect(first["agent_added"]).toBe(1);
    expect(second["agent_added"]).toBeUndefined();
    const rows = first["questions"] as Dict[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!["id"]).toMatch(/^q\.agent\./);
    expect(rows[0]!["sourceKind"]).toBe("agent_analysis");
    expect(rows[0]!["priority"]).toBe("high");
    expect(rows[0]!["blockedArtifacts"]).toEqual([]);
    expect(rt.blockers()).toEqual([]);
  });

  it("模型不能借用 seed 证据或伪造 cite 为新增语义背书", () => {
    const pkg: Dict = {
      processes: [
        {
          id: "proc.x",
          nodes: [{ id: "pn.approve", legacyId: "step.approve", actorRole: null }],
        },
      ],
      dataObjects: [],
      rules: [],
      events: [],
      roles: [],
      systems: [],
      evidence: [
        {
          id: "ev.placeholder",
          cite: "流程.md!P2",
          fileId: "",
          fileName: "",
          locator: {},
          snippet: "",
          extractor: "question-backlog",
          confidence: 0.5,
        },
      ],
    };
    const out = applyProfessionalAnalysis(
      pkg,
      {
        PROCESS: {
          steps: [
            {
              id: "step.approve",
              actor_role: "伪造角色",
              trigger: "伪造触发条件",
              evidence_ids: ["流程.md!P2"],
              analysis_evidence_ids: ["fake-cite"],
            },
          ],
        },
      },
      new Set(["流程.md!P2"]),
    );
    const node = ((out["processes"] as Dict[])[0]!["nodes"] as Dict[])[0]!;
    expect(node["actorRole"]).toBeNull();
    expect(node["trigger"]).toBeUndefined();
    expect(node["analysisEvidenceIds"]).toBeUndefined();
    expect(out["roles"]).toEqual([]);
    expect(out["evidence"]).toEqual(pkg["evidence"]);
  });

  it("OIR 里模型自带的 cite 不能反向进入可信证据集合", () => {
    const rt = new EngagementRuntimeInput({
      sessionId: "self-certified",
      project: "p",
      oir: {
        objects: [{
          rid: "ot.fake",
          apiName: { value: "Fake", evidence: [{ cite: "fake!p1" }] },
          displayName: { value: "伪造对象", evidence: [{ cite: "fake!p1" }] },
        }],
      },
    });
    expect(rt.verifiedEvidence(["fake!p1"])).toEqual([]);
  });

  it("真实但无关的 cite 不能把董事长、火星到货等内容写进 canonical package", () => {
    const pkg: Dict = {
      processes: [{
        id: "proc.x",
        nodes: [{ id: "pn.approve", legacyId: "step.approve", actorRole: null }],
      }],
      dataObjects: [], rules: [], events: [], roles: [], systems: [], evidence: [],
    };
    const cite = "流程.md!P2";
    const out = applyProfessionalAnalysis(pkg, {
      PROCESS: { steps: [{
        id: "step.approve",
        actor_role: "董事长",
        trigger: "火星到货",
        precondition: "金额一亿元",
        analysis_evidence_ids: [cite],
      }] },
    }, new Set([cite]), [{
      cite,
      file_id: "f1",
      file_name: "流程.md",
      locator: { kind: "page", page: 2 },
      snippet: "采购申请由申请人提交。",
    }]);
    const node = ((out["processes"] as Dict[])[0]!["nodes"] as Dict[])[0]!;
    expect(node["actorRole"]).toBeNull();
    expect(node["trigger"]).toBeUndefined();
    expect(node["precondition"]).toBeUndefined();
    expect(out["roles"]).toEqual([]);
  });

  it("专业模型不能把待确认需求无证据升级成已确认、必须和已覆盖", () => {
    const rt = runtime();
    const handler = new RequirementsHandler(rt, { modelAnalysis: true });
    const inputs = { RULES: { rules: [{
      id: "br_lock",
      effect: "订单审批后不得改价",
      condition: "订单审批后不得改价",
      evidence_ids: ["制度.md!P3"],
    }] } };
    const seed = handler.project(inputs);
    const requirement = (seed["requirements"] as Dict[])[0]!;
    const coverage = (seed["coverage_assessments"] as Dict[])[0]!;
    const out = handler.finalize({
      requirements: [{
        ...requirement,
        statement: "客户已确认必须上火星",
        confirmation_status: "CONFIRMED",
        priority: "MUST",
        evidence_ids: [],
        analysis_evidence_ids: [],
      }],
      coverage_assessments: [{ ...coverage, status: "FIT", evidence_ids: [] }],
      questions: [],
    }, inputs) as Dict;
    const got = (out["requirements"] as Dict[])[0]!;
    expect(got["statement"]).toBe(requirement["statement"]);
    expect(got["confirmation_status"]).toBe("CANDIDATE");
    expect(got["priority"]).toBe("UNSET");
    expect((out["coverage_assessments"] as Dict[])[0]!["status"]).toBe("UNKNOWN");
  });

  it("ERP/规则/数据治理增强会进入 canonical package 的业务字段", () => {
    const pkg: Dict = {
      processes: [
        {
          id: "proc.x",
          nodes: [{ id: "pn.approve", legacyId: "step.approve", actorRole: null }],
        },
      ],
      dataObjects: [
        {
          id: "obj.order",
          legacyId: "ot_order",
          lifecycleStates: [],
          sensitivity: "internal",
          systemOfRecord: null,
          ownerRole: null,
        },
      ],
      rules: [
        {
          id: "rule.lock",
          legacyId: "br_lock",
          rawStatement: "订单审批后不得改价",
          normalizedExpression: null,
          outcome: {},
          exceptions: [],
          compileStatus: "uncompiled",
        },
      ],
      events: [],
      roles: [],
      systems: [],
      evidence: [],
    };
    const allowedEvidence = new Set([
      "流程.md!P2",
      "配置.md!P4",
      "制度.md!P3",
      "数据字典.xlsx!订单",
    ]);
    const snippets: Record<string, string> = {
      "流程.md!P2": "审批订单由采购经理处理，提交订单后进入审批。",
      "配置.md!P4": "sys.erp 使用 SAP S/4HANA 2023 MM，中国区采用 CONFIGURATION，事务 ME29N。",
      "制度.md!P3": "规则 status == APPROVED，审批后 price immutable；例外为管理员撤回。",
      "数据字典.xlsx!订单": "订单由 sys.erp 负责，采购经理维护；状态 DRAFT、APPROVED，敏感级别 CONFIDENTIAL。COMPLETENESS 规则 order_no != null，阈值 1。",
    };
    const evidenceRecords: Dict[] = [...allowedEvidence].map((cite, index) => ({
      cite,
      file_id: `file-${index}`,
      file_name: cite.split("!")[0],
      locator: { kind: "page", page: index + 1 },
      snippet: snippets[cite],
      extractor: "evidence-index",
      confidence: 1,
    }));
    const out = applyProfessionalAnalysis(pkg, {
      PROCESS: {
        steps: [
          {
            id: "step.approve",
            actor_role: "采购经理",
            trigger: "提交订单",
            precondition: null,
            evidence_ids: ["流程.md!P2"],
            analysis_evidence_ids: ["流程.md!P2"],
          },
        ],
      },
      ERP_MAP: {
        landscape: [
          {
            system_id: "sys.erp",
            product: "SAP S/4HANA",
            version: "2023",
            module: "MM",
            org_scope: "中国区",
            evidence_ids: ["配置.md!P4"],
            analysis_evidence_ids: ["配置.md!P4"],
          },
        ],
        mappings: [
          {
            process_step_id: "step.approve",
            system_id: "sys.erp",
            implementation_kind: "CONFIGURATION",
            target_refs: ["ME29N"],
            confidence: 0.9,
            evidence_ids: ["配置.md!P4"],
            analysis_evidence_ids: ["配置.md!P4"],
          },
        ],
      },
      RULES: {
        rules: [
          {
            id: "br_lock",
            condition: "status == APPROVED",
            effect: "price immutable",
            exceptions: ["管理员撤回"],
            test_cases: [{ kind: "POSITIVE", given: {}, expected: true }],
            evidence_ids: ["制度.md!P3"],
            analysis_evidence_ids: ["制度.md!P3"],
          },
        ],
      },
      DATA_OBJECTS: {
        data_objects: [
          {
            id: "ot_order",
            classification: "TRANSACTION",
            lifecycle_states: ["DRAFT", "APPROVED"],
            sensitivity: "CONFIDENTIAL",
            system_of_record: "sys.erp",
            owner_role: "采购经理",
            evidence_ids: ["数据字典.xlsx!订单"],
            analysis_evidence_ids: ["数据字典.xlsx!订单"],
          },
        ],
        quality_rules: [
          {
            id: "dq.order.key",
            data_object_id: "ot_order",
            dimension: "COMPLETENESS",
            expression: "order_no != null",
            threshold: 1,
            evidence_ids: ["数据字典.xlsx!订单"],
            analysis_evidence_ids: ["数据字典.xlsx!订单"],
          },
        ],
      },
    }, allowedEvidence, evidenceRecords);
    const node = ((out["processes"] as Dict[])[0]!["nodes"] as Dict[])[0]!;
    const rule = (out["rules"] as Dict[])[0]!;
    const object = (out["dataObjects"] as Dict[])[0]!;
    expect((node["erpMappings"] as Dict[])[0]!["implementationKind"]).toBe("CONFIGURATION");
    expect(rule["normalizedExpression"]).toBe("status == APPROVED");
    expect(object["lifecycleStates"]).toEqual(["DRAFT", "APPROVED"]);
    expect(object["systemOfRecord"]).toBe("sys.erp");
    expect((object["qualityRules"] as Dict[])[0]!["id"]).toBe("dq.order.key");
    const packageEvidence = out["evidence"] as Dict[];
    const ids = new Set(packageEvidence.map((row) => row["id"]));
    const mappingEvidence = (node["erpMappings"] as Dict[])[0]!["evidenceIds"] as string[];
    const objectEvidence = object["analysisEvidenceIds"] as string[];
    const qualityEvidence = (object["qualityRules"] as Dict[])[0]!["evidenceIds"] as string[];
    for (const id of [...mappingEvidence, ...objectEvidence, ...qualityEvidence]) {
      expect(id).toMatch(/^ev\./);
      expect(ids.has(id)).toBe(true);
      const evidence = packageEvidence.find((row) => row["id"] === id)!;
      expect(Object.values(snippets)).toContain(evidence["snippet"]);
      expect(evidence["locator"]).toMatchObject({ kind: "page" });
    }
  });

  it("发布门禁会拒绝真实引用给无关材料事实背书", async () => {
    const cite = "流程.md!P2";
    const records = [{
      cite,
      file_id: "f1",
      file_name: "流程.md",
      locator: { kind: "page", page: 2 },
      snippet: "采购申请由申请人提交。",
    }];
    const pkg: Dict = {
      evidence: [{
        id: "ev.real",
        cite,
        fileId: "f1",
        fileName: "流程.md",
        locator: { kind: "page", page: 2 },
        snippet: "采购申请由申请人提交。",
      }],
      actions: [{
        id: "act.fake",
        name: "董事长批准火星订单",
        assertion: { origin: "EXTRACTED", confidence: 0.99, evidenceIds: ["ev.real"] },
      }],
    };
    const report = materialGroundingReport(pkg, records);
    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "MATERIAL_EVIDENCE_NOT_SUPPORTING_CLAIM" }),
    ]);

    const rt = new EngagementRuntimeInput({
      sessionId: "release-grounding",
      project: "p",
      oir: {},
      backlog: new QuestionBacklog(),
      evidenceRecords: records,
    });
    const review = new ReviewHandler(rt).project({
      CANONICALIZE: pkg,
      DECISION_APPLY: {
        safe_to_continue: true,
        mutation_count: 0,
        claimed_applied_count: 0,
      },
      TEST_PLAN: { coverage_gaps: [] },
    });
    expect(review["verdict"]).toBe("BLOCKED");
    expect(review["blockers"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MATERIAL_GROUNDING_FAILED" }),
    ]));

    const exported = await new ExportHandler(rt).execute({
      CANONICALIZE: pkg,
      REVIEW: { verdict: "PASS", schema_valid: true, warnings: [], artifact_checks: [] },
      HUMAN_ACCEPTANCE: {
        signed: true,
        decision: "APPROVE",
        package_bound: true,
        review_passed: true,
        releaseState: "RELEASED",
      },
    }, {} as RunContext);
    expect(exported["grounding_passed"]).toBe(false);
    expect(exported["review_passed"]).toBe(false);
    expect(exported["releaseState"]).toBe("DRAFT");
  });

  it("发布门禁接受能反查到真实原文且主张一致的材料事实", () => {
    const pkg: Dict = {
      evidence: [{ id: "ev.real", cite: "流程.md!P2", snippet: "采购申请由申请人提交。" }],
      actions: [{
        id: "act.submit",
        name: "提交采购申请",
        assertion: { origin: "EXTRACTED", confidence: 0.9, evidenceIds: ["ev.real"] },
      }],
    };
    expect(materialGroundingReport(pkg, [{
      cite: "流程.md!P2",
      text: "采购申请由申请人提交。",
    }])).toMatchObject({ enforced: true, passed: true, checked: 1, issues: [] });
  });

  it("客户材料已上传但零切片时，发布门禁拒绝对着文件名生成结论", () => {
    const report = materialGroundingReport({ evidence: [], actions: [] }, [], true);
    expect(report).toMatchObject({
      enforced: true,
      passed: false,
      checked: 0,
      issues: [expect.objectContaining({
        code: "MATERIAL_EVIDENCE_MISSING",
        claim: "已上传材料，但没有读到可核验的原文切片",
      })],
    });

    const rt = new EngagementRuntimeInput({
      sessionId: "unparsed-material",
      project: "p",
      oir: {},
      backlog: new QuestionBacklog(),
      corpus: { files: [{ file: "扫描件.pdf" }], chunks: 0 },
    });
    expect(rt.materialEvidenceRequired).toBe(true);
    const review = new ReviewHandler(rt).project({
      CANONICALIZE: { evidence: [] },
      DECISION_APPLY: {
        safe_to_continue: true,
        mutation_count: 0,
        claimed_applied_count: 0,
      },
      TEST_PLAN: { coverage_gaps: [] },
    });
    expect(review["blockers"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MATERIAL_GROUNDING_FAILED" }),
    ]));
  });
});
