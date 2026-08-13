"""把 ``store/repo.py`` 的 ``PgRepo`` 真跑一遍，导成 golden，给 TS 侧 ``store/repo/pg.ts`` 用。

PgRepo 是本仓最大的一块（1800 行、79 个方法），而它的行为里**手写期望值必然写错**的
地方极多：

  * 三个租约（build / chat / mutation）互斥与抢占的真值表 —— 谁能抢、谁抢不到、
    过期之后又如何，靠的是一串带条件的写语句，读代码推不出来；
  * ``next_decision_ordinal`` / ``next_event_seq`` / ``next_run_ordinal`` 三个
    计数器的发号结果与自愈行为；
  * ``save_state`` 家族的 CAS 语义（``expected_version`` 对不上返回 None、一个字
    都不写）与「``conflicts=None`` 不动冲突表、``[]`` 才是清空」；
  * ``record_decision`` 的推翻规则、``record_decision_v1`` 的幂等与 supersedes 链；
  * 各种边界的**异常类型与消息逐字**（RevisionConflict / IdempotencyConflict /
    DuplicateUsername / ValueError）。

所以这里存的不是我对 repo.py 的理解，是它真跑出来的**每一步返回值**，外加最后一张
全库快照。TS 侧照同一个剧本跑一遍，逐步比对。

── 怎么做到字节确定 ──────────────────────────────────────────────────────

1. ``TZ=UTC`` 强制设定（tstz 列在 SQLite 上是朴素文本，读回来会被按本地时区解释）；
2. 剧本里**一切时间戳都显式给**，所以 ``x or time.time()`` 永远走 x 那条路；
   躲不掉的只有 ``append_event`` 的 ``ts`` 和 ``finalize_decision_v1`` 写进
   metadata 的 ``finalizedAt`` —— 这两处归一化成 ``"<ts>"``；
3. 全库快照里由 ``CURRENT_TIMESTAMP`` / ``datetime.now()`` 落下的列同样归一化
   （见 ``NONDET``），其余列如实存；
4. JSON 列**解码之后**再存 —— SQLAlchemy 用 ``json.dumps`` 的默认分隔符
   （``", "`` / ``": "``），Drizzle 用 ``JSON.stringify``（紧凑），存的字节本来就不同，
   而这条差异不影响任何读路径（见 pg.ts 文件头 §分叉 2）；
5. tstz 列一律换算成 **epoch 秒并按 UTC 解释**，不存文本 —— 两边的读取口径由此对齐。

跑法::

    .venv/bin/python tools/golden/store_repo_pg.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

os.environ["TZ"] = "UTC"
try:  # Windows 上没有 tzset，本仓不支持它，但别在 import 阶段炸
    import time as _time

    _time.tzset()
except AttributeError:  # pragma: no cover
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.store.engine import Store  # noqa: E402
from ontocopilot.store.repo import (  # noqa: E402
    AuthSessionRow,
    DecisionRecordRow,
    DecisionRow,
    FileRow,
    PgRepo,
    ProjectMemoryRow,
    ProjectRow,
    QuestionRow,
    RevisionRow,
    SessionRow,
    UsageRow,
    UserRow,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden" / "store.repo.pg.json"

# ── 归一化 ────────────────────────────────────────────────────────────────

#: 由 CURRENT_TIMESTAMP / datetime.now() 落下的列，快照里换成 "<ts>"。
NONDET: dict[str, set[str]] = {
    "session": {"updated_at"},
    "session_file": {"uploaded_at"},
    "session_state": {"updated_at"},
    "decision": {"created_at"},
    "run": {"started_at", "ended_at"},
    "blob": {"created_at"},
    "app_setting": {"updated_at"},
    "llm_usage": {"created_at"},
    "project": {"created_at", "updated_at"},
    "project_memory": {"updated_at"},
    "session_event": {"ts"},
}

EVENT_KEYS = {"seq", "kind", "payload", "ts", "event_id"}


def norm(v: Any) -> Any:
    """返回值里躲不掉的两处时间归一化。"""
    if isinstance(v, dict):
        out = {k: norm(x) for k, x in v.items()}
        if set(out) == EVENT_KEYS:
            out["ts"] = "<ts>"
        if "finalizedAt" in out:
            out["finalizedAt"] = "<ts>"
        return out
    if isinstance(v, (list, tuple)):
        return [norm(x) for x in v]
    return v


def dto(v: Any) -> Any:
    """DTO → 可比较的 JSON。dataclass 用 ``__slots__``，asdict 走不通，逐字段取。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, set):
        return sorted(v)
    if isinstance(v, (list, tuple)):
        return [dto(x) for x in v]
    if isinstance(v, dict):
        return {k: dto(x) for k, x in v.items()}
    slots = getattr(type(v), "__slots__", None)
    if slots:
        return {k: dto(getattr(v, k)) for k in slots}
    raise TypeError(f"不知道怎么序列化 {type(v).__name__}")


