/**
 * BPMN 2.0 XML -> 可检索、可追溯的流程证据。
 *
 * 前线材料里的 BPMN 文件通常比流程截图更有价值：节点 id、分支条件和连线关系都
 * 是确定性结构，不该再交给模型从图片里猜。本解析器只读取建模所需的流程、活动、
 * 事件、网关和 sequenceFlow；未知扩展保留在原文件中，但不会伪装成已解析内容。
 *
 * ── 为什么这里的每个字段都不能"差不多" ──────────────────────────
 *
 * `structured.nodes` / `structured.sequenceFlows` 是下游流程可视化的**唯一输入**。
 * `sourceRef` / `targetRef` 反了，画出来的箭头就是反的；`type` 从 exclusiveGateway
 * 错成 parallelGateway，读图的人会以为两条分支同时发生。所以：
 *
 *   · 边的方向照抄属性，**不做任何"看起来更合理"的纠正**；
 *   · 网关/事件/任务的 `type` 保留原始标签名，`category` 只是分桶；
 *   · 指不到已解析节点的 ref **发 finding 而不是丢弃**——丢弃会让图看起来完整，
 *     而"看起来完整但少了一条边"是最难被发现的错。
 *
 * XML 选型见 `doc/xmlet.ts` 的文件头（手写零依赖的 ElementTree 等价物）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { pyRepr } from "../../kernel/errors.js";
import type { ParsedDoc } from "./base.js";
import { Parser, makeChunk, makeFinding, makeParsedDoc } from "./base.js";
import { pyNormalizeSpaces, pyStrip } from "./doc/pycompat.js";
import type { XElement } from "./doc/xmlet.js";
import {
  XmlParseError,
  childrenNamed,
  fromString,
  iterElements,
  itertext,
  localName,
  namespaceOf,
} from "./doc/xmlet.js";
import { hasDtdMarker } from "./doc/ziplite.js";

const MAX_XML_BYTES = 20 * 1024 * 1024;

const TASK_TYPES = new Set([
  "task", "userTask", "serviceTask", "manualTask", "scriptTask",
  "businessRuleTask", "sendTask", "receiveTask", "callActivity", "subProcess",
]);
const EVENT_TYPES = new Set([
  "startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent",
  "boundaryEvent",
]);
const GATEWAY_TYPES = new Set([
  "exclusiveGateway", "inclusiveGateway", "parallelGateway", "complexGateway",
  "eventBasedGateway",
]);

export interface BpmnLane {
  id: string;
  name: string;
}

export interface BpmnEventDefinition {
  type: string;
  attributes: Record<string, string>;
  text: string;
}

export interface BpmnNode {
  id: string;
  name: string;
  /** 原始标签名（`userTask` / `exclusiveGateway` / …）。画图靠它区分形状。 */
  type: string;
  /** task | event | gateway */
  category: string;
  process_id: string;
  incoming: string[];
  outgoing: string[];
  documentation: string;
  event_definitions: BpmnEventDefinition[];
  lanes: BpmnLane[];
  attributes: Record<string, string>;
}

export interface BpmnFlow {
  id: string;
  name: string;
  type: string;
  process_id: string;
  sourceRef: string;
  targetRef: string;
  condition: string;
  documentation: string;
  attributes: Record<string, string>;
}

export interface BpmnProcess {
  id: string;
  name: string;
  /** 属性缺失时是 `null`（Python 的 `None`），**不是 false** —— "没写"和"写了
   *  false"在导出 BPMN 时是两种不同的行为。 */
  isExecutable: boolean | null;
  documentation: string;
  nodes: BpmnNode[];
  sequenceFlows: BpmnFlow[];
}

/** 解析 `.bpmn` 和复合后缀 `.bpmn20.xml`。 */
export class BpmnParser extends Parser {
  override readonly kind = "bpmn";
  override readonly extensions = [".bpmn", ".bpmn20.xml"];

