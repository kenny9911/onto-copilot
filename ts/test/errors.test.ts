/**
 * errors 的 golden 校验 —— 消息串和继承关系都是 Python 侧真跑出来的。
 *
 * 这一层没有算法，只有**字节**和**类型分派**，所以测试专钉三样：
 *   1. instanceof 链（NodeFailure / HumanInputRequired **不是** HarnessError）；
 *   2. 消息格式串逐字一致，尤其 BudgetExhausted —— server.py 有条文本兜底在
 *      匹配它；
 *   3. 消息里两个 Python 格式化原语（`.0f` / `!r`）的每一个分支。
 *
 * 与 Python **零差异**。曾经有一条：`pyRepr` 不转义非 ASCII 的不可打印字符，
 * 当时判断「为诊断消息拖一张 unicodedata 表不划算」。后来发现判据就是
 * `\p{C} ∪ \p{Z}` 减掉 ASCII 空格（对全部码位比对过 CPython，零不一致），
 * 于是补齐了 —— golden 现在被逐字节直接断言，没有任何还原步骤。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BudgetExhausted,
  DagError,
  DeterminismViolation,
  FrozenPlanViolation,
  HarnessError,
  HumanInputRequired,
  NodeFailure,
  SandboxError,
  ToolDenied,
  formatFixed0,
  pyRepr,
} from "../src/kernel/errors.js";

interface Golden {
  hierarchy: Record<string, string[]>;
  budget_exhausted: { dimension: string; limit_lit: string; spent_lit: string; message: string }[];
  determinism_violation: { key: string; recorded: string; replayed: string; message: string }[];
  node_failure: { node_id: string; reason: string; retryable: boolean; message: string }[];
  human_input_required: { node_id: string; request_id: string; message: string }[];
  format_fixed0: { lit: string; out: string }[];
  repr_str: { in: string; out: string }[];
  defaults: { node_failure_retryable: boolean };
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/errors.json"), "utf8"),
) as Golden;

// ── instanceof 链 ──────────────────────────────────────────────────

/** 每个类造一个实例；构造参数无所谓，这里只关心它的原型链。 */
const SAMPLES: Record<string, Error> = {
  HarnessError: new HarnessError("m"),
  DagError: new DagError("m"),
  FrozenPlanViolation: new FrozenPlanViolation("m"),
  DeterminismViolation: new DeterminismViolation("k", "r1", "r2"),
  BudgetExhausted: new BudgetExhausted("usd", 1, 2),
  ToolDenied: new ToolDenied("m"),
  SandboxError: new SandboxError("m"),
  NodeFailure: new NodeFailure("n", "r"),
  HumanInputRequired: new HumanInputRequired("n", "req", {}),
};

/** Python 的 Exception 对应 JS 的 Error（两边都是"可捕获错误"的根）。 */
const CTORS: Record<string, abstract new (...a: never[]) => Error> = {
  Exception: Error,
  HarnessError,
  DagError,
  FrozenPlanViolation,
  DeterminismViolation,
  BudgetExhausted,
  ToolDenied,
  SandboxError,
  NodeFailure,
  HumanInputRequired,
};

