"""意图识别 —— 把一句自然语言落到一个**封闭集合**上。

产品里最容易做错的一步是"把用户说的话整个丢给模型，让它自由发挥"。那样做有两个
后果：一是不可审计（同一句话两次跑出不同动作，事后没人说得清为什么），二是不可
拒绝（模型总能编出一个动作来，哪怕它根本没听懂）。

这里的做法相反：

1. **意图是封闭集合。** 每个意图有确定的槽位和确定的执行器。集合之外的一律落到
   :attr:`Intent.UNKNOWN`，由上层去反问，而不是勉强归类。
2. **规则先判。** 引用了问题编号、点了建议序号、说了"别要/排除"——这些规则判得
   比模型准，也不花钱（ADR-5）。规则判不了才上模型。
3. **一句话可能有多个意图。** "第3条采纳，另外临时表别要了"是两件事，必须拆开，
   否则执行器只会做前一件。
4. **低置信度不猜。** 置信度低于阈值时返回 UNKNOWN 并附上候选，让上层反问 ——
   猜错一个 SET_SCOPE 会静默删掉一批对象，代价远高于多问一句。

模型判定走**结构化输出**，且只在规则失败时调用；判出来的结果仍要过一遍槽位校验，
模型说 "adopt suggestion sg-99" 而这个 id 不存在，照样降级成 UNKNOWN。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

__all__ = ["Intent", "IntentMatch", "IntentParse", "RuleIntentParser",
           "INTENT_SCHEMA", "split_clauses"]


class Intent(StrEnum):
    """封闭意图集合。新增意图必须同时给出槽位与执行器，否则不许加。"""

    ANSWER_QUESTION = "answer_question"    # 回答某个澄清问题
    ADOPT_SUGGESTION = "adopt_suggestion"  # 采纳建议
    REJECT_SUGGESTION = "reject_suggestion"
    SET_CALIBER = "set_caliber"            # 约定口径
    SET_NAMING = "set_naming"              # 约定命名
    SET_SCOPE = "set_scope"                # 纳入/排除一批对象
    CORRECT = "correct"                    # 纠正系统的某个判断
    EXPLAIN = "explain"                    # 要求解释某个判断
    RERUN = "rerun"                        # 重跑某段/某节点
    START_BUILD = "start_build"            # 开始梳理
    ASK_STATUS = "ask_status"              # 现在什么情况
    ADD_CONTEXT = "add_context"            # 补充背景，不触发动作
    CHITCHAT = "chitchat"
    UNKNOWN = "unknown"


#: 会改变产物的意图。这些执行前要回显确认 —— 静默改掉一批对象是最难发现的错误。
MUTATING = frozenset({Intent.ADOPT_SUGGESTION, Intent.SET_SCOPE, Intent.CORRECT,
                      Intent.RERUN, Intent.ANSWER_QUESTION, Intent.START_BUILD})


@dataclass(slots=True)
class IntentMatch:
    """一个意图及其槽位。"""

    intent: Intent
    #: 0~1。规则命中给高分，模型判定用它自己的分。
    confidence: float = 0.0
    #: 槽位。不同意图槽位不同，校验在 :meth:`IntentParse.validated` 里做。
    slots: dict[str, Any] = field(default_factory=dict)
    #: 原句里触发这个判定的片段。回显给用户看"我是这么理解你的"。
    span: str = ""
    #: 规则名或 "llm"。审计时要能区分这一条是怎么判出来的。
    by: str = ""

    @property
    def mutating(self) -> bool:
        return self.intent in MUTATING

    def to_dict(self) -> dict[str, Any]:
        return {"intent": str(self.intent), "confidence": round(self.confidence, 2),
                "slots": self.slots, "span": self.span, "by": self.by}


@dataclass(slots=True)
class IntentParse:
    """一整句话的解析结果 —— 可能含多个意图。"""

    text: str
    matches: list[IntentMatch] = field(default_factory=list)

    @property
    def confident(self) -> list[IntentMatch]:
        return [m for m in self.matches if m.intent is not Intent.UNKNOWN]

    @property
    def needs_clarification(self) -> bool:
        """一个都没判出来，或者全是低置信度 —— 该反问而不是硬做。"""
        return not self.confident

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "matches": [m.to_dict() for m in self.matches]}


# ══════════════════════════════════════════════════════════════════
#  分句
# ══════════════════════════════════════════════════════════════════
#: 并列连词。"第3条采纳，另外临时表别要了"是两件事 —— 不拆的话执行器只做前一件。
#: 英文只在 "and also" 处拆（纯 "and" 太容易误拆 "temp and staging tables"）。
_CONJ = re.compile(r"[；;。\n]+|，\s*(?=另外|还有|以及|同时|再有|顺便|此外|并且)|"
                   r",?\s+and\s+also\s+", re.I)


def split_clauses(text: str) -> list[str]:
    """把一句话拆成可以各自判意图的分句。

    只在**强分隔符**和并列连词处拆。逗号本身不拆 —— "如果没有字段，就先按接口反推"
    拆开之后两半都变成了别的意思。
    """
    parts = [p.strip(" ，,、") for p in _CONJ.split(text or "")]
    return [p for p in parts if p]


# ══════════════════════════════════════════════════════════════════
#  规则层
# ══════════════════════════════════════════════════════════════════
_NUM = r"(\d{1,3})"
#: 引用某个问题：#12 / 第3个问题 / 问题5 / Q7 / question 5
#: 注意 "question" 的分支要排在 "Q" 前面，且 Q 必须后跟数字 —— 否则 [Qq] 会先
#: 咬住 "question" 里的那个 q，导致 n=0 判不出。
_Q_REF = re.compile(rf"(?:#|问题\s*|第\s*{_NUM}\s*(?:个|条)?\s*问题|question\s*|\b[Qq](?=\s*\d))"
                    rf"\s*{_NUM}?", re.I)
#: 引用某条建议：第3条建议 / 建议2 / 第 3 条 / suggestion 2
_S_REF = re.compile(rf"(?:第\s*{_NUM}\s*条\s*建议|建议\s*{_NUM}|第\s*{_NUM}\s*条|suggestion\s*{_NUM})",
                    re.I)
#: 选项：选① / 第二个 / 选 B / 选项2 / option B / pick 2
#: 英文序数词（"the second one"）不在此列 —— 交给模型兜底，避免槽位歧义。
_OPT = re.compile(r"选\s*([①②③④⑤ABCDabcd\d])|第\s*([一二三四五12345])\s*个|"
                  r"(?:option|pick|choose)\s*([ABCDabcd\d])", re.I)

# 中英双语：中文规则要 CJK 才命中、英文规则要 ASCII 词才命中，两套互不串味，
# 所以合成一条正则、单一代码路径，既支持中文也支持英文命令（含混输）。
_ADOPT = re.compile(r"采纳|接受|同意|照(?:着)?做|就这么(?:办|干)|按你说的|可以，?\s*执行|同意执行|"
                    r"\b(?:adopt|accept|agree|go ahead|do it|sounds good|approve|apply it)\b", re.I)
_REJECT = re.compile(r"不采纳|不接受|否决|不同意|别(?:这么|那么)做|先不|算了|"
                     r"\b(?:reject|decline|do ?n'?t do|skip (?:it|that)|never ?mind|not now|no thanks)\b", re.I)
_EXCLUDE = re.compile(r"(?:都)?(?:别|不)要|排除|去掉|删掉|不(?:用|需要)(?:建模|进本体)|剔除|"
                      r"\b(?:exclude|drop|leave out|omit|get rid of|do ?n'?t (?:need|want|model))\b", re.I)
_INCLUDE = re.compile(r"要保留|留(?:着|下)|加回来|要(?:建模|进本体)|纳入|"
                      r"\b(?:include|keep|add back|bring back|retain)\b", re.I)
_EXPLAIN = re.compile(r"为什么|凭什么|依据是|怎么(?:得|判|看)出|从哪(?:看|来)|解释一下|说明一下理由|"
                      r"\b(?:why|explain|on what basis|how did you|justify|what makes you)\b", re.I)
# "重出模板"和"重新抽一遍"是两件代价差三个数量级的事，但都以"重"开头 ——
# 正则要都认得，分流交给槽位里的 phrase。
_RERUN = re.compile(r"重(?:跑|新|出|做|算|编译|生成)|再(?:跑|抽|来|生成)一?(?:遍|次)?|"
                    r"重新(?:分析|识别|编译|生成|梳理)|"
                    r"\b(?:re-?run|re-?do|regenerate|rebuild|recompile|re-?extract|"
                    r"run (?:it )?again|try again)\b", re.I)
#: 开始梳理。判在 _RERUN **之前** —— "重新梳理"两条都命中，但用户说"重新"时
#: 意思是重跑，说"开始"时意思是第一次跑。
_START = re.compile(r"^\s*(?:开始|跑一下|梳理一下|处理一下|分析一下|来吧|开工)|"
                    r"(?:开始|启动)(?:梳理|抽取|分析|处理)|把(?:材料|文件).{0,4}(?:梳理|处理|分析)|"
                    r"^\s*(?:start|begin|go|let'?s go|kick off|run it)\b|"
                    r"\b(?:start|begin) (?:the )?(?:build|modeling|extraction|analysis)\b", re.I)

_STATUS = re.compile(r"(?:现在|目前)?(?:什么|啥)(?:情况|进度|状态)|进度(?:怎么样|如何)|做到哪|跑完了吗|"
                     r"\b(?:status|progress|how'?s it going|are we done|done yet|where are we)\b", re.I)
#: 问句。「含税按专票算」是在**约定**口径，「我说的口径是什么」是在**问**它 ——
#: 只看关键词的话两者一模一样，而把提问记成一条新约定，等于用户每问一次就被
#: 悄悄改一次设定。
_QUESTION = re.compile(r"[?？]\s*$|^(?:什么|哪|谁|多少|怎么|如何|是否|有没有)|"
                       r"(?:是什么|有哪些|是多少|对不对|吗)\s*[?？]?\s*$|"
                       r"^(?:what|which|who|whose|how|why|when|where|is|are|do|does|can|"
                       r"could|should|would)\b", re.I)


def _is_question(c: str) -> bool:
    return bool(_QUESTION.search(c.strip()))


_CHITCHAT = re.compile(r"^\s*(?:你好|hi|hey|hello|在吗|谢谢|thanks?|thank you|辛苦了|好的|嗯+|"
                       r"ok|okay|great|cool|got it)\s*[!！。.~]*\s*$", re.I)

#: 口径词。这些词一出现，这句话几乎一定是在约定口径。
# 刻意不含"统一指/按/用"这类泛化说法 —— 它同样出现在命名约定里
# （"头表统一用 Header 后缀"），会把命名判成口径。判据要落在口径**本身的词**上。
_CALIBER = re.compile(r"含税|不含税|税率|口径|币种|本位币|折算|时间粒度|按(?:年|月|日|季)度?|"
                      r"自然(?:年|月)|财(?:年|月)|"
                      r"\b(?:tax[- ]?(?:in|ex)clusive|with(?:out)? tax|currency|granularity|"
                      r"fiscal (?:year|month)|caliber)\b", re.I)
_NAMING = re.compile(r"命名|前缀|后缀|驼峰|下划线|apiName|统一叫|统一用.{0,6}(?:命名|名字|后缀|前缀)|"
                     r"\b(?:naming|prefix|suffix|camel ?case|snake ?case|api ?name)\b", re.I)

#: 粘进来的结构化片段 —— DDL、JSON、接口定义。这是补充材料，不是指令。
_PASTED = re.compile(r"CREATE\s+TABLE|ALTER\s+TABLE|^\s*[{\[]|\bvarchar\s*\(|\bGET\s+/|\bPOST\s+/",
                     re.I | re.M)


class RuleIntentParser:
    """规则优先的意图解析。

    Args:
        question_ids: 当前待答问题的 id，按展示顺序。用户说"第3个问题"要能对上号。
        suggestion_ids: 当前建议的 id，按展示顺序。
        object_names: 已知对象名，用于把"临时表别要了"里的指代落到具体 rid 上。
    """

    def __init__(self, *, question_ids: list[str] | None = None,
                 suggestion_ids: list[str] | None = None,
                 object_names: list[str] | None = None) -> None:
        self.question_ids = list(question_ids or [])
        self.suggestion_ids = list(suggestion_ids or [])
        self.object_names = list(object_names or [])

    # ── 主入口 ──────────────────────────────────────────────────
    def parse(self, text: str) -> IntentParse:
        out: list[IntentMatch] = []
        for clause in split_clauses(text):
            m = self._one(clause)
            if m is not None:
                out.append(m)
        if not out:
            out.append(IntentMatch(Intent.UNKNOWN, 0.0, span=text, by="rule:none"))
        return IntentParse(text=text, matches=out)

    def _one(self, c: str) -> IntentMatch | None:
        # 顺序即优先级。先判**带明确指代**的，再判泛化的语气词 ——
        # "第3条采纳"里既有建议引用又有采纳动词，前者信息量更大。
        # 命名在口径**之前** —— 命名的判据（前缀/后缀/驼峰/apiName）更具体，
        # 而口径词更容易在别的语境里误命中。具体的先判。
        for probe in (self._chitchat, self._suggestion, self._question, self._scope,
                      self._naming, self._caliber, self._explain, self._start,
                      self._rerun, self._status, self._pasted):
            m = probe(c)
            if m is not None:
                return m
        return None

    # ── 各条规则 ────────────────────────────────────────────────
    def _chitchat(self, c: str) -> IntentMatch | None:
        if _CHITCHAT.match(c):
            return IntentMatch(Intent.CHITCHAT, 0.95, span=c, by="rule:chitchat")
        return None

    def _suggestion(self, c: str) -> IntentMatch | None:
        ref = _S_REF.search(c)
        adopt, reject = _ADOPT.search(c), _REJECT.search(c)
        if not (adopt or reject):
            return None
        sid = ""
        if ref:
            n = next((int(g) for g in ref.groups() if g), 0)
            if 1 <= n <= len(self.suggestion_ids):
                sid = self.suggestion_ids[n - 1]
        # 没点名但只有一条建议时，指代是无歧义的
        if not sid and len(self.suggestion_ids) == 1:
            sid = self.suggestion_ids[0]
        if not sid:
            # 说了"采纳"却对不上具体哪条 —— 这正是该反问的情形，不许猜
            return IntentMatch(Intent.UNKNOWN, 0.3, {"hint": "adopt_which"},
                               span=c, by="rule:suggestion_ambiguous")
        kind = Intent.REJECT_SUGGESTION if reject else Intent.ADOPT_SUGGESTION
        return IntentMatch(kind, 0.92, {"suggestion_id": sid}, span=c,
                           by="rule:suggestion")

    def _question(self, c: str) -> IntentMatch | None:
        ref = _Q_REF.search(c)
        opt = _OPT.search(c)
        if not (ref and (opt or "：" in c or ":" in c)):
            return None
        n = next((int(g) for g in ref.groups() if g), 0)
        if not (1 <= n <= len(self.question_ids)):
            return None
        slots: dict[str, Any] = {"question_id": self.question_ids[n - 1]}
        if opt:
            slots["option"] = next(g for g in opt.groups() if g)
        else:
            slots["answer"] = c.split("：", 1)[-1].split(":", 1)[-1].strip()
        return IntentMatch(Intent.ANSWER_QUESTION, 0.9, slots, span=c, by="rule:question")

    def _scope(self, c: str) -> IntentMatch | None:
        ex, inc = _EXCLUDE.search(c), _INCLUDE.search(c)
        if not (ex or inc):
            return None
        # 落到具体对象上。落不到就带着原话交给上层做模糊匹配 ——
        # 但**不许**在这里凭空猜一个模式去批量删。
        named = [n for n in self.object_names if n and n in c]
        slots: dict[str, Any] = {"action": "exclude" if ex else "include",
                                 "named": named, "phrase": c}
        conf = 0.88 if named else 0.55
        return IntentMatch(Intent.SET_SCOPE, conf, slots, span=c, by="rule:scope")

    def _caliber(self, c: str) -> IntentMatch | None:
        if _CALIBER.search(c) and not _EXPLAIN.search(c) and not _is_question(c):
            return IntentMatch(Intent.SET_CALIBER, 0.85, {"statement": c},
                               span=c, by="rule:caliber")
        return None

    def _naming(self, c: str) -> IntentMatch | None:
        if _NAMING.search(c) and not _EXPLAIN.search(c) and not _is_question(c):
            return IntentMatch(Intent.SET_NAMING, 0.85, {"statement": c},
                               span=c, by="rule:naming")
        return None

    def _explain(self, c: str) -> IntentMatch | None:
        if not _EXPLAIN.search(c):
            return None
        named = [n for n in self.object_names if n and n in c]
        return IntentMatch(Intent.EXPLAIN, 0.9, {"named": named, "question": c},
                           span=c, by="rule:explain")

    def _start(self, c: str) -> IntentMatch | None:
        # "重新/再来" 与 "again/re-run/redo" 都是重跑，不是首次开始 —— 让给 _rerun。
        if _START.search(c) and not re.search(r"重新|再来|重跑|again|re-?run|re-?do|regenerate",
                                              c, re.I):
            return IntentMatch(Intent.START_BUILD, 0.9, span=c, by="rule:start")
        return None

    def _rerun(self, c: str) -> IntentMatch | None:
        if _RERUN.search(c):
            return IntentMatch(Intent.RERUN, 0.85, {"phrase": c}, span=c, by="rule:rerun")
        return None

    def _status(self, c: str) -> IntentMatch | None:
        if _STATUS.search(c):
            return IntentMatch(Intent.ASK_STATUS, 0.9, span=c, by="rule:status")
        return None

    def _pasted(self, c: str) -> IntentMatch | None:
        if _PASTED.search(c) or len(c) > 200:
            return IntentMatch(Intent.ADD_CONTEXT, 0.8, {"content": c},
                               span=c[:80], by="rule:pasted")
        return None


# ══════════════════════════════════════════════════════════════════
#  模型层的输出契约
# ══════════════════════════════════════════════════════════════════
#: 规则判不出来时才用。要求模型**只**在封闭集合里选，并给出置信度 ——
#: 没有 "other" 这个逃生舱，判不出就得选 unknown，让上层去反问。
INTENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["matches"],
    "properties": {
        "matches": {
            "type": "array",
            "description": "一句话里的全部意图。判不出就给一条 unknown，不要硬凑。",
            "items": {
                "type": "object",
                "required": ["intent", "confidence", "span", "slots_json"],
                "properties": {
                    "intent": {"type": "string",
                               "enum": [str(i) for i in Intent]},
                    "confidence": {"type": "number",
                                   "description": "0~1。不确定就给低分，低分会转成反问，"
                                                  "比猜错强"},
                    "span": {"type": "string", "description": "原句里触发这个判定的片段，原样引用"},
                    "slots_json": {"type": "string",
                                   "description": "槽位 JSON 对象字符串。"
                                                  "answer_question 要 question_id/answer；"
                                                  "adopt_suggestion 要 suggestion_id；"
                                                  "set_scope 要 action(exclude|include)/named；"
                                                  "set_caliber/set_naming 要 statement；"
                                                  "explain 要 named/question。判不出就给 {}"},
                },
            },
        },
    },
}
