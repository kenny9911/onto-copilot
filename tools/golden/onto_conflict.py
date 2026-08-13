"""导出 onto/conflict.py + onto/align.py 的 golden —— 给 TS 侧当安全网。

冲突检测是这个产品最值钱的输出：判据写宽了刷假冲突，写窄了漏真冲突。
两个方向都必须被真跑出来的向量钉住，而不是靠手写期望值猜 Python 的行为。

这里同时钉住三样东西：

  1. **difflib.SequenceMatcher**（ratio / get_opcodes）—— TS 没有对等物，
     必须手写移植；``_widest_pair`` 与 ``undescribed_diff`` 的输出完全由它决定。
  2. **正则语义**：``\\bnet\\b`` 在 Python 里是 Unicode 词边界（``净额net`` 不匹配），
     JS 的 ``\\b`` 只认 ASCII（会匹配）；``^…$`` 在 Python 里还匹配末尾换行。
  3. **口径轴解析 / 冲突检测 / 实体对齐**的端到端产物。

**一处 Python 侧的不确定性必须显式绕开**：``axis_diff`` 返回的是
``pa.keys() & pb.keys()`` 这个 *set* 上的推导式，键序随进程哈希种子变化
（同一份输入，连跑六次得到六种顺序）。于是多轴分歧的 summary 里
"税（…）、时间粒度（…）" 的先后在 Python 侧本来就不稳定。
导出时把 semantic_divergence 的 summary 拆成 head + **排序后**的轴片段列表，
TS 侧做同样的归一再比 —— 钉住内容，不钉住那个本来就不存在的顺序。

跑法::

    .venv/bin/python tools/golden/onto_conflict.py

产物 golden/onto.conflict.json、golden/onto.align.json。
**字节确定**：全部输入都是字面量，且所有 set 推导出来的东西都排过序；
重跑两次 shasum 一致。
"""

from __future__ import annotations

import difflib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.onto.align import (  # noqa: E402
    AlignPolicy,
    AlignResult,
    EntityAligner,
    align_and_apply,
    tokens,
)
from ontocopilot.onto.conflict import (  # noqa: E402
    POLICY,
    Conflict,
    ConflictKind,
    auto_repair,
    axis_ambiguities,
    axis_diff,
    canonical_axes,
    detect_all,
    detect_missing_actions,
    detect_missing_required,
    detect_naming,
    detect_orphans,
    detect_perfunctory,
    detect_semantic_divergence,
    detect_type_mismatch,
    parse_axes,
    perfunctory_signals,
    primary_clause,
    to_camel,
    undescribed_diff,
)
from ontocopilot.onto.conflict import _endpoint_matches as endpoint_matches  # noqa: E402
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BaseType,
    Cardinality,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  0. difflib.SequenceMatcher —— TS 侧必须手写移植，先把它钉死
# ══════════════════════════════════════════════════════════════════
#: 覆盖：空串、完全相同、完全不同、重复字符（b2j 多下标）、CJK、
#: 星平面 emoji（Python 按 code point 迭代，JS 按 UTF-16 —— 必须分叉可见）、
#: 长度悬殊（ratio 分母）、公共前后缀（递归切分两侧都进队列）。
SEQ_CASES: list[tuple[str, str]] = [
    ("", ""),
    ("", "abc"),
    ("abc", ""),
    ("abc", "abc"),
    ("abc", "xyz"),
    ("abcdef", "abdf"),
    ("aaaa", "aa"),
    ("abab", "baba"),
    ("含税年度累计CNY", "不含税单次CNY"),
    ("计划金额取工艺路线上首道工序的产能上限", "计划金额取末道工序的产能下限"),
    ("计划金额", "计划金额"),
    ("🙂🙃🙂", "🙃🙂🙃"),
    ("a🙂b", "ab"),
    ("planamount", "planamounttotal"),
    ("purchaseplanheader", "pbpheader"),
    ("qwertyuiop", "poiuytrewq"),
    ("the quick brown fox", "the quick brown dog"),
    ("x" * 20, "x" * 3),
    # ↓ len(b) >= 200 才会触发 autojunk 的"高频元素清洗"，短串上两个开关没区别。
    #   align.py 走的是**默认开**，apiName 只要超过 200 字符就落进这条分支。
    #   这一对还顺带钉住一处容易抄错的细节：被清洗掉的 popular 元素进的是
    #   `bpopular`，**不是** `bjunk`，所以 find_longest_match 末尾的延伸循环
    #   照样能吃掉它们 —— 抄成同一个集合，长串的匹配块会整段消失。
    ("x" * 100 + "y" + "x" * 109, "x" * 100 + "z" + "x" * 109),
    ("ab" * 150, "ba" * 150),
]


