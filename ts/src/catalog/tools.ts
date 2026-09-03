/** Validated governance catalog for built-in tools and their least-privilege scopes. */

import {
  asRecord,
  asString,
  asStringList,
  readCatalogYaml,
} from "./io.js";
import type { FnToolInit, ToolHandler, ToolRegistry } from "../kernel/tools.js";

export type ToolAssembly = "core" | "dialogue";
export type ToolDangerName = "READ" | "COMPUTE" | "WRITE_LOCAL" | "EXTERNAL";
export type ToolAvailability = "always" | "evidence" | "oir" | "profiles_nonempty" | "sandbox";

export interface ManagedToolPolicy {
  readonly name: string;
  readonly assembly: ToolAssembly;
  readonly family: string;
  readonly danger: ToolDangerName;
  readonly access: string;
  readonly scopes: readonly string[];
  readonly availability: ToolAvailability;
  readonly implementation: string;
  readonly status: "active" | "deprecated";
  /** Short model-facing boundary; the detailed contract remains beside the handler. */
  readonly routingPrompt: string;
}

interface LoadedToolCatalog {
  readonly agentScopes: Readonly<Record<string, readonly string[]>>;
  readonly policies: readonly ManagedToolPolicy[];
  readonly byName: ReadonlyMap<string, ManagedToolPolicy>;
}

const DANGERS = new Set<ToolDangerName>(["READ", "COMPUTE", "WRITE_LOCAL", "EXTERNAL"]);
const ASSEMBLIES = new Set<ToolAssembly>(["core", "dialogue"]);
const AVAILABILITY = new Set<ToolAvailability>([
  "always",
  "evidence",
  "oir",
  "profiles_nonempty",
  "sandbox",
]);
const STATUSES = new Set(["active", "deprecated"] as const);
const TOOL_KEYS = new Set([
  "name",
  "assembly",
  "family",
  "danger",
  "access",
  "availability",
  "implementation",
  "status",
  "routing_prompt",
]);

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  const text = asString(value, label) as T;
  if (!allowed.has(text)) throw new Error(`${label} 的取值不受支持: ${text}`);
  return text;
}

function loadToolCatalog(): LoadedToolCatalog {
  const root = asRecord(readCatalogYaml("tools", "tools.yaml"), "tools/tools.yaml");
  if (root["schema_version"] !== 1) {
    throw new Error("tools/tools.yaml.schema_version 只支持 1");
  }

  const scopesRaw = asRecord(root["agent_scopes"], "tools.agent_scopes");
  const agentScopes: Record<string, readonly string[]> = {};
  for (const [scope, names] of Object.entries(scopesRaw)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(scope)) throw new Error(`非法工具作用域名: ${scope}`);
    const parsed = asStringList(names, `tools.agent_scopes.${scope}`);
    if (new Set(parsed).size !== parsed.length) throw new Error(`工具作用域 ${scope} 含重复工具`);
    agentScopes[scope] = parsed;
  }

  const profilesRaw = asRecord(root["access_profiles"], "tools.access_profiles");
  const profiles = new Map<string, readonly string[]>();
  for (const [profile, scopes] of Object.entries(profilesRaw)) {
    const parsed = asStringList(scopes, `tools.access_profiles.${profile}`);
    if (new Set(parsed).size !== parsed.length) throw new Error(`access profile ${profile} 含重复 scope`);
    profiles.set(profile, parsed);
  }

  const toolsRaw = root["tools"];
  if (!Array.isArray(toolsRaw)) throw new Error("tools.tools 必须是数组");
  const policies: ManagedToolPolicy[] = [];
  const byName = new Map<string, ManagedToolPolicy>();
  for (let i = 0; i < toolsRaw.length; i += 1) {
    const label = `tools.tools[${i}]`;
    const item = asRecord(toolsRaw[i], label);
    for (const key of Object.keys(item)) {
      if (!TOOL_KEYS.has(key)) throw new Error(`${label} 含未知字段: ${key}`);
    }
    const name = asString(item["name"], `${label}.name`);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(name)) {
      throw new Error(`${label}.name 非法: ${name}`);
    }
    if (byName.has(name)) throw new Error(`工具重名: ${name}`);
    const assembly = enumValue(item["assembly"], ASSEMBLIES, `${label}.assembly`);
    const access = asString(item["access"], `${label}.access`);
    const scopes = access === "agent_scopes"
      ? Object.entries(agentScopes)
          .filter(([, names]) => names.includes(name))
          .map(([scope]) => scope)
      : profiles.get(access);
    if (scopes === undefined) throw new Error(`${name} 引用了未知 access profile: ${access}`);
    if (assembly === "core" && access !== "agent_scopes") {
      throw new Error(`core 工具 ${name} 必须使用 agent_scopes`);
    }
    if (assembly === "dialogue" && access === "agent_scopes") {
      throw new Error(`dialogue 工具 ${name} 必须使用 access_profile`);
    }
    const implementation = asString(item["implementation"], `${label}.implementation`);
    if (!/^ts\/src\/server\/.+\.ts$/u.test(implementation) || implementation.includes("..")) {
      throw new Error(`${name} 的 implementation 越界或格式错误: ${implementation}`);
    }
    const routingPrompt = asString(item["routing_prompt"], `${label}.routing_prompt`);
    if (routingPrompt !== routingPrompt.trim()) {
      throw new Error(`${name} 的 routing_prompt 首尾不能有空白`);
    }
    if (routingPrompt.includes("\n")) {
      throw new Error(`${name} 的 routing_prompt 必须保持单行；详细说明留在 ToolSpec`);
    }
    if ([...routingPrompt].length > 220) {
      throw new Error(`${name} 的 routing_prompt 超过 220 字符，不再是短路由提示`);
    }
    const policy: ManagedToolPolicy = {
      name,
      assembly,
      family: asString(item["family"], `${label}.family`),
      danger: enumValue(item["danger"], DANGERS, `${label}.danger`),
      access,
      scopes: [...scopes],
      availability: enumValue(item["availability"], AVAILABILITY, `${label}.availability`),
      implementation,
      status: enumValue(item["status"], STATUSES, `${label}.status`),
      routingPrompt,
    };
    policies.push(policy);
    byName.set(name, policy);
  }

  for (const [scope, names] of Object.entries(agentScopes)) {
    for (const name of names) {
      const policy = byName.get(name);
      if (policy === undefined) throw new Error(`作用域 ${scope} 引用了未登记工具: ${name}`);
      if (policy.assembly !== "core") {
        throw new Error(`作用域 ${scope} 不能引用 dialogue 工具: ${name}`);
      }
    }
  }

  return { agentScopes, policies, byName };
}