STEPS: list[dict[str, Any]] = []


async def step(name: str, coro: Any) -> Any:
    """跑一步并记下返回值；抛出来的异常也是行为的一部分，如实记。"""
    try:
        value = await coro
    except Exception as exc:  # noqa: BLE001 —— 异常类型与消息就是被钉的行为
        STEPS.append({"step": name, "error": type(exc).__name__, "message": str(exc)})
        return None
    STEPS.append({"step": name, "value": norm(dto(value))})
    return value


# ── 全库快照 ──────────────────────────────────────────────────────────────


async def snapshot(store: Any) -> dict[str, Any]:
    import sqlalchemy as sa

    from ontocopilot.store import schema as t

    out: dict[str, Any] = {}
    async with store.engine.connect() as conn:
        for name in sorted(t.metadata.tables):
            table = t.metadata.tables[name]
            rows = (await conn.execute(sa.select(table))).mappings().all()
            dumped = []
            for r in rows:
                item: dict[str, Any] = {}
                for col in table.columns:
                    v = r[col.name]
                    if col.name in NONDET.get(name, set()):
                        item[col.name] = "<ts>" if v is not None else None
                    elif isinstance(v, datetime):
                        # 朴素 datetime 一律按 UTC 解释 —— 与 pg.ts 的 tstzEpoch 同口径。
                        item[col.name] = (
                            v if v.tzinfo else v.replace(tzinfo=UTC)
                        ).timestamp()
                    elif isinstance(v, (bytes, bytearray, memoryview)):
                        item[col.name] = "sha256:" + hashlib.sha256(bytes(v)).hexdigest()
                    else:
                        item[col.name] = v
                dumped.append(item)
            # metadata 里的 finalizedAt 是 time.time() 落的，快照同样要归一化。
            # 按内容排序而不是留着库返回的自然序：那个序是 rowid 序，而 rowid 会在
            # 删行之后被复用 —— 两边即使做了完全相同的事，也没有理由信它一定一致。
            out[name] = sorted(
                norm(dumped), key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False)
            )
    return out


# ── 剧本 ──────────────────────────────────────────────────────────────────

T0 = 1_700_000_000.0

CONFLICTS = [
    {
        "rid": "c.b",
        "kind": "duplicate",
        "handling": "ask_user",
        "summary": "两个同名实体",
        "subjects": ["e.1", "e.2"],
        "detector": "rule",
        "owner": "u1",
        "options": [{"id": "keep"}],
    },
    {"rid": "c.a", "kind": "gap", "handling": "hint"},
    {
        "rid": "c.c",
        "kind": "caliber",
        "handling": "round_trip",
        "summary": "",
        "subjects": [],
        "detector": "llm",
        "owner": None,
    },
]


