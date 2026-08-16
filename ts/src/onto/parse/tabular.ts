/**
 * 表格解析 —— xlsx / csv。移植自 `src/ontocopilot/onto/parse/tabular.py`。
 *
 * 真实梳理表不长成规整的二维数组。这个解析器处理的都是实际会遇到的情况：
 *
 * * **表头不在第一行。** 前面往往有标题、说明、空行。靠启发式定位表头行而不是
 *   假设它在第 1 行。
 * * **合并单元格伪装成分组。** 合并区只有左上角有值，直接读会得到一堆空格。
 *   向下/向右填充还原成真实的行列结构。
 * * **口径藏在批注里。** 单元格批注常常是最关键的信息（"这里指含税"），必须抽出来。
 * * **元数据里有客户名。** Office 文件在 `workbook.xml` 里保存绝对路径、在
 *   `docProps/core.xml` 里保存作者。这既是理解材料来源的线索，也是对外发布前
 *   必须清理的泄漏点。
 *
 * 列画像（唯一率、空值率、推断类型）由**确定性统计**产出，不交给模型 ——
 * LLM 无法可靠发现需要跨行分布理解的问题（arXiv:2503.06664）。
 *
 * ─────────────────────────────────────────────────────────────────
 * ## 为什么 xlsx 是自己读的（不用 exceljs / sheetjs）
 *
 * 这一层的产物是下游形状推断的**输入**：单元格的文本一旦和 Python 差一个字节，
 * 列画像、问题清单、流程图就全跟着偏。而两个现成库都在同一个地方失真：
 * 它们把数字单元格解成 JS `number`，**原始文本被丢掉**。openpyxl 不是这么做的 ——
 * 它按 `<v>` 的文本里有没有 `.` / `E`/`e` 决定给 `int` 还是 `float`
 * （`_reader._cast_number`），于是 `<v>1.0</v>` 在 Python 侧是 `str()` = `"1.0"`，
 * 在任何"先转成 number"的库里都只能是 `"1"`。同理 `<v>12345678901234567890</v>`
 * 在 Python 侧是精确的大整数，转成 double 就掉精度。
 *
 * 所以这里直接读 zip + 扫 sheet XML，**保留 `<v>` 的原文**，按 openpyxl 的判据
 * 决定 int / float / 日期 / 时长，再按 Python 的 `str()` 规则出字符串。
 * 被这个选择护住的四件事（也是 golden `tabular.hard.xlsx` 里逐条钉住的）：
 *
 *   1. **合并单元格**：openpyxl 读完 cell 之后会把合并区里**除左上角以外**的格子
 *      统统换成 `MergedCell`（值 None），哪怕 XML 里原本写着值。这些格子还会
 *      进 `_cells`，因而**撑大 max_row / max_col**。
 *   2. **空行**：`iter_rows()` 是按 `1..max_row × 1..max_col` 的整块矩形发的
 *      （openpyxl ≥3.1 的 `min_row/min_col` 参数缺省就是 1，**不是**首个有值的行/列），
 *      所以前导空行会原样出现在 grid 里；末尾空行由 `_read_sheet` 自己弹掉。
 *      只有样式没有值的 `<c s="6"/>` 同样进 `_cells`，同样撑大 max_col。
 *   3. **日期序列号**：转不转日期只看这个格子的 `s=` 指向的 cellXf 的数字格式
 *      （`is_date_format`），与值本身无关。`0 <= v < 1` 给 `time`、
 *      `[h]:mm:ss` 这类格式给 `timedelta`、其余给 `datetime`；1900 闰年 bug
 *      的 `+1` 修正照抄。
 *   4. **公式缓存值**：`data_only=True` 读的是 `<v>`，`<f>` 直接忽略；
 *      `t="str"`（公式的字符串结果）与 `t="e"`（错误值）都原样当字符串。
 *      `<v></v>` 是 `findtext(...) or None` → **None**，不是空串。
 *
 * 批注也是自己读的：openpyxl 把批注挂到 `ws[ref]` 上，这个下标操作会**新建单元格**，
 * 因而落在空白处的批注同样撑大 max_col（golden 里 D6 那条就是干这个的）。
 * 批注文本取 `Text.content` —— 只拼 `<t>` 与 `<r>/<t>`，**丢掉 `<rPh>` 拼音段**，
 * 而 sheetjs/exceljs 的默认行为会把拼音也拼进去。
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { inflateRawSync } from "node:zlib";

import { formatFixed0 } from "../../kernel/errors.js";
// pyRound 是 Python `round(x, nd)` 的移植（二进制精确值上的 half-even）。
// shape.ts 已经落地并被 golden 钉住，**不在这里另起一份**。
import { pyRound } from "../shape.js";
import type { Finding, ParsedDoc } from "./base.js";
// cpLen / cpSlice / readTextGuess 都是 base.ts 明说"解析层共用、别再复制"的原语。
import {
  Parser, cpLen, cpSlice, makeChunk, makeFinding, makeParsedDoc, readTextGuess,
} from "./base.js";

/** 表头探测的扫描深度。再深就不是表头了，是数据。 */
export const HEADER_SCAN_ROWS = 12;
/** 一行要被当成表头，非空单元格至少要占这个比例。 */
export const HEADER_FILL_RATIO = 0.5;

// ══════════════════════════════════════════════════════════════════
//  Python 原语的对齐层
// ══════════════════════════════════════════════════════════════════

/** Python str 的空白集：比 JS 的 `\s` 多 \x1c-\x1f 与 \x85，**少 ﻿**。 */
const PY_SPACE =
  "\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680" +
  "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

/** `str.strip()`。**不能**用 `trim()`：BOM 开头的单元格在 Python 里是有值的，
 * trim 会把它削成空串，整列的 fill / null_rate 跟着塌 —— 而那是所有判据的地基。 */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/**
 * `str.splitlines()`。**不能**用 `split(/\r?\n/)`：Python 还在 \v \f \x1c-\x1e
 * \x85     上断行，而 CSV 正文里 \x1c-\x1e（信息分隔符）真的会出现在
 * 某些导出工具的产物里。另外 `"".splitlines()` 是 `[]` 而 `"".split()` 是 `[""]`。
 */
