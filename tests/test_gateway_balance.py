"""余额探测（S2）与三类"钱不够"的文案分家 —— 契约 C 第 4 节。

这个文件盯的是两件事，两件都是"说错话比不说话更贵"：

  1. **铁律 C1：查不到 ≠ 没钱。** OpenAI 兼容网关大多根本没有余额接口，探测
     404/401/超时/被路由到登录页 HTML 是**常态而不是异常**。任何一种查不到都必须
     收敛成"未知"；一旦渲染成"余额不足"，用户会跑去给一个一分钱没欠的账户充值。
  2. **铁律 C4：本地 usd_cap 用满不是欠费。** S3 的文案里出现"充值/余额"，用户同样
     会去充值 —— 而真正该做的只是去设置里把上限调高。所以这里逐字断言禁用词。

外加 **C5**：探测失败不许让任何流程失败。设置页要照常返回、开跑前的提醒要照常闭嘴。
"""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from ontocopilot import appconfig, server
from ontocopilot.kernel import gateway_balance as gb
from ontocopilot.kernel.gateway_balance import (
    Balance,
    budget_capped_text,
    cached_balance,
    invalidate_cache,
    is_low,
    probe_balance,
    quota_exhausted_text,
    quota_low_text,
)
from ontocopilot.server import app
from ontocopilot.store.deps import set_repo_for_tests
from ontocopilot.store.repo import MemoryRepo

BASE = "http://gw.test/v1"
KEY = "sk-test-key"

#: 网关把未认证请求 302 到登录页时拿到的东西：200 + 一整页 HTML。状态码是好的，
#: 内容却完全不是 JSON —— 只看 status_code 的实现会在这里当场炸掉。
LOGIN_HTML = "<!doctype html><html><body>please sign in</body></html>"


@pytest.fixture(autouse=True)
def _clean_cache():
    """缓存是模块级的，测试之间会互相串味（尤其是"失败也缓存"那条）。"""
    invalidate_cache()
    yield
    invalidate_cache()


class _Gateway:
    """一个假网关：按 URL 后缀回响应，并记下自己被打了哪些路径。

    路径是要断言的 —— New-API 的用户接口挂在**站点根**而不是 ``/v1`` 下面，
    照着 base 直接拼会稳定 404，而"稳定 404"恰好和"这家网关没有这接口"长得
    一模一样，不断言路径就永远发现不了。
    """

    def __init__(self, routes: dict[str, httpx.Response | Exception]) -> None:
        self.routes = routes
        self.seen: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.seen.append(path)
        for suffix, out in self.routes.items():
            if path.endswith(suffix):
                if isinstance(out, Exception):
                    raise out
                return out
        return httpx.Response(404, text="not found")


