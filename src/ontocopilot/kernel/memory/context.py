"""ContextManager —— 四层记忆的装配。

    L0 System      角色 + 建模规范 + 命名词典        常驻，已压缩成规则表
    L1 Working     上游节点产出 + 本节点 scratchpad   全量（超预算则压缩）
    L2 Evidence    原始材料切片                      **按需检索**，弹性层
    L3 Reflection  本 Run 内 critic 沉淀的教训 + 长期记忆召回   全量（体量小）

装配顺序即优先级：L0 → L3 → L1 → L2。前三层是"必须知道的"，证据层拿剩下的
额度 —— 因为证据永远装不完，而且少装几片的代价远小于挤掉规范或教训。

超预算时的处置顺序也是设计好的：先压 scratchpad（节点内过程，信息密度最低），
再截上游产出的长文本字段，最后才削证据。**任何时候都不动 locator。**
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .evidence import Chunk, EvidenceIndex
from .long_term import LongTermStore
from .short_term import Scratchpad, WorkingSet
from .types import MemoryItem, MemoryKind, est_tokens


@dataclass(frozen=True, slots=True)
class LayerShares:
    """各层的预算占比。证据层不列 —— 它拿剩下的全部。"""

    system: float = 0.12
    reflection: float = 0.10
    working: float = 0.38
    #: 证据层最少要留这么多，否则这个节点根本没法做归因。
    evidence_floor: float = 0.20


@dataclass(slots=True)
class RenderedContext:
    """装配结果。"""

    text: str
    layers: dict[str, str] = field(default_factory=dict)
    tokens: dict[str, int] = field(default_factory=dict)
    chunks: list[Chunk] = field(default_factory=list)
    recalled: list[MemoryItem] = field(default_factory=list)
    compactions: int = 0
    dropped: list[str] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return sum(self.tokens.values())

    def stats(self) -> dict[str, Any]:
        return {
            "total_tokens": self.total_tokens,
            "layers": dict(self.tokens),
            "chunks": len(self.chunks),
            "recalled": len(self.recalled),
            "compactions": self.compactions,
            "dropped": self.dropped,
        }


class ContextManager:
    """把四层记忆装配成一份 prompt 上下文。

    Args:
        system: L0 常驻内容（角色、Ontology 原语定义、项目建模规范）。
        long_term: 长期记忆库，可为 None（首个 Run 冷启动）。
        evidence: 证据索引。
        budget_tokens: 单次装配的总预算。
    """

    def __init__(
        self,
        *,
        system: str = "",
        long_term: LongTermStore | None = None,
        evidence: EvidenceIndex | None = None,
        budget_tokens: int = 120_000,
        shares: LayerShares | None = None,
    ) -> None:
        self.system = system
        self.long_term = long_term
        # `is None` 而不是 `or` —— EvidenceIndex 定义了 __len__，空索引是 falsy。
        # 用 `or` 会在"先建空索引、再往里灌切片"这个常见顺序下静默丢掉索引。
        self.evidence = EvidenceIndex() if evidence is None else evidence
        self.budget_tokens = budget_tokens
        self.shares = shares or LayerShares()
        self._reflections: list[str] = []

    # ── L3 写入 ─────────────────────────────────────────────────
    def reflect(self, lesson: str) -> None:
        """Reflexion：把 critic 反馈沉淀成本 Run 内的教训。

        同一 Run 后续节点会看到它，从而不再犯同样的错。是否升入长期库由
        :class:`~.long_term.PromotionGate` 决定 —— 这里只管短期。
        """
        if lesson and lesson not in self._reflections:
            self._reflections.append(lesson)

    @property
    def reflections(self) -> list[str]:
        return list(self._reflections)

    # ── 装配 ────────────────────────────────────────────────────
    def assemble(
        self,
        *,
        task: str,
        query: str = "",
        working: WorkingSet | None = None,
        deps: list[str] | None = None,
        scratch: Scratchpad | None = None,
        run_id: str = "",
        evidence_files: list[str] | None = None,
        evidence_top_k: int = 24,
        budget_tokens: int | None = None,
        recall_kinds: tuple[MemoryKind, ...] | None = None,
        current_files: set[str] | None = None,
    ) -> RenderedContext:
        """装配上下文。

        Args:
            task: 本节点的任务描述，进 L0 尾部。
            query: 证据检索与长期记忆召回的查询串，默认用 task。
            deps: 上游节点 id，支持 ``PARSE.*`` 通配。
            current_files: 本轮在看的材料名。只影响参考档记忆：跨材料的那些会被
                降权并在 prompt 里标出来。不传 = 不做这层判断。
        """
        q = query or task
        # 节点可以给更紧的预算。抽取类节点的正文已经很长，再按全局预算灌证据
        # 会让单次输入涨好几倍，而多出来的部分往往是同一批切片。
        budget = min(self.budget_tokens, budget_tokens or self.budget_tokens)
        ctx = RenderedContext(text="")

        # ── L0 System ───────────────────────────────────────────
        sys_budget = int(budget * self.shares.system)
        sys_text = _clip(f"{self.system}\n\n## 当前任务\n{task}".strip(), sys_budget)
        ctx.layers["L0_system"] = sys_text
        ctx.tokens["L0_system"] = est_tokens(sys_text)

        # ── L3 Reflection：本 Run 教训 + 长期记忆召回 ─────────────
        refl_budget = int(budget * self.shares.reflection)
        recalled: list[MemoryItem] = []
        if self.long_term is not None:
            recalled = self.long_term.recall(
                q,
                run_id=run_id,
                kinds=recall_kinds,
                limit=10,
                budget_tokens=int(refl_budget * 0.6),
                current_files=current_files,
            )
        # 参考档的来源标注由 render 放在**内容前面** —— 下面这段会被整体 _clip，
        # 写在条目末尾的标注会被切掉，只剩一句看着像事实的断言。
        lines = [
            f"· {m.render(foreign_material=m.from_other_material(current_files))}"
            for m in recalled
        ]
        lines += [f"· 本轮教训：{r}" for r in self._reflections]
        refl_text = _clip("\n".join(lines), refl_budget)
        ctx.layers["L3_reflection"] = refl_text
        ctx.tokens["L3_reflection"] = est_tokens(refl_text)
        ctx.recalled = recalled

        # ── L1 Working：上游产出 + scratchpad ────────────────────
        work_budget = int(budget * self.shares.working)
        upstream = working.select(deps or []) if working else {}
        up_text = _render_upstream(upstream, work_budget - (scratch.tokens if scratch else 0))
        pad_text = ""
        if scratch is not None:
            if scratch.over_budget():
                ctx.compactions += scratch.compact_to_fit()
            pad_text = scratch.render()
        work_text = "\n\n".join(x for x in (up_text, pad_text) if x)
        if est_tokens(work_text) > work_budget:
            work_text = _clip(work_text, work_budget)
            ctx.dropped.append("working:truncated")
        ctx.layers["L1_working"] = work_text
        ctx.tokens["L1_working"] = est_tokens(work_text)

        # ── L2 Evidence：拿剩下的全部，但有地板 ──────────────────
        used = sum(ctx.tokens.values())
        ev_budget = max(int(budget * self.shares.evidence_floor), budget - used)
        if used + ev_budget > budget:
            # 前三层挤占了证据地板 —— 削 working 而不是削证据
            over = used + ev_budget - budget
            ctx.layers["L1_working"] = _clip(
                ctx.layers["L1_working"], max(0, ctx.tokens["L1_working"] - over)
            )
            ctx.tokens["L1_working"] = est_tokens(ctx.layers["L1_working"])
            ctx.dropped.append(f"working:-{over}tok(保证据地板)")

        chunks = self.evidence.search(
            q,
            top_k=evidence_top_k,
            files=evidence_files,
            expand=1,
            budget_tokens=ev_budget,
        )
        ev_text = EvidenceIndex.render(chunks)
        ctx.layers["L2_evidence"] = ev_text
        ctx.tokens["L2_evidence"] = est_tokens(ev_text)
        ctx.chunks = chunks

        ctx.text = _join(ctx.layers)
        return ctx


# ── 渲染辅助 ────────────────────────────────────────────────────
_HEADERS = {
    "L0_system": "",
    "L3_reflection": "## 已知约定与教训",
    "L1_working": "## 上游产出",
    "L2_evidence": "## 证据切片（每片带出处，引用时必须带上）",
}


def _join(layers: dict[str, str]) -> str:
    parts = []
    for key in ("L0_system", "L3_reflection", "L1_working", "L2_evidence"):
        body = layers.get(key, "").strip()
        if not body:
            continue
        head = _HEADERS.get(key, "")
        parts.append(f"{head}\n{body}".strip() if head else body)
    return "\n\n".join(parts)


def _clip(text: str, max_tokens: int) -> str:
    """按 token 预算截断。宁可截断也不能超预算 —— 超了是硬失败。"""
    if max_tokens <= 0:
        return ""
    if est_tokens(text) <= max_tokens:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if est_tokens(text[:mid]) <= max_tokens:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + " …[已截断]"


def _render_upstream(upstream: dict[str, Any], budget: int) -> str:
    """上游产出渲染。按节点均分预算，避免某个大产出把别的挤没。"""
    if not upstream:
        return ""
    import json

    per = max(200, budget // max(1, len(upstream)))
    parts = []
    for nid, out in upstream.items():
        body = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
        parts.append(f"### ← {nid}\n{_clip(body, per)}")
    return "\n\n".join(parts)