  /** 不把普通 `.xml` 抢过来；基础的"取扩展名"认不出复合后缀。 */
  override accepts(path: string): boolean {
    const name = basename(path).toLowerCase();
    return name.endsWith(".bpmn") || name.endsWith(".bpmn20.xml");
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileId = opts.fileId;
    const fileName = basename(path);
    const doc = makeParsedDoc({ fileId, fileName, kind: this.kind });

    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (e) {
      doc.findings.push(makeFinding(
        "parse_failed", `无法读取 BPMN 文件：${errText(e)}`, {}, "warn"));
      return doc;
    }

    if (data.length > MAX_XML_BYTES) {
      doc.findings.push(makeFinding(
        "file_too_large",
        `BPMN XML 大于 ${Math.floor(Math.floor(MAX_XML_BYTES / 1024) / 1024)} MiB，已拒绝解析`,
        { kind: "xml", pointer: "/" }, "warn"));
      return doc;
    }

    // 解析器不会主动取外部 DTD，但内部实体仍可能放大。BPMN 2.0 实例不需要 DTD，
    // 直接拒绝比尝试区分合法/恶意声明更稳妥。
    if (hasDtdMarker(data)) {
      doc.findings.push(makeFinding(
        "unsafe_xml", "BPMN 含 DTD/ENTITY 声明，已为避免实体展开攻击而拒绝解析",
        { kind: "xml", pointer: "/" }, "warn"));
      return doc;
    }

    let root: XElement;
    try {
      root = fromString(data);
    } catch (e) {
      const locator: Record<string, unknown> = { kind: "xml", pointer: "/" };
      if (e instanceof XmlParseError) {
        locator["line"] = e.position[0];
        locator["column"] = e.position[1];
      }
      doc.findings.push(makeFinding(
        "parse_failed", `BPMN XML 语法错误：${errText(e)}`, locator, "warn"));
      return doc;
    }

    const rootName = localName(root.tag);
    doc.meta["namespace"] = namespaceOf(root.tag);
    doc.meta["definitions_id"] = root.attrib["id"] ?? "";
    doc.meta["target_namespace"] = root.attrib["targetNamespace"] ?? "";
    if (rootName !== "definitions") {
      doc.findings.push(makeFinding(
        "unexpected_root", `BPMN 根节点应为 definitions，实际为 ${pyRepr(rootName)}`,
        { kind: "xml", pointer: `/${rootName}` }, "warn"));
    }

    const processes: BpmnProcess[] = [];
    const allNodes: BpmnNode[] = [];
    const allFlows: BpmnFlow[] = [];
    let order = 0;

    const processElements = [...iterElements(root)]
      .filter((e) => localName(e.tag) === "process");
    for (const [processIndex, process] of processElements.entries()) {
      const processNo = processIndex + 1;
      const processId = process.attrib["id"] || `process-${processNo}`;
      const processName = process.attrib["name"] || processId;
      if (!("id" in process.attrib)) {
        doc.findings.push(makeFinding(
          "missing_id", `第 ${processNo} 个 process 没有 id，临时使用 ${processId}`,
          locatorOf(processId, "process", processId), "warn"));
      }

      const lanes = laneMembers(process);
      const nodes: BpmnNode[] = [];
      const flows: BpmnFlow[] = [];
      let anonymous = 0;
      for (const element of iterElements(process)) {
        const elementType = localName(element.tag);
        const category = categoryOf(elementType);
        if (category === null) continue;
        let elementId = element.attrib["id"] ?? "";
        if (!elementId) {
          anonymous += 1;
          elementId = `anonymous-${category}-${anonymous}`;
          doc.findings.push(makeFinding(
            "missing_id",
            `流程 ${processId} 的 ${elementType} 没有 id，临时使用 ${elementId}`,
            locatorOf(processId, elementType, elementId), "warn"));
        }
        nodes.push({
          id: elementId,
          name: element.attrib["name"] || elementId,
          type: elementType,
          category,
          process_id: processId,
          incoming: childTexts(element, "incoming"),
          outgoing: childTexts(element, "outgoing"),
          documentation: childText(element, "documentation"),
          event_definitions: eventDefinitions(element),
          lanes: [...(lanes.get(elementId) ?? [])],
          attributes: strippedAttributes(element, ["id", "name"]),
        });
      }

      const nodeById = new Map<string, BpmnNode>();
      for (const node of nodes) nodeById.set(node.id, node);

      for (const element of iterElements(process)) {
        if (localName(element.tag) !== "sequenceFlow") continue;
        const flowId = element.attrib["id"] || `flow-${flows.length + 1}`;
        if (!("id" in element.attrib)) {
          doc.findings.push(makeFinding(
            "missing_id",
            `流程 ${processId} 的 sequenceFlow 没有 id，临时使用 ${flowId}`,
            locatorOf(processId, "sequenceFlow", flowId), "warn"));
        }
        const source = element.attrib["sourceRef"] ?? "";
        const target = element.attrib["targetRef"] ?? "";
        flows.push({
          id: flowId,
          name: element.attrib["name"] || flowId,
          type: "sequenceFlow",
          process_id: processId,
          sourceRef: source,
          targetRef: target,
          condition: childText(element, "conditionExpression"),
          documentation: childText(element, "documentation"),
          attributes: strippedAttributes(
            element, ["id", "name", "sourceRef", "targetRef"]),
        });
        for (const [refName, ref] of [["sourceRef", source], ["targetRef", target]] as const) {
          if (!ref || !nodeById.has(ref)) {
            doc.findings.push(makeFinding(
              "dangling_reference",
              `sequenceFlow ${flowId} 的 ${refName}=${pyRepr(ref)} 未指向已解析节点`,
              locatorOf(processId, "sequenceFlow", flowId), "warn"));
          }
        }
      }

      const processData: BpmnProcess = {
        id: processId,
        name: processName,
        isExecutable: boolAttr(process.attrib["isExecutable"]),
        documentation: childText(process, "documentation"),
        nodes,
        sequenceFlows: flows,
      };
      processes.push(processData);
      allNodes.push(...nodes);
      allFlows.push(...flows);

      let processRender = `BPMN 流程 ${processName}（id=${processId}）：`
        + `${nodes.length} 个节点，${flows.length} 条 sequenceFlow`;
      if (processData.documentation) processRender += `。${processData.documentation}`;
      doc.chunks.push(makeChunk({
        docId: `bpmn:${processId}`, fileId, fileName,
        locator: locatorOf(processId, "process", processId),
        render: processRender, raw: processData, order, tags: ["bpmn", "process"],
      }));
      order += 1;

      for (const node of nodes) {
        const laneText = node.lanes.length > 0
          ? "；泳道=" + node.lanes.map((lane) => lane.name).join("、") : "";
        let relationText = "";
        if (node.incoming.length > 0) relationText += "；incoming=" + node.incoming.join("、");
        if (node.outgoing.length > 0) relationText += "；outgoing=" + node.outgoing.join("、");
        const docText = node.documentation ? `；说明=${node.documentation}` : "";
        const definitionText = node.event_definitions.length > 0
          ? "；事件定义=" + node.event_definitions.map((item) => item.type).join("、") : "";
        doc.chunks.push(makeChunk({
          docId: `bpmn:${processId}:${node.id}`, fileId, fileName,
          locator: locatorOf(processId, node.type, node.id),
          render: `BPMN ${node.category} ${node.name}（${node.type}，id=${node.id}）`
            + `；流程=${processName}${laneText}${relationText}${definitionText}${docText}`,
          raw: node, order, tags: ["bpmn", node.category, node.type],
        }));
        order += 1;
      }

      for (const flow of flows) {
        const sourceName = nodeById.get(flow.sourceRef)?.name ?? flow.sourceRef;
        const targetName = nodeById.get(flow.targetRef)?.name ?? flow.targetRef;
        const conditionText = flow.condition ? `；条件=${flow.condition}` : "";
        const labelText = flow.name !== flow.id ? `；名称=${flow.name}` : "";
        doc.chunks.push(makeChunk({
          docId: `bpmn:${processId}:${flow.id}`, fileId, fileName,
          locator: locatorOf(processId, "sequenceFlow", flow.id),
          render: `BPMN sequenceFlow ${flow.id}：${sourceName}`
            + `（${flow.sourceRef}） → ${targetName}（${flow.targetRef}）`
            + `${labelText}${conditionText}`,
          raw: flow, order,
          tags: flow.condition
            ? ["bpmn", "sequenceFlow", "relation", "rule"]
            : ["bpmn", "sequenceFlow", "relation"],
        }));
        order += 1;
      }
    }

    doc.structured = {
      processes,
      nodes: allNodes,
      sequenceFlows: allFlows,
    };
    if (processes.length === 0) {
      doc.findings.push(makeFinding(
        "no_processes", "BPMN 文件里没有 process", { kind: "xml", pointer: "/" }, "warn"));
    }
    return doc;
  }
}

