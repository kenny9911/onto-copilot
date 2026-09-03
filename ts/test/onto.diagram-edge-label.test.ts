/**
 * 边标签的截断 —— 网关分支条件被砍成半句的问题。
 *
 * 评审更正过我一次：边标签**本来就渲染**（我原以为没画），真问题是
 * `cpSlice(e.label, 8)` 这个 8 码点上限。分支条件恰恰最容易超：
 * 「金额大于5万元」7 字勉强、「金额大于等于5万元」10 字直接被砍成
 * 「金额大于等于5万」—— 一个把「等于」砍掉的条件，含义是反的。
 *
 * 边标签是全图**唯一**带判定信息的东西（`FlowEdge.label`），砍它等于砍掉
 * 这张图能不能被执行的那部分。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";
import { toSvg } from "../src/onto/diagram.js";

function twoNodes(label: string): FlowGraph {
  const g = new FlowGraph();
  g.addNode(makeFlowNode({ rid: "fn_a", kind: NodeKind.GATEWAY, label: inferred("金额判断") }));
  g.addNode(makeFlowNode({ rid: "fn_b", kind: NodeKind.ACTION, label: inferred("总经理审批") }));
  g.connect("fn_a", "fn_b", { label });
  return g;
}

describe("边标签", () => {
  it("★ 十个字的分支条件不被砍掉后半截", () => {
    const svg = toSvg(twoNodes("金额大于等于5万元"));

    expect(svg).toContain("金额大于等于5万元");
  });

  it("砍掉「等于」会让条件含义反过来 —— 这正是要修的那种截断", () => {
    const svg = toSvg(twoNodes("金额大于等于5万元"));

    expect(svg).not.toContain(">金额大于等于5万<");
  });

  it("短标签原样出", () => {
    expect(toSvg(twoNodes("通过"))).toContain("通过");
  });

  it("超长标签仍然要截 —— 放宽不等于不截，一行画不下就是画不下", () => {
    const long = "这是一条特别长的分支条件".repeat(6);
    const svg = toSvg(twoNodes(long));

    expect(svg).not.toContain(long);
    expect(svg).toContain("…");
  });

  it("空标签不画 text 元素", () => {
    const svg = toSvg(twoNodes(""));

    expect(svg).not.toMatch(/font-size="9\.5"/u);
  });
});
