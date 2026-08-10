"""Ontology 交付包（Bundle）—— 把一个会话的全部产物打成一个可下载的 zip。

FDE 跑完梳理，手里是一堆散落在会话目录里的文件（模板 xlsx、流程图 SVG、oir.json…）。
他真正要交付给业务方/下游的，是**一个自洽的包**：产物 + 一份清单（manifest）+ 一份
中文交付说明。清单里最关键的一件事是**把「有据」和「推断」标出来** —— 灰色/虚线的
东西是系统猜的，交付前必须让人知道哪些还没有材料依据。

这个模块是**纯函数、零依赖**（只用 stdlib 的 zipfile/io/hashlib），和 diagram.py /
flow_extract.py 一样可以脱离服务单测。打包逻辑不塞进 server.py，就是为了能这样测。
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

from ..kernel.ids import sha256_hex

__all__ = [
    "BUNDLE_SCHEMA", "classify", "flow_provenance", "oir_provenance",
    "bundle_id", "build_manifest", "readme_text", "build_zip",
]

BUNDLE_SCHEMA = "ontocopilot.bundle/1"


# ══════════════════════════════════════════════════════════════════
#  文件归类
# ══════════════════════════════════════════════════════════════════
#: 每类产物 → (kind, 中文标题, 溯源提示)。溯源提示：grounded 全有据、
#: inferred 全推断、mixed 有据+推断混、n/a 不适用（元数据/原始上传）。
def classify(name: str) -> tuple[str, str, str]:
    """按文件名归类。文件名是产物流水线里固定命名的，靠它就够，不用读内容。"""
    n = name
    if n == "oir.json":
        return ("oir_json", "Ontology 中间表示（对象/属性/关系/动作/规则/问题）", "mixed")
    if n == "flow.json":
        return ("flow_json", "业务流程图数据（Action+Event+Workflow）", "mixed")
    if n == "流程图_主干.svg":
        return ("flow_svg_main", "主干业务流程图（仅有依据的环节）", "grounded")
    if n == "流程图.svg":
        return ("flow_svg_full", "完整业务流程图（含推断环节）", "mixed")
    if n == "流程图.mmd":
        return ("flow_mermaid", "业务流程图 Mermaid 源码", "mixed")
    if n == "template.spec.json":
        return ("template_spec", "填写模板结构定义（含回读锚点）", "mixed")
    if n.startswith("回传") and n.endswith(".xlsx"):
        return ("audit_return", "回传审核表", "n/a")
    if n.endswith(".xlsx"):
        return ("template_xlsx", "业务方填写模板", "mixed")
    return ("other", name, "n/a")


# ══════════════════════════════════════════════════════════════════
#  溯源汇总
# ══════════════════════════════════════════════════════════════════
def _extractors(assertion: Any) -> list[str]:
    """一条断言里每条证据的 extractor（docling/llm/ocr/human…）。"""
    if not isinstance(assertion, dict):
        return []
    return [str(e.get("extractor") or "llm")
            for e in (assertion.get("evidence") or []) if isinstance(e, dict)]


def _grounded(assertion: Any) -> bool:
    return bool(isinstance(assertion, dict) and (assertion.get("evidence") or []))


def flow_provenance(flow: dict[str, Any] | None) -> dict[str, Any]:
    """从 flow.json 汇总有据 vs 推断。空图返回一份全 0 的结构，别让下游判 None。"""
    flow = flow or {}
    nodes = flow.get("nodes") or []
    edges = flow.get("edges") or []
    stats = flow.get("stats") or {}
    grounded_nodes = sum(1 for n in nodes if n.get("grounded"))
    human = sum(1 for n in nodes
                if any(e.get("extractor") == "human"
                       for e in (((n.get("label") or {}).get("evidence")) or [])))
    human += sum(1 for e in edges
                 if any(p.get("extractor") == "human"
                        for p in (e.get("evidence") or [])))
    return {
        "nodes": len(nodes), "grounded_nodes": grounded_nodes,
        "inferred_nodes": len(nodes) - grounded_nodes,
        "edges": len(edges),
        "grounded_edges": sum(1 for e in edges if e.get("grounded")),
        "inferred_edges": int(stats.get("inferred_edges") or
                              sum(1 for e in edges if not e.get("grounded"))),
        "dead_ends": int(stats.get("dead_ends") or 0),
        "dangling": int(stats.get("dangling") or 0),
        "human_edited": human,
    }


def oir_provenance(oir: dict[str, Any] | None) -> dict[str, Any]:
    """从 oir.json 汇总每类容器的数量 + 有据/推断 + 按 extractor 统计。

    实体「有据」的判定：它的主名断言（displayName 优先，退回 apiName/statement/text）
    有 evidence。这是 UI 上区别渲染用的同一条标准。
    """
    oir = oir or {}
    objects = oir.get("objects") or []
    stats = dict(oir.get("stats") or {})

    def primary(entity: dict[str, Any]) -> Any:
        for k in ("displayName", "apiName", "statement", "text"):
            if k in entity:
                return entity[k]
        return None

    by_ext: dict[str, int] = {}
    for bucket in ("objects", "properties", "links", "actions", "rules", "questions"):
        for e in (oir.get(bucket) or []):
            for ext in _extractors(primary(e)):
                by_ext[ext] = by_ext.get(ext, 0) + 1

    grounded_objects = sum(1 for o in objects if _grounded(primary(o)))
    out = {
        "objects": len(objects),
        "properties": len(oir.get("properties") or []),
        "links": len(oir.get("links") or []),
        "actions": len(oir.get("actions") or []),
        "rules": len(oir.get("rules") or []),
        "questions": len(oir.get("questions") or []),
        "open_questions": int(stats.get("open_questions") or 0),
        "confirmed": int(stats.get("confirmed") or 0),
        "grounded_objects": grounded_objects,
        "inferred_objects": len(objects) - grounded_objects,
        "by_extractor": by_ext,
    }
    return out


# ══════════════════════════════════════════════════════════════════
#  版本戳 + 清单
# ══════════════════════════════════════════════════════════════════
def bundle_id(files: list[dict[str, Any]], product_version: str) -> str:
    """内容寻址的版本戳：对（路径, 文件 sha256）排序后连同产品版本号取 sha256[:12]。

    只有产物字节变了它才变 —— 同样的产物打两次包，bundle_id 相同（可复现）；
    时间戳（generated_at）单独存，不进这个哈希。
    """
    payload = "\n".join(f"{f['path']}:{f.get('sha256', '')}"
                        for f in sorted(files, key=lambda x: x["path"]))
    return sha256_hex(f"{product_version}\n{payload}")[:12]


def build_manifest(*, session: dict[str, Any], product_version: str,
                   files: list[dict[str, Any]], materials: list[dict[str, Any]],
                   flow: dict[str, Any] | None, oir: dict[str, Any] | None,
                   open_questions: list[dict[str, Any]],
                   generated_at: float, generated_at_iso: str = "") -> dict[str, Any]:
    """组装 manifest.json。有据 vs 推断在三个层级都露出来：每文件 provenance、
    provenance_summary 汇总、以及 notes 里的提醒。"""
    return {
        "schema": BUNDLE_SCHEMA,
        "product_version": product_version,
        "bundle_id": bundle_id(files, product_version),
        "generated_at": round(generated_at, 3),
        "generated_at_iso": generated_at_iso,
        "session": session,
        "materials": materials,
        "files": files,
        "provenance_summary": {
            "flow": flow_provenance(flow),
            "oir": oir_provenance(oir),
        },
        "open_questions": open_questions,
        "notes": "灰色/虚线元素为系统推断（材料中无直接依据），交付前请与业务方确认。"
                 "人工口述/人工编辑的内容标记为 human 来源，同样不是材料证据。",
    }


def readme_text(manifest: dict[str, Any]) -> str:
    """一份人可读的中文交付说明，进包顶层。让接包的人不打开 manifest 也能看懂。"""
    m = manifest
    sess = m.get("session") or {}
    fp = m["provenance_summary"]["flow"]
    op = m["provenance_summary"]["oir"]
    lines = [
        f"# 交付包 · {sess.get('project') or sess.get('title') or sess.get('id', '')}",
        "",
        f"- 产品版本：{m['product_version']}",
        f"- 包版本戳（bundle_id）：{m['bundle_id']}",
        f"- 生成时间：{m.get('generated_at_iso') or m.get('generated_at')}",
        f"- 会话：{sess.get('id', '')}（{sess.get('status', '')}）",
        "",
        "## 产物清单",
    ]
    for f in m.get("files") or []:
        tag = {"grounded": "有据", "inferred": "推断",
               "mixed": "有据+推断", "n/a": "—"}.get(f.get("provenance", "n/a"), "—")
        lines.append(f"- `{f['path']}` · {f.get('title', '')}（{tag}，{f.get('size', 0)} 字节）")
    if m.get("materials"):
        lines += ["", "## 原始材料（输入）"]
        lines += [f"- `materials/{x['name']}`（{x.get('size', 0)} 字节）"
                  for x in m["materials"]]
    lines += [
        "",
        "## 溯源概览",
        f"- 流程图：{fp['nodes']} 节点（{fp['grounded_nodes']} 有据 / "
        f"{fp['inferred_nodes']} 推断），{fp['edges']} 条边（{fp['inferred_edges']} 推断），"
        f"人工修改 {fp['human_edited']} 处，死路 {fp['dead_ends']}。",
        f"- 本体：{op['objects']} 对象（{op['grounded_objects']} 有据 / "
        f"{op['inferred_objects']} 推断）、{op['properties']} 属性、{op['links']} 关系、"
        f"{op['rules']} 规则，待澄清 {op['open_questions']} 条。",
    ]
    if m.get("open_questions"):
        lines += ["", "## 待澄清（交付前建议先问业务方）"]
        lines += [f"- {q.get('q') or q.get('text', '')}" for q in m["open_questions"][:20]]
    lines += ["", "---", m.get("notes", "")]
    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════
#  打包
# ══════════════════════════════════════════════════════════════════
def build_zip(entries: list[tuple[str, bytes]], manifest: dict[str, Any],
              readme: str) -> bytes:
    """把 (arcname, bytes) 列表 + manifest.json + 交付说明.md 打成内存 zip，返回字节。

    内存打包（BytesIO）：会话产物体量小，不落临时文件，也贴合离线/零依赖的取向。
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for arcname, data in entries:
            z.writestr(arcname, data)
        z.writestr("manifest.json",
                   json.dumps(manifest, ensure_ascii=False, indent=2))
        z.writestr("交付说明.md", readme)
    return buf.getvalue()
