/**
 * 「材料里画好的图」的统一形状。
 *
 * PPT 的连接线（`pptx_flow.ts`）和图片里识别出的连线（`vision_flow.ts`）读的是
 * 两种完全不同的东西，但产出的结构是同一个：一页上的若干框 + 框之间的箭头。
 * 统一成一个形状，是为了后面的策略路由和多源互证能一视同仁地消费它们 ——
 * 否则每加一条策略，下游就要多一个分支。
 *
 * 注意这里**不是** `FlowGraph`：这一层只描述「图上画了什么」，不带证据、不带
 * 断言、不带稳定编号。转成 FlowGraph 是下一步的事，那一步才会补出处。
 */

/** 图上的一个框。`kind` 只由形状几何判定，不看文字（见 pptx_flow 的说明）。 */
export interface DiagramNode {
  /** 页内唯一。PPT 用形状 id，视觉识别用框的文本。 */
  readonly id: string;
  readonly text: string;
  readonly kind: "action" | "gateway" | "terminal";
}

/** 图上的一条箭头。两端都必须指到本页的框。 */
export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  /** 线上的文字；分支条件常写在这里。没有就是空串。 */
  readonly label: string;
}

/** 一页上读出来的一张图。 */
export interface DiagramPage {
  /** 页码由调用方按真实顺序给，不是数组下标。 */
  readonly page: number;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
}
