"""流程模型 —— Workflow / Action / Event / Gateway。

这一层是产品重心的落点。OIR 原来的六个容器（对象/属性/关系/行动/规则/问题）
描述的是**静态结构**：有什么东西、它们长什么样。但 FDE 拿到一堆流程说明文档时，
他真正要搞清楚的是**动态过程**：谁在什么时候做了什么、做完之后发生了什么、
什么情况下走另一条路。这两件事用同一套容器表达不了。

目标产物是一张这样的图：

    阶段一｜集采计划编制与审批
      〔EVENT〕集采计划编制已发起 ──▶ 〔ACTION〕编制集采计划 ──▶ 〔EVENT〕集采计划已生成
        ──▶ 〔ACTION〕审批集采计划 ──▶ ◇集采计划审批结果 ──通过──▶ 〔EVENT〕已通过
                                                    └──驳回──▶ 〔EVENT〕已驳回 ──▶ 回到编制

几条贯穿整个模块的设计判断：

**Action 和 Event 是两种节点，不是一种。** 合成一种（"步骤"）会让图立刻失去信息：
"提交采购计划"和"采购计划已提交"在时间上差一个瞬间，在责任上差一整个系统边界 ——
前者是有人要做的事，后者是做完之后别人能观测到的事实。下游要按 Event 挂监听、
按 Action 挂权限，混在一起两边都挂不上。

**每条边都要能回答"凭什么"。** 从流程文档里抽出来的边有出处；为了让图连通而补的
边没有。**草稿图上必须一眼看得出哪些是补的** —— 一张分不清哪里是猜的流程图，
比没有图更危险，因为它看起来同样确定。

**编号由规则生成，不让模型编。** ``ACT-CP-DRAFT`` / ``EVT-CP-PLANNING-REQUESTED``
这种编号是下游系统的锚点，模型每次生成都会漂移一点，而漂移的编号意味着两版图
之间没法做 diff。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from ..kernel.ids import sha256_hex
from .oir import Assertion, Provenance, Status, inferred, make_rid

__all__ = [
    "EdgeKind",
    "FlowEdge",
    "FlowGraph",
    "FlowNode",
    "NodeKind",
    "Stage",
    "Workflow",
    "code_for",
    "domain_code",
    "flow_from_dict",
]


class NodeKind(StrEnum):
    """流程图上的节点类型。颜色与形状由它决定。"""

    ACTION = "action"      # 蓝色圆角矩形：有人/系统要做的一件事
    EVENT = "event"        # 橙色圆角矩形：做完之后可观测的事实
    GATEWAY = "gateway"    # 黄色菱形：分叉点，出边带条件
    TERMINAL = "terminal"  # 绿色矩形：终态或汇聚点
    EXTERNAL = "external"  # 外部平台/接口，虚线框


class EdgeKind(StrEnum):
    """边的类型。虚线和实线的区别不是好看，是**可信度**。"""

    FLOW = "flow"            # 实线：材料里写明的顺序
    CONDITIONAL = "cond"     # 实线带标签：网关的一条出边
    COMPENSATE = "comp"      # 紫色：逆向补偿/撤销路径
    EXTERNAL = "external"    # 虚线：跨系统调用，或延伸设计
    INFERRED = "inferred"    # 虚线灰：**我们补的**，材料里没有直接依据


@dataclass(slots=True)
class FlowNode:
    """流程图上的一个节点。"""

    rid: str
    kind: NodeKind
    #: 人读的名字，中文。图上显示的就是它。
    label: Assertion[str]
    #: 机器编号，如 ``ACT-CP-DRAFT``。下游系统按它挂钩子，**必须稳定**。
    code: str = ""
    #: 所属阶段（泳道）。
    stage: str = ""
    #: 承担这一步的角色。Action 才有意义。
    actor: Assertion[str] = field(default_factory=lambda: inferred(""))
    #: 关联的业务对象 rid —— 把流程图和实体模型接起来。
    objects: list[str] = field(default_factory=list)
    #: 外部系统节点专用：调的是哪个平台的什么接口。
    endpoint: str = ""
    status: Status = Status.CANDIDATE

    @property
    def grounded(self) -> bool:
        """这个节点有没有材料依据。没有的要在图上标出来。"""
        return bool(self.label.evidence)

    def to_dict(self) -> dict[str, Any]:
        return {"rid": self.rid, "kind": str(self.kind), "code": self.code,
                "label": self.label.to_dict(), "stage": self.stage,
                "actor": self.actor.to_dict(), "objects": self.objects,
                "endpoint": self.endpoint, "status": str(self.status),
                "grounded": self.grounded}


@dataclass(slots=True)
class FlowEdge:
    """一条边。"""

    rid: str
    source: str
    target: str
    kind: EdgeKind = EdgeKind.FLOW
    #: 条件标签，如"通过"/"驳回"。网关的出边必须有。
    label: str = ""
    evidence: list[Provenance] = field(default_factory=list)

    @property
    def grounded(self) -> bool:
        return bool(self.evidence)

    def to_dict(self) -> dict[str, Any]:
        return {"rid": self.rid, "from": self.source, "to": self.target,
                "kind": str(self.kind), "label": self.label,
                "grounded": self.grounded,
                "evidence": [e.to_dict() for e in self.evidence[:3]]}


@dataclass(slots=True)
class Stage:
    """一个阶段 = 图上的一条泳道。"""

    key: str
    title: str          # 阶段一｜集采计划编制与审批
    subtitle: str = ""  # 泳道标题下面那行小字
    order: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "title": self.title,
                "subtitle": self.subtitle, "order": self.order}


@dataclass(slots=True)
class Workflow:
    """一条完整的业务流。

    和 Stage 是两个维度：一条 Workflow 可以横跨多个阶段（采购计划从编制一路走到
    寻源），一个阶段里也可以有多条 Workflow 并行。图上泳道按 Stage 分，
    而 Workflow 是"从这里出发能走到哪"的追踪单位。
    """

    key: str
    title: str
    entry: str = ""            # 入口节点 rid
    exits: list[str] = field(default_factory=list)
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "title": self.title, "entry": self.entry,
                "exits": self.exits, "description": self.description}


# ══════════════════════════════════════════════════════════════════
#  编号
# ══════════════════════════════════════════════════════════════════
#: 常见业务域的短码。命中不了就从名字里生成，**永远不问模型** ——
#: 编号是下游系统的锚点，模型每次生成都会漂一点，而漂移的编号意味着两版图
#: 之间没法 diff。
_DOMAIN_CODES: dict[str, str] = {
    "集采计划": "CP", "采购需求计划": "PBP", "采购执行计划": "EP",
    "采购申请": "PR", "采购包": "PKG", "采购合同": "CT", "库存": "INV",
    "预算": "BDG", "寻源": "SRC", "供应商": "SUP", "跟踪": "TRK",
    "预警": "ALM", "报告": "RPT", "审批": "APR",
}

#: Action 的动词短码。中文动词 → 英文，图上编号才读得懂。
_VERB_CODES: dict[str, str] = {
    "编制": "DRAFT", "创建": "CREATE", "新建": "CREATE", "生成": "GENERATE",
    "提交": "SUBMIT", "审批": "APPROVE", "审核": "REVIEW", "确认": "CONFIRM",
    "驳回": "REJECT", "修改": "UPDATE", "变更": "CHANGE", "取消": "CANCEL",
    "作废": "VOID", "关闭": "CLOSE", "分配": "ALLOCATE", "拆分": "SPLIT",
    "合并": "MERGE", "导入": "IMPORT", "导出": "EXPORT", "同步": "SYNC",
    "调拨": "TRANSFER", "占用": "RESERVE", "释放": "RELEASE", "发布": "PUBLISH",
    "升级": "ESCALATE", "查询": "QUERY", "监控": "MONITOR", "评估": "ASSESS",
}

_CN = re.compile(r"[一-鿿]+")


def domain_code(text: str) -> str:
    """从一段中文里认出业务域短码。认不出返回空串 —— 不瞎编。"""
    for name, code in _DOMAIN_CODES.items():
        if name in text:
            return code
    return ""


def _verb_code(text: str) -> str:
    for verb, code in _VERB_CODES.items():
        if text.startswith(verb) or verb in text[:4]:
            return code
    return ""



#: 事件名 → 编号后缀。事件是**已经发生的事**，编号也该读起来像
#: （``EVT-CP-PLANNING-REQUESTED``），而不是一串哈希。
#: 顺序即优先级：先匹配到的赢，所以更具体的排在前面。
_EVENT_CODES: tuple[tuple[str, str], ...] = (
    ("编制已发起", "PLANNING-REQUESTED"), ("已发起", "REQUESTED"),
    ("已生成", "GENERATED"), ("已创建", "CREATED"), ("已提交", "SUBMITTED"),
    ("已通过", "APPROVED"), ("已批准", "APPROVED"), ("已驳回", "REJECTED"),
    ("已拒绝", "REJECTED"), ("已取消", "CANCELLED"), ("已作废", "VOIDED"),
    ("已关闭", "CLOSED"), ("已修改", "CHANGED"), ("已变更", "CHANGED"),
    ("已分配", "ALLOCATED"), ("已拆分", "SPLIT"), ("已合并", "MERGED"),
    ("已完成", "COMPLETED"), ("已失败", "FAILED"), ("已超时", "TIMEOUT"),
    ("已发布", "PUBLISHED"), ("已升级", "ESCALATED"), ("已确认", "CONFIRMED"),
    ("已占用", "RESERVED"), ("已释放", "RELEASED"), ("已入池", "POOLED"),
    ("已中止", "ABORTED"), ("已生效", "EFFECTIVE"), ("已归档", "ARCHIVED"),
    ("已检测", "DETECTED"), ("已触发", "TRIGGERED"),
)


def _event_code(text: str) -> str:
    """从事件名末尾认出状态词。认不出返回空 —— 兜底交给上层，不在这里编。"""
    for cn, code in _EVENT_CODES:
        if cn in text:
            return code
    return ""


def code_for(kind: NodeKind, label: str, *, stage_hint: str = "",
             taken: set[str] | None = None) -> str:
    """给一个节点生成稳定编号。

    ``ACT-CP-DRAFT`` / ``EVT-CP-PLANNING-REQUESTED`` 这种形态。规则生成而不是
    让模型编：同一个节点在两次运行里必须得到同一个编号，否则两版图之间没法
    做 diff，而 diff 恰恰是这个工具第二轮之后的主要价值。

    Args:
        taken: 已用编号。撞号时加数字后缀 —— 撞号会让下游的钩子挂错节点。
    """
    prefix = {NodeKind.ACTION: "ACT", NodeKind.EVENT: "EVT",
              NodeKind.GATEWAY: "GW", NodeKind.TERMINAL: "END",
              NodeKind.EXTERNAL: "EXT"}[kind]
    dom = domain_code(label) or domain_code(stage_hint) or "GEN"

    tail = _event_code(label) if kind is NodeKind.EVENT else _verb_code(label)
    if not tail:
        # 认不出语义就用**内容哈希**，不是 Python 的 hash() ——
        # 后者带进程随机盐，同一个节点每次启动都会拿到不同编号，
        # 两版图之间的 diff 直接全红。
        cn = "".join(_CN.findall(label)) or label
        tail = sha256_hex(cn)[:4].upper()

    code = f"{prefix}-{dom}-{tail}"
    if taken is None or code not in taken:
        return code
    i = 2
    while f"{code}-{i}" in taken:
        i += 1
    return f"{code}-{i}"


# ══════════════════════════════════════════════════════════════════
#  图
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class FlowGraph:
    """一个项目的完整流程图。"""

    nodes: dict[str, FlowNode] = field(default_factory=dict)
    edges: dict[str, FlowEdge] = field(default_factory=dict)
    stages: dict[str, Stage] = field(default_factory=dict)
    workflows: dict[str, Workflow] = field(default_factory=dict)

    # ── 构建 ────────────────────────────────────────────────────
    def add_node(self, n: FlowNode) -> FlowNode:
        if not n.code:
            n.code = code_for(n.kind, n.label.value, stage_hint=n.stage,
                              taken={x.code for x in self.nodes.values()})
        self.nodes[n.rid] = n
        return n

    def add_edge(self, e: FlowEdge) -> FlowEdge:
        self.edges[e.rid] = e
        return e

    def connect(self, src: str, dst: str, *, kind: EdgeKind = EdgeKind.FLOW,
                label: str = "", evidence: list[Provenance] | None = None) -> FlowEdge:
        return self.add_edge(FlowEdge(
            rid=make_rid("fe", f"{src}->{dst}:{label}"), source=src, target=dst,
            kind=kind, label=label, evidence=list(evidence or [])))

    # ── 查询 ────────────────────────────────────────────────────
    def out_edges(self, rid: str) -> list[FlowEdge]:
        return [e for e in self.edges.values() if e.source == rid]

    def in_edges(self, rid: str) -> list[FlowEdge]:
        return [e for e in self.edges.values() if e.target == rid]

    def by_stage(self) -> dict[str, list[FlowNode]]:
        """按泳道分组，泳道内按 order。"""
        out: dict[str, list[FlowNode]] = {}
        for n in self.nodes.values():
            out.setdefault(n.stage or "未分阶段", []).append(n)
        return out

    # ── 规模化 ──────────────────────────────────────────────────
    def main_path(self) -> FlowGraph:
        """只留主干：有材料依据的节点和边。

        47 个 Action + 101 个 Event 全画出来会边全交叉、字全重叠 —— 一张看不清
        的图和没有图一样没用。主干视图砍掉两类噪声：**推断出来的边**（我们补的，
        本就不确定）和**只连着推断边的孤立节点**。保留的是"材料明确写了顺序"的
        那条骨架，客户第一眼要看的就是它。

        返回一个新图，不改原图 —— 完整图仍然可查，只是默认先给主干。
        """
        keep_edges = [e for e in self.edges.values() if e.grounded]
        touched = {e.source for e in keep_edges} | {e.target for e in keep_edges}
        sub = FlowGraph(stages=dict(self.stages), workflows=dict(self.workflows))
        for rid, n in self.nodes.items():
            # 保留：连在有依据的边上的，或本身有依据且不是纯散文叶子的
            if rid in touched or (n.grounded and n.kind is not NodeKind.TERMINAL):
                sub.nodes[rid] = n
        for e in keep_edges:
            if e.source in sub.nodes and e.target in sub.nodes:
                sub.edges[e.rid] = e
        return sub

    # ── 体检 ────────────────────────────────────────────────────
    def dangling(self) -> list[FlowNode]:
        """既没有入边也没有出边的节点 —— 抽出来了但没接上，多半是漏了边。"""
        return [n for n in self.nodes.values()
                if not self.in_edges(n.rid) and not self.out_edges(n.rid)]

    def dead_ends(self) -> list[FlowNode]:
        """有入边、没出边、又不是终态 —— 流程在这里断了。

        这是流程图上最容易被忽略的错误：图看起来是连的，但顺着走会走进死胡同，
        而那往往意味着材料里少了一段。
        """
        return [n for n in self.nodes.values()
                if n.kind is not NodeKind.TERMINAL
                and self.in_edges(n.rid) and not self.out_edges(n.rid)]

    def unlabeled_branches(self) -> list[FlowNode]:
        """网关的出边没有条件标签 —— 看图的人不知道什么时候走哪条。"""
        return [n for n in self.nodes.values()
                if n.kind is NodeKind.GATEWAY
                and any(not e.label for e in self.out_edges(n.rid))]

    def actions_without_events(self) -> list[FlowNode]:
        """做了一件事却没有任何可观测的结果 —— 下游没法挂监听。"""
        out = []
        for n in self.nodes.values():
            if n.kind is not NodeKind.ACTION:
                continue
            if not any(self.nodes.get(e.target, FlowNode("", NodeKind.EVENT,
                                                         inferred(""))).kind
                       is NodeKind.EVENT for e in self.out_edges(n.rid)):
                out.append(n)
        return out

    def stats(self) -> dict[str, int]:
        kinds = {k: 0 for k in NodeKind}
        for n in self.nodes.values():
            kinds[n.kind] += 1
        return {
            "stages": len(self.stages), "workflows": len(self.workflows),
            "actions": kinds[NodeKind.ACTION], "events": kinds[NodeKind.EVENT],
            "gateways": kinds[NodeKind.GATEWAY],
            "terminals": kinds[NodeKind.TERMINAL],
            "externals": kinds[NodeKind.EXTERNAL],
            "edges": len(self.edges),
            # 有多少是我们补的 —— 这个数字直接决定这张图能不能拿去跟客户对
            "inferred_edges": sum(1 for e in self.edges.values() if not e.grounded),
            "dangling": len(self.dangling()), "dead_ends": len(self.dead_ends()),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "stages": [s.to_dict() for s in
                       sorted(self.stages.values(), key=lambda x: x.order)],
            "workflows": [w.to_dict() for w in self.workflows.values()],
            "nodes": [n.to_dict() for n in self.nodes.values()],
            "edges": [e.to_dict() for e in self.edges.values()],
            "stats": self.stats(),
        }


def flow_from_dict(data: dict[str, Any]) -> FlowGraph:
    """从 :meth:`FlowGraph.to_dict` 还原。

    恢复会话时要用 —— ``_flow`` 是活对象，重启后没了，只剩磁盘上的 flow.json。
    不还原它，对话里「改流程图」就无从下手。溯源要原样还原：人工加的节点
    （extractor=human）和材料抽的、系统推断的，三者在图上区分开，降级成 inferred
    会让这个区分消失。
    """
    from .oir import Assertion, Origin, Provenance

    def _prov(d: dict[str, Any]) -> Provenance:
        return Provenance(
            file_id=str(d.get("file_id") or ""), file_name=str(d.get("file_name") or ""),
            locator=dict(d.get("locator") or {}), snippet=str(d.get("snippet") or ""),
            extractor=str(d.get("extractor") or "llm"),
            confidence=float(d.get("confidence") or 0.5))

    def _assert(d: Any) -> Assertion[Any]:
        if not isinstance(d, dict):
            return inferred(d)
        try:
            origin = Origin(str(d.get("origin") or "inferred"))
        except ValueError:
            origin = Origin.INFERRED
        return Assertion(d.get("value"), origin,
                         [_prov(x) for x in (d.get("evidence") or [])],
                         float(d.get("confidence") or 0.5))

    g = FlowGraph()
    for st in data.get("stages", ()):
        g.stages[st["key"]] = Stage(key=st["key"], title=st.get("title", ""),
                                    subtitle=st.get("subtitle", ""),
                                    order=int(st.get("order", 0)))
    for w in data.get("workflows", ()):
        g.workflows[w["key"]] = Workflow(
            key=w["key"], title=w.get("title", ""), entry=w.get("entry", ""),
            exits=list(w.get("exits") or []), description=w.get("description", ""))
    for n in data.get("nodes", ()):
        try:
            kind = NodeKind(n["kind"])
        except ValueError:
            kind = NodeKind.ACTION
        node = FlowNode(rid=n["rid"], kind=kind, label=_assert(n.get("label")),
                        code=n.get("code", ""), stage=n.get("stage", ""),
                        actor=_assert(n.get("actor")),
                        objects=list(n.get("objects") or []),
                        endpoint=n.get("endpoint", ""))
        g.nodes[node.rid] = node
    for e in data.get("edges", ()):
        try:
            kind = EdgeKind(e["kind"])
        except ValueError:
            kind = EdgeKind.FLOW
        g.edges[e["rid"]] = FlowEdge(
            rid=e["rid"], source=e.get("from", ""), target=e.get("to", ""),
            kind=kind, label=e.get("label", ""),
            evidence=[_prov(x) for x in (e.get("evidence") or [])])
    return g
