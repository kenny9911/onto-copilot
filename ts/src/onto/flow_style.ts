/**
 * FlowGraph 的确定性视觉策略。
 *
 * 这里不保存一套“默认主题”。自动模式从图的业务语义、规模和拓扑中计算布局与
 * 配色：同一张图跨进程、跨机器得到同一结果；改了阶段或关键环节，主题与密度才会
 * 随之变化。显式 classic / slate / print / blueprint 仍由 diagram.ts 的兼容层处理。
 */

import type { FlowGraph } from "./flow.js";

export type DiagramDirection = "LR" | "TB";

export interface DiagramMetrics {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly stageCount: number;
  readonly edgeDensity: number;
  readonly branchCount: number;
  readonly branchRatio: number;
  readonly maxLabelLength: number;
  readonly averageLabelLength: number;
  readonly maxEdgeLabelLength: number;
  readonly maxStageLoad: number;
  readonly maxDepth: number;
  readonly maxParallel: number;
}

export interface DiagramLayout {
  readonly direction: DiagramDirection;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly bandPadding: number;
  readonly bandHeader: number;
  readonly bandGap: number;
  readonly margin: number;
  readonly titleHeight: number;
  readonly minCanvasWidth: number;
  readonly labelPerLine: number;
  readonly labelLines: number;
  /** 主轴上预计最多有多少列（LR）或多少行（TB）。 */
  readonly columns: number;
  readonly density: number;
  readonly rationale: readonly string[];
}

export interface FlowPalette {
  actionFill: string;
  actionLine: string;
  eventFill: string;
  eventLine: string;
  gatewayFill: string;
  gatewayLine: string;
  terminalFill: string;
  terminalLine: string;
  externalFill: string;
  externalLine: string;
  band: string;
  bandLine: string;
  ink: string;
  dim: string;
  edge: string;
  canvas?: string;
  /** auto 是一个可传递的标记；toSvg 会用真实图和标题重新求值。 */
  mode?: "auto" | "template" | "custom";
  themeId?: string;
  tone?: "light" | "dark";
  baseHue?: number;
}

export interface DiagramTheme {
  readonly id: string;
  readonly mode: "auto";
  readonly tone: "light" | "dark";
  readonly baseHue: number;
  readonly semanticHash: string;
  readonly stageAccents: readonly string[];
  readonly minimumTextContrast: number;
}

