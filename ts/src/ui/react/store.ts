// G ↔ React 的桥。**这里没有一行新状态** —— 状态仍然全部住在 state.ts 的 `G`，
// 这一层只负责「G 变了之后让订阅它的组件重画一次」。
//
// 为什么不把 G 换成 useState/useReducer：`G` 有测试（ui.session / ui.events /
// ui.contracts.* 一共两百多条断言直接读写 G），把它重写成 React 状态等于把那些
// 覆盖白白丢掉。迁移的目标是**换宿主**，不是换状态模型。
//
// 为什么是 useSyncExternalStore 而不是 context 里塞一个 useState：G 是**外部
// 可变对象**，非 React 代码（sse.ts 的事件回调、fetch 的 then、内联处理器）随时
// 在改它。useSyncExternalStore 正是给这种「外部数据源」用的官方接口，它还顺手
// 解决了并发渲染下的读撕裂 —— 自己拿 useState + useEffect 手搓订阅做不到。
//
// ## 给其他 track 的规矩（只有一条）
//
//   **改完 G 就调 bumpUi()。**
//
// 现有代码里几乎每一处 `G.X = …` 后面都紧跟着 `render()` / `paint*()`；React 化
// 一个模块时，那些 paint 函数的函数体换成 `bumpUi()` 即可，调用点一个都不用动。
//
// 注意 bumpUi 只是「通知」，不做脏检查：G 里大量是数组 / Set / 原地 push 的对象，
// 任何基于引用比较的自动侦测都会漏掉它们（`G.OPS.push(x)` 引用没变）。所以宁可
// 显式，也不要一个「大部分时候能用」的魔法。

import { createContext, useContext, useSyncExternalStore } from "react";

import { G, type UiState } from "../state.js";

export interface UiStore {
  /** 当前版本号。**快照必须是不可变值** —— 返回 G 本身的话引用恒等，永远不重画。 */
  getVersion: () => number;
  subscribe: (onChange: () => void) => () => void;
  /** 状态本体。始终是 state.ts 那个 `G`，不是拷贝。 */
  readonly state: UiState;
  /** 通知所有订阅者：G 变了。 */
  bump: () => void;
}

/** 造一个 store。生产环境只有一个（下面的 uiStore），造函数是给测试隔离用的。 */
export function createUiStore(state: UiState): UiStore {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    state,
    getVersion: () => version,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    bump() {
      version++;
      // 复制一份再遍历：订阅者在回调里退订（组件卸载）会改动这个 Set。
      for (const fn of [...listeners]) fn();
    },
  };
}

/** 全局唯一的那一个，包着 state.ts 的 G。 */
export const uiStore: UiStore = createUiStore(G);

export const UiContext = createContext<UiStore>(uiStore);

/**
 * 订阅整个 G，返回它本身（**同一个对象**，读到的永远是最新值）。
 *
 * 粗粒度是**刻意的**：现在的 render() 本来就是整段重画，先做到行为等价，
 * 性能问题等真的量出来再说 —— 提前拆细粒度订阅只会让「两边行为是否一致」
 * 这件唯一的验收手段变难。
 */
export function useUi(): UiState {
  const store = useContext(UiContext);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.state;
}

/**
 * 只订阅一个派生值。**选择器必须返回原始值或稳定引用** —— 返回新造的对象/数组
 * 会让 useSyncExternalStore 每次比较都不相等，直接打进无限重渲染。
 * 拿不准就用 useUi()。
 */
export function useUiValue<T>(select: (s: UiState) => T): T {
  const store = useContext(UiContext);
  const snapshot = (): T => select(store.state);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** 改完 G 之后调一次。见文件头。 */
export function bumpUi(): void { uiStore.bump(); }

/** `G.X = v; bumpUi()` 的简写。语义完全相同，不做任何合并或延迟。 */
export function setUi(patch: Partial<UiState>): void {
  Object.assign(G, patch);
  uiStore.bump();
}
