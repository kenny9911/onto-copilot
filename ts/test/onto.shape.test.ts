/**
 * shape 的 golden 校验 —— 期望值全部来自 Python 侧真跑出来的结果。
 *
 * 两份 golden：
 *   · `golden/shape.json`      主导出器导的四张表（登记表 / 行动表 / 字段表 / 问卷），
 *     只有输出没有输入 —— 输入在这里由 `shape.extra.json` 提供，两份的
 *     `shape` / `extract` 必须逐字节相等（`sameFour` 那一组就是在盯这件事：
 *     哪天有人只重导其中一份，立刻红）。
 *   · `golden/shape.extra.json` 本 track 自己导的（`tools/golden/shape.py`），
 *     补的是判据的**反例**：分组列的组名写在第 0 行还是第 1 行、列名自称是
 *     类型列与否、carry_in 给了与没给、问卷四信号缺一个 —— 每一对的判定都相反。
 *
 * 这里**不写一个手算的期望值**。手算的是猜测，golden 是事实。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ColumnRole,
  SegmentShape,
  Yield,
  baseTypeOf,
  classifyColumns,
  inferShape,
  looksLikeQuestion,
  parseColumnRole,
  parseYield,
  pyRound,
  splitOptions,
  structuralExtract,
} from "../src/onto/shape.js";
import type { Row } from "../src/onto/shape.js";

interface ShapeDict {
  row_count: number;
  row_unit: string | null;
  yields: string[];
  rule_decidable: string[];
  columns: { name: string; role: string; fill: number; distinct_ratio: number;
    mean_len: number; samples: string[] }[];
  note: string;
}
interface ExtractDict {
  objects: Record<string, unknown>[];
  properties: Record<string, unknown>[];
  links: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  questions: Record<string, unknown>[];
}
interface Case {
  name: string;
  /** `unknown[]`：golden 里有一条 junk_rows，故意混进了数组 / null / 字符串 ——
   * Python 侧 `isinstance(r, dict)` 会跳过它们，但**行数照算**。 */
  rows: unknown[];
  shape_rows: unknown[] | null;
  cites: string[];
  carry_in: Record<string, string> | null;
  shape: ShapeDict;
  describe: string;
  extract: ExtractDict;
}
interface Extra {
  cases: Case[];
  split_options: { in: string; out: string[] }[];
  looks_like_question: { in: string; out: boolean }[];
  base_type_of: { in: string | null; out: string }[];
}
interface Main {
  [k: string]: { shape: ShapeDict; extract: ExtractDict } | unknown;
  split_options: { in: string; out: string[] }[];
}

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as T;

const G: Extra = read("shape.extra.json");
const MAIN = read<Main>("shape.json");
const byName = (n: string): Case => {
  const c = G.cases.find((x) => x.name === n);
  if (!c) throw new Error(`golden 里没有用例 ${n}`);
  return c;
};

/** 用例的输入怎么喂给 infer_shape：形状可以来自整张表，抽取只跑一个窗口。 */
function runCase(c: Case): { shape: SegmentShape; extract: ExtractDict } {
  const shape = inferShape(c.shape_rows ?? c.rows);
  return {
    shape,
    extract: structuralExtract(c.rows, c.cites, shape, c.carry_in) as unknown as
      ExtractDict,
  };
}

describe("infer_shape / structural_extract 全量对 golden", () => {
  for (const c of G.cases) {
    it(c.name, () => {
      const { shape, extract } = runCase(c);
      expect(shape.toDict()).toEqual(c.shape);
      expect(extract).toEqual(c.extract);
    });
    it(`${c.name} · describe()`, () => {
      expect(runCase(c).shape.describe()).toBe(c.describe);
    });
  }
});

describe("主导出器的 shape.json —— 同样的输入必须给同样的输出", () => {
  for (const name of ["registry", "actions", "fields", "survey"]) {
    it(name, () => {
      const want = MAIN[name] as { shape: ShapeDict; extract: ExtractDict };
      const c = byName(name);
      // 两份 golden 本来就该一致；不一致说明有人只重导了一份
      expect(c.shape).toEqual(want.shape);
      const { shape, extract } = runCase(c);
      expect(shape.toDict()).toEqual(want.shape);
      expect(extract).toEqual(want.extract);
    });
  }
  it("split_options", () => {
    for (const v of MAIN.split_options) expect(splitOptions(v.in)).toEqual(v.out);
  });
});

