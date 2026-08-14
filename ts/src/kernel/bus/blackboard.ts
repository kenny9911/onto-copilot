/**
 * 黑板 —— agent 之间的共享事实层。移植自 Python 侧 `kernel/bus/blackboard.py`，
 * 由 golden/bus.json 钉住（fnmatch 真值表 + 1280 条模糊向量 + 黑板 op 程序）。
 *
 * **为什么不让 agent 自由对话。** 自由对话有三个致命问题：消息顺序不确定会破坏
 * 重放；token 无界增长；事后说不清"到底是谁认定了这件事"。所以本内核里 agent 间
 * 的一切通信都是**有类型、有记账**的。
 *
 * 黑板承载"很多节点都要用、但不在 DAG 直接路径上"的事实：术语映射、抽取过程中
 * 发现的命名约定、某个 ObjectType 的主键判定。写入 append-only 且带版本。
 *
 * **冲突不是噪声，是信号。** 两个 agent 对同一个 key 写了不同的值，恰恰就是
 * 「计划金额」双口径这类问题的机器表现形式。所以黑板不做 last-write-wins，
 * 而是把两个版本都留着、标记争议，交给 Critic 与澄清引擎去处理。静默覆盖会让
 * 系统丢掉它唯一一次发现矛盾的机会。
 *
 * ── TS 侧多出来的三件事（Python 侧不存在，因为标准库替它做了）──
 *   1. `fnmatchcase` 是手写的。它是 `ScopeSpec.blackboardPattern` 的执行体，
 *      也就是 DAG 作用域隔离的实际判据 —— 匹配范围一宽，节点就能读到不该读的
 *      上游状态。整段实现逐字对着 CPython 3.12 的 `fnmatch.translate` 写。
 *   2. 排序、切片、长度一律按 **code point**。Python 的 str 是 code point 序列，
 *      JS 的是 UTF-16 code unit 序列 —— 键里出现 emoji 就分叉。
 *   3. `formatFixed2` 是手写的（`toFixed(2)` 舍入规则与 CPython 不同）。
 */

import { canonicalJson } from "../ids.js";

// ══════════════════════════════════════════════════════════════════
//  code point 原语
// ══════════════════════════════════════════════════════════════════
// Python 的 str 索引/切片/比较/len 全按 code point；JS 全按 UTF-16 code unit。
// 只要串里有一个非 BMP 字符（emoji、部分生僻字），两套语义就分叉。黑板的 key
// 来自术语名和文件名，emoji 不是理论可能性。

/** 展开成 code point 数组。落单的代理码元会原样保留成一个元素（Python 同）。 */
function toCodePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) as number);
  return out;
}

/** code point 数（== Python 的 `len(s)`）。 */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** `s[:n]`（按 code point，且**不**做任何清尾美化 —— 美化就是分叉）。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/**
 * Python `sorted()` 对 str 的比较基准：逐 code point。
 *
 * JS 默认 `Array.sort()` 按 UTF-16 code unit —— BMP 内两者一致，键里出现代理对
 * 才分叉（golden 的 `sort_order_is_by_code_point` 用例专钉这条：Python 把 "😀"
 * 排在 "￿" 之后，JS 默认排序会把它排到前面）。
 *
 * ids.ts 里有一份同样的比较器，但它是模块私有的（契约 §5 列的导出符号里没有
 * 它），所以这里只能再写一遍 —— 不是没看见，是够不着。
 */
export function codePointCompare(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true && rb.done === true) return 0;
    if (ra.done === true) return -1;
    if (rb.done === true) return 1;
    const ca = ra.value.codePointAt(0) as number;
    const cb = rb.value.codePointAt(0) as number;
    if (ca !== cb) return ca - cb;
  }
}

