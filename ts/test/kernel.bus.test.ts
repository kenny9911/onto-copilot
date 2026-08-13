/**
 * kernel/bus 的 golden 校验 —— golden/bus.json 由 tools/golden/bus.py 从 Python 侧
 * 真跑出来（1280 条模糊向量 + 手挑的 fnmatch 边界 + 黑板 op 程序 + 一段 AgentBus
 * 脚本的真实事件流）。
 *
 * 三个重点，都是 Python 侧测试**没有覆盖**、TS 上却极易分叉的地方：
 *
 *   1. **通配语义**。它是 `ScopeSpec.blackboardPattern` 的执行体，也就是 DAG
 *      作用域隔离的实际判据。匹配范围一宽，节点就能读到不该读的上游状态，
 *      而且不会有任何报错 —— 只会安静地多看见一些东西。所以这里不写"看起来
 *      对"的用例，而是把 CPython 的真值表整张搬过来。
 *   2. **排序 / 切片 / 长度的基准**（code point vs UTF-16 code unit）。
 *   3. **`{:.2f}`** 的舍入规则。
 *
 * 一条**显式钉住的已知分叉**：JS 里 1 与 1.0 是同一个值，Python 内存里的 float
 * 经 canonical_json 是 "1.0"，TS 只能给 "1"（见 ids.ts 头部）。黑板的 value 是
 * float 时，`contested` 的分组键与 `fmtValue` 的输出都跟着不同。最后一个
 * describe 把这条钉成"必须不一样，且不一样成这个样子"，不是绕过。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HarnessError } from "../src/kernel/errors.js";
import { EventKind, makeEvent, type Event } from "../src/kernel/events.js";
import { fingerprint } from "../src/kernel/ids.js";
import {
  Blackboard,
  Entry,
  fmtValue,
  fnmatchcase,
  formatFixed2,
  makeRevision,
  revisionToDict,
  type Revision,
} from "../src/kernel/bus/blackboard.js";
import {
  AgentBus,
  BusError,
  makeMessage,
  type Message,
  type RecorderLike,
} from "../src/kernel/bus/bus.js";

// ══════════════════════════════════════════════════════════════════
//  golden 形状
// ══════════════════════════════════════════════════════════════════
interface FnRow {
  pat: string;
  name: string;
  match?: boolean;
  error?: string;
}
interface FnSurrogateRow {
  pat_cp: number[];
  name_cp: number[];
  match: boolean;
}
interface PyRevision {
  rev: number;
  key: string;
  value: unknown;
  by: string;
  support: string[];
  confidence: number;
  note: string;
}
interface PyEntry {
  current: PyRevision;
  contested: boolean;
  variants: PyRevision[];
  writers: string[];
  n_revisions: number;
}
interface BoardOp {
  key: string;
  value: unknown;
  by: string;
  support?: string[];
  confidence?: number;
  note?: string;
}
interface BoardCase {
  name: string;
  writes: { rev: PyRevision; newly: boolean }[];
  fired: { pattern: string; key: string; rev: number; newly: boolean }[];
  len: number;
  contested_keys: string[];
  keys: Record<string, string[]>;
  snapshot: Record<string, Record<string, unknown>>;
  snapshot_keys: Record<string, string[]>;
  render: { pattern: string; limit: number; out: string }[];
  entries: Record<string, PyEntry>;
  replay: {
    keys: string[];
    snapshot: Record<string, unknown>;
    snapshot_keys: string[];
    next_rev: number;
  };
}
interface PyBusEvent {
  run_id: string;
  seq: number;
  kind: string;
  node_id?: string;
  payload?: Record<string, unknown>;
  ref?: string;
  payload_keys: string[];
}
interface Golden {
  fnmatch: FnRow[];
  fnmatch_surrogate: FnSurrogateRow[];
  fnmatch_fuzz: FnRow[];
  board: BoardCase[];
  fmt: { value: unknown; out: string }[];
  ekey: { to: string; kind: string; payload: Record<string, unknown> | null; req_fp: string; ekey: string }[];
  bus: {
    broadcast_n: number[];
    subscribers_seen: string[];
    unregistered_message: string;
    request_result: unknown;
    request_result_keyed: unknown;
    effect_keys: string[];
    events: PyBusEvent[];
    restore_board: number;
  };
  float_divergence: { value: unknown; fmt: string }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "bus.json"), "utf8"),
) as Golden;

// 这些用例里的 ops 得从 golden 的 writes 反推 —— golden 存的是执行结果，
// 而每条结果里恰好带着当时的入参（rev.to_dict 就是入参的全量）。
function opsOf(c: BoardCase): BoardOp[] {
  return c.writes.map((w) => ({
    key: w.rev.key,
    value: w.rev.value,
    by: w.rev.by,
    support: w.rev.support,
    confidence: w.rev.confidence,
    note: w.rev.note,
  }));
}

// tools/golden/bus.py 里 watch 的模式没进 golden 的输出（只有 fired 里带
// pattern），所以这里从 fired 里恢复不出"注册了但从没触发"的模式。手写一份，
// 与生成脚本保持一致 —— 它是**输入**不是期望值，写错了 fired 会立刻对不上。
const WATCH_PATTERNS: Record<string, string[]> = {
  same_value_twice_is_not_a_conflict: ["glossary/*"],
  watchers_fire_on_new_conflict_only: ["oir/*", "*", "glossary/?"],
};

// ══════════════════════════════════════════════════════════════════
//  1. fnmatch
// ══════════════════════════════════════════════════════════════════
describe("fnmatchcase == CPython fnmatch.fnmatchcase", () => {
  it("手挑的边界用例全过", () => {
    const bad: string[] = [];
    for (const row of G.fnmatch) {
      if (row.error !== undefined) {
        // CPython 在这条上抛异常；TS 侧也必须抛，静默返回 false 是更坏的结果
        // （一个本该炸的模式会变成"什么都不匹配"，作用域悄悄收窄）。
        expect(() => fnmatchcase(row.name, row.pat)).toThrow();
        continue;
      }
      const got = fnmatchcase(row.name, row.pat);
      if (got !== row.match) {
        bad.push(`pat=${JSON.stringify(row.pat)} name=${JSON.stringify(row.name)} 期望 ${String(row.match)} 得到 ${String(got)}`);
      }
    }
    expect(bad).toEqual([]);
    expect(G.fnmatch.length).toBeGreaterThan(200);
  });

  it("确定性模糊向量全过（种子写死，1000+ 条）", () => {
    const bad: string[] = [];
    for (const row of G.fnmatch_fuzz) {
      if (row.error !== undefined) {
        expect(() => fnmatchcase(row.name, row.pat)).toThrow();
        continue;
      }
      const got = fnmatchcase(row.name, row.pat);
      if (got !== row.match) {
        bad.push(`pat=${JSON.stringify(row.pat)} name=${JSON.stringify(row.name)} 期望 ${String(row.match)} 得到 ${String(got)}`);
      }
    }
    expect(bad).toEqual([]);
    expect(G.fnmatch_fuzz.length).toBeGreaterThan(1000);
  });

  it("落单代理码元：`?` 吃的是一个 code point 而不是一个 code unit", () => {
    // 这一组的 pat/name 在 golden 里存成 code point 数组 —— 落单代理无法用
    // UTF-8 编码，塞进 JSON 字符串会让导出直接炸。
    for (const row of G.fnmatch_surrogate) {
      const pat = row.pat_cp.map((c) => String.fromCodePoint(c)).join("");
      const name = row.name_cp.map((c) => String.fromCodePoint(c)).join("");
      expect(fnmatchcase(name, pat)).toBe(row.match);
    }
    // 退回 UTF-16 语义的话，`?` 会匹配半个 emoji、`??` 会匹配整个 emoji。
    expect(fnmatchcase("😀", "?")).toBe(true);
    expect(fnmatchcase("😀", "??")).toBe(false);
  });

  it("空字符类让整个模式永不匹配，而不是只让那一位永不匹配", () => {
    // `[b-a]` 是逆序区间 → CPython 译成 `(?!)`（零宽且必失败），所以连
    // "长度不对" 都轮不到判断，整条模式对任何输入都是 false。
    expect(fnmatchcase("xy", "x[b-a]y")).toBe(false);
    expect(fnmatchcase("xay", "x[b-a]y")).toBe(false);
    expect(fnmatchcase("anything", "*[b-a]*")).toBe(false);
  });

  it("模式缓存不会串味", () => {
    // 编译结果按模式串缓存；两个只差一个字符的模式必须各编译各的。
    expect(fnmatchcase("oir/x", "oir/*")).toBe(true);
    expect(fnmatchcase("oir/x", "oir/?")).toBe(true);
    expect(fnmatchcase("oir/xy", "oir/?")).toBe(false);
    expect(fnmatchcase("oir/xy", "oir/*")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. format(x, ".2f")
// ══════════════════════════════════════════════════════════════════
describe("formatFixed2 == Python format(x, '.2f')", () => {
  it("半整数走银行家舍入（toFixed 在这四个点上是错的）", () => {
    // 期望值不是手写的：它们逐字出现在 golden 的 render_confidence_two_decimals
    // 里，下面 render 的 golden 断言会连带把它们再钉一遍。
    expect(formatFixed2(0.125)).toBe("0.12");
    expect(formatFixed2(0.375)).toBe("0.38");
    expect(formatFixed2(0.625)).toBe("0.62");
    expect(formatFixed2(0.875)).toBe("0.88");
    expect(formatFixed2(-0.125)).toBe("-0.12");
    // 这四个点上 toFixed 与 CPython 不同 —— 钉住"确实不同"，免得哪天有人
    // 觉得这个函数是多余的。
    expect((0.125).toFixed(2)).toBe("0.13");
    expect((0.625).toFixed(2)).toBe("0.63");
  });

  it("符号取自输入，非有限值走 Python 的拼写", () => {
    expect(formatFixed2(-0)).toBe("-0.00");
    expect(formatFixed2(0)).toBe("0.00");
    expect(formatFixed2(-0.001)).toBe("-0.00");
    expect(formatFixed2(NaN)).toBe("nan");
    expect(formatFixed2(Infinity)).toBe("inf");
    expect(formatFixed2(-Infinity)).toBe("-inf");
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. _fmt
// ══════════════════════════════════════════════════════════════════
describe("fmtValue == Python _fmt", () => {
  it("golden 向量全过", () => {
    for (const row of G.fmt) {
      expect(fmtValue(row.value)).toBe(row.out);
    }
  });

  it("截断按 code point 而不是 UTF-16 长度", () => {
    // 95 个 emoji：Python 的 len 是 95 > 90 要截断，JS 的 .length 是 190。
    // 若按 .length 切，会切出 45 个 emoji（90 个 code unit）而不是 90 个。
    const s = "😀".repeat(95);
    const out = fmtValue(s);
    expect([...out].length).toBe(91); // 90 个 code point + "…"
    expect(out.endsWith("…")).toBe(true);
    // 边界：恰好 90 个 code point 不截断。
    expect(fmtValue("😀".repeat(90))).toBe("😀".repeat(90));
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. Blackboard —— 回放 golden 里的 op 程序
// ══════════════════════════════════════════════════════════════════
function revToPy(r: Revision): PyRevision {
  return revisionToDict(r) as unknown as PyRevision;
}

describe("Blackboard 对齐 golden 的 op 程序", () => {
  for (const c of G.board) {
    it(c.name, () => {
      const bb = new Blackboard();
      const fired: { pattern: string; key: string; rev: number; newly: boolean }[] = [];
      for (const pattern of WATCH_PATTERNS[c.name] ?? []) {
        bb.watch(pattern, (key, rev, newly) => {
          fired.push({ pattern, key, rev: rev.rev, newly });
        });
      }

      const writes = opsOf(c).map((op) => {
        const [rev, newly] = bb.write(op.key, op.value, {
          by: op.by,
          support: op.support ?? [],
          confidence: op.confidence ?? 0.5,
          note: op.note ?? "",
        });
        return { rev: revToPy(rev), newly };
      });

      expect(writes).toEqual(c.writes);
      expect(fired).toEqual(c.fired);
      expect(bb.size).toBe(c.len);
      expect(bb.contested().map((e) => e.key)).toEqual(c.contested_keys);

      for (const [pattern, expected] of Object.entries(c.keys)) {
        expect(bb.keys(pattern)).toEqual(expected);
      }
      for (const [pattern, expected] of Object.entries(c.snapshot_keys)) {
        const snap = bb.snapshot(pattern);
        // 键序单独比：JSON.parse 会把整数形键重排，对象比不出顺序。
        expect([...snap.keys()]).toEqual(expected);
        expect(Object.fromEntries(snap)).toEqual(c.snapshot[pattern]);
      }
      for (const r of c.render) {
        expect(bb.render(r.pattern, r.limit)).toBe(r.out);
      }

      for (const [key, expected] of Object.entries(c.entries)) {
        const e = bb.entry(key);
        expect(e).toBeInstanceOf(Entry);
        const entry = e as Entry;
        expect(revToPy(entry.current)).toEqual(expected.current);
        expect(entry.contested).toBe(expected.contested);
        expect(entry.variants.map(revToPy)).toEqual(expected.variants);
        expect(entry.writers()).toEqual(expected.writers);
        expect(entry.revisions.length).toBe(expected.n_revisions);
      }

      // 从事件形态重建：黑板必须能从日志重建，否则恢复 Run 会丢共享状态。
      const bb2 = new Blackboard();
      bb2.replay(c.writes.map((w) => w.rev as unknown as Record<string, unknown>));
      expect(bb2.keys("*")).toEqual(c.replay.keys);
      expect([...bb2.snapshot("*").keys()]).toEqual(c.replay.snapshot_keys);
      expect(Object.fromEntries(bb2.snapshot("*"))).toEqual(c.replay.snapshot);
      // _rev 水位是私有的，只能靠"再写一条看它拿到几号"观测。
      const [probe] = bb2.write("__probe__", 0, { by: "probe" });
      expect(probe.rev).toBe(c.replay.next_rev);
    });
  }
});

describe("Blackboard 的 TS 侧风险点", () => {
  it("空 Entry 取 current 会炸而不是给 undefined", () => {
    // Python 是 max([]) 的 ValueError。给 undefined 的话，调用方会拿着
    // `undefined.value` 在别处炸，栈上看不出真正的原因。
    expect(() => new Entry("k").current).toThrow(/没有任何版本/);
  });

  it("support 存进去之后调用方改不动", () => {
    const bb = new Blackboard();
    const mine = ["a.xlsx!R1C1"];
    const [rev] = bb.write("k", 1, { by: "N", support: mine });
    mine.push("偷偷加的");
    expect(rev.support).toEqual(["a.xlsx!R1C1"]);
    // to_dict 出去的是新数组，改它也回不来。
    const d = revisionToDict(rev);
    (d["support"] as string[]).push("也偷偷加的");
    expect(rev.support).toEqual(["a.xlsx!R1C1"]);
  });

  it("read 的默认值走 Python 的 None 位置", () => {
    const bb = new Blackboard();
    expect(bb.read("没有的")).toBe(null);
    expect(bb.read("没有的", 42)).toBe(42);
    bb.write("有的", 0, { by: "N" });
    expect(bb.read("有的", 42)).toBe(0); // 值为 0 时不能退回默认值
  });

  it("replay 对残缺的日志行大声失败", () => {
    const bb = new Blackboard();
    expect(() => bb.replay([{ key: "k", value: 1, by: "N" }])).toThrow(/rev/);
    expect(() => bb.replay([{ rev: 1, value: 1, by: "N" }])).toThrow(/key/);
    // 缺省字段照 Python 的 d.get(..., 默认) 补齐。
    bb.replay([{ rev: 7, key: "k", value: 1, by: "N" }]);
    const e = bb.entry("k") as Entry;
    expect(e.current.confidence).toBe(0.5);
    expect(e.current.support).toEqual([]);
    expect(e.current.note).toBe("");
  });

  it("makeRevision 的默认值与 Python 的 dataclass 默认值一致", () => {
    const r = makeRevision({ rev: 1, key: "k", value: null, by: "N" });
    expect(revisionToDict(r)).toEqual({
      rev: 1, key: "k", value: null, by: "N", support: [], confidence: 0.5, note: "",
    });
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. AgentBus
// ══════════════════════════════════════════════════════════════════
/**
 * Recorder 的测试替身。
 *
 * **不是 kernel/recorder.ts 的移植** —— 那是另一条 track。这里只实现 bus 真正
 * 依赖的那一小块：emit 分配 seq 入内存日志；effect 首次执行时记结果，重放时
 * 直接读回。够用来验证"重放不会二次调用对方"，不够用来验证 Recorder 本身。
 */
