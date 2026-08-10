"""OIR —— Ontology 中间表示。

与 Palantir 三原语同构（ObjectType / LinkType / ActionType），保证下游可直接消费。

**这个模块只有一个设计要点，但它是整个产品的信任基础**：每个值都包在
:class:`Assertion` 里，强制携带 origin 和 evidence。想给某个字段赋值却拿不出
出处？类型系统逼你显式写 ``origin=INFERRED``，UI 就会用不同样式渲染它，FDE
一眼就知道哪些是系统猜的。

设计稿里 FDE 追问「你是怎么知道中广核的？」—— 系统必须能立刻答出「xlsx 内部
workbook.xml 的绝对保存路径」。答不上来的系统没有商业价值。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Generic, TypeVar

from ..kernel.ids import rid as make_rid

T = TypeVar("T")


# ══════════════════════════════════════════════════════════════════
#  溯源
# ══════════════════════════════════════════════════════════════════
class LocatorKind(StrEnum):
    CELL = "cell"  # xlsx/csv 单元格
    RANGE = "range"  # 行区间
    JSON = "json"  # RFC 6901 JSON Pointer
    DDL = "ddl"  # 表/列 + 源码 span
    PAGE = "page"  # 扫描件页 + bbox
    META = "meta"  # 文档元数据（作者、保存路径）
    #: 模型给的自由文本定位串。**保留原样而不是硬塞进结构化字段** ——
    #: 塞错字段会渲染成乱码，而出处渲染错等于「点回原文」这个承诺失效。
    RAW = "raw"


@dataclass(frozen=True, slots=True)
class Provenance:
    """一条证据的精确位置。"""

    file_id: str
    file_name: str
    locator: dict[str, Any]
    snippet: str = ""
    extractor: str = "llm"  # docling | openapi | sqlglot | ocr | code | llm
    confidence: float = 0.5

    def cite(self) -> str:
        """人可读引用串。UI 上点它就跳到原文并高亮。"""
        loc = self.locator
        match loc.get("kind"):
            case LocatorKind.CELL:
                tail = f"!{loc.get('sheet', '')}!R{loc.get('row')}C{loc.get('col')}"
            case LocatorKind.RANGE:
                r = loc.get("rows", [0, 0])
                tail = f"!{loc.get('sheet', '')}!R{r[0]}-{r[1]}"
            case LocatorKind.JSON:
                tail = f"#{loc.get('pointer', '')}"
            case LocatorKind.DDL:
                tail = f"#{loc.get('object', '')}"
            case LocatorKind.PAGE:
                tail = f"#p{loc.get('page')}"
            case LocatorKind.META:
                tail = f"#{loc.get('field', '')}"
            case LocatorKind.RAW:
                tail = f"#{loc.get('ref', '')}"
            case _:
                tail = ""
        return f"{self.file_name}{tail}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_id": self.file_id, "file_name": self.file_name, "locator": self.locator,
            "snippet": self.snippet[:300], "extractor": self.extractor,
            "confidence": round(self.confidence, 3), "cite": self.cite(),
        }


class Origin(StrEnum):
    EXTRACTED = "extracted"  # 从材料里抽出来的，有 evidence
    INFERRED = "inferred"  # 系统推断的，可能无 evidence —— UI 上要区别渲染
    USER = "user"  # 人填的 / 人拍板的，最高可信
    AUTO_REPAIRED = "auto_repaired"  # 系统自动修的，可回滚


@dataclass(slots=True)
class Assertion(Generic[T]):
    """一个带出处的值。

    ``evidence`` 为空且 ``origin`` 不是 INFERRED/USER 是非法状态 —— 由
    :meth:`validate` 检出，Provenance critic 会把它判成 HIGH。
    """

    value: T
    origin: Origin = Origin.INFERRED
    evidence: list[Provenance] = field(default_factory=list)
    confidence: float = 0.5

    @property
    def grounded(self) -> bool:
        return bool(self.evidence)

    def validate(self, path: str) -> list[str]:
        if self.origin is Origin.EXTRACTED and not self.evidence:
            return [f"{path}: origin=EXTRACTED 但没有 evidence"]
        return []

    def cites(self) -> list[str]:
        return [p.cite() for p in self.evidence]

    def to_dict(self) -> dict[str, Any]:
        return {
            "value": self.value, "origin": str(self.origin),
            "confidence": round(self.confidence, 3),
            "evidence": [p.to_dict() for p in self.evidence],
        }


def extracted(value: T, *ev: Provenance, confidence: float = 0.8) -> Assertion[T]:
    return Assertion(value, Origin.EXTRACTED, list(ev), confidence)


def inferred(value: T, *, confidence: float = 0.4) -> Assertion[T]:
    return Assertion(value, Origin.INFERRED, [], confidence)


def by_user(value: T, *, note: str = "") -> Assertion[T]:
    a = Assertion(value, Origin.USER, [], 0.98)
    if note:
        a.evidence = [Provenance("human", "人工决策", {"kind": "meta", "field": note},
                                 snippet=note, extractor="human", confidence=1.0)]
    return a


# ══════════════════════════════════════════════════════════════════
#  原语
# ══════════════════════════════════════════════════════════════════
class Status(StrEnum):
    CANDIDATE = "candidate"
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    DRAFT_FROM_API = "draft_from_api"  # 从 OpenAPI 反推的 ActionType，待人确认


class BaseType(StrEnum):
    STRING = "STRING"
    INTEGER = "INTEGER"
    DECIMAL = "DECIMAL"
    DATE = "DATE"
    TIMESTAMP = "TIMESTAMP"
    BOOLEAN = "BOOLEAN"
    ENUM = "ENUM"


class Cardinality(StrEnum):
    ONE_TO_ONE = "ONE_TO_ONE"
    ONE_TO_MANY = "ONE_TO_MANY"
    MANY_TO_MANY = "MANY_TO_MANY"


@dataclass(slots=True)
class PropertyType:
    rid: str
    parent: str
    api_name: Assertion[str]
    display_name: Assertion[str]
    base_type: Assertion[BaseType]
    #: ★ 口径。「计划金额」的问题不在类型（都是 DECIMAL），在这里。
    #: 把口径提升为一等结构化字段，冲突检测才有抓手。
    definition: Assertion[str] = field(default_factory=lambda: inferred(""))
    semantic_type: Assertion[str | None] = field(default_factory=lambda: inferred(None))
    unit: Assertion[str | None] = field(default_factory=lambda: inferred(None))
    required: Assertion[bool] = field(default_factory=lambda: inferred(False))
    value_domain: Assertion[list[str] | None] = field(default_factory=lambda: inferred(None))
    owner: str | None = None
    status: Status = Status.CANDIDATE
    conflicts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rid": self.rid, "parent": self.parent, "kind": "PropertyType",
            "apiName": self.api_name.to_dict(), "displayName": self.display_name.to_dict(),
            "baseType": self.base_type.to_dict(), "definition": self.definition.to_dict(),
            "semanticType": self.semantic_type.to_dict(), "unit": self.unit.to_dict(),
            "valueDomain": self.value_domain.to_dict(),
            "required": self.required.to_dict(), "owner": self.owner,
            "status": str(self.status), "conflicts": self.conflicts,
        }


@dataclass(slots=True)
class ObjectType:
    rid: str
    api_name: Assertion[str]
    display_name: Assertion[str]
    description: Assertion[str] = field(default_factory=lambda: inferred(""))
    primary_key: Assertion[list[str]] = field(default_factory=lambda: inferred([]))
    title_property: Assertion[str | None] = field(default_factory=lambda: inferred(None))
    properties: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
    owner: str | None = None
    status: Status = Status.CANDIDATE
    conflicts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rid": self.rid, "kind": "ObjectType",
            "apiName": self.api_name.to_dict(), "displayName": self.display_name.to_dict(),
            "description": self.description.to_dict(),
            "primaryKey": self.primary_key.to_dict(),
            "properties": self.properties, "aliases": self.aliases,
            "owner": self.owner, "status": str(self.status), "conflicts": self.conflicts,
        }


@dataclass(slots=True)
class LinkType:
    rid: str
    api_name: Assertion[str]
    source: str
    target: str
    cardinality: Assertion[Cardinality]
    join_key: Assertion[dict[str, str] | None] = field(default_factory=lambda: inferred(None))
    status: Status = Status.CANDIDATE
    conflicts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rid": self.rid, "kind": "LinkType", "apiName": self.api_name.to_dict(),
            "from": self.source, "to": self.target,
            "cardinality": self.cardinality.to_dict(), "joinKey": self.join_key.to_dict(),
            "status": str(self.status), "conflicts": self.conflicts,
        }


@dataclass(slots=True)
class ActionType:
    rid: str
    api_name: Assertion[str]
    applies_to: list[str] = field(default_factory=list)
    parameters: Assertion[list[dict[str, Any]]] = field(default_factory=lambda: inferred([]))
    effects: Assertion[list[str]] = field(default_factory=lambda: inferred([]))
    #: 从 OpenAPI 反推的来源。设计稿里的杀手锏：没人填 ActionType 时，
    #: 从写操作端点反推草稿再让业务确认，比让他们从零写完成率高得多。
    source_endpoint: Assertion[dict[str, str] | None] = field(
        default_factory=lambda: inferred(None)
    )
    status: Status = Status.CANDIDATE

    def to_dict(self) -> dict[str, Any]:
        return {
            "rid": self.rid, "kind": "ActionType", "apiName": self.api_name.to_dict(),
            "appliesTo": self.applies_to, "parameters": self.parameters.to_dict(),
            "effects": self.effects.to_dict(),
            "sourceEndpoint": self.source_endpoint.to_dict(), "status": str(self.status),
        }


# ══════════════════════════════════════════════════════════════════
#  容器
# ══════════════════════════════════════════════════════════════════

class RuleKind(StrEnum):
    """业务规则的类别。决定它下游变成什么 —— 校验规则进 schema，流程规则进
    ActionType 的前置条件，权限规则进 ActionType 的可见性。"""

    VALIDATION = "VALIDATION"    # 字段/记录级校验
    PROCESS = "PROCESS"          # 流程与状态流转
    AUTHORITY = "AUTHORITY"      # 谁能做什么
    CALCULATION = "CALCULATION"  # 派生与计算口径
    OTHER = "OTHER"


@dataclass(slots=True)
class BusinessRule:
    """一条业务规则。

    梳理表里最有价值也最容易丢的一类内容：整段整段的中文散文，既不是实体也不是
    字段，于是流水线里没有任何容器接得住它，抽出来就被丢掉。规则丢了，下游做出
    来的模型是一具没有约束的骨架 —— 字段都在，但谁都不知道什么时候能改。
    """

    rid: str
    statement: Assertion[str]
    kind: Assertion[RuleKind] = field(default_factory=lambda: inferred(RuleKind.OTHER))
    #: 这条规则约束哪些对象（object rid）。空 = 还没挂上，需要反问。
    applies_to: list[str] = field(default_factory=list)
    #: 承担这条规则的角色，如"采购计划员"。
    actor: Assertion[str] = field(default_factory=lambda: inferred(""))
    status: Status = Status.CANDIDATE

    def to_dict(self) -> dict[str, Any]:
        return {"rid": self.rid, "kind": "BusinessRule",
                "statement": self.statement.to_dict(),
                "ruleKind": self.kind.to_dict(), "appliesTo": self.applies_to,
                "actor": self.actor.to_dict(), "status": str(self.status)}



@dataclass(slots=True)
class OpenQuestion:
    """一个待澄清的问题。

    客户材料里信息密度最高的一份，往往就是一张问卷 —— 150 行全是"我们还需要
    知道什么"。之前它没有容器，于是每一行问题被抽成一个 ObjectType
    （``nodeQuestion46`` / displayName="一条需求能不能只安排部分数量…"），
    既是垃圾又污染了整个 OIR。

    这个容器同时接两个来源：客户自己问卷里搬过来的（``asked_by="customer"``）
    和我们从冲突里生成的（``"system"``）。两者合流之后才是"这个项目上还有多少
    没搞清楚"的完整答案 —— 分开统计只会让人以为已经问完了。
    """

    rid: str
    text: Assertion[str]
    #: 参考选项。已经拆成一条条，模板直接拿去做下拉。
    options: list[str] = field(default_factory=list)
    #: 答复。有答复 = 这是**事实**，不是待办 —— 它带着原始单元格的出处。
    answer: Assertion[str] = field(default_factory=lambda: inferred(""))
    #: 所属流程节点 / 业务场景。
    group: str = ""
    #: 客户自己的编号。回传时要能对上号 —— 他们内部就是按这个编号讨论的。
    code: str = ""
    applies_to: list[str] = field(default_factory=list)
    asked_by: str = "customer"
    owner: str | None = None
    status: Status = Status.CANDIDATE

    @property
    def answered(self) -> bool:
        return bool(self.answer.value.strip())

    def to_dict(self) -> dict[str, Any]:
        return {"rid": self.rid, "kind": "OpenQuestion", "text": self.text.to_dict(),
                "options": self.options, "answer": self.answer.to_dict(),
                "group": self.group, "code": self.code, "appliesTo": self.applies_to,
                "askedBy": self.asked_by, "owner": self.owner,
                "status": str(self.status)}


@dataclass(slots=True)
class OIR:
    """一个项目的完整本体中间表示。"""

    objects: dict[str, ObjectType] = field(default_factory=dict)
    properties: dict[str, PropertyType] = field(default_factory=dict)
    links: dict[str, LinkType] = field(default_factory=dict)
    actions: dict[str, ActionType] = field(default_factory=dict)
    rules: dict[str, BusinessRule] = field(default_factory=dict)
    questions: dict[str, OpenQuestion] = field(default_factory=dict)

    # ── 构建 ────────────────────────────────────────────────────
    def add_object(self, ot: ObjectType) -> ObjectType:
        self.objects[ot.rid] = ot
        return ot

    def add_property(self, pt: PropertyType) -> PropertyType:
        self.properties[pt.rid] = pt
        if (parent := self.objects.get(pt.parent)) and pt.rid not in parent.properties:
            parent.properties.append(pt.rid)
        return pt

    def add_link(self, lt: LinkType) -> LinkType:
        self.links[lt.rid] = lt
        return lt

    def add_action(self, at: ActionType) -> ActionType:
        self.actions[at.rid] = at
        return at

    def add_rule(self, br: BusinessRule) -> BusinessRule:
        self.rules[br.rid] = br
        return br

    def add_question(self, q: OpenQuestion) -> OpenQuestion:
        self.questions[q.rid] = q
        return q

    # ── 查询 ────────────────────────────────────────────────────
    def props_of(self, object_rid: str) -> list[PropertyType]:
        return [self.properties[r] for r in self.objects[object_rid].properties
                if r in self.properties]

    def orphans(self) -> list[ObjectType]:
        """无任何 Link 的孤立对象 —— 通常意味着遗漏，值得提示。"""
        linked = {l.source for l in self.links.values()} | {l.target for l in self.links.values()}
        return [o for o in self.objects.values() if o.rid not in linked]

    def objects_without_actions(self) -> list[ObjectType]:
        covered = {r for a in self.actions.values() for r in a.applies_to}
        return [o for o in self.objects.values() if o.rid not in covered]

    def dependents(self, rid: str) -> list[str]:
        """受某个 rid 影响的实体 —— 澄清引擎算「影响半径」用。"""
        out: list[str] = []
        if rid in self.objects:
            out += self.objects[rid].properties
            out += [l.rid for l in self.links.values() if rid in (l.source, l.target)]
            out += [a.rid for a in self.actions.values() if rid in a.applies_to]
        elif pt := self.properties.get(rid):
            out.append(pt.parent)
            out += [l.rid for l in self.links.values()
                    if l.join_key.value and rid in l.join_key.value.values()]
        return sorted(set(out))

    # ── 校验 ────────────────────────────────────────────────────
    def validate(self) -> list[str]:
        """结构性问题。Schema / Provenance 两个 critic 视角的规则来源。"""
        errs: list[str] = []
        for o in self.objects.values():
            errs += o.api_name.validate(f"{o.rid}.apiName")
            errs += o.display_name.validate(f"{o.rid}.displayName")
            for pk in o.primary_key.value or ():
                if pk not in self.properties:
                    errs.append(f"{o.rid}: 主键引用了不存在的属性 {pk}")
            if not o.primary_key.value:
                errs.append(f"{o.rid}: 未声明主键")
        for p in self.properties.values():
            errs += p.api_name.validate(f"{p.rid}.apiName")
            errs += p.base_type.validate(f"{p.rid}.baseType")
            if p.parent not in self.objects:
                errs.append(f"{p.rid}: 父对象 {p.parent} 不存在")
        for l in self.links.values():
            for side, r in (("from", l.source), ("to", l.target)):
                if r not in self.objects:
                    errs.append(f"{l.rid}: {side} 指向不存在的对象 {r}")
            if not l.join_key.value:
                errs.append(f"{l.rid}: 未声明 joinKey")
        return errs

    # ── 统计 / 序列化 ───────────────────────────────────────────
    def stats(self) -> dict[str, int]:
        return {
            "objects": len(self.objects), "properties": len(self.properties),
            "links": len(self.links), "actions": len(self.actions),
            "rules": len(self.rules),
            "questions": len(self.questions),
            # 未答的那部分才是待办。答过的是事实，混在一起统计会让人以为
            # 还有一大堆没问，或者反过来以为已经问完了。
            "open_questions": sum(1 for q in self.questions.values()
                                  if not q.answered),
            "orphans": len(self.orphans()),
            "confirmed": sum(1 for o in self.objects.values() if o.status is Status.CONFIRMED),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "objects": [o.to_dict() for o in self.objects.values()],
            "properties": [p.to_dict() for p in self.properties.values()],
            "links": [l.to_dict() for l in self.links.values()],
            "rules": [r.to_dict() for r in self.rules.values()],
            "questions": [q.to_dict() for q in self.questions.values()],
            "actions": [a.to_dict() for a in self.actions.values()],
            "stats": self.stats(),
        }


__all__ = [
    "OIR", "ObjectType", "PropertyType", "LinkType", "ActionType",
    "Assertion", "Provenance", "Origin", "Status", "BaseType", "Cardinality",
    "LocatorKind", "extracted", "inferred", "by_user", "make_rid",
    "BusinessRule", "RuleKind", "OpenQuestion", "oir_from_dict",
]


# ══════════════════════════════════════════════════════════════════
#  反序列化
# ══════════════════════════════════════════════════════════════════
def _prov_from(d: dict[str, Any]) -> Provenance:
    return Provenance(
        file_id=str(d.get("file_id") or ""), file_name=str(d.get("file_name") or ""),
        locator=dict(d.get("locator") or {}), snippet=str(d.get("snippet") or ""),
        extractor=str(d.get("extractor") or "llm"),
        confidence=float(d.get("confidence") or 0.5))


def _assert_from(d: Any, *, cast: Any = None) -> Assertion[Any]:
    """还原一条断言。

    ``origin`` 和 ``evidence`` 必须原样还原，不能重建成 inferred —— 一份重启后
    加载回来的 OIR 如果把所有 EXTRACTED 降级成 INFERRED，溯源链就断了，而
    ``Assertion.validate`` 只检查 "EXTRACTED 却没有 evidence" 这一种非法态，
    降级后的东西完全合法、静默通过。
    """
    if not isinstance(d, dict):
        return inferred(d)
    v = d.get("value")
    if cast is not None and v is not None:
        try:
            v = cast(v)
        except (ValueError, KeyError):
            pass
    try:
        origin = Origin(str(d.get("origin") or "inferred"))
    except ValueError:
        origin = Origin.INFERRED
    return Assertion(v, origin, [_prov_from(x) for x in (d.get("evidence") or [])],
                     float(d.get("confidence") or 0.5))


def _status_from(v: Any) -> Status:
    try:
        return Status(str(v))
    except ValueError:
        return Status.CANDIDATE


def oir_from_dict(data: dict[str, Any]) -> OIR:
    """从 :meth:`OIR.to_dict` 的产物还原。

    没有这个函数的后果是**进程重启即失能**：产物 oir.json 还在磁盘上，但服务
    起来之后没有任何路径能把它变回一个活的 OIR，于是"回答问题""采纳建议"
    "重出模板""审核回传"全部 409 —— 用户看着一个有产物的会话，什么都做不了。
    """
    oir = OIR()
    for o in data.get("objects", ()):
        oir.objects[o["rid"]] = ObjectType(
            rid=o["rid"], api_name=_assert_from(o.get("apiName")),
            display_name=_assert_from(o.get("displayName")),
            description=_assert_from(o.get("description")),
            primary_key=_assert_from(o.get("primaryKey")),
            properties=list(o.get("properties") or []),
            aliases=list(o.get("aliases") or []),
            owner=o.get("owner"), status=_status_from(o.get("status")),
            conflicts=list(o.get("conflicts") or []))
    for x in data.get("properties", ()):
        oir.properties[x["rid"]] = PropertyType(
            rid=x["rid"], parent=x.get("parent", ""),
            api_name=_assert_from(x.get("apiName")),
            display_name=_assert_from(x.get("displayName")),
            base_type=_assert_from(x.get("baseType"), cast=BaseType),
            definition=_assert_from(x.get("definition")),
            semantic_type=_assert_from(x.get("semanticType")),
            unit=_assert_from(x.get("unit")),
            value_domain=_assert_from(x.get("valueDomain")),
            required=_assert_from(x.get("required")),
            owner=x.get("owner"), status=_status_from(x.get("status")),
            conflicts=list(x.get("conflicts") or []))
    for l in data.get("links", ()):
        oir.links[l["rid"]] = LinkType(
            rid=l["rid"], api_name=_assert_from(l.get("apiName")),
            source=l.get("from", ""), target=l.get("to", ""),
            cardinality=_assert_from(l.get("cardinality"), cast=Cardinality),
            join_key=_assert_from(l.get("joinKey")),
            status=_status_from(l.get("status")),
            conflicts=list(l.get("conflicts") or []))
    for a in data.get("actions", ()):
        oir.actions[a["rid"]] = ActionType(
            rid=a["rid"], api_name=_assert_from(a.get("apiName")),
            applies_to=list(a.get("appliesTo") or []),
            parameters=_assert_from(a.get("parameters")),
            effects=_assert_from(a.get("effects")),
            source_endpoint=_assert_from(a.get("sourceEndpoint")),
            status=_status_from(a.get("status")))
    for r in data.get("rules", ()):
        oir.rules[r["rid"]] = BusinessRule(
            rid=r["rid"], statement=_assert_from(r.get("statement")),
            kind=_assert_from(r.get("ruleKind"), cast=RuleKind),
            applies_to=list(r.get("appliesTo") or []),
            actor=_assert_from(r.get("actor")), status=_status_from(r.get("status")))
    for q in data.get("questions", ()):
        oir.questions[q["rid"]] = OpenQuestion(
            rid=q["rid"], text=_assert_from(q.get("text")),
            options=list(q.get("options") or []),
            answer=_assert_from(q.get("answer")), group=str(q.get("group") or ""),
            code=str(q.get("code") or ""),
            applies_to=list(q.get("appliesTo") or []),
            asked_by=str(q.get("askedBy") or "customer"), owner=q.get("owner"),
            status=_status_from(q.get("status")))
    return oir
