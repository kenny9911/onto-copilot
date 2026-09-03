/**
 * 模型能力目录与按能力路由。移植自 `kernel/catalog.py`，行为由 `golden/catalog.json`
 * 逐条钉住。
 *
 * 聚合网关上挂着几十个模型，能力参差：有的能读图，有的不支持 `response_format`，
 * 有的没有 `effort`。**按名字硬编码路由会在换模型时静默坏掉** —— 请求照发，只是
 * 某个能力悄悄没了（比如 OCR 变成了「模型看不见图，凭字段名瞎猜」）。
 *
 * 所以这里把路由的单位从"模型名"换成"**所需能力**"：调用方声明"我要能读图 + 要
 * 结构化输出"，目录给出**有序候选**，网关逐个试直到成功。
 *
 * 能力从三处合成，后者覆盖前者：
 *
 * 1. 内置声明（{@link CARDS}）—— 已知模型的静态事实；
 * 2. 运行时发现 —— `/v1/models` 的元数据；
 * 3. **失败学习** —— 网关明确回「不支持图片输入」时，把该能力从这个模型上抹掉，
 *    本进程内不再浪费一次往返。
 *
 * ── 移植时新增的三件事（Python 侧不存在这些坑）────────────────────────────
 *
 * 1. **正则的 `\s` 与 `\b` 都是重写过的**。Python 的 `\s` 比 JS 多 U+001C–U+001F、
 *    少 U+FEFF；Python 的 `\w`（也就是 `\b` 的判据）**认中文**，JS 的只认 ASCII。
 *    后者会真咬人：`\badopt\b` 遇上「采纳adopt」时 Python 不匹配（"纳"是词字符，
 *    没有边界）而 JS 匹配 —— 中英混输在这个产品里是常态，判据不能两边不一样。
 *    所以下面用 {@link PY_S} / {@link BL} / {@link BR} 拼，不直接写 `\s` / `\b`。
 * 2. **全部带 `u` 标志**。除了让 `.` 按 code point 走，`u` 下的 `i` 用简单大小写
 *    折叠（U+212A KELVIN → k），这一点反而更接近 Python 的 `re.IGNORECASE`。
 * 3. **`\d` 仍是 ASCII 的**。Python 的 `\d` 认阿拉伯-印度数字，这里没有跟 ——
 *    见文件末尾 divergence 说明，代价是模型名里出现非 ASCII 数字时判据不同，
 *    而模型名从来都是 ASCII。
 */

import { ValueError } from "./errors.js";
import { pyRepr } from "./errors.js";
import { makeModelSpec } from "./llm.js";
import type { CatalogLike, Completion, ModelSpec } from "./llm.js";
import type { CallOptions, ModelGateway } from "./llm.js";
import { ModelError } from "./llm.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义的正则零件
// ══════════════════════════════════════════════════════════════════

/** Python 的 `\s`（str 模式）。JS 的 `\s` 多 U+FEFF、少 U+001C–U+001F。 */
const PY_S = "[\\p{White_Space}\\x1c-\\x1f]";
/** Python 的 `\b`，词**首**那一侧。判据是 Python 的 `\w`，它认中文。 */
const BL = "(?<![\\p{L}\\p{N}_])";
/** Python 的 `\b`，词**尾**那一侧。 */
const BR = "(?![\\p{L}\\p{N}_])";

/** 一律 `iu`：`i` 对应 `re.IGNORECASE`，`u` 让 `.`/字符类按 code point 走。 */
function re(source: string): RegExp {
  return new RegExp(source, "iu");
}

/** `s[:n]` —— Python 按 code point 切，UTF-16 的 slice 会切出半个 emoji。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `sorted(xs)` —— Python 按 code point 比，JS 默认 sort 按 UTF-16 code unit。 */
function pySorted(xs: Iterable<string>): string[] {
  return [...xs].sort((a, b) => {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
      const ra = ia.next();
      const rb = ib.next();
      if (ra.done === true && rb.done === true) return 0;
      if (ra.done === true) return -1;
      if (rb.done === true) return 1;
      const ca = ra.value.codePointAt(0) ?? 0;
      const cb = rb.value.codePointAt(0) ?? 0;
      if (ca !== cb) return ca - cb;
    }
  });
}

/** f-string 里一个 `list[str]` 的形态：`['a', 'b']`。复用 errors 的 `pyRepr`。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** Python `str(exc)` —— 只有消息，没有类名前缀。 */
function excText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ══════════════════════════════════════════════════════════════════
//  Capability
// ══════════════════════════════════════════════════════════════════

