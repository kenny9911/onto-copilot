"""短期记忆 —— Run 之内的工作记忆。

两个容器，生命周期不同：

  * :class:`Scratchpad` —— **节点作用域**。一次 agent loop 里的
    thought/action/observation 三元组。节点退出时整个丢掉，只留一份
    :meth:`Scratchpad.digest`。这是控制上下文膨胀的主力：某个节点内部转了 20
    轮，下游节点看到的只有结论。

  * :class:`WorkingSet` —— **Run 作用域**。沿 DAG 边流动的结构化产出。

压缩纪律（架构文档 §4.3）：working set 超过预算 70% 时压缩最老的 observation，
但 **locator 永不压缩** —— locator 丢了溯源就断了，而溯源是这个产品的信任基础。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .types import est_tokens

#: 从任意文本里捞 locator 的模式，压缩时强制保留。
#: 覆盖 ``实体梳理.xlsx!业务对象实体梳理!R44C6``、``f3:sheet0:rows[40..48]``、
#: ``$.components.schemas.Plan``、``clm_contract:L12-18``。
_LOCATOR_RE = re.compile(
    r"(?:[\w一-鿿.\-]+\.(?:xlsx|csv|docx|json|ddl|sql|png|pdf)"
    r"(?:[!:#][^\s,;，；、)】]*)?)"
    r"|(?:\bf\d+:[\w\[\].\-]+)"
    r"|(?:\$\.[\w.\[\]*]+)"
    r"|(?:\bR\d+C\d+\b)"
)


def extract_locators(text: str) -> list[str]:
    seen: dict[str, None] = {}
    for m in _LOCATOR_RE.finditer(text or ""):
        seen.setdefault(m.group(0), None)
    return list(seen)


@dataclass(slots=True)
class Turn:
    """agent loop 的一轮。"""

    thought: str = ""
    action: str = ""
    observation: str = ""
    compressed: bool = False

    @property
    def tokens(self) -> int:
        return est_tokens(self.thought) + est_tokens(self.action) + est_tokens(self.observation)

    def render(self) -> str:
        parts = []
        if self.thought:
            parts.append(f"想: {self.thought}")
        if self.action:
            parts.append(f"做: {self.action}")
        if self.observation:
            parts.append(f"见: {self.observation}")
        return "\n".join(parts)


#: 压缩器签名：拿到若干轮，返回一段摘要。生产上是一次廉价 LLM 调用，
#: 测试和降级路径用启发式。
Summarizer = Callable[[list[Turn]], str]


def heuristic_summary(turns: list[Turn]) -> str:
    """不调模型的兜底压缩：保留动作序列和观察的首句。"""
    acts = [t.action for t in turns if t.action]
    obs = [t.observation.split("。")[0][:80] for t in turns if t.observation]
    return f"（已压缩 {len(turns)} 轮）动作: {' → '.join(acts[:8])}；要点: {'；'.join(obs[:4])}"


class Scratchpad:
    """节点作用域的工作记忆。

    Args:
        budget_tokens: 触发压缩的软上限。
        keep_verbatim: 最近多少轮不压缩 —— 近期上下文对下一步决策最有用。
        summarizer: 压缩器，默认走启发式。
    """

    def __init__(
        self,
        *,
        budget_tokens: int = 24_000,
        keep_verbatim: int = 6,
        summarizer: Summarizer | None = None,
    ) -> None:
        self.budget_tokens = budget_tokens
        self.keep_verbatim = keep_verbatim
        self._summarize = summarizer or heuristic_summary
        self._turns: list[Turn] = []
        self._pinned: list[str] = []  # 压缩中幸存下来的 locator
        self.compactions = 0

    # ── 写入 ────────────────────────────────────────────────────
    def append(self, thought: str = "", action: str = "", observation: str = "") -> Turn:
        turn = Turn(thought=thought, action=action, observation=observation)
        self._turns.append(turn)
        for text in (thought, action, observation):
            for loc in extract_locators(text):
                if loc not in self._pinned:
                    self._pinned.append(loc)
        return turn

    # ── 状态 ────────────────────────────────────────────────────
    @property
    def turns(self) -> list[Turn]:
        return list(self._turns)

    @property
    def tokens(self) -> int:
        return sum(t.tokens for t in self._turns) + est_tokens(" ".join(self._pinned))

    @property
    def locators(self) -> list[str]:
        return list(self._pinned)

    def over_budget(self, threshold: float = 0.7) -> bool:
        return self.tokens > self.budget_tokens * threshold

    # ── 压缩 ────────────────────────────────────────────────────
    def compact(self) -> bool:
        """压缩最老的若干轮。返回是否真的压了。

        locator 不进压缩器 —— 它们已经被 pin 住，压缩后仍完整挂在 scratchpad 上。
        """
        head = len(self._turns) - self.keep_verbatim
        if head <= 1:
            return False
        old, keep = self._turns[:head], self._turns[head:]
        if all(t.compressed for t in old):
            return False  # 已经压过了，再压没有收益
        summary = Turn(observation=self._summarize(old), compressed=True)
        self._turns = [summary, *keep]
        self.compactions += 1
        return True

    def compact_to_fit(self, threshold: float = 0.7) -> int:
        n = 0
        while self.over_budget(threshold) and self.compact():
            n += 1
        return n

    # ── 输出 ────────────────────────────────────────────────────
    def render(self) -> str:
        body = "\n\n".join(t.render() for t in self._turns if t.render())
        if not self._pinned:
            return body
        locs = "、".join(self._pinned[:40])
        return f"{body}\n\n[本节点已引用的证据位置] {locs}" if body else f"[证据位置] {locs}"

    def digest(self, max_tokens: int = 600) -> dict[str, Any]:
        """节点退出时留给下游的东西 —— **只有这个会跨节点**。"""
        text = self._summarize(self._turns) if self._turns else ""
        while est_tokens(text) > max_tokens and len(text) > 80:
            text = text[: int(len(text) * 0.8)]
        return {
            "turns": len(self._turns),
            "summary": text,
            "locators": self._pinned[:64],
            "compactions": self.compactions,
        }

    def __len__(self) -> int:
        return len(self._turns)


@dataclass(slots=True)
class WorkingSet:
    """Run 作用域：沿 DAG 边流动的节点产出。

    只存**结构化产出**，不存节点内部过程 —— 那是 Scratchpad 的事，且不跨节点。
    """

    outputs: dict[str, Any] = field(default_factory=dict)
    digests: dict[str, dict[str, Any]] = field(default_factory=dict)

    def put(self, node_id: str, output: Any, digest: dict[str, Any] | None = None) -> None:
        self.outputs[node_id] = output
        if digest:
            self.digests[node_id] = digest

    def get(self, node_id: str, default: Any = None) -> Any:
        return self.outputs.get(node_id, default)

    def select(self, node_ids: list[str]) -> dict[str, Any]:
        """按 DAG 依赖取上游产出。支持 ``PARSE.*`` 通配 fan-out 节点。"""
        out: dict[str, Any] = {}
        for nid in node_ids:
            if nid.endswith(".*"):
                pre = nid[:-1]
                for k, v in self.outputs.items():
                    if k.startswith(pre):
                        out[k] = v
            elif nid in self.outputs:
                out[nid] = self.outputs[nid]
        return out

    @property
    def tokens(self) -> int:
        import json

        return est_tokens(json.dumps(self.outputs, ensure_ascii=False, default=str))
