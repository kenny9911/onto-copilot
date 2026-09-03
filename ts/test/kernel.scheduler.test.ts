/**
 * scheduler 的 golden 校验 —— golden/scheduler.json 由 tools/golden/scheduler.py
 * 从 Python 侧真跑出来。
 *
 * golden 里存的是**程序**：每条用例带一份 DAG 描述 + 一份脚本化的假 AgentLoop
 * （第 n 次调用返回什么 / 抛什么 / 睡多久 / 花多少预算），两边各自 replay 同一份
 * 脚本，再比对 outcome、每个节点被调的**次数**、以及 journal 里的整条事件流
 * （含 payload 的**键序**）。所以下面没有一个手写的期望值。
 *
 * 事件流能对得上，前提是这里的 `FakeRecorder` / `FakeBus` 与 Python 的
 * `Recorder` / `AgentBus.broadcast` 行为一致 —— 这两个替身因此也被 golden
 * 顺带钉住了：它们一旦跑偏，事件流立刻对不上。（`recorder.ts` / `bus.ts` 已经
 * 落地，但它们是带依赖的大对象；调度器这一层要的只是那五个方法，所以仍走替身。
 * 真类**结构上满足**这几个 port，下面有一条编译期断言钉住这件事。）
 *
 * **四条已知分叉，都在下面显式钉住，不是绕过**：
 *   1. Python 的 `\d`（str 模式）是 Unicode 的，`count == ٣` 会过并被 int() 解析；
 *      JS 的 `\d`（u 标志）只有 ASCII，这里抛「不支持的表达式」。见 known_divergences。
 *   2. 节点超时消息里的数字：Python 分 int / float（`60.0` 打成 "60.0"），
 *      JS 只有 double（打成 "60"）。golden 里那条用的是 0.01，两边一致。
 *   3. 「依赖无法满足」那条分支从公开 API 走不到（冻结过的 DAG 无环、依赖必存在），
 *      两边用同一个补丁（换掉 topoOrder + resolveDeps）才碰得到。
 *   4. 取消：Node 没有真正的任务取消。scheduler.ts 给的是「结果隔离」硬承诺 +
 *      `AbortSignal` 软承诺，Python 侧是 `task.cancel()`。golden 比不出这一层
 *      （Python 那边被取消的节点不会再产生事件），所以另写了 TS 侧的用例。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { Decision, Gate, makeGateResult, metricsFrom, type Verdict } from "../src/kernel/critic.js";
import {
  Dag,
  makeGateSpec,
  makeNodeBudget,
  makeNodeSpec,
  parseNodeMode,
  type GateSpec,
  type NodeSpec,
} from "../src/kernel/dag.js";
import { BudgetExhausted, HumanInputRequired, NodeFailure, pyRepr } from "../src/kernel/errors.js";
import { EventKind, eventToDict, makeEvent, type Event } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { QuotaExhausted } from "../src/kernel/llm.js";
import { WorkingSet } from "../src/kernel/memory/short_term.js";
import {
  metricsFromVerdicts,
  parseRunStatus,
  requirementPasses,
  runOutcomeOk,
  RunStatus,
  Scheduler,
  type AgentLoopLike,
  type BusLike,
  type NodeResultLike,
  type RecorderLike,
  type VerdictLike,
} from "../src/kernel/scheduler.js";

// ══════════════════════════════════════════════════════════════════
//  golden 形状
// ══════════════════════════════════════════════════════════════════

interface GoldenRequirement {
  readonly fixture: string;
  readonly expr: string;
  readonly result?: boolean;
  readonly error?: string;
  readonly retryable?: boolean;
}

interface GoldenEvent {
  readonly seq: number;
  readonly kind: string;
  readonly node_id: string | null;
  readonly ref: string | null;
  readonly payload: Record<string, unknown>;
  readonly payload_keys: string[];
}

interface GoldenOutcome {
  readonly status: string;
  readonly ok: boolean;
  readonly outputs: Record<string, unknown>;
  readonly results: Record<string, unknown>;
  readonly pending_human: Record<string, unknown> | null;
  readonly error: string;
  readonly skipped: string[];
  readonly budget: Record<string, unknown>;
}

interface ScriptOp {
  readonly do: string;
  readonly s?: number;
  readonly then?: ScriptOp;
  readonly amounts?: Record<string, number>;
  readonly add?: number;
  readonly output?: unknown;
  readonly verdicts?: readonly {
    readonly lens: string;
    readonly passed: boolean;
    readonly findings?: readonly { readonly severity?: string; readonly code?: string }[];
  }[];
  readonly error?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly msg?: string;
  readonly model?: string;
  readonly detail?: string;
  readonly status?: number;
  readonly request_id?: string;
  readonly payload?: Record<string, unknown>;
}

interface NodeData {
  readonly id: string;
  readonly mode?: string;
  readonly handler?: string;
  readonly deps?: string[];
  readonly retries?: number;
  readonly budget?: { readonly wallclock_s?: number };
  readonly gate?: { readonly kind?: string; readonly require?: string[]; readonly legacy?: string };
  readonly script?: ScriptOp[];
}

interface HistoryOp {
  readonly op: string;
  readonly node: string;
  readonly output?: unknown;
  readonly request_id?: string;
  readonly answer?: unknown;
}

interface CaseInput {
  readonly dag_name?: string;
  readonly run_id?: string;
  readonly nodes: NodeData[];
  readonly seed?: Record<string, unknown>;
  readonly history?: HistoryOp[];
  readonly budget?: {
    readonly limits?: Record<string, number>;
    readonly prespend?: Record<string, number>;
  };
  readonly concurrency?: number;
  readonly patch?: string;
}

interface GoldenCase {
  readonly name: string;
  readonly input: CaseInput;
  readonly outcome: GoldenOutcome;
  readonly calls: Record<string, number>;
  readonly events: GoldenEvent[];
}

interface Golden {
  readonly run_status: Record<string, string>;
  readonly metric_fixtures: Record<string, Record<string, unknown>>;
  readonly requirements: GoldenRequirement[];
  readonly known_divergences: GoldenRequirement[];
  readonly cases: GoldenCase[];
}

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "scheduler.json"), "utf8"),
) as Golden;

// ══════════════════════════════════════════════════════════════════
//  替身：Recorder / Bus / AgentLoop
// ══════════════════════════════════════════════════════════════════

/**
 * `Recorder` 的测试替身。recorder.ts 已经落地，这里仍用替身是因为真 Recorder
 * 是个带 journal / blob store 依赖的大对象，而调度器只用到五个方法；真类结构上
 * 满足 `RecorderLike`（有编译期断言钉着）。
 *
 * 只实现调度器用得到的那几个方法，但**行为必须与 Python 逐条对齐** ——
 * seq 分配、resume 时的历史扫描、complete_node 的 blob ref、ask_human 的
 * 「有答案就返回、没答案就发请求再抛」。blob 走的是已落地的 InMemoryBlobStore，
 * 所以 ref 与 Python 侧逐字节相同（内容寻址）。
 */
