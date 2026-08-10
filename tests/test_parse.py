"""解析器 —— 针对真实材料里实际会遇到的糟糕情况。"""

from __future__ import annotations

from ontocopilot.onto.parse import (
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)
from ontocopilot.onto.parse.tabular import detect_header_row, infer_type


# ══════════════════════════════════════════════════════════════════
#  xlsx
# ══════════════════════════════════════════════════════════════════
def test_header_is_found_below_title_rows(messy_xlsx):
    """真实梳理表前面有标题和填写人信息，表头不在第 1 行。"""
    doc = default_registry().parse(messy_xlsx)
    sheet = doc.structured["sheets"][0]
    assert sheet["header_row"] == 3
    assert sheet["columns"] == ["业务域", "业务对象", "实体名称", "字段", "类型", "口径说明"]
    assert any(f.kind == "header_offset" for f in doc.findings)


def test_merged_cells_are_filled_down(messy_xlsx):
    """合并区只有左上角有值，不还原就会得到一堆空格。"""
    doc = default_registry().parse(messy_xlsx)
    rows = [c.raw for c in doc.chunks if "row" in c.tags]
    # 「采购计划」跨三行合并，每行都该带上它
    assert sum(1 for r in rows if r.get("业务域") == "采购计划") == 3
    assert sum(1 for r in rows if r.get("业务对象") == "采购需求计划") == 2


def test_cell_comments_are_extracted(messy_xlsx):
    """口径经常只写在批注里。丢了批注，口径冲突就永远发现不了。"""
    doc = default_registry().parse(messy_xlsx)
    text = "\n".join(c.render for c in doc.chunks)
    assert "含税，年度累计，CNY" in text
    assert "不含税，单次，CNY" in text
    assert "〔批注〕" in text


def test_office_metadata_leak_is_reported_and_indexed(messy_xlsx):
    """作者名和绝对保存路径不在表格内容里，但常常泄漏客户名与项目代号。"""
    doc = default_registry().parse(messy_xlsx)
    leaks = [f for f in doc.findings if f.kind == "metadata_leak"]
    assert leaks and leaks[0].severity == "warn"
    # 元数据本身也要可检索 —— FDE 问"你怎么知道的"时要答得出来
    meta = [c for c in doc.chunks if "meta" in c.tags]
    assert meta and meta[0].locator["kind"] == "meta"


def test_row_chunks_carry_precise_locators(messy_xlsx):
    doc = default_registry().parse(messy_xlsx)
    row = next(c for c in doc.chunks if "row" in c.tags)
    assert row.locator["sheet"] == "业务对象实体梳理"
    assert row.cite().startswith("实体梳理.xlsx!业务对象实体梳理!R")


def test_header_detection_prefers_the_row_above_data():
    rows = [["采购计划梳理", "", ""], ["", "", ""],
            ["编码", "名称", "金额"], ["M-001", "电缆", "12.5"], ["M-002", "断路器", "88.0"]]
    assert detect_header_row(rows) == 2


def test_type_inference_from_actual_values():
    assert infer_type(["1", "2", "30"]) == "INTEGER"
    assert infer_type(["1.5", "2", "30.25"]) == "DECIMAL"
    assert infer_type(["2026-01-01", "2026/2/3"]) == "DATE"
    assert infer_type(["是", "否", "是"]) == "BOOLEAN"
    assert infer_type(["A", "B", "A", "B", "A", "B", "A", "B", "A", "B"]) == "ENUM"
    assert infer_type([]) == "STRING"


# ══════════════════════════════════════════════════════════════════
#  DDL
# ══════════════════════════════════════════════════════════════════
def test_ddl_columns_types_and_primary_keys(real_ddl):
    doc = default_registry().parse(real_ddl)
    tables = {t["name"]: t for t in doc.structured["tables"]}
    assert set(tables) == {"pbp_header", "clm_contract"}
    assert tables["pbp_header"]["primary_key"] == ["plan_id"]
    amount = next(c for c in tables["pbp_header"]["columns"] if c["name"] == "plan_amount")
    assert amount["type"] == "DECIMAL(18, 2)"
    assert next(c for c in tables["pbp_header"]["columns"]
                if c["name"] == "plan_id")["nullable"] is False


