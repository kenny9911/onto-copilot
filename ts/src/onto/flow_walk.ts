/**
 * 流程走查 —— FlowGraph 上的确定性图算法，零模型调用。
 *
 * 业务方验证流程的方式不是看图，是**走场景**：「50 万以上的采购单走到哪一步会
 * 怎样？」「驳回之后回到哪里？」静态体检（flow.ts 的 dangling / deadEnds /
 * unlabeledBranches）各回答一个「图哪里破了」；这里回答的是「顺着走会发生什么」：
 *
 *  · {@link walkOverview}   —— 骨架一眼清：起点/终点/断头/连通分量/回退环/走不进去的部分；
 *  · {@link enumeratePaths} —— 从起点数清所有走法，每条路说明结局（终态/断头/闭环）；
 *  · {@link traceFlow}      —— 拿一张单走一遍，分叉处**停下来列选项**，不替业务方猜。
 *
 * 三条设计纪律：
 *  1. **截断必须显式**（no silent caps）：路径枚举、环列表都有上限，截了就说 ——
 *     静默截断会被读成「全量就这些」；
 *  2. **推断边要点名**：每条路径都数清有几跳是零 evidence 的虚线边 —— 没依据的
 *     路径不能当材料事实转述给客户；
 *  3. **图坏了不许炸**：目标节点不存在的边按「走不下去」处理并说明 —— 与
 *     diagram.ts「画得出来比画得对更重要」同一取向，走查是诊断工具，诊断工具
 *     自己先炸就什么都查不了。
 */

import {
  FlowGraph,
  NodeKind,
  edgeGrounded,
  type FlowEdge,
  type FlowNode,
} from "./flow.js";

/** 人读的名字：label 缺了退 code，再缺退 rid —— 总得有个能指认的名字。 */
function nodeName(n: FlowNode): string {
  return n.label.value || n.code || n.rid;
}

/**
 * 名字 / 编号 / rid → 节点。rid 精确优先（唯一），其次 label，再次 code。
 * label 重名时取插入序第一个 —— 重名本身已由 structureDefects 报出，这里不重复裁决。
 */
export function resolveFlowNode(g: FlowGraph, ref: string): FlowNode | null {
  const want = ref.trim();
  if (!want) return null;
  const byRid = g.nodes.get(want);
  if (byRid !== undefined) return byRid;
  for (const n of g.nodes.values()) if (n.label.value === want) return n;
  for (const n of g.nodes.values()) if (n.code === want) return n;
  return null;
}

export interface WalkOverview {
  /**
   * 入口。首选结构入口（有出边、无入边）；一个都没有时退到 SCC 凝聚图的
   * 源分量找**环上入口** —— 真实材料里「驳回重来」环把流程头部圈进环里是常态
   * （实测会话 424ef360：15 节点全在环链上，入度 0 的节点不存在），按结构入口
   * 硬判会把一条完全可走的流程报成「起点（无）、全部走不进去」。
   */
  readonly entries: string[];
  /** true = entries 是环上入口（结构入口不存在，从回退环内进入流程）。 */
  readonly entriesOnCycle: boolean;
  /** 正常终点（TERMINAL）。 */
  readonly terminals: string[];
  /** 断头：有入无出、又不是终态 —— 材料里多半少了一段。 */
  readonly deadEnds: string[];
  /** 弱连通分量数。>1 = 图裂成互不相连的几块，画在一张图上但走不通。 */
  readonly components: number;
  /** 回退环（如「驳回→修改→再审」），每条环按节点名列出。业务常态，不是病灶。 */
  readonly cycles: string[][];
  /** 环太多时只列前几条 —— 截了就说。 */
  readonly cyclesTruncated: boolean;
  /** 从任何入口都走不进去、但自己有边的部分（典型：没有入口的死环）。 */
  readonly unreachable: string[];
}

const CYCLE_CAP = 10;

/**
 * Tarjan SCC（递归版；流程图节点数在百量级，栈深不是问题）。
 * 返回每个节点所属的 SCC 编号，同一编号 = 互相可达。
 */
