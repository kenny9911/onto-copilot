"""kernel/catalog.py 的 golden —— 「这次调用花多少钱、能不能读图」的全部判据。

写 `golden/catalog.json`（新文件，本 track 独占）。重跑两次字节一致。

    .venv/bin/python tools/golden/catalog.py

为什么这份要导得这么细：**catalog 决定每一次模型调用打在哪个模型上**，而它的
错法全是「不报错、只是结果变差」这一类 ——

  - `select()` 的排序键写反一位，旗舰模型就永远排在便宜模型后面（或反过来），
    账单差一个数量级而日志里什么都看不出来；
  - `infer_capabilities` 少认一个视觉模型，扫描件就静默 OCR 不了 ——
    产物看起来完整，只是那份材料的内容从来没进去过；
  - `denial_capability` 判宽了会把一次普通 500 当成「这个模型没有视觉」，
    于是把真能读图的模型从目录里抹掉，本进程内再也选不到它。

所以这里钉的是**判据矩阵**而不是「跑通」：每条正则的正例与反例、排序的完整次序、
失败学习的前后状态、以及 SmartGateway 逐个候选切换时的 trace。

TS 侧独有的风险，这里专门导了：

  1. `pool.sort(key=...)` 是**稳定**排序，而并列项的先后取决于 `dict` 的插入序 ——
     TS 用普通对象会把 `"a/b"` 这类键保序，但 `del` + 重新插入的顺序必须一样，
     所以 `discover` 前后的 `names()`/`select()` 两头都导；
  2. `ModelCatalog(cards)` 里的 `cards or CARDS`：**空列表是假值**，
     `ModelCatalog([])` 拿到的是内置目录而不是空目录。照抄成 `cards ?? CARDS`
     就是一个空目录，`require()` 立刻抛 LookupError；
  3. `f"{cap}"` 对 StrEnum 给的是**值**（"vision"），不是 "Capability.VISION"；
  4. `text[:150]` / `text[:200]` 按 code point 切，中文错误文本用 UTF-16 slice
     会在代理对上切出半个字符；
  5. `SmartGateway.call` 里那行 `key=... if "key" in kw else None` **会把 key
     从 kw 里 pop 掉**，所以只有第 0 个候选拿得到 `"<key>:0"`，第 1 个之后
     一律是 `None`。这是既有行为，TS 必须一模一样（改了就是重放指纹全变）。
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

import httpx  # noqa: E402

from ontocopilot.kernel.catalog import (  # noqa: E402
    CARDS,
    Capability,
    ModelCatalog,
    ModelCard,
    SmartGateway,
    card_from_name,
    denial_capability,
    infer_capabilities,
    is_chat_model,
)

C = Capability


def _spec(s: Any) -> dict[str, Any]:
    return {"name": s.name, "tier": s.tier, "usd_per_mtok_in": s.usd_per_mtok_in,
            "usd_per_mtok_out": s.usd_per_mtok_out, "effort": s.effort,
            "thinking": s.thinking}


def _card(c: ModelCard) -> dict[str, Any]:
    return {"to_dict": c.to_dict(), "spec": _spec(c.spec)}


# ══════════════════════════════════════════════════════════════════
#  denial_capability：把「网关拒绝的原因」认成一项能力
# ══════════════════════════════════════════════════════════════════
#: 前半是真实网关回过的话，后半是**反例** —— 判宽一格就会把普通故障当成
#: 「这个模型没有视觉」，然后把唯一能 OCR 的模型从目录里抹掉。
_DENIALS = [
    "No endpoints found that support image input",
    "no endpoints found that support image input.",
    "This model does not support vision",
    "model not support response_format",
    "unsupported parameter: reasoning.effort",
    "invalid json_schema for this model",
    "该模型不支持图片输入",
    "该模型不支持 structured 输出",
    "不支持 effort 参数",
    "Invalid multimodal request",
    "UNSUPPORTED: image_input",
    # ── 反例：说明「缺能力」的词都不在 ──────────────────────────────
    "",
    "   ",
    "Internal server error",
    "rate limit exceeded",
    "insufficient_user_quota",
    "connection reset by peer",
    # 命中了 not support 但没命中任何一项能力 → None（是别的故障）
    "does not support this request",
    "unsupported region",
    # 命中了能力词却没命中「不支持」的前置判据 → None
    "vision model ready",
    "response_format accepted",
    # 前置判据与能力词分处两句：Python 是两次独立 search，都命中就算数
    "server busy; also this model does not support multimodal",
    # 大小写与空白：\s+ 只吃空白，不吃换行以外的东西
    "NOT   SUPPORT image input",
    "not\nsupport vision",
    # 顺序：VISION 排在 STRUCTURED 前面，两个都命中时取先声明的
    "does not support image input with response_format",
    # \beffort\b 的边界：effortless 不该算
    "unsupported: effortless mode",
    "unsupported: effort mode",
]


# ══════════════════════════════════════════════════════════════════
#  按名字推断：is_chat_model / infer_capabilities / card_from_name
# ══════════════════════════════════════════════════════════════════
#: 覆盖 New-API / one-api 这类聚合网关真会暴露的 id 形态。视觉那一栏是重点 ——
#: 认不出带视觉的模型，扫描件就永远 OCR 不了。
_NAMES = [
    # 视觉
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision-preview",
    "gpt-4v", "gpt-5", "gpt-5-mini", "chatgpt-4o-latest",
    "o1", "o1-mini", "o3", "o3-mini", "o4-mini",
    "gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro", "gemini-embedding-001",
    "claude-3-5-sonnet", "claude-3-7-sonnet", "claude-4-opus", "claude-opus-4.8",
    "claude-sonnet-4", "claude-haiku-4.5",
    "qwen-vl-max", "qwen2.5-omni", "qwen2.5-72b", "qwen-turbo",
    "pixtral-large", "llava-1.6", "internvl2-8b", "minicpm-v-2.6",
    "glm-4v", "glm-4.5v", "glm-4-air", "step-1v-8k",
    "grok-2-vision-1212", "grok-4", "grok-3",
    "llama-3.2-11b-vision", "llama-3.2-90b", "llama-3.2-3b", "llama-4-scout",
    "llama-3.1-405b",
    # 纯文本 / 便宜
    "gpt-3.5-turbo", "deepseek-v3.2", "deepseek-r1", "moonshot-v1-8k",
    "kimi-k2.6", "kimi-vl-a3b", "text-davinci-003", "babbage-002",
    "mistral-small", "mistral-large", "yi-lightning", "ernie-4.0-8k",
    "abab6.5s", "hunyuan-lite", "spark-max", "doubao-pro-32k", "doubao-lite-4k",
    # 非对话端点：全该被 is_chat_model 挡掉
    "text-embedding-3-small", "bge-large-zh", "whisper-1", "tts-1-hd",
    "dall-e-3", "dalle-2", "stable-diffusion-3", "flux-pro", "midjourney-v6",
    "bge-reranker-v2", "omni-moderation-latest", "text-moderation-stable",
    "image-01", "gpt-4o-audio-preview", "speech-02", "cosyvoice-voice",
    "sora-2", "kling-v1", "suno-v4",
    # 带厂商前缀（vendor 从这里切）
    "anthropic/claude-opus-4.8", "google/gemini-3.5-flash", "openai/gpt-5.5",
    "deepseek/deepseek-v3.2", "z-ai/glm-5.2", "a/b/c",
    # 边界：既命中 VISION 又命中 TEXT_ONLY（TEXT_ONLY 赢）
    "gemini-embedding-exp", "qwen-vl-plus", "qwen-omni-turbo",
    # 边界：\bflux\b 只在词边界处命中
    "influx-model", "flux-1-dev",
    # 空 / 纯符号
    "", "   ", "-",
]


# ══════════════════════════════════════════════════════════════════
#  select / require：排序键与「一个都挑不出来」
# ══════════════════════════════════════════════════════════════════
_SELECTS: list[dict[str, Any]] = [
    {"needs": [], "prefer": "quality", "limit": 4, "exclude_vendors": []},
    {"needs": [], "prefer": "quality", "limit": 100, "exclude_vendors": []},
    {"needs": [], "prefer": "cost", "limit": 100, "exclude_vendors": []},
    {"needs": ["vision"], "prefer": "quality", "limit": 100, "exclude_vendors": []},
    {"needs": ["vision"], "prefer": "cost", "limit": 3, "exclude_vendors": []},
    {"needs": ["vision", "structured"], "prefer": "quality", "limit": 3,
     "exclude_vendors": []},
    {"needs": ["effort"], "prefer": "quality", "limit": 100, "exclude_vendors": []},
    {"needs": ["cheap"], "prefer": "cost", "limit": 100, "exclude_vendors": []},
    {"needs": ["long_context"], "prefer": "quality", "limit": 100,
     "exclude_vendors": ["anthropic", "openai"]},
    {"needs": ["vision"], "prefer": "quality", "limit": 100,
     "exclude_vendors": ["anthropic", "openai", "google"]},
    # limit 的边界：0 / 负数走 Python 切片语义
    {"needs": [], "prefer": "quality", "limit": 0, "exclude_vendors": []},
    {"needs": [], "prefer": "quality", "limit": -2, "exclude_vendors": []},
    # prefer 是任意字符串：非 "cost" 一律走 quality 分支
    {"needs": [], "prefer": "", "limit": 3, "exclude_vendors": []},
    {"needs": [], "prefer": "COST", "limit": 3, "exclude_vendors": []},
]

_REQUIRE_FAIL = [
    ["vision", "effort", "cheap"],
    ["vision", "cheap", "effort", "long_context", "structured"],
]


def _select_rows() -> list[dict[str, Any]]:
    rows = []
    for case in _SELECTS:
        cat = ModelCatalog()
        got = cat.select({C(n) for n in case["needs"]}, prefer=case["prefer"],
                         limit=case["limit"],
                         exclude_vendors=set(case["exclude_vendors"]))
        rows.append({**case, "out": [c.name for c in got]})
    return rows


def _require_rows() -> list[dict[str, Any]]:
    rows = []
    for needs in _REQUIRE_FAIL:
        cat = ModelCatalog()
        try:
            cat.require({C(n) for n in needs})
        except LookupError as exc:
            rows.append({"needs": needs, "error": str(exc)})
        else:  # pragma: no cover — 这几组本来就该挑不出来
            raise SystemExit(f"require({needs}) 竟然挑出来了，用例失效")
    return rows


# ══════════════════════════════════════════════════════════════════
#  失败学习：record_denial 的前后状态
# ══════════════════════════════════════════════════════════════════
_DENIAL_STEPS = [
    ("anthropic/claude-opus-4.8", "No endpoints found that support image input"),
    # 同一个模型同一项能力再来一次：已经抹掉了 → None，notes 不再增长
    ("anthropic/claude-opus-4.8", "No endpoints found that support image input"),
    # 目录里没有的模型
    ("nope/never", "does not support vision"),
    # 认不出缺哪项能力
    ("openai/gpt-5.5", "Internal server error"),
    # 本来就没有 EFFORT 的模型被说不支持 effort → None（cap not in capabilities）
    ("deepseek/deepseek-v3.2", "unsupported parameter: reasoning.effort"),
    ("openai/gpt-5.5", "unsupported parameter: reasoning.effort"),
]


def _denial_walk() -> dict[str, Any]:
    cat = ModelCatalog()
    steps = []
    for model, text in _DENIAL_STEPS:
        lost = cat.record_denial(model, text)
        steps.append({
            "model": model, "text": text,
            "lost": str(lost) if lost is not None else None,
            "notes": list(cat.notes),
            "card": cat.get(model).to_dict() if cat.get(model) else None,
        })
    return {"steps": steps, "final_by_capability": cat.by_capability(),
            "final_names": cat.names(),
            "vision_after": cat.by_capability().get("vision") or []}


# ══════════════════════════════════════════════════════════════════
#  discover：/v1/models 过滤 + 按名字补目录
# ══════════════════════════════════════════════════════════════════
_SEEN: list[dict[str, Any]] = []
_NEXT: list[Any] = [None]

_REAL_CLIENT = httpx.AsyncClient


class _PatchedClient(_REAL_CLIENT):  # type: ignore[misc, valid-type]
    """把 discover 内部自建的 AsyncClient 换成走 MockTransport 的那一个。

    `discover` 不接受 client 参数（原件不许改），所以只能在模块命名空间上换。
    """

    def __init__(self, **kw: Any) -> None:
        super().__init__(transport=httpx.MockTransport(_handler), **kw)


def _handler(request: httpx.Request) -> httpx.Response:
    _SEEN.append({"url": str(request.url), "method": request.method,
                  "authorization": request.headers.get("authorization", "")})
    return _NEXT[0](request)


def _ok(ids: list[str]) -> Any:
    return lambda _r: httpx.Response(200, json={"data": [{"id": i} for i in ids]})


_LIVE_MIX = [
    # 目录里有的（活着）
    "anthropic/claude-opus-4.8", "google/gemini-3.5-flash",
    # 目录里没有的：按名字推断能力补进来
    "gpt-4o", "gpt-4o-mini", "deepseek-r1", "gemini-2.5-flash",
    # 非对话端点：不该补
    "text-embedding-3-small", "whisper-1", "dall-e-3",
]

_DISCOVER: list[dict[str, Any]] = [
    {"name": "mixed", "base": "http://gw.test/v1", "key": "sk-k",
     "resp": _ok(_LIVE_MIX)},
    {"name": "trailing-slashes", "base": "http://gw.test/v1///", "key": "sk-k",
     "resp": _ok(["anthropic/claude-opus-4.8"])},
    # 全不匹配：目录被清空（_ensure_catalog 正是靠这个退回内置目录）
    {"name": "all-unknown", "base": "http://gw.test/v1", "key": "sk-k",
     "resp": _ok(["some-house-model"])},
    # data 为 null / 缺字段：`.get("data") or []`
    {"name": "null-data", "base": "http://gw.test/v1", "key": "sk-k",
     "resp": lambda _r: httpx.Response(200, json={"data": None})},
    {"name": "no-data-key", "base": "http://gw.test/v1", "key": "sk-k",
     "resp": lambda _r: httpx.Response(200, json={})},
    # 重复 id：live 是 set
    {"name": "dupe-ids", "base": "http://gw.test/v1", "key": "sk-k",
     "resp": _ok(["gpt-4o", "gpt-4o", "openai/gpt-5.5"])},
]

_DISCOVER_FAIL: list[dict[str, Any]] = [
    {"name": "http-500", "resp": lambda _r: httpx.Response(500, text="boom")},
    {"name": "http-401", "resp": lambda _r: httpx.Response(401, json={"e": 1})},
]


async def _discover_rows() -> list[dict[str, Any]]:
    rows = []
    for case in _DISCOVER:
        _SEEN.clear()
        _NEXT[0] = case["resp"]
        cat = ModelCatalog()
        live = await cat.discover(case["base"], case["key"])
        rows.append({
            "name": case["name"], "base": case["base"], "key": case["key"],
            "live": live, "seen": list(_SEEN), "notes": list(cat.notes),
            "names": cat.names(), "by_capability": cat.by_capability(),
            "describe": cat.describe(),
            # 过滤之后再选一次 —— _ensure_catalog 存在的全部理由就是这一步
            "select_vision": [c.name for c in cat.select({C.VISION})],
        })
    return rows


async def _discover_fail_rows() -> list[dict[str, Any]]:
    rows = []
    for case in _DISCOVER_FAIL:
        _SEEN.clear()
        _NEXT[0] = case["resp"]
        cat = ModelCatalog()
        try:
            await cat.discover("http://gw.test/v1", "sk-k")
        except Exception as exc:  # noqa: BLE001 — 就是要记下抛了什么
            rows.append({"name": case["name"], "exc": type(exc).__name__,
                         "notes": list(cat.notes), "names_intact": cat.names()})
        else:  # pragma: no cover
            raise SystemExit(f"{case['name']} 没抛错，用例失效")
    return rows


# ══════════════════════════════════════════════════════════════════
#  SmartGateway：候选切换、失败学习、key 的那个 pop
# ══════════════════════════════════════════════════════════════════
class _FakeGW:
    """只实现 SmartGateway 用到的那一个方法。行为按模型名配置。"""

    def __init__(self, behavior: dict[str, str]) -> None:
        self.behavior = behavior
        self.calls: list[dict[str, Any]] = []

    async def call(self, node_id: str, prompt: str, **kw: Any) -> Any:
        spec = kw.get("model")
        name = spec.name if spec is not None else ""
        self.calls.append({
            "node": node_id, "prompt": prompt, "model": name,
            # key 一定被显式传（f-string 或 None），所以直接记它的值
            "key": kw.get("key", "<absent>"),
            "rest": {k: v for k, v in sorted(kw.items()) if k not in ("model", "key")},
            "effort": spec.effort if spec is not None else None,
        })
        why = self.behavior.get(name, "")
        if why:
            raise RuntimeError(why)
        return f"completion:{name}"


_SMART: list[dict[str, Any]] = [
    {"name": "first-wins", "needs": ["vision", "structured"], "behavior": {},
     "kw": {}, "prefer": "quality", "max_candidates": 3, "prefer_models": []},
    # 第一个说自己不能读图 → 抹掉能力、切下一个
    {"name": "vision-denied-then-ok", "needs": ["vision", "structured"],
     "behavior": {"anthropic/claude-opus-4.8":
                  "No endpoints found that support image input"},
     "kw": {}, "prefer": "quality", "max_candidates": 3, "prefer_models": []},
    # 全挂：聚合成一条 ModelError。第二条超长 —— 钉 errors 里的 [:150] 与
    # trace 里的 [:200] 两个不同的截断点。第三条是中文 + emoji：按 code point 切。
    {"name": "all-fail", "needs": ["vision"], "behavior": {
        "anthropic/claude-opus-4.8": "boom-1",
        "openai/gpt-5.5": "boom-2 " + "x" * 400,
        "google/gemini-3.1-pro-preview": "网关炸了🙃" * 60},
     "kw": {}, "prefer": "quality", "max_candidates": 3, "prefer_models": []},
    # prefer_models 的第一个挂掉 → 落到 head 之后拼上来的通用候选
    {"name": "prefer-models-head-fails", "needs": ["vision"], "behavior": {
        "google/gemini-3.5-flash": "boom-flash"},
     "kw": {}, "prefer": "quality", "max_candidates": 2,
     "prefer_models": ["google/gemini-3.5-flash", "openai/gpt-5.5"]},
    # prefer_models 顶到前面，且不满足能力的会被剔掉；不在目录里的自动跳过
    {"name": "prefer-models", "needs": ["vision"], "behavior": {},
     "kw": {}, "prefer": "quality", "max_candidates": 3,
     "prefer_models": ["google/gemini-3.5-flash", "deepseek/deepseek-v3.2",
                       "nope/never", "anthropic/claude-opus-4.8"]},
    # key 的 pop：只有第 0 个候选拿得到 "ocr:p1:0"，之后一律 None
    {"name": "key-popped-after-first", "needs": ["vision"],
     "behavior": {"anthropic/claude-opus-4.8": "boom", "openai/gpt-5.5": "boom"},
     "kw": {"key": "ocr:p1", "max_tokens": 8000}, "prefer": "quality",
     "max_candidates": 3, "prefer_models": []},
    # 不传 key：那一支给 None，且 kw 里也不会多出 key
    {"name": "no-key", "needs": ["cheap"], "behavior": {},
     "kw": {"system": "s"}, "prefer": "cost", "max_candidates": 2,
     "prefer_models": []},
    # 目录里挑不出来 → LookupError，一次网关调用都不该发生
    {"name": "lookup-error", "needs": ["vision", "effort", "cheap"],
     "behavior": {}, "kw": {}, "prefer": "quality", "max_candidates": 3,
     "prefer_models": []},
]


async def _smart_rows() -> list[dict[str, Any]]:
    rows = []
    for case in _SMART:
        gw = _FakeGW(dict(case["behavior"]))
        sg = SmartGateway(gw)
        row: dict[str, Any] = {"name": case["name"], "needs": case["needs"],
                               "kw": {k: v for k, v in sorted(case["kw"].items())},
                               "prefer": case["prefer"],
                               "max_candidates": case["max_candidates"],
                               "prefer_models": case["prefer_models"]}
        try:
            out = await sg.call("n1", "p", needs={C(n) for n in case["needs"]},
                                prefer=case["prefer"],
                                max_candidates=case["max_candidates"],
                                prefer_models=tuple(case["prefer_models"]),
                                **dict(case["kw"]))
        except Exception as exc:  # noqa: BLE001 — 异常本身就是要钉的东西
            row["exc"] = type(exc).__name__
            row["error"] = str(exc)
            row["out"] = None
        else:
            row["exc"] = None
            row["out"] = out
        row["calls"] = gw.calls
        row["report"] = sg.report()
        rows.append(row)
    return rows


def main() -> None:
    httpx.AsyncClient = _PatchedClient  # type: ignore[misc]
    try:
        discover = asyncio.run(_discover_rows())
        discover_fail = asyncio.run(_discover_fail_rows())
    finally:
        httpx.AsyncClient = _REAL_CLIENT  # type: ignore[misc]

    default = ModelCatalog()
    out: dict[str, Any] = {
        "capability_values": [str(c) for c in Capability],
        "cards": [_card(c) for c in CARDS],
        "default_catalog": {
            "names": default.names(),
            "describe": default.describe(),
            "by_capability": default.by_capability(),
            # `cards or CARDS`：空列表是假值，落回内置目录
            "empty_list_falls_back": ModelCatalog([]).names(),
            "one_card": ModelCatalog([CARDS[0]]).names(),
            "get_missing": default.get("nope/never"),
        },
        "denial_capability": [
            {"text": t, "out": (lambda c: str(c) if c is not None else None)(
                denial_capability(t))} for t in _DENIALS],
        "is_chat_model": [{"name": n, "out": is_chat_model(n)} for n in _NAMES],
        "infer_capabilities": [
            {"name": n, "out": sorted(str(c) for c in infer_capabilities(n))}
            for n in _NAMES],
        "card_from_name": [{"name": n, **_card(card_from_name(n))} for n in _NAMES],
        "select": _select_rows(),
        "require_error": _require_rows(),
        "record_denial": _denial_walk(),
        "discover": discover,
        "discover_fail": discover_fail,
        "smart": asyncio.run(_smart_rows()),
    }

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "catalog.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}  {dst.stat().st_size} B")


if __name__ == "__main__":
    main()
