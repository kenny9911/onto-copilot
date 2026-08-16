/**
 * 运行时配置提供者 —— DB 覆盖优先于环境变量，热应用到**新** Run。
 * 移植自 `src/ontocopilot/appconfig.py`。
 *
 * 线上 `gateways()` 每个 Run 都新建一次网关（`server/usage.ts`），所以只要它读这里的
 * 缓存，管理员在设置页改的网关/模型/预算就会自动作用到下一次 Run，无需重启进程。
 *
 * **缓存原子替换**：后台流水线不在请求作用域里、会在两次 await 之间读缓存；所以
 * {@link refresh} 先构好新 Map、再一次性重绑模块级变量，读者永远看到的是"旧的
 * 一整份"或"新的一整份"，不会撞上半更新态。
 *
 * **不静默降级**：{@link resolvedLlmConfig} 自己做 DB→env→抛错，绝不回落到会抛错的
 * `llmConfig()` 作基线 —— 那样纯 UI 配置（env 里没写 key）就用不了了。
 *
 * 接线：进程启动时调一次 {@link installAppConfig}，把它装进 `server/usage.ts` 的
 * {@link registerAppConfig} 注册点（那边的默认实现是 env-only 分支）。
 */

import { makeLLMConfig } from "./kernel/config.js";
import type { LLMConfig } from "./kernel/config.js";
import { pyRepr } from "./kernel/errors.js";
import { registerAppConfig } from "./server/usage.js";
import type { AppConfigPort } from "./server/usage.js";
import type { Repo } from "./store/repo/protocol.js";
import type { JsonValue } from "./store/types.js";

/**
 * 进程级设置缓存。**只整体重绑，不原地改**（见模块头）。
 *
 * 用 Map 而不是普通对象：设置键理论上可以是任何字符串，而 JS 的普通对象会把
 * 「看起来像整数」的键排到前面 —— `listSettings()` 的顺序会静默漂移。
 */
let _CACHE: ReadonlyMap<string, JsonValue> = new Map();

/** 会通过设置页读写的键。 */
export const GATEWAY_BASE_URL = "gateway.base_url";
export const GATEWAY_API_KEY = "gateway.api_key";
export const BUDGET_USD_CAP = "budget.usd_cap";
export const BUDGET_CHAT_USD_CAP = "budget.chat_usd_cap";
const TIERS = ["low", "medium", "high", "critical"] as const;

/** 从仓储重新载入设置缓存（原子替换）。 */
export async function refresh(repo: Repo): Promise<void> {
  const rows = await repo.listSettings();
  const next = new Map<string, JsonValue>();
  for (const r of rows) next.set(r.key, r.value);
  _CACHE = next; // 一次性重绑：读者要么看到旧的一整份，要么看到新的一整份
}

export function get(key: string, dflt: JsonValue | undefined = undefined): JsonValue | undefined {
  const v = _CACHE.get(key);
  return v === undefined ? dflt : v;
}

