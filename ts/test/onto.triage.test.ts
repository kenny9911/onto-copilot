/**
 * 问题分诊（第 1 层工作坊套件）：4044 条问题里 97% 是逐行 lint
 * （实测会话 fc58b72e91bd：未声明主键 ×1365、孤立对象 ×1357、命名不合规 ×849），
 * 真正人工筛过的只有 138 条。分诊三层：
 *
 *  · 聚类 —— 同型逐行 conflict 按 kind 折叠成**一条模式级问题**（「1365 个对象未
 *    声明主键：主键口径统一按什么定？」），聚类键从 sourceRef 前缀解析
 *    （cf_missing_required_f50d8a9261 → missing_required），不靠文本正则；
 *  · 信号 —— informationGain / blastRadius 的**确定性生产者**（此前全仓无生产者，
 *    排序键第二位恒 0，next() 实际按生成早晚出题）；只填空，不覆盖已有值；
 *  · 降档 —— 逐行 lint 类 conflict 不再无差别 BLOCKING（延续「机器可执行的命名
 *    修复压 LOW」的既有先例）；口径分歧这类真决策保持 BLOCKING。
 *
 * 解析不出 kind 的 conflict 一律保守处理：不聚类、保持 BLOCKING、gain 取中档。
 */
import { describe, expect, it } from "vitest";

import {
  buildQuestionBacklog,
  Question,
  QuestionPriority,
} from "../src/onto/questions.js";
import {
  conflictKindOf,
  fillTriageSignals,
  triageBacklog,
} from "../src/onto/triage.js";

function q(over: Partial<ConstructorParameters<typeof Question>[0]> & { id: string }): Question {
  return new Question({ text: over.id, createdAt: 1.0, updatedAt: 1.0, ...over });
}

describe("conflictKindOf —— 聚类键从 sourceRef 前缀解析", () => {
  it("真实数据里的三大类都认得", () => {
    expect(conflictKindOf("cf_missing_required_f50d8a9261")).toBe("missing_required");
    expect(conflictKindOf("cf_naming_violation_bbb1c32ade")).toBe("naming_violation");
    expect(conflictKindOf("cf_orphan_1a2b3c")).toBe("orphan");
  });

  it("解析不出的一律 null（保守）：老式 cf_1、非 conflict 引用、空串", () => {
    expect(conflictKindOf("cf_1")).toBeNull();
    expect(conflictKindOf("oq_1")).toBeNull();
    expect(conflictKindOf("")).toBeNull();
  });
});

describe("fillTriageSignals —— 排序信号的确定性生产者", () => {
  it("open_question 0.6；已有值不覆盖", () => {
    const a = q({ id: "a", sourceKind: "open_question" });
    fillTriageSignals(a);
    expect(a.informationGain).toBe(0.6);
    const b = q({ id: "b", sourceKind: "open_question", informationGain: 0.9 });
    fillTriageSignals(b);
    expect(b.informationGain).toBe(0.9);
  });

  it("lint 类 conflict 低档，真决策类高档，机器可执行的最低", () => {
    const lint = q({ id: "l", sourceKind: "conflict", sourceRef: "cf_orphan_abc123" });
    fillTriageSignals(lint);
    expect(lint.informationGain).toBe(0.25);
    expect(lint.group).toBe("孤立对象");
    expect(lint.code).toBe("CF_ORPHAN");

    const real = q({ id: "r", sourceKind: "conflict", sourceRef: "cf_semantic_divergence_a1b2c3" });
    fillTriageSignals(real);
    expect(real.informationGain).toBe(0.7);

    const auto = q({
      id: "m", sourceKind: "conflict", sourceRef: "cf_naming_violation_ff00aa",
      options: [{ id: "apply", label: "改为 x", effect: { set_api_name: "x" } }],
    });
    fillTriageSignals(auto);
    expect(auto.informationGain).toBe(0.15);
  });

  it("blastRadius 从 scopeRefs / blockedArtifacts 数出来；已有值不覆盖", () => {
    const a = q({ id: "a", sourceKind: "open_question", scopeRefs: ["x", "y", "z"] });
    fillTriageSignals(a);
    expect(a.blastRadius).toBe(3);
    const b = q({ id: "b", sourceKind: "conflict", sourceRef: "cf_duplicate_aa11", blockedArtifacts: ["模板_v1.xlsx"] });
    fillTriageSignals(b);
    expect(b.blastRadius).toBe(1);
  });

  it("已有 group/code 不覆盖（agent 问题带着自己的分组进来）", () => {
    const a = q({ id: "a", sourceKind: "conflict", sourceRef: "cf_orphan_abc123", group: "数据对象", code: "AGENT_X" });
    fillTriageSignals(a);
    expect(a.group).toBe("数据对象");
    expect(a.code).toBe("AGENT_X");
  });
});

