/**
 * 两张 FlowGraph 的结构 diff —— 参考图 ↔ 实证图对齐的地基（第 1 层收官件）。
 *
 * flow_sketch 的价值主张是「拿去跟业务方对，让他指着说我们这儿不是这样」，
 * 但对完、材料跑出实证图之后，一直没有工具能把两张图叠起来。这份 diff 的
 * 输出就是下一场访谈的提纲：仅参考图有的环节（通识有、材料无证据 ——
 * 是材料缺了还是流程里没有？）、仅实证图有的（客户特色环节）、名字相近的
 * （疑似同一环节叫法不同）、配对子图上的衔接差异（顺序对不上）。
 *
 * 两张图的 rid 体系完全不同（sketch 自造 / 实证按材料编号派生），匹配只能靠
 * **名字**：先按归一化名字精确配对（同名多个按插入序贪心，不重复占用 ——
 * 重名本身由 structureDefects 报，这里不重复裁决），剩下的按 SequenceMatcher
 * 相似度降序贪心配对。全部确定性、零模型；阈值随结果透出，不神秘。
 *
 * 刻意通用：不叫 sketch_diff —— 撤销栈里的两版流程图、两次梳理的流程图，
 * 都是同一个比法（E1 缺口的地基）。
 */

import { SequenceMatcher } from "./difflib.js";
import { FlowGraph, type FlowNode } from "./flow.js";

function nameOf(n: FlowNode): string {
  return n.label.value || n.code || n.rid;
}

/** CJK 标签的归一化只做空白折叠 —— 大小写/标点的差异是真差异，不该被吃掉。 */
function norm(s: string): string {
  return s.replace(/\s+/g, "");
}

export interface MatchedPair {
  readonly left: string;
  readonly right: string;
  readonly exact: boolean;
  /** 精确配对恒 1；相近配对是 SequenceMatcher.ratio()（按码点）。 */
  readonly similarity: number;
  /** 同一环节两边画成了不同类型（参考图当动作、材料里是分叉点）—— 要点名。 */
  readonly kindDiff?: { readonly left: string; readonly right: string };
}

export interface EdgeRef {
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface FlowGraphDiff {
  /** 配对成功的环节，按 left 侧插入序。 */
  readonly matched: MatchedPair[];
  /** 仅 left 有（参考图侧：通识有、材料无证据）。 */
  readonly leftOnly: string[];
  /** 仅 right 有（实证侧：客户特色环节）。 */
  readonly rightOnly: string[];
  /** 配对子图上，left 有而 right 没有的衔接（按 left 侧名字报）。 */
  readonly edgeOnlyLeft: EdgeRef[];
  /** 配对子图上，right 有而 left 没有的衔接（按 right 侧名字报）。 */
  readonly edgeOnlyRight: EdgeRef[];
  /** 相近配对用的阈值 —— 透出来，读的人知道「相近」是按什么算的。 */
  readonly simThreshold: number;
}

export function diffFlowGraphs(
  left: FlowGraph,
  right: FlowGraph,
  opts: { simThreshold?: number } = {},
): FlowGraphDiff {
  const thr = opts.simThreshold ?? 0.6;
  const L = [...left.nodes.values()];
  const R = [...right.nodes.values()];

  const pairedL = new Map<string, FlowNode>(); // left rid → right node
  const usedR = new Set<string>();

  // ① 精确配对：归一化名字，同名桶按插入序贪心。
  const rByName = new Map<string, FlowNode[]>();
  for (const r of R) {
    const key = norm(nameOf(r));
    const bucket = rByName.get(key);
    if (bucket === undefined) rByName.set(key, [r]);
    else bucket.push(r);
  }
  for (const l of L) {
    const bucket = rByName.get(norm(nameOf(l)));
    const hit = bucket?.find((r) => !usedR.has(r.rid));
    if (hit !== undefined) {
      pairedL.set(l.rid, hit);
      usedR.add(hit.rid);
    }
  }

  // ② 相近配对：剩余两侧做全交叉打分，(−ratio, left 序, right 序) 排序后贪心。
  //    图有 NODE_CAP=80 的上限，O(n²) 在这里不构成问题。
  const freeL = L.filter((l) => !pairedL.has(l.rid));
  const freeR = R.filter((r) => !usedR.has(r.rid));
  const fuzzySim = new Map<string, number>();
  const candidates: { ratio: number; li: number; ri: number }[] = [];
  freeL.forEach((l, li) => {
    const a = [...norm(nameOf(l))];
    freeR.forEach((r, ri) => {
      const ratio = new SequenceMatcher(null, a, [...norm(nameOf(r))]).ratio();
      if (ratio >= thr) candidates.push({ ratio, li, ri });
    });
  });
  candidates.sort((a, b) => b.ratio - a.ratio || a.li - b.li || a.ri - b.ri);
  for (const c of candidates) {
    const l = freeL[c.li]!;
    const r = freeR[c.ri]!;
    if (pairedL.has(l.rid) || usedR.has(r.rid)) continue;
    pairedL.set(l.rid, r);
    usedR.add(r.rid);
    fuzzySim.set(l.rid, c.ratio);
  }

  const matched: MatchedPair[] = [];
  for (const l of L) {
    const r = pairedL.get(l.rid);
    if (r === undefined) continue;
    const sim = fuzzySim.get(l.rid);
    matched.push({
      left: nameOf(l),
      right: nameOf(r),
      exact: sim === undefined,
      similarity: sim ?? 1,
      ...(l.kind === r.kind ? {} : { kindDiff: { left: l.kind, right: r.kind } }),
    });
  }
  const leftOnly = L.filter((l) => !pairedL.has(l.rid)).map(nameOf);
  const rightOnly = R.filter((r) => !usedR.has(r.rid)).map(nameOf);

  // ③ 衔接差异：只在配对成功的子图上比 —— 端点都对不上的边没有可比性。
  //    身份 = 配对号的有向对（平行边折叠成一条：这里比的是「有没有这条衔接」，
  //    不是边的条数）。
  const pairIdxL = new Map<string, number>();
  const pairIdxR = new Map<string, number>();
  let idx = 0;
  for (const l of L) {
    const r = pairedL.get(l.rid);
    if (r === undefined) continue;
    pairIdxL.set(l.rid, idx);
    pairIdxR.set(r.rid, idx);
    idx += 1;
  }
  const project = (
    g: FlowGraph,
    keyOf: Map<string, number>,
  ): Map<string, EdgeRef> => {
    const out = new Map<string, EdgeRef>();
    for (const e of g.edges.values()) {
      const a = keyOf.get(e.source);
      const b = keyOf.get(e.target);
      if (a === undefined || b === undefined) continue;
      const key = `${a}->${b}`;
      if (out.has(key)) continue;
      const sn = g.nodes.get(e.source)!;
      const tn = g.nodes.get(e.target)!;
      out.set(key, { from: nameOf(sn), to: nameOf(tn), label: e.label });
    }
    return out;
  };
  const lEdges = project(left, pairIdxL);
  const rEdges = project(right, pairIdxR);
  const edgeOnlyLeft = [...lEdges.entries()]
    .filter(([k]) => !rEdges.has(k))
    .map(([, v]) => v);
  const edgeOnlyRight = [...rEdges.entries()]
    .filter(([k]) => !lEdges.has(k))
    .map(([, v]) => v);

  return { matched, leftOnly, rightOnly, edgeOnlyLeft, edgeOnlyRight, simThreshold: thr };
}
