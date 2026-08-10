"""对话推理。

这层最容易悄悄退化：随便一次改动就可能让所有问题都掉回"我没把握理解"，
或者让模型编出来的出处混进回答。下面每个用例钉的都是这两条线之一。
"""

from __future__ import annotations

import json

import pytest

from ontocopilot.kernel.critic import Severity
from ontocopilot.kernel.intent import Intent, IntentMatch, RuleIntentParser
from ontocopilot.kernel.tools import Danger, ToolRegistry
from ontocopilot.onto.converse import (
    ConversationAgent,
    check_grounding,
    needs_reasoning,
)


# ══════════════════════════════════════════════════════════════════
#  分流
# ══════════════════════════════════════════════════════════════════
def _m(intent: Intent) -> IntentMatch:
    return IntentMatch(intent, 0.9)


def test_unknown_goes_to_reasoning_not_to_an_apology():
    """核心回归。

    "采购包相关的对象都有哪些" 规则判不出意图，但它是个再正常不过的问题 ——
    该去查，不该让人重说一遍。判不出意图 ≠ 该反问。
    """
    assert needs_reasoning(_m(Intent.UNKNOWN), "采购包相关的对象都有哪些？")


def test_explain_always_reasons():
    assert needs_reasoning(_m(Intent.EXPLAIN), "为什么这两个对象有关系")


def test_state_answerable_intents_skip_the_model():
    """答案就在 state 里，跑一圈推理只是浪费钱和时间。"""
    for i in (Intent.ASK_STATUS, Intent.CHITCHAT, Intent.SET_CALIBER,
              Intent.ADOPT_SUGGESTION):
        assert not needs_reasoning(_m(i), "随便一句")


def test_evidence_words_force_reasoning_even_for_known_intents():
    """「依据是什么」哪怕挂在一个已知意图上，也得去查。"""
    assert needs_reasoning(_m(Intent.SET_CALIBER), "含税的口径依据在材料哪里？")
    assert needs_reasoning(_m(Intent.ASK_STATUS), "现在都有哪些对象？列一下")


def test_the_real_questions_from_the_session_all_reason():
    """三个真实提问，之前有两个掉进了反问。"""
    p = RuleIntentParser(object_names=["pbpHeader", "pbpLine"])
    for q in ["采购包相关的对象都有哪些？",
              "为什么 pbpHeader 和 pbpLine 之间应该有关系？依据在材料哪里？",
              "材料里关于「框架协议」是怎么说的？"]:
        m = max(p.parse(q).matches, key=lambda x: x.confidence)
        assert needs_reasoning(m, q), q


# ══════════════════════════════════════════════════════════════════
#  溯源校验
# ══════════════════════════════════════════════════════════════════
_OBS = [json.dumps({"chunks": [{"cite": "梳理表.xlsx!实体!R2-2", "text": "采购业务计划头"}]},
                   ensure_ascii=False)]


def test_fabricated_citation_is_caught():
    """编出处是最难被发现的一类错误 —— 长得跟真的一样，翻材料才发现没有。"""
    fs = check_grounding(
        {"answer": "有关系", "citations": ["梳理表.xlsx!实体!R99-99"], "confidence": 0.9},
        _OBS)
    assert any(f.code == "CITATION_FABRICATED" and f.severity is Severity.HIGH
               for f in fs)


def test_real_citation_passes():
    fs = check_grounding(
        {"answer": "有关系", "citations": ["梳理表.xlsx!实体!R2-2"], "confidence": 0.9},
        _OBS)
    assert not [f for f in fs if f.severity is Severity.HIGH]


def test_confident_but_uncited_is_flagged():
    """查过材料、给了高置信度、一条出处都不给 —— 典型的"看起来很确定其实没依据"。"""
    fs = check_grounding({"answer": "肯定有关系", "citations": [], "confidence": 0.95},
                         _OBS)
    assert any(f.code == "CITATION_MISSING" for f in fs)


def test_honest_uncertainty_is_not_punished():
    """查不到就说查不到，低置信度 + 空出处是**正确行为**，不该报错。"""
    fs = check_grounding({"answer": "材料里没写", "citations": [], "confidence": 0.2},
                         _OBS)
    assert not fs


def test_empty_answer_is_caught():
    fs = check_grounding({"answer": "", "citations": [], "confidence": 0.5}, _OBS)
    assert any(f.code == "ANSWER_EMPTY" for f in fs)


def test_malformed_output_is_caught():
    fs = check_grounding("不是字典", _OBS)
    assert any(f.code == "ANSWER_MALFORMED" for f in fs)


# ══════════════════════════════════════════════════════════════════
#  循环
# ══════════════════════════════════════════════════════════════════
class _Ctx:
    turn_id = "t1"
    bus = None
    approved = False


class _Comp:
    def __init__(self, data):
        self.data, self.text, self.usd = data, "", 0.001


