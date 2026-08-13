"""导出 server 段 D（流水线）里**纯函数**部分的 golden 向量。

覆盖 `server.py` 2656–3026 那一组：`_trace_detail` 与表格渲染工具。带 IO / 仓储 /
模型网关的部分（`_run_pipeline`、`_conversation_tables`）不在这里 —— 它们的行为
靠 TS 侧的假 repo 用例钉。

输出必须**字节确定**（重跑两次哈希一致），否则 diff 全是噪声：
`sort_keys=True`、`indent=2`、`ensure_ascii=False`，且不写任何时间戳/临时路径。

    .venv/bin/python tools/golden/server_pipeline.py
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

import ontocopilot.server as S
from ontocopilot.kernel.events import Event, EventKind

OUT = Path(__file__).resolve().parents[2] / "golden" / "server_pipeline.json"


# ── _oir_val ──────────────────────────────────────────────────────
OIR_VAL_CASES: list[Any] = [
    {"value": "客户"},
    {"value": ""},
    {"value": None},
    {},
    None,
    "",
    "裸串",
    0,
    123,
    False,
    True,
    [],
    ["a"],
]


# ── _oir_table ────────────────────────────────────────────────────
OIR: dict[str, Any] = {
    "objects": [
        {"displayName": {"value": "客户"}, "apiName": {"value": "Customer"},
         "description": {"value": "描述" * 80}, "status": "draft"},
        {"displayName": "裸串对象", "apiName": {"value": "Bare"},
         "description": {}, "status": ""},
        {"apiName": {"value": "NoName"}},
    ],
    "properties": [
        {"parent": "Customer", "displayName": {"value": "名称"},
         "apiName": {"value": "name"}, "baseType": {"value": "string"},
         "definition": {"value": "口径" * 80}},
        {"parent": "", "displayName": {}, "apiName": {}, "baseType": {},
         "definition": {}},
    ],
    "links": [
        {"from": "Customer", "to": "Order", "apiName": {"value": "orders"},
         "cardinality": {"value": "ONE_TO_MANY"}},
    ],
    "actions": [
        {"apiName": {"value": "createOrder"}, "appliesTo": ["Order", "Customer"]},
        {"apiName": {"value": "noApplies"}, "appliesTo": []},
        {"apiName": {"value": "missingApplies"}},
    ],
    "rules": [
        {"statement": {"value": "金额必须为正"}, "ruleKind": {"value": "validation"},
         "actor": {"value": "系统"}},
    ],
    "questions": [
        {"text": {"value": "客户编号唯一吗？"}, "answer": {"value": ""}, "code": "Q1"},
        {"text": {"value": "订单可以撤销吗？"}, "answer": {"value": "可以"}, "code": "Q2"},
    ],
}

OIR_TABLE_CASES = [
    ("objects", ""),
    ("objects", "customer"),
    ("objects", "不存在的词"),
    ("properties", ""),
    ("links", ""),
    ("actions", ""),
    ("rules", ""),
    ("questions", "可以"),
]


# ── _sheet_rows（csv/tsv 这条自写的路）────────────────────────────
CSV_FIXTURES: dict[str, str] = {
    "简单.csv": "编号,名称,备注\n1,客户,\n2,订单,加急\n",
    "有空行.csv": "编号,名称\n\n1,甲\n\n2,乙\n",
    "分号.csv": "a;b;c\n1;2;3\n4;5;6\n",
    "重名列.csv": "名称,名称,名称\n甲,乙,丙\n",
    "无表头.csv": "1,2,3\n4,5,6\n",
    "参差.csv": "a,b,c\n1,2\n3,4,5,6\n",
    "制表.tsv": "列1\t列2\n甲\t乙\n",
    "引号.csv": 'a,b\n"含,逗号","含""引号"\n',
}


# ── _match_file ───────────────────────────────────────────────────
MATCH_FILES = ["订单明细.xlsx", "客户主数据.csv", "readme.md"]
MATCH_CASES = [
    "订单明细.xlsx",
    "%E8%AE%A2%E5%8D%95%E6%98%8E%E7%BB%86.xlsx",
    "订单",
    "%E8%AE%A2%E5%8D%95",
    "readme",
    "不存在",
    "",
    "%E4%B8%",          # 残缺的百分号编码：Python 原样留下，不抛
    "%zz",
]


# ── _tables_in_text ───────────────────────────────────────────────
MD_CASES = [
    "",
    "没有表格的一段话。",
    "## AI 招聘业务流程梳理及访谈提问框架\n\n| 环节 | 负责人 |\n| --- | --- |\n| 筛选 | HR |\n| 面试 | 用人部门 |\n",
    "**加粗当标题**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    ("正文很长" * 30) + "\n\n| a |\n| --- |\n| 1 |\n",
    "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n### 第二张\n\n| c |\n| --- |\n| 3 |\n",
]


# ── _pick_table ───────────────────────────────────────────────────
PICK_TABLES = [
    {"title": "问题清单", "rows": [["1"]], "ts": 1.0},
    {"title": "AI 招聘业务流程梳理及访谈提问框架", "rows": [["2"]], "ts": 2.0},
    {"title": "对比表", "rows": [["3"]], "ts": 3.0},
    {"title": "问题清单", "rows": [["4"]], "ts": 4.0},
]
PICK_CASES = [
    "",
    "问题清单",
    "AI 招聘",
    "AI 招聘业务流程梳理及访谈提问框架（导出版）",
    "对比",
    "没有这张",
    "  问题清单  ",
]


# ── _trace_detail ─────────────────────────────────────────────────
def _ev(kind: EventKind, payload: dict[str, Any]) -> Event:
    return Event(run_id="r", seq=0, kind=kind, node_id="N", payload=payload)


TRACE_CASES = [
    _ev(EventKind.CRITIC_VERDICT, {"lens": "coverage", "passed": True,
                                   "findings": [{"claim": "覆盖" * 80}]}),
    _ev(EventKind.CRITIC_VERDICT, {"lens": "provenance", "passed": False,
                                   "findings": [{"claim": ""}]}),
    _ev(EventKind.CRITIC_VERDICT, {"lens": "x", "passed": False, "findings": []}),
    _ev(EventKind.CRITIC_VERDICT, {}),
    _ev(EventKind.THOUGHT, {"text": "想" * 200}),
    _ev(EventKind.THOUGHT, {}),
    _ev(EventKind.THOUGHT, {"text": None}),
    _ev(EventKind.OBSERVATION, {"tool": "evidence.search", "summary": "命中" * 80}),
    _ev(EventKind.OBSERVATION, {}),
    _ev(EventKind.BUDGET_SPENT, {"model": "gpt-x", "tok_in": 100, "tok_out": 20,
                                 "usd": 0.0123}),
    _ev(EventKind.BUDGET_SPENT, {}),
    _ev(EventKind.PLAN_CREATED, {"steps": [{"goal": "目标" * 30}, {"goal": "第二步"},
                                           {"goal": "三"}, {"goal": "四"},
                                           {"goal": "第五步不该出现"}]}),
    _ev(EventKind.PLAN_CREATED, {}),
    _ev(EventKind.NODE_FAILED, {"mode": "retry", "attempt": 2, "error": "boom",
                                "label": "L", "extra": "不该出现"}),
    _ev(EventKind.DEGRADED, {}),
    _ev(EventKind.NODE_ENTERED, {"attempt": 1, "error": None}),
]


class _S:
    """`_match_file` / `_material_table` 只碰 Session 的这两样。"""

    def __init__(self, files: list[dict[str, Any]], directory: Path) -> None:
        self.files = files
        self.dir = directory
        self.state: dict[str, Any] = {}
        self.events: list[dict[str, Any]] = []


def main() -> None:
    out: dict[str, Any] = {}

    out["oir_val"] = [{"in": x, "out": S._oir_val(x)} for x in OIR_VAL_CASES]

    out["oir_table"] = []
    for kind, contains in OIR_TABLE_CASES:
        label, head, rows = S._oir_table(OIR, kind, contains)
        out["oir_table"].append({"kind": kind, "contains": contains,
                                 "label": label, "head": head, "rows": rows})
    # 空 OIR / None 也要钉
    out["oir_table_empty"] = [
        {"kind": k, "out": list(S._oir_table({}, k, ""))} for k in sorted(S._OIR_COLS)
    ]

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        mats = root / "materials"
        mats.mkdir()
        for name, text in CSV_FIXTURES.items():
            (mats / name).write_text(text, encoding="utf-8")

        out["sheet_rows"] = []
        for name in CSV_FIXTURES:
            out["sheet_rows"].append(
                {"file": name, "out": S._sheet_rows(mats / name)})

        files = [{"name": n, "path": str(mats / n)} for n in CSV_FIXTURES]
        sess = _S(files, root)
        out["material_table"] = []
        for name in CSV_FIXTURES:
            rec: dict[str, Any] = {"file": name}
            try:
                f, sheet, cols, rows, note = S._material_table(sess, name)  # type: ignore[arg-type]
                rec["out"] = {"file": f, "sheet": sheet, "cols": cols,
                              "rows": rows, "note": note}
            except S._NoRows as exc:
                rec["no_rows"] = str(exc)
            except S._MultiSheet as exc:
                rec["multi_sheet"] = exc.sheets
            out["material_table"].append(rec)

        # 列筛选 / contains / 空列隐藏
        extra = []
        for args in (
            {"columns": ["名称"]},
            {"columns": ["名称", "不存在的列"]},
            {"columns": ["全都不存在"]},
            {"contains": "订单"},
            {"contains": "不可能出现"},
        ):
            rec = {"args": args}
            try:
                f, sheet, cols, rows, note = S._material_table(
                    sess, "简单.csv", "", args.get("contains", ""),  # type: ignore[arg-type]
                    args.get("columns"))
                rec["out"] = {"file": f, "sheet": sheet, "cols": cols,
                              "rows": rows, "note": note}
            except S._NoRows as exc:
                rec["no_rows"] = str(exc)
            extra.append(rec)
        out["material_table_args"] = extra

        # 不是表格 / 不存在
        misc = []
        sess2 = _S([{"name": "说明.md", "path": str(mats / "说明.md")}], root)
        (mats / "说明.md").write_text("# 标题\n", encoding="utf-8")
        for target, sx in (("说明.md", sess2), ("没有这个.csv", sess2)):
            try:
                S._material_table(sx, target)  # type: ignore[arg-type]
                misc.append({"target": target, "out": "unexpected"})
            except S._NoRows as exc:
                misc.append({"target": target, "no_rows": str(exc)})
        out["material_table_misc"] = misc

        # _full_rows_for：oir 配方 / material 配方 / 坏配方
        fsess = _S(files, root)
        fsess.state["oir"] = OIR
        out["full_rows_for"] = []
        for ev in (
            {"src": {"kind": "oir", "oir_kind": "objects"}},
            {"src": {"kind": "oir", "oir_kind": "questions", "contains": "可以"}},
            {"src": {"kind": "oir"}},                       # 缺 oir_kind → None
            {"src": {"kind": "material", "file": "简单.csv"}},
            {"src": {"kind": "material", "file": "没有这个.csv"}},
            {"src": {"kind": "别的"}},
            {},
        ):
            out["full_rows_for"].append(
                {"ev": ev, "rows": S._full_rows_for(fsess, ev)})  # type: ignore[arg-type]

    msess = _S([{"name": n} for n in MATCH_FILES], Path("/nonexistent"))
    out["match_file"] = [
        {"raw": raw,
         "hit": (S._match_file(msess, raw) or {}).get("name")}  # type: ignore[arg-type]
        for raw in MATCH_CASES
    ]

    # `blocks_from_markdown` 属于 onto.export（另一个 track）。把它的输出一并导出，
    # TS 侧用同一批 block 喂 `_tables_in_text` —— 这样测的是本段的取标题/组装逻辑，
    # 而不是把别人的 markdown 解析器一起绑进来。
    from ontocopilot.onto import export as X

    def _blk(b: Any) -> dict[str, Any]:
        return {"kind": b.kind, "text": b.text,
                "columns": list(b.columns), "rows": [list(r) for r in b.rows]}

    out["tables_in_text"] = [
        {"md": md,
         "blocks": [_blk(b) for b in X.blocks_from_markdown(md)],
         "out": S._tables_in_text(md, 1234.5)}
        for md in MD_CASES
    ]

    out["pick_table"] = [
        {"name": n,
         "hit": (S._pick_table(PICK_TABLES, n) or {}).get("rows")}
        for n in PICK_CASES
    ]
    out["pick_table_empty"] = S._pick_table([], "x")

    # payload 导成**有序的键值对列表**：最后那条分支复制的是 payload 的插入序
    # （`{k: v for k, v in p.items() if ...}`），而 sort_keys=True 会把 dict 重排，
    # TS 侧读回来就成了另一个顺序 —— 那样测的不是同一件事。
    out["trace_detail"] = [
        {"kind": str(ev.kind), "payload_items": [[k, v] for k, v in ev.payload.items()],
         "detail": S._trace_detail(ev)}
        for ev in TRACE_CASES
    ]

    out["last_card_table"] = []
    for events, cards in (
        ([], []),
        ([{"kind": "chat.turn"}], []),
        ([{"kind": "ui.table", "title": "A"}, {"kind": "ui.table", "title": "B"}], []),
        ([], [{"kind": "ui.table", "title": "C"}]),
        ([{"kind": "chat.turn"}], [{"kind": "ui.table", "title": "D"}]),
    ):
        cs = _S([], Path("/nonexistent"))
        cs.events = list(events)
        cs.state["_cards"] = list(cards)
        hit = S._last_card_table(cs)  # type: ignore[arg-type]
        out["last_card_table"].append(
            {"events": events, "cards": cards,
             "hit": None if hit is None else hit.get("title")})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True),
                   encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
