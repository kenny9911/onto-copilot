/**
 * 事件流 → span 树。
 *
 * 这一层最容易出的不是"少了几条 trace"，而是**它把执行搞坏了** —— 上报后端挂了
 * 导致梳理失败，或者旁路读了什么东西让重放分叉。所以测试的重头在"绝不影响执行"
 * 那几条，而不只是格式对不对。
 */

import { describe, expect, it, vi } from "vitest";

import { EventKind, makeEvent, type Event, type EventKind as Kind } from "../src/kernel/events.js";
import {
  OtelBridge,
  OtlpHttpExporter,
  bridgeFromEnv,
  exporterFromEnv,
  spanIdFor,
  traceIdFor,
  type TraceExporter,
} from "../src/kernel/otel.js";

// ── 测试替身 ──────────────────────────────────────────────────────

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  events: { name: string }[];
  status: { code: number; message?: string };
}

class Collect implements TraceExporter {
  readonly spans: Span[] = [];
  send(s: readonly unknown[]): void {
    this.spans.push(...(s as Span[]));
  }
  async drain(): Promise<void> {}
}

let ts = 1_000;
function ev(kind: Kind, nodeId: string | null = null, payload: Record<string, unknown> = {}): Event {
  ts += 10;
  return makeEvent({ runId: "R", seq: 0, kind, nodeId, payload, tsMs: ts });
}

function attrOf(s: Span, key: string): unknown {
  return s.attributes.find((a) => a.key === key)?.value;
}

// ── id 派生 ───────────────────────────────────────────────────────

