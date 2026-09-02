// @vitest-environment happy-dom
/**
 * 侧栏（`#convs`）的组件契约。
 *
 * 这 11 条不是新写的，是**从两个文件原样搬过来的**，判据一条没改，只把「断言拼出来的
 * 那串 HTML」换成「断言画出来的那棵 DOM」：
 *
 *   · ui.session.test.ts 的「侧栏」7 条 —— 会话行、按项目分组、折叠、未归类垫底、
 *     孤儿会话不许消失、后端没有 /api/projects 时安静退回平铺；
 *   · ui.contracts.escaping.test.ts 的「会话行：删除与改名处理器」4 条 —— 那 4 条原来
 *     断的是「拼进 onclick 的那个字符串字面量劈不开」，而**内联处理器整套已经没有了**
 *     （`onClick={() => dropSession(s.id, s.title)}` 传的是值）。所以判据换成它真正
 *     要保的东西：恶意输入渲染成文本，且处理器收到的是**原样**的值，一个字符都没被
 *     转义动过。这两件事对任何实现都测得了，而「调用了 earg()」不是。
 *
 * 剩下的两条（statusText 走 i18n、UNFILED 的 key 撞不上真项目 id）是纯逻辑，
 * 继续留在 ui.session.test.ts 的 stub 环境里 —— 它们和宿主无关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { convs, mountSidebar, rowTitles, shell } from "./ui.react.env.js";

// 处理器现在是真函数调用，所以「收到了什么」要把它们换成假的。
// importOriginal 保住同模块里那些被组件当纯函数用的导出（statusText / paintSessions）。
vi.mock("../src/ui/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/sessions.js")>();
  return { ...actual, dropSession: vi.fn(), openSession: vi.fn(), renameSession: vi.fn() };
});

import { G, PJ_OFF, UNFILED } from "../src/ui/state.js";
import { registeredRegions } from "../src/ui/react/app.js";
import { ConvRow, Sidebar } from "../src/ui/react/sidebar.js";
import { dropSession, renameSession } from "../src/ui/sessions.js";

const g = globalThis as any;

/** 攻击者能控制的那两串。第二条是旧世界里真出过事的形状。 */
const EVIL_TAG = `<img src=x onerror=alert(1)>`;
const EVIL_JS = `x','');globalThis.__pwned=1;//`;

const conv = (over: any = {}) => ({ id: "s1", title: "甲", status: "done", files: 0, ...over });

beforeEach(() => {
  shell();
  vi.clearAllMocks();
  delete g.__pwned;
  G.S = null;
  G.MAIN_PAGE = "chat";
  G.MODE = "work";
  G.LANG = "zh";
  G.PROJECTS = [];
  G.PROJECTS_OK = false;
  G.SESSION_LIST = [];
  PJ_OFF.clear();
  window.history.replaceState({ ocPage: "chat" }, "", "/");
});
afterEach(() => {
  cleanup();
  document.body.classList.remove("knowledge-page-open");
  window.history.replaceState({ ocPage: "chat" }, "", "/");
});

// ══════════════════════════════════════════════════════════════════
//  接线
// ══════════════════════════════════════════════════════════════════
describe("接线", () => {
  it("`#convs` 认的是 <Sidebar> —— 忘了注册的表现是「侧栏空白」，静默得可怕", () => {
    // registerRegion 写在 sidebar.tsx 的模块体最后一行，靠 react/regions.ts 点名
    // 引进来。漏了那一行不会报任何错：组件写好了、组件测试全绿，页面上侧栏是空的。
    const mine = registeredRegions().filter(r => r.id === "convs");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.Component).toBe(Sidebar);
  });
});