function sccOf(g: FlowGraph): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out = new Map<string, number>();
  let counter = 0;
  let sccCount = 0;
  const strongconnect = (rid: string): void => {
    index.set(rid, counter);
    low.set(rid, counter);
    counter += 1;
    stack.push(rid);
    onStack.add(rid);
    for (const e of g.outEdges(rid)) {
      const t = e.target;
      if (!g.nodes.has(t)) continue;
      if (!index.has(t)) {
        strongconnect(t);
        low.set(rid, Math.min(low.get(rid)!, low.get(t)!));
      } else if (onStack.has(t)) {
        low.set(rid, Math.min(low.get(rid)!, index.get(t)!));
      }
    }
    if (low.get(rid) === index.get(rid)) {
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        out.set(w, sccCount);
        if (w === rid) break;
      }
      sccCount += 1;
    }
  };
  for (const rid of g.nodes.keys()) if (!index.has(rid)) strongconnect(rid);
  return out;
}

export function walkOverview(g: FlowGraph): WalkOverview {
  let entries = [...g.nodes.values()].filter(
    (n) => g.outEdges(n.rid).length > 0 && g.inEdges(n.rid).length === 0,
  );
  // 结构入口一个都没有 = 流程头部被回退环圈进去了。退到 SCC 凝聚图：没有跨 SCC
  // 入边的源分量里，**能走出去（或含终态）的**才算入口区 —— 走不出去的死环不是
  // 入口，是「走不进去的部分」，下面照旧报。代表节点取插入序第一个（材料顺序）。
  let entriesOnCycle = false;
  if (entries.length === 0 && g.edges.size > 0) {
    const scc = sccOf(g);
    const hasCrossIn = new Set<number>();
    for (const e of g.edges.values()) {
      const si = scc.get(e.source);
      const ti = scc.get(e.target);
      if (si !== undefined && ti !== undefined && si !== ti) hasCrossIn.add(ti);
    }
    const picked = new Set<number>();
    const fallback: FlowNode[] = [];
    for (const n of g.nodes.values()) {
      const id = scc.get(n.rid)!;
      if (hasCrossIn.has(id) || picked.has(id)) continue;
      const members = [...g.nodes.values()].filter((m) => scc.get(m.rid) === id);
      const canExit = members.some(
        (m) =>
          m.kind === NodeKind.TERMINAL ||
          g.outEdges(m.rid).some((e) => scc.get(e.target) !== undefined && scc.get(e.target) !== id),
      );
      picked.add(id);
      if (canExit) fallback.push(n);
    }
    if (fallback.length > 0) {
      entries = fallback;
      entriesOnCycle = true;
    }
  }
  const terminals = [...g.nodes.values()].filter((n) => n.kind === NodeKind.TERMINAL);

  // 弱连通分量：入边出边都算相邻。
  const seen = new Set<string>();
  let components = 0;
  for (const start of g.nodes.keys()) {
    if (seen.has(start)) continue;
    components += 1;
    const q = [start];
    seen.add(start);
    while (q.length > 0) {
      const cur = q.pop()!;
      for (const e of [...g.outEdges(cur), ...g.inEdges(cur)]) {
        for (const next of [e.source, e.target]) {
          if (g.nodes.has(next) && !seen.has(next)) {
            seen.add(next);
            q.push(next);
          }
        }
      }
    }
  }

  // 回退环：DFS 回边。同一组节点的环只报一次（从不同入口能发现同一个环）。
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  let cyclesTruncated = false;
  const color = new Map<string, 1 | 2>(); // 1=栈上 2=完成
  const stack: string[] = [];
  const dfs = (rid: string): void => {
    color.set(rid, 1);
    stack.push(rid);
    for (const e of g.outEdges(rid)) {
      const t = e.target;
      if (!g.nodes.has(t)) continue; // 悬空边：走查不炸，体检那边会报
      const c = color.get(t);
      if (c === 1) {
        const at = stack.indexOf(t);
        const loop = stack.slice(at);
        const key = [...loop].sort().join("|");
        if (!cycleKeys.has(key)) {
          if (cycles.length >= CYCLE_CAP) {
            cyclesTruncated = true;
          } else {
            cycleKeys.add(key);
            cycles.push(loop.map((r) => nodeName(g.nodes.get(r)!)));
          }
        }
      } else if (c === undefined) {
        dfs(t);
      }
    }
    stack.pop();
    color.set(rid, 2);
  };
  for (const rid of g.nodes.keys()) if (!color.has(rid)) dfs(rid);

  // 从全部入口做可达性；有边却走不进去的（典型：无入口死环）单独点名。
  // 完全孤立的节点归 dangling 管，这里不重复报。
  const reachable = new Set<string>();
  {
    const q = entries.map((n) => n.rid);
    for (const rid of q) reachable.add(rid);
    while (q.length > 0) {
      const cur = q.pop()!;
      for (const e of g.outEdges(cur)) {
        if (g.nodes.has(e.target) && !reachable.has(e.target)) {
          reachable.add(e.target);
          q.push(e.target);
        }
      }
    }
  }
  const unreachable = [...g.nodes.values()]
    .filter(
      (n) =>
        !reachable.has(n.rid) &&
        (g.inEdges(n.rid).length > 0 || g.outEdges(n.rid).length > 0),
    )
    .map(nodeName);

  return {
    entries: entries.map(nodeName),
    entriesOnCycle,
    terminals: terminals.map(nodeName),
    deadEnds: g.deadEnds().map(nodeName),
    components,
    cycles,
    cyclesTruncated,
    unreachable,
  };
}

