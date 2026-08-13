/**
 * 模型网关 —— 难度路由、结构化输出、异构评委、成本记账。
 * 对应 Python 侧 `kernel/llm.py`，行为由 `golden/llm.json` 钉住。
 *
 * 三条纪律：
 *
 *   1. **所有调用走 Recorder.effect** —— 重放时读回历史，不重新付费。
 *   2. **难度路由**（DAAO 式）—— 便宜的活不该用旗舰模型，关键判断不该省。
 *   3. **异构评委** —— critic 用的模型必须与生成的不同，缓解自我增强偏差
 *      （LLM-as-judge 综述 arXiv:2411.15594）。这是网关强制的，不靠调用方自觉。
 *
 * **采样参数不在这一层出现**。当前一代模型（Claude Opus 5 / Sonnet 5）已移除
 * `temperature` / `top_p` / `top_k`，传了直接 400。控制推理深度的旋钮是 `effort`，
 * 所以 {@link ModelSpec} 带的是 effort 而不是 temperature。
 *
 * ── 记账为什么值得这么多代码 ──────────────────────────────────────────
 * `tok_in` / `tok_out` / `cache_read` / `cache_write` / `usd` 直接进 `llm_usage`
 * 账本（`store/types.ts` 的 `UsageRow`）和用户看到的费用。这一层有三种**不报错、
 * 只是数字不对**的错法，每一种都在 Python 侧真发生过：
 *
 *   - 重试三回只记最后一次（账做小到三分之一）；
 *   - 重放时照记不误（resume 一次账单翻倍，而 resume 是常态）；
 *   - 最终失败的调用当作没发生（连撞三次 schema 的钱凭空消失）。
 *
 * 所以 `fired` 那个闭包状态、`emit` 与 `spend` 的分离、失败路径上的 `_logUsage`
 * 都不是啰嗦 —— 少任何一块就回到上面某一种。
 */

import { Budget, roundHalfEven } from "./budget.js";
import { Difficulty } from "./dag.js";
import { HarnessError, pyRepr } from "./errors.js";
import { EventKind } from "./events.js";
import { sha256Hex } from "./ids.js";
import { estTokens } from "./memory/types.js";

// ══════════════════════════════════════════════════════════════════
//  异常
// ══════════════════════════════════════════════════════════════════

/** 模型调用失败或输出不合 schema。 */
export class ModelError extends HarnessError {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
    Object.setPrototypeOf(this, ModelError.prototype);
  }
}

/**
 * 输出被截断的迹象。这类失败重试同样的预算是没用的，必须加大。
 *
 * 前六条是 Python 原件里的（CPython `json` 的报错文案 + 我们自己的中文消息）。
 * **后面那批是 V8 的对应物**：同一个坏输入，CPython 说 `Expecting value`，V8 说
 * `Unexpected end of JSON input`；照抄 Python 的列表在 TS 上一条都命中不了，
 * 后果是「截断就加大预算重试」这条**静默失效** —— 密集材料（上百节点的流程图）
 * 按初始预算必然截断，然后连撞三次、整条链路失败，而账上看起来一切正常。
 *
 * 两边保留的理由：Python 时代的 journal / 事件日志里存的是 CPython 的字符串，
 * 重放时还会被这个函数分类一次。
 *
 * 映射关系（golden 里 `parse_json[*].truncated` 两边逐条比对过）：
 *   CPython `Expecting value`                        ← V8 `Unexpected end of JSON input`
 *                                                      / `is not valid JSON`
 *   CPython `Unterminated string starting at`        ← V8 `Unterminated string`
 *   CPython `Expecting ',' delimiter`                ← V8 `Expected ',' or`
 *   CPython `Expecting property name enclosed in …`  ← V8 `Expected property name`
 *                                                      / `Expected double-quoted property name`
 */
export const TRUNC_HINT: readonly string[] = [
  "不完整",
  "截断",
  "Unterminated",
  "Expecting value",
  "Expecting ',' delimiter",
  "Expecting property name",
  // ── V8（Node 20+）的 JSON.parse 报错 ──
  "Unexpected end of JSON input",
  "is not valid JSON",
  "Expected ',' or",
  "Expected property name",
  "Expected double-quoted property name",
];

/** Python `_looks_truncated`。 */
export function looksTruncated(err: string): boolean {
  return TRUNC_HINT.some((h) => err.includes(h));
}

/**
 * 思考型模型把 max_tokens 全花在推理上，没留下正文。
 *
 * **可恢复**：加大预算重试就行，不是模型不会做。会思考的模型（gemini-2.5+ /
 * o 系列等）推理 token 也计入 max_tokens，密集内容（一张上百节点的流程图）
 * 按老预算必然被截断 —— 直接失败等于这份材料白传。
 */
export class ModelTruncated extends ModelError {
  /** 截断也是打过一次、也计费了。后端拿得到用量就挂在这里，网关会照记。 */
  usage?: Usage;

  constructor(message: string, usage?: Usage) {
    super(message);
    this.name = "ModelTruncated";
    if (usage !== undefined) this.usage = usage;
    Object.setPrototypeOf(this, ModelTruncated.prototype);
  }
}

/**
 * 网关账户余额/配额耗尽。**不可重试** —— 退避多少次都一样。
 *
 * 与限流刻意分成两类异常，因为二者共用 429 却要走完全相反的处理：限流退避
 * 几秒就好，欠费退避到天亮也一样。以前统一当瞬时故障重试，用户先白等三轮
 * 退避、再收到一句 `HTTP 429` —— 既看不出是没钱，也不知道该去哪充。
 */
export class QuotaExhausted extends ModelError {
  /** 网关原文（截断到 300 **码点**），给人看的第一手证据。 */
  readonly detail: string;
  /** 触发的 HTTP 状态码（402 / 429），0 表示不是 HTTP 层拿到的。 */
  readonly status: number;

  constructor(model: string, detail: string, status = 0) {
    // Python 是 `(detail or "").strip()[:300]`。切片按**码点** —— 中文一个字一个
    // 码点，用 UTF-16 的 `slice` 在 300 处撞上代理对就会切出半个字符。
    const trimmed = (detail || "").trim();
    const cut = [...trimmed].slice(0, 300).join("");
    const where = status ? `HTTP ${status}` : "网关响应";
    super(`${model} 网关账户余额/配额已耗尽（${where}）：${cut}`);
    this.detail = cut;
    this.status = status;
    this.name = "QuotaExhausted";
    Object.setPrototypeOf(this, QuotaExhausted.prototype);
  }
}

/**
 * 安全分类器拒绝了请求。
 *
 * 不是 HTTP 错误 —— 返回的是 200 + `stop_reason="refusal"`。本体建模场景极少
 * 触发，但材料里若混入安全相关内容（渗透测试报告、生物实验数据）可能命中。
 */
export class ModelRefusal extends ModelError {
  readonly category: string | null;

  constructor(model: string, category: string | null) {
    // Python 是 `category or '未标注'`：空串同样落到"未标注"，别写成 `?? `。
    super(`${model} 拒绝了该请求（类别: ${category || "未标注"}）`);
    this.category = category;
    this.name = "ModelRefusal";
    Object.setPrototypeOf(this, ModelRefusal.prototype);
  }
}