export function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const c = ch.charCodeAt(0);
    const isBreak =
      c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x1c ||
      c === 0x1d || c === 0x1e || c === 0x85 || c === 0x2028 || c === 0x2029;
    if (!isBreak) {
      cur += ch;
      continue;
    }
    out.push(cur);
    cur = "";
    if (c === 0x0d && s[i + 1] === "\n") i++; // \r\n 算一个断点
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Python `repr(float)` / `str(float)`。
 *
 * 三处和 JS `String(x)` 不一样，每一处都会落到单元格文本上：
 *   · 整数值的 float：Python `1.0`，JS `"1"`；
 *   · 转指数记号的阈值：Python 是 `decpt <= -4 || decpt > 16`
 *     （`1e15` → `"1000000000000000.0"`、`1e16` → `"1e+16"`），JS 是 1e21 / 1e-7；
 *   · 指数的写法：Python `e-05`（带符号、至少两位），JS `e-5`。
 *
 * 有效数字用 `toExponential()`（不带参数时按规范给的就是**能唯一确定该 double 的
 * 最短位数**），与 CPython 的 dtoa mode 0 同解。
 */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  if (a === 0) return neg ? "-0.0" : "0.0";

  const [mant = "", ex = "0"] = a.toExponential().split("e");
  const digits = mant.replace(".", "");
  const decpt = Number(ex) + 1; // 值 = 0.<digits> × 10^decpt

  let body: string;
  if (decpt <= -4 || decpt > 16) {
    const head = digits.length > 1 ? `${digits[0]!}.${digits.slice(1)}` : digits;
    const e = decpt - 1;
    const sign = e < 0 ? "-" : "+";
    body = `${head}e${sign}${String(Math.abs(e)).padStart(2, "0")}`;
  } else if (decpt <= 0) {
    body = `0.${"0".repeat(-decpt)}${digits}`;
  } else if (decpt >= digits.length) {
    body = `${digits}${"0".repeat(decpt - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return neg ? `-${body}` : body;
}

/**
 * Python `format(x, ".0%")` —— 先乘 100 再按 `.0f` 舍入（half-even），最后补 `%`。
 *
 * **不能**用 `Math.round(x*100)` 或 `toFixed(0)`：两者在平局时一律向上，而
 * 列画像的比率天生爱落在 1/8、1/16 这种精确二进制值上（`distinct_ratio = 1/8`
 * → 12.5% → Python 给 12%，toFixed 给 13%）。这个百分比进的是 schema 切片的
 * render，也就是模型看到的那段文本。
 */
export function pyPct(x: number): string {
  return `${formatFixed0(x * 100)}%`;
}

// ══════════════════════════════════════════════════════════════════
//  列画像
// ══════════════════════════════════════════════════════════════════
// Python 的 `\d` 认 Unicode Nd（含全角 `１２３`），JS 的 `\d` 只认 ASCII ——
// 全角数字的编码列在国产系统导出的材料里并不罕见，判据必须跟 Python 一致，
// 所以一律换成 `\p{Nd}`。Python 无 MULTILINE 时的 `$` 还能匹配"末尾换行之前"，
// 对应 JS 的 `\n?$`（这里的取值都 strip 过，留着只是为了逐条对齐、不留暗坑）。
const INT_RE = /^-?\p{Nd}+\n?$/u;
const DEC_RE = /^-?\p{Nd}+\.\p{Nd}+\n?$/u;
const DATE_RE = /^\p{Nd}{4}[-/]\p{Nd}{1,2}[-/]\p{Nd}{1,2}/u;
const BOOL_SET = new Set(["是", "否", "true", "false", "y", "n", "yes", "no"]);

/** 按实际取值推断类型。全空返回 STRING。 */
export function inferType(values: readonly string[]): string {
  const vals: string[] = [];
  for (const v of values) {
    if (!v) continue; // Python 的 `if v` —— 空串是假值
    const s = pyStrip(v);
    if (s) vals.push(s);
  }
  if (vals.length === 0) return "STRING";
  if (vals.every((v) => INT_RE.test(v))) return "INTEGER";
  if (vals.every((v) => INT_RE.test(v) || DEC_RE.test(v))) return "DECIMAL";
  if (vals.every((v) => DATE_RE.test(v))) return "DATE";
  if (vals.every((v) => BOOL_SET.has(v.toLowerCase()))) return "BOOLEAN";
  // 取值集合小且重复率高 → 枚举
  const distinct = new Set(vals).size;
  if (distinct <= Math.max(2, Math.floor(vals.length / 8)) && vals.length >= 8) {
    return "ENUM";
  }
  return "STRING";
}

/** 一列的画像。 */
export interface ColumnProfile {
  readonly name: string;
  readonly count: number;
  readonly non_null: number;
  readonly null_rate: number;
  readonly distinct: number;
  readonly distinct_ratio: number;
  readonly unique: boolean;
  readonly inferred_type: string;
  readonly samples: string[];
}

/** 一列的确定性画像。冲突检测的 TYPE_MISMATCH 用它。 */
export function profileColumn(name: string, values: readonly string[]): ColumnProfile {
  // Python 的 `if v and str(v).strip()`：先真值判断（空串出局），再 strip 判断。
  const nonempty = values.filter((v) => Boolean(v) && pyStrip(v) !== "");
  const distinct = new Set(nonempty).size;
  return {
    name,
    count: values.length,
    non_null: nonempty.length,
    null_rate:
      values.length > 0 ? pyRound(1 - nonempty.length / values.length, 4) : 1.0,
    distinct,
    distinct_ratio: nonempty.length > 0 ? pyRound(distinct / nonempty.length, 4) : 0.0,
    unique: distinct === nonempty.length && nonempty.length > 0,
    inferred_type: inferType(nonempty),
    // dict.fromkeys 去重保序，再取前 5
    samples: [...new Set(nonempty)].slice(0, 5),
  };
}

// ══════════════════════════════════════════════════════════════════
//  表头探测
// ══════════════════════════════════════════════════════════════════

/**
 * 把一行渲染成 `列名=值` 列表，**同值的相邻列合并**。
 *
 * 合并单元格被填充后，同一个值会出现在连续的好几列里。一行 22 列全是同一段
 * 职责说明时，不合并的话这一行的 render 就是那段话重复 22 遍 —— 一个 45 行的
 * sheet 渲染出 27 万字符，模型只看得到开头，而开头全是重复。它会合理地推断
 * "这些列是重复的"然后整段放弃。**真实材料上就是这么丢掉一整张业务规则表的。**
 *
 * `comments` 是 `{列下标: 批注}`。批注**就地绑在被批注的那一列后面**，而不是
 * 甩到行尾 —— 口径几乎都写在批注里，"这条口径是哪一列的"必须跟着列走。值为空、
 * 没能落到任何 pair 的批注不丢，挂到末尾并标出所属列。
 *
 * `comments` 用 `Map` 而不是普通对象：键是数字，普通对象会按整数键**重排**，
 * 而末尾那圈"没落地的批注"是按插入序输出的。
 */
export function renderPairs(
  header: readonly string[],
  row: readonly string[],
  comments?: ReadonlyMap<number, string> | null,
): string[] {
  const cmt = comments ?? new Map<number, string>();
  const out: string[] = [];
  const used = new Set<number>();
  let i = 0;
  const n = Math.min(header.length, row.length);
  while (i < n) {
    const v = pyStrip(row[i]!);
    if (!v) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && pyStrip(row[j]!) === v) j += 1;
    const name = j === i + 1 ? header[i]! : `${header[i]!}~${header[j - 1]!}`;
    let tail = "";
    for (let c = i; c < j; c++) {
      used.add(c);
      const t = cmt.get(c);
      if (t !== undefined) tail += `　〔批注〕${t}`;
    }
    out.push(`${name}=${v}${tail}`);
    i = j;
  }
  for (const [c, txt] of cmt) {
    if (!used.has(c) && c >= 0 && c < header.length) {
      out.push(`〔批注·${header[c]!}〕${txt}`);
    }
  }
  return out;
}

/**
 * 把"写一次、下面留空继承"的分组列向下补全 —— **只给 render 用，不动 raw**。
 *
 * 合并单元格已在 `readSheet` 里按物理区域填过；这里补的是没做物理合并、
 * 纯靠视觉缩进表达层级的分组列。`实体名称` 最典型：每个实体写一次，其下的字段
 * 行留空，视觉上归属上面那个实体。不还原，`plan_amount` 这样的字段行进了检索
 * 索引就不知道自己属于哪个实体，跨实体口径冲突永远归不了因。
 *
 * 安全边界（宁可少补也不能误填"可选属性列"的空）：
 * * 必须存在一个"密集锚列"（逐行都填、逐行变化的记录键，如 `字段`）才动手；
 *   没有锚列说明这不是一行一记录的表，直接原样返回、不猜。
 * * 只补锚列**左侧**、比锚列**更粗**（重复更多）的短文本列 —— 那才是层级分组；
 *   锚列右侧的属性列留空往往是"没有值"，不能继承。
 * * 只在"真数据行"（至少一个密集列有值）上继承，空白分隔行不碰。
 */
export function fillHierarchy(
  header: readonly string[],
  body: readonly (readonly string[])[],
): string[][] {
  const n = body.length;
  // 原样返回时 Python 返回的是**同一个 list 对象**；这里统一拷成新数组，
  // 免得调用方改了 render 视图把 raw 也带偏（Python 侧靠 raw 用的是 `body[ri]`
  // 而不是 `render_body[ri]` 才没出事）。
  const copy = (): string[][] => body.map((r) => [...r]);
  if (n < 2 || header.length === 0) return copy();
  const ncol = header.length;

  const col = (i: number): string[] =>
    body.map((r) => (i < r.length ? pyStrip(r[i]!) : ""));

  const fill: number[] = [];
  const dratio: number[] = [];
  const maxlen: number[] = [];
  for (let i = 0; i < ncol; i++) {
    const vals = col(i);
    const nonblank = vals.filter((v) => v !== "");
    fill.push(nonblank.length / n);
    dratio.push(nonblank.length > 0 ? new Set(nonblank).size / n : 0.0);
    maxlen.push(vals.length > 0 ? Math.max(...vals.map(cpLen)) : 0);
  }

  // 记录键列：从左到右第一个"密集且逐行变化"的列（字段/编码）。
  let key = -1;
  for (let i = 0; i < ncol; i++) {
    if (fill[i]! >= 0.85 && dratio[i]! >= 0.5) {
      key = i;
      break;
    }
  }
  if (key < 0) return copy();
  // 分组列：键列左侧、比键列更粗、短文本、至少写过一次。
  const carryCols: number[] = [];
  for (let i = 0; i < key; i++) {
    if (fill[i]! > 0 && dratio[i]! < dratio[key]! && maxlen[i]! <= 24) carryCols.push(i);
  }
  if (carryCols.length === 0) return copy();
  const denseCols: number[] = [];
  for (let i = 0; i < ncol; i++) if (fill[i]! >= 0.85) denseCols.push(i);

  const out = body.map((r) => {
    const row = [...r];
    while (row.length < ncol) row.push("");
    return row;
  });
  const last = new Map<number, string>(carryCols.map((i) => [i, ""]));
  for (const r of out) {
    const isData = denseCols.some((d) => pyStrip(r[d] ?? "") !== "");
    for (const i of carryCols) {
      const cur = pyStrip(r[i] ?? "");
      if (cur !== "") last.set(i, cur);
      else if (isData && last.get(i)) r[i] = last.get(i)!;
    }
  }
  return out;
}

/**
 * 找出表头在第几行（0-based）；**没有表头时返回 -1**。
 *
 * 判据：填充率够高、几乎全是短文本、且**下一行的类型构成与它不同**。最后一条
 * 是关键 —— 数据区内部相邻两行的类型构成是一致的，表头与首行数据则不然。
 *
 * "没有表头"必须是一个可返回的答案。真实材料里有大量"第一行就是正文"的表
 * （合并单元格里塞一整段职责说明、规则清单）。以前这里无论如何都会选一行当
 * 表头，于是那一整段散文变成了列名，下游每一行的 render 都背上它，切片被这段
 * 重复文本撑爆、真正的内容被挤掉。返回 -1 让调用方改用位置列名、正文从第 0
 * 行开始。
 */
export function detectHeaderRow(rows: readonly (readonly string[])[]): number {
  let best = -1;
  let bestScore = 0.0;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i]!.map(pyStrip);
    const filled = cells.filter((c) => c !== "");
    if (cells.length === 0 || filled.length / cells.length < HEADER_FILL_RATIO) continue;
    // 表头单元格通常短、非数值
    const texty = filled.filter(
      (c) => !INT_RE.test(c) && !DEC_RE.test(c) && cpLen(c) <= 24,
    ).length;
    if (texty / filled.length < 0.5) continue; // 过半格子是长散文/数值 —— 这是正文
    let score = texty / filled.length;
    const nxt = i + 1 < rows.length ? rows[i + 1]! : [];
    if (nxt.length > 0) {
      const nxtFilled = nxt.map(pyStrip).filter((c) => c !== "");
      const nxtNumeric = nxtFilled.filter(
        (c) => INT_RE.test(c) || DEC_RE.test(c) || DATE_RE.test(c),
      ).length;
      if (nxtFilled.length > 0 && nxtNumeric / nxtFilled.length > 0.3) score += 0.5;
      if (new Set(nxtFilled).size === nxtFilled.length && nxtFilled.length > 1) {
        score += 0.1;
      }
    }
    score += Math.max(0.0, 0.3 - i * 0.05); // 靠前略加权，但不是决定性的
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** 表头重名会让下游按名取列时静默取错，必须消歧。 */
export function dedupeHeaders(header: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  header.forEach((h, i) => {
    const name = pyStrip(h ?? "") || `col${i + 1}`;
    const c = (seen.get(name) ?? 0) + 1;
    seen.set(name, c);
    out.push(c === 1 ? name : `${name}#${c}`);
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  zip —— 只为读 OOXML，够用就行
// ══════════════════════════════════════════════════════════════════
// 用 node:zlib 的 inflateRawSync 自己拆 zip，不引第三方：这一层只需要"按名取成员"，
// 而 xlsx 里除了 zip64 之外没有别的花样。读不出来就抛，交给上面按
// BadZipFile 一样处理（`officeMetadata` 吞掉、`XlsxParser.parse` 让它冒出去）。
class BadZip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadZip";
    Object.setPrototypeOf(this, BadZip.prototype);
  }
}

