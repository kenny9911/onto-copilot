/**
 * P1：受限 Cohort（PLAN_EXECUTE 第二形态）。
 *
 * 网关桩按 **key** 应答而不是按序 —— cohort 的调用到达顺序是并发竞态，
 * 按序桩会把测试写成"恰好按这个交错"，那不是契约。键即契约：
 *   cohort:plan → cohort:<任务文本哈希>:step:<j> / :final → final
 */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { NodeMode, makeNodeBudget, makeNodeSpec } from "../src/kernel/dag.js";
import type { NodeSpec } from "../src/kernel/dag.js";
import { BudgetExhausted, HumanInputRequired, NodeFailure } from "../src/kernel/errors.js";
import { EventKind } from "../src/kernel/events.js";
import { fingerprint } from "../src/kernel/ids.js";
import { QuotaExhausted } from "../src/kernel/llm.js";
import {
  AgentLoop,
  NodeHandler,
  PLAN_SCHEMA,
  cohortMaxOf,
  cohortPlanSchema,
} from "../src/kernel/loop.js";
import { Scratchpad } from "../src/kernel/memory/short_term.js";
import type { RunContext } from "../src/kernel/loop.js";

// ── 极简桩 ─────────────────────────────────────────────────────

interface Recorded {
  kind: EventKind;
  node_id: string | null;
  payload: Record<string, unknown>;
}

