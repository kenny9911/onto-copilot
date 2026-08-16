/**
 * 冲突检测 + 实体对齐的 golden 校验。
 *
 * 两份 golden，都由 `tools/golden/onto_conflict.py` 从 Python 原件真跑出来：
 *   - `golden/onto.conflict.json` —— difflib 向量、口径轴解析、七个检测器、
 *     auto_repair；
 *   - `golden/onto.align.json` —— 拆词、阻塞、打分、聚类、代表选举、落盘。
 *
 * 期望值一律来自 golden，不手写 —— 手写的是我对 Python 行为的*猜测*。
 * 少数几处 golden 钉不住的（Python 侧本来就不确定的键序、判据宽窄的语义断言）
 * 单独写，并在注释里说清为什么它必须手写。
 *
 * **判据宽窄两个方向都在这里**：写宽了刷假冲突（identical / punctuation_only /
 * both_empty 三个场景必须返回空），写窄了漏真冲突（known_axis / unknown_axis /
 * real_llm 三个场景必须各报一条）。两边任何一侧回归都会在这里红。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SequenceMatcher,
  cmpCodePoint,
  toCodePoints,
} from "../src/onto/difflib.js";
import {
  type Conflict,
  ConflictKind,
  FALLBACK_OPTIONS,
  Handling,
  POLICY,
  autoRepair,
  axisAmbiguities,
  axisDiff,
  canonicalAxes,
  conflictToDict,
  detectAll,
  detectMissingActions,
  detectMissingRequired,
  detectNaming,
  detectOrphans,
  detectPerfunctory,
  detectSemanticDivergence,
  detectTypeMismatch,
  endpointMatches,
  handlingOf,
  irreversibilityOf,
  makeConflict,
  makeOption,
  parseAxes,
  parseConflictKind,
  parseHandling,
  perfunctorySignals,
  primaryClause,
  toCamel,
  undescribedDiff,
} from "../src/onto/conflict.js";
import {
  type AlignPolicy,
  EntityAligner,
  alignAndApply,
  alignSummary,
  makeAlignPolicy,
  pairScoreToDict,
  tokens,
} from "../src/onto/align.js";
import {
  type ObjectType,
  type Provenance,
  BaseType,
  Cardinality,
  OIR,
  cite,
  extracted,
  inferred,
  makeActionType,
  makeLinkType,
  makeObjectType,
  makePropertyType,
  makeProvenance,
  makeRid,
} from "../src/onto/oir.js";

const readGolden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as Record<
    string,
    unknown
  >;

const G = readGolden("onto.conflict.json");
const GA = readGolden("onto.align.json");

type Row = Record<string, unknown>;
const rows = (o: unknown, k: string): Row[] => (o as Record<string, unknown>)[k] as Row[];
const sec = (k: string): Record<string, unknown> => G[k] as Record<string, unknown>;

// ══════════════════════════════════════════════════════════════════
//  0. difflib —— 上面所有东西的地基
// ══════════════════════════════════════════════════════════════════
describe("SequenceMatcher", () => {
  it("ratio / matching blocks / opcodes 与 CPython 逐向量一致", () => {
    for (const c of rows(G, "seqmatch")) {
      const a = toCodePoints(c["a"] as string);
      const b = toCodePoints(c["b"] as string);
      for (const [tag, autojunk] of [
        ["autojunk_off", false],
        ["autojunk_on", true],
      ] as const) {
        const want = c[tag] as Record<string, unknown>;
        const sm = new SequenceMatcher(null, a, b, autojunk);
        const where = `${JSON.stringify(c["a"])} vs ${JSON.stringify(c["b"])} [${tag}]`;
        expect(sm.ratio(), `ratio ${where}`).toBe(want["ratio"]);
        expect(
          sm.getMatchingBlocks().map((m) => [m.a, m.b, m.size]),
          `blocks ${where}`,
        ).toEqual(want["blocks"]);
        expect(
          sm.getOpcodes().map((o) => [o.tag, o.i1, o.i2, o.j1, o.j2]),
          `opcodes ${where}`,
        ).toEqual(want["opcodes"]);
      }
    }
  });

  it("按 code point 而不是 UTF-16 切 —— 星平面字符不许被劈开", () => {
    // "a🙂b" 在 JS 里 length 是 4；按 UTF-16 比会把 🙂 拆成两个代理项，
    // ratio 的分母跟着错，切出来的片段还是半个字符（渲染成 U+FFFD）。
    const a = toCodePoints("a🙂b");
    expect(a).toEqual(["a", "🙂", "b"]);
    expect(new SequenceMatcher(null, a, toCodePoints("ab"), false).ratio()).toBe(
      (2 * 2) / (3 + 2),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  1. 口径的结构化比较
// ══════════════════════════════════════════════════════════════════
describe("口径轴解析", () => {
  it("primary_clause 丢掉注解", () => {
    for (const c of rows(sec("axes"), "primary_clause")) {
      expect(primaryClause(c["in"] as string), JSON.stringify(c["in"])).toBe(c["out"]);
    }
  });

  it("parse_axes 按位置取值，注解里的对照值不算数", () => {
    for (const c of rows(sec("axes"), "parse_axes")) {
      expect([...parseAxes(c["in"] as string)], JSON.stringify(c["in"])).toEqual(c["out"]);
    }
    // whole= 是兼容参数，两种模式当前实现一致
    for (const c of rows(sec("axes"), "parse_axes_whole")) {
      expect([...parseAxes(c["in"] as string, true)], JSON.stringify(c["in"])).toEqual(c["out"]);
    }
  });

  it("axis_ambiguities：正文里就写了两个取值的轴不给值", () => {
    for (const c of rows(sec("axes"), "axis_ambiguities")) {
      expect(axisAmbiguities(c["in"] as string), JSON.stringify(c["in"])).toEqual(c["out"]);
    }
  });

  it("canonical_axes 是口径的规范化签名", () => {
    for (const c of rows(sec("axes"), "canonical_axes")) {
      expect(canonicalAxes(c["in"] as string), JSON.stringify(c["in"])).toBe(c["out"]);
    }
  });

  it("axis_diff 只报两边都识别出且不同的轴", () => {
    for (const c of rows(sec("axes"), "axis_diff")) {
      const got = [...axisDiff(c["a"] as string, c["b"] as string)]
        .map(([k, v]) => [k, [...v]])
        .sort((x, y) => cmpCodePoint(x[0] as string, y[0] as string));
      expect(got, `${c["a"] as string} / ${c["b"] as string}`).toEqual(c["out"]);
    }
  });

  it("undescribed_diff 给出确定性的差异片段", () => {
    for (const c of rows(sec("axes"), "undescribed_diff")) {
      expect(undescribedDiff(c["a"] as string, c["b"] as string)).toEqual(c["out"]);
    }
    for (const c of rows(sec("axes"), "undescribed_diff_limit")) {
      expect(
        undescribedDiff(c["a"] as string, c["b"] as string, c["limit"] as number),
      ).toEqual(c["out"]);
    }
  });

  it("`\\b` 是 Unicode 词边界 —— 「净额net」不许多认出一个 net", () => {
    // 手写这一条是因为它是"判据写宽了"最隐蔽的入口：JS 的 `\b` 只认 ASCII，
    // 照抄 `\bnet\b` 会在汉字与拉丁交界处凭空造出一个词边界。golden 里
    // 「净额net」这条已经把它钉住，这里只是把失败信息说清楚。
    expect(parseAxes("净额net").get("税")).toBe("不含税"); // 命中的是「净额」
    expect(parseAxes("a net b").get("税")).toBe("不含税"); // 真正的独立词
    expect(parseAxes("netto").has("税")).toBe(false);
    expect(parseAxes("_net_").has("税")).toBe(false); // `_` 也是词字符
  });

  it("★ axis_diff 的键序在 Python 侧本来就不确定，TS 固定成 AXES 声明序", () => {
    // Python 是 `pa.keys() & pb.keys()` 上的推导式，键序随进程哈希种子变化
    // （同一份输入连跑六次得到六种顺序）—— 没有稳定顺序可抄。这里钉住 TS 的
    // 选择，免得日后有人"顺手"改成别的顺序而没人发现。
    expect([...axisDiff("含税，年度累计，CNY，计划", "不含税，单次，USD，执行").keys()]).toEqual([
      "税",
      "时间粒度",
      "口径主体",
      "币种",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. 纯函数规则
// ══════════════════════════════════════════════════════════════════
describe("命名 / 敷衍 / 端点匹配", () => {
  it("to_camel", () => {
    for (const c of rows(sec("rules"), "to_camel")) {
      expect(toCamel(c["in"] as string), JSON.stringify(c["in"])).toBe(c["out"]);
    }
  });

  it("perfunctory_signals", () => {
    for (const c of rows(sec("rules"), "perfunctory_signals")) {
      const i = c["in"] as Record<string, unknown>;
      const opts: Parameters<typeof perfunctorySignals>[0] = { value: i["value"] as string };
      if ("column_header" in i) opts.columnHeader = i["column_header"] as string;
      if ("ai_prefill" in i) opts.aiPrefill = i["ai_prefill"] as string;
      if ("expects_definition" in i) opts.expectsDefinition = i["expects_definition"] as boolean;
      if ("column_distinct_ratio" in i) {
        opts.columnDistinctRatio = i["column_distinct_ratio"] as number;
      }
      expect(perfunctorySignals(opts), JSON.stringify(i)).toEqual(c["out"]);
    }
  });

  it("endpoint_matches：只有写端点才可能对应 ActionType", () => {
    for (const c of rows(sec("rules"), "endpoint_matches")) {
      expect(
        endpointMatches(
          c["endpoint"] as Record<string, unknown>,
          c["api_name"] as string,
          c["aliases"] as string[],
        ),
        JSON.stringify(c["endpoint"]),
      ).toBe(c["out"]);
    }
  });

  it("POLICY 表逐项一致 —— 处置方式是分类的全部意义", () => {
    const got = Object.entries(POLICY).map(([kind, p]) => ({
      kind,
      handling: p.handling,
      irreversibility: p.irreversibility,
      evidence_decidable: p.evidenceDecidable,
    }));
    expect(got).toEqual(rows(sec("rules"), "policy"));
  });

  it("枚举解析对未知值抛错，不静默降级", () => {
    expect(parseConflictKind("semantic_divergence")).toBe(ConflictKind.SEMANTIC_DIVERGENCE);
    expect(() => parseConflictKind("nope")).toThrow(RangeError);
    expect(parseHandling("ask_user")).toBe(Handling.ASK_USER);
    expect(() => parseHandling("nope")).toThrow(RangeError);
    expect([...FALLBACK_OPTIONS].sort()).toEqual([
      "defer_to_template",
      "keep_declared",
      "leave_blank",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. fixtures —— 与 tools/golden/onto_conflict.py 一一对应
// ══════════════════════════════════════════════════════════════════
function xlsx(row: number, snippet: string): Provenance {
  return makeProvenance(
    "f3",
    "实体梳理.xlsx",
    { kind: "cell", sheet: "业务对象实体梳理", row, col: "F" },
    { snippet, extractor: "docling", confidence: 0.94 },
  );
}

function ddl(obj: string, snippet: string): Provenance {
  return makeProvenance(
    "f5",
    "schema.ddl",
    { kind: "ddl", object: obj },
    { snippet, extractor: "sqlglot", confidence: 0.9 },
  );
}

function baseOir(): OIR {
  const o = new OIR();
  const plan = o.addObject(
    makeObjectType({
      rid: makeRid("ot", "purchase_plan_header"),
      apiName: extracted("purchasePlanHeader", xlsx(2, "采购业务计划头")),
      displayName: extracted("采购业务计划头", xlsx(2, "采购业务计划头")),
      primaryKey: inferred(["pt_plan_id"]),
    }),
  );
  const contract = o.addObject(
    makeObjectType({
      rid: makeRid("ot", "clm_contract"),
      apiName: extracted("clmContract", ddl("clm_contract", "CREATE TABLE clm_contract")),
      displayName: extracted("采购合同", xlsx(44, "采购合同")),
      primaryKey: inferred(["pt_contract_id"]),
    }),
  );
  o.addProperty(
    makePropertyType({
      rid: "pt_plan_id",
      parent: plan.rid,
      apiName: extracted("planId", xlsx(2, "planId")),
      displayName: extracted("计划编号", xlsx(2, "计划编号")),
      baseType: extracted(BaseType.STRING, ddl("pbp_header", "plan_id VARCHAR(32)")),
      definition: extracted("主键", xlsx(2, "主键")),
    }),
  );
  o.addProperty(
    makePropertyType({
      rid: "pt_contract_id",
      parent: contract.rid,
      apiName: extracted("contractId", ddl("clm_contract", "contract_id VARCHAR(32)")),
      displayName: extracted("合同编号", ddl("clm_contract", "contract_id")),
      baseType: extracted(BaseType.STRING, ddl("clm_contract", "contract_id VARCHAR(32)")),
      definition: extracted("主键", ddl("clm_contract", "PRIMARY KEY")),
    }),
  );
  // ★ 同名同类型，只有口径不同 —— 纯 schema 比对发现不了
  o.addProperty(
    makePropertyType({
      rid: "pt_plan_amount_budget",
      parent: plan.rid,
      apiName: extracted("planAmount", xlsx(44, "planAmount")),
      displayName: extracted("计划金额", xlsx(44, "计划金额")),
      baseType: extracted(BaseType.DECIMAL, xlsx(44, "DECIMAL(18,2)")),
      definition: extracted("含税，年度累计，CNY", xlsx(44, "计划金额（含税，年度累计）")),
      owner: "王明",
    }),
  );
  o.addProperty(
    makePropertyType({
      rid: "pt_plan_amount_contract",
      parent: contract.rid,
      apiName: extracted("planAmount", ddl("clm_contract", "plan_amount")),
      displayName: extracted("计划金额", ddl("clm_contract", "plan_amount")),
      baseType: extracted(BaseType.DECIMAL, ddl("clm_contract", "DECIMAL(18,2)")),
      definition: extracted("不含税，单次，CNY", ddl("clm_contract", "-- 不含税·单次")),
      owner: "李强",
    }),
  );
  o.addLink(
    makeLinkType({
      rid: "lt_plan_contract",
      apiName: extracted("planContracts", ddl("clm_contract", "FOREIGN KEY (plan_id)")),
      source: plan.rid,
      target: contract.rid,
      cardinality: extracted(Cardinality.ONE_TO_MANY, ddl("clm_contract", "FK")),
      joinKey: extracted(
        { fromProp: "pt_plan_id", toProp: "pt_contract_id" },
        ddl("clm_contract", "REFERENCES pbp_header(plan_id)"),
      ),
    }),
  );
  return o;
}

/** 两条同名属性，只有口径不同。**故意不挂父对象** —— 与 Python 侧一致。 */
function twoDefs(a: string, b: string): OIR {
  const o = new OIR();
  for (const [rid, defn] of [
    ["p1", a],
    ["p2", b],
  ] as const) {
    const p = xlsx(9, defn);
    o.properties.set(
      rid,
      makePropertyType({
        rid,
        parent: "ot_x",
        apiName: extracted("planAmount", p),
        displayName: extracted("计划金额", p),
        baseType: extracted(BaseType.DECIMAL, p),
        definition: extracted(defn, p),
      }),
    );
  }
  return o;
}