// ══════════════════════════════════════════════════════════════════
//  ModelSpec / Usage / Completion
// ══════════════════════════════════════════════════════════════════

/**
 * 一个模型档位。
 *
 * 纯数据（Python 侧是 `frozen=True, slots=True` 的 dataclass），所以是 interface +
 * 工厂，不是 class：它要进 catalog、进路由表、进 golden 的 JSON 往返。
 */
export interface ModelSpec {
  readonly name: string;
  /** "small" | "mid" | "frontier" */
  readonly tier: string;
  readonly usd_per_mtok_in: number;
  readonly usd_per_mtok_out: number;
  /** 推理深度。`null` 表示该模型**不支持** effort 参数（传了会 400）。 */
  readonly effort: string | null;
  /** 是否显式开启自适应思考。`null` 表示不下发 thinking 字段。 */
  readonly thinking: boolean | null;
}

/** dataclass 的默认值搬到工厂里 —— 不写成 class field，见契约的约定表。 */
export function makeModelSpec(
  p: Pick<ModelSpec, "name" | "tier" | "usd_per_mtok_in" | "usd_per_mtok_out"> &
    Partial<ModelSpec>,
): ModelSpec {
  return {
    name: p.name,
    tier: p.tier,
    usd_per_mtok_in: p.usd_per_mtok_in,
    usd_per_mtok_out: p.usd_per_mtok_out,
    // Python 的默认值是 effort="high" / thinking=True。用 `?? ` 而不是 `||`：
    // `effort: null` 是**显式的能力声明**（Flash/Haiku 不支持 effort），
    // 被默认值悄悄改回 "high" 就是每次请求 400。
    effort: p.effort !== undefined ? p.effort : "high",
    thinking: p.thinking !== undefined ? p.thinking : true,
  };
}

/**
 * 含缓存计价。缓存读约 0.1×，缓存写约 1.25×（5 分钟 TTL）。
 *
 * **运算顺序照抄** —— 四项先各自相乘再相加、最后统一除 1e6。浮点加法不满足
 * 结合律，把除法提前或者合并同类项都会在最后几位上与 Python 分叉，而这个数
 * 会进账本、进 `round(x, 5)` 之后的事件 payload。
 */
export function modelCost(
  spec: ModelSpec,
  tokIn: number,
  tokOut: number,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  return (
    (tokIn * spec.usd_per_mtok_in +
      cacheRead * spec.usd_per_mtok_in * 0.1 +
      cacheWrite * spec.usd_per_mtok_in * 1.25 +
      tokOut * spec.usd_per_mtok_out) /
    1e6
  );
}

/** `Usage.to_dict()` 的形状。键名 snake_case —— 它直接进 `UsageRow` 与事件 payload。 */
export interface UsageDict {
  tok_in: number;
  tok_out: number;
  cache_read: number;
  cache_write: number;
  usd: number | null;
}

/**
 * 一次（或一组）模型响应的用量。
 *
 * **是 class 不是 interface**：`bill()` 会就地累加一个 `Usage`（"这次逻辑调用的
 * 全部尝试之和"），有行为、有可变状态，按契约走 class + 显式 toDict/fromDict。
 */
export class Usage {
  tok_in: number;
  tok_out: number;
  cache_read: number;
  cache_write: number;
  /**
   * 网关回报的**真实成本**（美元）。有就用它，没有才回退到本地定价表估算 ——
   * 定价表会过期，网关的账单不会。
   *
   * `null` 的含义是"网关没给"，不是"零元"。这个区分决定界面敢不敢把金额当钱显示。
   */
  usd: number | null;

  constructor(init: Partial<UsageDict> = {}) {
    this.tok_in = init.tok_in ?? 0;
    this.tok_out = init.tok_out ?? 0;
    this.cache_read = init.cache_read ?? 0;
    this.cache_write = init.cache_write ?? 0;
    this.usd = init.usd ?? null;
  }

  get total(): number {
    return this.tok_in + this.tok_out + this.cache_read + this.cache_write;
  }

  toDict(): UsageDict {
    return {
      tok_in: this.tok_in,
      tok_out: this.tok_out,
      cache_read: this.cache_read,
      cache_write: this.cache_write,
      usd: this.usd,
    };
  }

  /** Python 侧是 `Usage(**raw)`：缺的键走默认值，多的键会抛。这里只取认识的。 */
  static fromDict(d: Partial<UsageDict> | null | undefined): Usage {
    return new Usage(d ?? {});
  }
}

/** 一次逻辑调用的结果。纯数据 → interface + 工厂。 */
export interface Completion {
  readonly text: string;
  /** schema 校验后的结构化结果。 */
  readonly data: unknown;
  readonly model: string;
  readonly usage: Usage;
  readonly usd: number;
  readonly attempts: number;
}

export function makeCompletion(p: Partial<Completion> & Pick<Completion, "text">): Completion {
  return {
    text: p.text,
    data: p.data ?? null,
    model: p.model ?? "",
    usage: p.usage ?? new Usage(),
    usd: p.usd ?? 0.0,
    attempts: p.attempts ?? 1,
  };
}

// ══════════════════════════════════════════════════════════════════
//  后端协议
// ══════════════════════════════════════════════════════════════════

export interface GenerateArgs {
  readonly model: ModelSpec;
  readonly prompt: string;
  readonly system?: string;
  readonly schema?: Record<string, unknown> | null;
  readonly maxTokens?: number;
  readonly cacheSystem?: boolean;
  /**
   * base64 data URI 列表。只有具备 VISION 能力的模型能收 —— 发给纯文本模型会被
   * 网关拒（这正是能力发现的信号来源）。
   */
  readonly images?: readonly string[] | null;
}

/** 真正调模型的地方。网关只管路由、记账、校验。 */
export interface LLMBackend {
  /** 返回 `[文本, 用量]`。 */
  generate(args: GenerateArgs): Promise<[string, Usage]>;
}

/** ScriptedBackend 的一条规则：`[Python 风格的正则源码 或 RegExp, 响应]`。 */
export type ScriptedRule = readonly [string | RegExp, string | ((prompt: string) => string)];

/** ScriptedBackend 记下的一次调用。 */
export interface ScriptedCall {
  readonly model: string;
  readonly prompt: string;
  readonly schema: boolean;
  readonly images: number;
}

/**
 * 测试与离线 demo 用的后端。
 *
 * 按 `[模式, 响应]` 顺序匹配 prompt，匹配不到走 `default`。完全确定性 ——
 * 这让整条流水线可以在没有 API key 的情况下端到端跑通并断言。
 */
export class ScriptedBackend implements LLMBackend {
  readonly rules: ScriptedRule[];
  default: string;
  readonly calls: ScriptedCall[] = [];

  constructor(rules: readonly ScriptedRule[] = [], defaultBody = "{}") {
    this.rules = [...rules];
    this.default = defaultBody;
  }

