/**
 * Agent 定义 —— 把"谁来干、用什么档位、能碰哪些工具、按哪套规程"打包成一个对象。
 * 移植自 Python 侧 `kernel/agents.py`，由 `golden/agents.json` 钉住（十三个 agent
 * 的每一个字节、作用域授权表、render_system 的两种形态）。可维护定义位于
 * `ts/catalog/agents/`；本文件保留类型、加载器和兼容 API。
 *
 * **Agent 是配置，不是代码。** 一个 {@link AgentSpec} 声明角色、模型档位、工具
 * 作用域、技能集、评审视角、循环模式；真正的执行由 `loop.ts` 的 AgentLoop 完成。
 * 这样"改一个 agent 的行为"是改配置，不是改控制流 —— 后者会让每次调整都带上回归
 * 风险。
 *
 * 三条约束写进了类型里，不靠自觉：
 *
 * * **工具按作用域授予。** 抽取 agent 的动作空间里根本没有出网工具，所以材料里
 *   写什么诱导都没用 —— 这是间接提示注入的主要防线。
 * * **技能渐进披露。** 只有 brief 常驻，正文按需载入。
 * * **评审视角与角色绑定。** 谁产出什么，就该被对应的视角审。
 *
 * ── 移植期的形态选择 ──────────────────────────────────────────────
 *
 * 1. `AgentSpec` 是 interface + 工厂 + 自由函数（`renderSystem` / `agentSpecToDict`），
 *    不是 class：它是纯配置，要能 JSON 往返（`to_dict` 进 `/api/agents`、进 DAG
 *    节点的 params）。默认值写成模块级常量，不用 class field —— 见契约 §1。
 * 2. `TOOL_SCOPES` / `scopesForTool` 由 `catalog/tools.ts` 加载，本文件只兼容转导出。
 */

import {
  asFiniteNumber,
  asRecord,
  asString,
  asStringList,
  readCatalogMarkdown,
  readCatalogText,
  readCatalogYaml,
} from "../catalog/io.js";
import { pyRepr } from "./errors.js";
import {
  Difficulty,
  NodeMode,
  makeNodeBudget,
  parseDifficulty,
  parseNodeMode,
  type NodeBudget,
} from "./dag.js";
import { SkillLibrary, keyError, pyStrip } from "./skills.js";

// Compatibility facade: tool governance now lives with the tool catalog, not Agents.
export { TOOL_SCOPES, scopesForTool } from "../catalog/tools.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义小工具
// ══════════════════════════════════════════════════════════════════

/** 见 skills.ts 里同名函数的说明：Python 比 code point，JS 默认比 code unit。 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

// ══════════════════════════════════════════════════════════════════
//  AgentSpec
// ══════════════════════════════════════════════════════════════════

/** JSON Schema 就是一坨 dict[str, Any]，这里不擅自收紧 —— 收紧等于凭空加了一道
 * Python 没有的校验，而这些 schema 会原样下发给模型。 */
export type OutputSchema = Record<string, unknown>;

/**
 * 一个具名 agent。
 *
 * - `toolScope`: 工具作用域名。`ToolRegistry` 按它授予工具。
 * - `skills`: 该角色相关的技能名。载入时机由 loop 决定，不是全量塞。
 * - `critics`: 产出后挂哪些评审视角。
 * - `difficulty`: 固定档位。`null` 表示交给难度路由自动决定。
 */
export interface AgentSpec {
  readonly name: string;
  /** 一句话说清这个 agent 负责什么。 */
  readonly role: string;
  readonly mode: NodeMode;
  readonly system: string;
  readonly toolScope: string;
  readonly skills: readonly string[];
  readonly critics: readonly string[];
  readonly difficulty: Difficulty | null;
  readonly budget: NodeBudget;
  readonly criticRounds: number;
  readonly outputSchema: OutputSchema | null;
}

export const AGENT_SPEC_DEFAULTS = {
  toolScope: "readonly",
  skills: [] as readonly string[],
  critics: [] as readonly string[],
  difficulty: null,
  criticRounds: 2,
  outputSchema: null,
} as const;

export function makeAgentSpec(
  init: Partial<AgentSpec> & Pick<AgentSpec, "name" | "role" | "mode" | "system">,
): AgentSpec {
  return {
    name: init.name,
    role: init.role,
    mode: init.mode,
    system: init.system,
    toolScope: init.toolScope ?? AGENT_SPEC_DEFAULTS.toolScope,
    // 每次新数组：Python 的 tuple 是不可变的，TS 的数组不是，共享引用迟早被人 push。
    skills: [...(init.skills ?? AGENT_SPEC_DEFAULTS.skills)],
    critics: [...(init.critics ?? AGENT_SPEC_DEFAULTS.critics)],
    difficulty: init.difficulty ?? AGENT_SPEC_DEFAULTS.difficulty,
    // Python 是 `field(default_factory=NodeBudget)` —— 每个 spec 一份新的默认预算。
    budget: init.budget ?? makeNodeBudget(),
    criticRounds: init.criticRounds ?? AGENT_SPEC_DEFAULTS.criticRounds,
    outputSchema: init.outputSchema ?? AGENT_SPEC_DEFAULTS.outputSchema,
  };
}

