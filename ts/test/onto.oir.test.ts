/**
 * OIR 的 golden 校验。
 *
 * 两份 golden：
 *   - `golden/pipeline.oir.json` —— 真材料（材料.xlsx）跑出来的完整 OIR，
 *     7 对象 / 6 行动 / 5 问题。用它做 fromDict → toDict 的往返断言，字段名、
 *     嵌套形状、省略规则全被它钉住。
 *   - `golden/oir.json` —— 由 `tools/golden/oir.py` 导出，补上真材料里没有的
 *     properties / links / rules 三个容器，外加 cite / round3 / 脏输入容错。
 *
 * 期望值一律来自 golden，不手写 —— 手写的是我对 Python 行为的猜测。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BaseType,
  Cardinality,
  OIR,
  Origin,
  RuleKind,
  Status,
  assertionToDict,
  byUser,
  cite,
  cites,
  extracted,
  grounded,
  inferred,
  isAnswered,
  makeActionType,
  makeBusinessRule,
  makeLinkType,
  makeObjectType,
  makeOpenQuestion,
  makePropertyType,
  makeProvenance,
  makeRid,
  oirFromDict,
  parseBaseType,
  parseCardinality,
  parseOrigin,
  parseRuleKind,
  parseStatus,
  provToDict,
  round3,
  validateAssertion,
  withConfidence,
  type Provenance,
} from "../src/onto/oir.js";

const readGolden = (name: string): Record<string, never> =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as Record<
    string,
    never
  >;

const PIPELINE = readGolden("pipeline.oir.json") as unknown as Record<string, unknown>;
const G = readGolden("oir.json") as unknown as {
  cite: { file_name: string; locator: Record<string, unknown>; out: string }[];
  scalars: {
    round3: { in: number; out: number }[];
    snippet_truncation: { in: string; out: string };
    prov_to_dict: Record<string, unknown>;
  };
  assertions: Record<string, unknown>;
  oir: {
    to_dict: Record<string, unknown>;
    validate_clean: string[];
    validate_broken: string[];
    dependents: Record<string, string[]>;
    props_of: Record<string, string[]>;
    orphans: string[];
    objects_without_actions: string[];
    answered: Record<string, boolean>;
  };
  from_dict_dirty: {
    in: Record<string, unknown>;
    out: Record<string, unknown>;
    missing_answer_in: Record<string, unknown>;
    missing_answer_raises: string;
  };
};

// ══════════════════════════════════════════════════════════════════
//  1. 真材料的往返
// ══════════════════════════════════════════════════════════════════
describe("pipeline.oir.json —— 真材料跑出来的 OIR", () => {
  it("fromDict → toDict 闭合（字段名 / 嵌套形状 / 省略规则全靠它钉）", () => {
    expect(oirFromDict(PIPELINE).toDict()).toStrictEqual(PIPELINE);
  });

  it("stats 是重算出来的，不是从输入里抄的", () => {
    const oir = oirFromDict(PIPELINE);
    expect(oir.stats()).toEqual(PIPELINE["stats"]);
    expect(oir.objects.size).toBe(7);
    expect(oir.actions.size).toBe(6);
    expect(oir.questions.size).toBe(5);
  });

  it("出处链原样还原 —— EXTRACTED 不许在往返中被降级成 INFERRED", () => {
    const oir = oirFromDict(PIPELINE);
    const first = [...oir.objects.values()][0]!;
    expect(first.apiName.origin).toBe(Origin.EXTRACTED);
    expect(cites(first.apiName)).toEqual(["材料.xlsx!业务对象实体梳理!R2-2"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. cite() —— 溯源的门面
// ══════════════════════════════════════════════════════════════════
describe("cite() 按 locator.kind 分派出的形态", () => {
  for (const v of G.cite) {
    it(`${JSON.stringify(v.locator)} → ${v.out}`, () => {
      expect(cite(makeProvenance("f1", v.file_name, v.locator))).toBe(v.out);
    });
  }

  it("rows 是垃圾时当场炸，不静默印出 R None-None", () => {
    const p = makeProvenance("f1", "x.xlsx", { kind: "range", rows: 7 });
    expect(() => cite(p)).toThrow(TypeError);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. round(x, 3) 与 snippet[:300]
// ══════════════════════════════════════════════════════════════════
describe("round3 与 Python 的 round(x, 3) 同为 half-even", () => {
  for (const v of G.scalars.round3) {
    it(`${v.in} → ${v.out}`, () => expect(round3(v.in)).toBe(v.out));
  }

  it("朴素写法会错 —— 这些用例正是 Math.round 踩雷的地方", () => {
    // 钉住"为什么不能图省事"：0.0625 上两种写法差一位。
    expect(Math.round(0.0625 * 1000) / 1000).toBe(0.063);
    expect(round3(0.0625)).toBe(0.062);
  });

  it("-0.0 的符号留着（Python round(-0.0001, 3) 是 -0.0）", () => {
    expect(Object.is(round3(-0.0001), -0)).toBe(true);
  });
});

describe("snippet 截断按 code point", () => {
  const t = G.scalars.snippet_truncation;

  it("与 Python 的 s[:300] 逐字相同", () => {
    const p = makeProvenance("f1", "长文.xlsx", { kind: "meta", field: "x" }, {
      snippet: t.in,
      confidence: 0.0625,
    });
    expect(provToDict(p)["snippet"]).toBe(t.out);
    expect(provToDict(p)).toEqual(G.scalars.prov_to_dict);
  });

  it("朴素 slice 会把代理对当两个字符 —— 少一半内容", () => {
    expect([...t.out].length).toBe(300);
    expect(t.in.slice(0, 300)).not.toBe(t.out);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. Assertion 与三个工厂
// ══════════════════════════════════════════════════════════════════
describe("Assertion 工厂", () => {
  const ev = makeProvenance(
    "f3",
    "实体梳理.xlsx",
    { kind: "cell", sheet: "业务对象实体梳理", row: 44, col: "F" },
    { snippet: "计划金额（含税，年度累计）", extractor: "docling", confidence: 0.94 },
  );
  const A = G.assertions;

  it("extracted", () => {
    expect(assertionToDict(extracted("planAmount", ev))).toEqual(A["extracted"]);
  });
  it("extracted + 显式 confidence（Python 的 confidence= 关键字参数）", () => {
    expect(assertionToDict(withConfidence(extracted("label", ev), 1.0))).toEqual(
      A["extracted_conf"],
    );
  });
  it("inferred", () => {
    expect(assertionToDict(inferred(null))).toEqual(A["inferred"]);
  });
  it("byUser 无 note", () => {
    expect(assertionToDict(byUser("采用含税口径"))).toEqual(A["by_user_plain"]);
  });
  it("byUser 带 note —— 人工决策也要留下一条 evidence", () => {
    expect(assertionToDict(byUser("采用含税口径", "王明在评审会上拍板"))).toEqual(
      A["by_user_note"],
    );
  });

  it("EXTRACTED 却没有 evidence 是非法态", () => {
    const bad = { value: "planAmount", origin: Origin.EXTRACTED, evidence: [], confidence: 0.5 };
    expect(validateAssertion(bad, "pt_x.apiName")).toEqual(A["validate_bad"]);
    expect(validateAssertion(inferred("planAmount"), "pt_x.apiName")).toEqual(A["validate_ok"]);
  });

  it("grounded / cites", () => {
    expect([grounded(inferred("x")), grounded(extracted("x", ev))]).toEqual(A["grounded"]);
    expect(cites(extracted("x", ev, ev))).toEqual(A["cites"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. 完整 OIR —— 六个容器都非空
// ══════════════════════════════════════════════════════════════════
/** 与 tools/golden/oir.py 的 build_oir() 一一对应。用 TS 侧的工厂重建同一份
 * OIR，再和 Python 的产物比 —— 这一步同时钉住了每个 dataclass 的默认值。 */
