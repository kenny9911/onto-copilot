/**
 * 段形状推断 —— 在读内容之前先搞清楚"这段材料到底是什么表"。
 *
 * 这一层存在的理由是一次真实失败。一份 326 行的采购材料里有三张 sheet：
 *
 *     业务对象实体梳理    168 行   一行 = 一个实体（有实体编码列，没有字段列）
 *     业务对象API梳理-行动 112 行   一行 = 一个行动（多一列 url）
 *     业务规则             45 行   一行 = 一段散文
 *
 * 流水线当时对三张表用同一句话提要求："每一行字段都要抽成 PropertyType"。于是
 * critic 判定"抽出 58 个对象却零属性 = 一定漏抽"、节点反复重试、预算烧穿，而真相
 * 是**前两张表里本来就没有属性**。写死"表里必有字段"就是硬编码，换一份材料立刻塌。
 *
 * 所以这里做两件事，全部从**列的取值画像**推断，不认表名、不认关键字表：
 *
 * 1. {@link classifyColumns} —— 每列是标识符 / 名称 / 分组 / 端点 / 数据类型 /
 *    是否必填 / 散文 / 枚举中的哪一种。
 * 2. {@link inferShape} —— 由列角色推出这一段**能产出什么**（对象 / 属性 / 行动 /
 *    规则），以及**哪些产出是规则就能确定的**。
 *
 * 第 2 点的下游影响是双重的：
 *   · critic 只对"这段应该有"的东西判缺失，假阳性消失；
 *   · 规则能确定的行（一行一实体、一行一行动）根本不进模型 —— 既不会丢行，
 *     也不会为了复述 168 行而烧 Opus 的钱。这就是 ADR-5 的落点。
 *
 * ── 移植说明（Python → TS 的语义分叉，全部由 golden/shape.extra.json 钉住）──
 *
 * 判据里的每一个阈值都照抄，一个都没动。会分叉的是**语言原语**，逐条处理：
 *
 *   · `len(s)` 是码点数，`s.length` 是 UTF-16 码元数 —— mean_len 直接喂给
 *     30 / 24 / 12 / 8 这些阈值，emoji 一进来就会把判定带偏，所以统一走 {@link cpLen}；
 *   · `str.strip()` 与 `String.trim()` 的空白集不同（Python 多 \x1c-\x1f\x85，
 *     JS 多 ﻿）—— fill 是所有判据的地基，这里用 {@link pyStrip} 精确对齐；
 *   · `\d` 在 Python 里认全角数字、`\w` 认中日韩，JS 的都不认 —— 正则里换成
 *     `\p{Nd}` / `\p{L}\p{N}`（golden 里有一条全角编号的选项串专门钉这个）；
 *   · `round(x, n)` 是**对二进制精确值**做 half-even，`toFixed` / `Math.round(x*1e3)`
 *     都不是（1/16 → Python 0.062，toFixed 0.063）—— 见 {@link pyRound}；
 *   · `str(v)`：None → "None"、True → "True" —— 见 {@link pyStr}。
 *
 * **已知且被钉住的分叉**：JS 里 1 与 1.0 是同一个值。单元格是 Python float 1.0 时
 * Python `str()` 给 "1.0"，TS 只能给 "1"。落到 api_name / display_name 上就是一个
 * 字节的差别。这是语言边界，不是 bug。
 */

// ══════════════════════════════════════════════════════════════════
//  Python 原语的对齐层
// ══════════════════════════════════════════════════════════════════

/** Python str 的空白集：比 JS 的 `\s` 多 \x1c-\x1f 与 \x85，少 ﻿。 */
const PY_SPACE = "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680" +
  "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

/** `str.strip()`。**不能**用 trim 代替：BOM 开头的单元格在 Python 里是有值的，
 * trim 会把它削成空串，整列 fill 跟着塌 —— 而 fill 是所有形状判据的地基。 */
function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/** `str.strip(chars)` —— 只削给定的那几个字符。 */
function pyStripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const cps = [...s];
  let i = 0;
  let j = cps.length;
  while (i < j && set.has(cps[i]!)) i += 1;
  while (j > i && set.has(cps[j - 1]!)) j -= 1;
  return cps.slice(i, j).join("");
}

/** `len(s)` —— 按码点。 */
function cpLen(s: string): number {
  return [...s].length;
}

