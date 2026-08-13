"""把 kernel/loop.py 的行为导成 golden，给 TS 侧 loop.ts 当安全网。

loop.py 之前没有 golden（Python 侧只有 tests/test_orchestration.py 里几条断言），
所以这份是新导的。

**设计：golden 里存的是"剧本"而不是"期望字符串"。** 每个 run 用例给出节点规格、
handler 配置和一串按调用序返回的模型响应；Python 这边用真的 :class:`AgentLoop`
跑一遍，把**网关收到的每一条 prompt、发出的每一个事件、handler 的调用轨迹、
最终 NodeResult** 全录下来。TS 侧照同一份剧本搭同构的 stub 再跑一遍，逐项比对。
于是 prompt 的字节、事件的顺序、finalize 被调了几次全部被钉住 —— 这些正是
"看起来跑通了、其实产物少了一半" 那类 bug 的藏身处。

**stub 是外挂的，Python 原件一个字没改。** loop.py 的协作方全是鸭子类型
（gateway / recorder / panel / bus / context manager / working set），所以外面塞
stub 进去就行。唯一的例外是 ``Scratchpad`` —— 它是 ``run()`` 内部 ``new`` 出来的，
所以这里把模块属性 ``loop.Scratchpad`` 换成 FakePad。换掉它是**必须的**：真的
Scratchpad 属于 memory/short_term.py，TS 侧还没落地，拿它当基准的话 golden 就
不可复现了。FakePad 的行为足够平凡，两边照抄不会分叉。

跑法::

    .venv/bin/python tools/golden/loop.py

字节确定：无时间、无随机、无并发（stub 全同步返回）、无集合迭代序。
重跑两次哈希必须一致。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel import loop as loop_mod  # noqa: E402
from ontocopilot.kernel.budget import Budget  # noqa: E402
from ontocopilot.kernel.critic import Finding, Severity, Verdict  # noqa: E402
from ontocopilot.kernel.dag import (  # noqa: E402
    Difficulty,
    NodeBudget,
    NodeMode,
    NodeSpec,
    ScopeSpec,
)
from ontocopilot.kernel.errors import HumanInputRequired, NodeFailure  # noqa: E402
from ontocopilot.kernel.loop import (  # noqa: E402
    PLAN_SCHEMA,
    STEP_SCHEMA,
    AgentLoop,
    NodeHandler,
    parse_action_args,
)

OUT = Path(__file__).resolve().parent.parent.parent / "golden"


# ══════════════════════════════════════════════════════════════════
#  stub 群 —— TS 侧要有一份逐字等价的实现
# ══════════════════════════════════════════════════════════════════
class FakePad:
    """替掉 Scratchpad。行为刻意平凡，两边照抄。

    ``over_at``：``len(entries)`` 落在这个集合里时 ``over_budget()`` 报 True，
    用来触发 CONTEXT_COMPACTED 那条分支。
    """

    def __init__(self, *, budget_tokens: int, over_at: tuple[int, ...] = (),
                 compact_to: int = 0) -> None:
        self.budget_tokens = budget_tokens
        self.over_at = set(over_at)
        self.compact_to = compact_to
        self.entries: list[dict[str, str]] = []

    def append(self, thought: str = "", action: str = "", observation: str = "") -> None:
        self.entries.append({"thought": thought, "action": action, "observation": observation})

    def over_budget(self, threshold: float = 0.7) -> bool:
        return len(self.entries) in self.over_at

    def compact_to_fit(self, threshold: float = 0.7) -> int:
        return self.compact_to

    def render(self) -> str:
        return "\n".join(
            f"T:{e['thought']}|A:{e['action']}|O:{e['observation']}" for e in self.entries
        )

    def digest(self, max_tokens: int = 600) -> dict[str, Any]:
        return {"turns": len(self.entries), "summary": self.render()}

    def __len__(self) -> int:
        return len(self.entries)


class StubRecorder:
    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.events: list[dict[str, Any]] = []
        self.attempts: dict[str, int] = {}

    def next_attempt(self, node_id: str) -> int:
        n = self.attempts.get(node_id, 0)
        self.attempts[node_id] = n + 1
        return n

    def emit(self, kind: Any, *, node_id: str | None = None,
             payload: dict[str, Any] | None = None, ref: str | None = None) -> None:
        self.events.append({"kind": str(kind), "node_id": node_id, "payload": payload or {}})

    async def ask_human(self, node_id: str, request_id: str, payload: dict[str, Any]) -> Any:
        if request_id in self.answers:
            return self.answers[request_id]
        raise HumanInputRequired(node_id, request_id, payload)


class StubRendered:
    def __init__(self, text: str) -> None:
        self.text = text

    def stats(self) -> dict[str, Any]:
        return {"total_tokens": len(self.text), "layers": {"system": 1}, "chunks": 0}


class StubCM:
    def __init__(self) -> None:
        self.assembles: list[dict[str, Any]] = []
        self.reflections: list[str] = []

    def assemble(self, *, task: str, query: str = "", working: Any = None,
                 deps: list[str] | None = None, scratch: Any = None, run_id: str = "",
                 evidence_files: list[str] | None = None, evidence_top_k: int = 24,
                 budget_tokens: int | None = None, recall_kinds: Any = None,
                 current_files: Any = None) -> StubRendered:
        self.assembles.append({
            "task": task, "query": query, "has_working": working is not None,
            "deps": list(deps) if deps is not None else None, "run_id": run_id,
            "evidence_files": evidence_files, "evidence_top_k": evidence_top_k,
            "budget_tokens": budget_tokens,
        })
        return StubRendered(f"CTX<{task}>")

    def reflect(self, lesson: str) -> None:
        self.reflections.append(lesson)


class StubBus:
    def __init__(self, facts: str) -> None:
        self.facts = facts
        self.patterns: list[str] = []

    def render_facts(self, pattern: str = "*") -> str:
        self.patterns.append(pattern)
        return self.facts


class StubWorking:
    def __init__(self, outputs: dict[str, Any]) -> None:
        self.outputs = outputs
        self.selects: list[list[str]] = []

    def select(self, node_ids: list[str]) -> dict[str, Any]:
        self.selects.append(list(node_ids))
        return dict(self.outputs)


class StubCompletion:
    def __init__(self, text: str, data: Any) -> None:
        self.text = text
        self.data = data


class StubRouting:
    def __init__(self, model: str) -> None:
        self.model = model

    def model_for(self, d: Difficulty) -> dict[str, Any]:
        return {"name": self.model, "difficulty": str(d)}


#: gw.call 的 kwargs 名 → golden 里记的名字。记"实际传了哪些 kwargs"是有意的：
#: refine 那一次**不传 system**（loop.py:415），照抄才不会悄悄多传一个系统提示。
_KW = ("system", "difficulty", "schema", "model", "key", "max_tokens", "images")


class StubGateway:
    """按调用序返回剧本里的响应，并录下每一次调用收到的东西。"""

    def __init__(self, responses: list[dict[str, Any]], *, rounds: int, iterations: int,
                 samples: int, model: str) -> None:
        self.responses = responses
        self.rounds = rounds
        self.iterations = iterations
        self.samples = samples
        self.routing = StubRouting(model)
        self.calls: list[dict[str, Any]] = []

    async def call(self, node_id: str, prompt: str, **kw: Any) -> StubCompletion:
        i = len(self.calls)
        self.calls.append({
            "node_id": node_id,
            "prompt": prompt,
            "passed": sorted(k for k in _KW if k in kw),
            "system": kw.get("system", ""),
            "difficulty": str(kw.get("difficulty", "")),
            "schema": _schema_id(kw.get("schema")),
            "key": kw.get("key"),
            "max_tokens": kw.get("max_tokens"),
        })
        r = self.responses[i] if i < len(self.responses) else {"text": "", "data": None}
        return StubCompletion(r.get("text", ""), r.get("data"))

    def iterations_for(self, d: Difficulty) -> int:
        return self.iterations

    def critic_rounds_for(self, d: Difficulty, requested: int | None = None) -> int:
        return self.rounds if requested is None else requested

    def samples_for(self, d: Difficulty) -> int:
        return self.samples


def _schema_id(schema: Any) -> str:
    if schema is None:
        return "null"
    if schema is STEP_SCHEMA:
        return "STEP"
    if schema is PLAN_SCHEMA:
        return "PLAN"
    return "HANDLER"


class StubPanel:
    """按 judge 调用序返回剧本里的裁决，并录下**它看到的 draft**。

    录 draft 是关键：critic 判的必须是节点真正要交出去的东西（finalize 之后的
    那份），不是模型刚吐的半成品。
    """

    def __init__(self, judgements: list[list[dict[str, Any]]]) -> None:
        self.judgements = judgements
        self.validated: list[dict[str, Any]] = []
        self.judged: list[dict[str, Any]] = []

    def validate(self, lenses: Any, node_id: str) -> None:
        self.validated.append({"lenses": list(lenses), "node_id": node_id})

    async def judge(self, draft: Any, lenses: Any, ctx: Any, *,
                    allow_llm: bool = True) -> list[Verdict]:
        i = len(self.judged)
        self.judged.append({
            "draft": draft, "lenses": list(lenses), "allow_llm": allow_llm,
            "node_id": ctx.node_id, "facts": ctx.facts, "samples": ctx.samples,
            "generator": ctx.generator,
        })
        spec = self.judgements[i] if i < len(self.judgements) else []
        return [_verdict(v) for v in spec]


def _verdict(v: dict[str, Any]) -> Verdict:
    return Verdict(
        lens=v["lens"],
        passed=v["passed"],
        findings=[
            Finding(
                severity=Severity(f.get("severity", "high")),
                code=f["code"],
                target=f.get("target", "-"),
                claim=f["claim"],
                evidence_checked=list(f.get("evidence_checked", ())),
            )
            for f in v.get("findings", ())
        ],
        note=v.get("note", ""),
    )


class StubHandler(NodeHandler):
    """按配置行事的 handler，并录下**调用轨迹**。

    轨迹钉住的是顺序，尤其是 finalize 出现了几次 —— critic 修订之后那一次
    正是 loop.py:424 修掉的 P0。
    """

    def __init__(self, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        self.schema = cfg.get("schema")
        self.system = cfg.get("system", "")
        self.trace: list[str] = []
        self._dispatches = 0

    def for_node(self, node_id: str) -> NodeHandler:
        self.trace.append(f"for_node:{node_id}")
        return self

    def task(self, inputs: dict[str, Any]) -> str:
        self.trace.append("task")
        return self.cfg.get("task", "完成本节点任务。")

    def query(self, inputs: dict[str, Any]) -> str:
        self.trace.append("query")
        q = self.cfg.get("query")
        return self.task(inputs) if q is None else q

    def skip_model(self, inputs: dict[str, Any]) -> Any:
        self.trace.append("skip_model")
        return self.cfg.get("skip_model")

    def finalize(self, draft: Any, inputs: dict[str, Any]) -> Any:
        self.trace.append(f"finalize:{json.dumps(draft, ensure_ascii=False, default=str)}")
        merge = self.cfg.get("finalize_merge")
        if merge is None:
            return draft
        out = dict(draft or {})
        out.update(merge)
        return out

    def human_request(self, draft: Any, inputs: dict[str, Any]) -> dict[str, Any]:
        self.trace.append("human_request")
        return self.cfg.get("human_request", {"draft": draft})

    async def execute(self, inputs: dict[str, Any], ctx: Any) -> Any:
        self.trace.append("execute")
        return self.cfg.get("execute")

    async def dispatch(self, action: dict[str, Any], ctx: Any) -> Any:
        self.trace.append(f"dispatch:{action.get('tool', '')}")
        seq = self.cfg.get("dispatch", [])
        i = min(self._dispatches, len(seq) - 1) if seq else -1
        self._dispatches += 1
        return seq[i] if i >= 0 else None


# ══════════════════════════════════════════════════════════════════
#  run 用例
# ══════════════════════════════════════════════════════════════════
def _spec(c: dict[str, Any]) -> NodeSpec:
    b = c.get("budget", {})
    s = c.get("scope", {})
    return NodeSpec(
        id=c["id"],
        mode=NodeMode(c["mode"]),
        handler=c["handler"],
        deps=tuple(c.get("deps", ())),
        critics=tuple(c.get("critics", ())),
        critic_rounds=c.get("critic_rounds", 2),
        difficulty=Difficulty(c["difficulty"]) if c.get("difficulty") else None,
        budget=NodeBudget(**b) if b else NodeBudget(),
        scope=ScopeSpec(**s) if s else ScopeSpec(),
    )


RUNS: list[dict[str, Any]] = [
    {
        "name": "single_shot_with_schema",
        "doc": "最短路径：SINGLE_SHOT + schema + 无 critic。钉住上下文装配与 finalize 各一次。",
        "node": {"id": "EXTRACT", "mode": "single_shot", "handler": "x",
                 "deps": ["PARSE"], "budget": {"tokens": 30000}},
        "handler": {"schema": {"type": "object"}, "system": "你是抽取器。",
                    "task": "抽取 ObjectType", "query": "对象 检索",
                    "finalize_merge": {"actions": [{"api_name": "createPbp"}]}},
        "working": {"PARSE": {"rows": 3}},
        "facts": "计划金额 = 两个口径",
        "responses": [{"text": "ignored", "data": {"objects": [{"api_name": "pbpHeader"}]}}],
        "run_id": "r1",
    },
    {
        "name": "single_shot_without_schema_uses_text",
        "doc": "handler.schema 为 None 时取 comp.text —— Python 的 `if handler.schema` 是真值判断。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x"},
        "handler": {"schema": None, "task": "写一段话"},
        "working": {},
        "facts": "",
        "responses": [{"text": "一段话", "data": {"ignored": True}}],
        "run_id": "r1",
    },
    {
        "name": "empty_schema_dict_is_falsy_so_text_wins",
        "doc": "空 dict 在 Python 里是**假**：schema={} 时走 comp.text 而不是 comp.data。"
               "TS 里 `{}` 是真值，照抄 `if (handler.schema)` 会在这里分叉。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x"},
        "handler": {"schema": {}, "task": "写一段话"},
        "working": {},
        "facts": "",
        "responses": [{"text": "文本赢", "data": {"a": 1}}],
        "run_id": "r1",
    },
    {
        "name": "rule_extracted_content_survives_the_refine_round",
        "doc": "P0（loop.py:419-424）：修订产物同样要过 finalize。删掉那一行的话，规则逐行"
               "抽好的 actions 会被模型重出的那版 JSON 整个吃掉 —— 真实事故是 112 行 API 表"
               "抽出 0 个 action。judge#1 看到的 draft 里必须仍有 actions。",
        "node": {"id": "EXTRACT", "mode": "single_shot", "handler": "x",
                 "critics": ["coverage"], "critic_rounds": 2},
        "handler": {"schema": {"type": "object"}, "task": "抽取 ObjectType",
                    "finalize_merge": {"actions": [{"api_name": "createPbp"},
                                                   {"api_name": "submitPbp"}]}},
        "working": {},
        "facts": "",
        "responses": [
            {"text": "", "data": {"objects": []}},
            {"text": "", "data": {"objects": [{"api_name": "pbpHeader"}]}},
        ],
        "judgements": [
            [{"lens": "coverage", "passed": False,
              "findings": [{"code": "OBJECTS_MISSING", "claim": "应该能抽出对象，实际一个都没有",
                            "evidence_checked": ["A1", "B2", "C3", "D4"]}]}],
            [{"lens": "coverage", "passed": True}],
        ],
        "run_id": "r1",
    },
    {
        "name": "last_refinement_is_reviewed_before_commit",
        "doc": "rounds=1 且首轮不过：修订之后必须**再判一次**，否则返回的裁决描述的是上一版产物。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x",
                 "critics": ["quality"], "critic_rounds": 1},
        "handler": {"schema": {"type": "object"}, "task": "出稿"},
        "working": {},
        "facts": "",
        "responses": [
            {"text": "", "data": {"quality": "bad"}},
            {"text": "", "data": {"quality": "still-bad"}},
        ],
        "judgements": [
            [{"lens": "quality", "passed": False,
              "findings": [{"code": "BAD", "claim": "quality is bad"}]}],
            [{"lens": "quality", "passed": False,
              "findings": [{"code": "BAD", "claim": "quality is still bad"}]}],
        ],
        "run_id": "r1",
    },
    {
        "name": "react_iterates_dispatches_and_compacts",
        "doc": "REACT：两步工具 + 一步 finish。钉住 observation 的 str() 形态、两处截断、"
               "以及 over_budget 触发的 CONTEXT_COMPACTED。",
        "node": {"id": "R", "mode": "react", "handler": "x",
                 "budget": {"tokens": 20000, "iterations": 5}},
        "handler": {"schema": {"type": "object"}, "task": "边看边抽",
                    "dispatch": [{"error": "本节点没有可用工具"},
                                 {"rows": [1, 2], "note": "第二次"}]},
        "working": {},
        "facts": "",
        "gateway": {"iterations": 3},
        "pad": {"over_at": [2], "compact_to": 2},
        "responses": [
            {"data": {"thought": "先查一下", "action": {"kind": "tool", "tool": "search",
                                                        "args_json": "{\"q\": \"计划金额\"}"}}},
            {"data": {"thought": "再查一下", "action": {"kind": "tool", "tool": "read",
                                                        "args_json": "不是 JSON"}}},
            {"data": {"thought": "够了", "action": {"kind": "finish", "tool": "",
                                                    "args_json": "{}"}}},
            {"text": "", "data": {"objects": ["a"]}},
        ],
        "run_id": "r1",
    },
    {
        "name": "astral_truncation_is_by_code_point",
        "doc": "thought[:800] 与 observation[:400] 切的都是**码点**。星平面字符（emoji）在 JS 里"
               "占两个 UTF-16 码元，用 JS 的 slice 会少切一半、并且可能留下半个代理对。",
        "node": {"id": "R", "mode": "react", "handler": "x",
                 "budget": {"tokens": 4000, "iterations": 1}},
        "handler": {"schema": None, "task": "边看边抽",
                    "dispatch": [{"k": "🎯" * 450}]},
        "working": {},
        "facts": "",
        "gateway": {"iterations": 1},
        "responses": [
            {"data": {"thought": "🧭" * 900, "action": {"kind": "tool", "tool": "t",
                                                        "args_json": "{}"}}},
            {"text": "收尾", "data": None},
        ],
        "run_id": "r1",
    },
    {
        "name": "codeact_shares_the_react_skeleton",
        "doc": "CODEACT 走同一个循环骨架，但**不**先要计划（只有 PLAN_EXECUTE 会）。",
        "node": {"id": "C", "mode": "codeact", "handler": "x",
                 "budget": {"tokens": 6000, "iterations": 1}},
        "handler": {"schema": {"type": "object"}, "task": "写代码算",
                    "dispatch": [{"stdout": "42\n"}]},
        "working": {},
        "facts": "",
        "gateway": {"iterations": 4},
        "responses": [
            {"data": {"thought": "跑一段", "action": {"kind": "tool", "tool": "code.exec",
                                                      "args_json": "{\"src\": \"print(42)\"}"}}},
            {"text": "", "data": {"n": 42}},
        ],
        "run_id": "r1",
    },
    {
        "name": "react_stops_at_max_iters",
        "doc": "iterations 上限取 min(节点预算, 网关档位) —— 这里网关档位更小。",
        "node": {"id": "R", "mode": "react", "handler": "x",
                 "budget": {"tokens": 20000, "iterations": 9}},
        "handler": {"schema": None, "task": "转圈", "dispatch": [{"ok": 1}]},
        "working": {},
        "facts": "",
        "gateway": {"iterations": 2},
        "responses": [
            {"data": {"thought": "一", "action": {"kind": "tool", "tool": "t", "args_json": "{}"}}},
            {"data": {"thought": "二", "action": {"kind": "tool", "tool": "t", "args_json": "{}"}}},
            {"text": "收尾", "data": None},
        ],
        "run_id": "r1",
    },
    {
        "name": "plan_execute_emits_plan",
        "doc": "PLAN_EXECUTE 先要一份计划，计划进 PLAN_CREATED 事件并出现在每一步的 prompt 里。",
        "node": {"id": "P", "mode": "plan_execute", "handler": "x",
                 "budget": {"tokens": 8000, "iterations": 1}},
        "handler": {"schema": {"type": "object"}, "task": "分步做"},
        "working": {},
        "facts": "",
        "gateway": {"iterations": 4},
        "responses": [
            {"data": {"steps": [{"goal": "先读表头"}, {"goal": "再抽行", "tool": "read"}]}},
            {"data": {"thought": "开工", "action": {"kind": "finish", "tool": "",
                                                    "args_json": "{}"}}},
            {"text": "", "data": {"done": True}},
        ],
        "run_id": "r1",
    },
    {
        "name": "deterministic_node_never_calls_model",
        "doc": "DETERMINISTIC 走 handler.execute，一次模型都不调，但 finalize 照样过。",
        "node": {"id": "D", "mode": "deterministic", "handler": "x", "deps": ["A", "B"]},
        "handler": {"schema": None, "task": "算", "execute": {"n": 7},
                    "finalize_merge": {"stamped": True}},
        "working": {"A": {"n": 1}, "B": {"n": 2}},
        "facts": "",
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "skip_model_short_circuits_everything",
        "doc": "ADR-5 在节点级的落点：规则已经算完就一次模型都不调（iterations=0），"
               "但 finalize 仍然要过。",
        "node": {"id": "S", "mode": "single_shot", "handler": "x"},
        "handler": {"schema": {"type": "object"}, "task": "问卷",
                    "skip_model": {"rows": [{"q": "一行一问"}]},
                    "finalize_merge": {"source": "rule"}},
        "working": {},
        "facts": "",
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "hitl_returns_recorded_answer",
        "doc": "HITL：历史里已有答案就直接返回。注意 loop.py:299 把 inputs 同时当 draft 传。",
        "node": {"id": "CLARIFY", "mode": "hitl", "handler": "x", "deps": ["A"]},
        "handler": {"schema": None, "task": "问人",
                    "human_request": {"questions": ["「计划金额」两个口径怎么处理？"]}},
        "working": {"A": {"n": 1}},
        "facts": "",
        "answers": {"CLARIFY:hitl": {"option_id": "split_two_properties"}},
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "hitl_without_answer_raises",
        "doc": "没有答案就抛 HumanInputRequired，由调度器挂起整个 Run。",
        "node": {"id": "CLARIFY", "mode": "hitl", "handler": "x"},
        "handler": {"schema": None, "task": "问人"},
        "working": {},
        "facts": "",
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "unregistered_handler_fails_unretryable",
        "doc": "未注册的 handler 名 —— 消息里的 !r 走 repr()，retryable=False。",
        "node": {"id": "N", "mode": "single_shot", "handler": "没注册的"},
        "handler": {"schema": None, "task": "x"},
        "handlers_key": "别的名字",
        "working": {},
        "facts": "",
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "budget_halt_stops_the_loop",
        "doc": "预算到 HALT 档时 REACT 第一轮就抛 NodeFailure（retryable=False）。",
        "node": {"id": "R", "mode": "react", "handler": "x", "budget": {"iterations": 3}},
        "handler": {"schema": None, "task": "转圈"},
        "working": {},
        "facts": "",
        "budget": {"limits": {"tokens": 1000}, "spend": {"tokens": 960}},
        "responses": [],
        "run_id": "r1",
    },
    {
        "name": "degraded_budget_skips_llm_critics",
        "doc": "预算降到 RULES_ONLY 时 allow_llm=False 传给 panel.judge —— 降级要记账、不静默。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x",
                 "critics": ["coverage"], "critic_rounds": 1},
        "handler": {"schema": {"type": "object"}, "task": "抽"},
        "working": {},
        "facts": "黑板：无",
        "budget": {"limits": {"tokens": 1000}, "spend": {"tokens": 880}},
        "responses": [{"data": {"objects": []}}],
        "judgements": [[{"lens": "coverage", "passed": True}]],
        "run_id": "r1",
    },
    {
        "name": "critic_passes_first_round_no_refine",
        "doc": "首轮全过就跳出，不发修订调用（done=1）。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x",
                 "critics": ["a", "b"], "critic_rounds": 3},
        "handler": {"schema": {"type": "object"}, "task": "抽"},
        "working": {},
        "facts": "",
        "responses": [{"data": {"ok": 1}}],
        "judgements": [[{"lens": "a", "passed": True}, {"lens": "b", "passed": True}]],
        "run_id": "r1",
    },
    {
        "name": "refine_with_null_data_keeps_previous_draft",
        "doc": "comp.data 为 None 时保留上一版 draft —— 不要把 None 写进产物。",
        "node": {"id": "N", "mode": "single_shot", "handler": "x",
                 "critics": ["a"], "critic_rounds": 2},
        "handler": {"schema": {"type": "object"}, "task": "抽",
                    "finalize_merge": {"kept": True}},
        "working": {},
        "facts": "",
        "responses": [
            {"data": {"v": 1}},
            {"text": "模型这次没给结构化结果", "data": None},
        ],
        "judgements": [
            [{"lens": "a", "passed": False, "findings": [{"code": "X", "claim": "不行"}]}],
            [{"lens": "a", "passed": True}],
        ],
        "run_id": "r1",
    },
]


async def _run_one(c: dict[str, Any]) -> dict[str, Any]:
    gw_cfg = c.get("gateway", {})
    pad_cfg = c.get("pad", {})
    b_cfg = c.get("budget", {})

    budget = Budget(**b_cfg.get("limits", {}))
    if b_cfg.get("spend"):
        budget.spend(**b_cfg["spend"])

    rec = StubRecorder(c.get("answers", {}))
    cm = StubCM()
    bus = StubBus(c.get("facts", ""))
    gw = StubGateway(
        c.get("responses", []),
        rounds=gw_cfg.get("rounds", 2),
        iterations=gw_cfg.get("iterations", 4),
        samples=gw_cfg.get("samples", 1),
        model=gw_cfg.get("model", "stub-model"),
    )
    panel = StubPanel(c.get("judgements", []))
    handler = StubHandler(c["handler"])
    working = StubWorking(c.get("working", {}))

    # FakePad 的构造参数由用例给，但 budget_tokens 必须由 loop 自己算（tokens // 2），
    # 所以这里只补 over_at / compact_to，budget_tokens 原样透传。
    def make_pad(*, budget_tokens: int) -> FakePad:
        return FakePad(
            budget_tokens=budget_tokens,
            over_at=tuple(pad_cfg.get("over_at", ())),
            compact_to=pad_cfg.get("compact_to", 0),
        )

    pads: list[FakePad] = []

    def pad_factory(**kw: Any) -> FakePad:
        p = make_pad(**kw)
        pads.append(p)
        return p

    loop_mod.Scratchpad = pad_factory  # type: ignore[assignment]
    try:
        agent = AgentLoop(
            gateway=gw, ctx_manager=cm, panel=panel, bus=bus, recorder=rec,
            budget=budget, handlers={c.get("handlers_key", c["node"]["handler"]): handler},
        )
        error: dict[str, Any] | None = None
        result: dict[str, Any] | None = None
        try:
            res = await agent.run(
                _spec(c["node"]), working=working, deps=list(c["node"].get("deps", ())),
                run_id=c["run_id"],
            )
            result = {
                "node_id": res.node_id,
                "output": res.output,
                "verdicts": [v.to_dict() for v in res.verdicts],
                "digest": res.digest,
                "iterations": res.iterations,
                "critic_rounds": res.critic_rounds,
                "context_stats": res.context_stats,
                "passed": res.passed,
            }
        except NodeFailure as exc:
            error = {"type": "NodeFailure", "message": str(exc),
                     "node_id": exc.node_id, "retryable": exc.retryable}
        except HumanInputRequired as exc:
            error = {"type": "HumanInputRequired", "message": str(exc),
                     "node_id": exc.node_id, "request_id": exc.request_id,
                     "payload": exc.payload}
    finally:
        loop_mod.Scratchpad = FakePad  # type: ignore[assignment]

    return {
        "name": c["name"],
        "doc": c["doc"],
        "case": {k: v for k, v in c.items() if k not in ("name", "doc")},
        "calls": gw.calls,
        "events": rec.events,
        "judged": panel.judged,
        "validated": panel.validated,
        "assembles": cm.assembles,
        "reflections": cm.reflections,
        "fact_patterns": bus.patterns,
        "selects": working.selects,
        "trace": handler.trace,
        "pads": [{"budget_tokens": p.budget_tokens, "entries": p.entries} for p in pads],
        "result": result,
        "error": error,
    }


# ══════════════════════════════════════════════════════════════════
#  纯函数用例
# ══════════════════════════════════════════════════════════════════
PARSE_ARGS: list[dict[str, Any]] = [
    {"args_json": "{\"query\": \"计划金额\"}"},
    {"args_json": "{}"},
    {"args_json": ""},
    {"args_json": "   "},
    {"args_json": "不是 JSON"},
    {"args_json": "[1, 2]"},
    {"args_json": "\"字符串\""},
    {"args_json": "null"},
    {"args_json": "123"},
    {"args": {"a": 1}},
    {"args_json": None, "args": {"b": 2}},
    {"args_json": "", "args": "{\"c\": 3}"},
    {"args_json": {"d": 4}},
    {},
    {"tool": "search"},
    {"args_json": "{\"嵌套\": {\"x\": [1, {\"y\": null}]}}"},
]

FMT_ACTIONS: list[dict[str, Any]] = [
    {"tool": "search", "args": {"query": "计划金额"}},
    {"tool": "search", "args": {}},
    {"args": {"a": 1}},
    {"tool": "x"},
    {"tool": "长" * 5, "args": {"k": "值" * 400}},
    {"tool": "t", "args": {"n": 2.5, "b": True, "z": None}},
    # `args[:300]` 切的是**码点**。星平面字符在 JS 里占两个 UTF-16 码元，照 JS 的
    # slice 切会在 150 个 emoji 处断开、还可能留半个代理对。
    {"tool": "t", "args": {"k": "🎯" * 400}},
]

STEP_PROMPTS: list[dict[str, Any]] = [
    {"ctx_text": "上下文", "pad_render": "", "pad_len": 0, "steps": None},
    {"ctx_text": "上下文", "pad_render": "做过的事", "pad_len": 2, "steps": None},
    {"ctx_text": "上下文", "pad_render": "", "pad_len": 0,
     "steps": [{"goal": "先读表头"}, {"goal": "再抽行"}]},
    {"ctx_text": "上下文", "pad_render": "做过的事", "pad_len": 1,
     "steps": [{"goal": "一"}, {"tool": "无 goal"}]},
    {"ctx_text": "上下文", "pad_render": "x", "pad_len": 3, "steps": []},
]

ROUTES: list[dict[str, Any]] = [
    {"outputs": {}, "deps": [], "critics": []},
    {"outputs": {"A": {"n": 1}}, "deps": ["A"], "critics": ["a", "b"]},
    {"outputs": {"A": {"n": 1}}, "deps": ["A"], "critics": ["a", "b", "c"]},
    {"outputs": {"A": {"text": "x" * 20000}}, "deps": ["A"], "critics": []},
    {"outputs": {"A": {"text": "x" * 200000}}, "deps": ["A"], "critics": []},
    {"outputs": {"A": {"text": "汉" * 4000}}, "deps": ["A"], "critics": []},
]

#: `str(obs)` 的形态。故意不放值为整数的 float（1.0）—— JS 里 1 和 1.0 是同一个
#: 值，那条分叉在 ids/journal 的 golden 里已经钉过，这里不重复。
PY_STRS: list[Any] = [
    "abc",
    "",
    "带'单引号'的",
    None,
    True,
    False,
    42,
    -7,
    2.5,
    1e-05,
    [],
    {},
    {"error": "本节点没有可用工具"},
    {"a": 1, "b": [1, 2, "x"], "c": None},
    [{"api_name": "pbpHeader"}, {"api_name": "createPbp"}],
    {"q": "it's"},
    {"多行": "第一行\n第二行"},
    {"嵌套": {"x": [1, {"y": True}]}},
    {"emoji": "🎯 命中"},
    "🎯 顶层字符串原样返回",
]


class _PadStub:
    def __init__(self, render: str, n: int) -> None:
        self._render = render
        self._n = n

    def render(self) -> str:
        return self._render

    def __len__(self) -> int:
        return self._n


def _refine_verdicts() -> list[dict[str, Any]]:
    return [
        {
            "draft": {"objects": [{"api_name": "pbpHeader"}]},
            "verdicts": [
                {"lens": "coverage", "passed": False,
                 "findings": [{"code": "MISSING", "claim": "少了行动",
                               "evidence_checked": ["A1", "B2", "C3", "D4"]},
                              {"code": "NAMING", "claim": "命名不规范"}]},
                {"lens": "provenance", "passed": True},
            ],
        },
        {"draft": "纯字符串产物", "verdicts": [
            {"lens": "x", "passed": False, "findings": [{"code": "C", "claim": "有'引号'"}]},
        ]},
        {"draft": {"big": "长" * 12000}, "verdicts": [
            {"lens": "y", "passed": False, "findings": [{"code": "D", "claim": "太长"}]},
        ]},
        {"draft": None, "verdicts": []},
    ]


def main() -> None:
    runs = [asyncio.run(_run_one(c)) for c in RUNS]

    payload: dict[str, Any] = {
        "_source": "src/ontocopilot/kernel/loop.py",
        "_note": (
            "stub 全部外挂，Python 原件未改；Scratchpad 被换成 FakePad（它是 run() 内部 new "
            "出来的，而 memory/short_term.py 尚未迁）。TS 侧要搭一份逐字等价的 stub。"
        ),
        "schemas": {"STEP_SCHEMA": STEP_SCHEMA, "PLAN_SCHEMA": PLAN_SCHEMA},
        "parse_action_args": [
            {"action": a, "out": parse_action_args(dict(a))} for a in PARSE_ARGS
        ],
        "fmt_action": [
            {"action": a, "out": loop_mod._fmt_action(dict(a))} for a in FMT_ACTIONS
        ],
        "step_prompt": [
            {**c, "out": AgentLoop._step_prompt(
                c["ctx_text"], _PadStub(c["pad_render"], c["pad_len"]), c["steps"])}
            for c in STEP_PROMPTS
        ],
        "refine_prompt": [
            {"draft": c["draft"], "verdicts": c["verdicts"],
             "out": loop_mod._refine_prompt(c["draft"], [_verdict(v) for v in c["verdicts"]])}
            for c in _refine_verdicts()
        ],
        "py_str": [{"value": v, "out": str(v)} for v in PY_STRS],
        "route": [],
        "runs": runs,
    }

    # _route 需要一个 AgentLoop 实例，但只用到 self（不碰任何协作方）
    router = AgentLoop(gateway=None, ctx_manager=None, panel=None, bus=None,  # type: ignore[arg-type]
                       recorder=None, budget=Budget(), handlers={})
    for c in ROUTES:
        node = _spec({"id": "N", "mode": "single_shot", "handler": "h",
                      "critics": c["critics"]})
        d = router._route(node, StubWorking(c["outputs"]), list(c["deps"]))
        payload["route"].append({
            "outputs_keys": sorted(c["outputs"]), "deps": c["deps"],
            "critics": c["critics"], "out": str(d),
            # 输入太大时不整份塞进 golden，改用可复现的构造式
            "outputs": c["outputs"] if len(json.dumps(c["outputs"])) < 400 else None,
            "outputs_build": None if len(json.dumps(c["outputs"])) < 400 else {
                "key": "A", "field": "text",
                "char": next(iter(c["outputs"].values()))["text"][0],
                "n": len(next(iter(c["outputs"].values()))["text"]),
            },
        })

    OUT.mkdir(exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path = OUT / "loop.json"
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    print(f"  loop.json  {path.stat().st_size:>8} B  sha256[:16]={digest}")


if __name__ == "__main__":
    main()
