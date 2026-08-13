"""gateway_balance 的 golden —— 「余额不足要能侦查并提醒」这条特性的全部字节。

写 `golden/gateway_balance.json`（新文件，本 track 独占）。重跑两次字节一致。

    .venv/bin/python tools/golden/gateway_balance.py

导这几样，每一样都是 TS 侧手写期望值必错的地方：

  - **`Balance.human()` 的数字格式**。`f"{x:,.2f}"` / `f"{x:,.0f}"` 是 Python 的
    round-half-**even**，JS 的 `toFixed` 是 ties→更大的 n；0.125 一个给 "0.12"
    一个给 "0.13"。加上千分位、`-0.0` 的符号、≥1e21 的指数记号，四处都能分叉，
    而这个串是用户拿来决定「要不要充值」的那个数。
  - **三份文案的逐字节形态**（S1 欠费 / S2 偏低 / S3 本地上限）。契约铁律 C4：
    S3 里出现"充值/余额/欠费"用户就会跑去给一个没欠费的账户交钱。
  - **探测的解析结果 + 真实打过的路径**。路径要钉：New-API 的用户接口挂在站点根，
    照着 `…/v1` 拼会稳定 404，而"稳定 404"和"这家网关没这接口"长得一模一样 ——
    不断言路径永远发现不了。
  - **`looks_like_quota_exhausted` 的判定矩阵**（源在 `kernel/backends.py`）。
    这是 scheduler「一次都不重试」的唯一依据：判宽了把一次限流说成欠费，判窄了
    让用户白等三轮退避再收一句 HTTP 429。两个方向都得钉。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from datetime import UTC, datetime, timedelta
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

import httpx  # noqa: E402

from ontocopilot.kernel.backends import looks_like_quota_exhausted  # noqa: E402
from ontocopilot.kernel.gateway_balance import (  # noqa: E402
    CACHE_TTL,
    LOW_RATIO,
    LOW_USD,
    QUOTA_UNIT,
    Balance,
    _num,
    _site_root,
    budget_capped_text,
    is_low,
    probe_balance,
    quota_exhausted_text,
    quota_low_text,
)

BASE = "http://gw.test/v1"
KEY = "sk-test-key"

#: 网关把未认证请求路由到登录页时拿到的东西：200 + 一整页 HTML。
LOGIN_HTML = "<!doctype html><html><body>please sign in</body></html>"


# ══════════════════════════════════════════════════════════════════
#  数字格式：human() 的两个口径
# ══════════════════════════════════════════════════════════════════
#: 全是"看着无聊、实际分叉"的值。八分之一（.125/.375/.625/.875）是 2 位小数上
#: **精确的**半整数，只有它们能触发 round-half-even；.5 同理触发 0 位小数那条。
_USD_NUMS = [
    0.0, -0.0, 0.005, 0.125, 0.375, 0.625, 0.875, 19.125, 17.5, 1.5, 2.0,
    -0.001, -1.5, -1234.5, 1234.5, 1234567.891, 1000000.0, 999999.995,
    0.1 + 0.2, 1 / 3, 1e15, 1e20, 1e21, 12345678901234567890.0,
]
_QUOTA_NUMS = [
    0.0, -0.0, 0.5, 1.5, 2.5, 3.5, -0.5, -1.5, 499.5, 500000.0, 1000000.0,
    1234.5, 999999.5, 1e15, 1e21, 12345678901234567890.0,
]


def _fmt_rows() -> list[dict[str, Any]]:
    rows = []
    for x in _USD_NUMS:
        rows.append({"remaining": x, "currency": "USD",
                     "out": Balance(remaining=x, currency="USD").human()})
    for x in _QUOTA_NUMS:
        rows.append({"remaining": x, "currency": QUOTA_UNIT,
                     "out": Balance(remaining=x, currency=QUOTA_UNIT).human()})
    # 任何非 "USD" 的币种都走额度分支 —— currency 是相等比较不是"是不是钱"。
    rows.append({"remaining": 12.5, "currency": "CNY",
                 "out": Balance(remaining=12.5, currency="CNY").human()})
    rows.append({"remaining": 12.5, "currency": "usd",   # 大小写敏感
                 "out": Balance(remaining=12.5, currency="usd").human()})
    return rows


#: nan/inf 不能直接躺在 JSON 里（json.dumps 会写出非法的 `NaN`），用字面量标记走。
_SPECIAL = {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf")}


def _special_rows() -> list[dict[str, Any]]:
    return [
        {"lit": lit, "currency": cur,
         "out": Balance(remaining=v, currency=cur).human()}
        for lit, v in _SPECIAL.items()
        for cur in ("USD", QUOTA_UNIT)
    ]


# ══════════════════════════════════════════════════════════════════
#  Balance 本体
# ══════════════════════════════════════════════════════════════════
#: 构造参数直接用 dict，TS 侧照着喂 makeBalance 即可。
_BALANCES: list[dict[str, Any]] = [
    {},
    {"total": 100.0},                                   # 有总额没用量 = 仍旧未知
    {"total": 100.0, "used": None},
    {"used": 3.0},
    {"remaining": 0.0},                                 # 0 是"没钱了"，不是"未知"
    {"remaining": 17.5, "total": 20.0, "used": 2.5, "source": "dashboard/billing"},
    {"remaining": 500000.0, "total": 600000.0, "used": 100000.0,
     "currency": "quota", "source": "api/user/self"},
    {"remaining": -5.0, "total": 10.0, "used": 15.0},   # 网关允许透支
    {"remaining": 1.5, "currency": "USD"},
    {"remaining": 42.0, "currency": "USD"},
    {"remaining": 5.0, "currency": "USD"},              # 恰好等于 LOW_USD（<= 取真）
    {"remaining": 5.000001, "currency": "USD"},
    {"total": 1000000.0, "remaining": 50000.0, "currency": "quota"},
    {"total": 1000000.0, "remaining": 500000.0, "currency": "quota"},
    {"total": 1000000.0, "remaining": 100000.0, "currency": "quota"},  # 恰好 10%
    {"total": 0.0, "remaining": 0.0, "currency": "quota"},   # total 假值 → 不看比例
    {"total": -10.0, "remaining": -1.0, "currency": "quota"},  # total <= 0 同上
    {"total": 1000000.0, "remaining": 50000.0, "currency": "USD"},  # 美元也看比例
]


def _balance_rows() -> list[dict[str, Any]]:
    rows = []
    for kw in _BALANCES:
        b = Balance(**kw)
        rows.append({
            "in": kw,
            "known": b.known,
            "human": b.human(),
            "to_dict": b.to_dict(),
            "is_low": is_low(b),
            # 阈值可调：把默认值以外的那一档也钉住，免得 TS 侧把参数写死
            "is_low_strict": is_low(b, usd_floor=20.0, ratio=0.5),
        })
    return rows


# ══════════════════════════════════════════════════════════════════
#  纯函数：_site_root / _num
# ══════════════════════════════════════════════════════════════════
_BASES = [
    "http://gw.test/v1", "http://gw.test/v1/", "http://gw.test",
    "https://api.openai.com/v1", "http://gw.test/api/v1", "http://gw.test/v1/v1",
    "/v1", "v1", "", "http://gw.test/V1", "http://gw.test/v1x",
    "http://gw.test///v1",
]

#: `_num` 的每一种"看着像数其实不是"。bool 是 int 的子类，不排掉的话
#: `quota: true` 会变成 1.0 —— 用户看到自己还剩 $1.00。
_NUM_INPUTS: list[Any] = [
    1, 0, -3, 1.5, 0.0, -0.0, 1e21, True, False, None, "20.00", "", [1, 2], {},
    {"a": 1}, [],
]


# ══════════════════════════════════════════════════════════════════
#  探测：真跑 probe_balance，钉解析结果 + 打过的路径
# ══════════════════════════════════════════════════════════════════
def _resp(spec: dict[str, Any]) -> httpx.Response:
    """把 golden 里的路由描述还原成响应。TS 侧照同一份描述造假 fetch。"""
    return httpx.Response(
        spec["status"],
        text=spec["body"],
        headers={"content-type": spec.get("content_type", "application/json")},
    )


_RAISERS = {
    "timeout": lambda: httpx.ReadTimeout("timed out"),
    "connect": lambda: httpx.ConnectError("connection refused"),
    "protocol": lambda: httpx.RemoteProtocolError("server disconnected"),
}


class _Gateway:
    """按 URL 后缀回响应，并记下自己被打了哪些路径。"""

    def __init__(self, routes: dict[str, dict[str, Any]]) -> None:
        self.routes = routes
        self.seen: list[str] = []
        self.params: list[dict[str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request.url.path)
        self.params.append(dict(request.url.params))
        for suffix, spec in self.routes.items():
            if request.url.path.endswith(suffix):
                if "raise" in spec:
                    raise _RAISERS[spec["raise"]]()
                return _resp(spec)
        return _resp({"status": 404, "body": "not found", "content_type": "text/plain"})


def _j(payload: object, status: int = 200) -> dict[str, Any]:
    return {"status": status, "body": json.dumps(payload, ensure_ascii=False),
            "content_type": "application/json"}


def _t(text: str, status: int = 200, ct: str = "text/plain") -> dict[str, Any]:
    return {"status": status, "body": text, "content_type": ct}


SUB = "/dashboard/billing/subscription"
USE = "/dashboard/billing/usage"
SELF = "/api/user/self"
DEAD = _t("not found", 404)

#: 每条 = (名字, base, key, 路由表)。名字只是给人看的，断言看 out/seen。
_SCENARIOS: list[tuple[str, str, str, dict[str, dict[str, Any]]]] = [
    # ── 探到了 ────────────────────────────────────────────────────
    ("openai-billing", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 20.0}), USE: _j({"total_usage": 250.0})}),
    ("openai-billing-system-limit", BASE, KEY,
     {SUB: _j({"system_hard_limit_usd": 12.0}), USE: _j({"total_usage": 100.0})}),
    # hard_limit_usd 在但为 null → 退到 system_hard_limit_usd
    ("openai-billing-null-then-system", BASE, KEY,
     {SUB: _j({"hard_limit_usd": None, "system_hard_limit_usd": 8.0}),
      USE: _j({"total_usage": 50.0})}),
    ("openai-billing-zero-usage", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 20.0}), USE: _j({"total_usage": 0})}),
    # 花超了：remaining 夹到 0，**不是负数**（负余额显示出来只会更让人困惑）
    ("openai-billing-overspent", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 10.0}), USE: _j({"total_usage": 2000.0})}),
    ("newapi-self", BASE, KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": 500000, "used_quota": 100000}})}),
    ("newapi-self-no-used", BASE, KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": 42}})}),
    ("newapi-self-negative", BASE, KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": -3000, "used_quota": 103000}})}),
    # base 不带 /v1：站点根就是它自己
    ("newapi-base-without-v1", "http://gw.test", KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": 7}})}),
    ("newapi-base-trailing-slash", "http://gw.test/v1/", KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": 7}})}),
    ("base-with-spaces", "  http://gw.test/v1  ", KEY,
     {SUB: DEAD, SELF: _j({"data": {"quota": 7}})}),
    # 第一个能解析出数的就返回，不该再打后面的端点
    ("first-endpoint-wins", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 10.0}), USE: _j({"total_usage": 100.0}),
      SELF: _j({"data": {"quota": 999}})}),

    # ── 查不到的每一种姿势（铁律 C1：一律"未知"）────────────────────
    ("all-404", BASE, KEY, {}),
    ("401", BASE, KEY, {"": _j({"error": "unauthorized"}, 401)}),
    ("403", BASE, KEY, {"": _t("forbidden", 403)}),
    ("500", BASE, KEY, {"": _t("internal error", 500)}),
    ("login-html-200", BASE, KEY, {"": _t(LOGIN_HTML, 200, "text/html")}),
    ("json-no-fields", BASE, KEY, {"": _j({"object": "billing_subscription"})}),
    ("json-null-fields", BASE, KEY,
     {"": _j({"hard_limit_usd": None, "data": {"quota": None}})}),
    # 字段在但是字符串 —— 拿它做减法会 TypeError
    ("json-string-fields", BASE, KEY, {"": _j({"hard_limit_usd": "20.00"})}),
    ("json-bool-fields", BASE, KEY,
     {"": _j({"hard_limit_usd": True, "data": {"quota": True}})}),
    ("json-list", BASE, KEY, {"": _j([1, 2, 3])}),
    ("json-scalar", BASE, KEY, {"": _j("hello")}),
    ("json-empty-object", BASE, KEY, {"": _j({})}),
    ("json-truncated", BASE, KEY, {"": _t('{"hard_limit_usd": 20.', 200,
                                          "application/json")}),
    ("empty-body-200", BASE, KEY, {"": _t("", 200, "application/json")}),
    # data 在但不是对象
    ("newapi-data-not-object", BASE, KEY, {SUB: DEAD, SELF: _j({"data": [1, 2]})}),
    ("newapi-data-null", BASE, KEY, {SUB: DEAD, SELF: _j({"data": None})}),
    # 拿得到额度、拿不到用量 → 仍旧不知道还剩多少，宁可报未知
    ("limit-without-usage", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 20.0}), USE: DEAD, SELF: DEAD}),
    ("limit-with-string-usage", BASE, KEY,
     {SUB: _j({"hard_limit_usd": 20.0}), USE: _j({"total_usage": "250"}), SELF: DEAD}),
    # 传输层炸了：这些是探测余额的**常态**，不是异常
    ("read-timeout", BASE, KEY, {"": {"raise": "timeout"}}),
    ("connect-error", BASE, KEY, {"": {"raise": "connect"}}),
    ("protocol-error", BASE, KEY, {"": {"raise": "protocol"}}),
    # 第一个端点炸了不该带走第二个
    ("first-blows-up-second-answers", BASE, KEY,
     {SUB: {"raise": "connect"}, USE: {"raise": "connect"},
      SELF: _j({"data": {"quota": 88}})}),

    # ── 没配网关：一个请求都不该发出去 ──────────────────────────────
    ("no-key", BASE, "", {SUB: _j({"hard_limit_usd": 20.0})}),
    ("no-base", "", KEY, {SUB: _j({"hard_limit_usd": 20.0})}),
    ("no-both", "", "", {SUB: _j({"hard_limit_usd": 20.0})}),
    ("blank-base", "   ", KEY, {SUB: _j({"hard_limit_usd": 20.0})}),
]


async def _run_scenarios() -> list[dict[str, Any]]:
    rows = []
    for name, base, key, routes in _SCENARIOS:
        gw = _Gateway(routes)
        async with httpx.AsyncClient(transport=httpx.MockTransport(gw)) as cl:
            bal = await probe_balance(base, key, timeout=5.0, client=cl)
        rows.append({
            "name": name, "base": base, "key": key, "routes": routes,
            "known": bal.known, "out": bal.to_dict(), "human": bal.human(),
            "is_low": is_low(bal), "seen": gw.seen,
            # dataclass 字段本身也钉一下：to_dict 在未知时只吐 {"known": false}
            "fields": {"total": bal.total, "used": bal.used,
                       "remaining": bal.remaining, "currency": bal.currency,
                       "source": bal.source},
        })
    return rows


async def _usage_params() -> dict[str, Any]:
    """usage 端点的查询参数：钉**形状**不钉日期（日期每天都变，钉了明天就红）。"""
    gw = _Gateway({SUB: _j({"hard_limit_usd": 20.0}), USE: _j({"total_usage": 1.0})})
    async with httpx.AsyncClient(transport=httpx.MockTransport(gw)) as cl:
        await probe_balance(BASE, KEY, timeout=5.0, client=cl)
    params = gw.params[1]
    today = datetime.now(UTC).date()
    start = datetime.strptime(params["start_date"], "%Y-%m-%d").date()
    end = datetime.strptime(params["end_date"], "%Y-%m-%d").date()
    return {
        "keys": sorted(params),
        "start_days_before_today": (today - start).days,
        "end_days_after_today": (end - today).days,
        "span_days": (end - start).days,
        "format": "%Y-%m-%d",
    }


# ══════════════════════════════════════════════════════════════════
#  文案：S1 / S2 / S3
# ══════════════════════════════════════════════════════════════════
_DETAILS = [
    "insufficient_user_quota",
    "",
    "   ",
    "  当前分组上游负载已饱和  ",
    '{"error":{"type":"insufficient_quota"}}',
    "\n余额不足\n",
]

_CAPS: list[tuple[float, float, str]] = [
    (15.2, 15.0, "build"),
    (15.2, 15.0, "chat"),
    (1.0, 1.0, "build"),
    (0.125, 0.125, "build"),      # round-half-even 的那个坑，文案里同样有
    (0.005, 2.675, "build"),
    (1234.5, 1000.0, "build"),
    (0.0, 0.0, "unknown-scope"),  # 未知 scope 落到 "本次梳理"
    (-0.0, 20.0, "chat"),
]

#: 判宽/判窄两个方向都要有。前半段是真欠费，后半段是**长得像但不是**。
_QUOTA_CASES: list[tuple[int, str]] = [
    # 真欠费
    (402, ""),
    (402, "Payment Required"),
    (402, "随便什么 body 都不看"),
    (429, "insufficient_quota"),
    (429, "INSUFFICIENT_QUOTA"),
    (429, "insufficient_user_quota"),
    (429, "exceeded_current_quota"),
    (429, "quota_exceeded"),
    (429, "billing_hard_limit_reached"),
    (429, "Your credit balance is too low to access the API"),
    (429, "CREDIT balance"),
    (429, "网关余额不足"),
    (429, "额度已用尽"),
    (429, "账户欠费，请充值"),
    # 真实网关（New-API 系）的欠费 429：message 写得跟限流一模一样，
    # 只有 type / code 说了实话 —— 所以整个 body 都要扫，不能只扫 message
    (429, '{"error":{"message":"当前分组上游负载已饱和，请稍后再试",'
          '"type":"insufficient_quota","code":"insufficient_user_quota"}}'),
    # 不是欠费（判宽了就会在这些上面误报）
    (429, ""),
    (429, "Rate limit reached for gpt-4 in organization org-x. Limit: 200000 TPM"),
    (429, "Too Many Requests"),
    (429, "请求过于频繁，请稍后重试"),
    (429, "requests per minute"),
    (429, "上游负载已饱和"),
    (500, "insufficient_quota"),
    (503, "余额不足"),
    (200, "insufficient_quota"),
    (401, "insufficient_quota"),
    (400, "quota_exceeded"),
    (404, "欠费"),
    (0, ""),
    (0, "insufficient_quota"),
    (408, "额度"),
    (529, "credit"),
    # 已知的过宽边缘：子串匹配，"accredited" 里也有 "credit"。
    # 钉住形状而不是假装它不存在 —— 改判据要连这条一起改。
    (429, "This endpoint is only for accredited partners"),
]


def main() -> None:
    out: dict[str, Any] = {
        "consts": {"QUOTA_UNIT": QUOTA_UNIT, "LOW_USD": LOW_USD,
                   "LOW_RATIO": LOW_RATIO, "CACHE_TTL": CACHE_TTL},
        "human": _fmt_rows(),
        "human_special": _special_rows(),
        "balances": _balance_rows(),
        "site_root": [{"in": s, "out": _site_root(s)} for s in _BASES],
        "num": [{"in": v, "out": _num(v)} for v in _NUM_INPUTS],
        "probe": asyncio.run(_run_scenarios()),
        "usage_params": asyncio.run(_usage_params()),
        "quota_exhausted_text": [{"detail": d, "out": quota_exhausted_text(d)}
                                 for d in _DETAILS],
        "quota_low_text": [{"in": kw, "out": quota_low_text(Balance(**kw))}
                           for kw in _BALANCES],
        "budget_capped_text": [
            {"spent": s, "cap": c, "scope": sc,
             "out": budget_capped_text(spent=s, cap=c, scope=sc)}
            for s, c, sc in _CAPS
        ],
        "looks_like_quota_exhausted": [
            {"status": st, "body": b, "out": looks_like_quota_exhausted(st, b)}
            for st, b in _QUOTA_CASES
        ],
    }

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "gateway_balance.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}  {dst.stat().st_size} B")


if __name__ == "__main__":
    main()