  generate(args: GenerateArgs): Promise<[string, Usage]> {
    const images = args.images ?? [];
    this.calls.push({
      model: args.model.name,
      prompt: args.prompt,
      schema: Boolean(args.schema),
      images: images.length,
    });
    let body = this.default;
    for (const [pattern, resp] of this.rules) {
      // Python 是 `re.search(pattern, prompt, re.DOTALL)`。`s` 标志对齐 DOTALL；
      // 两家正则方言在**这里用到的子集**（字面量、`.`、量词、字符类）上一致，
      // Python 专属语法（`(?P<n>…)`、`\Z`、条件组）不适用 —— 需要时直接传 RegExp。
      const re = typeof pattern === "string" ? new RegExp(pattern, "s") : pattern;
      if (re.test(args.prompt)) {
        body = typeof resp === "function" ? resp(args.prompt) : resp;
        break;
      }
    }
    const system = args.system ?? "";
    return Promise.resolve([
      body,
      new Usage({ tok_in: estTokens(system + args.prompt), tok_out: estTokens(body) }),
    ]);
  }
}

// ══════════════════════════════════════════════════════════════════
//  路由表
// ══════════════════════════════════════════════════════════════════

/**
 * 生产路由。Haiku 4.5 不支持 effort/adaptive thinking，所以两个字段都置空 ——
 * 传了会直接报错，这是模型代际差异，必须在路由表里显式表达。
 */
export const PRODUCTION_MODELS: Readonly<Record<string, ModelSpec>> = {
  small: makeModelSpec({
    name: "claude-haiku-4-5",
    tier: "small",
    usd_per_mtok_in: 1.0,
    usd_per_mtok_out: 5.0,
    effort: null,
    thinking: null,
  }),
  mid: makeModelSpec({
    name: "claude-sonnet-5",
    tier: "mid",
    usd_per_mtok_in: 3.0,
    usd_per_mtok_out: 15.0,
    effort: "medium",
  }),
  frontier: makeModelSpec({
    name: "claude-opus-5",
    tier: "frontier",
    usd_per_mtok_in: 5.0,
    usd_per_mtok_out: 25.0,
    effort: "high",
  }),
  /** CRITICAL 档：口径冲突判定这类错了代价最大的判断，用最高档推理。 */
  frontier_deep: makeModelSpec({
    name: "claude-opus-5",
    tier: "frontier",
    usd_per_mtok_in: 5.0,
    usd_per_mtok_out: 25.0,
    effort: "xhigh",
  }),
};

/**
 * 自定义聚合网关上的模型（OpenRouter 命名）。定价只用于预算估算的兜底 ——
 * 网关每次都回报真实成本，那个优先。
 *
 * 生成侧是"便宜档 Gemini Flash + 高难度档 Claude Sonnet"的混合路由：
 *   - LOW / MEDIUM   → google/gemini-3.5-flash（快、便宜；Flash 不支持 effort/思考）
 *   - HIGH / CRITICAL → anthropic/claude-sonnet-5（保留推理深度）
 * 难度分档除了切模型，还会放大 critic 轮数与自洽采样（见 {@link RoutingTable}），
 * 所以即便 LOW/MEDIUM 是同一个模型，难度依然影响循环强度。
 */
export const GATEWAY_MODELS: Readonly<Record<string, ModelSpec>> = {
  // Gemini 3.5 Flash：便宜档主力。Flash 不支持 effort / 自适应思考，两个字段
  // 都置空 —— 传了会 400。
  flash: makeModelSpec({
    name: "google/gemini-3.5-flash",
    tier: "mid",
    usd_per_mtok_in: 1.0,
    usd_per_mtok_out: 4.0,
    effort: null,
    thinking: null,
  }),
  // 同一个 Flash，但把推理压到最低档 —— 给"猜三条推荐问题"这种锦上添花的调用。
  // 这个端点**关不掉思考**（reasoning.enabled=false / max_tokens=0 / effort=none
  // 一律 400："Reasoning is mandatory for this endpoint"），但 minimal 认。
  // 实测同一句提示：不带 reasoning 7.8s / 934 出 token，minimal 3.5s / 202。
  flash_min: makeModelSpec({
    name: "google/gemini-3.5-flash",
    tier: "mid",
    usd_per_mtok_in: 1.0,
    usd_per_mtok_out: 4.0,
    effort: "minimal",
    thinking: null,
  }),
  // 高难度档暂用 Sonnet。Sonnet 支持 effort，CRITICAL 给更深的 xhigh，
  // 保留"错了代价最大的判断用更深推理"这条纪律。
  sonnet: makeModelSpec({
    name: "anthropic/claude-sonnet-5",
    tier: "mid",
    usd_per_mtok_in: 3.0,
    usd_per_mtok_out: 15.0,
    effort: "high",
  }),
  sonnet_deep: makeModelSpec({
    name: "anthropic/claude-sonnet-5",
    tier: "mid",
    usd_per_mtok_in: 3.0,
    usd_per_mtok_out: 15.0,
    effort: "xhigh",
  }),
  // 评委刻意跨厂商 —— 同族自评正是 LLM-as-judge 综述点名的自我增强偏差来源。
  // judgeFor 按模型名剔除与生成者同名的评委：Gemini 生成 → 落到 GPT；
  // Sonnet 生成 → GPT / Gemini 皆可。两条路径都保持跨厂商。
  judge_openai: makeModelSpec({
    name: "openai/gpt-5.5",
    tier: "frontier",
    usd_per_mtok_in: 5.0,
    usd_per_mtok_out: 25.0,
    effort: "high",
  }),
  judge_google: makeModelSpec({
    name: "google/gemini-3.5-flash",
    tier: "mid",
    usd_per_mtok_in: 1.0,
    usd_per_mtok_out: 4.0,
    effort: null,
    thinking: null,
  }),
};

/** 难度档 → 键名（供设置页/覆盖用）。 */
export const TIER_KEYS: Readonly<Record<string, Difficulty>> = {
  low: Difficulty.LOW,
  medium: Difficulty.MEDIUM,
  high: Difficulty.HIGH,
  critical: Difficulty.CRITICAL,
};

/** 各档"意图 effort"。仅当所选模型**支持** effort 时才下发，否则一律 null。 */
export const TIER_EFFORT: Readonly<Record<Difficulty, string | null>> = {
  [Difficulty.LOW]: null,
  [Difficulty.MEDIUM]: "medium",
  [Difficulty.HIGH]: "high",
  [Difficulty.CRITICAL]: "xhigh",
};

const DEFAULT_MAX_ITERATIONS: Readonly<Record<Difficulty, number>> = {
  [Difficulty.LOW]: 1,
  [Difficulty.MEDIUM]: 4,
  [Difficulty.HIGH]: 12,
  [Difficulty.CRITICAL]: 12,
};
const DEFAULT_CRITIC_ROUNDS: Readonly<Record<Difficulty, number>> = {
  [Difficulty.LOW]: 0,
  [Difficulty.MEDIUM]: 1,
  [Difficulty.HIGH]: 2,
  [Difficulty.CRITICAL]: 3,
};
/** CRITICAL 档的自洽采样数。 */
const DEFAULT_SELF_CONSISTENCY: Readonly<Record<Difficulty, number>> = {
  [Difficulty.LOW]: 1,
  [Difficulty.MEDIUM]: 1,
  [Difficulty.HIGH]: 1,
  [Difficulty.CRITICAL]: 3,
};

export interface RoutingTableInit {
  readonly models?: Partial<Record<Difficulty, ModelSpec>>;
  readonly judges?: readonly ModelSpec[];
  readonly fast?: ModelSpec | null;
  readonly maxIterations?: Partial<Record<Difficulty, number>>;
  readonly criticRounds?: Partial<Record<Difficulty, number>>;
  readonly selfConsistency?: Partial<Record<Difficulty, number>>;
}