/** 只给测试用：直接铺一份缓存（等价于 refresh 之后的状态）。 */
export function setCacheForTests(entries: Readonly<Record<string, JsonValue>>): void {
  _CACHE = new Map(Object.entries(entries));
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/**
 * Python 的 `float(str)`。
 *
 * **不能直接用 `Number()`**：两边在三处不一样，而这三处都会落在"预算上限"上 ——
 *   · `Number("")` 是 0，`float("")` 抛 ValueError（该回默认值 15，不是 0！
 *     0 上限意味着任何一次调用都超预算，服务直接不干活了）；
 *   · `Number("inf")` 是 NaN，`float("inf")` 是无穷（管理员写 inf 是想说"不封顶"）；
 *   · `Number("1_0")` 是 NaN，`float("1_0")` 是 10。
 */
function pyFloat(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (m !== null) {
    if (m[2]!.toLowerCase() === "nan") return NaN;
    return m[1] === "-" ? -Infinity : Infinity;
  }
  // 下划线只能夹在数字之间；先校验形状再抹掉
  if (/_/.test(t) && !/^[+-]?(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(t)) {
    return null;
  }
  const clean = t.replace(/_/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(clean)) return null;
  return Number(clean);
}

/** `float(v)` 对缓存里那几种 JSON 值的行为；不可转换（含 list/dict）回 null。 */
function pyFloatValue(v: JsonValue | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return pyFloat(v);
  return null; // list / dict → TypeError → 走 env
}

/** Python 的真值语义（`if v:`）。`0` / `""` / `false` / 空容器都是假。 */
function pyTruthy(v: JsonValue | undefined): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(v)`：`None` → `"None"`、`True` → `"True"`（缓存里可能是任何 JSON 值）。 */
function pyStr(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

// ══════════════════════════════════════════════════════════════════
//  各项设置
// ══════════════════════════════════════════════════════════════════

function num(key: string, env: string, dflt: number): number {
  const v = _CACHE.get(key);
  if (v !== undefined && v !== null) {
    const f = pyFloatValue(v);
    if (f !== null) return f;
    // 转不动就当没配，往下落到 env —— 与 Python 的 `except (TypeError, ValueError): pass`
  }
  const raw = process.env[env] ?? "";
  // Python 是 `float(os.getenv(env, "") or default)`：空串落默认值，坏值抛错也落默认值
  if (raw === "") return dflt;
  const f = pyFloat(raw);
  return f === null ? dflt : f;
}

export function usdCap(): number {
  return num(BUDGET_USD_CAP, "ONTOCOPILOT_USD_CAP", 15.0);
}

export function chatUsdCap(): number {
  return num(BUDGET_CHAT_USD_CAP, "ONTOCOPILOT_CHAT_USD_CAP", 3.0);
}

/** 各难度档的模型覆盖（只含设置页真正配了的档）。 */
export function modelOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tier of TIERS) {
    const v = _CACHE.get(`gateway.model.${tier}`);
    if (pyTruthy(v)) out[tier] = pyStr(v);
  }
  return out;
}

/**
 * 解析网关 base_url / api_key：设置 → 环境 → 抛错。
 *
 * 两者都没配时抛。和 `kernel/config.ts` 的 `llmConfig()` 同一条纪律：宁可显式失败，
 * 也不静默换端点。
 */
export function resolvedLlmConfig(): LLMConfig {
  const base = pyStr(
    pyTruthy(_CACHE.get(GATEWAY_BASE_URL))
      ? _CACHE.get(GATEWAY_BASE_URL)
      : (process.env["CUSTOM_LLM_BASE_URL"] ?? ""),
  ).replace(/\/+$/, "");
  const key = pyStr(
    pyTruthy(_CACHE.get(GATEWAY_API_KEY))
      ? _CACHE.get(GATEWAY_API_KEY)
      : (process.env["CUSTOM_LLM_API_KEY"] ?? ""),
  );
  const missing: string[] = [];
  if (!base) missing.push(GATEWAY_BASE_URL);
  if (!key) missing.push(GATEWAY_API_KEY);
  if (missing.length > 0) {
    // 消息形态照抄 `f"缺少 LLM 网关配置 {missing}"`（Python 的 list repr）
    throw new Error(
      `缺少 LLM 网关配置 [${missing.map((m) => pyRepr(m)).join(", ")}]：在设置页填写，或写进 .env`,
    );
  }
  return makeLLMConfig(base, key);
}

/** 写入一批设置并刷新缓存。`value` 为 `null` 的键表示删除。 */
export async function apply(
  repo: Repo,
  updates: Readonly<Record<string, JsonValue | null>>,
): Promise<void> {
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) await repo.deleteSetting(k);
    else await repo.setSetting(k, v);
  }
  await refresh(repo);
}

/** 装进 `server/usage.ts` 的注册点。**进程入口调一次**（见 `serve.ts`）。 */
export const APP_CONFIG_PORT: AppConfigPort = {
  resolvedLlmConfig,
  usdCap,
  chatUsdCap,
  modelOverrides,
  refresh,
};

export function installAppConfig(): void {
  registerAppConfig(APP_CONFIG_PORT);
}
