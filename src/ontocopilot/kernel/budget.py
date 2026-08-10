"""预算与降级。

**降级必须对用户可见。** 悄悄降级然后交付一个没审过的产物，比直接失败更严重 ——
FDE 会拿着它去跟客户对，而系统从没告诉过他这份东西的语义审核被跳过了。

所以每一级降级都：写事件日志 → 广播到总线 → 在产物上打标记 → 在 UI 上显示。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

from .errors import BudgetExhausted


class DegradeLevel(IntEnum):
    """降级阶梯（架构文档 §6.3）。数值越大越省，代价也越大。"""

    NONE = 0
    NO_SELF_CONSISTENCY = 1  # 剩余 <40%：关掉 Critical 档的多采样自洽
    FEWER_CRITIC_ROUNDS = 2  # 剩余 <25%：critic 轮数 2 → 1
    RULES_ONLY = 3  # 剩余 <15%：跳过 LLM critic，产物标「未经语义审核」
    HALT = 4  # 剩余 <5%：存 checkpoint，通知 FDE，暂停

    @property
    def label(self) -> str:
        return {
            DegradeLevel.NONE: "正常",
            DegradeLevel.NO_SELF_CONSISTENCY: "关闭多采样自洽",
            DegradeLevel.FEWER_CRITIC_ROUNDS: "critic 轮数降至 1",
            DegradeLevel.RULES_ONLY: "仅规则评审（产物标记未经语义审核）",
            DegradeLevel.HALT: "暂停并保存 checkpoint",
        }[self]


#: 剩余比例 → 降级级别。
_LADDER: tuple[tuple[float, DegradeLevel], ...] = (
    (0.05, DegradeLevel.HALT),
    (0.15, DegradeLevel.RULES_ONLY),
    (0.25, DegradeLevel.FEWER_CRITIC_ROUNDS),
    (0.40, DegradeLevel.NO_SELF_CONSISTENCY),
)


@dataclass(slots=True)
class Budget:
    """多维预算。任一维度耗尽即触发降级。

    Attributes:
        tokens: 总 token 上限。
        wallclock_s: 墙钟秒数上限。
        tool_calls: 工具调用次数上限。
        usd: 成本上限（模型网关按档位折算）。
    """

    tokens: float = 2_000_000
    wallclock_s: float = 3600
    tool_calls: float = 500
    usd: float = 50.0

    _spent: dict[str, float] = field(default_factory=lambda: {
        "tokens": 0.0, "wallclock_s": 0.0, "tool_calls": 0.0, "usd": 0.0
    })
    _floor: DegradeLevel = DegradeLevel.NONE  # 已宣告的最低级别，只升不降

    # ── 记账 ────────────────────────────────────────────────────
    def spend(self, **amounts: float) -> None:
        for k, v in amounts.items():
            if k not in self._spent:
                raise KeyError(f"未知预算维度: {k}")
            self._spent[k] += v

    def spent(self, dim: str) -> float:
        return self._spent[dim]

    def limit(self, dim: str) -> float:
        return float(getattr(self, dim))

    def remaining(self, dim: str) -> float:
        return max(0.0, self.limit(dim) - self._spent[dim])

    def ratio(self, dim: str) -> float:
        lim = self.limit(dim)
        return 1.0 if lim <= 0 else max(0.0, 1.0 - self._spent[dim] / lim)

    @property
    def tightest(self) -> tuple[str, float]:
        """最紧的维度及其剩余比例 —— 降级判定看它。"""
        dims = ("tokens", "wallclock_s", "tool_calls", "usd")
        return min(((d, self.ratio(d)) for d in dims), key=lambda p: p[1])

    # ── 降级 ────────────────────────────────────────────────────
    @property
    def level(self) -> DegradeLevel:
        """当前降级级别。

        **单调不减**：一旦宣告过某个降级级别就不再回退，即使事后上调了额度。
        原因是降级已经改变了产物 —— 少跑的 critic 不会因为后来钱变多了就补跑，
        产物上的「未经语义审核」标记也不该悄悄消失。
        """
        _, r = self.tightest
        lvl = DegradeLevel.NONE
        for threshold, candidate in _LADDER:
            if r < threshold:
                lvl = max(lvl, candidate)
        lvl = max(lvl, self._floor)
        self._floor = lvl  # latch
        return lvl

    def pin_level(self, lvl: DegradeLevel) -> None:
        """外部强制降级（例如用户主动选省钱模式）。"""
        self._floor = max(self._floor, lvl)

    def check(self, dim: str = "tokens") -> None:
        if self.remaining(dim) <= 0:
            raise BudgetExhausted(dim, self.limit(dim), self.spent(dim))

    # ── 节点级派生 ──────────────────────────────────────────────
    def critic_rounds(self, requested: int) -> int:
        lvl = self.level
        if lvl >= DegradeLevel.RULES_ONLY:
            return 0
        if lvl >= DegradeLevel.FEWER_CRITIC_ROUNDS:
            return min(requested, 1)
        return requested

    def allow_self_consistency(self) -> bool:
        return self.level < DegradeLevel.NO_SELF_CONSISTENCY

    def allow_llm_critic(self) -> bool:
        return self.level < DegradeLevel.RULES_ONLY

    def must_halt(self) -> bool:
        return self.level >= DegradeLevel.HALT

    def snapshot(self) -> dict[str, Any]:
        dim, r = self.tightest
        return {
            "spent": dict(self._spent),
            "limits": {d: self.limit(d) for d in self._spent},
            "tightest": dim,
            "remaining_ratio": round(r, 4),
            "level": int(self.level),
            "level_label": self.level.label,
        }