function addProp(
  o: OIR,
  rid: string,
  parent: string,
  api: string,
  defn: string,
  base: BaseType = BaseType.DECIMAL,
  disp = "计划金额",
): void {
  const p = xlsx(9, defn);
  o.addProperty(
    makePropertyType({
      rid,
      parent,
      apiName: extracted(api, p),
      displayName: extracted(disp, p),
      baseType: extracted(base, p),
      definition: extracted(defn, p),
    }),
  );
}

/** 判据"写宽了"的反向样本 + 每类规则各一条真该报的。 */
function messyOir(): OIR {
  const o = new OIR();
  const good = o.addObject(
    makeObjectType({
      rid: "ot_good",
      apiName: extracted("purchasePlan", xlsx(1, "x")),
      displayName: extracted("采购计划", xlsx(1, "x")),
      primaryKey: inferred(["pt_ok"]),
    }),
  );
  const bad = o.addObject(
    makeObjectType({
      rid: "ot_bad",
      apiName: extracted("采购合同", xlsx(2, "y")),
      displayName: extracted("采购合同", xlsx(2, "y")),
      primaryKey: inferred([]),
    }),
  );
  o.addObject(
    makeObjectType({
      rid: "ot_abbr",
      apiName: extracted("po", xlsx(3, "z")),
      displayName: extracted("采购订单", xlsx(3, "z")),
      primaryKey: inferred(["pt_ok"]),
    }),
  );
  addProp(o, "pt_ok", good.rid, "planId", "计划编号，主键", BaseType.STRING, "计划编号");
  addProp(o, "pt_snake", good.rid, "plan_amount", "含税，年度累计", BaseType.DECIMAL);
  o.addProperty(
    makePropertyType({
      rid: "pt_nodef",
      parent: bad.rid,
      apiName: extracted("contractAmount", xlsx(5, "w")),
      displayName: extracted("", xlsx(5, "w")),
      baseType: extracted(BaseType.DECIMAL, xlsx(5, "w")),
      definition: inferred("   "),
      owner: "李强",
    }),
  );
  o.addAction(
    makeActionType({
      rid: "at_submit",
      apiName: extracted("submitPlan", xlsx(6, "s")),
      appliesTo: ["ot_good"],
    }),
  );
  return o;
}

