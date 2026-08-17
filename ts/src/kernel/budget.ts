/**
 * 预算与降级 —— 对应 Python 侧 `kernel/budget.py`，由 golden/budget.json 与
 * golden/budget.extra.json 钉住。
 *
 * **降级必须对用户可见。** 悄悄降级然后交付一个没审过的产物，比直接失败更严重 ——
 * FDE 会拿着它去跟客户对，而系统从没告诉过他这份东西的语义审核被跳过了。
 *
 * 所以每一级降级都：写事件日志 → 广播到总线 → 在产物上打标记 → 在 UI 上显示。
 */

import { BudgetExhausted } from "./errors.js";

/**
 * 降级阶梯（架构文档 §6.3）。数值越大越省，代价也越大。
 *
 * 这是契约里**唯一允许**用 TS `enum` 的场合：判据全是 `>=` / `<` 的大小比较
 * （`lvl >= RULES_ONLY`），阶梯的顺序本身就是语义。其余枚举一律走
 * `as const` 对象 —— 那些要 JSON 往返，而这个进 JSON 时是 `int(level)`。
 */
export enum DegradeLevel {
  NONE = 0,
  NO_SELF_CONSISTENCY = 1, // 剩余 <40%：关掉 Critical 档的多采样自洽
  FEWER_CRITIC_ROUNDS = 2, // 剩余 <25%：critic 轮数 2 → 1
  RULES_ONLY = 3, // 剩余 <15%：跳过 LLM critic，产物标「未经语义审核」
  HALT = 4, // 剩余 <5%：存 checkpoint，通知 FDE，暂停
}

const LEVEL_LABELS: Readonly<Record<DegradeLevel, string>> = {
  [DegradeLevel.NONE]: "正常",
  [DegradeLevel.NO_SELF_CONSISTENCY]: "关闭多采样自洽",
  [DegradeLevel.FEWER_CRITIC_ROUNDS]: "critic 轮数降至 1",
  [DegradeLevel.RULES_ONLY]: "仅规则评审（产物标记未经语义审核）",
  [DegradeLevel.HALT]: "暂停并保存 checkpoint",
};

/** Python 侧的 `DegradeLevel.label` 属性。 */
export function degradeLabel(lvl: DegradeLevel): string {
  const s = LEVEL_LABELS[lvl];
  if (s === undefined) throw new Error(`未知降级级别: ${lvl}`);
  return s;
}

/** Python `DegradeLevel(v)`：未知值抛 ValueError。别用 `as DegradeLevel` 断言 ——
 * 那是把校验删掉，而这个值会从 checkpoint / 事件 payload 里读回来。 */
export function parseDegradeLevel(v: unknown): DegradeLevel {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4) {
    return v as DegradeLevel;
  }
  throw new Error(`未知降级级别: ${String(v)}`);
}

/**
 * 剩余比例 → 降级级别。
 *
 * 顺序不影响结果（Python 侧是遍历全表取 max，不是命中即停），照抄原表以便对读。
 */
const LADDER: readonly (readonly [number, DegradeLevel])[] = [
  [0.05, DegradeLevel.HALT],
  [0.15, DegradeLevel.RULES_ONLY],
  [0.25, DegradeLevel.FEWER_CRITIC_ROUNDS],
  [0.4, DegradeLevel.NO_SELF_CONSISTENCY],
];

/**
 * 预算维度。**顺序是语义的一部分**：`tightest` 在并列时取第一个（见下），
 * 而全新预算的四个维度剩余比例都是 1.0 —— 谁排第一，snapshot 里的
 * `tightest` 就是谁。
 */
export const DIMS = ["tokens", "wallclock_s", "tool_calls", "usd"] as const;
export type Dim = (typeof DIMS)[number];

const DIM_SET: ReadonlySet<string> = new Set<string>(DIMS);

export function isDim(k: string): k is Dim {
  return DIM_SET.has(k);
}

export function parseDim(k: string): Dim {
  if (!isDim(k)) throw new Error(`未知预算维度: ${k}`);
  return k;
}

/**
 * Python dataclass 的字段默认值。
 *
 * 按契约放在模块常量里而不是 class field —— class field 的初始化顺序会让子类
 * 覆盖基类，而这里的默认值是「一次 Run 的总闸」，被静默改掉不会有任何报错。
 */
