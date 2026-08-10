"""记忆层：短期压缩、证据检索、长期晋升/衰减/冲突、四层装配。"""

from __future__ import annotations

from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex, tokenize
from ontocopilot.kernel.memory.long_term import (
    DecayPolicy,
    LongTermStore,
    PromotionGate,
    PromotionReason,
)
from ontocopilot.kernel.memory.short_term import Scratchpad, WorkingSet, extract_locators
from ontocopilot.kernel.memory.types import MemoryItem, MemoryKind, Scope, mem_key


# ══════════════════════════════════════════════════════════════════
#  短期
# ══════════════════════════════════════════════════════════════════
def test_scratchpad_compaction_never_drops_locators():
    """压缩是为了省 token，但 locator 丢了溯源就断了 —— 这是产品的信任基础。"""
    pad = Scratchpad(budget_tokens=400, keep_verbatim=2)
    for i in range(12):
        pad.append(
            thought=f"第 {i} 轮：检查金额口径 " + "补充说明" * 20,
            action=f"evidence.search(q='计划金额 {i}')",
            observation=f"命中 实体梳理.xlsx!业务对象实体梳理!R{40 + i}C6，口径含税年度",
        )
    before = set(pad.locators)
    assert len(before) >= 12

    pad.compact_to_fit()
    assert pad.compactions > 0
    assert set(pad.locators) == before, "压缩后 locator 必须一条不少"
    assert "R44C6" in pad.render()


def test_scratchpad_digest_is_all_that_crosses_node_boundary():
    pad = Scratchpad()
    for i in range(20):
        pad.append(thought="想" * 200, action=f"act{i}", observation="见" * 200)
    d = pad.digest(max_tokens=200)
    assert d["turns"] == 20
    from ontocopilot.kernel.memory.types import est_tokens

    assert est_tokens(d["summary"]) <= 200
    assert d["locators"] == []


def test_extract_locators_covers_all_material_formats():
    text = (
        "见 实体梳理.xlsx!业务对象实体梳理!R44C6 与 schema.ddl#clm_contract，"
        "另有 openapi.json 的 $.components.schemas.Plan，切片 f3:sheet0"
    )
    locs = extract_locators(text)
    assert any("实体梳理.xlsx" in x for x in locs)
    assert any("schema.ddl" in x for x in locs)
    assert any(x.startswith("$.") for x in locs)
    assert any(x.startswith("f3:") for x in locs)


def test_working_set_wildcard_selects_fanout_nodes():
    ws = WorkingSet()
    for k in ("PARSE.xlsx", "PARSE.docx", "PARSE.ddl", "ALIGN"):
        ws.put(k, {"n": k})
    assert set(ws.select(["PARSE.*"])) == {"PARSE.xlsx", "PARSE.docx", "PARSE.ddl"}
    assert set(ws.select(["PARSE.*", "ALIGN"])) == {
        "PARSE.xlsx", "PARSE.docx", "PARSE.ddl", "ALIGN",
    }


# ══════════════════════════════════════════════════════════════════
#  证据检索
# ══════════════════════════════════════════════════════════════════
def _idx() -> EvidenceIndex:
    ix = EvidenceIndex()
    rows = [
        (40, "采购业务计划头 pbpHeader 年度滚动"),
        (41, "采购业务计划行 pbpLine 按物料拆分"),
        (44, "clmContract 采购合同 计划金额（含税，年度累计）"),
        (45, "supplierCode 供应商编码"),
        (81, "poHeader 采购订单头"),
    ]
    for i, (row, text) in enumerate(rows):
        ix.add(Chunk(
            chunk_id=f"x{row}", file_id="f3", file_name="实体梳理.xlsx",
            locator={"kind": "cell", "sheet": "业务对象实体梳理", "row": row, "col": "F"},
            render=text, order=i,
        ))
    ix.add(Chunk(
        chunk_id="d1", file_id="f5", file_name="schema.ddl",
        locator={"kind": "ddl", "object": "clm_contract"},
        render="CREATE TABLE clm_contract (plan_amount DECIMAL(18,2)) -- 不含税·单次",
        order=0,
    ))
    return ix


def test_camel_case_is_split_so_physical_and_business_names_both_hit():
    assert "contract" in tokenize("clmContract")
    assert "amount" in tokenize("plan_amount")