/**
 * 难度 → 模型 + 循环参数（架构文档 §4.2.3）。
 *
 * 字段**可变**：`gw.routing.judges = [...]` 是既有调用方式（换评委池不必重建路由）。
 */
export class RoutingTable {
  models: Partial<Record<Difficulty, ModelSpec>>;
  /** 评委池。{@link judgeFor} 会剔除与生成者同名的，保证异构。 */
  judges: ModelSpec[];
  /**
   * 辅助调用（推荐问题这类锦上添花的）用的"最低推理档"。`null` = 这套路由没有
   * 这一档，调用方照常按难度路由。
   *
   * 为什么是路由表的一格而不是调用处的一个参数：能不能压推理、压到哪一档
   * 是**厂商/网关的事实**（同一个 effort 字符串在另一家后端是 400），只有
   * 路由函数知道自己接的是谁。
   */
  fast: ModelSpec | null;
  maxIterations: Partial<Record<Difficulty, number>>;
  criticRounds: Partial<Record<Difficulty, number>>;
  selfConsistency: Partial<Record<Difficulty, number>>;

  constructor(init: RoutingTableInit = {}) {
    // 每次新对象，别共享引用（Python 的 default_factory 同理）。
    this.models = { ...(init.models ?? {}) };
    this.judges = [...(init.judges ?? [])];
    this.fast = init.fast ?? null;
    this.maxIterations = { ...DEFAULT_MAX_ITERATIONS, ...(init.maxIterations ?? {}) };
    this.criticRounds = { ...DEFAULT_CRITIC_ROUNDS, ...(init.criticRounds ?? {}) };
    this.selfConsistency = { ...DEFAULT_SELF_CONSISTENCY, ...(init.selfConsistency ?? {}) };
  }

  modelFor(d: Difficulty): ModelSpec {
    const spec = this.models[d];
    if (spec === undefined) throw new ModelError(`难度 ${d} 未配置模型`);
    return spec;
  }

  /** 挑一个与生成者不同的评委。 */
  judgeFor(generator: ModelSpec, salt = 0): ModelSpec {
    const pool = this.judges.filter((m) => m.name !== generator.name);
    if (pool.length === 0) {
      throw new ModelError(
        `没有可用的异构评委（生成模型 ${generator.name}）。` +
          "同模型自评会引入自我增强偏差，网关拒绝这么做。",
      );
    }
    // Python 的 `%` 对负数给非负余数（`-1 % 2 == 1`），JS 给 `-1` —— 直接下标
    // 就是 undefined。salt 由调用方给（多视角 critic 的编号），负数不是不可能。
    const idx = ((salt % pool.length) + pool.length) % pool.length;
    return pool[idx]!;
  }
}

/** 接真实模型的路由表。 */
export function productionRouting(): RoutingTable {
  const m = PRODUCTION_MODELS;
  return new RoutingTable({
    models: {
      [Difficulty.LOW]: m["small"]!,
      [Difficulty.MEDIUM]: m["mid"]!,
      [Difficulty.HIGH]: m["frontier"]!,
      [Difficulty.CRITICAL]: m["frontier_deep"]!,
    },
    // 评委跨模型族：opus 生成 → sonnet 评，sonnet 生成 → opus 评。
    judges: [m["mid"]!, m["frontier"]!],
  });
}

/** 目录卡片里本模块真正读到的那一小块（`kernel/catalog.ts` 还没落地）。 */
export interface CatalogCardLike {
  readonly spec: ModelSpec;
}

export interface CatalogLike {
  get(name: string): CatalogCardLike | null | undefined;
}

/**
 * 把"某档选某模型"落成 ModelSpec，**服务端派生 effort**。
 *
 * 关键安全点：不支持 effort 的模型（Flash/Haiku/deepseek…）必须 effort=null，
 * 否则后端把 effort 下发给网关会直接 400。用目录卡片的 `spec.effort` 是否为 null
 * 判断能力 —— 不引 Capability，避免与 catalog 形成循环依赖。
 */
export function overrideSpec(
  modelName: string,
  catalog: CatalogLike | null | undefined,
  diff: Difficulty,
): ModelSpec {
  const card = catalog != null ? catalog.get(modelName) : null;
  if (card == null) {
    // 目录里没有 → 保守：无 effort、中档定价（定价只用于兜底估算）。
    return makeModelSpec({
      name: modelName,
      tier: "mid",
      usd_per_mtok_in: 3.0,
      usd_per_mtok_out: 15.0,
      effort: null,
      thinking: null,
    });
  }
  const supportsEffort = card.spec.effort !== null;
  return makeModelSpec({
    name: modelName,
    tier: card.spec.tier,
    usd_per_mtok_in: card.spec.usd_per_mtok_in,
    usd_per_mtok_out: card.spec.usd_per_mtok_out,
    effort: supportsEffort ? TIER_EFFORT[diff] : null,
    thinking: supportsEffort ? true : null,
  });
}

/**
 * 接自定义聚合网关的路由表。
 *
 * 生成侧默认混合路由：LOW/MEDIUM 走 Gemini 3.5 Flash（快、省），HIGH/CRITICAL 走
 * Claude Sonnet（保留推理深度，CRITICAL 用更深 effort）。
 *
 * `modelOverrides` 形如 `{"low"|"medium"|"high"|"critical": "厂商/模型"}`，由管理员
 * 在设置页选定、按需覆盖各档模型；`catalog` 用来查模型能力/定价。effort 一律
 * **服务端派生**（见 {@link overrideSpec}），UI 不碰 effort。
 *
 * 评委保持代码默认（GPT / Gemini，跨厂商），**不暴露给 UI**：judgeFor 按名剔除
 * 与生成者同名的评委，所以两条生成路径都始终有异构评委 —— 缓解 LLM-as-judge
 * 综述里点名的自我增强偏差。
 */
export function gatewayRouting(
  modelOverrides?: Record<string, string> | null,
  catalog?: CatalogLike | null,
): RoutingTable {
  const m = GATEWAY_MODELS;
  const tiers: Partial<Record<Difficulty, ModelSpec>> = {
    [Difficulty.LOW]: m["flash"]!,
    [Difficulty.MEDIUM]: m["flash"]!,
    [Difficulty.HIGH]: m["sonnet"]!,
    [Difficulty.CRITICAL]: m["sonnet_deep"]!,
  };
  for (const [key, diff] of Object.entries(TIER_KEYS)) {
    const name = (modelOverrides ?? {})[key];
    if (name) tiers[diff] = overrideSpec(name, catalog, diff);
  }

  const judges = [m["judge_openai"]!, m["judge_google"]!];
  // 防御：任一档的生成者都必须留得下至少一个异构评委，否则 judgeFor 会在运行时
  // 抛错。默认双评委不同名，覆盖也不可能把两个都撞上，这里显式兜底。
  //
  // Python 是 `for spec in set(tiers.values())`（frozen dataclass 有值相等，所以
  // 是按值去重）。JS 的 Set 按引用去重，同名不同对象会重复检查 —— 结果一样（判据
  // 只看 name），但顺序确定：按 LOW→CRITICAL，而 Python 的 set 顺序是哈希序。
  // 这只影响"多个档同时无评委时报的是哪一个"，两边都不该被依赖。
  const seen = new Set<string>();
  for (const spec of Object.values(tiers)) {
    if (spec === undefined || seen.has(spec.name)) continue;
    seen.add(spec.name);
    if (!judges.some((j) => j.name !== spec.name)) {
      throw new ModelError(
        `${spec.name} 没有可用的异构评委（评委池：` +
          `[${judges.map((j) => pyRepr(j.name)).join(", ")}]）`,
      );
    }
  }
  // fast 只用于辅助调用，不跟着 modelOverrides 走 —— 管理员在设置页选的是
  // "干活用哪个模型"，不该顺带把"猜三条提示"也换成一个贵且慢的。
  return new RoutingTable({ models: tiers, judges, fast: m["flash_min"]! });
}

