from __future__ import annotations

import io
import json

import pytest

from ontocopilot.onto import (
    ONTOLOGY_PACKAGE_JSON_SCHEMA,
    SCHEMA_URL,
    SCHEMA_VERSION,
    build_package,
    export_package,
    package_from_dict,
    validate_package,
)
from ontocopilot.onto.flow import EdgeKind, FlowGraph, FlowNode, NodeKind, Stage
from ontocopilot.onto.oir import (
    OIR,
    ActionType,
    BaseType,
    BusinessRule,
    ObjectType,
    OpenQuestion,
    PropertyType,
    Provenance,
    RuleKind,
    by_user,
    extracted,
    inferred,
)


def _legacy_models() -> tuple[OIR, FlowGraph]:
    ev = Provenance(
        "file-1", "采购制度.docx", {"kind": "page", "page": 3},
        snippet="采购计划审批通过后创建采购包", extractor="docling", confidence=0.95,
    )
    oir = OIR()
    oir.add_object(ObjectType(
        rid="ot_procurement_plan",
        api_name=extracted("ProcurementPlan", ev),
        display_name=extracted("采购计划", ev),
        primary_key=extracted(["pt_plan_id"], ev),
    ))
    oir.add_property(PropertyType(
        rid="pt_plan_id", parent="ot_procurement_plan",
        api_name=extracted("planId", ev), display_name=extracted("计划ID", ev),
        base_type=extracted(BaseType.STRING, ev), required=extracted(True, ev),
    ))
    oir.add_action(ActionType(
        rid="at_approve_plan", api_name=extracted("审批采购计划", ev),
        applies_to=["ot_procurement_plan"], effects=inferred(["状态改为已审批"]),
    ))
    oir.add_rule(BusinessRule(
        rid="br_director_threshold",
        statement=extracted("含税金额达到50万元由采购总监审批", ev),
        kind=extracted(RuleKind.AUTHORITY, ev),
        applies_to=["ot_procurement_plan"], actor=extracted("采购总监", ev),
    ))
    oir.add_question(OpenQuestion(
        rid="oq_equal_threshold",
        text=extracted("正好50万元是否需要总监审批？", ev),
        options=["是", "否"], answer=by_user("是", note="访谈第5轮"),
        group="审批边界", applies_to=["br_director_threshold"], owner="业务负责人",
    ))

    flow = FlowGraph()
    flow.stages["approval"] = Stage("approval", "审批", order=1)
    flow.add_node(FlowNode(
        "fn_approve_plan", NodeKind.ACTION, extracted("审批采购计划", ev),
        stage="approval", actor=extracted("采购总监", ev),
        objects=["ot_procurement_plan"],
    ))
    flow.add_node(FlowNode(
        "fn_plan_approved", NodeKind.EVENT, extracted("采购计划已通过", ev),
        stage="approval", objects=["ot_procurement_plan"],
    ))
    flow.connect("fn_approve_plan", "fn_plan_approved", kind=EdgeKind.FLOW,
                 evidence=[ev])
    return oir, flow


def test_build_package_maps_legacy_oir_and_flow_to_stable_contract() -> None:
    oir, flow = _legacy_models()
    package = build_package(
        oir, flow, package_id="procurement", revision=2, base_revision=1,
        generated_at="2026-08-12T10:00:00+08:00",
    )
    data = package.to_dict()

    assert data["$schema"] == SCHEMA_URL
    assert data["schemaVersion"] == SCHEMA_VERSION
    assert data["packageId"] == "pkg.procurement"
    assert data["revision"] == 2
    assert data["baseRevision"] == 1
    assert data["validation"]["status"] == "passed"

    data_object = data["dataObjects"][0]
    assert data_object["id"] == "do.procurement.plan"
    assert data_object["kind"] == "document"
    assert data_object["identity"]["keys"] == ["attr.plan.id"]
    assert data_object["attributes"][0]["apiName"] == "planId"
    assert data_object["legacyId"] == "ot_procurement_plan"

    # The OIR action and the matching Flow action become one canonical Action.
    assert len(data["actions"]) == 1
    action = data["actions"][0]
    event = data["events"][0]
    assert action["id"] == "act.approve.plan"
    assert action["relatedDataObjects"] == ["do.procurement.plan"]
    assert action["sourceProcessNodes"] == ["pn.approve.plan"]
    assert action["emits"] == [event["id"]]
    assert event["producerAction"] == action["id"]
    assert event["payload"]["dataObject"] == data_object["id"]

    process = data["processes"][0]
    assert process["entryNodeIds"] == ["pn.approve.plan"]
    assert process["exitNodeIds"] == ["pn.plan.approved"]
    assert process["edges"][0]["from"] == "pn.approve.plan"
    assert process["edges"][0]["to"] == "pn.plan.approved"
    assert {n["semanticRef"] for n in process["nodes"]} == {
        action["id"], event["id"],
    }

    rule = data["rules"][0]
    assert rule["rawStatement"].startswith("含税金额")
    assert rule["scope"] == [data_object["id"]]
    assert rule["compileStatus"] == "uncompiled"
    assert rule["outcome"]["requiredRole"].startswith("role.")

    question = data["questions"][0]
    assert question["status"] == "answered"
    assert question["answerSchema"] == {"type": "string", "enum": ["是", "否"]}
    assert question["blockedArtifacts"] == [rule["id"]]
    assert data["decisions"][0]["questionId"] == question["id"]
    assert data["decisions"][0]["answer"] == "是"
    assert data["evidence"]


