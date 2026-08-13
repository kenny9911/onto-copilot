"""流程图渲染 —— FlowGraph → mermaid → SVG。

两级产物，不是一级：

    FlowGraph  ──▶  mermaid（人能读、能手改、能进 git、能在任何地方渲染）
               ──▶  SVG（能贴进 PPT 和文档，客户会上直接投屏）

中间那一级不能省。FDE 拿到草稿图之后一定要改 —— 挪个节点、改个措辞、补一条边。
只给 SVG 的话他改不动，只能回来找我们重生成；给了 mermaid，他自己就能在
mermaid live editor 里改完再导出。**能被人接手改的草稿才是草稿，改不动的
只是一张图片。**

SVG 用纯 Python 画，不依赖 mermaid-cli：这个环境拉不到 npm 包，而且多一个
外部进程就多一个部署条件。代价是布局算法要自己写，好处是零依赖、离线可用、
样式完全可控（要和客户那张图长得一样）。
"""

from __future__ import annotations

import html
from dataclasses import dataclass

from .flow import EdgeKind, FlowGraph, FlowNode, NodeKind

__all__ = ["Palette", "to_mermaid", "to_svg"]


# ══════════════════════════════════════════════════════════════════
#  mermaid
# ══════════════════════════════════════════════════════════════════
#: 各类节点的 mermaid 形状。形状本身要携带语义 —— 看图的人不该去对照图例
#: 才知道这个框是动作还是事件。
_SHAPE = {
    NodeKind.ACTION: ("([", "])"),      # 圆角矩形
    NodeKind.EVENT: ("[", "]"),          # 直角矩形
    NodeKind.GATEWAY: ("{", "}"),        # 菱形
    NodeKind.TERMINAL: ("[[", "]]"),     # 双线框
    NodeKind.EXTERNAL: ("[/", "/]"),     # 平行四边形
}

_ARROW = {
    EdgeKind.FLOW: "-->",
    EdgeKind.CONDITIONAL: "-->",
    EdgeKind.COMPENSATE: "-.->",
    EdgeKind.EXTERNAL: "-.->",
    EdgeKind.INFERRED: "-.->",
}


def _mid(rid: str) -> str:
    """mermaid 的节点 id 不能带特殊字符。"""
    return "n" + "".join(c if c.isalnum() else "_" for c in rid)[:40]


def _mlabel(text: str) -> str:
    """mermaid 标签里的引号和方括号会破坏语法。"""
    return (text or "").replace('"', "'").replace("[", "(").replace("]", ")")


def to_mermaid(g: FlowGraph, *, direction: str = "LR",
               show_codes: bool = True) -> str:
    """渲染成 mermaid flowchart。

    泳道用 ``subgraph`` 表达。mermaid 原生没有 BPMN 那种泳道，但 subgraph
    在视觉上足够接近，而且**跨 subgraph 的边照样能画** —— 这是选它而不是选
    别的图型的原因：真实业务流程里跨阶段的回退边（驳回重编）非常多，
    表达不了跨泳道的边等于表达不了业务。

    Args:
        show_codes: 节点标签里带不带 ``ACT-CP-DRAFT`` 这类编号。给客户看的时候
            关掉（他不关心），给下游接系统的人看的时候打开。
    """
    lines = [f"flowchart {direction}"]

    def render_node(n: FlowNode) -> str:
        o, c = _SHAPE[n.kind]
        label = _mlabel(n.label.value)
        if show_codes and n.code:
            label = f"{label}<br/><small>{n.code}</small>"
        if n.endpoint:
            # mermaid 是给人手改的那一级产物，接口路径直接写进标签 ——
            # 在 mermaid live editor 里能读、能搜、能一起改。
            label = f"{label}<br/><small>{_mlabel(n.endpoint)}</small>"
        if not n.grounded:
            # 没有材料依据的节点标出来。**分不清哪里是猜的流程图比没有图更危险**，
            # 因为它看起来同样确定。
            label = f"{label}<br/><small>· 推断 ·</small>"
        return f'    {_mid(n.rid)}{o}"{label}"{c}'

    by_stage = g.by_stage()
    ordered = sorted(g.stages.values(), key=lambda x: x.order)
    seen: set[str] = set()
    for st in ordered:
        members = by_stage.get(st.key) or []
        if not members:
            continue
        lines.append(f'    subgraph {_mid(st.key)}["{_mlabel(st.title)}"]')
        lines.append("        direction LR")
        for n in members:
            lines.append("    " + render_node(n).strip().rjust(0))
            seen.add(n.rid)
        lines.append("    end")

    for rid, n in g.nodes.items():   # 不属于任何阶段的
        if rid not in seen:
            lines.append(render_node(n))

    for e in g.edges.values():
        if e.source not in g.nodes or e.target not in g.nodes:
            continue
        arrow = _ARROW[e.kind]
        seg = (f"{arrow}|{_mlabel(e.label)}|" if e.label
               else arrow)
        lines.append(f"    {_mid(e.source)} {seg} {_mid(e.target)}")

    # 配色和客户那张图对齐 —— 蓝 Action、橙 Event、黄网关、绿终态
    lines += [
        "    classDef act fill:#dbeafe,stroke:#60a5fa,color:#1e3a5f;",
        "    classDef evt fill:#fef3c7,stroke:#fbbf24,color:#78350f;",
        "    classDef gw  fill:#fef9c3,stroke:#eab308,color:#713f12;",
        "    classDef end_ fill:#dcfce7,stroke:#4ade80,color:#14532d;",
        "    classDef ext fill:#f3e8ff,stroke:#c084fc,color:#581c87;",
    ]
    for kind, cls in ((NodeKind.ACTION, "act"), (NodeKind.EVENT, "evt"),
                      (NodeKind.GATEWAY, "gw"), (NodeKind.TERMINAL, "end_"),
                      (NodeKind.EXTERNAL, "ext")):
        ids = [_mid(r) for r, n in g.nodes.items() if n.kind is kind]
        if ids:
            lines.append(f"    class {','.join(ids)} {cls};")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
