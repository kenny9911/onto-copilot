// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextSyncStore, sendContextToChat } from "../src/ui/context-sync.js";
import { setLang } from "../src/ui/i18n.js";
import { G } from "../src/ui/state.js";
import { bumpUi } from "../src/ui/react/store.js";
import ContextSidebar, {
  ContextViewer, contextChatBridge, REVIEW_DRAFTS, REVIEW_NAV, sheetsFromJson, type ContextViewerTarget,
} from "../src/ui/react/context-sidebar.js";
import { PreviewBody } from "../src/ui/react/preview.js";
import { sidebarData } from "../src/ui/react/context-region.js";
import {
  WORKBENCH_TAB_ID,
  emptyWorkbenchTabs,
  reduceWorkbenchTabs,
  saveWorkbenchTabs,
  workbenchTabsStorageKey,
} from "../src/ui/react/workbench-tabs.js";

const g = globalThis as any;

function response(payload: unknown): any {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function failedResponse(status = 500, message = "failed"): any {
  return { ok: false, status, json: async () => ({}), text: async () => message };
}

function target(patch: Partial<ContextViewerTarget> = {}): ContextViewerTarget {
  return {
    id: "graph:current:all",
    type: "graph",
    title: "Ontology 工作流画布",
    format: "graph",
    extension: "",
    url: "/api/sessions/s-context/preview?source=model&name=flow",
    downloadUrl: "",
    sourceLabel: "模型 r12",
    fileName: "",
    cite: "",
    snippet: "",
    flow: {},
    oir: {},
    ...patch,
  };
}

/** 决定写入后自动发往聊天的那一步；测试收下 prompt，不真跑命令式 render()。 */
const SENT: string[] = [];

beforeEach(() => {
  SENT.length = 0;
  REVIEW_DRAFTS.clear();
  REVIEW_NAV.selectedId = "";
  REVIEW_NAV.drillQuestionId = "";
  contextChatBridge.send = async () => {
    SENT.push((document.getElementById("cin") as HTMLTextAreaElement).value);
  };
  document.body.innerHTML = '<textarea id="cin"></textarea><aside id="preview"><div id="pbody"></div></aside>';
  g.CSS = g.CSS || { escape: (value: string) => value };
  g.alert = () => {};
  contextSyncStore.clearFocus();
  contextSyncStore.clearReceipts();
  const canvas = g.HTMLCanvasElement?.prototype;
  if (canvas) canvas.getContext = () => ({
    scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, bezierCurveTo() {}, stroke() {},
    setLineDash() {}, lineTo() {}, closePath() {}, fill() {}, fillText() {},
  });
  g.fetch = async (url: string) => {
    if (String(url).endsWith("/questions")) {
      return response({ questions: G.Q_BACKLOG, summary: {}, nextBatch: [], revision: 1 });
    }
    return response({});
  };
  G.S = {
    id: "s-context",
    title: "采购协同项目",
    status: "done",
    mode: "work",
    state_version: 12,
    filelist: [{ name: "实体梳理.xlsx", state: "parsed", chunks: 32 }],
    state: {
      artifacts: ["oir.json", "流程图.svg"],
      oir: {
        objects: [{
          rid: "object:purchase-order",
          displayName: { value: "采购订单" },
          apiName: { value: "PurchaseOrder" },
          description: { value: "记录采购需求、审批与履约状态" },
          status: "已确认",
        }],
        properties: [{ parent: "PurchaseOrder", displayName: { value: "订单编号" }, apiName: { value: "orderNo" } }],
        links: [{ from: "PurchaseOrder", to: "Supplier", cardinality: "多对一" }],
        actions: [], rules: [], questions: [], stats: { objects: 1 },
      },
      flow: { workflows: [], stages: [], nodes: [], edges: [] },
    },
  };
  G.TAB = "model";
  G.LANG = "zh";
  localStorage.setItem("oc_lang", "zh");
  localStorage.removeItem("oc_graph_layout:s-context");
  localStorage.removeItem("oc_graph_layout:s-another");
  localStorage.removeItem(workbenchTabsStorageKey("s-context"));
  document.documentElement.lang = "zh-CN";
  G.Q_API = true;
  G.Q_NEXT = [];
  G.OPS = [];
  G.TRACE = [];
  G.THINKING = false;
  G.Q_BACKLOG = [{
    id: "q-cancel",
    text: "采购订单取消后的补偿动作是什么？",
    status: "open",
    priority: "blocking",
    applies: ["PurchaseOrder"],
    options: [],
    evidence: [],
    owner: "",
    role: "业务负责人",
    source: "rule-gap",
  }];
});

afterEach(() => cleanup());

describe("FDE 项目上下文 sidebar", () => {
  it("sidebarData 把 sketch 保留在独立预览字段，不并进正式 flow", () => {
    const formalFlow = { workflows: [], stages: [], nodes: [], edges: [] };
    const sketch = { domain: "采购审批", graph: { nodes: [{ rid: "sketch:1" }], edges: [] } };
    const session = {
      ...G.S,
      state: { ...(G.S as any).state, flow: formalFlow, sketch },
    };
    const data = sidebarData(null, session, []);
    expect(data.flow).toBe(formalFlow);
    expect(data.sketch).toBe(sketch);
  });

  it("审阅写入后的 live ledger 覆盖进入会话时的 /context 快照", () => {
    const data = sidebarData({
      schemaVersion: "ontocopilot.context/1",
      project: { session: { id: "s-context" }, revision: 1 },
      evidence: { records: [] },
      model: { revision: 1, items: [] },
      review: { questions: [{ id: "q-1", text: "旧问题", status: "open", revision: 1 }] },
      delivery: { artifacts: [] },
    }, G.S, [{ id: "q-1", text: "旧问题", status: "answered", answer: "新结论", revision: 2 }]);
    expect(data.questions).toEqual([expect.objectContaining({ id: "q-1", status: "answered", answer: "新结论" })]);
  });

  it("默认模型视图提供项目工作区与运行导航、搜索、筛选和对象详情", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(Array.from(container.querySelectorAll(".ctx-nav-item") as any[]).map((node: any) => node.textContent))
      .toEqual(["项目", "文件", "模型", "审阅", "交付", "运行"]);
    expect(container.querySelector('.ctx-nav-item[aria-selected="true"]')?.textContent).toBe("模型");
    expect(container.querySelector(".ctx-search input")?.getAttribute("placeholder")).toContain("对象");
    expect(container.textContent).toContain("采购订单");
    expect(container.textContent).toContain("PurchaseOrder");
    expect(container.textContent).toContain("关联");
    expect(container.textContent).toContain("待确认");
  });

  it("右侧文件页只显示本次会话附件，不再嵌入项目知识库", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "文件") as HTMLButtonElement);

    expect(container.querySelector(".od-session-section")).not.toBeNull();
    expect(container.querySelector(".od-library"), "项目知识库仍被嵌在右侧栏").toBeNull();
    expect(container.textContent).toContain("请到左侧入口打开“项目知识库”管理");
  });

  it("oc:workbench-open 把网页开成工作台 sibling，按 pageId 去重且不卸载六页工作台", async () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    act(() => window.dispatchEvent(new CustomEvent("oc:workbench-open", { detail: {
      kind: "web", pageId: "sap-help", url: "https://help.sap.com/pr", title: "SAP 采购申请",
    } })));
    await waitFor(() => expect(container.querySelector('.wb-tab[title="SAP 采购申请"]')).not.toBeNull());
    expect(container.querySelector(".wb-workbench-page")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".wb-resource-page:not([hidden]) .oc-web-preview")).not.toBeNull();
    expect(container.querySelector(".wb-resource-page:not([hidden]) .oc-web-preview")?.getAttribute("data-surface")).toBe("live");
    expect(container.querySelector('.wb-resource-page:not([hidden]) .oc-web-preview-mode')).toBeNull();
    expect(container.querySelector('.wb-resource-page:not([hidden]) .oc-web-preview-language')).toBeNull();
    expect(container.querySelector('.wb-resource-page:not([hidden]) .oc-web-preview-summary-trigger')).not.toBeNull();
    expect(container.querySelectorAll(".ctx-nav-item")).toHaveLength(6); // 常驻而不是卸载

    act(() => window.dispatchEvent(new CustomEvent("oc:workbench-open", { detail: {
      kind: "web", pageId: "sap-help", url: "https://help.sap.com/pr#approval", title: "SAP 审批说明",
      viewState: { language: "zh" },
    } })));
    await waitFor(() => expect(container.querySelector('.wb-tab[title="SAP 审批说明"]')).not.toBeNull());
    expect(container.querySelectorAll(".wb-tab-close")).toHaveLength(1);

    fireEvent.click(container.querySelector('.wb-tab[title="工作台"]') as HTMLButtonElement);
    expect(container.querySelector(".wb-workbench-page")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector('.ctx-nav-item[aria-selected="true"]')?.textContent).toBe("审阅");
  });

  it("两个隐藏 web tab 的晚到响应只回填内容，不抢工作台焦点或污染 MRU", async () => {
    type Resolve = () => void;
    let resolveA: Resolve | undefined;
    let resolveB: Resolve | undefined;
    const page = (id: string, title: string, url: string) => ({
      id, url, finalUrl: url, title, status: "snapshot",
      fetchedAt: "2026-08-28T17:00:00.000Z", digest: `digest-${id}`, contentType: "text/html",
      embed: { allowed: false, reason: "snapshot only" },
      paragraphs: [{ id: `${id}-p1`, text: title, citationIds: [] }], citations: [],
    });
    g.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/questions")) return response({ questions: G.Q_BACKLOG, summary: {}, nextBatch: [], revision: 1 });
      if (String(url).includes("/web/pages/page-a")) {
        return await new Promise((resolve) => { resolveA = () => resolve(response({ page: page("page-a", "A · 已加载", "https://a.example/") })); });
      }
      if (String(url).includes("/web/pages/page-b")) {
        return await new Promise((resolve) => { resolveB = () => resolve(response({ page: page("page-b", "B · 已加载", "https://b.example/") })); });
      }
      return response({});
    });

    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    act(() => window.dispatchEvent(new CustomEvent("oc:workbench-open", { detail: {
      kind: "web", pageId: "page-a", url: "https://a.example/", title: "A · 读取中",
    } })));
    await waitFor(() => expect(resolveA).toBeTypeOf("function"));
    act(() => window.dispatchEvent(new CustomEvent("oc:workbench-open", { detail: {
      kind: "web", pageId: "page-b", url: "https://b.example/", title: "B · 读取中",
    } })));
    await waitFor(() => expect(resolveB).toBeTypeOf("function"));
    fireEvent.click(container.querySelector('.wb-tab[title="工作台"]') as HTMLButtonElement);
    expect(container.querySelector('.wb-tab[aria-selected="true"]')?.getAttribute("title")).toBe("工作台");

    await act(async () => { resolveB?.(); });
    await waitFor(() => expect(container.querySelector('.wb-tab[title="B · 已加载"]')).not.toBeNull());
    expect(container.querySelector('.wb-tab[aria-selected="true"]')?.getAttribute("title")).toBe("工作台");
    await act(async () => { resolveA?.(); });
    await waitFor(() => expect(container.querySelector('.wb-tab[title="A · 已加载"]')).not.toBeNull());
    expect(container.querySelector('.wb-tab[aria-selected="true"]')?.getAttribute("title")).toBe("工作台");

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(workbenchTabsStorageKey("s-context")) || "{}");
      expect(stored.activeId).toBe(WORKBENCH_TAB_ID);
      expect(stored.mru?.[0]).toBe(WORKBENCH_TAB_ID);
      expect(stored.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({
          viewState: expect.objectContaining({ webHistory: expect.objectContaining({ entries: expect.any(Array) }) }),
        }) }),
      ]));
    });
  });

  it("存为材料的网页进入现有文件页，并按不可变 pageId/digest 重新打开", async () => {
    (G.S as any).state.asset_memory = {
      $schema: "ontocopilot.asset-memory/1",
      sessionId: "s-context",
      lastSeq: 8,
      assets: [{
        id: "asset_web_1", kind: "reference", mime: "text/html", name: "SAP 采购申请管理",
        source: "web.preview", status: "active", uri: "https://help.sap.com/pr",
        contentDigest: "digest-v1", metadata: {
          pageId: "page-sap-v1", finalUrl: "https://help.sap.com/pr", title: "SAP 采购申请管理",
          digest: "digest-v1", fetchedAt: "2026-08-28T14:32:00.000Z",
        },
      }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "文件") as HTMLButtonElement);
    expect(container.textContent).toContain("1 份网页材料");
    const row = Array.from(container.querySelectorAll(".ctx-web-material") as any[])
      .find((node: any) => node.textContent.includes("SAP 采购申请管理")) as HTMLButtonElement;
    fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.wb-tab[title="SAP 采购申请管理"]')).not.toBeNull());
    expect(container.querySelector(".wb-resource-page:not([hidden]) .oc-web-preview")).not.toBeNull();
  });

  it("刷新后用轻量定位恢复文件页签，不把整棵 OIR/Flow 冻结进 localStorage", async () => {
    const target = {
      kind: "file" as const,
      key: "material:material:采购制度.pdf:",
      id: "material:采购制度.pdf:",
      title: "采购制度.pdf",
      url: "/api/sessions/s-context/preview?source=material&name=采购制度.pdf",
      viewState: { viewer: {
        id: "material:采购制度.pdf:", type: "material", title: "采购制度.pdf", format: "pdf",
        extension: "pdf", url: "/api/sessions/s-context/preview?source=material&name=采购制度.pdf",
        downloadUrl: "/api/sessions/s-context/source?file=采购制度.pdf", sourceLabel: "项目材料",
        fileName: "采购制度.pdf", cite: "", snippet: "",
      } },
    };
    saveWorkbenchTabs(reduceWorkbenchTabs(emptyWorkbenchTabs("s-context"), { type: "open", target }));
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    await waitFor(() => expect(container.querySelector('.wb-tab[title="采购制度.pdf"]')).not.toBeNull());
    expect(container.querySelector(".wb-resource-page:not([hidden]) .ctx-viewer")).not.toBeNull();
    expect(container.querySelector(".ctx-viewer-title")?.textContent).toContain("采购制度.pdf");
    const persisted = localStorage.getItem(workbenchTabsStorageKey("s-context")) || "";
    expect(persisted).not.toContain('"oir"');
    expect(persisted).not.toContain('"flow"');
  });

  it("运行页合并同一步的开始/完成事件，并展示输入、输出、元数据和原始事件", () => {
    G.S.events = [
      { seq: 10, ts: 100, kind: "chat.step", event_id: "ev-start", step: {
        turn: "run-1", n: 1, q: "梳理采购审批", thought: "先查审批规则", tool: "web.search",
        args: { query: "采购审批", api_key: "sk-super-secret-value" }, model: "gpt-test",
      } },
      { seq: 11, ts: 102, kind: "chat.step", event_id: "ev-done", step: {
        turn: "run-1", n: 1, q: "梳理采购审批", tool: "web.search",
        args: { query: "采购审批", api_key: "sk-super-secret-value" }, observation: "返回 5 条结果", model: "gpt-test",
      } },
      { seq: 12, ts: 103, kind: "kernel.node_completed", node: "EXTRACT", secs: 2.4, detail: "抽取完成" },
      { seq: 13, ts: 104, kind: "chat.turn", turn: { speaker: "user", text: "不应重复到运行页" } },
    ] as never;
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "运行") as HTMLButtonElement);
    expect(container.querySelector(".ctx-sidebar-title")?.textContent).toBe("运行详情");
    expect(container.querySelectorAll(".ctx-runtime-step")).toHaveLength(1);
    expect(container.textContent).toContain("梳理采购审批");
    expect(container.textContent).toContain("输入");
    expect(container.textContent).toContain("采购审批");
    expect(container.textContent).toContain("输出");
    expect(container.textContent).toContain("返回 5 条结果");
    expect(container.textContent).toContain("元数据");
    expect(container.textContent).toContain("ev-start");
    expect(container.textContent).toContain("原始事件 · 2 条");
    expect(container.textContent).toContain("抽取完成");
    expect(container.textContent).toContain("[已隐藏敏感信息]");
    expect(container.textContent).not.toContain("sk-super-secret-value");
    expect(container.textContent).not.toContain("不应重复到运行页");
  });

  it("运行页接入内核 journal，带 ref 的完整输入输出在展开时按需读取", async () => {
    G.S.events = [{ seq: 1, ts: 1, kind: "chat.step", step: { turn: "chat-1", n: 1, tool: "web.search", args: { q: "采购" }, observation: "摘要" } }] as never;
    g.fetch = async (url: string) => {
      if (String(url).endsWith("/runtime/runs")) return response({
        total_runs: 1, truncated: false, runs: [{
          id: "chat_s-context_reason_demo", status: "recorded", quarantined: false,
          event_count: 2, started_at_ms: 1_000, ended_at_ms: 1_200, truncated: false,
          events: [
            { run_id: "chat_s-context_reason_demo", seq: 0, kind: "effect.requested", ts_ms: 1_000, node_id: "TOOL",
              payload: { key: "TOOL#0", kind: "tool.call", request: { query: "采购审批…(+20)" } }, ref: "blob:req", redacted: false },
            { run_id: "chat_s-context_reason_demo", seq: 1, kind: "effect.completed", ts_ms: 1_200, node_id: "TOOL",
              payload: { key: "TOOL#0", kind: "tool.call" }, ref: "blob:abc", redacted: false },
          ],
        }],
      });
      if (String(url).endsWith("/events/0")) return response({
        fidelity: "full", resolved: { query: "采购审批", max_tokens: 16000, api_key: "***已打码***" }, resolve_error: "", redacted: true,
      });
      if (String(url).endsWith("/events/1")) return response({
        fidelity: "full", resolved: { answer: "完整工具输出" }, resolve_error: "", redacted: false,
      });
      return response({});
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "运行") as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain("Harness 执行账本"));
    expect(container.textContent).toContain("对话推理");
    expect(container.textContent).toContain("tool.call");
    expect(container.textContent).toContain("采购审批");
    expect(container.textContent).toContain("完整输入");
    await waitFor(() => expect(container.textContent).toContain("16000"));
    expect(container.textContent).toContain("敏感字段已在服务端打码");
    await waitFor(() => expect(container.textContent).toContain("完整工具输出"));
    expect(container.textContent).toContain("原始内核事件 · 2 条");
  });

  it("审阅是两级导航：队列不自动展开详情，点条目进详情，返回回队列", async () => {
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    const review = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement;
    fireEvent.click(review);
    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());
    expect(container.textContent).toContain("采购订单取消后的补偿动作是什么？");
    // 一级页只有队列；详情（回答框）不许自动展开挤在同一屏里。
    expect(container.querySelector("textarea.ctx-review-answer")).toBeNull();
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector("textarea.ctx-review-answer")).not.toBeNull());
    expect(container.querySelector(".ctx-review-list")).toBeNull(); // 详情替换队列，是二级页
    expect(container.textContent).toContain("记录决定");
    fireEvent.click(container.querySelector(".ctx-review-back") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());
    expect(container.querySelector("textarea.ctx-review-answer")).toBeNull();
  });

  it("拉宽侧栏时筛选条不许被 flex 压扁（阻塞/重要/完整性/批量 只剩半截胶囊）", () => {
    // 2026-08-25 用户截图：侧栏拉宽后审阅的筛选分类只剩一条边。机制是
    // `.ctx-review-queue` 是 flex 纵列，容器查询在宽屏给它加 max-height+overflow，
    // 于是筛选条按 flex 默认 shrink:1 被压扁 —— 而不是让队列去滚。
    // 两道保险：队列里的固定件不许收缩；宽屏也不再给队列套内层滚动盒
    //（两级导航之后队列是独占一屏的，没有第二栏要对齐了）。
    const css = readFileSync(resolve(process.cwd(), "../ui/index.template.html"), "utf8");
    expect(css).toMatch(/\.ctx-review-queue>\.ctx-filters,\.ctx-review-queue>\.ctx-review-queue-head\{[^}]*flex:0 0 auto/u);
    expect(css).not.toMatch(/\.ctx-review-queue\{[^}]*overflow-y:auto/u);
  });

  it("换会话时审阅的选中项与草稿不许串台（批次 id 在会话之间是稳定的）", async () => {
    // batch:missing_primary_key 这类 id 每个会话都一样 —— 记住「上次停在哪」
    // 如果不按会话隔离，换到另一个会话会直接落进那个会话的同名批次详情页，
    // 草稿更糟：会把 A 会话写了一半的结论显示在 B 会话的问题下面。
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const answer = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    fireEvent.change(answer, { target: { value: "A 会话写了一半" } });
    // **不 cleanup、不重新 render** —— 真实的换会话只触发 re-render，不触发
    // remount（context-region.tsx 没有按会话 key）。上一版测试靠 cleanup() 拿到了
    // 一次重挂载，于是「复位」代码即使完全无效也能绿：本地 state 是 useState 初值，
    // 只在挂载时读一次，render 期改模块级变量根本改不动它。
    G.S = { ...G.S, id: "s-another" };
    bumpUi();
    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());
    // 回到队列，不是上一个会话停留的详情页
    expect(container.querySelector("textarea.ctx-review-answer")).toBeNull();
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const fresh = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    expect(fresh.value).not.toContain("A 会话写了一半");
  });

  it("四个动作都写明后果 —— 用户不该靠猜「分派/延期/记录决定」是什么", async () => {
    // 2026-08-25 用户原话：「每个问题的『应答要求』『分派』『延期』『记录』都是什么？」
    // 四个按钮里三个会写库、一个只是展开说明，而界面上没有一个字解释它们。
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector("textarea.ctx-review-answer")).not.toBeNull());
    const legend = container.querySelector(".ctx-review-legend");
    expect(legend?.textContent).toContain("记录决定");
    expect(legend?.textContent).toContain("台账");   // 说清落到哪里
    expect(legend?.textContent).toContain("分派");
    expect(legend?.textContent).toContain("延期");
    // 悬停也要有解释（按钮本身自带 title）。
    const byLabel = (label: string) => Array.from(container.querySelectorAll("button") as any[])
      .find((node: any) => node.textContent === label) as HTMLButtonElement;
    expect(byLabel("记录决定").getAttribute("title")).toContain("台账");
    expect(byLabel("延期").getAttribute("title")).toContain("原因");
    expect(byLabel("分派").getAttribute("title")).toContain("谁");
  });

  it("详情里的填写在返回/重进后仍在（跑批拒写时草稿不能跟着丢）", async () => {
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const answer = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    fireEvent.change(answer, { target: { value: "补偿动作先写一半" } });
    fireEvent.click(container.querySelector(".ctx-review-back") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const again = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    expect(again.value).toBe("补偿动作先写一半");
  });

  it("侧栏与审阅页不再摆装饰性说明文字", async () => {
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    expect(container.querySelector(".ctx-sidebar-subtitle")).toBeNull();
    expect(container.textContent).not.toContain("文件、模型、决策与交付的同一份视图");
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-grid")).not.toBeNull());
    expect(container.querySelector(".ctx-review-summary")).toBeNull();
    expect(container.textContent).not.toContain("业务/建模问题");
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "交付") as HTMLButtonElement);
    expect(container.textContent).not.toContain("可生成正式交付包");
  });

  it("决定卡给出问题编号、证据对照与可跳转的影响范围", async () => {
    G.Q_BACKLOG = [{
      id: "q-018",
      text: "审批金额是否含税？",
      status: "open",
      priority: "blocking",
      role: "流程负责人",
      why: "两份材料使用了不同口径，将影响审批网关与报表金额",
      applies: ["PurchaseOrder"],
      blockedArtifacts: ["流程图.svg"],
      options: [{ id: "with-tax", label: "含税" }, { id: "no-tax", label: "不含税" }],
      evidence: [
        { file_name: "采购制度.docx", cite: "采购制度.docx#p4", snippet: "采购金额以发票含税金额为准。" },
        { file_name: "审批矩阵.xlsx", cite: "审批矩阵.xlsx!Sheet1!R18", snippet: "不含税金额" },
      ],
      source: "open_question",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-crumb")).not.toBeNull());
    expect(container.querySelector(".ctx-review-crumb")?.textContent).toBe("问题 / Q-018");
    expect(container.querySelector(".ctx-review-role")?.textContent).toBe("流程负责人");
    expect(container.textContent).toContain("为什么要确认");
    expect(container.textContent).toContain("两份材料使用了不同口径");
    expect(container.querySelectorAll(".ctx-evidence-card")).toHaveLength(2);
    expect(container.querySelector(".ctx-evidence-card")?.textContent).toContain("采购制度.docx");
    // 影响范围只来自 applies / blockedArtifacts，不凭空造条目。
    const impact = Array.from(container.querySelectorAll(".ctx-impact-row") as any[])
      .map((node: any) => node.textContent);
    expect(impact.some((row: string) => row.includes("采购订单"))).toBe(true);
    expect(impact.some((row: string) => row.includes("流程图.svg"))).toBe(true);
    expect(Array.from(container.querySelectorAll(".ctx-option") as any[]).map((node: any) => node.textContent))
      .toEqual(["含税", "不含税"]);

    // 点影响范围里的模型项 → 跳到模型页并选中它，而不是让 FDE 自己去搜。
    const modelRow = Array.from(container.querySelectorAll(".ctx-impact-row") as any[])
      .find((node: any) => node.textContent.includes("采购订单")) as HTMLButtonElement;
    fireEvent.click(modelRow);
    await waitFor(() => expect(container.querySelector('.ctx-nav-item[aria-selected="true"]')?.textContent).toBe("模型"));
    expect(container.querySelector(".ctx-model-item.on")?.textContent).toContain("采购订单");
  });

  it("记录决定成功后把结论和影响范围自动发进聊天", async () => {
    let answered = false;
    const serverQuestion = () => ({
      id: "q-018", text: "审批金额是否含税？", priority: "blocking", options: [], applies: ["PurchaseOrder"],
      blockedArtifacts: [], evidence: [], source: "open_question",
      ...(answered ? { status: "answered", answer: "不含税", revision: 2 } : { status: "open", revision: 1 }),
    });
    g.fetch = async (url: string, init?: any) => {
      if (String(url).endsWith("/questions/q-018/answer") && init?.method === "POST") {
        answered = true;
        return response({});
      }
      if (String(url).endsWith("/questions")) return response({ questions: [serverQuestion()], summary: {}, nextBatch: [] });
      return response({});
    };
    G.Q_BACKLOG = [serverQuestion()];
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const answer = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    fireEvent.change(answer, { target: { value: "以不含税金额为准" } });
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((node: any) => node.textContent === "记录决定") as HTMLButtonElement);
    await waitFor(() => expect(SENT).toHaveLength(1));
    expect(SENT[0]).toContain("Q-018");
    expect(SENT[0]).toContain("以不含税金额为准");
    expect(SENT[0]).toContain("采购订单");
    expect(contextSyncStore.getSnapshot().receipts.at(-1)?.type).toBe("review.answer");
  });

  it("审阅优先展示 FDE 决策域，并把逐对象 schema lint 收成可展开批次", async () => {
    const lint = Array.from({ length: 175 }, (_, index) => ({
      id: `q-pk-${index}`,
      text: `Object${index}: 未声明主键`,
      status: "open",
      priority: "blocking",
      options: [],
      applies: [],
      blockedArtifacts: [],
      source: "conflict",
      raw: { sourceKind: "conflict", sourceRef: `cf_missing_required_${index}` },
    }));
    const business = {
      id: "q-event",
      text: "订单审批后由哪个 Action 发布事件，哪些系统消费？",
      status: "open",
      priority: "normal",
      options: [],
      applies: ["PurchaseOrder"],
      blockedArtifacts: [],
      source: "open_question",
    };
    G.Q_BACKLOG = [business, ...lint];
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    const review = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement;
    fireEvent.click(review);

    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());
    expect(container.textContent).toContain("Event 发布与消费");
    expect(container.querySelectorAll(".ctx-review-item")).toHaveLength(1);
    // 期望答案是回答框的 placeholder，不再占一整块正文 —— 进详情看。
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector("textarea.ctx-review-answer")).not.toBeNull());
    expect(container.querySelector("textarea.ctx-review-answer")?.getAttribute("placeholder"))
      .toContain("producer Action");
    fireEvent.click(container.querySelector(".ctx-review-back") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-review-list")).not.toBeNull());

    const diagnostic = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((node: any) => node.textContent.includes("批量")) as HTMLButtonElement;
    fireEvent.click(diagnostic);
    expect(container.textContent).toContain("175 个 DataObject 缺少主键定义");
    expect(container.querySelectorAll(".ctx-review-item")).toHaveLength(1);
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelectorAll(".ctx-review-batch-member")).toHaveLength(175));
    expect(container.textContent).toContain("批次仅用于聚合与排序");
    fireEvent.click(container.querySelector(".ctx-review-batch-member") as HTMLButtonElement);
    expect(container.querySelector("textarea.ctx-review-answer")).not.toBeNull();
    expect(container.textContent).toContain("返回批次");
  });

  it("已处理筛选只包含 answered/cancelled，不把 deferred 当作完成", async () => {
    G.Q_BACKLOG = [
      { id: "q-answered", text: "已确认问题", status: "answered", priority: "normal", options: [], applies: [], blockedArtifacts: [] },
      { id: "q-cancelled", text: "已取消问题", status: "cancelled", priority: "normal", options: [], applies: [], blockedArtifacts: [] },
      { id: "q-deferred", text: "延期等待业务确认", status: "deferred", priority: "normal", options: [], applies: [], blockedArtifacts: [] },
    ];
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement);
    const resolved = await waitFor(() => Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((node: any) => node.textContent.includes("已处理")) as HTMLButtonElement);
    fireEvent.click(resolved);
    expect(container.textContent).toContain("已确认问题");
    expect(container.textContent).toContain("已取消问题");
    expect(container.textContent).not.toContain("延期等待业务确认");
  });

  it("PreviewBody 在新 section 下装配的是 ContextSidebar，而不是旧七页签", () => {
    G.TAB = "model";
    const { container } = render(<PreviewBody />);
    expect(container.querySelector(".ctx-sidebar")).not.toBeNull();
    expect(container.querySelector(".ctx-nav")).not.toBeNull();
    expect(container.querySelector(".tabs")).toBeNull();
  });

  it("交付产物进入统一 viewer，并通过安全 preview API 内嵌 SVG", async () => {
    const requested: string[] = [];
    g.fetch = async (url: string) => {
      requested.push(String(url));
      if (String(url).includes("/preview?source=artifact")) return response({
        schemaVersion: "ontocopilot.preview/1",
        previewKind: "image",
        inlineUrl: "/api/sessions/s-context/preview/content?source=artifact&name=%E6%B5%81%E7%A8%8B%E5%9B%BE.svg",
        downloadUrl: "/api/sessions/s-context/artifacts/%E6%B5%81%E7%A8%8B%E5%9B%BE.svg",
        sourceUrl: "",
        notice: "",
        data: null,
      });
      return response({ questions: G.Q_BACKLOG, summary: {}, nextBatch: [], revision: 1 });
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const delivery = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "交付") as HTMLButtonElement;
    fireEvent.click(delivery);
    // 交付页现在按文档分组：一份文档一行，格式（SVG/XLSX/JSON…）是并排的入口。
    // 这条用例钉的是「点产物进统一 viewer 并走安全 preview API」，入口换了、能力没换。
    const flowDoc = Array.from(container.querySelectorAll(".ctx-delivery-doc") as any[])
      .find((node: any) => node.textContent.includes("流程图")) as HTMLElement;
    const svgEntry = Array.from(flowDoc.querySelectorAll(".ctx-format") as any[])
      .find((b: any) => b.textContent === "SVG") as HTMLButtonElement;
    fireEvent.click(svgEntry);
    await waitFor(() => expect(container.querySelector(".ctx-viewer-image")).not.toBeNull());
    expect(requested.some((url) => url.includes("/preview?source=artifact") && url.includes("name=%E6%B5%81%E7%A8%8B%E5%9B%BE.svg"))).toBe(true);
    expect(container.querySelector(".ctx-viewer-title")?.textContent).toBe("流程图.svg");
    expect(container.querySelector(".ctx-viewer-image")?.getAttribute("src")).toContain("/preview/content?");
    expect(container.querySelector(".ctx-viewer-image")?.getAttribute("src")).not.toContain("/artifacts/");
    expect(contextSyncStore.getSnapshot().receipts).toHaveLength(0);
    expect(contextSyncStore.getSnapshot().activeReference?.section).toBe("delivery");
  });

  it("交付页每份文档有「迭代」入口：预填按类型措辞的话进输入框（P3）", async () => {
    g.fetch = async () => response({ questions: [], summary: {}, nextBatch: [], revision: 1 });
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const delivery = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "交付") as HTMLButtonElement;
    fireEvent.click(delivery);
    const flowDoc = Array.from(container.querySelectorAll(".ctx-delivery-doc") as any[])
      .find((node: any) => node.textContent.includes("流程图")) as HTMLElement;
    const iterate = Array.from(flowDoc.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent.includes("迭代")) as HTMLButtonElement;
    expect(iterate).toBeTruthy();
    const existing = document.getElementById("cin") as HTMLTextAreaElement | null;
    const input = existing ?? (() => {
      const el = document.createElement("textarea");
      el.id = "cin";
      document.body.appendChild(el);
      return el;
    })();
    input.value = "";
    fireEvent.click(iterate);
    // 流程类文档 → 流程措辞；改完模型重导，产物跟着版本走
    expect(input.value).toContain("流程图");
    expect(input.value).toContain("调整");
    if (existing === null) input.remove(); else input.value = "";
  });

  it("live graph 显示 Workflow、Action、Event；节点选择只 focus，不发布写入回执", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1",
      previewKind: "graph",
      inlineUrl: "",
      downloadUrl: "",
      sourceUrl: "",
      notice: "",
      data: {
        workflows: [{ id: "procure", title: "采购审批", entry: "action:approve", evidenceIds: [], questionIds: [] }],
        nodes: [],
        edges: [{ id: "edge:approve-event", source: "action:approve", target: "event:approved", type: "flow", grounded: true }],
        ontologyActions: [{
          id: "action:approve", type: "action", label: "批准采购订单", apiName: "ApprovePurchaseOrder",
          grounded: true, evidenceIds: [], questionIds: [], relatedIds: ["event:approved"],
        }],
        events: [{
          id: "event:approved", type: "event", label: "采购订单已批准", apiName: "PurchaseOrderApproved",
          grounded: true, evidenceIds: [], questionIds: [], relatedIds: [],
        }],
        evidence: [],
      },
    });
    const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(3));
    expect(container.textContent).toContain("采购审批");
    expect(container.textContent).toContain("批准采购订单");
    expect(container.textContent).toContain("采购订单已批准");
    expect(container.textContent).toContain("缩小适配放大100%");
    const action = Array.from(container.querySelectorAll(".ctx-graph-node") as any[])
      .find((node: any) => node.textContent.includes("批准采购订单")) as HTMLButtonElement;
    fireEvent.click(action);
    expect(contextSyncStore.getSnapshot().activeReference?.refs.canvasNodeIds).toContain("action:approve");
    expect(contextSyncStore.getSnapshot().receipts).toHaveLength(0);
    expect(container.querySelector(".ctx-graph-inspector")?.textContent).toContain("批准采购订单");
  });

  it("正式工作流可在上到下/左到右之间重排，并按会话记住本地视图偏好", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "",
      sourceUrl: "", notice: "", data: {
        workflows: [], ontologyActions: [], events: [], evidence: [],
        nodes: [
          { id: "flow:apply", type: "action", label: "提交申请", grounded: true },
          { id: "flow:approve", type: "action", label: "主管审批", grounded: true },
          { id: "flow:done", type: "event", label: "审批完成", grounded: true },
        ],
        edges: [
          { id: "e1", source: "flow:apply", target: "flow:approve", grounded: true },
          { id: "e2", source: "flow:approve", target: "flow:done", grounded: true },
        ],
      },
    });
    const mounted = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(mounted.container.querySelectorAll(".ctx-graph-node")).toHaveLength(3));
    expect(mounted.container.querySelector(".ctx-graph")?.getAttribute("data-layout-direction")).toBe("LR");

    const buttons = Array.from(mounted.container.querySelectorAll(".ctx-graph-direction button")) as HTMLButtonElement[];
    expect(buttons.map((button) => button.textContent)).toEqual(["上到下", "左到右"]);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(buttons[0]!);

    await waitFor(() => expect(mounted.container.querySelector(".ctx-graph")
      ?.getAttribute("data-layout-direction")).toBe("TB"));
    const vertical = Array.from(mounted.container.querySelectorAll(".ctx-graph-node")) as HTMLElement[];
    expect(vertical.map((node) => Number.parseFloat(node.style.top)))
      .toEqual([...vertical].map((node) => Number.parseFloat(node.style.top)).sort((a, b) => a - b));
    expect(localStorage.getItem("oc_graph_layout:s-context")).toBe("TB");
    expect((G.S as any).state.flow.layoutDirection).toBeUndefined();

    mounted.unmount();
    const reopened = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(reopened.container.querySelectorAll(".ctx-graph-node")).toHaveLength(3));
    expect(reopened.container.querySelector(".ctx-graph")?.getAttribute("data-layout-direction")).toBe("TB");
  });

  it("已有 FlowGraph 时不把尚未映射的 Ontology 候选项塞进工作流画布", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1",
      previewKind: "graph",
      inlineUrl: "",
      downloadUrl: "",
      sourceUrl: "",
      notice: "",
      data: {
        workflows: [{ id: "procure", title: "采购审批", entry: "flow:approve", evidenceIds: [], questionIds: [] }],
        nodes: [
          { id: "flow:approve", type: "action", label: "批准采购订单", code: "ApprovePurchaseOrder", grounded: true },
          { id: "flow:approved", type: "event", label: "采购订单已批准", code: "PurchaseOrderApproved", grounded: true },
        ],
        edges: [{ id: "edge:approved", source: "flow:approve", target: "flow:approved", type: "flow", grounded: true }],
        ontologyActions: [{
          id: "action:unmapped", type: "action", label: "尚未映射动作", apiName: "UnmappedAction",
          grounded: false, evidenceIds: [], questionIds: [], relatedIds: [],
        }],
        events: [{
          id: "event:unmapped", type: "event", label: "尚未映射事件", apiName: "UnmappedEvent",
          grounded: false, evidenceIds: [], questionIds: [], relatedIds: [],
        }],
        evidence: [],
      },
    });
    const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(3));
    expect(container.textContent).toContain("采购审批");
    expect(container.textContent).toContain("批准采购订单");
    expect(container.textContent).toContain("采购订单已批准");
    expect(container.textContent).not.toContain("尚未映射动作");
    expect(container.textContent).not.toContain("尚未映射事件");
  });

  it("画布支持拖拽摆位、端口手动连线与全屏", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "", sourceUrl: "", notice: "",
      data: {
        workflows: [], edges: [], ontologyActions: [], evidence: [], events: [],
        nodes: [
          { id: "flow:approve", type: "action", label: "批准采购订单", code: "ApprovePurchaseOrder", grounded: true },
          { id: "flow:pay", type: "action", label: "发起付款", code: "StartPayment", grounded: true },
        ],
      },
    });
    const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(2));
    const [first, second] = Array.from(container.querySelectorAll(".ctx-graph-node")) as HTMLElement[];

    // 拖拽摆位：自动布局给的是起点，人工调整必须留得住。
    const startLeft = Number.parseFloat(first!.style.left);
    const startTop = Number.parseFloat(first!.style.top);
    fireEvent.pointerDown(first!, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(first!, { clientX: 190, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(first!, { clientX: 190, clientY: 160, pointerId: 1 });
    expect(Number.parseFloat(first!.style.left)).toBeCloseTo(startLeft + 90, 5);
    expect(Number.parseFloat(first!.style.top)).toBeCloseTo(startTop + 60, 5);

    // 端口连线只产生本地草案 + 一条回执；它不假装已经写进 Ontology。
    const port = first!.querySelector(".ctx-graph-port.out") as HTMLElement;
    fireEvent.pointerDown(port, { clientX: 200, clientY: 120, pointerId: 2 });
    fireEvent.pointerMove(container.querySelector(".ctx-graph-viewport") as HTMLElement, { clientX: 320, clientY: 120, pointerId: 2 });
    fireEvent.pointerUp(second!, { clientX: 400, clientY: 120, pointerId: 2 });
    expect(container.querySelectorAll(".ctx-graph-draft")).toHaveLength(1);
    expect(container.querySelector(".ctx-graph-draft")?.textContent).toContain("批准采购订单 → 发起付款");
    const receipt = contextSyncStore.getSnapshot().receipts.at(-1);
    expect(receipt?.type).toBe("model.confirm");
    expect(receipt?.summary).toContain("尚未写入 Ontology");
    expect(receipt?.refs.canvasNodeIds).toEqual(["flow:approve", "flow:pay"]);

    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((node: any) => node.textContent === "送去对话确认") as HTMLButtonElement);
    await waitFor(() => expect(SENT).toHaveLength(1));
    expect(SENT[0]).toContain("批准采购订单 → 发起付款");

    // 整理：把人工位移一次性清掉，回到自动布局。
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((node: any) => node.textContent === "整理") as HTMLButtonElement);
    expect(Number.parseFloat(first!.style.left)).toBeCloseTo(startLeft, 5);

    const fullscreen = container.querySelector(".ctx-graph-fullscreen") as HTMLButtonElement;
    fireEvent.click(fullscreen);
    expect(container.querySelector(".ctx-graph-full")).not.toBeNull();
    expect(fullscreen.textContent).toBe("退出全屏");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".ctx-graph-full")).toBeNull());
  });

  it("右栏不再有宽屏/紧凑开关，打开 viewer 后由 viewer 自己滚动", async () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(Array.from(container.querySelectorAll(".ctx-head-action") as any[]).map((node: any) => node.textContent))
      .toEqual(["收起"]);
    expect(container.querySelector(".ctx-sidebar")?.getAttribute("data-viewer")).toBe("");

    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "交付") as HTMLButtonElement);
    // 分组之后第一个入口是文档行上的格式芯片（见「交付页分组」那一组用例）
    fireEvent.click(container.querySelector(".ctx-format") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-viewer")).not.toBeNull());
    expect(container.querySelector(".ctx-sidebar")?.getAttribute("data-viewer")).toBe("1");

    // 内层卡片不能是「有 overflow:auto 却永远滚不动」的容器：那样滚轮会被
    // overscroll-behavior:contain 吞掉，鼠标必须移到最外层滚动条上才滚得动。
    const css = readFileSync(resolve(process.cwd(), "../ui/index.template.html"), "utf8");
    expect(css).toMatch(/\.ctx-sidebar\[data-viewer="1"\] \.ctx-body\{[^}]*overflow:hidden/u);
    expect(css).toMatch(/\n\.ctx-viewer-content\{(?:(?!overscroll-behavior:contain)[^}])*\}/u);
    expect(css).not.toMatch(/\.ctx-review-batch-members\{[^}]*overscroll-behavior:contain/u);
  });

  it("没有编排边时画布直说，而不是画一屏互不相连的格子", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "", sourceUrl: "", notice: "",
      data: {
        workflows: [], edges: [], ontologyActions: [], evidence: [],
        nodes: [
          { id: "act:submit", type: "action", label: "提交报销单", code: "ACT-1", grounded: false },
          { id: "evt:submitted", type: "event", label: "报销单已提交", code: "EVT-1", grounded: false },
        ],
        events: [],
      },
    });
    const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(2));
    const notice = container.querySelector(".ctx-graph-notice");
    expect(notice?.textContent).toContain("还没有任何编排关系");
    expect(notice?.textContent).toContain("端口");
  });

  it("孤立节点的列数跟着视口宽度走，窄栏不再缩成看不清的四列", async () => {
    const oldRaf = g.requestAnimationFrame;
    const oldObserver = g.ResizeObserver;
    let scheduled: (() => void) | null = null;
    g.requestAnimationFrame = (callback: () => void) => { scheduled = callback; return 1; };
    g.cancelAnimationFrame = () => {};
    g.ResizeObserver = undefined;
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "", sourceUrl: "", notice: "",
      data: {
        workflows: [], nodes: [], edges: [], ontologyActions: [], evidence: [],
        events: Array.from({ length: 7 }, (_, index) => ({
          id: `event:${index}`, type: "event", label: `Event ${index}`, apiName: `Event${index}`,
          grounded: true, evidenceIds: [], questionIds: [], relatedIds: [],
        })),
      },
    });
    try {
      const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
        onEvidence={() => {}} onReview={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(7));
      const viewport = container.querySelector(".ctx-graph-viewport") as HTMLDivElement;
      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 434 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 460 });
      await act(async () => { scheduled?.(); });
      await act(async () => { scheduled?.(); });
      const lefts = new Set(Array.from(container.querySelectorAll(".ctx-graph-node") as any[])
        .map((node: any) => node.style.left));
      // 434px 只放得下 2 列 214px 的节点；四列会把整张图压到读不出字的比例。
      expect(lefts.size).toBe(2);
      expect(Number.parseFloat(container.querySelector(".ctx-graph-zoom span")!.textContent!)).toBeGreaterThan(60);
    } finally {
      g.requestAnimationFrame = oldRaf;
      g.ResizeObserver = oldObserver;
    }
  });

  it("长工作流首次在侧栏保持可读比例，用户点适配时仍可查看全貌", async () => {
    const oldRaf = g.requestAnimationFrame;
    const oldObserver = g.ResizeObserver;
    let scheduled: (() => void) | null = null;
    g.requestAnimationFrame = (callback: () => void) => { scheduled = callback; return 1; };
    g.cancelAnimationFrame = () => {};
    g.ResizeObserver = undefined;
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `flow:${index}`, type: index === 9 ? "event" : "action", label: `步骤 ${index + 1}`,
      code: `STEP-${index + 1}`, grounded: true,
    }));
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "", sourceUrl: "", notice: "",
      data: {
        workflows: [], nodes, ontologyActions: [], events: [], evidence: [],
        edges: nodes.slice(0, -1).map((node, index) => ({
          id: `edge:${index}`, source: node.id, target: nodes[index + 1]!.id, type: "flow", grounded: true,
        })),
      },
    });
    // 显式选 LR：这条测的是 LR 的语义，不是"没选过时默认哪个方向"。
    localStorage.setItem("oc_graph_layout:s-context", "LR");
    try {
      const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
        onEvidence={() => {}} onReview={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(10));
      const viewport = container.querySelector(".ctx-graph-viewport") as HTMLDivElement;
      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 434 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 460 });
      await act(async () => { scheduled?.(); });

      // LR 必须是真正的左→右：即使 434px 侧栏只能容纳一两步，也不能把 10 层
      // 全折回成 x=44 的单列。首次展示保住 60% 可读比例并从入口开始；需要全貌
      // 时再由用户点「适配」。
      //
      // 这条测的是 **LR 的语义**，所以上面显式选了 LR（见 render 前的 localStorage
      // 种子）。「没选过时默认哪个方向」是另一件事，由 ui.canvas-layout 那边钉：
      // 窄高容器默认 TB —— 否则首次打开侧栏看到的是一条 50:1 的横带，
      // 用户的原话是「这个图像没有画出来」。
      const initial = Number.parseFloat(container.querySelector(".ctx-graph-zoom span")!.textContent!);
      expect(initial, "初始缩放不该低于可读下限").toBeGreaterThanOrEqual(60);
      const world = container.querySelector(".ctx-graph-world") as HTMLDivElement;
      const lefts = Array.from(container.querySelectorAll(".ctx-graph-node") as any[])
        .map((node: any) => Number.parseFloat(node.style.left));
      expect(new Set(lefts).size).toBe(10);
      expect(lefts.slice(0, 6)).toEqual([...lefts.slice(0, 6)].sort((a, b) => a - b));
      const [panX] = /translate\(([-\d.]+)px/u.exec(world.style.transform)?.slice(1) ?? [];
      const firstLeft = Number.parseFloat((container.querySelector(".ctx-graph-node") as HTMLElement).style.left);
      expect(Number(panX) + firstLeft * (initial / 100), "第一个节点不该被左边缘切掉")
        .toBeGreaterThanOrEqual(14);

      const fitButton = (Array.from(container.querySelectorAll(".ctx-graph-zoom button")) as HTMLButtonElement[])
        .find((button) => button.textContent === "适配") as HTMLButtonElement;
      fireEvent.click(fitButton);
      // 用户明确请求全貌时允许缩小；方向语义比强行把文字维持在 50% 更重要。
      expect(Number.parseFloat(container.querySelector(".ctx-graph-zoom span")!.textContent!))
        .toBeLessThan(30);
    } finally {
      g.requestAnimationFrame = oldRaf;
      g.ResizeObserver = oldObserver;
    }
  });

  it("表格 viewer 提供可聚焦的双向内部滚动区与 sticky 表头契约", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1",
      previewKind: "spreadsheet",
      inlineUrl: "",
      downloadUrl: "/artifact/orders.xlsx",
      sourceUrl: "",
      notice: "",
      data: {
        groups: [{ name: "Orders", rows: [
          { cite: "orders.xlsx!A2", text: "", cells: { orderId: "PO-1", supplier: "Acme" } },
          { cite: "orders.xlsx!A3", text: "", cells: { orderId: "PO-2", supplier: "Nova" } },
        ] }],
      },
    });
    const { container } = render(<ContextViewer target={target({
      id: "artifact:orders.xlsx", type: "artifact", title: "orders.xlsx", format: "table", extension: "xlsx",
    })} questions={[]} onBack={() => {}} onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelector(".ctx-viewer-table")).not.toBeNull());
    const scroll = container.querySelector(".ctx-viewer-table-wrap") as HTMLDivElement;
    expect(scroll.getAttribute("tabindex")).toBe("0");
    expect(scroll.getAttribute("aria-label")).toContain("横向和纵向滚动");
    expect(Array.from(container.querySelectorAll(".ctx-viewer-table th") as any[]).map((cell: any) => cell.textContent))
      .toEqual(["orderId", "supplier", "出处"]);

    const css = readFileSync(resolve(process.cwd(), "../ui/index.template.html"), "utf8");
    expect(css).toMatch(/\.ctx-viewer-table-wrap\{[^}]*overflow-x:auto;overflow-y:auto;/u);
    expect(css).toMatch(/\.ctx-viewer-table th\{[^}]*position:sticky;top:0;/u);
    expect(css).toMatch(/\.main\{[^}]*min-width:520px;/u);
    expect(css).toMatch(/\.preview\{[^}]*max-width:clamp\(320px,calc\(100vw - 750px\),900px\)/u);
    expect(css).toMatch(/\.mhead h2\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/u);
  });

  it("模型 taxonomy 包含 Event，主要导航与模型控件支持英文", () => {
    G.LANG = "en";
    G.S.state.oir.events = [{
      id: "evt:purchase-order-approved",
      name: { value: "Purchase order approved" },
      status: "candidate",
      producerAction: "ApprovePurchaseOrder",
      consumers: [],
      payload: { dataObject: "PurchaseOrder" },
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(Array.from(container.querySelectorAll(".ctx-nav-item") as any[]).map((node: any) => node.textContent))
      .toEqual(["Project", "Files", "Model", "Review", "Delivery", "Runtime"]);
    expect(container.querySelector(".ctx-sidebar-title")?.textContent).toBe("Project context");
    // 这个控件是**本页筛选**，不是全局搜索 —— 措辞要跟着改（见 SEARCH_HINT）
    expect(container.querySelector(".ctx-search input")?.getAttribute("placeholder")).toContain("Filter");
    const eventFilter = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((node: any) => node.textContent === "Event 1") as HTMLButtonElement;
    expect(eventFilter).not.toBeNull();
    fireEvent.click(eventFilter);
    expect(container.textContent).toContain("Purchase order approved");
    expect(container.textContent).toContain("Open in canvas");
  });

  it("header 不重复展示语言和 revision 控件，并跟随全局 i18n 刷新", () => {
    G.S = null;
    const { container } = render(<ContextSidebar />);
    expect(container.querySelector(".ctx-language")).toBeNull();
    expect(container.querySelector(".ctx-revision")).toBeNull();
    expect(container.textContent).not.toContain("模型 当前快照");
    act(() => setLang("en"));
    expect(G.LANG).toBe("en");
    expect(localStorage.getItem("oc_lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(container.querySelector(".ctx-sidebar-title")?.textContent).toBe("Project context");
    act(() => setLang("zh"));
    expect(G.LANG).toBe("zh");
    expect(localStorage.getItem("oc_lang")).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(container.querySelector(".ctx-sidebar-title")?.textContent).toBe("项目上下文");
  });

  it("孤立节点按有限列网格排布，并在首次展示时自动适配完整画布", async () => {
    const oldRaf = g.requestAnimationFrame;
    const oldCancel = g.cancelAnimationFrame;
    const oldObserver = g.ResizeObserver;
    let scheduled: (() => void) | null = null;
    g.requestAnimationFrame = (callback: () => void) => { scheduled = callback; return 1; };
    g.cancelAnimationFrame = () => {};
    g.ResizeObserver = undefined;
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "", sourceUrl: "", notice: "",
      data: {
        workflows: [], nodes: [], edges: [], ontologyActions: [], evidence: [],
        events: Array.from({ length: 10 }, (_, index) => ({
          id: `event:${index}`, type: "event", label: `Event ${index}`, apiName: `Event${index}`,
          grounded: true, evidenceIds: [], questionIds: [], relatedIds: [],
        })),
      },
    });
    try {
      const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
        onEvidence={() => {}} onReview={() => {}} />);
      await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(10));
      const viewport = container.querySelector(".ctx-graph-viewport") as HTMLDivElement;
      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 480 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 360 });
      await act(async () => { scheduled?.(); });
      const world = container.querySelector(".ctx-graph-world") as HTMLDivElement;
      const nodes = Array.from(container.querySelectorAll(".ctx-graph-node")) as HTMLElement[];
      const worldWidth = Number.parseFloat(world.style.width);
      const worldHeight = Number.parseFloat(world.style.height);
      expect(Math.max(...nodes.map((node) => Number.parseFloat(node.style.left)))).toBeLessThanOrEqual(686);
      expect(nodes.every((node) => Number.parseFloat(node.style.left) + 168 <= worldWidth)).toBe(true);
      expect(nodes.every((node) => Number.parseFloat(node.style.top) + 62 <= worldHeight)).toBe(true);
      expect(world.style.transform).toMatch(/scale\(0\.[0-9]+\)/u);
      expect(container.querySelector(".ctx-graph-zoom span")?.textContent).not.toBe("100%");
    } finally {
      g.requestAnimationFrame = oldRaf;
      g.cancelAnimationFrame = oldCancel;
      g.ResizeObserver = oldObserver;
    }
  });

  it("空 graph CTA 只把标准通用场景草案预填到聊天，不自动发送", async () => {
    let requests = 0;
    g.fetch = async () => {
      requests++;
      return response({
        schemaVersion: "ontocopilot.preview/1",
        previewKind: "graph",
        inlineUrl: "",
        downloadUrl: "",
        sourceUrl: "",
        notice: "当前 revision 还没有流程图结构",
        data: { workflows: [], nodes: [], edges: [], ontologyActions: [], events: [], evidence: [] },
      });
    };
    const { container } = render(<ContextViewer target={target()} questions={[]} onBack={() => {}}
      onEvidence={() => {}} onReview={() => {}} />);
    const cta = await waitFor(() => container.querySelector(".ctx-empty-action") as HTMLButtonElement);
    expect(cta).not.toBeNull();
    fireEvent.click(cta);
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    expect(composer.value).toContain("尚未描述场景");
    expect(composer.value).toContain("Ontology");
    expect(requests).toBe(1);
    expect(contextSyncStore.getSnapshot().receipts).toHaveLength(0);
  });

  it("正式 flow 为空时在右侧只读展示 sketch，并清楚标成通用参考而不是正式模型", async () => {
    const formalFlow = { workflows: [], stages: [], nodes: [], edges: [] };
    const existingArtifacts = ["已有数据字典.json"];
    (G.S as any).state.flow = formalFlow;
    (G.S as any).state.artifacts = existingArtifacts;
    (G.S as any).state.sketch = {
      domain: "采购审批",
      source_note: "通用参考 · 模型知识 · 非客户材料证据",
      graph: {
        stages: [{ key: "apply", title: "提出申请", order: 0 }],
        nodes: [
          { rid: "sketch:submit", kind: "action", label: "提交采购申请", code: "SubmitRequest", stage: "apply" },
          { rid: "sketch:approved", kind: "event", label: "采购申请已批准", code: "RequestApproved", stage: "apply" },
        ],
        edges: [{ rid: "sketch:edge", source: "sketch:submit", target: "sketch:approved", kind: "flow" }],
      },
    };
    g.fetch = async (url: string) => String(url).includes("/preview?")
      ? response({
        schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "",
        sourceUrl: "", notice: "当前 revision 还没有流程图结构",
        data: { workflows: [], nodes: [], edges: [], ontologyActions: [], events: [], evidence: [] },
      })
      : response({ questions: G.Q_BACKLOG, summary: {}, nextBatch: [], revision: 1 });

    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const processFilter = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((button: any) => button.textContent.includes("流程")) as HTMLButtonElement;
    // sketch 只负责预览，模型目录仍然如实报告正式流程为 0。
    expect(processFilter.textContent).toContain("0");

    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "工作流画布") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(2));

    const graph = container.querySelector('.ctx-graph[data-reference-preview="true"]');
    expect(graph).not.toBeNull();
    expect(graph?.textContent).toContain("通用参考");
    expect(graph?.textContent).toContain("未转正");
    expect(graph?.textContent).toContain("非客户证据");
    expect(graph?.textContent).toContain("只读参考草图");
    expect(graph?.textContent).toContain("提交采购申请");
    expect(graph?.textContent).toContain("采购申请已批准");
    expect(graph?.querySelectorAll(".ctx-graph-node.inferred")).toHaveLength(2);
    expect(graph?.querySelector(".ctx-graph-port.out")).toBeNull();

    // 通用参考草图和正式 Flow 共用同一套纯视图布局；切方向不会把草图转正。
    fireEvent.click((Array.from(graph?.querySelectorAll(".ctx-graph-direction button") || []) as HTMLButtonElement[])
      .find((button) => button.textContent === "上到下") as HTMLButtonElement);
    await waitFor(() => expect(graph?.getAttribute("data-layout-direction")).toBe("TB"));
    const sketchNodes = Array.from(graph?.querySelectorAll(".ctx-graph-node") || []) as HTMLElement[];
    expect(Number.parseFloat(sketchNodes[0]!.style.top)).toBeLessThan(Number.parseFloat(sketchNodes[1]!.style.top));
    expect((G.S as any).state.sketch.layoutDirection).toBeUndefined();

    fireEvent.click(graph?.querySelector(".ctx-sketch-adopt") as HTMLButtonElement);
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    expect(composer.value).toContain("draft.adopt");
    expect(composer.value).toContain("不要重新生成");
    expect(composer.value).toContain("generic_assumption");
    // 预览和 CTA 都不直接改状态；真正转正只能在用户发送后由工具完成。
    expect((G.S as any).state.flow).toBe(formalFlow);
    expect((G.S as any).state.artifacts).toBe(existingArtifacts);
    expect(contextSyncStore.getSnapshot().receipts).toHaveLength(0);
  });

  it("已有正式 flow 时正式画布优先，不让旧 sketch 覆盖或冒充当前流程", async () => {
    g.fetch = async () => response({
      schemaVersion: "ontocopilot.preview/1", previewKind: "graph", inlineUrl: "", downloadUrl: "",
      sourceUrl: "", notice: "", data: { workflows: [], nodes: [], edges: [], evidence: [] },
    });
    const { container } = render(<ContextViewer target={target({
      flow: {
        workflows: [], stages: [],
        nodes: [{ rid: "formal:approve", kind: "action", label: "正式审批", code: "Approve", grounded: true }],
        edges: [],
      },
      sketch: {
        domain: "过期参考",
        graph: {
          nodes: [{ rid: "sketch:old", kind: "action", label: "旧参考节点", code: "Old" }],
          edges: [], stages: [],
        },
      },
    })} questions={[]} onBack={() => {}} onEvidence={() => {}} onReview={() => {}} />);

    await waitFor(() => expect(container.querySelectorAll(".ctx-graph-node")).toHaveLength(1));
    expect(container.textContent).toContain("正式审批");
    expect(container.textContent).not.toContain("旧参考节点");
    expect(container.querySelector('[data-reference-preview="true"]')).toBeNull();
    expect(container.querySelector(".ctx-graph-port.out")).not.toBeNull();
  });

  it("项目没有材料时也提供通用场景草案入口", () => {
    G.S.filelist = [];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const project = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "项目") as HTMLButtonElement;
    fireEvent.click(project);
    const cta = container.querySelector(".ctx-empty-action") as HTMLButtonElement;
    expect(cta?.textContent).toBe("从通用场景生成草案");
    fireEvent.click(cta);
    expect((document.getElementById("cin") as HTMLTextAreaElement).value).toContain("尚未描述场景");
  });

  it("审阅写入失败不 publish，服务端投影成功变化后才发布回执", async () => {
    let failWrite = true;
    let serverQuestions = G.Q_BACKLOG.map((question: any) => ({ ...question }));
    g.fetch = async (url: string, init?: any) => {
      if (String(url).endsWith("/questions/q-cancel/answer") && init?.method === "POST") {
        if (failWrite) return failedResponse();
        serverQuestions = serverQuestions.map((question: any) => question.id === "q-cancel"
          ? { ...question, status: "answered", answer: "采用反向冲销并记录原因", revision: 2 }
          : question);
        return response({});
      }
      if (String(url).endsWith("/questions")) {
        return response({ questions: serverQuestions, summary: {}, nextBatch: [], revision: 2 });
      }
      return response({});
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const review = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "审阅") as HTMLButtonElement;
    fireEvent.click(review);
    await waitFor(() => expect(container.querySelector(".ctx-review-item")).not.toBeNull());
    fireEvent.click(container.querySelector(".ctx-review-item") as HTMLButtonElement);
    const answer = await waitFor(() => container.querySelector("textarea.ctx-review-answer") as HTMLTextAreaElement);
    fireEvent.change(answer, { target: { value: "采用反向冲销并记录原因" } });
    const submit = Array.from(container.querySelectorAll("button") as any[])
      .find((node: any) => node.textContent === "记录决定") as HTMLButtonElement;
    fireEvent.click(submit);
    await waitFor(() => expect(contextSyncStore.getSnapshot().receipts).toHaveLength(0));
    failWrite = false;
    fireEvent.click(submit);
    await waitFor(() => expect(contextSyncStore.getSnapshot().receipts.at(-1)?.type).toBe("review.answer"));
    expect(contextSyncStore.getSnapshot().receipts.at(-1)?.refs.questionIds).toContain("q-cancel");
  });
});

