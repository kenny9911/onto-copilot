"""检索 / 切片质量的回归护栏。

"怎么优化"离不开"怎么知道优化了没有"。这些用例把检索质量钉成可复现的断言：
黄金查询的 recall / 跨文件覆盖、旗舰级口径冲突的可归因性、以及 locator 往返保真。
它们全程确定性（纯 BM25，不动模型），因而可以进 CI、随每次改动跑。

用例数据用采购语料 fixture —— 那只是**测试数据**，被测的是领域无关的检索机制。
"""

from __future__ import annotations

from ontocopilot.onto.parse import build_index, default_registry


def _index(corpus):
    return build_index(default_registry().parse_all(corpus))


# ── 黄金检索集：query → top-k 里必须出现的 cite 子串 ────────────────────
GOLDEN = [
    # 同一字段的两种口径分别来自 DDL 注释和 xlsx 批注，都要检出来
    ("plan_amount 计划金额 口径", ["schema.ddl", "实体梳理.xlsx"], 8),
    # 按实体物理名检索，要能定位到该实体的行
    ("clmContract 计划金额", ["clmContract"], 8),
    # 规则句在流程说明里
    ("采购包 组建 规则", ["流程说明.docx"], 8),
]


def test_golden_retrieval_recall_and_cross_file_coverage(corpus):
    ix = _index(corpus)
    for q, must, k in GOLDEN:
        cites = [c.cite() for c in ix.search(q, top_k=k)]
        blob = " ".join(cites) + " " + " ".join(
            h.render for h in ix.search(q, top_k=k))
        for m in must:
            assert m in blob, f"查询 {q!r} 的 top-{k} 里缺 {m!r}：{cites}"


def test_plan_amount_conflict_keeps_xlsx_annotation_first_class(corpus):
    """旗舰级回归：不含税 那条口径必须能按实体 clmContract 从 xlsx 检出、且切片
    自证归属。这正是 blank-continuation 修复护住的能力 —— 修复前它检不出、也归不了因。"""
    ix = _index(corpus)
    hits = ix.search("clmContract plan_amount 不含税", top_k=6, expand=0)
    xlsx = [h for h in hits if "实体梳理.xlsx" in h.cite() and "不含税" in h.render]
    assert xlsx, [h.cite() for h in hits]
    assert "clmContract" in xlsx[0].render  # 切片自证归属，不靠行相邻性猜


def test_every_chunk_cite_roundtrips_to_its_file(corpus):
    """locator 往返保真：每个切片都要能点回一个非空、以文件名打头的出处 ——
    没有 locator 的结论在这个产品里没有价值。"""
    for doc in default_registry().parse_all(corpus):
        for c in doc.chunks:
            cite = c.cite()
            assert cite and cite.startswith(c.file_name), (c.file_name, c.locator, cite)
