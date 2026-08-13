"""主动建议 —— Copilot 里"副驾"的那一半。

反问（:mod:`~.clarify`）解决的是"我不确定，你来定"；建议解决的是"我看出来了，
你要不要"。两者的区别不是语气，是**代价结构**：
反问必须先停下来等人，所以问多了就是骚扰，`theta_ask` 卡得很紧；
建议不阻塞任何事，代价只有一行字，所以可以给得多，但**每条都必须能立刻执行**。
"这里可以再优化一下"不是建议，是废话。

因此这里每条建议都带三样东西：
    · 依据（citations）—— 指回材料里的真实位置，人能自己核；
    · 影响面（impact）—— 采纳会动多少个对象，决定排序；
    · 动作（action + payload）—— 前端能直接调的一次调用，不需要人再翻译一遍。

全部由规则推导。这类判断（命名后缀、孤儿聚集、临时表）规则判得比模型准，也不
花钱 —— ADR-5。
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .oir import (
    OIR,
    Cardinality,
    LinkType,
    ObjectType,
    Status,
    by_user,
    inferred,
    make_rid,
)

__all__ = [
    "Suggestion",
    "SuggestionEngine",
    "SuggestionKind",
    "apply_suggestion",
    "suggest",
]


class SuggestionKind(StrEnum):
    """建议类型。决定前端渲染成什么按钮。"""

    ADD_LINK = "ADD_LINK"             # 补一条关系
    ASK_MATERIAL = "ASK_MATERIAL"     # 找客户要缺失的材料
    EXCLUDE = "EXCLUDE"               # 把不该建模的东西排除出去
    NAMING = "NAMING"                 # 命名规范
    BIND_RULE = "BIND_RULE"           # 把悬空的业务规则挂到对象上
    REVIEW = "REVIEW"                 # 人工复核一批


@dataclass(slots=True)
class Suggestion:
    """一条可执行的建议。"""

    sid: str
    kind: SuggestionKind
    title: str
    rationale: str
    #: 采纳后会影响多少个对象 —— 排序的主轴
    impact: int = 0
    #: 0~1，规则判定的把握。低于 0.5 的措辞要保守。
    confidence: float = 0.8
    citations: list[str] = field(default_factory=list)
    #: 前端可直接执行的动作载荷
    payload: dict[str, Any] = field(default_factory=dict)

    @property
    def score(self) -> float:
        return self.impact * self.confidence

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.sid, "kind": str(self.kind), "title": self.title,
                "rationale": self.rationale, "impact": self.impact,
                "confidence": round(self.confidence, 2),
                "citations": self.citations[:6], "payload": self.payload}


# ══════════════════════════════════════════════════════════════════
#  结构信号
# ══════════════════════════════════════════════════════════════════
#: 主从结构的命名后缀。头/行/明细/关系是国内 ERP 类系统里最稳定的一组约定。
_HEAD = ("header", "head", "hdr", "main", "master")
_LINE = ("line", "lines", "detail", "details", "item", "items", "dtl")
_REL = ("rel", "relation", "ref", "map", "mapping", "link")

#: 不该进本体的技术性表。抽出来了不等于该建模 —— 临时表、日志表、快照表进了
#: 本体，客户在模板里看到一堆看不懂的名字，回填率立刻塌掉。
_TECHNICAL = re.compile(
    r"(tmp|temp|log|logs|his|hist|history|bak|backup|snapshot|stg|staging|"
    r"middle|mid|sync|job|task|batch)$", re.IGNORECASE)


def _split_suffix(api: str) -> tuple[str, str] | None:
    """把 ``pbpHeader`` 拆成 ``('pbp', 'header')``。拆不出来返回 None。"""
    parts = re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", api)
    if len(parts) < 2:
        return None
    return "".join(parts[:-1]), parts[-1].lower()



def _cite(a: Any) -> str:
    """取一条断言的第一处出处。``evidence`` 是列表 —— 一条断言可以由多处材料
    共同支撑，取第一处做展示即可，全列出来会把建议卡片撑爆。"""
    ev = getattr(a, "evidence", None) or []
    return ev[0].cite() if ev else ""


# ══════════════════════════════════════════════════════════════════
#  引擎
# ══════════════════════════════════════════════════════════════════
class SuggestionEngine:
    """从 OIR 的结构里读出该说的话。

    Args:
        min_impact: 影响面小于这个数的建议不出 —— 只动一个对象的事，说了也是噪声。
        limit: 最多出几条。建议不阻塞，但一屏放不下就等于没给。
    """

    def __init__(self, *, min_impact: int = 1, limit: int = 8) -> None:
        self.min_impact = min_impact
        self.limit = limit

    def propose(self, oir: OIR) -> list[Suggestion]:
        out: list[Suggestion] = []
        out += self._head_line_links(oir)
        out += self._objects_without_fields(oir)
        out += self._technical_tables(oir)
        out += self._naming_families(oir)
        out += self._unbound_rules(oir)
        out = [s for s in out if s.impact >= self.min_impact]
        out.sort(key=lambda s: -s.score)
        return out[:self.limit]

    # ── 主从结构 ────────────────────────────────────────────────
    def _head_line_links(self, oir: OIR) -> list[Suggestion]:
        """同词根的 Header / Line 对，中间却没有关系。

        这是登记表类材料最典型的缺口：实体清单一行一个，头和行都在，但"头包含行"
        这件事没有任何一行写出来 —— 它在写表的人脑子里。规则能看出来，因为词根
        相同、后缀一头一行，这不是巧合。
        """
        linked = {(l.source, l.target) for l in oir.links.values()}
        linked |= {(t, s) for s, t in linked}
        by_stem: dict[str, dict[str, ObjectType]] = defaultdict(dict)
        for ot in oir.objects.values():
            sp = _split_suffix(ot.api_name.value)
            if not sp:
                continue
            stem, suf = sp
            role = ("head" if suf in _HEAD else "line" if suf in _LINE
                    else "rel" if suf in _REL else "")
            if role:
                by_stem[stem.lower()].setdefault(role, ot)

        pairs = []
        for stem, roles in sorted(by_stem.items()):
            head, line = roles.get("head"), roles.get("line")
            if head is None or line is None:
                continue
            if (head.rid, line.rid) in linked:
                continue
            pairs.append((stem, head, line))
        if not pairs:
            return []

        cites = [c for _, h, _ in pairs[:6] if (c := _cite(h.api_name))]
        return [Suggestion(
            sid="sg-headline",
            kind=SuggestionKind.ADD_LINK,
            title=f"补 {len(pairs)} 组「头—行」包含关系",
            rationale=(
                "这些对象成对出现、词根相同、后缀一个是头一个是行（"
                + "、".join(f"{h.api_name.value}↔{l.api_name.value}"
                            for _, h, l in pairs[:3])
                + ("……" if len(pairs) > 3 else "")
                + "），但材料里没有任何一行写出它们的从属关系 —— "
                  "写表的人默认它是常识。不补上，下游生成的模型里行数据是游离的，"
                  "删掉一个头不会带走它的行。"),
            impact=len(pairs) * 2,
            confidence=0.85,
            citations=cites,
            payload={"links": [{"source": h.rid, "target": l.rid,
                                "api_name": f"{stem}Lines",
                                "cardinality": "ONE_TO_MANY"}
                               for stem, h, l in pairs]},
        )]

    # ── 有对象没字段 ────────────────────────────────────────────
    def _objects_without_fields(self, oir: OIR) -> list[Suggestion]:
        """对象抽全了、字段一个没有 —— 这不是抽漏，是材料里就没有。

        区分这两件事很重要：抽漏该重试，材料缺该去要材料。判据是有没有行动 ——
        连接口都定义好了却没人写字段，说明字段表在另一份文件里。
        """
        bare = [o for o in oir.objects.values()
                if not o.properties and o.status is not Status.REJECTED]
        if not bare or len(bare) < len(oir.objects) * 0.8:
            return []
        with_action = {r for a in oir.actions.values() for r in a.applies_to}
        hot = [o for o in bare if o.rid in with_action]
        cites = [c for o in (hot or bare)[:5] if (c := _cite(o.api_name))]
        return [Suggestion(
            sid="sg-nofields",
            kind=SuggestionKind.ASK_MATERIAL,
            title=f"{len(bare)} 个对象没有任何字段，需要再要一份字段梳理表",
            rationale=(
                "当前材料是一份**实体清单**，一行一个对象，没有字段列 —— "
                "所以零字段是材料的实情，不是抽取漏了。"
                + (f"其中 {len(hot)} 个对象已经定义了接口却没有字段，"
                   "说明字段定义在另一份文件里。" if hot else "")
                + "没有字段就没有口径，模板发下去客户也没东西可确认。"),
            impact=len(bare),
            confidence=0.9,
            citations=cites,
            payload={"ask": "字段梳理表（每行一个字段：所属对象/字段名/类型/口径/是否必填）",
                     "objects": [o.rid for o in (hot or bare)[:50]]},
        )]

    # ── 技术表 ──────────────────────────────────────────────────
    def _technical_tables(self, oir: OIR) -> list[Suggestion]:
        # 已经标记排除的不再建议 —— 采纳完还挂在那里，用户会以为没生效，
        # 然后再点一次。
        tech = [o for o in oir.objects.values()
                if _TECHNICAL.search(o.api_name.value)
                and o.status is not Status.REJECTED]
        if not tech:
            return []
        return [Suggestion(
            sid="sg-technical",
            kind=SuggestionKind.EXCLUDE,
            title=f"{len(tech)} 个疑似临时/日志表，建议不进本体",
            rationale=(
                "命名以 Tmp/Log/His/Sync 之类结尾（"
                + "、".join(o.api_name.value for o in tech[:4])
                + ("……" if len(tech) > 4 else "")
                + "），这类是技术实现产物，不是业务概念。放进模板会让客户在"
                  "一堆看不懂的名字里找自己那几个，回填率会明显下降。"
                  "**先别删，标记排除即可** —— 万一其中有个是业务表，删了不好找回来。"),
            impact=len(tech),
            confidence=0.7,
            citations=[c for o in tech[:5] if (c := _cite(o.api_name))],
            payload={"objects": [o.rid for o in tech]},
        )]

    # ── 命名家族 ────────────────────────────────────────────────
    def _naming_families(self, oir: OIR) -> list[Suggestion]:
        """多个前缀家族并存，说明这份材料是多个系统拼出来的。"""
        fam: dict[str, list[str]] = defaultdict(list)
        for ot in oir.objects.values():
            m = re.match(r"^([a-z]{2,5})(?=[A-Z])", ot.api_name.value)
            if m:
                fam[m.group(1)].append(ot.api_name.value)
        big = {k: v for k, v in fam.items() if len(v) >= 3}
        if len(big) < 2:
            return []
        top = sorted(big.items(), key=lambda kv: -len(kv[1]))
        return [Suggestion(
            sid="sg-naming",
            kind=SuggestionKind.NAMING,
            title=f"存在 {len(big)} 套命名前缀，建议先定命名规范再回传",
            rationale=(
                "对象名分成了 "
                + "、".join(f"{k}*（{len(v)} 个）" for k, v in top[:4])
                + " 几个家族 —— 通常意味着这份材料是几个子系统各写各的拼起来的。"
                  "跨家族的同名概念很可能是同一个东西，等模板发出去再发现，"
                  "客户已经按两套名字各填了一遍。"),
            impact=sum(len(v) for v in big.values()),
            confidence=0.6,
            citations=[],
            payload={"families": {k: v[:10] for k, v in top}},
        )]

    # ── 悬空规则 ────────────────────────────────────────────────
    def _unbound_rules(self, oir: OIR) -> list[Suggestion]:
        loose = [r for r in oir.rules.values()
                 if not r.applies_to and r.status is Status.CANDIDATE]
        if not loose:
            return []
        return [Suggestion(
            sid="sg-rules",
            kind=SuggestionKind.BIND_RULE,
            title=f"{len(loose)} 条业务规则还没挂到对象上",
            rationale=(
                "这些规则从散文里挖出来了，但材料没点名它约束哪个对象，"
                "抽取时按规矩留空而不是猜。挂错比不挂更糟 —— "
                "错误的约束会被下游当成真的执行。这一批适合一次性人工过一遍，"
                "每条只需要选一个对象。"),
            impact=len(loose),
            confidence=0.95,
            citations=[c for r in loose[:5] if (c := _cite(r.statement))],
            payload={"rules": [{"rid": r.rid, "statement": r.statement.value[:120]}
                               for r in loose[:30]]},
        )]


def suggest(oir: OIR, *, limit: int = 8) -> list[dict[str, Any]]:
    """便捷入口。"""
    return [s.to_dict() for s in SuggestionEngine(limit=limit).propose(oir)]


# ══════════════════════════════════════════════════════════════════
#  执行
# ══════════════════════════════════════════════════════════════════
def apply_suggestion(oir: OIR, sug: dict[str, Any], *, note: str = "") -> dict[str, Any]:
    """把一条建议真的落进 OIR。返回 ``{"changed": [...], "label": str}``。

    在此之前 :func:`suggest` 只产出数据，没有任何代码消费 payload —— 界面上
    "采纳"一句话，产物纹丝不动。**一个采纳不了的建议不如不给**：它让人以为
    自己做了决定，而实际上什么都没发生，等到模板发出去才发现，返工代价最大。

    落地的东西一律标 :attr:`Origin.USER`：这是人拍的板，后续任何自动逻辑
    不得覆盖它。
    """
    kind = str(sug.get("kind") or "")
    payload = sug.get("payload") or {}
    changed: list[str] = []

    if kind == "ADD_LINK":
        for spec in payload.get("links") or []:
            src, tgt = spec.get("source"), spec.get("target")
            if src not in oir.objects or tgt not in oir.objects:
                continue
            api = str(spec.get("api_name") or "")
            rid = make_rid("lt", api)
            if rid in oir.links:
                continue
            try:
                card = Cardinality(str(spec.get("cardinality", "ONE_TO_MANY")).upper())
            except ValueError:
                card = Cardinality.ONE_TO_MANY
            oir.add_link(LinkType(
                rid=rid, api_name=by_user(api, note=note or "采纳「补头—行关系」建议"),
                source=src, target=tgt,
                cardinality=by_user(card, note=note or "头一对多行"),
                join_key=inferred(None)))
            changed.append(rid)

    elif kind == "EXCLUDE":
        # **标记而不是删除。** 万一其中有个是业务表，删了不好找回来 ——
        # 这正是这条建议自己的措辞里承诺过的。
        for rid in payload.get("objects") or []:
            ot = oir.objects.get(rid)
            if ot is None or ot.status is Status.REJECTED:
                continue
            ot.status = Status.REJECTED
            changed.append(rid)

    elif kind == "BIND_RULE":
        # 挂规则要人一条条选对象，这里只能把它们标成待人处理，不能替人挂。
        for item in payload.get("rules") or []:
            br = oir.rules.get(str(item.get("rid") or ""))
            if br is not None and br.status is Status.CANDIDATE:
                br.status = Status.PROPOSED
                changed.append(br.rid)

    return {"kind": kind, "label": str(sug.get("title") or ""), "changed": changed}
