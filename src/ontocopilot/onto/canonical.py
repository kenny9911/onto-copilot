"""Canonical OntologyPackage v1.

This module is the compatibility boundary between the legacy :mod:`oir` /
:mod:`flow` views and the versioned business IR consumed by FDE artifacts.
It deliberately has no server dependency: a package can be built, validated,
serialized and replayed in batch jobs as well as in the interactive product.

The legacy models remain authoritative inputs during migration.  Conversion
never mutates them and never emits a dangling canonical reference: unresolved
legacy references are retained as validation warnings instead.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from ..kernel.ids import canonical_json, sha256_hex, slug
from .flow import FlowGraph
from .oir import OIR

SCHEMA_VERSION = "1.0.0"
SCHEMA_URL = "https://schemas.ontocopilot.dev/ontology-package/v1.schema.json"

COLLECTIONS = (
    "processes",
    "dataObjects",
    "actions",
    "events",
    "rules",
    "roles",
    "systems",
    "questions",
    "decisions",
    "evidence",
)

ONTOLOGY_PACKAGE_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": SCHEMA_URL,
    "title": "OntoCopilot OntologyPackage v1",
    "type": "object",
    "required": [
        "$schema", "schemaVersion", "packageId", "revision", "generatedAt",
        *COLLECTIONS, "validation",
    ],
    "properties": {
        "$schema": {"const": SCHEMA_URL},
        "schemaVersion": {"const": SCHEMA_VERSION},
        "packageId": {"type": "string", "pattern": "^pkg\\."},
        "revision": {"type": "integer", "minimum": 1},
        "baseRevision": {"type": ["integer", "null"], "minimum": 1},
        "generatedAt": {"type": "string", "format": "date-time"},
        **{name: {"type": "array", "items": {"type": "object"}}
           for name in COLLECTIONS},
        "validation": {"type": "object"},
    },
    "additionalProperties": False,
}


@dataclass(frozen=True, slots=True)
class ValidationFinding:
    """A machine-readable package validation finding."""

    code: str
    message: str
    path: str = ""
    severity: str = "error"
    ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity,
            "path": self.path,
            "message": self.message,
        }
        if self.ref is not None:
            out["ref"] = self.ref
        return out


@dataclass(slots=True)
class ValidationReport:
    """Result of schema-shape and referential-integrity validation."""

    findings: list[ValidationFinding] = field(default_factory=list)
    validators: list[str] = field(default_factory=lambda: [
        "schema-shape", "global-id-uniqueness", "reference-integrity",
    ])

    @property
    def passed(self) -> bool:
        return not any(f.severity == "error" for f in self.findings)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": "passed" if self.passed else "failed",
            "validators": list(self.validators),
            "findings": [f.to_dict() for f in self.findings],
        }


@dataclass(slots=True)
class OntologyPackage:
    """In-memory representation of the stable OntologyPackage v1 contract."""

    package_id: str
    revision: int = 1
    base_revision: int | None = None
    generated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    processes: list[dict[str, Any]] = field(default_factory=list)
    data_objects: list[dict[str, Any]] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    rules: list[dict[str, Any]] = field(default_factory=list)
    roles: list[dict[str, Any]] = field(default_factory=list)
    systems: list[dict[str, Any]] = field(default_factory=list)
    questions: list[dict[str, Any]] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    validation: ValidationReport = field(default_factory=ValidationReport)

    @property
    def schema_version(self) -> str:
        return SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": SCHEMA_URL,
            "schemaVersion": SCHEMA_VERSION,
            "packageId": self.package_id,
            "revision": self.revision,
            "baseRevision": self.base_revision,
            "generatedAt": self.generated_at,
            "processes": deepcopy(self.processes),
            "dataObjects": deepcopy(self.data_objects),
            "actions": deepcopy(self.actions),
            "events": deepcopy(self.events),
            "rules": deepcopy(self.rules),
            "roles": deepcopy(self.roles),
            "systems": deepcopy(self.systems),
            "questions": deepcopy(self.questions),
            "decisions": deepcopy(self.decisions),
            "evidence": deepcopy(self.evidence),
            "validation": self.validation.to_dict(),
        }

    def to_json(self, *, indent: int | None = 2) -> str:
        """Serialize without ASCII escaping so Chinese business terms survive."""
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent)


def package_from_dict(data: Mapping[str, Any]) -> OntologyPackage:
    """Load a package without silently migrating an unsupported schema version."""
    version = str(data.get("schemaVersion") or "")
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported OntologyPackage schemaVersion: {version!r}")
    package = OntologyPackage(
        package_id=str(data.get("packageId") or ""),
        revision=int(data.get("revision") or 0),
        base_revision=(int(data["baseRevision"])
                       if data.get("baseRevision") is not None else None),
        generated_at=str(data.get("generatedAt") or ""),
        processes=deepcopy(list(data.get("processes") or [])),
        data_objects=deepcopy(list(data.get("dataObjects") or [])),
        actions=deepcopy(list(data.get("actions") or [])),
        events=deepcopy(list(data.get("events") or [])),
        rules=deepcopy(list(data.get("rules") or [])),
        roles=deepcopy(list(data.get("roles") or [])),
        systems=deepcopy(list(data.get("systems") or [])),
        questions=deepcopy(list(data.get("questions") or [])),
        decisions=deepcopy(list(data.get("decisions") or [])),
        evidence=deepcopy(list(data.get("evidence") or [])),
    )
    package.validation = validate_package(package)
    return package


def export_package(package: OntologyPackage | Mapping[str, Any],
                   target: str | Path | TextIO, *, indent: int = 2) -> None:
    """Write a validated package JSON document to a path or text stream."""
    data = package.to_dict() if isinstance(package, OntologyPackage) else deepcopy(dict(package))
    report = validate_package(data)
    if not report.passed:
        errors = "; ".join(f.message for f in report.findings if f.severity == "error")
        raise ValueError(f"invalid OntologyPackage: {errors}")
    data["validation"] = report.to_dict()
    text = json.dumps(data, ensure_ascii=False, indent=indent) + "\n"
    if hasattr(target, "write"):
        target.write(text)  # type: ignore[union-attr]
    else:
        Path(target).write_text(text, encoding="utf-8")


def _raw(source: OIR | FlowGraph | Mapping[str, Any] | None) -> dict[str, Any]:
    if source is None:
        return {}
    if isinstance(source, Mapping):
        return deepcopy(dict(source))
    return source.to_dict()


def _value(value: Any, default: Any = "") -> Any:
    if isinstance(value, Mapping) and "value" in value:
        return value.get("value", default)
    return default if value is None else value


def _canonical_id(prefix: str, legacy_id: str, *legacy_prefixes: str) -> str:
    tail = str(legacy_id or "").strip()
    for old in legacy_prefixes:
        if tail.startswith(old):
            tail = tail[len(old):]
            break
    tail = slug(tail or prefix).replace("_", ".")
    return f"{prefix}.{tail}"


def _package_id(value: str) -> str:
    value = str(value or "default").strip()
    if value.startswith("pkg."):
        return value
    return f"pkg.{slug(value).replace('_', '.')}"


def _stable_input_id(prefix: str, value: Any, *legacy_prefixes: str) -> str:
    """Canonicalize a legacy ID while leaving an already canonical ID unchanged."""
    text = str(value or "").strip()
    return text if text.startswith(f"{prefix}.") else _canonical_id(
        prefix, text, *legacy_prefixes)


class _EvidenceIndex:
    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    def add(self, evidence: Mapping[str, Any]) -> str:
        stable = {
            "fileId": str(evidence.get("file_id") or evidence.get("fileId") or ""),
            "fileName": str(evidence.get("file_name") or evidence.get("fileName") or ""),
            "locator": deepcopy(dict(evidence.get("locator") or {})),
            "snippet": str(evidence.get("snippet") or "")[:300],
            "extractor": str(evidence.get("extractor") or "llm"),
            "confidence": round(float(evidence.get("confidence") or 0.5), 3),
        }
        stable["cite"] = str(evidence.get("cite") or "")
        eid = f"ev.{sha256_hex(canonical_json(stable))[:16]}"
        self.items.setdefault(eid, {"id": eid, **stable})
        return eid

    def reference(self, value: Any) -> str | None:
        """Turn a backlog evidence reference into a package-owned Evidence ID.

        Unified Questions intentionally store only evidence IDs.  During the migration
        window those IDs may be a canonical ``ev.*`` ID, a legacy cite string, or a full
        evidence object.  Canonical IDs are retained; legacy cites become deterministic
        placeholder Evidence records instead of dangling references.
        """
        if isinstance(value, Mapping):
            return self.add(value)
        text = str(value or "").strip()
        if not text:
            return None
        if text.startswith("ev."):
            self.items.setdefault(text, {
                "id": text, "fileId": "", "fileName": "", "locator": {},
                "snippet": "", "extractor": "question-backlog", "confidence": 0.5,
                "cite": text,
            })
            return text
        return self.add({"cite": text, "extractor": "question-backlog",
                         "confidence": 0.5})

    def assertion(self, *values: Any) -> dict[str, Any]:
        origins: list[str] = []
        confidence = 0.0
        evidence_ids: list[str] = []
        for value in values:
            if not isinstance(value, Mapping):
                continue
            origins.append(str(value.get("origin") or "inferred").upper())
            confidence = max(confidence, float(value.get("confidence") or 0.0))
            for evidence in value.get("evidence") or []:
                if isinstance(evidence, Mapping):
                    eid = self.add(evidence)
                    if eid not in evidence_ids:
                        evidence_ids.append(eid)
        rank = {"INFERRED": 0, "AUTO_REPAIRED": 1, "EXTRACTED": 2, "USER": 3}
        origin = max(origins or ["INFERRED"], key=lambda x: rank.get(x, 0))
        return {
            "origin": origin,
            "confidence": round(confidence or (0.4 if origin == "INFERRED" else 0.8), 3),
            "evidenceIds": evidence_ids,
        }


_MASTER_WORDS = ("供应商", "物料", "客户", "组织", "人员", "supplier", "material")
_REFERENCE_WORDS = ("字典", "类型", "分类", "配置", "代码", "枚举", "catalog", "code")
_DOCUMENT_WORDS = ("计划", "订单", "申请", "合同", "发票", "单据", "plan", "order", "invoice")
_MESSAGE_WORDS = ("消息", "事件报文", "通知", "message", "eventpayload", "notification")


def _data_kind(name: str) -> tuple[str, float]:
    lowered = name.lower()
    if any(word in lowered for word in _MESSAGE_WORDS):
        return "message", 0.8
    if any(word in lowered for word in _MASTER_WORDS):
        return "master", 0.7
    if any(word in lowered for word in _REFERENCE_WORDS):
        return "reference", 0.7
    if any(word in lowered for word in _DOCUMENT_WORDS):
        return "document", 0.65
    return "transaction", 0.25


def _normalise_decision(raw: Any, index: int, question_ids: dict[str, str]) -> dict[str, Any]:
    data = raw if isinstance(raw, Mapping) else (
        raw.to_dict() if hasattr(raw, "to_dict") else vars(raw)
    )
    legacy_id = str(data.get("id") or data.get("key") or f"decision-{index}")
    refs = list(data.get("affectedIds") or data.get("affected_ids")
                or data.get("scope_refs") or [])
    question = str(data.get("questionId") or data.get("question_id") or "")
    if not question:
        question = next((question_ids[r] for r in refs if r in question_ids), "")
    answer = data.get("answer", data.get("statement"))
    out = {
        "id": _stable_input_id("dec", legacy_id, "dec_", "dlg_"),
        "questionId": question_ids.get(question, question) or None,
        "answer": answer,
        "kind": str(data.get("kind") or "answer"),
        "actor": data.get("actor"),
        "actorRole": data.get("actorRole", data.get("actor_role")),
        "authority": data.get("authority"),
        "sourceTurn": data.get("sourceTurn", data.get("source_turn", data.get("turn"))),
        "effectiveAt": data.get("effectiveAt", data.get("createdAt", data.get("ts"))),
        "supersedes": data.get("supersedes"),
        "affectedIds": refs,
        "revision": data.get("revision"),
        "legacyId": legacy_id,
    }
    return out


def _question_input(source: Any) -> list[dict[str, Any]]:
    """Accept QuestionBacklog, its JSON form, a single Question, or an iterable.

    Keeping this adapter structural avoids a dependency from the canonical IR back to
    the question-domain implementation and lets persisted older payloads build too.
    """
    if source is None:
        return []
    if hasattr(source, "to_dict"):
        source = source.to_dict()
    if isinstance(source, Mapping):
        if "questions" in source:
            source = source.get("questions") or []
        elif "id" in source or "rid" in source:
            source = [source]
        else:
            source = list(source.values())
    if isinstance(source, (str, bytes)):
        raise TypeError("questions/backlog must not be a string")
    out: list[dict[str, Any]] = []
    for item in source:
        if hasattr(item, "to_dict"):
            item = item.to_dict()
        if not isinstance(item, Mapping):
            raise TypeError(f"question must be an object, got {type(item).__name__}")
        out.append(deepcopy(dict(item)))
    return out


def build_package(oir: OIR | Mapping[str, Any],
                  flow: FlowGraph | Mapping[str, Any] | None = None, *,
                  package_id: str = "pkg.default", revision: int = 1,
                  base_revision: int | None = None, generated_at: str | None = None,
                  decisions: Iterable[Any] = (), questions: Any | None = None,
                  backlog: Any | None = None) -> OntologyPackage:
    """Build OntologyPackage v1 from current OIR and FlowGraph representations.

    Both live objects and their existing ``to_dict()`` payloads are accepted.
    ``questions`` and its ``backlog`` alias accept the unified QuestionBacklog (or its
    persisted JSON).  When supplied it overrides the lifecycle fields of matching OIR
    OpenQuestions and adds conflict/manual questions that OIR cannot represent.
    Stable canonical IDs are derived from legacy RIDs and every canonical item
    carries ``legacyId`` during the migration window.
    """
    if revision < 1:
        raise ValueError("revision must be >= 1")
    if base_revision is not None and base_revision >= revision:
        raise ValueError("base_revision must be lower than revision")

    oir_data, flow_data = _raw(oir), _raw(flow)
    evidence = _EvidenceIndex()
    package = OntologyPackage(
        package_id=_package_id(package_id), revision=revision,
        base_revision=base_revision,
        generated_at=generated_at or datetime.now(UTC).isoformat(),
    )

    object_ids = {
        str(item.get("rid")): _canonical_id("do", str(item.get("rid")), "ot_")
        for item in oir_data.get("objects") or []
    }
    property_by_id = {
        str(item.get("rid")): item for item in oir_data.get("properties") or []
    }
    relation_by_source: dict[str, list[dict[str, Any]]] = {}
    for link in oir_data.get("links") or []:
        source = str(link.get("from") or "")
        target = str(link.get("to") or "")
        if source not in object_ids or target not in object_ids:
            continue
        relation_by_source.setdefault(source, []).append({
            "id": _canonical_id("rel", str(link.get("rid")), "lt_"),
            "name": str(_value(link.get("apiName"))),
            "target": object_ids[target],
            "cardinality": str(_value(link.get("cardinality"))),
            "joinKey": _value(link.get("joinKey"), None),
            "legacyId": str(link.get("rid") or ""),
        })

    for item in oir_data.get("objects") or []:
        legacy_id = str(item.get("rid") or "")
        name = str(_value(item.get("displayName")) or _value(item.get("apiName")))
        kind, kind_confidence = _data_kind(name)
        attributes = []
        for prop_id in item.get("properties") or []:
            prop = property_by_id.get(str(prop_id))
            if not prop:
                continue
            attributes.append({
                "id": _canonical_id("attr", str(prop.get("rid")), "pt_"),
                "apiName": str(_value(prop.get("apiName"))),
                "displayName": str(_value(prop.get("displayName"))),
                "type": str(_value(prop.get("baseType"))),
                "definition": str(_value(prop.get("definition"))),
                "semanticType": _value(prop.get("semanticType"), None),
                "unit": _value(prop.get("unit"), None),
                "required": bool(_value(prop.get("required"), False)),
                "valueDomain": _value(prop.get("valueDomain"), None),
                "assertion": evidence.assertion(
                    prop.get("apiName"), prop.get("displayName"), prop.get("definition")),
                "legacyId": str(prop.get("rid") or ""),
            })
        keys = [
            _canonical_id("attr", str(key), "pt_")
            for key in (_value(item.get("primaryKey"), []) or [])
            if str(key) in property_by_id
        ]
        package.data_objects.append({
            "id": object_ids[legacy_id],
            "kind": kind,
            "classificationConfidence": kind_confidence,
            "apiName": str(_value(item.get("apiName"))),
            "displayName": name,
            "description": str(_value(item.get("description"))),
            "identity": {"keys": keys},
            "systemOfRecord": None,
            "ownerRole": None,
            "lifecycleStates": [],
            "attributes": attributes,
            "relations": relation_by_source.get(legacy_id, []),
            "sensitivity": "internal",
            "assertion": evidence.assertion(item.get("apiName"), item.get("displayName")),
            "status": str(item.get("status") or "candidate"),
            "legacyId": legacy_id,
        })

    role_ids: dict[str, str] = {}
    system_ids: dict[str, str] = {}

    def role_for(name: Any) -> str | None:
        text = str(_value(name) or "").strip()
        if not text:
            return None
        if text.startswith("role."):
            role_ids.setdefault(text.removeprefix("role."), text)
            return text
        rid = _canonical_id("role", text)
        role_ids.setdefault(text, rid)
        return rid

    def system_for(endpoint: str) -> str | None:
        text = str(endpoint or "").strip()
        if not text:
            return None
        identity = text.split("//", 1)[-1].split("/", 1)[0] or text
        rid = _canonical_id("sys", identity)
        system_ids.setdefault(identity, rid)
        return rid

    action_ids: dict[str, str] = {}
    for item in oir_data.get("actions") or []:
        legacy_id = str(item.get("rid") or "")
        action_id = _canonical_id("act", legacy_id, "at_")
        action_ids[legacy_id] = action_id
        source_endpoint = _value(item.get("sourceEndpoint"), None) or {}
        endpoint = str(source_endpoint.get("path") or source_endpoint.get("url") or "") \
            if isinstance(source_endpoint, Mapping) else ""
        related = [object_ids[r] for r in item.get("appliesTo") or [] if r in object_ids]
        package.actions.append({
            "id": action_id,
            "name": str(_value(item.get("apiName"))),
            "actorRole": None,
            "system": system_for(endpoint),
            "inputs": [],
            "outputs": [],
            "relatedDataObjects": related,
            "parameters": _value(item.get("parameters"), []) or [],
            "preconditions": [],
            "effects": _value(item.get("effects"), []) or [],
            "emits": [],
            "compensationAction": None,
            "idempotency": None,
            "sourceProcessNodes": [],
            "sourceEndpoint": source_endpoint or None,
            "assertion": evidence.assertion(item.get("apiName"), item.get("effects")),
            "status": str(item.get("status") or "candidate"),
            "legacyId": legacy_id,
        })

    rule_ids: dict[str, str] = {}
    for item in oir_data.get("rules") or []:
        legacy_id = str(item.get("rid") or "")
        rule_id = _canonical_id("rule", legacy_id, "br_", "rule_")
        rule_ids[legacy_id] = rule_id
        actor_role = role_for(item.get("actor"))
        scope = [object_ids[r] for r in item.get("appliesTo") or [] if r in object_ids]
        package.rules.append({
            "id": rule_id,
            "rawStatement": str(_value(item.get("statement"))),
            "ruleKind": str(_value(item.get("ruleKind")) or "OTHER"),
            "scope": scope,
            "trigger": None,
            "normalizedExpression": None,
            "outcome": {"requiredRole": actor_role} if actor_role else {},
            "exceptions": [],
            "effectivePeriod": {"from": None, "to": None},
            "compileStatus": "uncompiled",
            "assertion": evidence.assertion(item.get("statement"), item.get("ruleKind")),
            "status": str(item.get("status") or "candidate"),
            "legacyId": legacy_id,
        })

    if questions is not None and backlog is not None:
        raise ValueError("pass either questions or backlog, not both")
    supplied_questions = _question_input(
        questions if questions is not None else backlog) if (
            questions is not None or backlog is not None) else []

    question_ids: dict[str, str] = {}
    answered: list[tuple[str, Mapping[str, Any]]] = []
    legacy_questions = list(oir_data.get("questions") or [])
    # The unified backlog is authoritative for lifecycle/routing fields.  Preserve OIR
    # assertions only for questions not represented there, and merge matching legacy
    # answers/evidence into the backlog row without producing duplicate Question IDs.
    by_id: dict[str, dict[str, Any]] = {}
    for item in legacy_questions:
        legacy_id = str(item.get("rid") or item.get("id") or "")
        by_id[legacy_id] = deepcopy(dict(item))
    for item in supplied_questions:
        legacy_id = str(item.get("id") or item.get("rid") or "")
        source_ref = str(item.get("sourceRef") or item.get("source_ref") or "")
        prior_key = (legacy_id if legacy_id in by_id else
                     source_ref if source_ref in by_id else "")
        prior = by_id.get(prior_key) or {}
        merged = {**prior, **item}
        # Backlog has no answer field by design; retain a legacy OIR answer when it is
        # the only decision source, while explicit Decisions remain authoritative.
        if item.get("answer") is None and prior.get("answer") is not None:
            merged["answer"] = prior["answer"]
        key = legacy_id or source_ref
        if prior_key and prior_key != key:
            by_id.pop(prior_key, None)
        by_id[key] = merged

    question_rows = list(by_id.values())
    # Resolve every alias before converting dependency references, including forward
    # dependencies to a Question that appears later in the backlog.
    for index, item in enumerate(question_rows, 1):
        legacy_id = str(item.get("id") or item.get("rid") or "")
        source_ref = str(item.get("sourceRef") or item.get("source_ref") or "")
        legacy_id = legacy_id or source_ref or f"question-{index}"
        canonical_id = _stable_input_id("q", legacy_id, "oq_", "q_")
        question_ids[legacy_id] = canonical_id
        if source_ref:
            question_ids[source_ref] = canonical_id

    for item in question_rows:
        legacy_id = str(item.get("id") or item.get("rid") or "")
        source_ref = str(item.get("sourceRef") or item.get("source_ref") or "")
        if not legacy_id:
            legacy_id = source_ref or f"question-{len(question_ids) + 1}"
        question_id = question_ids[legacy_id]
        answer = str(_value(item.get("answer")) or "")
        raw_blocked = (item.get("blockedArtifacts") or item.get("blocked_artifacts")
                       or item.get("appliesTo") or [])
        applies = [object_ids.get(r, action_ids.get(r, rule_ids.get(r, r)))
                   for r in raw_blocked]
        known_semantics = (set(object_ids.values()) | set(action_ids.values())
                           | set(rule_ids.values()))
        # ``blockedArtifacts`` may include artifact-lineage IDs that are not semantic
        # entities. Keep already-canonical package references; legacy unknowns cannot be
        # validated in OntologyPackage v1 and are omitted instead of emitted dangling.
        applies = [r for r in applies if r in known_semantics]
        raw_evidence = item.get("evidenceIds") or item.get("evidence_ids") or []
        evidence_ids = [eid for value in raw_evidence
                        if (eid := evidence.reference(value)) is not None]
        if not evidence_ids:
            evidence_ids = evidence.assertion(item.get("text"))["evidenceIds"]
        raw_dependencies = list(item.get("dependencies") or [])
        audience = (item.get("audienceRole") or item.get("audience_role")
                    or "")
        package.questions.append({
            "id": question_id,
            "gapId": item.get("gapId") or item.get("gap_id"),
            "code": str(item.get("code") or ""),
            "text": str(_value(item.get("text"))),
            "audienceRole": role_for(audience),
            "ownerUserId": (item.get("ownerUserId") or item.get("owner_user_id")
                            or item.get("owner")),
            "answerSchema": deepcopy(dict(
                item.get("answerSchema") or item.get("answer_schema") or (
                    {"type": "string", "enum": list(item.get("options") or [])}
                    if item.get("options") else {"type": "string"}))),
            "why": str(item.get("why") or item.get("group") or ""),
            "evidenceIds": evidence_ids,
            "blockedArtifacts": applies,
            # Canonical IDs are resolved after all questions are enumerated below.
            "dependencies": raw_dependencies,
            "informationGain": item.get("informationGain", item.get("information_gain")),
            "blastRadius": int(item.get("blastRadius", item.get("blast_radius"))
                               or len(applies)),
            "priority": str(item.get("priority") or "normal").lower(),
            "status": ("answered" if answer and not supplied_questions else
                       str(item.get("status") or "open").lower().removeprefix("status.")),
            "askedBy": str(item.get("askedBy") or item.get("sourceKind") or "customer"),
            "sourceKind": str(item.get("sourceKind") or item.get("source_kind") or ""),
            "sourceRef": source_ref or None,
            "version": int(item.get("version") or 0),
            "legacyId": legacy_id,
        })
        if answer:
            answered.append((question_id, item))

    for item in package.questions:
        item["dependencies"] = [question_ids.get(str(ref), str(ref))
                                for ref in item["dependencies"]]

    flow_nodes = list(flow_data.get("nodes") or [])
    process_node_ids = {
        str(node.get("rid")): _canonical_id("pn", str(node.get("rid")), "fn_")
        for node in flow_nodes
    }
    event_ids: dict[str, str] = {}
    action_by_id = {item["id"]: item for item in package.actions}
    process_nodes: list[dict[str, Any]] = []
    for node in flow_nodes:
        legacy_id = str(node.get("rid") or "")
        kind = str(node.get("kind") or "").lower()
        label = str(_value(node.get("label")))
        objects = [object_ids[r] for r in node.get("objects") or [] if r in object_ids]
        semantic_ref: str | None = None
        if kind == "action":
            semantic_ref = action_ids.get(legacy_id)
            if semantic_ref is None:
                candidate = _canonical_id("act", legacy_id, "fn_", "at_")
                # OIR and Flow may use different legacy prefixes for the same stable
                # business action.  Reuse an already-created canonical action instead
                # of creating a duplicate ID that would make the package invalid.
                if candidate in action_by_id:
                    semantic_ref = candidate
                    action_ids[legacy_id] = semantic_ref
                    sources = action_by_id[semantic_ref]["sourceProcessNodes"]
                    if process_node_ids[legacy_id] not in sources:
                        sources.append(process_node_ids[legacy_id])
                    related = action_by_id[semantic_ref]["relatedDataObjects"]
                    related.extend(ref for ref in objects if ref not in related)
                else:
                    semantic_ref = candidate
                    action_ids[legacy_id] = semantic_ref
                    package.actions.append({
                        "id": semantic_ref,
                        "name": label,
                        "actorRole": role_for(node.get("actor")),
                        "system": system_for(str(node.get("endpoint") or "")),
                        "inputs": [], "outputs": [], "relatedDataObjects": objects,
                        "parameters": [], "preconditions": [], "effects": [], "emits": [],
                        "compensationAction": None, "idempotency": None,
                        "sourceProcessNodes": [process_node_ids[legacy_id]],
                        "sourceEndpoint": node.get("endpoint") or None,
                        "assertion": evidence.assertion(node.get("label"), node.get("actor")),
                        "status": str(node.get("status") or "candidate"),
                        "legacyId": legacy_id,
                    })
                    action_by_id[semantic_ref] = package.actions[-1]
            else:
                action_by_id[semantic_ref]["sourceProcessNodes"].append(
                    process_node_ids[legacy_id])
        elif kind == "event":
            semantic_ref = _canonical_id("evt", legacy_id, "fn_", "evt_")
            event_ids[legacy_id] = semantic_ref
            package.events.append({
                "id": semantic_ref,
                "name": label,
                "producerAction": None,
                "producerSystem": system_for(str(node.get("endpoint") or "")),
                "payload": {"dataObject": objects[0], "schemaRef": None} if objects else None,
                "resultingState": None,
                "consumers": [],
                "delivery": None,
                "sourceProcessNodes": [process_node_ids[legacy_id]],
                "assertion": evidence.assertion(node.get("label")),
                "status": str(node.get("status") or "candidate"),
                "legacyId": legacy_id,
            })
        process_nodes.append({
            "id": process_node_ids[legacy_id],
            "kind": kind.upper(),
            "name": label,
            "code": str(node.get("code") or ""),
            "stageId": (_canonical_id("stage", str(node.get("stage")))
                        if node.get("stage") else None),
            "semanticRef": semantic_ref,
            "dataObjectRefs": objects,
            "actorRole": role_for(node.get("actor")),
            "assertion": evidence.assertion(node.get("label"), node.get("actor")),
            "legacyId": legacy_id,
        })

    process_edges = []
    for edge in flow_data.get("edges") or []:
        source, target = str(edge.get("from") or ""), str(edge.get("to") or "")
        if source not in process_node_ids or target not in process_node_ids:
            continue
        process_edges.append({
            "id": _canonical_id("pe", str(edge.get("rid")), "fe_"),
            "from": process_node_ids[source],
            "to": process_node_ids[target],
            "kind": str(edge.get("kind") or "flow"),
            "condition": str(edge.get("label") or "") or None,
            "evidenceIds": [evidence.add(e) for e in edge.get("evidence") or []
                            if isinstance(e, Mapping)],
            "legacyId": str(edge.get("rid") or ""),
        })

    if process_nodes:
        incoming = {edge["to"] for edge in process_edges}
        outgoing = {edge["from"] for edge in process_edges}
        workflow_names = [str(w.get("title") or "")
                          for w in flow_data.get("workflows") or []]
        package.processes.append({
            "id": _canonical_id("proc", package.package_id, "pkg."),
            "name": " / ".join(name for name in workflow_names if name) or package.package_id,
            "description": "",
            "stages": [{
                "id": _canonical_id("stage", str(stage.get("key") or "stage")),
                "name": str(stage.get("title") or ""),
                "description": str(stage.get("subtitle") or ""),
                "order": int(stage.get("order") or 0),
                "legacyId": str(stage.get("key") or ""),
            } for stage in flow_data.get("stages") or []],
            "nodes": process_nodes,
            "edges": process_edges,
            "entryNodeIds": [n["id"] for n in process_nodes if n["id"] not in incoming],
            "exitNodeIds": [n["id"] for n in process_nodes if n["id"] not in outgoing],
            "workflows": deepcopy(list(flow_data.get("workflows") or [])),
        })

    # Derive producer/consumer links only from explicit flow adjacency.
    event_by_legacy = {item["legacyId"]: item for item in package.events}
    for edge in flow_data.get("edges") or []:
        source, target = str(edge.get("from") or ""), str(edge.get("to") or "")
        if source in action_ids and target in event_by_legacy:
            action_id = action_ids[source]
            event_id = event_by_legacy[target]["id"]
            event_by_legacy[target]["producerAction"] = action_id
            if action_id in action_by_id and event_id not in action_by_id[action_id]["emits"]:
                action_by_id[action_id]["emits"].append(event_id)
        if source in event_by_legacy and target in action_ids:
            action_id = action_ids[target]
            consumers = event_by_legacy[source]["consumers"]
            if action_id not in consumers:
                consumers.append(action_id)

    known_ids = (set(object_ids.values()) | set(action_ids.values())
                 | set(event_ids.values()) | set(rule_ids.values()))
    raw_decisions = list(decisions)
    decision_ids: dict[str, str] = {}
    for index, raw_decision in enumerate(raw_decisions, 1):
        raw_data = (raw_decision if isinstance(raw_decision, Mapping) else
                    raw_decision.to_dict() if hasattr(raw_decision, "to_dict") else
                    vars(raw_decision))
        legacy_id = str(raw_data.get("id") or raw_data.get("key") or f"decision-{index}")
        decision_ids[legacy_id] = _stable_input_id("dec", legacy_id, "dec_", "dlg_")
    for index, raw_decision in enumerate(raw_decisions, 1):
        decision = _normalise_decision(raw_decision, index, question_ids)
        decision["actorRole"] = role_for(decision.get("actorRole"))
        decision["affectedIds"] = [
            object_ids.get(r, action_ids.get(r, rule_ids.get(r, event_ids.get(r, r))))
            for r in decision["affectedIds"]
        ]
        decision["affectedIds"] = [r for r in decision["affectedIds"] if r in known_ids]
        supersedes = decision.get("supersedes")
        if supersedes:
            decision["supersedes"] = decision_ids.get(str(supersedes), str(supersedes))
        package.decisions.append(decision)
    explicit_questions = {d.get("questionId") for d in package.decisions}
    for question_id, item in answered:
        if question_id in explicit_questions:
            continue
        legacy_id = str(item.get("rid") or "")
        answer = item.get("answer") or {}
        package.decisions.append({
            "id": _canonical_id("dec", f"answer-{legacy_id}"),
            "questionId": question_id,
            "answer": _value(answer),
            "kind": "answer",
            "actor": None,
            "actorRole": None,
            "authority": None,
            "sourceTurn": None,
            "effectiveAt": None,
            "supersedes": None,
            "affectedIds": [],
            "revision": revision,
            "assertion": evidence.assertion(answer),
            "legacyId": f"answer:{legacy_id}",
        })

    package.roles = [{"id": rid, "name": name} for name, rid in sorted(role_ids.items())]
    package.systems = [{"id": rid, "name": name} for name, rid in sorted(system_ids.items())]
    package.evidence = list(evidence.items.values())
    package.validation = validate_package(package)
    return package


def validate_package(package: OntologyPackage | Mapping[str, Any]) -> ValidationReport:
    """Validate the stable shape and every canonical cross-reference."""
    data = package.to_dict() if isinstance(package, OntologyPackage) else dict(package)
    findings: list[ValidationFinding] = []

    def add(code: str, message: str, path: str, *, severity: str = "error",
            ref: str | None = None) -> None:
        findings.append(ValidationFinding(code, message, path, severity, ref))

    if data.get("$schema") != SCHEMA_URL:
        add("SCHEMA_URL", "unsupported or missing $schema", "/$schema")
    if data.get("schemaVersion") != SCHEMA_VERSION:
        add("SCHEMA_VERSION", "unsupported or missing schemaVersion", "/schemaVersion")
    if not str(data.get("packageId") or "").startswith("pkg."):
        add("PACKAGE_ID", "packageId must start with 'pkg.'", "/packageId")
    if not isinstance(data.get("revision"), int) or int(data.get("revision") or 0) < 1:
        add("REVISION", "revision must be an integer >= 1", "/revision")
    base = data.get("baseRevision")
    if base is not None and (not isinstance(base, int) or base >= data.get("revision", 0)):
        add("BASE_REVISION", "baseRevision must be lower than revision", "/baseRevision")

    ids: dict[str, str] = {}
    by_collection: dict[str, set[str]] = {}
    for collection in COLLECTIONS:
        items = data.get(collection)
        if not isinstance(items, list):
            add("COLLECTION_TYPE", f"{collection} must be an array", f"/{collection}")
            items = []
        by_collection[collection] = set()
        for index, item in enumerate(items):
            path = f"/{collection}/{index}"
            if not isinstance(item, Mapping):
                add("ITEM_TYPE", "collection item must be an object", path)
                continue
            rid = str(item.get("id") or "")
            if not rid:
                add("MISSING_ID", "canonical item must have an id", f"{path}/id")
                continue
            if rid in ids:
                add("DUPLICATE_ID", f"duplicate canonical id {rid}", f"{path}/id", ref=rid)
            else:
                ids[rid] = path
            by_collection[collection].add(rid)

    all_ids = set(ids)
    process_node_ids: set[str] = set()
    for pi, process in enumerate(data.get("processes") or []):
        if not isinstance(process, Mapping):
            continue
        local_nodes: set[str] = set()
        stage_ids = {str(stage.get("id")) for stage in process.get("stages") or []
                     if isinstance(stage, Mapping) and stage.get("id")}
        for ni, node in enumerate(process.get("nodes") or []):
            if not isinstance(node, Mapping):
                continue
            node_id = str(node.get("id") or "")
            path = f"/processes/{pi}/nodes/{ni}"
            if not node_id:
                add("MISSING_PROCESS_NODE_ID", "process node must have an id", f"{path}/id")
            elif node_id in process_node_ids:
                add("DUPLICATE_PROCESS_NODE_ID", f"duplicate process node {node_id}", path)
            local_nodes.add(node_id)
            process_node_ids.add(node_id)
            semantic = node.get("semanticRef")
            if semantic and semantic not in all_ids:
                add("DANGLING_REF", f"semanticRef {semantic} does not exist",
                    f"{path}/semanticRef", ref=str(semantic))
            stage = node.get("stageId")
            if stage and stage not in stage_ids:
                add("DANGLING_REF", f"stageId {stage} does not exist",
                    f"{path}/stageId", ref=str(stage))
            for oi, ref in enumerate(node.get("dataObjectRefs") or []):
                if ref not in by_collection["dataObjects"]:
                    add("DANGLING_REF", f"DataObject {ref} does not exist",
                        f"{path}/dataObjectRefs/{oi}", ref=str(ref))
        for ei, edge in enumerate(process.get("edges") or []):
            if not isinstance(edge, Mapping):
                continue
            for side in ("from", "to"):
                ref = edge.get(side)
                if ref not in local_nodes:
                    add("DANGLING_REF", f"process edge {side} {ref} does not exist",
                        f"/processes/{pi}/edges/{ei}/{side}", ref=str(ref))
        for field_name in ("entryNodeIds", "exitNodeIds"):
            for ri, ref in enumerate(process.get(field_name) or []):
                if ref not in local_nodes:
                    add("DANGLING_REF", f"process node {ref} does not exist",
                        f"/processes/{pi}/{field_name}/{ri}", ref=str(ref))

    def check(ref: Any, allowed: set[str], path: str) -> None:
        if ref is not None and ref != "" and ref not in allowed:
            add("DANGLING_REF", f"referenced id {ref} does not exist", path, ref=str(ref))

    for i, item in enumerate(data.get("dataObjects") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("systemOfRecord"), by_collection["systems"],
              f"/dataObjects/{i}/systemOfRecord")
        check(item.get("ownerRole"), by_collection["roles"], f"/dataObjects/{i}/ownerRole")
        for j, relation in enumerate(item.get("relations") or []):
            if isinstance(relation, Mapping):
                check(relation.get("target"), by_collection["dataObjects"],
                      f"/dataObjects/{i}/relations/{j}/target")

    for i, item in enumerate(data.get("actions") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("actorRole"), by_collection["roles"], f"/actions/{i}/actorRole")
        check(item.get("system"), by_collection["systems"], f"/actions/{i}/system")
        check(item.get("compensationAction"), by_collection["actions"],
              f"/actions/{i}/compensationAction")
        for field_name, allowed in (
            ("inputs", by_collection["dataObjects"]),
            ("outputs", by_collection["dataObjects"]),
            ("relatedDataObjects", by_collection["dataObjects"]),
            ("preconditions", by_collection["rules"]),
            ("emits", by_collection["events"]),
            ("sourceProcessNodes", process_node_ids),
        ):
            for j, ref in enumerate(item.get(field_name) or []):
                check(ref, allowed, f"/actions/{i}/{field_name}/{j}")
        for j, effect in enumerate(item.get("effects") or []):
            if isinstance(effect, Mapping):
                check(effect.get("object"), by_collection["dataObjects"],
                      f"/actions/{i}/effects/{j}/object")

    for i, item in enumerate(data.get("events") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("producerAction"), by_collection["actions"],
              f"/events/{i}/producerAction")
        check(item.get("producerSystem"), by_collection["systems"],
              f"/events/{i}/producerSystem")
        payload = item.get("payload")
        if isinstance(payload, Mapping):
            check(payload.get("dataObject"), by_collection["dataObjects"],
                  f"/events/{i}/payload/dataObject")
        for j, ref in enumerate(item.get("consumers") or []):
            check(ref, by_collection["actions"], f"/events/{i}/consumers/{j}")
        for j, ref in enumerate(item.get("sourceProcessNodes") or []):
            check(ref, process_node_ids, f"/events/{i}/sourceProcessNodes/{j}")

    for i, item in enumerate(data.get("rules") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("trigger"), by_collection["events"], f"/rules/{i}/trigger")
        for j, ref in enumerate(item.get("scope") or []):
            check(ref, all_ids, f"/rules/{i}/scope/{j}")

    for i, item in enumerate(data.get("questions") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("audienceRole"), by_collection["roles"],
              f"/questions/{i}/audienceRole")
        for field_name, allowed in (
            ("blockedArtifacts", all_ids),
            ("dependencies", by_collection["questions"]),
            ("evidenceIds", by_collection["evidence"]),
        ):
            for j, ref in enumerate(item.get(field_name) or []):
                check(ref, allowed, f"/questions/{i}/{field_name}/{j}")

    for i, item in enumerate(data.get("decisions") or []):
        if not isinstance(item, Mapping):
            continue
        check(item.get("questionId"), by_collection["questions"],
              f"/decisions/{i}/questionId")
        check(item.get("actorRole"), by_collection["roles"],
              f"/decisions/{i}/actorRole")
        check(item.get("supersedes"), by_collection["decisions"],
              f"/decisions/{i}/supersedes")
        for j, ref in enumerate(item.get("affectedIds") or []):
            check(ref, all_ids, f"/decisions/{i}/affectedIds/{j}")

    # Assertions may appear at several nesting levels; walk all of them.
    def walk(value: Any, path: str = "") -> None:
        if isinstance(value, Mapping):
            assertion = value.get("assertion")
            if isinstance(assertion, Mapping):
                for i, ref in enumerate(assertion.get("evidenceIds") or []):
                    check(ref, by_collection["evidence"], f"{path}/assertion/evidenceIds/{i}")
            for key, child in value.items():
                if key not in {"validation", "assertion"}:
                    walk(child, f"{path}/{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}/{index}")

    walk(data)
    return ValidationReport(findings=findings)


__all__ = [
    "ONTOLOGY_PACKAGE_JSON_SCHEMA",
    "SCHEMA_URL",
    "SCHEMA_VERSION",
    "OntologyPackage",
    "ValidationFinding",
    "ValidationReport",
    "build_package",
    "export_package",
    "package_from_dict",
    "validate_package",
]
