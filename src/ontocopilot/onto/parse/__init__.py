"""材料解析层 —— 异构文件 → 统一 Chunk。

用法::

    from ontocopilot.onto.parse import default_registry, build_index

    docs = default_registry().parse_all(["实体梳理.xlsx", "schema.ddl", "openapi.json"])
    index = build_index(docs)          # 灌进证据索引，抽取节点就能检索了

派发按扩展名，未知扩展名回退到纯文本解析器 —— **绝不静默跳过**。跳过一份材料
而不告诉任何人，是这类系统最阴的失败模式：产物看起来正常，只是少了一整个来源。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...kernel.memory.evidence import EvidenceIndex
from .api import OpenApiParser
from .base import Finding, ParsedDoc, Parser, ParserRegistry, make_chunk
from .bpmn import BpmnParser
from .presentation import PptxParser
from .sql import DdlParser
from .tabular import CsvParser, XlsxParser, infer_type, profile_column
from .text import DocxParser, TextParser
from .vision import VisionParser


def default_registry(
    *, sql_dialect: str | None = None, vision_gateway: Any = None,
    vision_prefer: str = "quality", vision_progress: Any = None,
) -> ParserRegistry:
    """内置解析器。顺序即优先级。

    Args:
        vision_gateway: :class:`~ontocopilot.kernel.catalog.SmartGateway`。
            不传时扫描件仍会被登记，但会在 findings 里明说"没有配置视觉网关，
            这份材料的内容完全没有进入产物" —— **不静默跳过**。
    """
    return (
        ParserRegistry()
        .register(XlsxParser())
        .register(CsvParser())
        .register(DdlParser(dialect=sql_dialect))
        .register(OpenApiParser())
        .register(BpmnParser())
        .register(PptxParser())
        .register(DocxParser())
        .register(VisionParser(vision_gateway, prefer=vision_prefer,
                               on_progress=vision_progress))
        .register(TextParser(), fallback=True)
    )


def build_index(docs: list[ParsedDoc], index: EvidenceIndex | None = None) -> EvidenceIndex:
    """把解析结果灌进证据索引。"""
    ix = EvidenceIndex() if index is None else index
    for d in docs:
        ix.add_all(d.chunks)
    return ix


def corpus_summary(docs: list[ParsedDoc]) -> dict[str, Any]:
    """给 FDE 看的解析概览。

    **findings 必须一并给出** —— 表头偏移、编码猜测、大表采样、元数据泄漏，
    每一条都可能改变他对产物的信任程度。
    """
    return {
        "files": [d.stats() for d in docs],
        "chunks": sum(len(d.chunks) for d in docs),
        "findings": [
            {"file": d.file_name, "kind": f.kind, "severity": f.severity,
             "message": f.message, "locator": f.locator}
            for d in docs for f in d.findings
        ],
    }


def collect_endpoints(docs: list[ParsedDoc]) -> list[dict[str, Any]]:
    """所有 OpenAPI 写操作端点 —— ActionType 反推的输入。"""
    return [e for d in docs for e in d.structured.get("endpoints", ()) if e.get("write")]


def collect_profiles(docs: list[ParsedDoc]) -> dict[str, dict[str, Any]]:
    """所有列画像，按 ``表名.列名`` 索引 —— TYPE_MISMATCH 检测的输入。

    这些统计由**确定性代码**产出。LLM 无法可靠发现需要跨行分布理解的问题
    （arXiv:2503.06664），这类检测绝不能交给模型。
    """
    out: dict[str, dict[str, Any]] = {}
    for d in docs:
        for sheet in d.structured.get("sheets", ()):
            for col, prof in (sheet.get("profile") or {}).items():
                out[f"{sheet['name']}.{col}"] = prof
        if prof := d.structured.get("profile"):
            for col, p in prof.items():
                out[f"{Path(d.file_name).stem}.{col}"] = p
    return out


__all__ = [
    "BpmnParser",
    "CsvParser",
    "DdlParser",
    "DocxParser",
    "Finding",
    "OpenApiParser",
    "ParsedDoc",
    "Parser",
    "ParserRegistry",
    "PptxParser",
    "TextParser",
    "VisionParser",
    "XlsxParser",
    "build_index",
    "collect_endpoints",
    "collect_profiles",
    "corpus_summary",
    "default_registry",
    "infer_type",
    "make_chunk",
    "profile_column",
]
