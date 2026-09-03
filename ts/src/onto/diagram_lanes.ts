/**
 * 按**执行者**分泳道的流程图。
 *
 * `FlowNode.actor` 一路被收集、存储、要求模型填写、还被 critic 检查 ——
 * 而 `diagram.ts` 的两个 emitter 都不画它。泳道图的数据早就齐了，从没画过。
 *
 * ── 为什么是新文件而不是改 toSvg ────────────────────────────
 * `golden/onto.diagram.json` 里那 28 张 SVG 记录的是 **Python 真跑的输出**，
 * 而导出器 `tools/golden/*.py` 已经不在仓库里。从 TS 侧重生成，等于把一条
 * 跨语言一致性测试改写成"TS 自己证明自己"。所以现有 `toSvg` 逐字节不动，
 * 泳道走新函数、新产物（`流程图_泳道.svg`），两者并存。
 *
 * ── 一个真实的坑 ────────────────────────────────────────────
 * 真实库 `fdaced8ca9df` 的 actor 存成 `"采购计划员\n"`（带尾随换行）。
 * 不清洗就会把同一个角色劈成两条道 —— 而且看不出是数据问题，
 * 只会觉得"这张图怎么有两个采购计划员"。
 */

import type { FlowGraph, FlowNode } from "./flow.js";

const LANE_H = 92;
const NODE_W = 168;
const NODE_H = 46;
const PITCH_X = 208;
const PAD_L = 132;
const PAD_T = 48;

/** 没标执行者的节点归到这一道 —— 不丢，但要看得出是没标。 */
const UNKNOWN_LANE = "未指定";

/** 清洗 actor：真实数据带尾随换行、全角空格，不清洗会劈道。 */
function laneOf(n: FlowNode): string {
  const a = n.actor.value.replace(/\s+/gu, " ").trim();
  return a || UNKNOWN_LANE;
}

function esc(s: string): string {
  return s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export function toLaneSvg(g: FlowGraph, opts: { title?: string } = {}): string {
  const nodes = [...g.nodes.values()];

  // 按 actor 分道，保持插入序（材料顺序就是业务顺序，别按字母重排）
  const lanes = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    const key = laneOf(n);
    const bucket = lanes.get(key);
    if (bucket) bucket.push(n);
    else lanes.set(key, [n]);
  }

  const width = PAD_L + Math.max(1, ...[...lanes.values()].map((v) => v.length)) * PITCH_X + 40;
  const height = PAD_T + Math.max(1, lanes.size) * LANE_H + 48;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}" font-family="sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="24" y="28" font-size="14" font-weight="600" fill="#111827">`
    + `${esc(opts.title ?? "按执行者分泳道")}</text>`,
  ];

  // 全部节点都没标执行者时，出一张说得清自己的图，而不是一条假的"未指定"道
  const onlyUnknown = lanes.size === 1 && lanes.has(UNKNOWN_LANE);
  if (onlyUnknown) {
    out.push(
      `<text x="24" y="52" font-size="11.5" fill="#b45309">`
      + `材料里没有标注执行者，这张图分不出泳道 —— 先把执行者补齐再看这一版。</text>`,
    );
  }

  let row = 0;
  for (const [lane, members] of lanes) {
    const y = PAD_T + row * LANE_H;
    out.push(
      `<rect x="16" y="${y}" width="${width - 32}" height="${LANE_H - 10}" `
      + `fill="${row % 2 === 0 ? "#f9fafb" : "#ffffff"}" stroke="#e5e7eb"/>`,
      `<text class="lane-title" x="28" y="${y + 26}" font-size="12" font-weight="600" `
      + `fill="#374151">${esc(lane)}</text>`,
    );
    members.forEach((n, i) => {
      const x = PAD_L + i * PITCH_X;
      const ny = y + (LANE_H - 10 - NODE_H) / 2;
      out.push(
        `<rect x="${x}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="6" `
        + `fill="#eff6ff" stroke="#93c5fd"/>`,
        `<text x="${x + NODE_W / 2}" y="${ny + NODE_H / 2 + 4}" font-size="11" `
        + `fill="#1f2937" text-anchor="middle">${esc(cut(n.label.value, 12))}</text>`,
      );
    });
    row += 1;
  }

  out.push("</svg>");
  return out.join("\n");
}

function cut(s: string, n: number): string {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n - 1).join("") + "…";
}
