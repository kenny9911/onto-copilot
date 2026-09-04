/** Cross-catalog validation entry point used by CI and local maintainers. */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_AGENTS } from "../kernel/agents.js";
import { BUILTIN_SKILLS } from "../kernel/skills.js";
import { buildFdeEngagementDag, FDE_ENGAGEMENT_AGENTS } from "../onto/engagement.js";
import { findRepoRoot } from "../repo_root.js";
import { TOOL_POLICIES, TOOL_SCOPES, toolPolicy, toolPolicies } from "./tools.js";

export interface CatalogCheckResult {
  readonly skills: number;
  readonly agents: number;
  readonly tools: number;
  readonly coreTools: number;
  readonly dialogueTools: number;
  readonly workflows: number;
  readonly workflowNodes: number;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 含重复名称`);
}

export function checkCatalog(): CatalogCheckResult {
  unique(BUILTIN_SKILLS.map((skill) => skill.name), "Skills");
  unique(BUILTIN_AGENTS.map((agent) => agent.name), "Agents");
  unique(TOOL_POLICIES.map((tool) => tool.name), "Tools");

  const skillNames = new Set(BUILTIN_SKILLS.map((skill) => skill.name));
  for (const skill of BUILTIN_SKILLS) {
    for (const tool of skill.tools) toolPolicy(tool);
  }
  for (const agent of BUILTIN_AGENTS) {
    if (TOOL_SCOPES[agent.toolScope] === undefined) {
      throw new Error(`${agent.name} 引用了未知 tool_scope: ${agent.toolScope}`);
    }
    for (const skill of agent.skills) {
      if (!skillNames.has(skill)) throw new Error(`${agent.name} 引用了未知 Skill: ${skill}`);
    }
    if (agent.outputSchema !== null && agent.outputSchema["type"] !== "object") {
      throw new Error(`${agent.name} 的 output_schema 必须是 object schema`);
    }
  }
  // Skill 正文会随引用它的每个 Agent 一起注入。目录里声称“需要”的工具若不在
  // 任一引用 Agent 的作用域内，模型只会反复尝试一个永远不可见的动作。因此这里
  // 校验交集，而不是只校验工具名登记过。
  for (const skill of BUILTIN_SKILLS) {
    const consumers = BUILTIN_AGENTS.filter((agent) => agent.skills.includes(skill.name));
    for (const tool of skill.tools) {
      for (const agent of consumers) {
        if (!TOOL_SCOPES[agent.toolScope]!.includes(tool)) {
          throw new Error(
            `Skill ${skill.name} 需要工具 ${tool}，但 Agent ${agent.name} ` +
              `的作用域 ${agent.toolScope} 未授权`,
          );
        }
      }
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repo = findRepoRoot(here, 3);
  for (const policy of TOOL_POLICIES) {
    if (!existsSync(resolve(repo, policy.implementation))) {
      throw new Error(`${policy.name} 的 implementation 不存在: ${policy.implementation}`);
    }
  }

  const agentNames = new Set(BUILTIN_AGENTS.map((agent) => agent.name));
  for (const name of FDE_ENGAGEMENT_AGENTS) {
    if (!agentNames.has(name)) throw new Error(`FDE workflow 引用了未知 Agent: ${name}`);
  }
  const dag = buildFdeEngagementDag();
  const coreTools = toolPolicies("core").length;
  const dialogueTools = toolPolicies("dialogue").length;
  // dialogue 61：加了 document.read（通读正文）与 document.folders（看目录结构）。
  // 前者补的是「分析文档」—— 在它之前模型只有 search（要关键词）和 open（要
  // 已有的 evidence_ref），一份没猜中关键词的材料对模型等于不存在。
  // 后者补的是「管理文档」的第一步：不知道现在怎么归的类，就提不出整理建议。
  if (coreTools !== 8 || dialogueTools !== 61) {
    throw new Error(`工具目录数量异常: core=${coreTools}, dialogue=${dialogueTools}`);
  }
  return {
    skills: BUILTIN_SKILLS.length,
    agents: BUILTIN_AGENTS.length,
    tools: TOOL_POLICIES.length,
    coreTools,
    dialogueTools,
    workflows: 1,
    workflowNodes: dag.nodes.size,
  };
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...checkCatalog() }, null, 2)}\n`);
}
