"""onto/diagram.py 的 golden 导出 —— 给 ts/src/onto/diagram.ts 当安全网。

渲染层的期望值**一个字都不许手写**：SVG 是几十个坐标拼出来的字符串，手写一遍
等于把 Python 的布局算法在脑子里重跑一遍，而脑子重跑的正确率远低于机器。

导什么、为什么导它：

* ``_mid`` —— mermaid 节点 id 的清洗。判据是 ``c.isalnum()``，**Python 的
  isalnum 是 Unicode 级的**：中文、全角字母、罗马数字 Ⅷ、阿拉伯-印度数字 ٣
  全都算 alnum，只有 emoji 之类才被换成 ``_``。TS 侧照 ``/[a-zA-Z0-9]/`` 写会
  把每个中文都换成下划线，整张 mermaid 的节点 id 全变成 ``n________``，
  互相撞号之后图会连错。外加 ``[:40]`` 是**按 code point** 切。
* ``_wrap`` —— 中文按字数折行。``t[i:i+per_line]`` 同样按 code point，
  emoji 标签在 TS 侧按 UTF-16 切会得到半个代理对（渲染成 �）。
* ``_layer`` —— 泳道内分层。有环时 Kahn 剩下的一律塞最后一层，顺序取自
  ``remaining`` 的插入序，TS 侧必须用 Map 才复现得出来。
* ``cases`` —— 每个退化输入一组完整产物（mermaid ×2 + svg ×2）。
  **空图是重点**：``to_svg`` 上一版在零泳道时产出 ``[None]`` 然后 AttributeError，
  而"材料里没有流程说明"恰恰会走到这条路 —— 空图是新会话的初始状态。

每个 case 同时导 ``flow``（``FlowGraph.to_dict()``）—— TS 侧用 ``flowFromDict``
还原同一张图再渲染。**产物是从还原后的图渲染的**，不是从原图：这样 golden 里的
输入（dict）和输出（svg）之间没有任何 TS 侧看不见的中间状态。

跑法::

    .venv/bin/python tools/golden/onto_diagram.py

输出 ``golden/onto.diagram.json``（新文件，我独占）。全部输入都是字面量或
``golden/pipeline.flow.json``，重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.diagram import (  # noqa: E402
    Palette,
    _layer,
    _mid,
    _mlabel,
    _wrap,
    to_mermaid,
    to_svg,
)
from ontocopilot.onto.flow import (  # noqa: E402
    EdgeKind,
    FlowEdge,
    FlowGraph,
    FlowNode,
    NodeKind,
    Stage,
    Workflow,
    flow_from_dict,
)
from ontocopilot.onto.oir import Provenance, extracted, inferred  # noqa: E402

GOLDEN = ROOT / "golden"


def prov(snippet: str, ref: str = "R1") -> Provenance:
    """出处。``grounded`` 只看 evidence 非空，内容本身不进渲染结果（除了
    ``_cite`` 那条路，diagram 不走），所以固定字面量即可。"""
    return Provenance(
        file_id="f", file_name="材料.xlsx",
        locator={"kind": "raw", "ref": ref}, snippet=snippet,
        extractor="rule", confidence=1.0,
    )


def node(rid: str, kind: NodeKind, label: str, *, code: str = "", stage: str = "",
         endpoint: str = "", grounded: bool = True) -> FlowNode:
    """直接构造 FlowNode 而不走 ``FlowGraph.add_node`` —— 后者会调 ``code_for``
    自动编号，那是 flow.py 的行为，不该混进 diagram 的 golden 里。"""
    lab = extracted(label, prov(label)) if grounded else inferred(label)
    return FlowNode(rid=rid, kind=kind, label=lab, code=code, stage=stage,
                    endpoint=endpoint)


def edge(rid: str, src: str, dst: str, kind: EdgeKind = EdgeKind.FLOW,
         label: str = "", *, grounded: bool = True) -> FlowEdge:
    return FlowEdge(rid=rid, source=src, target=dst, kind=kind, label=label,
                    evidence=[prov(f"{src}->{dst}")] if grounded else [])


# ══════════════════════════════════════════════════════════════════
#  1. 单元向量
# ══════════════════════════════════════════════════════════════════
#: ``_mid`` 的输入。前四条是真实 rid 的形态，后面全是 Unicode 陷阱：
#: 全角字母/数字、圈号 ①（category No）、罗马数字 Ⅷ（Nl）、阿拉伯-印度数字 ٣（Nd）、
#: emoji（非 alnum → ``_``）、CJK 扩展 B 的生僻字（**astral**，切片单位在这里分叉）。
MID_CASES = [
    "fn_act1_创建采购需求计划",
    "fn_evt_已提交",
    "ab-cd.ef",
    "",
    "①②③",
    "ＡＢ１２",
    "Ⅷ",
    "٣",
    "😀x",
    "a" * 60,
    "中" * 60,
    "𠀀" * 60,          # 每个字符 2 个 UTF-16 码元：Python 取 40 个字，JS slice 取 20
    "a😀𠀀b",
    "!@#$%^&*()",
]

MLABEL_CASES = [
    "",
    '含"引号"的标签',
    "含[方括号]的标签",
    '["混合"]',
    "正常标签",
]

#: ``_wrap`` 的输入 —— 含默认参数（11/3）与 to_svg 里实际用的（12/2）两组。
WRAP_CASES: list[tuple[str, int, int]] = [
    ("", 11, 3),
    ("   ", 11, 3),
    ("短", 11, 3),
    ("  前后有空格  ", 11, 3),
    ("一二三四五六七八九十甲乙丙丁", 11, 3),
    ("一二三四五六七八九十甲乙丙丁", 12, 2),
    ("x" * 100, 11, 3),
    ("x" * 100, 12, 2),
    ("😀" * 40, 11, 3),
    ("😀" * 40, 12, 2),
    ("𠀀" * 40, 12, 2),
    ("abc", 1, 3),
    ("abcdefgh", 2, 2),
]


# ══════════════════════════════════════════════════════════════════
#  2. 图 —— 每个退化输入一张
# ══════════════════════════════════════════════════════════════════
def g_empty() -> FlowGraph:
    """空图。**这是重点**：新会话、或者材料里根本没有流程说明时就是这张。
    上一版 to_svg 在这里抛 AttributeError，整条建图链路一起死。"""
    return FlowGraph()


def g_single() -> FlowGraph:
    """单节点、零边、零阶段。``_layer`` 的 while 循环只转一圈，
    ``max((len(c) for c in layers), default=1)`` 的 default 分支在这里不走 ——
    走 default 的是 g_stage_empty。"""
    g = FlowGraph()
    g.nodes["fn_a"] = node("fn_a", NodeKind.ACTION, "编制集采计划", code="ACT-CP-DRAFT")
    return g


def g_single_ungrounded() -> FlowGraph:
    """没有材料依据的单节点 —— mermaid 要加「· 推断 ·」，SVG 要画虚线框。
    分不清哪里是猜的流程图比没有图更危险。"""
    g = FlowGraph()
    g.nodes["fn_a"] = node("fn_a", NodeKind.EVENT, "计划已生成", code="EVT-CP-GENERATED",
                           grounded=False)
    return g


def g_cycle() -> FlowGraph:
    """驳回重编 —— 真实业务流程里最常见的环。Kahn 一个节点都排不出来，
    全部落进"剩下的塞最后一层"那条路。画得出来比画得对更重要。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title="阶段一｜集采计划编制与审批",
                           subtitle="材料：业务规则 sheet", order=1)
    for rid, kind, label in (
        ("fn_draft", NodeKind.ACTION, "编制集采计划"),
        ("fn_approve", NodeKind.ACTION, "审批集采计划"),
        ("fn_gw", NodeKind.GATEWAY, "审批结果"),
    ):
        g.nodes[rid] = node(rid, kind, label, stage="s1")
    g.edges["fe1"] = edge("fe1", "fn_draft", "fn_approve")
    g.edges["fe2"] = edge("fe2", "fn_approve", "fn_gw")
    g.edges["fe3"] = edge("fe3", "fn_gw", "fn_draft", EdgeKind.CONDITIONAL, "驳回")
    return g


