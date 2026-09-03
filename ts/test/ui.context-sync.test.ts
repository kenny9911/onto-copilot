// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_NODE_REFERENCE_SCHEMA,
  CONTEXT_CHANGE_EVENT,
  CONTEXT_CHANGE_SCHEMA,
  CONTEXT_FOCUS_EVENT,
  CONTEXT_FOCUS_SCHEMA,
  canvasNodeCitation,
  contextReceiptCitation,
  contextReferenceFromCanvasNode,
  contextRevisionOf,
  createContextSyncStore,
  dispatchContextChangeRequest,
  dispatchContextFocusRequest,
  focusCanvasNodeReference,
  focusChatContext,
  genericScenarioDraftPrompt,
  installContextSyncBridge,
  prefillComposer,
  quoteContextReceiptToComposer,
  selectRecentContextReceipts,
  sendContextToChat,
} from "../src/ui/context-sync.js";

const NOW = Date.parse("2026-08-17T07:30:00.000Z");

function store(capacity = 80) {
  return createContextSyncStore({
    capacity,
    now: () => NOW,
    getSessionId: () => "s-procurement",
    getRevision: () => "r12",
  });
}

function answerInput(createdAt: string | number = NOW) {
  return {
    type: "review.answer",
    title: "已确认订单金额口径",
    summary: "采用含税总额",
    entityIds: ["ot_po", "ot_po", "pt_amount"],
    questionIds: ["q_tax"],
    evidenceIds: new Set(["ev_2", "ev_1"]),
    artifactIds: ["ontology.json"],
    canvasNodeIds: ["node-order"],
    createdAt,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ContextChangeReceipt", () => {
  it("把侧栏变更收口成稳定、去重、会话隔离的 wire shape", () => {
    const sync = store();
    let notifications = 0;
    sync.subscribe(() => { notifications += 1; });

    const first = sync.publish(answerInput());
    const duplicate = sync.publish(answerInput());

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      schemaVersion: CONTEXT_CHANGE_SCHEMA,
      sessionId: "s-procurement",
      type: "review.answer",
      section: "review",
      origin: "sidebar",
      title: "已确认订单金额口径",
      summary: "采用含税总额",
      revision: "r12",
      createdAt: "2026-08-17T07:30:00.000Z",
    });
    expect(first.id).toMatch(/^ctxr_[a-z0-9]+$/);
    expect(first.refs).toEqual({
      entityIds: ["ot_po", "pt_amount"],
      questionIds: ["q_tax"],
      evidenceIds: ["ev_1", "ev_2"],
      artifactIds: ["ontology.json"],
      canvasNodeIds: ["node-order"],
    });
    expect(sync.getSnapshot().receipts).toHaveLength(1);
    expect(sync.getSnapshot().version).toBe(1);
    expect(notifications).toBe(1); // 幂等 publish 不制造第二条“已补充”提示。
  });

  it("未知操作类型安全退回 context.update；revision 支持旧、新两种会话形态", () => {
    const sync = store();
    expect(sync.publish({ type: "alien", title: " ", createdAt: NOW })).toMatchObject({
      type: "context.update",
      section: "project",
      title: "上下文已更新",
    });
    expect(contextRevisionOf({ state: { artifact_revision: 7 } })).toBe("7");
    expect(contextRevisionOf({ project: { revision: { label: "r21" } } })).toBe("r21");
    expect(contextRevisionOf(null)).toBe("current");
  });

  it("容量、会话筛选、关闭与清空互不串台", () => {
    const sync = store(2);
    const a = sync.publish({ ...answerInput(NOW), sessionId: "s1", title: "A" });
    sync.publish({ ...answerInput(NOW + 1), sessionId: "s2", title: "B" });
    const c = sync.publish({ ...answerInput(NOW + 2), sessionId: "s1", title: "C" });
    expect(sync.getSnapshot().receipts.map((item) => item.title)).toEqual(["B", "C"]);
    expect(sync.getReceipt(a.id)).toBeNull();

    expect(selectRecentContextReceipts(sync.getSnapshot(), { sessionId: "s1" }).map((item) => item.id)).toEqual([c.id]);
    expect(sync.dismissReceipt(c.id)).toBe(true);
    expect(sync.dismissReceipt(c.id)).toBe(false);
    expect(selectRecentContextReceipts(sync.getSnapshot(), { sessionId: "s1" })).toEqual([]);
    expect(selectRecentContextReceipts(sync.getSnapshot(), { sessionId: "s1", includeDismissed: true })).toHaveLength(1);

    sync.clearReceipts("s2");
    expect(sync.getSnapshot().receipts.map((item) => item.title)).toEqual(["C"]);
    sync.clearReceipts();
    expect(sync.getSnapshot().receipts).toEqual([]);
  });
});