/**
 * 模型能力。Python 侧是 `StrEnum`，所以这里是常量对象 + 字面量联合 ——
 * 值要能 JSON 往返（`to_dict()` 吐的就是这些字符串）。
 */
export const Capability = {
  /** 能读图（OCR / 扫描件 / 截图）。 */
  VISION: "vision",
  /** 支持 `response_format.json_schema`。 */
  STRUCTURED: "structured",
  /** 支持 `reasoning.effort`。 */
  EFFORT: "effort",
  /** ≥ 200k。 */
  LONG_CONTEXT: "long_context",
  /** 单位成本低，适合大批量粗活。 */
  CHEAP: "cheap",
  /**
   * 能**出图**（images 端点，与 chat completions 不是一条路）。
   *
   * 与 `VISION` 是两回事：那个是读图（把扫描件读成文字和结构），这个是画图。
   * 只用来出「汇报版」展示副本 —— 一张 PNG 点不开出处、改不了、走查走不了，
   * 永远不参与校验和交付门禁。
   */
  IMAGE_GEN: "image_gen",
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

/** 声明顺序 == Python 的 `list(Capability)`。 */
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  Capability.VISION,
  Capability.STRUCTURED,
  Capability.EFFORT,
  Capability.LONG_CONTEXT,
  Capability.CHEAP,
  // 追加在**末尾**：这个顺序被 golden 逐字节钉着（capability_values），
  // 插在中间会把既有字节全改掉，而那份 golden 记的是 Python 的事实。
  Capability.IMAGE_GEN,
]);

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITIES);

/** `Capability(v)` —— 未知值 **抛错**，不许 `as Capability` 把校验删掉。 */
export function parseCapability(v: string): Capability {
  if (CAPABILITY_SET.has(v)) return v as Capability;
  throw new ValueError(`${pyRepr(v)} is not a valid Capability`);
}

const C = Capability;
const ALL: readonly Capability[] = [C.VISION, C.STRUCTURED, C.EFFORT, C.LONG_CONTEXT];

// ══════════════════════════════════════════════════════════════════
//  ModelCard
// ══════════════════════════════════════════════════════════════════

/** 一个模型的能力与定位。纯数据 —— Python 侧是 `frozen=True, slots=True`。 */
export interface ModelCard {
  readonly spec: ModelSpec;
  readonly capabilities: ReadonlySet<Capability>;
  /** 主观质量档 1~5。同样能力下优先高档，除非调用方明确要便宜的。 */
  readonly quality: number;
  /** 提供方，用于异构评委去重（同厂商的模型不算异构）。 */
  readonly vendor: string;
}

export function makeModelCard(p: {
  spec: ModelSpec;
  capabilities: Iterable<Capability>;
  quality?: number;
  vendor?: string;
}): ModelCard {
  return {
    spec: p.spec,
    capabilities: new Set(p.capabilities),
    quality: p.quality ?? 3,
    vendor: p.vendor ?? "",
  };
}

/** `ModelCard.name` 属性。 */
export function cardName(c: ModelCard): string {
  return c.spec.name;
}

/** `set(needs) <= self.capabilities`。 */
export function cardHas(c: ModelCard, needs: Iterable<Capability>): boolean {
  for (const n of needs) if (!c.capabilities.has(n)) return false;
  return true;
}

/** `replace(self, capabilities=self.capabilities - {cap})`。 */
export function cardWithout(c: ModelCard, cap: Capability): ModelCard {
  const caps = new Set(c.capabilities);
  caps.delete(cap);
  return { spec: c.spec, capabilities: caps, quality: c.quality, vendor: c.vendor };
}

export interface ModelCardDict {
  readonly name: string;
  readonly vendor: string;
  readonly quality: number;
  readonly effort: string | null;
  readonly capabilities: readonly string[];
}

export function cardToDict(c: ModelCard): ModelCardDict {
  return {
    name: cardName(c),
    vendor: c.vendor,
    quality: c.quality,
    effort: c.spec.effort,
    capabilities: pySorted(c.capabilities),
  };
}

