"""开场与追问 —— 让人知道这里能问什么。

一个空白输入框对新用户是最不友好的界面：他知道这工具"能分析业务文档"，但不知道
该说什么才有用。而每次回答之后同样有个断层 —— 系统刚说完"有 3 个死路"，
他得自己想出"哪三个"这个问题。

两端是同一件事：**把系统当前知道的东西，翻译成他能点的下一步。**

设计上有两条纪律：

**建议必须从状态里长出来，不是写死的清单。** 没上传材料时问"这份材料里有多少个
对象"是荒谬的；跑完之后还提示"上传材料"同样荒谬。所以每条建议都带一个
``when`` 判据，状态不满足就不出。

**只出他答得上、且答了有用的。** 一个提示如果点下去得到的是"我查不到"，
它的净价值是负的 —— 用户会开始怀疑其余的提示。

**而且一条都不能少。** 这两个函数是整个产品"接下来能干什么"的兜底，
它们返回空列表，用户看到的就是一个没有任何出口的空白 —— 恰恰在最需要指路的
时候（回答没跑通、梳理失败、材料传完还没开跑）。所以下面每条路径末尾都有
:func:`_always`：状态再刁钻，也要给得出三条他现在真能问的。
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

__all__ = ["Prompt", "followup_prompts", "opening_prompts"]


@dataclass(slots=True)
class Prompt:
    """一条可以直接点的提示。"""

    text: str
    #: 分组，前端可以按它排版。
    group: str = ""
    #: 点下去实际发送的话。默认就是 text —— 只有在显示文案和实际问法需要
    #: 不同时才分开（"看看流程图" → "把流程图里的死路列出来"）。
    send: str = ""

    def __post_init__(self) -> None:
        if not self.send:
            self.send = self.text

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "send": self.send, "group": self.group}


@dataclass(slots=True)
class _Rule:
    when: Callable[[dict[str, Any]], bool]
    make: Callable[[dict[str, Any]], list[Prompt]]


def _facts(state: dict[str, Any], files: list[str], status: str) -> dict[str, Any]:
    """把会话状态压成建议规则要看的几个数。"""
    oir = (state.get("oir") or {}).get("stats") or {}
    flow = (state.get("flow") or {}).get("stats") or {}
    return {
        "files": files, "n_files": len(files), "status": status,
        "objects": oir.get("objects", 0), "properties": oir.get("properties", 0),
        "links": oir.get("links", 0), "rules": oir.get("rules", 0),
        "questions": oir.get("open_questions", 0),
        "flow_actions": flow.get("actions", 0), "flow_events": flow.get("events", 0),
        "dead_ends": flow.get("dead_ends", 0),
        "inferred_edges": flow.get("inferred_edges", 0),
        "suggestions": [x.get("title", "") for x in (state.get("suggestions") or [])],
        "pending": len(state.get("questions") or []),
        "artifacts": state.get("artifacts") or [],
        "decisions": len(state.get("decisions") or []),
    }


def _key(text: str) -> str:
    """比对"是不是同一句"用的归一化：去空白与常见标点。

    他打的是"这类项目一般怎么推进"，提示写的是"这类项目一般怎么推进？"——
    逐字比会认为是两句，然后把他刚问过的原样推回去。
    """
    return re.sub(r"[\s，。？?！!、,.：:；;（）()「」\"']", "", str(text or ""))


def _always(f: dict[str, Any]) -> list[Prompt]:
    """任何状态下都给得出的三条。**这是最后一道兜底，不许返回空。**

    按"他此刻手上有什么"分档，而不是按产物统计 —— 产物统计恰恰是那些刁钻状态
    （梳理失败、抽出来是空的）里最靠不住的东西。
    """
    if f["n_files"] == 0:
        return [Prompt("我手上有一堆业务流程文档，你能帮我做什么？", "先了解"),
                Prompt("这类本体建模项目一般怎么推进？", "先了解"),
                Prompt("我把材料传上来，你先看看？", "开始")]
    if f["status"] != "done":
        return [Prompt(f"这 {f['n_files']} 份材料里都有什么？", "看材料",
                       send="先概括一下这些材料的结构：几张表、各是什么形状、"
                            "哪些是流程说明"),
                Prompt("这些材料够不够做一轮梳理？还缺什么？", "看材料"),
                Prompt("先挑一份最关键的讲讲它在说什么", "看材料")]
    return [Prompt("这一轮梳理都抽出了什么？", "看产物"),
            Prompt("哪些结论是推断出来的、没有材料依据？", "核实"),
            Prompt("接下来我该跟客户确认哪些事？", "分工")]


# ══════════════════════════════════════════════════════════════════
#  开场
# ══════════════════════════════════════════════════════════════════
_OPENING: tuple[_Rule, ...] = (
    # 什么都没有 —— 这时候他最需要知道"不上传也能聊"
    _Rule(
        when=lambda f: f["n_files"] == 0,
        make=lambda f: [
            Prompt("我手上有一堆业务流程文档，你能帮我做什么？", "先了解"),
            Prompt("做本体建模时，主数据和事务数据怎么划分？", "先了解"),
            Prompt("客户的梳理表里同一个字段有两种口径，一般怎么处理？", "先了解"),
        ]),
    # 有材料没跑 —— 这时候该让他先看看材料里有什么，而不是直接花钱
    _Rule(
        when=lambda f: f["n_files"] > 0 and f["status"] != "done",
        make=lambda f: [
            Prompt(f"这 {f['n_files']} 份材料里都有什么？", "看材料",
                   send="先概括一下这些材料的结构：几张表、各是什么形状、哪些是流程说明"),
            Prompt("材料里有哪些业务流程节点？", "看材料"),
            Prompt("有哪些地方是写得含糊、需要跟客户确认的？", "看材料"),
        ]),
)


def opening_prompts(*, state: dict[str, Any], files: list[str],
                    status: str = "idle") -> list[dict[str, Any]]:
    """新会话（或刚上传完）时给的几条起手式。

    刻意不写"你好"这类寒暄提示 —— 提示的位置很贵，占一条就少一条真正有用的。
    """
    f = _facts(state, files, status)
    for r in _OPENING:
        if r.when(f):
            return [p.to_dict() for p in r.make(f)]
    # 已经跑完了：开场就该是产物相关的。产物统计全是 0（只抽到对象、没流程没规则、
    # 问题也答完了 —— 一个正常终态）时 _done_prompts 会空，兜底顶上。
    return [p.to_dict() for p in (_done_prompts(f) or _always(f))[:3]]


def _done_prompts(f: dict[str, Any]) -> list[Prompt]:
    out: list[Prompt] = []
    if f["flow_actions"]:
        out.append(Prompt(
            f"流程图抽出了 {f['flow_actions']} 个动作，有哪些环节是断的？", "流程",
            send="流程图里有哪些死路和悬空节点？分别是材料哪里没写清楚"))
    if f["inferred_edges"]:
        out.append(Prompt(
            f"有 {f['inferred_edges']} 条边是你补的，凭什么这么连？", "流程",
            send="流程图里被标成推断的那些边，分别是怎么连出来的？没有依据的话就说没有"))
    if f["questions"]:
        out.append(Prompt(f"{f['questions']} 个待澄清问题里，哪些最该先问？", "待办"))
    if f["objects"] and not f["properties"]:
        out.append(Prompt("为什么一个字段都没抽到？", "追问",
                          send="材料里为什么没有字段定义？我该跟客户要什么"))
    if f["rules"]:
        out.append(Prompt(f"{f['rules']} 条业务规则分别管哪些单据？", "追问"))
    return out


# ══════════════════════════════════════════════════════════════════
#  追问
# ══════════════════════════════════════════════════════════════════
#: 回答里出现这些词，说明有个自然的下一问。**从回答本身长出来**的追问，
#: 比从状态长出来的更贴 —— 用户刚读完那句话，正想问的就是它。
_ECHO: tuple[tuple[str, str, str], ...] = (
    ("查不到", "那我该跟客户要什么材料？", "补材料"),
    ("材料里没有", "那我该跟客户要什么材料？", "补材料"),
    ("没有写", "这一块要问客户哪些问题？", "补材料"),
    ("推断", "这个推断的依据是什么？没有依据就说没有", "核实"),
    ("死路", "这些断掉的环节，材料里是怎么写的？", "核实"),
    ("建议", "把这条建议的影响范围列一下", "核实"),
    ("口径", "材料里关于这个口径一共有几种说法？", "核实"),
    ("待确认", "这些待确认的，哪些是我自己能定的、哪些必须问客户？", "分工"),
)


def followup_prompts(*, answer: str, state: dict[str, Any], files: list[str],
                     status: str = "idle", limit: int = 3,
                     asked: Iterable[str] = ()) -> list[dict[str, Any]]:
    """一次回答之后，给几条他多半想接着问的。

    ``asked`` 是他这轮之前说过的话。**已经问过的不再推荐** —— 聊了十轮之后
    还把开场白推给他（"我手上有一堆业务流程文档，你能帮我做什么？"）是这套
    提示最伤人的失败模式：它证明系统没在听。

    优先从**回答内容**长出来（他刚读完，正想问的就是它），不够再用状态补，
    还不够就用 :func:`_always` 兜底。去重后截断 —— 提示多于三条就变成噪声，
    人会一条都不看。

    **不会返回空。** 以前只有"一份材料都没有"时才兜底，于是最常见的中间态
    （材料传了、还没梳理）和最需要指路的时刻（回答是"这轮没跑通：…"）
    反而一条提示都没有。
    """
    a = str(answer or "")
    out: list[Prompt] = []
    seen = {_key(x) for x in asked}

    def take(p: Prompt) -> None:
        if _key(p.text) not in seen:
            out.append(p)
            seen.add(_key(p.text))

    for needle, text, group in _ECHO:
        if needle in a:
            take(Prompt(text, group))
        if len(out) >= limit:
            return [p.to_dict() for p in out]

    f = _facts(state, files, status)
    for p in _done_prompts(f):
        take(p)
        if len(out) >= limit:
            break

    for p in _always(f):
        if len(out) >= limit:
            break
        take(p)
    # 全被"他已经问过"筛掉了 —— 一条提示都不给比重复一条更糟，原样顶上。
    return [p.to_dict() for p in (out or _always(f))[:limit]]
