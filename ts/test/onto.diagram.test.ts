/**
 * diagram / suggest / clarify 三个模块的 golden 校验。
 *
 * 三份 golden，全部由 `tools/golden/onto_{diagram,suggest,clarify}.py` 从
 * **真跑一遍的 Python** 导出，期望值一个都没有手写 —— 手写的是我对 Python 行为
 * 的猜测，golden 是它的事实。三个导出脚本都字节确定（重跑两次 shasum 一致）。
 *
 *   - `golden/onto.diagram.json`  —— 14 张图 × (mermaid ×2 + svg ×2)，外加
 *     `_mid` / `_mlabel` / `_wrap` / `_layer` 的单元向量。
 *     **空图 / 单节点 / 环 / 超长标签 / 没注册的阶段 / 悬空边** 各一张：
 *     渲染层最容易在"正常输入都对、空输入直接崩"上翻车，而空 OIR 恰恰是
 *     新会话的初始状态（Python 侧真出过这个事故）。
 *   - `golden/onto.suggest.json`  —— 13 张 OIR × 两组 limit，7 组旋钮，
 *     11 条 `apply_suggestion`（连执行后的整个 OIR 一起钉）。
 *   - `golden/onto.clarify.json`  —— 12 条冲突的四个打分因子、9 组 rank、
 *     7 条 `apply_decision`、以及找不到选项时的报错原文。
 *
 * 每个 case 的输入都是 `to_dict()` 的产物，TS 侧用 `flowFromDict` / `oirFromDict`
 * 还原之后再跑 —— 这样 golden 的输入和输出之间没有任何 TS 侧看不见的中间状态。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatFixed0 } from "../src/kernel/errors.js";
import {
  ClarificationEngine,
  applyDecision,
  clarificationSummary,
  questionToDict,
} from "../src/onto/clarify.js";
import {
  makeConflict,
  makeOption,
  parseConflictKind,
  type Conflict,
  type Option,
} from "../src/onto/conflict.js";
import { layer, mid, mlabel, toMermaid, toSvg, wrap, makePalette } from "../src/onto/diagram.js";
import { flowFromDict, type FlowGraph } from "../src/onto/flow.js";
import { makeProvenance, oirFromDict, type OIR, type Provenance } from "../src/onto/oir.js";
import { pyRound } from "../src/onto/shape.js";
import {
  SuggestionEngine,
  TECHNICAL,
  applySuggestion,
  splitSuffix,
  suggest,
} from "../src/onto/suggest.js";

type Dict = Record<string, unknown>;

const readGolden = (name: string): Dict =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as Dict;

const DIAGRAM = readGolden("onto.diagram.json");
const SUGGEST = readGolden("onto.suggest.json");
const CLARIFY = readGolden("onto.clarify.json");

const rows = (d: Dict, k: string): Dict[] => d[k] as Dict[];
const byName = (d: Dict, k: string): Map<string, Dict> =>
  new Map(rows(d, k).map((c) => [c["name"] as string, c]));

// ══════════════════════════════════════════════════════════════════
//  diagram
// ══════════════════════════════════════════════════════════════════
describe("onto/diagram —— 单元规则", () => {
  it("_mid：isalnum 是 Unicode 级的，中文/全角/罗马数字/阿拉伯数字都保留", () => {
    for (const [input, expected] of DIAGRAM["mid"] as [string, string][]) {
      expect(mid(input), `mid(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it("_mid：星平面字符按 code point 计数，40 的截断不能按 UTF-16 码元", () => {
    // 60 个 CJK 扩展 B 的生僻字（每个 2 个码元）。按码元切只剩 20 个字。
    const astral = "𠀀".repeat(60);
    expect([...mid(astral)].length).toBe(41); // "n" + 40 个 code point
  });

  it("_mlabel：引号和方括号会破坏 mermaid 语法", () => {
    for (const [input, expected] of DIAGRAM["mlabel"] as [string, string][]) {
      expect(mlabel(input), `mlabel(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it("_wrap：per_line 为 0 抛错、为负回落成 [\"\"]（Python 的 range 语义）", () => {
    // 直译成 `for (i += perLine)` 在这两种输入上都会无限转 —— 无限循环比
    // 抛异常难查一个量级，而 wrap 是导出的，调用方不止 to_svg 一处。
    expect(() => wrap("abcdef", 0, 3)).toThrow(RangeError);
    expect(() => wrap("", 0, 3)).toThrow(RangeError);
    expect(wrap("abcdef", -1, 3)).toEqual([""]);
  });

  it("_wrap：按 code point 折行，超行数截断加省略号", () => {
    for (const c of rows(DIAGRAM, "wrap")) {
      const got = wrap(c["text"] as string, c["per_line"] as number, c["max_lines"] as number);
      expect(got, JSON.stringify(c["text"])).toEqual(c["out"]);
    }
  });
});

describe("onto/diagram —— 渲染", () => {
  const cases = byName(DIAGRAM, "cases");
  const graphOf = (c: Dict): FlowGraph => flowFromDict(c["flow"] as Dict);

  for (const [name, c] of cases) {
    describe(name, () => {
      it("_layer：泳道内分层（有环时剩下的全塞最后一层）", () => {
        const g = graphOf(c);
        const got: Record<string, string[][]> = {};
        for (const [key, members] of [...g.byStage()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          got[key] = layer(g, members).map((col) => col.map((n) => n.rid));
        }
        expect(got).toEqual(c["layers"]);
      });

      it("to_mermaid（LR + 编号）", () => {
        expect(toMermaid(graphOf(c))).toBe(c["mermaid"]);
      });

      it("to_mermaid（TB + 不带编号）", () => {
        expect(toMermaid(graphOf(c), { direction: "TB", showCodes: false })).toBe(
          c["mermaid_tb_nocodes"],
        );
      });

      it("to_svg（默认标题 + 默认配色）", () => {
        expect(toSvg(graphOf(c))).toBe(c["svg"]);
      });

      it("to_svg（自定义标题 + 自定义配色 + 不带编号）", () => {
        const palette = makePalette({
          actionFill: "#111111",
          actionLine: "#222222",
          eventFill: "#333333",
          eventLine: "#444444",
          gatewayFill: "#555555",
          gatewayLine: "#666666",
          terminalFill: "#777777",
          terminalLine: "#888888",
          externalFill: "#999999",
          externalLine: "#aaaaaa",
          band: "#bbbbbb",
          bandLine: "#cccccc",
          ink: "#dddddd",
          dim: "#eeeeee",
          edge: "#ffffff",
        });
        expect(toSvg(graphOf(c), { title: '自定义 "标题" <&>', palette, showCodes: false })).toBe(
          c["svg_custom"],
        );
      });
    });
  }

  it("空图不崩，而且真的画出一张 640 宽的白底 SVG", () => {
    // 这不是重复用例：上面那组是 golden 比对，这一条钉的是**为什么**要有空图用例 ——
    // 「材料里没有流程说明」是新会话的初始状态，Python 上一版在这里 AttributeError。
    const g = flowFromDict((cases.get("empty")!["flow"] as Dict));
    const svg = toSvg(g);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('viewBox="0 0 640 82"');
    // 没有任何 Action 接上接口时，那句「x/y 个环节已对上接口」不写 ——
    // 「0 个环节已对上接口」只会让人以为系统什么都没有。
    expect(svg).not.toContain("个环节已对上接口");
    expect(toMermaid(g).split("\n")[0]).toBe("flowchart LR");
  });

  it("坐标一律走 formatFixed0，不是 toFixed(0)", () => {
    // toFixed 是 half-away-from-zero，Python 的 .0f 是 half-even。坐标里出现
    // 半整数的机会不多，但一旦出现就是整条 path 串对不上。
    expect(formatFixed0(0.5)).toBe("0");
    expect((0.5).toFixed(0)).toBe("1"); // 反例：写成 toFixed 会得到这个
    expect(formatFixed0(2.5)).toBe("2");
  });
});

// ══════════════════════════════════════════════════════════════════
//  suggest
// ══════════════════════════════════════════════════════════════════
describe("onto/suggest —— 单元规则", () => {
  it("_split_suffix：驼峰拆分的边界（全大写 / 含中文 / 纯小写 / 数字后缀）", () => {
    for (const [input, expected] of SUGGEST["split_suffix"] as [string, string[] | null][]) {
      const got = splitSuffix(input);
      expect(got === null ? null : [...got], JSON.stringify(input)).toEqual(expected);
    }
  });

  it("_TECHNICAL：Python 的 $ 也匹配串尾换行之前", () => {
    for (const [input, hit, frag] of SUGGEST["technical"] as [string, boolean, string | null][]) {
      const m = TECHNICAL.exec(input);
      expect(m !== null, JSON.stringify(input)).toBe(hit);
      expect(m === null ? null : m[0], JSON.stringify(input)).toBe(frag);
    }
  });

  it("_TECHNICAL：`orderLog\\n` 命中而 `orderLog\\nx` 不命中", () => {
    // 单独立一条：这是从 xlsx 抽出来的对象名最常见的脏形态（单元格里的回车），
    // 照 JS 的 `$` 写会静默漏掉一整类技术表 —— 漏掉不报错，才是最难查的。
    expect(TECHNICAL.test("orderLog\n")).toBe(true);
    expect(TECHNICAL.test("orderLog\nx")).toBe(false);
    expect(/(log)$/i.test("orderLog\n")).toBe(false); // 反例：朴素写法
  });
});

describe("onto/suggest —— 建议生成", () => {
  for (const c of rows(SUGGEST, "cases")) {
    const name = c["name"] as string;
    it(`${name}：suggest() 默认 limit`, () => {
      expect(suggest(oirFromDict(c["oir"] as Dict))).toEqual(c["suggest"]);
    });
    it(`${name}：suggest(limit=3)`, () => {
      expect(suggest(oirFromDict(c["oir"] as Dict), { limit: 3 })).toEqual(c["suggest_limit3"]);
    });
  }

  it("min_impact / limit 两个旋钮：过滤在排序之前", () => {
    const oir = oirFromDict(SUGGEST["knobs_oir"] as Dict);
    for (const k of rows(SUGGEST, "knobs")) {
      const eng = new SuggestionEngine({
        minImpact: k["min_impact"] as number,
        limit: k["limit"] as number,
      });
      const proposed = eng.propose(oir);
      expect(
        proposed.map((s) => ({
          id: s.sid,
          kind: s.kind,
          title: s.title,
          rationale: s.rationale,
          impact: s.impact,
          confidence: s.confidence,
          citations: s.citations.slice(0, 6),
          payload: s.payload,
        })),
        `minImpact=${String(k["min_impact"])} limit=${String(k["limit"])}`,
      ).toEqual(k["out"]);
      // score 单独钉一份：结果碰巧一样但排序主轴算错时，只比 out 是看不出来的。
      expect(proposed.map((s) => s.impact * s.confidence)).toEqual(k["scores"]);
    }
  });

  it("排序主轴是 impact×confidence，不是 impact", () => {
    // `everything` 里 sg-nofields 与 sg-naming 影响面都是 17，把握 0.9 / 0.6 ——
    // 写成按 impact 排，这两条谁在前面就成了偶然，而排前面的那条是 FDE 第一眼看到的。
    const out = suggest(oirFromDict(SUGGEST["knobs_oir"] as Dict)) as Dict[];
    const nofields = out.find((s) => s["id"] === "sg-nofields")!;
    const naming = out.find((s) => s["id"] === "sg-naming")!;
    expect(nofields["impact"]).toBe(naming["impact"]);
    expect(out.indexOf(nofields)).toBeLessThan(out.indexOf(naming));
  });
});

describe("onto/suggest —— apply_suggestion", () => {
  for (const c of rows(SUGGEST, "apply")) {
    it(c["name"] as string, () => {
      const oir = oirFromDict(c["oir_before"] as Dict);
      const res = applySuggestion(oir, c["suggestion"] as Dict, { note: c["note"] as string });
      expect(res).toEqual(c["result"]);
      // **执行后的整个 OIR** 也要比：只看 changed 测不到"EXCLUDE 是标记而不是删除"。
      expect(oir.toDict()).toEqual(c["oir_after"]);
    });
  }

  it("EXCLUDE 标记为 REJECTED 而不是从容器里删掉", () => {
    const c = byName(SUGGEST, "apply").get("exclude_ok")!;
    const before = oirFromDict(c["oir_before"] as Dict);
    const n = before.objects.size;
    applySuggestion(before, c["suggestion"] as Dict, {});
    expect(before.objects.size).toBe(n); // 一个都没少
  });
});

// ══════════════════════════════════════════════════════════════════
//  clarify
// ══════════════════════════════════════════════════════════════════

/** 把 golden 里 `Provenance.to_dict()` 的产物还原。 */
function provFromDict(d: Dict): Provenance {
  return makeProvenance(d["file_id"] as string, d["file_name"] as string, d["locator"] as Dict, {
    snippet: d["snippet"] as string,
    extractor: d["extractor"] as string,
    confidence: d["confidence"] as number,
  });
}

