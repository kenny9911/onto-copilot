"""意图解析 —— 中英双语（P9）。

不变式：同一个命令，中文与英文都落到**同一个** Intent，槽位一致；解析纯规则、
确定、零成本（ADR-5），两种语言都要保住。不强求两语言 confidence 逐位相等（那是
过度约束）。判不出来仍是 UNKNOWN，不硬凑成动作意图。
"""

from __future__ import annotations

import pytest

from ontocopilot.kernel.intent import Intent, RuleIntentParser


def _intents(parse):
    return [m.intent for m in parse.matches]


@pytest.mark.parametrize("text", ["你好", "hello", "thanks", "thank you", "hi!", "ok"])
def test_chitchat_both_langs(text):
    assert _intents(RuleIntentParser().parse(text)) == [Intent.CHITCHAT]


@pytest.mark.parametrize("text", ["采纳", "adopt", "accept", "go ahead", "sounds good"])
def test_adopt_single_suggestion(text):
    p = RuleIntentParser(suggestion_ids=["sg-1"]).parse(text)
    m = next((m for m in p.matches if m.intent == Intent.ADOPT_SUGGESTION), None)
    assert m is not None and m.slots["suggestion_id"] == "sg-1"


@pytest.mark.parametrize("text", ["不采纳", "reject", "decline", "no thanks"])
def test_reject_single_suggestion(text):
    assert Intent.REJECT_SUGGESTION in _intents(
        RuleIntentParser(suggestion_ids=["sg-1"]).parse(text))


def test_suggestion_ref_english():
    p = RuleIntentParser(suggestion_ids=["sg-1", "sg-2", "sg-3"]).parse("adopt suggestion 2")
    m = next(m for m in p.matches if m.intent == Intent.ADOPT_SUGGESTION)
    assert m.slots["suggestion_id"] == "sg-2"


@pytest.mark.parametrize("text,action", [
    ("临时表别要了", "exclude"),
    ("exclude temp tables", "exclude"),
    ("drop the staging tables", "exclude"),
    ("keep the header table", "include"),
    ("纳入", "include")])
def test_scope_both_langs(text, action):
    p = RuleIntentParser(object_names=["临时表", "temp"]).parse(text)
    m = next((m for m in p.matches if m.intent == Intent.SET_SCOPE), None)
    assert m is not None and m.slots["action"] == action


@pytest.mark.parametrize("text", ["为什么", "why", "explain", "on what basis"])
def test_explain(text):
    assert Intent.EXPLAIN in _intents(RuleIntentParser().parse(text))


@pytest.mark.parametrize("text", ["重跑", "rerun", "re-run", "run it again", "regenerate"])
def test_rerun(text):
    assert Intent.RERUN in _intents(RuleIntentParser().parse(text))


@pytest.mark.parametrize("text", ["开始", "start", "begin", "let's go"])
def test_start(text):
    assert Intent.START_BUILD in _intents(RuleIntentParser().parse(text))


def test_run_again_is_rerun_not_start():
    # "run it again" 既含 "run it" 又含 "again" —— 必须落 RERUN，不是 START。
    ints = _intents(RuleIntentParser().parse("run it again"))
    assert Intent.RERUN in ints and Intent.START_BUILD not in ints


@pytest.mark.parametrize("text", ["现在什么进度", "status", "are we done", "progress?"])
def test_status(text):
    assert Intent.ASK_STATUS in _intents(RuleIntentParser().parse(text))


def test_answer_question_option_english():
    p = RuleIntentParser(question_ids=["q-1", "q-2"]).parse("question 2: option B")
    m = next((m for m in p.matches if m.intent == Intent.ANSWER_QUESTION), None)
    assert m is not None and m.slots["question_id"] == "q-2" and m.slots["option"] == "B"


@pytest.mark.parametrize("text", ["随便写点什么放在这儿", "just some random musing over here"])
def test_unknown_stays_unknown(text):
    # 没有命令词 → 允许 UNKNOWN / add_context / chitchat，但**绝不能**误判成动作意图。
    p = RuleIntentParser().parse(text)
    for bad in (Intent.START_BUILD, Intent.RERUN, Intent.SET_SCOPE,
                Intent.ADOPT_SUGGESTION, Intent.REJECT_SUGGESTION):
        assert bad not in _intents(p)
