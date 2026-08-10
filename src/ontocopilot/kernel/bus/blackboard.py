"""黑板 —— agent 之间的共享事实层。

**为什么不让 agent 自由对话。** 自由对话有三个致命问题：消息顺序不确定会破坏
重放；token 无界增长；事后说不清"到底是谁认定了这件事"。所以本内核里 agent 间
的一切通信都是**有类型、有记账**的。

黑板承载"很多节点都要用、但不在 DAG 直接路径上"的事实：术语映射、抽取过程中
发现的命名约定、某个 ObjectType 的主键判定。写入 append-only 且带版本。

**冲突不是噪声，是信号。** 两个 agent 对同一个 key 写了不同的值，恰恰就是
「计划金额」双口径这类问题的机器表现形式。所以黑板不做 last-write-wins，
而是把两个版本都留着、标记争议，交给 Critic 与澄清引擎去处理。静默覆盖会让
系统丢掉它唯一一次发现矛盾的机会。
"""

from __future__ import annotations

import fnmatch
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..ids import canonical_json


@dataclass(frozen=True, slots=True)
class Revision:
    """一次写入。"""

    rev: int
    key: str
    value: Any
    by: str  # 写入者：节点 id 或 agent 名
    support: tuple[str, ...] = ()  # evidence locator / 事件引用
    confidence: float = 0.5
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "rev": self.rev,
            "key": self.key,
            "value": self.value,
            "by": self.by,
            "support": list(self.support),
            "confidence": self.confidence,
            "note": self.note,
        }


@dataclass(slots=True)
class Entry:
    """一个 key 的完整历史。"""

    key: str
    revisions: list[Revision] = field(default_factory=list)

    @property
    def current(self) -> Revision:
        """当前采信的版本：可信度最高，同分取最新。"""
        return max(self.revisions, key=lambda r: (r.confidence, r.rev))

    @property
    def contested(self) -> bool:
        """是否存在实质分歧（值不同，而非同值被重复确认）。"""
        return len({canonical_json(r.value) for r in self.revisions}) > 1

    @property
    def variants(self) -> list[Revision]:
        """每个不同取值保留一个代表版本，按可信度降序。"""
        best: dict[str, Revision] = {}
        for r in self.revisions:
            k = canonical_json(r.value)
            if k not in best or (r.confidence, r.rev) > (best[k].confidence, best[k].rev):
                best[k] = r
        return sorted(best.values(), key=lambda r: (-r.confidence, r.rev))

    def writers(self) -> list[str]:
        return list(dict.fromkeys(r.by for r in self.revisions))


#: 订阅回调：(key, 新版本, 是否新产生分歧)
Watcher = Callable[[str, Revision, bool], None]


class Blackboard:
    """共享事实黑板。

    key 建议用命名空间形式：``glossary/采购包``、``naming/apiName_style``、
    ``oir/ot_purchase_plan/primaryKey``。订阅按 glob 匹配。
    """

    def __init__(self) -> None:
        self._entries: dict[str, Entry] = {}
        self._watchers: list[tuple[str, Watcher]] = []
        self._rev = 0

    # ── 写 ──────────────────────────────────────────────────────
    def write(
        self,
        key: str,
        value: Any,
        *,
        by: str,
        support: tuple[str, ...] | list[str] = (),
        confidence: float = 0.5,
        note: str = "",
    ) -> tuple[Revision, bool]:
        """写入一条事实。

        Returns:
            ``(revision, newly_contested)``。``newly_contested`` 为真表示这次
            写入**新产生**了分歧 —— 调度器据此把冲突推给 Critic。
        """
        entry = self._entries.setdefault(key, Entry(key=key))
        was = entry.contested
        self._rev += 1
        rev = Revision(
            rev=self._rev,
            key=key,
            value=value,
            by=by,
            support=tuple(support),
            confidence=confidence,
            note=note,
        )
        entry.revisions.append(rev)
        newly = entry.contested and not was

        for pattern, cb in self._watchers:
            if fnmatch.fnmatchcase(key, pattern):
                cb(key, rev, newly)
        return rev, newly

    # ── 读 ──────────────────────────────────────────────────────
    def read(self, key: str, default: Any = None) -> Any:
        e = self._entries.get(key)
        return e.current.value if e else default

    def entry(self, key: str) -> Entry | None:
        return self._entries.get(key)

    def keys(self, pattern: str = "*") -> list[str]:
        return sorted(k for k in self._entries if fnmatch.fnmatchcase(k, pattern))

    def contested(self) -> list[Entry]:
        """所有存在分歧的条目 —— 冲突检测阶段的输入之一。"""
        return [e for e in self._entries.values() if e.contested]

    def snapshot(self, pattern: str = "*") -> dict[str, Any]:
        return {k: self._entries[k].current.value for k in self.keys(pattern)}

    # ── 订阅 ────────────────────────────────────────────────────
    def watch(self, pattern: str, callback: Watcher) -> None:
        """按 glob 订阅。用于让 Critic 在分歧一出现就介入，而不是等到阶段末尾。"""
        self._watchers.append((pattern, callback))

    # ── 渲染 ────────────────────────────────────────────────────
    def render(self, pattern: str = "*", *, limit: int = 60) -> str:
        """装进 prompt 的形态。争议条目会把所有变体和各自的出处一起给出去 ——
        模型要能看见分歧才可能正确处理它。"""
        lines: list[str] = []
        for k in self.keys(pattern)[:limit]:
            e = self._entries[k]
            if not e.contested:
                r = e.current
                lines.append(f"· {k} = {_fmt(r.value)}　（{r.by}）")
                continue
            lines.append(f"· {k} ⚠ 存在 {len(e.variants)} 种说法：")
            for v in e.variants:
                src = f"，出处 {'、'.join(v.support[:3])}" if v.support else ""
                lines.append(f"    - {_fmt(v.value)}　（{v.by}，置信 {v.confidence:.2f}{src}）")
        return "\n".join(lines)

    # ── 重放重建 ────────────────────────────────────────────────
    def replay(self, revisions: list[dict[str, Any]]) -> None:
        """从事件日志重建黑板状态。恢复 Run 时用。"""
        for d in revisions:
            entry = self._entries.setdefault(d["key"], Entry(key=d["key"]))
            entry.revisions.append(
                Revision(
                    rev=d["rev"],
                    key=d["key"],
                    value=d["value"],
                    by=d["by"],
                    support=tuple(d.get("support", ())),
                    confidence=d.get("confidence", 0.5),
                    note=d.get("note", ""),
                )
            )
            self._rev = max(self._rev, d["rev"])

    def __len__(self) -> int:
        return len(self._entries)


def _fmt(value: Any, limit: int = 90) -> str:
    s = value if isinstance(value, str) else canonical_json(value)
    return s if len(s) <= limit else s[:limit] + "…"
