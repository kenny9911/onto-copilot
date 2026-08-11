"""对话推理 —— 用户问一句，系统真的去查、去想、再回答。

在此之前对话层是"规则判意图 → 套模板回复"。那套东西处理得了"采纳第 3 条"
这类**指令**，处理不了"为什么这两个对象有关系"、"这份材料里跟金额有关的口径
一共有几种说法"这类**问题** —— 后者没有固定答案，只能去查。

所以这里是两条路，不是一条：

    指令（规则判得出意图）  →  执行器，确定性，零模型调用，可重放
    问题（判不出或要查证）  →  推理循环：想 → 调工具 → 看结果 → 再想 → 回答

分流的判据不是"难不难"，是**答案在不在系统里**。"现在什么进度"的答案就在
state 里，查一下字典就行，让模型跑一圈只是浪费；"跟金额有关的口径有几种说法"
的答案散在 477 个切片里，只能检索。

推理循环的三条纪律：

1. **工具是只读的。** 对话可以查任何东西，但不能静默改产物 —— 要改必须走
   显式的执行器，并且回显改了什么。一个能在闲聊里悄悄删掉 17 个对象的副驾
   是不能用的。
2. **答案里的每个出处都必须来自工具返回。** 没查过就说不知道。这条由
   :class:`GroundingCritic` 强制，不是靠提示词祈祷。
3. **推理过程流式可见。** 用户要能看见它在查什么 —— 看不见的推理和编造的
   区别，用户是分辨不出来的。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from ..kernel.critic import Finding, Severity
from ..kernel.dag import Difficulty
from ..kernel.intent import Intent, IntentMatch

__all__ = ["ConverseTurn", "ConversationAgent", "ANSWER_SCHEMA",
           "needs_reasoning", "check_grounding"]


#: 推理循环的产出契约。
#:
#: ``citations`` 是**必填数组**而不是可选字段：可选的话模型会在不确定时干脆
#: 不给，而"没有出处的断言"正是这里要防的东西。宁可让它交一个空数组、然后被
#: critic 判不通过，也不要给它一个悄悄绕过的口子。
ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["thought", "answer", "citations", "confidence"],
    "properties": {
        "thought": {"type": "string", "minLength": 8,
                    "description": "你凭什么这么答，一到两句。会原样展示给用户 —— "
                                   "看不见的推理和编造的区别，他分辨不出来。不许留空"},
        "answer": {"type": "string",
                   "description": "给 FDE 看的回答。直接说结论，不要复述问题。"
                                  "查不到就说查不到 —— 编一个听起来合理的答案，"
                                  "代价是他拿着它去跟客户对话。"},
        "citations": {"type": "array", "items": {"type": "string"},
                      "description": "出处，原样抄工具返回里的 cite 字符串。"
                                     "**只能写你真的查到过的**；一条都没有就给空数组"},
        "confidence": {"type": "number", "description": "0~1"},
        "followup": {"type": "string",
                     "description": "如果回答依赖某个你无法确定的前提，把它写成一个问题；"
                                    "没有就留空"},
    },
}


# ══════════════════════════════════════════════════════════════════
#  分流
# ══════════════════════════════════════════════════════════════════
#: 答案就在系统状态里的意图 —— 查字典即可，跑推理循环纯属浪费。
_ANSWERABLE_FROM_STATE = frozenset({
    Intent.ASK_STATUS, Intent.CHITCHAT, Intent.SET_CALIBER, Intent.SET_NAMING,
    Intent.ADOPT_SUGGESTION, Intent.REJECT_SUGGESTION, Intent.ADD_CONTEXT,
    # 「开始梳理」「重出模板」是**指令**，不是问题。让推理循环去"查"该不该开始，
    # 它会认真地检索一圈然后回答"我查不到任何内容" —— 荒谬且花钱。
    Intent.START_BUILD, Intent.RERUN,
})

#: 这些词说明用户要的是解释或查证，即使意图判出来了也得去查。
_WANTS_EVIDENCE = re.compile(r"为什么|凭什么|依据|出处|哪来的|怎么(?:得|判|看)出|"
                             r"有几种|都有哪些|列一下|列出|找一找|查一下|对不对|真的吗")


def needs_reasoning(match: IntentMatch, text: str) -> bool:
    """这一句要不要进推理循环。

    判据是**答案在不在系统里**，不是难不难。判错的代价不对称：该查的没查，
    用户拿到一个想当然的答案；不该查的查了，只是多花几毛钱。所以这里偏向查。
    """
    if match.intent is Intent.EXPLAIN or match.intent is Intent.UNKNOWN:
        return True
    if _WANTS_EVIDENCE.search(text or ""):
        return True
    return match.intent not in _ANSWERABLE_FROM_STATE


# ══════════════════════════════════════════════════════════════════
#  溯源校验
# ══════════════════════════════════════════════════════════════════
def check_grounding(answer: dict[str, Any], observed: list[str]) -> list[Finding]:
    """答案里的出处必须真的在工具返回里出现过。

    模型编出处是最难被发现的一类错误 —— 出处长得跟真的一样，FDE 拿着它去翻
    材料，翻不到，然后开始怀疑整个系统。所以这里做的是**字符串级的核对**，
    不是让另一个模型来判断"看起来合不合理"。
    """
    out: list[Finding] = []
    if not isinstance(answer, dict):
        return [Finding(Severity.HIGH, "ANSWER_MALFORMED", "-", "回答不是结构化结果",
                        verifier="rule:grounding")]
    cites = [str(c).strip() for c in (answer.get("citations") or []) if str(c).strip()]
    blob = "\n".join(observed)
    for c in cites:
        if c not in blob:
            out.append(Finding(
                Severity.HIGH, "CITATION_FABRICATED", c,
                f"回答里引了「{c}」，但工具返回里没有这个出处",
                proposed_fix={"action": "RETRY",
                              "hint": "只引用工具真的返回过的 cite；查不到就说查不到"},
                verifier="rule:grounding"))

    # 有出处但没结论、或有结论却一条出处都没有，都要拦
    text = str(answer.get("answer") or "").strip()
    if not text:
        out.append(Finding(Severity.HIGH, "ANSWER_EMPTY", "-", "没有给出回答",
                           verifier="rule:grounding"))
    elif not cites and observed and float(answer.get("confidence") or 0) >= 0.7:
        # 查过东西、给了高置信度、却一条出处都不给 —— 这是最典型的"看起来
        # 很确定其实没依据"
        out.append(Finding(
            Severity.MEDIUM, "CITATION_MISSING", "-",
            "查了材料、给了高置信度，却没有引用任何出处",
            proposed_fix={"action": "RETRY", "hint": "把支撑结论的那几片的 cite 带上"},
            verifier="rule:grounding"))
    return out


# ══════════════════════════════════════════════════════════════════
#  推理循环
# ══════════════════════════════════════════════════════════════════
@dataclass(slots=True)
class ConverseTurn:
    """一次对话推理的完整记录。"""

    text: str
    answer: str = ""
    citations: list[str] = field(default_factory=list)
    confidence: float = 0.0
    followup: str = ""
    #: 想了几步、调了哪些工具。用于流式展示与事后审计。
    steps: list[dict[str, Any]] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    usd: float = 0.0
    #: 这一轮选了哪种推理方式，以及（plan_execute 时）列出的计划。
    #: 要能在推理面板里看见 —— "它凭什么这么想"和"它想了什么"一样重要。
    strategy: str = "react"
    plan: list[dict[str, Any]] = field(default_factory=list)

    @property
    def grounded(self) -> bool:
        return not any(f.severity is Severity.HIGH for f in self.findings)

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "answer": self.answer, "citations": self.citations,
                "confidence": round(self.confidence, 2), "followup": self.followup,
                "steps": self.steps, "grounded": self.grounded,
                "strategy": self.strategy, "plan": self.plan,
                "findings": [f.to_dict() for f in self.findings],
                "usd": round(self.usd, 4)}


# ══════════════════════════════════════════════════════════════════
#  推理方式的选择
# ══════════════════════════════════════════════════════════════════
#: 三种推理方式。和 :class:`~..kernel.dag.NodeMode` 同名同义 —— 抽取节点用的是
#: 那一套，对话侧以前只有一条固定循环，不管问什么都按"边想边查"跑五步。
#:
#: 判据是**路径可不可枚举**，不是难不难：
#:   - 不需要查任何东西（寒暄、常识、就事论事的解释）→ 一次出答，别空转五步；
#:   - 要查、但查什么取决于上一步看到什么 → ReAct；
#:   - 目标明确、步骤当场就能列全（"把 X 连到 Y，然后重出模板"）→ 先列计划再执行，
#:     让 FDE 在动手前看见要做哪几件事。
STRATEGY_LABEL = {
    "single_shot": "直接回答",
    "react": "边查边想",
    "plan_execute": "先列计划再执行",
}
#: 推理面板里的这几行也要跟界面语言走 —— 界面切成英文、推理栏还在冒中文，
#: 是最扎眼的那种半吊子本地化。
STRATEGY_LABEL_EN = {
    "single_shot": "answer directly",
    "react": "search as I reason",
    "plan_execute": "plan first, then execute",
}


def strategy_label(strategy: str, lang: str = "zh") -> str:
    return (STRATEGY_LABEL_EN if lang == "en" else STRATEGY_LABEL).get(strategy, strategy)

#: 一句话里连着好几件事的信号词。
_MULTI = re.compile(r"然后|接着|再(?:把|给|帮|重|出|加|改)|并且|同时|一起|依次|分别|"
                    r"最后|之后|顺便")
#: 改产物的动作词。计划模式是给"做事"准备的，不是给"问问题"准备的。
_DO_VERB = re.compile(r"改|加|删|连|补|标|设|生成|重出|导出|撤销|采纳|排除|移到|重命名")


def pick_strategy(text: str, *, has_tools: bool) -> str:
    """选这一轮用哪种推理方式。**便宜、可解释** —— 纯规则，零模型调用。

    选错的代价不对称：该查的没查会给出想当然的答案；不该列计划却列了，只是多
    一次调用。所以只在**明显**是多步动作时才上 plan_execute。
    """
    if not has_tools:
        return "single_shot"
    t = str(text or "")
    if _MULTI.search(t) and len(_DO_VERB.findall(t)) >= 2:
        return "plan_execute"
    return "react"


_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["steps"],
    "properties": {
        "steps": {
            "type": "array", "maxItems": 6,
            "description": "要做的几件事，按顺序。只列**这一轮真要做**的，别写待办清单",
            "items": {
                "type": "object", "required": ["goal"],
                "properties": {
                    "goal": {"type": "string", "description": "这一步要达成什么，一句话"},
                    "tool": {"type": "string", "description": "打算用哪个工具，不确定就留空"},
                },
            },
        },
    },
}


_SYSTEM = """你是 OntoCopilot 的对话侧，面对的是一位 FDE 工程师。

