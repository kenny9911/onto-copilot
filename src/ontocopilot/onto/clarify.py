"""澄清引擎 —— 从几十条冲突里选出最值得问 FDE 的那 3 个。

**为什么是 3 个而不是全问。** SAGE-Agent（arXiv:2511.08798）的核心发现是提问
**质量**远比数量重要：结构化不确定性驱动的选择在覆盖率提升 7~39% 的同时把提问
数减少 1.5~2.7×。FDE 的注意力是稀缺资源，问 10 个平庸问题比问 3 个关键问题
效果更差、体验也更差。

打分函数（信息增益 × 影响半径，参考 arXiv:2606.03135）::

    score = EIG × log1p(影响半径) × 不可逆性 × (1 − 自解性)

**停止准则**（CaRT, arXiv:2510.08517）：top-1 得分低于阈值就停止提问，剩余
不确定性**转移到模板里变成一个黄底空格**，由业务方在填写时消解。这是本产品的
巧妙之处 —— 没法在对话里解决的歧义不硬问，而是变成模板里的一个格子。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .conflict import FALLBACK_OPTIONS, Conflict, Handling, Option
from .oir import OIR


@dataclass(slots=True)
class Question:
    """一个建模决策问句。

    每个选项都必须带证据出处 —— FDE 要能点进去看原文再决定。给不出出处的
    选项等于让人凭感觉拍板，那还不如不问。
    """

    id: str
    conflict_rid: str
    title: str
    options: list[Option]
    impact: int  # 影响的 OIR 实体数
    score: float
    reversible: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "conflict_rid": self.conflict_rid, "title": self.title,
            "impact_count": self.impact, "score": round(self.score, 4),
            "reversible": self.reversible,
            "options": [o.to_dict() for o in self.options],
        }


@dataclass(slots=True)
class ClarificationSet:
    """澄清引擎的完整输出 —— 问什么、不问什么、不问的怎么处理。"""

    questions: list[Question] = field(default_factory=list)
    auto_repairable: list[Conflict] = field(default_factory=list)
    deferred_to_template: list[Conflict] = field(default_factory=list)
    round_trip: list[Conflict] = field(default_factory=list)
    hints: list[Conflict] = field(default_factory=list)
    stopped_because: str = ""

    def summary(self) -> dict[str, Any]:
        return {
            "asked": len(self.questions),
            "auto_repairable": len(self.auto_repairable),
            "deferred_to_template": len(self.deferred_to_template),
            "round_trip": len(self.round_trip),
            "hints": len(self.hints),
            "stopped_because": self.stopped_because,
        }


class ClarificationEngine:
    """按 EIG 排序选问题。

    Args:
        max_questions: 一次最多问几个。设计稿定的 3。
        theta_ask: 停止阈值。top-1 低于它就不再问。
    """

    def __init__(self, *, max_questions: int = 3, theta_ask: float = 0.35) -> None:
        self.max_questions = max_questions
        self.theta_ask = theta_ask

    def rank(self, conflicts: list[Conflict], oir: OIR) -> ClarificationSet:
        out = ClarificationSet()
        askable: list[tuple[float, Conflict]] = []

        for c in conflicts:
            match c.handling:
                case Handling.AUTO_REPAIR:
                    out.auto_repairable.append(c)
                case Handling.ROUND_TRIP:
                    out.round_trip.append(c)
                case Handling.HINT:
                    out.hints.append(c)
                case Handling.ASK_USER:
                    askable.append((self.score(c, oir), c))

        askable.sort(key=lambda p: -p[0])

        for i, (score, c) in enumerate(askable):
            if len(out.questions) >= self.max_questions:
                out.stopped_because = f"已达提问上限 {self.max_questions}"
                out.deferred_to_template.extend(c for _, c in askable[i:])
                break
            if score < self.theta_ask:
                out.stopped_because = (
                    f"剩余 {len(askable) - i} 条得分均低于阈值 {self.theta_ask}，"
                    "转为模板中的业务必填项"
                )
                out.deferred_to_template.extend(c for _, c in askable[i:])
                break
            out.questions.append(Question(
                id=f"q_{len(out.questions) + 1}_{c.rid[-8:]}",
                conflict_rid=c.rid,
                title=c.summary,
                options=c.options or [Option("defer", "转为模板必填项")],
                impact=self.blast(c, oir),
                score=score,
                reversible=c.irreversibility < 0.5,
            ))
        else:
            if not out.stopped_because:
                out.stopped_because = "全部可问的冲突都已提问"

        return out

    # ── 打分因子 ────────────────────────────────────────────────
    #: 影响半径的归一化基准。超过这个数的冲突在"影响面"这一维上已经拉满，
    #: 再大也不改变"必须问"的结论。
    BLAST_SCALE = 30

    def score(self, c: Conflict, oir: OIR) -> float:
        """四因子乘积，**归一化到 [0,1]**。

        归一化不是美学要求 —— ``theta_ask`` 是运维要调的旋钮，得分不在固定量纲
        上的话这个阈值没法解释，也没法跨项目复用。
        """
        eig = self.eig(c)
        blast_factor = min(1.0, math.log1p(self.blast(c, oir)) / math.log1p(self.BLAST_SCALE))
        return eig * blast_factor * c.irreversibility * (1 - self.self_resolvable(c))

    @staticmethod
    def eig(c: Conflict) -> float:
        """期望信息增益 —— 候选选项分布的归一化熵。

        对*事实之争*：选项越势均力敌，问一次的收益越大。
        对*政策选择*：兜底选项（「留空」「转模板」）也是真实的决策分支，所以
        参与计数、但不参与证据加权 —— 「不做」不需要证据。
        """
        opts = c.options or []
        if c.policy.evidence_decidable:
            branches = [o for o in opts if o.id not in FALLBACK_OPTIONS]
            weights = [1.0 + len(o.evidence) for o in branches]
        else:
            branches = list(opts)
            weights = [1.0] * len(branches)
        if len(branches) < 2:
            return 0.0
        total = sum(weights)
        probs = [w / total for w in weights]
        h = -sum(p * math.log2(p) for p in probs if p > 0)
        return h / math.log2(len(branches))  # 归一化到 [0,1]

    @staticmethod
    def blast(c: Conflict, oir: OIR) -> int:
        """影响半径 —— 这个决策定了之后，多少 OIR 实体的状态会随之确定。"""
        hit: set[str] = set()
        for rid in c.subjects:
            hit.add(rid)
            hit.update(oir.dependents(rid))
        return len(hit)

    @staticmethod
    def self_resolvable(c: Conflict) -> float:
        """自解性 —— 能靠更多证据自行解决的，不该占用人的注意力。

        **只对事实之争成立**。政策选择（做/不做）恒返回 0：「不做」这个分支
        天生没有证据，按证据平衡度打折会把一个该问的问题误判成"系统能自己定"。
        """
        if not c.policy.evidence_decidable or not c.options:
            return 0.0
        counts = [len(o.evidence) for o in c.options if o.id not in FALLBACK_OPTIONS]
        if not counts or sum(counts) == 0:
            return 0.0
        top = max(counts)
        # 一边证据碾压另一边 → 系统可以自己倾向；势均力敌 → 必须问人
        return min(0.8, (top - (sum(counts) - top)) / sum(counts))


# ══════════════════════════════════════════════════════════════════
#  决策回写
# ══════════════════════════════════════════════════════════════════
def apply_decision(oir: OIR, conflict: Conflict, option_id: str, *, note: str = "") -> dict:
    """把人的决策回写进 OIR，返回变更摘要。

    人的决策标 ``Origin.USER``、可信度 0.98 —— 它是业务事实，不是系统推断，
    后续任何自动逻辑都不得覆盖它。
    """
    from .oir import by_user

    option = next((o for o in conflict.options if o.id == option_id), None)
    if option is None:
        raise KeyError(f"冲突 {conflict.rid} 没有选项 {option_id!r}")

    changed: list[str] = []
    effect = option.effect

    if target := effect.get("unify_to"):
        source = oir.properties.get(target)
        for rid in conflict.subjects:
            p = oir.properties.get(rid)
            if p is None or source is None or rid == target:
                continue
            p.definition = by_user(source.definition.value, note=note or f"统一为 {target}")
            changed.append(rid)

    if effect.get("split"):
        from .conflict import _suffix

        for rid in effect["split"]:
            if (p := oir.properties.get(rid)) is None:
                continue
            p.api_name = by_user(f"{p.api_name.value}{_suffix(p)}", note=note or "拆分为两个属性")
            changed.append(rid)

    if new_type := effect.get("set_base_type"):
        for rid in conflict.subjects:
            if (p := oir.properties.get(rid)) is not None:
                p.base_type = by_user(new_type, note=note or "以实际数据为准")
                changed.append(rid)

    return {
        "conflict": conflict.rid, "option": option_id, "label": option.label,
        "changed": changed, "note": note, "deferred": bool(effect.get("defer")),
    }
