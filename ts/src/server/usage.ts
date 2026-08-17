/**
 * 用量账本、网关装配、以及「钱不够」的三种信号 —— 移植自 `server.py` 第 335~421 /
 * 656~801 行。
 *
 * **这个文件记的是钱的账。** 落进 `_USAGE_BUF` 的每一笔都必须能逐字段对上
 * `llm_usage` 表；丢一条就是账本在说谎，所以丢了必须有个数（`usageDropped()`）。
 *
 * ── 与 Python 的分叉（都在 divergences 里报了）─────────────────────────────
 *
 * 1. `appconfig.py` 还没迁 → {@link registerAppConfig} 是它的接线点，默认实现是
 *    **env-only**，也就是 appconfig 在设置缓存为空时的那条分支，逐行同义。
 * 2. `kernel/catalog.py`（ModelCatalog / SmartGateway）还没迁 → {@link gateways}
 *    的目录与 SmartGateway 由 {@link registerCatalogPort} 注入，缺席时目录为 null
 *    （`gatewayRouting` 本来就接受 null）、`smart` 为 null。
 * 3. `_drain_usage` 是个 `while True` + `asyncio.Task.cancel()`。Node 没有取消
 *    （约定 §2.2），换成 {@link startUsageDrain} 返回的显式 `stop()` 句柄。
 */

import {
  budgetCappedText,
  cachedBalance,
  isLow,
  quotaExhaustedText,
  quotaLowText,
} from "../kernel/gateway_balance.js";
import type { Balance } from "../kernel/gateway_balance.js";
import { balanceToDict } from "../kernel/gateway_balance.js";
import { Budget } from "../kernel/budget.js";
import { BudgetExhausted } from "../kernel/errors.js";
import { OpenAICompatBackend } from "../kernel/backends.js";
import { ModelGateway, QuotaExhausted, gatewayRouting } from "../kernel/llm.js";
import type { CatalogLike, UsageSinkRow } from "../kernel/llm.js";
import type { LLMConfig } from "../kernel/config.js";
import { makeLLMConfig } from "../kernel/config.js";
import { FileBlobStore, FileJournal } from "../kernel/journal.js";
import type { Event } from "../kernel/events.js";
import { bridgeFromEnv } from "../kernel/otel.js";
import { Recorder } from "../kernel/recorder.js";
import { makeUsageRow, usageTotal } from "../store/types.js";
import type { UsageRow } from "../store/types.js";
import type { Repo } from "../store/repo/protocol.js";

import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Session } from "./session.js";

// 这几个只在 quotaExhaustedText / budgetCappedText 的调用点用得上，但把它们
// **一并 re-export**：全仓只允许有一份文案（约定 §9 的同一条纪律），别的段要用
// 就从这里拿，不要自己再写一句"余额不足"。
export { budgetCappedText, quotaExhaustedText, quotaLowText };

// ══════════════════════════════════════════════════════════════════
//  运行时配置（appconfig.py 的接线点）
// ══════════════════════════════════════════════════════════════════

/** 线上 `gateways()` 每个 Run 都新建一次网关，所以只要它读这里，设置页改的配置
 * 就会自动作用到**下一次** Run，无需重启进程。 */
export interface AppConfigPort {
  /** 解析网关 base_url / api_key：设置 → 环境 → **抛错**。绝不静默换端点。 */
  resolvedLlmConfig(): LLMConfig;
  usdCap(): number;
  chatUsdCap(): number;
  /** 各难度档的模型覆盖（只含设置页真正配了的档）。 */
  modelOverrides(): Record<string, string>;
  /** 从仓储重新载入设置缓存（原子替换）。 */
  refresh(repo: Repo): Promise<void>;
}

/** `float(os.getenv(env, "") or default)`，坏值一律回默认。 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 默认实现 = appconfig **设置缓存为空**时的那条分支（DB→env→抛错里的 env 段）。
 * appconfig.ts 落地后调 {@link registerAppConfig} 换掉它。
 */