function readZip(buf: Buffer): Map<string, Buffer> {
  // 尾部 22 字节是 EOCD（没有注释时）；有注释就往前找签名。
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BadZip("找不到 zip 中央目录");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x0201_4b50) throw new BadZip("中央目录项签名不对");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(local) !== 0x0403_4b50) throw new BadZip("局部头签名不对");
    // 局部头的 name/extra 长度可以和中央目录不同，必须重新读
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new BadZip(`不支持的压缩方式 ${method}`);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  XML —— 只做扫描，不建 DOM
// ══════════════════════════════════════════════════════════════════
// sheet XML 动辄几十万个 `<c>`，建 DOM 是白付内存。这里只做"逐标签回调"，
// 用不上的子树直接跳过。

interface XTag {
  /** 去掉命名空间前缀的本地名 */
  readonly name: string;
  readonly attrs: Map<string, string>;
  /** `<x/>` 自闭合 */
  readonly selfClose: boolean;
  readonly close: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ref] ?? m;
  });
}

/**
 * 扫一遍 XML，对每个标签与文本节点回调。
 *
 * 不建 DOM：一张大表几十万个 `<c>`，建出来的树光节点对象就是几百 MB，而这里
 * 需要的只是"按出现顺序拿到标签和文本"。调用方自己维护它关心的那点状态
 * （在哪个 `<c>` 里、`<t>` 嵌了几层）。
 */
function scanXml(
  xml: string,
  onTag: (t: XTag) => void,
  onText?: (text: string) => void,
): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i && onText) {
      const t = xml.slice(i, lt);
      if (t) onText(t);
    }
    if (xml.startsWith("<!--", lt)) {
      i = xml.indexOf("-->", lt) + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      if (onText) onText(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      i = xml.indexOf(">", lt) + 1;
      continue;
    }
    // 找 `>`，跳过属性值里的 `>`
    let j = lt + 1;
    let quote = "";
    while (j < xml.length) {
      const ch = xml[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    const body = xml.slice(lt + 1, j);
    i = j + 1;

    const close = body.startsWith("/");
    const selfClose = body.endsWith("/");
    const inner = body.slice(close ? 1 : 0, selfClose ? -1 : undefined);
    const sp = inner.search(/[\s]/u);
    const qname = sp < 0 ? inner : inner.slice(0, sp);
    const colon = qname.indexOf(":");
    const name = colon < 0 ? qname : qname.slice(colon + 1);
    const attrs = new Map<string, string>();
    if (sp >= 0) {
      const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/gu;
      const rest = inner.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) {
        const key = m[1]!;
        const k = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
        attrs.set(k, unescapeXml(m[3] ?? m[4] ?? ""));
      }
    }
    onTag({ name, attrs, selfClose, close });
  }
}

// ══════════════════════════════════════════════════════════════════
//  日期 / 时长 —— openpyxl 的 from_excel
// ══════════════════════════════════════════════════════════════════
const US_PER_DAY = 86_400_000_000n;
const US_PER_SEC = 1_000_000n;
/** `date(1899,12,30).toordinal()` 换算成"距 1970-01-01 的天数"。 */
const EPOCH_DAYS = -25569;

/**
 * Python `timedelta(days=<float>)` 的取整规则。
 *
 * CPython 先把整数部分**精确**乘进去，再用 float 处理小数部分，最后对残余做
 * half-even 取整到微秒。直接 `Math.round(days*86400e6)` 在大天数上会差几微秒 ——
 * 45000.5 这种序列号乘出来早就超过 2^53 了。
 */