// ══════════════════════════════════════════════════════════════════
//  fnmatch —— 与 CPython `fnmatch.fnmatchcase` 等价
// ══════════════════════════════════════════════════════════════════
/*
 * 为什么不生成 JS 正则再交给引擎跑（那才是"翻译"的直觉做法）：
 *
 *   1. CPython 的 `translate()` 产出里有**原子组** `(?>.*?fixed)`，V8 不支持。
 *      去掉原子性不改变"是否匹配"（每段 fixed 都被 `*` 隔开，取最早出现位置
 *      永远是最优的），但会把最坏复杂度打回指数级。
 *   2. 它的转义是按 Python `re` 的方言做的：`\&` `\~` `\|` 以及 `re.escape`
 *      产出的 `\ `（反斜杠+空格）、`\<制表符>` 在 JS 的 `u` 模式下全是
 *      **SyntaxError**；不开 `u` 又会退回 UTF-16 语义（`?` 只吃半个 emoji）。
 *   3. `[]]` 在 Python `re` 里是「含 ']' 的字符类」，在 JS 里是「空类 + 字面
 *      量 ']'」—— 同一串字节，两个语言给出两种解析。
 *
 * 所以这里直接把模式编译成 token 序列自己匹配。**字符类的语义仍然逐字照抄
 * CPython**：先按 `translate()` 的 chunk 切分算法切出区间边界，再按 `sre` 解析
 * 字符类的规则（连字符只有在"未转义、且后面还有字符"时才是区间符）判定成员。
 * 两层都照抄，是因为它们的交互会产生反直觉的结果，例如
 * `[a-c-e]` = {a..c, '-', 'e'}，而不是 {a..c, c..e}。
 */

const CP_STAR = 0x2a; // *
const CP_QMARK = 0x3f; // ?
const CP_LBRACK = 0x5b; // [
const CP_RBRACK = 0x5d; // ]
const CP_BANG = 0x21; // !
const CP_DASH = 0x2d; // -

/** 一个编译后的模式元素。`star` 吃任意长度，其余各吃一个 code point。 */
type Token =
  | { readonly kind: "star" }
  | { readonly kind: "any" }
  | { readonly kind: "lit"; readonly cp: number }
  | {
      readonly kind: "cls";
      readonly neg: boolean;
      readonly chars: ReadonlySet<number>;
      readonly ranges: readonly (readonly [number, number])[];
    };

/** `null` 表示"整个模式永不匹配"（对应 CPython 译出的 `(?!)`）。 */
type Compiled = readonly Token[] | null;

/** 字符类里的一个原子：`escaped` 记录它在 CPython 译文里是否被反斜杠转义过 ——
 * 未转义的 `-` 才是区间符，这一位是区分区间和字面量连字符的唯一依据。 */
interface Atom {
  readonly cp: number;
  readonly escaped: boolean;
}

function indexOfCp(arr: readonly number[], cp: number, from: number, to: number): number {
  for (let i = from; i < to; i += 1) {
    if (arr[i] === cp) return i;
  }
  return -1;
}

/**
 * 解析 `pat[i0:j]`（方括号之间的内容，含可能的前导 `!`）。
 *
 * 返回 `null` 表示空集（CPython 译成 `(?!)`，于是整个模式永不匹配）；
 * 返回 `{kind:"any"}` 对应 CPython 的「否定空集 → `.`」。
 */
