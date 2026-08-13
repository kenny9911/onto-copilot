/**
 * 澄清引擎 —— 从几十条冲突里选出最值得问 FDE 的那 3 个。
 * 移植自 `src/ontocopilot/onto/clarify.py`，由 `golden/onto.clarify.json`
 * （`tools/golden/onto_clarify.py` 导出）钉住。
 *
 * **为什么是 3 个而不是全问。** SAGE-Agent（arXiv:2511.08798）的核心发现是提问
 * **质量**远比数量重要：结构化不确定性驱动的选择在覆盖率提升 7~39% 的同时把提问
 * 数减少 1.5~2.7×。FDE 的注意力是稀缺资源，问 10 个平庸问题比问 3 个关键问题
 * 效果更差、体验也更差。
 *
 * 打分函数（信息增益 × 影响半径，参考 arXiv:2606.03135）：
 *
 *     score = EIG × log1p(影响半径) × 不可逆性 × (1 − 自解性)
 *
 * **停止准则**（CaRT, arXiv:2510.08517）：top-1 得分低于阈值就停止提问，剩余
 * 不确定性**转移到模板里变成一个黄底空格**，由业务方在填写时消解。这是本产品的
 * 巧妙之处 —— 没法在对话里解决的歧义不硬问，而是变成模板里的一个格子。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`Math.log1p` 与 CPython 的 `math.log1p` 不是同一个实现**，个别输入差
 *     1 ULP（实测 blast = 2 / 13 / 47 上就差）。CPython 直接调平台 libm，
 *     所以这条差异连 Python 自己都不跨平台稳定 —— 不去"修"它，而是把它钉在
 *     测试里：`score` 允许几个 ULP 的差，而**排序、分桶、`round(score, 4)`
 *     全部按精确值断言**（真正决定行为的是这几样，不是尾数）。
 *  2. **`for ... else`**：Python 的 for-else 在**没有 break** 时才跑 else。
 *     这里决定 `stopped_because` 会不会被写成"全部可问的冲突都已提问"，
 *     照直译成"循环后面接一句"就永远覆盖掉前面两条 break 写进去的原因。
 *  3. **`rid[-8:]`**：倒数切片按 code point。冲突 rid 里带中文时（`_cid` 会把
 *     kind 拼进去，而 kind 是 ASCII，但 rid 也可能来自人工），JS 的 `slice(-8)`
 *     按 UTF-16 码元切，代理对会被切成半个。
 *  4. **`self_resolvable` 会返回负数**：`min(0.8, (top - rest) / total)` 在
 *     "分支多、每支证据都少"时给负值（四个等权分支 → −0.5），于是
 *     `1 − self_resolvable` > 1，`score` 冲出 [0,1]。docstring 说"归一化到 [0,1]"
 *     其实不成立。**照实迁**：这是 Python 侧的既有行为，改了 TS 侧就和
 *     Python 排出不同的 top-3，而 top-3 是这个产品直接暴露给 FDE 的东西。
 */

import { pyRepr } from "../kernel/errors.js";
import {
  FALLBACK_OPTIONS,
  Handling,
  handlingOf,
  irreversibilityOf,
  conflictPolicy,
  makeOption,
  optionToDict,
  parseAxes,
  type Conflict,
  type Option,
} from "./conflict.js";
import { byUser, type BaseType, type OIR, type PropertyType } from "./oir.js";
import { pyRound } from "./shape.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** `s[-n:]`：从**末尾**按 code point 取 n 个。`slice(-8)` 按 UTF-16 码元切，
 * 代理对会被切成半个（渲染成 �，而这串要进 Question.id）。 */
function cpTail(s: string, n: number): string {
  const cps = [...s];
  return cps.slice(Math.max(0, cps.length - n)).join("");
}

/** Python 的真值判断。`if target := effect.get("unify_to")` 这类 walrus 判的是
 * **真值**不是"存在"：空串 / 空列表 / 0 都要跳过。JS 里 `[]` 是真。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

// ══════════════════════════════════════════════════════════════════
//  数据形态
// ══════════════════════════════════════════════════════════════════

/** 一个建模决策问句。
 *
 * 每个选项都必须带证据出处 —— FDE 要能点进去看原文再决定。给不出出处的
 * 选项等于让人凭感觉拍板，那还不如不问。 */
