"""导出 onto/gaps.py 的 golden —— 给 TS 侧 ts/src/onto/gaps.ts 当安全网。

`golden/pipeline.oir.json` 已经是真材料跑完整条流水线（含 mine_questions）的产物，
但它只钉住了**结果**：四条挖掘通道各自的判据、每条判据的"该问的问出来了 / 不该问的
没问"、以及 Python 与 JS 必然分叉的那几处，一条都没被钉住。这个脚本补上那部分。

被钉住的分叉（每一条都在 golden 里有一个正例和一个反例）：

  1. ``\\s``  —— Python 的 str 模式 ``\\s`` 是「Unicode White_Space ∪ U+001C–U+001F」，
     JS 的 ``\\s`` 多 U+FEFF、少 U+001C–U+001F。占位符与单位之间夹一个这样的字符，
     两边就一个认一个不认；dedup key（``re.sub(r"\\s+","",sent)``）也走同一条判据。
  2. ``\\d``  —— Python 认整个 Unicode Nd（含全角 ``１``），JS 只认 ASCII。
     取值域名字的 ``_BAD_NAME`` 判据靠它。
  3. ``len`` / 切片按 code point —— ``len(text) < 8`` 与 ``text[:60]``（rid 的输入）
     在有 emoji 时两边差一倍。

跑法::

    .venv/bin/python tools/golden/gaps.py

产物 golden/gaps.json。**字节确定**：材料是 golden/材料.xlsx（已冻结字节），
其余输入全是字面量，重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.gaps import (  # noqa: E402
    Gap,
    alignment_gaps,
    empty_containers,
    enumerations,
    mine_questions,
    structural_gaps,
    undetermined_slots,
)
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BusinessRule,
    Cardinality,
    LinkType,
    ObjectType,
    OpenQuestion,
    Provenance,
    extracted,
    inferred,
    oir_from_dict,
)

OUT = ROOT / "golden"


# ══════════════════════════════════════════════════════════════════
#  序列化
# ══════════════════════════════════════════════════════════════════
def gap_d(g: Gap) -> dict[str, Any]:
    """Gap 的线上形态。prov 走 Provenance.to_dict()（含 cite），TS 侧同一个函数。"""
    return {
        "text": g.text, "group": g.group, "kind": g.kind,
        "prov": g.prov.to_dict() if g.prov else None,
        "options": g.options, "applies_to": g.applies_to, "weight": g.weight,
    }


def gaps_d(gs: list[Gap]) -> list[dict[str, Any]]:
    return [gap_d(g) for g in gs]


class Chunk:
    """gaps.py 只用 getattr 读这四个字段 —— golden 里也只存这四个。"""

    def __init__(self, render: str, *, locator: dict[str, Any] | None = None,
                 file_id: str = "f1", file_name: str = "x.xlsx") -> None:
        self.render, self.locator = render, locator
        self.file_id, self.file_name = file_id, file_name

    def d(self) -> dict[str, Any]:
        return {"file_id": self.file_id, "file_name": self.file_name,
                "locator": self.locator, "render": self.render}


class Finding:
    def __init__(self, kind: str, message: str, locator: dict[str, Any] | None) -> None:
        self.kind, self.message, self.locator = kind, message, locator

    def d(self) -> dict[str, Any]:
        return {"kind": self.kind, "message": self.message, "locator": self.locator}


class Doc:
    def __init__(self, findings: list[Finding], *, file_id: str = "f1",
                 file_name: str = "x.xlsx") -> None:
        self.findings, self.file_id, self.file_name = findings, file_id, file_name

    def d(self) -> dict[str, Any]:
        return {"file_id": self.file_id, "file_name": self.file_name,
                "findings": [f.d() for f in self.findings]}


def sheet(text: str, name: str = "业务规则", row: int = 47) -> Chunk:
    return Chunk(text, locator={"kind": "range", "sheet": name, "rows": [row, row]})


# ══════════════════════════════════════════════════════════════════
#  1. 未定参数：一条判据一个正例一个反例
# ══════════════════════════════════════════════════════════════════
SLOT_CASES: list[tuple[str, list[Chunk]]] = [
    # ── p0：XX 紧挨量词 ────────────────────────────────────────
    ("p0 命中：XX 后面就是单位", [sheet("2、实际与计划基线对比，如提前XX天需要进行预警提醒；")]),
    ("p0 不命中：XX 是普通缩写，后面不是单位", [sheet("由XX部门负责归口管理，报XX公司备案。")]),
    ("p0 全角与乘号也算占位符", [sheet("超出ＸＸ万元的采购包需要总监审批，否则驳回。")]),
    # ── p1：N + 单位，且前面不能是字母数字 ──────────────────────
    ("p1 命中：N 个工作日", [sheet("5、如第一时间未处理，则依据重复提醒要求，间隔N个工作日再次发送；")]),
    ("p1 不命中：N 前面是字母（lookbehind 挡掉）",
     [sheet("接口 queryPbpN天 的返回值需要补充说明，请业务方确认口径。")]),
    # ── p2 / p3 ────────────────────────────────────────────────
    ("p2 命中：百分之多少", [sheet("质保金比例按百分之多少扣留，需要采购与财务共同确认。")]),
    ("p3 命中：若干", [sheet("需求提报后由计划员合并若干条需求生成采购包，规则待业务确认。")]),
    # ── p4 / p5 ────────────────────────────────────────────────
    ("p4 命中：待梳理", [sheet("实体间关系待梳理，本期先按单表建模处理。")]),
    ("p5 命中：空括号", [sheet("采购包审批人为（  ），审批时限由业务部门另行规定。")]),
    # ── 去重：同一句在两个切片里只问一次 ────────────────────────
    ("同一句出现两次只问一次",
     [sheet("2、实际与计划基线对比，如提前XX天需要进行预警提醒；"),
      sheet("2、实际与计划基线对比，如提前XX天需要进行预警提醒；", row=48)]),
    # ── 分叉 1a：U+FEFF。JS 的 \s 认它，Python 的不认 ────────────
    ("分叉：XX 与单位之间夹 U+FEFF —— Python 不认（JS 的 \\s 会认）",
     [sheet("如提前XX﻿天需要进行预警提醒，提醒对象为采购计划员。")]),
    # ── 分叉 1b：U+001C。Python 的 \s 认它，JS 的不认 ────────────
    ("分叉：XX 与单位之间夹 U+001C —— Python 认（JS 的 \\s 不认）",
     [sheet("如提前XX\x1c天需要进行预警提醒，提醒对象为采购计划员。")]),
    # ── 分叉 3：len(text) 按 code point ─────────────────────────
    ("分叉：7 个 code point（含 emoji）—— Python 判 len<8 直接跳过",
     [sheet("😀😀😀😀XX天")]),
    ("对照：9 个 code point，同样含 emoji —— 进得来", [sheet("😀😀😀😀提前XX天预警")]),
    # ── limit ──────────────────────────────────────────────────
    ("limit 卡住产出条数",
     [sheet(f"第{i}条规则：如提前XX天预警，责任人待定；", row=50 + i) for i in range(6)]),
]


def export_slots() -> list[dict[str, Any]]:
    out = []
    for name, chunks in SLOT_CASES:
        limit = 3 if "limit" in name else 40
        out.append({"name": name, "chunks": [c.d() for c in chunks], "limit": limit,
                    "gaps": gaps_d(undetermined_slots(chunks, limit=limit))})
    return out


# ══════════════════════════════════════════════════════════════════
#  2. 空容器
# ══════════════════════════════════════════════════════════════════
EMPTY_CASES: list[tuple[str, list[Doc]]] = [
    ("empty_sheet 变成问题",
     [Doc([Finding("empty_sheet", "工作表「实体间关系-待梳理」是空的，已跳过",
                   {"sheet": "实体间关系-待梳理"})])]),
    ("empty_section / unparsed_sheet 同样算",
     [Doc([Finding("empty_section", "章节「接口清单」没有内容", {"sheet": "接口清单"}),
           Finding("unparsed_sheet", "工作表「附件」解析失败", {"sheet": "附件"})])]),
    ("别的 finding 一律不问",
     [Doc([Finding("metadata_leak", "文档带着作者名与绝对路径", {"sheet": "封面"}),
           Finding("encoding_guess", "按 GBK 解码", {"sheet": "清单"})])]),
    ("locator 里没有 sheet 名的不问",
     [Doc([Finding("empty_sheet", "有一张空表", {}),
           Finding("empty_sheet", "有一张空表", None),
           Finding("empty_sheet", "有一张空表", {"sheet": "   "})])]),
    ("没有 findings 的文档不问", [Doc([])]),
]


def export_empty() -> list[dict[str, Any]]:
    return [{"name": n, "docs": [d.d() for d in docs], "gaps": gaps_d(empty_containers(docs))}
            for n, docs in EMPTY_CASES]


# ══════════════════════════════════════════════════════════════════
#  3. 取值清单
# ══════════════════════════════════════════════════════════════════
ENUM_CASES: list[tuple[str, list[Chunk]]] = [
    ("命中：六个短取值，全用顿号分隔",
     [sheet("3、进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消；")]),
    ("不命中：逗号分句的并列 —— 顿号分词、逗号分句",
     [sheet("6、重大预警：关键物料，会造成项目停工、关键里程碑跳票、大额损失。")]),
    ("不命中：只有两个取值（下限是三个）", [sheet("优先级：高、低；")]),
    ("不命中：长度离散度过大，那是三个分句不是三个取值",
     [sheet("延误等级：局部轻微滞后、不影响整体项目节点、可由采购员自行协调处理；")]),
    # 真实形态：名字里的数字先被 strip 掉，于是 `_BAD_NAME` 的 `col\d` 反而不命中，
    # 「col」照样被当成取值域名字问出来。照实钉住，不在移植时"修好"。
    ("名字里的数字先被 strip 掉，col\\d 于是不命中", [sheet("col1：甲类、乙类、丙类；")]),
    ("分叉：名字以全角数字开头 —— Python 的 \\d 认 Nd，JS 的只认 ASCII",
     [sheet("１号：甲类、乙类、丙类；")]),
    ("对照：名字以半角数字开头 —— 两边都不问", [sheet("1号：甲类、乙类、丙类；")]),
    ("不命中：名字里带括号", [sheet("状态（旧）：草稿、生效、作废；")]),
    ("不命中：取值里带结果引导词", [sheet("处理方式：直接驳回、需重新提报、可由计划员改单；")]),
    ("去重：同名取值域只问一次",
     [sheet("进度状态标准：未开始、执行中、已完成；"),
      sheet("进度状态标准：未开始、执行中、已完成；", row=48)]),
    ("limit 卡住产出条数",
     [sheet("；".join(f"{n}：甲、乙、丙" for n in ("状态", "类型", "等级", "阶段", "来源")))]),
]


def export_enums() -> list[dict[str, Any]]:
    out = []
    for name, chunks in ENUM_CASES:
        limit = 2 if "limit" in name else 12
        out.append({"name": name, "chunks": [c.d() for c in chunks], "limit": limit,
                    "gaps": gaps_d(enumerations(chunks, limit=limit))})
    return out


# ══════════════════════════════════════════════════════════════════
#  4. 结构缺口
# ══════════════════════════════════════════════════════════════════
P = Provenance("f1", "x.xlsx", {"kind": "range", "sheet": "行动", "rows": [3, 3]},
               snippet="createFoo", extractor="rule", confidence=1.0)


def _obj(rid: str, api: str, cn: str, desc: str = "") -> ObjectType:
    return ObjectType(rid=rid, api_name=extracted(api, P), display_name=extracted(cn, P),
                      description=inferred(desc))


def oir_actions_and_rules() -> OIR:
    """挂不上宿主的接口 + 挂不到对象的规则 + 有名字没口径的对象。"""
    oir = OIR()
    for i in range(3):
        oir.add_object(_obj(f"ot_{i}", f"po{i}", f"采购对象{i}"))
    oir.add_action(ActionType(rid="at_x", api_name=extracted("createFoo", P), applies_to=[],
                              source_endpoint=extracted(
                                  {"path": "/v1/createFoo", "display": "创建 Foo"}, P)))
    oir.add_action(ActionType(rid="at_y", api_name=extracted("cancelFoo", P), applies_to=[],
                              source_endpoint=inferred(None)))
    # 这个有宿主 —— 不该被问
    oir.add_action(ActionType(rid="at_ok", api_name=extracted("createBar", P),
                              applies_to=["ot_0"]))
    oir.add_rule(BusinessRule(rid="br_x", statement=extracted("采购包一经分配不得拆包", P),
                              applies_to=[]))
    # 这条挂上了对象 —— 不该被问
    oir.add_rule(BusinessRule(rid="br_ok", statement=extracted("金额超限即驳回", P),
                              applies_to=["ot_0"]))
    return oir


def oir_many_orphans() -> OIR:
    """7 个孤儿接口 —— 前 6 条逐个问，剩下的合并成一条 `action_no_host_more`。"""
    oir = OIR()
    for i in range(7):
        oir.add_action(ActionType(rid=f"at_{i}", api_name=extracted(f"createX{i}", P),
                                  applies_to=[]))
    return oir


def oir_links() -> OIR:
    """基数靠猜的关系 + 一条端点缺失的（占了名额然后被跳过）。"""
    oir = OIR()
    oir.add_object(_obj("ot_h", "poHeader", "采购订单头", "订单主表"))
    oir.add_object(_obj("ot_l", "poLine", "采购订单行", "订单行表"))
    # 有 evidence 的基数 —— 不该被问
    oir.add_link(LinkType(rid="lt_ok", api_name=extracted("poHeaderLine", P),
                          source="ot_h", target="ot_l",
                          cardinality=extracted(Cardinality.ONE_TO_MANY, P)))
    # 没 evidence 的基数 —— 该问
    oir.add_link(LinkType(rid="lt_guess", api_name=extracted("poLineTax", P),
                          source="ot_h", target="ot_l",
                          cardinality=inferred(Cardinality.MANY_TO_MANY)))
    # 端点在 OIR 里不存在 —— 名额被它占掉然后跳过（照搬 Python 的顺序）
    oir.add_link(LinkType(rid="lt_dangling", api_name=extracted("dangling", P),
                          source="ot_missing", target="ot_l",
                          cardinality=inferred(Cardinality.ONE_TO_ONE)))
    return oir


def oir_two_nodesc() -> OIR:
    """只有 2 个没口径的对象 —— 阈值是 3，一条都不该问。"""
    oir = OIR()
    oir.add_object(_obj("ot_a", "a", "甲"))
    oir.add_object(_obj("ot_b", "b", "乙"))
    oir.add_object(_obj("ot_c", "c", "丙", "有口径的对象"))
    return oir


def oir_long_rule() -> OIR:
    """规则文本超过 70 个 code point 且带 emoji —— 钉住 `statement[:70]` 的切法。"""
    oir = OIR()
    stmt = "采购包创建后不得拆包😀" + "，具体口径由采购部与财务部共同确认后另行下发通知" * 3
    oir.add_rule(BusinessRule(rid="br_long", statement=extracted(stmt, P), applies_to=[]))
    return oir


def oir_links_starved() -> OIR:
    """6 条端点缺失的关系把名额占满 —— 第 7 条（端点齐全、该问的那条）被切掉。

    Python 是先 `[:_PER_KIND]` 再判端点，所以这里正确答案是**一条都不问**。
    移植时"顺手"改成先过滤再切片，就会多问出一条 —— 那正是最难查的一类漂移。
    """
    oir = OIR()
    oir.add_object(_obj("ot_h", "poHeader", "采购订单头", "订单主表"))
    oir.add_object(_obj("ot_l", "poLine", "采购订单行", "订单行表"))
    for i in range(6):
        oir.add_link(LinkType(rid=f"lt_dead{i}", api_name=extracted(f"dead{i}", P),
                              source="ot_missing", target="ot_l",
                              cardinality=inferred(Cardinality.ONE_TO_ONE)))
    oir.add_link(LinkType(rid="lt_real", api_name=extracted("real", P),
                          source="ot_h", target="ot_l",
                          cardinality=inferred(Cardinality.ONE_TO_MANY)))
    return oir


STRUCT_CASES: list[tuple[str, OIR]] = [
    ("接口与规则的归属", oir_actions_and_rules()),
    ("孤儿接口超过 6 个，多出来的合并成一条", oir_many_orphans()),
    ("基数靠猜的关系", oir_links()),
    ("端点缺失的关系先占名额再被跳过 —— 切片在过滤之前", oir_links_starved()),
    ("没口径的对象只有 2 个 —— 不到阈值", oir_two_nodesc()),
    ("规则文本按 code point 截到 70", oir_long_rule()),
    ("空 OIR 一条都不问", OIR()),
]


def export_struct() -> list[dict[str, Any]]:
    return [{"name": n, "oir": o.to_dict(), "gaps": gaps_d(structural_gaps(o))}
            for n, o in STRUCT_CASES]


# ══════════════════════════════════════════════════════════════════
#  5. 对齐拿不准的那些对
# ══════════════════════════════════════════════════════════════════
class Pair:
    def __init__(self, a: str, b: str, total: float, alias: bool = False,
                 reasons: list[str] | None = None) -> None:
        self.a, self.b, self.total, self.alias, self.reasons = a, b, total, alias, reasons

    def d(self) -> dict[str, Any]:
        return {"a": self.a, "b": self.b, "total": self.total,
                "alias": self.alias, "reasons": self.reasons}


def oir_align() -> OIR:
    oir = OIR()
    oir.add_object(_obj("ot_a", "spProjectTeamMember", "项目团队成员信息"))
    oir.add_object(_obj("ot_b", "clmProjectTeamMember", "项目团队成员信息"))
    oir.add_object(_obj("ot_c", "poHeader", ""))          # display 为空 → 回落 api_name
    oir.add_object(_obj("ot_d", "poHead", ""))
    return oir


ALIGN_CASES: list[tuple[str, list[Pair], int]] = [
    ("别名重合的排在前面，且带理由",
     [Pair("ot_c", "ot_d", 0.61, False, ["名字前缀相同"]),
      Pair("ot_a", "ot_b", 0.83, True,
           ["别名重合 ['项目团队成员信息']", "至少一边没有属性，无结构证据"])], 6),
    ("没有 reasons 时回落到「名称相近」", [Pair("ot_a", "ot_b", 0.5)], 6),
    ("端点在 OIR 里不存在的，跳过", [Pair("ot_a", "ot_missing", 0.9)], 6),
    ("同分保持原序（Python 的 sorted 是稳定的）",
     [Pair("ot_a", "ot_b", 0.5), Pair("ot_c", "ot_d", 0.5)], 6),
    ("limit 卡住条数", [Pair("ot_a", "ot_b", 0.9), Pair("ot_c", "ot_d", 0.8)], 1),
    ("没有拿不准的就什么都不说", [], 6),
]


def export_align() -> dict[str, Any]:
    oir = oir_align()
    # OIR 本身也进 golden —— TS 侧手搓一份"形状差不多"的必然漏掉 evidence，
    # 而 `prov` 恰恰就是从 evidence 上取的（真踩过：四条用例全红在 prov=null）。
    return {"oir": oir.to_dict(),
            "cases": [{"name": n, "uncertain": [p.d() for p in ps], "limit": lim,
                       "gaps": gaps_d(alignment_gaps(oir, ps, limit=lim))}
                      for n, ps, lim in ALIGN_CASES]}


# ══════════════════════════════════════════════════════════════════
#  6. 汇总：排序、去重、名额
# ══════════════════════════════════════════════════════════════════
def export_mine() -> list[dict[str, Any]]:
    out = []

    # ① 客户自带问卷 150 条 —— 一条不许挤掉我们自己挖的 5 条空表
    extra = [OpenQuestion(rid=f"q_c{i}", text=inferred(f"客户问卷第 {i} 条")) for i in range(150)]
    doc = Doc([Finding("empty_sheet", f"空表{i}", {"sheet": f"待梳理{i}"}) for i in range(5)])
    out.append({
        "name": "客户自带的问题不占我们的名额", "docs": [doc.d()], "chunks": [],
        "extra": [q.to_dict() for q in extra], "extra_gaps": [], "limit": 60,
        "questions": [q.to_dict() for q in
                      mine_questions(OIR(), docs=[doc], chunks=[], extra=extra, limit=60)],
    })

    # ② 反向：名额确实卡住我们自己挖的
    doc2 = Doc([Finding("empty_sheet", f"空表{i}", {"sheet": f"待梳理{i}"}) for i in range(20)])
    out.append({
        "name": "limit 卡住我们自己挖的", "docs": [doc2.d()], "chunks": [],
        "extra": [], "extra_gaps": [], "limit": 8,
        "questions": [q.to_dict() for q in
                      mine_questions(OIR(), docs=[doc2], chunks=[], limit=8)],
    })

    # ③ 四条通道一起排序：权重 5.0 空容器 > 4.0 接口归属 > 3.0 槽位/规则 > 2.5 枚举 > 2.0
    doc3 = Doc([Finding("empty_sheet", "空表", {"sheet": "实体间关系-待梳理"})])
    chunks3 = [sheet("2、实际与计划基线对比，如提前XX天需要进行预警提醒；"),
               sheet("3、进度状态标准：未开始、执行中、部分完成、已完成、已暂停、已取消；", row=48)]
    oir3 = oir_actions_and_rules()
    out.append({
        "name": "四条通道按权重混排", "docs": [doc3.d()], "chunks": [c.d() for c in chunks3],
        "extra": [], "extra_gaps": [], "limit": 60,
        "questions": [q.to_dict() for q in
                      mine_questions(oir3, docs=[doc3], chunks=chunks3, limit=60)],
        "oir": oir3.to_dict(),
    })

    # ④ extra_gaps 与自挖的一起排序；顺带钉住 `text[:60]` 的 code point 切法
    #    （60 个 code point 之后才出现的字不进 rid —— 按 UTF-16 切会少切一半）
    long_text = "😀" * 40 + "这段字在第 40 个 emoji 之后，按 code point 切 rid 里进不来" * 2
    extra_gaps = [Gap(text=long_text, group="外部", kind="flow_gap", weight=9.9),
                  Gap(text="流程图上这一步没有对应接口，是漏了还是线下做？",
                      group="流程", kind="flow_no_action", weight=1.0)]
    out.append({
        "name": "extra_gaps 参与同一份排序", "docs": [], "chunks": [],
        "extra": [], "extra_gaps": [gap_d(g) for g in extra_gaps], "limit": 60,
        "questions": [q.to_dict() for q in
                      mine_questions(OIR(), docs=[], chunks=[], extra_gaps=extra_gaps)],
    })

    # ⑤ 去重：extra 里已经有同 rid 的问题时，挖出来的那条不再重复进
    dup_gap = Gap(text="材料里有一张叫「实体间关系-待梳理」的表，但里面一行内容都没有。"
                       "这部分能补上吗？如果内容已经在别的文档里，请指出是哪一份。",
                  group="实体间关系-待梳理", kind="empty_container", weight=5.0)
    dup_extra = [dup_gap.to_question()]
    out.append({
        "name": "rid 撞上 extra 的就不再进", "docs": [doc3.d()], "chunks": [],
        "extra": [q.to_dict() for q in dup_extra], "extra_gaps": [], "limit": 60,
        "questions": [q.to_dict() for q in
                      mine_questions(OIR(), docs=[doc3], chunks=[], extra=dup_extra)],
    })
    return out


# ══════════════════════════════════════════════════════════════════
#  7. 真材料端到端
# ══════════════════════════════════════════════════════════════════
def export_material() -> dict[str, Any]:
    """golden/材料.xlsx 走一遍完整挖掘 —— 与 pipeline.oir.json 里那 5 条问题同源。"""
    from ontocopilot.kernel.memory.evidence import EvidenceIndex
    from ontocopilot.onto.parse import default_registry

    mat = OUT / "材料.xlsx"
    docs = [default_registry().parse(mat)]
    index = EvidenceIndex()
    for d in docs:
        for c in d.chunks:
            index.add(c)
    chunks = index.all_chunks()
    oir = oir_from_dict(json.loads((OUT / "pipeline.oir.json").read_text("utf-8")))

    return {
        "chunks": [{"file_id": c.file_id, "file_name": c.file_name,
                    "locator": c.locator, "render": c.render} for c in chunks],
        "docs": [{"file_id": d.file_id, "file_name": d.file_name,
                  "findings": [{"kind": f.kind, "message": f.message, "locator": f.locator}
                               for f in d.findings]} for d in docs],
        "undetermined_slots": gaps_d(undetermined_slots(chunks)),
        "empty_containers": gaps_d(empty_containers(docs)),
        "enumerations": gaps_d(enumerations(chunks)),
        "structural_gaps": gaps_d(structural_gaps(oir)),
        "questions": [q.to_dict() for q in
                      mine_questions(oir, docs=docs, chunks=chunks)],
    }


def main() -> None:
    data = {
        "slots": export_slots(),
        "empty": export_empty(),
        "enums": export_enums(),
        "struct": export_struct(),
        "align": export_align(),
        "mine": export_mine(),
        "material": export_material(),
    }
    p = OUT / "gaps.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
