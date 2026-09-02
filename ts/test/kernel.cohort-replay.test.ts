/**
 * P1 的核心安全性质：**cohort 的恢复重放 = 0 次模型调用、0 花费、0 次工具重执行**。
 *
 * 这条与 kernel.cohort.test.ts 的区别：那边是键契约（桩网关），这边是真链路 ——
 * 真 ModelGateway（effect 走真 Recorder + InMemoryJournal）+ 真 Budget + 模拟
 * tools.ts:767 契约的工具 effect（键取自 CohortRunContext.toolEffectKey）。
 * 中断恢复恰恰是**节点没跑完**的场景，调度器的 nodeIsComplete 帮不上忙，
 * 只有 effect 键逐个命中历史才能不重付 —— 并发子任务的到达顺序每次都不同，
 * 键必须与顺序无关，这正是「任务文本哈希」存在的理由。
 *
 * 后端按**提示词内容**应答而不是按序：并发交错会打乱到达顺序，按序脚本
 * 钉住的是某一种交错，不是契约。
 */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { NodeMode, makeNodeBudget, makeNodeSpec } from "../src/kernel/dag.js";
import { EventKind } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { ModelGateway, Usage, stubRouting } from "../src/kernel/llm.js";
import type { GenerateArgs, LLMBackend } from "../src/kernel/llm.js";
import { AgentLoop, NodeHandler } from "../src/kernel/loop.js";
import type { RunContext } from "../src/kernel/loop.js";
import { Scratchpad } from "../src/kernel/memory/short_term.js";
import { Recorder } from "../src/kernel/recorder.js";

/** 按提示词内容应答；每次真实网络调用都计数。 */
class ContentBackend implements LLMBackend {
  calls = 0;
  generate(args: GenerateArgs): Promise<[string, Usage]> {
    this.calls += 1;
    const p = args.prompt;
    const usage = new Usage({ tok_in: 10, tok_out: 5 });
    const reply = (data: unknown): Promise<[string, Usage]> =>
      Promise.resolve([JSON.stringify(data), usage]);
    // 顺序即优先级：综合收尾的提示词里也含子任务文本，专用标记先判。
    if (p.includes("拆成至多")) {
      return reply({ subtasks: [{ task: "查A" }, { task: "查B" }] });
    }
    if (p.includes("并行子任务结论")) {
      return reply({ answer: "综合" });
    }
    if (p.includes("给出子任务结论")) {
      return p.includes("查A")
        ? reply({ finding: "A 有证据", cites: ["OBS-证据A"] })
        : reply({ finding: "B 查无", cites: [] });
    }
    if (p.includes("查A") && !p.includes("已做步骤")) {
      return reply({ thought: "去查A", action: { kind: "tool", tool: "search", args_json: '{"q":"A"}' } });
    }
    if (p.includes("查A")) {
      return reply({ thought: "够了", action: { kind: "finish", tool: "", args_json: "{}" } });
    }
    if (p.includes("查B")) {
      return reply({ thought: "不用查", action: { kind: "finish", tool: "", args_json: "{}" } });
    }
    return Promise.reject(new Error(`没有为这句备答：${p.slice(0, 60)}`));
  }
}

/** 模拟 tools.ts:767：真实工具执行包进 rec.effect，键读自 ctx.toolEffectKey。 */
class EffectToolHandler extends NodeHandler {
  toolRuns = 0;
  constructor(private readonly rec: Recorder) {
    super();
    this.schema = { type: "object", properties: { answer: { type: "string" } } };
    this.system = "SYS";
  }
  override forNode(): NodeHandler { return this; }
  override task(): string { return "任务"; }
  override query(): string { return "任务"; }
  override skipModel(): unknown { return null; }
  override finalize(draft: unknown): unknown { return draft; }
  override humanRequest(): Record<string, unknown> { return {}; }
  override execute(): Promise<unknown> { return Promise.resolve(null); }
  override async dispatch(action: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const key = (ctx as unknown as { toolEffectKey?: string }).toolEffectKey ?? null;
    return await this.rec.effect(ctx.nodeId, "tool.call", { tool: String(action["tool"]) },
      () => { this.toolRuns += 1; return "OBS-证据A（第 3 行）"; },
      { key });
  }
}

class CM {
  assemble(o: { task: string }): { text: string; stats(): Record<string, unknown> } {
    const text = `CTX<${o.task}>`;
    return { text, stats: () => ({ total_tokens: [...text].length, layers: {}, chunks: 0 }) };
  }
  reflect(): void {}
}
const quietBus = { renderFacts: () => "", broadcast: () => undefined };
const quietPanel = { validate: () => undefined, judge: () => Promise.resolve([]) };

function nodeSpec() {
  return makeNodeSpec({
    id: "PROCESS", mode: NodeMode.PLAN_EXECUTE, handler: "h",
    params: { cohort_max: 2 }, budget: makeNodeBudget({ toolCalls: 8 }), criticRounds: 0,
  });
}

async function runOnce(journal: InMemoryJournal, blobs: InMemoryBlobStore, backend: ContentBackend, resume: boolean) {
  const rec = new Recorder("run-cohort-replay", journal, blobs, { resume });
  const budget = new Budget();
  const gw = new ModelGateway(backend, rec, { routing: stubRouting(), budget });
  const handler = new EffectToolHandler(rec);
  const loop = new AgentLoop({
    gateway: gw as never,
    ctxManager: new CM() as never,
    panel: quietPanel as never,
    bus: quietBus as never,
    recorder: rec as never,
    budget,
    handlers: { h: handler },
    newScratchpad: (t: number) => new Scratchpad({ budgetTokens: t }),
  });
  const res = await loop.run(nodeSpec(), {
    working: { select: () => ({}) } as never,
    deps: [],
    runId: "run-cohort-replay",
  });
  return { res, budget, handler };
}

describe("Cohort 重放（真 Recorder + 真 ModelGateway）", () => {
  it("恢复重放：0 次模型调用、0 次工具重执行、预算水位恢复一致、产出逐字节相同", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const backend = new ContentBackend();

    const first = await runOnce(journal, blobs, backend, false);
    expect(first.res.output).toEqual({ answer: "综合" });
    expect(first.handler.toolRuns).toBe(1);
    const callsAfterFirst = backend.calls;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(6);
    const spentEvents = () =>
      [...journal.read("run-cohort-replay")].filter((e) => e.kind === EventKind.BUDGET_SPENT).length;
    const spentAfterFirst = spentEvents();
    const tokensAfterFirst = first.budget.spent("tokens");
    expect(tokensAfterFirst).toBeGreaterThan(0);

    // ── 恢复：同一本 journal，新 Recorder/Budget/Handler ──
    const second = await runOnce(journal, blobs, backend, true);
    expect(backend.calls, "重放一个网络包都不许出").toBe(callsAfterFirst);
    expect(second.handler.toolRuns, "工具也不许重执行").toBe(0);
    expect(second.res.output).toEqual(first.res.output);
    expect(second.budget.spent("tokens"), "预算水位要恢复到同一位置").toBe(tokensAfterFirst);
    expect(spentEvents(), "不许再发第二份 BUDGET_SPENT").toBe(spentAfterFirst);
  });
});