describe("模型页从流程边推关系 —— 画布上连着、右栏不许说未识别", () => {
  beforeEach(() => {
    G.S.state.oir.actions = [];
    G.S.state.flow = {
      workflows: [], stages: [{ key: "s1", title: "阶段一" }],
      nodes: [
        { rid: "fn_1", id: "fn_1", kind: "action", label: "提交报销单", code: "ACT-1", stage: "s1", actor: "员工", grounded: false },
        { rid: "fn_2", id: "fn_2", kind: "event", label: "报销单已提交", code: "EVT-1", stage: "s1", grounded: false },
        { rid: "fn_3", id: "fn_3", kind: "action", label: "审批报销单", code: "ACT-2", stage: "s1", actor: "主管", grounded: false },
      ],
      edges: [
        { from: "fn_1", to: "fn_2" },   // action → event：fn_1 是生产者
        { from: "fn_2", to: "fn_3" },   // event → action：fn_3 是消费者
      ],
    };
  });

  it("Event 的生产/消费从边上读出来，不再是「未识别」", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const eventFilter = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      // 中文界面上这个筛选叫「事件」——KIND_LABEL 的中文位原来留的是英文，
      // 于是同一排控件「对象/流程/规则」是中文、后两个突然变英文。
      .find((node: any) => node.textContent.includes("事件")) as HTMLButtonElement;
    fireEvent.click(eventFilter);
    expect(container.textContent).toContain("报销单已提交");
    // 生产 Action 是画布上那条边的源头
    expect(container.textContent).toContain("提交报销单");
    expect(container.textContent).not.toContain("未识别");
    // 消费 Actions 计数 = 1（审批报销单）
    expect(container.textContent).toContain("审批报销单");
  });

  it("oir.actions 为空时 Action 计数从流程节点兜底 —— 画布上站着七个、右栏写 0 是在撒谎", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const actionFilter = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((node: any) => node.textContent.includes("动作")) as HTMLButtonElement;
    expect(actionFilter.textContent).toContain("2"); // 两个 action 节点
    fireEvent.click(actionFilter);
    expect(container.textContent).toContain("提交报销单");
    expect(container.textContent).toContain("员工");       // actor 进详情
    expect(container.textContent).toContain("产生事件");   // emits 关系
  });
});

