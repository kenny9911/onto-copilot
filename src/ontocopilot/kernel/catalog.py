"""模型能力目录与按能力路由。

聚合网关上挂着几十个模型，能力参差：有的能读图，有的不支持 ``response_format``，
有的没有 ``effort``。**按名字硬编码路由会在换模型时静默坏掉** —— 请求照发，只是
某个能力悄悄没了（比如 OCR 变成了「模型看不见图，凭字段名瞎猜」）。

所以这里把路由的单位从"模型名"换成"**所需能力**"：调用方声明"我要能读图 + 要
结构化输出"，目录给出**有序候选**，网关逐个试直到成功。

能力从三处合成，后者覆盖前者：

1. 内置声明（``CARDS``）—— 已知模型的静态事实；
2. 运行时发现 —— ``/v1/models`` 的 ``supported_endpoint_types`` 等元数据；
3. **失败学习** —— 网关明确回「不支持图片输入」时，把该能力从这个模型上抹掉，
   本进程内不再浪费一次往返。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any

from .llm import ModelSpec


class Capability(StrEnum):
    VISION = "vision"  # 能读图（OCR / 扫描件 / 截图）
    STRUCTURED = "structured"  # 支持 response_format.json_schema
    EFFORT = "effort"  # 支持 reasoning.effort
    LONG_CONTEXT = "long_context"  # ≥ 200k
    CHEAP = "cheap"  # 单位成本低，适合大批量粗活


@dataclass(frozen=True, slots=True)
class ModelCard:
    """一个模型的能力与定位。"""

    spec: ModelSpec
    capabilities: frozenset[Capability]
    #: 主观质量档 1~5。同样能力下优先高档，除非调用方明确要便宜的。
    quality: int = 3
    #: 提供方，用于异构评委去重（同厂商的模型不算异构）。
    vendor: str = ""

    @property
    def name(self) -> str:
        return self.spec.name

    def has(self, needs: frozenset[Capability] | set[Capability]) -> bool:
        return set(needs) <= self.capabilities

    def without(self, cap: Capability) -> ModelCard:
        return replace(self, capabilities=self.capabilities - {cap})

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "vendor": self.vendor, "quality": self.quality,
                "effort": self.spec.effort,
                "capabilities": sorted(str(c) for c in self.capabilities)}


C = Capability
_ALL = frozenset({C.VISION, C.STRUCTURED, C.EFFORT, C.LONG_CONTEXT})


def _card(name, vendor, quality, caps, *, effort="high", thinking=True,
          pin=3.0, pout=15.0) -> ModelCard:
    return ModelCard(
        spec=ModelSpec(name, "mid" if quality <= 3 else "frontier", pin, pout,
                       effort=effort if C.EFFORT in caps else None,
                       thinking=thinking if C.EFFORT in caps else None),
        capabilities=frozenset(caps), quality=quality, vendor=vendor)


#: 内置声明。只写**确认过**的能力 —— 猜错一个能力的代价是运行时静默降级。
CARDS: list[ModelCard] = [
    # Anthropic：视觉与结构化输出都实测过
    _card("anthropic/claude-opus-4.8", "anthropic", 5, _ALL, pin=5, pout=25),
    _card("anthropic/claude-sonnet-5", "anthropic", 4, _ALL, effort="medium",
          pin=3, pout=15),
    _card("anthropic/claude-haiku-4.5", "anthropic", 2,
          {C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP}, pin=1, pout=5),
    # OpenAI：跨厂商评委的主力
    _card("openai/gpt-5.5", "openai", 5, _ALL, pin=5, pout=25),
    _card("openai/gpt-5.4-mini", "openai", 2,
          {C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP}, pin=0.5, pout=2),
    # Google：视觉强、便宜，适合批量 OCR
    _card("google/gemini-3.5-flash", "google", 3,
          {C.VISION, C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP}, pin=1, pout=4),
    _card("google/gemini-3.1-pro-preview", "google", 4,
          {C.VISION, C.STRUCTURED, C.LONG_CONTEXT}, pin=3, pout=12),
    # 纯文本模型：**明确不带 VISION** —— 实测 deepseek 会返回
    # "No endpoints found that support image input"
    _card("deepseek/deepseek-v3.2", "deepseek", 3,
          {C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP}, effort=None, pin=0.3, pout=1.2),
    _card("moonshotai/kimi-k2.6", "moonshot", 3,
          {C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP}, effort=None, pin=0.6, pout=2.5),
    _card("z-ai/glm-5.2", "zhipu", 3, {C.STRUCTURED, C.LONG_CONTEXT, C.CHEAP},
          effort=None, pin=0.5, pout=2),
]

#: 网关回这些话时，说明该模型确实缺某项能力，可以直接从目录里抹掉。
_CAPABILITY_DENIALS: tuple[tuple[re.Pattern[str], Capability], ...] = (
    (re.compile(r"support\s+image|image\s+input|vision|multimodal", re.I), C.VISION),
    (re.compile(r"response_format|json_schema|structured", re.I), C.STRUCTURED),
    (re.compile(r"reasoning|\beffort\b", re.I), C.EFFORT),
)


def denial_capability(error_text: str) -> Capability | None:
    """从错误文本判断"缺的是哪项能力"。判不出来返回 None（那就是别的故障）。"""
    if not error_text or not re.search(r"not\s+support|unsupported|no\s+endpoints|"
                                       r"不支持|invalid", error_text, re.I):
        return None
    for pattern, cap in _CAPABILITY_DENIALS:
        if pattern.search(error_text):
            return cap
    return None


class ModelCatalog:
    """能力目录。按能力选模型，按失败学习。"""

    def __init__(self, cards: list[ModelCard] | None = None) -> None:
        self._cards: dict[str, ModelCard] = {c.name: c for c in (cards or CARDS)}
        self.notes: list[str] = []

    # ── 选型 ────────────────────────────────────────────────────
    def select(
        self,
        needs: set[Capability] | frozenset[Capability] = frozenset(),
        *,
        prefer: str = "quality",  # quality | cost
        limit: int = 4,
        exclude_vendors: set[str] = frozenset(),
    ) -> list[ModelCard]:
        """按能力挑出**有序候选**。

        返回列表而不是单个 —— 网关会逐个试。只给一个，遇到临时故障就只能整体失败。
        """
        pool = [c for c in self._cards.values()
                if c.has(needs) and c.vendor not in exclude_vendors]
        if prefer == "cost":
            pool.sort(key=lambda c: (c.spec.usd_per_mtok_out, -c.quality))
        else:
            pool.sort(key=lambda c: (-c.quality, c.spec.usd_per_mtok_out))
        return pool[:limit]

    def require(self, needs: set[Capability], **kw: Any) -> list[ModelCard]:
        """同 :meth:`select`，但一个都挑不出来时**报错而不是静默降级**。

        静默降级意味着"OCR 悄悄变成了凭字段名瞎猜"，产物看起来正常但完全是编的。
        """
        cands = self.select(needs, **kw)
        if not cands:
            raise LookupError(
                f"目录里没有同时具备 {sorted(str(n) for n in needs)} 的模型。"
                f"可用模型：{sorted(self._cards)}")
        return cands

    # ── 失败学习 ────────────────────────────────────────────────
    def record_denial(self, model: str, error_text: str) -> Capability | None:
        """网关说某模型不支持某能力时，把它从目录里抹掉。

        本进程内不再为同一个模型重复试同一种能力 —— 每次重试都是一个真实往返。
        """
        cap = denial_capability(error_text)
        card = self._cards.get(model)
        if cap is None or card is None or cap not in card.capabilities:
            return None
        self._cards[model] = card.without(cap)
        self.notes.append(f"{model} 实测不支持 {cap}，已从目录移除该能力")
        return cap

    # ── 运行时发现 ──────────────────────────────────────────────
    async def discover(self, base_url: str, api_key: str) -> list[str]:
        """从 ``/v1/models`` 拉取真实可用列表，剔除目录里网关没有的。

        目录写着但网关没上的模型，留着只会在运行时 404。
        """
        import httpx

        async with httpx.AsyncClient(timeout=30) as cli:
            r = await cli.get(f"{base_url.rstrip('/')}/models",
                              headers={"Authorization": f"Bearer {api_key}"})
            r.raise_for_status()
            live = {m["id"] for m in (r.json().get("data") or [])}

        missing = [n for n in self._cards if n not in live]
        for n in missing:
            del self._cards[n]
            self.notes.append(f"{n} 网关上不可用，已移除")
        return sorted(live)

    # ── 访问 ────────────────────────────────────────────────────
    def get(self, name: str) -> ModelCard | None:
        return self._cards.get(name)

    def names(self) -> list[str]:
        return sorted(self._cards)

    def describe(self) -> list[dict[str, Any]]:
        return [self._cards[n].to_dict() for n in self.names()]

    def by_capability(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for c in self._cards.values():
            for cap in c.capabilities:
                out.setdefault(str(cap), []).append(c.name)
        return {k: sorted(v) for k, v in sorted(out.items())}


# ══════════════════════════════════════════════════════════════════
#  按能力路由的网关
# ══════════════════════════════════════════════════════════════════
class SmartGateway:
    """在 :class:`~.llm.ModelGateway` 之上加一层**按能力选型 + 失败切换**。

    调用方说"我要能读图"，不说"我要用 gemini"。模型换了、网关换了、某个模型的
    视觉能力下线了，调用方代码都不用动 —— 而硬编码模型名的写法在这些情况下会
    静默降级成一个看不出来的错误答案。
    """

    def __init__(self, gateway: Any, catalog: ModelCatalog | None = None) -> None:
        self.gw = gateway
        self.catalog = catalog or ModelCatalog()
        self.trace: list[dict[str, Any]] = []

    async def call(
        self,
        node_id: str,
        prompt: str,
        *,
        needs: set[Capability] | frozenset[Capability] = frozenset(),
        prefer: str = "quality",
        max_candidates: int = 3,
        **kw: Any,
    ) -> Any:
        """按能力选型并调用，失败自动切下一个候选。

        Raises:
            LookupError: 目录里没有满足能力要求的模型。**不静默降级** ——
                拿没有视觉能力的模型去做 OCR，会得到一份凭字段名编出来的结果。
        """
        from .llm import ModelError

        cands = self.catalog.require(set(needs), prefer=prefer, limit=max_candidates)
        errors: list[str] = []

        for i, card in enumerate(cands):
            try:
                comp = await self.gw.call(
                    node_id, prompt, model=card.spec,
                    key=f"{kw.pop('key', 'cap')}:{i}" if "key" in kw else None, **kw)
                self.trace.append({"node": node_id, "model": card.name,
                                   "attempt": i + 1, "ok": True})
                return comp
            except Exception as exc:  # noqa: BLE001 — 要按错误内容判断该不该换模型
                text = str(exc)
                errors.append(f"{card.name}: {text[:150]}")
                lost = self.catalog.record_denial(card.name, text)
                self.trace.append({"node": node_id, "model": card.name,
                                   "attempt": i + 1, "ok": False,
                                   "lost_capability": str(lost) if lost else None,
                                   "error": text[:200]})
                if i == len(cands) - 1:
                    raise ModelError(
                        f"能力 {sorted(str(n) for n in needs)} 的 {len(cands)} 个候选"
                        f"全部失败：\n" + "\n".join(errors)) from exc
        raise ModelError("没有候选模型")  # pragma: no cover — require() 已保证非空

    def report(self) -> dict[str, Any]:
        return {"attempts": self.trace, "catalog_notes": self.catalog.notes,
                "by_capability": self.catalog.by_capability()}