/**
 * 组装系统提示词：角色 + 技能目录（brief，不含正文）。
 *
 * 三个条件缺一不可（`library` 在、`skills` 非空、catalog 非空串），少判一个就会在
 * 提示词末尾多出一个孤零零的空行 —— 提示词的字节是模型输入的一部分。
 */
export function renderSystem(spec: AgentSpec, library?: SkillLibrary | null): string {
  const parts = [pyStrip(spec.system)];
  if (library !== undefined && library !== null && spec.skills.length > 0) {
    const catalog = library.catalog([...spec.skills]);
    if (catalog !== "") parts.push("", catalog);
  }
  return parts.join("\n");
}

/** Python 侧的 `to_dict()`。键序照抄 —— 它会原样进 `/api` 响应。 */
export function agentSpecToDict(spec: AgentSpec): Record<string, unknown> {
  return {
    name: spec.name,
    role: spec.role,
    mode: spec.mode,
    tool_scope: spec.toolScope,
    skills: [...spec.skills],
    critics: [...spec.critics],
    // `str(x) if x else "auto"` —— Difficulty 的取值都非空串，所以只有 None 走兜底。
    difficulty: spec.difficulty ?? "auto",
    // 只导出 tokens / iterations 两维：另外两维（wallclockS / toolCalls）Python 侧
    // 也没进 to_dict，补上会让前端看到一个 Python 时代没有的字段。
    budget: { tokens: spec.budget.tokens, iterations: spec.budget.iterations },
  };
}

// ══════════════════════════════════════════════════════════════════
//  AgentLibrary
// ══════════════════════════════════════════════════════════════════

/** 具名 agent 的注册表。DAG 节点按名字引用它们。 */
export class AgentLibrary {
  private readonly agents = new Map<string, AgentSpec>();

  constructor(agents?: readonly AgentSpec[] | null) {
    for (const a of agents ?? []) this.agents.set(a.name, a);
  }

  register(spec: AgentSpec): this {
    this.agents.set(spec.name, spec);
    return this;
  }

  get(name: string): AgentSpec {
    const a = this.agents.get(name);
    if (a === undefined) {
      throw keyError(
        `没有名为 ${pyRepr(name)} 的 agent（已注册：${pyReprList(this.names())}）`,
      );
    }
    return a;
  }

  names(): string[] {
    return [...this.agents.keys()].sort(codePointCompare);
  }

  describe(): Record<string, unknown>[] {
    return this.names().map((n) => agentSpecToDict(this.get(n)));
  }
}

// ══════════════════════════════════════════════════════════════════
//  本体建模的内置 agent
// ══════════════════════════════════════════════════════════════════


const OUTPUT_SCHEMA_CACHE = new Map<string, OutputSchema>();

function loadOutputSchema(id: string, label: string): OutputSchema {
  if (!/^[a-z][a-z0-9_]*$/u.test(id)) throw new Error(`${label} 非法: ${id}`);
  const cached = OUTPUT_SCHEMA_CACHE.get(id);
  if (cached !== undefined) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readCatalogText("agents", "schemas", `${id}.schema.json`)) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 无法读取 ${id}.schema.json: ${detail}`);
  }
  const schema = asRecord(parsed, `${label} ${id}.schema.json`);
  if (schema["type"] !== "object") {
    throw new Error(`${label} ${id}.schema.json 必须是 object schema`);
  }
  OUTPUT_SCHEMA_CACHE.set(id, schema);
  return schema;
}
const AGENT_FRONTMATTER_KEYS = new Set([
  "schema_version",
  "version",
  "owner",
  "mode",
  "tool_scope",
  "skills",
  "critics",
  "difficulty",
  "budget",
  "critic_rounds",
  "output_schema",
]);

function nonnegativeInteger(value: unknown, label: string): number {
  const n = asFiniteNumber(value, label);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} 必须是非负整数`);
  return n;
}

function markdownField(text: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(text);
  if (match === null || match[1] === undefined || pyStrip(match[1]) === "") {
    throw new Error(`${label} 缺失`);
  }
  return pyStrip(match[1]);
}