// ══════════════════════════════════════════════════════════════════
//  会话行（原 ui.session.test.ts「侧栏」的前两条）
// ══════════════════════════════════════════════════════════════════
describe("会话行", () => {
  it("会话行：标题渲染成文本、双击改名、删除按钮", () => {
    const { container } = render(
      <ConvRow s={conv({ title: "<b>坏名字</b>", files: 2, created: 0 })} />);

    expect(container.querySelector("b"), "标题里的标签变成了元素").toBeNull();
    expect(container.querySelector(".t").textContent).toBe("<b>坏名字</b>");
    fireEvent.doubleClick(container.querySelector(".t"));
    expect(renameSession).toHaveBeenCalledWith("s1");
    fireEvent.click(container.querySelector(".del"));
    expect(dropSession).toHaveBeenCalledWith("s1", "<b>坏名字</b>");
  });

  it("聊天模式下会话行不带任何项目痕迹", () => {
    G.MODE = "chat";
    G.PROJECTS_OK = true;
    const { container } = render(<ConvRow s={conv({ title: "x" })} />);

    expect(container.querySelector(".conv").hasAttribute("draggable")).toBe(false);
    expect(container.querySelector(".mv"), "聊天模式又长出了工作模式的 ⋯").toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  分组（原 ui.session.test.ts「侧栏」的后五条）
// ══════════════════════════════════════════════════════════════════
describe("分组", () => {
  it("工作模式下即使一个项目都没有，也要出分区结构和「新建项目」入口", () => {
    G.PROJECTS_OK = true;
    G.SESSION_LIST = [conv({ title: "会话" })];
    mountSidebar();

    expect(convs().querySelectorAll(".pjsec").length).toBe(2);
    expect(convs().querySelector(".pjcreate"), "空态没有能点的新建入口").not.toBeNull();
    expect(convs().textContent).toContain("项目");
    expect(convs().textContent).toContain("未归类");
    expect(rowTitles()).toEqual(["会话"]);
  });

  it("后端没有 /api/projects 时安静地退回平铺，一点项目痕迹都不留", () => {
    G.PROJECTS_OK = false;
    G.SESSION_LIST = [conv({ title: "会话" })];
    mountSidebar();

    expect(rowTitles()).toEqual(["会话"]);
    expect(convs().querySelector(".pjgroup")).toBeNull();
    expect(convs().textContent).not.toContain("未归类");
  });

  it("按项目分组，折叠起来的项目不渲染内容，计数照旧", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "甲项目" }, { id: "p2", name: "乙项目" }];
    G.SESSION_LIST = [
      conv({ id: "s1", title: "在甲", project_id: "p1" }),
      conv({ id: "s2", title: "在乙", project_id: "p2" }),
      conv({ id: "s3", title: "没归类" }),
    ];
    PJ_OFF.add("p2");
    mountSidebar();

    expect(rowTitles()).toEqual(["在甲", "没归类"]);   // p2 收起来了
    const groups = [...convs().querySelectorAll(".pjgroup")];
    expect(groups[1].querySelector(".pjhead").className, "收起来的那个没有 off").toBe("pjhead off");
    expect(groups[1].querySelector(".pjbody"), "收起来了还画内容").toBeNull();
    // 折起来之后仍然看得出里面有几条 —— 计数不跟着藏
    expect(groups[1].querySelector(".pjn").textContent).toBe("1");
  });

  it("project_id 指向一个看不见的项目时归「未归类」—— 会话不能凭空消失", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "甲项目" }];
    G.SESSION_LIST = [conv({ id: "s9", title: "孤儿会话", project_id: "已删掉的项目" })];
    mountSidebar();

    expect(rowTitles()).toEqual(["孤儿会话"]);
    // 它挂在**最后**那一组（未归类）的 .pjbody 里，不是浮在外面
    const groups = [...convs().querySelectorAll(".pjgroup")];
    expect(groups[groups.length - 1].querySelector(".pjname").textContent).toBe("未归类");
    expect(groups[groups.length - 1].querySelector(".pjbody .conv .t").textContent).toBe("孤儿会话");
  });

  it("「未归类」也能收起来 —— 一个收不起来的分区会把项目全顶出屏幕", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "甲项目" }];
    G.SESSION_LIST = [conv({ id: "s3", title: "没归类" })];
    PJ_OFF.add(UNFILED);
    mountSidebar();

    expect(rowTitles()).toEqual([]);
    expect(convs().textContent).toContain("未归类");     // 段本身还在，只是收起来了
  });
});