def test_tokenize_emits_cjk_bigrams_for_discrimination():
    """中文按单字切区分度太低（采、购、包 到处都是）。相邻二字组让多字专有名词
    精确命中，同时保留单字兜底召回。camelCase 拆分对中文无效，二字组是对等手段。"""
    toks = tokenize("采购包头")
    assert "采购" in toks and "购包" in toks and "包头" in toks  # 二字组：精度
    assert "采" in toks and "头" in toks                        # 单字：召回


def test_cjk_bigrams_break_ties_that_unigrams_cannot():
    """两个切片单字集合相同、只是相邻关系不同 —— 单字模型给同分,二字组能分开。
    b 的单字频次更高（本应靠单字排前）,但只有 a 含"采购/购包"两个二字组。"""
    ix = EvidenceIndex()
    ix.add(Chunk(chunk_id="a", file_id="f", file_name="x", locator={}, render="采购包"))
    ix.add(Chunk(chunk_id="b", file_id="f", file_name="x", locator={},
                 render="采 采 购 购 包 包"))  # 单字更密,但无 采购/购包 二字组
    hits = ix.search("采购包", top_k=2, expand=0, diversify_by_file=False)
    assert hits[0].chunk_id == "a", [h.chunk_id for h in hits]


def test_rule_and_relation_tags_are_boosted_when_they_match():
    """规则/关系切片承载建模决定性信息（基数、口径、外键）—— 同等命中时优先。
    这才兑现 text.py 里"命中的切片打 rule 标签，检索时优先"的承诺。"""
    ix = EvidenceIndex()
    ix.add(Chunk(chunk_id="plain", file_id="f", file_name="x", locator={},
                 render="一个执行计划可拆入多个采购包", tags=["para"]))
    ix.add(Chunk(chunk_id="rule", file_id="f", file_name="x", locator={},
                 render="一个执行计划可拆入多个采购包", tags=["para", "rule"]))
    hits = ix.search("执行计划 采购包", top_k=2, expand=0, diversify_by_file=False)
    assert hits[0].chunk_id == "rule", [h.chunk_id for h in hits]


def test_search_finds_the_conflicting_definition_across_two_files():
    """按物理名检索要能同时捞出 xlsx 的业务口径和 DDL 的物理定义 ——
    「计划金额」双口径就是这么被发现的。"""
    ix = _idx()
    cites = [c.cite() for c in ix.search("clmContract 计划金额", top_k=5, expand=0)]
    assert cites[0] == "实体梳理.xlsx!业务对象实体梳理!R44CF"
    assert "schema.ddl#clm_contract" in cites


def test_search_can_filter_by_kind():
    """节点可以把检索限定到某类来源 —— 例如只看 DDL 的物理定义。"""
    ix = _idx()
    ddl_only = ix.search("plan_amount 计划金额", top_k=5, expand=0, kinds=["ddl"])
    assert ddl_only and all(c.locator.get("kind") == "ddl" for c in ddl_only)


def test_sheet_name_is_searchable_even_when_absent_from_render():
    """所属表/章节名不进 render（否则每行重复），但要进检索 token 流 ——
    "按所属表检索"才成立。领域无关。"""
    ix = EvidenceIndex()
    ix.add(Chunk(chunk_id="r", file_id="f", file_name="x.xlsx",
                 locator={"kind": "range", "sheet": "供应商主数据", "rows": [5, 5]},
                 render="编码=S001 | 名称=示例"))
    hits = ix.search("供应商", top_k=3, expand=0)
    assert any(h.chunk_id == "r" for h in hits)


def test_neighborhood_expansion_pulls_adjacent_rows():
    """表格语义常跨行 —— 只取命中行会丢掉表头和分组。"""
    ix = _idx()
    hit_only = ix.search("clmContract", top_k=1, expand=0)
    expanded = ix.search("clmContract", top_k=1, expand=1)
    assert len(expanded) > len(hit_only)
    assert {c.chunk_id for c in expanded} >= {"x41", "x44", "x45"}


def test_search_respects_token_budget():
    ix = _idx()
    tiny = ix.search("采购", top_k=10, expand=1, budget_tokens=8)
    assert sum(c.tokens for c in tiny) <= 8


