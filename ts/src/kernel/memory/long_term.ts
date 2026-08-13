/**
 * 长期记忆 —— 跨 Run 的项目知识。移植自 Python 侧 `kernel/memory/long_term.py`。
 *
 * 长期记忆一旦被污染，之后**所有** Run 都受影响，代价远高于短期出错。所以这里
 * 的默认姿态是保守：
 *
 *   1. **晋升要过闸**（`PromotionGate`）。人确认过、扛过 N 轮 critic、或在
 *      K 个不同 Run 里被独立观察到 —— 三选一才准进。没有 support 的一律拒。
 *   2. **冲突不静默覆盖**。新记忆与旧的矛盾时标 contested，两条都留着，检索时
 *      带警告一起给出去，由人来断。悄悄覆盖等于让系统忘记自己曾经知道过别的。
 *   3. **不用就衰减**。连续 N 个 Run 没被命中的条目降低 confidence，跌破地板就
 *      淘汰。项目会演化，去年的约定今年可能已经不成立。
 *
 * 由 `golden/memory.long_term.json` 钉住（闸门的每条拒绝理由、_merge 的四条分支、
 * recall 的排序与预算裁剪、decay 的浮点算术、save 的 JSON 形态）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { roundHalfEven } from "../budget.js";
// Python 侧 `variant_of` 里是**函数内 import**，按契约 §1 提到顶层。
import { sha256Hex } from "../ids.js";
import { MemoryItem, MemoryKind, MemoryTier, Scope } from "./types.js";
import type { MemoryItemDict } from "./types.js";

/**
 * Python 的 `_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[㐀-鿿]")`。
 *
 * 后半段是**单个** CJK 字符（U+3400–U+9FFF），不是字符段 —— 中文按字切。
 * 这段区间与 `types.isCjkCode` 的四段、`ids.slug` 的保留集都**不是**同一组，
 * 三处各有各的理由，别拿一个去套另一个。
 */
const TOKEN_RE = /[a-zA-Z0-9_]+|[㐀-鿿]/g;

/** 参考档的检索降权。人拍板和模型推断同时命中时，人的先出场。 */
const REFERENCE_DISCOUNT = 0.6;
/** 第二道降权：这条参考是在另一批材料上得出的，跟本轮更可能无关。 */
const FOREIGN_MATERIAL_DISCOUNT = 0.6;

const REF_DECISION_WHY =
  "参考档不许用 decision 这个 kind —— DECISION 在检索里吃 1.3 prior、" +
  "在衰减里完全豁免，模型的推断借它表达就成了既排前又永不过期";

/** 粗分词：拉丁按词、CJK 按字。检索长期记忆这种短文本足够，且零依赖。 */
function tok(text: string): string[] {
  const out: string[] = [];
  // `matchAll` 内部复制正则，不会动 TOKEN_RE 的 lastIndex —— 这个模块级常量被
  // 每次打分复用，靠的就是这一点。别改成 `while (TOKEN_RE.exec(...))`。
  for (const m of (text || "").matchAll(TOKEN_RE)) out.push(m[0].toLowerCase());
  return out;
}

/** `collections.Counter` 的最小替身：只需要计数与求和。 */
function counter(toks: readonly string[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const t of toks) c.set(t, (c.get(t) ?? 0) + 1);
  return c;
}

function sumValues(c: Map<string, number>): number {
  let n = 0;
  for (const v of c.values()) n += v;
  return n;
}