function daysToMicros(days: number): bigint {
  const intPart = Math.trunc(days);
  const frac = days - intPart;
  let us = BigInt(intPart) * US_PER_DAY;
  if (frac === 0) return us;
  const scaled = 86_400_000_000 * frac;
  const whole = Math.trunc(scaled);
  us += BigInt(whole);
  const leftover = scaled - whole;
  // round-half-even 到整微秒
  const fl = Math.floor(leftover);
  const rem = leftover - fl;
  let add = fl;
  if (rem > 0.5) add = fl + 1;
  else if (rem === 0.5) add = fl % 2 === 0 ? fl : fl + 1;
  return us + BigInt(add);
}

/** `str(datetime.timedelta)` —— `[N day[s], ]H:MM:SS[.ffffff]`，小时不补零。 */
function timedeltaStr(totalUs: bigint): string {
  // Python 的 timedelta 归一化：0 <= seconds < 86400、0 <= microseconds < 1e6，
  // 负数把 days 往下取整 —— 用 floor 除而不是截断除。
  const usPerDay = US_PER_DAY;
  let days = totalUs / usPerDay;
  let rest = totalUs % usPerDay;
  if (rest < 0n) {
    days -= 1n;
    rest += usPerDay;
  }
  const us = rest % US_PER_SEC;
  const secs = rest / US_PER_SEC;
  const h = secs / 3600n;
  const m = (secs % 3600n) / 60n;
  const s = secs % 60n;
  const hms =
    `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` +
    (us ? `.${String(us).padStart(6, "0")}` : "");
  if (days === 0n) return hms;
  return `${days} day${days === 1n || days === -1n ? "" : "s"}, ${hms}`;
}

/** `str(datetime.time)` —— `HH:MM:SS[.ffffff]`，小时补零。 */
function timeStr(totalUs: bigint): string {
  const us = totalUs % US_PER_SEC;
  const secs = totalUs / US_PER_SEC;
  const h = secs / 3600n;
  const m = (secs % 3600n) / 60n;
  const s = secs % 60n;
  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    String(s).padStart(2, "0") +
    (us ? `.${String(us).padStart(6, "0")}` : "")
  );
}

/** 距 1970-01-01 的天数 → 公历 y/m/d（Howard Hinnant 的 civil_from_days）。 */
function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) -
    Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** `str(datetime.datetime)` —— `YYYY-MM-DD HH:MM:SS[.ffffff]`。越界返回 null。 */
function datetimeStr(daysFromUnix: number, restUs: bigint): string | null {
  const [y, mo, d] = civilFromDays(daysFromUnix);
  if (y < 1 || y > 9999) return null; // Python datetime 的 MINYEAR/MAXYEAR
  return (
    `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-` +
    `${String(d).padStart(2, "0")} ${timeStr(restUs)}`
  );
}

/**
 * openpyxl `from_excel(value, WINDOWS_EPOCH, timedelta=...)` + `str()`。
 *
 * 序列号越界时 openpyxl 只 warn 并把格子降级成错误值 `#VALUE!` —— 照抄，
 * 因为"一格日期读崩把整份材料读没了"比"这一格是 #VALUE!"糟糕得多。
 */
function excelSerialToStr(value: number, asTimedelta: boolean): string {
  if (asTimedelta) {
    let us = daysToMicros(value);
    // openpyxl：有微秒残余就四舍五入到毫秒（round(us, -3)，同样 half-even）
    const sub = ((us % US_PER_SEC) + US_PER_SEC) % US_PER_SEC;
    if (sub !== 0n) {
      const q = sub / 1000n;
      const r = sub % 1000n;
      let ms = q;
      if (r > 500n || (r === 500n && q % 2n === 1n)) ms += 1n;
      us = us - sub + ms * 1000n;
    }
    return timedeltaStr(us);
  }

  // day, fraction = divmod(value, 1)
  const day = Math.floor(value);
  const fraction = value - day;
  // timedelta(milliseconds=round(fraction * 86400 * 1000))
  const ms = BigInt(Math.trunc(pyRound(fraction * 86400 * 1000, 0)));
  const diffUs = ms * 1000n;
  if (value >= 0 && value < 1 && diffUs < US_PER_DAY) return timeStr(diffUs);
  let d = day;
  if (value > 0 && value < 60) d += 1; // 1900 假闰年：Excel 多算了 2 月 29 日
  const totalDays = EPOCH_DAYS + d + Number(diffUs / US_PER_DAY);
  const rest = diffUs % US_PER_DAY;
  return datetimeStr(totalDays, rest) ?? "#VALUE!";
}