function agentSystemSection(text: string, label: string): string {
  const headings = [...text.matchAll(/(?:^|\n)##[ \t]+([^\n]+?)[ \t]*(?=\n|$)/gu)];
  if (headings.length === 0 || pyStrip(headings[0]?.[1] ?? "") !== "System") {
    throw new Error(`${label} 缺少 ## System`);
  }
  if (headings.length !== 1) {
    throw new Error(`${label} 只能有一个 ## System；Prompt 内部分节请使用 ###`);
  }
  const heading = headings[0]!;
  const start = heading.index + heading[0].length;
  const body = pyStrip(text.slice(start));
  if (body === "") throw new Error(`${label} 的 ## System 不能为空`);
  return body;
}

function loadAgentFile(file: string, basePrompt: string): AgentSpec {
  if (!/^[0-9]{2}-[a-z0-9-]+\.md$/u.test(file)) {
    throw new Error(`Agent manifest 含非法文件名: ${file}`);
  }
  const doc = readCatalogMarkdown("agents", file);
  for (const key of Object.keys(doc.attributes)) {
    if (!AGENT_FRONTMATTER_KEYS.has(key)) {
      throw new Error(`${file} 含未知 frontmatter 字段: ${key}`);
    }
  }
  if (doc.attributes["schema_version"] !== 1) {
    throw new Error(`${file}.schema_version 只支持 1`);
  }
  const version = asString(doc.attributes["version"], `${file}.version`);
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`${file}.version 必须是语义版本 x.y.z`);
  }
  asString(doc.attributes["owner"], `${file}.owner`);

  const name = markdownField(doc.body, /^#[ \t]+([^\n]+)$/mu, `${file} H1`);
  const role = markdownField(doc.body, /^>[ \t]*([^\n]+)$/mu, `${file} role`);
  const mode = parseNodeMode(asString(doc.attributes["mode"], `${file}.mode`));
  const difficultyRaw = doc.attributes["difficulty"];
  const difficulty = difficultyRaw === null || difficultyRaw === "auto"
    ? null
    : parseDifficulty(asString(difficultyRaw, `${file}.difficulty`));
  const budget = asRecord(doc.attributes["budget"], `${file}.budget`);

  const schemaId = doc.attributes["output_schema"];
  let outputSchema: OutputSchema | null = null;
  if (schemaId !== null && schemaId !== undefined) {
    const id = asString(schemaId, `${file}.output_schema`);
    outputSchema = loadOutputSchema(id, `${file}.output_schema`);
  }

  return makeAgentSpec({
    name,
    role,
    mode,
    system: `${pyStrip(basePrompt)}\n\n${agentSystemSection(doc.body, file)}`,
    toolScope: asString(doc.attributes["tool_scope"], `${file}.tool_scope`),
    skills: asStringList(doc.attributes["skills"], `${file}.skills`),
    critics: asStringList(doc.attributes["critics"], `${file}.critics`),
    difficulty,
    budget: makeNodeBudget({
      tokens: nonnegativeInteger(budget["tokens"], `${file}.budget.tokens`),
      iterations: nonnegativeInteger(budget["iterations"], `${file}.budget.iterations`),
      wallclockS: nonnegativeInteger(budget["wallclock_s"], `${file}.budget.wallclock_s`),
      toolCalls: nonnegativeInteger(budget["tool_calls"], `${file}.budget.tool_calls`),
    }),
    criticRounds: nonnegativeInteger(doc.attributes["critic_rounds"], `${file}.critic_rounds`),
    outputSchema,
  });
}

/** Load and validate the ordered built-in Agent catalog once at module startup. */
export function loadBuiltinAgents(): readonly AgentSpec[] {
  const manifest = asRecord(readCatalogYaml("agents", "manifest.yaml"), "agents/manifest.yaml");
  if (manifest["schema_version"] !== 1) {
    throw new Error("agents/manifest.yaml.schema_version 只支持 1");
  }
  const baseFile = asString(manifest["base_prompt"], "agents/manifest.yaml.base_prompt");
  if (baseFile !== "_base.md") throw new Error("Agent base_prompt 必须是 _base.md");
  const files = asStringList(manifest["agents"], "agents/manifest.yaml.agents");
  const basePrompt = readCatalogText("agents", baseFile);
  const agents = files.map((file) => loadAgentFile(file, basePrompt));
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.name)) throw new Error(`Agent 重名: ${agent.name}`);
    seen.add(agent.name);
  }
  return agents;
}

export const BUILTIN_AGENTS: readonly AgentSpec[] = loadBuiltinAgents();

export function defaultAgents(): AgentLibrary {
  return new AgentLibrary([...BUILTIN_AGENTS]);
}
