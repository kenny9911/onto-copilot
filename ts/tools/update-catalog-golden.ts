/**
 * Regenerate the golden surfaces that are intentionally derived from ts/catalog.
 *
 * The catalog is the source of truth.  This script preserves the hand-authored
 * parser/edge-case fixtures in the existing golden files, and refreshes only
 * values whose output depends on built-in Skill or Agent prompts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  AgentLibrary,
  BUILTIN_AGENTS,
  TOOL_SCOPES,
  agentSpecToDict,
  defaultAgents,
  makeAgentSpec,
  renderSystem,
  scopesForTool,
  type AgentSpec,
} from "../src/kernel/agents.js";
import { Difficulty, NodeMode, makeNodeBudget } from "../src/kernel/dag.js";
import { findingToDict, makeCriticContext } from "../src/kernel/critic.js";
import {
  BUILTIN_SKILLS,
  SkillLibrary,
  defaultLibrary,
  parseSkillMd,
  skillBrief,
  skillRender,
  skillTokens,
  type Skill,
} from "../src/kernel/skills.js";
import {
  FDE_ENGAGEMENT_AGENTS,
  buildFdeEngagementDag,
} from "../src/onto/engagement.js";
import {
  EXPECTED_ARTIFACTS,
  EngagementRuntimeInput,
  engagementCritics,
  engagementHandlers,
  traceability,
} from "../src/onto/engagement_runtime.js";
import { QuestionBacklog } from "../src/onto/questions.js";

type Dict = Record<string, any>;

const REPO = resolve(import.meta.dirname, "..", "..");
const GOLDEN = join(REPO, "golden");

function readJson(name: string): Dict {
  return JSON.parse(readFileSync(join(GOLDEN, name), "utf-8")) as Dict;
}

function writeJson(name: string, value: Dict): void {
  writeFileSync(join(GOLDEN, name), `${JSON.stringify(value, null, 1)}\n`, "utf-8");
}

function skillDict(skill: Skill): Dict {
  return {
    name: skill.name,
    description: skill.description,
    when_to_use: skill.whenToUse,
    procedure: skill.procedure,
    checklist: [...skill.checklist],
    tools: [...skill.tools],
    tags: [...skill.tags],
    tokens: skillTokens(skill),
    brief: skillBrief(skill),
    render: skillRender(skill),
  };
}

function thrownMessage(body: () => unknown): string {
  try {
    body();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("golden 期望该调用抛错，但它成功了");
}

function refreshSkills(): void {
  const old = readJson("skills.json");
  const library = defaultLibrary();
  const tokens = (name: string): number => skillTokens(library.get(name));
  const load = (old.load as Dict[]).map((entry) => {
    let budget = entry.budget_tokens as number | null;
    if (entry.case === "budget_exactly_fits") budget = tokens("口径对齐");
    if (entry.case === "budget_one_short") budget = tokens("口径对齐") - 1;
    if (entry.case === "second_exactly_fits") {
      budget = tokens("口径对齐") + tokens("命名归一");
    }
    if (entry.case === "second_one_short") {
      budget = tokens("口径对齐") + tokens("命名归一") - 1;
    }
    if (entry.case === "drop_is_not_a_suffix") budget = tokens("命名归一");
    return {
      ...entry,
      budget_tokens: budget,
      out: library.load(entry.names as string[], { budgetTokens: budget }),
    };
  });

  const fromDir = old.from_dir as Dict;
  const parsedDir = new SkillLibrary();
  for (const file of Object.keys(fromDir.files as Dict).sort()) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const fallback = file.slice(0, -3);
    parsedDir.register(parseSkillMd((fromDir.files as Dict)[file] as string, { fallback }));
  }

  writeJson("skills.json", {
    ...old,
    _note: "由 ts/tools/update-catalog-golden.ts 从 ts/catalog 生成；请勿手改派生字段",
    names: library.names(),
    count: library.size,
    missing_key_message: thrownMessage(() => library.get("不存在")),
    registry_order: BUILTIN_SKILLS.map((skill) => skill.name),
    skills: BUILTIN_SKILLS.map(skillDict),
    catalog: (old.catalog as Dict[]).map((entry) => ({
      ...entry,
      out: library.catalog(entry.names as string[] | null),
    })),
    load,
    select: (old.select as Dict[]).map((entry) => ({
      ...entry,
      picked: library.select(entry.task as string, { limit: entry.limit as number }),
    })),
    parse_skill_md: (old.parse_skill_md as Dict[]).map((entry) => ({
      ...entry,
      skill: skillDict(parseSkillMd(entry.text as string, { fallback: entry.fallback as string })),
    })),
    from_dir: {
      ...fromDir,
      names: parsedDir.names(),
      skills: parsedDir.names().map((name) => skillDict(parsedDir.get(name))),
      a_md_alone: skillDict(parseSkillMd((fromDir.files as Dict)["a.md"] as string, {
        fallback: "a",
      })),
    },
  });
}

function agentDict(agent: AgentSpec, skills: SkillLibrary): Dict {
  return {
    name: agent.name,
    role: agent.role,
    mode: agent.mode,
    system: agent.system,
    tool_scope: agent.toolScope,
    skills: [...agent.skills],
    critics: [...agent.critics],
    difficulty: agent.difficulty,
    budget: {
      tokens: agent.budget.tokens,
      iterations: agent.budget.iterations,
      wallclock_s: agent.budget.wallclockS,
      tool_calls: agent.budget.toolCalls,
    },
    critic_rounds: agent.criticRounds,
    output_schema: agent.outputSchema,
    to_dict: agentSpecToDict(agent),
    to_dict_keys: Object.keys(agentSpecToDict(agent)),
    render_system_bare: renderSystem(agent, null),
    render_system_with_library: renderSystem(agent, skills),
  };
}

function adHocAgents(): Record<string, AgentSpec> {
  return {
    minimal: makeAgentSpec({
      name: "x", role: "r", mode: NodeMode.REACT, system: "  sys  ",
    }),
    unknown_skill_yields_empty_catalog: makeAgentSpec({
      name: "u", role: "r", mode: NodeMode.SINGLE_SHOT, system: "sys",
      skills: ["不存在的技能"],
    }),
    no_skill: makeAgentSpec({
      name: "n", role: "r", mode: NodeMode.HITL, system: "sys\n\n",
    }),
    fixed_difficulty: makeAgentSpec({
      name: "d", role: "r", mode: NodeMode.DETERMINISTIC, system: "s",
      difficulty: Difficulty.LOW,
      budget: makeNodeBudget({ tokens: 1, iterations: 2, wallclockS: 3, toolCalls: 4 }),
      criticRounds: 0,
      critics: ["schema"],
      skills: ["命名归一"],
    }),
  };
}

function refreshAgents(): void {
  const old = readJson("agents.json");
  const skills = defaultLibrary();
  const agents = defaultAgents();
  const adHoc = adHocAgents();
  writeJson("agents.json", {
    ...old,
    _note: "由 ts/tools/update-catalog-golden.ts 从 ts/catalog 生成；请勿手改派生字段",
    names: agents.names(),
    missing_key_message: thrownMessage(() => agents.get("不存在")),
    registry_order: BUILTIN_AGENTS.map((agent) => agent.name),
    describe: agents.describe(),
    agents: BUILTIN_AGENTS.map((agent) => agentDict(agent, skills)),
    tool_scopes: Object.fromEntries(
      Object.entries(TOOL_SCOPES).map(([scope, names]) => [scope, [...names]]),
    ),
    scopes_for: Object.fromEntries(
      Object.keys(old.scopes_for as Dict).map((name) => [name, [...scopesForTool(name)]]),
    ),
    ad_hoc: Object.fromEntries(
      Object.entries(adHoc).map(([name, agent]) => [name, agentDict(agent, skills)]),
    ),
  });
}

function refreshPipelinePrompt(): void {
  const miner = defaultAgents().get("rule_miner");
  const skills = defaultLibrary();
  const prompt = `${renderSystem(miner, skills)}\n\n${skills.load([...miner.skills])}`;
  const path = join(GOLDEN, "onto.pipeline.json");
  const before = readFileSync(path, "utf-8");
  const matcher = /("rule_miner_system"[ \t]*:[ \t]*)"(?:\\.|[^"\\])*"/u;
  if (!matcher.test(before)) throw new Error("onto.pipeline.json 缺少 rule_miner_system");
  // 这里只替换一个 JSON string，保留这份大型 golden 里 Python 生成的 1.0 等
  // 数字字面量和其他工作树改动；JSON.parse/stringify 会把它们机械改成 1。
  const after = before.replace(matcher, `$1${JSON.stringify(prompt)}`);
  writeFileSync(path, after, "utf-8");
}

function refreshConversePromptHeads(): void {
  const head = renderSystem(defaultAgents().get("fde_interviewer"), defaultLibrary())
    .split("\n", 1)[0]!;
  const path = join(GOLDEN, "onto.converse.json");
  const before = readFileSync(path, "utf-8");
  const matcher = /("system_head"[ \t]*:[ \t]*)"(?:\\.|[^"\\])*"/gu;
  const hits = before.match(matcher)?.length ?? 0;
  if (hits !== 6) throw new Error(`onto.converse.json system_head 数量异常: ${hits}`);
  writeFileSync(path, before.replace(matcher, `$1${JSON.stringify(head)}`), "utf-8");
}

function refreshConverseWorkflow(): void {
  const path = join(GOLDEN, "onto.converse.json");
  const before = readFileSync(path, "utf-8");
  const parsed = JSON.parse(before) as Dict;
  const oldEngagement = parsed.engagement as Dict;
  const dag = buildFdeEngagementDag();
  const nodes = [...dag.nodes.values()].map((node) => ({
    budget: {
      tokens: node.budget.tokens,
      iterations: node.budget.iterations,
      wallclock_s: node.budget.wallclockS,
      tool_calls: node.budget.toolCalls,
    },
    critic_rounds: node.criticRounds,
    critics: [...node.critics],
    deps: [...node.deps],
    difficulty: node.difficulty,
    fanout_over: node.fanoutOver,
    gate: node.gate === null
      ? null
      : { kind: node.gate.kind, require: [...node.gate.require] },
    handler: node.handler,
    id: node.id,
    mode: node.mode,
    params: node.params,
    retries: node.retries,
    sandbox: node.sandbox,
    scope: {
      evidence_top_k: node.scope.evidenceTopK,
      evidence_files: node.scope.evidenceFiles,
      blackboard_pattern: node.scope.blackboardPattern,
    },
  }));
  const engagement = {
    agents: [...FDE_ENGAGEMENT_AGENTS],
    describe: dag.describe(),
    freeze_before: dag.freezeBefore,
    frozen: dag.frozen,
    name: dag.name,
    nodes,
    resolve_deps: Object.fromEntries(
      [...dag.nodes.keys()].map((nodeId) => [nodeId, dag.resolveDeps(nodeId)]),
    ),
    topo_order: dag.topoOrder(),
    deliberate_changes: oldEngagement.deliberate_changes ?? [],
  };

  // Replace only the top-level engagement property.  Re-serialising this large
  // Python-derived golden would mechanically turn historical `1.0` literals into
  // `1` and obscure the actual workflow change in review.
  const marker = before.match(/\n([ \t]*)"engagement": /u);
  const indent = marker?.[1] ?? "";
  const startMarker = `\n${indent}"engagement": `;
  const nextMarker = `\n${indent}"engagement_runtime": `;
  const start = before.indexOf(startMarker);
  const next = before.indexOf(nextMarker, start + startMarker.length);
  if (start < 0 || next < 0) throw new Error("onto.converse.json 缺少顶层 engagement 区段");
  const rendered = JSON.stringify(engagement, null, 2).replace(/\n/gu, `\n${indent}`);
  const after =
    before.slice(0, start) +
    `${startMarker}${rendered},` +
    before.slice(next);
  writeFileSync(path, after, "utf-8");
}

function runtimeInput(fixture: Dict, opts: {
  backlog?: Dict;
  downloadable?: boolean;
} = {}): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "engagement-test",
    project: "采购到付款",
    oir: fixture.oir as Dict,
    flow: fixture.flow as Dict,
    backlog: QuestionBacklog.fromDict(opts.backlog ?? fixture.backlog as Dict),
    decisions: [...fixture.decisions as unknown[]],
    generatedAt: "2026-08-12T00:00:00+00:00",
    releaseDownloadable: opts.downloadable ?? true,
  });
}

function clearedBacklog(fixture: Dict): Dict {
  const source = fixture.backlog as Dict;
  return {
    ...source,
    questions: (source.questions as Dict[]).map((row) => row.id === "q.erp.version"
      ? { ...row, status: "answered", blockedArtifacts: [], priority: "high" }
      : { ...row }),
  };
}

async function v3Delivery(runtime: EngagementRuntimeInput): Promise<Dict> {
  const handlers = engagementHandlers(runtime);
  const project = (key: string, inputs: Dict): Dict =>
    (handlers[key] as unknown as { project(values: Dict): Dict }).project(inputs);
  const execute = async (key: string, inputs: Dict): Promise<Dict> =>
    await handlers[key]!.execute(inputs, { nodeId: key } as never) as Dict;

  const out: Dict = {};
  out.INTAKE = project("agent.fde_interviewer", out);
  out.PROCESS = project("agent.process_modeler", out);
  out.ERP_MAP = project("agent.erp_mapper", out);
  out.RULES = project("agent.rule_engineer", out);
  out.DATA_OBJECTS = project("agent.data_steward", out);
  out.GAP = await execute("engagement.collect_gaps", out);
  out.INTERVIEW = handlers["engagement.interview"]!.skipModel(out);
  out.DECISION_PROPOSAL = project("agent.decision_integrator", out);
  out.DECISION_APPLY = await execute("engagement.validate_decision_application", out);
  out.REQUIREMENTS = project("agent.requirements_engineer", out);
  out.ARCHITECTURE = project("agent.solution_architect", out);
  out.TEST_PLAN = project("agent.acceptance_test_engineer", out);
  out.CANONICALIZE = await execute("engagement.canonicalize", out);
  out.REVIEW = project("agent.delivery_reviewer", out);
  const acceptanceRequest = handlers["engagement.human_acceptance"]!.humanRequest(null, out);
  const acceptanceQuestion = acceptanceRequest.question as Dict;
  if (!Array.isArray(runtime.decisions)) {
    throw new Error("golden runtime 必须使用可追加的 DecisionLedger fixture");
  }
  (runtime.decisions as unknown[]).push({
    id: "d.acceptance.golden",
    questionId: acceptanceQuestion.id,
    answer: "APPROVE",
    actor: "Golden Reviewer",
    actorRole: "admin",
    authority: "admin",
    createdAt: 1_776_000_000,
  });
  out.HUMAN_ACCEPTANCE = handlers["engagement.human_acceptance"]!.skipModel(out) as Dict;
  out.EXPORT = await execute("engagement.export", out);
  return out;
}

/** Refresh values asserted by the TS FDE runtime tests from current deterministic handlers. */
async function refreshConverseRuntime(): Promise<void> {
  const path = join(GOLDEN, "onto.converse.json");
  const before = readFileSync(path, "utf-8");
  const parsed = JSON.parse(before) as Dict;
  const old = parsed.engagement_runtime as Dict;
  const fixture = old.fixture as Dict;

  const baseRuntime = runtimeInput(fixture);
  const baseHandlers = engagementHandlers(baseRuntime);
  const project = (handlers: ReturnType<typeof engagementHandlers>, key: string, inputs: Dict): Dict =>
    (handlers[key] as unknown as { project(values: Dict): Dict }).project(inputs);
  const intake = project(baseHandlers, "agent.fde_interviewer", {});
  const process = project(baseHandlers, "agent.process_modeler", {});
  const erp = project(baseHandlers, "agent.erp_mapper", { PROCESS: process });
  const rules = project(baseHandlers, "agent.rule_engineer", {});
  const objects = project(baseHandlers, "agent.data_steward", {});
  const gap = await baseHandlers["engagement.collect_gaps"]!.execute(
    { PROCESS: process, ERP_MAP: erp, RULES: rules, DATA_OBJECTS: objects },
    { nodeId: "GAP" } as never,
  ) as Dict;
  const altRuntime = new EngagementRuntimeInput({
    sessionId: "engagement-test",
    project: "采购到付款",
    oir: fixture.oir as Dict,
    flow: fixture.flow_alt,
    backlog: QuestionBacklog.fromDict(fixture.backlog as Dict),
    decisions: [...fixture.decisions as unknown[]],
    generatedAt: "2026-08-12T00:00:00+00:00",
  });
  const altHandlers = engagementHandlers(altRuntime);
  const processAlt = project(altHandlers, "agent.process_modeler", {});
  const erpAlt = project(altHandlers, "agent.erp_mapper", { PROCESS: processAlt });

  const clearRuntime = runtimeInput(fixture, { backlog: clearedBacklog(fixture) });
  const clear = await v3Delivery(clearRuntime);
  const unavailable = await v3Delivery(runtimeInput(fixture, {
    backlog: clearedBacklog(fixture),
    downloadable: false,
  }));
  const blocked = await v3Delivery(baseRuntime);

  const emptyReview = project(baseHandlers, "agent.delivery_reviewer", {});
  const emptyExport = await baseHandlers["engagement.export"]!.execute(
    {},
    { nodeId: "EXPORT" } as never,
  ) as Dict;

  const tasks = Object.fromEntries(
    Object.keys(baseHandlers).sort().map((key) => [key, baseHandlers[key]!.task({})]),
  );
  const critics = engagementCritics();
  const criticDrafts: unknown[] = [
    intake,
    { engagement: {} },
    process,
    clear.REVIEW,
    { 随便: 1 },
    "不是 object",
    null,
    clear.REVIEW,
    { traceability: { unresolved: Array.from({ length: 12 }, (_, i) => `/x/${i}`) } },
    { traceability: { unresolved: [] } },
    {},
    { traceability: { unresolved: ["/a"] } },
    "不是 object",
  ];
  const oldVerdicts = (old.critics as Dict).verdicts as Dict[];
  const verdicts: Dict[] = [];
  for (let i = 0; i < oldVerdicts.length; i += 1) {
    const lens = oldVerdicts[i]!.lens as string;
    const nodeId = oldVerdicts[i]!.node_id as string;
    const verdict = await critics[lens]!.judge(criticDrafts[i], makeCriticContext({ nodeId }));
    verdicts.push({
      lens,
      node_id: nodeId,
      verdict: {
        lens: verdict.lens,
        passed: verdict.passed,
        high: verdict.findings.filter((finding) => finding.severity === "high").length,
        findings: verdict.findings.map(findingToDict),
        note: verdict.note,
      },
    });
  }

  const runtimeGolden: Dict = {
    ...old,
    expected_artifacts: [...EXPECTED_ARTIFACTS],
    handlers: {
      ...old.handlers as Dict,
      INTAKE: intake,
      PROCESS: process,
      ERP_MAP: erp,
      RULES: rules,
      DATA_OBJECTS: objects,
      GAP: gap,
      PROCESS_alt: processAlt,
      ERP_MAP_alt: erpAlt,
      INTERVIEW_skip_model: baseHandlers["engagement.interview"]!.skipModel({}),
      INTERVIEW_human_request: baseHandlers["engagement.interview"]!.humanRequest(null, {}),
      registry_keys: Object.keys(baseHandlers).sort(),
      tasks,
    },
    clear: {
      ...old.clear as Dict,
      INTERVIEW_skip_model: clear.INTERVIEW,
      pending: clearRuntime.pending().map((question) => question.id),
      blockers: clearRuntime.blockers().map((question) => question.id),
      CANONICALIZE: clear.CANONICALIZE,
      REVIEW: clear.REVIEW,
      HUMAN_ACCEPTANCE: clear.HUMAN_ACCEPTANCE,
      EXPORT: clear.EXPORT,
      traceability: traceability(clear.CANONICALIZE as Dict),
    },
    not_downloadable: { REVIEW: unavailable.REVIEW, EXPORT: unavailable.EXPORT },
    blocked: { REVIEW: blocked.REVIEW },
    review_empty_input: emptyReview,
    export_empty_input: emptyExport,
    critics: {
      names: Object.keys(critics).sort(),
      needs_llm: Object.fromEntries(
        Object.keys(critics).sort().map((name) => [name, critics[name]!.needsLlm]),
      ),
      verdicts,
    },
  };

  const marker = before.match(/\n([ \t]*)"engagement_runtime": /u);
  const indent = marker?.[1] ?? "";
  const startMarker = `\n${indent}"engagement_runtime": `;
  const start = before.indexOf(startMarker);
  const next = before.lastIndexOf("\n}");
  if (start < 0 || next < 0) throw new Error("onto.converse.json 缺少 engagement_runtime 区段");
  const rendered = JSON.stringify(runtimeGolden, null, 2).replace(/\n/gu, `\n${indent}`);
  writeFileSync(
    path,
    before.slice(0, start) + `${startMarker}${rendered}` + before.slice(next),
    "utf-8",
  );
}

refreshSkills();
refreshAgents();
refreshPipelinePrompt();
refreshConversePromptHeads();
refreshConverseWorkflow();
await refreshConverseRuntime();
process.stdout.write(
  "Updated catalog-derived Skill, Agent, workflow and deterministic FDE v3 goldens.\n",
);
