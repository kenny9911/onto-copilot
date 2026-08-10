"""L2 证据记忆 —— 原始材料的按需装载。

6 份材料展开可能上百万 token，**绝不全量装进上下文**。装载单元是带 locator 的
切片，按当前处理的实体名/列名做检索，取 top-k 再做邻域扩展（表格的上下文经常
在相邻行，只取命中行会丢掉表头和分组）。

这里用 BM25 而不是向量：本体建模的检索词是**专有名词**（`clmContract`、
`采购包头`、`plan_amount`），词形匹配比语义相似更准，而且零依赖、可解释、
能在事件日志里复现。生产上可以叠一层向量做召回补充，接口留在 :meth:`
EvidenceIndex.search` 的 ``rerank`` 钩子上。
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

_TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9]*|\d+|[㐀-鿿]")
_CAMEL_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def tokenize(text: str) -> list[str]:
    """分词 + camelCase 拆分。

    ``clmContract`` 要能被 ``contract`` 命中 —— 材料里物理名和业务名混用是常态。
    """
    out: list[str] = []
    for t in _TOKEN_RE.findall(text or ""):
        low = t.lower()
        out.append(low)
        if len(t) > 3 and _CAMEL_RE.search(t):
            out.extend(p.lower() for p in _CAMEL_RE.split(t))
        if "_" in low:
            out.extend(p for p in low.split("_") if p)
    return out


@dataclass(slots=True)
class Chunk:
    """一份材料的一个切片。

    ``locator`` 是这个产品的命脉：任何结论都要能点回原文的确切位置。
    格式见 :mod:`ontocopilot.onto.oir` 的 ``Provenance``。
    """

    chunk_id: str
    file_id: str
    file_name: str
    locator: dict[str, Any]
    render: str  # 给模型看的文本
    raw: Any = None  # 给代码用的结构
    order: int = 0  # 文件内序号，邻域扩展靠它
    tags: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        from .types import est_tokens

        return est_tokens(self.render)

    def cite(self) -> str:
        """人可读的引用串，进 prompt 时贴在切片前面。"""
        loc = self.locator
        match loc.get("kind"):
            case "cell":
                tail = f"!{loc.get('sheet', '')}!R{loc.get('row')}C{loc.get('col')}"
            case "range":
                rows = loc.get("rows", [0, 0])
                tail = f"!{loc.get('sheet', '')}!R{rows[0]}-{rows[1]}"
            case "json":
                tail = f"#{loc.get('pointer', '')}"
            case "ddl":
                tail = f"#{loc.get('object', '')}"
            case "page":
                tail = f"#p{loc.get('page')}"
            case "meta":
                tail = f"#{loc.get('field', '')}"
            case _:
                tail = ""
        return f"{self.file_name}{tail}"


class EvidenceIndex:
    """切片的 BM25 索引。"""

    K1 = 1.4
    B = 0.72

    def __init__(self) -> None:
        self._chunks: dict[str, Chunk] = {}
        self._tf: dict[str, Counter[str]] = {}
        self._df: Counter[str] = Counter()
        self._len: dict[str, int] = {}
        self._by_file: dict[str, list[str]] = defaultdict(list)
        self._avg_len = 0.0

    # ── 建索引 ──────────────────────────────────────────────────
    def add(self, chunk: Chunk) -> None:
        if chunk.chunk_id in self._chunks:
            return
        toks = tokenize(chunk.render) + tokenize(chunk.file_name)
        tf = Counter(toks)
        self._chunks[chunk.chunk_id] = chunk
        self._tf[chunk.chunk_id] = tf
        self._len[chunk.chunk_id] = len(toks)
        for t in tf:
            self._df[t] += 1
        self._by_file[chunk.file_id].append(chunk.chunk_id)
        self._avg_len = sum(self._len.values()) / max(1, len(self._len))

    def add_all(self, chunks: Iterable[Chunk]) -> None:
        for c in chunks:
            self.add(c)

    # ── 检索 ────────────────────────────────────────────────────
    def search(
        self,
        query: str,
        *,
        top_k: int = 20,
        files: Iterable[str] | None = None,
        expand: int = 1,
        budget_tokens: int | None = None,
        diversify_by_file: bool = True,
        rerank: Callable[[str, list[Chunk]], list[Chunk]] | None = None,
    ) -> list[Chunk]:
        """检索切片。

        Args:
            expand: 邻域半径。命中第 44 行时把 43/45 行也带上 —— 表格语义常常
                跨行（表头、合并单元格伪装的分组）。
            budget_tokens: 装载上限，超了就截断。**宁可少装也不能挤爆上下文。**
            diversify_by_file: 按文件轮转取结果，保证每个命中的文件都有代表。

                默认开，因为这个产品的核心价值依赖它：「计划金额」的两个口径分别
                在 xlsx 批注和 DDL 注释里，纯按分数取 top-k 时中文密集的切片会
                把 DDL 挤出去，跨文件冲突就永远发现不了。宁可牺牲一点单点精度，
                也要保证证据的**来源多样性**。
            rerank: 可选的二次排序钩子（向量重排、cross-encoder）。
        """
        allow = set(files) if files is not None else None
        q = Counter(tokenize(query))
        if not q or not self._chunks:
            return []

        n = len(self._chunks)
        scores: dict[str, float] = {}
        for cid, tf in self._tf.items():
            if allow is not None and self._chunks[cid].file_id not in allow:
                continue
            dl = self._len[cid] or 1
            s = 0.0
            for term, qc in q.items():
                f = tf.get(term, 0)
                if not f:
                    continue
                idf = math.log(1 + (n - self._df[term] + 0.5) / (self._df[term] + 0.5))
                denom = f + self.K1 * (1 - self.B + self.B * dl / max(1e-9, self._avg_len))
                s += idf * (f * (self.K1 + 1) / denom) * qc
            if s > 0:
                scores[cid] = s

        ranked = sorted(scores, key=lambda c: -scores[c])
        ranked = self._round_robin(ranked, top_k) if diversify_by_file else ranked[:top_k]
        hits = self._expand(ranked, expand) if expand else [self._chunks[c] for c in ranked]

        if rerank is not None:
            hits = rerank(query, hits)
        if budget_tokens is None:
            return hits

        out, spent = [], 0
        for c in hits:
            if spent + c.tokens > budget_tokens:
                continue
            out.append(c)
            spent += c.tokens
        return out

    def _round_robin(self, ranked: list[str], top_k: int) -> list[str]:
        """按文件轮转取结果，文件内保持原排名。

        效果是"每个命中的文件先拿一个名额，再按分数补齐"。这让检索结果天然带上
        来源多样性，而多样性正是跨文件冲突检测的前提。
        """
        buckets: dict[str, list[str]] = {}
        for cid in ranked:
            buckets.setdefault(self._chunks[cid].file_id, []).append(cid)
        # 文件之间按各自最高分排序，保证最相关的文件先出
        order = sorted(buckets, key=lambda f: ranked.index(buckets[f][0]))
        out: list[str] = []
        i = 0
        while len(out) < top_k and any(len(buckets[f]) > i for f in order):
            for f in order:
                if len(buckets[f]) > i:
                    out.append(buckets[f][i])
                    if len(out) >= top_k:
                        break
            i += 1
        return out

    def _expand(self, chunk_ids: list[str], radius: int) -> list[Chunk]:
        """按文件内序号做邻域扩展，保持原文顺序。"""
        picked: dict[str, None] = {}
        for cid in chunk_ids:
            c = self._chunks[cid]
            sibs = self._by_file[c.file_id]
            try:
                i = sibs.index(cid)
            except ValueError:
                picked.setdefault(cid, None)
                continue
            for j in range(max(0, i - radius), min(len(sibs), i + radius + 1)):
                picked.setdefault(sibs[j], None)
        chunks = [self._chunks[c] for c in picked]
        chunks.sort(key=lambda c: (c.file_id, c.order))
        return chunks

    # ── 渲染 ────────────────────────────────────────────────────
    @staticmethod
    def render(chunks: Iterable[Chunk]) -> str:
        """装进 prompt 的形态。每片都带引用，模型才有可能正确归因。"""
        return "\n\n".join(f"⟦{c.cite()}⟧\n{c.render}" for c in chunks)

    def get(self, chunk_id: str) -> Chunk | None:
        return self._chunks.get(chunk_id)

    def by_file(self, file_id: str) -> list[Chunk]:
        return [self._chunks[c] for c in self._by_file.get(file_id, ())]

    def __len__(self) -> int:
        return len(self._chunks)