// ══════════════════════════════════════════════════════════════════
//  数字格式 —— openpyxl 的 is_date_format / is_timedelta_format
// ══════════════════════════════════════════════════════════════════
const BUILTIN_FORMATS = new Map<number, string>([
  [0, "General"], [1, "0"], [2, "0.00"], [3, "#,##0"], [4, "#,##0.00"],
  [5, '"$"#,##0_);("$"#,##0)'], [6, '"$"#,##0_);[Red]("$"#,##0)'],
  [7, '"$"#,##0.00_);("$"#,##0.00)'], [8, '"$"#,##0.00_);[Red]("$"#,##0.00)'],
  [9, "0%"], [10, "0.00%"], [11, "0.00E+00"], [12, "# ?/?"], [13, "# ??/??"],
  [14, "mm-dd-yy"], [15, "d-mmm-yy"], [16, "d-mmm"], [17, "mmm-yy"],
  [18, "h:mm AM/PM"], [19, "h:mm:ss AM/PM"], [20, "h:mm"], [21, "h:mm:ss"],
  [22, "m/d/yy h:mm"],
  [37, "#,##0_);(#,##0)"], [38, "#,##0_);[Red](#,##0)"],
  [39, "#,##0.00_);(#,##0.00)"], [40, "#,##0.00_);[Red](#,##0.00)"],
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_)_("$"* \\(#,##0.00\\)_("$"* "-"??_)_(@_)'],
  [45, "mm:ss"], [46, "[h]:mm:ss"], [47, "mmss.0"], [48, "##0.0E+0"], [49, "@"],
]);

// 引号里的字面量与方括号里的区域设置都不算格式符 —— 但 `[h]`/`[m]`/`[s]`
// （时长）要留下。这两条正则是 openpyxl `styles/numbers.py` 的原样移植。
const FMT_STRIP_RE = /".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/gu;
const TIMEDELTA_RE = /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/iu;

function isDateFormat(fmt: string | undefined): boolean {
  if (fmt === undefined) return false;
  const head = fmt.split(";")[0]!;
  return /(?<![_\\])[dmhysDMHYS]/u.test(head.replace(FMT_STRIP_RE, ""));
}

function isTimedeltaFormat(fmt: string | undefined): boolean {
  if (fmt === undefined) return false;
  return TIMEDELTA_RE.test(fmt.split(";")[0]!);
}

// ══════════════════════════════════════════════════════════════════
//  xlsx 读取
// ══════════════════════════════════════════════════════════════════
/** 一张工作表读出来的东西。 */
interface RawSheet {
  readonly title: string;
  /** `(row << 20) | col`（都是 1-based）→ 单元格文本（未 strip） */
  readonly cells: Map<number, string>;
  /** 出现过的坐标（含只有样式的空格子、合并区、批注格）—— 维度由它算 */
  readonly present: Set<number>;
  readonly merges: { r0: number; c0: number; r1: number; c1: number }[];
  /** `(row, 0-based col)` → 批注原文 */
  readonly comments: [number, number, string][];
}

const cellKey = (r: number, c: number): number => r * 1_048_576 + c;

/** `A1` / `AB12` → [行, 列]，都是 1-based。 */
function refToRc(ref: string): [number, number] {
  let col = 0;
  let i = 0;
  while (i < ref.length) {
    const ch = ref.charCodeAt(i);
    if (ch >= 65 && ch <= 90) col = col * 26 + (ch - 64);
    else if (ch >= 97 && ch <= 122) col = col * 26 + (ch - 96);
    else break;
    i++;
  }
  return [Number.parseInt(ref.slice(i), 10) || 0, col];
}

/** 把 `<si>`…`</si>` 拆出来（共享串表）。 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1] ?? "";
    // openpyxl 读完还会 `text.replace('x005F_', '')` —— 那是 OOXML 的转义前缀，
    // 照抄，否则 `_x005F_x000D_` 这种值两边会差几个字符。
    out.push(collectText(inner).replace(/x005F_/gu, ""));
  }
  return out;
}

/** 收集一段 XML 里 `<t>` 的文本（跳过 `<rPh>`）。 */
function collectText(inner: string): string {
  let out = "";
  let inPh = false;
  let tDepth = 0;
  scanXml(inner, (t) => {
    if (t.name === "rPh" && !t.selfClose) inPh = !t.close;
    else if (t.name === "t" && !t.selfClose) tDepth += t.close ? -1 : 1;
  }, (text) => {
    if (tDepth > 0 && !inPh) out += unescapeXml(text);
  });
  return out;
}

/** cellXfs 的下标 → 这个样式是不是日期 / 时长。 */
interface StyleIndex {
  readonly date: Set<number>;
  readonly timedelta: Set<number>;
}

function parseStyles(xml: string | undefined): StyleIndex {
  const date = new Set<number>();
  const timedelta = new Set<number>();
  if (xml === undefined) return { date, timedelta };
  const custom = new Map<number, string>();
  let inCellXfs = false;
  let idx = 0;
  scanXml(xml, (t) => {
    if (t.name === "numFmt" && !t.close) {
      const id = Number(t.attrs.get("numFmtId"));
      const code = t.attrs.get("formatCode");
      if (Number.isFinite(id) && code !== undefined && !inCellXfs) custom.set(id, code);
      return;
    }
    if (t.name === "cellXfs") {
      inCellXfs = !t.close;
      return;
    }
    if (t.name === "xf" && inCellXfs && !t.close) {
      const id = Number(t.attrs.get("numFmtId") ?? 0);
      const fmt = custom.get(id) ?? BUILTIN_FORMATS.get(id);
      if (isDateFormat(fmt)) date.add(idx);
      if (isTimedeltaFormat(fmt)) timedelta.add(idx);
      idx += 1;
    }
  });
  return { date, timedelta };
}

/**
 * `_cast_number` + `str()`。
 *
 * openpyxl 的判据是 `re.search(r"\.|[E-e]", value)` —— **文本里有没有 `.` 或
 * 0x45–0x65 之间的字符**，不是"能不能整除"。所以 `<v>1.0</v>` 是 float
 * （`"1.0"`）而 `<v>1</v>` 是 int（`"1"`）。那个字符类顺带把 `_` 也圈了进去
 * （0x5F），于是 `1_0` 走 float 分支得到 `10.0` —— 照抄，包括这个巧合。
 *
 * 大整数走 BigInt：`12345678901234567890` 转 double 会掉到
 * `12345678901234567000`，而 Python 侧是精确的整数。
 */
function castNumber(text: string): { str: string; num: number } {
  const isFloat = /\.|[E-e]/u.test(text);
  if (isFloat) {
    // Python 的字面量允许下划线分组（`float("1_0") == 10.0`），JS 的 Number 不允许。
    const n = Number(text.replace(/_/gu, ""));
    return { str: pyFloatStr(n), num: n };
  }
  try {
    const b = BigInt(text);
    return { str: b.toString(), num: Number(b) };
  } catch {
    const n = Number(text);
    return { str: pyFloatStr(n), num: n };
  }
}

function parseSheetXml(
  xml: string,
  sst: readonly string[],
  styles: StyleIndex,
): { cells: Map<number, string>; present: Set<number>;
     merges: { r0: number; c0: number; r1: number; c1: number }[] } {
  const cells = new Map<number, string>();
  const present = new Set<number>();
  const merges: { r0: number; c0: number; r1: number; c1: number }[] = [];

  let rowCounter = 0;
  let colCounter = 0;
  // 当前 `<c>` 的状态
  let cur: { r: number; c: number; t: string; s: number } | null = null;
  let vBuf: string | null = null;
  let inV = false;
  let isStart = 0; // `<is>` 的深度
  let isBuf = "";
  let tDepth = 0;
  let phDepth = 0;

  const finish = (): void => {
    if (cur === null) return;
    const key = cellKey(cur.r, cur.c);
    present.add(key);
    let out = "";
    // `findtext(v) or None`：空的 <v> 也是 None
    const raw = vBuf !== null && vBuf !== "" ? vBuf : null;
    if (cur.t === "inlineStr") {
      if (isBuf !== "") out = isBuf;
    } else if (raw !== null) {
      switch (cur.t) {
        case "n": {
          const cast = castNumber(raw);
          if (styles.date.has(cur.s)) {
            out = excelSerialToStr(cast.num, styles.timedelta.has(cur.s));
          } else {
            out = cast.str;
          }
          break;
        }
        case "s": {
          out = sst[Number.parseInt(raw, 10)] ?? "";
          break;
        }
        case "b":
          out = Number.parseInt(raw, 10) !== 0 ? "True" : "False";
          break;
        default:
          // "str"（公式的字符串结果）/ "e"（错误值）/ "d"（ISO 日期）都原样留着。
          // "d" 在 Python 里会走 from_ISO8601 再 str()，实际文件里几乎不出现，
          // 这里按原文处理并在 divergences 里记着。
          out = raw;
      }
    }
    if (out !== "") cells.set(key, out);
    cur = null;
    vBuf = null;
    isBuf = "";
  };

  scanXml(xml, (t) => {
    switch (t.name) {
      case "row":
        if (t.close) return;
        finish();
        {
          const r = t.attrs.get("r");
          rowCounter = r !== undefined ? Number.parseInt(r, 10) : rowCounter + 1;
          colCounter = 0;
        }
        return;
      case "c": {
        if (t.close) {
          finish();
          return;
        }
        finish();
        const ref = t.attrs.get("r");
        let r: number;
        let c: number;
        if (ref !== undefined) {
          [r, c] = refToRc(ref);
          colCounter = c;
        } else {
          colCounter += 1;
          r = rowCounter;
          c = colCounter;
        }
        const sAttr = t.attrs.get("s");
        cur = {
          r, c,
          t: t.attrs.get("t") ?? "n",
          s: sAttr !== undefined && sAttr !== "" ? Number.parseInt(sAttr, 10) : 0,
        };
        vBuf = null;
        isBuf = "";
        if (t.selfClose) finish();
        return;
      }
      case "v":
        if (t.selfClose) vBuf = vBuf ?? "";
        else if (t.close) inV = false;
        else {
          inV = true;
          vBuf = "";
        }
        return;
      case "is":
        if (t.close) isStart -= 1;
        else if (!t.selfClose) isStart += 1;
        return;
      case "rPh":
        if (t.close) phDepth -= 1;
        else if (!t.selfClose) phDepth += 1;
        return;
      case "t":
        if (t.close) tDepth -= 1;
        else if (!t.selfClose) tDepth += 1;
        return;
      case "mergeCell": {
        const ref = t.attrs.get("ref");
        if (ref !== undefined && !t.close) {
          const [a, b] = ref.split(":");
          if (a !== undefined && b !== undefined) {
            const [r0, c0] = refToRc(a);
            const [r1, c1] = refToRc(b);
            merges.push({ r0, c0, r1, c1 });
          }
        }
        return;
      }
      default:
        return;
    }
  }, (text) => {
    if (inV && vBuf !== null) vBuf += unescapeXml(text);
    else if (isStart > 0 && tDepth > 0 && phDepth === 0) isBuf += unescapeXml(text);
  });
  finish();
  return { cells, present, merges };
}

/** 读一份 workbook 的全部工作表（顺序与 `<sheets>` 一致）。 */
function readWorkbook(parts: Map<string, Buffer>): RawSheet[] {
  const dec = (name: string): string | undefined => parts.get(name)?.toString("utf8");

  const sstXml = dec("xl/sharedStrings.xml");
  const sst = sstXml === undefined ? [] : parseSharedStrings(sstXml);
  const styles = parseStyles(dec("xl/styles.xml"));

  // rId → 目标（相对 xl/）
  const relXml = dec("xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map<string, string>();
  scanXml(relXml, (t) => {
    if (t.name === "Relationship" && !t.close) {
      const id = t.attrs.get("Id");
      const tgt = t.attrs.get("Target");
      if (id !== undefined && tgt !== undefined) rels.set(id, tgt);
    }
  });

  const sheets: { name: string; target: string }[] = [];
  const wbXml = dec("xl/workbook.xml") ?? "";
  scanXml(wbXml, (t) => {
    if (t.name === "sheet" && !t.close) {
      const name = t.attrs.get("name");
      const rid = t.attrs.get("id");
      if (name === undefined) return;
      const tgt = rid !== undefined ? rels.get(rid) : undefined;
      if (tgt !== undefined) sheets.push({ name, target: tgt });
    }
  });

  const out: RawSheet[] = [];
  for (const { name, target } of sheets) {
    const path = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//u, "")}`;
    const xml = dec(path);
    if (xml === undefined) continue;
    const { cells, present, merges } = parseSheetXml(xml, sst, styles);

    // 合并区：除左上角外全部换成 MergedCell（值 None），**并且照样进 _cells**。
    // 顺序是先 bind_cells 再 bind_merged_cells，所以 XML 里写在合并区里的值会被
    // 抹掉 —— 抹掉之后 `_read_sheet` 的填充又把左上角的值补回去，两步别省。
    for (const m of merges) {
      for (let r = m.r0; r <= m.r1; r++) {
        for (let c = m.c0; c <= m.c1; c++) {
          if (r === m.r0 && c === m.c0) continue;
          const k = cellKey(r, c);
          present.add(k);
          cells.delete(k);
        }
      }
    }

    // 批注：openpyxl 用 `ws[ref].comment = ...` 挂上去，这个下标会**新建单元格**，
    // 于是落在空白处的批注同样把 max_row / max_col 撑大。
    const comments: [number, number, string][] = [];
    const sheetRelPath = path.replace(/([^/]+)$/u, "_rels/$1.rels");
    const sheetRel = dec(sheetRelPath);
    if (sheetRel !== undefined) {
      let cmtTarget: string | undefined;
      scanXml(sheetRel, (t) => {
        if (t.name === "Relationship" && !t.close &&
            (t.attrs.get("Type") ?? "").endsWith("/comments")) {
          cmtTarget = t.attrs.get("Target");
        }
      });
      if (cmtTarget !== undefined) {
        const base = path.slice(0, path.lastIndexOf("/") + 1);
        const cmtPath = normalizePath(base + cmtTarget);
        const cmtXml = dec(cmtPath);
        if (cmtXml !== undefined) {
          for (const [ref, text] of parseComments(cmtXml)) {
            const [r, c] = refToRc(ref);
            if (r === 0 || c === 0) continue;
            present.add(cellKey(r, c));
            comments.push([r, c - 1, text]);
          }
        }
      }
    }
    out.push({ title: name, cells, present, merges, comments });
  }
  return out;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function parseComments(xml: string): [string, string][] {
  const out: [string, string][] = [];
  const re =
    /<(?:\w+:)?comment\s([^>]*)>([\s\S]*?)<\/(?:\w+:)?comment>/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const refM = /\bref\s*=\s*"([^"]*)"/u.exec(m[1] ?? "");
    if (refM === null) continue;
    out.push([refM[1]!, collectText(m[2] ?? "")]);
  }
  return out;
}

