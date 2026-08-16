// @vitest-environment happy-dom
/**
 * 会话改名（手动 + 自动命名回显）的前端契约 —— 从 `tests/test_ui_session_rename.py`
 * 逐条移过来。
 *
 * 原来那份是把 `ui/index.html` 的内联 JS 按文本锚点切出来喂给 Node 跑的；前端有了
 * 打包步骤之后锚点不复存在，所以改成直接 import 被测模块。**这一轮侧栏换成了 React
 * 组件**（react/sidebar.tsx），于是「侧栏改没改」这件事的观测方式跟着换：
 *
 *   旧：paintSessions() 往 `$("convs")` 写了几次 innerHTML；
 *   新：uiStore 被 bump 了几次（那是现在唯一的「重画一次」信号），
 *       外加**直接读那棵画出来的 DOM**里的标题 —— 后者比数次数更硬。
 *
 * 判据一条没动。被钉住的三件事，每一件都对应一个具体的坏结果：
 *   1. 改名失败时**本地一个字都不改** —— 先变成新名字、刷新又变回去，比直接
 *      说"没改成"更让人困惑。
 *   2. 改完就地更新侧栏 + 顶栏 <h2> —— 自动命名是后台发生的，等下次刷新才改名
 *      等于没改。
 *   3. 双击那条路在**每种模式**都在 —— 聊天模式下 ⋯ 按钮根本不存在（R5）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";

import { $, FakeEventSource, convs, inlineHandlers, mountSidebar, shell } from "./ui.react.env.js";

import { G, SESSION_TITLE_MAX } from "../src/ui/state.js";
import { applySessionTitle, renameSession } from "../src/ui/sessions.js";
import { evLabel } from "../src/ui/events.js";
import { connect } from "../src/ui/sse.js";
import { I18N, t } from "../src/ui/i18n.js";
import { uiStore } from "../src/ui/react/store.js";
import { DEFAULT_TITLES } from "../src/server/routes/sessions.js";

const g = globalThis as any;

// ── 替身：网络 / prompt / alert / 侧栏重画次数 ──────────────────────
type Call = { url: string; method?: string; body: any };
let calls: Call[] = [];
let alerts: string[] = [];
let promptReply: string | null = null;
let patchFails = false;
let reply: any = {};
/** 侧栏重画次数。paintSessions() 现在的可观察副作用就是 bump 一次 store。 */
let paints = 0;
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  shell();
  calls = []; alerts = []; promptReply = null; patchFails = false; reply = {}; paints = 0;
  G.LANG = "zh";
  G.MODE = "work";
  G.PROJECTS = [];
  G.PROJECTS_OK = false;          // 平铺渲染：一条会话行，改名之后直接读它
  G.SESSION_LIST = [{ id: "s1", title: "新会话", status: "ready", files: 0 }];
  G.S = { id: "s1", title: "新会话", mode: "work", status: "ready", files: 0, state: {}, events: [] };
  $("title").textContent = "新会话";

  g.fetch = async (url: string, o: any) => {
    calls.push({ url, method: o?.method, body: o?.body ? JSON.parse(o.body) : null });
    if (patchFails) return { ok: false, status: 400, text: async () => "400 改标题还没接上" };
    return { ok: true, status: 200, json: async () => reply };
  };
  g.prompt = () => promptReply;
  g.alert = (m: unknown) => { alerts.push(String(m)); };
  g.confirm = () => false;

  mountSidebar();
  // 挂完再开始数：render 那一次不算重画。
  unsubscribe = uiStore.subscribe(() => { paints++; });
});
afterEach(() => { unsubscribe?.(); unsubscribe = null; cleanup(); });

/** 侧栏那一行现在显示的标题（读的是真 DOM，不是 G）。 */
const row = () => convs().querySelector(".conv .t")?.textContent;
const head = () => $("title").textContent;

