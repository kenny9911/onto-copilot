"""真实模型后端。

两个实现，接口相同（:class:`~.llm.LLMBackend`），网关不关心用的是哪个：

  * :class:`AnthropicBackend` —— Anthropic Messages API 原生。``effort``、
    自适应思考、system 层缓存断点、``stop_reason=="refusal"`` 都用原生语义。
  * :class:`OpenAICompatBackend` —— OpenAI ``/chat/completions`` 协议，用于
    OpenRouter 风格的聚合网关。**能拿到网关回报的真实成本**，比本地定价表准。

后端只做四件事：翻译请求、拿真实用量、处理拒绝、重试瞬时故障。路由、记账、
schema 重试、重放全在网关里。
"""

from __future__ import annotations

import asyncio
import json
import random
from typing import Any

import httpx

from .llm import (
    LLMBackend,
    ModelError,
    ModelRefusal,
    ModelSpec,
    ModelTruncated,
    QuotaExhausted,
    Usage,
)

#: 超过这个 max_tokens 必须走流式，否则会撞 HTTP 超时。
STREAM_THRESHOLD = 16_000

#: 服务端兜底：安全分类器拒绝时自动换模型重跑，比我们自己接住再重试省一个往返。
FALLBACK_BETA = "server-side-fallback-2026-07-01"

#: 值得重试的瞬时故障。4xx（除 429）是请求本身的问题，重试没意义。
RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504, 529})

#: 配额耗尽的标志词，大小写不敏感、命中任一即可。前六个是各家网关的机器可读
#: 字段值（``error.type`` / ``error.code``），后几个是中文网关的人类文案。
_QUOTA_MARKERS: tuple[str, ...] = (
    "insufficient_quota",
    "insufficient_user_quota",
    "exceeded_current_quota",
    "quota_exceeded",
    "billing_hard_limit_reached",
    "credit",
    "余额",
    "额度",
    "欠费",
)


def looks_like_quota_exhausted(status: int, body: str) -> bool:
    """这个响应是不是"网关账户真的没钱了"（S1 硬信号）。

    纯函数，没有 IO，好单测 —— 这个判断错了两边都很贵：判宽了会把一次真限流
    说成欠费、让用户去给一个没欠费的账户充值；判窄了就退回"白等几轮退避"。

    两条规则：

      * ``402 Payment Required`` —— 语义就是这个，不看 body。
      * ``429`` **且** body 里有配额标志词。429 是欠费与限流共用的状态码，
        只能靠 body 分。

    **整个 body 都扫，不只扫 ``message``**：真实网关（New-API 系）的欠费 429
    长这样 ——
    ``{"error":{"message":"当前分组上游负载已饱和，请稍后再试",
    "type":"insufficient_quota","code":"insufficient_user_quota"}}``。
    ``message`` 写得跟限流一模一样，只有 ``type`` / ``code`` 说了实话。

    其余状态码一律 False：body 里出现"额度"二字不代表这次 500 是欠费。
    """
    if status == 402:
        return True
    if status != 429:
        return False
    low = (body or "").lower()
    return any(marker in low for marker in _QUOTA_MARKERS)


def _raise_if_quota(model: str, exc: Exception) -> None:
    """SDK 抛出来的 HTTP 异常若是欠费信号，换成 :class:`QuotaExhausted`。

    刻意用鸭子类型取 ``status_code`` / 响应体，**不 import anthropic 的异常类**：
    离线 demo 与测试都跑在没装 SDK / 用假 client 的环境里，为了认一个状态码把
    整个模块变成硬依赖不划算。

    不是欠费就原样返回，由调用方把原异常抛回去 —— 这里只做分流，不吞异常。
    """
    status = int(getattr(exc, "status_code", 0) or 0)
    body = getattr(exc, "body", None)
    text = json.dumps(body, ensure_ascii=False) if body is not None else ""
    if not text:
        text = getattr(getattr(exc, "response", None), "text", "") or str(exc)
    if looks_like_quota_exhausted(status, text):
        raise QuotaExhausted(model, text, status=status) from exc