/** `str(v)`。单元格来自 xlsx，可能是数字、布尔、None。 */
function pyStr(v: unknown): string {
  if (v === null) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    // 整数值的 float 在这里退化成整数写法（已知分叉，见文件头）。
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

const F64 = new DataView(new ArrayBuffer(8));

/** 把 double 拆成精确的 m * 2^e。 */
function decompose(x: number): { m: bigint; e: number } {
  F64.setFloat64(0, x);
  const bits = F64.getBigUint64(0);
  const be = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xf_ffff_ffff_ffffn;
  return be === 0 ? { m: frac, e: -1074 } : { m: frac | (1n << 52n), e: be - 1075 };
}

/** `round(x, nd)` —— 对**二进制精确值**做 half-even，再按十进制串回到 double。
 *
 * 这不是吹毛求疵：`fill` / `distinct_ratio` / `mean_len` 都是 k/n，正好落在
 * .5 上的机会一点也不少（1/16 = 0.0625、25/4 = 6.25 都是精确值）。
 * `Number(x.toFixed(n))` 在平局时朝上进位、`Math.round(x*1e3)/1e3` 还会额外
 * 引入一次乘法误差 —— 两条路都会让 to_dict 的数字和 golden 差一个末位。
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const { m, e } = decompose(Math.abs(x));
  const p = 10n ** BigInt(nd);
  const num = e >= 0 ? m * (1n << BigInt(e)) * p : m * p;
  const den = e >= 0 ? 1n : 1n << BigInt(-e);
  let q = num / den;
  const twice = (num % den) * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  // CPython 走的是 dtoa → strtod，中间不经过二进制运算；这里同样只拼十进制串。
  const s = q.toString().padStart(nd + 1, "0");
  const text = nd === 0 ? s : `${s.slice(0, s.length - nd)}.${s.slice(s.length - nd)}`;
  const out = Number(text);
  return neg ? -out : out;
}

/** `max(items, key=...)` —— 平局取**最先**出现的那个（Python 语义）。 */
function maxBy<T>(items: readonly T[], key: (t: T) => number[]): T | null {
  let best: T | null = null;
  let bestKey: number[] | null = null;
  for (const it of items) {
    const k = key(it);
    if (bestKey === null || cmpKey(k, bestKey) > 0) {
      best = it;
      bestKey = k;
    }
  }
  return best;
}

/** `min(items, key=...)` —— 平局同样取最先出现的。 */
function minBy<T>(items: readonly T[], key: (t: T) => number[]): T | null {
  let best: T | null = null;
  let bestKey: number[] | null = null;
  for (const it of items) {
    const k = key(it);
    if (bestKey === null || cmpKey(k, bestKey) < 0) {
      best = it;
      bestKey = k;
    }
  }
  return best;
}

function cmpKey(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── 行 ──────────────────────────────────────────────────────────

/** 一行的 ``raw`` 字典。
 *
 * 允许 Map 是因为**列序是判据的一部分**（答复槽取最右一列、宿主列同重复度时取
 * 靠右的），而 V8 的普通对象会把纯数字键提到最前面 —— 表头是 "1"/"2" 的材料
 * 一进来列序就乱了。这种材料用 Map 传。
 */
export type Row = Record<string, unknown> | Map<string, unknown>;

/** 对应 `isinstance(r, dict)` —— 不是字典的行直接跳过。 */
function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rowEntries(r: Row): [string, unknown][] {
  return r instanceof Map ? [...r.entries()] : Object.entries(r);
}

/** `str(row.get(key, ""))`。键不存在给 ""，键存在但值是 null 给 "None"。 */
function rowStr(r: Row, key: string): string {
  const v = r instanceof Map ? r.get(key) : (r as Record<string, unknown>)[key];
  return v === undefined ? "" : pyStr(v);
}

// ══════════════════════════════════════════════════════════════════
//  列角色
// ══════════════════════════════════════════════════════════════════

/** 一列在建模里扮演的角色。 */
export const ColumnRole = {
  IDENTIFIER: "identifier",   // 机器可读的编码：camelCase / snake_case / 点分
  LABEL: "label",             // 人读的名称，短、几乎不重复
  GROUP: "group",             // 分类/模块：短、重复率高
  ENDPOINT: "endpoint",       // URL 或路径 —— 一行绑定一个行动的信号
  DATATYPE: "datatype",       // 数据类型词表 —— 一行是一个字段的**决定性**信号
  REQUIRED: "required",       // 是否必填之类的布尔列
  PROSE: "prose",             // 长文本：定义、规则、职责
  ENUM: "enum",               // 取值很少的短枚举
  CARDINALITY: "cardinality", // 基数：1:N / M:N / 一对多 —— 关系表的**决定性**信号
  QUESTION: "question",       // 问句列 —— 问卷的主体
  OPTIONS: "options",         // 参考选项列（①②③）
  ANSWER_SLOT: "answer_slot", // 待填答复列：整列空，就是它把这张表标成"待填"
  EMPTY: "empty",             // 整列空
  UNKNOWN: "unknown",
} as const;
export type ColumnRole = (typeof ColumnRole)[keyof typeof ColumnRole];

const COLUMN_ROLES = new Set<string>(Object.values(ColumnRole));

/** 对应 `ColumnRole(v)`：认不出就抛，不要用 `as` 把校验删掉。 */
export function parseColumnRole(v: string): ColumnRole {
  if (!COLUMN_ROLES.has(v)) throw new Error(`未知的 ColumnRole: ${v}`);
  return v as ColumnRole;
}

/** 数据类型词表。命中要靠**取值**，不是列名 —— 列名叫"类型"但填的是中文说明的表
 * 到处都是，反过来列名叫 col7 却整列 varchar(32) 的也有。 */
const TYPE_WORDS = new Set([
  "varchar", "nvarchar", "char", "text", "clob", "blob", "string", "str",
  "int", "integer", "bigint", "smallint", "tinyint", "number", "numeric",
  "decimal", "double", "float", "money", "date", "datetime", "timestamp",
  "time", "bool", "boolean", "bit", "json", "uuid", "long", "short",
  "字符", "字符串", "整数", "整型", "数值", "数字", "日期", "时间", "布尔", "金额",
  // 中文数据字典里极常见的写法。少了这些，客户按国标格式给的字段表整张作废 ——
  // 见 normType：「字符型」会先被削成「字符」，所以这里补的是**词干不同**的。
  "文本", "长文本", "大文本", "备注", "小数", "浮点", "单精度", "双精度",
  "货币", "百分比", "枚举", "字典", "主键", "外键", "时间戳", "年月日",
  "逻辑", "二进制", "图片", "附件",
  // 各家数据库/建模工具的写法
  "varchar2", "nvarchar2", "int2", "int4", "int8", "serial",
  "real", "bytea", "jsonb", "uniqueidentifier", "datetime2",
]);

// `\d` 换成 `\p{Nd}`：Python 的 `\d` 认全角数字，JS 的只认 ASCII。
const TYPE_RE = /^\s*([A-Za-z0-9_一-鿿]+)\s*(\(\s*\p{Nd}+(\s*,\s*\p{Nd}+)?\s*\))?\s*$/u;

/** 中文类型词的后缀。「字符型」「数值类型」「日期类」都是同一个东西，
 * 逐个往词表里塞是塞不完的，削掉后缀再比才对。 */
const TYPE_SUFFIX = ["类型", "型", "类"];

/** 列名里出现这些词，说明它**自称**是类型列。只作为取值判据的**辅助**：
 * 客户会用自己的一套类型词（「短文本」「长整数」「自定义编码」），
 * 词表永远追不全，但"列名说是类型 + 取值又短又高度重复"这个组合很难误判。 */
const TYPE_NAME_RE = /(数据类型|字段类型|类型|type|datatype|data_type)/iu;

/** 把一个取值削成可比的类型词干：去长度括号、去中文后缀、转小写。 */
function normType(v: string): string {
  const m = TYPE_RE.exec(v);
  if (!m) return "";
  const stem = pyStrip(m[1]!).toLowerCase();
  for (const suf of TYPE_SUFFIX) {
    if (cpLen(stem) > cpLen(suf) && stem.endsWith(suf)) {
      return [...stem].slice(0, cpLen(stem) - cpLen(suf)).join("");
    }
  }
  return stem;
}

/** 布尔取值。同样只看取值。 */
const BOOL_WORDS = new Set(["是", "否", "y", "n", "yes", "no", "true", "false", "1", "0",
  "必填", "非必填", "可空", "不可空", "√", "×"]);

/** 基数取值：1:1 / 1:N / N:1 / M:N / 一对多 / 0..1 / 1..*。
 * 比对前先把全角冒号换成半角、去空白（roleOf 里做）。 */
const CARDINALITY_RE = /^(?:[01nm][:.][1nm*]|[01]\.\.[1n*]|一对一|一对多|多对一|多对多|n[:.]m|m[:.]n)$/i;

// 末尾的 `\n?` 不是手滑：Python 的 `$` 也匹配"结尾换行之前"，JS 的不。
// 取值在这里已经 strip 过，实际到不了这一步 —— 但留着，免得哪天有人拿没 strip
// 的值来调，两边就在最不显眼的地方分叉了。
const IDENT_RE = /^[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)*\n?$/u;
// `\w` 在 Python 里包含中日韩，JS 的只有 [A-Za-z0-9_] —— 中文路径的接口列
// （/接口/采购/查询）会整列判丢，所以展开成 \p{L}\p{N}_。
const URLISH_RE =
  /^(https?:\/\/|\/)[\p{L}\p{N}_\-./{}:%]*\n?$|^[\p{L}\p{N}_\-]+(\/[\p{L}\p{N}_\-{}]+){2,}\n?$/u;

/** 一列平均长度超过这个值就当散文。低于它的长中文串仍可能是名称。 */
const PROSE_LEN = 30;

export interface ColumnViewDict {
  name: string;
  role: ColumnRole;
  fill: number;
  distinct_ratio: number;
  mean_len: number;
  samples: string[];
}

/** 一列的角色判定结果。 */
export class ColumnView {
  name: string;
  /** 可写：稀疏分组列的后处理和问卷判定都会就地改角色。 */
  role: ColumnRole;
  /** 非空率 */
  fill: number;
  distinctRatio: number;
  meanLen: number;
  samples: string[];
  /** 第一行填没填。合并单元格的分组列**一定**是从第一行开始的（第一组的组名
   * 写在表首），而一列漏填几格的普通列不会正好只有第一行有值。 */
  firstFilled: boolean;
  /** 非空取值的去重个数。分组列有几层嵌套时，靠它分辨粗细 ——
   * 「应用模块」4 个值、「业务对象」14 个值，后者才是宿主那一层。 */
  distinct: number;

  constructor(p: {
    name: string; role: ColumnRole; fill: number; distinctRatio: number;
    meanLen: number; samples?: string[]; firstFilled?: boolean; distinct?: number;
  }) {
    this.name = p.name;
    this.role = p.role;
    this.fill = p.fill;
    this.distinctRatio = p.distinctRatio;
    this.meanLen = p.meanLen;
    this.samples = [...(p.samples ?? [])];
    this.firstFilled = p.firstFilled ?? false;
    this.distinct = p.distinct ?? 0;
  }

  toDict(): ColumnViewDict {
    return {
      name: this.name, role: this.role, fill: pyRound(this.fill, 3),
      distinct_ratio: pyRound(this.distinctRatio, 3),
      mean_len: pyRound(this.meanLen, 1), samples: this.samples.slice(0, 3),
    };
  }
}

function roleOf(name: string, values: readonly string[]):
[ColumnRole, number, number, number] {
  const vals = values.map(pyStrip);
  const nonempty = vals.filter((v) => v !== "");
  const fill = vals.length ? nonempty.length / vals.length : 0.0;
  if (nonempty.length === 0) return [ColumnRole.EMPTY, fill, 0.0, 0.0];
  const distinct = new Set(nonempty).size;
  const dratio = distinct / nonempty.length;
  const meanLen = nonempty.reduce((s, v) => s + cpLen(v), 0) / nonempty.length;
  const lower = nonempty.map((v) => v.toLowerCase());

  const frac = (pred: (v: string) => boolean): number =>
    lower.filter(pred).length / lower.length;

  // 端点：取值像 URL / 多级路径
  if (frac((v) => URLISH_RE.test(v)) >= 0.6) {
    return [ColumnRole.ENDPOINT, fill, dratio, meanLen];
  }

  // 数据类型。**这一列判丢了，整张字段表就报废** —— row_unit 从 property 翻成
  // object，prompt 转而告诉模型"这一段没有字段列，因此没有属性可抽"，critic 还把
  // 零属性判成正确答案。所以这里放宽三处，但每一处都要求"取值确实像类型"：
  //
  //   1. 词干比对（normType 削掉「型/类型/类」）—— 「字符型」当「字符」；
  //   2. 阈值 0.6 → 0.5 —— 中英混填（一半 varchar(32) 一半「字符型」）是常态，
  //      原来两种写法各占一半时**两边都不过 0.6**，整列直接落空；
  //   3. 列名自称是类型列时降到 0.3 —— 客户有自己的类型词（「短文本」
  //      「自定义编码」），词表永远追不全；但"列名说是类型 + 取值又短又高度
  //      重复"这个组合很难误判成别的角色。
  const typeFrac = frac((v) => TYPE_WORDS.has(normType(v)));
  const namedType = TYPE_NAME_RE.test(name || "");
  const looksTypeish = meanLen <= 12 && dratio <= 0.5;      // 短、且高度重复
  if (typeFrac >= 0.5 || (namedType && looksTypeish && typeFrac >= 0.3)) {
    return [ColumnRole.DATATYPE, fill, dratio, meanLen];
  }

  // 布尔
  if (frac((v) => BOOL_WORDS.has(v)) >= 0.8 && distinct <= 4) {
    return [ColumnRole.REQUIRED, fill, dratio, meanLen];
  }

  // 基数：1:N / M:N / 一对多 …… 整列都是这样的取值，这张表就是**关系表**。
  // 必须判在 ENUM 之前 —— 基数取值又短又高度重复，落进短枚举分支之后
  // 「一行一条关系」这个信号就永远丢了（真实案发：40 行的关联关系表被判成
  // 实体登记表，39 条带基数的关系一条都没抽出来）。
  if (frac((v) => CARDINALITY_RE.test(v.replace(/：/g, ":").replace(/\s+/g, ""))) >= 0.6) {
    return [ColumnRole.CARDINALITY, fill, dratio, meanLen];
  }

  // 散文
  if (meanLen > PROSE_LEN) return [ColumnRole.PROSE, fill, dratio, meanLen];

  // 标识符：ASCII 代码风格且几乎不重复
  if (frac((v) => IDENT_RE.test(v)) >= 0.8) {
    return [dratio >= 0.7 ? ColumnRole.IDENTIFIER : ColumnRole.ENUM,
      fill, dratio, meanLen];
  }

  // 短枚举 / 分组 / 名称，靠重复率区分
  if (dratio <= 0.15 && meanLen <= 12) return [ColumnRole.ENUM, fill, dratio, meanLen];
  if (dratio <= 0.5) return [ColumnRole.GROUP, fill, dratio, meanLen];
  if (dratio >= 0.7 && meanLen <= PROSE_LEN) {
    return [ColumnRole.LABEL, fill, dratio, meanLen];
  }
  return [ColumnRole.UNKNOWN, fill, dratio, meanLen];
}

/** 按列取值判定角色。输入是若干行的 ``raw`` 字典。 */
export function classifyColumns(rows: readonly unknown[]): ColumnView[] {
  // Map 而不是普通对象：列序是判据的一部分，而 V8 会把纯数字键提到最前面。
  const cols = new Map<string, string[]>();
  for (const r of rows) {
    if (!isRow(r)) continue;
    for (const [k, v] of rowEntries(r)) {
      let bucket = cols.get(k);
      if (bucket === undefined) {
        bucket = [];
        cols.set(k, bucket);
      }
      bucket.push(v === null || v === undefined ? "" : pyStr(v));
    }
  }
  // 补齐长度，否则整列缺失的行会让 fill 虚高
  const n = rows.length;
  const out: ColumnView[] = [];
  for (const [name, raw] of cols) {
    const vals = raw.concat(new Array<string>(Math.max(0, n - raw.length)).fill(""));
    const [role, fill, dratio, mlen] = roleOf(name, vals);
    const samples = [...new Set(vals.filter((v) => pyStrip(v) !== ""))].slice(0, 5);
    out.push(new ColumnView({
      name, role, fill, distinctRatio: dratio, meanLen: mlen, samples,
      firstFilled: vals.length > 0 && pyStrip(vals[0]!) !== "",
      distinct: new Set(vals.filter((v) => pyStrip(v) !== "")).size,
    }));
  }

  // 稀疏分组列：整表别的列都填满，唯独这一列只在每组第一行写一次、下面留空
  // 继承。Excel 里最常见的写法。单看一列判不出来 —— 它的取值互不重复，看着
  // 就是个普通名称列；只有和"别的列是满的"放在一起才知道那些空是继承不是缺失。
  //
  // 判据是**第一行有值**，不是"填充率高于某个数"。填充率下界曾经写死 0.02，
  // 意思是"500 行里少于 10 个组就不算分组列" —— 这个数没有任何依据，而且
  // 表越长越容易把真的分组列判丢。合并单元格的结构特征是：第一组的组名写在
  // 表首，后面每组换一次。第一行空着的稀疏列则多半是真的漏填。
  const dense = out.some((c) => c.fill >= 0.9);
  if (dense) {
    for (const c of out) {
      if ((c.role === ColumnRole.LABEL || c.role === ColumnRole.UNKNOWN)
        && c.firstFilled && c.fill > 0 && c.fill <= 0.6
        && c.meanLen <= PROSE_LEN) {
        c.role = ColumnRole.GROUP;
      }
    }
  }
  return out;
}

// ── 问卷信号 ────────────────────────────────────────────────────
/** 疑问句判据。同样只看取值：列名可能叫「澄清问题」，也可能叫 col3 或
 * 「需求确认事项」，认列名换一份材料立刻塌。 */
const QMARK = /[?？]\s*$/u;
const INTERROGATIVE = ["是否", "哪些", "哪个", "什么", "如何", "怎么", "怎样", "多少",
  "为什么", "是不是", "有没有", "要不要", "能不能", "能否", "可否",
  "请说明", "请确认", "请补充", "吗"];

/** 选项标记：①②③ / (1) / 1. / A) 都算 */
const OPTION_MARK_SRC = "[①-⑳❶-❿]|[(（]\\s*\\p{Nd}+\\s*[)）]|" +
  "(?:^|[\\s；;、])\\p{Nd}+\\s*[.、)]|(?:^|[\\s；;、])[A-Za-z]\\s*[.、)]";
const OPTION_MARK = new RegExp(OPTION_MARK_SRC, "u");
const OPTION_MARK_G = new RegExp(OPTION_MARK_SRC, "gu");

/** 问卷里夹着的分组标题行、小计行会被误当成问题。低于这个长度一律不算。 */
const MIN_QUESTION_LEN = 6;

export function looksLikeQuestion(v: unknown): boolean {
  const t = pyStrip(pyStr(v));
  return QMARK.test(t) || INTERROGATIVE.some((w) => t.includes(w));
}

/** 把「① 全线下 ② 系统里编 ③ 线下编、系统里审」拆成三段。
 *
 * 拆分放在这里而不是模板侧 —— 拆出来的选项要进 OIR，模板只是消费方。
 * 拆不出两段以上就返回空：**宁可不拆，也不要把一句完整的话切碎**，
 * 切碎的选项发到业务人员手里比不给选项更糟。
 */
export function splitOptions(text: unknown): string[] {
  const t = pyStrip(pyTruthy(text) ? pyStr(text) : "");
  if (!t) return [];
  let parts: string[];
  const marks = [...t.matchAll(OPTION_MARK_G)];
  if (marks.length >= 2) {
    // 下标来自 JS 正则、也只喂给 JS 的 slice —— 两边都按 UTF-16 码元算，
    // 与 Python 那边按码点算的下标各自自洽，切出来的子串一样。
    const cuts = marks.map((m) => m.index).concat([t.length]);
    parts = [];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      parts.push(t.slice(cuts[i]!, cuts[i + 1]!));
    }
    parts = parts.map((x) => pyStripChars(x.replace(OPTION_MARK, ""), " 　;；、."));
  } else {
    parts = t.split(/[；;\n]/u).map(pyStrip);
  }
  parts = parts.filter((x) => x !== "");
  return parts.length >= 2 ? parts : [];
}

/** Python 的 `x or default`：0 / "" / None / 空容器都算假。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "bigint") return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  return true;
}

function questionFrac(values: readonly string[]): number {
  const vals = values.map((x) => pyStrip(pyStr(x))).filter((v) => v !== "");
  if (vals.length === 0) return 0.0;
  return vals.filter(looksLikeQuestion).length / vals.length;
}

/** 认出「待填问卷」，命中时就地改写列角色。
 *
 * 四个信号必须**同时**成立。单独任何一个都会误伤：
 *
 * 1. 有一列几乎整列空（``fill <= 0.05``）—— 待填的答复槽；
 * 2. 除它之外**至少两列填满**（``fill >= 0.9``）—— 这一条把"待填表单"和
 *    "某列碰巧没填"分开，单看一列判不出来；
 * 3. 有一列过半是问句，且不是一两个字的短词；
 * 4. 行数够（{@link inferShape} 已保证 >= 3）。
 *
 * 第 1 条必须读 {@link ColumnView.fill} 的**原始数值**而不是 role ——
 * {@link classifyColumns} 末尾的稀疏分组列后处理会把"部分填了答复"的列
 * 改判成 GROUP，那时候 role 已经不是 EMPTY 了。
 */
export function detectQuestionnaire(shape: SegmentShape, rows: readonly unknown[]): boolean {
  if (rows.length < 3) return false;
  const cols = shape.columns.filter((c) => c.name);
  if (cols.length < 3) return false;

  // 答复槽取**最右边**那一列 —— Excel 问卷的答复列总在最后
  const blanks = cols.filter((c) => c.fill <= 0.05);
  if (blanks.length === 0) return false;
  const answer = blanks[blanks.length - 1]!;

  const dense = cols.filter((c) => c !== answer && c.fill >= 0.9);
  if (dense.length < 2) return false;

  let qCol: ColumnView | null = null;
  for (const c of dense) {
    if (c.meanLen < 8) continue;  // 一个字的"是否"不算问题
    const vals = rows.filter(isRow).map((r) => rowStr(r, c.name));
    if (questionFrac(vals) >= 0.5) {
      qCol = c;
      break;
    }
  }
  if (qCol === null) return false;

  // 参考选项列：拆得出两段以上就算。问卷不一定有这一列，找不到也不影响判定。
  let oCol: ColumnView | null = null;
  for (const c of cols) {
    if (c === answer || c === qCol) continue;
    const vals = rows.filter(isRow).map((r) => rowStr(r, c.name));
    const hit = vals.filter((v) => splitOptions(v).length >= 2).length;
    if (vals.length > 0 && hit / vals.length >= 0.4) {
      oCol = c;
      break;
    }
  }

  qCol.role = ColumnRole.QUESTION;
  answer.role = ColumnRole.ANSWER_SLOT;
  if (oCol !== null) oCol.role = ColumnRole.OPTIONS;
  return true;
}

// ══════════════════════════════════════════════════════════════════
//  段形状
// ══════════════════════════════════════════════════════════════════

/** 一段材料能产出的东西。 */
export const Yield = {
  OBJECTS: "objects",
  PROPERTIES: "properties",
  ACTIONS: "actions",
  LINKS: "links",
  RULES: "rules",
  QUESTIONS: "questions",
} as const;
export type Yield = (typeof Yield)[keyof typeof Yield];

const YIELDS = new Set<string>(Object.values(Yield));

/** 对应 `Yield(v)`：认不出就抛。 */
export function parseYield(v: string): Yield {
  if (!YIELDS.has(v)) throw new Error(`未知的 Yield: ${v}`);
  return v as Yield;
}

/** 一行对应一个什么。null = 说不准。 */
export type RowUnit =
  "object" | "property" | "action" | "rule" | "question" | "link" | null;

export interface SegmentShapeDict {
  row_count: number;
  row_unit: RowUnit;
  yields: string[];
  rule_decidable: string[];
  columns: ColumnViewDict[];
  note: string;
}

/** 这一段是什么表、能出什么、其中哪些规则就能定。 */
export class SegmentShape {
  columns: ColumnView[];
  yields: Set<Yield>;
  /** yields 的子集：规则可以直接算出来，不需要模型 */
  ruleDecidable: Set<Yield>;
  rowCount: number;
  rowUnit: RowUnit;
  note: string;

  constructor(p: {
    columns?: ColumnView[]; yields?: Iterable<Yield>; ruleDecidable?: Iterable<Yield>;
    rowCount?: number; rowUnit?: RowUnit; note?: string;
  } = {}) {
    this.columns = [...(p.columns ?? [])];
    this.yields = new Set(p.yields ?? []);
    this.ruleDecidable = new Set(p.ruleDecidable ?? []);
    this.rowCount = p.rowCount ?? 0;
    this.rowUnit = p.rowUnit ?? null;
    this.note = p.note ?? "";
  }

  col(role: ColumnRole): ColumnView | null {
    return this.columns.find((c) => c.role === role) ?? null;
  }

  cols(role: ColumnRole): ColumnView[] {
    return this.columns.filter((c) => c.role === role);
  }

  expects(y: Yield): boolean {
    return this.yields.has(y);
  }

  /** 对应 `dataclasses.replace(shape, row_count=n)` —— 浅拷贝，列和集合
   * 仍是**同一批对象**（pipeline 的 _window_shape 就依赖这一点：整张表的
   * 判断沿用，只有行数是这一窗口自己的）。 */
  withRowCount(rowCount: number): SegmentShape {
    const s = new SegmentShape({ rowCount, rowUnit: this.rowUnit, note: this.note });
    s.columns = this.columns;
    s.yields = this.yields;
    s.ruleDecidable = this.ruleDecidable;
    return s;
  }

  /** 给模型看的一句话形状说明。 */
  describe(): string {
    const roles = this.columns
      .filter((c) => c.role !== ColumnRole.EMPTY)
      .map((c) => `${c.name}〔${c.role}〕`)
      .join("、");
    const unit: Record<string, string> = {
      object: "一个业务对象", property: "一个字段/属性",
      action: "一个行动（有接口）", rule: "一段业务规则",
      question: "一个待澄清的问题（不是实体）",
      link: "一条对象间的关系（源对象→目标对象+基数，不是实体）",
    };
    const u = unit[this.rowUnit ?? ""] ?? "不确定的单元";
    const ys = [...this.yields].sort().join("、") || "（不确定）";
    return `这一段有 ${this.rowCount} 行，**一行 = ${u}**。\n`
      + `列角色：${roles}\n`
      + `可产出：${ys}`
      + (this.note ? `\n${this.note}` : "");
  }

  toDict(): SegmentShapeDict {
    return {
      row_count: this.rowCount, row_unit: this.rowUnit,
      // 值全是 ASCII 小写，默认 sort（UTF-16 序）与 Python 的码点序一致。
      yields: [...this.yields].sort(),
      rule_decidable: [...this.ruleDecidable].sort(),
      columns: this.columns.map((c) => c.toDict()), note: this.note,
    };
  }
}

/** 由列角色推出段形状。
 *
 * 判定顺序刻意如此：**数据类型列的存在压过一切**。一张表只要有一列在填
 * varchar/int/日期，它就是字段表，一行是一个属性；没有类型列却有唯一标识符
 * 列，那就是登记表，一行是一个实体 —— 这时"零属性"是正确答案，不是漏抽。
 */
export function inferShape(rows: readonly unknown[]): SegmentShape {
  const shape = new SegmentShape({
    columns: classifyColumns(rows), rowCount: rows.length,
  });
  // 一两行立不起一个形状。列画像靠的是取值分布，样本太少时"唯一"和"重复"没有
  // 区别 —— 文档元数据那一行（作者/路径/修改时间）就会被判成一张实体登记表，
  // 然后 critic 追着它要对象，节点白白重试两轮。
  if (rows.length < 3) {
    shape.note = "样本太少（不足 3 行），不下形状判断。";
    return shape;
  }

  const hasType = shape.cols(ColumnRole.DATATYPE).length > 0;

  // 问卷判在数据类型列**之后** —— 本模块开篇立的规矩是"数据类型列的存在压过
  // 一切"，这里不能破例。一张字段表完全可能有一列空着的「备注」，加上一列写成
  // 问句式的「口径」说明（"是否必填？…"），四个信号全中；抢在类型列前面判，
  // 整张字段表的属性会一个不剩地丢掉 —— 比它要修的那个 bug 更糟。
  if (!hasType && detectQuestionnaire(shape, rows)) {
    shape.rowUnit = "question";
    shape.yields.add(Yield.QUESTIONS);
    shape.ruleDecidable.add(Yield.QUESTIONS);
    shape.note = "这是一份**待填问卷**：一列整列空着等人填，其余列都是满的，"
      + "还有一列是问句。每一行是**一个待澄清的问题，不是业务实体**。"
      + "已填答复的行是事实。**这一段没有对象、没有字段可抽。**";
    // 直接返回 —— 不走后面"散文兜底出 RULES"和"多标识符列出 LINKS"两条，
    // 问卷段不该顺带产出规则或关系。yields 里只有 QUESTIONS，下游 critic
    // 才不会追着它要对象。
    return shape;
  }

  const hasEndpoint = shape.cols(ColumnRole.ENDPOINT).length > 0;
  const ident = shape.col(ColumnRole.IDENTIFIER);
  const label = shape.col(ColumnRole.LABEL);
  const prose = shape.cols(ColumnRole.PROSE);
  const structural = shape.columns.filter(
    (c) => c.role !== ColumnRole.PROSE && c.role !== ColumnRole.EMPTY);

  // 关系表：有基数列 + 至少两根名称列。判在 hasType 之后 —— 「数据类型列的
  // 存在压过一切」是本模块开篇立的规矩；FK 规格表（字段/类型/基数）先算字段表。
  const cardCol = shape.col(ColumnRole.CARDINALITY);
  const [linkSrc, linkDst] = linkColumns(shape);

  if (hasType) {
    shape.rowUnit = "property";
    shape.yields.add(Yield.PROPERTIES);
    shape.yields.add(Yield.OBJECTS);
    shape.note = "有数据类型列 —— 每一行都是一个字段，必须抽成 PropertyType。";
    // **属性也能由规则定** —— 只要宿主列在。
    //
    // 以前这一支没有 rule_decidable，于是属性只有"模型"这一条通道：模型没抽、
    // 抽了名字对不上、或者形状被误判成实体表，最终都是零属性，而零属性又会被
    // critic 判成正确结果。一张列全了（字段名/类型/宿主）的表，每一行映射成
    // 哪个属性是完全确定的 —— 和实体表一样确定，没有理由花钱让模型再猜一遍。
    // 没有宿主列时不设：那时"这个字段挂在谁身上"确实要判断，交给模型。
    // 判据必须和 extractProperties 用的是**同一个** —— 两处各判一次，
    // 迟早会出现"开关开了但抽取选不出列"（或反过来）的静默空转。
    const [pf, ph] = propertyColumns(shape);
    if (pf !== null && ph !== null) shape.ruleDecidable.add(Yield.PROPERTIES);
  } else if (cardCol !== null && linkSrc !== null && linkDst !== null) {
    // 一列整列是 1:N / M:N，旁边还有两根名称列 —— 这是**关系表**，一行一条
    // 对象间关系。以前没有这个形状，它落进「实体登记表」：critic 追着它按行
    // 数要**对象**，40 行专门写关系的表产出零关系，还多出几十个假对象。
    // 源/目标/基数三列俱全时，每一行映射成哪条关系是完全确定的 —— 规则抽，
    // 不花模型的钱，也不给它漏行的机会。
    shape.rowUnit = "link";
    shape.yields.add(Yield.LINKS);
    shape.ruleDecidable.add(Yield.LINKS);
    shape.note = "有基数列（1:N / M:N）和两根对象名称列 —— 这是**关系表**，"
      + "一行是一条对象间关系，不是实体。**这段的产出是 links，一行一条；"
      + "两端对象在别的表里登记过，这里不要再抽对象。**";
  } else if (hasEndpoint && (ident || label)) {
    shape.rowUnit = "action";
    shape.yields.add(Yield.ACTIONS);
    shape.yields.add(Yield.OBJECTS);
    // 行动**能**由规则定，对象**不能**：行动表里那列编码是行动码
    // （createPbp / queryOpenPbpLine），不是实体码。真正的宿主对象写在一列
    // 重复出现的中文名里，得靠命名归一才能给出 apiName —— 那是模型的活。
    shape.ruleDecidable.add(Yield.ACTIONS);
    shape.note = "有接口列 —— 每一行是一个行动，编码列装的是**行动码**不是实体码；"
      + "宿主对象在重复出现的名称列里，需要按命名规范起 apiName。"
      + "这段没有字段可抽。";
  } else if (ident && ident.fill >= 0.6 && TCODE_NAME_RE.test(ident.name)) {
    // 标识符列自称是事务码/交易码 —— 这是**功能清单**（SAP 事务码、菜单、
    // 报表），一行是系统的一个功能入口，不是业务对象。真实案发：1414 行的
    // 事务码表被当实体登记表，critic 按行数逼着模型造出 900 个假对象
    // （displayName='15' 这种行号都进了 OIR）。功能入口是 Action 的素材；
    // 值得建模的那部分让模型挑，不做逐行覆盖压力。
    shape.rowUnit = "action";
    shape.yields.add(Yield.ACTIONS);
    shape.note = "标识符列是**事务码/功能代码** —— 这是功能清单，一行是一个"
      + "系统功能入口，**不是业务对象，不要一行造一个对象**。产出是 actions："
      + "挑出与业务域相关的功能抽成行动，宿主对象从功能描述里判断。";
  } else if (ident && ident.fill >= 0.6) {
    shape.rowUnit = "object";
    shape.yields.add(Yield.OBJECTS);
    shape.ruleDecidable.add(Yield.OBJECTS);
    shape.note = "有唯一标识符列但没有数据类型列 —— 这是**实体登记表**，"
      + "一行一个对象。**这段没有属性可抽，零属性是正确结果。**";
    const attrCol = attrListColumn(shape);
    if (attrCol !== null) {
      // 登记表带「关键属性」列：顿号/逗号分隔的字段清单，每个词是一个属性、
      // 宿主是本行对象 —— 映射完全确定，规则抽（真实案发：9 个主数据对象
      // 44 个关键属性全军覆没，因为这条通道不存在）。类型/口径留给模型补。
      shape.yields.add(Yield.PROPERTIES);
      shape.note = "有唯一标识符列但没有数据类型列 —— 这是**实体登记表**，"
        + `一行一个对象。「${attrCol.name}」列是分隔符隔开的**字段清单**：`
        + "每个词已由规则抽成本行对象的属性，你要补的是类型与口径。";
    }
  } else if (prose.length > 0 && prose.length >= Math.max(1, structural.length)) {
    shape.rowUnit = "rule";
    shape.yields.add(Yield.RULES);
    shape.note = "整段以长文本为主 —— 这里出的是业务规则/约束，不是实体清单。";
  } else if (label) {
    shape.rowUnit = "object";
    shape.yields.add(Yield.OBJECTS);
    shape.note = "只有名称列，没有编码也没有类型 —— 对象名要靠命名规范生成。";
    const attrCol = attrListColumn(shape);
    if (attrCol !== null) {
      // 「MD-01」这类带连字符的编号不过 IDENT_RE，主数据清单走的是这条名称
      // 分支 —— 关键属性列的通道两条分支都要有，缺这边就是 44 个关键属性
      // 全军覆没的那半个成因。
      shape.yields.add(Yield.PROPERTIES);
      shape.note = "只有名称列，没有编码也没有类型 —— 对象名要靠命名规范生成。"
        + `「${attrCol.name}」列是分隔符隔开的**字段清单**：每个词已由规则抽成`
        + "本行对象的属性（宿主用本行的中文名），你要补的是类型与口径。";
    }
  }

  // 散文列在任何形状下都可能藏规则
  if (prose.length > 0 && !shape.yields.has(Yield.RULES)) shape.yields.add(Yield.RULES);
  // 有多个标识符列，行间往往有引用关系
  if (shape.cols(ColumnRole.IDENTIFIER).length >= 2) shape.yields.add(Yield.LINKS);
  return shape;
}

// ══════════════════════════════════════════════════════════════════
//  规则抽取
// ══════════════════════════════════════════════════════════════════

export interface RuleObject {
  api_name: string;
  display_name: string;
  source_locator: string;
  _origin: "rule";
  module?: string;
  group?: string;
}

export interface RuleProperty {
  parent_api_name: string;
  api_name: string;
  display_name: string;
  base_type: string;
  definition: string;
  required: boolean;
  source_locator: string;
  _origin: "rule";
}

export interface RuleAction {
  api_name: string;
  display_name: string;
  object_display: string;
  module: string;
  endpoint: string;
  source_locator: string;
  _origin: "rule";
}

export interface RuleQuestion {
  text: string;
  options: string[];
  options_raw: string;
  answer: string;
  group: string;
  code: string;
  source_locator: string;
  _origin: "rule";
}

export interface ExtractOut {
  objects: RuleObject[];
  properties: RuleProperty[];
  links: Record<string, unknown>[];
  actions: RuleAction[];
  questions: RuleQuestion[];
}

/** 把规则能确定的行直接抽出来，一行都不丢。
 *
 * 只处理 ``shape.ruleDecidable`` 认可的形状 —— 也就是"一行一实体"和
 * "一行一行动"这两种映射完全确定的表。其余留给模型。
 *
 * @param rows 每行的 ``raw`` 字典，与 ``cites`` 一一对应。
 * @param cites 每行的出处串，直接进 provenance。
 * @param carryIn 本段第一行之前各列最后一个非空取值。一张表被切成多段时，
 *   后面几段的组首在上一段里 —— 没有它，那些行的分组列全是空的。
 */
export function structuralExtract(
  rows: readonly unknown[],
  cites: readonly string[],
  shape: SegmentShape,
  carryIn?: Readonly<Record<string, string>> | null,
): ExtractOut {
  const out: ExtractOut = {
    objects: [], properties: [], links: [], actions: [], questions: [],
  };
  const carryMap: Record<string, string> = { ...(carryIn ?? {}) };

  if (shape.ruleDecidable.has(Yield.QUESTIONS)) {
    extractQuestions(rows, cites, shape, out, carryMap);
    return out;
  }

  if (shape.ruleDecidable.has(Yield.PROPERTIES)) {
    extractProperties(rows, cites, shape, out, carryMap);
    return out;
  }

  if (shape.ruleDecidable.has(Yield.LINKS)) {
    extractLinks(rows, cites, shape, out);
    return out;
  }

  // 登记表带「关键属性」列时，属性抽取**不依赖**对象是否规则可判 ——
  // 主数据清单的编号是「MD-01」这种带连字符的样式，过不了 IDENT_RE，
  // 对象走模型；但每行的字段清单照样是确定映射，规则抽，宿主用本行中文名
  // （buildOir 按显示名解析宿主）。
  const attrColPre = shape.yields.has(Yield.PROPERTIES)
    && !shape.ruleDecidable.has(Yield.PROPERTIES) ? attrListColumn(shape) : null;
  if (attrColPre !== null) {
    extractAttrListProperties(rows, cites, shape, out, attrColPre);
  }

  if (!shape.ruleDecidable.has(Yield.OBJECTS)
    && !shape.ruleDecidable.has(Yield.ACTIONS)) {
    return out;
  }

  const ident = shape.col(ColumnRole.IDENTIFIER);
  const endpoint = shape.col(ColumnRole.ENDPOINT);
  // 模块用满填充的枚举列；宿主对象用稀疏分组列（要向下继承）
  let module = shape.cols(ColumnRole.ENUM).find((c) => c.fill >= 0.9) ?? null;
  const host = hostColumn(shape);
  if (module === null && host !== null) {
    // 分组常有两层（应用模块 > 业务对象）。细的那层是宿主，粗的那层是模块 ——
    // 以前粗的那层直接被丢掉，材料里明明写着的归属信息就此消失。
    module = shape.cols(ColumnRole.GROUP)
      .find((c) => c !== host && c.fill < 0.9) ?? null;
  }
  const labels = shape.cols(ColumnRole.LABEL).filter((c) => c.fill >= 0.5);
  const label = maxBy(labels, (c) => [c.fill]);
  if (ident === null && label === null) return out;

  // 分组列的继承值。**从上一段接过来** —— 组首可能落在别的段里。
  let carry = host ? (carryMap[host.name] ?? "") : "";
  let modCarry = module ? (carryMap[module.name] ?? "") : "";

  const seen = new Set<string>();
  const n = Math.min(rows.length, cites.length);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const cite = cites[i]!;
    if (!isRow(row)) continue;
    const api = ident ? pyStrip(rowStr(row, ident.name)) : "";
    const disp = label ? pyStrip(rowStr(row, label.name)) : "";
    if (host) {  // 空 = 继承上一组，不是缺失
      carry = pyStrip(rowStr(row, host.name)) || carry;
    }
    if (module) {
      modCarry = pyStrip(rowStr(row, module.name)) || modCarry;
    }
    if (!api && !disp) continue;
    const key = api || disp;
    if (shape.ruleDecidable.has(Yield.OBJECTS) && !seen.has(key)) {
      seen.add(key);
      const obj: RuleObject = {
        api_name: api || disp, display_name: disp || api,
        source_locator: cite, _origin: "rule",
      };
      if (modCarry) obj.module = modCarry;
      if (carry) obj.group = carry;
      out.objects.push(obj);
    }
    if (endpoint && shape.ruleDecidable.has(Yield.ACTIONS)) {
      const url = pyStrip(rowStr(row, endpoint.name));
      if (!url) continue;
      const owner = carry;
      out.actions.push({
        // 编码列已经是行动码就直接用；只有没有编码列时才从路径反推
        api_name: api || actionName(url, owner || disp),
        display_name: disp || api,
        // 宿主写中文名，apiName 由下游命名归一/实体对齐解析
        object_display: owner, module: modCarry, endpoint: url,
        source_locator: cite, _origin: "rule",
      });
    }
  }
  return out;
}

