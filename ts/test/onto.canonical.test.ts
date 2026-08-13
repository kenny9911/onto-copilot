/**
 * OntologyPackage v1 归一层的 golden 校验。
 *
 * 全部期望值来自 `golden/canonical.json`（`tools/golden/canonical.py` 导出，
 * 字节确定）。**一个手写的期望值都没有** —— 手写的是我对 Python 行为的猜测，
 * golden 是它的事实。
 *
 * 这份测试的重心不是"跑通四条主链路"（那部分 `scenarios` 一次比对整包就够了），
 * 而是**逐条钉住归一规则的边界**：
 *
 *   · `canonicalId` 的前缀剥除只剥一层、strip 用的是 Python 的空白集；
 *   · `stableInputId` 对已规范 id 幂等 —— 这是"重跑一次不产生新 id"的地基；
 *   · `dataKind` 的命中顺序；
 *   · "差点该合并但不该合并"的十组近似名（`near_miss` 场景）必须拿到十个 id；
 *   · OIR 与 Flow 用不同前缀指同一个动作时**必须**合并（`merge_action_prefixes`）。
 *
 * 归一规则宽一格 = 两个业务对象静默合成一个 = 产物里少一行且没人报错。
 * 所以每条规则既有"该合并"的正例，也有"差一点就合并"的反例。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../src/kernel/ids.js";
import {
  COLLECTIONS,
  EvidenceIndex,
  KeyError,
  ONTOLOGY_PACKAGE_JSON_SCHEMA,
  OntologyPackage,
  SCHEMA_URL,
  SCHEMA_VERSION,
  ValueError,
  buildPackage,
  canonicalId,
  dataKind,
  exportPackage,
  normaliseDecision,
  packageFromDict,
  packageIdOf,
  pyStr,
  pyStrip,
  pyValue,
  questionInput,
  stableInputId,
  validatePackage,
  type BuildPackageOptions,
} from "../src/onto/canonical.js";

type Dict = Record<string, unknown>;

const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "canonical.json"), "utf8"),
) as Dict;

function section<T>(name: string): T {
  return GOLDEN[name] as T;
}

const UNITS = section<Dict>("units");
const EVIDENCE = section<Dict>("evidence");
const ADAPTERS = section<Dict>("adapters");
const SCENARIOS = section<Dict[]>("scenarios");
const VALIDATION = section<Dict[]>("validation");
const SERIALIZATION = section<Dict>("serialization");
const BUILD_RAISES = section<Dict[]>("build_raises");
const DIVERGENCE = section<Dict>("divergence");

/**
 * ── 唯一的已知语言边界：整数值的 float ──────────────────────────
 *
 * Evidence id 是 `canonical_json(记录)` 的 sha256。记录里的 `confidence` 在
 * Python 内存里是 float：`1.0` 序列化成 `"1.0"`，而 JS 里 `1` 与 `1.0` 是同一个
 * 值，`kernel/ids.ts` 的 canonicalJson 只能写 `"1"` —— 于是这条证据的 `ev.*`
 * 两边不同。**这不是本模块能修的**（JS 没有 float 类型），ids.ts 的文件头把它
 * 记为已钉住的语言边界。
 *
 * 它在主链路上真的会发生：`by_user(...)`（人工拍板）的 confidence 恒为 1.0，
 * 所以**任何被人工回答过的问题**，其证据 id 都会跨语言不同。
 *
 * 下面这个 remap 不是"绕过"：它从 golden 的证据记录**按同一条规则**重算 id，
 * 并断言每一条被重映射的记录确实含整数值的 confidence。别的原因导致的 id 变化
 * 不会被这里吸收 —— 会直接把测试打红。
 */
function evidenceIdRemap(expected: Dict): Map<string, string> {
  const remap = new Map<string, string>();
  for (const raw of (expected["evidence"] as Dict[] | undefined) ?? []) {
    const { id, ...stable } = raw;
    const tsId = `ev.${sha256Hex(canonicalJson(stable)).slice(0, 16)}`;
    if (tsId === id) continue;
    if (Number.isInteger(raw["confidence"])) {
      remap.set(id as string, tsId);
      continue;
    }
    // 剩下唯一一种"id 不等于内容哈希"的合法形态：reference() 给已经规范的
    // ev.* 留的占位记录 —— 它的 id 就是传进来的那个字符串。形状必须严丝合缝，
    // 否则说明出现了没预料到的分叉，直接打红而不是被这个函数吸收掉。
    expect(raw).toEqual({
      id, fileId: "", fileName: "", locator: {}, snippet: "",
      extractor: "question-backlog", confidence: 0.5, cite: id,
    });
  }
  return remap;
}

