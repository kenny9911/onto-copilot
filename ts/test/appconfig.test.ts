/**
 * `appconfig.ts` + `configapi.ts` + `serve.ts` —— 对着 `golden/appconfig.json` 跑，
 * 最后真起一个监听 socket 打 `/api/health`。
 *
 * 这三个文件是"配置"这条链的三段：从哪读（appconfig）、怎么给设置页（configapi）、
 * 谁把它们装起来（serve）。golden 钉的是前两段的**边角**，因为那里每一条都有一个
 * 看起来很像却不等价的 TS 写法：`Number("")` 是 0 而 `float("")` 抛错（0 上限
 * 意味着服务直接不干活）、`new URL().password` 与 `urlsplit().password` 对
 * `postgresql+asyncpg://` 的处理不同、redacted 的密钥不能被当成真值写回去。
 *
 * 最后那条起进程的用例是这一轮唯一能证明"整套东西真的能起来"的地方：
 * 真装配、真跑 lifespan、真监听端口、真发一次 HTTP。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import * as appconfig from "../src/appconfig.js";
import {
  balanceView,
  configRouter,
  redactDbUrl,
  registerConfigCatalog,
  snapshot,
  imageCatalogCacheReset,
  imageCatalogView,
} from "../src/configapi.js";
import type { ConfigCatalog } from "../src/configapi.js";
import { SYNTHETIC_ADMIN } from "../src/authgate.js";
import type { AuthEnv } from "../src/authgate.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import type { Repo } from "../src/store/repo/protocol.js";
import type { JsonValue } from "../src/store/types.js";
import { buildRepo, parseArgs, startServer } from "../src/serve.js";
import { Store } from "../src/store/engine.js";
import { PgRepo } from "../src/store/repo/pg.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(
  readFileSync(join(HERE, "..", "..", "golden", "appconfig.json"), "utf8"),
) as Golden;

interface Golden {
  redact_secret: [string, string][];
  redact_db_url: [string, string][];
  num: { cached: JsonValue | null; env: string; usd_cap: number | string }[];
  defaults: { usd_cap: number; chat_usd_cap: number };
  model_overrides: { cache: Record<string, JsonValue>; out: Record<string, string> }[];
  resolved_llm_config: {
    cache: Record<string, JsonValue>;
    env: Record<string, string>;
    out: Record<string, unknown>;
  }[];
  env_view: Record<string, unknown>[];
  gateway_creds: [string, string];
  snapshot: Record<string, unknown>;
  snapshot_catalog: unknown[];
  snapshot_from_db: Record<string, unknown>;
  balance_when_probe_fails: Record<string, unknown>;
}

/** golden 里 inf/nan 存的是字符串（裸的 `Infinity` 不是合法 JSON）。 */
function unjson(v: number | string): number {
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  if (v === "NaN") return NaN;
  return v as number;
}

/** 铺一份**完全确定**的环境：不继承跑测试那台机器上的 .env。 */
const OWNED = /^(CUSTOM_LLM|ONTOCOPILOT_|DATABASE_URL)/;
let SAVED: Record<string, string | undefined> = {};

function withEnv(env: Readonly<Record<string, string>>): void {
  for (const k of Object.keys(process.env)) {
    if (OWNED.test(k)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v !== "") process.env[k] = v;
  }
}

beforeEach(() => {
  SAVED = {};
  for (const k of Object.keys(process.env)) {
    if (OWNED.test(k)) SAVED[k] = process.env[k];
  }
  withEnv({});
  appconfig.setCacheForTests({});
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (OWNED.test(k)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(SAVED)) {
    if (v !== undefined) process.env[k] = v;
  }
  appconfig.setCacheForTests({});
  registerConfigCatalog(null);
});