class FakeRecorder implements RecorderLike {
  private seq = 0;
  private readonly completed = new Map<string, string | null>();
  private readonly humans = new Map<string, unknown>();

  constructor(
    readonly runId: string,
    readonly journal: InMemoryJournal,
    readonly blobs: InMemoryBlobStore,
    resume = false,
  ) {
    if (resume) {
      for (const ev of this.journal.read(this.runId)) {
        this.seq = Math.max(this.seq, ev.seq + 1);
        if (ev.kind === EventKind.NODE_COMPLETED) this.completed.set(ev.nodeId ?? "", ev.ref);
        else if (ev.kind === EventKind.HUMAN_RECORDED) {
          this.humans.set(String(ev.payload["request_id"]), ev.payload["answer"]);
        }
      }
    }
  }

  emit(
    kind: EventKind,
    opts: {
      readonly nodeId?: string;
      readonly payload?: Record<string, unknown>;
      readonly ref?: string;
    } = {},
  ): Event {
    const ev = makeEvent({
      runId: this.runId,
      seq: this.seq,
      kind,
      nodeId: opts.nodeId ?? null,
      payload: opts.payload ?? {},
      ref: opts.ref ?? null,
      tsMs: 0, // golden 里 ts_ms 已经丢掉了
    });
    this.seq += 1;
    this.journal.append(ev);
    return ev;
  }

  nodeIsComplete(nodeId: string): boolean {
    return this.completed.has(nodeId);
  }

  async nodeOutput(nodeId: string): Promise<unknown> {
    const ref = this.completed.get(nodeId);
    return ref === undefined || ref === null ? null : await this.blobs.getJson(ref);
  }

  async completeNode(nodeId: string, output: unknown): Promise<void> {
    const ref = await this.blobs.putJson(output);
    this.completed.set(nodeId, ref);
    this.emit(EventKind.NODE_COMPLETED, { nodeId, ref });
  }

  async askHuman(
    nodeId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.humans.has(requestId)) return this.humans.get(requestId);
    this.emit(EventKind.HUMAN_REQUESTED, {
      nodeId,
      payload: { request_id: requestId, ...payload },
    });
    throw new HumanInputRequired(nodeId, requestId, payload);
  }

  recordHumanAnswer(nodeId: string, requestId: string, answer: unknown): void {
    this.humans.set(requestId, answer);
    this.emit(EventKind.HUMAN_RECORDED, { nodeId, payload: { request_id: requestId, answer } });
  }
}

/** `bus.AgentBus.broadcast` 的替身：广播 + 落一条 MESSAGE_SENT。 */
class FakeBus implements BusLike {
  readonly sent: { frm: string; topic: string; payload: Record<string, unknown> }[] = [];

  constructor(private readonly rec: FakeRecorder) {}

  broadcast(opts: {
    readonly frm: string;
    readonly topic: string;
    readonly payload?: Record<string, unknown>;
  }): number {
    const payload = opts.payload ?? {};
    this.sent.push({ frm: opts.frm, topic: opts.topic, payload });
    // 本测试里没有订阅者，receivers 恒为 0（Python 侧同）
    this.rec.emit(EventKind.MESSAGE_SENT, {
      nodeId: opts.frm,
      payload: { topic: opts.topic, mode: "broadcast", receivers: 0, ...payload },
    });
    return 0;
  }
}

/** `tools/golden/scheduler.py` 里 ScriptedLoop 的孪生实现。 */
class ScriptedLoop implements AgentLoopLike {
  readonly calls = new Map<string, number>();
  /** 每次被调时 signal 的状态，取消用例要看它。 */
  readonly signals: { nid: string; signal: AbortSignal }[] = [];

  constructor(
    private readonly scripts: Map<string, ScriptOp[]>,
    private readonly budget: Budget,
    private readonly rec: FakeRecorder,
  ) {}

