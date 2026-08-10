"""实体对齐 —— 把多份材料里指向同一概念的不同名字合并成一个实体。

``采购需求计划`` / ``pbpHeader`` / ``PurchasePlan`` 常常是同一个东西。不对齐就会
抽出一堆重复对象，后面的冲突检测全部失真 —— 因为"同一个字段的两个口径"会被误判成
"两个不同字段各有一个口径"。

**结构证据优先于名称证据。** 名字像但结构对不上的，标存疑交人判，**不合并** ——
错误合并会把两个对象的属性混在一起，之后极难拆开；漏合并只是多一条待确认项。
这个不对称决定了这里所有的阈值取向。

流程：阻塞（避免 O(n²)）→ 成对打分 → 连通分量聚类 → 代表选举。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any

from .oir import OIR, ObjectType, Origin, Status

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_SPLIT = re.compile(r"[_\-\s/]+")

#: 结构性后缀。``pbpHeader`` 与 ``purchasePlanHeader`` 的 ``header`` 是同一个
#: 结构角色，不该作为区分度贡献相似度。
_STRUCTURAL = frozenset({"header", "line", "item", "detail", "master", "head",
                         "头", "行", "主", "明细", "表"})


_CJK_RUN = re.compile(r"[㐀-鿿]+")


def tokens(name: str) -> set[str]:
    """拆词：拉丁走 camelCase / snake_case，中文走**字符二元组**。

    中文没有词边界。``采购计划头`` 整体作为一个词元，和 ``采购计划`` 匹配不上 ——
    而业务对象名几乎全是中文，不切分等于放弃了一半的名称证据。二元组是无分词器
    情况下的标准做法：``采购计划头`` → {采购, 购计, 计划, 划头}。
    """
    text = name or ""
    out: set[str] = set()

    for run in _CJK_RUN.findall(text):
        if len(run) == 1:
            out.add(run)
        else:
            out.update(run[i : i + 2] for i in range(len(run) - 1))
        out.update(w for w in _STRUCTURAL if w in run)  # 结构词单独识别出来好剔除

    latin = _CJK_RUN.sub(" ", text)
    parts: list[str] = []
    for p in _SPLIT.split(latin):
        parts.extend(x for x in _CAMEL.split(p) if x)
    out.update(p.lower() for p in parts if len(p) >= 2)

    core = out - _STRUCTURAL
    return core or out  # 全是结构词就别清空了


@dataclass(slots=True)
class PairScore:
    """一对候选的打分明细。**明细必须留着** —— 合并是不可逆操作，
    事后要能回答"当初凭什么把这两个合了"。"""

    a: str
    b: str
    name: float = 0.0
    structure: float = 0.0
    alias: bool = False
    reasons: list[str] = field(default_factory=list)

    @property
    def total(self) -> float:
        # 结构权重高于名称：名字是人取的，结构是数据决定的
        return 0.35 * self.name + 0.65 * self.structure + (0.25 if self.alias else 0.0)

    def to_dict(self) -> dict[str, Any]:
        return {"a": self.a, "b": self.b, "name": round(self.name, 3),
                "structure": round(self.structure, 3), "alias": self.alias,
                "total": round(self.total, 3), "reasons": self.reasons}


@dataclass(frozen=True, slots=True)
class AlignPolicy:
    """阈值。取向是**宁可漏合并，不可错合并**。"""

    merge_at: float = 0.72  # 高于此：合并
    review_at: float = 0.45  # 介于两者：标存疑交人判
    #: 只有名称证据、结构证据为零时，无论名字多像都不自动合并
    require_structural: bool = True


@dataclass(slots=True)
class AlignResult:
    clusters: list[list[str]] = field(default_factory=list)
    merged: dict[str, str] = field(default_factory=dict)  # 被合并的 rid → 代表 rid
    uncertain: list[PairScore] = field(default_factory=list)
    scores: list[PairScore] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "clusters": len(self.clusters),
            "merged_away": len(self.merged),
            "uncertain_pairs": len(self.uncertain),
            "candidates_scored": len(self.scores),
        }


class EntityAligner:
    """对象级实体对齐。"""

    def __init__(self, policy: AlignPolicy | None = None) -> None:
        self.policy = policy or AlignPolicy()

    # ── 主流程 ──────────────────────────────────────────────────
    def align(self, oir: OIR) -> AlignResult:
        objs = list(oir.objects.values())
        result = AlignResult()
        if len(objs) < 2:
            result.clusters = [[o.rid] for o in objs]
            return result

        pairs = self._blocking(objs, oir)
        for a, b in pairs:
            s = self._score(oir, a, b)
            result.scores.append(s)
            if s.total >= self.policy.merge_at:
                if self.policy.require_structural and s.structure <= 0:
                    # 名字像但结构毫无交集 —— 这正是最危险的假阳性
                    s.reasons.append("仅名称相似、无结构证据，不自动合并")
                    result.uncertain.append(s)
                    continue
                result.merged.setdefault(b.rid, a.rid)
            elif s.total >= self.policy.review_at:
                result.uncertain.append(s)

        result.clusters = self._cluster(objs, result.merged)
        result.merged = {m: r for c in result.clusters for r in c[:1] for m in c[1:]}
        return result

    def apply(self, oir: OIR, result: AlignResult) -> list[dict[str, Any]]:
        """把聚类结果落到 OIR 上：属性改挂、别名合并、被并对象移除。"""
        log: list[dict[str, Any]] = []
        for cluster in result.clusters:
            if len(cluster) < 2:
                continue
            rep_rid = self._elect(oir, cluster)
            rep = oir.objects[rep_rid]
            for rid in cluster:
                if rid == rep_rid:
                    continue
                other = oir.objects.pop(rid, None)
                if other is None:
                    continue
                for pr in other.properties:
                    if (p := oir.properties.get(pr)) is not None:
                        p.parent = rep_rid
                        if pr not in rep.properties:
                            rep.properties.append(pr)
                for lt in oir.links.values():
                    if lt.source == rid:
                        lt.source = rep_rid
                    if lt.target == rid:
                        lt.target = rep_rid
                for at in oir.actions.values():
                    at.applies_to = [rep_rid if x == rid else x for x in at.applies_to]
                # 别名不能丢：它是下次遇到同一材料时能立刻认出来的依据
                for alias in (other.api_name.value, other.display_name.value,
                              *other.aliases):
                    if alias and alias not in rep.aliases and alias not in (
                            rep.api_name.value, rep.display_name.value):
                        rep.aliases.append(alias)
                log.append({"merged": rid, "into": rep_rid,
                            "aliases_kept": list(rep.aliases)})
        return log

    # ── 阻塞 ────────────────────────────────────────────────────
    def _blocking(
        self, objs: list[ObjectType], oir: OIR
    ) -> list[tuple[ObjectType, ObjectType]]:
        """生成候选对，避免 O(n²)。

        **三种阻塞键，缺一不可**：

        * 名称词元 —— 最直觉，但对缩写无效（``pbpHeader`` 与
          ``purchasePlanHeader`` 一个词元都不共享）。
        * 别名 —— 术语表里登记过的等价关系，最硬的信号，绝不能在阻塞阶段就丢掉。
        * **共享字段名** —— 结构阻塞。这是缩写场景唯一还能用的信号，也和"结构证据
          优先于名称"这条原则一致。只按名字阻塞，等于让整个打分器看不到最该看的那些对。
        """
        index: dict[str, set[int]] = {}

        def put(key: str, i: int) -> None:
            # 用 set 而不是 list：apiName 与 displayName 相同时同一个对象会被
            # 登记两次，落到成对循环里就变成 (i, i) 自配对
            index.setdefault(key, set()).add(i)

        for i, o in enumerate(objs):
            for t in tokens(o.api_name.value) | tokens(o.display_name.value):
                put(f"n:{t}", i)
            for a in (o.api_name.value, o.display_name.value, *o.aliases):
                if a:
                    put(f"a:{a.lower()}", i)
            for r in o.properties:
                if (p := oir.properties.get(r)) is not None:
                    put(f"p:{p.api_name.value.lower()}", i)

        seen: set[tuple[int, int]] = set()
        for key, id_set in index.items():
            if len(id_set) > 24 and not key.startswith("a:"):
                continue  # 过于常见的键没有区分度；别名例外，它本来就该稀有
            ids = sorted(id_set)
            for x in range(len(ids)):
                for y in range(x + 1, len(ids)):
                    seen.add((ids[x], ids[y]))
        return [(objs[i], objs[j]) for i, j in sorted(seen)]

    # ── 打分 ────────────────────────────────────────────────────
    def _score(self, oir: OIR, a: ObjectType, b: ObjectType) -> PairScore:
        s = PairScore(a=a.rid, b=b.rid)

        # 名称证据
        ta = tokens(a.api_name.value) | tokens(a.display_name.value)
        tb = tokens(b.api_name.value) | tokens(b.display_name.value)
        if ta and tb:
            jacc = len(ta & tb) / len(ta | tb)
            ratio = SequenceMatcher(
                None, a.api_name.value.lower(), b.api_name.value.lower()).ratio()
            s.name = max(jacc, ratio * 0.9)
            if shared := ta & tb:
                s.reasons.append(f"共享词元 {sorted(shared)}")

        # 别名证据：术语表里登记过的等价关系，最硬
        names_a = {a.api_name.value.lower(), a.display_name.value.lower(),
                   *(x.lower() for x in a.aliases)}
        names_b = {b.api_name.value.lower(), b.display_name.value.lower(),
                   *(x.lower() for x in b.aliases)}
        if names_a & names_b:
            s.alias = True
            s.reasons.append(f"别名重合 {sorted(names_a & names_b)}")

        # 结构证据：字段集合重叠 + 主键类型一致
        pa = {oir.properties[r].api_name.value.lower()
              for r in a.properties if r in oir.properties}
        pb = {oir.properties[r].api_name.value.lower()
              for r in b.properties if r in oir.properties}
        if pa and pb and not (pa & pb):
            s.reasons.append("字段集合无交集，无结构证据")
        if pa and pb:
            overlap = len(pa & pb) / min(len(pa), len(pb))
            s.structure = overlap
            s.reasons.append(f"字段重叠 {len(pa & pb)}/{min(len(pa), len(pb))}")
            if self._pk_types(oir, a) and self._pk_types(oir, a) == self._pk_types(oir, b):
                s.structure = min(1.0, s.structure + 0.2)
                s.reasons.append("主键类型一致")
        else:
            s.reasons.append("至少一边没有属性，无结构证据")
        return s

    @staticmethod
    def _pk_types(oir: OIR, o: ObjectType) -> tuple[str, ...]:
        return tuple(str(oir.properties[r].base_type.value)
                     for r in (o.primary_key.value or ()) if r in oir.properties)

    # ── 聚类与代表选举 ──────────────────────────────────────────
    @staticmethod
    def _cluster(objs: list[ObjectType], merged: dict[str, str]) -> list[list[str]]:
        """并查集求连通分量。传递性是必要的：A≡B、B≡C 就该是一个簇。"""
        parent = {o.rid: o.rid for o in objs}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for b, a in merged.items():
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        groups: dict[str, list[str]] = {}
        for o in objs:
            groups.setdefault(find(o.rid), []).append(o.rid)
        return [sorted(v) for v in groups.values()]

    @staticmethod
    def _elect(oir: OIR, cluster: list[str]) -> str:
        """选代表。

        优先有 **DDL 支撑**的：物理名是系统里实际存在的东西，业务名是人的说法，
        前者更适合做 apiName。其次看属性数量 —— 属性多的那个通常是主记录。
        """
        def rank(rid: str) -> tuple[int, int, str]:
            o = oir.objects[rid]
            ddl = any(e.extractor == "sqlglot" or e.locator.get("kind") == "ddl"
                      for e in o.api_name.evidence)
            return (1 if ddl else 0, len(o.properties), rid)

        return max(cluster, key=rank)


def align_and_apply(
    oir: OIR, policy: AlignPolicy | None = None
) -> tuple[AlignResult, list[dict[str, Any]]]:
    """跑完整对齐并落到 OIR 上。返回 ``(结果, 变更账)``。"""
    aligner = EntityAligner(policy)
    result = aligner.align(oir)
    return result, aligner.apply(oir, result)