/** 离线 demo / 测试用。模型名带 stub 前缀，避免误连真实 API。 */
export function stubRouting(): RoutingTable {
  const s = {
    small: makeModelSpec({
      name: "stub-small",
      tier: "small",
      usd_per_mtok_in: 0.8,
      usd_per_mtok_out: 4.0,
      effort: null,
      thinking: null,
    }),
    mid: makeModelSpec({
      name: "stub-mid",
      tier: "mid",
      usd_per_mtok_in: 3.0,
      usd_per_mtok_out: 15.0,
      effort: "medium",
    }),
    frontier: makeModelSpec({
      name: "stub-frontier",
      tier: "frontier",
      usd_per_mtok_in: 5.0,
      usd_per_mtok_out: 25.0,
      effort: "high",
    }),
    deep: makeModelSpec({
      name: "stub-frontier",
      tier: "frontier",
      usd_per_mtok_in: 5.0,
      usd_per_mtok_out: 25.0,
      effort: "xhigh",
    }),
    judge: makeModelSpec({
      name: "stub-judge",
      tier: "mid",
      usd_per_mtok_in: 3.0,
      usd_per_mtok_out: 15.0,
      effort: "high",
    }),
  };
  return new RoutingTable({
    models: {
      [Difficulty.LOW]: s.small,
      [Difficulty.MEDIUM]: s.mid,
      [Difficulty.HIGH]: s.frontier,
      [Difficulty.CRITICAL]: s.deep,
    },
    judges: [s.judge, s.mid],
  });
}

// ══════════════════════════════════════════════════════════════════
//  网关
// ══════════════════════════════════════════════════════════════════

/**
 * Recorder 里被本模块用到的那一小块。
 *
 * **为什么是结构化接口而不是 `import { Recorder }`**：`kernel/recorder.ts` 与本
 * 文件在同一波并行迁移里各自落地。这里只声明真正依赖的最小面 —— 与
 * `kernel/bus/bus.ts` 的 `RecorderLike`、`kernel/tools.ts` 的 `ToolRecorder` 是
 * 同一套做法。若签名对不上，以 Recorder 为准改这里，别去改 Recorder。
 *
 * 已用一次性 probe 验过：落地后的 `Recorder` **结构上满足**这个接口
 * （`const x: LlmRecorder = recorder` 编译通过）。之所以仍不直接 import：这一波
 * 六个 agent 并写，把别人的文件拉进本模块的类型图，一次中途保存就能让本 track
 * 的 tsc 假红。等这一波收完由主 agent 收敛成 `import type` 即可。
 */
export interface LlmRecorder {
  readonly runId?: string;
  emit(
    kind: EventKind,
    opts: { nodeId?: string; payload?: Record<string, unknown> },
  ): unknown;
  effect(
    nodeId: string,
    kind: string,
    request: Record<string, unknown>,
    fn: () => unknown | Promise<unknown>,
    opts?: { key?: string | null },
  ): Promise<unknown>;
}

/**
 * 落进用量账本的一行。键名 snake_case，字段是 `store/types.ts` 的 `UsageRow` 的
 * 子集 —— `id` / `ts` / `day` / `owner` / `session_id` / `kind` 由服务端补齐
 * （kernel 这层不认识存储，也不该认识"当前是哪个会话"）。
 */
export interface UsageSinkRow {
  readonly node_id: string;
  readonly model: string;
  readonly effort: string;
  readonly tok_in: number;
  readonly tok_out: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly usd: number;
  /** "gateway" | "estimated" */
  readonly usd_source: string;
  readonly attempts: number;
  /** "ok" | "failed" */
  readonly status: string;
  readonly run_id: string;
}

export type UsageSink = (row: UsageSinkRow) => void;

export interface ModelGatewayOptions {
  readonly routing?: RoutingTable | null;
  readonly budget?: Budget | null;
  readonly maxSchemaRetries?: number;
  readonly usageSink?: UsageSink | null;
}

export interface CallOptions {
  readonly system?: string;
  readonly difficulty?: Difficulty;
  /**
   * 给了就强制结构化输出。解析失败会带错误信息重试 `maxSchemaRetries` 次，
   * 仍失败则抛 {@link ModelError} —— **不返回半成品**，让节点的重试策略去处理。
   */
  readonly schema?: Record<string, unknown> | null;
  readonly model?: ModelSpec | null;
  /** 节点内并发调用必须给（比如四个 critic 视角同时跑）。 */
  readonly key?: string | null;
  readonly maxTokens?: number;
  readonly images?: readonly string[] | null;
}

/**
 * `doCall()` 存进 journal 的那个 dict。重放时原样读回，所以键名是**持久契约**。
 *
 * 后三个字段标成可选**不是**为了写起来方便：Python 时代的 journal 里没有
 * `billed` / `billed_usd`（那是加了重试聚合之后才有的），resume 一个旧 Run 时
 * 读回来就是缺的。声明成必填会让"回退到 usage"那条路在类型上说不通，然后被
 * 后来的人删掉 —— 那一删，旧日志重放出来的账就是最后一次尝试的钱。
 */
interface EffectResult {
  text: string;
  attempts: number;
  usage: UsageDict;
  billed?: UsageDict;
  billed_usd?: number;
  billed_usd_source?: string;
  data?: unknown;
}

/** 闭包里的"这次调用到底打没打出去"。见 {@link ModelGateway.call} 里的说明。 */
interface FiredState {
  hit: boolean;
  billed: Usage | null;
  attempts: number;
  usd: number;
  usdSource: string;
}

/** 所有模型调用的唯一入口。 */
export class ModelGateway {
  readonly backend: LLMBackend;
  readonly rec: LlmRecorder;
  routing: RoutingTable;
  readonly budget: Budget;
  readonly maxSchemaRetries: number;
  /**
   * 用量账本的落库口子。**这里是全部模型调用的唯一收口** —— judge、SmartGateway、
   * 对话、视觉 OCR、评委全都最终走 {@link call}，所以钩在这里就是 100% 覆盖。
   * kernel 不认识存储，具体怎么落由服务端注入。
   */
  readonly usageSink: UsageSink | null;

  constructor(backend: LLMBackend, recorder: LlmRecorder, opts: ModelGatewayOptions = {}) {
    this.backend = backend;
    this.rec = recorder;
    this.routing = opts.routing ?? stubRouting();
    this.budget = opts.budget ?? new Budget();
    this.maxSchemaRetries = opts.maxSchemaRetries ?? 2;
    this.usageSink = opts.usageSink ?? null;
  }

