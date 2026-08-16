/**
 * 设置页后端 —— 网关/模型/预算配置 + 环境镜像（只读）。**全部仅管理员**。
 * 移植自 `src/ontocopilot/configapi.py`。
 *
 * 只读侧沿用 `/api/health` 的"安全回显"套路：密钥永远 redacted，DATABASE_URL 的
 * 口令段也抹掉。写入侧把改动落进 `app_setting`，经 {@link appconfig} 热应用到新 Run。
 *
 * BASIC 范围：只暴露 base_url / api_key（只写）/ 各档模型选择 / 预算上限。评委、
 * effort、迭代轮数保持代码默认，UI 不碰 —— effort 由服务端按能力派生（见 llm）。
 *
 * ── 分叉：`kernel/catalog.ts` 还没落地 ─────────────────────────────────────
 *
 * `ModelCatalog` 归目录那一段。这里按调用面收成 {@link ConfigCatalog} 注入，缺席时
 * 用一份**空目录**：各档仍能报出默认模型（`gatewayRouting` 本来就接受 null 目录），
 * `catalog: []`，而 PUT 里"模型必须在目录中"那条校验会拒掉一切覆盖 —— 这是**故意**
 * 的 fail-closed：宁可让管理员看到"模型不在目录中"，也不能把一个查不到的模型名
 * 写进设置、下一次 Run 才在网关那边 400。目录段落地后调
 * {@link registerConfigCatalog} 即可。
 */

import { Hono } from "hono";

import * as appconfig from "./appconfig.js";
import { httpError, requireAdmin } from "./authgate.js";
import type { AuthEnv, RepoGetter } from "./authgate.js";
import { defaultRepoGetter } from "./authgate.js";
import * as gatewayBalance from "./kernel/gateway_balance.js";
import { Difficulty } from "./kernel/dag.js";
import { gatewayRouting } from "./kernel/llm.js";
import type { CatalogLike } from "./kernel/llm.js";
import type { JsonValue } from "./store/types.js";

const TIER_DIFF: Readonly<Record<string, Difficulty>> = {
  low: Difficulty.LOW,
  medium: Difficulty.MEDIUM,
  high: Difficulty.HIGH,
  critical: Difficulty.CRITICAL,
};

// ══════════════════════════════════════════════════════════════════
//  模型目录的接线点（见文件头的分叉说明）
// ══════════════════════════════════════════════════════════════════

/** 这一段真正用到的那一小块目录能力。 */
export interface ConfigCatalog extends CatalogLike {
  names(): string[];
  describe(): Record<string, unknown>[];
}

const EMPTY_CATALOG: ConfigCatalog = {
  get: () => null,
  names: () => [],
  describe: () => [],
};

let _newCatalog: () => ConfigCatalog = () => EMPTY_CATALOG;

/** `kernel/catalog.ts` 落地后调一次；传 null 恢复空目录。 */
export function registerConfigCatalog(fn: (() => ConfigCatalog) | null): void {
  _newCatalog = fn ?? (() => EMPTY_CATALOG);
}

// ══════════════════════════════════════════════════════════════════
//  安全回显
// ══════════════════════════════════════════════════════════════════

function redactSecret(v: string): string {
  if (!v) return "";
  // Python 的 `v[:6]` / `v[-4:]` 是按码点切；密钥通常是 ASCII，但别人也可能
  // 粘进来一串带中文的东西，切半个字符会让回显变成乱码
  const cp = [...v];
  return cp.length > 12 ? `${cp.slice(0, 6).join("")}…${cp.slice(-4).join("")}` : "…";
}

/** RFC 3986 的那条正则，对应 Python 的 `urlsplit`。 */
const URL_RE = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

/** 抹掉连接串里的口令段 —— 绝不把 DB 口令发给浏览器。 */
export function redactDbUrl(url: string): string {
  if (!url) return "";
  const m = URL_RE.exec(url);
  if (m === null) return "***"; // 对应 Python `except ValueError: return "***"`
  const [, scheme = "", netloc = "", path = "", query, fragment] = m;
  // `netloc.rpartition("@")` 取 userinfo，再 `partition(":")` 取 password
  const at = netloc.lastIndexOf("@");
  if (at < 0) return url;
  const userinfo = netloc.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon < 0) return url; // 没有口令段
  const password = userinfo.slice(colon + 1);
  if (!password) return url; // Python 的 `if p.password:`：空口令视为没有
  const masked = netloc.replace(`:${password}@`, ":***@");
  // urlunsplit：netloc 非空 → 一定走 `//` 分支
  let out = `//${masked}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  if (scheme) out = `${scheme}:${out}`;
  if (query) out += `?${query}`;
  if (fragment) out += `#${fragment}`;
  return out;
}