describe("traceId 从 runId 推出来，不随机", () => {
  it("同一个 runId 永远是同一个 trace —— 拿到会话号就能直接拼 trace URL", () => {
    // 随机 traceId 会让这条路断掉：FDE 报障时给的就是会话号。
    expect(traceIdFor("run-abc")).toBe(traceIdFor("run-abc"));
    expect(traceIdFor("run-abc")).not.toBe(traceIdFor("run-abd"));
  });

  it("长度合规：trace 32 hex（128 位），span 16 hex（64 位）", () => {
    expect(traceIdFor("x")).toMatch(/^[0-9a-f]{32}$/);
    expect(spanIdFor("x", "node:a")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("span id 同时取决于 runId 和局部键 —— 两个 Run 的同名节点不能撞", () => {
    expect(spanIdFor("R1", "node:a")).not.toBe(spanIdFor("R2", "node:a"));
    expect(spanIdFor("R1", "node:a")).not.toBe(spanIdFor("R1", "node:b"));
  });
});

// ── span 树 ───────────────────────────────────────────────────────

describe("成对事件构成 span，其余挂成 span event", () => {
  it("run → node → effect 三层父子关系", async () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "抽取"));
    b.observe(ev(EventKind.EFFECT_REQUESTED, "抽取", { key: "抽取#0", kind: "llm" }));
    b.observe(ev(EventKind.EFFECT_COMPLETED, "抽取", { key: "抽取#0", kind: "llm" }));
    b.observe(ev(EventKind.NODE_COMPLETED, "抽取"));
    b.observe(ev(EventKind.RUN_COMPLETED));
    await b.close();

    const byName = new Map(c.spans.map((s) => [s.name, s]));
    const run = byName.get("run")!;
    const node = byName.get("node 抽取")!;
    const eff = byName.get("effect llm @抽取")!;
    expect(run.parentSpanId).toBeUndefined();
    expect(node.parentSpanId).toBe(run.spanId);
    expect(eff.parentSpanId).toBe(node.spanId);
    expect(new Set(c.spans.map((s) => s.traceId))).toEqual(new Set([traceIdFor("R")]));
  });

  it("一个节点里的并发 effect 各有各的 span —— 键取 payload.key 而不是 nodeId", () => {
    // 用 nodeId 当键的话，第二个 effect 的 REQUESTED 会被当成"重复开"忽略，
    // 第一个 COMPLETED 又会把它关掉，四个 critic 视角只剩一条。
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "评审"));
    for (const k of ["评审#正确性", "评审#完备性"]) {
      b.observe(ev(EventKind.EFFECT_REQUESTED, "评审", { key: k, kind: "llm" }));
    }
    for (const k of ["评审#正确性", "评审#完备性"]) {
      b.observe(ev(EventKind.EFFECT_COMPLETED, "评审", { key: k, kind: "llm" }));
    }
    b.flush();
    expect(c.spans.filter((s) => s.name.startsWith("effect")).length).toBe(2);
    expect(new Set(c.spans.map((s) => s.spanId)).size).toBe(2);
  });

  it("不成对的事件挂到最内层 span 上，不自成 span", () => {
    // 零时长的 span 在瀑布图上是噪声；span event 才是它们的位置。
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "抽取"));
    b.observe(ev(EventKind.THOUGHT, "抽取"));
    b.observe(ev(EventKind.CRITIC_VERDICT, "抽取", { verdict: "pass" }));
    b.observe(ev(EventKind.NODE_COMPLETED, "抽取"));
    b.flush();
    const node = c.spans.find((s) => s.name === "node 抽取")!;
    expect(node.events.map((e) => e.name)).toEqual([EventKind.THOUGHT, EventKind.CRITIC_VERDICT]);
    expect(c.spans.length).toBe(1);
  });

  it("失败事件带 ERROR 状态与 error 文案", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "编译"));
    b.observe(ev(EventKind.NODE_FAILED, "编译", { error: "模板列对不上" }));
    b.flush();
    const s = c.spans[0]!;
    expect(s.status).toEqual({ code: 2, message: "模板列对不上" });
  });

  it("node.skipped 是 UNSET 不是 ERROR —— 跳过不是失败", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.NODE_ENTERED, "n"));
    b.observe(ev(EventKind.NODE_SKIPPED, "n"));
    b.flush();
    expect(c.spans[0]!.status.code).toBe(0);
  });

  it("没见过开头的结尾被丢掉 —— 不造一条起点为 0 的假长条", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.NODE_COMPLETED, "半路挂上的桥"));
    b.flush();
    expect(c.spans).toEqual([]);
  });

  it("时间戳换算成纳秒", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(makeEvent({ runId: "R", seq: 0, kind: EventKind.NODE_ENTERED, nodeId: "n", tsMs: 5 }));
    b.observe(
      makeEvent({ runId: "R", seq: 1, kind: EventKind.NODE_COMPLETED, nodeId: "n", tsMs: 12 }),
    );
    b.flush();
    expect(c.spans[0]!.startTimeUnixNano).toBe("5000000");
    expect(c.spans[0]!.endTimeUnixNano).toBe("12000000");
  });
});

describe("收尾：没关的 span 也要发出去", () => {
  it("Run 中断时仍开着的 span 标 unterminated + ERROR —— 那恰恰是最想看的几个", async () => {
    // 丢掉它们的话，"卡死"在瀑布图上表现为"什么都没发生"。
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "卡住的节点"));
    await b.close();
    expect(c.spans.length).toBe(2);
    for (const s of c.spans) {
      expect(s.status.code).toBe(2);
      expect(attrOf(s, "oc.unterminated")).toEqual({ boolValue: true });
    }
  });

  it("根 span 一关就自动收尾发出去 —— 不必等下一次 Run", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c, { batchSize: 10_000 });
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "还开着的节点"));
    b.observe(ev(EventKind.RUN_COMPLETED));
    // 没调 close()、也没到 batchSize，但 run 关了就该发
    expect(c.spans.map((s) => s.name).sort()).toEqual(["node 还开着的节点", "run"]);
  });

  it("RUN_FAILED 之后的尾巴事件仍然上报 —— 那正是解释『为什么被放弃』的那些", () => {
    // scheduler 文件头：取消之后还在跑的节点仍会往 journal 写事件。
    // 一见终态就关死桥的话，这段尾巴在 trace 里彻底消失。
    const c = new Collect();
    const b = new OtelBridge("R", c, { batchSize: 10_000 });
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.RUN_FAILED, null, { error: "预算耗尽" }));
    const before = c.spans.length;
    b.observe(ev(EventKind.NODE_ENTERED, "被放弃时还在跑的节点"));
    b.observe(ev(EventKind.NODE_COMPLETED, "被放弃时还在跑的节点"));
    expect(c.spans.length).toBe(before + 1); // 终态后不再攒批，立刻发
    expect(c.spans.at(-1)!.name).toBe("node 被放弃时还在跑的节点");
  });

  it("收尾按逆序：内层先关，父子关系还在", async () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.RUN_STARTED));
    b.observe(ev(EventKind.NODE_ENTERED, "n"));
    await b.close();
    expect(c.spans.map((s) => s.name)).toEqual(["node n", "run"]);
    expect(c.spans[0]!.parentSpanId).toBe(c.spans[1]!.spanId);
  });
});