function parseCharClass(P: readonly number[], i0: number, j: number): Token | null {
  const S = P.slice(i0, j);

  // ── 第一层：切 chunk（照抄 translate 的 '-' 处理）──
  let chunks: number[][];
  if (!S.includes(CP_DASH)) {
    // 没有连字符就没有区间，整段都是字面量（CPython 这里只转义反斜杠）。
    chunks = [S];
  } else {
    chunks = [];
    let cur = i0;
    // 紧跟 '[' 或 '[!' 的那个字符是第一个成员，不可能是区间符的左侧之后 ——
    // 所以搜索从它的下一位开始，`[-a]` 里的 '-' 才会被当成字面量。
    let k = P[i0] === CP_BANG ? i0 + 2 : i0 + 1;
    for (;;) {
      k = indexOfCp(P, CP_DASH, k, j);
      if (k < 0) break;
      chunks.push(P.slice(cur, k));
      cur = k + 1;
      k = k + 3; // 跳过区间右端点：`a-c-e` 里第二个 '-' 不是区间符
    }
    const tail = P.slice(cur, j);
    if (tail.length > 0) chunks.push(tail);
    else (chunks[chunks.length - 1] as number[]).push(CP_DASH); // 末尾的 '-' 是字面量

    // 去掉逆序区间（`[b-a]`）：正则里空区间是语法错误，CPython 把两个端点
    // 一起丢掉再把左右拼起来。丢空了就是空集 → 永不匹配。
    for (let m = chunks.length - 1; m >= 1; m -= 1) {
      const a = chunks[m - 1] as number[];
      const b = chunks[m] as number[];
      // CPython 在这里直接取 a[-1]/b[0]，空 chunk 会 IndexError。按 chunk 的
      // 长度下界（中间 chunk 至少 2 个字符）可以证明它不可达；真到了就说明
      // 上面的切分抄错了，宁可炸也不要静默给出一个不同的匹配范围。
      if (a.length === 0 || b.length === 0) {
        throw new Error(`fnmatch: 字符类切分出空 chunk，模式片段 ${JSON.stringify(S)}`);
      }
      if ((a[a.length - 1] as number) > (b[0] as number)) {
        chunks[m - 1] = a.slice(0, -1).concat(b.slice(1));
        chunks.splice(m, 1);
      }
    }
  }

  // ── 第二层：拼成 CPython 译文的原子序列 ──
  // chunk 内部的 `\ - & ~ |` 会被 translate 转义，chunk **之间**的连字符是区间符。
  const atoms: Atom[] = [];
  for (let m = 0; m < chunks.length; m += 1) {
    if (m > 0) atoms.push({ cp: CP_DASH, escaped: false });
    for (const cp of chunks[m] as number[]) {
      // 0x5c \  0x2d -  0x26 &  0x7e ~  0x7c |
      const escaped = cp === 0x5c || cp === CP_DASH || cp === 0x26 || cp === 0x7e || cp === 0x7c;
      atoms.push({ cp, escaped });
    }
  }

  // 前导 '!' → 否定。CPython 的判据是 `stuff[0] == '!'`，而 '!' 从不被转义。
  let neg = false;
  const first = atoms[0];
  if (first !== undefined && first.cp === CP_BANG && !first.escaped) {
    neg = true;
    atoms.shift();
  }
  // CPython 先判空集、再判 `stuff == '!'`：空 → 永不匹配，单个 '!' → 任意字符。
  if (atoms.length === 0) return neg ? { kind: "any" } : null;

  // ── 第三层：按 sre 解析字符类的规则定成员 ──
  const chars = new Set<number>();
  const ranges: [number, number][] = [];
  let p = 0;
  while (p < atoms.length) {
    const c1 = (atoms[p] as Atom).cp;
    p += 1;
    const sep = atoms[p];
    if (sep !== undefined && sep.cp === CP_DASH && !sep.escaped) {
      p += 1;
      const hi = atoms[p];
      if (hi === undefined) {
        // 源里紧跟的是 ']' —— sre 把这个 '-' 当字面量，然后类就结束了。
        chars.add(c1);
        chars.add(CP_DASH);
        break;
      }
      p += 1;
      if (hi.cp < c1) {
        // CPython 上面的合并步骤保证不会走到这里；走到了就是 re.error。
        throw new Error(`fnmatch: 非法字符区间 ${c1}-${hi.cp}`);
      }
      ranges.push([c1, hi.cp]);
    } else {
      chars.add(c1);
    }
  }
  return { kind: "cls", neg, chars, ranges };
}

