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


class MemoryTier(StrEnum):
    """这条记忆是谁说的 —— 决定它能不能被当真。

    ``scope`` 管的是活多久，``kind`` 管的是长什么样，这里管的是**凭什么信**。
    人的判断可以跨会话传递，机器的猜测只能提示：所以参考档永不晋升
    （见 :class:`~.long_term.PromotionGate`）、进 prompt 必须带来源标注
    （见 :meth:`MemoryItem.render`）、也不许成为产物的出处。
    """

    AUTHORITATIVE = "authoritative"  # 人拍板：跨会话直接生效
    REFERENCE = "reference"  # 模型推断：只作参考


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

    # 出身。默认是权威档 —— 既有调用点全是"人拍板"或"从规范导入"这条线，
    # 默认改成参考会让它们连带降级。新写入的模型推断必须显式标 REFERENCE。
    tier: MemoryTier = MemoryTier.AUTHORITATIVE
    origin_session: str = ""  # 哪个会话得出的，参考档要在 prompt 里报出来
    origin_files: list[str] = field(default_factory=list)  # 当时看的是哪几份材料

    @property
    def tokens(self) -> int:
        return est_tokens(self.content)

    @property
    def contested(self) -> bool:
        return bool(self.contested_by)

    def from_other_material(self, current_files: set[str] | None) -> bool:
        """这条参考记忆是不是在**另一批**材料上得出的。

        同一项目下不同会话上传的材料可能毫无关系，隔着材料得出的结论要再降一档。
        ``origin_files`` 为空 = 不知道来源，不算另一批 —— 不能凭"没记来源"就判它无关。
        """
        if self.tier is not MemoryTier.REFERENCE or not current_files or not self.origin_files:
            return False
        return not (set(self.origin_files) & set(current_files))

    def render(self, *, foreign_material: bool = False) -> str:
        mark = " ⚠争议" if self.contested else ""
        head = f"[{self.kind}]{mark}"
        if self.tier is not MemoryTier.REFERENCE:
            return f"{head} {self.content}"
        # 标注必须挤在**内容前面**：这些行会被拼成一段再按预算整体硬截断
        # （context.py 的 L3），写在条目末尾的免责说明会被切掉，只剩断言本身。
        parts = ["参考"]
        if self.origin_session:
            parts.append(f"来自会话《{self.origin_session}》")
        if foreign_material:
            parts.append("另一份材料")
        parts.append("未确认")
        return f"{head} {'·'.join(parts)}：{self.content}"

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
            "tier": str(self.tier),
            "origin_session": self.origin_session,
            "origin_files": self.origin_files,
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
            # 落盘过的 mem.json 里没有这三个字段，且 LongTermStore.load 对
            # from_dict 没有异常兜底 —— 少一个默认值就是老库一读就崩。
            tier=MemoryTier(d.get("tier", MemoryTier.AUTHORITATIVE)),
            origin_session=d.get("origin_session", ""),
            origin_files=list(d.get("origin_files", ())),
        )


def mem_key(kind: MemoryKind, subject: str) -> str:
    """稳定的记忆键。同一主题的同类记忆归到一条，避免长期库里堆同义副本。"""
    from ..ids import slug

    s = slug(subject, max_len=48)
    return f"{kind}:{s}" if s != "x" else f"{kind}:{sha256_hex(subject)[:12]}"
