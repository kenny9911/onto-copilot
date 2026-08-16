/**
 * Critic 与 Gate —— 产物出门前的最后一道关。移植自 Python 侧 `kernel/critic.py`。
 *
 * **分工纪律（架构文档 ADR-5）**：可规则化的判断一律不给 LLM。必填缺失、命名
 * 规范、类型合法性、引用完整性走确定性规则 —— 又快又准又免费，而且没有方差。
 * 只有规则表达不了的（口径矛盾、疑似敷衍、语义重复）才交模型。
 *
 * **偏差缓解**（LLM-as-judge 综述 arXiv:2411.15594、位置偏差 arXiv:2406.07791）：
 *
 *   - rubric 化打分 —— 每条 0/1 判定，不给自由分值，压住冗长偏差；
 *   - 生成模型 ≠ 评委模型 —— 由 `RoutingTable.judge_for` 强制；
 *   - CRITICAL 档三采样多数票，压方差；
 *   - 批判必须写明 `evidence_checked` 与 `verifier` —— 工具交互式批判
 *     （CRITIC, arXiv:2305.11738）比纯自省可靠。
 *
 * ── 移植时的三处要点 ────────────────────────────────────────────────
 *
 * **1. `len(votes) / 2` 是真除**（契约 §1 的表里专门列了这条）。这里补一条实测
 * 结论，省得下一个人再纠结：票数与失败计数都是整数，`n > L/2` 与 `n > floor(L/2)`
 * 在整数上恒等（L 偶数时 floor 不改值；L 奇数时两边都等价于 `n ≥ (L+1)/2`）。
 * 也就是说这一处写成 floor **暂时**不会改变行为。仍然写真除：Python 就是真除，
 * 而一旦哪天票变成加权的（比如高档模型两票），floor 会当场把阈值判错。
 *
 * **2. Python 的真值性不等于 JS 的。** `votes = [r.data for r in results if r.data]`
 * 里，评委返回一个空 dict `{}` 在 Python 是**假**（这一票被丢掉，全丢光就退化成
 * "评委未返回可解析结果"的 HIGH finding），在 JS 里 `{}` 是**真**。照抄 `if (r.data)`
 * 会让一批空回复变成"全票通过"，而且是静默通过 —— 见下面的 `pyTruthy`。
 *
 * **3. `ModelGateway` / `ModelSpec` 还没迁**（llm.ts 不在本轮）。这里只声明 critic
 * 真正用到的那一个方法的结构类型；llm.ts 落地后它的 `ModelGateway` 天然满足，
 * 不需要改这边。
 */

import { NodeFailure } from "./errors.js";
import { EventKind } from "./events.js";
import { pyJsonDumps } from "./journal.js";

// ══════════════════════════════════════════════════════════════════
//  数据
// ══════════════════════════════════════════════════════════════════

