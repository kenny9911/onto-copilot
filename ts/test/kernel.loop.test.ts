/**
 * loop 的 golden 校验 —— golden/loop.json 由 tools/golden/loop.py 从 Python 侧真跑出来。
 *
 * golden 里存的是**剧本**不是期望字符串：每个 run 用例给出节点规格、handler 配置和
 * 一串按调用序返回的模型响应，Python 用真的 AgentLoop 跑一遍，把网关收到的每一条
 * prompt、发出的每一个事件、handler 的调用轨迹、最终 NodeResult 全录下来。这里照同
 * 一份剧本搭同构的 stub 再跑一遍，逐项比对 —— 所以 prompt 的字节和 finalize 被调了
 * 几次都被钉住，而不是靠手写期望值去猜 Python 的行为。
 *
 * **两条已知分叉，都显式钉住，不是绕过**：
 *   1. `Verdict.to_dict()` 比 TS 侧的局部最小类型多 `high` / `note` 两个字段
 *      （它们属于 critic.py，loop 不读）。比对时两边都投影成 lens/passed/findings。
 *   2. `str()` 里值为整数的 float：JS 分不出 `1` 和 `1.0`。golden 的 py_str 用例
 *      刻意避开这一条 —— 它在 ids / journal 的 golden 里已经钉过，是语言边界。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Budget, type Dim } from "../src/kernel/budget.js";
import {
  makeNodeBudget,
  makeNodeSpec,
  makeScopeSpec,
  parseDifficulty,
  parseNodeMode,
  type NodeSpec,
} from "../src/kernel/dag.js";
import { HumanInputRequired, NodeFailure } from "../src/kernel/errors.js";
import { type EventKind } from "../src/kernel/events.js";
import { pyJsonDumps } from "../src/kernel/journal.js";
import {
  AgentLoop,
  NodeHandler,
  PLAN_SCHEMA,
  STEP_SCHEMA,
  fmtAction,
  parseActionArgs,
  pyStr,
  refinePrompt,
  type LoopAssembleOptions,
  type LoopCallOptions,
  type LoopCompletion,
  type LoopCriticContext,
  type LoopFinding,
  type LoopRendered,
  type LoopScratchpad,
  type LoopVerdict,
  type LoopWorkingSet,
} from "../src/kernel/loop.js";

// ══════════════════════════════════════════════════════════════════
//  golden 形状
// ══════════════════════════════════════════════════════════════════
interface PyFinding {
  code: string;
  claim: string;
  severity?: string;
  target?: string;
  evidence_checked?: string[];
}
interface PyVerdict {
  lens: string;
  passed: boolean;
  findings?: PyFinding[];
  note?: string;
}
interface NodeCfg {
  id: string;
  mode: string;
  handler: string;
  deps?: string[];
  critics?: string[];
  critic_rounds?: number;
  difficulty?: string | null;
  budget?: Record<string, number>;
  scope?: Record<string, unknown>;
}
interface HandlerCfg {
  schema?: Record<string, unknown> | null;
  system?: string;
  task?: string;
  query?: string | null;
  skip_model?: unknown;
  finalize_merge?: Record<string, unknown> | null;
  human_request?: Record<string, unknown>;
  execute?: unknown;
  dispatch?: unknown[];
}
interface RunCase {
  node: NodeCfg;
  handler: HandlerCfg;
  working?: Record<string, unknown>;
  facts?: string;
  responses?: { text?: string; data?: unknown }[];
  judgements?: PyVerdict[][];
  answers?: Record<string, unknown>;
  gateway?: { rounds?: number; iterations?: number; samples?: number; model?: string };
  pad?: { over_at?: number[]; compact_to?: number };
  budget?: { limits?: Record<string, number>; spend?: Record<string, number> };
  handlers_key?: string;
  run_id: string;
}
interface PyCall {
  node_id: string;
  prompt: string;
  passed: string[];
  system: string;
  difficulty: string;
  schema: string;
  key: string | null;
  max_tokens: number | null;
}
interface PyEvent {
  kind: string;
  node_id: string | null;
  payload: Record<string, unknown>;
}
interface PyJudged {
  draft: unknown;
  lenses: string[];
  allow_llm: boolean;
  node_id: string;
  facts: string;
  samples: number;
  generator: unknown;
}
interface PyAssemble {
  task: string;
  query: string;
  has_working: boolean;
  deps: string[] | null;
  run_id: string;
  evidence_files: string[] | null;
  evidence_top_k: number;
  budget_tokens: number | null;
}
interface PyResult {
  node_id: string;
  output: unknown;
  verdicts: (PyVerdict & { high: number })[];
  digest: Record<string, unknown>;
  iterations: number;
  critic_rounds: number;
  context_stats: Record<string, unknown>;
  passed: boolean;
}
interface PyRun {
  name: string;
  doc: string;
  case: RunCase;
  calls: PyCall[];
  events: PyEvent[];
  judged: PyJudged[];
  validated: { lenses: string[]; node_id: string }[];
  assembles: PyAssemble[];
  reflections: string[];
  fact_patterns: string[];
  selects: string[][];
  trace: string[];
  pads: { budget_tokens: number; entries: Record<string, string>[] }[];
  result: PyResult | null;
  error: Record<string, unknown> | null;
}
interface Golden {
  schemas: { STEP_SCHEMA: Record<string, unknown>; PLAN_SCHEMA: Record<string, unknown> };
  parse_action_args: { action: Record<string, unknown>; out: Record<string, unknown> }[];
  fmt_action: { action: Record<string, unknown>; out: string }[];
  step_prompt: {
    ctx_text: string;
    pad_render: string;
    pad_len: number;
    steps: unknown[] | null;
    out: string;
  }[];
  refine_prompt: { draft: unknown; verdicts: PyVerdict[]; out: string }[];
  py_str: { value: unknown; out: string }[];
  route: {
    outputs: Record<string, unknown> | null;
    outputs_build: { key: string; field: string; char: string; n: number } | null;
    deps: string[];
    critics: string[];
    out: string;
  }[];
  runs: PyRun[];
}

const G = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "golden", "loop.json"), "utf8"),
) as Golden;

// ══════════════════════════════════════════════════════════════════
//  stub 群 —— 与 tools/golden/loop.py 里的那一套逐字等价
// ══════════════════════════════════════════════════════════════════
class FakePad implements LoopScratchpad {
  readonly entries: { thought: string; action: string; observation: string }[] = [];
  constructor(
    readonly budgetTokens: number,
    private readonly overAt: ReadonlySet<number>,
    private readonly compactTo: number,
  ) {}
  get size(): number {
    return this.entries.length;
  }
  append(thought = "", action = "", observation = ""): void {
    this.entries.push({ thought, action, observation });
  }
  overBudget(): boolean {
    return this.overAt.has(this.entries.length);
  }
  compactToFit(): number {
    return this.compactTo;
  }
  render(): string {
    return this.entries.map((e) => `T:${e.thought}|A:${e.action}|O:${e.observation}`).join("\n");
  }
  digest(): Record<string, unknown> {
    return { turns: this.entries.length, summary: this.render() };
  }
}

class StubRecorder {
  readonly events: PyEvent[] = [];
  private readonly attempts = new Map<string, number>();
  constructor(private readonly answers: Record<string, unknown>) {}
  nextAttempt(nodeId: string): number {
    const n = this.attempts.get(nodeId) ?? 0;
    this.attempts.set(nodeId, n + 1);
    return n;
  }
  emit(
    kind: EventKind,
    opts?: { nodeId?: string | null; payload?: Record<string, unknown> },
  ): unknown {
    this.events.push({
      kind,
      node_id: opts?.nodeId ?? null,
      payload: opts?.payload ?? {},
    });
    return null;
  }
  askHuman(nodeId: string, requestId: string, payload: Record<string, unknown>): Promise<unknown> {
    if (Object.hasOwn(this.answers, requestId)) return Promise.resolve(this.answers[requestId]);
    return Promise.reject(new HumanInputRequired(nodeId, requestId, payload));
  }
}

class StubRendered implements LoopRendered {
  constructor(readonly text: string) {}
  stats(): Record<string, unknown> {
    // Python 那边是 len(text)，数的是**码点**
    return { total_tokens: [...this.text].length, layers: { system: 1 }, chunks: 0 };
  }
}

class StubCM {
  readonly assembles: PyAssemble[] = [];
  readonly reflections: string[] = [];
  assemble(o: LoopAssembleOptions): LoopRendered {
    this.assembles.push({
      task: o.task,
      query: o.query ?? "",
      has_working: o.working !== undefined && o.working !== null,
      deps: o.deps === undefined || o.deps === null ? null : [...o.deps],
      run_id: o.runId ?? "",
      evidence_files:
        o.evidenceFiles === undefined || o.evidenceFiles === null ? null : [...o.evidenceFiles],
      evidence_top_k: o.evidenceTopK ?? 24,
      budget_tokens: o.budgetTokens ?? null,
    });
    return new StubRendered(`CTX<${o.task}>`);
  }
  reflect(lesson: string): void {
    this.reflections.push(lesson);
  }
}

class StubBus {
  readonly patterns: string[] = [];
  constructor(private readonly facts: string) {}
  renderFacts(pattern = "*"): string {
    this.patterns.push(pattern);
    return this.facts;
  }
}

class StubWorking implements LoopWorkingSet {
  readonly selects: string[][] = [];
  constructor(private readonly outputs: Record<string, unknown>) {}
  select(nodeIds: readonly string[]): Record<string, unknown> {
    this.selects.push([...nodeIds]);
    return { ...this.outputs };
  }
}

/** gw.call 的 kwargs 名 → golden 里记的名字。见 loop.py:415 —— refine 那一次
 * **不传 system**，所以"传了哪些 kwargs"本身就是要钉的行为。 */