/** Python 的模块私有 `_card(...)`。 */
function card(
  name: string,
  vendor: string,
  quality: number,
  caps: readonly Capability[],
  o: { effort?: string | null; thinking?: boolean; pin?: number; pout?: number } = {},
): ModelCard {
  const effort = o.effort !== undefined ? o.effort : "high";
  const thinking = o.thinking ?? true;
  const hasEffort = caps.includes(C.EFFORT);
  return makeModelCard({
    spec: makeModelSpec({
      name,
      tier: quality <= 3 ? "mid" : "frontier",
      usd_per_mtok_in: o.pin ?? 3.0,
      usd_per_mtok_out: o.pout ?? 15.0,
      effort: hasEffort ? effort : null,
      thinking: hasEffort ? thinking : null,
    }),
    capabilities: caps,
    quality,
    vendor,
  });
}

/**
 * 内置声明。只写**确认过**的能力 —— 猜错一个能力的代价是运行时静默降级。
 *
 * **顺序有意义**：`select()` 的排序是稳定排序，并列项按这里的先后出。
 */
export const CARDS: readonly ModelCard[] = Object.freeze([
  // Anthropic：视觉与结构化输出都实测过
  card("anthropic/claude-opus-4.8", "anthropic", 5, ALL, { pin: 5, pout: 25 }),
  card("anthropic/claude-sonnet-5", "anthropic", 4, ALL, {
    effort: "medium",
    pin: 3,
    pout: 15,
  }),
  card("anthropic/claude-haiku-4.5", "anthropic", 2, [C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    pin: 1,
    pout: 5,
  }),
  // OpenAI：跨厂商评委的主力
  card("openai/gpt-5.5", "openai", 5, ALL, { pin: 5, pout: 25 }),
  card("openai/gpt-5.4-mini", "openai", 2, [C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    pin: 0.5,
    pout: 2,
  }),
  // Google：视觉强、便宜，适合批量 OCR
  card("google/gemini-3.5-flash", "google", 3, [C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    pin: 1,
    pout: 4,
  }),
  card("google/gemini-3.1-pro-preview", "google", 4, [C.VISION, C.STRUCTURED, C.LONG_CONTEXT], {
    pin: 3,
    pout: 12,
  }),
  // 纯文本模型：**明确不带 VISION** —— 实测 deepseek 会返回
  // "No endpoints found that support image input"
  card("deepseek/deepseek-v3.2", "deepseek", 3, [C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    effort: null,
    pin: 0.3,
    pout: 1.2,
  }),
  card("moonshotai/kimi-k2.6", "moonshot", 3, [C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    effort: null,
    pin: 0.6,
    pout: 2.5,
  }),
  card("z-ai/glm-5.2", "zhipu", 3, [C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP], {
    effort: null,
    pin: 0.5,
    pout: 2,
  }),
]);

// ══════════════════════════════════════════════════════════════════
//  失败学习的判据
// ══════════════════════════════════════════════════════════════════

/** 网关回这些话时，说明该模型确实缺某项能力，可以直接从目录里抹掉。 */
const CAPABILITY_DENIALS: readonly (readonly [RegExp, Capability])[] = [
  [re(`support${PY_S}+image|image${PY_S}+input|vision|multimodal`), C.VISION],
  [re("response_format|json_schema|structured"), C.STRUCTURED],
  [re(`reasoning|${BL}effort${BR}`), C.EFFORT],
];

const DENIAL_PRECHECK = re(
  `not${PY_S}+support|unsupported|no${PY_S}+endpoints|不支持|invalid`,
);

