/**
 * 接线的集成测试：真 Recorder → 真 HTTP → 真收集端。
 *
 * 单测证明了桥的逻辑对，证明不了**它真的被挂上了**、发出去的字节真的是 OTLP。
 * 这里起一个本地 collector 收下来，按 OTLP 的字段名逐个查。
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventKind } from "../src/kernel/events.js";
import { FileBlobStore, FileJournal } from "../src/kernel/journal.js";
import { bridgeFromEnv, traceIdFor } from "../src/kernel/otel.js";
import { Recorder } from "../src/kernel/recorder.js";

interface Received {
  resourceSpans: {
    resource: { attributes: { key: string; value: Record<string, string> }[] };
    scopeSpans: {
      scope: { name: string };
      spans: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number; message?: string };
      }[];
    }[];
  }[];
}

let server: Server;
let port = 0;
let paths: string[] = [];
let bodies: Received[] = [];
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-otel-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      paths.push(req.url ?? "");
      try {
        bodies.push(JSON.parse(raw) as Received);
      } catch {
        bodies.push({ resourceSpans: [] });
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function fresh(): { rec: Recorder; done: () => Promise<void> } {
  paths = [];
  bodies = [];
  const runId = "run-接线测试";
  const bridge = bridgeFromEnv(runId, {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_SERVICE_NAME: "ontocopilot-test",
  })!;
  const rec = new Recorder(runId, new FileJournal(join(dir, "j")), new FileBlobStore(join(dir, "b")), {
    observer: (e) => bridge.observe(e),
  });
  return { rec, done: () => bridge.close() };
}

describe("Recorder 的 observer 钩子 → OTLP collector", () => {
  it("一次 Run 的 span 树真的发到了 /v1/traces", async () => {
    const { rec, done } = fresh();
    rec.emit(EventKind.RUN_STARTED, { payload: { dag: "extraction" } });
    rec.emit(EventKind.NODE_ENTERED, { nodeId: "抽取", payload: { attempt: 0 } });
    rec.emit(EventKind.EFFECT_REQUESTED, {
      nodeId: "抽取",
      payload: { key: "抽取#0", kind: "llm", fp: "abc" },
    });
    rec.emit(EventKind.EFFECT_COMPLETED, {
      nodeId: "抽取",
      payload: { key: "抽取#0", kind: "llm", fp: "abc", usd: 0.012 },
    });
    rec.emit(EventKind.NODE_COMPLETED, { nodeId: "抽取" });
    rec.emit(EventKind.RUN_COMPLETED, { payload: {} });
    await done();

    expect(paths).toEqual(["/v1/traces"]);
    const spans = bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    expect(spans.map((s) => s.name).sort()).toEqual([
      "effect llm @抽取",
      "node 抽取",
      "run",
    ]);
    // traceId 由 runId 推出来 —— 会话号就是查 trace 的入口
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceIdFor("run-接线测试")]));
    const byName = new Map(spans.map((s) => [s.name, s]));
    expect(byName.get("effect llm @抽取")!.parentSpanId).toBe(byName.get("node 抽取")!.spanId);
    expect(spans.every((s) => s.status.code === 1)).toBe(true);
  });

  it("resource 上带 service.name —— 后端按它分服务", async () => {
    const { rec, done } = fresh();
    rec.emit(EventKind.RUN_STARTED, {});
    rec.emit(EventKind.RUN_COMPLETED, {});
    await done();
    const attrs = bodies[0]!.resourceSpans[0]!.resource.attributes;
    expect(attrs.find((a) => a.key === "service.name")!.value["stringValue"]).toBe(
      "ontocopilot-test",
    );
  });

  it("collector 挂掉时 emit 照常返回 —— 上报失败不能让梳理失败", async () => {
    const runId = "run-collector-挂了";
    const bridge = bridgeFromEnv(runId, {
      // 一个必然连不上的端口
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    })!;
    const rec = new Recorder(
      runId,
      new FileJournal(join(dir, "j2")),
      new FileBlobStore(join(dir, "b2")),
      { observer: (e) => bridge.observe(e) },
    );
    expect(() => {
      rec.emit(EventKind.RUN_STARTED, {});
      rec.emit(EventKind.RUN_COMPLETED, {});
    }).not.toThrow();
    await bridge.close();
  });

  it("没配 endpoint → 不挂 observer，事件照常进 journal", () => {
    expect(bridgeFromEnv("r", {})).toBeNull();
    const rec = new Recorder(
      "run-无上报",
      new FileJournal(join(dir, "j3")),
      new FileBlobStore(join(dir, "b3")),
    );
    const ev = rec.emit(EventKind.RUN_STARTED, {});
    expect(ev.seq).toBe(0);
  });
});
