/**
 * 取消与租约心跳 —— 对话段唯一需要"停止"语义的地方。
 *
 * ── 为什么这里有取消，而迁移约定 §2.2 说"取消：不假装有" ────────────────
 *
 * §2.2 针对的是内核：那里没有任何调用方能看见取消，用 `Promise.race` 模拟
 * `asyncio.wait` 只会造出一个"看起来取消了、其实还在跑"的假象。
 *
 * 对话段不一样 —— **取消是 HTTP 契约的一部分**：用户点「停止」，Python 侧
 * `/stop` cancel 掉 `s.chat_task`，这一轮就回 `{"reply":"（已停止）","stopped":true}`。
 * 前端认这个响应，所以这一层必须有取消。
 *
 * 取消信号本身用**已经落地的那套**：`RunHandle` / `RunCancelled`（`pipeline/types.ts`）
 * 和 `makeRunHandle`。这里只补两件它没有的小事。
 *
 * **诚实的差异**：`abort()` 只是打信号，被取消方查不查是它自己的事。
 * {@link waitOrAbort} 保证**调用方**在收到信号那一刻就往下走停止分支（这是
 * HTTP 契约要的），但已经发出去的模型请求如果下游没接 signal，它会继续跑完、
 * 继续计费，只是没人再等它的结果。Python 的 `task.cancel()` 在同样的位置也收不住
 * 已发出的 HTTP 请求 —— 两边一样，差别只在 Python 保证协程不会再往下走一行，
 * 而这里由 `waitOrAbort` 抛异常来保证同一件事。
 */

import { RunCancelled } from "../pipeline/types.js";

/**
 * 等一个 promise，中途收到 abort 就抛 {@link RunCancelled}。
 *
 * **被抛弃的那个 promise 必须挂 `.catch()`** —— 没人 await 的 rejected promise
 * 在 Node 里会触发 `unhandledRejection` 直接杀进程（迁移约定 §2.1 记过同一条）。
 */
export async function waitOrAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    throw new RunCancelled();
  }
  let onAbort: (() => void) | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => {
        p.catch(() => undefined);
        reject(new RunCancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject);
    });
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 反复续租，直到 `stop()` 被调用；续不上就调 `onLost()`。
 *
 * 对应 Python 的 `asyncio.create_task(heartbeat())` + `heartbeat_task.cancel()`。
 * 返回的 `stop()` **必须在 `finally` 里调** —— 漏掉就是一个永远续租的僵尸定时器，
 * 而它会让一个早就结束的请求一直霸着会话的 chat 租约。
 */
export function startHeartbeat(
  intervalSec: number,
  tick: () => Promise<boolean>,
  onLost: () => void,
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  const done = (async () => {
    for (;;) {
      // 睡眠必须**能被叫醒**：只 clearTimeout 的话这个 promise 永远不 settle，
      // `stop()` 里的 await 就死等 —— 每一条 chat 请求都会挂死在 finally。
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalSec * 1000);
      });
      if (stopped) return;
      let renewed: boolean;
      try {
        renewed = await tick();
      } catch {
        // 续租本身报错等同于没续上。Python 那边异常会冒进 task、再被
        // `gather(return_exceptions=True)` 吃掉 —— 结果是心跳**停了但没人 cancel
        // 主任务**，租约静默过期而请求还在写。这条更安全，是刻意的收紧。
        renewed = false;
      }
      if (stopped) return;
      if (!renewed) {
        onLost();
        return;
      }
    }
  })();
  // 没人 await 的 rejected promise 会杀进程，兜住。
  done.catch(() => undefined);
  return {
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (wake !== null) wake();
      await done.catch(() => undefined);
    },
  };
}
