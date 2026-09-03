/**
 * 流程图生成的策略路由 —— 「让 AI 自己决定用哪种方法」。
 *
 * 一次完整的决策是三步，这个模块负责**首尾两步**（都是零模型、可确定性判定的）：
 *
 *   ① `scanFlowSignals`  零模型扫材料，得到一份信号摘要
 *   ② （模型）           只看摘要选策略 —— 不看材料全文，所以便宜
 *   ③ `validateChoice`   硬校验模型的选择
 *
 * ── 为什么 ③ 不可省 ──────────────────────────────────────────
 * 模型会点一条根本跑不了的路（材料里一个 BPMN 都没有却选 S1）。没有硬校验的话，
 * 管线要一路跑到出空图才发现，而那时已经花过钱、也已经告诉用户"正在按 BPMN 解析"。
 * 所以：**信号为零的策略不许被选中**，策略名也只能从固定集合里取。
 *
 * 决策本身要**带出处地记进产物**（选了什么、为什么、跳过了什么），让用户能回答
 * "这张图是怎么来的" —— 一个说不清自己来历的产物，和硬编码出来的没有区别。
 */

import type { ParsedDoc } from "./parse/base.js";

/**
 * 固定策略集。模型只能从这里选 —— 开放式的策略名等于让模型自己发明管线。
 *
 * S1 BPMN 直读 / S2 PPT 连接线 / S3 图片流程图识读 / S4 LLM 文本建模
 * S5 表格顺序推断 / S6 接口清单反推 / S7 通用参考图
 */
export const STRATEGIES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** 零模型扫出来的材料能力摘要。全是计数，不含材料内容。 */
export interface FlowSignals {
  readonly bpmnFiles: number;
  /** PPT/Visio 里两端都接好的连接线总数。 */
  readonly pptConnectors: number;
  /** 图片/扫描件里识别出的连线总数。 */
  readonly visionRelations: number;
  /** 含编号步骤的文本切片数。 */
  readonly numberedStepChunks: number;
  readonly apiEndpoints: number;
  readonly materialCount: number;
}

/** 每条策略需要哪个信号非零才算"跑得动"。S7 不需要材料 —— 它就是没材料时用的。 */
const NEEDS: Readonly<Record<Strategy, (s: FlowSignals) => boolean>> = {
  S1: (s) => s.bpmnFiles > 0,
  S2: (s) => s.pptConnectors > 0,
  S3: (s) => s.visionRelations > 0,
  S4: (s) => s.numberedStepChunks > 0,
  S5: (s) => s.materialCount > 0,
  S6: (s) => s.apiEndpoints > 0,
  S7: () => true,
};

/** 编号步骤的结构特征：`（1）` `(1)` `1.` `1、` 开头。只看形状，不看内容。 */
const NUMBERED = /(?:^|\n)\s*(?:[（(]\s*\d+\s*[）)]|\d+\s*[.、])/u;

export function scanFlowSignals(
  docs: readonly ParsedDoc[],
  state: Record<string, unknown>,
): FlowSignals {
  let bpmnFiles = 0;
  let pptConnectors = 0;
  let visionRelations = 0;
  let numberedStepChunks = 0;

  for (const d of docs) {
    if ((d.kind ?? "") === "bpmn") bpmnFiles += 1;

    const st = (d.structured ?? {}) as Record<string, unknown>;

    // PPT 连接线：pptx_flow 落在 structured.slide_flows（可选发射，没画就没有这个键）
    for (const page of asArray(st["slide_flows"])) {
      pptConnectors += asArray(asRecord(page)["edges"]).length;
    }

    // 视觉识别的连线：vision 落在 structured.relations
    visionRelations += asArray(st["relations"]).length;

    for (const c of d.chunks ?? []) {
      if (NUMBERED.test(String(c.render ?? ""))) numberedStepChunks += 1;
    }
  }

  return {
    bpmnFiles,
    pptConnectors,
    visionRelations,
    numberedStepChunks,
    apiEndpoints: asArray(state["_endpoints"]).length,
    materialCount: docs.length,
  };
}

export interface ChoiceVerdict {
  readonly ok: boolean;
  readonly accepted: Strategy[];
  readonly rejected: { strategy: string; why: string }[];
}

/**
 * 硬校验模型的选择。两条判据：
 * 1. 名字必须在固定集合里；
 * 2. 对应的信号必须非零。
 */
export function validateChoice(
  chosen: readonly string[],
  signals: FlowSignals,
): ChoiceVerdict {
  const accepted: Strategy[] = [];
  const rejected: { strategy: string; why: string }[] = [];

  for (const raw of chosen) {
    const name = raw.trim();
    if (!isStrategy(name)) {
      rejected.push({ strategy: name, why: `不是可选策略。只能从 ${STRATEGIES.join("/")} 里选。` });
      continue;
    }
    if (accepted.includes(name)) continue;
    if (!NEEDS[name](signals)) {
      rejected.push({ strategy: name, why: `材料里没有这条策略需要的信号（相关计数为零），跑不出东西。` });
      continue;
    }
    accepted.push(name);
  }

  return { ok: accepted.length > 0, accepted, rejected };
}

function isStrategy(s: string): s is Strategy {
  return (STRATEGIES as readonly string[]).includes(s);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
