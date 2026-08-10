"""对话记忆 —— 会话作用域，介于 Run 与项目之间。

现有四层记忆全是 **Run 作用域**：节点执行时现装现用，Run 结束就散。这套东西
处理不了对话，因为对话的生命周期和 Run 不一样 —— 一次会话里可能跑三次 build，
用户在第一次 build 前说的"含税一律指增值税专用发票口径"，必须在第三次 build
的每一个抽取节点里都还在。

所以对话记忆**不是第五层**，它是一个**喂料口**：把会话里发生的事分成两种，分别
接到已有的层上。

    用户说的"决定"  →  L3 Reflection（和 critic 教训并列），且候选晋升长期库
    其余往来        →  会话自己持有，压缩后只留摘要，不进节点上下文

这个二分是这层的全部要点。把对话历史整个塞进 prompt 是最容易想到的做法，也是
错的：闲聊会挤掉证据，而真正要紧的那句口径约定会在第 40 轮被滚动窗口丢掉 ——
**恰恰是它最该活到最后。**

压缩因此有一条铁律：:class:`Decision` **永不进压缩器**。轮次可以被摘要吃掉，
决定只会被后来的决定推翻，不会被"太久了"淘汰。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..ids import sha256_hex
from .types import MemoryItem, MemoryKind, Scope, est_tokens

__all__ = ["Utterance", "Speaker", "Decision", "DecisionKind", "DialogueMemory",
           "heuristic_digest"]


class Speaker(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    #: 系统事件在对话里的投影（"已完成梳理，171 个对象"）。它不是谁说的话，
    #: 但用户会拿它当上下文引用（"刚才那 171 个里……"），所以必须留在轮次里。
    SYSTEM = "system"


@dataclass(slots=True)
class Utterance:
    """一轮对话。"""

    speaker: Speaker
    text: str
    ts: float = field(default_factory=time.time)
    #: 这轮被判成什么意图。规则判出来的填规则名，模型判的填意图名，判不出留空。
    intent: str = ""
    #: 这轮碰到了什么（对象 rid、问题 id、建议 id）。压缩时**不丢**，因为
    #: "我们上次聊的是哪几个对象"是后续指代消解的唯一依据。
    refs: list[str] = field(default_factory=list)
    compressed: bool = False

    @property
    def tokens(self) -> int:
        return est_tokens(self.text)

    def render(self) -> str:
        who = {Speaker.USER: "用户", Speaker.ASSISTANT: "助手",
               Speaker.SYSTEM: "系统"}[self.speaker]
        return f"{who}: {self.text}"

    def to_dict(self) -> dict[str, Any]:
        return {"speaker": str(self.speaker), "text": self.text, "ts": self.ts,
                "intent": self.intent, "refs": self.refs,
                "compressed": self.compressed}


class DecisionKind(StrEnum):
    """决定的类型。决定它作用到哪里、以及能不能晋升长期库。"""

    CALIBER = "caliber"        # 口径约定："含税一律指增值税专用发票口径"
    NAMING = "naming"          # 命名规范："头表统一用 Header 后缀"
    SCOPE = "scope"            # 范围取舍："临时表都不要"
    ANSWER = "answer"          # 回答了某个具体澄清问题
    ADOPTION = "adoption"      # 采纳/否决了某条建议
    CORRECTION = "correction"  # 纠正了系统的某个判断


#: 能晋升到长期库的类型。ANSWER 和 ADOPTION 是**就事论事**的，绑在这一份材料的
#: 某个具体条目上，跨 Run 没有意义；把它们固化成长期约束，下一个项目会莫名其妙地
#: 继承一堆和它无关的结论。
PROMOTABLE = frozenset({DecisionKind.CALIBER, DecisionKind.NAMING, DecisionKind.SCOPE})


@dataclass(slots=True)
class Decision:
    """用户在对话里拍下的一个板。

    和 :class:`~.types.MemoryItem` 是两回事：MemoryItem 是记忆库里的一条，
    Decision 是**会话里发生的一个事件**，它可能变成 MemoryItem（经过闸门），
    也可能只在本次会话有效。混成一个类型的话，"用户随口一说"和"已经写进长期库"
    就分不开了。
    """

    kind: DecisionKind
    statement: str
    #: 作用范围。空 = 全局；否则是 rid / 问题 id / 文件名。
    scope_refs: list[str] = field(default_factory=list)
    #: 出自第几轮。审计时要能回到原话 —— 摘要过的转述不能作为依据。
    turn_index: int = -1
    ts: float = field(default_factory=time.time)
    #: 被后来的决定推翻时置上。**不删除** —— 推翻本身是信息，
    #: 用户改主意的过程比结论更值得留档。
    superseded_by: int | None = None

    @property
    def key(self) -> str:
        return f"dlg_{sha256_hex(f'{self.kind}:{self.statement}')[:12]}"

    @property
    def active(self) -> bool:
        return self.superseded_by is None

    def render(self) -> str:
        scope = f"（限 {'、'.join(self.scope_refs[:4])}）" if self.scope_refs else ""
        return f"{self.statement}{scope}"

    def to_memory(self, *, run_id: str) -> MemoryItem:
        """转成记忆项，准备过晋升闸门。

        ``support`` 记的是"人在第几轮说的"。没有 support 的记忆不许晋升 ——
        对话决定的 support 就是那一轮本身，这也是它能算 human-confirmed 的依据。
        """
        return MemoryItem(
            key=self.key,
            kind=MemoryKind.DECISION if self.kind is not DecisionKind.NAMING
            else MemoryKind.CONVENTION,
            scope=Scope.PROJECT,
            content=self.render(),
            support=[f"dialogue:{run_id}:turn{self.turn_index}"],
            confidence=1.0,
            created_run=run_id,
            tags=["dialogue", str(self.kind)],
        )

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "kind": str(self.kind), "statement": self.statement,
                "scope_refs": self.scope_refs, "turn": self.turn_index,
                "ts": self.ts, "active": self.active,
                "superseded_by": self.superseded_by}


#: 压缩器签名。生产上是一次廉价 LLM 调用，降级和测试走启发式。
Digester = Callable[[list[Utterance]], str]


def heuristic_digest(turns: list[Utterance]) -> str:
    """不调模型的兜底压缩。

    只保留用户说过什么 —— 助手的回复是可以重新生成的，用户的输入不可以。
    压缩时优先牺牲助手侧，这个偏向是刻意的。
    """
    said = [t.text.replace("\n", " ")[:60] for t in turns if t.speaker is Speaker.USER]
    refs: list[str] = []
    for t in turns:
        for r in t.refs:
            if r not in refs:
                refs.append(r)
    body = f"（已压缩 {len(turns)} 轮）用户说过：{'；'.join(said[:8])}"
    return body + (f"｜涉及：{'、'.join(refs[:12])}" if refs else "")


class DialogueMemory:
    """一次会话的对话记忆。

    Args:
        budget_tokens: 轮次部分的预算。**决定不占这个预算** —— 决定是必须知道的，
            没有"装不下就不装"这个选项；装不下要削的是别的层。
        keep_verbatim: 最近多少轮保留原文。指代消解（"那个"、"刚才那条"）只依赖
            最近几轮，再往前的原文没有保留价值。
    """

    def __init__(self, *, budget_tokens: int = 4_000, keep_verbatim: int = 8,
                 digester: Digester | None = None) -> None:
        self.budget_tokens = budget_tokens
        self.keep_verbatim = keep_verbatim
        self._digest = digester or heuristic_digest
        self._turns: list[Utterance] = []
        self._decisions: list[Decision] = []
        self.compactions = 0

    # ── 写入 ────────────────────────────────────────────────────
    def say(self, speaker: Speaker | str, text: str, *, intent: str = "",
            refs: list[str] | None = None) -> Utterance:
        u = Utterance(speaker=Speaker(speaker), text=text, intent=intent,
                      refs=list(refs or []))
        self._turns.append(u)
        return u

    def decide(self, kind: DecisionKind | str, statement: str, *,
               scope_refs: list[str] | None = None) -> Decision:
        """记一个决定。同类同范围的旧决定会被标记为已推翻，但不删除。"""
        k = DecisionKind(kind)
        d = Decision(kind=k, statement=statement, scope_refs=list(scope_refs or []),
                     turn_index=len(self._turns) - 1)
        idx = len(self._decisions)
        for old in self._decisions:
            # 同类型 + 同作用域 = 后者推翻前者。作用域不同则并存 ——
            # "临时表都不要"和"但 clmSpaImportTmp 要留"不是矛盾，是细化。
            if (old.active and old.kind is k
                    and sorted(old.scope_refs) == sorted(d.scope_refs)):
                old.superseded_by = idx
        self._decisions.append(d)
        return d

    # ── 读取 ────────────────────────────────────────────────────
    @property
    def turns(self) -> list[Utterance]:
        return list(self._turns)

    @property
    def decisions(self) -> list[Decision]:
        """全部决定，含已被推翻的。"""
        return list(self._decisions)

    def active_decisions(self, *, kinds: tuple[DecisionKind, ...] | None = None,
                         refs: list[str] | None = None) -> list[Decision]:
        """当前生效的决定。

        Args:
            refs: 只要作用到这些 rid 上的（含全局决定）。节点装配上下文时按自己
                处理的对象过滤 —— 全量注入会让每个节点都背上整个会话的决定。
        """
        out = [d for d in self._decisions if d.active]
        if kinds:
            out = [d for d in out if d.kind in kinds]
        if refs is not None:
            want = set(refs)
            out = [d for d in out if not d.scope_refs or want & set(d.scope_refs)]
        return out

    @property
    def tokens(self) -> int:
        return sum(t.tokens for t in self._turns)

    def over_budget(self, threshold: float = 0.7) -> bool:
        return self.tokens > self.budget_tokens * threshold

    # ── 压缩 ────────────────────────────────────────────────────
    def compact(self) -> bool:
        """压掉最老的一批轮次。**决定不参与压缩。**

        决定是从轮次里提炼出来的独立对象，压掉轮次不会带走它们 —— 这正是把
        两者分开存的意义。滚动窗口式的对话历史做不到这一点：第 40 轮时，第 3 轮
        那句口径约定已经滑出窗口了，而它恰恰是最该活到最后的东西。
        """
        head = len(self._turns) - self.keep_verbatim
        if head <= 1:
            return False
        old, keep = self._turns[:head], self._turns[head:]
        if all(t.compressed for t in old):
            return False
        merged_refs: list[str] = []
        for t in old:
            for r in t.refs:
                if r not in merged_refs:
                    merged_refs.append(r)
        summary = Utterance(speaker=Speaker.SYSTEM, text=self._digest(old),
                            refs=merged_refs, compressed=True)
        self._turns = [summary, *keep]
        self.compactions += 1
        return True

    def compact_to_fit(self, threshold: float = 0.7) -> int:
        n = 0
        while self.over_budget(threshold) and self.compact():
            n += 1
        return n

    # ── 装配 ────────────────────────────────────────────────────
    def render_decisions(self, *, refs: list[str] | None = None) -> str:
        """给节点上下文用的决定清单。进 L3。"""
        ds = self.active_decisions(refs=refs)
        if not ds:
            return ""
        return "\n".join(f"· 已拍板：{d.render()}" for d in ds)

    def render_recent(self, *, limit: int = 6) -> str:
        """最近几轮原文。只在**回复用户**时用，不进节点上下文 ——
        抽取节点不需要知道用户跟你寒暄过什么。"""
        return "\n".join(t.render() for t in self._turns[-limit:])

    def promotable(self, *, run_id: str) -> list[MemoryItem]:
        """够格进长期库的决定。

        只有口径/命名/范围这三类跨 Run 才成立。回答某个问题、采纳某条建议是
        **就事论事**的，绑在这份材料的具体条目上；固化成长期约束的话，下一个
        项目会继承一堆和它毫无关系的结论 —— 长期记忆一旦污染，代价远高于短期。
        """
        return [d.to_memory(run_id=run_id) for d in self._decisions
                if d.active and d.kind in PROMOTABLE]

    # ── 持久化 ──────────────────────────────────────────────────
    def to_dict(self) -> dict[str, Any]:
        return {"turns": [t.to_dict() for t in self._turns],
                "decisions": [d.to_dict() for d in self._decisions],
                "compactions": self.compactions}

    @classmethod
    def from_dict(cls, data: dict[str, Any], **kw: Any) -> "DialogueMemory":
        dm = cls(**kw)
        for t in data.get("turns", ()):
            u = Utterance(speaker=Speaker(t["speaker"]), text=t["text"],
                          ts=t.get("ts", 0.0), intent=t.get("intent", ""),
                          refs=list(t.get("refs") or []),
                          compressed=bool(t.get("compressed")))
            dm._turns.append(u)
        for i, d in enumerate(data.get("decisions", ())):
            dec = Decision(kind=DecisionKind(d["kind"]), statement=d["statement"],
                           scope_refs=list(d.get("scope_refs") or []),
                           turn_index=d.get("turn", -1), ts=d.get("ts", 0.0))
            # active 不是存出来的字段，靠 superseded_by 还原，避免两处真相打架
            dec.superseded_by = d.get("superseded_by")
            dm._decisions.append(dec)
            del i
        dm.compactions = int(data.get("compactions", 0))
        return dm

    def __len__(self) -> int:
        return len(self._turns)
