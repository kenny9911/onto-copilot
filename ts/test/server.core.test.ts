/**
 * server 段 A+H：Session / 租约 / 用量账本 / 前端托管 / 应用装配。
 *
 * 能用 golden 断言的一律用 `golden/server.core.json`（`tools/golden/server_core.py`
 * 从 Python 原件真跑出来的）。手写的期望值只出现在 Python 侧压根没有对等物的地方
 * （Hono 的 HTTP 行为、AsyncLock 的 FIFO、drain 循环的停止语义）。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_EVENTS } from "../src/session_events.js";
import type { SessionEvent } from "../src/session_events.js";
import { setRepoForTests } from "../src/store/deps.js";
import type { EventRow, UsageRow } from "../src/store/types.js";
import { makeUsageRow } from "../src/store/types.js";

import {
  AsyncLock,
  CARD_EVENT_CAP,
  CARD_EVENT_KINDS,
  HYDRATE_LOCKS,
  HYDRATE_USERS,
  SESSIONS,
  Session,
  buildHeartbeatInterval,
  buildLeaseTtl,
  chatHeartbeatInterval,
  chatLeaseTtl,
  chatRecorderRunId,
  mutationHeartbeatInterval,
  mutationLeaseTtl,
  refreshLeaseTtls,
  registerHydrator,
  runIdFor,
  sess,
  sessAsync,
  spawnCancellable,
  withHydrateLock,
} from "../src/server/session.js";
import {
  USAGE_BUF_MAXLEN,
  drainUsageOnShutdown,
  flushUsage,
  moneyFailure,
  peekUsageBuf,
  resetUsageBufForTests,
  startUsageDrain,
  usageBufLength,
  usageDropped,
  usageReport,
  usageSink,
} from "../src/server/usage.js";
import {
  SYNTHETIC_ADMIN_ID,
  app,
  registerAuthMiddleware,
  registerCorsOrigins,
  uiDir,
} from "../src/server/app.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const GOLDEN = JSON.parse(
  readFileSync(resolve(HERE, "..", "..", "golden", "server.core.json"), "utf8"),
) as GoldenFile;

interface GoldenFile {
  usage_sink: Array<{
    kwargs: { session_id?: string; kind?: string; owner?: string };
    rec: Record<string, unknown>;
    row: Record<string, unknown>;
    total: number;
  }>;
  usage_report: Array<{
    name: string;
    query: Array<{ since: number; owner: string | null; limit: number }>;
    report: Record<string, unknown>;
  }>;
  money_failure: Array<{ name: string; signal: [string, string] }>;
  session_brief: Array<{ name: string; brief: Record<string, unknown> }>;
  run_id: Array<{ name: string; files: Array<Record<string, unknown>>; run_id: string }>;
  chat_recorder_run_id: Array<{
    name: string;
    kind: string;
    input: unknown;
    run_id: string;
  }>;
  lease_ttl: Array<{
    env: string | null;
    ttl: number;
    build_heartbeat: number;
    chat_heartbeat: number;
  }>;
  card_event: { kinds: string[]; cap: number };
}

const T0 = 1768480496.0;

// ══════════════════════════════════════════════════════════════════
//  测试替身
// ══════════════════════════════════════════════════════════════════

/** `_flush_usage` / drain 只用 addUsage 这一个方法。 */
class FakeUsageRepo {
  readonly written: UsageRow[] = [];
  failures = 0;

  async addUsage(row: UsageRow): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("db down");
    }
    this.written.push(row);
  }

  async usageSince(): Promise<UsageRow[]> {
    return [];
  }
}

/** 会话事件用的最小仓储。`getSession` 返回 null 时 hub 走 local-only。 */
class FakeEventRepo {
  seq = 0;
  readonly appended: Array<{ sid: string; kind: string; eventId: string | undefined }> = [];
  known = true;

  async getSession(sid: string): Promise<{ id: string } | null> {
    return this.known ? { id: sid } : null;
  }

  async appendEvent(
    sid: string,
    kind: string,
    payload: Record<string, unknown>,
    opts?: { eventId?: string | undefined },
  ): Promise<EventRow> {
    this.appended.push({ sid, kind, eventId: opts?.eventId });
    const seq = this.seq++;
    return {
      seq,
      ts: T0,
      kind,
      payload: payload as EventRow["payload"],
      event_id: opts?.eventId ?? "",
    };
  }