describe("双向 focus", () => {
  it("聊天引用回执后，侧栏能从 activeReference 找到同一实体/问题/证据", () => {
    const sync = store();
    const receipt = sync.publish(answerInput());
    const reference = sync.focusReceipt(receipt.id, "chat")!;
    expect(reference).toMatchObject({
      schemaVersion: CONTEXT_FOCUS_SCHEMA,
      source: "chat",
      section: "review",
      receiptId: receipt.id,
      sessionId: "s-procurement",
    });
    expect(reference.refs).toEqual(receipt.refs);
    expect(sync.getSnapshot().activeReference).toBe(reference);
    sync.clearFocus();
    expect(sync.getSnapshot().activeReference).toBeNull();
  });

  it("任意 chat turn.refs 或对象 chip 也能直接聚焦模型", () => {
    const sync = store();
    const reference = focusChatContext({
      section: "model",
      label: "聊天刚引用采购订单",
      entityIds: ["ot_po"],
      evidenceIds: ["ev_1"],
    }, sync);
    expect(reference.source).toBe("chat");
    expect(reference.refs.entityIds).toEqual(["ot_po"]);
    expect(sync.getSnapshot().activeReference?.id).toBe(reference.id);
  });
});

describe("Canvas node 稳定引用", () => {
  it("节点被收口为 sidebar/chat 共用的引用结构", () => {
    const first = contextReferenceFromCanvasNode({
      nodeId: "wf-approval",
      nodeType: "process",
      label: "采购订单审批",
      sessionId: "s1",
      revision: "r12",
      entityIds: ["ot_po"],
      questionIds: ["q_owner"],
      evidenceIds: ["ev_1"],
    });
    const second = contextReferenceFromCanvasNode({
      nodeId: "wf-approval",
      nodeType: "workflow",
      label: "采购订单审批",
      sessionId: "s1",
      revision: "r12",
      entityIds: ["ot_po"],
      questionIds: ["q_owner"],
      evidenceIds: ["ev_1"],
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: CANVAS_NODE_REFERENCE_SCHEMA,
      id: "canvas:workflow:wf-approval",
      nodeId: "wf-approval",
      nodeType: "workflow",
      section: "model",
      revision: "r12",
    });
    expect(first.refs).toEqual({
      entityIds: ["ot_po"],
      questionIds: ["q_owner"],
      evidenceIds: ["ev_1"],
      artifactIds: [],
      canvasNodeIds: ["wf-approval"],
    });
    expect(canvasNodeCitation(first)).toContain("引用画布节点「采购订单审批」");

    const sync = store();
    const focus = focusCanvasNodeReference(first, "sidebar", sync);
    expect(focus.refs.canvasNodeIds).toEqual(["wf-approval"]);
    expect(sync.getSnapshot().activeReference).toBe(focus);
  });
});