function compilePattern(pat: string): Compiled {
  const P = toCodePoints(pat);
  const n = P.length;
  const toks: Token[] = [];
  let i = 0;
  while (i < n) {
    const c = P[i] as number;
    i += 1;
    if (c === CP_STAR) {
      // 连续的 `*` 压成一个 —— 否则 `**` 会退化成两段独立回溯。
      const last = toks[toks.length - 1];
      if (last === undefined || last.kind !== "star") toks.push({ kind: "star" });
    } else if (c === CP_QMARK) {
      toks.push({ kind: "any" });
    } else if (c === CP_LBRACK) {
      // 找右方括号：紧跟的 '!' 以及它之后的**第一个** ']' 都算内容，
      // 所以 `[]]` 是「含 ']' 的类」而 `[]` 是字面量两个字符。
      let j = i;
      if (j < n && P[j] === CP_BANG) j += 1;
      if (j < n && P[j] === CP_RBRACK) j += 1;
      while (j < n && P[j] !== CP_RBRACK) j += 1;
      if (j >= n) {
        // 没有右方括号 → '[' 退化成字面量，后面的字符照常逐个处理。
        toks.push({ kind: "lit", cp: CP_LBRACK });
      } else {
        const cls = parseCharClass(P, i, j);
        i = j + 1;
        if (cls === null) return null; // 空集出现在任何位置 → 整个模式永不匹配
        toks.push(cls);
      }
    } else {
      toks.push({ kind: "lit", cp: c });
    }
  }
  return toks;
}

// Python 侧 `_compile_pattern` 挂了 `lru_cache(32768)`。这里必须有等价的缓存：
// `keys(pattern)` 会对每个 key 调一次 fnmatchcase，没缓存就是每个 key 重编译
// 一次模式。上限到了整表清空（而不是做 LRU）—— 命中率在这个场景下由"模式集合
// 很小"保证，复杂的淘汰策略换不来什么。
const PATTERN_CACHE = new Map<string, Compiled>();
const PATTERN_CACHE_MAX = 4096;

function compileCached(pat: string): Compiled {
  const hit = PATTERN_CACHE.get(pat);
  if (hit !== undefined) return hit; // 存进去的只可能是数组或 null，不会是 undefined
  const compiled = compilePattern(pat);
  if (PATTERN_CACHE.size >= PATTERN_CACHE_MAX) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(pat, compiled);
  return compiled;
}

function tokenMatches(tok: Token, cp: number): boolean {
  switch (tok.kind) {
    case "any":
      // CPython 译文外面包着 `(?s:…)`，所以 `?` 也吃换行。
      return true;
    case "lit":
      return tok.cp === cp;
    case "cls": {
      let inSet = tok.chars.has(cp);
      if (!inSet) {
        for (const [lo, hi] of tok.ranges) {
          if (cp >= lo && cp <= hi) {
            inSet = true;
            break;
          }
        }
      }
      return tok.neg ? !inSet : inSet;
    }
    case "star":
      // 调用方保证不会拿 star 走到这里。
      return false;
  }
}

/**
 * == Python `fnmatch.fnmatchcase(name, pat)`（注意实参顺序也照抄）。
 *
 * 匹配用经典的 glob 双指针贪心：遇到 `*` 记下回退点，失配就把 `*` 多吃一个
 * 字符再试。最坏 O(n·m)，不会像正则回溯那样爆炸 —— 模式来自 DAG 的作用域
 * 声明，虽然是开发者写的，但它决定的是安全边界，不该有可被拖垮的路径。
 */
export function fnmatchcase(name: string, pat: string): boolean {
  const toks = compileCached(pat);
  if (toks === null) return false;
  const S = toCodePoints(name);

  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starSi = 0;
  while (si < S.length) {
    const tok = toks[ti];
    if (tok !== undefined && tok.kind === "star") {
      starTi = ti;
      starSi = si;
      ti += 1;
    } else if (tok !== undefined && tokenMatches(tok, S[si] as number)) {
      ti += 1;
      si += 1;
    } else if (starTi >= 0) {
      starSi += 1;
      si = starSi;
      ti = starTi + 1;
    } else {
      return false;
    }
  }
  while (ti < toks.length && (toks[ti] as Token).kind === "star") ti += 1;
  return ti === toks.length;
}