/**
 * Python 的 `format(x, ".2f")`。
 *
 * `errors.formatFixed0` 是它 `.0f` 的姊妹，但那份把整数部分和半整数判断写死在
 * `.0f` 上，套不到两位小数。这里改走 `budget.roundHalfEven`（精确有理数上舍入、
 * ties-to-even），再 `toFixed(2)` 把已经舍好的值印出来 —— 此时 `toFixed` 只是
 * 排版，不再承担舍入，两边的 ties 策略分叉（CPython 取偶、JS 取远离零）就消失了。
 *
 * 不是理论问题：`_merge` 里的 `min(0.98, c + 0.1)` 能落在 0.875 这种精确的二进制
 * 并列点上，Python 给 "0.88"、裸 `toFixed(2)` 给 "0.88"…… 但 0.125 那侧就分了。
 * 这个字符串进 `promote()` 的返回说明、进事件日志，差一位就是长期噪声。
 */
function formatFixed2(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const r = roundHalfEven(x, 2);
  // Python 的 `format(-0.0, ".2f")` 是 "-0.00"，而 JS 的 `(-0).toFixed(2)` 是
  // "0.00"（规范里判的是 `x < 0`，-0 不满足）。符号来自输入，不是结果。
  if (r === 0 && (Object.is(r, -0) || Object.is(x, -0) || x < 0)) return "-0.00";
  return r.toFixed(2);
}

// ══════════════════════════════════════════════════════════════════
//  晋升
// ══════════════════════════════════════════════════════════════════

/** 四种、且只有四种能进长期库的理由。放宽任何一条，模型的臆测就会变成"事实"。 */
export const PromotionReason = {
  HUMAN_CONFIRMED: "human_confirmed", // 人拍板的决策
  CRITIC_SURVIVED: "critic_survived", // 扛过 N 轮评审
  REPEATED: "repeated", // 在 K 个不同 Run 里独立出现
  IMPORTED: "imported", // 从项目规范文档导入
} as const;
export type PromotionReason = (typeof PromotionReason)[keyof typeof PromotionReason];

/** 与 Python `list(PromotionReason)` 同序。 */
export const PROMOTION_REASONS: readonly PromotionReason[] = Object.values(PromotionReason);

const REASON_VALUES: ReadonlySet<string> = new Set<string>(PROMOTION_REASONS);

/** 对应 Python 的 `PromotionReason(value)` —— 未知值抛错，别用 `as` 蒙混过去。 */
export function parsePromotionReason(v: unknown): PromotionReason {
  if (typeof v === "string" && REASON_VALUES.has(v)) return v as PromotionReason;
  throw new Error(`未知的 PromotionReason: ${JSON.stringify(v)}`);
}

/** 闸门参数。Python 侧是 `@dataclass(frozen=True)`，四个字段全有默认值。 */
export interface PromotionGateInit {
  readonly minCriticRounds?: number | undefined;
  readonly minDistinctRuns?: number | undefined;
  readonly minConfidence?: number | undefined;
  readonly requireSupport?: boolean | undefined;
}

const GATE_DEFAULTS = {
  minCriticRounds: 2,
  minDistinctRuns: 2,
  minConfidence: 0.6,
  requireSupport: true,
} as const;

/**
 * 晋升闸门。
 *
 * 有行为（`check`）所以是 class 而不是 interface（契约 §1）。字段在构造函数体里
 * 赋值、**不写成类字段初始化器** —— 后者会在子类里把基类算好的值覆盖回默认值。
 */
export class PromotionGate {
  readonly minCriticRounds: number;
  readonly minDistinctRuns: number;
  /** Python 侧同样声明了却没在 `check` 里用到 —— 照抄，不要"顺手接上"。 */
  readonly minConfidence: number;
  readonly requireSupport: boolean;

  constructor(p: PromotionGateInit = {}) {
    this.minCriticRounds = p.minCriticRounds ?? GATE_DEFAULTS.minCriticRounds;
    this.minDistinctRuns = p.minDistinctRuns ?? GATE_DEFAULTS.minDistinctRuns;
    this.minConfidence = p.minConfidence ?? GATE_DEFAULTS.minConfidence;
    this.requireSupport = p.requireSupport ?? GATE_DEFAULTS.requireSupport;
  }

