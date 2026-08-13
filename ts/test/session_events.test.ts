/**
 * session_events 的 golden 校验 —— 钉的是**线上事件形态**。
 *
 * 这一层没有算法，只有「前端到底收到哪些键、什么顺序、什么值」。事件名或字段名
 * 改一个字，前端就静默瞎掉：跨 HTTP 没有任何类型检查拦得住。所以每条路径产出的
 * 事件都在这里逐字段、**连键序一起**比 golden。
 *
 * golden 里每个用例的假时钟/假 uuid 都从头开始（`reset_fakes()`），所以这边注入
 * 同样的替身之后能**逐字节**比全部字段，不需要把 ts / eventId 抹成占位符再比 ——
 * 那两个恰恰是真会被前端读到的字段。
 *
 * 已知且被钉住的两处分叉（都在 deviations 里报了）：
 *   1. payload 里的"数组下标形状"键（`"0"`）—— Python dict 按插入序，JS 对象把这
 *      类键提到最前。键集合与值完全一致，只有 JSON 的键**顺序**不同。
 *   2. `wait_seq` 在失败前挂上去的那一路 —— Python 协程要等被调度才开始执行，
 *      JS 的 async 函数体是同步开始的，见 persist_failed 那节的注释。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DurableEventHub, SESSION_EVENTS } from "../src/session_events.js";
import type { EventRepo, EventSession, EventSubscriber, SessionEvent } from "../src/session_events.js";
import type { EventRow, JsonObject, JsonValue } from "../src/store/types.js";

// ── golden ────────────────────────────────────────────────────────

interface Shape {
  keys: string[];
  event: Record<string, JsonValue>;
}

interface Golden {
  projection_shapes: (Shape & {
    kind: string;
    payload: JsonObject;
    delivered_before_commit: SessionEvent[];
    session_events_is_projection: boolean;
  })[];
  pending_seq_counter: { seqs: number[]; fresh_hub_first: number };
  ephemeral: (Shape & {
    seed: SessionEvent[];
    delivered: SessionEvent[];
    session_events_len: number;
  })[];
  commit_flow: {
    pending: Shape[];
    projections: Shape[];
    delivered: Shape[];
    session_events: Shape[];
    rows: { seq: number; kind: string; payload: JsonObject; event_id: string }[];
    receipt_after_commit_is_none: boolean;
    wait_seq_after_commit: number[];
  };
  payload_frozen: {
    row_payload: JsonObject;
    projection: Record<string, JsonValue>;
    caller_rows: JsonValue;
  };
  no_event_id_echo: Shape & { had_event_id_before_commit: boolean };
  detached_session: {
    before_commit: Shape;
    after_commit: Shape;
    delivered: Shape[];
    session_events: Shape[];
    wait_seq: number;
  };
  persist_failed: {
    max_attempts: number;
    exc: string;
    sleeps: number[];
    log_messages: string[];
    projection: Shape;
    delivered: Shape[];
    session_events: Shape[];
    wait_seq_early: { result: number | null; error: string | null };
    wait_seq_late: { result: number | null; error: string | null };
  }[];
  retry_transient: Shape & { calls: number; rows: number; sleeps: number[] };
  sort_and_dedupe: {
    label: string;
    seed: SessionEvent[];
    row_seq: number;
    session_events: Shape[];
    projection_index: number;
  }[];
  receipt_and_wait_seq: {
    receipt_pending_is_none: boolean;
    receipt_unknown_is_none: boolean;
    wait_seq_already_committed: number;
    wait_seq_no_seq_key: number;
    wait_seq_unknown_negative: number;
    wait_seq_pending: number;
  };
  shutdown_drains: { rows: number[]; seqs: number[]; after_shutdown_seq: number };
  seq_coercion: { in: JsonValue; out?: number; error?: string }[];
  backoff: { attempt: number; delay: number }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "golden", "session_events.json"), "utf8"),
) as Golden;

// ── Python 侧那几个替身的 TS 对应物 ────────────────────────────────

/** 与导出器 `_Clock` / `_Uuid` 同形：每个用例从头开始。 */
function fakes(): { now: () => number; newEventId: () => string } {
  let t = 0;
  let u = 0;
  return {
    now: () => 1700000000 + (t += 1),
    newEventId: () => (u += 1).toString(16).padStart(32, "0"),
  };
}

