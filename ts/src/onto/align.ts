/**
 * 实体对齐 —— 把多份材料里指向同一概念的不同名字合并成一个实体。
 * 移植自 `src/ontocopilot/onto/align.py`，由 `golden/onto.align.json` 钉住。
 *
 * `采购需求计划` / `pbpHeader` / `PurchasePlan` 常常是同一个东西。不对齐就会
 * 抽出一堆重复对象，后面的冲突检测全部失真 —— 因为"同一个字段的两个口径"会被误判成
 * "两个不同字段各有一个口径"。
 *
 * **结构证据优先于名称证据。** 名字像但结构对不上的，标存疑交人判，**不合并** ——
 * 错误合并会把两个对象的属性混在一起，之后极难拆开；漏合并只是多一条待确认项。
 * 这个不对称决定了这里所有的阈值取向。
 *
 * 流程：阻塞（避免 O(n²)）→ 成对打分 → 连通分量聚类 → 代表选举。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **字符串归一的顺序是有语义的**：`tokens()` 先抽 CJK 片段（原串上，
 *     大小写不参与），再把 CJK 挖空成空格得到拉丁部分，最后才 `lower()`。
 *     换个顺序（比如先整串 lower 再抽）在这份实现里恰好同结果，但先
 *     `_SPLIT` 后 `_CAMEL` 与反过来**不同**（`a_bC` → 前者 {a, b, c}，
 *     后者会先在 `bC` 处切出 `b`/`C` 再被下划线切）。照原样。
 *  2. **`f"{sorted(shared)}"` 印的是 Python 的 list repr**（`['plan', 'x']`，
 *     单引号 + `, `）—— 这些理由串会进审计账，必须逐字一致。复用
 *     `kernel/errors.ts` 的 `pyRepr`。
 *  3. **`round(x, 3)` 是 banker's rounding**，复用 `oir.ts` 的 `round3`。
 *  4. **`SequenceMatcher`** 没有对等物，见 `./difflib.ts`。align 这边走的是
 *     **默认 autojunk=True**（conflict 那边显式关掉），不能想当然合并。
 */

import { pyRepr } from "../kernel/errors.js";
import { SequenceMatcher, cmpCodePoint, toCodePoints } from "./difflib.js";
import { type OIR, type ObjectType, round3 } from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** `f"{['a', 'b']}"` —— Python 的 list repr。dag.ts 里有同名私有函数，
 * 两边都建立在 errors.ts 的 `pyRepr` 上，别再各写一版转义。 */
function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/** Python 的 `sorted()`：按 code point。 */
function sortedCp(items: Iterable<string>): string[] {
  return [...items].sort(cmpCodePoint);
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  return new Set([...a, ...b]);
}

// ══════════════════════════════════════════════════════════════════
//  拆词
// ══════════════════════════════════════════════════════════════════

const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])/u;
const SEP_SPLIT = /[_\-\s/]+/u;

/** 结构性后缀。`pbpHeader` 与 `purchasePlanHeader` 的 `header` 是同一个
 * 结构角色，不该作为区分度贡献相似度。 */
const STRUCTURAL: ReadonlySet<string> = new Set([
  "header", "line", "item", "detail", "master", "head",
  "头", "行", "主", "明细", "表",
]);

/** Python 侧字面写的是 `[㐀-鿿]+`，也就是 U+3400–U+9FFF。 */
const CJK_RUN = /[㐀-鿿]+/gu;

/**
 * 拆词：拉丁走 camelCase / snake_case，中文走**字符二元组**。
 *
 * 中文没有词边界。`采购计划头` 整体作为一个词元，和 `采购计划` 匹配不上 ——
 * 而业务对象名几乎全是中文，不切分等于放弃了一半的名称证据。二元组是无分词器
 * 情况下的标准做法：`采购计划头` → {采购, 购计, 计划, 划头}。
 */
