import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, KeyInput, MouseButton } from "puppeteer-core";

import type { AppEnv } from "../src/server/app.js";
import {
  LIVE_BROWSER_SCHEMA_VERSION,
  LIVE_BROWSER_DATA_URL_MAX_CHARS,
  LIVE_BROWSER_POST_MAX_BYTES,
  LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS,
  ChromiumLiveBrowserProvider,
  assertLiveBrowserCommittedPage,
  isSoftLiveBrowserNavigationTimeout,
  LiveBrowserError,
  LiveBrowserRuntime,
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

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

class FakeTab implements LiveBrowserTabHandle {
  readonly browserSessionId: string;
  closed = false;
  private current: LiveBrowserState;

  constructor(options: LiveBrowserOpenOptions) {
    this.browserSessionId = options.browserSessionId;
    this.current = {
      schemaVersion: LIVE_BROWSER_SCHEMA_VERSION,
      browserSessionId: options.browserSessionId,
      url: options.url,
      title: "Fake page",
      width: options.viewport.width,
      height: options.viewport.height,
      seq: 1,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      updatedAt: "2026-08-31T04:00:00.000Z",
    };
  }

  private next(fields: Partial<LiveBrowserState> = {}): LiveBrowserSnapshot {
    this.current = { ...this.current, ...fields, seq: this.current.seq + 1 };
    return { state: this.current, png: PNG };
  }

  state(): LiveBrowserState { return this.current; }
  frame(): Uint8Array { return PNG; }
  navigate(url: string): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next({ url, canGoBack: true })); }
  back(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next({ canGoBack: false, canGoForward: true })); }
  forward(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next({ canGoBack: true, canGoForward: false })); }
  reload(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  click(_x: number, _y: number, _button?: MouseButton): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  scroll(_deltaX: number, _deltaY: number): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  typeText(_text: string): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  pressKey(_key: KeyInput): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  screenshot(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  snapshotDocument(expected: { readonly seq: number; readonly url: string }) {
    if (expected.seq !== this.current.seq || expected.url !== this.current.url) {
      return Promise.reject(new LiveBrowserError("stale_frame", "stale", 409));
    }
    return Promise.resolve({
      schemaVersion: "ontocopilot.live-browser-text/1" as const,
      browserSessionId: this.browserSessionId,
      seq: this.current.seq,
      url: this.current.url,
      title: this.current.title,
      paragraphs: [{ text: "Dynamic visible content", ordinal: 0 }],
      capturedAt: "2026-08-31T04:00:00.000Z",
    });
  }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

class FakeProvider implements LiveBrowserProvider {
  readonly tabs: FakeTab[] = [];
  shutdownCalled = false;

  capabilities(): LiveBrowserCapabilities {
    return { available: true, features: ["navigate", "screenshot"] };
  }

  async open(options: LiveBrowserOpenOptions): Promise<LiveBrowserTabHandle> {
    const tab = new FakeTab(options);
    this.tabs.push(tab);
    return tab;
  }

  shutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }
}

describe("Live Browser public-network policy", () => {
  it("never serializes Chromium internal error pages as a successful frame", () => {
    expect(() => assertLiveBrowserCommittedPage(
      "chrome-error://chromewebdata/",
      "net::ERR_CONNECTION_CLOSED",
    )).toThrowError(expect.objectContaining({
      code: "browser_navigation_failed",
      status: 502,
      message: "net::ERR_CONNECTION_CLOSED",
    }));
    expect(() => assertLiveBrowserCommittedPage(
      "about:blank",
      "Navigation timeout of 30000 ms exceeded",
    )).toThrowError(expect.objectContaining({ code: "browser_navigation_timeout", status: 504 }));
    expect(() => assertLiveBrowserCommittedPage("https://github.com/openai/"))
      .not.toThrow();
  });

  it("treats only a committed, visibly usable HTTP page as a soft navigation timeout", () => {
    const timeout = new Error("Navigation timeout of 30000 ms exceeded");
    timeout.name = "TimeoutError";
    expect(isSoftLiveBrowserNavigationTimeout(timeout, {
      url: "https://github.com/openai/",
      readyState: "interactive",
      hasVisibleContent: true,
    })).toBe(true);
    expect(isSoftLiveBrowserNavigationTimeout(timeout, {
      url: "https://github.com/openai/",
      readyState: "complete",
      hasVisibleContent: true,
    })).toBe(true);
  });

  it("keeps real failures, blank documents and uncommitted pages visible", () => {
    const timeout = new Error("Navigation timeout of 30000 ms exceeded");
    timeout.name = "TimeoutError";
    expect(isSoftLiveBrowserNavigationTimeout(new Error("net::ERR_FAILED"), {
      url: "https://example.com/",
      readyState: "complete",
      hasVisibleContent: true,
    })).toBe(false);
    expect(isSoftLiveBrowserNavigationTimeout(timeout, {
      url: "https://example.com/",
      readyState: "complete",
      hasVisibleContent: false,
    })).toBe(false);
    expect(isSoftLiveBrowserNavigationTimeout(timeout, {
      url: "https://example.com/",
      readyState: "loading",
      hasVisibleContent: true,
    })).toBe(false);
    expect(isSoftLiveBrowserNavigationTimeout(timeout, {
      url: "chrome-error://chromewebdata/",
      readyState: "complete",
      hasVisibleContent: true,
    })).toBe(false);
  });

  it("allows only http(s), strips fragments, and accepts only all-public DNS answers", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const result = await validatedLiveBrowserUrl("https://docs.example/guide?q=1#secret", resolver);
    expect(result.url.toString()).toBe("https://docs.example/guide?q=1");
    expect(result.addresses).toHaveLength(1);
    expect(resolver).toHaveBeenCalledWith("docs.example");

    await expect(validatedLiveBrowserUrl("file:///etc/passwd", resolver)).rejects.toMatchObject({
      code: "blocked_scheme",
      status: 403,
    });
    await expect(validatedLiveBrowserUrl("https://docs.example:8443/", resolver)).rejects.toMatchObject({
      code: "blocked_port",
      status: 403,
    });
  });

  it("fails closed for localhost, metadata and any mixed/private DNS answer", async () => {
    await expect(validatedLiveBrowserUrl("http://localhost/", async () => [{
      address: "8.8.8.8", family: 4,
    }])).rejects.toBeInstanceOf(LiveBrowserError);
    await expect(validatedLiveBrowserUrl("http://169.254.169.254/latest/meta-data", async () => [{
      address: "169.254.169.254", family: 4,
    }])).rejects.toMatchObject({ code: "blocked_address" });
    await expect(validatedLiveBrowserUrl("https://split.example/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ])).rejects.toMatchObject({ code: "blocked_address", status: 403 });
  });

  it("allows public SPA reads, EventSource, dedicated-worker scripts and bounded GraphQL POST", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const base = {
      navigation: false,
      topLevelUrl: "https://app.example/",
    };
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://cdn.example/worker.js",
      method: "GET",
      resourceType: "script",
    }, resolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://app.example/events",
      method: "GET",
      resourceType: "eventsource",
    }, resolver)).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://app.example/graphql",
      method: "POST",
      resourceType: "fetch",
      bodyBytes: 1_024,
    }, resolver)).resolves.toBeUndefined();
  });

  it("keeps WebSocket, navigational/form POST, mutations and oversized SPA bodies blocked", async () => {
    const resolver = async () => [{ address: "8.8.8.8", family: 4 as const }];
    const base = { topLevelUrl: "https://app.example/" };
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "wss://app.example/socket",
      method: "GET",
      resourceType: "websocket",
      navigation: false,
    }, resolver)).rejects.toMatchObject({ code: "blocked_websocket" });
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://app.example/submit",
      method: "POST",
      resourceType: "document",
      navigation: true,
      bodyBytes: 20,
    }, resolver)).rejects.toMatchObject({ code: "blocked_method" });
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://app.example/graphql",
      method: "POST",
      resourceType: "xhr",
      navigation: false,
      bodyBytes: LIVE_BROWSER_POST_MAX_BYTES + 1,
    }, resolver)).rejects.toMatchObject({ code: "post_too_large" });
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://app.example/item",
      method: "DELETE",
      resourceType: "fetch",
      navigation: false,
    }, resolver)).rejects.toMatchObject({ code: "blocked_method" });
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "https://api.example/graphql",
      method: "POST",
      resourceType: "fetch",
      navigation: false,
      bodyBytes: 100,
    }, resolver)).rejects.toMatchObject({ code: "blocked_cross_origin_post" });
  });

  it("allows bounded data resources and same-origin blob modules without opening a network bypass", async () => {
    const base = { method: "GET", navigation: false, topLevelUrl: "https://app.example/page" };
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "data:image/svg+xml,<svg/>",
      resourceType: "image",
    })).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "blob:https://app.example/99a4d456",
      resourceType: "script",
    })).resolves.toBeUndefined();
    await expect(validateLiveBrowserRequest({
      ...base,
      url: "blob:https://evil.example/99a4d456",
      resourceType: "script",
    })).rejects.toMatchObject({ code: "blocked_local_resource" });
    await expect(validateLiveBrowserRequest({
      ...base,
      url: `data:text/plain,${"x".repeat(LIVE_BROWSER_DATA_URL_MAX_CHARS)}`,
      resourceType: "other",
    })).rejects.toMatchObject({ code: "blocked_local_resource" });
  });
});