/** 从错误文本判断"缺的是哪项能力"。判不出来返回 null（那就是别的故障）。 */
export function denialCapability(errorText: string): Capability | null {
  // Python 是 `if not error_text or not re.search(...)`：空串直接短路。
  if (!errorText || !DENIAL_PRECHECK.test(errorText)) return null;
  for (const [pattern, cap] of CAPABILITY_DENIALS) {
    if (pattern.test(errorText)) return cap;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  从网关模型名推断能力
//  （New-API / one-api 这类聚合网关按各家原名暴露模型）
// ══════════════════════════════════════════════════════════════════
// 内置 CARDS 写的是固定名字，对不上网关实际暴露的 id（gpt-4o、gemini-2.5-flash、
// claude-3-5-sonnet…）。发现时靠名字把网关真有的模型补进目录，尤其视觉 —— 认不出
// 带视觉的模型，扫描件就永远 OCR 不了。

const NOT_CHAT_RE = re(
  "embedding|whisper|tts|dall-?e|stable-?diffusion|" +
    `${BL}flux${BR}|midjourney|` +
    "rerank|moderation|image-|-audio|speech|-voice|sora|kling|suno|omni-moderation",
);
const VISION_RE = re(
  "gpt-4o|gpt-4\\.1|gpt-4-turbo|gpt-4-vision|gpt-4v|gpt-5|chatgpt-4o|" +
    `${BL}o1${BR}|${BL}o3${BR}|${BL}o4${BR}|` +
    "gemini|claude-3|claude-4|claude-opus|claude-sonnet|" +
    "claude-haiku|qwen.*(?:vl|omni)|pixtral|llava|internvl|minicpm-v|glm-4v|" +
    "glm-4\\.\\dv|step-1v|grok-2-vision|grok-4|llama-3\\.2-(?:11b|90b)|llama-4|" +
    // Moonshot 的视觉款叫 `moonshot-v1-{8k,32k,128k}-vision-preview` —— 家族名
    // 在下面的 TEXT_ONLY 里，只能靠 `-vision` 这一截把它捞回来（两边都要改，
    // 因为 TEXT_ONLY 是**否决票**）。漏掉它的后果不是少个选项，是整条扫描件
    // OCR 通路以「网关上没有视觉模型」的名义静默关掉 —— 而网关上明明有。
    "moonshot.*vision|kimi.*vl",
);
// 这里的 `(?!…)` 全是**给上面 VISION_RE 让路的豁免口**：否决票放行了，还得
// VISION_RE 真认得出来，那一档才落得下。两者少一边，整条豁免就是死代码 ——
// `kimi(?!.*vl)` 曾经就是：写了豁免、没配 VISION_RE，加不加它结果一模一样。
const TEXT_ONLY_RE = re(
  "gpt-3\\.5|deepseek|text-davinci|babbage|moonshot(?!.*vision)|kimi(?!.*vl)|" +
    "qwen(?!.*(?:vl|omni))|o1-mini|o3-mini|gemini-embedding",
);
const CHEAP_RE = re("mini|flash|haiku|nano|lite|small|8b|turbo|air");
const FRONTIER_RE = re(
  `opus|gpt-5|-pro${BR}|ultra|405b|max|claude-3-7|claude-sonnet-4|` +
    "o1(?!-mini)|o3(?!-mini)|gemini-2\\.5-pro|gemini-1\\.5-pro",
);

/** 是不是能对话/理解的模型（排掉 embedding/tts/画图等非对话端点）。 */
export function isChatModel(name: string): boolean {
  return !NOT_CHAT_RE.test(name);
}

/**
 * 是不是**出图**模型（images 端点那类）。
 *
 * 它们被 `NOT_CHAT_RE` 有意挡在聊天卡目录外（不该被难度路由选中去回话），
 * 所以「图像」档的配置校验走这里，而不是查目录。判据与 VISION_RE/CHEAP_RE
 * 同性质：认模型产品的名形，宁可多认一个（网关会在真调用时报错），
 * 也别把用户真配的型号在保存那一刻错杀。
 */
const IMAGE_MODEL_RE = re(
  // `image` 按**词段**认（gpt-5.4-image-2 / gemini-3.1-flash-image）：第一版写的
  // 是 `gpt-image`，对着真实网关一查 35 个模型零命中 —— 各家把 image 放在名字的
  // 什么位置没有约定，赌位置就是赌错。词界挡住 imagenet 这类形近词。
  `${BL}image${BR}|gpt-image|dall-?e|stable-?diffusion|${BL}flux${BR}|midjourney|imagen${BR}|${BL}sd(xl)?${BR}`,
);

export function isImageModel(name: string): boolean {
  return IMAGE_MODEL_RE.test(name);
}

/**
 * 按模型名推断能力。**保守但够用**：现代对话模型基本都支持 json schema，默认给
 * STRUCTURED；判错网关会报错、`recordDenial` 再抹掉。视觉是重点 —— 宁可多认一个
 * （多试一次），也别漏掉真能 OCR 的模型。
 */
export function inferCapabilities(name: string): ReadonlySet<Capability> {
  // 现代模型基本 ≥128k 且支持结构化输出
  const caps = new Set<Capability>([C.STRUCTURED, C.LONG_CONTEXT]);
  if (VISION_RE.test(name) && !TEXT_ONLY_RE.test(name)) caps.add(C.VISION);
  if (CHEAP_RE.test(name)) caps.add(C.CHEAP);
  return caps;
}

/** 给网关发现、但内置目录里没有的模型现造一张卡（能力靠名字推断）。 */
export function cardFromName(name: string): ModelCard {
  const caps = inferCapabilities(name);
  const quality = FRONTIER_RE.test(name) ? 4 : caps.has(C.CHEAP) ? 2 : 3;
  return makeModelCard({
    spec: makeModelSpec({
      name,
      tier: quality >= 4 ? "frontier" : "mid",
      usd_per_mtok_in: 2.0,
      usd_per_mtok_out: 8.0,
      effort: null,
      thinking: null,
    }),
    capabilities: caps,
    quality,
    vendor: name.includes("/") ? (name.split("/")[0] ?? "") : "",
  });
}

// ══════════════════════════════════════════════════════════════════
//  ModelCatalog
// ══════════════════════════════════════════════════════════════════

/**
 * 目录里挑不出满足能力要求的模型。== Python 的内建 `LookupError`。
 *
 * **这个类只许有一份。** 两份同名类是两个类身份，`instanceof` 会漏掉其中一份
 * 而且不报错 —— 症状是 vision 解析器把「网关上没有视觉模型」报成一句泛泛的
 * 「视觉识别失败」，用户照着这句话永远查不到该去网关上开一个带视觉的模型。
 */
export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
    Object.setPrototypeOf(this, LookupError.prototype);
  }
}

