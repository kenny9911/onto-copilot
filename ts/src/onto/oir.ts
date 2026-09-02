/**
 * OIR —— Ontology 中间表示。移植自 `src/ontocopilot/onto/oir.py`，
 * 由 `golden/pipeline.oir.json`（真材料跑出来的）+ `golden/oir.json`（补齐
 * properties / links / rules 三个容器）钉住。
 *
 * 与 Palantir 三原语同构（ObjectType / LinkType / ActionType），保证下游可直接消费。
 *
 * **这个模块只有一个设计要点，但它是整个产品的信任基础**：每个值都包在
 * `Assertion` 里，强制携带 origin 和 evidence。想给某个字段赋值却拿不出出处？
 * 类型系统逼你显式写 `inferred(...)`，UI 就会用不同样式渲染它，FDE 一眼就知道
 * 哪些是系统猜的。
 *
 * 设计稿里 FDE 追问「你是怎么知道中广核的？」—— 系统必须能立刻答出「xlsx 内部
 * workbook.xml 的绝对保存路径」。答不上来的系统没有商业价值。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **真值判断**：Python 里 `[]` / `{}` / `""` / `0` 都是假，JS 里 `[]` 和 `{}`
 *     是真。`validate()` 报不报「未声明主键」「未声明 joinKey」全靠这一条 ——
 *     照 JS 语义写会让这两条校验永远不触发。见 `pyTruthy`。
 *  2. **`round(x, 3)`**：Python 是 round-half-**even**，`Math.round` 是 half-up。
 *     0.0625 → Python 0.062 / 朴素 JS 0.063。confidence 直接印进产物，差一位
 *     就是两边 diff 全红。见 `round3`。
 *  3. **字符串切片**：`snippet[:300]` 按 code point 切，JS 的 `slice` 按 UTF-16
 *     code unit 切 —— 证据片段里全是中文和 emoji，长度会差一半。
 *  4. **`f"{None}"` 是 `"None"`**：cite() 在字段缺失时打印 `RNoneCNone` /
 *     `#pNone`，JS 的 `String(undefined)` 给 `undefined`。这些串会印进 xlsx
 *     批注、进产物、被人点回原文，一个字都不能漂。见 `pyFmt`。
 *
 * ── 形态选择 ────────────────────────────────────────────────────
 *
 * 六个实体（Provenance / Assertion / ObjectType / …）是**纯数据 interface +
 * 工厂 + 自由函数**（`cite(p)` / `assertionToDict(a)` / `objectToDict(o)`），
 * 不是 class：它们要 JSON 往返，class 的原型在 `JSON.parse` 之后就没了。
 * 只有 `OIR` 是 class —— 它有真正的行为（add_* / dependents / stats）。
 * 六个容器用 `Map` 而不是普通对象：Python 的 dict 保插入序，而 JS 普通对象对
 * 整数样式的键会重排（rid 目前都带 `ot_` 前缀不会踩到，但不值得赌）。
 */

import { rid as makeRid } from "../kernel/ids.js";

export { makeRid };

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。JS 里 `[]`/`{}` 是真，Python 里是假 —— 这个差异决定了
 * `validate()` 会不会漏报「未声明主键」，也决定 `_assert_from` 里 `confidence`
 * 为 0 时是不是回落到 0.5。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** f-string 里的插值：Python 的 `f"{None}"` 是 `"None"`，缺字段的 cite 串靠它。 */
function pyFmt(v: unknown): string {
  // undefined 是 JS 独有的"键不存在"，Python 侧对应的一律是 None。
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** `str(x)`。数字上与 Python 有已知差异（Python `str(2.0)` 是 `"2.0"`），
 * 但这条路径上的值来自 JSON，整数值的 float 早在 parse 时就塌成整数了。 */
function pyStr(v: unknown): string {
  return String(v);
}

/** `float(x)`。Python 对不可转换的值抛 ValueError/TypeError 且**没人接**——
 * 这里同样抛，绝不静默变成 NaN 混进 confidence。 */
function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (!Number.isNaN(n) || /^nan$/i.test(v.trim())) return n;
  }
  throw new TypeError(`float() 接不了 ${JSON.stringify(v)}`);
}

/** `list(x or [])`。Python 对字符串会拆成单字符 —— 照抄，不"美化"成 [s]。 */
function pyList(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  throw new TypeError(`list() 接不了 ${JSON.stringify(v)}`);
}

function pyStrList(v: unknown): string[] {
  return pyList(v).map(pyStr);
}

/** Python 的 `sorted()` 按 code point 比字符串；JS 默认 sort 按 UTF-16 code unit。
 * BMP 内一致，rid 里出现 CJK 扩展 B（U+20000 以上的生僻字）才分叉。
 * 与 `kernel/ids.ts` 里的同名私有函数重复，等那边导出后收敛。 */
function cmpCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done && rb.done) return 0;
    if (ra.done) return -1;
    if (rb.done) return 1;
    const ca = ra.value.codePointAt(0)!;
    const cb = rb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

function incDecimal(digits: string): string {
  const out = [...digits];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== "9") {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
    out[i] = "0";
  }
  return "1" + out.join("");
}

/** Python 的 `round(x, 3)`。
 *
 * 不能写 `Math.round(x * 1000) / 1000`：那是 half-**up**，而 Python 是
 * half-**even**（对二进制精确的值才有区别，恰好 1/16 的倍数全中：
 * 0.0625 → 0.062 而不是 0.063），乘法本身还会再引入一次舍入误差。
 *
 * 这里先用 `toFixed(20)` 拿到 double 的精确十进制展开 —— 只有当尾巴恰好是
 * `5000…0` 时才是真正的平局，这时按末位取偶。 */
