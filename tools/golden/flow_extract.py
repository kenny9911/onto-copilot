"""导出 onto/flow_extract.py + onto/flow_edit.py 的 golden。

这两个模块是「从材料里推出一张流程图」的落点：flow_extract 把一段五段式流程说明
拆成节点、按「输出↔触发条件」接边、从业务规则里认出网关；flow_edit 把 FDE 在
对话里说的修改结构化地打进那张图。

**期望值一个都不许手写。** 边的方向、哪条边有依据、哪条是推断补的、网关分支贴的
标签、编辑被拒时的逐字消息 —— 全部从这里导出。手写的期望值是对 Python 行为的猜测，
而这个模块存在的意义正是两侧对得上。

输入全部是本文件里的字面量（其中两段流程说明与 `tests/test_flow.py` 里的 `_REAL`/
`_REAL_PBP` 同源，是 `实体梳理.xlsx!业务规则` 的原文片段，含材料自带的错别字
「执行着」），不读任何外部文件、不涉及时间与随机 —— 重跑两次 shasum 一致。

跑法::

    .venv/bin/python tools/golden/flow_extract.py

产物 ``golden/flow_extract.json``（新文件，不碰任何已有 golden）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.flow import FlowGraph, NodeKind, Stage  # noqa: E402
from ontocopilot.onto.flow_edit import FlowEditError, apply_flow_edit  # noqa: E402
from ontocopilot.onto.flow_extract import (  # noqa: E402
    Gateway,
    ProcessStep,
    apply_scene_titles,
    attach_gateways,
    build_flow,
    gaps_to_questions,
    looks_like_process,
    parse_gateways,
    parse_steps,
    scene_headers,
    stages_by_domain,
    stages_from_groups,
    stages_from_survey,
    survey_stage_groups,
)

GOLDEN = ROOT / "golden"


# ══════════════════════════════════════════════════════════════════
#  输入语料
# ══════════════════════════════════════════════════════════════════
#: 真实材料的原文片段，含它自带的错别字「执行着」。
REAL = """（1）编制集采计划：集中采购专业机构根据集采原则，编制集采计划
触发条件：无（主要以集约化标准和框架到期日进行判断）；
输入：集采计划编制策略及集采计划编制要求，无系统节点；
输出：一级集采计划、二级集采计划、自定义集采计划；
执行者：采购计划员
（2）审核集采计划：对集采计划进行审批，以备注入采购需求计划；
触发条件：集采计划编制已完成，触发集采计划审批；
输入：集采计划
输出：已审批集采计划
执行着：集采部门领导
（3）创建采购需求计划：1）基于已审批集采计划自动注入；
触发条件：1）集采计划审批完成；
输入：1）已审批集采计划；
输出：未审批采购需求计划；
执行者：需求申请人"""

#: 材料原文里「采购需求计划」那一段的四个节点：创建 / 修改 / 取消 / 审批。
REAL_PBP = """（3）创建采购需求计划：基于已审批集采计划自动注入；
触发条件：集采计划审批完成；
输入：已审批集采计划；
输出：未审批采购需求计划；
执行者：需求申请人
（4）修改采购需求计划：如采购需求有变化，可进行修改并审批；
触发条件：采购需求需调整；
输入：数量、金额等调整；
输出：修改后采购需求计划；
执行者：需求申请人
（5）取消采购需求计划：执行采购需求计划取消流程进行取消；
触发条件：无需继续采购；
输入：需求取消；
输出：已取消采购需求计划；
执行者：需求申请人
（6）审批采购需求计划：对已完成编制的采购需求计划进行审批；
触发条件：采购需求计划已编制；
输入：采购需求计划；
输出：已审批采购需求计划；
执行者：需求申请人及部门领导"""

#: 全角数字编号。Python 的 `\\d` 对 str 模式匹配的是 **Unicode Nd**，`（１）` 照样
#: 是一个节点头，`int("１")` 也照样是 1 —— JS 的 `\\d` 只有 ASCII，不钉住这条
#: 就会在中文 Excel 导出的材料上整段丢节点。
FULLWIDTH = """（１）编制集采计划：全角编号的第一个节点
触发条件：无；
输入：编制要求；
输出：一级集采计划、二级集采计划；
执行者：采购计划员
（２）审核集采计划：对集采计划进行审批
触发条件：集采计划编制已完成；
输入：集采计划
输出：已审批集采计划
执行着：集采部门领导"""

#: 行首 `1.` / `2、` 式编号（走 _STEP_HEAD 的第二个分支，带 MULTILINE 的 `^`）。
LINE_HEAD = """1. 编制集采计划：说明一
触发条件：无；
输入：编制要求；
输出：集采计划；
执行者：采购计划员
2、审核集采计划：说明二
触发条件：编制已完成；
输入：集采计划；
输出：已审批集采计划；
执行者：集采部门领导"""

#: **孤零零一个 `\\r`**。Python 的 `re.MULTILINE` 里 `^` 只在 `\\n` 之后匹配，
#: 而 JS 的 `m` 标志把 `\\r` / `\\u2028` / `\\u2029` 也算换行 —— 照 JS 写会凭空
#: 多认出一个节点头，整段文字被从中间劈开。
CR_ONLY = "前言\r1、编制集采计划：说明\n触发条件：无；\n输入：x；\n输出：集采计划；\n执行者：甲"

#: 同一个字段名出现两次（材料里真有）：保留先出现的那个。
DUP_FIELD = """（1）编制集采计划：说明
触发条件：无；
输入：第一次写的输入；
输入：第二次写的输入；
输出：集采计划；
执行者：采购计划员
（2）审核集采计划：说明
触发条件：编制已完成；
输入：集采计划；
输出：已审批集采计划；
执行者：领导"""

#: 首行没有冒号（动作名后面直接跟字段）。
NO_COLON = """（1）编制集采计划
触发条件：无；
输入：编制要求；
输出：集采计划；
执行者：采购计划员
（2）审核集采计划
触发条件：编制已完成；
输入：集采计划；
输出：已审批集采计划；
执行者：领导"""

#: 一个字段都没有的编号列表 —— looks_like_process 必须判 False。
BARE_LIST = "（1）第一点（2）第二点（3）第三点"

#: 一个合并单元格里塞着多个节点全文的那种 700 字段落。
BLOB = (
    "（1）编制集采计划：集中采购专业机构根据集采原则，选取、分析、整合相关项目，"
    "对采购计划、历史采购数据进行系统性梳理与分析，编制集采计划\n"
    "触发条件：无\n输入：策略\n输出：一级集采计划\n执行者：采购计划员\n"
    "（2）审核集采计划：对集采计划进行审批\n触发条件：编制已完成\n"
)

#: 两条上限的证据：
#:   · 节点 4 的触发条件/输入里同时出现三个上游产出 → 只连**前两条**边；
#:   · 节点 1 列了四个并列产物 → 除第一个外只记**两个**到事件的 objects 上。
#: 没有这段语料，`hits[:2]` 和 `outs[1:3]` 这两个切片改成任何数字测试都不会红。
MULTI_HIT = """（1）编制集采计划：说明
输出：一级集采计划、二级集采计划、三级集采计划、自定义集采计划；
执行者：甲
（2）审核集采计划：说明
输入：集采计划；
输出：已审批集采计划；
执行者：乙
（3）创建采购需求计划：说明
输入：已审批集采计划；
输出：未审批采购需求计划；
执行者：丙
（4）汇总台账：说明
触发条件：一级集采计划已生成、已审批集采计划；
输入：未审批采购需求计划；
输出：台账已生成；
执行者：丁"""

#: 300 字的说明 + 200 字的证据片段：`detail[:300]` 与 `snippet[:200]` 两处切片
#: 都要在这里被削到，否则改成任何数字测试都不会红。
LONG_DETAIL = ("（1）编制集采计划：" + "集中采购专业机构根据集约化标准与框架到期日逐项复核" * 20 +
               "\n触发条件：无；\n输入：编制要求；\n输出：集采计划；\n执行者：甲\n"
               "（2）审核集采计划：说明\n输入：集采计划；\n输出：已审批集采计划；\n执行者：乙")

#: 一段里两个节点共同处理的东西只有一个字（「甲表」/「甲册」→「甲」）。
#: `_common_subject` 的 `len(head) >= 2` 在这里才被踩到 —— 一个字的标题
#: （「甲」）在泳道上什么也没说，宁可退回用第一个节点的全名。
#: 两个节点靠 **detail 里的「采购包」** 归到同一个业务域，名字本身认不出域。
ONE_CHAR_SUBJECT = """（1）编制甲表：采购包相关说明
输出：甲表；
执行者：甲
（2）审核甲册：采购包相关说明
输出：甲册；
执行者：乙"""

#: 共同主体恰好两个字（「甲乙」）—— `len(head) >= 2` 的下边界：留下它。
#: 两个节点靠 detail 里的「预算」归到同一个业务域。
TWO_CHAR_SUBJECT = """（1）编制甲乙表：预算相关说明
输出：甲乙表；
执行者：甲
（2）审核甲乙册：预算相关说明
输出：甲乙册；
执行者：乙"""

#: 「已审批**的**集采计划」对上「已审批集采计划」—— `_norm` 把「的了个条份项」
#: 和空白去掉之后才连得上这条边。不去的话这条边退化成一条推断虚线，
#: 而"这条边有没有依据"正是这张图能不能拿去跟客户对的判据。
NORM_MATCH = """（1）审核集采计划：说明
输出：已审批集采计划；
执行者：甲
（2）创建采购需求计划：说明
触发条件：已审批的集采计划已就绪；
输出：未审批采购需求计划；
执行者：乙"""

TEXTS: dict[str, str] = {
    "real": REAL,
    "real_pbp": REAL_PBP,
    "fullwidth": FULLWIDTH,
    "line_head": LINE_HEAD,
    "cr_only": CR_ONLY,
    "dup_field": DUP_FIELD,
    "no_colon": NO_COLON,
    "bare_list": BARE_LIST,
    "blob": BLOB,
    "empty": "",
    "prose": "一段没有编号的散文",
    "prose_flow": "本节说明采购流程的整体设计思路与目标。",
    "multi_hit": MULTI_HIT,
    "long_detail": LONG_DETAIL,
    "one_char_subject": ONE_CHAR_SUBJECT,
    "two_char_subject": TWO_CHAR_SUBJECT,
    "norm_match": NORM_MATCH,
    "one_step": "（1）编制集采计划：说明\n触发条件：无；\n输出：集采计划；",
    "space_head": "  （ 12 ） 编制集采计划 ：说明\n输入：x；\n输出：y；",
}


# ══════════════════════════════════════════════════════════════════
#  1. looks_like_process / parse_steps
# ══════════════════════════════════════════════════════════════════
def sec_parse() -> dict[str, Any]:
    detect = [{"text_key": k, "out": looks_like_process(TEXTS[k])} for k in TEXTS]
    # 非 str 输入：`str(text or "")` 把 None / 0 都变成空串。
    detect.append({"text": None, "out": looks_like_process(None)})  # type: ignore[arg-type]

    steps: list[dict[str, Any]] = []
    for key, cite, fname in (
        ("real", "业务规则!A14", ""),
        ("real", "", ""),
        ("real_pbp", "业务规则!A14", "实体梳理.xlsx"),
        ("fullwidth", "业务规则!A14", ""),
        ("line_head", "R1-1", ""),
        ("cr_only", "R1-1", ""),
        ("dup_field", "R1-1", ""),
        ("no_colon", "R1-1", ""),
        ("bare_list", "", ""),
        ("blob", "", ""),
        ("empty", "", ""),
        ("prose", "", ""),
        ("multi_hit", "业务规则!A14", ""),
        ("long_detail", "实体梳理.xlsx!业务规则!R14-14", "实体梳理.xlsx"),
        ("one_char_subject", "A1", ""),
        ("two_char_subject", "A1", ""),
        ("norm_match", "A1", ""),
        ("one_step", "", ""),
        ("space_head", "", ""),
    ):
        got = parse_steps(TEXTS[key], cite=cite, file_name=fname)
        steps.append({"text_key": key, "cite": cite, "file_name": fname,
                      "steps": [s.to_dict() for s in got]})
    return {"looks_like_process": detect, "parse_steps": steps}


# ══════════════════════════════════════════════════════════════════
#  2. 建图
# ══════════════════════════════════════════════════════════════════
#: (标签, 文本键, 阶段来源, 阶段来源参数, file_name)
#: 阶段来源：none / groups / survey / domain
_BUILDS: list[tuple[str, str, str, Any, str]] = [
    ("real_groups", "real", "groups",
     [["阶段一｜集采", [1, 2]], ["阶段二｜需求", [3]]], "实体梳理.xlsx"),
    ("real_no_stage", "real", "none", None, "x.xlsx"),
    ("real_partial_stage", "real", "groups", [["只覆盖前两个", [1, 2]]], "x.xlsx"),
    ("real_domain", "real", "domain", None, "x.xlsx"),
    ("real_pbp_no_stage", "real_pbp", "none", None, "x.xlsx"),
    ("real_pbp_domain", "real_pbp", "domain", None, "x.xlsx"),
    ("real_pbp_survey", "real_pbp", "survey",
     [["采购需求计划创建", [3, 4]], ["采购需求计划收尾", [5, 6]]], "x.xlsx"),
    ("fullwidth_no_stage", "fullwidth", "none", None, "x.xlsx"),
    ("dup_field_no_stage", "dup_field", "none", None, "x.xlsx"),
    ("empty_no_stage", "empty", "none", None, "x.xlsx"),
    ("multi_hit_no_stage", "multi_hit", "none", None, "x.xlsx"),
    ("multi_hit_domain", "multi_hit", "domain", None, "x.xlsx"),
    ("long_detail_no_stage", "long_detail", "none", None, "实体梳理.xlsx"),
    ("norm_match_no_stage", "norm_match", "none", None, "x.xlsx"),
]


def _stage_source(kind: str, param: Any, steps: list[ProcessStep],
                  ) -> tuple[FlowGraph | None, dict[int, str]]:
    if kind == "none":
        return None, {}
    if kind == "groups":
        return stages_from_groups({title: list(nos) for title, nos in param})
    if kind == "survey":
        return stages_from_survey([(title, list(nos)) for title, nos in param])
    if kind == "domain":
        return stages_by_domain(steps)
    raise AssertionError(kind)


def sec_build() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for label, text_key, kind, param, fname in _BUILDS:
        steps = parse_steps(TEXTS[text_key], cite="业务规则!A14")
        g, mapping = _stage_source(kind, param, steps)
        graph = build_flow(steps, stages=mapping or None, file_name=fname, graph=g)
        out.append({
            "label": label, "text_key": text_key, "stage_kind": kind,
            "stage_param": param, "file_name": fname,
            # 映射按节点号排序导出；两侧都按号取，顺序不影响语义
            "mapping": [[no, mapping[no]] for no in sorted(mapping)],
            "graph": graph.to_dict(),
        })
    return out


# ══════════════════════════════════════════════════════════════════
#  3. 阶段：场景标题 / 问卷分组 / 业务域
# ══════════════════════════════════════════════════════════════════
_SCENE_CELLS: list[list[str]] = [
    ["业务场景1", "采购执行计划创建"],
    ["业务场景2", "采购包创建", "业务规则：\n1、…"],
    ["业务场景一：采购执行计划创建（重点覆盖节点6—10）"],
    ["业务场景二：采购包创建（节点11—14）"],
    ["业务场景３", "全角编号的场景"],
    ["业务场景1"],
    ["业务场景1", BLOB],
    ["业务场景1", "这是一段长得不像标题的说明文字，足够超过四十个字符的上限所以不该被当成场景名使用"],
    ["普通单元格", "另一个"],
    [""],
    # 21 个 U+20000 区的生僻字：Python `len()` 数 code point（21 ≤ 40，收下），
    # JS `.length` 数 UTF-16 code unit（42 > 40，会丢掉这个场景名）。
    # 客户材料里的生僻姓氏/地名恰恰住在这一区。
    ["业务场景1", "𠀀" * 21],
]

_SURVEY_SHEETS: list[dict[str, list[str]]] = [
    {"规则问题": ["场景", "业务场景一：采购执行计划创建（重点覆盖节点6—10）",
                "业务场景二：采购包创建（节点11—14）"]},
    {"流程节点问题": ["节点", "（1）编制集采计划", "（2）审批集采计划",
                  "（3）创建采购需求计划", "（4）修改采购需求计划"]},
    {"流程节点问题": ["（1）编制集采计划", "（2）审批集采计划"],
     "规则问题": ["（3）创建采购需求计划"]},
    {"业务规则": [BLOB]},
    {"x": ["一段普通说明", "另一段"]},
    {"混合": ["（2）审批集采计划", "（1）编制集采计划", "（1）编制集采计划"]},
    # 生僻字节点名：Python 数 code point（3+20=23 ≤ 40，是标题），
    # JS 数 UTF-16 code unit（3+40=43 > 40，整个节点被当成正文丢掉）。
    {"生僻字": ["（1）" + "𠀀" * 20, "（2）编制集采计划"]},
    {},
]


def sec_stages() -> dict[str, Any]:
    scenes = [{"cells": cells, "out": scene_headers(cells)} for cells in _SCENE_CELLS]

    survey = []
    for sheets in _SURVEY_SHEETS:
        groups = survey_stage_groups(sheets)
        g, mapping = stages_from_survey([(t, list(n)) for t, n in groups])
        survey.append({
            "sheets": sheets,
            "groups": [[t, list(n)] for t, n in groups],
            "stages": [Stage.to_dict(st) if hasattr(Stage, "to_dict")
                       else {"key": st.key, "title": st.title,
                             "subtitle": st.subtitle, "order": st.order}
                       for st in g.stages.values()],
            "mapping": [[no, mapping[no]] for no in sorted(mapping)],
        })

    domain = []
    for key in ("real", "real_pbp", "line_head", "empty", "one_char_subject",
                "two_char_subject"):
        steps = parse_steps(TEXTS[key], cite="业务规则!A14")
        g, mapping = stages_by_domain(steps)
        domain.append({
            "text_key": key,
            "stages": [{"key": st.key, "title": st.title, "subtitle": st.subtitle,
                        "order": st.order} for st in g.stages.values()],
            "mapping": [[no, mapping[no]] for no in sorted(mapping)],
        })

    # apply_scene_titles：只在场景名里真的出现泳道主体词时才改
    applied = []
    for key, scene_list, groups_param in (
        ("real", ["业务场景1｜集采计划编制", "业务场景2｜采购需求计划创建"], None),
        ("real_pbp", ["业务场景1｜采购需求计划全流程"], None),
        ("real", ["完全对不上的场景名"], None),
        ("real", [], None),
        # 两条泳道抢同一个场景：used 保证一个场景只用一次
        ("real_pbp", ["采购需求计划", "采购需求计划"], None),
        # 泳道主体只有一个字 → 不参与匹配（一个字谁都"包含"，会乱贴标题）
        ("real", ["业务场景1｜甲类物资"], [["甲", [1, 2]], ["乙组", [3]]]),
        # 主体恰好两个字 → 参与匹配（`len(subject) < 2` 的下边界）
        ("real", ["业务场景1｜甲乙类物资"], [["甲乙", [1, 2]], ["丙丁", [3]]]),
        # 两条泳道都能命中**同一个**场景：`used` 保证它只被用掉一次
        ("real", ["集采计划与采购需求计划这一整段"], None),
    ):
        steps = parse_steps(TEXTS[key], cite="业务规则!A14")
        if groups_param is not None:
            g, _m = stages_from_groups({t: list(n) for t, n in groups_param})
        else:
            g, _m = stages_by_domain(steps)
        changed = apply_scene_titles(g, scene_list)
        applied.append({
            "text_key": key, "scenes": scene_list, "groups": groups_param,
            "changed": changed,
            "stages": [{"key": st.key, "title": st.title, "subtitle": st.subtitle,
                        "order": st.order} for st in g.stages.values()],
        })

    groups_cases = []
    for param in (
        [["阶段一｜集采", [1, 2]], ["阶段二｜需求", [3]]],
        [["只有一段", []]],
        [],
    ):
        g, mapping = stages_from_groups({t: list(n) for t, n in param})
        groups_cases.append({
            "groups": param,
            "stages": [{"key": st.key, "title": st.title, "subtitle": st.subtitle,
                        "order": st.order} for st in g.stages.values()],
            "mapping": [[no, mapping[no]] for no in sorted(mapping)],
        })

    return {"scene_headers": scenes, "survey_stage_groups": survey,
            "stages_by_domain": domain, "apply_scene_titles": applied,
            "stages_from_groups": groups_cases}


# ══════════════════════════════════════════════════════════════════
#  4. 网关
# ══════════════════════════════════════════════════════════════════
_RULE_TEXTS: list[tuple[str, str]] = [
    ("如调拨库存可满足要求，则不进行采购，如不满足，则创建采购执行计划", "A20"),
    ("如超出XX金额，则采购包创建失败", "A27"),
    ("请如实填写，例如金额、数量", "A1"),
    ("1、根据已审批采购申请进行采购包创建", "A2"),
    ("如果执行计划已经建了但还没审批，可以随时修改", "A3"),
    ("按照采购阶段配置周期（各阶段：采购立项创建、采购包分配、评标、定标），"
     "依据采购需求时间创建；如当前时间、需求时间计算后无法满足要求，则自动预警", "A20"),
    # 「无需」的「需」不是结果引导词 —— 少了否定前瞻，条件会被切成读不懂的半句
    ("如所需服务/物资无需再进行采购，则关闭需求", "A21"),
    ("若金额超过部门权限限额，则需上会评审，否则由部门领导直接审批", "A22"),
    ("如采购物资和，则自动预警", "A23"),          # 半截条件（以「和」收尾）→ 丢弃
    ("如单一来源等，则走特殊流程", "A24"),         # 半截条件（以「等」收尾）→ 丢弃
    ("当采购包已分配，则自动通知供应商；若供应商未响应，则升级处理", "A25"),
    ("一旦合同到期，需重新发起集采计划", "A26"),
    ("如X，则Y", "A28"),                          # 条件不足 3 字 → 丢弃
    ("如金额超限，则不允许提交", "A29"),           # 「不允许」→ 否
    ("如资料齐全，则可以继续下一步", "A30"),        # 「可以/继续」→ 满足
    ("如审批未通过，则驳回申请，反之进入下一环节", "A31"),
    ("", "A32"),
    # 结果短语超过 30 字 → `then[:30]` 削；整条超过 120 字 → `rule_text[:120]` 削
    ("如金额超过部门权限限额，则需要提交上级主管部门以及集团采购委员会进行联合评审"
     "并出具书面意见后方可继续，否则由发起部门自行组织内部评审并留档备查以备后续审计核查",
     "A33"),
    # 条件恰好 3 字（边界：`len(cond) < 3` 丢弃）
    ("如超限额，则驳回", "A34"),
    # 条件只有 2 字 —— `{3,40}` 根本不匹配
    ("如超限，则驳回", "A35"),
    # 「应」也是结果引导词 —— 它藏在「供**应**商」里，条件于是被切成「…且供」。
    # 看着像 bug，是既定行为：改了两边的图对不上。
    ("如采购金额超过部门权限限额且供应商尚未完成资质审查，则暂缓下达", "A36"),
    # 条件 40 字（`{3,40}` 的上限）→ `condition[:36]` 削掉后四个字
    ("如" + "采购物资清单编号" * 5 + "，则暂缓下达", "A37"),
    # 整条超过 120 字 → `rule_text[:120]` 削（它进 Provenance 的 snippet）
    ("如超限额，则驳回并通知申请人" + "、抄送部门领导与合规岗留档备查以便后续审计核查追溯" * 5,
     "A38"),
]


def sec_gateways() -> dict[str, Any]:
    parsed = []
    for text, cite in _RULE_TEXTS:
        gws = parse_gateways(text, cite=cite)
        parsed.append({
            "text": text, "cite": cite,
            "gateways": [{"condition": gw.condition,
                          "branches": [list(b) for b in gw.branches],
                          "cite": gw.cite, "rule_text": gw.rule_text,
                          "to_dict": gw.to_dict()} for gw in gws],
        })

    # attach_gateways：挂到具体节点 / 挂不上（None）/ 空图
    attach: list[dict[str, Any]] = []

    def _record(label: str, graph: FlowGraph, specs: list[tuple[str, str, Any]],
                fname: str) -> None:
        gws: list[tuple[Gateway, int | None]] = []
        for text, cite, node_no in specs:
            got = parse_gateways(text, cite=cite)
            assert got, text
            gws.append((got[0], node_no))
        attach_gateways(graph, gws, file_name=fname)
        attach.append({"label": label,
                       "specs": [[t, c, n] for t, c, n in specs],
                       "file_name": fname, "graph": graph.to_dict()})

    g0 = FlowGraph()
    g0.stages["s"] = Stage(key="s", title="阶段", order=1)
    _record("bare_no_anchor", g0,
            [("如超出XX金额，则采购包创建失败", "A27", None)], "x.xlsx")

    steps = parse_steps(REAL, cite="业务规则!A14")
    g1, mapping = stages_by_domain(steps)
    build_flow(steps, stages=mapping, file_name="x.xlsx", graph=g1)
    _record("anchored", g1,
            [("如调拨库存可满足要求，则不进行采购，如不满足，则创建采购执行计划",
              "A20", 2),
             ("如超出XX金额，则采购包创建失败", "A27", 99)], "x.xlsx")

    g2 = FlowGraph()
    _record("empty_graph", g2, [("如金额超限，则不允许提交", "A29", None)], "")

    return {"parse_gateways": parsed, "attach_gateways": attach}


# ══════════════════════════════════════════════════════════════════
#  5. 缺口 → 问题
# ══════════════════════════════════════════════════════════════════
def sec_gaps() -> list[dict[str, Any]]:
    out = []
    for label, text_key, kind, param in (
        ("real_groups", "real", "groups", [["阶段一｜集采", [1, 2]], ["阶段二｜需求", [3]]]),
        ("real_no_stage", "real", "none", None),
        ("real_pbp_domain", "real_pbp", "domain", None),
        ("empty", "empty", "none", None),
    ):
        steps = parse_steps(TEXTS[text_key], cite="业务规则!A14")
        g, mapping = _stage_source(kind, param, steps)
        graph = build_flow(steps, stages=mapping or None, file_name="x.xlsx", graph=g)
        qs = gaps_to_questions(graph, file_name="x.xlsx")
        out.append({"label": label, "text_key": text_key, "stage_kind": kind,
                    "stage_param": param,
                    "questions": [q.to_dict() for q in qs]})

    # 网关挂上去之后：未标条件的分支 + 推断边计数
    g = FlowGraph()
    g.stages["s"] = Stage(key="s", title="阶段", order=1)
    gws = parse_gateways("如超出XX金额，则采购包创建失败", cite="A27")
    attach_gateways(g, [(gws[0], None)], file_name="x.xlsx")
    out.append({"label": "gateway_only", "text_key": None, "stage_kind": None,
                "stage_param": None,
                "questions": [q.to_dict() for q in gaps_to_questions(g, file_name="x.xlsx")]})
    return out


# ══════════════════════════════════════════════════════════════════
#  6. flow_edit
# ══════════════════════════════════════════════════════════════════
def _edit_graph() -> FlowGraph:
    """和 tests/test_flow.py::_edit_graph 同源：三节点 + 两条泳道。"""
    steps = parse_steps(REAL, cite="业务规则!A14")
    g, mapping = stages_from_groups({"阶段一": [1, 2], "阶段二": [3]})
    return build_flow(steps, stages=mapping, file_name="x.xlsx", graph=g)


#: (标签, [(op, args), …])。连着做几步 —— 幂等/级联要跨步验。
_EDITS: list[tuple[str, list[tuple[str, dict[str, Any]]]]] = [
    ("rename_node", [("rename_node", {"node": "编制集采计划", "label": "编制年度集采计划"})]),
    ("rename_node_twice",
     [("rename_node", {"node": "编制集采计划", "label": "编制年度集采计划"}),
      ("rename_node", {"node": "编制年度集采计划", "label": "编制年度集采计划"})]),
    ("rename_by_rid", [("rename_node", {"node": "fn_act1_编制集采计划", "label": "改过的"})]),
    ("rename_by_code", [("rename_node", {"node": "ACT-CP-DRAFT", "label": "按编号找到的"})]),
    ("rename_fuzzy", [("rename_node", {"node": "创建采购需求", "label": "模糊命中"})]),
    ("rename_not_found", [("rename_node", {"node": "根本没有这个节点", "label": "x"})]),
    ("rename_ambiguous",
     [("add_node", {"kind": "action", "label": "编制月度计划"}),
      ("rename_node", {"node": "编制", "label": "x"})]),
    ("rename_non_string_ref", [("rename_node", {"node": 123, "label": "x"})]),
    # 六个都叫「编制…」：报错里**只列前五个**，第六个不该出现（列表要短到能读）
    ("rename_ambiguous_six",
     [("add_node", {"kind": "action", "label": "编制月度计划"}),
      ("add_node", {"kind": "action", "label": "编制季度计划"}),
      ("add_node", {"kind": "action", "label": "编制年度计划"}),
      ("add_node", {"kind": "action", "label": "编制专项计划"}),
      ("add_node", {"kind": "action", "label": "编制临时计划"}),
      ("rename_node", {"node": "编制", "label": "x"})]),
    ("set_actor", [("set_actor", {"node": "审核集采计划", "actor": "张三"})]),
    ("set_actor_on_event",
     [("set_actor", {"node": "已审批集采计划", "actor": "张三"})]),
    ("set_stage_by_key", [("set_stage", {"node": "创建采购需求计划", "stage": "s1"})]),
    ("set_stage_by_title", [("set_stage", {"node": "创建采购需求计划", "stage": "阶段一"})]),
    ("set_stage_unknown", [("set_stage", {"node": "创建采购需求计划", "stage": "没这个阶段"})]),
    ("add_node_action", [("add_node", {"kind": "action", "label": "临时复核"})]),
    ("add_node_event", [("add_node", {"kind": "event", "label": "集采计划已归档"})]),
    ("add_node_with_stage_and_actor",
     [("add_node", {"kind": "gateway", "label": "金额是否超限", "stage": "阶段二",
                    "actor": "评审组"})]),
    ("add_node_bad_kind", [("add_node", {"kind": "过程", "label": "x"})]),
    ("add_node_bad_stage",
     [("add_node", {"kind": "action", "label": "x", "stage": "没这个阶段"})]),
    ("add_node_twice_same_label",
     [("add_node", {"kind": "action", "label": "临时复核"}),
      ("add_node", {"kind": "action", "label": "临时复核"})]),
    ("connect", [("connect", {"source": "审核集采计划", "target": "创建采购需求计划"})]),
    ("connect_with_label",
     [("connect", {"source": "审核集采计划", "target": "创建采购需求计划",
                   "label": "人工确认"})]),
    ("connect_twice",
     [("connect", {"source": "审核集采计划", "target": "创建采购需求计划"}),
      ("connect", {"source": "审核集采计划", "target": "创建采购需求计划"})]),
    ("connect_missing", [("connect", {"source": "不存在A", "target": "不存在B"})]),
    ("disconnect_then_reconnect",
     [("connect", {"source": "审核集采计划", "target": "创建采购需求计划"}),
      ("disconnect", {"source": "审核集采计划", "target": "创建采购需求计划"})]),
    ("disconnect_nothing",
     [("disconnect", {"source": "审核集采计划", "target": "编制集采计划"})]),
    ("remove_node", [("remove_node", {"node": "审核集采计划"})]),
    ("remove_node_twice",
     [("remove_node", {"node": "审核集采计划"}),
      ("remove_node", {"node": "审核集采计划"})]),
    ("set_branch_label",
     [("connect", {"source": "审核集采计划", "target": "创建采购需求计划"}),
      ("set_branch_label", {"source": "审核集采计划", "target": "创建采购需求计划",
                            "label": "通过"})]),
    ("set_branch_label_no_edge",
     [("set_branch_label", {"source": "审核集采计划", "target": "编制集采计划",
                            "label": "通过"})]),
    ("unknown_op", [("explode_everything", {})]),
    ("missing_kwarg", [("rename_node", {"node": "编制集采计划"})]),
    ("missing_two_kwargs", [("connect", {})]),
    ("unexpected_kwarg",
     [("rename_node", {"node": "编制集采计划", "label": "x", "nope": 1})]),
    ("unexpected_wins_over_missing", [("rename_node", {"nope": 1})]),
]


def sec_edit() -> dict[str, Any]:
    base = _edit_graph()
    cases: list[dict[str, Any]] = []
    for label, ops in _EDITS:
        g = _edit_graph()
        rec: dict[str, Any] = {"label": label, "steps": []}
        for op, args in ops:
            snapshot = g.to_dict()
            try:
                note = apply_flow_edit(g, op, args)
                rec["steps"].append({"op": op, "args": args, "ok": True, "note": note,
                                     "after": g.to_dict()})
            except FlowEditError as exc:
                rec["steps"].append({"op": op, "args": args, "ok": False,
                                     "error": "FlowEditError", "message": str(exc),
                                     # 被拒的编辑必须一个字节都没动
                                     "unchanged": g.to_dict() == snapshot,
                                     "after": g.to_dict()})
            except Exception as exc:  # noqa: BLE001 —— 非 FlowEditError 也要钉住
                rec["steps"].append({"op": op, "args": args, "ok": False,
                                     "error": type(exc).__name__, "message": str(exc),
                                     "unchanged": g.to_dict() == snapshot,
                                     "after": g.to_dict()})
        cases.append(rec)
    return {"base": base.to_dict(), "cases": cases}


def main() -> None:
    data = {
        **sec_parse(),
        "build_flow": sec_build(),
        **sec_stages(),
        **sec_gateways(),
        "gaps_to_questions": sec_gaps(),
        "flow_edit": sec_edit(),
        "texts": TEXTS,
    }
    path = GOLDEN / "flow_extract.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
