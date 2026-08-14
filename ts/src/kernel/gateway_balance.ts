/**
 * 网关余额探测（best-effort）+ 三类「钱不够」的文案 —— 对应 Python 侧
 * `kernel/gateway_balance.py`，字节由 `golden/gateway_balance.json` 钉住。
 *
 * OpenAI 兼容网关（New-API / one-api / OpenRouter 这一类）**大多根本没有余额接口**，
 * 有的那几家路径还各不相同。所以这个模块只有一条立场：**查不到就是「未知」**。把
 * "查不到"渲染成"余额不足"，用户会跑去给一个根本没欠费的账户充值 —— 那比不显示
 * 余额糟得多。
 *
 * 同一个道理，本地 `usd_cap` 用满（我们自己设的闸）和网关欠费是**两回事**，文案
 * 必须分开：`budgetCappedText` 里绝不出现"充值/余额/欠费"这类词。
 *
 * 本模块不依赖 store、不依赖 server，也**不往外抛异常**：任何失败都收敛成
 * `makeBalance()`（未知）。探测挂了不该让梳理、设置页、任何东西跟着挂。
 *
 * ── TS 侧的三处刻意选择（都在 deviations 里报过）──────────────────────
 *
 * 1. **超时单位是毫秒**（`timeoutMs` / `ttlMs` / `CACHE_TTL_MS`）。Python 用秒，
 *    照抄成 `timeout: number` 的话，第一个手滑传 5000 的调用方会拿到 83 分钟的
 *    "超时"，而症状是设置页转圈 —— 没人会往超时单位上想。名字里带 Ms 就误不了。
 * 2. **超时用 `AbortSignal.timeout`**，不自己 `setTimeout`。Node 的这个 timer 是
 *    unref 的；自己造的没 unref，进程会在最后一次探测后多吊 5 秒不退出。
 * 3. **`fetchImpl` / `probe` 是显式的测试接缝**。Python 侧靠 monkeypatch 换掉模块
 *    级函数，ESM 的导出绑定是只读的，换不了 —— 接缝必须写进签名里。
 */

import { formatFixed0 } from "./errors.js";
import { canonicalJson } from "./ids.js";

/**
 * New-API 系的额度单位。**不是美元** —— 它是 token 额度，各家换算率还能自己配，
 * 猜一个汇率标上 "$" 比不标更糟（用户会照着这个数决定要不要充值）。
 */
export const QUOTA_UNIT = "quota";

/**
 * 余额"偏低"的判据。美元口径：跑一次梳理的默认上限是 $15，剩不到 $5 基本跑不完
 * 一轮，值得先说一声；额度口径换算不确定，只看比例。
 */
export const LOW_USD = 5.0;
export const LOW_RATIO = 0.1;

/** 进程内缓存的存活时间（Python 侧 `CACHE_TTL = 60.0` 秒）。设置页连点几下不该把网关打一遍。 */
export const CACHE_TTL_MS = 60_000;

/** 整段探测的默认预算（Python 侧 `timeout: float = 5.0` 秒）。 */
export const DEFAULT_TIMEOUT_MS = 5_000;

// ══════════════════════════════════════════════════════════════════
//  Python 数字格式化的移植
// ══════════════════════════════════════════════════════════════════

/**
 * Python `format(x, ".2f")`。**不要**用 `x.toFixed(2)` 代替，三处不同：
 *
 *   x        CPython .2f   JS toFixed(2)   说明
 *   0.125    "0.12"        "0.13"          CPython 是 round-half-**even**，
 *   0.625    "0.62"        "0.63"          toFixed 的并列规则是取更大的 n
 *   -0.0     "-0.00"       "0.00"          toFixed 只看 `x < 0`，-0 不满足
 *   1e21     "10…0.00"     "1e+21"         ≥1e21 时 toFixed 退回 toString
 *
 * 并列只可能出现在八分之一（.125/.375/.625/.875）这种 2 位小数上**精确**的
 * 二进制数上，所以判据是精确的，不存在浮点误差 —— 只要拿到 double 的精确十进制
 * 展开就行。`toFixed(20)` 给的正是这个展开（|x| < 1e21 时按规范是精确舍入到 20
 * 位，而任何 2 位并列点周围 1e-20 内没有别的 double），≥1e21 的 double 必为整数，
 * 走 BigInt。
 *
 * 这个串是用户拿来决定"要不要充值"的那个数，差一分就是投诉。
 */
