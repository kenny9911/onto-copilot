"""把 kernel/dag.py 的行为导成 golden，给 TS 侧 dag.ts 当安全网。

dag.py 之前没有 golden（Python 侧只有 tests/test_orchestration.py 里几条断言），
所以这份是新导的。

**设计：golden 里存的是"程序"而不是"输入对象"。** 每个用例带一串 ops
（dag/add/extend/expand/freeze/topo_order/…），Python 和 TS 各自用同一个解释器
replay 同一串 ops，再比对输出。这样 DAG 的构造过程不需要在 TS 测试里手抄一遍 ——
手抄的输入和手写的期望值一样不可信。

**ops 里只写显式传的 kwargs**，没传的字段由两边各自的 defaults 补齐 ——
于是"默认值是否一致"也被这份 golden 顺带钉住了。

跑法::

    .venv/bin/python tools/golden/dag.py

字节确定：无时间、无随机、无集合迭代序（凡是要排序的地方 dag.py 自己就排了）。
重跑两次哈希必须一致。
"""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.dag import (  # noqa: E402
    Dag,
    Difficulty,
    GateSpec,
    NodeBudget,
    NodeSpec,
    NodeMode,
    ScopeSpec,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  ops 解释器 —— TS 侧要有一份等价实现
# ══════════════════════════════════════════════════════════════════
def make_spec(d: dict[str, Any]) -> NodeSpec:
    """从 JSON 形状的 kwargs 造 NodeSpec。缺的字段走 dataclass 默认值。"""
    kw = dict(d)
    kw["mode"] = NodeMode(kw["mode"])
    if kw.get("difficulty") is not None:
        kw["difficulty"] = Difficulty(kw["difficulty"])
    for key in ("deps", "critics"):
        if key in kw:
            kw[key] = tuple(kw[key])
    if "scope" in kw:
        s = dict(kw["scope"])
        if s.get("evidence_files") is not None:
            s["evidence_files"] = tuple(s["evidence_files"])
        kw["scope"] = ScopeSpec(**s)
    if "budget" in kw:
        kw["budget"] = NodeBudget(**kw["budget"])
    if kw.get("gate") is not None:
        g = dict(kw["gate"])
        if "require" in g:
            g["require"] = tuple(g["require"])
        kw["gate"] = GateSpec(**g)
    return NodeSpec(**kw)


def run(ops: list[dict[str, Any]]) -> Dag:
    dag: Dag | None = None
    for op in ops:
        kind = op["op"]
        if kind == "dag":
            dag = Dag(op["name"], freeze_before=op.get("freeze_before"))
            continue
        assert dag is not None, "第一条 op 必须是 dag"
        if kind == "add":
            dag.add(make_spec(op["spec"]))
        elif kind == "extend":
            dag.extend([make_spec(s) for s in op["specs"]])
        elif kind == "expand":
            dag.expand({k: list(v) for k, v in op["cardinalities"].items()})
        elif kind == "freeze":
            dag.freeze()
        elif kind == "topo_order":
            dag.topo_order()
        elif kind == "resolve_deps":
            dag.resolve_deps(op["node"])
        elif kind == "dependents":
            dag.dependents(op["node"])
        elif kind == "describe":
            dag.describe()
        elif kind == "get":
            dag[op["node"]]
        else:
            raise AssertionError(f"未知 op: {kind}")
    assert dag is not None
    return dag


# ══════════════════════════════════════════════════════════════════
#  用例
# ══════════════════════════════════════════════════════════════════
def _n(nid: str, deps: list[str] | None = None, **kw: Any) -> dict[str, Any]:
    """test_orchestration.py 里那个 _n 的 JSON 版：最省的确定性节点。"""
    spec: dict[str, Any] = {"id": nid, "mode": "deterministic", "handler": "echo"}
    if deps is not None:
        spec["deps"] = deps
    spec.update(kw)
    return spec


CASES: list[dict[str, Any]] = [
    {
        "name": "stable_topo",
        "doc": "乱序 add 出来的拓扑序必须只由 id 排序决定 —— 重放的地基。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("C", ["A"])},
            {"op": "add", "spec": _n("A", [])},
            {"op": "add", "spec": _n("D", ["B", "C"])},
            {"op": "add", "spec": _n("B", ["A"])},
        ],
    },
    {
        "name": "diamond_dependents",
        "doc": "dependents 只算直接下游（澄清引擎的影响半径）。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "add", "spec": _n("B", ["A"])},
            {"op": "add", "spec": _n("C", ["A"])},
            {"op": "add", "spec": _n("D", ["B"])},
        ],
    },
    {
        "name": "duplicate_dep_not_deduped",
        "doc": "deps 里同一个上游写两遍不去重 —— 入度也算两次，两边必须一致。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "add", "spec": _n("B", ["A", "A"])},
        ],
    },
    {
        "name": "fanout_barrier",
        "doc": "PARSE.* 通配依赖 = 同步屏障；展开后 fanout_over 清空、params 补 fanout_key。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("PARSE", None, fanout_over="files")},
            {"op": "add", "spec": _n("ALIGN", ["PARSE.*"])},
            {"op": "expand", "cardinalities": {"PARSE": ["f1", "f2", "f3"]}},
        ],
    },
    {
        "name": "fanout_keeps_existing_params",
        "doc": "展开时 params 是合并不是替换；同名 fanout_key 被覆盖。",
        "ops": [
            {"op": "dag", "name": "t"},
            {
                "op": "add",
                "spec": _n("EX", None, fanout_over="segments",
                           params={"keep": 1, "fanout_key": "会被覆盖"}),
            },
            {"op": "expand", "cardinalities": {"EX": ["s0"]}},
        ],
    },
    {
        "name": "wildcard_does_not_match_the_base_id",
        "doc": "dep[:-1] 只削掉 '*'，留着那个点 —— 所以 'PARSE.*' 匹配不到 'PARSE' 自己。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("PARSE")},
            {"op": "add", "spec": _n("PARSE.f1")},
            {"op": "add", "spec": _n("ALIGN", ["PARSE.*"])},
        ],
    },
    {
        "name": "sort_is_by_code_point",
        "doc": (
            "fan-out 后缀来自用户上传的文件名，可能含 emoji。Python sorted 按 code "
            "point，JS 默认 sort 按 UTF-16 code unit —— 'z' < U+FFFF < U+1F40D 在两者"
            "之间排法不同。拓扑序漂了重放就废了，这条必须钉住。"
        ),
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("P", None, fanout_over="files")},
            {"op": "add", "spec": _n("ALIGN", ["P.*"])},
            {"op": "expand", "cardinalities": {"P": ["\U0001f40d", "\uffff", "z"]}},
        ],
    },
    {
        "name": "expand_with_empty_cardinality_deletes_the_node",
        "doc": "上传清单为空时 fan-out 节点直接消失，不留占位。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "add", "spec": _n("P", None, fanout_over="files")},
            {"op": "expand", "cardinalities": {"P": []}},
        ],
    },
    {
        "name": "freeze_before_may_point_at_an_expanded_prefix",
        "doc": "freeze_before='EXTRACT' 在展开成 EXTRACT.s0/s1 之后仍然合法。",
        "ops": [
            {"op": "dag", "name": "onto_extract", "freeze_before": "EXTRACT"},
            {
                "op": "add",
                "spec": _n("EXTRACT", None, mode="plan_execute", handler="extract",
                           fanout_over="segments",
                           scope={"evidence_top_k": 0},
                           budget={"tokens": 24000, "iterations": 4, "wallclock_s": 420},
                           critics=["coverage", "provenance"],
                           critic_rounds=2, difficulty="high", retries=1),
            },
            {"op": "add", "spec": _n("MERGE", ["EXTRACT.*"], handler="merge")},
            {"op": "expand", "cardinalities": {"EXTRACT": ["s0", "s1"]}},
            {"op": "freeze"},
        ],
    },
    {
        "name": "rich_spec_round_trip",
        "doc": "把所有字段都填满：gate / critics / sandbox / 嵌套 params / evidence_files。",
        "ops": [
            {"op": "dag", "name": "fde_like", "freeze_before": "INTAKE"},
            {
                "op": "extend",
                "specs": [
                    _n("INTAKE", None, mode="single_shot", handler="agent.fde_interviewer",
                       scope={"evidence_top_k": 40, "evidence_files": ["a.xlsx", "b.docx"],
                              "blackboard_pattern": "INTAKE.*"},
                       params={"agent": "fde_interviewer", "tool_scope": "reader",
                               "output_schema": {"type": "object",
                                                 "required": ["scope", "roles"]}}),
                    _n("GAP", ["INTAKE"], handler="engagement.collect_gaps",
                       scope={"evidence_top_k": 0},
                       budget={"tokens": 0, "iterations": 1, "wallclock_s": 60,
                               "tool_calls": 0},
                       params={"output_contract": "QuestionBacklog",
                               "rank_by": ["downstream_blocking", "blast_radius"]},
                       retries=0),
                    _n("INTERVIEW", ["GAP"], mode="hitl", handler="engagement.interview",
                       gate={"kind": "hitl"}, difficulty="low", retries=0),
                    _n("CODE", ["INTERVIEW"], mode="codeact", handler="transform",
                       sandbox="S2", critics=["coverage"], critic_rounds=3,
                       difficulty="critical"),
                    _n("REVIEW", ["CODE"], mode="react", handler="agent.delivery_reviewer",
                       gate={"kind": "auto",
                             "require": ["verdict == 'PASS'", "blocker_count == 0"]}),
                ],
            },
            {"op": "freeze"},
        ],
    },
]