describe("split_options（拆不出两段就一段都不拆）", () => {
  for (const v of G.split_options) {
    it(JSON.stringify(v.in), () => expect(splitOptions(v.in)).toEqual(v.out));
  }
});

describe("looks_like_question", () => {
  for (const v of G.looks_like_question) {
    it(JSON.stringify(v.in), () => expect(looksLikeQuestion(v.in)).toBe(v.out));
  }
});

describe("base_type_of（认不出一律 STRING，不猜）", () => {
  for (const v of G.base_type_of) {
    it(JSON.stringify(v.in), () => expect(baseTypeOf(v.in)).toBe(v.out));
  }
});

// ══════════════════════════════════════════════════════════════════
//  带血的判据 —— 每一条都靠 golden 里的**一对**用例，判定必须相反
// ══════════════════════════════════════════════════════════════════
describe("判据的反例对（一个都不许漂）", () => {
  const roleOfCol = (c: Case, col: string): string =>
    c.shape.columns.find((x) => x.name === col)!.role;

  it("稀疏分组列看的是**第一行有没有值**，不是填充率", () => {
    // 两份输入只差组名写在第 0 行还是第 1 行，填充率完全一样
    expect(byName("sparse_head").shape.columns[0]!.fill)
      .toBe(byName("sparse_nohead").shape.columns[0]!.fill);
    expect(roleOfCol(byName("sparse_head"), "分组")).toBe(ColumnRole.GROUP);
    expect(roleOfCol(byName("sparse_nohead"), "分组")).toBe(ColumnRole.LABEL);
    for (const n of ["sparse_head", "sparse_nohead"]) {
      const c = byName(n);
      expect(runCase(c).shape.toDict().columns).toEqual(c.shape.columns);
    }
  });

  it("宿主列取**取值最多**的那一层（细的），粗的那层落到 module", () => {
    const c = byName("two_level");
    const { extract } = runCase(c);
    // 应用域 2 个取值、业务对象 4 个 —— 宿主是后者
    expect(extract.objects[0]).toMatchObject({ module: "采购域", group: "对象0" });
    expect(extract.objects[15]).toMatchObject({ module: "供应商域", group: "对象3" });
  });

  it("carry_in：一张表被切成多段时，后段的组首在前一段里", () => {
    const withCarry = runCase(byName("carry_tail")).extract;
    const without = runCase(byName("carry_tail_none")).extract;
    expect(withCarry.objects).toHaveLength(without.objects.length);
    expect(withCarry.objects[0]).toHaveProperty("group", "采购需求计划");
    expect(without.objects[0]).not.toHaveProperty("group");
    // 字段表更狠：没有 carry_in 时宿主为空，**一行属性都抽不出来**
    expect(runCase(byName("field_carry_tail")).extract.properties).toHaveLength(6);
    expect(runCase(byName("field_carry_tail_none")).extract.properties)
      .toHaveLength(0);
  });

  it("问卷的四个信号必须同时成立", () => {
    expect(byName("survey").shape.row_unit).toBe("question");
    // 只有一列是满的（信号 2 不成立）→ 不是问卷
    expect(byName("survey_one_dense").shape.row_unit).toBe("object");
    expect(byName("survey_one_dense").shape.yields).not.toContain(Yield.QUESTIONS);
    // 长度不足 6 的「小计」行不算问题
    const qs = runCase(byName("survey_mixed")).extract.questions;
    expect(qs).toHaveLength(5);
    expect(qs.map((q) => q.text)).not.toContain("小计");
  });

  it("数据类型列的存在压过一切 —— 四个问卷信号全中也翻不了案", () => {
    const c = byName("field_looks_like_survey");
    expect(c.shape.row_unit).toBe("property");
    expect(c.shape.yields).toEqual(["objects", "properties"]);
    expect(runCase(c).extract.properties).toHaveLength(10);
  });

  it("列名自称是类型列才降到 0.3 —— 取值一样、只换列名，判定相反", () => {
    expect(roleOfCol(byName("custom_type"), "字段类型")).toBe(ColumnRole.DATATYPE);
    expect(roleOfCol(byName("custom_type_unnamed"), "特征")).toBe(ColumnRole.GROUP);
    expect(byName("custom_type").shape.row_unit).toBe("property");
    expect(byName("custom_type_unnamed").shape.row_unit).toBe("object");
  });

  it("中英混填的类型列：两种写法各占一半，0.6 会整列落空", () => {
    expect(roleOfCol(byName("mixed_type"), "数据类型")).toBe(ColumnRole.DATATYPE);
  });

  it("阈值全部卡在临界点上 —— 改任何一个，这一组里必有一对翻面", () => {
    const role = (c: string, col: string): string =>
      byName(c).shape.columns.find((x) => x.name === col)!.role;
    // 平均长度 31 是散文，30 还是名称（_PROSE_LEN = 30）
    expect(role("prose_edge", "长31")).toBe(ColumnRole.PROSE);
    expect(role("prose_edge", "长30")).toBe(ColumnRole.LABEL);
    // 取值里恰好一半像类型就够（0.5），0.4 不够 —— 且列名没自称是类型列
    expect(role("type_half", "格式")).toBe(ColumnRole.DATATYPE);
    expect(role("type_below", "格式")).toBe(ColumnRole.LABEL);
    // URL 0.6 / 布尔 0.8 / 标识符 0.8 与去重率 0.7
    expect(role("urlish_edge", "接口A")).toBe(ColumnRole.ENDPOINT);
    expect(role("urlish_edge", "接口B")).toBe(ColumnRole.LABEL);
    expect(role("bool_edge", "必填A")).toBe(ColumnRole.REQUIRED);
    expect(role("bool_edge", "必填B")).toBe(ColumnRole.LABEL);
    expect(role("ident_edge", "码C")).toBe(ColumnRole.IDENTIFIER);
    expect(role("ident_edge", "码D")).toBe(ColumnRole.LABEL);
    expect(role("ident_edge", "码B")).toBe(ColumnRole.ENUM);
    // 标识符列填够 0.6 才算登记表
    expect(byName("ident_fill_06").shape.rule_decidable).toEqual(["objects"]);
    expect(byName("ident_fill_05").shape.rule_decidable).toEqual([]);
    // 宿主列取值长 24 还认，25 就当口径说明（_HOST_MAX_LEN）
    expect(byName("host_len_24").shape.rule_decidable).toEqual(["properties"]);
    expect(byName("host_len_25").shape.rule_decidable).toEqual([]);
    expect(runCase(byName("host_len_25")).extract.properties).toHaveLength(0);
    // 6 个字的问题留下，5 个字的当分组标题丢掉（_MIN_QUESTION_LEN）
    const texts = runCase(byName("question_len_edge")).extract.questions
      .map((q) => q.text);
    expect(texts).toContain("是否要审批吗");
    expect(texts).not.toContain("是否要审批");
    // 问卷的四个数值信号同时卡在线上；答复列多填一格（0.05 → 0.1）就不是问卷
    expect(byName("survey_edge").shape.row_unit).toBe("question");
    expect(byName("survey_edge_over").shape.row_unit).toBe("object");
  });

  it("规则抽取的几条硬规矩", () => {
    // 不是字典的行整行跳过，但**仍然占一个行数** —— fill 的分母是 len(rows)
    const junk = byName("junk_rows");
    expect(junk.shape.row_count).toBe(8);
    expect(junk.shape.columns[0]!.fill).toBe(0.625);
    expect(runCase(junk).extract.objects).toHaveLength(5);
    // 同一个编码出现多次只登记一次
    expect(runCase(byName("dup_objects")).extract.objects).toHaveLength(8);
    // cites 比 rows 短时在短的那一头停（zip strict=False）
    expect(runCase(byName("cites_short")).extract.objects).toHaveLength(3);
    // 路径里有两个动词段，取**最靠后**的；{id} 段跳过；一个都没有就 manage
    expect(runCase(byName("action_two_verbs")).extract.actions.map((a) => a.api_name))
      .toEqual(["export采购订单", "delete采购订单", "approve采购订单",
        "manage采购订单", "manage采购订单"]);
    // 「必填」列写成 √／× 也要认
    expect(runCase(byName("required_check")).extract.properties.map((p) => p.required))
      .toEqual([false, true, false, true, false, true,
        false, true, false, true, false, true]);
    // definition 取最长的那一列（口径），短的只当兜底；长度不足 2 的列不算候选
    const pick = runCase(byName("notes_pick")).extract.properties;
    expect(pick[0]!.definition).toContain("含税口径");
    expect(pick[1]!.definition).toBe("备注1");
    expect(runCase(byName("notes_minlen")).extract.properties[1]!.definition).toBe("");
  });

  it("问卷段直接返回 —— 不顺带产出规则或关系", () => {
    // 这一张问卷另有一列长文本；走到后面的散文兜底就会多出 RULES
    const c = byName("survey_with_prose");
    expect(c.shape.columns.map((x) => x.role)).toContain(ColumnRole.PROSE);
    expect(c.shape.yields).toEqual(["questions"]);
    // 散文列不占多数时也不是规则段（1 列散文 + 2 列结构）
    expect(byName("prose_minority").shape.row_unit).toBe("object");
    expect(byName("prose_minority").shape.yields).toEqual(["objects", "rules"]);
  });

  it("样本不足 3 行不下形状判断", () => {
    const c = byName("too_few");
    expect(c.shape.row_unit).toBeNull();
    expect(c.shape.yields).toEqual([]);
    expect(c.shape.note).toContain("样本太少");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Python 侧没覆盖、TS 侧必须自己钉住的语言分叉
// ══════════════════════════════════════════════════════════════════
describe("Python 原语的对齐", () => {
  it("round 是对二进制精确值做 half-even，不是 toFixed", () => {
    // golden 的 rounding 用例把 fill / distinct_ratio / mean_len 全凑成了精确平局
    const c = byName("rounding");
    expect(c.shape.columns.map((x) => [x.fill, x.distinct_ratio, x.mean_len]))
      .toEqual([[0.062, 1.0, 2.0], [0.25, 1.0, 6.2], [1.0, 0.062, 4.0]]);
    expect(runCase(c).shape.toDict().columns).toEqual(c.shape.columns);
    // 朝上进位的那两条路会给 0.063 / 6.3
    expect(Number((0.0625).toFixed(3))).toBe(0.063);
    expect(pyRound(0.0625, 3)).toBe(0.062);
    expect(pyRound(6.25, 1)).toBe(6.2);
    expect(pyRound(6.35, 1)).toBe(6.3);   // 6.35 的二进制值在 6.35 之下
    expect(pyRound(-0.0625, 3)).toBe(-0.062);
    expect(pyRound(0, 3)).toBe(0);
  });

  it("mean_len 按码点算 —— emoji 不许把阈值顶过去", () => {
    // 每格 1 个 emoji（UTF-16 里是 2 个码元）。按码元算 mean_len=2，
    // 按码点算 =1；判据吃的是码点。
    const rows = Array.from({ length: 6 }, (_, i) => ({ 名称: "🐍", 编码: `a${i}` }));
    const cols = classifyColumns(rows);
    expect(cols[0]!.meanLen).toBe(1);
  });

  it("strip 用 Python 的空白集：BOM 开头的单元格是**有值**的", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ 编码: `a${i}`, 名称: "﻿名" }));
    const cols = classifyColumns(rows);
    // trim 会把 "﻿名" 削成 "名"，长度 1；Python 的 strip 不动 BOM，长度 2
    expect(cols[1]!.meanLen).toBe(2);
    // 反过来，Python 认、JS 的 trim 不认的 \x85 必须被削掉
    const rows2 = Array.from({ length: 6 }, (_, i) => ({ 编码: `a${i}`, 名称: "\x85" }));
    expect(classifyColumns(rows2)[1]!.role).toBe(ColumnRole.EMPTY);
  });

  it("正则里的 \\d 认全角数字、\\w 认中日韩", () => {
    // golden 里已有全角编号的选项串；这里补 \w 那一条：中文路径的接口列
    expect(splitOptions("１. 全角一 ２. 全角二")).toEqual(["全角一", "全角二"]);
    const rows = Array.from({ length: 6 }, (_, i) => ({
      名称: `功能${i}`, 接口: `/接口/采购/查询${i}`,
    }));
    expect(classifyColumns(rows)[1]!.role).toBe(ColumnRole.ENDPOINT);
  });

  it("str(v)：None → \"None\"、True → \"True\"", () => {
    const c = byName("nonstring");
    expect(runCase(c).shape.toDict()).toEqual(c.shape);
    expect(c.shape.columns.find((x) => x.name === "启用")!.samples)
      .toEqual(["False", "True"]);
    // 键存在但值是 None 时，classify_columns 当空格处理，抽取却拿到 "None" ——
    // 荒唐但这就是 Python 侧的产物，翻译不许"顺手修好"
    const objs = runCase(byName("null_cell")).extract.objects;
    expect(objs[3]!.display_name).toBe("None");
    expect(byName("null_cell").shape.columns[1]!.fill).toBe(0.8);
  });

  it("samples 留 5 条（to_dict 只露 3 条，golden 看不见第 4、5 条）", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ 名称: `对象${i}` }));
    expect(classifyColumns(rows)[0]!.samples)
      .toEqual(["对象0", "对象1", "对象2", "对象3", "对象4"]);
  });

  it("**已知分叉**：整数值的 float 在 JS 里还原不出 Python 的 \"1.0\"", () => {
    const cell = (v: unknown) => classifyColumns(
      Array.from({ length: 6 }, () => ({ 值: v })))[0]!.samples;
    expect(cell(1.0)).toEqual(["1"]);      // Python 侧是 ["1.0"]
    expect(cell(1.5)).toEqual(["1.5"]);    // 非整数的浮点两边一致
  });

  it("列序是判据的一部分 —— 数字表头要用 Map 才不会被 V8 重排", () => {
    // 普通对象里 "2" 会被提到 "甲" 前面，答复槽（最右一列）就选错了
    const plain = Array.from({ length: 6 }, (_, i) => ({ 甲: `x${i}`, 2: "" }));
    expect(classifyColumns(plain).map((c) => c.name)).toEqual(["2", "甲"]);
    const maps: Row[] = Array.from({ length: 6 }, (_, i) =>
      new Map<string, unknown>([["甲", `x${i}`], ["2", ""]]));
    expect(classifyColumns(maps).map((c) => c.name)).toEqual(["甲", "2"]);
  });
});

