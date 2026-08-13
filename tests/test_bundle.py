"""Bundle 打包纯逻辑。零服务、零依赖 —— 和 diagram/flow_extract 一样脱离 server 测。

打包的核心承诺有两条，两条都在这里盯：一是**可复现**（同样产物打两次包版本戳相同、
内容变则变），二是**有据 vs 推断要露出来**（清单和交付说明里都得能看到）。
"""

from __future__ import annotations

import io
import json
import zipfile

from ontocopilot.kernel.ids import sha256_hex
from ontocopilot.onto import bundle as B


def test_classify_maps_known_products():
    assert B.classify("流程图_主干.svg")[0] == "flow_svg_main"
    assert B.classify("流程图_主干.svg")[2] == "grounded"   # 主干只留有依据的
    assert B.classify("流程图.svg")[0] == "flow_svg_full"
    assert B.classify("oir.json")[0] == "oir_json"
    assert B.classify("flow.json")[0] == "flow_json"
    assert B.classify("模板_v1.xlsx")[0] == "template_xlsx"
    assert B.classify("template.spec.json")[0] == "template_spec"
    assert B.classify("回传_审核.xlsx")[0] == "audit_return"
    assert B.classify("随便.txt")[0] == "other"


def test_flow_provenance_counts_grounded_and_human():
    flow = {"nodes": [{"grounded": True, "label": {"evidence": []}},
                      {"grounded": False,
                       "label": {"evidence": [{"extractor": "human"}]}}],
            "edges": [{"grounded": True, "evidence": []},
                      {"grounded": False, "evidence": []}],
            "stats": {"inferred_edges": 1, "dead_ends": 0, "dangling": 0}}
    p = B.flow_provenance(flow)
    assert p["nodes"] == 2 and p["grounded_nodes"] == 1 and p["inferred_nodes"] == 1
    assert p["edges"] == 2 and p["inferred_edges"] == 1
    assert p["human_edited"] == 1


def test_oir_provenance_grounded_by_primary_name():
    oir = {"objects": [
        {"displayName": {"value": "采购包", "origin": "extracted",
                         "evidence": [{"extractor": "docling"}]}},
        {"displayName": {"value": "X", "origin": "inferred", "evidence": []}}],
        "stats": {"open_questions": 2, "confirmed": 1}}
    p = B.oir_provenance(oir)
    assert p["objects"] == 2
    assert p["grounded_objects"] == 1 and p["inferred_objects"] == 1
    assert p["by_extractor"] == {"docling": 1}
    assert p["open_questions"] == 2


def test_bundle_id_is_stable_and_content_sensitive():
    files = [{"path": "oir.json", "sha256": "aa"},
             {"path": "flow.json", "sha256": "bb"}]
    a = B.bundle_id(files, "0.1.0")
    assert a == B.bundle_id(list(reversed(files)), "0.1.0")          # 与顺序无关
    assert a != B.bundle_id([{"path": "oir.json", "sha256": "cc"},
                             {"path": "flow.json", "sha256": "bb"}], "0.1.0")  # 内容变
    assert a != B.bundle_id(files, "0.2.0")                          # 版本变
    assert len(a) == 12


def test_build_zip_contains_manifest_readme_and_files_with_matching_hashes():
    data = b'{"nodes": []}'
    files = [{"path": "flow.json", "size": len(data), "sha256": sha256_hex(data),
              "kind": "flow_json", "title": "流程图数据", "provenance": "mixed"}]
    manifest = B.build_manifest(
        session={"id": "s1", "title": "T", "project": "P", "status": "done"},
        product_version="0.1.0", files=files,
        materials=[{"name": "x.xlsx", "size": 3}],
        flow={"nodes": [], "edges": [], "stats": {}}, oir=None,
        open_questions=[{"q": "缺主键"}], generated_at=1.0,
        generated_at_iso="2026-08-10T00:00:00Z")
    blob = B.build_zip([("flow.json", data), ("materials/x.xlsx", b"abc")],
                       manifest, B.readme_text(manifest))
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = set(zf.namelist())
    assert {"flow.json", "materials/x.xlsx", "manifest.json", "交付说明.md"} <= names
    # manifest 里每个文件的 sha256 与 zip 成员字节一致
    m = json.loads(zf.read("manifest.json"))
    assert m["schema"] == B.BUNDLE_SCHEMA
    assert m["release_state"] == "DRAFT"
    assert m["bundle_id"] == B.bundle_id(files, "0.1.0", "DRAFT")
    assert sha256_hex(zf.read("flow.json")) == m["files"][0]["sha256"]
    # 交付说明里要有「推断」的提醒 —— 交付前让人知道哪些没依据
    readme = zf.read("交付说明.md").decode("utf-8")
    assert "推断" in readme
    assert "发布状态：DRAFT" in readme and "不得视为正式发布版本" in readme


def test_released_bundle_is_explicit_in_manifest_and_readme():
    manifest = B.build_manifest(
        session={"id": "s1", "status": "done", "release_state": "RELEASED"},
        product_version="0.1.0", files=[], materials=[], flow=None, oir=None,
        open_questions=[], generated_at=1.0,
    )
    assert manifest["release_state"] == "RELEASED"
    readme = B.readme_text(manifest)
    assert "发布状态：RELEASED" in readme
    assert "不得视为正式发布版本" not in readme
    draft = B.build_manifest(
        session={"id": "s1", "status": "done", "release_state": "DRAFT"},
        product_version="0.1.0", files=[], materials=[], flow=None, oir=None,
        open_questions=[], generated_at=1.0,
    )
    assert draft["bundle_id"] != manifest["bundle_id"]


def test_empty_inputs_do_not_crash_provenance():
    assert B.flow_provenance(None)["nodes"] == 0
    assert B.oir_provenance(None)["objects"] == 0