export interface Question {
  id: string;
  conflictRid: string;
  title: string;
  options: Option[];
  /** 影响的 OIR 实体数 */
  impact: number;
  score: number;
  reversible: boolean;
}

export function questionToDict(q: Question): Record<string, unknown> {
  return {
    id: q.id,
    conflict_rid: q.conflictRid,
    title: q.title,
    impact_count: q.impact,
    score: pyRound(q.score, 4),
    reversible: q.reversible,
    options: q.options.map(optionToDict),
  };
}

/** 澄清引擎的完整输出 —— 问什么、不问什么、不问的怎么处理。 */
export interface ClarificationSet {
  questions: Question[];
  autoRepairable: Conflict[];
  deferredToTemplate: Conflict[];
  roundTrip: Conflict[];
  hints: Conflict[];
  stoppedBecause: string;
}

export function makeClarificationSet(): ClarificationSet {
  return {
    questions: [],
    autoRepairable: [],
    deferredToTemplate: [],
    roundTrip: [],
    hints: [],
    stoppedBecause: "",
  };
}

export function clarificationSummary(s: ClarificationSet): Record<string, unknown> {
  return {
    asked: s.questions.length,
    auto_repairable: s.autoRepairable.length,
    deferred_to_template: s.deferredToTemplate.length,
    round_trip: s.roundTrip.length,
    hints: s.hints.length,
    stopped_because: s.stoppedBecause,
  };
}

// ══════════════════════════════════════════════════════════════════
//  引擎
// ══════════════════════════════════════════════════════════════════

/** 按 EIG 排序选问题。
 *
 * @param maxQuestions 一次最多问几个。设计稿定的 3。
 * @param thetaAsk 停止阈值。top-1 低于它就不再问。
 */
export class ClarificationEngine {
  /** 影响半径的归一化基准。超过这个数的冲突在"影响面"这一维上已经拉满，
   * 再大也不改变"必须问"的结论。 */
  static readonly BLAST_SCALE = 30;

  readonly maxQuestions: number;
  readonly thetaAsk: number;

  constructor(opts: { maxQuestions?: number; thetaAsk?: number } = {}) {
    this.maxQuestions = opts.maxQuestions ?? 3;
    this.thetaAsk = opts.thetaAsk ?? 0.35;
  }

  rank(conflicts: readonly Conflict[], oir: OIR): ClarificationSet {
    const out = makeClarificationSet();
    const askable: [number, Conflict][] = [];

    for (const c of conflicts) {
      switch (handlingOf(c)) {
        case Handling.AUTO_REPAIR:
          out.autoRepairable.push(c);
          break;
        case Handling.ROUND_TRIP:
          out.roundTrip.push(c);
          break;
        case Handling.HINT:
          out.hints.push(c);
          break;
        case Handling.ASK_USER:
          askable.push([this.score(c, oir), c]);
          break;
      }
    }

    // `sort(key=lambda p: -p[0])`：稳定降序。写成 `b[0] - a[0]` 才等价 ——
    // 同分时必须保持 conflicts 的原顺序，否则同一批冲突两次运行会问出不同的题。
    askable.sort((a, b) => b[0] - a[0]);

    // Python 的 for-else：只有**一次 break 都没有**时才补最后那句。
    let broke = false;
    for (let i = 0; i < askable.length; i++) {
      const [score, c] = askable[i]!;
      if (out.questions.length >= this.maxQuestions) {
        out.stoppedBecause = `已达提问上限 ${this.maxQuestions}`;
        for (const [, rest] of askable.slice(i)) out.deferredToTemplate.push(rest);
        broke = true;
        break;
      }
      if (score < this.thetaAsk) {
        out.stoppedBecause =
          `剩余 ${askable.length - i} 条得分均低于阈值 ${pyNum(this.thetaAsk)}，` +
          "转为模板中的业务必填项";
        for (const [, rest] of askable.slice(i)) out.deferredToTemplate.push(rest);
        broke = true;
        break;
      }
      out.questions.push({
        id: `q_${out.questions.length + 1}_${cpTail(c.rid, 8)}`,
        conflictRid: c.rid,
        title: c.summary,
        // 一个选项都没有时回落成"转模板"—— 一个没有任何选项的问句问了也没法答。
        options: c.options.length > 0 ? c.options : [makeOption("defer", "转为模板必填项")],
        impact: ClarificationEngine.blast(c, oir),
        score,
        reversible: irreversibilityOf(c) < 0.5,
      });
    }
    if (!broke && !out.stoppedBecause) {
      out.stoppedBecause = "全部可问的冲突都已提问";
    }

    return out;
  }

