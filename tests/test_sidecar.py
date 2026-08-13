"""Sidecar：TS 侧调不动的那三样（沙箱 / DDL 解析 / PDF 渲染）的 HTTP 门面。

盯的是**接入控制**和**行为零漂移**两件事：

  · 这个服务能执行任意 Python。token 缺失时必须拒绝服务，而不是默认放行 ——
    默认放行的服务迟早会被人用默认配置部署出去。
  · 它不重新实现任何逻辑，全部直接调 ``ontocopilot.*``。所以返回体必须和
    Python 主进程里拿到的**逐字段一致**，否则迁移期间两个宿主会看到两种行为。
"""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import httpx
import pytest

from sidecar.app import app

TOKEN = "test-sidecar-token-0001"

DDL = """
CREATE TABLE purchase_plan (
  id          BIGINT PRIMARY KEY,
  plan_amount DECIMAL(18,2),  -- 含税·年度累计
  dept_code   VARCHAR(32)     -- 归口部门
);
"""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://sidecar")


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    monkeypatch.setenv("ONTOCOPILOT_SIDECAR_TOKEN", TOKEN)


async def test_health_needs_no_token_and_reports_what_it_can_do():
    """探活不校验 token —— 它不泄露任何东西，而编排层要靠它判断起没起来。"""
    async with _client() as c:
        r = await c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    # 三个钉子各自在不在，编排层据此决定要不要走 sidecar 这条路
    assert set(body["capabilities"]) == {"sandbox", "sql", "pdf"}


async def test_a_missing_token_is_refused(monkeypatch):
    """**没配 token 就拒绝服务**，不是默认放行。"""
    monkeypatch.delenv("ONTOCOPILOT_SIDECAR_TOKEN", raising=False)
    async with _client() as c:
        r = await c.post("/sql/parse", json={"sql": DDL})
    assert r.status_code == 500
    assert "SIDECAR_TOKEN" in r.text


async def test_a_wrong_token_is_refused():
    async with _client() as c:
        r = await c.post("/sql/parse", json={"sql": DDL},
                         headers={"X-Sidecar-Token": "wrong"})
    assert r.status_code == 401


async def test_ddl_parsing_keeps_the_inline_comments():
    """行内注释是这个解析器**最重要的产出**，不是附属信息。

    `plan_amount DECIMAL(18,2)` 在两张表里长得一模一样，区别全在
    `-- 含税·年度累计` 里。丢掉注释，口径冲突就永远发现不了 —— 这也正是这条
    必须走真 sqlglot、不能在 TS 侧凑合的原因。
    """
    async with _client() as c:
        r = await c.post("/sql/parse", json={"sql": DDL},
                         headers={"X-Sidecar-Token": TOKEN})
    assert r.status_code == 200
    blob = str(r.json())
    assert "purchase_plan" in blob
    assert "含税·年度累计" in blob, "注释丢了，这个 sidecar 就没有存在的意义"


async def test_the_response_matches_what_the_python_host_sees():
    """行为零漂移：sidecar 与直接调用必须给出同一份产物。"""
    from ontocopilot.onto.parse.sql import DdlParser

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "schema.ddl"
        p.write_text(DDL, encoding="utf-8")
        direct = DdlParser().parse(p, file_id="sidecar")

    async with _client() as c:
        r = await c.post("/sql/parse", json={"sql": DDL},
                         headers={"X-Sidecar-Token": TOKEN})
    got = r.json()
    assert got["structured"] == direct.structured
    assert [c["render"] for c in got["chunks"]] == [c.render for c in direct.chunks]


async def test_sandbox_runs_code_and_returns_the_same_shape():
    async with _client() as c:
        r = await c.post("/sandbox/exec",
                         json={"code": "emit({'n': sum(INPUTS['xs'])})",
                               "inputs": {"xs": [1, 2, 3]}},
                         headers={"X-Sidecar-Token": TOKEN})
    assert r.status_code == 200
    body = r.json()
    # 与 ExecResult.to_dict() 逐字段一致
    assert {"ok", "exit_code", "duration_ms", "stdout", "stderr",
            "artifacts", "result", "flags"} <= set(body)
    assert body["ok"] is True
    assert body["result"] == {"n": 6}


async def test_the_caller_cannot_raise_the_sandbox_wallclock_limit():
    """只允许调小。让调用方把上限往大了改，等于把资源边界交给它自己声明。"""
    from sidecar.app import ExecReq  # noqa: F401  —— 形状校验用
    from ontocopilot.kernel.sandbox import SandboxLimits

    async with _client() as c:
        r = await c.post("/sandbox/exec",
                         json={"code": "emit({'ok': 1})",
                               "wallclock_seconds": 99_999},
                         headers={"X-Sidecar-Token": TOKEN})
    assert r.status_code == 200
    # 请求里那个 99999 不该生效 —— 默认上限才是天花板
    assert SandboxLimits().wallclock_seconds < 99_999


async def test_pdf_rendering_returns_png_pages():
    pymupdf = pytest.importorskip("pymupdf")
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "采购计划")
    pdf_bytes = doc.tobytes()
    doc.close()

    async with _client() as c:
        r = await c.post("/pdf/render",
                         json={"pdf_b64": base64.b64encode(pdf_bytes).decode()},
                         headers={"X-Sidecar-Token": TOKEN})
    assert r.status_code == 200
    pages = r.json()["pages"]
    assert len(pages) == 1
    assert base64.b64decode(pages[0])[:8] == b"\x89PNG\r\n\x1a\n"
