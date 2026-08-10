"""解析层的公共契约。

所有解析器输出同一种东西：带 :class:`~ontocopilot.kernel.memory.evidence.Chunk`
的 :class:`ParsedDoc`。下游抽取器只认 Chunk，**不认文件格式** —— 这条边界让
"加一种新格式"变成写一个解析器，而不是改抽取逻辑。

每个 Chunk 必须带 locator。没有 locator 的切片进不了索引 —— 因为它产生的任何
结论都无法溯源，而无法溯源的结论在这个产品里没有价值。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ...kernel.ids import sha256_hex
from ...kernel.memory.evidence import Chunk


@dataclass(slots=True)
class Finding:
    """解析过程中发现的、值得报给用户的事。

    最典型的是文档元数据泄漏：Office 文件默认携带作者名和绝对保存路径，
    对外发布前该清一遍。这不是解析错误，但它是 FDE 真正需要知道的信息。
    """

    kind: str  # metadata_leak | unparsed_sheet | encoding_guess | ...
    message: str
    locator: dict[str, Any] = field(default_factory=dict)
    severity: str = "info"  # info | warn


@dataclass(slots=True)
class ParsedDoc:
    """一份材料的解析结果。"""

    file_id: str
    file_name: str
    kind: str  # xlsx | csv | ddl | openapi | docx | text
    chunks: list[Chunk] = field(default_factory=list)
    #: 结构化产物，按解析器类型不同：表格给 sheets，DDL 给 tables，OpenAPI 给 endpoints
    structured: dict[str, Any] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def stats(self) -> dict[str, Any]:
        return {
            "file": self.file_name, "kind": self.kind, "chunks": len(self.chunks),
            "findings": len(self.findings),
            **{k: len(v) if isinstance(v, (list, dict)) else v
               for k, v in self.structured.items() if k != "raw"},
        }


class Parser(ABC):
    """一种格式的解析器。"""

    kind: str = "text"
    extensions: tuple[str, ...] = ()

    @abstractmethod
    def parse(self, path: Path, *, file_id: str) -> ParsedDoc: ...

    async def aparse(self, path: Path, *, file_id: str) -> ParsedDoc:
        """异步入口。默认转同步实现；需要调模型的解析器（OCR）覆盖它。"""
        return self.parse(path, file_id=file_id)

    def accepts(self, path: Path) -> bool:
        return path.suffix.lower() in self.extensions


class ParserRegistry:
    """按扩展名派发。未知扩展名回退到纯文本 —— **不静默跳过**。

    跳过一份材料而不告诉任何人，是这类系统最阴的失败模式：产物看起来正常，
    只是少了一整个来源。
    """

    def __init__(self) -> None:
        self._parsers: list[Parser] = []
        self._fallback: Parser | None = None

    def register(self, parser: Parser, *, fallback: bool = False) -> ParserRegistry:
        self._parsers.append(parser)
        if fallback:
            self._fallback = parser
        return self

    def for_path(self, path: Path) -> Parser:
        for p in self._parsers:
            if p.accepts(path):
                return p
        if self._fallback is None:
            raise ValueError(f"没有能处理 {path.suffix!r} 的解析器，也没有配置兜底解析器")
        return self._fallback

    def parse(self, path: Path | str, *, file_id: str | None = None) -> ParsedDoc:
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(p)
        fid = file_id or f"f_{sha256_hex(p.name)[:8]}"
        return self.for_path(p).parse(p, file_id=fid)

    def parse_all(self, paths: list[Path | str]) -> list[ParsedDoc]:
        return [self.parse(p) for p in paths]

    async def aparse(self, path: Path | str, *, file_id: str | None = None) -> ParsedDoc:
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(p)
        fid = file_id or f"f_{sha256_hex(p.name)[:8]}"
        return await self.for_path(p).aparse(p, file_id=fid)

    async def aparse_all(self, paths: list[Path | str]) -> list[ParsedDoc]:
        """异步解析全部材料。

        扫描件要调模型，所以整条链路要有异步入口 —— 否则只能悄悄跳过扫描件，
        而那是"产物看起来正常，只是少了一整个来源"的经典失败。
        """
        return [await self.aparse(p) for p in paths]


def make_chunk(
    *, doc_id: str, file_id: str, file_name: str, locator: dict[str, Any],
    render: str, raw: Any = None, order: int = 0, tags: list[str] | None = None,
) -> Chunk:
    return Chunk(
        chunk_id=f"{file_id}:{doc_id}", file_id=file_id, file_name=file_name,
        locator=locator, render=render, raw=raw, order=order, tags=tags or [],
    )
