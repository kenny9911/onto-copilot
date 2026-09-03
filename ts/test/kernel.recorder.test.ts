/**
 * Recorder 的重放语义 —— 内核最容易写错的地方。
 *
 * 主体是 **golden 的 ops 程序**：golden/recorder.json 里每个用例是一串
 * open/effect/complete_node/ask_human/… ，Python 和这里各跑一遍同一串 ops，
 * 比对 (每步返回值, 完整事件流)。手写的期望值只是我对 Python 行为的猜测，
 * 事件流才是事实 —— 连 effect key 的编号、payload 的键顺序、blob 的 ref
 * 都一起被钉住了。
 *
 * golden 覆盖不到的两类，单独手写：
 *   1. **并发**（single-flight、等待者拿到领导者的异常）—— asyncio 与 Promise
 *      的并发模型不一样，没有共同的向量可导；
 *   2. **异步落盘**（契约 §2.1 的改动）—— Python 侧压根不存在这条路径。
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeterminismViolation } from "../src/kernel/errors.js";
import { EventKind, eventToDict } from "../src/kernel/events.js";
import { fingerprint } from "../src/kernel/ids.js";
import {
  FileJournal,
  InMemoryBlobStore,
  InMemoryJournal,
  type BlobStore,
  type Journal,
} from "../src/kernel/journal.js";
import { INLINE_LIMIT, Recorder, digestRequest } from "../src/kernel/recorder.js";

// ══════════════════════════════════════════════════════════════════
//  golden
// ══════════════════════════════════════════════════════════════════
interface Step {
  readonly op: string;
  readonly resume?: boolean;
  readonly node?: string;
  readonly kind?: string;
  readonly request?: Record<string, unknown>;
  readonly key?: string;
  readonly result?: unknown;
  readonly raises?: string;
  readonly output?: unknown;
  readonly attempt?: number;
  readonly request_id?: string;
  readonly payload?: Record<string, unknown>;
  readonly answer?: unknown;
}

interface Golden {
  readonly inline_limit: number;
  readonly fingerprints: { kind: string; request: Record<string, unknown>; fp: string }[];
  readonly cases: {
    name: string;
    why: string;
    steps: Step[];
    outputs: unknown[];
    events: Record<string, unknown>[];
  }[];
  readonly store: {
    why: string;
    value: unknown;
    json_len: number;
    inline: boolean;
    ref: string | null;
  }[];
  readonly digest: { why: string; request: Record<string, unknown>; out: Record<string, string> }[];
  readonly digest_divergent: {
    why: string;
    request: Record<string, unknown>;
    python: Record<string, string>;
  }[];
  readonly clock: {
    call: string;
    node: string;
    n: number | null;
    key: string;
    kind: string;
    fp: string;
    request: Record<string, string>;
  }[];
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/recorder.json"), "utf8"),
) as Golden;

/** `{"__repeat__": [ch, n]}` → 长串。长串不进 golden，只存生成式。 */
function materialize(spec: unknown): unknown {
  if (typeof spec === "object" && spec !== null && "__repeat__" in spec) {
    const [ch, n] = (spec as { __repeat__: [string, number] }).__repeat__;
    return ch.repeat(n);
  }
  return spec;
}

/** 用例里制造失败用的异常。类名会出现在 EFFECT_FAILED 的 error 字段里。 */
class Boom extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Boom";
    Object.setPrototypeOf(this, Boom.prototype);
  }
}

interface ErrorOut {
  readonly __error__: string;
  readonly message: string;
}

function errorOut(e: unknown): ErrorOut {
  const err = e as Error;
  return { __error__: err.constructor.name, message: err.message };
}

/**
 * **已知分叉**：Python 的 `node_output("ALIGN")` 抛的是 `KeyError('ALIGN')`，
 * JS 没有 KeyError。行为完全相同（未完成的节点取产出必须报错），只有消息不同 ——
 * 按契约 §3 钉住分叉的确切形状，而不是跳过这一步。
 */