def _json(payload: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


async def _probe(gw: _Gateway, *, base: str = BASE, key: str = KEY,
                 timeout: float = 5.0) -> Balance:
    async with httpx.AsyncClient(transport=httpx.MockTransport(gw)) as cl:
        return await probe_balance(base, key, timeout=timeout, client=cl)


# ══════════════════════════════════════════════════════════════════
#  C1：默认就是"未知"
# ══════════════════════════════════════════════════════════════════
def test_empty_balance_is_unknown_not_zero():
    b = Balance()
    assert b.known is False
    assert b.to_dict() == {"known": False}       # 前端只需要看这一个字段
    assert b.human() == "未知"
    assert "0" not in b.human(), "把未知显示成 0 等于说'没钱了'"


def test_total_without_used_is_still_unknown():
    """知道总额、不知道花了多少 = 不知道还剩多少。别拿总额冒充余额。"""
    assert Balance(total=100.0).known is False
    assert Balance(total=100.0, used=None).to_dict() == {"known": False}


def test_is_low_is_false_for_unknown():
    """铁律 C1 的正面表达：未知**永远**不触发"余额偏低"提醒。"""
    assert is_low(Balance()) is False
    assert is_low(Balance(total=1000.0)) is False


def test_is_low_thresholds():
    assert is_low(Balance(remaining=1.5, currency="USD")) is True
    assert is_low(Balance(remaining=42.0, currency="USD")) is False
    # 额度口径换算率各家自己配，只能看比例
    assert is_low(Balance(total=1_000_000, remaining=50_000, currency="quota")) is True
    assert is_low(Balance(total=1_000_000, remaining=500_000, currency="quota")) is False


# ══════════════════════════════════════════════════════════════════
#  C1 + C5：查不到的每一种姿势都收敛成"未知"，而且不抛
# ══════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    ("name", "response"),
    [
        # 网关根本没有这个接口 —— 最常见的一种
        ("404", httpx.Response(404, text="not found")),
        # 余额接口要的是控制台令牌，API key 认不过
        ("401", httpx.Response(401, json={"error": "unauthorized"})),
        ("403", httpx.Response(403, text="forbidden")),
        # 网关把请求路由到了登录页：200 但根本不是 JSON
        ("html-200", httpx.Response(200, text=LOGIN_HTML,
                                    headers={"content-type": "text/html"})),
        # 200 + 合法 JSON，但没有我们要的任何字段
        ("json-no-fields", _json({"object": "billing_subscription"})),
        ("json-null-fields", _json({"hard_limit_usd": None, "data": {"quota": None}})),
        # 字段在，但是字符串 —— 拿它做减法会 TypeError
        ("json-string-fields", _json({"hard_limit_usd": "20.00"})),
        # JSON 顶层不是对象
        ("json-list", _json([1, 2, 3])),
        ("json-empty", _json({})),
        # 网关自己 5xx
        ("500", httpx.Response(500, text="internal error")),
        # 连不上 / 读超时 / TLS 崩了
        ("timeout", httpx.ReadTimeout("timed out")),
        ("connect-error", httpx.ConnectError("connection refused")),
        ("protocol-error", httpx.RemoteProtocolError("server disconnected")),
    ],
)
async def test_every_failure_shape_is_unknown(name, response):
    """所有端点都这么回 → 结果必须是"未知"，而且 probe 本身不许抛。"""
    bal = await _probe(_Gateway({"": response}))
    assert bal.known is False, f"{name} 被当成了查得到的余额"
    assert bal.to_dict() == {"known": False}
    assert is_low(bal) is False, f"{name} 触发了'余额偏低'提醒 —— 这就是 C1 说的伤害"


async def test_missing_credentials_never_touch_the_network():
    """没配网关就别去问。空 base / 空 key 连一个请求都不该发出去。"""
    for base, key in ((BASE, ""), ("", KEY), ("", "")):
        gw = _Gateway({"": _json({"hard_limit_usd": 20.0})})
        assert (await _probe(gw, base=base, key=key)).known is False
        assert gw.seen == []


async def test_whole_probe_is_time_boxed():
    """``timeout`` 是整件事的预算：网关吊着连接时，设置页不能跟着转圈。"""
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return _json({"hard_limit_usd": 20.0})

    t0 = time.monotonic()
    async with httpx.AsyncClient(transport=httpx.MockTransport(hang)) as cl:
        bal = await probe_balance(BASE, KEY, timeout=0.2, client=cl)
    elapsed = time.monotonic() - t0

    assert bal.known is False, "超时同样是'未知'，不是'没钱'"
    assert elapsed < 5.0, f"整段探测没有被 timeout 兜住，等了 {elapsed:.1f}s"


async def test_cancellation_is_not_swallowed():
    """用户点停止时探测要放行 —— 否则还得陪着把几个端点慢慢试完。"""
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(10)
        return _json({})

    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as cl:
        task = asyncio.create_task(probe_balance(BASE, KEY, timeout=30, client=cl))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


# ══════════════════════════════════════════════════════════════════
#  探到了：两种口径
# ══════════════════════════════════════════════════════════════════
async def test_openai_billing_computes_remaining_in_usd():
    """``total_usage`` 是**美分**，忘了除 100 会把 $2.5 报成 $250 花掉。"""
    gw = _Gateway({
        "/dashboard/billing/subscription": _json({"hard_limit_usd": 20.0}),
        "/dashboard/billing/usage": _json({"total_usage": 250.0}),
    })
    bal = await _probe(gw)

    assert bal.known is True
    assert (bal.total, bal.used, bal.remaining) == (20.0, 2.5, 17.5)
    assert bal.currency == "USD"
    assert bal.human() == "$17.50"
    assert bal.source, "余额得说得清是从哪查来的"
    assert bal.to_dict()["known"] is True