  check(item: MemoryItem, reason: PromotionReason, criticRounds = 0): [boolean, string] {
    // 参考档在这里被无条件挡掉，位置是刻意的：
    //   · 必须在 match reason 之前 —— HUMAN_CONFIRMED / IMPORTED 是 `return True`
    //     的直通分支，写在里面等于没写；
    //   · 必须在闸门**内部**而不是调用方 —— recall() 会给命中项攒 hit_runs，
    //     而 hit_runs 的条数正是 REPEATED 的判据，参考档被召回两轮就自动够格了。
    if (item.tier === MemoryTier.REFERENCE) {
      return [false, "参考档记忆永不晋升 —— 升权威的唯一路径是人在本会话里拍板"];
    }
    if (this.requireSupport && item.support.length === 0) {
      return [false, "无 support —— 拿不出依据的记忆不允许进长期库"];
    }
    switch (reason) {
      case PromotionReason.HUMAN_CONFIRMED:
      case PromotionReason.IMPORTED:
        return [true, reason];
      case PromotionReason.CRITIC_SURVIVED:
        if (criticRounds >= this.minCriticRounds) return [true, `扛过 ${criticRounds} 轮 critic`];
        return [false, `critic 轮数 ${criticRounds} < ${this.minCriticRounds}`];
      case PromotionReason.REPEATED: {
        const n = item.hitRuns.size;
        if (n >= this.minDistinctRuns) return [true, `在 ${n} 个 Run 中独立观察到`];
        return [false, `仅 ${n} 个 Run 观察到 < ${this.minDistinctRuns}`];
      }
    }
    // Python 侧 `match` 之后那行兜底。四个分支已经穷尽枚举，但 reason 可能是从
    // JSON 里读进来没过 parse 的脏值 —— 那时候必须是"拒绝"，不是"漏到 True"。
    return [false, "未知晋升理由"];
  }
}

/** 衰减参数。纯数据（Python 侧 frozen dataclass 且无方法）→ interface + 工厂。 */
export interface DecayPolicy {
  readonly idleRunsBeforeDecay: number;
  readonly decayPerRun: number;
  readonly evictBelow: number;
  /** 人确认的决策不衰减 —— 它代表业务事实，不是系统的猜测。 */
  readonly immuneKinds: ReadonlySet<MemoryKind>;
}

export interface DecayPolicyInit {
  readonly idleRunsBeforeDecay?: number | undefined;
  readonly decayPerRun?: number | undefined;
  readonly evictBelow?: number | undefined;
  readonly immuneKinds?: Iterable<MemoryKind> | undefined;
}

export function makeDecayPolicy(p: DecayPolicyInit = {}): DecayPolicy {
  return {
    idleRunsBeforeDecay: p.idleRunsBeforeDecay ?? 3,
    decayPerRun: p.decayPerRun ?? 0.08,
    evictBelow: p.evictBelow ?? 0.25,
    // 每次新建集合（对应 `frozenset({...})` 那个默认值），别共享引用
    immuneKinds: new Set(p.immuneKinds ?? [MemoryKind.DECISION]),
  };
}

// ══════════════════════════════════════════════════════════════════
//  存储
// ══════════════════════════════════════════════════════════════════

/** `LongTermStore.toDict()` 的线上形态。键序即落盘字节序。 */
export interface LongTermStoreDict {
  project: string;
  runs: string[];
  items: MemoryItemDict[];
}

export interface LongTermStoreInit {
  readonly gate?: PromotionGate | undefined;
  readonly decay?: DecayPolicy | undefined;
}

/** 项目/租户作用域的记忆库。记忆按项目隔离 —— 隔离靠**实例**，不靠字段。 */
export class LongTermStore {
  readonly project: string;
  gate: PromotionGate;
  decayPolicy: DecayPolicy;
  /** Map 而不是普通对象：key 形如 `fact:0` 时 V8 会把整数样式键提到最前面，
   * 而 `to_dict()`/`all()` 的顺序 = Python dict 的插入序，是被 golden 钉住的。 */
  private readonly items = new Map<string, MemoryItem>();
  /** Run 顺序，衰减靠它算"闲置了几个 Run"。 */
  private runSeen: string[] = [];

