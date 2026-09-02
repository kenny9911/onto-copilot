/**
 * PPT 里画的流程图 —— 连接线（`p:cxnSp`）解析。
 */

import { descendants, firstDescendant, itertext } from "./doc/xmlet.js";
import type { XElement } from "./doc/xmlet.js";
import { pyNormalizeSpaces, pyStrip } from "./doc/pycompat.js";

/** 一条连接线：两端都接在具体形状上，才算一条边。 */
export interface SlideConnector {
  /** 起点形状的 `cNvPr@id`。 */
  readonly from: string;
  /** 终点形状的 `cNvPr@id`。 */
  readonly to: string;
  /** 画在连接线上的文字（分支条件常写在这里）；没有就是空串。 */
  readonly label: string;
}

/** 一页里的一个候选流程节点。 */
export interface SlideShape {
  /** 形状的 `cNvPr@id`，连接线按它对号。 */
  readonly id: string;
  readonly text: string;
  readonly kind: "action" | "gateway" | "terminal";
}

/**
 * 判定节点类型的**唯一**依据：OOXML 的预设几何 `a:prstGeom@prst`。
 *
 * 刻意不看文字。业务词表（「审批」「判断」「结束」）换个行业就整体失效，而且是
 * 静默失效 —— 图还在、框还在，只是全判错。菱形在哪个行业都是分支，椭圆在哪个
 * 行业都是起止；这是画流程图的通用约定，不是某一份材料的形状。
 *
 * 认不出的几何一律 action：宁可粗，不猜。
 */
const GEOM_KIND: Readonly<Record<string, SlideShape["kind"]>> = Object.freeze({
  diamond: "gateway",
  flowChartDecision: "gateway",
  ellipse: "terminal",
  flowChartTerminator: "terminal",
});

export function shapesOf(slideRoot: XElement): SlideShape[] {
  const out: SlideShape[] = [];
  for (const sp of descendants(slideRoot, "sp")) {
    const text = shapeText(sp);
    // 没有文字的框是装饰（背景块、箭头贴图），不是流程步骤。
    if (text === "") continue;
    const id = firstDescendant(sp, "cNvPr")?.attrib["id"] ?? "";
    if (id === "") continue;
    const prst = firstDescendant(sp, "prstGeom")?.attrib["prst"] ?? "";
    out.push({ id, text, kind: GEOM_KIND[prst] ?? "action" });
  }
  return out;
}

function shapeText(sp: XElement): string {
  const parts = descendants(sp, "t").map((node) => itertext(node));
  return pyStrip(pyNormalizeSpaces(parts.join("")));
}

export function connectorsOf(slideRoot: XElement): SlideConnector[] {
  const out: SlideConnector[] = [];
  for (const cxn of descendants(slideRoot, "cxnSp")) {
    const from = firstDescendant(cxn, "stCxn")?.attrib["id"] ?? "";
    const to = firstDescendant(cxn, "endCxn")?.attrib["id"] ?? "";
    // 只接了一端的线在 PPT 里很常见（拖歪了、或纯装饰的引导线）。它不是一条边：
    // 收下来会凭空造出一个指向"某处"的箭头，比不画更误导。
    if (from === "" || to === "") continue;
    out.push({ from, to, label: connectorLabel(cxn) });
  }
  return out;
}

/** 连接线上的文字。分支条件（「金额 > 5万」）常常就写在这里。 */
function connectorLabel(cxn: XElement): string {
  const parts = descendants(cxn, "t").map((node) => itertext(node));
  return pyStrip(pyNormalizeSpaces(parts.join("")));
}

/** 一页 slide 读出来的流程图。 */
export interface SlideFlow {
  readonly nodes: SlideShape[];
  readonly edges: SlideConnector[];
}

/**
 * 一页 slide → 一张流程图，读不出来就返回 `null`。
 *
 * 判据只有一条结构特征：**至少有一条两端都落在本页形状上的连线**。
 * 不看这一页讲什么业务、不看有没有「流程」二字 —— 那种判据换份材料就失效。
 * 没有连线的一页哪怕写满了字，也只是并列的文本框。
 *
 * 指不到形状的边直接丢弃（PPT 里跨页引用、或删掉框后残留的线都会这样），
 * 但只要还剩至少一条有效边，这一页就仍然算一张图。
 */
export function slideFlowOf(slideRoot: XElement): SlideFlow | null {
  const nodes = shapesOf(slideRoot);
  if (nodes.length === 0) return null;

  const known = new Set(nodes.map((n) => n.id));
  const edges = connectorsOf(slideRoot)
    .filter((e) => known.has(e.from) && known.has(e.to));
  if (edges.length === 0) return null;

  // 没连线的框照样留下：漏画一根线是画图的人的疏忽，不是"这一步不存在"的证据。
  // 它会在体检里以孤立节点的形式暴露出来，由人来补。
  return { nodes, edges };
}

/** 一页 slide 及其页码。页码由调用方按 `p:sldIdLst` 的关系顺序给，不是数组下标。 */
export interface SlidePage {
  readonly page: number;
  readonly root: XElement;
}

/** 带页码的一张流程图。页码是证据能点回原幻灯片的前提。 */
export interface SlideFlowPage extends SlideFlow {
  readonly page: number;
}

/**
 * 从若干页里收出所有能成图的页。
 *
 * 页码用调用方给的 `page`，**不能**用数组下标 —— OOXML 允许 `slide2.xml` 排在
 * 第一页，用下标会让每一条溯源都错位（这条坑 `presentation.ts` 的文件头写过）。
 */
export function slideFlowsFrom(pages: readonly SlidePage[]): SlideFlowPage[] {
  const out: SlideFlowPage[] = [];
  for (const { page, root } of pages) {
    const flow = slideFlowOf(root);
    if (flow === null) continue;
    out.push({ page, nodes: flow.nodes, edges: flow.edges });
  }
  return out;
}