describe("继承关系与 Python mro 一致", () => {
  for (const [name, mro] of Object.entries(G.hierarchy)) {
    it(name, () => {
      const inst = SAMPLES[name]!;
      // 正反都断：该是的必须是，不该是的必须不是。只断正向的话，把所有类都挂到
      // HarnessError 下面也能全绿，而那恰好是 scheduler 分派失灵的那个 bug。
      for (const [other, Ctor] of Object.entries(CTORS)) {
        expect(inst instanceof Ctor, `${name} instanceof ${other}`).toBe(mro.includes(other));
      }
      expect(inst.name).toBe(name);
    });
  }

  it("NodeFailure / HumanInputRequired 不在 HarnessError 之下", () => {
    // 单独写死一条：上面那圈是数据驱动的，golden 换了它会跟着换；这条不会。
    expect(new NodeFailure("n", "r")).not.toBeInstanceOf(HarnessError);
    expect(new HumanInputRequired("n", "q", {})).not.toBeInstanceOf(HarnessError);
    expect(new BudgetExhausted("usd", 1, 2)).toBeInstanceOf(HarnessError);
  });

  it("跨 catch 边界仍认得出（instanceof 不靠 name 兜底）", () => {
    let caught: unknown;
    try {
      throw new BudgetExhausted("usd", 1, 2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    expect(caught).toBeInstanceOf(HarnessError);
    expect(caught).toBeInstanceOf(Error);
  });
});

// ── 消息字节 ───────────────────────────────────────────────────────

describe("BudgetExhausted 消息（server.py 拿它做文本兜底）", () => {
  for (const [i, v] of G.budget_exhausted.entries()) {
    it(`向量 ${i}: ${v.dimension} ${v.spent_lit}/${v.limit_lit}`, () => {
      const e = new BudgetExhausted(v.dimension, Number(v.limit_lit), Number(v.spent_lit));
      expect(e.message).toBe(v.message);
    });
  }

  it("server.py:799 的子串兜底照样命中", () => {
    const e = new BudgetExhausted("usd", 5, 5);
    expect(e.message).toContain("usd 预算耗尽");
    // Python 的 str(exc) 只有消息，JS 的 String(err) 会带上 "BudgetExhausted: "
    // 前缀 —— 子串匹配不受影响，但下游若照抄 str(exc) 去做**相等**比较会踩。
    expect(String(e)).toBe("BudgetExhausted: usd 预算耗尽: 5 / 5");
    expect(String(e)).toContain("usd 预算耗尽");
  });

  it("字段原样保留（异常链认类型那条路靠 dimension）", () => {
    const e = new BudgetExhausted("usd", 1.25, 9.5);
    expect(e.dimension).toBe("usd");
    expect(e.limit).toBe(1.25); // 消息里被 .0f 磨圆了，字段不许磨
    expect(e.spent).toBe(9.5);
    expect(e.message).toBe("usd 预算耗尽: 10 / 1"); // 9.5 → half-even → 10
  });
});

describe("DeterminismViolation 消息", () => {
  for (const [i, v] of G.determinism_violation.entries()) {
    it(`向量 ${i}: ${JSON.stringify(v.key)}`, () => {
      const e = new DeterminismViolation(v.key, v.recorded, v.replayed);
      expect(e.message).toBe(v.message);
      expect(e.key).toBe(v.key);
      expect(e.recorded).toBe(v.recorded);
      expect(e.replayed).toBe(v.replayed);
    });
  }

  it("三行结构与缩进（下游有按行读这条消息的）", () => {
    expect(new DeterminismViolation("EXTRACT#0", "aaaa", "bbbb").message).toBe(
      "effect 'EXTRACT#0' 重放不一致\n  已记录: aaaa\n  重算出: bbbb",
    );
  });
});

describe("NodeFailure", () => {
  for (const [i, v] of G.node_failure.entries()) {
    it(`向量 ${i}`, () => {
      const e = new NodeFailure(v.node_id, v.reason, v.retryable);
      expect(e.message).toBe(v.message);
      expect(e.nodeId).toBe(v.node_id);
      expect(e.reason).toBe(v.reason);
      expect(e.retryable).toBe(v.retryable);
    });
  }

  it("retryable 默认 true", () => {
    // 默认值翻反是这个仓库最贵的一类错：不可重试的失败被无限重试，
    // 每一轮都真花钱。golden 里 defaults 就是钉这一条的。
    expect(G.defaults.node_failure_retryable).toBe(true);
    expect(new NodeFailure("n", "r").retryable).toBe(true);
    expect(new NodeFailure("n", "r", false).retryable).toBe(false);
  });
});

describe("HumanInputRequired", () => {
  for (const [i, v] of G.human_input_required.entries()) {
    it(`向量 ${i}`, () => {
      const e = new HumanInputRequired(v.node_id, v.request_id, { q: "选哪个" });
      expect(e.message).toBe(v.message);
      expect(e.nodeId).toBe(v.node_id);
      expect(e.requestId).toBe(v.request_id);
    });
  }

  it("payload 存引用不存副本（与 Python 的 dict 语义一致）", () => {
    const p = { q: "选哪个" };
    expect(new HumanInputRequired("n", "req", p).payload).toBe(p);
  });
});

describe("简单子类：消息原样透传", () => {
  const simple = [DagError, FrozenPlanViolation, ToolDenied, SandboxError, HarnessError] as const;
  for (const Ctor of simple) {
    it(Ctor.name, () => expect(new Ctor("出事了 boom").message).toBe("出事了 boom"));
  }
});

// ── 格式化原语 ─────────────────────────────────────────────────────

describe("formatFixed0 == Python format(x, '.0f')", () => {
  for (const v of G.format_fixed0) {
    it(v.lit, () => expect(formatFixed0(Number(v.lit))).toBe(v.out));
  }

  it("toFixed(0) 在这些点上是错的 —— 别「简化」回去", () => {
    // 这条不是在测 JS，是在把「为什么不能用 toFixed」焊进测试里。
    for (const x of [0.5, 2.5, -0.5, -2.5, 1e21, Infinity, NaN]) {
      expect(formatFixed0(x)).not.toBe(x.toFixed(0));
    }
    expect(formatFixed0(0.5)).toBe("0"); // toFixed 给 "1"
    expect(formatFixed0(-2.5)).toBe("-2"); // toFixed 给 "-3"
    expect(formatFixed0(1e21)).toBe("1000000000000000000000"); // toFixed 给 "1e+21"
    expect(formatFixed0(Infinity)).toBe("inf"); // toFixed 给 "Infinity"
  });

  it("大整数打印 double 的精确值，不是 shortest round-trip", () => {
    // String(1.2345678901234568e20) 给 "123456789012345680000"，
    // 而这个 double 的精确值是 ...683968，Python 打的是后者。
    expect(formatFixed0(1.2345678901234568e20)).toBe("123456789012345683968");
  });

  it("负零的符号来自输入而不是结果", () => {
    expect(formatFixed0(-0.4)).toBe("-0");
    expect(formatFixed0(-0)).toBe("-0");
    expect(formatFixed0(0)).toBe("0");
  });
});

describe("pyRepr == Python repr(str)", () => {
  for (const v of G.repr_str) {
    it(JSON.stringify(v.in), () => expect(pyRepr(v.in)).toBe(v.out));
  }

  it("不可打印字符按 CPython 的宽度规则转义，可打印的非 ASCII 原样保留", () => {
    expect(pyRepr("nbsp\u00a0x")).toBe("'nbsp\\xa0x'"); // Zs，< 0x100 → \xNN
    expect(pyRepr("zwj\u200dx")).toBe("'zwj\\u200dx'"); // Cf，< 0x10000 → \uNNNN
    expect(pyRepr("\uffff")).toBe("'\\uffff'"); // Cn（未分配）也算不可打印
    expect(pyRepr("\u{e0001}")).toBe("'\\U000e0001'"); // 星际面 → \UNNNNNNNN
    expect(pyRepr("采购订单 🐍")).toBe("'采购订单 🐍'"); // 可打印：中文、ASCII 空格、emoji
  });

  it("引号选择：有 ' 无 \" 才换双引号（Python 为少转义一次）", () => {
    expect(pyRepr("EXTRACT#0")).toBe("'EXTRACT#0'"); // 最常见的路径就与 JSON.stringify 不同
    expect(JSON.stringify("EXTRACT#0")).toBe('"EXTRACT#0"');
    expect(pyRepr("a'b")).toBe('"a\'b"');
    expect(pyRepr('a"b')).toBe("'a\"b'");
    expect(pyRepr("a'\"b")).toBe("'a\\'\"b'"); // 两种都有 → 单引号 + 转义 '
  });

  it("控制字符走 \\xNN，不走 JSON 的 \\u00NN", () => {
    expect(pyRepr("\x00")).toBe("'\\x00'");
    expect(pyRepr("\x7f")).toBe("'\\x7f'");
    expect(pyRepr("a\nb")).toBe("'a\\nb'");
  });
});

describe("ValueError 只有一份类身份", () => {
  // onto/canonical.ts 与 onto/questions.ts 一度各定义了一份同名类。两份同名类
  // 就是两个类身份：`instanceof ValueError` 会漏掉其中一份，而且**不报错** ——
  // 上层按类型分派「输入非法」与「内部炸了」，漏判的后果是把用户的输入错误
  // 当成系统故障报出去。
  it("三个模块导出的是同一个类（不是三个长得一样的类）", async () => {
    const [k, c, q] = await Promise.all([
      import("../src/kernel/errors.js"),
      import("../src/onto/canonical.js"),
      import("../src/onto/questions.js"),
    ]);
    expect(c.ValueError).toBe(k.ValueError);
    expect(q.ValueError).toBe(k.ValueError);
  });

  it("validateUsageRow 抛的是 ValueError —— Python 的 UsageRow.validate 就抛这个", async () => {
    const { validateUsageRow, makeUsageRow } = await import("../src/store/types.js");
    const { ValueError } = await import("../src/kernel/errors.js");
    // kind 不在 {build, chat, aux} 里
    const bad = makeUsageRow({ id: "u1", model: "opus", kind: "nope", ts: 0, day: "2026-01-01" });
    expect(() => validateUsageRow(bad)).toThrow(ValueError);
    // 消息与 Python 逐字节一致（server 层拿 message 做子串匹配）
    expect(() => validateUsageRow(bad)).toThrow("usage kind 不支持: nope");
  });
});
