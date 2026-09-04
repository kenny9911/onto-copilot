// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/react/knowledge-workspace.js", () => ({
  KnowledgeWorkspace: ({ sessionId, sessionFiles }: {
    sessionId: string;
    sessionFiles: Array<{ name: string }>;
  }) => <section className="od-library" data-session-id={sessionId}>
    {sessionFiles.map((file) => <span key={file.name}>{file.name}</span>)}
  </section>,
}));

import { G } from "../src/ui/state.js";
import { registeredRegions } from "../src/ui/react/app.js";
import {
  KnowledgePage, closeKnowledgePage, openKnowledgePage,
} from "../src/ui/react/knowledge-page.js";

function setUrl(value: string, page: "chat" | "knowledge" = "chat"): void {
  window.history.replaceState({ ocPage: page }, "", value);
}

beforeEach(() => {
  document.body.innerHTML = '<div class="knowledge-page" id="knowledgePage"></div>';
  document.body.classList.remove("knowledge-page-open");
  setUrl("/work");
  G.MAIN_PAGE = "chat";
  G.MODE = "work";
  G.LANG = "zh";
  G.PROJECTS_OK = true;
  G.PROJECTS = [{ id: "p1", name: "采购数字化" }];
  G.S = {
    id: "s1",
    project_id: "p1",
    filelist: [{ name: "采购制度.docx", state: "parsed" }],
  };
});

afterEach(() => {
  cleanup();
  G.MAIN_PAGE = "chat";
  document.body.classList.remove("knowledge-page-open");
  setUrl("/work");
});

describe("独立项目知识库页面", () => {
  it("注册到独立主页面宿主，而不是右侧栏宿主", () => {
    const registrations = registeredRegions().filter((item) => item.id === "knowledgePage");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.Component).toBe(KnowledgePage);
    expect(registeredRegions().some((item) => item.id === "pbody" && item.Component === KnowledgePage)).toBe(false);
  });

  it("打开后占用主页面，并把当前会话文件交给项目知识库", async () => {
    const view = render(<KnowledgePage />);
    expect(view.container.querySelector(".knowledge-page-shell")).toBeNull();

    // 侧栏在会话已归项目时传 "project"；缺省是公共库。
    act(() => openKnowledgePage("project"));

    expect(G.MAIN_PAGE).toBe("knowledge");
    expect(G.KNOWLEDGE_TARGET).toBe("project");
    expect(window.location.hash).toBe("#knowledge");
    expect(await view.findByRole("main", { name: "知识库" })).not.toBeNull();
    expect(view.getByRole("heading", { name: /知识库/ })).not.toBeNull();
    expect(view.container.textContent).toContain("采购数字化");
    expect(view.container.querySelector(".od-library")?.getAttribute("data-session-id")).toBe("s1");
    expect(view.container.textContent).toContain("采购制度.docx");
    expect(document.body.classList.contains("knowledge-page-open")).toBe(true);
  });

  it("会话没归项目时进的是「我的材料」，不是被弹去公共库", () => {
    // 这条契约改过两次。第一版：`if (!G.S?.id || !G.S?.project_id) return;`
    // —— 按钮点了没反应。第二版改成「没项目就退到公共层」。
    //
    // 现在是第三版，起因是用户的截图：会话里 6 份材料，这一页写着「0 份材料」。
    // 公共库**结构上不可能**装着某个会话的上传件，把人送进去等于说「你的东西
    // 不见了」。后端 document_scope.ts 会给这种会话懒建「我的材料」默认项目，
    // 材料一直存得进去 —— 挡在门外的只有前端这个判据。
    G.S = { id: "s1", filelist: [] };
    const view = render(<KnowledgePage />);

    act(() => openKnowledgePage("project"));

    expect(G.MAIN_PAGE).toBe("knowledge");
    expect(G.KNOWLEDGE_TARGET).toBe("project");
    expect(window.location.hash).toBe("#knowledge");
    expect(view.container.querySelector(".knowledge-page-shell")).not.toBeNull();
    // 标题照实说后端那个默认项目的名字，不写「项目 · 知识库」去指一个用户
    // 从没建过的东西。
    expect(view.container.querySelector("h1")?.textContent).toBe("我的材料 · 知识库");
    // 两档现在都能用：项目层只要有会话就成立（后端会懒建默认项目），
    // 公共层本来就不依赖会话。灰掉的只剩「一个会话都没有」那种情况。
    const [global, project] = [...view.container.querySelectorAll(".kp-level button")] as HTMLButtonElement[];
    expect(project!.hasAttribute("disabled")).toBe(false);
    expect(project!.textContent).toBe("我的材料");
    expect(global!.hasAttribute("disabled")).toBe(false);
  });

  it("页面内返回会话会清掉 hash，并替换当前历史记录", async () => {
    const view = render(<KnowledgePage />);
    act(() => openKnowledgePage());
    const button = await view.findByRole("button", { name: "返回会话" });

    fireEvent.click(button);

    expect(G.MAIN_PAGE).toBe("chat");
    expect(window.location.hash).toBe("");
    expect(window.history.state).toMatchObject({ ocPage: "chat" });
    expect(view.container.querySelector(".knowledge-page-shell")).toBeNull();
    expect(document.body.classList.contains("knowledge-page-open")).toBe(false);
  });

  it("浏览器历史与直接 #knowledge 链接都能双向同步页面", async () => {
    const view = render(<KnowledgePage />);

    setUrl("/work#knowledge", "knowledge");
    act(() => window.dispatchEvent(new window.Event("hashchange")));
    await waitFor(() => expect(G.MAIN_PAGE).toBe("knowledge"));
    expect(view.container.querySelector(".knowledge-page-shell")).not.toBeNull();

    setUrl("/work", "chat");
    act(() => window.dispatchEvent(new window.Event("popstate")));
    await waitFor(() => expect(G.MAIN_PAGE).toBe("chat"));
    expect(view.container.querySelector(".knowledge-page-shell")).toBeNull();

    // 模拟刷新/外链直接落在 #knowledge：首次 effect 也必须接管，而不是只认按钮点击。
    cleanup();
    setUrl("/work#knowledge", "knowledge");
    G.MAIN_PAGE = "chat";
    const deepLink = render(<KnowledgePage />);
    await waitFor(() => expect(G.MAIN_PAGE).toBe("knowledge"));
    expect(deepLink.container.querySelector(".knowledge-page-shell")).not.toBeNull();
  });

  it("显式关闭函数支持替换历史记录", () => {
    render(<KnowledgePage />);
    act(() => openKnowledgePage());
    act(() => closeKnowledgePage({ replaceHistory: true }));
    expect(G.MAIN_PAGE).toBe("chat");
    expect(window.location.hash).toBe("");
    expect(window.history.state).toMatchObject({ ocPage: "chat" });
  });
});
