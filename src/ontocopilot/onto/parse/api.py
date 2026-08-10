"""OpenAPI / JSON Schema 解析。

对本体建模有两个用途：

* **schemas → 对象与属性候选**。``components.schemas`` 是别人已经做过一遍的
  建模，白拿。
* **写操作端点 → ActionType 草稿**。这是产品的杀手锏：没人填 ActionType 时，
  从 ``POST/PUT/PATCH/DELETE`` 反推草稿让业务确认，比让他们从零写完成率高得多。

GET 端点不进 ActionType —— 读操作不改变世界状态，不是 Action。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .base import Finding, ParsedDoc, Parser, make_chunk

WRITE_METHODS = ("post", "put", "patch", "delete")

#: JSON Schema 类型 → OIR BaseType。
TYPE_MAP = {
    ("string", None): "STRING", ("string", "date"): "DATE",
    ("string", "date-time"): "TIMESTAMP", ("string", "uuid"): "STRING",
    ("integer", None): "INTEGER", ("number", None): "DECIMAL",
    ("boolean", None): "BOOLEAN",
}


class OpenApiParser(Parser):
    kind = "openapi"
    extensions = (".json", ".yaml", ".yml")

    def parse(self, path: Path, *, file_id: str) -> ParsedDoc:
        doc = ParsedDoc(file_id=file_id, file_name=path.name, kind=self.kind)
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            spec = json.loads(text)
        except json.JSONDecodeError as exc:
            try:
                import yaml  # 可选依赖：yaml 版 spec 很常见

                spec = yaml.safe_load(text)
            except Exception:
                doc.findings.append(Finding(
                    "parse_failed", f"既不是合法 JSON 也读不成 YAML：{exc}", {},
                    severity="warn"))
                return doc

        if not isinstance(spec, dict):
            doc.findings.append(Finding("parse_failed", "顶层不是对象", {}, severity="warn"))
            return doc
        if "paths" not in spec and "components" not in spec:
            doc.kind = "json"
            return _plain_json(doc, spec, file_id, path)

        endpoints = _endpoints(spec, file_id, path.name)
        schemas = _schemas(spec)
        doc.structured = {"endpoints": endpoints, "schemas": schemas,
                          "title": (spec.get("info") or {}).get("title", "")}

        order = 0
        for e in endpoints:
            tag = "写操作，可反推 ActionType" if e["write"] else "读操作"
            doc.chunks.append(make_chunk(
                doc_id=f"ep{order}", file_id=file_id, file_name=path.name,
                locator={"kind": "json", "pointer": e["pointer"]},
                render=f"{e['method'].upper()} {e['path']}  operationId={e['operationId']}"
                       f"　〔{tag}〕" + (f" {e['summary']}" if e["summary"] else ""),
                raw=e, order=order, tags=["endpoint", "write" if e["write"] else "read"]))
            order += 1
            # 端点→请求体 schema 是一条关系，像 DDL 外键那样单独成一等切片
            if e.get("request_schema"):
                doc.chunks.append(make_chunk(
                    doc_id=f"eplink{order}", file_id=file_id, file_name=path.name,
                    locator={"kind": "json", "pointer": e["pointer"]},
                    render=f"{e['operationId']} → {e['request_schema']}"
                           "（请求体，引用该 schema）",
                    raw={"from": e["operationId"], "to": e["request_schema"]},
                    order=order, tags=["link", "relation"]))
                order += 1

        for name, s in schemas.items():
            props = "、".join(_prop_str(p, d) for p, d in s["properties"].items())
            doc.chunks.append(make_chunk(
                doc_id=f"schema:{name}", file_id=file_id, file_name=path.name,
                locator={"kind": "json", "pointer": f"$.components.schemas.{name}"},
                render=f"schema {name}：{props}"
                       + (f"　{s['description']}" if s["description"] else ""),
                raw=s, order=order, tags=["schema"]))
            order += 1

        if not any(e["write"] for e in endpoints):
            doc.findings.append(Finding(
                "no_write_endpoints",
                "spec 里没有写操作端点，无法反推 ActionType 草稿", {}))
        return doc


def _prop_str(p: str, d: dict[str, Any]) -> str:
    """property → 一段可检索文本：类型 + 必填 + 取值域 + 口径说明。

    description 常常就是口径（"含税、年度累计"），enum 是取值域 —— 只放进 raw 而不
    进 render，检索时就看不见。
    """
    s = f"{p}:{d['base_type']}" + ("*" if d["required"] else "")
    if d.get("enum"):
        s += "[" + "|".join(str(x) for x in d["enum"]) + "]"
    if d.get("description"):
        s += f"（{d['description']}）"
    return s


def _endpoints(spec: dict, file_id: str, file_name: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path, ops in (spec.get("paths") or {}).items():
        if not isinstance(ops, dict):
            continue
        for method, op in ops.items():
            m = method.lower()
            if m not in ("get", *WRITE_METHODS) or not isinstance(op, dict):
                continue
            out.append({
                "operationId": op.get("operationId") or _synth_id(m, path),
                "method": m, "path": path, "write": m in WRITE_METHODS,
                "summary": (op.get("summary") or op.get("description") or "")[:120],
                "tags": op.get("tags", []),
                "request_schema": _ref_name(op.get("requestBody")),
                "file_id": file_id, "file_name": file_name,
                "pointer": f"$.paths.{path}.{m}",
            })
    return out


def _schemas(spec: dict) -> dict[str, dict[str, Any]]:
    raw = ((spec.get("components") or {}).get("schemas")
           or spec.get("definitions") or {})
    out: dict[str, dict[str, Any]] = {}
    for name, s in raw.items():
        if not isinstance(s, dict) or s.get("type") not in (None, "object"):
            continue
        required = set(s.get("required") or ())
        props: dict[str, Any] = {}
        for pname, p in (s.get("properties") or {}).items():
            if not isinstance(p, dict):
                continue
            props[pname] = {
                "base_type": TYPE_MAP.get((p.get("type"), p.get("format")))
                or TYPE_MAP.get((p.get("type"), None), "STRING"),
                "required": pname in required,
                # OpenAPI 的 description 常常就是口径说明，必须带出来
                "description": p.get("description", ""),
                "enum": p.get("enum"),
                "format": p.get("format"),
            }
        out[name] = {"name": name, "description": s.get("description", ""),
                     "properties": props}
    return out


def _ref_name(body: Any) -> str | None:
    if not isinstance(body, dict):
        return None
    for media in (body.get("content") or {}).values():
        ref = ((media or {}).get("schema") or {}).get("$ref")
        if isinstance(ref, str):
            return ref.rsplit("/", 1)[-1]
    return None


def _synth_id(method: str, path: str) -> str:
    parts = [p for p in path.strip("/").split("/") if p and not p.startswith("{")]
    tail = "".join(p[:1].upper() + p[1:] for p in parts)
    return f"{method}{tail}" or method


def _plain_json(doc: ParsedDoc, obj: Any, file_id: str, path: Path) -> ParsedDoc:
    """不是 OpenAPI 的普通 JSON：按顶层键切片，保留 JSON Pointer。"""
    items = obj.items() if isinstance(obj, dict) else enumerate(obj)
    for i, (k, v) in enumerate(items):
        doc.chunks.append(make_chunk(
            doc_id=f"k{i}", file_id=file_id, file_name=path.name,
            locator={"kind": "json", "pointer": f"$.{k}"},
            render=f"{k}: {json.dumps(v, ensure_ascii=False)[:600]}",
            raw=v, order=i, tags=["json"]))
    doc.structured = {"keys": list(obj) if isinstance(obj, dict) else len(obj)}
    return doc
