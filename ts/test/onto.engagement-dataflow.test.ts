/**
 * 冻结拓扑里**哪些依赖边真的在传数据**。
 *
 * v3 把专业分析、决定校验、需求、架构、验收与人工签字节点接入冻结 DAG，并把
 * GAP、CANONICALIZE、REVIEW、HUMAN_ACCEPTANCE、EXPORT 的
 * 直接依赖展开到它们真正消费的节点。这里继续钉住确定性 seed 的数据边，避免
 * 回退路径在升级中丢掉基础映射。
 *
 * 一条声明了却不传数据的边是**拓扑在撒谎**：它让读代码的人以为 RULES 是在
 * PROCESS 的结论之上做推理，实际两者互不相干。这个谎正是"看起来像 8 段认知
 * 流水线"这个印象的来源。
 *
 * 这组测试**不主张删边** —— 边可能在记录设计意图（handler 将来换成模型驱动时
 * 该读上游），那是产品决策。它做的是把现状钉死：**今天哪些边承重、哪些不承重，
 * 一清二楚，而且不许在没人注意时改变**。
 *
 * 两个方向都守：
 *   · 承重的边变成不承重 → 有人把推理改成了投影，能力退化，必须红；
 *   · 不承重的边变成承重 → 好事，但拓扑的含义变了，也必须有人看见。
 */

import { describe, expect, it } from "vitest";

import { buildFdeEngagementDag } from "../src/onto/engagement.js";
import {
  DataObjectsHandler,
  ERPMapHandler,
  EngagementRuntimeInput,
  IntakeHandler,
  ProcessHandler,
  ReviewHandler,
} from "../src/onto/engagement_runtime.js";
import { OIR } from "../src/onto/oir.js";

function runtime(): EngagementRuntimeInput {
  return new EngagementRuntimeInput({
    sessionId: "s1",
    project: "测试项目",
    oir: new OIR(),
    flow: null,
    decisions: [],
    corpus: {},
    artifactRevision: 0,
    generatedAt: "2026-08-17T00:00:00+08:00",
    releaseDownloadable: true,
  });
}

/**
 * 这个 handler 的产出会不会因为上游输入而变。
 *
 * 用**行为**判定而不是读 `_inputs` 这个命名约定：下划线只是作者的自述，
 * 改个名字就骗过去了；喂两组差得很远的输入看产出变不变，骗不过去。
 */
function readsInputs(project: (i: Record<string, unknown>) => unknown, upstream: string): boolean {
  const empty = JSON.stringify(project({}));
  const filled = JSON.stringify(
    project({
      [upstream]: {
        contract: "SomethingRich",
        steps: [{ id: "s1", name: "一个上游产出的步骤" }],
        stages: [{ id: "st1", name: "阶段" }],
        systems: [{ name: "某系统", endpoint: "https://erp.example.com/api" }],
        nodes: [{ id: "n1", name: "节点" }],
      },
    }),
  );
  return empty !== filled;
}

describe("承重的边：改成不读上游必须红", () => {
  it("ERP_MAP 真的读 PROCESS —— 它是这批投影里唯一在做上下游拼接的", () => {
    // 它读的是 `PROCESS.steps[].system_ids[]`（engagement_runtime.ts:417-421），
    // 形状不对就什么都拼不出来。这里给真实形状。
    const h = new ERPMapHandler(runtime());
    const empty = h.project({});
    const filled = h.project({
      PROCESS: {
        steps: [{ id: "step.1", system_ids: ["https://erp.example.com/api/po"], evidence_ids: [] }],
      },
    });
    expect((empty as Record<string, unknown[]>)["mappings"]).toHaveLength(0);
    expect((filled as Record<string, unknown[]>)["mappings"]).toHaveLength(1);
  });

  it("ERP_MAP seed 不再把 endpoint 主机名冒充 ERP 产品", () => {
    // system_id 保留原始系统线索，product 只有模型拿到真实证据后才能填写。
    const h = new ERPMapHandler(runtime());
    const out = h.project({
      PROCESS: { steps: [{ id: "s", system_ids: ["https://erp.example.com/api/po"], evidence_ids: [] }] },
    }) as Record<string, Record<string, unknown>[]>;
    expect(out["landscape"]![0]!["product"]).toBeNull();
    expect(out["landscape"]![0]!["system_id"]).toBe("sys.erp.example.com");
  });

  it("REVIEW 真的读上游 —— 它要审的就是 CANONICALIZE 交出来的包", () => {
    const h = new ReviewHandler(runtime());
    expect(readsInputs((i) => h.project(i), "CANONICALIZE")).toBe(true);
  });
});

describe("不承重的边：现状钉死，变了要有人看见", () => {
  // 这三条边今天**声明了但不传数据**。它们不是 bug（确定性投影都从 runtime 读），
  // 但拓扑因此在暗示一个不存在的推理链条。
  const cases: [string, string, () => (i: Record<string, unknown>) => unknown][] = [
    ["INTAKE", "（无上游，但同样忽略输入）", () => {
      const h = new IntakeHandler(runtime());
      return (i) => h.project(i);
    }],
    ["PROCESS ← INTAKE", "INTAKE", () => {
      const h = new ProcessHandler(runtime());
      return (i) => h.project(i);
    }],
    ["DATA_OBJECTS ← PROCESS", "PROCESS", () => {
      const h = new DataObjectsHandler(runtime());
      return (i) => h.project(i);
    }],
  ];

  for (const [label, upstream, make] of cases) {
    it(`${label}：产出不随上游变 —— 今天是纯调度边`, () => {
      expect(readsInputs(make(), upstream)).toBe(false);
    });
  }
});

describe("v3 拓扑把专业数据流与人工验收显式化", () => {
  it("80 条声明边覆盖专业分析、决定校验、交付链、审查、人工验收和导出输入", () => {
    const dag = buildFdeEngagementDag();
    const declared = [...dag.nodes.keys()].reduce(
      (n, id) => n + dag.get(id).deps.length,
      0,
    );
    // 声明边数是拓扑的一等事实。它变了（加节点、改依赖）就该有人重新看一遍
    // 上面那两组：新加的边是承重的，还是又一条只在暗示推理的空边。
    expect(declared).toBe(80);
  });

  it("正式验收绑定完整候选，EXPORT 不能绕过 HUMAN_ACCEPTANCE", () => {
    const dag = buildFdeEngagementDag();
    expect(dag.get("HUMAN_ACCEPTANCE").deps).toEqual([
      "REVIEW",
      "CANONICALIZE",
      "TEST_PLAN",
      "ARCHITECTURE",
      "REQUIREMENTS",
      "DECISION_APPLY",
      "DECISION_PROPOSAL",
    ]);
    expect(dag.get("EXPORT").deps[0]).toBe("HUMAN_ACCEPTANCE");
    expect(dag.get("EXPORT").gate?.require).toContain("human_decided == true");
  });

  it("GAP 同时归并 Intake 与四个专业节点，一个都不能少", () => {
    expect([...buildFdeEngagementDag().get("GAP").deps].sort()).toEqual(
      ["INTAKE", "DATA_OBJECTS", "ERP_MAP", "PROCESS", "RULES"].sort(),
    );
  });
});
