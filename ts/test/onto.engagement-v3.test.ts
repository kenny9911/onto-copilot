/** FDE v3 fixed workflow: decision validation, delivery chain and formal acceptance. */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { AgentBus } from "../src/kernel/bus/bus.js";
import { CriticPanel } from "../src/kernel/critic.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { defaultAgents } from "../src/kernel/agents.js";
import { ModelGateway, ScriptedBackend, stubRouting } from "../src/kernel/llm.js";
import { AgentLoop, type RunContext } from "../src/kernel/loop.js";
import { ContextManager } from "../src/kernel/memory/context.js";
import { Scratchpad } from "../src/kernel/memory/short_term.js";
import { Recorder } from "../src/kernel/recorder.js";
import { RunStatus, Scheduler } from "../src/kernel/scheduler.js";
import {
  FDE_CHECKPOINT_VERSION,
  buildFdeEngagementDag,
} from "../src/onto/engagement.js";
import {
  DecisionApplicationHandler,
  EngagementRuntimeInput,
  HumanAcceptanceHandler,
  engagementCritics,
  engagementHandlers,
} from "../src/onto/engagement_runtime.js";
import { QuestionBacklog, validateAnswerAgainst } from "../src/onto/questions.js";

type Dict = Record<string, unknown>;

function runtime(decisions: unknown[] = []): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "v3-test",
    project: "采购到付款",
    oir: {
      objects: [
        {
          rid: "ot_order",
          displayName: { value: "采购订单", evidence: [] },
          apiName: { value: "PurchaseOrder", evidence: [] },
          primaryKey: { value: [], evidence: [] },
        },
      ],
      rules: [
        {
          rid: "br_lock_price",
          statement: {
            value: "采购订单审批后不得修改价格",
            evidence: [{ cite: "制度.md!P3" }],
          },
          ruleKind: { value: "VALIDATION", evidence: [] },
          appliesTo: ["ot_order"],
        },
      ],
    },
    flow: {
      nodes: [
        {
          rid: "step.approve",
          label: { value: "审批采购订单", evidence: [{ cite: "流程.md!P2" }] },
          actor: { value: "采购经理", evidence: [{ cite: "流程.md!P2" }] },
          objects: ["ot_order"],
          endpoint: "https://erp.example/api/orders/approve",
        },
      ],
      edges: [],
    },
    backlog: new QuestionBacklog(),
    decisions,
    generatedAt: "2026-08-26T00:00:00+00:00",
  });
}

function scheduler(
  rt: EngagementRuntimeInput,
  opts: { journal?: InMemoryJournal; blobs?: InMemoryBlobStore; resume?: boolean } = {},
) {
  const journal = opts.journal ?? new InMemoryJournal();
  const blobs = opts.blobs ?? new InMemoryBlobStore();
  const recorder = new Recorder("fde-v3", journal, blobs, { resume: opts.resume ?? false });
  const budget = new Budget({ tokens: 1_000_000, usd: 10 });
  const backend = new ScriptedBackend();
  const gateway = new ModelGateway(backend, recorder, { routing: stubRouting(), budget });
  const bus = new AgentBus(recorder);
  const loop = new AgentLoop({
    gateway,
    ctxManager: new ContextManager({ system: "FDE v3 test", budgetTokens: 64_000 }),
    panel: new CriticPanel(engagementCritics(), recorder),
    bus,
    recorder,
    budget,
    handlers: engagementHandlers(rt),
    newScratchpad: (tokens) => new Scratchpad({ budgetTokens: tokens }),
  });
  return {
    journal,
    blobs,
    backend,
    scheduler: new Scheduler(buildFdeEngagementDag(), loop, recorder, bus, budget, {
      concurrency: 4,
    }),
  };
}

describe("FDE engagement v3 frozen topology", () => {
  it("keeps the delivery chain ordered and requires formal sign-off before export", () => {
    const dag = buildFdeEngagementDag();
    expect(dag.name).toBe("fde_engagement_v3");
    expect(FDE_CHECKPOINT_VERSION).toBe("fde-engagement-v3");
    const order = dag.topoOrder();
    const chain = [
      "INTERVIEW",
      "DECISION_PROPOSAL",
      "DECISION_APPLY",
      "REQUIREMENTS",
      "ARCHITECTURE",
      "TEST_PLAN",
      "CANONICALIZE",
      "REVIEW",
      "HUMAN_ACCEPTANCE",
      "EXPORT",
    ];
    expect(chain.map((node) => order.indexOf(node))).toEqual(
      [...chain].map((_, index) => order.indexOf(chain[index]!)).sort((a, b) => a - b),
    );
    expect(dag.get("HUMAN_ACCEPTANCE").mode).toBe("hitl");
    expect(dag.get("EXPORT").deps).toContain("HUMAN_ACCEPTANCE");
    expect(dag.get("EXPORT").gate?.require).toContain("human_decided == true");
  });

  it("PROCESS 开了受限 Cohort 试点（cohort_max=2），审批/确定性节点绝不开", () => {
    const dag = buildFdeEngagementDag();
    expect(dag.get("PROCESS").mode).toBe("plan_execute");
    expect(dag.get("PROCESS").params["cohort_max"]).toBe(2);
    // 红线：GAP / DECISION_APPLY / CANONICALIZE / EXPORT 及 HITL 节点永远不进 cohort
    for (const id of [
      "GAP", "DECISION_APPLY", "CANONICALIZE", "EXPORT", "INTERVIEW", "HUMAN_ACCEPTANCE",
    ]) {
      expect(dag.get(id).params["cohort_max"], id).toBeUndefined();
    }
  });
});