function optionFromDict(d: Dict): Option {
  return makeOption(d["id"] as string, d["label"] as string, d["rationale"] as string, {
    evidence: (d["evidence"] as Dict[]).map(provFromDict),
    effect: d["effect"] as Dict,
  });
}

/** Python 侧没有 `conflict_from_dict`（产物只单向出去），所以这里手工还原 ——
 * 用的全是 conflict.ts 的公开工厂，没有第二套字段默认值。 */
function conflictFromDict(d: Dict): Conflict {
  return makeConflict(
    d["rid"] as string,
    parseConflictKind(d["kind"]),
    d["subjects"] as string[],
    d["summary"] as string,
    {
      evidence: (d["evidence"] as Dict[]).map(provFromDict),
      options: (d["options"] as Dict[]).map(optionFromDict),
      owner: d["owner"] as string | null,
      detector: d["detector"] as string,
    },
  );
}

const CLARIFY_OIR = (): OIR => oirFromDict(CLARIFY["oir"] as Dict);
const CONFLICTS = new Map<string, Conflict>(
  Object.entries(CLARIFY["conflicts"] as Record<string, Dict>).map(([k, v]) => [
    k,
    conflictFromDict(v),
  ]),
);

/** `Math.log1p` 与 CPython 的 `math.log1p`（走平台 libm）在个别输入上差 1 ULP，
 * 实测 blast = 2 / 13 / 47 就差。CPython 自己都不跨平台稳定，所以不去"修"它：
 * 原始 `score` 允许几个 ULP，而排序、分桶、`round(score,4)` 全部精确断言。 */