def export_seqmatch() -> list[dict[str, Any]]:
    out = []
    for a, b in SEQ_CASES:
        # conflict.py 用的是 autojunk=False，align.py 用的是默认 autojunk=True。
        # 两个都导：默认那条在短串上等价，但**不能假设**，得让 TS 自己对上。
        rows: dict[str, Any] = {"a": a, "b": b}
        for tag, junk in (("autojunk_off", False), ("autojunk_on", True)):
            sm = difflib.SequenceMatcher(None, a, b, autojunk=junk)
            rows[tag] = {
                "ratio": sm.ratio(),
                "blocks": [list(m) for m in sm.get_matching_blocks()],
                "opcodes": [list(op) for op in sm.get_opcodes()],
            }
        out.append(rows)
    return out


# ══════════════════════════════════════════════════════════════════
#  1. 口径的结构化比较
# ══════════════════════════════════════════════════════════════════
#: claude-opus-4.8 在真实材料上产出的口径原文。它写得很好（顺带说明了与另一处
#: 的差异），而正是这个"好"曾经让整串扫关键词的解析器判错了轴。
REAL_A = ("计划金额。口径：含税，年度累计，CNY（Excel 批注 R5-5 与 DDL 注释 "
          "pbp_header.plan_amount '含税·年度累计·CNY' 一致）。注意与 "
          "clmContract.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)"
          "上口径不同，两处均保留，交业务方拍板")
REAL_B = ("计划金额。口径：不含税，单次，CNY（Excel 批注 R8-8 与 DDL 注释 "
          "clm_contract.plan_amount '不含税·单次·CNY' 一致）。注意与 "
          "pbpHeader.planAmount 在税轴(含税/不含税)、时间粒度轴(年度累计/单次)"
          "上口径不同，两处均保留，交业务方拍板")

TEXTS: list[str] = [
    "",
    "含税，年度累计，CNY",
    "不含税，单次，CNY",
    "不含税·单次·CNY",
    "金额",
    REAL_A,
    REAL_B,
    "计划金额。口径（Excel 批注）：含税，年度累计，CNY；DDL 注释一致",
    "计划金额，含税/不含税两种口径都在用",
    "口径：未税，月度，USD",
    "口径:价税合计，全年，人民币，预算",
    "定义：净额结算，per_time，实际执行，美元",
    "定义:annual budget net amount",
    "本次采购的计划金额，指含税总价",
    "计划金额按不含税口径统计",
    "计划金额取工艺路线上首道工序的产能上限",
    "计划金额取末道工序的产能下限",
    "含税总价",
    "  含税，年度累计。  ",
    "注意：含税",                       # 标记在位置 0（find 返回 0，不切）
    "（含税）年度累计",                  # 括号在最前
    "参见附件，含税",                    # 标记之前没有轴取值 → 不切
    "含税，年度累计。注意与合同域在税轴(含税/不含税)上不同",
    "monthly net per time actual USD",
    "净额net",                          # \\b 的 Unicode 词边界：Python 不匹配
    "a net b",
    "netto",
    "_net_",
    "NET",
    "单元格",                            # 「元」在「单元格」里 —— 判据写宽的样子
]


def export_axes() -> dict[str, Any]:
    return {
        "primary_clause": [{"in": t, "out": primary_clause(t)} for t in TEXTS],
        # dict，键序 = _AXES 声明序，确定
        "parse_axes": [{"in": t, "out": list(parse_axes(t).items())} for t in TEXTS],
        "parse_axes_whole": [
            {"in": t, "out": list(parse_axes(t, whole=True).items())} for t in TEXTS
        ],
        "axis_ambiguities": [{"in": t, "out": axis_ambiguities(t)} for t in TEXTS],
        "canonical_axes": [{"in": t, "out": canonical_axes(t)} for t in TEXTS],
        # ★ set 推导，键序在 Python 侧本来就不稳 → 排序后导出
        "axis_diff": [
            {"a": a, "b": b,
             "out": sorted([k, list(v)] for k, v in axis_diff(a, b).items())}
            for a, b in AXIS_DIFF_PAIRS
        ],
        "undescribed_diff": [
            {"a": a, "b": b, "out": undescribed_diff(a, b)}
            for a, b in UNDESCRIBED_PAIRS
        ],
        "undescribed_diff_limit": [
            {"a": a, "b": b, "limit": n, "out": undescribed_diff(a, b, n)}
            for a, b, n in [
                ("abcdefghijklmn", "xbxdxfxhxjxlxn", 2),
                ("abcdefghijklmn", "xbxdxfxhxjxlxn", 0),
                ("abcdefghijklmn", "xbxdxfxhxjxlxn", 100),
            ]
        ],
    }


AXIS_DIFF_PAIRS = [
    ("含税，年度累计", "不含税，单次"),
    ("含税，年度累计", "金额"),
    (REAL_A, REAL_B),
    ("含税，年度累计，CNY", "不含税，单次，CNY"),
    ("本次采购的计划金额，指含税总价", "计划金额按不含税口径统计"),
    ("口径：未税，月度，USD", "口径:价税合计，全年，人民币，预算"),
    ("", ""),
    ("含税总价", "含税总价"),
    ("计划金额取工艺路线上首道工序的产能上限", "计划金额取末道工序的产能下限"),
]