ERRORS: list[dict[str, Any]] = [
    {
        "name": "duplicate_node_id",
        "doc": "repr 里的引号形态也要一致：id 含单引号时 Python repr 换成双引号。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("节点'A")},
            {"op": "add", "spec": _n("节点'A")},
        ],
    },
    {
        "name": "cycle_two_nodes",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A", ["B"])},
            {"op": "add", "spec": _n("B", ["A"])},
            {"op": "topo_order"},
        ],
    },
    {
        "name": "cycle_partial_stuck_set_is_sorted",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "add", "spec": _n("C", ["B"])},
            {"op": "add", "spec": _n("B", ["C"])},
            {"op": "topo_order"},
        ],
    },
    {
        "name": "dangling_dependency",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A", ["ghost"])},
            {"op": "topo_order"},
        ],
    },
    {
        "name": "dangling_dependency_via_resolve_deps",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A", ["ghost"])},
            {"op": "resolve_deps", "node": "A"},
        ],
    },
    {
        "name": "wildcard_matches_nothing",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("ALIGN", ["PARSE.*"])},
            {"op": "resolve_deps", "node": "ALIGN"},
        ],
    },
    {
        "name": "wildcard_matches_nothing_after_empty_expand",
        "doc": "展开成 0 个实例后，通配依赖立刻变成硬错 —— 不静默当作空屏障。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("P", None, fanout_over="files")},
            {"op": "add", "spec": _n("ALIGN", ["P.*"])},
            {"op": "expand", "cardinalities": {"P": []}},
            {"op": "topo_order"},
        ],
    },
    {
        "name": "expand_unknown_node",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "expand", "cardinalities": {"NOPE": ["f1"]}},
        ],
    },
    {
        "name": "expand_node_without_fanout_over",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "expand", "cardinalities": {"A": ["f1"]}},
        ],
    },
    {
        "name": "freeze_before_points_nowhere",
        "ops": [
            {"op": "dag", "name": "t", "freeze_before": "GHOST"},
            {"op": "add", "spec": _n("A")},
            {"op": "freeze"},
        ],
    },
    {
        "name": "frozen_rejects_add",
        "doc": "冻结是安全边界：材料里写「再加一个外发节点」也加不进来。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "freeze"},
            {"op": "add", "spec": _n("EVIL_EXFIL", None, handler="http.fetch")},
        ],
    },
    {
        "name": "frozen_rejects_extend",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "freeze"},
            {"op": "extend", "specs": [_n("B", ["A"])]},
        ],
    },
    {
        "name": "frozen_rejects_expand",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("P", None, fanout_over="files")},
            {"op": "expand", "cardinalities": {"P": ["f1"]}},
            {"op": "freeze"},
            {"op": "expand", "cardinalities": {"P": ["f2"]}},
        ],
    },
    {
        "name": "frozen_message_quotes_the_dag_name",
        "doc": "name 含单引号时 repr 换双引号 —— 消息要一模一样才叫钉住。",
        "ops": [
            {"op": "dag", "name": "t's dag"},
            {"op": "add", "spec": _n("A")},
            {"op": "freeze"},
            {"op": "add", "spec": _n("B")},
        ],
    },
    {
        "name": "missing_node_lookup",
        "doc": "Python 的 __getitem__ 抛 KeyError；TS 侧没有 KeyError，见 TS 注释里的分叉说明。",
        "ops": [
            {"op": "dag", "name": "t"},
            {"op": "add", "spec": _n("A")},
            {"op": "get", "node": "GHOST"},
        ],
    },
]


