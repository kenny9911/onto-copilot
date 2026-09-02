/**
 * 证据硬校验 —— 「实证档」这个承诺的唯一实际支撑点。
 *
 * 背景：设计评审核实，仓库里两个 provenance critic **都不做这件事** ——
 * 都只发 `Severity.MEDIUM`、都不检查 `origin`、都不看流程节点与边，
 * engagement 那个的 `passed` 还是恒真。只有 schema critic 会发能 block 的 HIGH。
 *
 * 也就是说：一条断言标着「来自材料」却一个出处都没有，现在可以一路走到交付包。
 * 而多策略生成一旦上线，低保真策略冒充实证的代价会立刻变高 ——
 * 所以在落盘之前加一道确定性闸门：**违规就抛错，不出产物。**
 *
 * 为什么是抛错而不是报 finding：报 finding 的东西会被人忽略，而这条一旦破防，
 * 图上那些"有据"的实线就是假的，下游（主干图、交付包、走查）全部跟着错。
 */
import { describe, expect, it } from "vitest";

import { EvidenceViolation, assertEvidenceDiscipline } from "../src/onto/flow_evidence.js";
import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { Origin, extracted, inferred, makeProvenance } from "../src/onto/oir.js";

function prov() {
  return makeProvenance("f1", "制度.docx", { kind: "raw", ref: "第3.2节" }, {
    snippet: "采购申请由发起人提交",
  });
}

describe("assertEvidenceDiscipline", () => {
  it("有出处的实证节点放行", () => {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({ rid: "fn_a", kind: NodeKind.ACTION, label: extracted("提交采购申请", prov()) }));

    expect(() => assertEvidenceDiscipline(g)).not.toThrow();
  });

  it("推断节点没有出处是合法的 —— 它没有声称自己来自材料", () => {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({ rid: "fn_a", kind: NodeKind.ACTION, label: inferred("推断出来的一步") }));

    expect(() => assertEvidenceDiscipline(g)).not.toThrow();
  });

  it("声称来自材料却没有出处 —— 当场拦下", () => {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({
      rid: "fn_a",
      kind: NodeKind.ACTION,
      label: { value: "凭空捏造的一步", origin: Origin.EXTRACTED, evidence: [], confidence: 1 },
    }));

    expect(() => assertEvidenceDiscipline(g)).toThrow(EvidenceViolation);
  });

  it("报错里点名是哪个节点、哪个字段 —— 不能只说「有问题」", () => {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({
      rid: "fn_a",
      kind: NodeKind.ACTION,
      label: { value: "凭空捏造的一步", origin: Origin.EXTRACTED, evidence: [], confidence: 1 },
    }));

    expect(() => assertEvidenceDiscipline(g)).toThrow(/凭空捏造的一步/u);
    expect(() => assertEvidenceDiscipline(g)).toThrow(/label/u);
  });

  it("actor 字段同样受管 —— 执行者也是会被当成事实引用的", () => {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({
      rid: "fn_a",
      kind: NodeKind.ACTION,
      label: extracted("提交采购申请", prov()),
      actor: { value: "采购员", origin: Origin.EXTRACTED, evidence: [], confidence: 1 },
    }));

    expect(() => assertEvidenceDiscipline(g)).toThrow(/actor/u);
  });

  it("一次把所有违规都列出来，不是碰到第一个就停", () => {
    const g = new FlowGraph();
    const bad = (v: string) =>
      ({ value: v, origin: Origin.EXTRACTED, evidence: [], confidence: 1 });
    g.addNode(makeFlowNode({ rid: "fn_a", kind: NodeKind.ACTION, label: bad("甲") }));
    g.addNode(makeFlowNode({ rid: "fn_b", kind: NodeKind.ACTION, label: bad("乙") }));

    try {
      assertEvidenceDiscipline(g);
      expect.unreachable("应该抛错");
    } catch (e) {
      expect((e as EvidenceViolation).violations).toHaveLength(2);
      expect((e as Error).message).toMatch(/甲/u);
      expect((e as Error).message).toMatch(/乙/u);
    }
  });

  it("空图放行", () => {
    expect(() => assertEvidenceDiscipline(new FlowGraph())).not.toThrow();
  });
});
