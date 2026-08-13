"""Agent 定义 —— 把"谁来干、用什么档位、能碰哪些工具、按哪套规程"打包成一个对象。

**Agent 是配置，不是代码。** 一个 :class:`AgentSpec` 声明角色、模型档位、工具
作用域、技能集、评审视角、循环模式；真正的执行由 :class:`~.loop.AgentLoop` 完成。
这样"改一个 agent 的行为"是改配置，不是改控制流 —— 后者会让每次调整都带上回归
风险。

三条约束写进了类型里，不靠自觉：

* **工具按作用域授予。** 抽取 agent 的动作空间里根本没有出网工具，所以材料里
  写什么诱导都没用 —— 这是间接提示注入的主要防线。
* **技能渐进披露。** 只有 brief 常驻，正文按需载入。
* **评审视角与角色绑定。** 谁产出什么，就该被对应的视角审。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .dag import Difficulty, NodeBudget, NodeMode
from .skills import SkillLibrary


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """一个具名 agent。

    Attributes:
        tool_scope: 工具作用域名。:class:`~.tools.ToolRegistry` 按它授予工具。
        skills: 该角色相关的技能名。载入时机由 loop 决定，不是全量塞。
        critics: 产出后挂哪些评审视角。
        difficulty: 固定档位。``None`` 表示交给难度路由自动决定。
    """

    name: str
    role: str  # 一句话说清这个 agent 负责什么
    mode: NodeMode
    system: str
    tool_scope: str = "readonly"
    skills: tuple[str, ...] = ()
    critics: tuple[str, ...] = ()
    difficulty: Difficulty | None = None
    budget: NodeBudget = field(default_factory=NodeBudget)
    critic_rounds: int = 2
    output_schema: dict[str, Any] | None = None

    def render_system(self, library: SkillLibrary | None = None) -> str:
        """组装系统提示词：角色 + 技能目录（brief，不含正文）。"""
        parts = [self.system.strip()]
        if library is not None and self.skills and (catalog := library.catalog(list(self.skills))):
            parts += ["", catalog]
        return "\n".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name, "role": self.role, "mode": str(self.mode),
            "tool_scope": self.tool_scope, "skills": list(self.skills),
            "critics": list(self.critics),
            "difficulty": str(self.difficulty) if self.difficulty else "auto",
            "budget": {"tokens": self.budget.tokens, "iterations": self.budget.iterations},
        }


class AgentLibrary:
    """具名 agent 的注册表。DAG 节点按名字引用它们。"""

    def __init__(self, agents: list[AgentSpec] | None = None) -> None:
        self._agents: dict[str, AgentSpec] = {a.name: a for a in (agents or [])}

    def register(self, spec: AgentSpec) -> AgentLibrary:
        self._agents[spec.name] = spec
        return self

    def get(self, name: str) -> AgentSpec:
        if name not in self._agents:
            raise KeyError(f"没有名为 {name!r} 的 agent（已注册：{sorted(self._agents)}）")
        return self._agents[name]

    def names(self) -> list[str]:
        return sorted(self._agents)

    def describe(self) -> list[dict[str, Any]]:
        return [self._agents[n].to_dict() for n in self.names()]


# ══════════════════════════════════════════════════════════════════
#  本体建模的内置 agent
# ══════════════════════════════════════════════════════════════════
_BASE = """你在为 FDE 工程师做本体建模，产出会被下游软件直接消费，也会被拿去
跟客户对账。所以有三条不可让步的纪律：

1. **每个断言都要能点回原文。** 引用出处用 `文件名!位置` 的原样格式，不要改写、
   不要简化。拿不出出处的判断，明确标成推断，不要假装有依据。
2. **口径不自行统一。** 同一个字段在两处口径不同时，两处都保留、指出差在哪个轴上，
   交给人拍板。替业务方做主是这个产品最严重的失败。
