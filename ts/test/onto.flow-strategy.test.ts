/**
 * 策略路由 —— 「让 AI 自己决定用哪种方法画流程图」。
 *
 * 两部分，这里测的是**可确定性判定**的那两半：
 *
 *   1. `scanFlowSignals`：零模型的材料能力扫描。模型看到的是这份信号摘要，
 *      不是材料全文 —— 所以这一步很便宜。
 *   2. `validateChoice`：对模型选择的硬校验。**信号为零的策略不许被选中**，
 *      否则模型可以凭空点一条根本跑不了的路，管线一路走到空图才发现。
 *
 * 中间那次模型调用不在这里测（它是模型行为），但它的输入和输出都被这两半夹住。
 */
import { describe, expect, it } from "vitest";

import { STRATEGIES, scanFlowSignals, validateChoice } from "../src/onto/flow_strategy.js";

function doc(over: Record<string, unknown> = {}) {
  return {
    file_id: "f1", file_name: "材料.docx", kind: "docx",
    chunks: [], findings: [], structured: {},
    ...over,
  } as never;
}

describe("scanFlowSignals", () => {
  it("BPMN 文件被数出来", () => {
    const s = scanFlowSignals([doc({ kind: "bpmn", file_name: "流程.bpmn" })], {});

    expect(s.bpmnFiles).toBe(1);
  });

  it("PPT 里的连接线被数出来 —— 数的是边不是页", () => {
    const s = scanFlowSignals([doc({
      kind: "pptx",
      structured: { slide_flows: [{ page: 2, nodes: [1, 2, 3], edges: [1, 2] }] },
    })], {});

    expect(s.pptConnectors).toBe(2);
  });

  it("图片里识别出的连线被数出来", () => {
    const s = scanFlowSignals([doc({
      kind: "pdf",
      structured: { relations: [{ from_entity: "甲", to_entity: "乙" }] },
    })], {});

    expect(s.visionRelations).toBe(1);
  });

  it("接口清单被数出来", () => {
    const s = scanFlowSignals([doc()], { _endpoints: [{ path: "/a" }, { path: "/b" }] });

    expect(s.apiEndpoints).toBe(2);
  });

  it("什么信号都没有的材料，各项都是 0", () => {
    const s = scanFlowSignals([doc()], {});

    expect(s.bpmnFiles + s.pptConnectors + s.visionRelations + s.apiEndpoints).toBe(0);
  });

  it("扫描不看业务词，只看结构 —— 换个行业的材料照样能扫", () => {
    const s = scanFlowSignals([doc({
      kind: "pptx", file_name: "医院陪护流程.pptx",
      structured: { slide_flows: [{ page: 1, nodes: [1], edges: [1] }] },
    })], {});

    expect(s.pptConnectors).toBe(1);
  });
});

describe("validateChoice", () => {
  const signals = {
    bpmnFiles: 0, pptConnectors: 47, visionRelations: 0,
    numberedStepChunks: 0, apiEndpoints: 0, materialCount: 3,
  };

  it("选了有信号的策略 —— 放行", () => {
    const r = validateChoice(["S2"], signals);

    expect(r.ok).toBe(true);
    expect(r.accepted).toEqual(["S2"]);
  });

  it("★ 选了信号为零的策略 —— 剔除，并说明为什么", () => {
    const r = validateChoice(["S1", "S2"], signals);

    expect(r.accepted).toEqual(["S2"]);
    expect(r.rejected[0]?.strategy).toBe("S1");
    expect(r.rejected[0]?.why).toMatch(/没有|零|信号/u);
  });

  it("不在固定集合里的策略名被拒 —— 防模型臆造", () => {
    const r = validateChoice(["S9", "让AI随便画"], signals);

    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
  });

  it("一条都不剩时 ok 为假 —— 调用方要据此回落", () => {
    const r = validateChoice(["S1"], signals);

    expect(r.ok).toBe(false);
  });

  it("通用参考图不需要材料信号 —— 它本来就是没材料时用的", () => {
    const empty = { ...signals, pptConnectors: 0 };
    const r = validateChoice(["S7"], empty);

    expect(r.ok).toBe(true);
  });

  it("重复选中同一条只算一次", () => {
    const r = validateChoice(["S2", "S2"], signals);

    expect(r.accepted).toEqual(["S2"]);
  });

  it("策略集合是固定的，模型只能从里面选", () => {
    expect(STRATEGIES).toContain("S1");
    expect(STRATEGIES).toContain("S7");
    expect(STRATEGIES).not.toContain("S9");
  });
});