export const Severity = {
  HIGH: "high", // 阻断发布
  MEDIUM: "medium", // 需处置，可打回
  LOW: "low", // 提示
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

const SEVERITY_VALUES: ReadonlySet<string> = new Set<string>(Object.values(Severity));

/** 对应 Python 的 `Severity(value)` —— 未知值抛错，不静默放行。 */
export function parseSeverity(v: unknown): Severity {
  if (typeof v === "string" && SEVERITY_VALUES.has(v)) return v as Severity;
  // 消息形状照 Python 的 `'x' is not a valid Severity`：日志里搜得到。
  throw new Error(`${JSON.stringify(v)} is not a valid Severity`);
}

/** 一条批判。字段是契约，不是建议 —— 缺 `evidenceChecked` 的批判无效。 */
export interface Finding {
  readonly severity: Severity;
  readonly code: string; // EVIDENCE_MISSING / NAMING_VIOLATION / …
  readonly target: string; // 被批判对象的 rid 或路径
  readonly claim: string; // 一句话说清问题
  readonly evidenceChecked: readonly string[];
  readonly proposedFix: Record<string, unknown> | null;
  readonly verifier: string; // 用什么核实的：规则名 / 工具名 / "llm"
}

export type FindingInit = Pick<Finding, "severity" | "code" | "target" | "claim"> &
  Partial<Finding>;

export function makeFinding(p: FindingInit): Finding {
  return {
    severity: p.severity,
    code: p.code,
    target: p.target,
    claim: p.claim,
    // 每次新数组，别共享调用方传进来的那个引用
    evidenceChecked: [...(p.evidenceChecked ?? [])],
    proposedFix: p.proposedFix ?? null,
    verifier: p.verifier ?? "",
  };
}

/** 线上形态是 snake_case（进事件 payload、进 API 响应）。 */
export function findingToDict(f: Finding): Record<string, unknown> {
  return {
    severity: f.severity,
    code: f.code,
    target: f.target,
    claim: f.claim,
    evidence_checked: [...f.evidenceChecked],
    proposed_fix: f.proposedFix,
    verifier: f.verifier,
  };
}

export interface Verdict {
  readonly lens: string;
  readonly passed: boolean;
  readonly findings: readonly Finding[];
  readonly note: string;
}

export type VerdictInit = Pick<Verdict, "lens" | "passed"> & Partial<Verdict>;

export function makeVerdict(p: VerdictInit): Verdict {
  return {
    lens: p.lens,
    passed: p.passed,
    findings: [...(p.findings ?? [])],
    note: p.note ?? "",
  };
}

/** Python 侧是 `Verdict.high` 属性；纯数据这边不挂方法，改成自由函数。 */
export function verdictHigh(v: Verdict): number {
  return v.findings.filter((f) => f.severity === Severity.HIGH).length;
}

export function verdictToDict(v: Verdict): Record<string, unknown> {
  return {
    lens: v.lens,
    passed: v.passed,
    high: verdictHigh(v),
    findings: v.findings.map(findingToDict),
    note: v.note,
  };
}

// ══════════════════════════════════════════════════════════════════
//  Critic
// ══════════════════════════════════════════════════════════════════

/** 模型档位。llm.ts 落地后由它的 `ModelSpec` 结构满足；critic 只把它透传给网关。 */
export interface JudgeModelSpec {
  readonly name: string;
}

/** 网关返回值里 critic 唯一读的字段。 */
export interface JudgeResult {
  readonly data?: unknown;
}

/** 评委网关的最小接口 —— 只钉住 `judge()`，其余留给 llm.ts。 */
export interface JudgeGateway {
  judge(
    nodeId: string,
    prompt: string,
    opts: {
      readonly generator: JudgeModelSpec | null;
      readonly schema?: Record<string, unknown>;
      readonly salt?: number;
      readonly key?: string;
    },
  ): Promise<JudgeResult>;
}

/**
 * 只需要 `emit` 的记录器。
 *
 * Python 侧这两处的类型标注是 `Recorder`，但实际只调 `emit`（测试里就传了个
 * 两行的桩）。这里照实际用法收窄：critic 不该因为想发一条事件就把整个 Recorder
 * （连带 journal、blob、重放索引）拖进依赖里。`Recorder` 天然满足它。
 */
export interface EventSink {
  emit(
    kind: EventKind,
    opts: {
      readonly nodeId?: string | null;
      readonly payload?: Record<string, unknown>;
    },
  ): unknown;
}

/** 评审时能拿到的东西。 */
export interface CriticContext {
  readonly nodeId: string;
  readonly gateway: JudgeGateway | null;
  readonly generator: JudgeModelSpec | null;
  readonly evidenceRender: string;
  readonly facts: string; // 黑板事实
  readonly rules: string; // 项目建模规范
  readonly samples: number; // 多采样自洽次数
}

export type CriticContextInit = Pick<CriticContext, "nodeId"> & Partial<CriticContext>;

export function makeCriticContext(p: CriticContextInit): CriticContext {
  return {
    nodeId: p.nodeId,
    // gateway / generator 在 Python 侧标注是必填，但规则视角根本不看 ctx，
    // 测试里一直传 None。默认给 null，别逼纯规则的调用方造一个假网关。
    gateway: p.gateway ?? null,
    generator: p.generator ?? null,
    evidenceRender: p.evidenceRender ?? "",
    facts: p.facts ?? "",
    rules: p.rules ?? "",
    samples: p.samples ?? 1,
  };
}

/** 一个评审视角。 */
export abstract class Critic {
  /** 视角名。Python 侧是类属性，子类在构造函数体里覆写。 */
  name = "critic";

  /**
   * 是否需要模型。预算降到 RULES_ONLY 时，需要模型的视角会被跳过。
   *
   * 子类用字段初始化器覆写是安全的（派生类字段在 `super()` 之后初始化），
   * **前提是基类构造函数不读它** —— 基类这里根本没有构造函数，别加。
   */
  readonly needsLlm: boolean = false;

  abstract judge(draft: unknown, ctx: CriticContext): Promise<Verdict>;
}

/**
 * 确定性规则视角。
 *
 * `check` 是一个纯函数：拿到 draft，返回 findings。不调模型、不看上下文 ——
 * 这保证它零成本、零方差、可在任何降级级别下运行。
 */
export class RuleCritic extends Critic {
  private readonly check: (draft: unknown) => readonly Finding[];

  constructor(name: string, check: (draft: unknown) => readonly Finding[]) {
    super();
    this.name = name;
    this.check = check;
  }

  // 实现里一个 await 都没有（这正是"零成本、零方差"的意思），但签名必须是
  // async —— Critic 的契约是 Promise，panel 拿它去 Promise.all。
  override judge(draft: unknown, _ctx: CriticContext): Promise<Verdict> {
    const findings = this.check(draft);
    return Promise.resolve(
      makeVerdict({
        lens: this.name,
        passed: !findings.some((f) => f.severity === Severity.HIGH),
        findings,
        note: `规则视角 · ${findings.length} 条`,
      }),
    );
  }
}

/** LLMCritic 下发的结构化输出 schema。Python 侧是 `LLMCritic._SCHEMA`（ClassVar）。 */
export const LLM_CRITIC_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["checks", "findings"],
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "pass"],
        properties: {
          item: { type: "string" },
          pass: { type: "boolean" },
          why: { type: "string" },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "code", "target", "claim", "evidence_checked"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          code: { type: "string" },
          target: { type: "string" },
          claim: { type: "string" },
          evidence_checked: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/**
 * 语义视角。用异构评委 + rubric 打分。
 *
 * @param rubric 逐条 0/1 的检查项。**不要写"整体质量如何"这种题** —— 那正是
 *   冗长偏差的入口。
 */
export class LLMCritic extends Critic {
  override readonly needsLlm = true;

  readonly rubric: readonly string[];
  readonly instruction: string;

  constructor(name: string, rubric: readonly string[], opts: { instruction?: string } = {}) {
    super();
    this.name = name;
    this.rubric = [...rubric];
    this.instruction = opts.instruction ?? "";
  }

  /** 导出只为 golden 能逐字节比对 —— Python 侧是私有的 `_prompt`。 */
  prompt(draft: unknown): string {
    const items = this.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n");
    return (
      `你是 ${this.name} 视角的评审。逐条判定下面每个检查项通过与否，` +
      `不要给总体评分、不要评论文风。\n\n` +
      `## 检查项\n${items}\n\n` +
      `## 项目规范\n${this.instruction === "" ? "（无额外规范）" : this.instruction}\n\n` +
      // "已知事实"这一段在 Python 原件里就是写死的 '（无）' —— ctx.facts 定义了却
      // 没接上。照抄，不顺手"修好"：修了就是两边的 prompt 分叉，而 prompt 变了
      // 模型输出就变了，这属于行为改动，不是迁移。
      `## 已知事实\n（无）\n\n` +
      `## 待审产物\n${sliceCodePoints(pyJsonDumps(draft, { defaultStr: true }), 20000)}\n\n` +
      "每条不通过的检查项都要产出一条 finding，且 evidence_checked 必须" +
      "填你实际核对过的出处（文件!位置）。核对不到出处就把 severity 标 high、" +
      "code 填 EVIDENCE_MISSING。"
    );
  }

  override async judge(draft: unknown, ctx: CriticContext): Promise<Verdict> {
    let prompt = this.prompt(draft);
    if (ctx.evidenceRender !== "") {
      prompt += `\n\n## 可核对的证据\n${sliceCodePoints(ctx.evidenceRender, 20000)}`;
    }
    const gateway = ctx.gateway;
    if (gateway === null) {
      // Python 会在这里抛 AttributeError（NoneType 没有 judge）。给条能读的。
      throw new TypeError(`${this.name}: LLMCritic 需要 gateway，ctx.gateway 是 null`);
    }

    // 多采样多数票：CRITICAL 档压方差用。
    // 注意 Promise.all 与 asyncio.gather 的差别：一支失败时 gather 会取消其余，
    // JS 这边其余的照跑到底（契约 §2.2：不假装有取消）。对纯网络调用没有影响。
    const n = Math.max(1, ctx.samples);
    const results = await Promise.all(
      Array.from({ length: n }, (_unused, i) =>
        gateway.judge(ctx.nodeId, prompt, {
          generator: ctx.generator,
          schema: LLM_CRITIC_SCHEMA,
          salt: i,
          key: `critic:${this.name}:${i}`,
        }),
      ),
    );

    // `if r.data` 走的是 **Python 的**真值性：空 dict / 空 list 是假票。
    const votes = results.filter((r) => pyTruthy(r.data)).map((r) => asVote(r.data));
    if (votes.length === 0) {
      return makeVerdict({
        lens: this.name,
        passed: false,
        findings: [
          makeFinding({
            severity: Severity.HIGH,
            code: "CRITIC_FAILED",
            target: "-",
            claim: "评委未返回可解析结果",
            verifier: "llm",
          }),
        ],
      });
    }

    // 多数票：一条检查项过半数判失败才算失败
    const failCounts = new Map<string, number>();
    for (const v of votes) {
      for (const c of asList(v["checks"], "checks")) {
        const check = asVote(c);
        // `c.get("pass", True)` —— 缺字段算通过；值同样按 Python 真值性判。
        if (!pyTruthy(check["pass"] ?? true)) {
          const item = check["item"];
          // Python 是 `c["item"]` 的 KeyError。schema 里 item 是必填的 string，
          // 非字符串当场拒绝（events.ts 同样的收紧理由：外部输入越早拒越好）。
          if (typeof item !== "string") {
            throw new TypeError(`评委的 check 缺少字符串 item: ${JSON.stringify(check)}`);
          }
          failCounts.set(item, (failCounts.get(item) ?? 0) + 1);
        }
      }
    }
    // **真除**：单票时阈值是 0.5，那一票的否决才算数（见文件头 §1）。
    const threshold = votes.length / 2;
    const failed = [...failCounts.entries()].filter(([, n2]) => n2 > threshold);

    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const v of votes) {
      for (const f of asList(v["findings"], "findings")) {
        const rec = asVote(f);
        const code = requireStr(rec, "code");
        const target = requireStr(rec, "target");
        // 去重键是 (code, target) 的**元组**；拼成串要带分隔符，
        // 否则 ("AB","C") 与 ("A","BC") 会撞成同一条。
        const sig = JSON.stringify([code, target]);
        if (seen.has(sig)) continue;
        seen.add(sig);
        findings.push(
          makeFinding({
            severity: parseSeverity(rec["severity"]),
            code,
            target,
            claim: requireStr(rec, "claim"),
            evidenceChecked: asStrList(rec["evidence_checked"], "evidence_checked"),
            verifier: "llm",
          }),
        );
      }
    }

    return makeVerdict({
      lens: this.name,
      passed: failed.length === 0 && !findings.some((f) => f.severity === Severity.HIGH),
      findings,
      note: `${votes.length} 票；未通过检查项 ${failed.length}/${this.rubric.length}`,
    });
  }
}