export function formatFixed2(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";

  // 符号取自输入而不是结果：Python 对 -0.0 / -0.001 都给 "-0.00"。
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  if (a >= 1e21) return (neg ? "-" : "") + BigInt(a).toString() + ".00";
  return (neg ? "-" : "") + roundTo2(a.toFixed(20));
}

/** 把"非负数的精确十进制展开"按 round-half-even 收到 2 位。 */
function roundTo2(s: string): string {
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? "" : s.slice(dot + 1);
  const keep = (frac + "00").slice(0, 2);
  const rest = frac.slice(2);
  const first = rest.charAt(0);

  let up = false;
  if (first > "5") up = true;
  else if (first === "5") {
    // 后面还有非零位 → 严格大于半，直接进；否则是精确并列，向偶数舍入。
    up = /[1-9]/.test(rest.slice(1)) || (keep.charCodeAt(1) - 0x30) % 2 === 1;
  }

  // 当作"分"来进位，避免在字符串上手写连锁进位（999.99 → 1000.00）。
  let digits = intPart + keep;
  if (up) digits = (BigInt(digits) + 1n).toString();
  digits = digits.padStart(3, "0");
  return digits.slice(0, -2) + "." + digits.slice(-2);
}

/** Python 格式化里的 `,`：整数部分每三位一个逗号。小数点后不分组。 */
function group(s: string): string {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const head = dot < 0 ? body : body.slice(0, dot);
  const tail = dot < 0 ? "" : body.slice(dot);
  // 非数字（"nan"/"inf"）不分组 —— Python 的 `,` 对它们同样是原样输出。
  if (!/^\d+$/.test(head)) return s;
  return (neg ? "-" : "") + head.replace(/\B(?=(\d{3})+$)/g, ",") + tail;
}

// ══════════════════════════════════════════════════════════════════
//  Balance
// ══════════════════════════════════════════════════════════════════

/**
 * 一次余额探测的结果。**默认就是"未知"** —— 造一个空的即表示没查到。
 *
 * 用 interface + 自由函数而不是 class：`balanceToDict` 的产物就是 `/api/config`
 * 的线上形态，会在 HTTP 边界上往返；class 实例过一遍 JSON 回来就只剩裸对象，
 * `.known` / `.human()` 静默变成 undefined（而"余额未知"恰好也长这样，错得看不出来）。
 */
export interface Balance {
  readonly total: number | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly currency: string;
  /** 命中的是哪个端点，写给人看的（"这个数是从哪来的"必须能追）。 */
  readonly source: string;
}

/** dataclass 的默认值搬到工厂里 —— 不写成 class field，见约定表。 */
export function makeBalance(p: Partial<Balance> = {}): Balance {
  return {
    total: p.total ?? null,
    used: p.used ?? null,
    remaining: p.remaining ?? null,
    currency: p.currency ?? "USD",
    source: p.source ?? "",
  };
}

/** 只认 remaining：知道总额却不知道花了多少，等于不知道还剩多少。 */
export function balanceKnown(b: Balance): boolean {
  return b.remaining !== null;
}

/** 给人看的剩余额度。未知就说未知，**不说 0** —— 0 是"没钱了"。 */
export function balanceHuman(b: Balance): string {
  if (b.remaining === null) return "未知";
  // currency 是相等比较不是"是不是钱"：小写 "usd" 也走额度分支，照 Python 原样。
  if (b.currency === "USD") return "$" + group(formatFixed2(b.remaining));
  return group(formatFixed0(b.remaining)) + " 额度";
}

/** `/api/config` 里 `balance` 字段的线上形态。未知时**只有** `known: false`。 */
export type BalanceDict =
  | { known: false }
  | {
      known: true;
      total: number | null;
      used: number | null;
      remaining: number | null;
      currency: string;
      source: string;
      text: string;
    };