// ── 隐私与背压 ────────────────────────────────────────────────────

describe("payload 只挑白名单 —— 上报目的地通常在公司外面", () => {
  it("材料内容、LLM 全文这类键不外发", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.NODE_ENTERED, "n", { kind: "llm" }));
    b.observe(
      ev(EventKind.NODE_COMPLETED, "n", {
        result: "客户的采购制度全文……",
        prompt: "系统提示词",
        text: "材料切片",
        usd: 0.012,
      }),
    );
    b.flush();
    const keys = c.spans[0]!.attributes.map((a) => a.key);
    expect(keys).toContain("oc.usd");
    expect(keys).not.toContain("oc.result");
    expect(keys).not.toContain("oc.prompt");
    expect(keys).not.toContain("oc.text");
  });

  it("白名单键的值是 null/undefined 时不产出属性 —— 空属性是噪声，不是信息", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.NODE_ENTERED, "n"));
    b.observe(ev(EventKind.NODE_COMPLETED, "n", { error: null, model: undefined, usd: 0 }));
    b.flush();
    const keys = c.spans[0]!.attributes.map((a) => a.key);
    expect(keys).not.toContain("oc.error");
    expect(keys).not.toContain("oc.model");
    expect(keys).toContain("oc.usd"); // 0 是有意义的值，不能跟 null 一起被滤掉
  });

  it("ref 只带引用字符串，blob 内容绝不外发", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c);
    b.observe(ev(EventKind.NODE_ENTERED, "n"));
    b.observe(
      makeEvent({
        runId: "R",
        seq: 1,
        kind: EventKind.NODE_COMPLETED,
        nodeId: "n",
        ref: "blob:abc",
        tsMs: 2,
      }),
    );
    b.flush();
    expect(attrOf(c.spans[0]!, "oc.ref")).toEqual({ stringValue: "blob:abc" });
  });
});

describe("绝不影响执行", () => {
  it("导出器抛异常 → observe 吞掉，不往上冒", () => {
    const boom: TraceExporter = {
      send() {
        throw new Error("上报后端挂了");
      },
      async drain() {},
    };
    const b = new OtelBridge("R", boom, { batchSize: 1 });
    expect(() => {
      b.observe(ev(EventKind.NODE_ENTERED, "n"));
      b.observe(ev(EventKind.NODE_COMPLETED, "n"));
    }).not.toThrow();
  });

  it("队列满了丢最旧的并计数，不背压内核", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c, { batchSize: 10_000, maxQueue: 3 });
    for (let i = 0; i < 10; i++) {
      b.observe(ev(EventKind.NODE_ENTERED, `n${i}`));
      b.observe(ev(EventKind.NODE_COMPLETED, `n${i}`));
    }
    expect(b.dropped).toBe(7);
    b.flush();
    expect(c.spans.length).toBe(3);
    expect(c.spans.map((s) => s.name)).toEqual(["node n7", "node n8", "node n9"]);
  });

  it("攒够 batchSize 自动发一批", () => {
    const c = new Collect();
    const b = new OtelBridge("R", c, { batchSize: 2 });
    for (let i = 0; i < 2; i++) {
      b.observe(ev(EventKind.NODE_ENTERED, `n${i}`));
      b.observe(ev(EventKind.NODE_COMPLETED, `n${i}`));
    }
    expect(c.spans.length).toBe(2); // 没等 close 就发了
  });
});