// ══════════════════════════════════════════════════════════════════
//  Panel
// ══════════════════════════════════════════════════════════════════

/**
 * 多视角并行评审。
 *
 * 四个视角互相独立，可并行 —— 延迟等于最慢的一个，不是四个之和。多视角比
 * 多次同质自省更有效（MAR, arXiv:2512.20845）。
 */
export class CriticPanel {
  /**
   * 存 Map 而不是普通对象：视角名来自配置，而普通对象上 `"toString" in obj`
   * 恒为真 —— 一个叫 `constructor` 的视角名会骗过 validate 的未注册检查，
   * 然后取到 `Object.prototype.constructor`。Map 没有原型键这回事。
   */
  readonly critics: ReadonlyMap<string, Critic>;
  readonly rec: EventSink;

  constructor(critics: Readonly<Record<string, Critic>> | ReadonlyMap<string, Critic>, rec: EventSink) {
    this.critics = critics instanceof Map ? new Map(critics) : new Map(Object.entries(critics));
    this.rec = rec;
  }

  /** 在任何 critic 开销之前拒绝拼错的/未注册的视角。 */
  validate(lenses: readonly string[], nodeId: string): void {
    const unknown = [...new Set(lenses.filter((name) => !this.critics.has(name)))];
    if (unknown.length > 0) {
      throw new NodeFailure(nodeId, `未注册的 critic: ${unknown.join(", ")}`, false);
    }
  }