export interface ResolvedDiagramStyle {
  readonly palette: FlowPalette;
  readonly theme: DiagramTheme;
  readonly layout: DiagramLayout;
  readonly metrics: DiagramMetrics;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** FNV-1a 32-bit。不能用 Math.random / 进程 hash：那会让相同流程每次换颜色。 */
export function stableSemanticHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    hash ^= cp & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (cp >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (cp >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function semanticSignature(g: FlowGraph, title: string): string {
  const stages = [...g.stages.values()]
    .map((stage) => `${stage.order}:${stage.key}:${stage.title}:${stage.subtitle}`)
    .sort();
  const nodes = [...g.nodes.values()]
    .map((node) => `${node.rid}:${String(node.kind)}:${node.stage}:${node.label.value}:${node.actor.value}`)
    .sort();
  const edges = [...g.edges.values()]
    .map((edge) => `${edge.source}>${edge.target}:${String(edge.kind)}:${edge.label}`)
    .sort();
  return [title.trim(), ...stages, ...nodes, ...edges].join("\u241f");
}

function topologyShape(g: FlowGraph, ids: ReadonlySet<string>): { depth: number; parallel: number } {
  if (ids.size === 0) return { depth: 1, parallel: 1 };
  const indegree = new Map<string, number>();
  for (const rid of ids) {
    let count = 0;
    for (const edge of g.inEdges(rid)) if (ids.has(edge.source)) count += 1;
    indegree.set(rid, count);
  }
  const remaining = new Set(ids);
  let depth = 0;
  let parallel = 1;
  while (remaining.size > 0) {
    const ready = [...remaining].filter((rid) => (indegree.get(rid) ?? 0) <= 0);
    if (ready.length === 0) {
      depth += 1;
      parallel = Math.max(parallel, remaining.size);
      break;
    }
    depth += 1;
    parallel = Math.max(parallel, ready.length);
    for (const rid of ready) {
      remaining.delete(rid);
      for (const edge of g.outEdges(rid)) {
        if (remaining.has(edge.target)) {
          indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
        }
      }
    }
  }
  return { depth, parallel };
}

export function analyzeDiagramMetrics(g: FlowGraph): DiagramMetrics {
  const nodes = [...g.nodes.values()];
  const labels = nodes.map((node) => codePointLength(node.label.value));
  const stageBuckets = g.byStage();
  let maxDepth = 1;
  let maxParallel = 1;
  let maxStageLoad = 0;
  for (const members of stageBuckets.values()) {
    maxStageLoad = Math.max(maxStageLoad, members.length);
    const shape = topologyShape(g, new Set(members.map((node) => node.rid)));
    maxDepth = Math.max(maxDepth, shape.depth);
    maxParallel = Math.max(maxParallel, shape.parallel);
  }
  const branchCount = nodes.filter((node) => g.outEdges(node.rid).length > 1).length;
  const nodeCount = nodes.length;
  const edgeCount = g.edges.size;
  const stageCount = Math.max(g.stages.size, stageBuckets.size);
  return {
    nodeCount,
    edgeCount,
    stageCount,
    edgeDensity: edgeCount / Math.max(1, nodeCount),
    branchCount,
    branchRatio: branchCount / Math.max(1, nodeCount),
    maxLabelLength: labels.length > 0 ? Math.max(...labels) : 0,
    averageLabelLength: labels.reduce((sum, length) => sum + length, 0) / Math.max(1, labels.length),
    maxEdgeLabelLength: [...g.edges.values()].reduce(
      (longest, edge) => Math.max(longest, codePointLength(edge.label)),
      0,
    ),
    maxStageLoad,
    maxDepth,
    maxParallel,
  };
}

export function resolveAutoLayout(metrics: DiagramMetrics): DiagramLayout {
  const branching = metrics.branchRatio >= 0.14 || metrics.maxParallel >= 3;
  const labelHeavy = metrics.maxLabelLength >= 18 || metrics.averageLabelLength >= 12;
  const direction: DiagramDirection = branching || (labelHeavy && metrics.maxDepth <= 4) ? "TB" : "LR";

  const nodeWidth = Math.round(clamp(156 + Math.max(0, metrics.maxLabelLength - 9) * 4.4, 156, 260));
  const nodeHeight = metrics.maxLabelLength >= 24 ? 68 : metrics.maxLabelLength >= 15 ? 60 : 52;
  const branchPressure = metrics.branchRatio * 76 + Math.max(0, metrics.maxParallel - 1) * 5;
  const edgePressure = Math.max(0, metrics.edgeDensity - 0.75) * 22;
  const labelPressure = Math.min(24, metrics.maxEdgeLabelLength * 0.9);
  const primaryGap = Math.round(clamp(40 + branchPressure + edgePressure + labelPressure, 42, 118));
  const crossGap = Math.round(clamp(22 + branchPressure * 0.55 + edgePressure, 22, 82));
  const compactStages = Math.max(0, metrics.stageCount - 4);
  const bandPadding = Math.round(clamp(21 - compactStages, 14, 22));
  const bandGap = Math.round(clamp(13 + metrics.stageCount + metrics.branchCount * 1.5, 14, 34));
  const margin = metrics.nodeCount > 28 ? 32 : metrics.nodeCount > 14 ? 28 : 24;
  const titleHeight = metrics.nodeCount > 22 || metrics.stageCount > 5 ? 72 : 58;
  const labelPerLine = Math.round(clamp((nodeWidth - 32) / 10.5, 11, 21));
  const rationale: string[] = [];
  if (branching) rationale.push("分支或并行节点较多，主轴采用 TB 以展开分叉");
  else rationale.push("流程以顺序主干为主，主轴采用 LR");
  if (labelHeavy) rationale.push("标签较长，自动加宽节点并增加标题空间");
  if (metrics.edgeDensity > 1.15) rationale.push("边密度较高，自动扩大节点与泳道间距");
  if (metrics.stageCount > 4) rationale.push("阶段较多，压缩泳道内边距并增大画布下限");

  return {
    direction,
    nodeWidth,
    nodeHeight,
    gapX: direction === "LR" ? primaryGap : crossGap,
    gapY: direction === "LR" ? crossGap : primaryGap,
    bandPadding,
    bandHeader: labelHeavy ? 46 : 40,
    bandGap,
    margin,
    titleHeight,
    minCanvasWidth: Math.round(clamp(500 + metrics.stageCount * 28 + metrics.maxParallel * 34, 540, 940)),
    labelPerLine,
    labelLines: nodeHeight >= 68 ? 3 : 2,
    columns: direction === "LR" ? metrics.maxDepth : metrics.maxParallel,
    density: Number(metrics.edgeDensity.toFixed(3)),
    rationale,
  };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  const [r0, g0, b0] =
    h < 60 ? [chroma, x, 0]
      : h < 120 ? [x, chroma, 0]
        : h < 180 ? [0, chroma, x]
          : h < 240 ? [0, x, chroma]
            : h < 300 ? [x, 0, chroma]
              : [chroma, 0, x];
  const byte = (channel: number): string => Math.round((channel + m) * 255).toString(16).padStart(2, "0");
  return `#${byte(r0)}${byte(g0)}${byte(b0)}`;
}

function rgb(hex: string): readonly [number, number, number] {
  const value = hex.replace(/^#/u, "");
  if (!/^[0-9a-f]{6}$/iu.test(value)) return [0, 0, 0];
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as unknown as readonly [number, number, number];
}

function luminance(hex: string): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722;
}

/** WCAG 对比度。自动配色测试与回执共用，不靠“看起来差不多”。 */
export function contrastRatio(left: string, right: string): number {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function paletteFrom(hash: number, metrics: DiagramMetrics): { palette: FlowPalette; theme: DiagramTheme } {
  const baseHue = (hash + metrics.stageCount * 29 + metrics.branchCount * 17) % 360;
  // 稠密图保持浅底（长时间审阅更清楚）；紧凑图允许由语义 hash 稳定选择深底。
  const dark = metrics.nodeCount > 0 && metrics.nodeCount <= 18 && ((hash >>> 3) + metrics.stageCount) % 5 === 0;
  const tone = dark ? "dark" : "light";
  const fillLightness = dark ? 19 : 92;
  const lineLightness = dark ? 64 : 43;
  const fillSaturation = dark ? 38 : 63;
  const lineSaturation = dark ? 70 : 68;
  const kindHue = (offset: number): number => (baseHue + offset) % 360;
  const ink = dark ? hslToHex(baseHue, 18, 96) : hslToHex(baseHue, 28, 14);
  const dim = dark ? hslToHex(baseHue, 16, 76) : hslToHex(baseHue, 22, 36);
  const canvas = hslToHex(baseHue, dark ? 20 : 25, dark ? 8 : 99);
  const palette: FlowPalette = {
    actionFill: hslToHex(kindHue(0), fillSaturation, fillLightness),
    actionLine: hslToHex(kindHue(0), lineSaturation, lineLightness),
    eventFill: hslToHex(kindHue(48), fillSaturation - 4, fillLightness),
    eventLine: hslToHex(kindHue(48), lineSaturation, lineLightness),
    gatewayFill: hslToHex(kindHue(88), fillSaturation, fillLightness),
    gatewayLine: hslToHex(kindHue(88), lineSaturation, lineLightness),
    terminalFill: hslToHex(kindHue(142), fillSaturation - 5, fillLightness),
    terminalLine: hslToHex(kindHue(142), lineSaturation, lineLightness),
    externalFill: hslToHex(kindHue(265), fillSaturation - 8, fillLightness),
    externalLine: hslToHex(kindHue(265), lineSaturation - 5, lineLightness),
    band: hslToHex(baseHue, dark ? 20 : 30, dark ? 12 : 97),
    bandLine: hslToHex(baseHue, dark ? 20 : 28, dark ? 27 : 84),
    ink,
    dim,
    edge: hslToHex(kindHue(12), dark ? 24 : 22, dark ? 64 : 43),
    canvas,
    mode: "auto",
    tone,
    baseHue,
  };
  const fills = [
    palette.actionFill,
    palette.eventFill,
    palette.gatewayFill,
    palette.terminalFill,
    palette.externalFill,
    palette.band,
  ];
  const minimumTextContrast = Math.min(...fills.map((fill) => contrastRatio(ink, fill)));
  const stageAccents = Array.from({ length: Math.max(1, metrics.stageCount) }, (_, index) => {
    const step = Math.max(41, Math.floor(360 / Math.max(1, metrics.stageCount)));
    return hslToHex(baseHue + index * step, dark ? 72 : 68, dark ? 62 : 44);
  });
  const semanticHash = hash.toString(16).padStart(8, "0");
  const id = `auto-${semanticHash}-${tone}-${metrics.stageCount}s`;
  palette.themeId = id;
  return {
    palette,
    theme: {
      id,
      mode: "auto",
      tone,
      baseHue,
      semanticHash,
      stageAccents,
      minimumTextContrast,
    },
  };
}

/**
 * 回执与 SVG 的共同真相：调用方展示的 theme/layout 元数据必须从这里拿。
 */
export function resolveDiagramStyle(
  g: FlowGraph,
  opts: { title?: string; template?: string } = {},
): ResolvedDiagramStyle {
  const metrics = analyzeDiagramMetrics(g);
  const hash = stableSemanticHash(semanticSignature(g, opts.title ?? ""));
  const { palette, theme } = paletteFrom(hash, metrics);
  return { palette, theme, layout: resolveAutoLayout(metrics), metrics };
}

/** paletteFor("auto") 在还没拿到图时使用的标记；toSvg 会重新解析真实样式。 */
export function autoPaletteMarker(): FlowPalette {
  const emptyMetrics: DiagramMetrics = {
    nodeCount: 0, edgeCount: 0, stageCount: 0, edgeDensity: 0,
    branchCount: 0, branchRatio: 0, maxLabelLength: 0, averageLabelLength: 0,
    maxEdgeLabelLength: 0, maxStageLoad: 0, maxDepth: 1, maxParallel: 1,
  };
  const { palette } = paletteFrom(stableSemanticHash("auto"), emptyMetrics);
  palette.themeId = "auto-pending";
  return palette;
}
