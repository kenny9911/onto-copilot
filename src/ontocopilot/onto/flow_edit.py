"""对话动态改流程图 —— 结构化编辑。

和模板编辑同构：流图是数据结构（:class:`~.flow.FlowGraph`），FDE 看着生成的
草稿图会要改 —— 改个节点措辞、补一条材料没写但他知道的边、删掉一个抽错的节点、
把节点挪到另一个阶段。

同样的纪律：**模型只选操作和参数，不重画整张图。** 直接让模型吐一张新 FlowGraph
会丢掉证据链 —— 每个节点/边的 ``Provenance`` 是这张图"不是瞎编"的凭证，重画一次
全没了。结构化编辑保留没被碰过的部分的出处。

一条关键区分：**FDE 手动补的边和节点，来源是"人工添加"，不是材料。** 它们在图上
和推断的边一样标出来 —— 但语义不同：推断是系统猜的，人工是 FDE 拍的板。两者都
不该冒充材料依据。
"""

from __future__ import annotations

from typing import Any

from .flow import EdgeKind, FlowEdge, FlowGraph, FlowNode, NodeKind
from .oir import Provenance, extracted, inferred, make_rid

__all__ = ["FlowEditError", "apply_flow_edit"]


class FlowEditError(ValueError):
    """一次流图编辑不合法。消息要说清为什么，让模型能转述。"""


_KINDS = {"action": NodeKind.ACTION, "event": NodeKind.EVENT,
          "gateway": NodeKind.GATEWAY, "terminal": NodeKind.TERMINAL,
          "external": NodeKind.EXTERNAL}


def _find_node(g: FlowGraph, ref: str) -> FlowNode:
    """按 rid、编号或标签找节点。FDE 说的是标签，不是 rid。"""
    if ref in g.nodes:
        return g.nodes[ref]
    hit = [n for n in g.nodes.values()
           if n.code == ref or n.label.value == ref]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        # 模糊：标签包含
        hit = [n for n in g.nodes.values() if ref in n.label.value]
    if len(hit) == 1:
        return hit[0]
    if not hit:
        raise FlowEditError(f"找不到节点「{ref}」。")
    raise FlowEditError(f"「{ref}」对应多个节点，说得更具体些："
                        f"{'、'.join(n.label.value for n in hit[:5])}")


def _human_prov(note: str) -> Provenance:
    """人工编辑的来源标记。**不是材料** —— 它是 FDE 拍的板，图上照样标出来，
    但和系统推断区分开。"""
    return Provenance("human", "人工编辑", {"kind": "meta", "field": note},
                      snippet=note, extractor="human", confidence=1.0)


# ══════════════════════════════════════════════════════════════════
#  操作
# ══════════════════════════════════════════════════════════════════
def _op_rename_node(g: FlowGraph, *, node: str, label: str) -> str:
    n = _find_node(g, node)
    old = n.label.value
    # 保留原出处 —— 只是改了措辞，依据没变
    ev = n.label.evidence or [_human_prov(f"人工改名：{old}→{label}")]
    n.label = extracted(label, *ev[:1])
    return f"把「{old}」改名为「{label}」。"


def _op_set_actor(g: FlowGraph, *, node: str, actor: str) -> str:
    n = _find_node(g, node)
    if n.kind is not NodeKind.ACTION:
        raise FlowEditError(f"「{n.label.value}」不是动作节点，没有执行者。")
    n.actor = extracted(actor, _human_prov(f"人工指定执行者：{actor}"))
    return f"「{n.label.value}」的执行者设为「{actor}」。"


def _op_set_stage(g: FlowGraph, *, node: str, stage: str) -> str:
    n = _find_node(g, node)
    # stage 可以是 key 或阶段标题
    key = next((k for k, st in g.stages.items()
                if k == stage or stage in st.title), None)
    if key is None:
        raise FlowEditError(f"没有阶段「{stage}」。现有："
                            f"{'、'.join(st.title for st in g.stages.values())}")
    n.stage = key
    return f"把「{n.label.value}」移到「{g.stages[key].title}」。"


