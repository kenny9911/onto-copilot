/**
 * 规则的可判定条件（A11 的地基）。
 *
 * 起因：同一条业务事实现在被写两遍 —— 一遍进 `statement`（"金额超过 50,000 元
 * 需总经理审批"），一遍进流程网关的边标签（"金额 > 5万"）。**两处没有任何
 * 可机读的联系，数字写法还不一样，矛盾了也没人发现。**
 * 而右栏那枚「无可判定条件」的芯片以前故意不报 —— OIR 根本没有这个字段，
 * 报了也补不了。先有能力，再有提示。
 */
import { describe, expect, it } from "vitest";

import { OIR, RuleKind, makeBusinessRule, inferred, oirFromDict } from "../src/onto/oir.js";
import { applyOirEdit, OIR_EDITABLE_FIELDS } from "../src/onto/oir_edit.js";

const val = (a: any) => (a && typeof a === "object" && "value" in a ? a.value : a);

describe("BusinessRule.condition", () => {
  it("add_rule 收 condition，落成人工口述的断言", () => {
    const oir = new OIR();
    const note = applyOirEdit(oir, "add_rule", {
      statement: "采购申请预估金额超过 50,000 元，需经总经理二级审批。",
      kind: "AUTHORITY",
      condition: "estimatedAmount > 50000",
    });
    expect(note).toContain("estimatedAmount > 50000");
    const r = [...oir.rules.values()][0]!;
    expect(val(r.condition)).toBe("estimatedAmount > 50000");
  });

  it("**不给就是空的，不硬凑** —— 写不出判定条件是常态，编一个比留空糟得多", () => {
    const oir = new OIR();
    applyOirEdit(oir, "add_rule", { statement: "报销要合规。" });
    expect(val([...oir.rules.values()][0]!.condition)).toBe("");
  });

  it("已有的规则能补条件、也能改分类 —— 抽取建的规则不会再走 add_rule", () => {
    const oir = new OIR();
    oir.addRule(makeBusinessRule({ rid: "br_x", statement: inferred("金额超 5 万要总经理批") }));
    applyOirEdit(oir, "edit_assertion",
      { target: "br_x", field: "condition", value: "amount > 50000" });
    applyOirEdit(oir, "edit_assertion",
      { target: "br_x", field: "kind", value: "AUTHORITY" });
    expect(val(oir.rules.get("br_x")!.condition)).toBe("amount > 50000");
    expect(val(oir.rules.get("br_x")!.kind)).toBe(RuleKind.AUTHORITY);
  });

  it("两个字段都在可改表里 —— 右栏那两枚芯片指的就是它们", () => {
    expect([...OIR_EDITABLE_FIELDS]).toContain("condition");
    expect([...OIR_EDITABLE_FIELDS]).toContain("kind");
  });

  it("**可选发射**：没填条件时产物里一个键都不多（老数据必须原样）", () => {
    const oir = new OIR();
    oir.addRule(makeBusinessRule({ rid: "br_a", statement: inferred("s") }));
    const dict = oir.toDict() as any;
    expect("condition" in dict.rules[0]).toBe(false);

    oir.rules.get("br_a")!.condition = inferred("x > 1");
    expect("condition" in (oir.toDict() as any).rules[0]).toBe(true);
  });

  it("往返：老数据（没有 condition 键）读回来是空断言，不是 undefined", () => {
    const back = oirFromDict({
      objects: [], properties: [], links: [], actions: [], questions: [],
      rules: [{ rid: "br_old", kind: "BusinessRule",
        statement: { value: "老规则", origin: "extracted", confidence: 1, evidence: [] },
        ruleKind: { value: "PROCESS", origin: "extracted", confidence: 1, evidence: [] },
        appliesTo: [], actor: { value: "", origin: "inferred", confidence: 0.4, evidence: [] },
        status: "candidate" }],
    });
    const r = back.rules.get("br_old")!;
    expect(val(r.condition)).toBe("");
    expect(r.condition.origin).toBe("inferred");
  });
});