def g_long_label() -> FlowGraph:
    """超长标签 / 超长副标题 / 超长边标签 / 超长接口路径。
    四处截断分别是 ``_wrap`` 的 12×2、``subtitle[:80]``、``label[:8]``、
    以及 endpoint 不截断只进 ``<title>``。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(
        key="s1", title="阶段一｜" + "很长的阶段名" * 10,
        subtitle="副标题" * 40, order=1)
    g.nodes["fn_a"] = node(
        "fn_a", NodeKind.ACTION, "编制采购需求计划并提交审批同时通知相关方确认口径",
        code="ACT-PBP-DRAFT-A-VERY-LONG-CODE", stage="s1",
        endpoint="POST /api/v1/procurement/purchase-budget-plan/submit-for-approval")
    g.nodes["fn_b"] = node("fn_b", NodeKind.EVENT, "😀" * 30, stage="s1")
    g.edges["fe1"] = edge("fe1", "fn_a", "fn_b", EdgeKind.CONDITIONAL,
                          "这是一条非常长的条件标签")
    return g


def g_all_kinds() -> FlowGraph:
    """五种节点 × 五种边，外加需要 HTML 转义的字符。

    ``&`` ``<`` ``>`` ``"`` ``'`` 在 SVG 里必须转义（``html.escape`` 默认
    ``quote=True``，单引号转成 ``&#x27;`` 而不是 ``&apos;``）；在 mermaid 里
    走的是另一套（``_mlabel`` 只换引号和方括号）—— 两级产物的转义规则不同，
    这正是最容易在 TS 侧混成一套的地方。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title='阶段 "一" <A&B>', subtitle="小字 & 说明",
                           order=1)
    g.workflows["w1"] = Workflow(key="w1", title="主流程", entry="fn_act")
    g.nodes["fn_act"] = node("fn_act", NodeKind.ACTION, '提交"计划"', code="ACT-CP-SUBMIT",
                             stage="s1", endpoint="POST /api/plan?a=1&b=2")
    g.nodes["fn_evt"] = node("fn_evt", NodeKind.EVENT, "计划[已提交]", code="EVT-CP-SUBMITTED",
                             stage="s1")
    g.nodes["fn_gw"] = node("fn_gw", NodeKind.GATEWAY, "审批结果 <?>", code="GW-APR-X",
                            stage="s1")
    g.nodes["fn_end"] = node("fn_end", NodeKind.TERMINAL, "流程结束", code="END-CP-DONE",
                             stage="s1")
    g.nodes["fn_ext"] = node("fn_ext", NodeKind.EXTERNAL, "外部平台 & 接口", code="EXT-SUP-1",
                             stage="s1", endpoint="GET /ext/supplier", grounded=False)
    g.edges["fe_flow"] = edge("fe_flow", "fn_act", "fn_evt")
    g.edges["fe_cond"] = edge("fe_cond", "fn_evt", "fn_gw", EdgeKind.CONDITIONAL, "通过")
    g.edges["fe_comp"] = edge("fe_comp", "fn_gw", "fn_act", EdgeKind.COMPENSATE, "撤销")
    g.edges["fe_ext"] = edge("fe_ext", "fn_gw", "fn_ext", EdgeKind.EXTERNAL,
                             '标签"含引号"')
    g.edges["fe_inf"] = edge("fe_inf", "fn_gw", "fn_end", EdgeKind.INFERRED, "",
                             grounded=False)
    return g