// ══════════════════════════════════════════════════════════════════
//  appconfig
// ══════════════════════════════════════════════════════════════════
describe("appconfig", () => {
  it("预算上限：设置 → 环境 → 默认，逐格与 Python 一致", () => {
    for (const c of G.num) {
      withEnv({ ONTOCOPILOT_USD_CAP: c.env });
      appconfig.setCacheForTests(c.cached === null ? {} : { "budget.usd_cap": c.cached });
      const want = unjson(c.usd_cap);
      const got = appconfig.usdCap();
      if (Number.isNaN(want)) expect(Number.isNaN(got)).toBe(true);
      else expect([c.cached, c.env, got]).toEqual([c.cached, c.env, want]);
    }
  });

  it('`float("")` 不是 0 —— 0 上限意味着任何一次调用都超预算', () => {
    withEnv({ ONTOCOPILOT_USD_CAP: "" });
    expect(appconfig.usdCap()).toBe(G.defaults.usd_cap);
    appconfig.setCacheForTests({ "budget.usd_cap": "" });
    expect(appconfig.usdCap()).toBe(G.defaults.usd_cap);
  });

  it("两档默认值", () => {
    expect(appconfig.usdCap()).toBe(G.defaults.usd_cap);
    expect(appconfig.chatUsdCap()).toBe(G.defaults.chat_usd_cap);
  });

  it("Run 三维上限都可配 —— tokens 不许再是唯一调不动的那维", () => {
    withEnv({
      ONTOCOPILOT_RUN_WALLCLOCK_S: "14400",
      ONTOCOPILOT_RUN_TOOL_CALLS: "4000",
      ONTOCOPILOT_RUN_TOKENS: "12000000",
    });
    expect(appconfig.runWallclockS()).toBe(14400);
    expect(appconfig.runToolCalls()).toBe(4000);
    expect(appconfig.runTokens()).toBe(12_000_000);
    withEnv({
      ONTOCOPILOT_RUN_WALLCLOCK_S: "",
      ONTOCOPILOT_RUN_TOOL_CALLS: "",
      ONTOCOPILOT_RUN_TOKENS: "",
    });
    expect(appconfig.runWallclockS()).toBe(3600);
    expect(appconfig.runToolCalls()).toBe(500);
    expect(appconfig.runTokens()).toBe(4_000_000);
  });

  it("模型覆盖只含真配了的档（假值一律不算配）", () => {
    for (const c of G.model_overrides) {
      appconfig.setCacheForTests(c.cache);
      expect([c.cache, appconfig.modelOverrides()]).toEqual([c.cache, c.out]);
    }
  });

  it("网关配置：设置 → 环境 → 抛错（绝不静默换端点）", () => {
    for (const c of G.resolved_llm_config) {
      withEnv(c.env);
      appconfig.setCacheForTests(c.cache);
      if ("error" in c.out) {
        expect(() => appconfig.resolvedLlmConfig()).toThrow(c.out["error"] as string);
      } else {
        const cfg = appconfig.resolvedLlmConfig();
        expect([cfg.baseUrl, cfg.apiKey]).toEqual([c.out["base_url"], c.out["api_key"]]);
      }
    }
  });

  it("refresh 是原子替换；apply 写完再刷", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    await repo.setSetting("budget.usd_cap", 99);
    await repo.setSetting("gateway.model.high", "a/b");
    await appconfig.refresh(repo);
    expect(appconfig.usdCap()).toBe(99);
    expect(appconfig.modelOverrides()).toEqual({ high: "a/b" });

    // null = 删除
    await appconfig.apply(repo, { "gateway.model.high": null, "budget.chat_usd_cap": 2 });
    expect(appconfig.modelOverrides()).toEqual({});
    expect(appconfig.chatUsdCap()).toBe(2);
    expect((await repo.listSettings()).map((r) => r.key).includes("gateway.model.high")).toBe(false);
  });

  /**
   * 「图像」档 —— 和 低/中/高/关键 并排的第五档，但**不进难度路由**：
   * 出图走 images 端点，与 chat completions 不是一条路，也没有 Difficulty 可映射。
   * 所以它有自己的读取口（imageModelOverride），不混进 modelOverrides() ——
   * 混进去会被 gatewayRouting 当成未知难度档。
   */
  it("图像档：gateway.model.image 有自己的读取口，不混进难度路由", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    await repo.setSetting("gateway.model.image", "openai/gpt-image-2, dall-e-3");
    await repo.setSetting("gateway.model.high", "a/b");
    await appconfig.refresh(repo);

    expect(appconfig.imageModelOverride()).toBe("openai/gpt-image-2, dall-e-3");
    // 难度路由的覆盖表里没有 image —— 它不是一个难度
    expect(appconfig.modelOverrides()).toEqual({ high: "a/b" });
  });

  it("图像档：没配就是空串", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    await appconfig.refresh(repo);

    expect(appconfig.imageModelOverride()).toBe("");
  });
});

/**
 * 图像模型的**可选列表** —— 设置页「图像」档下拉的数据源。
 *
 * 聊天目录被 NOT_CHAT_RE 有意挡住图像模型，所以列表只能来自**网关本身**：
 * 打开设置时探测一次 `/v1/models`，按名形筛出出图型号。
 * 探测失败（网关挂了/超时/没配 key）一律回空列表 —— 设置页回落到手填框，
 * 绝不能让设置页因为网关抖一下就打不开。
 */