  async judge(
    draft: unknown,
    lenses: readonly string[],
    ctx: CriticContext,
    opts: { allowLlm?: boolean } = {},
  ): Promise<Verdict[]> {
    // 拼错的 critic 以前在这里静默消失。那是控制面的配置错误，不是"评审通过"：
    // 空的 verdict 集合还会让下游的 `all([])` 每一道门都放行。所以在跑任何
    // （可能收费的）critic 之前整盘拒绝，失败既确定又便宜。
    this.validate(lenses, ctx.nodeId);
    const allowLlm = opts.allowLlm ?? true;

    const picked: Critic[] = [];
    const skipped: string[] = [];
    for (const name of lenses) {
      const c = this.critics.get(name);
      // `unknown` 上面已经拒过了；这个断言留在原地，是为了将来有人重构时
      // 走的是 fail closed，而不是把静默跳过又装回来。
      if (c === undefined) throw new Error(`critic 消失了: ${name}`);
      if (c.needsLlm && !allowLlm) {
        skipped.push(name); // 预算降级：跳过并记账，绝不静默
        continue;
      }
      picked.push(c);
    }

    const verdicts = await Promise.all(picked.map((c) => c.judge(draft, ctx)));

    for (const v of verdicts) {
      this.rec.emit(EventKind.CRITIC_VERDICT, { nodeId: ctx.nodeId, payload: verdictToDict(v) });
    }
    if (skipped.length > 0) {
      this.rec.emit(EventKind.DEGRADED, {
        nodeId: ctx.nodeId,
        payload: { skipped_critics: skipped, reason: "预算不足，未做语义审核" },
      });
    }
    return verdicts;
  }
}