function dumpOir(o: OIR): Record<string, unknown> {
  return {
    objects: [...o.objects.values()].map((x) => ({
      rid: x.rid,
      apiName: x.apiName.value,
      apiNameOrigin: x.apiName.origin,
      displayName: x.displayName.value,
      aliases: [...x.aliases],
      properties: [...x.properties],
      conflicts: [...x.conflicts],
    })),
    properties: [...o.properties.values()].map((x) => ({
      rid: x.rid,
      parent: x.parent,
      apiName: x.apiName.value,
      apiNameOrigin: x.apiName.origin,
      definition: x.definition.value,
      conflicts: [...x.conflicts],
    })),
    links: [...o.links.values()].map((x) => ({
      rid: x.rid,
      from: x.source,
      to: x.target,
      apiName: x.apiName.value,
      conflicts: [...x.conflicts],
    })),
    actions: [...o.actions.values()].map((x) => ({
      rid: x.rid,
      apiName: x.apiName.value,
      apiNameOrigin: x.apiName.origin,
      appliesTo: [...x.appliesTo],
    })),
  };
}

/** 与导出脚本里的 `norm_conflict` 同一套规则：抹掉 Python 侧本来就不稳的轴序。 */
function normConflict(c: Conflict): Record<string, unknown> {
  const d = conflictToDict(c);
  if (c.kind !== ConflictKind.SEMANTIC_DIVERGENCE) return d;
  const i = c.summary.indexOf("）：");
  expect(i, `summary 里找不到「）：」: ${c.summary}`).toBeGreaterThanOrEqual(0);
  const axes = c.summary.slice(i + 2);
  d["summary"] = null;
  d["summary_head"] = c.summary.slice(0, i) + "）：";
  d["summary_axes"] = axes.startsWith("差在这几处：")
    ? [axes]
    : axes.split("、").sort(cmpCodePoint);
  return d;
}