  async run(
    node: NodeSpec,
    opts: {
      readonly working: WorkingSet;
      readonly deps: string[];
      readonly runId: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<NodeResultLike> {
    const n = this.calls.get(node.id) ?? 0;
    this.calls.set(node.id, n + 1);
    if (opts.signal !== undefined) this.signals.push({ nid: node.id, signal: opts.signal });
    const script = this.scripts.get(node.id) ?? [{ do: "ok", output: {} }];
    return await this.apply(script[Math.min(n, script.length - 1)]!, node, opts);
  }

  private async apply(
    op: ScriptOp,
    node: NodeSpec,
    opts: { readonly working: WorkingSet; readonly deps: string[] },
  ): Promise<NodeResultLike> {
    switch (op.do) {
      case "sleep":
        await new Promise<void>((r) => setTimeout(r, (op.s ?? 0) * 1000));
        return await this.apply(op.then!, node, opts);
      case "spend":
        this.budget.spend(op.amounts ?? {});
        return await this.apply(op.then!, node, opts);
      case "ask_human": {
        const answer = await this.rec.askHuman(node.id, op.request_id!, op.payload ?? {});
        return { output: answer };
      }
      case "count": {
        const inputs = opts.working.select(opts.deps);
        let total = 0;
        for (const v of Object.values(inputs)) {
          const rec = v as Record<string, unknown> | null;
          total += typeof rec?.["n"] === "number" ? rec["n"] : 0;
        }
        return { output: { n: total + (op.add ?? 1) }, verdicts: verdictsOf(op) };
      }
      case "ok":
        return { output: op.output, verdicts: verdictsOf(op) };
      case "raise":
        throw errorOf(op, node.id);
      default:
        throw new Error(`未知 op: ${op.do}`);
    }
  }
}

function verdictsOf(op: ScriptOp): VerdictLike[] {
  return (op.verdicts ?? []).map((v) => ({
    lens: v.lens,
    passed: v.passed,
    findings: (v.findings ?? []).map((f) => ({
      severity: f.severity ?? "low",
      code: f.code ?? "C",
    })),
  }));
}

function errorOf(op: ScriptOp, nodeId: string): unknown {
  switch (op.error) {
    case "NodeFailure":
      return new NodeFailure(nodeId, op.reason!, op.retryable ?? true);
    case "QuotaExhausted":
      return new QuotaExhausted(op.model!, op.detail!, op.status ?? 0);
    case "RuntimeError":
      // Python 的 RuntimeError 在 JS 里没有对等类；`type(x).__name__` 走的是
      // constructor.name，所以造一个同名的匿名子类，错误文本才能与 golden 一致。
      return new (class RuntimeError extends Error {})(op.msg!);
    case "ValueError":
      return new (class ValueError extends Error {})(op.msg!);
    default:
      throw new Error(`未知 error: ${String(op.error)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  用例 replay
// ══════════════════════════════════════════════════════════════════

/** golden 里那唯一一个「可执行的老式 Gate」。判据是代码不是数据（critic.Gate
 *  刻意不做表达式解析），所以两边照着同一个名字各造一个。 */
function legacyGate(name: string): Gate {
  if (name !== "review_count_gt0") throw new Error(`未知 legacy gate: ${name}`);
  return new Gate(
    "legacy",
    [["必须有评审", (m) => (m["review_count"] as number) > 0]],
    (m) =>
      // Python 是 `f"未过: {m['failed']}"` —— str(list) 会对元素走 repr
      makeGateResult({
        decision: Decision.ABORT,
        reason: `未过: [${(m["failed"] as string[]).map(pyRepr).join(", ")}]`,
      }),
  );
}

/** 一道永远走 ASK_USER 的 Gate，专测 `_enforce_gate_decision` 的人工分支。 */
function askUserGate(): Gate {
  return new Gate("ask", [["永不通过", () => false]], () =>
    makeGateResult({ decision: Decision.ASK_USER, reason: "拿不准" }),
  );
}

function buildDag(input: CaseInput): Dag {
  const dag = new Dag(input.dag_name ?? "t");
  for (const nd of input.nodes) {
    let gate: GateSpec | null = null;
    if (nd.gate !== undefined) {
      gate =
        nd.gate.legacy !== undefined
          ? // 历史上的类型分裂：NodeSpec.gate 的静态类型只有 GateSpec，运行期
            // 却可能是可执行的 Gate。scheduler 两种都接，这里照着造。
            (legacyGate(nd.gate.legacy) as unknown as GateSpec)
          : makeGateSpec({ kind: nd.gate.kind!, require: nd.gate.require ?? [] });
    }
    dag.add(
      makeNodeSpec({
        id: nd.id,
        mode: parseNodeMode(nd.mode ?? "deterministic"),
        handler: nd.handler ?? "x",
        deps: nd.deps ?? [],
        budget:
          nd.budget === undefined
            ? makeNodeBudget()
            : makeNodeBudget({ wallclockS: nd.budget.wallclock_s! }),
        gate,
        retries: nd.retries ?? 0,
      }),
    );
  }
  return dag.freeze();
}

/** 与 `tools/golden/scheduler.py` 的 `_norm` 一致：预算快照里两个随真实时间
 *  变的字段换成占位符。 */
function norm(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(norm);
  if (typeof o === "object" && o !== null) {
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) d[k] = norm(v);
    if ("remaining_ratio" in d && "spent" in d && "limits" in d) {
      d["remaining_ratio"] = "<ratio>";
      const spent = d["spent"];
      if (typeof spent === "object" && spent !== null && "wallclock_s" in spent) {
        d["spent"] = { ...(spent as Record<string, unknown>), wallclock_s: "<elapsed>" };
      }
    }
    return d;
  }
  return o;
}

interface Replayed {
  readonly outcome: GoldenOutcome;
  readonly calls: Record<string, number>;
  readonly events: GoldenEvent[];
}

async function replay(input: CaseInput): Promise<Replayed> {
  const runId = input.run_id ?? "r1";
  const journal = new InMemoryJournal();
  const blobs = new InMemoryBlobStore();

  const history = input.history ?? [];
  if (history.length > 0) {
    const seedRec = new FakeRecorder(runId, journal, blobs);
    for (const op of history) {
      if (op.op === "complete") await seedRec.completeNode(op.node, op.output);
      else if (op.op === "human") seedRec.recordHumanAnswer(op.node, op.request_id!, op.answer);
      else throw new Error(`未知 history op: ${op.op}`);
    }
  }
  const rec = new FakeRecorder(runId, journal, blobs, history.length > 0);

  const budget = new Budget(input.budget?.limits ?? {});
  if (input.budget?.prespend) budget.spend(input.budget.prespend);

  const dag = buildDag(input);
  if (input.patch === "ghost_deps") {
    // 与 Python 同一个补丁：topoOrder 换成常量（调度器开头的恢复扫描要用它，
    // 而它内部也会调 resolveDeps），resolveDeps 换成一个永远不存在的节点。
    const order = dag.topoOrder();
    const patched = dag as unknown as {
      topoOrder: () => string[];
      resolveDeps: (nid: string) => string[];
    };
    patched.topoOrder = () => [...order];
    patched.resolveDeps = () => ["GHOST"];
  }

  const scripts = new Map<string, ScriptOp[]>();
  for (const nd of input.nodes) if (nd.script !== undefined) scripts.set(nd.id, nd.script);
  const loop = new ScriptedLoop(scripts, budget, rec);

  const sched = new Scheduler(dag, loop, rec, new FakeBus(rec), budget, {
    concurrency: input.concurrency ?? 8,
  });
  const outcome = await sched.run(runId, input.seed === undefined ? {} : { seed: input.seed });

  const events: GoldenEvent[] = [];
  for (const ev of journal.read(runId)) {
    const d = eventToDict(ev);
    const payload = d.payload ?? {};
    if (d.kind === "run.started") {
      // 拓扑指纹是确定性的，但每个 case 的图形状都不同 —— golden 里放占位符，
      // 这里先钉住真实形状（16 位 hex + 整数节点数）再归一，别把校验一起抹掉。
      const fp = payload["topology_fp"];
      if (typeof fp !== "string" || !/^[0-9a-f]{16}$/.test(fp)) {
        throw new Error(`run.started 缺合法 topology_fp: ${JSON.stringify(fp)}`);
      }
      if (!Number.isInteger(payload["node_count"])) {
        throw new Error("run.started 缺整数 node_count");
      }
      payload["topology_fp"] = "<fp>";
      payload["node_count"] = "<node_count>";
    }
    events.push({
      seq: d.seq,
      kind: d.kind,
      node_id: d.node_id ?? null,
      ref: d.ref ?? null,
      payload: norm(payload) as Record<string, unknown>,
      payload_keys: Object.keys(payload),
    });
  }

  const results: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(outcome.results)) results[k] = norm(v.output);

  return {
    outcome: {
      status: outcome.status,
      ok: runOutcomeOk(outcome),
      outputs: norm(outcome.outputs) as Record<string, unknown>,
      results,
      pending_human: norm(outcome.pendingHuman) as Record<string, unknown> | null,
      error: outcome.error,
      skipped: outcome.skipped,
      budget: norm(outcome.budget) as Record<string, unknown>,
    },
    calls: Object.fromEntries([...loop.calls.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    events,
  };
}

// ══════════════════════════════════════════════════════════════════
//  测试
// ══════════════════════════════════════════════════════════════════

describe("RunStatus", () => {
  it("枚举值与 Python 一致", () => {
    expect(GOLDEN.run_status).toEqual({
      COMPLETED: RunStatus.COMPLETED,
      SUSPENDED: RunStatus.SUSPENDED,
      FAILED: RunStatus.FAILED,
    });
  });

  it("未知值抛错而不是静默通过", () => {
    expect(parseRunStatus("failed")).toBe(RunStatus.FAILED);
    expect(() => parseRunStatus("done")).toThrow(/未知的 RunStatus: 'done'/);
  });
});

describe("metricsFromVerdicts", () => {
  it("与 Python 的 metrics_from 逐字段一致（golden fixture）", () => {
    expect(metricsFromVerdicts([])).toEqual(GOLDEN.metric_fixtures["empty"]);
    expect(metricsFromVerdicts([{ lens: "schema", passed: true, findings: [] }])).toEqual(
      GOLDEN.metric_fixtures["one_pass"],
    );
    expect(
      metricsFromVerdicts([
        { lens: "schema", passed: true, findings: [] },
        {
          lens: "provenance",
          passed: false,
          findings: [
            { severity: "high", code: "EVIDENCE_MISSING" },
            { severity: "low", code: "NAMING" },
          ],
        },
      ]),
    ).toEqual(GOLDEN.metric_fixtures["mixed"]);
  });

  it("空 panel 是「未评审」而不是无病呻吟地通过", () => {
    // 这条判据被 golden 的 empty fixture 钉着，单独写出来是因为它是 gate
    // 语义的地基：all_passed 若对空 panel 为 true，一道 `all_passed == true`
    // 的门会给根本没跑过 critic 的节点放行。
    expect(GOLDEN.metric_fixtures["empty"]!["all_passed"]).toBe(false);
    expect(metricsFromVerdicts([])["all_passed"]).toBe(false);
  });
});

describe("与已落地模块的接缝", () => {
  it("metricsFromVerdicts 与 critic.metricsFrom 结果相同（松/严口径两份实现不许漂）", () => {
    // scheduler 的那份收的是松口径 verdict（loop.NodeResult 的类型里没有
    // severity）。算法必须与 critic 的那份完全一致 —— 这条用例就是防漂的闸。
    const cases: Verdict[][] = [
      [],
      [{ lens: "schema", passed: true, findings: [], note: "" }],
      [
        { lens: "schema", passed: true, findings: [], note: "" },
        {
          lens: "provenance",
          passed: false,
          note: "",
          findings: [
            {
              severity: "high",
              code: "EVIDENCE_MISSING",
              target: "t",
              claim: "c",
              evidenceChecked: [],
              proposedFix: null,
              verifier: "",
            },
            {
              severity: "low",
              code: "NAMING",
              target: "t",
              claim: "c",
              evidenceChecked: [],
              proposedFix: null,
              verifier: "",
            },
          ],
        },
      ],
    ];
    for (const verdicts of cases) {
      expect(metricsFromVerdicts(verdicts as readonly VerdictLike[])).toEqual(
        metricsFrom(verdicts),
      );
    }
  });

  it("真的 Recorder / AgentLoop / AgentBus 结构上满足 port（接线时不需要 cast）", async () => {
    // 编译期断言为主：只要类型对不上，tsc 就红。运行期这里只做一个占位断言。
    const { Recorder } = await import("../src/kernel/recorder.js");
    const { AgentLoop } = await import("../src/kernel/loop.js");
    const { AgentBus } = await import("../src/kernel/bus/bus.js");
    type _R = InstanceType<typeof Recorder> extends RecorderLike ? true : never;
    type _L = InstanceType<typeof AgentLoop> extends AgentLoopLike ? true : never;
    type _B = InstanceType<typeof AgentBus> extends BusLike ? true : never;
    const ok: [_R, _L, _B] = [true, true, true];
    expect(ok).toEqual([true, true, true]);
  });
});

describe("GateSpec 断言小语言", () => {
  for (const req of GOLDEN.requirements) {
    it(`${req.fixture}: ${JSON.stringify(req.expr)}`, () => {
      const metrics = GOLDEN.metric_fixtures[req.fixture]!;
      if (req.error === undefined) {
        expect(requirementPasses(req.expr, metrics)).toBe(req.result);
      } else {
        let caught: unknown = null;
        try {
          requirementPasses(req.expr, metrics);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(NodeFailure);
        expect((caught as NodeFailure).message).toBe(req.error);
        expect((caught as NodeFailure).retryable).toBe(req.retryable);
      }
    });
  }

  it("已知分叉：Unicode 数字在 Python 能过，这里抛错", () => {
    for (const div of GOLDEN.known_divergences) {
      expect(div.result).toBe(true); // Python 侧：正则 \d 是 Unicode 的，int() 也认
      expect(() => requirementPasses(div.expr, GOLDEN.metric_fixtures[div.fixture]!)).toThrow(
        NodeFailure,
      );
    }
  });

  it("nodeId 会进错误消息（默认 'gate'）", () => {
    expect(() => requirementPasses("nope == 1", {}, "EXTRACT#3")).toThrow(
      "[EXTRACT#3] gate require 引用未知指标: 'nope'",
    );
  });

  it("不看原型链上的键 —— toString 不是指标", () => {
    // JS 的 `"toString" in obj` 是 true，Python 的 `in dict` 不是。用 `in`
    // 实现的话，这条表达式会拿到一个函数再去比较。
    expect(() => requirementPasses("toString == 1", { review_count: 0 })).toThrow(
      /引用未知指标: 'toString'/,
    );
  });
});

/**
 * 这条用例里两个节点在**同一批**结束，而 Python 的 `asyncio.wait` 返回的是
 * `set`，迭代顺序跟对象哈希（内存地址）走 —— 也就是说 Python 侧的处理顺序本身
 * 就没有定义（往 CASES 里插一条无关用例都可能把它翻过来）。所以对它只比多重
 * 集合，TS 自己那份确定的顺序另有一条用例单独断言。
 */
const ORDER_UNSPECIFIED_IN_PYTHON = new Set(["same_batch_completions_have_no_defined_order"]);

const eventKey = (e: GoldenEvent): string =>
  JSON.stringify([e.kind, e.node_id, e.ref, e.payload, e.payload_keys]);

describe("scheduler（golden 程序 replay）", () => {
  for (const c of GOLDEN.cases) {
    it(c.name, async () => {
      const got = await replay(c.input);
      expect(got.outcome).toEqual(c.outcome);
      expect(got.calls).toEqual(c.calls);
      if (ORDER_UNSPECIFIED_IN_PYTHON.has(c.name)) {
        expect(got.events.map(eventKey).sort()).toEqual(c.events.map(eventKey).sort());
        return;
      }
      expect(got.events.map((e) => ({ ...e, payload_keys: undefined }))).toEqual(
        c.events.map((e) => ({ ...e, payload_keys: undefined })),
      );
      // 键序单独比：toEqual 不看顺序，而 DEGRADED 的 payload 是
      // `{"level":…, "label":…, **snapshot}`，顺序本身就是被移植的行为
      expect(got.events.map((e) => e.payload_keys)).toEqual(c.events.map((e) => e.payload_keys));
    });
  }

  it("同批结束的节点，TS 侧按真实结束顺序处理（Python 那边是 set，没定义）", async () => {
    const c = GOLDEN.cases.find((x) => ORDER_UNSPECIFIED_IN_PYTHON.has(x.name))!;
    // 跑三遍：确定性本身才是这条用例要断言的东西
    for (let i = 0; i < 3; i += 1) {
      const got = await replay(c.input);
      expect(got.events.filter((e) => e.kind === "node.completed").map((e) => e.node_id)).toEqual([
        "A",
        "B",
        "C",
      ]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  TS 侧特有的用例（golden 比不出来的部分）
// ══════════════════════════════════════════════════════════════════

/** 起一个最小可用的 Scheduler，供下面几条 TS 专属用例使用。 */
function harness(
  nodes: NodeSpec[],
  loop: AgentLoopLike,
  opts: { concurrency?: number; budget?: Budget } = {},
): { sched: Scheduler; rec: FakeRecorder; journal: InMemoryJournal; bus: FakeBus } {
  const journal = new InMemoryJournal();
  const rec = new FakeRecorder("r1", journal, new InMemoryBlobStore());
  const bus = new FakeBus(rec);
  const budget = opts.budget ?? new Budget();
  const dag = new Dag("t");
  for (const n of nodes) dag.add(n);
  dag.freeze();
  const sched = new Scheduler(dag, loop, rec, bus, budget, {
    concurrency: opts.concurrency ?? 8,
  });
  return { sched, rec, journal, bus };
}

function node(id: string, deps: string[] = [], extra: Partial<NodeSpec> = {}): NodeSpec {
  return makeNodeSpec({
    id,
    mode: parseNodeMode("deterministic"),
    handler: "x",
    deps,
    ...extra,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("冻结是安全边界", () => {
  it("没冻结的 DAG 直接拒收", () => {
    const journal = new InMemoryJournal();
    const rec = new FakeRecorder("r1", journal, new InMemoryBlobStore());
    const dag = new Dag("t").add(node("A"));
    expect(
      () => new Scheduler(dag, null as unknown as AgentLoopLike, rec, new FakeBus(rec), new Budget()),
    ).toThrow(/冻结是安全边界/);
  });
});

describe("并发", () => {
  it("同层无依赖的节点并发跑", async () => {
    let concurrent = 0;
    let peak = 0;
    const loop: AgentLoopLike = {
      async run() {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(20);
        concurrent -= 1;
        return { output: { n: 1 } };
      },
    };
    const nodes = [node("A"), ...[0, 1, 2, 3].map((i) => node(`B${i}`, ["A"]))];
    const { sched } = harness(nodes, loop);
    await sched.run("r1");
    expect(peak).toBeGreaterThanOrEqual(3);
  });

  it("concurrency 是硬上限（信号量真的在限流）", async () => {
    let concurrent = 0;
    let peak = 0;
    const loop: AgentLoopLike = {
      async run() {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(10);
        concurrent -= 1;
        return { output: { n: 1 } };
      },
    };
    const nodes = Array.from({ length: 9 }, (_, i) => node(`N${i}`));
    const { sched } = harness(nodes, loop, { concurrency: 3 });
    const out = await sched.run("r1");
    expect(runOutcomeOk(out)).toBe(true);
    expect(peak).toBe(3);
  });
});

describe("取消：Node 上没有真正的任务取消（CONTRACT §2.2）", () => {
  it("Run 定案后，还在跑的节点产出一律不采纳，也绝不记成已完成", async () => {
    let slowFinished = false;
    const loop: AgentLoopLike = {
      async run(spec) {
        if (spec.id === "FAST") throw new NodeFailure("FAST", "炸了", false);
        await sleep(40);
        slowFinished = true;
        return { output: { n: 99 } };
      },
    };
    const { sched, journal } = harness([node("FAST"), node("SLOW")], loop);

    const out = await sched.run("r1");
    expect(out.status).toBe(RunStatus.FAILED);

    // 关键：等到 SLOW 真的跑完之后再看一遍
    await sleep(80);
    expect(slowFinished).toBe(true);
    expect(out.outputs["SLOW"]).toBeUndefined();
    expect(out.results["SLOW"]).toBeUndefined();
    const kinds = [...journal.read("r1")].map((e) => `${e.kind}:${e.nodeId ?? ""}`);
    // NODE_COMPLETED 是崩溃恢复的判据。一个属于已失败 Run 的节点若被记成
    // 已完成，下次 resume 会直接跳过它并把没人审过的产出当成事实。
    expect(kinds).not.toContain("node.completed:SLOW");
  });

  it("被放弃的节点抛错不会变成 unhandledRejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      seen.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const loop: AgentLoopLike = {
        async run(spec) {
          if (spec.id === "FAST") throw new NodeFailure("FAST", "炸了", false);
          await sleep(20);
          throw new Error("我在没人接的时候炸了");
        },
      };
      const { sched } = harness([node("FAST"), node("SLOW")], loop);
      await sched.run("r1");
      await sleep(60); // 等 SLOW 抛出来
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  it("软承诺：定案时给每个在飞节点 abort（听不听由它们）", async () => {
    const signals: AbortSignal[] = [];
    const loop: AgentLoopLike = {
      async run(spec, opts) {
        if (opts.signal !== undefined) signals.push(opts.signal);
        if (spec.id === "FAST") throw new NodeFailure("FAST", "炸了", false);
        await sleep(40);
        return { output: {} };
      },
    };
    const { sched } = harness([node("FAST"), node("SLOW")], loop);
    await sched.run("r1");
    expect(signals.length).toBe(2);
    expect(signals.some((s) => s.aborted)).toBe(true);
  });

  it("还在信号量里排队的节点被放弃后不再开跑（这是取消唯一真能省下钱的地方）", async () => {
    const started: string[] = [];
    const loop: AgentLoopLike = {
      async run(spec) {
        started.push(spec.id);
        if (spec.id === "A") {
          await sleep(10);
          throw new NodeFailure("A", "炸了", false);
        }
        await sleep(50);
        return { output: {} };
      },
    };
    // concurrency=1：A 拿到 permit，B/C 在队列里排队；A 失败 → Run 定案
    const { sched } = harness([node("A"), node("B"), node("C")], loop, { concurrency: 1 });
    const out = await sched.run("r1");
    expect(out.status).toBe(RunStatus.FAILED);
    await sleep(120);

    // **B 关不掉**：permit 是在 A 自己的 finally 里交出去的，比调度器观察到
    // A 失败早整整一个微任务 —— 那一刻 Run 还没定案，signal 还没 abort。
    // C 才是这个检查真正救下的那个：B 结束时 Run 已定案，permit 传到 C 手上时
    // 它看到 aborted，于是连 loop.run 都不调（省下一整次模型调用的钱）。
    // 想把 B 也关掉就只能给信号量的交接加人为延迟 —— 那是在用时序魔法伪装成
    // 取消，正是 CONTRACT §2.2 说的「不假装有」。
    expect(started).toEqual(["A", "B"]);
  });

  // ── 节点墙钟不含排队 ───────────────────────────────────────────
  //
  // 真实事故：219 个 EXTRACT 段无依赖、一次性全部入队，concurrency 4，单段实测
  // 66~120s。墙钟原来定在 acquire **之前**，于是 219 个节点的 420s 倒计时在 t=0
  // 同时启动 —— 第 12 个之后的节点拿到 permit 时配额已经烧光。失败的那个在
  // t=376.2s 才进场，只跑了 44 秒、只发出 1 次模型调用，就被判「超过节点墙钟上限」。
  //
  // 它不慢，它只是排在后面。整份 DAG 的时间上界由 Run 级 runDeadline 兜着，
  // 节点级墙钟管的是「单个节点别卡死」，不该变成队列位置抽签。
  it("**节点墙钟从拿到 permit 起算，排队时间不算在节点头上**", async () => {
    const ran: string[] = [];
    const loop: AgentLoopLike = {
      async run(spec) {
        ran.push(spec.id);
        await sleep(30);
        return { output: {} };
      },
    };
    // concurrency=1，每个节点墙钟 60ms、各跑 30ms。
    // 排队算进去的话：B 等 30ms + 跑 30ms 刚好卡线，C 等 60ms 直接必死。
    // 不算排队的话：三个都从各自开跑起算，都只用 30ms，全过。
    const short = { budget: makeNodeBudget({ wallclockS: 0.06 }) };
    const { sched } = harness(
      [node("A", [], short), node("B", [], short), node("C", [], short)],
      loop,
      { concurrency: 1 },
    );
    const out = await sched.run("r1");
    expect(ran.sort()).toEqual(["A", "B", "C"]);
    expect(out.status).toBe(RunStatus.COMPLETED);
  });
});

describe("降级广播", () => {
  it("bus.broadcast 收到的是 scheduler / budget/degrade / level+label", async () => {
    const budget = new Budget({ tokens: 1000 });
    budget.spend({ tokens: 900 });
    const loop: AgentLoopLike = { run: async () => ({ output: { n: 1 } }) };
    const { sched, bus } = harness([node("A")], loop, { budget });
    await sched.run("r1");
    expect(bus.sent).toEqual([
      {
        frm: "scheduler",
        topic: "budget/degrade",
        payload: { level: 3, label: "仅规则评审（产物标记未经语义审核）" },
      },
    ]);
  });

  it("只在级别**上升**时播一次", async () => {
    const budget = new Budget({ tokens: 1000 });
    budget.spend({ tokens: 900 });
    const loop: AgentLoopLike = { run: async () => ({ output: { n: 1 } }) };
    const { sched, bus } = harness([node("A"), node("B", ["A"]), node("C", ["B"])], loop, {
      budget,
    });
    await sched.run("r1");
    expect(bus.sent.length).toBe(1);
  });
});

describe("gate 的边角", () => {
  it("未知 gate kind 直接判死（不可重试）", async () => {
    const loop: AgentLoopLike = { run: async () => ({ output: {} }) };
    const { sched } = harness(
      [node("A", [], { gate: makeGateSpec({ kind: "MAYBE" }), retries: 3 })],
      loop,
    );
    const out = await sched.run("r1");
    expect(out.status).toBe(RunStatus.FAILED);
    expect(out.error).toBe("[A] NodeFailure: [A] 未知 gate kind: 'MAYBE'");
  });

  it("kind 会先 strip + lower（'  AUTO '也认）", async () => {
    const loop: AgentLoopLike = { run: async () => ({ output: {} }) };
    const { sched } = harness(
      [node("A", [], { gate: makeGateSpec({ kind: "  AUTO" }), retries: 0 })],
      loop,
    );
    const out = await sched.run("r1");
    expect(runOutcomeOk(out)).toBe(true);
  });

  it("不支持的 gate 配置按类型名报错", async () => {
    const loop: AgentLoopLike = { run: async () => ({ output: {} }) };
    const { sched } = harness(
      [node("A", [], { gate: "auto" as unknown as GateSpec, retries: 0 })],
      loop,
    );
    const out = await sched.run("r1");
    expect(out.error).toBe("[A] NodeFailure: [A] 不支持的 gate 配置: str");
  });

  it("ASK_USER：人答 pass 就放行，答别的按 revise/abort 定 retryable", async () => {
    const gate = askUserGate();
    const loop: AgentLoopLike = { run: async () => ({ output: { n: 1 } }) };

    for (const [answer, expected] of [
      ["pass", RunStatus.COMPLETED],
      ["approve", RunStatus.COMPLETED],
      ["revise", RunStatus.FAILED],
      ["abort", RunStatus.FAILED],
      ["", RunStatus.FAILED],
    ] as const) {
      const { sched, rec } = harness(
        [node("A", [], { gate: gate as unknown as GateSpec, retries: 0 })],
        loop,
      );
      rec.recordHumanAnswer("A", "A:gate", { decision: answer });
      const out = await sched.run("r1");
      expect(out.status, `answer=${answer}`).toBe(expected);
      if (expected === RunStatus.FAILED) {
        expect(out.error).toBe(`[A] NodeFailure: [A] 质量门「ask」人工决策: ${answer || "无效"}`);
      }
    }
  });

  it("ASK_USER + revise 是可重试的（用满 retries 才定案）", async () => {
    const gate = askUserGate();
    let calls = 0;
    const loop: AgentLoopLike = {
      run: async () => {
        calls += 1;
        return { output: { n: 1 } };
      },
    };
    const { sched, rec } = harness(
      [node("A", [], { gate: gate as unknown as GateSpec, retries: 2 })],
      loop,
    );
    rec.recordHumanAnswer("A", "A:gate", { decision: "revise" });
    await sched.run("r1");
    expect(calls).toBe(3);
  });
});

describe("HumanInputRequired 是挂起信号，不是失败", () => {
  it("从 loop 里直接抛出来也一样挂起（不进重试、不算节点失败）", async () => {
    let calls = 0;
    const loop: AgentLoopLike = {
      run: async (spec) => {
        calls += 1;
        throw new HumanInputRequired(spec.id, `${spec.id}:hitl`, { q: ["要几个口径？"] });
      },
    };
    const { sched, journal } = harness([node("A", [], { retries: 5 })], loop);
    const out = await sched.run("r1");
    expect(out.status).toBe(RunStatus.SUSPENDED);
    expect(calls).toBe(1); // 挂起不是失败，一次都不该重试
    expect(out.pendingHuman).toEqual({ node: "A", request_id: "A:hitl", q: ["要几个口径？"] });
    expect([...journal.read("r1")].some((e) => e.kind === EventKind.NODE_FAILED)).toBe(false);
  });
});

describe("BudgetExhausted 的重试纪律（与 isQuota 同构）", () => {
  it("预算耗尽一次都不重试 —— 额度不会因为重跑就长回来", async () => {
    let calls = 0;
    const loop: AgentLoopLike = {
      run: async () => {
        calls += 1;
        throw new BudgetExhausted("tokens", 100, 120);
      },
    };
    const { sched } = harness([node("A", [], { retries: 5 })], loop);
    const out = await sched.run("r1");
    expect(out.status).toBe(RunStatus.FAILED);
    // 走 else 兜底会烧满 retries+1 次。扇出型节点（EXTRACT 219 段）每白跑一次
    // 都是整段节点执行 —— 用户为一个必然失败的结果多等好几分钟。
    expect(calls).toBe(1);
    expect(String(out.error)).toContain("预算耗尽");
  });
});

describe("外部停止信号（/stop 案发：报了已停止，DAG 照跑）", () => {
  it("跑到一半 abort → 立刻定案 FAILED，不派新节点、在飞产出不采纳", async () => {
    const controller = new AbortController();
    let started = 0;
    const loop: AgentLoopLike = {
      async run(spec) {
        started += 1;
        if (spec.id === "A") {
          // 第一个节点跑到一半时外部喊停
          setTimeout(() => controller.abort(), 10);
          await sleep(60);
        }
        return { output: { n: 1 } };
      },
    };
    const nodes = [node("A"), node("B", ["A"]), node("C", ["A"])];
    const { sched } = harness(nodes, loop, { concurrency: 1 });
    const out = await sched.run("r1", { signal: controller.signal });
    expect(out.status).toBe(RunStatus.FAILED);
    expect(String(out.error)).toContain("外部停止");
    expect(started).toBe(1);           // B、C 从未被派出去
    expect(out.outputs["A"]).toBeUndefined(); // 在飞产出不采纳
  });

  it("进门前就已 abort → 一个节点都不跑", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    const loop: AgentLoopLike = {
      async run() {
        started += 1;
        return { output: {} };
      },
    };
    const { sched } = harness([node("A")], loop);
    const out = await sched.run("r1", { signal: controller.signal });
    expect(out.status).toBe(RunStatus.FAILED);
    expect(started).toBe(0);
  });

  it("不传 signal 时行为原样（回归保护）", async () => {
    const loop: AgentLoopLike = { async run() { return { output: { n: 1 } }; } };
    const { sched } = harness([node("A"), node("B", ["A"])], loop);
    const out = await sched.run("r1");
    expect(runOutcomeOk(out)).toBe(true);
  });
});
