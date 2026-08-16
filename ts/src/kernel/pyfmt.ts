/**
 * Python 数字格式化原语 —— `ids.ts`（指纹）与 `journal.ts`（落盘字节）共用的一份。
 *
 * 为什么单独成模块：这两处都要把 double 印成 **CPython 的记号**，而两边各写一份
 * 的代价不是重复代码，是**悄悄分叉**。分叉过一次了 —— `ids.ts` 的 `numToJson`
 * 原本对非整数直接 `String(n)`，注释还写着「JS 的 String(number) 与 Python
 * repr(float) 同为 shortest round-trip，字节一致」。前半句对，后半句错：
 * 有效数字确实是同一套 shortest round-trip 结果，但**什么时候转指数记号**
 * 和**指数补不补零**两边规则不同。golden/ids.json 里一条带指数的向量都没有，
 * 所以这个错误声明一直没被测到。
 *
 * 看着像吹毛求疵，但 usd 成本正好落在这个区间（一次调用 1.2e-5 美元），
 * 而它会进 effect 指纹、进事件 payload、进 jsonl。
 */

/**
 * CPython `repr(float)` / `json.dumps(float)` 的记号选择。**不是** `String(x)`：
 *
 *   x        CPython             JS String(x)
 *   1e-5     "1e-05"             "0.00001"              ← 记号不同
 *   1.2e-5   "1.2e-05"           "0.000012"             ← 记号不同
 *   1e-7     "1e-07"             "1e-7"                 ← 指数位数不同
 *   0.0001   "0.0001"            "0.0001"               ← 一致
 *
 * 判据：CPython 在 `decpt <= -4 || decpt > 16` 时转指数并把指数补足两位，
 * JS 在 `< 1e-6 || >= 1e21` 时转指数且指数不补零。
 *
 * **不处理整数值**。`1e16` 与 `10000000000000000` 在 JS 里是同一个值，而 Python
 * 里前者是 float（印成 `"1e+16"`）后者是 int（印成 `"10000000000000000"`）——
 * 这个区分在 JS 侧无从恢复，是已被两边测试钉住的语言边界，不是这个函数能解决的。
 * 调用方自己决定整数值走哪条路（`ids.ts` 按 int 处理，与它既有的 `1.0 → "1"`
 * 一致）。
 */
export function pyFloatRepr(x: number): string {
  // toExponential() 不带参数 = "唯一确定这个 double 所需的最少位数"，正是 repr 的位数
  const [mantissa = "", expPart = "0"] = x.toExponential().split("e");
  const exp = Number(expPart);
  const neg = mantissa.startsWith("-");
  const sign = neg ? "-" : "";
  const digits = (neg ? mantissa.slice(1) : mantissa).replace(".", "");

  if (exp <= -5 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const es = exp < 0 ? "-" : "+";
    return `${sign}${m}e${es}${Math.abs(exp).toString().padStart(2, "0")}`;
  }
  if (exp >= 0) {
    const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, "0");
    const frac = digits.slice(exp + 1);
    return `${sign}${intPart}.${frac === "" ? "0" : frac}`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}
