"""记忆的公共类型。

短期与长期共用一套 ``MemoryItem``，靠 ``scope`` 区分生命周期。这样"短期晋升为
长期"就是改一个字段 + 过一道闸，而不是在两套数据结构之间搬运。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..ids import sha256_hex

# ── token 估算 ──────────────────────────────────────────────────
# 上下文预算必须能在不调 tokenizer 的情况下算，否则每次装配都要付一次编码开销。
# CJK 约 1 字 ≈ 1 token，拉丁约 4 字符 ≈ 1 token。够用来做预算决策。
_CJK = re.compile(r"[㐀-鿿豈-﫿　-〿＀-￯]")


def est_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    return cjk + max(1, (len(text) - cjk) // 4)


class Scope(StrEnum):
    """生命周期。"""

    NODE = "node"  # 节点退出即丢，只留 digest
    RUN = "run"  # Run 结束即丢
    PROJECT = "project"  # 跨 Run，同一客户项目内共享
    TENANT = "tenant"  # 跨项目（命名规范、通用术语）


class MemoryKind(StrEnum):
    """记忆类型 —— 决定检索时怎么打分、晋升时走哪条闸。"""

    LESSON = "lesson"  # critic 反馈沉淀的教训（Reflexion）
    TERM = "term"  # 术语映射：别名 → 标准名
    CONVENTION = "convention"  # 命名/建模约定
    DECISION = "decision"  # 人拍板的建模决策（最高可信度）
    FACT = "fact"  # 关于本项目的事实（"金额口径以财务共享中心税率表为准"）
    ARTIFACT = "artifact"  # 产物指针（上一版 OIR 快照）


@dataclass(slots=True)
class MemoryItem:
    """一条记忆。

    ``support`` 是这条记忆的依据（事件 seq、evidence locator、人工决策 id）。
    没有 support 的记忆不允许晋升到长期 —— 长期记忆一旦污染，后续所有 Run 都
    受影响，代价远高于短期。
    """

    key: str  # 同 key 视为同一条，重复写入走合并而非追加
    kind: MemoryKind
    scope: Scope
    content: str
    confidence: float = 0.5
    support: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    # 使用统计 —— 检索打分与衰减都靠它
    created_run: str = ""
    last_used_run: str = ""
    use_count: int = 0
    hit_runs: set[str] = field(default_factory=set)  # 出现过它的 Run，用于"重复观察"晋升

    # 冲突：与已有记忆矛盾时不静默覆盖
    contested_by: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        return est_tokens(self.content)

    @property
    def contested(self) -> bool:
        return bool(self.contested_by)

    def render(self) -> str:
        mark = " ⚠争议" if self.contested else ""
        return f"[{self.kind}]{mark} {self.content}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "kind": str(self.kind),
            "scope": str(self.scope),
            "content": self.content,
            "confidence": round(self.confidence, 3),
            "support": self.support,
            "tags": self.tags,
            "meta": self.meta,
            "created_run": self.created_run,
            "last_used_run": self.last_used_run,
            "use_count": self.use_count,
            "hit_runs": sorted(self.hit_runs),
            "contested_by": self.contested_by,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MemoryItem:
        return cls(
            key=d["key"],
            kind=MemoryKind(d["kind"]),
            scope=Scope(d["scope"]),
            content=d["content"],
            confidence=d.get("confidence", 0.5),
            support=list(d.get("support", ())),
            tags=list(d.get("tags", ())),
            meta=dict(d.get("meta", {})),
            created_run=d.get("created_run", ""),
            last_used_run=d.get("last_used_run", ""),
            use_count=d.get("use_count", 0),
            hit_runs=set(d.get("hit_runs", ())),
            contested_by=list(d.get("contested_by", ())),
        )


def mem_key(kind: MemoryKind, subject: str) -> str:
    """稳定的记忆键。同一主题的同类记忆归到一条，避免长期库里堆同义副本。"""
    from ..ids import slug

    s = slug(subject, max_len=48)
    return f"{kind}:{s}" if s != "x" else f"{kind}:{sha256_hex(subject)[:12]}"
