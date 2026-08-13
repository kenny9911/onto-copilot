"""模型网关 —— 难度路由、结构化输出、异构评委、成本记账。

三条纪律：

  1. **所有调用走 Recorder.effect** —— 重放时读回历史，不重新付费。
  2. **难度路由**（DAAO 式）—— 便宜的活不该用旗舰模型，关键判断不该省。
  3. **异构评委** —— critic 用的模型必须与生成的不同，缓解自我增强偏差
     （LLM-as-judge 综述 arXiv:2411.15594）。这是网关强制的，不靠调用方自觉。

**采样参数不在这一层出现**。当前一代模型（Claude Opus 5 / Sonnet 5）已移除
``temperature`` / ``top_p`` / ``top_k``，传了直接 400。控制推理深度的旋钮是
``effort``，所以 :class:`ModelSpec` 带的是 effort 而不是 temperature。
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .budget import Budget
from .dag import Difficulty
from .errors import HarnessError
from .events import EventKind
from .ids import sha256_hex
from .recorder import Recorder


class ModelError(HarnessError):
    """模型调用失败或输出不合 schema。"""


#: 输出被截断的迹象。这类失败重试同样的预算是没用的，必须加大。
_TRUNC_HINT = ("不完整", "截断", "Unterminated", "Expecting value",
               "Expecting ',' delimiter", "Expecting property name")


def _looks_truncated(err: str) -> bool:
    return any(h in err for h in _TRUNC_HINT)


class ModelTruncated(ModelError):
    """思考型模型把 max_tokens 全花在推理上，没留下正文。

    **可恢复**：加大预算重试就行，不是模型不会做。会思考的模型（gemini-2.5+ /
    o 系列等）推理 token 也计入 max_tokens，密集内容（一张上百节点的流程图）
    按老预算必然被截断 —— 直接失败等于这份材料白传。
    """


class ModelRefusal(ModelError):
    """安全分类器拒绝了请求。

    不是 HTTP 错误 —— 返回的是 200 + ``stop_reason="refusal"``。本体建模场景
    极少触发，但材料里若混入安全相关内容（渗透测试报告、生物实验数据）可能命中。
    """

    def __init__(self, model: str, category: str | None) -> None:
        super().__init__(f"{model} 拒绝了该请求（类别: {category or '未标注'}）")
        self.category = category


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """一个模型档位。

    Attributes:
        effort: 推理深度。``None`` 表示该模型不支持 effort 参数（传了会报错）。
        thinking: 是否显式开启自适应思考。``None`` 表示不下发 thinking 字段。
    """

    name: str
    tier: str  # "small" | "mid" | "frontier"
    usd_per_mtok_in: float
    usd_per_mtok_out: float
    effort: str | None = "high"  # low | medium | high | xhigh | max
    thinking: bool | None = True

    def cost(self, tok_in: int, tok_out: int, cache_read: int = 0, cache_write: int = 0) -> float:
        """含缓存计价。缓存读约 0.1×，缓存写约 1.25×（5 分钟 TTL）。"""
        return (
            tok_in * self.usd_per_mtok_in
            + cache_read * self.usd_per_mtok_in * 0.1
            + cache_write * self.usd_per_mtok_in * 1.25
            + tok_out * self.usd_per_mtok_out
        ) / 1e6


@dataclass(slots=True)
class Usage:
    tok_in: int = 0
    tok_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    #: 网关回报的真实成本（美元）。有就用它，没有才回退到本地定价表估算 ——
    #: 定价表会过期，网关的账单不会。
    usd: float | None = None

    @property
    def total(self) -> int:
        return self.tok_in + self.tok_out + self.cache_read + self.cache_write

    def to_dict(self) -> dict[str, Any]:
        return {
            "tok_in": self.tok_in, "tok_out": self.tok_out,
            "cache_read": self.cache_read, "cache_write": self.cache_write,
            "usd": self.usd,
        }


@dataclass(slots=True)
class Completion:
    text: str
    data: Any = None  # schema 校验后的结构化结果
    model: str = ""
    usage: Usage = field(default_factory=Usage)
    usd: float = 0.0
    attempts: int = 1


# ══════════════════════════════════════════════════════════════════
#  后端协议
# ══════════════════════════════════════════════════════════════════
class LLMBackend(ABC):
    """真正调模型的地方。网关只管路由、记账、校验。"""

    @abstractmethod
    async def generate(
        self,
        *,
        model: ModelSpec,
        prompt: str,
        system: str = "",
        schema: dict[str, Any] | None = None,
        max_tokens: int = 16_000,
        cache_system: bool = True,
        images: list[str] | None = None,
    ) -> tuple[str, Usage]:
        """返回 ``(文本, 用量)``。

        Args:
            images: base64 data URI 列表。只有具备 VISION 能力的模型能收 ——
                发给纯文本模型会被网关拒（这正是能力发现的信号来源）。
        """


class ScriptedBackend(LLMBackend):
    """测试与离线 demo 用的后端。

    按 ``(模式, 响应)`` 顺序匹配 prompt，匹配不到走 ``default``。完全确定性 ——
    这让整条流水线可以在没有 API key 的情况下端到端跑通并断言。
    """

    def __init__(
        self,
        rules: list[tuple[str, str | Callable[[str], str]]] | None = None,
        *,
        default: str = "{}",
    ) -> None:
        self.rules = rules or []
        self.default = default
        self.calls: list[dict[str, Any]] = []

    async def generate(
        self,
        *,
        model: ModelSpec,
        prompt: str,
        system: str = "",
        schema: dict[str, Any] | None = None,
        max_tokens: int = 16_000,
        cache_system: bool = True,
        images: list[str] | None = None,
    ) -> tuple[str, Usage]:
        self.calls.append({"model": model.name, "prompt": prompt, "schema": bool(schema),
                           "images": len(images or ())})
        body = self.default
        for pattern, resp in self.rules:
            if re.search(pattern, prompt, re.DOTALL):
                body = resp(prompt) if callable(resp) else resp
                break
        from .memory.types import est_tokens

        return body, Usage(tok_in=est_tokens(system + prompt), tok_out=est_tokens(body))


# ══════════════════════════════════════════════════════════════════
#  路由表
# ══════════════════════════════════════════════════════════════════
#: 生产路由。Haiku 4.5 不支持 effort/adaptive thinking，所以两个字段都置空 ——
#: 传了会直接报错，这是模型代际差异，必须在路由表里显式表达。
PRODUCTION_MODELS: dict[str, ModelSpec] = {
    "small": ModelSpec("claude-haiku-4-5", "small", 1.0, 5.0, effort=None, thinking=None),
    "mid": ModelSpec("claude-sonnet-5", "mid", 3.0, 15.0, effort="medium"),
    "frontier": ModelSpec("claude-opus-5", "frontier", 5.0, 25.0, effort="high"),
    #: CRITICAL 档：口径冲突判定这类错了代价最大的判断，用最高档推理。
    "frontier_deep": ModelSpec("claude-opus-5", "frontier", 5.0, 25.0, effort="xhigh"),
}


@dataclass(slots=True)
class RoutingTable:
    """难度 → 模型 + 循环参数（架构文档 §4.2.3）。"""

    models: dict[Difficulty, ModelSpec] = field(default_factory=dict)
    #: 评委池。:meth:`judge_for` 会剔除与生成者同名的，保证异构。
    judges: list[ModelSpec] = field(default_factory=list)
    #: 辅助调用（推荐问题这类锦上添花的）用的"最低推理档"。``None`` = 这套路由
    #: 没有这一档，调用方照常按难度路由。
    #:
    #: 为什么是路由表的一格而不是调用处的一个参数：能不能压推理、压到哪一档
    #: 是**厂商/网关的事实**（同一个 effort 字符串在另一家后端是 400），只有
    #: 路由函数知道自己接的是谁。
    fast: ModelSpec | None = None

    max_iterations: dict[Difficulty, int] = field(default_factory=lambda: {
        Difficulty.LOW: 1, Difficulty.MEDIUM: 4,
        Difficulty.HIGH: 12, Difficulty.CRITICAL: 12,
    })
    critic_rounds: dict[Difficulty, int] = field(default_factory=lambda: {
        Difficulty.LOW: 0, Difficulty.MEDIUM: 1,
        Difficulty.HIGH: 2, Difficulty.CRITICAL: 3,
    })
    #: CRITICAL 档的自洽采样数。
    self_consistency: dict[Difficulty, int] = field(default_factory=lambda: {
        Difficulty.LOW: 1, Difficulty.MEDIUM: 1,
        Difficulty.HIGH: 1, Difficulty.CRITICAL: 3,
    })

    def model_for(self, d: Difficulty) -> ModelSpec:
        if d not in self.models:
            raise ModelError(f"难度 {d} 未配置模型")
        return self.models[d]

    def judge_for(self, generator: ModelSpec, salt: int = 0) -> ModelSpec:
        """挑一个与生成者不同的评委。"""
        pool = [m for m in self.judges if m.name != generator.name]
        if not pool:
            raise ModelError(
                f"没有可用的异构评委（生成模型 {generator.name}）。"
                "同模型自评会引入自我增强偏差，网关拒绝这么做。"
            )
        return pool[salt % len(pool)]


def production_routing() -> RoutingTable:
    """接真实模型的路由表。"""
    m = PRODUCTION_MODELS
    return RoutingTable(
        models={
            Difficulty.LOW: m["small"],
            Difficulty.MEDIUM: m["mid"],
            Difficulty.HIGH: m["frontier"],
            Difficulty.CRITICAL: m["frontier_deep"],
        },
        # 评委跨模型族：opus 生成 → sonnet 评，sonnet 生成 → opus 评。
        judges=[m["mid"], m["frontier"]],
    )


#: 自定义聚合网关上的模型（OpenRouter 命名）。定价只用于预算估算的兜底 ——
#: 网关每次都回报真实成本，那个优先。
#:
#: 生成侧是"便宜档 Gemini Flash + 高难度档 Claude Sonnet"的混合路由：
#:   * LOW / MEDIUM  → google/gemini-3.5-flash（快、便宜；Flash 不支持 effort/思考）
#:   * HIGH / CRITICAL → anthropic/claude-sonnet-5（保留推理深度）
#: 难度分档除了切模型，还会放大 critic 轮数与自洽采样（见 RoutingTable），
#: 所以即便 LOW/MEDIUM 是同一个模型，难度依然影响循环强度。
GATEWAY_MODELS: dict[str, ModelSpec] = {
    # Gemini 3.5 Flash：便宜档主力。Flash 不支持 effort / 自适应思考，两个字段
    # 都置空 —— 传了会 400。
    "flash": ModelSpec("google/gemini-3.5-flash", "mid", 1.0, 4.0,
                       effort=None, thinking=None),
    # 同一个 Flash，但把推理压到最低档 —— 给"猜三条推荐问题"这种锦上添花的调用。
    # 这个端点**关不掉思考**（reasoning.enabled=false / max_tokens=0 / effort=none
    # 一律 400："Reasoning is mandatory for this endpoint"），但 minimal 认。
    # 实测同一句提示：不带 reasoning 7.8s / 934 出 token，minimal 3.5s / 202。
    "flash_min": ModelSpec("google/gemini-3.5-flash", "mid", 1.0, 4.0,
                           effort="minimal", thinking=None),
    # 高难度档暂用 Sonnet。Sonnet 支持 effort，CRITICAL 给更深的 xhigh，
    # 保留"错了代价最大的判断用更深推理"这条纪律。
    "sonnet": ModelSpec("anthropic/claude-sonnet-5", "mid", 3.0, 15.0, effort="high"),
    "sonnet_deep": ModelSpec("anthropic/claude-sonnet-5", "mid", 3.0, 15.0,
                             effort="xhigh"),
    # 评委刻意跨厂商 —— 同族自评正是 LLM-as-judge 综述点名的自我增强偏差来源。
    # judge_for 按模型名剔除与生成者同名的评委：Gemini 生成 → 落到 GPT；
    # Sonnet 生成 → GPT / Gemini 皆可。两条路径都保持跨厂商。
    "judge_openai": ModelSpec("openai/gpt-5.5", "frontier", 5.0, 25.0, effort="high"),
    "judge_google": ModelSpec("google/gemini-3.5-flash", "mid", 1.0, 4.0, effort=None,
                              thinking=None),
}


#: 难度档 → 键名（供设置页/覆盖用）。
_TIER_KEYS: dict[str, Difficulty] = {
    "low": Difficulty.LOW, "medium": Difficulty.MEDIUM,
    "high": Difficulty.HIGH, "critical": Difficulty.CRITICAL,
}
#: 各档"意图 effort"。仅当所选模型**支持** effort 时才下发，否则一律 None。
_TIER_EFFORT: dict[Difficulty, str | None] = {
    Difficulty.LOW: None, Difficulty.MEDIUM: "medium",
    Difficulty.HIGH: "high", Difficulty.CRITICAL: "xhigh",
}


def _override_spec(model_name: str, catalog: Any, diff: Difficulty) -> ModelSpec:
    """把"某档选某模型"落成 ModelSpec，**服务端派生 effort**。

    关键安全点：不支持 effort 的模型（Flash/Haiku/deepseek…）必须 effort=None，
    否则后端把 effort 下发给网关会直接 400。用目录卡片的 spec.effort 是否为 None
    判断能力 —— 不引 Capability，避免与 catalog 形成循环依赖。
    """
    card = catalog.get(model_name) if catalog is not None else None
    if card is None:
        # 目录里没有 → 保守：无 effort、中档定价（定价只用于兜底估算）。
        return ModelSpec(model_name, "mid", 3.0, 15.0, effort=None, thinking=None)
    supports_effort = card.spec.effort is not None
    eff = _TIER_EFFORT[diff] if supports_effort else None
    return ModelSpec(model_name, card.spec.tier, card.spec.usd_per_mtok_in,
                     card.spec.usd_per_mtok_out, effort=eff,
                     thinking=True if supports_effort else None)


def gateway_routing(model_overrides: dict[str, str] | None = None,
                    catalog: Any = None) -> RoutingTable:
    """接自定义聚合网关的路由表。

    生成侧默认混合路由：LOW/MEDIUM 走 Gemini 3.5 Flash（快、省），HIGH/CRITICAL 走
    Claude Sonnet（保留推理深度，CRITICAL 用更深 effort）。

    ``model_overrides`` 形如 ``{"low"/"medium"/"high"/"critical": "厂商/模型"}``，
    由管理员在设置页选定、按需覆盖各档模型；``catalog`` 用来查模型能力/定价。
    effort 一律**服务端派生**（见 :func:`_override_spec`），UI 不碰 effort。

    评委保持代码默认（GPT / Gemini，跨厂商），**不暴露给 UI**：judge_for 按名剔除
    与生成者同名的评委，所以两条生成路径都始终有异构评委 —— 缓解 LLM-as-judge
    综述里点名的自我增强偏差。
    """
    m = GATEWAY_MODELS
    tiers: dict[Difficulty, ModelSpec] = {
        Difficulty.LOW: m["flash"],
        Difficulty.MEDIUM: m["flash"],
        Difficulty.HIGH: m["sonnet"],
        Difficulty.CRITICAL: m["sonnet_deep"],
    }
    for key, diff in _TIER_KEYS.items():
        name = (model_overrides or {}).get(key)
        if name:
            tiers[diff] = _override_spec(name, catalog, diff)

    judges = [m["judge_openai"], m["judge_google"]]
    # 防御：任一档的生成者都必须留得下至少一个异构评委，否则 judge_for 会在
    # 运行时抛错。默认双评委不同名，覆盖也不可能把两个都撞上，这里显式兜底。
    for spec in set(tiers.values()):
        if not [j for j in judges if j.name != spec.name]:
            raise ModelError(f"{spec.name} 没有可用的异构评委（评委池："
                             f"{[j.name for j in judges]}）")
    # fast 只用于辅助调用，不跟着 model_overrides 走 —— 管理员在设置页选的是
    # "干活用哪个模型"，不该顺带把"猜三条提示"也换成一个贵且慢的。
    return RoutingTable(models=tiers, judges=judges, fast=m["flash_min"])


def stub_routing() -> RoutingTable:
    """离线 demo / 测试用。模型名带 stub 前缀，避免误连真实 API。"""
    s = {
        "small": ModelSpec("stub-small", "small", 0.8, 4.0, effort=None, thinking=None),
        "mid": ModelSpec("stub-mid", "mid", 3.0, 15.0, effort="medium"),
        "frontier": ModelSpec("stub-frontier", "frontier", 5.0, 25.0, effort="high"),
        "deep": ModelSpec("stub-frontier", "frontier", 5.0, 25.0, effort="xhigh"),
        "judge": ModelSpec("stub-judge", "mid", 3.0, 15.0, effort="high"),
    }
    return RoutingTable(
        models={
            Difficulty.LOW: s["small"], Difficulty.MEDIUM: s["mid"],
            Difficulty.HIGH: s["frontier"], Difficulty.CRITICAL: s["deep"],
        },
        judges=[s["judge"], s["mid"]],
    )


# ══════════════════════════════════════════════════════════════════
#  网关
# ══════════════════════════════════════════════════════════════════
class ModelGateway:
    """所有模型调用的唯一入口。"""

    def __init__(
        self,
        backend: LLMBackend,
        recorder: Recorder,
        *,
        routing: RoutingTable | None = None,
        budget: Budget | None = None,
        max_schema_retries: int = 2,
        usage_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.backend = backend
        self.rec = recorder
        self.routing = routing or stub_routing()
        self.budget = budget or Budget()
        self.max_schema_retries = max_schema_retries
        #: 用量账本的落库口子。**这里是全部模型调用的唯一收口** —— judge、
        #: SmartGateway、对话、视觉 OCR、评委全都最终走 `call`，所以钩在这里
        #: 就是 100% 覆盖。kernel 不认识存储，具体怎么落由服务端注入。
        self.usage_sink = usage_sink

    async def call(
        self,
        node_id: str,
        prompt: str,
        *,
        system: str = "",
        difficulty: Difficulty = Difficulty.MEDIUM,
        schema: dict[str, Any] | None = None,
        model: ModelSpec | None = None,
        key: str | None = None,
        max_tokens: int = 16_000,
        images: list[str] | None = None,
    ) -> Completion:
        """调一次模型。

        Args:
            schema: 给了就强制结构化输出。解析失败会带错误信息重试
                ``max_schema_retries`` 次，仍失败则抛 :class:`ModelError` ——
                **不返回半成品**，让节点的重试策略去处理。
            key: 节点内并发调用必须给（比如四个 critic 视角同时跑）。
        """
        spec = model or self.routing.model_for(difficulty)
        req = {
            "model": spec.name,
            "effort": spec.effort,
            "thinking": spec.thinking,
            "system": system,
            "prompt": prompt,
            "schema": schema,
            "max_tokens": max_tokens,
            # 图片按内容哈希进指纹：重放要确定性，但完整 base64 塞进事件日志会撑爆它
            "images": [sha256_hex(i)[:16] for i in (images or ())],
        }

        # 这一次调用**有没有真的打到模型**。Recorder.effect 在重放时直接返回历史
        # 结果、根本不跑 do()，而记账必须只记真花了钱的那次 —— 否则 resume 一次
        # 账单翻一倍。闭包里置位是唯一能区分二者的信号（effect 本身不返回这个）。
        fired: dict[str, Any] = {
            "hit": False, "billed": None, "attempts": 0,
            "usd": 0.0, "usd_source": "estimated",
        }

        async def do() -> dict[str, Any]:
            last_err = ""
            fired["hit"] = True
            # **每一次重试都是真金白银。** 以前只把最后一次的 usage 带出去，于是
            # 一次调用重试三回、账上只算一回。schema 不合重试、截断加预算重试都
            # 会走到这里，密集材料上并不罕见。
            billed = Usage(usd=0.0)

            def bill(u: Usage) -> Usage:
                if int(fired["attempts"]) == 0:
                    fired["usd_source"] = "gateway" if u.usd is not None else "estimated"
                billed.tok_in += u.tok_in
                billed.tok_out += u.tok_out
                billed.cache_read += u.cache_read
                billed.cache_write += u.cache_write
                attempt_usd = u.usd
                if u.usd is None:
                    # Some providers omit a cost even when another retry returned one.
                    # Sum known gateway costs plus a local estimate for missing attempts,
                    # and label the aggregate estimated rather than presenting a partial
                    # gateway total as authoritative.
                    attempt_usd = spec.cost(
                        u.tok_in, u.tok_out, u.cache_read, u.cache_write,
                    )
                    fired["usd_source"] = "estimated"
                fired["usd"] = float(fired["usd"]) + float(attempt_usd or 0.0)
                # Usage.usd means "provider-reported actual cost". Preserve that
                # contract: a mixed/estimated aggregate keeps usage.usd=None while the
                # deterministic billed_usd field below carries the amount to Budget.
                billed.usd = (
                    float(fired["usd"])
                    if fired["usd_source"] == "gateway" else None
                )
                fired["billed"] = billed
                fired["attempts"] = int(fired["attempts"]) + 1
                return u

            # 思考型模型的推理 token 也计进 max_tokens：密集内容（上百节点的流程图）
            # 按初始预算必然被截断成"只有推理、没有正文"。那不是模型不会做，是预算
            # 给小了 —— 逐次加大重试，而不是让这份材料白传。
            budget = max_tokens
            for attempt in range(1 + self.max_schema_retries):
                p = prompt if attempt == 0 else (
                    f"{prompt}\n\n【上次输出不合要求】{last_err}\n"
                    "请只输出符合 schema 的 JSON，不要任何解释文字。"
                )
                try:
                    text, usage = await self.backend.generate(
                        model=spec, prompt=p, system=system, schema=schema,
                        max_tokens=budget, images=images,
                    )
                except ModelTruncated as exc:
                    # 截断也是打过一次、也计费了；exc 带不带 usage 都要留个痕
                    bill(getattr(exc, "usage", None) or Usage())
                    if attempt >= self.max_schema_retries:
                        raise
                    budget = min(budget * 3, 64_000)
                    last_err = str(exc)
                    continue
                bill(usage)
                out = {
                    "text": text, "attempts": attempt + 1,
                    "usage": usage.to_dict(), "billed": billed.to_dict(),
                    "billed_usd": fired["usd"],
                    "billed_usd_source": fired["usd_source"],
                }
                if schema is None:
                    return {**out, "data": None}
                try:
                    data = _parse_json(text)
                    _validate(data, schema)
                    return {**out, "data": data}
                except (ValueError, TypeError) as exc:
                    last_err = str(exc)
                    # 输出被**截断**（JSON 没写完）和"格式写错了"是两回事：前者
                    # 重试多少次都一样，除非把预算加大。密集内容 + 会思考的模型
                    # 尤其容易撞上 —— 实测 recommend 用 400 token 连撞三次全是
                    # 「JSON 不完整」，然后整条链路失败。
                    if _looks_truncated(last_err):
                        budget = min(budget * 3, 64_000)
            raise ModelError(
                f"{spec.name} 连续 {1 + self.max_schema_retries} 次输出不合 schema: {last_err}"
            )

        try:
            raw = await self.rec.effect(node_id, "llm.call", req, do, key=key)
        except Exception:
            # **打出去了但最终失败的那些次也花了钱。** 以前这里什么都不记，于是
            # 一次连撞三回 schema 然后放弃的调用，在账上等于没发生过。
            self._log_usage(node_id, spec, fired, status="failed")
            billed: Usage = fired.get("billed") or Usage()
            self._charge_usage(
                node_id, spec, billed,
                attempts=int(fired.get("attempts") or 1),
                status="failed", emit=bool(fired.get("hit")),
                usd=float(fired.get("usd") or 0.0),
            )
            raise

        # ``usage`` 是最后一次模型响应的历史字段；``billed`` 才是这个逻辑调用
        # 的真实总花费（含 schema/截断重试）。旧 journal 没有 billed 时回退到
        # usage，保证升级后仍能确定性重放。
        u = Usage(**(raw.get("billed") or raw["usage"]))
        usd = float(raw.get("billed_usd", self._usage_cost(spec, u)))
        comp = Completion(
            text=raw["text"], data=raw.get("data"), model=spec.name,
            usage=u,
            usd=usd,
            attempts=raw["attempts"],
        )
        self._log_usage(node_id, spec, fired, status="ok")
        self._charge_usage(
            node_id, spec, u, attempts=comp.attempts, status="ok",
            # 回放要把新建的内存 Budget 恢复到正确水位，但 journal 已有首次
            # BUDGET_SPENT；再追加一条会让事件审计看起来像付了两次钱。
            emit=bool(fired.get("hit")), usd=usd,
        )
        return comp

    @staticmethod
    def _usage_cost(spec: ModelSpec, usage: Usage) -> float:
        return usage.usd if usage.usd is not None else spec.cost(
            usage.tok_in, usage.tok_out, usage.cache_read, usage.cache_write,
        )

    def _charge_usage(
        self,
        node_id: str,
        spec: ModelSpec,
        usage: Usage,
        *,
        attempts: int,
        status: str,
        emit: bool,
        usd: float | None = None,
    ) -> float:
        """把一次逻辑调用的**全部尝试**计入运行预算。

        Durable usage ledger 只在真的触发后端时写一行；Budget 则是当前进程里的
        运行投影，Recorder 回放时也要按历史 billed 恢复。因此 spend 与 emit
        故意分开：回放 spend、但不制造第二条付费事件。
        """
        charged_usd = self._usage_cost(spec, usage) if usd is None else usd
        self.budget.spend(tokens=usage.total, usd=charged_usd)
        if emit:
            self.rec.emit(
                EventKind.BUDGET_SPENT,
                node_id=node_id,
                payload={
                    "model": spec.name, "effort": spec.effort,
                    "tok_in": usage.tok_in, "tok_out": usage.tok_out,
                    "cache_read": usage.cache_read, "cache_write": usage.cache_write,
                    "usd": round(charged_usd, 5), "attempts": attempts, "status": status,
                    "level": int(self.budget.level),
                },
            )
        return charged_usd

    def _log_usage(self, node_id: str, spec: ModelSpec,
                   fired: dict[str, Any], *, status: str) -> None:
        """把这次调用记进用量账本。**只记真打出去的那次。**

        ``usage_sink`` 由外面注入（服务端塞一个写库的），kernel 这层不认识存储。
        沉不进去不该把一次模型调用带下去 —— 记账失败是记账的事。
        """
        if self.usage_sink is None or not fired.get("hit"):
            return
        u: Usage = fired.get("billed") or Usage()
        try:
            self.usage_sink({
                "node_id": node_id, "model": spec.name, "effort": spec.effort or "",
                "tok_in": u.tok_in, "tok_out": u.tok_out,
                "cache_read": u.cache_read, "cache_write": u.cache_write,
                # 网关回了真实账单就用它，并**标明来源** —— 本地价目表对经网关
                # 发现的模型是编的（catalog 统一填 2.0/8.0），估出来的金额看着
                # 精确其实是错的，界面据此决定敢不敢把它当钱显示。
                "usd": float(fired.get("usd") or 0.0),
                "usd_source": fired.get("usd_source") or "estimated",
                "attempts": int(fired.get("attempts") or 1),
                "status": status,
                "run_id": getattr(self.rec, "run_id", "") or "",
            })
        except Exception:               # noqa: BLE001 —— 用量 sink 是旁路
            return

    async def judge(
        self,
        node_id: str,
        prompt: str,
        *,
        generator: ModelSpec,
        schema: dict[str, Any] | None = None,
        salt: int = 0,
        key: str | None = None,
        system: str = "",
    ) -> Completion:
        """以评委身份调用。强制换一个模型。"""
        return await self.call(
            node_id, prompt, system=system, schema=schema,
            model=self.routing.judge_for(generator, salt), key=key,
        )

    # ── 路由参数 ────────────────────────────────────────────────
    def iterations_for(self, d: Difficulty) -> int:
        return self.routing.max_iterations.get(d, 4)

    def critic_rounds_for(self, d: Difficulty, requested: int | None = None) -> int:
        base = self.routing.critic_rounds.get(d, 1) if requested is None else requested
        return self.budget.critic_rounds(base)

    def samples_for(self, d: Difficulty) -> int:
        n = self.routing.self_consistency.get(d, 1)
        return n if self.budget.allow_self_consistency() else 1


# ══════════════════════════════════════════════════════════════════
#  结构化输出
# ══════════════════════════════════════════════════════════════════
_FENCE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.DOTALL)


def _parse_json(text: str) -> Any:
    """从模型输出里抠 JSON。宽容一点：允许围栏、允许前后有零碎文字。

    真实后端用了 ``output_config.format`` 强制 JSON，正常路径下 ``json.loads``
    一次就过；这些兜底是给 ScriptedBackend 和降级路径准备的。
    """
    t = text.strip()
    # **先按整体解析。** 以前是无条件先抠围栏，而 `_FENCE.search` 是全文搜索 ——
    # 于是当回答**内容里**含一段 ```json（比如用户就是要一份 JSON Schema 范例），
    # 那段范例会把真正的外层结构顶掉，然后拿范例去当结构化输出解析、失败三次、
    # 整轮报错。问 JSON/代码问题必挂，正常路径反而没事，很难往这想。
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    # 整体不是 JSON，才考虑围栏：**优先开头那个**（那才是模型把答案包起来的写法），
    # 找不到再退回全文里的第一个。
    m = re.match(r"```(?:json)?\s*(.+?)\s*```\s*$", t, re.DOTALL) or _FENCE.search(t)
    if m:
        inner = m.group(1).strip()
        try:
            return json.loads(inner)
        except json.JSONDecodeError:
            t = inner
    start = min((i for i in (t.find("{"), t.find("[")) if i >= 0), default=-1)
    if start < 0:
        raise ValueError("输出里找不到 JSON")
    end = max(t.rfind("}"), t.rfind("]"))
    if end <= start:
        raise ValueError("JSON 不完整（输出被截断）")
    try:
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败: {exc}") from None


def _validate(data: Any, schema: dict[str, Any], path: str = "$") -> None:
    """JSON Schema 的实用子集校验。

    只覆盖我们实际用到的：type / required / properties / items / enum。
    刻意不引 jsonschema —— 内核依赖越少越好，而且这里的错误信息要直接喂回
    给模型，标准库的报错太啰嗦。
    """
    t = schema.get("type")
    if t == "object":
        if not isinstance(data, dict):
            raise TypeError(f"{path} 应为 object，实际 {type(data).__name__}")
        for req in schema.get("required", ()):
            if req not in data:
                raise ValueError(f"{path} 缺少必填字段 {req!r}")
        for k, sub in (schema.get("properties") or {}).items():
            if k in data:
                _validate(data[k], sub, f"{path}.{k}")
    elif t == "array":
        if not isinstance(data, list):
            raise TypeError(f"{path} 应为 array，实际 {type(data).__name__}")
        if item := schema.get("items"):
            for i, v in enumerate(data):
                _validate(v, item, f"{path}[{i}]")
    elif t == "string":
        if not isinstance(data, str):
            raise TypeError(f"{path} 应为 string")
    elif t == "number":
        if not isinstance(data, (int, float)) or isinstance(data, bool):
            raise TypeError(f"{path} 应为 number")
    elif t == "integer":
        if not isinstance(data, int) or isinstance(data, bool):
            raise TypeError(f"{path} 应为 integer")
    elif t == "boolean":
        if not isinstance(data, bool):
            raise TypeError(f"{path} 应为 boolean")

    if (allowed := schema.get("enum")) and data not in allowed:
        raise ValueError(f"{path} 取值 {data!r} 不在允许集合 {allowed}")