describe("imageCatalogView", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    imageCatalogCacheReset();
  });

  function fakeGateway(ids: string[]): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  }

  it("从网关名单里筛出出图型号，聊天模型不进列表", async () => {
    withEnv({ CUSTOM_LLM_BASE_URL: "http://gw/v1", CUSTOM_LLM_API_KEY: "k" });
    fakeGateway([
      "openai/gpt-5.4-image-2",
      "google/gemini-3.1-flash-image",
      "google/gemini-3.5-flash",
      "anthropic/claude-opus-4.8",
    ]);

    expect(await imageCatalogView()).toEqual([
      "google/gemini-3.1-flash-image",
      "openai/gpt-5.4-image-2",
    ]);
  });

  it("网关炸了给空列表，不炸设置页", async () => {
    withEnv({ CUSTOM_LLM_BASE_URL: "http://gw/v1", CUSTOM_LLM_API_KEY: "k" });
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;

    expect(await imageCatalogView()).toEqual([]);
  });

  it("没配网关也给空列表", async () => {
    withEnv({});

    expect(await imageCatalogView()).toEqual([]);
  });

  it("60 秒内不重复打网关 —— 设置页每次打开都探测会把网关刷爆", async () => {
    withEnv({ CUSTOM_LLM_BASE_URL: "http://gw/v1", CUSTOM_LLM_API_KEY: "k" });
    let hits = 0;
    globalThis.fetch = (async () => {
      hits += 1;
      return new Response(JSON.stringify({ data: [{ id: "dall-e-3" }] }), { status: 200 });
    }) as typeof fetch;

    await imageCatalogView();
    await imageCatalogView();

    expect(hits).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  configapi：安全回显
// ══════════════════════════════════════════════════════════════════
describe("configapi 的安全回显", () => {
  it("密钥永远 redacted", () => {
    for (const [raw, want] of G.redact_secret) {
      // _redact_secret 是模块私有的，从 snapshot 的出口验
      withEnv(raw === "" ? {} : { CUSTOM_LLM_API_KEY: raw });
      const gw = snapshot()["gateway"] as Record<string, unknown>;
      expect([raw, gw["api_key"]]).toEqual([raw, want]);
      expect(gw["key_set"]).toBe(raw !== "");
    }
  });

  it("DATABASE_URL 的口令段被抹掉 —— 绝不把 DB 口令发给浏览器", () => {
    for (const [raw, want] of G.redact_db_url) {
      expect([raw, redactDbUrl(raw)]).toEqual([raw, want]);
    }
  });

  it("环境镜像逐项与 Python 一致", () => {
    withEnv(GOLDEN_ENV);
    const env = snapshot()["env"] as Record<string, unknown>[];
    expect(env).toEqual(G.env_view);
    // 口令一个字都不许出现在响应里
    expect(JSON.stringify(env)).not.toContain("s3cr3t");
  });

  it("快照的四段（tiers / budget / gateway / env）与 Python 一致", () => {
    withEnv(GOLDEN_ENV);
    const snap = snapshot();
    delete snap["catalog"]; // ModelCatalog 那一段还没落地，golden 里单列
    expect(snap).toEqual(G.snapshot);
  });

  it("设置页里配的网关盖过 env（http:// 要标成 insecure）", () => {
    withEnv(GOLDEN_ENV);
    appconfig.setCacheForTests({
      "gateway.base_url": "http://insecure.example.com/",
      "gateway.api_key": "sk-in-db-1234567890",
    });
    const snap = snapshot();
    delete snap["catalog"];
    expect(snap).toEqual(G.snapshot_from_db);
    expect((snap["gateway"] as Record<string, unknown>)["insecure"]).toBe(true);
  });

  it("查不到余额是常态：渲染成「未知」，不报错、更不说「余额不足」", async () => {
    // 没配网关 → 探测函数直接返回未知，不发网络请求
    expect(await balanceView()).toEqual(G.balance_when_probe_fails);
    expect(JSON.stringify(await balanceView())).not.toContain("不足");
  });
});

const GOLDEN_ENV: Record<string, string> = {
  CUSTOM_LLM_BASE_URL: "https://gw.example.com/v1/",
  CUSTOM_LLM_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz",
  DATABASE_URL: "postgresql+asyncpg://oc:s3cr3t@db.internal:5432/onto?sslmode=require",
  ONTOCOPILOT_WORKSPACE: "/data/workspace",
  ONTOCOPILOT_AUTH: "1",
  ONTOCOPILOT_SESSION_TTL_HOURS: "72",
  ONTOCOPILOT_CORS_ORIGINS: "https://a.example.com,https://b.example.com",
  ONTOCOPILOT_USD_CAP: "25",
  ONTOCOPILOT_CHAT_USD_CAP: "4.5",
};

// ══════════════════════════════════════════════════════════════════
//  configapi：路由
// ══════════════════════════════════════════════════════════════════

/** 把 configRouter 挂进一个只做"注入当前用户"的壳里。 */
function testApp(repo: Repo, user: unknown = SYNTHETIC_ADMIN): Hono<AuthEnv> {
  const t = new Hono<AuthEnv>();
  t.use("*", (c, next) => {
    c.set("user", user as never);
    return next();
  });
  t.route("/", configRouter(() => repo));
  return t;
}

const CATALOG: ConfigCatalog = {
  get: (name) => (name === "a/b" || name === "c/d" ? { spec: { effort: null } as never } : null),
  names: () => ["a/b", "c/d"],
  describe: () => [{ name: "a/b" }, { name: "c/d" }],
};

describe("/api/config", () => {
  it("仅管理员", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    const res = await testApp(repo, { ...SYNTHETIC_ADMIN, role: "user" }).request("/api/config");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "需要管理员权限" });
  });

  it("GET 回快照 + 余额（余额未知也是 200）", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    const res = await testApp(repo).request("/api/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      // image_catalog：「图像」档下拉的数据源（网关探测，失败为空数组）
      ["balance", "budget", "catalog", "env", "gateway", "image_catalog", "tiers"].sort(),
    );
    expect(body["balance"]).toEqual({ known: false });
    expect(body["image_catalog"]).toEqual([]);
  });

  it("PUT 存 base_url / api_key / 预算，并热应用到缓存", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    const res = await testApp(repo).request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        base_url: "https://gw.example.com/v1//",
        api_key: "sk-real-key-0123456789",
        usd_cap: 12.5,
        chat_usd_cap: "2",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    // 尾斜杠被剥掉；密钥只写不回显
    expect(body["gateway"]!["base_url"]).toBe("https://gw.example.com/v1");
    expect(body["gateway"]!["api_key"]).toBe("sk-rea…6789");
    expect(body["budget"]).toEqual({ usd_cap: 12.5, chat_usd_cap: 2 });
    expect(appconfig.usdCap()).toBe(12.5);
    expect(appconfig.get("gateway.api_key")).toBe("sk-real-key-0123456789");
  });

  it("回显值（含省略号）不会被当成真密钥写回去", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    await appconfig.apply(repo, { "gateway.api_key": "sk-real-key-0123456789" });
    for (const api_key of ["sk-rea…6789", ""]) {
      const res = await testApp(repo).request("/api/config", {
        method: "PUT",
        body: JSON.stringify({ api_key }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(appconfig.get("gateway.api_key")).toBe("sk-real-key-0123456789");
    }
  });

  it("空 base_url / 非数字预算 / 非正预算 / 未知难度档一律 400", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    const put = async (body: unknown): Promise<[number, unknown]> => {
      const res = await testApp(repo).request("/api/config", {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      return [res.status, await res.json()];
    };
    expect(await put({ base_url: "  " })).toEqual([400, { detail: "base_url 不能为空" }]);
    expect(await put({ usd_cap: "abc" })).toEqual([400, { detail: "usd_cap 必须是数字" }]);
    expect(await put({ usd_cap: 0 })).toEqual([400, { detail: "usd_cap 必须大于 0" }]);
    expect(await put({ chat_usd_cap: -1 })).toEqual([400, { detail: "chat_usd_cap 必须大于 0" }]);
    expect(await put({ models: { nope: "a/b" } })).toEqual([400, { detail: "未知难度档：nope" }]);
    // 一条都没写进去
    expect((await repo.listSettings()).length).toBe(0);
  });

  /**
   * 「图像」档 —— 设置页模型分级的第五行。
   * 存储键同形（gateway.model.image）、校验同规（候选必须在目录里）、
   * 但它不进难度路由，snapshot 里单独一行（没有 effort，default 来自
   * 目录里第一个带出图能力的模型）。
   */
  it("图像档：保存、校验、清空、快照，一套走全", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    registerConfigCatalog(() => CATALOG);
    const app = testApp(repo);
    const put = async (body: unknown) => {
      const res = await app.request("/api/config", {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      return [res.status, (await res.json()) as Record<string, unknown>] as const;
    };

    // 把聊天模型误填进图像档 → 保存那一刻打回（不是运行时 images 端点 400）。
    // 图像档不查聊天目录：图像模型被 NOT_CHAT_RE 有意挡在目录外，查了永远打回。
    const [badStatus, badBody] = await put({ models: { image: "a/b" } });
    expect(badStatus).toBe(400);
    expect(String((badBody as { detail?: unknown })["detail"])).toMatch(/不是图像模型：a\/b/u);

    // 合法候选串（顿号也认）→ 落库 + 快照回显
    const [okStatus, okBody] = await put({ models: { image: " openai/gpt-image-2 、 dall-e-3 " } });
    expect(okStatus).toBe(200);
    expect(appconfig.imageModelOverride()).toBe("openai/gpt-image-2, dall-e-3");
    const imageTier = (okBody["tiers"] as Record<string, Record<string, unknown>>)["image"]!;
    expect(imageTier["model"]).toBe("openai/gpt-image-2");
    expect(imageTier["overridden"]).toBe(true);
    expect(imageTier["candidates"]).toBe("openai/gpt-image-2, dall-e-3");

    // 空串 = 清覆盖
    const [clrStatus, clrBody] = await put({ models: { image: "" } });
    expect(clrStatus).toBe(200);
    expect(appconfig.imageModelOverride()).toBe("");
    const cleared = (clrBody["tiers"] as Record<string, Record<string, unknown>>)["image"]!;
    expect(cleared["overridden"]).toBe(false);
    // 测试目录里没有带出图能力的模型 → default 是 null，如实说"没有"
    expect(cleared["model"]).toBeNull();
    expect(cleared["default"]).toBeNull();
  });

  it("模型必须在目录里；空串是「清覆盖」", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    registerConfigCatalog(() => CATALOG);
    const app = testApp(repo);
    const bad = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { low: "查无此模型" } }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "模型不在目录中：查无此模型" });

    const ok = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { low: "a/b" } }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    expect(appconfig.modelOverrides()).toEqual({ low: "a/b" });
    const tiers = ((await ok.json()) as Record<string, Record<string, Record<string, unknown>>>)[
      "tiers"
    ]!;
    expect(tiers["low"]!["model"]).toBe("a/b");
    expect(tiers["low"]!["overridden"]).toBe(true);

    await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { low: "" } }),
      headers: { "content-type": "application/json" },
    });
    expect(appconfig.modelOverrides()).toEqual({});
  });

  it("一档可配多候选（逗号/顿号分隔），逐个校验、存归一化串", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    registerConfigCatalog(() => CATALOG);
    const app = testApp(repo);
    const ok = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { high: " a/b 、 c/d " } }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    expect(appconfig.modelOverrides()).toEqual({ high: "a/b, c/d" });
    const tiers = ((await ok.json()) as Record<string, Record<string, Record<string, unknown>>>)[
      "tiers"
    ]!;
    expect(tiers["high"]!["candidates"]).toBe("a/b, c/d");
    expect(tiers["high"]!["model"]).toBe("a/b"); // 第一候选在目录 → 生效的是它

    const bad = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { high: "a/b, 查无此模型" } }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: "模型不在目录中：查无此模型" });
  });

  it("目录还没接线时一律拒绝覆盖（fail closed，不写一个查不到的模型名）", async () => {
    const repo = new MemoryRepo() as unknown as Repo;
    const res = await testApp(repo).request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { low: "a/b" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
//  serve
// ══════════════════════════════════════════════════════════════════
describe("serve", () => {
  it("argparse 的那一小块", () => {
    // 显式清掉环境：默认值现在取自 ONTOCOPILOT_PORT/HOST，开发机上恰好设了的话
    // 这条断言会莫名其妙地红，而红的原因跟被测代码无关。
    delete process.env["ONTOCOPILOT_PORT"];
    delete process.env["ONTOCOPILOT_HOST"];
    // 这里写死字面量而不是引 DEFAULT_PORT：默认端口是**对外承诺**，
    // 跟着常量走的话改常量就永远测不红。
    expect(parseArgs([])).toEqual({ host: "127.0.0.1", port: 3594, reload: false });
    expect(parseArgs(["--host", "0.0.0.0", "--port", "9000", "--reload"])).toEqual({
      host: "0.0.0.0",
      port: 9000,
      reload: true,
    });
    expect(parseArgs(["--port=1234"]).port).toBe(1234);
    // `type=int` 解析不出来要报错，不是悄悄用默认值
    expect(() => parseArgs(["--port", "abc"])).toThrow("invalid int value");
    expect(() => parseArgs(["--nope"])).toThrow("unrecognized arguments");
    expect(() => parseArgs(["--port"])).toThrow("expected one argument");
  });

  // 端口以前只能靠命令行传，于是同一台机器上并存好几个实例、各用各的端口，
  // 排查时反复在验证一个没人用的旧进程。钉死在 .env 里，"启动"只有一种结果。
  describe("端口默认值取自环境", () => {
    const saved = { p: process.env["ONTOCOPILOT_PORT"], h: process.env["ONTOCOPILOT_HOST"] };
    afterEach(() => {
      for (const [k, v] of [["ONTOCOPILOT_PORT", saved.p], ["ONTOCOPILOT_HOST", saved.h]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("ONTOCOPILOT_PORT / HOST 顶掉内置默认值", () => {
      process.env["ONTOCOPILOT_PORT"] = "8765";
      process.env["ONTOCOPILOT_HOST"] = "0.0.0.0";
      expect(parseArgs([])).toEqual({ host: "0.0.0.0", port: 8765, reload: false });
    });

    it("命令行显式传的优先于环境 —— 临时起第二个实例时要能压过去", () => {
      process.env["ONTOCOPILOT_PORT"] = "8765";
      expect(parseArgs(["--port", "9001"]).port).toBe(9001);
    });

    it("环境里写歪了退回 3594，不抛 —— .env 打错字不该让服务起不来", () => {
      for (const bad of ["abc", "", "0", "70000", "-1", "80 80"]) {
        process.env["ONTOCOPILOT_PORT"] = bad;
        expect(parseArgs([]).port, bad).toBe(3594);
      }
      // 但显式 --port 写歪了仍然报错：那是 argparse 的语义，两者不是一回事。
      process.env["ONTOCOPILOT_PORT"] = "8765";
      expect(() => parseArgs(["--port", "abc"])).toThrow("invalid int value");
    });
  });

  it("buildRepo 是唯一的选路点：没引擎走内存，有引擎走 PgRepo", async () => {
    const mem = await Store.open("");
    expect(buildRepo(mem)).toBeInstanceOf(MemoryRepo);
    const sqlite = await Store.open("sqlite+aiosqlite:///:memory:", { createAll: true });
    try {
      expect(buildRepo(sqlite)).toBeInstanceOf(PgRepo); // 同一个实现，方言由引擎带
    } finally {
      await sqlite.close();
    }
  });

  it("真起一个监听端口，打 /api/health", async () => {
    withEnv({
      ONTOCOPILOT_NO_DB: "1", // 纯内存：这条用例不该在磁盘上留下一个库
      ONTOCOPILOT_WORKSPACE: mkdtempSync(join(tmpdir(), "oc-serve-")),
      CUSTOM_LLM_BASE_URL: "https://gw.example.com/v1",
      CUSTOM_LLM_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz",
    });
    // port 0 = 让内核挑一个空闲端口，跑测试时不会撞上别人
    const server = await startServer({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, Record<string, unknown>>;
      // 网关配置解析得出来 → ok:true，且回显的 key 必须是脱敏后的那一个
      expect(body["ok"]).toBe(true);
      expect(body["gateway"]!["base_url"]).toBe("https://gw.example.com/v1");
      expect(String(body["gateway"]!["key"])).toContain("…");
      expect(String(body["gateway"]!["key"])).not.toContain("klmnop");
      // 库真的起来了（内存模式是**受支持的模式**，不是故障）
      expect(body["database"]!["mode"]).toBe("memory");
      expect(body["database"]!["ok"]).toBe(true);
      // 模型目录也接上了（这一份是**未经过滤**的内置目录，不打网关就有）
      expect((body["models"] as unknown as unknown[]).length).toBeGreaterThan(0);
      expect(Object.keys(body["capabilities"]!).length).toBeGreaterThan(0);

      // 前端外壳也在同一个进程上
      const ui = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(ui.status).toBe(200);
      expect(ui.headers.get("cache-control")).toContain("no-store");

      // /api/config 走的是同一套装配（开放模式下的合成管理员放行）
      const cfg = await fetch(`http://127.0.0.1:${server.port}/api/config`);
      expect(cfg.status).toBe(200);
      expect(Object.keys((await cfg.json()) as object)).toContain("tiers");
    } finally {
      await server.close();
    }
  }, 30_000);
});
