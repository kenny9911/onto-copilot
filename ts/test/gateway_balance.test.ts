/**
 * gateway_balance 的 golden 校验 —— 「AI 余额不足要能侦查并提醒」的后端。
 *
 * 这一层几乎没有算法，全是**说错话的代价**，所以测试盯着四件事：
 *
 *   1. **铁律 C1：查不到 ≠ 没钱。** 404 / 401 / 登录页 HTML / 连不上 / 超时 ——
 *      每一种都必须收敛成"未知"，而且 `isLow` 对未知永远 false。渲染成"余额不足"
 *      的话，用户会跑去给一个一分钱没欠的账户充值。
 *   2. **铁律 C4：本地上限用满不是欠费。** S3 文案里逐字断言禁用词。
 *   3. **`looksLikeQuotaExhausted` 的两个方向。** 它是 scheduler「一次都不重试」
 *      的唯一依据：判宽了把限流说成欠费，判窄了让用户白等三轮退避再收一句 429。
 *   4. **数字格式化的每一处 Python/JS 分叉。** `$0.12` vs `$0.13` 之类，全部由
 *      golden 逐字节钉住，没有手写期望值。
 *
 * 探测那一节是数据驱动的：假 fetch 直接照 golden 里的 `routes` 造响应，所以
 * TS 侧跑的是 Python 侧真跑过的同一批场景，连**打过哪些路径**都一起断言。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CACHE_TTL_MS,
  LOW_RATIO,
  LOW_USD,
  QUOTA_MARKERS,
  QUOTA_UNIT,
  type Balance,
  type FetchLike,
  balanceHuman,
  balanceKnown,
  balanceToDict,
  budgetCappedText,
  cachedBalance,
  formatFixed2,
  invalidateCache,
  isLow,
  looksLikeQuotaExhausted,
  makeBalance,
  probeBalance,
  quotaExhaustedText,
  quotaLowText,
  siteRoot,
} from "../src/kernel/gateway_balance.js";

// ── golden ────────────────────────────────────────────────────────

interface BalanceKwargs {
  total?: number | null;
  used?: number | null;
  remaining?: number | null;
  currency?: string;
  source?: string;
}

interface RouteSpec {
  status?: number;
  body?: string;
  content_type?: string;
  raise?: "timeout" | "connect" | "protocol";
}

interface Golden {
  consts: { QUOTA_UNIT: string; LOW_USD: number; LOW_RATIO: number; CACHE_TTL: number };
  human: { remaining: number; currency: string; out: string }[];
  human_special: { lit: string; currency: string; out: string }[];
  balances: {
    in: BalanceKwargs;
    known: boolean;
    human: string;
    to_dict: Record<string, unknown>;
    is_low: boolean;
    is_low_strict: boolean;
  }[];
  site_root: { in: string; out: string }[];
  probe: {
    name: string;
    base: string;
    key: string;
    routes: Record<string, RouteSpec>;
    known: boolean;
    out: Record<string, unknown>;
    human: string;
    is_low: boolean;
    seen: string[];
    fields: {
      total: number | null;
      used: number | null;
      remaining: number | null;
      currency: string;
      source: string;
    };
  }[];
  usage_params: {
    keys: string[];
    start_days_before_today: number;
    end_days_after_today: number;
    span_days: number;
  };
  quota_exhausted_text: { detail: string; out: string }[];
  quota_low_text: { in: BalanceKwargs; out: string }[];
  budget_capped_text: { spent: number; cap: number; scope: string; out: string }[];
  looks_like_quota_exhausted: { status: number; body: string; out: boolean }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/gateway_balance.json"), "utf8"),
) as Golden;

const SPECIAL: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };

afterEach(() => {
  invalidateCache();
});

// ══════════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════════
describe("常量", () => {
  it("与 Python 一致（CACHE_TTL 换算成毫秒）", () => {
    expect(QUOTA_UNIT).toBe(G.consts.QUOTA_UNIT);
    expect(LOW_USD).toBe(G.consts.LOW_USD);
    expect(LOW_RATIO).toBe(G.consts.LOW_RATIO);
    expect(CACHE_TTL_MS).toBe(G.consts.CACHE_TTL * 1000);
  });
});

// ══════════════════════════════════════════════════════════════════
//  数字格式化：用户拿来决定"要不要充值"的那个数
// ══════════════════════════════════════════════════════════════════
describe("human()", () => {
  for (const row of G.human) {
    it(`${row.currency} ${row.remaining} → ${row.out}`, () => {
      expect(balanceHuman(makeBalance({ remaining: row.remaining, currency: row.currency })))
        .toBe(row.out);
    });
  }

  for (const row of G.human_special) {
    it(`${row.currency} ${row.lit} → ${row.out}`, () => {
      const v = SPECIAL[row.lit];
      expect(v).toBeDefined();
      expect(balanceHuman(makeBalance({ remaining: v!, currency: row.currency }))).toBe(row.out);
    });
  }

  it("toFixed(2) 在这些值上是错的 —— 钉住分叉本身，别让谁「简化」回去", () => {
    // 只要有人把 formatFixed2 换成 toFixed，这条就红。
    expect(formatFixed2(0.125)).toBe("0.12");
    expect((0.125).toFixed(2)).toBe("0.13");
    expect(formatFixed2(-0)).toBe("-0.00");
    expect((-0).toFixed(2)).toBe("0.00");
    expect(formatFixed2(1e21)).toBe("1000000000000000000000.00");
    expect((1e21).toFixed(2)).toBe("1e+21");
  });

  it("未知说「未知」，不说 0", () => {
    expect(balanceHuman(makeBalance())).toBe("未知");
    expect(balanceHuman(makeBalance())).not.toContain("0");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Balance / is_low
// ══════════════════════════════════════════════════════════════════
describe("Balance", () => {
  for (const row of G.balances) {
    it(`${JSON.stringify(row.in)} → known=${row.known} low=${row.is_low}`, () => {
      const b = makeBalance(row.in);
      expect(balanceKnown(b)).toBe(row.known);
      expect(balanceHuman(b)).toBe(row.human);
      expect(balanceToDict(b)).toEqual(row.to_dict);
      expect(isLow(b)).toBe(row.is_low);
      expect(isLow(b, { usdFloor: 20.0, ratio: 0.5 })).toBe(row.is_low_strict);
    });
  }

  it("空的就是未知，to_dict 只有一个字段", () => {
    expect(balanceToDict(makeBalance())).toEqual({ known: false });
  });

  it("有总额没用量 = 仍旧不知道还剩多少（别拿总额冒充余额）", () => {
    expect(balanceKnown(makeBalance({ total: 100 }))).toBe(false);
    expect(isLow(makeBalance({ total: 100 }))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  纯函数
// ══════════════════════════════════════════════════════════════════
describe("siteRoot", () => {
  for (const row of G.site_root) {
    it(`${JSON.stringify(row.in)} → ${JSON.stringify(row.out)}`, () => {
      expect(siteRoot(row.in)).toBe(row.out);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  探测：假 fetch 照 golden 的 routes 造响应
// ══════════════════════════════════════════════════════════════════

class FakeGateway {
  readonly seen: string[] = [];
  readonly urls: string[] = [];

  constructor(private readonly routes: Record<string, RouteSpec>) {}

  readonly fetchImpl: FetchLike = async (url, init) => {
    // 每个请求都必须带 signal，否则"整段预算"根本没落地。
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const u = new URL(url);
    this.seen.push(u.pathname);
    this.urls.push(url);
    for (const [suffix, spec] of Object.entries(this.routes)) {
      if (u.pathname.endsWith(suffix)) return respond(spec);
    }
    return respond({ status: 404, body: "not found", content_type: "text/plain" });
  };
}

function respond(spec: RouteSpec): Response {
  if (spec.raise !== undefined) {
    // httpx 的 ReadTimeout / ConnectError / RemoteProtocolError 在 fetch 侧就是
    // 一个被 reject 的 promise —— 类型不同，但对本模块而言都是"这条路不通"。
    throw new TypeError(`fetch failed (${spec.raise})`);
  }
  return new Response(spec.body ?? "", {
    status: spec.status ?? 200,
    headers: { "content-type": spec.content_type ?? "application/json" },
  });
}

describe("探测", () => {
  for (const row of G.probe) {
    it(`${row.name} → ${row.known ? "known" : "未知"}`, async () => {
      const gw = new FakeGateway(row.routes);
      const bal = await probeBalance(row.base, row.key, {
        timeoutMs: 5000,
        fetchImpl: gw.fetchImpl,
      });

      expect(balanceKnown(bal)).toBe(row.known);
      expect(balanceToDict(bal)).toEqual(row.out);
      expect(balanceHuman(bal)).toBe(row.human);
      expect(isLow(bal)).toBe(row.is_low);
      expect({ ...bal }).toEqual(row.fields);
      // 路径要断言：New-API 的用户接口挂在**站点根**，照着 /v1 拼会稳定 404，
      // 而"稳定 404"和"这家网关没这接口"长得一模一样。
      expect(gw.seen).toEqual(row.seen);
    });
  }

  it("usage 端点带的日期窗口 = 今天前 99 天 → 明天", async () => {
    const gw = new FakeGateway({
      "/dashboard/billing/subscription": { body: '{"hard_limit_usd": 20.0}' },
      "/dashboard/billing/usage": { body: '{"total_usage": 1.0}' },
    });
    await probeBalance("http://gw.test/v1", "k", { timeoutMs: 5000, fetchImpl: gw.fetchImpl });

    const q = new URL(gw.urls[1]!).searchParams;
    expect([...q.keys()].sort()).toEqual(G.usage_params.keys);
    const start = q.get("start_date")!;
    const end = q.get("end_date")!;
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 钉窗口宽度而不是具体日期 —— 钉日期的话明天就红了。
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    expect(days).toBe(G.usage_params.span_days);
    const today = new Date().toISOString().slice(0, 10);
    expect((Date.parse(today) - Date.parse(start)) / 86_400_000)
      .toBe(G.usage_params.start_days_before_today);
  });

  it("没配网关就一个请求都不发", async () => {
    for (const [base, key] of [["http://gw.test/v1", ""], ["", "k"], ["", ""], ["  ", "k"]]) {
      const gw = new FakeGateway({ "": { body: '{"hard_limit_usd": 20.0}' } });
      const bal = await probeBalance(base!, key!, { fetchImpl: gw.fetchImpl });
      expect(balanceKnown(bal)).toBe(false);
      expect(gw.seen).toEqual([]);
    }
  });

  it("探测器自己抛也只是「未知」（铁律 C5）", async () => {
    const boom: FetchLike = () => {
      throw new Error("gateway unreachable");
    };
    expect(balanceKnown(await probeBalance("http://gw.test/v1", "k", { fetchImpl: boom })))
      .toBe(false);
  });

  it("响应体是流也读得动（不是所有网关都一次吐完）", async () => {
    const streaming: FetchLike = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":{"qu'));
            c.enqueue(new TextEncoder().encode('ota": 77}}'));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    // 第一个端点会先拿到同一份 body（没有 hard_limit_usd）→ 未知 → 换第二个。
    const bal = await probeBalance("http://gw.test/v1", "k", { fetchImpl: streaming });
    expect(bal.remaining).toBe(77);
    expect(bal.currency).toBe(QUOTA_UNIT);
  });

  it("JSON 里的裸 NaN：Python 收得下、JS 收不下 —— 结论仍是「未知」", async () => {
    // 已知分叉：`json.loads('{"quota": NaN}')` 在 Python 里成功（余额显示成
    // "$nan"），JS 的 JSON.parse 直接抛。抛出来被当成"这条路不通"，收敛到未知 ——
    // 分叉的方向是安全的那一侧，钉住形状而不是绕开。
    const nan: FetchLike = async () =>
      new Response('{"data": {"quota": NaN}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(balanceKnown(await probeBalance("http://gw.test/v1", "k", { fetchImpl: nan })))
      .toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  超时是**整段**的预算
// ══════════════════════════════════════════════════════════════════
describe("超时", () => {
  it("网关吊着连接时，整段探测按 timeoutMs 收口，第二个端点不再发请求", async () => {
    let started = 0;
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        started += 1;
        const sig = init.signal;
        expect(sig).toBeInstanceOf(AbortSignal);
        sig?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const t0 = Date.now();
    const bal = await probeBalance("http://gw.test/v1", "k", {
      timeoutMs: 120,
      fetchImpl: hang,
    });
    const elapsed = Date.now() - t0;

    expect(balanceKnown(bal)).toBe(false); // 超时同样是"未知"，不是"没钱"
    expect(elapsed).toBeLessThan(3000);
    // 预算是整段的：第一个端点把 120ms 吃光后，第二个连请求都不该发。
    expect(started).toBe(1);
  });

  it("AbortSignal.timeout 只收整数 —— 剩余预算带小数必须先取整", async () => {
    // 不取整的话 `ERR_OUT_OF_RANGE` 会在 fetch 之前抛出、被吞掉，症状是所有网关
    // 一律"余额未知"且没有任何日志。这里直接断言传下来的 delay 是合法的。
    let sawSignal = false;
    const check: FetchLike = async (_url, init) => {
      sawSignal = init.signal instanceof AbortSignal;
      return new Response('{"data":{"quota": 5}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    // 小数预算：performance.now() 本来就是浮点，这里只是把条件放到明面上。
    const bal = await probeBalance("http://gw.test/v1", "k", {
      timeoutMs: 1234.5678,
      fetchImpl: check,
    });
    expect(sawSignal).toBe(true);
    expect(bal.remaining).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════
//  缓存
// ══════════════════════════════════════════════════════════════════
describe("缓存", () => {
  function counter(result: Balance) {
    const state = { calls: 0 };
    const probe = async (): Promise<Balance> => {
      state.calls += 1;
      return result;
    };
    return { state, probe };
  }

  it("TTL 内复用，连点设置页不把网关打一遍", async () => {
    const { state, probe } = counter(makeBalance({ total: 20, used: 1, remaining: 19 }));
    for (let i = 0; i < 5; i += 1) {
      expect((await cachedBalance("http://gw.test/v1", "k", { probe })).remaining).toBe(19);
    }
    expect(state.calls).toBe(1);
  });

  it("失败也缓存 —— 网关没这接口时每次都白等一遍超时是最没意义的等待", async () => {
    const { state, probe } = counter(makeBalance());
    expect(balanceKnown(await cachedBalance("http://gw.test/v1", "k", { probe }))).toBe(false);
    expect(balanceKnown(await cachedBalance("http://gw.test/v1", "k", { probe }))).toBe(false);
    expect(state.calls).toBe(1);
  });

  it("按凭据分键：换了账户还拿上一个账户的余额是彻头彻尾的误导", async () => {
    const { state, probe } = counter(makeBalance({ remaining: 1 }));
    await cachedBalance("http://gw.test/v1", "k", { probe });
    await cachedBalance("http://gw.test/v1", "sk-another-account", { probe });
    await cachedBalance("http://other:3010/v1", "k", { probe });
    expect(state.calls).toBe(3);
  });

  it("键不会被分隔符撞在一起", async () => {
    // 手拼 base + ":" + key 的实现会把这两组折叠成同一个键。
    const { state, probe } = counter(makeBalance({ remaining: 1 }));
    await cachedBalance('http://a"', "b", { probe });
    await cachedBalance("http://a", '"b', { probe });
    expect(state.calls).toBe(2);
  });

  it("base 的首尾空白和末尾斜杠不影响命中", async () => {
    const { state, probe } = counter(makeBalance({ remaining: 1 }));
    await cachedBalance("http://gw.test/v1", "k", { probe });
    await cachedBalance("  http://gw.test/v1/  ", "k", { probe });
    expect(state.calls).toBe(1);
  });

  it("invalidateCache 强制重探（改了网关配置就不能再显示旧账户）", async () => {
    const { state, probe } = counter(makeBalance({ remaining: 1 }));
    await cachedBalance("http://gw.test/v1", "k", { probe });
    invalidateCache();
    await cachedBalance("http://gw.test/v1", "k", { probe });
    expect(state.calls).toBe(2);
  });

  it("ttl=0 等于不缓存", async () => {
    const { state, probe } = counter(makeBalance({ remaining: 1 }));
    await cachedBalance("http://gw.test/v1", "k", { probe, ttlMs: 0 });
    await cachedBalance("http://gw.test/v1", "k", { probe, ttlMs: 0 });
    expect(state.calls).toBe(2);
  });

  it("默认走真的 probeBalance（接缝没接反）", async () => {
    const gw = new FakeGateway({ "/api/user/self": { body: '{"data":{"quota": 9}}' } });
    const bal = await cachedBalance("http://gw.test/v1", "k", { fetchImpl: gw.fetchImpl });
    expect(bal.remaining).toBe(9);
    expect(gw.seen).toEqual(["/v1/dashboard/billing/subscription", "/api/user/self"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  欠费判定：两个方向都要钉
// ══════════════════════════════════════════════════════════════════
describe("looksLikeQuotaExhausted", () => {
  for (const row of G.looks_like_quota_exhausted) {
    it(`${row.status} ${JSON.stringify(row.body).slice(0, 60)} → ${row.out}`, () => {
      expect(looksLikeQuotaExhausted(row.status, row.body)).toBe(row.out);
    });
  }

  it("判窄了会烧钱：真欠费的每一种机器可读信号都得认出来", () => {
    // 认不出 → 退回"瞬时故障"那条路 → 用户白等三轮退避，再收一句 HTTP 429，
    // 既看不出是没钱也不知道该去哪充。
    expect(looksLikeQuotaExhausted(402, "")).toBe(true);
    for (const m of QUOTA_MARKERS) {
      expect(looksLikeQuotaExhausted(429, `{"error":{"code":"${m}"}}`)).toBe(true);
    }
    // 真实网关的欠费 429：message 写得跟限流一模一样，只有 type/code 说了实话 ——
    // 只扫 message 的实现会在这里漏判。
    expect(
      looksLikeQuotaExhausted(
        429,
        '{"error":{"message":"当前分组上游负载已饱和，请稍后再试",' +
          '"type":"insufficient_quota","code":"insufficient_user_quota"}}',
      ),
    ).toBe(true);
  });

  it("判宽了会误伤：限流、5xx、其它状态码都不是欠费", () => {
    // scheduler 拿这个判定当"一次都不重试"的依据，误判一次限流 = 一次本来能成的
    // 梳理当场定案失败，还劝用户去给没欠费的账户充值。
    expect(looksLikeQuotaExhausted(429, "Rate limit reached: 200000 TPM")).toBe(false);
    expect(looksLikeQuotaExhausted(429, "请求过于频繁，请稍后重试")).toBe(false);
    expect(looksLikeQuotaExhausted(429, "")).toBe(false);
    // 状态码不对时，body 里出现"额度""credit"也一律不算
    for (const status of [200, 400, 401, 404, 408, 500, 503, 529, 0]) {
      expect(looksLikeQuotaExhausted(status, "insufficient_quota 余额不足 credit"))
        .toBe(false);
    }
  });

  it("已知的过宽边缘：子串匹配，「accredited」里也有「credit」", () => {
    // 与 Python 一致（golden 钉着）。留在这里是为了让下一个改判据的人先看见它。
    expect(looksLikeQuotaExhausted(429, "only for accredited partners")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  三份文案必须分得开
// ══════════════════════════════════════════════════════════════════
describe("文案", () => {
  for (const row of G.quota_exhausted_text) {
    it(`S1 ${JSON.stringify(row.detail)}`, () => {
      expect(quotaExhaustedText(row.detail)).toBe(row.out);
    });
  }

  for (const row of G.quota_low_text) {
    it(`S2 ${JSON.stringify(row.in)}`, () => {
      expect(quotaLowText(makeBalance(row.in))).toBe(row.out);
    });
  }

  for (const row of G.budget_capped_text) {
    it(`S3 ${row.scope} ${row.spent}/${row.cap}`, () => {
      expect(budgetCappedText({ spent: row.spent, cap: row.cap, scope: row.scope }))
        .toBe(row.out);
    });
  }

  it("S1 是唯一该提「充值」的地方", () => {
    const text = quotaExhaustedText("insufficient_user_quota");
    expect(text).toContain("充值");
    expect(text).toContain("insufficient_user_quota"); // 网关原文是用户查账的唯一线索
    expect(quotaExhaustedText("").trim()).not.toBe("");
  });

  /** S3 文案的禁用词。命中任何一个，用户就会去给一个一分钱没欠的账户交钱。 */
  const FORBIDDEN_IN_CAP_TEXT = ["充值", "余额", "欠费", "余额不足", "top up", "top-up"];

  for (const scope of ["build", "chat"]) {
    it(`S3(${scope}) 绝不提充值/余额/欠费（铁律 C4）`, () => {
      const text = budgetCappedText({ spent: 15.2, cap: 15.0, scope });
      const low = text.toLowerCase();
      for (const w of FORBIDDEN_IN_CAP_TEXT) {
        expect(low).not.toContain(w.toLowerCase());
      }
      expect(text).toContain("上限");
      expect(text).toContain("设置"); // 得告诉用户闸在哪儿、怎么松
      expect(text).toContain("15.00");
    });
  }

  it("对话上限和梳理上限是两个不同的闸", () => {
    expect(budgetCappedText({ spent: 1, cap: 1, scope: "chat" }))
      .not.toBe(budgetCappedText({ spent: 1, cap: 1, scope: "build" }));
    // scope 省略 = build（Python 侧的默认值）
    expect(budgetCappedText({ spent: 1, cap: 1 }))
      .toBe(budgetCappedText({ spent: 1, cap: 1, scope: "build" }));
  });

  it("三条路径三份文案，两两不同", () => {
    const texts = new Set([
      quotaExhaustedText("x"),
      quotaLowText(makeBalance({ total: 10, used: 9, remaining: 1 })),
      budgetCappedText({ spent: 15, cap: 15 }),
    ]);
    expect(texts.size).toBe(3);
  });

  it("S2 的全部价值就是那个数", () => {
    expect(quotaLowText(makeBalance({ total: 20, used: 18, remaining: 2 }))).toContain("$2.00");
  });
});
