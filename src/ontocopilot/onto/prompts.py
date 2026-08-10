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
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

__all__ = ["Prompt", "opening_prompts", "followup_prompts"]


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
    # 已经跑完了：开场就该是产物相关的
    return [p.to_dict() for p in _done_prompts(f)[:3]]


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
                     status: str = "idle", limit: int = 3) -> list[dict[str, Any]]:
    """一次回答之后，给几条他多半想接着问的。

    优先从**回答内容**长出来（他刚读完，正想问的就是它），不够再用状态补。
    去重后截断 —— 提示多于三条就变成噪声，人会一条都不看。
    """
    a = str(answer or "")
    out: list[Prompt] = []
    seen: set[str] = set()

    for needle, text, group in _ECHO:
        if needle in a and text not in seen:
            out.append(Prompt(text, group))
            seen.add(text)
        if len(out) >= limit:
            return [p.to_dict() for p in out]

    f = _facts(state, files, status)
    for p in _done_prompts(f):
        if p.text in seen:
            continue
        out.append(p)
        seen.add(p.text)
        if len(out) >= limit:
            break

    if not out and f["n_files"] == 0:
        # 空会话里聊天，接着聊建模本身是最自然的
        out = [Prompt("这类项目一般怎么推进？", "先了解"),
               Prompt("我把材料传上来，你先看看？", "开始")]
    return [p.to_dict() for p in out[:limit]]