describe("Composer 与通用场景草案", () => {
  it("回执可非侵入式插入现有输入，一并广播 source=chat 的侧栏引用", () => {
    document.body.innerHTML = `<textarea id="cin">继续分析</textarea>`;
    const input = document.getElementById("cin") as HTMLTextAreaElement;
    const selection = input as unknown as { selectionStart: number; selectionEnd: number };
    selection.selectionStart = input.value.length;
    selection.selectionEnd = input.value.length;
    let inputEvents = 0;
    input.addEventListener("input", () => { inputEvents += 1; });
    const sync = store();
    const receipt = sync.publish(answerInput());

    const result = quoteContextReceiptToComposer(receipt, { store: sync });
    expect(result.inserted).toBe(true);
    expect(input.value).toContain("继续分析\n\n引用上下文「已确认订单金额口径」");
    expect(input.value).toContain("revision r12");
    expect(inputEvents).toBe(1);
    expect(result.reference).toMatchObject({ source: "chat", receiptId: receipt.id });
    expect(sync.getSnapshot().activeReference?.refs.questionIds).toEqual(["q_tax"]);

    const duplicate = quoteContextReceiptToComposer(receipt, { store: sync });
    expect(duplicate.inserted).toBe(false);
    expect(inputEvents).toBe(1);
    expect(contextReceiptCitation(receipt)).toContain("画布节点 node-order");
  });

  it("通用场景 prompt 明确无材料、输出类型、假设与验证，不把经验冒充客户事实", () => {
    const prompt = genericScenarioDraftPrompt({
      scenario: "连锁门店缺货后自动补货，并在高金额时走区域审批",
      outputType: "Workflow",
      assumptions: ["门店维护安全库存", "区域经理审批高金额订单"],
      validationFocus: ["阈值由谁维护？"],
      canvasNodeIds: ["scenario-replenishment"],
    });
    expect(prompt).toContain("生成一份 Workflow 草案");
    expect(prompt).toContain("通用场景：连锁门店缺货后自动补货");
    expect(prompt).toContain("当前没有可直接引用的客户材料");
    expect(prompt).toContain("不得表述为客户事实");
    expect(prompt).toContain("待验证假设");
    expect(prompt).toContain("阈值由谁维护？");
    expect(prompt).toContain("仅作定位，不代表证据");
  });

  it("prefillComposer 支持 Canvas 与草案；sendContextToChat 只有注入 send 才真正发送", async () => {
    document.body.innerHTML = `<textarea id="cin"></textarea>`;
    const sync = store();
    const canvas = contextReferenceFromCanvasNode({
      nodeId: "evt-approved", nodeType: "Event", label: "订单已审批", entityIds: ["ot_po"],
    }, { sessionId: "s-procurement", revision: "r12" });
    const canvasResult = prefillComposer(canvas, { store: sync, mode: "replace" });
    expect(canvasResult.prepared).toBe(true);
    expect(canvasResult.text).toContain("订单已审批");
    expect(canvasResult.reference?.source).toBe("chat");
    expect(sync.getSnapshot().activeReference?.refs.canvasNodeIds).toEqual(["evt-approved"]);

    const draft = {
      scenario: "合同到期前 30 天提醒续签",
      outputType: "Event",
      canvasNodeIds: ["evt-contract-expiring"],
    } as const;
    const notSent = await sendContextToChat(draft, { store: sync, mode: "replace" });
    expect(notSent.sent).toBe(false);
    const send = vi.fn(async () => {});
    const sent = await sendContextToChat(draft, { store: sync, mode: "replace", send });
    expect(sent.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((document.getElementById("cin") as HTMLTextAreaElement).value).toContain("输出类型：Event");
  });

  it("没有 composer 时只返回文本，不抛、不产生错误 focus", () => {
    const sync = store();
    const receipt = sync.publish(answerInput());
    const result = quoteContextReceiptToComposer(receipt, {
      document: { getElementById: () => null }, store: sync,
    });
    expect(result).toMatchObject({ inserted: false, reference: null });
    expect(sync.getSnapshot().activeReference).toBeNull();
  });
});

describe("CustomEvent bridge", () => {
  it("请求与通知分流；重复安装在 StrictMode 下仍只有一份监听", () => {
    const target = new EventTarget();
    const sync = store();
    const receipts: unknown[] = [];
    const focuses: unknown[] = [];
    target.addEventListener(CONTEXT_CHANGE_EVENT, (event) => {
      receipts.push((event as CustomEvent).detail);
    });
    target.addEventListener(CONTEXT_FOCUS_EVENT, (event) => {
      focuses.push((event as CustomEvent).detail);
    });
    const offA = installContextSyncBridge(target, sync);
    const offB = installContextSyncBridge(target, sync);

    expect(dispatchContextChangeRequest(answerInput(), target)).toBe(true);
    expect(sync.getSnapshot().receipts).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as any).schemaVersion).toBe(CONTEXT_CHANGE_SCHEMA);

    expect(dispatchContextFocusRequest({
      source: "chat", section: "model", label: "采购订单", entityIds: ["ot_po"],
    }, target)).toBe(true);
    expect(sync.getSnapshot().activeReference?.refs.entityIds).toEqual(["ot_po"]);
    expect(focuses).toHaveLength(1);

    offA(); // 第二个 effect 仍持有 bridge。
    dispatchContextChangeRequest({ ...answerInput(NOW + 1), title: "第二条" }, target);
    expect(sync.getSnapshot().receipts).toHaveLength(2);
    offB();
    dispatchContextChangeRequest({ ...answerInput(NOW + 2), title: "不会接收" }, target);
    expect(sync.getSnapshot().receipts).toHaveLength(2);
  });
});