export function round3(x: number): number {
  if (!Number.isFinite(x)) return x;
  // toFixed 在 |x| >= 1e21 时退化成指数记法；confidence 永远够不着，兜个底。
  if (Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const [int = "0", frac = ""] = Math.abs(x).toFixed(20).split(".");
  const keep = frac.slice(0, 3).padEnd(3, "0");
  const rest = frac.slice(3);
  const head = rest[0] ?? "0";
  let up: boolean;
  if (head > "5") up = true;
  else if (head < "5") up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = Number(keep[2]) % 2 === 1; // 平局 → 进到偶数位
  const digits = up ? incDecimal(int + keep) : int + keep;
  const padded = digits.padStart(4, "0");
  const n = Number(`${padded.slice(0, -3)}.${padded.slice(-3)}`);
  // Python 的 round(-0.0001, 3) 是 -0.0，符号要留着。
  return neg ? -n : n;
}

/** Python 的 `s[:n]` 按 code point 切。证据片段几乎全是中文/emoji，按 UTF-16
 * 切会少一半内容，还可能把代理对劈开印出 U+FFFD。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// ══════════════════════════════════════════════════════════════════
//  溯源
// ══════════════════════════════════════════════════════════════════

export const LocatorKind = {
  CELL: "cell", // xlsx/csv 单元格
  RANGE: "range", // 行区间
  JSON: "json", // RFC 6901 JSON Pointer
  DDL: "ddl", // 表/列 + 源码 span
  PAGE: "page", // 扫描件页 + bbox
  META: "meta", // 文档元数据（作者、保存路径）
  XML: "xml", // BPMN/XML 元素 XPath-like pointer
  /** 模型给的自由文本定位串。**保留原样而不是硬塞进结构化字段** ——
   * 塞错字段会渲染成乱码，而出处渲染错等于「点回原文」这个承诺失效。 */
  RAW: "raw",
} as const;
export type LocatorKind = (typeof LocatorKind)[keyof typeof LocatorKind];

/** 一条证据的精确位置。Python 侧是 frozen dataclass —— 这里全 readonly。 */
export interface Provenance {
  readonly fileId: string;
  readonly fileName: string;
  readonly locator: Record<string, unknown>;
  readonly snippet: string;
  readonly extractor: string; // docling | openapi | sqlglot | ocr | code | llm
  readonly confidence: number;
}

export function makeProvenance(
  fileId: string,
  fileName: string,
  locator: Record<string, unknown>,
  opts: { snippet?: string; extractor?: string; confidence?: number } = {},
): Provenance {
  return {
    fileId,
    fileName,
    locator: { ...locator },
    snippet: opts.snippet ?? "",
    extractor: opts.extractor ?? "llm",
    confidence: opts.confidence ?? 0.5,
  };
}

/** 人可读引用串。UI 上点它就跳到原文并高亮。
 *
 * **逐字照搬 Python** —— 这些串会印进 xlsx 批注、进产物、被人点回原文。
 * 缺字段时打印的 `None`（`RNoneCNone` / `#pNone`）也是形态的一部分，
 * 不许"顺手修好"成空串：那会让两边的产物 diff 不上。 */
export function cite(p: Provenance): string {
  const loc = p.locator;
  // Python 分两种取法：`loc.get(k, "")` 缺键给空串，`loc.get(k)` 缺键给 None
  // 而 f-string 把 None 印成 "None"。两种都要留着，形态不同是有意的。
  const or0 = (k: string): string => (loc[k] === undefined ? "" : pyFmt(loc[k]));
  const orNone = (k: string): string => pyFmt(loc[k]);
  let tail: string;
  switch (loc["kind"]) {
    case LocatorKind.CELL:
      tail = `!${or0("sheet")}!R${orNone("row")}C${orNone("col")}`;
      break;
    case LocatorKind.RANGE: {
      // Python 是 loc.get("rows", [0, 0])：**键存在但值是垃圾时不会兜底**，
      // 而是直接在下标那里炸。这里同样炸，不静默印出 RNone-None。
      const raw = "rows" in loc ? loc["rows"] : [0, 0];
      const r = typeof raw === "string" ? [...raw] : raw;
      if (!Array.isArray(r) || r.length < 2) {
        throw new TypeError(`cite: locator.rows 不可下标 ${JSON.stringify(raw)}`);
      }
      tail = `!${or0("sheet")}!R${pyFmt(r[0])}-${pyFmt(r[1])}`;
      break;
    }
    case LocatorKind.JSON:
      tail = `#${or0("pointer")}`;
      break;
    case LocatorKind.DDL:
      tail = `#${or0("object")}`;
      break;
    case LocatorKind.PAGE:
      tail = `#p${orNone("page")}`;
      break;
    case LocatorKind.META:
      tail = `#${or0("field")}`;
      break;
    case LocatorKind.XML:
      tail = `#${or0("pointer")}`;
      break;
    case LocatorKind.RAW:
      tail = `#${or0("ref")}`;
      break;
    default:
      tail = "";
  }
  return `${p.fileName}${tail}`;
}

export function provToDict(p: Provenance): Record<string, unknown> {
  return {
    file_id: p.fileId,
    file_name: p.fileName,
    locator: p.locator,
    snippet: sliceCodePoints(p.snippet, 300),
    extractor: p.extractor,
    confidence: round3(p.confidence),
    cite: cite(p),
  };
}

export const Origin = {
  EXTRACTED: "extracted", // 从材料里抽出来的，有 evidence
  INFERRED: "inferred", // 系统推断的，可能无 evidence —— UI 上要区别渲染
  USER: "user", // 人填的 / 人拍板的，最高可信
  AUTO_REPAIRED: "auto_repaired", // 系统自动修的，可回滚
} as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

