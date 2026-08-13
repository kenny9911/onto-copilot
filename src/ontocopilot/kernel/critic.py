"""Critic 与 Gate —— 产物出门前的最后一道关。

**分工纪律（架构文档 ADR-5）**：可规则化的判断一律不给 LLM。必填缺失、命名
规范、类型合法性、引用完整性走确定性规则 —— 又快又准又免费，而且没有方差。
只有规则表达不了的（口径矛盾、疑似敷衍、语义重复）才交模型。

**偏差缓解**（LLM-as-judge 综述 arXiv:2411.15594、位置偏差 arXiv:2406.07791）：

  * rubric 化打分 —— 每条 0/1 判定，不给自由分值，压住冗长偏差；
  * 生成模型 ≠ 评委模型 —— 由 :meth:`~.llm.RoutingTable.judge_for` 强制；
  * CRITICAL 档三采样多数票，压方差；
  * 批判必须写明 ``evidence_checked`` 与 ``verifier`` —— 工具交互式批判
    （CRITIC, arXiv:2305.11738）比纯自省可靠。
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar

from .errors import NodeFailure
from .events import EventKind
from .llm import ModelGateway, ModelSpec
from .recorder import Recorder


class Severity(StrEnum):
    HIGH = "high"  # 阻断发布
    MEDIUM = "medium"  # 需处置，可打回
    LOW = "low"  # 提示


@dataclass(slots=True)
class Finding:
    """一条批判。字段是契约，不是建议 —— 缺 ``evidence_checked`` 的批判无效。"""

    severity: Severity
    code: str  # EVIDENCE_MISSING / NAMING_VIOLATION / …
    target: str  # 被批判对象的 rid 或路径
    claim: str  # 一句话说清问题
    evidence_checked: list[str] = field(default_factory=list)
    proposed_fix: dict[str, Any] | None = None
    verifier: str = ""  # 用什么核实的：规则名 / 工具名 / "llm"

    def to_dict(self) -> dict[str, Any]:
        return {
            "severity": str(self.severity), "code": self.code, "target": self.target,
            "claim": self.claim, "evidence_checked": self.evidence_checked,
            "proposed_fix": self.proposed_fix, "verifier": self.verifier,
        }


@dataclass(slots=True)
class Verdict:
    lens: str
    passed: bool
    findings: list[Finding] = field(default_factory=list)
    note: str = ""

    @property
    def high(self) -> int:
        return sum(1 for f in self.findings if f.severity is Severity.HIGH)

    def to_dict(self) -> dict[str, Any]:
        return {
            "lens": self.lens, "passed": self.passed, "high": self.high,
            "findings": [f.to_dict() for f in self.findings], "note": self.note,
        }


# ══════════════════════════════════════════════════════════════════
#  Critic
# ══════════════════════════════════════════════════════════════════
class Critic(ABC):
    """一个评审视角。"""

    name: str = "critic"
    #: 是否需要模型。预算降到 RULES_ONLY 时，需要模型的视角会被跳过。
    needs_llm: bool = False

    @abstractmethod
    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict: ...


@dataclass(slots=True)
class CriticContext:
    """评审时能拿到的东西。"""

    node_id: str
    gateway: ModelGateway
    generator: ModelSpec
    evidence_render: str = ""
    facts: str = ""  # 黑板事实
    rules: str = ""  # 项目建模规范
    samples: int = 1  # 多采样自洽次数


class RuleCritic(Critic):
    """确定性规则视角。

    ``check`` 是一个纯函数：拿到 draft，返回 findings。不调模型、不看上下文 ——
    这保证它零成本、零方差、可在任何降级级别下运行。
    """

    needs_llm = False

    def __init__(self, name: str, check: Callable[[Any], list[Finding]]) -> None:
        self.name = name
        self._check = check

    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict:
        findings = self._check(draft)
        return Verdict(
            lens=self.name,
            passed=not any(f.severity is Severity.HIGH for f in findings),
            findings=findings,
            note=f"规则视角 · {len(findings)} 条",
        )


class LLMCritic(Critic):
    """语义视角。用异构评委 + rubric 打分。

    Args:
        rubric: 逐条 0/1 的检查项。**不要写"整体质量如何"这种题** —— 那正是
            冗长偏差的入口。
    """

    needs_llm = True

    def __init__(self, name: str, rubric: Sequence[str], *, instruction: str = "") -> None:
        self.name = name
        self.rubric = list(rubric)
        self.instruction = instruction

    _SCHEMA: ClassVar[dict[str, Any]] = {
        "type": "object",
        "required": ["checks", "findings"],
        "properties": {
            "checks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["item", "pass"],
                    "properties": {
                        "item": {"type": "string"},
                        "pass": {"type": "boolean"},
                        "why": {"type": "string"},
                    },
                },
            },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["severity", "code", "target", "claim", "evidence_checked"],
                    "properties": {
                        "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                        "code": {"type": "string"},
                        "target": {"type": "string"},
                        "claim": {"type": "string"},
                        "evidence_checked": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
        },
    }

    def _prompt(self, draft: Any) -> str:
        import json

        items = "\n".join(f"{i + 1}. {r}" for i, r in enumerate(self.rubric))
        return (
            f"你是 {self.name} 视角的评审。逐条判定下面每个检查项通过与否，"
            f"不要给总体评分、不要评论文风。\n\n"
            f"## 检查项\n{items}\n\n"
            f"## 项目规范\n{self.instruction or '（无额外规范）'}\n\n"
            f"## 已知事实\n{'（无）'}\n\n"
            f"## 待审产物\n{json.dumps(draft, ensure_ascii=False, default=str)[:20000]}\n\n"
            "每条不通过的检查项都要产出一条 finding，且 evidence_checked 必须"
            "填你实际核对过的出处（文件!位置）。核对不到出处就把 severity 标 high、"
            "code 填 EVIDENCE_MISSING。"
        )

    async def judge(self, draft: Any, ctx: CriticContext) -> Verdict:
        prompt = self._prompt(draft)
        if ctx.evidence_render:
            prompt += f"\n\n## 可核对的证据\n{ctx.evidence_render[:20000]}"

        # 多采样多数票：CRITICAL 档压方差用。
        results = await asyncio.gather(*[
            ctx.gateway.judge(
                ctx.node_id, prompt, generator=ctx.generator,
                schema=self._SCHEMA, salt=i, key=f"critic:{self.name}:{i}",
            )
            for i in range(max(1, ctx.samples))
        ])

        votes = [r.data for r in results if r.data]
        if not votes:
            return Verdict(lens=self.name, passed=False,
                           findings=[Finding(Severity.HIGH, "CRITIC_FAILED", "-",
                                             "评委未返回可解析结果", verifier="llm")])

        # 多数票：一条检查项过半数判失败才算失败
        fail_counts: dict[str, int] = {}
        for v in votes:
            for c in v.get("checks", ()):
                if not c.get("pass", True):
                    fail_counts[c["item"]] = fail_counts.get(c["item"], 0) + 1
        threshold = len(votes) / 2
        failed = {k for k, n in fail_counts.items() if n > threshold}

        findings: list[Finding] = []
        seen: set[tuple[str, str]] = set()
        for v in votes:
            for f in v.get("findings", ()):
                sig = (f["code"], f["target"])
                if sig in seen:
                    continue
                seen.add(sig)
                findings.append(Finding(
                    severity=Severity(f["severity"]), code=f["code"], target=f["target"],
                    claim=f["claim"], evidence_checked=list(f.get("evidence_checked", ())),
                    verifier="llm",
                ))

        return Verdict(
            lens=self.name,
            passed=not failed and not any(f.severity is Severity.HIGH for f in findings),
            findings=findings,
            note=f"{len(votes)} 票；未通过检查项 {len(failed)}/{len(self.rubric)}",
        )


# ══════════════════════════════════════════════════════════════════
#  Panel
# ══════════════════════════════════════════════════════════════════
class CriticPanel:
    """多视角并行评审。

    四个视角互相独立，可并行 —— 延迟等于最慢的一个，不是四个之和。多视角比
    多次同质自省更有效（MAR, arXiv:2512.20845）。
    """

    def __init__(self, critics: dict[str, Critic], recorder: Recorder) -> None:
        self.critics = critics
        self.rec = recorder

    def validate(self, lenses: Sequence[str], node_id: str) -> None:
        """Reject misspelled/unregistered lenses before any critic spends work."""
        unknown = list(dict.fromkeys(name for name in lenses if name not in self.critics))
        if unknown:
            raise NodeFailure(
                node_id,
                f"未注册的 critic: {', '.join(unknown)}",
                retryable=False,
            )

    async def judge(
        self, draft: Any, lenses: Sequence[str], ctx: CriticContext, *, allow_llm: bool = True
    ) -> list[Verdict]:
        # A misspelled critic used to disappear silently here.  That is a control-plane
        # configuration error, not a successful review: the resulting empty verdict set
        # also made ``all([])`` pass every downstream gate.  Reject the whole panel before
        # running any (potentially paid) critic so the failure is deterministic and cheap.
        self.validate(lenses, ctx.node_id)

        picked = []
        skipped = []
        for name in lenses:
            c = self.critics.get(name)
            # ``unknown`` was rejected above; keeping the assertion local makes a future
            # refactor fail closed instead of accidentally restoring the silent skip.
            assert c is not None
            if c.needs_llm and not allow_llm:
                skipped.append(name)  # 预算降级：跳过并记账，绝不静默
                continue
            picked.append(c)

        verdicts = list(await asyncio.gather(*(c.judge(draft, ctx) for c in picked)))

        for v in verdicts:
            self.rec.emit(EventKind.CRITIC_VERDICT, node_id=ctx.node_id, payload=v.to_dict())
        if skipped:
            self.rec.emit(
                EventKind.DEGRADED, node_id=ctx.node_id,
                payload={"skipped_critics": skipped, "reason": "预算不足，未做语义审核"},
            )
        return verdicts


# ══════════════════════════════════════════════════════════════════
#  Gate
# ══════════════════════════════════════════════════════════════════
class Decision(StrEnum):
    PASS = "pass"
    REVISE = "revise"  # 回到 loop 再修一轮
    ASK_USER = "ask_user"  # 需要人决策
    ROUND_TRIP = "round_trip"  # 打回业务方
    AUTO_REPAIR = "auto_repair"  # 可自动修
    ABORT = "abort"


@dataclass(slots=True)
class GateResult:
    decision: Decision
    reason: str
    detail: dict[str, Any] = field(default_factory=dict)


class Gate:
    """DAG 上的阻断点。

    ``require`` 是一组断言函数，全过才 PASS；不过则由 ``on_fail`` 决定去向。
    刻意不做表达式字符串解析 —— 判定逻辑用 Python 函数写，可测试、可打断点。
    """

    def __init__(
        self,
        name: str,
        require: Sequence[tuple[str, Callable[[dict[str, Any]], bool]]],
        on_fail: Callable[[dict[str, Any]], GateResult],
    ) -> None:
        self.name = name
        self.require = list(require)
        self.on_fail = on_fail

    def evaluate(self, metrics: dict[str, Any], rec: Recorder, node_id: str) -> GateResult:
        failed = [label for label, pred in self.require if not pred(metrics)]
        result = (
            GateResult(Decision.PASS, "全部硬门通过")
            if not failed
            else self.on_fail({**metrics, "failed": failed})
        )
        rec.emit(
            EventKind.GATE_EVALUATED, node_id=node_id,
            payload={"gate": self.name, "decision": str(result.decision),
                     "reason": result.reason, "failed": failed},
        )
        return result


def metrics_from(verdicts: Sequence[Verdict]) -> dict[str, Any]:
    """把评审结果压成 Gate 能判的指标。"""
    return {
        # An empty panel is "unreviewed", not a vacuous success.  Deterministic nodes
        # that intentionally have no critics can still use an empty-requirement gate;
        # a gate asserting ``all_passed`` now correctly demands at least one verdict.
        "review_count": len(verdicts),
        "all_passed": bool(verdicts) and all(v.passed for v in verdicts),
        "high_findings": sum(v.high for v in verdicts),
        "total_findings": sum(len(v.findings) for v in verdicts),
        "by_lens": {v.lens: v.passed for v in verdicts},
        "high_by_lens": {v.lens: v.high for v in verdicts},
        "findings_by_lens": {v.lens: len(v.findings) for v in verdicts},
        "codes": sorted({f.code for v in verdicts for f in v.findings}),
    }