const KW: Readonly<Record<string, string>> = {
  system: "system",
  difficulty: "difficulty",
  schema: "schema",
  model: "model",
  key: "key",
  maxTokens: "max_tokens",
  images: "images",
};

class StubGateway {
  readonly calls: PyCall[] = [];
  readonly routing: { modelFor: (d: string) => unknown };
  constructor(
    private readonly responses: { text?: string; data?: unknown }[],
    private readonly rounds: number,
    private readonly iterations: number,
    private readonly samples: number,
    model: string,
  ) {
    this.routing = { modelFor: (d: string) => ({ name: model, difficulty: d }) };
  }
  call(nodeId: string, prompt: string, opts?: LoopCallOptions): Promise<LoopCompletion> {
    const i = this.calls.length;
    const o = (opts ?? {}) as Record<string, unknown>;
    this.calls.push({
      node_id: nodeId,
      prompt,
      passed: Object.keys(o)
        .filter((k) => Object.hasOwn(KW, k))
        .map((k) => KW[k] as string)
        .sort(),
      system: opts?.system ?? "",
      difficulty: opts?.difficulty ?? "",
      schema: schemaId(opts?.schema),
      key: opts?.key ?? null,
      max_tokens: opts?.maxTokens ?? null,
    });
    const r = this.responses[i] ?? { text: "", data: null };
    return Promise.resolve({ text: r.text ?? "", data: r.data ?? null });
  }
  iterationsFor(): number {
    return this.iterations;
  }
  criticRoundsFor(_d: unknown, requested?: number | null): number {
    return requested === undefined || requested === null ? this.rounds : requested;
  }
  samplesFor(): number {
    return this.samples;
  }
}