/** `Origin(v)` 的等价物：未知值抛错。别用 `as Origin` —— 那是把校验删掉。 */
export function parseOrigin(v: unknown): Origin {
  const s = pyStr(v);
  for (const x of Object.values(Origin)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid Origin`);
}

/** 一个带出处的值。
 *
 * `evidence` 为空且 `origin` 不是 INFERRED/USER 是非法状态 —— 由
 * `validateAssertion` 检出，Provenance critic 会把它判成 HIGH。
 *
 * 字段可变：下游（audit / conflict 的 auto_repair）就是原地改 `origin` 和
 * `value` 的，Python 侧的 dataclass 也没 frozen。 */
export interface Assertion<T> {
  value: T;
  origin: Origin;
  evidence: Provenance[];
  confidence: number;
}

export function grounded(a: Assertion<unknown>): boolean {
  return a.evidence.length > 0;
}

export function validateAssertion(a: Assertion<unknown>, path: string): string[] {
  if (a.origin === Origin.EXTRACTED && a.evidence.length === 0) {
    return [`${path}: origin=EXTRACTED 但没有 evidence`];
  }
  return [];
}

export function cites(a: Assertion<unknown>): string[] {
  return a.evidence.map(cite);
}

export function assertionToDict(a: Assertion<unknown>): Record<string, unknown> {
  return {
    value: a.value,
    origin: a.origin,
    confidence: round3(a.confidence),
    evidence: a.evidence.map(provToDict),
  };
}

export function extracted<T>(value: T, ...ev: Provenance[]): Assertion<T> {
  return { value, origin: Origin.EXTRACTED, evidence: [...ev], confidence: 0.8 };
}

export function inferred<T>(value: T): Assertion<T> {
  return { value, origin: Origin.INFERRED, evidence: [], confidence: 0.4 };
}

export function byUser<T>(value: T, note = ""): Assertion<T> {
  const a: Assertion<T> = { value, origin: Origin.USER, evidence: [], confidence: 0.98 };
  if (note) {
    a.evidence = [
      makeProvenance("human", "人工决策", { kind: "meta", field: note }, {
        snippet: note,
        extractor: "human",
        confidence: 1.0,
      }),
    ];
  }
  return a;
}

/** Python 侧是 `extracted(v, prov, confidence=1.0)` 这样的关键字参数；TS 的可变
 * 参数吃掉了尾部位置，所以拆成一个独立的包装（`withConfidence(extracted(...), 1)`）。 */
export function withConfidence<T>(a: Assertion<T>, confidence: number): Assertion<T> {
  return { ...a, evidence: [...a.evidence], confidence };
}

// ══════════════════════════════════════════════════════════════════
//  原语
// ══════════════════════════════════════════════════════════════════

export const Status = {
  CANDIDATE: "candidate",
  PROPOSED: "proposed",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  DRAFT_FROM_API: "draft_from_api", // 从 OpenAPI 反推的 ActionType，待人确认
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export function parseStatus(v: unknown): Status {
  const s = pyStr(v);
  for (const x of Object.values(Status)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid Status`);
}

export const BaseType = {
  STRING: "STRING",
  INTEGER: "INTEGER",
  DECIMAL: "DECIMAL",
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP",
  BOOLEAN: "BOOLEAN",
  ENUM: "ENUM",
} as const;
export type BaseType = (typeof BaseType)[keyof typeof BaseType];

export function parseBaseType(v: unknown): BaseType {
  const s = pyStr(v);
  for (const x of Object.values(BaseType)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid BaseType`);
}

export const Cardinality = {
  ONE_TO_ONE: "ONE_TO_ONE",
  ONE_TO_MANY: "ONE_TO_MANY",
  MANY_TO_MANY: "MANY_TO_MANY",
} as const;
export type Cardinality = (typeof Cardinality)[keyof typeof Cardinality];

export function parseCardinality(v: unknown): Cardinality {
  const s = pyStr(v);
  for (const x of Object.values(Cardinality)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid Cardinality`);
}

/** 必填字段照原样，其余可省 —— 对应 Python dataclass 的 default_factory。 */
type Init<T, R extends keyof T> = Pick<T, R> & Partial<Omit<T, R>>;

export interface PropertyType {
  rid: string;
  parent: string;
  apiName: Assertion<string>;
  displayName: Assertion<string>;
  baseType: Assertion<BaseType>;
  /** ★ 口径。「计划金额」的问题不在类型（都是 DECIMAL），在这里。
   * 把口径提升为一等结构化字段，冲突检测才有抓手。 */
  definition: Assertion<string>;
  semanticType: Assertion<string | null>;
  unit: Assertion<string | null>;
  required: Assertion<boolean>;
  valueDomain: Assertion<string[] | null>;
  owner: string | null;
  status: Status;
  conflicts: string[];
}

export function makePropertyType(
  p: Init<PropertyType, "rid" | "parent" | "apiName" | "displayName" | "baseType">,
): PropertyType {
  return {
    rid: p.rid,
    parent: p.parent,
    apiName: p.apiName,
    displayName: p.displayName,
    baseType: p.baseType,
    definition: p.definition ?? inferred(""),
    semanticType: p.semanticType ?? inferred(null),
    unit: p.unit ?? inferred(null),
    required: p.required ?? inferred(false),
    valueDomain: p.valueDomain ?? inferred(null),
    owner: p.owner ?? null,
    status: p.status ?? Status.CANDIDATE,
    conflicts: [...(p.conflicts ?? [])],
  };
}

export function propertyToDict(p: PropertyType): Record<string, unknown> {
  return {
    rid: p.rid,
    parent: p.parent,
    kind: "PropertyType",
    apiName: assertionToDict(p.apiName),
    displayName: assertionToDict(p.displayName),
    baseType: assertionToDict(p.baseType),
    definition: assertionToDict(p.definition),
    semanticType: assertionToDict(p.semanticType),
    unit: assertionToDict(p.unit),
    valueDomain: assertionToDict(p.valueDomain),
    required: assertionToDict(p.required),
    owner: p.owner,
    status: p.status,
    conflicts: p.conflicts,
  };
}

export interface ObjectType {
  rid: string;
  apiName: Assertion<string>;
  displayName: Assertion<string>;
  description: Assertion<string>;
  primaryKey: Assertion<string[]>;
  /** Python 侧同样有这个字段，但 to_dict / from_dict 都不碰它 ——
   * 也就是说它**存不住**，一次往返就回到 inferred(null)。照搬，不擅自补。 */
  titleProperty: Assertion<string | null>;
  properties: string[];
  aliases: string[];
  /** ★ 对象分类：业务对象/单据/主数据/事务/派生数据。分类决定下游怎么待它 ——
   * 主数据进字典表、单据进流程、派生数据不让人填。以前只有交付包里有这个概念
   * （编译时一律落 UNKNOWN），抽取侧根本没有坑位。 */
  classification: Assertion<string>;
  owner: string | null;
  status: Status;
  conflicts: string[];
}