// ══════════════════════════════════════════════════════════════════
//  Gate
// ══════════════════════════════════════════════════════════════════

export const Decision = {
  PASS: "pass",
  REVISE: "revise", // 回到 loop 再修一轮
  ASK_USER: "ask_user", // 需要人决策
  ROUND_TRIP: "round_trip", // 打回业务方
  AUTO_REPAIR: "auto_repair", // 可自动修
  ABORT: "abort",
} as const;

export type Decision = (typeof Decision)[keyof typeof Decision];

const DECISION_VALUES: ReadonlySet<string> = new Set<string>(Object.values(Decision));

export function parseDecision(v: unknown): Decision {
  if (typeof v === "string" && DECISION_VALUES.has(v)) return v as Decision;
  throw new Error(`${JSON.stringify(v)} is not a valid Decision`);
}

export interface GateResult {
  readonly decision: Decision;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
}

export type GateResultInit = Pick<GateResult, "decision" | "reason"> & Partial<GateResult>;

export function makeGateResult(p: GateResultInit): GateResult {
  return { decision: p.decision, reason: p.reason, detail: { ...(p.detail ?? {}) } };
}

/** 一条硬门断言：`[人看的标签, 判据]`。 */
export type Requirement = readonly [string, (metrics: Record<string, unknown>) => boolean];

/**
 * DAG 上的阻断点。
 *
 * `require` 是一组断言函数，全过才 PASS；不过则由 `onFail` 决定去向。
 * 刻意不做表达式字符串解析 —— 判定逻辑用函数写，可测试、可打断点。
 */
export class Gate {
  readonly name: string;
  readonly require: readonly Requirement[];
  readonly onFail: (metrics: Record<string, unknown>) => GateResult;

  constructor(
    name: string,
    require: readonly Requirement[],
    onFail: (metrics: Record<string, unknown>) => GateResult,
  ) {
    this.name = name;
    this.require = [...require];
    this.onFail = onFail;
  }

  evaluate(metrics: Record<string, unknown>, rec: EventSink, nodeId: string): GateResult {
    const failed = this.require.filter(([, pred]) => !pred(metrics)).map(([label]) => label);
    const result =
      failed.length === 0
        ? makeGateResult({ decision: Decision.PASS, reason: "全部硬门通过" })
        : this.onFail({ ...metrics, failed });
    rec.emit(EventKind.GATE_EVALUATED, {
      nodeId,
      payload: {
        gate: this.name,
        decision: result.decision,
        reason: result.reason,
        failed,
      },
    });
    return result;
  }
}

