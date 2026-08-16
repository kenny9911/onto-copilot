/**
 * 流程图渲染 —— FlowGraph → mermaid → SVG。移植自
 * `src/ontocopilot/onto/diagram.py`，由 `golden/onto.diagram.json`
 * （`tools/golden/onto_diagram.py` 导出）钉住。
 *
 * 两级产物，不是一级：
 *
 *     FlowGraph  ──▶  mermaid（人能读、能手改、能进 git、能在任何地方渲染）
 *                ──▶  SVG（能贴进 PPT 和文档，客户会上直接投屏）
 *
 * 中间那一级不能省。FDE 拿到草稿图之后一定要改 —— 挪个节点、改个措辞、补一条边。
 * 只给 SVG 的话他改不动，只能回来找我们重生成；给了 mermaid，他自己就能在
 * mermaid live editor 里改完再导出。**能被人接手改的草稿才是草稿，改不动的
 * 只是一张图片。**
 *
 * SVG 自己画，不依赖 mermaid-cli：多一个外部进程就多一个部署条件。代价是布局
 * 算法要自己写，好处是零依赖、离线可用、样式完全可控（要和客户那张图长得一样）。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`str.isalnum()` 是 Unicode 级的**。`_mid` 拿它清洗 mermaid 节点 id，
 *     而中文、全角字母、罗马数字 Ⅷ、阿拉伯-印度数字 ٣ 在 Python 里**全是**
 *     alnum。照 `/[a-zA-Z0-9]/` 写，`fn_act1_创建采购需求计划` 会变成
 *     `nfn_act1________`，几个中文节点立刻撞成同一个 id，图连错还不报错。
 *     见 `isAlnum`。
 *  2. **切片单位**。`rid[:40]` / `label[:8]` / `subtitle[:80]` / `_wrap` 的
 *     `t[i:i+n]` 全按 code point；JS 的 `slice` 按 UTF-16 码元。标签里全是中文，
 *     emoji 还会被切出半个代理对。
 *  3. **`f"{x:.0f}"` 不是 `toFixed(0)`**：前者 round-half-**even**。坐标全靠它
 *     成串，复用 `kernel/errors.ts` 的 `formatFixed0`，不要另写。
 *  4. **两级产物的转义规则不同**：SVG 走 `html.escape(quote=True)`（单引号是
 *     `&#x27;` 不是 `&apos;`），mermaid 走 `_mlabel`（只把引号换成单引号、
 *     方括号换成圆括号）。混成一套会让 mermaid 里出现 `&amp;` 这种人读不了的东西。
 *
 * 空图是重点：**上一版 `to_svg` 在零泳道时产出 `[None]` 然后 AttributeError**，
 * 而"材料里没有流程说明"恰恰会走到这条路 —— 空图正是新会话的初始状态。
 */

import { formatFixed0 } from "../kernel/errors.js";
import {
  EdgeKind,
  NodeKind,
  nodeGrounded,
  type FlowGraph,
  type FlowNode,
} from "./flow.js";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的 `str.isalnum()`（逐 code point）。
 *
 * CPython 的判据是 `isalpha() or isdecimal() or isdigit() or isnumeric()`，
 * 落到 Unicode 分类上就是 `L*` ∪ `Nd` ∪ `Nl` ∪ `No`。已对 0..0x10FFFF 全量比对过
 * CPython 3.12：**没有一个 Python 认、这个正则不认的**；反方向有 9661 个
 * 这个正则认而 CPython 不认的，全部是 Unicode 15.0（CPython 3.12 的版本）
 * 之后新分配的码位 —— 那是 Unicode 版本差，不是判据差，追不了也不该追。 */
function isAlnum(ch: string): boolean {
  return /^[\p{L}\p{Nd}\p{Nl}\p{No}]$/u.test(ch);
}

/** `s[:n]`：按 code point 切。 */
function cpSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** `html.escape(s)`，默认 `quote=True`。
 *
 * `&` 必须**最先**替换，否则后面几步产出的 `&lt;` 会被再转义一次成 `&amp;lt;`。
 * 单引号是 `&#x27;`（CPython 的写法），不是 `&apos;` —— 这串会进 SVG，
 * 和客户那边的产物做 diff 时一个字都不能差。 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ══════════════════════════════════════════════════════════════════
//  mermaid
// ══════════════════════════════════════════════════════════════════