  async listFiles(): Promise<never[]> {
    return [];
  }
}

function goldenRow(g: Record<string, unknown>): UsageRow {
  return makeUsageRow(g as unknown as Parameters<typeof makeUsageRow>[0]);
}

beforeEach(() => {
  resetUsageBufForTests();
  SESSIONS.clear();
  HYDRATE_LOCKS.clear();
  HYDRATE_USERS.clear();
  registerHydrator(null);
  registerAuthMiddleware(null);
  registerCorsOrigins(null);
  setRepoForTests(null);
});

afterEach(async () => {
  await SESSION_EVENTS.shutdown();
  setRepoForTests(null);
});

// ══════════════════════════════════════════════════════════════════
//  1. 用量账本 —— 钱的账
// ══════════════════════════════════════════════════════════════════

describe("usageSink（golden）", () => {
  it("每一笔都逐字段对上 llm_usage", () => {
    for (const c of GOLDEN.usage_sink) {
      resetUsageBufForTests();
      const sink = usageSink({
        sessionId: c.kwargs.session_id ?? "",
        kind: c.kwargs.kind ?? "build",
        owner: c.kwargs.owner ?? "",
        now: () => T0,
        newId: () => "deadbeef".repeat(4),
      });
      sink(c.rec as Parameters<typeof sink>[0]);
      const rows = peekUsageBuf();
      expect(rows).toHaveLength(1);
      expect({ ...rows[0]! }).toEqual(c.row);
    }
  });

  it("缓冲满了挤掉最老的一条，而且**记个数**", () => {
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    // 直接灌满两万条太慢；改灌满后再多灌 3 条，只验行为不验规模
    for (let i = 0; i < USAGE_BUF_MAXLEN; i++) sink({ model: `m${i}` });
    expect(usageBufLength()).toBe(USAGE_BUF_MAXLEN);
    expect(usageDropped()).toBe(0);

    sink({ model: "overflow" });
    expect(usageBufLength()).toBe(USAGE_BUF_MAXLEN);
    expect(usageDropped()).toBe(1);
    // 挤掉的是队首那条最老的
    expect(peekUsageBuf()[0]!.model).toBe("m1");
    expect(peekUsageBuf()[USAGE_BUF_MAXLEN - 1]!.model).toBe("overflow");
  });
});

describe("flushUsage", () => {
  it("commit 成功才出队；limit 之外的留着", async () => {
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    for (let i = 0; i < 5; i++) sink({ model: `m${i}` });
    const repo = new FakeUsageRepo();
    expect(await flushUsage(repo, { limit: 3 })).toBe(3);
    expect(repo.written.map((r) => r.model)).toEqual(["m0", "m1", "m2"]);
    expect(usageBufLength()).toBe(2);
  });

  it("**一次瞬时 DB 故障不许吞掉一条已经接受的用量**", async () => {
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    sink({ model: "m0" });
    sink({ model: "m1" });
    const repo = new FakeUsageRepo();
    repo.failures = 1;
    await expect(flushUsage(repo)).rejects.toThrow("db down");
    // 那条还在队首，等着下一轮重试 —— 这正是这个函数存在的理由
    expect(usageBufLength()).toBe(2);
    expect(peekUsageBuf()[0]!.model).toBe("m0");

    expect(await flushUsage(repo)).toBe(2);
    expect(usageBufLength()).toBe(0);
  });
});