function hub(options: { maxAttempts?: number } = {}): DurableEventHub {
  return new DurableEventHub({ ...fakes(), ...options });
}

// 名字要和 Python 的内建异常一致 —— 事件里的 `error` 字段是
// `f"{type(e).__name__}: {e}"`，类名是**契约的一部分**，不是装饰。
class PyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
    Object.setPrototypeOf(this, PyError.prototype);
  }
}
class RuntimeErr extends PyError {
  constructor(message: string) {
    super("RuntimeError", message);
    Object.setPrototypeOf(this, RuntimeErr.prototype);
  }
}
class OSErr extends PyError {
  constructor(message: string) {
    super("OSError", message);
    Object.setPrototypeOf(this, OSErr.prototype);
  }
}
class ValueErr extends PyError {
  constructor(message: string) {
    super("ValueError", message);
    Object.setPrototypeOf(this, ValueErr.prototype);
  }
}
// errLabel 取的是 constructor.name，所以这三个类的**类名**必须逐字对上。
Object.defineProperty(RuntimeErr, "name", { value: "RuntimeError" });
Object.defineProperty(OSErr, "name", { value: "OSError" });
Object.defineProperty(ValueErr, "name", { value: "ValueError" });

function excFor(label: string): Error {
  if (label.startsWith("RuntimeError")) return new RuntimeErr(label.slice("RuntimeError: ".length));
  if (label.startsWith("OSError")) return new OSErr(label.slice("OSError: ".length));
  return new ValueErr(label.slice("ValueError: ".length));
}

class FakeQueue implements EventSubscriber {
  readonly items: SessionEvent[] = [];
  putNowait(event: SessionEvent): void {
    this.items.push(event);
  }
  drain(): SessionEvent[] {
    return this.items.splice(0, this.items.length);
  }
}

class FakeSession implements EventSession {
  readonly events: SessionEvent[] = [];
  readonly subscribers: EventSubscriber[] = [];
  constructor(
    readonly id = "s1",
    seed: SessionEvent[] = [],
  ) {
    for (const e of seed) this.events.push({ ...e });
  }
}

interface FakeRepoOptions {
  readonly exists?: boolean;
  readonly fail?: number;
  readonly exc?: Error;
  readonly echoEventId?: boolean;
  readonly startSeq?: number;
  readonly now?: () => number;
}

class FakeRepo implements EventRepo {
  calls = 0;
  getSessionCalls = 0;
  readonly rows: EventRow[] = [];
  private readonly byEventId = new Map<string, EventRow>();
  private nextSeq: number;
  private failRemaining: number;
  private readonly exists: boolean;
  private readonly exc: Error;
  private readonly echoEventId: boolean;
  private readonly now: () => number;

  constructor(options: FakeRepoOptions = {}) {
    this.exists = options.exists ?? true;
    this.failRemaining = options.fail ?? 0;
    this.exc = options.exc ?? new RuntimeErr("库炸了");
    this.echoEventId = options.echoEventId ?? true;
    this.nextSeq = options.startSeq ?? 0;
    this.now = options.now ?? (() => 0);
  }

  async getSession(_sid: string): Promise<unknown> {
    this.getSessionCalls += 1;
    return this.exists ? {} : null;
  }

  async appendEvent(
    _sid: string,
    kind: string,
    payload: JsonObject,
    eventId = "",
  ): Promise<EventRow> {
    this.calls += 1;
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw this.exc;
    }
    const cached = eventId ? this.byEventId.get(eventId) : undefined;
    if (cached !== undefined) return cached; // 幂等重放，不发新号
    const row: EventRow = {
      seq: this.nextSeq,
      kind,
      payload,
      ts: this.now(),
      event_id: this.echoEventId ? eventId : "",
    };
    this.nextSeq += 1;
    this.rows.push(row);
    if (eventId) this.byEventId.set(eventId, row);
    return row;
  }
}

