"""运行时配置提供者 —— DB 覆盖优先于环境变量，热应用到**新** Run。

线上 ``_gateways()`` 每个 Run 都新建一次网关（server.py），所以只要它读这里的
缓存，管理员在设置页改的网关/模型/预算就会自动作用到下一次 Run，无需重启进程。

**缓存原子替换**：后台流水线（``asyncio.create_task``）不在请求作用域里、会在
两次 await 之间读缓存；所以 :func:`refresh` 先构好新 dict、再一次性重绑模块全局，
读者永远看到的是"旧的一整份"或"新的一整份"，不会撞上半更新态。

**不静默降级**：:func:`resolved_llm_config` 自己做 DB→env→raise，绝不回落到会
抛错的 ``llm_config()`` 作基线 —— 那样纯 UI 配置（env 里没写 key）就用不了了。
"""

from __future__ import annotations

import os
from typing import Any

from .kernel.config import LLMConfig

#: 进程级设置缓存。**只整体重绑，不原地改**（见模块 docstring）。
_CACHE: dict[str, Any] = {}

#: 会通过设置页读写的键。
GATEWAY_BASE_URL = "gateway.base_url"
GATEWAY_API_KEY = "gateway.api_key"
BUDGET_USD_CAP = "budget.usd_cap"
BUDGET_CHAT_USD_CAP = "budget.chat_usd_cap"
_TIERS = ("low", "medium", "high", "critical")


async def refresh(repo: Any) -> None:
    """从仓储重新载入设置缓存（原子替换）。"""
    global _CACHE
    rows = await repo.list_settings()
    _CACHE = {r.key: r.value for r in rows}


def get(key: str, default: Any = None) -> Any:
    return _CACHE.get(key, default)


def _num(key: str, env: str, default: float) -> float:
    v = _CACHE.get(key)
    if v is not None:
        try:
            return float(v)
        except (TypeError, ValueError):
            pass
    try:
        return float(os.getenv(env, "") or default)
    except (TypeError, ValueError):
        return default


def usd_cap() -> float:
    return _num(BUDGET_USD_CAP, "ONTOCOPILOT_USD_CAP", 15.0)


def chat_usd_cap() -> float:
    return _num(BUDGET_CHAT_USD_CAP, "ONTOCOPILOT_CHAT_USD_CAP", 3.0)


def model_overrides() -> dict[str, str]:
    """各难度档的模型覆盖（只含设置页真正配了的档）。"""
    out: dict[str, str] = {}
    for tier in _TIERS:
        v = _CACHE.get(f"gateway.model.{tier}")
        if v:
            out[tier] = str(v)
    return out


def resolved_llm_config() -> LLMConfig:
    """解析网关 base_url / api_key：设置 → 环境 → 抛错。

    Raises:
        RuntimeError: 两者都没配。和 :func:`kernel.config.llm_config` 同一条纪律：
            宁可显式失败，也不静默换端点。
    """
    base = str(_CACHE.get(GATEWAY_BASE_URL) or os.getenv("CUSTOM_LLM_BASE_URL", "")).rstrip("/")
    key = str(_CACHE.get(GATEWAY_API_KEY) or os.getenv("CUSTOM_LLM_API_KEY", ""))
    missing = [n for n, v in ((GATEWAY_BASE_URL, base), (GATEWAY_API_KEY, key)) if not v]
    if missing:
        raise RuntimeError(f"缺少 LLM 网关配置 {missing}：在设置页填写，或写进 .env")
    return LLMConfig(base_url=base, api_key=key)


async def apply(repo: Any, updates: dict[str, Any]) -> None:
    """写入一批设置并刷新缓存。``value`` 为 ``None`` 的键表示删除。"""
    for k, v in updates.items():
        if v is None:
            await repo.delete_setting(k)
        else:
            await repo.set_setting(k, v)
    await refresh(repo)


__all__ = ["refresh", "get", "usd_cap", "chat_usd_cap", "model_overrides",
           "resolved_llm_config", "apply", "GATEWAY_BASE_URL", "GATEWAY_API_KEY",
           "BUDGET_USD_CAP", "BUDGET_CHAT_USD_CAP"]
