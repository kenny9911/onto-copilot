"""从流程说明里抽出流图 —— 规则优先。

真实材料里的流程说明长这样（`实体梳理.xlsx!业务规则!A14`，一个合并单元格里
塞六个节点）：

    （1）编制集采计划：集中采购专业机构根据集采原则……编制集采计划
    触发条件：无（主要以集约化标准和框架到期日进行判断）；
    输入：集采计划编制策略及集采计划编制要求，无系统节点；
    输出：一级集采计划、二级集采计划、自定义集采计划；
    执行者：采购计划员
    （2）审核集采计划：对集采计划进行审批，以备注入采购需求计划；
    ……

这个格式**规则就能拆**，一行不丢。让模型去读它只有两个后果：为复述结构化文本
付 Opus 的钱，以及它一定会在第十几个节点上开始漏。ADR-5 在这里的落点非常干净。

拆出来之后，四段各自有确定的去向：

    动作名       →  ACTION 节点
    输出         →  EVENT 节点（"已审批集采计划" 就是一个事实）
    触发条件     →  入边的来源线索（"集采计划审批完成" 指向上一个节点的输出）
    执行者       →  ACTION 的 actor

**边不能全靠猜。** 节点 N 的"输入/触发条件"里如果出现了节点 M 的"输出"原文，
那条边有依据；接不上的地方按编号顺序补一条虚线，并标成推断 —— 图上一眼能
看出哪里是我们连的。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .flow import EdgeKind, FlowGraph, FlowNode, NodeKind, Stage
from .oir import Provenance, extracted, inferred, make_rid

__all__ = ["ProcessStep", "parse_steps", "build_flow", "looks_like_process"]


#: 一个节点的开头：（1） / (1) / 1. / 1、
_STEP_HEAD = re.compile(r"[（(]\s*(\d{1,3})\s*[）)]\s*|^\s*(\d{1,3})\s*[.、]\s*", re.M)

#: 四个字段。「执行着」是材料里的错别字 —— 真实材料就是会有错别字，
#: 认不出它就会丢掉一整个节点的执行者。
_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("trigger", ("触发条件", "触发时机", "触发")),
    ("inputs", ("输入", "前置", "输入项")),
    ("outputs", ("输出", "产出", "输出项")),
    ("actor", ("执行者", "执行着", "责任人", "负责人", "角色")),
)
_FIELD_RE = re.compile(
    r"(" + "|".join(w for _, ws in _FIELDS for w in ws) + r")\s*[:：]\s*")


@dataclass(slots=True)
class ProcessStep:
    """流程说明里的一个节点。"""

    no: int
    name: str
    detail: str = ""
    trigger: str = ""
    inputs: str = ""
    outputs: str = ""
    actor: str = ""
    cite: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"no": self.no, "name": self.name, "detail": self.detail,
                "trigger": self.trigger, "inputs": self.inputs,
                "outputs": self.outputs, "actor": self.actor, "cite": self.cite}


def looks_like_process(text: str) -> bool:
    """这段文字是不是流程说明。

    判据是**结构**不是关键词：有编号节点、且节点里带「触发条件/输入/输出」这类
    字段。只看关键词的话，一句"本节说明采购流程"也会命中。
    """
    t = str(text or "")
    heads = len(_STEP_HEAD.findall(t))
    fields = len(_FIELD_RE.findall(t))
    return heads >= 2 and fields >= 2


def _split_fields(body: str) -> dict[str, str]:
    """把一个节点的正文按字段名切开。"""
    out: dict[str, str] = {}
    marks = list(_FIELD_RE.finditer(body))
    if not marks:
        return out
    for i, m in enumerate(marks):
        word = m.group(1)
        key = next((k for k, ws in _FIELDS if word in ws), None)
        if key is None:
            continue
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        val = body[m.end():end].strip().strip("；;。\n ")
        # 同一个字段出现两次（材料里有），保留先出现的 —— 后面的多半是别的节点
        # 串进来的残留
        out.setdefault(key, val)
    return out


def parse_steps(text: str, *, cite: str = "") -> list[ProcessStep]:
    """把一段流程说明拆成节点列表。一行不丢。"""
    t = str(text or "")
    heads = list(_STEP_HEAD.finditer(t))
    if not heads:
        return []
    steps: list[ProcessStep] = []
    for i, h in enumerate(heads):
        no = int(h.group(1) or h.group(2))
        start = h.end()
        end = heads[i + 1].start() if i + 1 < len(heads) else len(t)
        chunk = t[start:end].strip()

        # 首行是「动作名：说明」；冒号后面才是说明
        first_break = _FIELD_RE.search(chunk)
        head_part = chunk[:first_break.start()] if first_break else chunk
        rest = chunk[first_break.start():] if first_break else ""
        # re.split 带 maxsplit 只返回两段，不是三段 —— 用 partition 语义更清楚
        parts = re.split(r"[:：]", head_part, maxsplit=1)
        name, detail = (parts[0], parts[1]) if len(parts) == 2 else (head_part, "")
        f = _split_fields(rest)
        steps.append(ProcessStep(
            no=no, name=name.strip().strip("；;。\n "),
            detail=detail.strip().strip("；;。\n ")[:300],
            trigger=f.get("trigger", ""), inputs=f.get("inputs", ""),
            outputs=f.get("outputs", ""), actor=f.get("actor", ""), cite=cite))
    return steps


# ══════════════════════════════════════════════════════════════════
#  建图
# ══════════════════════════════════════════════════════════════════
#: 一个"输出"里可能列了好几个东西（"一级集采计划、二级集采计划、自定义集采计划"）。
#: 拆开之后每个都是独立事实，但**图上只画第一个** —— 三个并列的产物画三个
#: EVENT 会让图爆炸，而它们在流程上是同一个节拍。
_SPLIT = re.compile(r"[、,，;；]|\d[）)]\s*")

#: 事件名的规范化：材料里写"已审批采购需求计划"，这本身就是事件名，直接用。
#: 写"采购申请单"这种纯名词的，补一个"已生成"。
_DONE = re.compile(r"^(已|未)|(完成|生成|创建|提交|审批|取消|作废|删除|分配)$")


def _event_name(raw: str) -> str:
    t = raw.strip().strip("；;。 ")
    if not t:
        return ""
    if _DONE.search(t):
        return t
    return f"{t}已生成"


def _norm(s: str) -> str:
    """比对用的规范化：去掉修饰词，只留核心名词。

    "已审批集采计划" 和 "已审批的集采计划" 要能对上 —— 边的连通性全靠这个匹配，
    太严就连不上、太松就乱连。
    """
    return re.sub(r"[的了个条份项\s]", "", s)


def build_flow(steps: list[ProcessStep], *, stages: dict[int, str] | None = None,
               file_name: str = "", graph: FlowGraph | None = None) -> FlowGraph:
    """把节点列表建成流图。

    Args:
        stages: 节点号 → 阶段 key。材料里没有阶段划分，得由上层给（问卷的
            「节点」列、或者人工划）。不给就全放一条泳道。
    """
    g = graph or FlowGraph()
    stages = stages or {}
    # 每个节点产出的事件，供后面按"输出↔触发条件"接边
    produced: list[tuple[str, str, int]] = []   # (规范化名, 事件 rid, 节点号)

    for st in steps:
        prov = Provenance("f", file_name, {"kind": "raw", "ref": st.cite},
                          snippet=f"（{st.no}）{st.name}：{st.detail}"[:200],
                          extractor="rule", confidence=1.0)
        stage = stages.get(st.no, "main")
        act = g.add_node(FlowNode(
            rid=make_rid("fn", f"act{st.no}_{st.name}"), kind=NodeKind.ACTION,
            stage=stage, label=extracted(st.name, prov),
            actor=extracted(st.actor, prov) if st.actor else inferred("")))

        # 输出 → 事件。**只取第一个** —— 并列产物是同一个节拍。
        outs = [x for x in _SPLIT.split(st.outputs) if x.strip()]
        if outs:
            ename = _event_name(outs[0])
            evt = g.add_node(FlowNode(
                rid=make_rid("fn", f"evt{st.no}_{ename}"), kind=NodeKind.EVENT,
                stage=stage, label=extracted(ename, prov)))
            g.connect(act.rid, evt.rid, evidence=[prov])
            produced.append((_norm(ename), evt.rid, st.no))
            for extra in outs[1:3]:
                # 其余产物记在事件的 objects 上，不单独画节点
                evt.objects.append(extra.strip())

    # ── 接边 ────────────────────────────────────────────────────
    # 节点 N 的触发条件/输入里出现了节点 M 的产出 → 这条边有依据。
    for st in steps:
        act_rid = make_rid("fn", f"act{st.no}_{st.name}")
        if act_rid not in g.nodes:
            continue
        clue = _norm(f"{st.trigger} {st.inputs}")
        hits = [(rid, no) for name, rid, no in produced
                if no != st.no and name and name in clue]
        prov = Provenance("f", file_name, {"kind": "raw", "ref": st.cite},
                          snippet=f"触发条件：{st.trigger}｜输入：{st.inputs}"[:200],
                          extractor="rule", confidence=1.0)
        for rid, _no in hits[:2]:
            g.connect(rid, act_rid, evidence=[prov])

    # 接不上的按编号顺序补一条虚线，标成推断。**不补的话图是散的，
    # 补了不标的话人分不清哪里是我们连的** —— 后者更糟。
    by_no = {st.no: st for st in steps}
    for st in sorted(steps, key=lambda x: x.no):
        act_rid = make_rid("fn", f"act{st.no}_{st.name}")
        if act_rid not in g.nodes or g.in_edges(act_rid):
            continue
        prev = by_no.get(st.no - 1)
        if prev is None:
            continue
        prev_evt = next((rid for name, rid, no in produced if no == prev.no), None)
        if prev_evt:
            g.connect(prev_evt, act_rid, kind=EdgeKind.INFERRED, label="推断顺序")
    return g


def stages_from_groups(groups: dict[str, list[int]],
                       graph: FlowGraph | None = None) -> tuple[FlowGraph, dict[int, str]]:
    """把「阶段名 → 节点号列表」变成泳道定义。

    材料里**没有**阶段划分 —— 它只给了 17 个连续编号的节点。阶段是人（或问卷的
    「节点」分组）划出来的，所以这里接受外部输入而不是自己猜。猜阶段会让整张图
    的骨架建立在一个没人确认过的判断上。
    """
    g = graph or FlowGraph()
    mapping: dict[int, str] = {}
    for i, (title, nos) in enumerate(groups.items(), start=1):
        key = f"s{i}"
        g.stages[key] = Stage(key=key, order=i, title=title)
        for no in nos:
            mapping[no] = key
    return g, mapping


#: 问卷「节点」列里的 `（N）xxx`。这是节点到阶段的**权威归属** —— 客户自己
#: 就是按这个分组讨论的，比我们按编号切分强得多。
_SURVEY_NODE = re.compile(r"[（(]\s*(\d{1,3})\s*[）)]\s*(.+)")
#: 「业务场景一：采购执行计划创建（重点覆盖节点6—10）」这类场景标题。
_SCENE = re.compile(r"业务场景[一二三四五六七八九十]+\s*[:：]?\s*(?P<name>[^（(\n]+)"
                    r"(?:[（(]\s*(?:重点覆盖)?节点\s*(?P<lo>\d+)\s*[—\-~到至]\s*(?P<hi>\d+))?")


def stages_from_survey(survey_groups: list[tuple[str, list[int]]],
                       graph: FlowGraph | None = None) -> tuple[FlowGraph, dict[int, str]]:
    """从问卷的节点分组建阶段。

    问卷的「节点」列本身就是阶段划分：客户按 `（1）编制集采计划`…`（17）采购包分配`
    的分组在讨论。把连续编号按语义边界合并成阶段，比我们按每 4 个硬切强得多 ——
    后者的边界纯属巧合，前者是客户脑子里的真实结构。

    Args:
        survey_groups: ``(阶段标题, 节点号列表)``，通常由 :func:`survey_stage_groups`
            从问卷 sheet 读出。
    """
    g = graph or FlowGraph()
    mapping: dict[int, str] = {}
    for i, (title, nos) in enumerate(survey_groups, start=1):
        if not nos:
            continue
        key = f"s{i}"
        g.stages[key] = Stage(key=key, order=i, title=f"阶段{i}｜{title}",
                              subtitle=f"覆盖节点 {min(nos)}–{max(nos)}（来自客户访谈问卷）")
        for no in nos:
            mapping[no] = key
    return g, mapping


def survey_stage_groups(sheets: dict[str, list[str]]) -> list[tuple[str, list[int]]]:
    """从问卷各 sheet 的第一列读出阶段分组。

    两种线索都用：
    - 「流程节点问题」sheet 的 `（N）xxx` 给出节点的确切名字与顺序；
    - 「规则问题」sheet 的 `业务场景X（重点覆盖节点6—10）` 给出场景到区间的映射。

    Args:
        sheets: sheet 名 → 该 sheet 第一列的非空文本列表。

    Returns:
        ``[(阶段标题, [节点号...])]``，按出现顺序。抽不到就返回空 —— 上层据此
        退回按编号切分，并注明"阶段待确认"。
    """
    # 先看有没有明写区间的场景（最强的信号）
    scenes: list[tuple[str, int, int]] = []
    for _sheet, col in sheets.items():
        for cell in col:
            m = _SCENE.search(cell)
            if m and m.group("lo") and m.group("hi"):
                scenes.append((m.group("name").strip(),
                               int(m.group("lo")), int(m.group("hi"))))
    if scenes:
        return [(name, list(range(lo, hi + 1))) for name, lo, hi in scenes]

    # 退而求其次：按 `（N）名字` 里的动作前缀分组（编制/审批/创建…同族的并一段）
    nodes: list[tuple[int, str]] = []
    for col in sheets.values():
        for cell in col:
            m = _SURVEY_NODE.match(cell.strip())
            if m:
                nodes.append((int(m.group(1)), m.group(2).strip()))
    if not nodes:
        return []
    nodes.sort()
    # 按名字里的业务域切段：相邻节点域码相同就并入同一阶段
    from .flow import domain_code
    groups: list[tuple[str, list[int]]] = []
    for no, name in nodes:
        dom = domain_code(name)
        if groups and domain_code(groups[-1][0]) == dom and dom:
            groups[-1][1].append(no)
        else:
            groups.append((name, [no]))
    # 用每段第一个节点的名字做标题
    return [(name, nos) for name, nos in groups]


# ══════════════════════════════════════════════════════════════════
#  网关（黄色菱形）
# ══════════════════════════════════════════════════════════════════
#: 「如…则…」句式。业务规则里的条件分叉，全图唯一带出边标签的东西。
#: 三种写法都见于真实材料：如X，则Y / 如X则Y / 超出X，则Z失败。
#:
#: 「如」要在**从句开头**（前面是句首或标点），否则「如果」「例如」「比如」里
#: 那个「如」会把半句话当成条件。用「如果」写的整句也要认，所以「果」可选。
_COND = re.compile(
    r"(?:^|[，,；;。：:、\s])(?:如果?|若|倘若|当|一旦)\s*"
    r"(?P<cond>[^，,；;。：]{3,40}?)\s*[，,]?\s*"
    r"(?:则|即|就需?|需要?|应当?|自动|会|方可|才能)\s*"
    r"(?P<then>[^，,；;。]{2,50})")

#: 分叉的第二条边：「如满足…否则…」「可满足…如不满足…」。
_ELSE = re.compile(r"(?:否则|反之|如不|若不|不满足|超出|无法)")

#: 括号内容用占位符替换，切句时不被里面的标点干扰，切完再还原。
_PAREN = re.compile(r"[（(][^（()）]*[）)]")


def _mask_parens(text: str) -> str:
    return _PAREN.sub(lambda m: "\x00" + m.group(0).replace("；", "﹔")
                      .replace(";", "﹔").replace("、", "﹑") + "\x01", text)


def _unmask(text: str) -> str:
    return (text.replace("\x00", "").replace("\x01", "")
            .replace("﹔", "；").replace("﹑", "、"))


@dataclass(slots=True)
class Gateway:
    """从一条业务规则里认出的判断分叉。"""

    condition: str          # 判断依据（菱形里的字）
    branches: list[tuple[str, str]]  # (标签, 去向短语)
    cite: str = ""
    rule_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"condition": self.condition, "branches": self.branches,
                "cite": self.cite}


def parse_gateways(text: str, *, cite: str = "") -> list[Gateway]:
    """从一段规则文本里认出所有「如…则…」分叉。

    只认**真的有分叉语义**的：一条规则里如果同时出现「满足…则不…」和
    「不满足…则…」，那是一个双分支网关。单条「如X则Y」也算 —— 它是一条
    带条件的边，图上画成网关最忠实。

    判据是句式不是关键词。「如实填写」这种「如+副词」不会命中，因为它没有
    「则/需/自动」这类结果引导词。
    """
    out: list[Gateway] = []
    # 规则常按分号/编号分条，逐条看。但**括号内的分号不能切** —— 「（各阶段：
    # 采购立项创建、采购包分配…）」里的顿号和它前后的分号会把一条规则劈碎，
    # 于是「当前时间、」这种半截 condition 就冒出来了。先把括号内容抠掉再切。
    for raw_clause in re.split(r"[；;]\s*|\d+[、.）)]\s*", _mask_parens(str(text or ""))):
        clause = _unmask(raw_clause).strip()
        m = _COND.search(clause)
        if not m:
            continue
        cond = m.group("cond").strip()
        if len(cond) < 3 or cond.endswith(("、", "，", "和", "或")):
            continue  # 半截条件，多半是被切坏的，宁可丢不要糊弄
        then = m.group("then").strip()
        branches = [(_branch_label(then), then[:30])]
        # 同一条里的另一分支
        tail = clause[m.end():]
        m2 = _COND.search(tail)
        if m2:
            branches.append((_branch_label(m2.group("then")),
                             m2.group("then").strip()[:30]))
        elif _ELSE.search(tail):
            # 「否则/如不满足…」但没写成第二个完整的「如…则…」
            branches.append(("否则", tail.strip()[:30]))
        out.append(Gateway(condition=cond[:36], branches=branches,
                          cite=cite, rule_text=clause[:120]))
    return out


#: 结果短语 → 分支标签。给菱形出边贴的字，要短。
def _branch_label(then: str) -> str:
    t = then.strip()
    if any(w in t for w in ("失败", "不通过", "驳回", "拒绝", "预警", "无法")):
        return "不满足"
    if t.startswith(("不", "无需", "禁止", "不允许", "不进行")):
        return "否"
    if any(w in t for w in ("满足", "通过", "成功", "允许", "可以", "继续", "则创建")):
        return "满足"
    return "是"


def attach_gateways(g: FlowGraph, gateways: list[tuple[Gateway, int | None]], *,
                    file_name: str = "") -> FlowGraph:
    """把网关挂到流图上。

    ``gateways`` 是 ``(网关, 挂到哪个节点号)``。挂不上具体节点的（node=None）
    仍然建出来，独立悬在对应阶段里 —— 一个抽出来却没接上的网关，比不抽更该
    让人看见，它标示着"这条规则我认出来了但不知道插在哪"。
    """
    for gw, node_no in gateways:
        prov = Provenance("f", file_name, {"kind": "raw", "ref": gw.cite},
                          snippet=gw.rule_text, extractor="rule", confidence=1.0)
        anchor = None
        stage = "main"
        if node_no is not None:
            anchor = g.nodes.get(make_rid("fn", f"act{node_no}_"))
            # act rid 带名字，得按前缀找
            anchor = next((n for rid, n in g.nodes.items()
                           if rid.startswith(f"fn_act{node_no}_")), None)
            if anchor:
                stage = anchor.stage
        gw_node = g.add_node(FlowNode(
            rid=make_rid("fn", f"gw_{gw.condition}_{gw.cite}"),
            kind=NodeKind.GATEWAY, stage=stage,
            label=extracted(gw.condition, prov)))
        if anchor is not None:
            # 网关插在动作之后：动作 → 网关 → 各分支
            g.connect(anchor.rid, gw_node.rid, evidence=[prov])
        for label, dest in gw.branches:
            # 分支去向是散文短语，承接它的节点是流程末梢 —— 用 TERMINAL 而不是
            # EVENT。否则它们全被 dead_ends() 报成"流程断点"（散文短语当然没有
            # 下游），淹掉真正的断点。
            leaf = g.add_node(FlowNode(
                rid=make_rid("fn", f"gwend_{dest}_{gw.cite}"),
                kind=NodeKind.TERMINAL, stage=stage,
                label=extracted(dest, prov)))
            g.connect(gw_node.rid, leaf.rid, kind=EdgeKind.CONDITIONAL,
                     label=label, evidence=[prov])
    return g


# ══════════════════════════════════════════════════════════════════
#  缺口 → 问题
# ══════════════════════════════════════════════════════════════════
def gaps_to_questions(g: FlowGraph, *, file_name: str = "") -> list[Any]:
    """把流程图上的缺口变成给客户的待澄清问题。

    这是这个工具真正的价值落点：它不只是画一张图，而是**指出图里哪儿是空的、
    并把空的地方翻译成一个能问客户的问题**。图上标黄（推断/断路）的每一处，
    背后都有一个 FDE 本该问却容易漏掉的问题。

    产出 :class:`~.oir.OpenQuestion`，直接进 OIR 的问题容器，和问卷里搬来的
    问题合流成一份清单 —— 客户不需要知道哪条是他自己提的、哪条是系统发现的。

    Returns:
        ``OpenQuestion`` 列表。
    """
    from .oir import OpenQuestion, make_rid

    qs: list[Any] = []

    def _q(text: str, group: str, node: FlowNode | None = None) -> None:
        ev = (node.label.evidence if node and node.label.evidence
              else [Provenance("f", file_name, {"kind": "raw"},
                               snippet=text, extractor="rule", confidence=1.0)])
        qs.append(OpenQuestion(
            rid=make_rid("oq", f"flow_{text[:40]}"),
            text=extracted(text, *ev[:1]), group=group,
            asked_by="system"))

    # 死路：流程走到这里断了，材料没写下游
    for n in g.dead_ends():
        _q(f"「{n.label.value}」之后是什么？流程走到这里就断了，"
           f"材料里没有写它的下一步。", "流程断点", n)

    # 网关没标条件的分支：读图人不知道什么时候走哪条
    for n in g.unlabeled_branches():
        _q(f"「{n.label.value}」这个判断，各个分支的触发条件分别是什么？", "判断条件", n)

    # 动作没有对应事件：下游没法挂监听
    for n in g.actions_without_events():
        _q(f"「{n.label.value}」做完之后，系统里能观测到什么结果（状态变化/生成的单据）？",
           "动作结果", n)

    # 推断出来的边太多，说明整条链的衔接靠猜
    inferred = g.stats().get("inferred_edges", 0)
    if inferred >= 3:
        _q(f"整个流程有 {inferred} 处衔接是系统按节点顺序推断的，"
           f"材料里没有明确写。这些节点之间的实际先后顺序，能确认一下吗？", "流程顺序")

    return qs