function categoryOf(elementType: string): string | null {
  if (TASK_TYPES.has(elementType) || elementType.endsWith("Task")) return "task";
  if (EVENT_TYPES.has(elementType) || elementType.endsWith("Event")) return "event";
  if (GATEWAY_TYPES.has(elementType) || elementType.endsWith("Gateway")) return "gateway";
  return null;
}

/** `" ".join("".join(child.itertext()).split())` —— 换行和缩进在 XML 里没有语义。 */
function childText(element: XElement, childName: string): string {
  const child = childrenNamed(element, childName)[0];
  return child === undefined ? "" : pyNormalizeSpaces(itertext(child));
}

function childTexts(element: XElement, childName: string): string[] {
  return childrenNamed(element, childName)
    .map((child) => pyNormalizeSpaces(itertext(child)))
    .filter((text) => text);
}

function eventDefinitions(element: XElement): BpmnEventDefinition[] {
  const out: BpmnEventDefinition[] = [];
  for (const child of element.children) {
    const childType = localName(child.tag);
    if (!childType.endsWith("EventDefinition")) continue;
    out.push({
      type: childType,
      attributes: strippedAttributes(child, []),
      text: pyNormalizeSpaces(itertext(child)),
    });
  }
  return out;
}

/** 属性名去掉命名空间（`camunda:async` → `async`），并剔掉已经单列的那几个。 */
function strippedAttributes(element: XElement, skip: readonly string[]): Record<string, string> {
  const skipSet = new Set(skip);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.attrib)) {
    const local = localName(key);
    if (!skipSet.has(local)) out[local] = value;
  }
  return out;
}

