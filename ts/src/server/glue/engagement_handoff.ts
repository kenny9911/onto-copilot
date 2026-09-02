/**
 * FDE Engagement 与 server 持久化边界之间的纯数据接缝。
 *
 * Scheduler 的 HITL 请求不是另一套问题系统。特别是 HUMAN_ACCEPTANCE：它产出的
 * `pendingHuman.question` 必须进入现有 QuestionBacklog，才能复用 /questions/:id/answer
 * 的 DecisionLedger、幂等、审计和恢复链路。
 */

import { Question, QuestionBacklog } from "../../onto/questions.js";
import { buildFdeEngagementDag } from "../../onto/engagement.js";

type StateCarrier = { readonly state: Record<string, unknown> };

/** engagement_analysis 中允许持久化的节点输出。CANONICALIZE/EXPORT 有各自权威产物，
 * 不在这里再复制一份可能漂移的大包。 */
export const FDE_ANALYSIS_NODES: readonly string[] = [
  "INTAKE",
  "PROCESS",
  "ERP_MAP",
  "RULES",
  "DATA_OBJECTS",
  "GAP",
  "DECISION_PROPOSAL",
  "DECISION_APPLY",
  "REQUIREMENTS",
  "ARCHITECTURE",
  "TEST_PLAN",
  "REVIEW",
  "HUMAN_ACCEPTANCE",
];

/** 来源未变化时可用于零模型恢复/局部 fork 的 Agent 节点。 */
export const FDE_REPLAYABLE_AGENT_NODES: readonly string[] = [
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
];

/**
 * fork 节点及其所有 descendants 都必须活跑。只排除 fork 自身会让下游 Agent
 * 复用建立在旧输入上的结论（例如 PROCESS 重跑却继续沿用旧 REQUIREMENTS）。
 * 路由预览与 run.ts 实际 replay 共用这一个算法，避免 UI 回执与真实执行分叉。
 */
export function fdeForkReplayableNodes(
  forkNode: string,
  storedNodes: Record<string, unknown>,
): string[] {
  const dag = buildFdeEngagementDag();
  if (!dag.nodes.has(forkNode)) return [];
  const invalidated = new Set<string>([forkNode]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, spec] of dag.nodes) {
      if (invalidated.has(node)) continue;
      if (spec.deps.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(node);
        changed = true;
      }
    }
  }
  return FDE_REPLAYABLE_AGENT_NODES.filter((node) => {
    const value = storedNodes[node];
    return (
      !invalidated.has(node) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    );
  });
}

function mapping(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Scheduler 会补 `node`；旧 checkpoint 没有时只允许回落到历史唯一的 INTERVIEW。 */
export function pendingHumanNode(value: unknown): string {
  const row = mapping(value);
  const node = typeof row?.["node"] === "string" ? row["node"].trim() : "";
  return node || "INTERVIEW";
}

export function pendingHumanContract(value: unknown): string {
  const row = mapping(value);
  const contract = typeof row?.["contract"] === "string" ? row["contract"].trim() : "";
  if (contract) return contract;
  return pendingHumanNode(value) === "HUMAN_ACCEPTANCE"
    ? "HumanAcceptanceRequest.v1"
    : "QuestionBacklog";
}

/**
 * 把 HITL 的单条 Question 合入当前 backlog 投影。
 *
 * 这里只更新内存投影；调用方随后必须走现有 `syncQuestionBacklog`，由它统一写
 * repo/state/JSON/Markdown/XLSX。固定只认 singular `question`，不会把 request 中
 * 任何模型可控字段解释成文件名或另一个写通道。
 */
export function mergePendingHumanQuestion(s: StateCarrier, pendingHuman: unknown): boolean {
  const request = mapping(pendingHuman);
  const rawQuestion = mapping(request?.["question"]);
  if (rawQuestion === null) return false;

  const rawBacklog = s.state["question_backlog"];
  const backlog = QuestionBacklog.fromDict(
    mapping(rawBacklog) ?? (Array.isArray(rawBacklog) ? rawBacklog : []),
  );
  backlog.add(Question.fromLegacy(rawQuestion));
  s.state["question_backlog"] = backlog.toDict();
  return true;
}