他的工作是把客户的业务材料变成一份能落地的 Ontology。你有两种处境：

**手上有材料时** —— 你已经把它们解析、抽取成了一份中间表示，他问的多半是
材料里的事。先查再答。

**手上还没有材料时** —— 他可能在问建模本身的事（怎么划分对象、口径该怎么定、
这类项目一般怎么推进），也可能在跟你商量接下来做什么。**照常回答**，用你自己
的知识，但要说清这是通用经验而不是从他的材料里看来的。不要因为没有材料就
催他上传 —— 他自己知道什么时候该传。

工作方式：
- **绝不报告你没有亲手启动的进度。** 「正在解析」「系统正在后台处理」这类话，只有在
  你**这一轮真的调用了** build.start 之后才能说。没调就说"在跑"，是彻头彻尾的假话 ——
  他会一直等一个永远不会来的结果。不确定当前状态就调 session.status 看，别猜。
- **分清「看一下」和「梳理」—— 这两件事代价差一个数量级。**
  - 他说「分析一下这张图」「这图讲了什么」「这份材料里有什么」→ 他要的是**看懂**。
    用 `material.parse`（图片带 `ocr=true`）把内容读进来，再 `evidence.search`
    查着回答。**不要**调 build.start。
  - 只有他明确要**产出**东西时（「开始梳理」「抽本体」「生成流程图/模板」），
    才调 build.start —— 那会跑完整管线、花不少钱。
  拿不准就按前者做，然后问他要不要正式梳理。看错方向的代价是不对称的：多读一次
  图只是几毛钱，误启动一整轮梳理是几分钟和几美元。