class FakeRecorder implements RecorderLike {
  readonly runId: string;
  readonly events: Event[];
  readonly journal: { read(runId: string): Iterable<Event> };
  private seq = 0;
  private readonly counters = new Map<string, number>();
  private readonly effects = new Map<string, { fp: string; result: unknown }>();

  constructor(runId: string, events: Event[] = [], resume = false) {
    this.runId = runId;
    this.events = events;
    this.journal = { read: (rid: string) => events.filter((e) => e.runId === rid) };
    if (resume) {
      for (const ev of events) {
        this.seq = Math.max(this.seq, ev.seq + 1);
        if (ev.kind === EventKind.EFFECT_COMPLETED) {
          const key = ev.payload["key"] as string;
          if (!this.effects.has(key)) {
            this.effects.set(key, { fp: ev.payload["fp"] as string, result: ev.payload["result"] });
          }
        }
      }
    }
  }

  emit(
    kind: EventKind,
    opts?: { nodeId?: string | null; payload?: Record<string, unknown>; ref?: string | null },
  ): Event {
    const ev = makeEvent({
      runId: this.runId,
      seq: this.seq,
      kind,
      nodeId: opts?.nodeId ?? null,
      payload: opts?.payload ?? {},
      ref: opts?.ref ?? null,
      tsMs: 0,
    });
    this.seq += 1;
    this.events.push(ev);
    return ev;
  }