describe("属性表（S1）", () => {
  const prop = (api: string, name: string, extra: Record<string, unknown> = {}) => ({
    parent: "PurchaseOrder",
    apiName: { value: api, origin: "inferred" },
    displayName: { value: name, origin: "inferred" },
    baseType: { value: "STRING", origin: "inferred" },
    definition: { value: "", origin: "inferred" },
    required: { value: false, origin: "inferred" },
    valueDomain: { value: null, origin: "inferred" },
    ...extra,
  });

  const seed = (properties: any[]): void => {
    (G.S as any).state.oir.properties = properties;
  };

  it("列出属性名、类型和**口径** —— 口径是 FDE 拿去跟客户对账的东西", () => {
    seed([
      prop("orderNo", "订单编号", {
        definition: { value: "唯一标识采购订单的单号", origin: "inferred" },
        required: { value: true, origin: "inferred" },
      }),
      prop("amount", "金额", {
        baseType: { value: "DECIMAL", origin: "extracted" },
        apiName: { value: "amount", origin: "extracted" },
        definition: { value: "不含税", origin: "extracted" },
      }),
    ]);
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const table = container.querySelector(".ctx-attrs") as HTMLElement;
    expect(table).not.toBeNull();
    expect(table.textContent).toContain("订单编号");
    expect(table.textContent).toContain("DECIMAL");
    expect(table.textContent).toContain("唯一标识采购订单的单号");
    expect(table.textContent).toContain("不含税");
    expect(table.textContent).toContain("必填");
  });

  it("**origin 徽标要分得出通识和材料** —— 实测真实库 100% 是 inferred，界面上却只显示 candidate", () => {
    seed([
      prop("orderNo", "订单编号"),
      prop("amount", "金额", { apiName: { value: "amount", origin: "extracted" } }),
    ]);
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const rows = Array.from(container.querySelectorAll(".ctx-attr") as any[]);
    expect(rows[0]!.textContent).toContain("通识");
    expect(rows[1]!.textContent).toContain("材料");
  });

  it("ENUM 的取值域并进口径里 —— 取值表比一句描述有用", () => {
    seed([prop("status", "状态", {
      baseType: { value: "ENUM", origin: "inferred" },
      valueDomain: { value: ["草稿", "待审", "已批准"], origin: "inferred" },
    })]);
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.querySelector(".ctx-attrs")?.textContent).toContain("取值：草稿、待审、已批准");
  });

  it("超过 6 条先折叠，点开看全部 —— 侧栏是用来扫的", () => {
    seed(Array.from({ length: 9 }, (_v, i) => prop(`f${i}`, `字段${i}`)));
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.querySelectorAll(".ctx-attr")).toHaveLength(6);
    const more = Array.from(container.querySelectorAll(".ctx-inline-action") as any[])
      .find((b: any) => b.textContent.includes("还有 3 条")) as HTMLButtonElement;
    expect(more).toBeDefined();
    fireEvent.click(more);
    expect(container.querySelectorAll(".ctx-attr")).toHaveLength(9);
  });

  it("**零属性的空态要说下一步怎么办**，不是只说「暂无」—— 零属性才是这个产品最常见的状态", () => {
    seed([]);
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.querySelector(".ctx-attrs")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("还没有识别出属性");
    expect(text).toContain("上传含字段表的材料");
  });

  it("只有对象有属性表；流程/规则/Action 不长这一节", () => {
    seed([prop("orderNo", "订单编号")]);
    (G.S as any).state.oir.rules = [{
      rid: "br_x", statement: { value: "金额超 5 万要总经理批" },
      ruleKind: { value: "AUTHORITY" }, appliesTo: [], status: "candidate",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const rule = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("金额超 5 万"));
    if (rule) {
      fireEvent.click(rule);
      expect(container.querySelector(".ctx-attrs")).toBeNull();
    }
  });
});

