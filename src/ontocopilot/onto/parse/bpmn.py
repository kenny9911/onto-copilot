"""BPMN 2.0 XML -> 可检索、可追溯的流程证据。

前线材料里的 BPMN 文件通常比流程截图更有价值：节点 id、分支条件和连线关系都
是确定性结构，不该再交给模型从图片里猜。本解析器只读取建模所需的流程、活动、
事件、网关和 sequenceFlow；未知扩展保留在原文件中，但不会伪装成已解析内容。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from .base import Finding, ParsedDoc, Parser, make_chunk

_MAX_XML_BYTES = 20 * 1024 * 1024

_TASK_TYPES = frozenset({
    "task", "userTask", "serviceTask", "manualTask", "scriptTask",
    "businessRuleTask", "sendTask", "receiveTask", "callActivity", "subProcess",
})
_EVENT_TYPES = frozenset({
    "startEvent", "endEvent", "intermediateCatchEvent", "intermediateThrowEvent",
    "boundaryEvent",
})
_GATEWAY_TYPES = frozenset({
    "exclusiveGateway", "inclusiveGateway", "parallelGateway", "complexGateway",
    "eventBasedGateway",
})


class BpmnParser(Parser):
    """解析 ``.bpmn`` 和复合后缀 ``.bpmn20.xml``。"""

    kind = "bpmn"
    extensions = (".bpmn", ".bpmn20.xml")

    def accepts(self, path: Path) -> bool:
        """不把普通 ``.xml`` 抢过来；基础 ``Path.suffix`` 不认识复合后缀。"""
        name = path.name.lower()
        return name.endswith((".bpmn", ".bpmn20.xml"))

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        try:
            data = path.read_bytes()
        except OSError as exc:
            doc.findings.append(Finding(
                "parse_failed", f"无法读取 BPMN 文件：{exc}", {}, severity="warn"))
            return doc

        if len(data) > _MAX_XML_BYTES:
            doc.findings.append(Finding(
                "file_too_large",
                f"BPMN XML 大于 {_MAX_XML_BYTES // 1024 // 1024} MiB，已拒绝解析",
                {"kind": "xml", "pointer": "/"}, severity="warn"))
            return doc

        # ElementTree 不会主动取外部 DTD，但内部实体仍可能放大。BPMN 2.0 实例不需要
        # DTD，直接拒绝比尝试区分合法/恶意声明更稳妥。
        upper = data[: min(len(data), 64 * 1024)].upper()
        if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
            doc.findings.append(Finding(
                "unsafe_xml", "BPMN 含 DTD/ENTITY 声明，已为避免实体展开攻击而拒绝解析",
                {"kind": "xml", "pointer": "/"}, severity="warn"))
            return doc

        try:
            root = ET.fromstring(data)
        except ET.ParseError as exc:
            locator: dict[str, Any] = {"kind": "xml", "pointer": "/"}
            if getattr(exc, "position", None):
                locator["line"], locator["column"] = exc.position
            doc.findings.append(Finding(
                "parse_failed", f"BPMN XML 语法错误：{exc}", locator, severity="warn"))
            return doc

        root_name = _local(root.tag)
        namespace = _namespace(root.tag)
        doc.meta.update({
            "namespace": namespace,
            "definitions_id": root.attrib.get("id", ""),
            "target_namespace": root.attrib.get("targetNamespace", ""),
        })
        if root_name != "definitions":
            doc.findings.append(Finding(
                "unexpected_root", f"BPMN 根节点应为 definitions，实际为 {root_name!r}",
                {"kind": "xml", "pointer": f"/{root_name}"}, severity="warn"))

        processes: list[dict[str, Any]] = []
        all_nodes: list[dict[str, Any]] = []
        all_flows: list[dict[str, Any]] = []
        order = 0
        process_elements = [e for e in root.iter() if _local(e.tag) == "process"]
        for process_no, process in enumerate(process_elements, start=1):
            process_id = process.attrib.get("id") or f"process-{process_no}"
            process_name = process.attrib.get("name") or process_id
            if "id" not in process.attrib:
                doc.findings.append(Finding(
                    "missing_id", f"第 {process_no} 个 process 没有 id，临时使用 {process_id}",
                    _locator(process_id, "process", process_id), severity="warn"))

            lanes = _lane_members(process)
            nodes: list[dict[str, Any]] = []
            flows: list[dict[str, Any]] = []
            anonymous = 0
            for element in process.iter():
                element_type = _local(element.tag)
                category = _category(element_type)
                if category is None:
                    continue
                element_id = element.attrib.get("id")
                if not element_id:
                    anonymous += 1
                    element_id = f"anonymous-{category}-{anonymous}"
                    doc.findings.append(Finding(
                        "missing_id",
                        f"流程 {process_id} 的 {element_type} 没有 id，临时使用 {element_id}",
                        _locator(process_id, element_type, element_id), severity="warn"))
                node = {
                    "id": element_id,
                    "name": element.attrib.get("name") or element_id,
                    "type": element_type,
                    "category": category,
                    "process_id": process_id,
                    "incoming": _child_texts(element, "incoming"),
                    "outgoing": _child_texts(element, "outgoing"),
                    "documentation": _documentation(element),
                    "event_definitions": _event_definitions(element),
                    "lanes": lanes.get(element_id, []),
                    "attributes": {
                        _local(k): v for k, v in element.attrib.items()
                        if _local(k) not in {"id", "name"}
                    },
                }
                nodes.append(node)

            node_by_id = {node["id"]: node for node in nodes}
            for element in process.iter():
                if _local(element.tag) != "sequenceFlow":
                    continue
                flow_id = element.attrib.get("id") or f"flow-{len(flows) + 1}"
                if "id" not in element.attrib:
                    doc.findings.append(Finding(
                        "missing_id",
                        f"流程 {process_id} 的 sequenceFlow 没有 id，临时使用 {flow_id}",
                        _locator(process_id, "sequenceFlow", flow_id), severity="warn"))
                source = element.attrib.get("sourceRef", "")
                target = element.attrib.get("targetRef", "")
                condition = _child_text(element, "conditionExpression")
                flow = {
                    "id": flow_id,
                    "name": element.attrib.get("name") or flow_id,
                    "type": "sequenceFlow",
                    "process_id": process_id,
                    "sourceRef": source,
                    "targetRef": target,
                    "condition": condition,
                    "documentation": _documentation(element),
                    "attributes": {
                        _local(k): v for k, v in element.attrib.items()
                        if _local(k) not in {"id", "name", "sourceRef", "targetRef"}
                    },
                }
                flows.append(flow)
                for ref_name, ref in (("sourceRef", source), ("targetRef", target)):
                    if not ref or ref not in node_by_id:
                        doc.findings.append(Finding(
                            "dangling_reference",
                            f"sequenceFlow {flow_id} 的 {ref_name}={ref!r} 未指向已解析节点",
                            _locator(process_id, "sequenceFlow", flow_id), severity="warn"))

            process_data = {
                "id": process_id,
                "name": process_name,
                "isExecutable": _bool_attr(process.attrib.get("isExecutable")),
                "documentation": _documentation(process),
                "nodes": nodes,
                "sequenceFlows": flows,
            }
            processes.append(process_data)
            all_nodes.extend(nodes)
            all_flows.extend(flows)

            process_render = (
                f"BPMN 流程 {process_name}（id={process_id}）："
                f"{len(nodes)} 个节点，{len(flows)} 条 sequenceFlow"
            )
            if process_data["documentation"]:
                process_render += f"。{process_data['documentation']}"
            doc.chunks.append(make_chunk(
                doc_id=f"bpmn:{process_id}", file_id=file_id, file_name=path.name,
                locator=_locator(process_id, "process", process_id),
                render=process_render, raw=process_data, order=order,
                tags=["bpmn", "process"]))
            order += 1

            for node in nodes:
                lane_text = "；泳道=" + "、".join(
                    lane["name"] for lane in node["lanes"]) if node["lanes"] else ""
                relation_text = ""
                if node["incoming"]:
                    relation_text += "；incoming=" + "、".join(node["incoming"])
                if node["outgoing"]:
                    relation_text += "；outgoing=" + "、".join(node["outgoing"])
                doc_text = f"；说明={node['documentation']}" if node["documentation"] else ""
                definition_text = (
                    "；事件定义="
                    + "、".join(item["type"] for item in node["event_definitions"])
                    if node["event_definitions"] else ""
                )
                doc.chunks.append(make_chunk(
                    doc_id=f"bpmn:{process_id}:{node['id']}", file_id=file_id,
                    file_name=path.name,
                    locator=_locator(process_id, node["type"], node["id"]),
                    render=(f"BPMN {node['category']} {node['name']}"
                            f"（{node['type']}，id={node['id']}）"
                            f"；流程={process_name}{lane_text}{relation_text}"
                            f"{definition_text}{doc_text}"),
                    raw=node, order=order, tags=["bpmn", node["category"], node["type"]]))
                order += 1

            for flow in flows:
                source_name = node_by_id.get(flow["sourceRef"], {}).get("name", flow["sourceRef"])
                target_name = node_by_id.get(flow["targetRef"], {}).get("name", flow["targetRef"])
                condition_text = f"；条件={flow['condition']}" if flow["condition"] else ""
                label_text = (f"；名称={flow['name']}"
                              if flow["name"] != flow["id"] else "")
                doc.chunks.append(make_chunk(
                    doc_id=f"bpmn:{process_id}:{flow['id']}", file_id=file_id,
                    file_name=path.name,
                    locator=_locator(process_id, "sequenceFlow", flow["id"]),
                    render=(f"BPMN sequenceFlow {flow['id']}：{source_name}"
                            f"（{flow['sourceRef']}） → {target_name}（{flow['targetRef']}）"
                            f"{label_text}{condition_text}"),
                    raw=flow, order=order,
                    tags=["bpmn", "sequenceFlow", "relation"]
                         + (["rule"] if flow["condition"] else [])))
                order += 1

        doc.structured = {
            "processes": processes,
            "nodes": all_nodes,
            "sequenceFlows": all_flows,
        }
        if not processes:
            doc.findings.append(Finding(
                "no_processes", "BPMN 文件里没有 process", {"kind": "xml", "pointer": "/"},
                severity="warn"))
        return doc


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _namespace(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if tag.startswith("{") and "}" in tag else ""


def _category(element_type: str) -> str | None:
    if element_type in _TASK_TYPES or element_type.endswith("Task"):
        return "task"
    if element_type in _EVENT_TYPES or element_type.endswith("Event"):
        return "event"
    if element_type in _GATEWAY_TYPES or element_type.endswith("Gateway"):
        return "gateway"
    return None


def _child_text(element: ET.Element, child_name: str) -> str:
    for child in element:
        if _local(child.tag) == child_name:
            return " ".join("".join(child.itertext()).split())
    return ""


def _child_texts(element: ET.Element, child_name: str) -> list[str]:
    return [text for child in element if _local(child.tag) == child_name
            and (text := " ".join("".join(child.itertext()).split()))]


def _documentation(element: ET.Element) -> str:
    return _child_text(element, "documentation")


def _event_definitions(element: ET.Element) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for child in element:
        child_type = _local(child.tag)
        if not child_type.endswith("EventDefinition"):
            continue
        out.append({
            "type": child_type,
            "attributes": {_local(key): value for key, value in child.attrib.items()},
            "text": " ".join("".join(child.itertext()).split()),
        })
    return out


def _lane_members(process: ET.Element) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    for lane in process.iter():
        if _local(lane.tag) != "lane":
            continue
        lane_id = lane.attrib.get("id", "")
        lane_name = lane.attrib.get("name") or lane_id
        for child in lane:
            if _local(child.tag) != "flowNodeRef":
                continue
            ref = " ".join("".join(child.itertext()).split())
            if ref:
                out.setdefault(ref, []).append({"id": lane_id, "name": lane_name})
    return out


def _locator(process_id: str, element_type: str, element_id: str) -> dict[str, Any]:
    pointer = f'/definitions/process[@id="{process_id}"]'
    if element_type != "process":
        pointer += f'//{element_type}[@id="{element_id}"]'
    return {
        "kind": "xml",
        "pointer": pointer,
        "process": process_id,
        "element": element_type,
        "id": element_id,
    }


def _bool_attr(value: str | None) -> bool | None:
    if value is None:
        return None
    return value.strip().lower() in {"true", "1"}
