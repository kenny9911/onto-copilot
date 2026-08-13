/**
 * Critic / Gate —— 产物出门前那道关。
 *
 * 期望值一律来自 golden/critic.json（Python 真跑出来的 verdict / metrics / 决策
 * / 事件），手写的只有三类 Python 侧不存在的风险：
 *
 *   1. **多数票阈值的方向**：`len(votes)/2` 必须是真除。golden 的四条投票用例
 *      从两个方向钉住了它，这里再补一条"floor 与真除在整数上恒等"的证明性用例 ——
 *      免得下一个人看到 `n > votes.length / 2` 觉得该改成 floor（或者反过来，
 *      以为改成 floor 会出事而不敢动结论）。
 *   2. **Python 真值性**：空 dict 是假票。JS 里 `{}` 是真值，照抄 `if (r.data)`
 *      会把一批空回复变成全票通过。
 *   3. **视角表用 Map 而不是普通对象**：`"constructor" in obj` 恒为真，
 *      普通对象会让一个叫 constructor 的视角名骗过未注册检查。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NodeFailure } from "../src/kernel/errors.js";
import { EventKind } from "../src/kernel/events.js";
import { sha256Hex } from "../src/kernel/ids.js";
import {
  Critic,
  CriticPanel,
  Decision,
  Gate,
  LLMCritic,
  LLM_CRITIC_SCHEMA,
  RuleCritic,
  Severity,
  findingToDict,
  makeCriticContext,
  makeFinding,
  makeGateResult,
  makeVerdict,
  metricsFrom,
  parseDecision,
  parseSeverity,
  verdictToDict,
  type EventSink,
  type Finding,
  type GateResult,
  type JudgeGateway,
  type JudgeResult,
  type Requirement,
  type Verdict,
} from "../src/kernel/critic.js";

// ══════════════════════════════════════════════════════════════════
//  golden
// ══════════════════════════════════════════════════════════════════
type Dict = Record<string, unknown>;

interface Golden {
  readonly severity: string[];
  readonly decision: string[];
  readonly defaults: {
    finding: Dict;
    verdict: Dict;
    gate_result: Dict;
    critic_context: Dict;
  };
  readonly schema: Dict;
  readonly prompt: {
    why: string;
    name: string;
    rubric: string[];
    instruction: string;
    evidence_render: unknown;
    draft: unknown;
    len: number;
    sha256: string;
    prompt?: string;
  }[];
  readonly rule_critic: { why: string; name: string; findings: Dict[]; verdict: Dict; needs_llm: boolean }[];
  readonly vote: {
    why: string;
    rubric: string[];
    votes: unknown[];
    verdict: Dict;
    gateway_calls: { salt: number; key: string }[];
  }[];
  readonly metrics: { why: string; verdicts: Dict[]; metrics: Dict }[];
  readonly gate: {
    why: string;
    gate: string;
    require: [string, string][];
    on_fail: string;
    verdicts: Dict[];
    extra: Dict;
    metrics: Dict;
    result: Dict;
    events: Dict[];
  }[];
  readonly panel: {
    why: string;
    critics: { name: string; type: string; findings?: Dict[]; rubric?: string[] }[];
    lenses: string[];
    allow_llm: boolean;
    verdicts?: Dict[];
    error?: Dict;
    events: Dict[];
  }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/critic.json"), "utf8"),
) as Golden;

/** `{"__repeat__": [ch, n]}` → 长串。长串不进 golden，只存生成式。 */
function materialize(spec: unknown): unknown {
  if (typeof spec === "object" && spec !== null && "__repeat__" in spec) {
    const [ch, n] = (spec as { __repeat__: [string, number] }).__repeat__;
    return ch.repeat(n);
  }
  if (Array.isArray(spec)) return spec.map(materialize);
  if (typeof spec === "object" && spec !== null) {
    return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, materialize(v)]));
  }
  return spec;
}