  // ── 打分因子 ────────────────────────────────────────────────

  /** 四因子乘积。
   *
   * Python 的 docstring 说"归一化到 [0,1]"，实际上 `self_resolvable` 会返回
   * 负数（见文件头第 4 条），所以上界不成立。这里**不修**，因为 `thetaAsk`
   * 这个旋钮是按 Python 侧实际排出来的分数调的。
   *
   * 乘法顺序照抄 Python 的从左到右 —— 浮点乘法不满足结合律，换个括号就换个尾数。 */
  score(c: Conflict, oir: OIR): number {
    const eig = ClarificationEngine.eig(c);
    const blastFactor = Math.min(
      1.0,
      Math.log1p(ClarificationEngine.blast(c, oir)) /
        Math.log1p(ClarificationEngine.BLAST_SCALE),
    );
    return eig * blastFactor * irreversibilityOf(c) * (1 - ClarificationEngine.selfResolvable(c));
  }

  /** 期望信息增益 —— 候选选项分布的归一化熵。
   *
   * 对*事实之争*：选项越势均力敌，问一次的收益越大。
   * 对*政策选择*：兜底选项（「留空」「转模板」）也是真实的决策分支，所以
   * 参与计数、但不参与证据加权 —— 「不做」不需要证据。 */
  static eig(c: Conflict): number {
    const opts = c.options;
    let branches: Option[];
    let weights: number[];
    if (conflictPolicy(c).evidenceDecidable) {
      branches = opts.filter((o) => !FALLBACK_OPTIONS.has(o.id));
      weights = branches.map((o) => 1.0 + o.evidence.length);
    } else {
      branches = [...opts];
      weights = branches.map(() => 1.0);
    }
    if (branches.length < 2) return 0.0;
    let total = 0;
    for (const w of weights) total += w;
    const probs = weights.map((w) => w / total);
    let acc = 0;
    for (const p of probs) if (p > 0) acc += p * Math.log2(p);
    const h = -acc;
    return h / Math.log2(branches.length); // 归一化到 [0,1]
  }

  /** 影响半径 —— 这个决策定了之后，多少 OIR 实体的状态会随之确定。 */
  static blast(c: Conflict, oir: OIR): number {
    const hit = new Set<string>();
    for (const rid of c.subjects) {
      hit.add(rid);
      for (const d of oir.dependents(rid)) hit.add(d);
    }
    return hit.size;
  }

  /** 自解性 —— 能靠更多证据自行解决的，不该占用人的注意力。
   *
   * **只对事实之争成立**。政策选择（做/不做）恒返回 0：「不做」这个分支
   * 天生没有证据，按证据平衡度打折会把一个该问的问题误判成"系统能自己定"。 */
  static selfResolvable(c: Conflict): number {
    // `not c.options`：空列表在 Python 里是假值。
    if (!conflictPolicy(c).evidenceDecidable || c.options.length === 0) return 0.0;
    const counts = c.options
      .filter((o) => !FALLBACK_OPTIONS.has(o.id))
      .map((o) => o.evidence.length);
    let sum = 0;
    for (const n of counts) sum += n;
    if (counts.length === 0 || sum === 0) return 0.0;
    const top = Math.max(...counts);
    // 一边证据碾压另一边 → 系统可以自己倾向；势均力敌 → 必须问人。
    // 分支一多这个式子会变成负数，而 Python 侧就是这样 —— 见文件头第 4 条。
    return Math.min(0.8, (top - (sum - top)) / sum);
  }
}

/** f-string 里插一个 float：Python 的 `f"{0.35}"` 是 `"0.35"`，`f"{1.0}"` 是
 * `"1.0"` —— 而 JS 的 `String(1.0)` 给 `"1"`。这个数会进 `stoppedBecause`，
 * 是要给人读的运维文案。 */