// ── 导出器与装配 ──────────────────────────────────────────────────

describe("OtlpHttpExporter", () => {
  it("endpoint 带不带 /v1/traces 都认 —— 省掉一类『配好了却没数据』", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (u: string) => {
      seen.push(u);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    for (const ep of ["http://x:4318", "http://x:4318/", "http://x:4318/v1/traces"]) {
      const e = new OtlpHttpExporter({ endpoint: ep, fetchImpl: f });
      e.send([{ name: "s" } as never]);
      await e.drain();
    }
    expect(seen).toEqual(Array(3).fill("http://x:4318/v1/traces"));
  });

  it("空批次不发请求", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    new OtlpHttpExporter({ endpoint: "http://x", fetchImpl: f }).send([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("网络失败只计数，不抛 —— fire-and-forget", async () => {
    const f = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const e = new OtlpHttpExporter({ endpoint: "http://x", fetchImpl: f });
    e.send([{ name: "s" } as never]);
    await e.drain();
    expect(e.failures).toBe(1);
  });

  it("HTTP 非 2xx 也计入失败", async () => {
    const f = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const e = new OtlpHttpExporter({ endpoint: "http://x", fetchImpl: f });
    e.send([{ name: "s" } as never]);
    await e.drain();
    expect(e.failures).toBe(1);
  });

  it("trace/span id 在 JSON 里是 hex 字符串，不是 base64", async () => {
    // OTLP 的 JSON 映射对这两个字段有特例；搞反的话后端**静默丢 span**。
    let body = "";
    const f = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const e = new OtlpHttpExporter({ endpoint: "http://x", fetchImpl: f });
    const b = new OtelBridge("R", e, { batchSize: 1 });
    b.observe(ev(EventKind.NODE_ENTERED, "n"));
    b.observe(ev(EventKind.NODE_COMPLETED, "n"));
    await e.drain();
    const parsed = JSON.parse(body) as {
      resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
    };
    const span = parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.traceId).toBe(traceIdFor("R"));
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("按环境变量装配：没配就是彻底关掉", () => {
  it("没有 endpoint → null，调用方据此完全不挂 observer（零开销）", () => {
    // 返回一个"发到本地然后失败"的导出器会让每条事件都走一趟无用网络调用。
    expect(exporterFromEnv({})).toBeNull();
    expect(exporterFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBeNull();
    expect(bridgeFromEnv("R", {})).toBeNull();
  });

  it("认标准的 OTEL_EXPORTER_OTLP_ENDPOINT，也认项目私有名", () => {
    expect(exporterFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" })).not.toBeNull();
    expect(exporterFromEnv({ ONTOCOPILOT_OTLP_ENDPOINT: "http://x:4318" })).not.toBeNull();
  });

  it("OTEL_EXPORTER_OTLP_HEADERS 解析成请求头（托管后端的 API key 走这里）", async () => {
    let headers: Record<string, string> = {};
    const f = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const e = exporterFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://x",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=秘密, x-team = 平台组",
    })!;
    // exporterFromEnv 用真 fetch，这里换掉；只测解析结果
    (e as unknown as { f: typeof fetch }).f = f;
    e.send([{ name: "s" } as never]);
    await e.drain();
    expect(headers["x-api-key"]).toBe("秘密");
    expect(headers["x-team"]).toBe("平台组");
  });
});