UNDESCRIBED_PAIRS = [
    ("", ""),
    ("含税总价", "含税总价"),
    ("计划金额取工艺路线上首道工序的产能上限", "计划金额取末道工序的产能下限"),
    ("含税，年度累计，CNY", "不含税，单次，CNY"),
    ("A、B。C；D", "A B C D"),          # _norm_text 去标点后完全相同 → []
    ("🙂计划", "🙃计划"),
    ("abcdefghijklmn", "xbxdxfxhxjxlxn"),
]


# ══════════════════════════════════════════════════════════════════
#  2. 命名 / 敷衍 / 端点匹配
# ══════════════════════════════════════════════════════════════════
CAMEL_CASES = [
    "", "  ", "---", "planAmount", "plan_amount", "Plan Amount Total",
    " Plan ", "Plan", "PLAN", "plan-amount-total", "采购合同", "a", "A",
    "plan__amount", "_plan_amount_", "plan amount\tid", "planAmount\n",
    "计划_金额", "x", "PlanAmount",
]

PERF_CASES: list[dict[str, Any]] = [
    {"value": "含税，年度累计，CNY", "ai_prefill": "含税，年度累计，CNY"},
    {"value": "口径定义", "column_header": "口径定义"},
    {"value": "  口径定义  ", "column_header": "口径定义"},
    {"value": "待定"},
    {"value": "N/A"},
    {"value": "—"},
    {"value": "无"},
    {"value": "按合同", "column_distinct_ratio": 0.05},
    {"value": "按合同", "column_distinct_ratio": 0.05, "expects_definition": False},
    {"value": "不含税单次结算金额", "expects_definition": True},
    {"value": "不含税", "expects_definition": True},          # 3 字 → TOO_SHORT
    {"value": "不含税结算", "expects_definition": True},
    {"value": "", "expects_definition": True},                 # 空值不算 TOO_SHORT
    {"value": "", "column_header": "", "ai_prefill": ""},
    {"value": "是", "expects_definition": False},
    {"value": "🙂🙂🙂🙂", "expects_definition": True},          # 4 个 code point
    {"value": "🙂🙂🙂", "expects_definition": True},
    {"value": "同上", "ai_prefill": "同上", "column_distinct_ratio": 0.1},
]

ENDPOINT_CASES: list[dict[str, Any]] = [
    {"ep": {"operationId": "submitPurchasePlan", "method": "post",
            "path": "/purchase-plans/{id}/submit"}, "name": "purchasePlanHeader"},
    {"ep": {"operationId": "createClmContract", "method": "post", "path": "/contracts"},
     "name": "clmContract"},
    {"ep": {"operationId": "listSuppliers", "method": "get", "path": "/suppliers"},
     "name": "supplier"},
    {"ep": {"operationId": "deleteSupplier", "method": "DELETE", "path": "/suppliers/{id}"},
     "name": "supplier"},
    {"ep": {"operationId": "updateSupplier", "method": "patch", "path": "/suppliers/{id}"},
     "name": "supplierBank"},
    {"ep": {"operationId": "createPlan", "method": "put", "path": "/plans"},
     "name": "采购计划"},
    {"ep": {"operationId": "createPlan", "method": "put", "path": "/plans"},
     "name": "计划", "aliases": ["purchasePlan"]},
    {"ep": {"operationId": "createPlan", "method": "put", "path": "/plans"}, "name": ""},
    {"ep": {"method": "post", "path": "/plans"}, "name": "planHeader"},
    {"ep": {"operationId": "", "path": "", "method": "post"}, "name": "ab"},
    {"ep": {"operationId": "postPlans", "method": 1, "path": "/x"}, "name": "plan"},
    {"ep": {"operationId": "createPurchaseOrder", "method": "post", "path": "/orders"},
     "name": "purchaseOrderLine"},
]


def export_rules() -> dict[str, Any]:
    return {
        "to_camel": [{"in": s, "out": to_camel(s)} for s in CAMEL_CASES],
        "perfunctory_signals": [
            {"in": c, "out": perfunctory_signals(**c)} for c in PERF_CASES
        ],
        "endpoint_matches": [
            {"endpoint": c["ep"], "api_name": c["name"],
             "aliases": list(c.get("aliases", ())),
             "out": endpoint_matches(c["ep"], c["name"], c.get("aliases", ()))}
            for c in ENDPOINT_CASES
        ],
        "policy": [
            {"kind": str(k), "handling": str(v.handling),
             "irreversibility": v.irreversibility,
             "evidence_decidable": v.evidence_decidable}
            for k, v in POLICY.items()
        ],
    }


# ══════════════════════════════════════════════════════════════════
#  3. fixtures —— 复刻设计稿里的「计划金额」双口径场景
# ══════════════════════════════════════════════════════════════════
def xlsx(row: int, snippet: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
                      snippet=snippet, extractor="docling", confidence=0.94)