/** 类型词干 → OIR 的 BaseType。词干由 {@link normType} 削好（「字符型」→「字符」）。 */
const BASE_TYPE: Record<string, string> = {
  varchar: "STRING", nvarchar: "STRING", varchar2: "STRING",
  nvarchar2: "STRING", char: "STRING", text: "STRING", clob: "STRING",
  string: "STRING", str: "STRING", uuid: "STRING", json: "STRING",
  jsonb: "STRING", 字符: "STRING", 字符串: "STRING", 文本: "STRING",
  长文本: "STRING", 大文本: "STRING", 备注: "STRING",
  int: "INTEGER", integer: "INTEGER", bigint: "INTEGER",
  smallint: "INTEGER", tinyint: "INTEGER", long: "INTEGER",
  short: "INTEGER", serial: "INTEGER", int2: "INTEGER",
  int4: "INTEGER", int8: "INTEGER", 整数: "INTEGER", 整型: "INTEGER",
  decimal: "DECIMAL", numeric: "DECIMAL", number: "DECIMAL",
  double: "DECIMAL", float: "DECIMAL", real: "DECIMAL",
  money: "DECIMAL", 数值: "DECIMAL", 数字: "DECIMAL", 小数: "DECIMAL",
  浮点: "DECIMAL", 货币: "DECIMAL", 金额: "DECIMAL", 百分比: "DECIMAL",
  单精度: "DECIMAL", 双精度: "DECIMAL",
  date: "DATE", 日期: "DATE", 年月日: "DATE",
  datetime: "TIMESTAMP", datetime2: "TIMESTAMP", timestamp: "TIMESTAMP",
  time: "TIMESTAMP", 时间: "TIMESTAMP", 时间戳: "TIMESTAMP",
  bool: "BOOLEAN", boolean: "BOOLEAN", bit: "BOOLEAN",
  布尔: "BOOLEAN", 逻辑: "BOOLEAN",
  枚举: "ENUM", 字典: "ENUM",
};

