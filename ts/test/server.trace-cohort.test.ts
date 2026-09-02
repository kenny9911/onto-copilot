/**
 * P4 可观测性：内核事件投影要把三样带给前端 ——
 *   1. cohort 标注（哪条思考/工具行属于哪个并行子任务）；
 *   2. cohort 计划（「启动 N 个并行分析任务」的原始信号）；
 *   3. 节点耗时（completed.ts − entered.ts，投影层现算，**不发心跳事件** ——
 *      8-25 重放风暴的教训：持久事件流里绝不进按秒增长的东西）。
 */
import { describe, expect, it } from "vitest";

import { EventKind, makeEvent } from "../src/kernel/events.js";
import type { Event } from "../src/kernel/events.js";
import { pumpKernelEvents } from "../src/server/pipeline/trace.js";

function ev(kind: EventKind, seq: number, nodeId: string, payload: Record<string, unknown>, tsMs: number): Event {
  return makeEvent({ runId: "r1", seq, kind, nodeId, payload, ref: null, tsMs });
}

function fakeSession() {
  const events: Record<string, unknown>[] = [];
  return {
    state: {} as Record<string, unknown>,
    events,
    emit(kind: string, payload: Record<string, unknown> = {}) {
      const e = { ...payload, kind };
      events.push(e);
      return e;
    },
  };
}

function recOf(events: Event[]) {
  return { runId: "r1", journal: { read: () => events[Symbol.iterator]() } };
}

describe("内核事件投影（P4）", () => {
  it("cohort 字段随投影带出：计划带 cohort/cohort_tasks，思考/工具带 cohort_task", () => {
    const s = fakeSession();
    pumpKernelEvents(s as never, recOf([
      ev(EventKind.PLAN_CREATED, 0, "PROCESS",
        { steps: [{ goal: "查A" }, { goal: "查B" }], cohort: true, cohort_max: 2, cohort_tasks: 2 }, 1000),
      ev(EventKind.THOUGHT, 1, "PROCESS", { text: "想A", cohort_task: 0 }, 1100),
      ev(EventKind.OBSERVATION, 2, "PROCESS", { tool: "search", summary: "找到了", cohort_task: 1 }, 1200),
      ev(EventKind.THOUGHT, 3, "PROCESS", { text: "普通思考" }, 1300),
    ]) as never);
    const plan = s.events.find((e) => e["kind"] === "kernel.plan")!;
    expect(plan["cohort"]).toBe(true);
    expect(plan["cohort_tasks"]).toBe(2);
    // P4 四键：run_id + ts_ms 每行都带（handler 不在内核事件上，不硬造）
    expect(plan["run_id"]).toBe("r1");
    expect(plan["ts_ms"]).toBe(1000);
    const thoughts = s.events.filter((e) => e["kind"] === "kernel.thought");
    expect(thoughts[0]!["cohort_task"]).toBe(0);
    expect(thoughts[1]!["cohort_task"]).toBeUndefined();
    const obs = s.events.find((e) => e["kind"] === "kernel.observation")!;
    expect(obs["cohort_task"]).toBe(1);
  });

  it("节点耗时：completed 带 secs = completed.ts − entered.ts（跨两次泵也算得出）", () => {
    const s = fakeSession();
    const entered = ev(EventKind.NODE_ENTERED, 0, "PROCESS", {}, 10_000);
    pumpKernelEvents(s as never, recOf([entered]) as never);
    // 第二次泵才看到 completed —— entered 的时刻必须还记得
    pumpKernelEvents(s as never, recOf([
      entered,
      ev(EventKind.NODE_COMPLETED, 1, "PROCESS", {}, 22_500),
    ]) as never);
    const done = s.events.find((e) => e["kind"] === "kernel.node_completed")!;
    expect(done["secs"]).toBe(13);
  });

  it("没见过 entered 的 completed 不硬造耗时", () => {
    const s = fakeSession();
    pumpKernelEvents(s as never, recOf([
      ev(EventKind.NODE_COMPLETED, 0, "GHOST", {}, 5_000),
    ]) as never);
    const done = s.events.find((e) => e["kind"] === "kernel.node_completed")!;
    expect(done["secs"]).toBeUndefined();
  });
});