async def test_openai_billing_limit_without_usage_stays_unknown():
    """拿得到额度、拿不到用量 → 仍旧不知道还剩多少。宁可未知也不虚报。"""
    gw = _Gateway({
        "/dashboard/billing/subscription": _json({"hard_limit_usd": 20.0}),
        "/dashboard/billing/usage": httpx.Response(404, text="not found"),
        # New-API 那条也不通，否则会被它接住
        "/api/user/self": httpx.Response(404, text="not found"),
    })
    bal = await _probe(gw)
    assert bal.known is False
    assert bal.to_dict() == {"known": False}


async def test_newapi_quota_is_not_reported_as_dollars():
    """New-API 的 quota 是 **token 额度不是美元**，换算率各家自己配。

    猜一个汇率标上 "$" 比不标更糟：用户会照着这个数决定要不要充值。
    """
    gw = _Gateway({
        "/dashboard/billing/subscription": httpx.Response(404, text="no"),
        "/api/user/self": _json({"data": {"quota": 500_000, "used_quota": 100_000}}),
    })
    bal = await _probe(gw)

    assert bal.known is True
    assert bal.remaining == 500_000
    assert bal.currency != "USD"
    assert "$" not in bal.human(), "把 token 额度标成美元是在骗用户"
    assert "$" not in bal.to_dict()["text"]


async def test_newapi_endpoint_hangs_off_site_root_not_v1():
    """``/v1/api/user/self`` 会稳定 404，而 404 和"这家没这接口"长得一模一样。"""
    gw = _Gateway({"/api/user/self": _json({"data": {"quota": 42}})})
    bal = await _probe(gw)

    assert bal.known is True
    assert "/api/user/self" in gw.seen
    assert "/v1/api/user/self" not in gw.seen


async def test_first_endpoint_that_answers_wins():
    """第一个能解析出数的就返回，不该再去打后面的端点。"""
    gw = _Gateway({
        "/dashboard/billing/subscription": _json({"hard_limit_usd": 10.0}),
        "/dashboard/billing/usage": _json({"total_usage": 100.0}),
        "/api/user/self": _json({"data": {"quota": 999}}),
    })
    bal = await _probe(gw)

    assert bal.remaining == 9.0
    assert not any(p.endswith("/api/user/self") for p in gw.seen)


# ══════════════════════════════════════════════════════════════════
#  缓存：连点设置页不该把网关打一遍
# ══════════════════════════════════════════════════════════════════
class _Counter:
    """替掉 probe_balance，只数被叫了几次。"""

    def __init__(self, result: Balance) -> None:
        self.result = result
        self.calls = 0

    async def __call__(self, base_url: str, api_key: str, **kw) -> Balance:
        self.calls += 1
        return self.result


async def test_cache_reuses_within_ttl(monkeypatch):
    probe = _Counter(Balance(total=20.0, used=1.0, remaining=19.0, source="t"))
    monkeypatch.setattr(gb, "probe_balance", probe)

    for _ in range(5):
        assert (await cached_balance(BASE, KEY)).remaining == 19.0
    assert probe.calls == 1


async def test_cache_also_remembers_failures(monkeypatch):
    """网关根本没这接口时，每次打开设置页都白等一遍超时是最没意义的等待。"""
    probe = _Counter(Balance())
    monkeypatch.setattr(gb, "probe_balance", probe)

    assert (await cached_balance(BASE, KEY)).known is False
    assert (await cached_balance(BASE, KEY)).known is False
    assert probe.calls == 1


async def test_cache_keyed_by_credentials(monkeypatch):
    probe = _Counter(Balance(remaining=1.0))
    monkeypatch.setattr(gb, "probe_balance", probe)

    await cached_balance(BASE, KEY)
    await cached_balance(BASE, "sk-another-account")
    assert probe.calls == 2, "换了账户还拿上一个账户的余额是彻头彻尾的误导"


