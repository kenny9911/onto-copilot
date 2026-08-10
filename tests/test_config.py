"""运行时配置提供者 + 网关路由覆盖。

两条最要紧的不变式：
  1. 设置 → 环境 → 抛错 的优先级，且**永不静默降级**。
  2. 覆盖某档模型时 effort 由能力**服务端派生** —— 不支持 effort 的模型必须置
     None，否则后端把 effort 发给网关会直接 400。
"""

from __future__ import annotations

import pytest

from ontocopilot import appconfig
from ontocopilot.kernel.catalog import ModelCatalog
from ontocopilot.kernel.dag import Difficulty
from ontocopilot.kernel.llm import gateway_routing
from ontocopilot.store.repo import MemoryRepo


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    appconfig._CACHE = {}
    for var in ("CUSTOM_LLM_BASE_URL", "CUSTOM_LLM_API_KEY",
                "ONTOCOPILOT_USD_CAP", "ONTOCOPILOT_CHAT_USD_CAP"):
        monkeypatch.delenv(var, raising=False)
    yield
    appconfig._CACHE = {}


async def test_resolved_config_prefers_setting_over_env(monkeypatch):
    monkeypatch.setenv("CUSTOM_LLM_BASE_URL", "http://env:3010/v1")
    monkeypatch.setenv("CUSTOM_LLM_API_KEY", "sk-env")
    cfg = appconfig.resolved_llm_config()
    assert (cfg.base_url, cfg.api_key) == ("http://env:3010/v1", "sk-env")

    repo = MemoryRepo()
    await appconfig.apply(repo, {appconfig.GATEWAY_BASE_URL: "http://db:3010/v1/",
                                 appconfig.GATEWAY_API_KEY: "sk-db"})
    cfg = appconfig.resolved_llm_config()
    assert (cfg.base_url, cfg.api_key) == ("http://db:3010/v1", "sk-db")   # 末尾 / 去掉


def test_resolved_config_raises_when_missing():
    with pytest.raises(RuntimeError):
        appconfig.resolved_llm_config()      # 不静默降级，直接抛


async def test_budget_caps_precedence(monkeypatch):
    assert (appconfig.usd_cap(), appconfig.chat_usd_cap()) == (15.0, 3.0)   # 默认
    monkeypatch.setenv("ONTOCOPILOT_USD_CAP", "20")
    assert appconfig.usd_cap() == 20.0
    repo = MemoryRepo()
    await appconfig.apply(repo, {appconfig.BUDGET_USD_CAP: 8.5})
    assert appconfig.usd_cap() == 8.5        # 设置压过环境


async def test_model_overrides_reflects_settings():
    assert appconfig.model_overrides() == {}
    repo = MemoryRepo()
    await appconfig.apply(repo, {"gateway.model.high": "google/gemini-3.5-flash"})
    assert appconfig.model_overrides() == {"high": "google/gemini-3.5-flash"}


def test_default_routing_effort_by_tier():
    r = gateway_routing()
    assert r.model_for(Difficulty.LOW).effort is None        # flash 不支持 effort
    assert r.model_for(Difficulty.HIGH).effort == "high"     # sonnet
    assert r.model_for(Difficulty.CRITICAL).effort == "xhigh"


def test_override_derives_effort_none_for_effortless_model():
    cat = ModelCatalog()
    r = gateway_routing({"high": "google/gemini-3.5-flash"}, cat)
    spec = r.model_for(Difficulty.HIGH)
    assert spec.name == "google/gemini-3.5-flash"
    assert spec.effort is None               # 关键：否则会 400


def test_override_keeps_tier_effort_for_capable_model():
    cat = ModelCatalog()
    r = gateway_routing({"high": "openai/gpt-5.5"}, cat)      # gpt-5.5 目录里带 EFFORT
    assert r.model_for(Difficulty.HIGH).effort == "high"
    # LOW 档意图 effort 是 None，即便模型支持也不下发（保持便宜档语义）
    r2 = gateway_routing({"low": "openai/gpt-5.5"}, cat)
    assert r2.model_for(Difficulty.LOW).effort is None


def test_override_keeps_heterogeneous_judge():
    cat = ModelCatalog()
    # 即便某档设成与某评委同名的模型，judge_for 仍给得出异构评委。
    r = gateway_routing({"high": "openai/gpt-5.5"}, cat)
    gen = r.model_for(Difficulty.HIGH)
    assert r.judge_for(gen).name != gen.name


def test_unknown_override_model_is_safe():
    # 目录里没有的模型名 → 保守派生（无 effort），不抛。
    r = gateway_routing({"high": "some/unknown-model"}, ModelCatalog())
    spec = r.model_for(Difficulty.HIGH)
    assert spec.name == "some/unknown-model" and spec.effort is None
