// @vitest-environment happy-dom
/**
 * 侧栏项目文件夹的契约（从 tests/test_ui_project_sidebar.py 移过来）。
 *
 * 原来那份是把 index.html 里的内联 JS 用文本锚点切出来喂给 node 跑的；上一轮改成直接
 * import ts/src/ui/{projects,sessions,i18n}.ts。**这一轮侧栏换成了 React 组件**
 * （react/sidebar.tsx），所以断言的对象从「paintSessions() 拼出来的那串 HTML」换成
 * 「画出来的那棵 DOM」，判据一条没改，还是这六件事：
 *
 *   · R5：聊天模式的侧栏一点项目痕迹都不能有（执行点在 loadProjects，不是散在画的地方）
 *   · 渐进部署：后端还没有 /api/projects 时安静退回平铺，不弹错、不白屏
 *   · 分组本身：项目段在前、未归类垫底、指向未知项目的会话不许凭空消失
 *   · 折叠是纯重画（不发请求），且折起来之后还看得出里面有几条
 *   · 项目名是自由文本：以前它拼进 innerHTML，id 走 earg、名字走 esc，用错一层就是
 *     可执行的 XSS；现在 JSX 把这两条路都封死了，于是断言换成**结果**——
 *     标记渲染成文本、id 原样送到 toggleProject、整棵子树上一个 on* 属性都没有。
 *   · 文案：project.* 两本字典都要有；删除确认必须把两种后果分开说清
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, createEvent, fireEvent } from "@testing-library/react";

import { $, at, convs, inlineHandlers, mountSidebar, rowTitles, shell } from "./ui.react.env.js";

import { G, PJ_OFF, UNFILED } from "../src/ui/state.js";
import { paintSessions } from "../src/ui/sessions.js";
import { loadProjects, newSessionIn, sessionMenu, syncProjectChrome } from "../src/ui/projects.js";
import { I18N } from "../src/ui/i18n.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const g = globalThis as any;

/** 一个只会记账、永远不回内容的 fetch —— 用来钉「这条路上不许有网络请求」。 */
function forbidFetch(): { n: number } {
  const seen = { n: 0 };
  g.fetch = () => { seen.n++; throw new Error("这条路上不该发请求"); };
  return seen;
}

type Call = { url: string; method: string; body: any };