def g_unregistered_stage() -> FlowGraph:
    """节点挂在一个没注册的阶段上 —— 那本身是个 bug，但渲染不该因此崩。
    泳道标题回落成 key，mermaid 侧则完全不进 subgraph（``ordered`` 里没有它），
    走"不属于任何阶段"的那条路。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title="已注册阶段", order=1)
    g.nodes["fn_a"] = node("fn_a", NodeKind.ACTION, "在已注册阶段里", stage="s1")
    g.nodes["fn_b"] = node("fn_b", NodeKind.ACTION, "阶段没注册", stage="ghost")
    g.nodes["fn_c"] = node("fn_c", NodeKind.EVENT, "干脆没有阶段")
    g.edges["fe1"] = edge("fe1", "fn_a", "fn_b")
    return g


def g_stage_empty() -> FlowGraph:
    """注册了阶段却一个节点都没有 —— mermaid 侧 ``continue`` 跳过，
    SVG 侧连 band 都不画（``stage_keys`` 用 ``by_stage.get`` 过滤掉了）。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title="空阶段", order=1)
    g.stages["s2"] = Stage(key="s2", title="有节点的阶段", order=2)
    g.nodes["fn_a"] = node("fn_a", NodeKind.ACTION, "唯一节点", stage="s2")
    return g


