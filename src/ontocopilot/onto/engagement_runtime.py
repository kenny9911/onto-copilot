"""Executable handlers for the frozen FDE engagement DAG.

The extraction DAG remains the expensive, mature implementation of document
understanding.  This module turns its result into the *product* workflow: every
FDE stage is executed and checkpointed by :class:`~ontocopilot.kernel.scheduler.Scheduler`
without paying a second time for the same evidence.  Agent-shaped stages use
``skip_model`` to produce deterministic, schema-shaped projections from OIR and
Flow; deployments can replace one handler at a time with a model-backed version
without changing the frozen topology.

The important boundaries are executable, not descriptive:

* ``INTERVIEW`` raises ``HumanInputRequired`` while the durable backlog contains
  pending questions, then resumes once those questions are resolved;
* ``CANONICALIZE`` builds and validates the exact OntologyPackage revision;
* ``REVIEW`` and ``EXPORT`` expose hard metrics consumed by ``GateSpec`` before
  any server-side artifact writer is called.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..kernel.agents import default_agents
from ..kernel.critic import Critic, CriticContext, Finding, Severity, Verdict
from ..kernel.errors import NodeFailure
from ..kernel.loop import NodeHandler, RunContext
from .canonical import build_package, validate_package
from .oir import OIR
from .questions import DecisionLedger, Question, QuestionBacklog, QuestionStatus

_PENDING = {
    QuestionStatus.OPEN,
    QuestionStatus.ASSIGNED,
    QuestionStatus.BLOCKED,
}
_EXPECTED_ARTIFACTS = (
    "ontology.package.json",
    "ontology-package.schema.json",
    "data-objects.json",
    "actions.json",
    "events.json",
    "rules.json",
    "questions.json",
    "模板_v1.xlsx",
    "oir.json",
)


def _as_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "to_dict"):
        return value.to_dict()
    raise TypeError(f"expected mapping/to_dict object, got {type(value).__name__}")


def _value(value: Any, default: Any = "") -> Any:
    if isinstance(value, Mapping) and "value" in value:
        return value.get("value", default)
    return default if value is None else value


def _evidence_ids(*values: Any) -> list[str]:
    """Return stable human-readable evidence references already present in OIR.

    Engagement projections are not a second source of truth, so they retain the
    upstream cite rather than minting a new evidence identity.  Canonicalization
    later turns those references into package-owned ``ev.*`` IDs.
    """
    out: list[str] = []
    for value in values:
        if not isinstance(value, Mapping):
            continue
        for evidence in value.get("evidence") or ():
            if not isinstance(evidence, Mapping):
                continue
            ref = str(evidence.get("cite") or "").strip()
            if not ref:
                name = str(evidence.get("file_name") or evidence.get("fileName") or "")
                locator = evidence.get("locator") or {}
                ref = f"{name}#{locator}" if name else ""
            if ref and ref not in out:
                out.append(ref)
    return out


def _question_rows(backlog: QuestionBacklog) -> list[Question]:
    return sorted(backlog.questions.values(), key=lambda q: (q.created_at, q.id))


@dataclass(slots=True)
class EngagementRuntimeInput:
    """Materialized inputs for one engagement execution/replay."""

    session_id: str
    project: str
    oir: OIR | Mapping[str, Any]
    flow: Any | None = None
    backlog: QuestionBacklog | Mapping[str, Any] = field(default_factory=QuestionBacklog)
    decisions: DecisionLedger | list[Mapping[str, Any]] | Mapping[str, Any] = field(
        default_factory=DecisionLedger,
    )
    corpus: Mapping[str, Any] = field(default_factory=dict)
    artifact_revision: int = 0
    generated_at: str = "1970-01-01T00:00:00+00:00"
    release_downloadable: bool = True

    def oir_dict(self) -> dict[str, Any]:
        return _as_dict(self.oir)

    def flow_dict(self) -> dict[str, Any]:
        return _as_dict(self.flow)

    def question_backlog(self) -> QuestionBacklog:
        if isinstance(self.backlog, QuestionBacklog):
            return self.backlog
        return QuestionBacklog.from_dict(self.backlog)

    def decision_rows(self) -> list[dict[str, Any]]:
        if isinstance(self.decisions, DecisionLedger):
            return [d.to_dict() for d in self.decisions.decisions]
        raw: Any = self.decisions
        if isinstance(raw, Mapping):
            raw = raw.get("decisions") or []
        return [_as_dict(row) for row in raw]

    def pending(self) -> list[Question]:
        """All unresolved interview work, including non-release gaps."""
        return [q for q in _question_rows(self.question_backlog()) if q.status in _PENDING]

    def blockers(self) -> list[Question]:
        """Unresolved questions that are allowed to suspend formal delivery.

        A real discovery workbook can contain hundreds of ordinary open questions.
        They remain visible in the package and make it an explicit draft, but only a
        question declared ``blocking`` (priority or blocked artifact) stops the DAG.
        Deferred/cancelled questions are intentionally not blockers.
        """
        return [q for q in self.pending() if q.blocking]


class _StaticProjection(NodeHandler):
    """A model-shaped node whose current production path is deterministic."""

    def __init__(self, runtime: EngagementRuntimeInput, agent_name: str) -> None:
        self.runtime = runtime
        agent = default_agents().get(agent_name)
        self.schema = agent.output_schema
        self.system = agent.system

    def task(self, inputs: dict[str, Any]) -> str:
        return "把成熟抽取结果投影为本节点的稳定 FDE 交付契约。"

    def skip_model(self, inputs: dict[str, Any]) -> Any:
        return self.project(inputs)

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class IntakeHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "fde_interviewer")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        backlog = self.runtime.question_backlog()
        systems: dict[str, dict[str, Any]] = {}
        for action in self.runtime.oir_dict().get("actions") or ():
            endpoint = _value(action.get("sourceEndpoint"), None) or {}
            if not isinstance(endpoint, Mapping):
                continue
            raw = str(endpoint.get("url") or endpoint.get("path") or "").strip()
            if raw:
                key = raw.split("//", 1)[-1].split("/", 1)[0] or raw
                systems.setdefault(key, {
                    "id": f"sys.{key}", "name": key, "authority": "UNKNOWN",
                })
        questions = []
        for q in _question_rows(backlog):
            questions.append({
                "id": q.id,
                "text": q.text or q.id,
                "audience_role": q.audience_role or "业务负责人",
                "owner_user_id": q.owner_user_id or None,
                "priority": str(q.priority).upper().removeprefix("QUESTIONPRIORITY."),
                "answer_schema": dict(q.answer_schema or {"type": "string"}),
                "blocked_artifacts": list(q.blocked_artifacts),
                "evidence_ids": list(q.evidence_ids),
            })
        return {
            "engagement": {
                "objective": self.runtime.project or f"会话 {self.runtime.session_id} 业务梳理",
                "in_scope": ["AS-IS 流程", "OntologyPackage v1", "待澄清问题与决策"],
                "out_of_scope": [],
                "stakeholders": [],
                "systems": list(systems.values()),
                "acceptance_criteria": [
                    "OntologyPackage v1 引用完整性通过",
                    "发布前 REVIEW 与 EXPORT 硬门通过",
                ],
            },
            "findings": [],
            "questions": questions,
        }


class ProcessHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "process_modeler")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        flow = self.runtime.flow_dict()
        steps = []
        for node in flow.get("nodes") or ():
            label = node.get("label")
            actor = str(_value(node.get("actor")) or "待确认")
            steps.append({
                "id": str(node.get("rid") or node.get("id") or ""),
                "name": str(_value(label) or node.get("rid") or "未命名步骤"),
                "actor_role": actor,
                "trigger": None,
                "precondition": None,
                "input_data_ids": list(node.get("objects") or ()),
                "output_data_ids": list(node.get("objects") or ()),
                "system_ids": ([str(node.get("endpoint"))]
                               if node.get("endpoint") else []),
                "evidence_ids": _evidence_ids(label, node.get("actor")),
            })
        edges = [{
            "id": str(edge.get("rid") or edge.get("id") or ""),
            "from": str(edge.get("from") or ""),
            "to": str(edge.get("to") or ""),
            "kind": _edge_kind(edge.get("kind")),
            "event_or_condition": str(edge.get("label") or ""),
        } for edge in flow.get("edges") or ()]
        return {
            "process_id": f"proc.{self.runtime.session_id}",
            "perspective": "AS_IS",
            "steps": steps,
            "edges": edges,
            "gaps": [q.id for q in self.runtime.pending()],
            # This is the auditable hand-off from the mature EXTRACT composite.
            "source": "mature_extract_composite",
            "oir_stats": _oir_stats(self.runtime.oir_dict()),
        }


class ERPMapHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "erp_mapper")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        process = inputs.get("PROCESS") or {}
        landscape: dict[str, dict[str, Any]] = {}
        mappings = []
        for step in process.get("steps") or ():
            for raw_system in step.get("system_ids") or ():
                raw = str(raw_system).strip()
                if not raw:
                    continue
                name = raw.split("//", 1)[-1].split("/", 1)[0] or raw
                sid = f"sys.{name}"
                landscape.setdefault(sid, {
                    "system_id": sid,
                    "product": name,
                    "version": None,
                    "module": None,
                    "org_scope": None,
                })
                mappings.append({
                    "process_step_id": step["id"],
                    "system_id": sid,
                    "implementation_kind": "UNKNOWN",
                    "target_refs": [raw],
                    "confidence": 0.5,
                    "evidence_ids": list(step.get("evidence_ids") or ()),
                })
        questions = [q.id for q in self.runtime.pending()
                     if "erp" in q.audience_role.lower() or "顾问" in q.audience_role]
        return {
            "landscape": list(landscape.values()),
            "mappings": mappings,
            "questions": questions,
        }


class RulesHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "rule_engineer")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        rows = []
        for rule in self.runtime.oir_dict().get("rules") or ():
            statement = str(_value(rule.get("statement")) or "").strip()
            if not statement:
                continue
            raw_kind = str(_value(rule.get("ruleKind")) or "OTHER").upper()
            kind = raw_kind if raw_kind in {
                "VALIDATION", "PROCESS", "AUTHORITY", "CALCULATION", "DERIVATION",
            } else "VALIDATION"
            rows.append({
                "id": str(rule.get("rid") or ""),
                "kind": kind,
                "trigger_event_id": None,
                "applies_to_ids": list(rule.get("appliesTo") or ()),
                # Preserve the source statement.  Compilation into an executable
                # expression remains explicit instead of inventing business logic.
                "condition": statement,
                "effect": statement,
                "exceptions": [],
                "evidence_ids": _evidence_ids(rule.get("statement"), rule.get("ruleKind")),
                "test_cases": [],
            })
        questions = [q.id for q in self.runtime.pending()
                     if q.source_kind in {"rule", "conflict"}]
        return {"rules": rows, "conflicts": [], "questions": questions}


class DataObjectsHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "data_steward")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        rows = []
        for obj in self.runtime.oir_dict().get("objects") or ():
            name = str(_value(obj.get("displayName")) or _value(obj.get("apiName")) or "")
            rows.append({
                "id": str(obj.get("rid") or ""),
                "name": name or str(obj.get("rid") or "未命名对象"),
                "classification": _classification(name),
                "business_keys": list(_value(obj.get("primaryKey"), []) or ()),
                "system_of_record": None,
                "owner_role": None,
                "lifecycle_states": [],
                "sensitivity": "UNKNOWN",
                "evidence_ids": _evidence_ids(obj.get("apiName"), obj.get("displayName")),
            })
        questions = [q.id for q in self.runtime.pending()
                     if q.source_kind in {"data_object", "open_question"}]
        return {"data_objects": rows, "quality_rules": [], "questions": questions}


class GapHandler(NodeHandler):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        self.runtime = runtime

    def task(self, inputs: dict[str, Any]) -> str:
        return "合并专业节点发现的缺口并按阻塞性排序。"

    async def execute(self, inputs: dict[str, Any], ctx: RunContext) -> dict[str, Any]:
        backlog = self.runtime.question_backlog()
        return {
            "contract": "QuestionBacklog",
            "questions": backlog.to_dict()["questions"],
            "pending": [q.id for q in self.runtime.pending()],
            "next_batch": [q.id for q in backlog.next_batch(limit=5)],
            "stats": backlog.stats(),
            "sources": sorted(inputs),
        }


class InterviewHandler(NodeHandler):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        self.runtime = runtime

    def task(self, inputs: dict[str, Any]) -> str:
        return "等待 FDE 通过 Question/Decision 工作台完成阻塞决策。"

    def skip_model(self, inputs: dict[str, Any]) -> Any | None:
        if self.runtime.blockers():
            return None
        return {
            "contract": "DecisionLedger",
            "decisions": self.runtime.decision_rows(),
            "resolved": True,
            "releaseState": "DRAFT" if self.runtime.pending() else "RELEASED",
        }

    def human_request(self, draft: Any, inputs: dict[str, Any]) -> dict[str, Any]:
        blockers = self.runtime.blockers()
        batch = blockers[:5]
        return {
            "contract": "QuestionBacklog",
            "questions": [q.to_dict() for q in batch],
            "pending": len(blockers),
            "unresolved": len(self.runtime.pending()),
            "action": "answer_questions",
        }


class CanonicalizeHandler(NodeHandler):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        self.runtime = runtime

    def task(self, inputs: dict[str, Any]) -> str:
        return "构建并验证 OntologyPackage v1。"

    async def execute(self, inputs: dict[str, Any], ctx: RunContext) -> dict[str, Any]:
        current = int(self.runtime.artifact_revision)
        package = build_package(
            self.runtime.oir,
            self.runtime.flow,
            package_id=f"pkg.{self.runtime.session_id}",
            revision=current + 1,
            base_revision=current or None,
            generated_at=self.runtime.generated_at,
            decisions=self.runtime.decision_rows(),
            backlog=self.runtime.question_backlog(),
        )
        report = validate_package(package)
        if not report.passed:
            summary = "; ".join(
                f"{finding.code}@{finding.path}: {finding.message}"
                for finding in report.findings if finding.severity == "error"
            )
            raise NodeFailure(
                ctx.node_id,
                f"OntologyPackage v1 校验失败：{summary}",
                retryable=False,
            )
        data = package.to_dict()
        data["validation"] = report.to_dict()
        return data


class ReviewHandler(_StaticProjection):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        super().__init__(runtime, "delivery_reviewer")

    def project(self, inputs: dict[str, Any]) -> dict[str, Any]:
        package = inputs.get("CANONICALIZE") or {}
        report = validate_package(package)
        blockers = [{
            "code": finding.code,
            "message": finding.message,
            "owner_role": "delivery_reviewer",
            "artifact_ids": ["ontology.package.json"],
        } for finding in report.findings if finding.severity == "error"]
        blockers_open = self.runtime.blockers()
        if blockers_open:
            blockers.append({
                "code": "OPEN_BLOCKING_QUESTIONS",
                "message": f"仍有 {len(blockers_open)} 个阻塞问题未处理",
                "owner_role": "fde_interviewer",
                "artifact_ids": ["questions.json"],
            })
        if not self.runtime.release_downloadable:
            blockers.append({
                "code": "ARTIFACT_TARGET_UNAVAILABLE",
                "message": "交付目录当前不可写，无法生成可下载产物",
                "owner_role": "delivery_reviewer",
                "artifact_ids": list(_EXPECTED_ARTIFACTS),
            })
        checked, ungrounded = _traceability(package)
        valid = report.passed
        artifact_checks = [{
            "artifact_id": artifact,
            "schema_valid": valid,
            "downloadable": bool(self.runtime.release_downloadable),
        } for artifact in _EXPECTED_ARTIFACTS]
        unresolved_questions = self.runtime.pending()
        release_state = "DRAFT" if unresolved_questions else "RELEASED"
        warnings = (
            [f"{len(unresolved_questions)} 个非阻塞问题尚待澄清，交付件标记为 DRAFT"]
            if unresolved_questions else []
        )
        if ungrounded:
            warnings.append(f"{len(ungrounded)} 条推断断言没有材料证据")
        return {
            "verdict": "PASS" if not blockers else "BLOCKED",
            "blockers": blockers,
            "warnings": warnings,
            "releaseState": release_state,
            "traceability": {"checked": checked, "unresolved": ungrounded[:100]},
            "artifact_checks": artifact_checks,
            "blocker_count": len(blockers),
            "schema_valid": valid,
        }


class ExportHandler(NodeHandler):
    def __init__(self, runtime: EngagementRuntimeInput) -> None:
        self.runtime = runtime

    def task(self, inputs: dict[str, Any]) -> str:
        return "形成通过门禁后的交付提交计划；实际写盘由服务提交边界执行。"

    async def execute(self, inputs: dict[str, Any], ctx: RunContext) -> dict[str, Any]:
        review = inputs.get("REVIEW") or {}
        package = inputs.get("CANONICALIZE") or {}
        report = validate_package(package)
        artifact_checks = list(review.get("artifact_checks") or ())
        downloadable = bool(artifact_checks) and all(
            bool(item.get("downloadable")) for item in artifact_checks
        )
        return {
            "review_passed": review.get("verdict") == "PASS",
            "schema_valid": report.passed and bool(review.get("schema_valid")),
            "downloadable": downloadable,
            "releaseState": review.get("releaseState") or "DRAFT",
            "warnings": list(review.get("warnings") or ()),
            "formats": ["json", "xlsx", "md", "mermaid"],
            "artifacts": [item.get("artifact_id") for item in artifact_checks],
            # Server commits this exact validated payload only after Scheduler has
            # applied the EXPORT gate.
            "package": package,
        }


class ContractCritic(Critic):
    """Cheap output-contract critic for deterministic engagement projections."""

    name = "schema"
    needs_llm = False

    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict:
        findings: list[Finding] = []
        if not isinstance(draft, Mapping):
            findings.append(Finding(
                Severity.HIGH, "OUTPUT_NOT_OBJECT", ctx.node_id,
                "节点没有返回 JSON object", verifier="rule:engagement-contract",
            ))
        else:
            agent_name = {
                "INTAKE": "fde_interviewer",
                "PROCESS": "process_modeler",
                "ERP_MAP": "erp_mapper",
                "RULES": "rule_engineer",
                "DATA_OBJECTS": "data_steward",
                "REVIEW": "delivery_reviewer",
            }.get(ctx.node_id)
            if agent_name:
                schema = default_agents().get(agent_name).output_schema or {}
                missing = [key for key in schema.get("required") or () if key not in draft]
                if missing:
                    findings.append(Finding(
                        Severity.HIGH, "OUTPUT_REQUIRED_MISSING", ctx.node_id,
                        f"输出缺少必填字段：{', '.join(missing)}",
                        verifier="rule:engagement-contract",
                    ))
        return Verdict(
            self.name,
            not any(f.severity is Severity.HIGH for f in findings),
            findings,
            "确定性输出契约检查",
        )


class EngagementProvenanceCritic(Critic):
    """Surface ungrounded projections without inventing a release blocker."""

    name = "provenance"
    needs_llm = False

    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict:
        findings: list[Finding] = []
        if ctx.node_id == "REVIEW" and isinstance(draft, Mapping):
            unresolved = (draft.get("traceability") or {}).get("unresolved") or []
            if unresolved:
                findings.append(Finding(
                    Severity.MEDIUM,
                    "INFERRED_WITHOUT_EVIDENCE",
                    "OntologyPackage.v1",
                    f"{len(unresolved)} 条推断断言没有材料证据，已在交付警告中披露",
                    evidence_checked=[str(item) for item in unresolved[:10]],
                    verifier="rule:canonical-traceability",
                ))
        return Verdict(self.name, True, findings, "确定性溯源检查")


def engagement_handlers(runtime: EngagementRuntimeInput) -> dict[str, NodeHandler]:
    """Build the exact handler registry referenced by ``build_fde_engagement_dag``."""
    return {
        "agent.fde_interviewer": IntakeHandler(runtime),
        "agent.process_modeler": ProcessHandler(runtime),
        "agent.erp_mapper": ERPMapHandler(runtime),
        "agent.rule_engineer": RulesHandler(runtime),
        "agent.data_steward": DataObjectsHandler(runtime),
        "engagement.collect_gaps": GapHandler(runtime),
        "engagement.interview": InterviewHandler(runtime),
        "engagement.canonicalize": CanonicalizeHandler(runtime),
        "agent.delivery_reviewer": ReviewHandler(runtime),
        "engagement.export": ExportHandler(runtime),
    }


def engagement_critics() -> dict[str, Critic]:
    return {
        "schema": ContractCritic(),
        "provenance": EngagementProvenanceCritic(),
    }


def _edge_kind(value: Any) -> str:
    raw = str(value or "").lower()
    if "exception" in raw or "异常" in raw:
        return "EXCEPTION"
    if "timeout" in raw or "超时" in raw:
        return "TIMEOUT"
    if "cancel" in raw or "取消" in raw:
        return "CANCEL"
    if "condition" in raw or "gateway" in raw or "条件" in raw:
        return "CONDITIONAL"
    return "SEQUENCE"


def _classification(name: str) -> str:
    lowered = name.lower()
    if any(word in lowered for word in ("主数据", "供应商", "物料", "master")):
        return "MASTER_DATA"
    if any(word in lowered for word in ("文档", "附件", "document")):
        return "DOCUMENT"
    if any(word in lowered for word in ("交易", "订单", "申请", "transaction", "order")):
        return "TRANSACTION"
    return "BUSINESS_OBJECT"


def _oir_stats(oir: Mapping[str, Any]) -> dict[str, int]:
    return {
        key: len(oir.get(key) or ())
        for key in ("objects", "properties", "links", "actions", "rules", "questions")
    }


def _traceability(package: Mapping[str, Any]) -> tuple[int, list[str]]:
    checked = 0
    unresolved: list[str] = []

    def walk(value: Any, path: str = "") -> None:
        nonlocal checked
        if isinstance(value, Mapping):
            assertion = value.get("assertion")
            if isinstance(assertion, Mapping):
                checked += 1
                if (str(assertion.get("origin") or "").upper() == "INFERRED"
                        and not assertion.get("evidenceIds")):
                    unresolved.append(path or "/")
            for key, child in value.items():
                if key not in {"assertion", "validation"}:
                    walk(child, f"{path}/{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{path}/{index}")

    walk(package)
    return checked, unresolved


__all__ = [
    "ContractCritic",
    "EngagementProvenanceCritic",
    "EngagementRuntimeInput",
    "engagement_critics",
    "engagement_handlers",
]