/** 把 golden 里的 Python 证据 id 换成 TS 侧的，其余结构一字不改。 */
function applyRemap(value: unknown, remap: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return remap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((x) => applyRemap(x, remap));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Dict).map(([k, v]) => [k, applyRemap(v, remap)]));
  }
  return value;
}

/** golden 里的 kwargs 是 Python 的 snake_case，转成 TS 的选项对象。
 * `questions` / `backlog` 必须按"键在不在"转，不能按值是否为空 ——
 * `questions=[]` 与不传是两回事（前者会让所有问题的 status 走背包分支）。 */
function toOptions(raw: Dict): BuildPackageOptions {
  const out: BuildPackageOptions = {};
  if ("package_id" in raw) out.packageId = raw["package_id"] as string;
  if ("revision" in raw) out.revision = raw["revision"] as number;
  if ("base_revision" in raw) out.baseRevision = raw["base_revision"] as number | null;
  if ("generated_at" in raw) out.generatedAt = raw["generated_at"] as string;
  if ("decisions" in raw) out.decisions = raw["decisions"] as unknown[];
  if ("questions" in raw) out.questions = raw["questions"];
  if ("backlog" in raw) out.backlog = raw["backlog"];
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  常量
// ══════════════════════════════════════════════════════════════════
describe("契约常量", () => {
  const schema = section<Dict>("schema");

  it("版本与 URL 与 Python 一致", () => {
    expect(SCHEMA_VERSION).toBe(schema["SCHEMA_VERSION"]);
    expect(SCHEMA_URL).toBe(schema["SCHEMA_URL"]);
    expect([...COLLECTIONS]).toEqual(schema["COLLECTIONS"]);
  });

  it("JSON Schema 常量逐字段一致（键序也一致）", () => {
    expect(ONTOLOGY_PACKAGE_JSON_SCHEMA).toEqual(schema["ONTOLOGY_PACKAGE_JSON_SCHEMA"]);
    const py = schema["ONTOLOGY_PACKAGE_JSON_SCHEMA"] as Dict;
    expect(Object.keys(ONTOLOGY_PACKAGE_JSON_SCHEMA)).toEqual(Object.keys(py));
    expect(Object.keys(ONTOLOGY_PACKAGE_JSON_SCHEMA["properties"] as Dict))
      .toEqual(Object.keys(py["properties"] as Dict));
  });
});

// ══════════════════════════════════════════════════════════════════
//  归一原语
// ══════════════════════════════════════════════════════════════════
describe("canonicalId —— 遗留 id 归一", () => {
  const cases = UNITS["canonical_id"] as Dict[];

  it.each(cases.map((c, i) => [i, c] as const))("#%i %o", (_i, c) => {
    const prefixes = c["legacyPrefixes"] as string[];
    expect(canonicalId(c["prefix"] as string, c["legacy"], ...prefixes)).toBe(c["out"]);
  });

  it("差点该合并但不该合并的几对，两两不同", () => {
    // 真实事故的形状：只保留 ASCII 的 slug 把「集采计划编制已发起」和「编制集采
    // 计划」双双抹成 x，两个不同的东西共用一个 rid，后写的静默覆盖先写的。
    const distinct: [unknown, unknown][] = [
      ["集采计划编制已发起", "编制集采计划"],
      ["---", "==="],                       // 都退化成空 → 必须靠内容哈希分开
      ["ot_ot_plan", "ot_plan"],            // 只剥一层前缀
      ["br_rule_x", "rule_x"],              // 命中第一个前缀就 break
      ["﻿ot_bom", "ot_bom"],           // BOM：Python 的 strip 不剥
      ["ＰＬＡＮ", "PLAN"],                   // 全角与半角
    ];
    for (const [a, b] of distinct) {
      expect(canonicalId("do", a, "ot_", "br_", "rule_"))
        .not.toBe(canonicalId("do", b, "ot_", "br_", "rule_"));
    }
    // 反过来，该合并的必须合并：strip 掉的空白、大小写、下划线/连字符。
    expect(canonicalId("do", "  ot_plan  ", "ot_")).toBe(canonicalId("do", "ot_plan", "ot_"));
    expect(canonicalId("do", "ot_Plan", "ot_")).toBe(canonicalId("do", "ot_plan", "ot_"));
  });
});

describe("packageIdOf / stableInputId", () => {
  it.each((UNITS["package_id"] as Dict[]).map((c, i) => [i, c] as const))(
    "packageId #%i %o", (_i, c) => {
      expect(packageIdOf(c["in"])).toBe(c["out"]);
    });

  it.each((UNITS["stable_input_id"] as Dict[]).map((c, i) => [i, c] as const))(
    "stableInputId #%i %o", (_i, c) => {
      const prefixes = c["legacyPrefixes"] as string[];
      expect(stableInputId(c["prefix"] as string, c["in"], ...prefixes)).toBe(c["out"]);
    });

  it("已规范的 id 幂等 —— 重跑不产生新 id", () => {
    for (const c of UNITS["stable_input_id"] as Dict[]) {
      const once = stableInputId(c["prefix"] as string, c["in"],
        ...(c["legacyPrefixes"] as string[]));
      const twice = stableInputId(c["prefix"] as string, once,
        ...(c["legacyPrefixes"] as string[]));
      expect(twice).toBe(once);
    }
  });
});

describe("dataKind —— 按名字猜业务类别", () => {
  it.each((UNITS["data_kind"] as Dict[]).map((c) => [c["in"], c] as const))(
    "%o", (_name, c) => {
      expect(dataKind(c["in"] as string)).toEqual([c["kind"], c["confidence"]]);
    });

  it("全角 ＰＬＡＮ 不与半角 PLAN 合并", () => {
    expect(dataKind("PLAN")[0]).toBe("document");
    expect(dataKind("ＰＬＡＮ")[0]).toBe("transaction");
  });

  it("命中顺序：message > master > reference > document", () => {
    expect(dataKind("供应商消息")[0]).toBe("message"); // master + message
    expect(dataKind("物料字典")[0]).toBe("master");    // master + reference
    expect(dataKind("计划字典")[0]).toBe("reference"); // reference + document
  });
});

describe("pyValue —— 断言拆包", () => {
  it.each((UNITS["value"] as Dict[]).map((c, i) => [i, c] as const))("#%i %o", (_i, c) => {
    expect(pyValue(c["in"], c["default"])).toEqual(c["out"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  证据索引
// ══════════════════════════════════════════════════════════════════
describe("EvidenceIndex", () => {
  it.each((EVIDENCE["add"] as Dict[]).map((c, i) => [i, c] as const))(
    "add #%i 内容寻址的 id 与记录", (_i, c) => {
      const idx = new EvidenceIndex();
      const eid = idx.add(c["in"] as Dict);
      expect(eid).toBe(c["id"]);
      expect(idx.items.get(eid)).toEqual(c["item"]);
    });

  it("同一条证据的 snake_case 与 camelCase 写法收敛到同一个 id", () => {
    const shared = EVIDENCE["shared_index"] as Dict;
    const idx = new EvidenceIndex();
    const ids = (EVIDENCE["add"] as Dict[]).map((c) => idx.add(c["in"] as Dict));
    expect(ids).toEqual(shared["ids"]);
    expect([...idx.items.values()]).toEqual(shared["items"]);
    // 前两条是同一条证据的两种字段写法 —— 收敛不了就会在产物里出现重复证据。
    expect(ids[0]).toBe(ids[1]);
  });

  it.each((EVIDENCE["reference"] as Dict[]).map((c, i) => [i, c] as const))(
    "reference #%i %o", (_i, c) => {
      const idx = new EvidenceIndex();
      expect(idx.reference(c["in"])).toBe(c["out"]);
      expect([...idx.items.values()]).toEqual(c["items"]);
    });

  it.each((EVIDENCE["assertion"] as Dict[]).map((c, i) => [i, c] as const))(
    "assertion #%i", (_i, c) => {
      const idx = new EvidenceIndex();
      expect(idx.assertion(...(c["in"] as unknown[]))).toEqual(c["out"]);
      expect([...idx.items.values()]).toEqual(c["items"]);
    });

  it("【已知语言边界】confidence 恰好是整数值的 float 时，evidence id 跨语言不同", () => {
    // Python 内存里 1.0 是 float，canonical_json 写 "1.0"；JS 里 1 与 1.0 是同一个
    // 值，只能写 "1"。sha256 的输入不同 → ev.* 不同。这是 ids.ts 已钉住的语言
    // 边界（见该文件头注释），不是 canonical 层能修的：JS 没有 float 类型。
    const div = EVIDENCE["float_divergence"] as Dict;
    const idx = new EvidenceIndex();
    const tsId = idx.add(div["in"] as Dict);
    expect(tsId).not.toBe(div["id"]);
    // 但**记录本身**（JSON 结构）是一致的，只有 id 的那 16 位十六进制不同。
    const pyItem = { ...(div["item"] as Dict), id: tsId };
    expect(idx.items.get(tsId)).toEqual(pyItem);
  });
});

// ══════════════════════════════════════════════════════════════════
//  输入适配
// ══════════════════════════════════════════════════════════════════
describe("normaliseDecision", () => {
  const questionIds = new Map(
    Object.entries(ADAPTERS["question_ids"] as Record<string, string>));

  it.each((ADAPTERS["normalise_decision"] as Dict[]).map((c, i) => [i, c] as const))(
    "#%i %o", (_i, c) => {
      expect(normaliseDecision(c["in"], c["index"] as number, questionIds))
        .toEqual(c["out"]);
    });

  it("键存在但值为 None 时不走回退链", () => {
    // Python 的 d.get("actorRole", d.get("actor_role"))：键在就返回 None，
    // 而 JS 的 `??` 会继续往后取到 "FDE"。这条是两边最容易悄悄分叉的地方。
    const out = normaliseDecision({ actorRole: null, actor_role: "FDE" }, 1, questionIds);
    expect(out["actorRole"]).toBeNull();
  });
});

describe("questionInput", () => {
  it.each((ADAPTERS["question_input"] as Dict[]).map((c, i) => [i, c] as const))(
    "#%i %o", (_i, c) => {
      expect(questionInput(c["in"])).toEqual(c["out"]);
    });

  it.each((ADAPTERS["question_input_raises"] as Dict[]).map((c, i) => [i, c] as const))(
    "拒绝非法输入 #%i", (_i, c) => {
      expect(() => questionInput(c["in"])).toThrow(TypeError);
      expect(() => questionInput(c["in"])).toThrow(c["message"] as string);
    });
});

// ══════════════════════════════════════════════════════════════════
//  端到端场景
// ══════════════════════════════════════════════════════════════════
describe("buildPackage —— 端到端", () => {
  it.each(SCENARIOS.map((s) => [s["name"] as string, s] as const))("%s", (_name, s) => {
    const pkg = buildPackage(s["oir"] as Dict, s["flow"] as Dict | null,
      toOptions(s["options"] as Dict));
    const expected = s["out"] as Dict;
    expect(pkg.toDict()).toEqual(applyRemap(expected, evidenceIdRemap(expected)));
  });

  it("【已知语言边界】人工回答过的问题，其证据 id 跨语言不同", () => {
    // main 场景里的 by_user("是")：confidence=1.0 → Python 写 "1.0"、JS 写 "1"
    // → sha256 不同。整包只有这一条受影响，其余 id 逐字节一致。
    const expected = SCENARIOS.find((s) => s["name"] === "main")!["out"] as Dict;
    const remap = evidenceIdRemap(expected);
    expect(remap.size).toBe(1);
    const [pyId, tsId] = [...remap.entries()][0]!;
    expect(pyId).not.toBe(tsId);
    const record = (expected["evidence"] as Dict[]).find((e) => e["id"] === pyId)!;
    expect(record["confidence"]).toBe(1);
    expect(record["extractor"]).toBe("human");
  });

  it("同一份输入建两次得到同一份包（可重放的前提）", () => {
    const s = SCENARIOS.find((x) => x["name"] === "main")!;
    const opts = toOptions(s["options"] as Dict);
    const left = buildPackage(s["oir"] as Dict, s["flow"] as Dict, opts).toDict();
    const right = buildPackage(s["oir"] as Dict, s["flow"] as Dict, opts).toDict();
    expect(left).toEqual(right);
  });

  it("活对象（有 toDict 的）与它的 dict 载荷建出同一份包", () => {
    // 用**类实例**而不是对象字面量：Python 的 `isinstance(source, Mapping)` 先判，
    // 一个带 to_dict 键的 dict 在 Python 眼里仍是 dict。TS 侧同理 —— 字面量走
    // Mapping 分支，只有类实例才走 toDict()。
    class Live {
      constructor(private readonly d: Dict) {}
      toDict(): Dict { return this.d; }
    }
    const s = SCENARIOS.find((x) => x["name"] === "main")!;
    const opts = toOptions(s["options"] as Dict);
    expect(buildPackage(new Live(s["oir"] as Dict), new Live(s["flow"] as Dict), opts).toDict())
      .toEqual(buildPackage(s["oir"] as Dict, s["flow"] as Dict, opts).toDict());
  });

  it("近似名不合并：十个对象拿到十个 id", () => {
    const s = SCENARIOS.find((x) => x["name"] === "near_miss")!;
    const pkg = buildPackage(s["oir"] as Dict, null, toOptions(s["options"] as Dict));
    const ids = pkg.dataObjects.map((o) => o["id"] as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
  });

  it("OIR 与 Flow 的不同前缀指同一个动作时合并成一个 Action", () => {
    const s = SCENARIOS.find((x) => x["name"] === "merge_action_prefixes")!;
    const pkg = buildPackage(s["oir"] as Dict, s["flow"] as Dict,
      toOptions(s["options"] as Dict));
    // at_approve_plan（OIR）与 fn_approve_plan（Flow）→ 一个 act.approve.plan；
    // fn_reject_plan 前缀相同但名字不同 → 必须**另起**一个，不能被吞掉。
    const ids = pkg.actions.map((a) => a["id"]);
    expect(ids).toEqual(["act.approve.plan", "act.reject.plan"]);
    expect(pkg.validation.passed).toBe(true);
  });

  it("整数样式的问题 id 保持插入序（普通对象会重排成 1,2,10）", () => {
    const s = SCENARIOS.find((x) => x["name"] === "numeric_question_keys")!;
    const pkg = buildPackage(s["oir"] as Dict, null, toOptions(s["options"] as Dict));
    const golden = ((s["out"] as Dict)["questions"] as Dict[]).map((q) => q["legacyId"]);
    expect(pkg.questions.map((q) => q["legacyId"])).toEqual(golden);
    // Python dict 的插入序：10, 2, 1, -3, 01。用普通对象存 by_id 会重排成
    // 1, 2, 10, -3, 01（整数样式的键先按数值升序）。
    expect(golden).toEqual(["10", "2", "1", "-3", "01"]);
    expect(Object.keys({ "10": 0, "2": 0, "1": 0, "-3": 0, "01": 0 }))
      .toEqual(["1", "2", "10", "-3", "01"]);
  });
});

describe("buildPackage —— 拒绝非法参数", () => {
  const byLabel = new Map(BUILD_RAISES.map((r) => [r["label"] as string, r]));
  const mainOir = SCENARIOS.find((s) => s["name"] === "main")!["oir"] as Dict;
  const at = "2026-08-12T10:00:00+08:00";

  it.each([
    ["revision_zero", { revision: 0 }],
    ["revision_negative", { revision: -1 }],
    ["base_equal", { revision: 2, baseRevision: 2 }],
    ["base_greater", { revision: 2, baseRevision: 3 }],
    ["both_questions_and_backlog", { questions: [], backlog: [] }],
  ] as const)("%s", (label, extra) => {
    const expected = byLabel.get(label)!;
    expect(() => buildPackage(mainOir, null, { generatedAt: at, ...extra }))
      .toThrow(ValueError);
    expect(() => buildPackage(mainOir, null, { generatedAt: at, ...extra }))
      .toThrow(expected["message"] as string);
  });

  it("匿名问题（无 id/rid/sourceRef）与 Python 一样炸 KeyError", () => {
    // 两趟循环用了不同的兜底名（enumerate 下标 vs 字典长度加一），只要有一条
    // 匿名问题第二趟必然找不到键。这是 Python 的既有行为 —— TS 侧"修好"它
    // （静默造个 id）会让两条匿名问题合并成一条，那比崩掉更糟。
    const expected = byLabel.get("anonymous_question")!;
    const oir = (expected["kwargs"] as Dict)["oir"] as Dict;
    expect(() => buildPackage(oir, null, { generatedAt: at })).toThrow(KeyError);
    try {
      buildPackage(oir, null, { generatedAt: at });
      expect.unreachable();
    } catch (e) {
      expect((e as KeyError).key).toBe(expected["key"]);
      expect((e as KeyError).message).toBe(expected["message"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  校验器
// ══════════════════════════════════════════════════════════════════
describe("validatePackage", () => {
  //: `revision: 2.0` —— Python 的 isinstance(2.0, int) 为假 → 报 REVISION；
  //: JSON.parse 之后 2.0 在 JS 里就是 2，报不出来。JS 没有 float 类型，
  //: 这条无从复现（模块头注释里作为已知边界记着）。
  const FLOAT_INT_DIVERGENCE = "float_revision";

  for (const c of VALIDATION) {
    const name = c["name"] as string;
    if (name === FLOAT_INT_DIVERGENCE) continue;
    if (c["raises"] !== undefined) {
      it(`${name} —— 与 Python 一样抛`, () => {
        const raises = c["raises"] as Dict;
        expect(() => validatePackage(c["in"] as Dict)).toThrow(TypeError);
        expect(() => validatePackage(c["in"] as Dict)).toThrow(raises["message"] as string);
      });
      continue;
    }
    it(name, () => {
      const report = validatePackage(c["in"] as Dict);
      expect(report.toDict()).toEqual(c["out"]);
      expect(report.passed).toBe(c["passed"]);
    });
  }

  it("【已知语言边界】revision 是整数值的 float 时报不出 REVISION", () => {
    const c = VALIDATION.find((x) => x["name"] === FLOAT_INT_DIVERGENCE)!;
    const pyFindings = ((c["out"] as Dict)["findings"] as Dict[]).map((f) => f["code"]);
    expect(pyFindings).toEqual(["REVISION"]);
    // TS 侧 JSON.parse 已经把 2.0 塌成 2 —— 输入进到本模块之前就变了。
    expect(((c["in"] as Dict)["revision"])).toBe(2);
    expect(validatePackage(c["in"] as Dict).toDict()).toEqual({
      status: "passed",
      validators: (c["out"] as Dict)["validators"],
      findings: [],
    });
  });

  it("bool 是 int 的子类：revision=true 在 Python 侧合法", () => {
    const c = VALIDATION.find((x) => x["name"] === "bool_revision")!;
    const codes = validatePackage(c["in"] as Dict).findings.map((f) => f.code);
    expect(codes).not.toContain("REVISION");
    expect(codes).toEqual(((c["out"] as Dict)["findings"] as Dict[]).map((f) => f["code"]));
  });

  it("OntologyPackage 实例与它的 dict 得到同一份报告", () => {
    const s = SCENARIOS.find((x) => x["name"] === "main")!;
    const pkg = buildPackage(s["oir"] as Dict, s["flow"] as Dict,
      toOptions(s["options"] as Dict));
    expect(validatePackage(pkg).toDict()).toEqual(validatePackage(pkg.toDict()).toDict());
  });
});

// ══════════════════════════════════════════════════════════════════
//  序列化
// ══════════════════════════════════════════════════════════════════
describe("序列化", () => {
  const mainOut = SCENARIOS.find((s) => s["name"] === "main")!["out"] as Dict;

  it("packageFromDict → toDict 往返闭合", () => {
    // 往返的输入就是 golden 里那份 Python 包，证据 id 原样带着走 —— 这一条不
    // 涉及重算 id，所以不需要 remap，可以逐字段直接比。
    expect(packageFromDict(mainOut).toDict()).toEqual(SERIALIZATION["from_dict_roundtrip"]);
  });

  it.each((SERIALIZATION["from_dict_raises"] as Dict[]).map((c) => [c["label"], c] as const))(
    "packageFromDict 拒绝 %s", (_label, c) => {
      const payload = c["label"] === "bad_version"
        ? { ...mainOut, schemaVersion: "2.0.0" }
        : (c["label"] === "null_version" ? { schemaVersion: null } : {});
      expect(() => packageFromDict(payload)).toThrow(ValueError);
      expect(() => packageFromDict(payload)).toThrow(c["message"] as string);
    });

  it("toJson(indent=2) / toJson(null) 与 Python 的 json.dumps 字节一致", () => {
    const restored = packageFromDict(mainOut);
    // json.dumps 在 indent=None 时的默认分隔符是 ", " / ": "（带空格），
    // 不是 JSON.stringify 的紧凑形态 —— 差一个空格产物就对不上。
    for (const [key, actual] of [
      ["to_json_indent2", restored.toJson()],
      ["to_json_no_indent", restored.toJson(null)],
    ] as const) {
      const expected = SERIALIZATION[key] as string;
      expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
      expect(actual).toBe(normalizeIntFloat(expected));
    }
  });

  it("exportPackage 写出的文本与 Python 一致", () => {
    const restored = packageFromDict(mainOut);
    const chunks: string[] = [];
    exportPackage(restored, { write: (t) => void chunks.push(t) });
    const actual = chunks.join("");
    const expected = SERIALIZATION["export_text"] as string;
    expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
    expect(actual).toBe(normalizeIntFloat(expected));

    const fromMapping: string[] = [];
    exportPackage(mainOut, { write: (t) => void fromMapping.push(t) });
    expect(fromMapping.join("")).toBe(
      normalizeIntFloat(SERIALIZATION["export_text_from_mapping"] as string));
  });

  it("exportPackage 拒绝非法包（不写半份产物）", () => {
    const c = SERIALIZATION["export_raises"] as Dict;
    const invalid = SERIALIZATION["export_invalid_input"] as Dict;
    let wrote = false;
    expect(() => exportPackage(invalid, { write: () => { wrote = true; } }))
      .toThrow(ValueError);
    expect(() => exportPackage(invalid, { write: () => { wrote = true; } }))
      .toThrow(c["message"] as string);
    expect(wrote).toBe(false);
  });

  it("OntologyPackage 的默认 generatedAt 是 Python isoformat 的形状", () => {
    const pkg = new OntologyPackage({ packageId: "pkg.x" });
    // datetime.now(UTC).isoformat() → 2026-08-13T05:12:34.567890+00:00
    expect(pkg.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    // JS 的 Date 只有毫秒精度 —— 末三位恒为 0，形态对但精度不如 Python。
    expect(pkg.generatedAt.slice(-9, -6)).toBe("000");
  });
});

/**
 * 把 Python 文本里"整数值的 float"改写成 JS 的形态。
 *
 * `by_user("是")` 的 confidence 是 1.0，Python 写 `1.0`，JS 只能写 `1` ——
 * 这是 ids.ts 已钉住的语言边界（JS 里 1 与 1.0 是同一个值）。这里**只**改写
 * `"confidence": 1.0` 这一种形态，并断言出现次数与预期一致，免得这个改写
 * 悄悄盖掉别的真差异。
 */
function normalizeIntFloat(text: string): string {
  const hits = text.split('"confidence": 1.0').length - 1;
  expect(hits).toBe(1);
  return text.split('"confidence": 1.0').join('"confidence": 1');
}

// ══════════════════════════════════════════════════════════════════
//  Python 垫片
// ══════════════════════════════════════════════════════════════════
describe("Python 垫片", () => {
  it.each((DIVERGENCE["py_str"] as Dict[]).map((c, i) => [i, c] as const))(
    "pyStr #%i %o", (_i, c) => {
      expect(pyStr(c["in"])).toBe(c["out"]);
    });

  it.each((DIVERGENCE["strip"] as Dict[]).map((c, i) => [i, c] as const))(
    "pyStrip #%i", (_i, c) => {
      expect(pyStrip(c["in"] as string)).toBe(c["out"]);
    });

  it("pyStrip 的空白集逐码点等于 Python 的，与 trim() 的差集正是那 6 个字符", () => {
    // 全码点扫一遍而不是抽查：只要有一个字符两边判定不同，它就能在 strip 之后
    // 的前缀判定上把两个不同的 id 折成一个。
    const py = (DIVERGENCE["py_isspace"] as number[]).slice().sort((a, b) => a - b);
    const mine: number[] = [];
    const pyOnly: number[] = [];
    const jsOnly: number[] = [];
    const pySet = new Set(py);
    for (let cp = 0; cp < 0x110000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // 落单代理不参与
      const ch = String.fromCodePoint(cp);
      if (pyStrip(ch) === "") mine.push(cp);
      const inJs = ch.trim() === "";
      if (pySet.has(cp) && !inJs) pyOnly.push(cp);
      if (!pySet.has(cp) && inJs) jsOnly.push(cp);
    }
    expect(mine).toEqual(py);
    // Python 多剥 \x1c-\x1f 与 \x85，JS 多剥 ﻿（BOM）。
    expect(pyOnly).toEqual([0x1c, 0x1d, 0x1e, 0x1f, 0x85]);
    expect(jsOnly).toEqual([0xfeff]);
  });

  it("BOM 前缀的 id 不会被 trim 抹掉从而与已规范 id 合并", () => {
    // "﻿q.bom" 在 Python 眼里是**遗留** id（strip 不剥 BOM），要归一成
    // q.q.bom；用 trim() 会判成"已规范"的 q.bom，与真正的 q.bom 撞成一个。
    expect(stableInputId("q", "﻿q.bom", "oq_", "q_")).toBe("q.q.bom");
    expect(stableInputId("q", "q.bom", "oq_", "q_")).toBe("q.bom");
  });

  it("snippet 按 code point 切到 300，不劈开代理对", () => {
    const c = DIVERGENCE["slice_300"] as Dict;
    const idx = new EvidenceIndex();
    const eid = idx.add({ snippet: c["in"] });
    expect(idx.items.get(eid)!["snippet"]).toBe(c["out"]);
    expect([...(c["out"] as string)].length).toBe(300);
    expect((c["out"] as string)).not.toContain("�");
  });

  it("_data_kind 的四张词表与 Python 一字不差", () => {
    const words = DIVERGENCE["case_words"] as Record<string, string[]>;
    // 词表本身没有导出（它是 dataKind 的实现细节），这里反过来验：每个词都能
    // 把一个只含它的名字归到对应类别，而且优先级更高的类别不含这个词。
    const expectKind: Record<string, string> = {
      message: "message", master: "master", reference: "reference", document: "document",
    };
    const higher: Record<string, string[]> = {
      message: [], master: ["message"], reference: ["message", "master"],
      document: ["message", "master", "reference"],
    };
    for (const [group, list] of Object.entries(words)) {
      for (const w of list) {
        const blocked = higher[group]!.some((g) => words[g]!.some((x) => w.includes(x)));
        if (blocked) continue;
        expect([w, dataKind(w)[0]]).toEqual([w, expectKind[group]]);
      }
    }
  });

  it("int() 向零截断，bool 当整数", () => {
    // golden 的 int_cast 用例经由 blastRadius / version 两个字段间接验证；
    // 这里挑最容易写错的两条直接钉住形态。
    const cases = DIVERGENCE["int_cast"] as Dict[];
    const byIn = new Map(cases.map((c) => [JSON.stringify(c["in"]), c["out"]]));
    expect(byIn.get("3.9")).toBe(3);
    expect(byIn.get("-3.9")).toBe(-3); // 向零截断，不是向下取整
    expect(byIn.get("true")).toBe(1);
    const pkg = buildPackage({}, null, {
      generatedAt: "2026-08-12T10:00:00+08:00",
      questions: [{ id: "q1", text: "x", blast_radius: 3.9, version: "9" }],
    });
    expect(pkg.questions[0]!["blastRadius"]).toBe(3);
    expect(pkg.questions[0]!["version"]).toBe(9);
  });
});