/** 材料里写的类型 → BaseType 名。认不出就 STRING（保守，不猜）。 */
export function baseTypeOf(raw: unknown): string {
  // hasOwnProperty 不是洁癖：词干直接来自材料，一列填着「constructor」的表
  // 能从 Object.prototype 上摸到一个函数，dict.get 在 Python 里没有这一层。
  const stem = normType(pyTruthy(raw) ? pyStr(raw) : "");
  return Object.prototype.hasOwnProperty.call(BASE_TYPE, stem)
    ? BASE_TYPE[stem]! : "STRING";
}

/** 关系表里可能装对象名的列角色。IDENTIFIER 也算 —— 编码化的对象名（ASCII
 * camelCase）在两端列里同样合法。 */
const LINK_NAMEISH = new Set<ColumnRole>([
  ColumnRole.LABEL, ColumnRole.GROUP, ColumnRole.ENUM,
  ColumnRole.IDENTIFIER, ColumnRole.UNKNOWN,
]);
const LINK_SRC_RE = /(源|from|上游|左)/iu;
const LINK_DST_RE = /(目标|target|to|下游|被|右)/iu;

/** 标识符列自称事务码/交易码 —— 功能清单（不是实体登记表）的判据。 */
const TCODE_NAME_RE = /(事务码|事务代码|交易码|交易代码|t[-_]?code|功能代码)/iu;