  /** 调一次模型。 */
  async call(nodeId: string, prompt: string, opts: CallOptions = {}): Promise<Completion> {
    const system = opts.system ?? "";
    const difficulty = opts.difficulty ?? Difficulty.MEDIUM;
    const schema = opts.schema ?? null;
    const maxTokens = opts.maxTokens ?? 16_000;
    const images = opts.images ?? null;
    const spec = opts.model ?? this.routing.modelFor(difficulty);

    const req: Record<string, unknown> = {
      model: spec.name,
      effort: spec.effort,
      thinking: spec.thinking,
      system,
      prompt,
      schema,
      // 键名保持 snake_case：这个 dict 会被 fingerprint，改一个字母就是所有历史
      // effect 都对不上（DeterminismViolation）。
      max_tokens: maxTokens,
      // 图片按内容哈希进指纹：重放要确定性，但完整 base64 塞进事件日志会撑爆它
      images: (images ?? []).map((i) => sha256Hex(i).slice(0, 16)),
    };

    // 这一次调用**有没有真的打到模型**。Recorder.effect 在重放时直接返回历史
    // 结果、根本不跑 do()，而记账必须只记真花了钱的那次 —— 否则 resume 一次
    // 账单翻一倍。闭包里置位是唯一能区分二者的信号（effect 本身不返回这个）。
    const fired: FiredState = {
      hit: false,
      billed: null,
      attempts: 0,
      usd: 0.0,
      usdSource: "estimated",
    };

    const doCall = async (): Promise<EffectResult> => {
      let lastErr = "";
      fired.hit = true;
      // **每一次重试都是真金白银。** 以前只把最后一次的 usage 带出去，于是
      // 一次调用重试三回、账上只算一回。schema 不合重试、截断加预算重试都
      // 会走到这里，密集材料上并不罕见。
      const billed = new Usage({ usd: 0.0 });

      const bill = (u: Usage): void => {
        if (fired.attempts === 0) {
          fired.usdSource = u.usd !== null ? "gateway" : "estimated";
        }
        billed.tok_in += u.tok_in;
        billed.tok_out += u.tok_out;
        billed.cache_read += u.cache_read;
        billed.cache_write += u.cache_write;
        let attemptUsd = u.usd;
        if (u.usd === null) {
          // 有的供应商在某次重试给了成本、另一次没给。已知的网关成本照收，缺的
          // 那几次用本地估算补上，然后把**整笔**标成 estimated —— 拿一个只涵盖
          // 部分尝试的网关金额冒充权威账单，比标成估算更糟。
          attemptUsd = modelCost(spec, u.tok_in, u.tok_out, u.cache_read, u.cache_write);
          fired.usdSource = "estimated";
        }
        fired.usd = fired.usd + (attemptUsd ?? 0.0);
        // Usage.usd 的含义是"供应商回报的真实成本"。这个契约要守住：混合/估算出来
        // 的聚合值让 usage.usd 保持 null，金额由下面确定性的 billed_usd 字段带给
        // Budget。
        billed.usd = fired.usdSource === "gateway" ? fired.usd : null;
        fired.billed = billed;
        fired.attempts = fired.attempts + 1;
      };

      // 思考型模型的推理 token 也计进 max_tokens：密集内容（上百节点的流程图）
      // 按初始预算必然被截断成"只有推理、没有正文"。那不是模型不会做，是预算
      // 给小了 —— 逐次加大重试，而不是让这份材料白传。
      let budget = maxTokens;
      for (let attempt = 0; attempt < 1 + this.maxSchemaRetries; attempt++) {
        const p =
          attempt === 0
            ? prompt
            : `${prompt}\n\n【上次输出不合要求】${lastErr}\n` +
              "请只输出符合 schema 的 JSON，不要任何解释文字。";
        let text: string;
        let usage: Usage;
        try {
          [text, usage] = await this.backend.generate({
            model: spec,
            prompt: p,
            system,
            schema,
            maxTokens: budget,
            images,
          });
        } catch (exc) {
          // **只有截断值得重发。** 这个分支千万别放宽成 `instanceof ModelError`：
          // QuotaExhausted 也是 ModelError 的子类，一旦落进这里，欠费就又变成
          // "白等几轮再报一句看不懂的错"。
          if (!(exc instanceof ModelTruncated)) throw exc;
          // 截断也是打过一次、也计费了；exc 带不带 usage 都要留个痕
          bill(exc.usage ?? new Usage());
          if (attempt >= this.maxSchemaRetries) throw exc;
          budget = Math.min(budget * 3, 64_000);
          lastErr = exc.message;
          continue;
        }
        bill(usage);
        const out = {
          text,
          attempts: attempt + 1,
          usage: usage.toDict(),
          billed: billed.toDict(),
          billed_usd: fired.usd,
          billed_usd_source: fired.usdSource,
        };
        if (schema === null) return { ...out, data: null };
        try {
          const data = parseModelJson(text);
          validateAgainstSchema(data, schema);
          return { ...out, data };
        } catch (exc) {
          // Python 是 `except (ValueError, TypeError)` —— 这两个正是
          // `_parse_json` / `_validate` 故意抛的两类。JS 没有对应的分类，只能
          // 反着来：**除了模型层异常一律当成"输出不合要求"**。ModelError 必须
          // 放行，否则 QuotaExhausted 之类会被当成 schema 问题白重试。
          if (exc instanceof ModelError) throw exc;
          lastErr = exc instanceof Error ? exc.message : String(exc);
          // 输出被**截断**（JSON 没写完）和"格式写错了"是两回事：前者重试多少次
          // 都一样，除非把预算加大。密集内容 + 会思考的模型尤其容易撞上 ——
          // 实测 recommend 用 400 token 连撞三次全是「JSON 不完整」，然后整条
          // 链路失败。
          if (looksTruncated(lastErr)) budget = Math.min(budget * 3, 64_000);
        }
      }
      throw new ModelError(
        `${spec.name} 连续 ${1 + this.maxSchemaRetries} 次输出不合 schema: ${lastErr}`,
      );
    };

    let raw: EffectResult;
    try {
      raw = (await this.rec.effect(nodeId, "llm.call", req, doCall, {
        key: opts.key ?? null,
      })) as EffectResult;
    } catch (exc) {
      // **打出去了但最终失败的那些次也花了钱。** 以前这里什么都不记，于是
      // 一次连撞三回 schema 然后放弃的调用，在账上等于没发生过。
      this.logUsage(nodeId, spec, fired, "failed");
      const failedBilled = fired.billed ?? new Usage();
      this.chargeUsage(nodeId, spec, failedBilled, {
        attempts: fired.attempts || 1,
        status: "failed",
        emit: fired.hit,
        usd: fired.usd || 0.0,
      });
      throw exc;
    }

    // `usage` 是最后一次模型响应的历史字段；`billed` 才是这个逻辑调用的真实
    // 总花费（含 schema/截断重试）。旧 journal 没有 billed 时回退到 usage，
    // 保证升级后仍能确定性重放。
    // Python 是 `raw.get("billed") or raw["usage"]` —— **空 dict 在 Python 是假值**，
    // 所以这里也走真值判断而不是 `??`。旧日志里什么形状都可能有。
    const u = Usage.fromDict(pyTruthyContainer(raw.billed) ? raw.billed : raw.usage);
    const usd =
      raw.billed_usd === undefined ? usageCost(spec, u) : Number(raw.billed_usd);
    const comp = makeCompletion({
      text: raw.text,
      data: raw.data ?? null,
      model: spec.name,
      usage: u,
      usd,
      attempts: raw.attempts,
    });
    this.logUsage(nodeId, spec, fired, "ok");
    this.chargeUsage(nodeId, spec, u, {
      attempts: comp.attempts,
      status: "ok",
      // 回放要把新建的内存 Budget 恢复到正确水位，但 journal 已有首次
      // BUDGET_SPENT；再追加一条会让事件审计看起来像付了两次钱。
      emit: fired.hit,
      usd,
    });
    return comp;
  }