function expectCloseUlps(actual: number, expected: number, maxUlps = 4): void {
  if (actual === expected) return;
  expect(Number.isFinite(actual) && Number.isFinite(expected)).toBe(true);
  const ulp = Math.abs(expected) * Number.EPSILON;
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(ulp * maxUlps);
}

describe("onto/clarify —— 打分因子", () => {
  it("BLAST_SCALE 与 Python 一致", () => {
    expect(ClarificationEngine.BLAST_SCALE).toBe(CLARIFY["blast_scale"]);
  });

  it("eig / blast / self_resolvable / score 逐个钉", () => {
    const oir = CLARIFY_OIR();
    const eng = new ClarificationEngine();
    for (const f of rows(CLARIFY, "factors")) {
      const c = CONFLICTS.get(f["name"] as string)!;
      const tag = f["name"] as string;
      // 三个因子是整数或有限位小数运算，必须**精确**相等。
      expect(ClarificationEngine.eig(c), `${tag}.eig`).toBe(f["eig"]);
      expect(ClarificationEngine.blast(c, oir), `${tag}.blast`).toBe(f["blast"]);
      expect(ClarificationEngine.selfResolvable(c), `${tag}.self_resolvable`).toBe(
        f["self_resolvable"],
      );
      // score 里有 log1p —— 见 expectCloseUlps 的注释。尾数可以差，
      // 但**进产物的那个数**（Question.to_dict 里的 round(score,4)）必须一模一样。
      const got = eng.score(c, oir);
      expectCloseUlps(got, f["score"] as number, 2);
      expect(pyRound(got, 4), `${tag}.round(score,4)`).toBe(pyRound(f["score"] as number, 4));
    }
  });

  it("Math.log1p(2) 与 CPython 差 1 ULP —— 钉住它，不假装没有", () => {
    // `blast_two` 是唯一一条 blast 恰好为 2 且 eig 非零的冲突，也是全套里唯一
    // 一条 score 不是逐位相等的。差 0.98 ULP，够不上任何一次阈值比较，
    // 但 `toEqual` 会红 —— 所以这里说清楚它为什么被允许差。
    const oir = CLARIFY_OIR();
    const eng = new ClarificationEngine();
    const golden = new Map(
      rows(CLARIFY, "factors").map((f) => [f["name"] as string, f["score"] as number]),
    );
    const inexact = [...CONFLICTS].filter(
      ([name, c]) => eng.score(c, oir) !== golden.get(name),
    );
    expect(inexact.map(([n]) => n)).toEqual(["blast_two"]);
    expect(Math.log1p(2)).not.toBe(1.0986122886681098); // CPython 在 macOS 上给的值
  });

  it("self_resolvable 会返回负数 —— Python 侧就是这样，照实迁", () => {
    // 四个等权分支：(1 - 3) / 4 = -0.5，于是 (1 - self) = 1.5，score 冲出 [0,1]。
    // docstring 说"归一化到 [0,1]"其实不成立。改掉它会让 TS 排出和 Python
    // 不同的 top-3，而 top-3 是直接摆在 FDE 面前的东西。
    const four = CONFLICTS.get("four_even")!;
    expect(ClarificationEngine.selfResolvable(four)).toBe(-0.5);
    expect(new ClarificationEngine().score(four, CLARIFY_OIR())).toBeGreaterThan(0.9);
  });

  it("政策选择（evidence_decidable=false）的 self_resolvable 恒为 0", () => {
    // 「不做」这个分支天生没有证据，按证据平衡度打折会把一个该问的问题
    // 误判成"系统能自己定"。
    expect(ClarificationEngine.selfResolvable(CONFLICTS.get("policy")!)).toBe(0);
  });

  it("q_{n}_{rid[-8:]} 的倒数切片按 code point", () => {
    for (const [rid, tail] of CLARIFY["id_slices"] as [string, string][]) {
      const cps = [...rid];
      const got = cps.slice(Math.max(0, cps.length - 8)).join("");
      expect(got, JSON.stringify(rid)).toBe(tail);
    }
    // 反例：`slice(-8)` 按码元切，星平面 rid 会切出半个代理对。
    const astral = "cf_" + "𠀀".repeat(6);
    expect(astral.slice(-8)).not.toBe(
      (CLARIFY["id_slices"] as [string, string][]).find(([r]) => r === astral)![1],
    );
  });
});

