"""网关欠费的硬信号（S1）—— 判据、不重试、不误伤真限流。

这个文件盯的是三件互相拉扯的事：

  1. **429 是欠费与限流共用的状态码。** 判宽了，一次真限流会被说成"余额不足"，
     用户跑去给一个根本没欠费的账户充值；判窄了，欠费又退回"白等三轮退避、
     最后收到一句 HTTP 429"。
  2. 判成欠费就**一次都不许再打**：退避多少轮账户也不会自己有钱，那几十秒纯粹
     是烧用户的时间。所以断言的是"后端只被调用一次"，不是"抛了异常"。
  3. QuotaExhausted 是 ModelError 的子类，**必须能一路冒到服务端**，不能在网关
     的重试层里被当成普通模型故障又转一圈。
"""

from __future__ import annotations

import httpx
import pytest

from ontocopilot.kernel.backends import (
    AnthropicBackend,
    OpenAICompatBackend,
    looks_like_quota_exhausted,
)
from ontocopilot.kernel.budget import Budget
from ontocopilot.kernel.dag import Difficulty
from ontocopilot.kernel.journal import FileBlobStore, FileJournal
from ontocopilot.kernel.llm import (
    LLMBackend,
    ModelError,
    ModelGateway,
    ModelSpec,
    QuotaExhausted,
    RoutingTable,
    Usage,
)
from ontocopilot.kernel.recorder import Recorder

SPEC = ModelSpec("test-model", "mid", 3.0, 15.0, effort="medium")

#: 真实网关（New-API 系）余额耗尽时的原样响应。**message 写得跟限流一模一样**，
#: 只有 type / code 说了实话 —— 判据只看 message 就会漏判这一条。
QUOTA_429 = (
    '{"error":{"message":"当前分组上游负载已饱和，请稍后再试",'
    '"type":"insufficient_quota","code":"insufficient_user_quota"}}'
)

#: 真限流。措辞与上面那条同样"稍后再试"，但没有任何配额信号 —— 这条必须照常重试。
RATE_429 = (
    '{"error":{"message":"Rate limit reached for this model, please slow down",'
    '"type":"rate_limit_error","code":"rate_limit_exceeded"}}'
)

OK_BODY = (
    '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":10,"completion_tokens":5}}'
)


class _Gateway:
    """一个假网关：按脚本回响应，并数自己被打了几次。

    次数是本文件最要紧的断言 —— "抛了 QuotaExhausted"和"抛之前先白打了四次"
    在用户那里是完全不同的两件事。
    """

    def __init__(self, *script: tuple[int, str]) -> None:
        self.script = list(script)
        self.hits = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        status, body = self.script[min(self.hits, len(self.script) - 1)]
        self.hits += 1
        return httpx.Response(status, text=body,
                              headers={"content-type": "application/json"})


@pytest.fixture
def backoffs(monkeypatch):
    """把退避换成计数器：既不真睡，又能直接断言"这次一秒都没白等"。"""
    seen: list[int] = []

    async def fake(attempt: int, retry_after: str | None = None) -> None:
        seen.append(attempt)

    monkeypatch.setattr(OpenAICompatBackend, "_backoff", staticmethod(fake))
    return seen


async def _backend(gw: _Gateway, *, max_retries: int = 3) -> OpenAICompatBackend:
    b = OpenAICompatBackend("http://gw.test/v1", "sk-test", max_retries=max_retries)
    await b._client.aclose()  # 真 client 用不上，别留一个没人关的连接池
    b._client = httpx.AsyncClient(transport=httpx.MockTransport(gw))
    return b


async def _call(b: OpenAICompatBackend) -> tuple[str, Usage]:
    return await b.generate(model=SPEC, prompt="hi", max_tokens=100)


# ══════════════════════════════════════════════════════════════════
#  判据本身（纯函数）
# ══════════════════════════════════════════════════════════════════
@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        # 402 语义就是欠费，body 一概不看
        (402, "", True),
        (402, "whatever", True),
        # 429：只有带配额信号的才算欠费
        (429, QUOTA_429, True),
        (429, '{"error":{"code":"INSUFFICIENT_QUOTA"}}', True),   # 大小写不敏感
        (429, '{"error":{"message":"账户余额不足，请充值"}}', True),
        (429, '{"error":{"message":"额度已用完"}}', True),
        (429, '{"error":{"message":"credit balance is too low"}}', True),
        # C3：真限流不许被判成欠费
        (429, RATE_429, False),
        (429, "", False),
        (429, '{"error":{"message":"Too many requests"}}', False),
        # 别的状态码一律不判：body 里出现"额度"不代表这次 500 是欠费
        (500, QUOTA_429, False),
        (503, '{"error":{"message":"余额"}}', False),
        (200, QUOTA_429, False),
    ],
)
def test_quota_judgement(status, body, expected):
    assert looks_like_quota_exhausted(status, body) is expected


