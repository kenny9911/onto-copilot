"""导出 server 段 A+H（Session / 租约 / 用量账本 / 钱的三种信号）的 golden。

字节确定：所有时间戳、uuid、路径都由本脚本固定，不读时钟、不读磁盘。

    .venv/bin/python tools/golden/server_core.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot import server                    # noqa: E402
from ontocopilot.kernel.errors import BudgetExhausted  # noqa: E402
from ontocopilot.kernel.llm import QuotaExhausted      # noqa: E402
from ontocopilot.store.repo import UsageRow            # noqa: E402

OUT = ROOT / "golden" / "server.core.json"

#: 固定时刻：2026-01-15T12:34:56Z。所有 ts 都从它派生。
T0 = 1768480496.0


# ── 1. 用量账本：sink 落下来的一行要逐字段对上 llm_usage ──────────────
def usage_sink_rows() -> list[dict]:
    cases = [
        # (sink 参数, 网关回调的 rec)
        ({"session_id": "s1", "kind": "build", "owner": "u1"},
         {"model": "openai/gpt-5.5", "run_id": "run_s1_abcd1234", "node_id": "extract.0",
          "effort": "high", "tok_in": 1200, "tok_out": 340, "cache_read": 90,
          "cache_write": 10, "usd": 0.0123, "usd_source": "gateway",
          "attempts": 2, "status": "ok"}),
        # 全空的 rec —— 每个字段的默认值都是账本契约的一部分
        ({}, {}),
        # kind=chat + 失败 + 估算金额
        ({"session_id": "s2", "kind": "chat", "owner": ""},
         {"model": "google/gemini-3.5-flash", "tok_in": 7, "usd": 0.0,
          "usd_source": "estimated", "attempts": 1, "status": "failed"}),
    ]
    out = []
    for kwargs, rec in cases:
        server._USAGE_BUF.clear()
        sink = server._usage_sink(**kwargs)
        # 冻住 time.time 与 uuid4，让导出字节确定
        real_time = server.time.time
        server.time.time = lambda: T0
        try:
            import uuid as _uuid
            real_uuid4 = _uuid.uuid4
            _uuid.uuid4 = lambda: types.SimpleNamespace(hex="deadbeef" * 4)
            try:
                sink(rec)
            finally:
                _uuid.uuid4 = real_uuid4
        finally:
            server.time.time = real_time
        row: UsageRow = server._USAGE_BUF[-1]
        out.append({"kwargs": kwargs, "rec": rec,
                    "row": {k: getattr(row, k) for k in (
                        "id", "ts", "day", "model", "owner", "session_id", "kind",
                        "run_id", "node_id", "effort", "tok_in", "tok_out",
                        "cache_read", "cache_write", "usd", "usd_source",
                        "attempts", "status")},
                    "total": row.total})
    server._USAGE_BUF.clear()
    return out


# ── 2. /api/usage 的报表形状 ──────────────────────────────────────────
class _FakeRepo:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    async def usage_since(self, since, owner=None, limit=5000):
        self.calls.append({"since": round(since, 6), "owner": owner, "limit": limit})
        return self.rows


def _row(**kw) -> UsageRow:
    base = dict(id="x", ts=T0, day="2026-01-15", model="m", owner="", session_id="",
                kind="build", run_id="", node_id="", effort="",
                tok_in=0, tok_out=0, cache_read=0, cache_write=0,
                usd=0.0, usd_source="estimated", attempts=1, status="ok")
    base.update(kw)
    return UsageRow(**base)


def usage_reports() -> list[dict]:
    rows = [
        _row(id="a", ts=T0, model="openai/gpt-5.5", kind="build", node_id="n1",
             tok_in=100, tok_out=50, cache_read=10, cache_write=5,
             usd=0.02, usd_source="gateway", attempts=1, status="ok", session_id="s1"),
        _row(id="b", ts=T0 - 3600, model="openai/gpt-5.5", kind="chat", node_id="n2",
             tok_in=7, tok_out=3, usd=0.0, usd_source="estimated", status="failed",
             session_id="s1"),
        _row(id="c", ts=T0 - 86400 * 2, model="google/gemini-3.5-flash", kind="build",
             node_id="n3", tok_in=1000, tok_out=2000, usd=0.5, usd_source="gateway",
             attempts=3, status="ok", session_id="s2"),
    ]
    scenarios = [
        {"name": "day/all", "rows": rows, "days": 5, "bucket": "day", "limit": 5000},
        {"name": "hour", "rows": rows, "days": 1, "bucket": "hour", "limit": 5000},
        {"name": "empty", "rows": [], "days": 3, "bucket": "day", "limit": 5000},
        # 全部 gateway 计费 → cost_note=billed
        {"name": "billed", "rows": [rows[0]], "days": 2, "bucket": "day", "limit": 5000},
        # limit 命中 → truncated
        {"name": "truncated", "rows": rows, "days": 2, "bucket": "day", "limit": 3},
        # 参数钳制：0 → 30 天；负 limit → 1；超界 → 365 / 50000
        {"name": "clamped", "rows": [], "days": 0, "bucket": "weird", "limit": 0},
        {"name": "clamped_hi", "rows": [], "days": 9999, "bucket": "day",
         "limit": 999999},
    ]

    real_time = server.time.time
    real_get_repo = server.get_repo
    out = []
    try:
        server.time.time = lambda: T0
        for sc in scenarios:
            repo = _FakeRepo(sc["rows"])
            server.get_repo = lambda repo=repo: repo
            req = types.SimpleNamespace(state=types.SimpleNamespace())
            res = asyncio.run(server.usage(req, days=sc["days"], bucket=sc["bucket"],
                                           limit=sc["limit"]))
            out.append({"name": sc["name"], "query": repo.calls, "report": res})
    finally:
        server.time.time = real_time
        server.get_repo = real_get_repo
    return out


# ── 3. 钱的三种信号 ───────────────────────────────────────────────────
def money_failures() -> list[dict]:
    quota = QuotaExhausted("openai/gpt-5.5", "insufficient_quota: 余额不足", status=402)
    cap = BudgetExhausted("usd", 15.0, 15.2)
    tokens = BudgetExhausted("tokens", 100.0, 101.0)

    wrapped = RuntimeError("节点炸了")
    wrapped.__cause__ = quota

    deep = RuntimeError("l1")
    mid = RuntimeError("l2")
    mid.__cause__ = cap
    deep.__cause__ = mid

    # 调度器把类型抹平成文本的那条路 —— 类型判据一条都认不出来，只剩字符串
    flattened_quota = RuntimeError(f"QuotaExhausted: {quota}")
    flattened_cap = RuntimeError("BudgetExhausted: usd 预算耗尽: 15 / 15")

    cases = [
        ("quota_direct", quota),
        ("cap_direct", cap),
        ("tokens_not_money", tokens),
        ("quota_via_cause", wrapped),
        ("cap_via_two_causes", deep),
        ("flattened_quota_text", flattened_quota),
        ("flattened_cap_text", flattened_cap),
        ("unrelated", ValueError("解析失败")),
    ]
    return [{"name": n, "signal": list(server._money_failure(e))} for n, e in cases]


# ── 4. Session 的公共投影与 Run id ────────────────────────────────────
def session_shapes() -> list[dict]:
    out = []
    s = server.Session(id="sess-1")
    s.created = T0
    out.append({"name": "defaults", "brief": s.brief()})

    s2 = server.Session(id="sess-2", title="订单主数据", project="ACME",
                        project_id="p1", created=T0, status="done")
    s2.state["mode"] = "chat"
    s2.files = [{"name": "a.xlsx", "size": 10, "path": "/x/a.xlsx", "sha256": "aa"}]
    s2.error = "boom"
    out.append({"name": "populated", "brief": s2.brief()})
    return out


def run_ids() -> list[dict]:
    out = []
    for name, files in [
        ("empty", []),
        ("one", [{"name": "a.xlsx", "size": 1, "path": "/x/a.xlsx", "sha256": "aa"}]),
        # 顺序无关：同一批文件换个顺序必须给同一个 id
        ("two", [{"name": "b.csv", "size": 2, "path": "/x/b.csv", "sha256": "bb"},
                 {"name": "a.xlsx", "size": 1, "path": "/x/a.xlsx", "sha256": "aa"}]),
        ("two_reordered",
         [{"name": "a.xlsx", "size": 1, "path": "/x/a.xlsx", "sha256": "aa"},
          {"name": "b.csv", "size": 2, "path": "/x/b.csv", "sha256": "bb"}]),
        # 读不到内容时的兜底标记（路径一定不存在）
        ("missing", [{"name": "gone.xlsx", "size": 7,
                      "path": "/nonexistent/__gone__.xlsx"}]),
        ("cjk", [{"name": "材料 一.xlsx", "size": 3, "path": "/x/1", "sha256": "cc"}]),
    ]:
        s = server.Session(id="sess-1")
        s.files = [dict(f) for f in files]
        out.append({"name": name, "files": s.files, "run_id": server._run_id_for(s)})
    return out


def chat_recorder_ids() -> list[dict]:
    s = server.Session(id="sess-1")
    cases = [
        ("simple", "reason", {"text": "你好"}),
        ("list_input", "wording", ["a", "b"]),
        ("empty", "recommend", None),
    ]
    return [{"name": n, "kind": k, "input": v,
             "run_id": server._chat_recorder_run_id(s, kind=k, semantic_input=v)}
            for n, k, v in cases]


# ── 5. 租约 TTL 的钳制 ────────────────────────────────────────────────
def lease_ttls() -> list[dict]:
    import os
    out = []
    for raw in [None, "30", "5", "1", "0", "-3", "600", "abc", "", "12.5"]:
        prev = os.environ.get("ONTOCOPILOT_BUILD_LEASE_TTL")
        if raw is None:
            os.environ.pop("ONTOCOPILOT_BUILD_LEASE_TTL", None)
        else:
            os.environ["ONTOCOPILOT_BUILD_LEASE_TTL"] = raw
        try:
            ttl = server._configured_build_lease_ttl()
        finally:
            if prev is None:
                os.environ.pop("ONTOCOPILOT_BUILD_LEASE_TTL", None)
            else:
                os.environ["ONTOCOPILOT_BUILD_LEASE_TTL"] = prev
        out.append({"env": raw, "ttl": ttl,
                    "build_heartbeat": min(ttl / 3, 10.0),
                    "chat_heartbeat": min(ttl / 3, 5.0)})
    return out


def main() -> None:
    data = {
        "usage_sink": usage_sink_rows(),
        "usage_report": usage_reports(),
        "money_failure": money_failures(),
        "session_brief": session_shapes(),
        "run_id": run_ids(),
        "chat_recorder_run_id": chat_recorder_ids(),
        "lease_ttl": lease_ttls(),
        "card_event": {"kinds": list(server._CARD_EVENT_KINDS),
                       "cap": server._CARD_EVENT_CAP},
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