const ENV_APP_CONFIG: AppConfigPort = {
  resolvedLlmConfig(): LLMConfig {
    const base = String(process.env["CUSTOM_LLM_BASE_URL"] ?? "").replace(/\/+$/, "");
    const key = String(process.env["CUSTOM_LLM_API_KEY"] ?? "");
    const missing: string[] = [];
    if (!base) missing.push("gateway.base_url");
    if (!key) missing.push("gateway.api_key");
    if (missing.length) {
      // 消息形态照抄 Python 的 `f"缺少 LLM 网关配置 {missing}"`（list 的 repr）。
      throw new Error(
        `缺少 LLM 网关配置 [${missing.map((m) => `'${m}'`).join(", ")}]：在设置页填写，或写进 .env`,
      );
    }
    return makeLLMConfig(base, key);
  },
  usdCap: () => envNum("ONTOCOPILOT_USD_CAP", 15.0),
  chatUsdCap: () => envNum("ONTOCOPILOT_CHAT_USD_CAP", 3.0),
  modelOverrides: () => ({}),
  refresh: async () => undefined,
};

let _appConfig: AppConfigPort = ENV_APP_CONFIG;

export function registerAppConfig(port: AppConfigPort | null): void {
  _appConfig = port ?? ENV_APP_CONFIG;
}

export function appConfig(): AppConfigPort {
  return _appConfig;
}

// ══════════════════════════════════════════════════════════════════
//  模型目录（kernel/catalog.py 的接线点）
// ══════════════════════════════════════════════════════════════════

/** `gateways()` 真正用到的那一小块目录能力。 */
export interface CatalogPort {
  /** 按网关 `/v1/models` 过滤过的目录；没有就返回 null（`gatewayRouting` 接受 null）。 */
  current(): CatalogLike | null;
  /** `SmartGateway(gw, catalog)`。没接线时返回 null。 */
  makeSmart(gw: ModelGateway, catalog: CatalogLike | null): unknown;
}

const NO_CATALOG: CatalogPort = {
  current: () => null,
  makeSmart: () => null,
};

let _catalog: CatalogPort = NO_CATALOG;

export function registerCatalogPort(port: CatalogPort | null): void {
  _catalog = port ?? NO_CATALOG;
}

// ══════════════════════════════════════════════════════════════════
//  用量流水的缓冲
// ══════════════════════════════════════════════════════════════════

export const USAGE_BUF_MAXLEN = 20_000;

/**
 * 用量流水的落库缓冲。**记账不能挡在模型调用的路上**：网关那边是同步回调，
 * 而写库是 async，中间必须有个缓冲。
 *
 * Python 用 `deque(maxlen=...)` 而不是 `asyncio.Queue`：Queue 会绑定到创建它的
 * 事件循环，而测试里每个用例一个新循环、模块级对象却只建一次 —— 跨循环用就会挂住。
 * TS 侧没有这个问题，但**满了挤掉最老一条**的语义要留住，所以还是自己实现有界队列
 * （数组 + shift；两万条量级下 shift 的开销远小于一次网络往返）。
 */
const _usageBuf: UsageRow[] = [];

/** 缓冲满时丢掉了多少条。**要有个数**：静默丢账等于账本在说谎。 */
let _usageDropped = 0;

export function usageBufLength(): number {
  return _usageBuf.length;
}

export function usageDropped(): number {
  return _usageDropped;
}

/** 只给测试用：清空缓冲与丢弃计数。 */
export function resetUsageBufForTests(): void {
  _usageBuf.length = 0;
  _usageDropped = 0;
}

/** 只给测试/关停统计用：窥视缓冲内容（**副本**，改它不影响账本）。 */
export function peekUsageBuf(): readonly UsageRow[] {
  return [..._usageBuf];
}

/**
 * 造一个记账回调，把这次运行的身份（会话/用途/归属）绑上去。
 *
 * 网关只知道 node_id、模型和 token —— 会话是谁、这轮是梳理还是聊天、算在哪个
 * 账号头上，只有服务端知道，所以在这里闭包进去。
 */