describe("startUsageDrain", () => {
  it("常驻循环把缓冲写空，stop() 之后就真的停了", async () => {
    const repo = new FakeUsageRepo();
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    sink({ model: "m0" });
    const drain = startUsageDrain(() => repo, { idleMs: 1, backoffMs: 1 });
    for (let i = 0; i < 200 && repo.written.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(repo.written.map((r) => r.model)).toEqual(["m0"]);
    drain.stop();
    await drain.promise;

    // 停了之后新进来的不再被写走
    sink({ model: "after-stop" });
    await new Promise((r) => setTimeout(r, 10));
    expect(repo.written).toHaveLength(1);
    expect(usageBufLength()).toBe(1);
  });

  it("DB 挂掉时退避重试，不丢账", async () => {
    const repo = new FakeUsageRepo();
    repo.failures = 3;
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    sink({ model: "m0" });
    const drain = startUsageDrain(() => repo, { idleMs: 1, backoffMs: 1 });
    for (let i = 0; i < 400 && repo.written.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    drain.stop();
    await drain.promise;
    expect(repo.written.map((r) => r.model)).toEqual(["m0"]);
  });
});

describe("drainUsageOnShutdown", () => {
  it("写不动就把留在缓冲里的计入 dropped —— 不假装那些账已经落库", async () => {
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    sink({ model: "m0" });
    sink({ model: "m1" });
    const repo = new FakeUsageRepo();
    repo.failures = 99;
    await drainUsageOnShutdown(repo, { timeoutMs: 50 });
    expect(usageDropped()).toBe(2);
    expect(repo.written).toHaveLength(0);
  });

  it("正常情况下把尾巴写完", async () => {
    const sink = usageSink({ now: () => T0, newId: () => "x" });
    sink({ model: "m0" });
    const repo = new FakeUsageRepo();
    await drainUsageOnShutdown(repo);
    expect(repo.written).toHaveLength(1);
    expect(usageDropped()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. /api/usage 的报表
// ══════════════════════════════════════════════════════════════════

describe("usageReport（golden）", () => {
  for (const c of GOLDEN.usage_report) {
    it(c.name, async () => {
      const seen: Array<{ since: number; owner: string | null; limit: number }> = [];
      const source = GOLDEN.usage_report.find((x) => x.name === c.name)!;
      // golden 的 query 里记了 Python 真的拿什么参数去查库 —— 一起钉住，
      // 否则"报表长得对但查的是别人的账"这种错会溜过去。
      const repo = {
        async usageSince(
          since: number,
          opts?: { owner?: string | null; limit?: number },
        ): Promise<UsageRow[]> {
          seen.push({
            since: Number(since.toFixed(6)),
            owner: opts?.owner ?? null,
            limit: opts?.limit ?? 5000,
          });
          return REPORT_ROWS[c.name]!.map(goldenRow);
        },
      };
      const got = await usageReport(repo, {
        days: QUERY_ARGS[c.name]!.days,
        bucket: QUERY_ARGS[c.name]!.bucket,
        limit: QUERY_ARGS[c.name]!.limit,
        owner: null,
        now: T0,
      });
      expect(seen).toEqual(source.query);
      expect(got).toEqual(c.report);
    });
  }
});

/** golden 里的场景参数（`tools/golden/server_core.py` 的 `scenarios`）。 */
const QUERY_ARGS: Record<string, { days: number; bucket: string; limit: number }> = {
  "day/all": { days: 5, bucket: "day", limit: 5000 },
  hour: { days: 1, bucket: "hour", limit: 5000 },
  empty: { days: 3, bucket: "day", limit: 5000 },
  billed: { days: 2, bucket: "day", limit: 5000 },
  truncated: { days: 2, bucket: "day", limit: 3 },
  clamped: { days: 0, bucket: "weird", limit: 0 },
  clamped_hi: { days: 9999, bucket: "day", limit: 999999 },
};

const R1 = {
  id: "a",
  ts: T0,
  day: "2026-01-15",
  model: "openai/gpt-5.5",
  kind: "build",
  node_id: "n1",
  tok_in: 100,
  tok_out: 50,
  cache_read: 10,
  cache_write: 5,
  usd: 0.02,
  usd_source: "gateway",
  attempts: 1,
  status: "ok",
  session_id: "s1",
};
const R2 = {
  id: "b",
  ts: T0 - 3600,
  day: "2026-01-15",
  model: "openai/gpt-5.5",
  kind: "chat",
  node_id: "n2",
  tok_in: 7,
  tok_out: 3,
  usd: 0.0,
  usd_source: "estimated",
  status: "failed",
  session_id: "s1",
};
const R3 = {
  id: "c",
  ts: T0 - 86400 * 2,
  day: "2026-01-13",
  model: "google/gemini-3.5-flash",
  kind: "build",
  node_id: "n3",
  tok_in: 1000,
  tok_out: 2000,
  usd: 0.5,
  usd_source: "gateway",
  attempts: 3,
  status: "ok",
  session_id: "s2",
};
const ALL = [R1, R2, R3];
const REPORT_ROWS: Record<string, Array<Record<string, unknown>>> = {
  "day/all": ALL,
  hour: ALL,
  empty: [],
  billed: [R1],
  truncated: ALL,
  clamped: [],
  clamped_hi: [],
};

// ══════════════════════════════════════════════════════════════════
//  3. 钱不够的三种信号
// ══════════════════════════════════════════════════════════════════

describe("moneyFailure（golden）", () => {
  it("quota / cap / 都不是 —— 三条信号绝不能混", async () => {
    const { QuotaExhausted } = await import("../src/kernel/llm.js");
    const { BudgetExhausted } = await import("../src/kernel/errors.js");

    const quota = new QuotaExhausted("openai/gpt-5.5", "insufficient_quota: 余额不足", 402);
    const cap = new BudgetExhausted("usd", 15.0, 15.2);
    const tokens = new BudgetExhausted("tokens", 100.0, 101.0);
    const wrapped = new Error("节点炸了", { cause: quota });
    const deep = new Error("l1", { cause: new Error("l2", { cause: cap }) });
    const flatQuota = new Error(`QuotaExhausted: ${quota.message}`);
    const flatCap = new Error("BudgetExhausted: usd 预算耗尽: 15 / 15");

    const byName: Record<string, unknown> = {
      quota_direct: quota,
      cap_direct: cap,
      tokens_not_money: tokens,
      quota_via_cause: wrapped,
      cap_via_two_causes: deep,
      flattened_quota_text: flatQuota,
      flattened_cap_text: flatCap,
      unrelated: new TypeError("解析失败"),
    };
    for (const c of GOLDEN.money_failure) {
      expect([...moneyFailure(byName[c.name])], c.name).toEqual(c.signal);
    }
  });

  it("异常链最多跟六层 —— 环状/超长链不许把这一层挂住", () => {
    let e = new Error("leaf");
    for (let i = 0; i < 20; i++) e = new Error(`w${i}`, { cause: e });
    expect([...moneyFailure(e)]).toEqual(["", ""]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. Session
// ══════════════════════════════════════════════════════════════════

describe("Session.brief（golden）", () => {
  it("字段名是前端契约", () => {
    const s1 = new Session("sess-1", { created: T0 });
    expect(s1.brief()).toEqual(GOLDEN.session_brief[0]!.brief);

    const s2 = new Session("sess-2", {
      title: "订单主数据",
      project: "ACME",
      projectId: "p1",
      created: T0,
      status: "done",
    });
    s2.state["mode"] = "chat";
    s2.files = [{ name: "a.xlsx", size: 10, path: "/x/a.xlsx", sha256: "aa" }];
    s2.error = "boom";
    expect(s2.brief()).toEqual(GOLDEN.session_brief[1]!.brief);
  });
});

describe("runIdFor（golden）", () => {
  it("同一批材料换顺序给同一个 id；材料一变就是新 id", () => {
    for (const c of GOLDEN.run_id) {
      const s = new Session("sess-1");
      s.files = c.files.map((f) => ({
        name: String(f["name"]),
        size: Number(f["size"]),
        path: String(f["path"]),
        // golden 里 "missing" 那条的 sha256 是 `_run_id_for` **补算**出来的，
        // 输入侧不能带上，否则就不是同一个用例了
        sha256: c.name === "missing" ? "" : String(f["sha256"] ?? ""),
      }));
      expect(runIdFor(s), c.name).toBe(c.run_id);
    }
  });

  it("读不到内容时把兜底标记写回 files（下一次不再重算）", () => {
    const s = new Session("sess-1");
    s.files = [{ name: "gone.xlsx", size: 7, path: "/nonexistent/__gone__.xlsx", sha256: "" }];
    runIdFor(s);
    expect(s.files[0]!.sha256).toBe("missing:gone.xlsx:7");
  });

  it("项目文档按会话固定版本参与指纹，新版本不会静默改写旧 Run", () => {
    const s = new Session("sess-doc");
    s.state["_document_manifest"] = [{
      document_id: "doc-policy",
      version_id: "dv-1",
      sha256: "sha-v1",
    }];
    const v1 = runIdFor(s);
    // 项目库即使已有 v2，只要本会话仍固定 v1，manifest 不变，Run 也不变。
    expect(runIdFor(s)).toBe(v1);
    s.state["_document_manifest"] = [{
      document_id: "doc-policy",
      version_id: "dv-2",
      sha256: "sha-v2",
    }];
    expect(runIdFor(s)).not.toBe(v1);
  });
});

describe("chatRecorderRunId（golden）", () => {
  it("语义输入相同 → 同一份可重放日志", () => {
    const s = new Session("sess-1");
    for (const c of GOLDEN.chat_recorder_run_id) {
      expect(chatRecorderRunId(s, { kind: c.kind, semanticInput: c.input }), c.name).toBe(
        c.run_id,
      );
    }
  });
});

describe("Session.emit", () => {
  it("没有仓储时退回 local-only，序号从 0 起", () => {
    const s = new Session("s1");
    const a = s.emit("chat.delta", { text: "hi" });
    const b = s.emit("chat.delta", { text: "there" });
    expect(a["seq"]).toBe(0);
    expect(b["seq"]).toBe(1);
    expect(a["kind"]).toBe("chat.delta");
    expect(s.events).toHaveLength(2);
  });

  it("payload 里的 kind 顶不掉事件类型", () => {
    const s = new Session("s1");
    const ev = s.emit("conflict.found", { kind: "naming" });
    expect(ev["kind"]).toBe("conflict.found");
  });

  it("有仓储时走耐久路径，eventId 作为幂等键传下去", async () => {
    const repo = new FakeEventRepo();
    setRepoForTests(repo);
    const s = new Session("s1");
    const ev = await s.emitDurable("ui.table", { rows: 3 });
    expect(ev["seq"]).toBe(0);
    expect(repo.appended).toHaveLength(1);
    expect(repo.appended[0]!.kind).toBe("ui.table");
    // **必须**带上 —— 丢了幂等键，一次重试就重复插一条事件
    expect(repo.appended[0]!.eventId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("卡片事件保留状态投影，且只留最后 CAP 条", () => {
    expect([...CARD_EVENT_KINDS].filter((kind) => kind !== "web.sources"))
      .toEqual(GOLDEN.card_event.kinds);
    expect(CARD_EVENT_KINDS).toContain("web.sources");
    expect(CARD_EVENT_CAP).toBe(GOLDEN.card_event.cap);

    const s = new Session("s1");
    for (let i = 0; i < CARD_EVENT_CAP + 5; i++) s.emit("ui.table", { i });
    s.emit("chat.delta", { text: "不是卡片" });
    const cards = s.state["_cards"] as SessionEvent[];
    expect(cards).toHaveLength(CARD_EVENT_CAP);
    expect(cards[0]!["i"]).toBe(5);
    expect(cards[CARD_EVENT_CAP - 1]!["i"]).toBe(CARD_EVENT_CAP + 4);
  });

  it("裁剪是**原地**的 —— 别处拿到的引用要跟着变", () => {
    const s = new Session("s1");
    s.emit("ui.table", { i: 0 });
    const held = s.state["_cards"] as SessionEvent[];
    for (let i = 1; i < CARD_EVENT_CAP + 3; i++) s.emit("ui.table", { i });
    expect(s.state["_cards"]).toBe(held);
    expect(held).toHaveLength(CARD_EVENT_CAP);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. 取会话 / 恢复的 single-flight
// ══════════════════════════════════════════════════════════════════

describe("sess / sessAsync", () => {
  it("sess() 不做恢复，缺席就是 404", () => {
    expect(() => sess("nope")).toThrowError(/没有会话 nope/);
  });

  it("sess() 拿到的是同一个对象", () => {
    const s = new Session("s1");
    SESSIONS.set("s1", s);
    expect(sess("s1")).toBe(s);
  });

  it("sessAsync() 命中缓存时**不调** hydrate", async () => {
    const s = new Session("s1");
    SESSIONS.set("s1", s);
    let calls = 0;
    registerHydrator(async () => {
      calls += 1;
      return s;
    });
    expect(await sessAsync("s1")).toBe(s);
    expect(calls).toBe(0);
  });

  it("接线漏了要显式失败，不许伪装成 404", async () => {
    await expect(sessAsync("s1")).rejects.toThrow(/registerHydrator/);
  });
});

describe("withHydrateLock", () => {
  it("并发打开同一个冷会话只跑一次恢复，所有等待者拿同一个对象", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = async (): Promise<Session> => {
      const cached = SESSIONS.get("cold");
      if (cached) return cached;
      runs += 1;
      await gate;
      const s = new Session("cold");
      SESSIONS.set("cold", s);
      return s;
    };
    const all = Promise.all([
      withHydrateLock("cold", body),
      withHydrateLock("cold", body),
      withHydrateLock("cold", body),
    ]);
    release();
    const [a, b, c] = await all;
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("**释放与唤醒之间的缝隙**里不许另建一把锁（引用计数的存在理由）", async () => {
    const seen: Array<AsyncLock | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = withHydrateLock("x", async () => {
      await gate;
      seen.push(HYDRATE_LOCKS.get("x"));
    });
    const second = withHydrateLock("x", async () => {
      seen.push(HYDRATE_LOCKS.get("x"));
    });
    release();
    await Promise.all([first, second]);
    expect(seen[0]).toBe(seen[1]);
    // 全部退出后锁与计数都清掉，不许泄漏
    expect(HYDRATE_LOCKS.has("x")).toBe(false);
    expect(HYDRATE_USERS.has("x")).toBe(false);
  });

  it("body 抛错也要放锁并清理", async () => {
    await expect(
      withHydrateLock("y", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(HYDRATE_LOCKS.has("y")).toBe(false);
    await expect(withHydrateLock("y", async () => 1)).resolves.toBe(1);
  });
});

describe("AsyncLock", () => {
  it("FIFO —— 乱序会让两个并发编辑拿到同一个号", async () => {
    const lock = new AsyncLock();
    const order: number[] = [];
    await lock.acquire();
    const tasks = [1, 2, 3].map((i) =>
      lock.run(async () => {
        order.push(i);
      }),
    );
    lock.release();
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it("异常路径也放锁", async () => {
    const lock = new AsyncLock();
    await expect(lock.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(lock.isLocked).toBe(false);
  });
});

describe("spawnCancellable", () => {
  it("cancel() 只 abort 信号，被取消方自己退出（约定 §2.2：不假装有抢占式取消）", async () => {
    let aborted = false;
    const t = spawnCancellable(async (signal) => {
      for (let i = 0; i < 100; i++) {
        if (signal.aborted) {
          aborted = true;
          return "stopped";
        }
        await new Promise((r) => setTimeout(r, 1));
      }
      return "finished";
    });
    t.cancel();
    expect(await t.promise).toBe("stopped");
    expect(aborted).toBe(true);
    expect(t.done).toBe(true);
  });

  it("抛错不杀进程（promise 上已经挂了 catch）", async () => {
    const t = spawnCancellable(async () => {
      throw new Error("boom");
    });
    await expect(t.promise).rejects.toThrow("boom");
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. 租约 TTL
// ══════════════════════════════════════════════════════════════════

describe("租约 TTL（golden）", () => {
  const KEY = "ONTOCOPILOT_BUILD_LEASE_TTL";
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    refreshLeaseTtls();
  });

  it("下界 5s、坏值回默认 30s，心跳是 TTL/3 且各有上限", () => {
    for (const c of GOLDEN.lease_ttl) {
      if (c.env === null) delete process.env[KEY];
      else process.env[KEY] = c.env;
      refreshLeaseTtls();
      expect(buildLeaseTtl(), String(c.env)).toBe(c.ttl);
      expect(buildHeartbeatInterval(), String(c.env)).toBe(c.build_heartbeat);
    }
  });

  it("chat 租约独立配置，心跳上限是 5s（不是 build 的 10s）", () => {
    const ck = "ONTOCOPILOT_CHAT_LEASE_TTL";
    const prev = process.env[ck];
    process.env[ck] = "60";
    refreshLeaseTtls();
    try {
      expect(chatLeaseTtl()).toBe(60);
      expect(chatHeartbeatInterval()).toBe(5.0);
    } finally {
      if (prev === undefined) delete process.env[ck];
      else process.env[ck] = prev;
      refreshLeaseTtls();
    }
  });

  it("mutation 租约**不**随 refreshLeaseTtls 变 —— 照抄 Python 的 global 清单", () => {
    const before = mutationLeaseTtl();
    const mk = "ONTOCOPILOT_MUTATION_LEASE_TTL";
    const prev = process.env[mk];
    process.env[mk] = "90";
    refreshLeaseTtls();
    try {
      expect(mutationLeaseTtl()).toBe(before);
      expect(mutationHeartbeatInterval()).toBe(Math.min(before / 3, 5.0));
    } finally {
      if (prev === undefined) delete process.env[mk];
      else process.env[mk] = prev;
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. HTTP：前端外壳与 /api/usage
// ══════════════════════════════════════════════════════════════════

describe("GET /", () => {
  it("吐 ui/index.html，且**明确禁止缓存**", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    // 逐字节等于磁盘上那份 —— 这一轮不许动 html
    expect(body).toBe(readFileSync(join(uiDir(), "index.html"), "utf8"));
  });
});

describe("GET /api/usage", () => {
  it("路径、方法与响应字段名是前端契约", async () => {
    setRepoForTests({
      async usageSince(): Promise<UsageRow[]> {
        return [];
      },
    });
    const res = await app.request("/api/usage?days=3&bucket=day");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // by_owner / can_see_all / owner_filter / owner_names 是"管理员监控全部账号用量"
    // 那一批：前者是分账，后三个告诉界面**它现在看到的是谁的账** —— 少了它，
    // 管理员看到一份只有自己的报表却以为是全站的，而界面上没有任何迹象。
    expect(Object.keys(body).sort()).toEqual(
      ["by_kind", "by_model", "by_owner", "bucket", "can_see_all", "cost_note", "days",
       "owner_filter", "owner_names", "rows", "series", "total", "truncated"].sort(),
    );
    expect(body["days"]).toBe(3);
    expect(body["cost_note"]).toBe("none");
  });

  it("非整数参数回 422，不静默用默认值", async () => {
    setRepoForTests({
      async usageSince(): Promise<UsageRow[]> {
        return [];
      },
    });
    const res = await app.request("/api/usage?days=abc");
    expect(res.status).toBe(422);
  });

  it("强制鉴权下只查自己的账；合成管理员看全部", async () => {
    const seen: Array<string | null | undefined> = [];
    setRepoForTests({
      async usageSince(
        _since: number,
        opts?: { owner?: string | null },
      ): Promise<UsageRow[]> {
        seen.push(opts?.owner ?? null);
        return [];
      },
    });

    registerAuthMiddleware(async (c, next) => {
      c.set("user", { id: "u42" });
      await next();
    });
    await app.request("/api/usage");
    expect(seen.at(-1)).toBe("u42");

    registerAuthMiddleware(async (c, next) => {
      c.set("user", { id: SYNTHETIC_ADMIN_ID });
      await next();
    });
    await app.request("/api/usage");
    // 开放模式（合成管理员）看全部 —— null 就是"不按归属过滤"
    expect(seen.at(-1)).toBe(null);
  });

  // 「管理员监控全部账号的 token 用量」那一批。
  //
  // 这里以前有个静默的坑：判据只写 `isolate(c) ? ownerId(c) : null`，而 isolate 只
  // 排除合成管理员 —— **真管理员也被钉在自己账上**，于是他看到的是一份只有自己的
  // 报表，界面上却没有任何迹象说明这不是全站。
  describe("按角色的可见范围", () => {
    const seen: Array<string | null | undefined> = [];
    const install = (): void => {
      seen.length = 0;
      setRepoForTests({
        async usageSince(_since: number, opts?: { owner?: string | null }): Promise<UsageRow[]> {
          seen.push(opts?.owner ?? null);
          return [];
        },
      });
    };
    const as = (user: { id: string; role?: string }): void => {
      registerAuthMiddleware(async (c, next) => {
        c.set("user", user as unknown as Parameters<typeof c.set>[1]);
        await next();
      });
    };

    it("管理员不带参数 = 全部账号（null，不按归属过滤）", async () => {
      install(); as({ id: "a1", role: "admin" });
      const res = await app.request("/api/usage");
      expect(seen.at(-1)).toBe(null);
      expect((await res.json() as any).can_see_all).toBe(true);
    });

    it("管理员的 ?owner= 能钻到某个账号", async () => {
      install(); as({ id: "a1", role: "admin" });
      await app.request("/api/usage?owner=u42");
      expect(seen.at(-1)).toBe("u42");
    });

    it("**普通用户带 ?owner= 仍然只查自己** —— 越权参数被吃掉", async () => {
      install(); as({ id: "u42", role: "user" });
      const res = await app.request("/api/usage?owner=a1");
      expect(seen.at(-1)).toBe("u42");
      expect((await res.json() as any).can_see_all).toBe(false);
    });

    it("拿不到账号名不该让整个接口挂掉 —— 名字是装饰，数字才是意义", async () => {
      install(); as({ id: "a1", role: "admin" });
      // 假 repo 只有 usageSince，没有 listUsers
      const res = await app.request("/api/usage");
      expect(res.status).toBe(200);
      expect((await res.json() as any).owner_names).toEqual({});
    });
  });
});