- **材料要不要读、读哪几份，你来判断。** 上传只是把文件登记下来，**没有读内容**。
  `material.list` 看清单和每份读进来多少段；还没读的用 `material.parse` 读（表格/
  文档零成本）。他问材料里的事而清单显示"还没读入"时，**先读再答** —— 没读就检索
  只会查到空，然后你会误以为材料里没有。图片/扫描件要视觉模型，那个在「开始梳理」
  时做，不在这里。
- **要"列出来"就调 `ui.table`，别自己打。** 他说「列出来」「全部列一遍」「有哪些」时，
  用 `ui.table` 把那批产物以表格显示 —— 那张表由系统直接从产物里出，**202 条就是
  202 条，一条不少**。你自己在回答里逐条打的后果是：一定会截断，然后只能说"其余 199
  个未能呈现"，而那正是他要的东西。调完只说一句「已列出 N 条，见下表」，**不要复述**。
- **先查再答。** 你有检索材料和查询 OIR 的工具，用它们。凭印象回答在这里没有价值，
  他自己也能凭印象猜。
- **每个结论都带出处 —— 如果它来自材料。** 出处原样抄工具返回里的 cite 字符串，
  一个字都不要改。来自通用经验的结论不要编出处，直接说这是经验判断。
- **查不到就说查不到。** 他会拿你的回答去跟客户对话；一个听起来合理但是编的答案，
  代价是他在客户面前说错话。