#  SVG
# ══════════════════════════════════════════════════════════════════
@dataclass(frozen=True, slots=True)
class Palette:
    """配色。默认值取自客户那张图 —— 产出物要能直接贴进他们已有的材料里。"""

    action_fill: str = "#dbeafe"
    action_line: str = "#93c5fd"
    event_fill: str = "#fef3c7"
    event_line: str = "#fcd34d"
    gateway_fill: str = "#fefce8"
    gateway_line: str = "#eab308"
    terminal_fill: str = "#dcfce7"
    terminal_line: str = "#86efac"
    external_fill: str = "#f5f3ff"
    external_line: str = "#c4b5fd"
    band: str = "#fafafa"
    band_line: str = "#e5e7eb"
    ink: str = "#1f2937"
    dim: str = "#6b7280"
    edge: str = "#9ca3af"


#: 布局常数。节点宽高固定 —— 变宽的框会让泳道对不齐，而对齐是这类图可读性的
#: 主要来源。
NODE_W, NODE_H = 168, 52
GAP_X, GAP_Y = 46, 26
BAND_PAD, BAND_HEAD = 18, 40
MARGIN = 24


def _wrap(text: str, per_line: int = 11, max_lines: int = 3) -> list[str]:
    """中文按字数折行。超出行数截断加省略号 —— 框是固定宽的，撑破了整张图就乱。"""
    t = (text or "").strip()
    out = [t[i:i + per_line] for i in range(0, len(t), per_line)]
    if len(out) > max_lines:
        out = out[:max_lines]
        out[-1] = out[-1][:per_line - 1] + "…"
    return out or [""]


def _layer(g: FlowGraph, nodes: list[FlowNode]) -> list[list[FlowNode]]:
    """泳道内分层：按拓扑序排列，同层的并排。

    有环的图（驳回重编是个环）用 Kahn 算法会剩下一堆节点。剩下的一律放到最后
    一层 —— **画得出来比画得对更重要**：一张因为有环就画不出来的流程图，
    对 FDE 的价值是零，而真实业务流程几乎一定有环。
    """
    ids = {n.rid for n in nodes}
    indeg = {n.rid: sum(1 for e in g.in_edges(n.rid) if e.source in ids)
             for n in nodes}
    layers: list[list[FlowNode]] = []
    remaining = {n.rid: n for n in nodes}
    while remaining:
        ready = [n for rid, n in remaining.items() if indeg.get(rid, 0) <= 0]
        if not ready:                      # 环：剩下的全塞最后一层
            layers.append(list(remaining.values()))
            break
        layers.append(ready)
        for n in ready:
            remaining.pop(n.rid, None)
            for e in g.out_edges(n.rid):
                if e.target in remaining:
                    indeg[e.target] = indeg.get(e.target, 1) - 1
    return layers


