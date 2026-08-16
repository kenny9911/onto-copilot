/**
 * Python `difflib.SequenceMatcher` 的移植。移植自 CPython `Lib/difflib.py`，
 * 由 `golden/onto.conflict.json` 的 `seqmatch` 一节钉住（ratio / matching blocks /
 * opcodes 三样都对）。
 *
 * **为什么必须自己写一份**：`conflict.py` 的 `_widest_pair`（同名属性里字面差得
 * 最远的两条）和 `undescribed_diff`（"差在哪几个字"）的输出**完全**由这个算法
 * 决定 —— 换一个"看起来差不多"的相似度实现，冲突报出来的证据片段就变了，
 * 而证据片段是这条冲突可信的全部理由。npm 上的 diff 包用的是别的算法
 * （Myers / patience），得不到同一组 opcodes。
 *
 * **按 code point 而不是 UTF-16 code unit 比**：Python 迭代字符串给的是 code
 * point，口径正文里全是中文（BMP，两者一致）但也可能混进 emoji（星平面，
 * JS 会拆成两个代理项）。拆开之后 `ratio()` 的分母、opcodes 的下标全错位，
 * 切出来的片段还会是半个字符。所以对外只收 code point 数组，
 * 由 {@link toCodePoints} 转。
 *
 * 只移植 `conflict.py` / `align.py` 真正用到的三个出口（`ratio`、
 * `get_matching_blocks`、`get_opcodes`），不做 `get_grouped_opcodes` /
 * `quick_ratio` 这些没人调的。
 */

/** Python 迭代字符串的单位。`[...s]` 按 code point 切，代理对不会被劈开。 */
export function toCodePoints(s: string): string[] {
  return [...s];
}

/** Python 的 `sorted()` 按 code point 比字符串；JS 默认 sort 按 UTF-16 code unit。
 * BMP 内两者一致，只有星平面（emoji、CJK 扩展 B）才分叉 —— 而 rid / 别名 /
 * 词元里出现 emoji 并不稀奇。 */
export function cmpCodePoint(a: string, b: string): number {
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

/** `difflib.Match` —— a 的起点、b 的起点、长度。 */
export interface Match {
  readonly a: number;
  readonly b: number;
  readonly size: number;
}

export type OpcodeTag = "replace" | "delete" | "insert" | "equal";

/** `get_opcodes()` 的一行：`(tag, i1, i2, j1, j2)`。 */
export interface Opcode {
  readonly tag: OpcodeTag;
  readonly i1: number;
  readonly i2: number;
  readonly j1: number;
  readonly j2: number;
}

export class SequenceMatcher {
  private readonly a: readonly string[];
  private readonly b: readonly string[];
  private readonly autojunk: boolean;
  private readonly isjunk: ((elt: string) => boolean) | null;

  /** b 的元素 → 它在 b 里出现的全部下标（**升序**，find_longest_match 的
   * `if j >= bhi: break` 依赖这个升序）。 */
  private readonly b2j = new Map<string, number[]>();
  private readonly bjunk = new Set<string>();
  private readonly bpopular = new Set<string>();

  private cachedBlocks: Match[] | null = null;

  constructor(
    isjunk: ((elt: string) => boolean) | null,
    a: readonly string[],
    b: readonly string[],
    autojunk = true,
  ) {
    this.isjunk = isjunk;
    this.a = a;
    this.b = b;
    this.autojunk = autojunk;
    this.chainB();
  }

  /** CPython 的 `__chain_b`。 */
  private chainB(): void {
    const b = this.b;
    for (let i = 0; i < b.length; i++) {
      const elt = b[i] as string;
      const idxs = this.b2j.get(elt);
      if (idxs === undefined) this.b2j.set(elt, [i]);
      else idxs.push(i);
    }
    if (this.isjunk !== null) {
      for (const elt of this.b2j.keys()) if (this.isjunk(elt)) this.bjunk.add(elt);
      for (const elt of this.bjunk) this.b2j.delete(elt);
    }
    // 自动 junk 只在 len(b) >= 200 时启动 —— 短串上 autojunk 开关没有区别，
    // 但 align.py 走默认（开）而 conflict.py 显式关掉，形态不能想当然合并。
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of this.b2j) if (idxs.length > ntest) this.bpopular.add(elt);
      for (const elt of this.bpopular) this.b2j.delete(elt);
    }
  }

  /** CPython 的 `find_longest_match`。返回 a[alo:ahi] 与 b[blo:bhi] 里
   * **最靠前**（先 a 后 b）的最长匹配块。 */
  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b } = this;
    const isbjunk = (elt: string): boolean => this.bjunk.has(elt);
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;

    // j2len[j] = 以 a[i-1]/b[j-1] 结尾的连续匹配长度。每轮 i 重建一张新表。
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const js = this.b2j.get(a[i] as string);
      if (js !== undefined) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }

    // 向两侧吃掉非 junk 的相同元素……
    while (
      besti > alo && bestj > blo &&
      !isbjunk(b[bestj - 1] as string) && a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi && bestj + bestsize < bhi &&
      !isbjunk(b[bestj + bestsize] as string) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    // ……再吃掉紧贴着的 junk。isjunk 为 null 时这两段是死循环体（永不进入），
    // 保留是为了让这份移植能与 CPython 源码逐行对读。
    while (
      besti > alo && bestj > blo &&
      isbjunk(b[bestj - 1] as string) && a[besti - 1] === b[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi && bestj + bestsize < bhi &&
      isbjunk(b[bestj + bestsize] as string) &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  /** CPython 的 `get_matching_blocks`，含末尾那条哨兵 `(la, lb, 0)`。 */
  getMatchingBlocks(): Match[] {
    if (this.cachedBlocks !== null) return this.cachedBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      if (m.size > 0) {
        blocks.push(m);
        if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
        if (m.a + m.size < ahi && m.b + m.size < bhi) {
          queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
        }
      }
    }
    // Python 的 list.sort() 比元组 (a, b, size)，逐项比较
    blocks.sort((x, y) => x.a - y.a || x.b - y.b || x.size - y.size);

    // 相邻块合并 —— 递归切分会把一段连续匹配切成几截
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const { a: i2, b: j2, size: k2 } of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });
    this.cachedBlocks = nonAdjacent;
    return nonAdjacent;
  }

  /** CPython 的 `get_opcodes`。 */
  getOpcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const out: Opcode[] = [];
    for (const { a: ai, b: bj, size } of this.getMatchingBlocks()) {
      let tag: OpcodeTag | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag !== "") out.push({ tag, i1: i, i2: ai, j1: j, j2: bj });
      i = ai + size;
      j = bj + size;
      if (size > 0) out.push({ tag: "equal", i1: ai, i2: i, j1: bj, j2: j });
    }
    return out;
  }

  /** CPython 的 `ratio()` = `2 * 匹配元素数 / (len(a) + len(b))`，两端都空时 1.0。 */
  ratio(): number {
    let matches = 0;
    for (const m of this.getMatchingBlocks()) matches += m.size;
    const length = this.a.length + this.b.length;
    return length > 0 ? (2.0 * matches) / length : 1.0;
  }
}

/** 字符串版的便捷入口：按 code point 切开再比。 */
export function seqRatio(a: string, b: string, autojunk = true): number {
  return new SequenceMatcher(null, toCodePoints(a), toCodePoints(b), autojunk).ratio();
}