/** 各类节点的 mermaid 形状。形状本身要携带语义 —— 看图的人不该去对照图例
 * 才知道这个框是动作还是事件。 */
const SHAPE: Readonly<Record<NodeKind, readonly [string, string]>> = {
  [NodeKind.ACTION]: ["([", "])"], // 圆角矩形
  [NodeKind.EVENT]: ["[", "]"], // 直角矩形
  [NodeKind.GATEWAY]: ["{", "}"], // 菱形
  [NodeKind.TERMINAL]: ["[[", "]]"], // 双线框
  [NodeKind.EXTERNAL]: ["[/", "/]"], // 平行四边形
};

const ARROW: Readonly<Record<EdgeKind, string>> = {
  [EdgeKind.FLOW]: "-->",
  [EdgeKind.CONDITIONAL]: "-->",
  [EdgeKind.COMPENSATE]: "-.->",
  [EdgeKind.EXTERNAL]: "-.->",
  [EdgeKind.INFERRED]: "-.->",
};

/** mermaid 的节点 id 不能带特殊字符。
 *
 * Python 侧是私有的 `_mid`。这里导出是为了让 `golden/onto.diagram.json` 的
 * 单元向量能直接断言 —— 它是本模块最容易在 TS 侧写错的一条规则（见文件头第 1 条），
 * 而整张 mermaid 红掉的时候，先看它能立刻分清是 id 清洗错了还是别的地方。 */
export function mid(rid: string): string {
  let cleaned = "";
  // 逐 **code point** 迭代：`for...of` 给的是 code point，`rid[i]` 给的是码元。
  // 一个星平面字符在 Python 那边只换出一个 `_`，按码元迭代会换出两个。
  for (const c of rid) cleaned += isAlnum(c) ? c : "_";
  return "n" + cpSlice(cleaned, 40);
}

/** mermaid 标签里的引号和方括号会破坏语法。（Python 侧的 `_mlabel`。） */
export function mlabel(text: string): string {
  return (text || "").replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")");
}

/**
 * 渲染成 mermaid flowchart。
 *
 * 泳道用 `subgraph` 表达。mermaid 原生没有 BPMN 那种泳道，但 subgraph
 * 在视觉上足够接近，而且**跨 subgraph 的边照样能画** —— 这是选它而不是选
 * 别的图型的原因：真实业务流程里跨阶段的回退边（驳回重编）非常多，
 * 表达不了跨泳道的边等于表达不了业务。
 *
 * @param showCodes 节点标签里带不带 `ACT-CP-DRAFT` 这类编号。给客户看的时候
 *   关掉（他不关心），给下游接系统的人看的时候打开。
 */