/** 实体登记表里的「关键属性」列：分隔符隔开的字段清单。
 * 只按列名认 —— 取值判据（长文本、含顿号）会把「L4逻辑数据实体」这类
 * 同样是顿号清单、但装的是**实体名**的列误收进来。 */
const ATTR_LIST_NAME_RE = /(关键|主要|核心)属性|属性清单|属性列表|字段清单|关键字段/u;

export function attrListColumn(shape: SegmentShape): ColumnView | null {
  return shape.columns.find((c) =>
    ATTR_LIST_NAME_RE.test(c.name)
    && (c.role === ColumnRole.PROSE || c.role === ColumnRole.UNKNOWN
      || c.role === ColumnRole.LABEL)
    && c.fill >= 0.5) ?? null;
}

/** 登记表「关键属性」列的宿主列：优先列名点名（对象/名称/实体），
 * 其次编码列，最后第一根名称样的列。 */
const ATTR_HOST_NAME_RE = /(对象|名称|实体)/u;

function attrHostColumn(shape: SegmentShape, attrCol: ColumnView): ColumnView | null {
  const cand = shape.columns.filter((c) =>
    c !== attrCol && LINK_NAMEISH.has(c.role) && c.fill >= 0.5);
  return cand.find((c) => ATTR_HOST_NAME_RE.test(c.name))
    ?? cand.find((c) => c.role === ColumnRole.IDENTIFIER)
    ?? cand[0] ?? null;
}