// ══════════════════════════════════════════════════════════════════
//  Python `format(x, ".2f")`
// ══════════════════════════════════════════════════════════════════
/**
 * **不要**用 `x.toFixed(2)` 代替 —— 舍入规则不同，render 的字节会偏：
 *
 *   x        CPython .2f          JS toFixed(2)
 *   0.125    "0.12"（半偶）        "0.13"（半远离零）
 *   0.625    "0.62"               "0.63"
 *   -0.125   "-0.12"              "-0.13"
 *   inf/nan  "inf" / "nan"        "Infinity" / "NaN"
 *
 * 只有当 double 的**精确**二进制值正好落在两个两位小数的正中间时两者才分叉，
 * 也就是小数部分是 1/8 的奇数倍（0.125 / 0.375 / 0.625 / 0.875）。置信度取
 * 0.875 一点都不离奇，golden 的 `render_confidence_two_decimals` 就钉着这一组。
 *
 * 判据必须落在精确值上，所以走 BigInt 把 double 还原成精确有理数
 * （double 都是 m·2^e 形式的二进制有理数，分母是 2 的幂，可以精确表示）。
 * errors.ts 的 `formatFixed0` 用的是浮点判据 —— 那是因为 `.0f` 的半整数在
 * |x|<2^52 内可精确表示、减法无误差；到了两位小数这个前提不成立。
 */
export function formatFixed2(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";

  // 符号取自输入而不是结果：Python 对 -0.0 和 -0.001 都给 "-0.00"。
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const m = Math.abs(x);

  // m = num / den，精确。
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, m);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xf_ffff) << 32n) | BigInt(lo);
  let e: number;
  if (expBits === 0) {
    e = -1074; // 次正规数没有隐含的前导 1
  } else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  let num: bigint;
  let den: bigint;
  if (e >= 0) {
    num = mant << BigInt(e);
    den = 1n;
  } else {
    num = mant;
    den = 1n << BigInt(-e);
  }

  const scaled = num * 100n;
  let q = scaled / den; // 两个正数，BigInt 除法就是 floor
  const r = scaled - q * den;
  const twice = r * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && q % 2n === 1n) q += 1n; // 正中间：向偶数舍入

  const s = q.toString().padStart(3, "0");
  return `${sign}${s.slice(0, -2)}.${s.slice(-2)}`;
}

// ══════════════════════════════════════════════════════════════════
//  Revision / Entry
// ══════════════════════════════════════════════════════════════════

/** 一次写入。 */
export interface Revision {
  readonly rev: number;
  readonly key: string;
  readonly value: unknown;
  readonly by: string; // 写入者：节点 id 或 agent 名
  readonly support: readonly string[]; // evidence locator / 事件引用
  readonly confidence: number;
  readonly note: string;
}

export interface RevisionInit {
  readonly rev: number;
  readonly key: string;
  readonly value: unknown;
  readonly by: string;
  readonly support?: readonly string[];
  readonly confidence?: number;
  readonly note?: string;
}

/** 默认值写在工厂里而不是类字段上（见契约 §1）。 */
export function makeRevision(p: RevisionInit): Revision {
  return Object.freeze({
    rev: p.rev,
    key: p.key,
    value: p.value,
    by: p.by,
    // 每次新数组：Python 侧存的是 tuple（不可变），这里靠复制 + freeze 拿到
    // 同样的保证，否则调用方后续改自己那个数组会追改已写进日志的版本。
    support: Object.freeze([...(p.support ?? [])]),
    confidence: p.confidence ?? 0.5,
    note: p.note ?? "",
  });
}

/** 事件 payload 形态（字段名与 Python `Revision.to_dict()` 逐字一致）。 */
export function revisionToDict(r: Revision): Record<string, unknown> {
  return {
    rev: r.rev,
    key: r.key,
    value: r.value,
    by: r.by,
    support: [...r.support],
    confidence: r.confidence,
    note: r.note,
  };
}