def ddl(obj: str, snippet: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snippet, extractor="sqlglot", confidence=0.9)


def base_oir() -> OIR:
    o = OIR()
    plan = o.add_object(ObjectType(
        rid=make_rid("ot", "purchase_plan_header"),
        api_name=extracted("purchasePlanHeader", xlsx(2, "采购业务计划头")),
        display_name=extracted("采购业务计划头", xlsx(2, "采购业务计划头")),
        primary_key=inferred(["pt_plan_id"]),
    ))
    contract = o.add_object(ObjectType(
        rid=make_rid("ot", "clm_contract"),
        api_name=extracted("clmContract", ddl("clm_contract", "CREATE TABLE clm_contract")),
        display_name=extracted("采购合同", xlsx(44, "采购合同")),
        primary_key=inferred(["pt_contract_id"]),
    ))
    o.add_property(PropertyType(
        rid="pt_plan_id", parent=plan.rid,
        api_name=extracted("planId", xlsx(2, "planId")),
        display_name=extracted("计划编号", xlsx(2, "计划编号")),
        base_type=extracted(BaseType.STRING, ddl("pbp_header", "plan_id VARCHAR(32)")),
        definition=extracted("主键", xlsx(2, "主键")),
    ))
    o.add_property(PropertyType(
        rid="pt_contract_id", parent=contract.rid,
        api_name=extracted("contractId", ddl("clm_contract", "contract_id VARCHAR(32)")),
        display_name=extracted("合同编号", ddl("clm_contract", "contract_id")),
        base_type=extracted(BaseType.STRING, ddl("clm_contract", "contract_id VARCHAR(32)")),
        definition=extracted("主键", ddl("clm_contract", "PRIMARY KEY")),
    ))
    # ★ 同名同类型，只有口径不同 —— 纯 schema 比对发现不了
    o.add_property(PropertyType(
        rid="pt_plan_amount_budget", parent=plan.rid,
        api_name=extracted("planAmount", xlsx(44, "planAmount")),
        display_name=extracted("计划金额", xlsx(44, "计划金额")),
        base_type=extracted(BaseType.DECIMAL, xlsx(44, "DECIMAL(18,2)")),
        definition=extracted("含税，年度累计，CNY", xlsx(44, "计划金额（含税，年度累计）")),
        owner="王明",
    ))
    o.add_property(PropertyType(
        rid="pt_plan_amount_contract", parent=contract.rid,
        api_name=extracted("planAmount", ddl("clm_contract", "plan_amount")),
        display_name=extracted("计划金额", ddl("clm_contract", "plan_amount")),
        base_type=extracted(BaseType.DECIMAL, ddl("clm_contract", "DECIMAL(18,2)")),
        definition=extracted("不含税，单次，CNY", ddl("clm_contract", "-- 不含税·单次")),
        owner="李强",
    ))
    o.add_link(LinkType(
        rid="lt_plan_contract",
        api_name=extracted("planContracts", ddl("clm_contract", "FOREIGN KEY (plan_id)")),
        source=plan.rid, target=contract.rid,
        cardinality=extracted(Cardinality.ONE_TO_MANY, ddl("clm_contract", "FK")),
        join_key=extracted({"fromProp": "pt_plan_id", "toProp": "pt_contract_id"},
                           ddl("clm_contract", "REFERENCES pbp_header(plan_id)")),
    ))
    return o


def _prop(o: OIR, rid: str, parent: str, api: str, defn: str,
          base: str = BaseType.DECIMAL, disp: str = "计划金额") -> None:
    p = xlsx(9, defn)
    o.add_property(PropertyType(
        rid=rid, parent=parent, api_name=extracted(api, p),
        display_name=extracted(disp, p), base_type=extracted(base, p),
        definition=extracted(defn, p)))


def two_defs(a: str, b: str) -> OIR:
    """两条同名属性，只有口径不同。**故意不挂父对象** —— 复刻 Python 测试里
    直接往 o.properties 里塞的写法（detect_semantic_divergence 不看父对象）。"""
    o = OIR()
    for rid, defn in (("p1", a), ("p2", b)):
        p = xlsx(9, defn)
        o.properties[rid] = PropertyType(
            rid=rid, parent="ot_x", api_name=extracted("planAmount", p),
            display_name=extracted("计划金额", p),
            base_type=extracted(BaseType.DECIMAL, p), definition=extracted(defn, p))
    return o


