// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WORKBENCH_ADD_EVENT,
  WORKBENCH_TAB_ID,
  WorkbenchTabShell,
  emptyWorkbenchTabs,
  loadWorkbenchTabs,
  normalizeWorkbenchTarget,
  normalizeSafeWebUrl,
  reduceWorkbenchTabs,
  saveWorkbenchTabs,
  useWorkbenchTabs,
  workbenchResourceKey,
  workbenchTabsStorageKey,
  type WorkbenchResourceTarget,
} from "../src/ui/react/workbench-tabs.js";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const web = (patch: Partial<WorkbenchResourceTarget> = {}): WorkbenchResourceTarget => ({
  kind: "web",
  pageId: "sap-pr",
  url: "https://help.sap.com/purchase-requisitions#approval",
  title: "SAP · Manage Purchase Requisitions",
  ...patch,
});

describe("workbench tab store", () => {
  it("固定工作台不可关闭；同一 target 复用页签并更新最新标题/viewState", () => {
    const initial = emptyWorkbenchTabs("s1");
    expect(reduceWorkbenchTabs(initial, { type: "close", id: WORKBENCH_TAB_ID })).toBe(initial);

    const opened = reduceWorkbenchTabs(initial, { type: "open", target: web() });
    const duplicate = reduceWorkbenchTabs(opened, { type: "open", target: web({
      title: "采购申请管理",
      viewState: { language: "zh", scrollY: 360 },
    }) });
    expect(duplicate.resources).toHaveLength(1);
    expect(duplicate.resources[0]?.target).toMatchObject({
      title: "采购申请管理",
      viewState: { language: "zh", scrollY: 360 },
    });
    expect(duplicate.activeId).toBe(duplicate.resources[0]?.id);
  });

  it("URL 首开补 pageId 后再由事件打开仍复用 established tab key", () => {
    let state = reduceWorkbenchTabs(emptyWorkbenchTabs("s1"), { type: "open", target: {
      kind: "web", url: "https://docs.example.com/guide#intro", title: "读取中",
      viewState: { webHistory: { entries: [{ url: "https://docs.example.com/guide" }], index: 0 } },
    } });
    const establishedId = state.activeId;
    const establishedKey = state.resources[0]?.key;
    state = reduceWorkbenchTabs(state, { type: "patch", id: establishedId, patch: {
      pageId: "page-guide-v1", title: "指南 · 已加载", viewState: { digest: "digest-v1" },
    } });
    state = reduceWorkbenchTabs(state, { type: "activate", id: WORKBENCH_TAB_ID });
    state = reduceWorkbenchTabs(state, { type: "open", target: {
      kind: "web", pageId: "page-guide-v1", url: "https://docs.example.com/guide#approval",
      title: "指南 · 来自记忆", viewState: { language: "zh" },
    } });

    expect(state.resources).toHaveLength(1);
    expect(state.activeId).toBe(establishedId);
    expect(state.mru).toEqual([establishedId, WORKBENCH_TAB_ID]);
    expect(state.resources[0]).toMatchObject({
      id: establishedId,
      key: establishedKey,
      target: {
        key: establishedKey,
        pageId: "page-guide-v1",
        title: "指南 · 来自记忆",
        viewState: {
          digest: "digest-v1",
          language: "zh",
          webHistory: { entries: [{ url: "https://docs.example.com/guide" }], index: 0 },
        },
      },
    });
  });

  it("关闭当前页按 MRU 回退，不按视觉位置猜上一页", () => {
    let state = emptyWorkbenchTabs("s1");
    state = reduceWorkbenchTabs(state, { type: "open", target: web({
      pageId: "a", url: "https://a.example/", title: "A",
    }) });
    const a = state.activeId;
    state = reduceWorkbenchTabs(state, { type: "open", target: web({
      pageId: "b", url: "https://b.example/", title: "B",
    }) });
    const b = state.activeId;
    state = reduceWorkbenchTabs(state, { type: "activate", id: a });
    state = reduceWorkbenchTabs(state, { type: "activate", id: b });
    state = reduceWorkbenchTabs(state, { type: "close", id: b });
    expect(state.activeId).toBe(a);
  });

  it("隐藏资源的内容回填不激活、不改 MRU，并原子合并轻量 viewState", () => {
    let state = emptyWorkbenchTabs("s1");
    state = reduceWorkbenchTabs(state, { type: "open", target: web({
      pageId: "slow-a", url: "https://a.example/", title: "A",
    }) });
    const slowA = state.activeId;
    state = reduceWorkbenchTabs(state, { type: "open", target: web({
      pageId: "fast-b", url: "https://b.example/", title: "B",
    }) });
    state = reduceWorkbenchTabs(state, { type: "activate", id: WORKBENCH_TAB_ID });
    const mru = [...state.mru];

    state = reduceWorkbenchTabs(state, { type: "patch", id: slowA, patch: {
      pageId: "slow-a-v2",
      title: "A · 已加载",
      viewState: { digest: "digest-a", webHistory: { entries: [{ url: "https://a.example/" }], index: 0 } },
    } });
    state = reduceWorkbenchTabs(state, { type: "patch", id: slowA, patch: {
      viewState: { savedAssetId: "asset-a" },
    } });

    expect(state.activeId).toBe(WORKBENCH_TAB_ID);
    expect(state.mru).toEqual(mru);
    expect(state.resources.find((tab) => tab.id === slowA)?.target).toMatchObject({
      key: expect.any(String),
      pageId: "slow-a-v2",
      title: "A · 已加载",
      viewState: {
        digest: "digest-a",
        savedAssetId: "asset-a",
        webHistory: { entries: [{ url: "https://a.example/" }], index: 0 },
      },
    });
  });

  it("按会话隔离持久化 pageId/url/favicon/viewState，并丢弃坏数据", () => {
    let state = reduceWorkbenchTabs(emptyWorkbenchTabs("session/a"), {
      type: "open",
      target: web({ favicon: "https://help.sap.com/favicon.ico", viewState: { language: "bilingual" } }),
    });
    saveWorkbenchTabs(state);
    expect(loadWorkbenchTabs("session/a")).toMatchObject({
      activeId: state.activeId,
      resources: [{ target: {
        kind: "web", pageId: "sap-pr", url: expect.stringContaining("help.sap.com"),
        favicon: expect.stringContaining("favicon.ico"), viewState: { language: "bilingual" },
      } }],
    });
    expect(loadWorkbenchTabs("session/b").resources).toEqual([]);

    localStorage.setItem(workbenchTabsStorageKey("broken"), "{not json");
    expect(loadWorkbenchTabs("broken")).toEqual(emptyWorkbenchTabs("broken"));
  });

  it("持久化不写入 ContextViewer 的 OIR/Flow 大对象或函数", () => {
    const target: WorkbenchResourceTarget<any> = {
      kind: "context", id: "graph:12", title: "工作流画布",
      viewer: { id: "graph:12", flow: { nodes: Array.from({ length: 300 }, (_, id) => ({ id })) }, callback() {} },
      viewState: { zoom: 0.8 },
    };
    const state = reduceWorkbenchTabs(emptyWorkbenchTabs<any>("s-heavy"), { type: "open", target });
    saveWorkbenchTabs(state);
    const raw = localStorage.getItem(workbenchTabsStorageKey("s-heavy")) || "";
    expect(raw).not.toContain("callback");
    expect(raw).not.toContain("nodes");
    expect(loadWorkbenchTabs("s-heavy").resources[0]?.target).toEqual({
      kind: "context", id: "graph:12", title: "工作流画布", viewState: { zoom: 0.8 },
    });
  });

  it("公开 open 事件接受最小 web target，身份不受 hash 与 viewState 干扰", () => {
    const target = normalizeWorkbenchTarget({
      kind: "web", pageId: "page-7", url: "https://example.com/guide#part", viewState: { scrollY: 7 },
    });
    expect(target).toMatchObject({ kind: "web", pageId: "page-7", title: "https://example.com/guide#part" });
    expect(workbenchResourceKey(target!)).toBe("web:page-7");
    expect(normalizeWorkbenchTarget({ kind: "web", title: "缺 URL" })).toBeNull();
    expect(normalizeSafeWebUrl("help.sap.com/docs")).toBe("https://help.sap.com/docs");
    expect(normalizeSafeWebUrl("javascript:alert(1)")).toBeNull();
  });
});