/** 一个 key 的完整历史。 */
/**
 * 黑板上一个值的**身份**（用于判分歧、归并同值版本）。
 *
 * 纯数据走 `canonicalJson` —— 结构相同即同一个值，跨进程稳定。
 *
 * **非纯数据（函数、类实例）回落到对象身份**，而不是把它序列化成字符串。
 * 这里有一条 Python 侧的潜伏 bug 不能跟着抄：`canonical_json` 带 `default=str`
 * 兜底，一个函数会被序列化成 `"<function f at 0x1043062a0>"` —— **里面是内存
 * 地址**。同一个逻辑值在两个进程里因此算出两个不同的指纹，而 `ids.py` 自己的
 * 文件头写着「重放要求 ID 可复现，内核里不允许 uuid4 / random」。它不崩，
 * 所以一直没人发现。
 *
 * 黑板上确实存活对象：`_tools` 写的就是工具注册表本身（`pipeline.ts` 从这里取）。
 * 对这类值，「同一个句柄 = 同一个值」正是 `contested` 想问的问题，而对象身份
 * 恰好回答它，且**不假装**自己跨进程可复现。
 */
const IDENTITY = new WeakMap<object, string>();
let identitySeq = 0;

function valueKey(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    // canonicalJson 只对非纯数据抛（函数 / symbol / 类实例）。
    if (typeof value === "object" && value !== null) {
      let id = IDENTITY.get(value);
      if (id === undefined) {
        id = `\u0000opaque#${++identitySeq}`;
        IDENTITY.set(value, id);
      }
      return id;
    }
    // 函数本身不是 object 的 typeof，但可以做 WeakMap 的键
    if (typeof value === "function") {
      let id = IDENTITY.get(value as unknown as object);
      if (id === undefined) {
        id = `\u0000opaque#${++identitySeq}`;
        IDENTITY.set(value as unknown as object, id);
      }
      return id;
    }
    return `\u0000opaque:${String(typeof value)}`;
  }
}

export class Entry {
  readonly key: string;
  readonly revisions: Revision[];

  constructor(key: string, revisions: Revision[] = []) {
    this.key = key;
    this.revisions = revisions;
  }

  /** 当前采信的版本：可信度最高，同分取最新。 */
  get current(): Revision {
    const first = this.revisions[0];
    if (first === undefined) {
      // Python 是 `max([])` 的 ValueError。空 Entry 只可能来自外部直接构造 ——
      // write/replay 两条路都是先造 Entry 再立刻追加版本。
      throw new Error(`Entry(${JSON.stringify(this.key)}) 没有任何版本`);
    }
    let best = first;
    for (const r of this.revisions) {
      // 严格大于：Python 的 max 在并列时留**第一个**，这里必须一致。
      if (r.confidence > best.confidence || (r.confidence === best.confidence && r.rev > best.rev)) {
        best = r;
      }
    }
    return best;
  }


  /** 是否存在实质分歧（值不同，而非同值被重复确认）。 */
  get contested(): boolean {
    const seen = new Set<string>();
    for (const r of this.revisions) {
      seen.add(valueKey(r.value));
      if (seen.size > 1) return true;
    }
    return false;
  }

  /** 每个不同取值保留一个代表版本，按可信度降序。 */
  get variants(): Revision[] {
    // 必须用 Map：分组键是 canonicalJson 的结果，值为整数时就是 "1" 这种
    // 整数形字符串，普通对象会把它们重排到最前面（V8 对整数键特殊对待）。
    const best = new Map<string, Revision>();
    for (const r of this.revisions) {
      const k = valueKey(r.value);
      const cur = best.get(k);
      if (cur === undefined || r.confidence > cur.confidence ||
        (r.confidence === cur.confidence && r.rev > cur.rev)) {
        best.set(k, r);
      }
    }
    // 键 (-confidence, rev)。Array.sort 自 ES2019 起稳定，与 Python 的 sorted 同。
    return [...best.values()].sort((a, b) => b.confidence - a.confidence || a.rev - b.rev);
  }

