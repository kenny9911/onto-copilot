"""导出 onto/flow.py + onto/flow_link.py + onto/flow_bpmn.py 的 golden。

这三个模块合起来是「流程图可视化」那份交付物的产生逻辑：flow 是图本身
（节点/边/泳道/编号），flow_link 从 **行动清单反推流程连边**，flow_bpmn 把已经
是图的 BPMN 无损搬进来。边的方向、网关类型、端点绑定错一个，画出来的流程就是错的
—— 所以 TS 侧的期望值一个都不许手写，全部从这里导。

已有的 ``golden/pipeline.flow.json`` / ``golden/pipeline.oir.json`` 是真材料
（材料.xlsx）跑出来的，本脚本**直接读它们**当输入，不重跑流水线：

  · 输入两边完全同源（TS 读同样两个文件），不存在"抄错输入"这条失败模式；
  · 字节确定 —— 全部输入要么来自那两份 JSON，要么是本文件里的字面量。

补的部分是真材料没覆盖到的形态：网关/终态/外部节点、编号撞号、BPMN 泳道与
悬空引用、只有接口清单时的接口视角建图。

跑法::

    .venv/bin/python tools/golden/flow.py

产物 ``golden/flow.json``（新文件，不碰任何已有 golden）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.flow import (  # noqa: E402
    EdgeKind,
    FlowGraph,
    FlowNode,
    NodeKind,
    code_for,
    domain_code,
    flow_from_dict,
)
from ontocopilot.onto.flow_bpmn import flow_from_bpmn_docs  # noqa: E402
from ontocopilot.onto.flow_link import (  # noqa: E402
    _subject,
    attach_endpoints,
    canonical_verb,
    coverage_gaps,
    flow_from_actions,
)
from ontocopilot.onto.oir import Provenance, extracted, inferred, oir_from_dict  # noqa: E402

GOLDEN = ROOT / "golden"


# ══════════════════════════════════════════════════════════════════
#  1. 编号：domain_code / code_for
# ══════════════════════════════════════════════════════════════════
_DOMAIN_TEXTS = [
    "集采计划编制与审批",          # 命中 _DOMAIN_CODES 里的第一条
    "采购需求计划审批",            # "集采计划" 不在里面，才轮到 PBP
    "采购执行计划下达",
    "创建采购申请单（立项）",
    "采购包拆分",
    "合同签订",                    # "采购合同" 整词不在 → 认不出
    "库存占用",
    "预算校验",
    "寻源方式选择",
    "供应商准入",
    "跟踪与预警",
    "生成报告",
    "审批",
    "",                            # 空串谁都不命中
    "完全无关的一句话",
]

_CODE_CASES: list[dict[str, Any]] = [
    # ── ACTION：动词前缀直接命中 ──────────────────────────────
    {"kind": "action", "label": "编制集采计划", "stage_hint": "", "taken": []},
    {"kind": "action", "label": "审批采购需求计划", "stage_hint": "", "taken": []},
    # 动词不在开头但落在前 4 个字里（`verb in text[:4]` 那条分支）
    {"kind": "action", "label": "由计划员编制方案", "stage_hint": "集采计划", "taken": []},
    # 动词在第 5 个字之后 → 认不出 → 走内容哈希兜底
    {"kind": "action", "label": "采购需求计划的负责人提交", "stage_hint": "", "taken": []},
    # 域认不出 → GEN；标签里没有 CJK → 哈希算的是整个 label
    {"kind": "action", "label": "createPbp", "stage_hint": "", "taken": []},
    # 域从 stage_hint 兜
    {"kind": "action", "label": "填写表单", "stage_hint": "寻源方式选择", "taken": []},
    # ── EVENT：状态词表，顺序即优先级 ─────────────────────────
    {"kind": "event", "label": "集采计划编制已发起", "stage_hint": "", "taken": []},
    {"kind": "event", "label": "集采计划已生成", "stage_hint": "", "taken": []},
    {"kind": "event", "label": "采购申请已通过", "stage_hint": "", "taken": []},
    {"kind": "event", "label": "采购申请已批准", "stage_hint": "", "taken": []},
    {"kind": "event", "label": "库存已释放", "stage_hint": "", "taken": []},
    {"kind": "event", "label": "某件事情发生了", "stage_hint": "预算", "taken": []},
    # ── 其余三种前缀 ──────────────────────────────────────────
    {"kind": "gateway", "label": "集采计划审批结果", "stage_hint": "", "taken": []},
    {"kind": "terminal", "label": "流程结束", "stage_hint": "采购合同", "taken": []},
    {"kind": "external", "label": "调用供应商门户", "stage_hint": "", "taken": []},
    # ── 撞号：第一次 -2，再撞 -3 ─────────────────────────────
    {"kind": "action", "label": "编制集采计划", "stage_hint": "",
     "taken": ["ACT-CP-DRAFT"]},
    {"kind": "action", "label": "编制集采计划", "stage_hint": "",
     "taken": ["ACT-CP-DRAFT", "ACT-CP-DRAFT-2"]},
    # taken 里有 -3 但没有 -2：补的是最小可用后缀
    {"kind": "action", "label": "编制集采计划", "stage_hint": "",
     "taken": ["ACT-CP-DRAFT", "ACT-CP-DRAFT-3"]},
    # ── 哈希兜底必须是**内容哈希**，不是 hash()：同一个标签两次必须同号 ──
    {"kind": "event", "label": "一段没有状态词的说明", "stage_hint": "", "taken": []},
    {"kind": "action", "label": "🚀 emoji 与 ascii 混排 abc", "stage_hint": "", "taken": []},
]

_KINDS = {"action": NodeKind.ACTION, "event": NodeKind.EVENT,
          "gateway": NodeKind.GATEWAY, "terminal": NodeKind.TERMINAL,
          "external": NodeKind.EXTERNAL}


# ══════════════════════════════════════════════════════════════════
#  2. 动词归一 / 宿主提取
# ══════════════════════════════════════════════════════════════════
_VERB_TEXTS = [
    # 英文接口码：只看驼峰第一段
    "createPbp", "cancelOpenPbp", "queryPoApproveHistory", "approvePbp",
    "submitEp", "listPbpPage", "getPbpDetail", "savePbpHeader", "openPbp",
    "subtractInventory", "syncSupplier", "downloadTemplate", "removeItem",
    "PbpCreate",          # 首段是 Pbp，认不出动词
    "pbp_create",         # 驼峰切不出 create 在首段
    "UPPERCASE",          # findall 拿到 "U"+"PPERCASE"？—— 钉住实际行为
    "add", "new", "read",
    # 中文：前缀
    "创建采购需求计划", "审批采购执行计划", "取消采购包", "编制集采计划",
    "作废采购申请", "上报月度计划", "维护供应商档案",
    # 中文：动词在尾巴上
    "采购包分配", "采购需求计划审批", "集采计划编制", "库存占用",
    # 括号补充要先剥掉，否则尾缀认不出
    "采购申请单审批（一级）", "创建采购申请单（立项）",
    # 前缀优先于后缀：开头是"审批"，结尾是"计划"
    "审批采购需求计划",
    # 认不出
    "", "   ", "一段与动词无关的话", "供应商", "12345",
]

_SUBJECT_TEXTS = [
    "创建采购需求计划", "采购包分配", "创建采购申请单（立项）",
    "审批采购执行计划（二级）", "编制", "（采购包）", "采购需求计划",
    "取消采购包 ", "　采购计划　", "提交",
]


# ══════════════════════════════════════════════════════════════════
#  3. 合成图：编号撞号 / 体检 / 主干
# ══════════════════════════════════════════════════════════════════
#: 合成图与合成 BPMN 共用的一条证据。写进 golden，两侧读同一份。
_PROV: dict[str, Any] = {
    "file_id": "f_gold", "file_name": "流程说明.docx",
    "locator": {"kind": "raw", "ref": "第三章"},
    "snippet": "（1）编制集采计划：由计划员发起；", "extractor": "rule",
    "confidence": 1.0,
}

#: 一张手搓的图，专门覆盖真材料里没有的形态：
#: 网关 + 有标签/无标签出边、终态、外部节点、孤立节点、死胡同、
#: 两个同名 ACTION（撞号 → -2）、推断边（主干视图要砍掉）。
_BUILD_SPEC: dict[str, Any] = {
    "nodes": [
        {"rid": "n1", "kind": "event", "label": "集采计划编制已发起",
         "stage": "s1", "grounded": True},
        {"rid": "n2", "kind": "action", "label": "编制集采计划",
         "stage": "s1", "grounded": True},
        {"rid": "n3", "kind": "event", "label": "集采计划已生成",
         "stage": "s1", "grounded": True},
        {"rid": "n4", "kind": "action", "label": "审批集采计划",
         "stage": "s1", "grounded": True},
        {"rid": "n5", "kind": "gateway", "label": "集采计划审批结果",
         "stage": "s1", "grounded": True},
        {"rid": "n6", "kind": "event", "label": "集采计划已通过",
         "stage": "s2", "grounded": True},
        {"rid": "n7", "kind": "event", "label": "集采计划已驳回",
         "stage": "s2", "grounded": False},
        {"rid": "n8", "kind": "terminal", "label": "流程结束",
         "stage": "s2", "grounded": True},
        # 与 n2 同名 → code_for 撞号加后缀
        {"rid": "n9", "kind": "action", "label": "编制集采计划",
         "stage": "s3", "grounded": False},
        # 谁都不连 → dangling
        {"rid": "n10", "kind": "external", "label": "调用供应商门户",
         "stage": "", "grounded": False},
        # 有入边没出边且不是终态 → dead end
        {"rid": "n11", "kind": "action", "label": "归档集采计划",
         "stage": "s2", "grounded": True},
    ],
    "edges": [
        ["n1", "n2", "flow", "", True],
        ["n2", "n3", "flow", "", True],
        ["n3", "n4", "flow", "", True],
        ["n4", "n5", "flow", "", True],
        ["n5", "n6", "cond", "通过", True],
        ["n5", "n7", "cond", "", False],        # 网关出边没标签 → unlabeled
        ["n6", "n8", "flow", "", True],
        ["n7", "n2", "comp", "驳回后重编", False],
        ["n9", "n11", "inferred", "推断顺序", False],
        ["n6", "n11", "external", "", True],
    ],
}


def _prov_obj() -> Provenance:
    d = _PROV
    return Provenance(
        file_id=d["file_id"], file_name=d["file_name"], locator=dict(d["locator"]),
        snippet=d["snippet"], extractor=d["extractor"], confidence=d["confidence"])


def _build(spec: dict[str, Any]) -> FlowGraph:
    """按 spec 走一遍 add_node / connect —— TS 侧写同样的驱动。"""
    g = FlowGraph()
    for n in spec["nodes"]:
        label = (extracted(n["label"], _prov_obj()) if n["grounded"]
                 else inferred(n["label"]))
        g.add_node(FlowNode(rid=n["rid"], kind=_KINDS[n["kind"]], label=label,
                            stage=n["stage"], objects=list(n.get("objects") or [])))
    for src, dst, kind, label, grounded in spec["edges"]:
        g.connect(src, dst, kind=EdgeKind(kind), label=label,
                  evidence=[_prov_obj()] if grounded else [])
    return g


def _health(g: FlowGraph) -> dict[str, Any]:
    return {
        "dangling": [n.rid for n in g.dangling()],
        "dead_ends": [n.rid for n in g.dead_ends()],
        "unlabeled_branches": [n.rid for n in g.unlabeled_branches()],
        "actions_without_events": [n.rid for n in g.actions_without_events()],
        "by_stage": {k: [n.rid for n in v] for k, v in g.by_stage().items()},
        "out_edges": {rid: [e.rid for e in g.out_edges(rid)] for rid in g.nodes},
        "in_edges": {rid: [e.rid for e in g.in_edges(rid)] for rid in g.nodes},
        "codes": {rid: n.code for rid, n in g.nodes.items()},
    }


# ══════════════════════════════════════════════════════════════════
#  4. flow_from_dict 的脏输入
# ══════════════════════════════════════════════════════════════════
_FROM_DICT_CASES: list[dict[str, Any]] = [
    {"name": "empty", "data": {}},
    {"name": "unknown_kinds", "data": {
        "nodes": [{"rid": "a", "kind": "no-such-kind", "label": {"value": "x"}}],
        "edges": [{"rid": "e", "from": "a", "to": "a", "kind": "no-such-kind"}],
    }},
    {"name": "label_not_dict", "data": {
        "nodes": [{"rid": "a", "kind": "action", "label": "直接是字符串"},
                  {"rid": "b", "kind": "action"}],
    }},
    {"name": "origin_and_confidence", "data": {
        "nodes": [{"rid": "a", "kind": "action", "code": "KEEP-ME",
                   "label": {"value": "人工加的", "origin": "user", "confidence": 0.98},
                   "actor": {"value": "计划员", "origin": "bogus-origin"},
                   "objects": ["ot_x"], "endpoint": "/v1/x", "stage": "s"},
                  {"rid": "b", "kind": "event",
                   "label": {"value": "已生成", "origin": "extracted",
                             "confidence": 0,
                             "evidence": [{"file_id": "f", "file_name": "材料.xlsx",
                                           "locator": {"kind": "cell", "sheet": "S",
                                                       "row": 2, "col": 3},
                                           "snippet": "原文", "extractor": "rule",
                                           "confidence": 0}]}}],
        "edges": [{"rid": "e1", "from": "a", "to": "b", "kind": "cond", "label": "通过",
                   "evidence": [{"file_name": "材料.xlsx",
                                 "locator": {"kind": "raw", "ref": "R1"}}]}],
        "stages": [{"key": "s", "title": "阶段一", "order": "3"}],
        "workflows": [{"key": "w", "title": "主流程", "entry": "a", "exits": ["b"]}],
    }},
    # 状态**存不住**：to_dict 印了 status，from_dict 不读 —— 照实钉住
    {"name": "status_is_dropped", "data": {
        "nodes": [{"rid": "a", "kind": "action", "label": {"value": "x"},
                   "status": "confirmed"}],
    }},
]


# ══════════════════════════════════════════════════════════════════
#  5. flow_from_actions 的合成 OIR
# ══════════════════════════════════════════════════════════════════
def _act(rid: str, api: str, host: str, path: str, display: str,
         with_ev: bool = True) -> dict[str, Any]:
    ev = [{"file_id": "f_api", "file_name": "接口清单.xlsx",
           "locator": {"kind": "range", "sheet": "行动", "rows": [3, 3]},
           "snippet": f"实体编码={api}", "extractor": "rule", "confidence": 1.0}]
    return {
        "rid": rid, "kind": "ActionType",
        "apiName": {"value": api, "origin": "extracted", "confidence": 0.8,
                    "evidence": ev if with_ev else []},
        "appliesTo": [host] if host else [],
        "parameters": {"value": [], "origin": "inferred", "confidence": 0.4,
                       "evidence": []},
        "effects": {"value": [], "origin": "inferred", "confidence": 0.4,
                    "evidence": []},
        "sourceEndpoint": {"value": {"path": path, "display": display},
                           "origin": "extracted", "confidence": 0.8, "evidence": []},
        "status": "candidate",
    }


def _obj(rid: str, api: str, display: str, aliases: list[str]) -> dict[str, Any]:
    return {
        "rid": rid, "kind": "ObjectType",
        "apiName": {"value": api, "origin": "extracted", "confidence": 0.8,
                    "evidence": [{"file_id": "f_api", "file_name": "接口清单.xlsx",
                                  "locator": {"kind": "range", "sheet": "对象",
                                              "rows": [1, 1]},
                                  "snippet": f"对象={display}", "extractor": "rule",
                                  "confidence": 1.0}]},
        "displayName": {"value": display, "origin": "extracted", "confidence": 0.8,
                        "evidence": []},
        "description": {"value": "", "origin": "inferred", "confidence": 0.4,
                        "evidence": []},
        "primaryKey": {"value": [], "origin": "inferred", "confidence": 0.4,
                       "evidence": []},
        "properties": [], "aliases": aliases, "owner": None,
        "status": "candidate", "conflicts": [],
    }


#: 只有接口清单、没有流程说明时的那份材料。刻意造出：
#:   · pbp 上 6 个写接口（生命周期全序都用上）；
#:   · ep 上 2 个（刚好够一条泳道）；
#:   · pkg 上 1 个（不够 _MIN_ACTIONS_PER_LANE，整条泳道被丢掉）；
#:   · 一个查询接口（READ_ONLY_VERBS，不进图也不算孤儿）；
#:   · 一个 apiName 认不出动词、只有 display 能认出来的（两级兜底那条）；
#:   · 一个挂空宿主的（host="" → objects 为空）；
#:   · 一个没有 evidence 的（走 Provenance("f", file_name, …) 那条兜底）。
_SYNTH_OIR: dict[str, Any] = {
    "objects": [
        _obj("ot_pbp", "pbpHeader", "采购需求计划", ["需求计划", "PBP"]),
        _obj("ot_ep", "epHeader", "采购执行计划", []),
        _obj("ot_pkg", "pkgHeader", "采购包", []),
    ],
    "properties": [], "links": [], "rules": [], "questions": [],
    "actions": [
        _act("at_cancel_pbp", "cancelOpenPbp", "ot_pbp", "/v1/cancelOpenPbp", "取消PBP"),
        _act("at_create_pbp", "createPbp", "ot_pbp", "/v1/createPbp", "创建PBP"),
        _act("at_approve_pbp", "approvePbp", "ot_pbp", "/v1/approvePbp", "审批PBP"),
        _act("at_submit_pbp", "submitPbp", "ot_pbp", "/v1/submitPbp", "提交PBP"),
        # apiName 认不出动词，靠 sourceEndpoint.display 的"分配"兜底
        _act("at_alloc_pbp", "pbpXfer", "ot_pbp", "/v1/pbpXfer", "分配采购需求计划"),
        # 没有 evidence → prov 走 Provenance("f", file_name, {kind:raw,…}) 兜底
        _act("at_close_pbp", "closePbp", "ot_pbp", "/v1/closePbp", "关闭PBP",
             with_ev=False),
        _act("at_create_ep", "createEp", "ot_ep", "/v1/createEp", "创建EP"),
        _act("at_update_ep", "updateEp", "ot_ep", "/v1/updateEp", "修改EP"),
        # 只有一个 → 泳道被丢
        _act("at_split_pkg", "splitPkg", "ot_pkg", "/v1/splitPkg", "拆分采购包"),
        # 查询接口：不进图
        _act("at_query_pbp", "queryPbpPage", "ot_pbp", "/v1/queryPbpPage", "查询PBP"),
        # 宿主为空
        _act("at_sync_x", "syncAll", "", "/v1/syncAll", "同步全部"),
        _act("at_import_x", "importAll", "", "/v1/importAll", "导入全部"),
    ],
    "stats": {},
}


#: 专给 attach_endpoints 的分支覆盖用：真材料那张图只走到了"精确命中"一条路。
#: 这里凑齐 —— 别名命中、唯一包含匹配、歧义（宁可挂空）、有宿主没动词、
#: 同一个 (宿主, 动词) 上超过 max_per_node 个接口（U+3000 连接 + 截断）、
#: 以及接口没有 path 时回落到 apiName。
_LINK_OIR: dict[str, Any] = {
    "objects": [
        _obj("ot_pbp", "pbpHeader", "采购需求计划", ["需求计划", "PBP"]),
        _obj("ot_pbpline", "pbpLine", "采购需求计划行", []),
        _obj("ot_ep", "epHeader", "采购执行计划", []),
    ],
    "properties": [], "links": [], "rules": [], "questions": [],
    "actions": [
        _act("at_c1", "createPbp", "ot_pbp", "/v1/createPbp", "创建PBP"),
        _act("at_c2", "addPbp", "ot_pbp", "/v1/addPbp", "新增PBP"),
        _act("at_c3", "savePbp", "ot_pbp", "/v1/savePbp", "保存PBP"),
        # 没有 path → 节点上写 apiName
        _act("at_c4", "registerPbp", "ot_pbp", "", "登记PBP"),
        _act("at_cancel", "cancelPbp", "ot_pbp", "/v1/cancelPbp", "取消PBP"),
        _act("at_query", "queryPbp", "ot_pbp", "/v1/queryPbp", "查询PBP"),
        _act("at_ep_c", "createEp", "ot_ep", "/v1/createEp", "创建EP"),
    ],
    "stats": {},
}

_LINK_SPEC: dict[str, Any] = {
    "nodes": [
        # 精确命中 + 4 个 CREATE 接口 → 取前 3 个，U+3000 连接
        {"rid": "L1", "kind": "action", "label": "创建采购需求计划",
         "stage": "s", "grounded": True},
        # 宿主命中但这个宿主上没有 APPROVE → step_without_api（siblings 非空）
        {"rid": "L2", "kind": "action", "label": "审批采购需求计划",
         "stage": "s", "grounded": True},
        # 别名命中（"PBP" 是 ot_pbp 的别名），且节点上已经挂着这个宿主
        {"rid": "L3", "kind": "action", "label": "取消PBP",
         "stage": "s", "grounded": True, "objects": ["ot_pbp"]},
        # 唯一包含匹配："执行计划" ⊂ "采购执行计划"
        {"rid": "L4", "kind": "action", "label": "创建执行计划",
         "stage": "s", "grounded": True},
        # 歧义："计划" 同时落在三个对象名里 → 宁可挂空
        {"rid": "L5", "kind": "action", "label": "调整计划",
         "stage": "s", "grounded": False},
        # 认不出单据
        {"rid": "L6", "kind": "action", "label": "一段没有动词的说明",
         "stage": "s", "grounded": False},
        # 动词在尾巴上；宿主上一个接口都没有 → siblings 为空的那句话
        {"rid": "L7", "kind": "action", "label": "采购需求计划行创建",
         "stage": "s", "grounded": True},
        # 非 ACTION 节点一律跳过
        {"rid": "L8", "kind": "event", "label": "采购需求计划已创建",
         "stage": "s", "grounded": True},
    ],
    "edges": [["L1", "L8", "flow", "", True]],
}


# ══════════════════════════════════════════════════════════════════
#  6. BPMN
# ══════════════════════════════════════════════════════════════════
class _Doc:
    """只带 flow_bpmn 用到的四个属性的假 ParsedDoc。"""

    def __init__(self, d: dict[str, Any]) -> None:
        self.file_id = d["file_id"]
        self.file_name = d["file_name"]
        self.kind = d["kind"]
        self.structured = d["structured"]


_BPMN_DOCS: list[dict[str, Any]] = [
    # 非 BPMN，必须被过滤掉
    {"file_id": "f_x", "file_name": "表.xlsx", "kind": "xlsx",
     "structured": {"processes": [{"id": "p", "nodes": [{"id": "n", "type": "task"}]}]}},
    # structured 是 None（Python 侧 `or {}` 兜底）
    {"file_id": "f_none", "file_name": "空.bpmn", "kind": "bpmn", "structured": None},
    {"file_id": "f_bpmn", "file_name": "采购流程.bpmn", "kind": "bpmn", "structured": {
        "processes": [
            "不是 dict，跳过",
            {
                "id": "p 1", "name": "采购需求计划流程",
                "documentation": "从提出到审批",
                "nodes": [
                    {"id": "start1", "type": "startEvent", "name": "需求提出",
                     "category": "event"},
                    {"id": "task1", "type": "userTask", "name": "创建采购需求计划",
                     "category": "task", "documentation": "由需求申请人填写",
                     "lanes": [{"id": "lane1", "name": "需求申请人"}]},
                    {"id": "gw1", "type": "exclusiveGateway", "name": "审批结果",
                     "category": "gateway",
                     "lanes": [{"id": "lane2", "name": "计划管理员"},
                               {"id": "lane1", "name": "需求申请人"}]},
                    {"id": "task2", "type": "serviceTask", "category": "task",
                     "lanes": ["不是 dict", {"id": "lane2"}]},
                    {"id": "end1", "type": "endEvent", "name": "结束",
                     "category": "event"},
                    {"id": "end2", "type": "endEvent", "name": "驳回结束",
                     "category": "event"},
                    "不是 dict，跳过",
                    {"type": "task", "name": "没有 id，跳过"},
                    # category 与 type 都认不出 → ACTION
                    {"id": "misc1", "type": "", "category": "", "name": "杂项"},
                ],
                "sequenceFlows": [
                    {"id": "f1", "sourceRef": "start1", "targetRef": "task1"},
                    {"id": "f2", "sourceRef": "task1", "targetRef": "gw1",
                     "name": "f2"},          # name == id → 不当标签
                    {"id": "f3", "sourceRef": "gw1", "targetRef": "end1",
                     "name": "通过", "condition": "approved == true"},
                    {"id": "f4", "sourceRef": "gw1", "targetRef": "end2",
                     "name": "驳回"},
                    {"id": "f5", "sourceRef": "gw1", "targetRef": "no-such-node"},
                    "不是 dict，跳过",
                    {"sourceRef": "task1", "targetRef": "end1"},   # 无 id → "flow"
                ],
            },
            # 与 "p 1" slug 相同 → stage/workflow 的 rid 撞号
            {
                "id": "p-1", "name": "第二个流程",
                "nodes": [{"id": "start1", "type": "startEvent", "name": "开始"}],
                "sequenceFlows": [],
            },
        ],
    }},
]

#: `raw.get("lanes", ())` 这一行没有 `or []` 兜底：显式写了 ``"lanes": null``
#: 的节点会当场 TypeError。钉住这条，不"顺手修好"。
_BPMN_RAISES: list[dict[str, Any]] = [
    {"file_id": "f_bad", "file_name": "坏.bpmn", "kind": "bpmn", "structured": {
        "processes": [{"id": "p", "nodes": [
            {"id": "n1", "type": "task", "name": "x", "lanes": None}]}]}},
]


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    pipeline_flow = json.loads((GOLDEN / "pipeline.flow.json").read_text("utf-8"))
    pipeline_oir_dict = json.loads((GOLDEN / "pipeline.oir.json").read_text("utf-8"))

    out: dict[str, Any] = {}

    out["domain_code"] = [[t, domain_code(t)] for t in _DOMAIN_TEXTS]
    out["code_for"] = [
        {**c, "out": code_for(_KINDS[c["kind"]], c["label"],
                              stage_hint=c["stage_hint"], taken=set(c["taken"]))}
        for c in _CODE_CASES
    ]
    # taken=None 与 taken=set() 是两条分支（前者直接返回，后者查集合）
    out["code_for_taken_none"] = code_for(NodeKind.ACTION, "编制集采计划")

    out["canonical_verb"] = [[t, canonical_verb(t)] for t in _VERB_TEXTS]
    out["subject"] = [[t, _subject(t)] for t in _SUBJECT_TEXTS]

    # ── 合成图 ──────────────────────────────────────────────────
    built = _build(_BUILD_SPEC)
    out["build"] = {
        "prov": _PROV, "spec": _BUILD_SPEC, "graph": built.to_dict(),
        "health": _health(built), "main_path": built.main_path().to_dict(),
    }

    # ── flow_from_dict ─────────────────────────────────────────
    out["from_dict"] = [
        {"name": c["name"], "data": c["data"],
         "out": flow_from_dict(c["data"]).to_dict()}
        for c in _FROM_DICT_CASES
    ]
    # 真材料那张图：还原 → 再序列化，必须与磁盘上那份逐字段相等（status 除外）
    round_tripped = flow_from_dict(pipeline_flow)
    out["pipeline"] = {
        "roundtrip": round_tripped.to_dict(),
        "health": _health(round_tripped),
        "main_path": round_tripped.main_path().to_dict(),
    }

    # ── 接口挂载（就地改图，所以先跑 attach 再取图） ────────────
    oir = oir_from_dict(pipeline_oir_dict)
    graph = flow_from_dict(pipeline_flow)
    report = attach_endpoints(graph, oir)
    out["pipeline"]["attach"] = {
        "matched": report.matched,
        "unmatched_nodes": [list(x) for x in report.unmatched_nodes],
        "unresolved_nodes": [list(x) for x in report.unresolved_nodes],
        "used_actions": sorted(report.used_actions),
        "summary": report.summary(),
        "graph": graph.to_dict(),
    }
    out["pipeline"]["gaps"] = [_gap_dict(gp) for gp in coverage_gaps(report, oir)]
    out["pipeline"]["flow_from_actions"] = flow_from_actions(
        oir, file_name="材料.xlsx").to_dict()

    # max_per_node=1 / per_kind=1 的边界
    graph2 = flow_from_dict(pipeline_flow)
    report2 = attach_endpoints(graph2, oir, max_per_node=1)
    out["pipeline"]["attach_max1"] = {
        "matched": report2.matched,
        "endpoints": {rid: n.endpoint for rid, n in graph2.nodes.items()},
    }
    out["pipeline"]["gaps_per_kind_1"] = [
        _gap_dict(gp) for gp in coverage_gaps(report2, oir, per_kind=1)]

    # ── 合成 OIR 的接口视角建图 ────────────────────────────────
    synth = oir_from_dict(_SYNTH_OIR)
    out["synth_oir"] = _SYNTH_OIR
    out["synth"] = {
        "flow_from_actions": flow_from_actions(synth, file_name="接口清单.xlsx").to_dict(),
        "flow_from_actions_max_lanes_1": flow_from_actions(
            synth, file_name="接口清单.xlsx", max_lanes=1).to_dict(),
    }
    synth_graph = flow_from_actions(synth, file_name="接口清单.xlsx")
    synth_report = attach_endpoints(synth_graph, synth)
    out["synth"]["attach"] = {
        "matched": synth_report.matched,
        "unmatched_nodes": [list(x) for x in synth_report.unmatched_nodes],
        "unresolved_nodes": [list(x) for x in synth_report.unresolved_nodes],
        "used_actions": sorted(synth_report.used_actions),
        "summary": synth_report.summary(),
        "graph": synth_graph.to_dict(),
    }
    out["synth"]["gaps"] = [_gap_dict(gp) for gp in coverage_gaps(synth_report, synth)]
    # per_kind=2 → 5 个孤儿接口里只出 2 条，外加一条"另有 3 个"的兜底
    out["synth"]["gaps_per_kind_2"] = [
        _gap_dict(gp) for gp in coverage_gaps(synth_report, synth, per_kind=2)]

    # ── attach_endpoints 的分支覆盖 ────────────────────────────
    link_oir = oir_from_dict(_LINK_OIR)
    link_graph = _build(_LINK_SPEC)
    link_report = attach_endpoints(link_graph, link_oir)
    out["link"] = {
        "oir": _LINK_OIR, "spec": _LINK_SPEC,
        "matched": link_report.matched,
        "unmatched_nodes": [list(x) for x in link_report.unmatched_nodes],
        "unresolved_nodes": [list(x) for x in link_report.unresolved_nodes],
        "used_actions": sorted(link_report.used_actions),
        "summary": link_report.summary(),
        "graph": link_graph.to_dict(),
        "gaps": [_gap_dict(gp) for gp in coverage_gaps(link_report, link_oir)],
    }
    link_graph1 = _build(_LINK_SPEC)
    link_report1 = attach_endpoints(link_graph1, link_oir, max_per_node=1)
    out["link"]["max1"] = {
        "matched": link_report1.matched,
        "endpoints": {rid: n.endpoint for rid, n in link_graph1.nodes.items()},
        "objects": {rid: n.objects for rid, n in link_graph1.nodes.items()},
    }

    # ── BPMN ───────────────────────────────────────────────────
    bpmn_graph = flow_from_bpmn_docs([_Doc(d) for d in _BPMN_DOCS])
    out["bpmn"] = {
        "docs": _BPMN_DOCS,
        "graph": bpmn_graph.to_dict() if bpmn_graph is not None else None,
        "health": _health(bpmn_graph) if bpmn_graph is not None else None,
    }
    out["bpmn_none"] = flow_from_bpmn_docs(
        [_Doc(_BPMN_DOCS[0])]) is None
    out["bpmn_empty_structured"] = flow_from_bpmn_docs(
        [_Doc(_BPMN_DOCS[1])]) is None
    try:
        flow_from_bpmn_docs([_Doc(d) for d in _BPMN_RAISES])
        raised = "no-raise"
    except Exception as exc:  # noqa: BLE001
        raised = type(exc).__name__
    out["bpmn_raises"] = {"docs": _BPMN_RAISES, "error": raised}

    GOLDEN.mkdir(exist_ok=True)
    p = GOLDEN / "flow.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  flow.json {p.stat().st_size:>10} B")


def _gap_dict(gp: Any) -> dict[str, Any]:
    return {"text": gp.text, "group": gp.group, "kind": gp.kind,
            "weight": gp.weight, "options": gp.options,
            "applies_to": gp.applies_to,
            "prov": gp.prov.to_dict() if gp.prov is not None else None}


if __name__ == "__main__":
    main()
