/** Same-origin API surface for the isolated Live Browser Runtime. */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { KeyInput, MouseButton } from "puppeteer-core";

import type { AppEnv } from "../app.js";
import { isolate, ownerId } from "../app.js";
import {
  LiveBrowserError,
  liveBrowserRuntime,
  type LiveBrowserRuntime,
  type LiveBrowserSnapshot,
  type LiveBrowserState,
} from "../live_browser.js";
import { currentRepo } from "../session.js";
import { apiError, jsonBody } from "./sessions.js";

export interface LiveBrowserRouteDeps {
  readonly runtime?: LiveBrowserRuntime;
  /** Test seam and deployment hook for failure-only structured telemetry. */
  readonly failureLogger?: LiveBrowserFailureLogger;
}

export interface LiveBrowserFailureEvent {
  readonly event: "live_browser.failure";
  readonly sid: string;
  readonly action: string;
  readonly host: string;
  readonly code: string;
  readonly status: number;
  readonly elapsed_ms: number;
}

export type LiveBrowserFailureLogger = (event: LiveBrowserFailureEvent) => void;

function text(value: unknown, max = 4_096): string {
  const normalized = String(value ?? "").replace(/\u0000/gu, "").trim();
  return [...normalized].length <= max ? normalized : [...normalized].slice(0, max).join("");
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function browserId(c: Context<AppEnv>): string {
  const value = c.req.param("browserSessionId") ?? "";
  if (!/^browser_[a-f0-9]{24}$/u.test(value)) throw apiError(404, "没有这个 Live Browser 页面");
  return value;
}

function requestedFrameSeq(c: Context<AppEnv>): number {
  let values: string[];
  try {
    values = new URL(c.req.url).searchParams.getAll("seq");
  } catch {
    throw apiError(422, "frame seq 无效");
  }
  if (values.length !== 1 || !/^[1-9]\d*$/u.test(values[0] ?? "")) {
    throw apiError(422, "frame 必须提供一个正整数 seq");
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) throw apiError(422, "frame seq 超出安全整数范围");
  return value;
}

/**
 * Browser mutation endpoints intentionally do not accept configured cross-origin CORS callers.
 * Missing Origin remains allowed for same-host native/CLI clients; a browser supplied Origin or
 * Sec-Fetch-Site must prove same-origin.  This protects cookie-authenticated sessions from CSRF.
 */
function requireSameOrigin(c: Context<AppEnv>): void {
  const fetchSite = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw apiError(403, "Live Browser 控制接口只接受同源请求");
  }
  const raw = c.req.header("origin");
  // Browser mutations carry Origin. A non-browser/native caller may omit it only when it
  // explicitly identifies a user-initiated top-level request (`Sec-Fetch-Site: none`).
  if (!raw) {
    if (fetchSite === "none") return;
    throw apiError(403, "Live Browser 控制接口缺少可验证的同源来源");
  }
  let expected: string;
  try {
    expected = new URL(c.req.url).origin;
  } catch {
    throw apiError(403, "无法校验 Live Browser 请求来源");
  }
  if (raw !== expected) throw apiError(403, "Live Browser 控制接口只接受同源请求");
}

async function scopedSessionId(c: Context<AppEnv>): Promise<string> {
  const sid = c.req.param("sid") ?? "";
  const row = await currentRepo().getSession(sid);
  if (row === null || (isolate(c) && (row.owner || "") !== ownerId(c))) {
    // Nonexistent and unauthorized are deliberately indistinguishable.
    throw apiError(404, `没有会话 ${sid}`);
  }
  return sid;
}

function liveBrowserApiError(error: LiveBrowserError): HTTPException {
  const body = {
    // Preserve the FastAPI-compatible `detail` field while exposing a stable machine code.
    detail: error.message,
    message: error.message,
    code: error.code,
  };
  return new HTTPException(error.status as ContentfulStatusCode, {
    message: error.message,
    res: new Response(JSON.stringify(body), {
      status: error.status,
      headers: { "content-type": "application/json" },
    }),
  });
}

function safeHost(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return text(url.hostname.toLowerCase().replace(/\.$/u, ""), 253);
  } catch {
    return "";
  }
}