describe("DECISION_APPLY is validation-only", () => {
  it("accepts an explicitly authorised target but still performs zero mutations", async () => {
    const decisions = [
      {
        id: "d.rename",
        questionId: "q.rename",
        answer: "采购订单",
        affectedIds: ["ot_order"],
      },
    ];
    const out = await new DecisionApplicationHandler(runtime(decisions)).execute(
      {
        DECISION_PROPOSAL: {
          base_revision: 0,
          patch_proposals: [
            {
              id: "patch.rename",
              decision_id: "d.rename",
              operation: "SET",
              target: {
                entity_type: "ObjectType",
                entity_id: "ot_order",
                field: "displayName",
              },
              proposed_value: "采购订单",
              status: "PROPOSED",
            },
          ],
        },
      },
      {} as RunContext,
    );
    expect(out).toMatchObject({
      safe_to_continue: true,
      validated_count: 1,
      rejected_count: 0,
      mutation_count: 0,
      claimed_applied_count: 0,
      applied: false,
    });
    expect(out["applied_changes"]).toEqual([]);
    expect((out["validated_patches"] as Dict[])[0]?.["status"]).toBe(
      "VALIDATED_NOT_APPLIED",
    );
  });

  it("rejects targetless patches and any agent-authored APPLIED claim", async () => {
    const decisions = [{ id: "d1", questionId: "q1", answer: "x", affectedIds: [] }];
    const out = await new DecisionApplicationHandler(runtime(decisions)).execute(
      {
        DECISION_PROPOSAL: {
          base_revision: 0,
          patch_proposals: [
            { id: "p1", decision_id: "d1", status: "APPLIED", applied: true },
          ],
        },
      },
      {} as RunContext,
    );
    expect(out).toMatchObject({
      safe_to_continue: false,
      validated_count: 0,
      rejected_count: 1,
      untargeted_write_count: 1,
      claimed_applied_count: 1,
      mutation_count: 0,
      applied: false,
    });
  });
});

