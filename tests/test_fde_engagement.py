"""FDE front-line roles, skills, and the frozen engagement control plane."""

from __future__ import annotations

import pytest

from ontocopilot.kernel.agents import TOOL_SCOPES, default_agents
from ontocopilot.kernel.dag import NodeMode, NodeSpec
from ontocopilot.kernel.errors import FrozenPlanViolation
from ontocopilot.kernel.skills import default_library
from ontocopilot.onto.engagement import FDE_ENGAGEMENT_AGENTS, build_fde_engagement_dag

ROLE_SKILLS = {
    "fde_interviewer": {"访谈盘点", "缺口追问路由"},
    "process_modeler": {"流程建模", "缺口追问路由"},
    "erp_mapper": {"ERP映射", "缺口追问路由"},
    "rule_engineer": {"规则结构化", "缺口追问路由"},
    "data_steward": {"数据对象治理", "缺口追问路由"},
    "delivery_reviewer": {"交付审查"},
}


def test_fde_skills_are_complete_operating_procedures():
    skills = default_library()
    names = set().union(*ROLE_SKILLS.values())
    for name in names:
        skill = skills.get(name)
        assert skill.when_to_use, name
        assert skill.procedure.count("\n") >= 3, name
        assert len(skill.checklist) >= 4, name
        assert set(skill.tools) <= {
            "evidence.search", "evidence.rows", "oir.query", "profile.column",
        }


def test_fde_roles_reference_their_skills_and_have_output_contracts():
    agents = default_agents()
    skills = default_library()
    assert tuple(ROLE_SKILLS) == FDE_ENGAGEMENT_AGENTS
    for name, required_skills in ROLE_SKILLS.items():
        agent = agents.get(name)
        assert required_skills <= set(agent.skills)
        assert set(agent.skills) <= set(skills.names())
        schema = agent.output_schema
        assert schema and schema["type"] == "object"
        assert schema.get("required")
        assert set(schema["required"]) <= set(schema["properties"])


def test_fde_roles_use_least_privilege_scopes():
    agents = default_agents()
    allowed = {"evidence.search", "evidence.rows", "oir.query", "profile.column"}
    for name in FDE_ENGAGEMENT_AGENTS:
        agent = agents.get(name)
        tools = set(TOOL_SCOPES[agent.tool_scope])
        assert tools <= allowed
        assert not tools & {"code.exec", "mail.send", "http.fetch", "web.search"}
        if name not in {"erp_mapper", "data_steward"}:
            assert "profile.column" not in tools


def test_engagement_dag_has_frozen_discovery_to_export_dependencies():
    dag = build_fde_engagement_dag()
    assert dag.frozen and dag.freeze_before == "INTAKE"
    assert dag.resolve_deps("PROCESS") == ["INTAKE"]
    assert dag.resolve_deps("ERP_MAP") == ["PROCESS"]
    assert dag.resolve_deps("RULES") == ["PROCESS"]
    assert dag.resolve_deps("DATA_OBJECTS") == ["PROCESS"]
    assert dag.resolve_deps("GAP") == ["PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS"]
    assert dag["INTERVIEW"].mode is NodeMode.HITL
    assert dag.resolve_deps("INTERVIEW") == ["GAP"]
    assert dag.resolve_deps("CANONICALIZE") == ["INTERVIEW"]
    assert dag.resolve_deps("REVIEW") == ["CANONICALIZE"]
    assert dag.resolve_deps("EXPORT") == ["CANONICALIZE", "REVIEW"]
    assert dag.topo_order()[0] == "INTAKE"
    assert dag.topo_order()[-1] == "EXPORT"


def test_uploaded_content_cannot_mutate_the_frozen_engagement_plan():
    dag = build_fde_engagement_dag()
    with pytest.raises(FrozenPlanViolation, match="材料内容"):
        dag.add(NodeSpec("EXFILTRATE", NodeMode.REACT, "http.fetch", deps=("INTAKE",)))


def test_dag_agent_nodes_embed_serializable_execution_contracts():
    dag = build_fde_engagement_dag()
    node_to_agent = {
        "INTAKE": "fde_interviewer",
        "PROCESS": "process_modeler",
        "ERP_MAP": "erp_mapper",
        "RULES": "rule_engineer",
        "DATA_OBJECTS": "data_steward",
        "REVIEW": "delivery_reviewer",
    }
    for node_id, agent_name in node_to_agent.items():
        node = dag[node_id]
        agent = default_agents().get(agent_name)
        assert node.handler == f"agent.{agent_name}"
        assert node.params["agent"] == agent_name
        assert node.params["tool_scope"] == agent.tool_scope
        assert node.params["output_schema"] == agent.output_schema

    assert dag["GAP"].params["output_contract"] == "QuestionBacklog"
    assert dag["INTERVIEW"].params["output_contract"] == "DecisionLedger"
    assert dag["CANONICALIZE"].params["output_contract"] == "OntologyPackage.v1"
    assert dag["EXPORT"].params["formats"] == ("json", "xlsx", "md", "mermaid")
