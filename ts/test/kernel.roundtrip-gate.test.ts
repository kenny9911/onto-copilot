/**
 * ROUND_TRIP 从假选项变真挂起（O2）。
 *
 * 它在枚举（critic.ts:502）和 HITL 选项映射里一直存在，但没有任何处理分支 ——
 * 人在 gate 上选「打回业务方补料」，Run 直接 FAILED、engagement 检查点作废，
 * 已花的抽取钱买了一条错误消息。而挂起→回传→resume 的全套基础设施都是现成的。
 */
import { describe, expect, it } from "vitest";

import { HumanInputRequired } from "../src/kernel/errors.js";
import { Decision } from "../src/kernel/critic.js";

describe("round_trip gate", () => {
  it("**HITL_CHOICES 认它、actions 也要展示它** —— 存在但不被展示的选项等于不存在", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/kernel/scheduler.ts", "utf8"));
    // 两处 askHuman 的 actions 都带 round_trip
    const matches = src.match(/actions: \["pass", "revise", "abort", "round_trip"\]/gu) ?? [];
    expect(matches).toHaveLength(2);
    // 处理分支存在：ROUND_TRIP → HumanInputRequired（挂起），不是 NodeFailure（失败）
    expect(src).toContain("result.decision === Decision.ROUND_TRIP");
    expect(src).toContain("`${nid}:roundtrip`");
  });

  it("枚举本身还在（golden 钉着，别顺手动它）", () => {
    expect(Decision.ROUND_TRIP).toBe("round_trip");
  });

  it("HumanInputRequired 携带指路 payload 的形状", () => {
    const exc = new HumanInputRequired("N", "N:roundtrip", {
      kind: "round_trip", gate: "hitl", reason: "缺料",
      指路: "导出补料清单发业务方（export.file source=readiness / interview_kit），回传后继续这条 Run。",
    });
    expect(exc.nodeId).toBe("N");
    expect(exc.requestId).toBe("N:roundtrip");
    expect(String(exc.payload["指路"])).toContain("补料清单");
  });
});