def messy_oir() -> OIR:
    """判据"写宽了"的反向样本：一堆看起来可疑但**不该**报冲突的东西，
    外加每类规则各一条真该报的。"""
    o = OIR()
    good = o.add_object(ObjectType(
        rid="ot_good", api_name=extracted("purchasePlan", xlsx(1, "x")),
        display_name=extracted("采购计划", xlsx(1, "x")),
        primary_key=inferred(["pt_ok"])))
    bad = o.add_object(ObjectType(
        rid="ot_bad", api_name=extracted("采购合同", xlsx(2, "y")),
        display_name=extracted("采购合同", xlsx(2, "y")),
        primary_key=inferred([])))          # 未声明主键
    o.add_object(ObjectType(
        rid="ot_abbr", api_name=extracted("po", xlsx(3, "z")),
        display_name=extracted("采购订单", xlsx(3, "z")),
        primary_key=inferred(["pt_ok"])))   # 3 字以内 + 未登记 → 疑似缩写
    _prop(o, "pt_ok", good.rid, "planId", "计划编号，主键", BaseType.STRING, "计划编号")
    _prop(o, "pt_snake", good.rid, "plan_amount", "含税，年度累计", BaseType.DECIMAL)
    o.add_property(PropertyType(
        rid="pt_nodef", parent=bad.rid,
        api_name=extracted("contractAmount", xlsx(5, "w")),
        display_name=extracted("", xlsx(5, "w")),        # 缺显示名
        base_type=extracted(BaseType.DECIMAL, xlsx(5, "w")),
        definition=inferred("   "),                       # 缺口径（全空白）
        owner="李强"))
    o.add_action(ActionType(
        rid="at_submit", api_name=extracted("submitPlan", xlsx(6, "s")),
        applies_to=["ot_good"]))
    return o


def dump_oir(o: OIR) -> dict[str, Any]:
    """比 to_dict 窄的快照 —— 只留对齐/自动修真正会动的字段，diff 才读得懂。"""
    return {
        "objects": [
            {"rid": x.rid, "apiName": x.api_name.value,
             "apiNameOrigin": str(x.api_name.origin),
             "displayName": x.display_name.value, "aliases": list(x.aliases),
             "properties": list(x.properties), "conflicts": list(x.conflicts)}
            for x in o.objects.values()
        ],
        "properties": [
            {"rid": x.rid, "parent": x.parent, "apiName": x.api_name.value,
             "apiNameOrigin": str(x.api_name.origin),
             "definition": x.definition.value, "conflicts": list(x.conflicts)}
            for x in o.properties.values()
        ],
        "links": [
            {"rid": x.rid, "from": x.source, "to": x.target,
             "apiName": x.api_name.value, "conflicts": list(x.conflicts)}
            for x in o.links.values()
        ],
        "actions": [
            {"rid": x.rid, "apiName": x.api_name.value,
             "apiNameOrigin": str(x.api_name.origin),
             "appliesTo": list(x.applies_to)}
            for x in o.actions.values()
        ],
    }


def norm_conflict(c: Conflict) -> dict[str, Any]:
    """把 summary 里那段**顺序不稳定**的轴描述归一掉。

    见模块 docstring：``axis_diff`` 走的是 set 推导，键序随进程哈希种子变化。
    TS 侧照同样的规则归一，比的是内容而不是那个本来就不存在的顺序。
    """
    d = c.to_dict()
    if c.kind is not ConflictKind.SEMANTIC_DIVERGENCE:
        return d
    head, sep, axes = d["summary"].partition("）：")
    assert sep, d["summary"]
    d["summary"] = None
    d["summary_head"] = head + sep
    # "差在这几处：…" 分支是 undescribed_diff 的输出，顺序确定，原样保留
    d["summary_axes"] = ([axes] if axes.startswith("差在这几处：")
                         else sorted(axes.split("、")))
    return d


ENDPOINTS = [
    {"operationId": "submitPurchasePlan", "method": "post",
     "path": "/purchase-plans/{id}/submit", "pointer": "$.paths./purchase-plans"},
    {"operationId": "createClmContract", "method": "post", "path": "/contracts"},
    {"operationId": "listSuppliers", "method": "get", "path": "/suppliers"},
]


