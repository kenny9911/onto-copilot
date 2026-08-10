"""长期记忆 —— 跨 Run 的项目知识。

长期记忆一旦被污染，之后**所有** Run 都受影响，代价远高于短期出错。所以这里
的默认姿态是保守：

  1. **晋升要过闸**（:class:`PromotionGate`）。人确认过、扛过 N 轮 critic、或在
     K 个不同 Run 里被独立观察到 —— 三选一才准进。没有 support 的一律拒。
  2. **冲突不静默覆盖**。新记忆与旧的矛盾时标 contested，两条都留着，检索时
     带警告一起给出去，由人来断。悄悄覆盖等于让系统忘记自己曾经知道过别的。
  3. **不用就衰减**。连续 N 个 Run 没被命中的条目降低 confidence，跌破地板就
     淘汰。项目会演化，去年的约定今年可能已经不成立。
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

from .types import MemoryItem, MemoryKind, Scope

_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[㐀-鿿]")


def _tok(text: str) -> list[str]:
    """粗分词：拉丁按词、CJK 按字。检索长期记忆这种短文本足够，且零依赖。"""
    return [t.lower() for t in _TOKEN_RE.findall(text or "")]


# ══════════════════════════════════════════════════════════════════
#  晋升
# ══════════════════════════════════════════════════════════════════
class PromotionReason(StrEnum):
    HUMAN_CONFIRMED = "human_confirmed"  # 人拍板的决策
    CRITIC_SURVIVED = "critic_survived"  # 扛过 N 轮评审
    REPEATED = "repeated"  # 在 K 个不同 Run 里独立出现
    IMPORTED = "imported"  # 从项目规范文档导入


@dataclass(frozen=True, slots=True)
class PromotionGate:
    """晋升闸门参数。"""

    min_critic_rounds: int = 2
    min_distinct_runs: int = 2
    min_confidence: float = 0.6
    require_support: bool = True

    def check(
        self, item: MemoryItem, reason: PromotionReason, *, critic_rounds: int = 0
    ) -> tuple[bool, str]:
        if self.require_support and not item.support:
            return False, "无 support —— 拿不出依据的记忆不允许进长期库"
        match reason:
            case PromotionReason.HUMAN_CONFIRMED | PromotionReason.IMPORTED:
                return True, str(reason)
            case PromotionReason.CRITIC_SURVIVED:
                if critic_rounds >= self.min_critic_rounds:
                    return True, f"扛过 {critic_rounds} 轮 critic"
                return False, f"critic 轮数 {critic_rounds} < {self.min_critic_rounds}"
            case PromotionReason.REPEATED:
                n = len(item.hit_runs)
                if n >= self.min_distinct_runs:
                    return True, f"在 {n} 个 Run 中独立观察到"
                return False, f"仅 {n} 个 Run 观察到 < {self.min_distinct_runs}"
        return False, "未知晋升理由"


@dataclass(frozen=True, slots=True)
class DecayPolicy:
    """衰减参数。"""

    idle_runs_before_decay: int = 3
    decay_per_run: float = 0.08
    evict_below: float = 0.25
    #: 人确认的决策不衰减 —— 它代表业务事实，不是系统的猜测。
    immune_kinds: frozenset[MemoryKind] = frozenset({MemoryKind.DECISION})


# ══════════════════════════════════════════════════════════════════
#  存储
# ══════════════════════════════════════════════════════════════════
class LongTermStore:
    """项目/租户作用域的记忆库。

    Args:
        project: 项目标识，记忆按项目隔离。
        gate: 晋升闸门。
        decay: 衰减策略。
    """

    def __init__(
        self,
        project: str,
        *,
        gate: PromotionGate | None = None,
        decay: DecayPolicy | None = None,
    ) -> None:
        self.project = project
        self.gate = gate or PromotionGate()
        self.decay_policy = decay or DecayPolicy()
        self._items: dict[str, MemoryItem] = {}
        self._run_seen: list[str] = []  # Run 顺序，衰减靠它算"闲置了几个 Run"

    # ── 晋升 ────────────────────────────────────────────────────
    def promote(
        self,
        item: MemoryItem,
        reason: PromotionReason,
        *,
        run_id: str,
        critic_rounds: int = 0,
    ) -> tuple[bool, str]:
        """把一条短期记忆升入长期库。返回 ``(是否成功, 说明)``。"""
        ok, why = self.gate.check(item, reason, critic_rounds=critic_rounds)
        if not ok:
            return False, why

        item.hit_runs.add(run_id)
        item.created_run = item.created_run or run_id
        item.last_used_run = run_id
        if item.scope in (Scope.NODE, Scope.RUN):
            item.scope = Scope.PROJECT
        if reason is PromotionReason.HUMAN_CONFIRMED:
            item.confidence = max(item.confidence, 0.95)

        existing = self._items.get(item.key)
        if existing is None:
            self._items[item.key] = item
            return True, why

        return self._merge(existing, item, why)

    def _merge(self, old: MemoryItem, new: MemoryItem, why: str) -> tuple[bool, str]:
        """同 key 合并。内容一致 → 加固；不一致 → 标争议，两条都留。"""
        old.hit_runs |= new.hit_runs
        old.support = list(dict.fromkeys([*old.support, *new.support]))[:20]
        old.last_used_run = new.last_used_run

        if _same(old.content, new.content):
            # 独立观察到同一件事，可信度上升但有上限（避免自我强化到 1.0）
            old.confidence = min(0.98, old.confidence + 0.1)
            return True, f"{why}（与既有记忆一致，可信度 → {old.confidence:.2f}）"

        # 人拍板可以推翻机器的推断，但旧的降级留档而非删除
        if new.confidence >= 0.95 > old.confidence:
            variant_key = f"{old.key}~superseded#{len(old.contested_by)}"
            self._items[variant_key] = MemoryItem(
                key=variant_key,
                kind=old.kind,
                scope=old.scope,
                content=old.content,
                confidence=old.confidence * 0.5,
                support=old.support,
                tags=[*old.tags, "superseded"],
                created_run=old.created_run,
            )
            self._items[old.key] = new
            new.contested_by = [variant_key]
            return True, f"{why}（人工决策覆盖既有推断，旧值降级留档）"

        if variant_of(old, new) not in old.contested_by:
            old.contested_by.append(variant_of(old, new))
        old.confidence = min(old.confidence, 0.55)  # 有争议就不该自信
        return True, f"{why}（与既有记忆矛盾，已标争议，检索时会一并给出）"

    # ── 检索 ────────────────────────────────────────────────────
    def recall(
        self,
        query: str,
        *,
        run_id: str = "",
        kinds: Iterable[MemoryKind] | None = None,
        limit: int = 8,
        budget_tokens: int | None = None,
    ) -> list[MemoryItem]:
        """按相关度 × 可信度 × 热度检索。

        命中的条目会被记一次使用 —— 衰减策略据此判断哪些还活着。
        """
        pool = [
            it
            for it in self._items.values()
            if (kinds is None or it.kind in set(kinds)) and "superseded" not in it.tags
        ]
        if not pool:
            return []

        scored = sorted(
            ((self._score(it, query), it) for it in pool), key=lambda p: -p[0]
        )
        out: list[MemoryItem] = []
        spent = 0
        for score, it in scored:
            if score <= 0 and out:
                break
            if budget_tokens is not None and spent + it.tokens > budget_tokens:
                continue
            out.append(it)
            spent += it.tokens
            if len(out) >= limit:
                break

        for it in out:
            it.use_count += 1
            if run_id:
                it.last_used_run = run_id
                it.hit_runs.add(run_id)
        return out

    def _score(self, item: MemoryItem, query: str) -> float:
        q = Counter(_tok(query))
        d = Counter(_tok(item.content) + _tok(" ".join(item.tags)))
        if not q or not d:
            return 0.0
        # BM25 简化版：不做全库 IDF（长期库条目少，IDF 噪声大于信号）
        overlap = sum(min(c, d[t]) for t, c in q.items())
        if overlap == 0:
            return 0.0
        lex = overlap / math.sqrt(sum(q.values()) * sum(d.values()))
        heat = math.log1p(item.use_count) / 3.0
        # DECISION 天然优先：它是人拍板的事实，不是推断
        prior = 1.3 if item.kind is MemoryKind.DECISION else 1.0
        return (lex + 0.25 * heat) * item.confidence * prior

    # ── 衰减 ────────────────────────────────────────────────────
    def start_run(self, run_id: str) -> None:
        if run_id not in self._run_seen:
            self._run_seen.append(run_id)

    def decay(self, current_run: str) -> list[MemoryItem]:
        """按闲置 Run 数衰减，返回被淘汰的条目。"""
        self.start_run(current_run)
        order = {r: i for i, r in enumerate(self._run_seen)}
        now = order[current_run]
        p = self.decay_policy
        evicted: list[MemoryItem] = []

        for key, it in list(self._items.items()):
            if it.kind in p.immune_kinds:
                continue
            last = order.get(it.last_used_run, -1)
            idle = now - last if last >= 0 else now + 1
            if idle <= p.idle_runs_before_decay:
                continue
            it.confidence -= p.decay_per_run * (idle - p.idle_runs_before_decay)
            if it.confidence < p.evict_below:
                evicted.append(self._items.pop(key))
        return evicted

    # ── 持久化 ──────────────────────────────────────────────────
    def __len__(self) -> int:
        return len(self._items)

    def get(self, key: str) -> MemoryItem | None:
        return self._items.get(key)

    def all(self) -> list[MemoryItem]:
        return list(self._items.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "project": self.project,
            "runs": self._run_seen,
            "items": [it.to_dict() for it in self._items.values()],
        }

    def save(self, path: Path | str) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: Path | str, **kw: Any) -> LongTermStore:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
        store = cls(d["project"], **kw)
        store._run_seen = list(d.get("runs", ()))
        for raw in d.get("items", ()):
            it = MemoryItem.from_dict(raw)
            store._items[it.key] = it
        return store


def _same(a: str, b: str) -> bool:
    return _tok(a) == _tok(b)


def variant_of(old: MemoryItem, new: MemoryItem) -> str:
    from ..ids import sha256_hex

    return f"{old.key}~variant#{sha256_hex(new.content)[:8]}"