export interface SelectOptions {
  /** `quality`（默认）或 `cost`。**非 `"cost"` 的任何值都走 quality 分支。** */
  readonly prefer?: string;
  readonly limit?: number;
  readonly excludeVendors?: Iterable<string>;
}

/** 能力目录。按能力选模型，按失败学习。 */
export class ModelCatalog implements CatalogLike {
  /**
   * 键是模型名。**用 Map 而不是普通对象**：`select()` 的稳定排序会让并列项按
   * 插入序出，而 `discover()` 会 `delete` 再重新插入 —— 顺序本身是行为的一部分。
   */
  private readonly cards: Map<string, ModelCard>;

  readonly notes: string[] = [];

  constructor(cards?: readonly ModelCard[] | null) {
    // Python 是 `cards or CARDS`：**空列表是假值**，会落回内置目录。照抄成
    // `cards ?? CARDS` 就是一个空目录，require() 立刻抛 LookupError。
    const src = cards !== null && cards !== undefined && cards.length > 0 ? cards : CARDS;
    this.cards = new Map(src.map((c) => [cardName(c), c]));
  }

  // ── 选型 ────────────────────────────────────────────────────

  /**
   * 按能力挑出**有序候选**。
   *
   * 返回列表而不是单个 —— 网关会逐个试。只给一个，遇到临时故障就只能整体失败。
   */
  select(needs: Iterable<Capability> = [], o: SelectOptions = {}): ModelCard[] {
    const prefer = o.prefer ?? "quality";
    const limit = o.limit ?? 4;
    const needSet = new Set(needs);
    const ex = new Set(o.excludeVendors ?? []);
    const pool = [...this.cards.values()].filter(
      (c) => cardHas(c, needSet) && !ex.has(c.vendor),
    );
    // Array.prototype.sort 自 ES2019 起保证稳定，与 Python 的 sort 同语义。
    if (prefer === "cost") {
      // key=(out_price, -quality)：先便宜，同价再要质量高的
      pool.sort((a, b) => a.spec.usd_per_mtok_out - b.spec.usd_per_mtok_out || b.quality - a.quality);
    } else {
      // key=(-quality, out_price)：先高档，同档再要便宜的
      pool.sort((a, b) => b.quality - a.quality || a.spec.usd_per_mtok_out - b.spec.usd_per_mtok_out);
    }
    // `pool[:limit]`：limit 为负时是"去掉末尾几个"，slice 语义一致。
    return pool.slice(0, limit);
  }

  /**
   * 同 {@link select}，但一个都挑不出来时**报错而不是静默降级**。
   *
   * 静默降级意味着"OCR 悄悄变成了凭字段名瞎猜"，产物看起来正常但完全是编的。
   */
  require(needs: Iterable<Capability>, o: SelectOptions = {}): ModelCard[] {
    // Python 收的是 set —— 重复的能力名不该在错误消息里出现两次。
    const needList = [...new Set(needs)];
    const cands = this.select(needList, o);
    if (cands.length === 0) {
      throw new LookupError(
        `目录里没有同时具备 ${pyReprList(pySorted(needList))} 的模型。` +
          `可用模型：${pyReprList(this.names())}`,
      );
    }
    return cands;
  }

  // ── 失败学习 ────────────────────────────────────────────────