def test_rendered_chunks_carry_citations():
    ix = _idx()
    text = EvidenceIndex.render(ix.search("clmContract", top_k=1, expand=0))
    assert text.startswith("⟦实体梳理.xlsx!业务对象实体梳理!R44CF⟧\n")


# ══════════════════════════════════════════════════════════════════
#  长期
# ══════════════════════════════════════════════════════════════════
def _item(content: str, kind=MemoryKind.CONVENTION, support=("ev:1",)) -> MemoryItem:
    return MemoryItem(
        key=mem_key(kind, content[:20]), kind=kind, scope=Scope.RUN,
        content=content, support=list(support),
    )


def test_unsupported_memory_is_never_promoted():
    """拿不出依据的记忆不许进长期库 —— 长期库污染会影响之后所有 Run。"""
    store = LongTermStore("proj")
    ok, why = store.promote(
        _item("金额一律含税", support=()), PromotionReason.HUMAN_CONFIRMED, run_id="r1"
    )
    assert not ok and "support" in why
    assert len(store) == 0


def test_single_observation_is_not_enough():
    store = LongTermStore("proj", gate=PromotionGate(min_distinct_runs=2))
    it = _item("采购包头统一叫 purchasePackage")
    it.hit_runs.add("r1")
    ok, why = store.promote(it, PromotionReason.REPEATED, run_id="r1")
    assert not ok and "1 个 Run" in why


def test_repeated_across_runs_promotes():
    store = LongTermStore("proj", gate=PromotionGate(min_distinct_runs=2))
    it = _item("采购包头统一叫 purchasePackage")
    it.hit_runs |= {"r1", "r2"}
    ok, _ = store.promote(it, PromotionReason.REPEATED, run_id="r2")
    assert ok and len(store) == 1


def test_human_decision_promotes_immediately_at_high_confidence():
    store = LongTermStore("proj")
    ok, _ = store.promote(
        _item("计划金额拆成含税/不含税两个属性", MemoryKind.DECISION),
        PromotionReason.HUMAN_CONFIRMED, run_id="r1",
    )
    assert ok
    assert store.all()[0].confidence >= 0.95


