/** Versioned node checkpoints must not let an old projection masquerade as a new agent result. */
import { describe, expect, it } from "vitest";

import { Budget } from "../src/kernel/budget.js";
import { Dag, makeNodeSpec, NodeMode } from "../src/kernel/dag.js";
import { EventKind } from "../src/kernel/events.js";
import { InMemoryBlobStore, InMemoryJournal } from "../src/kernel/journal.js";
import { Recorder } from "../src/kernel/recorder.js";
import { RunStatus, Scheduler, type AgentLoopLike } from "../src/kernel/scheduler.js";

describe("Recorder / checkpoint_version", () => {
  it("同 nodeId 的 legacy、v2 checkpoint 相互隔离，同时保留事件里的真实 nodeId", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const first = new Recorder("versioned-run", journal, blobs);
    await first.completeNode("PROCESS", { source: "legacy-projection" });
    await first.completeNode(
      "RULES",
      { source: "model-analysis" },
      "fde-engagement-v2",
    );

    const resumed = new Recorder("versioned-run", journal, blobs, { resume: true });
    expect(resumed.nodeIsComplete("PROCESS")).toBe(true);
    expect(resumed.nodeIsComplete("PROCESS", "fde-engagement-v2")).toBe(false);
    expect(resumed.nodeIsComplete("RULES")).toBe(false);
    expect(resumed.nodeIsComplete("RULES", "fde-engagement-v2")).toBe(true);
    expect(await resumed.nodeOutput("RULES", "fde-engagement-v2")).toEqual({
      source: "model-analysis",
    });

    const event = [...journal.read("versioned-run")].find(
      (row) => row.kind === EventKind.NODE_COMPLETED && row.nodeId === "RULES",
    );
    expect(event?.payload["checkpoint_version"]).toBe("fde-engagement-v2");
  });

  it("同 nodeId 的 attempt/effect 按版本隔离，同版本仍可精确重放", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const first = new Recorder("versioned-effects", journal, blobs);

    expect(first.nextAttempt("PROCESS", "contract-v1")).toBe(0);
    first.emit(EventKind.NODE_ENTERED, {
      nodeId: "PROCESS",
      payload: { attempt: 0, checkpoint_version: "contract-v1" },
    });
    let oldCalls = 0;
    expect(
      await first.effect(
        "PROCESS",
        "llm.call",
        { prompt: "old contract" },
        () => {
          oldCalls += 1;
          return { source: "v1" };
        },
        { key: "final" },
      ),
    ).toEqual({ source: "v1" });
    expect(oldCalls).toBe(1);

    const resumed = new Recorder("versioned-effects", journal, blobs, { resume: true });
    expect(resumed.nextAttempt("PROCESS", "contract-v1")).toBe(1);
    let replayCalls = 0;
    expect(
      await resumed.effect(
        "PROCESS",
        "llm.call",
        { prompt: "old contract" },
        () => {
          replayCalls += 1;
          return { source: "should-not-run" };
        },
        { key: "final" },
      ),
    ).toEqual({ source: "v1" });
    expect(replayCalls).toBe(0);

    // A new semantic contract starts both attempt and effect namespaces from zero.
    // The changed request must execute instead of colliding with v1's `PROCESS#final`.
    expect(resumed.nextAttempt("PROCESS", "contract-v2")).toBe(0);
    resumed.emit(EventKind.NODE_ENTERED, {
      nodeId: "PROCESS",
      payload: { attempt: 0, checkpoint_version: "contract-v2" },
    });
    let newCalls = 0;
    expect(
      await resumed.effect(
        "PROCESS",
        "llm.call",
        { prompt: "new contract" },
        () => {
          newCalls += 1;
          return { source: "v2" };
        },
        { key: "final" },
      ),
    ).toEqual({ source: "v2" });
    expect(newCalls).toBe(1);

    const effects = [...journal.read("versioned-effects")].filter(
      (row) => row.kind === EventKind.EFFECT_COMPLETED,
    );
    expect(effects.map((row) => row.nodeId)).toEqual(["PROCESS", "PROCESS"]);
    expect(effects.map((row) => row.payload["key"])).toEqual([
      "PROCESS#final",
      "PROCESS#final",
    ]);
    expect(effects.map((row) => row.payload["checkpoint_version"])).toEqual([
      "contract-v1",
      "contract-v2",
    ]);
  });

  it("Scheduler 把 NodeSpec checkpoint_version 传给节点执行，不改 event.nodeId", async () => {
    const journal = new InMemoryJournal();
    const blobs = new InMemoryBlobStore();
    const recorder = new Recorder("scheduler-version", journal, blobs);
    const dag = new Dag("versioned").add(
      makeNodeSpec({
        id: "RULES",
        mode: NodeMode.SINGLE_SHOT,
        handler: "test.rules",
        retries: 0,
        params: { checkpoint_version: "rules-v3" },
      }),
    ).freeze();
    const seen: Array<string | null | undefined> = [];
    const loop: AgentLoopLike = {
      async run(node, opts) {
        seen.push(opts.checkpointVersion);
        const attempt = recorder.nextAttempt(node.id, opts.checkpointVersion);
        recorder.emit(EventKind.NODE_ENTERED, {
          nodeId: node.id,
          payload: {
            attempt,
            ...(opts.checkpointVersion === null || opts.checkpointVersion === undefined
              ? {}
              : { checkpoint_version: opts.checkpointVersion }),
          },
        });
        const output = await recorder.effect(
          node.id,
          "llm.call",
          { prompt: "rules-v3" },
          () => ({ source: "rules-v3" }),
          { key: "final" },
        );
        return { output };
      },
    };
    const outcome = await new Scheduler(
      dag,
      loop,
      recorder,
      { broadcast: () => 0 },
      new Budget(),
    ).run("scheduler-version");

    expect(outcome.status).toBe(RunStatus.COMPLETED);
    expect(seen).toEqual(["rules-v3"]);
    const versionedEvents = [...journal.read("scheduler-version")].filter(
      (row) =>
        row.kind === EventKind.NODE_ENTERED ||
        row.kind === EventKind.EFFECT_COMPLETED ||
        row.kind === EventKind.NODE_COMPLETED,
    );
    expect(versionedEvents.map((row) => row.nodeId)).toEqual(["RULES", "RULES", "RULES"]);
    expect(versionedEvents.map((row) => row.payload["checkpoint_version"])).toEqual([
      "rules-v3",
      "rules-v3",
      "rules-v3",
    ]);
  });
});
