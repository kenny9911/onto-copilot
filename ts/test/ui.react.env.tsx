/**
 * 侧栏组件测试共用的那点东西：一份**真**外壳 + 把 <Sidebar> 挂进 `#convs`。
 *
 * **不要 import ui.env.js。** 那个 stub 把 `document` 整个换成了自己那份假对象，
 * React 在上面一步都走不动。两套环境各管各的：逻辑层的测试继续跑 stub（它们一条
 * 都不用改），视图层的测试跑 happy-dom（文件头 `// @vitest-environment happy-dom`）。
 *
 * 外壳里的 id 与类名是从 ui/index.template.html 抄下来的：`#convs` 是 React 的宿主，
 * `#pjnewBtn` 归 syncProjectChrome()（那颗按钮长在冻结的 HTML 上，不属于任何 region），
 * `#title` 是顶栏那个 <h2>，`#popMenu` 是行内菜单的宿主。少一个，被测代码里的
 * `$("...")` 就会拿到 null，而那正是真实页面上不会发生的事。
 */
import { render, type RenderResult } from "@testing-library/react";

import { Sidebar } from "../src/ui/react/sidebar.js";

/** index.html 里侧栏那一段的真实结构（只留被测代码摸得到的那几个 id）。 */
export const SHELL = `<div class="app">
  <aside class="pane sidebar">
    <button class="newchat" id="newchatBtn">+ 新会话</button>
    <div class="secrow">
      <div class="sec">会话</div>
      <button class="pjnew" id="pjnewBtn" hidden>+</button>
    </div>
    <div class="convs" id="convs"></div>
  </aside>
  <main class="pane main">
    <div class="mhead">
      <div class="ava">OC</div>
      <h2 id="title">OntoCopilot</h2>
      <span class="pill" id="status"><i></i>就绪</span>
    </div>
    <div class="qbar" id="quotaBar" hidden></div>
    <div class="stream" id="stream"></div>
    <div class="comp">
      <div class="abar" id="abar"></div>
      <div class="cbox">
        <textarea class="cin" id="cin" rows="1"></textarea>
        <div class="crow">
          <span class="cfiles" id="chip"></span>
          <select class="msel" id="modelsel"><option value=""></option></select>
          <button class="cbtn go" id="send">↑</button>
        </div>
      </div>
    </div>
  </main>
</div>
<div class="popmenu" id="popMenu" hidden></div>`;

export function shell(): void {
  document.body.innerHTML = SHELL;
  (globalThis as any).EventSource = FakeEventSource;
}

/**
 * connect() 造的 EventSource 的替身。happy-dom **没有** EventSource，而侧栏上的
 * 好几条路（新建会话、移进项目 → loadSessions → connect）会走到它。
 * 和 ui.env.ts 里那个是同一个形状：把 onmessage 抓出来，测试自己往里喂事件。
 */
export class FakeEventSource {
  static last: FakeEventSource | null = null;
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** 与浏览器 EventSource 数值一致：0=CONNECTING, 1=OPEN, 2=CLOSED。 */
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
    FakeEventSource.instances.push(this);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  open(): void { this.closed = false; this.readyState = 1; this.onopen?.(); }
  error(opts: { closed?: boolean } = {}): void {
    this.closed = opts.closed === true;
    this.readyState = this.closed ? 2 : 0;
    this.onerror?.();
  }
  /** 按 SSE 的形态送一条事件（data 是 JSON 文本）。 */
  send(ev: unknown): void { this.onmessage?.({ data: JSON.stringify(ev) }); }
}

/** 一棵子树上出现过的全部属性名。属性值若「逃」出去，一定表现为多出来的属性名 ——
 *  拿 innerHTML 去 match /\son[a-z]+=/ 是不行的：被正确转义成文本的
 *  `<img src=x onerror=alert(1)>` 里也有那个形状。 */
export function attrNames(root: any): Set<string> {
  const names = new Set<string>();
  const visit = (el: any): void => {
    for (const a of Array.from(el.attributes) as any[]) names.add(a.name);
    for (const c of Array.from(el.children) as any[]) visit(c);
  };
  visit(root);
  return names;
}

/** 整棵子树上一个 on* 属性都没有 —— 内联处理器整套消失的判据。 */
export const inlineHandlers = (root: any): string[] =>
  [...attrNames(root)].filter(n => n.startsWith("on"));

export const convs = (): any => document.getElementById("convs");
export const $ = (id: string): any => document.getElementById(id);

/**
 * 把侧栏挂进那个**现成的** `#convs`（生产里走的是 portal，宿主是同一个元素）。
 * 之后 `paintSessions()` / `bumpUi()` 会驱动它重画，和页面上一模一样。
 */
export function mountSidebar(): RenderResult {
  return render(<Sidebar />, { container: convs() });
}

/** 侧栏当前画出来的会话标题，按顺序。 */
export const rowTitles = (): string[] =>
  [...convs().querySelectorAll(".conv .t")].map((e: any) => e.textContent);

/** 文本在侧栏里的出现位置 —— 「未归类垫底」这类顺序断言用它。 */
export function at(s: string): number {
  const i = String(convs().textContent).indexOf(s);
  if (i < 0) throw new Error(`侧栏里找不到 ${s}`);
  return i;
}