3. **做不到就说做不到。** 材料里没有的信息不要补全，宁可留空并说明缺什么。"""

_EXTRACTOR_SCHEMA = {
    "type": "object",
    "required": ["objects", "properties", "links"],
    "properties": {
        "objects": {"type": "array", "items": {
            "type": "object",
            "required": ["api_name", "display_name", "source_file", "source_locator"],
            "properties": {
                "api_name": {"type": "string"}, "display_name": {"type": "string"},
                "description": {"type": "string"},
                "source_file": {"type": "string"}, "source_locator": {"type": "string"}}}},
        "properties": {"type": "array", "items": {
            "type": "object",
            "required": ["parent_api_name", "api_name", "display_name", "base_type",
                         "definition", "source_file", "source_locator"],
            "properties": {
                "parent_api_name": {"type": "string"}, "api_name": {"type": "string"},
                "display_name": {"type": "string"},
                "base_type": {"type": "string", "enum": [
                    "STRING", "INTEGER", "DECIMAL", "DATE", "TIMESTAMP", "BOOLEAN", "ENUM"]},
                "definition": {"type": "string"}, "unit": {"type": "string"},
                "required": {"type": "boolean"},
                "source_file": {"type": "string"}, "source_locator": {"type": "string"}}}},
        "links": {"type": "array", "items": {
            "type": "object",
            "required": ["api_name", "from_api_name", "to_api_name", "cardinality",
                         "source_file", "source_locator"],
            "properties": {
                "api_name": {"type": "string"}, "from_api_name": {"type": "string"},
                "to_api_name": {"type": "string"},
                "cardinality": {"type": "string",
                                "enum": ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"]},
                "source_file": {"type": "string"}, "source_locator": {"type": "string"}}}},
    },
}


#: 规则挖掘的产出。业务规则是梳理表里最容易被整段丢掉的内容 —— 它既不是实体也
#: 不是字段，抽取 agent 的 schema 里没有它的位置，模型抽出来也会被静默丢弃。
_RULE_MINER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["rules"],
    "properties": {
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["statement", "kind", "source_file", "source_locator"],
                "properties": {
                    "statement": {"type": "string",
                                  "description": "一条**可判定**的规则，用材料的原话，不要概括成"
                                                 "「需要审批」这种没法执行的话"},
                    "kind": {"type": "string",
                             "enum": ["VALIDATION", "PROCESS", "AUTHORITY",
                                      "CALCULATION", "OTHER"]},
                    "actor": {"type": "string", "description": "承担这条规则的角色"},
                    "applies_to": {"type": "array", "items": {"type": "string"},
                                   "description": "这条规则约束的业务对象名；拿不准就留空，"
                                                  "留空会转成反问，猜错则会污染模型"},
                    "source_file": {"type": "string"},
                    "source_locator": {"type": "string"},
                },
            },
        },
    },
}


def _array(item: dict[str, Any]) -> dict[str, Any]:
    """Keep the FDE output contracts readable without weakening their item schema."""
    return {"type": "array", "items": item}


_REFS = _array({"type": "string", "minLength": 1})

_INTERVIEWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["engagement", "findings", "questions"],
    "properties": {
        "engagement": {
            "type": "object",
            "required": [
                "objective", "in_scope", "out_of_scope", "stakeholders", "systems",
                "acceptance_criteria",
            ],
            "properties": {
                "objective": {"type": "string", "minLength": 1},
                "in_scope": _array({"type": "string", "minLength": 1}),
                "out_of_scope": _array({"type": "string", "minLength": 1}),
                "stakeholders": _array({
                    "type": "object",
                    "required": ["role", "decision_right"],
                    "properties": {
                        "role": {"type": "string", "minLength": 1},
                        "person": {"type": ["string", "null"]},
                        "decision_right": {"type": "string", "minLength": 1},
                    },
                }),
                "systems": _array({
                    "type": "object",
                    "required": ["id", "name", "authority"],
                    "properties": {
                        "id": {"type": "string", "minLength": 1},
                        "name": {"type": "string", "minLength": 1},
                        "authority": {"type": "string", "enum": [
                            "SYSTEM_OF_RECORD", "REPLICA", "WORKFLOW", "UNKNOWN",
                        ]},
                    },
                }),
                "acceptance_criteria": _array({"type": "string", "minLength": 1}),
            },
        },
        "findings": _array({
            "type": "object",
            "required": ["statement", "epistemic_status", "evidence_ids"],
            "properties": {
                "statement": {"type": "string", "minLength": 1},
                "epistemic_status": {"type": "string", "enum": [
                    "FACT", "ASSUMPTION", "UNKNOWN",
                ]},
                "evidence_ids": _REFS,
            },
        }),
        "questions": _array({
            "type": "object",
            "required": [
                "id", "text", "audience_role", "priority", "answer_schema",
                "blocked_artifacts", "evidence_ids",
            ],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "text": {"type": "string", "minLength": 1},
                "audience_role": {"type": "string", "minLength": 1},
                "owner_user_id": {"type": ["string", "null"]},
                "priority": {"type": "string", "enum": [
                    "BLOCKING", "HIGH", "NORMAL", "LOW",
                ]},
                "answer_schema": {"type": "object"},
                "blocked_artifacts": _REFS,
                "evidence_ids": _REFS,
            },
        }),
    },
}

_PROCESS_MODELER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["process_id", "perspective", "steps", "edges", "gaps"],
    "properties": {
        "process_id": {"type": "string", "minLength": 1},
        "perspective": {"type": "string", "enum": ["AS_IS", "TO_BE"]},
        "steps": _array({
            "type": "object",
            "required": [
                "id", "name", "actor_role", "input_data_ids", "output_data_ids",
                "system_ids", "evidence_ids",
            ],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "name": {"type": "string", "minLength": 1},
                "actor_role": {"type": "string", "minLength": 1},
                "trigger": {"type": ["string", "null"]},
                "precondition": {"type": ["string", "null"]},
                "input_data_ids": _REFS,
                "output_data_ids": _REFS,
                "system_ids": _REFS,
                "evidence_ids": _REFS,
            },
        }),
        "edges": _array({
            "type": "object",
            "required": ["id", "from", "to", "kind", "event_or_condition"],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "from": {"type": "string", "minLength": 1},
                "to": {"type": "string", "minLength": 1},
                "kind": {"type": "string", "enum": [
                    "SEQUENCE", "CONDITIONAL", "EXCEPTION", "TIMEOUT", "CANCEL",
                ]},
                "event_or_condition": {"type": "string"},
            },
        }),
        "gaps": _REFS,
    },
}

_ERP_MAPPER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["landscape", "mappings", "questions"],
    "properties": {
        "landscape": _array({
            "type": "object",
            "required": ["system_id", "product", "version", "module", "org_scope"],
            "properties": {
                "system_id": {"type": "string", "minLength": 1},
                "product": {"type": "string", "minLength": 1},
                "version": {"type": ["string", "null"]},
                "module": {"type": ["string", "null"]},
                "org_scope": {"type": ["string", "null"]},
            },
        }),
        "mappings": _array({
            "type": "object",
            "required": [
                "process_step_id", "system_id", "implementation_kind", "target_refs",
                "confidence", "evidence_ids",
            ],
            "properties": {
                "process_step_id": {"type": "string", "minLength": 1},
                "system_id": {"type": "string", "minLength": 1},
                "implementation_kind": {"type": "string", "enum": [
                    "STANDARD", "CONFIGURATION", "ENHANCEMENT", "CUSTOM", "EXTERNAL",
                    "UNKNOWN",
                ]},
                "target_refs": _REFS,
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "evidence_ids": _REFS,
            },
        }),
        "questions": _REFS,
    },
}

_RULE_ENGINEER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["rules", "conflicts", "questions"],
    "properties": {
        "rules": _array({
            "type": "object",
            "required": [
                "id", "kind", "trigger_event_id", "applies_to_ids", "condition",
                "effect", "exceptions", "evidence_ids", "test_cases",
            ],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "kind": {"type": "string", "enum": [
                    "VALIDATION", "PROCESS", "AUTHORITY", "CALCULATION", "DERIVATION",
                ]},
                "trigger_event_id": {"type": ["string", "null"]},
                "applies_to_ids": _REFS,
                "condition": {"type": "string", "minLength": 1},
                "effect": {"type": "string", "minLength": 1},
                "exceptions": _array({"type": "string"}),
                "evidence_ids": _REFS,
                "test_cases": _array({
                    "type": "object",
                    "required": ["kind", "given", "expected"],
                    "properties": {
                        "kind": {"type": "string", "enum": [
                            "POSITIVE", "BOUNDARY", "NEGATIVE", "EXCEPTION",
                        ]},
                        "given": {"type": "object"},
                        "expected": {},
                    },
                }),
            },
        }),
        "conflicts": _REFS,
        "questions": _REFS,
    },
}

_DATA_STEWARD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["data_objects", "quality_rules", "questions"],
    "properties": {
        "data_objects": _array({
            "type": "object",
            "required": [
                "id", "name", "classification", "business_keys", "system_of_record",
                "owner_role", "lifecycle_states", "sensitivity", "evidence_ids",
            ],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "name": {"type": "string", "minLength": 1},
                "classification": {"type": "string", "enum": [
                    "BUSINESS_OBJECT", "DOCUMENT", "MASTER_DATA", "TRANSACTION",
                    "DERIVED_DATA",
                ]},
                "business_keys": _REFS,
                "system_of_record": {"type": ["string", "null"]},
                "owner_role": {"type": ["string", "null"]},
                "lifecycle_states": _REFS,
                "sensitivity": {"type": "string", "enum": [
                    "PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "UNKNOWN",
                ]},
                "evidence_ids": _REFS,
            },
        }),
        "quality_rules": _array({
            "type": "object",
            "required": ["id", "data_object_id", "dimension", "expression", "threshold"],
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "data_object_id": {"type": "string", "minLength": 1},
                "dimension": {"type": "string", "enum": [
                    "COMPLETENESS", "UNIQUENESS", "VALIDITY", "CONSISTENCY", "TIMELINESS",
                ]},
                "expression": {"type": "string", "minLength": 1},
                "threshold": {"type": "number"},
            },
        }),
        "questions": _REFS,
    },
}

_DELIVERY_REVIEWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["verdict", "blockers", "warnings", "traceability", "artifact_checks"],
    "properties": {
        "verdict": {"type": "string", "enum": ["PASS", "BLOCKED"]},
        "blockers": _array({
            "type": "object",
            "required": ["code", "message", "owner_role", "artifact_ids"],
            "properties": {
                "code": {"type": "string", "minLength": 1},
                "message": {"type": "string", "minLength": 1},
                "owner_role": {"type": "string", "minLength": 1},
                "artifact_ids": _REFS,
            },
        }),
        "warnings": _array({"type": "string", "minLength": 1}),
        "traceability": {
            "type": "object",
            "required": ["checked", "unresolved"],
            "properties": {
                "checked": {"type": "integer", "minimum": 0},
                "unresolved": _REFS,
            },
        },
        "artifact_checks": _array({
            "type": "object",
            "required": ["artifact_id", "schema_valid", "downloadable"],
            "properties": {
                "artifact_id": {"type": "string", "minLength": 1},
                "schema_valid": {"type": "boolean"},
                "downloadable": {"type": "boolean"},
            },
        }),
    },
}

BUILTIN_AGENTS = [
    AgentSpec(
        name="extractor",
        role="从异构材料里抽出 ObjectType / PropertyType / LinkType 候选",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

抽取时注意：
- 物理名（DDL 里的表列名）与业务名（梳理表里的中文）指同一个东西时，物理名进
  apiName，业务名进 displayName，不要抽成两个对象。
- **DDL 的行内注释和 Excel 的单元格批注是口径的主要来源**，务必读进 definition。
  两张表的同名字段类型完全一样、只有注释不同，这正是要抓的情况。
- 外键暗示基数：`clm_contract.plan_id → pbp_header.plan_id` 说明
  pbp_header 一对多 clm_contract。但流程说明里若写了"可拆入多个"，那是矛盾，
  两边都抽出来，不要挑一个。""",
        tool_scope="extract",
        skills=("口径对齐", "命名归一"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=120_000, iterations=6, wallclock_s=600),
        output_schema=_EXTRACTOR_SCHEMA,
    ),
    AgentSpec(
        name="rule_miner",
        role="从散文段落里挖出可判定的业务规则，并挂到它约束的对象上",
        mode=NodeMode.REACT,
        system=_BASE + """

你面对的是整段整段的中文散文 —— 岗位职责、流程说明、约束清单。这里**没有实体表**，
不要试图从中抽对象和字段。

挖规则的标准只有一条：**它是否可判定**。
- 「采购包创建后不能修改采购方式」可判定 → 抽。
- 「需要规范管理采购流程」不可判定 → 不抽，它是目标不是规则。
- 一段话里塞了六条编号规则，就抽成六条，不要合成一条。

规则要挂到它约束的对象上，但**只有材料里点了名的才挂**。凭语义猜"这条大概是说
采购包的"会把错误的约束焊死在错误的对象上，比不挂更糟 —— 留空会变成一个反问，
挂错不会。""",
        tool_scope="extract",
        skills=("口径对齐",),
        critics=("provenance",),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=40_000, iterations=4, wallclock_s=420),
        output_schema=_RULE_MINER_SCHEMA,
    ),
    AgentSpec(
        name="aligner",
        role="把多份材料里指向同一概念的不同名字合并成一个实体",
        mode=NodeMode.REACT,
        system=_BASE + """

对齐要靠**结构证据**（主键类型、字段重叠、行数量级），名字相似只是辅证。
只有名字像、结构对不上的，标为存疑交人判 —— 错误合并会把两个对象的属性混在
一起，之后极难拆开。""",
        tool_scope="align",
        skills=("实体对齐", "命名归一"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=80_000, iterations=8),
    ),
    AgentSpec(
        name="conflict_hunter",
        role="判定规则查不出来的语义冲突：口径矛盾、语义重复、疑似敷衍",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

规则能查的（必填缺失、命名违规、枚举越界、类型不符）已经由确定性代码处理完了，
**不要重复报**。你只判断规则表达不了的：

- 两段口径描述是不是真的矛盾，差在哪个轴上
- 两个对象是不是同一个概念的重复
- 填写内容是不是敷衍（抄列名、复读预填值、占位符）

跨行分布的问题（这列取值是不是异常、有没有偏态）**用 profile.column 工具查**，
不要自己看几个样本推断 —— 那类判断你做不可靠。""",
        tool_scope="analyze",
        skills=("口径对齐",),
        critics=("provenance",),
        difficulty=Difficulty.CRITICAL,
        budget=NodeBudget(tokens=100_000, iterations=6),
        critic_rounds=3,
    ),
    AgentSpec(
        name="clarifier",
        role="把冲突排序成最值得问 FDE 的 3 个建模决策",
        mode=NodeMode.SINGLE_SHOT,
        system=_BASE + """

FDE 的注意力是稀缺资源。问 10 个平庸问题比问 3 个关键问题效果更差、体验也更差。

每个问题必须：给出 2~4 个具体选项、每个选项附证据出处、说清影响多少个实体、
标明可逆还是不可逆。**给不出出处的选项等于让人凭感觉拍板，那还不如不问。**""",
        tool_scope="readonly",
        skills=("口径对齐", "ActionType反推"),
        critics=(),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=60_000, iterations=2),
    ),
    AgentSpec(
        name="action_drafter",
        role="从 OpenAPI 写端点反推 ActionType 草稿",
        mode=NodeMode.CODEACT,
        system=_BASE + """

只用写操作端点。每条草稿标 DRAFT_FROM_API，带上 JSON Pointer 出处。
草稿未经业务确认不算数，这一点要在产物里写清楚。""",
        tool_scope="extract",
        skills=("ActionType反推",),
        critics=("schema", "provenance"),
        difficulty=Difficulty.MEDIUM,
        budget=NodeBudget(tokens=60_000, iterations=5),
    ),
    AgentSpec(
        name="auditor",
        role="审业务方回传的模板，判定口径矛盾与疑似敷衍",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

锚点对齐、必填缺失、枚举越界、命名违规、完成度计算都由确定性代码做完了。
你只做两件规则做不了的事：

1. 回传后新产生的口径矛盾 —— 两个人各填各的，轴上冲突了
2. 疑似敷衍的最终判定 —— 启发式已经收窄了候选，你判断这格到底是敷衍还是
   真的就该这么填（有些字段填"无"是对的）

**别误伤。** 把认真填的判成敷衍，会直接摧毁业务方对这套流程的配合意愿。""",
        tool_scope="analyze",
        skills=("回传审核", "口径对齐"),
        critics=("provenance",),
        difficulty=Difficulty.CRITICAL,
        budget=NodeBudget(tokens=150_000, iterations=8),
        critic_rounds=3,
    ),
    AgentSpec(
        name="fde_interviewer",
        role="Interviewer：建立前线访谈范围基线，并把未知项路由成可回答的问题",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

你是 FDE 的访谈副驾，不是假装熟悉客户业务的顾问。先区分事实、假设和未知，再提问。
每个问题只解决一个决策，要写明应答角色、回答结构、证据、被阻塞产物与优先级。
业务方没有明确授权时，不替他确认 AS-IS，不把产品建议写成业务事实。""",
        tool_scope="interview",
        skills=("访谈盘点", "缺口追问路由"),
        critics=("provenance",),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=70_000, iterations=5),
        output_schema=_INTERVIEWER_SCHEMA,
    ),
    AgentSpec(
        name="process_modeler",
        role="Process Modeler：把访谈与材料建成可追溯的 AS-IS/TO-BE 流程",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

你负责流程语义，不负责替业务做优化决策。步骤、参与者、输入输出、系统、事件、网关、
异常与证据必须显式；流程图与结构化输出必须共用稳定 ID。发现缺口就列出，不脑补。""",
        tool_scope="process_model",
        skills=("流程建模", "缺口追问路由"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=90_000, iterations=6),
        output_schema=_PROCESS_MODELER_SCHEMA,
    ),
    AgentSpec(
        name="erp_mapper",
        role="ERP Mapper：把业务步骤与对象映射到 ERP 模块、交易、接口和字段",
        mode=NodeMode.REACT,
        system=_BASE + """

ERP 产品、版本与组织范围不明确时必须留空并向 ERP 顾问提问。只有材料能证明时才填写
交易码、表字段或客制实现；标准、配置、增强、客制、外部系统必须分开。""",
        tool_scope="erp_map",
        skills=("ERP映射", "缺口追问路由"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.CRITICAL,
        budget=NodeBudget(tokens=100_000, iterations=7),
        critic_rounds=3,
        output_schema=_ERP_MAPPER_SCHEMA,
    ),
    AgentSpec(
        name="rule_engineer",
        role="Rule Engineer：把业务口径写成可判定、可追溯、可测试的 Rules",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

不可判定的目标不是规则。复合句必须拆成原子规则；每条规则要绑定触发 Event、受约束
对象、条件、效果、例外、证据和测试。规则优先级冲突要保留并转成问题。""",
        tool_scope="rule_engineering",
        skills=("规则结构化", "口径对齐", "缺口追问路由"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.CRITICAL,
        budget=NodeBudget(tokens=90_000, iterations=6),
        critic_rounds=3,
        output_schema=_RULE_ENGINEER_SCHEMA,
    ),
    AgentSpec(
        name="data_steward",
        role="Data Steward：治理 DataObject 的身份、生命周期、质量、敏感性与权威源",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

业务对象不等于数据库表。你要定义业务键、状态机、System of Record、责任人、质量规则
与访问分类。敏感性或权威源没有证据时形成问题，不用常识自动分级。""",
        tool_scope="data_governance",
        skills=("数据对象治理", "实体对齐", "缺口追问路由"),
        critics=("schema", "provenance"),
        difficulty=Difficulty.HIGH,
        budget=NodeBudget(tokens=90_000, iterations=6),
        output_schema=_DATA_STEWARD_SCHEMA,
    ),
    AgentSpec(
        name="delivery_reviewer",
        role="Reviewer：独立审查流程、本体、决策、证据和可下载交付件是否一致",
        mode=NodeMode.PLAN_EXECUTE,
        system=_BASE + """

你是交付质量门，不参与补写业务事实。先读确定性校验结果，再做跨产物追溯审查。
任一 blocking finding 必须有代码、影响产物和责任角色；阻断未清零就不得判 PASS。""",
        tool_scope="delivery_review",
        skills=("交付审查",),
        critics=("schema", "provenance"),
        difficulty=Difficulty.CRITICAL,
        budget=NodeBudget(tokens=80_000, iterations=5),
        critic_rounds=3,
        output_schema=_DELIVERY_REVIEWER_SCHEMA,
    ),
]

