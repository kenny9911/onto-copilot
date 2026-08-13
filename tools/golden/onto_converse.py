"""导出 onto/converse + onto/engagement + onto/engagement_runtime 的 golden。

字节确定：所有时间戳、id、created_at 都写死；json.dumps 用 sort_keys + 固定缩进。
跑法：`.venv/bin/python tools/golden/onto_converse.py`（重跑两次 shasum 一致）。

**注意**：这里没有一处"手写期望值" —— 全部由 Python 真跑出来。TS 侧对着它断言。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.kernel.agents import default_agents  # noqa: E402
from ontocopilot.kernel.critic import CriticContext  # noqa: E402
from ontocopilot.kernel.intent import Intent, IntentMatch  # noqa: E402
from ontocopilot.kernel.tools import Danger, ToolRegistry  # noqa: E402
from ontocopilot.onto import converse as C  # noqa: E402
from ontocopilot.onto import engagement_runtime as ER  # noqa: E402
from ontocopilot.onto.engagement import (  # noqa: E402
    FDE_ENGAGEMENT_AGENTS,
    build_fde_engagement_dag,
)
from ontocopilot.onto.oir import (  # noqa: E402
    OIR,
    ActionType,
    BusinessRule,
    LocatorKind,
    ObjectType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)
from ontocopilot.onto.questions import (  # noqa: E402
    Question,
    QuestionBacklog,
    QuestionPriority,
    QuestionStatus,
)

OUT = ROOT / "golden" / "onto.converse.json"


# ══════════════════════════════════════════════════════════════════
#  共用的假件
# ══════════════════════════════════════════════════════════════════
class _Ctx:
    turn_id = "t1"
    approved = True
    rec = None

    def __init__(self) -> None:
        self.pending: list = []


class _Comp:
    def __init__(self, data: Any, usd: float = 0.001) -> None:
        self.data = data
        self.text = ""
        self.usd = usd


class _Gw:
    """按脚本回放的网关，同时把每次调用的 prompt/kwargs 记下来。"""

    def __init__(self, script: list[Any], usd: float = 0.001) -> None:
        self.script = list(script)
        self.usd = usd
        self.calls: list[dict[str, Any]] = []

    async def call(self, node_id: str, prompt: str, **kw: Any) -> _Comp:
        self.calls.append({
            "node_id": node_id,
            "prompt": prompt,
            "key": kw.get("key"),
            "schema_required": (kw.get("schema") or {}).get("required"),
        })
        data = self.script.pop(0) if self.script else {
            "answer": "没有更多了", "citations": [], "confidence": 0.1}
        if isinstance(data, BaseException):
            raise data
        return _Comp(data, self.usd)


def _registry() -> ToolRegistry:
    reg = ToolRegistry()

    @reg.fn("evidence.search", "检索材料",
            {"type": "object", "required": ["query"],
             "properties": {"query": {"type": "string"}}},
            danger=Danger.READ, scopes=("readonly",))
    def _s(ctx, query: str):  # noqa: ANN001, ANN202
        return {"chunks": [{"cite": "梳理表.xlsx!实体!R2-2", "text": f"命中 {query}"}]}

    @reg.fn("oir.query", "查中间表示",
            {"type": "object", "required": ["kind"],
             "properties": {"kind": {"type": "string"}}},
            danger=Danger.READ, scopes=("readonly",))
    def _q(ctx, kind: str):  # noqa: ANN001, ANN202
        raise RuntimeError(f"故意炸给模型看：{kind}")

    return reg


# ══════════════════════════════════════════════════════════════════
#  converse
# ══════════════════════════════════════════════════════════════════
_OBS = [json.dumps({"chunks": [{"cite": "梳理表.xlsx!实体!R2-2", "text": "采购业务计划头"}]},
                   ensure_ascii=False)]


def _converse_static() -> dict[str, Any]:
    labels = []
    for s in ("single_shot", "react", "plan_execute", "不存在的"):
        for lang in ("zh", "en", "ja"):
            labels.append([s, lang, C.strategy_label(s, lang)])

    needs = []
    texts = [
        "随便一句",
        "采购包相关的对象都有哪些？",
        "为什么这两个对象有关系",
        "含税的口径依据在材料哪里？",
        "现在都有哪些对象？列一下",
        "材料里关于「框架协议」是怎么说的？",
        "",
    ]
    for intent in Intent:
        for t in texts:
            needs.append([str(intent), t,
                          C.needs_reasoning(IntentMatch(intent, 0.9), t)])

    picks = []
    for t in [
        "你好",
        "材料里关于框架协议是怎么说的？",
        "把采购包连到订单，然后重出模板",
        "这份材料里有什么？",
        "先改一下字段，然后再加一条规则",
        "然后呢",
        "同时把它删掉并且重出模板",
        "",
    ]:
        for has_tools in (True, False):
            picks.append([t, has_tools, C.pick_strategy(t, has_tools=has_tools)])

    grounding = []
    cases: list[tuple[Any, list[str]]] = [
        ({"answer": "有关系", "citations": ["梳理表.xlsx!实体!R99-99"], "confidence": 0.9}, _OBS),
        ({"answer": "有关系", "citations": ["梳理表.xlsx!实体!R2-2"], "confidence": 0.9}, _OBS),
        ({"answer": "肯定有关系", "citations": [], "confidence": 0.95}, _OBS),
        ({"answer": "材料里没写", "citations": [], "confidence": 0.2}, _OBS),
        ({"answer": "", "citations": [], "confidence": 0.5}, _OBS),
        ("不是字典", _OBS),
        ({"answer": "答", "citations": [], "confidence": 0.7}, []),
        ({"answer": "答", "citations": ["  ", ""], "confidence": 0.9}, _OBS),
        ({"answer": "答", "citations": ["  梳理表.xlsx!实体!R2-2  "], "confidence": 0.9}, _OBS),
        ({"answer": "  \n ", "citations": [], "confidence": 0.1}, _OBS),
        ({"answer": "答", "confidence": 0.7}, _OBS),
        ({"answer": "答", "citations": [], "confidence": None}, _OBS),
    ]
    for answer, observed in cases:
        grounding.append({
            "answer": answer, "observed": observed,
            "findings": [f.to_dict() for f in C.check_grounding(answer, observed)],
        })

    parse_args = []
    for raw in ['{"a":1}', "{}", "", "   ", "不是 json", "[1,2]", '"str"', None, 7,
                {"already": "dict"}, '{"a": {"b": [1,2]}}']:
        parse_args.append([raw, C._parse_args(raw)])

    turns = []
    t1 = C.ConverseTurn(text="问")
    t1.answer = "答"
    t1.citations = ["a"]
    t1.confidence = 0.123456
    t1.usd = 0.000123456
    t1.next_questions = ["x"]
    t1.steps = [{"n": 1}]
    t1.strategy = "react"
    turns.append(t1.to_dict())
    t2 = C.ConverseTurn(text="问2")
    t2.findings = C.check_grounding(
        {"answer": "有", "citations": ["假的"], "confidence": 0.9}, _OBS)
    t2.confidence = 0.005
    t2.usd = 0.00005
    turns.append(t2.to_dict())

    reg = _registry()
    specs = reg.for_scope("readonly")
    agent = C.ConversationAgent(gateway=None, tools=reg)
    prompts = []
    for context, transcript, final in [
        ("", [], False),
        ("产物：3 个对象", [], False),
        ("产物：3 个对象", ["你想：a\n你调了 t({})\n返回：{}"], False),
        ("", ["1", "2", "3", "4", "5"], False),
        ("产物：3 个对象", ["1", "2"], True),
        ("", [], True),
    ]:
        prompts.append({
            "context": context, "transcript": transcript, "final": final,
            "out": agent._prompt("问句", context, transcript, specs, final),
        })
    plan_prompts = [
        {"context": "", "out": agent._plan_prompt("做事", "", specs)},
        {"context": "有状态", "out": agent._plan_prompt("做事", "有状态", specs)},
    ]

    return {
        "answer_schema": C.ANSWER_SCHEMA,
        "step_schema": C._STEP_SCHEMA,
        "plan_schema": C._PLAN_SCHEMA,
        "system": C._SYSTEM,
        "chat_system": C._CHAT_SYSTEM,
        "system_en": C.ConversationAgent(gateway=None, tools=_registry(),
                                         lang="en").system,
        "system_override_en": C.ConversationAgent(gateway=None, tools=_registry(),
                                                  lang="en", system="自定义").system,
        "strategy_label_zh": C.STRATEGY_LABEL,
        "strategy_label_en": C.STRATEGY_LABEL_EN,
        "strategy_label": labels,
        "needs_reasoning": needs,
        "pick_strategy": picks,
        "check_grounding": grounding,
        "parse_args": parse_args,
        "turn_to_dict": turns,
        "prompt": prompts,
        "plan_prompt": plan_prompts,
    }


async def _one_run(name: str, script: list[Any], text: str, **kw: Any) -> dict[str, Any]:
    gw = _Gw(script)
    reg = kw.pop("registry", None) or _registry()
    seen: list[dict[str, Any]] = []
    agent = C.ConversationAgent(gateway=gw, tools=reg, **kw)
    turn = await agent.run(text, ctx=_Ctx(), context=kw.pop("_context", ""),
                           on_step=seen.append)
    return {
        "name": name,
        "text": text,
        "turn": turn.to_dict(),
        "steps_seen": seen,
        "gw_calls": [{"node_id": c["node_id"], "key": c["key"],
                      "schema_required": c["schema_required"]} for c in gw.calls],
        "prompts": [c["prompt"] for c in gw.calls],
    }


async def _converse_runs() -> list[dict[str, Any]]:
    runs = []
    runs.append(await _one_run(
        "tool_then_answer",
        [{"kind": "tool", "thought": "先查材料", "tool": "evidence.search",
          "args_json": '{"query":"采购计划"}'},
         {"kind": "answer", "thought": "查到了就答", "answer": "查到了",
          "citations": ["梳理表.xlsx!实体!R2-2"], "confidence": 0.9}],
        "采购计划有哪些对象"))

    runs.append(await _one_run(
        "fabricated_citation_stripped",
        [{"kind": "tool", "thought": "查", "tool": "evidence.search",
          "args_json": '{"query":"x"}'},
         {"kind": "answer", "thought": "答", "answer": "结论",
          "citations": ["梳理表.xlsx!实体!R2-2", "编的.xlsx!无!R9-9"], "confidence": 0.9}],
        "问"))

    runs.append(await _one_run(
        "unknown_tool_goes_back_to_model",
        [{"kind": "tool", "thought": "查", "tool": "不存在的工具", "args_json": "{}"},
         {"kind": "answer", "thought": "那个没有", "answer": "那个工具没有",
          "citations": [], "confidence": 0.3}],
        "问"))

    runs.append(await _one_run(
        "tool_raises_goes_back_to_model",
        [{"kind": "tool", "thought": "查", "tool": "oir.query",
          "args_json": '{"kind":"objects"}'},
         {"kind": "answer", "thought": "工具炸了", "answer": "查不到",
          "citations": [], "confidence": 0.3}],
        "问"))

    runs.append(await _one_run(
        "gateway_error_is_reported",
        [RuntimeError("网关挂了")],
        "问"))

    runs.append(await _one_run(
        "step_budget",
        [{"kind": "tool", "thought": f"第{i}次", "tool": "evidence.search",
          "args_json": '{"query":"x"}'} for i in range(10)],
        "问", max_steps=3))

    runs.append(await _one_run(
        "answer_at_first_step",
        [{"kind": "answer", "thought": "打招呼，不用查东西", "answer": "在",
          "citations": [], "confidence": 0.9}],
        "你好"))

    runs.append(await _one_run(
        "empty_thought_is_reported",
        [{"kind": "answer", "thought": "", "answer": "随便说说",
          "citations": [], "confidence": 0.5}],
        "问"))

    runs.append(await _one_run(
        "no_tool_name_finishes",
        [{"kind": "tool", "thought": "忘了填工具名", "tool": "  ",
          "answer": "那就直接答", "citations": [], "confidence": 0.4,
          "args_json": "{}"}],
        "问"))

    runs.append(await _one_run(
        "next_questions_dedup_and_cap",
        [{"kind": "answer", "thought": "答", "answer": "答", "citations": [],
          "confidence": 0.5,
          "next_questions": [" 一 ", "", "一", "二", "三", "四"]}],
        "问"))

    runs.append(await _one_run(
        "missing_next_questions",
        [{"kind": "answer", "thought": "答", "answer": "答", "citations": [],
          "confidence": 0.5}],
        "问"))

    # single_shot：没有工具就一次出答
    runs.append(await _one_run(
        "single_shot_no_tools",
        [{"thought": "寒暄", "answer": "在。", "citations": [], "confidence": 0.9}],
        "你好", registry=ToolRegistry()))

    runs.append(await _one_run(
        "single_shot_gateway_error",
        [RuntimeError("网关又挂了")],
        "你好", registry=ToolRegistry()))

    # plan_execute
    runs.append(await _one_run(
        "plan_execute",
        [{"steps": [{"goal": "把采购包连到订单"}, {"goal": "重出模板"},
                    {"nogoal": "会被丢掉"}]},
         {"kind": "answer", "thought": "做完了", "answer": "两件事都办了。",
          "citations": [], "confidence": 0.9}],
        "把采购包连到订单，然后重出模板"))

    runs.append(await _one_run(
        "plan_execute_empty_plan_falls_back",
        [{"steps": []},
         {"kind": "answer", "thought": "直接答", "answer": "好了。",
          "citations": [], "confidence": 0.9}],
        "把采购包连到订单，然后重出模板"))

    runs.append(await _one_run(
        "plan_execute_plan_call_fails_falls_back",
        [RuntimeError("列计划失败"),
         {"kind": "answer", "thought": "直接答", "answer": "好了。",
          "citations": [], "confidence": 0.9}],
        "把采购包连到订单，然后重出模板"))

    # 固定策略 + 英文界面
    runs.append(await _one_run(
        "forced_strategy_en",
        [{"kind": "answer", "thought": "just answer", "answer": "OK",
          "citations": [], "confidence": 0.5}],
        "hello", strategy="react", lang="en"))

    runs.append(await _one_run(
        "plan_execute_en",
        [{"steps": [{"goal": "link it"}]},
         {"kind": "answer", "thought": "done", "answer": "done",
          "citations": [], "confidence": 0.5}],
        "把采购包连到订单，然后重出模板", lang="en"))

    return runs


# ══════════════════════════════════════════════════════════════════
#  engagement（冻结的控制面）
# ══════════════════════════════════════════════════════════════════
def _node_dump(node: Any) -> dict[str, Any]:
    return {
        "id": node.id,
        "mode": str(node.mode),
        "handler": node.handler,
        "deps": list(node.deps),
        "scope": {
            "evidence_top_k": node.scope.evidence_top_k,
            "evidence_files": (list(node.scope.evidence_files)
                               if node.scope.evidence_files is not None else None),
            "blackboard_pattern": node.scope.blackboard_pattern,
        },
        "budget": {
            "tokens": node.budget.tokens, "iterations": node.budget.iterations,
            "wallclock_s": node.budget.wallclock_s, "tool_calls": node.budget.tool_calls,
        },
        "critics": list(node.critics),
        "critic_rounds": node.critic_rounds,
        "gate": (None if node.gate is None else
                 {"kind": node.gate.kind, "require": list(node.gate.require)}),
        "difficulty": (None if node.difficulty is None else str(node.difficulty)),
        "sandbox": node.sandbox,
        "retries": node.retries,
        "fanout_over": node.fanout_over,
        "params": _jsonable(node.params),
    }


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def _engagement() -> dict[str, Any]:
    dag = build_fde_engagement_dag()
    return {
        "agents": list(FDE_ENGAGEMENT_AGENTS),
        "name": dag.name,
        "freeze_before": dag.freeze_before,
        "frozen": dag.frozen,
        "topo_order": dag.topo_order(),
        "describe": _jsonable(dag.describe()),
        "nodes": [_node_dump(dag[n]) for n in dag.topo_order()],
        "resolve_deps": {n: dag.resolve_deps(n) for n in dag.topo_order()},
    }


# ══════════════════════════════════════════════════════════════════
#  engagement_runtime
# ══════════════════════════════════════════════════════════════════
def _prov(file_name: str, **loc: Any) -> Provenance:
    return Provenance(file_id="f1", file_name=file_name, locator=loc,
                      snippet="片段", extractor="llm", confidence=0.8)


def _fixture_oir() -> OIR:
    oir = OIR()
    ev = _prov("梳理表.xlsx", kind=LocatorKind.CELL, sheet="实体", row=2, col=1)
    oir.add_object(ObjectType(
        rid=make_rid("ot", "PurchaseOrder"),
        api_name=extracted("PurchaseOrder", ev),
        display_name=extracted("采购订单", ev),
        description=inferred("采购订单业务对象"),
        primary_key=inferred(["poNo"]),
    ))
    oir.add_object(ObjectType(
        rid=make_rid("ot", "SupplierMaster"),
        api_name=inferred("SupplierMaster"),
        display_name=inferred("供应商主数据"),
    ))
    oir.add_object(ObjectType(
        rid=make_rid("ot", "Attachment"),
        api_name=inferred("Attachment"),
        display_name=inferred("合同文档附件"),
    ))
    oir.add_object(ObjectType(
        rid=make_rid("ot", "Misc"),
        api_name=inferred(""),
        display_name=inferred(""),
    ))
    oir.add_action(ActionType(
        rid=make_rid("act", "createPo"),
        api_name=inferred("createPo"),
        source_endpoint=inferred({"url": "https://erp.example.com/api/v1/po",
                                  "method": "POST"}),
    ))
    oir.add_action(ActionType(
        rid=make_rid("act", "listPo"),
        api_name=inferred("listPo"),
        source_endpoint=inferred({"path": "/local/po"}),
    ))
    oir.add_action(ActionType(
        rid=make_rid("act", "noop"),
        api_name=inferred("noop"),
    ))
    oir.add_rule(BusinessRule(
        rid=make_rid("rule", "r1"),
        statement=extracted("采购包创建后不能修改采购方式", ev),
        kind=extracted("PROCESS", ev),
        applies_to=[make_rid("ot", "PurchaseOrder")],
    ))
    oir.add_rule(BusinessRule(
        rid=make_rid("rule", "r2"),
        statement=inferred("金额超过 10 万需二级审批"),
        kind=inferred("不认识的种类"),
    ))
    oir.add_rule(BusinessRule(
        rid=make_rid("rule", "r3"),
        statement=inferred("   "),
    ))
    return oir


def _fixture_flow() -> dict[str, Any]:
    ev = _prov("流程图.pptx", kind=LocatorKind.PAGE, page=3).to_dict()
    noname = {"file_id": "f2", "file_name": "", "locator": {},
              "snippet": "", "extractor": "llm", "confidence": 0.5, "cite": ""}
    unnamed_loc = {"file_id": "f3", "file_name": "口述.txt",
                   "locator": {"kind": "raw", "ref": "x"},
                   "snippet": "", "extractor": "llm", "confidence": 0.5, "cite": ""}
    return {
        "nodes": [
            {"rid": "fn.1",
             "label": {"value": "创建采购申请", "origin": "extracted",
                       "confidence": 0.8, "evidence": [ev]},
             "actor": {"value": "采购员", "origin": "extracted",
                       "confidence": 0.8, "evidence": [ev, noname]},
             "objects": ["ot.PurchaseOrder"],
             "endpoint": "https://erp.example.com/api/v1/po"},
            {"rid": "fn.2",
             "label": {"value": "", "origin": "inferred",
                       "confidence": 0.4, "evidence": []},
             "actor": None,
             "objects": [],
             "endpoint": ""},
            {"rid": "fn.3",
             "label": "裸字符串标签",
             "actor": {"value": "", "origin": "inferred",
                       "confidence": 0.4, "evidence": [unnamed_loc]},
             "endpoint": "/api/local"},
        ],
        "edges": [
            {"rid": "fe.1", "from": "fn.1", "to": "fn.2", "kind": "sequence",
             "label": "提交"},
            {"id": "fe.2", "from": "fn.2", "to": "fn.3", "kind": "异常分支"},
            {"rid": "fe.3", "from": "fn.3", "to": "fn.1", "kind": "conditional gateway",
             "label": "驳回"},
            {"rid": "fe.4", "from": "fn.1", "to": "fn.3", "kind": "timeout"},
            {"rid": "fe.5", "from": "fn.1", "to": "fn.3", "kind": "取消"},
            {"rid": "fe.6", "from": "fn.1", "to": "fn.3", "kind": None},
        ],
    }


#: 只喂给 ProcessHandler 的畸形流程：节点没有 rid（只有 id）、连 id 都没有、
#: label 缺失。**不能**喂给 build_package —— canonical 那边对空 legacy_id 直接
#: KeyError（Python 侧既有行为，不是这次要修的东西）。
def _fixture_flow_alt() -> dict[str, Any]:
    return {
        "nodes": [
            {"id": "fn.only-id", "objects": ["a", "b"], "endpoint": "x"},
            {"label": {"value": "没有任何 id", "origin": "inferred",
                       "confidence": 0.4, "evidence": []}},
            {"rid": "fn.z", "label": None, "actor": {"value": None}},
        ],
        "edges": [{"from": "fn.only-id", "to": "fn.z"}],
    }


_T0 = 1_760_000_000.0


def _fixture_backlog() -> QuestionBacklog:
    bag = QuestionBacklog()
    rows = [
        Question(id="q.erp.version", text="当前 ERP 产品版本是什么？",
                 status=QuestionStatus.OPEN, audience_role="ERP顾问",
                 priority=QuestionPriority.BLOCKING,
                 blocked_artifacts=["ontology.package.json"],
                 source_kind="conflict", evidence_ids=["梳理表.xlsx!实体!R2-2"],
                 created_at=_T0 + 1, updated_at=_T0 + 1),
        Question(id="q.rule.approval", text="超额审批走几级？",
                 status=QuestionStatus.ASSIGNED, owner_user_id="u1",
                 audience_role="业务负责人", priority=QuestionPriority.HIGH,
                 source_kind="rule", created_at=_T0 + 2, updated_at=_T0 + 2),
        Question(id="q.obj.owner", text="供应商主数据谁维护？",
                 status=QuestionStatus.BLOCKED, audience_role="",
                 source_kind="data_object", created_at=_T0 + 3, updated_at=_T0 + 3),
        Question(id="q.done", text="已答的那条", status=QuestionStatus.ANSWERED,
                 source_kind="open_question", created_at=_T0 + 4, updated_at=_T0 + 4),
        Question(id="q.deferred", text="延后的那条", status=QuestionStatus.DEFERRED,
                 audience_role="ERP consultant", priority=QuestionPriority.LOW,
                 source_kind="open_question", created_at=_T0 + 5, updated_at=_T0 + 5),
    ]
    for q in rows:
        bag.add(q, preserve_lifecycle=False)
    return bag


_DECISIONS = [
    {"id": "dec.1", "question_id": "q.done", "answer": "两级", "decided_by": "u1"},
    {"id": "dec.2", "question_id": "q.rule.approval", "answer": {"n": 2}},
]


class _RunCtx:
    def __init__(self, node_id: str) -> None:
        self.node_id = node_id


def _runtime(backlog_dict: dict[str, Any], *, oir: Any, flow: Any,
             downloadable: bool = True) -> ER.EngagementRuntimeInput:
    return ER.EngagementRuntimeInput(
        session_id="engagement-test",
        project="采购到付款",
        oir=oir,
        flow=flow,
        backlog=QuestionBacklog.from_dict(backlog_dict),
        decisions=list(_DECISIONS),
        generated_at="2026-08-12T00:00:00+00:00",
        release_downloadable=downloadable,
    )


async def _engagement_runtime() -> dict[str, Any]:
    oir_dict = _fixture_oir().to_dict()
    flow_dict = _fixture_flow()
    backlog_dict = _fixture_backlog().to_dict()

    out: dict[str, Any] = {
        "fixture": {"oir": oir_dict, "flow": flow_dict, "backlog": backlog_dict,
                    "decisions": list(_DECISIONS), "flow_alt": _fixture_flow_alt()},
        "expected_artifacts": list(ER._EXPECTED_ARTIFACTS),
        "edge_kind": [[v, ER._edge_kind(v)] for v in [
            "sequence", "SEQUENCE", "异常分支", "exception", "timeout", "超时",
            "cancel", "取消", "conditional", "gateway", "条件跳转", "", None, 0, 1,
            "Exception timeout",
        ]],
        "classification": [[v, ER._classification(v)] for v in [
            "供应商主数据", "master data", "MASTER", "合同文档附件", "document",
            "采购订单", "申请单", "order", "transaction", "随便什么", "",
            "主数据的订单",
        ]],
        "oir_stats": ER._oir_stats(oir_dict),
        "oir_stats_empty": ER._oir_stats({}),
    }

    rt = _runtime(backlog_dict, oir=oir_dict, flow=flow_dict)
    out["input"] = {
        "oir_dict_keys": sorted(rt.oir_dict()),
        "flow_dict": rt.flow_dict(),
        "decision_rows": rt.decision_rows(),
        "pending": [q.id for q in rt.pending()],
        "blockers": [q.id for q in rt.blockers()],
    }
    out["input_variants"] = {
        "flow_none": ER.EngagementRuntimeInput(
            session_id="s", project="p", oir=oir_dict).flow_dict(),
        "decisions_mapping": ER.EngagementRuntimeInput(
            session_id="s", project="p", oir=oir_dict,
            decisions={"decisions": [{"id": "d"}]}).decision_rows(),
        "decisions_empty_ledger": ER.EngagementRuntimeInput(
            session_id="s", project="p", oir=oir_dict).decision_rows(),
    }

    handlers = ER.engagement_handlers(rt)
    intake = handlers["agent.fde_interviewer"].project({})
    process = handlers["agent.process_modeler"].project({})
    erp = handlers["agent.erp_mapper"].project({"PROCESS": process})
    rules = handlers["agent.rule_engineer"].project({})
    objects = handlers["agent.data_steward"].project({})
    gap = await handlers["engagement.collect_gaps"].execute(
        {"PROCESS": process, "ERP_MAP": erp, "RULES": rules, "DATA_OBJECTS": objects},
        _RunCtx("GAP"))
    interview_skip = handlers["engagement.interview"].skip_model({})
    interview_req = handlers["engagement.interview"].human_request(None, {})
    out["handlers"] = {
        "INTAKE": intake, "PROCESS": process, "ERP_MAP": erp, "RULES": rules,
        "DATA_OBJECTS": objects, "GAP": gap,
        "INTERVIEW_skip_model": interview_skip,
        "INTERVIEW_human_request": interview_req,
        "tasks": {k: h.task({}) for k, h in sorted(handlers.items())},
        "registry_keys": sorted(handlers),
    }

    alt = _runtime(backlog_dict, oir=oir_dict, flow=_fixture_flow_alt())
    out["handlers"]["PROCESS_alt"] = ER.engagement_handlers(
        alt)["agent.process_modeler"].project({})
    out["handlers"]["ERP_MAP_alt"] = ER.engagement_handlers(
        alt)["agent.erp_mapper"].project({"PROCESS": out["handlers"]["PROCESS_alt"]})

    # 没有阻塞问题时：INTERVIEW 直接跳过模型，走完 CANONICALIZE / REVIEW / EXPORT
    clear = dict(backlog_dict)
    clear_rows = []
    for row in backlog_dict["questions"]:
        row = dict(row)
        if row["id"] == "q.erp.version":
            row["status"] = "answered"
            row["blockedArtifacts"] = []
            row["priority"] = "high"
        clear_rows.append(row)
    clear["questions"] = clear_rows
    rt2 = _runtime(clear, oir=oir_dict, flow=flow_dict)
    h2 = ER.engagement_handlers(rt2)
    canon = await h2["engagement.canonicalize"].execute({}, _RunCtx("CANONICALIZE"))
    review = h2["agent.delivery_reviewer"].project({"CANONICALIZE": canon})
    export = await h2["engagement.export"].execute(
        {"CANONICALIZE": canon, "REVIEW": review}, _RunCtx("EXPORT"))
    out["clear"] = {
        "INTERVIEW_skip_model": h2["engagement.interview"].skip_model({}),
        "pending": [q.id for q in rt2.pending()],
        "blockers": [q.id for q in rt2.blockers()],
        "CANONICALIZE": canon,
        "REVIEW": review,
        "EXPORT": export,
        "traceability": list(ER._traceability(canon)),
    }

    # 交付目录不可写 → REVIEW 多一条 blocker、EXPORT 的 downloadable 为假
    rt3 = _runtime(clear, oir=oir_dict, flow=flow_dict, downloadable=False)
    h3 = ER.engagement_handlers(rt3)
    canon3 = await h3["engagement.canonicalize"].execute({}, _RunCtx("CANONICALIZE"))
    review3 = h3["agent.delivery_reviewer"].project({"CANONICALIZE": canon3})
    export3 = await h3["engagement.export"].execute(
        {"CANONICALIZE": canon3, "REVIEW": review3}, _RunCtx("EXPORT"))
    out["not_downloadable"] = {"REVIEW": review3, "EXPORT": export3}

    # 仍有阻塞问题 → REVIEW 判 BLOCKED
    review_blocked = handlers["agent.delivery_reviewer"].project({"CANONICALIZE": canon})
    out["blocked"] = {"REVIEW": review_blocked}

    # 包不合法 → CANONICALIZE 抛 NodeFailure（两个对象同 rid ⇒ DUPLICATE_ID）
    bad_oir = json.loads(json.dumps(oir_dict, ensure_ascii=False))
    bad_oir["objects"].append(json.loads(json.dumps(oir_dict["objects"][0],
                                                    ensure_ascii=False)))
    bad = _runtime(clear, oir=bad_oir, flow=None)
    try:
        await ER.engagement_handlers(bad)["engagement.canonicalize"].execute(
            {}, _RunCtx("CANONICALIZE"))
    except Exception as exc:  # noqa: BLE001
        out["canonicalize_failure"] = {
            "type": type(exc).__name__,
            "message": str(exc),
            "node_id": getattr(exc, "node_id", None),
            "retryable": getattr(exc, "retryable", None),
        }
    else:
        out["canonicalize_failure"] = None
    out["fixture"]["oir_dup"] = bad_oir

    # REVIEW 拿到一个空包（上游没跑）时的形态
    out["review_empty_input"] = handlers["agent.delivery_reviewer"].project({})
    out["export_empty_input"] = await handlers["engagement.export"].execute(
        {}, _RunCtx("EXPORT"))

    # critics
    critics = ER.engagement_critics()
    verdicts = []
    cases: list[tuple[str, str, Any]] = [
        ("schema", "INTAKE", intake),
        ("schema", "INTAKE", {"engagement": {}}),
        ("schema", "PROCESS", process),
        ("schema", "REVIEW", review),
        ("schema", "GAP", {"随便": 1}),
        ("schema", "INTAKE", "不是 object"),
        ("schema", "INTAKE", None),
        ("provenance", "REVIEW", review),
        ("provenance", "REVIEW", {"traceability": {"unresolved": [f"/x/{i}"
                                                                 for i in range(12)]}}),
        ("provenance", "REVIEW", {"traceability": {"unresolved": []}}),
        ("provenance", "REVIEW", {}),
        ("provenance", "INTAKE", {"traceability": {"unresolved": ["/a"]}}),
        ("provenance", "REVIEW", "不是 object"),
    ]
    for lens, node_id, draft in cases:
        v = await critics[lens].judge(draft, CriticContext(node_id=node_id, gateway=None,
                                                           generator=None))
        verdicts.append({"lens": lens, "node_id": node_id, "verdict": v.to_dict()})
    out["critics"] = {
        "names": sorted(critics),
        "needs_llm": {k: c.needs_llm for k, c in sorted(critics.items())},
        "verdicts": verdicts,
    }

    # _traceability 的独立向量
    out["traceability"] = [
        [{}, list(ER._traceability({}))],
        [{"a": {"assertion": {"origin": "INFERRED", "evidenceIds": []}}},
         list(ER._traceability({"a": {"assertion": {"origin": "INFERRED",
                                                    "evidenceIds": []}}}))],
        [{"a": {"assertion": {"origin": "inferred", "evidenceIds": ["ev.1"]}}},
         list(ER._traceability({"a": {"assertion": {"origin": "inferred",
                                                    "evidenceIds": ["ev.1"]}}}))],
        [{"a": [{"assertion": {"origin": "EXTRACTED"}}]},
         list(ER._traceability({"a": [{"assertion": {"origin": "EXTRACTED"}}]}))],
        [{"assertion": {"origin": "INFERRED"}, "validation": {"x": 1}},
         list(ER._traceability({"assertion": {"origin": "INFERRED"},
                                "validation": {"x": 1}}))],
    ]

    # agent 投影节点身上挂的 schema / system 来自 AgentLibrary
    lib = default_agents()
    out["static_projection"] = {
        name: {"schema_required": (lib.get(name).output_schema or {}).get("required"),
               "system_head": lib.get(name).system.split("\n", 1)[0]}
        for name in FDE_ENGAGEMENT_AGENTS
    }
    return out


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    data = {
        "converse": _converse_static(),
        "converse_runs": asyncio.run(_converse_runs()),
        "engagement": _engagement(),
        "engagement_runtime": asyncio.run(_engagement_runtime()),
    }
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