export const DEFAULT_LIMITS: Readonly<Record<Dim, number>> = {
  tokens: 2_000_000,
  wallclock_s: 3600,
  tool_calls: 500,
  usd: 50.0,
};

/** `snapshot()` 的形状。键名沿用 Python 的 snake_case —— 它直接进事件 payload
 * 和前端（server.py 读 `snapshot()["spent"]["usd"]`），改名就是改线上契约。 */
export interface BudgetSnapshot {
  readonly spent: Record<Dim, number>;
  readonly limits: Record<Dim, number>;
  readonly tightest: Dim;
  readonly remaining_ratio: number;
  readonly level: number;
  readonly level_label: string;
}

/** `toDict()` 的形状 —— 见 `Budget.toDict` 的说明，Python 侧没有对应物。 */
export interface BudgetState {
  readonly limits: Record<Dim, number>;
  readonly spent: Record<Dim, number>;
  readonly floor: number;
}

// ── Python round(x, nd) 的移植 ─────────────────────────────────────

const F64 = new DataView(new ArrayBuffer(8));

/** 把 double 精确拆成 `m * 2^e`（m、e 均为整数，无任何舍入）。 */
function decompose(x: number): { m: bigint; e: number } {
  F64.setFloat64(0, x);
  const bits = F64.getBigUint64(0);
  const neg = (bits >> 63n) === 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xf_ffff_ffff_ffffn;
  // 次正规数（exp === 0）没有隐含的前导 1，指数固定在最小档
  const m = exp === 0 ? frac : frac | 0x10_0000_0000_0000n;
  return { m: neg ? -m : m, e: exp === 0 ? -1074 : exp - 1075 };
}

/**
 * Python 的 `round(x, nd)`。
 *
 * **不要**用 `Math.round(x * 10**nd) / 10**nd` 或 `Number(x.toFixed(nd))` 代替，
 * 两处都会分叉：
 *   1. `x * 1e4` 本身带舍入误差，可能把一个不是并列的值推成并列（或反过来）；
 *   2. 恰好并列时 CPython 取偶（banker's rounding），JS 一律取远离零的那侧。
 *
 * 第 2 条不是理论问题：`ratio = 0.03125`（花掉 96.875%）是精确的二进制半整数，
 * Python 给 `0.0312`，`toFixed(4)` 给 `0.0313`。`snapshot()` 的
 * `remaining_ratio` 进事件日志、进 UI、进跨版本 diff —— 差最后一位就是长期噪声。
 *
 * 做法是在**精确有理数**上舍入：x = m·2^e，要求的是 round_half_even(m·2^e·10^nd)。
 * 全程 BigInt，不碰浮点中间量。
 */
export function roundHalfEven(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const { m, e } = decompose(x);
  const p10 = 10n ** BigInt(nd);

  let num: bigint;
  let den: bigint;
  if (e >= 0) {
    num = m * (1n << BigInt(e)) * p10;
    den = 1n;
  } else {
    num = m * p10;
    den = 1n << BigInt(-e);
  }

  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = a / den;
  const rem2 = (a % den) * 2n; // 与 den 比大小即可判出 <½ / =½ / >½
  const up = rem2 > den || (rem2 === den && (q & 1n) === 1n);
  const n = up ? q + 1n : q;

  // CPython 是「精确舍到 nd 位十进制 → 再 strtod 回最近的 double」。n 与 10^nd
  // 在这个量级上都是精确可表示的，IEEE 除法又是正确舍入的，所以这一步等价。
  const out = Number(neg ? -n : n) / Number(p10);
  return out === 0 ? 0 * (neg ? -1 : 1) : out;
}

// ── Budget ─────────────────────────────────────────────────────────

/**
 * 多维预算。任一维度耗尽即触发降级。
 *
 * Python 侧 `limit(dim)` 用 `getattr(self, dim)` 反射（维度名同时是字段名，也是
 * `_spent` 的键）。这里把四个上限收进 `limits` 记录，反射的需求随之消失 ——
 * 但**未知维度必须继续抛**：`Record<Dim, number>` 在运行时就是个普通对象，
 * 从 JSON / 旧 checkpoint 里读进来的错拼键会被静默新建，然后这笔钱永远不进
 * 任何一档判定，预算在账面上"花不完"。
 */