describe("triageBacklog —— 折叠与分层", () => {
  function herd(): Question[] {
    const out: Question[] = [];
    for (let i = 0; i < 10; i += 1) {
      out.push(q({ id: `o${i}`, text: `obj${i} 与任何对象都没有关系`, sourceKind: "conflict", sourceRef: `cf_orphan_${i}a2b3c` }));
    }
    for (let i = 0; i < 4; i += 1) {
      out.push(q({ id: `p${i}`, text: `obj${i}: 未声明主键`, sourceKind: "conflict", sourceRef: `cf_missing_required_${i}f50d8` }));
    }
    out.push(q({ id: "s1", text: "计划金额含税吗？", sourceKind: "conflict", sourceRef: "cf_semantic_divergence_a1", priority: QuestionPriority.BLOCKING }));
    out.push(q({ id: "s2", text: "SOR 是哪个系统？", sourceKind: "conflict", sourceRef: "cf_semantic_divergence_b2", priority: QuestionPriority.BLOCKING }));
    out.push(q({ id: "oq", text: "结算周期是什么？", sourceKind: "open_question" }));
    return out;
  }

  it("同 kind ≥ 阈值折叠成模式组，组按规模降序；其余进 ask", () => {
    const t = triageBacklog(herd(), { minCluster: 3 });
    expect(t.clusters.map((c) => [c.kind, c.count])).toEqual([
      ["orphan", 10],
      ["missing_required", 4],
    ]);
    expect(t.clusters[0]!.title).toContain("10 个对象");
    expect(t.clusters[1]!.title).toContain("主键");
    // 2 条口径分歧（不足阈值不折叠）+ 1 条 open_question
    expect(t.ask.map((x) => x.id).sort()).toEqual(["oq", "s1", "s2"]);
  });

  it("ask 按（优先级，gain×blast）排序 —— blocking 的口径分歧排在 open_question 前面", () => {
    const qs = herd();
    for (const x of qs) fillTriageSignals(x);
    const t = triageBacklog(qs, { minCluster: 3 });
    expect(t.ask[0]!.priority).toBe(QuestionPriority.BLOCKING);
    expect(t.ask[2]!.id).toBe("oq");
  });

  it("模式组统计可自动应用的条数，代表取插入序第一条", () => {
    const qs = herd();
    qs[0] = q({
      id: "o0", text: "obj0 与任何对象都没有关系", sourceKind: "conflict", sourceRef: "cf_orphan_0a2b3c",
      options: [{ id: "apply", label: "并入 x", effect: { set_parent: "x" } }],
    });
    const t = triageBacklog(qs, { minCluster: 3 });
    expect(t.clusters[0]!.autoApplicable).toBe(1);
    expect(t.clusters[0]!.representative.id).toBe("o0");
    expect(t.clusters[0]!.instanceIds).toHaveLength(10);
  });
});

describe("buildQuestionBacklog 的分诊接线", () => {
  it("raw conflict：lint kind 降 NORMAL 并填组别；真决策与解析不出的保持 BLOCKING", () => {
    const bag = buildQuestionBacklog({
      conflicts: [
        { handling: "ask_user", rid: "cf_orphan_abc123", summary: "obj 与任何对象都没有关系" },
        { handling: "ask_user", rid: "cf_semantic_divergence_a1b2", summary: "口径分歧" },
        { handling: "ask_user", rid: "cf_9", summary: "解析不出 kind 的老式引用" },
      ],
    });
    const by = new Map([...bag.questions.values()].map((x) => [x.sourceRef, x]));
    expect(by.get("cf_orphan_abc123")!.priority).toBe(QuestionPriority.NORMAL);
    expect(by.get("cf_orphan_abc123")!.group).toBe("孤立对象");
    expect(by.get("cf_orphan_abc123")!.informationGain).toBe(0.25);
    expect(by.get("cf_semantic_divergence_a1b2")!.priority).toBe(QuestionPriority.BLOCKING);
    expect(by.get("cf_semantic_divergence_a1b2")!.informationGain).toBe(0.7);
    expect(by.get("cf_9")!.priority).toBe(QuestionPriority.BLOCKING);
    expect(by.get("cf_9")!.informationGain).toBe(0.5);
    expect(by.get("cf_9")!.group).toBe("");
  });
});
