/**
 * E2（真实数据事故，2026-08-20）：跨 attempt 的 keyed effect 撞键。
 *
 * 现场：EXTRACT.s20_1 第 0 次尝试的 #plan LLM 调用撞上网关 503 → 节点按可重试
 * 失败重进 → 第 1 次尝试再要 #plan，prompt 已随上下文演进（并发下别的节点跑完、
 * 黑板事实变了）→ 指纹不同 → DeterminismViolation → **一个节点的正常重试把
 * 整轮 $4.35 的抽取判死**。
 *
 * 语义：恢复路径早就写明「同 key 重复写入意味着重试，应复用首次结果」——
 * 实时路径必须与它一致：跨 attempt 是陈账（重做），同 attempt 才是违例（炸）。
 */
import { describe, expect, it } from "vitest";

import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { Recorder } from "../src/kernel/recorder.js";
import { DeterminismViolation } from "../src/kernel/errors.js";
import { EventKind } from "../src/kernel/events.js";

function rec(): Recorder {
  return new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
}

describe("keyed effect 跨 attempt", () => {
  it("**重试后 prompt 变了 → 重做，不炸**；发 effect.superseded 让它可见", async () => {
    const r = rec();
    r.nextAttempt("N");                       // attempt 0（水位 → 1）
    const a = await r.effect("N", "llm.call", { prompt: "v1" }, async () => "计划A", { key: "plan" });
    expect(a).toBe("计划A");

    r.nextAttempt("N");                       // 节点重试（水位 → 2）
    const b = await r.effect("N", "llm.call", { prompt: "v2-上下文演进了" }, async () => "计划B", { key: "plan" });
    expect(b).toBe("计划B");                  // 重新执行，不回放陈账

    const kinds = [...r.journal.read("r1")].map((e) => e.kind);
    expect(kinds).toContain(EventKind.EFFECT_SUPERSEDED);
  });

  it("重试后 prompt 没变 → 照旧免费回放（省钱语义原样）", async () => {
    const r = rec();
    r.nextAttempt("N");
    await r.effect("N", "llm.call", { prompt: "同一份" }, async () => "结果", { key: "plan" });
    r.nextAttempt("N");
    let executed = false;
    const out = await r.effect("N", "llm.call", { prompt: "同一份" }, async () => {
      executed = true; return "不该跑到这";
    }, { key: "plan" });
    expect(out).toBe("结果");
    expect(executed).toBe(false);
  });

  it("**同一 attempt 内同 key 不同指纹照样炸** —— 那是真的不确定性", async () => {
    const r = rec();
    r.nextAttempt("N");
    await r.effect("N", "llm.call", { prompt: "v1" }, async () => "A", { key: "plan" });
    await expect(
      r.effect("N", "llm.call", { prompt: "v2" }, async () => "B", { key: "plan" }),
    ).rejects.toThrow(DeterminismViolation);
  });

  it("**chat 侧（从不调 nextAttempt）严格性原样** —— 水位恒 0，撞键必炸", async () => {
    const r = rec();
    await r.effect("CHAT", "llm.call", { prompt: "v1" }, async () => "A", { key: "step0" });
    await expect(
      r.effect("CHAT", "llm.call", { prompt: "v2" }, async () => "B", { key: "step0" }),
    ).rejects.toThrow(DeterminismViolation);
  });

  it("非 keyed（计数器）effect 不受影响 —— 它们本来就按序号各占一格", async () => {
    const r = rec();
    r.nextAttempt("N");
    await r.effect("N", "llm.call", { prompt: "v1" }, async () => "A");
    r.nextAttempt("N");
    const out = await r.effect("N", "llm.call", { prompt: "v2" }, async () => "B");
    expect(out).toBe("B");
  });

  it("崩溃恢复：resume 后重进节点，同指纹回放、变指纹重做（不再是死路）", async () => {
    const j = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const r1 = new Recorder("r1", j, blobs);
    r1.nextAttempt("N");
    await r1.effect("N", "llm.call", { prompt: "v1" }, async () => "老结果", { key: "plan" });
    // 模拟进程崩溃后 resume
    const r2 = new Recorder("r1", j, blobs, { resume: true });
    r2.nextAttempt("N");   // 重进（loadHistory 已把 attempt 水位重建到 ≥1）
    // 变指纹：重做而不是 DeterminismViolation
    const out = await r2.effect("N", "llm.call", { prompt: "v2" }, async () => "新结果", { key: "plan" });
    expect(out).toBe("新结果");
  });
});
