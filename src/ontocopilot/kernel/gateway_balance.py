"""网关余额探测（best-effort）+ 三类「钱不够」的文案。

OpenAI 兼容网关（New-API / one-api / OpenRouter 这一类）**大多根本没有余额接口**，
有的那几家路径还各不相同。所以这个模块只有一条立场：**查不到就是「未知」**。把
"查不到"渲染成"余额不足"，用户会跑去给一个根本没欠费的账户充值 —— 那比不显示
余额糟得多。

同一个道理，本地 ``usd_cap`` 用满（我们自己设的闸）和网关欠费是**两回事**，文案
必须分开：:func:`budget_capped_text` 里绝不出现"充值/余额/欠费"这类词。

本模块不依赖 store、不依赖 server，也**不往外抛异常**：任何失败都收敛成
``Balance()``（未知）。探测挂了不该让梳理、设置页、任何东西跟着挂。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

#: New-API 系的额度单位。**不是美元** —— 它是 token 额度，各家换算率还能自己配，
#: 猜一个汇率标上 "$" 比不标更糟（用户会照着这个数决定要不要充值）。
QUOTA_UNIT = "quota"

#: 余额"偏低"的判据。美元口径：跑一次梳理的默认上限是 $15，剩不到 $5 基本跑不完
#: 一轮，值得先说一声；额度口径换算不确定，只看比例。
LOW_USD = 5.0
LOW_RATIO = 0.10

#: 进程内缓存的存活时间。设置页连点几下不该把网关打一遍。
CACHE_TTL = 60.0


@dataclass(frozen=True, slots=True)
class Balance:
    """一次余额探测的结果。**默认就是"未知"** —— 构造一个空的即表示没查到。"""

    total: float | None = None
    used: float | None = None
    remaining: float | None = None
    currency: str = "USD"
    #: 命中的是哪个端点，写给人看的（"这个数是从哪来的"必须能追）。
    source: str = ""

    @property
    def known(self) -> bool:
        # 只认 remaining：知道总额却不知道花了多少，等于不知道还剩多少。
        return self.remaining is not None

    def human(self) -> str:
        """给人看的剩余额度。未知就说未知，**不说 0** —— 0 是"没钱了"。"""
        if self.remaining is None:
            return "未知"
        if self.currency == "USD":
            return f"${self.remaining:,.2f}"
        return f"{self.remaining:,.0f} 额度"

    def to_dict(self) -> dict[str, Any]:
        if not self.known:
            return {"known": False}
        return {"known": True, "total": self.total, "used": self.used,
                "remaining": self.remaining, "currency": self.currency,
                "source": self.source, "text": self.human()}


def is_low(b: Balance, *, usd_floor: float = LOW_USD, ratio: float = LOW_RATIO) -> bool:
    """余额是否低到值得提醒。**未知永远返回 False**（铁律 C1）。"""
    if not b.known or b.remaining is None:
        return False
    if b.currency == "USD" and b.remaining <= usd_floor:
        return True
    if b.total and b.total > 0:
        return b.remaining / b.total <= ratio
    return False


# ══════════════════════════════════════════════════════════════════
#  探测
# ══════════════════════════════════════════════════════════════════
#: 一个端点探测器：拿到客户端/base/请求头，返回 Balance（拿不到就是未知）。
_Probe = Callable[[httpx.AsyncClient, str, dict[str, str]], Awaitable["Balance"]]


def _auth(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}


def _num(v: Any) -> float | None:
    """只认真能当数用的值。``None`` / 字符串 / 布尔一律当没拿到。"""
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return float(v)


def _site_root(base: str) -> str:
    """把 ``…/v1`` 这样的 API 前缀退回站点根。

    New-API 的用户接口挂在站点根（``/api/user/self``）而不是 OpenAI 前缀下面，
    照着 base 直接拼会稳定 404。
    """
    return base[:-3].rstrip("/") if base.endswith("/v1") else base


async def _get_json(cl: httpx.AsyncClient, url: str, headers: dict[str, str],
                    params: dict[str, str] | None = None) -> dict[str, Any] | None:
    """取一个 JSON 对象。非 200 / 不是 JSON（例如网关把请求路由到了登录页 HTML）
    / 不是对象，都当"这条路不通"，返回 None。"""
    r = await cl.get(url, headers=headers, params=params)
    if r.status_code != 200:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def _probe_openai_billing(cl: httpx.AsyncClient, base: str,
                                headers: dict[str, str]) -> Balance:
    """OpenAI 兼容口径：``hard_limit_usd`` - ``total_usage``/100（后者是**美分**）。"""
    sub = await _get_json(cl, f"{base}/dashboard/billing/subscription", headers)
    if sub is None:
        return Balance()
    limit = _num(sub.get("hard_limit_usd"))
    if limit is None:
        limit = _num(sub.get("system_hard_limit_usd"))
    if limit is None:
        return Balance()
    today = datetime.now(UTC).date()
    usage = await _get_json(
        cl, f"{base}/dashboard/billing/usage", headers,
        params={"start_date": str(today - timedelta(days=99)),
                "end_date": str(today + timedelta(days=1))},
    )
    cents = _num((usage or {}).get("total_usage"))
    if cents is None:
        # 拿得到额度、拿不到用量 → 仍旧不知道还剩多少。宁可报未知，也不拿总额
        # 冒充余额。
        return Balance()
    used = cents / 100.0
    return Balance(total=limit, used=used, remaining=max(0.0, limit - used),
                   currency="USD", source="dashboard/billing")


async def _probe_newapi_self(cl: httpx.AsyncClient, base: str,
                             headers: dict[str, str]) -> Balance:
    """New-API / one-api 口径：``data.quota`` 是**剩余额度**，``data.used_quota``
    是已用。单位是 token 额度不是美元，换算率各家自己配，所以只报额度。"""
    body = await _get_json(cl, f"{_site_root(base)}/api/user/self", headers)
    data = (body or {}).get("data")
    if not isinstance(data, dict):
        return Balance()
    remaining = _num(data.get("quota"))
    if remaining is None:
        return Balance()
    used = _num(data.get("used_quota"))
    total = remaining + used if used is not None else None
    return Balance(total=total, used=used, remaining=remaining,
                   currency=QUOTA_UNIT, source="api/user/self")


async def _attempt(probe: _Probe, cl: httpx.AsyncClient, base: str,
                   headers: dict[str, str]) -> Balance:
    """跑一个端点，**任何失败都当"这条路不通"**（返回未知），换下一个。

    404/401/连不上/网关把请求重定向到登录页 HTML —— 这些不是异常情况，是探测
    余额的常态。取消要放行，否则用户点了停止还得等探测慢慢试完。
    """
    try:
        return await probe(cl, base, headers)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — 铁律 C5：探测失败不许让任何流程失败
        return Balance()


async def probe_balance(base_url: str, api_key: str, *, timeout: float = 5.0,
                        client: httpx.AsyncClient | None = None) -> Balance:
    """依次试几个常见端点，第一个能解析出数的就返回；全都不行返回 ``Balance()``。

    ``timeout`` 是**整件事**的预算，不只是单个请求的：设置页等着这个结果，不能因为
    网关吊着连接就转上十几秒。``client`` 只是测试接缝（自己造的会在这里关掉）。

    Args:
        base_url: 网关 base（通常以 ``/v1`` 结尾）。
        api_key: 网关密钥。空则直接返回未知 —— 没密钥问了也是白问。
        timeout: 整个探测的秒数上限。
        client: 复用的 HTTP 客户端；不传则自建自关。
    """
    base = (base_url or "").strip().rstrip("/")
    if not base or not api_key:
        return Balance()
    cl = client or httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=min(timeout, 3.0)), follow_redirects=True)
    headers = _auth(api_key)
    try:
        async with asyncio.timeout(timeout):
            for probe in (_probe_openai_billing, _probe_newapi_self):
                b = await _attempt(probe, cl, base, headers)
                if b.known:
                    return b
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — 铁律 C5：探测失败不许让任何流程失败
        return Balance()
    finally:
        if client is None:
            await cl.aclose()
    return Balance()


#: (base_url, api_key) → (探到的时刻, 结果)。**失败也缓存** —— 网关根本没这接口时，
#: 每次打开设置页都白等一遍超时是最没意义的等待。
_CACHE: dict[tuple[str, str], tuple[float, Balance]] = {}


async def cached_balance(base_url: str, api_key: str, *, ttl: float = CACHE_TTL,
                         timeout: float = 5.0) -> Balance:
    """带进程内短缓存的 :func:`probe_balance`。"""
    key = ((base_url or "").strip().rstrip("/"), api_key or "")
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit is not None and now - hit[0] < ttl:
        return hit[1]
    bal = await probe_balance(base_url, api_key, timeout=timeout)
    _CACHE[key] = (now, bal)
    return bal


def invalidate_cache() -> None:
    """网关配置改了就得重新探 —— 换了密钥还显示旧账户的余额是彻头彻尾的误导。"""
    _CACHE.clear()


# ══════════════════════════════════════════════════════════════════
#  文案：S1（网关欠费）/ S2（余额偏低）/ S3（本地上限）
# ══════════════════════════════════════════════════════════════════
def quota_exhausted_text(detail: str = "") -> str:
    """S1 硬信号：网关账户真的没钱了。**这是唯一该提"充值"的地方。**"""
    tip = "网关账户余额不足，梳理没法继续。去网关充值后重跑即可，已经跑完的部分会接着用。"
    detail = (detail or "").strip()
    return f"{tip}网关原文：{detail}" if detail else tip


def quota_low_text(b: Balance) -> str:
    """S2：查得到而且偏低。只提醒，不阻断 —— 用户可能正在充值或另有付费方式。"""
    return f"网关余额只剩 {b.human()}，这次梳理可能跑不完。"


def budget_capped_text(*, spent: float, cap: float, scope: str = "build") -> str:
    """S3：**我们自己设的闸**用满了。

    这段文案里绝不能出现"充值/余额/欠费" —— 网关账户可能一分钱没少，把本地上限
    说成欠费，用户会去给一个没问题的账户交钱（契约第 2 节，铁律 C4）。
    """
    what = "这个会话的对话" if scope == "chat" else "本次梳理"
    return (f"{what}的花费上限 ${cap:.2f} 用满了（已花 ${spent:.2f}）。"
            f"这是你在设置里定的上限，网关账户本身没有问题；要继续就去"
            f"「设置 → 预算」调高，或者新建会话。")


__all__ = ["CACHE_TTL", "LOW_RATIO", "LOW_USD", "QUOTA_UNIT", "Balance",
           "budget_capped_text", "cached_balance", "invalidate_cache", "is_low",
           "probe_balance", "quota_exhausted_text", "quota_low_text"]
