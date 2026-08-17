/**
 * Frozen FDE engagement workflow declaration.
 *
 * The executable handlers live in `engagement_runtime.ts`; keeping the declaration
 * separate preserves the stable control-plane contract.  Material *contents* are node
 * inputs and can never add tools or alter the topology.
 *
 * 移植说明：Python 的 `ScopeSpec(evidence_top_k=0, recall_long_term=False)` 里，
 * `recall_long_term` 全仓**只写不读**，`kernel/dag.ts` 已确认它是死开关、没有迁。
 * 这里同样不迁 —— 为了"看起来完整"把一个假字段加回去，等于凭空承诺了一个
 * 谁都没有实现的语义。
 */

import { type AgentLibrary, defaultAgents } from "../kernel/agents.js";
import {
  Dag,
  Difficulty,
  type GateSpec,
  NodeMode,
  type NodeSpec,
  makeGateSpec,
  makeNodeBudget,
  makeNodeSpec,
  makeScopeSpec,
} from "../kernel/dag.js";

export const FDE_ENGAGEMENT_AGENTS: readonly string[] = [
  "fde_interviewer",
  "process_modeler",
  "erp_mapper",
  "rule_engineer",
  "data_steward",
  "delivery_reviewer",
];

/** Translate an `AgentSpec` into the existing DAG node contract. */
function agentNode(
  nodeId: string,
  agentName: string,
  opts: {
    deps?: readonly string[];
    evidenceTopK?: number;
    gate?: GateSpec | null;
  } = {},
): NodeSpec {
  const agent = defaultAgents().get(agentName);
  return makeNodeSpec({
    id: nodeId,
    mode: agent.mode,
    handler: `agent.${agentName}`,
    deps: opts.deps ?? [],
    scope: makeScopeSpec({ evidenceTopK: opts.evidenceTopK ?? 32 }),
    budget: agent.budget,
    critics: agent.critics,
    criticRounds: agent.criticRounds,
    difficulty: agent.difficulty,
    gate: opts.gate ?? null,
    params: {
      agent: agentName,
      tool_scope: agent.toolScope,
      output_schema: agent.outputSchema,
    },
  });
}

/**
 * Build and freeze the front-line discovery-to-delivery workflow.
 *
 * The optional `agents` argument is a fail-fast compatibility check for deployments
 * that extend the default agent library.  Nodes still carry only serializable names and
 * schemas, so the declaration can be journalled or rendered without live agent objects.
 *
 * Topology:
 * ```
 *     INTAKE -> PROCESS -> ERP_MAP -----\
 *                       -> RULES --------> GAP -> INTERVIEW (HITL)
 *                       -> DATA_OBJECTS -/             |
 *                                          CANONICALIZE -> REVIEW -> EXPORT
 * ```
 *
 * `GAP` is the synchronization barrier.  `INTERVIEW` is always present even when the
 * current backlog is empty; its deterministic handler may immediately accept an empty
 * answer.  This keeps uploaded content from changing the plan after it is frozen.
 */
