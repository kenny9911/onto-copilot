"""BPMN ``ParsedDoc`` -> :class:`FlowGraph` 的确定性桥接。

BPMN 已经是一张结构化流程图：让模型再从切片里抽一遍不仅慢，还会丢节点 id、条件
和泳道。本模块只做无损映射；任何 BPMN 引用都保留为 XML provenance。
"""

from __future__ import annotations

from typing import Any

from .flow import EdgeKind, FlowEdge, FlowGraph, FlowNode, NodeKind, Stage, Workflow
from .oir import Provenance, Status, extracted, make_rid


def flow_from_bpmn_docs(docs: list[Any]) -> FlowGraph | None:
    """把一批 BPMN ``ParsedDoc`` 合并为一张图；没有 BPMN 节点则返回 ``None``。"""
    bpmn_docs = [doc for doc in docs if getattr(doc, "kind", "") == "bpmn"]
    if not bpmn_docs:
        return None

    graph = FlowGraph()
    node_ids: dict[tuple[str, str, str], str] = {}
    process_stage: dict[tuple[str, str], str] = {}
    stage_order = 0

    for doc in bpmn_docs:
        for process in (getattr(doc, "structured", {}) or {}).get("processes", ()):
            if not isinstance(process, dict):
                continue
            process_id = str(process.get("id") or "process")
            process_name = str(process.get("name") or process_id)
            process_key = (doc.file_id, process_id)
            base_stage = _unique_key(graph.stages, make_rid(
                "stage", f"{doc.file_id}:{process_id}"))
            process_stage[process_key] = base_stage
            graph.stages[base_stage] = Stage(
                key=base_stage, title=process_name,
                subtitle=f"BPMN process · {doc.file_name}", order=stage_order)
            stage_order += 1

            for raw in process.get("nodes", ()):
                if not isinstance(raw, dict):
                    continue
                element_id = str(raw.get("id") or "")
                if not element_id:
                    continue
                category = str(raw.get("category") or "")
                kind = _node_kind(category, str(raw.get("type") or ""))
                rid = _unique_key(graph.nodes, make_rid(
                    "fn", f"{doc.file_id}:{process_id}:{element_id}"))
                node_ids[(doc.file_id, process_id, element_id)] = rid
                stage = _lane_stage(
                    graph, doc=doc, process_id=process_id, process_name=process_name,
                    lanes=raw.get("lanes") or [], fallback=base_stage, order=stage_order)
                if stage not in graph.stages:
                    stage = base_stage
                elif stage != base_stage and graph.stages[stage].order >= stage_order:
                    stage_order = graph.stages[stage].order + 1
                prov = _provenance(
                    doc, process_id=process_id, element_type=str(raw.get("type") or category),
                    element_id=element_id,
                    snippet=_node_snippet(raw, process_name),
                )
                actor = "、".join(
                    str(lane.get("name") or lane.get("id") or "")
                    for lane in raw.get("lanes", ()) if isinstance(lane, dict))
                node = FlowNode(
                    rid=rid, kind=kind,
                    label=extracted(str(raw.get("name") or element_id), prov, confidence=1.0),
                    stage=stage,
                    actor=extracted(actor, prov, confidence=1.0) if actor else extracted(
                        "", prov, confidence=1.0),
                    status=Status.CANDIDATE,
                )
                graph.add_node(node)

            entries: list[str] = []
            exits: list[str] = []
            for raw in process.get("nodes", ()):
                if not isinstance(raw, dict):
                    continue
                rid = node_ids.get((doc.file_id, process_id, str(raw.get("id") or "")))
                if not rid:
                    continue
                element_type = str(raw.get("type") or "")
                if element_type == "startEvent":
                    entries.append(rid)
                if element_type == "endEvent":
                    exits.append(rid)
            workflow_key = _unique_key(graph.workflows, make_rid(
                "wf", f"{doc.file_id}:{process_id}"))
            graph.workflows[workflow_key] = Workflow(
                key=workflow_key, title=process_name,
                entry=entries[0] if entries else "", exits=exits,
                description=str(process.get("documentation") or ""),
            )

    for doc in bpmn_docs:
        for process in (getattr(doc, "structured", {}) or {}).get("processes", ()):
            if not isinstance(process, dict):
                continue
            process_id = str(process.get("id") or "process")
            for raw in process.get("sequenceFlows", ()):
                if not isinstance(raw, dict):
                    continue
                flow_id = str(raw.get("id") or "flow")
                source = node_ids.get((doc.file_id, process_id, str(raw.get("sourceRef") or "")))
                target = node_ids.get((doc.file_id, process_id, str(raw.get("targetRef") or "")))
                if not source or not target:
                    # Parser 已给出 dangling_reference finding；不在图里伪造无来源节点。
                    continue
                condition = str(raw.get("condition") or "").strip()
                name = str(raw.get("name") or "").strip()
                label = condition or (name if name != flow_id else "")
                prov = _provenance(
                    doc, process_id=process_id, element_type="sequenceFlow",
                    element_id=flow_id,
                    snippet=(f"{raw.get('sourceRef', '')} -> {raw.get('targetRef', '')}"
                             + (f"；{label}" if label else "")),
                )
                edge_rid = _unique_key(graph.edges, make_rid(
                    "fe", f"{doc.file_id}:{process_id}:{flow_id}"))
                graph.add_edge(FlowEdge(
                    rid=edge_rid, source=source, target=target,
                    kind=EdgeKind.CONDITIONAL if label else EdgeKind.FLOW,
                    label=label, evidence=[prov],
                ))

    return graph if graph.nodes else None