  /**
   * 网关说某模型不支持某能力时，把它从目录里抹掉。
   *
   * 本进程内不再为同一个模型重复试同一种能力 —— 每次重试都是一个真实往返。
   */
  recordDenial(model: string, errorText: string): Capability | null {
    const cap = denialCapability(errorText);
    const c = this.cards.get(model);
    if (cap === null || c === undefined || !c.capabilities.has(cap)) return null;
    // Map 对已存在的键重新赋值**保持原位置**，与 Python 的 dict 一致。
    this.cards.set(model, cardWithout(c, cap));
    this.notes.push(`${model} 实测不支持 ${cap}，已从目录移除该能力`);
    return cap;
  }

  // ── 运行时发现 ──────────────────────────────────────────────

  /**
   * 从 `/v1/models` 拉取真实可用列表，剔除目录里网关没有的。
   *
   * 目录写着但网关没上的模型，留着只会在运行时 404。
   */
  async discover(baseUrl: string, apiKey: string): Promise<string[]> {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    // httpx 的 timeout=30 是分项超时，AbortSignal.timeout 是整体超时 —— 对这个
    // 一次性的小 GET 没有实际区别。
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    const body = (await r.json()) as { data?: unknown } | null;
    const rows = (body?.data ?? null) as readonly unknown[] | null;
    const live = new Set<string>();
    for (const m of rows ?? []) {
      const id = (m as Record<string, unknown> | null)?.["id"];
      // Python 是 `m["id"]`：缺键直接 KeyError 冒到 _ensure_catalog 的 except。
      // 这里同样抛 —— 悄悄塞一个 "undefined" 进目录才是更坏的结果。
      if (typeof id !== "string") throw new Error("模型列表里有一项缺少 id");
      live.add(id);
    }

    const missing = [...this.cards.keys()].filter((n) => !live.has(n));
    for (const n of missing) {
      this.cards.delete(n);
      this.notes.push(`${n} 网关上不可用，已移除`);
    }
    // 网关上有、目录里没有的：按名字推断能力补进来。New-API 用各家原名，对不上
    // 内置目录，不补的话这些模型（含真能 OCR 的视觉模型）永远选不到。
    for (const name of pySorted(live)) {
      if (!this.cards.has(name) && isChatModel(name)) {
        this.cards.set(name, cardFromName(name));
        this.notes.push(`${name} 从网关发现，按名字推断能力`);
      }
    }
    return pySorted(live);
  }

  // ── 访问 ────────────────────────────────────────────────────

  get(name: string): ModelCard | null {
    return this.cards.get(name) ?? null;
  }

  names(): string[] {
    return pySorted(this.cards.keys());
  }

  describe(): ModelCardDict[] {
    return this.names().map((n) => cardToDict(this.cards.get(n)!));
  }

  byCapability(): Record<string, string[]> {
    const out = new Map<string, string[]>();
    for (const c of this.cards.values()) {
      for (const cap of c.capabilities) {
        const bucket = out.get(cap);
        if (bucket === undefined) out.set(cap, [cardName(c)]);
        else bucket.push(cardName(c));
      }
    }
    // Python 是 `{k: sorted(v) for k, v in sorted(out.items())}`：键也排序。
    // 能力名不是整数样式的字符串，所以普通对象保得住这个插入序。
    const sorted: Record<string, string[]> = {};
    for (const k of pySorted(out.keys())) sorted[k] = pySorted(out.get(k)!);
    return sorted;
  }
}

// ══════════════════════════════════════════════════════════════════
//  按能力路由的网关
// ══════════════════════════════════════════════════════════════════

/** {@link SmartGateway} 真正用到的那一件事。`ModelGateway` 天然满足。 */
export interface GatewayLike {
  call(nodeId: string, prompt: string, opts?: CallOptions): Promise<Completion>;
}

/** 一次候选尝试。成功只有前四个键，失败多两个 —— 与 Python 的 dict 逐键一致。 */
export interface SmartAttempt {
  readonly node: string;
  readonly model: string;
  readonly attempt: number;
  readonly ok: boolean;
  readonly lost_capability?: string | null;
  readonly error?: string;
}

export interface SmartCallOptions extends CallOptions {
  readonly needs?: Iterable<Capability>;
  readonly prefer?: string;
  readonly maxCandidates?: number;
  /**
   * 优先试这几个（按序）。**给定任务上实测更好的模型，排在通用的质量/成本排序
   * 之前** —— 比如流程图 OCR，实测 gemini-3.5-flash 读出的连线关系是 opus 的
   * 两倍多、还快一倍，而"连线"恰恰是流程图的核心信息。不在目录里的名字自动
   * 跳过，所以网关换了也不会因此失败。
   */
  readonly preferModels?: readonly string[];
}

