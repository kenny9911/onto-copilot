import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Danger, ToolRegistry } from "../src/kernel/tools.js";
import { Question, QuestionBacklog, QuestionPriority } from "../src/onto/questions.js";
import { AsyncLock } from "../src/server/pipeline/types.js";
import { converseTools } from "../src/server/dialogue/tools.js";
import type { DialogueDeps, SessionLike } from "../src/server/dialogue/ports.js";
import type { Repo } from "../src/store/repo/protocol.js";
import type { SessionEvent } from "../src/session_events.js";

function makeSession(state: Record<string, unknown> = {}): SessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-fde-tools-"));
  const s = {
    id: "s-fde",
    title: "FDE",
    project: "采购项目",
    projectId: "p1",
    created: 1_700_000_000,
    files: [],
    status: "done",
    error: "",
    dir,
    events: [],
    state,
    stateVersion: 1,
    owner: "",
    buildLeaseOwner: "",
    mutationLeaseOwner: "",
    buildLock: new AsyncLock(),
    chatTask: null,
    runTask: null,
    lang: "zh",
    emit(kind: string, payload: Record<string, unknown> = {}) {
      const event = { kind, ...payload } as unknown as SessionEvent;
      this.events.push(event);
      return event;
    },
    async emitDurable(kind: string, payload: Record<string, unknown> = {}) {
      return this.emit(kind, payload);
    },
  } satisfies SessionLike;
  return s;
}

function fakeRepo(over: Partial<Repo> = {}): Repo {
  return new Proxy({
    mode: "memory",
    listDecisionsV1: async () => [],
    listRevisions: async () => [],
    ...over,
  } as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      return () => { throw new Error(`unexpected repo call: ${key}`); };
    },
  }) as unknown as Repo;
}

function makeDeps(backlog = new QuestionBacklog(), repo = fakeRepo()): DialogueDeps {
  const base: Partial<DialogueDeps> = {
    builtinRegistry: () => new ToolRegistry(),
    questionBacklog: () => backlog,
    getRepo: () => repo,
    exportApi: {
      FORMATS: ["xlsx", "docx", "md", "csv"],
      availableFormats: () => ["xlsx", "docx", "md", "csv"],
      resolveFormat: (format: string) => format,
      imageFormats: () => ["xlsx", "docx", "md"],
      supportsImages: () => true,
      render: async () => [new Uint8Array(), { ext: ".md", label: "MD" }],
      safeName: (title: string, ext: string) => title + ext,
    },
  };
  return new Proxy(base as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      throw new Error(`unexpected dialogue dependency: ${key}`);
    },
  }) as unknown as DialogueDeps;
}

async function call(
  s: SessionLike,
  deps: DialogueDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await converseTools(s, deps).call(name, args, { approved: true, pending: [] }, {
    scope: "converse",
  }) as Record<string, unknown>;
}