async def test_invalidate_cache_forces_reprobe(monkeypatch):
    probe = _Counter(Balance(remaining=1.0))
    monkeypatch.setattr(gb, "probe_balance", probe)

    await cached_balance(BASE, KEY)
    invalidate_cache()
    await cached_balance(BASE, KEY)
    assert probe.calls == 2


async def test_cache_expires(monkeypatch):
    probe = _Counter(Balance(remaining=1.0))
    monkeypatch.setattr(gb, "probe_balance", probe)

    await cached_balance(BASE, KEY, ttl=0.0)
    await cached_balance(BASE, KEY, ttl=0.0)
    assert probe.calls == 2


# ══════════════════════════════════════════════════════════════════
#  C4：三份文案必须分得开
# ══════════════════════════════════════════════════════════════════
#: S3 文案的禁用词。命中任何一个，用户就会去给一个一分钱没欠的账户交钱。
FORBIDDEN_IN_CAP_TEXT = ("充值", "余额", "欠费", "余额不足", "top up", "top-up")


@pytest.mark.parametrize("scope", ["build", "chat"])
def test_budget_capped_text_never_says_topup(scope):
    """铁律 C4 —— 本地上限用满是**我们自己设的闸**，网关账户可能一分钱没少。"""
    text = budget_capped_text(spent=15.2, cap=15.0, scope=scope)
    low = text.lower()
    for word in FORBIDDEN_IN_CAP_TEXT:
        assert word.lower() not in low, f"S3 文案里出现了「{word}」—— 用户会跑去充值"
    assert "上限" in text
    assert "设置" in text, "得告诉用户闸在哪儿、怎么松"
    assert "15.0" in text or "15.00" in text


def test_budget_capped_text_distinguishes_chat_from_build():
    """对话上限和梳理上限是两个不同的闸，说错了用户会去调错的那个。"""
    assert budget_capped_text(spent=1.0, cap=1.0, scope="chat") != \
        budget_capped_text(spent=1.0, cap=1.0, scope="build")


def test_quota_exhausted_text_is_the_only_one_that_says_topup():
    """S1 是唯一确凿知道"网关账户真的没钱"的信号，也只有它该提充值。"""
    text = quota_exhausted_text("insufficient_user_quota")
    assert "充值" in text
    assert "insufficient_user_quota" in text, "网关原文是用户查账的唯一线索"
    assert quota_exhausted_text("").strip(), "没有原文也得说人话，不能只剩空字符串"


def test_quota_low_text_carries_the_number():
    """S2 提醒的全部价值就是那个数 —— 没有数就只是句吓人的话。"""
    text = quota_low_text(Balance(total=20.0, used=18.0, remaining=2.0))
    assert "$2.00" in text
    assert "余额" in text                 # S2 谈的确实是网关余额，不受 C4 约束


def test_three_texts_are_mutually_distinct():
    """三条路径三份文案。任意两条撞车，前端就分不出该显示哪种颜色/该做什么。"""
    texts = {quota_exhausted_text("x"),
             quota_low_text(Balance(total=10.0, used=9.0, remaining=1.0)),
             budget_capped_text(spent=15.0, cap=15.0)}
    assert len(texts) == 3