describe("缺口小标（S2）", () => {
  it("对象缺主键/属性/关系/流程都点名，不是只给四个裸数字", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[])
      .map((n: any) => n.textContent);
    // 固件里的采购订单有 1 个属性、1 条关系，没有主键、没接流程
    expect(chips).toContain("无主键");
    expect(chips).toContain("未接入流程");
    expect(chips).not.toContain("无属性");
    expect(chips).not.toContain("无关系");
  });

  it("**点一下就把补齐指令填进输入框** —— 报缺不给下一步等于把活推回给人", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const pk = Array.from(container.querySelectorAll(".ctx-gap") as any[])
      .find((n: any) => n.textContent === "无主键") as HTMLButtonElement;
    fireEvent.click(pk);
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    expect(composer.value).toContain("采购订单");
    expect(composer.value).toContain("主键");
    expect(composer.value).toContain("唯一标识");
  });

  it("补齐指令要点名要口径 —— 只说「补属性」模型会敷衍两条", () => {
    (G.S as any).state.oir.properties = [];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const noAttr = Array.from(container.querySelectorAll(".ctx-gap") as any[])
      .find((n: any) => n.textContent === "无属性") as HTMLButtonElement;
    fireEvent.click(noAttr);
    const value = (document.getElementById("cin") as HTMLTextAreaElement).value;
    expect(value).toContain("口径");
    expect(value).toContain("含不含税");
  });

  it("Action 缺入参/未绑定对象也报 —— 实测 121 个 Action 里 119 个没有入参", () => {
    (G.S as any).state.oir.actions = [{
      rid: "at_submit", apiName: { value: "SubmitRequisition" },
      appliesTo: [], parameters: { value: [] }, effects: { value: ["提交"] },
      status: "candidate",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const action = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("SubmitRequisition"));
    expect(action).toBeDefined();
    fireEvent.click(action as HTMLElement);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[])
      .map((n: any) => n.textContent);
    expect(chips).toContain("缺入参");
    expect(chips).toContain("未绑定对象");
  });

  it("什么都不缺就一个小标都不出 —— 精简的前提是没话时闭嘴", () => {
    (G.S as any).state.oir.objects[0].primaryKey = { value: ["orderNo"] };
    (G.S as any).state.oir.links = [{ from: "PurchaseOrder", to: "Supplier", cardinality: "多对一" }];
    (G.S as any).state.flow = {
      workflows: [], stages: [], edges: [],
      nodes: [{ rid: "fn_1", kind: "action", label: { value: "下单" }, objects: ["PurchaseOrder"] }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    // 列表现在按缺口数排序，第一项不再必然是对象 —— 显式点开要看的那个
    const target = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("采购订单")) as HTMLButtonElement;
    fireEvent.click(target);
    expect(container.querySelectorAll(".ctx-detail .ctx-gap")).toHaveLength(0);
  });
});

