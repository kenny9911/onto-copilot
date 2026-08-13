"""导出 appconfig.py + configapi.py 的 golden —— 给 TS 侧当安全网。

这两个模块的值钱之处全在**边角**：`float("")` 该回默认值而不是 0（0 上限意味着
服务直接不干活）、redacted 的密钥不能被当成真值写回去、DATABASE_URL 的口令段
必须抹掉、余额查不到时那一行必须是「未知」而不是报错。这些在 TS 侧全都有一条
现成的、看起来很像却不等价的写法（`Number("")` 是 0，`new URL()` 的 password
语义和 `urlsplit` 不同），所以逐条钉住。

跑法::

    .venv/bin/python tools/golden/appconfig.py

产物 golden/appconfig.json。**字节确定**：环境变量在脚本里显式铺好再读，
不继承外部环境；不发任何网络请求（余额那条走一个必然失败的探测函数）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot import appconfig, configapi  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "golden"

#: 铺一份**完全确定**的环境。镜像里的每一项都出现，好让 env_view 的形状被钉住。
ENV = {
    "CUSTOM_LLM_BASE_URL": "https://gw.example.com/v1/",
    "CUSTOM_LLM_API_KEY": "sk-abcdefghijklmnopqrstuvwxyz",
    "DATABASE_URL": "postgresql+asyncpg://oc:s3cr3t@db.internal:5432/onto?sslmode=require",
    "ONTOCOPILOT_WORKSPACE": "/data/workspace",
    "ONTOCOPILOT_NO_DB": "",
    "ONTOCOPILOT_AUTH": "1",
    "ONTOCOPILOT_COOKIE_SECURE": "",
    "ONTOCOPILOT_SESSION_TTL_HOURS": "72",
    "ONTOCOPILOT_CORS_ORIGINS": "https://a.example.com,https://b.example.com",
    "ONTOCOPILOT_USD_CAP": "25",
    "ONTOCOPILOT_CHAT_USD_CAP": "4.5",
}

SECRETS = ["", "short", "0123456789ab", "0123456789abc", "sk-" + "x" * 40,
           "中文密钥中文密钥中文密钥中文"]

DB_URLS = [
    "",
    "postgresql+asyncpg://oc:s3cr3t@db.internal:5432/onto",
    "postgresql://oc:s3cr3t@db:5432/onto?sslmode=require#frag",
    "postgresql://oc@db:5432/onto",                       # 没有口令段
    "postgresql://oc:@db:5432/onto",                      # 空口令
    "sqlite+aiosqlite:///workspace/ontocopilot.db",       # 没有 netloc
    "postgresql://o:c:d@db/x",                            # 口令里有冒号
    "postgresql://u%40h:p%3Aw@db/x",                      # 百分号编码
    "not a url at all",
]

#: `(缓存里的值, 环境变量的值, 期望)`。空串代表"环境变量没设"。
NUM_CASES: list[tuple[Any, str]] = [
    (None, ""), (None, "25"), (None, "0"), (None, "abc"), (None, " 7.5 "),
    (None, "1e2"), (None, "inf"), (None, "1_0"), (None, "-3"),
    (5, ""), (5.5, "25"), ("8", "25"), ("", "25"), ("abc", "25"),
    (True, ""), ([], "25"), ({"a": 1}, "25"), (0, "25"),
]

OVERRIDE_CASES: list[dict[str, Any]] = [
    {},
    {"gateway.model.low": "a/b"},
    {"gateway.model.low": "", "gateway.model.high": "c/d"},
    {"gateway.model.low": 0, "gateway.model.medium": False},
    {"gateway.model.critical": 12},
    {"gateway.model.unknown_tier": "x/y"},
]

RESOLVE_CASES: list[tuple[dict[str, Any], dict[str, str]]] = [
    ({}, {}),
    ({}, {"CUSTOM_LLM_BASE_URL": "https://x/", "CUSTOM_LLM_API_KEY": "k"}),
    ({"gateway.base_url": "https://y//", "gateway.api_key": "k2"}, {}),
    ({"gateway.base_url": "https://y"}, {"CUSTOM_LLM_API_KEY": "k3"}),
    ({"gateway.api_key": "k4"}, {"CUSTOM_LLM_BASE_URL": "https://z"}),
    ({}, {"CUSTOM_LLM_BASE_URL": "https://only-base"}),
    ({"gateway.base_url": "", "gateway.api_key": ""},
     {"CUSTOM_LLM_BASE_URL": "https://env", "CUSTOM_LLM_API_KEY": "envk"}),
]


def _jsonable(x: float) -> float | str:
    import math

    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    return x


def with_env(env: dict[str, str]) -> None:
    for k in list(os.environ):
        if k.startswith(("CUSTOM_LLM", "ONTOCOPILOT_", "DATABASE_URL")):
            del os.environ[k]
    os.environ.update({k: v for k, v in env.items() if v != ""})


def set_cache(d: dict[str, Any]) -> None:
    appconfig._CACHE = dict(d)          # noqa: SLF001 —— golden 脚本，直接铺缓存


def main() -> None:
    out: dict[str, Any] = {}

    out["redact_secret"] = [[s, configapi._redact_secret(s)] for s in SECRETS]
    out["redact_db_url"] = [[u, configapi._redact_db_url(u)] for u in DB_URLS]

    nums = []
    for cached, env in NUM_CASES:
        with_env({"ONTOCOPILOT_USD_CAP": env})
        set_cache({} if cached is None else {"budget.usd_cap": cached})
        # inf / nan 不是合法 JSON（`json.dumps` 会写出裸的 Infinity，而
        # `JSON.parse` 直接抛），存成字符串；TS 侧读的时候映射回去
        nums.append({"cached": cached, "env": env,
                     "usd_cap": _jsonable(appconfig.usd_cap())})
    out["num"] = nums

    with_env({})
    set_cache({})
    out["defaults"] = {"usd_cap": appconfig.usd_cap(),
                       "chat_usd_cap": appconfig.chat_usd_cap()}

    out["model_overrides"] = [{"cache": c, "out": (set_cache(c) or appconfig.model_overrides())}
                              for c in OVERRIDE_CASES]

    resolved = []
    for cache, env in RESOLVE_CASES:
        with_env(env)
        set_cache(cache)
        try:
            cfg = appconfig.resolved_llm_config()
            got: dict[str, Any] = {"base_url": cfg.base_url, "api_key": cfg.api_key,
                                   "redacted_key": cfg.redacted_key,
                                   "insecure": cfg.insecure_transport}
        except RuntimeError as exc:
            got = {"error": str(exc)}
        resolved.append({"cache": cache, "env": env, "out": got})
    out["resolved_llm_config"] = resolved

    # ── configapi 的只读侧 ────────────────────────────────────────
    with_env(ENV)
    set_cache({})
    out["env_view"] = configapi._env_view()
    out["gateway_creds"] = list(configapi._gateway_creds())
    snap = configapi._snapshot()
    # catalog 是 ModelCatalog().describe()，TS 侧那一段还没落地 —— 单独放，
    # 让 TS 能比对其余四段而不必先有目录
    out["snapshot_catalog"] = snap.pop("catalog")
    out["snapshot"] = snap

    set_cache({"gateway.base_url": "http://insecure.example.com/",
               "gateway.api_key": "sk-in-db-1234567890"})
    snap2 = configapi._snapshot()
    snap2.pop("catalog")
    out["snapshot_from_db"] = snap2

    # 余额查不到是**常态**：探测抛异常时那一行必须是「未知」，不是报错、
    # 更不是"余额不足"（configapi.py:98 的真实事故注释）
    async def _boom(*_a: Any, **_kw: Any) -> Any:
        raise OSError("网关根本没有余额接口")

    real = configapi.gateway_balance.cached_balance
    configapi.gateway_balance.cached_balance = _boom          # type: ignore[assignment]
    try:
        out["balance_when_probe_fails"] = asyncio.run(configapi._balance_view())
    finally:
        configapi.gateway_balance.cached_balance = real       # type: ignore[assignment]

    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / "appconfig.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8")
    print(f"wrote {p} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
