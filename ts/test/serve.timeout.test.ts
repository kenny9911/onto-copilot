/**
 * 请求超时：Node 的 5 分钟默认值必须关掉。
 *
 * uvicorn（Python 时代的宿主）**没有**请求超时，所以一次跑很久的请求只会慢、
 * 不会断。Node 的 `requestTimeout` 默认 300_000，超过就把连接掐了 —— 前端看到的
 * 是一句 `TypeError: Failed to fetch`，而服务端那一轮**还在继续跑**并通过 SSE
 * 交付结果。症状于是变成「报错了但结果又出来了」，且没有任何日志。
 *
 * 实测一次「读一张图 + 回答」的对话轮就要 54 秒，完整梳理重材料远不止。
 */

import { describe, expect, it } from "vitest";

import { startServer } from "../src/serve.js";

describe("HTTP 服务的超时设置", () => {
  it("requestTimeout 关掉了 —— 长梳理不该被宿主静默掐断", async () => {
    const running = await startServer({ port: 0 });
    try {
      // startServer 不导出底层 http.Server，从监听端口反查它的设置：
      // 直接断言「一个耗时超过默认 300s 的请求不会断」要跑 5 分钟，不现实。
      // 这里退一步，断言进程里所有 http.Server 的 requestTimeout 都是 0。
      const { _getActiveHandles } = process as unknown as {
        _getActiveHandles: () => { requestTimeout?: number }[];
      };
      const servers = _getActiveHandles().filter(
        (h) => typeof h.requestTimeout === "number",
      );
      expect(servers.length).toBeGreaterThan(0); // 抓不到就说明这条测试没在测东西
      for (const s of servers) expect(s.requestTimeout).toBe(0);
    } finally {
      await running.close();
    }
  });

  it("headersTimeout 保持默认 —— 慢的是我们自己的处理，不是对端发头", async () => {
    const running = await startServer({ port: 0 });
    try {
      const { _getActiveHandles } = process as unknown as {
        _getActiveHandles: () => { requestTimeout?: number; headersTimeout?: number }[];
      };
      const servers = _getActiveHandles().filter(
        (h) => typeof h.requestTimeout === "number",
      );
      // 60s：防慢速头攻击的那道闸不该跟着一起关掉
      for (const s of servers) expect(s.headersTimeout).toBeGreaterThan(0);
    } finally {
      await running.close();
    }
  });
});