function ShellFixture(): any {
  const controller = useWorkbenchTabs("fixture-session");
  return <WorkbenchTabShell controller={controller}
    workbench={<div data-testid="resident-workbench">
      <input aria-label="工作台草稿" defaultValue="未修改" />
      <button type="button" onClick={() => controller.open(web())}>打开 SAP</button>
      <button type="button" onClick={() => controller.open(web({ pageId: "policy", title: "采购制度.pdf", kind: "file", id: "policy" }))}>打开制度</button>
    </div>}
    renderResource={(target) => <div data-testid={`resource-${target.pageId || target.id}`}>{target.title}</div>} />;
}

function IdentityEvolutionFixture(): any {
  const controller = useWorkbenchTabs("identity-evolution");
  const tab = controller.state.resources[0];
  const url = "https://docs.example.com/guide";
  return <WorkbenchTabShell controller={controller}
    workbench={<div>
      <button type="button" onClick={() => controller.open({ kind: "web", url, title: "读取中" })}>URL 打开</button>
      <button type="button" onClick={() => {
        if (tab) controller.updateWithoutActivate(tab.id, {
          pageId: "page-guide-v1", title: "已加载",
          viewState: { webHistory: { entries: [{ url }], index: 0 } },
        });
      }}>补 pageId</button>
      <button type="button" onClick={() => controller.open({
        kind: "web", pageId: "page-guide-v1", url: `${url}#approval`, title: "来自事件",
      })}>事件打开</button>
    </div>}
    renderResource={(target) => <div data-testid="identity-resource">{target.title}</div>} />;
}