export interface SmartReport {
  readonly attempts: readonly SmartAttempt[];
  readonly catalog_notes: readonly string[];
  readonly by_capability: Record<string, string[]>;
}

/**
 * 在 `ModelGateway` 之上加一层**按能力选型 + 失败切换**。
 *
 * 调用方说"我要能读图"，不说"我要用 gemini"。模型换了、网关换了、某个模型的
 * 视觉能力下线了，调用方代码都不用动 —— 而硬编码模型名的写法在这些情况下会
 * 静默降级成一个看不出来的错误答案。
 */
export class SmartGateway {
  readonly gw: GatewayLike;
  readonly catalog: ModelCatalog;
  readonly trace: SmartAttempt[] = [];

  constructor(gateway: GatewayLike, catalog?: ModelCatalog | null) {
    this.gw = gateway;
    this.catalog = catalog ?? new ModelCatalog();
  }

  /**
   * 按能力选型并调用，失败自动切下一个候选。
   *
   * @throws {@link LookupError} 目录里没有满足能力要求的模型。**不静默降级** ——
   *   拿没有视觉能力的模型去做 OCR，会得到一份凭字段名编出来的结果。
   * @throws {@link ModelError} 全部候选都失败，消息里带每个候选的错误摘要。
   */
  async call(nodeId: string, prompt: string, o: SmartCallOptions = {}): Promise<Completion> {
    const {
      needs: needsIn = [],
      prefer = "quality",
      maxCandidates = 3,
      preferModels = [],
      ...rest
    } = o;
    // Python 侧一路是 `set(needs)`，去重后再排序进错误消息。
    const needs = [...new Set(needsIn)];

    let cands = this.catalog.require(needs, { prefer, limit: maxCandidates });
    if (preferModels.length > 0) {
      const head: ModelCard[] = [];
      for (const n of preferModels) {
        const c = this.catalog.get(n);
        if (c !== null && cardHas(c, needs)) head.push(c);
      }
      const seen = new Set(head.map(cardName));
      // 注意：结果**可能超过 maxCandidates**（head 是额外拼上去的）。这是 Python
      // 的既有行为，不要顺手"修好" —— OCR 那条路正靠它多试两个实测更好的模型。
      cands = [...head, ...cands.filter((c) => !seen.has(cardName(c)))];
    }
    const errors: string[] = [];

    // Python 那行是 `key=f"{kw.pop('key','cap')}:{i}" if "key" in kw else None`。
    // `kw.pop` 有副作用：**只有第 0 个候选拿得到 `"<key>:0"`，之后一律 None**。
    // 这不是笔误也不能"修" —— key 进 Recorder 的 effect 指纹，改一个字就是
    // 所有历史 effect 全部对不上（DeterminismViolation）。
    let keyPresent = Object.prototype.hasOwnProperty.call(o, "key");
    const keyValue = o.key;

    for (let i = 0; i < cands.length; i += 1) {
      const cardI = cands[i]!;
      let key: string | null = null;
      if (keyPresent) {
        // f-string 里 None 会印成 "None"。真实调用方一律传字符串，这里只是不撒谎。
        key = `${keyValue === null || keyValue === undefined ? "None" : keyValue}:${i}`;
        keyPresent = false;
      }
      try {
        const comp = await this.gw.call(nodeId, prompt, { ...rest, model: cardI.spec, key });
        this.trace.push({ node: nodeId, model: cardName(cardI), attempt: i + 1, ok: true });
        return comp;
      } catch (exc) {
        const text = excText(exc);
        errors.push(`${cardName(cardI)}: ${cpSlice(text, 150)}`);
        const lost = this.catalog.recordDenial(cardName(cardI), text);
        this.trace.push({
          node: nodeId,
          model: cardName(cardI),
          attempt: i + 1,
          ok: false,
          lost_capability: lost,
          error: cpSlice(text, 200),
        });
        if (i === cands.length - 1) {
          const err = new ModelError(
            `能力 ${pyReprList(pySorted(needs))} 的 ${cands.length} 个候选` +
              `全部失败：\n${errors.join("\n")}`,
          );
          // `raise ... from exc`：根因不能丢，_money_failure 顺着 cause 找欠费。
          (err as { cause?: unknown }).cause = exc;
          throw err;
        }
      }
    }
    // require() 已保证 cands 非空，走不到这里。
    throw new ModelError("没有候选模型");
  }

