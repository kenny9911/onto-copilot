/** Strict loader for frozen, catalog-backed Agent workflows. */

import {
  asFiniteNumber,
  asRecord,
  asString,
  asStringList,
  readCatalogYaml,
} from "../catalog/io.js";
import type { AgentLibrary } from "../kernel/agents.js";
import {
  Dag,
  type Difficulty,
  type GateSpec,
  type NodeBudget,
  type NodeMode,
  makeGateSpec,
  makeNodeBudget,
  makeNodeSpec,
  makeScopeSpec,
  parseDifficulty,
  parseNodeMode,
} from "../kernel/dag.js";

interface GateDefinition {
  readonly kind: string;
  readonly require: readonly string[];
}

interface NodeBase {
  readonly id: string;
  readonly deps: readonly string[];
  readonly evidenceTopK: number;
  readonly gate: GateDefinition | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly retries: number;
}

export interface AgentNodeDefinition extends NodeBase {
  readonly kind: "agent";
  readonly agent: string;
}

export interface HandlerNodeDefinition extends NodeBase {
  readonly kind: "handler";
  readonly mode: NodeMode;
  readonly handler: string;
  readonly budget: NodeBudget;
  readonly difficulty: Difficulty | null;
}

export type WorkflowNodeDefinition = AgentNodeDefinition | HandlerNodeDefinition;

export interface WorkflowDefinition {
  readonly name: string;
  readonly checkpointVersion: string;
  readonly freezeBefore: string;
  readonly requiredAgents: readonly string[];
  readonly nodes: readonly WorkflowNodeDefinition[];
}

const TOP_KEYS = new Set([
  "schema_version",
  "name",
  "checkpoint_version",
  "freeze_before",
  "required_agents",
  "nodes",
]);
const NODE_KEYS = new Set([
  "id",
  "agent",
  "mode",
  "handler",
  "deps",
  "evidence_top_k",
  "budget",
  "difficulty",
  "gate",
  "params",
  "retries",
]);

