import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyInput, MouseButton } from "puppeteer-core";

import { AssetMemory } from "../src/onto/asset_memory.js";
import type { AppEnv } from "../src/server/app.js";
import {
  LIVE_BROWSER_SCHEMA_VERSION,
  LiveBrowserError,
  LiveBrowserRuntime,
  type LiveBrowserCapabilities,
  type LiveBrowserOpenOptions,
  type LiveBrowserProvider,
  type LiveBrowserSnapshot,
  type LiveBrowserState,
  type LiveBrowserTabHandle,
} from "../src/server/live_browser.js";
import {
  LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS,
  LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
  LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION,
  liveBrowserDocumentPage,
} from "../src/server/live_browser_snapshot.js";
import { registerWebPreviewRoutes } from "../src/server/routes/web-preview.js";
import { Session, SESSIONS } from "../src/server/session.js";
import { setRepoForTests } from "../src/store/deps.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeSessionRow } from "../src/store/types.js";

const FRAME = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const A = "https://app.example/purchase";
const B = "https://app.example/expense";

class SpaTab implements LiveBrowserTabHandle {
  private value: LiveBrowserState;
  private visible: string[] = ["Static application shell"];

  constructor(readonly browserSessionId: string, url: string) {
    this.value = {
      schemaVersion: LIVE_BROWSER_SCHEMA_VERSION,
      browserSessionId,
      url,
      title: "SPA shell",
      width: 1280,
      height: 800,
      seq: 1,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      updatedAt: "2026-08-31T15:00:00.000Z",
    };
  }

  hydrate(title: string, paragraphs: string[]): void {
    this.value = { ...this.value, title };
    this.visible = paragraphs;
  }

  private next(patch: Partial<LiveBrowserState> = {}): LiveBrowserSnapshot {
    this.value = {
      ...this.value,
      ...patch,
      seq: this.value.seq + 1,
      updatedAt: `2026-08-31T15:00:0${this.value.seq}.000Z`,
    };
    return { state: this.value, png: FRAME };
  }