  constructor(project: string, p: LongTermStoreInit = {}) {
    this.project = project;
    this.gate = p.gate ?? new PromotionGate();
    this.decayPolicy = p.decay ?? makeDecayPolicy();
  }

  // ── 晋升 ────────────────────────────────────────────────────

  /** 把一条短期记忆升入长期库。返回 `[是否成功, 说明]`。 */
  promote(
    item: MemoryItem,
    reason: PromotionReason,
    opts: { readonly runId: string; readonly criticRounds?: number | undefined },
  ): [boolean, string] {
    const runId = opts.runId;
    if (item.tier === MemoryTier.REFERENCE && item.kind === MemoryKind.DECISION) {
      // 闸门下一行也会拒掉它，但那句话说的是"永不晋升"，掩盖了真正的问题：
      // 借 DECISION 这个 kind 表达推断，会同时拿到 1.3 的检索 prior 和衰减豁免。
      return [false, REF_DECISION_WHY];
    }
    const [ok, why] = this.gate.check(item, reason, opts.criticRounds ?? 0);
    if (!ok) return [false, why];

    item.hitRuns.add(runId);
    // Python 的 `a or b`：空串是假值。`??` 在这里是错的 —— 空串会被留下来。
    item.createdRun = item.createdRun || runId;
    item.lastUsedRun = runId;
    if (item.scope === Scope.NODE || item.scope === Scope.RUN) item.scope = Scope.PROJECT;
    if (reason === PromotionReason.HUMAN_CONFIRMED) {
      item.confidence = Math.max(item.confidence, 0.95);
    }

    const existing = this.items.get(item.key);
    if (existing === undefined) {
      this.items.set(item.key, item);
      return [true, why];
    }
    return this.merge(existing, item, why);
  }

  /**
   * 记下一条参考档观察。返回 `[是否记下, 说明]`。
   *
   * 参考档不走 `promote` —— 它压根不在晋升体系里，闸门只会拒它。但它仍然走
   * `merge`：同 key 撞上人拍板的条目时，必须让"参考不许覆盖权威"那道判断真的
   * 生效，而不是绕过合并直接写进 items 把人的约定顶掉。
   *
   * 这里**不写 hitRuns** —— 那是晋升的证据，参考档不该攒。
   */
  note(item: MemoryItem, opts: { readonly runId?: string | undefined } = {}): [boolean, string] {
    const runId = opts.runId ?? "";
    if (item.tier !== MemoryTier.REFERENCE) {
      return [false, "note() 只收参考档 —— 权威档必须走 promote 过闸门"];
    }
    if (item.kind === MemoryKind.DECISION) return [false, REF_DECISION_WHY];

    item.createdRun = item.createdRun || runId;
    item.lastUsedRun = runId || item.lastUsedRun;
    const existing = this.items.get(item.key);
    if (existing === undefined) {
      this.items.set(item.key, item);
      return [true, "记下参考档观察"];
    }
    return this.merge(existing, item, "参考档观察");
  }

