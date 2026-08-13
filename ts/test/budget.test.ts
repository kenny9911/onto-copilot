/**
 * budget 的 golden 校验。
 *
 * 两份 golden：
 *   - `golden/budget.json`      主导出器的七档消耗比例 + 一条 latch
 *   - `golden/budget.extra.json` 我导的补充（tools/golden/budget.py）：snapshot 的
 *     round-half-even、tightest 并列取首、边界额度、BudgetExhausted 的消息串、
 *     spend 未知维度
 *
 * 期望值一个都不是手写的 —— 手写的是我对 Python 行为的猜测，golden 是它的事实。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  Budget,
  DEFAULT_LIMITS,
  DegradeLevel,
  DIMS,
  degradeLabel,
  parseDegradeLevel,
  parseDim,
  roundHalfEven,
  type Dim,
} from "../src/kernel/budget.js";
import { BudgetExhausted } from "../src/kernel/errors.js";

// ── golden 的形状 ────────────────────────────────────────────────

interface LadderRow {
  spent_frac: number;
  level: number;
  critic_rounds_of_2: number;
  allow_self_consistency: boolean;
  allow_llm_critic: boolean;
  must_halt: boolean;
}
interface LatchRow {
  case: "latch";
  after_spend_900: number;
  after_rollback_to_100: number;
}
interface MainGolden {
  ladder: (LadderRow | LatchRow)[];
}

type Limits = Partial<Record<Dim, number>>;

interface SnapOut {
  spent: Record<Dim, number>;
  limits: Record<Dim, number>;
  tightest: Dim;
  remaining_ratio: number;
  level: number;
  level_label: string;
}
interface ExtraGolden {
  snapshot: { limits: Limits; spends: Limits[]; out: SnapOut }[];
  accessors: {
    limits: Limits;
    spends: Limits[];
    dims: { dim: Dim; limit: number; spent: number; remaining: number; ratio: number }[];
    tightest: [Dim, number];
  }[];
  check: {
    limits: Limits;
    spends: Limits[];
    dim: Dim | null;
    raises: boolean;
    message?: string;
    dimension?: string;
    limit?: number;
    spent?: number;
  }[];
  spend_unknown_dim: { key: string; arg0: string; spent_after: Record<Dim, number> };
  spend_partial_before_throw: Record<Dim, number>;
  labels: { level: number; name: string; label: string }[];
  pinned: {
    pinned: number;
    level: number;
    critic_rounds: { requested: number; out: number }[];
    allow_self_consistency: boolean;
    allow_llm_critic: boolean;
    must_halt: boolean;
  }[];
  pin_monotonic: { after_pin_3: number; after_pin_1: number };
  round4: { in: number; out: number }[];
}

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as T;

const G = read<MainGolden>("budget.json");
const X = read<ExtraGolden>("budget.extra.json");

/** 照抄 tools/export_golden.py 的 export_budget：同样的构造、同样的消耗。 */
function build(limits: Limits, spends: Limits[]): Budget {
  const b = new Budget(limits);
  for (const s of spends) b.spend(s);
  return b;
}

const isLatch = (r: LadderRow | LatchRow): r is LatchRow =>
  (r as LatchRow).case === "latch";

// ── 主 golden ────────────────────────────────────────────────────

describe("降级阶梯（golden/budget.json）", () => {
  for (const row of G.ladder) {
    if (isLatch(row)) continue;
    it(`花掉 ${row.spent_frac * 100}%`, () => {
      // 与 export_budget 一字不差：Budget(tokens=1000, usd=10.0)，只花 tokens
      const b = new Budget({ tokens: 1000, usd: 10.0 });
      b.spend({ tokens: 1000 * row.spent_frac });
      expect(b.currentLevel()).toBe(row.level);
      expect(b.criticRounds(2)).toBe(row.critic_rounds_of_2);
      expect(b.allowSelfConsistency()).toBe(row.allow_self_consistency);
      expect(b.allowLlmCritic()).toBe(row.allow_llm_critic);
      expect(b.mustHalt()).toBe(row.must_halt);
    });
  }

  it("latch：花钱后又「退款」，级别不许降回去", () => {
    const row = G.ladder.find(isLatch);
    expect(row).toBeDefined();
    const b = new Budget({ tokens: 1000 });
    b.spend({ tokens: 900 });
    expect(b.currentLevel()).toBe(row!.after_spend_900);
    // Python 侧是 `b._spent["tokens"] = 100` —— 人为回退水位。这正是 `_spent`
    // 保持"约定私有"而不是 TS private 的原因：这条用例必须写得出来。
    b._spent.tokens = 100;
    expect(b.currentLevel()).toBe(row!.after_rollback_to_100);
  });
});

