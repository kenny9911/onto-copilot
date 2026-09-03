/**
 * durable mutation queue（第 3 层）：梳理跑着时的写操作不再被拒 —— 排队、落库、
 * 跑完按序应用。三条纪律：
 *  · 应用镜像活编辑的全套动作（versions 栈 + 补丁日志 + 记忆），不是旁路；
 *  · 对不上的（结构变了/名字没了）以 stale **显式**报出，绝不静默丢；
 *  · 整个 drain 是尽力而为：单条失败不拖累其余，也绝不让 Run 本身失败。
 */
import { describe, expect, it } from "vitest";

import { FlowGraph, NodeKind, makeFlowNode } from "../src/onto/flow.js";
import { OIR, Status, extracted, inferred, makeObjectType, makeProvenance } from "../src/onto/oir.js";
import { drainMutationQueue, enqueueMutation } from "../src/server/glue/mutations.js";

function sess(): Record<string, any> {
  const events: any[] = [];
  const g = new FlowGraph();
  g.nodes.set("n1", makeFlowNode({ rid: "n1", kind: NodeKind.ACTION, label: inferred("提交申请") }));
  const oir = new OIR();
  const P = makeProvenance("f1", "a.xlsx", { row: 1 }, { snippet: "采购订单", extractor: "rule", confidence: 0.9 });
  oir.objects.set("do.po", makeObjectType({ rid: "do.po", apiName: extracted("po", P), displayName: extracted("采购订单", P) }));
  return {
    id: "s1", dir: "/tmp/onto-mq-test", state: { _flow: g, _oir: oir }, events,
    emit: (kind: string, payload: any = {}) => { events.push({ kind, ...payload }); return payload; },
  };
}

describe("enqueueMutation", () => {
  it("入队返回位置，队列落在 _mutation_queue", () => {
    const s = sess();
    expect(enqueueMutation(s as never, { tool: "flow", op: "rename_node", args: { node: "提交申请", label: "提交采购申请" }, source: "user" })).toBe(1);
    expect(enqueueMutation(s as never, { tool: "oir", op: "set_status", args: { target: "采购订单", status: "confirmed" }, source: "user" })).toBe(2);
    expect((s.state["_mutation_queue"] as unknown[]).length).toBe(2);
  });
});

describe("drainMutationQueue", () => {
  it("按序应用；成功的走全套（补丁日志），对不上的 stale 显式报出；队列清空", () => {
    const s = sess();
    enqueueMutation(s as never, { tool: "flow", op: "rename_node", args: { node: "提交申请", label: "提交采购申请" }, source: "user" });
    enqueueMutation(s as never, { tool: "oir", op: "set_status", args: { target: "采购订单", status: "confirmed" }, source: "user" });
    enqueueMutation(s as never, { tool: "flow", op: "rename_node", args: { node: "不存在的环节", label: "x" }, source: "user" });
    const got = drainMutationQueue(s as never, { rewriteFlow: () => undefined, persistOir: () => undefined });
    expect(got.applied).toHaveLength(2);
    expect(got.stale).toHaveLength(1);
    expect(got.stale[0]!.why).toContain("找不到");
    // 真的改上了
    expect((s.state["_flow"] as FlowGraph).nodes.get("n1")!.label.value).toBe("提交采购申请");
    expect((s.state["_oir"] as OIR).objects.get("do.po")!.status).toBe(Status.CONFIRMED);
    // 补丁日志累积（下一轮重建靠它重放）
    expect((s.state["_flow_patch_log"] as unknown[]).length).toBe(1);
    expect((s.state["_oir_patch_log"] as unknown[]).length).toBe(1);
    // 队列清空 + 事件带清单
    expect((s.state["_mutation_queue"] as unknown[]).length).toBe(0);
    const ev = s.events.find((e: any) => e.kind === "mutations.applied");
    expect(ev.applied).toBe(2);
    expect(JSON.stringify(ev.stale)).toContain("不存在的环节");
  });

  it("空队列是无操作：不发事件不碰状态", () => {
    const s = sess();
    const got = drainMutationQueue(s as never, { rewriteFlow: () => undefined, persistOir: () => undefined });
    expect(got.applied).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });
});