function engagementState(): Record<string, unknown> {
  return {
    artifact_revision: 7,
    release_state: "DRAFT",
    artifacts: ["ontology.package.json", "questions.json"],
    ontology_package: { revision: 7, validation: { passed: true } },
    engagement_analysis: {
      nodes: {
        INTAKE: {
          engagement: {
            in_scope: ["采购申请到订单"],
            out_of_scope: ["供应商寻源"],
            acceptance_criteria: ["审批规则有边界用例"],
          },
          findings: [{ statement: "采购订单由 ERP 管理", epistemic_status: "FACT", evidence_ids: ["EVID[f!p1]"] }],
        },
        PROCESS: {
          steps: [
            { id: "step.create_po", name: "创建采购订单", evidence_ids: ["EVID[f!p2]"] },
            { id: "step.unmapped", name: "线下复核", evidence_ids: ["EVID[f!p3]"] },
          ],
        },
        ERP_MAP: {
          landscape: [
            { system_id: "sys.erp", product: "S/4HANA", version: null, module: "MM", org_scope: "CN", evidence_ids: ["EVID[f!p4]"] },
          ],
          mappings: [
            { process_step_id: "step.create_po", system_id: "sys.erp", implementation_kind: "CONFIGURATION", target_refs: ["ME21N"], confidence: 0.9, evidence_ids: ["EVID[f!p4]"] },
          ],
        },
        RULES: {
          rules: [
            {
              id: "rule.approval",
              kind: "AUTHORITY",
              trigger_event_id: null,
              applies_to_ids: ["obj.po"],
              condition: "amount > 10000",
              effect: "需要总监审批",
              exceptions: [],
              evidence_ids: ["EVID[f!p5]"],
              test_cases: [
                { kind: "POSITIVE", given: [{ field: "amount", value: 10001 }], expected: "总监审批" },
                { kind: "BOUNDARY", given: [{ field: "amount", value: 10000 }], expected: "无需总监审批" },
              ],
            },
            {
              id: "rule.uncovered",
              kind: "VALIDATION",
              trigger_event_id: null,
              applies_to_ids: ["obj.po"],
              condition: "supplier_id != null",
              effect: "允许提交",
              exceptions: [],
              evidence_ids: [],
              test_cases: [],
            },
          ],
        },
        DATA_OBJECTS: {
          data_objects: [
            { id: "obj.po", name: "采购订单", system_of_record: "sys.erp", owner_role: "采购专员", sensitivity: "INTERNAL", evidence_ids: ["EVID[f!p6]"] },
          ],
          quality_rules: [
            { id: "dq.po_supplier", data_object_id: "obj.po", dimension: "COMPLETENESS", expression: "supplier_id 非空", threshold: 1, evidence_ids: ["EVID[f!p7]"] },
          ],
        },
        REVIEW: {
          verdict: "PASS",
          schema_valid: true,
          blockers: [],
          warnings: ["1 个非阻塞问题尚待澄清"],
          artifact_checks: [{ artifact_id: "ontology.package.json", schema_valid: true, downloadable: true }],
        },
      },
    },
  };
}