export function tokens(name: string): Set<string> {
  const text = name || "";
  const out = new Set<string>();

  // 正则带 `g`，exec 会带 lastIndex 状态 —— 用 matchAll 拿一次性迭代器，
  // 避免同一个模块级正则在两次调用之间串味。
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0];
    const cps = toCodePoints(run);
    if (cps.length === 1) {
      out.add(run);
    } else {
      for (let i = 0; i < cps.length - 1; i++) out.add(cps.slice(i, i + 2).join(""));
    }
    for (const w of STRUCTURAL) if (run.includes(w)) out.add(w); // 结构词单独识别出来好剔除
  }

  const latin = text.replace(CJK_RUN, " ");
  const parts: string[] = [];
  for (const p of latin.split(SEP_SPLIT)) {
    for (const x of p.split(CAMEL_SPLIT)) if (x !== "") parts.push(x);
  }
  for (const p of parts) if (toCodePoints(p).length >= 2) out.add(p.toLowerCase());

  const core = new Set<string>();
  for (const t of out) if (!STRUCTURAL.has(t)) core.add(t);
  return core.size > 0 ? core : out; // 全是结构词就别清空了
}

// ══════════════════════════════════════════════════════════════════
//  打分
// ══════════════════════════════════════════════════════════════════

/**
 * 一对候选的打分明细。**明细必须留着** —— 合并是不可逆操作，
 * 事后要能回答"当初凭什么把这两个合了"。
 */
export interface PairScore {
  a: string;
  b: string;
  name: number;
  structure: number;
  alias: boolean;
  reasons: string[];
}

export function makePairScore(a: string, b: string): PairScore {
  return { a, b, name: 0.0, structure: 0.0, alias: false, reasons: [] };
}

/** 结构权重高于名称：名字是人取的，结构是数据决定的。 */
export function pairTotal(s: PairScore): number {
  return 0.35 * s.name + 0.65 * s.structure + (s.alias ? 0.25 : 0.0);
}

export function pairScoreToDict(s: PairScore): Record<string, unknown> {
  return {
    a: s.a,
    b: s.b,
    name: round3(s.name),
    structure: round3(s.structure),
    alias: s.alias,
    total: round3(pairTotal(s)),
    reasons: s.reasons,
  };
}

/** 阈值。取向是**宁可漏合并，不可错合并**。 */
export interface AlignPolicy {
  /** 高于此：合并 */
  readonly mergeAt: number;
  /** 介于两者：标存疑交人判 */
  readonly reviewAt: number;
  /** 只有名称证据、结构证据为零时，无论名字多像都不自动合并 */
  readonly requireStructural: boolean;
}

export const DEFAULT_ALIGN_POLICY: AlignPolicy = {
  mergeAt: 0.72,
  reviewAt: 0.45,
  requireStructural: true,
};

export function makeAlignPolicy(p: Partial<AlignPolicy> = {}): AlignPolicy {
  return {
    mergeAt: p.mergeAt ?? DEFAULT_ALIGN_POLICY.mergeAt,
    reviewAt: p.reviewAt ?? DEFAULT_ALIGN_POLICY.reviewAt,
    requireStructural: p.requireStructural ?? DEFAULT_ALIGN_POLICY.requireStructural,
  };
}

export interface AlignResult {
  clusters: string[][];
  /** 被合并的 rid → 代表 rid。插入序有意义（`_cluster` 按它建并查集）。 */
  merged: Map<string, string>;
  uncertain: PairScore[];
  scores: PairScore[];
}

export function makeAlignResult(): AlignResult {
  return { clusters: [], merged: new Map(), uncertain: [], scores: [] };
}

export function alignSummary(r: AlignResult): Record<string, number> {
  return {
    clusters: r.clusters.length,
    merged_away: r.merged.size,
    uncertain_pairs: r.uncertain.length,
    candidates_scored: r.scores.length,
  };
}

// ══════════════════════════════════════════════════════════════════
//  对齐器
// ══════════════════════════════════════════════════════════════════

/** 对象级实体对齐。 */
export class EntityAligner {
  readonly policy: AlignPolicy;