const ERROR_DIVERGENCE = new Map<string, ErrorOut>([
  ["KeyError\u0000'ALIGN'", { __error__: "Error", message: "节点未完成: 'ALIGN'" }],
]);

function expectedOutput(golden: unknown): unknown {
  if (typeof golden !== "object" || golden === null || !("__error__" in golden)) return golden;
  const g = golden as ErrorOut;
  return ERROR_DIVERGENCE.get(`${g.__error__}\u0000${g.message}`) ?? g;
}

async function runOps(steps: readonly Step[]): Promise<{
  outputs: unknown[];
  events: Record<string, unknown>[];
}> {
  const journal: Journal = new InMemoryJournal();
  const blobs: BlobStore = new InMemoryBlobStore();
  let rec: Recorder | null = null;
  const outputs: unknown[] = [];

  for (const step of steps) {
    try {
      if (step.op === "open") {
        rec = new Recorder("r1", journal, blobs, { resume: step.resume === true });
        outputs.push(null);
        continue;
      }
      if (rec === null) throw new Error("第一步必须是 open");
      const node = step.node ?? "";
      switch (step.op) {
        case "effect": {
          const request = Object.fromEntries(
            Object.entries(step.request ?? {}).map(([k, v]) => [k, materialize(v)]),
          );
          const result = materialize(step.result);
          const fn =
            step.raises === undefined
              ? (): unknown => result
              : (): unknown => {
                  throw new Boom(step.raises as string);
                };
          outputs.push(
            await rec.effect(node, step.kind ?? "", request, fn, {
              key: step.key ?? null,
            }),
          );
          break;
        }
        case "complete_node":
          await rec.completeNode(node, materialize(step.output));
          outputs.push(null);
          break;
        case "node_is_complete":
          outputs.push(rec.nodeIsComplete(node));
          break;
        case "node_output":
          outputs.push(await rec.nodeOutput(node));
          break;
        case "next_attempt":
          outputs.push(rec.nextAttempt(node));
          break;
        case "node_entered":
          rec.emit(EventKind.NODE_ENTERED, { nodeId: node, payload: { attempt: step.attempt } });
          outputs.push(null);
          break;
        case "ask_human":
          outputs.push(await rec.askHuman(node, step.request_id ?? "", step.payload ?? {}));
          break;
        case "record_human_answer":
          rec.recordHumanAnswer(node, step.request_id ?? "", step.answer);
          outputs.push(null);
          break;
        default:
          throw new Error(`未知 op: ${step.op}`);
      }
    } catch (e) {
      outputs.push(errorOut(e));
    }
  }

  const events = [...journal.read("r1")].map((ev) => {
    const d: Record<string, unknown> = { ...eventToDict(ev) };
    delete d["ts_ms"]; // 墙钟不进比对
    return d;
  });
  return { outputs, events };
}

// ══════════════════════════════════════════════════════════════════
describe("golden ops 程序", () => {
  for (const c of G.cases) {
    it(`${c.name} —— ${c.why}`, async () => {
      const got = await runOps(c.steps);
      expect(got.outputs).toEqual(c.outputs.map(expectedOutput));
      expect(got.events).toEqual(c.events);
    });
  }
});

describe("effect 指纹", () => {
  it("fingerprint({kind, request}) 与 Python 逐字相同", () => {
    for (const g of G.fingerprints) {
      expect(fingerprint({ kind: g.kind, request: g.request })).toBe(g.fp);
    }
  });
});

describe("INLINE_LIMIT 边界", () => {
  it("常量本身与 Python 一致", () => {
    expect(INLINE_LIMIT).toBe(G.inline_limit);
  });

  for (const g of G.store) {
    it(g.why, async () => {
      const journal = new InMemoryJournal();
      const blobs = new InMemoryBlobStore();
      const rec = new Recorder("r1", journal, blobs);
      const value = materialize(g.value);
      await rec.effect("N", "tool.exec", {}, () => value);
      const ev = [...journal.read("r1")].find((e) => e.kind === EventKind.EFFECT_COMPLETED);
      expect(ev).toBeDefined();
      expect("result" in ev!.payload).toBe(g.inline);
      // ref 也逐字相同 —— blob 是内容寻址的，ref 一变，Python 时代写下的
      // blob 就一个都找不回来了。
      expect(ev!.ref).toBe(g.ref);
      if (!g.inline) {
        const rec2 = new Recorder("r1", journal, blobs, { resume: true });
        expect(await rec2.effect("N", "tool.exec", {}, () => "WRONG")).toEqual(value);
      }
    });
  }
});

