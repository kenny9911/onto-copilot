/**
 * §7.5 节点级 fork 重跑的地基：checkpointSalt 把整个 engagement 段的
 * checkpoint_version 掺盐 —— 旧检查点全部失配（重新执行），保留的专业节点由
 * replayOutputs 零模型重放，被 fork 的走活模型；EXTRACT 段版本不动、照旧免费复用。
 * 默认（不加盐）路径必须与既有字节完全一致 —— converse 的 golden 钉着拓扑。
 */
import { describe, expect, it } from "vitest";

import { FDE_CHECKPOINT_VERSION, buildFdeEngagementDag } from "../src/onto/engagement.js";
import {
  FDE_REPLAYABLE_AGENT_NODES,
  fdeForkReplayableNodes,
} from "../src/server/glue/engagement_handoff.js";

describe("buildFdeEngagementDag checkpointSalt", () => {
  it("默认不加盐：每个节点仍是原版本串", () => {
    const dag = buildFdeEngagementDag();
    for (const spec of dag.nodes.values()) {
      expect(spec.params["checkpoint_version"]).toBe(FDE_CHECKPOINT_VERSION);
    }
  });

  it("加盐：每个节点统一带上 fork 后缀，拓扑不变", () => {
    const base = buildFdeEngagementDag();
    const forked = buildFdeEngagementDag(null, { checkpointSalt: "process.ab12cd" });
    expect([...forked.nodes.keys()]).toEqual([...base.nodes.keys()]);
    for (const spec of forked.nodes.values()) {
      expect(spec.params["checkpoint_version"]).toBe(`${FDE_CHECKPOINT_VERSION}+fork.process.ab12cd`);
    }
    for (const [nid, spec] of forked.nodes) {
      expect(spec.deps).toEqual(base.nodes.get(nid)!.deps);
    }
  });

  it("PROCESS/ERP_MAP fork 不复用任何 downstream Agent 的旧结论", () => {
    const stored = Object.fromEntries(
      FDE_REPLAYABLE_AGENT_NODES.map((node) => [node, { node, revision: "old" }]),
    );
    expect(fdeForkReplayableNodes("PROCESS", stored)).toEqual(["INTAKE"]);
    expect(fdeForkReplayableNodes("ERP_MAP", stored)).toEqual([
      "INTAKE",
      "PROCESS",
      "RULES",
      "DATA_OBJECTS",
    ]);
    for (const downstream of [
      "DECISION_PROPOSAL",
      "REQUIREMENTS",
      "ARCHITECTURE",
      "TEST_PLAN",
      "REVIEW",
    ]) {
      expect(fdeForkReplayableNodes("ERP_MAP", stored)).not.toContain(downstream);
    }
  });
});