describe("枚举与形状对象", () => {
  it("枚举值就是字符串，能 JSON 往返", () => {
    expect(JSON.parse(JSON.stringify({ r: ColumnRole.DATATYPE })))
      .toEqual({ r: "datatype" });
    expect(parseColumnRole("answer_slot")).toBe(ColumnRole.ANSWER_SLOT);
    expect(parseYield("questions")).toBe(Yield.QUESTIONS);
  });

  it("未知值抛，不静默放行", () => {
    expect(() => parseColumnRole("identifiers")).toThrow();
    expect(() => parseYield("object")).toThrow();
  });

  it("空 SegmentShape 可直接构造（pipeline 的 default_factory）", () => {
    const s = new SegmentShape();
    expect(s.toDict()).toEqual({
      row_count: 0, row_unit: null, yields: [], rule_decidable: [],
      columns: [], note: "",
    });
    expect(s.col(ColumnRole.LABEL)).toBeNull();
    expect(s.expects(Yield.OBJECTS)).toBe(false);
  });

  it("withRowCount 是 dataclasses.replace 的对等物：浅拷贝，列还是同一批", () => {
    const s = inferShape(byName("registry").rows);
    const w = s.withRowCount(3);
    expect(w.rowCount).toBe(3);
    expect(s.rowCount).toBe(14);
    expect(w.columns).toBe(s.columns);      // 整张表的判断沿用，不重算
    expect(w.toDict().note).toBe(s.toDict().note);
  });
});