describe("请求摘要", () => {
  it("golden 的每一组逐字节一致", () => {
    for (const g of G.digest) {
      const request = Object.fromEntries(
        Object.entries(g.request).map(([k, v]) => [k, materialize(v)]),
      );
      expect(digestRequest(request), g.why).toEqual(g.out);
    }
  });

  it("已知分叉：值为整数的 float（只影响日志里的摘要，不影响指纹与重放）", () => {
    // JS 分不出 1 与 1.0 —— 与 ids.ts / journal.ts 同一条语言边界。指数记号那条
    // 不再是分叉（pyfmt 的 pyFloatRepr 抹平了）。摘要不进 fp，所以重放不受影响；
    // 这里把分叉的确切形状钉下来，别哪天"顺手修好"。
    const ts: Record<string, string>[] = G.digest_divergent.map((g) => digestRequest(g.request));
    expect(G.digest_divergent.map((g) => g.python)).toEqual([
      { t: "1.0" },
      { t: "0.25" },
      { t: "1e-05" },
      { args: "{'temperature': 1.0}" },
    ]);
    expect(ts).toEqual([
      { t: "1" }, // ← 唯一的分叉
      { t: "0.25" },
      { t: "1e-05" }, // 指数记号两边一致
      { args: "{'temperature': 1}" }, // ← 同一条分叉，嵌在容器里
    ]);
  });
});

describe("完整请求 blob 捕获", () => {
  it("显式开启时 requested.ref 指向原始结构，payload 仍保留可扫列表的 digest", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const rec = new Recorder("r1", journal, blobs, { captureRequestBlobs: true });
    const request = {
      prompt: "采".repeat(520),
      schema: { type: "object", required: ["answer"] },
      nested: { api_key: "只用于验证原始结构没有在存储前被改写" },
    };

    await expect(rec.effect("N", "llm.call", request, () => ({ ok: true }))).resolves.toEqual({ ok: true });

    const requested = [...journal.read("r1")].find((event) => event.kind === EventKind.EFFECT_REQUESTED);
    expect(requested?.ref).toMatch(/^blob:/u);
    expect(requested?.payload["request_fidelity"]).toBe("full");
    expect((requested?.payload["request"] as Record<string, string>)["prompt"]).toContain("…(+120)");
    expect(await blobs.getJson(requested!.ref!)).toEqual(request);
  });

  it("request blob 写失败只降级审计 fidelity，effect 仍执行并正常完成", async () => {
    class RejectingBlobStore extends InMemoryBlobStore {
      override put(_data: Uint8Array | string): Promise<string> {
        return Promise.reject(new Error("request blob unavailable"));
      }
    }

    const journal = new InMemoryJournal();
    const rec = new Recorder("r1", journal, new RejectingBlobStore(), {
      captureRequestBlobs: true,
    });
    let calls = 0;
    const out = await rec.effect("N", "tool.call", { query: "采购审批" }, () => {
      calls += 1;
      return { ok: true };
    });

    expect(out).toEqual({ ok: true });
    expect(calls).toBe(1);
    const events = [...journal.read("r1")];
    const requested = events.find((event) => event.kind === EventKind.EFFECT_REQUESTED);
    expect(requested?.ref).toBeNull();
    expect(requested?.payload).toMatchObject({
      request: { query: "采购审批" },
      request_fidelity: "digest",
      request_capture_error: "Error: request blob unavailable",
    });
    expect(events.some((event) => event.kind === EventKind.EFFECT_COMPLETED)).toBe(true);
  });
});