/** 记账 + 按 url 回内容的 fetch。routes 命不中就回 {}。 */
function routeFetch(routes: (u: string, m: string) => any): Call[] {
  const calls: Call[] = [];
  g.fetch = async (u: string, o: any = {}) => {
    const method = (o && o.method) || "GET";
    calls.push({ url: u, method, body: o && o.body ? JSON.parse(o.body) : undefined });
    const data = routes(u, method) ?? {};
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return calls;
}

/** 侧栏重画一次。生产里 paintSessions() 就是这么被调的（折叠、切语言、拉完列表）。 */
const repaint = (): void => { act(() => { paintSessions(); }); };

/** 拖拽事件要带 dataTransfer，否则被测函数第一句就炸。 */
const dt = (sid = ""): any => ({
  effectAllowed: "", dropEffect: "", setData() {}, getData: () => sid,
});

beforeEach(() => {
  shell();
  G.S = null;
  G.MODE = "work";
  G.LANG = "zh";
  G.PROJECTS = [];
  G.PROJECTS_OK = false;
  G.SESSION_LIST = [];
  G.DRAG_SID = null;
  PJ_OFF.clear();
  g.fetch = async () => { throw new Error("test: fetch not stubbed"); };
  g.prompt = () => null;
  g.alert = () => {};
  g.confirm = () => false;
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  R5：聊天模式完全不进项目
// ══════════════════════════════════════════════════════════════════
describe("R5 聊天模式", () => {
  // python: test_chat_mode_never_shows_a_project_anywhere_in_the_sidebar
  it("聊天模式的侧栏是平铺的，连一次 /api/projects 都不发", async () => {
    G.MODE = "chat";
    G.PROJECTS = [{ id: "p1", name: "客户A" }];       // 上一轮工作模式留下的残留
    G.PROJECTS_OK = true;
    G.SESSION_LIST = [{ id: "s1", title: "闲聊", project_id: "p1", files: 0, status: "ready" }];
    const seen = forbidFetch();
    mountSidebar();

    await loadProjects();          // 执行点在这儿：不是 work 就清空返回
    repaint();

    expect(G.PROJECTS).toEqual([]);
    expect(seen.n).toBe(0);                            // 聊天模式还是发了 /api/projects
    expect($("pjnewBtn").hidden).toBe(true);
    const html = convs().innerHTML;
    for (const trace of ["pjgroup", "pjhead", "pjsec", "未归类", "客户A"]) {
      expect(html, `聊天模式侧栏里出现了 ${trace}`).not.toContain(trace);
    }
    expect(convs().querySelector(".mv"), "聊天模式的会话行上长出了「移到项目」").toBeNull();
    expect(rowTitles()).toEqual(["闲聊"]);             // 会话本身还是要在的
  });
});

// ══════════════════════════════════════════════════════════════════
//  渐进部署：后端还没有 /api/projects 时不许白屏、不许弹错
// ══════════════════════════════════════════════════════════════════
describe("后端还没有 /api/projects", () => {
  // python: test_a_backend_without_projects_degrades_to_todays_flat_list
  it("404 是「没有项目」不是「出错了」：退回平铺，会话列表照旧", async () => {
    G.PROJECTS_OK = true;          // 先假装支持，看 404 之后有没有翻回去
    G.SESSION_LIST = [{ id: "s1", title: "会话一", project_id: "", files: 2, status: "done" }];
    // 不走 j()：j() 对非 2xx 直接抛，401 还会弹登录框 —— 对一个旧后端那两件事都是错的反应
    g.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    mountSidebar();

    await loadProjects();
    repaint();

    expect(G.PROJECTS_OK).toBe(false);
    expect(G.PROJECTS).toEqual([]);
    expect($("pjnewBtn").hidden, "后端不支持时还露着「新建项目」").toBe(true);
    expect(convs().querySelector(".pjgroup")).toBeNull();
    expect(rowTitles(), "退化后会话列表还得在，不能白屏").toEqual(["会话一"]);
  });

  // python: test_load_projects_swallows_the_failure_instead_of_raising
  it("网络直接断也一样：安静退回平铺，不往外抛", async () => {
    G.PROJECTS_OK = true;
    g.fetch = async () => { throw new Error("boom"); };

    await expect(loadProjects()).resolves.toBeUndefined();

    expect(G.PROJECTS_OK).toBe(false);
    expect(G.PROJECTS).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  分组本身
// ══════════════════════════════════════════════════════════════════
describe("分组", () => {
  // python: test_sessions_are_grouped_under_their_project_with_unfiled_last
  it("会话挂在自己项目下，未归类垫底", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "客户A" }, { id: "p2", name: "客户B" }];
    G.SESSION_LIST = [
      { id: "s1", title: "甲", project_id: "p1", files: 1, status: "done" },
      { id: "s2", title: "乙", project_id: "p2", files: 1, status: "done" },
      { id: "s3", title: "丙", project_id: "", files: 1, status: "done" },
    ];
    mountSidebar();

    expect(at("客户A")).toBeLessThan(at("甲"));
    expect(at("甲")).toBeLessThan(at("客户B"));
    expect(at("客户B")).toBeLessThan(at("乙"));
    expect(at("乙")).toBeLessThan(at("未归类"));
    expect(at("未归类"), "未归类段必须在最后").toBeLessThan(at("丙"));
    // 层级也要对：每条会话都住在自己那组的 .pjbody 里，不是平铺在外面
    const groups = [...convs().querySelectorAll(".pjgroup")];
    expect(groups.map((x: any) => x.querySelector(".pjname").textContent))
      .toEqual(["客户A", "客户B", "未归类"]);
    expect(groups.map((x: any) => x.querySelector(".pjbody .conv .t").textContent))
      .toEqual(["甲", "乙", "丙"]);
  });

  // python: test_a_session_pointing_at_an_unknown_project_falls_back_to_unfiled
  it("指向一个看不见的项目时落进未归类 —— 会话不能凭空消失", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "客户A" }];
    G.SESSION_LIST = [{ id: "s9", title: "孤儿会话", project_id: "不存在的项目", files: 0, status: "done" }];
    mountSidebar();

    expect(rowTitles()).toEqual(["孤儿会话"]);
    expect(at("未归类")).toBeLessThan(at("孤儿会话"));
  });

  // python: test_collapsing_a_project_hides_its_sessions_but_keeps_the_count
  it("折叠是纯重画：不发请求，藏内容但留计数", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "客户A" }];
    G.SESSION_LIST = [{ id: "s1", title: "甲", project_id: "p1", files: 1, status: "done" }];
    mountSidebar();
    const seen = forbidFetch();

    // 点的是项目那一行本身 —— 展开/折叠没有单独的把手，整条 .pjhead 都可点
    fireEvent.click(convs().querySelector(".pjhead"));

    expect([...PJ_OFF]).toEqual(["p1"]);
    expect(seen.n, "折叠不该发请求").toBe(0);
    expect(rowTitles()).toEqual([]);
    expect(convs().textContent).toContain("客户A");
    expect(convs().querySelector(".pjhead").className).toBe("pjhead off");
    expect(convs().querySelector(".pjn").textContent, "折叠后看不出里面有几条").toBe("1");
    // 再点一次要能展开回来（折叠是**双向**的，PJ_OFF 记的是「收起了哪些」）
    fireEvent.click(convs().querySelector(".pjhead"));
    expect(rowTitles()).toEqual(["甲"]);
  });

  // python: test_work_mode_shows_the_project_section_even_with_no_projects
  it("零项目也要出分区结构和能点的新建入口，平铺只发生在两种情况", async () => {
    G.PROJECTS_OK = true;
    G.SESSION_LIST = [{ id: "s1", title: "会话一", files: 0, status: "done" }];
    mountSidebar();

    expect(convs().textContent).toContain(I18N["zh"]!["project.section"]!);
    expect(convs().textContent).toContain(I18N["zh"]!["project.createFirst"]!);
    expect(convs().textContent).toContain("未归类");
    expect(rowTitles()).toEqual(["会话一"]);

    // 空态必须是个**能点的东西**，不是一行灰字：点下去真的开始建项目
    const calls = routeFetch((u, m) => {
      if (u === "/api/projects" && m === "POST") return { id: "p9", name: "第一个项目" };
      if (u === "/api/projects") return { projects: [] };
      if (u === "/api/sessions") return [];
      return {};
    });
    g.prompt = () => "第一个项目";
    const btn = convs().querySelector("button.pjcreate");
    expect(btn, "空态入口不在").not.toBeNull();
    await act(async () => { fireEvent.click(btn); });
    expect(calls.find(c => c.url === "/api/projects" && c.method === "POST")?.body)
      .toEqual({ name: "第一个项目" });

    // 平铺只允许发生在：聊天模式、或后端没有 /api/projects
    G.MODE = "chat";
    repaint();
    expect(convs().querySelector(".pjsec")).toBeNull();
    G.MODE = "work"; G.PROJECTS_OK = false;
    repaint();
    expect(convs().querySelector(".pjsec")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  XSS：项目名是自由文本
//
//  旧表述：这一行拼进 innerHTML，id 走 earg、名字走 esc，用错一层就是可执行的 XSS。
//  新表述：那条拼串的路已经没有了（JSX 转义文本节点，事件参数是值）。所以断的是
//          **结果**：标记渲染成文本、id 原样送到 toggleProject、没有 on* 属性。
// ══════════════════════════════════════════════════════════════════
describe("恶意项目名", () => {
  // python: test_a_hostile_project_name_cannot_break_out_of_the_row
  it("名字渲染成文本、id 原样送到处理器 —— 两条路都封死", () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p'1", name: "<img src=x onerror=alert(1)>" }];
    G.SESSION_LIST = [];
    mountSidebar();

    expect(convs().querySelector("img"), "项目名带的标签变成了元素").toBeNull();
    expect(convs().querySelector(".pjname").textContent).toBe("<img src=x onerror=alert(1)>");
    // 注意不能拿 innerHTML 去 match /\son[a-z]+=/：被正确转义成文本的那串里也有
    // " onerror=" 这个形状。要看的是**属性名集合**。
    expect(inlineHandlers(convs()), "渲染结果里还有内联处理器属性").toEqual([]);

    // 那个撇号原来是最容易劈开字符串字面量的地方；现在它只是一个普通字符，
    // 点一下折叠，PJ_OFF 里记下的必须是**原样**的 id。
    fireEvent.click(convs().querySelector(".pjhead"));
    expect([...PJ_OFF]).toEqual(["p'1"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  文案
// ══════════════════════════════════════════════════════════════════
describe("文案", () => {
  // python: test_project_keys_exist_in_both_dictionaries
  it("project.* 两本字典都有（缺 key 会静默回落到中文）", () => {
    for (const key of ["project.new", "project.namePrompt", "project.rename",
      "project.renamePrompt", "project.delete", "project.confirmDelete",
      "project.unfiled", "project.noUnfiled", "project.empty",
      "project.moveTo", "project.moveOut", "project.none", "project.failed"]) {
      expect(I18N["zh"]!, `zh 少了 ${key}`).toHaveProperty(key);
      expect(I18N["en"]!, `en 少了 ${key}`).toHaveProperty(key);
    }
  });

  // python: test_the_new_empty_state_keys_exist_in_both_dictionaries
  it("空态那两个 key 两本字典都有", () => {
    for (const key of ["project.section", "project.createFirst"]) {
      expect(I18N["zh"]!, `zh 少了 ${key}`).toHaveProperty(key);
      expect(I18N["en"]!, `en 少了 ${key}`).toHaveProperty(key);
    }
  });

  // python: test_deleting_a_project_spells_out_both_consequences
  it("删除确认把两种后果分开说清：会话不会没、项目记忆会没", () => {
    const zh = I18N["zh"]!["project.confirmDelete"]!;
    expect(zh, "没说清会话会掉回未归类").toContain("未归类");
    expect(zh).toContain("不会被删除");
    expect(zh, "没说清项目记忆会一起删掉").toContain("记忆");
    expect(zh).toContain("不可恢复");
    const en = I18N["en"]!["project.confirmDelete"]!;
    expect(en).toContain("Unfiled");
    expect(en).toContain("not deleted");
    expect(en).toContain("memory");
    expect(en).toContain("cannot be recovered");
  });
});

// ══════════════════════════════════════════════════════════════════
//  在项目里直接开新会话
// ══════════════════════════════════════════════════════════════════
describe("项目上的 ＋", () => {
  // python: test_a_project_can_start_its_own_session
  it("等价于「新建会话 + 移进去」，不该让用户建完再自己搬一次", async () => {
    G.PROJECTS_OK = true;
    const calls = routeFetch((u, m) => {
      if (u === "/api/projects") return { projects: [{ id: "p1", name: "客户A" }] };
      if (u === "/api/sessions" && m === "POST") return { id: "new1", title: "新会话", mode: "work" };
      if (u === "/api/sessions") return [];
      if (/^\/api\/sessions\/[^/]+\/state$/.test(u)) return { prompts: [], filelist: [] };
      return {};
    });

    await newSessionIn("p1");

    const created = calls.findIndex(c => c.url === "/api/sessions" && c.method === "POST");
    const moved = calls.findIndex(c => c.method === "PATCH" && c.body && "project_id" in c.body);
    expect(created, "没有新建会话").toBeGreaterThan(-1);
    expect(moved, "建完没有搬进项目").toBeGreaterThan(created);
    expect(calls[moved]!.url).toBe("/api/sessions/new1");
    expect(calls[moved]!.body.project_id).toBe("p1");
  });

  // 那颗 ＋ 真的接在这条路上（原来断的是 onclick 里的函数名）
  it("项目那一行上的 ＋ 接的就是它，且不会顺带把项目折叠掉", async () => {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "客户A" }];
    G.SESSION_LIST = [];
    mountSidebar();
    const calls = routeFetch((u, m) => {
      if (u === "/api/projects") return { projects: [{ id: "p1", name: "客户A" }] };
      if (u === "/api/sessions" && m === "POST") return { id: "new1", title: "新会话", mode: "work" };
      if (u === "/api/sessions") return [];
      if (/^\/api\/sessions\/[^/]+\/state$/.test(u)) return { prompts: [], filelist: [] };
      return {};
    });

    await act(async () => { fireEvent.click(convs().querySelector(".pjadd")); });

    expect(calls.some(c => c.url === "/api/sessions" && c.method === "POST")).toBe(true);
    expect([...PJ_OFF], "点 ＋ 顺带把项目折叠了").toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  拖拽归类
// ══════════════════════════════════════════════════════════════════
describe("拖拽归类", () => {
  function withOneProject(): void {
    G.PROJECTS_OK = true;
    G.PROJECTS = [{ id: "p1", name: "客户A" }];
    G.SESSION_LIST = [{ id: "s1", title: "甲", status: "done", files: 0 }];
    mountSidebar();
  }

  /** drop 之后会 moveSession → loadSessions → **整块重画**；项目得还在，
   *  否则第二次放置就没有目标了（而那正是要测的东西）。 */
  const backend = (): Call[] => routeFetch((u) => {
    if (u === "/api/projects") return { projects: [{ id: "p1", name: "客户A" }] };
    if (u === "/api/sessions") return [];
    return {};
  });

  // python: test_a_session_can_be_dragged_into_a_project
  it("会话行可拖，项目段与未归类段都是放置目标", async () => {
    withOneProject();
    const calls = backend();

    const row = convs().querySelector(".conv");
    expect(row.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(row, { dataTransfer: dt() });
    expect(G.DRAG_SID, "拖起来之后没人知道拖的是哪条").toBe("s1");
    expect(row.classList.contains("dragging")).toBe(true);

    // 放置目标每次都重新取：drop 之后 loadSessions() 会让侧栏整块重画，
    // 手里那个节点已经从文档上摘下来了。
    const heads = (): any[] => [...convs().querySelectorAll(".pjhead")];
    expect(heads()).toHaveLength(2);                  // 项目 + 未归类
    await act(async () => { fireEvent.drop(heads()[0], { dataTransfer: dt("s1") }); });
    expect(calls.find(c => c.method === "PATCH")?.body).toEqual({ project_id: "p1" });

    // 「未归类」也必须能放：只进不出的文件夹是个陷阱
    calls.length = 0;
    G.DRAG_SID = "s1";
    await act(async () => { fireEvent.drop(heads()[1], { dataTransfer: dt("s1") }); });
    expect(calls.find(c => c.method === "PATCH")?.body).toEqual({ project_id: null });
  });

  // python: test_a_session_can_be_dragged_into_a_project（preventDefault 那一半）
  it("dragOver/drop 都 preventDefault —— 不然拖拽「看着做了其实没生效」", async () => {
    withOneProject();
    backend();
    const head = convs().querySelector(".pjhead");

    G.DRAG_SID = null;
    const idle = createEvent.dragOver(head, { dataTransfer: dt() });
    fireEvent(head, idle);
    expect(idle.defaultPrevented, "没在拖会话时不该抢（那是上传文件的活）").toBe(false);

    G.DRAG_SID = "s1";
    const over = createEvent.dragOver(head, { dataTransfer: dt() });
    fireEvent(head, over);
    expect(over.defaultPrevented).toBe(true);
    expect(head.classList.contains("dragover"), "拖到头上没有高亮").toBe(true);
    // 离开就撤掉高亮 —— 不撤的话侧栏会留下一排「都能放」的假象
    fireEvent.dragLeave(head, { dataTransfer: dt() });
    expect(head.classList.contains("dragover")).toBe(false);

    for (const i of [0, 1]) {
      G.DRAG_SID = "s1";
      const target = [...convs().querySelectorAll(".pjhead")][i];
      const drop = createEvent.drop(target, { dataTransfer: dt("s1") });
      await act(async () => { fireEvent(target, drop); });
      expect(drop.defaultPrevented).toBe(true);
    }
  });

  // python: test_the_menu_path_survives_alongside_drag
  it("菜单那条路还在 —— 键盘/触屏/读屏拖不动一个 div", () => {
    expect(typeof sessionMenu).toBe("function");
    withOneProject();
    const mv = convs().querySelector(".conv .mv");
    expect(mv, "会话行上没有「移到项目」那颗 ⋯").not.toBeNull();

    fireEvent.click(mv);
    const menu = $("popMenu");
    expect(menu.hidden, "点了 ⋯ 菜单没出来").toBe(false);
    expect(menu.textContent).toContain("客户A");        // 能移进哪个项目，说得出名字
  });

  // python: test_the_drop_target_is_visible_while_dragging
  it("拖动时看得出会掉进哪儿（样式在 index.html 里，逐字节未变）", () => {
    const css = readFileSync(resolve(ROOT, "ui", "index.html"), "utf8");
    expect(css).toContain(".pjhead.dragover");
    expect(css).toContain(".conv.dragging");
  });

  // python: test_the_empty_state_entry_is_a_button_not_a_caption
  it("空态入口是个按钮不是一行说明文字", () => {
    expect(readFileSync(resolve(ROOT, "ui", "index.html"), "utf8")).toContain(".pjcreate{");
    G.PROJECTS_OK = true; G.PROJECTS = []; G.SESSION_LIST = [];
    mountSidebar();
    const btn = convs().querySelector(".pjcreate");
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe("BUTTON");
  });
});

// 「未归类」的收展 key 与真项目 id 撞不上：见 ui.session.test.ts
// 「未归类也能收起来」：见 ui.sidebar.test.tsx
void UNFILED;
void syncProjectChrome;