  /**
   * 把一次逻辑调用的**全部尝试**计入运行预算。
   *
   * Durable usage ledger 只在真的触发后端时写一行；Budget 则是当前进程里的运行
   * 投影，Recorder 回放时也要按历史 billed 恢复。因此 spend 与 emit 故意分开：
   * 回放 spend、但不制造第二条付费事件。
   */
  private chargeUsage(
    nodeId: string,
    spec: ModelSpec,
    usage: Usage,
    o: { attempts: number; status: string; emit: boolean; usd?: number | null },
  ): number {
    const chargedUsd = o.usd == null ? usageCost(spec, usage) : o.usd;
    this.budget.spend({ tokens: usage.total, usd: chargedUsd });
    if (o.emit) {
      this.rec.emit(EventKind.BUDGET_SPENT, {
        nodeId,
        payload: {
          model: spec.name,
          effort: spec.effort,
          tok_in: usage.tok_in,
          tok_out: usage.tok_out,
          cache_read: usage.cache_read,
          cache_write: usage.cache_write,
          // Python 的 `round(x, 5)` 是 round-half-even 且在精确有理数上做；
          // `toFixed(5)` 两条都不满足。budget.ts 已经把它移植过，复用。
          usd: roundHalfEven(chargedUsd, 5),
          attempts: o.attempts,
          status: o.status,
          level: this.budget.currentLevel(),
        },
      });
    }
    return chargedUsd;
  }

  /**
   * 把这次调用记进用量账本。**只记真打出去的那次。**
   *
   * `usageSink` 由外面注入（服务端塞一个写库的），kernel 这层不认识存储。
   * 沉不进去不该把一次模型调用带下去 —— 记账失败是记账的事。
   */
  private logUsage(
    nodeId: string,
    spec: ModelSpec,
    fired: FiredState,
    status: string,
  ): void {
    if (this.usageSink === null || !fired.hit) return;
    const u = fired.billed ?? new Usage();
    try {
      this.usageSink({
        node_id: nodeId,
        model: spec.name,
        effort: spec.effort ?? "",
        tok_in: u.tok_in,
        tok_out: u.tok_out,
        cache_read: u.cache_read,
        cache_write: u.cache_write,
        // 网关回了真实账单就用它，并**标明来源** —— 本地价目表对经网关发现的
        // 模型是编的（catalog 统一填 2.0/8.0），估出来的金额看着精确其实是错的，
        // 界面据此决定敢不敢把它当钱显示。
        usd: fired.usd || 0.0,
        usd_source: fired.usdSource || "estimated",
        attempts: fired.attempts || 1,
        status,
        run_id: this.rec.runId ?? "",
      });
    } catch {
      // 用量 sink 是旁路：库挂了不该把一次梳理带下去。
      return;
    }
  }

  /** 以评委身份调用。强制换一个模型。 */
  async judge(
    nodeId: string,
    prompt: string,
    o: {
      generator: ModelSpec;
      schema?: Record<string, unknown> | null;
      salt?: number;
      key?: string | null;
      system?: string;
    },
  ): Promise<Completion> {
    return this.call(nodeId, prompt, {
      system: o.system ?? "",
      schema: o.schema ?? null,
      model: this.routing.judgeFor(o.generator, o.salt ?? 0),
      key: o.key ?? null,
    });
  }

  // ── 路由参数 ────────────────────────────────────────────────
  iterationsFor(d: Difficulty): number {
    return this.routing.maxIterations[d] ?? 4;
  }

  criticRoundsFor(d: Difficulty, requested?: number | null): number {
    const base = requested == null ? (this.routing.criticRounds[d] ?? 1) : requested;
    return this.budget.criticRounds(base);
  }

  samplesFor(d: Difficulty): number {
    const n = this.routing.selfConsistency[d] ?? 1;
    return this.budget.allowSelfConsistency() ? n : 1;
  }
}

/** Python 的 `ModelGateway._usage_cost`。 */
export function usageCost(spec: ModelSpec, usage: Usage): number {
  return usage.usd !== null
    ? usage.usd
    : modelCost(spec, usage.tok_in, usage.tok_out, usage.cache_read, usage.cache_write);
}

// ══════════════════════════════════════════════════════════════════
//  结构化输出
// ══════════════════════════════════════════════════════════════════

// Python 的 `\s` 与 JS 的 `\s` 在这里可以互换：差集只有 U+001C..U+001F（Python 有、
// JS 没有）与 U+FEFF（JS 有、Python 没有），模型输出里出现即是别的问题。
const FENCE = /```(?:json)?\s*(.+?)\s*```/s;
const FENCE_AT_START = /^```(?:json)?\s*(.+?)\s*```\s*$/s;

/**
 * 结构化输出的形状问题。
 *
 * Python 侧 `_parse_json` / `_validate` 分别抛 `ValueError` / `TypeError`，
 * 调用点 `except (ValueError, TypeError)` 把两者一并当作"这次输出不合要求"。
 * JS 没有这层分类，所以这里把两者收进一个具名类 —— `exc` 字段留住原本是哪一种，
 * golden 里两边逐条比对（`validate[*].exc`）。
 */
export class JsonShapeError extends Error {
  /** "ValueError" | "TypeError"，对应 Python 侧抛的那个类。 */
  readonly pyType: string;

  constructor(message: string, pyType: string) {
    super(message);
    this.pyType = pyType;
    this.name = "JsonShapeError";
    Object.setPrototypeOf(this, JsonShapeError.prototype);
  }
}

/**
 * 从模型输出里抠 JSON。宽容一点：允许围栏、允许前后有零碎文字。
 *
 * 真实后端用了 `output_config.format` 强制 JSON，正常路径下一次就过；
 * 这些兜底是给 ScriptedBackend 和降级路径准备的。
 *
 * （Python 名：`_parse_json`）
 */
