/**
 * Python 字符串/数值语义的等价实现 —— 只放**两边不等价**的那几个。
 *
 * 为什么不直接用 JS 的对应物：这三个解析器的输出是拼出来的字符串，任何一处
 * 归一化差异都会在 render / structured 里显形，而 render 是进模型上下文的东西。
 *
 *   `str.split()`      空白集不同：Python 认 \x1c–\x1f，JS 的 \s 不认；JS 认 ﻿，
 *                      Python 不认。
 *   `str.splitlines()` 断行集比 JS 的 \n 大得多（\v \f \x1c–\x1e \x85    ）。
 *   `int(s)`           非整数字符串**抛**，而 JS 的 parseInt 会给个半截结果 ——
 *                      吞掉畸形的 EMU 坐标，bbox 就会静默变成错的位置。
 *   `float(x)`         `float("")` 抛，而 `Number("")` 给 0。
 *   `min/max`          **含 NaN 时行为相反**：Python 的 `max(0.0, min(1.0, nan))`
 *                      给 1.0，JS 的 `Math.max(0, Math.min(1, NaN))` 给 NaN。
 *                      vision 的 bbox 归一化正好踩在这上面（golden 的 "nan" 用例）。
 */

/** Python `str.isspace()` 为真的字符（BMP 内，由 CPython 3.13 实地枚举得到）。 */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0"
  + "\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const SPLIT_RE = new RegExp(`[${PY_SPACE}]+`);
const LSTRIP_RE = new RegExp(`^[${PY_SPACE}]+`);
const RSTRIP_RE = new RegExp(`[${PY_SPACE}]+$`);

/** == Python `s.split()`（无分隔符）：按空白串切，丢掉首尾产生的空串。 */
export function pySplitWhitespace(s: string): string[] {
  return s.split(SPLIT_RE).filter((part) => part !== "");
}

/** == Python `" ".join(s.split())`：把任意空白压成单个半角空格。 */
export function pyNormalizeSpaces(s: string): string {
  return pySplitWhitespace(s).join(" ");
}

/** == Python `s.strip()`。 */
export function pyStrip(s: string): string {
  return s.replace(LSTRIP_RE, "").replace(RSTRIP_RE, "");
}

// \r\n 必须排在前面，否则 \r 先匹配会把 \n 留成一个空行。
// 注意 \x1f 在 Python 里**是空白但不是断行符** —— 与 split() 的集合差这一个。
const LINE_RE = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

/** == Python `s.splitlines()`：不产生结尾空串，空串给空列表。 */
export function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(LINE_RE);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** == Python `int(s)`：非整数**抛**。畸形坐标必须炸，不能悄悄取个前缀。 */
export function pyInt(s: string): number {
  const t = pyStrip(s);
  // Python 允许数字间下划线（`1_000`），也允许全角数字；后者在 OOXML 的 EMU
  // 属性里不会出现，不实现，见 notes。
  if (!/^[+-]?\d+(_\d+)*$/.test(t)) {
    throw new TypeError(`invalid literal for int() with base 10: ${JSON.stringify(s)}`);
  }
  return Number(t.replace(/_/g, ""));
}

const FLOAT_RE =
  /^([+-]?)(?:(inf(?:inity)?|nan)|((?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?))$/i;

/** == Python `float(x)`：接受数字/布尔/数字字符串，其余**抛**。
 *
 * 三处与 `Number()` 不同，每一处都会静默改变 bbox：`Number("")` 给 0（Python 抛）、
 * `Number("inf")` 给 NaN（Python 给 ∞）、`Number(null)` 给 0（Python 抛）。 */
export function pyFloat(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x !== "string") {
    throw new TypeError("float() argument must be a string or a real number");
  }
  const m = FLOAT_RE.exec(pyStrip(x));
  if (!m) throw new TypeError(`could not convert string to float: ${x}`);
  const sign = m[1] === "-" ? -1 : 1;
  if (m[2] !== undefined) {
    return m[2].toLowerCase() === "nan" ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }
  return sign * Number((m[3] ?? "").replace(/_/g, ""));
}

/** Python 两参数 `min`：只在 `b < a` 时取 b —— NaN 比较全为假，所以 NaN 会被丢掉。 */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/** Python 两参数 `max`。 */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a;
}
