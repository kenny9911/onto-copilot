/**
 * flow_extract / flow_edit 的 golden 校验。
 *
 * 期望值全部来自 `golden/flow_extract.json`（`tools/golden/flow_extract.py` 导出，
 * 字节确定）—— 这个模块几乎全是正则和"边该不该连"的判断，手写期望值就是把我对
 * Python 行为的猜测钉成断言。语料里两段流程说明是真材料
 * （`实体梳理.xlsx!业务规则`）的原文片段，含它自带的错别字「执行着」。
 *
 * 少数几条是 TS 侧独有的风险（`\d` 只认 ASCII、`m` 标志把 `\r` 当换行、
 * `len()` 数 UTF-16），Python 侧无从表达，单独标注。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FlowGraph, makeStage } from "../src/onto/flow.js";
import { FlowEditError, applyFlowEdit } from "../src/onto/flow_edit.js";
import {
  MAIN_STAGE,
  applySceneTitles,
  attachGateways,
  buildFlow,
  gapsToQuestions,
  gatewayToDict,
  looksLikeProcess,
  mayHaveCondition,
  parseGateways,
  parseSteps,
  processStepToDict,
  sceneHeaders,
  stagesByDomain,
  stagesFromGroups,
  stagesFromSurvey,
  surveyStageGroups,
  type Gateway,
  type ProcessStep,
} from "../src/onto/flow_extract.js";
import { questionToDict } from "../src/onto/oir.js";

type Dict = Record<string, unknown>;

const G = JSON.parse(
  readFileSync(join(__dirname, "../../golden/flow_extract.json"), "utf8"),
) as Dict;

const TEXTS = G["texts"] as Record<string, string>;
const rows = (k: string): Dict[] => G[k] as Dict[];

/** golden 里的阶段来源描述 → (图, 节点号→阶段) */
function stageSource(
  kind: unknown,
  param: unknown,
  steps: readonly ProcessStep[],
): [FlowGraph | null, Map<number, string>] {
  if (kind === "none") return [null, new Map()];
  if (kind === "domain") return stagesByDomain(steps);
  const pairs = (param as Array<[string, number[]]>).map(
    ([t, n]) => [t, n] as readonly [string, readonly number[]],
  );
  if (kind === "groups") return stagesFromGroups(pairs);
  if (kind === "survey") return stagesFromSurvey(pairs);
  throw new Error(`未知的阶段来源 ${String(kind)}`);
}

function stagesOf(g: FlowGraph): Dict[] {
  return [...g.stages.values()].map((st) => ({
    key: st.key,
    title: st.title,
    subtitle: st.subtitle,
    order: st.order,
  }));
}