describe("计数口径", () => {
  /** 真实库 bafd0dd05e69 的形状：workflows 容器空、stats.workflows=0、5 个阶段。 */
  const realShape = {
    workflows: [],
    stages: [{ key: "s1", title: "阶段一" }, { key: "s2", title: "阶段二" },
      { key: "s3", title: "阶段三" }, { key: "s4", title: "阶段四" }, { key: "s5", title: "阶段五" }],
    nodes: [], edges: [],
    stats: { stages: 5, workflows: 0, actions: 6, events: 6 },
  };

  it("**项目页和模型页的「流程」必须是同一个数** —— 实测这里曾经一个 0 一个 5", () => {
    (G.S as any).state.flow = realShape;
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);

    // 模型页的筛选条
    const chip = Array.from(container.querySelectorAll(".ctx-chip, .ctx-filter, button") as any[])
      .map((n: any) => n.textContent)
      .find((t: string) => /^流程\s*\d+$/u.test(t ?? ""));
    expect(chip).toBeDefined();
    const modelCount = Number(/\d+/u.exec(chip!)![0]);

    // 切到项目页
    const project = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((n: any) => n.textContent === "项目") as HTMLButtonElement;
    fireEvent.click(project);
    const stat = Array.from(container.querySelectorAll(".ctx-stat") as any[])
      .find((n: any) => n.textContent.includes("流程"));
    expect(stat).toBeDefined();
    const projectCount = Number(/\d+/u.exec(stat!.textContent)![0]);

    expect(projectCount).toBe(modelCount);
    // 而且要是 5（stages），不是 stats.workflows 那个 0
    expect(projectCount).toBe(5);
  });

  it("真有 workflows 时以 workflows 为准，不再退回 stages", () => {
    (G.S as any).state.flow = {
      ...realShape,
      workflows: [{ key: "w1", title: "采购主流程" }, { key: "w2", title: "退货流程" }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const project = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((n: any) => n.textContent === "项目") as HTMLButtonElement;
    fireEvent.click(project);
    const stat = Array.from(container.querySelectorAll(".ctx-stat") as any[])
      .find((n: any) => n.textContent.includes("流程"));
    expect(Number(/\d+/u.exec(stat!.textContent)![0])).toBe(2);
  });
});

describe("bind_objects 的用户可见回路", () => {
  it("**绑上对象后「流程节点」要从 0 变成 1** —— 这才是「流程节点 0」这个症状的终点", () => {
    const node = (objects: string[]) => ({
      rid: "fn_1", kind: "action", code: "ACT-1",
      label: { value: "下采购单" }, stage: "s1", objects,
    });
    const flowOf = (objects: string[]) => ({
      workflows: [], stages: [{ key: "s1", title: "阶段一" }], nodes: [node(objects)], edges: [],
    });

    const factOf = (c: Element): string => {
      const hit = Array.from(c.querySelectorAll(".ctx-fact") as any[])
        .find((n: any) => n.textContent.includes("流程节点"));
      return hit ? hit.textContent : "";
    };
    const chipsOf = (c: Element): string[] =>
      Array.from(c.querySelectorAll(".ctx-gap") as any[]).map((n: any) => n.textContent);

    // 绑之前：没有「流程节点」这个数字（0 让位给芯片 —— 同一件事不说两遍），芯片在
    (G.S as any).state.flow = flowOf([]);
    const before = render(<ContextSidebar context={{ revision: 12 }} />).container;
    expect(factOf(before)).toBe("");
    expect(chipsOf(before)).toContain("未接入流程");
    cleanup();

    // 绑之后（bind_objects 落的是 rid）：芯片消失，数字出现且是 1
    (G.S as any).state.flow = flowOf(["object:purchase-order"]);
    const after = render(<ContextSidebar context={{ revision: 12 }} />).container;
    expect(chipsOf(after)).not.toContain("未接入流程");
    expect(factOf(after)).toContain("1");
  });
});

describe("状态徽标的措辞", () => {
  it("**不许把英文枚举原样打在中文界面上** —— 实测真实库 775 条实体 100% 是 candidate", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    // 固件里的对象 status 是「已确认」（中文原样回显），换成真实库的形状再看
    (G.S as any).state.oir.objects[0].status = "candidate";
    cleanup();
    const c2 = render(<ContextSidebar context={{ revision: 12 }} />).container;
    expect(c2.textContent).toContain("待确认");
    expect(c2.textContent).not.toContain("candidate");
    expect(container).toBeDefined();
  });

  it("认不出的枚举值原样回显 —— 猜一个中文名会把新枚举藏起来", () => {
    (G.S as any).state.oir.objects[0].status = "quarantined";
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.textContent).toContain("quarantined");
  });

  it("confirmed 也要翻，不是只翻 candidate", () => {
    (G.S as any).state.oir.objects[0].status = "confirmed";
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.textContent).toContain("已确认");
    expect(container.textContent).not.toContain("confirmed");
  });
});

describe("发布状态口径", () => {
  it("**项目页和交付页不能同一秒一个 DRAFT 一个 RELEASED**", () => {
    // 没有阻塞问题、没有开放问题，但会话还没跑完 —— 正是两套公式分叉的那一刻
    (G as any).Q_BACKLOG = [];
    (G.S as any).status = "running";
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);

    // 两个面板画法不同：项目页是 .ctx-badge，交付页是 hero 的 .ctx-detail-title。
    // 所以按**文本**找，不按类名找 —— 要钉的是"用户读到的那个词"。
    const badgeOn = (tab: string): string => {
      const nav = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
        .find((n: any) => n.textContent === tab) as HTMLButtonElement;
      fireEvent.click(nav);
      const hit = Array.from(container.querySelectorAll("span, div") as any[])
        .map((n: any) => (n.textContent ?? "").trim())
        .find((t: string) => ["BLOCKED", "DRAFT", "RELEASED"].includes(t));
      return hit ?? "";
    };
    const project = badgeOn("项目");
    const delivery = badgeOn("交付");
    expect(project).toBe(delivery);
    // 取严：会话没跑完就不许说 RELEASED
    expect(project).toBe("DRAFT");
  });

  it("会话跑完且无开放问题 → 两边一起变 RELEASED", () => {
    (G as any).Q_BACKLOG = [];
    (G.S as any).status = "done";
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    const project = Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((n: any) => n.textContent === "项目") as HTMLButtonElement;
    fireEvent.click(project);
    const badge = Array.from(container.querySelectorAll("span, div") as any[])
      .map((n: any) => (n.textContent ?? "").trim())
      .find((t: string) => ["BLOCKED", "DRAFT", "RELEASED"].includes(t));
    expect(badge).toBe("RELEASED");
  });
});