def test_ddl_inline_comments_carry_the_definition(real_ddl):
    """两张表的 plan_amount 长得一模一样，区别全在注释里。"""
    doc = default_registry().parse(real_ddl)
    tables = {t["name"]: t for t in doc.structured["tables"]}
    a = next(c for c in tables["pbp_header"]["columns"] if c["name"] == "plan_amount")
    b = next(c for c in tables["clm_contract"]["columns"] if c["name"] == "plan_amount")
    assert a["comment"] == "含税·年度累计·CNY"
    assert b["comment"] == "不含税·单次·CNY"


def test_constraint_lines_are_not_mistaken_for_columns(real_ddl):
    """`CONSTRAINT fk_plan FOREIGN KEY ...` 不是列定义。"""
    doc = default_registry().parse(real_ddl)
    cols = {c["name"] for t in doc.structured["tables"] for c in t["columns"]}
    assert "CONSTRAINT" not in cols and "fk_plan" not in cols


def test_foreign_keys_become_cardinality_evidence(real_ddl):
    doc = default_registry().parse(real_ddl)
    fk = doc.structured["tables"][1]["foreign_keys"]
    assert fk and fk[0]["column"] == "plan_id"
    assert fk[0]["ref_table"] == "pbp_header" and fk[0]["ref_column"] == "plan_id"
    chunk = next(c for c in doc.chunks if "fk" in c.tags)
    assert "一对多" in chunk.render


def test_bad_sql_is_reported_not_swallowed(tmp_path):
    p = tmp_path / "broken.ddl"
    p.write_text("CREATE TABLE (((", encoding="utf-8")
    doc = default_registry().parse(p)
    assert any(f.kind in ("parse_failed", "no_tables") for f in doc.findings)


# ══════════════════════════════════════════════════════════════════
#  OpenAPI
# ══════════════════════════════════════════════════════════════════
def test_write_endpoints_are_separated_from_reads(real_openapi):
    """GET 不是 Action —— 读操作不改变世界状态。"""
    doc = default_registry().parse(real_openapi)
    eps = {e["operationId"]: e for e in doc.structured["endpoints"]}
    assert eps["submitPurchasePlan"]["write"] and eps["createPurchasePackage"]["write"]
    assert not eps["listSuppliers"]["write"]
    assert collect_endpoints([doc]) and all(e["write"] for e in collect_endpoints([doc]))


def test_schemas_give_object_and_property_candidates(real_openapi):
    doc = default_registry().parse(real_openapi)
    plan = doc.structured["schemas"]["Plan"]
    assert plan["properties"]["planId"]["required"]
    assert plan["properties"]["planAmount"]["base_type"] == "DECIMAL"
    assert plan["properties"]["effectiveDate"]["base_type"] == "DATE"
    assert plan["properties"]["status"]["enum"] == ["DRAFT", "SUBMITTED"]
    # description 常常就是口径说明，必须带出来
    assert "含税" in plan["properties"]["planAmount"]["description"]


def test_endpoint_chunks_carry_json_pointers(real_openapi):
    doc = default_registry().parse(real_openapi)
    ep = next(c for c in doc.chunks if "endpoint" in c.tags)
    assert ep.locator["kind"] == "json" and ep.locator["pointer"].startswith("$.paths.")


# ══════════════════════════════════════════════════════════════════
#  CSV / docx
# ══════════════════════════════════════════════════════════════════
def test_gbk_csv_is_decoded_and_flagged(gbk_csv):
    doc = default_registry().parse(gbk_csv)
    assert doc.structured["columns"] == ["物料编码", "物料名称", "计量单位", "单价"]
    assert any(f.kind == "encoding_guess" for f in doc.findings)