function schemaId(schema: Record<string, unknown> | null | undefined): string {
  if (schema === null || schema === undefined) return "null";
  if (schema === STEP_SCHEMA) return "STEP";
  if (schema === PLAN_SCHEMA) return "PLAN";
  return "HANDLER";
}

function toVerdict(v: PyVerdict): LoopVerdict {
  return {
    lens: v.lens,
    passed: v.passed,
    findings: (v.findings ?? []).map(
      (f): LoopFinding => ({
        code: f.code,
        claim: f.claim,
        evidenceChecked: [...(f.evidence_checked ?? [])],
      }),
    ),
  };
}

class StubPanel {
  readonly validated: { lenses: string[]; node_id: string }[] = [];
  readonly judged: PyJudged[] = [];
  constructor(private readonly judgements: PyVerdict[][]) {}
  validate(lenses: readonly string[], nodeId: string): void {
    this.validated.push({ lenses: [...lenses], node_id: nodeId });
  }
  judge(
    draft: unknown,
    lenses: readonly string[],
    ctx: LoopCriticContext,
    opts?: { allowLlm?: boolean },
  ): Promise<LoopVerdict[]> {
    const i = this.judged.length;
    this.judged.push({
      draft,
      lenses: [...lenses],
      allow_llm: opts?.allowLlm ?? true,
      node_id: ctx.nodeId,
      facts: ctx.facts,
      samples: ctx.samples,
      generator: ctx.generator,
    });
    return Promise.resolve((this.judgements[i] ?? []).map(toVerdict));
  }
}

