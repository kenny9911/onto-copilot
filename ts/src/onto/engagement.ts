/**
 * Compatibility facade for the catalog-backed, frozen FDE engagement workflow.
 *
 * The executable handlers live in engagement_runtime.ts.  The control-plane topology
 * lives in ts/catalog/workflows/fde-engagement.yaml and is loaded once at startup; user
 * material can never select another file or mutate the frozen graph.
 */

import { type AgentLibrary, defaultAgents } from "../kernel/agents.js";
import { NodeMode } from "../kernel/dag.js";
import {
  buildWorkflowDag,
  loadWorkflowDefinition,
  type WorkflowDefinition,
} from "../workflows/loader.js";

const FDE_DEFINITION = loadWorkflowDefinition("fde-engagement.yaml");

function assertFdeSafetyContract(definition: WorkflowDefinition): void {
  if (definition.name !== "fde_engagement_v3") {
    throw new Error(`FDE workflow name 不可变更: ${definition.name}`);
  }
  if (definition.freezeBefore !== "INTAKE" || definition.nodes[0]?.id !== "INTAKE") {
    throw new Error("FDE workflow 必须在首个 INTAKE 节点前冻结");
  }
  const interview = definition.nodes.find((node) => node.id === "INTERVIEW");
  if (
    interview?.kind !== "handler" ||
    interview.mode !== NodeMode.HITL ||
    interview.handler !== "engagement.interview" ||
    interview.gate === null ||
    !interview.gate.require.includes("contract == 'DecisionLedger'") ||
    !interview.gate.require.includes("resolved == true")
  ) {
    throw new Error("FDE INTERVIEW 必须保留 DecisionLedger 人工门");
  }
  const decisionProposal = definition.nodes.find((node) => node.id === "DECISION_PROPOSAL");
  if (
    decisionProposal?.kind !== "agent" ||
    decisionProposal.agent !== "decision_integrator"
  ) {
    throw new Error("FDE DECISION_PROPOSAL 必须由 decision_integrator 生成只读变更建议");
  }
  const decisionApply = definition.nodes.find((node) => node.id === "DECISION_APPLY");
  if (
    decisionApply?.kind !== "handler" ||
    decisionApply.mode !== NodeMode.DETERMINISTIC ||
    decisionApply.handler !== "engagement.validate_decision_application" ||
    decisionApply.gate === null ||
    !decisionApply.gate.require.includes("untargeted_write_count == 0") ||
    !decisionApply.gate.require.includes("mutation_count == 0") ||
    !decisionApply.gate.require.includes("claimed_applied_count == 0")
  ) {
    throw new Error("FDE DECISION_APPLY 必须确定性、无写权限并对无目标/伪应用 fail closed");
  }
  for (const [id, agent] of [
    ["REQUIREMENTS", "requirements_engineer"],
    ["ARCHITECTURE", "solution_architect"],
    ["TEST_PLAN", "acceptance_test_engineer"],
  ] as const) {
    const node = definition.nodes.find((candidate) => candidate.id === id);
    if (node?.kind !== "agent" || node.agent !== agent) {
      throw new Error(`FDE ${id} 必须由 ${agent} 执行`);
    }
  }
  const review = definition.nodes.find((node) => node.id === "REVIEW");
  if (review?.kind !== "agent" || review.agent !== "delivery_reviewer" || review.gate === null) {
    throw new Error("FDE REVIEW 必须由 delivery_reviewer 执行并保留质量门");
  }
  const humanAcceptance = definition.nodes.find((node) => node.id === "HUMAN_ACCEPTANCE");
  if (
    humanAcceptance?.kind !== "handler" ||
    humanAcceptance.mode !== NodeMode.HITL ||
    humanAcceptance.handler !== "engagement.human_acceptance" ||
    humanAcceptance.gate === null ||
    !humanAcceptance.gate.require.includes("signed == true") ||
    !humanAcceptance.gate.require.includes("decision_recorded == true") ||
    !humanAcceptance.gate.require.includes("package_bound == true")
  ) {
    throw new Error("FDE HUMAN_ACCEPTANCE 必须保留与精确包版本绑定的正式人工签字门");
  }
  const exported = definition.nodes.find((node) => node.id === "EXPORT");
  if (
    exported?.kind !== "handler" ||
    exported.handler !== "engagement.export" ||
    exported.gate === null ||
    !exported.gate.require.includes("human_decided == true")
  ) {
    throw new Error("FDE EXPORT 必须保留确定性交付门");
  }
}

assertFdeSafetyContract(FDE_DEFINITION);

export const FDE_ENGAGEMENT_AGENTS: readonly string[] = [...FDE_DEFINITION.requiredAgents];
export const FDE_CHECKPOINT_VERSION = FDE_DEFINITION.checkpointVersion;

/**
 * Build a fresh frozen front-line workflow.  The optional AgentLibrary retains the
 * historical fail-fast compatibility check; executable node specs still come from the
 * default built-in catalog, exactly as before this file-structure migration.
 */
export function buildFdeEngagementDag(
  agents?: AgentLibrary | null,
  opts: { checkpointSalt?: string } = {},
) {
  const compatibilityLibrary = agents ?? defaultAgents();
  for (const name of FDE_ENGAGEMENT_AGENTS) compatibilityLibrary.get(name);

  const checkpointVersion = opts.checkpointSalt
    ? `${FDE_CHECKPOINT_VERSION}+fork.${opts.checkpointSalt}`
    : FDE_CHECKPOINT_VERSION;
  return buildWorkflowDag(FDE_DEFINITION, defaultAgents(), { checkpointVersion });
}