function expandedEngagementState(): Record<string, unknown> {
  const state = engagementState();
  const nodes = ((state["engagement_analysis"] as Record<string, unknown>)["nodes"] as Record<string, unknown>);
  Object.assign(nodes, {
    DECISION_PROPOSAL: {
      base_revision: 7,
      decision_assessments: [{
        decision_id: "dec.new", state: "APPLICABLE", summary: "确认订单 Owner",
        target_ids: ["obj.po"], supersedes_decision_ids: [], evidence_ids: ["EVID[f!p8]"],
        rationale: "决定有稳定 target",
      }],
      patch_proposals: [{
        id: "patch.new", decision_id: "dec.new", operation: "REPLACE", target_kind: "DATA_OBJECT",
        target_id: "obj.po", field_path: "owner_role", before_summary: "采购专员",
        after_summary: "采购经理", preconditions: ["base revision 7"], affected_ids: ["obj.po"],
        risk: "MEDIUM", evidence_ids: ["EVID[f!p8]"],
      }],
      unresolved_items: [],
    },
    DECISION_APPLY: {
      contract: "DecisionApplicationValidation.v1", status: "VALIDATED_NOT_APPLIED",
      safe_to_continue: true, validated_patches: [{ id: "patch.new", decision_id: "dec.new" }],
      rejected_patches: [], mutation_count: 0, applied_changes: [], applied: false,
    },
    REQUIREMENTS: {
      requirements: [{
        id: "req.new", title: "订单审批", type: "CONTROL", statement: "订单必须按金额分级审批",
        confirmation_status: "CANDIDATE", priority: "MUST", owner_role: "采购经理",
        stakeholder_roles: ["财务经理"], acceptance_criteria: ["10001 元触发总监审批"],
        depends_on_ids: [], related_artifact_ids: ["rule.approval"], evidence_ids: ["EVID[f!p5]"],
      }],
      coverage_assessments: [{
        requirement_id: "req.new", status: "FIT", capability_ids: ["sys.erp"],
        rationale: "ERP 配置支持", downstream_impact: "需配置审批策略", evidence_ids: ["EVID[f!p5]"],
      }],
      questions: [],
    },
    ARCHITECTURE: {
      components: [{
        id: "cmp.approval", name: "审批服务", kind: "SERVICE", status: "PROPOSED",
        responsibility: "执行采购审批策略", system_id: "sys.erp", requirement_ids: ["req.new"],
        evidence_ids: ["EVID[f!p4]"],
      }],
      fit_gap_dispositions: [{
        id: "fit.req.new", requirement_id: "req.new", fit: "PARTIAL_FIT",
        proposed_disposition: "CONFIGURE", component_ids: ["cmp.approval"], rationale: "需配置阈值",
        constraints: [], impact_summary: "配置审批策略", evidence_ids: ["EVID[f!p4]"],
      }],
      integration_contracts: [], risks: [], questions: [],
    },
    TEST_PLAN: {
      test_cases: [{
        id: "uat.req.new", title: "分级审批", kind: "BUSINESS_RULE", priority: "BLOCKING",
        status: "READY_FOR_REVIEW", requirement_ids: ["req.new"], rule_ids: ["rule.approval"],
        process_step_ids: ["step.create_po"], integration_contract_ids: [], preconditions: ["审批策略已配置"],
        given: [{ field: "amount", value: 10001 }], when: "提交订单", then: ["进入总监审批"],
        test_data_requirements: ["测试订单"], evidence_ids: ["EVID[f!p5]"], automation_candidate: true,
      }],
      traceability: [{
        requirement_id: "req.new", test_case_ids: ["uat.req.new"], coverage: "COVERED",
        evidence_ids: ["EVID[f!p5]"],
      }],
      coverage_gaps: [],
      readiness: { recommendation: "READY_FOR_HUMAN_REVIEW", blocking_gap_ids: [], rationale: ["追溯完整"] },
    },
  });
  return state;
}