class StubHandler extends NodeHandler {
  readonly trace: string[] = [];
  private dispatches = 0;
  constructor(private readonly cfg: HandlerCfg) {
    super();
    this.schema = cfg.schema ?? null;
    this.system = cfg.system ?? "";
  }
  override forNode(nodeId: string): NodeHandler {
    this.trace.push(`for_node:${nodeId}`);
    return this;
  }
  override task(_inputs: Record<string, unknown>): string {
    this.trace.push("task");
    return this.cfg.task ?? "完成本节点任务。";
  }
  override query(inputs: Record<string, unknown>): string {
    this.trace.push("query");
    const q = this.cfg.query;
    return q === undefined || q === null ? this.task(inputs) : q;
  }
  override skipModel(): unknown {
    this.trace.push("skip_model");
    return this.cfg.skip_model ?? null;
  }
  override finalize(draft: unknown): unknown {
    this.trace.push(`finalize:${pyJsonDumps(draft, { defaultStr: true })}`);
    const merge = this.cfg.finalize_merge;
    if (merge === undefined || merge === null) return draft;
    // Python 是 `dict(draft or {})` —— 假值 draft 一律当空 dict
    const base = typeof draft === "object" && draft !== null ? draft : {};
    return { ...base, ...merge };
  }
  override humanRequest(draft: unknown): Record<string, unknown> {
    this.trace.push("human_request");
    return this.cfg.human_request ?? { draft };
  }
  override execute(): Promise<unknown> {
    this.trace.push("execute");
    return Promise.resolve(this.cfg.execute ?? null);
  }
  override dispatch(action: Record<string, unknown>): Promise<unknown> {
    this.trace.push(`dispatch:${String(action["tool"] ?? "")}`);
    const seq = this.cfg.dispatch ?? [];
    const i = seq.length > 0 ? Math.min(this.dispatches, seq.length - 1) : -1;
    this.dispatches += 1;
    return Promise.resolve(i >= 0 ? seq[i] : null);
  }
}

function specOf(c: NodeCfg): NodeSpec {
  const b = c.budget ?? {};
  const s = (c.scope ?? {}) as { evidence_top_k?: number; blackboard_pattern?: string };
  return makeNodeSpec({
    id: c.id,
    mode: parseNodeMode(c.mode),
    handler: c.handler,
    deps: c.deps ?? [],
    critics: c.critics ?? [],
    criticRounds: c.critic_rounds ?? 2,
    difficulty: c.difficulty ? parseDifficulty(c.difficulty) : null,
    budget: makeNodeBudget({
      ...(b["tokens"] !== undefined ? { tokens: b["tokens"] } : {}),
      ...(b["iterations"] !== undefined ? { iterations: b["iterations"] } : {}),
      ...(b["wallclock_s"] !== undefined ? { wallclockS: b["wallclock_s"] } : {}),
      ...(b["tool_calls"] !== undefined ? { toolCalls: b["tool_calls"] } : {}),
    }),
    scope: makeScopeSpec({
      ...(s.evidence_top_k !== undefined ? { evidenceTopK: s.evidence_top_k } : {}),
      ...(s.blackboard_pattern !== undefined ? { blackboardPattern: s.blackboard_pattern } : {}),
    }),
  });
}