def test_judgement_reads_type_and_code_not_just_message():
    """真实欠费响应的 message 长得像限流 —— 判据必须看到 type/code 才算数。"""
    import json

    payload = json.loads(QUOTA_429)["error"]
    assert "quota" not in payload["message"]              # message 帮不上忙
    assert looks_like_quota_exhausted(429, json.dumps({"error": {
        "message": payload["message"]}}, ensure_ascii=False)) is False
    assert looks_like_quota_exhausted(429, QUOTA_429) is True


# ══════════════════════════════════════════════════════════════════
#  C2：判成欠费 → 一次都不重试
# ══════════════════════════════════════════════════════════════════
async def test_402_raises_quota_exhausted_without_retrying(backoffs):
    gw = _Gateway((402, '{"error":{"message":"Payment Required"}}'))
    b = await _backend(gw)

    with pytest.raises(QuotaExhausted) as exc:
        await _call(b)

    assert gw.hits == 1, "余额不足还退避重试，纯粹是让用户白等"
    assert backoffs == []
    assert exc.value.status == 402


async def test_429_with_quota_body_raises_without_retrying(backoffs):
    gw = _Gateway((429, QUOTA_429))
    b = await _backend(gw)

    with pytest.raises(QuotaExhausted) as exc:
        await _call(b)

    assert gw.hits == 1
    assert backoffs == []
    assert exc.value.status == 429
    # 网关原文要带出去：只有它能告诉人"是哪个账户、哪一条限制"
    assert "insufficient_user_quota" in exc.value.detail
    assert "test-model" in str(exc.value)


async def test_detail_is_truncated():
    """网关偶尔回一整页 HTML，detail 是要显示给人看的，不能整页糊上去。"""
    gw = _Gateway((402, "x" * 1000))
    b = await _backend(gw)

    with pytest.raises(QuotaExhausted) as exc:
        await _call(b)
    assert len(exc.value.detail) == 300


# ══════════════════════════════════════════════════════════════════
#  C3：真限流照常退避重试（只加不减）
# ══════════════════════════════════════════════════════════════════
async def test_rate_limit_429_still_retries_and_recovers(backoffs):
    gw = _Gateway((429, RATE_429), (200, OK_BODY))
    b = await _backend(gw)

    text, usage = await _call(b)

    assert text == "ok"
    assert gw.hits == 2, "限流是瞬时故障，退一步再来就好 —— 这条能力不许丢"
    assert backoffs == [0]
    assert usage.tok_in == 10


async def test_rate_limit_429_exhausts_retries_as_before(backoffs):
    """一直限流仍然按老路走完重试并报普通失败，**不是**报余额不足。"""
    gw = _Gateway((429, RATE_429))
    b = await _backend(gw, max_retries=2)

    with pytest.raises(ModelError) as exc:
        await _call(b)

    assert not isinstance(exc.value, QuotaExhausted)
    assert gw.hits == 3            # 首次 + 2 次重试
    assert backoffs == [0, 1, 2]
    assert "余额" not in str(exc.value)


async def test_other_4xx_untouched():
    """非 402/429 的 4xx 还是原样抛，不许被新判据顺手改了类型。"""
    gw = _Gateway((401, '{"error":{"message":"invalid api key"}}'))
    b = await _backend(gw)

    with pytest.raises(ModelError) as exc:
        await _call(b)
    assert not isinstance(exc.value, QuotaExhausted)
    assert "401" in str(exc.value)


# ══════════════════════════════════════════════════════════════════
#  3.3：网关层不许把它当普通 ModelError 再重试一遍
# ══════════════════════════════════════════════════════════════════
class _QuotaBackend(LLMBackend):
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, *, model, prompt, system="", schema=None,
                       max_tokens=16_000, cache_system=True, images=None):
        self.calls += 1
        raise QuotaExhausted(model.name, QUOTA_429, status=429)


async def test_gateway_does_not_retry_quota_exhausted(tmp_path):
    backend = _QuotaBackend()
    rec = Recorder("r-quota", FileJournal(tmp_path / "j"), FileBlobStore(tmp_path / "b"))
    gw = ModelGateway(backend, rec,
                      routing=RoutingTable(models=dict.fromkeys(Difficulty, SPEC),
                                           judges=[SPEC]),
                      budget=Budget(), max_schema_retries=2)

    with pytest.raises(QuotaExhausted) as exc:
        # 带 schema 走的是"输出不合规就重发"那条路径 —— 欠费绝不能掉进去
        await gw.call("n1", "hi", schema={"type": "object", "properties": {}})

    assert backend.calls == 1, "网关又替用户重试了三遍欠费，账户还是没钱"
    assert exc.value.status == 429


# ══════════════════════════════════════════════════════════════════
#  Anthropic 直连：SDK 异常里的欠费信号也要分流出来
# ══════════════════════════════════════════════════════════════════
class _SDKError(Exception):
    """仿 anthropic.APIStatusError 的形状（status_code + 已解析的 body）。"""

    def __init__(self, status: int, body: object) -> None:
        super().__init__(f"HTTP {status}")
        self.status_code = status
        self.body = body