  /** 同 key 合并。内容一致 → 加固；不一致 → 标争议，两条都留。 */
  private merge(old: MemoryItem, next: MemoryItem, why: string): [boolean, string] {
    for (const r of next.hitRuns) old.hitRuns.add(r);
    // 不带 run 的写入（note 的 runId 可省）不该把旧条目的"上次用过"抹掉 ——
    // 抹掉了衰减就会把它当成一直闲置，白白扣分。
    old.lastUsedRun = next.lastUsedRun || old.lastUsedRun;
    // 参考档的 support 不许并进权威档：support 是这条记忆的依据，会被人当出处看，
    // 混进模型推断的依据就等于让参考档从后门进了交付物的溯源。
    if (!(old.tier === MemoryTier.AUTHORITATIVE && next.tier === MemoryTier.REFERENCE)) {
      // `dict.fromkeys` = 保序去重；`[:20]` 是硬上限
      old.support = [...new Set([...old.support, ...next.support])].slice(0, 20);
    }

    if (same(old.content, next.content)) {
      // 独立观察到同一件事，可信度上升但有上限（避免自我强化到 1.0）
      old.confidence = Math.min(0.98, old.confidence + 0.1);
      return [true, `${why}（与既有记忆一致，可信度 → ${formatFixed2(old.confidence)}）`];
    }

    // 谁能覆盖谁：**先看档位，档位裁不了才回落到数字**。
    // 原来只有 `new.confidence >= 0.95 > old.confidence` 这个裸比较，而
    // HUMAN_CONFIRMED 会把 confidence 顶到 0.95 —— 参考档一旦借到这个数字，
    // 就能把人拍板的条目打成 superseded，而 superseded 被 recall 直接排除，
    // 等于人的约定静默消失。反过来（人拍板推翻推断）才是这条分支的本意。
    const newRef = next.tier === MemoryTier.REFERENCE;
    const oldRef = old.tier === MemoryTier.REFERENCE;
    // Python 的链式比较 `a >= b > c` 等价于 `a >= b && b > c`，不是 `(a >= b) > c`
    if (!newRef && (oldRef || (next.confidence >= 0.95 && 0.95 > old.confidence))) {
      const variantKey = `${old.key}~superseded#${old.contestedBy.length}`;
      this.items.set(
        variantKey,
        new MemoryItem({
          key: variantKey,
          kind: old.kind,
          scope: old.scope,
          content: old.content,
          confidence: old.confidence * 0.5,
          support: old.support,
          tags: [...old.tags, "superseded"],
          createdRun: old.createdRun,
          tier: old.tier,
          originSession: old.originSession,
          originFiles: [...old.originFiles],
        }),
      );
      this.items.set(old.key, next);
      next.contestedBy = [variantKey];
      return [true, `${why}（人工决策覆盖既有推断，旧值降级留档）`];
    }

    const v = variantOf(old, next);
    if (!old.contestedBy.includes(v)) old.contestedBy.push(v);
    if (!(newRef && !oldRef)) {
      old.confidence = Math.min(old.confidence, 0.55); // 有争议就不该自信
    } else {
      // 模型的推断跟人拍板的约定对不上：矛盾记下来（人能看见），但不许
      // 拿它压人的可信度 —— 那是从排名侧变相实现覆盖。
      return [true, `${why}（与人拍板的约定矛盾，已记下存疑，权威档不受影响）`];
    }
    return [true, `${why}（与既有记忆矛盾，已标争议，检索时会一并给出）`];
  }

  // ── 检索 ────────────────────────────────────────────────────

