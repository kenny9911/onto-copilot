/**
 * 「机械配对」检测。
 *
 * 用户对生成的流程图最直接的抱怨是"死板"，而最强的视觉信号是这个节奏：
 * 每个 Action 后面挂一个 Event，整张图是一条没有分叉、没有汇合的直链。
 *
 * 它的来源有两处：
 *   - `flowFromActions`（接口清单兜底）按设计就是一动作一事件地配；
 *   - `flow.sketch` 的提示词写着"关键动作后面要跟它产出的事实"，配上
 *     `DETAIL_SHAPE` 规定的确切节点数，模型就把预算填成了交替链。
 *
 * 真实业务流程不长这样：它有并行、有汇合、有驳回回路，也有连着好几步
 * 才产生一个对外可观测事实的地方。
 *
 * ── 两条设计约束 ──────────────────────────────────────────────
 * 1. **只看结构，不看业务词。** 判据是"每个 action 是否恰好后接一个 event"
 *    和"图里有没有分叉/汇合"，换个行业照样成立。
 * 2. **是信号不是门禁。** `structureDefects` 是硬门禁（返回缺陷就直接不出图），
 *    往那里加这条会让每一张通不过的图消失。这里只产出一条可读提示，
 *    交给复审轮驱动模型改；改不动也照样出图。
 */

import { FlowGraph, NodeKind } from "./flow.js";

/** 少于这么多个动作就不下判断 —— 三五步的流程本来就该是直的。 */
const MIN_ACTIONS = 4;

/** 配对率高到这个程度才算机械。留一点余量：真实流程里确实有大段是顺序的。 */
const PAIRED_THRESHOLD = 0.9;

export interface RhythmSignal {
  /** 是不是一条机械配对的直链。 */
  readonly mechanical: boolean;
  /** 恰好后接一个事件的动作占全部动作的比例。 */
  readonly pairedRatio: number;
  /** 给人看、也直接进复审要求的一句话。`mechanical` 为假时是空串。 */
  readonly note: string;
}

/** 某个节点的出边条数。 */
function outDegree(g: FlowGraph, rid: string): number {
  let n = 0;
  for (const e of g.edges.values()) if (e.source === rid) n += 1;
  return n;
}

function inDegree(g: FlowGraph, rid: string): number {
  let n = 0;
  for (const e of g.edges.values()) if (e.target === rid) n += 1;
  return n;
}

export function rhythmSignal(g: FlowGraph): RhythmSignal {
  const none = { mechanical: false, pairedRatio: 0, note: "" };

  const actions = [...g.nodes.values()].filter((n) => n.kind === NodeKind.ACTION);
  if (actions.length < MIN_ACTIONS) return none;

  // 有任何分叉或汇合，就说明这张图有真实结构，不是填出来的链。
  // 网关的存在本身就是分叉的信号（哪怕它此刻只有一条出边）。
  for (const n of g.nodes.values()) {
    if (n.kind === NodeKind.GATEWAY) return { ...none, pairedRatio: pairedRatioOf(g, actions) };
    if (outDegree(g, n.rid) > 1 || inDegree(g, n.rid) > 1) {
      return { ...none, pairedRatio: pairedRatioOf(g, actions) };
    }
  }

  const ratio = pairedRatioOf(g, actions);
  if (ratio < PAIRED_THRESHOLD) return { ...none, pairedRatio: ratio };

  return {
    mechanical: true,
    pairedRatio: ratio,
    note:
      `这张图里 ${Math.round(ratio * 100)}% 的动作后面都紧跟着一个事件，`
      + "而且整张图是一条没有分叉也没有汇合的直链。"
      + "真实流程不是这样：不是每个动作都会产生别人要等的事实，"
      + "而且总有并行、汇合或驳回回路。请只在**别人真的要等**的地方放事件，"
      + "并把真实存在的分叉画出来。",
  };
}

/** 恰好后接一个 event 的 action 占比。 */
function pairedRatioOf(
  g: FlowGraph,
  actions: readonly { rid: string }[],
): number {
  if (actions.length === 0) return 0;
  let paired = 0;
  for (const a of actions) {
    const targets = [...g.edges.values()]
      .filter((e) => e.source === a.rid)
      .map((e) => g.nodes.get(e.target));
    const events = targets.filter((t) => t?.kind === NodeKind.EVENT);
    if (targets.length === 1 && events.length === 1) paired += 1;
  }
  return paired / actions.length;
}
