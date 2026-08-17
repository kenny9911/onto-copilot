/**
 * 降级标记：`ValidationReport` 要说出**哪些评审没跑**。
 */

import { describe, expect, it } from "vitest";

import { ValidationReport } from "../src/onto/canonical.js";

// ── 降级标记（budget.ts:24 的枚举注释承诺过、但全仓一直不存在的那个标记）──
//
// `DegradeLevel.RULES_ONLY` 的注释写着"产物标「未经语义审核」"，
// `budget.ts:263` 又写着"产物上的「未经语义审核」标记也不该悄悄消失" ——
// 而在此之前 grep 全仓，**这个标记根本不存在**。注释在描述一个没实现的功能，
// latch 的存在会让读代码的人以为它实现了。
//
// 位置选在 `validation` 而不是新开顶层字段，有两个理由：
//   1. 语义：`validators` 本来就在宣称"这些检查跑过了"。一份只列 findings、
//      却不说"语义评审整段没跑"的验证报告，恰恰就是缺陷本身。
//   2. 兼容：包的 JSON schema 是 `additionalProperties: false`，加顶层字段要
//      改 schema；而 `validation` 的子 schema 是 `{"type":"object"}`，完全开放。
//
// **没有跳过任何评审时一个键都不输出** —— 未降级的运行产出逐字节不变，
// golden/canonical.json 的 from_dict_roundtrip 一动不动。
describe("降级标记进产物", () => {
  it("没跳过评审时不输出任何多余的键 —— 未降级的产物逐字节不变", () => {
    const r = new ValidationReport();
    expect(Object.keys(r.toDict()).sort()).toEqual(["findings", "status", "validators"]);
  });

  it("跳过了评审就必须说出来：什么没跑、为什么", () => {
    const r = new ValidationReport({
      skippedReviews: [
        { what: "llm_critic", why: "预算降级", level: 3, label: "仅规则评审（产物标记未经语义审核）" },
      ],
    });
    const d = r.toDict() as Record<string, unknown>;
    expect(d["semantically_reviewed"]).toBe(false);
    expect(d["skipped_reviews"]).toEqual([
      { what: "llm_critic", why: "预算降级", level: 3, label: "仅规则评审（产物标记未经语义审核）" },
    ]);
  });

  it("跳过评审**不**让 status 变 failed —— 门的判定逻辑不动，那一处本来就是对的", () => {
    // 混淆"有 error"和"没审过"会让 fail-closed 的门开始误报，
    // 而 ExportHandler 那条 fail-closed 判定是这个代码库里少数做对的地方。
    const r = new ValidationReport({
      skippedReviews: [{ what: "llm_critic", why: "预算降级", level: 3, label: "x" }],
    });
    expect(r.passed).toBe(true);
    expect((r.toDict() as Record<string, unknown>)["status"]).toBe("passed");
  });

  it("skippedReviews 每次新数组 —— 与 findings/validators 同样的共享引用防串味", () => {
    const shared = [{ what: "a", why: "b", level: 3, label: "c" }];
    const r = new ValidationReport({ skippedReviews: shared });
    shared.push({ what: "后加的", why: "", level: 4, label: "" });
    expect((r.toDict() as Record<string, unknown[]>)["skipped_reviews"]).toHaveLength(1);
  });
});