  async effect(
    nodeId: string,
    kind: string,
    request: Record<string, unknown>,
    fn: () => unknown | Promise<unknown>,
    opts?: { key?: string | null },
  ): Promise<unknown> {
    let ekey: string;
    const k = opts?.key;
    if (k === undefined || k === null) {
      const idx = this.counters.get(nodeId) ?? 0;
      this.counters.set(nodeId, idx + 1);
      ekey = `${nodeId}#${idx}`;
    } else {
      ekey = `${nodeId}#${k}`;
    }
    const fp = fingerprint({ kind, request });
    const recorded = this.effects.get(ekey);
    if (recorded !== undefined) {
      if (recorded.fp !== fp) throw new Error(`effect ${ekey} 重放不一致`);
      return recorded.result;
    }
    this.emit(EventKind.EFFECT_REQUESTED, { nodeId, payload: { key: ekey, kind, fp } });
    const result = await fn();
    this.effects.set(ekey, { fp, result });
    this.emit(EventKind.EFFECT_COMPLETED, {
      nodeId,
      payload: { key: ekey, kind, fp, result },
    });
    return result;
  }
}

function busEventRows(events: readonly Event[]): PyBusEvent[] {
  const kinds: EventKind[] = [EventKind.BLACKBOARD_WRITE, EventKind.MESSAGE_SENT];
  return events
    .filter((e) => kinds.includes(e.kind))
    .map((e) => {
      const row: PyBusEvent = {
        run_id: e.runId,
        seq: e.seq,
        kind: e.kind,
        payload_keys: Object.keys(e.payload),
      };
      if (e.nodeId !== null) row.node_id = e.nodeId;
      if (Object.keys(e.payload).length > 0) row.payload = e.payload;
      if (e.ref !== null) row.ref = e.ref;
      return row;
    });
}