def snapshot(case: dict[str, Any]) -> dict[str, Any]:
    dag = run(case["ops"])
    ids = list(dag.nodes)
    probes = ids + ["__ghost__", "PARSE", "P"]
    return {
        "name": case["name"],
        "doc": case.get("doc", ""),
        "ops": case["ops"],
        "frozen": dag.frozen,
        "freeze_before": dag.freeze_before,
        "len": len(dag),
        # 插入序 —— Python dict 保序，TS 侧必须用 Map 才对得上
        "node_ids": ids,
        "nodes": [asdict(dag[n]) for n in ids],
        "is_fanout": [[n, dag[n].is_fanout] for n in ids],
        "topo_order": dag.topo_order(),
        "resolve_deps": [[n, dag.resolve_deps(n)] for n in ids],
        "dependents": [[n, dag.dependents(n)] for n in ids],
        "describe": dag.describe(),
        "contains": [[n, n in dag] for n in probes],
    }


def snapshot_error(case: dict[str, Any]) -> dict[str, Any]:
    try:
        run(case["ops"])
    except Exception as exc:  # noqa: BLE001 —— 就是要把类型和消息原样记下来
        return {
            "name": case["name"],
            "doc": case.get("doc", ""),
            "ops": case["ops"],
            "error": {"type": type(exc).__name__, "message": str(exc)},
        }
    raise AssertionError(f"用例 {case['name']} 本该抛异常")


