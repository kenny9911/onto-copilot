"""`server.py` 的 `_export_doc`（3039）与 `_act`（6416）的 golden 导出。

这两个是最后一批接线的端口，而它们**没有任何 Python 侧单测**（`_act` 的唯一
调用方 `_drain_queue` 读的 `s.state["_queued"]` 全仓从没被写过）。手写期望值
就是在猜；这里真跑一遍 Python，把它吐出来的东西钉住。

导什么、为什么导它：

* ``export_doc`` —— 十一种 (source, contains, title, name) 组合下的
  ``(ExportDoc 的 title/note/blocks, 回执 dict)``。覆盖：

  - ``questions`` 走**统一台账**与走**梳理产物**两条路（判据是
    ``s.state["question_backlog"]`` 的真假，少后半个条件的话新会话会拿到空表）；
  - ``_OIR_COLS`` 那一档的表头/行/标题拼法（``label（含contains）``）；
  - ``last_answer`` / ``conversation``（**system 轮次不能丢**：它是被压缩掉的
    那些轮次仅存的记录，过滤掉就等于导出一份宣称自己完整的残缺记录）；
  - 认不出的 source。

  ``last_table`` 那一档不导：它要 ``_conversation_tables``（读仓储、读事件表），
  在纯函数导出器里造不出确定的输入，TS 侧由 `tables.ts` 自己的用例守住。

* ``act`` —— 九个意图分支的返回值原样（dict 分支就是 dict，见下）。覆盖
  CHITCHAT/ASK_STATUS 的 ``_status_line`` 措辞、SET_CALIBER 的决定落库、
  SET_SCOPE 的"落不到对象上就反问"、ADOPT/REJECT_SUGGESTION、EXPLAIN 的出处、
  ANSWER_QUESTION 的三种序号写法、RERUN 的两条岔路。
  ``START_BUILD`` 不导：它要 ``_claim_and_start_build``（碰仓储与后台任务）。

  **注意 `_act` 的返回类型**：它声明 ``-> str``，但走 ``_outcome(...)`` 的分支
  返回的是 ``{kind, facts, fallback}`` 这个 dict。这不是笔误，是原件的形状 ——
  所以 golden 里两种都有，TS 侧照搬同一个联合类型。

字节确定：时间戳写死、不碰网络与仓储、没有随机数，重跑两次 shasum 一致。

跑法::

    .venv/bin/python tools/golden/server_act_export.py

输出 ``golden/server.act_export.json``（新文件，我独占）。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

GOLDEN = ROOT / "golden"

#: 时间戳全部写死 —— 导出必须字节确定。
T0 = 1_700_000_000.0


# ══════════════════════════════════════════════════════════════════
#  夹具
# ══════════════════════════════════════════════════════════════════
def _oir_state() -> dict[str, Any]:
    """``s.state["oir"]`` 的形态 —— `_oir_table` 读的就是这个 dict 快照。"""

    def _a(v: Any) -> dict[str, Any]:
        return {"value": v, "origin": "extracted", "confidence": 1.0, "evidence": []}

    return {
        "objects": [
            {"rid": "ot_order", "api_name": _a("Order"), "display_name": _a("订单"),
             "description": _a("客户下的一笔订单，含税口径见口径约定"), "status": "candidate"},
            {"rid": "ot_tmp", "api_name": _a("TmpStage"), "display_name": _a("临时暂存表"),
             "description": _a("ETL 中间结果"), "status": "candidate"},
        ],
        "properties": [
            {"rid": "pt_amt", "parent": "ot_order", "api_name": _a("amount"),
             "display_name": _a("金额"), "base_type": _a("decimal"),
             "definition": _a("含税金额")},
        ],
        "actions": [
            {"rid": "at_submit", "api_name": _a("submitOrder"),
             "applies_to": ["ot_order"]},
        ],
        "rules": [],
        "links": [],
        "questions": [
            {"rid": "oq_1", "text": _a("订单金额含税吗？"), "answer": _a(""), "code": "Q-1"},
        ],
        "stats": {"objects": 2, "properties": 1, "links": 0, "actions": 1, "rules": 0},
    }


def _backlog_state() -> dict[str, Any]:
    from ontocopilot.onto.questions import Question, QuestionBacklog, QuestionPriority

    bag = QuestionBacklog()
    bag.add(Question(id="q-a", text="订单金额是含税还是不含税？", why="口径不一致会让报表对不上",
                     audience_role="财务", owner_user_id="", created_at=T0, updated_at=T0))
    bag.add(Question(id="q-b", text="客户主数据的唯一键是什么？", owner_user_id="li",
                     priority=QuestionPriority.BLOCKING, why="",
                     created_at=T0 + 1, updated_at=T0 + 1))
    return bag.to_dict()


def _session(**state: Any) -> Any:
    from ontocopilot import server as S

    s = S.Session(id="sess_fixed", title="示例会话", project="示例 ERP 项目", created=T0)
    s.state.update(state)
    return s


def _dm() -> Any:
    """一份带 system 轮（被压缩掉的旧轮次）的对话记忆。"""
    from ontocopilot.kernel.memory.dialogue import DialogueMemory, Speaker

    dm = DialogueMemory()
    dm.say(Speaker.SYSTEM, "（已压缩 6 轮）早前聊了材料范围与口径")
    dm.say(Speaker.USER, "订单金额是含税的吗？")
    dm.say(Speaker.ASSISTANT, "## 结论\n\n是含税。\n\n- 依据 A\n- 依据 B")
    for t in dm.turns:
        t.ts = T0
    return dm


def _blocks(doc: Any) -> list[dict[str, Any]]:
    return [
        {"kind": b.kind, "text": b.text, "level": b.level,
         "columns": list(b.columns), "rows": [list(r) for r in b.rows],
         # `items` 是 `(depth, marker, text)` 三元组的列表，不是对象
         "items": [list(i) for i in b.items]}
        for b in doc.blocks
    ]


# ══════════════════════════════════════════════════════════════════
#  _export_doc
# ══════════════════════════════════════════════════════════════════
def _export_cases() -> list[dict[str, Any]]:
    from ontocopilot import server as S

    out: list[dict[str, Any]] = []

    def run(name: str, s: Any, source: str, contains: str = "",
            title: str = "", table: str = "") -> None:
        doc, receipt = asyncio.run(S._export_doc(s, source, contains, title, table))
        out.append({
            "name": name, "source": source, "contains": contains,
            "title": title, "table_name": table,
            "doc": None if doc is None else {
                "title": doc.title, "note": doc.note, "blocks": _blocks(doc),
            },
            "receipt": receipt,
        })

    oir = _oir_state()

    # 1) 统一台账在 → 走 QuestionBacklog
    run("questions_backlog", _session(question_backlog=_backlog_state()), "questions")
    # 2) 台账里筛不到 → 明确说"没有符合条件的"
    run("questions_backlog_miss", _session(question_backlog=_backlog_state()),
        "questions", contains="根本没有这个词")
    # 3) 台账不在 → **掉到 _OIR_COLS 那一档**（"questions" 也是产物的一类）
    run("questions_from_oir", _session(oir=oir), "questions")
    # 4~6) 产物表：全量 / 带 contains 的标题拼法 / 筛空
    run("oir_objects", _session(oir=oir), "objects")
    run("oir_objects_contains", _session(oir=oir), "objects", contains="临时")
    run("oir_objects_contains_empty", _session(oir=oir), "objects", contains="不存在的词")
    # 7) 这一类是空的
    run("oir_rules_empty", _session(oir=oir), "rules")
    # 8) 显式 title 覆盖
    run("oir_props_titled", _session(oir=oir), "properties", title="字段清单")
    # 9~10) 对话：整段（system 轮要留）与"刚才那段"
    run("conversation", _session(_dialogue=_dm()), "conversation")
    run("last_answer", _session(_dialogue=_dm()), "last_answer")
    # 11) 一句话都没有
    run("conversation_empty", _session(), "conversation")
    run("last_answer_empty", _session(), "last_answer")
    # 12) 认不出的 source
    run("unknown_source", _session(), "没这个东西")
    return out


# ══════════════════════════════════════════════════════════════════
#  _act
# ══════════════════════════════════════════════════════════════════
def _act_cases() -> list[dict[str, Any]]:
    from ontocopilot import server as S
    from ontocopilot.kernel.intent import Intent, IntentMatch

    out: list[dict[str, Any]] = []

    def run(name: str, s: Any, intent: Intent, slots: dict[str, Any] | None = None) -> None:
        m = IntentMatch(intent, 0.9, slots or {}, "", "test")
        r = asyncio.run(S._act(s, m))
        out.append({"name": name, "intent": str(intent), "slots": slots or {},
                    "result": r, "result_is_dict": isinstance(r, dict)})

    oir = _oir_state()
    budget = {"spent": {"usd": 1.2345}}
    sugs = [
        {"id": "sg_1", "kind": "EXCLUDE", "title": "排除 3 张疑似临时表",
         "payload": {"objects": ["ot_tmp", "ot_a", "ot_b"]}},
        {"id": "sg_2", "kind": "SPLIT", "title": "拆分订单表", "payload": {}},
    ]

    # 寒暄：没材料 vs 有材料（后者复用 _status_line）
    run("chitchat_empty", _session(), Intent.CHITCHAT)
    s = _session(oir=oir, budget=budget, questions=[{"id": "1"}], suggestions=sugs)
    s.files = [{"name": "订单.xlsx"}, {"name": "接口.json"}]
    run("chitchat_with_files", s, Intent.CHITCHAT)

    s = _session(oir=oir, budget=budget, questions=[{"id": "1"}], suggestions=sugs)
    s.files = [{"name": "订单.xlsx"}]
    run("ask_status", s, Intent.ASK_STATUS)
    run("ask_status_cold", _session(), Intent.ASK_STATUS)

    run("add_context", _session(), Intent.ADD_CONTEXT, {"content": "含税一律指增值税专票口径"})
    run("set_caliber", _session(), Intent.SET_CALIBER, {"statement": "含税一律指增值税专票口径"})
    run("set_naming", _session(_oir=object()), Intent.SET_NAMING, {"statement": "头表统一用 Header 后缀"})

    # 范围：没产物 / 落不到对象上（挂到 EXCLUDE 建议） / 落不到也没建议 / 点名
    run("scope_no_oir", _session(), Intent.SET_SCOPE, {"named": [], "action": "exclude"})
    run("scope_suggest", _session(_oir=object(), suggestions=sugs), Intent.SET_SCOPE,
        {"named": [], "action": "exclude"})
    run("scope_no_hint", _session(_oir=object(), suggestions=[]), Intent.SET_SCOPE,
        {"named": [], "action": "exclude"})
    run("scope_named", _session(_oir=object()), Intent.SET_SCOPE,
        {"named": ["TmpStage", "LogAudit"], "action": "exclude"})
    run("scope_keep", _session(_oir=object()), Intent.SET_SCOPE,
        {"named": ["Order"], "action": "include"})

    # 建议：不在列表里 / 否决 / 采纳但没产物
    run("sug_missing", _session(suggestions=sugs), Intent.ADOPT_SUGGESTION,
        {"suggestion_id": "sg_x"})
    run("sug_reject", _session(suggestions=sugs), Intent.REJECT_SUGGESTION,
        {"suggestion_id": "sg_2"})
    run("sug_adopt_no_oir", _session(suggestions=sugs), Intent.ADOPT_SUGGESTION,
        {"suggestion_id": "sg_2"})

    # 解释：没产物 / 有产物且带出处
    run("explain_cold", _session(), Intent.EXPLAIN, {"named": ["Order"]})
    run("explain_real", _session(_oir=_real_oir()), Intent.EXPLAIN, {"named": ["Order"]})
    run("explain_unknown", _session(_oir=_real_oir()), Intent.EXPLAIN, {"named": ["NoSuch"]})

    # 回答：对不上 / ①②③ / 数字 / 字母 / 越界
    conflicts, questions = _conflict_fixture()
    for nm, opt in (("answer_circled", "②"), ("answer_digit", "1"),
                    ("answer_letter", "b"), ("answer_oob", "9"), ("answer_blank", "")):
        run(nm, _session(_conflicts=conflicts, questions=questions),
            Intent.ANSWER_QUESTION, {"question_id": "cf_1", "option": opt})
    run("answer_no_target", _session(_conflicts=conflicts, questions=questions),
        Intent.ANSWER_QUESTION, {"question_id": "cf_x", "option": "①"})

    # 重跑：没产物 / 重出模板 / 重抽材料的价签
    run("rerun_cold", _session(), Intent.RERUN, {"phrase": "重跑"})
    run("rerun_full", _session(_oir=object(), budget=budget), Intent.RERUN, {"phrase": "重跑"})

    run("unknown_intent", _session(), Intent.UNKNOWN)
    return out


def _real_oir() -> Any:
    """一份真的 OIR —— `_do_explain` 读 `oir.objects[*].api_name.evidence`。"""
    from ontocopilot.onto.oir import (
        OIR, ActionType, Assertion, ObjectType, Origin, Provenance,
    )

    oir = OIR()
    prov = Provenance(file_id="f1", file_name="订单.xlsx", locator={"sheet": "Sheet1", "row": 3})
    oir.add_object(ObjectType(
        rid="ot_order",
        api_name=Assertion("Order", Origin.EXTRACTED, [prov], 1.0),
        display_name=Assertion("订单", Origin.EXTRACTED, [prov], 1.0),
    ))
    oir.add_action(ActionType(
        rid="at_submit",
        api_name=Assertion("submitOrder", Origin.EXTRACTED, [prov], 1.0),
        applies_to=["ot_order"],
    ))
    return oir


def _conflict_fixture() -> tuple[list[Any], list[dict[str, Any]]]:
    from ontocopilot.onto.conflict import Conflict, ConflictKind, Option

    c = Conflict(
        rid="cf_1", kind=ConflictKind.TYPE_MISMATCH, subjects=["pt_amt"],
        summary="金额字段用哪个类型？",
        options=[Option("o1", "decimal(18,2)"), Option("o2", "整数分")],
    )
    q = {"conflict_rid": "cf_1",
         "options": [{"id": "o1", "label": "decimal(18,2)"}, {"id": "o2", "label": "整数分"}]}
    return [c], [q]


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    GOLDEN.mkdir(exist_ok=True)
    data = {
        "_note": "tools/golden/server_act_export.py 生成，勿手改",
        "export_doc": _export_cases(),
        "act": _act_cases(),
    }
    out = GOLDEN / "server.act_export.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"→ {out}")


if __name__ == "__main__":
    main()