  constructor(policy: AlignPolicy | null = null) {
    this.policy = policy ?? DEFAULT_ALIGN_POLICY;
  }

  // ── 主流程 ──────────────────────────────────────────────────
  align(oir: OIR): AlignResult {
    const objs = [...oir.objects.values()];
    const result = makeAlignResult();
    if (objs.length < 2) {
      result.clusters = objs.map((o) => [o.rid]);
      return result;
    }

    for (const [a, b] of this.blocking(objs, oir)) {
      const s = this.score(oir, a, b);
      result.scores.push(s);
      const total = pairTotal(s);
      if (total >= this.policy.mergeAt) {
        if (this.policy.requireStructural && s.structure <= 0) {
          // 名字像但结构毫无交集 —— 这正是最危险的假阳性
          s.reasons.push("仅名称相似、无结构证据，不自动合并");
          result.uncertain.push(s);
          continue;
        }
        if (!result.merged.has(b.rid)) result.merged.set(b.rid, a.rid); // setdefault
      } else if (total >= this.policy.reviewAt) {
        result.uncertain.push(s);
      }
    }

    result.clusters = EntityAligner.cluster(objs, result.merged);
    const remerged = new Map<string, string>();
    for (const c of result.clusters) {
      const rep = c[0];
      if (rep === undefined) continue;
      for (const m of c.slice(1)) remerged.set(m, rep);
    }
    result.merged = remerged;
    return result;
  }

  /** 把聚类结果落到 OIR 上：属性改挂、别名合并、被并对象移除。 */
  apply(oir: OIR, result: AlignResult): Record<string, unknown>[] {
    const log: Record<string, unknown>[] = [];
    for (const cluster of result.clusters) {
      if (cluster.length < 2) continue;
      const repRid = EntityAligner.elect(oir, cluster);
      const rep = oir.objects.get(repRid);
      // Python 是 oir.objects[rep_rid]，不存在就 KeyError。照抄地炸。
      if (rep === undefined) throw new Error(`KeyError: ${pyRepr(repRid)}`);
      for (const rid of cluster) {
        if (rid === repRid) continue;
        const other = oir.objects.get(rid);
        if (other === undefined) continue;
        oir.objects.delete(rid);
        for (const pr of other.properties) {
          const p = oir.properties.get(pr);
          if (p !== undefined) {
            p.parent = repRid;
            if (!rep.properties.includes(pr)) rep.properties.push(pr);
          }
        }
        for (const lt of oir.links.values()) {
          if (lt.source === rid) lt.source = repRid;
          if (lt.target === rid) lt.target = repRid;
        }
        for (const at of oir.actions.values()) {
          at.appliesTo = at.appliesTo.map((x) => (x === rid ? repRid : x));
        }
        // 别名不能丢：它是下次遇到同一材料时能立刻认出来的依据
        for (const alias of [other.apiName.value, other.displayName.value, ...other.aliases]) {
          if (
            alias &&
            !rep.aliases.includes(alias) &&
            alias !== rep.apiName.value &&
            alias !== rep.displayName.value
          ) {
            rep.aliases.push(alias);
          }
        }
        log.push({ merged: rid, into: repRid, aliases_kept: [...rep.aliases] });
      }
    }
    return log;
  }

