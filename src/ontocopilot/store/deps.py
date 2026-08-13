"""FastAPI 接线 —— 路由怎么拿到仓储。

**依赖注入，不是全局池。** 具体说：引擎是模块级单例（连接池本来就该是进程级的），
但路由拿到的是 ``Depends(get_repo)`` 的产物。差别只在一件事上，而这件事是决定性的：
``app.dependency_overrides[get_repo]`` 能在测试里把整条数据库路径换掉，
而 ``from .store import POOL`` 换不掉。254 个测试一个库都不连的前提，
就靠这一层。

**为什么不用 ``Depends`` 注入一个 connection 而是注入 repo**：
路由里管理连接生命周期意味着每个路由都要背一遍 begin/commit 的纪律，
而这个服务里 ``_run_pipeline`` 是 ``asyncio.create_task`` 起的后台任务
（server.py:255）—— 它压根不在请求作用域里，拿不到请求级连接。
两条路径用同一个 repo 对象、各自开事务，才不会出现"后台任务用了一个
早已被请求结束时归还的连接"。

server.py 的改法（示意，替换现在直接摸 SESSIONS 的地方）::

    from .store.deps import get_repo, lifespan
    from .store.repo import Repo, SessionRow

    app = FastAPI(title="OntoCopilot", version="0.1.0", lifespan=lifespan)

    @app.get("/api/sessions")
    async def list_sessions(repo: Repo = Depends(get_repo)) -> list[dict]:
        rows = await repo.list_sessions()
        return [r.brief() for r in rows]

    @app.post("/api/sessions")
    async def create_session(body: dict | None = None,
                             repo: Repo = Depends(get_repo)) -> dict:
        body = body or {}
        row = SessionRow(id=uuid.uuid4().hex[:12],
                         title=body.get("title") or "新的本体梳理",
                         project=body.get("project", ""))
        (WORKSPACE / row.id).mkdir(parents=True, exist_ok=True)
        await repo.create_session(row)
        return row.brief()
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .engine import Store, database_url
from .repo import Repo, build_repo

#: 进程级单例。连接池就该是进程级的 —— 每请求建池会把 Postgres 的
#: max_connections 打爆。
_store: Store | None = None
_repo: Repo | None = None


def workspace_root() -> Path:
    """材料与产物的落盘根。

    容器里挂在 /data/workspace，宿主机上还是 ./workspace ——
    所以 session_file 存的必须是**相对路径**，绝对路径换个环境就失效
    （现状 server.py:187 存的是 ``str(dest)``）。
    """
    return Path(os.getenv("ONTOCOPILOT_WORKSPACE", "workspace"))


@asynccontextmanager
async def lifespan(app: Any) -> AsyncIterator[None]:
    """替换现在的 ``@app.on_event("startup")``（server.py:903-905）。

    做三件事：建 workspace 根、选路（库/内存）、把选路结果讲清楚。
    **不在这里跑迁移** —— 迁移是独立的一次性任务（compose 里的 migrate 服务）。
    应用进程自己迁移的话，滚动发布时 N 个副本会同时改 schema。
    """
    global _store, _repo
    root = workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    url = database_url()

    if not url:
        # 没配 DATABASE_URL **不该等于丢数据**。这是个本地工具，一个 SQLite
        # 文件就够了，零配置。"默认丢失、要配置才保存"是把运维负担摊给用户，
        # 而他多半到重启那一刻才发现。
        #
        # 真要纯内存（跑测试、临时试用）用 ONTOCOPILOT_NO_DB=1 显式关掉。
        if os.getenv("ONTOCOPILOT_NO_DB"):
            _store = await Store.open("")
            _repo = build_repo(_store)
            print("[store] ONTOCOPILOT_NO_DB=1 → 纯内存，重启即丢")
            try:
                yield
            finally:
                await _store.close()
                _store, _repo = None, None
            return
        url = f"sqlite+aiosqlite:///{(root / 'ontocopilot.db').resolve()}"
        # SQLite 走 create_all：它没有滚动发布，也没有多副本同时改 schema
        # 的问题，单独维护一套迁移不值得。基础依赖已包含驱动；若这里仍失败，
        # 必须 fail closed。静默换成易失内存会把启动故障伪装成数小时后的数据丢失。
        try:
            _store = await Store.open(url, create_all=True)
        except Exception as exc:  # 转成包含落盘路径的可诊断错误
            raise RuntimeError(
                f"本地 SQLite 无法启动（{root / 'ontocopilot.db'}）："
                f"{type(exc).__name__}: {exc}。若确需临时内存模式，请显式设置 "
                "ONTOCOPILOT_NO_DB=1。"
            ) from exc
        print(f"[store] 本地 SQLite → {root / 'ontocopilot.db'}")
        _repo = build_repo(_store)
    else:
        # 显式 DATABASE_URL 也允许指向 SQLite（本地开发、桌面部署和测试常用）。
        # 一个全新的 SQLite 文件与零配置路径应有相同的建表语义；否则连接本身
        # healthcheck 会成功，随后应用第一次读取 app_setting 才以“no such table”
        # 崩溃。PostgreSQL 仍只走独立迁移，绝不由应用副本 create_all。
        _store = await Store.open(url, create_all=url.startswith("sqlite"))
        _repo = build_repo(_store)

    if _store.enabled:
        health = await _store.healthcheck()
        if not health["ok"]:
            # **显式配了** DATABASE_URL 却连不上 → 直接失败，不偷偷回落到内存。
            # 和 llm_config() 拒绝静默换端点是同一条纪律：用户指定了一个后端，
            # 我们换了另一个而不告诉他，是最难查的一类问题。
            if database_url():
                raise RuntimeError(f"DATABASE_URL 已配置但连不上：{health['error']}")
            print(f"[store] 本地库异常：{health.get('error')}")
    try:
        yield
    finally:
        await _store.close()
        _store, _repo = None, None


def get_repo() -> Repo:
    """FastAPI 依赖。测试里用 ``app.dependency_overrides[get_repo]`` 换掉。"""
    if _repo is None:
        raise RuntimeError("仓储未初始化 —— app 的 lifespan 没跑起来")
    return _repo


def get_store() -> Store:
    if _store is None:
        raise RuntimeError("Store 未初始化")
    return _store


def set_repo_for_tests(repo: Repo | None) -> None:
    """给不走 ASGI 的单元测试用。走 HTTP 的一律用 dependency_overrides。"""
    global _repo
    _repo = repo


__all__ = ["get_repo", "get_store", "lifespan", "set_repo_for_tests", "workspace_root"]