interface Replayed {
  calls: PyCall[];
  events: PyEvent[];
  judged: PyJudged[];
  validated: { lenses: string[]; node_id: string }[];
  assembles: PyAssemble[];
  reflections: string[];
  fact_patterns: string[];
  selects: string[][];
  trace: string[];
  pads: { budget_tokens: number; entries: Record<string, string>[] }[];
  result: Omit<PyResult, "verdicts"> & { verdicts: PyVerdict[] };
  error: Record<string, unknown> | null;
}

async function replay(c: RunCase): Promise<Replayed> {
  const bcfg = c.budget ?? {};
  const budget = new Budget((bcfg.limits ?? {}) as Partial<Record<Dim, number>>);
  if (bcfg.spend) budget.spend(bcfg.spend as Partial<Record<Dim, number>>);

  const rec = new StubRecorder(c.answers ?? {});
  const cm = new StubCM();
  const bus = new StubBus(c.facts ?? "");
  const gw = new StubGateway(
    c.responses ?? [],
    c.gateway?.rounds ?? 2,
    c.gateway?.iterations ?? 4,
    c.gateway?.samples ?? 1,
    c.gateway?.model ?? "stub-model",
  );
  const panel = new StubPanel(c.judgements ?? []);
  const handler = new StubHandler(c.handler);
  const working = new StubWorking(c.working ?? {});
  const pads: FakePad[] = [];
  const overAt = new Set(c.pad?.over_at ?? []);
  const compactTo = c.pad?.compact_to ?? 0;

  const loop = new AgentLoop({
    gateway: gw,
    ctxManager: cm,
    panel,
    bus,
    recorder: rec,
    budget,
    handlers: { [c.handlers_key ?? c.node.handler]: handler },
    newScratchpad: (budgetTokens: number) => {
      const p = new FakePad(budgetTokens, overAt, compactTo);
      pads.push(p);
      return p;
    },
  });

  let result: Replayed["result"] | null = null;
  let error: Record<string, unknown> | null = null;
  try {
    const res = await loop.run(specOf(c.node), {
      working,
      deps: c.node.deps ?? [],
      runId: c.run_id,
    });
    result = {
      node_id: res.nodeId,
      output: res.output,
      verdicts: res.verdicts.map((v) => ({
        lens: v.lens,
        passed: v.passed,
        findings: v.findings.map((f) => ({ code: f.code, claim: f.claim })),
      })),
      digest: res.digest,
      iterations: res.iterations,
      critic_rounds: res.criticRounds,
      context_stats: res.contextStats,
      passed: res.verdicts.every((v) => v.passed),
    };
  } catch (e) {
    if (e instanceof NodeFailure) {
      error = {
        type: "NodeFailure",
        message: e.message,
        node_id: e.nodeId,
        retryable: e.retryable,
      };
    } else if (e instanceof HumanInputRequired) {
      error = {
        type: "HumanInputRequired",
        message: e.message,
        node_id: e.nodeId,
        request_id: e.requestId,
        payload: e.payload,
      };
    } else {
      throw e;
    }
  }

  return {
    calls: gw.calls,
    events: rec.events,
    judged: panel.judged,
    validated: panel.validated,
    assembles: cm.assembles,
    reflections: cm.reflections,
    fact_patterns: bus.patterns,
    selects: working.selects,
    trace: handler.trace,
    pads: pads.map((p) => ({ budget_tokens: p.budgetTokens, entries: p.entries })),
    result: result as Replayed["result"],
    error,
  };
}

/** golden 的 verdict 带着 critic.py 的 `high` / `note`（loop 不读），投影掉再比。 */
function projectVerdicts(vs: (PyVerdict & { high?: number })[]): PyVerdict[] {
  return vs.map((v) => ({
    lens: v.lens,
    passed: v.passed,
    findings: (v.findings ?? []).map((f) => ({ code: f.code, claim: f.claim })),
  }));
}