const CATALOG = loadToolCatalog();

/** Backwards-compatible Agent scope export, now sourced from tools/tools.yaml. */
export const TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = CATALOG.agentScopes;
export const TOOL_POLICIES: readonly ManagedToolPolicy[] = CATALOG.policies;

export function scopesForTool(tool: string): readonly string[] {
  return TOOL_POLICIES.find((policy) => policy.name === tool && policy.assembly === "core")
    ?.scopes ?? [];
}

export function toolPolicy(name: string): ManagedToolPolicy {
  const policy = CATALOG.byName.get(name);
  if (policy === undefined) throw new Error(`工具未登记在 tools/tools.yaml: ${name}`);
  return policy;
}

export function toolPolicies(assembly: ToolAssembly): readonly ManagedToolPolicy[] {
  return TOOL_POLICIES.filter((policy) => policy.assembly === assembly);
}

const ROUTING_PREFIX = "选择边界：";

/**
 * Compose the catalog-owned routing boundary with the handler-owned detailed prompt.
 * Keeping the detailed text byte-for-byte intact protects dynamic capability wording
 * (for example export formats) and the operation guidance pinned by regression tests.
 */
export function composeManagedToolPrompt(name: string, detailed: string): string {
  if (typeof detailed !== "string" || detailed.trim() === "") {
    throw new Error(`${name} 的 ToolSpec description 不能为空`);
  }
  const route = `${ROUTING_PREFIX}${toolPolicy(name).routingPrompt}\n\n`;
  return detailed.startsWith(route) ? detailed : route + detailed;
}

export interface ManagedToolRegistrar {
  fn(init: FnToolInit, handler: ToolHandler): ToolRegistry;
}

/**
 * Opt-in adapter for OntoChat production registries. The generic ToolRegistry stays
 * catalog-agnostic for tests, MCP tools and embedders; only managed built-ins receive
 * catalog routing text.
 */
export function managedToolRegistrar(
  registry: ToolRegistry,
  assembly: ToolAssembly,
): ManagedToolRegistrar {
  return Object.freeze({
    fn(init: FnToolInit, handler: ToolHandler): ToolRegistry {
      const policy = toolPolicy(init.name);
      if (policy.assembly !== assembly) {
        throw new Error(
          `${init.name} 属于 ${policy.assembly} 装配，不能从 ${assembly} registrar 注册`,
        );
      }
      if (policy.status !== "active") {
        throw new Error(`${init.name} 已标记为 ${policy.status}，不能注册进生产动作空间`);
      }
      return registry.fn(
        { ...init, description: composeManagedToolPrompt(init.name, init.description) },
        handler,
      );
    },
  });
}

export interface ManagedToolRegistration {
  readonly name: string;
  readonly origin: string;
  readonly danger: string;
  readonly scopes: readonly string[];
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, i) => value === expected[i]);
}

/**
 * Fail fast when executable registration drifts from tools/tools.yaml.
 * Conditional core tools may be absent; dialogue assembly is always complete.
 */
export function assertManagedToolRegistrations(
  registrations: readonly ManagedToolRegistration[],
  assembly: ToolAssembly,
  opts: { requireAll?: boolean } = {},
): void {
  const expected = toolPolicies(assembly).filter((policy) => policy.status === "active");
  const expectedNames = new Set(expected.map((policy) => policy.name));
  for (const registration of registrations) {
    if (registration.origin !== "builtin") continue;
    if (!expectedNames.has(registration.name)) {
      throw new Error(`${assembly} 装配注册了未登记工具: ${registration.name}`);
    }
    const policy = toolPolicy(registration.name);
    if (registration.danger !== policy.danger) {
      throw new Error(
        `${registration.name} danger 与 catalog 不一致: ` +
          `${registration.danger} != ${policy.danger}`,
      );
    }
    if (!sameStrings(registration.scopes, policy.scopes)) {
      throw new Error(
        `${registration.name} scopes 与 catalog 不一致: ` +
          `${JSON.stringify(registration.scopes)} != ${JSON.stringify(policy.scopes)}`,
      );
    }
    if (registration.scopes.includes("*")) {
      throw new Error(`${registration.name} 禁止使用全局 * scope`);
    }
  }
  if (opts.requireAll === true) {
    const actual = new Set(registrations.map((registration) => registration.name));
    const missing = expected.filter((policy) => !actual.has(policy.name)).map((policy) => policy.name);
    if (missing.length > 0) throw new Error(`${assembly} 装配缺少工具: ${missing.join("、")}`);
  }
}