  /**
   * 按相关度 × 可信度 × 热度检索。命中的条目会被记一次使用 —— 衰减策略据此
   * 判断哪些还活着。
   *
   * `currentFiles`：本轮在看的材料。传了它，参考档里"在另一批材料上得出的"
   * 会再降一档 —— 同一项目下不同会话的材料可能毫不相干。
   */
  recall(
    query: string,
    opts: {
      readonly runId?: string | undefined;
      readonly kinds?: Iterable<MemoryKind> | null | undefined;
      readonly limit?: number | undefined;
      readonly budgetTokens?: number | null | undefined;
      readonly currentFiles?: ReadonlySet<string> | null | undefined;
    } = {},
  ): MemoryItem[] {
    const runId = opts.runId ?? "";
    const limit = opts.limit ?? 8;
    const budgetTokens = opts.budgetTokens ?? null;
    const currentFiles = opts.currentFiles ?? null;
    // Python 侧 `set(kinds)` 写在推导式条件里、**每个条目重算一次**；这里只算
    // 一次。差别只有传一次性迭代器时才看得见，而那种传法在 Python 侧本身就是 bug。
    const kindAllow = opts.kinds === undefined || opts.kinds === null ? null : new Set(opts.kinds);

    const pool: MemoryItem[] = [];
    for (const it of this.items.values()) {
      if ((kindAllow === null || kindAllow.has(it.kind)) && !it.tags.includes("superseded")) {
        pool.push(it);
      }
    }
    if (pool.length === 0) return [];

    // Python 的 `sorted(key=lambda p: -p[0])` 是稳定排序，同分保持 items 的插入序。
    // JS 的 `Array.prototype.sort` 自 ES2019 起同样必须稳定 —— 这条是对齐的前提。
    const scored = pool.map((it) => ({ score: this.score(it, query, currentFiles), it }));
    scored.sort((a, b) => b.score - a.score); // == 按 -score 升序

    const out: MemoryItem[] = [];
    let spent = 0;
    for (const { score, it } of scored) {
      // 注意 `and out`：分数为 0 的**第一条**照样收 —— 空手而归比给一条弱相关更糟
      if (score <= 0 && out.length > 0) break;
      if (budgetTokens !== null && spent + it.tokens > budgetTokens) continue;
      out.push(it);
      spent += it.tokens;
      if (out.length >= limit) break;
    }

    for (const it of out) {
      it.useCount += 1;
      if (runId) {
        it.lastUsedRun = runId;
        // 参考档不攒 hitRuns。hitRuns 是 REPEATED 晋升的**证据**，而参考档
        // 永远拿不到晋升 —— 让它攒，等于给闸门那道拒绝留了条绕行路：被召回
        // 两个 Run 之后它就"够格"了，只差有人用错 reason 调一次 promote。
        // lastUsedRun 照写，衰减要靠它判断这条还活着。
        if (it.tier !== MemoryTier.REFERENCE) it.hitRuns.add(runId);
      }
    }
    return out;
  }

  private score(
    item: MemoryItem,
    query: string,
    currentFiles: ReadonlySet<string> | null,
  ): number {
    const q = counter(tok(query));
    const d = counter([...tok(item.content), ...tok(item.tags.join(" "))]);
    if (q.size === 0 || d.size === 0) return 0.0;
    // BM25 简化版：不做全库 IDF（长期库条目少，IDF 噪声大于信号）
    let overlap = 0;
    for (const [t, c] of q) overlap += Math.min(c, d.get(t) ?? 0);
    if (overlap === 0) return 0.0;
    const lex = overlap / Math.sqrt(sumValues(q) * sumValues(d));
    const heat = Math.log1p(item.useCount) / 3.0;
    // DECISION 天然优先：它是人拍板的事实，不是推断
    let prior = item.kind === MemoryKind.DECISION ? 1.3 : 1.0;
    // 参考档打折挂在打分里、不动存储里的 confidence —— 改存量会顺带改变
    // merge 的覆盖判据和衰减的淘汰线，一次装配就把库里的数据带偏了。
    if (item.tier === MemoryTier.REFERENCE) {
      prior *= REFERENCE_DISCOUNT;
      if (item.fromOtherMaterial(currentFiles)) prior *= FOREIGN_MATERIAL_DISCOUNT;
    }
    // 运算顺序照抄：浮点加乘不满足结合律，重排一次最后一位就可能不同
    return (lex + 0.25 * heat) * item.confidence * prior;
  }

  // ── 衰减 ────────────────────────────────────────────────────

  startRun(runId: string): void {
    if (!this.runSeen.includes(runId)) this.runSeen.push(runId);
  }

