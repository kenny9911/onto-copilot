"""AI 推荐问题（面向 FDE）。

两条线：
  * 追问**跟着回答一起回来**（converse 的 next_questions），和答案同一刻上屏；
  * 模型没给时才另起一次 ``_ai_recommend``（开场提示走的也是它）——
    网关失败回退成 ``None``，调用方据此退回启发式。
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from ontocopilot import server
from ontocopilot.server import SESSIONS, Session, app
from ontocopilot.store.deps import get_repo, set_repo_for_tests
from ontocopilot.store.repo import FileRow, MemoryRepo, SessionRow


class _Comp:
    def __init__(self, data):
        self.data, self.text, self.usd = data, "", 0.001


class _BoomGw:
    async def call(self, *a, **k):
        raise RuntimeError("网关挂了")


class _OkGw:
    def __init__(self, data):
        self._data = data

    async def call(self, *a, **k):
        return _Comp(self._data)


def _patch_gw(monkeypatch, gw):
    monkeypatch.setattr(server, "_gateways", lambda *a, **k: (None, gw, None, None))


async def test_ai_recommend_returns_none_on_gateway_error(monkeypatch):
    _patch_gw(monkeypatch, _BoomGw())
    out = await server._ai_recommend(Session(id="r1"), slot="followup",
                                     user_text="q", reply="a")
    assert out is None


async def test_ai_recommend_normalizes_questions(monkeypatch):
    data = {"questions": [
        {"text": "死路在哪几处？", "send": "列出流程图里的死路"},
        {"text": "这些口径谁定？"},          # 无 send → 缺省等于 text
    ]}
    _patch_gw(monkeypatch, _OkGw(data))
    out = await server._ai_recommend(Session(id="r2"), slot="followup",
                                     user_text="q", reply="a")
    assert [x["text"] for x in out] == ["死路在哪几处？", "这些口径谁定？"]
    assert out[0]["send"] == "列出流程图里的死路"
    assert out[1]["send"] == "这些口径谁定？"


async def test_ai_recommend_caps_and_drops_empty(monkeypatch):
    data = {"questions": [
        {"text": "一"}, {"text": ""}, {"text": "二"}, {"text": "三"}, {"text": "四"},
    ]}
    _patch_gw(monkeypatch, _OkGw(data))
    out = await server._ai_recommend(Session(id="r3"), slot="opening")
    assert [x["text"] for x in out] == ["一", "二", "三"]   # 去空 + 截到 3


async def test_ai_recommend_none_on_empty_result(monkeypatch):
    _patch_gw(monkeypatch, _OkGw({"questions": []}))
    out = await server._ai_recommend(Session(id="r4"), slot="followup",
                                     user_text="q", reply="a")
    assert out is None


# ══════════════════════════════════════════════════════════════════
#  追问和回答一起上屏（不另起一次调用）
# ══════════════════════════════════════════════════════════════════
class _Turn:
    """`_reason` 的返回：只带 `_chat_claimed` 真正读的那几个字段。"""

    def __init__(self, next_questions):
        self.answer = "查到了，采购计划有 12 个对象。"
        self.citations, self.followup, self.steps = [], "", []
        self.next_questions = next_questions


async def _fake(turn):
    return turn


@pytest.fixture
async def chat_client(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTOCOPILOT_AUTH", raising=False)
    monkeypatch.setattr(server, "ROOT", tmp_path)
    repo = MemoryRepo()
    await repo.create_session(SessionRow(id="rec1"))
    set_repo_for_tests(repo)
    SESSIONS["rec1"] = server.Session(id="rec1")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            yield c
    finally:
        set_repo_for_tests(None)
        SESSIONS.clear()


def _spy_background(monkeypatch) -> list:
    fired: list = []

    async def _spy(s, **kw):
        fired.append(kw.get("slot"))

    monkeypatch.setattr(server, "_emit_ai_prompts", _spy)
    return fired


async def test_answer_followups_ride_along_and_skip_the_extra_call(
        chat_client, monkeypatch):
    """核心回归：回答自带追问时，不再多起一次模型调用去猜他接下来问什么。

    那次调用实测比回答晚 7~8 秒才回来 —— 答案早读完了，chips 才在眼皮底下换。
    """
    fired = _spy_background(monkeypatch)
    qs = ["部分驳回这类异常怎么建模？", "这些事件流要哪些状态机字段？"]
    monkeypatch.setattr(server, "_reason", lambda *a, **k: _fake(_Turn(qs)))

    r = await chat_client.post("/api/sessions/rec1/chat", json={"text": "有哪些对象"})
    assert r.status_code == 200
    body = r.json()
    assert [x["text"] for x in body["followups"]] == qs
    # 点下去发出去的就是它显示的那句话
    assert [x["send"] for x in body["followups"]] == qs
    await asyncio.sleep(0)
    assert fired == []


async def test_no_model_questions_never_costs_a_round_trip(
        chat_client, monkeypatch):
    """模型漏填时用启发式顶上，**不在这条请求里再买一次推荐**。

    曾经在这里补算过一次。它是 inline await，而答案早就通过 SSE 上屏、思考气泡
    也收了 —— 用户读完就去点 chips，这条请求却还攥着 chat lease 没还，那一下
    点击直接吃 409「已有一轮对话正在处理」，连输入框里的字都被清掉。
    网关挂掉时更糟：答案自己重试完 6~9 秒，补算再对着同一个死网关重试一遍。

    也不许甩后台 task —— 那个 task 会活过 chat lease，成为无主的 writer。
    """
    fired = _spy_background(monkeypatch)
    monkeypatch.setattr(server, "_reason", lambda *a, **k: _fake(_Turn([])))
    seen: list[str] = []

    async def recommend(_s, *, slot, **_kw):
        seen.append(slot)

    monkeypatch.setattr(server, "_ai_recommend", recommend)

    r = await chat_client.post("/api/sessions/rec1/chat", json={"text": "有哪些对象"})
    assert r.status_code == 200
    assert r.json()["followups"]            # 启发式那批顶上，chips 不会空着
    assert seen == []                       # 没有 inline 的付费往返
    assert fired == []                      # 也没有无主后台 writer


async def test_reasoning_panel_gets_the_thinking_not_the_questions(monkeypatch):
    """推理面板记的是**它在想什么**，算出来的问题属于聊天窗口的 chips。

    以前那里还抄一份截断到 18 字的问题列表：点不了、看不全，还让人以为回答
    还没完 —— 产物摆错了地方。
    """
    _patch_gw(monkeypatch, _OkGw({"questions": [{"text": "流程图里的死路在哪几处？"}]}))
    repo = MemoryRepo()
    await repo.create_session(SessionRow(id="r5"))
    set_repo_for_tests(repo)
    s = Session(id="r5")
    try:
        await server._emit_ai_prompts(s, slot="opening")
    finally:
        set_repo_for_tests(None)

    aux = [e for e in s.events if e.get("kind") == "chat.step"]
    assert len(aux) == 1                                   # 只留「想推荐问题」那一条
    assert "死路" not in json.dumps(aux, ensure_ascii=False)
    ready = [e for e in s.events if e.get("kind") == "prompts.ready"]
    assert [q["text"] for q in ready[0]["questions"]] == ["流程图里的死路在哪几处？"]


# ══════════════════════════════════════════════════════════════════
#  每一次交互结束，聊天窗口里都要有「接下来能问什么」
# ══════════════════════════════════════════════════════════════════
async def test_followups_survive_reopening_the_session(chat_client, monkeypatch):
    """核心回归：chips 以前只活在前端内存里。

    隔一天回来打开同一个会话，对着一段旧对话，"接下来能问什么"一条不剩 ——
    而那正是最需要它的时刻。
    """
    _spy_background(monkeypatch)
    qs = ["部分驳回这类异常怎么建模？", "这些事件流要哪些状态机字段？"]
    monkeypatch.setattr(server, "_reason", lambda *a, **k: _fake(_Turn(qs)))
    await chat_client.post("/api/sessions/rec1/chat", json={"text": "有哪些对象"})

    # **真的重开一次。** 只查 /state 是不够的：那会命中 SESSIONS 里同一个内存
    # 对象，一个字节都没经过仓储。把它踢出去，逼 /state 走 hydrate。
    SESSIONS.pop("rec1", None)
    st = (await chat_client.get("/api/sessions/rec1/state")).json()
    assert [x["text"] for x in st["followups"]] == qs

    # 并发的梳理 checkpoint 撞 CAS 时，chat 侧只重发 _CHAT_OWNED_DOCS 里的键；
    # followups 漏在外面的话，这一轮的 chips 会被静默丢弃。
    assert "followups" in server._CHAT_OWNED_DOCS


async def test_stopped_turn_still_leaves_an_exit_without_paying(
        chat_client, monkeypatch):
    """他刚按了停止，这时候再自作主张买一次推荐是逆着他的意思来；

    但「接下来干什么」比平时更需要一个出口 —— 用不花钱的那批。
    """
    seen: list[str] = []
    monkeypatch.setattr(server, "_ai_recommend",
                        lambda *a, **k: seen.append("paid") or _none())

    async def cancelled(*_a, **_k):
        raise asyncio.CancelledError

    monkeypatch.setattr(server, "_reason", cancelled)
    r = await chat_client.post("/api/sessions/rec1/chat", json={"text": "梳理一下"})
    body = r.json()
    assert body["stopped"] is True
    assert body["followups"]                          # 停了也有出口
    assert seen == []                                 # 但没为此花钱


async def test_every_chat_exit_carries_followups(chat_client, monkeypatch):
    """三个出口 —— 正常回答、确认重放、被停止 —— 都不许交出空 chips。"""
    _spy_background(monkeypatch)
    monkeypatch.setattr(server, "_ai_recommend", lambda *a, **k: _none())
    monkeypatch.setattr(server, "_reason", lambda *a, **k: _fake(_Turn([])))

    normal = await chat_client.post("/api/sessions/rec1/chat", json={"text": "有哪些对象"})
    assert normal.json()["followups"], "正常回答"

    server.SESSIONS["rec1"].state["_pending_actions"] = [
        {"kind": "noop", "args": {}}]
    monkeypatch.setattr(server, "_replay_pending",
                        lambda *a, **k: _text("改好了。"))
    replay = await chat_client.post("/api/sessions/rec1/chat",
                                    json={"text": "确认", "confirm": True})
    assert replay.json()["replayed"] is True
    assert replay.json()["followups"], "确认重放"


async def test_dropping_a_material_replaces_the_chips_durably(
        chat_client, monkeypatch, tmp_path):
    """撤掉一份材料之后，chips 不能还在问那份材料里有什么。

    回归点在**持久化**：`_persist` 只做 upsert，`state.pop("followups")` 对库
    是个 no-op —— 换个 worker hydrate 一次，作废的 chips 原样回来。
    """
    _spy_background(monkeypatch)
    monkeypatch.setattr(server, "_reason",
                        lambda *a, **k: _fake(_Turn(["a.csv 里有什么？"])))
    s = SESSIONS["rec1"]
    (s.dir / "materials").mkdir(parents=True, exist_ok=True)
    path = s.dir / "materials" / "a.csv"
    path.write_text("列1,列2\n1,2\n", encoding="utf-8")
    s.files = [{"name": "a.csv", "size": path.stat().st_size,
                "path": str(path), "sha256": "x"}]
    await get_repo().add_files(s.id, [FileRow(
        name="a.csv", rel_path="rec1/materials/a.csv",
        size=path.stat().st_size, sha256="x",
    )])
    await chat_client.post("/api/sessions/rec1/chat", json={"text": "看看材料"})
    assert s.state["followups"][0]["text"] == "a.csv 里有什么？"

    r = await chat_client.delete("/api/sessions/rec1/files/a.csv")
    assert r.status_code == 200
    assert r.json()["prompts"], "删完要给出新的开场提示"

    # 重开：库里那份必须也已经作废，而不只是内存里没了
    SESSIONS.pop("rec1", None)
    st = (await chat_client.get("/api/sessions/rec1/state")).json()
    assert st["followups"] == []
    assert st["prompts"]


async def _none():
    return None


async def _text(x: str) -> str:
    return x