  /** 写过这个 key 的人，去重且保持首次出现顺序（== `dict.fromkeys`）。 */
  writers(): string[] {
    return [...new Set(this.revisions.map((r) => r.by))];
  }
}

/** 订阅回调：(key, 新版本, 是否新产生分歧)。 */
export type Watcher = (key: string, rev: Revision, newlyContested: boolean) => void;

// ══════════════════════════════════════════════════════════════════
//  Blackboard
// ══════════════════════════════════════════════════════════════════

export interface WriteOptions {
  readonly by: string;
  readonly support?: readonly string[];
  readonly confidence?: number;
  readonly note?: string;
}

/**
 * 共享事实黑板。
 *
 * key 建议用命名空间形式：`glossary/采购包`、`naming/apiName_style`、
 * `oir/ot_purchase_plan/primaryKey`。订阅按 glob 匹配。
 */
export class Blackboard {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers: [string, Watcher][] = [];
  private rev = 0;

  // ── 写 ──────────────────────────────────────────────────────
  /**
   * 写入一条事实。
   *
   * 返回 `[revision, newlyContested]`。`newlyContested` 为真表示这次写入
   * **新产生**了分歧 —— 调度器据此把冲突推给 Critic。
   */
  write(key: string, value: unknown, opts: WriteOptions): [Revision, boolean] {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = new Entry(key);
      this.entries.set(key, entry);
    }
    const was = entry.contested;
    this.rev += 1;
    const rev = makeRevision({
      rev: this.rev,
      key,
      value,
      by: opts.by,
      support: opts.support ?? [],
      confidence: opts.confidence ?? 0.5,
      note: opts.note ?? "",
    });
    entry.revisions.push(rev);
    const newly = entry.contested && !was;

    for (const [pattern, cb] of this.watchers) {
      if (fnmatchcase(key, pattern)) cb(key, rev, newly);
    }
    return [rev, newly];
  }

  // ── 读 ──────────────────────────────────────────────────────
  read(key: string, defaultValue: unknown = null): unknown {
    const e = this.entries.get(key);
    return e !== undefined ? e.current.value : defaultValue;
  }

  /** Python 返回 `Entry | None`；这里用 `undefined`（Map.get 的自然形态）。 */
  entry(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  keys(pattern = "*"): string[] {
    const out: string[] = [];
    for (const k of this.entries.keys()) {
      if (fnmatchcase(k, pattern)) out.push(k);
    }
    return out.sort(codePointCompare);
  }

  /** 所有存在分歧的条目 —— 冲突检测阶段的输入之一。按插入序，同 Python。 */
  contested(): Entry[] {
    return [...this.entries.values()].filter((e) => e.contested);
  }

  /**
   * 返回 `Map` 而不是普通对象：Python 的 dict 保持这里的排序结果，而 JS 的
   * 普通对象会把整数形字符串键（"2" / "10" 这种）提到最前并按数值排 ——
   * 黑板的 key 是自由字符串，没有理由假设它不会长成那样。
   */
  snapshot(pattern = "*"): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const k of this.keys(pattern)) {
      out.set(k, (this.entries.get(k) as Entry).current.value);
    }
    return out;
  }

  // ── 订阅 ────────────────────────────────────────────────────
  /** 按 glob 订阅。用于让 Critic 在分歧一出现就介入，而不是等到阶段末尾。 */
  watch(pattern: string, callback: Watcher): void {
    this.watchers.push([pattern, callback]);
  }

  // ── 渲染 ────────────────────────────────────────────────────
  /**
   * 装进 prompt 的形态。争议条目会把所有变体和各自的出处一起给出去 ——
   * 模型要能看见分歧才可能正确处理它。
   *
   * Python 侧 `limit` 是 keyword-only，这里退化成第二个位置参数。
   */
  render(pattern = "*", limit = 60): string {
    const lines: string[] = [];
    for (const k of this.keys(pattern).slice(0, limit)) {
      const e = this.entries.get(k) as Entry;
      if (!e.contested) {
        const r = e.current;
        lines.push(`· ${k} = ${fmtValue(r.value)}　（${r.by}）`);
        continue;
      }
      const variants = e.variants;
      lines.push(`· ${k} ⚠ 存在 ${variants.length} 种说法：`);
      for (const v of variants) {
        const src = v.support.length > 0 ? `，出处 ${v.support.slice(0, 3).join("、")}` : "";
        lines.push(
          `    - ${fmtValue(v.value)}　（${v.by}，置信 ${formatFixed2(v.confidence)}${src}）`,
        );
      }
    }
    return lines.join("\n");
  }

  // ── 重放重建 ────────────────────────────────────────────────
  /** 从事件日志重建黑板状态。恢复 Run 时用。 */
  replay(revisions: readonly Record<string, unknown>[]): void {
    for (const d of revisions) {
      const key = expectString(d, "key");
      const rev = expectNumber(d, "rev");
      let entry = this.entries.get(key);
      if (entry === undefined) {
        entry = new Entry(key);
        this.entries.set(key, entry);
      }
      entry.revisions.push(
        makeRevision({
          rev,
          key,
          value: d["value"],
          by: expectString(d, "by"),
          support: optSupport(d),
          confidence: optNumber(d, "confidence", 0.5),
          note: optString(d, "note", ""),
        }),
      );
      this.rev = Math.max(this.rev, rev);
    }
  }

  /** == Python 的 `__len__`。 */
  get size(): number {
    return this.entries.size;
  }
}

