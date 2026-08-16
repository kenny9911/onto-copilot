/**
 * events 的 golden 校验 —— 27 种 kind 与 4 条往返样本都是 Python 侧真跑出来的。
 *
 * 这个模块的价值全在**字节形状**上：kind 的字面值、to_dict 的字段省略规则、
 * 键的插入顺序。三样里任何一样漂了，历史 jsonl 就重放不回来，而且不会当场报错。
 * 所以这里的断言全部落在字节上，不落在"看起来对不对"上。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/kernel/ids.js";
import {
  EVENT_KINDS,
  EventKind,
  REPLAYABLE,
  eventFromDict,
  eventToDict,
  makeEvent,
  nowMs,
  parseEventKind,
} from "../src/kernel/events.js";

interface Golden {
  kinds: string[];
  roundtrip: { dict: Record<string, unknown>; line: string }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/events.json"), "utf8"),
) as Golden;

describe("EventKind 与 Python StrEnum 同值同序", () => {
  it("全部 27 种，顺序一致", () => {
    expect(EVENT_KINDS).toEqual(G.kinds);
    expect(EVENT_KINDS).toHaveLength(27);
  });

  it("没有重名值（两个 kind 撞同一个字符串会让重放选错分支）", () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });

  it("parseEventKind 接受每一个 golden 值并原样返回", () => {
    for (const k of G.kinds) expect(parseEventKind(k)).toBe(k);
  });

  it("parseEventKind 对未知值抛错，不静默放行", () => {
    // 成员名不是值 —— Python 侧 EventKind("RUN_STARTED") 同样是 ValueError。
    expect(() => parseEventKind("RUN_STARTED")).toThrow();
    expect(() => parseEventKind("run.unknown")).toThrow();
    expect(() => parseEventKind("")).toThrow();
    expect(() => parseEventKind(null)).toThrow();
    expect(() => parseEventKind(0)).toThrow();
    expect(() => parseEventKind(undefined)).toThrow();
  });

  it("REPLAYABLE 就是那两种", () => {
    expect([...REPLAYABLE].sort()).toEqual(["effect.completed", "human.recorded"]);
  });
});

describe("往返样本：to_dict 的字节与 jsonl 行", () => {
  for (const [i, g] of G.roundtrip.entries()) {
    it(`向量 ${i} —— ${String(g.dict["kind"])}`, () => {
      const ev = eventFromDict(g.dict);

      // 1. 字段集合与值
      expect(eventToDict(ev)).toEqual(g.dict);

      // 2. 键的插入顺序 —— journal 的 json.dumps 不排序，落盘字节直接跟着它走
      expect(Object.keys(eventToDict(ev))).toEqual(Object.keys(g.dict));

      // 3. 整行字节（golden 的 line 是 sort_keys + separators=(",",":") + ensure_ascii=False，
      //    与 canonicalJson 同定义），非 ASCII 不转义这一条也一并钉住
      expect(canonicalJson(eventToDict(ev))).toBe(g.line);
    });
  }

  it("from_dict → to_dict 是恒等（重放读回来的事件再写出去必须一模一样）", () => {
    for (const g of G.roundtrip) {
      expect(eventToDict(eventFromDict(eventToDict(eventFromDict(g.dict))))).toEqual(g.dict);
    }
  });

  it("样本二的 payload 键序在 canonical 化时被排序，与源 dict 无关", () => {
    // 源 dict 是 {mode, attempt}，golden line 里是 {"attempt":…,"mode":…}。
    const g = G.roundtrip[1]!;
    expect(g.line).toContain('"payload":{"attempt":1,"mode":"plan_execute"}');
    expect(canonicalJson(eventToDict(eventFromDict(g.dict)))).toBe(g.line);
  });
});

describe("makeEvent 的默认值（Python dataclass 默认值搬到工厂里）", () => {
  const ev = makeEvent({ runId: "r", seq: 0, kind: EventKind.RUN_STARTED });

  it("nodeId / ref 默认 null，payload 默认空对象，tsMs 默认 0", () => {
    expect(ev.nodeId).toBeNull();
    expect(ev.ref).toBeNull();
    expect(ev.payload).toEqual({});
    expect(ev.tsMs).toBe(0);
  });

  it("默认 payload 不共享 —— 两条事件各拿各的对象", () => {
    const a = makeEvent({ runId: "r", seq: 0, kind: EventKind.THOUGHT });
    const b = makeEvent({ runId: "r", seq: 1, kind: EventKind.THOUGHT });
    expect(a.payload).not.toBe(b.payload);
  });

  it("显式传入的 payload 也复制 —— 调用方之后改它，已落日志的事件不许跟着变", () => {
    const src: Record<string, unknown> = { a: 1 };
    const e = makeEvent({ runId: "r", seq: 0, kind: EventKind.THOUGHT, payload: src });
    src["a"] = 2;
    src["b"] = 3;
    expect(e.payload).toEqual({ a: 1 });
  });

  it("事件对象本身冻结（对应 frozen=True，同样只保一层）", () => {
    expect(() => {
      (ev as { seq: number }).seq = 99;
    }).toThrow(TypeError);
    expect(ev.seq).toBe(0);
  });
});

describe("字段省略规则 —— 决定 jsonl 字节形状，Python 侧没覆盖但漂了就静默丢字段", () => {
  const base = { runId: "r", seq: 7, kind: EventKind.NODE_ENTERED, tsMs: 1 };

  it("nodeId=null / payload={} / ref=null 三个字段全省略", () => {
    expect(canonicalJson(eventToDict(makeEvent(base)))).toBe(
      '{"kind":"node.entered","run_id":"r","seq":7,"ts_ms":1}',
    );
  });

  it("nodeId 是空串要写出来 —— 判据是 !== null，不是真值性", () => {
    const d = eventToDict(makeEvent({ ...base, nodeId: "" }));
    expect(Object.hasOwn(d, "node_id")).toBe(true);
    expect(d.node_id).toBe("");
  });

  it("ref 是空串要写出来", () => {
    const d = eventToDict(makeEvent({ ...base, ref: "" }));
    expect(Object.hasOwn(d, "ref")).toBe(true);
    expect(d.ref).toBe("");
  });

  it("payload 只在为空对象时省略；含 falsy 值的 payload 要写", () => {
    expect(Object.hasOwn(eventToDict(makeEvent({ ...base, payload: {} })), "payload")).toBe(false);
    const d = eventToDict(makeEvent({ ...base, payload: { ok: false, n: 0, s: "" } }));
    expect(d.payload).toEqual({ ok: false, n: 0, s: "" });
  });

  it("ts_ms 与 seq 即使是 0 也照写（它们不在省略名单里）", () => {
    const d = eventToDict(makeEvent({ runId: "r", seq: 0, kind: EventKind.RUN_STARTED }));
    expect(d.seq).toBe(0);
    expect(d.ts_ms).toBe(0);
  });
});

describe("eventFromDict 的宽容与拒绝", () => {
  const min = { run_id: "r", seq: 3, kind: "run.failed" };

  it("缺 node_id / payload / ref / ts_ms 时回退到默认", () => {
    const e = eventFromDict(min);
    expect(e).toEqual({
      runId: "r",
      seq: 3,
      kind: "run.failed",
      nodeId: null,
      payload: {},
      ref: null,
      tsMs: 0,
    });
  });

  it("payload 为 null（Python 的 `or {}` 路径）归一成空对象", () => {
    expect(eventFromDict({ ...min, payload: null }).payload).toEqual({});
  });

  it("读回来的 payload 与源 dict 不共享引用", () => {
    const src: Record<string, unknown> = { ...min, payload: { a: 1 } };
    const e = eventFromDict(src);
    (src["payload"] as Record<string, unknown>)["a"] = 2;
    expect(e.payload).toEqual({ a: 1 });
  });

  it("未知 kind 抛错（损坏或来自更新版本的日志不许悄悄读进来）", () => {
    expect(() => eventFromDict({ ...min, kind: "run.teleported" })).toThrow();
  });

  it("整行不是对象时抛错（jsonl 里出现 null / 数组 / 裸标量）", () => {
    expect(() => eventFromDict(null)).toThrow();
    expect(() => eventFromDict([min])).toThrow();
    expect(() => eventFromDict("run.failed")).toThrow();
  });

  it("缺 run_id / seq 抛错（对应 Python 的 KeyError）", () => {
    expect(() => eventFromDict({ seq: 1, kind: "run.failed" })).toThrow();
    expect(() => eventFromDict({ run_id: "r", kind: "run.failed" })).toThrow();
  });

  it("类型不对当场拒绝 —— 这是相对 Python 的有意收紧", () => {
    expect(() => eventFromDict({ ...min, seq: "3" })).toThrow();
    expect(() => eventFromDict({ ...min, node_id: 5 })).toThrow();
    expect(() => eventFromDict({ ...min, ref: 5 })).toThrow();
    expect(() => eventFromDict({ ...min, ts_ms: "1" })).toThrow();
    expect(() => eventFromDict({ ...min, payload: [1, 2] })).toThrow();
  });
});

describe("nowMs", () => {
  it("是整数毫秒且落在合理区间（只给事件记录用，业务逻辑不许读）", () => {
    const t = nowMs();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(1.7e12);
  });
});