class _FakeMessages:
    def __init__(self, exc: Exception) -> None:
        self.exc = exc
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        raise self.exc


class _FakeClient:
    def __init__(self, exc: Exception) -> None:
        self.messages = _FakeMessages(exc)


async def test_anthropic_402_becomes_quota_exhausted():
    client = _FakeClient(_SDKError(402, {"error": {"message": "credit balance too low"}}))
    b = AnthropicBackend(client=client, server_fallback=False)

    with pytest.raises(QuotaExhausted) as exc:
        await b.generate(model=SPEC, prompt="hi", max_tokens=100)

    assert exc.value.status == 402
    assert client.messages.calls == 1


async def test_anthropic_other_errors_pass_through():
    """C5 的同款纪律：分流只认欠费，别的错误必须原样冒上去、别被改了形状。"""
    boom = _SDKError(500, {"error": {"message": "internal"}})
    b = AnthropicBackend(client=_FakeClient(boom), server_fallback=False)

    with pytest.raises(_SDKError) as exc:
        await b.generate(model=SPEC, prompt="hi", max_tokens=100)
    assert exc.value is boom


# ══════════════════════════════════════════════════════════════════
#  调度器：欠费不重试
# ══════════════════════════════════════════════════════════════════
async def test_the_scheduler_does_not_rerun_a_node_that_ran_out_of_credit():
    """欠费不是"这次不巧"。

    调度器原来把它交给 `except Exception` 按 NodeSpec.retries 重跑整个节点。
    代价不是几秒退避 —— EXTRACT 是按 segment 扇出的贵活（retries=1），每个分片
    都要再白跑一整次节点执行，用户为一个必然失败的结果多等好几分钟。
    """
    from ontocopilot.kernel.budget import Budget
    from ontocopilot.kernel.bus.bus import AgentBus
    from ontocopilot.kernel.dag import Dag, NodeMode, NodeSpec
    from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
    from ontocopilot.kernel.llm import QuotaExhausted
    from ontocopilot.kernel.loop import NodeHandler
    from ontocopilot.kernel.recorder import Recorder
    from ontocopilot.kernel.scheduler import RunStatus, Scheduler

    calls = {"n": 0}

    class _Broke(NodeHandler):
        async def execute(self, inputs, ctx):
            calls["n"] += 1
            raise QuotaExhausted("gw-model", "insufficient_user_quota", status=429)

    class _Loop:
        async def run(self, spec, *, working, deps, run_id):
            return await _Broke().execute({}, None)

    rec = Recorder("r1", InMemoryJournal(), InMemoryBlobStore())
    dag = Dag("t").add(NodeSpec("A", NodeMode.DETERMINISTIC, "x", retries=3)).freeze()
    sched = Scheduler(dag, _Loop(), rec, AgentBus(rec), Budget())

    out = await sched.run("r1")
    assert out.status is RunStatus.FAILED
    assert calls["n"] == 1, f"欠费还重跑了 {calls['n']} 次（retries=3）"
    assert "QuotaExhausted" in out.error, "错误里认不出是欠费，上层没法说人话"


async def test_a_normal_failure_still_uses_its_retries():
    """对照组：普通失败照常重试。上一条不能靠"把重试关掉"来通过。"""
    from ontocopilot.kernel.budget import Budget
    from ontocopilot.kernel.bus.bus import AgentBus
    from ontocopilot.kernel.dag import Dag, NodeMode, NodeSpec
    from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal
    from ontocopilot.kernel.recorder import Recorder
    from ontocopilot.kernel.scheduler import RunStatus, Scheduler

    calls = {"n": 0}

    class _Loop:
        async def run(self, spec, *, working, deps, run_id):
            calls["n"] += 1
            raise RuntimeError("上游 502")

    rec = Recorder("r2", InMemoryJournal(), InMemoryBlobStore())
    dag = Dag("t").add(NodeSpec("A", NodeMode.DETERMINISTIC, "x", retries=3)).freeze()
    out = await Scheduler(dag, _Loop(), rec, AgentBus(rec), Budget()).run("r2")

    assert out.status is RunStatus.FAILED
    assert calls["n"] == 4, "普通失败的重试被顺手关掉了"


async def test_the_real_exception_stays_reachable_through_the_chain():
    """NodeFailure 要挂着真异常 —— 上层判"是不是欠费"优先走类型而不是文本。"""
    from ontocopilot.kernel.errors import NodeFailure
    from ontocopilot.kernel.llm import QuotaExhausted

    original = QuotaExhausted("m", "insufficient_quota", status=402)
    try:
        try:
            raise original
        except QuotaExhausted as exc:
            raise NodeFailure("A", f"{type(exc).__name__}: {exc}",
                              retryable=False) from exc
    except NodeFailure as wrapped:
        assert wrapped.__cause__ is original