class _Gw:
    """按脚本回放的网关。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    async def call(self, node_id, prompt, **kw):
        self.calls += 1
        return _Comp(self.script.pop(0) if self.script else
                     {"answer": "没有更多了", "citations": [], "confidence": 0.1})


def _registry() -> ToolRegistry:
    reg = ToolRegistry()

    @reg.fn("evidence.search", "检索材料", {"type": "object", "required": ["query"],
                                        "properties": {"query": {"type": "string"}}},
            danger=Danger.READ, scopes=("readonly",))
    def _s(ctx, query: str):
        return {"chunks": [{"cite": "梳理表.xlsx!实体!R2-2", "text": f"命中 {query}"}]}

    return reg


async def test_loop_calls_tools_then_answers_with_real_citations():
    gw = _Gw([
        {"kind": "tool", "thought": "先查材料", "tool": "evidence.search",
         "args_json": '{"query":"采购计划"}'},
        {"kind": "answer", "answer": "查到了", "citations": ["梳理表.xlsx!实体!R2-2"],
         "confidence": 0.9},
    ])
    turn = await ConversationAgent(gateway=gw, tools=_registry()).run(
        "采购计划有哪些对象", ctx=_Ctx())
    assert turn.answer == "查到了"
    assert turn.grounded
    # 一次工具步 + 一次收尾步。收尾步也要在轨迹里 —— "一步就答上来"的问题
    # （寒暄、凭经验回答）不发这一步的话，推理面板上什么都看不到，
    # 而那恰恰是最该让人核对它想了什么的时候。
    assert [x["tool"] for x in turn.steps] == ["evidence.search", ""]
    assert turn.steps[-1]["kind"] == "answer"


async def test_fabricated_citations_are_stripped_not_annotated():
    """发现编造就**当场删掉**，而不是附一句"可能有误" —— 后者把核对推给用户。"""
    gw = _Gw([
        {"kind": "tool", "thought": "查", "tool": "evidence.search",
         "args_json": '{"query":"x"}'},
        {"kind": "answer", "answer": "结论",
         "citations": ["梳理表.xlsx!实体!R2-2", "编的.xlsx!无!R9-9"], "confidence": 0.9},
    ])
    turn = await ConversationAgent(gateway=gw, tools=_registry()).run("问", ctx=_Ctx())
    assert turn.citations == ["梳理表.xlsx!实体!R2-2"]
    assert not turn.grounded


async def test_tool_failure_goes_back_to_the_model_not_up_as_a_crash():
    reg = _registry()
    gw = _Gw([
        {"kind": "tool", "thought": "查", "tool": "不存在的工具", "args_json": "{}"},
        {"kind": "answer", "answer": "那个工具没有", "citations": [], "confidence": 0.3},
    ])
    turn = await ConversationAgent(gateway=gw, tools=reg).run("问", ctx=_Ctx())
    assert "error" in str(turn.steps[0]["observation"])
    assert turn.answer == "那个工具没有"


async def test_gateway_failure_is_reported_not_swallowed():
    class _Boom:
        async def call(self, *a, **k):
            raise RuntimeError("网关挂了")

    turn = await ConversationAgent(gateway=_Boom(), tools=_registry()).run(
        "问", ctx=_Ctx())
    assert "网关挂了" in turn.answer
    assert not turn.grounded


async def test_step_budget_is_enforced():
    """转不出来就如实说，比让人干等三十秒好。"""
    gw = _Gw([{"kind": "tool", "thought": f"第{i}次", "tool": "evidence.search",
               "args_json": '{"query":"x"}'} for i in range(10)])
    turn = await ConversationAgent(gateway=gw, tools=_registry(), max_steps=3).run(
        "问", ctx=_Ctx())
    assert gw.calls <= 3
    # 3 次调用 = 2 次工具步 + 1 次收尾步
    assert len(turn.steps) <= 3
    assert turn.steps[-1]["kind"] == "answer"


async def test_steps_are_streamed_as_they_happen():
    """看不见的推理和编造的区别，用户分辨不出来。"""
    seen = []
    gw = _Gw([
        {"kind": "tool", "thought": "查一下", "tool": "evidence.search",
         "args_json": '{"query":"x"}'},
        {"kind": "answer", "answer": "好", "citations": [], "confidence": 0.4},
    ])
    await ConversationAgent(gateway=gw, tools=_registry()).run(
        "问", ctx=_Ctx(), on_step=seen.append)
    # 一个工具步回调两次（发起时、拿到 observation 后），收尾步回调一次
    assert len(seen) >= 3
    assert seen[0]["thought"] == "查一下"
    assert any("observation" in x for x in seen)
    assert seen[-1]["kind"] == "answer", "收尾步没有被流式发出"


async def test_conversation_tools_are_read_only():
    """对话不能静默改产物。能在闲聊里悄悄删掉 17 个对象的副驾是不能用的。"""
    reg = _registry()
    names = {t.spec.name for t in reg.for_scope("readonly")}
    assert names == {"evidence.search"}
    assert all(t.spec.danger is Danger.READ for t in reg.for_scope("readonly"))


async def test_the_final_answer_step_is_always_traced():
    """「你好」这类一步就答完的问题，也必须在轨迹里留下它想了什么。

    只在调工具时才发步骤的话，推理面板对寒暄和凭经验回答永远是空的 ——
    而看不见的推理和编造的区别，用户分辨不出来。
    """
    gw = _Gw([{"kind": "answer", "thought": "打招呼，不用查东西",
               "answer": "在", "citations": [], "confidence": 0.9}])
    seen = []
    turn = await ConversationAgent(gateway=gw, tools=_registry()).run(
        "你好", ctx=_Ctx(), on_step=seen.append)
    assert len(turn.steps) == 1
    assert turn.steps[0]["thought"] == "打招呼，不用查东西"
    assert seen and seen[-1]["kind"] == "answer"


async def test_an_empty_thought_is_reported_not_hidden():
    """模型把必填的 thought 填成空串是实测发生过的 —— required 只保证字段存在。
    与其显示一个空行，不如如实说它没交代。"""
    gw = _Gw([{"kind": "answer", "thought": "", "answer": "随便说说",
               "citations": [], "confidence": 0.5}])
    turn = await ConversationAgent(gateway=gw, tools=_registry()).run("问", ctx=_Ctx())
    assert "没有给出思考" in turn.steps[-1]["thought"]