// ══════════════════════════════════════════════════════════════════
//  项目知识库入口：它属于工作模式的左侧导航，不属于右侧项目上下文。
// ══════════════════════════════════════════════════════════════════
describe("项目知识库入口", () => {
  it("聊天模式和不支持项目的旧后端都不显示入口", () => {
    G.MODE = "chat";
    G.PROJECTS_OK = true;
    mountSidebar();
    expect(convs().querySelector(".side-knowledge-entry")).toBeNull();

    cleanup();
    shell();
    G.MODE = "work";
    G.PROJECTS_OK = false;
    mountSidebar();
    expect(convs().querySelector(".side-knowledge-entry")).toBeNull();
  });

  it("工作模式显示入口，但未打开项目会话时不可用", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "采购项目" }];
    G.S = { id: "s0" };
    mountSidebar();

    const entry = convs().querySelector(".side-knowledge-entry") as HTMLButtonElement;
    expect(entry).not.toBeNull();
    expect(entry.hasAttribute("disabled")).toBe(true);
    expect(entry.textContent).toContain("请先选择项目会话");
  });

  it("入口位于项目列表之前，点击后打开独立主页面并写入可恢复的 hash", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "采购项目" }];
    G.S = { id: "s1", project_id: "p1" };
    G.SESSION_LIST = [conv({ project_id: "p1" })];
    mountSidebar();

    const entry = convs().querySelector(".side-knowledge-entry") as HTMLButtonElement;
    expect(entry.hasAttribute("disabled")).toBe(false);
    expect(convs().firstElementChild).toBe(entry);
    fireEvent.click(entry);

    expect(G.MAIN_PAGE).toBe("knowledge");
    expect(window.location.hash).toBe("#knowledge");
    expect(entry.classList.contains("on")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  会话行：删除与改名处理器（原 ui.contracts.escaping.test.ts 那 4 条）
//
//  旧表述：拼进 onclick 的字符串字面量劈不开（earg = eattr ∘ ejs）。
//  新表述：**根本没有内联处理器了** —— 断言渲染结果里一个 on* 属性都没有，
//          且处理器收到的是原样的值。这才是那 4 条真正要保的东西。
// ══════════════════════════════════════════════════════════════════
describe("会话行：删除与改名处理器", () => {
  it("标题里一个撇号（「客户'A'的项目」）弄不坏删除按钮", () => {
    const { container } = render(<ConvRow s={conv({ title: `客户'A'的项目`, files: 2 })} />);
    fireEvent.click(container.querySelector(".del"));
    expect(dropSession).toHaveBeenCalledWith("s1", `客户'A'的项目`);
    // 良性的撇号原样显示 —— 界面上不该冒出 &#39;
    expect(container.innerHTML).not.toContain("&#39;");
  });

  it("敌意标题：注入不执行，处理器收到的仍是原样字符串", () => {
    const { container } = render(<ConvRow s={conv({ title: EVIL_JS })} />);
    expect(container.innerHTML, "渲染结果里还有内联处理器属性").not.toMatch(/\son[a-z]+=/);
    fireEvent.click(container.querySelector(".del"));
    expect(dropSession).toHaveBeenCalledWith("s1", EVIL_JS);
    expect(g.__pwned).toBeUndefined();
  });

  it("敌意会话 id 也劈不开双击改名", () => {
    const { container } = render(<ConvRow s={conv({ id: EVIL_JS, title: "正常标题" })} />);
    fireEvent.doubleClick(container.querySelector(".t"));
    expect(renameSession).toHaveBeenCalledWith(EVIL_JS);
    expect(g.__pwned).toBeUndefined();
  });

  it("标题落在文本位置时，标签就是字，不是元素", () => {
    const { container } = render(<ConvRow s={conv({ title: EVIL_TAG })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".t").textContent).toBe(EVIL_TAG);
  });
});
