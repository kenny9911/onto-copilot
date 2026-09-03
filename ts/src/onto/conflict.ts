/**
 * 冲突分类与检测 —— 产品的核心价值。移植自 `src/ontocopilot/onto/conflict.py`，
 * 由 `golden/onto.conflict.json`（Python 真跑出来的）钉住。
 *
 * 冲突必须精确分类，因为**不同类型的处置方式完全不同**：命名违规可以自动修，
 * 口径分歧必须问人，疑似敷衍要打回责任人。混成一个"问题列表"就没法自动化了。
 *
 * 分工纪律（架构文档 ADR-5）：能规则化的一律规则化。这里 8 类里有 5 类是纯规则
 * —— 又快又准又免费又没方差；只有 SEMANTIC_DIVERGENCE、PERFUNCTORY、DUPLICATE
 * 需要语义判断，且都先用启发式收窄候选集再交模型，避免全量喂给 LLM。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`\b` 是 Unicode 词边界**。Python 的 `\w` 含汉字，所以
 *     `re.search(r"\bnet\b", "净额net")` **不匹配**；JS 的 `\b` 只认 ASCII，
 *     同一个串会匹配上。判据写宽了就是这么来的 —— 见 {@link WORD_CHARS}。
 *  2. **`^…$` 的 `$` 还匹配末尾换行**。`_CAMEL` 用 `re.match(r"^…$")` 判
 *     lowerCamelCase，`"planAmount\n"` 在 Python 侧是**合法**的，JS 默认不是。
 *  3. **字符串按 code point**。`len(v) <= 3`、`body[:40]`、difflib 的下标全是
 *     code point；口径正文里混一个 emoji，按 UTF-16 算就全错位。
 *  4. **`difflib.SequenceMatcher`** 没有对等物，见 `./difflib.ts`。
 *  5. **`axis_diff` 的键序在 Python 侧本来就不确定** —— 它是
 *     `pa.keys() & pb.keys()` 这个 *set* 上的推导式，键序随进程哈希种子变化
 *     （同一份输入连跑六次得到六种顺序）。TS 侧固定成 `AXES` 的声明序。
 *     受影响的只有多轴分歧 summary 里"税（…）、时间粒度（…）"的先后。
 */

import { pyRepr } from "../kernel/errors.js";
import { sha256Hex } from "../kernel/ids.js";
import { SequenceMatcher, cmpCodePoint, toCodePoints } from "./difflib.js";
import {
  type Assertion,
  type OIR,
  type PropertyType,
  type Provenance,
  Origin,
  makeProvenance,
  provToDict,
} from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** f-string 里的插值：Python 的 `f"{None}"` 是 `"None"`。 */
function pyFmt(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** `str(x)`。数字上有已知差异（Python `str(2.0)` 是 `"2.0"`，JS 是 `"2"`）——
 * 这条路径上的值来自 JSON / profiler，整数值的 float 早在 parse 时就塌成整数了。 */
function pyStr(v: unknown): string {
  return String(v);
}

/** `s[:n]`，按 code point 切。 */
function sliceCodePoints(s: string, n: number): string {
  return toCodePoints(s).slice(0, n).join("");
}

/** `len(s)`，按 code point 数。 */
function cpLength(s: string): number {
  return toCodePoints(s).length;
}

/** `str.strip(chars)` —— 从两端剥掉这些字符里的任意一个。 */
function pyStripChars(s: string, chars: string): string {
  const set = new Set(toCodePoints(chars));
  const cps = toCodePoints(s);
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i] as string)) i += 1;
  while (j > i && set.has(cps[j - 1] as string)) j -= 1;
  return cps.slice(i, j).join("");
}

/** `str.rstrip(chars)`：剥掉**全部**尾部匹配字符，不是只剥一个。 */
function pyRstripChars(s: string, chars: string): string {
  const set = new Set(toCodePoints(chars));
  const cps = toCodePoints(s);
  let j = cps.length;
  while (j > 0 && set.has(cps[j - 1] as string)) j -= 1;
  return cps.slice(0, j).join("");
}

/** Python 的真值判断。JS 里 `[]`/`{}` 是真，Python 里是假。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `d[k]` —— 键不存在时 Python 抛 KeyError，这里同样炸。
 * 静默给默认值等于凭空捏造一条证据的来源，比崩掉恶劣得多。 */
function req(d: Record<string, unknown>, k: string): unknown {
  if (!(k in d)) throw new Error(`KeyError: ${pyRepr(k)}`);
  return d[k];
}

/** `d.get(k, dflt)` —— **只有键缺失**才给默认值。键在但值是 null 时，
 * Python 拿到的是 None（f-string 印成 "None"），不是默认值。 */
function dget(d: Record<string, unknown>, k: string, dflt: unknown): unknown {
  return k in d ? d[k] : dflt;
}

/** `d.get(k, dflt)`，且要求取到的是字符串。
 *
 * Python 侧对非字符串是**当场炸**（`(5).strip()` → AttributeError），
 * 不是静默 `String(5)`。照抄：脏输入要立刻可见。 */
function getStr(d: Record<string, unknown>, k: string, dflt = ""): string {
  const v = d[k];
  if (v === undefined || v === null) return dflt; // Python 的 `x or ""`
  if (typeof v !== "string") throw new TypeError(`${pyRepr(k)} 期望字符串，拿到 ${pyFmt(v)}`);
  return v;
}

/** Python 的 `sorted()`：按 code point。 */
function sortedCp(items: Iterable<string>): string[] {
  return [...items].sort(cmpCodePoint);
}

// ══════════════════════════════════════════════════════════════════
//  枚举
// ══════════════════════════════════════════════════════════════════

export const ConflictKind = {
  SEMANTIC_DIVERGENCE: "semantic_divergence", // 同名字段两处口径不一致
  MISSING_REQUIRED: "missing_required",
  NAMING_VIOLATION: "naming_violation",
  DUPLICATE: "duplicate",
  PERFUNCTORY: "perfunctory", // 疑似敷衍
  ORPHAN: "orphan",
  TYPE_MISMATCH: "type_mismatch",
  MISSING_ACTION: "missing_action",
} as const;
export type ConflictKind = (typeof ConflictKind)[keyof typeof ConflictKind];