export function usageSink(
  o: {
    sessionId?: string;
    kind?: string;
    owner?: string;
    /** 测试接缝：epoch 秒（== Python `time.time()`）。ESM 换不掉模块级绑定。 */
    now?: () => number;
    /** 测试接缝：`uuid.uuid4().hex`。 */
    newId?: () => string;
  } = {},
): (rec: Partial<UsageSinkRow>) => void {
  const sessionId = o.sessionId ?? "";
  const kind = o.kind ?? "build";
  const owner = o.owner ?? "";
  const now = o.now ?? (() => Date.now() / 1000);
  const newId = o.newId ?? (() => randomUUID().replace(/-/g, ""));
  return (rec: Partial<UsageSinkRow>): void => {
    const ts = now();
    const row = makeUsageRow({
      id: newId(),
      ts,
      day: utcDay(ts),
      model: rec.model || "?",
      owner,
      session_id: sessionId,
      kind,
      run_id: rec.run_id || "",
      node_id: rec.node_id || "",
      effort: rec.effort || "",
      tok_in: Math.trunc(Number(rec.tok_in) || 0),
      tok_out: Math.trunc(Number(rec.tok_out) || 0),
      cache_read: Math.trunc(Number(rec.cache_read) || 0),
      cache_write: Math.trunc(Number(rec.cache_write) || 0),
      usd: Number(rec.usd) || 0.0,
      usd_source: rec.usd_source || "estimated",
      attempts: Math.trunc(Number(rec.attempts) || 1),
      status: rec.status || "ok",
    });
    if (_usageBuf.length >= USAGE_BUF_MAXLEN) {
      // maxlen 会挤掉最老的一条，记个数别静默
      _usageDropped += 1;
      _usageBuf.shift();
    }
    _usageBuf.push(row);
  };
}

/**
 * 把缓冲里的流水写进库，返回写了几条。
 *
 * 只有仓储确认提交后才从队首移除。异常向上传给常驻 drain（它会退避重试）或
 * shutdown（它会把真正来不及写的尾部计入 dropped），避免一次瞬时 DB 故障把
 * 一条已经接受的用量记录永久吞掉。
 */
export async function flushUsage(
  repo: Pick<Repo, "addUsage">,
  o: { limit?: number } = {},
): Promise<number> {
  const limit = o.limit ?? 500;
  let n = 0;
  while (_usageBuf.length > 0 && n < limit) {
    const row = _usageBuf[0]!;
    await repo.addUsage(row);
    // await 期间别的模型调用可能把已满缓冲的队首挤掉；只有它仍是同一个
    // 对象时才 pop，避免误删下一条尚未落库的记录。
    if (_usageBuf.length > 0 && _usageBuf[0] === row) _usageBuf.shift();
    n += 1;
  }
  return n;
}

/** {@link startUsageDrain} 的句柄。Node 没有任务取消，停要显式停（约定 §2.2）。 */
export interface UsageDrain {
  readonly promise: Promise<void>;
  stop(): void;
}

/**
 * 常驻的落库循环。lifespan 里起一个。
 *
 * 出错就退避 2s 再来 —— **不吞掉那一批**（`flushUsage` 只在 commit 后才出队）。
 */
export function startUsageDrain(
  getRepoFn: () => Pick<Repo, "addUsage">,
  o: { idleMs?: number; backoffMs?: number } = {},
): UsageDrain {
  const idleMs = o.idleMs ?? 500;
  const backoffMs = o.backoffMs ?? 2000;
  let stopped = false;
  let wake: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => {
      const t = setTimeout(() => {
        wake = null;
        res();
      }, ms);
      // 关停时立刻醒来，别让 shutdown 白等一个 idle 周期。
      wake = () => {
        clearTimeout(t);
        wake = null;
        res();
      };
    });
  }

  const promise = (async () => {
    while (!stopped) {
      try {
        if (_usageBuf.length > 0) await flushUsage(getRepoFn());
        await sleep(idleMs);
      } catch {
        await sleep(backoffMs);
      }
    }
  })();
  promise.catch(() => undefined);

  return {
    promise,
    stop(): void {
      stopped = true;
      wake?.();
    },
  };
}

/**
 * 关停时把剩下的流水写完 —— 一次梳理刚跑完就重启，账不该丢。
 *
 * 写不动就把**还留在缓冲里的**全部计入 dropped：用量写入是旁路，正常关停不能
 * 因账本不可用而卡死，但也不能假装那些账已经落库了。
 */
