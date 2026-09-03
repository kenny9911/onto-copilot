/**
 * S3：图片流程图识读 → FlowGraph。
 *
 * `vision.ts` 的 OCR 已经产出 `structured.relations`（框之间的连线，含线上文字），
 * 实测最好的模型在百节点图上认出 34 条 —— 但此前没有任何流程构建代码读它，
 * **已经付过钱的信号被整体扔掉**。这个模块就是那次付费的收割器。
 *
 * ── 保守档（评审定的）───────────────────────────────────────
 * 只产 action 节点 + 边。`OCR_SCHEMA.blocks.kind` 是 ER 图口径
 * （entity_box/field/note/…），没有任何流程语义可推 —— 硬猜 gateway/terminal
 * 就是在编。节点类型留给人工或后续策略补。
 *
 * ── 保真度 ─────────────────────────────────────────────────
 * 转写客户自己画的图，记实证档（extracted + 页级 locator）。但消费方必须
 * 一并展示「识别到 N 框 M 线，可能有遗漏」：漏掉的线会静默变成
 * "这两个框之间没有关系" —— 假阴性伪装成实证，必须说破。
 */

import { FlowGraph, NodeKind, makeFlowNode } from "./flow.js";
import { extracted, makeProvenance, makeRid } from "./oir.js";
import type { Provenance } from "./oir.js";

/** vision 落在 `doc.structured` 里的形状（只取用得到的字段）。 */
interface VisionDocLike {
  readonly file_id: string;
  readonly file_name: string;
  readonly structured: Record<string, unknown>;
}

export function flowFromVision(doc: VisionDocLike): FlowGraph | null {
  const relations = asArray(doc.structured["relations"]);
  if (relations.length === 0) return null;

  const g = new FlowGraph();
  // 实体文本 → rid。同一个框在多条线里出现是常态，只建一次。
  const byText = new Map<string, string>();

  const nodeOf = (text: string, page: number): string | null => {
    const t = text.trim();
    if (!t) return null;
    const hit = byText.get(t);
    if (hit !== undefined) return hit;
    const n = g.addNode(makeFlowNode({
      rid: makeRid("fn", `vis_${t}`),
      kind: NodeKind.ACTION,
      label: extracted(t, prov(doc, page, t)),
    }));
    byText.set(t, n.rid);
    return n.rid;
  };

  let edges = 0;
  for (const raw of relations) {
    const r = asRecord(raw);
    const page = typeof r["page"] === "number" ? (r["page"] as number) : 1;
    const from = nodeOf(String(r["from_entity"] ?? ""), page);
    const to = nodeOf(String(r["to_entity"] ?? ""), page);
    // 一端是空名的线不成边 —— 造一个无名节点比丢一条线更误导
    if (from === null || to === null) continue;
    g.connect(from, to, {
      label: String(r["label"] ?? ""),
      evidence: [prov(doc, page, `${r["from_entity"]} → ${r["to_entity"]}`)],
    });
    edges += 1;
  }

  return edges > 0 ? g : null;
}

function prov(doc: VisionDocLike, page: number, snippet: string): Provenance {
  return makeProvenance(doc.file_id, doc.file_name, { kind: "page", page }, {
    snippet,
    extractor: "vision",
  });
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