/**
 * 读成字符串网格，顺带还原合并单元格、抽出批注（按 (行, 列下标) 定位）。
 *
 * grid 是 `1..max_row × 1..max_col` 的整块矩形 —— openpyxl 的 `iter_rows()`
 * 缺省从 A1 起，**不是**从首个有值的格子起。工作表一个格子都没有时给空 grid。
 */
export function readSheet(ws: RawSheet): [string[][], Map<string, string>] {
  let maxRow = 1;
  let maxCol = 1;
  for (const k of ws.present) {
    const r = Math.floor(k / 1_048_576);
    const c = k % 1_048_576;
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  const grid: string[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const row: string[] = [];
    for (let c = 1; c <= maxCol; c++) row.push(pyStrip(ws.cells.get(cellKey(r, c)) ?? ""));
    grid.push(row);
  }

  // 合并区只有左上角有值 —— 填充回去，否则下游看到一堆空格
  for (const m of ws.merges) {
    const r0 = m.r0 - 1;
    const c0 = m.c0 - 1;
    if (r0 >= grid.length || r0 < 0 || c0 < 0 || c0 >= grid[r0]!.length) continue;
    const v = grid[r0]![c0]!;
    if (!v) continue;
    for (let r = r0; r < Math.min(m.r1, grid.length); r++) {
      const line = grid[r]!;
      for (let c = c0; c < Math.min(m.c1, line.length); c++) {
        if (!line[c]) line[c] = v;
      }
    }
  }

  // 键是 "行,0-based 列"。Python 那边是元组键的 dict，插入序按 iter_rows 的
  // 行优先顺序 —— 这里按同样的顺序排一遍，因为 `renderPairs` 末尾那圈
  // "没落地的批注"是按插入序输出的。
  const comments = new Map<string, string>();
  const sorted = [...ws.comments].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  for (const [r, c, txt0] of sorted) {
    const txt = pyStrip(txt0);
    if (!txt0) continue; // Python: `if c.comment and c.comment.text`
    const key = `${r},${c}`;
    const prev = comments.get(key);
    comments.set(key, prev === undefined ? txt : `${prev}；${txt}`);
  }

  while (grid.length > 0 && !grid[grid.length - 1]!.some((x) => pyStrip(x) !== "")) {
    grid.pop();
  }
  return [grid, comments];
}

/**
 * 抽 Office 文档元数据。
 *
 * `workbook.xml` 里的 `absPath` 保存着这份文件最后一次保存时的绝对路径，
 * `docProps/core.xml` 里有作者名。两者都不在表格内容里，但常常泄漏客户名、
 * 项目代号和人名 —— 既是理解材料来源的线索，也是对外发布前必须清的东西。
 */
function officeMetadata(
  bytes: Buffer, fileName: string, doc: ParsedDoc,
): Finding[] {
  const out: Finding[] = [];
  const meta = new Map<string, string>();
  try {
    const parts = readZip(bytes);
    const wb = parts.get("xl/workbook.xml");
    if (wb !== undefined) {
      const m = /absPath[^>]*url="([^"]+)"/u.exec(wb.toString("utf8"));
      if (m !== null) meta.set("abs_path", unescapeXml(m[1]!));
    }
    const core = parts.get("docProps/core.xml");
    if (core !== undefined) {
      const xml = core.toString("utf8");
      for (const [tag, key] of [
        ["dc:creator", "creator"],
        ["cp:lastModifiedBy", "last_modified_by"],
        ["dcterms:modified", "modified"],
      ] as const) {
        const m = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "u").exec(xml);
        if (m !== null) meta.set(key, unescapeXml(m[1]!));
      }
    }
  } catch {
    // BadZipFile / KeyError / OSError —— 元数据读不出来不该让整份材料解析失败
    return out;
  }

  for (const [k, v] of meta) doc.meta[k] = v;
  const leaked: [string, string][] = [];
  for (const [k, v] of meta) {
    if ((k === "abs_path" || k === "creator" || k === "last_modified_by") && v) {
      leaked.push([k, v]);
    }
  }
  if (leaked.length > 0) {
    const detail = leaked.map(([k, v]) => `${k}=${v}`).join("；");
    out.push(makeFinding(
      "metadata_leak",
      `文档元数据里带着作者与保存路径（${detail}）。这些不在表格内容里，` +
        "但对外发布前建议清理，或把项目名换成中性代号。",
      { kind: "meta", field: "workbook.xml/docProps" },
      "warn",
    ));
    // 元数据本身也是可检索的证据 —— FDE 问"你怎么知道客户是谁"时要答得出来
    doc.chunks.push(makeChunk({
      docId: "meta", fileId: doc.file_id, fileName,
      locator: { kind: "meta", field: "workbook.xml/absPath" },
      render: `〔文档元数据〕${detail}`,
      raw: Object.fromEntries(meta), order: -1, tags: ["meta"],
    }));
  }
  return out;
}