export function toMermaid(
  g: FlowGraph,
  opts: { direction?: string; showCodes?: boolean } = {},
): string {
  const direction = opts.direction ?? "LR";
  const showCodes = opts.showCodes ?? true;
  const lines: string[] = [`flowchart ${direction}`];

  const renderNode = (n: FlowNode): string => {
    const [o, c] = SHAPE[n.kind];
    let label = mlabel(n.label.value);
    if (showCodes && n.code) label = `${label}<br/><small>${n.code}</small>`;
    if (n.endpoint) {
      // mermaid 是给人手改的那一级产物，接口路径直接写进标签 ——
      // 在 mermaid live editor 里能读、能搜、能一起改。
      label = `${label}<br/><small>${mlabel(n.endpoint)}</small>`;
    }
    if (!nodeGrounded(n)) {
      // 没有材料依据的节点标出来。**分不清哪里是猜的流程图比没有图更危险**，
      // 因为它看起来同样确定。
      label = `${label}<br/><small>· 推断 ·</small>`;
    }
    return `    ${mid(n.rid)}${o}"${label}"${c}`;
  };

  const byStage = g.byStage();
  // Python 的 sorted 稳定，key 是 order；比较器必须写成相减，
  // 写成 `a.order < b.order ? -1 : 1` 会把同 order 的两条打乱。
  const ordered = [...g.stages.values()].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  for (const st of ordered) {
    const members = byStage.get(st.key) ?? [];
    if (members.length === 0) continue;
    lines.push(`    subgraph ${mid(st.key)}["${mlabel(st.title)}"]`);
    lines.push("        direction LR");
    for (const n of members) {
      // Python 是 `"    " + render_node(n).strip().rjust(0)` —— rjust(0) 是空操作，
      // strip() 把 render_node 自带的 4 空格缩进削掉再补回 4 个，净效果就是原样。
      // 照抄这一步而不是"简化掉"：真要哪天 render_node 改了缩进，两边得一起变。
      lines.push("    " + renderNode(n).trim());
      seen.add(n.rid);
    }
    lines.push("    end");
  }

  for (const [rid, n] of g.nodes) {
    // 不属于任何阶段的
    if (!seen.has(rid)) lines.push(renderNode(n));
  }

  for (const e of g.edges.values()) {
    if (!g.nodes.has(e.source) || !g.nodes.has(e.target)) continue;
    const arrow = ARROW[e.kind];
    const seg = e.label ? `${arrow}|${mlabel(e.label)}|` : arrow;
    lines.push(`    ${mid(e.source)} ${seg} ${mid(e.target)}`);
  }

  // 配色和客户那张图对齐 —— 蓝 Action、橙 Event、黄网关、绿终态
  lines.push(
    "    classDef act fill:#dbeafe,stroke:#60a5fa,color:#1e3a5f;",
    "    classDef evt fill:#fef3c7,stroke:#fbbf24,color:#78350f;",
    "    classDef gw  fill:#fef9c3,stroke:#eab308,color:#713f12;",
    "    classDef end_ fill:#dcfce7,stroke:#4ade80,color:#14532d;",
    "    classDef ext fill:#f3e8ff,stroke:#c084fc,color:#581c87;",
  );
  const classes: readonly [NodeKind, string][] = [
    [NodeKind.ACTION, "act"],
    [NodeKind.EVENT, "evt"],
    [NodeKind.GATEWAY, "gw"],
    [NodeKind.TERMINAL, "end_"],
    [NodeKind.EXTERNAL, "ext"],
  ];
  for (const [kind, cls] of classes) {
    const ids: string[] = [];
    for (const [r, n] of g.nodes) if (n.kind === kind) ids.push(mid(r));
    if (ids.length > 0) lines.push(`    class ${ids.join(",")} ${cls};`);
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════
//  SVG
// ══════════════════════════════════════════════════════════════════

/** 配色。默认值取自客户那张图 —— 产出物要能直接贴进他们已有的材料里。 */
export interface Palette {
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
}

const PALETTE_DEFAULTS: Readonly<Palette> = {
  actionFill: "#dbeafe",
  actionLine: "#93c5fd",
  eventFill: "#fef3c7",
  eventLine: "#fcd34d",
  gatewayFill: "#fefce8",
  gatewayLine: "#eab308",
  terminalFill: "#dcfce7",
  terminalLine: "#86efac",
  externalFill: "#f5f3ff",
  externalLine: "#c4b5fd",
  band: "#fafafa",
  bandLine: "#e5e7eb",
  ink: "#1f2937",
  dim: "#6b7280",
  edge: "#9ca3af",
};

export function makePalette(p: Partial<Palette> = {}): Palette {
  return { ...PALETTE_DEFAULTS, ...p };
}

/** 布局常数。节点宽高固定 —— 变宽的框会让泳道对不齐，而对齐是这类图可读性的
 * 主要来源。 */
export const NODE_W = 168;
export const NODE_H = 52;
const GAP_X = 46;
const GAP_Y = 26;
const BAND_PAD = 18;
const BAND_HEAD = 40;
const MARGIN = 24;

/** 中文按字数折行。超出行数截断加省略号 —— 框是固定宽的，撑破了整张图就乱。
 *
 * 导出是因为它是 `to_svg` 里唯一一处纯函数的截断规则，golden 单独钉了它 ——
 * 整张 SVG 红的时候，先看这一条能立刻分清是布局错了还是折行错了。 */
export function wrap(text: string, perLine = 11, maxLines = 3): string[] {
  // Python 是 `range(0, len(t), per_line)`：step 为 0 直接 ValueError，step 为负
  // 得到空 range（于是 `out or [""]` 回落成 `[""]`）。TS 的 for 循环在这两种
  // 输入上都会**无限转**，而无限循环比抛异常难查一个量级。
  if (perLine === 0) throw new RangeError("range() arg 3 must not be zero");
  const t = (text || "").trim();
  const cps = [...t]; // 按 code point 切：中文和 emoji 都不能按码元数
  const out: string[] = [];
  if (perLine > 0) {
    for (let i = 0; i < cps.length; i += perLine) out.push(cps.slice(i, i + perLine).join(""));
  }
  if (out.length > maxLines) {
    out.length = maxLines;
    const last = out[maxLines - 1]!;
    out[maxLines - 1] = cpSlice(last, perLine - 1) + "…";
  }
  return out.length > 0 ? out : [""];
}

/** 泳道内分层：按拓扑序排列，同层的并排。
 *
 * 有环的图（驳回重编是个环）用 Kahn 算法会剩下一堆节点。剩下的一律放到最后
 * 一层 —— **画得出来比画得对更重要**：一张因为有环就画不出来的流程图，
 * 对 FDE 的价值是零，而真实业务流程几乎一定有环。 */
export function layer(g: FlowGraph, nodes: readonly FlowNode[]): FlowNode[][] {
  const ids = new Set(nodes.map((n) => n.rid));
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    let d = 0;
    for (const e of g.inEdges(n.rid)) if (ids.has(e.source)) d += 1;
    indeg.set(n.rid, d);
  }
  const layers: FlowNode[][] = [];
  // Map 而不是普通对象：这里的迭代顺序就是产物里同层节点的左右顺序，
  // 而普通对象对整数样式的键会重排。
  const remaining = new Map<string, FlowNode>(nodes.map((n) => [n.rid, n]));
  while (remaining.size > 0) {
    const ready: FlowNode[] = [];
    for (const [rid, n] of remaining) if ((indeg.get(rid) ?? 0) <= 0) ready.push(n);
    if (ready.length === 0) {
      // 环：剩下的全塞最后一层
      layers.push([...remaining.values()]);
      break;
    }
    layers.push(ready);
    for (const n of ready) {
      remaining.delete(n.rid);
      for (const e of g.outEdges(n.rid)) {
        if (remaining.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 1) - 1);
      }
    }
  }
  return layers;
}

