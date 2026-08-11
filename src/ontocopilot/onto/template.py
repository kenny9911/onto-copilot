"""模板编译器 —— OIR → 可发给业务方填写的 xlsx。

三个设计要点：

1. **隐藏锚点列**（架构文档 ADR-4）。每行带 ``_oir_rid``（稳定 ID）与
   ``_oir_hash``（预填内容哈希）。业务方会任意增删行、重排序、改列宽 —— 没有
   锚点就只能做模糊匹配，回传审核精度会崩。有锚点才能做单元格级 diff，也才抓得到
   「AI 预填了但被原样交回」这种情况。

2. **样式即语义**。黄底=业务必填，灰底锁定=已定只读，白底=可改，红角标=有冲突。
   业务方不用读说明就知道该动哪里。

3. **校验前移**。枚举做下拉、口径做正则、冲突写批注 —— 在业务方那一端就拦住
   一部分错误，比回传后再打回便宜得多。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from ..kernel.ids import sha256_hex
from .conflict import Conflict
from .oir import OIR, Origin, Status

ANCHOR_RID = "_oir_rid"
ANCHOR_HASH = "_oir_hash"


class Role(StrEnum):
    """单元格角色，决定样式与审核规则。"""

    LOCKED = "locked"  # 已定，只读（灰）
    PREFILLED = "prefilled"  # AI 预填，可改（白）
    REQUIRED = "required"  # 业务必填（黄）
    GUIDE = "guide"  # 填写指引


#: 完成度加权。主键错了整张表报废，备注空着无所谓 —— 权重必须反映这个差异，
#: 否则"完成度 68%"这个数字没有决策价值。
WEIGHTS: dict[str, float] = {
    # 答复和规则确认是这轮真正要的东西，权重最高。primaryKey 从 5.0 降到 1.0：
    # 实测它一列独占完成度权重的 58%，而 172 行全空、只有 FDE 填得了、
    # 且填了也永远不会被写回 OIR —— 一个填不了也没用的东西不该主导达标线。
    "答复": 5.0,
    "这条对吗": 3.0,
    "执行角色": 2.0,
    "管哪个单据": 2.0,
    "primaryKey": 1.0,
    "definition": 4.0,
    "displayName": 2.0,
    "cardinality": 3.0,
    "description": 1.0,
    "owner": 1.0,
    "note": 0.5,
}


@dataclass(slots=True)
class Cell:
    rid: str
    sheet: str
    field: str
    value: str
    role: Role
    owner: str | None = None
    comment: str = ""
    options: list[str] | None = None  # 枚举 → 下拉
    conflict: bool = False
    #: 这格是否期望**成段的自由文本**。
    #:
    #: 敷衍检测的启发式（太短、整列一个值）只对自由文本成立。枚举列和责任人列
    #: 本来取值就少且短，套同一套规则会把正常填写全部误报成敷衍。由编译期显式
    #: 标注而不是运行时猜 —— 编译期知道这格是什么，运行时只能靠字符串猜。
    expects_prose: bool = False

    @property
    def weight(self) -> float:
        return WEIGHTS.get(self.field, 1.0)

    @property
    def prefill_hash(self) -> str:
        """预填内容的哈希。回传时比一下就知道这格有没有被动过。"""
        return sha256_hex(self.value)[:12] if self.value else ""

    def to_dict(self) -> dict[str, Any]:
        return {"rid": self.rid, "sheet": self.sheet, "field": self.field,
                "value": self.value, "role": str(self.role), "owner": self.owner,
                "comment": self.comment, "options": self.options,
                "conflict": self.conflict, "expects_prose": self.expects_prose}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Cell":
        return cls(rid=d["rid"], sheet=d["sheet"], field=d["field"], value=d["value"],
                   role=Role(d["role"]), owner=d.get("owner"), comment=d.get("comment", ""),
                   options=d.get("options"), conflict=d.get("conflict", False),
                   expects_prose=d.get("expects_prose", False))


@dataclass(slots=True)
class Sheet:
    name: str
    guide: str
    columns: list[str]
    rows: list[dict[str, Cell]] = field(default_factory=list)


@dataclass(slots=True)
class TemplateSpec:
    """编译结果。写 xlsx 与回传审核共用这一份规格 —— 两边对不上是最难查的 bug。"""

    sheets: list[Sheet] = field(default_factory=list)
    round: int = 1

    def cells(self) -> list[Cell]:
        return [c for s in self.sheets for r in s.rows for c in r.values()]

    def by_rid(self) -> dict[tuple[str, str], Cell]:
        return {(c.rid, c.field): c for c in self.cells()}

    # ── 持久化 ──────────────────────────────────────────────────
    # 发模板和审回传通常是两次独立的进程调用（中间隔着业务方填写的几天），
    # 所以规格必须能落盘再读回 —— 两边对不上是最难查的一类 bug。
    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "sheets": [
                {"name": sh.name, "guide": sh.guide, "columns": sh.columns,
                 "rows": [{k: c.to_dict() for k, c in row.items()} for row in sh.rows]}
                for sh in self.sheets
            ],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TemplateSpec":
        spec = cls(round=d.get("round", 1))
        for sh in d.get("sheets", ()):
            sheet = Sheet(name=sh["name"], guide=sh.get("guide", ""),
                          columns=list(sh.get("columns", ())))
            sheet.rows = [{k: Cell.from_dict(c) for k, c in row.items()}
                          for row in sh.get("rows", ())]
            spec.sheets.append(sheet)
        return spec

    def save(self, path: "Path | str") -> "Path":
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1),
                     encoding="utf-8")
        return p

    @classmethod
    def load(cls, path: "Path | str") -> "TemplateSpec":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def stats(self) -> dict[str, Any]:
        cells = self.cells()
        filled = [c for c in cells if c.role in (Role.LOCKED, Role.PREFILLED) and c.value]
        required = [c for c in cells if c.role is Role.REQUIRED]
        owners: dict[str, int] = {}
        for c in required:
            if c.owner:
                owners[c.owner] = owners.get(c.owner, 0) + 1
        return {
            "sheets": len(self.sheets),
            "total_cells": len(cells),
            "prefilled": len(filled),
            "prefill_rate": round(len(filled) / max(1, len(cells)), 3),
            "business_required": len(required),
            "conflicts": sum(1 for c in cells if c.conflict),
            "owners": dict(sorted(owners.items(), key=lambda p: -p[1])),
        }


# ══════════════════════════════════════════════════════════════════
#  编译
# ══════════════════════════════════════════════════════════════════
def compile_template(
    oir: OIR, conflicts: list[Conflict] | None = None, *, round_no: int = 1
) -> TemplateSpec:
    """把 OIR 编译成填写模板规格。"""
    conflicted = {rid for c in (conflicts or []) for rid in c.subjects}
    notes: dict[str, list[str]] = {}
    for c in conflicts or ():
        for rid in c.subjects:
            notes.setdefault(rid, []).append(c.summary)

    spec = TemplateSpec(round=round_no)
    # 顺序即优先级：业务人员从上往下填，最该他答的排在最前面。
    # 待澄清问题和业务规则以前根本不在模板里 —— OIR 里最贵的两类内容在编译这
    # 一步整体蒸发，而剩下的 apiName / baseType / cardinality 他一列都读不懂。
    for build in (_sheet_questions, _sheet_rules):
        sh = build(oir)
        if sh.rows:
            spec.sheets.append(sh)
    spec.sheets.append(_sheet_objects(oir, conflicted, notes))
    for build2 in (_sheet_properties, _sheet_links):
        sh = build2(oir, conflicted, notes)
        # **空表一律不出。** 一张只有表头的「属性明细」配上一句"口径定义是本轮
        # 重点"，是这份模板给业务方最强的指令指向一张空表。
        if sh.rows:
            spec.sheets.append(sh)
    for build3 in (_sheet_actions, _sheet_glossary):
        sh = build3(oir)
        if sh.rows:
            spec.sheets.append(sh)
    return spec


#: 期望成段自由文本的字段。敷衍启发式只对这些成立。
PROSE_FIELDS = frozenset({"definition", "description"})


def _cell(rid, sheet, fld, value, role, *, owner=None, comment="", options=None, conflict=False):
    return Cell(rid=rid, sheet=sheet, field=fld, value=value or "", role=role,
                owner=owner, comment=comment, options=options, conflict=conflict,
                expects_prose=fld in PROSE_FIELDS and not options)


def _evidence_note(assertion: Any) -> str:
    """把证据出处写进批注。业务方对某个预填值有疑问时，能直接看到系统凭什么这么填。"""
    if not assertion.evidence:
        return "（无证据支撑，系统推断）" if assertion.origin is Origin.INFERRED else ""
    lines = [f"{e.cite()}：{e.snippet[:80]}" for e in assertion.evidence[:3]]
    return "依据\n" + "\n".join(lines)


def _sheet_objects(oir: OIR, conflicted: set[str], notes: dict[str, list[str]]) -> Sheet:
    sh = Sheet(
        "01_对象清单",
        "本表列出系统从材料中识别出的业务对象。灰底=已定，无需改动；黄底=需要你确认或补充。",
        ["apiName", "displayName", "description", "primaryKey", "owner"],
    )
    for o in oir.objects.values():
        cf = o.rid in conflicted
        note = "\n".join(notes.get(o.rid, ()))
        sh.rows.append({
            "apiName": _cell(o.rid, sh.name, "apiName", o.api_name.value, Role.LOCKED,
                             comment=_evidence_note(o.api_name)),
            "displayName": _cell(o.rid, sh.name, "displayName", o.display_name.value,
                                 Role.PREFILLED, owner=o.owner,
                                 comment=_evidence_note(o.display_name)),
            "description": _cell(o.rid, sh.name, "description", o.description.value,
                                 Role.REQUIRED, owner=o.owner,
                                 comment="请一句话说明这个对象在业务里代表什么"),
            # primaryKey **不向业务方要**。实测：172 行全空、一列独占完成度权重
            # 的 58%、只有 FDE 答得了（"主键"是数据建模词汇），而且填了也永远
            # 不会被 merge_into_oir 写回 —— 一个填不了、填了也没用的必填格，
            # 唯一的作用是把达标线永远压在够不到的地方。
            "primaryKey": _cell(o.rid, sh.name, "primaryKey",
                                "、".join(o.primary_key.value or ()),
                                Role.PREFILLED if o.primary_key.value else Role.LOCKED,
                                owner=o.owner, comment=_evidence_note(o.primary_key),
                                conflict=cf),
            # owner 同理：172 行全空、没有任何说明该填岗位还是人名，
            # 而"这批单据归谁"是**一次**能答完的事，不该逐行问 172 遍。
            "owner": _cell(o.rid, sh.name, "owner", o.owner or "",
                           Role.PREFILLED if o.owner else Role.LOCKED,
                           owner=o.owner, comment=note),
        })
    return sh


def _sheet_properties(oir: OIR, conflicted: set[str], notes: dict[str, list[str]]) -> Sheet:
    sh = Sheet(
        "02_属性明细",
        "口径定义是本轮的重点：请写清楚这个字段到底统计的是什么（含税/不含税、"
        "时间粒度、口径主体）。红角标的格子存在冲突，批注里有详情。",
        ["parent", "apiName", "baseType", "definition", "unit", "required", "owner"],
    )
    base_types = [t.value for t in __import__(
        "ontocopilot.onto.oir", fromlist=["BaseType"]).BaseType]
    for p in oir.properties.values():
        cf = p.rid in conflicted
        parent = oir.objects.get(p.parent)
        sh.rows.append({
            "parent": _cell(p.rid, sh.name, "parent",
                            parent.display_name.value if parent else p.parent, Role.LOCKED),
            "apiName": _cell(p.rid, sh.name, "apiName", p.api_name.value, Role.LOCKED,
                             comment=_evidence_note(p.api_name)),
            "baseType": _cell(p.rid, sh.name, "baseType", str(p.base_type.value),
                              Role.PREFILLED, options=base_types,
                              comment=_evidence_note(p.base_type)),
            # ★ 口径永远是业务必填 —— 系统抽出来的只是候选，必须有人认领
            "definition": _cell(p.rid, sh.name, "definition", p.definition.value,
                                Role.REQUIRED, owner=p.owner, conflict=cf,
                                comment="\n".join([*notes.get(p.rid, ()),
                                                   _evidence_note(p.definition)]).strip()),
            "unit": _cell(p.rid, sh.name, "unit", p.unit.value or "", Role.PREFILLED,
                          owner=p.owner),
            "required": _cell(p.rid, sh.name, "required",
                              "是" if p.required.value else "否", Role.PREFILLED,
                              options=["是", "否"], owner=p.owner),
            "owner": _cell(p.rid, sh.name, "owner", p.owner or "",
                           Role.PREFILLED if p.owner else Role.REQUIRED, owner=p.owner),
        })
    return sh


def _sheet_links(oir: OIR, conflicted: set[str], notes: dict[str, list[str]]) -> Sheet:
    sh = Sheet(
        "03_关系清单",
        "请确认两个对象之间的对应关系。一对多还是多对多，直接影响下游能不能建出正确的工作流。",
        ["apiName", "from", "to", "cardinality", "joinKey"],
    )
    cards = ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"]
    for lt in oir.links.values():
        src, tgt = oir.objects.get(lt.source), oir.objects.get(lt.target)
        sh.rows.append({
            "apiName": _cell(lt.rid, sh.name, "apiName", lt.api_name.value, Role.LOCKED),
            "from": _cell(lt.rid, sh.name, "from",
                          src.display_name.value if src else lt.source, Role.LOCKED),
            "to": _cell(lt.rid, sh.name, "to",
                        tgt.display_name.value if tgt else lt.target, Role.LOCKED),
            "cardinality": _cell(lt.rid, sh.name, "cardinality", str(lt.cardinality.value),
                                 Role.REQUIRED, options=cards, conflict=lt.rid in conflicted,
                                 comment="\n".join([*notes.get(lt.rid, ()),
                                                    _evidence_note(lt.cardinality)]).strip()),
            "joinKey": _cell(lt.rid, sh.name, "joinKey",
                             json.dumps(lt.join_key.value, ensure_ascii=False)
                             if lt.join_key.value else "", Role.LOCKED),
        })
    return sh



#: 只读动作的动词。判据是**接口路径里的动词**，不是接口名 —— 名字可以随便起，
#: 路径是实际调用的东西。
_READ_VERBS = ("query", "get", "list", "search", "find", "fetch", "detail",
               "page", "export", "download", "view", "read")


def _read_only(action: Any) -> bool:
    """这个动作改不改数据。改不了的，"影响范围"就不该问人。"""
    ep = action.source_endpoint.value or {}
    blob = f"{action.api_name.value} {ep.get('path', '')} {ep.get('display', '')}".lower()
    if any(v in blob for v in ("create", "update", "delete", "save", "submit",
                               "cancel", "approve", "import", "subtract", "close")):
        return False
    return any(v in blob for v in _READ_VERBS)


def _sheet_actions(oir: OIR) -> Sheet:
    sh = Sheet(
        "04_动作清单",
        "带「待确认」的是系统从 OpenAPI 反推的草稿。请核对参数与影响范围 —— "
        "改比从零写快得多，但草稿未经确认不算数。",
        ["apiName", "appliesTo", "sourceEndpoint", "effects", "confirmed"],
    )
    for a in oir.actions.values():
        drafted = a.status is Status.DRAFT_FROM_API
        ep = a.source_endpoint.value or {}
        sh.rows.append({
            "apiName": _cell(a.rid, sh.name, "apiName", a.api_name.value, Role.PREFILLED,
                             comment=_evidence_note(a.api_name)),
            "appliesTo": _cell(a.rid, sh.name, "appliesTo", "、".join(a.applies_to),
                               Role.PREFILLED),
            "sourceEndpoint": _cell(a.rid, sh.name, "sourceEndpoint",
                                    f"{ep.get('method', '').upper()} {ep.get('path', '')}".strip(),
                                    Role.LOCKED, comment=_evidence_note(a.source_endpoint)),
            # 查询类接口不改任何数据，"影响范围"的答案是确定的 —— 逐个问
            # 111 遍里有一半是在问同一个已知答案。
            "effects": _cell(a.rid, sh.name, "effects",
                             "只读，不改动单据" if _read_only(a) else
                             "、".join(a.effects.value or ()),
                             Role.LOCKED if _read_only(a) else Role.REQUIRED),
            # 只有**真的是草稿**的才要确认。111 行全预填「已确认」再要人确认一遍，
            # 结果是他核对后觉得没问题、不动，然后被判敷衍 —— 实测这一条让
            # "每格都认真填满"的完成度卡在 0.8861，永远够不到 0.95。
            "confirmed": _cell(a.rid, sh.name, "confirmed", "待确认" if drafted else "已确认",
                               Role.REQUIRED if drafted else Role.PREFILLED,
                               options=["已确认", "待确认", "不适用"]),
        })
    return sh



#: 问题表可能出现的列，按**这份材料实际有的东西**取子集。
#:
#: 以前这五列是写死的（节点 | 编号 | 澄清问题 | 参考选项 | 答复），照抄的是某一位
#: 客户那份问卷的样子。换一份没有问卷的材料，「编号」和「参考选项」就是两列
#: 从头空到尾的空格 —— 业务方看到空列的第一反应是"这是不是要我填"，而它们
#: 根本没有内容可填。列要么有内容，要么不出现。
_Q_COLUMNS: tuple[tuple[str, Any], ...] = (
    ("所属部分", lambda q: q.group),
    ("编号", lambda q: q.code),
    ("澄清问题", lambda q: q.text.value),
    ("参考选项", lambda q: "　".join(f"{i + 1}）{o}" for i, o in enumerate(q.options))),
    ("答复", lambda q: ""),
    ("材料出处", lambda q: q.text.evidence[0].cite() if q.text.evidence else ""),
)

#: 无论如何都要出的两列。没有问题正文就没有这张表，没有答复栏就没法回收。
_Q_REQUIRED_COLUMNS = frozenset({"澄清问题", "答复"})


def _sheet_questions(oir: OIR) -> Sheet:
    """待澄清问题。

    这张表以前不存在 —— 150 个待澄清问题在编译到 xlsx 这一步整体蒸发，而它们是
    整份 OIR 里**信息密度最高**的内容：客户自己写的、按流程节点分好组、带参考
    选项、只差一个答复。

    问题的来源现在有三条（客户问卷 / 流程图缺口 / 证据里挖出来的缺口），三条给的
    字段不一样：问卷带编号和参考选项，挖出来的带出处和分组。所以**列是算出来的**
    ——哪一列有内容才出哪一列。参考选项原样保留 ①②③ 不做下拉：有的问题答案不在
    选项里，做成下拉等于逼人二选一。

    「材料出处」是新加的一列。业务方对一个问题的第一反应通常是"这是从哪儿冒出来
    的"，答不上来他就跳过了；写清楚"业务规则!R47"，他能自己翻回去看上下文。
    """
    pending = [q for q in oir.questions.values() if not q.answered]
    # 客户自己提的排最前 —— 那是他本来就想问的，比我们发现的任何缺口都该先答。
    pending.sort(key=lambda q: (q.asked_by != "customer", q.group, q.code))

    cols = [name for name, get in _Q_COLUMNS
            if name in _Q_REQUIRED_COLUMNS or any(str(get(q)).strip() for q in pending)]
    sh = Sheet("02_待澄清问题",
               "这些是梳理过程中没法从材料里确定的事。答复栏按你了解的实际情况填，"
               "拿不准就写「不确定」——写不确定比猜一个有用。"
               + ("　带「材料出处」的可以按出处翻回原文核对。" if "材料出处" in cols else ""),
               cols)
    getters = dict(_Q_COLUMNS)
    for q in pending:
        row = {}
        for name in cols:
            row[name] = _cell(
                q.rid, sh.name, name, str(getters[name](q)),
                Role.REQUIRED if name == "答复" else Role.LOCKED,
                comment=_evidence_note(q.text) if name == "澄清问题" else "")
        sh.rows.append(row)
    return sh


def _sheet_rules(oir: OIR) -> Sheet:
    """业务规则确认。

    规则原文是成段中文，业务专家一眼能读。要他补的只有两件他知道、而系统猜不到
    的事：**这条归谁执行**，以及**这条管的是哪个单据**。两列都短，答起来快。
    """
    sh = Sheet("03_业务规则确认",
               "下面是从材料里挖出来的业务规则。请确认它对不对、归谁执行、管的是哪个单据。",
               ["规则原文", "执行角色", "管哪个单据", "这条对吗"])
    by_rid = {o.rid: o.display_name.value for o in oir.objects.values()}
    for r in oir.rules.values():
        hosts = "、".join(by_rid.get(h, h) for h in r.applies_to)
        sh.rows.append({
            "规则原文": _cell(r.rid, sh.name, "规则原文", r.statement.value, Role.LOCKED,
                          comment=_evidence_note(r.statement)),
            # 系统读到了就预填，没读到才要人填 —— 已经知道的不该再问一遍
            "执行角色": _cell(r.rid, sh.name, "执行角色", r.actor.value,
                          Role.PREFILLED if r.actor.value else Role.REQUIRED),
            "管哪个单据": _cell(r.rid, sh.name, "管哪个单据", hosts,
                           Role.PREFILLED if hosts else Role.REQUIRED),
            "这条对吗": _cell(r.rid, sh.name, "这条对吗", "", Role.REQUIRED,
                          options=["对", "不对", "需要改", "看不懂"]),
        })
    return sh


def _sheet_glossary(oir: OIR) -> Sheet:
    sh = Sheet("05_术语表", "系统识别到的别名。如果某个别名其实指的是别的东西，请在这里指出。",
               ["standard", "aliases", "correct"])
    for o in oir.objects.values():
        if not o.aliases:
            continue
        sh.rows.append({
            "standard": _cell(o.rid, sh.name, "standard", o.display_name.value, Role.LOCKED),
            "aliases": _cell(o.rid, sh.name, "aliases", "、".join(o.aliases), Role.PREFILLED),
            "correct": _cell(o.rid, sh.name, "correct", "", Role.REQUIRED,
                             options=["正确", "有误"], owner=o.owner),
        })
    return sh


# ══════════════════════════════════════════════════════════════════
#  写出 xlsx
# ══════════════════════════════════════════════════════════════════
FILL = {
    Role.REQUIRED: "FDF6E3",  # 黄：业务必填
    Role.LOCKED: "F3F1ED",  # 灰：已定只读
    Role.PREFILLED: "FFFFFF",  # 白：可改
    Role.GUIDE: "EEF1F6",
}


def write_xlsx(spec: TemplateSpec, path: Path | str, *, project: str = "") -> Path:
    """写出带样式、校验、批注和隐藏锚点列的 xlsx。"""
    from openpyxl import Workbook
    from openpyxl.comments import Comment
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.worksheet.datavalidation import DataValidation

    wb = Workbook()
    wb.remove(wb.active)

    thin = Side(style="thin", color="E0DDD6")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    head_font = Font(bold=True, size=10, color="4A453C")
    guide_font = Font(italic=True, size=10, color="6B6862")

    # ── 填写指引 ────────────────────────────────────────────────
    ws = wb.create_sheet("00_填写指引")
    ws.column_dimensions["A"].width = 100
    lines = [
        f"OntoCopilot 实体梳理模板 · {project} · 第 {spec.round} 轮",
        "",
        "颜色含义：",
        "  黄底  = 业务必填，本轮需要你填写或确认",
        "  灰底  = 已定，只读，请勿改动",
        "  白底  = 系统预填，如有出入可直接改",
        "  红角标 = 存在冲突，把鼠标停在格子上看批注",
        "",
        "填写要点：",
        "  1. 「口径定义」是本轮重点。请写清含税/不含税、时间粒度、口径主体。",
        "  2. 预填值不是结论。原样交回等于没审，系统会识别出来并再次打回。",
        "  3. 每张表第一行是本表的填写说明，已冻结。",
        "  4. 前两列被隐藏，是系统的对齐锚点，请勿删除或改动行结构以外的内容。",
        "",
        f"本轮统计：{json.dumps(spec.stats(), ensure_ascii=False)}",
    ]
    for i, text in enumerate(lines, start=1):
        c = ws.cell(row=i, column=1, value=text)
        c.font = Font(bold=(i == 1), size=12 if i == 1 else 10)
        c.alignment = Alignment(wrap_text=True, vertical="top")

    # ── 数据表 ──────────────────────────────────────────────────
    for sheet in spec.sheets:
        ws = wb.create_sheet(sheet.name)

        # 第 1 行：填写说明；第 2 行：表头；数据从第 3 行开始
        ws.cell(row=1, column=1, value=sheet.guide).font = guide_font
        ws.merge_cells(start_row=1, start_column=1, end_row=1,
                       end_column=max(3, len(sheet.columns) + 2))
        ws.row_dimensions[1].height = 30

        headers = [ANCHOR_RID, ANCHOR_HASH, *sheet.columns]
        for col, name in enumerate(headers, start=1):
            c = ws.cell(row=2, column=col, value=name)
            c.font = head_font
            c.fill = PatternFill("solid", fgColor="FAF9F6")
            c.border = border

        for r, row in enumerate(sheet.rows, start=3):
            first = next(iter(row.values()))
            ws.cell(row=r, column=1, value=first.rid)
            ws.cell(row=r, column=2, value="|".join(
                f"{f}={c.prefill_hash}" for f, c in row.items() if c.prefill_hash))
            for col, name in enumerate(sheet.columns, start=3):
                cell = row.get(name)
                if cell is None:
                    continue
                x = ws.cell(row=r, column=col, value=cell.value)
                x.fill = PatternFill("solid", fgColor=FILL[cell.role])
                x.border = border
                x.alignment = Alignment(wrap_text=True, vertical="top")
                if cell.role is Role.REQUIRED:
                    x.font = Font(bold=True, color="8A6D1F")
                if cell.comment:
                    x.comment = Comment(cell.comment[:900], "OntoCopilot")
                if cell.conflict:
                    # 红角标：openpyxl 没有原生角标，用红色粗边框 + 批注等效表达
                    red = Side(style="medium", color="9C3B32")
                    x.border = Border(left=thin, right=red, top=red, bottom=thin)

        # 枚举列做下拉：错误在业务方那端就被拦住，比回传后再打回便宜得多
        for col, name in enumerate(sheet.columns, start=3):
            opts = next((row[name].options for row in sheet.rows
                         if name in row and row[name].options), None)
            if not opts:
                continue
            letter = ws.cell(row=2, column=col).column_letter
            dv = DataValidation(type="list", formula1=f'"{",".join(opts)}"', allow_blank=True,
                                showErrorMessage=True, errorTitle="取值不在允许范围",
                                error=f"请从下拉中选择：{'、'.join(opts)}")
            ws.add_data_validation(dv)
            dv.add(f"{letter}3:{letter}{max(3, len(sheet.rows) + 2)}")

        ws.column_dimensions["A"].hidden = True  # _oir_rid
        ws.column_dimensions["B"].hidden = True  # _oir_hash
        for col, name in enumerate(sheet.columns, start=3):
            ws.column_dimensions[ws.cell(row=2, column=col).column_letter].width = (
                40 if name in ("definition", "description") else 20
            )
        ws.freeze_panes = "C3"

    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out
