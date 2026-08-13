"""记忆层：短期压缩、证据检索、长期晋升/衰减/冲突、四层装配。"""

from __future__ import annotations

import json

from ontocopilot.kernel.memory.context import ContextManager
from ontocopilot.kernel.memory.evidence import Chunk, EvidenceIndex, tokenize
from ontocopilot.kernel.memory.long_term import (
    DecayPolicy,
    LongTermStore,
    PromotionGate,
    PromotionReason,
)
from ontocopilot.kernel.memory.project import ROW_FIELDS, ProjectMemory
from ontocopilot.kernel.memory.short_term import Scratchpad, WorkingSet, extract_locators
from ontocopilot.kernel.memory.types import (
    MemoryItem,
    MemoryKind,
    MemoryTier,
    Scope,
    mem_key,
)


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


def test_search_ignores_chunks_with_no_query_term_overlap():
    """倒排候选集：完全不含任何查询词的切片绝不该被打分/返回 —— BM25 语义如此，
    倒排索引优化后也必须保持。"""
    ix = EvidenceIndex()
    ix.add(Chunk(chunk_id="hit", file_id="f", file_name="x", locator={},
                 render="采购合同 计划金额"))
    ix.add(Chunk(chunk_id="miss", file_id="f", file_name="x", locator={},
                 render="供应商 地址 电话"))
    hits = ix.search("计划金额", top_k=10, expand=0)
    assert {h.chunk_id for h in hits} == {"hit"}


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
#  两档记忆：人的判断可以传递，机器的猜测只能提示
# ══════════════════════════════════════════════════════════════════
def _ref(content: str, kind=MemoryKind.LESSON, **kw) -> MemoryItem:
    """一条参考档记忆 —— 模型自己推断出来的。"""
    return MemoryItem(
        key=kw.pop("key", mem_key(kind, content[:20])), kind=kind, scope=Scope.PROJECT,
        content=content, support=list(kw.pop("support", ["ev:1"])),
        tier=MemoryTier.REFERENCE, **kw,
    )


def test_reference_memory_can_never_be_promoted():
    """R1：模型的推断不许自己变成"跨会话直接生效的约定"。四条晋升理由全堵死 ——
    闸门里的无条件前置检查，不是调用方自觉。"""
    store = LongTermStore("proj")
    for reason in PromotionReason:
        it = _ref("计划金额大概是含税的")
        it.hit_runs |= {"r1", "r2", "r3"}  # REPEATED 的判据凑满
        ok, why = store.promote(it, reason, run_id="r9", critic_rounds=9)
        assert not ok, f"{reason} 竟然放行了参考档"
        assert "参考档" in why
    assert len(store) == 0


def test_recall_never_accumulates_promotion_evidence_for_reference():
    """纵深防御：recall 给命中项攒 hit_runs，而 len(hit_runs) 正是 REPEATED 的判据。
    参考档拿不到晋升，就不该为一场永远不会发生的晋升攒证据。"""
    store = LongTermStore("proj")
    ref = _ref("采购包和计划八成是一对多")
    store.note(ref, run_id="r1")
    fact = _item("采购包与计划一对多", MemoryKind.FACT)
    store.promote(fact, PromotionReason.IMPORTED, run_id="r1")

    for run in ("r2", "r3", "r4"):
        store.recall("采购包 计划", run_id=run, limit=10)

    assert store.get(ref.key).hit_runs == set(), "参考档不该攒晋升证据"
    assert store.get(ref.key).use_count == 3, "使用次数照记 —— 衰减要靠它"
    assert len(store.get(fact.key).hit_runs) >= 3, "权威档的统计不该被这条改动波及"