function laneMembers(process: XElement): Map<string, BpmnLane[]> {
  const out = new Map<string, BpmnLane[]>();
  for (const lane of iterElements(process)) {
    if (localName(lane.tag) !== "lane") continue;
    const laneId = lane.attrib["id"] ?? "";
    const laneName = lane.attrib["name"] || laneId;
    for (const child of lane.children) {
      if (localName(child.tag) !== "flowNodeRef") continue;
      const ref = pyNormalizeSpaces(itertext(child));
      if (!ref) continue;
      const bucket = out.get(ref);
      if (bucket === undefined) out.set(ref, [{ id: laneId, name: laneName }]);
      else bucket.push({ id: laneId, name: laneName });
    }
  }
  return out;
}

function locatorOf(
  processId: string, elementType: string, elementId: string,
): Record<string, unknown> {
  let pointer = `/definitions/process[@id="${processId}"]`;
  if (elementType !== "process") pointer += `//${elementType}[@id="${elementId}"]`;
  return {
    kind: "xml",
    pointer,
    process: processId,
    element: elementType,
    id: elementId,
  };
}

/** 属性没写是 `null`，写了才看内容。`"TRUE"` 认，`"yes"` 不认 —— 照 Python 的判据。 */
function boolAttr(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const t = pyStrip(value).toLowerCase();
  return t === "true" || t === "1";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