const norm = (cs: readonly Conflict[]): Record<string, unknown>[] => cs.map(normConflict);

const ENDPOINTS: Record<string, unknown>[] = [
  {
    operationId: "submitPurchasePlan",
    method: "post",
    path: "/purchase-plans/{id}/submit",
    pointer: "$.paths./purchase-plans",
  },
  { operationId: "createClmContract", method: "post", path: "/contracts" },
  { operationId: "listSuppliers", method: "get", path: "/suppliers" },
];

const REAL_A =
  "计划金额。口径：含税，年度累计，CNY（Excel 批注 R5-5 与 DDL 注释 " +
  "pbp_header.plan_amount '含税·年度累计·CNY' 一致）。注意与 " +
  "clmContract.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)" +
  "上口径不同，两处均保留，交业务方拍板";
const REAL_B =
  "计划金额。口径：不含税，单次，CNY（Excel 批注 R8-8 与 DDL 注释 " +
  "clm_contract.plan_amount '不含税·单次·CNY' 一致）。注意与 " +
  "pbpHeader.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)" +
  "上口径不同，两处均保留，交业务方拍板";

// ══════════════════════════════════════════════════════════════════
//  4. 检测器
// ══════════════════════════════════════════════════════════════════
const D = (k: string): unknown => (G["detectors"] as Record<string, unknown>)[k];