class Rec {
  readonly events: Recorded[] = [];
  private readonly attempts = new Map<string, number>();
  nextAttempt(nodeId: string): number {
    const n = this.attempts.get(nodeId) ?? 0;
    this.attempts.set(nodeId, n + 1);
    return n;
  }
  emit(kind: EventKind, opts?: { nodeId?: string | null; payload?: Record<string, unknown> }): unknown {
    this.events.push({ kind, node_id: opts?.nodeId ?? null, payload: opts?.payload ?? {} });
    return null;
  }
  askHuman(nodeId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown> {
    return Promise.reject(new HumanInputRequired(nodeId, requestId, payload));
  }
}

class CM {
  assemble(o: { task: string }): { text: string; stats(): Record<string, unknown> } {
    const text = `CTX<${o.task}>`;
    return { text, stats: () => ({ total_tokens: [...text].length, layers: {}, chunks: 0 }) };
  }
  reflect(): void {}
}

class Bus {
  renderFacts(): string {
    return "";
  }
  broadcast(): void {}
}

class Panel {
  validate(): void {}
  judge(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

interface GwCall {
  key: string | null;
  prompt: string;
  schema: Record<string, unknown> | null;
}

type KeyedResponse = { data?: unknown; text?: string } | { reject: Error };

/** 按 key 应答的网关桩。没有 key 的调用（经典路径）落到 byOrder。 */
class KeyedGateway {
  readonly calls: GwCall[] = [];
  readonly routing = { modelFor: () => ({ name: "stub", difficulty: "low" }) };
  private order = 0;
  constructor(
    private readonly byKey: Record<string, KeyedResponse>,
    private readonly byOrder: KeyedResponse[] = [],
  ) {}
  call(
    _nodeId: string,
    prompt: string,
    opts?: { key?: string | null; schema?: Record<string, unknown> | null },
  ): Promise<{ text: string; data: unknown }> {
    const key = opts?.key ?? null;
    this.calls.push({ key, prompt, schema: opts?.schema ?? null });
    const r = key !== null && key in this.byKey ? this.byKey[key]! : this.byOrder[this.order++];
    if (r === undefined) return Promise.reject(new Error(`没有为 key=${key} 备答`));
    if ("reject" in r) return Promise.reject(r.reject);
    return Promise.resolve({ text: r.text ?? "", data: r.data ?? null });
  }
  iterationsFor(): number {
    return 4;
  }
  criticRoundsFor(): number {
    return 0;
  }
  samplesFor(): number {
    return 1;
  }
}

interface Dispatched {
  tool: string;
  args: Record<string, unknown>;
  effect_key: string | null;
  tool_limit: number | null;
}

class CohortHandler extends NodeHandler {
  readonly dispatched: Dispatched[] = [];
  constructor(private readonly obsByQ: Record<string, unknown | Error>) {
    super();
    this.schema = { type: "object", properties: { answer: { type: "string" } } };
    this.system = "SYS";
  }
  override forNode(): NodeHandler {
    return this;
  }
  override task(): string {
    return "任务";
  }
  override query(): string {
    return "任务";
  }
  override skipModel(): unknown {
    return null;
  }
  override finalize(draft: unknown): unknown {
    return draft;
  }
  override humanRequest(): Record<string, unknown> {
    return {};
  }
  override execute(): Promise<unknown> {
    return Promise.resolve(null);
  }
  override dispatch(action: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
    const args = (action["args"] ?? {}) as Record<string, unknown>;
    // 模拟 tools.ts:767：每次真实调用恰好读一次 toolEffectKey
    const key = (ctx as unknown as { toolEffectKey?: string }).toolEffectKey ?? null;
    this.dispatched.push({
      tool: String(action["tool"] ?? ""),
      args,
      effect_key: key,
      tool_limit: ctx.nodeToolLimit,
    });
    const q = String(args["q"] ?? "");
    const obs = this.obsByQ[q];
    if (obs instanceof Error) return Promise.reject(obs);
    return Promise.resolve(obs ?? `没有为 q=${q} 备的观察`);
  }
}

const H_A = fingerprint("查A");
const H_B = fingerprint("查B");

function stepTool(thought: string, q: string): KeyedResponse {
  return { data: { thought, action: { kind: "tool", tool: "search", args_json: JSON.stringify({ q }) } } };
}
const STEP_FINISH: KeyedResponse = { data: { thought: "够了", action: { kind: "finish" } } };

function cohortNode(params: Record<string, unknown> = { cohort_max: 2 }): NodeSpec {
  return makeNodeSpec({
    id: "P",
    mode: NodeMode.PLAN_EXECUTE,
    handler: "h",
    params,
    budget: makeNodeBudget({ toolCalls: 4 }),
    criticRounds: 0,
  });
}

function rig(gw: KeyedGateway, handler: CohortHandler) {
  const rec = new Rec();
  const loop = new AgentLoop({
    gateway: gw as never,
    ctxManager: new CM() as never,
    panel: new Panel() as never,
    bus: new Bus() as never,
    recorder: rec as never,
    budget: new Budget(),
    handlers: { h: handler },
    newScratchpad: (t: number) => new Scratchpad({ budgetTokens: t }),
  });
  const run = () =>
    loop.run(cohortNode(), {
      working: { select: () => ({}) } as never,
      deps: [],
      runId: "r-cohort",
    });
  return { loop, rec, run };
}

const BASE_RESPONSES: Record<string, KeyedResponse> = {
  "cohort:plan": { data: { subtasks: [{ task: "查A" }, { task: "查B" }] } },
  [`cohort:${H_A}:step:0`]: stepTool("想A", "A"),
  [`cohort:${H_A}:step:1`]: STEP_FINISH,
  [`cohort:${H_A}:final`]: { data: { finding: "A 对接 SAP", cites: ["A-证据-真实存在"] } },
  [`cohort:${H_B}:step:0`]: stepTool("想B", "B"),
  [`cohort:${H_B}:step:1`]: STEP_FINISH,
  [`cohort:${H_B}:final`]: { data: { finding: "B 无对接", cites: ["凭空捏造的出处"] } },
  final: { data: { answer: "综合结论" } },
};

const BASE_OBS = {
  A: "工具返回：A-证据-真实存在（第 3 行）",
  B: "工具返回：B 是另一码事",
};

describe("Cohort（PLAN_EXECUTE 第二形态）", () => {
  it("门未开（无 cohort_max）→ 经典路径原样：首调用是 key=plan 的 PLAN_SCHEMA", async () => {
    expect(cohortMaxOf(cohortNode({}))).toBeNull();
    expect(cohortMaxOf(cohortNode({ cohort_max: 1 }))).toBeNull();
    const gw = new KeyedGateway({}, [
      { data: { steps: [] } }, // plan
      { data: { thought: "t", action: { kind: "finish" } } },
      { data: { answer: "经典" } }, // final
    ]);
    const handler = new CohortHandler({});
    const rec = new Rec();
    const loop = new AgentLoop({
      gateway: gw as never,
      ctxManager: new CM() as never,
      panel: new Panel() as never,
      bus: new Bus() as never,
      recorder: rec as never,
      budget: new Budget(),
      handlers: { h: handler },
      newScratchpad: (t: number) => new Scratchpad({ budgetTokens: t }),
    });
    await loop.run(cohortNode({}), {
      working: { select: () => ({}) } as never,
      deps: [],
      runId: "r-classic",
    });
    expect(gw.calls[0]!.key).toBe("plan");
    expect(gw.calls[0]!.schema).toBe(PLAN_SCHEMA);
  });

  it("基本流：提案→并行子任务（稳定哈希键）→接地检查→确定性合并→标准收尾", async () => {
    const gw = new KeyedGateway(BASE_RESPONSES);
    const handler = new CohortHandler(BASE_OBS);
    const { rec, run } = rig(gw, handler);
    const res = await run();

    expect(res.output).toEqual({ answer: "综合结论" });

    // 提案 schema 把上限写给模型看
    const planCall = gw.calls.find((c) => c.key === "cohort:plan")!;
    const subtasks = (planCall.schema as { properties: { subtasks: Record<string, unknown> } })
      .properties.subtasks;
    expect(subtasks["maxItems"]).toBe(2);
    expect(cohortPlanSchema(3)["type"]).toBe("object");

    // 键 = 任务文本哈希，不是数组下标
    const keys = new Set(gw.calls.map((c) => c.key));
    for (const k of [
      "cohort:plan",
      `cohort:${H_A}:step:0`,
      `cohort:${H_A}:final`,
      `cohort:${H_B}:step:0`,
      `cohort:${H_B}:final`,
      "final",
    ]) {
      expect(keys, k).toContain(k);
    }

    // 每个子任务：独立 effect 键前缀 + 分摊后的工具额度（4 / 2 = 2）
    const byKey = new Map(handler.dispatched.map((d) => [d.effect_key, d]));
    expect(byKey.has(`cohort:${H_A}:t0`)).toBe(true);
    expect(byKey.has(`cohort:${H_B}:t0`)).toBe(true);
    for (const d of handler.dispatched) expect(d.tool_limit).toBe(2);

    // PLAN_CREATED 标了 cohort，UI 据此显示「N 个并行分析任务」
    const planned = rec.events.find((e) => e.kind === EventKind.PLAN_CREATED)!;
    expect(planned.payload["cohort"]).toBe(true);
    expect(planned.payload["cohort_tasks"]).toBe(2);
    const thoughts = rec.events.filter((e) => e.kind === EventKind.THOUGHT);
    expect(thoughts.some((e) => e.payload["cohort_task"] === 0)).toBe(true);
    expect(thoughts.some((e) => e.payload["cohort_task"] === 1)).toBe(true);

    // 接地：A 的 cite 在自己的工具返回里 → 干净；B 的不在 → 明标不可采信
    const finalCall = gw.calls.find((c) => c.key === "final")!;
    expect(finalCall.prompt).toContain("「A-证据-真实存在」");
    expect(finalCall.prompt).not.toContain("「A-证据-真实存在」（未在工具返回中找到");
    expect(finalCall.prompt).toContain("「凭空捏造的出处」（未在工具返回中找到，不可采信）");
  });

  it("同文子任务不共键：出现序号消歧", async () => {
    const h = fingerprint("同一句话");
    const gw = new KeyedGateway({
      "cohort:plan": { data: { subtasks: [{ task: "同一句话" }, { task: "同一句话" }] } },
      [`cohort:${h}:step:0`]: STEP_FINISH,
      [`cohort:${h}:final`]: { data: { finding: "一", cites: [] } },
      [`cohort:${h}:1:step:0`]: STEP_FINISH,
      [`cohort:${h}:1:final`]: { data: { finding: "二", cites: [] } },
      final: { data: { answer: "ok" } },
    });
    const { run } = rig(gw, new CohortHandler({}));
    await run();
    const keys = new Set(gw.calls.map((c) => c.key));
    expect(keys).toContain(`cohort:${h}:step:0`);
    expect(keys).toContain(`cohort:${h}:1:step:0`);
  });

  it("单个子任务失败不拖垮：另一个照常，失败明写进合并结果", async () => {
    const gw = new KeyedGateway(BASE_RESPONSES);
    const handler = new CohortHandler({ ...BASE_OBS, A: new Error("网络抖了") });
    const { run } = rig(gw, handler);
    const res = await run();
    expect(res.output).toEqual({ answer: "综合结论" });
    const finalCall = gw.calls.find((c) => c.key === "final")!;
    expect(finalCall.prompt).toContain("子任务失败");
    expect(finalCall.prompt).toContain("网络抖了");
  });

  it("四类运行级异常原样穿透，不被吞成「子任务失败」", async () => {
    for (const exc of [
      new QuotaExhausted("m", "欠费"),
      new BudgetExhausted("tokens", 1, 2),
      new HumanInputRequired("P", "rq", {}),
      new NodeFailure("P", "停", false),
    ]) {
      const gw = new KeyedGateway({
        ...BASE_RESPONSES,
        [`cohort:${H_B}:step:0`]: { reject: exc },
      });
      const { run } = rig(gw, new CohortHandler(BASE_OBS));
      await expect(run(), exc.constructor.name).rejects.toBe(exc);
    }
  });

  it("全军覆没 → NodeFailure（retryable），错误带上首个失败原因", async () => {
    const gw = new KeyedGateway(BASE_RESPONSES);
    const handler = new CohortHandler({ A: new Error("坏A"), B: new Error("坏B") });
    const { run } = rig(gw, handler);
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NodeFailure);
    expect((err as NodeFailure).message).toContain("cohort 全部 2 个子任务失败");
  });

  it("提案为空 → 退回经典 plan-execute，不炸节点", async () => {
    const gw = new KeyedGateway(
      { "cohort:plan": { data: { subtasks: [] } } },
      [
        { data: { steps: [] } }, // 经典 plan
        { data: { thought: "t", action: { kind: "finish" } } },
        { data: { answer: "经典兜底" } },
      ],
    );
    const { run } = rig(gw, new CohortHandler({}));
    const res = await run();
    expect(res.output).toEqual({ answer: "经典兜底" });
    expect(gw.calls.some((c) => c.key === "plan")).toBe(true);
  });
});