export function buildFdeEngagementDag(agents?: AgentLibrary | null): Dag {
  const library = agents ?? defaultAgents();
  // 只为 fail-fast：库里缺角色就当场 KeyError，而不是等跑到那个节点才发现。
  for (const name of FDE_ENGAGEMENT_AGENTS) library.get(name);

  const dag = new Dag("fde_engagement_v1", { freezeBefore: "INTAKE" });
  dag.extend([
    agentNode("INTAKE", "fde_interviewer", { evidenceTopK: 40 }),
    agentNode("PROCESS", "process_modeler", { deps: ["INTAKE"], evidenceTopK: 48 }),
    agentNode("ERP_MAP", "erp_mapper", { deps: ["PROCESS"], evidenceTopK: 40 }),
    agentNode("RULES", "rule_engineer", { deps: ["PROCESS"], evidenceTopK: 40 }),
    agentNode("DATA_OBJECTS", "data_steward", { deps: ["PROCESS"], evidenceTopK: 40 }),
    makeNodeSpec({
      id: "GAP",
      mode: NodeMode.DETERMINISTIC,
      handler: "engagement.collect_gaps",
      deps: ["PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS"],
      scope: makeScopeSpec({ evidenceTopK: 0 }),
      budget: makeNodeBudget({ tokens: 0, iterations: 1, wallclockS: 60, toolCalls: 0 }),
      params: {
        output_contract: "QuestionBacklog",
        rank_by: ["downstream_blocking", "blast_radius", "irreversibility", "evidence_gap"],
      },
      retries: 0,
    }),
    makeNodeSpec({
      id: "INTERVIEW",
      mode: NodeMode.HITL,
      handler: "engagement.interview",
      deps: ["GAP"],
      scope: makeScopeSpec({ evidenceTopK: 0 }),
      budget: makeNodeBudget({ tokens: 0, iterations: 1, wallclockS: 604_800, toolCalls: 0 }),
      difficulty: Difficulty.LOW,
      // **唯一的人类环节不能是唯一没有门的节点。**
      //
      // 在此之前 INTERVIEW 一条 require 都没有，而 REVIEW 带 4 条、EXPORT 带 3 条。
      // 门读的是节点自己的产出（scheduler.applyGate 把 result.output 的顶层键并进
      // metrics），所以这里断的是 InterviewHandler 的输出契约本身。
      //
      // 故意**不**用 `blocker_count == 0`：REVIEW 门要的就是它，而
      // `InterviewHandler.skipModel` 判的也是同一个 `blockers()` —— 拿它当
      // INTERVIEW 的门，等于让同一个判据自己给自己发通行证，两道门一起空过。
      //
      // 值不大但不是摆设：`requirementPasses` 遇到未知指标路径抛 NodeFailure
      // （scheduler.ts:1052），所以 handler 哪天返回一个缺字段的东西会当场失败，
      // 而不是让一个形状不对的 DecisionLedger 一路流到 CANONICALIZE。
      gate: makeGateSpec({
        kind: "auto",
        require: ["contract == 'DecisionLedger'", "resolved == true"],
      }),
      params: {
        input_contract: "QuestionBacklog",
        output_contract: "DecisionLedger",
        batching: "progressive",
      },
      retries: 0,
    }),
    makeNodeSpec({
      id: "CANONICALIZE",
      mode: NodeMode.DETERMINISTIC,
      handler: "engagement.canonicalize",
      deps: ["INTERVIEW"],
      scope: makeScopeSpec({ evidenceTopK: 0 }),
      budget: makeNodeBudget({ tokens: 0, iterations: 1, wallclockS: 120, toolCalls: 0 }),
      params: { output_contract: "OntologyPackage.v1" },
      retries: 0,
    }),
    agentNode("REVIEW", "delivery_reviewer", {
      deps: ["CANONICALIZE"],
      evidenceTopK: 24,
      gate: makeGateSpec({
        kind: "auto",
        require: [
          "verdict == 'PASS'",
          "blocker_count == 0",
          "all_passed == true",
          "high_findings == 0",
        ],
      }),
    }),
    makeNodeSpec({
      id: "EXPORT",
      mode: NodeMode.DETERMINISTIC,
      handler: "engagement.export",
      // Export must receive both the reviewed package and the review verdict.
      // A transitive dependency is not included in WorkingSet.select(); declaring
      // both inputs prevents the release handler from silently re-validating `{}`.
      deps: ["CANONICALIZE", "REVIEW"],
      scope: makeScopeSpec({ evidenceTopK: 0 }),
      budget: makeNodeBudget({ tokens: 0, iterations: 1, wallclockS: 180, toolCalls: 0 }),
      gate: makeGateSpec({
        kind: "auto",
        require: ["review_passed == true", "schema_valid == true", "downloadable == true"],
      }),
      params: {
        formats: ["json", "xlsx", "md", "mermaid"],
        input_contract: "OntologyPackage.v1",
      },
      retries: 0,
    }),
  ]);
  return dag.freeze();
}
