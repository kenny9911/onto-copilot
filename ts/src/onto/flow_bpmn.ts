/**
 * BPMN `ParsedDoc` → {@link FlowGraph} 的确定性桥接。移植自
 * `src/ontocopilot/onto/flow_bpmn.py`，由 `golden/flow.json` 的 `bpmn` 段钉住。
 *
 * BPMN 已经是一张结构化流程图：让模型再从切片里抽一遍不仅慢，还会丢节点 id、条件
 * 和泳道。本模块只做无损映射；任何 BPMN 引用都保留为 XML provenance。
 */

import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  makeFlowEdge,
  makeFlowNode,
  makeStage,
  makeWorkflow,
} from "./flow.js";
import {
  Status,
  extracted,
  makeProvenance,
  makeRid,
  withConfidence,
  type Provenance,
} from "./oir.js";

/**
 * `flow_from_bpmn_docs` 只用到 ParsedDoc 的四个字段，所以这里按**结构**约束
 * 而不是 import `parse/base.ts` 的 `ParsedDoc` —— 两个模块因此不互相拖着走，
 * 而真正的 `ParsedDoc` 结构上天然满足这个接口（字段名照 Python 的 snake_case）。
 */
export interface BpmnDocLike {
  readonly kind?: string;
  readonly file_id: string;
  readonly file_name: string;
  readonly structured?: Record<string, unknown> | null;
}

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  return String(v);
}

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `str(x or "y")`。 */
function pyOr(v: unknown, fallback: string): string {
  return pyTruthy(v) ? pyStr(v) : fallback;
}

/** f-string 里的 `{d.get(k, "")}`：键缺失印空串，键在但值是 None 印 `"None"`。
 * 两种形态不一样是有意的 —— 出处片段会被人点回原文。 */