describe("口径分歧（产品最值钱的输出）", () => {
  it("同名同类型、只有口径不同 —— 纯 schema 比对发现不了", () => {
    expect(norm(detectSemanticDivergence(baseOir()))).toEqual(D("semantic_divergence_base"));
  });

  it("判据宽窄两个方向都被钉住", () => {
    for (const c of D("semantic_divergence_cases") as Row[]) {
      expect(
        norm(detectSemanticDivergence(twoDefs(c["a"] as string, c["b"] as string))),
        c["name"] as string,
      ).toEqual(c["out"]);
    }
  });

  it("三处同名聚成一条，不按两两配对", () => {
    const o = new OIR();
    for (const [rid, defn] of [
      ["p1", "含税，年度累计"],
      ["p2", "不含税，单次"],
      ["p3", "含税，年度累计"],
    ] as const) {
      const p = xlsx(9, defn);
      o.properties.set(
        rid,
        makePropertyType({
          rid,
          parent: "ot_x",
          apiName: extracted("planAmount", p),
          displayName: extracted("计划金额", p),
          baseType: extracted(BaseType.DECIMAL, p),
          definition: extracted(defn, p),
        }),
      );
    }
    expect(norm(detectSemanticDivergence(o))).toEqual(D("semantic_divergence_three"));
  });

  // ── 下面几条是对 golden 的"读法"，让回归失败时一眼看懂坏在哪 ──
  it("写窄了会漏：认不出轴也必须报，并明说判不出是哪一维", () => {
    const cs = detectSemanticDivergence(
      twoDefs("计划金额取工艺路线上首道工序的产能上限", "计划金额取末道工序的产能下限"),
    );
    expect(cs).toHaveLength(1);
    expect(handlingOf(cs[0] as Conflict)).toBe(Handling.ASK_USER);
    expect((cs[0] as Conflict).summary).toContain("判不出是哪一维");
    expect((cs[0] as Conflict).summary).toContain("首");
    expect((cs[0] as Conflict).summary).toContain("末");
  });

  it("写宽了会刷噪声：字面/标点相同的一律闭嘴", () => {
    expect(detectSemanticDivergence(twoDefs("含税总价", "含税总价"))).toEqual([]);
    expect(detectSemanticDivergence(twoDefs("含税、年度累计。", "含税，年度累计"))).toEqual([]);
    expect(detectSemanticDivergence(twoDefs("", ""))).toEqual([]);
  });

  it("认得出轴时不许退化成「差在这几个字」", () => {
    const cs = detectSemanticDivergence(
      twoDefs("本次采购的计划金额，指含税总价", "计划金额按不含税口径统计"),
    );
    expect(cs).toHaveLength(1);
    expect((cs[0] as Conflict).summary).toContain("税（含税 vs 不含税）");
    expect((cs[0] as Conflict).summary).not.toContain("判不出");
  });

  it("真实 LLM 长口径仍判得出税轴与时间粒度轴", () => {
    expect([...axisDiff(REAL_A, REAL_B)]).toEqual([
      ["税", ["含税", "不含税"]],
      ["时间粒度", ["年度累计", "单次"]],
    ]);
  });

  it("报冲突 ≠ 裁决：选项里不许出现推荐字段", () => {
    const cs = detectSemanticDivergence(
      twoDefs("计划金额取首道工序产能上限", "计划金额取末道工序产能下限"),
    );
    const opts = (cs[0] as Conflict).options;
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(Object.keys(o)).not.toContain("recommended");
  });

  it("证据引用的形状不能变 —— 它是这条冲突可信的全部理由", () => {
    // locator 原样带过来，cite() 能把人送回那一格 / 那一句
    const c = detectSemanticDivergence(baseOir())[0] as Conflict;
    expect(c.evidence.map(cite)).toEqual([
      "实体梳理.xlsx!业务对象实体梳理!R44CF",
      "schema.ddl#clm_contract",
    ]);
    expect(c.evidence[0]?.locator).toEqual({
      kind: "cell",
      sheet: "业务对象实体梳理",
      row: 44,
      col: "F",
    });
    // 每个可选项也要拿得出出处，否则等于让人凭感觉拍板
    expect(c.options.filter((o) => o.evidence.length > 0)).toHaveLength(3);
  });
});

describe("规则检测器", () => {
  it("命名违规", () => {
    expect(norm(detectNaming(messyOir()))).toEqual(D("naming_messy"));
    expect(norm(detectNaming(messyOir(), ["po"]))).toEqual(D("naming_with_dictionary"));
  });

  it("必填缺失", () => {
    expect(norm(detectMissingRequired(messyOir()))).toEqual(D("missing_required_messy"));
  });

  it("孤立对象", () => {
    expect(norm(detectOrphans(messyOir()))).toEqual(D("orphans_messy"));
    expect(norm(detectOrphans(baseOir()))).toEqual(D("orphans_base"));
  });

  it("缺 ActionType —— 聚合成一个政策问题，不是每个对象问一次", () => {
    expect(norm(detectMissingActions(baseOir(), ENDPOINTS))).toEqual(D("missing_actions_base"));
    expect(norm(detectMissingActions(baseOir(), null))).toEqual(D("missing_actions_no_endpoints"));
    expect(
      norm(
        detectMissingActions(baseOir(), [
          { operationId: "listPlans", method: "get", path: "/p" },
        ]),
      ),
    ).toEqual(D("missing_actions_get_only"));
    expect(norm(detectMissingActions(messyOir(), ENDPOINTS))).toEqual(
      D("missing_actions_all_covered"),
    );
  });

  it("类型不符（由确定性 profiler 供数，不交模型）", () => {
    expect(
      norm(
        detectTypeMismatch(baseOir(), {
          pt_plan_amount_budget: { inferred_type: "STRING", sample_size: 1200 },
          pt_plan_id: { inferred_type: "STRING" },
          pt_contract_id: { inferred_type: "INTEGER" },
          pt_ghost: { inferred_type: "STRING" },
          pt_plan_amount_contract: { sample_size: 5 },
        }),
      ),
    ).toEqual(D("type_mismatch"));
  });

  it("疑似敷衍", () => {
    expect(
      norm(
        detectPerfunctory([
          {
            rid: "pt_a",
            field: "口径定义",
            value: "口径定义",
            column_header: "口径定义",
            owner: "王明",
          },
          { rid: "pt_b", field: "口径定义", value: "不含税，单次结算", owner: "李强" },
          { rid: "pt_c", value: "待定" },
          {
            rid: "pt_d",
            field: "责任人",
            value: "王明",
            expects_definition: false,
            column_distinct_ratio: 0.02,
          },
        ]),
      ),
    ).toEqual(D("perfunctory"));
  });
});

