"""Frozen FDE engagement workflow declaration.

The executable handlers live in :mod:`.engagement_runtime`; keeping the declaration
separate preserves the stable control-plane contract.  Material *contents* are node
inputs and can never add tools or alter the topology.
"""

from __future__ import annotations

from ..kernel.agents import AgentLibrary, default_agents
from ..kernel.dag import (
    Dag,
    Difficulty,
    GateSpec,
    NodeBudget,
    NodeMode,
    NodeSpec,
    ScopeSpec,
)

FDE_ENGAGEMENT_AGENTS: tuple[str, ...] = (
    "fde_interviewer",
    "process_modeler",
    "erp_mapper",
    "rule_engineer",
    "data_steward",
    "delivery_reviewer",
)


def _agent_node(
    node_id: str,
    agent_name: str,
    *,
    deps: tuple[str, ...] = (),
    evidence_top_k: int = 32,
    gate: GateSpec | None = None,
) -> NodeSpec:
    """Translate an :class:`AgentSpec` into the existing DAG node contract."""
    agent = default_agents().get(agent_name)
    return NodeSpec(
        id=node_id,
        mode=agent.mode,
        handler=f"agent.{agent_name}",
        deps=deps,
        scope=ScopeSpec(evidence_top_k=evidence_top_k),
        budget=agent.budget,
        critics=agent.critics,
        critic_rounds=agent.critic_rounds,
        difficulty=agent.difficulty,
        gate=gate,
        params={
            "agent": agent_name,
            "tool_scope": agent.tool_scope,
            "output_schema": agent.output_schema,
        },
    )


def build_fde_engagement_dag(
    agents: AgentLibrary | None = None,
) -> Dag:
    """Build and freeze the front-line discovery-to-delivery workflow.

    The optional ``agents`` argument is a fail-fast compatibility check for deployments
    that extend the default agent library.  Nodes still carry only serializable names and
    schemas, so the declaration can be journalled or rendered without live agent objects.

    Topology::

        INTAKE -> PROCESS -> ERP_MAP -----\
                          -> RULES --------> GAP -> INTERVIEW (HITL)
                          -> DATA_OBJECTS -/             |
                                             CANONICALIZE -> REVIEW -> EXPORT

    ``GAP`` is the synchronization barrier.  ``INTERVIEW`` is always present even when the
    current backlog is empty; its deterministic handler may immediately accept an empty
    answer.  This keeps uploaded content from changing the plan after it is frozen.
    """
    library = agents or default_agents()
    for name in FDE_ENGAGEMENT_AGENTS:
        library.get(name)

    dag = Dag("fde_engagement_v1", freeze_before="INTAKE")
    dag.extend([
        _agent_node("INTAKE", "fde_interviewer", evidence_top_k=40),
        _agent_node("PROCESS", "process_modeler", deps=("INTAKE",), evidence_top_k=48),
        _agent_node("ERP_MAP", "erp_mapper", deps=("PROCESS",), evidence_top_k=40),
        _agent_node("RULES", "rule_engineer", deps=("PROCESS",), evidence_top_k=40),
        _agent_node(
            "DATA_OBJECTS", "data_steward", deps=("PROCESS",), evidence_top_k=40,
        ),
        NodeSpec(
            id="GAP",
            mode=NodeMode.DETERMINISTIC,
            handler="engagement.collect_gaps",
            deps=("PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS"),
            scope=ScopeSpec(evidence_top_k=0, recall_long_term=False),
            budget=NodeBudget(tokens=0, iterations=1, wallclock_s=60, tool_calls=0),
            params={
                "output_contract": "QuestionBacklog",
                "rank_by": (
                    "downstream_blocking", "blast_radius", "irreversibility", "evidence_gap",
                ),
            },
            retries=0,
        ),
        NodeSpec(
            id="INTERVIEW",
            mode=NodeMode.HITL,
            handler="engagement.interview",
            deps=("GAP",),
            scope=ScopeSpec(evidence_top_k=0, recall_long_term=False),
            budget=NodeBudget(tokens=0, iterations=1, wallclock_s=604_800, tool_calls=0),
            difficulty=Difficulty.LOW,
            params={
                "input_contract": "QuestionBacklog",
                "output_contract": "DecisionLedger",
                "batching": "progressive",
            },
            retries=0,
        ),
        NodeSpec(
            id="CANONICALIZE",
            mode=NodeMode.DETERMINISTIC,
            handler="engagement.canonicalize",
            deps=("INTERVIEW",),
            scope=ScopeSpec(evidence_top_k=0),
            budget=NodeBudget(tokens=0, iterations=1, wallclock_s=120, tool_calls=0),
            params={"output_contract": "OntologyPackage.v1"},
            retries=0,
        ),
        _agent_node(
            "REVIEW", "delivery_reviewer", deps=("CANONICALIZE",), evidence_top_k=24,
            gate=GateSpec(
                kind="auto",
                require=(
                    "verdict == 'PASS'", "blocker_count == 0",
                    "all_passed == true", "high_findings == 0",
                ),
            ),
        ),
        NodeSpec(
            id="EXPORT",
            mode=NodeMode.DETERMINISTIC,
            handler="engagement.export",
            # Export must receive both the reviewed package and the review verdict.
            # A transitive dependency is not included in WorkingSet.select(); declaring
            # both inputs prevents the release handler from silently re-validating `{}`.
            deps=("CANONICALIZE", "REVIEW"),
            scope=ScopeSpec(evidence_top_k=0, recall_long_term=False),
            budget=NodeBudget(tokens=0, iterations=1, wallclock_s=180, tool_calls=0),
            gate=GateSpec(
                kind="auto",
                require=(
                    "review_passed == true", "schema_valid == true",
                    "downloadable == true",
                ),
            ),
            params={
                "formats": ("json", "xlsx", "md", "mermaid"),
                "input_contract": "OntologyPackage.v1",
            },
            retries=0,
        ),
    ])
    return dag.freeze()


__all__ = ["FDE_ENGAGEMENT_AGENTS", "build_fde_engagement_dag"]