describe("onto/clarify —— rank", () => {
  for (const r of rows(CLARIFY, "rank")) {
    it(r["name"] as string, () => {
      const oir = CLARIFY_OIR();
      const eng = new ClarificationEngine({
        maxQuestions: r["max_questions"] as number,
        thetaAsk: r["theta_ask"] as number,
      });
      // 输入整条冲突都在 golden 里 —— `real_detected` 那组来自 `detect_all`，
      // 只有 rid 的话这条最像真实场景的用例就还原不出来。
      const input = (r["input"] as Dict[]).map(conflictFromDict);
      expect(input.map((c) => c.rid)).toEqual(r["input_rids"]);
      const out = eng.rank(input, oir);
      expect(out.questions.map(questionToDict)).toEqual(r["questions"]);
      expect(out.autoRepairable.map((c) => c.rid)).toEqual(r["auto_repairable"]);
      expect(out.deferredToTemplate.map((c) => c.rid)).toEqual(r["deferred_to_template"]);
      expect(out.roundTrip.map((c) => c.rid)).toEqual(r["round_trip"]);
      expect(out.hints.map((c) => c.rid)).toEqual(r["hints"]);
      expect(out.stoppedBecause).toBe(r["stopped_because"]);
      expect(clarificationSummary(out)).toEqual(r["summary"]);
    });
  }

  it("没有一条可问时走 for-else，理由是「全部可问的冲突都已提问」", () => {
    // Python 的 for-else：只有一次 break 都没有才补这句。直译成"循环后面接一句"
    // 会把上面两条 break 写进去的原因盖掉，而那两句是运维要读的。
    const out = new ClarificationEngine().rank([], CLARIFY_OIR());
    expect(out.stoppedBecause).toBe("全部可问的冲突都已提问");
    const onlyNonAsk = ["auto", "round_trip", "hint"].map((k) => CONFLICTS.get(k)!);
    expect(new ClarificationEngine().rank(onlyNonAsk, CLARIFY_OIR()).stoppedBecause).toBe(
      "全部可问的冲突都已提问",
    );
  });

  it("阈值文案里的 float 按 Python 的 str() 印（0.35 而不是 0.35000000000000003）", () => {
    const r = byName(CLARIFY, "rank").get("below_theta")!;
    expect(r["stopped_because"]).toContain("阈值 0.35，");
  });

  it("一个选项都没有的冲突，Question 回落成「转为模板必填项」", () => {
    const noOpts = CONFLICTS.get("no_options")!;
    expect(noOpts.options).toHaveLength(0);
    // 它的 eig 是 0，正常路径下进不了 questions —— 直接调 rank 并把阈值放到 -1
    // 才走得到那条回落分支。
    const out = new ClarificationEngine({ thetaAsk: -1 }).rank([noOpts], CLARIFY_OIR());
    expect(out.questions[0]!.options.map((o) => [o.id, o.label])).toEqual([
      ["defer", "转为模板必填项"],
    ]);
  });
});

describe("onto/clarify —— apply_decision", () => {
  for (const a of rows(CLARIFY, "apply")) {
    it(a["name"] as string, () => {
      const oir = CLARIFY_OIR();
      const conflict = conflictFromDict(a["conflict"] as Dict);
      const res = applyDecision(oir, conflict, a["option_id"] as string, {
        note: a["note"] as string,
      });
      expect(res).toEqual(a["result"]);
      expect(oir.toDict()).toEqual(a["oir_after"]);
    });
  }

  it("找不到选项时抛错，消息与 Python 的 KeyError.args[0] 一致", () => {
    const c = CONFLICTS.get("balanced")!;
    for (const [bad, message] of CLARIFY["missing_option"] as [string, string, string][]) {
      // JS 没有 KeyError，按本仓库既有约定（oir.ts / conflict.ts）加 "KeyError: " 前缀。
      expect(() => applyDecision(CLARIFY_OIR(), c, bad)).toThrowError(`KeyError: ${message}`);
    }
  });
});
