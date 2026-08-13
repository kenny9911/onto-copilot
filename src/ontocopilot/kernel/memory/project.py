"""项目记忆 —— 同一项目下的会话共享的那份长期库。

为什么要在 :class:`~.long_term.LongTermStore` 外面再包一层：

1. **隔离靠实例，不靠字段。** ``Scope`` 在检索里完全不参与过滤，``mem_key`` 也是
   ``{kind}:{slug}`` 不含项目 —— 两个项目共用一个 store，同名主题会直接撞进
   ``_merge`` 的争议/覆盖逻辑。所以是一个项目一个实例，边界就是这个对象本身。
2. **store 不会自己落盘。** 它不收 path、不记 path，save/load 是纯手动的。要跨会话
   活下来只能由外面把行装进来、再把行拿回去写库。

3. **两档记忆的入口在这里分岔。** 人拍板走 :meth:`remember_decision`（过晋升闸门），
   模型推断走 :meth:`observe`（进参考档，永远不会晋升）。分岔点只有这一处，
   服务层就不会有第三种写法。

行的形状是纯 dict，键与 ``project_memory`` 表的列名一一对应。kernel 不依赖 store，
所以这里既不 import 也不 return 任何 store 层的类型。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable, Mapping
from typing import Any

from .long_term import LongTermStore, PromotionReason
from .types import MemoryItem, MemoryKind, MemoryTier, Scope, mem_key

#: to_rows/from_rows 的列名。与 store/schema.py 的 ``project_memory`` 对齐；
#: 两边都是手抄的，改一边必须改另一边。
ROW_FIELDS = (
    "project_id",
    "key",
    "tier",
    "kind",
    "content",
    "confidence",
    "support",
    "tags",
    "origin_session",
    "origin_files",
    "contested_by",
    "hit_runs",
    "use_count",
    "created_run",
    "last_used_run",
)


class ProjectMemory:
    """一个项目一个实例。包着 ``LongTermStore``，负责与 repo 的装载/回写。"""

    def __init__(self, project_id: str, store: LongTermStore | None = None) -> None:
        self.project_id = project_id
        self.store = store if store is not None else LongTermStore(project_id)

    # ── 装载 / 回写 ─────────────────────────────────────────────
    @classmethod
    def from_rows(cls, project_id: str, rows: list[Any]) -> ProjectMemory:
        """从库里读出的行重建。不属于本项目的行直接丢掉 —— 隔离是这层的职责。"""
        pm = cls(project_id)
        items = []
        for raw in rows:
            d = _as_dict(raw)
            if str(d.get("project_id", project_id)) != project_id:
                continue
            items.append(MemoryItem.from_dict(_to_item_dict(d)))
        pm.store.adopt(items)
        return pm

    def to_rows(self) -> list[dict[str, Any]]:
        """给 repo 落库用的纯 dict。含 superseded 变体 —— 那是审计留档，不能丢。"""
        rows: list[dict[str, Any]] = []
        for it in self.store.all():
            rows.append(
                {
                    "project_id": self.project_id,
                    "key": it.key,
                    "tier": str(it.tier),
                    "kind": str(it.kind),
                    "content": it.content,
                    "confidence": round(float(it.confidence), 3),
                    "support": list(it.support),
                    "tags": list(it.tags),
                    "origin_session": it.origin_session,
                    "origin_files": list(it.origin_files),
                    "contested_by": list(it.contested_by),
                    "hit_runs": sorted(it.hit_runs),
                    "use_count": int(it.use_count),
                    "created_run": it.created_run,
                    "last_used_run": it.last_used_run,
                }
            )
        return rows

    # ── 写入：两档，两个入口 ────────────────────────────────────
    def remember_decision(self, item: MemoryItem, *, run_id: str = "") -> tuple[bool, str]:
        """人拍板的约定进权威档。``item`` 通常来自 ``Decision.to_memory()``。"""
        if item.tier is MemoryTier.REFERENCE:
            # 参考档不能就地翻牌成权威 —— 那正是"升权威只能靠人重新拍板"要堵的路。
            # 人真拍了板，就该由拍板那一轮新造一条带 support 的权威条目。
            return False, "参考档不能改标成权威 —— 请用本轮拍板的 Decision 重新构造一条"
        item.scope = Scope.PROJECT
        return self.store.promote(item, PromotionReason.HUMAN_CONFIRMED, run_id=run_id)

    def observe(
        self,
        content: str,
        *,
        kind: MemoryKind = MemoryKind.LESSON,
        run_id: str = "",
        session_id: str = "",
        files: Iterable[str] = (),
        support: Iterable[str] = (),
        confidence: float = 0.5,
    ) -> MemoryItem:
        """模型推断出来的教训/事实进参考档。

        返回构造出的条目（不一定就是库里那条：同 key 撞上权威档时会被合并规则挡下）。
        """
        # DECISION 这个 kind 在检索里吃 1.3 prior、在衰减里完全豁免，是留给人拍板的。
        # 推断借它表达就成了既排前又永不过期 —— 改记成 LESSON，它本来就是教训。
        k = MemoryKind.LESSON if kind is MemoryKind.DECISION else kind
        item = MemoryItem(
            key=mem_key(k, content[:48]),
            kind=k,
            scope=Scope.PROJECT,
            content=content,
            confidence=confidence,
            support=list(support),
            tags=["observed"],
            tier=MemoryTier.REFERENCE,
            origin_session=session_id,
            origin_files=list(files),
        )
        self.store.note(item, run_id=run_id)
        return item

    # ── 读取 ────────────────────────────────────────────────────
    def recall(
        self,
        query: str,
        *,
        run_id: str = "",
        current_files: set[str] | None = None,
        top_k: int = 8,
    ) -> list[MemoryItem]:
        return self.store.recall(query, run_id=run_id, limit=top_k, current_files=current_files)

    def authoritative(self) -> list[MemoryItem]:
        """权威档条目。产物的 provenance / decisions 只准取这一份。"""
        return [it for it in self.store.all() if it.tier is MemoryTier.AUTHORITATIVE]

    def __len__(self) -> int:
        return len(self.store)


def _as_dict(row: Any) -> dict[str, Any]:
    """行既可能是 repo 读出的 dict，也可能是它的 dataclass。两种都收，但都当纯数据看。"""
    if isinstance(row, Mapping):
        return dict(row)
    if dataclasses.is_dataclass(row) and not isinstance(row, type):
        return dataclasses.asdict(row)
    raise TypeError(f"项目记忆行必须是 dict 或 dataclass，收到 {type(row).__name__}")


def _to_item_dict(d: Mapping[str, Any]) -> dict[str, Any]:
    """行 → MemoryItem.from_dict 的入参。

    ``project_memory`` 表没有 scope 和 meta 两列（项目记忆按定义就是项目作用域，
    meta 是节点内的临时挂载），所以这里补一个 PROJECT 回去而不是指望行里有。
    """
    return {
        "key": d["key"],
        "kind": d["kind"],
        "scope": str(Scope.PROJECT),
        "content": d["content"],
        "confidence": d.get("confidence", 0.5),
        "support": d.get("support") or [],
        "tags": d.get("tags") or [],
        "created_run": d.get("created_run") or "",
        "last_used_run": d.get("last_used_run") or "",
        "use_count": d.get("use_count") or 0,
        "hit_runs": d.get("hit_runs") or [],
        "contested_by": d.get("contested_by") or [],
        "tier": d.get("tier") or str(MemoryTier.AUTHORITATIVE),
        "origin_session": d.get("origin_session") or "",
        "origin_files": d.get("origin_files") or [],
    }
