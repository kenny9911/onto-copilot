// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { contextSyncStore } from "../src/ui/context-sync.js";
import { ContextReceipts } from "../src/ui/react/context-receipts.js";
import { G } from "../src/ui/state.js";

beforeEach(() => {
  document.body.innerHTML = `<textarea id="cin"></textarea><aside id="preview"></aside>`;
  G.S = { id: "s1", state: { artifact_revision: 12 }, events: [] };
  G.TAB = "model";
  G.CONTEXT_BACK = null;
  contextSyncStore.clearReceipts();
  contextSyncStore.clearFocus();
});

afterEach(() => {
  cleanup();
  contextSyncStore.clearReceipts();
  contextSyncStore.clearFocus();
});

describe("<ContextReceipts>", () => {
  it("把已写入的侧栏变更显示为系统回执，而不是聊天气泡", () => {
    act(() => {
      contextSyncStore.publish({
        type: "review.answer",
        title: "已确认审批金额口径",
        summary: "采用含税金额",
        questionIds: ["q-18"],
      });
    });
    const { container } = render(<ContextReceipts />);
    expect(container.querySelector(".context-receipts")).not.toBeNull();
    expect(container.querySelector(".bub")).toBeNull();
    expect(container.textContent).toContain("项目上下文已更新");
    expect(container.textContent).toContain("已确认审批金额口径");
  });

  it("可引用到下一轮、跳回对应侧栏并关闭回执", () => {
    let receipt: ReturnType<typeof contextSyncStore.publish>;
    act(() => {
      receipt = contextSyncStore.publish({
        type: "delivery.select",
        title: "已选择流程图",
        summary: "流程图.svg",
        artifactIds: ["流程图.svg"],
      });
    });
    const view = render(<ContextReceipts />);
    fireEvent.click(view.getByRole("button", { name: "引用到下一轮" }));
    expect((document.getElementById("cin") as HTMLTextAreaElement).value).toContain("已选择流程图");
    expect(contextSyncStore.getSnapshot().activeReference?.refs.artifactIds).toEqual(["流程图.svg"]);

    fireEvent.click(view.getByRole("button", { name: "查看" }));
    expect(G.TAB).toBe("delivery");

    fireEvent.click(view.getByRole("button", { name: `关闭回执：${receipt!.title}` }));
    expect(view.container.querySelector(".context-receipts")).toBeNull();
  });

  // 「当前侧栏引用」那张卡已经删了 —— 它在聊天流里只是复述侧栏已经显示着的东西。
  // 这条测试从"显示引用条"翻过来：只浏览、没有写入回执时，聊天流里**什么都不该出现**。
  it("只浏览对象不产生任何聊天流卡片 —— 浏览不是写入", () => {
    act(() => {
      contextSyncStore.focus({
        source: "sidebar",
        section: "model",
        label: "Action：提交采购订单",
        entityIds: ["action-submit"],
        canvasNodeIds: ["node-submit"],
      });
    });
    const view = render(<ContextReceipts />);
    expect(view.container.querySelector(".context-focus")).toBeNull();
    expect(view.container.querySelector(".context-receipts")).toBeNull();
    expect(view.container.firstChild).toBeNull();
    // store 侧的 focus 仍然记着 —— 侧栏将来要订阅它做定位，删的只是聊天流里那张卡。
    expect(contextSyncStore.getSnapshot().activeReference?.label).toBe("Action：提交采购订单");
  });
});
