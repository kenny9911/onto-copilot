"""事件耐久性 —— "消息要刷新才出现"那个 bug 的回归网。

根因不在前端也不在聊天流程，在连接池：文件库被放在 StaticPool 上，整个进程共用
**一个** DBAPI 连接。SSE 每 250ms 轮询读、聊天那边在写，两者的事务边界互相穿插，
一方的 ROLLBACK 把另一方的写作废 —— session.next_event_seq 被回退到已提交行后面，
下一次 append 分配到用过的 seq 撞 UNIQUE，重试 5 次全撞同一个号，事件永远落不了库。
而 SSE 只推库里的行，于是助手的回答从界面上消失；对话记忆是另一条路存的，所以
刷新又看得到。
"""

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from ontocopilot.store.engine import Store
from ontocopilot.store.repo import SessionRow, build_repo


async def _open(tmp_path):
    store = await Store.open(f"sqlite+aiosqlite:///{tmp_path / 'e.db'}", create_all=True)
    repo = build_repo(store)
    await repo.create_session(SessionRow(id="s1", title="t", created=0))
    return store, repo


async def test_file_backed_sqlite_does_not_share_one_connection(tmp_path):
    """StaticPool 把同一个连接同时交给每个并发 checkout —— 对内存库是必须的，
    对文件库是灾难。"""
    from sqlalchemy.pool import StaticPool

    store, _ = await _open(tmp_path)
    try:
        assert not isinstance(store.engine.pool, StaticPool)
        async with store.engine.connect() as a, store.engine.connect() as b:
            ida = await a.run_sync(lambda c: id(c.connection.dbapi_connection))
            idb = await b.run_sync(lambda c: id(c.connection.dbapi_connection))
        assert ida != idb, "两个并发连接还是同一个 DBAPI 连接"
    finally:
        await store.close()


async def test_events_survive_concurrent_reads_and_writes(tmp_path):
    """SSE 在轮询读的同时聊天在写 —— 这正是真实运行时的样子。"""
    store, repo = await _open(tmp_path)
    try:
        stop = False

        async def poll():
            while not stop:
                await repo.read_events("s1", since=0)
                await asyncio.sleep(0.005)

        pollers = [asyncio.create_task(poll()) for _ in range(2)]
        for _ in range(6):
            await asyncio.gather(*[
                repo.append_event("s1", "chat.turn", {"n": i}) for i in range(4)])
        stop = True
        await asyncio.gather(*pollers)

        rows = await repo.read_events("s1", since=0)
        assert len(rows) == 24, f"丢了事件：只有 {len(rows)}/24"
        assert len({r.seq for r in rows}) == 24, "seq 重号"
        nxt = sqlite3.connect(tmp_path / "e.db").execute(
            "select next_event_seq from session").fetchone()[0]
        assert nxt > max(r.seq for r in rows), "计数器回退到了已提交行后面"
    finally:
        await store.close()


async def test_a_rewound_counter_heals_itself(tmp_path):
    """已经被搅坏的会话必须能自己恢复 —— 用户库里就有一个（bfd1016b707f：
    9 轮对话，事件表里只有 1 条）。光换连接池救不了它：计数器还指着 0，
    下一次 append 照样撞。"""
    store, repo = await _open(tmp_path)
    try:
        for i in range(3):
            await repo.append_event("s1", "chat.turn", {"n": i})
        # 手动把计数器搅回去，重现坏掉的状态
        db = sqlite3.connect(tmp_path / "e.db")
        db.execute("update session set next_event_seq=0"); db.commit(); db.close()

        row = await repo.append_event("s1", "chat.turn", {"n": "heal"})
        assert row.seq == 3, f"没有从表里兜底，分配到了 {row.seq}"
        assert len(await repo.read_events("s1", since=0)) == 4
        # 计数器也修回来了，下一条继续往前走
        assert (await repo.append_event("s1", "chat.turn", {"n": "next"})).seq == 4
    finally:
        await store.close()


async def test_total_persistence_failure_is_logged_not_swallowed(tmp_path, caplog):
    """丢事件是数据丢失。这次 bug 里服务器日志一个字都没有 —— 从外面看就是
    "模型答了、界面空着"，没有任何线索。"""
    from ontocopilot.session_events import DurableEventHub

    class _Boom:
        async def get_session(self, sid): return object()
        async def append_event(self, *a, **k): raise RuntimeError("库炸了")

    class _Sess:
        id = "s1"
        def __init__(self): self.events, self.subscribers = [], []

    hub = DurableEventHub(max_attempts=1)
    sess = _Sess()
    with caplog.at_level("ERROR"):
        hub.enqueue(sess, _Boom(), "chat.turn", {"turn": {"text": "hi"}})
        await hub.flush()
    assert any("chat.turn" in r.getMessage() for r in caplog.records), \
        "落库失败没有留下任何日志"
    assert any(e.get("kind") == "event.persist_failed" for e in sess.events)
