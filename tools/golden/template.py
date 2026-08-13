"""导出 onto/template.py + onto/template_edit.py 的 golden —— 给 TS 侧当安全网。

已有的 golden 只钉住了两个角：``pipeline.template.json``（真材料编出来的 spec，
但**没带 conflicts**，所以批注里那部分内容对不上）与 ``xlsx.cells.json``（只有
两张表、没有下拉、没有列宽）。这个脚本补上剩下的：

  1. **conflicts 参与编译**。conflicted 集合决定红角标，notes 决定批注前半段 ——
     不带 conflicts 编出来的 spec 与线上产物差七格。这里把 detect_all 的输出
     一起导出来（TS 侧没有 conflict.py 的移植件，只按 subjects/summary 消费）。
  2. **属性/关系/规则三张表**。真材料里 properties / links / rules 全空，
     `_sheet_properties` / `_sheet_links` / `_sheet_rules` 一行都没被跑到。
  3. **`_Q_COLUMNS` 的自适应性**。三份内容不同的问题集 → 三组不同的列。
     这是"模板列要从证据推出来"这条硬要求的可执行判据：列写死了这里必然红。
  4. **xlsx 的五样样式语义**：填充色、批注、隐藏锚点列、列宽、数据校验（下拉）。
     openpyxl 写出来再用 openpyxl 读回，逐格 dump。
  5. **template_edit 的每一条守卫消息**。消息里有 `sorted(WRITEBACK_FIELDS)`
     这类 Python list repr，一个空格都不能漂 —— 模型要把它转述给用户。

跑法::

    .venv/bin/python tools/golden/template.py

产物 golden/template.json。**字节确定**：输入要么是仓库里的 golden 文件，
要么是本文件里的字面量；xlsx 写到临时目录、只把读回来的内容入库（临时路径不进
产物）。重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from openpyxl import load_workbook  # noqa: E402
from openpyxl.utils import column_index_from_string, get_column_letter  # noqa: E402

from ontocopilot.kernel.ids import fingerprint, sha256_hex  # noqa: E402
from ontocopilot.onto.conflict import detect_all  # noqa: E402
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BaseType,
    BusinessRule,
    Cardinality,
    LinkType,
    ObjectType,
    OpenQuestion,
    PropertyType,
    Provenance,
    Status,
    extracted,
    inferred,
    oir_from_dict,
)
from ontocopilot.onto.template import (  # noqa: E402
    WEIGHTS,
    Cell,
    Role,
    TemplateSpec,
    compile_template,
    write_xlsx,
)
from ontocopilot.onto.template_edit import (  # noqa: E402
    EditError,
    apply_edit,
    reconcile_template,
)

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "golden"


def px(row: int, snip: str) -> Provenance:
    return Provenance("f3", "实体梳理.xlsx",
                      {"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
                      snippet=snip, extractor="docling", confidence=0.94)


def pd_(obj: str, snip: str) -> Provenance:
    return Provenance("f5", "schema.ddl", {"kind": "ddl", "object": obj},
                      snippet=snip, extractor="sqlglot", confidence=0.9)


def _conflicts(cs: list[Any]) -> list[dict[str, Any]]:
    """TS 侧只消费 subjects / summary —— conflict.py 还没移植，导这两样就够。"""
    return [{"rid": c.rid, "kind": str(c.kind), "subjects": list(c.subjects),
             "summary": c.summary} for c in cs]


def _save_text(spec: TemplateSpec) -> str:
    """save() 落盘的文本（indent=1, ensure_ascii=False）。发模板与审回传是两次
    独立的进程调用，格式对不上就是最难查的那类 bug。"""
    return json.dumps(spec.to_dict(), ensure_ascii=False, indent=1)


def _compiled(oir: OIR, cs: list[Any], *, round_no: int = 1,
              with_oir: bool = True) -> dict[str, Any]:
    spec = compile_template(oir, cs, round_no=round_no)
    out = {
        "conflicts": _conflicts(cs),
        "round_no": round_no,
        "spec": spec.to_dict(),
        "stats": spec.stats(),
        # 落盘文本整段入库会让这个文件翻倍，只钉哈希与长度 —— 差一个字节就红。
        "save_sha256": sha256_hex(_save_text(spec)),
        "save_len": len(_save_text(spec)),
    }
    if with_oir:
        # 编译的输入：OIR 在 detect_all 之后（detect_all 会往实体的 conflicts
        # 里追加 rid），TS 侧照这份还原才是同一个起点。
        out["oir"] = oir.to_dict()
    return out


# ══════════════════════════════════════════════════════════════════
#  1. 真材料 + conflicts
# ══════════════════════════════════════════════════════════════════
def export_pipeline() -> dict[str, Any]:
    # 输入就是 golden/pipeline.oir.json 本身（TS 侧直接读那一份，这里不重复入库）
    oir = oir_from_dict(json.loads((OUT / "pipeline.oir.json").read_text("utf-8")))
    cs = detect_all(oir)
    return _compiled(oir, cs, with_oir=False)


# ══════════════════════════════════════════════════════════════════
#  2. 六张表全跑到的 OIR
# ══════════════════════════════════════════════════════════════════
def _rich_oir() -> OIR:
    o = OIR()
    plan = o.add_object(ObjectType(
        rid="ot_purchase_plan_header",
        api_name=extracted("purchasePlanHeader", pd_("pbp_header", "CREATE TABLE pbp_header")),
        display_name=extracted("采购业务计划头", px(2, "采购业务计划头")),
        description=inferred(""),
        primary_key=extracted(["pt_plan_id"], pd_("pbp_header", "PRIMARY KEY")),
        aliases=["pbpHeader", "采购需求计划"], owner="王明"))
    contract = o.add_object(ObjectType(
        rid="ot_clm_contract",
        api_name=extracted("clmContract", pd_("clm_contract", "CREATE TABLE clm_contract")),
        display_name=extracted("采购合同", px(44, "采购合同")),
        description=extracted("采购合同主表", px(44, "采购合同主表")),
        primary_key=inferred([]), owner="李强"))
    # 没有别名的对象：术语表要跳过它（`if not o.aliases: continue`）
    o.add_object(ObjectType(
        rid="ot_supplier", api_name=inferred("supplier"),
        display_name=inferred("供应商"), primary_key=inferred([])))

    for rid, parent, api, disp, owner in [
        ("pt_plan_id", plan.rid, "planId", "计划编号", "王明"),
        ("pt_contract_id", contract.rid, "contractId", "合同编号", None),
    ]:
        o.add_property(PropertyType(
            rid=rid, parent=parent, api_name=extracted(api, px(2, api)),
            display_name=extracted(disp, px(2, disp)),
            base_type=extracted(BaseType.STRING, px(2, "STRING")),
            definition=extracted("主键", px(2, "主键")),
            required=inferred(True), owner=owner))
    # 同名不同口径 —— detect_semantic_divergence 抓的正是这一对
    o.add_property(PropertyType(
        rid="pt_amount_budget", parent=plan.rid,
        api_name=extracted("planAmount", px(44, "planAmount")),
        display_name=extracted("计划金额", px(44, "计划金额")),
        base_type=extracted(BaseType.DECIMAL, px(44, "DECIMAL(18,2)")),
        definition=extracted("含税，年度累计，CNY", px(44, "计划金额（含税，年度累计）")),
        unit=extracted("CNY", px(44, "CNY")), owner="王明"))
    o.add_property(PropertyType(
        rid="pt_amount_contract", parent=contract.rid,
        api_name=extracted("planAmount", pd_("clm_contract", "plan_amount")),
        display_name=extracted("计划金额", pd_("clm_contract", "plan_amount")),
        base_type=extracted(BaseType.DECIMAL, pd_("clm_contract", "DECIMAL(18,2)")),
        # **只让「税」这一条轴不同，别再让时间粒度也不同。**
        # conflict.py 的 axis_diff 用 `pa.keys() & pb.keys()`（集合）拼 summary，
        # 两条轴以上时拼出来的顺序随 PYTHONHASHSEED 变 —— 这个 golden 就会隔一次
        # 跑一个哈希。一条轴的分歧同样能把冲突这条路径跑满，且字节确定。
        definition=extracted("不含税，年度累计，CNY", pd_("clm_contract", "-- 不含税·年度累计")),
        unit=inferred(None), owner="李强"))
    # 父对象查不到的属性：parent 列要回落到 rid 本身
    o.add_property(PropertyType(
        rid="pt_orphan_prop", parent="ot_不存在",
        api_name=inferred("ghost"), display_name=inferred("孤儿字段"),
        base_type=inferred(BaseType.ENUM), definition=inferred("")))

    ev = pd_("clm_contract", "FOREIGN KEY (plan_id)")
    o.add_link(LinkType(rid="lt_plan_contract", api_name=extracted("planContracts", ev),
                        source=plan.rid, target=contract.rid,
                        cardinality=extracted(Cardinality.ONE_TO_MANY, ev),
                        join_key=extracted({"fromProp": "pt_plan_id",
                                            "toProp": "pt_contract_id"}, ev)))
    # source/target 指向不存在的对象：from/to 列要回落到 rid，joinKey 为空
    o.add_link(LinkType(rid="lt_dangling", api_name=inferred("danglingLink"),
                        source="ot_不存在", target="ot_也不存在",
                        cardinality=inferred(Cardinality.MANY_TO_MANY),
                        join_key=inferred(None)))

    o.add_action(ActionType(
        rid="at_submit_plan", api_name=inferred("submitPurchasePlan"),
        applies_to=[plan.rid], effects=inferred(["创建单据", "占用预算"]),
        source_endpoint=inferred({"method": "post", "path": "/purchase-plans/{id}/submit"}),
        status=Status.DRAFT_FROM_API))
    # 只读动作：effects 一列由 _read_only 判成"只读，不改动单据"且锁死
    o.add_action(ActionType(
        rid="at_query_plan", api_name=extracted("queryPlanList", px(60, "queryPlanList")),
        applies_to=[plan.rid, contract.rid], effects=inferred([]),
        source_endpoint=extracted({"method": "get", "path": "/purchase-plans/query",
                                   "display": "计划查询"}, px(60, "GET /purchase-plans/query")),
        status=Status.CONFIRMED))
    # 路径里带 create：即便动词表里有 export 也算写操作（黑名单优先）
    o.add_action(ActionType(
        rid="at_export_create", api_name=inferred("exportAndCreateSnapshot"),
        applies_to=[], effects=inferred([]),
        source_endpoint=inferred({"method": "", "path": "/snapshots/create/export"}),
        status=Status.CONFIRMED))

    o.add_rule(BusinessRule(
        rid="br_amount", statement=extracted("计划金额超过 100 万需二级审批", px(70, "超过 100 万")),
        applies_to=[plan.rid], actor=extracted("采购计划员", px(70, "采购计划员"))))
    # actor 空 + applies_to 指向查不到的 rid：两列都要落到 REQUIRED
    o.add_rule(BusinessRule(
        rid="br_no_actor", statement=inferred("合同必须先于付款生成"),
        applies_to=["ot_不存在"], actor=inferred("")))

    o.add_question(OpenQuestion(
        rid="oq_tax", text=extracted("金额含不含税？", px(80, "金额含不含税？")),
        options=["含税", "不含税"], group="口径", code="1", asked_by="customer"))
    o.add_question(OpenQuestion(
        rid="oq_answered", text=inferred("已经答过的问题"),
        answer=inferred("答过了"), group="口径", code="2", asked_by="customer"))
    return o


def export_rich() -> dict[str, Any]:
    # 先 to_dict → from_dict 走一圈：导出的 oir 就是编译时的那一份，TS 侧还原后
    # 起点完全一致（oir_from_dict 会丢 title_property 这类存不住的字段）。
    oir = oir_from_dict(_rich_oir().to_dict())
    cs = detect_all(oir)
    return _compiled(oir, cs, round_no=3)


# ══════════════════════════════════════════════════════════════════
#  3. 自适应列 —— 「模板列要从证据推出来」的可执行判据
# ══════════════════════════════════════════════════════════════════
def _q_oir(qs: list[OpenQuestion]) -> OIR:
    o = OIR()
    for q in qs:
        o.add_question(q)
    return o


def export_adaptive() -> dict[str, Any]:
    """三份内容不同的问题集 → 三组不同的列。

    列写死了这里必然红：`_Q_COLUMNS` 的六列按"这份材料里这一列到底有没有内容"
    取子集，只有「澄清问题」「答复」是无论如何都出的。
    """
    cases = {
        # 客户问卷：带编号、带参考选项、按流程节点分组，但没有出处
        "questionnaire": [
            OpenQuestion(rid="oq1", text=inferred("一条需求能不能只安排部分数量？"),
                         options=["能", "不能"], group="计划下达", code="A-1",
                         asked_by="customer"),
            OpenQuestion(rid="oq2", text=inferred("超额下达要不要审批？"),
                         options=["要", "不要"], group="计划下达", code="A-2",
                         asked_by="customer"),
        ],
        # 从证据里挖出来的：有出处、有分组，没有编号也没有参考选项
        "mined": [
            OpenQuestion(rid="oq3",
                         text=extracted("「计划金额」的口径是含税还是不含税？",
                                        px(44, "计划金额（含税，年度累计）")),
                         group="口径", asked_by="system"),
        ],
        # 只有正文：除了两列必出列，其余全不出
        "bare": [
            OpenQuestion(rid="oq4", text=inferred("这批单据归谁维护？"), asked_by="system"),
        ],
        # 混合：客户提的排最前（asked_by != "customer" 是排序键的第一位）
        "mixed": [
            OpenQuestion(rid="oq5", text=inferred("系统问的，分组 B"), group="B",
                         asked_by="system"),
            OpenQuestion(rid="oq6", text=inferred("客户问的，分组 Z"), group="Z", code="9",
                         asked_by="customer"),
            OpenQuestion(rid="oq7", text=inferred("系统问的，分组 A"), group="A",
                         asked_by="system"),
        ],
    }
    out: dict[str, Any] = {}
    for name, qs in cases.items():
        oir = _q_oir(qs)
        spec = compile_template(oir)
        sh = next(s for s in spec.sheets if s.name == "02_待澄清问题")
        out[name] = {
            "oir": oir.to_dict(),
            "columns": list(sh.columns),
            "guide": sh.guide,
            "order": [next(iter(r.values())).rid for r in sh.rows],
            "spec": spec.to_dict(),
        }
    return out


# ══════════════════════════════════════════════════════════════════
#  4. 空 OIR —— 空表一律不出，但对象清单永远出
# ══════════════════════════════════════════════════════════════════
def export_empty() -> dict[str, Any]:
    spec = compile_template(OIR())
    return {"spec": spec.to_dict(), "stats": spec.stats(),
            "sheet_names": [s.name for s in spec.sheets]}


# ══════════════════════════════════════════════════════════════════
#  5. Cell 的标量行为
# ══════════════════════════════════════════════════════════════════
def export_cell() -> dict[str, Any]:
    samples = [
        Cell(rid="r1", sheet="s", field="definition", value="含税口径", role=Role.REQUIRED,
             owner="王明", comment="批注", options=None, conflict=True, expects_prose=True),
        Cell(rid="r2", sheet="s", field="note", value="", role=Role.LOCKED),
        Cell(rid="r3", sheet="s", field="没有权重的字段", value="🐍甲乙丙",
             role=Role.PREFILLED, options=["对", "不对"]),
    ]
    return {
        "weights": WEIGHTS,
        "samples": [{"to_dict": c.to_dict(), "weight": c.weight,
                     "prefill_hash": c.prefill_hash,
                     "round_trip": Cell.from_dict(c.to_dict()).to_dict()} for c in samples],
        # from_dict 的缺省：owner/comment/options/conflict/expects_prose 全可省
        "from_dict_minimal": Cell.from_dict(
            {"rid": "r4", "sheet": "s", "field": "f", "value": "v", "role": "locked"}
        ).to_dict(),
    }


# ══════════════════════════════════════════════════════════════════
#  6. xlsx —— 样式即语义
# ══════════════════════════════════════════════════════════════════
def _dump_xlsx(path: Path) -> dict[str, Any]:
    """逐格 dump。比 export_golden.py 的那份多了列宽、边框、对齐、合并、行高、
    下拉的全部属性 —— 那五样"打开 Excel 才看得见"的东西全在这里。"""
    def rgb(color: Any) -> Any:
        v = getattr(color, "rgb", None)
        return v if isinstance(v, str) else None

    wb = load_workbook(path)
    sheets: dict[str, Any] = {}
    for ws in wb.worksheets:
        cells = []
        for row in ws.iter_rows():
            for c in row:
                if c.value is None and not c.comment:
                    continue
                cells.append({
                    "ref": c.coordinate, "value": c.value,
                    "fill": rgb(c.fill.fgColor) if c.fill and c.fill.fgColor else None,
                    "bold": bool(c.font and c.font.bold),
                    "italic": bool(c.font and c.font.italic),
                    "size": c.font.size if c.font else None,
                    "font_color": rgb(c.font.color) if c.font and c.font.color else None,
                    "wrap": c.alignment.wrap_text if c.alignment else None,
                    "valign": c.alignment.vertical if c.alignment else None,
                    "border": {side: [getattr(getattr(c.border, side), "style", None),
                                      rgb(getattr(getattr(c.border, side), "color", None))]
                               for side in ("left", "right", "top", "bottom")},
                    "comment": c.comment.text if c.comment else None,
                })
        # 列宽/隐藏按**逐列**摊开：一个 <col min=3 max=8 width=20/> 元素在 Excel 里
        # 是 C..H 六列都 20，而 openpyxl 的 column_dimensions 只按 min 那一列建键。
        # openpyxl 自己写出来的表每列一个元素（摊开是恒等），exceljs 会把相邻等宽的
        # 列合并成一个元素 —— 不摊开就会把"同一份表"看成两份。
        hidden_cols: list[str] = []
        widths: dict[str, float] = {}
        for key, dim in ws.column_dimensions.items():
            lo = dim.min or column_index_from_string(key)
            hi = dim.max or lo
            for i in range(lo, hi + 1):
                letter = get_column_letter(i)
                if dim.hidden:
                    hidden_cols.append(letter)
                elif dim.width is not None:
                    widths[letter] = dim.width

        sheets[ws.title] = {
            "cells": cells,
            "hidden_cols": hidden_cols,
            "widths": widths,
            "freeze": ws.freeze_panes,
            "merged": [str(r) for r in ws.merged_cells.ranges],
            "row_heights": {str(k): v.height for k, v in ws.row_dimensions.items()
                            if v.height is not None},
            "validations": [{"sqref": str(dv.sqref), "type": dv.type,
                             "formula1": dv.formula1, "allow_blank": dv.allowBlank,
                             "show_error": dv.showErrorMessage,
                             "error_title": dv.errorTitle, "error": dv.error}
                            for dv in ws.data_validations.dataValidation],
        }
    return {"sheet_order": wb.sheetnames, "sheets": sheets}


def export_xlsx() -> dict[str, Any]:
    """两份产物：真材料那份（沿用 xlsx.cells.json 的输入形状）与六表全的富样本。"""
    out: dict[str, Any] = {}

    rich = oir_from_dict(_rich_oir().to_dict())
    cs = detect_all(rich)
    spec = compile_template(rich, cs, round_no=3)
    # 批注 900 字符截断 + 冲突红边框都在这一份里
    long_note = "很长的批注" * 400
    spec.sheets[0].rows[0][spec.sheets[0].columns[0]].comment = long_note
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "rich.xlsx"
        write_xlsx(spec, p, project="ONT-112")
        out["rich"] = {"project": "ONT-112", "round_no": 3,
                       "long_comment_on": [spec.sheets[0].name, spec.sheets[0].columns[0]],
                       "long_comment_in": long_note, "dump": _dump_xlsx(p)}

    empty = compile_template(OIR())
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "empty.xlsx"
        write_xlsx(empty, p, project="")
        out["empty"] = {"project": "", "dump": _dump_xlsx(p)}
    return out


# ══════════════════════════════════════════════════════════════════
#  7. template_edit —— 守卫消息一个字都不能漂
# ══════════════════════════════════════════════════════════════════
def _edit_base() -> OIR:
    o = OIR()
    for i in range(5):
        o.add_object(ObjectType(rid=f"ot_{i}", api_name=inferred(f"obj{i}"),
                                display_name=inferred(f"对象{i}"),
                                primary_key=inferred([]),
                                aliases=["别名甲", "别名乙"] if i < 2 else []))
    return o


#: 每条 case 都从一份全新的 base spec 开始 —— 上一条的副作用不许漏到下一条。
EDIT_CASES: list[tuple[str, list[tuple[str, dict[str, Any]]]]] = [
    ("add_display_column", [("add_column", {"sheet": "01_对象清单", "name": "备注",
                                            "role": "prefilled", "value": "待补",
                                            "comment": "随手记", "owner": "王明"})]),
    ("add_column_with_options", [("add_column", {"sheet": "01_对象清单", "name": "阶段",
                                                 "options": ["初稿", "初稿", "  ", "定稿"]})]),
    ("add_required_without_writeback", [("add_column", {"sheet": "01_对象清单",
                                                        "name": "乱填的必填列",
                                                        "role": "required"})]),
    ("add_duplicate_column", [("add_column", {"sheet": "01_对象清单", "name": "apiName"})]),
    ("add_column_unknown_role", [("add_column", {"sheet": "01_对象清单", "name": "x",
                                                 "role": "readonly"})]),
    ("add_column_bad_options", [("add_column", {"sheet": "01_对象清单", "name": "x",
                                                "options": ["正常", "含,逗号"]})]),
    # 模糊表名：note 里回显的是调用方那个串，写进 Cell.sheet 的却必须是真表名
    ("add_column_fuzzy_sheet", [("add_column", {"sheet": "对象清单", "name": "备注"})]),
    ("add_column_unknown_sheet", [("add_column", {"sheet": "根本不存在的表", "name": "x"})]),
    # G6：同一 (rid, field) 跨表出现两次，by_rid 会塌成一个
    ("add_same_column_to_two_sheets", [("add_column", {"sheet": "01_对象清单", "name": "备注"}),
                                       ("add_column", {"sheet": "05_术语表", "name": "备注"})]),
    ("drop_primary_key", [("drop_column", {"sheet": "01_对象清单", "column": "primaryKey"})]),
    ("drop_anchor", [("drop_column", {"sheet": "01_对象清单", "column": "_oir_rid"})]),
    ("drop_missing_column", [("drop_column", {"sheet": "01_对象清单", "column": "不存在"})]),
    ("drop_until_last", [("drop_column", {"sheet": "05_术语表", "column": "standard"}),
                         ("drop_column", {"sheet": "05_术语表", "column": "aliases"}),
                         ("drop_column", {"sheet": "05_术语表", "column": "correct"})]),
    ("rename_to_no_writeback", [("rename_column", {"sheet": "01_对象清单",
                                                   "old": "description",
                                                   "new": "随便改的名"})]),
    ("rename_prefilled_writeback", [("rename_column", {"sheet": "01_对象清单", "old": "owner",
                                                       "new": "负责人"})]),
    # description → definition：两边都在 WRITEBACK_FIELDS，且 expects_prose 要跟着变
    ("rename_into_prose_field", [("rename_column", {"sheet": "01_对象清单",
                                                    "old": "description",
                                                    "new": "definition"})]),
    ("rename_anchor", [("rename_column", {"sheet": "01_对象清单", "old": "_oir_hash",
                                          "new": "x"})]),
    ("rename_missing", [("rename_column", {"sheet": "01_对象清单", "old": "不存在",
                                           "new": "x"})]),
    ("rename_onto_existing", [("rename_column", {"sheet": "01_对象清单", "old": "owner",
                                                 "new": "displayName"})]),
    ("set_role_ok", [("set_role", {"sheet": "01_对象清单", "column": "displayName",
                                   "role": "required"})]),
    ("set_role_primary_key", [("set_role", {"sheet": "01_对象清单", "column": "primaryKey",
                                            "role": "required"})]),
    ("set_role_no_writeback", [("set_role", {"sheet": "05_术语表", "column": "aliases",
                                             "role": "required"})]),
    ("set_role_anchor", [("set_role", {"sheet": "01_对象清单", "column": "_oir_rid",
                                       "role": "locked"})]),
    ("set_role_missing_column", [("set_role", {"sheet": "01_对象清单", "column": "不存在",
                                               "role": "locked"})]),
    ("set_options_ok", [("set_options", {"sheet": "01_对象清单", "column": "owner",
                                         "options": ["采购部", "财务部", "采购部", " "]})]),
    ("set_options_too_few", [("set_options", {"sheet": "01_对象清单", "column": "owner",
                                              "options": ["只有一个"]})]),
    ("set_options_comma", [("set_options", {"sheet": "01_对象清单", "column": "owner",
                                            "options": ["正常", "含,逗号"]})]),
    ("set_options_quote", [("set_options", {"sheet": "01_对象清单", "column": "owner",
                                            "options": ["正常", '含"引号']})]),
    ("set_options_too_long", [("set_options", {"sheet": "01_对象清单", "column": "owner",
                                               "options": [f"选项{i}" * 6 for i in range(20)]})]),
    ("set_options_missing_column", [("set_options", {"sheet": "01_对象清单",
                                                     "column": "不存在",
                                                     "options": ["甲", "乙"]})]),
    ("set_guide_fuzzy", [("set_guide", {"sheet": "对象清单", "text": "新说明"})]),
    ("reorder_ok", [("reorder_sheets", {"order": ["05_术语表", "01_对象清单"]})]),
    ("reorder_not_permutation", [("reorder_sheets", {"order": ["只有一张"]})]),
    ("unknown_op", [("没有这个操作", {})]),
    # 参数不对：CPython 的 TypeError 文案 TS 侧复现不了，只钉前缀（见 divergences）
    ("missing_required_arg", [("add_column", {"sheet": "01_对象清单"})]),
    ("unexpected_arg", [("set_guide", {"sheet": "01_对象清单", "text": "x", "多余": 1})]),
]


def _digest(spec: TemplateSpec) -> dict[str, Any]:
    """编辑后的形态摘要 + 全量指纹。

    37 个 case 各存一份完整 spec 会让这个文件到 800 KB，而 diff 出来全是噪声。
    指纹（canonical_json 的 sha256 前 16 位，两边同实现）覆盖每一个字段，
    摘要给出人看得懂的那部分 —— 红了能一眼看出红在哪。
    """
    return {
        "fp": fingerprint(spec.to_dict()),
        "round": spec.round,
        "sheets": [{"name": sh.name, "guide": sh.guide, "columns": list(sh.columns),
                    "nrows": len(sh.rows),
                    "first_row": {k: c.to_dict() for k, c in sh.rows[0].items()}
                    if sh.rows else None}
                   for sh in spec.sheets],
    }


def export_edits() -> dict[str, Any]:
    base_oir = _edit_base()
    base = compile_template(base_oir)
    cases = []
    for name, ops in EDIT_CASES:
        spec = TemplateSpec.from_dict(base.to_dict())
        notes: list[str] = []
        err: str | None = None
        for op, args in ops:
            try:
                notes.append(apply_edit(spec, op, args))
            except EditError as exc:
                err = str(exc)
                break
        cases.append({"name": name,
                      "ops": [{"op": op, "args": args} for op, args in ops],
                      "notes": notes, "error": err, "after": _digest(spec)})

    # reconcile：OIR 改了（多一个对象）+ 手改（加一列）+ 重放不上的一条
    oir2 = _edit_base()
    oir2.add_object(ObjectType(rid="ot_new", api_name=inferred("objN"),
                               display_name=inferred("新对象"), primary_key=inferred([])))
    patch_log = [
        {"op": "add_column", "args": {"sheet": "01_对象清单", "name": "备注",
                                      "role": "prefilled"}},
        {"op": "add_column", "args": {"sheet": "根本不存在的表", "name": "x"}},
    ]
    fresh, stale = reconcile_template(oir2, [], patch_log)
    return {
        "base_oir": base_oir.to_dict(),
        "base_spec": base.to_dict(),
        # base_spec 小，落盘文本整段入库 —— save/load 的格式由它钉死
        "base_save_text": _save_text(base),
        "cases": cases,
        "reconcile": {"oir": oir2.to_dict(), "patch_log": patch_log,
                      "after": _digest(fresh), "stale": stale},
    }


def main() -> None:
    obj = {
        "pipeline": export_pipeline(),
        "rich": export_rich(),
        "adaptive": export_adaptive(),
        "empty": export_empty(),
        "cell": export_cell(),
        "xlsx": export_xlsx(),
        "edits": export_edits(),
    }
    OUT.mkdir(exist_ok=True)
    p = OUT / "template.json"
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  template.json {p.stat().st_size} B")


if __name__ == "__main__":
    # `--dump <xlsx>`：用**同一段** openpyxl 代码 dump 任意一份 xlsx。
    # TS 侧写出来的表能不能"在 Excel 里跟 openpyxl 的产物长得一样"，靠的就是
    # 拿这个去比 golden 里的 dump —— vitest 里读回来的是 exceljs 自己的解析器，
    # 只证明 exceljs 自洽，证明不了 openpyxl 也这么看。
    if len(sys.argv) > 2 and sys.argv[1] == "--dump":
        print(json.dumps(_dump_xlsx(Path(sys.argv[2])), ensure_ascii=False, indent=1))
    else:
        main()
