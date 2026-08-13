"""onto/suggest.py 的 golden 导出 —— 给 ts/src/onto/suggest.ts 当安全网。

建议引擎的产物是**给人看的中文长句**，里面拼了计数、对象名、省略号。手写期望值
= 把 f-string 在脑子里重跑一遍，错了还看不出来（一句话读着通顺就以为对了）。

导什么、为什么导它：

* ``split_suffix`` —— ``pbpHeader → ('pbp','header')`` 的驼峰拆分。正则
  ``[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])`` 在两边语义一致，但**结果里的边界情况**
  （全大写、含中文、纯小写、带数字后缀）决定了哪些对象会被认成"头/行"。
* ``technical`` —— ``_TECHNICAL`` 用 ``$`` 锚定后缀。**Python 的 ``$`` 也匹配
  串尾换行之前**（``re.search(r"log$", "orderLog\\n")`` 命中），JS 的 ``$``
  不带 ``m`` 时不匹配。对象名末尾带 ``\\n`` 在从 xlsx 抽出来的材料里非常常见
  （单元格里回车没清干净），照 JS 语义写会漏掉一整类技术表。
* ``cases`` —— 每条规则一个 OIR，外加"全部规则同时命中"的那个：后者才测得到
  **排序（impact×confidence 降序、稳定）与 limit 截断**。
* ``knobs`` —— 同一个 OIR 在不同 ``min_impact`` / ``limit`` 下的产物。
* ``apply`` —— ``apply_suggestion`` 每条分支各一例（含脏输入），
  同时导**执行后的整个 OIR**：只看返回的 ``changed`` 列表测不到
  "EXCLUDE 是标记而不是删除"这条最要紧的性质。

跑法::

    .venv/bin/python tools/golden/onto_suggest.py

输出 ``golden/onto.suggest.json``（新文件，我独占）。输入全是字面量，
重跑两次 shasum 一致。
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BaseType,
    BusinessRule,
    Cardinality,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    RuleKind,
    Status,
    extracted,
    inferred,
    make_rid,
    oir_from_dict,
)
from ontocopilot.onto.suggest import (  # noqa: E402
    _TECHNICAL,
    _split_suffix,
    SuggestionEngine,
    apply_suggestion,
    suggest,
)

GOLDEN = ROOT / "golden"


def prov(ref: str) -> Provenance:
    return Provenance(file_id="f", file_name="材料.xlsx",
                      locator={"kind": "cell", "sheet": "对象", "row": 1, "col": "A"},
                      snippet=ref, extractor="rule", confidence=1.0)


def obj(name: str, *, cited: bool = True, status: Status = Status.CANDIDATE,
        props: list[str] | None = None) -> ObjectType:
    """一个对象。``cited=False`` 用来测 ``_cite`` 的空串会被 walrus 过滤掉
    （``[c for o in xs if (c := _cite(o.api_name))]` 只收非空）。"""
    api = extracted(name, prov(name)) if cited else inferred(name)
    return ObjectType(rid=make_rid("ot", name), api_name=api,
                      display_name=inferred(name), status=status,
                      properties=list(props or []))


def prop(parent: str, name: str) -> PropertyType:
    return PropertyType(rid=make_rid("pt", f"{parent}.{name}"), parent=parent,
                        api_name=inferred(name), display_name=inferred(name),
                        base_type=inferred(BaseType.STRING))


def rule(text: str, *, applies: list[str] | None = None,
         status: Status = Status.CANDIDATE, cited: bool = True) -> BusinessRule:
    st = extracted(text, prov(text)) if cited else inferred(text)
    return BusinessRule(rid=make_rid("br", text), statement=st,
                        kind=inferred(RuleKind.VALIDATION),
                        applies_to=list(applies or []), status=status)


# ══════════════════════════════════════════════════════════════════
#  单元向量
# ══════════════════════════════════════════════════════════════════
SPLIT_CASES = [
    "pbpHeader", "pbpLine", "pbpLines", "pbpDetail", "pbpItems", "pbpRel",
    "ctMapping", "pkgMain", "pkgDtl", "orderMaster",
    "a", "ab", "PBPHEADER", "pbp_header", "pbpHDR", "purchaseOrderDetails",
    "ABCDef", "x1y2", "中文Header", "pbpHeader2", "", "aB", "AB", "aBc",
]

#: ``$`` 与串尾换行的坑集中在这里。前两条是正常命中，第三条 ``orderLog\n``
#: 是 Python 命中 / 朴素 JS 漏掉的那条，最后几条是不该命中的反例。
TECHNICAL_CASES = [
    "orderTmp", "orderLOG", "orderLog\n", "order_log", "订单log", "orderHis",
    "orderBackup", "orderSnapshot", "orderStaging", "orderBatch",
    "order", "tmpOrder", "orderlogx", "orderLog\nx", "logs", "temp",
]


# ══════════════════════════════════════════════════════════════════
#  OIR 用例
# ══════════════════════════════════════════════════════════════════
def oir_empty() -> OIR:
    return OIR()


def oir_head_line() -> OIR:
    """头—行成对但没有关系。

    四组：pbp（该报）、ct（已经有 link 了，不该报）、pkg（该报，rel 角色也在但
    不参与配对）、po（只有头没有行，不该报）。第五组 ord 的头没有出处 ——
    citations 会少一条，但建议照出。
    """
    o = OIR()
    for name in ("pbpHeader", "pbpLine", "ctHeader", "ctLines", "pkgMain",
                 "pkgItems", "pkgRel", "poHeader"):
        o.add_object(obj(name))
    o.add_object(obj("ordHeader", cited=False))
    o.add_object(obj("ordDetails"))
    o.add_link(LinkType(rid="lt_ct", api_name=inferred("ctLines"),
                        source=make_rid("ot", "ctHeader"),
                        target=make_rid("ot", "ctLines"),
                        cardinality=inferred(Cardinality.ONE_TO_MANY)))
    return o


def oir_head_line_many() -> OIR:
    """七组头—行 —— 越过 ``pairs[:3]`` 的省略号阈值和 ``pairs[:6]`` 的
    citations 上限。两个截断位置不同，只用三组测不到。"""
    o = OIR()
    for stem in ("aa", "bb", "cc", "dd", "ee", "ff", "gg"):
        o.add_object(obj(f"{stem}Header"))
        o.add_object(obj(f"{stem}Line"))
    return o


def oir_no_fields() -> OIR:
    """对象抽全了、字段一个没有。三个对象已定义了行动 —— 文案里会多一句
    「其中 N 个对象已经定义了接口却没有字段」。"""
    o = OIR()
    for i in range(6):
        o.add_object(obj(f"bareObject{i}"))
    o.add_action(ActionType(rid="at_1", api_name=inferred("createBare"),
                            applies_to=[make_rid("ot", "bareObject0"),
                                        make_rid("ot", "bareObject1")]))
    o.add_action(ActionType(rid="at_2", api_name=inferred("updateBare"),
                            applies_to=[make_rid("ot", "bareObject2")]))
    return o


def oir_no_fields_no_hot() -> OIR:
    """同样零字段，但没有任何行动 —— ``hot`` 为空，``hot or bare`` 走 bare 分支，
    文案里那句「已经定义了接口」不出现。Python 的空列表是假值，
    TS 写成 ``hot ?? bare`` 会永远走 hot。"""
    o = OIR()
    for i in range(3):
        o.add_object(obj(f"bareObject{i}"))
    return o


def oir_fields_threshold_fires() -> OIR:
    """5 个对象、1 个有字段 → bare=4，``4 < 5*0.8 == 4.0`` 为假 → **出建议**。
    边界恰好落在等号上，用整数除法或 <= 都会翻。"""
    o = OIR()
    for i in range(5):
        o.add_object(obj(f"someObject{i}"))
    p = prop(make_rid("ot", "someObject0"), "code")
    o.add_property(p)
    return o


def oir_fields_threshold_silent() -> OIR:
    """4 个对象、1 个有字段 → bare=3，``3 < 4*0.8 == 3.2`` 为真 → **不出建议**。"""
    o = OIR()
    for i in range(4):
        o.add_object(obj(f"someObject{i}"))
    o.add_property(prop(make_rid("ot", "someObject0"), "code"))
    return o


def oir_technical() -> OIR:
    """技术表。第六个已经标了 REJECTED —— 采纳过的不该再冒出来，
    否则用户会以为没生效然后再点一次。"""
    o = OIR()
    for name in ("orderTmp", "orderLog", "orderHis", "syncJob", "stgOrder",
                 "orderSnapshot"):
        o.add_object(obj(name))
    o.add_object(obj("planLog", status=Status.REJECTED))
    o.add_object(obj("purchaseOrder"))
    return o


def oir_technical_newline() -> OIR:
    """对象名末尾带换行 —— xlsx 单元格里没清干净的回车。Python 的 ``$`` 命中，
    JS 的不带 ``m`` 的 ``$`` 不命中。"""
    o = OIR()
    o.add_object(obj("orderLog\n"))
    o.add_object(obj("planTmp\n"))
    o.add_object(obj("normalObject"))
    return o


def oir_naming() -> OIR:
    """三套命名前缀，每套 ≥3 个 —— 说明这份材料是几个子系统拼出来的。
    另外放两个只有 2 个成员的家族（不计入 big）和一个不匹配前缀正则的名字。"""
    o = OIR()
    for stem, n in (("pbp", 4), ("ct", 3), ("inv", 5), ("sup", 2)):
        for i in range(n):
            o.add_object(obj(f"{stem}Entity{i}"))
    o.add_object(obj("standalone"))
    o.add_object(obj("TOOLONGPREFIXEntity"))
    return o


def oir_naming_one_family() -> OIR:
    """只有一套家族 —— ``len(big) < 2`` 不出建议。"""
    o = OIR()
    for i in range(5):
        o.add_object(obj(f"pbpEntity{i}"))
    return o


def oir_rules() -> OIR:
    """悬空规则。第三条已经挂上了对象、第四条不是 CANDIDATE —— 都不该报。
    statement 里放一条超长的，测 ``statement.value[:120]`` 的 code point 切片。"""
    o = OIR()
    o.add_object(obj("purchaseOrder"))
    o.add_rule(rule("采购金额超过 100 万需要总经理审批"))
    o.add_rule(rule("集采计划一经审批不得修改，只能作废重编"))
    o.add_rule(rule("挂上了对象的规则", applies=[make_rid("ot", "purchaseOrder")]))
    o.add_rule(rule("已经确认过的规则", status=Status.CONFIRMED))
    o.add_rule(rule("长" * 200))
    o.add_rule(rule("没有出处的规则", cited=False))
    return o


def oir_everything() -> OIR:
    """五条规则同时命中 —— 只有这一张图测得到排序与截断。"""
    o = OIR()
    for stem, n in (("pbp", 4), ("ct", 3), ("inv", 3)):
        for i in range(n):
            o.add_object(obj(f"{stem}Entity{i}"))
    for name in ("pbpHeader", "pbpLine", "ctHeader", "ctLines", "invTmp", "invLog",
                 "ctSyncJob"):
        o.add_object(obj(name))
    o.add_action(ActionType(rid="at_1", api_name=inferred("createPbp"),
                            applies_to=[make_rid("ot", "pbpHeader")]))
    for i in range(4):
        o.add_rule(rule(f"悬空规则 {i}"))
    return o


CASES: list[tuple[str, Any]] = [
    ("empty", oir_empty),
    ("head_line", oir_head_line),
    ("head_line_many", oir_head_line_many),
    ("no_fields", oir_no_fields),
    ("no_fields_no_hot", oir_no_fields_no_hot),
    ("fields_threshold_fires", oir_fields_threshold_fires),
    ("fields_threshold_silent", oir_fields_threshold_silent),
    ("technical", oir_technical),
    ("technical_newline", oir_technical_newline),
    ("naming", oir_naming),
    ("naming_one_family", oir_naming_one_family),
    ("rules", oir_rules),
    ("everything", oir_everything),
]

#: ``min_impact`` / ``limit`` 两个旋钮。``min_impact`` 过滤在排序**之前**，
#: 顺序反了会得到不同的 top-N。
KNOBS: list[tuple[int, int]] = [(1, 8), (0, 8), (3, 8), (1, 1), (1, 2), (1, 100),
                                (999, 8)]


# ══════════════════════════════════════════════════════════════════
#  apply_suggestion
# ══════════════════════════════════════════════════════════════════
def apply_base() -> OIR:
    o = OIR()
    for name in ("pbpHeader", "pbpLine", "ctHeader", "ctLines", "orderTmp",
                 "orderLog"):
        o.add_object(obj(name))
    o.add_rule(rule("悬空规则 A"))
    o.add_rule(rule("悬空规则 B"))
    o.add_rule(rule("已确认规则", status=Status.CONFIRMED))
    return o


APPLY_CASES: list[tuple[str, dict[str, Any], str]] = [
    ("add_link_ok", {
        "kind": "ADD_LINK", "title": "补 1 组「头—行」包含关系",
        "payload": {"links": [
            {"source": make_rid("ot", "pbpHeader"), "target": make_rid("ot", "pbpLine"),
             "api_name": "pbpLines", "cardinality": "ONE_TO_MANY"}]},
    }, ""),
    ("add_link_note", {
        "kind": "ADD_LINK", "title": "带 note",
        "payload": {"links": [
            {"source": make_rid("ot", "pbpHeader"), "target": make_rid("ot", "pbpLine"),
             "api_name": "pbpLines", "cardinality": "ONE_TO_MANY"}]},
    }, "FDE 张三在 2026-08-13 拍板"),
    ("add_link_missing_object", {
        "kind": "ADD_LINK", "title": "源对象不存在",
        "payload": {"links": [
            {"source": "ot_ghost", "target": make_rid("ot", "pbpLine"),
             "api_name": "ghostLines", "cardinality": "ONE_TO_MANY"}]},
    }, ""),
    ("add_link_bad_cardinality", {
        # 脏基数字符串 → ValueError → 回落 ONE_TO_MANY，而不是崩。
        "kind": "ADD_LINK", "title": "基数写错",
        "payload": {"links": [
            {"source": make_rid("ot", "ctHeader"), "target": make_rid("ot", "ctLines"),
             "api_name": "ctLines", "cardinality": "many-to-many"}]},
    }, ""),
    ("add_link_lower_cardinality", {
        # 小写但合法 —— .upper() 之后能解析出来。
        "kind": "ADD_LINK", "title": "小写基数",
        "payload": {"links": [
            {"source": make_rid("ot", "ctHeader"), "target": make_rid("ot", "ctLines"),
             "api_name": "ctLines2", "cardinality": "many_to_many"}]},
    }, ""),
    ("add_link_dup", {
        # 两条 spec 的 api_name 相同 → 第二条的 rid 已在 links 里 → 跳过。
        "kind": "ADD_LINK", "title": "重复",
        "payload": {"links": [
            {"source": make_rid("ot", "pbpHeader"), "target": make_rid("ot", "pbpLine"),
             "api_name": "dupLines", "cardinality": "ONE_TO_MANY"},
            {"source": make_rid("ot", "ctHeader"), "target": make_rid("ot", "ctLines"),
             "api_name": "dupLines", "cardinality": "ONE_TO_ONE"}]},
    }, ""),
    ("add_link_no_payload", {"kind": "ADD_LINK", "title": "空载荷"}, ""),
    ("exclude_ok", {
        "kind": "EXCLUDE", "title": "2 个疑似临时/日志表，建议不进本体",
        "payload": {"objects": [make_rid("ot", "orderTmp"), make_rid("ot", "orderLog"),
                                "ot_ghost"]},
    }, ""),
    ("bind_rule_ok", {
        "kind": "BIND_RULE", "title": "2 条业务规则还没挂到对象上",
        "payload": {"rules": [{"rid": make_rid("br", "悬空规则 A")},
                              {"rid": make_rid("br", "已确认规则")},
                              {"rid": "br_ghost"}, {}]},
    }, ""),
    ("unknown_kind", {"kind": "REVIEW", "title": "人工复核",
                      "payload": {"objects": ["ot_x"]}}, ""),
    ("no_kind", {"title": "连 kind 都没有"}, ""),
]


def main() -> None:
    out: dict[str, Any] = {
        "split_suffix": [[s, list(_split_suffix(s)) if _split_suffix(s) else None]
                         for s in SPLIT_CASES],
        "technical": [[s, m is not None, m.group(0) if m else None]
                      for s in TECHNICAL_CASES
                      for m in (_TECHNICAL.search(s),)],
        "cases": [],
        "knobs": [],
        "apply": [],
    }

    for name, build in CASES:
        # 从**还原后**的 OIR 出发：golden 里的输入就是这份 dict，TS 侧也只拿得到它。
        # 直接用原对象的话，两侧之间会隔着一层 oir_from_dict 的往返差异。
        data = build().to_dict()
        o = oir_from_dict(data)
        out["cases"].append({
            "name": name,
            "oir": data,
            "suggest": suggest(o),
            "suggest_limit3": suggest(o, limit=3),
        })

    everything_dict = oir_everything().to_dict()
    out["knobs_oir"] = everything_dict
    everything = oir_from_dict(everything_dict)
    for min_impact, limit in KNOBS:
        eng = SuggestionEngine(min_impact=min_impact, limit=limit)
        out["knobs"].append({
            "min_impact": min_impact, "limit": limit,
            "out": [s.to_dict() for s in eng.propose(everything)],
            # score 是排序主轴，单独导一份 —— 排序错了但结果碰巧一样时它会露馅
            "scores": [s.score for s in eng.propose(everything)],
        })

    for name, sug, note in APPLY_CASES:
        before = apply_base().to_dict()
        o = oir_from_dict(before)
        res = apply_suggestion(o, copy.deepcopy(sug), note=note)
        out["apply"].append({"name": name, "suggestion": sug, "note": note,
                             "oir_before": before, "result": res,
                             "oir_after": o.to_dict()})

    path = GOLDEN / "onto.suggest.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                    encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
