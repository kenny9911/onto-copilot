/**
 * 事件流（SSE）—— 移植自 `server.py` 的 1976–2026 行。
 *
 * 事件流是内核事件日志的**投影**，不是另一套埋点。所以前端上看到的推理轨迹与
 * 事后重放、审计看到的是同一份数据 —— 两套埋点必然会漂移，而漂移的那天你不会
 * 知道该信哪个。
 *
 * **repo cursor 是唯一事实源，队列只负责同进程低延迟唤醒。** 每次唤醒（以及定时
 * 轮询）都读取 `seq >= cursor`，因此另一个 worker append 的事件一样可见；本地
 * 队列和轮询同时命中也只会发送一次。`since` 就是断点续传的那一格 —— 前端断线
 * 重连靠它，错一格就丢事件或重复事件。
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { EventSubscriber, SessionEvent } from "../../session_events.js";
import { eventRowAsSse } from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { currentRepo, sessAsync } from "../session.js";

/** 每轮最多等 repo 一次的时长。本进程 commit 会立刻唤醒；外部 worker 没共享
 * 内存，最多等待这么久的 repo poll。Postgres 的 NOTIFY 可作为未来的纯优化，
 * 正确性不依赖数据库方言或连接级 LISTEN。 */
const POLL_MS = 250;
/** keepalive 间隔（秒）。其余 timeout 只是跨 worker cursor 轮询。 */
const KEEPALIVE_S = 20;

/**
 * `asyncio.Queue` 的等价物，只满足这一处的用法：单消费者、带超时的 `get`。
 *
 * **不用 Promise.race 假装取消**（契约 §2.2）：这里的超时是真超时 ——
 * `setTimeout` 到点就 resolve(false)，没有悬着的 promise 留在事件循环里。
 */
export class SseQueue implements EventSubscriber {
  private readonly items: SessionEvent[] = [];
  private waiter: ((got: boolean) => void) | null = null;

  putNowait(item: SessionEvent): void {
    this.items.push(item);
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      w(true);
    }
  }

  /** 取一条；`timeoutMs` 内没有就返回 false（对应 Python 的 TimeoutError 分支）。
   * 取到的内容**故意丢掉** —— Python 侧同样只把它当唤醒信号，真正的数据永远
   * 从 repo 再读一遍。 */
  async get(timeoutMs: number): Promise<boolean> {
    if (this.items.length > 0) {
      this.items.shift();
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(false);
      }, timeoutMs);
      this.waiter = (got: boolean) => {
        clearTimeout(timer);
        this.items.shift();
        resolve(got);
      };
    });
  }
}

export function registerStreamRoutes(app: Hono<AppEnv>): void {
  app.get("/api/sessions/:sid/stream", async (c) => {
    const sid = c.req.param("sid");
    const s = await sessAsync(sid);
    // `since: int = 0`；解析不出来按 0，与 FastAPI 的 422 不同（见 divergences）。
    const sinceRaw = c.req.query("since");
    const since = sinceRaw === undefined ? 0 : Number.parseInt(sinceRaw, 10) || 0;
    const q = new SseQueue();
    s.subscribers.push(q);

    // FastAPI 那边显式带这两个头：nginx 不关缓冲的话，SSE 会被攒成一大坨再吐，
    // 前端看起来就是"推理轨迹半天不动，然后一下全出来"。
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      let cursor = Math.max(0, since);
      let lastKeepalive = monotonicS();
      try {
        if (since === 0) {
          // 前端当前固定以 since=0 重连，所以显式清空后按 durable seq 重放。
          // 这一行的字节形态照抄 Python（json.dumps 的默认分隔符带空格）。
          await stream.write('data: {"kind": "stream.reset", "seq": -1, "ts": 0}\n\n');
        }
        while (!stream.aborted && !stream.closed) {
          const rows = await currentRepo().readEvents(sid, { since: cursor });
          for (const row of rows) {
            if (row.seq < cursor) continue;
            const ev: SessionEvent = { ...eventRowAsSse(row) };
            cursor = row.seq + 1;
            // hydrate/state/debug 消费者仍能看到同一份权威投影；按 seq 去重。
            if (!s.events.some((x) => x["seq"] === row.seq)) {
              s.events.push(ev);
              s.events.sort((a, b) => seqOf(a) - seqOf(b));
            }
            await stream.writeSSE({ data: JSON.stringify(ev) });
          }
          const got = await q.get(POLL_MS);
          if (!got) {
            // 每 20 秒发 keepalive，其余 timeout 只是跨 worker cursor 轮询。
            const now = monotonicS();
            if (now - lastKeepalive >= KEEPALIVE_S) {
              lastKeepalive = now;
              await stream.write(": keepalive\n\n");
            }
          }
        }
      } finally {
        const i = s.subscribers.indexOf(q);
        if (i >= 0) s.subscribers.splice(i, 1);
      }
    });
  });
}

/** `int(x.get("seq", -1))` —— 缺 seq 的条目排在最前，和 Python 一致。 */
function seqOf(x: SessionEvent): number {
  const v = x["seq"];
  return v === undefined ? -1 : Math.trunc(Number(v));
}

/** `time.monotonic()`，单位秒。 */
function monotonicS(): number {
  return Number(process.hrtime.bigint() / 1_000_000n) / 1000;
}