// ── 输入是字面量，**不能**从 golden 里读回来 ──────────────────────────
//
// golden 落盘时用了 `sort_keys=True`，嵌套 dict 的键序被排过 —— 输出侧不受影响
// （键序单独存在 `keys` 数组里），但**输入**侧的 payload / seed 一旦从 golden 读
// 回来，键序就已经不是导出器当时喂进去的那个了。而键序恰恰是这份 golden 要钉的
// 东西之一。所以输入在这里逐字重写一遍，再和 golden 的记录做一次值层面的对账，
// 防止两份清单悄悄漂移。

const PROJECTION_INPUTS: { kind: string; payload: JsonObject }[] = [
  { kind: "step.0", payload: {} },
  { kind: "chat.turn", payload: { turn: { text: "已确认" } } },
  { kind: "ui.conflict", payload: { kind: "命名冲突", detail: "两处口径不一致" } },
  { kind: "ui.table", payload: { seq: 99, ts: 5.0, title: "缺口" } },
  { kind: "legacy.echo", payload: { eventId: "caller-supplied", n: 1 } },
  { kind: "legacy.indexed", payload: { "0": "第一行", n: 1 } },
  {
    kind: "ui.table",
    payload: { title: "缺口", columns: ["问题", "业务回答"], rows: [["金额阈值", "审批口径"]] },
  },
];

const EPHEMERAL_SEEDS: SessionEvent[][] = [
  [],
  [
    { seq: 0, kind: "a" },
    { seq: 1, kind: "b" },
  ],
  [
    { seq: -1, kind: "a" },
    { seq: -2, kind: "b" },
  ],
  [
    { seq: 5, kind: "a" },
    { seq: 2, kind: "b" },
  ],
  [{ kind: "无 seq 字段" }],
  [{ seq: "3", kind: "字符串 seq" }],
  [{ seq: 2.9, kind: "浮点 seq" }],
  [{ seq: true, kind: "bool seq" }],
];

const SORT_SEEDS: SessionEvent[][] = [
  [
    { seq: 3, kind: "c" },
    { seq: 1, kind: "a" },
    { seq: 2, kind: "b" },
  ],
  [
    { seq: 2, kind: "b" },
    { seq: -3, kind: "p3" },
    { seq: -1, kind: "p1" },
    { seq: 0, kind: "a" },
  ],
  [{ seq: 0, kind: "dup", n: 0 }],
  [
    { seq: 0, kind: "dup", n: 0 },
    { seq: 0, kind: "dup", n: 0 },
  ],
];

/** 一条事件的完整形态：键序 + 全部键值，一个都不放过。 */
function expectShape(actual: SessionEvent | undefined, expected: Shape): void {
  expect(actual).toBeDefined();
  expect(Object.keys(actual as SessionEvent)).toEqual(expected.keys);
  expect(actual).toEqual(expected.event);
}