// ══════════════════════════════════════════════════════════════════
//  renameSession / applySessionTitle 的真实行为
// ══════════════════════════════════════════════════════════════════
describe("renameSession", () => {
  it("改名把 PATCH 发出去，并更新标题露面的每一处", async () => {
    // 标题同时出现在侧栏行、顶栏 <h2>、和内存里那个当前会话对象。漏掉任何一处，
    // 用户看到的就是"改了一半"——最常见的是顶栏还挂着「新会话」。
    promptReply = "采购计划管理实体";
    await act(async () => { await renameSession("s1"); });

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("/api/sessions/s1");
    expect(calls[0]!.body).toEqual({ title: "采购计划管理实体" });
    expect(row(), "侧栏那一行没跟着改").toBe("采购计划管理实体");
    expect(G.S.title).toBe("采购计划管理实体");
    expect(head()).toBe("采购计划管理实体");   // 顶栏标题没跟着改
    expect(paints).toBe(1);
    expect(alerts).toEqual([]);
  });

  it("后端还在拒绝改标题时，本地一个字都不改", async () => {
    // 前端可以先于后端上线：那条 PATCH 现在对 title 就是 400。这时候唯一正确的
    // 反应是**什么都不改**并说一声。乐观更新在这里是有害的 —— 名字会先变、下次
    // 刷新又变回去，用户以为是自己点错了。
    patchFails = true;
    promptReply = "新名字";
    await act(async () => { await renameSession("s1"); });

    expect(row()).toBe("新会话");
    expect(G.S.title).toBe("新会话");
    expect(head()).toBe("新会话");
    expect(paints).toBe(0);                    // 失败了还重画 = 本地已经改过了
    expect(alerts).toEqual([t("session.renameFailed")]);
    expect(alerts[0]).toBe("没能改名，稍后再试");
  });

  it("取消 / 清空 / 原样确认都不发请求", async () => {
    // 原样确认尤其要挡：它会把标题写进服务端，于是"用户手动改过"这个状态被点亮，
    // 此后再也不会自动命名 —— 而用户其实只是打开看了看就按了确定。
    for (const typed of [null, "   ", "新会话", "  新会话  "]) {
      calls = []; paints = 0;
      promptReply = typed;
      await act(async () => { await renameSession("s1"); });
      expect(calls, String(typed)).toEqual([]);
      expect(paints, String(typed)).toBe(0);
    }
  });

  it("服务端存下的标题压过输入的那个", async () => {
    // 服务端会再规范化一次（折空白、去首尾），PATCH 回的 brief 里是**存下的**那个。
    // 照着本地那份贴，界面上就会出现一个服务端并没有存下的样子，下次刷新又变。
    reply = { id: "s1", title: "服务端规范化过的名字" };
    promptReply = "我 敲 的";
    await act(async () => { await renameSession("s1"); });

    expect(row()).toBe("服务端规范化过的名字");
    expect(head()).toBe("服务端规范化过的名字");
  });

  it("空白折叠得和服务端一模一样", async () => {
    // 标题里的换行会把侧栏那一行撑成两行，而它在标题里没有任何意义。
    promptReply = "  采购计划\n  管理  ";
    await act(async () => { await renameSession("s1"); });
    expect(calls[0]!.body).toEqual({ title: "采购计划 管理" });
  });

  it("超长标题先裁再发", async () => {
    // 服务端要挡超长；在这里先截断，用户当场就看得到"最后叫什么"，而不是提交完
    // 被一个 400 顶回来、名字还是旧的。
    promptReply = "长".repeat(400);
    await act(async () => { await renameSession("s1"); });

    expect(calls[0]!.body.title.length).toBe(120);
    expect(SESSION_TITLE_MAX).toBe(120);
    expect(row()).toBe("长".repeat(120));
  });
});

