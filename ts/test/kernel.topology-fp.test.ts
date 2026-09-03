/**
 * P0：拓扑指纹 —— RUN_STARTED 只记 dag.name 的年代，恢复一轮跑批时没人核对
 * "现在这张图"和"检查点是从哪张图上落下来的"是不是同一张。嵌套调度器的
 * 子 DAG 是按材料内容**运行时编译**出来的：材料一变、图就变，旧检查点混着
 * 新拓扑重放是无声的错账。这里钉三件事：
 *   1. RUN_STARTED 带上 topology_fp + node_count；
 *   2. 同一 journal 里同名 DAG 换了形状 → fail closed（拒跑，不猜）；
 *   3. 掺盐 fork（checkpointVersion 变、形状没变）**不**触发拦截 —— 盐的
 *      本意就是同图脱检查点，指纹只看结构。
 */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { Dag, NodeMode, makeNodeSpec } from "../src/kernel/dag.js";
import { EventKind } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { Recorder } from "../src/kernel/recorder.js";
import { Scheduler, topologyFingerprint } from "../src/kernel/scheduler.js";
import type { AgentLoopLike, BusLike } from "../src/kernel/scheduler.js";

const okLoop: AgentLoopLike = {
  run: (node) => Promise.resolve({ output: { node: node.id }, halted: false }) as never,
};
const quietBus: BusLike = { broadcast: () => undefined };

function tinyDag(opts: { extra?: boolean; salt?: string; name?: string } = {}): Dag {
  // 盐走节点 params.checkpoint_version —— 与 §7.5 掺盐 fork 同一条通道。
  const params = opts.salt === undefined ? {} : { checkpoint_version: opts.salt };
  const node = (id: string, deps: string[] = []) =>
    makeNodeSpec({ id, mode: NodeMode.SINGLE_SHOT, handler: "h", deps, params });
  const dag = new Dag(opts.name ?? "t");
  dag.add(node("A"));
  dag.add(node("B", ["A"]));
  if (opts.extra === true) dag.add(node("C", ["B"]));
  dag.freeze();
  return dag;
}

function rig(dag: Dag, journal: InMemoryJournal): Scheduler {
  const rec = new Recorder("run-fp", journal, new InMemoryBlobStore());
  return new Scheduler(dag, okLoop, rec, quietBus, new Budget());
}

describe("拓扑指纹（P0）", () => {
  it("指纹只看结构：同形状同指纹，动边/动点就变，checkpointVersion 不参与", () => {
    const base = topologyFingerprint(tinyDag());
    expect(topologyFingerprint(tinyDag())).toBe(base);
    expect(topologyFingerprint(tinyDag({ extra: true }))).not.toBe(base);
    expect(topologyFingerprint(tinyDag({ salt: "s1" })), "盐不该变指纹").toBe(base);
  });

  it("RUN_STARTED 带 topology_fp 与 node_count", async () => {
    const journal = new InMemoryJournal();
    await rig(tinyDag(), journal).run("run-fp");
    const started = [...journal.read("run-fp")].filter((e) => e.kind === EventKind.RUN_STARTED);
    expect(started).toHaveLength(1);
    expect(started[0]!.payload["dag"]).toBe("t");
    expect(started[0]!.payload["topology_fp"]).toBe(topologyFingerprint(tinyDag()));
    expect(started[0]!.payload["node_count"]).toBe(2);
  });

  it("同 journal 恢复：同形状放行，换形状 fail closed", async () => {
    const journal = new InMemoryJournal();
    await rig(tinyDag(), journal).run("run-fp");
    // 同形状恢复 —— 正常放行（检查点全中，零重跑）。
    await expect(rig(tinyDag(), journal).run("run-fp")).resolves.toBeDefined();
    // 换形状恢复 —— 拒跑，错误里说清两边指纹与出路。
    await expect(rig(tinyDag({ extra: true }), journal).run("run-fp")).rejects.toThrow(
      /拓扑指纹不一致/,
    );
  });

  it("掺盐 fork 不触发拦截（同图脱检查点是盐的本职）", async () => {
    const journal = new InMemoryJournal();
    await rig(tinyDag(), journal).run("run-fp");
    await expect(rig(tinyDag({ salt: "fork-1" }), journal).run("run-fp")).resolves.toBeDefined();
  });

  it("同 journal 里不同名 DAG 互不干扰（嵌套子图共用 Recorder 的现实）", async () => {
    const journal = new InMemoryJournal();
    await rig(tinyDag(), journal).run("run-fp");
    // 子图名字不同，形状也不同 —— 不该拿外层的指纹来拦它。
    await expect(
      rig(tinyDag({ extra: true, name: "sub" }), journal).run("run-fp"),
    ).resolves.toBeDefined();
  });

  it("老 journal 的 RUN_STARTED 没有指纹 → 不校验（向后兼容）", async () => {
    const journal = new InMemoryJournal();
    const rec = new Recorder("run-fp", journal, new InMemoryBlobStore());
    rec.emit(EventKind.RUN_STARTED, { payload: { dag: "t" } });
    await expect(rig(tinyDag({ extra: true }), journal).run("run-fp")).resolves.toBeDefined();
  });
});

describe("嵌套墙钟不重记（P0）", () => {
  it("accountsWallclock=false 的调度器一分钱墙钟都不记；默认档照记", async () => {
    const slowLoop: AgentLoopLike = {
      run: async (node) => {
        await new Promise((r) => setTimeout(r, 30));
        return { output: { node: node.id }, halted: false } as never;
      },
    };
    const mk = (accounts: boolean) => {
      const budget = new Budget();
      const rec = new Recorder(`run-wc-${accounts}`, new InMemoryJournal(), new InMemoryBlobStore());
      const sched = new Scheduler(tinyDag(), slowLoop, rec, quietBus, budget,
        accounts ? {} : { accountsWallclock: false });
      return { budget, sched, run: () => sched.run(`run-wc-${accounts}`) };
    };
    const outer = mk(true);
    await outer.run();
    expect(outer.budget.spent("wallclock_s")).toBeGreaterThan(0);
    const nested = mk(false);
    await nested.run();
    expect(nested.budget.spent("wallclock_s")).toBe(0);
  });
});

describe("abortNode 契约（审查修复）", () => {
  it("run 定案后 inflight 复位：对已结束的 run 停节点必须返回 false", async () => {
    const journal = new InMemoryJournal();
    const rec = new Recorder("run-abort-after", journal, new InMemoryBlobStore());
    const sched = new Scheduler(tinyDag(), okLoop, rec, quietBus, new Budget());
    await sched.run("run-abort-after");
    expect(sched.abortNode("A"), "跑完的 run 里没有在飞节点").toBe(false);
  });
});