describe("HUMAN_ACCEPTANCE durable sign-off", () => {
  it("fails closed for direct finalize input; only an exact durable ledger row can sign", () => {
    const handler = new HumanAcceptanceHandler(runtime());
    const inputs = {
      CANONICALIZE: { packageId: "pkg.v3-test", revision: 1, objects: [] },
      REVIEW: { verdict: "PASS", blocker_count: 0, schema_valid: true, artifact_checks: [] },
    };
    expect(handler.skipModel(inputs)).toBeNull();
    const request = handler.humanRequest({}, inputs);
    expect((request["question"] as Dict)["answerSchema"]).toEqual({
      type: "string",
      enum: ["APPROVE", "REJECT"],
    });
    const binding = request["binding"] as Dict;
    expect(binding["package_digest"]).toEqual(expect.any(String));
    const accepted = handler.finalize(
      {
        decision: "APPROVE",
        actor: "Alice",
        actor_role: "admin",
        authority: "admin",
        signed_at: "2026-08-26T01:00:00+00:00",
      },
      inputs,
    ) as Dict;
    expect(accepted).toMatchObject({
      signed: false,
      decision: "APPROVE",
      package_bound: false,
      review_passed: true,
      decision_recorded: false,
      releaseState: "DRAFT",
    });
    const stale = handler.finalize(
      { ...accepted, question_id: "q.acceptance.stale", package_digest: "stale" },
      inputs,
    ) as Dict;
    expect(stale["package_bound"]).toBe(false);
    expect(stale["releaseState"]).toBe("DRAFT");
    const rejected = handler.finalize(
      {
        decision: "REJECT",
        actor: "Alice",
        actor_role: "admin",
        authority: "admin",
        signed_at: "2026-08-26T01:10:00+00:00",
      },
      inputs,
    ) as Dict;
    expect(rejected).toMatchObject({
      decision: "REJECT",
      signed: false,
      decision_recorded: false,
      package_bound: false,
      releaseState: "DRAFT",
    });
  });

  it("does not recognise a ledger signature without an allowed authority", () => {
    const inputs = {
      CANONICALIZE: { packageId: "pkg.v3-test", revision: 1, objects: [] },
      REVIEW: { verdict: "PASS", blocker_count: 0, schema_valid: true, artifact_checks: [] },
    };
    const request = new HumanAcceptanceHandler(runtime()).humanRequest({}, inputs);
    const questionId = String((request["question"] as Dict)["id"]);
    const handler = new HumanAcceptanceHandler(runtime([{
      id: "d.acceptance.forged",
      questionId,
      answer: "APPROVE",
      actor: "ordinary-user",
      actorRole: "admin",
      authority: "",
      createdAt: 1_777_000_000,
    }]));
    expect(handler.skipModel(inputs)).toMatchObject({
      signed: false,
      decision_recorded: false,
      releaseState: "DRAFT",
    });
  });

  it("suspends without signature, then resumes from a DecisionLedger sign-off", async () => {
    const decisions: unknown[] = [
      {
        id: "d.business.rename",
        questionId: "",
        answer: "采购订单",
        actor: "Bob",
        actorRole: "流程负责人",
        affectedIds: ["ot_order"],
        metadata: {
          target: {
            entity_type: "OBJECT",
            entity_id: "ot_order",
            field: "displayName",
          },
          evidence_ids: ["制度.md!P3"],
        },
        createdAt: 1_776_000_000,
      },
    ];
    const first = scheduler(runtime(decisions));
    const suspended = await first.scheduler.run("fde-v3");
    expect(suspended.status, suspended.error ?? "unexpected terminal state").toBe(
      RunStatus.SUSPENDED,
    );
    expect(suspended.pendingHuman?.["node"]).toBe("HUMAN_ACCEPTANCE");
    expect(Object.keys(suspended.outputs)).not.toContain("EXPORT");
    expect(first.backend.calls).toEqual([]);
    for (const [node, agent] of [
      ["DECISION_PROPOSAL", "decision_integrator"],
      ["REQUIREMENTS", "requirements_engineer"],
      ["ARCHITECTURE", "solution_architect"],
      ["TEST_PLAN", "acceptance_test_engineer"],
    ] as const) {
      expect(() =>
        validateAnswerAgainst(
          suspended.outputs[node],
          defaultAgents().get(agent).outputSchema!,
          `$${node}`,
        ),
      ).not.toThrow();
    }

    const request = suspended.pendingHuman as Dict;
    const question = request["question"] as Dict;
    decisions.push({
      id: "d.acceptance.1",
      questionId: question["id"],
      answer: "APPROVE",
      actor: "admin-1",
      actorRole: "admin",
      authority: "admin",
      createdAt: 1_777_000_000,
    });

    const resumed = scheduler(runtime(decisions), {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const completed = await resumed.scheduler.run("fde-v3");
    expect(completed.status).toBe(RunStatus.COMPLETED);
    expect((completed.outputs["HUMAN_ACCEPTANCE"] as Dict)).toMatchObject({
      signed: true,
      package_bound: true,
      decision: "APPROVE",
      releaseState: "RELEASED",
    });
    expect((completed.outputs["EXPORT"] as Dict)).toMatchObject({
      human_accepted: true,
      releaseState: "RELEASED",
    });
    expect(resumed.backend.calls).toEqual([]);
  });

  it("records REJECT as a completed DRAFT decision instead of returning a system failure", async () => {
    const decisions: unknown[] = [];
    const first = scheduler(runtime(decisions));
    const suspended = await first.scheduler.run("fde-v3");
    expect(suspended.status).toBe(RunStatus.SUSPENDED);
    const question = (suspended.pendingHuman?.["question"] ?? {}) as Dict;
    decisions.push({
      id: "d.acceptance.reject",
      questionId: question["id"],
      answer: "REJECT",
      actor: "admin-1",
      actorRole: "admin",
      authority: "admin",
      rationale: "验收范围尚需调整",
      createdAt: 1_777_000_001,
    });
    const resumed = scheduler(runtime(decisions), {
      journal: first.journal,
      blobs: first.blobs,
      resume: true,
    });
    const outcome = await resumed.scheduler.run("fde-v3");
    expect(outcome.status).toBe(RunStatus.COMPLETED);
    expect(outcome.outputs["HUMAN_ACCEPTANCE"]).toMatchObject({
      decision: "REJECT",
      decision_recorded: true,
      releaseState: "DRAFT",
    });
    expect(outcome.outputs["EXPORT"]).toMatchObject({
      human_decided: true,
      human_accepted: false,
      releaseState: "DRAFT",
    });
  });
});