function findingFrom(spec: Dict): Finding {
  return makeFinding({
    severity: parseSeverity(spec["severity"]),
    code: spec["code"] as string,
    target: spec["target"] as string,
    claim: spec["claim"] as string,
    ...(spec["evidence_checked"] === undefined
      ? {}
      : { evidenceChecked: spec["evidence_checked"] as string[] }),
    ...(spec["proposed_fix"] === undefined
      ? {}
      : { proposedFix: spec["proposed_fix"] as Dict | null }),
    ...(spec["verifier"] === undefined ? {} : { verifier: spec["verifier"] as string }),
  });
}

function verdictFrom(spec: Dict): Verdict {
  return makeVerdict({
    lens: spec["lens"] as string,
    passed: spec["passed"] as boolean,
    ...(spec["findings"] === undefined
      ? {}
      : { findings: (spec["findings"] as Dict[]).map(findingFrom) }),
    ...(spec["note"] === undefined ? {} : { note: spec["note"] as string }),
  });
}

/** 只需要 emit 的记录器（Python 侧测试里也是这么个两行的桩）。 */
class StubRec implements EventSink {
  readonly events: Dict[] = [];

  emit(kind: EventKind, opts: { nodeId?: string | null; payload?: Dict }): void {
    this.events.push({
      kind,
      node_id: opts.nodeId ?? null,
      payload: opts.payload ?? {},
    });
  }
}

// ══════════════════════════════════════════════════════════════════
describe("枚举与默认值", () => {
  it("Severity / Decision 的取值与顺序", () => {
    expect(Object.values(Severity)).toEqual(G.severity);
    expect(Object.values(Decision)).toEqual(G.decision);
  });

  it("未知取值抛错而不是静默放行", () => {
    expect(() => parseSeverity("nope")).toThrow();
    expect(() => parseSeverity(1)).toThrow();
    expect(() => parseDecision("nope")).toThrow();
    expect(parseSeverity("high")).toBe(Severity.HIGH);
    expect(parseDecision("round_trip")).toBe(Decision.ROUND_TRIP);
  });

  it("dataclass 默认值", () => {
    expect(
      findingToDict(
        makeFinding({ severity: Severity.LOW, code: "C", target: "T", claim: "claim" }),
      ),
    ).toEqual(G.defaults.finding);
    expect(verdictToDict(makeVerdict({ lens: "lens", passed: true }))).toEqual(G.defaults.verdict);
    const gr = makeGateResult({ decision: Decision.PASS, reason: "r" });
    expect({ decision: gr.decision, reason: gr.reason, detail: gr.detail }).toEqual(
      G.defaults.gate_result,
    );
    const ctx = makeCriticContext({ nodeId: "N" });
    expect({
      evidence_render: ctx.evidenceRender,
      facts: ctx.facts,
      rules: ctx.rules,
      samples: ctx.samples,
    }).toEqual(G.defaults.critic_context);
  });

  it("findings 数组不共享调用方的引用", () => {
    const shared: Finding[] = [];
    const v = makeVerdict({ lens: "a", passed: true, findings: shared });
    shared.push(makeFinding({ severity: Severity.HIGH, code: "X", target: "t", claim: "c" }));
    expect(v.findings).toHaveLength(0);
  });
});

describe("LLMCritic 的 schema 与 prompt", () => {
  it("下发的 JSON Schema 逐字节一致", () => {
    expect(LLM_CRITIC_SCHEMA).toEqual(G.schema);
  });

  for (const g of G.prompt) {
    it(`prompt: ${g.why}`, () => {
      const c = new LLMCritic(g.name, g.rubric, { instruction: g.instruction });
      let text = c.prompt(materialize(g.draft));
      const ev = materialize(g.evidence_render) as string;
      // 证据那一段是 judge() 里追加的，这里照它的写法拼一遍
      if (ev !== "") text += `\n\n## 可核对的证据\n${[...ev].slice(0, 20000).join("")}`;
      if (g.prompt !== undefined) expect(text).toBe(g.prompt);
      expect([...text].length).toBe(g.len);
      expect(sha256Hex(text)).toBe(g.sha256);
    });
  }
});