/** `(变量名, 是否密钥, 是否需重启)`。这里一律**只读展示**。 */
const ENV_MIRROR: ReadonlyArray<readonly [string, boolean, boolean]> = [
  ["CUSTOM_LLM_BASE_URL", false, false],
  ["CUSTOM_LLM_API_KEY", true, false],
  ["DATABASE_URL", true, true],
  ["ONTOCOPILOT_WORKSPACE", false, true],
  ["ONTOCOPILOT_NO_DB", false, true],
  ["ONTOCOPILOT_AUTH", false, true],
  ["ONTOCOPILOT_COOKIE_SECURE", false, true],
  ["ONTOCOPILOT_SESSION_TTL_HOURS", false, true],
  ["ONTOCOPILOT_CORS_ORIGINS", false, true],
  ["ONTOCOPILOT_USD_CAP", false, false],
  ["ONTOCOPILOT_CHAT_USD_CAP", false, false],
];

function envView(): Record<string, unknown>[] {
  return ENV_MIRROR.map(([name, secret, restart]) => {
    const raw = process.env[name] ?? "";
    const value = name === "DATABASE_URL" ? redactDbUrl(raw) : secret ? redactSecret(raw) : raw;
    return { name, value, set: Boolean(raw), secret, restart };
  });
}

/** 当前生效的网关 base / 密钥（设置 → 环境，与 appconfig 同一优先级）。 */
function gatewayCreds(): [string, string] {
  const base = pyStr(appconfig.get(appconfig.GATEWAY_BASE_URL), process.env["CUSTOM_LLM_BASE_URL"])
    .replace(/\/+$/, "");
  const key = pyStr(appconfig.get(appconfig.GATEWAY_API_KEY), process.env["CUSTOM_LLM_API_KEY"]);
  return [base, key];
}

/** `str(a or b)`，b 缺省是空串。 */
function pyStr(a: JsonValue | undefined, b: string | undefined): string {
  const truthy =
    a !== undefined && a !== null && a !== false && a !== 0 && a !== "" &&
    !(Array.isArray(a) && a.length === 0);
  if (truthy) return typeof a === "string" ? a : JSON.stringify(a);
  return b ?? "";
}

/**
 * 设置页那次探测的秒数上限。比默认的 5s 短：这是一次点击的等待时间，而余额只是
 * 页面上的一行字 —— 宁可显示"未知"，也不要让设置页转圈。
 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * 余额一行。**任何失败都渲染成「未知」**（铁律 C1 / C5）：网关没有余额接口
 * 是常态，绝不能让设置页因此报错，更不能把"查不到"说成"余额不足"。
 */
export async function balanceView(): Promise<gatewayBalance.BalanceDict> {
  const [base, key] = gatewayCreds();
  try {
    const bal = await gatewayBalance.cachedBalance(base, key, { timeoutMs: PROBE_TIMEOUT_MS });
    return gatewayBalance.balanceToDict(bal);
  } catch {
    // 探测不是设置页的必要条件
    return gatewayBalance.balanceToDict(gatewayBalance.makeBalance());
  }
}

export function snapshot(): Record<string, unknown> {
  const cat = _newCatalog();
  const overrides = appconfig.modelOverrides();
  const routing = gatewayRouting(overrides, cat);
  const defaults = gatewayRouting(null, cat);
  const tiers: Record<string, unknown> = {};
  for (const [key, diff] of Object.entries(TIER_DIFF)) {
    const spec = routing.modelFor(diff);
    tiers[key] = {
      model: spec.name,
      effort: spec.effort,
      overridden: key in overrides,
      default: defaults.modelFor(diff).name,
    };
  }
  const [base, rawKey] = gatewayCreds();
  return {
    gateway: {
      base_url: base,
      api_key: redactSecret(rawKey),
      key_set: Boolean(rawKey),
      insecure: base.startsWith("http://"),
    },
    tiers,
    catalog: cat.describe(),
    budget: { usd_cap: appconfig.usdCap(), chat_usd_cap: appconfig.chatUsdCap() },
    env: envView(),
  };
}