export function makeObjectType(
  p: Init<ObjectType, "rid" | "apiName" | "displayName">,
): ObjectType {
  return {
    rid: p.rid,
    apiName: p.apiName,
    displayName: p.displayName,
    description: p.description ?? inferred(""),
    primaryKey: p.primaryKey ?? inferred([]),
    titleProperty: p.titleProperty ?? inferred(null),
    properties: [...(p.properties ?? [])],
    aliases: [...(p.aliases ?? [])],
    classification: p.classification ?? inferred(""),
    owner: p.owner ?? null,
    status: p.status ?? Status.CANDIDATE,
    conflicts: [...(p.conflicts ?? [])],
  };
}

export function objectToDict(o: ObjectType): Record<string, unknown> {
  return {
    rid: o.rid,
    kind: "ObjectType",
    apiName: assertionToDict(o.apiName),
    displayName: assertionToDict(o.displayName),
    description: assertionToDict(o.description),
    primaryKey: assertionToDict(o.primaryKey),
    properties: o.properties,
    aliases: o.aliases,
    // **可选发射**：没填时一个键都不多 —— golden 钉的是旧字节，老会话必须原样
    ...(o.classification.value ? { classification: assertionToDict(o.classification) } : {}),
    owner: o.owner,
    status: o.status,
    conflicts: o.conflicts,
  };
}

export interface LinkType {
  rid: string;
  apiName: Assertion<string>;
  /** Python 字段名是 source/target，产物里的键是 from/to（`from` 在 JS 里不是
   * 保留字但在 import 语境下极易撞车，保持 Python 的命名）。 */
  source: string;
  target: string;
  cardinality: Assertion<Cardinality>;
  joinKey: Assertion<Record<string, string> | null>;
  status: Status;
  conflicts: string[];
}

export function makeLinkType(
  p: Init<LinkType, "rid" | "apiName" | "source" | "target" | "cardinality">,
): LinkType {
  return {
    rid: p.rid,
    apiName: p.apiName,
    source: p.source,
    target: p.target,
    cardinality: p.cardinality,
    joinKey: p.joinKey ?? inferred(null),
    status: p.status ?? Status.CANDIDATE,
    conflicts: [...(p.conflicts ?? [])],
  };
}

export function linkToDict(l: LinkType): Record<string, unknown> {
  return {
    rid: l.rid,
    kind: "LinkType",
    apiName: assertionToDict(l.apiName),
    from: l.source,
    to: l.target,
    cardinality: assertionToDict(l.cardinality),
    joinKey: assertionToDict(l.joinKey),
    status: l.status,
    conflicts: l.conflicts,
  };
}

export interface ActionType {
  rid: string;
  apiName: Assertion<string>;
  appliesTo: string[];
  /** 执行角色。通用草案里按通识填的会在 package 编译时落成 assumed 绑定。 */
  actor: Assertion<string>;
  /** 前置条件（自然语言即可）。没有前置条件的 Action 无法进审批链配置。 */
  preconditions: Assertion<string[]>;
  parameters: Assertion<Record<string, unknown>[]>;
  effects: Assertion<string[]>;
  /** 从 OpenAPI 反推的来源。设计稿里的杀手锏：没人填 ActionType 时，
   * 从写操作端点反推草稿再让业务确认，比让他们从零写完成率高得多。 */
  sourceEndpoint: Assertion<Record<string, string> | null>;
  status: Status;
}

export function makeActionType(p: Init<ActionType, "rid" | "apiName">): ActionType {
  return {
    rid: p.rid,
    apiName: p.apiName,
    appliesTo: [...(p.appliesTo ?? [])],
    actor: p.actor ?? inferred(""),
    preconditions: p.preconditions ?? inferred([]),
    parameters: p.parameters ?? inferred([]),
    effects: p.effects ?? inferred([]),
    sourceEndpoint: p.sourceEndpoint ?? inferred(null),
    status: p.status ?? Status.CANDIDATE,
  };
}

export function actionToDict(a: ActionType): Record<string, unknown> {
  return {
    rid: a.rid,
    kind: "ActionType",
    apiName: assertionToDict(a.apiName),
    appliesTo: a.appliesTo,
    // **可选发射**：没填时一个键都不多 —— golden 钉的是旧字节，老数据必须原样。
    ...(a.actor.value ? { actor: assertionToDict(a.actor) } : {}),
    ...(a.preconditions.value.length > 0 ? { preconditions: assertionToDict(a.preconditions) } : {}),
    parameters: assertionToDict(a.parameters),
    effects: assertionToDict(a.effects),
    sourceEndpoint: assertionToDict(a.sourceEndpoint),
    status: a.status,
  };
}

/**
 * ★ 业务事件 —— OIR 的一等公民（A6 的第一步）。
 *
 * 以前 Event 只作为 FlowGraph 的一种 node kind 存在：进不了交付包的对象模型、
 * 拿不到证据、编辑面也补不了载荷；「没有流程图就没有事件」。
 * 现在抽取 schema 有了 events 桶，这里是它的落点。
 *
 * 字段刻意少：payload 是**对象 rid 列表**而不是自由 schema —— 事件带的是
 * 哪张单据的数据，先把这一层连上；字段级载荷等真实样本多了再说。
 * 序列化键与右栏的读法对齐（producerAction / objectIds —— context-sidebar
 * 的 modelItems 早就在读这两个键，只是一直没人发过）。
 */
export interface EventType {
  rid: string;
  apiName: Assertion<string>;
  displayName: Assertion<string>;
  /** 产生它的 Action（rid；解析不到时存原样 api_name，宁可粗也不丢）。 */
  emittedBy: string[];
  /** 事件载荷涉及的对象 rid。 */
  payload: string[];
  status: Status;
}

export function makeEventType(p: Init<EventType, "rid" | "apiName" | "displayName">): EventType {
  return {
    rid: p.rid,
    apiName: p.apiName,
    displayName: p.displayName,
    emittedBy: [...(p.emittedBy ?? [])],
    payload: [...(p.payload ?? [])],
    status: p.status ?? Status.CANDIDATE,
  };
}

