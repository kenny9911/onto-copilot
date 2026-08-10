"""端到端演示 —— 不需要 API key，完全离线可跑。

走完设计稿里的往返闭环前半段：

    材料上传 → 分路解析(fan-out) → 抽取 → 冲突检测 → 澄清(HITL 阻断)
    → [人拍板] → 从 checkpoint 恢复 → 决策回写 → 出模板规格

演示的是内核的四条硬承诺：

  1. **fan-out + 屏障**：三份材料并行解析，ALIGN 依赖 ``PARSE.*`` 自动等齐；
  2. **HITL 持久化**：澄清节点挂起整个 Run，人答完后从原地恢复；
  3. **不重复付费**：恢复时已完成节点整个跳过，模型一次都不再调；
  4. **全链路溯源**：每个结论都能点回 ``文件!位置``。

跑法::

    python examples/demo_pipeline.py
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.bus.bus import AgentBus
from ontocopilot.kernel.critic import CriticPanel, Finding, RuleCritic, Severity
from ontocopilot.kernel.dag import Dag, NodeBudget, NodeMode, NodeSpec, ScopeSpec
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
from ontocopilot.kernel.llm import ModelGateway, ScriptedBackend, stub_routing
from ontocopilot.kernel.loop import AgentLoop, NodeHandler, RunContext
from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex
from ontocopilot.kernel.memory.long_term import LongTermStore, PromotionReason
from ontocopilot.kernel.memory.types import MemoryItem, MemoryKind, Scope, mem_key
from ontocopilot.kernel.recorder import Recorder
from ontocopilot.kernel.scheduler import RunStatus, Scheduler
from ontocopilot.onto.clarify import ClarificationEngine, apply_decision
from ontocopilot.onto.conflict import auto_repair, detect_all
from ontocopilot.onto.oir import (
    OIR,
    BaseType,
    Cardinality,
    LinkType,
    ObjectType,
    PropertyType,
    Provenance,
    extracted,
    inferred,
    make_rid,
)

RUN_ID = "run_ont112_demo"
PROJECT = "ONT-112"


# ══════════════════════════════════════════════════════════════════
#  材料（六份中的三份，够展示异构解析）
# ══════════════════════════════════════════════════════════════════
FILES = {
    "xlsx": ("f3", "实体梳理.xlsx"),
    "ddl": ("f5", "schema.ddl"),
    "openapi": ("f1", "openapi.json"),
}

RAW = {
    "xlsx": [
        (2, "采购需求计划 | 采购业务计划头 | pbpHeader | 年度滚动"),
        (9, "采购包 | 采购包头 | purchasePackage | 多计划合并"),
        (44, "clmContract | 采购合同 | 计划金额（含税，年度累计）CNY"),
        (81, "poHeader | 采购订单头 | —"),
    ],
    "ddl": [
        ("clm_contract", "CREATE TABLE clm_contract (contract_id VARCHAR(32) PRIMARY KEY, "
                         "plan_id VARCHAR(32), plan_amount DECIMAL(18,2)) -- 不含税·单次 CNY"),
        ("pbp_header", "CREATE TABLE pbp_header (plan_id VARCHAR(32) PRIMARY KEY, "
                       "plan_amount DECIMAL(18,2)) -- 含税·年度累计"),
    ],
    "openapi": [
        ("$.paths./purchase-plans/{id}/submit", "post submitPurchasePlan"),
        ("$.paths./purchase-packages", "post createPurchasePackage"),
        ("$.paths./contracts", "post createClmContract"),
    ],
}

ENDPOINTS = [
    {"operationId": "submitPurchasePlan", "method": "post",
     "path": "/purchase-plans/{id}/submit", "file_id": "f1", "file_name": "openapi.json",
     "pointer": "$.paths./purchase-plans/{id}/submit"},
    {"operationId": "createPurchasePackage", "method": "post", "path": "/purchase-packages",
     "file_id": "f1", "file_name": "openapi.json", "pointer": "$.paths./purchase-packages"},
    {"operationId": "createClmContract", "method": "post", "path": "/contracts",
     "file_id": "f1", "file_name": "openapi.json", "pointer": "$.paths./contracts"},
]


def build_evidence() -> EvidenceIndex:
    ix = EvidenceIndex()
    fid, fname = FILES["xlsx"]
    for i, (row, text) in enumerate(RAW["xlsx"]):
        ix.add(Chunk(f"x{row}", fid, fname,
                     {"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
                     render=text, order=i))
    fid, fname = FILES["ddl"]
    for i, (obj, text) in enumerate(RAW["ddl"]):
        ix.add(Chunk(f"d{i}", fid, fname, {"kind": "ddl", "object": obj}, render=text, order=i))
    fid, fname = FILES["openapi"]
    for i, (ptr, text) in enumerate(RAW["openapi"]):
        ix.add(Chunk(f"o{i}", fid, fname, {"kind": "json", "pointer": ptr}, render=text, order=i))
    return ix


def prov(kind: str, locator: dict, snippet: str, extractor: str, conf: float = 0.9) -> Provenance:
    fid, fname = FILES[kind]
    return Provenance(fid, fname, locator, snippet=snippet, extractor=extractor, confidence=conf)


# ══════════════════════════════════════════════════════════════════
#  Handlers
# ══════════════════════════════════════════════════════════════════
class Ingest(NodeHandler):
    def task(self, inputs):
        return "登记材料清单并算哈希"

    async def execute(self, inputs, ctx: RunContext):
        return {"files": sorted(FILES), "count": len(FILES)}


class Parse(NodeHandler):
    """按格式分路解析。fan-out 出来的每个实例处理一份材料。"""

    def __init__(self, kind: str):
        self.kind = kind

    def task(self, inputs):
        return f"解析 {FILES[self.kind][1]}"

    async def execute(self, inputs, ctx: RunContext):
        chunks = RAW[self.kind]
        # 解析出的术语立刻上黑板 —— 下游节点不必再解析一遍
        ctx.bus.post(f"glossary/{self.kind}", [c[0] for c in chunks],
                     by=ctx.node_id, confidence=0.7)
        return {"file": FILES[self.kind][1], "chunks": len(chunks),
                "extractor": {"xlsx": "docling", "ddl": "sqlglot",
                              "openapi": "openapi"}[self.kind]}


class Extract(NodeHandler):
    """SINGLE_SHOT：走模型 + 强制 schema。离线用 ScriptedBackend 顶替。"""

    schema = {
        "type": "object",
        "required": ["objects"],
        "properties": {
            "objects": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["api_name", "display_name"],
                    "properties": {"api_name": {"type": "string"},
                                   "display_name": {"type": "string"}},
                },
            }
        },
    }
    system = "你是本体建模助手。规范：apiName 用 lowerCamelCase，每个断言必须带证据出处。"

    def task(self, inputs):
        return "从材料中抽取候选 ObjectType"

    def query(self, inputs):
        return "采购计划 采购包 clmContract poHeader 计划金额"


class BuildOIR(NodeHandler):
    """把抽取结果落成 OIR。这一步是确定性的 —— 结构组装不该交给模型。"""

    def task(self, inputs):
        return "组装 OIR"

    async def execute(self, inputs, ctx: RunContext):
        return {"oir": _assemble().to_dict()}


class DetectConflicts(NodeHandler):
    def task(self, inputs):
        return "检测冲突"

    async def execute(self, inputs, ctx: RunContext):
        oir = _assemble()
        conflicts = detect_all(oir, endpoints=ENDPOINTS)
        repaired = auto_repair(oir, conflicts)
        for c in conflicts:
            if c.kind.value == "semantic_divergence":
                # 分歧上黑板，Critic 和澄清引擎都能看到
                ctx.bus.post(f"conflict/{c.rid}", c.summary, by=ctx.node_id,
                             support=[e.cite() for e in c.evidence], confidence=0.9)
        return {
            "conflicts": [c.to_dict() for c in conflicts],
            "auto_repaired": repaired,
            "stats": oir.stats(),
        }


class Clarify(NodeHandler):
    """HITL：排序后把 top-3 抛给人，Run 在这里挂起。"""

    def task(self, inputs):
        return "排歧义并请 FDE 拍板"

    def human_request(self, draft, inputs):
        oir = _assemble()
        conflicts = detect_all(oir, endpoints=ENDPOINTS)
        cs = ClarificationEngine(max_questions=3).rank(conflicts, oir)
        return {"questions": [q.to_dict() for q in cs.questions], "routing": cs.summary()}


class Synthesize(NodeHandler):
    """把人的决策回写 OIR，产出模板规格。"""

    def task(self, inputs):
        return "回写决策并生成模板规格"

    async def execute(self, inputs, ctx: RunContext):
        decision = next((v for v in inputs.values()
                         if isinstance(v, dict) and "option_id" in v), {})
        oir = _assemble()
        conflicts = detect_all(oir, endpoints=ENDPOINTS)
        auto_repair(oir, conflicts)

        applied = None
        target = next((c for c in conflicts if c.rid == decision.get("conflict_rid")), None)
        if target and decision.get("option_id"):
            applied = apply_decision(oir, target, decision["option_id"],
                                     note=decision.get("note", ""))
            # 人拍板的结论晋升长期记忆，下个项目冷启动就能用上
            store: LongTermStore = ctx.bus.board.read("_long_term_store")
            if store is not None:
                store.promote(
                    MemoryItem(
                        key=mem_key(MemoryKind.DECISION, target.summary[:20]),
                        kind=MemoryKind.DECISION, scope=Scope.RUN,
                        content=f"{target.summary} → {applied['label']}",
                        support=[e.cite() for e in target.evidence],
                    ),
                    PromotionReason.HUMAN_CONFIRMED, run_id=ctx.run_id,
                )

        cells = _template_cells(oir)
        return {
            "applied": applied,
            "oir": oir.stats(),
            "template": {
                "total_cells": len(cells),
                "prefilled": sum(1 for c in cells if c["role"] == "prefilled"),
                "business_required": sum(1 for c in cells if c["role"] == "required"),
                "prefill_rate": round(
                    sum(1 for c in cells if c["role"] == "prefilled") / max(1, len(cells)), 3),
                "owners": sorted({c["owner"] for c in cells if c.get("owner")}),
            },
        }


# ══════════════════════════════════════════════════════════════════
#  OIR 组装（真实系统里由抽取节点产生，这里固定下来好断言）
# ══════════════════════════════════════════════════════════════════
def _assemble() -> OIR:
    o = OIR()
    plan = o.add_object(ObjectType(
        rid=make_rid("ot", "purchase_plan_header"),
        api_name=extracted("purchasePlanHeader",
                           prov("ddl", {"kind": "ddl", "object": "pbp_header"},
                                "CREATE TABLE pbp_header", "sqlglot")),
        display_name=extracted("采购业务计划头",
                               prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理",
                                             "row": 2, "col": "C"},
                                    "采购业务计划头", "docling")),
        primary_key=inferred(["pt_plan_id"]),
        aliases=["pbpHeader", "采购需求计划"],
        owner="王明",
    ))
    contract = o.add_object(ObjectType(
        rid=make_rid("ot", "clm_contract"),
        api_name=extracted("clmContract",
                           prov("ddl", {"kind": "ddl", "object": "clm_contract"},
                                "CREATE TABLE clm_contract", "sqlglot")),
        display_name=extracted("采购合同",
                               prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理",
                                             "row": 44, "col": "C"}, "采购合同", "docling")),
        primary_key=inferred(["pt_contract_id"]),
        owner="李强",
    ))
    o.add_object(ObjectType(
        rid=make_rid("ot", "purchase_package"),
        api_name=extracted("purchasePackage",
                           prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理",
                                         "row": 9, "col": "C"}, "采购包头", "docling")),
        display_name=extracted("采购包头",
                               prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理",
                                             "row": 9, "col": "D"}, "采购包头", "docling")),
        primary_key=inferred(["pt_pkg_id"]),
        owner="王明",
    ))

    def _pk(rid, parent, api, disp, ev):
        o.add_property(PropertyType(
            rid=rid, parent=parent, api_name=extracted(api, ev),
            display_name=extracted(disp, ev),
            base_type=extracted(BaseType.STRING, ev),
            definition=extracted("主键", ev), required=inferred(True)))

    _pk("pt_plan_id", plan.rid, "planId", "计划编号",
        prov("ddl", {"kind": "ddl", "object": "pbp_header"}, "plan_id VARCHAR(32)", "sqlglot"))
    _pk("pt_contract_id", contract.rid, "contractId", "合同编号",
        prov("ddl", {"kind": "ddl", "object": "clm_contract"},
             "contract_id VARCHAR(32)", "sqlglot"))
    _pk("pt_pkg_id", make_rid("ot", "purchase_package"), "packageId", "采购包编号",
        prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理", "row": 9, "col": "E"},
             "采购包编号", "docling"))

    # ★ 同名、同类型、口径不同 —— 纯 schema 比对发现不了
    ev_budget = prov("xlsx", {"kind": "cell", "sheet": "业务对象实体梳理", "row": 44, "col": "F"},
                     "计划金额（含税，年度累计）CNY", "docling", 0.94)
    ev_contract = prov("ddl", {"kind": "ddl", "object": "clm_contract"},
                       "plan_amount DECIMAL(18,2) -- 不含税·单次 CNY", "sqlglot", 0.9)
    o.add_property(PropertyType(
        rid="pt_plan_amount_budget", parent=plan.rid,
        api_name=extracted("planAmount", ev_budget),
        display_name=extracted("计划金额", ev_budget),
        base_type=extracted(BaseType.DECIMAL, ev_budget),
        definition=extracted("含税，年度累计，CNY", ev_budget),
        required=inferred(True), owner="王明"))
    o.add_property(PropertyType(
        rid="pt_plan_amount_contract", parent=contract.rid,
        api_name=extracted("planAmount", ev_contract),
        display_name=extracted("计划金额", ev_contract),
        base_type=extracted(BaseType.DECIMAL, ev_contract),
        definition=extracted("不含税，单次，CNY", ev_contract),
        required=inferred(True), owner="李强"))

    ev_fk = prov("ddl", {"kind": "ddl", "object": "clm_contract"},
                 "FOREIGN KEY (plan_id) REFERENCES pbp_header(plan_id)", "sqlglot")
    o.add_link(LinkType(
        rid="lt_plan_contract", api_name=extracted("planContracts", ev_fk),
        source=plan.rid, target=contract.rid,
        cardinality=extracted(Cardinality.ONE_TO_MANY, ev_fk),
        join_key=extracted({"fromProp": "pt_plan_id", "toProp": "pt_contract_id"}, ev_fk)))
    return o


def _template_cells(oir: OIR) -> list[dict[str, Any]]:
    """模板单元格规格。样式即语义：黄底=业务必填，灰底=已定只读。"""
    cells: list[dict[str, Any]] = []
    for p in oir.properties.values():
        cells.append({"rid": p.rid, "field": "apiName", "role": "prefilled",
                      "style": "locked", "owner": p.owner})
        cells.append({"rid": p.rid, "field": "baseType", "role": "prefilled",
                      "style": "locked", "owner": p.owner})
        # 口径必须业务方确认 —— 系统抽出来的只是候选
        cells.append({"rid": p.rid, "field": "definition",
                      "role": "required" if p.conflicts or not p.definition.grounded
                      else "prefilled",
                      "style": "yellow" if p.conflicts else "editable", "owner": p.owner})
    for o_ in oir.objects.values():
        cells.append({"rid": o_.rid, "field": "description", "role": "required",
                      "style": "yellow", "owner": o_.owner})
    return cells


# ══════════════════════════════════════════════════════════════════
#  装配与运行
# ══════════════════════════════════════════════════════════════════
def build_dag() -> Dag:
    d = Dag("onto_v1", freeze_before="PARSE")
    d.add(NodeSpec("INGEST", NodeMode.DETERMINISTIC, "ingest"))
    d.add(NodeSpec("PARSE", NodeMode.DETERMINISTIC, "parse", deps=("INGEST",),
                   fanout_over="files"))
    d.add(NodeSpec("EXTRACT", NodeMode.SINGLE_SHOT, "extract", deps=("PARSE.*",),
                   scope=ScopeSpec(evidence_top_k=12),
                   budget=NodeBudget(tokens=8000)))
    d.add(NodeSpec("BUILD_OIR", NodeMode.DETERMINISTIC, "build_oir", deps=("EXTRACT",),
                   critics=("schema", "provenance")))
    d.add(NodeSpec("CONFLICT", NodeMode.DETERMINISTIC, "conflict", deps=("BUILD_OIR",)))
    d.add(NodeSpec("CLARIFY", NodeMode.HITL, "clarify", deps=("CONFLICT",)))
    d.add(NodeSpec("SYNTHESIZE", NodeMode.DETERMINISTIC, "synthesize", deps=("CLARIFY",)))
    return d


HANDLERS = {
    "ingest": Ingest(), "extract": Extract(), "build_oir": BuildOIR(),
    "conflict": DetectConflicts(), "clarify": Clarify(), "synthesize": Synthesize(),
    **{f"parse.{k}": Parse(k) for k in FILES},
}


def _schema_critic(draft: Any) -> list[Finding]:
    errs = _assemble().validate()
    return [Finding(Severity.HIGH, "SCHEMA_INVALID", "oir", e, verifier="oir.validate")
            for e in errs]


def _provenance_critic(draft: Any) -> list[Finding]:
    oir = _assemble()
    out: list[Finding] = []
    for p in oir.properties.values():
        if not p.definition.grounded and p.definition.value:
            out.append(Finding(Severity.MEDIUM, "EVIDENCE_MISSING", p.rid,
                               f"{p.api_name.value} 的口径无证据支撑",
                               verifier="assertion.grounded"))
    return out


def make_harness(*, resume: bool, journal, blobs, long_term: LongTermStore):
    rec = Recorder(RUN_ID, journal, blobs, resume=resume)
    bus = AgentBus(rec)
    bus.board.write("_long_term_store", long_term, by="bootstrap")
    budget = Budget(tokens=2_000_000, usd=50.0)

    backend = ScriptedBackend([
        (r"抽取候选 ObjectType", json.dumps({"objects": [
            {"api_name": "purchasePlanHeader", "display_name": "采购业务计划头"},
            {"api_name": "purchasePackage", "display_name": "采购包头"},
            {"api_name": "clmContract", "display_name": "采购合同"},
        ]}, ensure_ascii=False)),
    ])
    gw = ModelGateway(backend, rec, routing=stub_routing(), budget=budget)
    cm = ContextManager(
        system="你是 OntoCopilot。规范：apiName 用 lowerCamelCase；每个断言必须带证据出处。",
        long_term=long_term, evidence=build_evidence(), budget_tokens=40_000,
    )
    panel = CriticPanel({
        "schema": RuleCritic("schema", _schema_critic),
        "provenance": RuleCritic("provenance", _provenance_critic),
    }, rec)
    loop = AgentLoop(gateway=gw, ctx_manager=cm, panel=panel, bus=bus,
                     recorder=rec, budget=budget, handlers=HANDLERS)

    dag = build_dag()
    dag.expand({"PARSE": sorted(FILES)}).freeze()
    # fan-out 实例各自绑到对应格式的 handler
    for k in FILES:
        object.__setattr__(dag[f"PARSE.{k}"], "handler", f"parse.{k}")

    return Scheduler(dag, loop, rec, bus, budget), rec, backend, cm


async def main() -> None:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    long_term = LongTermStore(PROJECT)

    print("═" * 74)
    print("  OntoCopilot 端到端演示 ·", PROJECT)
    print("═" * 74)

    # ── 第一程：跑到澄清门被人拦住 ─────────────────────────────
    sched, rec, backend, cm = make_harness(
        resume=False, journal=journal, blobs=blobs, long_term=long_term)
    out = await sched.run(RUN_ID)

    print(f"\n▸ 第一程 · {out.status}")
    print(f"  已完成节点  {sorted(out.results)}")
    print(f"  模型调用    {len(backend.calls)} 次")

    conflicts = out.outputs["CONFLICT"]["conflicts"]
    repaired = out.outputs["CONFLICT"]["auto_repaired"]
    print(f"\n▸ 冲突检测 · {len(conflicts)} 条")
    by_kind: dict[str, int] = {}
    for c in conflicts:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    for k, n in sorted(by_kind.items(), key=lambda p: -p[1]):
        print(f"  {k:22} {n}")
    print(f"  自动修（命名类）        {len(repaired)}")

    assert out.status is RunStatus.SUSPENDED, "澄清门应该拦住 Run"
    questions = out.pending_human["questions"]
    print(f"\n▸ 澄清门 · Run 已挂起，等 FDE 拍板")
    print(f"  路由: {out.pending_human['routing']}")
    for q in questions:
        print(f"\n  ── {q['title']}")
        print(f"     影响 {q['impact_count']} 个实体 · 得分 {q['score']} · "
              f"{'可逆' if q['reversible'] else '不可逆'}")
        for o in q["options"][:3]:
            cites = "、".join(e["cite"] for e in o["evidence"][:2])
            print(f"       ○ {o['label']}")
            if cites:
                print(f"         出处 {cites}")

    # ── 人拍板 ─────────────────────────────────────────────────
    picked = next(q for q in questions
                  if any(o["id"] == "split_two_properties" for o in q["options"]))
    answer = {"conflict_rid": picked["conflict_rid"], "option_id": "split_two_properties",
              "note": "跟李强当面对齐过"}
    Recorder(RUN_ID, journal, blobs, resume=True).record_human_answer(
        "CLARIFY", out.pending_human["request_id"], answer)
    print(f"\n▸ FDE 决策 · {answer['option_id']}（{answer['note']}）")

    # ── 第二程：从 checkpoint 恢复 ─────────────────────────────
    sched2, rec2, backend2, cm2 = make_harness(
        resume=True, journal=journal, blobs=blobs, long_term=long_term)
    out2 = await sched2.run(RUN_ID)

    print(f"\n▸ 第二程 · {out2.status}")
    print(f"  从 checkpoint 跳过  {len(out2.skipped)} 个节点: {sorted(out2.skipped)}")
    print(f"  模型调用            {len(backend2.calls)} 次  ← 已完成的节点不重新付费")

    syn = out2.outputs["SYNTHESIZE"]
    print(f"\n▸ 决策回写")
    print(f"  {syn['applied']['label']}")
    print(f"  变更实体 {syn['applied']['changed']}")

    t = syn["template"]
    print(f"\n▸ 模板规格")
    print(f"  总格数      {t['total_cells']}")
    print(f"  预填        {t['prefilled']}（{t['prefill_rate']:.0%}）")
    print(f"  业务必填    {t['business_required']}  ← 黄底")
    print(f"  责任人      {'、'.join(t['owners'])}")

    print(f"\n▸ 长期记忆 · {len(long_term)} 条")
    for m in long_term.all():
        print(f"  [{m.kind}] {m.content}")
        print(f"        依据 {'、'.join(m.support[:2])} · 可信度 {m.confidence:.2f}")

    # ── 审计 ───────────────────────────────────────────────────
    events = list(journal.read(RUN_ID))
    kinds: dict[str, int] = {}
    for e in events:
        kinds[str(e.kind)] = kinds.get(str(e.kind), 0) + 1
    print(f"\n▸ 事件日志 · {len(events)} 条（整条链路可重放、可审计）")
    for k, n in sorted(kinds.items(), key=lambda p: -p[1])[:8]:
        print(f"  {k:26} {n}")
    print(f"\n▸ 预算 · {out2.budget['spent']['tokens']:.0f} tokens · "
          f"${out2.budget['spent']['usd']:.4f} · {out2.budget['level_label']}")
    print("═" * 74)

    assert out2.ok
    assert len(backend2.calls) == 0, "恢复时不应再调模型"


if __name__ == "__main__":
    asyncio.run(main())
