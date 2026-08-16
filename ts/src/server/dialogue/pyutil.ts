/**
 * server 段 E 自用的 Python 语义小工具 —— **只放别处没有的那几件**。
 *
 * 已经落地、直接复用的（不要在这里再写一份）：
 * `cpSlice`/`cpLen`（`onto/parse/base.ts`）、`pyJsonDumps`（`kernel/journal.ts`，
 * 默认分隔符 `", "`/`": "`）、`pyTruthy`/`pyStr`/`pyReprList`/`pyUnquote`
 * （`server/pipeline/tables.ts`）。重写一份的必然后果是两份慢慢分叉，
 * 而分叉的症状是"同一个字符串在两个工具里截断点不一样"。
 */

/**
 * Python 的 `round(x, n)`：half-**even**，不是 JS 的 half-up。
 *
 * 抄 `onto/oir.ts:round3` 的做法：先用 `toFixed(20)` 拿到 double 的精确十进制
 * 展开，只有尾巴恰好是 `5000…0` 才是真平局，这时按末位取偶。
 * `Math.round(x*100)/100` 既是 half-up、乘法本身还会再引入一次舍入。
 *
 * 这一段里它管着三个会被人看见的数：`chat.turn` 的 confidence（2 位）、
 * `/chat` 响应里的 `usd`（4 位）、`material.list` 的「大小KB」（0 位）。
 */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x)) return x;
  // toFixed 在 |x| >= 1e21 时退化成指数记法，兜个底。
  if (Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const parts = Math.abs(x).toFixed(20).split(".");
  const int = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const keep = frac.slice(0, n).padEnd(n, "0");
  const rest = frac.slice(n);
  let digits = int + keep;
  const half = rest.replace(/0+$/, "") === "5";
  const up =
    rest !== "" && (rest[0] ?? "0") >= "5" && (!half || Number(digits.at(-1) ?? "0") % 2 === 1);
  if (up) digits = (BigInt(digits) + 1n).toString().padStart(digits.length, "0");
  const head = digits.slice(0, digits.length - n) || "0";
  const tail = n > 0 ? digits.slice(digits.length - n) : "0";
  const out = Number(`${head}.${tail}`);
  return neg ? -out : out;
}

/** Python `format(x, '.0%')`：先 ×100 再按 `.0f` 半偶入，最后补 `%`。 */
export function formatPercent0(x: number): string {
  const v = pyRound(x * 100, 0);
  return `${Object.is(v, -0) ? 0 : v}%`;
}

/** Python 的 `xs[-n:]`（这里只在 n>0 时用，保持显式）。 */
export function tailSlice<T>(xs: readonly T[], n: number): T[] {
  return n <= 0 ? [] : xs.slice(Math.max(0, xs.length - n));
}

/** Python `sorted(xs)`：按 code point。JS 默认 sort 按 UTF-16 code unit。 */
export function pySorted(xs: readonly string[]): string[] {
  return [...xs].sort((a, b) => {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
      const ra = ia.next();
      const rb = ib.next();
      if (ra.done === true && rb.done === true) return 0;
      if (ra.done === true) return -1;
      if (rb.done === true) return 1;
      const ca = ra.value.codePointAt(0) ?? 0;
      const cb = rb.value.codePointAt(0) ?? 0;
      if (ca !== cb) return ca - cb;
    }
  });
}

/**
 * `json.dumps(obj, ensure_ascii=False, indent=n)`。
 *
 * `kernel/journal.ts` 的 `pyJsonDumps` 不带 indent（它只服务落盘那一条路），
 * 而这一段有两处非要 indent 不可：写 `oir.json`（indent=1，人要 diff 它）和
 * `_say` 塞给措辞模型的事实块 —— 后者进 prompt，缩进影响模型读得懂读不懂。
 */
export function pyJsonIndent(obj: unknown, indent: number): string {
  const enc = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") {
      if (Number.isNaN(v)) return "NaN";
      if (v === Infinity) return "Infinity";
      if (v === -Infinity) return "-Infinity";
      return String(v);
    }
    if (typeof v === "string") return jsonString(v);
    const pad = "\n" + " ".repeat(indent * (depth + 1));
    const tail = "\n" + " ".repeat(indent * depth);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[${pad}${v.map((x) => enc(x, depth + 1)).join("," + pad)}${tail}]`;
    }
    const entries =
      v instanceof Map
        ? [...v].map(([k, x]) => [String(k), x] as const)
        : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, x]) => `${jsonString(k)}: ${enc(x, depth + 1)}`)
      .join("," + pad);
    return `{${pad}${body}${tail}}`;
  };
  return enc(obj, 0);
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** `ensure_ascii=False` 的字符串编码：非 ASCII 原样出，控制字符走 \uXXXX。 */
function jsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc !== undefined) {
      out += esc;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x20 ? `\\u${cp.toString(16).padStart(4, "0")}` : ch;
  }
  return `${out}"`;
}

/**
 * Python 的 `type(exc).__name__`。
 *
 * 用 `constructor.name` 而不是 `err.name`：`class Foo extends Error {}` 不显式设
 * `this.name` 时 `err.name` 还是 `"Error"`，而 Python 那边印的是子类名。这条串会
 * 原样进工具回执给模型看（"执行「x」时出错了：KeyError: …"），错了模型就学不会自纠。
 */
export function excName(e: unknown): string {
  if (e === null || e === undefined) return "NoneType";
  const ctor = (e as { constructor?: { name?: string } }).constructor;
  if (typeof ctor?.name === "string" && ctor.name !== "") return ctor.name;
  return typeof e;
}

/** Python 的 `str(exc)`：只有消息正文，没有类名前缀。 */
export function excText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