export function balanceToDict(b: Balance): BalanceDict {
  if (!balanceKnown(b)) return { known: false };
  return {
    known: true,
    total: b.total,
    used: b.used,
    remaining: b.remaining,
    currency: b.currency,
    source: b.source,
    text: balanceHuman(b),
  };
}

export interface LowThresholds {
  readonly usdFloor?: number;
  readonly ratio?: number;
}

/** 余额是否低到值得提醒。**未知永远返回 false**（铁律 C1）。 */
export function isLow(b: Balance, t: LowThresholds = {}): boolean {
  const usdFloor = t.usdFloor ?? LOW_USD;
  const ratio = t.ratio ?? LOW_RATIO;
  if (!balanceKnown(b) || b.remaining === null) return false;
  if (b.currency === "USD" && b.remaining <= usdFloor) return true;
  // Python 是 `if b.total and b.total > 0`：total 为 0 / None 都跳过。
  if (b.total !== null && b.total > 0) return b.remaining / b.total <= ratio;
  return false;
}

// ══════════════════════════════════════════════════════════════════
//  探测
// ══════════════════════════════════════════════════════════════════

/** 只需要 fetch 的这一点点签名；测试塞假的进来。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  /** 整段探测的毫秒预算（不是单个请求的）。 */
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

interface Ctx {
  readonly fetchImpl: FetchLike;
  readonly base: string;
  readonly headers: Record<string, string>;
  /** performance.now() 口径的截止时刻。 */
  readonly deadline: number;
  /**
   * **整段探测共用的一个信号**（Python 那边是 `asyncio.timeout` 从外面掐整块）。
   *
   * 原来每个请求各自 `AbortSignal.timeout(remaining)`，而"还剩多少预算"是另一次
   * 独立读表 —— 两个时钟差零点几毫秒，abort 早触发一点，`remaining` 就还是正数，
   * 于是第一个端点被掐掉之后**第二个照样发出去**，整段探测最长要 2×timeout。
   * 这个竞态在机器空闲时看不见，套件并发跑起来就现形（真的红过）。
   *
   * 用同一个信号之后，"超时了没有"只有一个答案。
   */
  readonly signal: AbortSignal;
}

/** 一个端点探测器：拿到上下文，返回 Balance（拿不到就是未知）。 */
type Probe = (ctx: Ctx) => Promise<Balance>;

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

/**
 * 只认真能当数用的值。`null` / 字符串 / 布尔一律当没拿到。
 *
 * 布尔在 Python 侧要单独排（`bool` 是 `int` 的子类），JS 里 `typeof true` 不是
 * "number" 所以自然出局 —— 但判据的**理由**一样：`{"quota": true}` 变成 1.0，
 * 用户会看到自己还剩 $1.00。
 */
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * 把 `…/v1` 这样的 API 前缀退回站点根。
 *
 * New-API 的用户接口挂在站点根（`/api/user/self`）而不是 OpenAI 前缀下面，
 * 照着 base 直接拼会稳定 404 —— 而"稳定 404"和"这家网关没这接口"长得一模一样。
 */