/** 登记表的「关键属性」列逐行拆词成属性，宿主用本行的名称格。
 * base_type 给 STRING —— 那是 buildOir 对缺席类型的既有缺省，不是这里新编的；
 * 口径（definition）留空，由模型补（outstanding() 会为此继续索要 PROPERTIES）。 */
function extractAttrListProperties(
  rows: readonly unknown[],
  cites: readonly string[],
  shape: SegmentShape,
  out: ExtractOut,
  attrCol: ColumnView,
): void {
  const host = attrHostColumn(shape, attrCol);
  if (host === null) return;
  const n = Math.min(rows.length, cites.length);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    if (!isRow(row)) continue;
    const parent = pyStrip(rowStr(row, host.name));
    if (!parent) continue;
    const seen = new Set<string>();
    for (const tok of pyStrip(rowStr(row, attrCol.name)).split(/[、，,;；/｜|]/u)) {
      const name = pyStrip(tok);
      if (!name || cpLen(name) > 24 || seen.has(name)) continue;
      seen.add(name);
      out.properties.push({
        parent_api_name: parent, api_name: name, display_name: name,
        base_type: "STRING", definition: "", required: false,
        source_locator: cites[i]!, _origin: "rule",
      });
    }
  }
}

/** 关系表里哪一列是**源对象**、哪一列是**目标对象**。
 *
 * 先按列名认（源/from/上游 vs 目标/to/下游）；两根都认出来才按名字配对。
 * 认不全就按列序取前两根名称列 —— 中文关系表的书写习惯是源在左、目标在右，
 * 只认出一半时按名字配对反而容易错位。
 * inferShape 判 ruleDecidable 和 extractLinks 选列用的是**同一个**判据 ——
 * 两处各判一次，迟早出现「开关开了但抽取选不出列」的静默空转。 */
