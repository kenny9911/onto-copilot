"""对话记忆。

这层的全部价值在一条铁律上：**轮次可以被压掉，决定不行。**
下面每个用例都在钉这条线的某一段。
"""

from __future__ import annotations

from ontocopilot.kernel.memory.dialogue import (
    DecisionKind,
    DialogueMemory,
    Speaker,
    Utterance,
    heuristic_digest,
)
from ontocopilot.kernel.memory.long_term import LongTermStore, PromotionReason
from ontocopilot.kernel.memory.types import MemoryKind


def _chatty(dm: DialogueMemory, n: int = 12) -> None:
    for i in range(n):
        dm.say("user", f"第 {i} 轮随便问点什么，这句话没什么信息量但是很占地方啊啊啊")
        dm.say("assistant", f"第 {i} 轮的回复，同样很长很占地方嗯嗯嗯嗯嗯嗯嗯嗯")


# ══════════════════════════════════════════════════════════════════
#  压缩
# ══════════════════════════════════════════════════════════════════
def test_decisions_survive_any_amount_of_compaction():
    """核心用例。

    滚动窗口式的对话历史在这里必然失败：第 3 轮那句口径约定会滑出窗口，
    而它恰恰是最该活到最后的东西。
    """
    dm = DialogueMemory(budget_tokens=200, keep_verbatim=3)
    dm.say("user", "含税一律指增值税专用发票口径")
    dm.decide(DecisionKind.CALIBER, "含税一律指增值税专用发票口径")
    _chatty(dm, 20)

    assert dm.compact_to_fit() > 0
    assert len(dm) <= 5  # 轮次被压得只剩尾巴
    assert "增值税专用发票" in dm.render_decisions()


def test_compaction_keeps_refs_from_dropped_turns():
    """指代消解只靠 refs 活着 —— 原文压没了，"刚才那几个对象"还得能对上。"""
    dm = DialogueMemory(budget_tokens=120, keep_verbatim=2)
    dm.say("user", "看看 pbpHeader", refs=["ot_pbpheader"])
    dm.say("assistant", "它有 3 个行动", refs=["ot_pbpheader"])
    _chatty(dm, 8)
    dm.compact_to_fit()

    head = dm.turns[0]
    assert head.compressed
    assert "ot_pbpheader" in head.refs


def test_compaction_is_idempotent_once_everything_is_compressed():
    dm = DialogueMemory(budget_tokens=1, keep_verbatim=1)
    _chatty(dm, 4)
    dm.compact()
    assert dm.compact() is False  # 已经压过的不再重复压，否则会无限循环


def test_heuristic_digest_keeps_user_side():
    """助手的话可以重新生成，用户的输入不能 —— 压缩时牺牲助手侧是刻意的。"""
    turns = [Utterance(Speaker.USER, "临时表都别要"),
             Utterance(Speaker.ASSISTANT, "好的，已排除 17 个"),
             Utterance(Speaker.USER, "口径按含税算")]
    d = heuristic_digest(turns)
    assert "临时表都别要" in d
    assert "口径按含税算" in d


def test_short_dialogue_is_never_compacted():
    dm = DialogueMemory(budget_tokens=1, keep_verbatim=8)
    dm.say("user", "你好")
    assert dm.compact() is False


# ══════════════════════════════════════════════════════════════════
#  决定的生命周期
# ══════════════════════════════════════════════════════════════════
def test_later_decision_supersedes_but_does_not_delete():
    """用户改主意的过程本身是信息，删掉就没法审计"当时为什么那样做"。"""
    dm = DialogueMemory()
    dm.decide(DecisionKind.CALIBER, "含税指专票口径")
    dm.decide(DecisionKind.CALIBER, "改了，含税指普票口径")

    assert [d.statement for d in dm.active_decisions()] == ["改了，含税指普票口径"]
    assert len(dm.decisions) == 2
    assert dm.decisions[0].superseded_by == 1


def test_different_scopes_coexist_instead_of_overriding():
    """「临时表都不要」和「但这一张要留」不是矛盾，是细化。"""
    dm = DialogueMemory()
    dm.decide(DecisionKind.SCOPE, "临时表都不要")
    dm.decide(DecisionKind.SCOPE, "clmSpaImportTmp 要留", scope_refs=["ot_clmspaimporttmp"])
    assert len(dm.active_decisions()) == 2


def test_decisions_filter_by_refs_includes_global_ones():
    """节点只该背上和自己相关的决定，但全局决定对谁都算数。"""
    dm = DialogueMemory()
    dm.decide(DecisionKind.CALIBER, "全局：含税口径")
    dm.decide(DecisionKind.CORRECTION, "pbpLine 不是实体", scope_refs=["ot_pbpline"])
    dm.decide(DecisionKind.CORRECTION, "别的对象的事", scope_refs=["ot_other"])

    got = {d.statement for d in dm.active_decisions(refs=["ot_pbpline"])}
    assert got == {"全局：含税口径", "pbpLine 不是实体"}