function pyNum(x: number): string {
  if (Object.is(x, -0)) return "-0.0";
  // 1e16 起 Python 转成 `1e+16`，JS 还在印全展开 —— 阈值够不着那里，
  // 但把边界写出来比假装它不存在好。
  if (Number.isInteger(x) && Number.isFinite(x) && Math.abs(x) < 1e16) {
    return `${x}.0`;
  }
  return String(x);
}

// ══════════════════════════════════════════════════════════════════
//  决策回写
// ══════════════════════════════════════════════════════════════════

export interface DecisionResult {
  conflict: string;
  option: string;
  label: string;
  changed: string[];
  note: string;
  deferred: boolean;
}

/** 把人的决策回写进 OIR，返回变更摘要。
 *
 * 人的决策标 `Origin.USER`、可信度 0.98 —— 它是业务事实，不是系统推断，
 * 后续任何自动逻辑都不得覆盖它。
 *
 * 找不到选项时 Python 抛 `KeyError`。JS 没有 KeyError，按本仓库既有约定
 * （`oir.ts` / `conflict.ts`）抛 `Error`，消息是 `"KeyError: " + Python 的 args[0]`。 */
export function applyDecision(
  oir: OIR,
  conflict: Conflict,
  optionId: string,
  opts: { note?: string } = {},
): DecisionResult {
  const note = opts.note ?? "";
  const option = conflict.options.find((o) => o.id === optionId);
  if (option === undefined) {
    throw new Error(`KeyError: 冲突 ${conflict.rid} 没有选项 ${pyRepr(optionId)}`);
  }

  const changed: string[] = [];
  const effect = option.effect;

  const target = effect["unify_to"];
  if (pyTruthy(target)) {
    const source = typeof target === "string" ? oir.properties.get(target) : undefined;
    for (const rid of conflict.subjects) {
      const p = oir.properties.get(rid);
      if (p === undefined || source === undefined || rid === target) continue;
      p.definition = byUser(source.definition.value, note || `统一为 ${String(target)}`);
      changed.push(rid);
    }
  }

  if (pyTruthy(effect["split"])) {
    for (const rid of effect["split"] as unknown[]) {
      if (typeof rid !== "string") continue;
      const p = oir.properties.get(rid);
      if (p === undefined) continue;
      p.apiName = byUser(`${p.apiName.value}${suffixOf(p)}`, note || "拆分为两个属性");
      changed.push(rid);
    }
  }

  const newType = effect["set_base_type"];
  if (pyTruthy(newType)) {
    for (const rid of conflict.subjects) {
      const p = oir.properties.get(rid);
      if (p !== undefined) {
        // Python 这里**不校验** —— effect 里写什么就存什么。走 `parseBaseType`
        // 会在 Python 不炸的地方炸，那是行为变化，不是"修好"。
        p.baseType = byUser(newType as BaseType, note || "以实际数据为准");
        changed.push(rid);
      }
    }
  }

  return {
    conflict: conflict.rid,
    option: optionId,
    label: option.label,
    changed,
    note,
    deferred: pyTruthy(effect["defer"]),
  };
}

/** 拆分后缀。
 *
 * **这是 `conflict.ts` 里同名私有函数的第二份实现**，不是我想要的形状：Python 侧
 * `apply_decision` 用的是函数内 `from .conflict import _suffix`，跨模块拿了个私有
 * 符号；TS 里拿不到没导出的东西。轴取值表（含税/不含税/年度累计/单次）因此在两个
 * 文件里各有一份，**任何一边改了另一边不会跟着改** —— 正确的收敛方式是
 * `conflict.ts` 把 `suffix` 导出来，然后删掉这里。
 *
 * 在那之前，`golden/onto.clarify.json` 的 `apply.split` 用例钉住了四个轴取值的
 * 拼接结果，两份实现一旦漂开会红在那条用例上，而不是悄悄产出不同的属性名。 */
function suffixOf(p: PropertyType): string {
  const axes = parseAxes(p.definition.value || "");
  const tail: Readonly<Record<string, string>> = {
    含税: "TaxIncl",
    不含税: "Net",
    年度累计: "Annual",
    单次: "PerTime",
  };
  let out = "";
  for (const v of axes.values()) out += tail[v] ?? "";
  return out;
}
