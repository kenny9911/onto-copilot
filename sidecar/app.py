"""Python sidecar —— TS 侧调不动的那三样东西。

迁移盘点认定三个「钉子」在 JS 生态里没有可接受的对等物：

  * **sandbox** —— ``code.exec`` 存在的理由就是让模型写 pandas 做数据变换
    （ADR-2：数据变换走 CodeAct）。把宿主换成 TS **不消除** Python 依赖，
    只是多一道语言边界。所以沙箱必须留在 Python。
  * **sqlglot** —— 解析客户给的 DDL，支持二十来种方言。JS 侧 ``node-sql-parser``
    方言覆盖明显更弱，``pgsql-ast-parser`` 只有 Postgres。而客户的 schema.ddl
    是从哪个库导出来的**事先不知道** —— 那正是要用 sqlglot 的原因。
  * **pymupdf** —— PDF 渲染成图给视觉模型。

关键判断：**沙箱本来就必须是 Python，所以 sidecar 跑不掉**；那另外两个搭车几乎
免费。三个钉子于是塌缩成一个进程。

这里**不重新实现任何逻辑** —— 全部直接调 ``ontocopilot.*`` 的现成模块。行为零漂移
是这个设计最重要的性质：迁移期间同一份代码同时服务 Python 主进程和 TS 主进程。

## 安全

这个服务能**执行任意 Python 代码**。两道门，缺一不可：

  1. 只监听 127.0.0.1（``serve()`` 里写死，不给参数）；
  2. 每个请求要带 ``X-Sidecar-Token``，值来自 ``ONTOCOPILOT_SIDECAR_TOKEN``。
     环境变量没设就**拒绝启动** —— 默认放行的服务迟早会被人用默认配置部署出去。

沙箱自身的隔离（子进程、资源限制、静态扫描）仍由 ``kernel.sandbox`` 负责；
这一层只做接入控制。
"""

from __future__ import annotations

import base64
import hmac
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

app = FastAPI(title="OntoCopilot sidecar", docs_url=None, redoc_url=None)

_TOKEN_ENV = "ONTOCOPILOT_SIDECAR_TOKEN"


def _check(token: str | None) -> None:
    want = os.getenv(_TOKEN_ENV) or ""
    if not want:
        # 起不来好过默认放行。这个服务能执行任意代码，没有"开发模式随便用"的余地。
        raise HTTPException(500, f"{_TOKEN_ENV} 未设置，sidecar 拒绝服务")
    # 定长比较：token 校验的耗时不该泄露前缀正确了几位
    if not token or not hmac.compare_digest(token, want):
        raise HTTPException(401, "sidecar token 不匹配")


@app.get("/health")
async def health() -> dict[str, Any]:
    """探活。**不校验 token** —— 它不泄露任何东西，而编排层要靠它判断起没起来。"""
    import importlib.util

    return {
        "ok": True,
        "capabilities": {
            name: importlib.util.find_spec(mod) is not None
            for name, mod in (("sandbox", "ontocopilot.kernel.sandbox"),
                              ("sql", "sqlglot"), ("pdf", "pymupdf"))
        },
    }


# ══════════════════════════════════════════════════════════════════
#  1. 沙箱
# ══════════════════════════════════════════════════════════════════
class ExecReq(BaseModel):
    code: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    #: 覆盖 SandboxLimits 的墙钟上限。**只允许调小** —— 让调用方把上限往大了改，
    #: 等于把沙箱的资源边界交给它自己声明。
    wallclock_seconds: int | None = None


@app.post("/sandbox/exec")
async def sandbox_exec(req: ExecReq,
                       x_sidecar_token: str | None = Header(default=None)) -> dict[str, Any]:
    """跑一段 Python。返回体与 ``ExecResult.to_dict()`` **逐字段一致**。

    直接复用 ``kernel.sandbox`` —— 静态扫描、子进程隔离、资源限制、产物回收
    全在那边，这里一行都不重写。
    """
    _check(x_sidecar_token)
    from ontocopilot.kernel.sandbox import LocalSubprocessSandbox, SandboxLimits

    limits = SandboxLimits()
    if req.wallclock_seconds is not None:
        limits = SandboxLimits(
            cpu_seconds=limits.cpu_seconds,
            wallclock_seconds=min(limits.wallclock_seconds, max(1, req.wallclock_seconds)),
            memory_mb=limits.memory_mb, max_output_bytes=limits.max_output_bytes,
            max_out_dir_mb=limits.max_out_dir_mb, network=limits.network)
    sandbox = LocalSubprocessSandbox(limits)
    res = await sandbox.exec(req.code, inputs=req.inputs)
    return res.to_dict()