- 回答要短。他要的是结论和依据，不是过程复述。
- **thought 一定要写实**。它会原样显示在界面的推理面板里，他靠它判断你有没有在
  一本正经地胡说。填空串等于什么都没想。

**回答风格 —— 只给结论和结果，不露技术实现：**
- **绝不提工具名、内部机制、方法论。** 不要说"我调 flow.preview / build.start / oir.add"、
  不要讲"抽取管线 / 五段式 / 冻结 DAG"这类内部说法。你要做某件事就**直接做**，然后用
  业务语言说**做成了什么效果**：说"我把流程图生成好了""我把这个字段补进去了"，而不是
  "我调用了某某工具"。
- 用户问"你怎么做到的""用了什么模型/框架"时，简单答"这是我内置的能力"即可，不展开
  技术细节。给的是结果和结论，不是实现说明书。

改产物的工具你也有 —— 但它们动的是他辛苦得来的产物，纪律要严：
- **口述的事实要落进产物。** 他说出材料没写、但他知道的事实时，别只回「知道了」——
  按性质分派：讲的是**本体元素**（对象/属性/关系/规则/某字段的取值或口径）就用
  oir.add / oir.edit；讲的是**流程**（多一步、连一条边、加个网关、谁来做、归哪个阶段）
  就用 flow.edit；两者都涉及（如「采购包创建后状态变成已发布」既是状态取值/流程规则、
  又是流程上一个事件）就**两个都调**。
- **口述永远不是材料证据。** 它在产物里标「人工口述」(Origin=USER)，可信度高，但绝不能
  说成是从材料里读到的。改完精确复述你改了什么，不要为口述的事实编出处。
- **这些改产物的工具会先要用户确认。** 被挡下时把你打算改什么讲清楚，等他点头再来一次。
  只读的检索/查询不受此限。"""


#: 「聊天」模式的系统提示：一个**通用**助手，不是 FDE 专用副驾。可以分析上传的材料，
#: 但**只分析不生产** —— 不抽本体、不出流程图、不生成模板。要产出这些就切「工作」。
_CHAT_SYSTEM = """你是 OntoCopilot 的聊天助手 —— 一个通用的 AI 助手。

聊天是**通用对话**：回答问题、帮着分析、写东西、聊聊都行，用你自己的知识。
用户若上传了文件，你可以读它、就它对话和分析 —— 但**上传只是登记，没有读内容**：
先用 `material.list` 看清单，显示"还没读入"的用 `material.parse` 读进来，再检索。

