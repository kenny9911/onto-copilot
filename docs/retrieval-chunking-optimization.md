# Retrieval & Chunking Optimization — Status

Date: 2026-08-10
Scope: `onto/parse/*` (chunking) + `kernel/memory/evidence.py` (BM25 retrieval)
Guiding constraint: **OntoCopilot serves many business domains, not just
procurement.** Every change here is a language/structure signal, never domain
vocabulary. Retrieval stays BM25-first: zero-dependency, explainable,
reproducible in the event log. Provenance (`locator`) is sacred.

## Done (this pass)

Retrieval core (`evidence.py`):
- **CJK bigram tokenizer** — adjacent 2-char grams alongside unigrams; the
  camelCase-split equivalent for Chinese. Helps any CJK-language domain.
- **Tag boost** — `rule`/`relation`/`fk` chunks get ×1.3 only when they already
  match. Fulfills the long-documented "命中的切片打 rule 标签，检索时优先".
- **kind/tag filtering** — `search()` and the `evidence.search` tool can scope a
  query to a source type (e.g. `["ddl"]`).
- **Situating terms** — a `Chunk.context` field plus locator sheet/section names
  are tokenized into the search stream (not `render`, to avoid per-row
  repetition). "Retrieve by owning table/section" now works.
- **Inverted postings index** — score only chunks containing a query term. BM25
  output is bit-identical; matters when one xlsx explodes into thousands of rows.

Chunking (`onto/parse/*`):
- **Blank-continuation fill** (tabular) — grouping columns written once with
  blanks below (e.g. 实体名称) are carried into the chunk `render` (not `raw`, so
  downstream `shape.py` group detection is untouched). Field rows self-attribute
  to their entity; the flagship cross-entity 口径 conflict gains the xlsx批注 as
  a first-class source. **Safety-bounded** (needs a dense record-key anchor, only
  carries coarser columns left of it, never over-fills optional attributes).
- **Comment→column binding** (tabular) — cell comments keyed by `(row, col)`,
  rendered inline after the annotated column instead of one trailing blob.
- **Per-sheet xlsx schema chunk** — columns + types, mirroring csv.
- **DDL** — inline `COMMENT '...'` via the AST (not just `--`); table-level
  chunk; composite FK mapped positionally.
- **OpenAPI** — property `description`/`enum` in the schema render;
  endpoint→request-schema link chunks; null-description crash guarded.
- **docx** — full heading breadcrumb (H1 > H2 > H3) into locator+render; heading
  detection broadened to localized `标题` styles and numbering depth.

Domain-generality:
- **Rule cues** (`_RULE_HINTS`) bilingual and domain-neutral: dropped
  finance-specific 含税/不含税, added English cardinality/modality/relational
  cues. Rule tagging is a boost, never a gate.
- **Default session title** de-hardcoded (`采购中台 …` → `新的本体梳理`).

Evaluation:
- `tests/test_retrieval_eval.py` — deterministic golden recall / cross-file
  coverage, the 计划金额 conflict regression, locator round-trip fidelity.

## Deferred (with rationale)

| Item | Why deferred |
|---|---|
| **Hybrid BM25 + dense (RRF)** | Real fix for the paraphrase / bilingual-name gap, but adds an embedding dependency + vector cache. Do it behind a feature flag when a domain needs it; the `search(rerank=…)` hook is already the integration point. Keep BM25 primary + logged. |
| **Cross-encoder / LLM rerank** | Same hook. Cache scores by (query, chunk_id) for reproducibility. Marginal now — tag-boost + bigrams + inline comments already cover deterministic precision. |
| **ColBERT / late interaction** | Heavy dependency (token-level vectors, long-context embed model); breaks zero-dep. Not worth it. |
| **KG-augmented `oir.query`** | Turn the flat name-contains tool into neighborhood traversal over the OIR being built. Valuable for converse/audit; larger change, its own task. |
| **Size-adaptive segmentation** (`pipeline.py` `SEGMENT_CHUNKS=45`) | The fixed split and full-corpus extraction are fine for the demo corpus but won't scale to a 5000-row sheet. Needs a token-budgeted packer + fan-out cap; touches orchestration. |
| **Cap huge xlsx rows for retrieval** | csv caps at schema+20 samples; xlsx still indexes every row. Capping requires decoupling *retrieval chunks* from *extraction rows* (the rule layer needs full `chunk.raw`). Do it with the segmentation work above. |
| **Cross-segment LINK reconciliation** | A post-MERGE node to match FKs/relations across segments. Depends on the segmentation refactor. |

## Design notes for future domains

- Chunking is deterministic + statistics-based; retrieval is lexical; extraction
  is LLM-driven with procurement **examples** in prompts. The examples teach the
  concept without constraining the domain — keep them concrete.
- `flow._DOMAIN_CODES` is a procurement seed with graceful fallback (unknown
  domain → name-generated code). When a second domain onboards, make domain
  codes configurable rather than extending the hardcoded dict.