/** `ConflictKind(v)` 的等价物：未知值抛错。别用 `as ConflictKind`。 */
export function parseConflictKind(v: unknown): ConflictKind {
  const s = pyStr(v);
  for (const x of Object.values(ConflictKind)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid ConflictKind`);
}

/** 处置方式 —— 决定这条冲突走哪条路。 */
export const Handling = {
  ASK_USER: "ask_user", // 必须人拍板
  AUTO_REPAIR: "auto_repair", // 可逆、零语义损失，系统自动修
  ROUND_TRIP: "round_trip", // 打回业务方
  HINT: "hint", // 仅提示
} as const;
export type Handling = (typeof Handling)[keyof typeof Handling];

export function parseHandling(v: unknown): Handling {
  const s = pyStr(v);
  for (const x of Object.values(Handling)) if (x === s) return x;
  throw new RangeError(`'${s}' is not a valid Handling`);
}

/**
 * 每类冲突怎么处置。
 *
 * - `irreversibility`：决策错了之后的返工代价。主键选择 > 基数 > 命名。
 * - `evidenceDecidable`：**证据的多寡能否替人做决定**。
 *
 *   这个字段区分两种性质完全不同的分歧：
 *
 *   * *事实之争*（口径分歧、重复、类型不符）—— 一边证据碾压另一边时，
 *     系统可以自己倾向，不必占用人的注意力；
 *   * *政策选择*（要不要从 OpenAPI 反推 ActionType）—— 「不反推」这个
 *     选项天然没有证据，但它是个真实的决策。这里按证据平衡度打折会把
 *     一个该问的问题误判成"系统能自己定"。
 */
export interface KindPolicy {
  readonly handling: Handling;
  readonly irreversibility: number;
  readonly evidenceDecidable: boolean;
}

function policy(handling: Handling, irreversibility: number, evidenceDecidable = false): KindPolicy {
  return { handling, irreversibility, evidenceDecidable };
}

/** 声明序 = Python dict 的插入序，`Object.entries` 会照样吐出来（键都不是整数样式）。 */
export const POLICY: Readonly<Record<ConflictKind, KindPolicy>> = {
  [ConflictKind.SEMANTIC_DIVERGENCE]: policy(Handling.ASK_USER, 1.0, true),
  [ConflictKind.DUPLICATE]: policy(Handling.ASK_USER, 0.8, true),
  [ConflictKind.TYPE_MISMATCH]: policy(Handling.ASK_USER, 0.6, true),
  [ConflictKind.MISSING_ACTION]: policy(Handling.ASK_USER, 0.7, false),
  [ConflictKind.MISSING_REQUIRED]: policy(Handling.ROUND_TRIP, 0.3),
  [ConflictKind.PERFUNCTORY]: policy(Handling.ROUND_TRIP, 0.3),
  [ConflictKind.NAMING_VIOLATION]: policy(Handling.AUTO_REPAIR, 0.2),
  [ConflictKind.ORPHAN]: policy(Handling.HINT, 0.4),
};

/** 兜底选项 —— 参与决策但不参与"证据谁更充分"的比较。 */
export const FALLBACK_OPTIONS: ReadonlySet<string> = new Set([
  "defer_to_template",
  "leave_blank",
  "keep_declared",
]);

// ══════════════════════════════════════════════════════════════════
//  数据形态
// ══════════════════════════════════════════════════════════════════

/** 一个处置选项。每个都必须能给出证据出处 —— FDE 要能点进去看原文。 */
export interface Option {
  id: string;
  label: string;
  rationale: string;
  evidence: Provenance[];
  effect: Record<string, unknown>;
}

export function makeOption(
  id: string,
  label: string,
  rationale = "",
  opts: { evidence?: readonly Provenance[]; effect?: Record<string, unknown> } = {},
): Option {
  return {
    id,
    label,
    rationale,
    evidence: [...(opts.evidence ?? [])],
    effect: { ...(opts.effect ?? {}) },
  };
}

export function optionToDict(o: Option): Record<string, unknown> {
  return {
    id: o.id,
    label: o.label,
    rationale: o.rationale,
    evidence: o.evidence.map(provToDict),
    effect: o.effect,
  };
}

export interface Conflict {
  rid: string;
  kind: ConflictKind;
  /** 涉及的 OIR rid */
  subjects: string[];
  summary: string;
  evidence: Provenance[];
  options: Option[];
  owner: string | null;
  detector: string;
}

export function makeConflict(
  rid: string,
  kind: ConflictKind,
  subjects: readonly string[],
  summary: string,
  opts: {
    evidence?: readonly Provenance[];
    options?: readonly Option[];
    owner?: string | null;
    detector?: string;
  } = {},
): Conflict {
  return {
    rid,
    kind,
    subjects: [...subjects],
    summary,
    evidence: [...(opts.evidence ?? [])],
    options: [...(opts.options ?? [])],
    owner: opts.owner ?? null,
    detector: opts.detector ?? "rule",
  };
}

export function conflictPolicy(c: Conflict): KindPolicy {
  const p = POLICY[c.kind];
  // Python 是 POLICY[self.kind]，未知 kind 直接 KeyError。照抄地炸。
  if (p === undefined) throw new Error(`KeyError: ${pyRepr(pyStr(c.kind))}`);
  return p;
}

export function handlingOf(c: Conflict): Handling {
  const base = conflictPolicy(c).handling;
  // **处置档位要对得上这条冲突自己有没有可执行的自动选项。**
  //
  // NAMING_VIOLATION 按 kind 一律是 AUTO_REPAIR，可含中文的名字机器给不出译名
  // （detectNaming 那里已经不再发「改为 <它自己>」这种死选项）。档位若还留在
  // auto_repair，这些冲突就顶着「系统会自己修」的名分永远消化不掉 —— 真库里
  // 25 条命名违规有 23 条是这种，长期占住三成派生积压。没有可自动执行的选项，
  // 它就是要问人的那一档。
  if (base === Handling.AUTO_REPAIR) {
    const appliable = c.options.some((o) => o.effect["set_api_name"] !== undefined);
    // **ROUND_TRIP，不是 ASK_USER。** 第一版写成 ask_user，测试当场抓到后果：
    // 「必须我拍板」的条数从 1 条涨到 77 条 —— 真决策被一堆待译名淹掉，
    // 比卡在 auto_repair 更糟。中文 apiName 要的是**业务方回填一个译名**，
    // 那是回传模板那一档的事，不是 FDE 现场拍板的事。
    if (!appliable) return Handling.ROUND_TRIP;
  }
  return base;
}

export function irreversibilityOf(c: Conflict): number {
  return conflictPolicy(c).irreversibility;
}

export function conflictToDict(c: Conflict): Record<string, unknown> {
  return {
    rid: c.rid,
    kind: c.kind,
    subjects: c.subjects,
    summary: c.summary,
    handling: handlingOf(c),
    evidence: c.evidence.map(provToDict),
    options: c.options.map(optionToDict),
    owner: c.owner,
    detector: c.detector,
  };
}

function cid(kind: ConflictKind, ...parts: string[]): string {
  return `cf_${kind}_${sha256Hex(parts.join("|")).slice(0, 10)}`;
}

// ══════════════════════════════════════════════════════════════════
//  口径的结构化比较
// ══════════════════════════════════════════════════════════════════

/** CPython 的 `SRE_UNI_IS_WORD` ≈ 字母 + 数字 + 下划线（不含组合记号）。
 *
 * Python 的 `\b` 建立在这个集合上，**汉字算词字符**，所以
 * `re.search(r"\bnet\b", "净额net")` 不匹配 —— 「额」与「n」之间没有边界。
 * JS 的 `\b` 只认 `[A-Za-z0-9_]`，会在那里认出一个边界并误命中。
 * 「净额net」误命中还不改结果（本来就命中「净额」），但「税net」这种串
 * 会凭空多出一个轴取值 —— 判据写宽了，顾问就会看到假冲突。 */
const WORD_CHARS = "\\p{L}\\p{N}_";
const NET_WORD = `(?<![${WORD_CHARS}])net(?![${WORD_CHARS}])`;

function ax(src: string): RegExp {
  // `u` 是 `\p{…}` 的前提；`i` 对应 re.IGNORECASE。两个都不带 `g`，
  // exec 才没有 lastIndex 状态（== Python 的 re.search，永远从 0 开始）。
  return new RegExp(src, "iu");
}

/**
 * 口径不是自由文本 —— 它由若干个正交的轴构成。把轴抽出来做结构化比对，
 * 比让模型读两段中文判断"是否一致"稳定得多，而且能说清**差在哪个轴上**。
 *
 * 用数组而不是对象：这里的顺序是产物顺序（`parse_axes` 的返回、`_suffix` 拼出来
 * 的名字后缀都按它走），必须是声明序，不能交给引擎的键序规则。
 */
const AXES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, RegExp]>]> = [
  // 「不含税」里含有「含税」—— 必须用否定回顾，否则前者会被误判成后者。
  // 这是中文口径解析最容易踩的坑，两个取值的语义正好相反。
  [
    "税",
    [
      ["不含税", ax(`不含税|未税|净额|${NET_WORD}`)],
      ["含税", ax("(?<!不)(?<!未)含税|价税合计")],
    ],
  ],
  [
    "时间粒度",
    [
      ["年度累计", ax("年度累计|年累计|全年|annual")],
      ["单次", ax("单次|单笔|每次|per[_ ]?time")],
      ["月度", ax("月度|按月|monthly")],
    ],
  ],
  [
    "口径主体",
    [
      ["计划", ax("计划|预算|budget")],
      ["执行", ax("执行|实际|actual")],
    ],
  ],
  [
    "币种",
    [
      ["CNY", ax("CNY|人民币|元")],
      ["USD", ax("USD|美元")],
    ],
  ],
];

/**
 * 注解的起始标记。口径正文永远在最前面，之后是出处、对照说明、备注。
 *
 * 这个切分不是锦上添花 —— 一条写得好的口径常常会顺带说明"与某处在税轴
 * (含税/不含税) 上不同"，整串扫关键词会把注解里提到的对照值当成本条的取值。
 * **模型写得越详细，这个错越容易犯。**
 */
const ANNOTATION_MARKERS = [
  "（", "(", "注意", "参见", "详见", "另见", "对比", "区别于",
  "与上", "备注", "说明：", "cf.", "note:",
] as const;
const LEAD_IN = ["口径：", "口径:", "定义：", "定义:"] as const;

/** 取口径的正文部分，丢掉注解。 */
export function primaryClause(text: string): string {
  let t = (text || "").trim();
  for (const lead of LEAD_IN) {
    const i = t.indexOf(lead);
    if (i >= 0) {
      // indexOf/slice 都按 UTF-16 走，两者一致 → 切出来的子串与 Python 逐字相同
      t = t.slice(i + lead.length);
      break;
    }
  }
  // 只在标记之后确实没有轴取值时才切。括号有时出现在取值**之前**
  // （"口径（Excel 批注）：含税，年度累计"），照切会把正文整个丢掉。
  const marks: number[] = [];
  for (const m of ANNOTATION_MARKERS) {
    const i = t.indexOf(m);
    if (i > 0) marks.push(i);
  }
  marks.sort((a, b) => a - b);
  for (const i of marks) {
    const head = t.slice(0, i);
    for (const [, options] of AXES) {
      for (const [, pattern] of options) {
        if (pattern.test(head)) return pyStripChars(head, " 。；;,，");
      }
    }
  }
  return pyStripChars(t, " 。；;,，");
}

/**
 * 把一段口径描述解析成轴 → 取值。
 *
 * 同一轴上多个互斥取值同时出现时，**取最先出现的那个**。口径正文永远写在
 * 对照注解之前 —— "含税，年度累计。注意与合同域在税轴(含税/不含税)上不同"
 * 这种写法里，第一个「含税」才是本条的取值。
 *
 * 按位置判而不是靠切分正文，是因为注解的形态千变万化：括号可能出现在取值
 * 之前（"口径（Excel 批注）：含税"），也可能在之后。位置规则对两种都成立。
 *
 * 返回 `Map` 而不是普通对象：轴名是中文，虽然不会触发整数键重排，但调用方
 * 依赖的是**插入序**（`_suffix` 直接拼 values），用 Map 说得更清楚。
 *
 * @param whole 保留参数以兼容旧调用；当前实现两种模式一致（都按位置解析）。
 */
export function parseAxes(text: string, whole = false): Map<string, string> {
  void whole;
  const body = text || "";
  // 正文里就同时写了两个取值的轴，是真的没写清楚 —— 不给值。
  // 位置规则只用来排除**注解**里提到的对照值，不该用来给含糊的正文强行定性。
  const unclear = new Set(axisAmbiguities(body));
  const out = new Map<string, string>();
  for (const [axis, options] of AXES) {
    if (unclear.has(axis)) continue;
    const hits: [number, string][] = [];
    for (const [label, pattern] of options) {
      const m = pattern.exec(body);
      if (m !== null) hits.push([m.index, label]);
    }
    if (hits.length === 0) continue;
    // Python 的 min() 比元组：先比位置，位置相同再比标签（按 code point）
    let best = hits[0] as [number, string];
    for (const h of hits.slice(1)) {
      if (h[0] < best[0] || (h[0] === best[0] && cmpCodePoint(h[1], best[1]) < 0)) best = h;
    }
    out.set(axis, best[1]);
  }
  return out;
}

/**
 * **正文里**同一轴上出现了多个互斥取值的轴名 —— 这类要打回让人写清楚。
 *
 * 只看正文：注解里列举对照值是正常写法，不算歧义。
 */
export function axisAmbiguities(text: string): string[] {
  const body = primaryClause(text);
  const out: string[] = [];
  for (const [axis, options] of AXES) {
    let n = 0;
    for (const [, p] of options) if (p.test(body)) n += 1;
    if (n > 1) out.push(axis);
  }
  return out;
}

/**
 * 两段口径在哪些轴上冲突。只报**两边都识别出且不同**的轴。
 *
 * 一边识别不出不算冲突 —— 那是信息缺失（MISSING_REQUIRED），不是矛盾。
 *
 * ★ **键序是一处有意的分叉**：Python 侧是 `pa.keys() & pb.keys()` 上的推导式，
 * 键序随进程哈希种子变化（同一份输入连跑六次能得到六种顺序），也就是说
 * Python 那边根本没有稳定顺序可抄。这里固定成 AXES 的声明序 —— 内容一致，
 * 顺序确定。受影响的只有多轴分歧 summary 里各轴片段的先后。
 */
export function axisDiff(a: string, b: string): Map<string, [string, string]> {
  const pa = parseAxes(a);
  const pb = parseAxes(b);
  const out = new Map<string, [string, string]>();
  for (const [k, va] of pa) {
    const vb = pb.get(k);
    if (vb !== undefined && va !== vb) out.set(k, [va, vb]);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  规则检测器
// ══════════════════════════════════════════════════════════════════

/** Python 的 `$` 除了串尾，还匹配**末尾那一个换行之前**的位置 ——
 * `re.match(r"^[a-z][a-zA-Z0-9]*$", "planAmount\n")` 是匹配的。
 * JS 的 `$`（无 `m`）只认串尾，所以显式写出那个可选换行。 */
const CAMEL_RE = /^[a-z][a-zA-Z0-9]*\n?$/u;
/** Python 侧字面写的是 `[㐀-鿿]`，也就是 U+3400–U+9FFF。 */
const HAS_CJK = /[㐀-鿿]/u;

/** 四个容器共有的形状 —— detect_naming / auto_repair 只碰 rid 与 apiName。 */
interface NamedEntity {
  rid: string;
  apiName: Assertion<string>;
}

/** 命名规范。纯规则 + 词典，可自动修。 */
export function detectNaming(oir: OIR, dictionary: Iterable<string> = []): Conflict[] {
  const known = new Set(dictionary);
  const out: Conflict[] = [];
  const entities: NamedEntity[] = [
    ...oir.objects.values(),
    ...oir.properties.values(),
    ...oir.links.values(),
    ...oir.actions.values(),
  ];
  for (const entity of entities) {
    const name = entity.apiName.value || "";
    const why: string[] = [];
    if (HAS_CJK.test(name)) {
      why.push("apiName 含中文");
    } else if (!CAMEL_RE.test(name)) {
      why.push("apiName 不是 lowerCamelCase");
    }
    // len 按 code point：一个 emoji 在 JS 里长度是 2，会漏判成"不是缩写"
    if (cpLength(name) <= 3 && !known.has(name)) why.push("疑似未登记缩写");
    if (why.length === 0) continue;
    const fixed = toCamel(name);
    // **能自动修的才给自动修的选项。**
    //
    // toCamel 做的是标识符归一（切 `[_\-\s]+` 再驼峰拼），对 latin 标识符是
    // 「可逆、零语义损失」的；对含中文的名字它两头不着：
    //   · 多数情况恒等（真库 25 条里 23 条），option 变成「改为 <它自己>」——
    //     autoRepair 因 old === new 短路，这条冲突就永远消化不掉；
    //   · 少数情况把名字里的连字符当分隔符吃掉 ——「按期概率50%-85%」
    //     变成「50%85%」，区间号没了，那不是归一，是改数据。
    // 中文名要的是一个**译名**，机器给不出来。所以照报违规（上游没罗马化是
    // 真信号），但把动作交回给人。
    const repairable = fixed !== name && !HAS_CJK.test(name);
    const options = repairable
      ? [
          makeOption("apply", `改为 ${fixed}`, "可逆、零语义损失", {
            effect: { set_api_name: fixed },
          }),
        ]
      : [
          makeOption(
            "rename",
            "请给这个对象的英文译名（lowerCamelCase）",
            "机器只会做标识符归一，给不出译名；中文 apiName 交付不了，需要人定",
          ),
        ];
    out.push(
      makeConflict(
        cid(ConflictKind.NAMING_VIOLATION, entity.rid),
        ConflictKind.NAMING_VIOLATION,
        [entity.rid],
        `${entity.rid}: ${why.join("；")}`,
        {
          evidence: [...entity.apiName.evidence],
          options,
          detector: "rule:NAME-01",
        },
      ),
    );
  }
  return out;
}

/** 必填缺失。规则，打回责任人。 */
export function detectMissingRequired(oir: OIR): Conflict[] {
  const out: Conflict[] = [];
  for (const p of oir.properties.values()) {
    const gaps: string[] = [];
    if ((p.definition.value || "").trim() === "") gaps.push("口径定义");
    if ((p.displayName.value || "").trim() === "") gaps.push("显示名");
    if (gaps.length === 0) continue;
    out.push(
      makeConflict(
        cid(ConflictKind.MISSING_REQUIRED, p.rid),
        ConflictKind.MISSING_REQUIRED,
        [p.rid],
        `${pyFmt(p.apiName.value)}: 缺 ${gaps.join("、")}`,
        { owner: p.owner, detector: "rule:REQ-01" },
      ),
    );
  }
  for (const o of oir.objects.values()) {
    // Python 是 `if not o.primary_key.value` —— 空数组在 Python 里是**假**。
    // 照 JS 语义写（`!o.primaryKey.value`）这条永远不报。
    const pk = o.primaryKey.value;
    if (pk === null || pk === undefined || pk.length === 0) {
      out.push(
        makeConflict(
          cid(ConflictKind.MISSING_REQUIRED, o.rid, "pk"),
          ConflictKind.MISSING_REQUIRED,
          [o.rid],
          `${pyFmt(o.apiName.value)}: 未声明主键`,
          { owner: o.owner, detector: "rule:REQ-02" },
        ),
      );
    }
  }
  return out;
}

/** 孤立对象。图算法，仅提示 —— 通常意味着遗漏而非错误。 */
export function detectOrphans(oir: OIR): Conflict[] {
  return oir.orphans().map((o) =>
    makeConflict(
      cid(ConflictKind.ORPHAN, o.rid),
      ConflictKind.ORPHAN,
      [o.rid],
      `${pyFmt(o.apiName.value)} 与任何对象都没有关系，可能是遗漏`,
      { evidence: [...o.apiName.evidence], detector: "rule:GRAPH-01" },
    ),
  );
}

/**
 * 有对象但无 ActionType。
 *
 * 设计稿里的杀手锏就在这：不是简单报"缺失"，而是**从 OpenAPI 写操作端点反推
 * 草稿**再让业务确认。让业务方从"改"开始比从"写"开始完成率高得多。
 */
export function detectMissingActions(
  oir: OIR,
  endpoints: readonly Record<string, unknown>[] | null = null,
): Conflict[] {
  const missing = oir.objectsWithoutActions();
  if (missing.length === 0) return [];
  const eps = endpoints ?? [];

  // **聚合成一个政策问题，而不是每个对象问一次。**
  // 23 个对象都缺 ActionType 时，「要不要从 OpenAPI 反推」是一次决策，不是
  // 23 次。逐个问会瞬间耗尽 FDE 的耐心，而且每问一次答案都一样。
  const matched = new Map<string, Record<string, unknown>[]>();
  for (const o of missing) {
    const cands = eps.filter((e) => endpointMatches(e, o.apiName.value, o.aliases));
    if (cands.length > 0) matched.set(o.rid, cands);
  }

  const covered = matched.size;
  const ev: Provenance[] = [];
  for (const cands of matched.values()) {
    for (const e of cands.slice(0, 1)) {
      const method = req(e, "method");
      if (typeof method !== "string") {
        throw new TypeError(`endpoint.method 期望字符串，拿到 ${pyFmt(method)}`);
      }
      ev.push(
        makeProvenance(
          pyFmt(dget(e, "file_id", "openapi")),
          pyFmt(dget(e, "file_name", "openapi.json")),
          { kind: "json", pointer: pyFmt(dget(e, "pointer", "")) },
          {
            snippet: `${method.toUpperCase()} ${pyFmt(req(e, "path"))} → ${pyFmt(
              req(e, "operationId"),
            )}`,
            extractor: "openapi",
            confidence: 0.85,
          },
        ),
      );
    }
  }

  const options: Option[] = [];
  if (covered > 0) {
    const draftActions: Record<string, unknown[]> = {};
    for (const [r, c] of matched) draftActions[r] = c.map((e) => req(e, "operationId"));
    options.push(
      makeOption(
        "draft_from_openapi",
        `反推草稿，覆盖 ${covered}/${missing.length} 个对象`,
        "标记为 DRAFT_FROM_API 进模板让业务确认 —— 从「改」开始比从「写」开始完成率高得多",
        { evidence: ev.slice(0, 6), effect: { draft_actions: draftActions } },
      ),
    );
  }
  options.push(makeOption("leave_blank", "留空让业务自己填", "预计完成率低于 30%"));

  const detail =
    covered > 0 ? `；OpenAPI 里有写端点可覆盖其中 ${covered} 个` : "；OpenAPI 里没有可用端点";
  return [
    makeConflict(
      cid(ConflictKind.MISSING_ACTION, ...sortedCp(missing.map((o) => o.rid))),
      ConflictKind.MISSING_ACTION,
      missing.map((o) => o.rid),
      `${missing.length} 个对象没有任何 ActionType${detail}`,
      { evidence: ev.slice(0, 6), options, detector: "rule:ACT-01" },
    ),
  ];
}

/** 只有写操作端点才可能对应 ActionType。GET 是读，不改变世界状态。 */
const WRITE_METHODS: ReadonlySet<string> = new Set(["post", "put", "patch", "delete"]);
/** Python 的 `\s` 比 JS 的多 `\x1c-\x1f` `\x85`、少 `﻿`；api 名里出现这些
 * 控制字符的概率约等于零，不为它单独造一个字符类。 */
const SPLIT_RE = /(?<=[a-z0-9])(?=[A-Z])|[_\-\s/{}]+/u;

/**
 * 端点是否可能属于这个对象。
 *
 * 按 camelCase 拆词后做词元匹配 —— 物理名与业务名混用是常态，整串比对基本
 * 匹配不上。只取前两个词元：`purchasePlanHeader` 的 `Header` 是结构后缀，
 * 端点名里通常不出现。
 */
export function endpointMatches(
  endpoint: Record<string, unknown>,
  apiName: string,
  aliases: Iterable<string> = [],
): boolean {
  if (!WRITE_METHODS.has(pyFmt(dget(endpoint, "method", "")).toLowerCase())) return false;
  let hay = `${pyFmt(dget(endpoint, "operationId", ""))} ${pyFmt(
    dget(endpoint, "path", ""),
  )}`.toLowerCase();
  hay = hay.replace(/[-_/]/gu, "");
  for (const name of [apiName, ...aliases]) {
    const tokens = (name || "")
      .split(SPLIT_RE)
      .filter((t) => cpLength(t) >= 3)
      .slice(0, 2)
      .map((t) => t.toLowerCase());
    // `rstrip("s")` 剥掉的是**全部**尾部 s，不是一个
    if (tokens.length > 0 && tokens.every((t) => hay.includes(pyRstripChars(t, "s")))) return true;
  }
  return false;
}

/**
 * 声明类型与实际数据不符。
 *
 * **由确定性 profiler 提供分布统计** —— LLM 无法可靠发现需要跨行统计理解的
 * 问题（arXiv:2503.06664 的实证结论），这类检测绝不能交给模型。
 */
export function detectTypeMismatch(
  oir: OIR,
  profiles: Readonly<Record<string, Record<string, unknown>>>,
): Conflict[] {
  const out: Conflict[] = [];
  for (const [rid, prof] of Object.entries(profiles)) {
    const p = oir.properties.get(rid);
    const actual = prof["inferred_type"];
    if (p === undefined || actual === undefined || actual === null) continue;
    if (pyStr(actual) !== pyStr(p.baseType.value)) {
      const sample = dget(prof, "sample_size", "?");
      out.push(
        makeConflict(
          cid(ConflictKind.TYPE_MISMATCH, rid),
          ConflictKind.TYPE_MISMATCH,
          [rid],
          `${pyFmt(p.apiName.value)}: 声明 ${pyFmt(p.baseType.value)}，` +
            `实际数据看起来是 ${pyFmt(actual)}（样本 ${pyFmt(sample)} 行）`,
          {
            options: [
              makeOption("use_actual", `改为 ${pyFmt(actual)}`, "以实际数据为准", {
                effect: { set_base_type: actual },
              }),
              makeOption("keep_declared", `保留 ${pyFmt(p.baseType.value)}`, "数据侧需清洗"),
            ],
            detector: "profiler:TYPE-01",
          },
        ),
      );
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  语义检测器（先用启发式收窄，再交模型）
// ══════════════════════════════════════════════════════════════════

/**
 * 同名属性两处口径不一致 —— 「计划金额」双口径就是这一类。
 *
 * 先按 apiName 分组找同名属性，再对口径做**结构化轴比对**。类型相同、名字相同、
 * 只有口径文字不同，所以纯 schema 比对发现不了 —— 这正是本产品的价值所在。
 */
export function detectSemanticDivergence(oir: OIR): Conflict[] {
  const byName = new Map<string, PropertyType[]>();
  for (const p of oir.properties.values()) {
    const key = (p.apiName.value || "").toLowerCase();
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [p]);
    else bucket.push(p);
  }

  const out: Conflict[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;

    // **按 apiName 聚成一条，不按两两配对。**
    // 同一个字段在 3 处出现就有 3 对组合，逐对上报会让「计划金额」一个决策
    // 占掉 top-3 里的两三个位置，而 FDE 要做的其实只是一次口径裁决。
    let variants = new Map<string, PropertyType[]>();
    for (const p of group) {
      const key = canonicalAxes(p.definition.value || "");
      const bucket = variants.get(key);
      if (bucket === undefined) variants.set(key, [p]);
      else bucket.push(p);
    }

    // **轴认得出来是加分项，不是前置条件。**
    //
    // 以前这里有两道 `continue`：轴签名只有一种就跳过、说不出差在哪一维也跳过。
    // 于是"两段口径写得明显不同，但一条已知轴都没命中"被表达成了「没问题」——
    // 系统不是没查，是主动判定了这两条口径相同。轴表只有四条采购财务轴
    // （见 AXES），换个行业（工艺、条款、诊疗）几乎条条落在这里，整条口径
    // 检测静默归零。这正好违反「查不到就说查不到」。
    //
    // 现在：轴认得出就报轴；认不出就报**差在哪几个字**，并明说这一维判不出来。
    // 报冲突 ≠ 裁决 —— 选项里照旧不给推荐，仍然是人拍板。
    let reps = [...variants.values()].map((ps) => ps[0] as PropertyType);
    const diff =
      reps.length >= 2
        ? axisDiff(
            (reps[0] as PropertyType).definition.value || "",
            (reps[1] as PropertyType).definition.value || "",
          )
        : new Map<string, [string, string]>();
    let axes: string;
    if (diff.size > 0) {
      axes = [...diff].map(([k, [va, vb]]) => `${k}（${va} vs ${vb}）`).join("、");
    } else {
      // 同名属性里字面最不一样的两条 —— 轴分不开它们，字面分得开。
      const [a, b] = widestPair(group);
      if (a === null || b === null) continue; // 字面上真的一模一样，这才是"没问题"
      reps = [a, b];
      const frags = undescribedDiff(a.definition.value || "", b.definition.value || "");
      axes = `差在这几处：${frags.join("、")}（我判不出是哪一维）`;
      if (variants.size < 2) {
        variants = new Map([
          ["a", [a]],
          ["b", [b]],
        ]);
      }
    }
    const r0 = reps[0] as PropertyType;
    const r1 = reps[1] as PropertyType;
    const where = `${variants.size} 种口径、涉及 ${group.length} 处`;
    out.push(
      makeConflict(
        cid(ConflictKind.SEMANTIC_DIVERGENCE, ...sortedCp(group.map((p) => p.rid))),
        ConflictKind.SEMANTIC_DIVERGENCE,
        group.map((p) => p.rid),
        `「${r0.displayName.value || name}」口径不一致（${where}）：${axes}`,
        {
          evidence: reps.flatMap((p) => p.definition.evidence.slice(0, 1)),
          options: divergenceOptions(r0, r1, diff, variants),
          detector: "rule:AXIS-01",
        },
      ),
    );
  }
  return out;
}

/** 口径的规范化签名。轴取值相同即视为同一种口径，无论文字怎么写。 */
export function canonicalAxes(text: string): string {
  const axm = parseAxes(text);
  const keys = sortedCp(axm.keys());
  return keys.map((k) => `${k}=${axm.get(k) as string}`).join("|") || "∅";
}

/**
 * 同名属性里字面差得最远的两条。全都一字不差时返回 `[null, null]`。
 *
 * 只在轴分不开它们时才用 —— 报冲突要举得出**具体两处**，"这 5 处口径不一致"
 * 而不指出是哪两处，FDE 没法拿去问客户。
 */
function widestPair(group: readonly PropertyType[]): [PropertyType | null, PropertyType | null] {
  let bestRatio = 1.0;
  let bestA: PropertyType | null = null;
  let bestB: PropertyType | null = null;
  for (let i = 0; i < group.length; i++) {
    const a = group[i] as PropertyType;
    for (const b of group.slice(i + 1)) {
      const na = normText(a.definition.value);
      const nb = normText(b.definition.value);
      if (na.length === 0 && nb.length === 0) continue;
      const ratio = new SequenceMatcher(null, na, nb, false).ratio();
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestA = a;
        bestB = b;
      }
    }
  }
  return [bestA, bestB];
}

/** 比字面时先去掉空白与标点 —— 多一个顿号不是口径差异。
 * 返回 **code point 数组**：下游是 difflib，它的下标必须按 code point 算。 */
function normText(text: string | null | undefined): string[] {
  return toCodePoints((text ?? "").replace(/[\s，。；;、,.:：（）()【】[\]「」"']+/gu, ""));
}

/**
 * 两段口径**差在哪几个片段**上。确定性切分，不解释含义。
 *
 * 用途是回答"我判不出差在哪一维，但我看得出差在哪几个字" —— 轴表只有四条
 * 采购财务轴，换个行业（工艺、条款、诊疗）几乎条条认不出，而认不出不该等于
 * "没问题"。中文没有词边界，所以按字符做最长公共子序列取差异片段，
 * 不做分词、不猜语义。
 */
export function undescribedDiff(a: string, b: string, limit = 6): string[] {
  const na = normText(a);
  const nb = normText(b);
  if (na.length === nb.length && na.every((c, i) => c === nb[i])) return [];
  const out: string[] = [];
  for (const op of new SequenceMatcher(null, na, nb, false).getOpcodes()) {
    if (op.tag === "equal") continue;
    for (const frag of [na.slice(op.i1, op.i2).join(""), nb.slice(op.j1, op.j2).join("")]) {
      if (frag !== "" && !out.includes(frag)) out.push(frag);
    }
  }
  return out.slice(0, limit);
}

function divergenceOptions(
  a: PropertyType,
  b: PropertyType,
  diff: ReadonlyMap<string, [string, string]>,
  variants: ReadonlyMap<string, PropertyType[]> | null = null,
): Option[] {
  const axLabel = sortedCp(diff.keys()).join("_");
  // 同一种口径下的**所有**属性都要一起改名，不能只改代表那一个 ——
  // 漏掉的那个会在下一轮又被判成新的口径冲突。
  const splitRids =
    variants !== null && variants.size > 0
      ? [...variants.values()].flatMap((ps) => ps.map((p) => p.rid))
      : [a.rid, b.rid];
  return [
    makeOption(
      "split_two_properties",
      `拆成两个属性：${a.apiName.value}${suffix(a)} / ${b.apiName.value}${suffix(b)}`,
      "信息不丢，但下游报表口径要跟着改",
      {
        evidence: [...a.definition.evidence.slice(0, 1), ...b.definition.evidence.slice(0, 1)],
        effect: { split: splitRids, axes: axLabel },
      },
    ),
    makeOption("unify_a", `统一为 A 口径（${short(a.definition.value)}）`, "B 处标记为派生，需补换算规则", {
      evidence: [...a.definition.evidence.slice(0, 1)],
      effect: { unify_to: a.rid },
    }),
    makeOption("unify_b", `统一为 B 口径（${short(b.definition.value)}）`, "A 处标记为派生，历史数据需回溯", {
      evidence: [...b.definition.evidence.slice(0, 1)],
      effect: { unify_to: b.rid },
    }),
    makeOption("defer_to_template", "先不定，转成模板里的业务必填项", "推迟到业务方填写时消解", {
      effect: { defer: true },
    }),
  ];
}

/** 选项标签只放口径正文。整段糊上去人读不下去，也就等于没给选项。 */
function short(text: string, limit = 40): string {
  const body = primaryClause(text) || text || "";
  return cpLength(body) <= limit ? body : sliceCodePoints(body, limit) + "…";
}

function suffix(p: PropertyType): string {
  const axm = parseAxes(p.definition.value || "");
  const tail: Readonly<Record<string, string>> = {
    含税: "TaxIncl",
    不含税: "Net",
    年度累计: "Annual",
    单次: "PerTime",
  };
  let out = "";
  for (const v of axm.values()) out += tail[v] ?? "";
  return out;
}

/** 疑似敷衍的启发式信号。**先用规则收窄候选，再交 LLM 终判** ——
 * 纯规则会误伤真该填「无」的格子，纯 LLM 又贵又不稳。 */
export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "无", "n/a", "na", "-", "—", "待定", "同上", "见附件", "略", "tbd",
]);

/** 单元格级的敷衍信号。 */
export function perfunctorySignals(opts: {
  value: string;
  columnHeader?: string;
  aiPrefill?: string;
  expectsDefinition?: boolean;
  columnDistinctRatio?: number;
}): string[] {
  const value = opts.value;
  const columnHeader = opts.columnHeader ?? "";
  const aiPrefill = opts.aiPrefill ?? "";
  const expectsDefinition = opts.expectsDefinition ?? true;
  const columnDistinctRatio = opts.columnDistinctRatio ?? 1.0;

  const v = (value || "").trim();
  const s: string[] = [];
  if (v !== "" && columnHeader !== "" && v === columnHeader.trim()) s.push("COPIED_HEADER");
  if (PLACEHOLDERS.has(v.toLowerCase())) s.push("PLACEHOLDER");
  // len 按 code point：四个 emoji 在 JS 里是 8，会漏判
  if (expectsDefinition && cpLength(v) > 0 && cpLength(v) < 4) s.push("TOO_SHORT");
  if (aiPrefill !== "" && v === aiPrefill.trim()) {
    // AI 预填了，业务方原样交回 —— 说明他根本没审。不抓出来整个往返闭环
    // 就是自欺欺人。
    s.push("UNCHANGED_PREFILL");
  }
  // 整列一个值只对**自由文本列**才是敷衍信号。枚举列（是/否、已确认/待确认）
  // 和责任人列本来取值就少，按重复率判会把正常填写全部误报成敷衍。
  if (expectsDefinition && columnDistinctRatio < 0.2) s.push("BULK_FILLED");
  return s;
}

/**
 * 从回传件里挑出疑似敷衍的格子（启发式阶段）。
 *
 * 命中信号的进 LLM 终判队列；没命中的连模型都不用调。
 */
export function detectPerfunctory(cells: readonly Record<string, unknown>[]): Conflict[] {
  const out: Conflict[] = [];
  for (const c of cells) {
    const ratio = dget(c, "column_distinct_ratio", 1.0);
    // Python 是 `column_distinct_ratio < 0.2`，非数值当场 TypeError。同样炸：
    // 静默当 0 会把整列误判成敷衍，那是往 FDE 桌上倒噪声。
    if (typeof ratio !== "number") {
      throw new TypeError(`column_distinct_ratio 期望数值，拿到 ${pyFmt(ratio)}`);
    }
    const sig = perfunctorySignals({
      value: getStr(c, "value"),
      columnHeader: getStr(c, "column_header"),
      aiPrefill: getStr(c, "ai_prefill"),
      expectsDefinition: pyTruthy(dget(c, "expects_definition", true)),
      columnDistinctRatio: ratio,
    });
    if (sig.length === 0) continue;
    const rid = req(c, "rid");
    out.push(
      makeConflict(
        cid(ConflictKind.PERFUNCTORY, pyFmt(rid), getStr(c, "field")),
        ConflictKind.PERFUNCTORY,
        [pyFmt(rid)],
        // 注意两处 field 的默认值不同：cid 里是 ""，摘要里是 "字段"。照抄。
        `${pyFmt(dget(c, "field", "字段"))} 疑似敷衍填写（${sig.join("、")}）`,
        { owner: (dget(c, "owner", null) ?? null) as string | null, detector: "heuristic:PERF-01" },
      ),
    );
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  汇总
// ══════════════════════════════════════════════════════════════════

/** 跑完全部规则检测器。语义检测器（DUPLICATE 的最终判定）由 critic 补。 */
export function detectAll(
  oir: OIR,
  opts: {
    endpoints?: readonly Record<string, unknown>[] | null;
    profiles?: Readonly<Record<string, Record<string, unknown>>> | null;
    dictionary?: Iterable<string>;
    returnedCells?: readonly Record<string, unknown>[] | null;
  } = {},
): Conflict[] {
  const out: Conflict[] = [
    ...detectSemanticDivergence(oir),
    ...detectNaming(oir, opts.dictionary ?? []),
    ...detectMissingRequired(oir),
    ...detectOrphans(oir),
    ...detectMissingActions(oir, opts.endpoints ?? null),
    ...detectTypeMismatch(oir, opts.profiles ?? {}),
    ...detectPerfunctory(opts.returnedCells ?? []),
  ];
  for (const c of out) {
    for (const rid of c.subjects) {
      // 注意：**没有 actions** —— Python 侧就只挂这三个桶，别顺手补第四个。
      for (const bucket of [oir.objects, oir.properties, oir.links]) {
        const e = bucket.get(rid);
        if (e !== undefined && !e.conflicts.includes(c.rid)) e.conflicts.push(c.rid);
      }
    }
  }
  return out;
}

/**
 * 执行可自动修的冲突，返回可回滚的变更账。
 *
 * **边界很保守**：只有可逆、零语义损失、可完整记账的才自动做。命名规范化满足；
 * 口径统一不满足（会丢信息，必须问人）。
 */
export function autoRepair(oir: OIR, conflicts: readonly Conflict[]): Record<string, unknown>[] {
  const log: Record<string, unknown>[] = [];
  for (const c of conflicts) {
    if (handlingOf(c) !== Handling.AUTO_REPAIR || c.options.length === 0) continue;
    const effect = (c.options[0] as Option).effect;
    const newName = effect["set_api_name"];
    if (newName === undefined || newName === null) continue;
    for (const rid of c.subjects) {
      // 这里**有 actions** —— 与 detect_all 的反向挂载不对称，是 Python 的原样。
      for (const bucket of [oir.objects, oir.properties, oir.links, oir.actions] as const) {
        const e: NamedEntity | undefined = bucket.get(rid);
        if (e === undefined) continue;
        const old = e.apiName.value;
        if (old === newName) continue;
        e.apiName.value = pyStr(newName);
        e.apiName.origin = Origin.AUTO_REPAIRED;
        log.push({
          conflict: c.rid,
          rid,
          field: "apiName",
          from: old,
          to: newName,
          reversible: true,
        });
      }
    }
  }
  return log;
}

/** 把各种命名风格归一成 lowerCamelCase。中文原样保留 —— 需要人给译名。 */
export function toCamel(name: string): string {
  const parts = (name || "").trim().split(/[_\-\s]+/u).filter((p) => p !== "");
  // 注意返回的是**原始** name，不是 strip 过的 —— to_camel("  ") 给 "  "。
  if (parts.length === 0) return name;
  const first = parts[0] as string;
  // 判据用的也是原始 name：" Plan " 里有空格，所以走下面那条分支变成 "plan"，
  // 而不是 "Plan" → "plan"（这一版恰好同值，但换成 " PlanX " 就分岔了）。
  if (parts.length === 1 && !/[_\-\s]/u.test(name)) {
    const cps = toCodePoints(first);
    return (cps[0] as string).toLowerCase() + cps.slice(1).join("");
  }
  return (
    first.toLowerCase() +
    parts
      .slice(1)
      .map((p) => sliceCodePoints(p, 1).toUpperCase() + toCodePoints(p).slice(1).join(""))
      .join("")
  );
}