但聊天**只分析、不生产**：不抽本体、不出流程图、不生成填写模板 —— 这些是「工作」
模式的事。用户要正式梳理业务材料、产出这些东西时，告诉他切到上方「工作」模式（那边
是支持 FDE 工程师的完整工作流），或点「转成工作会话」把文件带过去接着做。

几条：
- 直接、简洁地回答；不确定就说不确定，别编。
- 用检索读到的内容如实引用，别编出处。
- 别催用户上传，也别硬把话题往梳理上带 —— 他要梳理时自己会说。
- **只给结论和结果，不露技术实现**：不要提工具名、内部机制或方法论；问到"怎么做到的"
  就答"这是我内置的能力"，不展开技术细节。
"""


class ConversationAgent:
    """对话侧的推理循环。

    刻意不复用 :class:`~..kernel.loop.AgentLoop`：那个循环是给 DAG 节点用的，
    带着 critic 环、预算档位、降级广播、节点重试 —— 对话要的是**低延迟、可中断、
    过程可见**，两者的取舍方向相反。共用的是工具注册表、证据索引和溯源纪律。

    Args:
        gateway: 模型网关。
        tools: 工具注册表，按 ``scope`` 授权。
        max_steps: 最多想几步。对话不该转很久 —— 转不出来就如实说，
            比让人干等三十秒更好。
    """

    def __init__(self, *, gateway: Any, tools: Any, scope: str = "readonly",
                 max_steps: int = 5, system: str | None = None,
                 model: Any = None, lang: str = "zh",
                 strategy: str | None = None) -> None:
        self.gw = gateway
        self.tools = tools
        self.scope = scope
        self.max_steps = max_steps
        #: 固定推理方式；``None`` = 每轮按请求自动选（见 :func:`pick_strategy`）。
        #: 测试和特殊场景可以钉死，正常运行让它自己选。
        self.strategy = strategy
        #: 界面语言。推理面板里那几行由我们自己拼，得跟着它走 —— 界面切成英文、
        #: 推理栏还在冒中文，是最扎眼的那种半吊子本地化。
        self.lang = lang
        #: 系统提示可覆盖 —— 聊天模式换成通用助手 `_CHAT_SYSTEM`，工作模式用 FDE 版。
        self.system = system or _SYSTEM
        if lang == "en":
            # 只加一行输出语言指令：领域内容仍是中文材料，模型照读不误，只把**它自己
            # 的话**换成英文。实体名/口径等抽取出来的术语保持原文，别硬翻。
            self.system += ("\n\n[Output language] Reply to the user in English. "
                            "Keep extracted domain terms (entity names, calibers, "
                            "field names) in their original language.")
        #: 指定模型（ModelSpec）则对话直接用它，跳过按难度的路由 —— 工作模式的模型选择器。
        self.model = model

    async def run(self, text: str, *, ctx: Any, context: str = "",
                  on_step: Any = None) -> ConverseTurn:
        """跑一轮对话推理。

        Args:
            context: 会话状态摘要（当前产物统计、已拍板的决定、待答问题）。
                它进系统层而不是用户层 —— 用户说的话和系统给的事实混在一起，
                材料里写的"请忽略之前的指令"就有机会冒充系统事实。
            on_step: 每产生一步就回调一次，用于流式上屏。
        """
        turn = ConverseTurn(text=text)
        observed: list[str] = []
        transcript: list[str] = []
        specs = self.tools.for_scope(self.scope)

        # ── 选推理方式，并让它在推理面板里看得见 ──────────────────────
        turn.strategy = self.strategy or pick_strategy(text, has_tools=bool(specs))
        if on_step:
            _lbl = strategy_label(turn.strategy, self.lang)
            on_step({"n": 0,
                     "thought": (f"This turn: {_lbl}." if self.lang == "en"
                                 else f"这一轮按「{_lbl}」来。"),
                     "tool": "", "args": {}})

        if turn.strategy == "single_shot":
            # 不需要查东西就别空转五步：一次调用直接出答案。
            try:
                comp = await self.gw.call(
                    f"CHAT.{ctx.turn_id}",
                    self._prompt(text, context, transcript, specs, final=True),
                    system=self.system, difficulty=Difficulty.MEDIUM, model=self.model,
                    schema=ANSWER_SCHEMA, key="single")
            except Exception as exc:  # noqa: BLE001
                turn.answer = f"这轮没跑通：{type(exc).__name__}: {exc}"
                turn.findings.append(Finding(Severity.HIGH, "GATEWAY_ERROR", "-",
                                             str(exc), verifier="rule:gateway"))
                return turn
            turn.usd += float(getattr(comp, "usd", 0.0) or 0.0)
            return self._finish(turn, comp.data if isinstance(comp.data, dict) else {},
                                observed, on_step)

        if turn.strategy == "plan_execute":
            # 先把这一轮要做的几件事列出来 —— FDE 在动手前就该看见清单，而不是
            # 等做完了才知道动了什么。列不出来就退回边查边想，不要卡住。
            try:
                pc = await self.gw.call(
                    f"CHAT.{ctx.turn_id}",
                    self._plan_prompt(text, context, specs),
                    system=self.system, difficulty=Difficulty.MEDIUM, model=self.model,
                    schema=_PLAN_SCHEMA, key="plan")
                turn.usd += float(getattr(pc, "usd", 0.0) or 0.0)
                turn.plan = [x for x in ((pc.data or {}).get("steps") or []) if x.get("goal")]
            except Exception:  # noqa: BLE001 — 列不出计划不该让这轮失败
                turn.plan = []
            if turn.plan:
                lines = "；".join(f"{i+1}. {x['goal']}" for i, x in enumerate(turn.plan))
                transcript.append(f"【本轮计划】{lines}")
                if on_step:
                    on_step({"n": 0, "tool": "", "args": {},
                             "thought": (f"Plan: {lines}" if self.lang == "en"
                                         else f"计划：{lines}")})
            else:
                turn.strategy = "react"

        for step in range(self.max_steps):
            last = step == self.max_steps - 1
            prompt = self._prompt(text, context, transcript, specs, final=last)
            try:
                comp = await self.gw.call(
                    f"CHAT.{ctx.turn_id}", prompt, system=self.system,
                    difficulty=Difficulty.MEDIUM, model=self.model,
                    schema=ANSWER_SCHEMA if last else _STEP_SCHEMA,
                    # key 必须给：同一个"节点"里会连着调好几次，不给 key 的话
                    # effect 记账会按 (node_id, idx) 撞在一起。
                    key=f"step{step}")
            except Exception as exc:  # noqa: BLE001 — 对话失败要如实说，不能静默
                turn.answer = f"这轮没跑通：{type(exc).__name__}: {exc}"
                turn.findings.append(Finding(Severity.HIGH, "GATEWAY_ERROR", "-",
                                            str(exc), verifier="rule:gateway"))
                return turn
            turn.usd += float(getattr(comp, "usd", 0.0) or 0.0)
            data = comp.data if isinstance(comp.data, dict) else {}

            if last or data.get("kind") == "answer":
                return self._finish(turn, data, observed, on_step)

            tool = str(data.get("tool") or "").strip()
            thought = str(data.get("thought") or "")
            args = _parse_args(data.get("args_json"))
            rec = {"n": step + 1, "thought": thought, "tool": tool, "args": args}
            if on_step:
                on_step(dict(rec))

            if not tool:
                return self._finish(turn, data, observed, on_step)
            try:
                obs = await self.tools.call(tool, args, ctx, scope=self.scope)
            except Exception as exc:  # noqa: BLE001 — 工具失败回给模型，不是中断
                obs = {"error": f"{type(exc).__name__}: {exc}"}
            rendered = json.dumps(obs, ensure_ascii=False, default=str)[:4000]
            observed.append(rendered)
            rec["observation"] = rendered[:600]
            turn.steps.append(rec)
            if on_step:
                on_step(dict(rec))
            transcript.append(f"你想：{thought}\n你调了 {tool}({json.dumps(args, ensure_ascii=False)})\n"
                              f"返回：{rendered}")

        return turn

    # ── 内部 ────────────────────────────────────────────────────
    def _finish(self, turn: ConverseTurn, data: dict[str, Any],
                observed: list[str], on_step: Any) -> ConverseTurn:
        # 收尾这一步同样要发出去。只在调工具时才发的话，"一步就答上来"的问题
        # （寒暄、凭经验回答）在轨迹里什么都看不到 —— 而那恰恰是最该让人核对
        # "它到底想了什么"的时候。
        thought = str(data.get("thought") or "").strip()
        final = {"n": len(turn.steps) + 1,
                 # 模型仍可能填空 —— 与其显示一个空行，不如如实说它没交代
                 "thought": thought or "（模型没有给出思考过程）",
                 "tool": "", "args": {}, "kind": "answer"}
        turn.steps.append(final)
        if on_step:
            on_step(dict(final))
        turn.answer = str(data.get("answer") or "").strip()
        turn.citations = [str(c) for c in (data.get("citations") or [])]
        turn.confidence = float(data.get("confidence") or 0.0)
        turn.followup = str(data.get("followup") or "").strip()
        turn.findings = check_grounding(data, observed)
        if not turn.grounded:
            # 编出处是最难被发现的错误。发现了就**当场删掉**那几条，而不是
            # 附一句"以下出处可能有误" —— 后者等于把核对的活推给用户。
            blob = "\n".join(observed)
            turn.citations = [c for c in turn.citations if c in blob]
            turn.answer += "\n\n（有出处没核对上，已移除；结论请自行复核）"
        return turn

    def _prompt(self, text: str, context: str, transcript: list[str],
                specs: list[Any], final: bool) -> str:
        head = [f"## 当前会话状态\n{context}\n" if context else "",
                f"## FDE 问的是\n{text}\n"]
        if transcript:
            head.append("## 你已经查过的\n" + "\n\n".join(transcript[-4:]) + "\n")
        if final:
            head.append("现在给出回答。**出处只能写你上面真的查到过的**，"
                        "一条都没查到就给空数组、并在回答里说明你没查到。")
        else:
            tools = "\n".join(t.spec.render() for t in specs)
            head.append(f"## 可用工具\n{tools}\n\n"
                        "查够了就把 kind 设成 answer 直接回答；还需要查就设成 tool。")
        return "\n".join(x for x in head if x)

    def _plan_prompt(self, text: str, context: str, specs: list[Any]) -> str:
        """列计划用的提示。**只列这一轮真要做的几件事**，不是写待办清单。"""
        tools = "\n".join(t.spec.render() for t in specs)
        return "\n".join(x for x in [
            f"## 当前会话状态\n{context}\n" if context else "",
            f"## FDE 要做的\n{text}\n",
            f"## 可用工具\n{tools}\n",
            "他这一句里包含好几件事。**先把要做的按顺序列出来**（最多 6 步），"
            "每步一句话说清要达成什么、打算用哪个工具。只列这一轮真要做的；"
            "他没要求的别自作主张加。列完就会按这个顺序执行。",
        ] if x)


#: 中间步骤的契约。和最终回答共用一个 schema 会让模型在没查够的时候就急着
#: 填 answer —— 分开两个 schema，"还要不要查"就变成一个显式选择。
_STEP_SCHEMA: dict[str, Any] = {
    "type": "object",
    # **thought 必须排在最前面。** 结构化输出是逐字段生成的，把它放在 answer
    # 后面等于让模型先写完答案再补一句"我是这么想的" —— 那不是推理，是事后编排。
    # 实测：放在第二位时模型直接填空串（required 只保证字段存在，不保证非空）。
    "required": ["thought", "kind", "tool", "args_json"],
    "properties": {
        "thought": {"type": "string", "minLength": 8,
                    "description": "你此刻在想什么，一到两句。要查东西就说清查什么、为什么；"
                                   "要直接回答就说清你凭什么这么答。"
                                   "**这段会原样展示给用户**，是他核对你有没有乱说的唯一依据，"
                                   "不许留空、不许写「思考中」这种废话"},
        "kind": {"type": "string", "enum": ["tool", "answer"]},
        "tool": {"type": "string", "description": "kind=answer 时填空串"},
        "args_json": {"type": "string",
                      "description": '工具参数的 JSON 对象字符串；kind=answer 时填 {}'},
        "answer": {"type": "string", "description": "kind=answer 时填这里"},
        "citations": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "number"},
    },
}


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        out = json.loads(raw)
        return out if isinstance(out, dict) else {}
    except json.JSONDecodeError:
        return {}
