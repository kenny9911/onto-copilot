/**
 * `FlowNode.objects` 的契约：**只存业务对象 rid**。
 *
 * 这条契约被 `flow_extract` 违反过：一个步骤列了多个产物时，第二、三个产物的
 * **原始标签串**被 push 进 `objects`（"其余产物记在事件的 objects 上"）。
 * 后果不是显示错乱，而是**静默失效**：
 *
 *   `autoBindObjects` 的第一句是 `if (n.objects.length > 0) continue;`
 *   —— 它把"已经绑过对象"当作跳过的理由。于是这些事件节点**永远**不会被自动绑定，
 *   `impact.trace` 和 `flow.walk` 在它们身上都少报一截，而没有任何地方会报错。
 *
 * 真实库实测：`fdaced8ca9df` 有 18 个脏值，其中一个是**裸换行符**。
 *
 * 所以两侧都要管：写入侧不再污染，读取侧治愈已经落盘的历史数据。
 */
import { describe, expect, it } from "vitest";

import { flowFromDict } from "../src/onto/flow.js";
import { buildFlow, parseSteps } from "../src/onto/flow_extract.js";

describe("写入侧：多产物不再污染 objects", () => {
  const TEXT = [
    "（1）提交采购申请",
    "触发条件：部门提出需求",
    "输入：需求清单",
    "输出：采购申请单、采购台账、审批记录",
    "执行者：采购员",
    "（2）部门审批",
    "触发条件：收到采购申请单",
    "输入：采购申请单",
    "输出：审批结论",
    "执行者：部门负责人",
  ].join("\n");

  it("并列产物不会被塞进 objects —— 那个字段只放 rid", () => {
    const steps = parseSteps(TEXT, { cite: "制度.docx!p1", fileName: "制度.docx" });
    const g = buildFlow(steps, { fileName: "制度.docx" });

    for (const n of g.nodes.values()) {
      for (const o of n.objects) {
        expect(o, `objects 里出现了非 rid 的值：${JSON.stringify(o)}`)
          .toMatch(/^[a-z]+_/u);
      }
    }
  });

  it("事件节点因此仍是「未绑定」状态，能被自动绑定捡起来", () => {
    const steps = parseSteps(TEXT, { cite: "制度.docx!p1", fileName: "制度.docx" });
    const g = buildFlow(steps, { fileName: "制度.docx" });
    const events = [...g.nodes.values()].filter((n) => n.kind === "event");

    expect(events.length).toBeGreaterThan(0);
    // 空 objects 才会进入 autoBindObjects 的处理范围
    expect(events.every((n) => n.objects.length === 0)).toBe(true);
  });
});

describe("读取侧：治愈历史脏数据", () => {
  const dirtyDoc = {
    stages: [],
    workflows: [],
    nodes: [{
      rid: "fn_evt1", kind: "event", code: "EVT-X-1", stage: "",
      label: { value: "一级集采计划已生成", origin: "extracted", evidence: [], confidence: 1 },
      actor: { value: "", origin: "inferred", evidence: [], confidence: 0.4 },
      objects: ["ot_purchaseplan", "二级集采计划", "\n"],
      endpoint: "", status: "candidate",
    }],
    edges: [],
  };

  it("非 rid 的值在反序列化时被丢掉", () => {
    const g = flowFromDict(dirtyDoc);

    expect(g.nodes.get("fn_evt1")?.objects).toEqual(["ot_purchaseplan"]);
  });

  it("干净的历史数据原样保留", () => {
    const clean = structuredClone(dirtyDoc);
    clean.nodes[0]!.objects = ["ot_a", "ot_b"];

    expect(flowFromDict(clean).nodes.get("fn_evt1")?.objects).toEqual(["ot_a", "ot_b"]);
  });
});
