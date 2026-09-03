/**
 * 网关全局并发上限（P0）。
 *
 * 调度器的信号量只管**节点**并发（默认 8）；一个节点内部再并行（cohort、只读
 * 并行批、四 critic 视角）时，真实 HTTP 并发 = 节点并发 × 节点内并发，而
 * backends 对上游只有 429/欠费的被动分支，没有主动限流。这里在**唯一**的网络
 * 收口点（backend.generate，位于 rec.effect 内侧）加一道进程级 FIFO 信号量：
 *  · 重放不经过 generate → 不被限流（重放本该 0 网络 0 等待）；
 *  · FIFO 语义照抄 scheduler 的 Semaphore —— release 把 permit 直接交给下一个
 *    等待者，先到先服务，不许插队。
 */

import { afterEach, describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import {
  ModelGateway,
  Usage,
  setGatewayMaxConcurrency,
  stubRouting,
} from "../src/kernel/llm.js";
import { EventKind } from "../src/kernel/events.js";
import type { LlmRecorder } from "../src/kernel/llm.js";

/** 最小 recorder：effect 直通执行（等价于「没有历史可重放」）。 */
class PassRecorder implements LlmRecorder {
  readonly runId = "r";
  emit(_kind: EventKind, _opts: { nodeId?: string; payload?: Record<string, unknown> }): null {
    return null;
  }
  async effect(
    _nodeId: string,
    _kind: string,
    _request: Record<string, unknown>,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    return await run();
  }
}

/** 记录「同时在飞多少」的假后端。 */
function trackingBackend(delayMs: number) {
  let inflight = 0;
  let peak = 0;
  const order: number[] = [];
  return {
    peak: () => peak,
    order,
    backend: {
      async generate() {
        inflight += 1;
        peak = Math.max(peak, inflight);
        order.push(inflight);
        await new Promise((r) => setTimeout(r, delayMs));
        inflight -= 1;
        return ["{}", new Usage()] as never;
      },
    },
  };
}

afterEach(() => setGatewayMaxConcurrency(null));

describe("网关全局并发上限", () => {
  it("10 个并发调用，同时在飞的绝不超过上限 2", async () => {
    setGatewayMaxConcurrency(2);
    const t = trackingBackend(25);
    const gw = new ModelGateway(t.backend as never, new PassRecorder(), {
      routing: stubRouting(),
      budget: new Budget(),
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) => gw.call(`N${i}`, "问一下")));
    expect(t.peak()).toBe(2);
    expect(t.order.length).toBe(10);        // 一个都没丢，只是排队
  });

  it("不设上限时行为不变（老部署零影响）", async () => {
    const t = trackingBackend(15);
    const gw = new ModelGateway(t.backend as never, new PassRecorder(), {
      routing: stubRouting(),
      budget: new Budget(),
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => gw.call(`N${i}`, "问")));
    expect(t.peak()).toBe(6);               // 全部同时在飞
  });

  it("排队的调用失败不吞 permit —— 后续调用照常拿到额度", async () => {
    setGatewayMaxConcurrency(1);
    let n = 0;
    const backend = {
      async generate() {
        n += 1;
        if (n === 1) throw new Error("第一发炸了");
        return ["{}", new Usage()] as never;
      },
    };
    const gw = new ModelGateway(backend as never, new PassRecorder(), {
      routing: stubRouting(), budget: new Budget(), maxSchemaRetries: 0,
    });
    await expect(gw.call("A", "x")).rejects.toThrow();
    // permit 还回来了：第二个调用能正常走
    const out = await gw.call("B", "y");
    expect(out).toBeTruthy();
  });
});