  state(): LiveBrowserState { return this.value; }
  frame(): Uint8Array { return FRAME; }
  navigate(url: string): Promise<LiveBrowserSnapshot> {
    this.visible = url === B ? ["Employee submits expense claim.", "Finance checks the invoice."] : ["Page A"];
    return Promise.resolve(this.next({ url, title: url === B ? "Expense SPA" : "Page A", canGoBack: true }));
  }
  back(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  forward(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  reload(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  click(_x: number, _y: number, _button?: MouseButton): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  scroll(_x: number, _y: number): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  typeText(_text: string): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  pressKey(_key: KeyInput): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  screenshot(): Promise<LiveBrowserSnapshot> { return Promise.resolve(this.next()); }
  async snapshotDocument(expected: { readonly seq: number; readonly url: string }) {
    if (expected.seq !== this.value.seq || expected.url !== this.value.url) {
      throw new LiveBrowserError("stale_frame", "网页已经变化，请刷新", 409);
    }
    return {
      schemaVersion: LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION,
      browserSessionId: this.browserSessionId,
      seq: this.value.seq,
      url: this.value.url,
      title: this.value.title,
      paragraphs: this.visible.map((text, ordinal) => ({ text, ordinal, y: 100 + ordinal * 40 })),
      capturedAt: "2026-08-31T15:00:10.000Z",
    };
  }
  close(): Promise<void> { return Promise.resolve(); }
}

class SpaProvider implements LiveBrowserProvider {
  readonly tabs: SpaTab[] = [];
  capabilities(): LiveBrowserCapabilities { return { available: true, features: ["screenshot"] }; }
  async open(options: LiveBrowserOpenOptions): Promise<LiveBrowserTabHandle> {
    const tab = new SpaTab(options.browserSessionId, options.url);
    this.tabs.push(tab);
    return tab;
  }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

const originHeaders = {
  "content-type": "application/json",
  origin: "http://onto.local",
  "sec-fetch-site": "same-origin",
};

describe("Live Browser visible-DOM snapshot → AI summary", () => {
  let repo: MemoryRepo;
  let runtime: LiveBrowserRuntime;
  let provider: SpaProvider;
  let app: Hono<AppEnv>;
  let sessionA: Session;
  let sessionB: Session;
  let model: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repo = new MemoryRepo();
    setRepoForTests(repo);
    SESSIONS.clear();
    await repo.createSession(makeSessionRow({ id: "session-a", owner: "owner-a", title: "A" }));
    await repo.createSession(makeSessionRow({ id: "session-b", owner: "owner-b", title: "B" }));
    sessionA = new Session("session-a", { owner: "owner-a", title: "A" });
    sessionB = new Session("session-b", { owner: "owner-b", title: "B" });
    SESSIONS.set(sessionA.id, sessionA);
    SESSIONS.set(sessionB.id, sessionB);
    provider = new SpaProvider();
    runtime = new LiveBrowserRuntime({ provider, startReaper: false });
    model = vi.fn(async (_session: Session, request: Record<string, any>) => {
      const ids = request.semanticInput.citationIds as string[];
      return {
        title: "Current SPA summary",
        bullets: [{ text: "The rendered process is summarized.", citationIds: [ids[0]] }],
      };
    });
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: c.req.header("x-test-user") || "owner-a" });
      await next();
    });
    app.onError((error) => error instanceof HTTPException
      ? error.getResponse()
      : Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 }));
    registerWebPreviewRoutes(app, { liveBrowser: runtime, model });
  });

  afterEach(async () => {
    await runtime.shutdown();
    setRepoForTests(null);
    SESSIONS.clear();
  });

  async function freeze(
    sid: string,
    browserSessionId: string,
    seq: number,
    url: string,
    owner = "owner-a",
  ): Promise<Response> {
    return await app.request(`http://onto.local/api/sessions/${sid}/web/live-snapshots`, {
      method: "POST",
      headers: { ...originHeaders, "x-test-user": owner },
      body: JSON.stringify({ browserSessionId, seq, url }),
    });
  }

  it("summarizes late-rendered SPA text from the refreshed frame, then survives session restart", async () => {
    const opened = await runtime.open(sessionA.id, A);
    const tab = provider.tabs[0]!;
    tab.hydrate("Purchase approval SPA", [
      "Requester submits a purchase requisition.",
      "Budget owner approves the requisition.",
    ]);
    // The adaptive UI screenshot poll refreshes pixels/state after late client-side hydration.
    const refreshed = await runtime.action(sessionA.id, opened.state.browserSessionId, (current) => current.screenshot());
    expect(refreshed.state.seq).toBe(2);

    const response = await freeze(sessionA.id, refreshed.state.browserSessionId, refreshed.state.seq, A);
    expect(response.status).toBe(201);
    const page = (await response.json() as any).page;
    expect(page).toMatchObject({
      title: "Purchase approval SPA",
      finalUrl: A,
      status: "snapshot",
      paragraphs: [
        { text: "Requester submits a purchase requisition.", liveLocator: { seq: 2, ordinal: 0, y: 100 } },
        { text: "Budget owner approves the requisition.", liveLocator: { seq: 2, ordinal: 1, y: 140 } },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("<script");

    const summarized = await app.request(
      `http://onto.local/api/sessions/${sessionA.id}/web/pages/${page.id}/summarize`,
      { method: "POST", headers: { "content-type": "application/json", "x-test-user": "owner-a" }, body: "{}" },
    );
    expect(summarized.status).toBe(200);
    expect((await summarized.json() as any).summary.basedOn).toMatchObject({ pageId: page.id, digest: page.digest });
    expect(model.mock.calls[0]?.[1].prompt).toContain("Requester submits a purchase requisition.");
    expect(model.mock.calls[0]?.[1].prompt).not.toContain("Static application shell");
    expect(AssetMemory.fromDict(sessionA.state["asset_memory"]).list()
      .some((asset) => asset.metadata["pageId"] === page.id)).toBe(true);

    const durableState = await repo.loadState(sessionA.id);
    expect(JSON.stringify(durableState["web_pages"])).toContain("Budget owner approves");
    expect(durableState["asset_memory"]).toBeDefined();
    const restarted = new Session(sessionA.id, {
      owner: "owner-a",
      title: sessionA.title,
      state: JSON.parse(JSON.stringify(durableState)),
      stateVersion: sessionA.stateVersion,
    });
    SESSIONS.set(sessionA.id, restarted);
    sessionA = restarted;
    const restored = await app.request(
      `http://onto.local/api/sessions/${sessionA.id}/web/pages/${page.id}`,
      { headers: { "x-test-user": "owner-a" } },
    );
    expect(restored.status).toBe(200);
    expect((await restored.json() as any).page.paragraphs[1].text)
      .toBe("Budget owner approves the requisition.");
  });

  it("binds A→B navigation to current seq/URL and rejects stale, arbitrary and cross-session captures", async () => {
    const opened = await runtime.open(sessionA.id, A);
    const id = opened.state.browserSessionId;
    const navigated = await runtime.action(sessionA.id, id, (tab) => tab.navigate(B));

    expect((await freeze(sessionA.id, id, opened.state.seq, A)).status).toBe(409);
    expect((await freeze(sessionA.id, id, navigated.state.seq, A)).status).toBe(409);
    expect((await freeze(sessionA.id, id, navigated.state.seq, "https://evil.example/")).status).toBe(409);

    const current = await freeze(sessionA.id, id, navigated.state.seq, B);
    expect(current.status).toBe(201);
    const page = (await current.json() as any).page;
    expect(page.finalUrl).toBe(B);
    expect(page.paragraphs.map((row: any) => row.text)).toEqual([
      "Employee submits expense claim.", "Finance checks the invoice.",
    ]);

    // A valid browser id owned by session A is still undiscoverable from session B.
    expect((await freeze(sessionB.id, id, navigated.state.seq, B, "owner-b")).status).toBe(404);
    expect((await freeze(sessionA.id, id, navigated.state.seq, B, "owner-b")).status).toBe(404);
    const missingOrigin = await app.request(
      `http://onto.local/api/sessions/${sessionA.id}/web/live-snapshots`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ browserSessionId: id, seq: navigated.state.seq, url: B }) },
    );
    expect(missingOrigin.status).toBe(403);
  });
});

describe("Live Browser snapshot bounds", () => {
  it("double-cleans, deduplicates and enforces paragraph/character ceilings", () => {
    const page = liveBrowserDocumentPage({
      schemaVersion: LIVE_BROWSER_SNAPSHOT_SCHEMA_VERSION,
      browserSessionId: "browser_aaaaaaaaaaaaaaaaaaaaaaaa",
      seq: 7,
      url: A,
      title: "\u0000 Dynamic title ",
      paragraphs: Array.from({ length: 200 }, (_, index) => ({
        text: index === 1 ? "same" : index === 2 ? "same" : `${index}:${"x".repeat(5_000)}`,
        ordinal: index,
      })),
      capturedAt: "2026-08-31T15:00:00.000Z",
    });
    expect(page.paragraphs.length).toBeLessThanOrEqual(LIVE_BROWSER_SNAPSHOT_MAX_PARAGRAPHS);
    expect(page.paragraphs.reduce((total, row) => total + [...row.text].length, 0))
      .toBeLessThanOrEqual(LIVE_BROWSER_SNAPSHOT_MAX_TEXT_CHARS);
    expect(page.paragraphs.filter((row) => row.text === "same")).toHaveLength(1);
    expect(page.title).toBe("Dynamic title");
  });
});