describe("AgentBus 对齐 golden 的事件流", () => {
  it("post / broadcast / request 写出的事件逐字一致", async () => {
    const rec = new FakeRecorder("r1");
    const bus = new AgentBus(rec);

    const seen: string[] = [];
    bus.subscribe("budget/*", (m) => seen.push(`budget:${String(m.payload["level"])}`));
    bus.subscribe("*", (m) => seen.push(`all:${m.to}`));
    bus.register("ACTOR", (m: Message) => ({ ok: true, kind: m.kind }));

    bus.post("glossary/采购包", "purchasePackage", { by: "N1", confidence: 0.6 });
    bus.post("oir/x/def", "含税", { by: "N1", support: ["a.xlsx!R1C1"], confidence: 0.8 });
    bus.post("oir/x/def", "不含税", { by: "N2", confidence: 0.7, note: "来自 DDL" });

    const ns = [
      bus.broadcast({ frm: "SCHED", topic: "budget/degrade", payload: { level: "critic_rounds=1" } }),
      bus.broadcast({ frm: "SCHED", topic: "run/cancel" }),
      bus.broadcast({ frm: "SCHED", topic: "t", payload: { mode: "覆盖", receivers: -1 } }),
    ];
    expect(ns).toEqual(G.bus.broadcast_n);
    expect(seen).toEqual(G.bus.subscribers_seen);

    let message = "";
    try {
      await bus.request({ frm: "A", to: "不存在", kind: "x" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(G.bus.unregistered_message);

    expect(await bus.request({ frm: "CRITIC", to: "ACTOR", kind: "justify", payload: { claim: "c" } }))
      .toEqual(G.bus.request_result);
    expect(await bus.request({ frm: "CRITIC", to: "ACTOR", kind: "ask", payload: { i: 1 }, key: "q1" }))
      .toEqual(G.bus.request_result_keyed);

    expect(busEventRows(rec.events)).toEqual(G.bus.events);
    expect(
      rec.events
        .filter((e) => e.kind === EventKind.EFFECT_REQUESTED)
        .map((e) => e.payload["key"]),
    ).toEqual(G.bus.effect_keys);

    // 从日志重建黑板（Python 侧是同步方法，这里是 async —— 见文件头/deviations）。
    const bus2 = new AgentBus(new FakeRecorder("r1", rec.events, true));
    expect(await bus2.restoreBoard()).toBe(G.bus.restore_board);
    expect(bus2.read("glossary/采购包")).toBe("purchasePackage");
    expect(bus2.contested().map((e) => e.key)).toEqual(["oir/x/def"]);
  });

  it("effect key 的拼接形状", () => {
    for (const v of G.ekey) {
      const req = { to: v.to, kind: v.kind, payload: v.payload ?? {} };
      expect(fingerprint(req)).toBe(v.req_fp);
      expect(`msg:${v.to}:${v.kind}:${fingerprint(req)}`).toBe(v.ekey);
    }
  });

  it("重放时不再调用对方（对方内部可能是昂贵的 LLM 调用）", async () => {
    const rec = new FakeRecorder("r1");
    const bus = new AgentBus(rec);
    let calls = 0;
    const handler = () => {
      calls += 1;
      return { ok: true };
    };
    bus.register("ACTOR", handler);
    await bus.request({ frm: "CRITIC", to: "ACTOR", kind: "justify", payload: { c: 1 } });
    expect(calls).toBe(1);

    const bus2 = new AgentBus(new FakeRecorder("r1", rec.events, true));
    bus2.register("ACTOR", handler);
    const out = await bus2.request({ frm: "CRITIC", to: "ACTOR", kind: "justify", payload: { c: 1 } });
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it("显式 key 让并发请求各走各的（重放顺序不同也对得上）", async () => {
    const rec = new FakeRecorder("r1");
    const bus = new AgentBus(rec);
    bus.register("ACTOR", (m) => `ans:${String(m.payload["i"])}`);
    const out = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        bus.request({ frm: "C", to: "ACTOR", kind: "ask", payload: { i }, key: `q${String(i)}` }),
      ),
    );
    expect(out).toEqual(["ans:0", "ans:1", "ans:2", "ans:3"]);

    const bus2 = new AgentBus(new FakeRecorder("r1", rec.events, true));
    bus2.register("ACTOR", () => "WRONG");
    const again = await Promise.all(
      [3, 2, 1, 0].map((i) =>
        bus2.request({ frm: "C", to: "ACTOR", kind: "ask", payload: { i }, key: `q${String(i)}` }),
      ),
    );
    expect(again).toEqual(["ans:3", "ans:2", "ans:1", "ans:0"]);
  });

  it("同步处理器与异步处理器走同一条路", async () => {
    const bus = new AgentBus(new FakeRecorder("r1"));
    bus.register("SYNC", () => "同步");
    bus.register("ASYNC", async () => Promise.resolve("异步"));
    expect(await bus.request({ frm: "C", to: "SYNC", kind: "k" })).toBe("同步");
    expect(await bus.request({ frm: "C", to: "ASYNC", kind: "k" })).toBe("异步");
  });

  it("BusError 是 HarnessError（编排层错误，不是节点失败）", async () => {
    const bus = new AgentBus(new FakeRecorder("r1"));
    await expect(bus.request({ frm: "A", to: "无", kind: "x" })).rejects.toBeInstanceOf(BusError);
    await expect(bus.request({ frm: "A", to: "无", kind: "x" })).rejects.toBeInstanceOf(
      HarnessError,
    );
  });

  it("传进来的黑板不会被换掉", () => {
    // Python 侧那行必须写 `is None` 而不是 `or`：Blackboard 定义了 __len__，
    // 空黑板是 falsy，用 `or` 会把调用方的共享黑板换成一个新的空黑板。
    // JS 里对象恒真，这个坑不存在 —— 但共享语义本身要有测试守着。
    const shared = new Blackboard();
    const bus = new AgentBus(new FakeRecorder("r1"), shared);
    expect(bus.board).toBe(shared);
    bus.post("k", 1, { by: "N" });
    expect(shared.read("k")).toBe(1);
  });

  it("广播只送给 glob 命中的订阅者，且回执数就是命中数", () => {
    const bus = new AgentBus(new FakeRecorder("r1"));
    const got: string[] = [];
    bus.subscribe("oir/*", () => got.push("oir"));
    bus.subscribe("oir/x", () => got.push("exact"));
    expect(bus.broadcast({ frm: "S", topic: "oir/x" })).toBe(2);
    expect(bus.broadcast({ frm: "S", topic: "oir/y" })).toBe(1);
    expect(bus.broadcast({ frm: "S", topic: "glossary/a" })).toBe(0);
    expect(got).toEqual(["oir", "exact", "oir"]);
  });

  it("makeMessage 的默认值", () => {
    expect(makeMessage({ frm: "A", to: "B", kind: "k" })).toEqual({
      frm: "A", to: "B", kind: "k", payload: {}, replyTo: null,
    });
  });

  it("renderFacts 就是黑板的 render", () => {
    const bus = new AgentBus(new FakeRecorder("r1"));
    bus.post("oir/x", "含税", { by: "A" });
    bus.post("glossary/y", "z", { by: "B" });
    expect(bus.renderFacts("oir/*")).toBe(bus.board.render("oir/*"));
    expect(bus.renderFacts("oir/*")).not.toContain("glossary/y");
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. 已知分叉（钉住形状，不绕过）
// ══════════════════════════════════════════════════════════════════
describe("已知分叉：float 值的 canonical_json", () => {
  it("Python 的 1.0 在这里只能是 1", () => {
    const py = new Map(G.float_divergence.map((r) => [JSON.stringify(r.value), r.fmt]));
    // Python: "1.0"    TS: "1"
    expect(py.get("1")).toBe("1.0");
    expect(fmtValue(1.0)).toBe("1");
    // Python: "-0.0"   TS: "-0.0"（ids.ts 对 -0 特判过，这一个反而是一致的）
    expect(py.get("0")).toBe("-0.0");
    expect(fmtValue(-0)).toBe("-0.0");
    // 列表里同理：整数值的 float 掉小数点，非整数的 float 两边一致。
    expect(py.get("[1,2.5]")).toBe("[1.0,2.5]");
    expect(fmtValue([1.0, 2.5])).toBe("[1,2.5]");
  });

  it("后果：值是 float 时 contested 的分组键跨语言不可比", () => {
    // TS 侧自洽（1 与 1.0 本来就是同一个值，判成"同一个说法"是对的），
    // 但拿 Python 时代的日志来重放，分组结果可能不同。这是语言边界。
    const bb = new Blackboard();
    bb.write("k", 1, { by: "A" });
    const [, newly] = bb.write("k", 1.0, { by: "B" });
    expect(newly).toBe(false);
    expect((bb.entry("k") as Entry).contested).toBe(false);
  });
});