# ══════════════════════════════════════════════════════════════════
#  Anthropic 原生
# ══════════════════════════════════════════════════════════════════
class AnthropicBackend(LLMBackend):
    """Anthropic Messages API 后端。

    Args:
        client: ``AsyncAnthropic`` 实例。不传则按环境凭证自行构造。
        cache_system: 是否给 system 层打缓存断点。默认开 —— 这是本系统最划算的
            一项优化：L0 层在整个 Run 内字节稳定，而每个节点都要带上它。
        server_fallback: 拒绝时是否让服务端自动切模型。

    注意当前一代模型（Opus 5 / Sonnet 5）已移除 ``temperature`` / ``top_p`` /
    ``top_k``，传了直接 400；推理深度用 ``effort``。
    """

    def __init__(
        self,
        client: Any = None,
        *,
        cache_system: bool = True,
        server_fallback: bool = True,
    ) -> None:
        if client is None:
            from anthropic import AsyncAnthropic  # 延迟导入：离线 demo 不需要 SDK

            client = AsyncAnthropic()
        self.client = client
        self.cache_system = cache_system
        self.server_fallback = server_fallback

    def _build(
        self, *, model: ModelSpec, prompt: str, system: str,
        schema: dict[str, Any] | None, max_tokens: int, cache_system: bool,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": model.name,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            block: dict[str, Any] = {"type": "text", "text": system}
            if cache_system:
                # 渲染顺序是 tools → system → messages，所以这一个断点同时覆盖两者。
                block["cache_control"] = {"type": "ephemeral"}
            kwargs["system"] = [block]

        output_config: dict[str, Any] = {}
        if model.effort:
            output_config["effort"] = model.effort
        if schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": strictify(schema)}
        if output_config:
            kwargs["output_config"] = output_config
        if model.thinking:
            kwargs["thinking"] = {"type": "adaptive"}
        return kwargs

    async def generate(
        self, *, model: ModelSpec, prompt: str, system: str = "",
        schema: dict[str, Any] | None = None, max_tokens: int = 16_000,
        cache_system: bool = True, images: list[str] | None = None,
    ) -> tuple[str, Usage]:
        if images:
            raise ModelError("AnthropicBackend 的视觉输入尚未接线，请用 OpenAICompatBackend")
        kwargs = self._build(
            model=model, prompt=prompt, system=system, schema=schema,
            max_tokens=max_tokens, cache_system=cache_system and self.cache_system,
        )
        if self.server_fallback:
            kwargs["betas"] = [FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
            api = self.client.beta.messages
        else:
            api = self.client.messages

        try:
            if max_tokens > STREAM_THRESHOLD:
                async with api.stream(**kwargs) as stream:
                    msg = await stream.get_final_message()
            else:
                msg = await api.create(**kwargs)
        except Exception as exc:
            # 只分流欠费信号，其余原样抛。
            # Anthropic 直连也会 402（账户余额耗尽），SDK 把它抛成一个普通的
            # APIStatusError，上层只看得到"调用失败"。分流出来才有人话可说。
            _raise_if_quota(model.name, exc)
            raise

        if msg.stop_reason == "refusal":
            raise ModelRefusal(
                model.name, getattr(getattr(msg, "stop_details", None), "category", None)
            )

        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        u = msg.usage
        return text, Usage(
            tok_in=getattr(u, "input_tokens", 0) or 0,
            tok_out=getattr(u, "output_tokens", 0) or 0,
            cache_read=getattr(u, "cache_read_input_tokens", 0) or 0,
            cache_write=getattr(u, "cache_creation_input_tokens", 0) or 0,
        )


# ══════════════════════════════════════════════════════════════════
#  OpenAI 兼容网关
# ══════════════════════════════════════════════════════════════════
class OpenAICompatBackend(LLMBackend):
    """OpenAI ``/chat/completions`` 协议后端（OpenRouter 风格聚合网关）。

    与 Anthropic 原生的三点差异，都会影响上层行为，所以在这里显式处理：

      1. **结构化输出**走 ``response_format.json_schema`` 而不是
         ``output_config.format``，且 ``strict`` 要求每个 object 显式关掉
         ``additionalProperties``。
      2. **推理深度**走 ``reasoning.effort``（OpenRouter 约定）。网关不认这个
         字段时会 400，此时降级重发一次而不是整个失败 —— 少一档推理好过没结果。
      3. **成本由网关回报**（``usage.cost``），比本地定价表准。网关没给才回退到
         :meth:`ModelSpec.cost` 估算。

    Args:
        base_url: 形如 ``http://host:3010/v1``。
        api_key: 凭证。**只从环境读，不接受源码硬编码**（见 :mod:`.config`）。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 300.0,
        max_retries: int = 3,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._key = api_key
        self.max_retries = max_retries
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=15.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "content-type": "application/json",
                **(extra_headers or {}),
            },
        )
        #: 网关明确拒绝过的可选字段，后续请求直接不带 —— 避免每次都白试一轮。
        self._unsupported: set[str] = set()

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── 请求组装 ────────────────────────────────────────────────
    def _build(
        self, *, model: ModelSpec, prompt: str, system: str,
        schema: dict[str, Any] | None, max_tokens: int, drop: set[str],
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        if images:
            # 文字在前、图在后：先说清要干什么，模型看图时才有目标
            content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            content += [{"type": "image_url", "image_url": {"url": u}} for u in images]
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": prompt})

        body: dict[str, Any] = {
            "model": model.name,
            "max_tokens": max_tokens,
            "messages": messages,
        }
        if schema is not None and "response_format" not in drop:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "strict": True, "schema": strictify(schema)},
            }
        if model.effort and "reasoning" not in drop:
            body["reasoning"] = {"effort": model.effort}
        return body

    # ── 调用 ────────────────────────────────────────────────────
    async def generate(
        self, *, model: ModelSpec, prompt: str, system: str = "",
        schema: dict[str, Any] | None = None, max_tokens: int = 16_000,
        cache_system: bool = True, images: list[str] | None = None,
    ) -> tuple[str, Usage]:
        drop = set(self._unsupported)
        last: Exception | None = None

        for attempt in range(self.max_retries + 1):
            body = self._build(model=model, prompt=prompt, system=system,
                               schema=schema, max_tokens=max_tokens, drop=drop,
                               images=images)
            try:
                resp = await self._client.post(f"{self.base_url}/chat/completions", json=body)
            except httpx.RequestError as exc:  # 网络层故障 —— 可重试
                last = exc
                await self._backoff(attempt)
                continue

            if resp.status_code == 400 and (field := self._offending_field(resp.text, body)):
                # 网关不认某个可选字段：记下来，降级重发。少一档推理好过没结果。
                self._unsupported.add(field)
                drop.add(field)
                last = ModelError(f"{model.name} 不支持 {field}，已降级重发：{resp.text[:200]}")
                continue

            # **必须排在 RETRYABLE_STATUS 之前。** 欠费与限流共用 429，落进重试
            # 分支就是纯浪费：退避多少轮账户也不会自己有钱，用户白等一遍才收到
            # 一句 `HTTP 429`。这里立刻抛、一次都不重试。
            if looks_like_quota_exhausted(resp.status_code, resp.text):
                raise QuotaExhausted(model.name, resp.text, status=resp.status_code)

            if resp.status_code in RETRYABLE_STATUS:
                last = ModelError(f"{model.name} HTTP {resp.status_code}: {resp.text[:200]}")
                await self._backoff(attempt, resp.headers.get("retry-after"))
                continue

            if resp.status_code >= 400:
                raise ModelError(f"{model.name} HTTP {resp.status_code}: {resp.text[:400]}")

            return self._parse(model, resp.json())

        raise ModelError(f"{model.name} 重试 {self.max_retries} 次后仍失败: {last}")

    # ── 响应解析 ────────────────────────────────────────────────
    def _parse(self, model: ModelSpec, data: dict[str, Any]) -> tuple[str, Usage]:
        choices = data.get("choices") or []
        if not choices:
            raise ModelError(f"{model.name} 返回空 choices: {json.dumps(data)[:300]}")
        msg = choices[0].get("message") or {}

        if refusal := msg.get("refusal"):
            raise ModelRefusal(model.name, str(refusal)[:120])
        if choices[0].get("finish_reason") == "content_filter":
            raise ModelRefusal(model.name, "content_filter")

        text = msg.get("content") or ""
        if not text and msg.get("reasoning"):
            # 只出了思考没出正文 —— max_tokens 被思考吃光了。抛**可重试**的
            # ModelTruncated，让网关加大预算再来一次；抛普通 ModelError 的话
            # 这份材料就直接白传了。
            raise ModelTruncated(
                f"{model.name} 只返回了推理内容、没有正文，"
                f"多半是 max_tokens 不够（本次 finish_reason="
                f"{choices[0].get('finish_reason')}）"
            )

        u = data.get("usage") or {}
        pd = u.get("prompt_tokens_details") or {}
        cached = pd.get("cached_tokens", 0) or 0
        usage = Usage(
            # prompt_tokens 含缓存命中部分，扣掉才是真正按全价计的输入
            tok_in=max(0, (u.get("prompt_tokens", 0) or 0) - cached),
            tok_out=u.get("completion_tokens", 0) or 0,
            cache_read=cached,
            cache_write=pd.get("cache_write_tokens", 0) or 0,
            usd=u.get("cost"),  # 网关回报的真实成本，优先于本地估算
        )
        return text, usage

    # ── 辅助 ────────────────────────────────────────────────────
    @staticmethod
    def _offending_field(error_text: str, body: dict[str, Any]) -> str | None:
        """400 是不是因为某个可选字段不被支持。"""
        low = error_text.lower()
        for field in ("response_format", "reasoning"):
            if field in body and field in low:
                return field
        return None

    @staticmethod
    async def _backoff(attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                await asyncio.sleep(min(30.0, float(retry_after)))
                return
            except ValueError:
                pass
        # 抖动：并发节点同时撞限流时避免整齐重试再次撞墙
        await asyncio.sleep(min(20.0, (2**attempt) * 0.8 + random.random()))


# ══════════════════════════════════════════════════════════════════
#  共用
# ══════════════════════════════════════════════════════════════════
def strictify(schema: dict[str, Any]) -> dict[str, Any]:
    """结构化输出要求每个 object 显式关掉 ``additionalProperties``，且
    ``required`` 必须列全所有属性（OpenAI strict 模式的硬要求）。

    我们内部的 schema 只写业务字段，这里统一补齐，免得每处定义都写一遍模板噪音。
    """
    if schema.get("type") == "object":
        props = schema.get("properties") or {}
        return {
            **schema,
            "additionalProperties": False,
            "required": sorted(props),  # strict 模式要求列全
            "properties": {k: strictify(v) for k, v in props.items()},
        }
    if schema.get("type") == "array" and (item := schema.get("items")):
        return {**schema, "items": strictify(item)}
    return schema