def export_detectors() -> dict[str, Any]:
    out: dict[str, Any] = {}

    # ── 口径分歧：真该报的 ──────────────────────────────────────
    out["semantic_divergence_base"] = [
        norm_conflict(c) for c in detect_semantic_divergence(base_oir())]

    # ── 口径分歧：判据宽窄的两个方向 ────────────────────────────
    div_cases = [
        # 认得出轴 → 报轴
        ("known_axis", "本次采购的计划金额，指含税总价", "计划金额按不含税口径统计"),
        # 认不出轴但字面不同 → 报"差在哪几个字"，并明说判不出维度
        ("unknown_axis", "计划金额取工艺路线上首道工序的产能上限",
         "计划金额取末道工序的产能下限"),
        # 字面一模一样 → 必须闭嘴（写宽了就是这里刷噪声）
        ("identical", "含税总价", "含税总价"),
        # 只有标点不同 → _norm_text 归一后相同，同样闭嘴
        ("punctuation_only", "含税、年度累计。", "含税，年度累计"),
        # 一边识别不出 → 不是矛盾，是信息缺失，axis_diff 空 → 走字面分支
        ("one_sided", "含税，年度累计", "金额"),
        # 两边都空 → _widest_pair 返回 (None, None) → 不报
        ("both_empty", "", ""),
        # 一边空一边有 → 字面分支能分开
        ("half_empty", "", "含税"),
        # 真实 LLM 长口径
        ("real_llm", REAL_A, REAL_B),
    ]
    out["semantic_divergence_cases"] = [
        {"name": n, "a": a, "b": b,
         "out": [norm_conflict(c) for c in detect_semantic_divergence(two_defs(a, b))]}
        for n, a, b in div_cases
    ]

    # 三处同名 → 聚成一条，不按两两配对
    o3 = OIR()
    for rid, defn in (("p1", "含税，年度累计"), ("p2", "不含税，单次"),
                      ("p3", "含税，年度累计")):
        p = xlsx(9, defn)
        o3.properties[rid] = PropertyType(
            rid=rid, parent="ot_x", api_name=extracted("planAmount", p),
            display_name=extracted("计划金额", p),
            base_type=extracted(BaseType.DECIMAL, p), definition=extracted(defn, p))
    out["semantic_divergence_three"] = [
        norm_conflict(c) for c in detect_semantic_divergence(o3)]

    # ── 其余规则检测器 ──────────────────────────────────────────
    m = messy_oir()
    out["naming_messy"] = [norm_conflict(c) for c in detect_naming(m)]
    out["naming_with_dictionary"] = [
        norm_conflict(c) for c in detect_naming(messy_oir(), dictionary=["po"])]
    out["missing_required_messy"] = [
        norm_conflict(c) for c in detect_missing_required(messy_oir())]
    out["orphans_messy"] = [norm_conflict(c) for c in detect_orphans(messy_oir())]
    out["orphans_base"] = [norm_conflict(c) for c in detect_orphans(base_oir())]

    out["missing_actions_base"] = [
        norm_conflict(c) for c in detect_missing_actions(base_oir(), ENDPOINTS)]
    out["missing_actions_no_endpoints"] = [
        norm_conflict(c) for c in detect_missing_actions(base_oir(), None)]
    out["missing_actions_get_only"] = [
        norm_conflict(c) for c in detect_missing_actions(
            base_oir(), [{"operationId": "listPlans", "method": "get", "path": "/p"}])]
    out["missing_actions_all_covered"] = [
        norm_conflict(c) for c in detect_missing_actions(messy_oir(), ENDPOINTS)]

    out["type_mismatch"] = [
        norm_conflict(c) for c in detect_type_mismatch(base_oir(), {
            "pt_plan_amount_budget": {"inferred_type": "STRING", "sample_size": 1200},
            "pt_plan_id": {"inferred_type": "STRING"},          # 与声明一致 → 不报
            "pt_contract_id": {"inferred_type": "INTEGER"},     # 无 sample_size → "?"
            "pt_ghost": {"inferred_type": "STRING"},            # OIR 里没有 → 跳过
            "pt_plan_amount_contract": {"sample_size": 5},      # 无 inferred_type → 跳过
        })]

    out["perfunctory"] = [norm_conflict(c) for c in detect_perfunctory([
        {"rid": "pt_a", "field": "口径定义", "value": "口径定义",
         "column_header": "口径定义", "owner": "王明"},
        {"rid": "pt_b", "field": "口径定义", "value": "不含税，单次结算", "owner": "李强"},
        {"rid": "pt_c", "value": "待定"},                        # 无 field / 无 owner
        {"rid": "pt_d", "field": "责任人", "value": "王明",
         "expects_definition": False, "column_distinct_ratio": 0.02},
    ])]

    # ── detect_all：顺序 + 反向挂载 ─────────────────────────────
    full = base_oir()
    all_cs = detect_all(full, endpoints=ENDPOINTS, profiles={
        "pt_plan_amount_budget": {"inferred_type": "STRING", "sample_size": 1200}},
        dictionary=["po"], returned_cells=[
            {"rid": "pt_plan_id", "field": "口径定义", "value": "待定", "owner": "王明"}])
    out["detect_all_base"] = {
        "conflicts": [norm_conflict(c) for c in all_cs],
        "oir_after": dump_oir(full),
    }

    messy_full = messy_oir()
    messy_cs = detect_all(messy_full)
    out["detect_all_messy"] = {
        "conflicts": [norm_conflict(c) for c in messy_cs],
        "oir_after": dump_oir(messy_full),
    }

    # ── auto_repair：边界要保守 ─────────────────────────────────
    rep = messy_oir()
    rep_cs = detect_naming(rep)
    out["auto_repair_naming"] = {
        "log": auto_repair(rep, rep_cs),
        "oir_after": dump_oir(rep),
    }
    div = base_oir()
    out["auto_repair_divergence_is_noop"] = {
        "log": auto_repair(div, detect_semantic_divergence(div)),
        "oir_after": dump_oir(div),
    }
    return out


