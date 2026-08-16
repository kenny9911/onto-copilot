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
  get: (name) => (name === "a/b" ? { spec: { effort: null } as never } : null),
  names: () => ["a/b"],
  describe: () => [{ name: "a/b" }],
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
      ["balance", "budget", "catalog", "env", "gateway", "tiers"].sort(),
    );
    expect(body["balance"]).toEqual({ known: false });
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
