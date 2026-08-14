"""`onto/parse/__init__.py`（装配层）的 golden 导出。

这一层只有五个函数，但它们是「材料进系统」这条路的全部：
``default_registry`` 决定哪份材料交给谁解析，``build_index`` 决定它进不进检索，
``collect_profiles`` / ``collect_endpoints`` 决定下游的确定性检测能看到什么，
``corpus_summary`` 决定 FDE 在界面上看到什么。

导什么、为什么导它：

* ``registry`` —— 九个解析器的**顺序**（顺序即优先级：``.json`` 归 OpenApiParser
  而不是兜底的 TextParser），以及 ``for_path`` 在一批真实/刁钻路径上的派发结果。
  没兜底时才抛 —— 兜底存在时**未知扩展名必须落到 TextParser**，静默跳过一份
  材料是这类系统最阴的失败模式。
* ``corpus`` —— 一个**真语料**跑完整条 ``parse_all → build_index →
  collect_* / corpus_summary``。语料里放了 ``golden/材料.xlsx``（真材料，
  ``pipeline.*.json`` 就是从它跑出来的）、CSV、OpenAPI、纯文本、以及一个
  未知扩展名的文件。合成文件的字节以 base64 一并导出，TS 侧落到临时目录再解析，
  两边吃的是同一批字节。
* ``vectors`` —— 三个 collect/summary 函数在合成 ParsedDoc 上的分支：
  ``profile`` 为空字典时被 walrus 判falsy而**整段跳过**、跨文件同名 sheet
  后者覆盖前者、``write`` 取真值（不是 ``is True``）、``stats()`` 里 ``title``
  是字符串所以**原样输出**不取长度、``Path(name).stem`` 的几个刁钻名字
  （``trail.`` 在 Python 与 Node 的 ``extname`` 之间正好分叉）。

跑法::

    .venv/bin/python tools/golden/onto_parse_index.py

输出 ``golden/onto.parse.index.json``（新文件，我独占）。重跑两次 shasum 必须一致。
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ontocopilot.kernel.memory.evidence import Chunk
from ontocopilot.onto.parse import (
    ParsedDoc,
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)
from ontocopilot.onto.parse.base import Finding

OUT = Path(__file__).resolve().parents[2] / "golden"


# ══════════════════════════════════════════════════════════════════
#  序列化
# ══════════════════════════════════════════════════════════════════

def dump_doc(doc: ParsedDoc) -> dict[str, Any]:
    """ParsedDoc → 纯 JSON。字段顺序固定，diff 才读得懂。"""
    return {
        "file_id": doc.file_id,
        "file_name": doc.file_name,
        "kind": doc.kind,
        "meta": doc.meta,
        "structured": doc.structured,
        "findings": [{"kind": f.kind, "message": f.message,
                      "locator": f.locator, "severity": f.severity}
                     for f in doc.findings],
        "chunks": [{"chunk_id": c.chunk_id, "file_id": c.file_id,
                    "file_name": c.file_name, "locator": c.locator,
                    "render": c.render, "raw": c.raw, "order": c.order,
                    "tags": list(c.tags), "context": c.context}
                   for c in doc.chunks],
        "stats": doc.stats(),
    }


def load_doc(d: dict[str, Any]) -> ParsedDoc:
    """JSON → ParsedDoc。合成向量用，TS 侧照着同一份 JSON 重建。"""
    doc = ParsedDoc(file_id=d["file_id"], file_name=d["file_name"], kind=d["kind"])
    doc.structured = d.get("structured", {})
    doc.meta = d.get("meta", {})
    doc.findings = [Finding(f["kind"], f["message"], f.get("locator", {}),
                            f.get("severity", "info"))
                    for f in d.get("findings", [])]
    doc.chunks = [Chunk(chunk_id=c["chunk_id"], file_id=c["file_id"],
                        file_name=c["file_name"], locator=c.get("locator", {}),
                        render=c.get("render", ""), raw=c.get("raw"),
                        order=c.get("order", 0), tags=list(c.get("tags", [])),
                        context=c.get("context", ""))
                   for c in d.get("chunks", [])]
    return doc


# ══════════════════════════════════════════════════════════════════
#  1. 注册表：顺序即优先级 + 派发
# ══════════════════════════════════════════════════════════════════

DISPATCH_PATHS = [
    "/m/材料.xlsx",
    "/m/表.XLSX",                  # 扩展名大小写不敏感
    "/m/清单.xlsm",
    "/m/清单.xltx",
    "/m/inventory.csv",
    "/m/inventory.tsv",
    "/m/schema.ddl",
    "/m/schema.sql",
    "/m/openapi.json",
    "/m/openapi.yaml",
    "/m/openapi.yml",
    "/m/flow.bpmn",
    "/m/flow.bpmn20.xml",          # 复合后缀：BpmnParser 覆写了 accepts
    "/m/plain.xml",                # 普通 xml **不**归 BPMN，落兜底
    "/m/deck.pptx",
    "/m/deck.pptm",
    "/m/deck.ppsx",
    "/m/doc.docx",
    "/m/scan.png",
    "/m/scan.PDF",
    "/m/notes.md",
    "/m/notes.txt",
    "/m/notes.markdown",
    "/m/notes.rst",
    "/m/README",                   # 没有扩展名 → 兜底
    "/m/data.parquet",             # 未知扩展名 → 兜底，**不静默跳过**
    "/m/说明.中文后缀",             # 非 ASCII 扩展名
    "/m/archive.tar.gz",
]


def registry_section() -> dict[str, Any]:
    reg = default_registry()
    bare = default_registry.__wrapped__ if hasattr(default_registry, "__wrapped__") else None
    assert bare is None  # 没有装饰器，直接用
    parsers = [{"kind": p.kind, "extensions": list(p.extensions)} for p in reg._parsers]
    dispatch = [{"path": p, "kind": reg.for_path(Path(p)).kind} for p in DISPATCH_PATHS]

    # 没有兜底时 for_path 抛 ValueError，消息里有 `!r`
    from ontocopilot.onto.parse.base import ParserRegistry
    from ontocopilot.onto.parse.text import TextParser
    empty = ParserRegistry().register(TextParser())      # 注册了但**不是**兜底
    errors = []
    for p in ("/m/data.parquet", "/m/README", "/m/说明.中文后缀"):
        try:
            empty.for_path(Path(p))
        except ValueError as e:
            errors.append({"path": p, "error": str(e)})
        else:                                            # pragma: no cover
            errors.append({"path": p, "error": None})

    return {
        "parsers": parsers,
        "fallback": reg._fallback.kind if reg._fallback else None,
        "dispatch": dispatch,
        "no_fallback_errors": errors,
        # 构造参数要真的落到解析器身上
        "sql_dialect": [
            {"arg": None, "dialect": default_registry()._parsers[2].dialect},
            {"arg": "postgres",
             "dialect": default_registry(sql_dialect="postgres")._parsers[2].dialect},
        ],
        "vision_prefer": [
            {"arg": "quality", "prefer": default_registry()._parsers[7].prefer},
            {"arg": "cost",
             "prefer": default_registry(vision_prefer="cost")._parsers[7].prefer},
        ],
        "vision_gateway_none": default_registry()._parsers[7].gateway is None,
    }


# ══════════════════════════════════════════════════════════════════
#  2. 真语料端到端
# ══════════════════════════════════════════════════════════════════

CSV_BYTES = (
    "客户编号,客户名称,注册日期,信用额度,状态\n"
    "C001,北京海淀商贸,2023-01-15,100000,启用\n"
    "C002,上海浦东实业,2023-02-20,250000,启用\n"
    "C003,广州天河科技,2023-03-11,,停用\n"
    "C004,深圳南山物流,2023-04-02,80000,启用\n"
).encode("utf-8")

OPENAPI_BYTES = json.dumps({
    "openapi": "3.0.0",
    "info": {"title": "客户中心 API", "version": "1.0.0"},
    "paths": {
        "/customers": {
            "get": {"summary": "查询客户列表", "operationId": "listCustomers"},
            "post": {"summary": "新建客户", "operationId": "createCustomer",
                     "requestBody": {"content": {"application/json": {
                         "schema": {"$ref": "#/components/schemas/Customer"}}}}},
        },
        "/customers/{id}": {
            "get": {"summary": "查询客户", "operationId": "getCustomer"},
            "put": {"summary": "更新客户", "operationId": "updateCustomer"},
            "delete": {"summary": "停用客户", "operationId": "deleteCustomer"},
        },
    },
    "components": {"schemas": {"Customer": {
        "type": "object",
        "required": ["code", "name"],
        "properties": {
            "code": {"type": "string", "description": "客户编号"},
            "name": {"type": "string", "description": "客户名称"},
            "credit": {"type": "number", "description": "信用额度"},
        },
    }}},
}, ensure_ascii=False, indent=1).encode("utf-8")

NOTES_BYTES = (
    "# 客户主数据口径\n\n"
    "客户编号全局唯一，一个客户至多有一个主责销售。\n"
    "信用额度必须大于零，停用客户不参与额度校验。\n\n"
    "## 状态机\n\n"
    "启用 → 停用 需要审批，停用 → 启用 不需要。\n"
).encode("utf-8")

UNKNOWN_BYTES = "id|name\n1|甲\n2|乙\n".encode("utf-8")

SYNTH_FILES: list[tuple[str, bytes]] = [
    ("客户.csv", CSV_BYTES),
    ("openapi.json", OPENAPI_BYTES),
    ("notes.md", NOTES_BYTES),
    ("data.parquet", UNKNOWN_BYTES),
]

# **不导 search 的结果**。`EvidenceIndex.search` 的候选集是 `set[str]`，同分切片的
# 相对次序跟着 PYTHONHASHSEED 走 —— 同一份材料连跑两次导出，第五名就换了一个 id。
# 那不是 TS 侧要复现的行为，而是 Python 的哈希随机化，钉住它只会把噪声当成契约。
# `build_index` 的职责到"切片按解析顺序全部进了索引"为止，下面导的就是这个；
# BM25 打分本身归 memory.evidence track，那边已经钉死了。


def corpus_section() -> dict[str, Any]:
    tmp = Path(tempfile.mkdtemp(prefix="parse_index_"))
    try:
        paths = [tmp / "材料.xlsx"]
        shutil.copyfile(OUT / "材料.xlsx", paths[0])
        for name, raw in SYNTH_FILES:
            p = tmp / name
            p.write_bytes(raw)
            paths.append(p)

        reg = default_registry()
        docs = reg.parse_all(paths)
        index = build_index(docs)

        return {
            "materials": [
                {"name": "材料.xlsx", "from_golden": True,
                 "sha256_b64": base64.b64encode(
                     hashlib.sha256((OUT / "材料.xlsx").read_bytes()).digest()).decode()},
                *[{"name": n, "from_golden": False,
                   "bytes_b64": base64.b64encode(b).decode()} for n, b in SYNTH_FILES],
            ],
            "docs": [dump_doc(d) for d in docs],
            "summary": corpus_summary(docs),
            "profiles": collect_profiles(docs),
            "endpoints": collect_endpoints(docs),
            "index": {
                "len": len(index),
                "chunk_ids": [c.chunk_id for c in index.all_chunks()],
                "file_names": index.file_names(),
                "by_file": {fid: [c.chunk_id for c in index.by_file(fid)]
                            for fid in index.file_names().values()},
            },
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════
#  3. 合成向量：三个 collect/summary 的分支
# ══════════════════════════════════════════════════════════════════

def _doc(file_id: str, file_name: str, kind: str, structured: dict[str, Any],
         *, findings: list[dict[str, Any]] | None = None,
         chunks: int = 0) -> dict[str, Any]:
    return {
        "file_id": file_id, "file_name": file_name, "kind": kind, "meta": {},
        "structured": structured,
        "findings": findings or [],
        "chunks": [{"chunk_id": f"{file_id}:c{i}", "file_id": file_id,
                    "file_name": file_name, "locator": {"row": i}, "render": f"块{i}",
                    "raw": None, "order": i, "tags": [], "context": ""}
                   for i in range(chunks)],
    }


PROF_A = {"name": "客户编号", "type": "code", "nulls": 0}
PROF_B = {"name": "金额", "type": "number", "nulls": 2}

VECTORS: list[dict[str, Any]] = [
    {
        "name": "空语料",
        "docs": [],
    },
    {
        "name": "sheets 的三种 profile 缺失形态",
        "docs": [_doc("f1", "a.xlsx", "xlsx", {"sheets": [
            {"name": "有画像", "profile": {"客户编号": PROF_A}},
            {"name": "profile 是 None", "profile": None},
            {"name": "profile 是空字典", "profile": {}},
            {"name": "根本没有 profile 键"},
        ]}, chunks=2)],
    },
    {
        "name": "doc 级 profile：空字典被 walrus 判假，整段跳过",
        "docs": [
            _doc("f1", "empty.csv", "csv", {"columns": [], "rows": 0, "profile": {}}),
            _doc("f2", "有货.csv", "csv", {"rows": 3, "profile": {"金额": PROF_B}}),
        ],
    },
    {
        "name": "Path(...).stem 的刁钻名字",
        "docs": [
            _doc("f1", "odd.name.csv", "csv", {"profile": {"甲": PROF_A}}),
            _doc("f2", "noext", "csv", {"profile": {"乙": PROF_A}}),
            _doc("f3", ".hidden", "csv", {"profile": {"丙": PROF_A}}),
            _doc("f4", "trail.", "csv", {"profile": {"丁": PROF_A}}),
            _doc("f5", "a..csv", "csv", {"profile": {"戊": PROF_A}}),
            _doc("f6", ".hidden.csv", "csv", {"profile": {"己": PROF_A}}),
        ],
    },
    {
        "name": "跨文件同名 sheet：后者覆盖前者",
        "docs": [
            _doc("f1", "一月.xlsx", "xlsx",
                 {"sheets": [{"name": "客户", "profile": {"编号": PROF_A}}]}),
            _doc("f2", "二月.xlsx", "xlsx",
                 {"sheets": [{"name": "客户", "profile": {"编号": PROF_B}}]}),
        ],
    },
    {
        "name": "sheet 与 doc 级 profile 同时存在（键前缀不同）",
        "docs": [_doc("f1", "混合.xlsx", "xlsx", {
            "sheets": [{"name": "表一", "profile": {"甲": PROF_A}}],
            "profile": {"乙": PROF_B},
        })],
    },
    {
        "name": "endpoints：write 取真值而不是 is True",
        "docs": [
            _doc("f1", "api.json", "openapi", {"endpoints": [
                {"method": "get", "path": "/a", "write": False},
                {"method": "post", "path": "/b", "write": True},
                {"method": "put", "path": "/c"},
                {"method": "patch", "path": "/d", "write": "yes"},
                {"method": "delete", "path": "/e", "write": 0},
                {"method": "post", "path": "/f", "write": None},
                {"method": "post", "path": "/g", "write": 1},
            ]}),
            _doc("f2", "plain.json", "json", {"keys": ["a"]}),
            _doc("f3", "空端点.json", "openapi", {"endpoints": []}),
        ],
    },
    {
        "name": "corpus_summary：stats 里 title 是字符串所以原样、raw 键被排除",
        "docs": [
            _doc("f1", "api.json", "openapi", {
                "endpoints": [{"method": "post", "path": "/a", "write": True}],
                "schemas": {"A": {}, "B": {}},
                "title": "客户中心 API",
                "raw": {"整份": "原始数据", "很大": [1, 2, 3]},
            }, findings=[
                {"kind": "metadata_leak", "message": "作者：张三",
                 "locator": {"part": "docProps/core.xml"}, "severity": "warn"},
            ], chunks=3),
            _doc("f2", "空.md", "text", {"sections": 0, "chars": 0}, chunks=0),
            _doc("f3", "多发现.csv", "csv", {"rows": 1}, findings=[
                {"kind": "encoding_guess", "message": "按 gb18030 解码",
                 "locator": {}, "severity": "warn"},
                {"kind": "header_shift", "message": "表头在第 3 行",
                 "locator": {"sheet": "x", "row": 3}, "severity": "info"},
            ], chunks=1),
        ],
    },
    {
        "name": "stats 的取长度规则：list/dict 取长度、标量原样",
        "docs": [_doc("f1", "杂.xlsx", "xlsx", {
            "sheets": [{"name": "s1"}, {"name": "s2"}],
            "rows": 42,
            "delimiter": ",",
            "title": "标题不取长度",
            "profile": {"a": {}, "b": {}, "c": {}},
            "flag": True,
            "ratio": 0.5,
            "nothing": None,
        }, chunks=1)],
    },
]


def vectors_section() -> list[dict[str, Any]]:
    out = []
    for v in VECTORS:
        docs = [load_doc(d) for d in v["docs"]]
        out.append({
            "name": v["name"],
            "docs": v["docs"],
            "summary": corpus_summary(docs),
            "profiles": collect_profiles(docs),
            "endpoints": collect_endpoints(docs),
            "index": {
                "len": len(build_index(docs)),
                "chunk_ids": [c.chunk_id for c in build_index(docs).all_chunks()],
            },
        })
    return out


def build_index_reuse() -> dict[str, Any]:
    """传入已有索引时**就地灌入并返回同一个对象** —— 重解析要能往同一个索引里加。"""
    a = [load_doc(_doc("f1", "a.xlsx", "xlsx", {}, chunks=2))]
    b = [load_doc(_doc("f2", "b.xlsx", "xlsx", {}, chunks=3))]
    ix = build_index(a)
    same = build_index(b, ix)
    return {
        "is_same_object": same is ix,
        "chunk_ids": [c.chunk_id for c in ix.all_chunks()],
        # 同一份文档灌两次：EvidenceIndex.add 见到重复 chunk_id 直接 return
        "twice_len": len(build_index(a, build_index(a))),
    }


def main() -> None:
    out = {
        "registry": registry_section(),
        "corpus": corpus_section(),
        "vectors": vectors_section(),
        "build_index_reuse": build_index_reuse(),
    }
    path = OUT / "onto.parse.index.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  onto.parse.index.json {path.stat().st_size:>9} B")


if __name__ == "__main__":
    main()