// ══════════════════════════════════════════════════════════════════
//  纯函数
// ══════════════════════════════════════════════════════════════════
describe("schema 常量", () => {
  it("STEP_SCHEMA / PLAN_SCHEMA 与 Python 逐字一致", () => {
    expect(STEP_SCHEMA).toEqual(G.schemas.STEP_SCHEMA);
    expect(PLAN_SCHEMA).toEqual(G.schemas.PLAN_SCHEMA);
  });
});

describe("parseActionArgs", () => {
  for (const [i, c] of G.parse_action_args.entries()) {
    it(`#${i} ${JSON.stringify(c.action)}`, () => {
      expect(parseActionArgs({ ...c.action })).toEqual(c.out);
    });
  }

  it("args_json 是 dict 时原样返回同一个引用（Python 也不复制）", () => {
    const args = { a: 1 };
    expect(parseActionArgs({ args_json: args })).toBe(args);
  });
});

describe("fmtAction", () => {
  for (const [i, c] of G.fmt_action.entries()) {
    it(`#${i}`, () => {
      expect(fmtAction({ ...c.action })).toBe(c.out);
    });
  }
});

describe("AgentLoop.stepPrompt", () => {
  for (const [i, c] of G.step_prompt.entries()) {
    it(`#${i}`, () => {
      // pad 的内容由 golden 给（render 固定），这里只需要 size 与 render 对得上
      const stub: LoopScratchpad = {
        size: c.pad_len,
        append: () => null,
        overBudget: () => false,
        compactToFit: () => 0,
        render: () => c.pad_render,
        digest: () => ({}),
      };
      expect(AgentLoop.stepPrompt(c.ctx_text, stub, c.steps)).toBe(c.out);
    });
  }
});

describe("refinePrompt", () => {
  for (const [i, c] of G.refine_prompt.entries()) {
    it(`#${i}`, () => {
      expect(refinePrompt(c.draft, c.verdicts.map(toVerdict))).toBe(c.out);
    });
  }
});

describe("pyStr（observation 的 str() 形态）", () => {
  for (const [i, c] of G.py_str.entries()) {
    it(`#${i} ${JSON.stringify(c.value)}`, () => {
      expect(pyStr(c.value)).toBe(c.out);
    });
  }

  it("dict 不能变成 [object Object]", () => {
    // 直接用 String() 的话模型下一步看到的是一句 [object Object]
    expect(pyStr({ error: "x" })).not.toContain("[object");
  });
});

