"""导出 onto/canonical.py 的 golden —— 给 TS 侧 ts/src/onto/canonical.ts 当安全网。

canonical.py 是 OntologyPackage v1 的**归一层**：把 OIR / FlowGraph / 统一问题背包 /
决定台账四路遗留表示收敛成一份稳定契约。归一规则写宽一格，两个不同的业务对象就会
拿到同一个 canonical id 并静默合并 —— 那是不报错的数据损坏，所以这份 golden 的
重点不是"跑通"，而是把**每条归一规则的边界**钉死，尤其是"差一点该合并但不该合并"。

除了跑通四条主链路，这里专门导了 TS 侧独有的风险：

  1. ``str.strip()`` 与 JS ``trim()`` 的空白集不同 —— Python 多剥 \\x1c-\\x1f 与
     \\x85，JS 多剥 \\ufeff（BOM）。id 前缀判定（``startswith("dec.")`` /
     ``startswith("pkg.")``）就在 strip 之后，剥错一个字符就换一条分支；
  2. ``snippet[:300]`` 按 code point 切，JS 的 slice 按 UTF-16 code unit 切；
  3. ``dict`` 保插入序，而 JS 普通对象对**整数样式的键**会重排 —— ``by_id``
     的键是问题的遗留 id，业务上真的会出现 "1"/"2"/"10"，重排就换了问题顺序；
  4. ``dict.get(k, default)`` 在**键存在但值为 None** 时返回 None，不走 default；
     决定上 ``actorRole=None`` + ``actor_role="FDE"`` 的组合就靠这条；
  5. ``isinstance(x, int)`` 对 ``bool`` 为真（bool 是 int 的子类），
     ``validate_package`` 的 revision 校验直接受影响；
  6. ``round(x, 3)`` 是 half-even；``float`` 的 ``1.0`` 在 canonical_json 里是
     ``"1.0"`` 而 JS 只能给 ``"1"`` —— 这会让 **evidence id 跨语言不同**，
     属于 ids.ts 已钉住的语言边界，这里把它的确切形状导出来；
  7. 匿名问题（既无 id/rid 也无 sourceRef）会让 Python 抛 KeyError —— 两趟循环
     用了不同的兜底名。这是 Python 的既有行为，TS 必须同样炸。

跑法::

    .venv/bin/python tools/golden/canonical.py

产物 golden/canonical.json。**字节确定**：generated_at 全部显式传入，证据 id 由内容
导出，没有任何 now()/random，重跑两次 shasum 一致。
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.canonical import (  # noqa: E402
    COLLECTIONS,
    ONTOLOGY_PACKAGE_JSON_SCHEMA,
    SCHEMA_URL,
    SCHEMA_VERSION,
    _canonical_id,
    _data_kind,
    _EvidenceIndex,
    _normalise_decision,
    _package_id,
    _question_input,
    _stable_input_id,
    _value,
    build_package,
    export_package,
    package_from_dict,
    validate_package,
)
from ontocopilot.onto.flow import EdgeKind, FlowGraph, FlowNode, NodeKind, Stage  # noqa: E402
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BaseType,
    BusinessRule,
    LinkType,
    ObjectType,
    OpenQuestion,
    PropertyType,
    Provenance,
    RuleKind,
    by_user,
    extracted,
    inferred,
)

OUT = ROOT / "golden"

#: 全部场景共用的固定时间戳 —— 不固定就没有字节确定性。
AT = "2026-08-12T10:00:00+08:00"


# ══════════════════════════════════════════════════════════════════
#  1. 遗留输入 —— 用真对象搭，再 to_dict 落进 golden 当 TS 的输入
# ══════════════════════════════════════════════════════════════════
def legacy_models() -> tuple[OIR, FlowGraph]:
    """tests/test_canonical_package.py 里的那套采购场景，一字不改地搬过来。"""
    ev = Provenance(
        "file-1", "采购制度.docx", {"kind": "page", "page": 3},
        snippet="采购计划审批通过后创建采购包", extractor="docling", confidence=0.95,
    )
    oir = OIR()
    oir.add_object(ObjectType(
        rid="ot_procurement_plan",
        api_name=extracted("ProcurementPlan", ev),
        display_name=extracted("采购计划", ev),
        primary_key=extracted(["pt_plan_id"], ev),
    ))
    oir.add_property(PropertyType(
        rid="pt_plan_id", parent="ot_procurement_plan",
        api_name=extracted("planId", ev), display_name=extracted("计划ID", ev),
        base_type=extracted(BaseType.STRING, ev), required=extracted(True, ev),
    ))
    oir.add_action(ActionType(
        rid="at_approve_plan", api_name=extracted("审批采购计划", ev),
        applies_to=["ot_procurement_plan"], effects=inferred(["状态改为已审批"]),
    ))
    oir.add_rule(BusinessRule(
        rid="br_director_threshold",
        statement=extracted("含税金额达到50万元由采购总监审批", ev),
        kind=extracted(RuleKind.AUTHORITY, ev),
        applies_to=["ot_procurement_plan"], actor=extracted("采购总监", ev),
    ))
    oir.add_question(OpenQuestion(
        rid="oq_equal_threshold",
        text=extracted("正好50万元是否需要总监审批？", ev),
        options=["是", "否"], answer=by_user("是", note="访谈第5轮"),
        group="审批边界", applies_to=["br_director_threshold"], owner="业务负责人",
    ))

    flow = FlowGraph()
    flow.stages["approval"] = Stage("approval", "审批", order=1)
    flow.add_node(FlowNode(
        "fn_approve_plan", NodeKind.ACTION, extracted("审批采购计划", ev),
        stage="approval", actor=extracted("采购总监", ev),
        objects=["ot_procurement_plan"],
    ))
    flow.add_node(FlowNode(
        "fn_plan_approved", NodeKind.EVENT, extracted("采购计划已通过", ev),
        stage="approval", objects=["ot_procurement_plan"],
    ))
    flow.connect("fn_approve_plan", "fn_plan_approved", kind=EdgeKind.FLOW, evidence=[ev])
    return oir, flow


def merge_models() -> tuple[OIR, FlowGraph]:
    """OIR 与 Flow 用**不同前缀**指同一个业务动作 —— 归一层必须合并成一个 Action。

    这是 canonical.py 里唯一一处"主动合并"：``at_approve_plan`` 与 ``fn_approve_plan``
    去掉前缀后 slug 相同，于是共用 ``act.approve.plan``。合并做窄了会出重复 id
    让整包校验不过，做宽了会把两个真不同的动作揉成一个。同一份图里再放一个
    **前缀相同但名字不同**的节点（fn_reject_plan），它必须**不**被合并。
    """
    ev = Provenance("file-2", "流程.bpmn", {"kind": "xml", "pointer": "/p/t[1]"},
                    snippet="审批", extractor="bpmn", confidence=0.9)
    oir = OIR()
    oir.add_object(ObjectType(rid="ot_plan", api_name=extracted("Plan", ev),
                              display_name=extracted("采购计划单据", ev)))
    oir.add_action(ActionType(rid="at_approve_plan", api_name=extracted("approvePlan", ev),
                              applies_to=["ot_plan"]))
    flow = FlowGraph()
    flow.stages["s1"] = Stage("s1", "阶段一", subtitle="小字", order=1)
    flow.add_node(FlowNode("fn_approve_plan", NodeKind.ACTION, extracted("审批", ev),
                           stage="s1", objects=["ot_plan"]))
    flow.add_node(FlowNode("fn_reject_plan", NodeKind.ACTION, extracted("驳回", ev),
                           stage="s1", actor=extracted("采购经理", ev),
                           endpoint="https://erp.example.com/v1/reject"))
    flow.add_node(FlowNode("fn_plan_rejected", NodeKind.EVENT, extracted("计划已驳回", ev),
                           stage="s1"))
    flow.connect("fn_approve_plan", "fn_reject_plan", kind=EdgeKind.FLOW, label="驳回")
    flow.connect("fn_reject_plan", "fn_plan_rejected", kind=EdgeKind.FLOW)
    flow.connect("fn_plan_rejected", "fn_approve_plan", kind=EdgeKind.FLOW)
    return oir, flow


def near_miss_oir() -> OIR:
    """"差点该合并但不该合并"的一组对象 —— 每一对都必须拿到不同的 canonical id。

    真实事故的形状：只保留 ASCII 的 slug 会把「集采计划编制已发起」和「编制集采计划」
    双双抹成 ``x``，两个不同的东西共用一个 rid，后写的静默覆盖先写的。这里把同类
    陷阱一次性摆齐：中文近义、全角/半角、大小写、前后空白、纯符号。
    """
    ev = Provenance("f", "近似.xlsx", {"kind": "cell", "sheet": "S", "row": 1, "col": "A"},
                    snippet="近似名", extractor="docling", confidence=0.75)
    oir = OIR()
    for rid, name in [
        ("ot_a1", "集采计划编制已发起"),
        ("ot_a2", "编制集采计划"),
        ("ot_b1", "PLAN"),          # .lower() → plan → document
        ("ot_b2", "ＰＬＡＮ"),        # 全角：lower 之后仍是全角，**不**命中 plan
        ("ot_c1", "供应商"),
        ("ot_c2", "供应商消息"),      # 同时含 master 与 message 词 → message 先赢
        ("ot_d1", "---"),           # slug 退化成空 → 内容哈希兜底
        ("ot_d2", "==="),           # 同样退化，但哈希不同 → 不能撞
        ("ot_e1", "MATERIAL"),
        ("ot_e2", "materialCatalog"),  # master 与 reference 都命中 → master 先赢
    ]:
        oir.add_object(ObjectType(rid=rid, api_name=extracted(name, ev),
                                  display_name=extracted(name, ev)))
    return oir


# ══════════════════════════════════════════════════════════════════
#  2. 归一原语的逐条钉子
# ══════════════════════════════════════════════════════════════════
#: ``_canonical_id`` —— 归一层的核心。前缀剥除只剥**第一个命中**的，剥完再 slug，
#: 最后把下划线换成点。BOM/NEL 那两条钉的是 strip 的空白集差异。
CANONICAL_ID_CASES: list[tuple[str, Any, list[str]]] = [
    ("do", "ot_procurement_plan", ["ot_"]),
    ("do", "ot_ot_plan", ["ot_"]),            # 只剥一层
    ("attr", "pt_plan_id", ["pt_"]),
    ("rule", "rule_x", ["br_", "rule_"]),     # 命中第二个前缀
    ("rule", "br_rule_x", ["br_", "rule_"]),  # 命中第一个就 break，rule_ 留着
    ("act", "at_审批采购计划", ["at_"]),
    ("do", "", ["ot_"]),                      # 空 → slug(prefix)
    ("do", None, ["ot_"]),
    ("do", "   ", ["ot_"]),                   # 全空白 → strip 成空 → slug(prefix)
    ("do", "---", []),                        # 纯符号 → 哈希兜底
    ("do", "===", []),
    ("proc", "pkg.procurement", ["pkg."]),
    ("do", "  ot_有空白  ", ["ot_"]),           # strip 在剥前缀之前
    ("do", " ot_nbsp ", ["ot_"]),   # NBSP：两边的 strip 都剥
    ("do", "\x85ot_nel", ["ot_"]),            # NEL：Python 剥、JS trim 不剥
    ("do", "\x1cot_fs", ["ot_"]),             # 文件分隔符：同上
    ("do", "﻿ot_bom", ["ot_"]),          # BOM：JS trim 剥、Python 不剥
    ("do", "ot_", ["ot_"]),                   # 剥完就空 → slug(prefix)
    ("do", 12, []),                           # 非字符串 → str()
    ("do", 0, []),                            # 0 是假值 → `legacy_id or ""` → ""
    ("do", False, []),
    ("do", "A" * 60, []),                     # 触发 slug 的 40 code point 截断
    ("do", "甲" * 60, []),                     # 中文截断按 code point
    ("do", "计划🐍名", []),                      # 代理对不能被劈开
]

PACKAGE_ID_CASES: list[Any] = [
    "procurement", "pkg.procurement", "", None, "   ", "pkg.", "Pkg.Weird",
    "采购 项目", "a_b_c", "﻿pkg.bom", "\x85pkg.nel", 0, False, "---",
]

STABLE_INPUT_ID_CASES: list[tuple[str, Any, list[str]]] = [
    ("dec", "dec.already.canonical", ["dec_", "dlg_"]),
    ("dec", "dec_old", ["dec_", "dlg_"]),
    ("dec", "dlg_old", ["dec_", "dlg_"]),
    ("dec", "decision-1", ["dec_", "dlg_"]),
    ("q", "q.amount.caliber", ["oq_", "q_"]),
    ("q", "q_equal_threshold", ["oq_", "q_"]),
    ("q", "oq_equal_threshold", ["oq_", "q_"]),
    ("q", "  q.spaced  ", ["oq_", "q_"]),      # strip 之后才判前缀
    ("q", "\x85q.nel", ["oq_", "q_"]),         # Python strip 剥 → 判定成"已规范"
    ("q", "﻿q.bom", ["oq_", "q_"]),       # Python 不剥 → 判定成"遗留"
    ("q", "", ["oq_", "q_"]),
    ("dec", None, ["dec_"]),
]

#: ``_data_kind`` —— 唯一一处按名字猜业务类别的地方。命中顺序 message > master >
#: reference > document > transaction，顺序换了分类就换了。
DATA_KIND_CASES = [
    "采购需求计划", "供应商", "物料主数据", "数据字典", "状态类型", "采购订单",
    "发票", "消息", "事件报文", "通知", "供应商消息", "物料字典", "计划字典",
    "supplier", "SUPPLIER", "Supplier", "material", "materialCatalog",
    "catalog", "code", "plan", "PLAN", "ＰＬＡＮ", "order", "invoice",
    "message", "eventPayload", "EVENTPAYLOAD", "notification",
    "", "随便什么", "ﬁle", "İSTANBUL", "Straße", "ΟΔΟΣ", "planı",
    "客户", "组织", "人员", "分类", "配置", "代码", "枚举", "合同", "申请", "单据",
]

#: ``_value`` —— 断言拆包。Mapping 且含 "value" 键时**无条件**取 value（哪怕是 None），
#: 其余情况只有 None 才回落到 default。0/""/[]/False 一律原样返回。
VALUE_CASES: list[tuple[Any, Any]] = [
    ({"value": "计划金额", "origin": "extracted"}, ""),
    ({"value": None}, ""),
    ({"value": None}, "兜底"),
    ({"value": 0}, ""),
    ({"value": []}, None),
    ({"origin": "extracted"}, ""),   # 没有 "value" 键 → 整个 Mapping 原样返回
    (None, ""),
    (None, None),
    (None, []),
    ("裸字符串", ""),
    (0, "兜底"),
    ("", "兜底"),
    ([], "兜底"),
    (False, "兜底"),
]


def export_units() -> dict[str, Any]:
    return {
        "canonical_id": [
            {"prefix": p, "legacy": lid, "legacyPrefixes": pre,
             "out": _canonical_id(p, lid, *pre)}
            for p, lid, pre in CANONICAL_ID_CASES
        ],
        "package_id": [{"in": v, "out": _package_id(v)} for v in PACKAGE_ID_CASES],
        "stable_input_id": [
            {"prefix": p, "in": v, "legacyPrefixes": pre,
             "out": _stable_input_id(p, v, *pre)}
            for p, v, pre in STABLE_INPUT_ID_CASES
        ],
        "data_kind": [{"in": n, "kind": _data_kind(n)[0], "confidence": _data_kind(n)[1]}
                      for n in DATA_KIND_CASES],
        "value": [{"in": v, "default": d, "out": _value(v, d)} for v, d in VALUE_CASES],
    }


# ══════════════════════════════════════════════════════════════════
#  3. 证据索引 —— 内容寻址的 id，跨语言必须一致（1.0 那条除外）
# ══════════════════════════════════════════════════════════════════
LONG_SNIPPET = "甲" * 200 + "🐍" * 100 + "z" * 100  # 400 code points，含代理对

EVIDENCE_ADDS: list[dict[str, Any]] = [
    {"file_id": "f1", "file_name": "采购制度.docx", "locator": {"kind": "page", "page": 3},
     "snippet": "采购计划审批通过后创建采购包", "extractor": "docling", "confidence": 0.95},
    # snake_case 与 camelCase 都要认，且认出来的是同一条 → 同一个 id
    {"fileId": "f1", "fileName": "采购制度.docx", "locator": {"kind": "page", "page": 3},
     "snippet": "采购计划审批通过后创建采购包", "extractor": "docling", "confidence": 0.95},
    {},                                            # 全缺省 → confidence 落 0.5
    {"confidence": 0},                             # 0 是假值 → 走 `or 0.5`
    {"confidence": 0.0625},                        # half-even：0.062 而不是 0.063
    {"snippet": LONG_SNIPPET},                     # [:300] 按 code point 切
    {"cite": "采购制度.docx#p3"},
    {"file_id": "f1", "fileId": "f2"},             # snake 优先
]

#: confidence 恰好是**整数值的 float** —— Python canonical_json 写 "1.0"，
#: JS 只能写 "1"，于是 sha256 不同、evidence id 不同。这是 ids.ts 已钉住的语言
#: 边界（JS 里 1 与 1.0 是同一个值，无从区分），不是 canonical 层能修的。
EVIDENCE_FLOAT_DIVERGENCE = {"confidence": 1.0, "cite": "满分证据"}

EVIDENCE_REFERENCES: list[Any] = [
    "ev.0123456789abcdef",                          # 已规范 → 原样保留 + 占位记录
    "采购制度.docx#p3",                               # 遗留 cite → 确定性占位证据
    {"file_id": "f9", "file_name": "x.docx", "locator": {}, "snippet": "内联证据"},
    "", None, "   ",                                # 空 → None（不产生悬空引用）
    0, False,
]

EVIDENCE_ASSERTIONS: list[list[Any]] = [
    [],                                              # 没有值 → INFERRED / 0.4
    [{"origin": "extracted", "confidence": 0.9}],
    [{"origin": "user", "confidence": 0.0}],         # 0 → `or` 落到 0.8（非 INFERRED）
    [{"origin": "inferred", "confidence": 0.0}],     # 0 → 落到 0.4
    [{"origin": "外星人"}],                            # 未知 origin → rank 0，但原样保留
    [{"origin": "inferred"}, {"origin": "user"}],    # max 取 rank 最大
    [{"origin": "user"}, {"origin": "外星人"}],        # 同 rank 时 max 取**第一个**
    [{"origin": "外星人"}, {"origin": "怪东西"}],
    ["不是 Mapping", None, 12],                       # 非 Mapping 一律跳过
    [{"origin": "extracted", "confidence": 0.9,
      "evidence": [{"file_id": "f1", "snippet": "a"},
                   {"file_id": "f1", "snippet": "a"},   # 重复 → 只留一个 id
                   {"file_id": "f2", "snippet": "b"},
                   "不是 Mapping"]}],
]


def export_evidence() -> dict[str, Any]:
    adds = []
    for raw in EVIDENCE_ADDS:
        idx = _EvidenceIndex()
        eid = idx.add(raw)
        adds.append({"in": raw, "id": eid, "item": idx.items[eid]})

    shared = _EvidenceIndex()
    shared_ids = [shared.add(raw) for raw in EVIDENCE_ADDS]

    refs = []
    for raw in EVIDENCE_REFERENCES:
        idx = _EvidenceIndex()
        refs.append({"in": raw, "out": idx.reference(raw),
                     "items": list(idx.items.values())})

    assertions = []
    for values in EVIDENCE_ASSERTIONS:
        idx = _EvidenceIndex()
        assertions.append({"in": values, "out": idx.assertion(*values),
                           "items": list(idx.items.values())})

    div = _EvidenceIndex()
    div_id = div.add(EVIDENCE_FLOAT_DIVERGENCE)
    return {
        "add": adds,
        "shared_index": {"ids": shared_ids, "items": list(shared.items.values())},
        "reference": refs,
        "assertion": assertions,
        "float_divergence": {"in": EVIDENCE_FLOAT_DIVERGENCE, "id": div_id,
                             "item": div.items[div_id]},
    }


# ══════════════════════════════════════════════════════════════════
#  4. _normalise_decision / _question_input
# ══════════════════════════════════════════════════════════════════
#: ``dict.get(k, default)`` 在键存在但值为 None 时返回 None —— 后三条钉的就是它。
DECISION_CASES: list[dict[str, Any]] = [
    {"id": "dec_old", "questionId": "oq_equal_threshold", "answer": False,
     "affectedIds": ["br_director_threshold"], "revision": 1},
    {"key": "dlg_legacy", "statement": "用含税口径", "scope_refs": ["ot_plan"],
     "turn": "t-7", "ts": 1723449600.0, "actor_role": "FDE"},
    {"actorRole": None, "actor_role": "FDE"},          # 键在但为 None → 取 None
    {"sourceTurn": None, "source_turn": "t-1", "turn": "t-2"},
    {"effectiveAt": None, "createdAt": "2026-01-01", "ts": 1.0},
    {"answer": None, "statement": "不该被取到"},          # answer 键在 → None
    {"question_id": "q_x", "affected_ids": ["a"], "scope_refs": ["b"]},
    {},                                                  # 全缺 → decision-<index>
    {"id": "", "key": "", "affectedIds": []},
]

QUESTION_INPUT_CASES: list[Any] = [
    None,
    [],
    [{"id": "q1", "text": "问题一"}],
    {"questions": [{"id": "q1"}, {"id": "q2"}]},         # 背包的 JSON 形态
    {"questions": None},                                  # → []
    {"id": "q_single", "text": "单条"},                    # 单个 Question 的 dict
    {"rid": "oq_single"},
    {"a": {"id": "qa"}, "b": {"id": "qb"}},               # 既无 questions 也无 id → values()
    {},                                                   # 空 dict → values() → []
]

QUESTION_INPUT_RAISES: list[Any] = ["字符串", b"bytes", [1, 2], ["x"], [None]]


def export_adapters() -> dict[str, Any]:
    question_ids = {"oq_equal_threshold": "q.equal.threshold", "q_x": "q.x",
                    "ot_plan": "q.from.ref"}
    decisions = [
        {"in": raw, "index": i,
         "out": _normalise_decision(raw, i, question_ids)}
        for i, raw in enumerate(DECISION_CASES, 1)
    ]
    inputs = [{"in": raw, "out": _question_input(raw)} for raw in QUESTION_INPUT_CASES]
    raises = []
    for raw in QUESTION_INPUT_RAISES:
        try:
            _question_input(raw)
        except TypeError as e:
            raises.append({"in": raw.decode() if isinstance(raw, bytes) else raw,
                           "isBytes": isinstance(raw, bytes),
                           "type": type(e).__name__, "message": str(e)})
        else:
            raise SystemExit(f"_question_input({raw!r}) 不再抛了？重新核对")
    return {"question_ids": question_ids, "normalise_decision": decisions,
            "question_input": inputs, "question_input_raises": raises}


# ══════════════════════════════════════════════════════════════════
#  5. 端到端场景
# ══════════════════════════════════════════════════════════════════
BACKLOG_CONFLICT_QUESTION: dict[str, Any] = {
    "id": "q_conflict_amount_caliber",
    "text": "预算金额应使用含税还是不含税口径？",
    "status": "status.answered",
    "ownerUserId": "fde-wang",
    "audienceRole": "ERP顾问",
    "answerSchema": {"type": "string", "enum": ["tax-inclusive", "tax-exclusive"]},
    "priority": "BLOCKING",
    "dependencies": ["oq_equal_threshold"],
    "blockedArtifacts": ["br_director_threshold", "artifact-lineage-9"],
    "sourceKind": "conflict",
    "sourceRef": "cf_amount_caliber",
    "why": "两个材料的金额口径冲突",
    "options": [],
    "evidenceIds": ["采购制度.docx#p3"],
    "informationGain": 0.92,
    "blastRadius": 7,
    "version": 4,
}

BACKLOG_OVERRIDE_QUESTION: dict[str, Any] = {
    "id": "q_equal_threshold",
    "sourceRef": "oq_equal_threshold",
    "sourceKind": "open_question",
    "text": "正好50万元是否需要总监审批？",
    "status": "deferred",
    "ownerUserId": "owner-7",
    "audienceRole": "业务负责人",
    "priority": "high",
    "answerSchema": {"type": "string", "enum": ["是", "否"]},
    "version": 9,
}

#: 键是"整数样式"的问题背包 —— Python dict 保插入序，JS 普通对象会重排成 1,2,10。
#: 问题的输出顺序直接来自这个 dict，重排就是产物 diff 全红。
NUMERIC_KEY_QUESTIONS: list[dict[str, Any]] = [
    {"id": "10", "text": "第十条"},
    {"id": "2", "text": "第二条"},
    {"id": "1", "text": "第一条", "dependencies": ["10", "2"]},
    {"id": "-3", "text": "负数键"},
    {"id": "01", "text": "前导零不是整数样式"},
]

#: 各种脏输入：blastRadius 键在但为 None、priority 大小写、status 带 "status." 前缀、
#: 证据引用的三种形态、超长 snippet、options 生成 answerSchema。
DIRTY_QUESTIONS: list[dict[str, Any]] = [
    {"id": "q_dirty_1", "text": {"value": "断言形态的题干"},
     "blastRadius": None, "blocked_artifacts": ["ot_procurement_plan"],
     "priority": "BLOCKING", "status": "status.ANSWERED",
     "evidence_ids": ["ev.0123456789abcdef", "采购制度.docx#p3",
                      {"file_id": "f9", "snippet": LONG_SNIPPET}],
     "information_gain": 0.5, "audience_role": "ERP顾问", "owner": "fde-li"},
    {"id": "q_dirty_2", "text": "裸字符串题干", "options": ["甲", "乙"],
     "gap_id": "gap-2", "code": "Q-002", "group": "分组当 why 用",
     "version": "9", "blast_radius": 3.9,
     "blockedArtifacts": ["at_approve_plan", "br_director_threshold", "不存在的东西"]},
    {"sourceRef": "cf_only_source_ref", "text": "只有 sourceRef 的问题"},
]


def scenario(name: str, oir: Any, flow: Any = None, **options: Any) -> dict[str, Any]:
    pkg = build_package(oir, flow, **options)
    out: dict[str, Any] = {
        "name": name,
        "oir": oir if isinstance(oir, dict) else oir.to_dict(),
        "flow": None if flow is None else (flow if isinstance(flow, dict) else flow.to_dict()),
        "options": {k: v for k, v in options.items()},
        "out": pkg.to_dict(),
    }
    return out


def export_scenarios() -> list[dict[str, Any]]:
    oir, flow = legacy_models()
    oir_d, flow_d = oir.to_dict(), flow.to_dict()
    merge_oir, merge_flow = merge_models()

    explicit_decisions = [
        {"id": "dec_old", "questionId": "oq_equal_threshold", "answer": False,
         "affectedIds": ["br_director_threshold"], "revision": 1},
        {"id": "dec_new", "questionId": "oq_equal_threshold", "answer": True,
         "affectedIds": ["br_director_threshold", "at_approve_plan", "游离引用"],
         "supersedes": "dec_old", "revision": 2},
    ]
    conflict_decision = {
        "id": "dec_conflict_amount", "questionId": "q_conflict_amount_caliber",
        "answer": "tax-inclusive", "actor": "fde-wang", "actorRole": "FDE",
        "affectedIds": ["br_director_threshold"], "revision": 4,
        "idempotencyKey": "idem-conflict-1",
    }

    return [
        scenario("main", oir_d, flow_d, package_id="procurement", revision=2,
                 base_revision=1, generated_at=AT),
        # 同一组输入，一次给活对象一次给 dict —— Python 侧断言两者相等，
        # TS 侧只吃 dict，所以这里只导 dict 版即可（形状与上面一致）。
        scenario("no_flow", oir_d, None, package_id="pkg.procurement", generated_at=AT),
        scenario("explicit_decisions", oir_d, flow_d, generated_at=AT,
                 decisions=explicit_decisions),
        scenario("backlog_conflict", oir_d, flow_d, generated_at=AT,
                 backlog=[BACKLOG_CONFLICT_QUESTION], decisions=[conflict_decision]),
        scenario("backlog_override", oir_d, flow_d, generated_at=AT,
                 questions=[BACKLOG_OVERRIDE_QUESTION]),
        scenario("canonical_ids_idempotent", OIR().to_dict(), None, generated_at=AT,
                 questions=[{"id": "q.amount.caliber", "text": "金额口径是什么？"}],
                 decisions=[{"id": "dec.amount.caliber", "questionId": "q.amount.caliber",
                             "answer": "含税", "actor": "fde"}]),
        scenario("merge_action_prefixes", merge_oir.to_dict(), merge_flow.to_dict(),
                 package_id="合并", generated_at=AT),
        scenario("near_miss", near_miss_oir().to_dict(), None, package_id="近似",
                 generated_at=AT),
        scenario("numeric_question_keys", OIR().to_dict(), None, generated_at=AT,
                 questions=NUMERIC_KEY_QUESTIONS),
        scenario("dirty_questions", oir_d, flow_d, generated_at=AT,
                 questions=DIRTY_QUESTIONS),
        scenario("empty", {}, {}, generated_at=AT),
        scenario("empty_none", {}, None, generated_at=AT),
    ]


# ══════════════════════════════════════════════════════════════════
#  6. 校验器 —— 每条 finding 的 code / path / ref / 顺序都要一致
# ══════════════════════════════════════════════════════════════════
def mutate(base: dict[str, Any], fn: Any) -> dict[str, Any]:
    data = json.loads(json.dumps(base, ensure_ascii=False))
    fn(data)
    return data


def export_validation(main: dict[str, Any]) -> list[dict[str, Any]]:
    cases: list[tuple[str, Any]] = []

    def add(name: str, fn: Any) -> None:
        cases.append((name, fn))

    add("clean", lambda d: None)
    add("dangling_and_duplicate", lambda d: (
        d["events"][0].__setitem__("producerAction", "act.missing"),
        d["actions"].append(dict(d["actions"][0])),
    ))
    add("bad_header", lambda d: (
        d.__setitem__("$schema", "https://example.com/other"),
        d.__setitem__("schemaVersion", "2.0.0"),
        d.__setitem__("packageId", "procurement"),
        d.__setitem__("revision", 0),
        d.__setitem__("baseRevision", 9),
    ))
    # bool 是 int 的子类 → Python 认为 revision=True 合法且 int(True)==1
    add("bool_revision", lambda d: d.__setitem__("revision", True))
    add("float_revision", lambda d: d.__setitem__("revision", 2.0))
    add("string_revision", lambda d: d.__setitem__("revision", "2"))
    add("null_base_revision", lambda d: d.__setitem__("baseRevision", None))
    add("collection_not_array", lambda d: d.__setitem__("rules", {"a": 1}))
    add("item_not_object", lambda d: d["rules"].append("我不是对象"))
    add("missing_item_id", lambda d: d["rules"].append({"rawStatement": "无 id"}))
    add("dangling_question_dependency",
        lambda d: d["questions"][0].__setitem__("dependencies", ["q.missing"]))
    add("dangling_evidence",
        lambda d: d["questions"][0].__setitem__("evidenceIds", ["ev.missing"]))
    add("dangling_assertion_evidence",
        lambda d: d["dataObjects"][0]["assertion"].__setitem__(
            "evidenceIds", ["ev.missing", ""]))
    add("process_edge_missing_side",
        lambda d: d["processes"][0]["edges"][0].pop("to"))
    add("dangling_stage_and_semantic", lambda d: (
        d["processes"][0]["nodes"][0].__setitem__("stageId", "stage.missing"),
        d["processes"][0]["nodes"][0].__setitem__("semanticRef", "act.missing"),
        d["processes"][0]["nodes"][0].__setitem__("dataObjectRefs", ["do.missing"]),
    ))
    add("duplicate_process_node", lambda d: d["processes"][0]["nodes"].append(
        dict(d["processes"][0]["nodes"][0])))
    add("entry_exit_dangling", lambda d: (
        d["processes"][0].__setitem__("entryNodeIds", ["pn.missing"]),
        d["processes"][0].__setitem__("exitNodeIds", ["pn.missing"]),
    ))
    add("action_refs_dangling", lambda d: (
        d["actions"][0].__setitem__("inputs", ["do.missing"]),
        d["actions"][0].__setitem__("preconditions", ["rule.missing"]),
        d["actions"][0].__setitem__("compensationAction", "act.missing"),
        d["actions"][0].__setitem__("actorRole", "role.missing"),
        d["actions"][0].__setitem__("system", "sys.missing"),
        d["actions"][0].__setitem__("effects", [{"object": "do.missing"}, "非对象"]),
        d["actions"][0].__setitem__("sourceProcessNodes", ["pn.missing"]),
    ))
    add("decision_refs_dangling", lambda d: (
        d["decisions"][0].__setitem__("questionId", "q.missing"),
        d["decisions"][0].__setitem__("supersedes", "dec.missing"),
        d["decisions"][0].__setitem__("affectedIds", ["do.missing", None, "", 0]),
    ))
    add("rule_trigger_dangling", lambda d: (
        d["rules"][0].__setitem__("trigger", "evt.missing"),
        d["rules"][0].__setitem__("scope", ["do.missing"]),
    ))
    add("event_refs_dangling", lambda d: (
        d["events"][0].__setitem__("consumers", ["act.missing"]),
        d["events"][0].__setitem__("payload", {"dataObject": "do.missing"}),
        d["events"][0].__setitem__("producerSystem", "sys.missing"),
    ))
    add("dataobject_refs_dangling", lambda d: (
        d["dataObjects"][0].__setitem__("systemOfRecord", "sys.missing"),
        d["dataObjects"][0].__setitem__("ownerRole", "role.missing"),
        d["dataObjects"][0]["relations"].append({"target": "do.missing"}),
    ))
    # ref 是非字符串：check 里 `ref != ""` 为真、`ref not in allowed` 也为真 →
    # 报出来的 message 走 f-string（`f"{True}"` 是 "True"），ref 走 str()
    add("nonstring_refs", lambda d: d["questions"][0].__setitem__(
        "blockedArtifacts", [0, True, None, "", 1.5]))
    # ref 是 list → `x in set` 要求可哈希 → TypeError。TS 侧 Set.has 不会炸，
    # 必须显式判，否则「Python 崩、TS 静默通过」就成了两边行为分叉。
    add("unhashable_ref", lambda d: d["questions"][0].__setitem__(
        "blockedArtifacts", [["嵌套"]]))
    add("missing_collections", lambda d: [d.pop(c, None) for c in COLLECTIONS])

    out = []
    for name, fn in cases:
        data = mutate(main, fn)
        try:
            report = validate_package(data)
        except (TypeError, ValueError) as e:
            # revision 是字符串时 `base >= revision` 直接 TypeError —— JS 的 `>=`
            # 会隐式转型而**不**抛，这条必须在 TS 侧显式复现。
            out.append({"name": name, "in": data, "out": None,
                        "raises": {"type": type(e).__name__, "message": str(e)}})
            continue
        out.append({"name": name, "in": data, "out": report.to_dict(),
                    "passed": report.passed})
    return out


# ══════════════════════════════════════════════════════════════════
#  7. 序列化：to_json / export_package / package_from_dict
# ══════════════════════════════════════════════════════════════════
def export_serialization(main_pkg_dict: dict[str, Any]) -> dict[str, Any]:
    restored = package_from_dict(main_pkg_dict)
    stream = io.StringIO()
    export_package(restored, stream)

    stream2 = io.StringIO()
    export_package(main_pkg_dict, stream2)

    bad_version = json.loads(json.dumps(main_pkg_dict, ensure_ascii=False))
    bad_version["schemaVersion"] = "2.0.0"
    raises: list[dict[str, Any]] = []
    for label, payload in [("bad_version", bad_version), ("missing_version", {}),
                           ("null_version", {"schemaVersion": None})]:
        try:
            package_from_dict(payload)
        except ValueError as e:
            raises.append({"label": label, "type": type(e).__name__, "message": str(e)})
        else:
            raise SystemExit(f"package_from_dict({label}) 不再抛了？")

    invalid = json.loads(json.dumps(main_pkg_dict, ensure_ascii=False))
    invalid["questions"][0]["dependencies"] = ["q.missing"]
    try:
        export_package(invalid, io.StringIO())
    except ValueError as e:
        export_raises = {"type": type(e).__name__, "message": str(e)}
    else:
        raise SystemExit("export_package 不再拒绝非法包了？")

    return {
        "from_dict_roundtrip": restored.to_dict(),
        "export_text": stream.getvalue(),
        "export_text_from_mapping": stream2.getvalue(),
        "to_json_indent2": restored.to_json(),
        "to_json_no_indent": restored.to_json(indent=None),
        "from_dict_raises": raises,
        "export_raises": export_raises,
        "export_invalid_input": invalid,
    }


def export_build_raises() -> list[dict[str, Any]]:
    oir, _ = legacy_models()
    oir_d = oir.to_dict()
    out = []
    for label, kwargs in [
        ("revision_zero", {"revision": 0}),
        ("revision_negative", {"revision": -1}),
        ("base_equal", {"revision": 2, "base_revision": 2}),
        ("base_greater", {"revision": 2, "base_revision": 3}),
        ("both_questions_and_backlog", {"questions": [], "backlog": []}),
    ]:
        try:
            build_package(oir_d, generated_at=AT, **kwargs)
        except ValueError as e:
            out.append({"label": label, "kwargs": kwargs,
                        "type": type(e).__name__, "message": str(e)})
        else:
            raise SystemExit(f"build_package({label}) 不再抛了？")

    # 匿名问题（既无 id/rid 也无 sourceRef）：两趟循环的兜底名不一致 →
    # 第二趟必然 KeyError。这是 Python 的既有行为，不是 TS 要"修好"的东西。
    anon = {"questions": [{"text": {"value": "匿名问题"}}]}
    try:
        build_package(anon, generated_at=AT)
    except KeyError as e:
        out.append({"label": "anonymous_question", "kwargs": {"oir": anon},
                    "type": type(e).__name__, "message": str(e), "key": e.args[0]})
    else:
        raise SystemExit("匿名问题不再 KeyError 了？重新核对两趟循环的兜底名")
    return out


# ══════════════════════════════════════════════════════════════════
#  8. 语言边界的显式钉子
# ══════════════════════════════════════════════════════════════════
#: Python ``str.strip()`` 与 JS ``trim()`` 的空白集**不同**：
#: Python 多剥 \x1c-\x1f 与 \x85，JS 多剥 ﻿。canonical 层在 strip 之后立刻
#: 判前缀，剥错一个字符就换一条分支 —— 所以 TS 必须自带 pyStrip 而不是用 trim。
STRIP_CASES = [
    "  x  ", "\tx\n", "\x0bx\x0c", "\rx\r", "\x1cx\x1c", "\x1dx", "\x1ex", "\x1fx",
    "\x85x", "\xa0x\xa0", " x", " x", " x", " x", " x",
    " x", " x", "　x", "﻿x", "x﻿", "​x",
    "", "   ", "\x85", "﻿", "计划  ", "  计划",
]


#: ``str(x)`` 在容器上是 Python repr，与 JS 的 ``String(x)`` 完全不同 ——
#: ``str(['a','b'])`` 是 ``"['a', 'b']"`` 而 JS 给 ``"a,b"``。displayName /
#: rawStatement 这些字段都走 ``str(_value(...))``，材料里出现列表值就直接印进产物。
PY_STR_CASES: list[Any] = [
    None, True, False, 0, 1, -1, 1.5, "文本", "",
    ["a", "b"], ["a"], [], [1, True, None], [["嵌套"], {"k": "v"}],
    {"a": 1}, {}, {"a": "文本", "b": None},
]

#: Python ``str.isspace()`` 为真的 29 个码点。JS 的 ``trim()`` 用的是另一套
#: （多 ﻿、少 \x1c-\x1f 与 \x85），所以 TS 侧必须自带 pyStrip。
PY_SPACE = [c for c in range(0x110000) if chr(c).isspace()]


def export_divergence() -> dict[str, Any]:
    return {
        "py_str": [{"in": v, "out": str(v)} for v in PY_STR_CASES],
        "py_isspace": PY_SPACE,
        "strip": [{"in": s, "out": s.strip()} for s in STRIP_CASES],
        # `s[:300]` 按 code point 切：400 code point 的串（含 100 个代理对）
        "slice_300": {"in": LONG_SNIPPET, "out": LONG_SNIPPET[:300],
                      "code_points": len(LONG_SNIPPET),
                      "utf16_units": len(LONG_SNIPPET.encode("utf-16-le")) // 2},
        # `.lower()` / `.upper()`：命中 _data_kind 词表的那些字符两边完全一致，
        # 已在 data_kind 用例里覆盖；这里只钉住整套词表本身。
        "case_words": {
            "master": ["供应商", "物料", "客户", "组织", "人员", "supplier", "material"],
            "reference": ["字典", "类型", "分类", "配置", "代码", "枚举", "catalog", "code"],
            "document": ["计划", "订单", "申请", "合同", "发票", "单据",
                         "plan", "order", "invoice"],
            "message": ["消息", "事件报文", "通知", "message", "eventpayload",
                        "notification"],
        },
        # bool 是 int 的子类
        "isinstance_int": {"True": isinstance(True, int), "1.0": isinstance(1.0, int),
                           "1": isinstance(1, int)},
        # int(x) 的截断方向
        "int_cast": [{"in": v, "out": int(v)} for v in
                     [3.9, -3.9, 0.5, "7", True, False, 0]],
    }


def main() -> None:
    scenarios = export_scenarios()
    main_out = next(s for s in scenarios if s["name"] == "main")["out"]
    obj = {
        "schema": {
            "SCHEMA_VERSION": SCHEMA_VERSION,
            "SCHEMA_URL": SCHEMA_URL,
            "COLLECTIONS": list(COLLECTIONS),
            "ONTOLOGY_PACKAGE_JSON_SCHEMA": ONTOLOGY_PACKAGE_JSON_SCHEMA,
        },
        "units": export_units(),
        "evidence": export_evidence(),
        "adapters": export_adapters(),
        "scenarios": scenarios,
        "validation": export_validation(main_out),
        "serialization": export_serialization(main_out),
        "build_raises": export_build_raises(),
        "divergence": export_divergence(),
    }
    OUT.mkdir(exist_ok=True)
    p = OUT / "canonical.json"
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  canonical.json {p.stat().st_size} B")


if __name__ == "__main__":
    main()