// ── 补充 golden ──────────────────────────────────────────────────

describe("snapshot（golden/budget.extra.json）", () => {
  for (const [i, c] of X.snapshot.entries()) {
    it(`向量 ${i}：${JSON.stringify(c.limits)} − ${JSON.stringify(c.spends)}`, () => {
      expect(build(c.limits, c.spends).snapshot()).toEqual(c.out);
    });
  }
});

describe("逐维读数与 tightest", () => {
  for (const [i, c] of X.accessors.entries()) {
    it(`向量 ${i}`, () => {
      const b = build(c.limits, c.spends);
      for (const d of c.dims) {
        expect(b.limit(d.dim)).toBe(d.limit);
        expect(b.spent(d.dim)).toBe(d.spent);
        expect(b.remaining(d.dim)).toBe(d.remaining);
        // 比例不做容差比较：两边都是同一串 IEEE754 运算，必须**逐位**相同。
        // 容差会把"公式抄错了但数量级对"这类错误放过去。
        expect(b.ratio(d.dim)).toBe(d.ratio);
      }
      expect(b.tightest()).toEqual(c.tightest);
    });
  }
});

describe("check / BudgetExhausted", () => {
  for (const [i, c] of X.check.entries()) {
    it(`向量 ${i}：${c.raises ? "抛" : "不抛"}`, () => {
      const b = build(c.limits, c.spends);
      const run = () => (c.dim === null ? b.check() : b.check(c.dim));
      if (!c.raises) {
        expect(run).not.toThrow();
        return;
      }
      let caught: unknown;
      try {
        run();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BudgetExhausted);
      const err = caught as BudgetExhausted;
      // 消息串是契约：server.py 在异常链认不出类型时靠 `"usd 预算耗尽" in text`
      // 兜底判"欠费"。里面的 `:.0f` 是 round-half-even（10.5 → "10"）。
      expect(err.message).toBe(c.message);
      expect(err.dimension).toBe(c.dimension);
      expect(err.limit).toBe(c.limit);
      expect(err.spent).toBe(c.spent);
    });
  }
});

describe("spend 的未知维度", () => {
  it("抛错，消息与 Python 的 KeyError 参数一致", () => {
    const b = new Budget();
    expect(() =>
      // 编译期就该拦住；这里绕过类型是为了模拟 JSON / 旧 checkpoint 灌进来的
      // 错拼键 —— 运行时的 throw 才是真正的防线。
      (b as unknown as { spend(a: Record<string, number>): void }).spend({
        [X.spend_unknown_dim.key]: 1.0,
      }),
    ).toThrow(X.spend_unknown_dim.arg0);
    expect(b._spent).toEqual(X.spend_unknown_dim.spent_after);
  });

  it("抛之前已经记上的不回滚（照抄 Python 的边遍历边加）", () => {
    const b = new Budget({ tokens: 1000 });
    try {
      (b as unknown as { spend(a: Record<string, number>): void }).spend({
        tokens: 10,
        nope: 1.0,
      });
    } catch {
      /* 形状由下面这行断言 */
    }
    expect(b._spent).toEqual(X.spend_partial_before_throw);
  });
});

describe("阶梯标签与 pin_level", () => {
  it("五级的数值、名字、标签", () => {
    for (const l of X.labels) {
      const lvl = parseDegradeLevel(l.level);
      expect(DegradeLevel[lvl]).toBe(l.name);
      expect(degradeLabel(lvl)).toBe(l.label);
    }
  });

  for (const row of X.pinned) {
    it(`pin 到 ${row.pinned} 后的派生`, () => {
      const b = new Budget();
      b.pinLevel(parseDegradeLevel(row.pinned));
      expect(b.currentLevel()).toBe(row.level);
      for (const cr of row.critic_rounds) {
        expect(b.criticRounds(cr.requested)).toBe(cr.out);
      }
      expect(b.allowSelfConsistency()).toBe(row.allow_self_consistency);
      expect(b.allowLlmCritic()).toBe(row.allow_llm_critic);
      expect(b.mustHalt()).toBe(row.must_halt);
    });
  }

  it("pin_level 只升不降", () => {
    const b = new Budget();
    b.pinLevel(DegradeLevel.RULES_ONLY);
    expect(b.currentLevel()).toBe(X.pin_monotonic.after_pin_3);
    b.pinLevel(DegradeLevel.NO_SELF_CONSISTENCY);
    expect(b.currentLevel()).toBe(X.pin_monotonic.after_pin_1);
  });
});