def _op_add_node(g: FlowGraph, *, kind: str, label: str, stage: str = "",
                 actor: str = "") -> str:
    if kind not in _KINDS:
        raise FlowEditError(f"节点类型只能是 {list(_KINDS)}，不是 {kind}。")
    stage_key = ""
    if stage:
        stage_key = next((k for k, st in g.stages.items()
                          if k == stage or stage in st.title), "")
        if not stage_key:
            raise FlowEditError(f"没有阶段「{stage}」。")
    prov = _human_prov(f"人工添加节点：{label}")
    n = g.add_node(FlowNode(
        rid=make_rid("fn", f"manual_{label}"), kind=_KINDS[kind],
        stage=stage_key, label=inferred(label),   # inferred：人工加的，不冒充材料
        actor=extracted(actor, prov) if actor else inferred("")))
    n.label.evidence = [prov]   # 标成人工来源，图上会标出来
    return f"加了一个{kind}节点「{label}」（人工添加，图上会标注）。"


def _op_connect(g: FlowGraph, *, source: str, target: str, label: str = "") -> str:
    src = _find_node(g, source)
    tgt = _find_node(g, target)
    # 人工连的边：EdgeKind.INFERRED 让它在图上是虚线，但 evidence 标人工来源
    prov = _human_prov(f"人工连边：{src.label.value}→{tgt.label.value}")
    e = g.connect(src.rid, tgt.rid, kind=EdgeKind.INFERRED, label=label,
                  evidence=[prov])
    del e
    return (f"连了一条边：「{src.label.value}」→「{tgt.label.value}」"
            f"{f'（{label}）' if label else ''}。人工添加的边图上是虚线。")


def _op_disconnect(g: FlowGraph, *, source: str, target: str) -> str:
    src = _find_node(g, source)
    tgt = _find_node(g, target)
    gone = [e.rid for e in g.edges.values()
            if e.source == src.rid and e.target == tgt.rid]
    if not gone:
        raise FlowEditError(f"「{src.label.value}」和「{tgt.label.value}」之间没有边。")
    for rid in gone:
        g.edges.pop(rid, None)
    return f"删掉了「{src.label.value}」→「{tgt.label.value}」的边。"


def _op_remove_node(g: FlowGraph, *, node: str) -> str:
    n = _find_node(g, node)
    # 连带删掉挂在它上面的边 —— 留下悬空边比留下节点更糟
    for rid in [e.rid for e in g.edges.values()
                if e.source == n.rid or e.target == n.rid]:
        g.edges.pop(rid, None)
    g.nodes.pop(n.rid, None)
    return f"删掉了节点「{n.label.value}」及其相连的边。"


def _op_set_branch_label(g: FlowGraph, *, source: str, target: str,
                         label: str) -> str:
    """给网关的一条出边贴条件标签（通过/驳回）。"""
    src = _find_node(g, source)
    tgt = _find_node(g, target)
    hit = [e for e in g.edges.values()
           if e.source == src.rid and e.target == tgt.rid]
    if not hit:
        raise FlowEditError(f"「{src.label.value}」和「{tgt.label.value}」之间没有边。")
    hit[0].label = label
    hit[0].kind = EdgeKind.CONDITIONAL
    return f"给「{src.label.value}」→「{tgt.label.value}」这条边标上「{label}」。"


_OPS = {
    "rename_node": _op_rename_node,
    "set_actor": _op_set_actor,
    "set_stage": _op_set_stage,
    "add_node": _op_add_node,
    "connect": _op_connect,
    "disconnect": _op_disconnect,
    "remove_node": _op_remove_node,
    "set_branch_label": _op_set_branch_label,
}


def apply_flow_edit(g: FlowGraph, op: str, args: dict[str, Any]) -> str:
    """对流图应用一次结构化编辑，成功返回一句人话。

    抛 :class:`FlowEditError` 时原图不动 —— 大多数操作是就地改单个对象，
    失败发生在找不到节点/参数不对，此时还没动过任何东西。
    """
    fn = _OPS.get(op)
    if fn is None:
        raise FlowEditError(f"不支持的流图编辑 {op}。支持：{sorted(_OPS)}")
    try:
        return fn(g, **args)
    except TypeError as exc:
        raise FlowEditError(f"{op} 的参数不对：{exc}") from exc