describe("LiveBrowserRuntime", () => {
  it("times out a hanging provider, releases its reservation, supports retry, and closes a late tab", async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    const originalOpen = provider.open.bind(provider);
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    provider.open = vi.fn(async (options: LiveBrowserOpenOptions) => {
      if (calls++ > 0) return await originalOpen(options);
      await firstGate;
      return await originalOpen(options);
    });
    const runtime = new LiveBrowserRuntime({
      provider,
      maxTabs: 1,
      providerOpenTimeoutMs: 50,
      startReaper: false,
    });
    try {
      const opening = runtime.open("session-a", "https://a.example/");
      const timedOut = expect(opening).rejects.toMatchObject({
        code: "browser_provider_timeout",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(51);
      await timedOut;
      expect(runtime.list("session-a")).toEqual([]);

      // The failed reservation cannot keep maxTabs occupied.
      const retried = await runtime.open("session-a", "https://retry.example/");
      expect(retried.state.url).toBe("https://retry.example/");

      releaseFirst();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      const late = provider.tabs.find((tab) => tab.browserSessionId !== retried.state.browserSessionId);
      expect(late?.closed).toBe(true);
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("times out a hanging screenshot, evicts the broken tab, and permits a fresh retry", async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    const runtime = new LiveBrowserRuntime({
      provider,
      actionTimeoutMs: 50,
      startReaper: false,
    });
    try {
      const opened = await runtime.open("session-a", "https://a.example/");
      const tab = provider.tabs[0]!;
      let releaseScreenshot = (_snapshot: LiveBrowserSnapshot): void => undefined;
      tab.screenshot = vi.fn(() => new Promise<LiveBrowserSnapshot>((resolve) => {
        releaseScreenshot = resolve;
      }));
      const screenshot = runtime.action("session-a", opened.state.browserSessionId, (handle) => handle.screenshot());
      const timedOut = expect(screenshot).rejects.toMatchObject({
        code: "browser_action_timeout",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(51);
      await timedOut;
      expect(tab.closed).toBe(true);
      expect(runtime.list("session-a")).toEqual([]);

      const retried = await runtime.open("session-a", "https://retry.example/");
      expect(retried.state.url).toBe("https://retry.example/");
      releaseScreenshot({ state: tab.state(), png: PNG });
      await Promise.resolve();
      expect(tab.closed).toBe(true);
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("gives top-level navigation its own longer deadline while interactions keep the short limit", async () => {
    vi.useFakeTimers();
    const provider = new FakeProvider();
    const runtime = new LiveBrowserRuntime({
      provider,
      actionTimeoutMs: 10,
      navigationActionTimeoutMs: 50,
      startReaper: false,
    });
    try {
      const opened = await runtime.open("session-a", "https://a.example/");
      const tab = provider.tabs[0]!;
      tab.navigate = vi.fn(() => new Promise<LiveBrowserSnapshot>(() => undefined));
      const navigation = runtime.action(
        "session-a",
        opened.state.browserSessionId,
        (handle) => handle.navigate("https://b.example/"),
        { kind: "navigation" },
      );
      const timedOut = expect(navigation).rejects.toMatchObject({
        code: "browser_action_timeout",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(11);
      expect(tab.closed).toBe(false);
      expect(runtime.list("session-a")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(40);
      await timedOut;
      expect(tab.closed).toBe(true);
      expect(runtime.list("session-a")).toEqual([]);
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });

  it("rejects and closes a provider tab that resolves to chrome-error instead of wiring success", async () => {
    const provider = new FakeProvider();
    const originalOpen = provider.open.bind(provider);
    let invalid = true;
    provider.open = vi.fn(async (options: LiveBrowserOpenOptions) => {
      const tab = await originalOpen(options);
      if (invalid) {
        const validState = tab.state();
        tab.state = () => ({
          ...validState,
          url: "chrome-error://chromewebdata/",
          error: "net::ERR_CONNECTION_CLOSED",
        });
      }
      return tab;
    });
    const runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    await expect(runtime.open("session-a", "https://a.example/"))
      .rejects.toMatchObject({ code: "browser_navigation_failed", status: 502 });
    expect(provider.tabs[0]?.closed).toBe(true);
    expect(runtime.list("session-a")).toEqual([]);
    invalid = false;
    await expect(runtime.open("session-a", "https://retry.example/"))
      .resolves.toMatchObject({ state: { url: "https://retry.example/" } });
    await runtime.shutdown();
  });

  it("isolates tabs by OntoCopilot session and closes idle contexts", async () => {
    const provider = new FakeProvider();
    let now = 1_000;
    const runtime = new LiveBrowserRuntime({
      provider,
      now: () => now,
      idleTtlMs: 50,
      startReaper: false,
    });
    const first = await runtime.open("session-a", "https://a.example/");
    const second = await runtime.open("session-b", "https://b.example/", { width: 900, height: 600 });
    expect(runtime.list("session-a").map((row) => row.browserSessionId)).toEqual([
      first.state.browserSessionId,
    ]);
    expect(runtime.list("session-b")[0]).toMatchObject({ width: 900, height: 600 });
    expect(() => runtime.get("session-a", second.state.browserSessionId)).toThrowError(LiveBrowserError);

    now += 51;
    expect(await runtime.closeExpired()).toBe(2);
    expect(provider.tabs.every((tab) => tab.closed)).toBe(true);
    await runtime.shutdown();
    expect(provider.shutdownCalled).toBe(true);
  });

  it("reserves capacity before async browser creation, preventing concurrent max-tab bypass", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = new FakeProvider();
    const originalOpen = provider.open.bind(provider);
    provider.open = vi.fn(async (options: LiveBrowserOpenOptions) => {
      await gate;
      return await originalOpen(options);
    });
    const runtime = new LiveBrowserRuntime({ provider, maxTabs: 1, startReaper: false });
    const first = runtime.open("session-a", "https://a.example/");
    await Promise.resolve();
    await expect(runtime.open("session-a", "https://b.example/")).rejects.toMatchObject({
      code: "too_many_tabs",
      status: 409,
    });
    release();
    await first;
    await runtime.shutdown();
  });

  it("cancels an in-flight open when its OntoCopilot session is closed", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = new FakeProvider();
    const originalOpen = provider.open.bind(provider);
    provider.open = vi.fn(async (options: LiveBrowserOpenOptions) => {
      await gate;
      return await originalOpen(options);
    });
    const runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    const opening = runtime.open("session-a", "https://a.example/");
    await Promise.resolve();
    const closing = runtime.closeSession("session-a");
    release();
    await expect(opening).rejects.toMatchObject({ code: "browser_cancelled", status: 409 });
    await closing;
    expect(provider.tabs[0]?.closed).toBe(true);
    expect(runtime.list("session-a")).toEqual([]);
    await expect(runtime.open("session-a", "https://late.example/"))
      .rejects.toMatchObject({ code: "browser_cancelled", status: 409 });
    expect(provider.tabs).toHaveLength(1);
    await runtime.shutdown();
  });
});

describe("ChromiumLiveBrowserProvider lifecycle", () => {
  it("bounds a hanging launch during shutdown and closes the browser if launch resolves late", async () => {
    vi.useFakeTimers();
    let resolveLaunch = (_browser: Browser): void => undefined;
    const launch = new Promise<Browser>((resolve) => { resolveLaunch = resolve; });
    const provider = new ChromiumLiveBrowserProvider();
    (provider as unknown as { starting: Promise<Browser> | null }).starting = launch;
    const lateClose = vi.fn(() => Promise.resolve());
    const lateBrowser = {
      close: lateClose,
      process: () => null,
    } as unknown as Browser;
    try {
      const shutdown = provider.shutdown();
      const completed = expect(shutdown).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(LIVE_BROWSER_SHUTDOWN_TIMEOUT_MS + 1);
      await completed;

      resolveLaunch(lateBrowser);
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      expect(lateClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Live Browser routes", () => {
  let repo: MemoryRepo;
  let provider: FakeProvider;
  let runtime: LiveBrowserRuntime;
  let app: Hono<AppEnv>;
  let failureLogger: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repo = new MemoryRepo();
    setRepoForTests(repo);
    await repo.createSession(makeSessionRow({ id: "live-session", owner: "fde-1", title: "Live" }));
    provider = new FakeProvider();
    runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    failureLogger = vi.fn();
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-test-user") || "fde-1" });
      await next();
    });
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
    });
    registerLiveBrowserRoutes(app, { runtime, failureLogger });
  });

  afterEach(async () => {
    await runtime.shutdown();
    setRepoForTests(null);
  });

  async function open(): Promise<Record<string, any>> {
    const response = await app.request("http://onto.local/api/sessions/live-session/live-browser/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://onto.local" },
      body: JSON.stringify({ url: "https://www.palantir.com/", viewport: { width: 1024, height: 720 } }),
    });
    expect(response.status).toBe(201);
    return await response.json() as Record<string, any>;
  }

  it("returns same-origin frame URLs and no-store PNG frames", async () => {
    const opened = await open();
    expect(opened.browser).toMatchObject({
      url: "https://www.palantir.com/",
      width: 1024,
      height: 720,
      seq: 1,
    });
    expect(opened.browser.frameUrl).toMatch(
      /^\/api\/sessions\/live-session\/live-browser\/sessions\/browser_[a-f0-9]{24}\/frame\?seq=1$/u,
    );
    const frame = await app.request(`http://onto.local${opened.browser.frameUrl}`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(frame.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(PNG);
  });

  it("never serves newer pixels under a stale frame URL and recovers on the next current URL", async () => {
    const opened = await open();
    const id = opened.browser.browserSessionId as string;
    const originalFrameUrl = opened.browser.frameUrl as string;

    const foreign = await app.request(`http://onto.local${originalFrameUrl}`, {
      headers: { "x-test-user": "fde-2" },
    });
    expect(foreign.status).toBe(404);

    const refreshed = await app.request(
      `http://onto.local/api/sessions/live-session/live-browser/sessions/${id}/screenshot`,
      { method: "POST", headers: { origin: "http://onto.local" } },
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json() as Record<string, any>;
    expect(refreshedBody.browser.seq).toBe(2);

    const stale = await app.request(`http://onto.local${originalFrameUrl}`);
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).not.toContain("image/png");

    // This is the URL published by the next screenshot/state poll after the stale image failed.
    const current = await app.request(`http://onto.local${String(refreshedBody.browser.frameUrl)}`);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await current.arrayBuffer())).toEqual(PNG);
  });

  it("requires exactly one canonical positive integer frame seq", async () => {
    const opened = await open();
    const id = opened.browser.browserSessionId as string;
    const base = `http://onto.local/api/sessions/live-session/live-browser/sessions/${id}/frame`;
    for (const query of ["", "?seq=", "?seq=0", "?seq=-1", "?seq=1.5", "?seq=01", "?seq=1&seq=1"]) {
      const response = await app.request(`${base}${query}`);
      expect(response.status, query || "missing seq").toBe(422);
    }
  });

  it("enforces ownership and same-origin CSRF checks on every mutation", async () => {
    const foreign = await app.request("http://onto.local/api/sessions/live-session/live-browser/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(foreign.status).toBe(403);

    const missingOrigin = await app.request("http://onto.local/api/sessions/live-session/live-browser/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(missingOrigin.status).toBe(403);

    const otherOwner = await app.request("http://onto.local/api/sessions/live-session/live-browser/capabilities", {
      headers: { "x-test-user": "fde-2" },
    });
    expect(otherOwner.status).toBe(404);
  });

  it("closes a tab whose client aborts before the open response is delivered", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://onto.local/api/sessions/live-session/live-browser/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://onto.local" },
      body: JSON.stringify({ url: "https://example.com" }),
      signal: controller.signal,
    });
    const response = await app.request(request);
    expect(response.status).toBe(409);
    expect(provider.tabs[0]?.closed).toBe(true);
    expect(runtime.list("live-session")).toEqual([]);
  });

  it("returns an explicit retryable 504 instead of leaving a hanging provider request open", async () => {
    vi.useFakeTimers();
    provider.open = vi.fn(() => new Promise<LiveBrowserTabHandle>(() => undefined));
    await runtime.shutdown();
    runtime = new LiveBrowserRuntime({
      provider,
      providerOpenTimeoutMs: 50,
      startReaper: false,
    });
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "fde-1" });
      await next();
    });
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
    });
    registerLiveBrowserRoutes(app, { runtime, failureLogger });
    try {
      const responsePromise = app.request("http://onto.local/api/sessions/live-session/live-browser/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://onto.local" },
        body: JSON.stringify({ url: "https://github.com/" }),
      });
      await vi.advanceTimersByTimeAsync(51);
      const response = await responsePromise;
      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining("请重试"),
        message: expect.stringContaining("请重试"),
        code: "browser_provider_timeout",
      });
      expect(failureLogger).toHaveBeenCalledWith(expect.objectContaining({
        event: "live_browser.failure",
        sid: "live-session",
        action: "open",
        host: "github.com",
        code: "browser_provider_timeout",
        status: 504,
        elapsed_ms: expect.any(Number),
      }));
      expect(runtime.list("live-session")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves navigation error codes and logs only a credential-free host", async () => {
    const opened = await open();
    const id = opened.browser.browserSessionId as string;
    provider.tabs[0]!.navigate = vi.fn(async () => {
      throw new LiveBrowserError("browser_navigation_failed", "upstream connect failed", 502);
    });
    const response = await app.request(
      `http://onto.local/api/sessions/live-session/live-browser/sessions/${id}/navigate`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://onto.local" },
        body: JSON.stringify({ url: "https://user:secret@docs.example/private?token=abc" }),
      },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      detail: "upstream connect failed",
      message: "upstream connect failed",
      code: "browser_navigation_failed",
    });
    expect(failureLogger).toHaveBeenCalledTimes(1);
    const event = failureLogger.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "live_browser.failure",
      sid: "live-session",
      action: "navigate",
      host: "docs.example",
      code: "browser_navigation_failed",
      status: 502,
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("token");
    expect(JSON.stringify(event)).not.toContain(id);
  });

  it("exposes navigation/input actions without returning third-party HTML", async () => {
    const opened = await open();
    const id = opened.browser.browserSessionId as string;
    const navigate = await app.request(
      `http://onto.local/api/sessions/live-session/live-browser/sessions/${id}/navigate`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://onto.local" },
        body: JSON.stringify({ url: "https://example.com/next" }),
      },
    );
    expect(navigate.status).toBe(200);
    const navigationBody = await navigate.json() as any;
    expect(navigationBody.browser).toMatchObject({
      url: "https://example.com/next",
      canGoBack: true,
      seq: 2,
    });
    expect(JSON.stringify(navigationBody)).not.toContain("<html");

    const key = await app.request(
      `http://onto.local/api/sessions/live-session/live-browser/sessions/${id}/key`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://onto.local" },
        body: JSON.stringify({ text: "采购申请" }),
      },
    );
    expect(key.status).toBe(200);
  });
});
