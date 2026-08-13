"""导出 onto/bundle.py 的 golden 向量（供 ts/test/onto.bundle.test.ts 断言）。

字节确定性：`bundle.build_zip` 把**当前本地时间**写进每个 zip 成员的 mtime
（CPython `zipfile.writestr` 对 str 参数的既定行为），所以直接跑两次产出的字节
必然不同。这里在**导出脚本内**冻结 `zipfile` 看到的 time —— Python 原件一个字
都没改，冻结只发生在这个进程里。冻结用的 date_time 一并写进 golden，TS 侧用
同一个值调 buildZip 才能做整包字节比对。

重跑两次 shasum 一致。
"""

from __future__ import annotations

import base64
import json
import sys
import time as _time
import types
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.onto import bundle as B  # noqa: E402

#: 冻结的成员时间戳。选一个秒数为奇数的时刻 —— DOS 时间只有 2 秒精度
#: （`dt[5] // 2`），奇数秒能顺带钉住"截断而不是四舍五入"。
FROZEN = (2026, 8, 13, 20, 27, 35)


def _freeze_zipfile_clock() -> None:
    shim = types.SimpleNamespace(
        localtime=lambda *_a: _time.struct_time((*FROZEN, 0, 1, -1)),
        time=lambda: 0.0,
    )
    zipfile.time = shim  # type: ignore[attr-defined]