# ══════════════════════════════════════════════════════════════════
#  C5：探测失败不许让任何流程失败
# ══════════════════════════════════════════════════════════════════
class _FakeSession:
    """只提供 ``emit`` 的鸭子会话 —— ``_warn_low_balance`` 用不到别的东西。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def emit(self, kind: str, /, **payload):
        self.events.append((kind, payload))
        return {"kind": kind, **payload}


@pytest.fixture
def gateway_configured(monkeypatch):
    appconfig._CACHE = {}
    monkeypatch.setenv("CUSTOM_LLM_BASE_URL", BASE)
    monkeypatch.setenv("CUSTOM_LLM_API_KEY", KEY)
    yield
    appconfig._CACHE = {}


async def test_build_start_is_silent_when_balance_unknown(gateway_configured, monkeypatch):
    """铁律 C1 落到用户眼前的那一下：查不到就**什么都不说**。"""
    monkeypatch.setattr(server, "cached_balance", _Counter(Balance()))
    s = _FakeSession()
    await server._warn_low_balance(s)
    assert s.events == []


async def test_build_start_survives_probe_blowing_up(gateway_configured, monkeypatch):
    """铁律 C5：探测炸了也只是"未知"，梳理照跑。"""
    async def boom(*a, **kw):
        raise httpx.ConnectError("gateway unreachable")

    monkeypatch.setattr(server, "cached_balance", boom)
    s = _FakeSession()
    await server._warn_low_balance(s)          # 不许抛
    assert s.events == []


async def test_build_start_survives_unconfigured_gateway(monkeypatch):
    """网关没配好时 ``resolved_llm_config`` 会抛 —— 也不该把梳理带下水。"""
    appconfig._CACHE = {}
    for var in ("CUSTOM_LLM_BASE_URL", "CUSTOM_LLM_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    s = _FakeSession()
    await server._warn_low_balance(s)
    assert s.events == []


async def test_build_start_warns_but_does_not_block(gateway_configured, monkeypatch):
    """查得到且偏低 → 发一条 quota.low，**不阻断**（用户可能正在充值）。"""
    low = Balance(total=20.0, used=18.5, remaining=1.5, source="dashboard/billing")
    monkeypatch.setattr(server, "cached_balance", _Counter(low))
    s = _FakeSession()
    await server._warn_low_balance(s)

    assert [k for k, _ in s.events] == ["quota.low"]
    payload = s.events[0][1]
    assert "$1.50" in payload["message"]
    assert payload["balance"]["known"] is True


async def test_build_start_silent_when_balance_is_healthy(gateway_configured, monkeypatch):
    monkeypatch.setattr(server, "cached_balance",
                        _Counter(Balance(total=200.0, used=1.0, remaining=199.0)))
    s = _FakeSession()
    await server._warn_low_balance(s)
    assert s.events == []


# ── 设置页：/api/config 的 balance 字段 ────────────────────────────
def _client(repo: MemoryRepo) -> httpx.AsyncClient:
    set_repo_for_tests(repo)          # 零账号 → 开放模式，请求自带合成 admin
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_config_survives_probe_failure(gateway_configured, monkeypatch):
    """C5：网关没有余额接口是常态，设置页不许因此 500，也不许说"余额不足"。"""
    async def boom(*a, **kw):
        raise httpx.ReadTimeout("no answer")

    monkeypatch.setattr(gb, "probe_balance", boom)
    async with _client(MemoryRepo()) as c:
        r = await c.get("/api/config")
    assert r.status_code == 200
    assert r.json()["balance"] == {"known": False}


async def test_config_reports_known_balance(gateway_configured, monkeypatch):
    probe = _Counter(Balance(total=20.0, used=2.5, remaining=17.5, source="dashboard/billing"))
    monkeypatch.setattr(gb, "probe_balance", probe)
    async with _client(MemoryRepo()) as c:
        bal = (await c.get("/api/config")).json()["balance"]
        await c.get("/api/config")             # 连点：缓存要挡住第二次
    assert bal["known"] is True and bal["text"] == "$17.50"
    assert probe.calls == 1


async def test_config_put_reprobes_after_credentials_change(gateway_configured, monkeypatch):
    """换了 base/密钥还显示上一个账户的余额是纯误导。"""
    probe = _Counter(Balance(remaining=5.0, total=10.0, used=5.0))
    monkeypatch.setattr(gb, "probe_balance", probe)
    async with _client(MemoryRepo()) as c:
        await c.get("/api/config")
        r = await c.put("/api/config", json={"base_url": "http://other:3010/v1"})
    assert r.status_code == 200
    assert probe.calls == 2


async def test_config_never_probes_at_import_or_startup(gateway_configured, monkeypatch):
    """**不在 lifespan 里查** —— 那会让"网关不通"变成"服务起不来"。"""
    probe = _Counter(Balance(remaining=1.0))
    monkeypatch.setattr(gb, "probe_balance", probe)
    async with _client(MemoryRepo()) as c:
        await c.get("/api/health")             # 与余额无关的路由
        assert probe.calls == 0
        await c.get("/api/config")             # 只有打开设置页才查
        assert probe.calls == 1