  /** 按闲置 Run 数衰减，返回被淘汰的条目。 */
  decay(currentRun: string): MemoryItem[] {
    this.startRun(currentRun);
    const order = new Map<string, number>();
    this.runSeen.forEach((r, i) => order.set(r, i));
    // startRun 刚保证过它在里面
    const now = order.get(currentRun)!;
    const p = this.decayPolicy;
    const evicted: MemoryItem[] = [];

    // `list(self._items.items())` 的快照：循环里会 pop，边遍历边删是未定义行为
    for (const [key, it] of [...this.items]) {
      if (p.immuneKinds.has(it.kind)) continue;
      const last = order.get(it.lastUsedRun) ?? -1;
      // 从没被用过（lastUsedRun 不在 runSeen 里）算作比第一个 Run 还老
      const idle = last >= 0 ? now - last : now + 1;
      if (idle <= p.idleRunsBeforeDecay) continue;
      it.confidence -= p.decayPerRun * (idle - p.idleRunsBeforeDecay);
      if (it.confidence < p.evictBelow) {
        evicted.push(it);
        this.items.delete(key);
      }
    }
    return evicted;
  }

  // ── 持久化 ──────────────────────────────────────────────────

  /** Python 的 `__len__`。TS 没有运算符重载，只能是方法。 */
  get size(): number {
    return this.items.size;
  }

  get(key: string): MemoryItem | undefined {
    return this.items.get(key);
  }

  all(): MemoryItem[] {
    return [...this.items.values()];
  }

  /** 已经见过的 Run 顺序（只读快照）。衰减的"闲置几轮"就是按它算的。 */
  get runs(): readonly string[] {
    return this.runSeen;
  }

  /**
   * 把已经落过库的条目原样装回来，返回装入条数。
   *
   * **不过闸门、不走合并** —— 这些条目当初进库时已经过了一次闸，按当下状态重放
   * 只会被误判（比如权威档的 support 早被合并压缩过）。只给持久化装载用，
   * 新记忆一律走 `promote` 或 `note`。
   */
  adopt(items: Iterable<MemoryItem>): number {
    let n = 0;
    for (const it of items) {
      this.items.set(it.key, it);
      n += 1;
    }
    return n;
  }

  toDict(): LongTermStoreDict {
    return {
      project: this.project,
      runs: this.runSeen,
      items: this.all().map((it) => it.toDict()),
    };
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toDict(), null, 1), "utf8");
  }

  static load(path: string, init: LongTermStoreInit = {}): LongTermStore {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`mem.json 不是对象: ${JSON.stringify(raw)}`);
    }
    const d = raw as Record<string, unknown>;
    const project = d["project"];
    if (typeof project !== "string") throw new Error("mem.json 缺少 project");
    const store = new LongTermStore(project, init);
    const runs = d["runs"];
    // `String(r)`：Python 的 `list(d.get("runs", ()))` 原样收下数字，之后
    // `order.get(it.last_used_run)` 拿字符串去查数字键必然查不到，衰减就把那条
    // 记忆当成"从没用过"。这里统一成字符串，与 `last_used_run` 的类型对上。
    store.runSeen = Array.isArray(runs) ? runs.map((r) => String(r)) : [];
    const items = d["items"];
    // Python 是 `d.get("items", ())`，对每条直接 from_dict —— **没有异常兜底**。
    // 坏行就该当场炸，静默跳过等于让一条记忆凭空消失且不留痕。
    for (const rawItem of Array.isArray(items) ? items : []) {
      const it = MemoryItem.fromDict(rawItem);
      store.items.set(it.key, it);
    }
    return store;
  }
}

function same(a: string, b: string): boolean {
  const ta = tok(a);
  const tb = tok(b);
  return ta.length === tb.length && ta.every((x, i) => x === tb[i]);
}

/** 争议变体的 key。同一条新内容反复撞同一条旧记忆时只记一次（内容哈希去重）。 */
export function variantOf(old: MemoryItem, next: MemoryItem): string {
  return `${old.key}~variant#${sha256Hex(next.content).slice(0, 8)}`;
}
