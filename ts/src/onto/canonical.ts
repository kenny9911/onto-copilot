/**
 * OntologyPackage v1 —— 归一层。移植自 `src/ontocopilot/onto/canonical.py`，
 * 由 `golden/canonical.json`（`tools/golden/canonical.py` 导出）钉住。
 *
 * 这一层是 legacy（OIR / FlowGraph）与稳定业务契约之间的**唯一收敛点**：同一个
 * 业务对象在四路输入里有七八种写法（`ot_plan` / `fn_plan` / `q_x` / `oq_x` /
 * 带 BOM 的、带全角的、大小写乱的），全靠这里收敛成一个 canonical id。
 *
 * **归一规则写宽一格，两个不同的业务对象就会拿到同一个 id 并静默合并。**
 * 那不是崩溃，是产物里少了一行 —— 没人会发现。所以这里的每条规则都窄到刚好够用，
 * 而且每条都有"差点该合并但不该合并"的反例钉在测试里。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`str.strip()` 与 `trim()` 的空白集不同**。Python 多剥 `\x1c`-`\x1f`
 *     与 `\x85`（NEL），JS 多剥 `﻿`（BOM）。canonical 层在 strip 之后
 *     **立刻判前缀**（`startswith("dec.")` / `startswith("pkg.")`），剥错一个
 *     字符就换一条分支 —— `"﻿q.bom"` 在 Python 眼里是遗留 id（要归一成
 *     `q.q.bom`），用 `trim()` 就变成"已规范"的 `q.bom`，两个不同的问题合并。
 *     所以这里自带 `pyStrip`，**不许**用 `trim()`。
 *  2. **字符串切片按 code point**。`snippet[:300]` 的证据片段几乎全是中文和
 *     emoji，按 UTF-16 切会少一半内容，还可能把代理对劈开。
 *  3. **dict 保插入序，JS 普通对象对整数样式的键会重排**。问题背包的 `by_id`
 *     键是问题的遗留 id，业务上真的会出现 `"1"`/`"2"`/`"10"` —— 而 questions
 *     的输出顺序直接来自它，重排就是产物 diff 全红。凡是键来自外部数据的字典
 *     一律用 `Map`。
 *  4. **`dict.get(k, default)` 在"键存在但值为 None"时返回 None**，不走 default。
 *     决定上 `{"actorRole": null, "actor_role": "FDE"}` 的结果是 `null` 而不是
 *     `"FDE"`。JS 的 `??` 语义相反，必须显式判键存在。
 *  5. **`isinstance(x, int)` 对 `bool` 为真**（bool 是 int 的子类）。
 *     `validate_package` 的 revision 校验直接受影响：`revision: true` 在
 *     Python 侧合法。
 *  6. **`.lower()` / `.upper()`**：`_data_kind` 的词表全是中文 + 小写 ASCII，
 *     两边在这个范围内逐字节一致（土耳其 İ、德语 ß、希腊终止 sigma 都验过，
 *     见 golden 的 `data_kind` 用例）。全码点扫描下两边有 110 个字符不一致，
 *     全部落在 Latin Ext-D 增补 / Garay 文字这些 Unicode 版本差异区，既不在
 *     slug 的保留集里也不可能拼出词表里的词，对本模块无影响。
 *
 * ── 无法消除的语言边界（不是 bug，是 JS 没有 float 类型） ──────────
 *
 *  · Python 内存里值为整数的 float（`confidence=1.0`）序列化成 `"1.0"`，
 *    TS 只能给 `"1"`。后果有二：
 *      (a) **evidence id 跨语言不同** —— id 是 `canonical_json(stable)` 的
 *          sha256，`confidence` 恰好是 1.0 时两边算出不同的 `ev.*`；
 *      (b) `export_package` 的**文本**在这些位置差一个 `.0`。
 *    结构（JSON.parse 之后）是一致的，只有字节形态不同。golden 里把这两条的
 *    确切形状都导了出来，测试按"已知差异"钉住而不是绕过。
 *  · 同理 `validate_package` 里 `isinstance(revision, int)`：Python 对
 *    `2.0` 报 REVISION，TS 侧 JSON.parse 之后 `2.0` 就是 `2`，报不出来。
 *  · JSON.parse **本身**会把整数样式的键重排。一份嵌套对象里带 `"1"`/`"0"`
 *    键的包，TS 读进来时顺序就已经变了 —— 这发生在本模块之前，本层无从补救。
 */

/*
 * ── 关于导出面 ──────────────────────────────────────────────────
 * Python 侧 `_canonical_id` / `_package_id` / `_value` / `_data_kind` /
 * `_PackageEvidenceIndex` 这些带下划线的都是私有的，`__all__` 里没有它们。TS 侧把它们
 * **导出**，是刻意的：归一规则宽一格就会静默合并两个业务对象，这种错不会在
 * 端到端断言里露头（产物只是少一行），必须逐条钉住。同理导出 `pyStr` /
 * `pyStrip` / `pyJsonDumps` 三个 Python 垫片 —— 它们的正确性同样只能被直接
 * 断言，而且下游模块要与 Python 时代的字节比对时会用得上。
 */

import { writeFileSync } from "node:fs";

import { pyRepr } from "../kernel/errors.js";
import { canonicalJson, sha256Hex, slug } from "../kernel/ids.js";
import { round3 } from "./oir.js";

export const SCHEMA_VERSION = "1.0.0";
export const SCHEMA_URL = "https://schemas.ontocopilot.dev/ontology-package/v1.schema.json";

export const COLLECTIONS = [
  "processes",
  "dataObjects",
  "actions",
  "events",
  "rules",
  "roles",
  "systems",
  "questions",
  "decisions",
  "evidence",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

type Dict = Record<string, unknown>;

export const ONTOLOGY_PACKAGE_JSON_SCHEMA: Dict = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_URL,
  title: "OntoCopilot OntologyPackage v1",
  type: "object",
  required: ["$schema", "schemaVersion", "packageId", "revision", "generatedAt",
    ...COLLECTIONS, "validation"],
  properties: {
    $schema: { const: SCHEMA_URL },
    schemaVersion: { const: SCHEMA_VERSION },
    packageId: { type: "string", pattern: "^pkg\\." },
    revision: { type: "integer", minimum: 1 },
    baseRevision: { type: ["integer", "null"], minimum: 1 },
    generatedAt: { type: "string", format: "date-time" },
    ...Object.fromEntries(COLLECTIONS.map((name) =>
      [name, { type: "array", items: { type: "object" } }] as const)),
    validation: { type: "object" },
  },
  additionalProperties: false,
};

// ══════════════════════════════════════════════════════════════════
//  Python 异常的对等物
// ══════════════════════════════════════════════════════════════════

// ValueError 收在 kernel/errors.ts —— 两份同名类就是两个类身份，
// `instanceof` 会漏掉其中一份且不报错。这里只 re-export，保住本模块的公开 API。
import { ValueError } from "../kernel/errors.js";
export { ValueError };

// KeyError 收在 kernel/errors.ts —— 两份同名类就是两个类身份，
// `instanceof` 会漏掉其中一份且不报错（ValueError 已经这样翻过一次车）。
import { KeyError } from "../kernel/errors.js";
export { KeyError };

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

function isNone(v: unknown): v is null | undefined {
  // undefined 是 JS 独有的"键不存在"，Python 侧对应的一律是 None。
  return v === null || v === undefined;
}

/** `x if x is not None else None` 的出口形态：写进产物的 dict 里 undefined 必须
 * 落成 null，否则 JSON.stringify 会把整个键**吞掉**，而 Python 会写 `null`。 */
function nn(v: unknown): unknown {
  return v === undefined ? null : v;
}

/** Python 的 Mapping 判定。数据全部来自 JSON.parse，所以"普通对象"就够 ——
 * 有原型的（OIR / FlowGraph 实例）走 to_dict 那条分支，正对应 Python 侧
 * `isinstance(source, Mapping)` 为假。 */
function isMapping(v: unknown): v is Dict {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasKey(o: Dict, k: string): boolean {
  // `k in o` 会走原型链（`"toString" in {}` 是 true），Python 的 `in` 不会。
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** `d.get(k)` —— 缺键给 undefined，等价于 Python 的 None。 */
function dget(o: unknown, k: string): unknown {
  return isMapping(o) && hasKey(o, k) ? o[k] : undefined;
}

/** `d.get(k, default)` —— **键存在但值为 None 时返回 None**，不走 default。
 * 这一条在决定的 `actorRole`/`actor_role` 回退链上是决定性的。 */
function dgetd(o: unknown, k: string, dflt: unknown): unknown {
  return isMapping(o) && hasKey(o, k) ? o[k] : dflt;
}

/** Python 的真值判断。JS 里 `[]` 和 `{}` 是真，Python 里是假 —— 本模块里
 * `source_endpoint or None`、`if process_nodes`、`options or []` 全靠它。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return !Number.isNaN(v) ? v !== 0 : true;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python 的 `a or b`。 */
function pyOr(a: unknown, b: unknown): unknown {
  return pyTruthy(a) ? a : b;
}

/** Python 的 `type(x).__name__`，只覆盖 JSON 能产生的那几种。 */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** Python 的 `repr(x)`（容器内部用）。字符串走 kernel/errors 的 `pyRepr`
 * ——那份已经把非 ASCII 不可打印字符的 `\xNN`/`\uNNNN`/`\UNNNNNNNN` 做到零差异。 */
function pyReprAny(v: unknown): string {
  return typeof v === "string" ? pyRepr(v) : pyStr(v);
}

function pyNum(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  // 已知边界：Python 的 float 1.0 给 "1.0"，JS 无从区分 1 与 1.0。
  return String(n);
}

/**
 * Python 的 `str(x)`，也就是 f-string 的 `f"{x}"`。
 *
 * `None` → `"None"`、`True` → `"True"`、列表 → `"['a', 'b']"`。**不要**用
 * `String(x)` 代替：`String(["a","b"])` 给 `"a,b"`，而 displayName /
 * rawStatement / name 这些字段全都走 `str(_value(...))` 直接印进产物 ——
 * 材料里出现列表值时，两边产物就差一行文案。
 */
export function pyStr(v: unknown): string {
  if (isNone(v)) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNum(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(pyReprAny).join(", ")}]`;
  if (isMapping(v)) {
    const body = Object.entries(v)
      .map(([k, x]) => `${pyRepr(k)}: ${pyReprAny(x)}`)
      .join(", ");
    return `{${body}}`;
  }
  return String(v);
}

/** Python 的 `float(x)`。不可转换的值 Python 抛且**没人接**，这里同样抛 ——
 * 静默变成 NaN 会混进 confidence 再混进 evidence id。 */
function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = pyStrip(v);
    if (t !== "") {
      const n = Number(t);
      if (!Number.isNaN(n)) return n;
    }
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** Python 的 `int(x)`：float 向零截断，字符串必须是整数字面量。 */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ValueError(`cannot convert ${pyNum(v)} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = pyStrip(v);
    if (/^[+-]?\d+$/.test(t)) return Number(t);
    throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${pyTypeName(v)}'`);
}

/** `isinstance(x, int)` —— **bool 是 int 的子类**，所以 `revision: true` 在
 * Python 侧算合法整数。JSON 里的 `2.0` 在 JS 侧已经塌成 `2`，这一条无从复现
 * （模块头注释里作为已知边界记着）。 */
function pyIsInt(v: unknown): boolean {
  return typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v));
}