def _node_kind(category: str, element_type: str) -> NodeKind:
    if category == "gateway" or element_type.endswith("Gateway"):
        return NodeKind.GATEWAY
    if category == "event" or element_type.endswith("Event"):
        return NodeKind.TERMINAL if element_type == "endEvent" else NodeKind.EVENT
    return NodeKind.ACTION


def _lane_stage(
    graph: FlowGraph, *, doc: Any, process_id: str, process_name: str,
    lanes: list[Any], fallback: str, order: int,
) -> str:
    lane = next((item for item in lanes if isinstance(item, dict)), None)
    if lane is None:
        return fallback
    lane_id = str(lane.get("id") or lane.get("name") or "lane")
    lane_name = str(lane.get("name") or lane_id)
    key = make_rid("stage", f"{doc.file_id}:{process_id}:lane:{lane_id}")
    if key not in graph.stages:
        graph.stages[key] = Stage(
            key=key, title=lane_name,
            subtitle=f"{process_name} · BPMN lane · {doc.file_name}", order=order)
    return key


def _provenance(
    doc: Any, *, process_id: str, element_type: str, element_id: str, snippet: str,
) -> Provenance:
    return Provenance(
        file_id=str(doc.file_id), file_name=str(doc.file_name),
        locator={
            "kind": "xml",
            "pointer": (f'/definitions/process[@id="{process_id}"]'
                        + ("" if element_type == "process" else
                           f'//{element_type}[@id="{element_id}"]')),
            "process": process_id,
            "element": element_type,
            "id": element_id,
        },
        snippet=snippet[:300], extractor="bpmn", confidence=1.0,
    )


def _node_snippet(raw: dict[str, Any], process_name: str) -> str:
    bits = [str(raw.get("name") or raw.get("id") or ""), str(raw.get("type") or ""),
            f"process={process_name}"]
    if raw.get("documentation"):
        bits.append(str(raw["documentation"]))
    return "；".join(bit for bit in bits if bit)


def _unique_key(items: dict[str, Any], base: str) -> str:
    if base not in items:
        return base
    suffix = 2
    while f"{base}_{suffix}" in items:
        suffix += 1
    return f"{base}_{suffix}"