describe("AgentLoop.route", () => {
  for (const [i, c] of G.route.entries()) {
    it(`#${i} → ${c.out}`, () => {
      const outputs =
        c.outputs ??
        (() => {
          const b = c.outputs_build;
          if (b === null) throw new Error("golden 缺 outputs_build");
          return { [b.key]: { [b.field]: b.char.repeat(b.n) } };
        })();
      const loop = new AgentLoop({
        gateway: null as never,
        ctxManager: null as never,
        panel: null as never,
        bus: null as never,
        recorder: null as never,
        budget: new Budget(),
        handlers: {},
        newScratchpad: () => new FakePad(0, new Set(), 0),
      });
      const node = specOf({ id: "N", mode: "single_shot", handler: "h", critics: c.critics });
      expect(loop.route(node, new StubWorking(outputs), c.deps)).toBe(c.out);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  整节点重放
// ══════════════════════════════════════════════════════════════════
describe("AgentLoop.run 重放 golden 剧本", () => {
  for (const run of G.runs) {
    describe(run.name, () => {
      it(run.doc.slice(0, 60), async () => {
        const got = await replay(run.case);

        expect(got.error).toEqual(run.error);
        expect(got.trace).toEqual(run.trace);
        expect(got.calls).toEqual(run.calls);
        expect(got.events).toEqual(run.events);
        expect(got.judged).toEqual(run.judged);
        expect(got.validated).toEqual(run.validated);
        expect(got.assembles).toEqual(run.assembles);
        expect(got.reflections).toEqual(run.reflections);
        expect(got.fact_patterns).toEqual(run.fact_patterns);
        expect(got.selects).toEqual(run.selects);
        expect(got.pads).toEqual(run.pads);

        if (run.result === null) {
          expect(got.result).toBeNull();
        } else {
          expect(got.result.output).toEqual(run.result.output);
          expect(got.result.verdicts).toEqual(projectVerdicts(run.result.verdicts));
          expect(got.result.digest).toEqual(run.result.digest);
          expect(got.result.iterations).toBe(run.result.iterations);
          expect(got.result.critic_rounds).toBe(run.result.critic_rounds);
          expect(got.result.context_stats).toEqual(run.result.context_stats);
          expect(got.result.passed).toBe(run.result.passed);
          expect(got.result.node_id).toBe(run.result.node_id);
        }
      });
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  P0：修订产物必须再过一次 finalize
// ══════════════════════════════════════════════════════════════════
describe("critic 修订环不能吃掉规则抽好的内容（loop.ts:critique 的 finalize）", () => {
  /**
   * 真实事故：一段 45 行的行动表，规则逐行抽出 45 个 action，critic 报的是
   * 「对象缺失」；模型按意见重出一版 JSON，里面只有对象、没有 action —— 45 个行动
   * 就此消失，112 行 API 表最终抽出 0 个 action。修订的产物同样要过 finalize，
   * 规则那份才是权威。
   *
   * **这条测试是这个 bug 的钉子**：把 `critique()` 里的
   * `draft = handler.finalize(comp.data, inputs)` 改回 `draft = comp.data`，
   * 下面三条断言全红（已实际验证过一遍，不是推测）。
   */
  class RuleBacked extends NodeHandler {
    override schema: Record<string, unknown> | null = { type: "object" };
    override task(): string {
      return "抽取 ObjectType";
    }
    override finalize(draft: unknown): unknown {
      const base = typeof draft === "object" && draft !== null ? draft : {};
      // 规则逐行抽好的那份，带着出处，模型重出的 JSON 里绝不会有
      return { ...base, actions: [{ api_name: "createPbp" }] };
    }
  }

  async function runIt(): Promise<{ result: unknown; seen: unknown[] }> {
    const rec = new StubRecorder({});
    const gw = new StubGateway(
      [{ data: { objects: [] } }, { data: { objects: [{ api_name: "pbpHeader" }] } }],
      2,
      4,
      1,
      "m",
    );
    // 第一轮：没抽出对象 → 打回；第二轮：模型只重出了对象
    const panel = new StubPanel([
      [
        {
          lens: "coverage",
          passed: false,
          findings: [{ code: "OBJECTS_MISSING", claim: "应该能抽出对象，实际一个都没有" }],
        },
      ],
      [{ lens: "coverage", passed: true }],
    ]);
    const loop = new AgentLoop({
      gateway: gw,
      ctxManager: new StubCM(),
      panel,
      bus: new StubBus(""),
      recorder: rec,
      budget: new Budget(),
      handlers: { x: new RuleBacked() },
      newScratchpad: (t) => new FakePad(t, new Set(), 0),
    });
    const node = makeNodeSpec({
      id: "EXTRACT",
      mode: parseNodeMode("single_shot"),
      handler: "x",
      critics: ["coverage"],
      criticRounds: 2,
    });
    const res = await loop.run(node, { working: new StubWorking({}), deps: [], runId: "r1" });
    return { result: res.output, seen: panel.judged.map((j) => j.draft) };
  }

  it("修订后的产物里，规则抽好的 action 还在", async () => {
    const { result } = await runIt();
    expect(result).toEqual({
      objects: [{ api_name: "pbpHeader" }],
      actions: [{ api_name: "createPbp" }],
    });
  });

  it("修订后的那一版也要带上模型这次改的东西", async () => {
    const { result } = await runIt();
    expect((result as { objects: unknown[] }).objects).toHaveLength(1);
  });

  it("终局评审看到的是 finalize 之后的产物，不是模型刚吐的半成品", async () => {
    const { seen } = await runIt();
    expect(seen).toHaveLength(2);
    // critic 判的必须是节点真正要交出去的东西 —— 否则它会对"模型没抽但规则已经
    // 抽了"的内容报缺失，把一个好产物打回去重做
    expect((seen[1] as { actions: unknown[] }).actions).toEqual([{ api_name: "createPbp" }]);
  });
});
