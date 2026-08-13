/**
 * 对话口述改 OIR —— 结构化编辑。移植自 `src/ontocopilot/onto/oir_edit.py`。
 *
 * 和模板/流图编辑同构：FDE 知道材料没写的事实（「采购包创建后状态变成已发布」、
 * 「再加一个供应商对象」、「这条属性其实是必填」），要能**说给 Copilot 听、直接落进
 * 本体**，而不是我们改代码。
 *
 * 同样的两条纪律：
 *   1. **模型只选操作和参数，绝不重写整份 OIR。** 直接让模型吐一份新 OIR 会把其它
 *      断言的溯源全抹掉 —— 每个值的 origin/evidence 是「这不是瞎编」的凭证。
 *   2. **口述的事实一律 `Origin.USER`（人工拍板），带 extractor="human" 的 Provenance，
 *      绝不冒充材料抽取（EXTRACTED）。** 它在 OIR 里可见、可信度高，但语义上是「人说的」，
 *      不是「材料里读到的」。这条由构造保证：所有赋值都走 {@link byUser}。
 *
 * 原子性和模板编辑一样：在一份副本上应用、守卫过了才换回，半应用的 OIR 比不改更糟。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`fn(trial, **args)` 的参数校验**：Python 的关键字展开会替我们把「多给了一个
 *     参数」「少给了一个必填参数」变成 TypeError，`apply_oir_edit` 再把它翻译成
 *     一句人话给模型看。TS 里对象参数不会报这个，所以 `OPS` 表里显式声明了每个
 *     op 的必填/可选参数，`checkKwargs` 逐字复现 CPython 的报错文案 ——
 *     模型就是靠这句话学会下次怎么调的。
 *  2. **容器换回的方式**：Python 是 `oir.objects = trial.objects`（换 dict 对象），
 *     TS 侧 `OIR` 的六个 Map 是 readonly，所以改成 clear + 灌回。对
 *     「活 OIR 的引用保持有效」这个目的是等价的；唯一的差别是有人另存了
 *     `oir.objects` 这个 Map 引用时，Python 看到的是旧 dict、TS 看到的是新内容 ——
 *     而 Python 侧那个行为本来就是隐患，不是特性。
 *  3. **`str(v)` 的容器形态**：错误消息和回执里有 `f"…改为「{value}」"`，
 *     Python 的 `str(['x'])` 是 `"['x']"`（元素用 repr），JS 的 `String(['x'])`
 *     是 `"x"`。这些串会原样念给用户听，见 {@link pyStr}。
 *  4. **`str(1.0)` 是 `"1.0"`**：`required` 的强制转换里有
 *     `str(v).lower() in ("1", "true", "是", "yes")`，Python 收到 float `1.0`
 *     判 False、收到 int `1` 判 True。JS 的 number 分不出这两者，一律判 True。
 *     **这条无法在 TS 侧修复**，已在 divergences 里报出。
 */

import { pyRepr } from "../kernel/errors.js";
import {
  BaseType,
  Cardinality,
  Origin,
  RuleKind,
  Status,
  byUser,
  inferred,
  makeActionType,
  makeBusinessRule,
  makeLinkType,
  makeObjectType,
  makePropertyType,
  makeRid,
  oirFromDict,
  parseBaseType,
  parseCardinality,
  parseRuleKind,
  parseStatus,
  type ActionType,
  type Assertion,
  type BusinessRule,
  type LinkType,
  type OIR,
  type ObjectType,
  type PropertyType,
} from "./oir.js";

/** 一次 OIR 编辑不合法。消息要说清为什么，让模型能转述给用户。 */
export class OIREditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OIREditError";
    Object.setPrototypeOf(this, OIREditError.prototype); // 保住 instanceof
  }
}

/** Python 的 TypeError。`apply_oir_edit` **只**翻译这一类为「参数不对」。 */
class PyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
    Object.setPrototypeOf(this, PyTypeError.prototype);
  }
}

/** Python 的 AttributeError。**故意不被 `apply_oir_edit` 接住** —— Python 侧
 * `(api_name or "").strip()` 收到非字符串就是这个异常，它一路冒到 server 变成
 * 500。翻译成友好的「参数不对」看着更好，但那是两侧行为分叉。 */
class PyAttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeError";
    Object.setPrototypeOf(this, PyAttributeError.prototype);
  }
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return Number.isNaN(v) ? true : v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map);
}

function pyNumRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  return String(n).replace(/e([+-])(\d)$/, "e$10$2");
}

/** Python 的 `repr()`，容器递归。字符串走 `errors.ts` 的 `pyRepr`（零差异）。 */
function pyReprAny(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNumRepr(v);
  if (typeof v === "string") return pyRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyReprAny).join(", ") + "]";
  if (v instanceof Map) {
    return "{" + [...v].map(([k, x]) => `${pyReprAny(k)}: ${pyReprAny(x)}`).join(", ") + "}";
  }
  if (isPlainDict(v)) {
    const e = Object.entries(v);
    return "{" + e.map(([k, x]) => `${pyReprAny(k)}: ${pyReprAny(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** Python 的 `str()` / f-string 插值：字符串原样，其余走 repr。 */
function pyStr(v: unknown): string {
  return typeof v === "string" ? v : pyReprAny(v);
}

/** `sorted()` 按 code point 比 —— 报错文案里的字段名/op 名列表都要稳定。 */
function pySorted(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => {
    const x = [...a];
    const y = [...b];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const ca = x[i]!.codePointAt(0)!;
      const cb = y[i]!.codePointAt(0)!;
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return x.length - y.length;
  });
}

/** Python 打印一个 list 的形态：`['a', 'b']`。 */
function pyList(items: readonly string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

/** Python 的 `s[:n]`：按 code point 切。规则正文全是中文，按 UTF-16 切会少一半。 */
function head(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Python 的 `list(v)`：str 拆成字符、dict 取键、不可迭代直接 TypeError。 */
function pyIterList(v: unknown): unknown[] {
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (isPlainDict(v)) return Object.keys(v);
  throw new PyTypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/** Python 的 `dict(v)`。 */
function pyDict(v: unknown): Record<string, unknown> {
  if (isPlainDict(v)) return { ...v };
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), x]));
  throw new PyTypeError(`'${pyTypeName(v)}' object is not iterable`);
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  // JS 分不出 int / float；整数值一律报 int（绝大多数场景就是 int）。
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  return "dict";
}

// ══════════════════════════════════════════════════════════════════
//  实体的通用视角
// ══════════════════════════════════════════════════════════════════

/** `_resolve_any` 能返回的五种实体。 */
type Entity = ObjectType | PropertyType | LinkType | ActionType | BusinessRule;

/** `getattr(ent, attr, None)`：字段不存在返回 undefined，不抛。 */
function attr(ent: object, key: string): unknown {
  return (ent as Record<string, unknown>)[key];
}

function assertionOf(ent: object, key: string): Assertion<unknown> | null {
  const a = attr(ent, key);
  return a !== null && a !== undefined && typeof a === "object" && "value" in a
    ? (a as Assertion<unknown>)
    : null;
}

/** 口述赋值的统一入口：Origin.USER + 一条 human Provenance。**不是材料证据。** */
function human<T>(value: T, note: string): Assertion<T> {
  return byUser(value, note);
}

function label(ent: object): string {
  for (const key of ["displayName", "apiName", "statement"]) {
    const a = assertionOf(ent, key);
    if (a !== null && pyTruthy(a.value)) return pyStr(a.value);
  }
  const rid = attr(ent, "rid");
  return rid === undefined ? "?" : pyStr(rid);
}

// ══════════════════════════════════════════════════════════════════
//  解析（FDE 说的是名字/编号，不是 rid）
// ══════════════════════════════════════════════════════════════════

function findObject(oir: OIR, ref: string): ObjectType {
  const direct = oir.objects.get(ref);
  if (direct) return direct;
  let hit = [...oir.objects.values()].filter(
    (o) =>
      o.apiName.value === ref ||
      o.displayName.value === ref ||
      (pyTruthy(o.aliases) ? o.aliases : []).includes(ref),
  );
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) {
    hit = [...oir.objects.values()].filter(
      (o) =>
        (o.displayName.value || "").includes(ref) || (o.apiName.value || "").includes(ref),
    );
  }
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) throw new OIREditError(`找不到对象「${ref}」。`);
  throw new OIREditError(
    `「${ref}」对应多个对象，说具体些：` +
      hit.slice(0, 5).map((o) => o.displayName.value).join("、"),
  );
}

function findProperty(oir: OIR, ref: string, parent: string | null = null): PropertyType {
  const direct = oir.properties.get(ref);
  if (direct) return direct;
  let objRef: string | null = parent;
  let key = ref;
  if (parent === null && ref.includes(".")) {
    // 「采购包.状态」这种写法。partition 按**第一个**点切。
    const i = ref.indexOf(".");
    objRef = ref.slice(0, i);
    key = ref.slice(i + 1);
  }
  let cands = [...oir.properties.values()];
  if (pyTruthy(objRef)) {
    const po = findObject(oir, objRef!);
    cands = cands.filter((p) => p.parent === po.rid);
  }
  let hit = cands.filter((p) => p.apiName.value === key || p.displayName.value === key);
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) {
    hit = cands.filter(
      (p) => (p.displayName.value || "").includes(key) || (p.apiName.value || "").includes(key),
    );
  }
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) throw new OIREditError(`找不到属性「${ref}」。`);
  throw new OIREditError(`「${ref}」对应多个属性，说具体些（可写成「对象.属性」）。`);
}

function findRule(oir: OIR, ref: string): BusinessRule {
  const direct = oir.rules.get(ref);
  if (direct) return direct;
  const hit = [...oir.rules.values()].filter((r) => (r.statement.value || "").includes(ref));
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) throw new OIREditError(`找不到规则「${ref}」。`);
  throw new OIREditError(`「${ref}」对应多条规则，说具体些。`);
}

function findAction(oir: OIR, ref: string): ActionType {
  const direct = oir.actions.get(ref);
  if (direct) return direct;
  let hit = [...oir.actions.values()].filter((a) => a.apiName.value === ref);
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) {
    hit = [...oir.actions.values()].filter((a) => (a.apiName.value || "").includes(ref));
  }
  if (hit.length === 1) return hit[0]!;
  if (hit.length === 0) throw new OIREditError(`找不到动作「${ref}」。`);
  throw new OIREditError(`「${ref}」对应多个动作，说具体些。`);
}

/** 跨容器解析实体，供 editAssertion / setStatus 使用。 */
function resolveAny(oir: OIR, ref: string): Entity {
  for (const finder of [findObject, findProperty, findRule, findAction] as const) {
    try {
      return finder(oir, ref);
    } catch (e) {
      if (!(e instanceof OIREditError)) throw e;
    }
  }
  const l = oir.links.get(ref);
  if (l) return l;
  throw new OIREditError(`找不到「${ref}」对应的对象/属性/关系/动作/规则。`);
}

// ══════════════════════════════════════════════════════════════════
//  新增（oir.add）
// ══════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** `(x or "").strip()`。x 为真值但不是字符串 → Python 的 AttributeError。 */
function strip0(v: unknown): string {
  const x = pyTruthy(v) ? v : "";
  if (typeof x !== "string") {
    throw new PyAttributeError(`'${pyTypeName(x)}' object has no attribute 'strip'`);
  }
  return x.trim();
}

/** 只当名字用、不 strip 的可选字符串参数（display_name / description / …）。
 * Python 不校验它们的类型，原样存进 Assertion，所以这里也不校验。 */
function text0(v: unknown): string {
  return (v === undefined ? "" : v) as string;
}

/** 拿去喂 findObject/findProperty/… 的引用。非字符串在 Python 侧会在
 * `ref in (o.display_name.value or "")` 那一行抛 TypeError（然后被
 * `apply_oir_edit` 翻译成「参数不对」）。 */
function ref0(v: unknown): string {
  if (typeof v !== "string") {
    throw new PyTypeError(
      `'in <string>' requires string as left operand, not ${pyTypeName(v)}`,
    );
  }
  return v;
}

function opAddObjectType(oir: OIR, a: Args): string {
  const apiName = strip0(a["api_name"]);
  const displayName = text0(a["display_name"]);
  const description = text0(a["description"]);
  if (!apiName) throw new OIREditError("新增对象要给 api_name。");
  for (const o of oir.objects.values()) {
    if (o.apiName.value === apiName) {
      throw new OIREditError(`已有对象「${apiName}」，要改用 oir.edit。`);
    }
  }
  oir.addObject(
    makeObjectType({
      rid: makeRid("ot", apiName),
      apiName: human(apiName, `人工口述新增对象：${apiName}`),
      displayName: human(pyTruthy(displayName) ? displayName : apiName, "人工口述"),
      description: pyTruthy(description) ? human(description, "人工口述") : inferred(""),
    }),
  );
  return `新增对象「${pyStr(pyTruthy(displayName) ? displayName : apiName)}」（人工口述，标 USER 来源）。`;
}

function opAddProperty(oir: OIR, a: Args): string {
  const parent = findObject(oir, ref0(a["object"]));
  const apiName = strip0(a["api_name"]);
  const displayName = text0(a["display_name"]);
  const definition = text0(a["definition"]);
  const required = a["required"] ?? false;
  const valueDomain = a["value_domain"] ?? null;
  if (!apiName) throw new OIREditError("新增属性要给 api_name。");
  for (const p of oir.properties.values()) {
    if (p.parent === parent.rid && p.apiName.value === apiName) {
      throw new OIREditError(`对象「${parent.displayName.value}」已有属性「${apiName}」。`);
    }
  }
  let bt: BaseType;
  try {
    bt = parseBaseType(a["base_type"] === undefined ? "STRING" : a["base_type"]);
  } catch {
    throw new OIREditError(`base_type 只能是 ${pyList(Object.values(BaseType))}。`);
  }
  oir.addProperty(
    makePropertyType({
      rid: makeRid("pt", `${parent.rid}_${apiName}`),
      parent: parent.rid,
      apiName: human(apiName, "人工口述"),
      displayName: human(pyTruthy(displayName) ? displayName : apiName, "人工口述"),
      baseType: human(bt, "人工口述"),
      definition: pyTruthy(definition) ? human(definition, "人工口述") : inferred(""),
      required: human(pyTruthy(required), "人工口述"),
      valueDomain: pyTruthy(valueDomain)
        ? human(pyIterList(valueDomain) as string[], "人工口述")
        : inferred(null),
    }),
  );
  return `给「${parent.displayName.value}」加属性「${pyStr(
    pyTruthy(displayName) ? displayName : apiName,
  )}」。`;
}

function opAddLink(oir: OIR, a: Args): string {
  const src = findObject(oir, ref0(a["source"]));
  const tgt = findObject(oir, ref0(a["target"]));
  const joinKey = a["join_key"] ?? null;
  let card: Cardinality;
  try {
    card = parseCardinality(a["cardinality"] === undefined ? "ONE_TO_MANY" : a["cardinality"]);
  } catch {
    throw new OIREditError(`cardinality 只能是 ${pyList(Object.values(Cardinality))}。`);
  }
  const given = strip0(a["api_name"]);
  const name = given || `${src.apiName.value}_${tgt.apiName.value}`;
  oir.addLink(
    makeLinkType({
      rid: makeRid("lt", `${src.rid}_${name}_${tgt.rid}`),
      apiName: human(name, "人工口述"),
      source: src.rid,
      target: tgt.rid,
      cardinality: human(card, "人工口述"),
      joinKey: pyTruthy(joinKey)
        ? human(pyDict(joinKey) as Record<string, string>, "人工口述")
        : inferred(null),
    }),
  );
  return (
    `连关系：「${src.displayName.value}」→「${tgt.displayName.value}」` + `（${card}）。`
  );
}

function opAddRule(oir: OIR, a: Args): string {
  const statement = strip0(a["statement"]);
  if (!statement) throw new OIREditError("新增规则要给 statement。");
  let rk: RuleKind;
  try {
    rk = parseRuleKind(a["kind"] === undefined ? "PROCESS" : a["kind"]);
  } catch {
    throw new OIREditError(`kind 只能是 ${pyList(Object.values(RuleKind))}。`);
  }
  const appliesTo = a["applies_to"] ?? null;
  const actor = text0(a["actor"]);
  const applies = pyIterList(pyTruthy(appliesTo) ? appliesTo : []).map(
    (x) => findObject(oir, ref0(x)).rid,
  );
  oir.addRule(
    makeBusinessRule({
      rid: makeRid("br", statement),
      statement: human(statement, "人工口述"),
      kind: human(rk, "人工口述"),
      appliesTo: applies,
      actor: pyTruthy(actor) ? human(actor, "人工口述") : inferred(""),
    }),
  );
  return `新增业务规则「${head(statement, 24)}」（${rk}）。`;
}

/** 新增可执行语义动作；所有口述字段保持 USER provenance。 */
function opAddActionType(oir: OIR, a: Args): string {
  const apiName = strip0(a["api_name"]);
  if (!apiName) throw new OIREditError("新增动作要给 api_name。");
  for (const x of oir.actions.values()) {
    if (x.apiName.value === apiName) {
      throw new OIREditError(`已有动作「${apiName}」，要改用 oir.edit。`);
    }
  }
  const appliesTo = a["applies_to"] ?? null;
  const parameters = a["parameters"] ?? null;
  const effects = a["effects"] ?? null;
  const sourceEndpoint = a["source_endpoint"] ?? null;
  const targets = pyIterList(pyTruthy(appliesTo) ? appliesTo : []).map(
    (ref) => findObject(oir, ref0(ref)).rid,
  );
  oir.addAction(
    makeActionType({
      rid: makeRid("at", apiName),
      apiName: human(apiName, `人工口述新增动作：${apiName}`),
      appliesTo: targets,
      parameters: human(
        pyIterList(pyTruthy(parameters) ? parameters : []) as Record<string, unknown>[],
        "人工口述动作参数",
      ),
      effects: human(
        pyIterList(pyTruthy(effects) ? effects : []) as string[],
        "人工口述动作效果",
      ),
      sourceEndpoint: pyTruthy(sourceEndpoint)
        ? human(pyDict(sourceEndpoint) as Record<string, string>, "人工口述动作接口")
        : inferred(null),
    }),
  );
  return `新增动作「${apiName}」（人工口述，标 USER 来源）。`;
}

function opAddEnumValue(oir: OIR, a: Args): string {
  const property = ref0(a["property"]);
  const value = a["value"];
  const pt = findProperty(oir, property);
  const dom = pyIterList(pyTruthy(pt.valueDomain.value) ? pt.valueDomain.value : []) as string[];
  if (dom.includes(value as string)) {
    throw new OIREditError(`「${property}」已经有取值「${pyStr(value)}」。`);
  }
  dom.push(value as string);
  pt.valueDomain = human(dom, `人工口述新增取值：${pyStr(value)}`);
  if (pt.baseType.value !== BaseType.ENUM) {
    pt.baseType = human(BaseType.ENUM, "人工口述：有取值域了，类型改 ENUM");
  }
  return `给属性「${pt.displayName.value}」加取值「${pyStr(value)}」。`;
}

// ══════════════════════════════════════════════════════════════════
//  修改（oir.edit）
// ══════════════════════════════════════════════════════════════════

/** 可用 editAssertion 改的断言字段：**wire 上是 Python 的 snake_case**
 * （模型学到的就是这些名字），值是 TS 侧的属性名。 */
const EDITABLE: Record<string, string> = {
  display_name: "displayName",
  description: "description",
  definition: "definition",
  base_type: "baseType",
  cardinality: "cardinality",
  api_name: "apiName",
  required: "required",
  actor: "actor",
  statement: "statement",
  parameters: "parameters",
  effects: "effects",
  source_endpoint: "sourceEndpoint",
};

/** 值的强制转换。抛 ValueError/KeyError 的位置与 Python 一一对应。 */
const COERCE: Record<string, (v: unknown) => unknown> = {
  base_type: (v) => parseBaseType(v),
  cardinality: (v) => parseCardinality(v),
  required: (v) =>
    // Python: `bool(v) if isinstance(v, bool) else str(v).lower() in (...)`。
    // 注意 `str(1.0)` 是 `"1.0"`（判 False），而 JS 的 1.0 就是 1（判 True）——
    // 这条分叉在 TS 侧无解，见文件头第 4 条。
    typeof v === "boolean" ? v : ["1", "true", "是", "yes"].includes(pyStr(v).toLowerCase()),
  parameters: (v) => pyIterList(v),
  effects: (v) => pyIterList(v),
  source_endpoint: (v) => (v !== null && v !== undefined ? pyDict(v) : null),
};

/** `parseX` 抛的是 RangeError（== Python 的 ValueError）。Python 侧
 * `except (ValueError, KeyError)` 只吞这两类，TypeError 要继续往上走 ——
 * 它在 `apply_oir_edit` 里会被翻译成「参数不对」，语气完全不同。 */
function isValueOrKeyError(e: unknown): boolean {
  return e instanceof RangeError || (e instanceof Error && e.name === "KeyError");
}

function opEditAssertion(oir: OIR, a: Args): string {
  const target = ref0(a["target"]);
  // field 不 strip、也不校验类型：Python 里非字符串的 field 直接落进
  // `field not in _EDITABLE` 判 False，报的是「不是可改字段」。
  const raw = a["field"];
  const value = a["value"];
  const note = text0(a["note"]);
  const ent = resolveAny(oir, target);
  const field = typeof raw === "string" ? raw : "";
  const tsKey = typeof raw === "string" ? EDITABLE[raw] : undefined;
  if (tsKey === undefined || !(tsKey in ent)) {
    // 文案照抄 Python：它说「这个实体上可改」却印的是全集，是原件的一处不精确，
    // 但这句话会原样念给用户听，改了两边就对不上。
    throw new OIREditError(
      `「${pyStr(raw)}」不是可改字段。这个实体上可改：${pyList(
        pySorted(Object.keys(EDITABLE)),
      )}`,
    );
  }
  let coerced: unknown;
  try {
    coerced = (COERCE[field] ?? ((v: unknown) => v))(value);
  } catch (e) {
    if (!isValueOrKeyError(e)) throw e;
    throw new OIREditError(`${field} 的值「${pyStr(value)}」不合法。`);
  }
  (ent as unknown as Record<string, unknown>)[tsKey] = human(
    coerced,
    pyTruthy(note) ? note : `人工口述改 ${field}`,
  );
  return `把「${label(ent)}」的 ${field} 改为「${pyStr(value)}」。`;
}

function opSetStatus(oir: OIR, a: Args): string {
  const ent = resolveAny(oir, ref0(a["target"]));
  let st: Status;
  try {
    st = parseStatus(a["status"]);
  } catch {
    throw new OIREditError(`status 只能是 ${pyList(Object.values(Status))}。`);
  }
  (ent as { status: Status }).status = st;
  return `把「${label(ent)}」标为 ${st}。`;
}

function opBindRule(oir: OIR, a: Args): string {
  const br = findRule(oir, ref0(a["rule"]));
  const obj = findObject(oir, ref0(a["object"]));
  if (!br.appliesTo.includes(obj.rid)) br.appliesTo.push(obj.rid);
  br.status = Status.PROPOSED;
  return `把规则「${head(br.statement.value, 16)}」挂到「${obj.displayName.value}」。`;
}

function opSetActionScope(oir: OIR, a: Args): string {
  const at = findAction(oir, ref0(a["action"]));
  const objects = a["objects"];
  at.appliesTo = pyIterList(objects).map((ref) => findObject(oir, ref0(ref)).rid);
  at.status = Status.PROPOSED;
  return `把动作「${at.apiName.value}」关联到 ${at.appliesTo.length} 个数据对象。`;
}

/** 只有人工口述加错的才能硬删；材料抽出来的删了会丢证据，引导去 setStatus。
 *
 * `kind` 这个参数 Python 侧也没用上，照实迁 —— 删掉它就是一处静默的接口漂移。 */
function requireUserOrigin(ent: object, kind: string): void {
  void kind;
  for (const key of ["displayName", "apiName", "statement"]) {
    const a = assertionOf(ent, key);
    if (a !== null && a.origin === Origin.USER) return;
  }
  throw new OIREditError(
    `「${label(ent)}」不是人工口述加的（是从材料抽出来的），删除会丢证据。` +
      `要排除请用 set_status(status=rejected)。`,
  );
}

function opRemoveObjectType(oir: OIR, a: Args): string {
  const o = findObject(oir, ref0(a["target"]));
  requireUserOrigin(o, "对象");
  for (const r of [...oir.properties.values()].filter((p) => p.parent === o.rid).map((p) => p.rid)) {
    oir.properties.delete(r);
  }
  for (const r of [...oir.links.values()]
    .filter((l) => o.rid === l.source || o.rid === l.target)
    .map((l) => l.rid)) {
    oir.links.delete(r);
  }
  oir.objects.delete(o.rid);
  return `删掉了对象「${o.displayName.value}」及其属性/相关关系。`;
}

function opRemoveProperty(oir: OIR, a: Args): string {
  const p = findProperty(oir, ref0(a["target"]));
  requireUserOrigin(p, "属性");
  oir.properties.delete(p.rid);
  const parent = oir.objects.get(p.parent);
  if (parent && parent.properties.includes(p.rid)) {
    parent.properties.splice(parent.properties.indexOf(p.rid), 1);
  }
  return `删掉了属性「${p.displayName.value}」。`;
}

function opRemoveLink(oir: OIR, a: Args): string {
  const target = ref0(a["target"]);
  const lt = oir.links.get(target);
  if (lt === undefined) throw new OIREditError(`找不到关系「${target}」（用 rid）。`);
  requireUserOrigin(lt, "关系");
  oir.links.delete(lt.rid);
  return `删掉了关系「${lt.apiName.value}」。`;
}

function opRemoveRule(oir: OIR, a: Args): string {
  const r = findRule(oir, ref0(a["target"]));
  requireUserOrigin(r, "规则");
  oir.rules.delete(r.rid);
  return `删掉了规则「${head(r.statement.value, 16)}」。`;
}

function opRemoveActionType(oir: OIR, a: Args): string {
  const action = findAction(oir, ref0(a["target"]));
  requireUserOrigin(action, "动作");
  oir.actions.delete(action.rid);
  return `删掉了动作「${action.apiName.value}」。`;
}

// ══════════════════════════════════════════════════════════════════
//  op 表 + 关键字校验
// ══════════════════════════════════════════════════════════════════

interface OpSpec {
  /** Python 侧的内部函数名 —— 它出现在 TypeError 文案里，会被念给用户听。 */
  fnName: string;
  required: readonly string[];
  optional: readonly string[];
  run: (oir: OIR, args: Args) => string;
}

const OPS: Record<string, OpSpec> = {
  // add
  add_object_type: {
    fnName: "_op_add_object_type",
    required: ["api_name"],
    optional: ["display_name", "description"],
    run: opAddObjectType,
  },
  add_property: {
    fnName: "_op_add_property",
    required: ["object", "api_name"],
    optional: ["display_name", "base_type", "definition", "required", "value_domain"],
    run: opAddProperty,
  },
  add_link: {
    fnName: "_op_add_link",
    required: ["source", "target"],
    optional: ["api_name", "cardinality", "join_key"],
    run: opAddLink,
  },
  add_rule: {
    fnName: "_op_add_rule",
    required: ["statement"],
    optional: ["kind", "applies_to", "actor"],
    run: opAddRule,
  },
  add_action_type: {
    fnName: "_op_add_action_type",
    required: ["api_name"],
    optional: ["applies_to", "parameters", "effects", "source_endpoint"],
    run: opAddActionType,
  },
  add_enum_value: {
    fnName: "_op_add_enum_value",
    required: ["property", "value"],
    optional: [],
    run: opAddEnumValue,
  },
  // edit
  edit_assertion: {
    fnName: "_op_edit_assertion",
    required: ["target", "field", "value"],
    optional: ["note"],
    run: opEditAssertion,
  },
  set_status: {
    fnName: "_op_set_status",
    required: ["target", "status"],
    optional: [],
    run: opSetStatus,
  },
  bind_rule: { fnName: "_op_bind_rule", required: ["rule", "object"], optional: [], run: opBindRule },
  set_action_scope: {
    fnName: "_op_set_action_scope",
    required: ["action", "objects"],
    optional: [],
    run: opSetActionScope,
  },
  remove_object_type: {
    fnName: "_op_remove_object_type",
    required: ["target"],
    optional: [],
    run: opRemoveObjectType,
  },
  remove_property: {
    fnName: "_op_remove_property",
    required: ["target"],
    optional: [],
    run: opRemoveProperty,
  },
  remove_link: { fnName: "_op_remove_link", required: ["target"], optional: [], run: opRemoveLink },
  remove_rule: { fnName: "_op_remove_rule", required: ["target"], optional: [], run: opRemoveRule },
  remove_action_type: {
    fnName: "_op_remove_action_type",
    required: ["target"],
    optional: [],
    run: opRemoveActionType,
  },
};

/** 可用的编辑操作名。给上层做 schema / 提示用，别再手抄一份。 */
export const OIR_EDIT_OPS: readonly string[] = Object.keys(OPS);

/** 复现 CPython 关键字展开的两条报错。
 *
 * 顺序也照抄：**先报多余的参数，再报缺失的** —— CPython 是在绑定关键字时就
 * 抛「unexpected keyword」，缺参检查发生在那之后。 */
function checkKwargs(spec: OpSpec, args: Args): void {
  const known = new Set([...spec.required, ...spec.optional]);
  for (const k of Object.keys(args)) {
    if (!known.has(k)) {
      throw new PyTypeError(`${spec.fnName}() got an unexpected keyword argument '${k}'`);
    }
  }
  const missing = spec.required.filter((k) => !(k in args));
  if (missing.length > 0) {
    const names = missing.map((k) => `'${k}'`);
    const joined =
      names.length === 1
        ? names[0]!
        : names.length === 2
          ? `${names[0]!} and ${names[1]!}`
          : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]!}`;
    const plural = missing.length === 1 ? "argument" : "arguments";
    throw new PyTypeError(
      `${spec.fnName}() missing ${missing.length} required keyword-only ${plural}: ${joined}`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════
//  守卫
// ══════════════════════════════════════════════════════════════════

/** 编辑后的引用/唯一性校验。**PK/joinKey 缺失只是告警不阻塞** —— 口述是增量的，
 * 一个刚加的对象合理地还没主键。任何一条硬约束不过就整体拒绝、原 OIR 不动。 */
function guard(oir: OIR): void {
  for (const p of oir.properties.values()) {
    if (!oir.objects.has(p.parent)) {
      throw new OIREditError(`属性 ${p.rid} 的父对象 ${p.parent} 不存在。`);
    }
  }
  for (const l of oir.links.values()) {
    for (const [side, r] of [
      ["from", l.source],
      ["to", l.target],
    ] as const) {
      if (!oir.objects.has(r)) {
        throw new OIREditError(`关系 ${l.rid} 的 ${side} 指向不存在的对象 ${r}。`);
      }
    }
  }
  for (const r of oir.rules.values()) {
    for (const a of r.appliesTo) {
      if (!oir.objects.has(a)) throw new OIREditError(`规则 ${r.rid} 挂到了不存在的对象 ${a}。`);
    }
  }
  for (const action of oir.actions.values()) {
    for (const target of action.appliesTo) {
      if (!oir.objects.has(target)) {
        throw new OIREditError(`动作 ${action.rid} 关联了不存在的对象 ${target}。`);
      }
    }
  }
  const seen = new Map<string, string>();
  for (const o of oir.objects.values()) {
    const k = o.apiName.value;
    // `if k and k in seen`：空 api_name 不算重复（Python 的真值判断）。
    if (pyTruthy(k) && seen.has(k)) throw new OIREditError(`对象 api_name 重复：${k}`);
    seen.set(k, o.rid);
  }
}

function refill<K, V>(dst: Map<K, V>, src: Map<K, V>): void {
  dst.clear();
  for (const [k, v] of src) dst.set(k, v);
}

/** 对 OIR 应用一次结构化编辑，成功返回一句人话。
 *
 * **在副本上应用、守卫通过后才换回** —— 被拒的编辑让活 OIR 字节不变，未触碰部分
 * 的溯源全保留。抛 {@link OIREditError} 时调用方转述给用户。 */
export function applyOirEdit(oir: OIR, op: string, args: Args): string {
  const spec = OPS[op];
  if (spec === undefined) {
    throw new OIREditError(`不支持的 OIR 编辑 ${op}。支持：${pyList(pySorted(Object.keys(OPS)))}`);
  }
  const trial = oirFromDict(oir.toDict());
  let note: string;
  try {
    checkKwargs(spec, args);
    note = spec.run(trial, args);
  } catch (exc) {
    // **只接 TypeError**。Python 侧的 `except TypeError` 不会接住 AttributeError /
    // ValueError，接多了会把「服务端出错」伪装成「你参数写错了」，模型于是
    // 一遍遍地换参数重试同一个必然失败的调用。
    if (exc instanceof PyTypeError) {
      throw new OIREditError(`${op} 的参数不对：${exc.message}`);
    }
    throw exc;
  }
  guard(trial);
  // 通过：把 trial 的内容搬回 oir（保持同一个 OIR 引用，state["_oir"] 持有它）
  refill(oir.objects, trial.objects);
  refill(oir.properties, trial.properties);
  refill(oir.links, trial.links);
  refill(oir.actions, trial.actions);
  refill(oir.rules, trial.rules);
  refill(oir.questions, trial.questions);
  return note;
}