describe("信任信号（状态徽标）", () => {
  const withStatus = (st: string) => {
    (G.S as any).state.oir.objects[0].status = st;
    return render(<ContextSidebar context={{ revision: 12 }} />).container;
  };
  const badge = (c: Element): HTMLElement =>
    Array.from(c.querySelectorAll(".ctx-detail .ctx-badge") as any[])[0] as HTMLElement;

  it("**未知状态要 fail-closed** —— proposed 是聊天刚写进去的，最该复核，不能画成绿的已确认", () => {
    const b = badge(withStatus("proposed"));
    expect(b.className).toContain("warning");
    expect(b.className).not.toContain("confirmed");
  });

  it("rejected 单独一档 —— 它不是「要复核」，是「已经判了」，绿和黄都不对", () => {
    const b = badge(withStatus("rejected"));
    expect(b.className).toContain("rejected");
    expect(b.className).not.toContain("confirmed");
    expect(b.textContent).toBe("已否决");
  });

  it("只有明确确认过的才走绿", () => {
    const b = badge(withStatus("confirmed"));
    expect(b.className).toContain("confirmed");
    expect(b.className).not.toContain("warning");
  });

  it("candidate（真实库 775/775 就是它）走要复核", () => {
    const b = badge(withStatus("candidate"));
    expect(b.className).toContain("warning");
  });
});

describe("工作队列（R5）", () => {
  const seedMany = (): void => {
    const oir = (G.S as any).state.oir;
    // 三个对象：一个啥都不缺、一个缺两项、一个缺三项
    oir.objects = [
      { rid: "ot_full", apiName: { value: "Full" }, displayName: { value: "齐全对象" },
        description: { value: "d" }, primaryKey: { value: ["id"] }, status: "candidate" },
      { rid: "ot_two", apiName: { value: "TwoGaps" }, displayName: { value: "缺两项" },
        description: { value: "d" }, primaryKey: { value: ["id"] }, status: "candidate" },
      { rid: "ot_three", apiName: { value: "ThreeGaps" }, displayName: { value: "缺三项" },
        description: { value: "d" }, primaryKey: { value: [] }, status: "candidate" },
    ];
    oir.properties = [{ parent: "ot_full", apiName: { value: "id" }, displayName: { value: "编号" },
      baseType: { value: "STRING" }, definition: { value: "" }, required: { value: true },
      valueDomain: { value: null } }];
    oir.links = [{ from: "ot_full", to: "ot_two", cardinality: "ONE_TO_MANY" }];
    (G.S as any).state.flow = { workflows: [], stages: [{ key: "s1", title: "阶段一" }],
      nodes: [{ rid: "fn1", kind: "action", label: { value: "n" }, stage: "s1", objects: ["ot_full"] }],
      edges: [], stats: { terminals: 1, dead_ends: 0 } };
  };

  it("**列表行上挂缺口数** —— 「哪些对象缺主键」不该靠一条条点开看", () => {
    seedMany();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const rows = Array.from(container.querySelectorAll(".ctx-model-item") as any[]);
    const withCount = rows.filter((r: any) => r.querySelector(".ctx-item-gaps"));
    expect(withCount.length).toBeGreaterThan(0);
    // 齐全的那个不挂数字
    const full = rows.find((r: any) => r.textContent.includes("齐全对象"))!;
    expect(full.querySelector(".ctx-item-gaps")).toBeNull();
  });

  // 这条用例原来钉的是「缺口多的排前面」，理由写着「截断要截掉没问题的那些，
  // 不是随机的后 N 条」—— 它真正在乎的是**截断别把整类都切没**（202 个对象的
  // 会话里规则/Action/Event 一行都到不了）。而"缺得最多的排最前"这个手段有反效果：
  // 空壳恰好缺得最多，于是解析噪声霸占第一屏（线上实测）。
  // 现在换成：默认按建得实排，截断**按组算**，每一类都保证有露面机会。
  it("默认按「建得有多实」排，齐全的在最前", () => {
    seedMany();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const labels = Array.from(container.querySelectorAll(".ctx-model-item strong") as any[])
      .map((n: any) => n.textContent);
    expect(labels.indexOf("齐全对象")).toBeLessThan(labels.indexOf("缺两项"));
    expect(labels.indexOf("缺两项")).toBeLessThan(labels.indexOf("缺三项"));
  });

  it("截断按组算 —— 对象再多，规则/流程也有露面机会", () => {
    seedMany();
    const oir = (G.S as any).state.oir;
    // 200 个对象把列表塞满；规则只有 2 条，绝不能被挤没
    oir.objects = Array.from({ length: 200 }, (_, i) => ({
      rid: `ot_bulk_${i}`, apiName: { value: `Bulk${i}` }, displayName: { value: `批量对象${i}` },
      description: { value: "d" }, primaryKey: { value: [] }, status: "candidate",
    }));
    oir.rules = [
      { rid: "rule_a", name: { value: "规则甲" }, statement: { value: "金额大于一万需审批" }, appliesTo: [], status: "candidate" },
      { rid: "rule_b", name: { value: "规则乙" }, statement: { value: "跨月不许改" }, appliesTo: [], status: "candidate" },
    ];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const labels = Array.from(container.querySelectorAll(".ctx-model-item strong") as any[])
      .map((n: any) => n.textContent);
    // 规则行的标题取的是 statement（规则的内容才是它的身份）
    expect(labels).toContain("金额大于一万需审批");
    expect(labels).toContain("跨月不许改");
    // 对象那一组要如实说自己被截了多少
    const objectGroup = Array.from(container.querySelectorAll(".ctx-model-group") as any[])
      .find((g: any) => (g.querySelector(".ctx-model-group-head")?.textContent || "").includes("对象"))!;
    expect(objectGroup.querySelector(".ctx-list-cap")?.textContent).toMatch(/另有\s*\d+/u);
  });

  it("「待补全 N」筛选只留有缺口的", () => {
    seedMany();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const todo = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((b: any) => b.textContent.startsWith("待补全")) as HTMLButtonElement;
    expect(todo).toBeDefined();
    fireEvent.click(todo);
    const labels = Array.from(container.querySelectorAll(".ctx-model-item strong") as any[])
      .map((n: any) => n.textContent);
    expect(labels).not.toContain("齐全对象");
    expect(labels).toContain("缺三项");
  });

  it("全库同一个状态时那一列不占位 —— 一整列同一个词等于一列空白", () => {
    seedMany();
    const onlyObjects = (c: Element): void => {
      const chip = Array.from(c.querySelectorAll(".ctx-filter") as any[])
        .find((b: any) => b.textContent.startsWith("对象")) as HTMLButtonElement;
      fireEvent.click(chip);
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    onlyObjects(container);
    expect(container.querySelectorAll(".ctx-model-item .ctx-status")).toHaveLength(0);
    cleanup();
    // 有区分度时就要显示
    (G.S as any).state.oir.objects[0].status = "confirmed";
    const c2 = render(<ContextSidebar context={{ revision: 12 }} />).container;
    onlyObjects(c2);
    expect(c2.querySelectorAll(".ctx-model-item .ctx-status").length).toBeGreaterThan(0);
  });
});

describe("规则 / 流程 / 事件也进工作队列（R4）", () => {
  it("规则未绑对象要报，而「未分类」不报 —— ruleKind 不在 EDITABLE 里，报了也补不了", () => {
    (G.S as any).state.oir.rules = [{
      rid: "br_x", statement: { value: "金额超 5 万要总经理批" },
      ruleKind: { value: "AUTHORITY" }, appliesTo: [], actor: { value: "" }, status: "candidate",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const rule = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("金额超 5 万"))!;
    fireEvent.click(rule);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[]).map((n: any) => n.textContent);
    expect(chips).toContain("未绑对象");
    expect(chips).toContain("无执行角色");
    // 这两条以前**故意不报**（OIR 没有条件字段、ruleKind 不在 EDITABLE 里）。
    // 现在两条路都通了，才放出来 —— 先有能力，再有提示。
    expect(chips).toContain("无可判定条件");
  });

  it("规则有了判定条件就不再报，并且条件要显示出来", () => {
    (G.S as any).state.oir.rules = [{
      rid: "br_y", statement: { value: "金额超 5 万要总经理批" },
      ruleKind: { value: "AUTHORITY" }, appliesTo: ["PurchaseOrder"],
      actor: { value: "总经理" }, condition: { value: "amount > 50000" }, status: "candidate",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const rule = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("金额超 5 万"))!;
    fireEvent.click(rule);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[]).map((n: any) => n.textContent);
    expect(chips).not.toContain("无可判定条件");
    expect(container.querySelector(".ctx-detail")?.textContent).toContain("amount > 50000");
  });

  it("未分类（OTHER）也报，补齐指令要把四个档说清楚", () => {
    (G.S as any).state.oir.rules = [{
      rid: "br_z", statement: { value: "报销要合规" }, ruleKind: { value: "OTHER" },
      appliesTo: ["PurchaseOrder"], actor: { value: "" }, condition: { value: "" }, status: "candidate",
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("报销要合规"))! as HTMLElement);
    const chip = Array.from(container.querySelectorAll(".ctx-gap") as any[])
      .find((n: any) => n.textContent === "未分类") as HTMLButtonElement;
    expect(chip).toBeDefined();
    fireEvent.click(chip);
    const v = (document.getElementById("cin") as HTMLTextAreaElement).value;
    expect(v).toContain("VALIDATION");
    expect(v).toContain("CALCULATION");
  });

  it("流程无终态 / 有死端要报，数字来自 flow.stats（后端早就算好了）", () => {
    (G.S as any).state.flow = {
      workflows: [], stages: [{ key: "s1", title: "阶段一" }],
      nodes: [{ rid: "fn1", kind: "action", label: { value: "下单" }, stage: "s1", objects: [] }],
      edges: [], stats: { terminals: 0, dead_ends: 2 },
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const proc = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("阶段一"))!;
    fireEvent.click(proc);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[]).map((n: any) => n.textContent);
    expect(chips).toContain("无终态");
    expect(chips).toContain("2 个死端");
    expect(chips).toContain("节点未绑对象");
  });

  it("事件无生产者 / 无下游 / 无载荷要报", () => {
    (G.S as any).state.flow = {
      workflows: [], stages: [], edges: [],
      nodes: [{ rid: "fn_e", kind: "event", label: { value: "采购申请已提交" }, objects: [] }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const evt = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("采购申请已提交"))!;
    fireEvent.click(evt);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[]).map((n: any) => n.textContent);
    expect(chips).toContain("无生产者");
    expect(chips).toContain("无下游");
    expect(chips).toContain("无载荷");
  });
});

describe("翻出处不丢位置（R2）", () => {
  it("**打开证据再返回，选中项和类型筛选都还在** —— 440px 下 viewer 会顶掉整个列表", () => {
    (G.S as any).state.oir.objects = [
      { rid: "ot_a", apiName: { value: "A" }, displayName: { value: "甲对象" },
        description: { value: "d" }, primaryKey: { value: ["id"] }, status: "candidate" },
      { rid: "ot_b", apiName: { value: "B" }, displayName: { value: "乙对象" },
        description: { value: "d" }, primaryKey: { value: ["id"] }, status: "candidate" },
    ];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);

    // 筛到「对象」、选中第二个
    const kindChip = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((b: any) => b.textContent.startsWith("对象")) as HTMLButtonElement;
    fireEvent.click(kindChip);
    const second = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("乙对象")) as HTMLButtonElement;
    fireEvent.click(second);
    expect(container.querySelector(".ctx-detail-title")?.textContent).toBe("乙对象");

    // 打开画布成为顶层 sibling resource。工作台只隐藏、不卸载，因此 ModelPanel
    // 和它的筛选/选中 state 都继续常驻。
    const openGraph = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "在画布中打开") as HTMLButtonElement;
    fireEvent.click(openGraph);
    expect(container.querySelector(".wb-workbench-page")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".ctx-model-list")).not.toBeNull();
    expect(container.querySelector(".wb-resource-page:not([hidden]) .ctx-graph")).not.toBeNull();

    // 返回
    const back = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => (b.textContent ?? "").includes("返回")) as HTMLButtonElement;
    expect(back).toBeDefined();
    fireEvent.click(back);

    // 选中项还是乙对象、筛选还停在「对象」
    expect(container.querySelector(".ctx-detail-title")?.textContent).toBe("乙对象");
    const on = Array.from(container.querySelectorAll(".ctx-filter.on") as any[])
      .map((b: any) => b.textContent);
    expect(on.some((t: string) => t.startsWith("对象"))).toBe(true);
  });
});

describe("空态说下一步（不是「暂无」）", () => {
  it("**整份模型为空 ≠ 筛选没匹配上** —— 上一版把「还没建模型」说成筛选问题", () => {
    (G.S as any).state.oir = { objects: [], properties: [], links: [], actions: [], rules: [], questions: [] };
    (G.S as any).state.flow = { workflows: [], stages: [], nodes: [], edges: [] };
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const text = container.textContent ?? "";
    expect(text).toContain("还没有模型");
    expect(text).not.toContain("这个筛选下没有");
    // 而且给了和画布同一颗 CTA
    const cta = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "从通用场景生成草案");
    expect(cta).toBeDefined();
  });

  it("模型非空但筛选没命中时，才说筛选", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const search = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "根本不存在的东西zzz" } });
    expect(container.textContent).toContain("这个筛选下没有");
  });

  it("**待确认排在证据前面** —— 证据 100% 为空，不该挡在今天要动的东西前面", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const titles = Array.from(container.querySelectorAll(".ctx-detail .ctx-section-title") as any[])
      .map((n: any) => n.textContent);
    const pending = titles.indexOf("待确认");
    const evidence = titles.indexOf("证据");
    expect(pending).toBeGreaterThanOrEqual(0);
    // 证据为空时整节不出现；出现的话也必须在待确认之后
    if (evidence >= 0) expect(pending).toBeLessThan(evidence);
  });

  it("证据为空时收成一行、并说清楚这意味着什么", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    expect(container.querySelector(".ctx-evidence-none")?.textContent)
      .toContain("这一项是推断出来的");
  });
});

describe("数字与芯片不重复（S2 兑现原意）", () => {
  it("**全是 0 的对象一个数字都不出** —— 四个缺口芯片已经把话说完了", () => {
    (G.S as any).state.oir.objects = [{
      rid: "ot_empty", apiName: { value: "Empty" }, displayName: { value: "空对象" },
      description: { value: "d" }, primaryKey: { value: [] }, status: "candidate",
    }];
    (G.S as any).state.oir.properties = [];
    (G.S as any).state.oir.links = [];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const target = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("空对象")) as HTMLButtonElement;
    fireEvent.click(target);
    expect(container.querySelectorAll(".ctx-detail .ctx-fact")).toHaveLength(0);
    expect(container.querySelectorAll(".ctx-detail .ctx-gap").length).toBeGreaterThan(0);
  });

  it("有值的维度才出数字，而且不和芯片说同一件事", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const target = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("采购订单")) as HTMLButtonElement;
    fireEvent.click(target);
    const facts = Array.from(container.querySelectorAll(".ctx-detail .ctx-fact") as any[])
      .map((n: any) => n.textContent);
    const chips = Array.from(container.querySelectorAll(".ctx-detail .ctx-gap") as any[])
      .map((n: any) => n.textContent);
    // 固件：1 个属性、1 条关系 → 这两个有数字；没有芯片跟它们重复
    expect(facts.some((t: string) => t.includes("属性"))).toBe(true);
    expect(chips).not.toContain("无属性");
    expect(chips).not.toContain("无关系");
  });
});