describe("workbench tab shell", () => {
  it("资源是工作台的 sibling page；资源激活时工作台隐藏但不卸载，返回后草稿仍在", () => {
    const { container, getByLabelText } = render(<ShellFixture />);
    const draft = getByLabelText("工作台草稿") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "访谈中的未保存草稿" } });
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "打开 SAP") as HTMLButtonElement);

    expect(container.querySelector(".wb-workbench-page")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".wb-resource-page:not([hidden])")?.textContent).toContain("Manage Purchase Requisitions");
    // hidden 不是 conditional render：工作台 DOM 仍在。
    expect(container.querySelector('[data-testid="resident-workbench"]')).not.toBeNull();

    fireEvent.click(Array.from(container.querySelectorAll('[role="tab"]') as any[])
      .find((tab: any) => tab.textContent.includes("工作台")) as HTMLButtonElement);
    expect((getByLabelText("工作台草稿") as HTMLInputElement).value).toBe("访谈中的未保存草稿");
  });

  it("固定 tab 没有关闭按钮；资源可关闭；overflow 和 + 都是可操作合同", () => {
    const { container } = render(<ShellFixture />);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "打开 SAP") as HTMLButtonElement);
    fireEvent.click(container.querySelector('.wb-tab[title="工作台"]') as HTMLButtonElement);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "打开制度") as HTMLButtonElement);

    expect(container.querySelector('.wb-tab-wrap:first-child .wb-tab-close')).toBeNull();
    expect(container.querySelectorAll(".wb-tab-close")).toHaveLength(2);
    fireEvent.click(container.querySelector(".wb-tab-overflow") as HTMLButtonElement);
    expect(container.querySelectorAll('.wb-overflow [role="menuitem"]')).toHaveLength(3);

    let requested = 0;
    window.addEventListener(WORKBENCH_ADD_EVENT, () => { requested++; }, { once: true });
    fireEvent.click(container.querySelector(".wb-tab-add") as HTMLButtonElement);
    expect(requested).toBe(1);
    expect(container.querySelector(".wb-add-resource")).not.toBeNull();
  });

  it("+ 自带可访问 URL 输入，不依赖外部监听器也能打开并去重网页", () => {
    const { container } = render(<ShellFixture />);
    fireEvent.click(container.querySelector(".wb-tab-add") as HTMLButtonElement);
    const input = container.querySelector("#wb-add-url") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("false");
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(container.querySelector(".wb-add-resource") as HTMLFormElement);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("http(s)");

    fireEvent.change(input, { target: { value: "help.sap.com/docs" } });
    fireEvent.submit(container.querySelector(".wb-add-resource") as HTMLFormElement);
    expect(container.querySelector('.wb-tab[title="help.sap.com"]')).not.toBeNull();
    expect(container.querySelector(".wb-resource-page:not([hidden])")?.textContent).toBe("help.sap.com");
  });

  it("URL→pageId→事件的 React 流程不会产生第二个资源页", async () => {
    const { container, getByText } = render(<IdentityEvolutionFixture />);
    fireEvent.click(getByText("URL 打开"));
    fireEvent.click(container.querySelector('.wb-tab[title="工作台"]') as HTMLButtonElement);
    fireEvent.click(getByText("补 pageId"));
    fireEvent.click(getByText("事件打开"));

    await waitFor(() => expect(container.querySelector('.wb-tab[title="来自事件"]')).not.toBeNull());
    expect(container.querySelectorAll(".wb-tab-close")).toHaveLength(1);
    expect(container.querySelectorAll(".wb-resource-page")).toHaveLength(1);
    expect(container.querySelector(".wb-resource-page:not([hidden])")?.textContent).toBe("来自事件");
  });

  it("tablist 支持方向键/Home/End/Delete，只有当前 tab 进入顺序焦点", async () => {
    const { container } = render(<ShellFixture />);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "打开 SAP") as HTMLButtonElement);
    fireEvent.click(container.querySelector('.wb-tab[title="工作台"]') as HTMLButtonElement);
    fireEvent.click(Array.from(container.querySelectorAll("button") as any[])
      .find((button: any) => button.textContent === "打开制度") as HTMLButtonElement);

    const selected = container.querySelector('.wb-tab[aria-selected="true"]') as HTMLButtonElement;
    fireEvent.keyDown(selected, { key: "Home" });
    expect(container.querySelector('.wb-tab[aria-selected="true"]')?.getAttribute("title")).toBe("工作台");
    expect(Array.from(container.querySelectorAll(".wb-tab") as any[]).filter((tab: any) => tab.tabIndex === 0)).toHaveLength(1);

    fireEvent.keyDown(container.querySelector('.wb-tab[aria-selected="true"]') as HTMLButtonElement, { key: "End" });
    const last = container.querySelector('.wb-tab[aria-selected="true"]') as HTMLButtonElement;
    expect(last.getAttribute("title")).toBe("采购制度.pdf");
    fireEvent.keyDown(last, { key: "Delete" });
    await waitFor(() => expect(container.querySelectorAll(".wb-tab-close")).toHaveLength(1));
  });

  it("CSS 明确覆盖 320/440/680+ 三档，而不是靠页面最小宽度侥幸不溢出", () => {
    const css = readFileSync(resolve(process.cwd(), "../ui/index.template.html"), "utf8");
    expect(css).toMatch(/@container preview \(max-width:359px\)/u);
    expect(css).toMatch(/@container preview \(min-width:440px\)/u);
    expect(css).toMatch(/@container preview \(min-width:680px\)/u);
    expect(css).toMatch(/\.wb-tabs-scroll\{[^}]*overflow-x:auto/u);
  });
});