export async function drainUsageOnShutdown(
  repo: Pick<Repo, "addUsage">,
  o: { limit?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushUsage(repo, { limit: o.limit ?? 20_000 }),
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error("flush usage timeout")), timeoutMs);
      }),
    ]);
  } catch {
    _usageDropped += _usageBuf.length;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════════════
//  网关装配
// ══════════════════════════════════════════════════════════════════

export interface Gateways {
  readonly backend: OpenAICompatBackend;
  readonly gw: ModelGateway;
  /** `SmartGateway`。`kernel/catalog.ts` 未落地时是 null，见文件头分叉 2。 */
  readonly smart: unknown;
  readonly budget: Budget;
}

/**
 * 一次 Run 的网关四件套。
 *
 * 一份几百行的梳理表要跑十来个抽取节点，每个节点还可能因 critic 打回重来。
 * 上限设太紧的后果不是省钱，是跑到一半 HALT、前面花掉的钱全打水漂。
 */
export function gateways(
  out: string,
  runId: string,
  o: { resume?: boolean; sessionId?: string; kind?: string; owner?: string } = {},
): Gateways {
  const cfg = _appConfig.resolvedLlmConfig(); // 设置 → env → 抛错
  // OTel 旁路：没配 OTEL_EXPORTER_OTLP_ENDPOINT 时 bridgeFromEnv 返回 null，
  // observer 整个不挂 —— 关掉就是真的零开销，不是"发到本地然后每条都失败"。
  const bridge = bridgeFromEnv(runId);
  const rec = new Recorder(
    runId,
    new FileJournal(join(out, "journal")),
    new FileBlobStore(join(out, "blobs")),
    {
      resume: o.resume ?? false,
      ...(bridge !== null ? { observer: (e: Event) => bridge.observe(e) } : {}),
    },
  );
  const budget = new Budget({ tokens: 4_000_000, usd: _appConfig.usdCap() });
  const backend = new OpenAICompatBackend(cfg.baseUrl, cfg.apiKey);
  // 启动时按网关可用模型过滤过的目录 —— 视觉选型据此落到网关真有的视觉模型上
  const catalog = _catalog.current();
  // 路由按当前设置构建（含各档模型覆盖）并随本次 Run 固定：配置改动只作用到之后
  // 新建的 Run，不影响在跑的这次。
  const routing = gatewayRouting(_appConfig.modelOverrides(), catalog);
  const gw = new ModelGateway(backend, rec, {
    routing,
    budget,
    usageSink: usageSink({
      sessionId: o.sessionId ?? "",
      kind: o.kind ?? "build",
      owner: o.owner ?? "",
    }),
  });
  return { backend, gw, smart: _catalog.makeSmart(gw, catalog), budget };
}

// ══════════════════════════════════════════════════════════════════
//  钱不够的三种信号（契约 C 第 2 节）
//
//  S1 网关欠费、S2 余额偏低、S3 本地上限用满 —— **文案绝不能混**。把"你自己设的
//  上限用完了"说成"余额不足"，用户会去给一个根本没欠费的账户充值。
// ══════════════════════════════════════════════════════════════════

/** 开跑前那次余额探测的秒数上限。见 {@link warnLowBalance}。 */
export const BALANCE_TIMEOUT = 3.0;

/**
 * 跑之前探一次网关余额，查得到且偏低就提醒一句。**只提醒，不阻断。**
 *
 * 查不到（网关没这类接口是常态）就什么都不说 —— 沉默比一句"余额未知"有用，
 * 更比一句猜出来的"余额不足"安全。整段被 try 包住：探测失败不许影响梳理。
 */
export async function warnLowBalance(s: Session): Promise<void> {
  let bal: Balance;
  try {
    const cfg = _appConfig.resolvedLlmConfig();
    // 超时压到 3s：这一步挡在解析前面，用户盯着的是"开始跑了没有"。余额只是
    // 一句提醒，宁可不提，也不该让每次开跑先空等五秒。
    bal = await cachedBalance(cfg.baseUrl, cfg.apiKey, {
      timeoutMs: BALANCE_TIMEOUT * 1000,
    });
  } catch {
    // 铁律 C5：探测挂了也只是"未知"
    return;
  }
  if (isLow(bal)) {
    s.emit("quota.low", { message: quotaLowText(bal), balance: balanceToDict(bal) });
  }
}

/** {@link moneyFailure} 的返回：`(信号, 网关原文)`。 */
export type MoneySignal = "quota" | "cap" | "";

/**
 * 把一次失败认成 `"quota"`（网关欠费）/ `"cap"`（本地上限）/ `""`（都不是）。
 *
 * 为什么还要看字符串：节点里抛的异常被调度器统一转成 `NodeFailure` 的**文本**
 * （`kernel/scheduler.ts` 里 `${type(last).name}: ${last}`），到这一层早就不是原来
 * 的类型了。所以类型优先、文本兜底 —— 只靠 instanceof 的话，最常见的那条路
 * （抽取节点里欠费）恰好一条都认不出来。
 */
export function moneyFailure(exc: unknown): readonly [MoneySignal, string] {
  let cur: unknown = exc;
  for (let i = 0; i < 6; i++) {
    // 异常链理论上无环，仍设个上限
    if (cur === null || cur === undefined) break;
    if (cur instanceof QuotaExhausted) return ["quota", cur.detail];
    if (cur instanceof BudgetExhausted && cur.dimension === "usd") return ["cap", ""];
    // Python 是 `cur.__cause__ or cur.__context__`。JS 只有 `cause`（`new Error(m,
    // {cause})`），没有隐式的 __context__ —— 隐式链在 TS 侧根本不存在，不是漏迁。
    cur = cur instanceof Error ? (cur.cause as unknown) : null;
  }
  const text = excText(exc);
  if (text.includes("QuotaExhausted")) return ["quota", text];
  // BudgetExhausted 的消息形态（errors.ts: `${dimension} 预算耗尽: …`）
  if (text.includes("usd 预算耗尽")) return ["cap", ""];
  return ["", ""];
}

/** Python `str(exc)` —— 只有消息，没有类名。 */
function excText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ══════════════════════════════════════════════════════════════════
//  /api/usage 的报表
// ══════════════════════════════════════════════════════════════════

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d")` */
function utcDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

/** `"%Y-%m-%d %H:00"` */
function utcHour(ts: number): string {
  return `${utcDay(ts)} ${two(new Date(ts * 1000).getUTCHours())}:00`;
}

export interface UsageTotals {
  calls: number;
  tok_in: number;
  tok_out: number;
  cache_read: number;
  cache_write: number;
  tokens: number;
  usd_billed: number;
  billed_calls: number;
  failed: number;
}

export interface UsageGroup {
  name: string;
  calls: number;
  tokens: number;
  tok_in: number;
  tok_out: number;
}

export interface UsageBucket {
  t: string;
  calls: number;
  tokens: number;
  tok_in: number;
  tok_out: number;
}

export interface UsageDetailRow {
  ts: number;
  model: string;
  kind: string;
  node: string;
  tok_in: number;
  tok_out: number;
  tokens: number;
  attempts: number;
  status: string;
  session_id: string;
}

/** `/api/usage` 的响应体。**字段名是前端契约，一个字都不能改。** */
export interface UsageReport {
  days: number;
  bucket: string;
  total: UsageTotals;
  series: UsageBucket[];
  by_model: UsageGroup[];
  by_kind: UsageGroup[];
  rows: UsageDetailRow[];
  truncated: boolean;
  /** billed | partial | none —— 金额可信度，界面据此决定显示还是打问号。 */
  cost_note: string;
}

export interface UsageQuery {
  days?: number;
  bucket?: string;
  limit?: number;
  /** null = 不按归属过滤（开放模式/合成管理员看全部）。 */
  owner?: string | null;
  /** 测试接缝：`time.time()`。 */
  now?: number;
}

/**
 * 模型用量：总量 + 按时间的曲线 + 按模型/用途的拆分 + 明细。
 *
 * **只统计 token，不把估算的金额当钱报。** 经网关发现的模型在本地价目表里是
 * 统一编的 2.0/8.0 美元每百万 token —— 拿它算出来的金额看着精确，其实是错的，
 * 比不显示更糟。只有网关自己回了账单（usd_source=gateway）的那部分才算钱，
 * 并且明确告诉界面它覆盖了多少条。
 */
export async function usageReport(
  repo: Pick<Repo, "usageSince">,
  q: UsageQuery = {},
): Promise<UsageReport> {
  const days = Math.max(1, Math.min(Math.trunc(q.days || 30), 365));
  const bucket = q.bucket === "hour" ? "hour" : "day";
  // 明细查询不能让一个请求把整本账拉进进程；负数也不能借 slice 语义悄悄
  // 变成空结果。前端默认 5k，显式导出最多 50k。
  const limit = Math.max(1, Math.min(Math.trunc(q.limit || 5000), 50_000));
  const now = q.now ?? Date.now() / 1000;
  const since = now - days * 86400;
  const owner = q.owner ?? null;
  const rows = await repo.usageSince(since, { owner, limit });

  const key = (ts: number): string => (bucket === "hour" ? utcHour(ts) : utcDay(ts));

  const total: UsageTotals = {
    calls: 0,
    tok_in: 0,
    tok_out: 0,
    cache_read: 0,
    cache_write: 0,
    tokens: 0,
    usd_billed: 0.0,
    billed_calls: 0,
    failed: 0,
  };
  const byModel = new Map<string, UsageGroup>();
  const byKind = new Map<string, UsageGroup>();
  const series = new Map<string, UsageBucket>();

  for (const r of rows) {
    total.calls += 1;
    total.tok_in += r.tok_in;
    total.tok_out += r.tok_out;
    total.cache_read += r.cache_read;
    total.cache_write += r.cache_write;
    total.tokens += usageTotal(r);
    if (r.status === "failed") total.failed += 1;
    if (r.usd_source === "gateway") {
      total.usd_billed += r.usd;
      total.billed_calls += 1;
    }
    for (const [grp, name] of [
      [byModel, r.model],
      [byKind, r.kind],
    ] as const) {
      let g = grp.get(name);
      if (g === undefined) {
        g = { name, calls: 0, tokens: 0, tok_in: 0, tok_out: 0 };
        grp.set(name, g);
      }
      g.calls += 1;
      g.tokens += usageTotal(r);
      g.tok_in += r.tok_in;
      g.tok_out += r.tok_out;
    }
    const k = key(r.ts);
    let b = series.get(k);
    if (b === undefined) {
      b = { t: k, calls: 0, tokens: 0, tok_in: 0, tok_out: 0 };
      series.set(k, b);
    }
    b.calls += 1;
    b.tokens += usageTotal(r);
    b.tok_in += r.tok_in;
    b.tok_out += r.tok_out;
  }

  // 空桶要补出来，否则"哪天没跑"在曲线上看不出来，只会被挤成连续的一片
  const stepMs = bucket === "hour" ? 3600_000 : 86400_000;
  const cur = new Date(since * 1000);
  cur.setUTCMinutes(0, 0, 0);
  if (bucket === "day") cur.setUTCHours(0);
  const end = now * 1000;
  const filled: UsageBucket[] = [];
  for (let t = cur.getTime(); t <= end && filled.length < 400; t += stepMs) {
    const k = bucket === "hour" ? utcHour(t / 1000) : utcDay(t / 1000);
    filled.push(series.get(k) ?? { t: k, calls: 0, tokens: 0, tok_in: 0, tok_out: 0 });
  }

  // `sorted(key=lambda x: -x["tokens"])` —— 稳定降序。JS 的 sort 自 ES2019
  // 起也保证稳定，两边并列时的先后一致。
  const top = [...byModel.values()].sort((a, b) => b.tokens - a.tokens);

  return {
    days,
    bucket,
    total,
    series: filled,
    by_model: top,
    by_kind: [...byKind.values()].sort((a, b) => b.tokens - a.tokens),
    // 明细给最近这些条；界面上是流水表，也是导出的来源
    rows: rows.slice(0, 300).map((r) => ({
      ts: r.ts,
      model: r.model,
      kind: r.kind,
      node: r.node_id,
      tok_in: r.tok_in,
      tok_out: r.tok_out,
      tokens: usageTotal(r),
      attempts: r.attempts,
      status: r.status,
      session_id: r.session_id,
    })),
    truncated: rows.length >= limit,
    cost_note:
      total.billed_calls === total.calls && rows.length > 0
        ? "billed"
        : total.billed_calls
          ? "partial"
          : "none",
  };
}