function expectShapes(actual: SessionEvent[], expected: Shape[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((s, i) => expectShape(actual[i], s));
}

// ══════════════════════════════════════════════════════════════════

describe("pending projection 的形态", () => {
  it("键序与全部字段逐条对齐 golden", async () => {
    expect(PROJECTION_INPUTS.length).toBe(G.projection_shapes.length);
    for (const [i, c] of G.projection_shapes.entries()) {
      const input = PROJECTION_INPUTS[i] as { kind: string; payload: JsonObject };
      expect({ kind: input.kind, payload: input.payload }).toEqual({
        kind: c.kind,
        payload: c.payload,
      });
      const h = hub();
      const session = new FakeSession();
      const q = new FakeQueue();
      session.subscribers.push(q);

      const ev = h.enqueue(session, new FakeRepo(), input.kind, input.payload);
      const snapshot = { ...ev };
      const keys = Object.keys(ev);

      // enqueue **绝不**通知订阅者：负数 seq 永远不上 SSE。
      expect(q.drain()).toEqual(c.delivered_before_commit);
      expect(session.events[session.events.length - 1] === ev).toBe(
        c.session_events_is_projection,
      );
      expect(snapshot).toEqual(c.event);

      if (c.kind === "legacy.indexed") {
        // **已知分叉**：payload 键是 canonical array index（"0"）时，JS 把它提到
        // 对象最前，Python 保持插入序。键集合和值都一致，只有 JSON 的键顺序不同；
        // SSE 消费方解析 JSON 读不到顺序，所以无害 —— 但要有记录。
        expect(c.keys).toEqual(["seq", "ts", "0", "n", "kind", "eventId"]);
        expect(keys).toEqual(["0", "seq", "ts", "n", "kind", "eventId"]);
      } else {
        expect(keys).toEqual(c.keys);
      }
      await h.shutdown();
    }
  });

  it("payload 里的 kind 永远顶不掉事件类型", () => {
    const h = hub();
    const ev = h.enqueue(new FakeSession(), new FakeRepo(), "ui.conflict", {
      kind: "命名冲突",
      detail: "两处口径不一致",
    });
    expect(ev["kind"]).toBe("ui.conflict");
    expect(ev["detail"]).toBe("两处口径不一致");
  });

  it("pending seq 是 hub 级递增的负数，跨会话共享", async () => {
    const h = hub();
    const repo = new FakeRepo();
    const a = new FakeSession("a");
    const b = new FakeSession("b");
    const seqs = [
      h.enqueue(a, repo, "x", {})["seq"],
      h.enqueue(b, repo, "y", {})["seq"],
      h.enqueue(a, repo, "z", {})["seq"],
    ];
    expect(seqs).toEqual(G.pending_seq_counter.seqs);

    const other = hub();
    expect(other.enqueue(new FakeSession("c"), repo, "x", {})["seq"]).toBe(
      G.pending_seq_counter.fresh_hub_first,
    );
    await h.shutdown();
    await other.shutdown();
  });

  it("enqueue 返回时仓储一次都还没被碰", async () => {
    // Python 的 create_task 要等下一轮调度；JS 的 async 函数体是同步开始的，
    // worker 若不挂到微任务上，repo.getSession 会在调用方拿到 projection 之前
    // 就打出去 —— 那就不是"同步 emit、异步耐久"了。
    const h = hub();
    const repo = new FakeRepo();
    h.enqueue(new FakeSession(), repo, "step.0", { n: 0 });
    expect(repo.getSessionCalls).toBe(0);
    await h.flush();
    expect(repo.getSessionCalls).toBe(1);
    await h.shutdown();
  });
});

describe("local-only 路径（emitEphemeral）", () => {
  it("seq = max(非负 seq) + 1，且立刻推给订阅者", () => {
    expect(EPHEMERAL_SEEDS.length).toBe(G.ephemeral.length);
    for (const [i, c] of G.ephemeral.entries()) {
      const seed = EPHEMERAL_SEEDS[i] as SessionEvent[];
      expect(seed).toEqual(c.seed);
      const h = hub();
      const session = new FakeSession("s1", seed);
      const q = new FakeQueue();
      session.subscribers.push(q);

      const ev = h.emitEphemeral(session, "ui.note", { text: "本地" });

      expect(Object.keys(ev)).toEqual(c.keys);
      expect(ev).toEqual(c.event);
      // 本地路径**没有 eventId** —— 它只在走仓储时才有意义（幂等键）。
      expect("eventId" in ev).toBe(false);
      expect(q.drain()).toEqual(c.delivered);
      expect(session.events.length).toBe(c.session_events_len);
    }
  });

  it("Python int() 的强制转换语义（seq 可能是字符串/浮点/bool）", () => {
    for (const c of G.seq_coercion) {
      const h = hub();
      const session = new FakeSession("s1", [{ seq: c.in, kind: "seed" }]);
      if (c.error !== undefined) {
        // Python 抛 ValueError；这里也必须抛，别让 "3.5" 静默变成 3.5。
        expect(() => h.emitEphemeral(session, "x", {})).toThrow();
      } else {
        const expected = c.out ?? 0;
        expect(h.emitEphemeral(session, "x", {})["seq"]).toBe(
          expected >= 0 ? expected + 1 : 0,
        );
      }
    }
  });
});

describe("正常落库", () => {
  it("projection 被原地回填成仓储的权威形态，订阅者只看到这一份", async () => {
    const c = G.commit_flow;
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession();
    const repo = new FakeRepo({ now: f.now });
    const q = new FakeQueue();
    session.subscribers.push(q);

    const projections = [0, 1, 2, 3].map((n) =>
      h.enqueue(session, repo, `step.${n}`, { n }),
    );
    const pending = projections.map((p) => ({ ...p }));
    await h.flush();

    expectShapes(pending, c.pending);
    expectShapes(projections, c.projections);
    expectShapes(q.drain(), c.delivered);
    expectShapes(session.events, c.session_events);
    expect(
      repo.rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        payload: r.payload,
        event_id: r.event_id,
      })),
    ).toEqual(c.rows);
    // 收据结清后必须摘掉，否则每条事件都在表里挂一份，长会话就是内存泄漏。
    expect(h.receipt(projections[0] as SessionEvent) === null).toBe(
      c.receipt_after_commit_is_none,
    );
    expect(await Promise.all(projections.map((p) => h.waitSeq(p)))).toEqual(
      c.wait_seq_after_commit,
    );
    await h.shutdown();
  });

  it("payload 冻结在 emit 边界 —— 之后调用方再改都不算数", async () => {
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession();
    const repo = new FakeRepo({ now: f.now });
    const rows: JsonValue[][] = [["before"]];
    const projection = h.enqueue(session, repo, "ui.table", { rows });
    (rows[0] as JsonValue[])[0] = "after";
    await h.flush();

    expect(repo.rows[0]?.payload).toEqual(G.payload_frozen.row_payload);
    expect(projection).toEqual(G.payload_frozen.projection);
    expect(rows).toEqual(G.payload_frozen.caller_rows);
    await h.shutdown();
  });

  it("仓储回的行没有 event_id 时，projection 上的 eventId 会消失", async () => {
    const c = G.no_event_id_echo;
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession();
    const projection = h.enqueue(
      session,
      new FakeRepo({ echoEventId: false, now: f.now }),
      "step.0",
      { n: 0 },
    );
    expect("eventId" in projection).toBe(c.had_event_id_before_commit);
    await h.flush();
    expectShape(projection, c);
    await h.shutdown();
  });

  it("会话没落过库时退化成 local-only，eventId 一并消失", async () => {
    const c = G.detached_session;
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession("s1", [{ seq: 7, kind: "旧事件" }]);
    const q = new FakeQueue();
    session.subscribers.push(q);

    const projection = h.enqueue(
      session,
      new FakeRepo({ exists: false, now: f.now }),
      "step.0",
      { n: 0 },
    );
    expectShape({ ...projection }, c.before_commit);
    await h.flush();

    expectShape(projection, c.after_commit);
    expectShapes(q.drain(), c.delivered);
    expectShapes(session.events, c.session_events);
    expect(await h.waitSeq(projection)).toBe(c.wait_seq);
    await h.shutdown();
  });
});