  report(): SmartReport {
    return {
      attempts: this.trace,
      catalog_notes: this.catalog.notes,
      by_capability: this.catalog.byCapability(),
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  _ensure_catalog（server.py:457）—— 懒发现的那份进程级缓存
// ══════════════════════════════════════════════════════════════════
//
// 放在这里而不是 server 段：它的全部状态（_CATALOG / _CATALOG_OK）和全部逻辑
// 都是目录的事，server 只需要一个 `registerCatalogPort(makeCatalogPort(...))`。
// 接线在 `server/catalog_wiring.ts`。

/** `appconfig.resolved_llm_config()` 的返回里这一层用到的两个字段。 */
export interface LlmEndpoint {
  readonly baseUrl: string;
  readonly apiKey: string;
}

let CACHED: ModelCatalog | null = null;
let CACHED_OK = false;

/**
 * 按网关 `/v1/models` 过滤模型目录。**懒发现、成功一次即缓存。**
 *
 * 不过滤的后果正是「扫描件不识别」：视觉选型按质量挑候选（opus/gpt-5.5 在前），
 * 可网关未必上了这些模型 —— 候选逐个 404，而真能 OCR 的 gemini-3.5-flash 因质量档
 * 排在候选之外、**从没被试到**，于是扫描件内容静默不进产物。发现后目录只留网关
 * 真有的模型，`require(VISION)` 就落到网关实际提供的视觉模型上。
 *
 * 在 build 时调（那时网关一定配好了，启动时未必）。发现失败、或命名不匹配把目录
 * 清空了，都退回内置目录（比没有目录好），且**不置 OK** —— 下次 build 再试。
 */
export async function ensureCatalog(resolve: () => LlmEndpoint): Promise<ModelCatalog> {
  if (CACHED_OK && CACHED !== null) return CACHED;
  const cat = new ModelCatalog();
  try {
    const cfg = resolve();
    const live = await cat.discover(cfg.baseUrl, cfg.apiKey);
    if (cat.names().length > 0) {
      const vision = cat.byCapability()["vision"] ?? [];
      console.log(
        `[catalog] 网关可用模型 ${cat.names().length} 个；视觉可用：` +
          `${vision.length > 0 ? pyReprList(vision) : "无（扫描件仍无法 OCR，请在网关上开一个带视觉的模型）"}`,
      );
      CACHED = cat;
      CACHED_OK = true;
      return cat;
    }
    console.log(
      `[catalog] 发现清空了目录（网关命名与内置不匹配？live=${pyReprList(live.slice(0, 8))}），退回内置`,
    );
  } catch (exc) {
    // 发现失败不该拖垮 build。
    console.log(`[catalog] 模型发现失败，退回内置：${excName(exc)}: ${excText(exc)}`);
  }
  CACHED = new ModelCatalog();
  return CACHED;
}

function excName(e: unknown): string {
  if (e === null || e === undefined) return "NoneType";
  const ctor = (e as { constructor?: { name?: string } }).constructor;
  return typeof ctor?.name === "string" && ctor.name !== "" ? ctor.name : typeof e;
}

/** `_gateways` 里那句 `_CATALOG or ModelCatalog()`。**永远不返回 null。** */
export function currentCatalog(): ModelCatalog {
  return CACHED ?? new ModelCatalog();
}

/** 只给测试用：把懒发现的缓存清掉。 */
export function resetCatalogCache(): void {
  CACHED = null;
  CACHED_OK = false;
}

/**
 * `server/usage.ts` 的 `registerCatalogPort()` 要的那两件事。
 *
 * `current()` 返回的是 `_CATALOG or ModelCatalog()` —— **不是 null**。
 * 给 null 的话 `overrideSpec` 会走"目录里没有"的保守分支，把管理员在设置页选的
 * 模型一律按 mid/无 effort 计，与 Python 不是一个行为。
 */
export function makeCatalogPort(resolve: () => LlmEndpoint): {
  current(): CatalogLike;
  makeSmart(gw: ModelGateway, catalog: CatalogLike | null): SmartGateway;
  ensure(): Promise<ModelCatalog>;
} {
  return {
    current: () => currentCatalog(),
    makeSmart: (gw, catalog) =>
      new SmartGateway(gw, catalog instanceof ModelCatalog ? catalog : null),
    ensure: () => ensureCatalog(resolve),
  };
}