function fmtGet(d: Record<string, unknown>, k: string): string {
  return k in d ? pyStr(d[k]) : "";
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `for x in v`，其中 v 来自 `d.get(k, ())`。Python 对 None 抛
 * `TypeError: 'NoneType' object is not iterable` —— 照抛。 */
function iterOf(v: unknown): unknown[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  throw new TypeError(`'${v === null ? "NoneType" : typeof v}' object is not iterable`);
}

/** `d.get(k, ())`：键缺失给空序列，键在就原样拿（None 会在 iterOf 那里炸）。 */
function seq(d: Record<string, unknown>, k: string): unknown[] {
  return k in d ? iterOf(d[k]) : [];
}

/** `d.get(k) or []`：None 也当空。 */
function seqOrEmpty(d: Record<string, unknown>, k: string): unknown[] {
  const v = d[k];
  return pyTruthy(v) ? iterOf(v) : [];
}

/** `s[:300]` 按 code point 切 —— BPMN 的 documentation 常是整段中文。 */
function sliceCodePoints(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// ══════════════════════════════════════════════════════════════════

/** 把一批 BPMN `ParsedDoc` 合并为一张图；没有 BPMN 节点则返回 `null`。 */
export function flowFromBpmnDocs(docs: readonly BpmnDocLike[]): FlowGraph | null {
  const bpmnDocs = docs.filter((doc) => (doc.kind ?? "") === "bpmn");
  if (bpmnDocs.length === 0) return null;

  const graph = new FlowGraph();
  // Python 的键是 (file_id, process_id, element_id) 三元组；JS 没有值相等的元组，
  // 用 Map 套 Map 会写三层，这里退而用 JSON 串当键 —— canonicalJson 级别的严谨
  // 在这里是多余的，三段都是字符串。
  const nodeIds = new Map<string, string>();
  const key3 = (f: string, p: string, e: string): string => JSON.stringify([f, p, e]);
  let stageOrder = 0;
  // Python 侧还有一份 process_stage 映射，写进去之后没有任何地方读它 —— 死代码，不迁。

  for (const doc of bpmnDocs) {
    for (const rawProcess of seq(doc.structured ?? {}, "processes")) {
      if (!isPlainDict(rawProcess)) continue;
      const process = rawProcess;
      const processId = pyOr(process["id"], "process");
      const processName = pyOr(process["name"], processId);
      const baseStage = uniqueKey(graph.stages, makeRid("stage", `${doc.file_id}:${processId}`));
      graph.stages.set(
        baseStage,
        makeStage({
          key: baseStage,
          title: processName,
          subtitle: `BPMN process · ${doc.file_name}`,
          order: stageOrder,
        }),
      );
      stageOrder += 1;

      for (const rawNode of seq(process, "nodes")) {
        if (!isPlainDict(rawNode)) continue;
        const raw = rawNode;
        const elementId = pyOr(raw["id"], "");
        if (!elementId) continue;
        const category = pyOr(raw["category"], "");
        const kind = nodeKindOf(category, pyOr(raw["type"], ""));
        const rid = uniqueKey(
          graph.nodes,
          makeRid("fn", `${doc.file_id}:${processId}:${elementId}`),
        );
        nodeIds.set(key3(doc.file_id, processId, elementId), rid);
        let stage = laneStage(graph, {
          doc,
          processId,
          processName,
          lanes: seqOrEmpty(raw, "lanes"),
          fallback: baseStage,
          order: stageOrder,
        });
        const existing = graph.stages.get(stage);
        if (existing === undefined) {
          // laneStage 要么返回 fallback、要么现建一条，所以这条分支走不到 ——
          // 照迁，它是 Python 侧的防御。
          stage = baseStage;
        } else if (stage !== baseStage && existing.order >= stageOrder) {
          stageOrder = existing.order + 1;
        }
        const prov = provenanceOf(doc, {
          processId,
          elementType: pyOr(raw["type"], category),
          elementId,
          snippet: nodeSnippet(raw, processName),
        });
        // `raw.get("lanes", ())` 这一行**没有** `or []` 兜底：显式写了
        // `"lanes": null` 的节点会当场 TypeError。照实迁，不"顺手修好"。
        const actor = seq(raw, "lanes")
          .filter(isPlainDict)
          .map((lane) => pyOr(lane["name"], pyOr(lane["id"], "")))
          .join("、");
        graph.addNode(
          makeFlowNode({
            rid,
            kind,
            label: withConfidence(extracted(pyOr(raw["name"], elementId), prov), 1.0),
            stage,
            // Python 那里是 `extracted(actor, …) if actor else extracted("", …)` ——
            // actor 为空时两个分支的结果一模一样，合成一句。
            actor: withConfidence(extracted(actor, prov), 1.0),
            status: Status.CANDIDATE,
          }),
        );
      }

      const entries: string[] = [];
      const exits: string[] = [];
      for (const rawNode of seq(process, "nodes")) {
        if (!isPlainDict(rawNode)) continue;
        const rid = nodeIds.get(key3(doc.file_id, processId, pyOr(rawNode["id"], "")));
        if (!rid) continue;
        const elementType = pyOr(rawNode["type"], "");
        if (elementType === "startEvent") entries.push(rid);
        if (elementType === "endEvent") exits.push(rid);
      }
      const workflowKey = uniqueKey(
        graph.workflows,
        makeRid("wf", `${doc.file_id}:${processId}`),
      );
      graph.workflows.set(
        workflowKey,
        makeWorkflow({
          key: workflowKey,
          title: processName,
          entry: entries.length > 0 ? (entries[0] as string) : "",
          exits,
          description: pyOr(process["documentation"], ""),
        }),
      );
    }
  }

  for (const doc of bpmnDocs) {
    for (const rawProcess of seq(doc.structured ?? {}, "processes")) {
      if (!isPlainDict(rawProcess)) continue;
      const process = rawProcess;
      const processId = pyOr(process["id"], "process");
      for (const rawFlow of seq(process, "sequenceFlows")) {
        if (!isPlainDict(rawFlow)) continue;
        const raw = rawFlow;
        const flowId = pyOr(raw["id"], "flow");
        const source = nodeIds.get(key3(doc.file_id, processId, pyOr(raw["sourceRef"], "")));
        const target = nodeIds.get(key3(doc.file_id, processId, pyOr(raw["targetRef"], "")));
        if (!source || !target) {
          // Parser 已给出 dangling_reference finding；不在图里伪造无来源节点。
          continue;
        }
        const condition = pyOr(raw["condition"], "").trim();
        const name = pyOr(raw["name"], "").trim();
        const label = condition || (name !== flowId ? name : "");
        const prov = provenanceOf(doc, {
          processId,
          elementType: "sequenceFlow",
          elementId: flowId,
          snippet:
            `${fmtGet(raw, "sourceRef")} -> ${fmtGet(raw, "targetRef")}` +
            (label ? `；${label}` : ""),
        });
        const edgeRid = uniqueKey(
          graph.edges,
          makeRid("fe", `${doc.file_id}:${processId}:${flowId}`),
        );
        graph.addEdge(
          makeFlowEdge({
            rid: edgeRid,
            source,
            target,
            kind: label ? EdgeKind.CONDITIONAL : EdgeKind.FLOW,
            label,
            evidence: [prov],
          }),
        );
      }
    }
  }

  return graph.nodes.size > 0 ? graph : null;
}

function nodeKindOf(category: string, elementType: string): NodeKind {
  if (category === "gateway" || elementType.endsWith("Gateway")) return NodeKind.GATEWAY;
  if (category === "event" || elementType.endsWith("Event")) {
    return elementType === "endEvent" ? NodeKind.TERMINAL : NodeKind.EVENT;
  }
  return NodeKind.ACTION;
}

function laneStage(
  graph: FlowGraph,
  p: {
    doc: BpmnDocLike;
    processId: string;
    processName: string;
    lanes: readonly unknown[];
    fallback: string;
    order: number;
  },
): string {
  const lane = p.lanes.find(isPlainDict);
  if (lane === undefined) return p.fallback;
  const laneId = pyOr(lane["id"], pyOr(lane["name"], "lane"));
  const laneName = pyOr(lane["name"], laneId);
  const key = makeRid("stage", `${p.doc.file_id}:${p.processId}:lane:${laneId}`);
  if (!graph.stages.has(key)) {
    graph.stages.set(
      key,
      makeStage({
        key,
        title: laneName,
        subtitle: `${p.processName} · BPMN lane · ${p.doc.file_name}`,
        order: p.order,
      }),
    );
  }
  return key;
}

function provenanceOf(
  doc: BpmnDocLike,
  p: { processId: string; elementType: string; elementId: string; snippet: string },
): Provenance {
  return makeProvenance(
    pyStr(doc.file_id),
    pyStr(doc.file_name),
    {
      kind: "xml",
      pointer:
        `/definitions/process[@id="${p.processId}"]` +
        (p.elementType === "process" ? "" : `//${p.elementType}[@id="${p.elementId}"]`),
      process: p.processId,
      element: p.elementType,
      id: p.elementId,
    },
    { snippet: sliceCodePoints(p.snippet, 300), extractor: "bpmn", confidence: 1.0 },
  );
}

function nodeSnippet(raw: Record<string, unknown>, processName: string): string {
  const bits = [
    pyOr(raw["name"], pyOr(raw["id"], "")),
    pyOr(raw["type"], ""),
    `process=${processName}`,
  ];
  if (pyTruthy(raw["documentation"])) bits.push(pyStr(raw["documentation"]));
  return bits.filter((bit) => bit).join("；");
}

function uniqueKey(items: ReadonlyMap<string, unknown>, base: string): string {
  if (!items.has(base)) return base;
  let suffix = 2;
  while (items.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}