describe("落库失败", () => {
  it("吼日志 + 推一条 event.persist_failed，绝不假装送达", async () => {
    for (const c of G.persist_failed) {
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      });
      const f = fakes();
      const h = new DurableEventHub({ ...f, maxAttempts: c.max_attempts });
      const session = new FakeSession("s1", [{ seq: 4, kind: "旧事件" }]);
      const q = new FakeQueue();
      session.subscribers.push(q);
      const repo = new FakeRepo({ fail: 99, exc: excFor(c.exc), now: f.now });

      const projection = h.enqueue(session, repo, "chat.turn", { turn: { text: "hi" } });
      // **已知分叉**：golden 里 max_attempts=1 那条的 early 拿到的是 -1 而不是
      // 异常。那不是本模块的设计，是 asyncio 的调度产物 —— Python 协程要等被调度
      // 才开始执行，而 max_attempts=1 的失败路径上一次都没让出控制权，early 那个
      // task 第一次跑起来时收据已经被摘了。JS 的 async 函数体是同步开始的，
      // waitSeq 在调用瞬间就把收据抓在手里，所以三条都会收到异常 —— TS 这边
      // 反而更贴"绝不假装送达"这条契约。把 TS 的行为钉死在这里。
      const early = h.waitSeq(projection).then(
        (v) => ({ result: v as number | null, error: null as string | null }),
        (e: unknown) => ({
          result: null as number | null,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        }),
      );
      await h.flush();

      expect(await early).toEqual({ result: null, error: c.exc });
      // 失败之后**才**问的那一路：收据已摘，退化成读 projection 的负 seq。
      expect(await h.waitSeq(projection)).toBe(c.wait_seq_late.result);
      expect(c.wait_seq_late.error).toBeNull();

      expect(logged).toEqual(c.log_messages);
      expect(repo.calls).toBe(c.max_attempts);
      // 原 projection 原样留着（负 seq、eventId 都在）供诊断。
      expectShape(projection, c.projection);
      expectShapes(q.drain(), c.delivered);
      expectShapes(session.events, c.session_events);
      spy.mockRestore();
      await h.shutdown();
    }
  });

  it("没人等收据时，失败也不能把进程带走（unhandledRejection）", async () => {
    // Node 默认会因为无人处理的 rejected promise 直接退出进程；vitest 也会把它
    // 记成本次运行的错误。这个用例故意**不碰**收据 —— 它能跑完就是证据。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = hub({ maxAttempts: 1 });
    const session = new FakeSession();
    h.enqueue(session, new FakeRepo({ fail: 99 }), "chat.turn", { turn: { text: "hi" } });
    await h.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.events.some((e) => e["kind"] === "event.persist_failed")).toBe(true);
    spy.mockRestore();
    await h.shutdown();
  });

  it("坏订阅者不能把写入者带走（TS 侧的加固，Python 没有）", async () => {
    // Python 那边 writer task 一旦因异常死掉，`queue.join()` 就永远等不到，整个
    // loop 的耐久性静默停摆 —— 正是这个模块自己在骂的那种"丢事件还不吭声"。
    // 失败分支里的 putNowait 是裸调的，一个坏订阅者就够了。这里兜了一层。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = hub({ maxAttempts: 1 });
    const session = new FakeSession();
    session.subscribers.push({
      putNowait() {
        throw new Error("订阅者炸了");
      },
    });
    const repo = new FakeRepo({ fail: 1 });
    h.enqueue(session, repo, "会炸的那条", {});
    const survivor = h.enqueue(session, repo, "后面这条不许丢", {});
    await h.flush();

    expect(survivor["seq"]).toBe(0); // 写入者活下来了，后一条照常落库
    expect(repo.rows.map((r) => r.kind)).toEqual(["后面这条不许丢"]);
    spy.mockRestore();
    await h.shutdown();
  });

  it("一次瞬时失败后重试成功，不能写成两条", async () => {
    const c = G.retry_transient;
    const f = fakes();
    const h = new DurableEventHub({ ...f, maxAttempts: 2 });
    const session = new FakeSession();
    const repo = new FakeRepo({ fail: 1, exc: new OSErr("temporary"), now: f.now });
    const projection = h.enqueue(session, repo, "once", { n: 1 });
    await h.flush();

    expect(repo.calls).toBe(c.calls);
    expect(repo.rows.length).toBe(c.rows);
    expectShape(projection, c);
    await h.shutdown();
  });

  it("退避是 min(0.05 * 2**attempt, 0.5)，不是固定间隔", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const stub = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, 0); // 记下来就立刻放行，别真睡
    }) as unknown as typeof setTimeout;
    vi.stubGlobal("setTimeout", stub);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = hub({ maxAttempts: 8 });
      h.enqueue(new FakeSession(), new FakeRepo({ fail: 99 }), "x", {});
      await h.flush();
      await h.shutdown();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
    // 8 次尝试之间睡 7 次；两边都用 `delay * 1000` 换算，避免浮点换算方式不同。
    expect(delays).toEqual(G.backoff.slice(0, 7).map((b) => b.delay * 1000));
  });
});

