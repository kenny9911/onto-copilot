import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyInput, MouseButton } from "puppeteer-core";

import type { AppEnv } from "../src/server/app.js";
import {
  LIVE_BROWSER_DATA_URL_MAX_CHARS,
  LIVE_BROWSER_POST_MAX_BYTES,
  LIVE_BROWSER_SCHEMA_VERSION,
  LiveBrowserError,
  LiveBrowserNavigationBudget,
  LiveBrowserRuntime,
  SafeLiveBrowserProxy,
  discoverLiveBrowserUpstreamProxy,
  parseLiveBrowserUpstreamProxy,
  validateLiveBrowserRequest,
  validatedLiveBrowserUrl,
  type LiveBrowserCapabilities,
  type LiveBrowserOpenOptions,
  type LiveBrowserProvider,
  type LiveBrowserSnapshot,
  type LiveBrowserState,
  type LiveBrowserTabHandle,
} from "../src/server/live_browser.js";
import { registerLiveBrowserRoutes } from "../src/server/routes/live-browser.js";
import { setRepoForTests } from "../src/store/deps.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeSessionRow } from "../src/store/types.js";

const FRAME = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeTab implements LiveBrowserTabHandle {
  private value: LiveBrowserState;
  readonly close = vi.fn(async () => undefined);

  constructor(readonly browserSessionId: string, url: string) {
    this.value = {
      schemaVersion: LIVE_BROWSER_SCHEMA_VERSION,
      browserSessionId,
      url,
      title: "Safe page",
      width: 1280,
      height: 800,
      seq: 1,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
  }

  private snapshot(patch: Partial<LiveBrowserState> = {}): LiveBrowserSnapshot {
    this.value = { ...this.value, ...patch, seq: this.value.seq + 1 };
    return { state: this.value, png: FRAME.slice() };
  }

  state(): LiveBrowserState { return this.value; }
  frame(): Uint8Array { return FRAME.slice(); }
  async navigate(url: string): Promise<LiveBrowserSnapshot> { return this.snapshot({ url }); }
  async back(): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async forward(): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async reload(): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async click(_x: number, _y: number, _button?: MouseButton): Promise<LiveBrowserSnapshot> {
    return this.snapshot();
  }
  async scroll(_deltaX: number, _deltaY: number): Promise<LiveBrowserSnapshot> {
    return this.snapshot();
  }
  async typeText(_text: string): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async pressKey(_key: KeyInput): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async screenshot(): Promise<LiveBrowserSnapshot> { return this.snapshot(); }
  async snapshotDocument(expected: { readonly seq: number; readonly url: string }) {
    if (expected.seq !== this.value.seq || expected.url !== this.value.url) {
      throw new LiveBrowserError("stale_frame", "stale", 409);
    }
    return {
      schemaVersion: "ontocopilot.live-browser-text/1" as const,
      browserSessionId: this.browserSessionId,
      seq: this.value.seq,
      url: this.value.url,
      title: this.value.title,
      paragraphs: [{ text: "Dynamic visible content", ordinal: 0 }],
      capturedAt: "2026-08-31T00:00:00.000Z",
    };
  }
}

class FakeProvider implements LiveBrowserProvider {
  readonly opened: LiveBrowserOpenOptions[] = [];
  readonly tabs: FakeTab[] = [];
  readonly shutdown = vi.fn(async () => undefined);

  capabilities(): LiveBrowserCapabilities {
    return { available: true, features: ["navigate", "screenshot"] };
  }

  async open(options: LiveBrowserOpenOptions): Promise<LiveBrowserTabHandle> {
    this.opened.push(options);
    const tab = new FakeTab(options.browserSessionId, options.url);
    this.tabs.push(tab);
    return tab;
  }
}

describe("Live Browser network gate", () => {
  it("只信任 loopback HTTP 上游代理，并按显式配置、环境、macOS 系统设置排序", () => {
    expect(parseLiveBrowserUpstreamProxy("http://127.0.0.1:7897")).toMatchObject({
      host: "127.0.0.1",
      port: 7897,
    });
    expect(parseLiveBrowserUpstreamProxy("http://user:p%40ss@localhost:7897")).toMatchObject({
      host: "127.0.0.1",
      port: 7897,
      authorization: `Basic ${Buffer.from("user:p@ss").toString("base64")}`,
    });
    for (const value of [
      "https://127.0.0.1:7897",
      "http://192.168.1.2:7897",
      "http://proxy.example:7897",
      "socks5://127.0.0.1:7897",
    ]) expect(parseLiveBrowserUpstreamProxy(value)).toBeNull();

    expect(discoverLiveBrowserUpstreamProxy({
      platform: "darwin",
      env: { HTTPS_PROXY: "http://127.0.0.1:7001" },
      readMacProxy: () => "HTTPSProxy : 127.0.0.1\nHTTPSPort : 7002\nHTTPSEnable : 1",
    })).toMatchObject({ port: 7001 });
    expect(discoverLiveBrowserUpstreamProxy({
      platform: "darwin",
      env: { HTTPS_PROXY: "http://remote.example:7001" },
      readMacProxy: () => "HTTPSProxy : 127.0.0.1\nHTTPSPort : 7002\nHTTPSEnable : 1",
    })).toMatchObject({ host: "127.0.0.1", port: 7002 });
    expect(() => discoverLiveBrowserUpstreamProxy({
      platform: "linux",
      env: { ONTOCOPILOT_BROWSER_UPSTREAM_PROXY: "https://127.0.0.1:7897" },
    })).toThrowError(expect.objectContaining({ code: "invalid_upstream_proxy", status: 503 }));
  });

  it("通过本机上游代理 CONNECT 到已验证 pinned IP，同时保留原始 Host 与隐藏凭据", async () => {
    const transcript: string[] = [];
    const upstream = createNetServer((socket) => {
      let buffer = Buffer.alloc(0);
      let connected = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const header = buffer.subarray(0, boundary).toString("latin1");
        buffer = buffer.subarray(boundary + 4);
        transcript.push(header);
        if (!connected) {
          connected = true;
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          return;
        }
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as { port: number }).port;
    const proxy = new SafeLiveBrowserProxy(
      async () => [{ address: "93.184.216.34", family: 4 as const }],
      { upstreamProxy: `http://agent:s3cret@127.0.0.1:${port}` },
    );
    const endpoint = new URL(await proxy.start());
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: "GET",
          path: "http://public.example/assets/app.js?q=1",
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        request.once("error", reject);
        request.end();
      });
      expect(result).toEqual({ status: 200, body: "ok" });
      expect(transcript[0]).toContain("CONNECT 93.184.216.34:80 HTTP/1.1");
      expect(transcript[0]).toContain("Host: public.example:80");
      expect(transcript[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("agent:s3cret").toString("base64")}`);
      expect(transcript[1]).toContain("GET /assets/app.js?q=1 HTTP/1.1");
      expect(transcript[1]?.toLowerCase()).toContain("host: public.example");
      expect(transcript[1]?.toLowerCase()).toContain("connection: close");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("CONNECT 任一端关闭都会销毁另一端，避免 CLOSED/CLOSE_WAIT 隧道泄漏", async () => {
    let resolveUpstreamClosed = (): void => undefined;
    const upstreamClosed = new Promise<void>((resolve) => { resolveUpstreamClosed = resolve; });
    const upstream = createNetServer((socket) => {
      socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
      socket.once("close", resolveUpstreamClosed);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as { port: number }).port;
    const proxy = new SafeLiveBrowserProxy(
      async () => [{ address: "93.184.216.34", family: 4 as const }],
      { upstreamProxy: `http://127.0.0.1:${port}` },
    );
    const endpoint = new URL(await proxy.start());
    try {
      const client = netConnect({ host: endpoint.hostname, port: Number(endpoint.port) });
      await new Promise<void>((resolve, reject) => {
        client.once("error", reject);
        client.once("connect", () => client.write(
          "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n",
        ));
        client.once("data", () => {
          client.destroy();
          resolve();
        });
      });
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("upstream tunnel did not close")), 1_000);
          timeout.unref();
        }),
      ]);
      for (let attempt = 0; attempt < 20
        && (proxy as unknown as { sockets: Set<unknown> }).sockets.size > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect((proxy as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("启用的上游代理失败时明确返回 502，不静默直连且不泄露代理凭据", async () => {
    const upstream = createNetServer((socket) => {
      socket.once("data", () => socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
      ));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const port = (upstream.address() as { port: number }).port;
    const proxy = new SafeLiveBrowserProxy(
      async () => [{ address: "93.184.216.34", family: 4 as const }],
      { upstreamProxy: `http://agent:s3cret@127.0.0.1:${port}` },
    );
    const endpoint = new URL(await proxy.start());
    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest({
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: "GET",
          path: "http://public.example/private?token=hidden",
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        request.once("error", reject);
        request.end();
      });
      expect(result.status).toBe(502);
      expect(result.body).toContain("本机上游代理未能建立公网连接");
      expect(result.body).not.toContain("agent");
      expect(result.body).not.toContain("s3cret");
      expect(result.body).not.toContain("token");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("每次顶层导航获得独立预算，旧 generation 不能消耗新页面配额", () => {
    const budget = new LiveBrowserNavigationBudget();
    const first = budget.begin();
    for (let index = 0; index < 512; index += 1) expect(budget.accountRequest(first)).toBe("allowed");
    expect(budget.accountRequest(first)).toBe("exceeded");
    budget.exhaust();
    const second = budget.begin();
    expect(second).toBe(first + 1);
    expect(budget.accountRequest(first)).toBe("stale");
    expect(budget.accountBytes(100, first)).toBe("stale");
    expect(budget.accountRequest(second)).toBe("allowed");
    expect(budget.accountBytes(1_024, second)).toBe("allowed");
    expect(budget).toMatchObject({ requestCount: 1, receivedBytes: 1_024, exceeded: false });
  });

  it("在 DNS 前拒绝所有非 Web scheme、URL credentials 与非标准端口", async () => {
    const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    for (const value of [
      "file:///etc/passwd",
      "data:text/html,hello",
      "javascript:alert(1)",
      "blob:https://example.com/id",
      "about:blank",
      "chrome://settings",
      "ws://example.com/socket",
      "wss://example.com/socket",
    ]) {
      await expect(validatedLiveBrowserUrl(value, resolver)).rejects.toMatchObject({
        code: "blocked_scheme",
        status: 403,
      });
    }
    await expect(validatedLiveBrowserUrl("https://user:secret@example.com", resolver))
      .rejects.toMatchObject({ code: "blocked_credentials", status: 403 });
    await expect(validatedLiveBrowserUrl("https://example.com:8443", resolver))
      .rejects.toMatchObject({ code: "blocked_port", status: 403 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("拒绝 localhost、私网/保留地址和混合 DNS，避免任选公网项造成 rebinding", async () => {
    const blocked = [
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ];
    for (const address of blocked) {
      await expect(validatedLiveBrowserUrl(
        "https://public.example/page",
        async () => [{ address, family: address.includes(":") ? 6 : 4 } as const],
      )).rejects.toMatchObject({ code: "blocked_address", status: 403 });
    }
    await expect(validatedLiveBrowserUrl("https://public.example/page", async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.8", family: 4 as const },
    ])).rejects.toMatchObject({ code: "blocked_address", status: 403 });
    await expect(validatedLiveBrowserUrl("https://localhost/page", async () => {
      throw new Error("resolver must not run");
    })).rejects.toMatchObject({ code: "blocked_host", status: 403 });
  });

  it("只返回已验证地址并删除 fragment", async () => {
    const result = await validatedLiveBrowserUrl("https://docs.example/path?q=1#secret", async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);
    expect(result.url.toString()).toBe("https://docs.example/path?q=1");
    expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("代理会重新解析并阻断 HTTP 与 CONNECT 的 DNS rebinding，不信任先前的公网结果", async () => {
    const exercise = async (kind: "http" | "connect"): Promise<string> => {
      let lookups = 0;
      const resolver = vi.fn(async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: "93.184.216.34", family: 4 as const }]
          : [{ address: "127.0.0.1", family: 4 as const }];
      });
      await expect(validatedLiveBrowserUrl("https://rebind.example/", resolver)).resolves.toMatchObject({
        addresses: [{ address: "93.184.216.34", family: 4 }],
      });
      const proxy = new SafeLiveBrowserProxy(resolver);
      const endpoint = new URL(await proxy.start());
      try {
        if (kind === "http") {
          return await new Promise<string>((resolve, reject) => {
            const request = httpRequest({
              host: endpoint.hostname,
              port: Number(endpoint.port),
              method: "GET",
              path: "http://rebind.example/resource.js",
            }, (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.once("end", () => resolve(`HTTP/${response.statusCode} ${Buffer.concat(chunks).toString("utf8")}`));
            });
            request.once("error", reject);
            request.end();
          });
        }
        return await new Promise<string>((resolve, reject) => {
          const socket = netConnect({ host: endpoint.hostname, port: Number(endpoint.port) });
          const chunks: Buffer[] = [];
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error("CONNECT policy response timed out"));
          }, 2_000);
          socket.once("connect", () => socket.write(
            "CONNECT rebind.example:443 HTTP/1.1\r\nHost: rebind.example:443\r\n\r\n",
          ));
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.once("end", () => {
            clearTimeout(timeout);
            resolve(Buffer.concat(chunks).toString("utf8"));
          });
          socket.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      } finally {
        await proxy.close();
      }
    };

    await expect(exercise("http")).resolves.toMatch(/^HTTP\/403 .*私网/u);
    await expect(exercise("connect")).resolves.toMatch(/^HTTP\/1\.1 403 Forbidden[\s\S]*私网/u);
  });

  it("明文代理在解析或连接前拒绝超限 POST，不能被当作无界上传 relay", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("oversized POST must fail before DNS");
    });
    const proxy = new SafeLiveBrowserProxy(resolver);
    const endpoint = new URL(await proxy.start());
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          host: endpoint.hostname,
          port: Number(endpoint.port),
          method: "POST",
          path: "http://public.example/graphql",
          headers: { "content-length": String(LIVE_BROWSER_POST_MAX_BYTES + 1) },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(413);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
});

describe("Live Browser anonymous compatibility policy", () => {
  const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
  const request = (patch: Partial<Parameters<typeof validateLiveBrowserRequest>[0]> = {}) => ({
    url: "https://app.example/assets/app.js",
    method: "GET",
    resourceType: "script",
    navigation: false,
    topLevelUrl: "https://app.example/dashboard",
    ...patch,
  });

  beforeEach(() => publicResolver.mockClear());

  it("允许公开 GET、EventSource、同源受限 POST 与同源 data/blob 渲染资源", async () => {
    await expect(validateLiveBrowserRequest(request(), publicResolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest(request({
      url: "https://events.example/stream",
      resourceType: "eventsource",
    }), publicResolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest(request({
      url: "https://app.example/graphql",
      method: "POST",
      resourceType: "fetch",
      bodyBytes: LIVE_BROWSER_POST_MAX_BYTES,
    }), publicResolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest(request({
      url: "data:text/javascript,self.postMessage(1)",
      resourceType: "worker",
    }), publicResolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest(request({
      url: "blob:https://app.example/1234",
      resourceType: "worker",
    }), publicResolver)).resolves.toBeUndefined();
  });

  it("禁止 WebSocket、跨站/导航/超限 POST 以及其它 unsafe method", async () => {
    await expect(validateLiveBrowserRequest(request({
      url: "wss://app.example/socket",
      resourceType: "websocket",
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_websocket", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      url: "https://api.other.example/graphql",
      method: "POST",
      resourceType: "xhr",
      bodyBytes: 10,
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_cross_origin_post", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      url: "https://app.example/form",
      method: "POST",
      resourceType: "document",
      navigation: true,
      bodyBytes: 10,
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_method", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      url: "https://app.example/graphql",
      method: "POST",
      resourceType: "fetch",
      bodyBytes: LIVE_BROWSER_POST_MAX_BYTES + 1,
    }), publicResolver)).rejects.toMatchObject({ code: "post_too_large", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      method: "PUT",
      resourceType: "fetch",
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_method", status: 403 });
  });

  it("data/blob 只能作为有界、非导航、当前网页同源的子资源", async () => {
    await expect(validateLiveBrowserRequest(request({
      url: "data:text/html,redirect",
      resourceType: "document",
      navigation: true,
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_local_resource", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      url: `data:text/plain,${"x".repeat(LIVE_BROWSER_DATA_URL_MAX_CHARS)}`,
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_local_resource", status: 403 });
    await expect(validateLiveBrowserRequest(request({
      url: "blob:https://other.example/1234",
      resourceType: "worker",
    }), publicResolver)).rejects.toMatchObject({ code: "blocked_local_resource", status: 403 });
  });

  it("Dedicated Worker 的公网请求仍经过同一 DNS/IP policy", async () => {
    await expect(validateLiveBrowserRequest(request({
      url: "https://worker.example/module.js",
      resourceType: "worker",
    }), async () => [{ address: "169.254.169.254", family: 4 as const }]))
      .rejects.toMatchObject({ code: "blocked_address", status: 403 });
  });
});

describe("Live Browser runtime ownership and cleanup", () => {
  it("runtime key 同时绑定 Onto sid 与 browser id，并按 TTL 清理", async () => {
    const provider = new FakeProvider();
    let now = 1_000;
    const runtime = new LiveBrowserRuntime({
      provider,
      now: () => now,
      idleTtlMs: 100,
      maxTabs: 1,
      startReaper: false,
    });
    const opened = await runtime.open("sid-a", "https://example.com");
    const id = opened.state.browserSessionId;
    expect(() => runtime.get("sid-b", id)).toThrowError(LiveBrowserError);
    expect(runtime.list("sid-b")).toEqual([]);
    await expect(runtime.open("sid-a", "https://example.org"))
      .rejects.toMatchObject({ code: "too_many_tabs" });
    expect(provider.opened).toHaveLength(1);

    now = 1_101;
    await expect(runtime.closeExpired()).resolves.toBe(1);
    expect(provider.tabs[0]?.close).toHaveBeenCalledTimes(1);
    expect(() => runtime.get("sid-a", id)).toThrowError(LiveBrowserError);
    await runtime.shutdown();
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
  });

  it("close 对错误 sid 不产生跨会话副作用，正确 close 幂等", async () => {
    const provider = new FakeProvider();
    const runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    const opened = await runtime.open("sid-a", "https://example.com");
    const id = opened.state.browserSessionId;
    await runtime.close("sid-b", id);
    expect(provider.tabs[0]?.close).not.toHaveBeenCalled();
    expect(runtime.get("sid-a", id).state.browserSessionId).toBe(id);
    await runtime.close("sid-a", id);
    await runtime.close("sid-a", id);
    expect(provider.tabs[0]?.close).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });
});

describe("Live Browser same-origin route gate", () => {
  let repo: MemoryRepo;
  let provider: FakeProvider;
  let runtime: LiveBrowserRuntime;
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    repo = new MemoryRepo();
    setRepoForTests(repo);
    await repo.createSession(makeSessionRow({ id: "sid-a", owner: "user-a", title: "A" }));
    await repo.createSession(makeSessionRow({ id: "sid-a-2", owner: "user-a", title: "A2" }));
    await repo.createSession(makeSessionRow({ id: "sid-b", owner: "user-b", title: "B" }));
    provider = new FakeProvider();
    runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-test-user") || "user-a" });
      await next();
    });
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
    });
    registerLiveBrowserRoutes(app, { runtime });
  });

  afterEach(async () => {
    await runtime.shutdown();
    setRepoForTests(null);
  });

  async function open(headers: Record<string, string> = {}): Promise<Response> {
    return await app.request("/api/sessions/sid-a/live-browser/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", ...headers },
      body: JSON.stringify({ url: "https://example.com" }),
    });
  }

  it("cross-origin / cross-site / 非 owner 请求都在 provider 调用前失败", async () => {
    expect((await open({ origin: "https://evil.example" })).status).toBe(403);
    expect((await open({ origin: "http://localhost", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await open({ "x-test-user": "user-b" })).status).toBe(404);
    expect(provider.opened).toHaveLength(0);
  });

  it("frame 只交付给同一 owner+sid，并带禁止缓存/嗅探/跨源读取的响应头", async () => {
    const response = await open();
    expect(response.status).toBe(201);
    const browser = (await response.json() as { browser: LiveBrowserState & { frameUrl: string } }).browser;
    expect(browser.frameUrl).toContain(`/api/sessions/sid-a/live-browser/sessions/${browser.browserSessionId}/frame`);

    const frame = await app.request(browser.frameUrl);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(frame.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(frame.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(FRAME);

    expect((await app.request(browser.frameUrl, { headers: { "x-test-user": "user-b" } })).status).toBe(404);
    const wrongSid = browser.frameUrl.replace("/sid-a/", "/sid-a-2/");
    expect((await app.request(wrongSid)).status).toBe(404);
  });

  it("browser id 不是授权凭证，控制动作仍需同源门与正确 sid", async () => {
    const browser = (await (await open()).json() as { browser: LiveBrowserState }).browser;
    const base = `/api/sessions/sid-a/live-browser/sessions/${browser.browserSessionId}`;
    const foreign = await app.request(`${base}/reload`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(provider.tabs[0]?.state().seq).toBe(1);

    const valid = await app.request(`${base}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ deltaX: 0, deltaY: 300 }),
    });
    expect(valid.status).toBe(200);
    expect(((await valid.json() as { browser: LiveBrowserState }).browser).seq).toBe(2);

    const wrongSid = await app.request(`${base.replace("/sid-a/", "/sid-a-2/")}/reload`, {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect(wrongSid.status).toBe(404);
    expect(provider.tabs[0]?.state().seq).toBe(2);
  });
});
