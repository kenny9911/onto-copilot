/**
 * 多策略合流 —— 两条以上策略各出了一张图，怎么并成一张。
 *
 * ── 唯一的纪律 ──────────────────────────────────────────────
 * **冲突不静默合并。** 两条策略对同一个环节说了不同的话（执行者不同、分支条件
 * 不同），那是要问业务方的事，不是系统挑一个的事。挑一个就等于在产物里编造了
 * 一个"共识"，而且不留痕迹 —— 下一个人看到的是一张干净的图，看不出这里曾经有
 * 两种说法。
 *
 * ── 为什么不直接用 flow_diff ────────────────────────────────
 * `diffFlowGraphs` 返回的是**标签串不是 rid**，唯一暴露的差异维度是 `kindDiff`
 * （设计评审核实）。合流需要按 rid 找回节点、逐字段比对、把 evidence 取并集，
 * 它做不到。这里用同一套"精确名优先"的配对思路，但结果带 rid 和字段级差异。
 * `sketch.diff` 的既有用法不动。
 */

import { FlowGraph, makeFlowNode } from "./flow.js";
import type { FlowNode } from "./flow.js";
import type { Provenance } from "./oir.js";
import type { Strategy } from "./flow_strategy.js";

/** 保真度序：文件里写着的 > 模型读图的 > 模型读字的 > 推断的 > 通识。 */
const FIDELITY: Readonly<Record<Strategy, number>> = {
  S1: 0, S2: 1, S3: 2, S4: 3, S5: 4, S6: 5, S7: 6,
};

export interface StrategyGraph {
  readonly strategy: Strategy;
  readonly graph: FlowGraph;
}

/** 一处两条策略说法不同的地方。**不合并**，交给问题清单。 */
export interface MergeConflict {
  /** 环节名（两边配对上的那个）。 */
  readonly node: string;
  /** 哪个字段打架，如 `actor`。 */
  readonly field: string;
  readonly left: string;
  readonly right: string;
  /** 哪两条策略在打架 —— 不说清就没法判谁更可信。 */
  readonly strategies: [Strategy, Strategy];
}

export interface MergeResult {
  readonly graph: FlowGraph;
  readonly conflicts: MergeConflict[];
  /** 每个环节名来自哪些策略 —— 产物上要能回答"这一步是谁看出来的"。 */
  readonly sources: Map<string, Strategy[]>;
  /** 实际采用的策略顺序（按保真度排过）。 */
  readonly order: Strategy[];
}

/** 配对键：环节名归一化后精确比。模糊配对留给 sketch.diff，那是给人看的场景。 */
function keyOf(n: FlowNode): string {
  return n.label.value.trim().replace(/\s+/gu, "");
}

export function mergeFlowGraphs(inputs: readonly StrategyGraph[]): MergeResult {
  const order = [...inputs]
    .sort((a, b) => FIDELITY[a.strategy] - FIDELITY[b.strategy])
    .map((x) => x.strategy);
  const sorted = [...inputs].sort((a, b) => FIDELITY[a.strategy] - FIDELITY[b.strategy]);

  const out = new FlowGraph();
  const conflicts: MergeConflict[] = [];
  const sources = new Map<string, Strategy[]>();
  // 环节名 → 已落进 out 的那个节点，以及它来自哪条策略
  const seen = new Map<string, { node: FlowNode; from: Strategy }>();

  for (const { strategy, graph } of sorted) {
    for (const n of graph.nodes.values()) {
      const key = keyOf(n);
      const prev = seen.get(key);

      if (prev === undefined) {
        // 第一次见：原样收下。code 留空由 addNode 生成，保证编号规则一致。
        const copy = out.addNode(makeFlowNode({
          rid: n.rid, kind: n.kind, label: n.label, stage: n.stage,
          actor: n.actor, objects: [...n.objects], endpoint: n.endpoint, status: n.status,
        }));
        seen.set(key, { node: copy, from: strategy });
        sources.set(key, [strategy]);
        continue;
      }

      sources.get(key)?.push(strategy);

      // 出处取并集 —— 多源互证正是合流的价值所在
      prev.node.label = {
        ...prev.node.label,
        evidence: dedupeProv([...prev.node.label.evidence, ...n.label.evidence]),
      };

      // 逐字段比：两边都填了且不同 → 冲突，不合并
      const a = prev.node.actor.value.trim();
      const b = n.actor.value.trim();
      if (a && b && a !== b) {
        conflicts.push({
          node: n.label.value, field: "actor", left: a, right: b,
          strategies: [prev.from, strategy],
        });
      } else if (!a && b) {
        // 一方缺信息不算冲突：有值的赢，别让空值抹掉已知的信息
        prev.node.actor = n.actor;
      }
    }
  }

  return { graph: out, conflicts, sources, order };
}

/** 同一份出处不重复收（两条策略读到同一句话是常事）。 */
function dedupeProv(list: readonly Provenance[]): Provenance[] {
  const seenKey = new Set<string>();
  const out: Provenance[] = [];
  for (const p of list) {
    const k = `${p.fileName}|${JSON.stringify(p.locator)}|${p.snippet}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    out.push(p);
  }
  return out;
}
