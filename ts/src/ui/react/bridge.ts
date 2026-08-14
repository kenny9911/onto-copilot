// 组件调用**旧动作函数**时的一层薄包装。
//
// questions.ts / returnaudit.ts / decisions.ts 里的动作函数（qDefer、qReopen、
// applyReturnAudit …）末尾调的是 `paint()` / `render()` —— 内联 JS 时代的渲染器。
// 那些调用点一个都不该动（它们同时还被 index.html 里的内联 onclick 用着，而
// #pbody / #stream 这两个容器现在仍归 preview.ts / render.ts 管）。
//
// 所以由**组件这一侧**在同一个时刻补一次 bumpUi()：两个渲染器同时收到通知，
// 迁移期里谁在画都是对的。等容器真的归了 React，旧 paint() 消失，这一层跟着删。
//
// 为什么同步与异步各 bump 一次：qRequest 这类函数的**同步段**先 `Q_BUSY.add(id)`
// （按钮要立刻变成「保存中…」），真正的结果要等 await 回来。只 bump 一次，
// 两个时刻里必然有一个画不出来。

import { bumpUi } from "./store.js";

/** 包一层：调用后立刻 bump，返回 Promise 的话落地后再 bump 一次。 */
export function bumped<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    const out = fn(...args);
    bumpUi();
    const then = (out as { then?: unknown } | null | undefined)?.then;
    if (typeof then === "function") {
      (out as unknown as Promise<unknown>).then(() => { bumpUi(); }, () => { bumpUi(); });
    }
    return out;
  };
}
