"""AI 推荐问题（面向 FDE）：网关失败时回退成 None（调用方退回启发式），
成功时把模型给的 questions 规范化成可点提示（send 缺省等于 text）。
"""

from __future__ import annotations

import ontocopilot.server as server
from ontocopilot.server import Session


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