function nonnegativeInteger(value: unknown, label: string): number {
  const n = asFiniteNumber(value, label);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} 必须是非负整数`);
  return n;
}

function parseGate(value: unknown, label: string): GateDefinition | null {
  if (value === null || value === undefined) return null;
  const gate = asRecord(value, label);
  for (const key of Object.keys(gate)) {
    if (key !== "kind" && key !== "require") throw new Error(`${label} 含未知字段: ${key}`);
  }
  return {
    kind: asString(gate["kind"], `${label}.kind`),
    require: asStringList(gate["require"], `${label}.require`),
  };
}

function parseBudget(value: unknown, label: string): NodeBudget {
  const budget = asRecord(value, label);
  const allowed = new Set(["tokens", "iterations", "wallclock_s", "tool_calls"]);
  for (const key of Object.keys(budget)) {
    if (!allowed.has(key)) throw new Error(`${label} 含未知字段: ${key}`);
  }
  return makeNodeBudget({
    tokens: nonnegativeInteger(budget["tokens"], `${label}.tokens`),
    iterations: nonnegativeInteger(budget["iterations"], `${label}.iterations`),
    wallclockS: nonnegativeInteger(budget["wallclock_s"], `${label}.wallclock_s`),
    toolCalls: nonnegativeInteger(budget["tool_calls"], `${label}.tool_calls`),
  });
}

function parseNode(value: unknown, index: number): WorkflowNodeDefinition {
  const label = `workflow.nodes[${index}]`;
  const raw = asRecord(value, label);
  for (const key of Object.keys(raw)) {
    if (!NODE_KEYS.has(key)) throw new Error(`${label} 含未知字段: ${key}`);
  }
  const id = asString(raw["id"], `${label}.id`);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(id)) throw new Error(`${label}.id 非法: ${id}`);
  const deps = raw["deps"] === undefined ? [] : asStringList(raw["deps"], `${label}.deps`);
  const evidenceTopK = raw["evidence_top_k"] === undefined
    ? 32
    : nonnegativeInteger(raw["evidence_top_k"], `${label}.evidence_top_k`);
  const gate = parseGate(raw["gate"], `${label}.gate`);
  const params = raw["params"] === undefined
    ? {}
    : asRecord(raw["params"], `${label}.params`);
  if (Object.hasOwn(params, "checkpoint_version")) {
    throw new Error(`${label}.params 不得覆盖 checkpoint_version`);
  }
  const retries = raw["retries"] === undefined
    ? 1
    : nonnegativeInteger(raw["retries"], `${label}.retries`);

  if (raw["agent"] !== undefined) {
    for (const forbidden of ["mode", "handler", "budget", "difficulty"]) {
      if (raw[forbidden] !== undefined) throw new Error(`${label} 的 agent 节点不能声明 ${forbidden}`);
    }
    return {
      kind: "agent",
      id,
      agent: asString(raw["agent"], `${label}.agent`),
      deps,
      evidenceTopK,
      gate,
      params,
      retries,
    };
  }

  return {
    kind: "handler",
    id,
    mode: parseNodeMode(asString(raw["mode"], `${label}.mode`)),
    handler: asString(raw["handler"], `${label}.handler`),
    deps,
    evidenceTopK,
    gate,
    params,
    retries,
    budget: parseBudget(raw["budget"], `${label}.budget`),
    difficulty: raw["difficulty"] === undefined || raw["difficulty"] === null
      ? null
      : parseDifficulty(asString(raw["difficulty"], `${label}.difficulty`)),
  };
}

export function loadWorkflowDefinition(file: string): WorkflowDefinition {
  if (!/^[a-z0-9-]+\.yaml$/u.test(file)) throw new Error(`非法 workflow 文件名: ${file}`);
  const root = asRecord(readCatalogYaml("workflows", file), `workflows/${file}`);
  for (const key of Object.keys(root)) {
    if (!TOP_KEYS.has(key)) throw new Error(`workflows/${file} 含未知字段: ${key}`);
  }
  if (root["schema_version"] !== 1) throw new Error(`${file}.schema_version 只支持 1`);
  const requiredAgents = asStringList(root["required_agents"], `${file}.required_agents`);
  if (new Set(requiredAgents).size !== requiredAgents.length) {
    throw new Error(`${file}.required_agents 含重复项`);
  }
  if (!Array.isArray(root["nodes"])) throw new Error(`${file}.nodes 必须是数组`);
  const nodes = root["nodes"].map(parseNode);
  const ids = nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${file}.nodes 含重复 id`);
  const declaredAgents = new Set(
    nodes.filter((node): node is AgentNodeDefinition => node.kind === "agent")
      .map((node) => node.agent),
  );
  for (const agent of requiredAgents) {
    if (!declaredAgents.has(agent)) throw new Error(`${file} 缺少 required agent 节点: ${agent}`);
  }
  return {
    name: asString(root["name"], `${file}.name`),
    checkpointVersion: asString(root["checkpoint_version"], `${file}.checkpoint_version`),
    freezeBefore: asString(root["freeze_before"], `${file}.freeze_before`),
    requiredAgents,
    nodes,
  };
}

function gateSpec(gate: GateDefinition | null): GateSpec | null {
  return gate === null ? null : makeGateSpec({ kind: gate.kind, require: gate.require });
}

/** Instantiate a fresh DAG from an immutable, already-validated definition. */
export function buildWorkflowDag(
  definition: WorkflowDefinition,
  agents: AgentLibrary,
  opts: { checkpointVersion?: string } = {},
): Dag {
  const checkpointVersion = opts.checkpointVersion ?? definition.checkpointVersion;
  for (const name of definition.requiredAgents) agents.get(name);
  const dag = new Dag(definition.name, { freezeBefore: definition.freezeBefore });
  for (const node of definition.nodes) {
    if (node.kind === "agent") {
      const agent = agents.get(node.agent);
      dag.add(makeNodeSpec({
        id: node.id,
        mode: agent.mode,
        handler: `agent.${node.agent}`,
        deps: node.deps,
        scope: makeScopeSpec({ evidenceTopK: node.evidenceTopK }),
        budget: agent.budget,
        critics: agent.critics,
        criticRounds: agent.criticRounds,
        difficulty: agent.difficulty,
        gate: gateSpec(node.gate),
        retries: node.retries,
        params: {
          checkpoint_version: checkpointVersion,
          agent: node.agent,
          tool_scope: agent.toolScope,
          output_schema: agent.outputSchema,
          ...node.params,
        },
      }));
      continue;
    }
    dag.add(makeNodeSpec({
      id: node.id,
      mode: node.mode,
      handler: node.handler,
      deps: node.deps,
      scope: makeScopeSpec({ evidenceTopK: node.evidenceTopK }),
      budget: node.budget,
      difficulty: node.difficulty,
      gate: gateSpec(node.gate),
      retries: node.retries,
      params: { checkpoint_version: checkpointVersion, ...node.params },
    }));
  }
  return dag.freeze();
}