/** Python 的 `>=`。数字与字符串**不可比**，Python 直接 TypeError 而 JS 的 `>=`
 * 会隐式转型 —— `revision: "2"` 这种脏包在 Python 侧是崩，TS 侧不能悄悄放过。 */
function pyGe(a: unknown, b: unknown): boolean {
  const numeric = (x: unknown): boolean => typeof x === "number" || typeof x === "boolean";
  if (numeric(a) && numeric(b)) return Number(a) >= Number(b);
  if (typeof a === "string" && typeof b === "string") return cmpCodePoint(a, b) >= 0;
  throw new TypeError(
    `'>=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** `x in some_set` —— Python 要求可哈希，list/dict 直接 TypeError。
 * JS 的 `Set.has` 对任何东西都只是返回 false，会让一份脏包在 Python 侧崩、
 * 在 TS 侧"校验通过"，那是两边行为分叉里最坏的一种。 */
function pyInSet(ref: unknown, allowed: ReadonlySet<unknown>): boolean {
  if (Array.isArray(ref)) throw new TypeError("unhashable type: 'list'");
  if (isMapping(ref)) throw new TypeError("unhashable type: 'dict'");
  return allowed.has(ref);
}

function pyInMap(ref: unknown, allowed: ReadonlyMap<unknown, unknown>): boolean {
  if (Array.isArray(ref)) throw new TypeError("unhashable type: 'list'");
  if (isMapping(ref)) throw new TypeError("unhashable type: 'dict'");
  return allowed.has(ref);
}

//: Python `str.isspace()` 为真的 29 个码点。JS `trim()` 用的是另一套：
//: 多 ﻿、少 \x1c-\x1f 与 \x85。见模块头注释第 1 条。
const PY_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python 的 `str.strip()`。**不要**用 `trim()` 代替 —— 见模块头注释第 1 条。 */
export function pyStrip(s: string): string {
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  const isSpace = (c: string): boolean => PY_SPACE.has(c.codePointAt(0)!);
  while (i < j && isSpace(cps[i]!)) i += 1;
  while (j > i && isSpace(cps[j - 1]!)) j -= 1;
  return cps.slice(i, j).join("");
}

/** Python 的 `s[:n]` 按 code point 切。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python 的 `sorted()` 按 code point 比字符串；JS 默认 sort 按 UTF-16 code unit。
 * 角色名里出现 CJK 扩展 B（U+20000 以上的生僻字）才分叉，但 roles 是产物里
 * 排好序的一列，错一位就是 diff 噪声。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

/** `for x in (v or [])`。Python 对字符串会拆成单字符、对 dict 会迭代键 ——
 * 照抄，不"美化"成 `[v]`：脏输入的形态两边必须一致。 */
function iterOr(v: unknown): unknown[] {
  if (!pyTruthy(v)) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isMapping(v)) return Object.keys(v);
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

function deepCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => deepCopy(x)) as unknown as T;
  if (isMapping(v)) {
    const out: Dict = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
    return out as unknown as T;
  }
  return v;
}

/** Python 的 `str.split(sep, 1)`。JS 的 `split` 没有 maxsplit，全拆之后再拼是错的
 * （`"a//b//c"` 要拆成 `["a", "b//c"]`）—— system_for 的域名提取靠它。 */
function splitOnce(s: string, sep: string): string[] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * Python 的 `json.dumps(obj, ensure_ascii=False, indent=…)`。
 *
 * **不能**用 `JSON.stringify` 代替：`indent=None` 时 Python 的默认分隔符是
 * `", "` / `": "`（带空格！），而 `JSON.stringify(x)` 是紧凑的。产物文件要与
 * Python 时代的字节比对，差一个空格就是整份 diff 全红。
 */
export function pyJsonDumps(v: unknown, indent: number | null): string {
  const itemSep = indent === null ? ", " : ",";
  const keySep = ": ";
  const pad = (level: number): string => (indent === null ? "" : " ".repeat(indent * level));
  const nl = indent === null ? "" : "\n";

  const enc = (x: unknown, level: number): string => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : (x > 0 ? "Infinity" : "-Infinity");
      // 已知边界：Python 的 float 1.0 写 "1.0"，JS 只能写 "1"。
      return String(x);
    }
    if (typeof x === "string") return JSON.stringify(x);
    if (Array.isArray(x)) {
      if (x.length === 0) return "[]";
      const body = x.map((e) => pad(level + 1) + enc(e, level + 1)).join(itemSep + nl);
      return `[${nl}${body}${nl}${pad(level)}]`;
    }
    const entries = Object.entries(x as Dict);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, e]) => `${pad(level + 1)}${JSON.stringify(k)}${keySep}${enc(e, level + 1)}`)
      .join(itemSep + nl);
    return `{${nl}${body}${nl}${pad(level)}}`;
  };
  return enc(v, 0);
}

/** `datetime.now(UTC).isoformat()` 的形态。JS 的 Date 只有毫秒精度，末三位
 * 恒为 0 —— 精度不如 Python，但格式（含 `+00:00` 而非 `Z`）必须一致，
 * 否则下游按 `date-time` 解析的地方会挑食。 */
function utcIsoNow(): string {
  const iso = new Date().toISOString(); // 2026-08-13T05:12:34.567Z
  return `${iso.slice(0, -1)}000+00:00`;
}

// ══════════════════════════════════════════════════════════════════
//  校验结果
// ══════════════════════════════════════════════════════════════════

export interface ValidationFinding {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly severity: string;
  readonly ref: string | null;
}

const FINDING_DEFAULTS = { path: "", severity: "error", ref: null } as const;

export function makeValidationFinding(p: {
  code: string;
  message: string;
  path?: string | undefined;
  severity?: string | undefined;
  ref?: string | null | undefined;
}): ValidationFinding {
  return {
    code: p.code,
    message: p.message,
    path: p.path ?? FINDING_DEFAULTS.path,
    severity: p.severity ?? FINDING_DEFAULTS.severity,
    ref: p.ref ?? FINDING_DEFAULTS.ref,
  };
}

export function findingToDict(f: ValidationFinding): Dict {
  const out: Dict = {
    code: f.code,
    severity: f.severity,
    path: f.path,
    message: f.message,
  };
  if (f.ref !== null) out["ref"] = f.ref;
  return out;
}

const DEFAULT_VALIDATORS = ["schema-shape", "global-id-uniqueness", "reference-integrity"];

/**
 * 一项**没有跑**的评审。
 *
 * `DegradeLevel.RULES_ONLY` 的枚举注释（`kernel/budget.ts:24`）承诺"产物标
 * 「未经语义审核」"，`budget.ts:263` 又写着这个标记"不该悄悄消失" —— 而在此
 * 之前 grep 全仓，**这个标记根本不存在**。注释在描述一个没实现的功能，而 latch
 * 的存在会让读代码的人以为它实现了。
 */
export interface SkippedReview {
  /** 没跑的是什么。例："llm_critic"。 */
  readonly what: string;
  /** 为什么没跑。给人看的一句话。 */
  readonly why: string;
  /** 触发跳过时的降级级别（`DegradeLevel` 的数值）。 */
  readonly level: number;
  /** 该级别的中文标签。 */
  readonly label: string;
}

export class ValidationReport {
  readonly findings: ValidationFinding[];
  readonly validators: string[];
  /**
   * 本次**没有跑**的评审。
   *
   * 放在 validation 里而不是新开一个包顶层字段，两个理由：
   *   1. **语义**：`validators` 本来就在宣称"这些检查跑过了"。一份只列 findings、
   *      却不说"语义评审整段没跑"的验证报告，恰恰就是缺陷本身。
   *   2. **兼容**：包的 JSON schema 是 `additionalProperties: false`（见
   *      `ONTOLOGY_PACKAGE_JSON_SCHEMA`），加顶层字段要改 schema 版本；
   *      而 `validation` 的子 schema 是 `{"type":"object"}`，完全开放。
   */
  readonly skippedReviews: SkippedReview[];

  constructor(p: { findings?: ValidationFinding[] | undefined;
    validators?: string[] | undefined;
    skippedReviews?: readonly SkippedReview[] | undefined } = {}) {
    // 每次新数组：Python 的 default_factory 语义，共享引用会让两份报告串味。
    this.findings = [...(p.findings ?? [])];
    this.validators = [...(p.validators ?? DEFAULT_VALIDATORS)];
    this.skippedReviews = [...(p.skippedReviews ?? [])];
  }

  get passed(): boolean {
    return !this.findings.some((f) => f.severity === "error");
  }

  toDict(): Dict {
    const out: Dict = {
      status: this.passed ? "passed" : "failed",
      validators: [...this.validators],
      findings: this.findings.map(findingToDict),
    };
    // **一项都没跳过时一个键都不加** —— 未降级的运行产出逐字节不变，
    // golden/canonical.json 的 from_dict_roundtrip 一动不动。
    //
    // 注意 status **不**因为跳过评审就变 failed：混淆"有 error"和"没审过"
    // 会让 fail-closed 的门开始误报，而 ExportHandler 那条判定是这个代码库里
    // 少数真正做对的地方，不该被这件事波及。
    if (this.skippedReviews.length > 0) {
      out["semantically_reviewed"] = false;
      out["skipped_reviews"] = this.skippedReviews.map((s) => ({ ...s }));
    }
    return out;
  }
}

// ══════════════════════════════════════════════════════════════════
//  包
// ══════════════════════════════════════════════════════════════════

export interface OntologyPackageInit {
  packageId: string;
  revision?: number | undefined;
  baseRevision?: number | null | undefined;
  generatedAt?: string | undefined;
  processes?: Dict[] | undefined;
  dataObjects?: Dict[] | undefined;
  actions?: Dict[] | undefined;
  events?: Dict[] | undefined;
  rules?: Dict[] | undefined;
  roles?: Dict[] | undefined;
  systems?: Dict[] | undefined;
  questions?: Dict[] | undefined;
  decisions?: Dict[] | undefined;
  evidence?: Dict[] | undefined;
  validation?: ValidationReport | undefined;
}

export class OntologyPackage {
  packageId: string;
  revision: number;
  baseRevision: number | null;
  generatedAt: string;
  processes: Dict[];
  dataObjects: Dict[];
  actions: Dict[];
  events: Dict[];
  rules: Dict[];
  roles: Dict[];
  systems: Dict[];
  questions: Dict[];
  decisions: Dict[];
  evidence: Dict[];
  validation: ValidationReport;

  // 默认值写在构造函数体里而不是 class field：子类的 field 初始化会在基类
  // 构造之后跑，用 class field 默认值会把基类刚赋的值再覆盖一遍。
  constructor(p: OntologyPackageInit) {
    this.packageId = p.packageId;
    this.revision = p.revision ?? 1;
    this.baseRevision = p.baseRevision ?? null;
    this.generatedAt = p.generatedAt ?? utcIsoNow();
    this.processes = [...(p.processes ?? [])];
    this.dataObjects = [...(p.dataObjects ?? [])];
    this.actions = [...(p.actions ?? [])];
    this.events = [...(p.events ?? [])];
    this.rules = [...(p.rules ?? [])];
    this.roles = [...(p.roles ?? [])];
    this.systems = [...(p.systems ?? [])];
    this.questions = [...(p.questions ?? [])];
    this.decisions = [...(p.decisions ?? [])];
    this.evidence = [...(p.evidence ?? [])];
    this.validation = p.validation ?? new ValidationReport();
  }

  get schemaVersion(): string {
    return SCHEMA_VERSION;
  }

  toDict(): Dict {
    return {
      $schema: SCHEMA_URL,
      schemaVersion: SCHEMA_VERSION,
      packageId: this.packageId,
      revision: this.revision,
      baseRevision: this.baseRevision,
      generatedAt: this.generatedAt,
      processes: deepCopy(this.processes),
      dataObjects: deepCopy(this.dataObjects),
      actions: deepCopy(this.actions),
      events: deepCopy(this.events),
      rules: deepCopy(this.rules),
      roles: deepCopy(this.roles),
      systems: deepCopy(this.systems),
      questions: deepCopy(this.questions),
      decisions: deepCopy(this.decisions),
      evidence: deepCopy(this.evidence),
      validation: this.validation.toDict(),
    };
  }

  /** 不做 ASCII 转义，中文业务术语原样落盘。 */
  toJson(indent: number | null = 2): string {
    return pyJsonDumps(this.toDict(), indent);
  }
}

/** 不静默迁移不支持的 schema 版本 —— 迁移是有损的，宁可拒绝。 */
export function packageFromDict(data: Dict): OntologyPackage {
  const version = pyStr(pyOr(dget(data, "schemaVersion"), ""));
  if (version !== SCHEMA_VERSION) {
    throw new ValueError(`unsupported OntologyPackage schemaVersion: ${pyRepr(version)}`);
  }
  const list = (k: string): Dict[] => deepCopy(iterOr(dget(data, k))) as Dict[];
  const baseRevision = dget(data, "baseRevision");
  const pkg = new OntologyPackage({
    packageId: pyStr(pyOr(dget(data, "packageId"), "")),
    revision: pyInt(pyOr(dget(data, "revision"), 0)),
    baseRevision: isNone(baseRevision) ? null : pyInt(baseRevision),
    generatedAt: pyStr(pyOr(dget(data, "generatedAt"), "")),
    processes: list("processes"),
    dataObjects: list("dataObjects"),
    actions: list("actions"),
    events: list("events"),
    rules: list("rules"),
    roles: list("roles"),
    systems: list("systems"),
    questions: list("questions"),
    decisions: list("decisions"),
    evidence: list("evidence"),
  });
  pkg.validation = validatePackage(pkg);
  return pkg;
}

/** `export_package` 的落点：文件路径，或任何有 `write(text)` 的东西。 */
export interface TextSink {
  write(text: string): void;
}

/** 把校验通过的包写成 JSON 文档。**校验不过就不写** —— 半份产物比没有更糟。 */
export function exportPackage(
  pkg: OntologyPackage | Dict,
  target: string | TextSink,
  indent = 2,
): void {
  const data = pkg instanceof OntologyPackage ? pkg.toDict() : deepCopy(pkg);
  const report = validatePackage(data);
  if (!report.passed) {
    const errors = report.findings
      .filter((f) => f.severity === "error")
      .map((f) => f.message)
      .join("; ");
    throw new ValueError(`invalid OntologyPackage: ${errors}`);
  }
  data["validation"] = report.toDict();
  const text = pyJsonDumps(data, indent) + "\n";
  if (typeof target === "string") writeFileSync(target, text, { encoding: "utf8" });
  else target.write(text);
}

// ══════════════════════════════════════════════════════════════════
//  归一原语
// ══════════════════════════════════════════════════════════════════

/** 活对象（OIR / FlowGraph）或它们的 `to_dict()` 载荷，两种都收。 */
export type PackageSource = Dict | { toDict(): Dict } | null | undefined;

function rawOf(source: PackageSource): Dict {
  if (isNone(source)) return {};
  if (isMapping(source)) return deepCopy(source);
  const obj = source as { toDict?: unknown };
  if (typeof obj.toDict === "function") return (obj as { toDict(): Dict }).toDict();
  throw new TypeError(`不认识的包来源：'${pyTypeName(source)}'`);
}

/**
 * 断言拆包。**Mapping 且含 `value` 键时无条件取 `value`（哪怕是 None）**，
 * 其余情况只有 None 才回落到 default —— `0` / `""` / `[]` / `False` 原样返回。
 * 写成 `?? default` 就是把 0 和空串也当缺失，那会让"数量=0"变成默认值。
 */
export function pyValue(v: unknown, dflt: unknown = ""): unknown {
  if (isMapping(v) && hasKey(v, "value")) return v["value"];
  return isNone(v) ? dflt : v;
}

/**
 * 遗留 id → canonical id。归一层的核心。
 *
 * 顺序是**固定**的：strip → 剥第一个命中的遗留前缀（`break`，只剥一层）→ slug
 * → 下划线换点。任何一步换位置结果就换 —— `"br_rule_x"` 命中 `br_` 就停，
 * 剩下的 `rule_` 留在 id 里（`rule.rule.x`），这是刻意的：多剥一层就会与
 * 真正的 `rule_x` 撞成同一个 id。
 */
export function canonicalId(prefix: string, legacyId: unknown, ...legacyPrefixes: string[]): string {
  let tail = pyStrip(pyStr(pyOr(legacyId, "")));
  for (const old of legacyPrefixes) {
    if (tail.startsWith(old)) {
      // startsWith 命中后，前 old.length 个 UTF-16 码元**就是** old 本身，
      // 所以按码元切与按 code point 切等价，无需再展开。
      tail = tail.slice(old.length);
      break;
    }
  }
  const body = slug(pyTruthy(tail) ? tail : prefix).replaceAll("_", ".");
  return `${prefix}.${body}`;
}

export function packageIdOf(value: unknown): string {
  const text = pyStrip(pyStr(pyOr(value, "default")));
  if (text.startsWith("pkg.")) return text;
  return `pkg.${slug(text).replaceAll("_", ".")}`;
}

/** 已经是 canonical 的 id 原样保留，遗留 id 才归一 —— 幂等的关键。 */
export function stableInputId(prefix: string, value: unknown, ...legacyPrefixes: string[]): string {
  const text = pyStrip(pyStr(pyOr(value, "")));
  return text.startsWith(`${prefix}.`)
    ? text
    : canonicalId(prefix, text, ...legacyPrefixes);
}

// ══════════════════════════════════════════════════════════════════
//  证据索引
// ══════════════════════════════════════════════════════════════════

// Python 侧这个类叫 `_EvidenceIndex`（私有、不在 __all__ 里），命名就是为了不和
// memory/evidence.py 里那个公开的 EvidenceIndex 撞名 —— 两者是完全不同的东西：
// 那边是 BM25 检索索引，这里是导出包的去重索引。TS 侧不用下划线前缀，改叫
// PackageEvidenceIndex 把同一个区分表达出来。
export class PackageEvidenceIndex {
  // 键是 `ev.<hex>`，不会撞上整数样式，但外部数据喂进来的键一律用 Map。
  readonly items = new Map<string, Dict>();

  add(evidence: Dict): string {
    const locatorRaw = pyOr(dget(evidence, "locator"), {});
    if (!isMapping(locatorRaw)) {
      throw new TypeError(`locator 必须是对象，收到 '${pyTypeName(locatorRaw)}'`);
    }
    const stable: Dict = {
      fileId: pyStr(pyOr(pyOr(dget(evidence, "file_id"), dget(evidence, "fileId")), "")),
      fileName: pyStr(pyOr(pyOr(dget(evidence, "file_name"), dget(evidence, "fileName")), "")),
      locator: deepCopy(locatorRaw),
      snippet: sliceCodePoints(pyStr(pyOr(dget(evidence, "snippet"), "")), 300),
      extractor: pyStr(pyOr(dget(evidence, "extractor"), "llm")),
      confidence: round3(pyFloat(pyOr(dget(evidence, "confidence"), 0.5))),
    };
    stable["cite"] = pyStr(pyOr(dget(evidence, "cite"), ""));
    const eid = `ev.${sha256Hex(canonicalJson(stable)).slice(0, 16)}`;
    if (!this.items.has(eid)) this.items.set(eid, { id: eid, ...stable });
    return eid;
  }

  /**
   * 把背包里的证据引用变成本包自有的 Evidence id。
   *
   * 统一问题背包**只存证据 id**。迁移窗口里这些 id 可能是 canonical 的 `ev.*`、
   * 一条遗留 cite 串，或者一整个证据对象。canonical id 原样保留；遗留 cite
   * 生成**确定性的占位 Evidence 记录**，而不是留下一条悬空引用。
   */
  reference(value: unknown): string | null {
    if (isMapping(value)) return this.add(value);
    const text = pyStrip(pyStr(pyOr(value, "")));
    if (!pyTruthy(text)) return null;
    if (text.startsWith("ev.")) {
      if (!this.items.has(text)) {
        this.items.set(text, {
          id: text, fileId: "", fileName: "", locator: {},
          snippet: "", extractor: "question-backlog", confidence: 0.5,
          cite: text,
        });
      }
      return text;
    }
    return this.add({ cite: text, extractor: "question-backlog", confidence: 0.5 });
  }

  assertion(...values: unknown[]): Dict {
    const origins: string[] = [];
    let confidence = 0.0;
    const evidenceIds: string[] = [];
    for (const value of values) {
      if (!isMapping(value)) continue;
      origins.push(pyStr(pyOr(dget(value, "origin"), "inferred")).toUpperCase());
      confidence = Math.max(confidence, pyFloat(pyOr(dget(value, "confidence"), 0.0)));
      for (const evidence of iterOr(dget(value, "evidence"))) {
        if (isMapping(evidence)) {
          const eid = this.add(evidence);
          if (!evidenceIds.includes(eid)) evidenceIds.push(eid);
        }
      }
    }
    const rank: Record<string, number> = {
      INFERRED: 0, AUTO_REPAIRED: 1, EXTRACTED: 2, USER: 3,
    };
    const pool = origins.length > 0 ? origins : ["INFERRED"];
    // Python 的 max(key=…) 返回**第一个**最大值，同 rank 时取先出现的那个。
    let origin = pool[0]!;
    for (const candidate of pool.slice(1)) {
      if ((rank[candidate] ?? 0) > (rank[origin] ?? 0)) origin = candidate;
    }
    return {
      origin,
      confidence: round3(pyTruthy(confidence)
        ? confidence
        : (origin === "INFERRED" ? 0.4 : 0.8)),
      evidenceIds,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  按名字猜业务类别
// ══════════════════════════════════════════════════════════════════
const MASTER_WORDS = ["供应商", "物料", "客户", "组织", "人员", "supplier", "material"];
const REFERENCE_WORDS = ["字典", "类型", "分类", "配置", "代码", "枚举", "catalog", "code"];
const DOCUMENT_WORDS = ["计划", "订单", "申请", "合同", "发票", "单据", "plan", "order", "invoice"];
const MESSAGE_WORDS = ["消息", "事件报文", "通知", "message", "eventpayload", "notification"];

/**
 * 名字 → (类别, 置信度)。**命中顺序是规则的一部分**：message > master >
 * reference > document > transaction。「供应商消息」两个词表都命中，按顺序
 * 归到 message；「物料字典」归到 master。换顺序就换分类，而分类会进产物。
 *
 * 词表全是中文 + 小写 ASCII，`.lower()` 在这个范围内两边逐字节一致。
 * 注意全角 `ＰＬＡＮ` 小写之后仍是全角，**不**命中 `plan` —— 这是对的，
 * 它和半角 `PLAN` 本来就可能是两个不同的东西。
 */
export function dataKind(name: string): [string, number] {
  const lowered = name.toLowerCase();
  if (MESSAGE_WORDS.some((w) => lowered.includes(w))) return ["message", 0.8];
  if (MASTER_WORDS.some((w) => lowered.includes(w))) return ["master", 0.7];
  if (REFERENCE_WORDS.some((w) => lowered.includes(w))) return ["reference", 0.7];
  if (DOCUMENT_WORDS.some((w) => lowered.includes(w))) return ["document", 0.65];
  return ["transaction", 0.25];
}

// ══════════════════════════════════════════════════════════════════
//  决定 / 问题的输入适配
// ══════════════════════════════════════════════════════════════════

function toDictLike(raw: unknown): Dict {
  if (isMapping(raw)) return raw;
  const obj = raw as { toDict?: unknown } | null;
  if (obj !== null && typeof obj === "object" && typeof obj.toDict === "function") {
    return (obj as { toDict(): Dict }).toDict();
  }
  // Python 走 vars(raw)，对 slots dataclass 会 TypeError。这里同样拒绝。
  throw new TypeError(`vars() argument must have __dict__ attribute`);
}

export function normaliseDecision(
  raw: unknown, index: number, questionIds: ReadonlyMap<string, string>,
): Dict {
  const data = toDictLike(raw);
  const legacyId = pyStr(pyOr(pyOr(dget(data, "id"), dget(data, "key")), `decision-${index}`));
  const refs = [...iterOr(pyOr(pyOr(dget(data, "affectedIds"), dget(data, "affected_ids")),
    dget(data, "scope_refs")))];
  let question = pyStr(pyOr(pyOr(dget(data, "questionId"), dget(data, "question_id")), ""));
  if (!pyTruthy(question)) {
    question = "";
    for (const r of refs) {
      if (pyInMap(r, questionIds)) {
        question = questionIds.get(r as string)!;
        break;
      }
    }
  }
  const answer = dgetd(data, "answer", dget(data, "statement"));
  const resolved = pyInMap(question, questionIds) ? questionIds.get(question)! : question;
  return {
    id: stableInputId("dec", legacyId, "dec_", "dlg_"),
    questionId: pyTruthy(resolved) ? resolved : null,
    answer: nn(answer),
    kind: pyStr(pyOr(dget(data, "kind"), "answer")),
    actor: nn(dget(data, "actor")),
    actorRole: nn(dgetd(data, "actorRole", dget(data, "actor_role"))),
    authority: nn(dget(data, "authority")),
    sourceTurn: nn(dgetd(data, "sourceTurn",
      dgetd(data, "source_turn", dget(data, "turn")))),
    effectiveAt: nn(dgetd(data, "effectiveAt",
      dgetd(data, "createdAt", dget(data, "ts")))),
    supersedes: nn(dget(data, "supersedes")),
    affectedIds: refs,
    revision: nn(dget(data, "revision")),
    legacyId,
  };
}

/**
 * 收 QuestionBacklog、它的 JSON 形态、单条 Question，或任意可迭代。
 *
 * 保持结构化（只看形状不看类型）是刻意的：canonical IR 不该反向依赖问题域的
 * 实现，而且历史上持久化的旧载荷也要能建包。
 */
export function questionInput(source: unknown): Dict[] {
  if (isNone(source)) return [];
  let cur: unknown = source;
  const asObj = cur as { toDict?: unknown } | null;
  if (asObj !== null && typeof asObj === "object" && typeof asObj.toDict === "function") {
    cur = (asObj as { toDict(): Dict }).toDict();
  }
  if (isMapping(cur)) {
    if (hasKey(cur, "questions")) cur = pyOr(cur["questions"], []);
    else if (hasKey(cur, "id") || hasKey(cur, "rid")) cur = [cur];
    else cur = Object.values(cur);
  }
  if (typeof cur === "string") throw new TypeError("questions/backlog must not be a string");
  if (!Array.isArray(cur)) throw new TypeError(`'${pyTypeName(cur)}' object is not iterable`);
  const out: Dict[] = [];
  for (const raw of cur) {
    let item: unknown = raw;
    const o = item as { toDict?: unknown } | null;
    if (o !== null && typeof o === "object" && typeof o.toDict === "function") {
      item = (o as { toDict(): Dict }).toDict();
    }
    if (!isMapping(item)) {
      throw new TypeError(`question must be an object, got ${pyTypeName(item)}`);
    }
    out.push(deepCopy(item));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  建包
// ══════════════════════════════════════════════════════════════════

export interface BuildPackageOptions {
  packageId?: string | undefined;
  revision?: number | undefined;
  baseRevision?: number | null | undefined;
  generatedAt?: string | null | undefined;
  decisions?: Iterable<unknown> | undefined;
  questions?: unknown;
  backlog?: unknown;
  /** 本次**没有跑**的评审。空数组 = 全跑了，产物里一个键都不加。 */
  skippedReviews?: readonly SkippedReview[] | undefined;
}

/**
 * 从当前的 OIR / FlowGraph 表示建出 OntologyPackage v1。
 *
 * 活对象与它们已有的 `to_dict()` 载荷都收。`questions`（及其别名 `backlog`）
 * 收统一的 QuestionBacklog 或它持久化后的 JSON：给了它就以它为准覆盖匹配的
 * OIR OpenQuestion 的生命周期字段，并补上 OIR 表达不了的冲突/人工问题。
 * canonical id 一律从遗留 rid 稳定导出，迁移窗口内每条都带 `legacyId`。
 */
export function buildPackage(
  oir: PackageSource,
  flow: PackageSource = null,
  options: BuildPackageOptions = {},
): OntologyPackage {
  const revision = options.revision ?? 1;
  const baseRevision = options.baseRevision ?? null;
  if (revision < 1) throw new ValueError("revision must be >= 1");
  if (baseRevision !== null && baseRevision >= revision) {
    throw new ValueError("base_revision must be lower than revision");
  }

  const oirData = rawOf(oir);
  const flowData = rawOf(flow);
  const evidence = new PackageEvidenceIndex();
  const pkg = new OntologyPackage({
    packageId: packageIdOf(options.packageId ?? "pkg.default"),
    revision,
    baseRevision,
    generatedAt: pyTruthy(options.generatedAt)
      ? pyStr(options.generatedAt)
      : utcIsoNow(),
  });

  // ── 数据对象 ───────────────────────────────────────────────────
  const objectIds = new Map<string, string>();
  for (const item of iterOr(dget(oirData, "objects"))) {
    const key = pyStr(dget(item, "rid"));
    objectIds.set(key, canonicalId("do", key, "ot_"));
  }
  const propertyById = new Map<string, unknown>();
  for (const item of iterOr(dget(oirData, "properties"))) {
    propertyById.set(pyStr(dget(item, "rid")), item);
  }
  const relationBySource = new Map<string, Dict[]>();
  for (const link of iterOr(dget(oirData, "links"))) {
    const source = pyStr(pyOr(dget(link, "from"), ""));
    const target = pyStr(pyOr(dget(link, "to"), ""));
    if (!objectIds.has(source) || !objectIds.has(target)) continue;
    const bucket = relationBySource.get(source) ?? [];
    bucket.push({
      id: canonicalId("rel", pyStr(dget(link, "rid")), "lt_"),
      name: pyStr(pyValue(dget(link, "apiName"))),
      target: objectIds.get(target)!,
      cardinality: pyStr(pyValue(dget(link, "cardinality"))),
      joinKey: nn(pyValue(dget(link, "joinKey"), null)),
      legacyId: pyStr(pyOr(dget(link, "rid"), "")),
    });
    relationBySource.set(source, bucket);
  }

  for (const item of iterOr(dget(oirData, "objects"))) {
    const legacyId = pyStr(pyOr(dget(item, "rid"), ""));
    const name = pyStr(pyOr(pyValue(dget(item, "displayName")), pyValue(dget(item, "apiName"))));
    const [kind, kindConfidence] = dataKind(name);
    const attributes: Dict[] = [];
    for (const propId of iterOr(dget(item, "properties"))) {
      const prop = propertyById.get(pyStr(propId));
      if (!pyTruthy(prop)) continue;
      attributes.push({
        id: canonicalId("attr", pyStr(dget(prop, "rid")), "pt_"),
        apiName: pyStr(pyValue(dget(prop, "apiName"))),
        displayName: pyStr(pyValue(dget(prop, "displayName"))),
        type: pyStr(pyValue(dget(prop, "baseType"))),
        definition: pyStr(pyValue(dget(prop, "definition"))),
        semanticType: nn(pyValue(dget(prop, "semanticType"), null)),
        unit: nn(pyValue(dget(prop, "unit"), null)),
        required: pyTruthy(pyValue(dget(prop, "required"), false)),
        valueDomain: nn(pyValue(dget(prop, "valueDomain"), null)),
        assertion: evidence.assertion(
          dget(prop, "apiName"), dget(prop, "displayName"), dget(prop, "definition")),
        legacyId: pyStr(pyOr(dget(prop, "rid"), "")),
      });
    }
    const keys: string[] = [];
    for (const key of iterOr(pyOr(pyValue(dget(item, "primaryKey"), []), []))) {
      if (propertyById.has(pyStr(key))) keys.push(canonicalId("attr", pyStr(key), "pt_"));
    }
    pkg.dataObjects.push({
      id: objectIds.get(legacyId)!,
      kind,
      classificationConfidence: kindConfidence,
      apiName: pyStr(pyValue(dget(item, "apiName"))),
      displayName: name,
      description: pyStr(pyValue(dget(item, "description"))),
      identity: { keys },
      systemOfRecord: null,
      ownerRole: null,
      lifecycleStates: [],
      attributes,
      relations: relationBySource.get(legacyId) ?? [],
      sensitivity: "internal",
      assertion: evidence.assertion(dget(item, "apiName"), dget(item, "displayName")),
      status: pyStr(pyOr(dget(item, "status"), "candidate")),
      legacyId,
    });
  }

  // ── 角色 / 系统：出现即登记，最后按名字排序输出 ──────────────────
  const roleIds = new Map<string, string>();
  const systemIds = new Map<string, string>();
  // slug 有长度上限，不同长名称/URL 可能收敛成同一个 canonical id。无碰撞时必须
  // 保持既有 golden；只有“不同 identity 占用同一个 id”时追加稳定 hash 后缀。
  const roleIdentityById = new Map<string, string>();
  const systemIdentityById = new Map<string, string>();
  const collisionSafeId = (
    preferred: string,
    identity: string,
    occupied: Map<string, string>,
  ): string => {
    const owner = occupied.get(preferred);
    if (owner === undefined || owner === identity) {
      occupied.set(preferred, identity);
      return preferred;
    }
    // 8 hex 已足够作为正常后缀；仍防御极端 hash 前缀碰撞，逐步加长而不是覆盖。
    const digest = sha256Hex(identity);
    for (let width = 8; width <= digest.length; width += 4) {
      const candidate = `${preferred}.h${digest.slice(0, width)}`;
      const candidateOwner = occupied.get(candidate);
      if (candidateOwner === undefined || candidateOwner === identity) {
        occupied.set(candidate, identity);
        return candidate;
      }
    }
    // sha256 全长仍冲突只可能是同 hash 的不同 identity；保留确定性且显式区分长度。
    const fallback = `${preferred}.h${digest}.${identity.length}`;
    occupied.set(fallback, identity);
    return fallback;
  };

  const roleFor = (name: unknown): string | null => {
    const text = pyStrip(pyStr(pyOr(pyValue(name), "")));
    if (!pyTruthy(text)) return null;
    if (text.startsWith("role.")) {
      const bare = text.slice("role.".length);
      if (!roleIds.has(bare)) {
        roleIds.set(bare, collisionSafeId(text, bare, roleIdentityById));
      }
      return roleIds.get(bare)!;
    }
    const rid = collisionSafeId(canonicalId("role", text), text, roleIdentityById);
    if (!roleIds.has(text)) roleIds.set(text, rid);
    return roleIds.get(text)!;
  };

  const systemFor = (endpoint: unknown): string | null => {
    const text = pyStrip(pyStr(pyOr(endpoint, "")));
    if (!pyTruthy(text)) return null;
    const afterScheme = splitOnce(text, "//").at(-1)!;
    const head = splitOnce(afterScheme, "/")[0]!;
    const identity = pyTruthy(head) ? head : text;
    const rid = collisionSafeId(canonicalId("sys", identity), identity, systemIdentityById);
    if (!systemIds.has(identity)) systemIds.set(identity, rid);
    return systemIds.get(identity)!;
  };

  // ── 行动 ───────────────────────────────────────────────────────
  const actionIds = new Map<string, string>();
  for (const item of iterOr(dget(oirData, "actions"))) {
    const legacyId = pyStr(pyOr(dget(item, "rid"), ""));
    const actionId = canonicalId("act", legacyId, "at_");
    actionIds.set(legacyId, actionId);
    const sourceEndpoint = pyOr(pyValue(dget(item, "sourceEndpoint"), null), {});
    const endpoint = isMapping(sourceEndpoint)
      ? pyStr(pyOr(pyOr(dget(sourceEndpoint, "path"), dget(sourceEndpoint, "url")), ""))
      : "";
    const related: string[] = [];
    for (const r of iterOr(dget(item, "appliesTo"))) {
      const k = r as string;
      if (objectIds.has(k)) related.push(objectIds.get(k)!);
    }
    pkg.actions.push({
      id: actionId,
      name: pyStr(pyValue(dget(item, "apiName"))),
      actorRole: null,
      system: systemFor(endpoint),
      inputs: [],
      outputs: [],
      relatedDataObjects: related,
      parameters: pyOr(pyValue(dget(item, "parameters"), []), []),
      preconditions: [],
      effects: pyOr(pyValue(dget(item, "effects"), []), []),
      emits: [],
      compensationAction: null,
      idempotency: null,
      sourceProcessNodes: [],
      sourceEndpoint: pyTruthy(sourceEndpoint) ? sourceEndpoint : null,
      assertion: evidence.assertion(dget(item, "apiName"), dget(item, "effects")),
      status: pyStr(pyOr(dget(item, "status"), "candidate")),
      legacyId,
    });
  }

  // ── 规则 ───────────────────────────────────────────────────────
  const ruleIds = new Map<string, string>();
  for (const item of iterOr(dget(oirData, "rules"))) {
    const legacyId = pyStr(pyOr(dget(item, "rid"), ""));
    const ruleId = canonicalId("rule", legacyId, "br_", "rule_");
    ruleIds.set(legacyId, ruleId);
    const actorRole = roleFor(dget(item, "actor"));
    const scope: string[] = [];
    for (const r of iterOr(dget(item, "appliesTo"))) {
      const k = r as string;
      if (objectIds.has(k)) scope.push(objectIds.get(k)!);
    }
    pkg.rules.push({
      id: ruleId,
      rawStatement: pyStr(pyValue(dget(item, "statement"))),
      ruleKind: pyStr(pyOr(pyValue(dget(item, "ruleKind")), "OTHER")),
      scope,
      trigger: null,
      normalizedExpression: null,
      outcome: actorRole !== null ? { requiredRole: actorRole } : {},
      exceptions: [],
      effectivePeriod: { from: null, to: null },
      compileStatus: "uncompiled",
      assertion: evidence.assertion(dget(item, "statement"), dget(item, "ruleKind")),
      status: pyStr(pyOr(dget(item, "status"), "candidate")),
      legacyId,
    });
  }

  // ── 问题：统一背包对生命周期/路由字段有最终解释权 ────────────────
  const questionsGiven = !isNone(options.questions);
  const backlogGiven = !isNone(options.backlog);
  if (questionsGiven && backlogGiven) {
    throw new ValueError("pass either questions or backlog, not both");
  }
  const suppliedQuestions = questionsGiven || backlogGiven
    ? questionInput(questionsGiven ? options.questions : options.backlog)
    : [];

  const questionIds = new Map<string, string>();
  const answered: [string, Dict][] = [];
  const legacyQuestions = [...iterOr(dget(oirData, "questions"))];
  // 统一背包是生命周期/路由字段的权威。背包里没有的问题保留 OIR 的断言；
  // 匹配上的把遗留答案/证据并进背包那一行，**不能**产生重复的 Question id。
  // 键来自外部数据（业务上真的有 "1"/"2"/"10" 这种遗留 id），必须用 Map ——
  // 普通对象会把整数样式的键重排，而 questions 的输出顺序直接来自这里。
  const byId = new Map<string, Dict>();
  for (const item of legacyQuestions) {
    const legacyId = pyStr(pyOr(pyOr(dget(item, "rid"), dget(item, "id")), ""));
    byId.set(legacyId, deepCopy(item as Dict));
  }
  for (const item of suppliedQuestions) {
    const legacyId = pyStr(pyOr(pyOr(dget(item, "id"), dget(item, "rid")), ""));
    const sourceRef = pyStr(pyOr(pyOr(dget(item, "sourceRef"), dget(item, "source_ref")), ""));
    const priorKey = byId.has(legacyId) ? legacyId : (byId.has(sourceRef) ? sourceRef : "");
    const prior = byId.get(priorKey) ?? {};
    const merged: Dict = { ...prior, ...item };
    // 背包按设计没有 answer 字段；当遗留 OIR 答案是唯一的决定来源时保留它，
    // 显式 Decision 仍然优先。
    if (isNone(dget(item, "answer")) && !isNone(dget(prior, "answer"))) {
      merged["answer"] = prior["answer"];
    }
    const key = pyTruthy(legacyId) ? legacyId : sourceRef;
    if (pyTruthy(priorKey) && priorKey !== key) byId.delete(priorKey);
    byId.set(key, merged);
  }

  const questionRows = [...byId.values()];
  // 先把所有别名解析完再转依赖引用，这样"依赖到后面才出现的问题"也认得出。
  let index = 0;
  for (const item of questionRows) {
    index += 1;
    const raw = pyStr(pyOr(pyOr(dget(item, "id"), dget(item, "rid")), ""));
    const sourceRef = pyStr(pyOr(pyOr(dget(item, "sourceRef"), dget(item, "source_ref")), ""));
    const legacyId = pyTruthy(raw) ? raw : (pyTruthy(sourceRef) ? sourceRef : `question-${index}`);
    const canonical = stableInputId("q", legacyId, "oq_", "q_");
    questionIds.set(legacyId, canonical);
    if (pyTruthy(sourceRef)) questionIds.set(sourceRef, canonical);
  }

  for (const item of questionRows) {
    let legacyId = pyStr(pyOr(pyOr(dget(item, "id"), dget(item, "rid")), ""));
    const sourceRef = pyStr(pyOr(pyOr(dget(item, "sourceRef"), dget(item, "source_ref")), ""));
    if (!pyTruthy(legacyId)) {
      // 注意兜底名与上一趟**不一致**（那边是 enumerate 的下标，这边是字典长度
      // 加一）：只要有一条问题既无 id/rid 也无 sourceRef，这里必然 KeyError。
      // 这是 Python 的既有行为，不是 TS 要"修好"的东西 —— 静默造一个 id 出来
      // 会让两个匿名问题合并成一个。
      legacyId = pyTruthy(sourceRef) ? sourceRef : `question-${questionIds.size + 1}`;
    }
    if (!questionIds.has(legacyId)) throw new KeyError(legacyId);
    const questionId = questionIds.get(legacyId)!;
    const answer = pyStr(pyOr(pyValue(dget(item, "answer")), ""));
    const rawBlocked = pyOr(pyOr(pyOr(dget(item, "blockedArtifacts"),
      dget(item, "blocked_artifacts")), dget(item, "appliesTo")), []);
    let applies = iterOr(rawBlocked).map((r) => {
      const k = r as string;
      if (objectIds.has(k)) return objectIds.get(k)!;
      if (actionIds.has(k)) return actionIds.get(k)!;
      if (ruleIds.has(k)) return ruleIds.get(k)!;
      return r;
    });
    const knownSemantics = new Set<unknown>([
      ...objectIds.values(), ...actionIds.values(), ...ruleIds.values(),
    ]);
    // `blockedArtifacts` 里可能混进产物血缘 id，那些不是语义实体。已经是
    // canonical 的包内引用保留；遗留的未知 id 在 OntologyPackage v1 里无法校验，
    // 宁可丢掉也不留一条悬空引用。
    applies = applies.filter((r) => pyInSet(r, knownSemantics));
    const rawEvidence = pyOr(pyOr(dget(item, "evidenceIds"), dget(item, "evidence_ids")), []);
    let evidenceIds: string[] = [];
    for (const value of iterOr(rawEvidence)) {
      const eid = evidence.reference(value);
      if (eid !== null) evidenceIds.push(eid);
    }
    if (evidenceIds.length === 0) {
      evidenceIds = evidence.assertion(dget(item, "text"))["evidenceIds"] as string[];
    }
    const rawDependencies = [...iterOr(dget(item, "dependencies"))];
    const audience = pyOr(pyOr(dget(item, "audienceRole"), dget(item, "audience_role")), "");
    const options_ = dget(item, "options");
    const answerSchema = pyOr(pyOr(dget(item, "answerSchema"), dget(item, "answer_schema")),
      pyTruthy(options_)
        ? { type: "string", enum: [...iterOr(options_)] }
        : { type: "string" });
    if (!isMapping(answerSchema)) {
      throw new TypeError(`answerSchema 必须是对象，收到 '${pyTypeName(answerSchema)}'`);
    }
    pkg.questions.push({
      id: questionId,
      gapId: nn(pyOr(dget(item, "gapId"), dget(item, "gap_id"))),
      code: pyStr(pyOr(dget(item, "code"), "")),
      text: pyStr(pyValue(dget(item, "text"))),
      audienceRole: roleFor(audience),
      ownerUserId: nn(pyOr(pyOr(dget(item, "ownerUserId"), dget(item, "owner_user_id")),
        dget(item, "owner"))),
      answerSchema: deepCopy(answerSchema),
      why: pyStr(pyOr(pyOr(dget(item, "why"), dget(item, "group")), "")),
      evidenceIds,
      blockedArtifacts: applies,
      // canonical id 在下面全部问题枚举完之后再解析。
      dependencies: rawDependencies,
      informationGain: nn(dgetd(item, "informationGain", dget(item, "information_gain"))),
      blastRadius: pyInt(pyOr(dgetd(item, "blastRadius", dget(item, "blast_radius")),
        applies.length)),
      priority: pyStr(pyOr(dget(item, "priority"), "normal")).toLowerCase(),
      status: pyTruthy(answer) && !pyTruthy(suppliedQuestions)
        ? "answered"
        : removePrefix(pyStr(pyOr(dget(item, "status"), "open")).toLowerCase(), "status."),
      askedBy: pyStr(pyOr(pyOr(dget(item, "askedBy"), dget(item, "sourceKind")), "customer")),
      sourceKind: pyStr(pyOr(pyOr(dget(item, "sourceKind"), dget(item, "source_kind")), "")),
      sourceRef: pyTruthy(sourceRef) ? sourceRef : null,
      version: pyInt(pyOr(dget(item, "version"), 0)),
      legacyId,
    });
    if (pyTruthy(answer)) answered.push([questionId, item]);
  }

  for (const item of pkg.questions) {
    item["dependencies"] = (item["dependencies"] as unknown[]).map((ref) => {
      const key = pyStr(ref);
      return questionIds.get(key) ?? key;
    });
  }

  // ── 流程图 ─────────────────────────────────────────────────────
  const flowNodes = [...iterOr(dget(flowData, "nodes"))];
  const processNodeIds = new Map<string, string>();
  for (const node of flowNodes) {
    const key = pyStr(dget(node, "rid"));
    processNodeIds.set(key, canonicalId("pn", key, "fn_"));
  }
  const eventIds = new Map<string, string>();
  const actionById = new Map<string, Dict>();
  for (const item of pkg.actions) actionById.set(item["id"] as string, item);
  const processNodes: Dict[] = [];
  for (const node of flowNodes) {
    const legacyId = pyStr(pyOr(dget(node, "rid"), ""));
    const kind = pyStr(pyOr(dget(node, "kind"), "")).toLowerCase();
    const label = pyStr(pyValue(dget(node, "label")));
    const objects: string[] = [];
    for (const r of iterOr(dget(node, "objects"))) {
      const k = r as string;
      if (objectIds.has(k)) objects.push(objectIds.get(k)!);
    }
    let semanticRef: string | null = null;
    if (kind === "action") {
      semanticRef = actionIds.get(legacyId) ?? null;
      if (semanticRef === null) {
        const candidate = canonicalId("act", legacyId, "fn_", "at_");
        // OIR 与 Flow 可能用不同的遗留前缀指同一个稳定业务动作。复用已经建好的
        // canonical action，而不是造一个重复 id —— 重复 id 会让整包校验不过。
        if (actionById.has(candidate)) {
          semanticRef = candidate;
          actionIds.set(legacyId, semanticRef);
          const target = actionById.get(semanticRef)!;
          const sources = target["sourceProcessNodes"] as string[];
          if (!sources.includes(processNodeIds.get(legacyId)!)) {
            sources.push(processNodeIds.get(legacyId)!);
          }
          const related = target["relatedDataObjects"] as string[];
          // Python 的 `list.extend(生成器)` 是**边消费边追加**的，所以生成器里的
          // `ref not in related` 看得见刚追加的项 —— objects 内部重复会被去掉。
          for (const ref of objects) if (!related.includes(ref)) related.push(ref);
        } else {
          semanticRef = candidate;
          actionIds.set(legacyId, semanticRef);
          const created: Dict = {
            id: semanticRef,
            name: label,
            actorRole: roleFor(dget(node, "actor")),
            system: systemFor(pyStr(pyOr(dget(node, "endpoint"), ""))),
            inputs: [], outputs: [], relatedDataObjects: objects,
            parameters: [], preconditions: [], effects: [], emits: [],
            compensationAction: null, idempotency: null,
            sourceProcessNodes: [processNodeIds.get(legacyId)!],
            sourceEndpoint: nn(pyOr(dget(node, "endpoint"), null)),
            assertion: evidence.assertion(dget(node, "label"), dget(node, "actor")),
            status: pyStr(pyOr(dget(node, "status"), "candidate")),
            legacyId,
          };
          pkg.actions.push(created);
          actionById.set(semanticRef, created);
        }
      } else {
        (actionById.get(semanticRef)!["sourceProcessNodes"] as string[])
          .push(processNodeIds.get(legacyId)!);
      }
    } else if (kind === "event") {
      semanticRef = canonicalId("evt", legacyId, "fn_", "evt_");
      eventIds.set(legacyId, semanticRef);
      pkg.events.push({
        id: semanticRef,
        name: label,
        producerAction: null,
        producerSystem: systemFor(pyStr(pyOr(dget(node, "endpoint"), ""))),
        payload: objects.length > 0 ? { dataObject: objects[0]!, schemaRef: null } : null,
        resultingState: null,
        consumers: [],
        delivery: null,
        sourceProcessNodes: [processNodeIds.get(legacyId)!],
        assertion: evidence.assertion(dget(node, "label")),
        status: pyStr(pyOr(dget(node, "status"), "candidate")),
        legacyId,
      });
    }
    processNodes.push({
      id: processNodeIds.get(legacyId)!,
      kind: kind.toUpperCase(),
      name: label,
      code: pyStr(pyOr(dget(node, "code"), "")),
      stageId: pyTruthy(dget(node, "stage"))
        ? canonicalId("stage", pyStr(dget(node, "stage")))
        : null,
      semanticRef,
      dataObjectRefs: objects,
      actorRole: roleFor(dget(node, "actor")),
      assertion: evidence.assertion(dget(node, "label"), dget(node, "actor")),
      legacyId,
    });
  }

  const processEdges: Dict[] = [];
  for (const edge of iterOr(dget(flowData, "edges"))) {
    const source = pyStr(pyOr(dget(edge, "from"), ""));
    const target = pyStr(pyOr(dget(edge, "to"), ""));
    if (!processNodeIds.has(source) || !processNodeIds.has(target)) continue;
    const evidenceIds: string[] = [];
    for (const e of iterOr(dget(edge, "evidence"))) {
      if (isMapping(e)) evidenceIds.push(evidence.add(e));
    }
    processEdges.push({
      id: canonicalId("pe", pyStr(dget(edge, "rid")), "fe_"),
      from: processNodeIds.get(source)!,
      to: processNodeIds.get(target)!,
      kind: pyStr(pyOr(dget(edge, "kind"), "flow")),
      condition: nn(pyOr(pyStr(pyOr(dget(edge, "label"), "")), null)),
      evidenceIds,
      legacyId: pyStr(pyOr(dget(edge, "rid"), "")),
    });
  }

  if (processNodes.length > 0) {
    const incoming = new Set(processEdges.map((e) => e["to"]));
    const outgoing = new Set(processEdges.map((e) => e["from"]));
    const workflowNames = iterOr(dget(flowData, "workflows"))
      .map((w) => pyStr(pyOr(dget(w, "title"), "")));
    const joined = workflowNames.filter((n) => pyTruthy(n)).join(" / ");
    pkg.processes.push({
      id: canonicalId("proc", pkg.packageId, "pkg."),
      name: pyTruthy(joined) ? joined : pkg.packageId,
      description: "",
      stages: iterOr(dget(flowData, "stages")).map((stage) => ({
        id: canonicalId("stage", pyStr(pyOr(dget(stage, "key"), "stage"))),
        name: pyStr(pyOr(dget(stage, "title"), "")),
        description: pyStr(pyOr(dget(stage, "subtitle"), "")),
        order: pyInt(pyOr(dget(stage, "order"), 0)),
        legacyId: pyStr(pyOr(dget(stage, "key"), "")),
      })),
      nodes: processNodes,
      edges: processEdges,
      entryNodeIds: processNodes.filter((n) => !incoming.has(n["id"])).map((n) => n["id"]),
      exitNodeIds: processNodes.filter((n) => !outgoing.has(n["id"])).map((n) => n["id"]),
      workflows: deepCopy([...iterOr(dget(flowData, "workflows"))]),
    });
  }

  // 生产者/消费者只从**显式的**流程邻接推，不猜。
  const eventByLegacy = new Map<string, Dict>();
  for (const item of pkg.events) eventByLegacy.set(item["legacyId"] as string, item);
  for (const edge of iterOr(dget(flowData, "edges"))) {
    const source = pyStr(pyOr(dget(edge, "from"), ""));
    const target = pyStr(pyOr(dget(edge, "to"), ""));
    if (actionIds.has(source) && eventByLegacy.has(target)) {
      const actionId = actionIds.get(source)!;
      const event = eventByLegacy.get(target)!;
      const eventId = event["id"] as string;
      event["producerAction"] = actionId;
      const action = actionById.get(actionId);
      if (action !== undefined) {
        const emits = action["emits"] as string[];
        if (!emits.includes(eventId)) emits.push(eventId);
      }
    }
    if (eventByLegacy.has(source) && actionIds.has(target)) {
      const actionId = actionIds.get(target)!;
      const consumers = eventByLegacy.get(source)!["consumers"] as string[];
      if (!consumers.includes(actionId)) consumers.push(actionId);
    }
  }

  // ── 决定 ───────────────────────────────────────────────────────
  const knownIds = new Set<unknown>([
    ...objectIds.values(), ...actionIds.values(),
    ...eventIds.values(), ...ruleIds.values(),
  ]);
  const rawDecisions = [...(options.decisions ?? [])];
  const decisionIds = new Map<string, string>();
  rawDecisions.forEach((rawDecision, i) => {
    const rawData = toDictLike(rawDecision);
    const legacyId = pyStr(pyOr(pyOr(dget(rawData, "id"), dget(rawData, "key")),
      `decision-${i + 1}`));
    decisionIds.set(legacyId, stableInputId("dec", legacyId, "dec_", "dlg_"));
  });
  rawDecisions.forEach((rawDecision, i) => {
    const decision = normaliseDecision(rawDecision, i + 1, questionIds);
    decision["actorRole"] = roleFor(decision["actorRole"]);
    const mapped = (decision["affectedIds"] as unknown[]).map((r) => {
      const k = r as string;
      if (objectIds.has(k)) return objectIds.get(k)!;
      if (actionIds.has(k)) return actionIds.get(k)!;
      if (ruleIds.has(k)) return ruleIds.get(k)!;
      if (eventIds.has(k)) return eventIds.get(k)!;
      return r;
    });
    decision["affectedIds"] = mapped.filter((r) => pyInSet(r, knownIds));
    const supersedes = decision["supersedes"];
    if (pyTruthy(supersedes)) {
      const key = pyStr(supersedes);
      decision["supersedes"] = decisionIds.get(key) ?? key;
    }
    pkg.decisions.push(decision);
  });

  const explicitQuestions = new Set(pkg.decisions.map((d) => d["questionId"]));
  for (const [questionId, item] of answered) {
    if (explicitQuestions.has(questionId)) continue;
    const legacyId = pyStr(pyOr(dget(item, "rid"), ""));
    const answer = pyOr(dget(item, "answer"), {});
    pkg.decisions.push({
      id: canonicalId("dec", `answer-${legacyId}`),
      questionId,
      answer: nn(pyValue(answer)),
      kind: "answer",
      actor: null,
      actorRole: null,
      authority: null,
      sourceTurn: null,
      effectiveAt: null,
      supersedes: null,
      affectedIds: [],
      revision,
      assertion: evidence.assertion(answer),
      legacyId: `answer:${legacyId}`,
    });
  }

  const sortedRoles = [...roleIds.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]));
  pkg.roles = sortedRoles.map(([name, rid]) => ({ id: rid, name }));
  const sortedSystems = [...systemIds.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]));
  pkg.systems = sortedSystems.map(([name, rid]) => ({ id: rid, name }));
  pkg.evidence = [...evidence.items.values()];
  pkg.validation = validatePackage(pkg, options.skippedReviews ?? []);
  return pkg;
}

function removePrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// ══════════════════════════════════════════════════════════════════
//  校验
// ══════════════════════════════════════════════════════════════════

/** 校验稳定形状与每一条 canonical 交叉引用。 */
export function validatePackage(
  pkg: OntologyPackage | Dict,
  skippedReviews: readonly SkippedReview[] = [],
): ValidationReport {
  // Python 侧对 Mapping 只做**浅**拷贝（`dict(package)`），照抄 —— 深拷贝会让
  // export_package 里"改 data['validation']"的副作用形态变掉。
  const data: Dict = pkg instanceof OntologyPackage ? pkg.toDict() : { ...pkg };
  const findings: ValidationFinding[] = [];

  const add = (code: string, message: string, path: string,
    severity = "error", ref: string | null = null): void => {
    findings.push(makeValidationFinding({ code, message, path, severity, ref }));
  };
  const check = (ref: unknown, allowed: ReadonlySet<unknown>, path: string): void => {
    if (!isNone(ref) && ref !== "" && !pyInSet(ref, allowed)) {
      add("DANGLING_REF", `referenced id ${pyStr(ref)} does not exist`, path,
        "error", pyStr(ref));
    }
  };

  if (dget(data, "$schema") !== SCHEMA_URL) {
    add("SCHEMA_URL", "unsupported or missing $schema", "/$schema");
  }
  if (dget(data, "schemaVersion") !== SCHEMA_VERSION) {
    add("SCHEMA_VERSION", "unsupported or missing schemaVersion", "/schemaVersion");
  }
  if (!pyStr(pyOr(dget(data, "packageId"), "")).startsWith("pkg.")) {
    add("PACKAGE_ID", "packageId must start with 'pkg.'", "/packageId");
  }
  if (!pyIsInt(dget(data, "revision")) || pyInt(pyOr(dget(data, "revision"), 0)) < 1) {
    add("REVISION", "revision must be an integer >= 1", "/revision");
  }
  const base = dget(data, "baseRevision");
  if (!isNone(base) && (!pyIsInt(base) || pyGe(base, dgetd(data, "revision", 0)))) {
    add("BASE_REVISION", "baseRevision must be lower than revision", "/baseRevision");
  }

  const ids = new Map<string, string>();
  const byCollection = new Map<string, Set<string>>();
  for (const collection of COLLECTIONS) {
    let items = dget(data, collection);
    if (!Array.isArray(items)) {
      add("COLLECTION_TYPE", `${collection} must be an array`, `/${collection}`);
      items = [];
    }
    const bucket = new Set<string>();
    byCollection.set(collection, bucket);
    (items as unknown[]).forEach((item, index) => {
      const path = `/${collection}/${index}`;
      if (!isMapping(item)) {
        add("ITEM_TYPE", "collection item must be an object", path);
        return;
      }
      const rid = pyStr(pyOr(dget(item, "id"), ""));
      if (!pyTruthy(rid)) {
        add("MISSING_ID", "canonical item must have an id", `${path}/id`);
        return;
      }
      if (ids.has(rid)) {
        add("DUPLICATE_ID", `duplicate canonical id ${rid}`, `${path}/id`, "error", rid);
      } else {
        ids.set(rid, path);
      }
      bucket.add(rid);
    });
  }
  const coll = (name: CollectionName): Set<string> => byCollection.get(name)!;
  const checkEvidenceIds = (value: unknown, path: string): void => {
    iterOr(value).forEach((ref, index) => {
      check(ref, coll("evidence"), `${path}/${index}`);
    });
  };

  const allIds = new Set<string>(ids.keys());
  const processNodeIds = new Set<string>();
  iterOr(dget(data, "processes")).forEach((process, pi) => {
    if (!isMapping(process)) return;
    const localNodes = new Set<string>();
    const stageIds = new Set<string>();
    for (const stage of iterOr(dget(process, "stages"))) {
      if (isMapping(stage) && pyTruthy(dget(stage, "id"))) stageIds.add(pyStr(dget(stage, "id")));
    }
    iterOr(dget(process, "nodes")).forEach((node, ni) => {
      if (!isMapping(node)) return;
      const nodeId = pyStr(pyOr(dget(node, "id"), ""));
      const path = `/processes/${pi}/nodes/${ni}`;
      if (!pyTruthy(nodeId)) {
        add("MISSING_PROCESS_NODE_ID", "process node must have an id", `${path}/id`);
      } else if (processNodeIds.has(nodeId)) {
        add("DUPLICATE_PROCESS_NODE_ID", `duplicate process node ${nodeId}`, path);
      }
      localNodes.add(nodeId);
      processNodeIds.add(nodeId);
      const semantic = dget(node, "semanticRef");
      if (pyTruthy(semantic) && !pyInSet(semantic, allIds)) {
        add("DANGLING_REF", `semanticRef ${pyStr(semantic)} does not exist`,
          `${path}/semanticRef`, "error", pyStr(semantic));
      }
      const stage = dget(node, "stageId");
      if (pyTruthy(stage) && !pyInSet(stage, stageIds)) {
        add("DANGLING_REF", `stageId ${pyStr(stage)} does not exist`,
          `${path}/stageId`, "error", pyStr(stage));
      }
      iterOr(dget(node, "dataObjectRefs")).forEach((ref, oi) => {
        if (!pyInSet(ref, coll("dataObjects"))) {
          add("DANGLING_REF", `DataObject ${pyStr(ref)} does not exist`,
            `${path}/dataObjectRefs/${oi}`, "error", pyStr(ref));
        }
      });
      checkEvidenceIds(dget(node, "analysisEvidenceIds"), `${path}/analysisEvidenceIds`);
      iterOr(dget(node, "erpMappings")).forEach((mapping, mi) => {
        if (isMapping(mapping)) {
          checkEvidenceIds(
            dget(mapping, "evidenceIds"),
            `${path}/erpMappings/${mi}/evidenceIds`,
          );
        }
      });
    });
    iterOr(dget(process, "edges")).forEach((edge, ei) => {
      if (!isMapping(edge)) return;
      for (const side of ["from", "to"] as const) {
        const ref = dget(edge, side);
        if (!pyInSet(ref, localNodes)) {
          add("DANGLING_REF", `process edge ${side} ${pyStr(ref)} does not exist`,
            `/processes/${pi}/edges/${ei}/${side}`, "error", pyStr(ref));
        }
      }
    });
    for (const fieldName of ["entryNodeIds", "exitNodeIds"] as const) {
      iterOr(dget(process, fieldName)).forEach((ref, ri) => {
        if (!pyInSet(ref, localNodes)) {
          add("DANGLING_REF", `process node ${pyStr(ref)} does not exist`,
            `/processes/${pi}/${fieldName}/${ri}`, "error", pyStr(ref));
        }
      });
    }
  });

  iterOr(dget(data, "dataObjects")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "systemOfRecord"), coll("systems"), `/dataObjects/${i}/systemOfRecord`);
    check(dget(item, "ownerRole"), coll("roles"), `/dataObjects/${i}/ownerRole`);
    checkEvidenceIds(dget(item, "analysisEvidenceIds"), `/dataObjects/${i}/analysisEvidenceIds`);
    iterOr(dget(item, "qualityRules")).forEach((rule, qi) => {
      if (isMapping(rule)) {
        checkEvidenceIds(
          dget(rule, "evidenceIds"),
          `/dataObjects/${i}/qualityRules/${qi}/evidenceIds`,
        );
      }
    });
    iterOr(dget(item, "relations")).forEach((relation, j) => {
      if (isMapping(relation)) {
        check(dget(relation, "target"), coll("dataObjects"),
          `/dataObjects/${i}/relations/${j}/target`);
      }
    });
  });

  iterOr(dget(data, "actions")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "actorRole"), coll("roles"), `/actions/${i}/actorRole`);
    check(dget(item, "system"), coll("systems"), `/actions/${i}/system`);
    check(dget(item, "compensationAction"), coll("actions"),
      `/actions/${i}/compensationAction`);
    const groups: [string, Set<string>][] = [
      ["inputs", coll("dataObjects")],
      ["outputs", coll("dataObjects")],
      ["relatedDataObjects", coll("dataObjects")],
      ["preconditions", coll("rules")],
      ["emits", coll("events")],
      ["sourceProcessNodes", processNodeIds],
    ];
    for (const [fieldName, allowed] of groups) {
      iterOr(dget(item, fieldName)).forEach((ref, j) => {
        check(ref, allowed, `/actions/${i}/${fieldName}/${j}`);
      });
    }
    iterOr(dget(item, "effects")).forEach((effect, j) => {
      if (isMapping(effect)) {
        check(dget(effect, "object"), coll("dataObjects"), `/actions/${i}/effects/${j}/object`);
      }
    });
  });

  iterOr(dget(data, "events")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "producerAction"), coll("actions"), `/events/${i}/producerAction`);
    check(dget(item, "producerSystem"), coll("systems"), `/events/${i}/producerSystem`);
    const payload = dget(item, "payload");
    if (isMapping(payload)) {
      check(dget(payload, "dataObject"), coll("dataObjects"), `/events/${i}/payload/dataObject`);
    }
    iterOr(dget(item, "consumers")).forEach((ref, j) => {
      check(ref, coll("actions"), `/events/${i}/consumers/${j}`);
    });
    iterOr(dget(item, "sourceProcessNodes")).forEach((ref, j) => {
      check(ref, processNodeIds, `/events/${i}/sourceProcessNodes/${j}`);
    });
  });

  iterOr(dget(data, "rules")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "trigger"), coll("events"), `/rules/${i}/trigger`);
    iterOr(dget(item, "scope")).forEach((ref, j) => {
      check(ref, allIds, `/rules/${i}/scope/${j}`);
    });
    checkEvidenceIds(dget(item, "analysisEvidenceIds"), `/rules/${i}/analysisEvidenceIds`);
  });

  iterOr(dget(data, "questions")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "audienceRole"), coll("roles"), `/questions/${i}/audienceRole`);
    const groups: [string, Set<string>][] = [
      ["blockedArtifacts", allIds],
      ["dependencies", coll("questions")],
      ["evidenceIds", coll("evidence")],
    ];
    for (const [fieldName, allowed] of groups) {
      iterOr(dget(item, fieldName)).forEach((ref, j) => {
        check(ref, allowed, `/questions/${i}/${fieldName}/${j}`);
      });
    }
  });

  iterOr(dget(data, "decisions")).forEach((item, i) => {
    if (!isMapping(item)) return;
    check(dget(item, "questionId"), coll("questions"), `/decisions/${i}/questionId`);
    check(dget(item, "actorRole"), coll("roles"), `/decisions/${i}/actorRole`);
    check(dget(item, "supersedes"), coll("decisions"), `/decisions/${i}/supersedes`);
    iterOr(dget(item, "affectedIds")).forEach((ref, j) => {
      check(ref, allIds, `/decisions/${i}/affectedIds/${j}`);
    });
  });

  // 断言可能出现在好几层嵌套里，全部走一遍。
  const walk = (value: unknown, path = ""): void => {
    if (isMapping(value)) {
      const assertion = dget(value, "assertion");
      if (isMapping(assertion)) {
        iterOr(dget(assertion, "evidenceIds")).forEach((ref, i) => {
          check(ref, coll("evidence"), `${path}/assertion/evidenceIds/${i}`);
        });
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "validation" && key !== "assertion") walk(child, `${path}/${key}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}/${index}`));
    }
  };
  walk(data);
  return new ValidationReport({ findings, skippedReviews });
}
