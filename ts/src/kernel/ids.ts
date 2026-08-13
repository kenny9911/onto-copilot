/**
 * 稳定 ID 与内容寻址 —— 与 Python 侧 `kernel/ids.py` **字节级一致**，
 * 由 golden/ids.json 钉住。
 *
 * 重放要求 ID 可复现，所以内核里不允许 uuid4 / random。两种合法来源：
 *   1. 内容寻址 —— 由内容 sha256 导出，天然去重、天然幂等；
 *   2. 结构化路径 —— 由 (run_id, node_id, 序号) 拼出。
 *
 * 为什么不用 JSON.stringify：canonical_json 是 effect 指纹的唯一底座，而
 * Python 与 JS 的 JSON 序列化在最阴的地方不等价 ——
 *
 *   Python json.dumps(1.0)  → "1.0"      JSON.stringify(1)  → "1"
 *   Python json.dumps(-0.0) → "-0.0"     JSON.stringify(-0) → "0"
 *   sort_keys 按 code point 排            Array.sort 按 UTF-16 code unit 排
 *
 * 前两条靠手写数字格式化对齐（-0 显式写成 "-0.0"）；第三条靠 code point
 * 比较器对齐（BMP 内两者本来一致，代理对键上才分叉）。
 *
 * **已知且被钉住的分叉**：JS 里 1 与 1.0 是同一个值，无从区分。Python 内存里
 * 值为整数的 float（confidence=1.0 这类）序列化成 "1.0"，TS 侧只能给 "1"。
 * 后果是 **effect 指纹跨语言不可移植** —— TS 跑的 Run 重放 TS 自己的日志没
 * 问题（自洽），但拿 Python 时代的 journal 来重放会 fingerprint 不匹配。
 * 这是语言边界，不是 bug；golden 测试里把这一条钉成"已知差异"而不是绕过。
 */

import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return h.digest("hex");
}

/** 内容寻址引用，如 `blob:3f2a…`（截断到 32 位十六进制）。 */
export function contentRef(data: string | Uint8Array, prefix = "blob"): string {
  return `${prefix}:${sha256Hex(data).slice(0, 32)}`;
}

function numToJson(n: number): string {
  if (!Number.isFinite(n)) {
    // Python json.dumps 默认放行 NaN/Infinity —— 但那不是合法 JSON，指纹输入里
    // 也从未出现过。出现即 bug，抛出来比静默序列化好。
    throw new Error(`canonical_json: 不接受非有限数 ${n}`);
  }
  if (Number.isInteger(n)) return Object.is(n, -0) ? "-0.0" : String(n);
  // 非整数：JS 的 String(number) 与 Python repr(float) 同为 shortest
  // round-trip，字节一致（golden 钉着 10.25 / 0.13 / 1.5 这些）。
  return String(n);
}

function strToJson(s: string): string {
  // ensure_ascii=False：只转义引号、反斜杠和控制字符，非 ASCII 原样保留 ——
  // JSON.stringify 对字符串的行为恰好一致。
  return JSON.stringify(s);
}

/** Python str 比较是按 code point 的；JS 默认 sort 按 UTF-16 code unit。
 * BMP 内一致，键里出现代理对（emoji）才分叉 —— 这里显式按 code point 比。 */
function codePointCompare(a: string, b: string): number {
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

function toJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return numToJson(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return strToJson(v);
  if (Array.isArray(v)) return `[${v.map(toJson).join(",")}]`;
  if (v instanceof Map) return toJson(Object.fromEntries(v));
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).sort(codePointCompare);
    return `{${keys.map((k) => `${strToJson(k)}:${toJson(rec[k])}`).join(",")}}`;
  }
  // Python 侧是 default=str 兜底；JS 的 String() 对普通对象给 [object Object]，
  // 信息量为零还会静默污染指纹 —— 直接拒绝，指纹输入必须是纯数据。
  throw new Error(`canonical_json: 不接受 ${typeof v}`);
}

/** 确定性 JSON —— 键排序、无多余空白（separators=(",",":")）。 */
export function canonicalJson(obj: unknown): string {
  return toJson(obj);
}

/** 请求指纹（16 位十六进制），用于重放一致性校验。 */
export function fingerprint(obj: unknown): string {
  return sha256Hex(canonicalJson(obj)).slice(0, 16);
}

// 与 Python _SLUG_RE 同形：保留 a-z0-9 + CJK 统一表意 + 日文假名，其余换 "_"。
// CJK 必须保留 —— 只留 ASCII 的话，一整批中文名会被抹成同一个空串，
// 不同的东西拿到同一个 rid、后写的静默覆盖先写的（Python 侧真实事故）。
const SLUG_RE = /[^a-z0-9一-鿿぀-ヿ]+/g;

export function slug(text: string, maxLen = 40): string {
  // Python 是 text.strip().lower()。lower 的等价性在这里成立：保留集内只有
  // ASCII 字母有大小写，CJK/假名没有大小写映射。
  const s = text.trim().toLowerCase().replace(SLUG_RE, "_").replace(/^_+|_+$/g, "");
  if (!s) {
    // 纯符号名退化成空时用内容哈希兜底，不是常量 —— 常量会把所有这类名字
    // 折叠成同一个 id。
    return "x" + sha256Hex(text).slice(0, 8);
  }
  // Python 的 s[:max_len] 按 code point 切且**不清尾** —— 截断恰好落在 "_" 上
  // 就留着。照抄，不做"美化"：美化就是分叉。
  return [...s].slice(0, maxLen).join("");
}

/** OIR 实体的稳定 rid，如 `ot_采购订单头`。 */
export function rid(kind: string, name: string): string {
  return `${kind}_${slug(name)}`;
}

/** 结构化子 ID，如 `EXTRACT#property#3`。 */
export function childId(parent: string, ...parts: (string | number)[]): string {
  const tail = parts.map(String).join("#");
  return tail ? `${parent}#${tail}` : parent;
}
