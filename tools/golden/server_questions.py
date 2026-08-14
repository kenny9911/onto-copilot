"""server.py 段 G（问题清单七条路由）的 golden 导出。

钉住的是**交付物本身的字节**，不是路由的壳。理由：这一段的产出（`问题清单.md`
/ `问题清单.json`）是真的要发给 ERP 顾问去填的文件 —— 编号错位、状态串行、
"未关闭 N 条"算错，没有任何测试会红，只会让顾问按错的清单去开会。

导什么、为什么导它：

* ``exports`` —— 一份固定 backlog 跑 ``_write_question_exports`` 后 md / json
  两份文件的**完整正文**。md 的迭代序是**插入序**、json 的是"阻塞项优先"的
  排序序，两者刻意不同；只钉其中一份就发现不了另一份抄错了顺序。
  （xlsx 不导正文 —— openpyxl 与 exceljs 的 zip 字节本来就不同，那一档由
  `golden/server.artifacts.json` 的头部用例守住。）
* ``payload`` —— ``_question_payload`` 在有/无 activeDecision 两种情况下的
  完整字典。字段名一个字错了前端就静默瞎掉。
* ``expected_version`` —— ``_expected_version`` 对 12 种输入的结果（含
  ``int()`` 对浮点、数字串、bool 的语义），以及抛 400 的那几种。
* ``predict_effect`` —— ``_predict_decision_effect`` 四条分支 + 找不到选项时的
  422 消息原文（消息里有 ``!r``，两边的 repr 不一样）。
* ``content_disposition`` / ``media`` —— 三种 format 的两个下载头。

字节确定：所有时间戳写死，没有随机数，重跑两次 shasum 一致。

跑法::

    .venv/bin/python tools/golden/server_questions.py

输出 ``golden/server.questions.json``（新文件，我独占）。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto.conflict import Conflict, ConflictKind, Option  # noqa: E402
from ontocopilot.onto.questions import (  # noqa: E402
    Decision,
    Question,
    QuestionBacklog,
    QuestionPriority,
    QuestionStatus,
)

GOLDEN = ROOT / "golden"

#: 时间戳全部写死 —— 导出必须字节确定。
T0 = 1_700_000_000.0


def _q(**kw: Any) -> Question:
    kw.setdefault("created_at", T0)
    kw.setdefault("updated_at", T0)
    return Question(**kw)


def _backlog() -> QuestionBacklog:
    """插入序与"阻塞项优先"的排序序**刻意不一致**的一份 backlog。

    第一条是普通问题、第二条才是 blocking：md 里它排第 2，json 里它排第 1。
    两份文件因此不可能靠同一个循环写出来 —— 抄错了会立刻看出来。
    """
    bag = QuestionBacklog()
    bag.add(_q(id="q-a", text="订单金额是含税还是不含税？", why="口径不一致会让报表对不上",
               audience_role="财务", owner_user_id="", priority=QuestionPriority.NORMAL,
               source_kind="open_question", source_ref="oq_1",
               dependencies=["q-b"], created_at=T0 + 1, updated_at=T0 + 1))
    bag.add(_q(id="q-b", text="客户主数据的唯一键是什么？", why="", audience_role="",
               owner_user_id="li", status=QuestionStatus.ASSIGNED,
               priority=QuestionPriority.BLOCKING,
               blocked_artifacts=["模板_v1.xlsx", "ontology.package.json"],
               source_kind="conflict", source_ref="cf_2",
               created_at=T0 + 2, updated_at=T0 + 2))
    bag.add(_q(id="q-c", text="退货流程是否需要财务复核？", status=QuestionStatus.ANSWERED,
               priority=QuestionPriority.LOW, audience_role="业务",
               created_at=T0 + 3, updated_at=T0 + 3))
    bag.add(_q(id="q-d", text="这条先放一放", status=QuestionStatus.CANCELLED,
               created_at=T0 + 4, updated_at=T0 + 4))
    return bag


def _decision() -> Decision:
    return Decision(id="dec_fixed", question_id="q-a", answer="不含税", actor="fde",
                    actor_role="财务", authority="财务总监", source_turn="t-7",
                    affected_ids=["oir_x", "oir_y"], idempotency_key="idem-1",
                    rationale="以 ERP 里的净额为准", created_at=T0 + 10,
                    metadata={"status": "applied"})


def _exports() -> dict[str, Any]:
    """真跑一次 ``_write_question_exports``，把 md / json 读回来。"""
    from ontocopilot import server as S

    backlog = _backlog()
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)

        class _S:  # noqa: D401 - 只喂 _write_question_exports 用到的四个属性
            dir = d
            project = "示例 ERP 项目"
            title = "会话标题"
            state: dict[str, Any] = {}

        S._write_question_exports(_S(), backlog)  # type: ignore[arg-type]
        return {
            "md": (d / "问题清单.md").read_text(encoding="utf-8"),
            "json": (d / "问题清单.json").read_text(encoding="utf-8"),
            # `s.state["artifacts"]` 的投影：三份文件的排序名单。
            "artifacts": _S.state["artifacts"],
            "stats": backlog.stats(),
        }


def _expected_version() -> list[dict[str, Any]]:
    from fastapi import HTTPException

    from ontocopilot import server as S

    cases: list[dict[str, Any]] = []
    bodies: list[dict[str, Any]] = [
        {},
        {"expected_revision": None},
        {"expected_revision": 3},
        {"expected_revision": "7"},
        {"expected_revision": "  7  "},
        {"expected_revision": "+7"},
        {"expected_revision": "-2"},
        {"expected_revision": 2.9},
        {"expected_revision": -2.9},
        {"expected_revision": True},
        {"expected_revision": "1.5"},
        {"expected_revision": "abc"},
        {"expected_revision": []},
        {"expectedRevision": 5},
        # 两个键都在：`get(a, get(b))` 只看 a。
        {"expected_revision": 1, "expectedRevision": 9},
        {"expected_revision": None, "expectedRevision": 9},
    ]
    for body in bodies:
        row: dict[str, Any] = {"body": body}
        try:
            row["out"] = S._expected_version(body)
        except HTTPException as exc:
            row["error"] = [exc.status_code, exc.detail]
        cases.append(row)
    return cases


def _predict_effect() -> list[dict[str, Any]]:
    from fastapi import HTTPException

    from ontocopilot import server as S

    def cf(*options: Option) -> Conflict:
        return Conflict(rid="cf_2", kind=ConflictKind.SEMANTIC_DIVERGENCE,
                        subjects=["p_1", "p_2", "p_3"], summary="口径不一致",
                        options=list(options))

    q = _backlog().questions["q-b"]
    cases: list[dict[str, Any]] = [
        # target=None：受影响的就是这条问题挡住的产物。
        {"what": "no_conflict", "option": "任意",
         "out": S._predict_decision_effect(q, None, "任意")},
        {"what": "split", "option": "o1",
         "out": S._predict_decision_effect(
             q, cf(Option(id="o1", label="拆", effect={"split": ["p_1", "p_3"]})), "o1")},
        {"what": "unify_to", "option": "o2",
         "out": S._predict_decision_effect(
             q, cf(Option(id="o2", label="统一", effect={"unify_to": "p_2"})), "o2")},
        {"what": "set_base_type", "option": "o3",
         "out": S._predict_decision_effect(
             q, cf(Option(id="o3", label="改类型", effect={"set_base_type": "decimal"})), "o3")},
        {"what": "empty_effect", "option": "o4",
         "out": S._predict_decision_effect(q, cf(Option(id="o4", label="无副作用")), "o4")},
    ]
    try:
        S._predict_decision_effect(q, cf(Option(id="o1", label="拆")), "不存在的选项")
    except HTTPException as exc:
        cases.append({"what": "missing_option", "option": "不存在的选项",
                      "error": [exc.status_code, exc.detail]})
    return cases


def main() -> None:
    from ontocopilot import server as S

    backlog = _backlog()
    names = {"xlsx": "问题清单.xlsx", "md": "问题清单.md", "json": "问题清单.json"}
    data = {
        "exports": _exports(),
        "payload": {
            "without_decision": S._question_payload(backlog.questions["q-a"]),
            "with_decision": S._question_payload(backlog.questions["q-a"], _decision()),
        },
        "expected_version": _expected_version(),
        "predict_effect": _predict_effect(),
        "content_disposition": {k: S._content_disposition(v) for k, v in names.items()},
        "media": {
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "md": "text/markdown; charset=utf-8",
            "json": "application/json",
        },
        "next_batch": {
            # `max(1, min(limit or 5, 50))` 的四个边界，外加排序结果。
            str(limit): [q.id for q in backlog.next_batch(limit=max(1, min(limit or 5, 50)))]
            for limit in (0, 1, 2, 99, -3)
        },
    }
    out = GOLDEN / "server.questions.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True),
                   encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
