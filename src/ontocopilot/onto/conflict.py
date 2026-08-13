"""冲突分类与检测 —— 产品的核心价值。

冲突必须精确分类，因为**不同类型的处置方式完全不同**：命名违规可以自动修，
口径分歧必须问人，疑似敷衍要打回责任人。混成一个"问题列表"就没法自动化了。

分工纪律（架构文档 ADR-5）：能规则化的一律规则化。这里 8 类里有 5 类是纯规则
—— 又快又准又免费又没方差；只有 SEMANTIC_DIVERGENCE、PERFUNCTORY、DUPLICATE
需要语义判断，且都先用启发式收窄候选集再交模型，避免全量喂给 LLM。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..kernel.ids import sha256_hex
from .oir import OIR, Origin, PropertyType, Provenance


class ConflictKind(StrEnum):
    SEMANTIC_DIVERGENCE = "semantic_divergence"  # 同名字段两处口径不一致
    MISSING_REQUIRED = "missing_required"
    NAMING_VIOLATION = "naming_violation"
    DUPLICATE = "duplicate"
    PERFUNCTORY = "perfunctory"  # 疑似敷衍
    ORPHAN = "orphan"
    TYPE_MISMATCH = "type_mismatch"
    MISSING_ACTION = "missing_action"


class Handling(StrEnum):
    """处置方式 —— 决定这条冲突走哪条路。"""

    ASK_USER = "ask_user"  # 必须人拍板
    AUTO_REPAIR = "auto_repair"  # 可逆、零语义损失，系统自动修
    ROUND_TRIP = "round_trip"  # 打回业务方
    HINT = "hint"  # 仅提示


@dataclass(frozen=True, slots=True)
class KindPolicy:
    """每类冲突怎么处置。

    Attributes:
        irreversibility: 决策错了之后的返工代价。主键选择 > 基数 > 命名。
        evidence_decidable: **证据的多寡能否替人做决定**。

            这个字段区分两种性质完全不同的分歧：

            * *事实之争*（口径分歧、重复、类型不符）—— 一边证据碾压另一边时，
              系统可以自己倾向，不必占用人的注意力；
            * *政策选择*（要不要从 OpenAPI 反推 ActionType）—— 「不反推」这个
              选项天然没有证据，但它是个真实的决策。这里按证据平衡度打折会把
              一个该问的问题误判成"系统能自己定"。
    """

    handling: Handling
    irreversibility: float
    evidence_decidable: bool = False


POLICY: dict[ConflictKind, KindPolicy] = {
    ConflictKind.SEMANTIC_DIVERGENCE: KindPolicy(Handling.ASK_USER, 1.0, True),
    ConflictKind.DUPLICATE: KindPolicy(Handling.ASK_USER, 0.8, True),
    ConflictKind.TYPE_MISMATCH: KindPolicy(Handling.ASK_USER, 0.6, True),
    ConflictKind.MISSING_ACTION: KindPolicy(Handling.ASK_USER, 0.7, False),
    ConflictKind.MISSING_REQUIRED: KindPolicy(Handling.ROUND_TRIP, 0.3),
    ConflictKind.PERFUNCTORY: KindPolicy(Handling.ROUND_TRIP, 0.3),
    ConflictKind.NAMING_VIOLATION: KindPolicy(Handling.AUTO_REPAIR, 0.2),
    ConflictKind.ORPHAN: KindPolicy(Handling.HINT, 0.4),
}

#: 兜底选项 —— 参与决策但不参与"证据谁更充分"的比较。
FALLBACK_OPTIONS = frozenset({"defer_to_template", "leave_blank", "keep_declared"})


@dataclass(slots=True)
class Option:
    """一个处置选项。每个都必须能给出证据出处 —— FDE 要能点进去看原文。"""

    id: str
    label: str
    rationale: str = ""
    evidence: list[Provenance] = field(default_factory=list)
    effect: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "label": self.label, "rationale": self.rationale,
            "evidence": [e.to_dict() for e in self.evidence], "effect": self.effect,
        }


@dataclass(slots=True)
class Conflict:
    rid: str
    kind: ConflictKind
    subjects: list[str]  # 涉及的 OIR rid
    summary: str
    evidence: list[Provenance] = field(default_factory=list)
    options: list[Option] = field(default_factory=list)
    owner: str | None = None
    detector: str = "rule"

    @property
    def policy(self) -> KindPolicy:
        return POLICY[self.kind]

    @property
    def handling(self) -> Handling:
        return self.policy.handling

    @property
    def irreversibility(self) -> float:
        return self.policy.irreversibility

    def to_dict(self) -> dict[str, Any]:
        return {
            "rid": self.rid, "kind": str(self.kind), "subjects": self.subjects,
            "summary": self.summary, "handling": str(self.handling),
            "evidence": [e.to_dict() for e in self.evidence],
            "options": [o.to_dict() for o in self.options],
            "owner": self.owner, "detector": self.detector,
        }


def _cid(kind: ConflictKind, *parts: str) -> str:
    return f"cf_{kind}_{sha256_hex('|'.join(parts))[:10]}"


# ══════════════════════════════════════════════════════════════════
#  口径的结构化比较
# ══════════════════════════════════════════════════════════════════
#: 口径不是自由文本 —— 它由若干个正交的轴构成。把轴抽出来做结构化比对，
#: 比让模型读两段中文判断"是否一致"稳定得多，而且能说清**差在哪个轴上**。
_AXES: dict[str, list[tuple[str, str]]] = {
    # 「不含税」里含有「含税」—— 必须用否定回顾，否则前者会被误判成后者。
    # 这是中文口径解析最容易踩的坑，两个取值的语义正好相反。
    "税": [("不含税", r"不含税|未税|净额|\bnet\b"), ("含税", r"(?<!不)(?<!未)含税|价税合计")],
    "时间粒度": [
        ("年度累计", r"年度累计|年累计|全年|annual"),
        ("单次", r"单次|单笔|每次|per[_ ]?time"),
        ("月度", r"月度|按月|monthly"),
    ],
    "口径主体": [("计划", r"计划|预算|budget"), ("执行", r"执行|实际|actual")],
    "币种": [("CNY", r"CNY|人民币|元"), ("USD", r"USD|美元")],
}


#: 注解的起始标记。口径正文永远在最前面，之后是出处、对照说明、备注。
#:
#: 这个切分不是锦上添花 —— 一条写得好的口径常常会顺带说明"与某处在税轴
#: (含税/不含税) 上不同"，整串扫关键词会把注解里提到的对照值当成本条的取值。
#: **模型写得越详细，这个错越容易犯。**
_ANNOTATION_MARKERS = ("（", "(", "注意", "参见", "详见", "另见", "对比", "区别于",
                       "与上", "备注", "说明：", "cf.", "note:")
_LEAD_IN = ("口径：", "口径:", "定义：", "定义:")


def primary_clause(text: str) -> str:
    """取口径的正文部分，丢掉注解。"""
    t = (text or "").strip()
    for lead in _LEAD_IN:
        if (i := t.find(lead)) >= 0:
            t = t[i + len(lead):]
            break
    # 只在标记之后确实没有轴取值时才切。括号有时出现在取值**之前**
    # （"口径（Excel 批注）：含税，年度累计"），照切会把正文整个丢掉。
    for i in sorted(i for m in _ANNOTATION_MARKERS if (i := t.find(m)) > 0):
        head = t[:i]
        if any(re.search(p, head, re.IGNORECASE) for opts in _AXES.values() for _, p in opts):
            return head.strip(" 。；;,，")
    return t.strip(" 。；;,，")


def parse_axes(text: str, *, whole: bool = False) -> dict[str, str]:
    """把一段口径描述解析成轴 → 取值。

    同一轴上多个互斥取值同时出现时，**取最先出现的那个**。口径正文永远写在
    对照注解之前 —— "含税，年度累计。注意与合同域在税轴(含税/不含税)上不同"
    这种写法里，第一个「含税」才是本条的取值。

    按位置判而不是靠切分正文，是因为注解的形态千变万化：括号可能出现在取值
    之前（"口径（Excel 批注）：含税"），也可能在之后。位置规则对两种都成立。

    Args:
        whole: 保留参数以兼容旧调用；当前实现两种模式一致（都按位置解析）。
    """
    body = text or ""
    # 正文里就同时写了两个取值的轴，是真的没写清楚 —— 不给值。
    # 位置规则只用来排除**注解**里提到的对照值，不该用来给含糊的正文强行定性。
    unclear = set(axis_ambiguities(body))
    out: dict[str, str] = {}
    for axis, options in _AXES.items():
        if axis in unclear:
            continue
        hits = [(m.start(), label) for label, pattern in options
                if (m := re.search(pattern, body, re.IGNORECASE))]
        if hits:
            out[axis] = min(hits)[1]
    return out


def axis_ambiguities(text: str) -> list[str]:
    """**正文里**同一轴上出现了多个互斥取值的轴名 —— 这类要打回让人写清楚。

    只看正文：注解里列举对照值是正常写法，不算歧义。
    """
    body = primary_clause(text)
    return [axis for axis, options in _AXES.items()
            if sum(1 for _, p in options if re.search(p, body, re.IGNORECASE)) > 1]


def axis_diff(a: str, b: str) -> dict[str, tuple[str, str]]:
    """两段口径在哪些轴上冲突。只报**两边都识别出且不同**的轴。

    一边识别不出不算冲突 —— 那是信息缺失（MISSING_REQUIRED），不是矛盾。
    """
    pa, pb = parse_axes(a), parse_axes(b)
    return {k: (pa[k], pb[k]) for k in pa.keys() & pb.keys() if pa[k] != pb[k]}


# ══════════════════════════════════════════════════════════════════
#  规则检测器
# ══════════════════════════════════════════════════════════════════
_CAMEL = re.compile(r"^[a-z][a-zA-Z0-9]*$")
_HAS_CJK = re.compile(r"[㐀-鿿]")


def detect_naming(oir: OIR, *, dictionary: Iterable[str] = ()) -> list[Conflict]:
    """命名规范。纯规则 + 词典，可自动修。"""
    known = set(dictionary)
    out: list[Conflict] = []
    for entity in (*oir.objects.values(), *oir.properties.values(),
                   *oir.links.values(), *oir.actions.values()):
        name = entity.api_name.value or ""
        why: list[str] = []
        if _HAS_CJK.search(name):
            why.append("apiName 含中文")
        elif not _CAMEL.match(name):
            why.append("apiName 不是 lowerCamelCase")
        if len(name) <= 3 and name not in known:
            why.append("疑似未登记缩写")
        if not why:
            continue
        fixed = to_camel(name)
        out.append(Conflict(
            rid=_cid(ConflictKind.NAMING_VIOLATION, entity.rid),
            kind=ConflictKind.NAMING_VIOLATION,
            subjects=[entity.rid],
            summary=f"{entity.rid}: {'；'.join(why)}",
            evidence=list(entity.api_name.evidence),
            options=[Option("apply", f"改为 {fixed}", "可逆、零语义损失",
                            effect={"set_api_name": fixed})],
            detector="rule:NAME-01",
        ))
    return out


def detect_missing_required(oir: OIR) -> list[Conflict]:
    """必填缺失。规则，打回责任人。"""
    out: list[Conflict] = []
    for p in oir.properties.values():
        gaps = [
            label for label, ok in (
                ("口径定义", bool((p.definition.value or "").strip())),
                ("显示名", bool((p.display_name.value or "").strip())),
            ) if not ok
        ]
        if not gaps:
            continue
        out.append(Conflict(
            rid=_cid(ConflictKind.MISSING_REQUIRED, p.rid),
            kind=ConflictKind.MISSING_REQUIRED,
            subjects=[p.rid],
            summary=f"{p.api_name.value}: 缺 {'、'.join(gaps)}",
            owner=p.owner,
            detector="rule:REQ-01",
        ))
    for o in oir.objects.values():
        if not o.primary_key.value:
            out.append(Conflict(
                rid=_cid(ConflictKind.MISSING_REQUIRED, o.rid, "pk"),
                kind=ConflictKind.MISSING_REQUIRED, subjects=[o.rid],
                summary=f"{o.api_name.value}: 未声明主键", owner=o.owner,
                detector="rule:REQ-02",
            ))
    return out


def detect_orphans(oir: OIR) -> list[Conflict]:
    """孤立对象。图算法，仅提示 —— 通常意味着遗漏而非错误。"""
    return [
        Conflict(
            rid=_cid(ConflictKind.ORPHAN, o.rid), kind=ConflictKind.ORPHAN,
            subjects=[o.rid],
            summary=f"{o.api_name.value} 与任何对象都没有关系，可能是遗漏",
            evidence=list(o.api_name.evidence), detector="rule:GRAPH-01",
        )
        for o in oir.orphans()
    ]


def detect_missing_actions(oir: OIR, endpoints: list[dict[str, Any]] | None = None) -> list[Conflict]:
    """有对象但无 ActionType。

    设计稿里的杀手锏就在这：不是简单报"缺失"，而是**从 OpenAPI 写操作端点反推
    草稿**再让业务确认。让业务方从"改"开始比从"写"开始完成率高得多。
    """
    missing = oir.objects_without_actions()
    if not missing:
        return []
    eps = endpoints or []

    # **聚合成一个政策问题，而不是每个对象问一次。**
    # 23 个对象都缺 ActionType 时，「要不要从 OpenAPI 反推」是一次决策，不是
    # 23 次。逐个问会瞬间耗尽 FDE 的耐心，而且每问一次答案都一样。
    matched: dict[str, list[dict[str, Any]]] = {}
    for o in missing:
        cands = [e for e in eps if _endpoint_matches(e, o.api_name.value, o.aliases)]
        if cands:
            matched[o.rid] = cands

    covered = len(matched)
    ev = [
        Provenance(
            e.get("file_id", "openapi"), e.get("file_name", "openapi.json"),
            {"kind": "json", "pointer": e.get("pointer", "")},
            snippet=f"{e['method'].upper()} {e['path']} → {e['operationId']}",
            extractor="openapi", confidence=0.85,
        )
        for cands in matched.values() for e in cands[:1]
    ]

    options: list[Option] = []
    if covered:
        options.append(Option(
            "draft_from_openapi",
            f"反推草稿，覆盖 {covered}/{len(missing)} 个对象",
            "标记为 DRAFT_FROM_API 进模板让业务确认 —— 从「改」开始比从「写」"
            "开始完成率高得多",
            evidence=ev[:6],
            effect={"draft_actions": {r: [e["operationId"] for e in c]
                                      for r, c in matched.items()}},
        ))
    options.append(Option("leave_blank", "留空让业务自己填", "预计完成率低于 30%"))

    detail = f"；OpenAPI 里有写端点可覆盖其中 {covered} 个" if covered else "；OpenAPI 里没有可用端点"
    return [Conflict(
        rid=_cid(ConflictKind.MISSING_ACTION, *sorted(o.rid for o in missing)),
        kind=ConflictKind.MISSING_ACTION,
        subjects=[o.rid for o in missing],
        summary=f"{len(missing)} 个对象没有任何 ActionType{detail}",
        evidence=ev[:6], options=options, detector="rule:ACT-01",
    )]


#: 只有写操作端点才可能对应 ActionType。GET 是读，不改变世界状态。
_WRITE_METHODS = frozenset({"post", "put", "patch", "delete"})
_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|[_\-\s/{}]+")


def _endpoint_matches(endpoint: dict[str, Any], api_name: str, aliases: Iterable[str] = ()) -> bool:
    """端点是否可能属于这个对象。

    按 camelCase 拆词后做词元匹配 —— 物理名与业务名混用是常态，整串比对基本
    匹配不上。只取前两个词元：``purchasePlanHeader`` 的 ``Header`` 是结构后缀，
    端点名里通常不出现。
    """
    if str(endpoint.get("method", "")).lower() not in _WRITE_METHODS:
        return False
    hay = f"{endpoint.get('operationId', '')} {endpoint.get('path', '')}".lower()
    hay = re.sub(r"[-_/]", "", hay)
    for name in (api_name, *aliases):
        tokens = [t.lower() for t in _SPLIT.split(name or "") if len(t) >= 3][:2]
        if tokens and all(t.rstrip("s") in hay for t in tokens):
            return True
    return False


def detect_type_mismatch(oir: OIR, profiles: dict[str, dict[str, Any]]) -> list[Conflict]:
    """声明类型与实际数据不符。

    **由确定性 profiler 提供分布统计** —— LLM 无法可靠发现需要跨行统计理解的
    问题（arXiv:2503.06664 的实证结论），这类检测绝不能交给模型。
    """
    out: list[Conflict] = []
    for rid, prof in profiles.items():
        p = oir.properties.get(rid)
        if p is None or (actual := prof.get("inferred_type")) is None:
            continue
        if actual != str(p.base_type.value):
            out.append(Conflict(
                rid=_cid(ConflictKind.TYPE_MISMATCH, rid),
                kind=ConflictKind.TYPE_MISMATCH, subjects=[rid],
                summary=f"{p.api_name.value}: 声明 {p.base_type.value}，"
                        f"实际数据看起来是 {actual}"
                        f"（样本 {prof.get('sample_size', '?')} 行）",
                options=[
                    Option("use_actual", f"改为 {actual}", "以实际数据为准",
                           effect={"set_base_type": actual}),
                    Option("keep_declared", f"保留 {p.base_type.value}",
                           "数据侧需清洗"),
                ],
                detector="profiler:TYPE-01",
            ))
    return out


# ══════════════════════════════════════════════════════════════════
#  语义检测器（先用启发式收窄，再交模型）
# ══════════════════════════════════════════════════════════════════
def detect_semantic_divergence(oir: OIR) -> list[Conflict]:
    """同名属性两处口径不一致 —— 「计划金额」双口径就是这一类。

    先按 apiName 分组找同名属性，再对口径做**结构化轴比对**。类型相同、名字相同、
    只有口径文字不同，所以纯 schema 比对发现不了 —— 这正是本产品的价值所在。
    """
    by_name: dict[str, list[PropertyType]] = {}
    for p in oir.properties.values():
        by_name.setdefault((p.api_name.value or "").lower(), []).append(p)

    out: list[Conflict] = []
    for name, group in by_name.items():
        if len(group) < 2:
            continue

        # **按 apiName 聚成一条，不按两两配对。**
        # 同一个字段在 3 处出现就有 3 对组合，逐对上报会让「计划金额」一个决策
        # 占掉 top-3 里的两三个位置，而 FDE 要做的其实只是一次口径裁决。
        variants: dict[str, list[PropertyType]] = {}
        for p in group:
            key = canonical_axes(p.definition.value or "")
            variants.setdefault(key, []).append(p)
        if len(variants) < 2:
            continue

        reps = [ps[0] for ps in variants.values()]
        diff = axis_diff(reps[0].definition.value or "", reps[1].definition.value or "")
        if not diff:
            continue
        axes = "、".join(f"{k}（{va} vs {vb}）" for k, (va, vb) in diff.items())
        where = f"{len(variants)} 种口径、涉及 {len(group)} 处"
        out.append(Conflict(
            rid=_cid(ConflictKind.SEMANTIC_DIVERGENCE, *sorted(p.rid for p in group)),
            kind=ConflictKind.SEMANTIC_DIVERGENCE,
            subjects=[p.rid for p in group],
            summary=f"「{reps[0].display_name.value or name}」口径不一致（{where}）：{axes}",
            evidence=[e for p in reps for e in p.definition.evidence[:1]],
            options=_divergence_options(reps[0], reps[1], diff, variants),
            detector="rule:AXIS-01",
        ))
    return out


def canonical_axes(text: str) -> str:
    """口径的规范化签名。轴取值相同即视为同一种口径，无论文字怎么写。"""
    ax = parse_axes(text)
    return "|".join(f"{k}={ax[k]}" for k in sorted(ax)) or "∅"


def _divergence_options(
    a: PropertyType, b: PropertyType, diff: dict,
    variants: dict[str, list[PropertyType]] | None = None,
) -> list[Option]:
    ax = "_".join(sorted(diff))
    # 同一种口径下的**所有**属性都要一起改名，不能只改代表那一个 ——
    # 漏掉的那个会在下一轮又被判成新的口径冲突。
    split_rids = ([p.rid for ps in variants.values() for p in ps] if variants
                  else [a.rid, b.rid])
    return [
        Option(
            "split_two_properties",
            f"拆成两个属性：{a.api_name.value}{_suffix(a)} / {b.api_name.value}{_suffix(b)}",
            "信息不丢，但下游报表口径要跟着改",
            evidence=[*a.definition.evidence[:1], *b.definition.evidence[:1]],
            effect={"split": split_rids, "axes": ax},
        ),
        Option("unify_a", f"统一为 A 口径（{_short(a.definition.value)}）",
               "B 处标记为派生，需补换算规则", evidence=list(a.definition.evidence[:1]),
               effect={"unify_to": a.rid}),
        Option("unify_b", f"统一为 B 口径（{_short(b.definition.value)}）",
               "A 处标记为派生，历史数据需回溯", evidence=list(b.definition.evidence[:1]),
               effect={"unify_to": b.rid}),
        Option("defer_to_template", "先不定，转成模板里的业务必填项",
               "推迟到业务方填写时消解", effect={"defer": True}),
    ]


def _short(text: str, limit: int = 40) -> str:
    """选项标签只放口径正文。整段糊上去人读不下去，也就等于没给选项。"""
    body = primary_clause(text) or (text or "")
    return body if len(body) <= limit else body[:limit] + "…"


def _suffix(p: PropertyType) -> str:
    axes = parse_axes(p.definition.value or "")
    tail = {"含税": "TaxIncl", "不含税": "Net", "年度累计": "Annual", "单次": "PerTime"}
    return "".join(tail.get(v, "") for v in axes.values())


#: 疑似敷衍的启发式信号。**先用规则收窄候选，再交 LLM 终判** ——
#: 纯规则会误伤真该填「无」的格子，纯 LLM 又贵又不稳。
PLACEHOLDERS = {"无", "n/a", "na", "-", "—", "待定", "同上", "见附件", "略", "tbd"}


def perfunctory_signals(
    *, value: str, column_header: str = "", ai_prefill: str = "",
    expects_definition: bool = True, column_distinct_ratio: float = 1.0,
) -> list[str]:
    """单元格级的敷衍信号。"""
    v = (value or "").strip()
    s: list[str] = []
    if v and column_header and v == column_header.strip():
        s.append("COPIED_HEADER")
    if v.lower() in PLACEHOLDERS:
        s.append("PLACEHOLDER")
    if expects_definition and 0 < len(v) < 4:
        s.append("TOO_SHORT")
    if ai_prefill and v == ai_prefill.strip():
        # AI 预填了，业务方原样交回 —— 说明他根本没审。不抓出来整个往返闭环
        # 就是自欺欺人。
        s.append("UNCHANGED_PREFILL")
    # 整列一个值只对**自由文本列**才是敷衍信号。枚举列（是/否、已确认/待确认）
    # 和责任人列本来取值就少，按重复率判会把正常填写全部误报成敷衍。
    if expects_definition and column_distinct_ratio < 0.2:
        s.append("BULK_FILLED")
    return s


def detect_perfunctory(cells: list[dict[str, Any]]) -> list[Conflict]:
    """从回传件里挑出疑似敷衍的格子（启发式阶段）。

    命中信号的进 LLM 终判队列；没命中的连模型都不用调。
    """
    out: list[Conflict] = []
    for c in cells:
        sig = perfunctory_signals(
            value=c.get("value", ""), column_header=c.get("column_header", ""),
            ai_prefill=c.get("ai_prefill", ""),
            expects_definition=c.get("expects_definition", True),
            column_distinct_ratio=c.get("column_distinct_ratio", 1.0),
        )
        if not sig:
            continue
        out.append(Conflict(
            rid=_cid(ConflictKind.PERFUNCTORY, c["rid"], c.get("field", "")),
            kind=ConflictKind.PERFUNCTORY, subjects=[c["rid"]],
            summary=f"{c.get('field', '字段')} 疑似敷衍填写（{'、'.join(sig)}）",
            owner=c.get("owner"), detector="heuristic:PERF-01",
        ))
    return out


# ══════════════════════════════════════════════════════════════════
#  汇总
# ══════════════════════════════════════════════════════════════════
def detect_all(
    oir: OIR,
    *,
    endpoints: list[dict[str, Any]] | None = None,
    profiles: dict[str, dict[str, Any]] | None = None,
    dictionary: Iterable[str] = (),
    returned_cells: list[dict[str, Any]] | None = None,
) -> list[Conflict]:
    """跑完全部规则检测器。语义检测器（DUPLICATE 的最终判定）由 critic 补。"""
    out = [
        *detect_semantic_divergence(oir),
        *detect_naming(oir, dictionary=dictionary),
        *detect_missing_required(oir),
        *detect_orphans(oir),
        *detect_missing_actions(oir, endpoints),
        *detect_type_mismatch(oir, profiles or {}),
        *detect_perfunctory(returned_cells or []),
    ]
    for c in out:
        for rid in c.subjects:
            for bucket in (oir.objects, oir.properties, oir.links):
                if (e := bucket.get(rid)) is not None and c.rid not in e.conflicts:
                    e.conflicts.append(c.rid)
    return out


def auto_repair(oir: OIR, conflicts: list[Conflict]) -> list[dict[str, Any]]:
    """执行可自动修的冲突，返回可回滚的变更账。

    **边界很保守**：只有可逆、零语义损失、可完整记账的才自动做。命名规范化满足；
    口径统一不满足（会丢信息，必须问人）。
    """
    log: list[dict[str, Any]] = []
    for c in conflicts:
        if c.handling is not Handling.AUTO_REPAIR or not c.options:
            continue
        effect = c.options[0].effect
        if (new_name := effect.get("set_api_name")) is None:
            continue
        for rid in c.subjects:
            for bucket in (oir.objects, oir.properties, oir.links, oir.actions):
                if (e := bucket.get(rid)) is None:
                    continue
                old = e.api_name.value
                if old == new_name:
                    continue
                e.api_name.value = new_name
                e.api_name.origin = Origin.AUTO_REPAIRED
                log.append({"conflict": c.rid, "rid": rid, "field": "apiName",
                            "from": old, "to": new_name, "reversible": True})
    return log


def to_camel(name: str) -> str:
    """把各种命名风格归一成 lowerCamelCase。中文原样保留 —— 需要人给译名。"""
    parts = [p for p in re.split(r"[_\-\s]+", (name or "").strip()) if p]
    if not parts:
        return name
    if len(parts) == 1 and not re.search(r"[_\-\s]", name):
        return parts[0][0].lower() + parts[0][1:]
    return parts[0].lower() + "".join(p[:1].upper() + p[1:] for p in parts[1:])