describe("applySessionTitle（自动命名回显）", () => {
  it("自动命名就地落地，不再跑一次网络", () => {
    // 自动命名由服务端在上传/回答之后做，前端只收到一条事件。applySessionTitle
    // 必须能独立把它贴上去（不重新拉一次会话列表）—— 否则侧栏要等到下次刷新才改名。
    act(() => { applySessionTitle("s1", "采购计划管理-v2"); });

    expect(calls).toEqual([]);               // 回显不该再发一次网络请求
    expect(row()).toBe("采购计划管理-v2");
    expect(head()).toBe("采购计划管理-v2");
    expect(paints).toBe(1);
  });

  it("改别的会话永远不动顶栏", () => {
    // 顶栏那个 <h2> 只代表**当前**会话。自动命名可能发生在任意一条会话上
    // （多 worker、多标签页），把别人的名字贴到顶栏是一个看起来像"会话被切走了"
    // 的假象。
    G.SESSION_LIST.push({ id: "s2", title: "新会话", status: "ready", files: 0 });
    act(() => { applySessionTitle("s2", "另一条"); });

    expect(G.SESSION_LIST[1].title).toBe("另一条");
    expect(head()).toBe("新会话");
    expect(G.S.title).toBe("新会话");
  });

  it("名字没变就不重画侧栏", () => {
    // 重连时 since=0 会把全部事件原样重放一遍（包括那条改名）。每重连一次就重画
    // 一次侧栏 = 每次网络抖动列表闪一下，还会打断正在进行的拖拽。
    act(() => { applySessionTitle("s1", "新会话"); });
    expect(paints).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  入口：双击（每种模式都在）+ 工作模式 ⋯ 菜单里的一项
// ══════════════════════════════════════════════════════════════════
describe("改名入口", () => {
  it("聊天模式没有 ⋯ 菜单，但双击那条路还在", async () => {
    // R5 不许聊天模式的侧栏出现任何项目痕迹，那颗 ⋯ 按钮也就不在。而
    // 「每个会话都叫新对话」在聊天模式里一样成立 —— 所以入口选的是双击标题：
    // 它是唯一一条两种模式都走得通的路。
    G.MODE = "chat";
    G.PROJECTS_OK = false;
    G.SESSION_LIST = [{ id: "s1", title: "新对话", status: "ready", files: 0 }];
    act(() => { uiStore.bump(); });

    expect(convs().querySelector(".mv"), "聊天模式又长出了工作模式的 ⋯").toBeNull();

    promptReply = "双击改的名字";
    await act(async () => { fireEvent.doubleClick(convs().querySelector(".conv .t")); });
    expect(calls.map(c => c.url)).toEqual(["/api/sessions/s1"]);
    expect(row()).toBe("双击改的名字");
  });

  it("恶意会话 id 冲不出双击改名这条路", async () => {
    // 旧世界里会话 id 是拼进一个内联处理器的字符串字面量的，所以那条测试按浏览器
    // 的真实顺序验：解码属性 → 当 JS 编译。**现在那条路整个没有了** —— 参数是值，
    // 从组件直接进函数。所以判据换成：渲染结果里一个 on* 属性都没有，处理器收到的
    // 是原样的 id（它出现在请求 URL 里），页面上什么都没被执行。
    const evil = "x','');globalThis.__pwned=1;//";
    delete g.__pwned;
    G.SESSION_LIST = [{ id: evil, title: "无所谓", status: "ready", files: 0 }];
    act(() => { uiStore.bump(); });

    expect(inlineHandlers(convs()), "会话行上还有内联处理器属性").toEqual([]);

    promptReply = "改成这个";
    await act(async () => { fireEvent.doubleClick(convs().querySelector(".conv .t")); });

    expect(g.__pwned).toBeUndefined();
    expect(calls.map(c => c.url)).toEqual([`/api/sessions/${encodeURIComponent(evil)}`]);
  });

  it("菜单在的地方，菜单里就有「重命名」", async () => {
    // 双击这个手势界面上没有可见提示，菜单负责让人发现它。
    G.PROJECTS_OK = true;                       // ⋯ 只在工作模式 + 后端支持时出现
    act(() => { uiStore.bump(); });
    fireEvent.click(convs().querySelector(".conv .mv"));

    const menu = $("popMenu");
    expect(menu.hidden, "点了 ⋯ 菜单没出来").toBe(false);
    const first = menu.children[0];
    expect(first.textContent).toBe(t("session.rename"));
    expect(first.textContent).toBe("重命名");
    // 点它真的走到 renameSession（不是只长得像）
    promptReply = "菜单改的名字";
    await act(async () => { first.click(); });
    expect(calls.map(c => c.url)).toEqual(["/api/sessions/s1"]);
    expect(calls[0]!.body).toEqual({ title: "菜单改的名字" });
  });

  it("会话行上有一条「可以改名」的悬浮提示", () => {
    expect(convs().querySelector(".conv .t").getAttribute("title"))
      .toBe(t("session.renameTip"));
    expect(convs().querySelector(".conv .t").getAttribute("title")).toBe("双击可以改名");

    G.LANG = "en";
    act(() => { uiStore.bump(); });
    expect(convs().querySelector(".conv .t").getAttribute("title"))
      .toBe("Double-click to rename");
  });
});

// ══════════════════════════════════════════════════════════════════
//  事件流：改名要即时反映，且不许在操作记录里露出原始 key
// ══════════════════════════════════════════════════════════════════
describe("事件流", () => {
  it("session.renamed 接在流上：带 id 认 id，不带就是当前这条", () => {
    // 服务端自动命名完发一条事件；不接的话侧栏要等下次刷新才改名。事件走当前
    // 会话那条流，缺 id 时说的就是当前这条。
    G.SESSION_LIST.push({ id: "s2", title: "另一条会话", status: "ready", files: 0 });
    connect();
    const es = FakeEventSource.last!;

    act(() => { es.send({ seq: 1, ts: 1, kind: "session.renamed", title: "自动起的名字" }); });
    expect(G.S.title).toBe("自动起的名字");
    expect(G.SESSION_LIST[0].title).toBe("自动起的名字");
    expect(row(), "侧栏没跟着事件改").toBe("自动起的名字");

    act(() => { es.send({ seq: 2, ts: 2, kind: "session.renamed", id: "s2", title: "别人的名字" }); });
    expect(G.SESSION_LIST[1].title).toBe("别人的名字");
    expect(G.S.title).toBe("自动起的名字");   // 顶栏那条不受影响
  });

  it("改名相关的事件都有中文标签，不露原始 key", () => {
    // 漏一条标签，操作记录里就直接冒出 `session.renamed` 这种原始 key。
    expect(evLabel("session.renamed")).toBe("会话改名");
    expect(evLabel("session.rename_failed")).toBe("自动命名失败");
    for (const k of ["session.renamed", "session.rename_failed"]) {
      expect(evLabel(k)).not.toContain(".");
      expect(evLabel(k)).not.toContain("_");
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  文案
// ══════════════════════════════════════════════════════════════════
describe("文案", () => {
  it("这个 UI 造出来的默认标题，正是服务端认的那批默认值", () => {
    // 自动命名只在"标题还是默认值"时接管，而**默认值是前端写死的**（newSession
    // 用 `session.newChat` / `session.newWork`）。两处一旦对不上，表现是完全静默的：
    // 会话照建，名字永远停在「新会话」，没有任何报错。
    const created: string[] = [];
    for (const lang of ["zh", "en"]) {
      for (const key of ["session.newChat", "session.newWork"]) {
        const value = I18N[lang]![key]!;
        expect(value, `${lang}.${key} 不存在`).toBeTruthy();
        created.push(value);
        expect(DEFAULT_TITLES.has(value), `${key}「${value}」不在服务端的默认标题集合里`)
          .toBe(true);
      }
    }
    // 只要 Python 服务端还在跑，它那张集合也得认这四个（迁移期两边并存）
    const py = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
      "src", "ontocopilot", "server.py");
    if (existsSync(py)) {
      const src = readFileSync(py, "utf-8");
      const i = src.indexOf("_DEFAULT_TITLES = frozenset({");
      if (i >= 0) {
        const block = src.slice(i, src.indexOf("})", i));
        for (const value of created) {
          expect(block.includes(`"${value}"`), `「${value}」不在 server.py 的默认标题集合里`)
            .toBe(true);
        }
      }
    }
  });

  it("改名用到的 key 中英两本字典都有", () => {
    // t() 缺 key 时**静默**回落到中文 —— 漏了 en 的表现是英文界面冒出中文，
    // 不报错、不红。
    for (const key of ["session.rename", "session.renamePrompt",
      "session.renameTip", "session.renameFailed"]) {
      expect(I18N["zh"]![key], `zh 少了 ${key}`).toBeTruthy();
      expect(I18N["en"]![key], `en 少了 ${key}`).toBeTruthy();
      expect(I18N["en"]![key]).not.toBe(I18N["zh"]![key]);
    }
  });
});