def test_large_csv_is_sampled_not_fully_indexed(gbk_csv):
    """几万行逐行入索引会撑爆上下文，且毫无检索价值。"""
    doc = default_registry().parse(gbk_csv)
    assert doc.structured["rows"] == 30
    assert len([c for c in doc.chunks if "sample" in c.tags]) == 20
    assert any(f.kind == "sampled" for f in doc.findings)
    prof = doc.structured["profile"]["物料编码"]
    assert prof["unique"] and prof["inferred_type"] == "STRING"
    assert doc.structured["profile"]["单价"]["inferred_type"] == "DECIMAL"


def test_docx_rule_sentences_are_tagged(flow_docx):
    """基数就是从「一个执行计划可拆入多个采购包」这种句子里读出来的。"""
    doc = default_registry().parse(flow_docx)
    rules = [c for c in doc.chunks if "rule" in c.tags]
    assert rules
    assert any("多个采购包" in c.render for c in rules)
    assert any("年度累计含税" in c.render for c in doc.chunks)


def test_docx_tables_are_extracted_separately(flow_docx):
    doc = default_registry().parse(flow_docx)
    tbl = [c for c in doc.chunks if "table" in c.tags]
    assert len(tbl) == 2
    assert "含税年度累计" in " ".join(c.render for c in tbl)


def test_docx_author_leak_is_reported(flow_docx):
    doc = default_registry().parse(flow_docx)
    assert any(f.kind == "metadata_leak" for f in doc.findings)


# ══════════════════════════════════════════════════════════════════
#  语料级
# ══════════════════════════════════════════════════════════════════
def test_whole_corpus_parses_and_is_searchable(corpus):
    docs = default_registry().parse_all(corpus)
    assert len(docs) == 5
    ix = build_index(docs)
    assert len(ix) > 20

    hits = ix.search("plan_amount 计划金额 口径", top_k=8, expand=0)
    cites = [c.cite() for c in hits]
    # 同一个字段的两种口径分别来自 xlsx 批注和 DDL 注释，都要能检出来
    assert any("schema.ddl" in c for c in cites)
    body = "\n".join(h.render for h in hits)
    assert "含税" in body


def test_summary_surfaces_every_finding(corpus):
    docs = default_registry().parse_all(corpus)
    s = corpus_summary(docs)
    kinds = {f["kind"] for f in s["findings"]}
    assert {"metadata_leak", "header_offset", "encoding_guess", "sampled"} <= kinds
    assert s["chunks"] == sum(len(d.chunks) for d in docs)


def test_unknown_extension_falls_back_not_skipped(tmp_path):
    """跳过一份材料而不告诉任何人，是这类系统最阴的失败模式。"""
    p = tmp_path / "notes.xyz"
    p.write_text("一个执行计划可拆入多个采购包。", encoding="utf-8")
    doc = default_registry().parse(p)
    assert doc.chunks and "采购包" in doc.chunks[0].render


def test_profiles_are_collected_for_type_mismatch_detection(corpus):
    docs = default_registry().parse_all(corpus)
    profiles = collect_profiles(docs)
    assert any(k.endswith(".单价") for k in profiles)
    assert profiles[next(k for k in profiles if k.endswith(".单价"))]["inferred_type"] == "DECIMAL"


def test_retrieval_gives_every_matching_file_a_seat(corpus):
    """跨文件口径冲突的前提是两边都被检出来。

    纯按分数取 top-k 时中文密集的切片会把 DDL 挤掉 —— 那样「计划金额」的双口径
    就永远发现不了。按文件轮转保证来源多样性。
    """
    ix = build_index(default_registry().parse_all(corpus))
    hits = ix.search("plan_amount 计划金额 口径", top_k=8, expand=0)
    files = {h.file_name for h in hits}
    assert {"schema.ddl", "实体梳理.xlsx"} <= files, f"只检出了 {files}"

    flat = ix.search("plan_amount 计划金额 口径", top_k=8, expand=0, diversify_by_file=False)
    assert len({h.file_name for h in flat}) <= len(files), "关掉多样性后来源应更集中"