export function linkColumns(shape: SegmentShape): [ColumnView | null, ColumnView | null] {
  const names = shape.columns.filter((c) => LINK_NAMEISH.has(c.role) && c.fill >= 0.6);
  if (names.length < 2) return [null, null];
  const src = names.find((c) => LINK_SRC_RE.test(c.name)) ?? null;
  const dst = names.find((c) => c !== src && LINK_DST_RE.test(c.name)) ?? null;
  if (src !== null && dst !== null) return [src, dst];
  return [names[0]!, names[1]!];
}

/** 材料里写的基数 → OIR 的 Cardinality 名。认不出就不给 —— 编一个基数比
 * 留空更难发现（buildOir 对缺席基数有自己的缺省语义）。 */
const CARD_MAP: Record<string, string> = {
  "1:1": "ONE_TO_ONE", "一对一": "ONE_TO_ONE",
  "1:n": "ONE_TO_MANY", "1:m": "ONE_TO_MANY", "一对多": "ONE_TO_MANY", "1..*": "ONE_TO_MANY",
  // 真实材料两种写法并存：「N:1」和「M:1」是同一个意思（监造计划 M:1 采购合同）
  "n:1": "MANY_TO_ONE", "m:1": "MANY_TO_ONE", "多对一": "MANY_TO_ONE",
  "m:n": "MANY_TO_MANY", "n:m": "MANY_TO_MANY", "多对多": "MANY_TO_MANY",
};

/** 关系表逐行抽 links。一行 = 一条 (源对象, 目标对象, 基数)。 */
function extractLinks(
  rows: readonly unknown[],
  cites: readonly string[],
  shape: SegmentShape,
  out: ExtractOut,
): void {
  const [src, dst] = linkColumns(shape);
  const cardCol = shape.col(ColumnRole.CARDINALITY);
  if (src === null || dst === null) return;
  const seen = new Set<string>();
  const n = Math.min(rows.length, cites.length);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    if (!isRow(row)) continue;
    const a = pyStrip(rowStr(row, src.name));
    const b = pyStrip(rowStr(row, dst.name));
    if (!a || !b) continue;
    const api = `${a}_${b}`;
    if (seen.has(api)) continue; // 同一对出现两次：保留先出现的那行
    seen.add(api);
    const rawCard = cardCol !== null
      ? pyStrip(rowStr(row, cardCol.name)).replace(/：/g, ":").replace(/\s+/g, "").toLowerCase()
      : "";
    const card = CARD_MAP[rawCard];
    out.links.push({
      api_name: api,
      from_api_name: a,
      to_api_name: b,
      ...(card !== undefined ? { cardinality: card } : {}),
      source_locator: cites[i]!,
      _origin: "rule",
    });
  }
}

/** 宿主列的取值是对象名，不会很长。超过这个长度的列是口径/说明，不是宿主。 */
const HOST_MAX_LEN = 24;

/** 字段表里哪一列是**字段名**、哪一列是**宿主对象**。
 *
 * 通用的 ``shape.col(IDENTIFIER)`` / {@link hostColumn} 在这里都会挑错：
 *
 * * 合并单元格的字段表里，「所属对象」只在组首写一次，稀疏得像个标识符列 ——
 *   ``col(IDENTIFIER)`` 取**第一个**，于是把宿主当成了字段名；
 * * {@link hostColumn} 在分组列里按 distinct **最多**的挑，而字段表里那个"分组列"
 *   往往是稀疏的「口径说明」（几条长文本），比真正的宿主列 distinct 还多。
 *
 * 这里的判据直接来自字段表的形状：**字段名几乎不重复，宿主大量重复**。
 */
function propertyColumns(shape: SegmentShape): [ColumnView | null, ColumnView | null] {
  const cand = shape.columns.filter(
    (c) => (c.role === ColumnRole.IDENTIFIER || c.role === ColumnRole.ENUM
      || c.role === ColumnRole.GROUP) && c.distinct >= 1);
  if (cand.length === 0) return [null, null];
  // 字段名：去重率最高的那列（一行一个字段，几乎不重样）
  const field = maxBy(cand, (c) => [c.distinctRatio, c.fill])!;
  // 宿主：**重复**的那列 —— distinct 少、取值短、且不是字段名本身
  const hosts = cand.filter(
    (c) => c !== field && c.meanLen <= HOST_MAX_LEN
      && c.distinct >= 1 && c.distinct < Math.max(2, field.distinct));
  if (hosts.length === 0) return [field, null];
  // 同样重复度时优先组首就填了的（合并单元格的分组列一定从第一行开始）
  const host = minBy(hosts, (c) => [c.distinct, c.firstFilled ? 0 : 1])!;
  return [field, host];
}