describe("时间与随机走 effect", () => {
  for (const g of G.clock) {
    it(`${g.call} 的 effect 形状（key/kind/fp/摘要）`, async () => {
      const journal = new InMemoryJournal();
      const blobs = new InMemoryBlobStore();
      const rec = new Recorder("r1", journal, blobs);
      const first = g.call === "now" ? await rec.now(g.node) : await rec.rand(g.node, g.n ?? 1);
      const ev = [...journal.read("r1")].find((e) => e.kind === EventKind.EFFECT_REQUESTED);
      expect(ev?.payload).toEqual({
        key: g.key,
        kind: g.kind,
        fp: g.fp,
        request: g.request,
      });
      // 重放拿回首次那个值：这正是"工作流逻辑不许读墙钟"的兑现方式
      const rec2 = new Recorder("r1", journal, blobs, { resume: true });
      const again = g.call === "now" ? await rec2.now(g.node) : await rec2.rand(g.node, g.n ?? 1);
      expect(again).toBe(first);
    });
  }

  it("rand 的取值落在 [0, n)", async () => {
    const rec = new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
    for (let i = 0; i < 50; i += 1) {
      const v = await rec.rand("N", 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("rand(0) 抛错而不是悄悄返回 0", async () => {
    // 悄悄返回的那个 0 会被记进日志，之后每次重放都理直气壮地还给你。
    const rec = new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
    await expect(rec.rand("N", 0)).rejects.toThrow("empty range for randrange()");
  });
});

// ══════════════════════════════════════════════════════════════════
//  并发：没有 golden（asyncio 与 Promise 的模型不同），手写
// ══════════════════════════════════════════════════════════════════
describe("single-flight", () => {
  it("同一显式 key 并发只执行一次副作用", async () => {
    const journal = new InMemoryJournal();
    const rec = new Recorder("r1", journal, new InMemoryBlobStore());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fn = async (): Promise<unknown> => {
      calls += 1;
      await gate;
      return { ok: true };
    };

    const first = rec.effect("N", "tool.call", { id: 1 }, fn, { key: "same" });
    const second = rec.effect("N", "tool.call", { id: 1 }, fn, { key: "same" });
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(calls).toBe(1);

    const kinds = [...journal.read("r1")].map((e) => e.kind);
    expect(kinds.filter((k) => k === EventKind.EFFECT_REQUESTED)).toHaveLength(1);
    expect(kinds.filter((k) => k === EventKind.EFFECT_COMPLETED)).toHaveLength(1);
  });

  it("同一 key 但请求不同 → fail closed", async () => {
    const rec = new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = rec.effect("N", "x", { v: 1 }, async () => {
      await gate;
      return "ok";
    }, { key: "k" });
    await expect(rec.effect("N", "x", { v: 2 }, () => "ok", { key: "k" })).rejects.toBeInstanceOf(
      DeterminismViolation,
    );
    release();
    expect(await first).toBe("ok");
  });

  it("领导者失败：等待者拿到同一个异常，之后 key 可以重试", async () => {
    const rec = new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const boom = new Boom("沙箱超时");
    const first = rec.effect("N", "x", { v: 1 }, async () => {
      await gate;
      throw boom;
    }, { key: "k" });
    const second = rec.effect("N", "x", { v: 1 }, () => "never", { key: "k" });
    release();
    await expect(first).rejects.toBe(boom);
    await expect(second).rejects.toBe(boom);
    // 失败的 effect 没记账，同 key 重来一次是真的重跑
    expect(await rec.effect("N", "x", { v: 1 }, () => "retried", { key: "k" })).toBe("retried");
  });

  it("领导者失败且**无人等待**时不会掀翻进程", async () => {
    // 契约 §2.1：无人 await 的 rejected promise 在 Node 里会触发 unhandledRejection
    // 直接杀进程。single-flight 的那个 future 必须一创建就挂上空 catch。
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      seen.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const rec = new Recorder("r1", new InMemoryJournal(), new InMemoryBlobStore());
      await expect(
        rec.effect("N", "x", {}, () => {
          throw new Boom("没人等我");
        }, { key: "lonely" }),
      ).rejects.toThrow("没人等我");
      // 给 Node 两轮宏任务去派发 unhandledRejection
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("无显式 key 的并发计数器互不干扰（各拿各的序号）", async () => {
    const journal = new InMemoryJournal();
    const rec = new Recorder("r1", journal, new InMemoryBlobStore());
    const out = await Promise.all([
      rec.effect("N", "t", { i: 0 }, () => "a"),
      rec.effect("N", "t", { i: 1 }, () => "b"),
    ]);
    expect(out).toEqual(["a", "b"]);
    const keys = [...journal.read("r1")]
      .filter((e) => e.kind === EventKind.EFFECT_COMPLETED)
      .map((e) => e.payload["key"]);
    expect(new Set(keys)).toEqual(new Set(["N#0", "N#1"]));
  });
});

describe("不可缓存的权限敏感 effect", () => {
  it("崩溃后恢复仍实时执行，撤权前结果只留审计、不能被重放", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const beforeCrash = new Recorder("acl-run", journal, blobs);
    let calls = 0;
    expect(await beforeCrash.effect(
      "TOOL",
      "tool.call",
      { tool: "document.open", evidence_ref: "odoc.v1.doc.ver.chunk" },
      () => {
        calls += 1;
        return { ok: true, text: "撤权前正文" };
      },
      { replay: "never" },
    )).toEqual({ ok: true, text: "撤权前正文" });

    // 模拟进程崩溃后 ACL 已撤销：同一个 run、同一个 effect key、同一个请求。
    const resumed = new Recorder("acl-run", journal, blobs, { resume: true });
    expect(await resumed.effect(
      "TOOL",
      "tool.call",
      { tool: "document.open", evidence_ref: "odoc.v1.doc.ver.chunk" },
      () => {
        calls += 1;
        return { ok: false, error: "当前账号已无权读取" };
      },
      { replay: "never" },
    )).toEqual({ ok: false, error: "当前账号已无权读取" });
    expect(calls).toBe(2);

    const completed = [...journal.read("acl-run")]
      .filter((event) => event.kind === EventKind.EFFECT_COMPLETED);
    expect(completed).toHaveLength(2);
    expect(completed.every((event) => event.payload["replay_policy"] === "never")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  异步落盘（契约 §2.1 的改动，Python 侧不存在这条路径）
// ══════════════════════════════════════════════════════════════════
describe("与 FileJournal 的配合", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-recorder-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emit 之后不 flush 也能读回（重放不能少步骤）", async () => {
    const journal = new FileJournal(join(dir, "j"));
    const rec = new Recorder("r1", journal, new InMemoryBlobStore());
    await rec.effect("N", "llm.call", { p: 1 }, () => "out");
    // 还没 flush：read() 必须把队列里的也算上，否则同进程里"写完立刻重放"会少事件
    expect([...journal.read("r1")]).toHaveLength(2);

    const rec2 = new Recorder("r1", journal, new InMemoryBlobStore(), { resume: true });
    expect(await rec2.effect("N", "llm.call", { p: 1 }, () => "WRONG")).toBe("out");
    await journal.flush();
  });

  it("Run 收尾 await flush() 之后，历史能被新进程读到", async () => {
    const root = join(dir, "j2");
    const blobs = new InMemoryBlobStore();
    const journal = new FileJournal(root);
    const rec = new Recorder("r1", journal, blobs);
    await rec.effect("N", "llm.call", { p: 1 }, () => "out");
    await rec.completeNode("N", { objects: 23 });
    await journal.flush(); // ← 调度器的责任：Recorder 自己不 flush

    expect(readdirSync(root)).toEqual(["r1.jsonl"]);
    const fresh = new FileJournal(root); // 新"进程"
    const rec2 = new Recorder("r1", fresh, blobs, { resume: true });
    expect(rec2.nodeIsComplete("N")).toBe(true);
    expect(await rec2.nodeOutput("N")).toEqual({ objects: 23 });
    expect(await rec2.effect("N", "llm.call", { p: 1 }, () => "WRONG")).toBe("out");
  });
});