export function siteRoot(base: string): string {
  // 末尾三个字符是 ASCII 的 "/v1"，UTF-16 与 code point 切法在这里等价。
  return base.endsWith("/v1") ? base.slice(0, -3).replace(/\/+$/, "") : base;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 取一个 JSON 对象。非 200 / 不是 JSON（例如网关把请求路由到了登录页 HTML）
 * / 不是对象，都当"这条路不通"，返回 null。
 */
async function getJson(
  ctx: Ctx,
  url: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  // 整段预算花完就别再发新请求。**判据是那个共享信号本身**，不是再读一次表 ——
  // 读表会和 abort 的触发时刻差出一条缝，第二个端点就从那条缝里溜出去了。
  if (ctx.signal.aborted) return null;
  if (ctx.deadline - monoNow() <= 0) return null;

  const full = params ? `${url}?${new URLSearchParams(params).toString()}` : url;
  const res = await ctx.fetchImpl(full, {
    headers: ctx.headers,
    // httpx 那边是 follow_redirects=True；fetch 默认就是 follow，写出来是为了
    // 别人改这行时知道它是**契约**：网关把 /api/user/self 302 到别处很常见。
    redirect: "follow",
    signal: ctx.signal,
  });

  if (res.status !== 200) {
    await discardBody(res);
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  return isRecord(data) ? data : null;
}

/**
 * `AbortSignal.timeout` 只收 **uint32 的整数**，给个 1.5 直接
 * `ERR_OUT_OF_RANGE`。而 `performance.now()` 是浮点，剩余预算几乎必然带小数 ——
 * 不取整的话每次请求都在 fetch 之前就抛，被 `attempt` 吞掉，症状是**所有网关都
 * 报"余额未知"**，一行日志都没有。向上取整：绝不把预算算少成 0。
 */
function clampDelay(ms: number): number {
  return Math.min(Math.max(Math.ceil(ms), 1), 2_147_483_647);
}

/**
 * 不读的响应体要显式丢掉。undici 里未消费的 body 会把连接吊在池子里直到超时，
 * 而"非 200"是这个模块最常见的路径（网关根本没有余额接口），设置页每打开一次
 * 就吊两条。cancel 自己也可能抛（body 已被读/已关闭），照吞。
 */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* 丢不掉就算了，绝不能因为清理动作让探测失败 */
  }
}

/**
 * UTC 今天 ± n 天的 `YYYY-MM-DD`。
 *
 * 用 UTC 是因为 Python 侧是 `datetime.now(UTC).date()`；UTC 没有夏令时，一天恰好
 * 86400 秒，所以"先加天数再取日期"和"先取日期再加天数"在这里等价。
 */
