"""设置页后端 —— 网关/模型/预算配置 + 环境镜像（只读）。**全部仅管理员**。

只读侧沿用 /api/health 的"安全回显"套路：密钥永远 redacted，DATABASE_URL 的
口令段也抹掉。写入侧把改动落进 app_setting，经 :mod:`appconfig` 热应用到新 Run。

BASIC 范围：只暴露 base_url / api_key（只写）/ 各档模型选择 / 预算上限。评委、
effort、迭代轮数保持代码默认，UI 不碰 —— effort 由服务端按能力派生（见 llm）。
"""

from __future__ import annotations

import os
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException

from . import appconfig
from .authgate import require_admin
from .kernel import gateway_balance
from .kernel.catalog import ModelCatalog
from .kernel.dag import Difficulty
from .kernel.llm import gateway_routing
from .store.deps import get_repo
from .store.repo import Repo

router = APIRouter(prefix="/api/config", dependencies=[Depends(require_admin)])

_TIER_DIFF = {"low": Difficulty.LOW, "medium": Difficulty.MEDIUM,
              "high": Difficulty.HIGH, "critical": Difficulty.CRITICAL}


def _redact_secret(v: str) -> str:
    return (f"{v[:6]}…{v[-4:]}" if len(v) > 12 else "…") if v else ""


def _redact_db_url(url: str) -> str:
    """抹掉连接串里的口令段 —— 绝不把 DB 口令发给浏览器。"""
    if not url:
        return ""
    try:
        p = urlsplit(url)
        if p.password:
            netloc = p.netloc.replace(f":{p.password}@", ":***@", 1)
            return urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))
    except ValueError:
        return "***"
    return url


#: (变量名, 是否密钥, 是否可在别处改, 是否需重启)。这里一律**只读展示**。
_ENV_MIRROR = [
    ("CUSTOM_LLM_BASE_URL", False, False),
    ("CUSTOM_LLM_API_KEY", True, False),
    ("DATABASE_URL", True, True),
    ("ONTOCOPILOT_WORKSPACE", False, True),
    ("ONTOCOPILOT_NO_DB", False, True),
    ("ONTOCOPILOT_AUTH", False, True),
    ("ONTOCOPILOT_COOKIE_SECURE", False, True),
    ("ONTOCOPILOT_SESSION_TTL_HOURS", False, True),
    ("ONTOCOPILOT_CORS_ORIGINS", False, True),
    ("ONTOCOPILOT_USD_CAP", False, False),
    ("ONTOCOPILOT_CHAT_USD_CAP", False, False),
]


def _env_view() -> list[dict[str, Any]]:
    out = []
    for name, secret, restart in _ENV_MIRROR:
        raw = os.getenv(name, "")
        if name == "DATABASE_URL":
            val = _redact_db_url(raw)
        elif secret:
            val = _redact_secret(raw)
        else:
            val = raw
        out.append({"name": name, "value": val, "set": bool(raw),
                    "secret": secret, "restart": restart})
    return out


def _gateway_creds() -> tuple[str, str]:
    """当前生效的网关 base / 密钥（设置 → 环境，与 appconfig 同一优先级）。"""
    base = str(appconfig.get(appconfig.GATEWAY_BASE_URL)
               or os.getenv("CUSTOM_LLM_BASE_URL", "")).rstrip("/")
    key = str(appconfig.get(appconfig.GATEWAY_API_KEY)
              or os.getenv("CUSTOM_LLM_API_KEY", ""))
    return base, key


#: 设置页那次探测的秒数上限。比默认的 5s 短：这是一次点击的等待时间，而余额只是
#: 页面上的一行字 —— 宁可显示"未知"，也不要让设置页转圈。
_PROBE_TIMEOUT = 3.0


async def _balance_view() -> dict[str, Any]:
    """余额一行。**任何失败都渲染成「未知」**（铁律 C1 / C5）：网关没有余额接口
    是常态，绝不能让设置页因此报错，更不能把"查不到"说成"余额不足"。"""
    base, key = _gateway_creds()
    try:
        bal = await gateway_balance.cached_balance(base, key, timeout=_PROBE_TIMEOUT)
    except Exception:  # noqa: BLE001 — 探测不是设置页的必要条件
        return gateway_balance.Balance().to_dict()
    return bal.to_dict()


def _snapshot(repo_unused: Any = None) -> dict[str, Any]:
    cat = ModelCatalog()
    overrides = appconfig.model_overrides()
    routing = gateway_routing(overrides, cat)
    defaults = gateway_routing(None, cat)
    tiers = {}
    for key, diff in _TIER_DIFF.items():
        spec = routing.model_for(diff)
        tiers[key] = {"model": spec.name, "effort": spec.effort,
                      "overridden": key in overrides,
                      "default": defaults.model_for(diff).name}
    base, raw_key = _gateway_creds()
    return {
        "gateway": {"base_url": base, "api_key": _redact_secret(raw_key),
                    "key_set": bool(raw_key), "insecure": base.startswith("http://")},
        "tiers": tiers,
        "catalog": cat.describe(),
        "budget": {"usd_cap": appconfig.usd_cap(),
                   "chat_usd_cap": appconfig.chat_usd_cap()},
        "env": _env_view(),
    }


@router.get("")
async def get_config():
    # 按需查，**不在 lifespan 里查**：启动依赖外部网络就成了"网关不通 → 服务起不来"。
    return {**_snapshot(), "balance": await _balance_view()}


@router.put("")
async def put_config(body: dict, repo: Annotated[Repo, Depends(get_repo)]):
    updates: dict[str, Any] = {}
    cat_names = set(ModelCatalog().names())

    if "base_url" in body:
        base = str(body["base_url"] or "").strip().rstrip("/")
        if not base:
            raise HTTPException(400, "base_url 不能为空")
        updates[appconfig.GATEWAY_BASE_URL] = base

    if "api_key" in body:
        key = str(body["api_key"] or "")
        # 只写不回显：空串 / 含省略号（那是回显值）一律视为"保持不变"，绝不把
        # redacted 占位符当成真值写回去。
        if key and "…" not in key:
            updates[appconfig.GATEWAY_API_KEY] = key

    models = body.get("models")
    if isinstance(models, dict):
        for tier, name in models.items():
            if tier not in _TIER_DIFF:
                raise HTTPException(400, f"未知难度档：{tier}")
            name = str(name or "").strip()
            if not name:
                updates[f"gateway.model.{tier}"] = None       # 清覆盖 → 回默认
            elif name in cat_names:
                updates[f"gateway.model.{tier}"] = name
            else:
                raise HTTPException(400, f"模型不在目录中：{name}")

    for field_, skey in (("usd_cap", appconfig.BUDGET_USD_CAP),
                         ("chat_usd_cap", appconfig.BUDGET_CHAT_USD_CAP)):
        if field_ in body:
            try:
                v = float(body[field_])
            except (TypeError, ValueError):
                raise HTTPException(400, f"{field_} 必须是数字") from None
            if v <= 0:
                raise HTTPException(400, f"{field_} 必须大于 0")
            updates[skey] = v

    await appconfig.apply(repo, updates)
    # 换了 base/密钥还显示上一个账户的余额是纯误导 —— 存完就把缓存清掉再探一次。
    gateway_balance.invalidate_cache()
    return {**_snapshot(), "balance": await _balance_view()}


__all__ = ["router"]