function buildOir(): OIR {
  const xlsx = (row: number, snippet: string): Provenance =>
    makeProvenance(
      "f3",
      "实体梳理.xlsx",
      { kind: "cell", sheet: "业务对象实体梳理", row, col: "F" },
      { snippet, extractor: "docling", confidence: 0.94 },
    );
  const ddl = (object: string, snippet: string): Provenance =>
    makeProvenance("f5", "schema.ddl", { kind: "ddl", object }, {
      snippet,
      extractor: "sqlglot",
      confidence: 0.9,
    });

  const o = new OIR();
  const plan = o.addObject(
    makeObjectType({
      rid: makeRid("ot", "purchase_plan_header"),
      apiName: extracted("purchasePlanHeader", xlsx(2, "采购业务计划头")),
      displayName: extracted("采购业务计划头", xlsx(2, "采购业务计划头")),
      description: inferred("采购需求计划的头表"),
      primaryKey: inferred(["pt_plan_id"]),
      aliases: ["采购需求计划"],
    }),
  );
  const contract = o.addObject(
    makeObjectType({
      rid: makeRid("ot", "clm_contract"),
      apiName: extracted("clmContract", ddl("clm_contract", "CREATE TABLE clm_contract")),
      displayName: extracted("采购合同", xlsx(44, "采购合同")),
      primaryKey: inferred(["pt_contract_id"]),
      owner: "李强",
      status: Status.CONFIRMED,
      conflicts: ["cf_naming_1"],
    }),
  );
  o.addObject(
    makeObjectType({
      rid: makeRid("ot", "supplier"),
      apiName: extracted("supplier", ddl("supplier", "CREATE TABLE supplier")),
      displayName: inferred("供应商"),
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
      required: extracted(true, ddl("pbp_header", "NOT NULL")),
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
  o.addProperty(
    makePropertyType({
      rid: "pt_plan_amount_budget",
      parent: plan.rid,
      apiName: extracted("planAmount", xlsx(44, "planAmount")),
      displayName: extracted("计划金额", xlsx(44, "计划金额")),
      baseType: extracted(BaseType.DECIMAL, xlsx(44, "DECIMAL(18,2)")),
      definition: extracted("含税，年度累计，CNY", xlsx(44, "计划金额（含税，年度累计）")),
      semanticType: inferred("money"),
      unit: extracted("CNY", xlsx(44, "币种=CNY")),
      valueDomain: extracted(["草稿", "已提交", "已审批"], xlsx(45, "状态枚举")),
      owner: "王明",
      status: Status.PROPOSED,
      conflicts: ["cf_semantic_1"],
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
  o.addAction(
    makeActionType({
      rid: "at_createpbp",
      apiName: extracted("createPbp", xlsx(2, "创建PBP")),
      appliesTo: [plan.rid],
      parameters: inferred([{ name: "planId", baseType: "STRING" }]),
      effects: extracted(["create:ot_purchase_plan_header"], xlsx(2, "创建")),
      sourceEndpoint: extracted(
        { path: "/v1/createPbp", display: "创建PBP" },
        xlsx(2, "url=/v1/createPbp"),
      ),
      status: Status.DRAFT_FROM_API,
    }),
  );
  o.addRule(
    makeBusinessRule({
      rid: "br_amount_gate",
      statement: extracted(
        "计划金额超过 100 万时必须走二级审批。",
        xlsx(88, "计划金额超过100万时必须走二级审批"),
      ),
      kind: extracted(RuleKind.AUTHORITY, xlsx(88, "审批权限")),
      appliesTo: [plan.rid],
      actor: extracted("采购计划员", xlsx(88, "责任岗位=采购计划员")),
    }),
  );
  o.addRule(makeBusinessRule({ rid: "br_orphan", statement: inferred("一条没挂上对象的规则。") }));
  o.addQuestion(
    makeOpenQuestion({
      rid: "oq_amount_axis",
      text: extracted("「计划金额」到底是含税还是不含税？", xlsx(44, "计划金额")),
      options: ["含税", "不含税"],
      group: "采购计划管理",
      code: "Q-017",
      appliesTo: ["pt_plan_amount_budget"],
      askedBy: "system",
    }),
  );
  o.addQuestion(
    makeOpenQuestion({
      rid: "oq_answered",
      text: extracted("一条需求能不能只安排部分数量？", xlsx(90, "部分安排")),
      answer: byUser("可以，剩余数量留在原需求上", "王明"),
      group: "采购计划管理",
      code: "Q-046",
      owner: "王明",
      status: Status.CONFIRMED,
    }),
  );
  o.addQuestion(
    makeOpenQuestion({
      rid: "oq_blank_answer",
      text: inferred("空白答复算不算已答？"),
      answer: extracted("   \n  ", xlsx(91, "  ")),
    }),
  );
  return o;
}

describe("完整 OIR（六个容器都非空）", () => {
  it("TS 侧重建的 OIR 与 Python 的 to_dict 逐字段相同", () => {
    expect(buildOir().toDict()).toStrictEqual(G.oir.to_dict);
  });

  it("fromDict → toDict 闭合", () => {
    expect(oirFromDict(G.oir.to_dict).toDict()).toStrictEqual(G.oir.to_dict);
  });

  it("addProperty 把 rid 挂到父对象上，且不重复挂", () => {
    const o = buildOir();
    const plan = o.objects.get(makeRid("ot", "purchase_plan_header"))!;
    expect(plan.properties).toEqual(["pt_plan_id", "pt_plan_amount_budget"]);
    o.addProperty(o.properties.get("pt_plan_id")!);
    expect(plan.properties).toEqual(["pt_plan_id", "pt_plan_amount_budget"]);
  });

  it("validate 干净", () => {
    expect(buildOir().validate()).toEqual(G.oir.validate_clean);
  });

  it("validate 抓结构性问题 —— 空主键 / 空 joinKey 靠 Python 真值语义", () => {
    const o = buildOir();
    o.objects.get(makeRid("ot", "clm_contract"))!.primaryKey = inferred([]);
    o.objects.get(makeRid("ot", "purchase_plan_header"))!.primaryKey = inferred(["pt_ghost"]);
    o.links.get("lt_plan_contract")!.source = "ot_ghost";
    o.links.get("lt_plan_contract")!.joinKey = inferred(null);
    o.properties.get("pt_plan_id")!.parent = "ot_ghost";
    o.properties.get("pt_contract_id")!.apiName = {
      value: "contractId",
      origin: Origin.EXTRACTED,
      evidence: [],
      confidence: 0.5,
    };
    expect(o.validate()).toEqual(G.oir.validate_broken);
    // 空数组的主键必须报 —— 写成 `!value` 的话 JS 里 [] 为真，这条永远不触发
    expect(G.oir.validate_broken).toContain("ot_clm_contract: 未声明主键");
  });

  it("dependents 给出影响半径（排序后去重）", () => {
    const o = buildOir();
    for (const [rid, want] of Object.entries(G.oir.dependents)) {
      expect(o.dependents(rid)).toEqual(want);
    }
  });

  it("propsOf / orphans / objectsWithoutActions", () => {
    const o = buildOir();
    for (const [rid, want] of Object.entries(G.oir.props_of)) {
      expect(o.propsOf(rid).map((p) => p.rid)).toEqual(want);
    }
    expect(o.orphans().map((x) => x.rid)).toEqual(G.oir.orphans);
    expect(o.objectsWithoutActions().map((x) => x.rid)).toEqual(G.oir.objects_without_actions);
    // Python 是 self.objects[rid]，不存在就 KeyError
    expect(() => o.propsOf("不存在的rid")).toThrow();
  });

  it("answered：只有空白的答复仍算未答", () => {
    const o = buildOir();
    const got = Object.fromEntries([...o.questions.values()].map((q) => [q.rid, isAnswered(q)]));
    expect(got).toEqual(G.oir.answered);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. oirFromDict 的容错
// ══════════════════════════════════════════════════════════════════
describe("oirFromDict 吃脏输入", () => {
  it("与 Python 逐字段相同（裸值断言 / 未知 origin / 未知枚举 / 未知状态）", () => {
    expect(oirFromDict(G.from_dict_dirty.in).toDict()).toStrictEqual(G.from_dict_dirty.out);
  });

  it("confidence 明确写 0 会被 Python 的 `or` 吃掉，落回 0.5", () => {
    const out = G.from_dict_dirty.out as { objects: { displayName: { confidence: number } }[] };
    expect(out.objects[0]!.displayName.confidence).toBe(0.5);
  });

  it("枚举里没有的 baseType 原样留着，不抹成默认值", () => {
    const oir = oirFromDict(G.from_dict_dirty.in);
    expect(oir.properties.get("pt_dirty")!.baseType.value).toBe("WEIRD_TYPE");
  });

  it("缺 answer 的问题会连整份 toDict 一起炸 —— 与 Python 同步的已知地雷", () => {
    expect(G.from_dict_dirty.missing_answer_raises).toContain("AttributeError");
    expect(() => oirFromDict(G.from_dict_dirty.missing_answer_in).toDict()).toThrow(TypeError);
  });

  it("行里缺 rid 就炸，不静默丢行", () => {
    expect(() => oirFromDict({ objects: [{ apiName: "x" }] })).toThrow(/rid/);
  });

  it("evidence 里混进非对象就炸 —— 静默产出空 Provenance 等于凭空捏造出处", () => {
    expect(() =>
      oirFromDict({
        objects: [{ rid: "ot_x", apiName: { value: "x", evidence: ["不是对象"] } }],
      }),
    ).toThrow(TypeError);
  });
});

describe("枚举解析：未知值抛错，不用 as 断言把校验删掉", () => {
  it("parseX 对未知值抛", () => {
    expect(() => parseOrigin("外星人")).toThrow(RangeError);
    expect(() => parseStatus("不认识")).toThrow(RangeError);
    expect(() => parseBaseType("WEIRD_TYPE")).toThrow(RangeError);
    expect(() => parseCardinality("ONE_TO_NONE")).toThrow(RangeError);
    expect(() => parseRuleKind("随便")).toThrow(RangeError);
  });

  it("认识的值原样返回", () => {
    expect(parseOrigin("auto_repaired")).toBe(Origin.AUTO_REPAIRED);
    expect(parseStatus("draft_from_api")).toBe(Status.DRAFT_FROM_API);
    expect(parseBaseType("DECIMAL")).toBe(BaseType.DECIMAL);
    expect(parseCardinality("MANY_TO_MANY")).toBe(Cardinality.MANY_TO_MANY);
    expect(parseRuleKind("CALCULATION")).toBe(RuleKind.CALCULATION);
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. Python 侧没覆盖、但 TS 侧必须钉住的
// ══════════════════════════════════════════════════════════════════
describe("Python 没覆盖到、TS 侧有风险的行为", () => {
  it("dependents 按 code point 排，不按 UTF-16 code unit", () => {
    // "￿"(U+FFFF) vs 𠀀(U+20000)：code point 序是 FFFF 在前，
    // 而 JS 默认 sort 按 code unit 会把 U+20000（代理对 D840…）排到前面。
    const o = new OIR();
    o.addObject(
      makeObjectType({ rid: "ot_x", apiName: inferred("x"), displayName: inferred("x") }),
    );
    for (const rid of ["pt_\u{20000}", "pt_￿"]) {
      o.addProperty(
        makePropertyType({
          rid,
          parent: "ot_x",
          apiName: inferred("x"),
          displayName: inferred("x"),
          baseType: inferred(BaseType.STRING),
        }),
      );
    }
    expect(o.dependents("ot_x")).toEqual(["pt_￿", "pt_\u{20000}"]);
    expect(["pt_\u{20000}", "pt_￿"].sort()).toEqual(["pt_\u{20000}", "pt_￿"]);
  });

  it("工厂给的数组是新数组，不与调用方共享引用", () => {
    const aliases = ["别名"];
    const o = makeObjectType({
      rid: "ot_x",
      apiName: inferred("x"),
      displayName: inferred("x"),
      aliases,
    });
    o.aliases.push("又一个");
    expect(aliases).toEqual(["别名"]);
  });

  it("makeRid 就是 kernel/ids 的 rid", () => {
    expect(makeRid("ot", "采购订单头")).toBe("ot_采购订单头");
  });
});
