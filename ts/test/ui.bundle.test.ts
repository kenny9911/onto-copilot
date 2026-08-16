/**
 * **打出来的那份 ui/index.html 真的跑得起来。**
 *
 * ui.build.test.ts 断的是「产物和源码一致、CSS 没动」—— 那三条对一份**加载即报错**
 * 的页面照样全绿。内联 JS 时代这个缺口还不算贵（那段代码就是从原件逐行搬来的）；
 * 打进一整个 react-dom 之后就不一样了：模块顶层多了几千行别人写的初始化代码，
 * 一次打包配置写错就是白屏，而所有静态检查都察觉不到。
 *
 * 所以这里把 index.html 里那段内联脚本原样丢进一个真 DOM 里执行一遍，喂它一套
 * 最小的后端响应，然后看界面有没有画出来。**脚本能跑完本身就是 React 装上了的证据**：
 * mountApp() 在顶层同步调用，react-dom 若加载失败，eval 这一句就抛了。
 *
 * （补一句实测：esbuild 在 platform:"browser" 下会自动把 process.env.NODE_ENV 替换成
 * "development"，所以「忘了 define」不会崩，只会悄悄多打 500 KB 的开发版进去 ——
 * 下面因此有一条专门盯 production 那半边。）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(resolve(ROOT, "ui", "index.html"), "utf8");

/** 取正文那段内联脚本（head 里还有一小块，所以从 </style> 之后开始找）。 */
function inlineScript(): string {
  const start = html.indexOf("<script>", html.indexOf("</style>"));
  const end = html.lastIndexOf("</script>");
  expect(start).toBeGreaterThan(0);
  return html.slice(start + "<script>".length, end);
}

/** 页面加载时会打的那几个接口。少一条就会在 init 里抛出未捕获的 rejection。 */
const ROUTES: Record<string, unknown> = {
  "/api/auth/status": { auth_enabled: false, bootstrap_needed: false, authenticated: true, user: null },
  "/api/health": { database: { ok: true, mode: "postgres" } },
  "/api/projects": { projects: [] },
  "/api/sessions": [],
  "/api/models": { models: [] },
};

async function boot(): Promise<{ w: any; errors: string[] }> {
  const js = inlineScript();
  const start = html.indexOf("<script>", html.indexOf("</style>"));
  const w: any = new Window({ url: "http://localhost/" });
  // body 用的是 index.html 里那份真结构（内联脚本之前的部分）。
  w.document.body.innerHTML = html.slice(html.indexOf("<body>") + "<body>".length, start);
  const errors: string[] = [];
  w.fetch = async (u: string) => {
    const path = String(u).split("?")[0]!;
    if (!(path in ROUTES)) { errors.push(`没有桩的接口：${path}`); }
    return {
      ok: true, status: 200,
      json: async () => ROUTES[path] ?? {},
      text: async () => JSON.stringify(ROUTES[path] ?? {}),
    };
  };
  try { w.eval(js); } catch (e) { errors.push(String(e)); }
  // init 是个异步 IIFE：等它把那几个 await 走完。
  await new Promise((r) => setTimeout(r, 100));
  return { w, errors };
}

describe("ui/index.html 这份产物", () => {
  it("内联脚本里没有剩下的 process.env —— 浏览器里没有那个对象", () => {
    expect(inlineScript()).not.toMatch(/\bprocess\s*\.\s*env\b/);
  });

  it("React 运行时确实打进去了", () => {
    expect(inlineScript()).toContain("createRoot");
  });

  it("打进去的是 **production** 那半边，不是带一整套开发期警告的 development 版", () => {
    // 这两句只存在于 react-dom 的 development 构建里。漏了 define 的话产物会从
    // 762 KB 涨到 1278 KB，而所有别的检查都不会响。
    const js = inlineScript();
    expect(js).not.toContain("Each child in a list should have a unique");
    expect(js).not.toContain("validateDOMNesting");
  });

  it("在真 DOM 里加载不抛错，界面画得出来", async () => {
    const { w, errors } = await boot();
    expect(errors).toEqual([]);
    // 内联处理器要用的名字挂上了（globals.ts）——「按钮全是死的」的判据。
    expect(typeof w.newSession).toBe("function");
    expect(typeof w.render).toBe("function");
    // 侧栏与消息流都被填过：init 一路走到了 loadSessions / render。
    expect(w.document.getElementById("convs").innerHTML.length).toBeGreaterThan(0);
    expect(w.document.getElementById("stream").innerHTML.length).toBeGreaterThan(0);
  });

  it("React 挂载没有往 body 里加节点 —— index.html 的结构保持原样", async () => {
    const { w } = await boot();
    // .app + 两个 file input + popmenu + 五个 overlay，和模板里数出来的一致。
    const ids = [...w.document.body.children].map((e: any) => e.id || e.className);
    expect(ids).toEqual([
      "app", "picker", "returnPicker", "popMenu",
      "loginOverlay", "pwOverlay", "profileOverlay", "accountsModal", "settingsModal",
    ]);
  });
});