  // ── 阻塞 ────────────────────────────────────────────────────
  /**
   * 生成候选对，避免 O(n²)。
   *
   * **三种阻塞键，缺一不可**：
   *
   * * 名称词元 —— 最直觉，但对缩写无效（`pbpHeader` 与 `purchasePlanHeader`
   *   一个词元都不共享）。
   * * 别名 —— 术语表里登记过的等价关系，最硬的信号，绝不能在阻塞阶段就丢掉。
   * * **共享字段名** —— 结构阻塞。这是缩写场景唯一还能用的信号，也和"结构证据
   *   优先于名称"这条原则一致。只按名字阻塞，等于让整个打分器看不到最该看的那些对。
   *
   * Python 侧叫 `_blocking`（私有）。TS 侧公开，因为它是 golden 直接钉的一层。
   */
  blocking(objs: readonly ObjectType[], oir: OIR): [ObjectType, ObjectType][] {
    const index = new Map<string, Set<number>>();
    // 用 set 而不是 list：apiName 与 displayName 相同时同一个对象会被
    // 登记两次，落到成对循环里就变成 (i, i) 自配对
    const put = (key: string, i: number): void => {
      const s = index.get(key);
      if (s === undefined) index.set(key, new Set([i]));
      else s.add(i);
    };

    for (let i = 0; i < objs.length; i++) {
      const o = objs[i] as ObjectType;
      for (const t of union(tokens(o.apiName.value), tokens(o.displayName.value))) put(`n:${t}`, i);
      for (const a of [o.apiName.value, o.displayName.value, ...o.aliases]) {
        if (a) put(`a:${a.toLowerCase()}`, i);
      }
      for (const r of o.properties) {
        const p = oir.properties.get(r);
        if (p !== undefined) put(`p:${p.apiName.value.toLowerCase()}`, i);
      }
    }

    const seen = new Set<string>();
    for (const [key, idSet] of index) {
      // 过于常见的键没有区分度；别名例外，它本来就该稀有
      if (idSet.size > 24 && !key.startsWith("a:")) continue;
      const ids = [...idSet].sort((x, y) => x - y);
      for (let x = 0; x < ids.length; x++) {
        for (let y = x + 1; y < ids.length; y++) seen.add(`${ids[x] as number},${ids[y] as number}`);
      }
    }
    const pairs = [...seen]
      .map((s) => s.split(",").map(Number) as [number, number])
      .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    return pairs.map(([i, j]) => [objs[i] as ObjectType, objs[j] as ObjectType]);
  }

  // ── 打分 ────────────────────────────────────────────────────
  /** Python 侧叫 `_score`。 */
  score(oir: OIR, a: ObjectType, b: ObjectType): PairScore {
    const s = makePairScore(a.rid, b.rid);

    // 名称证据
    const ta = union(tokens(a.apiName.value), tokens(a.displayName.value));
    const tb = union(tokens(b.apiName.value), tokens(b.displayName.value));
    if (ta.size > 0 && tb.size > 0) {
      const jacc = intersect(ta, tb).size / union(ta, tb).size;
      const ratio = new SequenceMatcher(
        null,
        toCodePoints(a.apiName.value.toLowerCase()),
        toCodePoints(b.apiName.value.toLowerCase()),
      ).ratio();
      s.name = Math.max(jacc, ratio * 0.9);
      const shared = intersect(ta, tb);
      if (shared.size > 0) s.reasons.push(`共享词元 ${pyReprList(sortedCp(shared))}`);
    }

    // 别名证据：术语表里登记过的等价关系，最硬
    const namesA = new Set([
      a.apiName.value.toLowerCase(),
      a.displayName.value.toLowerCase(),
      ...a.aliases.map((x) => x.toLowerCase()),
    ]);
    const namesB = new Set([
      b.apiName.value.toLowerCase(),
      b.displayName.value.toLowerCase(),
      ...b.aliases.map((x) => x.toLowerCase()),
    ]);
    const sharedNames = intersect(namesA, namesB);
    if (sharedNames.size > 0) {
      s.alias = true;
      s.reasons.push(`别名重合 ${pyReprList(sortedCp(sharedNames))}`);
    }

    // 结构证据：字段集合重叠 + 主键类型一致
    const pa = new Set<string>();
    for (const r of a.properties) {
      const p = oir.properties.get(r);
      if (p !== undefined) pa.add(p.apiName.value.toLowerCase());
    }
    const pb = new Set<string>();
    for (const r of b.properties) {
      const p = oir.properties.get(r);
      if (p !== undefined) pb.add(p.apiName.value.toLowerCase());
    }
    const both = pa.size > 0 && pb.size > 0;
    const overlapSet = intersect(pa, pb);
    if (both && overlapSet.size === 0) s.reasons.push("字段集合无交集，无结构证据");
    if (both) {
      const denom = Math.min(pa.size, pb.size);
      s.structure = overlapSet.size / denom;
      s.reasons.push(`字段重叠 ${overlapSet.size}/${denom}`);
      const pkA = EntityAligner.pkTypes(oir, a);
      if (pkA.length > 0 && sameTuple(pkA, EntityAligner.pkTypes(oir, b))) {
        s.structure = Math.min(1.0, s.structure + 0.2);
        s.reasons.push("主键类型一致");
      }
    } else {
      s.reasons.push("至少一边没有属性，无结构证据");
    }
    return s;
  }

