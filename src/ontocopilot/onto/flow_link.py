"""把流程图和接口清单接起来。

这两样东西以前是**两份互不相干的产物**：

    流程图     17 个节点，「创建采购需求计划」「审批采购执行计划」…… 全是中文动作名
    动作清单   112 行接口，createPbp / cancelOpenPbp / queryPoHeader …… 全是接口码

于是图上看不出哪一步真的有系统支撑，接口清单里也看不出这个接口落在流程的哪一环。
而这正是 ERP 顾问拿到材料后第一件要做的事：把流程和系统能力对上，找出**流程里有
但系统里没有**的环节。

接法是两级都靠证据，不靠名字相似：

    宿主对象   步骤名去掉动词前缀 → 匹配对象的中文名或别名 → 对象 rid
    动词       步骤名的动词前缀、接口码里的动词段 → 归一到同一套动词码

两级都命中才算数。只对上宿主不看动词的话，「取消采购需求计划」会挂到 createPbp
上 —— 同一个单据上动词不同就是两回事，挂错比不挂糟得多。

接完之后剩下的两类缺口才是真正值钱的：

  · 流程里有、接口清单里没有 → 「这一步在系统里由谁来做？」
  · 接口是写操作、却不在流程的任何一步里 → 「这个接口属于流程的哪一环？」

最后是 :func:`flow_from_actions`：材料里**只有接口清单、没有一段流程说明**时，
按"同一个单据上 create → submit → approve → cancel"的生命周期出一张接口视角的
草图。顺序是推的，所以边一律画虚线 —— 分不清哪里是猜的流程图比没有图更危险。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .flow import EdgeKind, FlowGraph, FlowNode, NodeKind, Stage
from .oir import OIR, Provenance, extracted, inferred, make_rid

__all__ = ["LinkReport", "attach_endpoints", "canonical_verb", "coverage_gaps",
           "flow_from_actions"]


# ══════════════════════════════════════════════════════════════════
#  动词归一
# ══════════════════════════════════════════════════════════════════
#: 中英文动词 → 同一套动词码。两边都要归一，否则「创建」和 ``create`` 对不上。
#:
#: 顺序即优先级，**长的写在前面**：``cancelOpenPbp`` 里既有 ``cancel`` 也有
#: ``open``，先匹配到 cancel 才是对的。
_VERBS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("APPROVE", ("审批", "审核", "批准", "核准", "approve", "audit", "verify")),
    ("SUBMIT", ("提交", "上报", "报送", "submit", "commit")),
    ("CREATE", ("创建", "新建", "编制", "新增", "录入", "登记", "create", "add",
                "insert", "new", "save", "register")),
    ("UPDATE", ("修改", "变更", "调整", "更新", "维护", "update", "edit", "modify",
                "change", "amend")),
    ("CANCEL", ("取消", "作废", "撤销", "终止", "cancel", "void", "abort",
                "revoke", "subtract")),
    ("DELETE", ("删除", "移除", "delete", "remove", "drop")),
    ("CLOSE", ("关闭", "结束", "完结", "close", "finish", "complete")),
    ("ALLOCATE", ("分配", "下达", "派发", "指派", "allocate", "assign", "dispatch",
                  "distribute")),
    ("SPLIT", ("拆分", "拆包", "split")),
    ("MERGE", ("合并", "汇总", "merge", "combine")),
    ("PUBLISH", ("发布", "下发", "publish", "release")),
    ("IMPORT", ("导入", "import", "upload")),
    ("EXPORT", ("导出", "下载", "export", "download")),
    ("SYNC", ("同步", "推送", "sync", "push")),
    ("RESERVE", ("预留", "占用", "锁定", "reserve", "lock", "hold")),
    ("QUERY", ("查询", "查看", "检索", "获取", "query", "get", "list", "search",
               "find", "fetch", "detail", "page", "view", "read", "open")),
)

#: 只读动词。它们不改数据，**不属于流程的任何一步** —— 把 60 个查询接口画进
#: 流程图只会把真正的环节淹掉，为它们逐个造"这一步在哪"的问题更是纯噪声。
READ_ONLY_VERBS = frozenset({"QUERY", "EXPORT"})

#: 动词码 → 给业务方看的中文。动词码是内部对齐用的，出现在问卷上就等于要求
#: 对方先学一遍我们的词表。
_VERB_CN: dict[str, str] = {
    "APPROVE": "审批", "SUBMIT": "提交", "CREATE": "创建", "UPDATE": "修改",
    "CANCEL": "取消", "DELETE": "删除", "CLOSE": "关闭", "ALLOCATE": "分配",
    "SPLIT": "拆分", "MERGE": "合并", "PUBLISH": "发布", "IMPORT": "导入",
    "EXPORT": "导出", "SYNC": "同步", "RESERVE": "预留", "QUERY": "查询",
}

#: 一个单据的生命周期顺序。接口视角建图时按它排先后 —— 这不是业务规则，
#: 是"先有单据才谈得上审批、审批完才谈得上取消"这种时序常识，所以边标成推断。
LIFECYCLE: tuple[str, ...] = (
    "CREATE", "IMPORT", "UPDATE", "SUBMIT", "APPROVE", "PUBLISH", "ALLOCATE",
    "SPLIT", "MERGE", "RESERVE", "SYNC", "CANCEL", "DELETE", "CLOSE",
)

#: 中文动词，按**长的优先**排。正则的分支是最左匹配，短的排前面会先咬住。
_CN_VERBS = sorted((w for _, ws in _VERBS for w in ws if not w.isascii()),
                   key=len, reverse=True)

#: 动作词在名字**两端**都可能出现：材料里既写「创建采购包」也写「采购包分配」。
#: 只认前缀的话，后一种全部认不出动词，于是整个环节被判成"缺接口"。
_ACTION_PREFIX = re.compile("^(?:" + "|".join(_CN_VERBS) + ")")
_ACTION_SUFFIX = re.compile("(?:" + "|".join(_CN_VERBS) + ")$")

#: 名字尾巴上的补充说明：「创建采购申请单（立项）」处理的单据是采购申请单。
#: 不剥掉它，宿主对象就永远匹配不上。
_ASIDE = re.compile(r"[（(][^（()）]*[）)]\s*$")

_CAMEL = re.compile(r"[A-Z][a-z]*|[a-z]+")


def canonical_verb(text: str) -> str:
    """从中文动作名或英文接口码里认出动词。认不出返回空串 —— 不瞎猜。

    英文按驼峰切段，**只看第一段**：``createPbp`` 的动词是 create，而
    ``queryPoApproveHistory`` 的动词是 query 不是 approve —— 它查的是审批历史，
    不是执行审批。只扫关键词而不看位置，这条会挂错。
    """
    t = str(text or "").strip()
    if not t:
        return ""
    if t.isascii():
        parts = _CAMEL.findall(t)
        head = (parts[0] if parts else t).lower()
        for code, words in _VERBS:
            if any(w.isascii() and (head == w or head.startswith(w)) for w in words):
                return code
        return ""
    head = _ASIDE.sub("", t)
    for code, words in _VERBS:
        if any(not w.isascii() and head.startswith(w) for w in words):
            return code
    # 动词在后面：「采购包分配」「采购需求计划审批」。前缀没命中才看后缀 ——
    # 反过来会让「审批采购需求计划」被结尾的「计划」之类误伤。
    for code, words in _VERBS:
        if any(not w.isascii() and head.endswith(w) for w in words):
            return code
    return ""


def _subject(label: str) -> str:
    """步骤名去掉动词和括号补充，剩下的就是它处理的单据。"""
    t = _ASIDE.sub("", str(label or "")).strip()
    t = _ACTION_PREFIX.sub("", t)
    t = _ACTION_SUFFIX.sub("", t)
    return t.strip("（）() 　")


# ══════════════════════════════════════════════════════════════════
#  接上去
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class LinkReport:
    """接的结果。缺口分析全部从这里读，不再第二次遍历图。"""

    #: 节点 rid → 挂上的行动 rid 列表
    matched: dict[str, list[str]] = field(default_factory=dict)
    #: 找到了宿主对象、但那个对象上没有对应动词的接口
    unmatched_nodes: list[tuple[str, str, str]] = field(default_factory=list)
    #: 连宿主对象都没对上的节点（rid, 步骤名）
    unresolved_nodes: list[tuple[str, str]] = field(default_factory=list)
    #: 已经被某个节点用掉的行动 rid
    used_actions: set[str] = field(default_factory=set)

    def summary(self) -> dict[str, Any]:
        return {"接上接口的环节": len(self.matched),
                "有单据但缺接口的环节": len(self.unmatched_nodes),
                "认不出单据的环节": len(self.unresolved_nodes),
                "用到的接口": len(self.used_actions)}


def _host_index(oir: OIR) -> dict[str, str]:
    """中文名 / 别名 → 对象 rid。行动表和流程说明之间只有中文名对得上。"""
    out: dict[str, str] = {}
    for rid, o in oir.objects.items():
        for name in (o.display_name.value, *o.aliases):
            if (n := str(name or "").strip()):
                out.setdefault(n, rid)
    return out


def _resolve_host(subject: str, hosts: dict[str, str]) -> str | None:
    """步骤处理的单据 → 对象 rid。

    先精确，再**唯一**的包含匹配。命中多个说明这个名字有歧义，宁可挂空 ——
    挂空会变成一个反问，挂错会把接口标在错误的环节上。
    """
    if not subject:
        return None
    if hit := hosts.get(subject):
        return hit
    near = {rid for name, rid in hosts.items()
            if subject in name or name in subject}
    return next(iter(near)) if len(near) == 1 else None


def attach_endpoints(g: FlowGraph, oir: OIR, *, max_per_node: int = 3) -> LinkReport:
    """给流程图上的每个 ACTION 节点挂上实现它的接口。就地改图，返回接的结果。

    Args:
        max_per_node: 一个环节最多标几个接口。标满一屏没人看得完，
            而"有没有系统支撑"这个问题第一个接口就回答了。
    """
    report = LinkReport()
    hosts = _host_index(oir)
    # 行动按 (宿主, 动词) 建索引。112 个行动 × 17 个节点全表扫是浪费，
    # 更重要的是索引让"同一个宿主上有哪些动词"这个问题一次就能答。
    by_host_verb: dict[tuple[str, str], list[Any]] = {}
    by_host: dict[str, list[Any]] = {}
    for a in oir.actions.values():
        verb = canonical_verb(a.api_name.value) or canonical_verb(
            (a.source_endpoint.value or {}).get("display", ""))
        for host in a.applies_to or ():
            by_host_verb.setdefault((host, verb), []).append(a)
            by_host.setdefault(host, []).append(a)

    for rid, n in g.nodes.items():
        if n.kind is not NodeKind.ACTION:
            continue
        label = n.label.value
        host = _resolve_host(_subject(label), hosts)
        if host is None:
            report.unresolved_nodes.append((rid, label))
            continue
        if host not in n.objects:
            n.objects.append(host)
        verb = canonical_verb(label)
        hits = by_host_verb.get((host, verb), []) if verb else []
        if not hits:
            report.unmatched_nodes.append((rid, label, host))
            continue
        picked = hits[:max_per_node]
        # 节点上写**路径**不写接口码：路径是实际调用的东西，接口码只是个名字。
        n.endpoint = "　".join(
            str((a.source_endpoint.value or {}).get("path") or a.api_name.value)
            for a in picked)
        report.matched[rid] = [a.rid for a in picked]
        report.used_actions.update(a.rid for a in picked)
    return report


# ══════════════════════════════════════════════════════════════════
#  缺口 → 问题
# ══════════════════════════════════════════════════════════════════
def coverage_gaps(report: LinkReport, oir: OIR, *, per_kind: int = 8) -> list[Any]:
    """接完之后剩下的两类缺口，转成能发给业务方的问题。

    这是接起来之后**真正值钱的部分**：一张标着接口的流程图是好看，一份
    "第 6 步没有任何系统支撑""这 4 个写接口不在流程里"的清单才是要拿去开会的。
    """
    from .gaps import Gap

    out: list[Gap] = []

    # 1. 流程里有、接口清单里没有
    for _rid, label, host in report.unmatched_nodes[:per_kind]:
        obj = oir.objects.get(host)
        # 报给业务方看的是**中文**。动词码是我们内部对齐用的，把 CANCEL/SPLIT
        # 直接摆到问卷上，等于让人先学一遍我们的词表再回答问题。
        siblings = sorted({
            _VERB_CN.get(v, v) for a in oir.actions.values()
            if host in (a.applies_to or ()) and (v := canonical_verb(a.api_name.value))})
        out.append(Gap(
            text=f"「{label}」这一步在系统里由哪个接口完成？"
                 + (f"材料里「{obj.display_name.value}」上只有"
                    f"{'、'.join(siblings[:6])}这几类接口，没有对应的。"
                    if obj is not None and siblings else
                    "材料的接口清单里找不到对应的接口。")
                 + "如果这一步是线下做的，请直接说明。",
            group="流程与系统", kind="step_without_api",
            prov=_prov_of(oir.objects.get(host)), weight=4.5))

    # 2. 写接口在流程里没有出现。**只算写接口** —— 查询接口不改数据，
    #    它本来就不属于流程的任何一步，为它造问题纯粹是噪声。
    orphan = [a for a in oir.actions.values()
              if a.rid not in report.used_actions
              and (v := canonical_verb(a.api_name.value))
              and v not in READ_ONLY_VERBS]
    for a in orphan[:per_kind]:
        ep = a.source_endpoint.value or {}
        host = next((oir.objects.get(h) for h in (a.applies_to or ())), None)
        out.append(Gap(
            text=f"接口「{a.api_name.value}」"
                 + (f"（{ep.get('display')}）" if ep.get("display") else "")
                 + "会改动数据，但它不在流程说明的任何一步里。"
                 + (f"它属于「{host.display_name.value}」的哪一环？"
                    if host is not None else "它属于流程的哪一环？"),
            group="流程与系统", kind="api_without_step",
            prov=_prov_of_assertion(a.api_name), weight=3.5))
    if len(orphan) > per_kind:
        out.append(Gap(
            text=f"另有 {len(orphan) - per_kind} 个写接口同样不在流程说明里，"
                 f"完整清单见「动作清单」表。是不是还有一段流程没有提供？",
            group="流程与系统", kind="api_without_step_more", weight=3.0))
    return out


def _prov_of(obj: Any) -> Provenance | None:
    return _prov_of_assertion(getattr(obj, "api_name", None)) if obj else None


def _prov_of_assertion(assertion: Any) -> Provenance | None:
    ev = getattr(assertion, "evidence", None) or ()
    return ev[0] if ev else None


# ══════════════════════════════════════════════════════════════════
#  接口视角建图
# ══════════════════════════════════════════════════════════════════
#: 建接口视角时，一个宿主对象至少要有几个写接口才值得单独画一条泳道。
#: 只有一个 create 的对象画出来是一个孤零零的框，占地方不给信息。
_MIN_ACTIONS_PER_LANE = 2


def flow_from_actions(oir: OIR, *, file_name: str = "",
                      max_lanes: int = 12) -> FlowGraph:
    """只有接口清单、没有流程说明时，出一张接口视角的流程草图。

    以前这种材料的结果是 ``flow.skipped``：一张图都没有。而 112 行接口里
    "同一个单据上先 create 再 approve 再 cancel"这层先后关系本身就是一份可以
    拿去和客户对的草稿 —— 对的过程中他会立刻指出哪里不对，那比一张白纸有用得多。

    三条纪律：

    * **节点有依据**：每个节点都来自接口清单里的一行，带原始出处；
    * **边是推的**：顺序来自 :data:`LIFECYCLE` 这层时序常识，不是材料写的，
      所以一律 ``EdgeKind.INFERRED``（图上是虚线）；
    * **只画写接口**：查询接口不改数据，画进去只会把真正的环节淹掉。

    Args:
        max_lanes: 最多画几条泳道。按接口数从多到少取 —— 接口最多的对象就是
            这份材料的主线。
    """
    g = FlowGraph()
    lanes: dict[str, list[tuple[str, Any]]] = {}
    for a in oir.actions.values():
        verb = canonical_verb(a.api_name.value) or canonical_verb(
            (a.source_endpoint.value or {}).get("display", ""))
        if not verb or verb in READ_ONLY_VERBS:
            continue
        host = next(iter(a.applies_to or ()), "")
        lanes.setdefault(host, []).append((verb, a))

    ranked = sorted(lanes.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    order = 0
    for host, items in ranked[:max_lanes]:
        if len(items) < _MIN_ACTIONS_PER_LANE:
            continue
        obj = oir.objects.get(host)
        order += 1
        key = f"api{order}"
        g.stages[key] = Stage(
            key=key, order=order,
            title=obj.display_name.value if obj is not None else "未归属接口",
            subtitle="按接口清单推出的顺序，材料里没有写明，待人工确认")
        items.sort(key=lambda p: (LIFECYCLE.index(p[0]) if p[0] in LIFECYCLE else 99,
                                  p[1].api_name.value))
        prev_evt: str | None = None
        for verb, a in items:
            ep = a.source_endpoint.value or {}
            prov = _prov_of_assertion(a.api_name) or Provenance(
                "f", file_name, {"kind": "raw", "ref": a.api_name.value},
                snippet=str(ep.get("path") or ""), extractor="rule", confidence=1.0)
            act = g.add_node(FlowNode(
                rid=make_rid("fn", f"api_{a.api_name.value}"), kind=NodeKind.ACTION,
                stage=key, label=extracted(str(ep.get("display") or a.api_name.value), prov),
                actor=inferred(""), objects=[host] if host else [],
                endpoint=str(ep.get("path") or "")))
            evt = g.add_node(FlowNode(
                rid=make_rid("fn", f"apievt_{a.api_name.value}"), kind=NodeKind.EVENT,
                stage=key,
                label=extracted(_event_name(verb, obj), prov)))
            g.connect(act.rid, evt.rid, evidence=[prov])
            if prev_evt:
                g.connect(prev_evt, act.rid, kind=EdgeKind.INFERRED, label="推断顺序")
            prev_evt = evt.rid
    return g


#: 动词 → 事件名。事件是**已经发生的事**，名字要读起来像一个事实。
_EVENT_NAME: dict[str, str] = {
    "CREATE": "已创建", "IMPORT": "已导入", "UPDATE": "已修改", "SUBMIT": "已提交",
    "APPROVE": "已审批", "PUBLISH": "已发布", "ALLOCATE": "已分配", "SPLIT": "已拆分",
    "MERGE": "已合并", "RESERVE": "已占用", "SYNC": "已同步", "CANCEL": "已取消",
    "DELETE": "已删除", "CLOSE": "已关闭",
}


def _event_name(verb: str, obj: Any) -> str:
    name = obj.display_name.value if obj is not None else "单据"
    return f"{name}{_EVENT_NAME.get(verb, '已处理')}"
