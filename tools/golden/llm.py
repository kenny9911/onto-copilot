"""kernel/llm.py + kernel/backends.py 的 golden —— 「一次调用花了多少钱」的全部字节。

写 `golden/llm.json`（新文件，本 track 独占）。重跑两次字节一致。

    .venv/bin/python tools/golden/llm.py

导这几样，每一样都是 TS 侧手写期望值必错的地方：

  - **用量记账的逐字段结果**。tok_in / tok_out / cache_read / cache_write / usd
    直接进 llm_usage 账本和用户看到的费用。少记一类 token 就是账目静默错误，而
    「重试三回只记最后一次」「重放再记一笔」这两种错法都不报错、只是数字不对。
    所以这里把**账本行 + BUDGET_SPENT 事件 payload + Budget 水位**三样一起导。
  - **`_parse_json` 的分支矩阵**。围栏优先级那一条是真实事故（回答里含一段
    ```json 范例会把外层结构顶掉）；CPython 与 V8 的 JSON 报错文案完全不同，
    所以这里额外导一个 `truncated` 布尔 —— 两侧字符串不同，但**分类必须一致**，
    否则 TS 侧的预算升级会静默失效。
  - **`_validate` 的报错文案**。这些字符串会原样喂回给模型（重试提示词里），
    也就是说它们是**请求字节的一部分**。
  - **路由表**。哪个模型配哪个 effort 是厂商事实：Flash 传了 effort 直接 400。
  - **`looks_like_quota_exhausted` 的判定矩阵**。scheduler「一次都不重试」的唯一
    依据，两个方向都得钉。
  - **`strictify`**：strict 模式要求 required 列全属性且 additionalProperties=False，
    `sorted(props)` 是按 code point 排的（JS 默认 sort 按 UTF-16 code unit）。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.backends import (  # noqa: E402
    RETRYABLE_STATUS,
    STREAM_THRESHOLD,
    AnthropicBackend,
    OpenAICompatBackend,
    looks_like_quota_exhausted,
    strictify,
)
from ontocopilot.kernel.budget import Budget  # noqa: E402
from ontocopilot.kernel.catalog import ModelCatalog  # noqa: E402
from ontocopilot.kernel.dag import Difficulty  # noqa: E402
from ontocopilot.kernel.events import EventKind  # noqa: E402
from ontocopilot.kernel.journal import InMemoryBlobStore, InMemoryJournal  # noqa: E402
from ontocopilot.kernel.llm import (  # noqa: E402
    _TIER_EFFORT,
    _TIER_KEYS,
    GATEWAY_MODELS,
    PRODUCTION_MODELS,
    Completion,
    LLMBackend,
    ModelError,
    ModelGateway,
    ModelRefusal,
    ModelSpec,
    ModelTruncated,
    QuotaExhausted,
    RoutingTable,
    ScriptedBackend,
    Usage,
    _looks_truncated,
    _parse_json,
    _validate,
    gateway_routing,
    production_routing,
    stub_routing,
)
from ontocopilot.kernel.recorder import Recorder  # noqa: E402

SPEC = ModelSpec("test-model", "mid", 3.0, 15.0, effort="medium")


def spec_dict(s: ModelSpec) -> dict[str, Any]:
    return {"name": s.name, "tier": s.tier, "usd_per_mtok_in": s.usd_per_mtok_in,
            "usd_per_mtok_out": s.usd_per_mtok_out, "effort": s.effort,
            "thinking": s.thinking}


def routing_dict(r: RoutingTable) -> dict[str, Any]:
    return {
        "models": {str(d): spec_dict(s) for d, s in r.models.items()},
        "judges": [spec_dict(s) for s in r.judges],
        "fast": spec_dict(r.fast) if r.fast is not None else None,
        "max_iterations": {str(d): n for d, n in r.max_iterations.items()},
        "critic_rounds": {str(d): n for d, n in r.critic_rounds.items()},
        "self_consistency": {str(d): n for d, n in r.self_consistency.items()},
    }


def err(fn) -> dict[str, Any]:
    """跑一次，把「成功值」或「异常类型 + 逐字消息」记下来。"""
    try:
        return {"ok": True, "value": fn()}
    except Exception as exc:  # noqa: BLE001 —— 导 golden 就是要把异常也导出来
        return {"ok": False, "exc": type(exc).__name__, "message": str(exc)}


# ══════════════════════════════════════════════════════════════════
#  成本与用量
# ══════════════════════════════════════════════════════════════════
_COST_CASES: list[tuple[dict[str, Any], tuple[int, int, int, int]]] = [
    ({"pin": 3.0, "pout": 15.0}, (1000, 500, 0, 0)),
    ({"pin": 3.0, "pout": 15.0}, (1_000_000, 0, 0, 0)),
    ({"pin": 3.0, "pout": 15.0}, (0, 0, 1_000_000, 0)),      # 缓存读 0.1×
    ({"pin": 3.0, "pout": 15.0}, (0, 0, 0, 1_000_000)),      # 缓存写 1.25×
    ({"pin": 1.0, "pout": 4.0}, (12_345, 6_789, 1_011, 213)),
    ({"pin": 0.3, "pout": 1.2}, (7, 3, 1, 1)),               # 小数会暴露运算顺序
    ({"pin": 5.0, "pout": 25.0}, (0, 0, 0, 0)),
]

_USAGE_CASES: list[dict[str, Any]] = [
    {},
    {"tok_in": 10, "tok_out": 5},
    {"tok_in": 10, "tok_out": 5, "cache_read": 3, "cache_write": 7},
    {"tok_in": 1, "tok_out": 2, "cache_read": 3, "cache_write": 4, "usd": 0.125},
    {"usd": 0.0},
]


# ══════════════════════════════════════════════════════════════════
#  截断判据
# ══════════════════════════════════════════════════════════════════
_TRUNC_CASES: list[str] = [
    "JSON 不完整（输出被截断）",
    "输出里找不到 JSON",
    "Unterminated string starting at: line 1 column 7 (char 6)",
    "Expecting value: line 1 column 1 (char 0)",
    "Expecting ',' delimiter: line 1 column 5 (char 4)",
    "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)",
    "字段 foo 不是 string",
    "schema 里没有这个枚举值",
    "$ 缺少必填字段 'ok'",
    "$.a 应为 string",
    "",
    "内容被截断了",
]


# ══════════════════════════════════════════════════════════════════
#  _parse_json
# ══════════════════════════════════════════════════════════════════
#: 真实事故：回答**内容里**含一段 ```json 范例，无条件抠围栏会把外层结构顶掉。
_EXAMPLE_ANSWER = json.dumps({
    "thought": "给他一份 schema 范例",
    "answer": "可以这样写：\n```json\n{\n  \"type\": \"object\"\n}\n```\n照着改。",
    "citations": [], "confidence": 0.9,
}, ensure_ascii=False)

_PARSE_CASES: list[str] = [
    '{"answer":"hi"}',
    '  {"answer":"hi"}  ',
    "```json\n{\"answer\":\"ok\"}\n```",
    "```\n{\"answer\":\"ok\"}\n```",
    "这是结果：{\"answer\":\"y\"} 完毕",
    _EXAMPLE_ANSWER,
    "前言\n```json\n{\"a\":1}\n```\n后记",          # 围栏不在开头 → 走 search
    "[1, 2, 3]",
    "文字 [1,2] 文字 {\"a\":1}",                    # start 取两者靠前的那个
    '"裸字符串"',
    "42",
    "true",
    "null",
    "没有任何 JSON",
    "{",                                            # end <= start → 不完整
    '{"a": 1',                                      # 有 { 无 } → 不完整
    '{"a": }',                                      # 有结构、解析失败
    '{"a": 1,}',
    '{"a": 1 "b": 2}',
    '{"a": "未闭合',
    "```json\n{\"a\": 1\n```",                       # 围栏里是坏 JSON → 退回 t=inner
    "```json\n坏的\n```{\"b\": 2}",
    "NaN",                                          # CPython 认，V8 不认
    '{"x": Infinity}',
]


# ══════════════════════════════════════════════════════════════════
#  _validate
# ══════════════════════════════════════════════════════════════════
_OBJ = {"type": "object", "required": ["a", "b"],
        "properties": {"a": {"type": "string"}, "b": {"type": "integer"}}}
_ARR = {"type": "array", "items": {"type": "object", "required": ["k"],
                                   "properties": {"k": {"type": "number"}}}}
_ENUM = {"type": "string", "enum": ["低", "中", "高"]}

_VALIDATE_CASES: list[tuple[Any, dict[str, Any]]] = [
    ({"a": "x", "b": 1}, _OBJ),
    ({"a": "x"}, _OBJ),                                   # 缺 b
    ({"b": 1}, _OBJ),                                     # 缺 a（报的是第一个缺的）
    ({"a": 1, "b": 1}, _OBJ),                             # a 类型错
    ({"a": "x", "b": "1"}, _OBJ),                         # b 类型错
    ({"a": "x", "b": True}, _OBJ),                        # bool 不算 integer
    ([], _OBJ),
    ("串", _OBJ),
    (None, _OBJ),
    (3, _OBJ),
    ([{"k": 1}, {"k": 2.5}], _ARR),
    ([{"k": 1}, {}], _ARR),                               # 第二项缺 k → path [1]
    ([{"k": "x"}], _ARR),
    ({"k": 1}, _ARR),
    ([{"k": True}], _ARR),                                # bool 不算 number
    ("中", _ENUM),
    ("其他", _ENUM),
    (5, _ENUM),
    ({"a": "x", "b": 1}, {"type": "object"}),             # 无 properties/required
    ({"a": "x"}, {}),                                     # 空 schema：什么都不查
    (True, {"type": "boolean"}),
    (1, {"type": "boolean"}),
    ("x", {"type": "number"}),
    (1.5, {"type": "integer"}),                           # 真浮点：Python 判错
    # 整数值的 float：**JS 里与 int 是同一个值，分不出来**。这两条是钉分叉用的，
    # 不是期望 TS 跟上 —— 见 kernel.llm.test.ts 里对应的说明。
    (2.0, {"type": "integer"}),
    (2.0, _OBJ),                                          # 报错文案里的 type 名
    ("x", {"type": "unknown-kind"}),                      # 未知 type 一律放行
    ("b", {"enum": ["a", "b"]}),                          # 只有 enum、没有 type
    ("c", {"enum": ["a", "b"]}),
    ("c", {"enum": []}),                                  # 空 enum 是假值 → 不查
    ({"a": "x", "b": 1, "多": 1}, _OBJ),                   # 多余字段不报
    ({"a": "x", "b": 1}, {"type": "object", "required": ["缺失的中文键"]}),
]


# ══════════════════════════════════════════════════════════════════
#  strictify
# ══════════════════════════════════════════════════════════════════
_STRICTIFY_CASES: list[dict[str, Any]] = [
    {"type": "object", "properties": {"b": {"type": "string"}, "a": {"type": "number"}}},
    {"type": "object", "properties": {}},
    {"type": "object"},
    {"type": "object", "required": ["a"],
     "properties": {"a": {"type": "object", "properties": {"z": {"type": "string"}}}}},
    {"type": "array", "items": {"type": "object",
                                "properties": {"k": {"type": "string"}}}},
    {"type": "array"},
    {"type": "string", "enum": ["a"]},
    # 键排序按 code point：非 ASCII 与星平面都要钉（JS 默认按 UTF-16 code unit）
    {"type": "object", "properties": {"z": {"type": "string"}, "中": {"type": "string"},
                                      "\U0001f600": {"type": "string"},
                                      "￿": {"type": "string"},
                                      "A": {"type": "string"}}},
    {"type": "object", "additionalProperties": True,
     "properties": {"a": {"type": "string"}}},           # 已有的键被覆盖但保持位置
]


# ══════════════════════════════════════════════════════════════════
#  欠费判定
# ══════════════════════════════════════════════════════════════════
QUOTA_429 = ('{"error":{"message":"当前分组上游负载已饱和，请稍后再试",'
             '"type":"insufficient_quota","code":"insufficient_user_quota"}}')
RATE_429 = ('{"error":{"message":"Rate limit reached for this model, please slow down",'
            '"type":"rate_limit_error","code":"rate_limit_exceeded"}}')

_QUOTA_CASES: list[tuple[int, str]] = [
    (402, ""), (402, "whatever"), (402, RATE_429),
    (429, QUOTA_429),
    (429, '{"error":{"code":"INSUFFICIENT_QUOTA"}}'),
    (429, '{"error":{"message":"账户余额不足，请充值"}}'),
    (429, '{"error":{"message":"额度已用完"}}'),
    (429, '{"error":{"message":"credit balance is too low"}}'),
    (429, '{"error":{"message":"欠费停机"}}'),
    (429, '{"error":{"message":"CREDIT"}}'),
    (429, '{"error":{"type":"exceeded_current_quota"}}'),
    (429, '{"error":{"type":"quota_exceeded"}}'),
    (429, '{"error":{"type":"billing_hard_limit_reached"}}'),
    (429, RATE_429), (429, ""), (429, '{"error":{"message":"Too many requests"}}'),
    (500, QUOTA_429), (503, '{"error":{"message":"余额"}}'), (200, QUOTA_429),
    (401, QUOTA_429), (0, QUOTA_429),
]


# ══════════════════════════════════════════════════════════════════
#  后端请求组装 / 响应解析
# ══════════════════════════════════════════════════════════════════
_FLASH = ModelSpec("google/gemini-3.5-flash", "mid", 1.0, 4.0, effort=None, thinking=None)
_SONNET = ModelSpec("anthropic/claude-sonnet-5", "mid", 3.0, 15.0, effort="high")
_SCHEMA = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}

_BUILD_CASES: list[dict[str, Any]] = [
    {"model": _SONNET, "prompt": "hi", "system": "", "schema": None,
     "max_tokens": 100, "drop": set(), "images": None},
    {"model": _SONNET, "prompt": "hi", "system": "系统提示", "schema": _SCHEMA,
     "max_tokens": 16000, "drop": set(), "images": None},
    {"model": _FLASH, "prompt": "hi", "system": "s", "schema": _SCHEMA,
     "max_tokens": 100, "drop": set(), "images": None},
    {"model": _SONNET, "prompt": "看图", "system": "", "schema": None,
     "max_tokens": 100, "drop": set(), "images": ["data:image/png;base64,AAA",
                                                  "data:image/png;base64,BBB"]},
    {"model": _SONNET, "prompt": "hi", "system": "s", "schema": _SCHEMA,
     "max_tokens": 100, "drop": {"reasoning"}, "images": None},
    {"model": _SONNET, "prompt": "hi", "system": "s", "schema": _SCHEMA,
     "max_tokens": 100, "drop": {"response_format", "reasoning"}, "images": None},
]

_ANTHROPIC_BUILD_CASES: list[dict[str, Any]] = [
    {"model": _SONNET, "prompt": "hi", "system": "", "schema": None,
     "max_tokens": 100, "cache_system": True},
    {"model": _SONNET, "prompt": "hi", "system": "系统", "schema": None,
     "max_tokens": 100, "cache_system": True},
    {"model": _SONNET, "prompt": "hi", "system": "系统", "schema": None,
     "max_tokens": 100, "cache_system": False},
    {"model": _SONNET, "prompt": "hi", "system": "系统", "schema": _SCHEMA,
     "max_tokens": 20000, "cache_system": True},
    {"model": _FLASH, "prompt": "hi", "system": "系统", "schema": _SCHEMA,
     "max_tokens": 100, "cache_system": True},
]

_PARSE_RESP_CASES: list[dict[str, Any]] = [
    {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
     "usage": {"prompt_tokens": 10, "completion_tokens": 5}},
    {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
     "usage": {"prompt_tokens": 100, "completion_tokens": 5,
               "prompt_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 7},
               "cost": 0.0123}},
    {"choices": [{"message": {"content": ""}, "finish_reason": "length"}],
     "usage": {"prompt_tokens": 1, "completion_tokens": 0}},
    # 只出了思考没出正文 → 可重试的 ModelTruncated
    {"choices": [{"message": {"content": "", "reasoning": "想了很久"},
                  "finish_reason": "length"}],
     "usage": {"prompt_tokens": 1, "completion_tokens": 900}},
    {"choices": [{"message": {"refusal": "safety"}, "finish_reason": "stop"}]},
    {"choices": [{"message": {"content": "x"}, "finish_reason": "content_filter"}]},
    {"choices": []},
    {},
    {"choices": [{"message": {"content": "ok"}}],
     "usage": {"prompt_tokens": 10, "completion_tokens": 5,
               "prompt_tokens_details": {"cached_tokens": 30}}},   # 缓存 > 输入 → 钳到 0
    {"choices": [{"message": {"content": "ok"}}], "usage": None},
    {"choices": [{"message": None}]},
]

_OFFENDING_CASES: list[tuple[str, dict[str, Any]]] = [
    ("Unknown field: response_format", {"response_format": {}, "reasoning": {}}),
    ("unsupported parameter 'reasoning'", {"response_format": {}, "reasoning": {}}),
    ("RESPONSE_FORMAT not allowed", {"response_format": {}}),
    ("reasoning is not supported", {"model": "m"}),          # body 里没有 → None
    ("something else broke", {"response_format": {}, "reasoning": {}}),
    # 两个都提到时按固定顺序取 response_format
    ("response_format and reasoning both bad", {"response_format": {}, "reasoning": {}}),
]


# ══════════════════════════════════════════════════════════════════
#  端到端：网关记账
# ══════════════════════════════════════════════════════════════════
class _Sequenced(LLMBackend):
    """按脚本产出，逐次记录**真打出去的**请求 —— 重试的那几次也是真花钱。"""

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def generate(self, *, model, prompt, system="", schema=None,
                       max_tokens=16_000, cache_system=True, images=None):
        item = self.script[min(len(self.calls), len(self.script) - 1)]
        self.calls.append({"model": model.name, "prompt": prompt,
                           "max_tokens": max_tokens, "schema": schema is not None})
        if isinstance(item, Exception):
            raise item
        return item


def _gateway(backend: LLMBackend, ledger: list[dict[str, Any]], *,
             run_id: str, journal: InMemoryJournal, blobs: InMemoryBlobStore,
             resume: bool = False, max_schema_retries: int = 2,
             budget: Budget | None = None) -> tuple[ModelGateway, Budget]:
    b = budget or Budget()
    rec = Recorder(run_id, journal, blobs, resume=resume)
    return ModelGateway(backend, rec, routing=stub_routing(), budget=b,
                        usage_sink=ledger.append,
                        max_schema_retries=max_schema_retries), b


def _completion_dict(c: Completion) -> dict[str, Any]:
    return {"text": c.text, "data": c.data, "model": c.model,
            "usage": c.usage.to_dict(), "usd": c.usd, "attempts": c.attempts}


def _spent_events(journal: InMemoryJournal, run_id: str) -> list[dict[str, Any]]:
    return [ev.payload for ev in journal.read(run_id)
            if ev.kind is EventKind.BUDGET_SPENT]


async def _scenario(name: str, script: list[Any], *, schema: dict[str, Any] | None,
                    max_schema_retries: int = 2, prompt: str = "给我 JSON",
                    difficulty: Difficulty = Difficulty.LOW) -> dict[str, Any]:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    ledger: list[dict[str, Any]] = []
    backend = _Sequenced(script)
    gw, budget = _gateway(backend, ledger, run_id=name, journal=journal, blobs=blobs,
                          max_schema_retries=max_schema_retries)

    outcome: dict[str, Any]
    kwargs: dict[str, Any] = {"difficulty": difficulty}
    if schema is not None:
        kwargs["schema"] = schema
    try:
        comp = await gw.call("NODE", prompt, **kwargs)
        outcome = {"ok": True, "completion": _completion_dict(comp)}
    except Exception as exc:  # noqa: BLE001
        outcome = {"ok": False, "exc": type(exc).__name__, "message": str(exc)}

    return {
        "name": name,
        "outcome": outcome,
        "backend_calls": backend.calls,
        "ledger": ledger,
        "budget_spent_events": _spent_events(journal, name),
        "budget": {"tokens": budget.spent("tokens"), "usd": budget.spent("usd")},
    }


async def _replay_scenario() -> dict[str, Any]:
    """**最要命的一种账目错误**：重放时 Recorder 直接返回历史结果、根本不打模型，
    记账如果照记不误，resume 一次账单就翻一倍 —— 而 resume 恰恰是常态。"""
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    schema = {"type": "object", "required": ["ok"],
              "properties": {"ok": {"type": "boolean"}}}
    ledger: list[dict[str, Any]] = []
    backend = _Sequenced([
        ("not json", Usage(tok_in=10, tok_out=2, cache_read=3, usd=0.10)),
        ('{"ok": true}', Usage(tok_in=20, tok_out=4, cache_write=5, usd=0.20)),
    ])
    gw, budget = _gateway(backend, ledger, run_id="run-usage", journal=journal,
                          blobs=blobs, max_schema_retries=1)
    first = await gw.call("NODE", "give json", difficulty=Difficulty.LOW, schema=schema)

    ledger2: list[dict[str, Any]] = []
    gw2, budget2 = _gateway(backend, ledger2, run_id="run-usage", journal=journal,
                            blobs=blobs, resume=True, max_schema_retries=1)
    second = await gw2.call("NODE", "give json", difficulty=Difficulty.LOW, schema=schema)

    return {
        "first": {"completion": _completion_dict(first), "ledger": ledger,
                  "budget": {"tokens": budget.spent("tokens"), "usd": budget.spent("usd")},
                  "budget_spent_events": _spent_events(journal, "run-usage")},
        "replay": {"completion": _completion_dict(second), "ledger": ledger2,
                   "budget": {"tokens": budget2.spent("tokens"),
                              "usd": budget2.spent("usd")},
                   "backend_calls": len(backend.calls),
                   "budget_spent_events": _spent_events(journal, "run-usage")},
    }


async def _judge_scenario() -> dict[str, Any]:
    """评委、SmartGateway、对话、OCR 最终都走 call —— 钩在那里才是 100% 覆盖。"""
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()
    ledger: list[dict[str, Any]] = []
    backend = _Sequenced([("ok", Usage(tok_in=5, tok_out=5))])
    rec = Recorder("run-judge", journal, blobs)
    routing = RoutingTable(models=dict.fromkeys(Difficulty, SPEC),
                           judges=[ModelSpec("judge-model", "mid", 1.0, 2.0, effort=None),
                                   ModelSpec("judge-two", "mid", 1.0, 2.0, effort="high")])
    gw = ModelGateway(backend, rec, routing=routing, budget=Budget(),
                      usage_sink=ledger.append)
    comp = await gw.judge("NODE", "评一下", generator=SPEC, salt=1)
    return {"completion": _completion_dict(comp), "ledger": ledger,
            "backend_calls": backend.calls}


async def _scripted_backend() -> list[dict[str, Any]]:
    """ScriptedBackend：离线端到端跑通的底座，用量是 est_tokens 估的。"""
    be = ScriptedBackend([(r"抽取 ObjectType", '{"objects": ["a"]}'),
                          (r"多行.*匹配", "命中")], default="{}")
    out: list[dict[str, Any]] = []
    for system, prompt in [("", "抽取 ObjectType 列表"), ("系统", "多行\n匹配"),
                           ("sys", "没有规则命中"), ("", "中文提示词很长" * 3)]:
        text, usage = await be.generate(model=SPEC, prompt=prompt, system=system)
        out.append({"system": system, "prompt": prompt, "text": text,
                    "usage": usage.to_dict()})
    return out


async def _gateway_scenarios() -> list[dict[str, Any]]:
    schema = {"type": "object", "required": ["ok"],
              "properties": {"ok": {"type": "boolean"}}}
    return [
        # 一次成功，无 schema
        await _scenario("plain", [("ok", Usage(tok_in=120, tok_out=30, cache_read=10))],
                        schema=None, prompt="问点什么"),
        # 网关回了真实账单 → usd_source=gateway
        await _scenario("gateway-usd",
                        [("ok", Usage(tok_in=1000, tok_out=1000, usd=0.42))], schema=None),
        # 没回账单 → 本地价目表估算
        await _scenario("estimated-usd",
                        [("ok", Usage(tok_in=1_000_000, tok_out=0))], schema=None),
        # schema 校验失败 → 重试（报错文案是我们自己的中文，跨语言逐字节可比）
        await _scenario("validate-retry", [
            ('{"a": 1}', Usage(tok_in=100, tok_out=50)),
            ('{"ok": "真"}', Usage(tok_in=110, tok_out=60)),
            ('{"ok": true}', Usage(tok_in=120, tok_out=20)),
        ], schema=schema),
        # 解析失败 → 重试（报错文案来自 CPython 的 json，两侧字符串不同）
        await _scenario("parse-retry", [
            ("不是 JSON", Usage(tok_in=100, tok_out=50)),
            ('{"ok": true}', Usage(tok_in=120, tok_out=20)),
        ], schema=schema),
        # 一直不合 schema → 抛 ModelError，但那几次都花了钱
        await _scenario("all-bad", [('{"a": 1}', Usage(tok_in=200, tok_out=10))],
                        schema=schema),
        # 部分尝试有网关账单、部分没有 → 聚合标 estimated，usage.usd 保持 None
        await _scenario("mixed-usd", [
            ('{"a": 1}', Usage(tok_in=10, tok_out=1, usd=0.10)),
            ('{"ok": true}', Usage(tok_in=20, tok_out=2)),
        ], schema=schema),
        # 截断 → 加大预算重试（看 backend_calls 里的 max_tokens）
        await _scenario("truncated", [
            ModelTruncated("只有推理没有正文"),
            ('{"ok": true}', Usage(tok_in=30, tok_out=3)),
        ], schema=schema),
        # 一直截断 → 原样抛 ModelTruncated
        await _scenario("truncated-forever", [ModelTruncated("一直只有推理")],
                        schema=schema, max_schema_retries=1),
        # 欠费 → 一次都不重试，账上仍留一行 failed
        await _scenario("quota", [QuotaExhausted("stub-small", QUOTA_429, status=429)],
                        schema=schema),
        # 记账 sink 挂了不该把模型调用带下去
        await _scenario("no-schema-truncated", [ModelTruncated("正文空")], schema=None,
                        max_schema_retries=0),
    ]


async def _broken_sink() -> dict[str, Any]:
    journal, blobs = InMemoryJournal(), InMemoryBlobStore()

    def boom(_row: dict[str, Any]) -> None:
        raise RuntimeError("库挂了")

    rec = Recorder("run-sink", journal, blobs)
    gw = ModelGateway(_Sequenced([("ok", Usage(tok_in=1, tok_out=1))]), rec,
                      routing=stub_routing(), budget=Budget(), usage_sink=boom)
    comp = await gw.call("NODE", "x", difficulty=Difficulty.LOW)
    return {"completion": _completion_dict(comp),
            "budget_spent_events": _spent_events(journal, "run-sink")}


# ══════════════════════════════════════════════════════════════════
def main() -> None:
    cat = ModelCatalog()
    stub = stub_routing()
    prod = production_routing()

    routing_params = {
        str(d): {
            "iterations": stub.max_iterations.get(d, 4),
            "critic_rounds": stub.critic_rounds.get(d, 1),
            "self_consistency": stub.self_consistency.get(d, 1),
        }
        for d in Difficulty
    }

    ob = OpenAICompatBackend("http://gw.test/v1/", "sk-secret-key")
    ab = AnthropicBackend(client=object(), server_fallback=False)

    out: dict[str, Any] = {
        "constants": {
            "stream_threshold": STREAM_THRESHOLD,
            "retryable_status": sorted(RETRYABLE_STATUS),
            "tier_keys": {k: str(v) for k, v in _TIER_KEYS.items()},
            "tier_effort": {str(k): v for k, v in _TIER_EFFORT.items()},
            "base_url_rstrip": ob.base_url,
        },
        "cost": [
            {"spec": spec_dict(ModelSpec("m", "mid", c["pin"], c["pout"])),
             "tok_in": a, "tok_out": b, "cache_read": cr, "cache_write": cw,
             "usd": ModelSpec("m", "mid", c["pin"], c["pout"]).cost(a, b, cr, cw)}
            for c, (a, b, cr, cw) in _COST_CASES
        ],
        "usage": [{"init": kw, "total": Usage(**kw).total, "to_dict": Usage(**kw).to_dict()}
                  for kw in _USAGE_CASES],
        "looks_truncated": [{"err": e, "out": _looks_truncated(e)} for e in _TRUNC_CASES],
        "parse_json": [
            {"text": t, **_parse_case(t)} for t in _PARSE_CASES
        ],
        "validate": [
            {"data": d, "schema": s, **err(lambda d=d, s=s: _validate(d, s))}
            for d, s in _VALIDATE_CASES
        ],
        "strictify": [{"in": s, "out": strictify(s)} for s in _STRICTIFY_CASES],
        "quota_judgement": [{"status": st, "body": b,
                             "out": looks_like_quota_exhausted(st, b)}
                            for st, b in _QUOTA_CASES],
        "openai_build": [
            {"args": {**{k: v for k, v in c.items() if k != "model" and k != "drop"},
                      "model": spec_dict(c["model"]), "drop": sorted(c["drop"])},
             "out": ob._build(model=c["model"], prompt=c["prompt"], system=c["system"],
                              schema=c["schema"], max_tokens=c["max_tokens"],
                              drop=c["drop"], images=c["images"])}
            for c in _BUILD_CASES
        ],
        "anthropic_build": [
            {"args": {**{k: v for k, v in c.items() if k != "model"},
                      "model": spec_dict(c["model"])},
             "out": ab._build(model=c["model"], prompt=c["prompt"], system=c["system"],
                              schema=c["schema"], max_tokens=c["max_tokens"],
                              cache_system=c["cache_system"])}
            for c in _ANTHROPIC_BUILD_CASES
        ],
        "openai_parse": [
            {"data": d, **_parse_resp_case(ob, d)} for d in _PARSE_RESP_CASES
        ],
        "offending_field": [
            {"error_text": t, "body_keys": sorted(b),
             "out": OpenAICompatBackend._offending_field(t, b)}
            for t, b in _OFFENDING_CASES
        ],
        "routing": {
            "production_models": {k: spec_dict(v) for k, v in PRODUCTION_MODELS.items()},
            "gateway_models": {k: spec_dict(v) for k, v in GATEWAY_MODELS.items()},
            "production": routing_dict(prod),
            "stub": routing_dict(stub),
            "gateway_default": routing_dict(gateway_routing()),
            "gateway_overrides": [
                {"overrides": o, "catalog": with_cat,
                 **err(lambda o=o, w=with_cat: routing_dict(
                     gateway_routing(o, cat if w else None)))}
                for o, with_cat in [
                    ({"high": "google/gemini-3.5-flash"}, True),
                    ({"high": "openai/gpt-5.5"}, True),
                    ({"low": "openai/gpt-5.5"}, True),
                    ({"critical": "deepseek/deepseek-v3.2"}, True),
                    ({"high": "some/unknown-model"}, True),
                    ({"high": "openai/gpt-5.5"}, False),
                    ({}, True),
                    (None, True),
                ]
            ],
            "params": routing_params,
            "model_for": [
                {"difficulty": str(d), **err(lambda d=d: spec_dict(stub.model_for(d)))}
                for d in Difficulty
            ],
            "model_for_missing": err(
                lambda: spec_dict(RoutingTable().model_for(Difficulty.HIGH))),
            "judge_for": [
                {"generator": g, "salt": s,
                 **err(lambda g=g, s=s: prod.judge_for(
                     ModelSpec(g, "mid", 1.0, 1.0), s).name)}
                for g, s in [("claude-opus-5", 0), ("claude-opus-5", 1),
                             ("claude-sonnet-5", 0), ("claude-sonnet-5", 3),
                             ("other", 0), ("other", 1), ("other", 2), ("other", 5),
                             ("other", -1), ("other", -3)]
            ],
            "judge_for_empty": err(
                lambda: RoutingTable(judges=[SPEC]).judge_for(SPEC).name),
        },
        "catalog_cards": {
            name: spec_dict(cat.get(name).spec)
            for name in ["google/gemini-3.5-flash", "openai/gpt-5.5",
                         "deepseek/deepseek-v3.2", "anthropic/claude-sonnet-5"]
            if cat.get(name) is not None
        },
        "errors": {
            "quota_exhausted": [
                {"model": m, "detail": d, "status": st,
                 "message": str(QuotaExhausted(m, d, status=st)),
                 "detail_out": QuotaExhausted(m, d, status=st).detail,
                 "detail_len": len(QuotaExhausted(m, d, status=st).detail)}
                for m, d, st in [
                    ("m", "insufficient_quota", 429),
                    ("m", "  padded  ", 402),
                    ("m", "", 0),
                    ("m", "", 402),
                    # 300 码点的截断：中文一个字一个码点，按字节切会切碎
                    ("测试模型", "余" * 400, 429),
                    ("m", "x" * 1000, 402),
                ]
            ],
            "refusal": [
                {"model": m, "category": c, "message": str(ModelRefusal(m, c))}
                for m, c in [("m", "safety"), ("m", None), ("m", ""), ("模型", "自伤")]
            ],
            "model_error": str(ModelError("普通失败")),
            "hierarchy": {
                "ModelTruncated": [c.__name__ for c in ModelTruncated.__mro__[1:4]],
                "QuotaExhausted": [c.__name__ for c in QuotaExhausted.__mro__[1:4]],
                "ModelRefusal": [c.__name__ for c in ModelRefusal.__mro__[1:4]],
            },
        },
        "scripted_backend": asyncio.run(_scripted_backend()),
        "gateway": asyncio.run(_gateway_scenarios()),
        "gateway_replay": asyncio.run(_replay_scenario()),
        "gateway_judge": asyncio.run(_judge_scenario()),
        "gateway_broken_sink": asyncio.run(_broken_sink()),
    }

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "llm.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}  {dst.stat().st_size} B")


def _parse_case(text: str) -> dict[str, Any]:
    """`_parse_json` 的结果 + **截断分类**。

    CPython 与 V8 的 JSON 报错文案完全不同（"Expecting value" vs "Unexpected end of
    JSON input"），字符串没法直接比 —— 但 `_looks_truncated(str(exc))` 的**布尔结果
    必须一致**，否则 TS 侧「截断就加大预算重试」这条会静默失效。所以这里同时导
    分类（error_kind）与判定（truncated）。
    """
    try:
        value = _parse_json(text)
        # CPython 的 json 认 NaN / Infinity 字面量，V8 不认。把非有限数换成哨兵串：
        # 一来 `json.dumps` 写出的 `NaN` 根本不是合法 JSON（JS 侧 `JSON.parse`
        # 直接读不了这个 golden 文件），二来这两条正是要钉的分叉。
        return {"ok": True, "value": _jsonable(value),
                "nonfinite": _has_nonfinite(value), "error_kind": None,
                "truncated": False}
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if msg == "输出里找不到 JSON":
            kind = "not_found"
        elif msg == "JSON 不完整（输出被截断）":
            kind = "incomplete"
        elif msg.startswith("JSON 解析失败: "):
            kind = "decode"
        else:
            kind = "other"
        return {"ok": False, "exc": type(exc).__name__, "message": msg,
                "nonfinite": False, "error_kind": kind,
                "truncated": _looks_truncated(msg)}


def _jsonable(v: Any) -> Any:
    """把非有限 float 换成哨兵串 —— golden 必须是**合法 JSON**，JS 才读得进去。"""
    import math

    if isinstance(v, float) and not math.isfinite(v):
        return "__nan__" if math.isnan(v) else ("__inf__" if v > 0 else "__-inf__")
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


def _has_nonfinite(v: Any) -> bool:
    import math

    if isinstance(v, float):
        return not math.isfinite(v)
    if isinstance(v, dict):
        return any(_has_nonfinite(x) for x in v.values())
    if isinstance(v, list):
        return any(_has_nonfinite(x) for x in v)
    return False


def _parse_resp_case(ob: OpenAICompatBackend, data: dict[str, Any]) -> dict[str, Any]:
    try:
        text, usage = ob._parse(SPEC, data)
        return {"ok": True, "text": text, "usage": usage.to_dict()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "exc": type(exc).__name__, "message": str(exc)}


if __name__ == "__main__":
    main()