describe("round(x, 4)：CPython 的 ties-to-even", () => {
  for (const c of X.round4) {
    it(`${c.in} → ${c.out}`, () => {
      expect(roundHalfEven(c.in, 4)).toBe(c.out);
    });
  }

  it("并列点上与 toFixed 确实不同（分叉存在，才需要这段实现）", () => {
    // 这条不是在测 Python，是在钉住"为什么不能用 toFixed" —— 哪天有人把
    // roundHalfEven 换成 Number(x.toFixed(4))，上面那组 golden 会红，这条会绿，
    // 两条一起看就知道是被"简化"掉了而不是 golden 过期。
    expect(Number((0.03125).toFixed(4))).toBe(0.0313);
    expect(roundHalfEven(0.03125, 4)).toBe(0.0312);
  });
});

describe("Python 侧没覆盖、但 TS 侧必须钉住的", () => {
  it("默认额度与 Python dataclass 的字段默认值一致", () => {
    // 走 golden 的第一条 snapshot（limits 为空 = 全默认）反查，不手写数字
    const fromGolden = X.snapshot[0]!.out.limits;
    expect({ ...DEFAULT_LIMITS }).toEqual(fromGolden);
  });

  it("DIMS 的顺序就是 tightest 的并列取首顺序", () => {
    // 顺序是语义：全新预算四维 ratio 都是 1.0，golden 里 tightest 是 DIMS[0]
    expect(DIMS[0]).toBe(X.accessors[0]!.tightest[0]);
    expect(DIMS.map(String)).toEqual(X.accessors[0]!.dims.map((d) => d.dim));
  });

  it("parseDim 拒绝未知维度，不静默建键", () => {
    expect(() => parseDim("tokn")).toThrow("未知预算维度: tokn");
  });

  it("parseDegradeLevel 拒绝越界/非整数，不用 as 断言蒙混", () => {
    expect(() => parseDegradeLevel(5)).toThrow();
    expect(() => parseDegradeLevel(-1)).toThrow();
    expect(() => parseDegradeLevel(1.5)).toThrow();
    expect(() => parseDegradeLevel("3")).toThrow();
  });

  it("currentLevel 是带副作用的：读一次就 latch 住 floor", () => {
    const b = new Budget({ tokens: 1000 });
    b.spend({ tokens: 900 });
    // 关键在于**先读一次**再退款。不读的话 floor 从未被写过，级别会跟着回退 ——
    // 这正是 Python 那个 @property 的副作用，做成方法后必须原样保住。
    expect(b.currentLevel()).toBe(DegradeLevel.RULES_ONLY);
    b._spent.tokens = 0;
    expect(b.currentLevel()).toBe(DegradeLevel.RULES_ONLY);

    const fresh = new Budget({ tokens: 1000 });
    fresh.spend({ tokens: 900 });
    fresh._spent.tokens = 0; // 一次都没读过 → 没 latch 过 → 正常
    expect(fresh.currentLevel()).toBe(DegradeLevel.NONE);
  });

  it("snapshot 本身也会 latch（它常是降级后第一个被调用的）", () => {
    const b = new Budget({ tokens: 1000 });
    b.spend({ tokens: 900 });
    expect(b.snapshot().level).toBe(DegradeLevel.RULES_ONLY);
    b._spent.tokens = 0;
    expect(b.snapshot().level).toBe(DegradeLevel.RULES_ONLY);
  });

  it("toDict/fromDict 往返带上 floor —— 重启不许把降级洗掉", () => {
    const b = new Budget({ tokens: 1000, usd: 10.0 });
    b.spend({ tokens: 900, usd: 1.0 });
    const lvl = b.currentLevel();
    expect(lvl).toBe(DegradeLevel.RULES_ONLY);

    const back = Budget.fromDict(b.toDict());
    expect(back.toDict()).toEqual(b.toDict());
    expect(back.snapshot()).toEqual(b.snapshot());

    // 恢复后就算额度被人工调高，级别也不回退
    const funded = Budget.fromDict({ ...b.toDict(), limits: { ...b.limits, tokens: 1e9 } });
    expect(funded.currentLevel()).toBe(DegradeLevel.RULES_ONLY);
  });

  it("snapshot 返回的是副本，不是内部账本的引用", () => {
    const b = new Budget({ tokens: 1000 });
    const s = b.snapshot();
    b.spend({ tokens: 500 });
    expect(s.spent.tokens).toBe(0);
  });
});