// 日志是外部输入，形状不由本进程保证。Python 走 `d["key"]` 的 KeyError，
// 这里给条能读的错误 —— 和 events.ts 的 `eventFromDict` 同一套"越早拒越好"。
function expectString(d: Record<string, unknown>, field: string): string {
  const v = d[field];
  if (typeof v !== "string") {
    throw new Error(`黑板版本的 ${field} 不是字符串: ${JSON.stringify(d)}`);
  }
  return v;
}

function expectNumber(d: Record<string, unknown>, field: string): number {
  const v = d[field];
  if (typeof v !== "number") {
    throw new Error(`黑板版本的 ${field} 不是数字: ${JSON.stringify(d)}`);
  }
  return v;
}

function optNumber(d: Record<string, unknown>, field: string, fallback: number): number {
  const v = d[field];
  if (v === undefined) return fallback;
  if (typeof v !== "number") {
    throw new Error(`黑板版本的 ${field} 不是数字: ${JSON.stringify(d)}`);
  }
  return v;
}

function optString(d: Record<string, unknown>, field: string, fallback: string): string {
  const v = d[field];
  if (v === undefined) return fallback;
  if (typeof v !== "string") {
    throw new Error(`黑板版本的 ${field} 不是字符串: ${JSON.stringify(d)}`);
  }
  return v;
}

function optSupport(d: Record<string, unknown>): readonly string[] {
  const v = d["support"];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`黑板版本的 support 不是字符串数组: ${JSON.stringify(d)}`);
  }
  return v as string[];
}

/**
 * 值在 prompt 里的形态。导出只为让 golden 测试能直接钉它（Python 侧是模块私有的
 * `_fmt`，但它决定 render 的字节，不该只能间接测）。
 *
 * 截断按 code point：`limit` 是 Python 的 `len(s)`，用 JS 的 `.length` 会把
 * 一个 emoji 算成两格，长度恰好在边界上的值就会被切成不同的样子。
 */
export function fmtValue(value: unknown, limit = 90): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = canonicalJson(value);
    } catch {
      // 黑板上存得下活对象（`_tools` 就是工具注册表本身）。渲染进 prompt 时
      // 不能因此整条链路崩掉，但**也不能**学 Python 用 `default=str` 打印出
      // `<function f at 0x1043062a0>` —— 那个内存地址会进模型上下文、进事件
      // 日志，既没有信息量又让同一份内容在两次运行里长得不一样。
      s = `<${typeof value}>`;
    }
  }
  return cpLength(s) <= limit ? s : cpSlice(s, limit) + "…";
}