export class Budget {
  /** 各维度上限。 */
  readonly limits: Record<Dim, number>;

  /**
   * 已消耗。下划线沿用 Python 的「约定私有」而不是 TS 的 `private` ——
   * golden 的 latch 用例正是靠直接改它制造一次"退款"（`b._spent["tokens"] = 100`）
   * 来验证降级不回退；`private` 会让这条用例根本写不出来。
   */
  readonly _spent: Record<Dim, number>;

  /** 已宣告的最低级别，只升不降。 */
  private _floor: DegradeLevel = DegradeLevel.NONE;

  constructor(limits: Partial<Record<Dim, number>> = {}) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const [k, v] of Object.entries(limits)) {
      if (v !== undefined) this.limits[parseDim(k)] = v;
    }
    this._spent = { tokens: 0.0, wallclock_s: 0.0, tool_calls: 0.0, usd: 0.0 };
  }

  // ── 记账 ────────────────────────────────────────────────────
  /**
   * 记一笔消耗。未知维度抛错。
   *
   * 抛之前**已经记上的不回滚** —— Python 侧就是边遍历边加，`spend(tokens=10,
   * nope=1)` 会留下 tokens=10 再抛。照抄，不要"优化"成先校验后统一写入：
   * 那样在 TS 侧看着更干净，但两边对同一次错误调用的账面状态会分叉，而这种
   * 调用出现时通常已经在重试路径上了。
   */
  spend(amounts: Partial<Record<Dim, number>>): void {
    for (const [k, v] of Object.entries(amounts)) {
      const dim = parseDim(k);
      if (v !== undefined) this._spent[dim] += v;
    }
  }

  spent(dim: Dim): number {
    return this._spent[dim];
  }

  limit(dim: Dim): number {
    return this.limits[dim];
  }

  remaining(dim: Dim): number {
    return Math.max(0.0, this.limit(dim) - this._spent[dim]);
  }

  ratio(dim: Dim): number {
    const lim = this.limit(dim);
    return lim <= 0 ? 1.0 : Math.max(0.0, 1.0 - this._spent[dim] / lim);
  }

  /**
   * 最紧的维度及其剩余比例 —— 降级判定看它。
   *
   * Python 的 `min(..., key=...)` 在并列时返回**第一个**最小值。这里用严格
   * `<` 来保持同样的取首语义：全新预算四维都是 1.0，两边都必须给 "tokens"。
   * 用 `<=` 就会变成取末（"usd"），snapshot 里的 tightest 字段立刻跨语言分叉。
   */
  tightest(): readonly [Dim, number] {
    let bestDim: Dim = DIMS[0];
    let bestRatio = this.ratio(DIMS[0]);
    for (const d of DIMS.slice(1)) {
      const r = this.ratio(d);
      if (r < bestRatio) {
        bestDim = d;
        bestRatio = r;
      }
    }
    return [bestDim, bestRatio];
  }

  // ── 降级 ────────────────────────────────────────────────────
  /**
   * 当前降级级别。**读一次就会 latch**（写入内部 `_floor`）。
   *
   * **单调不减**：一旦宣告过某个降级级别就不再回退，即使事后上调了额度。
   * 原因是降级已经改变了产物 —— 少跑的 critic 不会因为后来钱变多了就补跑，
   * 产物上的「未经语义审核」标记也不该悄悄消失。
   *
   * Python 侧这是个 `@property`。这里**故意**做成方法而不是 getter：一个读了
   * 就改状态的 getter 迟早会被后来的人当脏代码"清理"成纯函数，而那一改会
   * 悄无声息地打开降级回退的口子（没有任何测试会因为"少写一次内部字段"而红，
   * 除了 golden 里那条 latch 用例）。方法名和这段注释就是给那个人看的。
   */
  currentLevel(): DegradeLevel {
    const [, r] = this.tightest();
    let lvl = DegradeLevel.NONE;
    // Python 是 `max(lvl, candidate)`；这里写成显式比较而不是 Math.max，
    // 因为 Math.max 的返回类型是 number，赋回枚举要么报错要么得靠断言。
    for (const [threshold, candidate] of LADDER) {
      if (r < threshold && candidate > lvl) lvl = candidate;
    }
    if (this._floor > lvl) lvl = this._floor;
    this._floor = lvl; // latch
    return lvl;
  }

  /** 外部强制降级（例如用户主动选省钱模式）。 */
  pinLevel(lvl: DegradeLevel): void {
    if (lvl > this._floor) this._floor = lvl;
  }

  check(dim: Dim = "tokens"): void {
    if (this.remaining(dim) <= 0) {
      throw new BudgetExhausted(dim, this.limit(dim), this.spent(dim));
    }
  }

  // ── 节点级派生 ──────────────────────────────────────────────
  /**
   * 本节点实际要跑几轮 critic。
   *
   * **降级不许把审查降到零** —— 这是与 Python golden 的一处**故意分叉**
   * （`golden/budget.json` 的 level 3 原值是 0）。
   *
   * 理由是本枚举自己写的语义：`RULES_ONLY` 的注释是「跳过 LLM critic，产物标
   * 『未经语义审核』」，描述文案是「仅规则评审」—— **规则档 critic 本来就该
   * 继续跑**。返回 0 会让 `loop.ts` 的 `rounds !== 0` 守卫把整个 critic 环连同
   * refine 一起跳过，规则档也一并没了。同一档的 `allowLlmCritic()` 已经返回
   * false，两个方法对同一档给出互相矛盾的指令，而且让 `allowLlmCritic` 在这一
   * 档的分支永远不可达。
   *
   * 为什么这条比省钱重要：`currentLevel()` 是 latch，而 `RULES_ONLY` 档
   * `mustHalt()` 仍是 false —— **梳理继续进行，只是从此没有任何 critic 看过**。
   * 失败方向是"静默发布未经审核的产物"，不是"明确失败"。规则档 critic 不花
   * 模型的钱，省它省不出什么，代价却是审查断档。
   *
   * `HALT` 档返回 0 是对的：那一档本来就不该有工作在跑。
   * `requested === 0`（节点自己声明不要 critic）也照旧是 0 —— 下限护的是降级
   * 这个动作，不是去覆盖节点自己的声明。
   */
  criticRounds(requested: number): number {
    const lvl = this.currentLevel(); // 注意：latch
    if (lvl >= DegradeLevel.HALT) return 0;
    if (lvl >= DegradeLevel.FEWER_CRITIC_ROUNDS) return Math.min(requested, 1);
    return requested;
  }

  allowSelfConsistency(): boolean {
    return this.currentLevel() < DegradeLevel.NO_SELF_CONSISTENCY;
  }

  allowLlmCritic(): boolean {
    return this.currentLevel() < DegradeLevel.RULES_ONLY;
  }

  mustHalt(): boolean {
    return this.currentLevel() >= DegradeLevel.HALT;
  }

  snapshot(): BudgetSnapshot {
    const [dim, r] = this.tightest();
    // Python 侧读了三次 `self.level`（每次都 latch）。latch 是幂等的，所以读一次
    // 等价 —— 但**必须真的读一次**：snapshot 常常是降级后第一个被调用的东西，
    // 少了这次读，_floor 就要等到下一个 allow_* 才落地。
    const lvl = this.currentLevel();
    return {
      spent: { ...this._spent },
      limits: Object.fromEntries(DIMS.map((d) => [d, this.limit(d)])) as Record<Dim, number>,
      tightest: dim,
      remaining_ratio: roundHalfEven(r, 4),
      level: lvl,
      level_label: degradeLabel(lvl),
    };
  }

  /**
   * 完整可复原状态。Python 侧没有对应物（那边靠 dataclass + 进程内共享），
   * TS 侧按契约显式化。
   *
   * **必须带上 `floor`**：checkpoint 恢复后如果只还原 limits 与 spent，一次
   * 「额度用尽 → 降级 → 人工加额 → 重启」的流程会让产物上的「未经语义审核」
   * 标记凭空消失，而少跑的那几轮 critic 并不会补回来。`snapshot()` 是给人看的
   * 投影，不带 floor，别拿它当持久化格式。
   */
  toDict(): BudgetState {
    return {
      limits: { ...this.limits },
      spent: { ...this._spent },
      floor: this._floor,
    };
  }

  static fromDict(d: BudgetState): Budget {
    const b = new Budget(d.limits);
    for (const [k, v] of Object.entries(d.spent)) {
      if (v !== undefined) b._spent[parseDim(k)] = v;
    }
    b.pinLevel(parseDegradeLevel(d.floor));
    return b;
  }
}