def g_stage_order() -> FlowGraph:
    """阶段的 order 乱序注册 + 两个同 order —— ``sorted(key=order)`` 是**稳定**排序，
    同 order 的两条保持注册顺序。TS 的 Array.sort 也稳定，但比较器写成
    ``a.order - b.order`` 才等价，写成 ``a.order < b.order ? -1 : 1`` 就不是了。"""
    g = FlowGraph()
    g.stages["s3"] = Stage(key="s3", title="第三", order=3)
    g.stages["s1b"] = Stage(key="s1b", title="并列一 B", order=1)
    g.stages["s1a"] = Stage(key="s1a", title="并列一 A", order=1)
    g.stages["s0"] = Stage(key="s0", title="第零", order=0)
    for k in ("s3", "s1b", "s1a", "s0"):
        g.nodes[f"fn_{k}"] = node(f"fn_{k}", NodeKind.ACTION, f"{k} 的节点", stage=k)
    return g


def g_dangling_edges() -> FlowGraph:
    """边指向不存在的节点 —— mermaid 与 SVG 都要静默跳过而不是抛 KeyError。
    从会话恢复的图里这很常见：节点被人删了，边还在 flow.json 里。"""
    g = FlowGraph()
    g.nodes["fn_a"] = node("fn_a", NodeKind.ACTION, "存在的节点")
    g.edges["fe1"] = edge("fe1", "fn_a", "fn_ghost")
    g.edges["fe2"] = edge("fe2", "fn_ghost", "fn_a")
    g.edges["fe3"] = edge("fe3", "fn_ghost", "fn_ghost2")
    return g