/**
 * 把评审结果压成 Gate 能判的指标。
 *
 * 用 type 而不是 interface：type 才有隐式索引签名，
 * `{...metricsFrom(v), completeness: 0.96}` 这种扩展写法才能过类型检查。
 */
export type Metrics = {
  review_count: number;
  all_passed: boolean;
  high_findings: number;
  total_findings: number;
  by_lens: Record<string, boolean>;
  high_by_lens: Record<string, number>;
  findings_by_lens: Record<string, number>;
  codes: string[];
};

export function metricsFrom(verdicts: readonly Verdict[]): Metrics {
  const byLens: Record<string, boolean> = {};
  const highByLens: Record<string, number> = {};
  const findingsByLens: Record<string, number> = {};
  const codes = new Set<string>();
  for (const v of verdicts) {
    byLens[v.lens] = v.passed;
    highByLens[v.lens] = verdictHigh(v);
    findingsByLens[v.lens] = v.findings.length;
    for (const f of v.findings) codes.add(f.code);
  }
  return {
    // 空 panel 是"未评审"，不是空洞的成功。确定性节点如果就是没有 critic，
    // 照样可以用一个空 require 的 gate；而一道断言 `all_passed` 的门现在
    // 会正确地要求至少有一条 verdict。
    review_count: verdicts.length,
    all_passed: verdicts.length > 0 && verdicts.every((v) => v.passed),
    high_findings: verdicts.reduce((s, v) => s + verdictHigh(v), 0),
    total_findings: verdicts.reduce((s, v) => s + v.findings.length, 0),
    by_lens: byLens,
    high_by_lens: highByLens,
    findings_by_lens: findingsByLens,
    codes: [...codes].sort(codePointCompare),
  };
}

// ── 小工具 ─────────────────────────────────────────────────────────

/**
 * Python 的 `bool(x)`。与 JS 的真值性有两处要命的差别：
 *   - 空容器（`{}` / `[]`）在 Python 是**假**，在 JS 是真；
 *   - `NaN` 在 Python 是**真**（它是个非零 float），在 JS 是假。
 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0; // NaN !== 0 → 真，与 Python 一致
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python 那边是直接 `.get()` / `["x"]`，类型不对就 AttributeError / KeyError。 */
function asVote(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new TypeError(`评委返回的不是对象: ${JSON.stringify(v) ?? String(v)}`);
  return v;
}

/**
 * `v.get(name, ())` —— **只有键缺失**才是空序列。
 *
 * 显式的 null 在 Python 里是 `for c in None` 的 TypeError，这里照样拒绝：
 * 把 null 悄悄当成空数组的方向恰好是最危险的那个（checks 为空 = 一条都没失败
 * = 这一票全过）。
 */
function asList(v: unknown, name: string): readonly unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TypeError(`评委的 ${name} 不是数组: ${JSON.stringify(v)}`);
  return v;
}

/**
 * `list(f.get("evidence_checked", ()))`。
 *
 * Python 那句原样收下任何元素（真来了个 int 就写进 Finding，再原样进日志）。
 * 这里要求必须是字符串：schema 里 evidence_checked 就是 array of string，
 * 而"证据出处"是要被人拿去核对的东西，静默转成 "1" 比报错更糟。
 */
function asStrList(v: unknown, name: string): string[] {
  return asList(v, name).map((x) => {
    if (typeof x !== "string") {
      throw new TypeError(`评委的 ${name} 里混进了非字符串: ${JSON.stringify(x)}`);
    }
    return x;
  });
}

function requireStr(rec: Record<string, unknown>, field: string): string {
  const v = rec[field];
  if (typeof v !== "string") {
    throw new TypeError(`评委的 finding 缺少字符串 ${field}: ${JSON.stringify(rec)}`);
  }
  return v;
}

/** Python `s[:n]` 按码位切；`.slice` 按码元切，会把 emoji 劈成半个。 */
function sliceCodePoints(s: string, n: number): string {
  // 码位数 ≤ 码元数，短串直接返回，别为一个 20000 的上限把几 MB 的串展成数组
  if (s.length <= n) return s;
  return [...s].slice(0, n).join("");
}

/** Python str 比较按码位；JS 默认 sort 按 UTF-16 码元。BMP 内一致，emoji 才分叉。 */
function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0) ?? 0;
    const cb = rb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca - cb;
  }
}
