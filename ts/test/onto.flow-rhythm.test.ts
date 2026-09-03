/**
 * 「机械配对」检测 —— 一张图是不是被填成了 动作→事件→动作→事件 的直链。
 *
 * 用户反馈的「死板」，最强的视觉信号就是这个节奏：每个 Action 后面挂一个
 * 罐头 Event，整张图是一条没有分叉、没有汇合、没有回路的链。真实业务流程
 * 不长这样 —— 它有并行、有汇合、有驳回回路，也有连着好几步才产生一个
 * 对外可观测事实的地方。
 *
 * 这个判据**只看结构**（每个 action 是否恰好后接一个 event、图里有没有分叉/汇合），
 * 不看任何业务词，所以换个行业照样成立。
 *
 * 它是**信号不是门禁**：`structureDefects` 是硬门禁，往那里加判据会让每一张
 * 通不过的图直接不出图（评审已指出这个坑）。这里只产出一条可读的提示，
 * 交给 sketch 的复审轮去驱动模型改，改不动也照样出图。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";
import { rhythmSignal } from "../src/onto/flow_rhythm.js";

/** 造一条 a1→e1→a2→e2→… 的直链。 */
function chain(pairs: number): FlowGraph {
  const g = new FlowGraph();
  let prevEvt = "";
  for (let i = 1; i <= pairs; i++) {
    const a = g.addNode(makeFlowNode({
      rid: `fn_a${i}`, kind: NodeKind.ACTION, label: inferred(`动作${i}`),
    }));
    const e = g.addNode(makeFlowNode({
      rid: `fn_e${i}`, kind: NodeKind.EVENT, label: inferred(`动作${i}已完成`),
    }));
    g.connect(a.rid, e.rid);
    if (prevEvt) g.connect(prevEvt, a.rid);
    prevEvt = e.rid;
  }
  return g;
}

describe("rhythmSignal", () => {
  it("严格交替的直链被认出来", () => {
    const s = rhythmSignal(chain(6));

    expect(s.mechanical).toBe(true);
    expect(s.pairedRatio).toBe(1);
  });

  it("提示语点明问题，能直接进复审要求", () => {
    const s = rhythmSignal(chain(6));

    expect(s.note).toMatch(/动作/u);
    expect(s.note.length).toBeGreaterThan(10);
  });

  it("有分叉就不算机械 —— 分叉是真实流程的标志", () => {
    const g = chain(4);
    const gw = g.addNode(makeFlowNode({
      rid: "fn_gw", kind: NodeKind.GATEWAY, label: inferred("金额判断"),
    }));
    g.connect("fn_e2", gw.rid);
    g.connect(gw.rid, "fn_a4", { label: "超限" });

    expect(rhythmSignal(g).mechanical).toBe(false);
  });

  it("有连着两步才出一个事实的地方，就不算机械", () => {
    const g = chain(4);
    // 再加一个动作，它后面**不**跟事件
    const a5 = g.addNode(makeFlowNode({
      rid: "fn_a5", kind: NodeKind.ACTION, label: inferred("动作5"),
    }));
    g.connect("fn_e4", a5.rid);

    const s = rhythmSignal(g);
    expect(s.pairedRatio).toBeLessThan(1);
    expect(s.mechanical).toBe(false);
  });

  it("动作太少时不下判断 —— 三步的流程本来就该是直的", () => {
    expect(rhythmSignal(chain(2)).mechanical).toBe(false);
  });

  it("空图不炸", () => {
    expect(rhythmSignal(new FlowGraph()).mechanical).toBe(false);
  });
});