def test_agreeing_observations_reinforce_confidence():
    store = LongTermStore("proj")
    a = _item("apiName 用 lowerCamelCase")
    store.promote(a, PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    c0 = store.all()[0].confidence
    b = _item("apiName 用 lowerCamelCase")
    b.hit_runs |= {"r1", "r2"}
    store.promote(b, PromotionReason.REPEATED, run_id="r2")
    assert store.get(a.key).confidence >= c0
    assert len(store) == 1, "同 key 应合并而非堆同义副本"


def test_contradiction_is_contested_not_silently_overwritten():
    """静默覆盖 = 让系统忘记自己曾经知道过别的。必须两条都留，标争议。"""
    store = LongTermStore("proj")
    a = _item("计划金额口径为含税年度累计", MemoryKind.FACT)
    store.promote(a, PromotionReason.IMPORTED, run_id="r1")
    b = MemoryItem(key=a.key, kind=MemoryKind.FACT, scope=Scope.RUN,
                   content="计划金额口径为不含税单次", support=["ev:9"])
    b.hit_runs |= {"r2", "r3"}
    ok, why = store.promote(b, PromotionReason.REPEATED, run_id="r3")
    assert ok and "争议" in why
    kept = store.get(a.key)
    assert kept.contested
    assert kept.confidence <= 0.55, "有争议就不该自信"


def test_human_decision_supersedes_inference_but_keeps_audit_trail():
    store = LongTermStore("proj")
    inferred = _item("采购包与计划是一对多", MemoryKind.FACT)
    inferred.confidence = 0.6
    store.promote(inferred, PromotionReason.IMPORTED, run_id="r1")

    decided = MemoryItem(key=inferred.key, kind=MemoryKind.FACT, scope=Scope.RUN,
                         content="采购包与计划是多对多", support=["human:q2"])
    store.promote(decided, PromotionReason.HUMAN_CONFIRMED, run_id="r2")

    assert "多对多" in store.get(inferred.key).content
    superseded = [i for i in store.all() if "superseded" in i.tags]
    assert len(superseded) == 1 and "一对多" in superseded[0].content


def test_recall_ranks_decisions_above_inferences():
    store = LongTermStore("proj")
    for c, k in [("计划金额可能含税", MemoryKind.FACT),
                 ("计划金额拆成两个属性", MemoryKind.DECISION)]:
        store.promote(_item(c, k), PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    top = store.recall("计划金额", run_id="r2", limit=2)
    assert top[0].kind is MemoryKind.DECISION


def test_idle_memory_decays_and_evicts_but_decisions_are_immune():
    """项目会演化，去年的约定今年可能不成立。但人拍板的事实不衰减。"""
    store = LongTermStore(
        "proj",
        decay=DecayPolicy(idle_runs_before_decay=1, decay_per_run=0.5, evict_below=0.5),
    )
    stale = _item("旧约定：金额列叫 amt", MemoryKind.CONVENTION)
    stale.confidence = 0.7
    store.promote(stale, PromotionReason.IMPORTED, run_id="r1")
    decision = _item("拆成两个属性", MemoryKind.DECISION)
    store.promote(decision, PromotionReason.HUMAN_CONFIRMED, run_id="r1")

    for r in ("r2", "r3", "r4"):
        store.start_run(r)
    evicted = store.decay("r4")

    assert [e.key for e in evicted] == [stale.key]
    assert store.get(decision.key) is not None


def test_store_roundtrips_through_disk(tmp_path):
    store = LongTermStore("proj")
    store.promote(_item("apiName 用 lowerCamelCase"), PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    p = tmp_path / "mem.json"
    store.save(p)
    again = LongTermStore.load(p)
    assert len(again) == 1
    assert again.all()[0].content == "apiName 用 lowerCamelCase"


# ══════════════════════════════════════════════════════════════════
#  四层装配
# ══════════════════════════════════════════════════════════════════
def _cm(budget=2000) -> ContextManager:
    lt = LongTermStore("proj")
    lt.promote(_item("采购包头统一叫 purchasePackage", MemoryKind.CONVENTION),
               PromotionReason.HUMAN_CONFIRMED, run_id="r0")
    return ContextManager(
        system="你是本体建模助手。规范：apiName 用 lowerCamelCase。",
        long_term=lt, evidence=_idx(), budget_tokens=budget,
    )


def test_assemble_layers_in_priority_order():
    cm = _cm()
    ws = WorkingSet()
    ws.put("PARSE.xlsx", {"chunks": 169})
    ctx = cm.assemble(task="抽取 ObjectType", query="clmContract 计划金额",
                      working=ws, deps=["PARSE.*"], run_id="r1")

    body = ctx.text
    assert body.index("本体建模助手") < body.index("已知约定") < body.index("上游产出")
    assert body.index("上游产出") < body.index("证据切片")
    assert ctx.total_tokens <= cm.budget_tokens
    assert ctx.chunks and ctx.recalled


def test_evidence_floor_is_defended_by_trimming_working_set():
    """前三层挤占证据地板时，削 working 而不是削证据 —— 没证据就没法归因。"""
    cm = _cm(budget=900)
    ws = WorkingSet()
    ws.put("BIG", {"blob": "填充" * 4000})
    ctx = cm.assemble(task="抽取", query="clmContract", working=ws, deps=["BIG"], run_id="r1")

    assert ctx.tokens["L2_evidence"] > 0, "证据层不能被挤到 0"
    assert ctx.total_tokens <= cm.budget_tokens
    assert any("working" in d for d in ctx.dropped)


def test_reflection_from_this_run_reaches_later_nodes():
    cm = _cm()
    cm.reflect("provenance critic 驳回过无证据断言，本轮所有 baseType 必须带 evidence")
    ctx = cm.assemble(task="抽取属性", run_id="r1")
    assert "本轮教训" in ctx.text and "baseType" in ctx.text


def test_scratchpad_is_compacted_during_assembly_when_over_budget():
    cm = _cm(budget=1200)
    pad = Scratchpad(budget_tokens=300, keep_verbatim=2)
    for i in range(15):
        pad.append(thought="推理" * 60, action=f"a{i}", observation="观察" * 60)
    ctx = cm.assemble(task="抽取", scratch=pad, run_id="r1")
    assert ctx.compactions > 0
    assert ctx.total_tokens <= cm.budget_tokens