#: 工具作用域 → 该作用域能用哪些工具。抽取 agent 拿不到写工具，
#: 分析 agent 拿不到沙箱以外的执行能力。
TOOL_SCOPES: dict[str, tuple[str, ...]] = {
    "readonly": ("evidence.search", "evidence.rows", "oir.query"),
    "extract": ("evidence.search", "evidence.rows", "oir.query", "profile.column"),
    "align": ("evidence.search", "evidence.rows", "oir.query", "profile.column"),
    "analyze": ("evidence.search", "evidence.rows", "oir.query", "profile.column",
                "code.exec"),
    "compile": ("oir.query", "code.exec"),
    # FDE engagement 角色只读证据/中间表示。修改与导出由 DAG 中的
    # 确定性 handler 执行，不给读取客户材料的 agent 任意 code.exec 权限。
    "interview": ("evidence.search", "evidence.rows", "oir.query"),
    "process_model": ("evidence.search", "evidence.rows", "oir.query"),
    "erp_map": ("evidence.search", "evidence.rows", "oir.query", "profile.column"),
    "rule_engineering": ("evidence.search", "evidence.rows", "oir.query"),
    "data_governance": (
        "evidence.search", "evidence.rows", "oir.query", "profile.column",
    ),
    "delivery_review": ("evidence.search", "evidence.rows", "oir.query"),
}


def default_agents() -> AgentLibrary:
    return AgentLibrary(list(BUILTIN_AGENTS))