export function parseModelJson(text: string): unknown {
  let t = text.trim();
  // **先按整体解析。** 以前是无条件先抠围栏，而 `FENCE` 是全文搜索 —— 于是当回答
  // **内容里**含一段 ```json（比如用户就是要一份 JSON Schema 范例），那段范例会
  // 把真正的外层结构顶掉，然后拿范例去当结构化输出解析、失败三次、整轮报错。
  // 问 JSON/代码问题必挂，正常路径反而没事，很难往这想。
  const whole = tryJson(t);
  if (whole.ok) return whole.value;

  // 整体不是 JSON，才考虑围栏：**优先开头那个**（那才是模型把答案包起来的写法），
  // 找不到再退回全文里的第一个。
  const m = FENCE_AT_START.exec(t) ?? FENCE.exec(t);
  if (m) {
    const inner = m[1]!.trim();
    const parsed = tryJson(inner);
    if (parsed.ok) return parsed.value;
    t = inner;
  }
  const cands = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  // Python 的 find/rfind 数码点，JS 的 indexOf/lastIndexOf 数 UTF-16 码元 ——
  // 但两边都只把下标交给**同一门语言的**切片，取出的子串完全一致，所以这里
  // 不需要 code point 版本（`{`/`}`/`[`/`]` 都是 ASCII，不会落在代理对中间）。
  const start = cands.length > 0 ? Math.min(...cands) : -1;
  if (start < 0) throw new JsonShapeError("输出里找不到 JSON", "ValueError");
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (end <= start) throw new JsonShapeError("JSON 不完整（输出被截断）", "ValueError");
  const slice = t.slice(start, end + 1);
  const last = tryJson(slice);
  if (last.ok) return last.value;
  throw new JsonShapeError(`JSON 解析失败: ${last.message}`, "ValueError");
}

type JsonAttempt = { ok: true; value: unknown } | { ok: false; message: string };

function tryJson(s: string): JsonAttempt {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (exc) {
    // 已知且被钉住的分叉：CPython 的 `json.loads` 认 `NaN` / `Infinity` /
    // `-Infinity` 字面量，JSON.parse 不认。TS 侧因此把 `NaN` 判成"找不到 JSON"、
    // 把 `{"x": Infinity}` 判成解析失败。golden 里两条用例都留着，见测试里的说明。
    return { ok: false, message: exc instanceof Error ? exc.message : String(exc) };
  }
}

// ── Python 值的字面表示 ────────────────────────────────────────────

/** `type(x).__name__`，限于 JSON 值域。报错文案会原样喂回给模型。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (typeof v === "number") {
    // **已知分叉**：JS 里 `2` 与 `2.0` 是同一个值。Python 侧 `json.loads("2.0")`
    // 给 float、报 "float"，TS 只能报 "int"。这条只影响喂回给模型的提示词措辞，
    // 不影响判定；golden 里留着一条用例把形状钉死。
    return Number.isInteger(v) ? "int" : "float";
  }
  return "dict";
}

/**
 * Python `repr(x)` / `str(list)`，限于 JSON 值域。
 *
 * 字符串走 `errors.pyRepr`（单双引号策略 + 不可打印字符的 `\xNN`/`\uNNNN` 都在
 * 那边做过零差异比对）—— 别在这里重写一遍。
 */
export function pyReprValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return pyRepr(v);
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    // 整数值的 float 在 Python 是 "2.0"，这里只能给 "2"（同上，已知分叉）。
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.entries(rec)
    .map(([k, val]) => `${pyRepr(k)}: ${pyReprValue(val)}`)
    .join(", ")}}`;
}

/**
 * Python 的 `==`，限于 JSON 值域 —— `enum` 的 `data not in allowed` 用它。
 *
 * 两处 JS 的 `===` / `includes` 做不到的：容器按**结构**比（`{"a":1} == {"a":1}`
 * 在 Python 为真），以及 `True == 1` / `1 == 1.0` 为真。enum 里放对象少见，但
 * "判据在边角上和 Python 不一样"正是最难查的一类漂移。
 */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  const an = typeof a === "boolean" ? (a ? 1 : 0) : a;
  const bn = typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof an === "number" && typeof bn === "number") return an === bn;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEq(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const ka = Object.keys(ra);
    const kb = Object.keys(rb);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(rb, k) && pyEq(ra[k], rb[k]));
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python `if x:` 对 dict / list 的真值判断（空即假）。JS 里空对象是真值。 */
function pyTruthyContainer(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * JSON Schema 的实用子集校验。
 *
 * 只覆盖我们实际用到的：type / required / properties / items / enum。刻意不引
 * jsonschema（TS 侧同理：不引 ajv）—— 内核依赖越少越好，而且这里的错误信息要
 * 直接喂回给模型，通用校验器的报错太啰嗦。
 *
 * （Python 名：`_validate`）
 */
export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path = "$",
): void {
  const t = schema["type"];
  if (t === "object") {
    if (!isRecord(data)) {
      throw new JsonShapeError(`${path} 应为 object，实际 ${pyTypeName(data)}`, "TypeError");
    }
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const req of required) {
        // `in` 会翻原型链（"constructor" / "toString" 一律为真），Python 的
        // `req not in data` 只看自有键 —— 必须用 hasOwn。
        if (typeof req !== "string" || !Object.hasOwn(data, req)) {
          throw new JsonShapeError(
            `${path} 缺少必填字段 ${pyReprValue(req)}`,
            "ValueError",
          );
        }
      }
    }
    const props = schema["properties"];
    if (isRecord(props)) {
      for (const [k, sub] of Object.entries(props)) {
        if (Object.hasOwn(data, k) && isRecord(sub)) {
          validateAgainstSchema(data[k], sub, `${path}.${k}`);
        }
      }
    }
  } else if (t === "array") {
    if (!Array.isArray(data)) {
      throw new JsonShapeError(`${path} 应为 array，实际 ${pyTypeName(data)}`, "TypeError");
    }
    const item = schema["items"];
    // Python 是 `if item := schema.get("items")` —— **空 dict 在 Python 是假值**，
    // 在 JS 是真值。照抄成 `if (item)` 会让 `items: {}` 从"不查"变成"递归进去查"。
    if (pyTruthyContainer(item) && isRecord(item)) {
      data.forEach((v, i) => validateAgainstSchema(v, item, `${path}[${i}]`));
    }
  } else if (t === "string") {
    if (typeof data !== "string") {
      throw new JsonShapeError(`${path} 应为 string`, "TypeError");
    }
  } else if (t === "number") {
    // Python 排掉 bool（它是 int 的子类）。JS 里 `typeof true !== "number"`，
    // 自然出局 —— 但理由一样：`{"score": true}` 当成 1 分是静默的错。
    if (typeof data !== "number") {
      throw new JsonShapeError(`${path} 应为 number`, "TypeError");
    }
  } else if (t === "integer") {
    // **已知分叉**：Python 是 `isinstance(data, int)`，`2.0` 判错；JS 分不出
    // `2` 与 `2.0`，判过。golden 里钉着这条，见测试说明。
    if (typeof data !== "number" || !Number.isInteger(data)) {
      throw new JsonShapeError(`${path} 应为 integer`, "TypeError");
    }
  } else if (t === "boolean") {
    if (typeof data !== "boolean") {
      throw new JsonShapeError(`${path} 应为 boolean`, "TypeError");
    }
  }

  const allowed = schema["enum"];
  // 同上：Python 的 `if (allowed := …) and …` 里空 list 是假值 → 不查。
  if (pyTruthyContainer(allowed) && Array.isArray(allowed)) {
    if (!allowed.some((x) => pyEq(data, x))) {
      throw new JsonShapeError(
        `${path} 取值 ${pyReprValue(data)} 不在允许集合 ${pyReprValue(allowed)}`,
        "ValueError",
      );
    }
  }
}
