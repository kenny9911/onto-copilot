"""`store/repo.py` 的 `MemoryRepo` golden —— 一条脚本化的操作流水 + 每一步的真实返回。

为什么要 golden：MemoryRepo 是**没配 DATABASE_URL 时真正跑的实现**，79 个方法里
排序 / 过滤 / 分页 / 幂等 / 租约围栏全靠语义等价撑着。手写期望值等于把我对 Python
行为的*猜测*钉进测试；这里改成把 Python 真跑一遍，让它自己说。

导出的形状：

    {"ops": [{"m": "list_sessions", "pos": [], "kw": {"owner": "u1"}}, ...],
     "results": [{"ok": <序列化后的返回值>} | {"err": {"type": ..., "msg": ...}}, ...]}

TS 侧只需要一个 40 行的派发器：`m` 走 snake→camel，`pos` 原样展开，`kw` 的键同样
snake→camel 后当作最后那个 `opts` 对象。**场景只存在于 golden 里**，两侧不重写。

时钟：`time.time` 换成从 1000.0 起步、每次 +1 的计数器。两侧的调用**次数**必须相同，
所以 TS 那边也要保住 `row.created or now()` 的短路语义 —— 这本身就是一条被钉住的
断言（次数错位会让后面所有自动填充的时间戳整体偏移，测试立刻红）。

字节确定：假时钟 + sort_keys + 固定缩进，重跑两次 sha256 一致。

    .venv/bin/python tools/golden/store_repo_memory.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.store.repo import (  # noqa: E402
    AuthSessionRow,
    DecisionRecordRow,
    DecisionRow,
    FileRow,
    MemoryRepo,
    ProjectMemoryRow,
    ProjectRow,
    QuestionRow,
    RevisionRow,
    SessionRow,
    UsageRow,
    UserRow,
)

# ── 假时钟 ────────────────────────────────────────────────────────
_TICK = [1000.0]


def _fake_time() -> float:
    _TICK[0] += 1.0
    return _TICK[0]


time.time = _fake_time  # type: ignore[assignment]


# ── 序列化 ────────────────────────────────────────────────────────
def ser(v: Any) -> Any:
    """把返回值压成两侧共同的 JSON 形态。

    dataclass → 按字段名的 dict（与 TS 的 Row DTO 逐字同名）；
    set → **排序后的列表**（Python 的 set 无序，直接 list 会不确定）；
    tuple → 列表（`record_decision_v1` 那类 `(row, created)`）。
    """
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return {f.name: ser(getattr(v, f.name)) for f in dataclasses.fields(v)}
    if isinstance(v, set | frozenset):
        return sorted(ser(x) for x in v)
    if isinstance(v, tuple | list):
        return [ser(x) for x in v]
    if isinstance(v, dict):
        return {k: ser(x) for k, x in v.items()}
    return v


OPS: list[dict[str, Any]] = []
RESULTS: list[dict[str, Any]] = []


def call(repo: MemoryRepo, m: str, *pos: Any, **kw: Any) -> Any:
    """记录一次调用（参数在调用**之前**快照 —— Python 侧会就地改传进去的行）。"""
    OPS.append({"m": m, "pos": [ser(p) for p in pos], "kw": {k: ser(v) for k, v in kw.items()}})
    try:
        r = asyncio.run(getattr(repo, m)(*pos, **kw))
    except Exception as e:  # noqa: BLE001 —— 异常形态本身就是契约的一部分
        RESULTS.append({"err": {"type": type(e).__name__, "msg": str(e)}})
        return None
    RESULTS.append({"ok": ser(r)})
    return r


def q(qid: str, **kw: Any) -> QuestionRow:
    base: dict[str, Any] = {"id": qid, "text": f"问题 {qid}", "doc": {"id": qid, "version": 0}}
    base.update(kw)
    return QuestionRow(**base)


def scenario() -> None:
    r = MemoryRepo()

    # ── 会话：创建 / 重复创建 / 排序 / owner 过滤 / limit ────────────
    call(r, "create_session", SessionRow(id="s1", title="甲", owner="u1", created=10.0))
    call(r, "create_session", SessionRow(id="s2", title="乙", owner="u2", created=30.0))
    call(r, "create_session", SessionRow(id="s3", title="丙", owner="", created=20.0))
    # created 留 0 → 走假时钟填充，同时钉住"非 0 时不调时钟"的短路
    call(r, "create_session", SessionRow(id="s4", title="丁", owner="u1"))
    call(r, "create_session", SessionRow(id="s1", title="重复"))          # KeyError
    call(r, "list_sessions")
    call(r, "list_sessions", owner="u1")
    call(r, "list_sessions", owner="")                                    # 只看无归属
    call(r, "list_sessions", limit=2)
    call(r, "list_sessions", limit=0)
    call(r, "get_session", "s1")
    call(r, "get_session", "nope")
    call(r, "rename_session", "s1", "甲改")
    call(r, "rename_session", "nope", "x")
    call(r, "get_session", "s1")
    call(r, "set_status", "s2", "failed", error="炸了")
    call(r, "set_status", "nope", "failed")                               # KeyError
    call(r, "get_session", "s2")

    # ── 状态机 claim ───────────────────────────────────────────────
    call(r, "claim_session_status", "s3", from_statuses=["idle"], to_status="queued")
    call(r, "claim_session_status", "s3", from_statuses=["idle"], to_status="queued")
    call(r, "claim_session_status", "nope", from_statuses=["idle"], to_status="queued")

    # ── 文件（同名覆盖 + 返回全量）─────────────────────────────────
    call(r, "add_files", "s1", [FileRow(name="a.pdf", rel_path="f/a.pdf", size=3, sha256="aa"),
                                FileRow(name="b.csv", rel_path="f/b.csv", size=5, sha256="bb")])
    call(r, "add_files", "s1", [FileRow(name="a.pdf", rel_path="f/a2.pdf", size=9, sha256="cc")])
    call(r, "list_files", "s1")
    call(r, "remove_file", "s1", "b.csv")
    call(r, "remove_file", "s1", "b.csv")
    call(r, "list_files", "s1")
    call(r, "list_files", "nope")

    # ── state / conflicts ──────────────────────────────────────────
    call(r, "save_state", "s1", {"oir": {"n": 1}, "budget": {"usd": 2}})
    call(r, "load_state", "s1")
    call(r, "load_state", "s1", include_derived=False)                    # budget 是 derived
    call(r, "load_state", "s1", keys=["oir"])
    call(r, "load_state", "s1", keys=[])
    call(r, "save_state", "s1", {"corpus": [1, 2]})                       # 合并不是替换
    call(r, "load_state", "s1")
    call(r, "save_state", "s1", {"x": 1}, expected_version=99)            # CAS 失败
    call(r, "save_state", "s1", {"x": 1}, expected_version=2)             # CAS 命中
    call(r, "load_state", "s1")
    call(r, "save_state", "nope", {})                                     # KeyError
    # conflicts=None 不动冲突表；[] 才是清空
    call(r, "save_state", "s1", {},
         conflicts=[{"rid": "c1", "kind": "dup"}, {"rid": "c2", "kind": "gap"}],
         asked_rids=["c2"])
    call(r, "list_conflicts", "s1")
    call(r, "get_conflict", "s1", "c2")
    call(r, "get_conflict", "s1", "nope")
    call(r, "save_state", "s1", {"oir": {"n": 2}})                        # 不传 conflicts
    call(r, "list_conflicts", "s1")
    call(r, "save_state", "s1", {}, conflicts=[])                         # 传 [] = 清空
    call(r, "list_conflicts", "s1")

    # ── 租约：build ────────────────────────────────────────────────
    call(r, "claim_build_lease", "s4", owner="w1", now=100.0, ttl=30.0,
         from_statuses=["idle"])
    call(r, "claim_build_lease", "s4", owner="w2", now=100.0, ttl=30.0,
         from_statuses=["idle"])                                          # 状态已变，抢不到
    call(r, "claim_build_lease", "s4", owner="", now=100.0, ttl=30.0, from_statuses=["idle"])
    call(r, "claim_build_lease", "s4", owner="w2", now=100.0, ttl=0.0, from_statuses=["idle"])
    call(r, "renew_build_lease", "s4", owner="w2", now=110.0, ttl=30.0)   # 不是持有者
    call(r, "renew_build_lease", "s4", owner="w1", now=110.0, ttl=30.0)
    call(r, "set_build_status", "s4", owner="w1", now=200.0, status="parsing")  # 已过期
    call(r, "set_build_status", "s4", owner="w1", now=120.0, status="parsing")
    call(r, "get_session", "s4")
    call(r, "save_build_state", "s4", {"oir": {"k": 1}}, owner="w1", now=120.0,
         status="extracting")
    call(r, "save_build_state", "s4", {"oir": {"k": 2}}, owner="wX", now=120.0,
         status="extracting")
    call(r, "get_session", "s4")
    call(r, "request_build_cancel", "s4", now=130.0)
    call(r, "get_session", "s4")
    call(r, "renew_build_lease", "s4", owner="w1", now=131.0, ttl=30.0)   # 已被要求取消
    call(r, "release_build_lease", "s4", owner="w2")
    call(r, "release_build_lease", "s4", owner="w1")
    call(r, "release_build_lease", "s4", owner="w1")

    # reap：状态还卡在 live、租约已过期（或干脆没有）
    call(r, "claim_build_lease", "s4", owner="w3", now=300.0, ttl=10.0,
         from_statuses=["stopped"])
    call(r, "reap_expired_build_lease", "s4", now=305.0, error="超时")     # 还没过期
    call(r, "reap_expired_build_lease", "s4", now=400.0, error="超时")
    call(r, "get_session", "s4")

    # ── 租约：chat / mutation 三方互斥 ─────────────────────────────
    call(r, "claim_chat_lease", "s1", owner="c1", now=100.0, ttl=30.0)
    call(r, "claim_chat_lease", "s1", owner="c2", now=100.0, ttl=30.0)    # 还活着
    call(r, "claim_chat_lease", "s1", owner="c2", now=200.0, ttl=30.0)    # 过期了可以抢
    call(r, "claim_chat_lease", "nope", owner="c1", now=1.0, ttl=1.0)
    call(r, "renew_chat_lease", "s1", owner="c1", now=205.0, ttl=30.0)    # 不是持有者
    call(r, "renew_chat_lease", "s1", owner="c2", now=205.0, ttl=30.0)
    call(r, "save_chat_state", "s1", {"chat": 1}, owner="c2", now=210.0)
    call(r, "save_chat_state", "s1", {"chat": 2}, owner="c1", now=210.0)
    call(r, "request_chat_cancel", "s1", now=211.0)
    call(r, "request_chat_cancel", "s1", now=212.0)                       # 已经取消过
    call(r, "save_chat_state", "s1", {"chat": 3}, owner="c2", now=213.0)  # 取消后写不进
    call(r, "release_chat_lease", "s1", owner="c2")

    call(r, "claim_mutation_lease", "s1", owner="m1", kind="edit", now=300.0, ttl=30.0)
    call(r, "claim_mutation_lease", "s1", owner="m2", kind="edit", now=300.0, ttl=30.0)
    call(r, "claim_chat_lease", "s1", owner="c9", now=301.0, ttl=30.0)    # 被 mutation 挡住
    call(r, "renew_mutation_lease", "s1", owner="m1", now=305.0, ttl=30.0)
    call(r, "save_mutation_state", "s1", {"mut": 1}, owner="m1", now=306.0, status="idle")
    call(r, "save_mutation_state", "s1", {"mut": 2}, owner="m1", now=306.0, status="idle",
         chat_owner="ghost")                                              # chat 租约不在
    call(r, "release_mutation_lease", "s1", owner="m1")
    call(r, "release_mutation_lease", "s1", owner="m1")

    # ── legacy decision：ordinal 是计数器、答案按 target_rid 收敛 ────
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="answer", target_rid="c1",
                                                 statement="第一次", ts=5.0))
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="answer", target_rid="c1",
                                                 statement="第二次"))
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="answer", target_rid="c2",
                                                 statement="另一个"))
    # scope_refs 顺序不同但集合相同 → sorted 之后相等 → 后者推翻前者
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="scope",
                                                 scope_refs=["b", "a"], statement="范围一"))
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="scope",
                                                 scope_refs=["a", "b"], statement="范围二"))
    call(r, "record_decision", "s1", DecisionRow(ordinal=0, kind="scope",
                                                 scope_refs=["c"], statement="别的范围"))
    call(r, "list_decisions", "s1")
    call(r, "list_decisions", "s1", active_only=True)
    call(r, "answered_rids", "s1")

    # ── Question v1 ────────────────────────────────────────────────
    call(r, "upsert_questions", "s1", [q("q2", created=7.0), q("q1", created=7.0), q("q3")])
    call(r, "upsert_questions", "s1", [q("q1", text="改过了")])           # created 保住
    call(r, "list_questions", "s1")
    call(r, "list_questions", "s1", statuses=["open"])
    call(r, "list_questions", "s1", statuses=["answered"])
    call(r, "get_question", "s1", "q1")
    call(r, "get_question", "s1", "nope")
    call(r, "save_question", "s1", q("q1", text="CAS", version=0), expected_version=0)
    call(r, "save_question", "s1", q("q1", text="再来", version=0), expected_version=0)
    call(r, "save_question", "s1", q("zz", text="没有这条"), expected_version=0)
    call(r, "save_question", "s1", q("q3", text="无 CAS"))
    call(r, "get_question", "s1", "q1")

    # ── Decision v1：幂等键 + supersedes 链 ────────────────────────
    def dec(did: str, **kw: Any) -> DecisionRecordRow:
        base: dict[str, Any] = {"id": did, "question_id": "q1", "answer": "A", "actor": "u1"}
        base.update(kw)
        return DecisionRecordRow(**base)

    call(r, "record_decision_v1", "s1", dec("d0"))                        # 缺 idempotency_key
    call(r, "record_decision_v1", "s1", dec("d1", idempotency_key="k1", semantic_hash="h1"))
    call(r, "record_decision_v1", "s1", dec("d1b", idempotency_key="k1", semantic_hash="h1"))
    call(r, "record_decision_v1", "s1", dec("d1c", idempotency_key="k1", semantic_hash="h2"))
    call(r, "record_decision_v1", "s1", dec("d2", idempotency_key="k2", semantic_hash="h1"))
    call(r, "record_decision_v1", "s1", dec("d3", idempotency_key="k3", semantic_hash="h9",
                                            answer="B"))
    # claimed 才是 finalize 的正常入口；没有 status 的老记录按 applied 算（见下面 d1）
    call(r, "record_decision_v1", "s1", dec("d4", question_id="q2", idempotency_key="k4",
                                            semantic_hash="h4", metadata={"status": "claimed"}))
    call(r, "finalize_decision_v1", "s1", "d4", status="failed", error="工具炸了")
    call(r, "finalize_decision_v1", "s1", "d4", status="failed")           # error 被抹掉
    call(r, "record_decision_v1", "s1", dec("d5", question_id="q2", idempotency_key="k5",
                                            semantic_hash="h5",
                                            metadata={"status": "claimed"}))
    call(r, "list_decisions_v1", "s1")
    call(r, "finalize_decision_v1", "s1", "d3", status="applied")
    call(r, "finalize_decision_v1", "s1", "d3", status="applied")
    call(r, "finalize_decision_v1", "s1", "d3", status="failed")
    call(r, "finalize_decision_v1", "s1", "d1", status="failed", error="没生效")
    call(r, "finalize_decision_v1", "s1", "d1", status="failed")          # error 被抹掉
    call(r, "finalize_decision_v1", "s1", "nope", status="applied")
    call(r, "finalize_decision_v1", "s1", "d3", status="乱来")
    call(r, "list_decisions_v1", "s1")

    # ── Revision ───────────────────────────────────────────────────
    def rev(rid: str, ordinal: int, **kw: Any) -> RevisionRow:
        base: dict[str, Any] = {"id": rid, "ordinal": ordinal, "parent_id": None,
                                "kind": "edit", "status": "proposed",
                                "doc": {"id": rid, "ordinal": ordinal}}
        base.update(kw)
        return RevisionRow(**base)

    call(r, "record_revision", "s1", rev("rv2", 2))
    call(r, "record_revision", "s1", rev("rv1", 1))
    call(r, "list_revisions", "s1")                                       # 按 ordinal 排好
    call(r, "record_revision", "s1", rev("rv1", 5))                       # id 撞了
    call(r, "record_revision", "s1", rev("rv9", 2))                       # ordinal 撞了
    call(r, "record_revision", "s1", rev("rv3", 3, idempotency_key="ik"))
    call(r, "record_revision", "s1", rev("rv3", 3, idempotency_key="ik"))  # 同 doc → 幂等
    call(r, "record_revision", "s1", rev("rv4", 4, idempotency_key="ik",
                                         doc={"id": "rv4", "不一样": True}))
    call(r, "append_revision", "s1", rev("忽略", -1))
    call(r, "append_revision", "s1", rev("忽略", -1, idempotency_key="ak"))
    call(r, "append_revision", "s1", rev("忽略", -1, idempotency_key="ak"))
    call(r, "list_revisions", "s1")
    call(r, "finalize_revision", "s1", "rv1", status="applied")
    call(r, "finalize_revision", "s1", "rv1", status="applied")
    call(r, "finalize_revision", "s1", "rv1", status="rejected")
    call(r, "finalize_revision", "s1", "nope", status="applied")
    call(r, "finalize_revision", "s1", "rv2", status="乱来")
    call(r, "list_revisions", "s1")

    # ── 事件：seq 发号 + event_id 幂等 ─────────────────────────────
    call(r, "append_event", "s1", "node.started", {"node": "A"})
    call(r, "append_event", "s1", "node.done", {"node": "A"}, event_id="e1")
    call(r, "append_event", "s1", "node.done", {"node": "B"}, event_id="e1")   # 幂等
    call(r, "append_event", "s1", "node.done", {"node": "B"}, event_id="e2")
    call(r, "append_event", "s1", "tick", {})                                  # 无 id 不幂等
    call(r, "append_event", "s1", "tick", {})
    call(r, "read_events", "s1")
    call(r, "read_events", "s1", since=3)
    call(r, "read_events", "s1", since=99)
    call(r, "count_events", "s1")
    call(r, "count_events", "nope")

    # ── Run ────────────────────────────────────────────────────────
    call(r, "next_run", "s1", "build")
    call(r, "next_run", "s1", "chat")
    call(r, "next_run", "s2", "build")
    call(r, "finish_run", "s1.0", status="ok", budget={"usd": 1})
    call(r, "finish_run", "nope", status="ok")

    # ── 账号 ───────────────────────────────────────────────────────
    call(r, "create_user", UserRow(id="u1", username="alice", password_hash="h", created=50.0))
    call(r, "create_user", UserRow(id="u2", username="bob", password_hash="h", created=40.0))
    call(r, "create_user", UserRow(id="u1", username="x", password_hash="h"))
    call(r, "create_user", UserRow(id="u3", username="alice", password_hash="h"))
    call(r, "list_users")
    call(r, "count_users")
    call(r, "get_user", "u1")
    call(r, "get_user_by_username", "bob")
    call(r, "get_user_by_username", "nope")
    call(r, "update_user", "u1", role="admin")
    call(r, "update_user", "u1", active=False, prefs={"theme": "dark"}, display_name="爱丽丝")
    call(r, "update_user", "u1")                                          # 全缺席 = 一列不动
    call(r, "update_user", "nope", role="admin")
    call(r, "get_user", "u1")

    # ── 登录会话 ───────────────────────────────────────────────────
    call(r, "create_auth_session", AuthSessionRow(token_hash="t1", user_id="u1", expires=100.0))
    call(r, "create_auth_session", AuthSessionRow(token_hash="t2", user_id="u1", expires=0.0))
    call(r, "create_auth_session", AuthSessionRow(token_hash="t3", user_id="u2", expires=500.0,
                                                  created=3.0, last_seen=4.0))
    call(r, "get_auth_session", "t1")
    call(r, "get_auth_session", "nope")
    call(r, "prune_auth_sessions", now=200.0)                             # t1 过期；t2 永不过期
    call(r, "get_auth_session", "t1")
    call(r, "delete_auth_session", "t2")
    call(r, "delete_auth_session", "t2")
    call(r, "delete_user_auth_sessions", "u2")
    call(r, "create_auth_session", AuthSessionRow(token_hash="t4", user_id="u2", expires=900.0))
    call(r, "delete_user", "u2")                                          # 级联登录会话
    call(r, "get_auth_session", "t4")
    call(r, "delete_user", "u2")
    call(r, "count_users")

    # ── 用量 ───────────────────────────────────────────────────────
    def usage(uid: str, ts: float, **kw: Any) -> UsageRow:
        base: dict[str, Any] = {"id": uid, "ts": ts, "day": "2026-01-01", "model": "m"}
        base.update(kw)
        return UsageRow(**base)

    call(r, "add_usage", usage("g1", 10.0, owner="u1", tok_in=5))
    call(r, "add_usage", usage("g2", 30.0, owner="u2", tok_out=7))
    call(r, "add_usage", usage("g3", 20.0, owner="", usd=0.5, usd_source="gateway"))
    call(r, "add_usage", usage("bad", 1.0, kind="乱来"))                   # validate 拦下
    call(r, "add_usage", usage("bad2", 1.0, attempts=0))
    call(r, "usage_since", 0.0)
    call(r, "usage_since", 15.0)
    call(r, "usage_since", 0.0, owner="u1")
    call(r, "usage_since", 0.0, owner="")
    call(r, "usage_since", 0.0, limit=2)
    call(r, "usage_since", 0.0, limit=0)

    # ── 项目 ───────────────────────────────────────────────────────
    call(r, "create_project", ProjectRow(id="p1", name="项目甲", owner="u1", sort_order=2))
    call(r, "create_project", ProjectRow(id="p2", name="项目乙", owner="u1", sort_order=1))
    call(r, "create_project", ProjectRow(id="p3", name="项目丙", owner="", sort_order=1))
    call(r, "create_project", ProjectRow(id="p1", name="重复"))
    call(r, "list_projects")
    call(r, "list_projects", owner="u1")
    call(r, "list_projects", owner="")
    call(r, "get_project", "p1")
    call(r, "get_project", "nope")
    call(r, "rename_project", "p1", "项目甲改")
    call(r, "rename_project", "nope", "x")
    call(r, "assign_session", "s1", "p1")
    call(r, "assign_session", "s2", "p1")
    call(r, "assign_session", "s3", None)
    call(r, "assign_session", "nope", "p1")
    call(r, "get_session", "s1")
    call(r, "reassign_sessions", "u1", "u9")
    call(r, "reassign_projects", "u1", "u9")
    call(r, "list_sessions", owner="u9")
    call(r, "list_projects", owner="u9")

    # ── 项目记忆（按 key 排序、删部分/删全部）──────────────────────
    def mem(pid: str, key: str, **kw: Any) -> ProjectMemoryRow:
        base: dict[str, Any] = {"project_id": pid, "key": key, "tier": "authoritative",
                                "kind": "convention", "content": f"内容 {key}"}
        base.update(kw)
        return ProjectMemoryRow(**base)

    call(r, "upsert_project_memory", [mem("p1", "b"), mem("p1", "a"), mem("p2", "z")])
    call(r, "upsert_project_memory", [mem("p1", "a", content="改过了", tier="reference")])
    call(r, "list_project_memory", "p1")
    call(r, "list_project_memory", "nope")
    call(r, "delete_project_memory", "p1", keys=["a", "不存在"])
    call(r, "list_project_memory", "p1")
    call(r, "delete_project_memory", "p1")
    call(r, "delete_project_memory", "p1")
    call(r, "delete_project", "p1")                                       # 会话掉回未归类
    call(r, "get_session", "s1")
    call(r, "get_project", "p1")
    call(r, "list_project_memory", "p2")                                  # 别的项目没被牵连

    # ── 设置 ───────────────────────────────────────────────────────
    call(r, "set_setting", "b", {"on": True})
    call(r, "set_setting", "a", 42)
    call(r, "set_setting", "b", "改过了")
    call(r, "get_setting", "b")
    call(r, "get_setting", "nope")
    call(r, "list_settings")                                              # 插入序，不排序
    call(r, "delete_setting", "a")
    call(r, "delete_setting", "a")
    call(r, "list_settings")

    # ── 删会话：只清会话侧容器，顶层容器一根毫毛都不能动 ──────────
    # 红队过的坑：project 容器是按 **project id** 键的，而清理循环拿 **session id**
    # 去 pop。这里故意造一个 id 撞车的会话（sid == "P" == 某个项目 id），
    # 把它删掉之后项目、项目记忆、账号、设置、用量必须全在。
    call(r, "create_project", ProjectRow(id="P", name="同名项目"))
    call(r, "upsert_project_memory", [mem("P", "k1")])
    call(r, "create_session", SessionRow(id="P", title="同名会话", created=1.0))
    call(r, "append_event", "P", "x", {})
    call(r, "next_run", "P", "build")
    call(r, "delete_session", "P")
    call(r, "delete_session", "P")
    call(r, "get_project", "P")
    call(r, "list_project_memory", "P")
    call(r, "count_users")
    call(r, "list_settings")
    call(r, "usage_since", 0.0)
    call(r, "count_events", "P")
    call(r, "next_run", "P", "build")                                     # run 计数已归零
    call(r, "list_sessions")

    # 会话删干净之后，同 id 重建不该继承任何东西
    call(r, "create_session", SessionRow(id="s2", title="不能到这一步"))    # s2 还在 → KeyError
    call(r, "delete_session", "s2")
    call(r, "create_session", SessionRow(id="s2", title="重建", created=99.0))
    call(r, "load_state", "s2")
    call(r, "count_events", "s2")
    call(r, "list_decisions", "s2")

    # ── 「看起来像整数」的键：Python dict 保插入序，JS 普通对象会把它们提到最前 ──
    # 这是 TS 侧独有的坑（Python 侧不可能踩），所以这一段是专门为移植加的：
    # 会话 id / 文件名 / 设置键 / 事件 payload 都可能长成 "10" "2" 这样。
    call(r, "create_session", SessionRow(id="10", title="十", created=5.0))
    call(r, "create_session", SessionRow(id="2", title="二", created=5.0))
    call(r, "create_session", SessionRow(id="a", title="甲", created=5.0))
    call(r, "list_sessions")                                              # created 并列 → 稳定序
    call(r, "add_files", "10", [FileRow(name="10.pdf", rel_path="x", size=1),
                                FileRow(name="2.pdf", rel_path="x", size=1),
                                FileRow(name="b.pdf", rel_path="x", size=1)])
    call(r, "list_files", "10")
    call(r, "set_setting", "10", 1)
    call(r, "set_setting", "2", 2)
    call(r, "set_setting", "zz", 3)
    call(r, "list_settings")
    call(r, "save_state", "10", {"10": "十", "2": "二", "oir": {"10": 1, "2": 2}})
    call(r, "load_state", "10")
    call(r, "save_state", "10", {},
         conflicts=[{"rid": "10"}, {"rid": "2"}, {"rid": "c"}], asked_rids=["c", "10"])
    call(r, "list_conflicts", "10")

    # ── 码位排序：增补平面字符 vs U+FFFD 段（UTF-16 码元序会排反）──
    call(r, "create_session", SessionRow(id="sx", created=1.0))
    call(r, "upsert_questions", "sx", [q("\U0001f600", created=1.0), q("�", created=1.0)])
    call(r, "list_questions", "sx")
    call(r, "upsert_project_memory", [mem("px", "\U0001f600"), mem("px", "�")])
    call(r, "list_project_memory", "px")


def main() -> None:
    scenario()
    out = ROOT / "golden" / "store.repo.memory.json"
    out.write_text(
        json.dumps({"ops": OPS, "results": RESULTS}, ensure_ascii=False, indent=2,
                   sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"{out} —— {len(OPS)} 步")


if __name__ == "__main__":
    main()