# ══════════════════════════════════════════════════════════════════
#  4. 实体对齐
# ══════════════════════════════════════════════════════════════════
TOKEN_CASES = [
    "", "purchasePlanHeader", "plan_amount", "头", "采购计划头", "采购计划",
    "pbpHeader", "pbp_header", "PurchasePlan", "purchase plan/header",
    "采购需求计划", "明细行", "clmContract", "a", "ab", "abc",
    "采购计划-Header", "订单Line明细", "PO", "计划金额Amount",
]


def _al_x(snip: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "S", "row": 2, "col": "C"},
                      snippet=snip, extractor="docling")


def _al_d(obj: str, snip: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snip, extractor="sqlglot")


def _al_obj(rid: str, api: str, disp: str, ev: Provenance,
            aliases: tuple[str, ...] = ()) -> ObjectType:
    return ObjectType(rid=rid, api_name=extracted(api, ev),
                      display_name=extracted(disp, ev),
                      primary_key=inferred([]), aliases=list(aliases))


def _al_prop(o: OIR, rid: str, parent: str, api: str,
             base: str = BaseType.STRING) -> None:
    o.add_property(PropertyType(
        rid=rid, parent=parent, api_name=extracted(api, _al_x(api)),
        display_name=extracted(api, _al_x(api)),
        base_type=extracted(base, _al_x(api)), definition=extracted("", _al_x(api))))


def scen_merge() -> OIR:
    """DDL 的 pbpHeader 和梳理表的 purchasePlanHeader 是同一个东西。"""
    o = OIR()
    a = o.add_object(_al_obj("ot_a", "pbpHeader", "采购业务计划头",
                             _al_d("pbp_header", "CREATE TABLE pbp_header")))
    b = o.add_object(_al_obj("ot_b", "purchasePlanHeader", "采购需求计划",
                             _al_x("采购需求计划"), aliases=("pbpHeader",)))
    for rid, parent, api in [("p1", a.rid, "planId"), ("p2", a.rid, "planAmount"),
                             ("p3", b.rid, "planId"), ("p4", b.rid, "planAmount")]:
        _al_prop(o, rid, parent, api)
    return o


def scen_election() -> OIR:
    o = OIR()
    biz = o.add_object(_al_obj("ot_biz", "purchasePlan", "采购计划", _al_x("采购计划")))
    phys = o.add_object(_al_obj("ot_phys", "pbpHeader", "采购业务计划头",
                                _al_d("pbp_header", "CREATE TABLE")))
    _al_prop(o, "p1", biz.rid, "planId")
    _al_prop(o, "p2", phys.rid, "planId")
    _al_prop(o, "p3", biz.rid, "planAmount")
    _al_prop(o, "p4", phys.rid, "planAmount")
    return o


def scen_not_merged() -> OIR:
    """名字像但结构对不上 —— 错误合并会把两个对象的属性混在一起，之后极难拆开。"""
    o = OIR()
    a = o.add_object(_al_obj("ot_a", "purchasePlan", "采购计划", _al_x("采购计划")))
    b = o.add_object(_al_obj("ot_b", "purchasePlanTemplate", "采购计划模板", _al_x("模板")))
    _al_prop(o, "p1", a.rid, "planId")
    _al_prop(o, "p2", a.rid, "planAmount")
    _al_prop(o, "p3", b.rid, "templateId")
    _al_prop(o, "p4", b.rid, "layoutJson")
    return o


def scen_no_structure() -> OIR:
    o = OIR()
    o.add_object(_al_obj("ot_a", "purchasePlan", "采购计划", _al_x("A")))
    o.add_object(_al_obj("ot_b", "purchasePlan", "采购计划", _al_d("t", "B")))
    return o


def scen_alias_only() -> OIR:
    o = OIR()
    o.add_object(_al_obj("ot_a", "pbpHeader", "采购业务计划头", _al_d("t", "x")))
    o.add_object(_al_obj("ot_b", "purchasePlanHeader", "采购需求计划", _al_x("y"),
                         aliases=("pbpHeader",)))
    return o


def scen_transitive() -> OIR:
    o = OIR()
    for i, (rid, api) in enumerate([("ot_a", "pbpHeader"), ("ot_b", "purchasePlanHeader"),
                                    ("ot_c", "planHeader")]):
        o.add_object(_al_obj(rid, api, "采购计划头",
                             _al_d("t", api) if i == 0 else _al_x(api)))
        for f in ("planId", "planAmount", "planName"):
            _al_prop(o, f"{rid}_{f}", rid, f)
    return o


