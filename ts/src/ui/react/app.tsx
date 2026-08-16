// 根组件与挂载。
//
// ## 为什么不是 `createRoot(document.body).render(<App/>)`
//
// `ui/index.html` 的 `<body>` 是**逐字节冻结**的（767 行 CSS 靠那批 class 与 id
// 生效，改了就等于重新设计界面，而用户要的是换框架）。所以 React 不接管 body，
// 它接管的是 body 里那十几个**空容器**：`#convs` `#stream` `#abar` `#pbody`
// `#quotaBar` `#acctBody` `#setBody` `#identity` …… —— 原来 `innerHTML=` 往里写的
// 就是这些，React 只是换个方式往同样的位置写同样的 DOM。
//
// 实现是**一个 root + N 个 portal**，而不是 N 个 root：
//   - 一个 root ⇒ 一棵树 ⇒ context / 批处理 / 并发调度都是共享的。N 个 root 之间
//     这些全是割裂的，同一次 bumpUi() 会变成 N 次互不相干的重画。
//   - root 挂在一个**游离**的 div 上（从不 appendChild 到 document）：body 的子节点
//     结构因此一个字节都没变，而 portal 的目标是真容器，照样渲染。
//
// ## 一个容器只能有一个主人
//
// 一个 id 要么归 React（注册了 region），要么归旧的 `innerHTML=` 那套，**不能两个
// 都来**：React 会按自己上一次的虚拟树去 diff，旧代码在它背后改了真实 DOM 之后，
// 下一次更新轻则丢节点重则抛 NotFoundError。所以 registerRegion 对重复 id 直接抛错 ——
// 这种冲突静默下去只会变成一个「偶尔少半个侧栏」的鬼故事。
//
// ## 迁移一个模块的完整动作
//
//   1. 写组件（.tsx，放在 ts/src/ui/react/ 下），类名与 DOM 结构照抄原来的字符串；
//   2. 在模块**顶层**调 registerRegion("容器id", 组件)；
//   3. 把原来的 paintXxx() 函数体换成 bumpUi()（调用点一个都不动）；
//   4. 确保这个模块被 main.ts 直接或间接 import 到（否则模块体不执行，注册不上）。

import { StrictMode, createContext, useContext, useSyncExternalStore,
  type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { UiContext, uiStore, type UiStore } from "./store.js";

export interface Region {
  /** 宿主容器的 id，必须是 index.html 里已经存在的那个（不新建元素）。 */
  id: string;
  Component: ComponentType;
}

// ── region 注册表（本身也是个外部 store，好让测试在挂载后追加）────────
const regions = new Map<string, ComponentType>();
const regionListeners = new Set<() => void>();
let regionVersion = 0;

function notifyRegions(): void {
  regionVersion++;
  for (const fn of [...regionListeners]) fn();
}

export function registerRegion(id: string, Component: ComponentType): void {
  const prev = regions.get(id);
  if (prev && prev !== Component) {
    throw new Error(`容器 #${id} 已经有一个 React region 了 —— 一个容器只能有一个主人`);
  }
  regions.set(id, Component);
  notifyRegions();
}

/** 测试用：拆掉一个 region。生产代码不该调。 */
export function unregisterRegion(id: string): void {
  if (regions.delete(id)) notifyRegions();
}

export function registeredRegions(): Region[] {
  return [...regions].map(([id, Component]) => ({ id, Component }));
}

// ── 根组件 ────────────────────────────────────────────────────────
/** 容器的取法做成可注入的：测试里容器来自 testing-library 造的 DOM。 */
export const HostContext = createContext<(id: string) => Element | null>(
  (id) => (typeof document === "undefined" ? null : document.getElementById(id)),
);

function useRegions(): Region[] {
  const subscribe = (fn: () => void): (() => void) => {
    regionListeners.add(fn);
    return () => { regionListeners.delete(fn); };
  };
  useSyncExternalStore(subscribe, () => regionVersion, () => regionVersion);
  return registeredRegions();
}

/** 每个 region 一个 portal。容器不在（当前页面没有那块）就整块跳过，不报错。 */
export function Regions(): ReactNode {
  const lookup = useContext(HostContext);
  return useRegions().map(({ id, Component }) => {
    const host = lookup(id);
    return host ? createPortal(<Component />, host, id) : null;
  });
}

export function App({ store = uiStore }: { store?: UiStore }): ReactNode {
  return (
    <UiContext.Provider value={store}>
      <Regions />
    </UiContext.Provider>
  );
}

// ── 挂载 ──────────────────────────────────────────────────────────
let root: Root | null = null;

/**
 * 把 React 挂起来。**幂等** —— 重复调用不会造第二棵树。
 *
 * 没有任何 region 注册时这是一次彻底的空操作：页面还是那份现成的界面，
 * 谁也没被接管。四条视图 track 各自 registerRegion 之后才会有东西被画出来。
 */
export function mountApp(): void {
  if (root) return;
  if (typeof document === "undefined") return;
  // 游离节点：不进 document，body 的结构因此保持逐字节不变。
  root = createRoot(document.createElement("div"));
  root.render(<StrictMode><App /></StrictMode>);
}

/** 测试用：拆掉整棵树。 */
export function unmountApp(): void {
  root?.unmount();
  root = null;
}

export function isMounted(): boolean { return root !== null; }