# ══════════════════════════════════════════════════════════════════
#  2. DDL 解析
# ══════════════════════════════════════════════════════════════════
class SqlReq(BaseModel):
    sql: str
    dialect: str = ""
    file_name: str = "schema.ddl"


@app.post("/sql/parse")
async def sql_parse(req: SqlReq,
                    x_sidecar_token: str | None = Header(default=None)) -> dict[str, Any]:
    """解析 DDL，返回 ``ParsedDoc`` 的 dict 形态。

    **行内注释是这个解析器最重要的产出**，不是附属信息：``plan_amount
    DECIMAL(18,2)`` 在两张表里长得一模一样，区别全在 ``-- 含税·年度累计`` 和
    ``-- 不含税·单次`` 里。丢掉注释，口径冲突永远发现不了 —— 所以这条必须走
    真的 sqlglot，不能在 TS 侧凑合。
    """
    _check(x_sidecar_token)
    from ontocopilot.onto.parse.sql import DdlParser

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / req.file_name
        p.write_text(req.sql, encoding="utf-8")
        doc = DdlParser(dialect=req.dialect or None).parse(p, file_id="sidecar")
    return {
        "file_id": doc.file_id, "file_name": doc.file_name, "kind": doc.kind,
        "structured": doc.structured,
        "chunks": [{"chunk_id": c.chunk_id, "locator": c.locator, "render": c.render,
                    "raw": c.raw, "order": c.order, "tags": c.tags} for c in doc.chunks],
        "findings": [{"kind": f.kind, "message": f.message, "locator": f.locator,
                      "severity": f.severity} for f in doc.findings],
    }


# ══════════════════════════════════════════════════════════════════
#  3. PDF → 图
# ══════════════════════════════════════════════════════════════════
class PdfReq(BaseModel):
    #: base64 的 PDF 字节。走 body 而不是路径 —— TS 主进程和 sidecar 未必共享文件系统
    pdf_b64: str
    max_pages: int = 20
    zoom: float = 2.0


@app.post("/pdf/render")
async def pdf_render(req: PdfReq,
                     x_sidecar_token: str | None = Header(default=None)) -> dict[str, Any]:
    """把 PDF 每页渲染成 PNG（base64）。"""
    _check(x_sidecar_token)
    # 用 pymupdf 而不是 vision.py 里那个 `import fitz`：fitz 这个别名已经被上游
    # 标记弃用（导入时会打 warning），新代码没有理由再往上贴。
    import pymupdf

    data = base64.b64decode(req.pdf_b64)
    pages: list[str] = []
    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        total = pdf.page_count          # 必须在 with 里取 —— 出了块文档就关了
        for i, page in enumerate(pdf):
            if i >= req.max_pages:
                break
            pix = page.get_pixmap(matrix=pymupdf.Matrix(req.zoom, req.zoom))
            pages.append(base64.b64encode(pix.tobytes("png")).decode("ascii"))
    return {"pages": pages, "truncated": len(pages) < total}


def serve() -> None:
    """只监听回环。**不给 host 参数** —— 能执行任意代码的服务不该有对外监听的开关。"""
    import uvicorn

    if not os.getenv(_TOKEN_ENV):
        raise SystemExit(f"必须先设置 {_TOKEN_ENV}（sidecar 能执行任意代码）")
    # 8712 而不是 871：<1024 是特权端口，非 root 起不来 —— 一个只监听回环的
    # 辅助进程没有任何理由要 root。
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("ONTOCOPILOT_SIDECAR_PORT", "8712")))


if __name__ == "__main__":
    serve()