def test_decision_records_which_turn_it_came_from():
    """审计要能回到原话 —— 摘要过的转述不能当依据。"""
    dm = DialogueMemory()
    dm.say("user", "第一句")
    dm.say("user", "含税按专票算")
    d = dm.decide(DecisionKind.CALIBER, "含税按专票算")
    assert d.turn_index == 1
    assert dm.turns[d.turn_index].text == "含税按专票算"


# ══════════════════════════════════════════════════════════════════
#  晋升长期库
# ══════════════════════════════════════════════════════════════════
def test_only_cross_run_kinds_are_promotable():
    """回答某个问题、采纳某条建议都是就事论事的。

    把它们固化成长期约束，下一个项目会继承一堆和它毫无关系的结论 ——
    长期记忆一旦污染，后续所有 Run 都受影响。
    """
    dm = DialogueMemory()
    dm.decide(DecisionKind.CALIBER, "含税指专票")
    dm.decide(DecisionKind.NAMING, "头表统一 Header 后缀")
    dm.decide(DecisionKind.SCOPE, "临时表不要")
    dm.decide(DecisionKind.ANSWER, "选第二个", scope_refs=["q_1"])
    dm.decide(DecisionKind.ADOPTION, "采纳建议 3", scope_refs=["sg-headline"])

    items = dm.promotable(run_id="r1")
    assert len(items) == 3
    assert all("选第二个" not in m.content and "采纳建议" not in m.content for m in items)


def test_naming_decisions_become_conventions_not_decisions():
    """命名规范和"这次这么定"不是一回事，检索时的打分也不同。"""
    dm = DialogueMemory()
    dm.decide(DecisionKind.NAMING, "头表统一 Header 后缀")
    dm.decide(DecisionKind.CALIBER, "含税指专票")
    kinds = {m.kind for m in dm.promotable(run_id="r1")}
    assert kinds == {MemoryKind.CONVENTION, MemoryKind.DECISION}


def test_promoted_decisions_carry_support_so_the_gate_accepts_them():
    """没有 support 的记忆不许进长期库。对话决定的 support 就是那一轮本身。"""
    dm = DialogueMemory()
    dm.say("user", "含税指专票")
    dm.decide(DecisionKind.CALIBER, "含税指专票")
    item = dm.promotable(run_id="run_7")[0]
    assert item.support == ["dialogue:run_7:turn0"]

    store = LongTermStore(project="ONT-112")
    results = [store.promote(m, PromotionReason.HUMAN_CONFIRMED, run_id="run_7")
               for m in dm.promotable(run_id="run_7")]
    assert all(ok for ok, _ in results), results
    assert store.recall("含税", run_id="run_8")


def test_superseded_decisions_are_not_promoted():
    dm = DialogueMemory()
    dm.decide(DecisionKind.CALIBER, "旧口径")
    dm.decide(DecisionKind.CALIBER, "新口径")
    assert [m.content for m in dm.promotable(run_id="r1")] == ["新口径"]


# ══════════════════════════════════════════════════════════════════
#  持久化
# ══════════════════════════════════════════════════════════════════
def test_round_trip_preserves_supersession():
    """active 不是存出来的字段，靠 superseded_by 还原 —— 两处真相会打架。"""
    dm = DialogueMemory()
    dm.say("user", "一句话", refs=["ot_a"])
    dm.decide(DecisionKind.SCOPE, "旧范围")
    dm.decide(DecisionKind.SCOPE, "新范围")

    back = DialogueMemory.from_dict(dm.to_dict())
    assert len(back) == 1
    assert back.turns[0].refs == ["ot_a"]
    assert [d.statement for d in back.active_decisions()] == ["新范围"]
    assert back.decisions[0].superseded_by == 1


def test_round_trip_after_compaction():
    dm = DialogueMemory(budget_tokens=100, keep_verbatim=2)
    dm.decide(DecisionKind.CALIBER, "含税指专票")
    _chatty(dm, 10)
    dm.compact_to_fit()

    back = DialogueMemory.from_dict(dm.to_dict())
    assert back.compactions == dm.compactions
    assert back.turns[0].compressed
    assert "含税指专票" in back.render_decisions()


# ══════════════════════════════════════════════════════════════════
#  装配
# ══════════════════════════════════════════════════════════════════
def test_recent_turns_are_not_the_same_thing_as_decisions():
    """抽取节点不需要知道用户跟你寒暄过什么。"""
    dm = DialogueMemory()
    dm.say("user", "你好啊")
    dm.decide(DecisionKind.CALIBER, "含税指专票")
    assert "你好啊" in dm.render_recent()
    assert "你好啊" not in dm.render_decisions()


def test_empty_dialogue_renders_empty_not_noise():
    dm = DialogueMemory()
    assert dm.render_decisions() == ""
    assert dm.render_recent() == ""