function mappingOf(m: ReadonlyMap<number, string>): Array<[number, string]> {
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

// ══════════════════════════════════════════════════════════════════
//  拆解
// ══════════════════════════════════════════════════════════════════
describe("golden 本身", () => {
  it("每一段都真的有用例（空数组循环零次，会把整份测试变成一句空话）", () => {
    const want: Record<string, number> = {
      looks_like_process: 20,
      parse_steps: 19,
      build_flow: 14,
      scene_headers: 11,
      survey_stage_groups: 8,
      stages_by_domain: 6,
      apply_scene_titles: 8,
      stages_from_groups: 3,
      parse_gateways: 23,
      attach_gateways: 3,
      gaps_to_questions: 5,
    };
    for (const [k, n] of Object.entries(want)) expect(rows(k).length, k).toBe(n);
    expect(((G["flow_edit"] as Dict)["cases"] as Dict[]).length).toBe(35);
  });
});

describe("looksLikeProcess", () => {
  it("判据是结构不是关键词", () => {
    for (const row of rows("looks_like_process")) {
      const text = "text_key" in row ? TEXTS[row["text_key"] as string] : row["text"];
      expect(looksLikeProcess(text), JSON.stringify(row)).toBe(row["out"]);
    }
  });
});

describe("parseSteps", () => {
  it("一行不丢，四个字段各归各位", () => {
    for (const row of rows("parse_steps")) {
      const got = parseSteps(TEXTS[row["text_key"] as string], {
        cite: row["cite"] as string,
        fileName: row["file_name"] as string,
      });
      expect(got.map(processStepToDict), row["text_key"] as string).toEqual(row["steps"]);
    }
  });

  it("全角编号照样是节点头（JS 的 \\d 只有 ASCII）", () => {
    // Python 的 `\d` 匹配整个 Unicode Nd 类。这条在 Python 侧无从表达 ——
    // 那边根本不会写错。
    const steps = parseSteps(TEXTS["fullwidth"]!);
    expect(steps.map((s) => s.no)).toEqual([1, 2]);
  });

  it("孤零零一个 \\r 不算换行（JS 的 m 标志算）", () => {
    // 照 JS 的 `m` 写会在这里凭空多认出一个节点头，把一段文字从中间劈开。
    expect(parseSteps(TEXTS["cr_only"]!)).toEqual([]);
    expect(TEXTS["cr_only"]!).toContain("\r");
  });
});

// ══════════════════════════════════════════════════════════════════
//  建图
// ══════════════════════════════════════════════════════════════════
describe("buildFlow", () => {
  it("节点/边/泳道逐字段对上 golden", () => {
    for (const row of rows("build_flow")) {
      const steps = parseSteps(TEXTS[row["text_key"] as string], { cite: "业务规则!A14" });
      const [g0, mapping] = stageSource(row["stage_kind"], row["stage_param"], steps);
      expect(mappingOf(mapping), row["label"] as string).toEqual(row["mapping"]);
      const g = buildFlow(steps, {
        stages: mapping.size > 0 ? mapping : null,
        fileName: row["file_name"] as string,
        graph: g0,
      });
      expect(g.toDict(), row["label"] as string).toEqual(row["graph"]);
    }
  });

  it("没分到阶段的节点落在**注册过的**兜底泳道里", () => {
    // 真实事故：50 个节点里有 49 个落在一条没注册的泳道，画出来标题是内部 key。
    const g = buildFlow(parseSteps(TEXTS["real"]!, { cite: "业务规则!A14" }), {
      fileName: "x.xlsx",
    });
    expect(g.nodes.size).toBeGreaterThan(0);
    for (const n of g.nodes.values()) expect(g.stages.has(n.stage)).toBe(true);
    expect(g.stages.has(MAIN_STAGE)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  阶段
// ══════════════════════════════════════════════════════════════════
describe("阶段划分", () => {
  it("sceneHeaders：编号和名字分在两个单元格也要拼起来", () => {
    for (const row of rows("scene_headers")) {
      expect(sceneHeaders(row["cells"] as string[]), JSON.stringify(row["cells"])).toEqual(
        row["out"],
      );
    }
  });

  it("sceneHeaders：40 字上限数 code point，不数 UTF-16", () => {
    // 生僻姓氏地名住在 U+20000 区。按 `.length` 数会让 21 个字变成 42，
    // 于是客户自己写的场景名被当成正文丢掉。
    const cells = ["业务场景1", "𠀀".repeat(21)];
    expect("𠀀".repeat(21).length).toBe(42); // UTF-16 长度确实翻倍
    expect(sceneHeaders(cells)).toEqual([`业务场景1｜${"𠀀".repeat(21)}`]);
  });

  it("surveyStageGroups + stagesFromSurvey", () => {
    for (const row of rows("survey_stage_groups")) {
      const sheets = row["sheets"] as Record<string, string[]>;
      const groups = surveyStageGroups(sheets);
      expect(groups.map(([t, n]) => [t, n]), JSON.stringify(sheets)).toEqual(row["groups"]);
      const [g, mapping] = stagesFromSurvey(groups);
      expect(stagesOf(g)).toEqual(row["stages"]);
      expect(mappingOf(mapping)).toEqual(row["mapping"]);
    }
  });

  it("stagesByDomain：按业务域切，不按固定条数切", () => {
    for (const row of rows("stages_by_domain")) {
      const steps = parseSteps(TEXTS[row["text_key"] as string], { cite: "业务规则!A14" });
      const [g, mapping] = stagesByDomain(steps);
      expect(stagesOf(g), row["text_key"] as string).toEqual(row["stages"]);
      expect(mappingOf(mapping)).toEqual(row["mapping"]);
    }
  });

  it("applySceneTitles：对不上就不改，场景名进副标题", () => {
    for (const row of rows("apply_scene_titles")) {
      const steps = parseSteps(TEXTS[row["text_key"] as string], { cite: "业务规则!A14" });
      const groups = row["groups"] as Array<[string, number[]]> | null;
      const [g] =
        groups === null
          ? stagesByDomain(steps)
          : stagesFromGroups(groups.map(([t, n]) => [t, n] as readonly [string, readonly number[]]));
      const changed = applySceneTitles(g, row["scenes"] as string[]);
      expect(changed, JSON.stringify(row["scenes"])).toBe(row["changed"]);
      expect(stagesOf(g)).toEqual(row["stages"]);
    }
  });

  it("stagesFromGroups", () => {
    for (const row of rows("stages_from_groups")) {
      const pairs = (row["groups"] as Array<[string, number[]]>).map(
        ([t, n]) => [t, n] as readonly [string, readonly number[]],
      );
      const [g, mapping] = stagesFromGroups(pairs);
      expect(stagesOf(g)).toEqual(row["stages"]);
      expect(mappingOf(mapping)).toEqual(row["mapping"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  网关
// ══════════════════════════════════════════════════════════════════
/**
 * 预筛与正则不许脱节。
 *
 * `glue/flow.ts` 在把文本喂给 `parseGateways` 之前有一道便宜的预筛。它原本写死成
 * `includes("如") && (includes("则") || includes("否则"))` —— 而 `COND_RE` 本身认
 * 「若 / 倘若 / 当 / 一旦」和「即 / 就 / 需 / 应 / 自动 / 会 / 方可 / 才能」。
 * 于是「若金额超过5万，需总经理审批」这类规则**整段**进不了网关抽取，
 * 症状是"这份材料里一个分支都没识别出来"，而不是报错。
 *
 * 所以预筛必须与 `COND_RE` 共用一份词形定义，并由下面这条守卫钉住：
 * **凡是 COND_RE 能匹配的句子，预筛都必须放行。**
 */
describe("条件预筛", () => {
  const SENTENCES = [
    "如果金额超过5万，则需要总经理审批",
    "如金额超过5万，则需要总经理审批",
    "若金额超过5万，需总经理审批",
    "倘若供应商未通过资质审核，应当退回申请",
    "当库存低于安全线，就触发补货流程",
    "一旦合同到期，自动转入续签流程",
    "若验收不合格，方可拒收",
    "如遇紧急采购，才能走特批通道",
  ];

  it("COND_RE 能匹配的句子，预筛一条都不许拦下", () => {
    for (const s of SENTENCES) {
      // 先证明这句话确实是 COND_RE 认的（否则这条守卫是空的）
      expect(parseGateways(s, { cite: "f!A1" }).length, `COND_RE 应认得：${s}`)
        .toBeGreaterThan(0);
      expect(mayHaveCondition(s), `预筛拦下了 COND_RE 认得的句子：${s}`).toBe(true);
    }
  });

  it("不含条件句的文本被挡掉 —— 预筛还得省钱", () => {
    expect(mayHaveCondition("采购申请由发起人填写并提交")).toBe(false);
    expect(mayHaveCondition("本节说明采购流程的适用范围")).toBe(false);
  });
});

describe("网关", () => {
  it("parseGateways：句式判据 + 半截条件宁可丢", () => {
    for (const row of rows("parse_gateways")) {
      const got = parseGateways(row["text"], { cite: row["cite"] as string });
      const want = row["gateways"] as Dict[];
      expect(got.length, row["text"] as string).toBe(want.length);
      got.forEach((gw, i) => {
        const w = want[i]!;
        expect(gw.condition, row["text"] as string).toBe(w["condition"]);
        expect(gw.branches).toEqual(w["branches"]);
        expect(gw.cite).toBe(w["cite"]);
        expect(gw.ruleText).toBe(w["rule_text"]);
        // to_dict 里**没有** rule_text —— 它只在建图时当 snippet 用
        expect(gatewayToDict(gw)).toEqual(w["to_dict"]);
      });
    }
  });

  it("attachGateways：挂不上具体节点的也要建出来", () => {
    for (const row of rows("attach_gateways")) {
      const label = row["label"] as string;
      let g: FlowGraph;
      if (label === "anchored") {
        const steps = parseSteps(TEXTS["real"]!, { cite: "业务规则!A14" });
        const [g1, mapping] = stagesByDomain(steps);
        buildFlow(steps, { stages: mapping, fileName: "x.xlsx", graph: g1 });
        g = g1;
      } else if (label === "empty_graph") {
        g = new FlowGraph();
      } else {
        g = new FlowGraph();
        g.stages.set("s", makeStage({ key: "s", title: "阶段", order: 1 }));
      }
      const specs = (row["specs"] as Array<[string, string, number | null]>).map(
        ([text, cite, no]) => {
          const got = parseGateways(text, { cite });
          expect(got.length, text).toBeGreaterThan(0);
          return [got[0]!, no] as readonly [Gateway, number | null];
        },
      );
      attachGateways(g, specs, { fileName: row["file_name"] as string });
      expect(g.toDict(), label).toEqual(row["graph"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  缺口 → 问题
// ══════════════════════════════════════════════════════════════════
describe("gapsToQuestions", () => {
  it("图上标黄的每一处都变成一个能问客户的问题", () => {
    for (const row of rows("gaps_to_questions")) {
      let g: FlowGraph;
      if (row["label"] === "gateway_only") {
        g = new FlowGraph();
        g.stages.set("s", makeStage({ key: "s", title: "阶段", order: 1 }));
        const gws = parseGateways("如超出XX金额，则采购包创建失败", { cite: "A27" });
        attachGateways(g, [[gws[0]!, null]], { fileName: "x.xlsx" });
      } else {
        const steps = parseSteps(TEXTS[row["text_key"] as string], { cite: "业务规则!A14" });
        const [g0, mapping] = stageSource(row["stage_kind"], row["stage_param"], steps);
        g = buildFlow(steps, {
          stages: mapping.size > 0 ? mapping : null,
          fileName: "x.xlsx",
          graph: g0,
        });
      }
      const qs = gapsToQuestions(g, { fileName: "x.xlsx" });
      expect(qs.map(questionToDict), row["label"] as string).toEqual(row["questions"]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  编辑
// ══════════════════════════════════════════════════════════════════
function editGraph(): FlowGraph {
  const steps = parseSteps(TEXTS["real"]!, { cite: "业务规则!A14" });
  const [g, mapping] = stagesFromGroups([
    ["阶段一", [1, 2]],
    ["阶段二", [3]],
  ]);
  return buildFlow(steps, { stages: mapping, fileName: "x.xlsx", graph: g });
}

describe("applyFlowEdit", () => {
  it("起始图与 golden 一致", () => {
    expect(editGraph().toDict()).toEqual((G["flow_edit"] as Dict)["base"]);
  });

  it("每一步的回执、被拒的消息、以及拒了之后图一个字节都没动", () => {
    for (const cse of (G["flow_edit"] as Dict)["cases"] as Dict[]) {
      const g = editGraph();
      const label = cse["label"] as string;
      for (const step of cse["steps"] as Dict[]) {
        const op = step["op"] as string;
        const args = step["args"] as Record<string, unknown>;
        const before = JSON.stringify(g.toDict());
        if (step["ok"] === true) {
          expect(applyFlowEdit(g, op, args), `${label}/${op}`).toBe(step["note"]);
        } else {
          let caught: unknown = null;
          try {
            applyFlowEdit(g, op, args);
          } catch (exc) {
            caught = exc;
          }
          expect(caught, `${label}/${op} 该被拒却通过了`).toBeInstanceOf(FlowEditError);
          expect((caught as Error).message, `${label}/${op}`).toBe(step["message"]);
          // 原子性：被拒的编辑一个字节都不许改
          expect(JSON.stringify(g.toDict()) === before, `${label}/${op}`).toBe(
            step["unchanged"],
          );
        }
        expect(g.toDict(), `${label}/${op}`).toEqual(step["after"]);
      }
    }
  });

  it("FlowEditError 是 ValueError 的子类（Python 侧就是）", () => {
    const g = editGraph();
    expect(() => applyFlowEdit(g, "explode_everything", {})).toThrow(FlowEditError);
    try {
      applyFlowEdit(g, "explode_everything", {});
    } catch (exc) {
      // 只有一份 ValueError（kernel/errors.ts）——两份同名类会让 instanceof 静默漏
      expect(exc).toBeInstanceOf(Error);
      expect((exc as Error).name).toBe("FlowEditError");
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  apply_patch：一次落一整块，整批成功才落地
// ══════════════════════════════════════════════════════════════════

describe("applyFlowEdit / apply_patch", () => {
  const 骨架 = {
    stages: [
      { key: "s1", title: "阶段一｜申请与审批" },
      { key: "s2", title: "阶段二｜付款" },
    ],
    nodes: [
      { key: "n1", kind: "action", label: "提交报销单", stage: "s1", actor: "员工" },
      { key: "n2", kind: "event", label: "报销单已提交", stage: "s1" },
      { key: "n3", kind: "gateway", label: "金额是否超阈值", stage: "s1" },
      { key: "n4", kind: "action", label: "财务出账", stage: "s2", actor: "财务" },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "n4", label: "未超阈值" },
    ],
  };

  it("一次调用建出一份连通的流程 —— 这是 5 步预算下唯一能做到的方式", () => {
    const g = new FlowGraph();
    const note = applyFlowEdit(g, "apply_patch", 骨架);

    expect(g.stages.size).toBe(2);
    expect(g.nodes.size).toBe(4);
    expect(g.edges.size).toBe(3);
    expect(g.dangling()).toEqual([]); // 没有孤立节点
    expect(note).toContain("4 个环节");
    expect(note).toContain("3 条连线");
  });

  it("**整批成功才落地** —— 一条边指向不存在的节点，原图一个字节都不动", () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", 骨架);
    const before = JSON.stringify(g.toDict());

    expect(() =>
      applyFlowEdit(g, "apply_patch", {
        nodes: [{ key: "x1", kind: "action", label: "新环节", stage: "s1" }],
        edges: [{ from: "x1", to: "根本不存在的节点" }],
      }),
    ).toThrow(/既不是这一批里的 key，也不是图上已有的节点/u);

    // 半张流程图比没有更糟：它看起来像是完整的
    expect(JSON.stringify(g.toDict())).toBe(before);
  });

  it("坏在哪一条要说清楚 —— 整批拒绝时这是模型唯一能据以改对的信息", () => {
    const g = new FlowGraph();
    expect(() =>
      applyFlowEdit(g, "apply_patch", {
        stages: [{ key: "s1", title: "阶段一" }],
        nodes: [
          { key: "n1", kind: "action", label: "好节点", stage: "s1" },
          { key: "n2", kind: "外星人", label: "坏节点", stage: "s1" },
        ],
      }),
    ).toThrow(/nodes\[1\]（坏节点）/u);
  });

  it("边能连到图上**已有**的节点 —— 给现有流程补一段，不是只能从零建", () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", 骨架);

    applyFlowEdit(g, "apply_patch", {
      nodes: [{ key: "n5", kind: "event", label: "款项已支付", stage: "s2" }],
      edges: [{ from: "财务出账", to: "n5" }], // 用已有节点的名字
    });

    const evt = [...g.nodes.values()].find((n) => n.label.value === "款项已支付")!;
    const act = [...g.nodes.values()].find((n) => n.label.value === "财务出账")!;
    expect([...g.edges.values()].some((e) => e.source === act.rid && e.target === evt.rid)).toBe(true);
  });

  it("什么都不给 → 一句人话，不是静默成功", () => {
    const g = new FlowGraph();
    expect(() => applyFlowEdit(g, "apply_patch", {})).toThrow(/至少要给/u);
  });

  it("通用假设档不留任何 evidence —— 否则会被算成有材料依据", () => {
    const g = new FlowGraph();
    applyFlowEdit(g, "apply_patch", 骨架, { source: "generic_assumption" });
    for (const n of g.nodes.values()) expect(n.label.evidence).toEqual([]);
    for (const e of g.edges.values()) expect(e.evidence).toEqual([]);
  });
});