def main() -> None:
    payload = {
        "_readme": (
            "由 tools/golden/dag.py 导出。ops 是可 replay 的程序，两边跑同一串 ops "
            "再比对输出。nodes 里的 gate.timeout_s / gate.on_timeout / "
            "scope.recall_long_term 三个字段全仓零读取，TS 侧没有迁 —— "
            "见 dead_fields，测试里把这条分叉显式钉住。"
        ),
        "enums": {
            "NodeMode": {m.name: m.value for m in NodeMode},
            "Difficulty": {m.name: m.value for m in Difficulty},
        },
        "defaults": {
            "NodeSpec": asdict(NodeSpec(id="X", mode=NodeMode.DETERMINISTIC, handler="h")),
            "ScopeSpec": asdict(ScopeSpec()),
            "NodeBudget": asdict(NodeBudget()),
            "GateSpec": asdict(GateSpec(kind="auto")),
        },
        "dead_fields": {
            "GateSpec.timeout_s": GateSpec(kind="auto").timeout_s,
            "GateSpec.on_timeout": GateSpec(kind="auto").on_timeout,
            "ScopeSpec.recall_long_term": ScopeSpec().recall_long_term,
        },
        "cases": [snapshot(c) for c in CASES],
        "errors": [snapshot_error(c) for c in ERRORS],
    }
    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "dag.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  dag.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    main()