def scen_repoint() -> OIR:
    o = OIR()
    a = o.add_object(_al_obj("ot_a", "pbpHeader", "计划头", _al_d("t", "x")))
    b = o.add_object(_al_obj("ot_b", "purchasePlanHeader", "计划头", _al_x("y")))
    c = o.add_object(_al_obj("ot_c", "clmContract", "采购合同", _al_d("c", "z")))
    _al_prop(o, "p1", a.rid, "planId")
    _al_prop(o, "p2", b.rid, "planId")
    _al_prop(o, "p3", a.rid, "planAmount")
    _al_prop(o, "p4", b.rid, "planAmount")
    _al_prop(o, "p5", c.rid, "contractId")
    ev = _al_d("clm", "FK")
    o.add_link(LinkType(rid="lt", api_name=extracted("planContracts", ev),
                        source="ot_b", target="ot_c",
                        cardinality=extracted("ONE_TO_MANY", ev), join_key=inferred(None)))
    o.add_action(ActionType(rid="at", api_name=extracted("submitPlan", ev),
                            applies_to=["ot_b", "ot_c"]))
    return o


def scen_nothing_common() -> OIR:
    o = OIR()
    for rid, api in [("ot_a", "purchasePlan"), ("ot_b", "supplierBank"),
                     ("ot_c", "taxCode")]:
        o.add_object(_al_obj(rid, api, api, _al_x(api)))
    return o


def scen_thresholds() -> OIR:
    o = OIR()
    a = o.add_object(_al_obj("ot_a", "purchasePlan", "采购计划", _al_x("A")))
    b = o.add_object(_al_obj("ot_b", "purchasePlanV2", "采购计划V2", _al_x("B")))
    _al_prop(o, "p1", a.rid, "planId")
    _al_prop(o, "p2", b.rid, "planId")
    return o


def scen_pk_types() -> OIR:
    """主键类型一致要给结构分加 0.2，且 min(1.0, …) 要封顶。"""
    o = OIR()
    a = ObjectType(rid="ot_a", api_name=extracted("pbpHeader", _al_d("t", "x")),
                   display_name=extracted("计划头", _al_d("t", "x")),
                   primary_key=inferred(["p1"]))
    b = ObjectType(rid="ot_b", api_name=extracted("purchasePlanHeader", _al_x("y")),
                   display_name=extracted("计划头", _al_x("y")),
                   primary_key=inferred(["p2"]))
    o.add_object(a)
    o.add_object(b)
    _al_prop(o, "p1", "ot_a", "planId")
    _al_prop(o, "p2", "ot_b", "planId")
    return o


def scen_single() -> OIR:
    o = OIR()
    o.add_object(_al_obj("ot_only", "purchasePlan", "采购计划", _al_x("A")))
    return o


def scen_empty() -> OIR:
    return OIR()


ALIGN_SCENARIOS: list[tuple[str, Any, AlignPolicy | None]] = [
    ("merge", scen_merge, None),
    ("election", scen_election, None),
    ("not_merged", scen_not_merged, None),
    ("no_structure", scen_no_structure, None),
    ("alias_only", scen_alias_only, None),
    ("transitive", scen_transitive, None),
    ("repoint", scen_repoint, None),
    ("nothing_common", scen_nothing_common, None),
    ("thresholds_default", scen_thresholds, None),
    ("thresholds_strict", scen_thresholds, AlignPolicy(merge_at=0.99)),
    ("thresholds_loose", scen_thresholds, AlignPolicy(merge_at=0.3)),
    ("no_structural_guard_off", scen_no_structure,
     AlignPolicy(merge_at=0.5, require_structural=False)),
    ("pk_types", scen_pk_types, None),
    ("single", scen_single, None),
    ("empty", scen_empty, None),
]


def dump_result(r: AlignResult) -> dict[str, Any]:
    return {
        "clusters": r.clusters,
        "merged": list(r.merged.items()),      # 插入序有意义，别塌成 dict
        "uncertain": [s.to_dict() for s in r.uncertain],
        "scores": [s.to_dict() for s in r.scores],
        "summary": r.summary(),
    }


def export_align() -> dict[str, Any]:
    out: dict[str, Any] = {
        "tokens": [{"in": s, "out": sorted(tokens(s))} for s in TOKEN_CASES],
        "blocking": [],
        "scenarios": [],
    }
    for name, make, policy in ALIGN_SCENARIOS:
        o = make()
        aligner = EntityAligner(policy)
        objs = list(o.objects.values())
        out["blocking"].append({
            "name": name,
            "pairs": [[a.rid, b.rid] for a, b in aligner._blocking(objs, o)] if objs else [],
        })

        o2 = make()
        result, log = align_and_apply(o2, policy)
        out["scenarios"].append({
            "name": name,
            "policy": None if policy is None else {
                "merge_at": policy.merge_at, "review_at": policy.review_at,
                "require_structural": policy.require_structural},
            "result": dump_result(result),
            "apply_log": log,
            "oir_after": dump_oir(o2),
        })
    return out


# ══════════════════════════════════════════════════════════════════
def write(name: str, payload: dict[str, Any]) -> None:
    path = OUT / name
    path.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8")
    print(f"wrote {path}")


def main() -> None:
    write("onto.conflict.json", {
        "seqmatch": export_seqmatch(),
        "axes": export_axes(),
        "rules": export_rules(),
        "detectors": export_detectors(),
    })
    write("onto.align.json", export_align())


if __name__ == "__main__":
    main()