def g_backward() -> FlowGraph:
    """回退边：目标在源的左边，走"从下方绕"的那条贝塞尔。
    两条分支的 ``d`` 串形状完全不同，只测一条等于没测。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title="单泳道", order=1)
    g.nodes["fn_1"] = node("fn_1", NodeKind.ACTION, "第一步", stage="s1")
    g.nodes["fn_2"] = node("fn_2", NodeKind.ACTION, "第二步", stage="s1")
    g.nodes["fn_3"] = node("fn_3", NodeKind.ACTION, "第三步", stage="s1")
    g.edges["fe1"] = edge("fe1", "fn_1", "fn_2")
    g.edges["fe2"] = edge("fe2", "fn_2", "fn_3")
    g.edges["fe3"] = edge("fe3", "fn_3", "fn_1", EdgeKind.COMPENSATE, "整体回退")
    return g


def g_wired() -> FlowGraph:
    """有 Action 接上了接口 —— SVG 抬头那句「x/y 个环节已对上接口」只有
    ``wired`` 非零时才出现。零的时候不写，因为「0 个环节已对上接口」会让人
    以为系统什么都没有。"""
    g = FlowGraph()
    g.nodes["fn_1"] = node("fn_1", NodeKind.ACTION, "有接口的动作",
                           endpoint="POST /api/a")
    g.nodes["fn_2"] = node("fn_2", NodeKind.ACTION, "没接口的动作")
    g.nodes["fn_3"] = node("fn_3", NodeKind.EVENT, "事件也带 endpoint",
                           endpoint="GET /api/b")
    return g


def g_wide() -> FlowGraph:
    """一条泳道里多层多行 —— 撑出 640 以外的画布宽度，把 ``W`` 的
    ``max(max_w + MARGIN, 640)`` 那条分支走到另一边。"""
    g = FlowGraph()
    g.stages["s1"] = Stage(key="s1", title="宽泳道", order=1)
    for i in range(6):
        g.nodes[f"fn_{i}"] = node(f"fn_{i}", NodeKind.ACTION, f"第{i}步", stage="s1")
    # 0→1→2→3 串成 4 层，4 和 5 与 0 同层（无入边）
    for i in range(3):
        g.edges[f"fe_{i}"] = edge(f"fe_{i}", f"fn_{i}", f"fn_{i + 1}")
    return g


def g_pipeline() -> FlowGraph:
    """真材料（材料.xlsx）跑出来的图。字面量搭的图再全，也不如一张真的。"""
    return flow_from_dict(json.loads((GOLDEN / "pipeline.flow.json").read_text("utf-8")))


CASES: list[tuple[str, Any]] = [
    ("empty", g_empty),
    ("single", g_single),
    ("single_ungrounded", g_single_ungrounded),
    ("cycle", g_cycle),
    ("long_label", g_long_label),
    ("all_kinds", g_all_kinds),
    ("unregistered_stage", g_unregistered_stage),
    ("stage_empty", g_stage_empty),
    ("stage_order", g_stage_order),
    ("dangling_edges", g_dangling_edges),
    ("backward", g_backward),
    ("wired", g_wired),
    ("wide", g_wide),
    ("pipeline", g_pipeline),
]

#: 自定义配色。默认色取自客户那张图，但 Palette 是可换的 —— 换了之后每一处
#: 填充/描边/文字色都要跟着换，漏一处就是半张图配色不对。
CUSTOM = Palette(
    action_fill="#111111", action_line="#222222", event_fill="#333333",
    event_line="#444444", gateway_fill="#555555", gateway_line="#666666",
    terminal_fill="#777777", terminal_line="#888888", external_fill="#999999",
    external_line="#aaaaaa", band="#bbbbbb", band_line="#cccccc",
    ink="#dddddd", dim="#eeeeee", edge="#ffffff",
)


def main() -> None:
    out: dict[str, Any] = {
        "mid": [[s, _mid(s)] for s in MID_CASES],
        "mlabel": [[s, _mlabel(s)] for s in MLABEL_CASES],
        "wrap": [{"text": t, "per_line": p, "max_lines": m, "out": _wrap(t, p, m)}
                 for t, p, m in WRAP_CASES],
        "cases": [],
    }

    for name, build in CASES:
        src = build()
        data = src.to_dict()
        # 从**还原后**的图渲染：golden 里的输入是这份 dict，TS 侧也只拿得到它。
        # 从原图渲染的话，两侧之间会隔着一层 flow_from_dict 的往返差异。
        g = flow_from_dict(data)
        out["cases"].append({
            "name": name,
            "flow": data,
            "layers": {k: [[n.rid for n in col] for col in _layer(g, v)]
                       for k, v in sorted(g.by_stage().items())},
            "mermaid": to_mermaid(g),
            "mermaid_tb_nocodes": to_mermaid(g, direction="TB", show_codes=False),
            "svg": to_svg(g),
            "svg_custom": to_svg(g, title='自定义 "标题" <&>', palette=CUSTOM,
                                 show_codes=False),
        })

    path = GOLDEN / "onto.diagram.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                    encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes, {len(out['cases'])} cases)")


if __name__ == "__main__":
    main()
