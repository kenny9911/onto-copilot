/**
 * B7：对齐合并对象后，**全部引用方**都要改挂。
 *
 * 上一版只改挂了 properties.parent / links / actions.appliesTo ——
 * rules.appliesTo 和 questions.appliesTo 里还指着被删掉的 rid（悬空引用）。
 * 后果：「改这个对象会影响哪些规则」查不到、右栏把规则算成未绑对象、
 * 审阅问题定位不到实体。同一次合并少改挂一类引用，就多一类幽灵。
 */
import { describe, expect, it } from "vitest";

import { EntityAligner, makeAlignResult } from "../src/onto/align.js";
import {
  OIR, inferred, makeBusinessRule, makeEventType, makeObjectType, makeOpenQuestion,
} from "../src/onto/oir.js";

describe("合并后的引用改挂", () => {
  it("rules / questions / events 全部指向代表对象，不留旧 rid", () => {
    const oir = new OIR();
    oir.addObject(makeObjectType({
      rid: "ot_a", apiName: inferred("PbpHeader"), displayName: inferred("采购业务计划头"),
    }));
    oir.addObject(makeObjectType({
      rid: "ot_b", apiName: inferred("pbpHeader"), displayName: inferred("采购需求计划"),
    }));
    oir.addRule(makeBusinessRule({
      rid: "br_1", statement: inferred("金额超 5 万要审批"), appliesTo: ["ot_b"],
    }));
    oir.addQuestion(makeOpenQuestion({
      rid: "oq_1", text: inferred("口径含税吗？"), appliesTo: ["ot_b"],
    }));
    oir.addEvent(makeEventType({
      rid: "et_1", apiName: inferred("PlanApproved"), displayName: inferred("计划已批准"),
      payload: ["ot_b"],
    }));

    // 直接喂 apply 一个手工簇 —— B7 修的是 apply 的改挂完整性，
    // 聚类判分是另一个函数的责任，这条测试不该和它的阈值耦合。
    const aligner = new EntityAligner();
    const result = makeAlignResult();
    result.clusters = [["ot_a", "ot_b"]];
    const merged = aligner.apply(oir, result);
    expect(merged.length).toBeGreaterThan(0);
    const rep = String(merged[0]!["into"]);
    const gone = String(merged[0]!["merged"]);

    expect(oir.rules.get("br_1")!.appliesTo).toEqual([rep]);
    expect(oir.questions.get("oq_1")!.appliesTo).toEqual([rep]);
    expect(oir.events.get("et_1")!.payload).toEqual([rep]);
    // 全 OIR 不再有任何地方引用被并掉的 rid
    const blob = JSON.stringify(oir.toDict());
    expect(blob).not.toContain(gone);
  });
});