function utcDateString(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** OpenAI 兼容口径：`hard_limit_usd` - `total_usage`/100（后者是**美分**）。 */
const probeOpenaiBilling: Probe = async (ctx) => {
  const sub = await getJson(ctx, `${ctx.base}/dashboard/billing/subscription`);
  if (sub === null) return makeBalance();
  let limit = num(sub["hard_limit_usd"]);
  if (limit === null) limit = num(sub["system_hard_limit_usd"]);
  if (limit === null) return makeBalance();

  const usage = await getJson(ctx, `${ctx.base}/dashboard/billing/usage`, {
    start_date: utcDateString(-99),
    end_date: utcDateString(1),
  });
  const cents = num(usage?.["total_usage"]);
  if (cents === null) {
    // 拿得到额度、拿不到用量 → 仍旧不知道还剩多少。宁可报未知，也不拿总额冒充余额。
    return makeBalance();
  }
  const used = cents / 100.0;
  return makeBalance({
    total: limit,
    used,
    remaining: Math.max(0.0, limit - used),
    currency: "USD",
    source: "dashboard/billing",
  });
};

/**
 * New-API / one-api 口径：`data.quota` 是**剩余额度**，`data.used_quota` 是已用。
 * 单位是 token 额度不是美元，换算率各家自己配，所以只报额度。
 */
const probeNewapiSelf: Probe = async (ctx) => {
  const body = await getJson(ctx, `${siteRoot(ctx.base)}/api/user/self`);
  const data = body?.["data"];
  if (!isRecord(data)) return makeBalance();
  const remaining = num(data["quota"]);
  if (remaining === null) return makeBalance();
  const used = num(data["used_quota"]);
  return makeBalance({
    total: used !== null ? remaining + used : null,
    used,
    remaining,
    currency: QUOTA_UNIT,
    source: "api/user/self",
  });
};

const PROBES: readonly Probe[] = [probeOpenaiBilling, probeNewapiSelf];

/**
 * 跑一个端点，**任何失败都当"这条路不通"**（返回未知），换下一个。
 *
 * 404/401/连不上/网关把请求重定向到登录页 HTML —— 这些不是异常情况，是探测余额
 * 的常态。
 *
 * Python 那边这里会把 `CancelledError` 放行（用户点了停止就别再陪着试完剩下的
 * 端点）。JS 没有对等物：唯一会飞过来的 AbortError 是**我们自己**的超时，语义上
 * 就是"这条路不通"，照吞（契约 §2.2：不在这一层发明取消机制）。
 */
async function attempt(probe: Probe, ctx: Ctx): Promise<Balance> {
  try {
    return await probe(ctx);
  } catch {
    return makeBalance();
  }
}

function monoNow(): number {
  // 单调钟。用 Date.now() 的话，一次 NTP 回拨就能让"整段预算"变成负数（探测直接
  // 空转）或者让缓存永不过期。
  return performance.now();
}

/**
 * 依次试几个常见端点，第一个能解析出数的就返回；全都不行返回未知。
 *
 * `timeoutMs` 是**整件事**的预算，不只是单个请求的：设置页等着这个结果，不能因为
 * 网关吊着连接就转上十几秒。
 *
 * @param baseUrl 网关 base（通常以 `/v1` 结尾）。
 * @param apiKey 网关密钥。空则直接返回未知 —— 没密钥问了也是白问。
 */
export async function probeBalance(
  baseUrl: string,
  apiKey: string,
  opts: ProbeOptions = {},
): Promise<Balance> {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!base || !apiKey) return makeBalance();

  const ctx: Ctx = {
    fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
    base,
    headers: authHeaders(apiKey),
    deadline: monoNow() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    signal: AbortSignal.timeout(clampDelay(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  };

  try {
    for (const probe of PROBES) {
      const b = await attempt(probe, ctx);
      if (balanceKnown(b)) return b;
    }
  } catch {
    // `attempt` 已经吞干净了，走到这里说明是本模块自己的 bug。照样收敛成"未知"：
    // 铁律 C5 —— 探测失败不许让任何流程失败，包括探测代码自己写错的时候。
    return makeBalance();
  }
  return makeBalance();
}

// ══════════════════════════════════════════════════════════════════
//  缓存
// ══════════════════════════════════════════════════════════════════

/**
 * (base_url, api_key) → (探到的时刻, 结果)。**失败也缓存** —— 网关根本没这接口时，
 * 每次打开设置页都白等一遍超时是最没意义的等待。
 *
 * 键用 canonicalJson 拼两段字符串：拿分隔符手拼（`base + ":" + key`）会在
 * base 里含分隔符时把两个账户折叠成一个 —— 显示别的账户的余额是最坏的一种错。
 */
const CACHE = new Map<string, readonly [number, Balance]>();

export type ProbeFn = (
  baseUrl: string,
  apiKey: string,
  opts: ProbeOptions,
) => Promise<Balance>;

export interface CachedOptions extends ProbeOptions {
  readonly ttlMs?: number;
  /** 测试接缝：ESM 换不掉模块级绑定，只能从签名里递进来。 */
  readonly probe?: ProbeFn;
}

/** 带进程内短缓存的 {@link probeBalance}。 */
export async function cachedBalance(
  baseUrl: string,
  apiKey: string,
  opts: CachedOptions = {},
): Promise<Balance> {
  const key = canonicalJson([(baseUrl || "").trim().replace(/\/+$/, ""), apiKey || ""]);
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  const hit = CACHE.get(key);
  const now = monoNow();
  if (hit !== undefined && now - hit[0] < ttlMs) return hit[1];

  const probe = opts.probe ?? probeBalance;
  const probeOpts: ProbeOptions =
    opts.fetchImpl !== undefined
      ? { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, fetchImpl: opts.fetchImpl }
      : { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const bal = await probe(baseUrl, apiKey, probeOpts);
  CACHE.set(key, [now, bal]);
  return bal;
}

/** 网关配置改了就得重新探 —— 换了密钥还显示旧账户的余额是彻头彻尾的误导。 */
export function invalidateCache(): void {
  CACHE.clear();
}

// ══════════════════════════════════════════════════════════════════
//  欠费判定（S1 硬信号）
// ══════════════════════════════════════════════════════════════════

/**
 * 配额耗尽的标志词，大小写不敏感、命中任一即可。前六个是各家网关的机器可读字段值
 * （`error.type` / `error.code`），后几个是中文网关的人类文案。
 */
export const QUOTA_MARKERS: readonly string[] = [
  "insufficient_quota",
  "insufficient_user_quota",
  "exceeded_current_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "credit",
  "余额",
  "额度",
  "欠费",
];

/**
 * 这个响应是不是"网关账户真的没钱了"（S1 硬信号）。
 *
 * 纯函数，没有 IO，好单测 —— 这个判断错了两边都很贵：判宽了会把一次真限流说成
 * 欠费、让用户去给一个没欠费的账户充值；判窄了就退回"白等几轮退避"。它也是
 * scheduler 里 `QuotaExhausted` **一次都不重试**的唯一依据。
 *
 * 两条规则：
 *   - `402 Payment Required` —— 语义就是这个，不看 body。
 *   - `429` **且** body 里有配额标志词。429 是欠费与限流共用的状态码，只能靠 body 分。
 *
 * **整个 body 都扫，不只扫 `message`**：真实网关（New-API 系）的欠费 429 长这样 ——
 * `{"error":{"message":"当前分组上游负载已饱和，请稍后再试",
 * "type":"insufficient_quota","code":"insufficient_user_quota"}}`。
 * `message` 写得跟限流一模一样，只有 `type` / `code` 说了实话。
 *
 * 其余状态码一律 false：body 里出现"额度"二字不代表这次 500 是欠费。
 *
 * 注：源在 Python 侧的 `kernel/backends.py`（那个模块整体还没迁）。这里是同一份
 * 判据，`golden/gateway_balance.json` 里两个方向的用例都钉着；backends 迁过来时
 * **导入这一个**，别再抄一份 —— 抄一份就必然分叉，而分叉的症状是"有时候会重试"。
 */
export function looksLikeQuotaExhausted(status: number, body: string): boolean {
  if (status === 402) return true;
  if (status !== 429) return false;
  // toLowerCase 与 Python str.lower() 都是无 locale 的 Unicode 全量小写映射；
  // 标志词是 ASCII + 中文，落在两边完全一致的区域里。
  const low = (body || "").toLowerCase();
  return QUOTA_MARKERS.some((m) => low.includes(m));
}

// ══════════════════════════════════════════════════════════════════
//  文案：S1（网关欠费）/ S2（余额偏低）/ S3（本地上限）
// ══════════════════════════════════════════════════════════════════

/** S1 硬信号：网关账户真的没钱了。**这是唯一该提"充值"的地方。** */
export function quotaExhaustedText(detail = ""): string {
  const tip = "网关账户余额不足，梳理没法继续。去网关充值后重跑即可，已经跑完的部分会接着用。";
  const d = (detail || "").trim();
  return d ? `${tip}网关原文：${d}` : tip;
}

/** S2：查得到而且偏低。只提醒，不阻断 —— 用户可能正在充值或另有付费方式。 */
export function quotaLowText(b: Balance): string {
  return `网关余额只剩 ${balanceHuman(b)}，这次梳理可能跑不完。`;
}

export interface CappedTextArgs {
  readonly spent: number;
  readonly cap: number;
  readonly scope?: string;
}

/**
 * S3：**我们自己设的闸**用满了。
 *
 * 这段文案里绝不能出现"充值/余额/欠费" —— 网关账户可能一分钱没少，把本地上限说成
 * 欠费，用户会去给一个没问题的账户交钱（契约第 2 节，铁律 C4）。
 */
export function budgetCappedText(a: CappedTextArgs): string {
  const what = a.scope === "chat" ? "这个会话的对话" : "本次梳理";
  // 这里的 `.2f` **不带千分位**（Python 侧写的是 `:.2f` 不是 `:,.2f}`）：
  // $1000.00 而不是 $1,000.00。照抄，不"顺手美化"。
  return (
    `${what}的花费上限 $${formatFixed2(a.cap)} 用满了（已花 $${formatFixed2(a.spent)}）。` +
    `这是你在设置里定的上限，网关账户本身没有问题；要继续就去` +
    `「设置 → 预算」调高，或者新建会话。`
  );
}
