// @vitest-environment happy-dom
/**
 * React 骨架本身的契约：状态怎么接进组件树、组件挂在哪里、以及那条
 * 「一个容器只能有一个主人」的规矩。
 *
 * **environment 用文件头的 docblock 指定，不写 vitest 配置文件。** 现有的 243 条
 * UI 测试跑在 test/ui.env.ts 那个手写 stub 上（它连 `document` 都换成了自己那份），
 * 全局切成 happy-dom 会把它们一起改掉 —— 而那些测试没有一条是要改的。
 * 一行 docblock 就能按文件选环境，没必要动全局。
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { G } from "../src/ui/state.js";
import {
  App, isMounted, mountApp, registerRegion, registeredRegions, unmountApp, unregisterRegion,
} from "../src/ui/react/app.js";
import { bumpUi, createUiStore, setUi, useUi, useUiValue } from "../src/ui/react/store.js";

// 手动调 act() 需要这个标志（RTL 的 render 自己会设，mountApp 那条用例不走 render）。
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** 把 index.html 里那几个真实容器立起来 —— React 只往已经存在的 id 里 portal。 */
function shell(): void {
  document.body.innerHTML = `<div class="app">
    <aside class="pane sidebar"><div class="convs" id="convs"></div></aside>
    <main class="pane main"><div class="stream" id="stream"></div></main>
  </div>`;
}

const REGIONS_UNDER_TEST = ["convs", "stream", "nosuchcontainer"];

beforeEach(() => { shell(); });
afterEach(() => {
  // 整块包在 act 里：unregisterRegion 会通知还挂着的树重画，散在 act 外面
  // React 会刷一串 "not wrapped in act" 到 stderr。
  act(() => {
    cleanup();
    unmountApp();
    for (const id of REGIONS_UNDER_TEST) unregisterRegion(id);
  });
});

// ══════════════════════════════════════════════════════════════════
//  状态：G 还是那个 G
// ══════════════════════════════════════════════════════════════════
describe("useUi —— G 与组件树之间的桥", () => {
  function Title(): ReactNode {
    const g = useUi();
    return <h2 id="probe">{String(g.S?.title ?? "-")}</h2>;
  }

  it("读到的就是 state.ts 那个 G，不是拷贝", () => {
    G.S = { id: "s1", title: "原来的名字" };
    const { container } = render(<Title />);
    expect(container.textContent).toBe("原来的名字");
  });

  it("bumpUi() 之后组件重画", () => {
    G.S = { id: "s1", title: "旧" };
    const { container } = render(<Title />);
    act(() => { G.S.title = "新"; bumpUi(); });
    expect(container.textContent).toBe("新");
  });

  it("**不 bump 就不重画** —— 这条规矩是显式的，没有魔法脏检查", () => {
    // 这不是缺陷，是设计：G 里大量是数组 / Set / 原地 push 的对象（G.OPS.push(x)
    // 之后引用没变），任何基于引用比较的自动侦测都会漏掉它们。宁可要一条
    // 「改完就 bump」的死规矩，也不要一个大部分时候能用的自动机制。
    G.S = { id: "s1", title: "旧" };
    const { container } = render(<Title />);
    G.S.title = "偷偷改了";
    expect(container.textContent).toBe("旧");
    act(() => { bumpUi(); });
    expect(container.textContent).toBe("偷偷改了");
  });

  it("setUi(patch) = Object.assign(G, patch) + bumpUi()，语义完全一样", () => {
    G.S = { id: "s1", title: "旧" };
    const { container } = render(<Title />);
    act(() => { setUi({ S: { id: "s2", title: "换了会话" } }); });
    expect(container.textContent).toBe("换了会话");
    expect(G.S.id).toBe("s2");     // 真的写回了 G，不是组件里的一份影子状态
  });

  it("useUiValue 只订阅一个派生值", () => {
    G.MODE = "work";
    function Mode(): ReactNode { return <span>{useUiValue(s => s.MODE)}</span>; }
    const { container } = render(<Mode />);
    act(() => { G.MODE = "chat"; bumpUi(); });
    expect(container.textContent).toBe("chat");
  });

  it("store 之间互不串台（createUiStore 给测试隔离用）", () => {
    const a = createUiStore({ ...G, MODE: "work" } as any);
    let hits = 0;
    const off = a.subscribe(() => { hits++; });
    bumpUi();                       // 全局那个 store 动了
    expect(hits).toBe(0);           // 隔离的这个不该收到
    a.bump();
    expect(hits).toBe(1);
    off();
    a.bump();
    expect(hits).toBe(1);           // 退订之后不再收
  });
});

// ══════════════════════════════════════════════════════════════════
//  挂载：portal 进 index.html 里现成的容器
// ══════════════════════════════════════════════════════════════════
describe("region 与挂载", () => {
  function Convs(): ReactNode { return <div className="conv">一行会话</div>; }
  function Stream(): ReactNode { return <div className="bub oc">一条消息</div>; }

  it("组件画进的是那个现成的容器，不是新造的节点", () => {
    registerRegion("convs", Convs);
    render(<App />);
    const host = document.getElementById("convs")!;
    expect(host.querySelector(".conv")?.textContent).toBe("一行会话");
    // 容器自己的类名与位置没被动过 —— 767 行 CSS 认的就是这些。
    expect(host.className).toBe("convs");
    expect(host.parentElement?.className).toBe("pane sidebar");
  });

  it("多个 region 各进各的容器", () => {
    registerRegion("convs", Convs);
    registerRegion("stream", Stream);
    render(<App />);
    expect(document.getElementById("convs")!.textContent).toBe("一行会话");
    expect(document.getElementById("stream")!.textContent).toBe("一条消息");
  });

  it("容器不存在就整块跳过，不抛错", () => {
    registerRegion("nosuchcontainer", Convs);
    expect(() => render(<App />)).not.toThrow();
  });

  it("同一个容器注册两个组件直接抛错 —— 一个容器只能有一个主人", () => {
    registerRegion("convs", Convs);
    expect(() => registerRegion("convs", Stream)).toThrow(/只能有一个主人/);
    // 同一个组件重复注册（模块被 import 两次）是幂等的，不该炸。
    expect(() => registerRegion("convs", Convs)).not.toThrow();
    expect(registeredRegions().filter(r => r.id === "convs")).toHaveLength(1);
  });

  it("mountApp 幂等，而且**不往 body 里添任何节点**", () => {
    registerRegion("convs", Convs);
    const before = document.body.children.length;
    act(() => { mountApp(); });
    act(() => { mountApp(); });
    expect(isMounted()).toBe(true);
    // root 挂在游离节点上：body 的子节点数一个都没多，index.html 的结构因此没变。
    expect(document.body.children.length).toBe(before);
    expect(document.getElementById("convs")!.querySelector(".conv")).not.toBeNull();
    act(() => { unmountApp(); });
    expect(isMounted()).toBe(false);
    // 卸载之后容器被清空，回到 index.html 里那个空 div 的样子。
    expect(document.getElementById("convs")!.innerHTML).toBe("");
  });

  it("挂载之后 bumpUi 能穿到 portal 里的组件", () => {
    function Live(): ReactNode { return <div className="conv">{useUi().MODE}</div>; }
    registerRegion("convs", Live);
    G.MODE = "work";
    act(() => { mountApp(); });
    expect(document.getElementById("convs")!.textContent).toBe("work");
    act(() => { G.MODE = "chat"; bumpUi(); });
    expect(document.getElementById("convs")!.textContent).toBe("chat");
  });
});
