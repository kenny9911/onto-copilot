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

from .types import MemoryItem, MemoryKind, MemoryTier, Scope

_TOKEN_RE = re.compile(r"[a-zA-Z0-9_]+|[㐀-鿿]")

#: 参考档的检索降权。人拍板和模型推断同时命中时，人的先出场。
_REFERENCE_DISCOUNT = 0.6
#: 第二道降权：这条参考是在另一批材料上得出的，跟本轮更可能无关。
_FOREIGN_MATERIAL_DISCOUNT = 0.6

_REF_DECISION_WHY = (
    "参考档不许用 decision 这个 kind —— DECISION 在检索里吃 1.3 prior、"
    "在衰减里完全豁免，模型的推断借它表达就成了既排前又永不过期"
)


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
        # 参考档在这里被无条件挡掉，位置是刻意的：
        #   · 必须在 match reason 之前 —— HUMAN_CONFIRMED / IMPORTED 是 `return True`
        #     的直通分支，写在里面等于没写；
        #   · 必须在闸门**内部**而不是调用方 —— recall() 会给命中项攒 hit_runs，
        #     而 len(hit_runs) 正是 REPEATED 的判据，参考档被召回两轮就自动够格了。
        if item.tier is MemoryTier.REFERENCE:
            return False, "参考档记忆永不晋升 —— 升权威的唯一路径是人在本会话里拍板"
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
        if item.tier is MemoryTier.REFERENCE and item.kind is MemoryKind.DECISION:
            # 闸门下一行也会拒掉它，但那句话说的是"永不晋升"，掩盖了真正的问题：
            # 借 DECISION 这个 kind 表达推断，会同时拿到 1.3 的检索 prior 和衰减豁免。
            return False, _REF_DECISION_WHY
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

    def note(self, item: MemoryItem, *, run_id: str = "") -> tuple[bool, str]:
        """记下一条参考档观察。返回 ``(是否记下, 说明)``。

        参考档不走 ``promote`` —— 它压根不在晋升体系里，闸门只会拒它。但它仍然
        走 ``_merge``：同 key 撞上人拍板的条目时，必须让"参考不许覆盖权威"那道
        判断真的生效，而不是绕过合并直接写进 ``_items`` 把人的约定顶掉。

        这里**不写 hit_runs** —— 那是晋升的证据，参考档不该攒。
        """
        if item.tier is not MemoryTier.REFERENCE:
            return False, "note() 只收参考档 —— 权威档必须走 promote 过闸门"
        if item.kind is MemoryKind.DECISION:
            return False, _REF_DECISION_WHY

        item.created_run = item.created_run or run_id
        item.last_used_run = run_id or item.last_used_run
        existing = self._items.get(item.key)
        if existing is None:
            self._items[item.key] = item
            return True, "记下参考档观察"
        return self._merge(existing, item, "参考档观察")

    def _merge(self, old: MemoryItem, new: MemoryItem, why: str) -> tuple[bool, str]:
        """同 key 合并。内容一致 → 加固；不一致 → 标争议，两条都留。"""
        old.hit_runs |= new.hit_runs
        # 不带 run 的写入（note 的 run_id 可省）不该把旧条目的"上次用过"抹掉 ——
        # 抹掉了衰减就会把它当成一直闲置，白白扣分。
        old.last_used_run = new.last_used_run or old.last_used_run
        # 参考档的 support 不许并进权威档：support 是这条记忆的依据，会被人当出处看，
        # 混进模型推断的依据就等于让参考档从后门进了交付物的溯源。
        if not (old.tier is MemoryTier.AUTHORITATIVE and new.tier is MemoryTier.REFERENCE):
            old.support = list(dict.fromkeys([*old.support, *new.support]))[:20]

        if _same(old.content, new.content):
            # 独立观察到同一件事，可信度上升但有上限（避免自我强化到 1.0）
            old.confidence = min(0.98, old.confidence + 0.1)
            return True, f"{why}（与既有记忆一致，可信度 → {old.confidence:.2f}）"

        # 谁能覆盖谁：**先看档位，档位裁不了才回落到数字**。
        # 原来只有 `new.confidence >= 0.95 > old.confidence` 这个裸比较，而
        # HUMAN_CONFIRMED 会把 confidence 顶到 0.95 —— 参考档一旦借到这个数字，
        # 就能把人拍板的条目打成 superseded，而 superseded 被 recall 直接排除，
        # 等于人的约定静默消失。反过来（人拍板推翻推断）才是这条分支的本意。
        new_ref = new.tier is MemoryTier.REFERENCE
        old_ref = old.tier is MemoryTier.REFERENCE
        if not new_ref and (old_ref or new.confidence >= 0.95 > old.confidence):
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
                tier=old.tier,
                origin_session=old.origin_session,
                origin_files=list(old.origin_files),
            )
            self._items[old.key] = new
            new.contested_by = [variant_key]
            return True, f"{why}（人工决策覆盖既有推断，旧值降级留档）"

        if variant_of(old, new) not in old.contested_by:
            old.contested_by.append(variant_of(old, new))
        if not (new_ref and not old_ref):
            old.confidence = min(old.confidence, 0.55)  # 有争议就不该自信
        else:
            # 模型的推断跟人拍板的约定对不上：矛盾记下来（人能看见），但不许
            # 拿它压人的可信度 —— 那是从排名侧变相实现覆盖。
            return True, f"{why}（与人拍板的约定矛盾，已记下存疑，权威档不受影响）"
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
        current_files: set[str] | None = None,
    ) -> list[MemoryItem]:
        """按相关度 × 可信度 × 热度检索。

        命中的条目会被记一次使用 —— 衰减策略据此判断哪些还活着。

        Args:
            current_files: 本轮在看的材料。传了它，参考档里"在另一批材料上得出的"
                会再降一档 —— 同一项目下不同会话的材料可能毫不相干。
        """
        pool = [
            it
            for it in self._items.values()
            if (kinds is None or it.kind in set(kinds)) and "superseded" not in it.tags
        ]
        if not pool:
            return []

        scored = sorted(
            ((self._score(it, query, current_files), it) for it in pool), key=lambda p: -p[0]
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
                # 参考档不攒 hit_runs。hit_runs 是 REPEATED 晋升的**证据**，而参考档
                # 永远拿不到晋升 —— 让它攒，等于给闸门那道拒绝留了条绕行路：被召回
                # 两个 Run 之后它就"够格"了，只差有人用错 reason 调一次 promote。
                # last_used_run 照写，衰减要靠它判断这条还活着。
                if it.tier is not MemoryTier.REFERENCE:
                    it.hit_runs.add(run_id)
        return out

    def _score(
        self, item: MemoryItem, query: str, current_files: set[str] | None = None
    ) -> float:
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
        # 参考档打折挂在打分里、不动存储里的 confidence —— 改存量会顺带改变
        # _merge 的覆盖判据和衰减的淘汰线，一次装配就把库里的数据带偏了。
        if item.tier is MemoryTier.REFERENCE:
            prior *= _REFERENCE_DISCOUNT
            if item.from_other_material(current_files):
                prior *= _FOREIGN_MATERIAL_DISCOUNT
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

    def adopt(self, items: Iterable[MemoryItem]) -> int:
        """把已经落过库的条目原样装回来，返回装入条数。

        **不过闸门、不走合并** —— 这些条目当初进库时已经过了一次闸，按当下状态重放
        只会被误判（比如权威档的 support 早被合并压缩过）。只给持久化装载用，
        新记忆一律走 :meth:`promote` 或 :meth:`note`。
        """
        n = 0
        for it in items:
            self._items[it.key] = it
            n += 1
        return n

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