def main() -> None:
    _freeze_zipfile_clock()
    out: dict[str, object] = {}

    # ── classify ────────────────────────────────────────────────
    names = [
        "oir.json", "flow.json", "流程图_主干.svg", "流程图.svg", "流程图.mmd",
        "template.spec.json", "回传_审核.xlsx", "回传.xlsx", "回传.csv",
        "模板_v1.xlsx", "随便.txt", "", "xlsx", "materials/回传x.xlsx",
    ]
    out["classify"] = [{"name": n, "out": list(B.classify(n))} for n in names]

    # ── 溯源汇总：合成向量 + 真材料 ──────────────────────────────
    synthetic_flow = {
        "nodes": [
            {"grounded": True, "label": {"evidence": []}},
            {"grounded": False, "label": {"evidence": [{"extractor": "human"}]}},
            {"grounded": False, "label": {}},
            {"label": {"evidence": [{"extractor": "human"}, {"extractor": "llm"}]}},
        ],
        "edges": [
            {"grounded": True, "evidence": []},
            {"grounded": False, "evidence": [{"extractor": "human"}]},
            {"grounded": 0, "evidence": None},
        ],
        "stats": {"inferred_edges": 0, "dead_ends": 2, "dangling": "3"},
    }
    synthetic_oir = {
        "objects": [
            {"displayName": {"value": "采购包", "origin": "extracted",
                             "evidence": [{"extractor": "docling"}]}},
            {"displayName": {"value": "X", "origin": "inferred", "evidence": []}},
            {"apiName": {"value": "y", "evidence": [{"extractor": "ocr"}, {}]}},
        ],
        "rules": [{"statement": {"evidence": [{"extractor": "human"}]}}],
        "questions": [{"text": {"evidence": []}}, {}],
        "stats": {"open_questions": 2, "confirmed": 1},
    }
    flow_real = json.loads((ROOT / "golden" / "pipeline.flow.json").read_text("utf-8"))
    oir_real = json.loads((ROOT / "golden" / "pipeline.oir.json").read_text("utf-8"))
    out["flow_provenance"] = [
        {"label": "none", "in": None, "out": B.flow_provenance(None)},
        {"label": "empty", "in": {}, "out": B.flow_provenance({})},
        {"label": "synthetic", "in": synthetic_flow,
         "out": B.flow_provenance(synthetic_flow)},
        {"label": "pipeline.flow.json", "in": None, "out": B.flow_provenance(flow_real)},
    ]
    out["oir_provenance"] = [
        {"label": "none", "in": None, "out": B.oir_provenance(None)},
        {"label": "empty", "in": {}, "out": B.oir_provenance({})},
        {"label": "synthetic", "in": synthetic_oir, "out": B.oir_provenance(synthetic_oir)},
        {"label": "pipeline.oir.json", "in": None, "out": B.oir_provenance(oir_real)},
    ]

    # ── bundle_id ───────────────────────────────────────────────
    files_ab = [{"path": "oir.json", "sha256": "aa"}, {"path": "flow.json", "sha256": "bb"}]
    cjk_files = [{"path": "流程图.svg", "sha256": "11"}, {"path": "Zz.svg", "sha256": "22"},
                 {"path": "oir.json"}]
    out["bundle_id"] = [
        {"files": files_ab, "pv": "0.1.0", "rs": "", "id": B.bundle_id(files_ab, "0.1.0")},
        {"files": list(reversed(files_ab)), "pv": "0.1.0", "rs": "",
         "id": B.bundle_id(list(reversed(files_ab)), "0.1.0")},
        {"files": files_ab, "pv": "0.2.0", "rs": "", "id": B.bundle_id(files_ab, "0.2.0")},
        {"files": files_ab, "pv": "0.1.0", "rs": "DRAFT",
         "id": B.bundle_id(files_ab, "0.1.0", "DRAFT")},
        {"files": files_ab, "pv": "0.1.0", "rs": "RELEASED",
         "id": B.bundle_id(files_ab, "0.1.0", "RELEASED")},
        # 中文文件名：Python 按 code point 排，JS 默认 sort 按 UTF-16 code unit 排
        {"files": cjk_files, "pv": "0.1.0", "rs": "", "id": B.bundle_id(cjk_files, "0.1.0")},
    ]

    # ── manifest / readme / zip ─────────────────────────────────
    data = b'{"nodes": []}'
    files = [{"path": "flow.json", "size": len(data),
              "sha256": __import__("hashlib").sha256(data).hexdigest(),
              "kind": "flow_json", "title": "流程图数据", "provenance": "mixed"},
             {"path": "流程图_主干.svg", "size": 3, "sha256": "cc",
              "kind": "flow_svg_main", "title": "主干", "provenance": "grounded"},
             {"path": "readme.txt", "size": 0}]
    cases = []
    for label, session, flow, oir, oq in [
        ("draft", {"id": "s1", "title": "T", "project": "P", "status": "done"},
         synthetic_flow, synthetic_oir, [{"q": "缺主键"}, {"text": "谁负责"}, {}]),
        ("released", {"id": "s2", "status": "done", "release_state": "released"},
         None, None, []),
        ("bogus_state", {"id": "s3", "status": "x", "release_state": "WEIRD"},
         None, None, []),
    ]:
        man = B.build_manifest(
            session=session, product_version="0.1.0", files=files, materials=[
                {"name": "材料.xlsx", "size": 3}, {"name": "b.pdf"}],
            flow=flow, oir=oir, open_questions=oq,
            generated_at=1723540123.4567, generated_at_iso="2026-08-13T12:00:00Z")
        readme = B.readme_text(man)
        cases.append({
            "label": label,
            "session": session,
            "flow": flow,
            "oir": oir,
            "open_questions": oq,
            "manifest": man,
            "manifest_json": json.dumps(man, ensure_ascii=False, indent=2),
            "readme": readme,
        })
    out["manifest_cases"] = cases
    out["manifest_files"] = files
    out["manifest_materials"] = [{"name": "材料.xlsx", "size": 3}, {"name": "b.pdf"}]

    zip_entries = [("flow.json", data), ("materials/材料.xlsx", b"abc"),
                   ("空.bin", b""), ("big.txt", b"x" * 5000)]
    blob = B.build_zip(zip_entries, cases[0]["manifest"], cases[0]["readme"])
    out["zip"] = {
        "date_time": list(FROZEN),
        "entries": [{"name": n, "b64": base64.b64encode(d).decode()} for n, d in zip_entries],
        "manifest_case": "draft",
        "b64": base64.b64encode(blob).decode(),
        "namelist": zipfile.ZipFile(__import__("io").BytesIO(blob)).namelist(),
    }

    dst = ROOT / "golden" / "onto.bundle.json"
    # **不能 sort_keys**：manifest 的键序本身就是被断言的东西（它要进包、要被
    # diff），排一遍序就把 TS 侧要复现的形态抹掉了。插入序本来就是确定的。
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(f"wrote {dst} ({dst.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
