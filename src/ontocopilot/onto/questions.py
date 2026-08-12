"""FDE 访谈中的统一 Question / Decision / Revision 领域契约。

现有产品有两套问题：OIR ``OpenQuestion`` 与 conflict 澄清卡。本模块不删除它们，
而是提供一个稳定的兼容层，把两者投影进同一份 :class:`QuestionBacklog`。答案不会
直接覆盖问题文本，而是 append-only 地写进 :class:`DecisionLedger`；修改则表示为
基于明确版本的 :class:`PatchSet` / :class:`Revision`。

模块只含纯领域逻辑，不依赖 FastAPI、数据库或模型，因而可以在 API、Agent DAG、
CLI 与测试里共同使用。持久化 DTO 在 ``store.repo``，两层通过 ``to_dict/from_dict``
的 JSON 契约解耦。
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "AnswerValidationError", "Decision", "DecisionLedger", "IdempotencyConflict",
    "PatchOp", "PatchSet", "Question", "QuestionBacklog", "QuestionPriority",
    "QuestionStatus", "QuestionTransitionError", "Revision", "RevisionConflict",
    "RevisionStatus", "answer_question", "build_question_backlog",
]


SCHEMA_VERSION = "1.0.0"


class QuestionStatus(StrEnum):
    OPEN = "open"
    ASSIGNED = "assigned"
    BLOCKED = "blocked"
    ANSWERED = "answered"
    DEFERRED = "deferred"
    CANCELLED = "cancelled"


class QuestionPriority(StrEnum):
    BLOCKING = "blocking"
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class RevisionStatus(StrEnum):
    PROPOSED = "proposed"
    APPLIED = "applied"
    REJECTED = "rejected"
    ROLLED_BACK = "rolled_back"


class QuestionTransitionError(ValueError):
    """问题状态转换不合法。"""


class AnswerValidationError(ValueError):
    """回答不符合问题的 ``answerSchema``。"""


class IdempotencyConflict(ValueError):
    """同一幂等键被用于不同的业务动作。"""


class RevisionConflict(ValueError):
    """PatchSet 的 base revision 不是当前 revision。"""


_TRANSITIONS: dict[QuestionStatus, frozenset[QuestionStatus]] = {
    QuestionStatus.OPEN: frozenset({
        QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED, QuestionStatus.ANSWERED,
        QuestionStatus.DEFERRED, QuestionStatus.CANCELLED,
    }),
    QuestionStatus.ASSIGNED: frozenset({
        QuestionStatus.OPEN, QuestionStatus.BLOCKED, QuestionStatus.ANSWERED,
        QuestionStatus.DEFERRED, QuestionStatus.CANCELLED,
    }),
    QuestionStatus.BLOCKED: frozenset({
        QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.DEFERRED,
        QuestionStatus.CANCELLED,
    }),
    # 答案被判无效、依赖事实变化时允许显式 reopen；历史 Decision 仍保留。
    QuestionStatus.ANSWERED: frozenset({QuestionStatus.OPEN, QuestionStatus.CANCELLED}),
    QuestionStatus.DEFERRED: frozenset({
        QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.CANCELLED,
    }),
    QuestionStatus.CANCELLED: frozenset({QuestionStatus.OPEN}),
}


def _now() -> float:
    return time.time()


def _value(raw: Any) -> Any:
    """读取 Assertion.to_dict() 或普通 JSON 的值。"""
    return raw.get("value") if isinstance(raw, Mapping) and "value" in raw else raw


def _as_status(raw: Any, *, answered: bool = False, owner: str = "") -> QuestionStatus:
    if answered:
        return QuestionStatus.ANSWERED
    aliases = {
        "candidate": QuestionStatus.OPEN,
        "confirmed": QuestionStatus.ANSWERED,
        "rejected": QuestionStatus.CANCELLED,
    }
    try:
        status = aliases.get(str(raw or "").lower()) or QuestionStatus(str(raw or "open"))
    except ValueError:
        status = QuestionStatus.OPEN
    # 只有遗留 OpenQuestion（没有显式生命周期）才用 owner 推断 ASSIGNED；统一契约
    # 的显式 ``status=open`` 必须 round-trip 原样保留。
    if raw in (None, "") and status is QuestionStatus.OPEN and owner:
        return QuestionStatus.ASSIGNED
    return status


def _as_priority(raw: Any, *, blocking: bool = False) -> QuestionPriority:
    if blocking:
        return QuestionPriority.BLOCKING
    try:
        return QuestionPriority(str(raw or "normal").lower())
    except ValueError:
        return QuestionPriority.NORMAL


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      default=str)


def _digest(prefix: str, value: Any, *, size: int = 20) -> str:
    raw = _canonical_json(value).encode("utf-8")
    return f"{prefix}_{hashlib.sha256(raw).hexdigest()[:size]}"


@dataclass(slots=True)
class Question:
    """一条可路由、可回答、可追踪产物阻塞关系的问题。"""

    id: str
    text: str
    status: QuestionStatus = QuestionStatus.OPEN
    owner_user_id: str = ""
    audience_role: str = ""
    answer_schema: dict[str, Any] = field(default_factory=lambda: {"type": "string"})
    priority: QuestionPriority = QuestionPriority.NORMAL
    dependencies: list[str] = field(default_factory=list)
    blocked_artifacts: list[str] = field(default_factory=list)
    source_kind: str = "manual"
    source_ref: str = ""
    why: str = ""
    options: list[Any] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    scope_refs: list[str] = field(default_factory=list)
    group: str = ""
    code: str = ""
    information_gain: float = 0.0
    blast_radius: int = 0
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)
    version: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def terminal(self) -> bool:
        return self.status in {QuestionStatus.ANSWERED, QuestionStatus.CANCELLED}

    @property
    def blocking(self) -> bool:
        return self.priority is QuestionPriority.BLOCKING or bool(self.blocked_artifacts)

    def ready(self, resolved_question_ids: Iterable[str]) -> bool:
        """依赖都已关闭且自身可进入访谈批次。"""
        if self.status not in {QuestionStatus.OPEN, QuestionStatus.ASSIGNED}:
            return False
        return set(self.dependencies).issubset(set(resolved_question_ids))

    def transition(self, target: QuestionStatus | str, *, now: float | None = None) -> None:
        target = QuestionStatus(target)
        if target is self.status:
            return
        if target not in _TRANSITIONS[self.status]:
            raise QuestionTransitionError(f"问题 {self.id} 不能从 {self.status} 转为 {target}")
        if target is QuestionStatus.ASSIGNED and not self.owner_user_id:
            raise QuestionTransitionError(f"问题 {self.id} 分派前必须指定 owner_user_id")
        self.status = target
        self.updated_at = now or _now()
        self.version += 1

    def assign(self, owner_user_id: str, *, audience_role: str | None = None,
               now: float | None = None) -> None:
        owner_user_id = owner_user_id.strip()
        if not owner_user_id:
            raise ValueError("owner_user_id 不能为空")
        if self.status in {QuestionStatus.ANSWERED, QuestionStatus.CANCELLED}:
            raise QuestionTransitionError(f"终态问题 {self.id} 不能直接分派，请先 reopen")
        self.owner_user_id = owner_user_id
        if audience_role is not None:
            self.audience_role = audience_role.strip()
        if self.status is not QuestionStatus.ASSIGNED:
            self.transition(QuestionStatus.ASSIGNED, now=now)
        else:
            self.updated_at = now or _now()
            self.version += 1

    def validate_answer(self, answer: Any) -> None:
        _validate_answer(answer, self.answer_schema, path="$answer")

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": "ontocopilot.question/1", "schemaVersion": SCHEMA_VERSION,
            "id": self.id, "text": self.text, "status": str(self.status),
            "ownerUserId": self.owner_user_id, "audienceRole": self.audience_role,
            "answerSchema": self.answer_schema, "priority": str(self.priority),
            "dependencies": self.dependencies, "blockedArtifacts": self.blocked_artifacts,
            "sourceKind": self.source_kind, "sourceRef": self.source_ref,
            "why": self.why, "options": self.options, "evidenceIds": self.evidence_ids,
            "scopeRefs": self.scope_refs, "group": self.group, "code": self.code,
            "informationGain": self.information_gain, "blastRadius": self.blast_radius,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
            "version": self.version, "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Question":
        """兼容统一契约、OIR OpenQuestion 与 clarify.Question 的字典。"""
        text_raw = raw.get("text", raw.get("title", raw.get("summary", "")))
        text = str(_value(text_raw) or "")
        answer = _value(raw.get("answer"))
        answered = answer not in (None, "", [], {})
        source_ref = str(raw.get("sourceRef") or raw.get("conflict_rid")
                         or raw.get("conflictRid") or raw.get("rid") or "")
        source_kind = str(raw.get("sourceKind") or (
            "conflict" if raw.get("conflict_rid") or raw.get("conflictRid") else
            "open_question" if raw.get("rid") else "manual"))
        qid = str(raw.get("id") or raw.get("rid") or "")
        if not qid:
            qid = _digest("q", {"source": source_ref, "text": text})
        owner = str(raw.get("ownerUserId") or raw.get("owner") or "")
        status_raw = raw.get("status")
        status = _as_status(status_raw, answered=answered, owner=owner)
        # OIR OpenQuestion 的 ``status=CANDIDATE`` 是建模置信状态，不是任务状态；
        # 有 owner 时在统一队列里应解释成已分派。
        if (source_kind == "open_question" and owner and
                str(status_raw or "").lower() == "candidate"):
            status = QuestionStatus.ASSIGNED
        opts = list(raw.get("options") or [])
        answer_schema = dict(raw.get("answerSchema") or raw.get("answer_schema") or {})
        if not answer_schema:
            # conflict card 的 option 回答是 option id；普通 OpenQuestion 默认为文本。
            if opts and source_kind == "conflict":
                ids = [str(x.get("id")) if isinstance(x, Mapping) else str(x) for x in opts]
                answer_schema = {"type": "string", "enum": ids}
            else:
                answer_schema = {"type": "string"}
        evidence_ids = list(raw.get("evidenceIds") or raw.get("evidence_ids") or [])
        if not evidence_ids and isinstance(text_raw, Mapping):
            for ev in text_raw.get("evidence") or []:
                if isinstance(ev, Mapping):
                    evidence_ids.append(str(ev.get("id") or ev.get("cite")
                                            or ev.get("file_id") or ""))
            evidence_ids = [x for x in evidence_ids if x]
        blocked = list(raw.get("blockedArtifacts") or raw.get("blocked_artifacts") or [])
        return cls(
            id=qid, text=text, status=status, owner_user_id=owner,
            audience_role=str(raw.get("audienceRole") or raw.get("audience_role") or ""),
            answer_schema=answer_schema,
            priority=_as_priority(raw.get("priority"), blocking=bool(blocked)),
            dependencies=list(raw.get("dependencies") or []), blocked_artifacts=blocked,
            source_kind=source_kind, source_ref=source_ref,
            why=str(raw.get("why") or ""), options=opts, evidence_ids=evidence_ids,
            scope_refs=list(raw.get("scopeRefs") or raw.get("scope_refs")
                            or raw.get("appliesTo") or []),
            group=str(raw.get("group") or ""), code=str(raw.get("code") or ""),
            information_gain=float(raw.get("informationGain") or raw.get("score") or 0),
            blast_radius=int(raw.get("blastRadius") or raw.get("impact_count") or 0),
            created_at=float(raw.get("createdAt") or raw.get("created_at") or _now()),
            updated_at=float(raw.get("updatedAt") or raw.get("updated_at") or _now()),
            version=int(raw.get("version") or 0), metadata=dict(raw.get("metadata") or {}),
        )

    @classmethod
    def from_legacy(cls, raw: Any) -> "Question":
        if isinstance(raw, cls):
            return replace(raw)
        if hasattr(raw, "to_dict"):
            return cls.from_dict(raw.to_dict())
        if isinstance(raw, Mapping):
            return cls.from_dict(raw)
        raise TypeError(f"无法转换为 Question: {type(raw).__name__}")


@dataclass(slots=True)
class Decision:
    """一次经校验后生效的回答；旧决定永不删除，只通过 supersedes 失效。"""

    id: str
    question_id: str
    answer: Any
    actor: str
    actor_role: str = ""
    authority: str = ""
    source_turn: str = ""
    affected_ids: list[str] = field(default_factory=list)
    supersedes: str | None = None
    revision: int | None = None
    idempotency_key: str = ""
    rationale: str = ""
    created_at: float = field(default_factory=_now)
    metadata: dict[str, Any] = field(default_factory=dict)

    def semantic_payload(self) -> dict[str, Any]:
        """幂等比较不含服务器分配的 id/time/revision/supersedes。"""
        return {
            "questionId": self.question_id, "answer": self.answer, "actor": self.actor,
            "actorRole": self.actor_role, "authority": self.authority,
            "sourceTurn": self.source_turn, "affectedIds": sorted(self.affected_ids),
            "rationale": self.rationale,
        }

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(_canonical_json(self.semantic_payload()).encode()).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": "ontocopilot.decision/1", "schemaVersion": SCHEMA_VERSION,
            "id": self.id, "questionId": self.question_id, "answer": self.answer,
            "actor": self.actor, "actorRole": self.actor_role, "authority": self.authority,
            "sourceTurn": self.source_turn, "affectedIds": self.affected_ids,
            "supersedes": self.supersedes, "revision": self.revision,
            "idempotencyKey": self.idempotency_key, "rationale": self.rationale,
            "createdAt": self.created_at, "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Decision":
        qid = str(raw.get("questionId") or raw.get("question_id")
                  or raw.get("target_rid") or "")
        answer = raw.get("answer", raw.get("option_id", raw.get("statement")))
        did = str(raw.get("id") or raw.get("decisionId") or "")
        if not did:
            did = _digest("dec", {"question": qid, "answer": answer,
                                  "actor": raw.get("actor", "user")})
        return cls(
            id=did, question_id=qid, answer=answer,
            actor=str(raw.get("actor") or "user"),
            actor_role=str(raw.get("actorRole") or raw.get("actor_role") or ""),
            authority=str(raw.get("authority") or ""),
            source_turn=str(raw.get("sourceTurn") or raw.get("source_turn") or ""),
            affected_ids=list(raw.get("affectedIds") or raw.get("affected_ids")
                              or raw.get("changed") or []),
            supersedes=raw.get("supersedes"), revision=raw.get("revision"),
            idempotency_key=str(raw.get("idempotencyKey")
                                or raw.get("idempotency_key") or ""),
            rationale=str(raw.get("rationale") or raw.get("note") or ""),
            created_at=float(raw.get("createdAt") or raw.get("ts") or _now()),
            metadata=dict(raw.get("metadata") or {}),
        )


@dataclass(slots=True)
class DecisionLedger:
    decisions: list[Decision] = field(default_factory=list)

    def __post_init__(self) -> None:
        ids = [d.id for d in self.decisions]
        if len(ids) != len(set(ids)):
            raise ValueError("Decision id 重复")
        idem = [d.idempotency_key for d in self.decisions if d.idempotency_key]
        if len(idem) != len(set(idem)):
            raise ValueError("Decision idempotencyKey 重复")

    def active_for(self, question_id: str) -> Decision | None:
        superseded = {d.supersedes for d in self.decisions if d.supersedes}
        return next((d for d in reversed(self.decisions)
                     if d.question_id == question_id and d.id not in superseded), None)

    def record(self, decision: Decision) -> tuple[Decision, bool]:
        """记录决定，返回 ``(decision, created)``；重复请求返回原记录。"""
        if decision.idempotency_key:
            prior = next((d for d in self.decisions
                          if d.idempotency_key == decision.idempotency_key), None)
            if prior:
                if prior.fingerprint != decision.fingerprint:
                    raise IdempotencyConflict(
                        f"幂等键 {decision.idempotency_key!r} 已用于另一份回答")
                return prior, False
        prior = self.active_for(decision.question_id)
        if prior and prior.fingerprint == decision.fingerprint:
            return prior, False
        if prior:
            decision.supersedes = prior.id
        if not decision.id:
            decision.id = _digest("dec", decision.semantic_payload())
        if any(d.id == decision.id for d in self.decisions):
            raise IdempotencyConflict(f"Decision id {decision.id!r} 已存在但内容不同")
        self.decisions.append(decision)
        return decision, True

    def to_dict(self) -> dict[str, Any]:
        return {"$schema": "ontocopilot.decision-ledger/1", "schemaVersion": SCHEMA_VERSION,
                "decisions": [d.to_dict() for d in self.decisions]}

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any] | Sequence[Mapping[str, Any]]) -> "DecisionLedger":
        rows = raw if isinstance(raw, Sequence) else raw.get("decisions") or []
        return cls([Decision.from_dict(x) for x in rows])


@dataclass(slots=True)
class QuestionBacklog:
    questions: dict[str, Question] = field(default_factory=dict)

    def add(self, question: Question, *, preserve_lifecycle: bool = True) -> Question:
        old = self.questions.get(question.id)
        if old and preserve_lifecycle:
            # 重跑挖掘只能更新描述性字段，不能抹掉人的分派/关闭状态。
            question.status = old.status
            question.owner_user_id = old.owner_user_id
            question.audience_role = old.audience_role or question.audience_role
            question.created_at = old.created_at
            question.version = old.version
        self.questions[question.id] = question
        return question

    def assign(self, question_id: str, owner_user_id: str, *, audience_role: str | None = None,
               now: float | None = None) -> Question:
        q = self.questions[question_id]
        q.assign(owner_user_id, audience_role=audience_role, now=now)
        return q

    def transition(self, question_id: str, target: QuestionStatus | str, *,
                   now: float | None = None) -> Question:
        q = self.questions[question_id]
        q.transition(target, now=now)
        return q

    def next_batch(self, *, limit: int = 5, audience_role: str | None = None,
                   owner_user_id: str | None = None) -> list[Question]:
        resolved = {q.id for q in self.questions.values() if q.terminal}
        rows = [q for q in self.questions.values() if q.ready(resolved)]
        if audience_role is not None:
            rows = [q for q in rows if not q.audience_role or q.audience_role == audience_role]
        if owner_user_id is not None:
            rows = [q for q in rows if not q.owner_user_id or q.owner_user_id == owner_user_id]
        weights = {QuestionPriority.BLOCKING: 4, QuestionPriority.HIGH: 3,
                   QuestionPriority.NORMAL: 2, QuestionPriority.LOW: 1}
        rows.sort(key=lambda q: (
            -weights[q.priority], -(q.information_gain * max(1, q.blast_radius)),
            q.created_at, q.id))
        return rows[:max(0, limit)]

    def to_dict(self) -> dict[str, Any]:
        rows = sorted(self.questions.values(), key=lambda q: (q.created_at, q.id))
        return {"$schema": "ontocopilot.question-backlog/1", "schemaVersion": SCHEMA_VERSION,
                "questions": [q.to_dict() for q in rows], "stats": self.stats()}

    def stats(self) -> dict[str, int]:
        out = {s.value: 0 for s in QuestionStatus}
        for q in self.questions.values():
            out[q.status.value] += 1
        out["total"] = len(self.questions)
        out["blockingOpen"] = sum(1 for q in self.questions.values()
                                  if q.blocking and not q.terminal)
        return out

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any] | Sequence[Any]) -> "QuestionBacklog":
        rows = raw if isinstance(raw, Sequence) else raw.get("questions") or []
        bag = cls()
        for item in rows:
            bag.add(Question.from_legacy(item), preserve_lifecycle=False)
        return bag


def build_question_backlog(*, open_questions: Iterable[Any] = (),
                           clarification_questions: Iterable[Any] = (),
                           conflicts: Iterable[Any] = (),
                           existing: QuestionBacklog | Mapping[str, Any] | None = None
                           ) -> QuestionBacklog:
    """把三种遗留来源合成统一 Backlog；同源问题不会因重跑丢 lifecycle。"""
    backlog = (existing if isinstance(existing, QuestionBacklog)
               else QuestionBacklog.from_dict(existing or []))
    by_conflict: dict[str, Question] = {}
    for item in clarification_questions:
        q = Question.from_legacy(item)
        q.source_kind = "conflict"
        q.source_ref = q.source_ref or q.id
        q.priority = QuestionPriority.BLOCKING
        by_conflict[q.source_ref] = q
        backlog.add(q)
    # 原始 conflict 只补齐 clarification 没覆盖的 ask_user 问题。
    for item in conflicts:
        raw = item.to_dict() if hasattr(item, "to_dict") else dict(item)
        handling = str(raw.get("handling") or "")
        if handling and handling != "ask_user":
            continue
        ref = str(raw.get("rid") or raw.get("id") or "")
        if ref in by_conflict:
            continue
        raw = {**raw, "id": _digest("q", {"conflict": ref}),
               "conflict_rid": ref, "title": raw.get("summary") or raw.get("title") or "",
               "priority": "blocking"}
        backlog.add(Question.from_dict(raw))
    for item in open_questions:
        backlog.add(Question.from_legacy(item))
    return backlog


def answer_question(backlog: QuestionBacklog, ledger: DecisionLedger, question_id: str,
                    answer: Any, *, actor: str, actor_role: str = "", authority: str = "",
                    source_turn: str = "", idempotency_key: str,
                    affected_ids: Sequence[str] = (), revision: int | None = None,
                    rationale: str = "", now: float | None = None) -> tuple[Decision, bool]:
    """校验回答、幂等记 Decision、关闭问题；适合作为 API/Agent 的领域入口。"""
    q = backlog.questions[question_id]
    q.validate_answer(answer)
    if not idempotency_key.strip():
        raise ValueError("回答必须提供 idempotency_key")
    decision = Decision(
        id="", question_id=question_id, answer=answer, actor=actor,
        actor_role=actor_role, authority=authority, source_turn=source_turn,
        affected_ids=list(affected_ids or q.blocked_artifacts), revision=revision,
        idempotency_key=idempotency_key, rationale=rationale, created_at=now or _now())
    recorded, created = ledger.record(decision)
    if q.status is not QuestionStatus.ANSWERED:
        q.transition(QuestionStatus.ANSWERED, now=now)
    return recorded, created


@dataclass(frozen=True, slots=True)
class PatchOp:
    op: str
    path: str
    value: Any = None
    from_path: str = ""
    target_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.op not in {"add", "remove", "replace", "move", "copy", "test"}:
            raise ValueError(f"不支持的 patch op: {self.op}")
        if not self.path.startswith("/"):
            raise ValueError("PatchOp.path 必须是 JSON Pointer")
        if self.op in {"move", "copy"} and not self.from_path.startswith("/"):
            raise ValueError(f"{self.op} 必须提供 from_path")

    def to_dict(self) -> dict[str, Any]:
        out = {"op": self.op, "path": self.path}
        if self.op != "remove":
            out["value"] = self.value
        if self.from_path:
            out["from"] = self.from_path
        if self.target_ids:
            out["targetIds"] = list(self.target_ids)
        return out

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "PatchOp":
        return cls(str(raw["op"]), str(raw["path"]), raw.get("value"),
                   str(raw.get("from") or raw.get("from_path") or ""),
                   tuple(raw.get("targetIds") or raw.get("target_ids") or ()))


@dataclass(slots=True)
class PatchSet:
    id: str
    base_revision: int
    ops: list[PatchOp]
    affected_ids: list[str] = field(default_factory=list)
    blocked_artifacts: list[str] = field(default_factory=list)
    idempotency_key: str = ""
    actor: str = "agent"
    reason: str = ""
    created_at: float = field(default_factory=_now)

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(_canonical_json({
            "baseRevision": self.base_revision,
            "ops": [op.to_dict() for op in self.ops],
            "affectedIds": sorted(self.affected_ids),
        }).encode()).hexdigest()

    def require_base(self, current_revision: int) -> None:
        if self.base_revision != current_revision:
            raise RevisionConflict(
                f"PatchSet {self.id} 基于 revision {self.base_revision}，"
                f"当前已是 {current_revision}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": "ontocopilot.patch-set/1", "schemaVersion": SCHEMA_VERSION,
            "id": self.id, "baseRevision": self.base_revision,
            "ops": [op.to_dict() for op in self.ops], "affectedIds": self.affected_ids,
            "blockedArtifacts": self.blocked_artifacts,
            "idempotencyKey": self.idempotency_key, "actor": self.actor,
            "reason": self.reason, "createdAt": self.created_at,
            "fingerprint": self.fingerprint,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "PatchSet":
        return cls(
            id=str(raw.get("id") or _digest("patch", raw.get("ops") or [])),
            base_revision=int(raw.get("baseRevision") or raw.get("base_revision") or 0),
            ops=[PatchOp.from_dict(x) for x in raw.get("ops") or []],
            affected_ids=list(raw.get("affectedIds") or raw.get("affected_ids") or []),
            blocked_artifacts=list(raw.get("blockedArtifacts")
                                   or raw.get("blocked_artifacts") or []),
            idempotency_key=str(raw.get("idempotencyKey")
                                or raw.get("idempotency_key") or ""),
            actor=str(raw.get("actor") or "agent"), reason=str(raw.get("reason") or ""),
            created_at=float(raw.get("createdAt") or raw.get("created_at") or _now()),
        )


@dataclass(slots=True)
class Revision:
    id: str
    ordinal: int
    parent_id: str | None
    kind: str
    status: RevisionStatus
    patch_set: PatchSet | None = None
    changed_ids: list[str] = field(default_factory=list)
    invalidated_artifacts: list[str] = field(default_factory=list)
    actor: str = "agent"
    source_turn: str = ""
    snapshot_hash: str = ""
    created_at: float = field(default_factory=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "$schema": "ontocopilot.revision/1", "schemaVersion": SCHEMA_VERSION,
            "id": self.id, "ordinal": self.ordinal, "parentId": self.parent_id,
            "kind": self.kind, "status": str(self.status),
            "patchSet": self.patch_set.to_dict() if self.patch_set else None,
            "changedIds": self.changed_ids,
            "invalidatedArtifacts": self.invalidated_artifacts,
            "actor": self.actor, "sourceTurn": self.source_turn,
            "snapshotHash": self.snapshot_hash, "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Revision":
        patch = raw.get("patchSet") or raw.get("patch_set")
        return cls(
            id=str(raw["id"]), ordinal=int(raw.get("ordinal") or 0),
            parent_id=raw.get("parentId", raw.get("parent_id")),
            kind=str(raw.get("kind") or "edit"),
            status=RevisionStatus(str(raw.get("status") or "proposed")),
            patch_set=PatchSet.from_dict(patch) if patch else None,
            changed_ids=list(raw.get("changedIds") or raw.get("changed_ids") or []),
            invalidated_artifacts=list(raw.get("invalidatedArtifacts")
                                       or raw.get("invalidated_artifacts") or []),
            actor=str(raw.get("actor") or "agent"),
            source_turn=str(raw.get("sourceTurn") or raw.get("source_turn") or ""),
            snapshot_hash=str(raw.get("snapshotHash") or raw.get("snapshot_hash") or ""),
            created_at=float(raw.get("createdAt") or raw.get("created_at") or _now()),
        )


def _validate_answer(value: Any, schema: Mapping[str, Any], *, path: str) -> None:
    """验证产品当前需要的 JSON Schema 子集，未知 keyword 保留给下游完整 validator。"""
    if not schema:
        return
    if "const" in schema and value != schema["const"]:
        raise AnswerValidationError(f"{path} 必须等于 {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise AnswerValidationError(f"{path} 必须是 {schema['enum']!r} 之一")
    kinds = schema.get("type")
    kinds = [kinds] if isinstance(kinds, str) else list(kinds or [])
    checks = {
        "null": lambda x: x is None,
        "boolean": lambda x: isinstance(x, bool),
        "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
        "number": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
        "string": lambda x: isinstance(x, str),
        "array": lambda x: isinstance(x, list),
        "object": lambda x: isinstance(x, Mapping),
    }
    if kinds and not any(checks.get(k, lambda _: True)(value) for k in kinds):
        raise AnswerValidationError(f"{path} 类型必须是 {kinds}，实际是 {type(value).__name__}")
    if isinstance(value, str):
        if len(value) < int(schema.get("minLength") or 0):
            raise AnswerValidationError(f"{path} 太短")
        if schema.get("maxLength") is not None and len(value) > int(schema["maxLength"]):
            raise AnswerValidationError(f"{path} 太长")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if schema.get("minimum") is not None and value < schema["minimum"]:
            raise AnswerValidationError(f"{path} 不能小于 {schema['minimum']}")
        if schema.get("maximum") is not None and value > schema["maximum"]:
            raise AnswerValidationError(f"{path} 不能大于 {schema['maximum']}")
    if isinstance(value, list) and isinstance(schema.get("items"), Mapping):
        for i, item in enumerate(value):
            _validate_answer(item, schema["items"], path=f"{path}[{i}]")
    if isinstance(value, Mapping):
        missing = [x for x in schema.get("required") or [] if x not in value]
        if missing:
            raise AnswerValidationError(f"{path} 缺少字段 {missing}")
        props = schema.get("properties") or {}
        for key, sub in props.items():
            if key in value and isinstance(sub, Mapping):
                _validate_answer(value[key], sub, path=f"{path}.{key}")