/**
 * 渲染成自包含 SVG。零依赖、离线可用。
 *
 * 布局：一个阶段一条横向泳道（和客户那张图一致），泳道内按拓扑分层从左往右。
 * 跨泳道的边走贝塞尔曲线，避开节点。
 */
export function toSvg(
  g: FlowGraph,
  opts: { title?: string; palette?: Palette | null; showCodes?: boolean } = {},
): string {
  const title = opts.title ?? "业务流程总览";
  const p = opts.palette ?? makePalette();
  const showCodes = opts.showCodes ?? true;
  const byStage = g.byStage();
  const ordered = [...g.stages.values()].sort((a, b) => a.order - b.order);
  // 泳道顺序：先按注册顺序排已注册的，再补上有节点却没注册的（那本身是个 bug，
  // 但**渲染不该因此崩**——一张少个标题的图，也远好过一个 AttributeError 把整条
  // 建图链路带走）。Python 上一版这里是 `[type(...) and None]`，零泳道时产出
  // `[None]`，下一行取 `.key` 直接抛异常，而"材料里没有流程说明"恰恰会走到这条路。
  const stageKeys: string[] = [];
  for (const st of ordered) {
    if ((byStage.get(st.key) ?? []).length > 0) stageKeys.push(st.key);
  }
  for (const k of byStage.keys()) if (!stageKeys.includes(k)) stageKeys.push(k);

  const pos = new Map<string, [number, number]>();
  const bands: [string, number, number, number][] = []; // key, y, h, w
  let y = MARGIN + 34;
  let maxW = 0;

  for (const key of stageKeys) {
    const members = byStage.get(key) ?? [];
    const layers = layer(g, members);
    // `max(..., default=1)`：空泳道也按一行算高度。
    const rows = layers.length > 0 ? Math.max(...layers.map((c) => c.length)) : 1;
    const bandH = BAND_HEAD + rows * NODE_H + (rows - 1) * GAP_Y + BAND_PAD * 2;
    layers.forEach((col, li) => {
      col.forEach((n, ri) => {
        pos.set(n.rid, [
          MARGIN + BAND_PAD + li * (NODE_W + GAP_X),
          y + BAND_HEAD + BAND_PAD + ri * (NODE_H + GAP_Y),
        ]);
      });
    });
    const w = MARGIN + BAND_PAD * 2 + Math.max(1, layers.length) * (NODE_W + GAP_X);
    maxW = Math.max(maxW, w);
    bands.push([key, y, bandH, w]);
    y += bandH + 16;
  }

  const W = Math.max(maxW + MARGIN, 640);
  const H = y + MARGIN;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${formatFixed0(W)} ${formatFixed0(H)}" ` +
      `width="${formatFixed0(W)}" height="${formatFixed0(H)}" font-family="-apple-system,PingFang SC,` +
      `Microsoft YaHei,sans-serif">`,
    `<rect width="${formatFixed0(W)}" height="${formatFixed0(H)}" fill="#ffffff"/>`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0,0 L10,5 L0,10 z" fill="${p.edge}"/></marker></defs>`,
    `<text x="${MARGIN}" y="${MARGIN + 14}" font-size="17" font-weight="600" ` +
      `fill="${p.ink}">${htmlEscape(title)}</text>`,
  ];
  const st = g.stats();
  // 「多少个环节有接口撑着」是拿这张图开会时第一个被问到的数。没接上任何接口时
  // 不写这一句 —— 一句「0 个环节已对上接口」只会让人以为系统什么都没有。
  let wired = 0;
  let acts = 0;
  for (const n of g.nodes.values()) {
    if (n.kind === NodeKind.ACTION) {
      acts += 1;
      if (n.endpoint) wired += 1;
    }
  }
  out.push(
    `<text x="${MARGIN}" y="${MARGIN + 32}" font-size="11" fill="${p.dim}">` +
      `${st["actions"] ?? 0} 个 Action ｜ ${st["events"] ?? 0} 个 Event ｜ ` +
      `${st["stages"] ?? 0} 个阶段 ｜ ${st["inferred_edges"] ?? 0} 条边为系统推断，需人工确认` +
      (wired ? ` ｜ ${wired}/${acts} 个环节已对上接口` : "") +
      "</text>",
  );

  // 泳道
  for (const [key, by, bh] of bands) {
    const stage = g.stages.get(key);
    out.push(
      `<rect x="${MARGIN}" y="${formatFixed0(by)}" width="${formatFixed0(W - MARGIN * 2)}" ` +
        `height="${formatFixed0(bh)}" rx="6" fill="${p.band}" stroke="${p.bandLine}"/>`,
    );
    out.push(
      `<rect x="${MARGIN}" y="${formatFixed0(by)}" width="4" height="${formatFixed0(bh)}" ` +
        `rx="2" fill="${p.actionLine}"/>`,
    );
    out.push(
      `<text x="${MARGIN + 16}" y="${formatFixed0(by + 22)}" font-size="12.5" ` +
        `font-weight="600" fill="${p.ink}">` +
        `${htmlEscape(stage ? stage.title : key)}</text>`,
    );
    if (stage && stage.subtitle) {
      out.push(
        `<text x="${MARGIN + 16}" y="${formatFixed0(by + 36)}" font-size="10" ` +
          `fill="${p.dim}">${htmlEscape(cpSlice(stage.subtitle, 80))}</text>`,
      );
    }
  }

  // 边先画，压在节点下面
  for (const e of g.edges.values()) {
    const src = pos.get(e.source);
    const tgt = pos.get(e.target);
    if (src === undefined || tgt === undefined) continue;
    const [x1, y1] = src;
    const [x2, y2] = tgt;
    const sx = x1 + NODE_W;
    const sy = y1 + NODE_H / 2;
    const tx = x2;
    const ty = y2 + NODE_H / 2;
    const dash =
      e.kind === EdgeKind.INFERRED ||
      e.kind === EdgeKind.EXTERNAL ||
      e.kind === EdgeKind.COMPENSATE
        ? ' stroke-dasharray="5 4"'
        : "";
    const col = e.kind === EdgeKind.COMPENSATE ? "#c4b5fd" : p.edge;
    let d: string;
    if (tx < sx) {
      // 回退边：从下方绕
      const mid2 = Math.max(sy, ty) + NODE_H * 0.7;
      d =
        `M${formatFixed0(sx)},${formatFixed0(sy)} C${formatFixed0(sx + 40)},${formatFixed0(mid2)} ` +
        `${formatFixed0(tx - 40)},${formatFixed0(mid2)} ${formatFixed0(tx)},${formatFixed0(ty)}`;
    } else {
      d =
        `M${formatFixed0(sx)},${formatFixed0(sy)} C${formatFixed0((sx + tx) / 2)},${formatFixed0(sy)} ` +
        `${formatFixed0((sx + tx) / 2)},${formatFixed0(ty)} ${formatFixed0(tx)},${formatFixed0(ty)}`;
    }
    out.push(
      `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.3"` +
        `${dash} marker-end="url(#a)"/>`,
    );
    if (e.label) {
      out.push(
        `<text x="${formatFixed0((sx + tx) / 2)}" y="${formatFixed0((sy + ty) / 2 - 5)}" ` +
          `font-size="9.5" fill="${p.dim}" text-anchor="middle">` +
          `${htmlEscape(cpSlice(e.label, 8))}</text>`,
      );
    }
  }

  // 节点
  const fills: Readonly<Record<NodeKind, readonly [string, string]>> = {
    [NodeKind.ACTION]: [p.actionFill, p.actionLine],
    [NodeKind.EVENT]: [p.eventFill, p.eventLine],
    [NodeKind.GATEWAY]: [p.gatewayFill, p.gatewayLine],
    [NodeKind.TERMINAL]: [p.terminalFill, p.terminalLine],
    [NodeKind.EXTERNAL]: [p.externalFill, p.externalLine],
  };
  const tags: Readonly<Record<NodeKind, string>> = {
    [NodeKind.ACTION]: "ACTION",
    [NodeKind.EVENT]: "EVENT",
    [NodeKind.GATEWAY]: "",
    [NodeKind.TERMINAL]: "",
    [NodeKind.EXTERNAL]: "外部",
  };
  for (const [rid, n] of g.nodes) {
    const at = pos.get(rid);
    if (at === undefined) continue;
    const [x, ny] = at;
    const [fill, line] = fills[n.kind];
    const dash = !nodeGrounded(n) ? ' stroke-dasharray="4 3"' : "";
    if (n.kind === NodeKind.GATEWAY) {
      const cx = x + NODE_W / 2;
      const cy = ny + NODE_H / 2;
      out.push(
        `<polygon points="${formatFixed0(cx)},${formatFixed0(ny)} ${formatFixed0(x + NODE_W)},${formatFixed0(cy)} ` +
          `${formatFixed0(cx)},${formatFixed0(ny + NODE_H)} ${formatFixed0(x)},${formatFixed0(cy)}" fill="${fill}" ` +
          `stroke="${line}"${dash}/>`,
      );
    } else {
      const r = n.kind === NodeKind.ACTION ? 14 : 4;
      out.push(
        `<rect x="${formatFixed0(x)}" y="${formatFixed0(ny)}" width="${NODE_W}" ` +
          `height="${NODE_H}" rx="${r}" fill="${fill}" stroke="${line}"${dash}/>`,
      );
    }
    const tag = tags[n.kind];
    let ty0 = ny + 15;
    if (tag) {
      out.push(
        `<text x="${formatFixed0(x + NODE_W / 2)}" y="${formatFixed0(ty0)}" font-size="7.5" ` +
          `fill="${p.dim}" text-anchor="middle" letter-spacing="0.5">${tag}</text>`,
      );
      ty0 += 12;
    }
    wrap(n.label.value, 12, 2).forEach((ln, i) => {
      out.push(
        `<text x="${formatFixed0(x + NODE_W / 2)}" y="${formatFixed0(ty0 + i * 12)}" ` +
          `font-size="10.5" fill="${p.ink}" text-anchor="middle">` +
          `${htmlEscape(ln)}</text>`,
      );
    });
    if (showCodes && n.code) {
      out.push(
        `<text x="${formatFixed0(x + NODE_W / 2)}" y="${formatFixed0(ny + NODE_H - 6)}" ` +
          `font-size="7" fill="${p.dim}" text-anchor="middle" ` +
          `font-family="ui-monospace,monospace">${htmlEscape(n.code)}</text>`,
      );
    }
    if (n.endpoint) {
      // 接口路径在 168px 宽的框里放不下，硬塞会把标签挤掉。用一个角标表示
      // "这一步有系统支撑"，完整路径进 <title> —— 鼠标停上去就能看全。
      out.push(
        `<circle cx="${formatFixed0(x + NODE_W - 9)}" cy="${formatFixed0(ny + 9)}" r="3.5" ` +
          `fill="${p.actionLine}"><title>${htmlEscape(n.endpoint)}` +
          `</title></circle>`,
      );
    }
  }

  out.push(
    `<text x="${MARGIN}" y="${formatFixed0(H - 8)}" font-size="9" fill="${p.dim}">` +
      "虚线 = 系统推断的顺序，材料里没有明写　·　右上角圆点 = 这一步有接口实现，" +
      "悬停看路径</text>",
  );
  out.push("</svg>");
  return out.join("\n");
}