describe("汇总与自动修", () => {
  it("detect_all 的顺序 + 反向挂载到实体上", () => {
    const full = baseOir();
    const cs = detectAll(full, {
      endpoints: ENDPOINTS,
      profiles: { pt_plan_amount_budget: { inferred_type: "STRING", sample_size: 1200 } },
      dictionary: ["po"],
      returnedCells: [{ rid: "pt_plan_id", field: "口径定义", value: "待定", owner: "王明" }],
    });
    expect({ conflicts: norm(cs), oir_after: dumpOir(full) }).toEqual(D("detect_all_base"));

    const messy = messyOir();
    const mcs = detectAll(messy);
    expect({ conflicts: norm(mcs), oir_after: dumpOir(messy) }).toEqual(D("detect_all_messy"));
  });

  it("auto_repair 只碰可逆、零语义损失的那一类", () => {
    const rep = messyOir();
    const log = autoRepair(rep, detectNaming(rep));
    expect({ log, oir_after: dumpOir(rep) }).toEqual(D("auto_repair_naming"));
    for (const e of log) expect(e["reversible"]).toBe(true);

    // 口径统一会丢信息 —— 边界必须保守到"一条都不碰"
    const div = baseOir();
    const noop = autoRepair(div, detectSemanticDivergence(div));
    expect({ log: noop, oir_after: dumpOir(div) }).toEqual(D("auto_repair_divergence_is_noop"));
    expect(noop).toEqual([]);
    expect(div.properties.get("pt_plan_amount_budget")?.definition.value).toBe(
      "含税，年度累计，CNY",
    );
  });

  it("makeConflict / handlingOf / irreversibilityOf 走的是同一张 POLICY 表", () => {
    const c = makeConflict("cf_x", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a"], "s", {
      options: [makeOption("only", "唯一选择")],
    });
    expect(handlingOf(c)).toBe(Handling.ASK_USER);
    expect(irreversibilityOf(c)).toBe(1.0);
    expect(conflictToDict(c)["handling"]).toBe("ask_user");
    // 未知 kind 直接炸，不静默当成 HINT
    const bogus = { ...c, kind: "nope" as ConflictKind };
    expect(() => handlingOf(bogus)).toThrow(/KeyError/u);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. 实体对齐
// ══════════════════════════════════════════════════════════════════
function alX(snip: string): Provenance {
  return makeProvenance(
    "f3",
    "实体梳理.xlsx",
    { kind: "cell", sheet: "S", row: 2, col: "C" },
    { snippet: snip, extractor: "docling" },
  );
}

function alD(obj: string, snip: string): Provenance {
  return makeProvenance(
    "f5",
    "schema.ddl",
    { kind: "ddl", object: obj },
    { snippet: snip, extractor: "sqlglot" },
  );
}

function alObj(
  rid: string,
  api: string,
  disp: string,
  ev: Provenance,
  aliases: readonly string[] = [],
): ObjectType {
  return makeObjectType({
    rid,
    apiName: extracted(api, ev),
    displayName: extracted(disp, ev),
    primaryKey: inferred([] as string[]),
    aliases: [...aliases],
  });
}

function alProp(o: OIR, rid: string, parent: string, api: string, base = BaseType.STRING): void {
  o.addProperty(
    makePropertyType({
      rid,
      parent,
      apiName: extracted(api, alX(api)),
      displayName: extracted(api, alX(api)),
      baseType: extracted(base, alX(api)),
      definition: extracted("", alX(api)),
    }),
  );
}

const SCENARIOS: Record<string, () => OIR> = {
  /** DDL 的 pbpHeader 和梳理表的 purchasePlanHeader 是同一个东西。 */
  merge: () => {
    const o = new OIR();
    const a = o.addObject(
      alObj("ot_a", "pbpHeader", "采购业务计划头", alD("pbp_header", "CREATE TABLE pbp_header")),
    );
    const b = o.addObject(
      alObj("ot_b", "purchasePlanHeader", "采购需求计划", alX("采购需求计划"), ["pbpHeader"]),
    );
    alProp(o, "p1", a.rid, "planId");
    alProp(o, "p2", a.rid, "planAmount");
    alProp(o, "p3", b.rid, "planId");
    alProp(o, "p4", b.rid, "planAmount");
    return o;
  },
  election: () => {
    const o = new OIR();
    const biz = o.addObject(alObj("ot_biz", "purchasePlan", "采购计划", alX("采购计划")));
    const phys = o.addObject(
      alObj("ot_phys", "pbpHeader", "采购业务计划头", alD("pbp_header", "CREATE TABLE")),
    );
    alProp(o, "p1", biz.rid, "planId");
    alProp(o, "p2", phys.rid, "planId");
    alProp(o, "p3", biz.rid, "planAmount");
    alProp(o, "p4", phys.rid, "planAmount");
    return o;
  },
  /** 名字像但结构对不上 —— 错误合并之后极难拆开。 */
  not_merged: () => {
    const o = new OIR();
    const a = o.addObject(alObj("ot_a", "purchasePlan", "采购计划", alX("采购计划")));
    const b = o.addObject(alObj("ot_b", "purchasePlanTemplate", "采购计划模板", alX("模板")));
    alProp(o, "p1", a.rid, "planId");
    alProp(o, "p2", a.rid, "planAmount");
    alProp(o, "p3", b.rid, "templateId");
    alProp(o, "p4", b.rid, "layoutJson");
    return o;
  },
  no_structure: () => {
    const o = new OIR();
    o.addObject(alObj("ot_a", "purchasePlan", "采购计划", alX("A")));
    o.addObject(alObj("ot_b", "purchasePlan", "采购计划", alD("t", "B")));
    return o;
  },
  alias_only: () => {
    const o = new OIR();
    o.addObject(alObj("ot_a", "pbpHeader", "采购业务计划头", alD("t", "x")));
    o.addObject(
      alObj("ot_b", "purchasePlanHeader", "采购需求计划", alX("y"), ["pbpHeader"]),
    );
    return o;
  },
  transitive: () => {
    const o = new OIR();
    const specs: [string, string][] = [
      ["ot_a", "pbpHeader"],
      ["ot_b", "purchasePlanHeader"],
      ["ot_c", "planHeader"],
    ];
    specs.forEach(([rid, api], i) => {
      o.addObject(alObj(rid, api, "采购计划头", i === 0 ? alD("t", api) : alX(api)));
      for (const f of ["planId", "planAmount", "planName"]) alProp(o, `${rid}_${f}`, rid, f);
    });
    return o;
  },
  repoint: () => {
    const o = new OIR();
    const a = o.addObject(alObj("ot_a", "pbpHeader", "计划头", alD("t", "x")));
    const b = o.addObject(alObj("ot_b", "purchasePlanHeader", "计划头", alX("y")));
    const c = o.addObject(alObj("ot_c", "clmContract", "采购合同", alD("c", "z")));
    alProp(o, "p1", a.rid, "planId");
    alProp(o, "p2", b.rid, "planId");
    alProp(o, "p3", a.rid, "planAmount");
    alProp(o, "p4", b.rid, "planAmount");
    alProp(o, "p5", c.rid, "contractId");
    const ev = alD("clm", "FK");
    o.addLink(
      makeLinkType({
        rid: "lt",
        apiName: extracted("planContracts", ev),
        source: "ot_b",
        target: "ot_c",
        cardinality: extracted(Cardinality.ONE_TO_MANY, ev),
        joinKey: inferred(null),
      }),
    );
    o.addAction(
      makeActionType({
        rid: "at",
        apiName: extracted("submitPlan", ev),
        appliesTo: ["ot_b", "ot_c"],
      }),
    );
    return o;
  },
  nothing_common: () => {
    const o = new OIR();
    for (const [rid, api] of [
      ["ot_a", "purchasePlan"],
      ["ot_b", "supplierBank"],
      ["ot_c", "taxCode"],
    ] as const) {
      o.addObject(alObj(rid, api, api, alX(api)));
    }
    return o;
  },
  thresholds: () => {
    const o = new OIR();
    const a = o.addObject(alObj("ot_a", "purchasePlan", "采购计划", alX("A")));
    const b = o.addObject(alObj("ot_b", "purchasePlanV2", "采购计划V2", alX("B")));
    alProp(o, "p1", a.rid, "planId");
    alProp(o, "p2", b.rid, "planId");
    return o;
  },
  /** 主键类型一致要给结构分加 0.2，且 min(1.0, …) 要封顶。 */
  pk_types: () => {
    const o = new OIR();
    o.addObject(
      makeObjectType({
        rid: "ot_a",
        apiName: extracted("pbpHeader", alD("t", "x")),
        displayName: extracted("计划头", alD("t", "x")),
        primaryKey: inferred(["p1"]),
      }),
    );
    o.addObject(
      makeObjectType({
        rid: "ot_b",
        apiName: extracted("purchasePlanHeader", alX("y")),
        displayName: extracted("计划头", alX("y")),
        primaryKey: inferred(["p2"]),
      }),
    );
    alProp(o, "p1", "ot_a", "planId");
    alProp(o, "p2", "ot_b", "planId");
    return o;
  },
  single: () => {
    const o = new OIR();
    o.addObject(alObj("ot_only", "purchasePlan", "采购计划", alX("A")));
    return o;
  },
  empty: () => new OIR(),
};

/** 与导出脚本的 ALIGN_SCENARIOS 一一对应（名字 → 场景 + 策略）。 */
const ALIGN_CASES: [string, string, AlignPolicy | null][] = [
  ["merge", "merge", null],
  ["election", "election", null],
  ["not_merged", "not_merged", null],
  ["no_structure", "no_structure", null],
  ["alias_only", "alias_only", null],
  ["transitive", "transitive", null],
  ["repoint", "repoint", null],
  ["nothing_common", "nothing_common", null],
  ["thresholds_default", "thresholds", null],
  ["thresholds_strict", "thresholds", makeAlignPolicy({ mergeAt: 0.99 })],
  ["thresholds_loose", "thresholds", makeAlignPolicy({ mergeAt: 0.3 })],
  [
    "no_structural_guard_off",
    "no_structure",
    makeAlignPolicy({ mergeAt: 0.5, requireStructural: false }),
  ],
  ["pk_types", "pk_types", null],
  ["single", "single", null],
  ["empty", "empty", null],
];

describe("实体对齐", () => {
  it("拆词：拉丁走 camelCase，中文走字符二元组，结构词剔除", () => {
    for (const c of rows(GA, "tokens")) {
      expect([...tokens(c["in"] as string)].sort(cmpCodePoint), JSON.stringify(c["in"])).toEqual(
        c["out"],
      );
    }
  });

  it("阻塞：三种键缺一不可，过于常见的键（别名除外）丢掉", () => {
    const want = new Map(rows(GA, "blocking").map((r) => [r["name"] as string, r["pairs"]]));
    for (const [name, scen, policy] of ALIGN_CASES) {
      const make = SCENARIOS[scen];
      if (make === undefined) throw new Error(`未知场景 ${scen}`);
      const o = make();
      const objs = [...o.objects.values()];
      const pairs =
        objs.length > 0
          ? new EntityAligner(policy).blocking(objs, o).map(([a, b]) => [a.rid, b.rid])
          : [];
      expect(pairs, name).toEqual(want.get(name));
    }
  });

  it("打分明细 / 聚类 / 代表选举 / 落盘全部逐场景一致", () => {
    const want = new Map(rows(GA, "scenarios").map((r) => [r["name"] as string, r]));
    for (const [name, scen, policy] of ALIGN_CASES) {
      const make = SCENARIOS[scen];
      if (make === undefined) throw new Error(`未知场景 ${scen}`);
      const o = make();
      const [result, log] = alignAndApply(o, policy);
      const w = want.get(name) as Row;
      // 策略表本身也对一遍 —— 两侧的场景表漂了必须当场发现
      expect(
        policy === null
          ? null
          : {
              merge_at: policy.mergeAt,
              review_at: policy.reviewAt,
              require_structural: policy.requireStructural,
            },
        `${name} policy`,
      ).toEqual(w["policy"]);
      expect(
        {
          clusters: result.clusters,
          merged: [...result.merged].map(([k, v]) => [k, v]),
          uncertain: result.uncertain.map(pairScoreToDict),
          scores: result.scores.map(pairScoreToDict),
          summary: alignSummary(result),
        },
        `${name} result`,
      ).toEqual(w["result"]);
      expect(log, `${name} log`).toEqual(w["apply_log"]);
      expect(dumpOir(o), `${name} oir`).toEqual(w["oir_after"]);
    }
  });

  // ── 下面几条把 golden 的含义写成人话，回归时一眼看懂坏在哪 ──
  it("名字像但结构毫无交集 —— 不合并，进人工复核队列", () => {
    const o = (SCENARIOS["no_structure"] as () => OIR)();
    const result = new EntityAligner().align(o);
    expect([...result.merged]).toEqual([]);
    expect(result.uncertain.length).toBeGreaterThan(0);
    expect(result.uncertain.some((s) => s.reasons.some((r) => r.includes("无结构证据")))).toBe(
      true,
    );
  });

  it("字段毫无重叠的两个对象不许被合并", () => {
    const o = (SCENARIOS["not_merged"] as () => OIR)();
    const [, log] = alignAndApply(o);
    expect(o.objects.size).toBe(2);
    expect(log).toEqual([]);
  });

  it("物理名（有 DDL 支撑）赢得代表选举", () => {
    const o = (SCENARIOS["election"] as () => OIR)();
    alignAndApply(o);
    expect([...o.objects.keys()]).toEqual(["ot_phys"]);
  });

  it("合并后关系两端与行动的 appliesTo 都跟着改挂", () => {
    const o = (SCENARIOS["repoint"] as () => OIR)();
    alignAndApply(o);
    expect([...o.objects.keys()].sort()).toEqual(["ot_a", "ot_c"]);
    expect(o.links.get("lt")?.source).toBe("ot_a");
    expect(o.actions.get("at")?.appliesTo).toEqual(["ot_a", "ot_c"]);
    for (const rid of ["p1", "p2", "p3", "p4"]) {
      expect(o.properties.get(rid)?.parent).toBe("ot_a");
    }
  });

  it("A≡B、B≡C 就该是一个簇", () => {
    const o = (SCENARIOS["transitive"] as () => OIR)();
    alignAndApply(o);
    expect(o.objects.size).toBe(1);
  });

  it("毫无共词的对象对不进入打分", () => {
    const o = (SCENARIOS["nothing_common"] as () => OIR)();
    expect(new EntityAligner().align(o).scores).toEqual([]);
  });

  it("理由串是 Python 的 list repr —— 审计账要逐字对得上", () => {
    const o = (SCENARIOS["merge"] as () => OIR)();
    const s = new EntityAligner().align(o).scores[0];
    // 单引号 + `, ` 分隔 + 非 ASCII 可打印字符原样 —— 就是 Python 的 list repr。
    // 「header」是结构词，被 tokens() 剔掉了，所以共享词元只剩两个中文二元组。
    expect(s?.reasons).toContain("共享词元 ['计划', '采购']");
    expect(s?.reasons).toContain("别名重合 ['pbpheader']");
  });

  it("阈值可调：调紧不合、调松就合", () => {
    const strict = new EntityAligner(makeAlignPolicy({ mergeAt: 0.99 })).align(
      (SCENARIOS["thresholds"] as () => OIR)(),
    );
    const loose = new EntityAligner(makeAlignPolicy({ mergeAt: 0.3 })).align(
      (SCENARIOS["thresholds"] as () => OIR)(),
    );
    expect(strict.merged.size).toBe(0);
    expect(loose.merged.size).toBeGreaterThan(0);
  });
});