export interface PathRecord {
  readonly nodes: string[];
  /** 这条路的结局：走到终态 / 断头 / 回到走过的节点（环闭合）/ 触到深度上限。 */
  readonly end: "terminal" | "dead_end" | "loop_back" | "depth_cap";
}

export interface PathEnumeration {
  readonly paths: PathRecord[];
  /** true = 还有走法没列出来（撞了 maxPaths）。 */
  readonly truncated: boolean;
}

/**
 * 从 `fromRid` 枚举全部简单路径（同一节点每条路上最多出现一次）。
 *
 * 当前节点还有出边、但全部通向本路径已走过的节点时，按「环闭合」收束成一条
 * loop_back 路径 —— 驳回重编这类回退环因此会以一条明确的路出现，而不是被吞掉。
 */
export function enumeratePaths(
  g: FlowGraph,
  fromRid: string,
  opts: { maxPaths?: number; maxDepth?: number } = {},
): PathEnumeration {
  const maxPaths = opts.maxPaths ?? 30;
  const maxDepth = opts.maxDepth ?? 60;
  const paths: PathRecord[] = [];
  let truncated = false;

  const walk = (rid: string, path: string[], onPath: Set<string>): void => {
    if (truncated && paths.length >= maxPaths) return;
    const node = g.nodes.get(rid);
    if (node === undefined) return;
    path.push(rid);
    onPath.add(rid);
    const record = (end: PathRecord["end"]): void => {
      if (paths.length >= maxPaths) {
        truncated = true;
      } else {
        paths.push({ nodes: path.map((r) => nodeName(g.nodes.get(r)!)), end });
      }
    };
    if (node.kind === NodeKind.TERMINAL) {
      record("terminal");
    } else {
      const outs = g.outEdges(rid).filter((e) => g.nodes.has(e.target));
      if (outs.length === 0) {
        record("dead_end");
      } else if (path.length >= maxDepth) {
        record("depth_cap");
      } else {
        const fresh = outs.filter((e) => !onPath.has(e.target));
        if (fresh.length === 0) {
          record("loop_back");
        } else {
          for (const e of fresh) walk(e.target, path, onPath);
        }
      }
    }
    path.pop();
    onPath.delete(rid);
  };
  walk(fromRid, [], new Set());
  return { paths, truncated };
}

export interface TraceStep {
  readonly rid: string;
  readonly label: string;
  readonly kind: NodeKind;
  readonly stage: string;
  readonly actor: string;
  /** 走到这一步用的边；起点没有。grounded=false 是推断边（图上的虚线）。 */
  readonly via?: { readonly label: string; readonly grounded: boolean };
}