/** 字段表逐行抽成属性，一行不丢。
 *
 * 宿主从分组列继承（合并单元格只在组首写一次），所以要带 carryIn —— 一张表
 * 被切成多段时，后面几段的组名在上一段里。宿主一并登记成对象：属性挂不上父
 * 对象就会在装配时被丢掉，而那正是"模型抽到了、产物里却没有"的由来。
 */
function extractProperties(
  rows: readonly unknown[], cites: readonly string[], shape: SegmentShape,
  out: ExtractOut, carryIn: Readonly<Record<string, string>>,
): void {
  const [ident, host] = propertyColumns(shape);
  const dtype = shape.col(ColumnRole.DATATYPE);
  const req = shape.col(ColumnRole.REQUIRED);
  const labels = shape.cols(ColumnRole.LABEL).filter((c) => c.fill >= 0.5);
  const label = maxBy(labels, (c) => [c.fill]);
  if (ident === null || host === null) return;
  // 口径列：**不能只认 PROSE**。稀疏的口径列（只有几行写了"含税口径"）取值一少
  // 就会被判成 GROUP —— 而口径是字段表里最值钱的东西（"金额含不含税""按自然月
  // 还是按账期"），漏掉它等于把这张表最难问出来的部分丢了。凡是没被占用、
  // 又比标签长的列都算候选。
  const used = new Set<ColumnView>(
    [ident, host, dtype, req, label].filter((x): x is ColumnView => x !== null));
  // Python 的 sorted 是稳定排序，Array.sort 自 ES2019 起也是 —— 同长度的列
  // 保持原列序，选中的"口径"才不会跟着引擎晃。
  const notes = shape.columns
    .filter((c) => !used.has(c) && c.role !== ColumnRole.EMPTY && c.meanLen >= 2)
    .sort((a, b) => b.meanLen - a.meanLen);   // 最长的那列最可能是口径，短的当兜底

  let carry = carryIn[host.name] ?? "";
  const seenObj = new Set<string>();
  const seenProp = new Set<string>();
  const n = Math.min(rows.length, cites.length);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const cite = cites[i]!;
    if (!isRow(row)) continue;
    carry = pyStrip(rowStr(row, host.name)) || carry;
    const api = pyStrip(rowStr(row, ident.name));
    if (!api || !carry) continue;
    if (!seenObj.has(carry)) {
      seenObj.add(carry);
      out.objects.push({
        api_name: carry, display_name: carry, source_locator: cite, _origin: "rule",
      });
    }
    // 元组键要能无歧义还原 —— 拿分隔符拼串的话，("a b","c") 与 ("a","b c")
    // 会撞成同一个键，第二个字段被静默丢掉。
    const key = JSON.stringify([carry, api]);
    if (seenProp.has(key)) continue;
    seenProp.add(key);
    const disp = label ? pyStrip(rowStr(row, label.name)) : "";
    // 口径写在散文列里（"含税口径""按自然月"）—— 那是这个字段最值钱的部分
    let definition = "";
    for (const c of notes) {
      const v = pyStrip(rowStr(row, c.name));
      if (v) {
        definition = v;
        break;
      }
    }
    out.properties.push({
      parent_api_name: carry,
      api_name: api,
      display_name: disp || api,
      base_type: dtype ? baseTypeOf(rawGet(row, dtype.name)) : "STRING",
      definition,
      required: req ? TRUE_WORDS.has(pyStrip(rowStr(row, req.name))) : false,
      source_locator: cite, _origin: "rule",
    });
  }
}

/** `row.get(k)`（没有默认值）—— base_type_of 那一处要的是原值不是串。 */
function rawGet(r: Row, key: string): unknown {
  const v = r instanceof Map ? r.get(key) : (r as Record<string, unknown>)[key];
  return v === undefined ? null : v;
}

/** 「是否必填」里算真的取值。 */
const TRUE_WORDS = new Set(["是", "y", "Y", "yes", "YES", "true", "TRUE", "1",
  "必填", "√", "✓"]);

/** 哪一列写的是宿主业务对象。
 *
 * 分组常有两层：「应用模块」（4 个取值）套着「业务对象」（14 个取值）。
 * 宿主是**细的那一层** —— 取值越多，分得越细。取值一样多时取靠右的那列，
 * 因为表格是从粗到细往右排的。
 */
function hostColumn(shape: SegmentShape): ColumnView | null {
  const groups = shape.cols(ColumnRole.GROUP).filter((c) => c.fill < 0.9);
  if (groups.length === 0) return null;
  const order = new Map<ColumnView, number>(shape.columns.map((c, i) => [c, i]));
  return maxBy(groups, (c) => [c.distinct, order.get(c) ?? 0]);
}

const VERB_HINTS: [string, string][] = [
  ["create", "create"], ["add", "create"], ["save", "create"], ["insert", "create"],
  ["new", "create"], ["submit", "submit"], ["update", "update"], ["edit", "update"],
  ["modify", "update"], ["delete", "delete"], ["remove", "delete"],
  ["approve", "approve"], ["audit", "approve"], ["confirm", "approve"],
  ["cancel", "cancel"], ["close", "close"], ["import", "import"], ["export", "export"],
  ["sync", "sync"], ["push", "sync"],
];

/** 从接口路径反推行动名。取路径里最靠后的动词段，取不到就用 manage。 */
function actionName(url: string, objKey: string): string {
  const parts = url.split(/[/?#]/u).filter((p) => p && !p.startsWith("{"));
  let verb = "";
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const low = parts[i]!.toLowerCase().replace(/[^a-z]/gu, "");
    for (const [hint, canon] of VERB_HINTS) {
      if (low.startsWith(hint) || low.endsWith(hint)) {
        verb = canon;
        break;
      }
    }
    if (verb) break;
  }
  // `objKey[:1].upper() + objKey[1:]` —— 按码点切，别把代理对劈成两半
  const cps = [...objKey];
  const head = cps.length > 0
    ? cps[0]!.toUpperCase() + cps.slice(1).join("")
    : "Object";
  return `${verb || "manage"}${head}`;
}

/** 问卷 → 待澄清问题。一行一问，映射完全确定，不进模型。
 *
 * 让模型复述 150 行问题既会截断丢行，又要为零信息量的复制付 Opus 的钱 ——
 * 和实体登记表上的结论一模一样。
 */
function extractQuestions(
  rows: readonly unknown[], cites: readonly string[], shape: SegmentShape,
  out: ExtractOut, carryIn: Readonly<Record<string, string>> | null = null,
): void {
  const qCol = shape.col(ColumnRole.QUESTION);
  const aCol = shape.col(ColumnRole.ANSWER_SLOT);
  const oCol = shape.col(ColumnRole.OPTIONS);
  const grp = [...shape.cols(ColumnRole.GROUP), ...shape.cols(ColumnRole.ENUM)][0] ?? null;
  const code = shape.cols(ColumnRole.LABEL).find((c) => c.meanLen <= 8) ?? null;
  if (qCol === null) return;

  let carry = grp ? ((carryIn ?? {})[grp.name] ?? "") : "";
  const n = Math.min(rows.length, cites.length);
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const cite = cites[i]!;
    if (!isRow(row)) continue;
    const text = pyStrip(rowStr(row, qCol.name));
    if (grp) {  // 「节点」列同样是每组只写一次
      carry = pyStrip(rowStr(row, grp.name)) || carry;
    }
    if (cpLen(text) < MIN_QUESTION_LEN) continue;  // 分组标题行、小计行
    const rawOpts = oCol ? pyStrip(rowStr(row, oCol.name)) : "";
    out.questions.push({
      text,
      options: splitOptions(rawOpts),
      options_raw: rawOpts,
      answer: aCol ? pyStrip(rowStr(row, aCol.name)) : "",
      group: carry,
      code: code ? pyStrip(rowStr(row, code.name)) : "",
      source_locator: cite, _origin: "rule",
    });
  }
}