/**
 * 逐表读出 grid 与批注 —— Python 侧 `_read_sheet` 的对等物。
 *
 * 单独暴露出来是因为它是 xlsx 这条链上**唯一**会因为库选型而失真的一环
 * （见文件头）：golden 里逐表钉的就是它的输出，出问题时先比这里。
 */
export function readSheetGrids(
  bytes: Buffer,
): { title: string; grid: string[][]; comments: Map<string, string> }[] {
  return readWorkbook(readZip(bytes)).map((ws) => {
    const [grid, comments] = readSheet(ws);
    return { title: ws.title, grid, comments };
  });
}

/** 一张表在 `structured.sheets` 里的形态。 */
export interface SheetSummary {
  readonly name: string;
  readonly header_row: number;
  readonly columns: string[];
  readonly rows: number;
  readonly profile: Record<string, ColumnProfile>;
}

export class XlsxParser extends Parser {
  override readonly kind = "xlsx";
  override readonly extensions: readonly string[] = [".xlsx", ".xlsm", ".xltx"];

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileName = basename(path);
    const bytes = await readFile(path);
    const doc = makeParsedDoc({
      fileId: opts.fileId, fileName, kind: this.kind,
    });
    doc.findings.push(...officeMetadata(bytes, fileName, doc));

    const sheets: SheetSummary[] = [];
    let order = 0;

    for (const ws of readWorkbook(readZip(bytes))) {
      const [grid, comments] = readSheet(ws);
      if (grid.length === 0) {
        doc.findings.push(makeFinding(
          "empty_sheet", `工作表「${ws.title}」是空的，已跳过`, { sheet: ws.title }));
        continue;
      }

      const h = detectHeaderRow(grid);
      const width = Math.max(...grid.map((r) => r.length));
      const header =
        h >= 0
          ? dedupeHeaders(grid[h]!)
          : Array.from({ length: width }, (_, i) => `col${i + 1}`);
      const body = grid.slice(h + 1);
      const cols: Record<string, ColumnProfile> = {};
      header.forEach((name, i) => {
        cols[name] = profileColumn(name, body.map((r) => (i < r.length ? r[i]! : "")));
      });
      sheets.push({
        name: ws.title, header_row: h + 1, columns: header,
        rows: body.length, profile: cols,
      });
      if (h > 0) {
        doc.findings.push(makeFinding(
          "header_offset",
          `「${ws.title}」表头在第 ${h + 1} 行，不是第 1 行`,
          { sheet: ws.title, row: h + 1 }));
      } else if (h < 0) {
        doc.findings.push(makeFinding(
          "no_header",
          `「${ws.title}」没有可识别的表头，已按位置列名处理、正文从第 1 行起`,
          { sheet: ws.title }));
      }

      // 每张表一个 schema 切片：一眼看清列构成/类型，检索"这张表有哪些列"
      // 时不必扫每一行 —— 大表尤其重要。
      doc.chunks.push(makeChunk({
        docId: `${ws.title}:schema`, fileId: opts.fileId, fileName,
        locator: { kind: "range", sheet: ws.title, rows: [h + 1, h + 1] },
        render:
          `表「${ws.title}」列：` +
          Object.entries(cols)
            .map(([n, p]) => `${n}（${p.inferred_type}，唯一率${pyPct(p.distinct_ratio)}）`)
            .join(" | "),
        raw: cols, order, tags: ["schema"],
      }));
      order += 1;

      // 每行一个切片：行是表格里语义完整的最小单元。render 用补全了分组列的
      // 视图（切片才能自证归属），raw 保持原样（下游 shape 靠留空判分组列）。
      const renderBody = fillHierarchy(header, body);
      body.forEach((row, ri) => {
        const excelRow = h + 2 + ri;
        const rowComments = new Map<number, string>();
        for (const [k, t] of comments) {
          const comma = k.indexOf(",");
          if (Number(k.slice(0, comma)) === excelRow) {
            rowComments.set(Number(k.slice(comma + 1)), t);
          }
        }
        const pairs = renderPairs(header, renderBody[ri]!, rowComments);
        if (pairs.length === 0) return;
        const raw: Record<string, string> = {};
        for (let i = 0; i < Math.min(header.length, row.length); i++) {
          raw[header[i]!] = row[i]!;
        }
        doc.chunks.push(makeChunk({
          docId: `${ws.title}:r${excelRow}`, fileId: opts.fileId, fileName,
          locator: { kind: "range", sheet: ws.title, rows: [excelRow, excelRow] },
          render: pairs.join(" | "),
          raw, order, tags: ["row"],
        }));
        order += 1;
      });
    }

    doc.structured["sheets"] = sheets;
    return doc;
  }
}

// ══════════════════════════════════════════════════════════════════
//  csv
// ══════════════════════════════════════════════════════════════════

// `_read_text` 的移植在 base.ts 的 `readTextGuess` 里（那是解析层共用的原语，
// text.ts 也吃它），这里**不再复制一份**。它的向量在
// `test/onto.parse.tabular.test.ts` 里跑 —— tabular 是它的第一个调用方，
// 而编码猜错的后果（整份 CSV 正文乱码 + encoding_guess 报一个错的编码名）
// 也是在这条链上才看得见。

// ── csv.Sniffer 的移植 ────────────────────────────────────────────
// 只有 delimiter 会被用到（`csv.reader(..., delimiter=delim)` 其余参数走 excel
// 方言的缺省），但 delimiter 的求法两步都要照抄：先按"引号夹着的字段"猜，
// 猜不出来再做频次分析。任何一步偏了，分号 CSV 就会被当成单列表。

class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
    Object.setPrototypeOf(this, CsvError.prototype);
  }
}

