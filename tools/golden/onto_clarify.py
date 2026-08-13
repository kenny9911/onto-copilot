"""onto/clarify.py 的 golden 导出 —— 给 ts/src/onto/clarify.ts 当安全网。

澄清引擎是**纯数值**的：四个因子相乘、和阈值比、排序、截断。数值上差一点点
（log 底数、真除写成整除、归一化漏一处）不会崩，只会让"该问的问题"悄悄变成
"转模板"，而这条路上没有任何报错 —— 所以必须逐个因子钉住，不能只钉最终名次。

导什么、为什么导它：

* ``factors`` —— 每条冲突的 ``eig`` / ``blast`` / ``self_resolvable`` / ``score``
  四个数各导一份。只对最终 ``rank`` 断言的话，两个因子同时算错但乘积碰巧
  过阈值，测试照样绿。
* ``rank`` —— 五种停止路径各一例：上限、阈值、全部问完、一条都不能问、
  以及"能问的比上限多且后几条低于阈值"（两条 break 谁先触发）。
* ``id_slices`` —— ``q_{n}_{c.rid[-8:]}``。倒数切片在 rid 短于 8、含中文、
  含代理对时是三种不同的行为，而 TS 的 ``slice(-8)`` 按 UTF-16 码元切。
* ``apply`` —— ``apply_decision`` 的三种 effect（unify_to / split / set_base_type）
  加找不到选项时的 KeyError **消息原文**（消息里有 ``!r``，两边的 repr 不一样）。

跑法::

    .venv/bin/python tools/golden/onto_clarify.py

输出 ``golden/onto.clarify.json``（新文件，我独占）。重跑两次 shasum 一致。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.clarify import ClarificationEngine, apply_decision  # noqa: E402
from ontocopilot.onto.conflict import (  # noqa: E402
    Conflict,
    ConflictKind,
    Option,
    detect_all,
)
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BaseType,
    Cardinality,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    Status,
    extracted,
    inferred,
    make_rid,
    oir_from_dict,
)

GOLDEN = ROOT / "golden"


def prov(snippet: str, row: int = 1) -> Provenance:
    return Provenance(file_id="f", file_name="材料.xlsx",
                      locator={"kind": "cell", "sheet": "字段", "row": row, "col": "D"},
                      snippet=snippet, extractor="rule", confidence=0.9)


def opt(oid: str, label: str, n_ev: int = 0, **effect: Any) -> Option:
    """带 n 条证据的选项。证据条数是 eig 的权重，也是 self_resolvable 的分母。"""
    return Option(id=oid, label=label,
                  evidence=[prov(f"{oid}#{i}", i) for i in range(n_ev)],
                  effect=dict(effect))


# ══════════════════════════════════════════════════════════════════
#  一张有依赖关系的 OIR —— blast 要真的走 dependents
# ══════════════════════════════════════════════════════════════════
def build_oir() -> OIR:
    o = OIR()
    for name in ("purchasePlan", "purchaseOrder", "supplier"):
        o.add_object(ObjectType(rid=make_rid("ot", name),
                                api_name=extracted(name, prov(name)),
                                display_name=inferred(name)))
    # 同名的 planAmount **只差一个轴**（税），这是有意的：``axis_diff`` 用
    # ``pa.keys() & pb.keys()`` 取交集，**集合的迭代顺序随 PYTHONHASHSEED 变**，
    # 差两个轴时 ``detect_semantic_divergence`` 的 summary（也就是 Question.title，
    # 直接摆在 FDE 面前的那句话）在两次进程之间会换序。这份 golden 必须字节确定，
    # 所以绕开它 —— 但**这是 Python 侧的真问题**，不是我这份导出的问题。
    # ``usedAmount`` 只在计划侧出现（不构成同名分歧），单纯为了让 split 用例
    # 覆盖到 ``_suffix`` 的第四个轴取值 PerTime。
    for parent, name, defn in (
        ("purchasePlan", "planAmount", "口径：含税，年度累计"),
        ("purchasePlan", "planCode", "计划编号"),
        ("purchasePlan", "usedAmount", "口径：单次"),
        ("purchaseOrder", "planAmount", "口径：不含税，年度累计"),
        ("purchaseOrder", "orderCode", "订单编号"),
        ("supplier", "supplierName", ""),
    ):
        o.add_property(PropertyType(
            rid=make_rid("pt", f"{parent}.{name}"), parent=make_rid("ot", parent),
            api_name=extracted(name, prov(name)), display_name=inferred(name),
            base_type=inferred(BaseType.DECIMAL),
            definition=extracted(defn, prov(defn)) if defn else inferred("")))
    o.add_link(LinkType(rid="lt_plan_order", api_name=inferred("planOrders"),
                        source=make_rid("ot", "purchasePlan"),
                        target=make_rid("ot", "purchaseOrder"),
                        cardinality=inferred(Cardinality.ONE_TO_MANY)))
    o.add_action(ActionType(rid="at_create", api_name=inferred("createPlan"),
                            applies_to=[make_rid("ot", "purchasePlan")]))
    return o


#: 从**还原后**的 OIR 出发 —— golden 里的输入就是 ``OIR_DICT``，TS 侧也只拿得到它。
OIR_DICT = build_oir().to_dict()
OIR_MAIN = oir_from_dict(OIR_DICT)
PT_PLAN = make_rid("pt", "purchasePlan.planAmount")
PT_ORDER = make_rid("pt", "purchaseOrder.planAmount")
PT_USED = make_rid("pt", "purchasePlan.usedAmount")
OT_PLAN = make_rid("ot", "purchasePlan")


# ══════════════════════════════════════════════════════════════════
#  冲突样本 —— 每条针对一个打分因子的分支
# ══════════════════════════════════════════════════════════════════
def conflicts() -> dict[str, Conflict]:
    c: dict[str, Conflict] = {}

    #: 事实之争 + 证据势均力敌 → self_resolvable 小、eig 大 → 必问。
    c["balanced"] = Conflict(
        rid="cf_semantic_divergence_balanced", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN, PT_ORDER], summary="「计划金额」口径不一致（2 种口径）",
        options=[opt("unify_a", "统一为 A 口径", 2, unify_to=PT_PLAN),
                 opt("unify_b", "统一为 B 口径", 2, unify_to=PT_ORDER),
                 opt("defer_to_template", "先不定，转成模板必填项", 0, defer=True)])

    #: 一边证据碾压 → self_resolvable 接近上限 0.8 → 得分被大幅打折。
    c["lopsided"] = Conflict(
        rid="cf_semantic_divergence_lopsided", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN, PT_ORDER], summary="一边证据碾压另一边",
        options=[opt("unify_a", "统一为 A 口径", 9, unify_to=PT_PLAN),
                 opt("unify_b", "统一为 B 口径", 1, unify_to=PT_ORDER),
                 opt("defer_to_template", "转模板", 0, defer=True)])

    #: 证据全为 0 → ``sum(counts) == 0`` 的分支 → self_resolvable 回 0。
    c["no_evidence"] = Conflict(
        rid="cf_duplicate_noev", kind=ConflictKind.DUPLICATE,
        subjects=[PT_PLAN, PT_ORDER], summary="两条属性疑似重复，两边都没有出处",
        options=[opt("merge", "合并"), opt("keep", "保留两条")])

    #: 只剩一个非兜底分支 → ``len(branches) < 2`` → eig=0 → 一定被 theta 挡掉。
    c["single_branch"] = Conflict(
        rid="cf_type_mismatch_single", kind=ConflictKind.TYPE_MISMATCH,
        subjects=[PT_PLAN], summary="只有一个真分支",
        options=[opt("use_actual", "改为 STRING", 3, set_base_type="STRING"),
                 opt("keep_declared", "保留 DECIMAL", 0)])

    #: 政策选择：evidence_decidable=False。兜底选项**参与计数**，
    #: self_resolvable 恒 0 —— 「不做」这个分支天生没有证据。
    c["policy"] = Conflict(
        rid="cf_missing_action_policy", kind=ConflictKind.MISSING_ACTION,
        subjects=[OT_PLAN], summary="3 个对象没有任何 ActionType",
        options=[opt("draft_from_openapi", "反推草稿", 5,
                     draft_actions={OT_PLAN: ["createPlan"]}),
                 opt("leave_blank", "留空让业务自己填", 0)])

    #: 一个选项都没有 —— Question 要回落成 ``[Option("defer", "转为模板必填项")]``，
    #: 而 eig 为 0，所以它其实永远进不了 questions。两件事都要钉。
    c["no_options"] = Conflict(
        rid="cf_missing_action_noopt", kind=ConflictKind.MISSING_ACTION,
        subjects=[OT_PLAN], summary="没有任何选项")

    #: subjects 指向不存在的 rid —— dependents 返回空，blast 仍然算 1（自己）。
    c["ghost_subject"] = Conflict(
        rid="cf_duplicate_ghost", kind=ConflictKind.DUPLICATE,
        subjects=["pt_ghost", "pt_ghost"], summary="subject 不存在",
        options=[opt("a", "A", 1), opt("b", "B", 1)])

    #: blast **恰好等于 2**，且 eig 与 irreversibility 都非零 —— 专门为了让
    #: ``math.log1p(2)`` 真的参与一次乘法。CPython 走平台 libm、V8 走自己的实现，
    #: 这两个值在 2 上差 1 ULP；上面那些用例的 eig 恰好是 0，score 一律 0，
    #: 于是这条分叉被"躲"过去了。躲过去的分叉迟早会在别处冒出来。
    c["blast_two"] = Conflict(
        rid="cf_duplicate_blasttwo", kind=ConflictKind.DUPLICATE,
        subjects=["pt_ghost_a", "pt_ghost_b"], summary="blast 恰好 2",
        options=[opt("a", "A", 1), opt("b", "B", 1)])

    #: subjects 为空 —— blast=0，``log1p(0)/log1p(30)`` = 0 → score 0。
    c["empty_subjects"] = Conflict(
        rid="cf_duplicate_empty", kind=ConflictKind.DUPLICATE, subjects=[],
        summary="没有 subject", options=[opt("a", "A", 1), opt("b", "B", 1)])

    #: 四个非兜底分支、证据完全均匀 → eig 恰好 1.0（归一化熵拉满）。
    c["four_even"] = Conflict(
        rid="cf_semantic_divergence_four", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN, PT_ORDER, OT_PLAN], summary="四个等权分支",
        options=[opt("a", "A", 1), opt("b", "B", 1), opt("c", "C", 1),
                 opt("d", "D", 1)])

    #: 非 ASK_USER 的三条 —— 各自进 auto_repairable / round_trip / hints。
    c["auto"] = Conflict(rid="cf_naming_violation_x", kind=ConflictKind.NAMING_VIOLATION,
                         subjects=[PT_PLAN], summary="apiName 含中文")
    c["round_trip"] = Conflict(rid="cf_missing_required_x",
                               kind=ConflictKind.MISSING_REQUIRED,
                               subjects=[PT_PLAN], summary="缺口径定义")
    c["hint"] = Conflict(rid="cf_orphan_x", kind=ConflictKind.ORPHAN,
                         subjects=[make_rid("ot", "supplier")], summary="孤立对象")
    return c


C = conflicts()

#: ``q_{n}_{rid[-8:]}`` 的倒数切片。短 rid、中文 rid、代理对 rid 三种形态，
#: TS 的 ``slice(-8)`` 按 UTF-16 码元切，最后一条会切出半个代理对。
ID_SLICE_RIDS = ["cf_x", "cf_abcdefgh", "cf_abcdefghij", "cf_口径不一致的那一条",
                 "cf_" + "𠀀" * 6, "", "12345678", "1234567"]


def rank_cases() -> list[tuple[str, list[Conflict], int, float]]:
    """(名字, 冲突列表, max_questions, theta_ask)。

    五条停止路径：全部问完 / 一条都没有 / 达上限 / 低于阈值 / 上限先于阈值触发。
    """
    return [
        ("empty", [], 3, 0.35),
        ("all_asked", [C["balanced"], C["four_even"]], 3, 0.05),
        ("only_non_ask", [C["auto"], C["round_trip"], C["hint"]], 3, 0.35),
        ("hits_limit", [C["balanced"], C["four_even"], C["no_evidence"],
                        C["policy"], C["lopsided"]], 3, 0.01),
        ("below_theta", [C["balanced"], C["single_branch"], C["no_options"]],
         3, 0.35),
        ("theta_zero_limit_one", [C["balanced"], C["four_even"]], 1, 0.0),
        ("mixed_all_buckets", list(C.values()), 3, 0.35),
        ("max_zero", [C["balanced"], C["four_even"]], 0, 0.35),
        ("real_detected", detect_all(oir_from_dict(OIR_DICT)), 3, 0.35),
    ]


# ══════════════════════════════════════════════════════════════════
#  apply_decision
# ══════════════════════════════════════════════════════════════════
def apply_cases() -> list[tuple[str, Conflict, str, str]]:
    unify = Conflict(
        rid="cf_apply_unify", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN, PT_ORDER], summary="统一口径",
        options=[opt("unify_a", "统一为 A 口径（含税，年度累计）", 1, unify_to=PT_PLAN),
                 opt("unify_ghost", "统一到不存在的属性", 0, unify_to="pt_ghost")])
    split = Conflict(
        rid="cf_apply_split", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN, PT_ORDER], summary="拆成两个属性",
        # 四个轴取值（含税/不含税/年度累计/单次）在这一条里全部走到 ——
        # ``_suffix`` 的取值表只有四项，少一项就有一条拼不出来的后缀没人测。
        options=[opt("split_two_properties", "拆分", 1,
                     split=[PT_PLAN, PT_ORDER, PT_USED, "pt_ghost"],
                     axes="时间粒度_税")])
    retype = Conflict(
        rid="cf_apply_type", kind=ConflictKind.TYPE_MISMATCH, subjects=[PT_PLAN],
        summary="类型不符",
        options=[opt("use_actual", "改为 STRING", 1, set_base_type="STRING"),
                 opt("keep_declared", "保留 DECIMAL", 0)])
    defer = Conflict(
        rid="cf_apply_defer", kind=ConflictKind.SEMANTIC_DIVERGENCE,
        subjects=[PT_PLAN], summary="转模板",
        options=[opt("defer_to_template", "先不定", 0, defer=True)])
    return [
        ("unify", unify, "unify_a", ""),
        ("unify_note", unify, "unify_a", "FDE 拍板：以计划域为准"),
        # 统一到不存在的属性 —— source 为 None，一条都不改，也不崩。
        ("unify_ghost", unify, "unify_ghost", ""),
        ("split", split, "split_two_properties", ""),
        ("set_type", retype, "use_actual", ""),
        # 没有任何 effect 的选项 —— changed 为空，defer 为 False。
        ("keep", retype, "keep_declared", ""),
        ("defer", defer, "defer_to_template", ""),
    ]


def main() -> None:
    eng = ClarificationEngine()
    oir = OIR_MAIN

    out: dict[str, Any] = {
        "blast_scale": ClarificationEngine.BLAST_SCALE,
        "oir": OIR_DICT,
        "conflicts": {k: v.to_dict() for k, v in C.items()},
        "factors": [
            {"name": k, "rid": v.rid, "handling": str(v.handling),
             "irreversibility": v.irreversibility,
             "evidence_decidable": v.policy.evidence_decidable,
             "eig": ClarificationEngine.eig(v),
             "blast": ClarificationEngine.blast(v, oir),
             "self_resolvable": ClarificationEngine.self_resolvable(v),
             "score": eng.score(v, oir)}
            for k, v in C.items()
        ],
        "id_slices": [[r, r[-8:]] for r in ID_SLICE_RIDS],
        "rank": [],
        "apply": [],
    }

    for name, cs, maxq, theta in rank_cases():
        e = ClarificationEngine(max_questions=maxq, theta_ask=theta)
        cset = e.rank(cs, oir)
        out["rank"].append({
            "name": name, "max_questions": maxq, "theta_ask": theta,
            # 整条冲突都导出来而不是只导 rid：``real_detected`` 那组来自
            # ``detect_all``，不在上面手搭的 ``conflicts`` 里，只有 rid 的话
            # TS 侧还原不出来，那条最像真实场景的用例就只能跳过。
            "input": [c.to_dict() for c in cs],
            "input_rids": [c.rid for c in cs],
            "questions": [q.to_dict() for q in cset.questions],
            "auto_repairable": [c.rid for c in cset.auto_repairable],
            "deferred_to_template": [c.rid for c in cset.deferred_to_template],
            "round_trip": [c.rid for c in cset.round_trip],
            "hints": [c.rid for c in cset.hints],
            "stopped_because": cset.stopped_because,
            "summary": cset.summary(),
        })

    for name, conflict, option_id, note in apply_cases():
        o = oir_from_dict(OIR_DICT)
        res = apply_decision(o, conflict, option_id, note=note)
        out["apply"].append({"name": name, "conflict": conflict.to_dict(),
                             "option_id": option_id, "note": note,
                             "result": res, "oir_after": o.to_dict()})

    # 找不到选项时的 KeyError 消息原文 —— 消息里有 `!r`，两边的 repr 规则不同。
    missing = []
    for bad in ["nope", "含中文的 option id", "带'引号'", ""]:
        try:
            apply_decision(oir_from_dict(OIR_DICT), C["balanced"], bad)
        except KeyError as exc:
            # KeyError 的 str() 会再套一层 repr，args[0] 才是消息原文。
            missing.append([bad, exc.args[0], str(exc)])
    out["missing_option"] = missing

    path = GOLDEN / "onto.clarify.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                    encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