describe("FDE read tools", () => {
  it("8 个工具全部是 READ，且 chat/converse 都只能得到只读处理器", () => {
    const reg = converseTools(makeSession(), makeDeps());
    for (const name of [
      "decision.patch.preview", "decision.patch.query", "requirements.query", "requirements.trace",
      "architecture.query", "acceptance.test.query", "acceptance.coverage", "signoff.package",
    ]) {
      expect(reg.get(name, "chat").spec.danger, name).toBe(Danger.READ);
      expect(reg.get(name, "converse").spec.danger, name).toBe(Danger.READ);
    }
  });

  it("问题表只显示人话，稳定 ID 留在技术字段供回答和审计", async () => {
    const question = new Question({
      id: "q.agent.714851a0",
      text: "[高][ERP顾问][blocked:sys_metaerp] 请确认 MetaERP 的具体版本" +
        " | answer:TEXT | evidence:材料.docx#p1",
      sourceKind: "agent_analysis",
      priority: QuestionPriority.HIGH,
      audienceRole: "ERP顾问",
      why: "由 ERP_MAP 独立分析发现，需由相应业务角色确认",
    });
    const backlog = new QuestionBacklog(new Map([[question.id, question]]));
    const s = makeSession({ question_backlog: backlog.toDict() });
    const out = await call(s, makeDeps(backlog), "ui.table", {
      kind: "questions",
      title: "阻碍系统自动抽取的关键待澄清问题（部分展示）",
    });
    const table = (s.events as unknown as Record<string, unknown>[]).find(
      (event) => event["kind"] === "ui.table",
    )!;
    expect(table["title"]).toBe("需要优先确认的问题（部分展示）");
    expect(table["columns"]).toEqual([
      "序号", "需要确认的问题", "状态", "重要程度", "请谁回答", "为什么要问",
    ]);
    expect(table["rows"]).toEqual([[
      "1", "请确认 MetaERP 的具体版本", "待回答", "优先确认", "ERP顾问",
      "材料里的系统信息没有说明清楚，需要请ERP顾问确认。",
    ]]);
    expect(table["question_ids"]).toEqual([question.id]);
    expect(out["questionIds"]).toEqual([question.id]);
    expect(JSON.stringify(table["rows"])).not.toMatch(/q\.agent|blocked:|answer:|evidence:|ERP_MAP|open|high/u);
  });

  it("decision.patch.preview 只预览 conflict effect，绝不修改会话或落 Decision", async () => {
    const question = new Question({
      id: "q.merge",
      text: "两个供应商对象是否合并？",
      sourceKind: "conflict",
      sourceRef: "cf.merge",
      priority: QuestionPriority.BLOCKING,
    });
    const backlog = new QuestionBacklog(new Map([[question.id, question]]));
    const state = {
      artifact_revision: 3,
      _conflicts: [{
        rid: "cf.merge",
        subjects: ["obj.a", "obj.b"],
        options: [{
          id: "merge_a",
          label: "合并到 A",
          rationale: "A 是主数据",
          evidence: [{ cite: "EVID[f!p1]" }],
          effect: { unify_to: "obj.a" },
        }],
      }],
    };
    const before = JSON.stringify(state);
    const out = await call(makeSession(state), makeDeps(backlog), "decision.patch.preview", {
      question_id: "q.merge",
      option_id: "merge_a",
    });
    expect(out["effect_status"]).toBe("DETERMINISTIC_EFFECT_FOUND");
    expect(out["affected_ids"]).toEqual(["obj.b"]);
    expect(out["auto_applied"]).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("decision.patch.preview 没有确定性 target 时明确是 record-only，而非编造字段 patch", async () => {
    const q = new Question({ id: "q.owner", text: "数据 Owner 是谁？", sourceKind: "agent_analysis" });
    const out = await call(
      makeSession(),
      makeDeps(new QuestionBacklog(new Map([[q.id, q]]))),
      "decision.patch.preview",
      { question_id: q.id, answer: "采购经理" },
    );
    expect(out["effect_status"]).toBe("NO_DETERMINISTIC_FIELD_PATCH");
    expect(out["patch_ops"]).toEqual([]);
    expect(String(out["apply_guard"])).toContain("question.answer");
  });

  it("decision.patch.query 连接耐久 Decision 与 Revision，但不重放 patch", async () => {
    const repo = fakeRepo({
      listDecisionsV1: async () => [{
        id: "dec_1", question_id: "q1", answer: "merge_a", actor: "fde", actor_role: "顾问",
        authority: "customer", source_turn: "t1", affected_ids: ["obj.b"], supersedes: null,
        revision: 4, idempotency_key: "k1", semantic_hash: "h1", rationale: "客户确认",
        metadata: { status: "applied" }, created: 10,
      }],
      listRevisions: async () => [{
        id: "rev_4", ordinal: 4, parent_id: "rev_3", kind: "question_answer", status: "applied",
        doc: {}, patch_set: { id: "patch.dec_1", ops: [], affectedIds: ["obj.b"] },
        changed_ids: ["obj.b"], invalidated_artifacts: ["ontology.package.json"], actor: "fde",
        source_turn: "t1", snapshot_hash: "blob:abc", idempotency_key: "k1", created: 11,
      }],
    });
    const out = await call(makeSession(), makeDeps(new QuestionBacklog(), repo), "decision.patch.query");
    const items = out["items"] as Record<string, unknown>[];
    expect(items[0]!["status"]).toBe("applied");
    expect((items[0]!["revision"] as Record<string, unknown>)["ordinal"]).toBe(4);
    expect(out["auto_applied"]).toBe(false);
  });

  it("requirements.query 与 trace 保留精确 ref、证据和显式对象链接", async () => {
    const s = makeSession(engagementState());
    const query = await call(s, makeDeps(), "requirements.query", { kind: "business_rule" });
    const item = (query["items"] as Record<string, unknown>[])[0]!;
    expect(item["ref"]).toBe("rule.approval");
    expect(item["evidence_ids"]).toEqual(["EVID[f!p5]"]);

    const trace = await call(s, makeDeps(), "requirements.trace", { requirement_ref: "rule.approval" });
    expect(trace["outgoing_refs"]).toContain("obj.po");
    expect(trace["resolved_targets"]).toContainEqual({
      ref: "obj.po", node: "DATA_OBJECTS", collection: "data_objects",
    });
    expect(trace["trace_status"]).toBe("TRACED");
  });

  it("没有 Engagement 产物时 requirements.query 返回 NOT_AVAILABLE，不把空说成已覆盖", async () => {
    const out = await call(makeSession(), makeDeps(), "requirements.query");
    expect(out["status"]).toBe("NOT_AVAILABLE");
    expect(String(out["note"])).toContain("不表示");
  });

  it("architecture.query 保留 UNKNOWN，并列出未映射流程步骤", async () => {
    const out = await call(makeSession(engagementState()), makeDeps(), "architecture.query");
    expect((out["systems"] as Record<string, unknown>[])[0]!["version"]).toBeNull();
    expect(out["explicit_unknowns"]).toContainEqual({ kind: "system_detail", ref: "sys.erp" });
    expect(out["explicit_unknowns"]).toContainEqual({ kind: "unmapped_process_step", ref: "step.unmapped" });
    expect(String(out["boundary"])).toContain("不是目标架构建议");
  });

  it("acceptance.test.query 只回测试设计，并明确 NOT_EXECUTED", async () => {
    const out = await call(makeSession(engagementState()), makeDeps(), "acceptance.test.query", {
      rule_id: "rule.approval",
      kind: "BOUNDARY",
    });
    const tests = out["tests"] as Record<string, unknown>[];
    expect(tests).toHaveLength(1);
    expect(tests[0]!["test_ref"]).toBe("rule.approval#test[1]");
    expect(tests[0]!["execution_status"]).toBe("NOT_EXECUTED");
  });

  it("acceptance.coverage 区分规则设计覆盖与验收标准测试链接", async () => {
    const out = await call(makeSession(engagementState()), makeDeps(), "acceptance.coverage");
    const design = out["rule_test_design_coverage"] as Record<string, unknown>;
    const criteria = out["acceptance_criteria"] as Record<string, unknown>;
    expect(design["coverage_pct"]).toBe(50);
    expect(design["rules_without_tests"]).toEqual(["rule.uncovered"]);
    expect(criteria["linkage_status"]).toBe("NOT_MODELED");
    expect(String(out["boundary"])).toContain("不表示测试已执行");
  });

  it("signoff.package 最多给 READY_FOR_HUMAN_REVIEW，永不声称已签署", async () => {
    const repo = fakeRepo({ listDecisionsV1: async () => [] });
    const out = await call(makeSession(engagementState()), makeDeps(new QuestionBacklog(), repo), "signoff.package");
    const signoff = out["human_signoff"] as Record<string, unknown>;
    expect(out["readiness"]).toBe("READY_FOR_HUMAN_REVIEW");
    expect(signoff["status"]).toBe("NOT_RECORDED");
    expect(signoff["reviewer"]).toBeNull();
    expect(String(out["boundary"])).toContain("不表示已签署");
  });

  it("signoff.package 缺 Review/schema/revision 时 fail closed 为 INCOMPLETE", async () => {
    const out = await call(makeSession(), makeDeps(), "signoff.package");
    expect(out["readiness"]).toBe("INCOMPLETE");
    expect((out["checks"] as Record<string, unknown>)["schema_validation"]).toBe("UNKNOWN");
  });

  it("新 DECISION_PROPOSAL/DECISION_APPLY 优先于旧 conflict preview，且保持零写入语义", async () => {
    const out = await call(makeSession(expandedEngagementState()), makeDeps(), "decision.patch.preview", {
      decision_id: "dec.new",
    });
    expect(out["contract"]).toBe("DecisionChangeProposal.v1");
    expect((out["patch_proposals"] as Record<string, unknown>[])[0]!["target_id"]).toBe("obj.po");
    const validation = out["application_validation"] as Record<string, unknown>;
    expect(validation["mutation_count"]).toBe(0);
    expect(validation["applied"]).toBe(false);
  });

  it("新 REQUIREMENTS 输出确认状态、验收标准并参与精确 trace", async () => {
    const s = makeSession(expandedEngagementState());
    const query = await call(s, makeDeps(), "requirements.query", { kind: "requirement" });
    const req = (query["items"] as Record<string, unknown>[])[0]!;
    expect(req["ref"]).toBe("req.new");
    expect(req["confirmation_status"]).toBe("CANDIDATE");
    expect(req["acceptance_criteria"]).toEqual(["10001 元触发总监审批"]);
    const trace = await call(s, makeDeps(), "requirements.trace", { requirement_ref: "req.new" });
    expect(trace["outgoing_refs"]).toContain("rule.approval");
  });

  it("新 ARCHITECTURE 输出优先，支持 requirement/component fit-gap 查询", async () => {
    const out = await call(makeSession(expandedEngagementState()), makeDeps(), "architecture.query", {
      requirement_id: "req.new",
      component_id: "cmp.approval",
    });
    expect(out["source_node"]).toBe("ARCHITECTURE");
    expect((out["components"] as Record<string, unknown>[])[0]!["status"]).toBe("PROPOSED");
    expect((out["fit_gap_dispositions"] as Record<string, unknown>[])[0]!["proposed_disposition"])
      .toBe("CONFIGURE");
  });

  it("新 TEST_PLAN 优先，READY_FOR_HUMAN_REVIEW 仍明确不是执行通过", async () => {
    const s = makeSession(expandedEngagementState());
    const query = await call(s, makeDeps(), "acceptance.test.query", { requirement_id: "req.new" });
    const test = (query["tests"] as Record<string, unknown>[])[0]!;
    expect(query["source_node"]).toBe("TEST_PLAN");
    expect(test["execution_status"]).toBe("NOT_EXECUTED");
    const coverage = await call(s, makeDeps(), "acceptance.coverage");
    expect(coverage["source_node"]).toBe("TEST_PLAN");
    expect((coverage["requirement_test_design_coverage"] as Record<string, unknown>)["coverage_pct"])
      .toBe(100);
    expect((coverage["test_case_design"] as Record<string, Record<string, number>>)["by_kind"]!["BUSINESS_RULE"])
      .toBe(1);
    expect(String(coverage["boundary"])).toContain("不表示测试已运行或通过");
  });

  it("signoff.package 只查询已存在且精确绑定的 HUMAN_ACCEPTANCE", async () => {
    const state = expandedEngagementState();
    const nodes = ((state["engagement_analysis"] as Record<string, unknown>)["nodes"] as Record<string, unknown>);
    nodes["HUMAN_ACCEPTANCE"] = {
      contract: "HumanAcceptance.v1", decision_id: "dec.accept", decision: "APPROVE", signed: true,
      actor: "张验收", actor_role: "业务验收负责人", signed_at: "2026-08-26T10:00:00Z",
      package_id: "pkg.s-fde", revision: 7, review_digest: "sha256-review",
      package_bound: true, review_passed: true, releaseState: "RELEASED",
    };
    const out = await call(makeSession(state), makeDeps(), "signoff.package");
    expect(out["readiness"]).toBe("HUMAN_ACCEPTED");
    const signoff = out["human_signoff"] as Record<string, unknown>;
    expect(signoff["status"]).toBe("RECORDED");
    expect(signoff["reviewer"]).toBe("张验收");
  });
});