const SNIFF_PATTERNS: { re: RegExp; groups: string[] }[] = [
  // Python 的 `\w` 认 Unicode 字母/数字/下划线（含中文），JS 的只认 ASCII ——
  // 换成 \p{L}\p{N}_ 才不会把中文列名当成候选分隔符。
  { re: /([^\p{L}\p{N}_\n"'])( ?)(["'])[\s\S]*?\3\1/gu, groups: ["delim", "space", "quote"] },
  { re: /(?:^|\n)(["'])[\s\S]*?\1([^\p{L}\p{N}_\n"'])( ?)/gu, groups: ["quote", "delim", "space"] },
  { re: /([^\p{L}\p{N}_\n"'])( ?)(["'])[\s\S]*?\3(?:$|\n)/gu, groups: ["delim", "space", "quote"] },
  { re: /(?:^|\n)(["'])[\s\S]*?\1(?:$|\n)/gu, groups: ["quote"] },
];

function guessQuoteAndDelimiter(data: string, delimiters: string): string | null {
  let matches: string[][] = [];
  let groups: string[] = [];
  for (const p of SNIFF_PATTERNS) {
    p.re.lastIndex = 0;
    const found: string[][] = [];
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(data)) !== null) {
      found.push(m.slice(1).map((x) => x ?? ""));
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
    if (found.length > 0) {
      matches = found;
      groups = p.groups;
      break;
    }
  }
  if (matches.length === 0) return null;

  const delims = new Map<string, number>();
  const di = groups.indexOf("delim");
  for (const m of matches) {
    if (di < 0) continue;
    const key = m[di] ?? "";
    if (key && delimiters.includes(key)) delims.set(key, (delims.get(key) ?? 0) + 1);
  }
  if (delims.size === 0) return "";
  // `max(delims, key=delims.get)` —— 平手取**最先插入**的那个
  let best = "";
  let bestN = -1;
  for (const [k, v] of delims) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return best === "\n" ? "" : best;
}

function guessDelimiter(data0: string, delimiters: string): string {
  const data = data0.split("\n").filter((x) => x !== "");
  if (data.length === 0) return "";
  const ascii: string[] = [];
  for (let c = 0; c < 127; c++) ascii.push(String.fromCharCode(c));

  const charFrequency = new Map<string, Map<number, number>>();
  const modes = new Map<string, [number, number]>();
  const delims = new Map<string, [number, number]>();
  const chunkLength = Math.min(10, data.length);
  let iteration = 0;
  let start = 0;
  let end = chunkLength;

  while (start < data.length) {
    iteration += 1;
    for (const line of data.slice(start, end)) {
      for (const ch of ascii) {
        let meta = charFrequency.get(ch);
        if (meta === undefined) {
          meta = new Map<number, number>();
          charFrequency.set(ch, meta);
        }
        const freq = countChar(line, ch);
        meta.set(freq, (meta.get(freq) ?? 0) + 1);
      }
    }
    for (const [ch, meta] of charFrequency) {
      const items = [...meta];
      if (items.length === 1 && items[0]![0] === 0) continue;
      if (items.length > 1) {
        // `max(items, key=lambda x: x[1])` —— 平手取最先出现的
        let top = items[0]!;
        for (const it of items) if (it[1] > top[1]) top = it;
        const others = items.filter((it) => it !== top);
        modes.set(ch, [top[0], top[1] - others.reduce((a, b) => a + b[1], 0)]);
      } else {
        modes.set(ch, items[0]!);
      }
    }
    const total = Math.min(chunkLength * iteration, data.length);
    let consistency = 1.0;
    const threshold = 0.9;
    while (delims.size === 0 && consistency >= threshold) {
      for (const [k, v] of modes) {
        if (v[0] > 0 && v[1] > 0 && v[1] / total >= consistency && delimiters.includes(k)) {
          delims.set(k, v);
        }
      }
      consistency -= 0.01;
    }
    if (delims.size === 1) return [...delims.keys()][0]!;
    start = end;
    end += chunkLength;
  }

  if (delims.size === 0) return "";
  if (delims.size > 1) {
    for (const d of [",", "\t", ";", " ", ":"]) if (delims.has(d)) return d;
  }
  // `items.sort()` 排的是 ((freq, count), char) 元组，取最大
  const items = [...delims].map(([k, v]) => [v, k] as [[number, number], string]);
  items.sort((a, b) =>
    a[0][0] - b[0][0] || a[0][1] - b[0][1] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return items[items.length - 1]![1];
}

function countChar(s: string, ch: string): number {
  let n = 0;
  let i = s.indexOf(ch);
  while (i >= 0) {
    n += 1;
    i = s.indexOf(ch, i + 1);
  }
  return n;
}

/** `csv.Sniffer().sniff(sample, delimiters=...)`，只返回 delimiter；猜不出来抛。 */
export function sniffDelimiter(sample: string, delimiters = ",;\t|"): string {
  let delim = guessQuoteAndDelimiter(sample, delimiters);
  if (delim === null || delim === "") delim = guessDelimiter(sample, delimiters);
  if (!delim) throw new CsvError("Could not determine delimiter");
  return delim;
}

/**
 * `csv.reader(lines, delimiter=d)` —— excel 方言：`"` 引号、doublequote、
 * 无 escapechar、不吃行首空格、QUOTE_MINIMAL、strict=False。
 *
 * 喂进来的是 `splitlines()` 的结果（行尾已经没有换行），所以跨行的引号字段会被
 * **无缝拼接**（`"b1` + `b2"` → `b1b2`）—— 这是 Python 在同样输入下的行为，
 * 不是 bug，别"顺手"补一个 \n。
 */
export function csvReader(lines: readonly string[], delimiter: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  // START_RECORD | START_FIELD | IN_FIELD | IN_QUOTED | QUOTE_IN_QUOTED
  let state: "rec" | "sf" | "in" | "q" | "qq" = "rec";

  for (const line of lines) {
    for (const ch of line) {
      // START_RECORD 见到非行尾字符就转 START_FIELD，**再由 START_FIELD 处理它**
      if (state === "rec") state = "sf";
      switch (state) {
        case "sf":
          if (ch === '"') state = "q";
          else if (ch === delimiter) {
            fields.push("");
            state = "sf";
          } else {
            field = ch;
            state = "in";
          }
          break;
        case "in":
          if (ch === delimiter) {
            fields.push(field);
            field = "";
            state = "sf";
          } else field += ch;
          break;
        case "q":
          if (ch === '"') state = "qq";
          else field += ch;
          break;
        case "qq":
          if (ch === '"') {
            field += '"'; // doublequote：""  → 一个字面引号
            state = "q";
          } else if (ch === delimiter) {
            fields.push(field);
            field = "";
            state = "sf";
          } else {
            // strict=False：引号后跟别的字符就当普通字符继续
            field += ch;
            state = "in";
          }
          break;
      }
    }
    // 行尾（EOL 哨兵）：引号里的行尾什么都不加，其余收尾出一条记录
    if (state === "q") continue;
    if (state === "rec") {
      rows.push([]); // 空行 → 空记录
      continue;
    }
    if (state !== "sf" || fields.length > 0 || field !== "") fields.push(field);
    rows.push(fields);
    fields = [];
    field = "";
    state = "rec";
  }
  if (state !== "rec") {
    // 引号没闭合就到了输入末尾：Python 同样把已攒下的内容出成一条记录
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}

export class CsvParser extends Parser {
  override readonly kind = "csv";
  override readonly extensions: readonly string[] = [".csv", ".tsv"];

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileName = basename(path);
    const stem = fileName.slice(0, fileName.length - extname(fileName).length);
    const doc = makeParsedDoc({
      fileId: opts.fileId, fileName, kind: this.kind,
    });
    const [text, enc] = await readTextGuess(path);
    if (enc !== "utf-8") {
      doc.findings.push(makeFinding(
        "encoding_guess",
        `文件不是 UTF-8，按 ${enc} 解码（中文 CSV 常见 GBK）`,
        {}, "warn"));
    }

    const sample = cpSlice(text, 0, 8192);
    let delim: string;
    try {
      delim = sniffDelimiter(sample);
    } catch {
      delim = extname(fileName).toLowerCase() === ".tsv" ? "\t" : ",";
    }
    const rows = csvReader(pySplitlines(text), delim)
      .filter((r) => r.some((x) => pyStrip(x) !== ""));
    if (rows.length === 0) {
      doc.structured["columns"] = [];
      doc.structured["rows"] = 0;
      doc.structured["profile"] = {};
      return doc;
    }

    const h = detectHeaderRow(rows);
    const header =
      h >= 0
        ? dedupeHeaders(rows[h]!)
        : Array.from({ length: Math.max(...rows.map((r) => r.length)) },
                     (_, i) => `col${i + 1}`);
    const body = rows.slice(h + 1);
    const profile: Record<string, ColumnProfile> = {};
    header.forEach((name, i) => {
      profile[name] = profileColumn(name, body.map((r) => (i < r.length ? r[i]! : "")));
    });
    doc.structured["columns"] = header;
    doc.structured["rows"] = body.length;
    doc.structured["delimiter"] = delim;
    doc.structured["profile"] = profile;

    // 大表不逐行切片 —— 几万行会把索引撑爆且毫无检索价值。
    // 给表头 + 画像 + 少量样本行，这才是抽取需要看的东西。
    doc.chunks.push(makeChunk({
      docId: "schema", fileId: opts.fileId, fileName,
      locator: { kind: "range", sheet: stem, rows: [h + 1, h + 1] },
      render:
        "列：" +
        Object.entries(profile)
          .map(([n, p]) =>
            `${n}(${p.inferred_type}，唯一率${pyPct(p.distinct_ratio)}，` +
            `空值率${pyPct(p.null_rate)})`)
          .join(" | "),
      raw: profile, order: 0, tags: ["schema"],
    }));
    body.slice(0, 20).forEach((row, ri) => {
      doc.chunks.push(makeChunk({
        docId: `r${h + 2 + ri}`, fileId: opts.fileId, fileName,
        locator: { kind: "range", sheet: stem, rows: [h + 2 + ri, h + 2 + ri] },
        render: renderPairs(header, row).join(" | "),
        order: ri + 1, tags: ["sample"],
      }));
    });
    if (body.length > 20) {
      doc.findings.push(makeFinding(
        "sampled",
        `共 ${body.length} 行，索引里只放了前 20 行样本 + 全量列画像`,
        {}));
    }
    return doc;
  }
}
