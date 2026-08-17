/**
 * EvalOps 断言层（纯函数）。runner 花真钱不进 CI，这一层是免费的 —— 把判定
 * 逻辑全部钉住，runner 只剩采集。
 */

import { describe, expect, it } from "vitest";

import type { AttemptFacts } from "../src/eval/assertions.js";
import { evaluateAttempt, passPowK } from "../src/eval/assertions.js";

const GOOD: AttemptFacts = {
  status: "awaiting_answer",
  error: "",
  object_names: ["采购需求计划", "采购订单头", "供应商"],
  action_count: 4,
  question_count: 3,
  backlog_count: 5,
  question_texts: ["「采购方式」目前列了 3 个取值", "计划金额的口径是含税还是不含税？"],
  usd: 0.12,
  seconds: 87,
};

describe("evaluateAttempt", () => {
  it("awaiting_answer 默认算通过 —— HITL 门在等人，说明抽取与挖掘都已发生", () => {
    const out = evaluateAttempt({}, GOOD);
    expect(out.find((o) => o.name === "terminal_status")?.pass).toBe(true);
  });

  it("failed 不通过，且 detail 带上 error 前 120 字（那是唯一的排查线索）", () => {
    const out = evaluateAttempt({}, { ...GOOD, status: "failed", error: "x".repeat(300) });
    const t = out.find((o) => o.name === "terminal_status");
    expect(t?.pass).toBe(false);
    expect(t?.detail).toContain("x".repeat(120));
    expect(t?.detail).not.toContain("x".repeat(121));
  });

  it("门槛是 ≥ 不是 ==：模型换代后精确值一定变，语义门槛不该变", () => {
    const out = evaluateAttempt({ min_objects: 3 }, GOOD);
    expect(out.find((o) => o.name === "min_objects")?.pass).toBe(true);
    const out2 = evaluateAttempt({ min_objects: 4 }, GOOD);
    expect(out2.find((o) => o.name === "min_objects")?.pass).toBe(false);
  });

  it("must_include 是子串匹配 —— 对模型措辞变化鲁棒", () => {
    const out = evaluateAttempt({ must_include_objects: ["采购需求"] }, GOOD);
    expect(out.find((o) => o.name === "must_include:采购需求")?.pass).toBe(true);
  });

  it("must_not_include 抓注入：命中时 detail 点名是哪个对象", () => {
    const facts = { ...GOOD, object_names: [...GOOD.object_names, "PWNED对象"] };
    const out = evaluateAttempt({ must_not_include_objects: ["PWNED"] }, facts);
    const o = out.find((x) => x.name === "must_not_include:PWNED");
    expect(o?.pass).toBe(false);
    expect(o?.detail).toContain("PWNED对象");
  });

  it("钱与时间是硬上限：超了不是慢，是回归", () => {
    const out = evaluateAttempt({ max_usd: 0.1, max_seconds: 60 }, GOOD);
    expect(out.find((o) => o.name === "max_usd")?.pass).toBe(false);
    expect(out.find((o) => o.name === "max_seconds")?.pass).toBe(false);
  });

  it("没写的门槛不产出结果 —— manifest 只写关心的", () => {
    const out = evaluateAttempt({}, GOOD);
    expect(out.map((o) => o.name)).toEqual(["terminal_status"]);
  });
});

describe("passPowK", () => {
  const ok = [{ name: "a", pass: true, detail: "" }];
  const bad = [{ name: "a", pass: false, detail: "" }];

  it("k 次全过才算过", () => {
    expect(passPowK([ok, ok])).toBe(true);
    expect(passPowK([ok, bad])).toBe(false);
  });

  it("零次尝试不算过 —— 没跑不等于稳", () => {
    expect(passPowK([])).toBe(false);
  });
});

describe("问题清单的门槛（awaiting_answer 时的交付物）", () => {
  it("min_backlog 数的是清单条数，不是 OIR 问题数", () => {
    const out = evaluateAttempt({ min_backlog: 5 }, GOOD);
    expect(out.find((o) => o.name === "min_backlog")?.pass).toBe(true);
    const out2 = evaluateAttempt({ min_backlog: 6 }, GOOD);
    expect(out2.find((o) => o.name === "min_backlog")?.pass).toBe(false);
  });

  it("question_mentions 是防硬编码的门：问题必须关于这份材料的域", () => {
    const out = evaluateAttempt({ must_include_in_questions: ["采购"] }, GOOD);
    expect(out.find((o) => o.name === "question_mentions:采购")?.pass).toBe(true);
    // 换个域的词 —— 写死的问题模板在这里露馅
    const out2 = evaluateAttempt({ must_include_in_questions: ["门诊"] }, GOOD);
    const o = out2.find((x) => x.name === "question_mentions:门诊");
    expect(o?.pass).toBe(false);
    expect(o?.detail).toContain("样例");
  });
});