describe("RuleCritic", () => {
  for (const g of G.rule_critic) {
    it(g.why, async () => {
      const findings = g.findings.map(findingFrom);
      const c = new RuleCritic(g.name, () => findings);
      expect(c.needsLlm).toBe(g.needs_llm);
      const v = await c.judge({ any: "draft" }, makeCriticContext({ nodeId: "N" }));
      expect(verdictToDict(v)).toEqual(g.verdict);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  多数票
// ══════════════════════════════════════════════════════════════════
class StubGateway implements JudgeGateway {
  readonly seen: { salt: number; key: string }[] = [];

  constructor(private readonly votes: readonly unknown[]) {}

  judge(
    _nodeId: string,
    _prompt: string,
    opts: { salt?: number; key?: string },
  ): Promise<JudgeResult> {
    const salt = opts.salt ?? 0;
    this.seen.push({ salt, key: opts.key ?? "" });
    return Promise.resolve({ data: this.votes[salt] });
  }
}

describe("多数票聚合", () => {
  for (const g of G.vote) {
    it(g.why, async () => {
      const gw = new StubGateway(g.votes);
      const c = new LLMCritic("semantic", g.rubric);
      const v = await c.judge(
        { d: 1 },
        makeCriticContext({ nodeId: "N", gateway: gw, samples: g.votes.length }),
      );
      expect(verdictToDict(v)).toEqual(g.verdict);
      expect(gw.seen).toEqual(g.gateway_calls);
    });
  }

  it("阈值写成 floor 会怎样：整数上恒等，所以这里改不改都不炸 —— 但仍然写真除", () => {
    // 结论钉在这里，省得下一个人重新推一遍：n 与 L 都是整数时
    // `n > L/2` ⟺ `n > floor(L/2)`（L 偶数时 floor 不改值；L 奇数时两边都
    // 等价于 n ≥ (L+1)/2）。真正会咬人的是**票带权重**的那天，那时 floor 会
    // 当场把阈值判错 —— 所以按 Python 原样写真除。
    for (let L = 1; L <= 9; L += 1) {
      for (let n = 0; n <= L; n += 1) {
        expect(n > L / 2).toBe(n > Math.floor(L / 2));
      }
    }
    // 而"单票时阈值是 0.5"这条本身是硬要求：一票否决必须生效。
    expect(1 > 1 / 2).toBe(true);
  });

  it("空 dict 是假票（Python 真值性），不是全票通过", async () => {
    // 这一条是 JS 与 Python 分叉最要命的地方：照抄 `if (r.data)` 的话，
    // 两个空回复会被当成两张有效票，checks 为空 → 一条都没失败 → passed=true，
    // 而且是静默通过。golden 的 vote 用例已经钉住了它，这里留一条独立的断言，
    // 免得有人重构时把 pyTruthy 换成 Boolean()。
    const c = new LLMCritic("semantic", ["口径一致"]);
    const v = await c.judge(
      {},
      makeCriticContext({ nodeId: "N", gateway: new StubGateway([{}, {}]), samples: 2 }),
    );
    expect(v.passed).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(["CRITIC_FAILED"]);
  });

  it("没有 gateway 就用 LLMCritic：报错而不是当成通过", async () => {
    const c = new LLMCritic("semantic", ["口径一致"]);
    await expect(c.judge({}, makeCriticContext({ nodeId: "N" }))).rejects.toThrow(/gateway/);
  });

  it("评委返回的形状不对：报错而不是当成空", async () => {
    const c = new LLMCritic("semantic", ["口径一致"]);
    await expect(
      c.judge({}, makeCriticContext({ nodeId: "N", gateway: new StubGateway(["不是对象"]) })),
    ).rejects.toThrow(TypeError);
  });
});

// ══════════════════════════════════════════════════════════════════
describe("metrics_from", () => {
  for (const g of G.metrics) {
    it(g.why, () => {
      expect(metricsFrom(g.verdicts.map(verdictFrom))).toEqual(g.metrics);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  Gate
// ══════════════════════════════════════════════════════════════════
const PREDICATES: Record<string, (m: Dict) => boolean> = {
  no_high: (m) => m["high_findings"] === 0,
  all_passed: (m) => m["all_passed"] === true,
  completeness_95: (m) => ((m["completeness"] as number | undefined) ?? 0) >= 0.95,
  always_false: () => false,
};

const ON_FAIL: Record<string, (m: Dict) => GateResult> = {
  abort: (m) =>
    makeGateResult({
      decision: Decision.ABORT,
      reason: "未过：" + (m["failed"] as string[]).join("、"),
    }),
  route_by_completeness: (m) =>
    makeGateResult({
      decision:
        ((m["completeness"] as number | undefined) ?? 0) < 0.95
          ? Decision.ROUND_TRIP
          : Decision.ASK_USER,
      reason: "未过：" + (m["failed"] as string[]).join("、"),
      detail: { failed: [...(m["failed"] as string[])] },
    }),
};

describe("Gate", () => {
  for (const g of G.gate) {
    it(g.why, () => {
      const require: Requirement[] = g.require.map(([label, p]) => [label, PREDICATES[p]!]);
      const gate = new Gate(g.gate, require, ON_FAIL[g.on_fail]!);
      const metrics: Dict = { ...metricsFrom(g.verdicts.map(verdictFrom)), ...g.extra };
      expect(metrics).toEqual(g.metrics);
      const rec = new StubRec();
      const r = gate.evaluate(metrics, rec, "GATE");
      expect({ decision: r.decision, reason: r.reason, detail: r.detail }).toEqual(g.result);
      expect(rec.events).toEqual(g.events);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  Panel
// ══════════════════════════════════════════════════════════════════
function buildCritic(spec: { name: string; type: string; findings?: Dict[]; rubric?: string[] }): Critic {
  if (spec.type === "rule") {
    const findings = (spec.findings ?? []).map(findingFrom);
    return new RuleCritic(spec.name, () => findings);
  }
  return new LLMCritic(spec.name, spec.rubric ?? []);
}

describe("CriticPanel", () => {
  for (const g of G.panel) {
    it(g.why, async () => {
      const rec = new StubRec();
      const critics = Object.fromEntries(g.critics.map((c) => [c.name, buildCritic(c)]));
      const panel = new CriticPanel(critics, rec);
      const ctx = makeCriticContext({ nodeId: "N" });
      if (g.error !== undefined) {
        const err = await panel
          .judge({ draft: 1 }, g.lenses, ctx, { allowLlm: g.allow_llm })
          .then(() => null)
          .catch((e: unknown) => e as NodeFailure);
        expect(err).toBeInstanceOf(NodeFailure);
        expect({
          type: err!.constructor.name,
          message: err!.message,
          node_id: err!.nodeId,
          retryable: err!.retryable,
        }).toEqual(g.error);
      } else {
        const verdicts = await panel.judge({ draft: 1 }, g.lenses, ctx, {
          allowLlm: g.allow_llm,
        });
        expect(verdicts.map(verdictToDict)).toEqual(g.verdicts);
      }
      expect(rec.events).toEqual(g.events);
    });
  }

  it("视角表用 Map：叫 constructor 的视角骗不过未注册检查", () => {
    // 普通对象上 `"constructor" in obj` 恒为真，`obj["constructor"]` 拿到的是
    // Object 构造器 —— 于是一个拼错成 constructor / toString 的视角名会通过
    // validate，然后在 judge 里以完全看不懂的方式炸掉。Python 的 dict 没这毛病，
    // 所以这条没有 golden 可抄。
    const panel = new CriticPanel({ schema: new RuleCritic("schema", () => []) }, new StubRec());
    expect(() => {
      panel.validate(["constructor"], "N");
    }).toThrow(NodeFailure);
    expect(() => {
      panel.validate(["toString"], "N");
    }).toThrow(/未注册的 critic: toString/);
  });

  it("构造时接受 Map，且拷一份（之后改原表不影响已建的 panel）", () => {
    const src = new Map<string, Critic>([["schema", new RuleCritic("schema", () => [])]]);
    const panel = new CriticPanel(src, new StubRec());
    src.delete("schema");
    expect(() => {
      panel.validate(["schema"], "N");
    }).not.toThrow();
  });
});