describe("commit 之后的排序与去重", () => {
  it("非负 seq 在前升序，未落库的负 seq 在后按 |seq| 升序", async () => {
    expect(SORT_SEEDS.length).toBe(G.sort_and_dedupe.length);
    for (const [i, c] of G.sort_and_dedupe.entries()) {
      const seed = SORT_SEEDS[i] as SessionEvent[];
      expect(seed).toEqual(c.seed);
      const f = fakes();
      const h = new DurableEventHub(f);
      const session = new FakeSession("s1", seed);
      const projection = h.enqueue(
        session,
        new FakeRepo({ startSeq: c.row_seq, now: f.now }),
        "committed",
        { n: 0 },
      );
      await h.flush();

      expectShapes(session.events, c.session_events);
      expect(session.events.indexOf(projection)).toBe(c.projection_index);
      await h.shutdown();
    }
  });
});

describe("收据与排空", () => {
  it("receipt / waitSeq 的每个分支", async () => {
    const c = G.receipt_and_wait_seq;
    const h = hub();
    const session = new FakeSession();
    const projection = h.enqueue(session, new FakeRepo(), "step.0", { n: 0 });

    expect(h.receipt(projection) === null).toBe(c.receipt_pending_is_none);
    expect(h.receipt({ seq: -99 }) === null).toBe(c.receipt_unknown_is_none);
    // 已经是非负 seq 的事件：直接返回，不查收据。
    expect(await h.waitSeq({ seq: 12, kind: "x" })).toBe(c.wait_seq_already_committed);
    expect(await h.waitSeq({ kind: "x" })).toBe(c.wait_seq_no_seq_key);
    expect(await h.waitSeq({ seq: -7, kind: "x" })).toBe(c.wait_seq_unknown_negative);
    expect(await h.waitSeq(projection)).toBe(c.wait_seq_pending);
    await h.shutdown();
  });

  it("shutdown 先排空再停，之后还能继续用", async () => {
    const c = G.shutdown_drains;
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession();
    const repo = new FakeRepo({ now: f.now });
    const projections = [0, 1, 2, 3, 4, 5, 6, 7].map((n) =>
      h.enqueue(session, repo, "tail", { n }),
    );

    await h.shutdown(); // 没 flush，直接 shutdown：一条都不许丢

    expect(repo.rows.map((r) => r.payload["n"])).toEqual(c.rows);
    expect(projections.map((p) => p["seq"])).toEqual(c.seqs);

    const again = h.enqueue(session, repo, "after", { n: 8 });
    await h.flush();
    expect(again["seq"]).toBe(c.after_shutdown_seq);
    await h.shutdown();
  });

  it("空 hub 上的 flush / shutdown 是 no-op", async () => {
    const h = hub();
    await h.flush();
    await h.shutdown();
    await h.shutdown();
  });

  it("flush 期间新入队的事件也一起等（join 语义）", async () => {
    const f = fakes();
    const h = new DurableEventHub(f);
    const session = new FakeSession();
    const repo = new FakeRepo({ now: f.now });
    h.enqueue(session, repo, "a", {});
    const waiting = h.flush();
    h.enqueue(session, repo, "b", {});
    await waiting;
    expect(repo.rows.length).toBe(2);
    await h.shutdown();
  });
});

describe("进程级单例", () => {
  it("SESSION_EVENTS 是个可用的 DurableEventHub", async () => {
    const session = new FakeSession("singleton");
    const repo = new FakeRepo();
    const ev = SESSION_EVENTS.enqueue(session, repo, "step.0", { n: 0 });
    expect(ev["seq"]).toBeLessThan(0);
    // 真 uuid4().hex：32 位十六进制、无连字符。它是仓储的**幂等键**，所以这里
    // 用随机 id 不违反"内核里不许 uuid"那条 —— 那条约束的是可重放的 id。
    expect(ev["eventId"]).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof ev["ts"]).toBe("number");
    await SESSION_EVENTS.flush();
    expect(ev["seq"]).toBe(0);
    await SESSION_EVENTS.shutdown();
  });
});
