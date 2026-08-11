"""Agent Loop 运行时 —— DAG 节点内部的执行引擎。

节点是**上下文作用域边界**（TDP, arXiv:2604.11378）：节点内部转 20 轮产生的中间
推理不会泄漏到下游，只有结构化产出和一份 digest 会流下去。这是控制上下文膨胀
的主力手段。

五种模式对应架构文档 §4.2.1。选哪种由 :class:`~.dag.NodeSpec` 声明，不由模型
自己决定 —— 让模型选自己的执行模式会让行为不可预测，而 FDE 场景需要可预测性。
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass, field
from typing import Any

from .budget import Budget
from .bus.bus import AgentBus
from .critic import CriticContext, CriticPanel, Decision, Verdict, metrics_from
from .dag import Difficulty, NodeMode, NodeSpec
from .errors import NodeFailure
from .events import EventKind
from .llm import ModelGateway
from .memory.context import ContextManager
from .memory.short_term import Scratchpad, WorkingSet
from .recorder import Recorder


@dataclass(slots=True)
class NodeResult:
    node_id: str
    output: Any
    verdicts: list[Verdict] = field(default_factory=list)
    digest: dict[str, Any] = field(default_factory=dict)
    iterations: int = 0
    critic_rounds: int = 0
    context_stats: dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return all(v.passed for v in self.verdicts)


# ══════════════════════════════════════════════════════════════════
#  Handler
# ══════════════════════════════════════════════════════════════════
class NodeHandler(ABC):
    """领域层挂到节点上的实现。

    内核完全不知道什么是 ObjectType —— 它只知道调 handler 的这几个钩子。
    这条边界守住了，换领域只需重写 handler。
    """

    #: 产出的 JSON Schema。给了就强制结构化输出。
    schema: dict[str, Any] | None = None
    #: 追加到 L0 系统层的领域规范。
    system: str = ""

    def task(self, inputs: dict[str, Any]) -> str:
        """本节点的任务描述，进上下文。"""
        return "完成本节点任务。"

    def query(self, inputs: dict[str, Any]) -> str:
        """证据检索与长期记忆召回用的查询串。默认复用 task。"""
        return self.task(inputs)

    async def execute(self, inputs: dict[str, Any], ctx: RunContext) -> Any:
        """DETERMINISTIC 模式的实现。其余模式不会调到这里。"""
        raise NotImplementedError(f"{type(self).__name__} 未实现 execute()")

    async def dispatch(self, action: dict[str, Any], ctx: RunContext) -> Any:
        """REACT / CODEACT 模式下执行一个动作，返回 observation。"""
        raise NotImplementedError(f"{type(self).__name__} 未实现 dispatch()")

    def skip_model(self, inputs: dict[str, Any]) -> Any | None:
        """规则已经把这个节点算完了吗？算完了就返回结果，一次模型都不调。

        ADR-5 在节点级的落点。有些段（一行一问的问卷、一行一实体的登记表）
        映射完全确定，让模型再走一遍 agent loop 只有两个后果：为零信息量的
        复述付钱，以及**模型一定会截断**导致丢行。

        返回 ``None`` 表示这个节点确实需要推理。
        """
        return None

    def finalize(self, draft: Any, inputs: dict[str, Any]) -> Any:
        """产出定稿前的确定性加工。默认原样返回。

        用来把"规则算出来的部分"并进模型产出。放在 critic 之前，让 critic 看到
        的就是节点最终交出去的东西。
        """
        return draft

    def human_request(self, draft: Any, inputs: dict[str, Any]) -> dict[str, Any]:
        """HITL 模式下要问人什么。"""
        return {"draft": draft}

    def for_node(self, node_id: str) -> "NodeHandler":
        """按节点 id 解析出实际的 handler。

        fan-out 出来的实例（``EXTRACT.s0`` / ``EXTRACT.s1`` …）共用一个注册名，
        但各自要处理不同的数据。默认返回自己；需要分派的 handler 覆盖它 ——
        这样"段"仍然是数据，不必为每段往注册表里塞一个条目。
        """
        return self


@dataclass(slots=True)
class RunContext:
    """一次 Run 的共享环境，透传给 handler。"""

    run_id: str
    rec: Recorder
    bus: AgentBus
    gateway: ModelGateway
    budget: Budget
    ctx: ContextManager
    node_id: str = ""


# ══════════════════════════════════════════════════════════════════
#  循环
# ══════════════════════════════════════════════════════════════════
#: REACT / PLAN_EXECUTE 每一步的输出契约。
#:
#: 工具参数是 **JSON 字符串**而不是嵌套 object。原因是结构化输出的 strict 模式
#: 要求每个 object 声明完整的 properties 并关掉 additionalProperties —— 而工具
#: 参数的形状因工具而异，声明不出来。写成 object 的后果是模型**一个参数都传不了**：
#: 它会反复尝试调工具、反复被拒，最后在 thought 里写"args schema 不允许传任何参数"。
#: 这正是真实材料上撞到的。
STEP_SCHEMA = {
    "type": "object",
    "required": ["thought", "action"],
    "properties": {
        "thought": {"type": "string"},
        "action": {
            "type": "object",
            "required": ["kind", "tool", "args_json"],
            "properties": {
                "kind": {"type": "string", "enum": ["tool", "finish"]},
                "tool": {"type": "string", "description": "kind=finish 时填空串"},
                "args_json": {"type": "string",
                              "description": '工具参数的 JSON 对象字符串，如 {"query":"计划金额"}；'
                                             "kind=finish 时填 {}"},
            },
        },
    },
}


def parse_action_args(action: dict[str, Any]) -> dict[str, Any]:
    """把 ``args_json`` 解析成参数字典。解析不了就返回空，让工具层报缺参。"""
    raw = action.get("args_json") or action.get("args")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    import json as _json

    try:
        out = _json.loads(raw)
        return out if isinstance(out, dict) else {}
    except _json.JSONDecodeError:
        return {}

PLAN_SCHEMA = {
    "type": "object",
    "required": ["steps"],
    "properties": {
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["goal"],
                "properties": {"goal": {"type": "string"}, "tool": {"type": "string"}},
            },
        }
    },
}


class AgentLoop:
    """节点执行引擎。"""

    def __init__(
        self,
        *,
        gateway: ModelGateway,
        ctx_manager: ContextManager,
        panel: CriticPanel,
        bus: AgentBus,
        recorder: Recorder,
        budget: Budget,
        handlers: dict[str, NodeHandler],
    ) -> None:
        self.gw = gateway
        self.cm = ctx_manager
        self.panel = panel
        self.bus = bus
        self.rec = recorder
        self.budget = budget
        self.handlers = handlers

    # ── 入口 ────────────────────────────────────────────────────
    async def run(
        self, node: NodeSpec, *, working: WorkingSet, deps: list[str], run_id: str
    ) -> NodeResult:
        base = self.handlers.get(node.handler)
        if base is None:
            raise NodeFailure(node.id, f"未注册的 handler: {node.handler!r}", retryable=False)
        handler = base.for_node(node.id)

        attempt = self.rec.next_attempt(node.id)
        self.rec.emit(
            EventKind.NODE_ENTERED, node_id=node.id,
            payload={"mode": str(node.mode), "attempt": attempt, "handler": node.handler},
        )

        difficulty = node.difficulty or self._route(node, working, deps)
        inputs = working.select(deps)
        rctx = RunContext(
            run_id=run_id, rec=self.rec, bus=self.bus, gateway=self.gw,
            budget=self.budget, ctx=self.cm, node_id=node.id,
        )

        pad = Scratchpad(budget_tokens=node.budget.tokens // 2)
        skipped = handler.skip_model(inputs)
        if skipped is not None:
            draft, iters = skipped, 0
        else:
            draft, iters = await self._produce(node, handler, inputs, rctx, pad,
                                               difficulty)
        # 规则产出在这里并进来 —— 必须**先于** critic，否则 critic 判的不是节点
        # 的真实产出，会对"模型没抽但规则已经抽了"的东西报缺失。
        draft = handler.finalize(draft, inputs)

        # ── Critic 环 ────────────────────────────────────────────
        rounds = self.gw.critic_rounds_for(difficulty, node.critic_rounds)
        verdicts: list[Verdict] = []
        done = 0
        if node.critics and rounds:
            draft, verdicts, done = await self._critique(
                node, handler, inputs, draft, rctx, difficulty, rounds, pad
            )

        # ── 硬门：**fail-closed** ─────────────────────────────────
        # Gate 一直是实现好的，但没有任何地方读 NodeSpec.gate —— critic 判了不通过，
        # 节点照样把产出交出去，"质量门"只是一句声明。这里让它真的挡住：判不过就
        # 抛 NodeFailure，由调度器按 retryable 决定重试还是让整次 Run 失败。
        if node.gate is not None:
            gr = node.gate.evaluate(metrics_from(verdicts), self.rec, node.id)
            if gr.decision in (Decision.ABORT, Decision.ROUND_TRIP):
                raise NodeFailure(node.id, f"质量门「{node.gate.name}」未通过：{gr.reason}",
                                  retryable=False)
            if gr.decision is Decision.REVISE:
                # 还能修就让调度器重试这个节点，而不是把半成品放行
                raise NodeFailure(node.id, f"质量门「{node.gate.name}」要求重做：{gr.reason}",
                                  retryable=True)

        rendered = self.cm.assemble(
            task=handler.task(inputs), query=handler.query(inputs),
            working=working, deps=deps, run_id=run_id,
            evidence_top_k=node.scope.evidence_top_k,
        )
        return NodeResult(
            node_id=node.id, output=draft, verdicts=verdicts,
            digest=pad.digest(), iterations=iters, critic_rounds=done,
            context_stats=rendered.stats(),
        )

    # ── 产出 ────────────────────────────────────────────────────
    async def _produce(
        self,
        node: NodeSpec,
        handler: NodeHandler,
        inputs: dict[str, Any],
        rctx: RunContext,
        pad: Scratchpad,
        difficulty: Difficulty,
    ) -> tuple[Any, int]:
        if node.mode is NodeMode.DETERMINISTIC:
            return await handler.execute(inputs, rctx), 0

        if node.mode is NodeMode.HITL:
            request_id = f"{node.id}:hitl"
            answer = await self.rec.ask_human(
                node.id, request_id, handler.human_request(inputs, inputs)
            )
            return answer, 0

        ctx_text = self._context(node, handler, inputs, rctx)

        if node.mode is NodeMode.SINGLE_SHOT:
            comp = await self.gw.call(
                node.id, ctx_text, system=handler.system,
                difficulty=difficulty, schema=handler.schema,
                max_tokens=min(node.budget.tokens, 16_000),
            )
            return (comp.data if handler.schema else comp.text), 1

        return await self._iterate(node, handler, inputs, rctx, pad, difficulty, ctx_text)

    async def _iterate(
        self,
        node: NodeSpec,
        handler: NodeHandler,
        inputs: dict[str, Any],
        rctx: RunContext,
        pad: Scratchpad,
        difficulty: Difficulty,
        ctx_text: str,
    ) -> tuple[Any, int]:
        """REACT / PLAN_EXECUTE / CODEACT 的共用循环骨架。"""
        max_iters = min(node.budget.iterations, self.gw.iterations_for(difficulty))
        steps: list[dict[str, Any]] | None = None

        if node.mode is NodeMode.PLAN_EXECUTE:
            plan = await self.gw.call(
                node.id, f"{ctx_text}\n\n先出一份可执行的分步计划。",
                system=handler.system, difficulty=difficulty, schema=PLAN_SCHEMA,
                key="plan",
            )
            steps = (plan.data or {}).get("steps", [])
            self.rec.emit(EventKind.PLAN_CREATED, node_id=node.id, payload={"steps": steps})

        i = 0
        while i < max_iters:
            if self.budget.must_halt():
                raise NodeFailure(node.id, "预算耗尽，已保存 checkpoint", retryable=False)

            prompt = self._step_prompt(ctx_text, pad, steps)
            comp = await self.gw.call(
                node.id, prompt, system=handler.system, difficulty=difficulty,
                schema=STEP_SCHEMA, key=f"step:{i}",
            )
            step = comp.data or {}
            thought = step.get("thought", "")
            action = step.get("action", {}) or {}
            self.rec.emit(EventKind.THOUGHT, node_id=node.id, payload={"text": thought[:800]})
            i += 1

            if action.get("kind") == "finish":
                pad.append(thought=thought, action="finish")
                break

            action = {**action, "args": parse_action_args(action)}
            obs = await handler.dispatch(action, rctx)
            obs_text = str(obs)[:4000]
            pad.append(thought=thought, action=_fmt_action(action), observation=obs_text)
            self.rec.emit(
                EventKind.OBSERVATION, node_id=node.id,
                payload={"tool": action.get("tool", ""), "summary": obs_text[:400]},
            )
            if pad.over_budget():
                n = pad.compact_to_fit()
                self.rec.emit(EventKind.CONTEXT_COMPACTED, node_id=node.id,
                              payload={"compactions": n})

        final = await self.gw.call(
            node.id,
            f"{ctx_text}\n\n## 本节点已完成的工作\n{pad.render()}\n\n据此给出最终产出。",
            system=handler.system, difficulty=difficulty, schema=handler.schema, key="final",
            max_tokens=min(node.budget.tokens, 16_000),
        )
        return (final.data if handler.schema else final.text), i

    # ── 评审 ────────────────────────────────────────────────────
    async def _critique(
        self,
        node: NodeSpec,
        handler: NodeHandler,
        inputs: dict[str, Any],
        draft: Any,
        rctx: RunContext,
        difficulty: Difficulty,
        rounds: int,
        pad: Scratchpad,
    ) -> tuple[Any, list[Verdict], int]:
        generator = self.gw.routing.model_for(difficulty)
        cctx = CriticContext(
            node_id=node.id, gateway=self.gw, generator=generator,
            facts=self.bus.render_facts(node.scope.blackboard_pattern),
            samples=self.gw.samples_for(difficulty),
        )
        verdicts: list[Verdict] = []
        done = 0

        for r in range(rounds):
            verdicts = await self.panel.judge(
                draft, node.critics, cctx, allow_llm=self.budget.allow_llm_critic()
            )
            done = r + 1
            if all(v.passed for v in verdicts):
                break

            # Reflexion：把教训写进本 Run 的记忆，后续节点自动规避同类错误
            for v in verdicts:
                for f in v.findings:
                    self.cm.reflect(f"{v.lens}/{f.code}: {f.claim}")

            comp = await self.gw.call(
                node.id,
                _refine_prompt(draft, verdicts),
                difficulty=difficulty, schema=handler.schema,
                key=f"refine:{r}",
            )
            if comp.data is not None:
                # 修订产物同样要过 finalize。模型重出的那版 JSON 里只有它这次改的
                # 东西 —— 规则逐行抽好的部分（一段 45 行行动表的全部 action）不在
                # 里面，直接赋值就等于把它们删了。真实事故：168 行接口全部消失，
                # 而 critic 下一轮报的是「一个行动都没有」，看着像模型没抽。
                draft = handler.finalize(comp.data, inputs)
            pad.append(action=f"refine#{r}", observation=f"按 {len(verdicts)} 条评审意见修订")

        return draft, verdicts, done

    # ── 辅助 ────────────────────────────────────────────────────
    def _context(
        self, node: NodeSpec, handler: NodeHandler, inputs: dict[str, Any], rctx: RunContext
    ) -> str:
        rendered = self.cm.assemble(
            task=handler.task(inputs), query=handler.query(inputs),
            run_id=rctx.run_id, evidence_top_k=node.scope.evidence_top_k,
            budget_tokens=node.budget.tokens,
            evidence_files=list(node.scope.evidence_files or ()) or None,
        )
        facts = self.bus.render_facts(node.scope.blackboard_pattern)
        body = rendered.text
        if facts:
            body += f"\n\n## 共享事实（黑板）\n{facts}"
        if inputs:
            import json

            body += f"\n\n## 本节点输入\n{json.dumps(inputs, ensure_ascii=False, default=str)[:12000]}"
        return body

    @staticmethod
    def _step_prompt(ctx_text: str, pad: Scratchpad, steps: list[dict] | None) -> str:
        parts = [ctx_text]
        if steps:
            plan = "\n".join(f"{i + 1}. {s.get('goal', '')}" for i, s in enumerate(steps))
            parts.append(f"## 计划\n{plan}")
        if len(pad):
            parts.append(f"## 已做过的\n{pad.render()}")
        parts.append("给出下一步：需要用工具就 kind=tool，已经够了就 kind=finish。")
        return "\n\n".join(parts)

    def _route(self, node: NodeSpec, working: WorkingSet, deps: list[str]) -> Difficulty:
        """难度路由（DAAO 式）。输入规模 + 历史失败率决定档位。

        刻意保持廉价 —— 路由本身花钱就本末倒置了。
        """
        from .memory.types import est_tokens
        import json

        size = est_tokens(json.dumps(working.select(deps), ensure_ascii=False, default=str))
        if node.critics and len(node.critics) >= 3:
            return Difficulty.CRITICAL  # 挂了三个以上视角，说明这步不能错
        if size > 40_000:
            return Difficulty.HIGH
        if size > 4_000:
            return Difficulty.MEDIUM
        return Difficulty.LOW


def _fmt_action(action: dict[str, Any]) -> str:
    import json

    args = json.dumps(action.get("args", {}), ensure_ascii=False, default=str)
    return f"{action.get('tool', '?')}({args[:300]})"


def _refine_prompt(draft: Any, verdicts: list[Verdict]) -> str:
    import json

    issues = "\n".join(
        f"- [{v.lens}/{f.code}] {f.claim}"
        + (f"（已核对: {'、'.join(f.evidence_checked[:3])}）" if f.evidence_checked else "")
        for v in verdicts for f in v.findings
    )
    return (
        "评审提出了下面这些问题，逐条修掉，其余部分保持不变。\n\n"
        f"## 评审意见\n{issues}\n\n"
        f"## 当前产物\n{json.dumps(draft, ensure_ascii=False, default=str)[:20000]}"
    )


__all__ = ["AgentLoop", "NodeHandler", "NodeResult", "RunContext", "metrics_from"]