describe("属性行内修正（R1）", () => {
  it("**点属性行就把修正指令填好** —— 对象名、apiName、当前类型和口径都替他写上", () => {
    (G.S as any).state.oir.properties = [{
      parent: "PurchaseOrder",
      apiName: { value: "estimatedAmount", origin: "extracted" },
      displayName: { value: "预估金额", origin: "extracted" },
      baseType: { value: "DECIMAL", origin: "extracted" },
      definition: { value: "不含税，按申请时点汇率折人民币", origin: "extracted" },
      required: { value: true, origin: "extracted" },
      valueDomain: { value: null, origin: "extracted" },
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const row = container.querySelector(".ctx-attr") as any;
    // 是个真按钮 —— 键盘能到、屏幕阅读器认得，不是挂了 onClick 的 div
    expect(String(row.tagName)).toBe("BUTTON");
    fireEvent.click(row);
    const v = (document.getElementById("cin") as HTMLTextAreaElement).value;
    // 对象名 + apiName + 中文名 + 当前类型 + 当前口径 + 必填，一个都不能少 ——
    // 少一样 FDE 就得自己敲，敲错一个字模型就改到别的对象上
    expect(v).toContain("采购订单");
    expect(v).toContain("estimatedAmount");
    expect(v).toContain("预估金额");
    expect(v).toContain("DECIMAL");
    expect(v).toContain("不含税");
    expect(v).toContain("必填");
    // 结尾是冒号 —— 人只补结论
    expect(v.trimEnd().endsWith("：")).toBe(true);
  });

  it("没有口径的属性要说「没有口径」，不能空着让模型猜", () => {
    (G.S as any).state.oir.properties = [{
      parent: "PurchaseOrder", apiName: { value: "remark" }, displayName: { value: "备注" },
      baseType: { value: "STRING" }, definition: { value: "" },
      required: { value: false }, valueDomain: { value: null },
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(container.querySelector(".ctx-attr") as HTMLButtonElement);
    const v = (document.getElementById("cin") as HTMLTextAreaElement).value;
    expect(v).toContain("没有口径");
    expect(v).toContain("非必填");
  });

  it("apiName 和中文名相同时不重复写两遍", () => {
    (G.S as any).state.oir.properties = [{
      parent: "PurchaseOrder", apiName: { value: "status" }, displayName: { value: "status" },
      baseType: { value: "ENUM" }, definition: { value: "" },
      required: { value: true }, valueDomain: { value: null },
    }];
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(container.querySelector(".ctx-attr") as HTMLButtonElement);
    const v = (document.getElementById("cin") as HTMLTextAreaElement).value;
    expect(v).not.toContain("status（status）");
  });
});

describe("证据定位（R8）", () => {
  const CHUNKS = [
    { cite: "梳理表.xlsx!实体!R2-2", text: "第一段：无关的内容" },
    { cite: "梳理表.xlsx!实体!R7-3", text: "第二段：审批金额含税口径写在这里" },
    { cite: "梳理表.xlsx!实体!R9-1", text: "第三段：也是无关的内容" },
  ];

  it("**按 chunk 渲染并给每段打 data-cite** —— 没有锚点就谈不上定位", async () => {
    const scrolled: string[] = [];
    (globalThis as any).Element.prototype.scrollIntoView = function (this: any) {
      scrolled.push(this.getAttribute?.("data-cite") ?? "");
    };
    (G as any).SRC = { "梳理表.xlsx": { chunks: CHUNKS } };
    const { container } = render(<ContextViewer
      target={target({ type: "evidence", format: "document", cite: "梳理表.xlsx!实体!R7-3",
        fileName: "梳理表.xlsx", snippet: "审批金额含税口径写在这里" })}
      questions={[]} onBack={() => {}} onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelectorAll("[data-cite]").length).toBeGreaterThan(0));
    // 三段都有锚点
    expect(container.querySelectorAll("[data-cite]")).toHaveLength(3);
    // 命中的那一段被滚过去并高亮
    await waitFor(() => expect(container.querySelector(".ctx-cite-hit")).not.toBeNull());
    expect(container.querySelector(".ctx-cite-hit")?.textContent).toContain("审批金额含税");
    expect(scrolled).toContain("梳理表.xlsx!实体!R7-3");
  });

  it("纯文本类型也画 snippet 引言 —— 上一版只有 document 有，用户不知道自己撞上哪一支", async () => {
    (G as any).SRC = { "a.txt": { chunks: [{ cite: "a.txt!R1", text: "这是那一句" }] } };
    const { container } = render(<ContextViewer
      target={target({ type: "evidence", format: "text", cite: "a.txt!R1",
        fileName: "a.txt", snippet: "这是那一句" })}
      questions={[]} onBack={() => {}} onEvidence={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(container.querySelector(".ctx-viewer-snippet")).not.toBeNull());
    expect(container.querySelector(".ctx-viewer-snippet")?.textContent).toBe("这是那一句");
  });
});

describe("画布联动（R7）", () => {
  const seedGraph = (): void => {
    (G.S as any).state.oir.objects = [{
      rid: "ot_a", apiName: { value: "PurchaseOrder" }, displayName: { value: "采购订单" },
      description: { value: "d" }, primaryKey: { value: ["id"] }, status: "candidate",
    }];
    (G.S as any).state.oir.links = [];
    (G.S as any).state.flow = {
      workflows: [], stages: [{ key: "s1", title: "阶段一" }],
      nodes: [{ rid: "fn1", kind: "action", label: { value: "下单" }, stage: "s1", objects: [] }],
      edges: [], stats: { terminals: 1, dead_ends: 0 },
    };
  };

  it("**对象点「在画布中打开」要落在「对象关系」模式**，不是停在工作流", () => {
    seedGraph();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const obj = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("采购订单")) as HTMLButtonElement;
    fireEvent.click(obj);
    const open = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "在画布中打开") as HTMLButtonElement;
    fireEvent.click(open);
    const on = Array.from(container.querySelectorAll(".ctx-graph-modes button, .ctx-graph-toolbar button") as any[])
      .find((b: any) => b.className.includes("on"));
    expect(on?.textContent).toBe("对象关系");
  });

  it("**切模式不再无条件清空选中** —— 新模式下这个节点还在就留着", () => {
    seedGraph();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const obj = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("采购订单")) as HTMLButtonElement;
    fireEvent.click(obj);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "在画布中打开") as HTMLButtonElement);
    // 对象关系模式下这个对象是被选中的
    expect(container.querySelector(".ctx-graph-node.on")).not.toBeNull();
    // 切到工作流：那里没有这个对象节点，才该清空
    const wf = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "工作流") as HTMLButtonElement;
    fireEvent.click(wf);
    expect(container.querySelector(".ctx-graph-node.on")).toBeNull();
    // 切回来要恢复
    const objMode = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "对象关系") as HTMLButtonElement;
    fireEvent.click(objMode);
    expect(container.querySelector(".ctx-graph-node")).not.toBeNull();
  });

  it("流程项的 id 转成画布用的 workflow: 前缀 —— 前缀对不上就永远选不中", () => {
    seedGraph();
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const proc = Array.from(container.querySelectorAll(".ctx-model-item") as any[])
      .find((n: any) => n.textContent.includes("阶段一")) as HTMLButtonElement;
    fireEvent.click(proc);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "在画布中打开") as HTMLButtonElement);
    // 落在工作流模式（流程不是对象）
    const on = Array.from(container.querySelectorAll("button") as any[])
      .filter((b: any) => ["工作流", "对象关系"].includes(b.textContent))
      .find((b: any) => b.className.includes("on"));
    expect(on?.textContent).toBe("工作流");
  });
});

describe("输入框不许被冲掉", () => {
  const composer = (): HTMLTextAreaElement => document.getElementById("cin") as HTMLTextAreaElement;

  it("**「询问此对象」不冲掉半句话**，而且给的是一个问句、不是一行元数据", () => {
    composer().value = "我半句话还没打完";
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const ask = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => (b.textContent ?? "").startsWith("询问此")) as HTMLButtonElement;
    fireEvent.click(ask);
    const v = composer().value;
    expect(v).toContain("我半句话还没打完");     // 原来那半句还在
    expect(v).toContain("采购订单");
    expect(v).toContain("我想确认");             // 是个问句
    expect(v).not.toContain("画布节点");          // 业务对象不叫这个
    expect(v).not.toContain("object");            // 不露英文枚举
    expect(v).not.toMatch(/node\s+\S+/u);         // 不露内部 rid
  });

  it("**两个缺口芯片能连点** —— 上一版点第二个把第一个冲掉", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const chips = Array.from(container.querySelectorAll(".ctx-gap") as any[]) as HTMLButtonElement[];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(chips[0]!);
    const first = composer().value;
    fireEvent.click(chips[1]!);
    const both = composer().value;
    expect(both).toContain(first.trim().slice(0, 12));
    expect(both.length).toBeGreaterThan(first.length);
  });

  it("属性行的修正指令同样是追加", () => {
    composer().value = "先说一句";
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(container.querySelector(".ctx-attr") as HTMLButtonElement);
    expect(composer().value).toContain("先说一句");
  });
});

describe("筛选框说人话（R10）", () => {
  it("**每页说清楚按什么筛**，不再承诺跨 tab 搜索", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const ph = (): string => container.querySelector(".ctx-search input")?.getAttribute("placeholder") ?? "";
    expect(ph()).toContain("在模型里筛");
    const go = (tab: string): void => {
      fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
        .find((n: any) => n.textContent === tab) as HTMLButtonElement);
    };
    go("交付");
    expect(ph()).toContain("在产物里筛");
    go("审阅");
    expect(ph()).toContain("在待确认里筛");
  });

  // 上一轮这条钉的是「项目页不显示搜索框」—— 那是**降级方案**：因为它只是本页
  // 筛选，而项目页不收 query，所以干脆藏起来。这一轮做成了真的跨 tab（命中数
  // 下拉，点一下切过去），项目页就该有框了，钉的东西也跟着换成新契约。
  it("项目页也能搜 —— 它现在是跨 tab 的，不再是本页筛选", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((n: any) => n.textContent === "项目") as HTMLButtonElement);
    expect(container.querySelector(".ctx-search")).not.toBeNull();
    expect(container.querySelector(".ctx-search input")?.getAttribute("placeholder"))
      .toContain("搜文件、对象、待确认、产物");
  });
});

describe("跨 tab 搜索（R10 完成态）", () => {
  it("**按 tab 分组给命中数** —— 「这个词在这个项目里有没有」不用挨个 tab 试", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const input = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "采购订单" } });
    const hits = Array.from(container.querySelectorAll(".ctx-search-hit") as any[])
      .map((n: any) => n.textContent);
    // 模型里有这个对象
    expect(hits.some((t: string) => t.startsWith("模型"))).toBe(true);
  });

  it("**点命中数切过去并带上 query** —— 交付页搜「采购订单」看到 0 会以为项目里没有", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    // 先待在交付页
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((n: any) => n.textContent === "交付") as HTMLButtonElement);
    const input = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "采购订单" } });
    // 下拉告诉他模型里有
    const modelHit = Array.from(container.querySelectorAll(".ctx-search-hit") as any[])
      .find((n: any) => n.textContent.startsWith("模型")) as HTMLButtonElement;
    expect(modelHit).toBeDefined();
    fireEvent.click(modelHit);
    // 切过去了，query 还在，而且真的筛出了东西
    expect(container.querySelector('.ctx-nav-item[aria-selected="true"]')?.textContent).toBe("模型");
    expect((container.querySelector(".ctx-search input") as HTMLInputElement).value).toBe("采购订单");
    expect(container.querySelectorAll(".ctx-model-item").length).toBeGreaterThan(0);
  });

  it("整个项目都没命中时明说，而不是让人以为只是这一页没有", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const input = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "根本不存在zzz" } });
    expect(container.querySelector(".ctx-search-none")?.textContent).toContain("这个项目里没有匹配");
  });

  it("命中数与切过去之后看到的条数一致 —— 说有 N 条就得真有 N 条", () => {
    const { container } = render(<ContextSidebar context={{ revision: 12 }} />);
    const input = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "采购订单" } });
    const modelHit = Array.from(container.querySelectorAll(".ctx-search-hit") as any[])
      .find((n: any) => n.textContent.startsWith("模型")) as HTMLButtonElement;
    const claimed = Number(/\d+/u.exec(modelHit.textContent ?? "")![0]);
    fireEvent.click(modelHit);
    expect(container.querySelectorAll(".ctx-model-item")).toHaveLength(claimed);
  });
});

describe("自动发送不许吃掉草稿", () => {
  it("**发完把用户的半句话原样放回去** —— 自动发送是有意的，吃草稿不是", async () => {
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    composer.value = "我正在打的另一句话";
    const seen: string[] = [];
    contextChatBridge.send = async () => {
      seen.push(composer.value);      // 发出去的是侧栏那条，不是草稿
      composer.value = "";            // sendChat 发完会清空
    };
    const { sent } = await sendContextToChat("请确认这条关联是否成立", {
      send: contextChatBridge.send, mode: "replace",
    });
    expect(sent).toBe(true);
    expect(seen[0]).toContain("请确认这条关联");
    expect(seen[0]).not.toContain("我正在打的另一句话");
    // 草稿还回来了
    expect(composer.value).toBe("我正在打的另一句话");
  });

  it("发送抛错也要还草稿 —— 发失败还把草稿吃了是最糟的组合", async () => {
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    composer.value = "草稿";
    await expect(sendContextToChat("x", {
      send: async () => { throw new Error("网络挂了"); }, mode: "replace",
    })).rejects.toThrow("网络挂了");
    expect(composer.value).toBe("草稿");
  });

  it("本来就是空的就别多此一举", async () => {
    const composer = document.getElementById("cin") as HTMLTextAreaElement;
    composer.value = "";
    await sendContextToChat("x", { send: async () => { composer.value = ""; }, mode: "replace" });
    expect(composer.value).toBe("");
  });
});

describe("项目驾驶舱（项目页）", () => {
  it("先展示项目阶段与下一步；阻塞问题浮出最关键的一条与负责人", () => {
    G.S = {
      title: "采购项目",
      status: "done",
      filelist: [{ name: "a.xlsx" }],
      state: {
        oir: { stats: { objects: 3 } },
        flow: { workflows: [{ id: "purchase" }] },
        artifacts: ["oir.json"],
        artifact_revision: 7,
      },
    } as never;
    G.Q_BACKLOG = [
      { id: "q1", text: "计划金额到底含不含税要一个明确口径", status: "open", priority: "blocking", audienceRole: "财务", blockedArtifacts: [] },
      { id: "q2", text: "普通待办", status: "open", priority: "normal", blockedArtifacts: [] },
    ] as never;
    const { container } = render(
      <ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />,
    );
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "项目"));
    const txt = container.textContent || "";
    expect(txt).toContain("项目概况");
    expect(txt).toContain("等待关键决策");
    expect(txt).toContain("资料");
    expect(txt).toContain("模型");
    expect(txt).toContain("审阅");
    expect(txt).toContain("交付");
    expect(txt).toContain("1 个关键问题正在阻塞交付");
    expect(txt).toContain("关键阻塞");
    expect(txt).toContain("计划金额到底含不含税");
    expect(txt).toContain("财务");
    expect(txt).toContain("r7");
    expect(container.querySelectorAll(".ctx-project-workspace")).toHaveLength(4);
    expect(txt).not.toContain("北极星四问");
    expect(txt).not.toContain("Engagement");
  });

  it("最近更新只留摘要，并能进入完整运行记录", () => {
    G.S = {
      title: "采购项目", status: "done", filelist: [{ name: "a.xlsx" }],
      state: { oir: { objects: [{ id: "po" }] }, flow: {}, artifacts: ["oir.json"], artifact_revision: 7 },
      events: [{ seq: 1, ts: 1, kind: "artifact.ready", name: "oir.json" }],
    } as never;
    G.Q_BACKLOG = [] as never;
    G.OPS = [{ seq: 1, ts: 1, kind: "artifact.ready", label: "产物已生成", detail: "oir.json", tag: "ok" }] as never;
    const { container } = render(
      <ContextSidebar context={{ revision: 7, questions: [] }} />,
    );
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "项目"));
    const btn = Array.from(container.querySelectorAll("button") as any[])
      .find((b: any) => b.textContent === "查看运行记录") as HTMLButtonElement;
    expect(container.textContent).toContain("产物已生成");
    fireEvent.click(btn);
    expect(container.querySelector(".ctx-sidebar-title")?.textContent).toBe("运行详情");
    expect(container.textContent).toContain("运行记录");
  });

  it("空态只给两条清晰起步路径，不展示零值工作区或内部 Engagement", () => {
    G.S = {
      title: "新会话", status: "idle", filelist: [],
      state: { artifacts: [], engagement: { plan: [{ id: "INTAKE", state: "pending" }] } },
    } as never;
    G.Q_BACKLOG = [] as never;
    const { container } = render(<ContextSidebar context={{ revision: 0, questions: [] }} />);
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "项目"));
    const txt = container.textContent || "";
    expect(txt).not.toContain("北极星四问");
    expect(txt).not.toContain("INTAKE");
    expect(container.querySelectorAll(".ctx-project-workspace")).toHaveLength(0);
    expect(txt).toContain("先提供业务材料");
    expect(txt).toContain("上传材料");
    expect(txt).toContain("从通用场景生成草案");
  });
});