async def run(store: Any) -> None:
    repo = PgRepo(store.engine)
    STEPS.append({"step": "mode", "value": repo.mode})

    # ── 会话 ──────────────────────────────────────────────────────────
    await step(
        "create_session/s1",
        repo.create_session(
            SessionRow(id="s1", title="第一个", project="P", created=T0 + 0.5, owner="u1")
        ),
    )
    await step(
        "create_session/s2",
        repo.create_session(SessionRow(id="s2", title="第二个", created=T0 + 100.0)),
    )
    await step("get_session/s1", repo.get_session("s1"))
    await step("get_session/missing", repo.get_session("zz"))
    await step("list_sessions/all", repo.list_sessions())
    await step("list_sessions/owner", repo.list_sessions(owner="u1"))
    await step("list_sessions/empty_owner", repo.list_sessions(owner=""))
    await step("list_sessions/limit", repo.list_sessions(1))
    await step("rename_session/hit", repo.rename_session("s1", "改过名"))
    await step("rename_session/miss", repo.rename_session("zz", "x"))
    await step("set_status/s2", repo.set_status("s2", "failed", error="boom"))
    await step("get_session/s2", repo.get_session("s2"))
    await step(
        "claim_session_status/ok",
        repo.claim_session_status("s2", from_statuses=["failed", "failed"], to_status="idle"),
    )
    await step(
        "claim_session_status/again",
        repo.claim_session_status("s2", from_statuses=["failed"], to_status="idle"),
    )
    await step(
        "claim_session_status/empty",
        repo.claim_session_status("s2", from_statuses=[], to_status="idle"),
    )

    # ── 文件 ──────────────────────────────────────────────────────────
    await step(
        "add_files",
        repo.add_files(
            "s1",
            [
                FileRow(name="b.xlsx", rel_path="s1/b.xlsx", size=12, sha256="bb"),
                FileRow(name="a.pdf", rel_path="s1/a.pdf", size=34, sha256="aa"),
            ],
        ),
    )
    await step(
        "add_files/upsert",
        repo.add_files("s1", [FileRow(name="a.pdf", rel_path="s1/a2.pdf", size=99, sha256="a2")]),
    )
    await step("list_files", repo.list_files("s1"))
    await step("remove_file/hit", repo.remove_file("s1", "b.xlsx"))
    await step("remove_file/miss", repo.remove_file("s1", "b.xlsx"))

    # ── 归属改判 ──────────────────────────────────────────────────────
    await step("reassign_sessions/empty", repo.reassign_sessions("", "u2"))
    await step("reassign_sessions/named", repo.reassign_sessions("u2", "u3"))
    await step("get_session/s2/after", repo.get_session("s2"))

    # ── 状态与冲突 ────────────────────────────────────────────────────
    await step(
        "save_state/first",
        repo.save_state(
            "s1",
            {"oir": {"entities": [1, 2]}, "budget": {"spent": 3}},
            conflicts=CONFLICTS,
            asked_rids=["c.c", "c.b"],
        ),
    )
    await step("load_state/all", repo.load_state("s1"))
    await step("load_state/keys", repo.load_state("s1", keys=["oir"]))
    await step("load_state/empty_keys", repo.load_state("s1", keys=[]))
    await step("load_state/no_derived", repo.load_state("s1", include_derived=False))
    await step("list_conflicts", repo.list_conflicts("s1"))
    await step("get_conflict/hit", repo.get_conflict("s1", "c.a"))
    await step("get_conflict/miss", repo.get_conflict("s1", "zz"))
    await step(
        "save_state/cas_stale",
        repo.save_state("s1", {"oir": {"entities": []}}, expected_version=0),
    )
    await step("load_state/after_stale", repo.load_state("s1", keys=["oir"]))
    await step(
        "save_state/cas_ok",
        repo.save_state("s1", {"oir": {"entities": [7]}}, expected_version=1),
    )
    await step("list_conflicts/after_cas", repo.list_conflicts("s1"))
    await step("save_state/clear_conflicts", repo.save_state("s1", {}, conflicts=[]))
    await step("list_conflicts/cleared", repo.list_conflicts("s1"))

    # ── build 租约 ────────────────────────────────────────────────────
    await step(
        "claim_build_lease/ok",
        repo.claim_build_lease(
            "s1", owner="b1", now=T0, ttl=60.0, from_statuses=["idle"], to_status="queued"
        ),
    )
    await step(
        "claim_build_lease/taken",
        repo.claim_build_lease(
            "s1", owner="b2", now=T0, ttl=60.0, from_statuses=["idle", "queued"]
        ),
    )
    await step("renew_build_lease/ok", repo.renew_build_lease("s1", owner="b1", now=T0 + 1, ttl=60.0))
    await step(
        "renew_build_lease/other", repo.renew_build_lease("s1", owner="b2", now=T0 + 1, ttl=60.0)
    )
    await step(
        "set_build_status/ok",
        repo.set_build_status("s1", owner="b1", now=T0 + 2, status="parsing"),
    )
    await step(
        "set_build_status/other",
        repo.set_build_status("s1", owner="b2", now=T0 + 2, status="done"),
    )
    await step(
        "save_build_state/ok",
        repo.save_build_state(
            "s1",
            {"flow": {"steps": 2}},
            owner="b1",
            now=T0 + 3,
            status="extracting",
            conflicts=[CONFLICTS[1]],
            asked_rids=["c.a"],
        ),
    )
    await step(
        "save_build_state/other",
        repo.save_build_state("s1", {"flow": {}}, owner="b2", now=T0 + 3, status="done"),
    )
    await step("request_build_cancel/ok", repo.request_build_cancel("s1", now=T0 + 4))
    await step(
        "request_build_cancel/again", repo.request_build_cancel("s1", now=T0 + 4)
    )
    await step(
        "renew_build_lease/cancelled",
        repo.renew_build_lease("s1", owner="b1", now=T0 + 5, ttl=60.0),
    )
    await step("release_build_lease/ok", repo.release_build_lease("s1", owner="b1"))
    await step("release_build_lease/again", repo.release_build_lease("s1", owner="b1"))

    # 回收过期租约：先重新抢一个 ttl 很短的
    await step("set_status/idle", repo.set_status("s1", "idle", error=""))
    await step(
        "claim_build_lease/short",
        repo.claim_build_lease(
            "s1", owner="b3", now=T0 + 10, ttl=1.0, from_statuses=["idle"], to_status="queued"
        ),
    )
    await step(
        "reap_expired_build_lease/live",
        repo.reap_expired_build_lease("s1", now=T0 + 10.5, error="太久没心跳"),
    )
    await step(
        "reap_expired_build_lease/expired",
        repo.reap_expired_build_lease("s1", now=T0 + 100, error="太久没心跳"),
    )
    await step("get_session/after_reap", repo.get_session("s1"))
    await step(
        "reap_expired_build_lease/done",
        repo.reap_expired_build_lease("s1", now=T0 + 200, error="x"),
    )

    # ── chat 租约 ─────────────────────────────────────────────────────
    await step("claim_chat_lease/ok", repo.claim_chat_lease("s1", owner="c1", now=T0, ttl=30.0))
    await step("claim_chat_lease/taken", repo.claim_chat_lease("s1", owner="c2", now=T0, ttl=30.0))
    await step("claim_chat_lease/missing_session", repo.claim_chat_lease("zz", owner="c1", now=T0, ttl=30.0))
    await step("renew_chat_lease/ok", repo.renew_chat_lease("s1", owner="c1", now=T0 + 1, ttl=30.0))
    await step("renew_chat_lease/other", repo.renew_chat_lease("s1", owner="c2", now=T0 + 1, ttl=30.0))
    await step(
        "save_chat_state/ok",
        repo.save_chat_state("s1", {"dialogue": {"turns": 1}}, owner="c1", now=T0 + 2),
    )
    await step(
        "save_chat_state/other",
        repo.save_chat_state("s1", {"dialogue": {}}, owner="c2", now=T0 + 2),
    )
    await step("request_chat_cancel/ok", repo.request_chat_cancel("s1", now=T0 + 3))
    await step("request_chat_cancel/again", repo.request_chat_cancel("s1", now=T0 + 3))
    await step("renew_chat_lease/cancelled", repo.renew_chat_lease("s1", owner="c1", now=T0 + 4, ttl=30.0))
    await step("release_chat_lease/ok", repo.release_chat_lease("s1", owner="c1"))

    # ── mutation 租约 ─────────────────────────────────────────────────
    await step(
        "claim_mutation_lease/ok",
        repo.claim_mutation_lease("s1", owner="m1", kind="edit", now=T0, ttl=30.0),
    )
    await step(
        "claim_mutation_lease/taken",
        repo.claim_mutation_lease("s1", owner="m2", kind="edit", now=T0, ttl=30.0),
    )
    await step(
        "renew_mutation_lease/ok", repo.renew_mutation_lease("s1", owner="m1", now=T0 + 1, ttl=30.0)
    )
    await step(
        "renew_mutation_lease/other",
        repo.renew_mutation_lease("s1", owner="m2", now=T0 + 1, ttl=30.0),
    )
    await step(
        "save_mutation_state/ok",
        repo.save_mutation_state(
            "s1", {"oir": {"entities": [9]}}, owner="m1", now=T0 + 2, status="done"
        ),
    )
    await step(
        "save_mutation_state/other",
        repo.save_mutation_state("s1", {"oir": {}}, owner="m2", now=T0 + 2, status="done"),
    )
    await step(
        "claim_build_lease/blocked_by_mutation",
        repo.claim_build_lease(
            "s1", owner="b9", now=T0 + 2, ttl=60.0, from_statuses=["done", "idle"]
        ),
    )
    await step("release_mutation_lease/ok", repo.release_mutation_lease("s1", owner="m1"))
    await step("release_mutation_lease/again", repo.release_mutation_lease("s1", owner="m1"))

    # ── 人的决定（legacy）─────────────────────────────────────────────
    await step(
        "record_decision/naming",
        repo.record_decision(
            "s1",
            DecisionRow(
                ordinal=-1, kind="naming", statement="叫客户", scope_refs=["e.1"], ts=T0 + 20
            ),
        ),
    )
    await step(
        "record_decision/naming_again",
        repo.record_decision(
            "s1",
            DecisionRow(
                ordinal=-1, kind="naming", statement="改叫甲方", scope_refs=["e.1"], ts=T0 + 21
            ),
        ),
    )
    await step(
        "record_decision/other_scope",
        repo.record_decision(
            "s1",
            DecisionRow(ordinal=-1, kind="naming", statement="别的", scope_refs=["e.2"], ts=T0 + 22),
        ),
    )
    await step(
        "record_decision/answer",
        repo.record_decision(
            "s1",
            DecisionRow(ordinal=-1, kind="answer", target_rid="c.a", option_id="keep", ts=T0 + 23),
        ),
    )
    await step(
        "record_decision/answer_again",
        repo.record_decision(
            "s1",
            DecisionRow(ordinal=-1, kind="answer", target_rid="c.a", option_id="drop", ts=T0 + 24),
        ),
    )
    await step("list_decisions/all", repo.list_decisions("s1"))
    await step("list_decisions/active", repo.list_decisions("s1", active_only=True))
    await step("answered_rids", repo.answered_rids("s1"))

    # ── Question v1 ───────────────────────────────────────────────────
    q1 = QuestionRow(
        id="q.1",
        text="主体是谁？",
        status="open",
        priority="blocking",
        dependencies=["q.0"],
        source_kind="conflict",
        source_ref="c.a",
        doc={"id": "q.1", "text": "主体是谁？", "version": 0},
        version=0,
        created=T0 + 30,
        updated=T0 + 30,
    )
    q2 = QuestionRow(
        id="q.2",
        text="口径按月还是按年？",
        doc={"id": "q.2", "version": 0},
        created=T0 + 31,
        updated=T0 + 31,
    )
    await step("upsert_questions", repo.upsert_questions("s1", [q1, q2]))
    await step("list_questions/all", repo.list_questions("s1"))
    await step("list_questions/status", repo.list_questions("s1", statuses=["open"]))
    await step("list_questions/none", repo.list_questions("s1", statuses=[]))
    await step("get_question/hit", repo.get_question("s1", "q.1"))
    await step("get_question/miss", repo.get_question("s1", "zz"))
    await step(
        "save_question/insert",
        repo.save_question(
            "s1",
            QuestionRow(
                id="q.3",
                text="新问题",
                doc={"id": "q.3", "version": 0},
                created=T0 + 32,
                updated=T0 + 32,
            ),
        ),
    )
    await step(
        "save_question/cas_ok",
        repo.save_question(
            "s1",
            QuestionRow(
                id="q.1",
                text="主体是谁？",
                status="answered",
                doc={"id": "q.1", "text": "主体是谁？", "version": 0},
                version=0,
                created=T0 + 30,
                updated=T0 + 33,
            ),
            expected_version=0,
        ),
    )
    await step(
        "save_question/cas_stale",
        repo.save_question(
            "s1",
            QuestionRow(
                id="q.1",
                text="x",
                doc={"id": "q.1", "version": 0},
                version=0,
                created=T0 + 30,
                updated=T0 + 34,
            ),
            expected_version=0,
        ),
    )
    await step("get_question/after_cas", repo.get_question("s1", "q.1"))

    # ── Decision v1 ───────────────────────────────────────────────────
    d1 = DecisionRecordRow(
        id="d.1",
        question_id="q.1",
        answer={"value": "甲方"},
        actor="user",
        actor_role="owner",
        authority="final",
        idempotency_key="k1",
        semantic_hash="h1",
        created=T0 + 40,
    )
    await step("record_decision_v1/new", repo.record_decision_v1("s1", d1))
    await step(
        "record_decision_v1/same_key",
        repo.record_decision_v1(
            "s1",
            DecisionRecordRow(
                id="d.1b",
                question_id="q.1",
                answer={"value": "甲方"},
                actor="user",
                idempotency_key="k1",
                semantic_hash="h1",
                created=T0 + 41,
            ),
        ),
    )
    await step(
        "record_decision_v1/key_clash",
        repo.record_decision_v1(
            "s1",
            DecisionRecordRow(
                id="d.1c",
                question_id="q.1",
                answer={"value": "别的"},
                actor="user",
                idempotency_key="k1",
                semantic_hash="h9",
                created=T0 + 42,
            ),
        ),
    )
    await step(
        "record_decision_v1/no_key",
        repo.record_decision_v1(
            "s1",
            DecisionRecordRow(id="d.x", question_id="q.1", answer=None, actor="user"),
        ),
    )
    await step(
        "record_decision_v1/supersede",
        repo.record_decision_v1(
            "s1",
            DecisionRecordRow(
                id="d.2",
                question_id="q.1",
                answer={"value": "乙方"},
                actor="user",
                idempotency_key="k2",
                semantic_hash="h2",
                created=T0 + 43,
            ),
        ),
    )
    await step(
        "finalize_decision_v1/applied",
        repo.finalize_decision_v1("s1", "d.2", status="applied"),
    )
    await step(
        "finalize_decision_v1/conflict",
        repo.finalize_decision_v1("s1", "d.2", status="failed", error="炸了"),
    )
    await step(
        "finalize_decision_v1/bad_status",
        repo.finalize_decision_v1("s1", "d.2", status="weird"),
    )
    await step(
        "finalize_decision_v1/missing",
        repo.finalize_decision_v1("s1", "d.zz", status="applied"),
    )
    await step("list_decisions_v1", repo.list_decisions_v1("s1"))

    # ── Revision ──────────────────────────────────────────────────────
    await step(
        "record_revision/new",
        repo.record_revision(
            "s1",
            RevisionRow(
                id="rev.0",
                ordinal=0,
                parent_id=None,
                kind="edit",
                status="proposed",
                doc={"id": "rev.0", "ordinal": 0},
                idempotency_key="r0",
                created=T0 + 50,
            ),
        ),
    )
    await step(
        "record_revision/same_key",
        repo.record_revision(
            "s1",
            RevisionRow(
                id="rev.0",
                ordinal=0,
                parent_id=None,
                kind="edit",
                status="proposed",
                doc={"id": "rev.0", "ordinal": 0},
                idempotency_key="r0",
                created=T0 + 51,
            ),
        ),
    )
    await step(
        "record_revision/key_clash",
        repo.record_revision(
            "s1",
            RevisionRow(
                id="rev.0b",
                ordinal=0,
                parent_id=None,
                kind="edit",
                status="proposed",
                doc={"id": "rev.0b"},
                idempotency_key="r0",
                created=T0 + 52,
            ),
        ),
    )
    await step(
        "append_revision/first",
        repo.append_revision(
            "s1",
            RevisionRow(
                id="ignored",
                ordinal=-1,
                parent_id="ignored",
                kind="edit",
                status="proposed",
                doc={"kind": "edit", "id": "ignored"},
                changed_ids=["e.1"],
                idempotency_key="ra",
                created=T0 + 53,
            ),
        ),
    )
    await step(
        "append_revision/second",
        repo.append_revision(
            "s1",
            RevisionRow(
                id="ignored",
                ordinal=-1,
                parent_id=None,
                kind="edit",
                status="proposed",
                doc={"kind": "edit"},
                idempotency_key="rb",
                created=T0 + 54,
            ),
        ),
    )
    await step(
        "append_revision/idempotent",
        repo.append_revision(
            "s1",
            RevisionRow(
                id="ignored",
                ordinal=-1,
                parent_id=None,
                kind="edit",
                status="proposed",
                doc={"kind": "edit"},
                idempotency_key="rb",
                created=T0 + 55,
            ),
        ),
    )
    await step("finalize_revision/applied", repo.finalize_revision("s1", "rev.1", status="applied"))
    await step("finalize_revision/retry", repo.finalize_revision("s1", "rev.1", status="applied"))
    await step(
        "finalize_revision/conflict", repo.finalize_revision("s1", "rev.1", status="rejected")
    )
    await step("finalize_revision/bad", repo.finalize_revision("s1", "rev.1", status="weird"))
    await step("finalize_revision/missing", repo.finalize_revision("s1", "rev.99", status="applied"))
    await step("list_revisions", repo.list_revisions("s1"))

    # ── 事件 ──────────────────────────────────────────────────────────
    await step("append_event/1", repo.append_event("s1", "chat.delta", {"text": "你好"}))
    await step("append_event/2", repo.append_event("s1", "chat.done", {"ok": True}))
    await step(
        "append_event/idem", repo.append_event("s1", "chat.delta", {"text": "重"}, event_id="e-1")
    )
    await step(
        "append_event/idem_retry",
        repo.append_event("s1", "chat.delta", {"text": "不一样"}, event_id="e-1"),
    )
    big = {"blob": "汉" * 20000}
    await step("append_event/big", repo.append_event("s1", "node.completed", big))
    await step("read_events/all", repo.read_events("s1"))
    await step("read_events/since", repo.read_events("s1", since=3))
    await step("count_events", repo.count_events("s1"))

    # ── Run ───────────────────────────────────────────────────────────
    r1 = await step("next_run/1", repo.next_run("s1", "build"))
    await step("next_run/2", repo.next_run("s1", "chat"))
    await step("finish_run", repo.finish_run(r1, status="done", budget={"usd": 0.5}))

    # ── 账号 ──────────────────────────────────────────────────────────
    await step(
        "create_user/admin",
        repo.create_user(
            UserRow(
                id="u1",
                username="admin",
                password_hash="scrypt$x",
                role="admin",
                prefs={"theme": "dark"},
                created=T0 + 60,
                display_name="管理员",
            )
        ),
    )
    await step(
        "create_user/plain",
        repo.create_user(
            UserRow(id="u2", username="bob", password_hash="scrypt$y", created=T0 + 61)
        ),
    )
    await step(
        "create_user/dup",
        repo.create_user(
            UserRow(id="u3", username="bob", password_hash="scrypt$z", created=T0 + 62)
        ),
    )
    await step("get_user/hit", repo.get_user("u1"))
    await step("get_user/miss", repo.get_user("zz"))
    await step("get_user_by_username", repo.get_user_by_username("bob"))
    await step("list_users", repo.list_users())
    await step("count_users", repo.count_users())
    await step("update_user/partial", repo.update_user("u2", role="admin", active=False))
    await step("update_user/noop", repo.update_user("u2"))
    await step("update_user/missing", repo.update_user("zz", role="admin"))

    # ── 登录会话 ──────────────────────────────────────────────────────
    await step(
        "create_auth_session",
        repo.create_auth_session(
            AuthSessionRow(
                token_hash="t1", user_id="u1", created=T0 + 70, last_seen=0.0, expires=T0 + 3600
            )
        ),
    )
    await step(
        "create_auth_session/expired",
        repo.create_auth_session(
            AuthSessionRow(
                token_hash="t2", user_id="u2", created=T0 + 71, last_seen=T0 + 71, expires=T0 + 72
            )
        ),
    )
    await step("get_auth_session/hit", repo.get_auth_session("t1"))
    await step("get_auth_session/miss", repo.get_auth_session("zz"))
    await step("prune_auth_sessions", repo.prune_auth_sessions(now=T0 + 100))
    await step("delete_auth_session/hit", repo.delete_auth_session("t1"))
    await step("delete_auth_session/miss", repo.delete_auth_session("t1"))
    await step(
        "create_auth_session/again",
        repo.create_auth_session(
            AuthSessionRow(
                token_hash="t3", user_id="u2", created=T0 + 80, last_seen=T0 + 80, expires=T0 + 9999
            )
        ),
    )
    await step("delete_user_auth_sessions", repo.delete_user_auth_sessions("u2"))
    await step("delete_user/hit", repo.delete_user("u2"))
    await step("delete_user/miss", repo.delete_user("u2"))

    # ── 用量 ──────────────────────────────────────────────────────────
    await step(
        "add_usage/1",
        repo.add_usage(
            UsageRow(
                id="usage.1",
                ts=T0 + 90,
                day="2023-11-14",
                model="gpt-5",
                owner="u1",
                session_id="s1",
                run_id="s1.0",
                node_id="EXTRACT",
                kind="build",
                effort="high",
                tok_in=1000,
                tok_out=200,
                cache_read=30,
                cache_write=4,
                usd=0.125,
                usd_source="gateway",
                attempts=2,
                status="ok",
            )
        ),
    )
    await step(
        "add_usage/2",
        repo.add_usage(
            UsageRow(id="usage.2", ts=T0 + 91, day="2023-11-14", model="haiku", kind="chat")
        ),
    )
    await step(
        "add_usage/bad",
        repo.add_usage(
            UsageRow(id="usage.3", ts=T0 + 92, day="2023-11-14", model="x", attempts=0)
        ),
    )
    await step("usage_since/all", repo.usage_since(0.0))
    await step("usage_since/owner", repo.usage_since(0.0, owner="u1"))
    await step("usage_since/no_owner", repo.usage_since(0.0, owner=""))
    await step("usage_since/window", repo.usage_since(T0 + 91))
    await step("usage_since/limit0", repo.usage_since(0.0, limit=0))

    # ── 项目 ──────────────────────────────────────────────────────────
    await step(
        "create_project/1",
        repo.create_project(ProjectRow(id="p1", name="甲项目", owner="u1", sort_order=1)),
    )
    await step(
        "create_project/2", repo.create_project(ProjectRow(id="p2", name="乙项目", sort_order=0))
    )
    await step("list_projects/all", repo.list_projects())
    await step("list_projects/owner", repo.list_projects(owner="u1"))
    await step("get_project/hit", repo.get_project("p1"))
    await step("get_project/miss", repo.get_project("zz"))
    await step("rename_project/hit", repo.rename_project("p1", "甲项目改"))
    await step("rename_project/miss", repo.rename_project("zz", "x"))
    await step("reassign_projects/empty", repo.reassign_projects("", "u9"))
    await step("assign_session/set", repo.assign_session("s1", "p1"))
    await step("assign_session/clear", repo.assign_session("s2", ""))
    await step("assign_session/miss", repo.assign_session("zz", "p1"))
    await step("get_session/assigned", repo.get_session("s1"))
    await step(
        "upsert_project_memory",
        repo.upsert_project_memory(
            [
                ProjectMemoryRow(
                    project_id="p1",
                    key="naming:客户",
                    tier="authoritative",
                    kind="naming",
                    content="统一叫甲方",
                    confidence=0.9,
                    support=["f1"],
                    tags=["naming"],
                    origin_session="s1",
                    origin_files=["a.pdf"],
                    use_count=2,
                    created_run="s1.0",
                    last_used_run="s1.1",
                ),
                ProjectMemoryRow(
                    project_id="p1",
                    key="caliber:月",
                    tier="reference",
                    kind="caliber",
                    content="按自然月",
                ),
            ]
        ),
    )
    await step("upsert_project_memory/empty", repo.upsert_project_memory([]))
    await step("list_project_memory", repo.list_project_memory("p1"))
    await step("delete_project_memory/keys", repo.delete_project_memory("p1", keys=["caliber:月"]))
    await step("delete_project_memory/empty", repo.delete_project_memory("p1", keys=[]))
    await step("list_project_memory/after", repo.list_project_memory("p1"))
    await step("delete_project/p1", repo.delete_project("p1"))
    await step("get_session/released", repo.get_session("s1"))
    await step("list_project_memory/gone", repo.list_project_memory("p1"))

    # ── 设置 ──────────────────────────────────────────────────────────
    await step("set_setting/new", repo.set_setting("gateway", {"url": "https://x"}))
    await step("set_setting/update", repo.set_setting("gateway", {"url": "https://y"}))
    await step("set_setting/scalar", repo.set_setting("budget", 12.5))
    await step("get_setting/hit", repo.get_setting("gateway"))
    await step("get_setting/miss", repo.get_setting("zz"))
    await step("list_settings", repo.list_settings())
    await step("delete_setting/hit", repo.delete_setting("budget"))
    await step("delete_setting/miss", repo.delete_setting("budget"))

    # ── 收尾 ──────────────────────────────────────────────────────────
    await step("delete_session/hit", repo.delete_session("s2"))
    await step("delete_session/miss", repo.delete_session("s2"))
    await step("count_events/after_delete", repo.count_events("s2"))


async def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="repo-golden-"))
    db = tmp / "golden.db"
    store = await Store.open(f"sqlite+aiosqlite:///{db}", create_all=True)
    try:
        await run(store)
        snap = await snapshot(store)
    finally:
        await store.close()
        for p in sorted(tmp.glob("*")):
            p.unlink()
        tmp.rmdir()

    payload = {
        "note": "PgRepo（SQLite 方言）逐步返回值 + 全库快照。生成器 tools/golden/store_repo_pg.py",
        "steps": STEPS,
        "snapshot": snap,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")
    print(f"{OUT}  steps={len(STEPS)}  sha256={hashlib.sha256(OUT.read_bytes()).hexdigest()[:16]}")


if __name__ == "__main__":
    asyncio.run(main())