// ══════════════════════════════════════════════════════════════════
//  路由
// ══════════════════════════════════════════════════════════════════

/** FastAPI 的 `body: dict`。不是 JSON 对象就当空 dict —— 与那边 `body or {}` 同形。 */
async function readBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw httpError(422, "请求体必须是 JSON 对象");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(422, "请求体必须是 JSON 对象");
  }
  return raw as Record<string, unknown>;
}

/** Python 的 `float(body[field])`，坏值抛 400。 */
function bodyFloat(v: unknown, field: string): number {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "boolean"
        ? (v ? 1 : 0)
        : typeof v === "string" && v.trim() !== ""
          ? Number(v.trim())
          : NaN;
  if (!Number.isFinite(n)) throw httpError(400, `${field} 必须是数字`);
  return n;
}

/**
 * 对应 `router = APIRouter(prefix="/api/config", dependencies=[Depends(require_admin)])`。
 * 那个 router 级依赖在这里是一条 `use()` 中间件 —— 每条路由自己判会漏掉新加的那条。
 */
export function configRouter(repoOf: RepoGetter = defaultRepoGetter): Hono<AuthEnv> {
  const r = new Hono<AuthEnv>();

  r.use("/api/config", (c, next) => {
    requireAdmin(c);
    return next();
  });

  r.get("/api/config", async (c) => {
    // 按需查，**不在 lifespan 里查**：启动依赖外部网络就成了"网关不通 → 服务起不来"。
    return c.json({ ...snapshot(), balance: await balanceView() });
  });

  r.put("/api/config", async (c) => {
    const body = await readBody(c);
    const updates: Record<string, JsonValue | null> = {};
    const catNames = new Set(_newCatalog().names());

    if ("base_url" in body) {
      const raw = body["base_url"];
      const base = (raw === null || raw === undefined || raw === false || raw === 0 || raw === ""
        ? ""
        : String(raw)
      )
        .trim()
        .replace(/\/+$/, "");
      if (!base) throw httpError(400, "base_url 不能为空");
      updates[appconfig.GATEWAY_BASE_URL] = base;
    }

    if ("api_key" in body) {
      const raw = body["api_key"];
      const key =
        raw === null || raw === undefined || raw === false || raw === 0 || raw === ""
          ? ""
          : String(raw);
      // 只写不回显：空串 / 含省略号（那是回显值）一律视为"保持不变"，绝不把
      // redacted 占位符当成真值写回去。
      if (key && !key.includes("…")) updates[appconfig.GATEWAY_API_KEY] = key;
    }

    const models = body["models"];
    if (models !== null && typeof models === "object" && !Array.isArray(models)) {
      for (const [tier, raw] of Object.entries(models as Record<string, unknown>)) {
        if (!(tier in TIER_DIFF)) throw httpError(400, `未知难度档：${tier}`);
        const name = (raw === null || raw === undefined || raw === false || raw === 0 || raw === ""
          ? ""
          : String(raw)
        ).trim();
        if (!name) {
          updates[`gateway.model.${tier}`] = null; // 清覆盖 → 回默认
        } else if (catNames.has(name)) {
          updates[`gateway.model.${tier}`] = name;
        } else {
          throw httpError(400, `模型不在目录中：${name}`);
        }
      }
    }

    for (const [field, skey] of [
      ["usd_cap", appconfig.BUDGET_USD_CAP],
      ["chat_usd_cap", appconfig.BUDGET_CHAT_USD_CAP],
    ] as const) {
      if (field in body) {
        const v = bodyFloat(body[field], field);
        if (v <= 0) throw httpError(400, `${field} 必须大于 0`);
        updates[skey] = v;
      }
    }

    await appconfig.apply(repoOf(), updates);
    // 换了 base/密钥还显示上一个账户的余额是纯误导 —— 存完就把缓存清掉再探一次。
    gatewayBalance.invalidateCache();
    return c.json({ ...snapshot(), balance: await balanceView() });
  });

  return r;
}