  /** Python 侧叫 `_pk_types`。返回的是 tuple，比较靠**逐项相等**。 */
  static pkTypes(oir: OIR, o: ObjectType): string[] {
    const out: string[] = [];
    for (const r of o.primaryKey.value ?? []) {
      const p = oir.properties.get(r);
      if (p !== undefined) out.push(String(p.baseType.value));
    }
    return out;
  }

  // ── 聚类与代表选举 ──────────────────────────────────────────
  /** 并查集求连通分量。传递性是必要的：A≡B、B≡C 就该是一个簇。 */
  static cluster(objs: readonly ObjectType[], merged: ReadonlyMap<string, string>): string[][] {
    const parent = new Map<string, string>();
    for (const o of objs) parent.set(o.rid, o.rid);

    const find = (x0: string): string => {
      let x = x0;
      for (;;) {
        const p = parent.get(x) as string;
        if (p === x) return x;
        // 路径减半：把 x 直接挂到祖父上
        parent.set(x, parent.get(p) as string);
        x = parent.get(x) as string;
      }
    };

    for (const [b, a] of merged) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    }

    const groups = new Map<string, string[]>();
    for (const o of objs) {
      const root = find(o.rid);
      const g = groups.get(root);
      if (g === undefined) groups.set(root, [o.rid]);
      else g.push(o.rid);
    }
    return [...groups.values()].map((v) => sortedCp(v));
  }

  /**
   * 选代表。
   *
   * 优先有 **DDL 支撑**的：物理名是系统里实际存在的东西，业务名是人的说法，
   * 前者更适合做 apiName。其次看属性数量 —— 属性多的那个通常是主记录。
   */
  static elect(oir: OIR, cluster: readonly string[]): string {
    const rank = (rid: string): [number, number, string] => {
      const o = oir.objects.get(rid);
      if (o === undefined) throw new Error(`KeyError: ${pyRepr(rid)}`);
      const ddl = o.apiName.evidence.some(
        (e) => e.extractor === "sqlglot" || e.locator["kind"] === "ddl",
      );
      return [ddl ? 1 : 0, o.properties.length, rid];
    };
    // Python 的 max() 在并列时返回**第一个**最大值 —— 元组第三项是 rid，
    // 全序，实际不会并列；但比较顺序（ddl → 属性数 → rid）必须一模一样。
    let best: string | undefined;
    let bestKey: [number, number, string] | undefined;
    for (const rid of cluster) {
      const k = rank(rid);
      if (bestKey === undefined || cmpRank(k, bestKey) > 0) {
        best = rid;
        bestKey = k;
      }
    }
    if (best === undefined) throw new Error("max() arg is an empty sequence");
    return best;
  }
}

function cmpRank(x: [number, number, string], y: [number, number, string]): number {
  if (x[0] !== y[0]) return x[0] - y[0];
  if (x[1] !== y[1]) return x[1] - y[1];
  return cmpCodePoint(x[2], y[2]);
}

function sameTuple(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 跑完整对齐并落到 OIR 上。返回 `[结果, 变更账]`。 */
export function alignAndApply(
  oir: OIR,
  policy: AlignPolicy | null = null,
): [AlignResult, Record<string, unknown>[]] {
  const aligner = new EntityAligner(policy);
  const result = aligner.align(oir);
  return [result, aligner.apply(oir, result)];
}