def test_reference_can_never_supersede_a_human_decision():
    """R4：覆盖判据原本只是 `confidence >= 0.95` 这个裸数字。参考档一旦借到这个数字，
    就能把人拍板的条目打成 superseded —— 而 superseded 会被 recall 直接排除，
    人的约定就这么静默消失了。"""
    store = LongTermStore("proj")
    decided = _item("计划金额一律按含税年度累计", MemoryKind.FACT)
    store.promote(decided, PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    assert store.get(decided.key).confidence >= 0.95

    guess = _ref("计划金额一律按不含税单次", key=decided.key, support=["llm:r2"])
    guess.confidence = 0.99  # 就算它自称笃定
    ok, why = store.note(guess, run_id="r2")

    kept = store.get(decided.key)
    assert ok and "权威" in why
    assert "含税年度累计" in kept.content, "人拍板的内容必须原样还在"
    assert kept.tier is MemoryTier.AUTHORITATIVE
    assert not [i for i in store.all() if "superseded" in i.tags], "不许把人的约定打进坟场"
    assert kept.confidence >= 0.95, "也不许从排名侧变相覆盖"
    assert [i.key for i in store.recall("计划金额", run_id="r3")] == [decided.key]


def test_human_decision_still_supersedes_a_model_guess():
    """反向必须通：人在会话里重新拍板，就该顶掉模型先前的猜测，旧值降级留档。"""
    store = LongTermStore("proj")
    guess = _ref("采购包与计划是一对多")
    store.note(guess, run_id="r1")
    decided = MemoryItem(key=guess.key, kind=MemoryKind.FACT, scope=Scope.RUN,
                         content="采购包与计划是多对多", support=["human:q2"])
    ok, _ = store.promote(decided, PromotionReason.HUMAN_CONFIRMED, run_id="r2")

    assert ok and "多对多" in store.get(guess.key).content
    assert store.get(guess.key).tier is MemoryTier.AUTHORITATIVE
    superseded = [i for i in store.all() if "superseded" in i.tags]
    assert len(superseded) == 1 and "一对多" in superseded[0].content


def test_reference_may_not_borrow_the_decision_kind():
    """DECISION 在检索里吃 1.3 prior、在衰减里完全豁免。推断借它表达，就成了
    既排名靠前又永不过期 —— 正好是这套分层的反面。"""
    store = LongTermStore("proj")
    bad = _ref("金额口径以财务表为准", MemoryKind.DECISION)
    ok, why = store.promote(bad, PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    assert not ok and "decision" in why
    ok, why = store.note(bad, run_id="r1")
    assert not ok and "decision" in why
    assert len(store) == 0

    pm = ProjectMemory("p1")
    it = pm.observe("金额口径以财务表为准", kind=MemoryKind.DECISION, run_id="r1")
    assert it.kind is MemoryKind.LESSON, "要么拒绝，要么改记成教训，不能放它进 DECISION"


def test_reference_support_never_leaks_into_a_human_decision():
    """support 是这条记忆的依据，会被人当出处看。让参考档的依据并进权威档，
    等于参考记忆从后门进了交付物的溯源。"""
    store = LongTermStore("proj")
    decided = _item("金额含税", MemoryKind.FACT, support=["human:q1"])
    store.promote(decided, PromotionReason.HUMAN_CONFIRMED, run_id="r1")
    store.note(_ref("金额不含税", key=decided.key, support=["llm:猜的"]), run_id="r2")
    assert store.get(decided.key).support == ["human:q1"]


def test_old_memory_json_without_tier_still_loads(tmp_path):
    """已经落过盘的 mem.json 里没有 tier / origin_* 三个字段，而 load 对 from_dict
    没有异常兜底 —— 少一个默认值就是老库一读就崩。"""
    legacy = {
        "key": "convention:x", "kind": "convention", "scope": "project",
        "content": "apiName 用 lowerCamelCase", "confidence": 0.9,
        "support": ["ev:1"], "tags": [], "meta": {},
        "created_run": "r1", "last_used_run": "r1", "use_count": 2,
        "hit_runs": ["r1"], "contested_by": [],
    }
    it = MemoryItem.from_dict(legacy)
    assert it.tier is MemoryTier.AUTHORITATIVE, "老数据全是人拍板/规范导入那条线"
    assert it.origin_session == "" and it.origin_files == []

    p = tmp_path / "mem.json"
    p.write_text(
        json.dumps({"project": "proj", "runs": ["r1"], "items": [legacy]}), encoding="utf-8"
    )
    again = LongTermStore.load(p)
    assert len(again) == 1 and again.all()[0].tier is MemoryTier.AUTHORITATIVE


# ══════════════════════════════════════════════════════════════════
#  项目记忆门面
# ══════════════════════════════════════════════════════════════════
def test_project_memory_rows_roundtrip_without_touching_the_store_layer():
    """跨会话活下来只能靠行进行出：store 自己不会落盘。行必须是纯 dict，
    键与 project_memory 表的列名对齐。"""
    pm = ProjectMemory("p1")
    pm.remember_decision(
        _item("计划金额拆成含税/不含税两个属性", MemoryKind.DECISION), run_id="r1"
    )
    pm.observe("采购包名在 DDL 里叫 pkg_no", run_id="r1", session_id="s7",
               files=["schema.ddl"], support=["ev:2"])

    rows = pm.to_rows()
    assert len(rows) == 2
    assert all(isinstance(r, dict) and set(r) == set(ROW_FIELDS) for r in rows)
    assert all(r["project_id"] == "p1" for r in rows)

    again = ProjectMemory.from_rows("p1", rows)
    assert len(again) == 2
    ref = [i for i in again.store.all() if i.tier is MemoryTier.REFERENCE]
    assert len(ref) == 1
    assert ref[0].origin_session == "s7" and ref[0].origin_files == ["schema.ddl"]
    # 装回来之后那条参考档还是参考档 —— 落盘一圈不该把它洗白
    ok, _ = again.store.promote(ref[0], PromotionReason.HUMAN_CONFIRMED, run_id="r2")
    assert not ok


def test_project_memory_drops_rows_from_other_projects():
    """隔离靠实例：mem_key 不含 project，混进别的项目的行就会撞 key 走合并。"""
    pm = ProjectMemory.from_rows("p1", [
        {"project_id": "p1", "key": "fact:a", "tier": "authoritative", "kind": "fact",
         "content": "本项目金额含税", "confidence": 0.95},
        {"project_id": "p2", "key": "fact:a", "tier": "authoritative", "kind": "fact",
         "content": "另一个项目金额不含税", "confidence": 0.95},
    ])
    assert len(pm) == 1
    assert "本项目" in pm.store.get("fact:a").content


def test_remember_decision_refuses_to_relabel_a_reference_item():
    """R1 的另一半：升权威的唯一路径是人在本会话里重新拍板，不是把旧条目改个标。"""
    pm = ProjectMemory("p1")
    stale = _ref("我猜金额是含税的")
    ok, why = pm.remember_decision(stale, run_id="r1")
    assert not ok and "重新构造" in why
    assert len(pm) == 0


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


def test_reference_annotation_survives_l3_clipping():
    """R3：L3 把长期召回和本轮教训拼成一段再按预算硬截断。免责标注写在条目末尾
    会被切掉，只剩一句看着像事实的断言 —— 所以必须在每条的**前缀**里。"""
    lt = LongTermStore("proj")
    for i in range(10):
        lt.note(_ref(f"计划金额口径说明{i}", key=f"lesson:{i}",
                     origin_session="上一个会话"), run_id="r0")
    cm = ContextManager(long_term=lt, budget_tokens=1000)
    ctx = cm.assemble(task="抽取属性", query="计划金额口径", run_id="r1")

    l3 = ctx.layers["L3_reflection"]
    assert "…[已截断]" in l3, "预算没卡住就没测到东西"
    assert "上一个会话" in l3
    # 活下来的每一条只要还带着断言，就必须同时带着"这是参考、未确认"的标注
    carrying = [ln for ln in l3.splitlines() if "计划金额" in ln]
    assert carrying
    for ln in carrying:
        assert "参考" in ln and "未确认" in ln, ln


def test_reference_from_another_material_is_marked_and_ranked_lower():
    """同一项目下不同会话的材料可能毫不相干。隔着材料得出的推断要再降一档，
    并且在 prompt 里说清楚它来自另一份材料。"""
    lt = LongTermStore("proj")
    near = _ref("计划金额取自本表", key="lesson:near", origin_session="s1")
    far = _ref("计划金额取自本表", key="lesson:far", origin_session="s2",
               origin_files=["别的项目.xlsx"])
    lt.note(near, run_id="r0")
    lt.note(far, run_id="r0")

    cm = ContextManager(long_term=lt, budget_tokens=4000)
    ctx = cm.assemble(task="抽取", query="计划金额", run_id="r1",
                      current_files={"实体梳理.xlsx"})

    assert [m.key for m in ctx.recalled] == ["lesson:near", "lesson:far"], "跨材料的要排后面"
    assert "另一份材料" in ctx.text
    assert ctx.text.count("另一份材料") == 1, "只有跨材料那条该被标"


def test_authoritative_memory_renders_exactly_as_before():
    """加分层不能顺手改人拍板那条的样子 —— 它是既有行为，改了会连带影响所有节点。"""
    it = _item("apiName 用 lowerCamelCase")
    assert it.render() == f"[{MemoryKind.CONVENTION}] apiName 用 lowerCamelCase"


def test_scratchpad_is_compacted_during_assembly_when_over_budget():
    cm = _cm(budget=1200)
    pad = Scratchpad(budget_tokens=300, keep_verbatim=2)
    for i in range(15):
        pad.append(thought="推理" * 60, action=f"a{i}", observation="观察" * 60)
    ctx = cm.assemble(task="抽取", scratch=pad, run_id="r1")
    assert ctx.compactions > 0
    assert ctx.total_tokens <= cm.budget_tokens


# ══════════════════════════════════════════════════════════════════
#  文件名 → file_id（模型只看得到文件名）
# ══════════════════════════════════════════════════════════════════
async def test_evidence_search_accepts_file_names_not_just_ids():
    """`files=` 按 file_id 过滤，但没有任何工具给过模型 file_id —— 它只看得到
    文件名。不解析的话模型一填 files 就静默拿到空结果，然后据此断言"材料里没有"。
    """
    from ontocopilot.kernel.memory.evidence import EvidenceIndex
    from ontocopilot.kernel.tools import builtin_registry
    from ontocopilot.onto.parse.base import make_chunk

    ix = EvidenceIndex()
    ix.add(make_chunk(doc_id="a", file_id="f_abc123", file_name="采购计划.xlsx",
                      locator={"kind": "cell"}, render="计划金额 是含税金额", order=0))
    ix.add(make_chunk(doc_id="b", file_id="f_zzz999", file_name="别的.xlsx",
                      locator={"kind": "cell"}, render="计划金额 别的文件", order=0))
    assert ix.file_names()["采购计划.xlsx"] == "f_abc123"

    reg = builtin_registry(evidence=ix)

    class Ctx:
        approved = True

        def __init__(self):
            self.pending: list = []

    hit = await reg.call("evidence.search",
                         {"query": "计划金额", "files": ["采购计划.xlsx"]}, Ctx())
    assert hit["count"] == 1                      # 修好前这里是 0
    assert "采购计划.xlsx" in hit["chunks"][0]["cite"]
    # 认不出的文件要**说出来**，不能装作查过了没有
    miss = await reg.call("evidence.search",
                          {"query": "计划金额", "files": ["不存在.xlsx"]}, Ctx())
    assert miss["count"] == 0 and "不存在.xlsx" in miss.get("error", "")