// ══════════════════════════════════════════════════════════════════
//  产物预览：结构化 JSON 要当表看，不是一堵字符串墙
//
//  2026-08-25 用户截图：交付页打开 `数据字典.json`，界面给的是缩进后的整坨
//  JSON。而它的形状是 `{tables:[…], fields:[…], coverage:{…}}` —— 每个数组都是
//  一张标准的表。把表渲染成字符串墙，等于把已经结构化的东西又拍回文本。
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  交付页：主次要分明
//
//  2026-08-25 用户原话「有点杂乱无顺序」。实测那个会话 16 个产物平铺成 16 行
//  一模一样的「JSON 文件名 ready 预览」——真正要交给客户的只有两份文档，
//  其余 11 个是同一份草案包切出来的机器视图。
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  模型页：人人都有的缺口说一次，就别在每行重复
//
//  实测（3f6079e3e38f）：32 个对象**全部**是 0 属性、0 关系、0 证据，于是每一行
//  都挂着一个「4」的缺口徽章 —— 49 行同一个数字，信息量为零，还占掉了真正有
//  区分度的位置。这与本文件已有的另一条纪律同源：状态列在全库同值时不占位。
//  共有的缺口应该在列表顶上说一次（而且要说人话），行上只留**彼此不同**的那些。
// ══════════════════════════════════════════════════════════════════
describe("模型页的共有缺口", () => {
  const bareObjects = (n: number) => Array.from({ length: n }, (_, i) => ({
    rid: `object:o${i}`,
    displayName: { value: `对象${i}` },
    apiName: { value: `obj${i}` },
    description: { value: "" },
    status: "candidate",
  }));
  const openModel = async (container: Element) => {
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "模型") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-model-list")).not.toBeNull());
  };

  it("整组都缺同样的东西时，组头说一次，行上一个标都不留", async () => {
    G.S.state.oir = { objects: bareObjects(6), properties: [], links: [], actions: [], rules: [], events: [], questions: [], stats: {} };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    const note = container.querySelector(".ctx-common-gaps");
    expect(note?.textContent).toContain("全部");
    expect(note?.textContent).toContain("无属性");
    expect(note?.textContent).toContain("无关系");
    expect(container.querySelectorAll(".ctx-item-gaps")).toHaveLength(0);
  });

  it("**绝大多数**都缺时也只在组头说，且如实报比例 —— 行上只标异常", async () => {
    // 线上实测：28 个对象里 22 个挂着**同一个**标「无主键、无属性 +1」。
    // 只按「全体共有」去重，规律仍然被重复 22 遍。规律就该在组头说一次，
    // 行上留给「这一条和同类不一样在哪」。
    const objs = bareObjects(10);
    // 9/10 缺主键（多数），1 个有 —— 多数规律进组头，那 1 个不是"异常缺口"所以不带标
    for (let i = 0; i < 1; i += 1) (objs[i] as any).primaryKey = { value: [`obj${i}_id`] };
    G.S.state.oir = { objects: objs, properties: [], links: [], actions: [], rules: [], events: [], questions: [], stats: {} };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    const note = container.querySelector(".ctx-common-gaps")!;
    // 如实报比例：不能把 9/10 说成「全部」
    expect(note.textContent).toContain("9/10");
    expect(note.textContent).toContain("无主键");
    expect(note.textContent).toContain("全部");     // 无属性/无关系确实是全部
    expect(container.querySelectorAll(".ctx-item-gaps")).toHaveLength(0);
  });

  it("少数派的缺口才留在行上，而且写成人话不是一个数字", async () => {
    // 8 个对象：只有 2 个缺关系（少数）→ 那 2 个带标，其余干净
    const objs = bareObjects(8);
    G.S.state.oir = {
      objects: objs, actions: [], rules: [], events: [], questions: [], stats: {},
      // 给 6 个对象各自连一条关系，剩下 2 个没有 → 「无关系」成为少数派缺口
      properties: objs.map((o: any, i: number) => ({
        parent: `obj${i}`, apiName: { value: `f${i}` }, displayName: { value: `字段${i}` },
        baseType: "STRING", definition: { value: "x" },
      })),
      links: objs.slice(0, 6).map((o: any, i: number) => ({
        rid: `link:l${i}`, from: `obj${i}`, to: `obj${(i + 1) % 6}`, cardinality: "多对一",
        displayName: { value: `关系${i}` },
      })),
    };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    const marked = Array.from(container.querySelectorAll(".ctx-item-gaps") as any[]);
    expect(marked).toHaveLength(2);
    expect(marked[0]!.textContent).toContain("无关系");   // 是词，不是「1」
  });

  it("混着对象和规则时按**各自类型**算共有缺口，并分组列出", async () => {
    // 线上实测抓到的：visible 里混着 28 个对象 + 20 条规则 + 1 个动作，
    // 于是「全体共有」为空，42 行各自重复「无主键、无属性 +2」—— 比原来的
    // 数字徽章更吵。共有性只在同类之间才有意义。
    G.S.state.oir = {
      objects: bareObjects(4), properties: [], links: [], actions: [], events: [], questions: [], stats: {},
      rules: Array.from({ length: 3 }, (_, i) => ({
        rid: `rule:r${i}`, name: { value: `规则${i}` }, statement: { value: "" }, appliesTo: [], status: "candidate",
      })),
    };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    // 分组：对象一组、规则一组，各带自己的标题与条数
    const groups = Array.from(container.querySelectorAll(".ctx-model-group") as any[]);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const heads = groups.map((g: any) => g.querySelector(".ctx-model-group-head")?.textContent || "");
    expect(heads.some((h: string) => h.includes("对象") && h.includes("4"))).toBe(true);
    expect(heads.some((h: string) => h.includes("规则") && h.includes("3"))).toBe(true);
    // 对象那一组说它自己的共有缺口，而不是「全体没有共同点」
    const objectGroup = groups.find((g: any) => (g.querySelector(".ctx-model-group-head")?.textContent || "").includes("对象"))!;
    expect(objectGroup.querySelector(".ctx-common-gaps")?.textContent).toContain("无属性");
    // 共有的不再逐行重复
    expect(objectGroup.querySelectorAll(".ctx-item-gaps")).toHaveLength(0);
  });

  it("**排序按「有多少」，不按「缺多少」** —— 空壳不许霸占第一屏", async () => {
    // 线上实测（3f6079e3e38f）：对象组第一屏是 业务对象 / 一、监控对象 / 一 / 二 /
    // 规则体系明细 / 规则名称 —— 全是解析噪声；而 采购申请/采购订单/验收/采购计划
    // 这些真建了模的排在最末。原因是按 gaps.length 降序排，而空壳恰好缺得最多：
    // 「最需要补」被当成了「最该先看」，可 FDE 打开模型页是来看**模型**的。
    const objs = [
      { rid: "object:empty1", displayName: { value: "一" }, apiName: { value: "partOne" }, status: "candidate" },
      { rid: "object:empty2", displayName: { value: "规则名称" }, apiName: { value: "ruleName" }, status: "candidate" },
      { rid: "object:real", displayName: { value: "采购订单" }, apiName: { value: "purchaseOrder" }, status: "candidate",
        primaryKey: { value: ["orderNo"] } },
    ];
    G.S.state.oir = {
      objects: objs, actions: [], rules: [], events: [], questions: [], stats: {},
      properties: [
        { parent: "purchaseOrder", apiName: { value: "orderNo" }, displayName: { value: "订单编号" },
          baseType: "STRING", definition: { value: "唯一编号" } },
        { parent: "purchaseOrder", apiName: { value: "amount" }, displayName: { value: "金额" },
          baseType: "DECIMAL", definition: { value: "含税" } },
      ],
      links: [{ rid: "link:l1", from: "purchaseOrder", to: "partOne", cardinality: "多对一",
        displayName: { value: "关联" } }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    const names = Array.from(container.querySelectorAll(".ctx-model-item strong") as any[])
      .map((e: any) => e.textContent.trim());
    expect(names[0]).toBe("采购订单");            // 建得最实的排最前
    expect(names.indexOf("采购订单")).toBeLessThan(names.indexOf("规则名称"));
  });

  it("显式点开「待补全」时才按缺口排 —— 那一档本来就是工作队列", async () => {
    const objs = [
      { rid: "object:real", displayName: { value: "采购订单" }, apiName: { value: "purchaseOrder" },
        status: "candidate", primaryKey: { value: ["orderNo"] } },
      { rid: "object:empty", displayName: { value: "一" }, apiName: { value: "partOne" }, status: "candidate" },
    ];
    G.S.state.oir = {
      objects: objs, actions: [], rules: [], events: [], questions: [], stats: {},
      properties: [{ parent: "purchaseOrder", apiName: { value: "orderNo" }, displayName: { value: "订单编号" },
        baseType: "STRING", definition: { value: "唯一编号" } }],
      links: [{ rid: "link:l1", from: "purchaseOrder", to: "partOne", cardinality: "多对一",
        displayName: { value: "关联" } }],
    };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    const todo = Array.from(container.querySelectorAll(".ctx-filter") as any[])
      .find((b: any) => b.textContent.includes("待补全")) as HTMLButtonElement;
    fireEvent.click(todo);
    const names = Array.from(container.querySelectorAll(".ctx-model-item strong") as any[])
      .map((e: any) => e.textContent.trim());
    expect(names[0]).toBe("一");                  // 缺得最多的排最前 —— 这一档要的就是它
  });

  it("只有一项时不提「共有缺口」（一个人的共同点不叫共同点）", async () => {
    G.S.state.oir = { objects: bareObjects(1), properties: [], links: [], actions: [], rules: [], events: [], questions: [], stats: {} };
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: [] }} />);
    await openModel(container);
    expect(container.querySelector(".ctx-common-gaps")).toBeNull();
    expect(container.querySelectorAll(".ctx-item-gaps").length).toBeGreaterThan(0);
  });
});

describe("交付页分组", () => {
  const ARTIFACTS = [
    "数据字典.json", "数据字典.xlsx", "问题清单.json", "问题清单.md", "问题清单.xlsx",
    "ontology.package.draft.json", "ontology-package.v1.schema.json",
    "data-objects.draft.json", "links.draft.json", "actions.draft.json", "events.draft.json",
    "workflows.draft.json", "rules.draft.json", "integrations.draft.json",
    "gaps.draft.json", "questions.draft.json",
  ];
  const openDelivery = async (container: Element) => {
    fireEvent.click(Array.from(container.querySelectorAll(".ctx-nav-item") as any[])
      .find((node: any) => node.textContent === "交付") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".ctx-delivery-panel")).not.toBeNull());
  };

  it("16 个产物收成 2 份文档 + 1 组默认折叠的模型快照", async () => {
    G.S.state.artifacts = ARTIFACTS;
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    await openDelivery(container);
    const docs = Array.from(container.querySelectorAll(".ctx-delivery-doc") as any[]);
    expect(docs.map((d: any) => d.querySelector(".ctx-delivery-doc-title")?.textContent))
      .toEqual(["数据字典", "问题清单"]);
    // 机器视图默认不展开 —— 但要说清有多少个，不能让人以为产物少了
    expect(container.querySelector(".ctx-artifact")).toBeNull();
    const toggle = container.querySelector(".ctx-snapshot-toggle") as HTMLButtonElement;
    expect(toggle.textContent).toContain("11");
  });

  it("同一份文档的格式并排成入口，xlsx 排在 json 前面（能填能回传的先给）", async () => {
    G.S.state.artifacts = ARTIFACTS;
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    await openDelivery(container);
    const first = container.querySelector(".ctx-delivery-doc") as HTMLElement;
    // 「迭代」是动作入口不是格式入口（P3），格式排序断言把它剔出去单看
    expect(Array.from(first.querySelectorAll(".ctx-format:not(.ctx-iterate)") as any[])
      .map((b: any) => b.textContent))
      .toEqual(["XLSX", "JSON"]);
  });

  it("展开后机器视图逐个可点 —— 折叠是收纳，不是藏起来", async () => {
    G.S.state.artifacts = ARTIFACTS;
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    await openDelivery(container);
    fireEvent.click(container.querySelector(".ctx-snapshot-toggle") as HTMLButtonElement);
    expect(container.querySelectorAll(".ctx-artifact")).toHaveLength(11);
  });

  it("搜索照旧管用，且能搜到被折叠的那些", async () => {
    G.S.state.artifacts = ARTIFACTS;
    const { container } = render(<ContextSidebar context={{ revision: 12, questions: G.Q_BACKLOG }} />);
    await openDelivery(container);
    const search = container.querySelector(".ctx-search input") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "links" } });
    await waitFor(() => expect(container.querySelectorAll(".ctx-artifact")).toHaveLength(1));
    expect(container.querySelector(".ctx-artifact")?.textContent).toContain("links.draft.json");
    expect(container.querySelectorAll(".ctx-delivery-doc")).toHaveLength(0);
  });
});

describe("sheetsFromJson", () => {
  it("对象里的每个「对象数组」各成一张表，列取并集、顺序按首次出现", () => {
    const sheets = sheetsFromJson({
      tables: [
        { file: "a.xlsx", container: "Sheet1", rowCount: 33 },
        { file: "b.xlsx", container: "Sheet2", rowCount: 7, note: "补充" },
      ],
      fields: [{ name: "orderNo", type: "string" }],
    });
    expect(sheets.map((s) => s.name)).toEqual(["tables", "fields"]);
    expect(sheets[0]!.columns).toEqual(["file", "container", "rowCount", "note"]);
    expect(sheets[0]!.rows[0]).toEqual(["a.xlsx", "Sheet1", "33", ""]);
    expect(sheets[1]!.rows).toEqual([["orderNo", "string"]]);
  });

  it("顶层就是对象数组时成一张表", () => {
    const sheets = sheetsFromJson([{ a: 1 }, { a: 2 }]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.rows).toEqual([["1"], ["2"]]);
  });

  it("嵌套值压成紧凑 JSON，不让一格吃掉整行", () => {
    const sheets = sheetsFromJson({ rows: [{ k: "x", meta: { a: 1 }, tags: ["p", "q"] }] });
    expect(sheets[0]!.rows[0]).toEqual(["x", '{"a":1}', "p, q"]);
  });

  it("标量、标量数组与空数组不成表（那些该按原样的 JSON 看）", () => {
    expect(sheetsFromJson({ coverage: { hit: 3 }, names: ["a", "b"], empty: [] })).toEqual([]);
    expect(sheetsFromJson("字符串")).toEqual([]);
    expect(sheetsFromJson(null)).toEqual([]);
  });

  it("超大表截断，并在表名上说清楚截了多少（不许假装全在这里）", () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ i }));
    const sheets = sheetsFromJson({ many });
    expect(sheets[0]!.rows).toHaveLength(500);
    expect(sheets[0]!.name).toContain("900");
  });
});