def to_svg(g: FlowGraph, *, title: str = "业务流程总览",
           palette: Palette | None = None, show_codes: bool = True) -> str:
    """渲染成自包含 SVG。零依赖、离线可用。

    布局：一个阶段一条横向泳道（和客户那张图一致），泳道内按拓扑分层从左往右。
    跨泳道的边走贝塞尔曲线，避开节点。
    """
    p = palette or Palette()
    by_stage = g.by_stage()
    ordered = sorted(g.stages.values(), key=lambda x: x.order)
    # 泳道顺序：先按注册顺序排已注册的，再补上有节点却没注册的（那本身是个 bug，
    # 但**渲染不该因此崩**——一张少个标题的图，也远好过一个 AttributeError 把整条
    # 建图链路带走）。上一版这里是 `[type(...) and None]`，零泳道时产出 [None]，
    # 下一行取 .key 直接抛异常，而"材料里没有流程说明"恰恰会走到这条路。
    stage_keys = [st.key for st in ordered if by_stage.get(st.key)]
    stage_keys += [k for k in by_stage if k not in stage_keys]

    pos: dict[str, tuple[float, float]] = {}
    bands: list[tuple[str, float, float, float]] = []   # key, y, h, w
    y = MARGIN + 34
    max_w = 0.0

    for key in stage_keys:
        members = by_stage.get(key) or []
        layers = _layer(g, members)
        rows = max((len(c) for c in layers), default=1)
        band_h = BAND_HEAD + rows * NODE_H + (rows - 1) * GAP_Y + BAND_PAD * 2
        for li, col in enumerate(layers):
            for ri, n in enumerate(col):
                pos[n.rid] = (MARGIN + BAND_PAD + li * (NODE_W + GAP_X),
                              y + BAND_HEAD + BAND_PAD + ri * (NODE_H + GAP_Y))
        w = MARGIN + BAND_PAD * 2 + max(1, len(layers)) * (NODE_W + GAP_X)
        max_w = max(max_w, w)
        bands.append((key, y, band_h, w))
        y += band_h + 16

    W, H = max(max_w + MARGIN, 640), y + MARGIN
    out: list[str] = [
        (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" '
         f'width="{W:.0f}" height="{H:.0f}" font-family="-apple-system,PingFang SC,'
         f'Microsoft YaHei,sans-serif">'),
        f'<rect width="{W:.0f}" height="{H:.0f}" fill="#ffffff"/>',
        ('<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" '
         'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
         f'<path d="M0,0 L10,5 L0,10 z" fill="{p.edge}"/></marker></defs>'),
        (f'<text x="{MARGIN}" y="{MARGIN + 14}" font-size="17" font-weight="600" '
         f'fill="{p.ink}">{html.escape(title)}</text>'),
    ]
    st = g.stats()
    # 「多少个环节有接口撑着」是拿这张图开会时第一个被问到的数。没接上任何接口时
    # 不写这一句 —— 一句「0 个环节已对上接口」只会让人以为系统什么都没有。
    wired = sum(1 for n in g.nodes.values()
                if n.kind is NodeKind.ACTION and n.endpoint)
    acts = sum(1 for n in g.nodes.values() if n.kind is NodeKind.ACTION)
    out.append(
        f'<text x="{MARGIN}" y="{MARGIN + 32}" font-size="11" fill="{p.dim}">'
        f'{st["actions"]} 个 Action ｜ {st["events"]} 个 Event ｜ '
        f'{st["stages"]} 个阶段 ｜ {st["inferred_edges"]} 条边为系统推断，需人工确认'
        + (f' ｜ {wired}/{acts} 个环节已对上接口' if wired else "")
        + '</text>')

    # 泳道
    for key, by, bh, _w in bands:
        stage = g.stages.get(key)
        out.append(f'<rect x="{MARGIN}" y="{by:.0f}" width="{W - MARGIN * 2:.0f}" '
                   f'height="{bh:.0f}" rx="6" fill="{p.band}" stroke="{p.band_line}"/>')
        out.append(f'<rect x="{MARGIN}" y="{by:.0f}" width="4" height="{bh:.0f}" '
                   f'rx="2" fill="{p.action_line}"/>')
        out.append(f'<text x="{MARGIN + 16}" y="{by + 22:.0f}" font-size="12.5" '
                   f'font-weight="600" fill="{p.ink}">'
                   f'{html.escape(stage.title if stage else key)}</text>')
        if stage and stage.subtitle:
            out.append(f'<text x="{MARGIN + 16}" y="{by + 36:.0f}" font-size="10" '
                       f'fill="{p.dim}">{html.escape(stage.subtitle[:80])}</text>')

    # 边先画，压在节点下面
    for e in g.edges.values():
        if e.source not in pos or e.target not in pos:
            continue
        x1, y1 = pos[e.source]; x2, y2 = pos[e.target]
        sx, sy = x1 + NODE_W, y1 + NODE_H / 2
        tx, ty = x2, y2 + NODE_H / 2
        dash = ' stroke-dasharray="5 4"' if e.kind in (
            EdgeKind.INFERRED, EdgeKind.EXTERNAL, EdgeKind.COMPENSATE) else ""
        col = "#c4b5fd" if e.kind is EdgeKind.COMPENSATE else p.edge
        if tx < sx:                       # 回退边：从下方绕
            mid = max(sy, ty) + NODE_H * 0.7
            d = f"M{sx:.0f},{sy:.0f} C{sx + 40:.0f},{mid:.0f} {tx - 40:.0f},{mid:.0f} {tx:.0f},{ty:.0f}"
        else:
            d = f"M{sx:.0f},{sy:.0f} C{(sx + tx) / 2:.0f},{sy:.0f} {(sx + tx) / 2:.0f},{ty:.0f} {tx:.0f},{ty:.0f}"
        out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="1.3"'
                   f'{dash} marker-end="url(#a)"/>')
        if e.label:
            out.append(f'<text x="{(sx + tx) / 2:.0f}" y="{(sy + ty) / 2 - 5:.0f}" '
                       f'font-size="9.5" fill="{p.dim}" text-anchor="middle">'
                       f'{html.escape(e.label[:8])}</text>')

    # 节点
    fills = {NodeKind.ACTION: (p.action_fill, p.action_line),
             NodeKind.EVENT: (p.event_fill, p.event_line),
             NodeKind.GATEWAY: (p.gateway_fill, p.gateway_line),
             NodeKind.TERMINAL: (p.terminal_fill, p.terminal_line),
             NodeKind.EXTERNAL: (p.external_fill, p.external_line)}
    for rid, n in g.nodes.items():
        if rid not in pos:
            continue
        x, ny = pos[rid]
        fill, line = fills[n.kind]
        dash = ' stroke-dasharray="4 3"' if not n.grounded else ""
        if n.kind is NodeKind.GATEWAY:
            cx, cy = x + NODE_W / 2, ny + NODE_H / 2
            out.append(f'<polygon points="{cx:.0f},{ny:.0f} {x + NODE_W:.0f},{cy:.0f} '
                       f'{cx:.0f},{ny + NODE_H:.0f} {x:.0f},{cy:.0f}" fill="{fill}" '
                       f'stroke="{line}"{dash}/>')
        else:
            r = 14 if n.kind is NodeKind.ACTION else 4
            out.append(f'<rect x="{x:.0f}" y="{ny:.0f}" width="{NODE_W}" '
                       f'height="{NODE_H}" rx="{r}" fill="{fill}" stroke="{line}"{dash}/>')
        tag = {NodeKind.ACTION: "ACTION", NodeKind.EVENT: "EVENT",
               NodeKind.GATEWAY: "", NodeKind.TERMINAL: "", NodeKind.EXTERNAL: "外部"}[n.kind]
        ty0 = ny + 15
        if tag:
            out.append(f'<text x="{x + NODE_W / 2:.0f}" y="{ty0:.0f}" font-size="7.5" '
                       f'fill="{p.dim}" text-anchor="middle" letter-spacing="0.5">{tag}</text>')
            ty0 += 12
        for i, ln in enumerate(_wrap(n.label.value, per_line=12, max_lines=2)):
            out.append(f'<text x="{x + NODE_W / 2:.0f}" y="{ty0 + i * 12:.0f}" '
                       f'font-size="10.5" fill="{p.ink}" text-anchor="middle">'
                       f'{html.escape(ln)}</text>')
        if show_codes and n.code:
            out.append(f'<text x="{x + NODE_W / 2:.0f}" y="{ny + NODE_H - 6:.0f}" '
                       f'font-size="7" fill="{p.dim}" text-anchor="middle" '
                       f'font-family="ui-monospace,monospace">{html.escape(n.code)}</text>')
        if n.endpoint:
            # 接口路径在 168px 宽的框里放不下，硬塞会把标签挤掉。用一个角标表示
            # "这一步有系统支撑"，完整路径进 <title> —— 鼠标停上去就能看全。
            out.append(f'<circle cx="{x + NODE_W - 9:.0f}" cy="{ny + 9:.0f}" r="3.5" '
                       f'fill="{p.action_line}"><title>{html.escape(n.endpoint)}'
                       f'</title></circle>')

    out.append(
        f'<text x="{MARGIN}" y="{H - 8:.0f}" font-size="9" fill="{p.dim}">'
        '虚线 = 系统推断的顺序，材料里没有明写　·　右上角圆点 = 这一步有接口实现，'
        '悬停看路径</text>')
    out.append("</svg>")
    return "\n".join(out)