function defaultFailureLogger(event: LiveBrowserFailureEvent): void {
  // Keep the line safe for central collection: no path/query, browser id, exception text or stack.
  console.error(JSON.stringify(event));
}

interface GuardedOperation {
  readonly sid: string;
  readonly action: string;
  readonly host?: string;
}

async function guarded<T>(
  operation: GuardedOperation,
  failureLogger: LiveBrowserFailureLogger,
  body: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await body();
  } catch (error) {
    const status = error instanceof LiveBrowserError ? error.status : 500;
    const code = error instanceof LiveBrowserError ? error.code : "internal_error";
    try {
      failureLogger({
        event: "live_browser.failure",
        sid: text(operation.sid, 128),
        action: text(operation.action, 64),
        host: safeHost(operation.host ?? ""),
        code: text(code, 128),
        status,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
      });
    } catch {
      // Telemetry must never replace the browser error returned to the caller.
    }
    if (error instanceof LiveBrowserError) throw liveBrowserApiError(error);
    throw error;
  }
}

function currentHost(runtime: LiveBrowserRuntime, sid: string, browserSessionId: string): string {
  try {
    return safeHost(runtime.get(sid, browserSessionId).state.url);
  } catch {
    return "";
  }
}

function wireState(sid: string, state: LiveBrowserState): Record<string, unknown> {
  return {
    ...state,
    frameUrl: `/api/sessions/${encodeURIComponent(sid)}/live-browser/sessions/` +
      `${encodeURIComponent(state.browserSessionId)}/frame?seq=${state.seq}`,
  };
}

function wireSnapshot(sid: string, snapshot: LiveBrowserSnapshot): Record<string, unknown> {
  return { browser: wireState(sid, snapshot.state) };
}

function pngBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function registerLiveBrowserRoutes(
  app: Hono<AppEnv>,
  deps: LiveBrowserRouteDeps = {},
): void {
  const runtime = deps.runtime ?? liveBrowserRuntime;
  const failureLogger = deps.failureLogger ?? defaultFailureLogger;

  app.get("/api/sessions/:sid/live-browser/capabilities", async (c) => {
    await scopedSessionId(c);
    return c.json(runtime.capabilities());
  });

  app.get("/api/sessions/:sid/live-browser/sessions", async (c) => {
    const sid = await scopedSessionId(c);
    return c.json({ browsers: runtime.list(sid).map((state) => wireState(sid, state)) });
  });

  app.post("/api/sessions/:sid/live-browser/sessions", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const body = await jsonBody(c);
    const url = text(body["url"]);
    if (!url) throw apiError(422, "url 不能为空");
    const rawViewport = body["viewport"];
    const viewport = rawViewport !== null && typeof rawViewport === "object" && !Array.isArray(rawViewport)
      ? {
        width: number((rawViewport as Record<string, unknown>)["width"]),
        height: number((rawViewport as Record<string, unknown>)["height"]),
      }
      : undefined;
    const opened = await guarded(
      { sid, action: "open", host: url },
      failureLogger,
      () => runtime.open(sid, url, viewport),
    );
    // If the client left while Chromium was starting/navigating, no UI can learn the generated id.
    // Close immediately instead of consuming the per-session/global tab quota until TTL.
    if (c.req.raw.signal.aborted) {
      await runtime.close(sid, opened.state.browserSessionId);
      throw apiError(409, "Live Browser 请求已取消");
    }
    return c.json(wireSnapshot(sid, opened), 201);
  });

  app.get("/api/sessions/:sid/live-browser/sessions/:browserSessionId", async (c) => {
    const sid = await scopedSessionId(c);
    const snapshot = await guarded(
      { sid, action: "get" },
      failureLogger,
      () => runtime.get(sid, browserId(c)),
    );
    return c.json(wireSnapshot(sid, snapshot));
  });

  app.get("/api/sessions/:sid/live-browser/sessions/:browserSessionId/frame", async (c) => {
    const sid = await scopedSessionId(c);
    const expectedSeq = requestedFrameSeq(c);
    const snapshot = await guarded(
      { sid, action: "frame" },
      failureLogger,
      () => runtime.get(sid, browserId(c)),
    );
    // `frameUrl` is a versioned capability: never serve newer pixels under an older state/URL.
    // The UI's next state poll publishes a fresh URL and naturally recovers from this 409.
    if (snapshot.state.seq !== expectedSeq) {
      throw apiError(409, "Live Browser 画面版本已经过期，请刷新页面状态");
    }
    return new Response(pngBody(snapshot.png), {
      status: 200,
      headers: {
        "cache-control": "private, no-store, no-cache, must-revalidate",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-type": "image/png",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  });

  app.delete("/api/sessions/:sid/live-browser/sessions/:browserSessionId", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const id = browserId(c);
    await guarded(
      { sid, action: "close", host: currentHost(runtime, sid, id) },
      failureLogger,
      () => runtime.close(sid, id),
    );
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sid/live-browser/sessions/:browserSessionId/navigate", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const id = browserId(c);
    const body = await jsonBody(c);
    const url = text(body["url"]);
    if (!url) throw apiError(422, "url 不能为空");
    const result = await guarded(
      { sid, action: "navigate", host: url },
      failureLogger,
      () => runtime.action(
        sid,
        id,
        (tab) => tab.navigate(url),
        { kind: "navigation" },
      ),
    );
    return c.json(wireSnapshot(sid, result));
  });

  const simpleAction = (
    path: "back" | "forward" | "reload" | "screenshot",
    action: (tab: Parameters<LiveBrowserRuntime["action"]>[2] extends (tab: infer T) => unknown ? T : never) => Promise<LiveBrowserSnapshot>,
    kind: "interaction" | "navigation" = "interaction",
  ): void => {
    app.post(`/api/sessions/:sid/live-browser/sessions/:browserSessionId/${path}`, async (c) => {
      requireSameOrigin(c);
      const sid = await scopedSessionId(c);
      const id = browserId(c);
      const result = await guarded(
        { sid, action: path, host: currentHost(runtime, sid, id) },
        failureLogger,
        () => runtime.action(sid, id, action, { kind }),
      );
      return c.json(wireSnapshot(sid, result));
    });
  };
  simpleAction("back", (tab) => tab.back(), "navigation");
  simpleAction("forward", (tab) => tab.forward(), "navigation");
  simpleAction("reload", (tab) => tab.reload(), "navigation");
  simpleAction("screenshot", (tab) => tab.screenshot());

  app.post("/api/sessions/:sid/live-browser/sessions/:browserSessionId/pointer", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const id = browserId(c);
    const body = await jsonBody(c);
    if (body["action"] !== "click") throw apiError(422, "pointer.action 只支持 click");
    const button = text(body["button"], 16) || "left";
    if (!["left", "middle", "right"].includes(button)) throw apiError(422, "不支持这个鼠标按钮");
    const result = await guarded(
      { sid, action: "pointer.click", host: currentHost(runtime, sid, id) },
      failureLogger,
      () => runtime.action(
        sid,
        id,
        (tab) => tab.click(number(body["x"]), number(body["y"]), button as MouseButton),
      ),
    );
    return c.json(wireSnapshot(sid, result));
  });

  app.post("/api/sessions/:sid/live-browser/sessions/:browserSessionId/scroll", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const id = browserId(c);
    const body = await jsonBody(c);
    const result = await guarded(
      { sid, action: "scroll", host: currentHost(runtime, sid, id) },
      failureLogger,
      () => runtime.action(
        sid,
        id,
        (tab) => tab.scroll(number(body["deltaX"] ?? 0), number(body["deltaY"] ?? 0)),
      ),
    );
    return c.json(wireSnapshot(sid, result));
  });

  app.post("/api/sessions/:sid/live-browser/sessions/:browserSessionId/key", async (c) => {
    requireSameOrigin(c);
    const sid = await scopedSessionId(c);
    const id = browserId(c);
    const body = await jsonBody(c);
    const typed = typeof body["text"] === "string" ? body["text"] : "";
    const key = text(body["key"], 40);
    if ((typed && key) || (!typed && !key)) throw apiError(422, "请只提供 text 或 key 其中一个");
    const result = await guarded(
      { sid, action: typed ? "key.type" : "key.press", host: currentHost(runtime, sid, id) },
      failureLogger,
      () => runtime.action(
        sid,
        id,
        (tab) => typed ? tab.typeText(typed) : tab.pressKey(key as KeyInput),
      ),
    );
    return c.json(wireSnapshot(sid, result));
  });
}