def test_build_package_accepts_legacy_dicts_and_is_deterministic() -> None:
    oir, flow = _legacy_models()
    options = {
        "package_id": "pkg.procurement", "revision": 1,
        "generated_at": "2026-08-12T02:00:00Z",
    }
    left = build_package(oir, flow, **options).to_dict()
    right = build_package(oir.to_dict(), flow.to_dict(), **options).to_dict()
    assert left == right


def test_explicit_decisions_are_mapped_and_supersession_is_preserved() -> None:
    oir, flow = _legacy_models()
    decisions = [
        {
            "id": "dec_old", "questionId": "oq_equal_threshold", "answer": False,
            "affectedIds": ["br_director_threshold"], "revision": 1,
        },
        {
            "id": "dec_new", "questionId": "oq_equal_threshold", "answer": True,
            "affectedIds": ["br_director_threshold"], "supersedes": "dec_old",
            "revision": 2,
        },
    ]
    data = build_package(oir, flow, decisions=decisions).to_dict()
    assert len(data["decisions"]) == 2  # no duplicate derived answer decision
    old, new = data["decisions"]
    assert old["id"] == "dec.old"
    assert new["supersedes"] == old["id"]
    assert new["affectedIds"] == [data["rules"][0]["id"]]
    assert data["validation"]["status"] == "passed"


def test_validate_package_reports_duplicate_and_dangling_references() -> None:
    oir, flow = _legacy_models()
    data = build_package(oir, flow).to_dict()
    data["events"][0]["producerAction"] = "act.missing"
    data["actions"].append(dict(data["actions"][0]))

    report = validate_package(data)
    assert not report.passed
    codes = {finding.code for finding in report.findings}
    assert "DUPLICATE_ID" in codes
    assert "DANGLING_REF" in codes
    assert any(f.ref == "act.missing" for f in report.findings)


def test_package_round_trip_and_export(tmp_path) -> None:
    oir, flow = _legacy_models()
    original = build_package(
        oir, flow, package_id="procurement", revision=3, base_revision=2,
        generated_at="2026-08-12T10:00:00+08:00",
    )
    restored = package_from_dict(original.to_dict())
    assert restored.to_dict() == original.to_dict()

    target = tmp_path / "OntologyPackage.json"
    export_package(restored, target)
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["validation"]["status"] == "passed"
    assert saved["dataObjects"][0]["displayName"] == "采购计划"

    stream = io.StringIO()
    export_package(restored, stream)
    assert json.loads(stream.getvalue())["packageId"] == "pkg.procurement"


def test_export_refuses_invalid_package() -> None:
    oir, flow = _legacy_models()
    data = build_package(oir, flow).to_dict()
    data["questions"][0]["dependencies"] = ["q.missing"]
    with pytest.raises(ValueError, match="invalid OntologyPackage"):
        export_package(data, io.StringIO())


def test_schema_constant_documents_all_stable_collections() -> None:
    required = set(ONTOLOGY_PACKAGE_JSON_SCHEMA["required"])
    assert {"processes", "dataObjects", "actions", "events", "rules"} <= required
    assert {"questions", "decisions", "evidence", "validation"} <= required


def test_package_rejects_invalid_revisions_and_schema_versions() -> None:
    oir, _ = _legacy_models()
    with pytest.raises(ValueError, match="revision"):
        build_package(oir, revision=0)
    with pytest.raises(ValueError, match="base_revision"):
        build_package(oir, revision=2, base_revision=2)

    data = build_package(oir).to_dict()
    data["schemaVersion"] = "2.0.0"
    with pytest.raises(ValueError, match="unsupported"):
        package_from_dict(data)
