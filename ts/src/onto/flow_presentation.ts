/**
 * 「汇报版」展示副本 —— 图像模型画的那张图。
 *
 * 它和核心产物的关系只有一条：**单向**。它读 FlowGraph 的结构去画，画完不回写。
 *
 * ── 为什么要把这条写成契约，而不是靠自觉 ──────────────────────
 * 一张 PNG 点不开出处、改不了、走查走不了、和别的版本比不了。它一旦被当成
 * "流程图"参与校验或交付门禁，前面所有关于证据、可编辑、可追溯的保证就都白做了。
 * 所以：自带标记 + 被门禁明确排除 + 在说明里写清它不能用来干什么。
 *
 * ── 一个必须说破的局限 ─────────────────────────────────────
 * 图像模型画中文标签常出错字、糊字。核心产物永远是 `流程图.svg`（矢量、可点、
 * 文字是真文字）。这张只是好看，不是准。瞒着这一点交出去，就是拿好看换可信。
 */

import type { FlowGraph } from "./flow.js";
import { NodeKind } from "./flow.js";

/** 产物类型标记。门禁与校验按它排除。 */
export const DISPLAY_ONLY = "display_only";

export function isDisplayOnly(meta: Record<string, unknown>): boolean {
  return meta["kind"] === DISPLAY_ONLY;
}

export interface PresentationBrief {
  readonly kind: string;
  readonly notice: string;
}

/** 跟着展示副本一起交出去的说明。 */
export function presentationBrief(): PresentationBrief {
  return {
    kind: DISPLAY_ONLY,
    notice:
      "由图像模型渲染，仅供汇报展示。**不可编辑**、点不开出处（无溯源）、"
      + "不参与任何校验与交付门禁。中文标签可能出现错字或糊字 —— "
      + "以 流程图.svg 为准，那一版的文字是真文字、每个环节能点回材料原文。",
  };
}

/**
 * 喂给图像模型的输入：**结构的文字描述**，不是"画一张采购流程图"。
 *
 * 让它照着已经确定的结构画，而不是自由发挥 —— 自由发挥出来的东西和材料没关系，
 * 那就退回成了"看起来像流程图的装饰画"。
 */
export function presentationPromptOf(g: FlowGraph): string {
  const nodes = [...g.nodes.values()];
  if (nodes.length === 0) return "";

  const lines: string[] = [
    "按下面这个结构画一张业务流程图，不要增删环节：",
    "不要套固定 classic 模板。请根据阶段数量、分支密度和标签长度自行选择横向或纵向布局，" +
      "并生成与业务语义匹配、对比清晰的配色；保持专业、克制、适合业务汇报。",
    "所有中文节点名、条件和执行者必须逐字保留；不要把装饰性文字当作业务节点。",
    "",
  ];

  const stages = [...g.stages.values()].sort((left, right) => left.order - right.order);
  if (stages.length > 0) {
    lines.push("阶段/泳道：");
    for (const stage of stages) {
      lines.push(`- ${stage.title}${stage.subtitle ? `（${stage.subtitle}）` : ""}`);
    }
    lines.push("");
  }

  for (const n of nodes) {
    const actor = n.actor.value.trim();
    const shape = SHAPE_WORD[n.kind];
    const stage = g.stages.get(n.stage)?.title || n.stage;
    lines.push(
      `- ${n.label.value}（${shape}${stage ? `，阶段：${stage}` : ""}` +
        `${actor ? `，执行者：${actor}` : ""}）`,
    );
  }

  const edges = [...g.edges.values()];
  if (edges.length > 0) {
    lines.push("", "连线：");
    for (const e of edges) {
      const from = g.nodes.get(e.source)?.label.value ?? e.source;
      const to = g.nodes.get(e.target)?.label.value ?? e.target;
      lines.push(`- ${from} → ${to}${e.label ? `（条件：${e.label}）` : ""}`);
    }
  }

  return lines.join("\n");
}

const SHAPE_WORD: Readonly<Record<NodeKind, string>> = {
  [NodeKind.ACTION]: "矩形，一步动作",
  [NodeKind.EVENT]: "圆角框，做完之后别人能看到的事实",
  [NodeKind.GATEWAY]: "菱形，分支判断",
  [NodeKind.TERMINAL]: "椭圆，起止",
  [NodeKind.EXTERNAL]: "虚线框，外部系统",
};