export function eventToDict(e: EventType): Record<string, unknown> {
  return {
    rid: e.rid,
    kind: "EventType",
    apiName: assertionToDict(e.apiName),
    displayName: assertionToDict(e.displayName),
    emittedBy: e.emittedBy,
    // 右栏兼容键：modelItems 读 producerAction（单值）与 objectIds
    producerAction: e.emittedBy[0] ?? "",
    objectIds: e.payload,
    status: e.status,
  };
}

// ══════════════════════════════════════════════════════════════════
//  容器
// ══════════════════════════════════════════════════════════════════

/** 业务规则的类别。决定它下游变成什么 —— 校验规则进 schema，流程规则进
 * ActionType 的前置条件，权限规则进 ActionType 的可见性。 */
export const RuleKind = {
  VALIDATION: "VALIDATION", // 字段/记录级校验
  PROCESS: "PROCESS", // 流程与状态流转
  AUTHORITY: "AUTHORITY", // 谁能做什么
  CALCULATION: "CALCULATION", // 派生与计算口径
  OTHER: "OTHER",
} as const;
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];

export function parseRuleKind(v: unknown): RuleKind {
  const s = pyStr(v);
  for (const x of Object.values(RuleKind)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid RuleKind`);
}

/** 一条业务规则。
 *
 * 梳理表里最有价值也最容易丢的一类内容：整段整段的中文散文，既不是实体也不是
 * 字段，于是流水线里没有任何容器接得住它，抽出来就被丢掉。规则丢了，下游做出
 * 来的模型是一具没有约束的骨架 —— 字段都在，但谁都不知道什么时候能改。 */
export interface BusinessRule {
  rid: string;
  statement: Assertion<string>;
  kind: Assertion<RuleKind>;
  /** 这条规则约束哪些对象（object rid）。空 = 还没挂上，需要反问。 */
  appliesTo: string[];
  /** 承担这条规则的角色，如"采购计划员"。 */
  actor: Assertion<string>;
  /**
   * ★ **可判定的条件**。`statement` 是原话（"金额超过 50,000 元需总经理审批"），
   * 这里是能拿去执行的那一半（`estimatedAmount > 50000`）。
   *
   * 为什么必须单独一个字段：同一条业务事实现在会被写两遍 —— 一遍进 statement，
   * 一遍进流程网关的边标签（"金额 > 5万"）—— **两处没有任何可机读的联系，
   * 数字写法还不一样（50,000 vs 5万），矛盾了也没人发现**。有了这个字段，
   * 校验代码生成得出来，规则与分支的交叉核对也才有抓手。
   *
   * 形态是**归一化后的表达式文本**而不是结构体：`{subject,op,value}` 那种拆法
   * 在"两个条件与起来""按某个枚举取值分档"上会立刻不够用，而这一层现在还没有
   * 足够的真实样本来定形。先把话说准，结构化留给下一步。
   */
  condition: Assertion<string>;
  status: Status;
}

export function makeBusinessRule(p: Init<BusinessRule, "rid" | "statement">): BusinessRule {
  return {
    rid: p.rid,
    statement: p.statement,
    kind: p.kind ?? inferred(RuleKind.OTHER),
    appliesTo: [...(p.appliesTo ?? [])],
    actor: p.actor ?? inferred(""),
    condition: p.condition ?? inferred(""),
    status: p.status ?? Status.CANDIDATE,
  };
}

export function ruleToDict(r: BusinessRule): Record<string, unknown> {
  return {
    rid: r.rid,
    kind: "BusinessRule",
    statement: assertionToDict(r.statement),
    ruleKind: assertionToDict(r.kind),
    appliesTo: r.appliesTo,
    actor: assertionToDict(r.actor),
    // **可选发射**：没填时一个键都不多 —— golden 钉的是旧字节，老会话必须原样。
    // 与 actionToDict 的 actor/preconditions 是同一条纪律。
    ...(r.condition.value ? { condition: assertionToDict(r.condition) } : {}),
    status: r.status,
  };
}

/** 一个待澄清的问题。
 *
 * 客户材料里信息密度最高的一份，往往就是一张问卷 —— 150 行全是"我们还需要
 * 知道什么"。之前它没有容器，于是每一行问题被抽成一个 ObjectType
 * （`nodeQuestion46` / displayName="一条需求能不能只安排部分数量…"），
 * 既是垃圾又污染了整个 OIR。
 *
 * 这个容器同时接两个来源：客户自己问卷里搬过来的（`askedBy="customer"`）
 * 和我们从冲突里生成的（`"system"`）。两者合流之后才是"这个项目上还有多少
 * 没搞清楚"的完整答案 —— 分开统计只会让人以为已经问完了。 */
export interface OpenQuestion {
  rid: string;
  text: Assertion<string>;
  /** 参考选项。已经拆成一条条，模板直接拿去做下拉。 */
  options: string[];
  /** 答复。有答复 = 这是**事实**，不是待办 —— 它带着原始单元格的出处。 */
  answer: Assertion<string>;
  /** 所属流程节点 / 业务场景。 */
  group: string;
  /** 客户自己的编号。回传时要能对上号 —— 他们内部就是按这个编号讨论的。 */
  code: string;
  appliesTo: string[];
  askedBy: string;
  owner: string | null;
  status: Status;
}

export function makeOpenQuestion(p: Init<OpenQuestion, "rid" | "text">): OpenQuestion {
  return {
    rid: p.rid,
    text: p.text,
    options: [...(p.options ?? [])],
    answer: p.answer ?? inferred(""),
    group: p.group ?? "",
    code: p.code ?? "",
    appliesTo: [...(p.appliesTo ?? [])],
    askedBy: p.askedBy ?? "customer",
    owner: p.owner ?? null,
    status: p.status ?? Status.CANDIDATE,
  };
}

/** Python 是 `bool(self.answer.value.strip())`。
 *
 * **注意这里会炸**：`oirFromDict` 遇到没有 `answer` 键的问题（旧格式 / 手写
 * JSON）会还原出 `value = null`，于是这里对 null 取 `.trim()` 直接抛
 * TypeError —— Python 侧同样抛 AttributeError，连整份 `toDict()` 一起带走。
 * 不"顺手"改成静默当未答：那会让 TS 的 stats 数字和 Python 对不上，
 * 而这个模块存在的意义就是两边对得上。修要在 Python 侧一起修。 */
export function isAnswered(q: OpenQuestion): boolean {
  return q.answer.value.trim().length > 0;
}

export function questionToDict(q: OpenQuestion): Record<string, unknown> {
  return {
    rid: q.rid,
    kind: "OpenQuestion",
    text: assertionToDict(q.text),
    options: q.options,
    answer: assertionToDict(q.answer),
    group: q.group,
    code: q.code,
    appliesTo: q.appliesTo,
    askedBy: q.askedBy,
    owner: q.owner,
    status: q.status,
  };
}

/** 一个项目的完整本体中间表示。 */
export class OIR {
  readonly objects = new Map<string, ObjectType>();
  readonly properties = new Map<string, PropertyType>();
  readonly links = new Map<string, LinkType>();
  readonly actions = new Map<string, ActionType>();
  readonly rules = new Map<string, BusinessRule>();
  readonly events = new Map<string, EventType>();
  readonly questions = new Map<string, OpenQuestion>();

  // ── 构建 ────────────────────────────────────────────────────
  addObject(ot: ObjectType): ObjectType {
    this.objects.set(ot.rid, ot);
    return ot;
  }

  addProperty(pt: PropertyType): PropertyType {
    this.properties.set(pt.rid, pt);
    const parent = this.objects.get(pt.parent);
    if (parent && !parent.properties.includes(pt.rid)) parent.properties.push(pt.rid);
    return pt;
  }

  addLink(lt: LinkType): LinkType {
    this.links.set(lt.rid, lt);
    return lt;
  }

  addAction(at: ActionType): ActionType {
    this.actions.set(at.rid, at);
    return at;
  }

  addRule(br: BusinessRule): BusinessRule {
    this.rules.set(br.rid, br);
    return br;
  }

  addEvent(e: EventType): EventType {
    this.events.set(e.rid, e);
    return e;
  }

  addQuestion(q: OpenQuestion): OpenQuestion {
    this.questions.set(q.rid, q);
    return q;
  }

  // ── 查询 ────────────────────────────────────────────────────
  propsOf(objectRid: string): PropertyType[] {
    const o = this.objects.get(objectRid);
    // Python 是 self.objects[object_rid]，不存在就 KeyError。照抄地炸。
    if (!o) throw new Error(`KeyError: ${objectRid}`);
    const out: PropertyType[] = [];
    for (const r of o.properties) {
      const p = this.properties.get(r);
      if (p) out.push(p);
    }
    return out;
  }

  /** 无任何 Link 的孤立对象 —— 通常意味着遗漏，值得提示。 */
  orphans(): ObjectType[] {
    const linked = new Set<string>();
    for (const l of this.links.values()) {
      linked.add(l.source);
      linked.add(l.target);
    }
    return [...this.objects.values()].filter((o) => !linked.has(o.rid));
  }

  objectsWithoutActions(): ObjectType[] {
    const covered = new Set<string>();
    for (const a of this.actions.values()) for (const r of a.appliesTo) covered.add(r);
    return [...this.objects.values()].filter((o) => !covered.has(o.rid));
  }

  /** 受某个 rid 影响的实体 —— 澄清引擎算「影响半径」用。 */
  dependents(rid: string): string[] {
    const out: string[] = [];
    const o = this.objects.get(rid);
    if (o) {
      out.push(...o.properties);
      for (const l of this.links.values()) {
        if (rid === l.source || rid === l.target) out.push(l.rid);
      }
      for (const a of this.actions.values()) {
        if (a.appliesTo.includes(rid)) out.push(a.rid);
      }
      // 规则也在波及面里 ——「改这个对象会波及哪些规则」恰恰是客户当面最常问的，
      // 而这条以前不收，impact.trace 因此对规则全盲（影响分析 C1 缺口）。
      for (const r of this.rules.values()) {
        if (r.appliesTo.includes(rid)) out.push(r.rid);
      }
    } else {
      const pt = this.properties.get(rid);
      if (pt) {
        out.push(pt.parent);
        for (const l of this.links.values()) {
          const jk = l.joinKey.value;
          if (jk && Object.values(jk).includes(rid)) out.push(l.rid);
        }
      }
    }
    return [...new Set(out)].sort(cmpCodePoint);
  }

  // ── 校验 ────────────────────────────────────────────────────
  /** 结构性问题。Schema / Provenance 两个 critic 视角的规则来源。 */
  validate(): string[] {
    const errs: string[] = [];
    for (const o of this.objects.values()) {
      errs.push(...validateAssertion(o.apiName, `${o.rid}.apiName`));
      errs.push(...validateAssertion(o.displayName, `${o.rid}.displayName`));
      for (const pk of o.primaryKey.value ?? []) {
        if (!this.properties.has(pk)) errs.push(`${o.rid}: 主键引用了不存在的属性 ${pk}`);
      }
      // pyTruthy：空数组在 Python 里是假，写成 `!o.primaryKey.value` 这条永远不报。
      if (!pyTruthy(o.primaryKey.value)) errs.push(`${o.rid}: 未声明主键`);
    }
    for (const p of this.properties.values()) {
      errs.push(...validateAssertion(p.apiName, `${p.rid}.apiName`));
      errs.push(...validateAssertion(p.baseType, `${p.rid}.baseType`));
      if (!this.objects.has(p.parent)) errs.push(`${p.rid}: 父对象 ${p.parent} 不存在`);
    }
    for (const l of this.links.values()) {
      for (const [side, r] of [
        ["from", l.source],
        ["to", l.target],
      ] as const) {
        if (!this.objects.has(r)) errs.push(`${l.rid}: ${side} 指向不存在的对象 ${r}`);
      }
      if (!pyTruthy(l.joinKey.value)) errs.push(`${l.rid}: 未声明 joinKey`);
    }
    return errs;
  }

  // ── 统计 / 序列化 ───────────────────────────────────────────
  stats(): Record<string, number> {
    let open = 0;
    for (const q of this.questions.values()) if (!isAnswered(q)) open++;
    let confirmed = 0;
    for (const o of this.objects.values()) if (o.status === Status.CONFIRMED) confirmed++;
    return {
      objects: this.objects.size,
      properties: this.properties.size,
      links: this.links.size,
      actions: this.actions.size,
      rules: this.rules.size,
      ...(this.events.size > 0 ? { events: this.events.size } : {}),
      questions: this.questions.size,
      // 未答的那部分才是待办。答过的是事实，混在一起统计会让人以为
      // 还有一大堆没问，或者反过来以为已经问完了。
      open_questions: open,
      orphans: this.orphans().length,
      confirmed,
    };
  }

  toDict(): Record<string, unknown> {
    return {
      objects: [...this.objects.values()].map(objectToDict),
      properties: [...this.properties.values()].map(propertyToDict),
      links: [...this.links.values()].map(linkToDict),
      rules: [...this.rules.values()].map(ruleToDict),
      // **可选发射**：没有事件时一个键都不多 —— golden 钉的是旧字节
      ...(this.events.size > 0
        ? { events: [...this.events.values()].map(eventToDict) }
        : {}),
      questions: [...this.questions.values()].map(questionToDict),
      actions: [...this.actions.values()].map(actionToDict),
      stats: this.stats(),
    };
  }
}

// ══════════════════════════════════════════════════════════════════
//  反序列化
// ══════════════════════════════════════════════════════════════════

/** Python 的 `d.get(k)`：键不存在给 None。JS 的 undefined 在这条路径上一律
 * 归一成 null —— 不归一的话 `{value: undefined}` 会在 JSON 里凭空消失。 */
function g(d: Record<string, unknown>, k: string): unknown {
  const v = d[k];
  return v === undefined ? null : v;
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function provFrom(d: unknown): Provenance {
  // Python 是 `d.get(...)`，evidence 里混进非 dict 会 AttributeError。这里同样
  // 拒绝：静默产出一条空 Provenance 等于凭空捏造出处，比崩掉恶劣得多。
  if (!isPlainDict(d)) throw new TypeError(`evidence 里不是对象：${JSON.stringify(d)}`);
  const o = d;
  const loc = g(o, "locator");
  const conf = g(o, "confidence");
  return {
    fileId: pyTruthy(g(o, "file_id")) ? pyStr(g(o, "file_id")) : "",
    fileName: pyTruthy(g(o, "file_name")) ? pyStr(g(o, "file_name")) : "",
    locator: isPlainDict(loc) ? { ...loc } : {},
    snippet: pyTruthy(g(o, "snippet")) ? pyStr(g(o, "snippet")) : "",
    extractor: pyTruthy(g(o, "extractor")) ? pyStr(g(o, "extractor")) : "llm",
    // `or 0.5`：confidence 明确写成 0 的会被当成"没填"，落回 0.5。
    // 看着像 bug，但它是 Python 侧的既定行为，改了两边产物就 diff 不上。
    confidence: pyTruthy(conf) ? pyFloat(conf) : 0.5,
  };
}

/** 还原一条断言。
 *
 * `origin` 和 `evidence` 必须原样还原，不能重建成 inferred —— 一份重启后
 * 加载回来的 OIR 如果把所有 EXTRACTED 降级成 INFERRED，溯源链就断了，而
 * `validateAssertion` 只检查 "EXTRACTED 却没有 evidence" 这一种非法态，
 * 降级后的东西完全合法、静默通过。 */
function assertFrom(d: unknown, cast?: (v: unknown) => unknown): Assertion<unknown> {
  if (!isPlainDict(d)) return inferred(d === undefined ? null : d);
  let v = g(d, "value");
  if (cast && v !== null) {
    try {
      v = cast(v);
    } catch {
      // 枚举里没有的值原样留着 —— 抹成默认值等于把"模型给了个没见过的类型"
      // 这件事悄悄吞掉。
    }
  }
  let origin: Origin;
  try {
    origin = parseOrigin(pyTruthy(g(d, "origin")) ? g(d, "origin") : "inferred");
  } catch {
    origin = Origin.INFERRED;
  }
  const ev = g(d, "evidence");
  const conf = g(d, "confidence");
  return {
    value: v,
    origin,
    evidence: pyList(ev).map(provFrom),
    // 注意默认是 0.5，不是 inferred() 的 0.4 —— Python 这里是直接构造
    // Assertion 而不是走工厂，缺 confidence 的字段还原出来会比 inferred 高一档。
    confidence: pyTruthy(conf) ? pyFloat(conf) : 0.5,
  };
}

function statusFrom(v: unknown): Status {
  try {
    return parseStatus(v);
  } catch {
    return Status.CANDIDATE;
  }
}

/** 从 `OIR.toDict()` 的产物还原。
 *
 * 没有这个函数的后果是**进程重启即失能**：产物 oir.json 还在磁盘上，但服务
 * 起来之后没有任何路径能把它变回一个活的 OIR，于是"回答问题""采纳建议"
 * "重出模板""审核回传"全部 409 —— 用户看着一个有产物的会话，什么都做不了。
 *
 * 注意这里**不用 add_\* 走一遍**，而是直接塞进容器：`add_property` 会往父对象
 * 的 properties 里追加，而产物里那份列表已经是完整的，走一遍就会重复。 */
export function oirFromDict(data: Record<string, unknown>): OIR {
  const oir = new OIR();
  // Python 是 `for o in data.get("objects", ())` 后直接 `o["rid"]` —— 行不是
  // dict、或者没有 rid，都会当场 TypeError/KeyError。这里同样炸：一份少了 rid
  // 的产物静默丢行，比崩掉难查一百倍。
  const rows = (k: string): Record<string, unknown>[] =>
    pyList(g(data, k)).map((row) => {
      if (!isPlainDict(row)) throw new TypeError(`${k}: 行不是对象 ${JSON.stringify(row)}`);
      if (row["rid"] === undefined) throw new Error(`KeyError: ${k}[].rid`);
      return row;
    });
  /** `x.get(k, "")`：只有键缺失才给空串。null 在 Python 侧会原样留着（然后
   * to_dict 印出 null），TS 这里的字段类型是 string，统一收敛成空串 —— 这是
   * 一处**有意的分叉**，只影响脏输入的产物形态，不影响任何比较逻辑。 */
  const str0 = (d: Record<string, unknown>, k: string): string =>
    d[k] === undefined || d[k] === null ? "" : pyStr(d[k]);

  for (const o of rows("objects")) {
    const rid = pyStr(o["rid"]);
    oir.objects.set(rid, {
      rid,
      apiName: assertFrom(g(o, "apiName")) as Assertion<string>,
      displayName: assertFrom(g(o, "displayName")) as Assertion<string>,
      description: assertFrom(g(o, "description")) as Assertion<string>,
      primaryKey: assertFrom(g(o, "primaryKey")) as Assertion<string[]>,
      titleProperty: inferred(null),
      properties: pyStrList(g(o, "properties")),
      aliases: pyStrList(g(o, "aliases")),
      // 老数据没有这个键（可选发射），缺省回落到与 makeObjectType 相同的空断言
      classification: o["classification"] === undefined
        ? inferred("")
        : (assertFrom(g(o, "classification")) as Assertion<string>),
      owner: (g(o, "owner") as string | null) ?? null,
      status: statusFrom(g(o, "status")),
      conflicts: pyStrList(g(o, "conflicts")),
    });
  }
  for (const x of rows("properties")) {
    const rid = pyStr(x["rid"]);
    oir.properties.set(rid, {
      rid,
      parent: str0(x, "parent"),
      apiName: assertFrom(g(x, "apiName")) as Assertion<string>,
      displayName: assertFrom(g(x, "displayName")) as Assertion<string>,
      baseType: assertFrom(g(x, "baseType"), parseBaseType) as Assertion<BaseType>,
      definition: assertFrom(g(x, "definition")) as Assertion<string>,
      semanticType: assertFrom(g(x, "semanticType")) as Assertion<string | null>,
      unit: assertFrom(g(x, "unit")) as Assertion<string | null>,
      valueDomain: assertFrom(g(x, "valueDomain")) as Assertion<string[] | null>,
      required: assertFrom(g(x, "required")) as Assertion<boolean>,
      owner: (g(x, "owner") as string | null) ?? null,
      status: statusFrom(g(x, "status")),
      conflicts: pyStrList(g(x, "conflicts")),
    });
  }
  for (const l of rows("links")) {
    const rid = pyStr(l["rid"]);
    oir.links.set(rid, {
      rid,
      apiName: assertFrom(g(l, "apiName")) as Assertion<string>,
      source: str0(l, "from"),
      target: str0(l, "to"),
      cardinality: assertFrom(g(l, "cardinality"), parseCardinality) as Assertion<Cardinality>,
      joinKey: assertFrom(g(l, "joinKey")) as Assertion<Record<string, string> | null>,
      status: statusFrom(g(l, "status")),
      conflicts: pyStrList(g(l, "conflicts")),
    });
  }
  for (const a of rows("actions")) {
    const rid = pyStr(a["rid"]);
    oir.actions.set(rid, {
      rid,
      apiName: assertFrom(g(a, "apiName")) as Assertion<string>,
      appliesTo: pyStrList(g(a, "appliesTo")),
      // 老数据没有这两个键（可选发射），缺省回落到与 makeActionType 相同的空断言
      actor: a["actor"] === undefined ? inferred("") : (assertFrom(g(a, "actor")) as Assertion<string>),
      preconditions: a["preconditions"] === undefined
        ? inferred([])
        : (assertFrom(g(a, "preconditions")) as Assertion<string[]>),
      parameters: assertFrom(g(a, "parameters")) as Assertion<Record<string, unknown>[]>,
      effects: assertFrom(g(a, "effects")) as Assertion<string[]>,
      sourceEndpoint: assertFrom(g(a, "sourceEndpoint")) as Assertion<Record<
        string,
        string
      > | null>,
      status: statusFrom(g(a, "status")),
    });
  }
  for (const r of rows("rules")) {
    const rid = pyStr(r["rid"]);
    oir.rules.set(rid, {
      rid,
      statement: assertFrom(g(r, "statement")) as Assertion<string>,
      kind: assertFrom(g(r, "ruleKind"), parseRuleKind) as Assertion<RuleKind>,
      appliesTo: pyStrList(g(r, "appliesTo")),
      actor: assertFrom(g(r, "actor")) as Assertion<string>,
      // 老数据没有这个键（可选发射），缺省回落到与 makeBusinessRule 相同的空断言
      condition: r["condition"] === undefined
        ? inferred("")
        : (assertFrom(g(r, "condition")) as Assertion<string>),
      status: statusFrom(g(r, "status")),
    });
  }
  // 老数据没有 events 键（可选发射）—— rows() 会对缺失键给空列表吗？
  // 不会：pyList(undefined) 的行为要么空要么抛，这里显式判一次，缺键就跳过。
  if (Array.isArray(g(data, "events"))) {
    for (const e of rows("events")) {
      const rid = pyStr(e["rid"]);
      oir.events.set(rid, {
        rid,
        apiName: assertFrom(g(e, "apiName")) as Assertion<string>,
        displayName: assertFrom(g(e, "displayName")) as Assertion<string>,
        emittedBy: pyStrList(g(e, "emittedBy")),
        payload: pyStrList(g(e, "objectIds")),
        status: statusFrom(g(e, "status")),
      });
    }
  }
  for (const q of rows("questions")) {
    const rid = pyStr(q["rid"]);
    oir.questions.set(rid, {
      rid,
      text: assertFrom(g(q, "text")) as Assertion<string>,
      options: pyStrList(g(q, "options")),
      answer: assertFrom(g(q, "answer")) as Assertion<string>,
      group: pyTruthy(g(q, "group")) ? pyStr(g(q, "group")) : "",
      code: pyTruthy(g(q, "code")) ? pyStr(g(q, "code")) : "",
      appliesTo: pyStrList(g(q, "appliesTo")),
      askedBy: pyTruthy(g(q, "askedBy")) ? pyStr(g(q, "askedBy")) : "customer",
      owner: (g(q, "owner") as string | null) ?? null,
      status: statusFrom(g(q, "status")),
    });
  }
  return oir;
}
