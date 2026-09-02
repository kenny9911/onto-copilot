/**
 * 人类环节的两个洞。
 *
 * 对抗式论证（docs/Fixed-Workflow-Adversarial-Verdict-2026-08-17.md）核实出来的：
 *
 *   1. **唯一的人类环节是唯一没有门的节点。** `buildFdeEngagementDag` 里
 *      REVIEW 带 4 条 require、EXPORT 带 3 条，而 INTERVIEW 一条都没有。
 *   2. **材料越干净，越没有人看过这次交付。** `InterviewHandler.skipModel` 在
 *      `blockers().length === 0` 时返回非 null，于是 `AgentLoop.produce()` 里
 *      的 `askHuman` 不可达。而 BLOCKING 的唯一来源是"材料里检出了冲突"——
 *      一份内部自洽、写得干净的制度文档（这比写出互相矛盾的文档容易得多）
 *      就能让零个人类看过这次交付，而 DAG 上显示 INTERVIEW 已完成。
 *      更糟的是 REVIEW 门要的 `blocker_count == 0` 用的是**同一个**计数，
 *      两道门一起空过。
 *
 * 这里**不**去禁掉 skipModel：真的没有问题要问时，硬让每次运行都卡住等人是错的。
 * 修的是"没人看过"这件事**没有留下痕迹**——它必须像预算降级那样进产物。
 */

import { describe, expect, it } from "vitest";

import { buildFdeEngagementDag } from "../src/onto/engagement.js";
import { CanonicalizeHandler, EngagementRuntimeInput } from "../src/onto/engagement_runtime.js";
import { OIR } from "../src/onto/oir.js";
import type { RunContext } from "../src/kernel/loop.js";

function runtimeWith(decisions: unknown[]): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "s1",
    project: "测试项目",
    oir: new OIR(),
    flow: null,
    decisions,
    corpus: {},
    artifactRevision: 0,
    generatedAt: "2026-08-17T00:00:00+08:00",
    releaseDownloadable: true,
  });
}

async function packageOf(decisions: unknown[]): Promise<Record<string, unknown>> {
  const h = new CanonicalizeHandler(runtimeWith(decisions));
  const out = await h.execute({}, {} as RunContext);
  return (out as Record<string, Record<string, unknown>>)["package"] ?? (out as Record<string, unknown>);
}

describe("INTERVIEW 必须有门", () => {
  it("唯一的人类环节不能是唯一没有门的节点", () => {
    const dag = buildFdeEngagementDag();
    const interview = dag.get("INTERVIEW");
    expect(interview.gate).not.toBeNull();
    expect(interview.gate).not.toBeUndefined();
  });

  it("门要的是这个节点自己的产出契约，不是别处的计数", () => {
    // REVIEW 门要的 `blocker_count == 0` 与 InterviewHandler.skipModel 判的
    // 是**同一个** blockers() —— 拿它当 INTERVIEW 的门等于让同一个判据
    // 自己给自己发通行证。
    const g = buildFdeEngagementDag().get("INTERVIEW").gate!;
    const req = [...(g as { require: readonly string[] }).require].join(" ");
    expect(req).toContain("contract");
    expect(req).toContain("resolved");
    expect(req).not.toContain("blocker_count");
  });

  it("REVIEW 保留既有质量门，EXPORT 在其上增加正式人工决定门", () => {
    const dag = buildFdeEngagementDag();
    expect([...(dag.get("REVIEW").gate as { require: readonly string[] }).require]).toEqual([
      "verdict == 'PASS'",
      "blocker_count == 0",
      "all_passed == true",
      "high_findings == 0",
    ]);
    expect([...(dag.get("EXPORT").gate as { require: readonly string[] }).require]).toEqual([
      "review_passed == true",
      "human_decided == true",
      "schema_valid == true",
      "downloadable == true",
    ]);
  });
});

describe("「没有人看过」必须进产物", () => {
  it("零条人工拍板 → 产物标出 human_review 没跑", async () => {
    const pkg = await packageOf([]);
    const v = pkg["validation"] as Record<string, unknown>;
    expect(v["semantically_reviewed"]).toBe(false);
    const skipped = v["skipped_reviews"] as { what: string; why: string }[];
    expect(skipped.map((s) => s.what)).toContain("human_review");
    // 措辞要说清"没有拍板记录"，不是"人没看"——我们只能证明前者
    expect(skipped.find((s) => s.what === "human_review")!.why).toContain("拍板");
  });

  it("有人工拍板 → 不标 —— 未降级且有人看过的产物逐字节不变", async () => {
    const pkg = await packageOf([{ id: "d1", kind: "naming", answer: "以制度为准" }]);
    const v = pkg["validation"] as Record<string, unknown>;
    expect(v["skipped_reviews"]).toBeUndefined();
    expect(v["semantically_reviewed"]).toBeUndefined();
    expect(Object.keys(v).sort()).toEqual(["findings", "status", "validators"]);
  });

  it("标记是**推导**的，不是累加的 —— 重放时 INTERVIEW 不重跑，累加的标记会消失", async () => {
    // 同一个 runtime 连造两次包，结果必须一致（推导无状态；累加会翻倍或漏掉）
    const rt = runtimeWith([]);
    const a = (await new CanonicalizeHandler(rt).execute({}, {} as RunContext)) as Record<string, Record<string, unknown>>;
    const b = (await new CanonicalizeHandler(rt).execute({}, {} as RunContext)) as Record<string, Record<string, unknown>>;
    const va = (a["package"] ?? a)["validation"] as Record<string, unknown[]>;
    const vb = (b["package"] ?? b)["validation"] as Record<string, unknown[]>;
    expect(va["skipped_reviews"]).toEqual(vb["skipped_reviews"]);
    expect(va["skipped_reviews"]).toHaveLength(1);
  });

  it("不改 status —— 没人看过不等于校验失败，混淆会让 fail-closed 的门误报", async () => {
    const pkg = await packageOf([]);
    expect((pkg["validation"] as Record<string, unknown>)["status"]).toBe("passed");
  });
});
