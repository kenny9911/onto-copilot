/**
 * 「汇报版」展示副本 —— 图像模型画的那张。
 *
 * 它和核心产物的关系只有一条：**单向**。它读结构去画，画完不回写。
 *
 * 为什么要把这条写死成契约而不是靠自觉：一张 PNG 点不开出处、改不了、
 * 走查走不了、和别的版本比不了。一旦它被当成"流程图"参与校验或交付门禁，
 * 前面所有关于证据、可编辑、可追溯的保证就都白做了。
 * 所以它必须自带标记，并且被门禁明确排除。
 */
import { describe, expect, it } from "vitest";

import { Capability, CAPABILITIES } from "../src/kernel/catalog.js";
import {
  DISPLAY_ONLY, isDisplayOnly, presentationBrief, presentationPromptOf,
} from "../src/onto/flow_presentation.js";
import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { inferred } from "../src/onto/oir.js";

describe("Capability.IMAGE_GEN", () => {
  it("能力枚举里有出图这一项", () => {
    expect(Capability.IMAGE_GEN).toBe("image_gen");
  });

  it("★ 追加在末尾 —— 声明顺序被 golden 钉着，插在中间会改掉既有字节", () => {
    expect(CAPABILITIES[CAPABILITIES.length - 1]).toBe(Capability.IMAGE_GEN);
  });

  it("读图和出图是两回事，不许混", () => {
    expect(Capability.VISION).not.toBe(Capability.IMAGE_GEN);
  });
});

describe("展示副本的标记", () => {
  it("带 display_only 标记的产物能被认出来", () => {
    expect(isDisplayOnly({ kind: DISPLAY_ONLY })).toBe(true);
  });

  it("普通产物不会被误判", () => {
    expect(isDisplayOnly({ kind: "svg" })).toBe(false);
    expect(isDisplayOnly({})).toBe(false);
  });

  it("标记里必须写清它不能用来干什么", () => {
    const meta = presentationBrief();

    expect(meta.kind).toBe(DISPLAY_ONLY);
    expect(meta.notice).toMatch(/不可编辑/u);
    expect(meta.notice).toMatch(/出处|溯源/u);
    expect(meta.notice).toMatch(/门禁|校验|交付/u);
  });

  it("说明里要点出中文标签可能出错 —— 这是图像模型的已知局限，不能瞒", () => {
    expect(presentationBrief().notice).toMatch(/中文|错字/u);
  });
});

describe("给图像模型的输入", () => {
  function graph() {
    const g = new FlowGraph();
    g.addNode(makeFlowNode({
      rid: "fn_1", kind: NodeKind.ACTION, label: inferred("提交采购申请"),
      actor: inferred("采购员"),
    }));
    g.addNode(makeFlowNode({
      rid: "fn_2", kind: NodeKind.GATEWAY, label: inferred("金额判断"),
    }));
    g.connect("fn_1", "fn_2", { label: "金额大于5万" });
    return g;
  }

  it("喂给它的是结构的文字描述，不是让它自由发挥", () => {
    const d = presentationPromptOf(graph());

    expect(d).toContain("提交采购申请");
    expect(d).toContain("金额判断");
  });

  it("分支条件要带上 —— 那是图上最要紧的信息", () => {
    expect(presentationPromptOf(graph())).toContain("金额大于5万");
  });

  it("执行者要带上，画出来才有泳道", () => {
    expect(presentationPromptOf(graph())).toContain("采购员");
  });

  it("Image 2 不套固定 classic，而是按拓扑动态选择布局与配色", () => {
    const prompt = presentationPromptOf(graph());
    expect(prompt).toContain("不要套固定 classic 模板");
    expect(prompt).toContain("分支密度");
    expect(prompt).toContain("自行选择横向或纵向布局");
    expect(prompt).toContain("生成与业务语义匹配");
  });

  it("空图给空串，不让模型凭空画一张", () => {
    expect(presentationPromptOf(new FlowGraph())).toBe("");
  });
});