export interface ForkOption {
  /** 边上的条件标签；没有标签时落到目标节点名 —— 总得有个能指认的词。 */
  readonly label: string;
  readonly target: string;
  readonly grounded: boolean;
}

export interface TraceResult {
  readonly steps: TraceStep[];
  readonly stopped: "terminal" | "dead_end" | "fork" | "loop" | "broken" | "step_cap";
  /** stopped=fork 时的可选项，拿去问业务方「这里走哪条」。 */
  readonly options?: ForkOption[];
  /** stopped=loop 时闭环回到的节点名。 */
  readonly loopTo?: string;
  /** 走过的边里有几条是零 evidence 的推断边。 */
  readonly ungroundedHops: number;
}

const TRACE_STEP_CAP = 100;

/**
 * 单令牌走查。**任何多出边都停下来问**，不区分网关与非网关 —— 事件多出边在
 * BPMN 语义里是并行扇出，但拿一张单走场景时替业务方猜「主路」比停下来问更糟：
 * 猜错的那条会被当成「系统说流程是这样」。
 *
 * `choices` 按节点（名字/编号/rid 均可作键）给出该处走哪条：值匹配边的条件标签，
 * 匹配不上再试目标节点的名字 / rid。
 */
export function traceFlow(
  g: FlowGraph,
  fromRid: string,
  choices: Record<string, string>,
  opts: { maxSteps?: number } = {},
): TraceResult {
  const maxSteps = opts.maxSteps ?? TRACE_STEP_CAP;
  const steps: TraceStep[] = [];
  const visited = new Set<string>();
  let ungroundedHops = 0;

  const choiceFor = (n: FlowNode): string | undefined =>
    choices[nodeName(n)] ?? choices[n.rid] ?? (n.code ? choices[n.code] : undefined);

  let current = g.nodes.get(fromRid) ?? null;
  let via: TraceStep["via"] | undefined = undefined;
  while (current !== null) {
    steps.push({
      rid: current.rid,
      label: nodeName(current),
      kind: current.kind,
      stage: current.stage,
      actor: current.actor.value,
      ...(via === undefined ? {} : { via }),
    });
    visited.add(current.rid);
    if (current.kind === NodeKind.TERMINAL) {
      return { steps, stopped: "terminal", ungroundedHops };
    }
    if (steps.length >= maxSteps) {
      return { steps, stopped: "step_cap", ungroundedHops };
    }
    const outs = g.outEdges(current.rid);
    if (outs.length === 0) {
      return { steps, stopped: "dead_end", ungroundedHops };
    }
    let edge: FlowEdge;
    if (outs.length === 1) {
      edge = outs[0]!;
    } else {
      const pick = choiceFor(current);
      const hit =
        pick === undefined
          ? undefined
          : (outs.find((e) => e.label === pick) ??
            outs.find((e) => {
              const t = g.nodes.get(e.target);
              return t !== undefined && (nodeName(t) === pick || t.rid === pick);
            }));
      if (hit === undefined) {
        const options: ForkOption[] = outs.map((e) => {
          const t = g.nodes.get(e.target);
          return {
            label: e.label || (t ? nodeName(t) : e.target),
            target: t ? nodeName(t) : e.target,
            grounded: edgeGrounded(e),
          };
        });
        return { steps, stopped: "fork", options, ungroundedHops };
      }
      edge = hit;
    }
    const next = g.nodes.get(edge.target);
    if (next === undefined) {
      // 悬空边：走查不炸（诊断工具自己先炸就什么都查不了），如实报走不下去。
      return { steps, stopped: "broken", ungroundedHops };
    }
    if (visited.has(next.rid)) {
      return { steps, stopped: "loop", loopTo: nodeName(next), ungroundedHops };
    }
    if (!edgeGrounded(edge)) ungroundedHops += 1;
    via = { label: edge.label, grounded: edgeGrounded(edge) };
    current = next;
  }
  return { steps, stopped: "broken", ungroundedHops };
}
