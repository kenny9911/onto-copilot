"""HTTP 服务 —— FastAPI + SSE。

事件流是内核事件日志的**投影**，不是另一套埋点。所以前端上看到的推理轨迹与
事后重放、审计看到的是同一份数据 —— 两套埋点必然会漂移，而漂移的那天你不会
知道该信哪个。

::

    uvicorn ontocopilot.server:app --port 8000
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from . import __version__, appconfig, authgate, configapi
from .kernel.agents import default_agents
from .kernel.backends import OpenAICompatBackend
from .kernel.budget import Budget
from .kernel.bus.bus import AgentBus
from .kernel.catalog import ModelCatalog, SmartGateway
from .kernel.critic import CriticPanel
from .kernel.dag import Difficulty
from .kernel.events import EventKind
from .kernel.ids import fingerprint, sha256_hex
from .kernel.intent import Intent, RuleIntentParser
from .kernel.journal import FileBlobStore, FileJournal
from .kernel.llm import ModelGateway, gateway_routing
from .kernel.loop import AgentLoop
from .kernel.memory.context import ContextManager
from .kernel.memory.dialogue import (
    Decision,
    DecisionKind,
    DialogueMemory,
    Speaker,
)
from .kernel.recorder import Recorder
from .kernel.sandbox import default_sandbox
from .kernel.scheduler import RunStatus, Scheduler
from .kernel.skills import default_library
from .kernel.tools import Danger, builtin_registry
from .onto.audit import ReturnAuditor, read_returned
from .onto.clarify import apply_decision
from .onto.converse import ConversationAgent
from .onto.oir import oir_from_dict
from .onto.parse import (
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)
from .onto.pipeline import (
    CoverageCritic,
    build_dag,
    build_oir,
    finish,
    handlers_for,
    provenance_critic,
    segment_corpus,
)
from .onto.prompts import followup_prompts, opening_prompts
from .onto.questions import (
    Decision as QuestionDecision,
)
from .onto.questions import (
    IdempotencyConflict,
    PatchSet,
    Question,
    QuestionBacklog,
    QuestionPriority,
    QuestionStatus,
    QuestionTransitionError,
    Revision,
    RevisionConflict,
    RevisionStatus,
    build_question_backlog,
)
from .onto.suggest import apply_suggestion
from .onto.template import TemplateSpec, compile_template, write_xlsx
from .session_events import SESSION_EVENTS
from .store.deps import get_repo, get_store, workspace_root
from .store.deps import lifespan as store_lifespan
from .store.repo import (
    DecisionRecordRow,
    FileRow,
    QuestionRow,
    RevisionRow,
    SessionRow,
    UsageRow,
)

# 与 store 使用同一份配置源。模块级初值覆盖普通 env 启动；lifespan 在加载
# ``.env`` 后还会刷新一次，避免数据库落在配置目录、材料却落在 cwd/workspace。
ROOT = workspace_root()
_WORKER_ID = f"worker-{uuid.uuid4().hex}"


def _configured_build_lease_ttl() -> float:
    """Return a bounded lease TTL without making a bad env value break import."""
    try:
        return max(5.0, float(os.getenv("ONTOCOPILOT_BUILD_LEASE_TTL", "30")))
    except ValueError:
        return 30.0


def _configured_chat_lease_ttl() -> float:
    """Keep chat takeover configurable and bounded like build execution leases."""
    try:
        return max(5.0, float(os.getenv("ONTOCOPILOT_CHAT_LEASE_TTL", "30")))
    except ValueError:
        return 30.0


def _configured_mutation_lease_ttl() -> float:
    try:
        return max(5.0, float(os.getenv("ONTOCOPILOT_MUTATION_LEASE_TTL", "30")))
    except ValueError:
        return 30.0


_BUILD_LEASE_TTL = _configured_build_lease_ttl()
_BUILD_HEARTBEAT_INTERVAL = min(_BUILD_LEASE_TTL / 3, 10.0)
_CHAT_LEASE_TTL = _configured_chat_lease_ttl()
_CHAT_HEARTBEAT_INTERVAL = min(_CHAT_LEASE_TTL / 3, 5.0)
_MUTATION_LEASE_TTL = _configured_mutation_lease_ttl()
_MUTATION_HEARTBEAT_INTERVAL = min(_MUTATION_LEASE_TTL / 3, 5.0)
_SOURCE_UI = Path(__file__).resolve().parents[2] / "ui"
_PACKAGED_UI = Path(__file__).resolve().parent / "ui"
# 源码开发与 wheel 安装使用不同位置；选择真实存在的完整工作台。
UI = _SOURCE_UI if (_SOURCE_UI / "index.html").exists() else _PACKAGED_UI


# ══════════════════════════════════════════════════════════════════
#  会话
# ══════════════════════════════════════════════════════════════════
@dataclass
class Session:
    """一次建模会话。

    状态全部落在磁盘上（``workspace/<id>/``），内存里只放句柄 —— 这样进程重启
    后产物还在，事件日志也还能重放。
    """

    id: str
    title: str = "新建会话"
    project: str = ""
    created: float = field(default_factory=time.time)
    files: list[dict[str, Any]] = field(default_factory=list)
    status: str = "idle"  # idle | parsing | extracting | awaiting_answer | done | failed | stopped
    #: SSE 订阅者的队列。断线重连时按 seq 补发，见 /stream。
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    state: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    #: 最近一次装入/写入的 durable projection 版本。多 worker 的 Session 缓存
    # 不是事实源；chat 抢到仓储租约后用它判断是否必须先刷新再执行下一轮。
    state_version: int = 0
    #: 当前请求选的界面语言（zh/en）。请求时捕获，供**后台管线**读取 —— 管线跑在
    #  非请求作用域、读不到 cookie/请求，只能靠 Session 传递（与鉴权/配置同一套手法）。
    lang: str = "zh"
    #: 归属账号 id（app_user.id），与库里的 session.owner 一致。用量流水要按账号
    #  记，而记账发生在**非请求作用域**的后台管线里 —— 和 lang 同一个理由。
    owner: str = ""
    #: 正在跑的对话轮 / 梳理任务的句柄 —— 停止按钮据此 cancel。运行时对象，**不落库**。
    chat_task: asyncio.Task | None = field(default=None, repr=False, compare=False)
    run_task: asyncio.Task | None = field(default=None, repr=False, compare=False)
    #: 每次 build 独有的 lease token。不能只用进程 id：同一 worker 停掉旧任务后
    # 立刻重跑时，旧任务的 finally 否则会误删新任务的 lease（ABA）。
    build_lease_owner: str = field(default="", repr=False, compare=False)
    #: Question/Audit/chat structural edits share one durable cross-worker lease.
    #: The token is invocation-scoped and is never persisted in session_state.
    mutation_lease_owner: str = field(default="", repr=False, compare=False)
    #: Question/Decision 并发锁。Decision claim 在 repo 内是原子的；这把锁
    # 还将 OIR 回写、Question 转态、Revision 发号收口为一个进程内临界区。
    question_lock: asyncio.Lock = field(default_factory=asyncio.Lock,
                                        repr=False, compare=False)
    #: build 的“检查状态 → 占位 → 创建任务”必须原子。否则同一 event loop
    #: 两个并发 POST 都可能在后台任务真正把状态改成 parsing 前越过检查。
    build_lock: asyncio.Lock = field(default_factory=asyncio.Lock,
                                     repr=False, compare=False)

    @property
    def dir(self) -> Path:
        return ROOT / self.id

    def emit(self, kind: str, /, **payload: Any) -> dict[str, Any]:
        """发一条事件。

        ``kind`` 是**位置限定**参数（``/``）：payload 里带 ``kind`` 字段是很自然的
        写法（冲突类型、产物类型都叫 kind），不限定就会和这个形参撞名报错。
        payload 里的同名字段会覆盖事件类型，所以下面把它放在展开之前。
        """
        # 保持同步接口，但不再发一个 ``len(events)`` 临时序号给 SSE。运行在服务
        # event loop 时，DurableEventHub 串行 append；仓储返回的 seq 才会广播，并
        # 原地回填这个 projection。没有运行时/仓储的纯领域调用保持 local-only。
        try:
            repo = get_repo()
            ev = SESSION_EVENTS.enqueue(self, repo, kind, payload)
        except (RuntimeError, LookupError):
            ev = SESSION_EVENTS.emit_ephemeral(self, kind, payload)
        # 少数内容事件继续保留状态投影，兼容迁移前的会话；新会话的权威历史始终是
        # session_event，hydrate 不会重复灌这份 cards。
        if kind in _CARD_EVENT_KINDS:
            cards = self.state.setdefault("_cards", [])
            cards.append(ev)
            if len(cards) > _CARD_EVENT_CAP:
                del cards[:-_CARD_EVENT_CAP]
        return ev

    async def emit_durable(self, kind: str, /, **payload: Any) -> dict[str, Any]:
        """Emit and wait until the returned projection has its authoritative seq.

        Most telemetry can use synchronous :meth:`emit`; callers that immediately
        expose the sequence as an API contract (table download links and chat turn
        correlation) use this helper.
        """
        event = self.emit(kind, **payload)
        await SESSION_EVENTS.wait_seq(event)
        return event

    def brief(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "project": self.project,
                "status": self.status, "files": len(self.files),
                "mode": self.state.get("mode", "work"),
                "created": self.created, "error": self.error}


SESSIONS: dict[str, Session] = {}
#: 首次恢复要跨多个 ``await`` 读取 repo / 材料 / OIR；同一进程里若两个请求同时
#: 打开冷会话，不能各造一份 Session 后互相覆盖。锁按 sid 分片，避免恢复 A 会话时
#: 阻塞完全无关的 B 会话。
_HYDRATE_LOCKS: dict[str, asyncio.Lock] = {}
#: 进入 single-flight（含正在等锁）的协程数。不能只看 ``lock.locked()`` 后 pop：
#: release 与 waiter 真正恢复之间有一个调度缝隙，第三个请求会在缝隙里另建一把锁。
_HYDRATE_USERS: dict[str, int] = {}

#: 按网关实际可用模型过滤后的目录。视觉选型（OCR）靠它 —— 见 _ensure_catalog。
#: 懒发现：第一次 build 时（网关此刻一定配好了）拉一次 /v1/models 并缓存。
_CATALOG: ModelCatalog | None = None
_CATALOG_OK: bool = False

# lifespan 取代 on_event("startup")：后者在 FastAPI 里已弃用，而且没有对称的
# 关闭钩子 —— 连接池不 dispose 的话，热重载会一轮轮泄漏连接。
@asynccontextmanager
async def _lifespan(app: FastAPI) -> Any:
    """先起库，再对账。顺序不能反 —— 对账要用 repo。"""
    global ROOT, _BUILD_LEASE_TTL, _BUILD_HEARTBEAT_INTERVAL
    global _CHAT_LEASE_TTL, _CHAT_HEARTBEAT_INTERVAL
    global _USAGE_DROPPED
    # 把 .env 载进进程环境。CLI 走 llm_config() 时会加载，但服务端的网关配置改走
    # appconfig（DB→env→抛错），它只读 os.getenv 不自己加载 —— 于是裸 uvicorn 启动
    # 时 .env 里的网关明明配了却读不到，/chat 与 /build 全 500。在这里一次性载入。
    from .kernel.config import load_dotenv
    load_dotenv()
    ROOT = workspace_root()
    _BUILD_LEASE_TTL = _configured_build_lease_ttl()
    _BUILD_HEARTBEAT_INTERVAL = min(_BUILD_LEASE_TTL / 3, 10.0)
    _CHAT_LEASE_TTL = _configured_chat_lease_ttl()
    _CHAT_HEARTBEAT_INTERVAL = min(_CHAT_LEASE_TTL / 3, 5.0)
    async with store_lifespan(app):
        ROOT.mkdir(parents=True, exist_ok=True)
        await appconfig.refresh(get_repo())      # 预热设置缓存（网关/模型/预算覆盖）
        await _reconcile_on_boot()
        usage_task = asyncio.create_task(_drain_usage())   # 用量流水落库
        try:
            yield
        finally:
            usage_task.cancel()
            await asyncio.gather(usage_task, return_exceptions=True)
            # 关停前把剩下的流水写完 —— 一次梳理刚跑完就重启，账不该丢。
            try:
                await asyncio.wait_for(_flush_usage(get_repo(), limit=20_000),
                                       timeout=5)
            except Exception:                              # noqa: BLE001
                # 用量写入是旁路；正常关停不能因账本不可用而卡死。
                _USAGE_DROPPED += len(_USAGE_BUF)
            # 仓储连接在外层 context 退出时才关闭；先 drain，确保已经接受的同步
            # emit 在正常关停时全部 commit，避免 shutdown 尾部丢审计。
            await SESSION_EVENTS.shutdown()


app = FastAPI(title="OntoCopilot", version=__version__, lifespan=_lifespan)
# 鉴权门禁：一道 fail-closed 的 HTTP 中间件（详见 :mod:`authgate`）。**先**注册它、
# **后**注册 CORS，这样 CORS 在外层 —— 预检 OPTIONS 与 401 响应上都能带跨域头。
app.middleware("http")(authgate.auth_middleware)
app.add_middleware(
    CORSMiddleware,
    # 默认空 = 仅同源（实际部署方式）。带凭证时浏览器禁止通配，cors_origins 也会滤掉 "*"。
    allow_origins=authgate.cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(authgate.router)
app.include_router(authgate.users_router)
app.include_router(configapi.router)


@app.get("/api/usage")
async def usage(request: Request, days: int = 30, bucket: str = "day",
                limit: int = 5000) -> dict[str, Any]:
    """模型用量：总量 + 按时间的曲线 + 按模型/用途的拆分 + 明细。

    **只统计 token，不把估算的金额当钱报。** 经网关发现的模型在本地价目表里是
    统一编的 2.0/8.0 美元每百万 token —— 拿它算出来的金额看着精确，其实是错的，
    比不显示更糟。只有网关自己回了账单（usd_source=gateway）的那部分才算钱，
    并且明确告诉界面它覆盖了多少条。
    """
    from datetime import UTC, datetime, timedelta

    days = max(1, min(int(days or 30), 365))
    bucket = "hour" if bucket == "hour" else "day"
    # 明细查询不能让一个请求把整本账拉进进程；负数也不能借 Python slice
    # 语义悄悄变成空结果。前端默认 5k，显式导出最多 50k。
    limit = max(1, min(int(limit or 5000), 50_000))
    now = time.time()
    since = now - days * 86400
    # 强制鉴权下只看自己的账；开放模式（合成管理员）看全部，与会话列表同一套规则
    owner = _owner_id(request) if _isolate(request) else None
    rows = await get_repo().usage_since(since, owner=owner, limit=limit)

    def key(ts: float) -> str:
        d = datetime.fromtimestamp(ts, tz=UTC)
        return d.strftime("%Y-%m-%d %H:00") if bucket == "hour" else d.strftime("%Y-%m-%d")

    total = {"calls": 0, "tok_in": 0, "tok_out": 0, "cache_read": 0,
             "cache_write": 0, "tokens": 0, "usd_billed": 0.0,
             "billed_calls": 0, "failed": 0}
    by_model: dict[str, dict[str, Any]] = {}
    by_kind: dict[str, dict[str, Any]] = {}
    series: dict[str, dict[str, Any]] = {}

    for r in rows:
        total["calls"] += 1
        for f in ("tok_in", "tok_out", "cache_read", "cache_write"):
            total[f] += getattr(r, f)
        total["tokens"] += r.total
        if r.status == "failed":
            total["failed"] += 1
        if r.usd_source == "gateway":
            total["usd_billed"] += r.usd
            total["billed_calls"] += 1
        for grp, name in ((by_model, r.model), (by_kind, r.kind)):
            g = grp.setdefault(name, {"name": name, "calls": 0, "tokens": 0,
                                      "tok_in": 0, "tok_out": 0})
            g["calls"] += 1
            g["tokens"] += r.total
            g["tok_in"] += r.tok_in
            g["tok_out"] += r.tok_out
        b = series.setdefault(key(r.ts), {"t": key(r.ts), "calls": 0, "tokens": 0,
                                          "tok_in": 0, "tok_out": 0})
        b["calls"] += 1
        b["tokens"] += r.total
        b["tok_in"] += r.tok_in
        b["tok_out"] += r.tok_out

    # 空桶要补出来，否则"哪天没跑"在曲线上看不出来，只会被挤成连续的一片
    step = timedelta(hours=1) if bucket == "hour" else timedelta(days=1)
    cur = datetime.fromtimestamp(since, tz=UTC).replace(minute=0, second=0, microsecond=0)
    if bucket == "day":
        cur = cur.replace(hour=0)
    end = datetime.fromtimestamp(now, tz=UTC)
    filled = []
    while cur <= end and len(filled) < 400:
        k = cur.strftime("%Y-%m-%d %H:00") if bucket == "hour" else cur.strftime("%Y-%m-%d")
        filled.append(series.get(k) or {"t": k, "calls": 0, "tokens": 0,
                                        "tok_in": 0, "tok_out": 0})
        cur += step

    top = sorted(by_model.values(), key=lambda x: -x["tokens"])
    return {
        "days": days, "bucket": bucket, "total": total,
        "series": filled,
        "by_model": top,
        "by_kind": sorted(by_kind.values(), key=lambda x: -x["tokens"]),
        # 明细给最近这些条；界面上是流水表，也是导出的来源
        "rows": [{"ts": r.ts, "model": r.model, "kind": r.kind, "node": r.node_id,
                  "tok_in": r.tok_in, "tok_out": r.tok_out, "tokens": r.total,
                  "attempts": r.attempts, "status": r.status,
                  "session_id": r.session_id} for r in rows[:300]],
        "truncated": len(rows) >= limit,
        # 金额可信度：界面据此决定显示还是打问号
        "cost_note": ("billed" if total["billed_calls"] == total["calls"] and rows
                      else "partial" if total["billed_calls"] else "none"),
    }


def _sess(sid: str) -> Session:
    """取活着的会话。**不做恢复** —— 恢复要 await，这个函数是同步的。

    需要恢复的路由用 :func:`_sess_async`。
    """
    if sid not in SESSIONS:
        raise HTTPException(404, f"没有会话 {sid}（可能需要先打开它）")
    return SESSIONS[sid]


async def _sess_async(sid: str) -> Session:
    """取会话；首次恢复按 sid single-flight，所有等待者拿到同一个对象。"""
    return SESSIONS.get(sid) or await _hydrate(sid)


async def _refresh_files_projection(s: Session) -> None:
    """Replace a worker's material inventory with the repository authority.

    ``Session.files`` is intentionally an in-process projection.  A mutation/build
    lease serializes writers, but it does not magically refresh another worker that
    cached the session before an upload.  Every claimed structural operation therefore
    reloads this small table before it decides whether files exist or which ones to
    parse/copy/delete.
    """
    rows = await get_repo().list_files(s.id)
    s.files = [{
        "name": row.name,
        "size": row.size,
        "path": str(ROOT / row.rel_path),
        "sha256": row.sha256,
    } for row in rows]


async def _ensure_catalog() -> ModelCatalog:
    """按网关 /v1/models 过滤模型目录，装配视觉网关。**懒发现、成功一次即缓存。**

    不过滤的后果正是「扫描件不识别」：视觉选型按质量挑候选（opus/gpt-5.5 在前），
    可网关未必上了这些模型 —— 候选逐个 404，而真能 OCR 的 gemini-3.5-flash 因质量档
    排在候选之外、**从没被试到**，于是扫描件内容静默不进产物。发现后目录只留网关
    真有的模型，require(VISION) 就落到网关实际提供的视觉模型上。

    在 build 时调（那时网关一定配好了，启动时未必）。发现失败、或命名不匹配把目录
    清空了，都退回内置目录（比没有目录好），且不置 OK —— 下次 build 再试。
    """
    global _CATALOG, _CATALOG_OK
    if _CATALOG_OK and _CATALOG is not None:
        return _CATALOG
    cat = ModelCatalog()
    try:
        cfg = appconfig.resolved_llm_config()
        live = await cat.discover(cfg.base_url, cfg.api_key)
        if cat.names():
            vision = cat.by_capability().get("vision") or []
            print(f"[catalog] 网关可用模型 {len(cat.names())} 个；视觉可用："
                  f"{vision or '无（扫描件仍无法 OCR，请在网关上开一个带视觉的模型）'}")
            _CATALOG, _CATALOG_OK = cat, True
            return cat
        print(f"[catalog] 发现清空了目录（网关命名与内置不匹配？live={live[:8]}），退回内置")
    except Exception as exc:  # noqa: BLE001 — 发现失败不该拖垮 build
        print(f"[catalog] 模型发现失败，退回内置：{type(exc).__name__}: {exc}")
    _CATALOG = ModelCatalog()
    return _CATALOG


def _run_id_for(s: Session) -> str:
    """这次梳理的 Run id：会话 + **语料指纹**。

    以前固定用 ``run_<sid>``，且 Recorder 不开 resume —— 于是进程一崩，上一轮已经
    付费跑完的模型调用全部作废，重跑从头再花一遍钱。

    指纹进 id 是为了让 resume **安全**：同一批材料重跑 → 同一个 id → 命中日志里
    已完成的 effect，直接读回不重花钱；材料一变（加了/删了文件）→ 新 id → 干净的
    新日志，不会拿旧提示的结果去冒充新语料的答案（那正是 DeterminismViolation
    要防的）。
    """
    # 文件名 + 大小不是内容指纹：两个同名、同字节数但内容不同的 CSV 会误命中
    # 上一轮模型 effect。上传时会写 sha256；旧会话没有时在这里补算一次，保证迁移
    # 前创建的项目也不会复用错误结果。
    sig = []
    for f in s.files:
        digest = str(f.get("sha256") or "")
        if not digest:
            try:
                digest = sha256_hex(Path(f["path"]).read_bytes())
            except OSError:
                digest = f"missing:{f['name']}:{int(f.get('size') or 0)}"
            f["sha256"] = digest
        sig.append((f["name"], digest))
    sig.sort()
    return f"run_{s.id}_{fingerprint(sig)[:8]}"


def _chat_recorder_run_id(s: Session, *, kind: str, semantic_input: Any) -> str:
    """Return the durable-effect namespace for a chat-side operation.

    A repository Run answers *which invocation is currently running* and must be
    unique even for two identical requests.  Recorder answers *which effects may
    be replayed safely* and therefore needs the opposite property: equal semantic
    input in the same session maps to the same journal.  Keeping these two IDs
    separate avoids both orphaned ``chat_<uuid>`` journals and lost resume hits.
    """
    return f"chat_{s.id}_{kind}_{fingerprint(semantic_input)[:16]}"


@dataclass(slots=True)
class _ChatRun:
    """One chat-side invocation plus its replayable Recorder journal."""

    repo_run_id: str
    recorder_run_id: str
    backend: Any
    gw: Any
    smart: Any
    budget: Budget
    status: str = "done"
    error: str = ""

    def fail(self, error: str) -> None:
        self.status = "failed"
        self.error = error


async def _finish_chat_repo_run(
    repo: Any,
    repo_run_id: str,
    *,
    status: str,
    error: str,
    budget: dict[str, Any],
) -> None:
    """Shield lifecycle finalisation from caller cancellation.

    ``CancelledError`` leaves the task's cancellation request set.  A database
    driver is therefore allowed to cancel the very ``finish_run`` that should
    record the cancellation.  Run the small final write in its own task and
    shield it; if the outer task is already cancelling, await that inner task
    once more before propagating the original cancellation.
    """
    task = asyncio.create_task(repo.finish_run(
        repo_run_id, status=status, error=error, budget=budget,
    ))
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        await task


@asynccontextmanager
async def _chat_run(
    s: Session,
    *,
    kind: str,
    semantic_input: Any,
    resume: bool = True,
) -> Any:
    """Create/finalise a Repo Run around every chat-side Recorder producer.

    ``finish_run`` lives here so normal completion, exception and cancellation
    cannot drift between ``_reason``, confirmations, wording and recommendations.
    The backend is also always closed, including on ``CancelledError``.
    """
    # Pure domain/unit callers may construct a Session without registering it.
    # The HTTP product path never does: create/hydrate establishes the row first.
    # Keep that narrow test seam while making every real invocation durable.
    try:
        repo = get_repo()
        registered = await repo.get_session(s.id)
    except RuntimeError:
        repo = None
        registered = None
    repo_run_id = (await repo.next_run(s.id, f"chat:{kind}")) \
        if repo is not None and registered is not None else ""
    recorder_run_id = _chat_recorder_run_id(
        s, kind=kind, semantic_input=semantic_input,
    )

    def budget_doc() -> dict[str, Any]:
        # Correlate the unique invocation row with the semantic Recorder journal.
        # Without this pointer both stores are individually correct but an audit
        # cannot follow ``session.12`` to the effects it produced.
        snapshot = budget.snapshot() if budget is not None else {}
        return {**snapshot, "recorder_run_id": recorder_run_id}

    backend = None
    budget = None
    try:
        journal = s.dir / "journal" / f"{recorder_run_id}.jsonl"
        backend, gw, smart, budget = _gateways(
            s.dir, recorder_run_id, resume=resume and journal.exists(),
            session_id=s.id, kind="chat", owner=s.owner,
        )
        run = _ChatRun(
            repo_run_id=repo_run_id,
            recorder_run_id=recorder_run_id,
            backend=backend,
            gw=gw,
            smart=smart,
            budget=budget,
        )
        yield run
    except asyncio.CancelledError:
        if repo_run_id:
            await _finish_chat_repo_run(
                repo, repo_run_id,
                status="failed",
                error="cancelled",
                budget=budget_doc(),
            )
        raise
    except BaseException as exc:
        if repo_run_id:
            await _finish_chat_repo_run(
                repo, repo_run_id,
                status="failed",
                error=f"{type(exc).__name__}: {exc}",
                budget=budget_doc(),
            )
        raise
    else:
        if repo_run_id:
            await _finish_chat_repo_run(
                repo, repo_run_id,
                status=run.status,
                error=run.error,
                budget=budget_doc(),
            )
    finally:
        if backend is not None:
            await backend.aclose()


#: 用量流水的落库缓冲。**记账不能挡在模型调用的路上**：网关那边是同步回调，
#: 而写库是 async，中间必须有个缓冲。
#:
#: 用 deque 而不是 asyncio.Queue：Queue 会绑定到创建它的事件循环，而测试里每个
#: 用例一个新循环、模块级对象却只建一次 —— 跨循环用就会挂住。deque 不认循环。
_USAGE_BUF: deque = deque(maxlen=20_000)
#: 缓冲满时丢掉了多少条。**要有个数**：静默丢账等于账本在说谎。
_USAGE_DROPPED = 0


def _usage_sink(*, session_id: str = "", kind: str = "build",
                owner: str = "") -> Any:
    """造一个记账回调，把这次运行的身份（会话/用途/归属）绑上去。

    网关只知道 node_id、模型和 token —— 会话是谁、这轮是梳理还是聊天、算在哪个
    账号头上，只有服务端知道，所以在这里闭包进去。
    """
    def sink(rec: dict[str, Any]) -> None:
        import uuid as _uuid
        from datetime import UTC, datetime

        ts = time.time()
        row = UsageRow(
            id=_uuid.uuid4().hex, ts=ts,
            day=datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d"),
            model=rec.get("model") or "?", owner=owner, session_id=session_id,
            kind=kind, run_id=rec.get("run_id") or "",
            node_id=rec.get("node_id") or "", effort=rec.get("effort") or "",
            tok_in=int(rec.get("tok_in") or 0), tok_out=int(rec.get("tok_out") or 0),
            cache_read=int(rec.get("cache_read") or 0),
            cache_write=int(rec.get("cache_write") or 0),
            usd=float(rec.get("usd") or 0.0),
            usd_source=rec.get("usd_source") or "estimated",
            attempts=int(rec.get("attempts") or 1),
            status=rec.get("status") or "ok")
        global _USAGE_DROPPED
        if len(_USAGE_BUF) >= (_USAGE_BUF.maxlen or 0):
            _USAGE_DROPPED += 1        # maxlen 会挤掉最老的一条，记个数别静默
        _USAGE_BUF.append(row)
    return sink


async def _flush_usage(repo: Any, *, limit: int = 500) -> int:
    """把缓冲里的流水写进库，返回写了几条。

    只有仓储确认提交后才从队首移除。异常向上传给常驻 drain（它会退避重试）或
    shutdown（它会把真正来不及写的尾部计入 dropped），避免一次瞬时 DB 故障把
    一条已经接受的用量记录永久吞掉。
    """
    n = 0
    while _USAGE_BUF and n < limit:
        row = _USAGE_BUF[0]
        await repo.add_usage(row)
        # await 期间别的模型调用可能把已满 deque 的队首挤掉；只有它仍是同一个
        # 对象时才 pop，避免误删下一条尚未落库的记录。
        if _USAGE_BUF and _USAGE_BUF[0] is row:
            _USAGE_BUF.popleft()
        n += 1
    return n


async def _drain_usage() -> None:
    """常驻的落库循环。lifespan 里起一个。"""
    while True:
        try:
            if _USAGE_BUF:
                await _flush_usage(get_repo())
            await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise
        except Exception:              # noqa: BLE001
            await asyncio.sleep(2)


def _gateways(out: Path, run_id: str, *, resume: bool = False,
              session_id: str = "", kind: str = "build", owner: str = "",
              ) -> tuple[Any, ModelGateway, SmartGateway, Budget]:
    cfg = appconfig.resolved_llm_config()          # 设置 → env → 抛错
    rec = Recorder(run_id, FileJournal(out / "journal"), FileBlobStore(out / "blobs"),
                   resume=resume)
    # 一份几百行的梳理表要跑十来个抽取节点，每个节点还可能因 critic 打回重来。
    # 上限设太紧的后果不是省钱，是跑到一半 HALT、前面花掉的钱全打水漂。
    budget = Budget(tokens=4_000_000, usd=appconfig.usd_cap())
    backend = OpenAICompatBackend(cfg.base_url, cfg.api_key)
    # 启动时按网关可用模型过滤过的目录 —— 视觉选型据此落到网关真有的视觉模型上
    catalog = _CATALOG or ModelCatalog()
    # 路由按当前设置构建（含各档模型覆盖）并随本次 Run 固定：配置改动只作用到之后
    # 新建的 Run，不影响在跑的这次。
    routing = gateway_routing(appconfig.model_overrides(), catalog)
    gw = ModelGateway(backend, rec, routing=routing, budget=budget,
                      usage_sink=_usage_sink(session_id=session_id, kind=kind,
                                             owner=owner))
    return backend, gw, SmartGateway(gw, catalog), budget


# ══════════════════════════════════════════════════════════════════
#  会话与文件
# ══════════════════════════════════════════════════════════════════
@app.get("/api/health")
async def health() -> dict[str, Any]:
    try:
        cfg = appconfig.resolved_llm_config()      # 设置 → env → 抛错
        gateway = {"base_url": cfg.base_url, "key": cfg.redacted_key,
                   "insecure": cfg.insecure_transport}
    except RuntimeError as exc:
        gateway = {"error": str(exc)}
    cat = ModelCatalog()
    try:
        db = await get_store().healthcheck()
    except Exception as exc:  # noqa: BLE001 — 健康检查本身不该把 /health 打挂
        db = {"mode": "unknown", "ok": False, "error": str(exc)}
    return {"ok": "error" not in gateway, "gateway": gateway, "database": db,
            "models": cat.describe(), "capabilities": cat.by_capability(),
            "skills": default_library().names()}


@app.get("/api/models")
async def api_models() -> dict[str, Any]:
    """「工作」模式模型选择器：列出网关**实际可用**的模型（懒发现，回落内置目录）。"""
    cat = await _ensure_catalog()
    return {"models": cat.describe()}


@app.post("/api/sessions/{sid}/model")
async def set_model(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """设定该会话对话用的模型。空/未知则清除，回落到按难度路由。"""
    s = await _sess_async(sid)
    async with _session_mutation(s, "session.model"):
        name = str((body or {}).get("model") or "")
        cat = await _ensure_catalog()
        s.state["model"] = name if (name and cat.get(name)) else ""
        await _persist(s, status=False)
        return {"model": s.state["model"]}


# ── 会话归属（按账号隔离）─────────────────────────────────────────
def _owner_id(request: Request) -> str:
    """当前请求用户的 id（开放模式下是合成管理员 "__local__"）。新建会话记它为归属。"""
    u = getattr(request.state, "user", None)
    return u.id if u is not None else ""


def _isolate(request: Request) -> bool:
    """是否要按账号隔离：强制鉴权下的真实用户才隔离；开放模式（合成管理员）照旧全见。"""
    u = getattr(request.state, "user", None)
    return u is not None and u.id != authgate.SYNTHETIC_ADMIN.id


@app.get("/api/sessions")
async def list_sessions(request: Request) -> list[dict[str, Any]]:
    """会话列表**以库为准**。强制鉴权下只列归属自己的；开放模式保持原行为
    （合并内存里活着的 + 盘上孤儿目录）。"""
    isolate = _isolate(request)
    rows = await get_repo().list_sessions(owner=_owner_id(request) if isolate else None)
    out: list[dict[str, Any]] = []
    for r in rows:
        live = SESSIONS.get(r.id)
        if live is not None:
            out.append(live.brief())
            continue
        files = await get_repo().list_files(r.id)
        st = await get_repo().load_state(r.id, keys=["mode"])
        out.append({"id": r.id, "title": r.title, "project": r.project,
                    "status": r.status, "files": len(files), "created": r.created,
                    "error": r.error, "mode": st.get("mode", "work"),
                    "hydrated": False})
    if isolate:
        # 隔离模式到此为止：只列库里归属自己的会话（每次创建都已落库带 owner）。
        # 不合并"内存里活着但不在结果集"的会话，也不扫孤儿目录 —— 那些会泄露他人
        # 或无归属的会话。
        return sorted(out, key=lambda x: -x["created"])

    known = {r.id for r in rows}
    out += [s.brief() for s in SESSIONS.values() if s.id not in known]
    known |= {x["id"] for x in out}

    # 盘上的孤儿目录也要列。它们是数据库接上之前建的会话 —— 产物、材料、
    # 事件日志都还在，只是没人认领。不列的话用户看到的是"我的东西没了"，
    # 而磁盘上明明还有 14MB。
    if ROOT.exists():
        for d in ROOT.iterdir():
            if not d.is_dir() or d.name in known or (d / ".deleted").exists():
                continue
            arts = [x.name for x in d.iterdir() if x.is_file()]
            mats = d / "materials"
            out.append({
                "id": d.name, "title": d.name, "project": "",
                # 有产物就是跑完过的。目录里的事实比一个丢掉的状态字段可信。
                "status": "done" if "oir.json" in arts else "idle",
                "files": len(list(mats.iterdir())) if mats.exists() else 0,
                "created": d.stat().st_mtime, "error": "",
                "mode": "work", "orphan": True})
    return sorted(out, key=lambda x: -x["created"])


@app.post("/api/sessions")
async def create_session(request: Request,
                         body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body or {}
    s = Session(id=uuid.uuid4().hex[:12],
                title=body.get("title") or "新的本体梳理",
                project=body.get("project", ""))
    # 聊天 / 工作 双模式：chat = 纯对话（只读工具、无梳理管线），work = 完整工作台。
    s.state["mode"] = body.get("mode") if body.get("mode") in ("work", "chat") else "work"
    s.dir.mkdir(parents=True, exist_ok=True)
    s.owner = _owner_id(request)       # 用量流水按账号记
    SESSIONS[s.id] = s
    created_row = False
    try:
        await get_repo().create_session(SessionRow(
            id=s.id, title=s.title, project=s.project, status=s.status,
            error="", created=s.created, state_version=0, owner=s.owner))
        created_row = True
        await _persist(s, status=False)   # 把 mode 落下来，重载前就存在
        return s.brief()
    except BaseException:
        SESSIONS.pop(s.id, None)
        if created_row:
            await get_repo().delete_session(s.id)
        # A failed create is not a user asset yet.  Leaving the directory behind
        # makes the orphan scanner resurrect a session that never committed.
        import shutil
        if s.dir.exists():
            shutil.rmtree(s.dir)
        raise


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str, purge: bool = False) -> dict[str, Any]:
    """删会话。

    Args:
        purge: 连 ``workspace/<sid>/`` 一起删。默认 **False** —— 产物、事件日志、
            原始材料都在那儿，"从列表里去掉"和"把东西删了"是两件事，
            后者要用户明确说。
    """
    # A normal persisted session is deleted under the same cross-worker mutation
    # lease as every other structural write.  Otherwise a remote build can claim the
    # session between this route's read and ``delete_session`` and keep writing files
    # after the user has removed the project.  Legacy orphan directories have no row
    # (and therefore no lease target), so preserve the old direct cleanup path.
    row = await get_repo().get_session(sid)
    if row is not None:
        s = await _sess_async(sid)
        async with _session_mutation(s, "session.delete"):
            return await _delete_session_once(sid, purge=purge)
    return await _delete_session_once(sid, purge=purge)


async def _delete_session_once(sid: str, *, purge: bool) -> dict[str, Any]:
    """Delete a session after the caller has fenced concurrent mutations."""
    existed = await get_repo().delete_session(sid)
    live = SESSIONS.pop(sid, None)
    if live is not None:
        for q in list(live.subscribers):  # 断开订阅者，否则 SSE 会一直挂着
            q.put_nowait({"seq": -1, "kind": "session.deleted"})
        live.subscribers.clear()
    removed = False
    d = ROOT / sid
    if not purge and d.exists():
        # 只从列表移除、产物留着 —— 但目录还在，孤儿扫描会把它再捡回来。
        # 留一个标记：目录是用户的资产，"已删除"是我们的状态，两者要能共存。
        (d / ".deleted").write_text(str(time.time()), encoding="utf-8")
    if purge:
        import shutil
        if d.exists():
            shutil.rmtree(d)
            removed = True
    if not existed and live is None and not removed:
        raise HTTPException(404, f"没有会话 {sid}")
    return {"deleted": sid, "purged": removed}


@app.post("/api/sessions/{sid}/files")
async def upload(sid: str, files: list[UploadFile]) -> dict[str, Any]:
    s = await _sess_async(sid)
    async with _session_mutation(s, "materials.upload"):
        result = await _upload_once(s, files)
    # Start the optional recommendation only after releasing the mutation lease; its
    # own chat lease is then guaranteed not to race this upload's projection commit.
    asyncio.create_task(_emit_ai_prompts(s, slot="opening"))
    return result


async def _upload_once(s: Session, files: list[UploadFile]) -> dict[str, Any]:
    """Stage and atomically install one multipart batch under a mutation lease."""
    sid = s.id
    if _busy(s):
        raise HTTPException(409, "正在梳理，不能同时替换材料。")
    mats = s.dir / "materials"
    mats.mkdir(parents=True, exist_ok=True)
    max_files = max(1, int(os.getenv("ONTOCOPILOT_MAX_FILES", "100")))
    file_limit = int(os.getenv("ONTOCOPILOT_MAX_UPLOAD_MB", "100")) * 1024 * 1024
    session_limit = int(os.getenv("ONTOCOPILOT_MAX_SESSION_MB", "500")) * 1024 * 1024
    existing = {item["name"]: int(item.get("size") or 0) for item in s.files}
    incoming_names = {Path(f.filename or "unnamed").name for f in files}
    projected_names = set(existing) | incoming_names
    if len(projected_names) > max_files:
        raise HTTPException(413, f"会话材料数不能超过 {max_files} 份")
    base_total = sum(size for name, size in existing.items() if name not in incoming_names)
    staged: dict[str, tuple[Path, int, str]] = {}
    temps: set[Path] = set()
    staged_total = 0
    try:
        for f in files:
            name = Path(f.filename or "unnamed").name
            temp = mats / f".{uuid.uuid4().hex}.upload"
            temps.add(temp)
            digest = hashlib.sha256()
            size = 0
            # 同一 multipart 里若名字重复，以最后一份为准；前一份不计配额也不落盘。
            prior = staged.pop(name, None)
            if prior is not None:
                prior[0].unlink(missing_ok=True)
                staged_total -= prior[1]
            try:
                with temp.open("wb") as handle:
                    while chunk := await f.read(1024 * 1024):
                        size += len(chunk)
                        if size > file_limit:
                            raise HTTPException(
                                413,
                                f"{name} 超过单文件 {file_limit // 1024 // 1024}MB 限制",
                            )
                        if base_total + staged_total + size > session_limit:
                            raise HTTPException(
                                413,
                                f"会话材料总量超过 {session_limit // 1024 // 1024}MB 限制",
                            )
                        handle.write(chunk)
                        digest.update(chunk)
                staged[name] = (temp, size, digest.hexdigest())
                staged_total += size
            finally:
                await f.close()
    except BaseException:
        # 校验阶段的失败还没有触碰正式文件；清掉整批 staging，包括已经完整读完的
        # 前序文件。只有整个 multipart 读完才会进入下面的提交阶段。
        for temp in temps:
            temp.unlink(missing_ok=True)
        raise

    # 文件系统没有多文件事务。每个旧版本先原子移到同目录 backup；只有所有 replace
    # 和 repo 的单事务 upsert 都成功后才删除 backup。任何一步（包括第二个 replace、
    # DB 写入或请求取消）失败，都按逆序恢复旧版本并移除本批新文件。
    backups: dict[str, Path | None] = {}
    installed: list[str] = []
    added = [
        {"name": name, "size": size, "path": str(mats / name), "sha256": digest}
        for name, (_temp, size, digest) in staged.items()
    ]
    try:
        for name, (temp, _size, _digest) in staged.items():
            dest = mats / name
            backup: Path | None = None
            if dest.exists():
                backup = mats / f".{uuid.uuid4().hex}.backup"
                dest.replace(backup)
            backups[name] = backup
            temp.replace(dest)
            installed.append(name)
        await get_repo().add_files(sid, [
            FileRow(name=f["name"], rel_path=str(Path(f["path"]).relative_to(ROOT)),
                    size=f["size"], sha256=f["sha256"])
            for f in added])
    except BaseException:
        for name in reversed(installed):
            (mats / name).unlink(missing_ok=True)
        for name, backup in backups.items():
            if backup is not None and backup.exists():
                backup.replace(mats / name)
        raise
    else:
        for backup in backups.values():
            if backup is not None:
                backup.unlink(missing_ok=True)
    finally:
        for temp in temps:
            temp.unlink(missing_ok=True)

    for item in added:
        # 同名上传是替换，不是把同一材料在语料清单里追加两遍。内存投影只在磁盘与
        # repo 均成功后更新，异常路径与两个权威存储保持旧状态。
        s.files = [old for old in s.files if old["name"] != item["name"]]
        s.files.append(item)
    s.emit("files.attached", files=[f["name"] for f in s.files])
    # **上传只登记，不解析。** 解析是不是现在做、做哪几份，交给 AI 判断（它有
    # material.list 看清单、material.parse 去读）。上传即解析看着"贴心"，实际是
    # 替 FDE 和 AI 都做了决定：他可能还要再传两份、可能只想先聊聊，而 AI 也没有
    # 机会说"这份跟你要问的没关系，先不读"。
    s.emit("materials.registered",
           files=[f["name"] for f in added],
           note="已登记，还没读内容。要读时由助手调用解析。")
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    public["engagement"] = _engagement_view(s)
    return {"files": s.files, "corpus": s.state.get("corpus"),
            "prompts": opening_prompts(state=public,
                                       files=[f["name"] for f in s.files],
                                       status=s.status)}


@app.delete("/api/sessions/{sid}/files/{name}")
async def remove_material(sid: str, name: str) -> dict[str, Any]:
    """撤掉一份还没梳理的材料。

    FDE 传错了、传多了要能拿掉再开始 —— 只能重传不能删，等于逼他重开一个会话。
    删完重跑 ``_preparse``，证据索引与语料摘要跟着收缩，否则聊天还能检索到一份
    已经不在列表里的材料。
    """
    s = await _sess_async(sid)
    async with _session_mutation(s, "materials.remove"):
        return await _remove_material_once(s, name)


async def _remove_material_once(s: Session, name: str) -> dict[str, Any]:
    """Remove and re-index one material under a cross-worker mutation lease."""
    sid = s.id
    if _busy(s):
        raise HTTPException(409, "正在梳理，这时候增删材料会和正在跑的解析打架。")
    fname = Path(name).name          # basename：防路径穿越
    old_index = next((i for i, f in enumerate(s.files) if f["name"] == fname), None)
    if old_index is None:
        raise HTTPException(404, name)
    old_item = s.files[old_index]
    p = s.dir / "materials" / fname
    backup = p.with_name(f".{uuid.uuid4().hex}.remove") if p.exists() else None
    if backup is not None:
        p.replace(backup)
    s.files = [f for f in s.files if f["name"] != fname]
    try:
        await get_repo().remove_file(sid, fname)
        s.emit("files.attached", files=[f["name"] for f in s.files])
        # 索引/语料要跟着这次删除重算；没材料了就把上一轮的残留清干净。
        if s.files:
            await _preparse(s)
        else:
            for k in ("_docs", "_index", "_chunks", "_profiles", "_endpoints", "corpus"):
                s.state.pop(k, None)
        # 撤掉一份材料，"现在能问什么"就变了 —— 上传那条路早就带着新提示回去了，
        # 删除这条以前不带，于是 chips 还在问一份已经不存在的材料里有什么。
        #
        # 写空数组，**不能 pop**：`_persist` 只做 upsert（`docs = {k: state[k]
        # for k in _PERSISTED if k in state}`），删掉内存里的 key 只是让它不进
        # docs，库里那份原样留着 —— 换个 worker hydrate 一次，chips 又回来问
        # 一份已经删掉的材料。正是这几行想防的事。
        s.state["followups"] = []
        await _persist(s, status=False)
    except BaseException:
        # File + file inventory + derived projection are one user operation.  Put
        # both authoritative stores back before the mutation context restores the
        # in-memory state snapshot.
        if backup is not None and backup.exists():
            backup.replace(p)
        s.files.insert(min(old_index, len(s.files)), old_item)
        await get_repo().add_files(sid, [FileRow(
            name=fname,
            rel_path=str(Path(old_item["path"]).relative_to(ROOT)),
            size=int(old_item.get("size") or 0),
            sha256=str(old_item.get("sha256") or ""),
        )])
        raise
    if backup is not None:
        backup.unlink(missing_ok=True)
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    return {"files": s.files, "corpus": s.state.get("corpus"),
            "prompts": opening_prompts(state=public,
                                       files=[f["name"] for f in s.files],
                                       status=s.status)}


@app.post("/api/sessions/{sid}/to_work")
async def to_work(sid: str, request: Request) -> dict[str, Any]:
    """把一个聊天会话转成工作会话：把聊天里传的文件带过去，在那边正式梳理。

    聊天只对话、不梳理；真要抽本体/出流程图，转成工作会话即可 —— 文件跟着走，
    不用重新上传。
    """
    src = await _sess_async(sid)
    async with _session_mutation(src, "session.to_work"):
        return await _to_work_once(src, request)


async def _to_work_once(src: Session, request: Request) -> dict[str, Any]:
    """Copy one stable source snapshot into a new work session."""
    import shutil

    ws = Session(id=uuid.uuid4().hex[:12],
                 title=(src.title.replace("对话", "").strip() or "梳理") + "（自聊天）")
    ws.state["mode"] = "work"
    ws.owner = _owner_id(request)
    created_row = False
    try:
        ws.dir.mkdir(parents=True, exist_ok=False)
        src_mats = src.dir / "materials"
        if src_mats.exists():
            (ws.dir / "materials").mkdir(exist_ok=True)
            for p in sorted(src_mats.iterdir()):
                if p.is_file():
                    dst = ws.dir / "materials" / p.name
                    shutil.copy2(p, dst)
                    ws.files.append({
                        "name": p.name, "size": dst.stat().st_size,
                        "path": str(dst), "sha256": sha256_hex(dst.read_bytes()),
                    })
        SESSIONS[ws.id] = ws
        await get_repo().create_session(SessionRow(
            id=ws.id, title=ws.title, project="", status=ws.status,
            error="", created=ws.created, state_version=0, owner=ws.owner))
        created_row = True
        if ws.files:
            await get_repo().add_files(ws.id, [
                FileRow(name=f["name"],
                        rel_path=str(Path(f["path"]).relative_to(ROOT)),
                        size=f["size"], sha256=f["sha256"])
                for f in ws.files])
            await _preparse(ws)
        await _persist(ws, status=False)
        return {"id": ws.id, "files": len(ws.files)}
    except BaseException:
        SESSIONS.pop(ws.id, None)
        if created_row:
            await get_repo().delete_session(ws.id)
        if ws.dir.exists():
            shutil.rmtree(ws.dir)
        raise


#: 切片缓存里每段留多少字符。整段全存会让一份 477 段的语料把 session_state 撑成
#: 几 MB；1500 足够"点回原文"显示上下文，检索本身走 EvidenceIndex 不靠它。
_CHUNK_TEXT_CAP = 1500

#: material.rows 能读行的格式；别的文件没有"行"这个概念，正文走 evidence.search。
_TABULAR_EXT = (".xlsx", ".xlsm", ".xltx", ".csv", ".tsv")
#: 一次最多列多少行。超了**要在回执里说清**还剩多少 —— 悄悄截断会被读成"就这些"。
_ROWS_MAX = 500


def _chunk_cache(docs: list[Any]) -> dict[str, list[dict[str, Any]]]:
    """把解析结果摊成可持久化的切片缓存。**解析的两条路共用这一个形状。**

    以前上传那条路存全文、不带 tags，梳理管线那条存截断到 1500、带 tags —— 谁最后
    跑谁说了算。下游按 tags 过滤时，取决于当时是哪条路写的，行为会莫名其妙地变，
    而且不报错。
    """
    return {d.file_name: [{"cite": c.cite(), "text": c.render[:_CHUNK_TEXT_CAP],
                           "tags": list(c.tags or []), "locator": c.locator}
                          for c in d.chunks]
            for d in docs}


async def _preparse(s: Session, *, vision: Any = None) -> None:
    """解析材料、建证据索引，让对话能查材料。**不产出任何本体/流程图/模板。**

    ``vision`` 默认不给：扫描件在这条路上只登记不识别 —— 识别要调模型、要花钱，
    不该由"拖了个文件进来"触发。给了就连图片一起识别，用于用户明确说"分析一下
    这张图"的场景（他要的是读懂这张图，不是启动整条梳理管线）。
    """
    try:
        reg = default_registry(
            vision_gateway=vision,
            vision_progress=(lambda m: s.emit("flow.step", cite="", found=m))
            if vision else None)
        docs = await reg.aparse_all([f["path"] for f in s.files])
    except Exception as exc:  # noqa: BLE001 — 解析失败不该让上传失败
        s.emit("parse.failed", error=f"{type(exc).__name__}: {exc}")
        return
    index = build_index(docs)
    # **保住上一轮花钱 OCR 出来的切片。** 这里是不带视觉网关的重解析（上传时、
    # 每次 hydrate 都会跑），扫描件在这条路上恒定产出 0 切片。直接覆盖的话，
    # build 阶段付费识别出来的内容就在下一次开会话时静默蒸发 —— 而 `/source`
    # 会对一份明明识别过的材料回"尚未解析"。所以：新解析没读出东西、而旧缓存
    # 里有的文件，保留旧的，并把它们重新灌回检索索引。
    from .onto.parse.base import make_chunk
    prev = s.state.get("_chunks") or {}
    fresh = _chunk_cache(docs)
    kept = 0
    for fname, saved in prev.items():
        if fresh.get(fname) or not saved:
            continue
        fresh[fname] = saved
        fid = f"restored_{fname}"
        for i, c in enumerate(saved):
            index.add(make_chunk(
                doc_id=f"r{i}", file_id=fid, file_name=fname,
                locator=c.get("locator") or {}, render=c.get("text") or "", order=i))
        kept += len(saved)
    # `_docs` 曾经存在这里，但只被写、从没被读（唯一提到它的地方是删材料时的
    # pop 列表）。存一份活的 ParsedDoc 列表在 state 里既占内存又是第二份真相 ——
    # 需要文档的地方（建流程图、切段）都在解析当场就拿到了。
    s.state["_index"] = index
    s.state["_profiles"] = collect_profiles(docs)
    s.state["_endpoints"] = collect_endpoints(docs)
    s.state["corpus"] = corpus_summary(docs)
    s.state["_chunks"] = fresh
    if kept:
        s.emit("corpus.restored", chunks=kept,
               note="沿用上一轮已识别的扫描件内容，未重新调用视觉模型")
    s.emit("corpus.ready", stats={"files": len(docs), "chunks": len(index)},
           findings=[{"kind": f.kind, "message": f.message,
                      "severity": f.severity, "locator": f.locator}
                     for d in docs for f in d.findings][:12])




async def _restore_dialogue(s: Session) -> None:
    """把库里的决定装回对话记忆。

    不装的话，"我记下了你的口径约定"在重启之后就成了空话 —— 库里明明有，
    但下一次 Run 的 ContextManager 读的是内存里的 DialogueMemory，那是空的。
    """
    saved = s.state.pop("dialogue", None)
    if saved:
        try:
            s.state["_dialogue"] = DialogueMemory.from_dict(saved)
        except (KeyError, TypeError, ValueError):
            s.emit("hydrate.partial", error="对话历史格式损坏，已只恢复已拍板决定")
    rows = await get_repo().list_decisions(s.id)
    dm = _dialogue(s)
    # dialogue 文档和 decision 表有重叠：前者保留轮次，后者是决定的权威审计表。
    # 只补文档尚未包含的尾部，避免每次 hydrate 都把同一批决定复制一遍。
    for r in rows[len(dm.decisions):]:
        d = Decision(kind=DecisionKind(r.kind), statement=r.statement,
                     scope_refs=list(r.scope_refs or []), turn_index=r.turn_index,
                     ts=r.ts)
        d.superseded_by = r.superseded_by
        dm._decisions.append(d)


async def _hydrate(sid: str) -> Session:
    """Single-flight 地把库里/盘上的会话变回一个活的 :class:`Session`。"""
    if cached := SESSIONS.get(sid):
        return cached
    lock = _HYDRATE_LOCKS.setdefault(sid, asyncio.Lock())
    _HYDRATE_USERS[sid] = _HYDRATE_USERS.get(sid, 0) + 1
    try:
        async with lock:
            # 等锁期间首个调用者已完成恢复；所有并发等待者必须拿同一实例。
            if cached := SESSIONS.get(sid):
                return cached
            return await _hydrate_once(sid)
    finally:
        users = _HYDRATE_USERS.get(sid, 1) - 1
        if users:
            _HYDRATE_USERS[sid] = users
        else:
            _HYDRATE_USERS.pop(sid, None)
            if _HYDRATE_LOCKS.get(sid) is lock:
                _HYDRATE_LOCKS.pop(sid, None)


async def _hydrate_once(sid: str) -> Session:
    """把库里/盘上的会话变回一个活的 Session。

    **重启后打开一个旧会话，必须真的能用** —— 只把标题和文件名读回来、
    而所有操作都 409，比列表里干脆不显示它更糟：用户看着一个"完成"的会话，
    点什么都没反应。

    重的东西（OIR、证据索引）按需重建：OIR 从 oir.json 反序列化，索引重新解析
    材料（xlsx 解析是零模型调用的）。扫描件例外 —— 它要过视觉模型，重建要花钱，
    所以留到用户真的点了「重新梳理」。
    """
    row = await get_repo().get_session(sid)
    d = ROOT / sid
    if row is None and (not d.exists() or (d / ".deleted").exists()):
        raise HTTPException(404, f"没有会话 {sid}")

    s = Session(id=sid,
                title=row.title if row else sid,
                project=row.project if row else "",
                created=row.created if row else d.stat().st_mtime,
                # 有 oir.json 就是跑完过的 —— 目录里的事实比一个丢掉的状态字段可信
                status=(row.status if row else
                        ("done" if (d / "oir.json").exists() else "idle")),
                state_version=row.state_version if row else 0,
                owner=row.owner if row else "")
    try:
        await _hydrate_into(s, row=row, directory=d)
    except BaseException:
        # 包括 CancelledError：恢复失败/取消后不能留下一份可被后续请求命中的半成品。
        if SESSIONS.get(sid) is s:
            SESSIONS.pop(sid, None)
        raise
    # 只有全部 repo/文件/领域状态恢复成功后才发布缓存。若提前发布，晚到请求会在
    # `_sess_async` 的 fast path 命中半成品，完全绕过上面的 single-flight 锁。
    SESSIONS[sid] = s
    return s


async def _hydrate_into(s: Session, *, row: Any, directory: Path) -> None:
    """填充已占位的 Session；只由 :func:`_hydrate_once` 在恢复锁内调用。"""
    sid = s.id
    d = directory
    # A persisted session may legitimately have no artifacts or materials yet (for
    # example, a chat-only session reopened after its first turn).  Hydration must
    # not assume the workspace directory was already created by an upload/build.
    d.mkdir(parents=True, exist_ok=True)

    mats = d / "materials"
    if mats.exists():
        s.files = [{"name": f.name, "size": f.stat().st_size, "path": str(f),
                    "sha256": sha256_hex(f.read_bytes())}
                   for f in sorted(mats.iterdir()) if f.is_file()]
    if row is not None:
        s.owner = row.owner or ""      # 用量流水按账号记，后台管线读不到请求
        s.state.update(await get_repo().load_state(sid))
        await _restore_dialogue(s)
        # 进程内 SSE 不是历史。session_event 才是断线/重启后的 cursor；恢复后
        # “上一轮生成的下载卡/审核结果/问题表”仍在原来的时间线上，而不是只剩
        # 一个笼统的 session.restored。
        durable_events = await get_repo().read_events(sid, since=0)
        if durable_events:
            s.events = [event.as_sse() for event in durable_events]
        qrows = await get_repo().list_questions(sid)
        if qrows:
            s.state["question_backlog"] = QuestionBacklog.from_dict(
                [r.doc for r in qrows]).to_dict()
        # 多 worker 下不能因本 worker 没有 Task 就宣布运行死亡。只有 lease 已过期
        # （或迁移前根本没有 lease）的运行才可回收；健康 worker 的 heartbeat 必须保留。
        if s.status in ("queued", "parsing", "extracting"):
            error = "上次运行被中断（租约已过期）。材料和已拍板的决定都在，可以重新开始。"
            reaped = await get_repo().reap_expired_build_lease(
                sid, now=time.time(), error=error,
            )
            if reaped:
                s.status, s.error = "failed", error

    oir_json = d / "oir.json"
    if oir_json.exists():
        try:
            data = json.loads(oir_json.read_text(encoding="utf-8"))
            s.state["_oir"] = oir_from_dict(data)
            s.state.setdefault("oir", data)
        except Exception as exc:  # noqa: BLE001 — 读不回来要说，不能假装会话是好的
            s.emit("hydrate.partial", error=f"oir.json 读不回来：{exc}")
    flow_json = d / "flow.json"
    if flow_json.exists():
        # 流程图是产品的主产出 —— 恢复会话时不读回来，界面上那个 tab 就是空的，
        # 而 SVG 明明躺在同一个目录里。
        try:
            from .onto.flow import flow_from_dict
            data = json.loads(flow_json.read_text(encoding="utf-8"))
            s.state["flow"] = data
            # _flow 是活对象，「改流程图」要用它 —— 只恢复 dict 快照不够
            s.state["_flow"] = flow_from_dict(data)
        except Exception as exc:  # noqa: BLE001
            s.emit("hydrate.partial", error=f"flow.json 读不回来：{exc}")

    if s.files:
        await _preparse(s)          # 证据索引重建，零模型调用
    if s.state.get("_oir") is not None and not s.state.get("question_backlog"):
        await _sync_question_backlog(s)
    s.state["artifacts"] = [x.name for x in d.iterdir() if x.is_file()]
    # 迁移前的会话可能只有 state._cards、没有 session_event；仅对此兼容。新会话
    # hydrate 已直接载入 durable seq，绝不重编号或重复灌卡片。
    durable_loaded = bool(row is not None and s.events)
    if not durable_loaded:
        for c in (s.state.get("_cards") or []):
            s.events.append({**c, "seq": len(s.events)})
    # single-flight 保证并发冷启动只走一次这里。恢复完成本身是 API 返回语义的一部分，
    # 不能仅把事件排进后台队列就发布 Session：否则进程恰在返回后退出时，用户已经看见
    # “恢复成功”，审计里却没有对应记录。等待这条 FIFO 尾事件的 durable seq 也会顺带
    # 保证恢复期间较早发出的 partial/corpus 事件全部落库。
    await s.emit_durable(
        "session.restored",
        files=len(s.files),
        stats=(s.state.get("oir") or {}).get("stats"),
    )


def _engagement_view(s: Session) -> dict[str, Any]:
    """把冻结的 FDE Engagement DAG 投影为前端可跟踪的阶段状态。"""
    from .onto.engagement import build_fde_engagement_dag

    dag = build_fde_engagement_dag()
    current = (
        "INTERVIEW" if s.status == "awaiting_answer"
        else "EXPORT" if s.status == "done"
        else "INTAKE" if s.status in {"idle", "stopped", "failed"}
        else "PROCESS"
    )
    order = dag.topo_order()
    current_index = order.index(current)
    plan = []
    for index, node in enumerate(dag.describe()):
        state = "active" if node["id"] == current else (
            "completed" if index < current_index else "pending"
        )
        plan.append({**node, "state": state})
    return {
        "version": "fde_engagement_v1",
        "frozen": dag.frozen,
        "current": current,
        "plan": plan,
    }


@app.get("/api/sessions/{sid}/state")
async def state(sid: str) -> dict[str, Any]:
    """会话全量状态。

    ``filelist`` 必须一并返回 —— 只给数量的话，重新打开一个会话时前端就没法
    渲染材料列表，"点回原文"这条路直接断掉。
    """
    s = await _sess_async(sid)
    await _refresh_files_projection(s)
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    dm = s.state.get("_dialogue")
    if dm is not None:
        public["dialogue"] = dm.to_dict()
        public["decisions"] = [d.to_dict() for d in dm.active_decisions()]
    public["engagement"] = _engagement_view(s)
    names = [f["name"] for f in s.files]
    # 每份材料的**解析状态**要跟着回去。只给名字和大小的话，界面上没有任何地方
    # 能回答"这份读进来了没有" —— 用户只能去问助手，而助手（在工具回执含糊时）
    # 会猜。状态是事实，应该看得见，不该靠问。
    _chunks = s.state.get("_chunks") or {}
    _scan = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf")
    return {**s.brief(),
            "filelist": [{
                "name": f["name"], "size": f["size"],
                "chunks": len(_chunks.get(f["name"]) or []),
                "state": ("parsed" if _chunks.get(f["name"])
                          else "scan_pending" if f["name"].lower().endswith(_scan)
                          else "unread"),
            } for f in s.files],
            "state": public, "events": len(s.events),
            # 一个空白输入框对新用户是最不友好的界面 —— 他知道这工具能分析
            # 业务文档，但不知道该说什么才有用。
            "prompts": opening_prompts(state=public, files=names, status=s.status),
            # 上一轮那批追问也要还回去。它以前只活在前端内存里，于是**每次重开
            # 会话、每次刷新，chips 就永久消失** —— 恰恰是"接着上次干"的时候。
            "followups": s.state.get("followups") or []}



def s_state_dialogue(s: Session) -> Any:
    """取会话已有的对话记忆，没有就返回 None（不新建 —— 这里只读）。"""
    return s.state.get("_dialogue")


# ══════════════════════════════════════════════════════════════════
#  事件流
# ══════════════════════════════════════════════════════════════════
@app.get("/api/sessions/{sid}/stream")
async def stream(sid: str, since: int = 0) -> StreamingResponse:
    """SSE。repo cursor 是唯一事实源，队列只负责同进程低延迟唤醒。

    每次唤醒（以及定时轮询）都读取 ``seq >= cursor``，因此另一个 worker
    append 的事件一样可见；本地队列和轮询同时命中也只会发送一次。
    """
    s = await _sess_async(sid)
    q: asyncio.Queue = asyncio.Queue()
    s.subscribers.append(q)

    async def gen():
        cursor = max(0, since)
        last_keepalive = time.monotonic()
        try:
            if since == 0:
                # 前端当前固定以 since=0 重连，所以显式清空后按 durable seq 重放。
                yield ('data: {"kind": "stream.reset", "seq": -1, "ts": 0}\n\n')
            while True:
                rows = await get_repo().read_events(sid, since=cursor)
                for row in rows:
                    if row.seq < cursor:
                        continue
                    ev = row.as_sse()
                    cursor = row.seq + 1
                    # hydrate/state/debug consumers仍能看到同一份权威投影；按 seq 去重。
                    if not any(x.get("seq") == row.seq for x in s.events):
                        s.events.append(ev)
                        s.events.sort(key=lambda x: int(x.get("seq", -1)))
                    yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
                try:
                    # 本进程 commit 会立刻唤醒；外部 worker 没共享内存，最多等待
                    # 250ms 的 repo poll。Postgres 的 NOTIFY 可作为未来的纯优化，
                    # 正确性不依赖数据库方言或连接级 LISTEN。
                    await asyncio.wait_for(q.get(), timeout=0.25)
                except TimeoutError:
                    # 每 20 秒发 keepalive，其余 timeout 只是跨 worker cursor 轮询。
                    now = time.monotonic()
                    if now - last_keepalive >= 20:
                        last_keepalive = now
                        yield ": keepalive\n\n"
        finally:
            if q in s.subscribers:
                s.subscribers.remove(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ══════════════════════════════════════════════════════════════════
#  流水线
# ══════════════════════════════════════════════════════════════════
_BUILD_STARTABLE = ("idle", "done", "failed", "stopped")


async def _claim_and_start_build(s: Session, *, tier: str = "full") -> str:
    """Claim one durable build lease and start its local task.

    Every product entry point (HTTP, intent action and ConversationAgent tools)
    uses this boundary.  The returned value is ``started`` or the authoritative
    repository status; ``missing``/``no_files`` are explicit local failures.
    """
    tier = tier if tier in ("full", "flow_preview") else "full"
    async with s.build_lock:
        lease_owner = f"{_WORKER_ID}:{uuid.uuid4().hex}"
        claimed = await get_repo().claim_build_lease(
            s.id,
            owner=lease_owner,
            now=time.time(),
            ttl=_BUILD_LEASE_TTL,
            from_statuses=_BUILD_STARTABLE,
            to_status="queued",
        )
        if not claimed:
            row = await get_repo().get_session(s.id)
            if row is None:
                return "missing"
            s.status, s.error = row.status, row.error
            return row.status

        # Claim 先于 task，保证另一个 worker 即使持有陈旧 Session 投影，也无法
        # 启动第二条付费 DAG。pipeline 一进入就把 token 捕获到局部变量中。
        await _refresh_files_projection(s)
        if not s.files:
            await get_repo().release_build_lease(s.id, owner=lease_owner)
            await get_repo().claim_session_status(
                s.id, from_statuses=("queued",), to_status="idle",
            )
            return "no_files"
        s.status = "queued"
        s.error = ""
        s.build_lease_owner = lease_owner
        try:
            s.run_task = asyncio.create_task(_run_pipeline(s, tier=tier))
        except BaseException:
            await get_repo().release_build_lease(s.id, owner=lease_owner)
            s.build_lease_owner = ""
            await get_repo().claim_session_status(
                s.id, from_statuses=("queued",), to_status="failed",
                error="后台任务未能启动",
            )
            raise
    return "started"


@app.post("/api/sessions/{sid}/build")
async def build(sid: str, tier: str = "full") -> dict[str, Any]:
    s = await _sess_async(sid)
    tier = tier if tier in ("full", "flow_preview") else "full"
    outcome = await _claim_and_start_build(s, tier=tier)
    # 抢不到租约但状态本来就可启动 = 一次争用，不是"在跑"。重试一次再下结论。
    if outcome in _BUILD_STARTABLE:
        outcome = await _claim_and_start_build(s, tier=tier)
    if outcome == "no_files":
        raise HTTPException(400, "还没有上传材料")
    if outcome == "missing":
        raise HTTPException(404, f"没有会话 {sid}")
    if outcome == "awaiting_answer":
        raise HTTPException(409, "当前正在等待业务回答；请先回答、暂缓或导出问题清单。")
    if outcome != "started":
        raise HTTPException(409, f"没能启动梳理（会话状态：{outcome}）")
    return {"started": True, "session": s.id, "tier": tier}


@app.post("/api/sessions/{sid}/stop")
async def stop(sid: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """中断在跑的生成：``target`` 取 ``chat``（对话轮）/ ``run``（梳理任务）/
    ``all``（默认，两者都停）。

    幂等 —— 没有在跑的就是一次 200 空操作。停止意图先落仓储，再取消本 worker
    的 task；远端 worker 由 build heartbeat / chat token watcher 协作取消。
    """
    s = await _sess_async(sid)
    target = (body or {}).get("target") or "all"
    if target not in ("chat", "run", "all"):
        raise HTTPException(400, "target 只能是 chat、run 或 all")
    stopped: list[str] = []
    requested: list[str] = []
    if target in ("chat", "all"):
        durable_chat = await get_repo().request_chat_cancel(sid, now=time.time())
        if s.chat_task and not s.chat_task.done():
            s.chat_task.cancel()
            stopped.append("chat")
        elif durable_chat:
            # The durable lease is fenced, but only its worker can acknowledge task
            # termination.  Do not report a remote request as synchronously stopped.
            requested.append("chat")
    if target in ("run", "all"):
        durable_run = await get_repo().request_build_cancel(sid, now=time.time())
        if s.run_task and not s.run_task.done():
            s.run_task.cancel()
            stopped.append("run")
        elif durable_run:
            s.status = "stopped"
            s.error = ""
            requested.append("run")
    return {"stopped": stopped, "requested": requested}


def _on_run_cancelled(s: Session) -> None:
    """梳理被用户喊停时的收尾：状态落成 ``stopped``，发一条事件让前端把箭头收回。

    不是 ``failed``（没出错，是人喊停），也不回 ``idle``（idle 的文案是"待上传"，
    材料明明在）。``stopped`` 是"跑到一半被停、可以重跑"的独立状态。
    """
    s.status = "stopped"
    s.emit("run.cancelled", reason="用户停止")


async def _run_pipeline(s: Session, *, tier: str = "full") -> None:
    """跑真正的 Harness：解析 → 切段 → DAG 调度抽取 → 合并 → 下游确定性环节。

    抽取**不是一次大调用**。语料按 sheet/章节切段后 fan-out 成多个 DAG 节点，
    每个节点内部是带工具的 agent loop、出来还要过 critic。这是唯一能处理真实
    材料的形态 —— 一次性把几百个切片丢给模型，八成内容会被截掉，而流水线
    还会一路绿灯跑完。
    """
    backend = None
    budget = None
    repo_run_id: str | None = None
    lease_owner = s.build_lease_owner
    owner_task = asyncio.current_task()
    heartbeat_task: asyncio.Task[None] | None = None

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(_BUILD_HEARTBEAT_INTERVAL)
            renewed = await get_repo().renew_build_lease(
                s.id, owner=lease_owner, now=time.time(), ttl=_BUILD_LEASE_TTL,
            )
            if not renewed:
                row = await get_repo().get_session(s.id)
                # A successful owner-fenced terminal checkpoint intentionally makes
                # renew ineligible.  That is normal completion, not cancellation.
                if row is not None and row.status in {
                    "awaiting_answer", "done", "failed",
                }:
                    return
                # Durable stop intent, lease takeover/expiry, or session deletion fences
                # this invocation.  Cancellation is cooperative but reaches every await.
                if owner_task is not None and not owner_task.done():
                    owner_task.cancel()
                return

    try:
        # The route already created this invocation-specific lease.  Capturing it in a
        # local variable avoids ABA if a stopped run is immediately restarted in the
        # same worker and mutates ``s.build_lease_owner``.
        if not lease_owner or not await get_repo().renew_build_lease(
            s.id, owner=lease_owner, now=time.time(), ttl=_BUILD_LEASE_TTL,
        ):
            raise asyncio.CancelledError
        heartbeat_task = asyncio.create_task(
            heartbeat(), name=f"build-heartbeat:{s.id}",
        )
        repo_run_id = await get_repo().next_run(s.id, f"build:{tier}")
        s.status = "parsing"
        s.emit("node.entered", node="PARSE", title="解析材料")
        await _ensure_catalog()          # 按网关可用模型过滤目录（视觉网关/OCR 靠它）
        # resume=True：这条 Run 的日志还在盘上就接着用。上次跑到一半崩了/被停了，
        # 已完成的模型调用直接从日志读回，不重花钱；语料变了 run_id 就变了，
        # 不会误用旧结果。
        run_id = _run_id_for(s)
        resumed = (s.dir / "journal" / f"{run_id}.jsonl").exists()
        backend, gw, smart, budget = _gateways(
            s.dir, run_id, resume=resumed,
            session_id=s.id, kind="build", owner=s.owner)
        if resumed:
            s.emit("flow.step", cite="",
                   found="上次这批材料跑到一半中断了，已完成的部分直接接着用，不重跑。")

        paths = [Path(f["path"]) for f in s.files]
        # 扫描件/图片要过视觉模型，一页可能几十秒。不预告的话界面上就是"解析中"
        # 一动不动，用户分不清在识别还是卡死了。先说清有几份要识别、用什么识别。
        scans = [p for p in paths if p.suffix.lower() in
                 (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf")]
        if scans:
            cat = _CATALOG or ModelCatalog()
            vis = (cat.by_capability().get("vision") or [])
            s.emit("flow.step", cite="", found=(
                f"{len(scans)} 份图片/扫描件要用视觉模型识别（"
                + (f"可用：{'、'.join(vis[:3])}" if vis
                   else "⚠ 网关上没有带视觉的模型，识别会失败")
                + "），单页可能要几十秒。"))
        # 识别进度直接投影进推理面板：一页要几分钟，不报进度的话那几分钟里界面
        # 是死的，用户分不清在识别、还是又挂了。
        docs = await default_registry(
            vision_gateway=smart,
            vision_progress=lambda msg: s.emit("flow.step", cite="", found=msg),
        ).aparse_all(paths)
        index = build_index(docs)
        endpoints = collect_endpoints(docs)
        profiles = collect_profiles(docs)
        # 留给 _recompile —— 没有它们，重出模板时接口反推那类冲突会凭空消失，
        # 用户会以为"改了个决定，怎么少了几条冲突"。
        s.state["_endpoints"] = endpoints
        s.state["_profiles"] = profiles
        # 对话侧的推理循环要靠它检索材料。不存的话对话只能凭 OIR 说话，
        # 而"这句话在材料哪里"恰恰是 FDE 最常问的。
        s.state["_index"] = index
        summary = corpus_summary(docs)
        s.state["corpus"] = summary
        s.state["_chunks"] = _chunk_cache(docs)
        await _build_flow_diagram(s, docs)
        await _persist(s, lease_owner=lease_owner)
        s.emit("node.completed", node="PARSE",
               stats={"files": len(paths), "chunks": len(index),
                      "endpoints": len(endpoints), "profiles": len(profiles)},
               findings=summary["findings"])

        # 免费流程预览：流程图已出，到此为止 —— 不进 EXTRACT 那条付费 DAG。
        # 文本/表格/SQL 语料到这里零模型成本；扫描件/PDF 因视觉解析会有少量费用。
        if tier == "flow_preview":
            s.status = "done"
            await _persist(s, lease_owner=lease_owner)
            fstats = (s.state.get("flow") or {}).get("stats") or {}
            s.emit("run.completed", stats={"tier": "flow_preview", **fstats})
            await get_repo().finish_run(repo_run_id, status="done")
            asyncio.create_task(_emit_ai_prompts(s, slot="opening"))
            return

        # ── 切段并冻结计划 ─────────────────────────────────────
        segments = segment_corpus(index, docs)
        # 产品主线使用完整 FDE Engagement DAG 作为稳定的控制面：材料内容只能
        # 决定某个节点看哪些证据，不能增删角色、工具或跳过 HITL/Review/Export。
        # 现有 EXTRACT fan-out 是 PROCESS/DATA/RULES 节点内部的数据并行实现，
        # 不是另一条偷偷存在的产品流程。
        from .onto.engagement import build_fde_engagement_dag
        engagement = build_fde_engagement_dag()
        s.emit("engagement.frozen", version=engagement.name,
               nodes=engagement.describe(), current="PROCESS")
        s.emit("plan.frozen", segments=[{"key": g.key, "label": g.label,
                                         "file": g.file_name, "chunks": len(g.chunk_ids)}
                                        for g in segments],
               note="段数来自材料结构（有几个 sheet/章节），不来自内容 —— 计划冻结成立")
        if not segments:
            # 「材料里没有可抽取的内容」对着一份明明有内容的流程图说，等于什么都
            # 没说 —— 真正发生的多半是**上游没读出东西**（扫描件识别失败/超时）。
            # 把每份材料的实际情况和解析阶段的告警一起说出来，别让人去猜。
            detail = "；".join(
                f"{d.file_name} 读出 {len(d.chunks)} 段" for d in docs) or "没有材料"
            warns = [f.message for d in docs for f in d.findings
                     if f.kind in ("vision_failed", "empty_ocr", "no_vision_model")]
            raise RuntimeError(
                "没有可抽取的内容：" + detail
                + ("。原因：" + "；".join(warns[:3]) if warns else
                   "。材料可能是空的，或格式无法解析。"))

        # ── 装配 Harness ───────────────────────────────────────
        s.status = "extracting"
        agent = default_agents().get("extractor")
        skills = default_library()
        system = agent.render_system(skills) + "\n\n" + skills.load(list(agent.skills))

        bus = AgentBus(gw.rec)
        # HTTP 服务绝不把宿主 LocalSubprocessSandbox 暴露给不可信材料。确需
        # CodeAct 的部署必须显式开启，并且 production=True 会 fail-closed
        # 地选择 gVisor；运行时缺失时执行失败，不会退回本机子进程。
        codeact_enabled = os.getenv("ONTOCOPILOT_ENABLE_CODEACT", "").lower() in {
            "1", "true", "yes",
        }
        sandbox = default_sandbox(production=True) if codeact_enabled else None
        tools = builtin_registry(evidence=index, profiles=profiles, sandbox=sandbox)
        bus.board.write("_tools", tools, by="bootstrap")

        cm = ContextManager(system=system, evidence=index, budget_tokens=90_000)
        # 对话里拍下的板要真的作用到每个抽取节点上。ContextManager 是 Run 作用域
        # 的局部对象，HTTP 层碰不到它 —— 所以必须在这里、Run 起来的时候灌进去。
        # 不灌的话，"我记下了你的口径约定"就是一句空话：它躺在会话状态里，
        # 一个节点也看不见。
        dm = s_state_dialogue(s)
        for d in dm.active_decisions() if dm else ():
            cm.reflect(f"用户已拍板：{d.render()}")
        # 也挂到黑板上 —— 黑板事实会随 bus.render_facts() 进下一个节点的 prompt，
        # 和 L3 是两条独立通路，任何一条断了另一条还在。
        for i, d in enumerate(dm.active_decisions() if dm else ()):
            bus.post(f"decision.{d.kind}.{i}", d.render(), by="user", confidence=1.0)
        panel = CriticPanel({"coverage": CoverageCritic(segments, index),
                             "provenance": provenance_critic()}, gw.rec)
        loop = AgentLoop(gateway=gw, ctx_manager=cm, panel=panel, bus=bus,
                         recorder=gw.rec, budget=budget,
                         handlers=handlers_for(segments, index, agent, system))
        dag = build_dag(segments)
        sched = Scheduler(dag, loop, gw.rec, bus, budget, concurrency=4)

        s.emit("node.entered", node="EXTRACT",
               title=f"抽取 · {len(segments)} 段并行", segments=len(segments))
        _pump_kernel_events(s, gw.rec, bus)
        # 抽取是整条链最长的一段。只在开始/结束各泵一次，等于抽取全程「推理」面板
        # 一片空白 —— FDE 看到的是一个转圈的进度条，看不见 AI 在想什么、查了什么，
        # 分不清"在干活"和"卡住了"。这里边跑边泵，让推理实时可见。
        # 用同一个 run_id —— 调度器另起一个 id 的话，恢复索引和它写的日志就对不上，
        # resume 会永远命不中。
        outcome = await _run_with_live_trace(s, gw.rec, bus, sched.run(run_id))

        if not outcome.ok:
            raise RuntimeError(f"抽取失败：{outcome.error}")

        merged = outcome.outputs.get("MERGE") or {}
        oir = build_oir(merged, index)
        stale_oir = _replay_oir_patches(s, oir)
        if stale_oir:
            s.emit("oir.stale_edits", count=len(stale_oir),
                   items=[{"op": x["op"], "why": x["why"]} for x in stale_oir])
        # 流程图和接口清单在这里接起来。图是 PARSE 阶段就出的（那时还没有 OIR），
        # 所以只能等到这一步：每个流程环节标上实现它的接口，接完再重出一次产物。
        link_gaps = _link_flow_to_api(s, oir)
        # 待澄清问题的四个来源在这里合流，客户不需要知道哪条是谁提的：
        #   · 材料里本来就有的问卷（规则逐行搬进来的，asked_by=customer）
        #   · 流程图上标黄的缺口 —— 不只画图，还指出图里哪儿是空的
        #   · 流程与接口对不上的地方 —— 哪一步没有系统支撑、哪个写接口不在流程里
        #   · 从证据里挖的缺口 —— 占位符、空表、待确认的取值清单、结构空位
        # 后两条以前都不存在：材料没带问卷时，这张表就只剩三四行系统自问自答。
        from .onto.gaps import mine_questions

        mined = mine_questions(oir, docs=docs, chunks=index.all_chunks(),
                               extra=list(s.state.get("_flow_gaps") or ()),
                               extra_gaps=link_gaps)
        for q in mined:
            if q.rid not in oir.questions:
                oir.add_question(q)
        s.emit("gaps.mined", count=len(mined),
               groups=sorted({q.group for q in mined if q.group})[:12])
        s.emit("node.completed", node="EXTRACT",
               stats=oir.stats(), segments=len(segments),
               usd=round(budget.snapshot()["spent"]["usd"], 4))

        # ── 下游：全部确定性 ───────────────────────────────────
        s.emit("node.entered", node="FINISH", title="对齐 → 冲突 → 澄清 → 模板")
        s.emit("engagement.stage", node="GAP",
               deps=["PROCESS", "ERP_MAP", "RULES", "DATA_OBJECTS"])
        res = finish(oir, endpoints=endpoints, profiles=profiles,
                     project=s.project or s.title)
        conflicts = res["conflicts"]
        kinds: dict[str, int] = {}
        for c in conflicts:
            kinds[str(c.kind)] = kinds.get(str(c.kind), 0) + 1
        s.emit("node.completed", node="ALIGN", stats=res["align"],
               merged=res["merged"], uncertain=res["uncertain"])
        s.emit("node.completed", node="CONFLICT", kinds=kinds,
               auto_repaired=res["auto_repaired"],
               conflicts=[c.to_dict() for c in conflicts])

        cs = res["clarify"]
        s.state["oir"] = oir.to_dict()
        s.state["conflicts"] = [c.to_dict() for c in conflicts]
        s.state["questions"] = [q.to_dict() for q in cs.questions]
        s.state["routing"] = cs.summary()
        s.state["budget"] = budget.snapshot()
        s.state["_oir"] = oir
        s.state["_conflicts"] = conflicts
        s.state["suggestions"] = res.get("suggestions") or []
        backlog = await _sync_question_backlog(
            s, oir=oir, clarification=cs.questions, conflicts=conflicts,
        )
        s.emit("clarify.request", questions=s.state["questions"], routing=cs.summary())
        # 梳理挂起等 FDE 拍板 —— 这正是他下一步要问的时候，出一版结合全量产物的开场。
        asyncio.create_task(_emit_ai_prompts(s, slot="opening"))
        if s.state["suggestions"]:
            # 建议不阻塞 —— 单独发一条事件，前端另起一栏，不要塞进问题流里让人
            # 误以为必须先答完才能继续。
            s.emit("suggest.ready", suggestions=s.state["suggestions"])

        # ── 可执行的产品 Engagement DAG ───────────────────────────
        # 成熟 EXTRACT fan-out 已完成唯一一轮付费材料理解。专业节点以它的 OIR/Flow
        # 为 seed，通过规则型 skip_model 形成各自契约；但节点调度、checkpoint、HITL
        # 与 release gate 都是真实 Scheduler 执行，而不是 UI 进度事件的模拟。
        from datetime import datetime

        from .onto.engagement_runtime import (
            EngagementRuntimeInput,
            engagement_critics,
            engagement_handlers,
        )

        runtime = EngagementRuntimeInput(
            session_id=s.id,
            project=s.project or s.title,
            oir=oir,
            flow=s.state.get("_flow"),
            backlog=backlog,
            decisions=list(s.state.get("decision_ledger") or ()),
            corpus=s.state.get("corpus") or {},
            artifact_revision=int(s.state.get("artifact_revision") or 0),
            # Recorder 重放要求输出确定。会话创建时刻对同一语料 run 始终稳定。
            generated_at=datetime.fromtimestamp(s.created, UTC).isoformat(),
            release_downloadable=os.access(s.dir, os.W_OK),
        )
        # The question/decision API must resume this exact content-addressed
        # Recorder after INTERVIEW.  Persist the identity with the suspended
        # session; deriving it again after files change would target another run.
        s.state["engagement_run_id"] = run_id
        engagement_loop = AgentLoop(
            gateway=gw,
            ctx_manager=cm,
            panel=CriticPanel(engagement_critics(), gw.rec),
            bus=bus,
            recorder=gw.rec,
            budget=budget,
            handlers=engagement_handlers(runtime),
        )
        engagement_sched = Scheduler(
            engagement,
            engagement_loop,
            gw.rec,
            bus,
            budget,
            concurrency=4,
        )
        engagement_outcome = await _run_with_live_trace(
            s, gw.rec, bus, engagement_sched.run(run_id),
        )
        s.state["engagement_execution"] = {
            "status": str(engagement_outcome.status),
            "completed": sorted(engagement_outcome.results),
            "restored": sorted(engagement_outcome.skipped),
            "pendingHuman": engagement_outcome.pending_human,
        }
        if engagement_outcome.status is RunStatus.SUSPENDED:
            s.status = "awaiting_answer"
            pending_human = engagement_outcome.pending_human or {}
            s.emit(
                "engagement.stage",
                node="INTERVIEW",
                contract="QuestionBacklog",
                pending=int(pending_human.get("pending") or len(_pending_questions(s))),
            )
            s.emit("run.suspended", reason="等待 FDE 拍板")
            # OIR、冲突与问题在等待人回答前必须是同一个持久检查点。以前持久化发生
            # 在这些字段赋值之前，主 HITL 路径一重启就只剩旧版本。
            await _persist(s, lease_owner=lease_owner)
            await get_repo().finish_run(
                repo_run_id, status="suspended",
                budget=budget.snapshot() if budget is not None else {})
            return
        if not engagement_outcome.ok:
            raise RuntimeError(f"FDE Engagement 失败：{engagement_outcome.error}")
        export_plan = engagement_outcome.outputs.get("EXPORT") or {}
        if not (export_plan.get("review_passed")
                and export_plan.get("schema_valid")
                and export_plan.get("downloadable")):
            raise RuntimeError("FDE Engagement EXPORT 硬门未通过，已阻止交付")
        s.state["release_state"] = str(export_plan.get("releaseState") or "RELEASED")
        s.emit(
            "engagement.stage",
            node="EXPORT",
            contract="OntologyPackage.v1",
            artifacts=export_plan.get("artifacts") or [],
        )
        # 只有 REVIEW/EXPORT gate 已提交，现有原子 release 边界才真正写盘。
        await _compile(s, lease_owner=lease_owner)
        await get_repo().finish_run(
            repo_run_id, status="done",
            budget=budget.snapshot() if budget is not None else {})
    except asyncio.CancelledError:
        # 用户点了停止 —— CancelledError 是 BaseException，不会被下面的
        # `except Exception` 吞掉。收尾后**照常重抛**，让任务干净地结束。
        # A remote /stop already owns the durable ``stopped`` state.  Local cancellation
        # projects it in memory.  Do not write status *or documents* here: the lease may
        # have expired and a new invocation may already own the session.  Any unfenced
        # cleanup write could stop or overwrite that newer run (classic stale writer).
        _on_run_cancelled(s)
        row = await get_repo().get_session(s.id)
        if row is not None:
            s.status, s.error = row.status, row.error
        if repo_run_id is not None:
            await get_repo().finish_run(repo_run_id, status="failed", error="cancelled")
        raise
    except Exception as exc:  # noqa: BLE001 — 服务边界，错误要送到前端而不是吞掉
        s.status = "failed"
        s.error = f"{type(exc).__name__}: {exc}"
        s.emit("run.failed", error=s.error)
        try:
            await _persist(s, lease_owner=lease_owner)
        except asyncio.CancelledError:
            # A durable stop/stale-owner fence already chose the public status.
            if repo_run_id is not None:
                await get_repo().finish_run(
                    repo_run_id, status="failed", error="cancelled",
                    budget=budget.snapshot() if budget is not None else {},
                )
            raise
        if repo_run_id is not None:
            await get_repo().finish_run(
                repo_run_id, status="failed", error=s.error,
                budget=budget.snapshot() if budget is not None else {})
    finally:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
        if lease_owner:
            await get_repo().release_build_lease(s.id, owner=lease_owner)
            if s.build_lease_owner == lease_owner:
                s.build_lease_owner = ""
        if backend is not None:
            await backend.aclose()


#: 内核事件里值得推到前端的那些。**推理轨迹是事件日志的投影**，不是另一套埋点 ——
#: 两套埋点必然漂移，漂移那天你不会知道该信哪个。
_KERNEL_TRACE = {
    EventKind.NODE_ENTERED: "kernel.node_entered",
    EventKind.NODE_COMPLETED: "kernel.node_completed",
    EventKind.NODE_FAILED: "kernel.node_failed",
    EventKind.PLAN_CREATED: "kernel.plan",
    EventKind.THOUGHT: "kernel.thought",
    EventKind.OBSERVATION: "kernel.observation",
    EventKind.CRITIC_VERDICT: "kernel.critic",
    EventKind.DEGRADED: "kernel.degraded",
    EventKind.BUDGET_SPENT: "kernel.spend",
}


def _pump_kernel_events(s: Session, rec: Any, bus: Any) -> None:
    """把内核事件日志里的新事件投影到会话事件流。"""
    seen = s.state.setdefault("_kernel_seq", 0)
    latest = seen
    for ev in rec.journal.read(rec.run_id):
        if ev.seq < seen or ev.kind not in _KERNEL_TRACE:
            latest = max(latest, ev.seq + 1)
            continue
        latest = max(latest, ev.seq + 1)
        s.emit(_KERNEL_TRACE[ev.kind], node=ev.node_id or "",
               detail=_trace_detail(ev))
    s.state["_kernel_seq"] = latest


async def _run_with_live_trace(s: Session, rec: Any, bus: Any, coro: Any,
                               *, every: float = 1.0) -> Any:
    """跑一段长任务，同时按节拍把内核推理事件泵到会话事件流。

    抽取要跑几分钟；不边跑边泵的话，「推理」面板在这几分钟里是空的，FDE 看不出
    AI 到底在想什么、有没有卡住。泵本身只是读日志 + emit，很便宜。
    """
    task = asyncio.ensure_future(coro)
    try:
        while not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=every)
            except TimeoutError:
                pass
            _pump_kernel_events(s, rec, bus)   # 每拍泵一次，异常不吞（泵失败要暴露）
        return await task
    finally:
        _pump_kernel_events(s, rec, bus)       # 收尾再泵一次，别漏最后几条


def _trace_detail(ev: Any) -> str:
    p = ev.payload or {}
    if ev.kind is EventKind.CRITIC_VERDICT:
        head = f"{p.get('lens')} {'通过' if p.get('passed') else '未通过'}"
        first = (p.get("findings") or [{}])[0].get("claim", "")
        return f"{head}　{first[:90]}" if first else head
    if ev.kind is EventKind.THOUGHT:
        return str(p.get("text", ""))[:160]
    if ev.kind is EventKind.OBSERVATION:
        return f"{p.get('tool', '')} → {str(p.get('summary', ''))[:110]}"
    if ev.kind is EventKind.BUDGET_SPENT:
        return f"{p.get('model')} {p.get('tok_in')}→{p.get('tok_out')} ${p.get('usd')}"
    if ev.kind is EventKind.PLAN_CREATED:
        return "；".join(str(x.get("goal", ""))[:40] for x in (p.get("steps") or [])[:4])
    return str({k: v for k, v in p.items() if k in ("mode", "attempt", "error", "label")})





#: 会持久化的公开状态 key。私有（``_`` 开头）的一律不存 —— 它们要么是活对象
#: （OIR、证据索引），要么是能重算的（列画像），存了反而制造第二份真相。
_PERSISTED = ("oir", "flow", "template", "artifacts", "questions", "question_backlog",
              "decision_ledger", "suggestions", "corpus", "budget", "routing", "answered", "audit",
              "mode", "model", "artifact_revision", "ontology_package",
              "engagement_run_id", "engagement_execution", "release_state",
              # 上一轮的追问 chips。落库是因为它是**会话的一部分**：重开会话时
              # "接下来能问什么"必须还在，而不是让人对着一段旧对话重新想。
              "followups")

#: 私有的版本/补丁栈也要落库 —— 它们是「撤销历史」和「重跑时要重放的人工补丁」，
#: 恰恰是最不该随重启丢掉的一份状态（`_flow_versions`/`_tpl_versions` 以前只在内存，
#: 重启后 undo 历史全没）。都是 `_` 前缀，`/state` 路由照旧剥离、不外泄；也不在
#: DERIVED_KEYS 里，所以以 derived=False 存、hydrate 时原样载回。这里把 Batch 4/5
#: 才写入的 `_oir_versions`/`_*_patch_log` 一并列上 —— `_persist` 只落已存在的 key，
#: 提前列上无害，省得回头再改这处。
_PERSISTED_PRIVATE = ("_flow_versions", "_tpl_versions", "_oir_versions",
                      "_flow_patch_log", "_tpl_patch_log", "_oir_patch_log")
#: 单栈封顶，防一个长命进程每编辑一次就把栈顶到天上。撤销深度 20 够用。
_VERSION_STACK_CAP = 20

#: 私有的**非栈**状态：整体存、不做尾部截断（上面那圈 `stack[-CAP:]` 是给列表用的，
#: 套在 dict 上会直接 TypeError）。
#:
#: ``_chunks`` 必须在这里：``store/const.py`` 把它排除在 DERIVED_KEYS 之外，理由写得
#: 很清楚 —— 扫描件重建要再花一次视觉模型的钱，而且 OCR 结果可能和当初抽取时不一样，
#: 那样"点回原文"看到的就不是系统真正读过的东西。但它从来没被写进任何持久化白名单，
#: 于是**每次重启，付费 OCR 出来的切片全丢**，`/source` 对一份已经识别过的材料回
#: "尚未解析"。这就是那条注释描述的后果本身。
#: ``_cards`` 同理：事件流是进程内的，但其中**承载内容**的那几条（AI 列出来的表、
#: 导出的文件）重开会话必须还在，否则用户以为东西丢了。见 ``Session.emit``。
_PERSISTED_PRIVATE_DOCS = ("_chunks", "_cards", "_tables", "_pending_actions", "_pending_action",
                           "_last_reason", "_chat_usd")
# Chat reasoning always owns these documents.  Keeping the set explicit lets an
# optimistic-CAS retry merge a turn over a simultaneous build checkpoint without
# resubmitting stale OIR/flow, and lets build retry without erasing that turn.
_CHAT_OWNED_DOCS = frozenset({
    "dialogue", "_pending_actions", "_pending_action", "_last_reason", "_chat_usd",
    # 这一轮的 chips 跟着这一轮的回答走，和 dialogue 同属对话侧 —— 并发的梳理
    # checkpoint 不该把它们盖掉，也不该被它们盖掉。
    "followups",
})

#: 产物 → 给业务方看的表：每类挑**看得懂**的列，不是把内部结构原样倒出来。
#:
#: 放在模块级而不是 `_ui_table` 里面，是因为**导出必须和屏幕上看到的是同一张表**。
#: 各写一份的话，AI 列出来的表和导出的 xlsx 迟早会不一样列、不一样条数，而用户
#: 会拿导出的那份去跟客户对话 —— 那时候没人知道哪份是对的。
_OIR_LABEL = {"objects": "业务对象", "properties": "属性", "links": "关系",
              "actions": "动作", "rules": "业务规则", "questions": "待澄清问题"}


def _oir_val(x: Any) -> str:
    return str((x or {}).get("value", "") if isinstance(x, dict) else (x or ""))


_OIR_COLS: dict[str, list[tuple[str, Any]]] = {
    "objects": [("名称", lambda o: _oir_val(o.get("displayName"))),
                ("API 名", lambda o: _oir_val(o.get("apiName"))),
                ("说明", lambda o: _oir_val(o.get("description"))[:120]),
                ("状态", lambda o: o.get("status", ""))],
    "properties": [("所属对象", lambda p: p.get("parent", "")),
                   ("字段", lambda p: _oir_val(p.get("displayName"))),
                   ("API 名", lambda p: _oir_val(p.get("apiName"))),
                   ("类型", lambda p: _oir_val(p.get("baseType"))),
                   ("口径", lambda p: _oir_val(p.get("definition"))[:100])],
    "links": [("从", lambda l: l.get("from", "")),
              ("到", lambda l: l.get("to", "")),
              ("名称", lambda l: _oir_val(l.get("apiName"))),
              ("基数", lambda l: _oir_val(l.get("cardinality")))],
    "actions": [("动作", lambda a: _oir_val(a.get("apiName"))),
                ("作用对象", lambda a: "、".join(a.get("appliesTo") or []))],
    "rules": [("规则", lambda r: _oir_val(r.get("statement"))),
              ("类别", lambda r: _oir_val(r.get("ruleKind"))),
              ("角色", lambda r: _oir_val(r.get("actor")))],
    "questions": [("问题", lambda q: _oir_val(q.get("text"))),
                  ("答复", lambda q: _oir_val(q.get("answer"))),
                  ("编号", lambda q: q.get("code", ""))],
}


def _oir_table(oir: dict[str, Any], kind: str,
               contains: str = "") -> tuple[str, list[str], list[list[str]]]:
    """产物里的一类东西 → (中文类名, 表头, 行)。"""
    items = list((oir or {}).get(kind) or [])
    cols = _OIR_COLS[kind]
    if contains:
        k = contains.lower()
        items = [x for x in items if k in json.dumps(x, ensure_ascii=False).lower()]
    return (_OIR_LABEL[kind], [name for name, _ in cols],
            [[fn(x) for _, fn in cols] for x in items])


class _NoRows(Exception):
    """材料里读不出行时抛出，消息就是给模型看的回执。"""


def _sheet_rows(path: Path) -> dict[str, list[dict[str, Any]]]:
    """表格文件 → {表名: [ {列名: 值} ]}。**全量，不截断。**

    xlsx 走解析器的 row 切片（一行一片、``raw`` 就是列名→值）。csv/tsv **不能**走
    这条路：``CsvParser`` 压根不产 ``row`` 切片 —— 它只出一片 schema 加最多 20 片
    ``sample``，于是按 tag 过滤会把 csv 的每一行都丢掉，工具对任何 csv 都回
    "没读出数据行"，而工具描述和后缀白名单都写着支持 csv。这里对 csv 自己读一遍。
    """
    if path.suffix.lower() in (".csv", ".tsv"):
        import csv as _csv

        from .onto.parse.tabular import _read_text, dedupe_headers, detect_header_row

        text, _ = _read_text(path)
        delim = "\t" if path.suffix.lower() == ".tsv" else None
        if delim is None:
            try:
                delim = _csv.Sniffer().sniff(text[:4096], ",;\t|").delimiter
            except Exception:                                     # noqa: BLE001
                delim = ","
        grid = [[(c or "").strip() for c in r]
                for r in _csv.reader(text.splitlines(), delimiter=delim)]
        grid = [r for r in grid if any(r)]
        if not grid:
            return {}
        h = detect_header_row(grid)
        width = max(len(r) for r in grid)
        header = (dedupe_headers(grid[h]) if h >= 0
                  else [f"col{i + 1}" for i in range(width)])
        body = grid[h + 1:]
        return {path.stem: [{header[i]: r[i] for i in range(min(len(header), len(r)))}
                            for r in body if any(r)]}

    doc = default_registry().parse(path)
    out: dict[str, list[dict[str, Any]]] = {}
    for c in doc.chunks:
        if "row" not in (c.tags or ()):
            continue
        out.setdefault((c.locator or {}).get("sheet") or path.stem, []).append(c.raw or {})
    return out


def _material_table(s: Session, file: str, sheet: str = "", contains: str = "",
                    columns: list[str] | None = None
                    ) -> tuple[str, str, list[str], list[list[str]], dict[str, Any]]:
    """材料里的一张表 → (文件名, 表名, 列, **全部**行, 附注)。

    ``material.rows`` 和导出共用这一个 —— 各读各的，迟早会一个 500 行一个 900 行，
    而用户会拿导出的那份去跟客户对话。附注里带 blank/missing 列信息给回执用。
    """
    f = _match_file(s, file)
    if not f:
        raise _NoRows(f"没有材料「{file}」。现有：{[x['name'] for x in s.files]}")
    path = Path(f.get("path") or (s.dir / "materials" / f["name"]))
    if path.suffix.lower() not in _TABULAR_EXT:
        raise _NoRows(f"「{f['name']}」不是表格（{path.suffix or '无后缀'}），没有"
                      f"「行」可列。正文内容用 evidence.search。")
    try:
        by_sheet = _sheet_rows(path)
    except Exception as exc:                                      # noqa: BLE001
        raise _NoRows(f"读不了「{f['name']}」：{type(exc).__name__}: {exc}") from None
    if not by_sheet:
        raise _NoRows(f"「{f['name']}」里没读出数据行。")

    names = list(by_sheet)
    pick = (sheet if sheet in by_sheet else
            next((n for n in names if sheet and sheet in n), ""))
    if not pick:
        if sheet:
            raise _NoRows(f"没有工作表「{sheet}」。现有：{names}")
        if len(names) > 1:
            raise _MultiSheet({n: len(v) for n, v in by_sheet.items()})
        pick = names[0]

    data = by_sheet[pick]
    cols = list({k: None for r in data for k in r})
    note: dict[str, Any] = {}
    if columns:
        want = [c for c in cols if c in columns]
        if not want:
            raise _NoRows(f"这些列都不存在：{columns}。现有列：{cols}")
        if [c for c in columns if c not in cols]:
            note["没有这几列"] = [c for c in columns if c not in cols]
        cols = want
    if contains:
        k = contains.lower()
        data = [r for r in data
                if k in " ".join(str(v) for v in r.values()).lower()]
    live = [c for c in cols if any(str(r.get(c, "")).strip() for r in data)]
    if len(cols) - len(live):
        note["隐藏的空列"] = f"{len(cols) - len(live)} 个整列都是空的，没列出来"
    cols = live or cols
    return (f["name"], pick, cols,
            [[str(r.get(c, "") or "") for c in cols] for r in data], note)


class _MultiSheet(Exception):
    def __init__(self, sheets: dict[str, int]) -> None:
        self.sheets = sheets


def _full_rows_for(s: Session, ev: dict[str, Any]) -> list[list[str]] | None:
    """按事件里记的**来源配方**重新算一遍全量行。

    事件里的 ``rows`` 是**给屏幕看的**，封了顶（_ROWS_MAX）。文件没有这个限制 ——
    导出继承屏幕的截断，就会出现一个叫「问题清单（900 行）.xlsx」、里面只有 500 行
    的文件，而 FDE 会把它当完整清单发给客户。所以导出按配方重算，不读 rows。
    """
    src = ev.get("src") or {}
    try:
        if src.get("kind") == "oir":
            _, _, rows = _oir_table(s.state.get("oir") or {},
                                    src["oir_kind"], src.get("contains", ""))
            return rows
        if src.get("kind") == "material":
            _, _, _, rows, _ = _material_table(
                s, src["file"], src.get("sheet", ""), src.get("contains", ""),
                src.get("columns") or None)
            return rows
    except Exception:                                             # noqa: BLE001
        return None            # 重算不出来就退回事件里那份，并在 note 里说清
    return None


def _last_card_table(s: Session) -> dict[str, Any] | None:
    """上一次用 ``ui.table`` 卡片列出来的表。"""
    for ev in reversed(s.events):
        if ev.get("kind") == "ui.table":
            return ev
    for ev in reversed(s.state.get("_cards") or []):     # 事件流是进程内的，兜一层
        if ev.get("kind") == "ui.table":
            return ev
    return None


def _match_file(s: Session, raw: str) -> dict[str, Any] | None:
    """按名字找一份材料。全等 → 解码后全等 → 子串。

    模型很爱把中文文件名**百分号编码**了再传（把它当 URL 片段）。同一个名字在
    material.parse 里靠子串蒙混过去、在 evidence.search 里却直接"没有这些材料"，
    模型就会以为文件没读进来，转头去猜答案。名字在哪个工具里都得是同一个意思。
    """
    from urllib.parse import unquote

    cand = [raw]
    if "%" in raw:
        dec = unquote(raw)
        if dec != raw:
            cand.append(dec)
    for x in cand:
        hit = next((f for f in s.files if f["name"] == x), None)
        if hit:
            return hit
    for x in cand:
        hit = next((f for f in s.files if x and x in f["name"]), None)
        if hit:
            return hit
    return None


def _tables_in_text(text: str, ts: float) -> list[dict[str, Any]]:
    """一条回答正文里的所有表格（markdown 竖线表），各自带上它的标题。

    模型经常不调 ``ui.table``，而是直接把表写进回答里 —— 访谈提纲这类一次性的
    东西本来就不是"产物清单"。标题取表格前面最近的那个小标题或加粗行：模型写
    「**AI 招聘业务流程梳理及访谈提问框架**」这种很常见，而用户回头正是**用这个
    名字**来指它的。
    """
    from .onto import export as X

    out: list[dict[str, Any]] = []
    blocks = X.blocks_from_markdown(text or "")
    for i, b in enumerate(blocks):
        if b.kind != "table" or not b.rows:
            continue
        title = ""
        for prev in reversed(blocks[:i]):
            cand = (prev.text or "").strip()
            if prev.kind in ("heading", "para") and 0 < len(cand) <= 60:
                title = cand
                break
        out.append({"kind": "ui.table", "ts": float(ts or 0),
                    "title": title or "清单", "columns": list(b.columns),
                    "rows": [list(r) for r in b.rows], "total": len(b.rows)})
    return out


async def _conversation_tables(s: Session) -> list[dict[str, Any]]:
    """这个会话里出现过的**全部**表格，按时间从早到晚。

    两个来源都要，缺一不可：

    * **耐久事件表**（``chat.turn``）—— 这是完整历史。DialogueMemory 会压缩：
      超预算时最老的几轮被合并成一句摘要，原文就没了。用户过两轮回头说"把刚才
      那张 AI 招聘表导出来"时，那条回答很可能已经被压掉 —— 只看 DialogueMemory
      就会翻出**另一张**表给他，这正是他下载到的东西不对的原因。
    * **当前 DialogueMemory** —— 兜住耐久事件还没落库、以及历史遗留会话。

    按 (ts, 标题, 行数) 去重，两边重复的算一份。
    """
    seen: dict[tuple, dict[str, Any]] = {}

    def take(rec: dict[str, Any]) -> None:
        key = (round(float(rec.get("ts") or 0), 3), rec.get("title"),
               len(rec.get("rows") or []))
        seen.setdefault(key, rec)

    try:
        rows = await get_repo().read_events(s.id, since=0)
    except Exception:                                       # noqa: BLE001
        rows = []
    for row in rows:
        ev = row.as_sse()
        if ev.get("kind") == "ui.table" and ev.get("rows"):
            take({**ev, "ts": float(ev.get("ts") or 0)})
        elif ev.get("kind") == "chat.turn":
            turn = ev.get("turn") or {}
            if str(turn.get("speaker")) == "assistant":
                for rec in _tables_in_text(turn.get("text") or "",
                                           float(turn.get("ts") or ev.get("ts") or 0)):
                    take(rec)

    for ev in list(s.events) + list(s.state.get("_cards") or []):
        if ev.get("kind") == "ui.table" and ev.get("rows"):
            take({**ev, "ts": float(ev.get("ts") or 0)})
    for rec in s.state.get("_tables") or []:          # 压缩前存下来的那份
        take(dict(rec))
    for t in _dialogue(s).turns:
        if str(t.speaker) == "assistant":
            for rec in _tables_in_text(t.text or "", float(t.ts or 0)):
                take(rec)

    return sorted(seen.values(), key=lambda r: float(r.get("ts") or 0))


def _pick_table(tables: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    """按名字挑一张表；没给名字就是最后出现的那张。

    用户点了名（"导出成 Excel：AI 招聘业务流程梳理及访谈提问框架"）却还是拿最后
    一张，就会把**另一张**表发给他 —— 他会以为系统记错了，实际是代码没听。
    """
    if not tables:
        return None
    if not name:
        return tables[-1]
    key = name.strip().lower()
    # 先全等、再包含、再反向包含（用户常把标题抄短或抄长一点）
    for match in (lambda t: t == key,
                  lambda t: key in t,
                  lambda t: t in key and len(t) >= 4):
        hit = [r for r in tables if match(str(r.get("title") or "").strip().lower())]
        if hit:
            return hit[-1]
    return None


async def _last_table(s: Session, name: str = "") -> dict[str, Any] | None:
    """用户说「这个表」指的那张。

    给了名字就**按名字挑**——他点名要「AI 招聘业务流程梳理及访谈提问框架」，
    结果拿到最后一张（另一个话题的对比表），只会以为系统记错了。
    没给名字才是"最后出现的那张"。
    """
    return _pick_table(await _conversation_tables(s), name)


async def _export_doc(s: Session, source: str, contains: str,
                      title: str, table_name: str = "") -> tuple[Any, dict[str, Any]]:
    """按 source 组装要导出的内容。返回 (ExportDoc | None, 组不出来时的回执)。

    组不出来时**要说清是哪一步没有东西**：一句"导出失败"会让模型转头跟用户说
    "系统限制"，而真实原因往往是他还没列过表、或者还没跑梳理 —— 那是能补的。
    """
    from .onto import export as X

    if source == "questions" and s.state.get("question_backlog"):
        backlog = _question_backlog(s)
        items = list(backlog.questions.values())
        if contains:
            needle = contains.lower()
            items = [q for q in items if needle in json.dumps(
                q.to_dict(), ensure_ascii=False).lower()]
        if not items:
            return None, {"error": "统一问题台账里没有符合条件的问题。"}
        head = ["问题ID", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问"]
        rows = [[q.id, q.text, str(q.status), str(q.priority), q.audience_role,
                 q.owner_user_id, q.why] for q in items]
        return X.ExportDoc(
            title=title or "待澄清问题",
            blocks=X.table_block(head, rows),
            note=f"共 {len(rows)} 条，由统一 QuestionBacklog 导出",
        ), {}

    if source in _OIR_COLS:
        oir = s.state.get("oir") or {}
        if not (oir.get(source) or []):
            return None, {"error": f"还没有 {source} —— 梳理还没跑过或这一类是空的。",
                          "下一步": "如果他要导的是**自己上传的表**，先用 material.rows "
                                    "列出来，再用 source=last_table 导。"}
        label, head, rows = _oir_table(oir, source, contains)
        if not rows:
            return None, {"error": f"{label}里没有含「{contains}」的条目，导出会是空表。"}
        name = title or (f"{label}（含{contains}）" if contains else label)
        return X.ExportDoc(title=name, blocks=X.table_block(head, rows),
                           note=f"共 {len(rows)} 条，由 OntoCopilot 从本次梳理产物导出"), {}

    if source == "last_table":
        tables = await _conversation_tables(s)
        ev = _pick_table(tables, table_name)
        if ev is None and table_name:
            # 点了名却找不到 —— **把有哪些告诉模型**，别让它默默导另一张给用户
            return None, {"error": f"这段对话里没有叫「{table_name}」的表。",
                          "现有的表": [r.get("title") for r in tables][-8:] or "一张都没有",
                          "下一步": "用上面列出的名字之一重试；或者不传 name，导最后一张。"}
        if ev is None:
            return None, {"error": "还没有列过表，没有「这个表」可导。",
                          "下一步": "先用 ui.table（产物）或 material.rows（上传的表）"
                                    "把内容列给他看，再导出。"}
        head = list(ev.get("columns") or [])
        # 事件里的 rows 是**给屏幕看的**，封了顶；文件没有这个限制。按事件里记的
        # 来源配方重算全量，否则会导出一个叫「问题清单（900 行）.xlsx」、里面只有
        # 500 行的文件 —— 而 FDE 会把它当完整清单发给客户。
        full = _full_rows_for(s, ev)
        rows = full if full is not None else [list(r) for r in (ev.get("rows") or [])]
        partial = full is None and int(ev.get("total") or len(rows)) > len(rows)
        if contains:
            k = contains.lower()
            rows = [r for r in rows if k in " ".join(str(c) for c in r).lower()]
            if not rows:
                return None, {"error": f"这张表里没有含「{contains}」的行。"}
        name = title or str(ev.get("title") or "清单")
        note = f"共 {len(rows)} 条，由 OntoCopilot 导出"
        if partial:
            # 补不回全量时**必须说出来**，标题里那个数字也不能留着骗人。原标题
            # 结尾常有个「（900 行）」—— 那是屏幕上那张表的总数，直接换掉，
            # 别再追加一个括号变成「（900 行）（前 500 行）」。
            name = re.sub(r"（[^（）]*\d+\s*[行条][^（）]*）\s*$", "", name).strip()
            name = f"{name}（前 {len(rows)} 行，原表 {ev.get('total')} 行）"
            note = (f"只含前 {len(rows)} 行，原表共 {ev.get('total')} 行 —— "
                    f"重新读原始材料失败，这份**不是全量**。")
        doc = X.ExportDoc(title=name, blocks=X.table_block(head, rows), note=note)
        return doc, ({"注意": note} if partial else {})

    # **system 轮次不能一律丢掉。** DialogueMemory 每轮都 compact_to_fit()，超预算
    # 的旧轮次会被换成一条 Speaker.SYSTEM 的摘要（"（已压缩 N 轮）…"）—— 那是那些
    # 轮次仅存的记录。过滤掉它，导出的"整段对话"就从中间开始，而且还宣称自己是全部。
    raw_turns = _dialogue(s).turns
    turns = [t for t in raw_turns if str(t.speaker) != "system"]
    if source == "last_answer":
        answer = next((t for t in reversed(turns) if str(t.speaker) == "assistant"), None)
        if answer is None:
            return None, {"error": "这轮之前还没有过回答，没有「刚才那段」可导。"}
        return X.ExportDoc(title=title or "OntoCopilot 回答",
                           blocks=X.blocks_from_markdown(answer.text),
                           note="由 OntoCopilot 导出"), {}

    if source == "conversation":
        if not raw_turns:
            return None, {"error": "这个会话还没有对话内容。"}
        blocks: list[Any] = []
        compacted = 0
        for t in raw_turns:
            sp = str(t.speaker)
            if sp == "system":
                compacted += 1
                blocks.append(X.Block("heading", "（早前对话摘要）", level=2))
            else:
                blocks.append(X.Block("heading", "FDE" if sp == "user" else "OntoCopilot",
                                      level=2))
            blocks.extend(X.blocks_from_markdown(t.text))
        note = f"共 {len(turns)} 轮，由 OntoCopilot 导出"
        if compacted:
            note += f"；更早的轮次已被压缩成 {compacted} 条摘要，原文不再保留"
        return X.ExportDoc(title=title or (s.title or "对话记录"), blocks=blocks,
                           note=note), {}

    return None, {"error": f"不认识的 source「{source}」。"}


#: 值得跨重启留下来的事件类型 —— 判据是「里面装的是内容，不是进度」。
_CARD_EVENT_KINDS = ("ui.table", "export.ready")
#: 留最近几条就够。一张 192 行的表 JSON 就有几十 KB，不封顶会把状态文档撑爆。
_CARD_EVENT_CAP = 12


def _push_version(s: Session, key: str, snap: dict[str, Any]) -> list[Any]:
    """把一个「编辑前」快照压进版本栈并就地封顶，返回该栈（活列表）。

    调用方在编辑失败时还要 ``pop()`` 掉刚压的这个，所以返回的必须是同一个列表。
    """
    v = s.state.setdefault(key, [])
    v.append(snap)
    if len(v) > _VERSION_STACK_CAP:
        del v[: len(v) - _VERSION_STACK_CAP]
    return v


async def _persist(s: Session, *, status: bool = True,
                   lease_owner: str = "", chat_owner: str = "",
                   docs_only: set[str] | None = None) -> None:
    """把会话当前状态写进库。**在每个节点边界调用。**

    只在最后写一次的后果是：跑到一半崩了，前面几分钟和几美元全白花，
    而磁盘上什么都没有。节点边界是天然的检查点 —— 那正是 Recorder 记
    ``NODE_COMPLETED`` 的地方。

    持久化失败必须上抛。继续生成一份无法恢复、审计链已断裂的“成功”产物，比明确
    失败更危险；调用边界会把异常转换成 failed Run 或 HTTP 失败，用户不会误以为
    已经保存。发出的 ``persist.failed`` 事件只用于诊断，不会吞掉原异常。
    """
    repo = get_repo()
    try:
        docs = {k: s.state[k] for k in _PERSISTED if k in s.state}
        # 私有的版本/补丁栈也落，顺手把内存态也封顶
        for k in _PERSISTED_PRIVATE:
            stack = s.state.get(k)
            if stack:
                s.state[k] = stack[-_VERSION_STACK_CAP:]
                docs[k] = s.state[k]
        for k in _PERSISTED_PRIVATE_DOCS:      # 整体存，不截断
            doc = s.state.get(k)
            if doc:
                docs[k] = doc
        dm = s.state.get("_dialogue")
        if dm is not None:
            # Dialogue and every domain edit from the turn are one projection commit.
            # Saving dialogue in a second transaction lets a new worker slip between
            # them and observe a half turn (or have the old worker overwrite it).
            docs["dialogue"] = dm.to_dict()
        if docs_only is not None:
            docs = {key: value for key, value in docs.items() if key in docs_only}
        conflicts = [c.to_dict() for c in (s.state.get("_conflicts") or [])]
        persist_conflicts = docs_only is None or bool({"questions", "question_backlog",
                                                       "oir"} & docs_only)
        asked_rids = [q["conflict_rid"] for q in (s.state.get("questions") or [])]
        mutation_owner = s.mutation_lease_owner
        if lease_owner and (chat_owner or mutation_owner):
            raise ValueError("build lease 和 chat lease 不能同时提交同一 checkpoint")
        if mutation_owner:
            version = await repo.save_mutation_state(
                s.id, docs, owner=mutation_owner, now=time.time(),
                status=s.status, error=s.error,
                conflicts=(conflicts or None) if persist_conflicts else None,
                asked_rids=asked_rids, chat_owner=chat_owner,
                expected_version=s.state_version,
            )
            if version is None:
                raise HTTPException(
                    409, "领域修改租约已失效或会话已更新；未覆盖最新状态。",
                )
        elif lease_owner:
            version = await repo.save_build_state(
                s.id, docs, owner=lease_owner, now=time.time(),
                status=s.status, error=s.error,
                conflicts=(conflicts or None) if persist_conflicts else None,
                asked_rids=asked_rids,
                expected_version=s.state_version,
            )
            if version is None:
                # The build owner can stay alive while another worker adds a dialogue
                # turn.  Retry once without the chat-owned documents: build never owns
                # dialogue/chat spend, so dropping them is a lossless merge.
                build_docs = {key: value for key, value in docs.items()
                              if key not in _CHAT_OWNED_DOCS}
                row = await repo.get_session(s.id)
                if row is not None:
                    version = await repo.save_build_state(
                        s.id, build_docs, owner=lease_owner, now=time.time(),
                        status=s.status, error=s.error,
                        conflicts=(conflicts or None) if persist_conflicts else None,
                        asked_rids=asked_rids,
                        expected_version=row.state_version,
                    )
            if version is None:
                raise asyncio.CancelledError
        elif chat_owner:
            version = await repo.save_chat_state(
                s.id, docs, owner=chat_owner, now=time.time(),
                conflicts=(conflicts or None) if persist_conflicts else None,
                asked_rids=asked_rids,
                expected_version=s.state_version,
            )
            if version is None:
                # A build/question/audit mutation won after this chat refreshed.
                # Chat-only state is disjoint, so merge just those keys on top of the
                # new version instead of replaying paid reasoning or stale OIR/flow.
                chat_docs = {key: value for key, value in docs.items()
                             if key in _CHAT_OWNED_DOCS}
                row = await repo.get_session(s.id)
                if row is not None:
                    version = await repo.save_chat_state(
                        s.id, chat_docs, owner=chat_owner, now=time.time(),
                        conflicts=None, asked_rids=(),
                        expected_version=row.state_version,
                    )
            if version is None:
                raise asyncio.CancelledError
        else:
            if status:
                await repo.set_status(s.id, s.status, error=s.error)
            version = await repo.save_state(
                s.id, docs,
                conflicts=(conflicts or None) if persist_conflicts else None,
                asked_rids=asked_rids,
                expected_version=s.state_version,
            )
            if version is None:
                raise HTTPException(
                    409, "会话已在另一工作进程更新；请刷新后重试，未覆盖对方改动。",
                )
        s.state_version = version
        if dm is not None:
            await _persist_decisions(s, dm)
    except Exception as exc:
        s.emit("persist.failed", error=f"{type(exc).__name__}: {exc}")
        raise


def _question_backlog(s: Session) -> QuestionBacklog:
    raw = s.state.get("question_backlog") or {"questions": []}
    return QuestionBacklog.from_dict(raw)


def _pending_questions(s: Session) -> list[Question]:
    return [q for q in _question_backlog(s).questions.values()
            if q.status in {QuestionStatus.OPEN, QuestionStatus.ASSIGNED,
                            QuestionStatus.BLOCKED}]


async def _sync_question_backlog(s: Session, *, oir: Any | None = None,
                                 clarification: Any = (), conflicts: Any = (),
                                 preserve_repo_lifecycle: bool = False,
                                 ) -> QuestionBacklog:
    """把 OIR 问题与 conflict cards 合到唯一 Backlog，并同时写 repo/state/文件。"""
    existing = None if preserve_repo_lifecycle else s.state.get("question_backlog")
    authoritative_existing: QuestionBacklog | None = None
    if existing is None:
        rows = await get_repo().list_questions(s.id)
        if rows:
            existing = {"questions": [r.doc for r in rows]}
            authoritative_existing = QuestionBacklog.from_dict(existing)
    oir = oir or s.state.get("_oir")
    backlog = build_question_backlog(
        open_questions=list((oir.questions if oir is not None else {}).values()),
        clarification_questions=list(clarification or s.state.get("questions") or ()),
        conflicts=list(conflicts or s.state.get("_conflicts") or ()),
        existing=existing)
    if authoritative_existing is not None:
        # build_question_backlog refreshes descriptive/source fields.  Priority and
        # blocked-artifact classification, however, are durable workflow controls;
        # an OIR OpenQuestion projection must not downgrade a manually promoted
        # release blocker back to normal during deterministic finish().
        for qid, old in authoritative_existing.questions.items():
            if current := backlog.questions.get(qid):
                current.priority = old.priority
                current.blocked_artifacts = list(old.blocked_artifacts)
                current.dependencies = list(old.dependencies)
                current.metadata = dict(old.metadata)
    s.state["question_backlog"] = backlog.to_dict()
    await get_repo().upsert_questions(
        s.id, [QuestionRow.from_domain(q) for q in backlog.questions.values()])
    _write_question_exports(s, backlog)
    return backlog


async def _persist_decisions(s: Session, dm: Any) -> None:
    """增量写决定。已经写过的不重复写 —— 用 ordinal 对齐。"""
    from .store.repo import DecisionRow

    have = len(await get_repo().list_decisions(s.id))
    for i, d in enumerate(dm.decisions):
        if i < have:
            continue
        await get_repo().record_decision(s.id, DecisionRow(
            ordinal=i, kind=str(d.kind), statement=d.statement,
            scope_refs=list(d.scope_refs), turn_index=d.turn_index,
            superseded_by=d.superseded_by, target_rid="", option_id="",
            changed=[], note="", ts=d.ts))


async def _drain_queue(s: Session) -> None:
    """把梳理期间排下的改动执行掉。

    入队的时候我们对用户说了"本轮梳理跑完就执行"。不排干的话那句话就是谎话，
    而且是**最坏的一种**：用户以为说过了，于是不再重复，结果什么都没发生。

    每条都回执做了什么 —— 静默执行和静默丢弃，用户同样分辨不出来。
    """
    queued = s.state.pop("_queued", None)
    if not queued:
        return
    from .kernel.intent import IntentMatch

    done: list[str] = []
    for item in queued:
        try:
            m = IntentMatch(Intent(item["intent"]), float(item.get("confidence") or 0.9),
                            item.get("slots") or {}, item.get("span", ""),
                            item.get("by", "queued"))
            r = await _act(s, m)
        except Exception as exc:  # noqa: BLE001 — 一条失败不该拖垮其余的
            r = f"「{item.get('span', '')}」没执行成功：{type(exc).__name__}: {exc}"
        if r:
            done.append(r)
    if done:
        _publish_turn(s, Speaker.ASSISTANT,
                      "梳理跑完了，把你刚才排下的几件事办了：\n\n" + "\n\n".join(done))
        s.emit("queue.drained", count=len(queued))


async def _recompile(
    s: Session,
    *,
    lease_owner: str = "",
    preserve_question_rows: bool = False,
) -> None:
    """按当前 OIR 重算下游并重写产物。**零模型调用。**

    对齐、冲突检测、自动修复、澄清排序、模板编译全是确定性代码 —— 用户改了
    一个决定就重跑一遍整个 DAG 是没必要的浪费，那要花几美元。
    """
    oir = s.state["_oir"]
    res = finish(oir, endpoints=s.state.get("_endpoints"),
                 profiles=s.state.get("_profiles"), project=s.project)
    s.state["_conflicts"] = res["conflicts"]
    s.state["oir"] = oir.to_dict()
    s.state["conflicts"] = [c.to_dict() for c in res["conflicts"]]
    s.state["suggestions"] = res.get("suggestions") or []
    backlog = await _sync_question_backlog(
        s,
        oir=oir,
        clarification=res["clarify"].questions,
        conflicts=res["conflicts"],
        preserve_repo_lifecycle=preserve_question_rows,
    )
    # The final Question answer must resume the *same* content-addressed Recorder.
    # Otherwise `_compile` would let the HTTP answer path bypass
    # CANONICALIZE→REVIEW→EXPORT even though the initial build correctly suspended.
    released = await _resume_engagement_release(
        s, backlog=backlog, lease_owner=lease_owner,
    )
    if not released:
        s.status = "awaiting_answer"
        await _persist(s, lease_owner=lease_owner)
    s.emit("suggest.ready", suggestions=s.state["suggestions"])


async def _resume_engagement_release(
    s: Session,
    *,
    backlog: QuestionBacklog | None = None,
    lease_owner: str = "",
) -> bool:
    """Resume the frozen engagement after Question/Decision mutations.

    Returns ``False`` only for an expected INTERVIEW suspension.  REVIEW/EXPORT
    gate failures raise and therefore cannot be converted into a successful HTTP
    answer.  The extract nodes are restored from the content-addressed journal;
    the engagement projection itself is deterministic and performs no LLM calls.
    """
    if s.state.get("_oir") is None:
        raise RuntimeError("没有可恢复的 OIR，不能继续 FDE Engagement")
    backlog = backlog or _question_backlog(s)
    base_run_id = _run_id_for(s)
    recorded_run_id = str(s.state.get("engagement_run_id") or "")
    base_journal = s.dir / "journal" / f"{base_run_id}.jsonl"
    if recorded_run_id:
        run_id = recorded_run_id
    elif base_journal.exists():
        # Sessions built after the executable engagement rollout share the mature
        # extraction Recorder.  This fallback also upgrades an early deployment
        # that suspended before ``engagement_run_id`` was persisted.
        run_id = base_run_id
    else:
        # Legacy sessions/tests may have OIR artifacts but predate the engagement
        # journal entirely.  Give migration its own namespace so a later full build
        # cannot restore these projection checkpoints as extraction work.
        run_id = f"{base_run_id}_engagement"
    journal_store = FileJournal(s.dir / "journal")
    journal = s.dir / "journal" / f"{run_id}.jsonl"
    resume = journal.exists()
    if resume and any(
        event.kind is EventKind.NODE_COMPLETED and event.node_id == "EXPORT"
        for event in journal_store.read(run_id)
    ):
        # A completed engagement is an immutable checkpoint.  Reusing it after a
        # Question/Decision mutation would restore CANONICALIZE/REVIEW/EXPORT and
        # silently serve the old package.  Mutations after release get their own
        # deterministic revision namespace; a still-suspended INTERVIEW continues
        # to use the original run above.
        mutation = fingerprint({
            "questions": backlog.to_dict(),
            "decisions": list(s.state.get("decision_ledger") or ()),
            "artifactRevision": int(s.state.get("artifact_revision") or 0),
        })[:12]
        run_id = f"{base_run_id}_engagement_{mutation}"
        journal = s.dir / "journal" / f"{run_id}.jsonl"
        resume = journal.exists()
    s.state["engagement_run_id"] = run_id

    backend = None
    budget = None
    try:
        # Every engagement handler and critic is deterministic/skip_model.  Resume
        # needs a Recorder, not an API key or a paid backend—even when its journal
        # also contains the mature extraction checkpoints.
        from .kernel.llm import ScriptedBackend, stub_routing

        rec = Recorder(
            run_id,
            journal_store,
            FileBlobStore(s.dir / "blobs"),
            resume=resume,
        )
        budget = Budget(tokens=1_000_000, usd=1)
        offline_backend = ScriptedBackend()
        gw = ModelGateway(
            offline_backend, rec, routing=stub_routing(), budget=budget,
        )
        if not resume:
            s.emit("engagement.checkpoint_migrated", runId=run_id)
        index = s.state.get("_index")
        bus = AgentBus(gw.rec)
        tools = builtin_registry(
            evidence=index,
            profiles=s.state.get("_profiles"),
            sandbox=None,
        )
        bus.board.write("_tools", tools, by="bootstrap")
        cm = ContextManager(
            system="FDE Engagement deterministic resume",
            evidence=index,
            budget_tokens=90_000,
        )
        from datetime import datetime

        from .onto.engagement import build_fde_engagement_dag
        from .onto.engagement_runtime import (
            EngagementRuntimeInput,
            engagement_critics,
            engagement_handlers,
        )

        runtime = EngagementRuntimeInput(
            session_id=s.id,
            project=s.project or s.title,
            oir=s.state["_oir"],
            flow=s.state.get("_flow"),
            backlog=backlog,
            decisions=list(s.state.get("decision_ledger") or ()),
            corpus=s.state.get("corpus") or {},
            artifact_revision=int(s.state.get("artifact_revision") or 0),
            generated_at=datetime.fromtimestamp(s.created, UTC).isoformat(),
            release_downloadable=os.access(s.dir, os.W_OK),
        )
        loop = AgentLoop(
            gateway=gw,
            ctx_manager=cm,
            panel=CriticPanel(engagement_critics(), gw.rec),
            bus=bus,
            recorder=gw.rec,
            budget=budget,
            handlers=engagement_handlers(runtime),
        )
        outcome = await _run_with_live_trace(
            s,
            gw.rec,
            bus,
            Scheduler(
                build_fde_engagement_dag(), loop, gw.rec, bus, budget,
                concurrency=4,
            ).run(run_id),
        )
        if offline_backend.calls:
            raise RuntimeError("确定性 FDE Engagement 恢复意外触发了模型调用")
        s.state["engagement_execution"] = {
            "status": str(outcome.status),
            "completed": sorted(outcome.results),
            "restored": sorted(outcome.skipped),
            "pendingHuman": outcome.pending_human,
        }
        if outcome.status is RunStatus.SUSPENDED:
            s.emit("engagement.stage", node="INTERVIEW", contract="QuestionBacklog")
            return False
        if not outcome.ok:
            raise RuntimeError(f"FDE Engagement 恢复失败：{outcome.error}")
        export_plan = outcome.outputs.get("EXPORT") or {}
        if not (export_plan.get("review_passed")
                and export_plan.get("schema_valid")
                and export_plan.get("downloadable")):
            raise RuntimeError("FDE Engagement EXPORT 硬门未通过，已阻止交付")
        s.state["release_state"] = str(export_plan.get("releaseState") or "RELEASED")
        s.emit(
            "engagement.stage",
            node="EXPORT",
            contract="OntologyPackage.v1",
            artifacts=export_plan.get("artifacts") or [],
        )
        await _compile(s, lease_owner=lease_owner)
        return True
    finally:
        if backend is not None:
            await backend.aclose()


def _replay_oir_patches(s: Session, oir: Any) -> list[dict[str, Any]]:
    """把 FDE 的结构化 OIR 修改重放到新抽取结果；冲突项显式返回而不是静默丢失。"""
    from .onto.oir_edit import OIREditError, apply_oir_edit

    stale: list[dict[str, Any]] = []
    for patch in s.state.get("_oir_patch_log") or []:
        try:
            apply_oir_edit(oir, patch["op"], patch.get("args") or {})
        except OIREditError as exc:
            stale.append({**patch, "why": str(exc)})
    return stale



def _rewrite_flow_artifacts(s: Session, g: Any) -> None:
    """把一张流图落成全部产物：全图 SVG、主干 SVG、mermaid、flow.json，并刷新内存态
    与产物列表。**首次建图 / flow.edit / flow.undo 共用这一条**——否则三处各写各的，
    迟早漂移（历史上 flow.edit 就漏了重出主干图，编辑后主干图一直是旧的）。

    主干图只在「主干 ⊊ 全图」时才有意义：删节点删到只剩主干时出一张精简视图；一旦
    主干等于全图，旧的主干文件要删掉，否则留着一张过期的图冒充当前主干。
    """
    from .onto.diagram import to_mermaid, to_svg

    title = f"{s.project or s.title} · Action + Event 业务流程"
    (s.dir / "流程图.svg").write_text(to_svg(g, title=title), encoding="utf-8")
    (s.dir / "流程图.mmd").write_text(to_mermaid(g), encoding="utf-8")
    main = g.main_path()
    main_svg = s.dir / "流程图_主干.svg"
    if len(main.nodes) < len(g.nodes):
        main_svg.write_text(
            to_svg(main, title=f"{s.project or s.title} · 主干流程（仅有依据的环节）"),
            encoding="utf-8")
    elif main_svg.exists():
        main_svg.unlink()   # 主干不再区别于全图，删掉过期文件
    (s.dir / "flow.json").write_text(
        json.dumps(g.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
    s.state["_flow"] = g
    s.state["flow"] = g.to_dict()
    s.state["artifacts"] = sorted(a.name for a in s.dir.iterdir() if a.is_file())


def _replay_flow_patches(s: Session, g: Any) -> list[dict[str, Any]]:
    """把会话记下的人工流程图编辑重放到一张新建的图上，返回重放不上的（stale）。

    重跑管线会从材料重建 FlowGraph、覆盖掉 FDE 上一轮手动补的节点/边。把每次 flow.edit
    的 op 记进 ``_flow_patch_log``，重建后按顺序重放 —— 节点 rid/code 跨进程稳定，靠
    标签/编号引用的 op 能重新解析上；人工加的节点/边经各自 add_node/connect 重现，仍
    标 human。解析不上的（引用的节点在新图里没了）收集为 stale 上报，**绝不静默丢**。
    """
    from .onto.flow_edit import FlowEditError, apply_flow_edit

    stale: list[dict[str, Any]] = []
    for p in s.state.get("_flow_patch_log") or []:
        try:
            apply_flow_edit(g, p["op"], p.get("args") or {})
        except FlowEditError as exc:
            stale.append({**p, "why": str(exc)})
    return stale


async def _build_flow_diagram(s: Session, docs: list[Any]) -> None:
    """从材料里抽流程说明，出 mermaid + SVG。**零模型调用。**

    这是产品的主产出：FDE 要的不是一份结构化数据，是一张能拿去跟客户对的
    流程图。抽不出来就不出图 —— 出一张空图比不出更糟，它会让人以为材料里
    没有流程。
    """
    # BPMN 已经是一张结构化图，必须直接保留节点 id、泳道、条件和 sequenceFlow
    # provenance；再从 render 文本做一次规则抽取会丢信息，还可能改写原有顺序。
    from .onto.flow_bpmn import flow_from_bpmn_docs

    bpmn_graph = flow_from_bpmn_docs(docs)
    if bpmn_graph is not None:
        stale = _replay_flow_patches(s, bpmn_graph)
        if stale:
            s.emit("flow.stale_edits", count=len(stale),
                   items=[{"op": x["op"], "why": x["why"]} for x in stale])
        _rewrite_flow_artifacts(s, bpmn_graph)
        from .onto.flow_extract import gaps_to_questions

        source_names = [d.file_name for d in docs if getattr(d, "kind", "") == "bpmn"]
        source = "、".join(source_names)
        s.state["_flow_gaps"] = gaps_to_questions(bpmn_graph, file_name=source)
        s.state["artifacts"] = sorted(x.name for x in s.dir.iterdir() if x.is_file())
        s.emit("flow.bpmn", sources=source_names, stats=bpmn_graph.stats(),
               why="BPMN 是结构化流程定义，已直接映射，未让模型重新解释")
        s.emit("flow.ready", stats=bpmn_graph.stats(),
               gap_questions=len(s.state["_flow_gaps"]),
               issues={"死路": [n.label.value for n in bpmn_graph.dead_ends()][:6],
                       "无标签分支": [n.label.value
                                 for n in bpmn_graph.unlabeled_branches()][:6],
                       "有动作无事件": [n.label.value
                                  for n in bpmn_graph.actions_without_events()][:6]})
        return

    from .onto.flow_extract import (
        apply_scene_titles,
        attach_gateways,
        build_flow,
        looks_like_process,
        parse_gateways,
        parse_steps,
        scene_headers,
        stages_by_domain,
        stages_from_survey,
        survey_stage_groups,
    )

    steps: list[Any] = []
    rule_texts: list[tuple[str, str]] = []   # (原文, cite) 供网关抽取
    survey_cols: dict[str, list[str]] = {}   # 供阶段划分
    scenes: list[str] = []                   # 材料里写明的业务场景标题
    seen_text: set[str] = set()              # 同段被 raw/render 各扫一遍，去重
    for d in docs:
        for c in d.chunks:
            raw = c.raw if isinstance(c.raw, dict) else {}
            for val in list(raw.values()) + [c.render]:
                text = str(val or "")
                if len(text) < 60 or text in seen_text:
                    continue
                seen_text.add(text)
                # 两条通道**独立判定**，不是 if/elif —— 流程说明段本身也含
                # 「如…则…」（"如不满足，则创建执行计划"），用 elif 会让它被
                # 流程通道吃掉、进不了网关抽取，于是网关只剩零星几个。
                if looks_like_process(text):
                    got = parse_steps(text, cite=c.cite(), file_name=d.file_name)
                    known = {x.no for x in steps}
                    fresh = [x for x in got if x.no not in known]
                    steps += fresh
                    if fresh:
                        # 每一步推理都投影出来 —— 用户要看见流程是**从哪一行材料
                        # 推出来的**，而不是接受一张凭空出现的图。"不是瞎编"要能核对。
                        s.emit("flow.step", cite=c.cite(),
                               found=f"识别为流程说明，抽出 {len(fresh)} 个节点："
                                     + "、".join(f"（{x.no}）{x.name}" for x in fresh[:6])
                                     + ("…" if len(fresh) > 6 else ""))
                if "如" in text and ("则" in text or "否则" in text):
                    rule_texts.append((text, c.cite()))
            # 问卷的「节点」列：一行一个 (N) 节点名，作阶段依据
            first = next(iter(raw.values()), "") if raw else ""
            if isinstance(first, str) and first.strip():
                survey_cols.setdefault(d.file_name, []).append(first.strip())
            # 场景标题：编号和名字常常分在**相邻的两个单元格**里
            # （A 列「业务场景1」、B 列「采购执行计划创建」），只读第一列
            # 就只剩一串没有名字的编号。
            scenes += scene_headers([str(v or "") for v in raw.values()])
    if not steps:
        s.emit("flow.skipped", reason="材料里没有找到「触发条件/输入/输出」这种"
                                      "结构化的流程说明")
        return

    steps.sort(key=lambda x: x.no)

    # ── 阶段：三条依据按可信度排队，全部来自材料 ────────────────────
    #   1. 问卷/场景明写了节点区间（「业务场景一（重点覆盖节点6—10）」）—— 最硬；
    #   2. 问卷「节点」列的 `（N）短名` 分组 —— 客户自己就是按这个讨论的；
    #   3. 都没有，按**业务域**切（相邻且处理同一个单据的节点归一段）。
    # 第 3 条以前是"每 4 个切一刀"，那个 4 没有任何依据，切出来的边界纯属巧合。
    groups = survey_stage_groups(survey_cols) if survey_cols else []
    if groups:
        g, mapping = stages_from_survey(groups)
        basis = "问卷节点分组"
    else:
        g, mapping = stages_by_domain(steps)
        basis = "业务对象切分"
    if scenes:
        # 客户自己给场景起的名字比我们切出来的标题更完整，也是他开会时会用的词。
        # 对得上的泳道换成他的说法，对不上的保持原样 —— 硬凑会给一段流程贴上
        # 另一段的名字。
        renamed = apply_scene_titles(g, scenes)
        s.emit("flow.scenes", scenes=scenes[:12], basis=basis, renamed=renamed)

    fname = docs[0].file_name if docs else ""
    g = build_flow(steps, stages=mapping, file_name=fname, graph=g)

    # ── 网关：从「如…则…」规则里抽，尽量挂到相关动作 ──────────────
    step_by_kw = {st.name: st.no for st in steps}
    gws: list[tuple[Any, int | None]] = []
    seen_gw: set[str] = set()
    for text, cite in rule_texts:
        for gw in parse_gateways(text, cite=cite):
            key = gw.condition[:20]
            if key in seen_gw:          # 同一条规则被多处引用，只挂一次
                continue
            seen_gw.add(key)
            node = next((no for name, no in step_by_kw.items()
                         if any(w in gw.rule_text for w in (name, name[:4]))), None)
            gws.append((gw, node))
    if gws:
        g = attach_gateways(g, gws[:16], file_name=fname)

    # 重放人工编辑 —— 补料重跑不能吞掉 FDE 上一轮手动补的节点/边
    stale = _replay_flow_patches(s, g)
    if stale:
        s.emit("flow.stale_edits", count=len(stale),
               items=[{"op": x["op"], "why": x["why"]} for x in stale])
    # 全图 + 主干 + mermaid + flow.json 一把落地（和 flow.edit/flow.undo 共用同一条）
    _rewrite_flow_artifacts(s, g)
    # 流程图上标黄的每一处缺口，都是一个 FDE 本该问客户却容易漏掉的问题。
    # 暂存起来 —— OIR 这时候还没建，等它建好把这些问题合流进问题容器，
    # 客户不需要知道哪条是他自己问卷里提的、哪条是系统从图里发现的。
    from .onto.flow_extract import gaps_to_questions
    s.state["_flow_gaps"] = gaps_to_questions(g, file_name=fname)
    # 产物列表要立刻刷 —— 流程图在 PARSE 之后就出来了，而 artifacts 原来只在
    # _compile（几分钟后）才写。中间这段时间文件在盘上、界面上却看不到。
    s.state["artifacts"] = sorted(x.name for x in s.dir.iterdir() if x.is_file())
    s.emit("flow.ready", stats=g.stats(),
           gap_questions=len(s.state["_flow_gaps"]),
           issues={"死路": [n.label.value for n in g.dead_ends()][:6],
                   "无标签分支": [n.label.value for n in g.unlabeled_branches()][:6],
                   "有动作无事件": [n.label.value for n in g.actions_without_events()][:6]})


def _link_flow_to_api(s: Session, oir: Any) -> list[Any]:
    """把接口清单接到流程图上，重出产物，返回对不上的缺口。**零模型调用。**

    时序上必须在这里：流程图在 PARSE 之后就出来了（那时 OIR 还不存在），而接口
    清单要等 EXTRACT 跑完。两者以前就一直是两份互不相干的产物 —— 图上看不出哪
    一步有系统支撑，接口清单里也看不出这个接口落在流程的哪一环。

    材料里**没有**流程说明时（`_flow` 不存在），退一步用接口清单本身建一张接口
    视角的草图：同一个单据上 create → approve → cancel 的先后关系本身就能拿去和
    客户对，比一张白纸有用。顺序是推的，图上是虚线。
    """
    from .onto.flow_link import attach_endpoints, coverage_gaps, flow_from_actions

    g = s.state.get("_flow")
    if g is None:
        if not oir.actions:
            return []
        g = flow_from_actions(oir, file_name=s.files[0]["name"] if s.files else "")
        if not g.nodes:
            return []
        s.emit("flow.from_api", nodes=len(g.nodes),
               why="材料里没有流程说明，这张图是按接口清单的生命周期推的，全部待确认")
    report = attach_endpoints(g, oir)
    _rewrite_flow_artifacts(s, g)
    gaps = coverage_gaps(report, oir)
    s.emit("flow.linked", **report.summary(), gaps=len(gaps))
    return gaps


async def _compile(s: Session, *, lease_owner: str = "") -> None:
    oir = s.state["_oir"]
    conflicts = s.state.get("_conflicts") or []
    # Canonical artifacts and question exports must be projections of the same unified
    # backlog.  Sync first: otherwise conflict questions/answers enter the Ledger only
    # after ontology.package.json has already been written and Decisions dangle.
    await _sync_question_backlog(s, oir=oir, conflicts=conflicts)
    s.emit("node.entered", node="COMPILE", title="编译模板")
    spec = compile_template(oir, conflicts)
    # Release Gate 必须发生在任何可下载产物写盘之前。Canonical 包若存在悬空引用、
    # 重复 ID 或 schema 破坏，模板/OIR 也不能先以“新版本”出现在下载接口里。
    # 先构建并验证一次，后面把同一份数据提交，避免两次构建的 generatedAt 漂移。
    canonical = _write_canonical_artifacts(s, write=False)
    xlsx = write_xlsx(spec, s.dir / "模板_v1.xlsx", project=s.project or s.title)
    spec.save(s.dir / "template.spec.json")
    (s.dir / "oir.json").write_text(
        json.dumps(oir.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
    _write_canonical_artifacts(s, prepared=canonical)
    # oir.json 写了、state 里的快照没刷 —— 前端读的是快照，于是磁盘上是新的、
    # 界面上是旧的。这种不一致只有对着文件核对才会发现。
    s.state["oir"] = oir.to_dict()
    s.state["template"] = spec.stats()
    s.state["artifacts"] = [p.name for p in s.dir.iterdir() if p.is_file()]
    s.status = "awaiting_answer" if _pending_questions(s) else "done"
    await _persist(s, lease_owner=lease_owner)
    s.emit("artifact.ready", artifact="template", name=xlsx.name, stats=spec.stats())
    # 排队的动作要在"完成"**之前**执行完。放在之后的话，用户先看到「已完成」、
    # 界面停止刷新，然后产物才悄悄变了 —— 他不会知道。
    await _drain_queue(s)
    if s.status == "done":
        s.emit("run.completed", stats=oir.stats())
    else:
        s.emit("run.suspended", reason="仍有待业务回答的问题")
    asyncio.create_task(_emit_ai_prompts(s, slot="opening"))


def _write_canonical_artifacts(s: Session, *, write: bool = True,
                               prepared: dict[str, Any] | None = None
                               ) -> dict[str, Any]:
    """生成并校验 OntologyPackage，再提交五个稳定 JSON 视图。

    ``write=False`` 是发布前预检；``prepared`` 让真正提交复用同一份已校验数据，
    从而保证 Release Gate 检查的正是最终写出的那个 revision。
    """
    from .onto.canonical import (
        ONTOLOGY_PACKAGE_JSON_SCHEMA,
        build_package,
        validate_package,
    )

    oir = s.state.get("_oir")
    if oir is None:
        return {}
    current = int(s.state.get("artifact_revision") or 0)
    revision = current + 1
    decisions = []
    dm = s.state.get("_dialogue")
    if dm is not None:
        decisions = [d.to_dict() for d in dm.decisions]
    # Question Decision Ledger 是 FDE 回答的权威历史。仓储读取是 async，编译函数
    # 保持同步，因此调用方在 state 中维护一份耐久投影；缺省仍兼容 legacy dialogue。
    decisions += list(s.state.get("decision_ledger") or [])
    if prepared is None:
        package = build_package(
            oir, s.state.get("_flow"), package_id=f"pkg.{s.id}", revision=revision,
            base_revision=current or None, decisions=decisions,
            backlog=s.state.get("question_backlog"))
        data = package.to_dict()
    else:
        data = prepared
        revision = int(data.get("revision") or revision)
    report = validate_package(data)
    data["validation"] = report.to_dict()
    if not report.passed:
        findings = [f.to_dict() for f in report.findings if f.severity == "error"]
        s.emit("artifact.validation_failed", artifact="ontology_package",
               revision=revision, findings=findings[:20])
        summary = "; ".join(f"{f.code}@{f.path}: {f.message}"
                            for f in report.findings if f.severity == "error")
        raise RuntimeError(f"OntologyPackage v1 校验失败，已阻止交付：{summary}")
    if not write:
        return data
    (s.dir / "ontology.package.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    (s.dir / "ontology-package.schema.json").write_text(
        json.dumps(ONTOLOGY_PACKAGE_JSON_SCHEMA, ensure_ascii=False, indent=2),
        encoding="utf-8")
    views = {
        "data-objects.json": data["dataObjects"],
        "actions.json": data["actions"],
        "events.json": data["events"],
        "rules.json": data["rules"],
        "questions.json": data["questions"],
    }
    for name, rows in views.items():
        (s.dir / name).write_text(
            json.dumps({"schemaVersion": data["schemaVersion"], "revision": revision,
                        "items": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    s.state["artifact_revision"] = revision
    s.state["ontology_package"] = {
        "schemaVersion": data["schemaVersion"], "packageId": data["packageId"],
        "revision": revision, "validation": data["validation"],
        "stats": {k: len(data[k]) for k in
                  ("dataObjects", "actions", "events", "rules", "questions")},
    }
    return data


def _question_payload(q: Question, active: QuestionDecision | None = None) -> dict[str, Any]:
    data = q.to_dict()
    if active is not None:
        data["activeDecision"] = active.to_dict()
        data["answer"] = active.answer
    else:
        data["activeDecision"] = None
        data["answer"] = None
    return data


async def _load_question_domain(s: Session) -> tuple[QuestionBacklog, dict[str, QuestionDecision]]:
    rows_q = await get_repo().list_questions(s.id)
    # repo 是并发写的权威状态；state 只是渲染缓存。每次 mutation 后虽然会同步，
    # 但多 worker/另一个请求的 CAS 更新不会自动进本进程内存。
    backlog = (QuestionBacklog.from_dict([r.doc for r in rows_q])
               if rows_q else _question_backlog(s))
    s.state["question_backlog"] = backlog.to_dict()
    rows = await get_repo().list_decisions_v1(s.id)
    decisions = [QuestionDecision.from_dict({
        "id": r.id, "questionId": r.question_id, "answer": r.answer,
        "actor": r.actor, "actorRole": r.actor_role, "authority": r.authority,
        "sourceTurn": r.source_turn, "affectedIds": r.affected_ids,
        "supersedes": r.supersedes, "revision": r.revision,
        "idempotencyKey": r.idempotency_key, "rationale": r.rationale,
        "createdAt": r.created, "metadata": r.metadata,
    }) for r in rows if r.metadata.get("status") != "failed"]
    superseded = {d.supersedes for d in decisions if d.supersedes}
    active: dict[str, QuestionDecision] = {}
    for d in decisions:
        if d.id not in superseded:
            active[d.question_id] = d
    # Decision rows are the durable ledger.  Refreshing this projection before an
    # engagement resume prevents one worker from publishing a package that omits a
    # decision finalized by another worker milliseconds earlier.
    s.state["decision_ledger"] = [d.to_dict() for d in decisions]
    return backlog, active


async def _refresh_authoritative_question_state(
    s: Session,
) -> tuple[QuestionBacklog, dict[str, QuestionDecision]]:
    """Reload repo-owned interview state and project answers onto the live OIR."""
    backlog, active = await _load_question_domain(s)
    oir = s.state.get("_oir")
    if oir is not None:
        from .onto.oir import by_user

        for qid, decision in active.items():
            q = backlog.questions.get(qid)
            if q is None or q.source_kind != "open_question":
                continue
            oq = oir.questions.get(q.source_ref or q.id)
            if oq is not None:
                oq.answer = by_user(
                    str(decision.rationale or decision.answer),
                    note=f"Question Decision {decision.id}",
                )
        s.state["oir"] = oir.to_dict()
    _write_question_exports(s, backlog)
    return backlog, active


def _expected_version(body: dict[str, Any]) -> int | None:
    raw = body.get("expected_revision", body.get("expectedRevision"))
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "expected_revision 必须是整数") from exc


async def _save_question_domain(s: Session, q: Question, *, expected: int | None) -> None:
    if expected is not None and q.version != expected:
        raise HTTPException(409, f"问题已更新：预期 version {expected}，实际 {q.version}")
    if expected is None:
        # 无 CAS 的服务端内部写也只推进一个 revision；一个 PATCH 改三个字段不是
        # 三次业务动作。调用方领域方法可能已经各自 +1，这里统一收口。
        current = await get_repo().get_question(s.id, q.id)
        base = current.version if current is not None else q.version
        q.version = base + 1
        q.updated_at = time.time()
    row = QuestionRow.from_domain(q)
    try:
        saved = await get_repo().save_question(s.id, row, expected_version=expected)
    except RevisionConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    q.version = saved.version
    q.updated_at = saved.updated
    backlog = _question_backlog(s)
    backlog.questions[q.id] = q
    s.state["question_backlog"] = backlog.to_dict()
    _write_question_exports(s, backlog)
    await _persist(s)


def _write_question_exports(s: Session, backlog: QuestionBacklog) -> None:
    """问题清单三格式始终同源生成；下载路由也复用这三份字节。"""
    rows = [_question_payload(q) for q in sorted(
        backlog.questions.values(), key=lambda x: (x.priority != QuestionPriority.BLOCKING,
                                                   x.created_at, x.id))]
    (s.dir / "问题清单.json").write_text(
        json.dumps({"schemaVersion": "1.0.0", "questions": rows,
                    "summary": backlog.stats()}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    lines = [f"# {s.project or s.title} · 待澄清问题", "",
             f"共 {len(rows)} 条，未关闭 {sum(not q.terminal for q in backlog.questions.values())} 条。",
             ""]
    for i, q in enumerate(backlog.questions.values(), 1):
        lines += [f"## {i}. {q.text}", "", f"- 状态：{q.status}",
                  f"- 优先级：{q.priority}",
                  f"- 回答对象：{q.audience_role or '待分派'}",
                  f"- 负责人：{q.owner_user_id or '待分派'}"]
        if q.why:
            lines.append(f"- 为什么问：{q.why}")
        if q.blocked_artifacts:
            lines.append(f"- 阻塞产物：{'、'.join(q.blocked_artifacts)}")
        lines.append("")
    (s.dir / "问题清单.md").write_text("\n".join(lines), encoding="utf-8")
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "待澄清问题"
    ws.append(["编号", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问",
               "依赖问题", "阻塞产物", "问题ID"])
    for i, q in enumerate(backlog.questions.values(), 1):
        ws.append([i, q.text, str(q.status), str(q.priority), q.audience_role,
                   q.owner_user_id, q.why, "、".join(q.dependencies),
                   "、".join(q.blocked_artifacts), q.id])
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    widths = (8, 52, 13, 12, 18, 18, 36, 24, 32, 28)
    for i, width in enumerate(widths, 1):
        ws.column_dimensions[chr(64 + i)].width = width
    wb.save(s.dir / "问题清单.xlsx")
    s.state["artifacts"] = sorted(p.name for p in s.dir.iterdir() if p.is_file())


@app.get("/api/sessions/{sid}/questions")
async def questions_list(sid: str, limit: int = 0) -> dict[str, Any]:
    s = await _sess_async(sid)
    if not s.state.get("question_backlog") and s.state.get("_oir") is not None:
        await _sync_question_backlog(s)
    backlog, active = await _load_question_domain(s)
    batch = backlog.next_batch(limit=max(1, min(limit or 5, 50)))
    rows = [_question_payload(q, active.get(q.id)) for q in backlog.questions.values()]
    return {"questions": rows, "summary": backlog.stats(),
            "nextBatch": [q.id for q in batch],
            "revision": max((q.version for q in backlog.questions.values()), default=0)}


@app.patch("/api/sessions/{sid}/questions/{qid}")
async def question_update(sid: str, qid: str, body: dict[str, Any]) -> dict[str, Any]:
    s = await _sess_async(sid)
    async with _session_mutation(s, "question.update"), s.question_lock:
        return await _question_update_once(s, qid, body)


async def _question_update_once(s: Session, qid: str,
                                body: dict[str, Any]) -> dict[str, Any]:
    backlog, active = await _load_question_domain(s)
    q = backlog.questions.get(qid)
    if q is None:
        raise HTTPException(404, f"没有问题 {qid}")
    expected = _expected_version(body)
    original_version = q.version
    if expected is not None and q.version != expected:
        raise HTTPException(409, f"问题已更新：预期 version {expected}，实际 {q.version}")
    owner = body.get("ownerUserId", body.get("owner_user_id"))
    role = body.get("audienceRole", body.get("audience_role"))
    priority = body.get("priority")
    status = body.get("status")
    if not any(key in body for key in (
            "ownerUserId", "owner_user_id", "audienceRole", "audience_role",
            "priority", "status")):
        raise HTTPException(400, "没有可更新的 Question 字段")
    if status is not None:
        try:
            target_status = QuestionStatus(str(status))
        except ValueError as exc:
            raise HTTPException(400, f"不支持的问题状态 {status}") from exc
        if target_status is QuestionStatus.ANSWERED:
            raise HTTPException(400, "answered 必须通过 /answer 记录 Decision")
    if owner is not None:
        owner = str(owner).strip()
        if owner:
            q.assign(owner, audience_role=str(role or q.audience_role))
        else:
            q.owner_user_id = ""
            if q.status is QuestionStatus.ASSIGNED:
                q.transition(QuestionStatus.OPEN)
    elif role is not None:
        q.audience_role = str(role).strip()
        q.version += 1
        q.updated_at = time.time()
    if priority is not None:
        try:
            raw_priority = str(priority).lower()
            # 早期前端曾用 medium；稳定领域契约是
            # blocking/high/normal/low。在 API 边界上兼容旧值，库内只存 normal。
            q.priority = QuestionPriority(
                "normal" if raw_priority == "medium" else raw_priority)
        except ValueError as exc:
            raise HTTPException(400, f"不支持的优先级 {priority}") from exc
        q.version += 1
        q.updated_at = time.time()
    if status is not None and target_status is not q.status:
        try:
            q.transition(target_status)
        except (ValueError, QuestionTransitionError) as exc:
            raise HTTPException(400, str(exc)) from exc
    # repo CAS 负责只加一次版本；领域对象上多字段修改只算一个 revision。
    q.version = expected if expected is not None else original_version
    await _save_question_domain(s, q, expected=expected)
    # Closing/reopening the last blocker is semantically the same release boundary
    # as answering it.  Reload from repo first so a concurrent worker cannot leave
    # the durable backlog fully closed while every local copy still saw one open.
    authoritative, active = await _refresh_authoritative_question_state(s)
    if (status is not None and target_status in {
            QuestionStatus.DEFERRED, QuestionStatus.CANCELLED}
            and s.state.get("_oir") is not None):
        await _recompile(s, preserve_question_rows=True)
        authoritative, active = await _refresh_authoritative_question_state(s)
    pending = sum(q.status in {
        QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED,
    } for q in authoritative.questions.values())
    s.status = "awaiting_answer" if pending else "done"
    await _persist(s)
    return {
        "question": _question_payload(authoritative.questions[q.id], active.get(q.id)),
        "summary": authoritative.stats(),
        "status": s.status,
    }


@app.post("/api/sessions/{sid}/questions/{qid}/reopen")
async def question_reopen(sid: str, qid: str,
                          body: dict[str, Any] | None = None) -> dict[str, Any]:
    s = await _sess_async(sid)
    async with _session_mutation(s, "question.reopen"), s.question_lock:
        return await _question_reopen_once(s, qid, body or {})


async def _question_reopen_once(s: Session, qid: str,
                                body: dict[str, Any]) -> dict[str, Any]:
    backlog, _ = await _load_question_domain(s)
    q = backlog.questions.get(qid)
    if q is None:
        raise HTTPException(404, f"没有问题 {qid}")
    expected = _expected_version(body)
    original_version = q.version
    try:
        q.transition(QuestionStatus.OPEN)
    except QuestionTransitionError as exc:
        raise HTTPException(400, str(exc)) from exc
    q.version = expected if expected is not None else original_version
    await _save_question_domain(s, q, expected=expected)
    s.status = "awaiting_answer"
    await _persist(s)
    return {"question": _question_payload(q), "status": s.status}


async def _answer_domain_question(s: Session, qid: str,
                                  body: dict[str, Any], *,
                                  mutation_claimed: bool = False) -> dict[str, Any]:
    if mutation_claimed:
        async with s.question_lock:
            return await _answer_domain_question_once(s, qid, body)
    async with _session_mutation(s, "question.answer"), s.question_lock:
        return await _answer_domain_question_once(s, qid, body)


def _decision_from_row(row: DecisionRecordRow) -> QuestionDecision:
    return QuestionDecision.from_dict({
        "id": row.id, "questionId": row.question_id, "answer": row.answer,
        "actor": row.actor, "actorRole": row.actor_role, "authority": row.authority,
        "sourceTurn": row.source_turn, "affectedIds": row.affected_ids,
        "supersedes": row.supersedes, "revision": row.revision,
        "idempotencyKey": row.idempotency_key, "rationale": row.rationale,
        "createdAt": row.created, "metadata": row.metadata,
    })


def _predict_decision_effect(q: Question, target: Any | None,
                             option_id: str) -> list[str]:
    """在回写前计算 Decision fingerprint 需要的 affectedIds。

    这只做纯读投影，不调 ``apply_decision``；因此 repo 可以先原子 claim
    Decision，重试只有一个请求能得到 ``created=True`` 并执行副作用。
    """
    if target is None:
        return list(q.blocked_artifacts)
    option = next((o for o in target.options if o.id == option_id), None)
    if option is None:
        raise HTTPException(422, f"冲突 {target.rid} 没有选项 {option_id!r}")
    effect = option.effect
    if effect.get("split"):
        return [rid for rid in effect["split"]]
    if target_rid := effect.get("unify_to"):
        return [rid for rid in target.subjects if rid != target_rid]
    if effect.get("set_base_type"):
        return list(target.subjects)
    return []


async def _recover_applied_answer_release(
    s: Session,
) -> tuple[QuestionBacklog, dict[str, QuestionDecision], int]:
    """Finish the durable release boundary for an already-applied Decision.

    The Decision claim/finalize, Question lifecycle update and engagement
    checkpoint deliberately live in separate durable records.  A worker can die
    after the first two commits and before INTERVIEW is resumed.  Retrying the
    same idempotency key must therefore do more than echo the old Decision: it
    reloads repo-owned interview state and, when no release blocker remains,
    resumes (or migrates) the deterministic engagement journal.

    A completed engagement with an on-disk package is left untouched, so normal
    network retries do not mint artifact revisions.  Ordinary non-blocking open
    questions still keep the session in ``awaiting_answer`` while the DRAFT
    package remains downloadable.
    """
    authoritative, active = await _refresh_authoritative_question_state(s)
    pending_rows = [
        q for q in authoritative.questions.values()
        if q.status in {
            QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED,
        }
    ]
    release_blockers = [q for q in pending_rows if q.blocking]
    execution = s.state.get("engagement_execution") or {}
    release_checkpoint_complete = (
        str(execution.get("status") or "") == str(RunStatus.COMPLETED)
        and bool(s.state.get("ontology_package"))
        and (s.dir / "ontology.package.json").is_file()
    )
    if (s.state.get("_oir") is not None
            and not release_blockers
            and not release_checkpoint_complete):
        await _recompile(s, preserve_question_rows=True)
        authoritative, active = await _refresh_authoritative_question_state(s)
        pending_rows = [
            q for q in authoritative.questions.values()
            if q.status in {
                QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED,
            }
        ]
    pending = len(pending_rows)
    s.status = "awaiting_answer" if pending else "done"
    await _persist(s)
    return authoritative, active, pending


async def _answer_domain_question_once(s: Session, qid: str,
                                       body: dict[str, Any]) -> dict[str, Any]:
    backlog, _active = await _load_question_domain(s)
    q = backlog.questions.get(qid)
    if q is None:
        raise HTTPException(404, f"没有问题 {qid}")
    expected = _expected_version(body)
    original_version = q.version
    if expected is not None and q.version != expected:
        raise HTTPException(409, f"问题已更新：预期 version {expected}，实际 {q.version}")
    answer_value = body.get("answer", body.get("option_id", body.get("answerText")))
    if answer_value is None or answer_value == "":
        raise HTTPException(400, "answer 不能为空")
    # 非 conflict 的 enum UI 可能提交 option id；其 schema 已声明 enum，可直接校验。
    try:
        q.validate_answer(answer_value)
    except Exception as exc:
        raise HTTPException(422, str(exc)) from exc
    idem = str(body.get("idempotencyKey") or body.get("idempotency_key") or "").strip()
    if not idem:
        raise HTTPException(400, "idempotencyKey 必填")
    # 先查幂等记录。副作用（apply_decision / OpenQuestion 回写）只能发生在新请求上；
    # 如果先 mutate 再去 repo 判重，网络重试会把同一决定应用两次。
    previous = next((r for r in await get_repo().list_decisions_v1(s.id)
                     if r.idempotency_key == idem), None)
    if previous is not None:
        probe = QuestionDecision(
            id="", question_id=q.id, answer=answer_value,
            actor=str(body.get("actor") or "fde"),
            actor_role=str(body.get("actorRole") or q.audience_role),
            authority=str(body.get("authority") or ""),
            source_turn=str(body.get("sourceTurn") or ""),
            affected_ids=list(previous.affected_ids),
            idempotency_key=idem,
            rationale=str(body.get("answerText") or body.get("note") or ""))
        if previous.semantic_hash != probe.fingerprint:
            raise HTTPException(409, f"幂等键 {idem!r} 已用于另一份回答")
        prior = _decision_from_row(previous)
        effect_status = str(previous.metadata.get("status") or "applied")
        if effect_status == "failed":
            raise HTTPException(
                409, f"上次回答回写失败：{previous.metadata.get('error') or '未知错误'}")
        if effect_status == "claimed":
            raise HTTPException(409, "这个回答正在由另一个请求应用，请稍后刷新")
        authoritative, active, pending = await _recover_applied_answer_release(s)
        return {"decision": prior.to_dict(), "created": False,
                "question": _question_payload(
                    authoritative.questions.get(q.id, q), active.get(q.id) or prior),
                "pending": pending, "status": s.status,
                "applied": None}
    # 已成功记录的幂等重放在任何状态下都可以恢复；但新回答只允许
    # OPEN/ASSIGNED。这一校验必须早于 Decision claim、OIR 回写和 Revision，
    # 否则 deferred/blocked 问题会出现“HTTP 失败但副作用已提交”。
    if q.status not in {QuestionStatus.OPEN, QuestionStatus.ASSIGNED}:
        raise HTTPException(
            409,
            f"问题当前状态为 {q.status}，不能直接回答；请先重新打开。",
        )
    target = None
    option_id = str(body.get("option_id") or answer_value)
    if q.source_kind == "conflict" or q.source_ref.startswith("cf_"):
        target = next((c for c in s.state.get("_conflicts") or []
                       if c.rid == q.source_ref), None)
        if target is None:
            raise HTTPException(409, f"冲突 {q.source_ref} 尚未恢复，不能应用回答")
    affected_ids = _predict_decision_effect(q, target, option_id)
    decision = QuestionDecision(
        id="", question_id=q.id, answer=answer_value,
        actor=str(body.get("actor") or "fde"),
        actor_role=str(body.get("actorRole") or q.audience_role),
        authority=str(body.get("authority") or ""),
        source_turn=str(body.get("sourceTurn") or ""),
        affected_ids=affected_ids,
        revision=int(s.state.get("artifact_revision") or 0) + 1,
        idempotency_key=idem, rationale=str(body.get("answerText") or body.get("note") or ""),
    )
    decision.id = f"dec_{decision.fingerprint[:20]}"
    decision.metadata["status"] = "claimed"
    try:
        stored, created = await get_repo().record_decision_v1(
            s.id, DecisionRecordRow.from_domain(decision))
    except IdempotencyConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    if not created:
        prior = _decision_from_row(stored)
        effect_status = str(stored.metadata.get("status") or "applied")
        if effect_status == "failed":
            raise HTTPException(
                409, f"上次回答回写失败：{stored.metadata.get('error') or '未知错误'}")
        if effect_status == "claimed":
            raise HTTPException(409, "这个回答正在由另一个请求应用，请稍后刷新")
        authoritative, active, pending = await _recover_applied_answer_release(s)
        return {"decision": prior.to_dict(), "created": False,
                "question": _question_payload(
                    authoritative.questions.get(q.id, q), active.get(q.id) or prior),
                "pending": pending, "status": s.status,
                "applied": None}
    # 只有取得 claim 的请求才能执行 OIR 副作用。回写失败不删
    # Decision，而是终结为 failed，审计能看到“人回答过但没有生效”。
    applied: dict[str, Any] | None = None
    try:
        if target is not None:
            applied = apply_decision(
                s.state["_oir"], target, option_id,
                note=str(body.get("answerText") or body.get("note") or ""))
            # 预计受影响对象与实际不符时 fail closed，避免指纹/审计说谎。
            actual = list(applied.get("changed") or [])
            if sorted(actual) != sorted(decision.affected_ids):
                raise RuntimeError(
                    f"Decision effect 预计 {decision.affected_ids} 与实际 {actual} 不一致")
        if q.source_kind == "open_question" and s.state.get("_oir") is not None:
            oq = s.state["_oir"].questions.get(q.source_ref or q.id)
            if oq is not None:
                from .onto.oir import by_user
                oq.answer = by_user(str(body.get("answerText") or answer_value),
                                    note=f"Question Decision {decision.id}")
    except Exception as exc:  # 副作用失败必须耐久标记后才向上报错
        await get_repo().finalize_decision_v1(
            s.id, decision.id, status="failed",
            error=f"{type(exc).__name__}: {exc}")
        raise HTTPException(422, f"回答已记录，但回写 Ontology 失败：{exc}") from exc
    stored = await get_repo().finalize_decision_v1(
        s.id, decision.id, status="applied")
    decision.metadata = dict(stored.metadata)
    q.transition(QuestionStatus.ANSWERED)
    q.version = expected if expected is not None else original_version
    await _save_question_domain(s, q, expected=expected)
    s.state["oir"] = s.state["_oir"].to_dict() if s.state.get("_oir") is not None else s.state.get("oir")
    if q.source_ref.startswith("cf_"):
        answered = set(s.state.setdefault("answered", []))
        answered.add(q.source_ref)
        s.state["answered"] = sorted(answered)
    # 回答本身形成一个耐久 revision，供工作台查看与 artifact lineage 引用。
    # id/ordinal 只是 placeholder，repo.append_revision 持有 session 锁发号。
    rev = Revision(
        id="rev.pending", ordinal=0, parent_id=None,
        kind="question_answer", status=RevisionStatus.APPLIED,
        patch_set=PatchSet(id=f"patch.{decision.id}", base_revision=0, ops=[],
                           affected_ids=decision.affected_ids, idempotency_key=idem,
                           actor=decision.actor, reason=decision.rationale),
        changed_ids=decision.affected_ids, invalidated_artifacts=q.blocked_artifacts,
        actor=decision.actor, source_turn=decision.source_turn)
    await get_repo().append_revision(
        s.id, RevisionRow.from_domain(rev, idempotency_key=f"answer:{idem}"))
    # Question/Decision rows—not this worker's Session cache—are authoritative.
    # This reload also projects another worker's just-finalized answer back into the
    # latest OIR before deterministic finish/canonicalization runs.
    authoritative, active = await _refresh_authoritative_question_state(s)
    if s.state.get("_oir") is not None:
        await _recompile(s, preserve_question_rows=True)
        authoritative, active = await _refresh_authoritative_question_state(s)
    pending = sum(row.status in {
        QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED,
    } for row in authoritative.questions.values())
    s.status = "awaiting_answer" if pending else "done"
    await _persist(s)
    s.emit("question.answered", question=q.id, decision=decision.id,
           pending=pending, affected=decision.affected_ids)
    return {"decision": decision.to_dict(), "created": True,
            "question": _question_payload(authoritative.questions[q.id],
                                           active.get(q.id) or decision),
            "pending": pending,
            "status": s.status, "applied": applied}


@app.post("/api/sessions/{sid}/questions/{qid}/answer")
async def question_answer(sid: str, qid: str, body: dict[str, Any]) -> dict[str, Any]:
    return await _answer_domain_question(await _sess_async(sid), qid, body)


@app.get("/api/sessions/{sid}/questions/export")
async def questions_export(sid: str, format: str = "xlsx") -> Response:
    s = await _sess_async(sid)
    backlog = _question_backlog(s)
    _write_question_exports(s, backlog)
    fmt = format.lower()
    names = {"xlsx": "问题清单.xlsx", "md": "问题清单.md", "json": "问题清单.json"}
    if fmt not in names:
        raise HTTPException(400, "format 只支持 xlsx、md、json")
    p = s.dir / names[fmt]
    media = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             "md": "text/markdown; charset=utf-8", "json": "application/json"}[fmt]
    return Response(p.read_bytes(), media_type=media,
                    headers={"Content-Disposition": _content_disposition(p.name)})


@app.get("/api/sessions/{sid}/revisions")
async def revisions_list(sid: str) -> dict[str, Any]:
    await _sess_async(sid)
    rows = await get_repo().list_revisions(sid)
    return {"revisions": [r.doc for r in rows], "count": len(rows),
            "current": max((r.ordinal for r in rows), default=0)}


@app.post("/api/sessions/{sid}/answer")
async def answer(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """旧 conflict API 的兼容入口；内部复用统一 Decision Ledger 幂等路径。"""
    s = await _sess_async(sid)
    conflict_rid = str(body.get("conflict_rid") or "")
    backlog = _question_backlog(s)
    q = next((x for x in backlog.questions.values()
              if x.source_ref == conflict_rid), None)
    if q is None:
        # 历史会话尚未建立统一 backlog 时即时迁移。
        backlog = await _sync_question_backlog(
            s, clarification=s.state.get("questions") or (),
            conflicts=s.state.get("_conflicts") or ())
        q = next((x for x in backlog.questions.values()
                  if x.source_ref == conflict_rid), None)
    if q is None:
        raise HTTPException(404, f"没有冲突 {conflict_rid}")
    compat = dict(body)
    compat["answer"] = body.get("option_id")
    compat["answerText"] = body.get("note", "")
    compat.setdefault("actor", "fde")
    # 旧调用方没有幂等头，以 session+conflict+option 生成稳定键；相同回答天然重放。
    compat.setdefault("idempotencyKey",
                      f"legacy:{s.id}:{conflict_rid}:{body.get('option_id', '')}")
    return await _answer_domain_question(s, q.id, compat)



# ══════════════════════════════════════════════════════════════════
#  对话
# ══════════════════════════════════════════════════════════════════
def _dialogue(s: Session) -> DialogueMemory:
    """取会话的对话记忆，没有就建。

    放在 ``_dialogue`` 这个私有 key 下而不是 ``state`` 的公开部分 —— 它有自己的
    序列化形态（to_dict），直接丢进 state 会被 /state 原样吐出去，把整份对话历史
    塞进每一次状态轮询。
    """
    dm = s.state.get("_dialogue")
    if dm is None:
        dm = DialogueMemory()
        s.state["_dialogue"] = dm
    return dm


def _parser_for(s: Session) -> RuleIntentParser:
    """按会话当前状态构造解析器。

    问题/建议的 **展示顺序**就是用户口中的"第几条" —— 这个映射必须来自当前状态，
    不能写死。用户说"第3条"时，第3条是什么完全取决于他屏幕上看到的是什么。
    """
    oir = s.state.get("_oir")
    names = [o.api_name.value for o in oir.objects.values()] if oir is not None else []
    return RuleIntentParser(
        question_ids=[q["conflict_rid"] for q in s.state.get("questions") or []],
        suggestion_ids=[x["id"] for x in s.state.get("suggestions") or []],
        object_names=names,
    )


def _publish_turn(s: Session, speaker: Speaker, text: str, *, intent: str = "",
                  confidence: float = 1.0, refs: list[str] | None = None
                  ) -> dict[str, Any]:
    """写进对话记忆并投影成 SSE 事件，返回这条 ``chat.turn`` 的事件 projection。

    两件事必须一起做：只写记忆前端看不见，只发事件刷新页面就没了。返回的是
    projection 而不是临时序号 —— 需要权威 seq 的调用方可以 ``wait_seq`` 它。
    """
    dm = _dialogue(s)
    u = dm.say(speaker, text, intent=intent, refs=refs or [])
    # **压缩之前先把这一轮产出的表记下来。** compact_to_fit 会把最老的几轮合并成
    # 一句摘要，原文就没了 —— 而用户过两轮回头说"把刚才那张 AI 招聘表导出来"时，
    # 需要的正是原文。事件表里也有一份，但那要靠库；这份索引跟着会话状态走，
    # 库不可用、或者历史遗留会话，一样找得到。
    if speaker is Speaker.ASSISTANT:
        _remember_tables(s, text, float(u.ts or time.time()))
    dm.compact_to_fit()
    ev = s.emit("chat.turn", turn={**u.to_dict(), "confidence": round(confidence, 2)})
    return ev


#: 记多少张表。一张表几十 KB，封顶防止长会话把状态文档撑爆；超了丢最老的。
_TABLE_MEMORY_CAP = 24


def _remember_tables(s: Session, text: str, ts: float) -> None:
    """把一条回答里产出的表格存进会话记忆，按标题去重（同名的以新的为准）。"""
    fresh = _tables_in_text(text, ts)
    if not fresh:
        return
    kept: list[dict[str, Any]] = list(s.state.get("_tables") or [])
    for rec in fresh:
        kept = [x for x in kept if x.get("title") != rec.get("title")]
        kept.append(rec)
    s.state["_tables"] = kept[-_TABLE_MEMORY_CAP:]



@dataclass(slots=True)
class _ChatCtx:
    """对话推理的运行上下文。

    ``rec`` **必须给**。没有它，``ToolRegistry.call`` 的 EFFECT_REQUESTED 记账
    直接跳过（tools.py 里 ``rec is None`` 就不 emit）—— 改产物的工具调用一条都
    不进事件日志。实测过：chat_*.jsonl 里 grep ``tool.call`` 零命中。
    进程一重启，"哪一轮、凭什么把这 17 个对象标成 REJECTED"就永久查不到了，
    这和事件日志 append-only、审计可追的前提直接矛盾。
    """

    turn_id: str
    rec: Any = None
    bus: Any = None
    #: 用户是否已经批准了这一轮里的高危动作。由 /chat 的 confirm 参数置上，
    #: 不是默认放行。
    approved: bool = False
    #: 被闸门拒绝的高危动作会追加到这里，供确认时**直接重放**（而不是重新推理）。
    pending: list = field(default_factory=list)



# ══════════════════════════════════════════════════════════════════
#  对话侧的动作工具
# ══════════════════════════════════════════════════════════════════


async def _reconcile_on_boot() -> None:
    """启动时只回收 lease 过期（或迁移前无 lease）的运行。

    单个 Run 不能活过它所属 worker 重启，但其它 worker 仍可能健康运行。进程启动
    不等于整个服务集群重启；以 durable expiry 为准，不能以本地 Task 缓存为准。

    以前这件事只在 ``_hydrate`` 里做，也就是**有人点开那个会话时**才纠正。
    列表里它会一直显示「进行中」，用户等一个永远不会来的结果 —— 而他不点开，
    就永远等不到纠正。对账必须在启动时做一次，不能等人来触发。
    """
    repo = get_repo()
    try:
        rows = await repo.list_sessions(limit=500)
    except Exception:  # noqa: BLE001 — 对账失败不该挡住启动
        return
    n = 0
    for r in rows:
        if r.status in ("queued", "parsing", "extracting"):
            reaped = await repo.reap_expired_build_lease(
                r.id, now=time.time(),
                error="上次运行的租约已过期。材料、决定和**已经跑完的那部分**都还在 ——"
                      "再点一次「开始梳理」会接着上次的进度跑，不重复花钱。",
            )
            n += int(reaped)
    if n:
        print(f"[store] 启动对账：{n} 个会话上次没跑完，已标记为中断")


def _busy(s: Session) -> bool:
    """这个会话正在跑 DAG 吗。

    改产物的动作必须看这个。旧的 chat 路由有「跑着时排队」，我在改成
    agent-first 的时候把它删了 —— 审查当场指出来：跑着的时候调重编译，
    界面会显示「已完成」而抽取还在继续。
    """
    return s.status in ("queued", "parsing", "extracting")


def _converse_tools(s: Session) -> Any:
    """把执行器注册成推理循环可以调的工具。

    以前是反过来的：规则判出意图 → 直接执行 → 模型只负责给结果措辞。那套东西
    的问题不是不好用，是**没有思考可看** —— 「你好」根本走不到推理循环，
    推理轨迹永远是空的；而且规则判错时模型没有机会纠正，它拿到的已经是既成事实。

    现在模型自己决定调什么。规则的判定降级成提示塞进 prompt —— 它仍然有用
    （便宜、准、可审计），但不再是绕过模型的旁路。

    **改产物的工具一律 WRITE_LOCAL**，且每个都在返回值里说清改了什么，
    模型必须把它转述给用户。静默改产物是这层最不能出的错。
    """
    # 证据索引按**调用时**解析，不按建注册表时。工具集是一轮开始时装配的，而
    # `material.parse` 就是在这一轮中间把索引建出来的 —— 早绑的话，AI 刚读完材料
    # 却发现这一轮没有检索工具可用，只能等下一轮，白跑一趟。
    class _LazyIndex:
        def _ix(self) -> Any:
            return s.state.get("_index")

        def search(self, *a: Any, **k: Any) -> Any:
            ix = self._ix()
            return ix.search(*a, **k) if ix is not None else []

        def file_names(self) -> dict[str, str]:
            ix = self._ix()
            return ix.file_names() if ix is not None else {}

        def __len__(self) -> int:
            ix = self._ix()
            return len(ix) if ix is not None else 0

    class _LazyOIR:
        """同理：OIR 也按调用时解析。

        `oir.query` 是**条件注册**的（`if oir is not None`），而工具集在回合开始时
        就装配好了 —— 一个还没跑过梳理的会话里它压根不存在，等这一轮里梳理跑完
        （或者 hydrate 把 OIR 载回来），模型仍然查不了自己刚产出的东西。
        """
        def __getattr__(self, name: str) -> Any:
            live = s.state.get("_oir")
            if live is None:
                raise RuntimeError("还没有产物（没跑过梳理），查不了本体。")
            return getattr(live, name)

    reg = builtin_registry(evidence=_LazyIndex(), oir=_LazyOIR(),
                           profiles=s.state.get("_profiles"))
    # RO（只读：看状态、看材料清单、查流程）两个模式都给 —— 聊天也要能就上传的
    # 材料对话。RW（改产物：抽本体、改流程图、出模板、开跑）**只给工作模式**。
    # `material.parse` 单独放行到聊天：它只是把文件读进索引，不产出任何产物，
    # 而聊天要分析上传的文件就必须能读。
    RO, RW = ("converse", "chat"), ("converse",)
    RO_PARSE = ("converse", "chat")

    @reg.fn("material.list",
            "列出这次会话的全部材料：文件名、体量、已经读进来多少段、有没有还没识别的。"
            "**要判断某份材料值不值得细看、或者用户问「都有什么材料」时，先调它。** 零成本。",
            {"type": "object", "properties": {}}, danger=Danger.READ, scopes=RO)
    def _mat_list(ctx: Any) -> dict[str, Any]:
        chunks = s.state.get("_chunks") or {}
        scan_ext = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf")
        rows = []
        for f in s.files:
            cs = chunks.get(f["name"]) or []
            is_scan = f["name"].lower().endswith(scan_ext)
            rows.append({
                "文件": f["name"], "大小KB": round((f.get("size") or 0) / 1024),
                "已读入段数": len(cs),
                # 两种"没读"要分清：文本类现在就能读（material.parse，零成本），
                # 图片类要视觉模型、留到梳理时 —— 混成一句话会让 AI 对着文本材料
                # 干等"开始梳理"，或者以为图片现在就能读。
                "状态": ("已读入" if cs else
                         "还没识别（图片/扫描件，点「开始梳理」时用视觉模型识别）"
                         if is_scan else "还没读入（调 material.parse 即可读，零成本）"),
            })
        return {"材料数": len(s.files), "材料": rows,
                "说明": "要看某份材料的正文，用 evidence.search 并把文件名填进 files"}

    @reg.fn("template.query",
            "看当前填写模板长什么样：有哪些表、每张表几行、有哪些列、哪些格要业务方填。"
            "**要改模板之前先看一眼** —— 不知道现在有什么列就改，多半改错。零成本。",
            {"type": "object", "properties": {
                "sheet": {"type": "string", "description": "只看某张表；不给则看总览"}}},
            danger=Danger.READ, scopes=RO)
    def _tpl_query(ctx: Any, sheet: str = "") -> dict[str, Any]:
        from .onto.template import TemplateSpec

        sp = s.dir / "template.spec.json"
        if not sp.exists():
            return {"error": "还没有模板。跑完一轮梳理才会生成。"}
        spec = TemplateSpec.load(sp)
        if sheet:
            sh = next((x for x in spec.sheets
                       if x.name == sheet or sheet in x.name), None)
            if sh is None:
                return {"error": f"没有表「{sheet}」。现有："
                                 f"{[x.name for x in spec.sheets]}"}
            roles: dict[str, int] = {}
            for row in sh.rows:
                for c in row.values():
                    roles[str(c.role)] = roles.get(str(c.role), 0) + 1
            return {"表": sh.name, "行数": len(sh.rows), "列": list(sh.columns),
                    "说明": sh.guide, "各类格子数": roles,
                    "前两行": [{k: v.value for k, v in r.items()}
                               for r in sh.rows[:2]]}
        return {"轮次": spec.round, "统计": spec.stats(),
                "表": [{"表名": x.name, "行数": len(x.rows),
                        "列": list(x.columns), "说明": (x.guide or "")[:80]}
                       for x in spec.sheets],
                "提示": "要看某张表的内容传 sheet=表名；要改结构用 template.edit"}

    @reg.fn("ui.table",
            "把一批产物**以表格形式列给用户看**（对象/属性/关系/动作/规则/待澄清问题）。"
            "用户说「列出来」「全部列一遍」「有哪些」这类要求时**用它，不要自己在回答里"
            "一条条打出来** —— 你打字既会截断、又可能记错；这个表由系统直接从产物里出，"
            "一条不少。调完在回答里说一句「已列出 N 条，见下表」即可。",
            {"type": "object", "required": ["kind"],
             "properties": {
                 "kind": {"type": "string",
                          "enum": ["objects", "properties", "links", "actions",
                                   "rules", "questions"]},
                 "contains": {"type": "string",
                              "description": "只列名字/内容里含这个词的；不给则全部"},
                 "title": {"type": "string", "description": "给这张表起个标题"}}},
            danger=Danger.READ, scopes=RO)
    async def _ui_table(ctx: Any, kind: str, contains: str = "",
                        title: str = "") -> dict[str, Any]:
        if kind == "questions" and s.state.get("question_backlog"):
            backlog = _question_backlog(s)
            qs = list(backlog.questions.values())
            if contains:
                needle = contains.lower()
                qs = [q for q in qs if needle in json.dumps(
                    q.to_dict(), ensure_ascii=False).lower()]
            head = ["问题ID", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问"]
            rows = [[q.id, q.text, str(q.status), str(q.priority),
                     q.audience_role, q.owner_user_id, q.why] for q in qs]
            await s.emit_durable(
                "ui.table", title=title or f"统一问题清单（{len(rows)} 条）",
                columns=head, rows=rows)
            return {"已列出": len(rows), "类型": "统一问题清单",
                    "说明": "问题台账已经显示；不要在回答里逐条复述。"}
        oir = s.state.get("oir") or {}
        items = list(oir.get(kind) or [])
        if not items:
            # 这条错最容易被误读成"这东西读不出来"，然后模型就去 evidence.search 抄
            # 几条片段凑清单、再跟用户说"系统读取异常"。要列的东西在**用户自己上传
            # 的表**里时，根本不需要梳理 —— 直接读那张表就有。
            return {"error": f"还没有 {kind} —— 这里列的是**梳理产出的**东西，"
                             f"而梳理还没跑过。",
                    "下一步": "如果用户要的其实是**他上传的表格里已有的内容**"
                              "（比如他自己整理好的问题清单），用 material.rows"
                              "(file=…) 直接把那张表列出来，不用先梳理。"}

        label, head, rows = _oir_table(oir, kind, contains)
        await s.emit_durable(
            "ui.table", title=title or f"{label}（{len(rows)} 条）",
            columns=head, rows=rows, total=len(rows),
            src={"kind": "oir", "oir_kind": kind, "contains": contains})
        # 返回给模型的是**摘要**，不是全部行 —— 它不需要、也不该把这些再打一遍
        return {"已列出": len(rows), "类型": label,
                "说明": f"表格已经显示给用户了。回答里说一句「已列出 {len(rows)} 条"
                        f"{label}，见下表」就够了，**不要再逐条复述**。"}

    @reg.fn(
        "question.next",
        "读取统一 QuestionBacklog 的下一批高价值问题。用户问『接下来该问什么/问谁』"
        "或要访谈议程时用；会直接在聊天中显示可导出的表格。",
        {"type": "object", "properties": {
            "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            "audience_role": {"type": "string", "description": "只看某个回答角色"},
        }},
        danger=Danger.READ,
        scopes=RO,
    )
    async def _question_next(ctx: Any, limit: int = 5,
                             audience_role: str = "") -> dict[str, Any]:
        backlog = _question_backlog(s)
        batch = backlog.next_batch(limit=max(1, min(limit, 20)))
        if audience_role:
            batch = [q for q in batch if audience_role in q.audience_role]
        head = ["问题ID", "问题", "优先级", "回答对象", "负责人", "影响/为什么问"]
        rows = [[q.id, q.text, str(q.priority), q.audience_role,
                 q.owner_user_id, q.why] for q in batch]
        await s.emit_durable(
            "ui.table", title=f"下一批访谈问题（{len(rows)} 条）",
            columns=head, rows=rows)
        return {"count": len(rows), "questionIds": [q.id for q in batch],
                "summary": backlog.stats(),
                "说明": "问题已显示为表格；可继续分派、回答或导出。"}

    @reg.fn(
        "question.answer",
        "把业务人员/ERP 顾问对某个问题的自由文本或选项回答写入 DecisionLedger，"
        "更新 Ontology 与 Revision，并生成下一批问题。必须使用 question.next/ui.table"
        "中展示的稳定 question_id；写入前向用户说明影响并等待本轮确认。",
        {"type": "object", "required": ["question_id", "answer"],
         "properties": {
             "question_id": {"type": "string"},
             "answer": {},
             "option_id": {"type": "string"},
             "answer_text": {"type": "string"},
             "actor": {"type": "string"},
             "actor_role": {"type": "string"},
             "idempotency_key": {"type": "string"},
         }},
        danger=Danger.EXTERNAL,
        scopes=RW,
    )
    async def _question_answer_tool(
        ctx: Any,
        question_id: str,
        answer: Any,
        option_id: str = "",
        answer_text: str = "",
        actor: str = "fde",
        actor_role: str = "",
        idempotency_key: str = "",
    ) -> dict[str, Any]:
        idem = idempotency_key or (
            f"chat:{ctx.turn_id}:{question_id}:{fingerprint(answer)[:12]}"
        )
        result = await _answer_domain_question(s, question_id, {
            "answer": answer, "option_id": option_id or None,
            "answerText": answer_text, "actor": actor,
            "actorRole": actor_role, "sourceTurn": ctx.turn_id,
            "idempotencyKey": idem,
        }, mutation_claimed=bool(s.mutation_lease_owner))
        return {"已记录": result["decision"]["id"], "created": result["created"],
                "question": question_id, "pending": result["pending"],
                "status": result["status"], "下一步": "用 question.next 取下一批问题"}

    @reg.fn("export.file",
            "把**刚刚给用户看的那份内容**存成一个可下载的文件。他说「把这个表转成 "
            "excel 给我」「导出成 word / pdf」「能不能下载」时用它，调完他那边就会出现"
            "一个下载按钮。\n"
            "source 选哪个：他说「这个表/刚才那个清单」→ last_table（默认 —— **屏幕上"
            "最后出现的那张表**，你用 ui.table 列的、从材料里读的、以及你直接写在回答"
            "正文里的 markdown 表格，都算）；他指名要某一类产物 → "
            "objects/properties/links/actions/rules/questions；他说「把你刚才那段回答"
            "存下来」→ last_answer；「把我们这段对话导出来」→ conversation。\n"
            "格式挑不准就按内容挑：**表格类给 xlsx**（能筛能排能粘），**成文的东西给 "
            "docx 或 pdf**，要留档给 md。",
            {"type": "object", "required": ["format"],
             "properties": {
                 "format": {"type": "string",
                            # 口语别名（excel/word/表格）由 export.resolve_format
                            # 规范化；这里若写死五个 enum，工具契约会在
                            # 处理器有机会规范化之前就拒绝合法的“excel”。
                            "description": "xlsx/excel、docx/word、pdf、md、csv"},
                 "source": {"type": "string",
                            "enum": ["last_table", "objects", "properties", "links",
                                     "actions", "rules", "questions",
                                     "last_answer", "conversation"],
                            "description": "导什么；不给就是上一张表"},
                 "contains": {"type": "string",
                              "description": "只导含这个词的行（对表格类有效）"},
                 "name": {"type": "string",
                          "description": "他点名要哪张表时填上那个名字（比如「AI 招聘"
                                         "业务流程梳理及访谈提问框架」）。**只要他说了"
                                         "名字就一定要填** —— 不填就是导最后一张，很可能"
                                         "是别的话题那张。source=last_table 时有效"},
                 "title": {"type": "string",
                           "description": "文件名/标题；不给就按内容起一个"}}},
            danger=Danger.WRITE_LOCAL, scopes=RO)
    async def _export_file(ctx: Any, format: str, source: str = "last_table",
                           contains: str = "", title: str = "",
                           name: str = "") -> dict[str, Any]:
        from .onto import export as X

        try:
            fmt = X.resolve_format(format)
            if not fmt:
                return {"error": f"不支持的格式「{format}」。可用："
                                 f"{'/'.join(X.FORMATS)}"}
        except Exception as exc:                                  # noqa: BLE001
            return {"error": str(exc)}

        doc, receipt = await _export_doc(s, source, contains, title, name)
        if doc is None:
            return receipt                       # 组不出内容时 receipt 里是 error

        try:
            data, spec = X.render(doc, fmt)
        except ImportError as exc:               # 某个格式的库没装：只影响这一种
            return {"error": f"这台机器上导不出 {fmt}：{exc}"}
        except Exception as exc:                                  # noqa: BLE001
            return {"error": f"写 {fmt} 失败：{type(exc).__name__}: {exc}"}

        # 写进 exports/ **子目录**：会话根目录下的散文件会被当成产物（artifacts 是
        # "根目录下所有文件"算出来的），于是导出件会混进产物列表、混进交付包 zip，
        # 一个叫「问题清单.xlsx」的导出还可能被「下载填写模板」按钮抓走。
        outdir = s.dir / "exports"
        outdir.mkdir(parents=True, exist_ok=True)
        name = X.safe_name(doc.title, spec.ext)
        (outdir / name).write_bytes(data)

        rows = sum(len(t.rows) for t in doc.tables)
        s.emit("export.ready", name=name, label=spec.label, size=len(data),
               rows=rows, title=doc.title)
        return {"已生成": name, "格式": spec.label, "大小字节": len(data),
                "表格行数": rows or "不适用",
                "说明": f"下载按钮已经显示给用户了。回答里说一句「已导出「{name}」，"
                        f"点下面就能下载」即可，**不要贴链接、不要说存在哪个目录**。",
                **receipt}      # 补不回全量之类的话要一起说，不能只写在文件里

    @reg.fn("material.parse",
            "把还没读过的材料**读进来**（不产出任何本体/流程图/模板）。"
            "表格/CSV/SQL/文档零成本。**图片/扫描件要传 ocr=true**，那会调视觉模型"
            "把图里的内容识别出来（要花钱，但只识别、不梳理）。\n"
            "用户说「分析一下这张图/这份材料」「这图讲了什么」时用它 —— 读完再用 "
            "evidence.search 看内容然后回答。**这不是「开始梳理」**：他只是想看看，"
            "没让你产出本体和流程图。",
            {"type": "object", "properties": {
                "files": {"type": "array", "items": {"type": "string"},
                          "description": "只读这几份（文件名）；不给就把还没读的都读了"},
                "ocr": {"type": "boolean",
                        "description": "图片/扫描件要识别就传 true（会调视觉模型）"}}},
            danger=Danger.WRITE_LOCAL, scopes=RO_PARSE)
    async def _mat_parse(ctx: Any, files: list[str] | None = None,
                         ocr: bool = False) -> dict[str, Any]:
        if not s.files:
            return {"error": "还没有材料。"}
        if _busy(s):
            return {"error": "梳理正在跑，它自己会解析。"}
        scan_ext = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf")
        before = dict(s.state.get("_chunks") or {})
        if ocr:
            # **只识别，不梳理。** 用户说"分析一下这张图"时要的就是这个：把图读懂，
            # 而不是启动一整条抽本体/出流程图/编模板的管线。识别结果进证据索引，
            # 接下来用 evidence.search 就能就图作答。
            await _ensure_catalog()
            targets = sorted(files or [f["name"] for f in s.files])
            async with _chat_run(
                s,
                kind="ocr",
                semantic_input={
                    "files": [
                        (f.get("name"), f.get("sha256"), f.get("size"))
                        for f in s.files if f.get("name") in targets
                    ],
                },
            ) as run:
                await _preparse(s, vision=run.smart)
        else:
            await _preparse(s)                  # 零模型调用；扫描件在这条路上不识别
        after = s.state.get("_chunks") or {}
        got = {k: len(v) for k, v in after.items() if len(v) > len(before.get(k) or [])}
        scans = [f["name"] for f in s.files
                 if not after.get(f["name"]) and f["name"].lower().endswith(scan_ext)]
        # **措辞必须让模型没法误解成"已经在跑了"。** 这里回过"没有新读入的（可能
        # 都读过了）"，模型就据此对用户说"系统正在解析中" —— 一句彻头彻尾的假话，
        # 而其实什么都没启动。工具的回执是模型唯一的事实来源，含糊即等于撒谎。
        out: dict[str, Any] = {
            "本次读入": got or "无（没有可用这种方式读的新材料）",
            "当前状态": s.status,
            "已读入的材料": {k: len(v) for k, v in after.items() if v} or "无",
        }
        if scans:
            out["还没识别的图片"] = scans
            out["下一步"] = ("这些是图片/扫描件。**要看懂它们就再调一次本工具、"
                             "带上 ocr=true**（会调视觉模型识别，只识别不梳理），"
                             "然后用 evidence.search 查内容作答。只有当用户明确要"
                             "**产出**本体/流程图/模板时，才用 build.start。"
                             "**不要说系统正在解析** —— 在你调用之前什么都没开始。")
        elif got:
            out["下一步"] = "已经读进来了，用 evidence.search 查内容"
        return out

    @reg.fn("material.inspect",
            "看一份材料的结构大纲：分成了哪些段、都是什么类型、解析时发现了什么问题。"
            "**这是目录不是正文** —— 要正文用 evidence.search。零成本。",
            {"type": "object", "required": ["file"],
             "properties": {"file": {"type": "string", "description": "文件名"}}},
            danger=Danger.READ, scopes=RO)
    def _mat_inspect(ctx: Any, file: str) -> dict[str, Any]:
        chunks = s.state.get("_chunks") or {}
        from urllib.parse import unquote
        cand = [file] + ([unquote(file)] if "%" in file else [])
        name = next((x for x in cand if x in chunks), "") or next(
            (k for k in chunks if any(x and x in k for x in cand)), "")
        if not name:
            return {"error": f"没有材料「{file}」。现有：{sorted(chunks) or '（还没上传）'}"}
        cs = chunks[name]
        by_tag: dict[str, int] = {}
        for c in cs:
            for t in (c.get("tags") or ["未分类"]):
                by_tag[t] = by_tag.get(t, 0) + 1
        return {"文件": name, "段数": len(cs),
                "各类段落": by_tag,
                "前几段": [{"出处": c.get("cite"), "摘录": (c.get("text") or "")[:160]}
                           for c in cs[:5]],
                "下一步": (f"要**整张表列给用户**：material.rows(file=\"{name}\")；"
                           f"要查某个说法在哪：evidence.search(query=…, files=[\"{name}\"])")}

    @reg.fn("material.rows",
            "把**用户自己上传的表格**里的行原样列出来给他看（xlsx/csv）。他说「把表里的"
            "问题列给我」「这份表有哪些行」「全部列一遍」，而东西在**他上传的表**里时，"
            "用这个 —— 行由系统直接从文件读，150 行就是 150 行。\n"
            "**绝不要拿 evidence.search 的片段凑清单**：那是按相关度取的前几条，拿它当"
            "全集必然只剩零星几条，而他要的正是全部。零成本，不需要先梳理。\n"
            "（`ui.table` 列的是**梳理产出的**对象/属性/规则；这个列的是**原始材料**。）",
            {"type": "object", "required": ["file"],
             "properties": {
                 "file": {"type": "string", "description": "文件名"},
                 "sheet": {"type": "string",
                           "description": "工作表名；整份只有一张表时可不给"},
                 "contains": {"type": "string",
                              "description": "只列内容里含这个词的行；不给则全部"},
                 "columns": {"type": "array", "items": {"type": "string"},
                             "description": "只要这几列；不给则全部"},
                 "title": {"type": "string", "description": "给这张表起个标题"}}},
            danger=Danger.READ, scopes=RO)
    async def _mat_rows(ctx: Any, file: str, sheet: str = "", contains: str = "",
                        columns: list[str] | None = None,
                        title: str = "") -> dict[str, Any]:
        try:
            fname, pick, cols, data, note = _material_table(
                s, file, sheet, contains, columns)
        except _MultiSheet as multi:
            return {"多张工作表": multi.sheets,
                    "下一步": "传 sheet=表名 再调一次；用户没指定就先问他要哪张。"}
        except _NoRows as exc:
            return {"error": str(exc)}

        total = len(data)
        shown = data[:_ROWS_MAX]
        await s.emit_durable(
            "ui.table",
            title=title or (f"{fname}·{pick}"
                            + (f"（含「{contains}」{total} 行）" if contains
                               else f"（{total} 行）")),
            columns=cols, rows=shown, total=total,
            # 来源配方：导出时据此重算**全量**行，不受屏幕封顶影响
            src={"kind": "material", "file": fname, "sheet": pick,
                 "contains": contains, "columns": columns or []})
        out: dict[str, Any] = {
            "已列出": len(shown), "总行数": total, "表": pick, "列": cols,
            "说明": f"表格已经显示给用户了。回答里说一句「已列出 {len(shown)} 条，"
                    f"见下表」就够了，**不要再逐条复述**。",
            **note,
        }
        if total > len(shown):
            out["只显示了前几行"] = (f"共 {total} 行，界面上只列了前 {_ROWS_MAX} 行。"
                                     f"**要告诉用户还有 {total - len(shown)} 行没列**，"
                                     f"想看全部可以用 contains=… 缩小范围，"
                                     f"或者直接导出成文件 —— **导出是全量的**。")
        return out

    @reg.fn("session.status", "查当前会话的状态：材料、产物统计、待拍板的问题、建议、花费。"
            "回答『进度』『现在什么情况』这类问题前先调它。",
            {"type": "object", "properties": {}}, danger=Danger.READ, scopes=RO)
    def _status(ctx: Any) -> dict[str, Any]:
        st = (s.state.get("oir") or {}).get("stats") or {}
        spent = (s.state.get("budget") or {}).get("spent") or {}
        chunks = s.state.get("_chunks") or {}
        return {"材料": [f"{f['name']}（{len(chunks.get(f['name']) or [])} 段）"
                        for f in s.files],
                "状态": s.status,
                "产物": st or "还没跑过梳理",
                # 生成了哪些文件也要能看见 —— 模型总不能对着自己产出的东西说不知道
                "已生成的文件": s.state.get("artifacts") or "无",
                "流程图": (s.state.get("flow") or {}).get("stats") or "还没有",
                "模板": s.state.get("template") or "还没有",
                "花费美元": round(float(spent.get("usd") or 0), 2),
                "待拍板": [q.get("title") for q in (s.state.get("questions") or [])],
                "建议": [{"序号": i + 1, "标题": x["title"], "影响": x["impact"]}
                        for i, x in enumerate(s.state.get("suggestions") or [])],
                "已拍板的约定": [d.render() for d in _dialogue(s).active_decisions()]}


    @reg.fn("flow.query",
            "查已抽出的业务流程图：阶段、动作、事件、边。"
            "回答『流程有哪些环节』『某个动作的上下游是什么』之前先调它。",
            {"type": "object", "properties": {
                "stage": {"type": "string", "description": "只看某个阶段，留空看全部"},
                "around": {"type": "string",
                           "description": "只看某个节点的上下游，填节点名或编号"}}},
            danger=Danger.READ, scopes=RO)
    def _flow(ctx: Any, stage: str = "", around: str = "") -> dict[str, Any]:
        g = s.state.get("_flow")
        if g is None:
            return {"error": "还没有流程图。材料里要有「触发条件/输入/输出」"
                             "这类结构化的流程说明才抽得出来"}
        if around:
            hit = next((n for n in g.nodes.values()
                        if around in n.label.value or around == n.code), None)
            if hit is None:
                return {"error": f"找不到「{around}」"}
            return {"节点": hit.label.value, "编号": hit.code,
                    "阶段": (g.stages.get(hit.stage).title if hit.stage in g.stages
                            else hit.stage),
                    "执行者": hit.actor.value or "（材料没写）",
                    "上游": [g.nodes[e.source].label.value for e in g.in_edges(hit.rid)
                            if e.source in g.nodes],
                    "下游": [g.nodes[e.target].label.value for e in g.out_edges(hit.rid)
                            if e.target in g.nodes],
                    "出处": (hit.label.evidence[0].cite() if hit.label.evidence
                            else "（推断，无出处）")}
        nodes = [n for n in g.nodes.values()
                 if not stage or stage in (g.stages.get(n.stage).title
                                           if n.stage in g.stages else n.stage)]
        return {"统计": g.stats(),
                "阶段": [x.title for x in sorted(g.stages.values(), key=lambda y: y.order)],
                "节点": [{"名": n.label.value, "编号": n.code, "类型": str(n.kind),
                        "有依据": n.grounded} for n in nodes[:60]]}

    @reg.fn("flow.issues",
            "查流程图的问题：断掉的环节、没标条件的分支、有动作却没有对应事件的地方。"
            "这些正是该拿去问客户的 —— 它们标出了材料里缺了什么。",
            {"type": "object", "properties": {}}, danger=Danger.READ, scopes=RO)
    def _flow_issues(ctx: Any) -> dict[str, Any]:
        g = s.state.get("_flow")
        if g is None:
            return {"error": "还没有流程图"}
        return {
            "死路（有入无出且不是终态）": [
                {"节点": n.label.value, "出处": (n.label.evidence[0].cite()
                                              if n.label.evidence else "推断")}
                for n in g.dead_ends()[:10]],
            "悬空（既无入也无出）": [n.label.value for n in g.dangling()[:10]],
            "分支没标条件": [n.label.value for n in g.unlabeled_branches()[:10]],
            "有动作没有对应事件": [n.label.value for n in g.actions_without_events()[:10]],
            "推断的边数": g.stats()["inferred_edges"],
            "说明": "推断的边是系统按节点编号顺序补的，材料里没有直接依据"}

    @reg.fn("decision.record",
            "记下用户拍板的一条约定（口径、命名、范围）。它会进后续每个抽取节点的上下文。"
            "**只在用户明确表态时调**——他在问「口径是什么」不是在定口径。",
            {"type": "object", "required": ["kind", "statement"],
             "properties": {
                 "kind": {"type": "string", "enum": ["caliber", "naming", "scope",
                                                     "correction"]},
                 "statement": {"type": "string", "description": "用他的原话，不要改写"},
                 "scope_refs": {"type": "array", "items": {"type": "string"},
                                "description": "限定作用的对象 rid；全局约定留空"}}},
            danger=Danger.WRITE_LOCAL, scopes=RW)
    def _decide(ctx: Any, kind: str, statement: str,
                scope_refs: list[str] | None = None) -> dict[str, Any]:
        d = _dialogue(s).decide(DecisionKind(kind), statement,
                                scope_refs=scope_refs or [])
        return {"已记下": d.render(), "类型": kind,
                "生效范围": "后续每个抽取节点；已抽好的部分要重跑才应用",
                "当前生效的约定数": len(_dialogue(s).active_decisions())}

    @reg.fn("suggestion.apply",
            "采纳或否决一条建议。采纳会**真的改产物**（补关系、标记排除等）。"
            "调之前必须先用 session.status 看清有哪些建议、序号是几。",
            {"type": "object", "required": ["index", "accept"],
             "properties": {"index": {"type": "integer", "description": "从 1 开始"},
                            "accept": {"type": "boolean"}}},
            # EXTERNAL 而不是 WRITE_LOCAL：``requires_approval`` 只认 EXTERNAL，
            # 而"把 20 个对象标成排除"是不可逆的（代码里没有 un-exclude）。
            # 分级的语义在这里让位于后果的语义。
            danger=Danger.EXTERNAL, scopes=RW)
    def _apply(ctx: Any, index: int, accept: bool = True) -> dict[str, Any]:
        if accept and _busy(s):
            # 改的是上一轮留在 state 里的 OIR，而 _run_pipeline 跑完会整个覆盖它
            # —— 用户的采纳被静默吞掉，没有任何报错。
            return {"error": "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。"}
        ss = s.state.get("suggestions") or []
        if not (1 <= index <= len(ss)):
            return {"error": f"没有第 {index} 条建议，现在共 {len(ss)} 条"}
        sug = ss[index - 1]
        _dialogue(s).decide(DecisionKind.ADOPTION,
                            f"{'采纳' if accept else '否决'}：{sug['title']}",
                            scope_refs=[sug["id"]])
        if not accept:
            return {"已否决": sug["title"], "产物未改动": True}
        oir = s.state.get("_oir")
        if oir is None:
            return {"error": "还没有产物，先跑一轮梳理"}
        applied = apply_suggestion(oir, sug, note=f"对话中采纳：{sug['title']}")
        s.state["oir"] = oir.to_dict()
        s.emit("human.recorded", conflict=sug["id"], option="adopt",
               label=applied["label"], changed=applied["changed"])
        return {"已采纳": sug["title"], "实际改动数": len(applied["changed"]),
                "改动类型": applied["kind"],
                "下一步": "说「重出模板」才会按新结果重编译" if applied["changed"]
                else "这条没有可自动执行的动作"}

    def _do_oir_edit(op: str, **args: Any) -> dict[str, Any]:
        """oir.add / oir.edit 的共用落地。口述的事实进 OIR，一律标人工来源（USER）。"""
        from .onto.oir_edit import OIREditError, apply_oir_edit

        oir = s.state.get("_oir")
        if oir is None:
            return {"error": "还没有产物，先跑一轮梳理。"}
        if _busy(s):
            # 改的是上一轮留在 state 里的 OIR，_run_pipeline 跑完会整个覆盖它
            return {"error": "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。"}
        clean = {k: v for k, v in args.items() if v is not None}
        versions = _push_version(s, "_oir_versions", oir.to_dict())
        patch = s.state.setdefault("_oir_patch_log", [])
        patch.append({"op": op, "args": clean})
        try:
            note = apply_oir_edit(oir, op, clean)
        except OIREditError as exc:
            versions.pop()
            patch.pop()
            return {"error": str(exc), "改动": "无（这次编辑没做）"}
        s.state["oir"] = oir.to_dict()
        (s.dir / "oir.json").write_text(
            json.dumps(oir.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
        # 记一条 CORRECTION 决定 —— 既落当前产物，也进后续重抽的上下文
        _dialogue(s).decide(DecisionKind.CORRECTION, f"人工口述改本体：{note}")
        s.emit("oir.edited", op=op, note=note, stats=oir.stats())
        s.emit("human.recorded", kind="oir", note=note)
        return {"已改": note, "当前": oir.stats(),
                "下一步": "说「重出模板」按新结果重编译（会保留你的模板手工修改）"}

    @reg.fn("oir.undo", "撤销上一次人工本体编辑，并恢复对应证据与来源。",
            {"type": "object", "properties": {}},
            danger=Danger.WRITE_LOCAL, scopes=RW)
    def _oir_undo(ctx: Any) -> dict[str, Any]:
        if _busy(s):
            return {"error": "梳理正在跑，暂时不能撤销本体编辑。"}
        versions = s.state.get("_oir_versions") or []
        if not versions:
            return {"error": "没有可撤销的本体编辑。"}
        previous = versions.pop()
        if s.state.get("_oir_patch_log"):
            s.state["_oir_patch_log"].pop()
        restored = oir_from_dict(previous)
        s.state["_oir"] = restored
        s.state["oir"] = restored.to_dict()
        (s.dir / "oir.json").write_text(
            json.dumps(previous, ensure_ascii=False, indent=1), encoding="utf-8")
        s.emit("oir.edited", op="undo", note="已撤销上一次本体编辑",
               stats=restored.stats())
        return {"已撤销": True, "当前": restored.stats(), "剩余版本": len(versions)}

    @reg.fn("oir.add",
            "口述新增本体事实：加数据对象/属性/关系/Action/业务规则/枚举状态值。FDE 说出材料没写"
            "但他知道的事实（如「采购包创建后状态变成已发布」= 给采购包.状态加取值"
            "「已发布」，且/或加一条 PROCESS 规则）。**你只选 op 和参数，绝不重写整份 OIR** —— "
            "重写会抹掉其它断言的溯源。新增内容一律标「人工口述」(Origin=USER)，在 OIR 里"
            "可见、可信度高，但绝不冒充材料抽取。改完让用户「重出模板」。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["add_object_type", "add_property", "add_link",
                                 "add_action_type", "add_rule", "add_enum_value"]},
                 "object": {"type": "string", "description": "add_property 的所属对象名"},
                 "api_name": {"type": "string"},
                 "display_name": {"type": "string"},
                 "base_type": {"type": "string",
                               "enum": ["STRING", "INTEGER", "DECIMAL", "DATE",
                                        "TIMESTAMP", "BOOLEAN", "ENUM"]},
                 "cardinality": {"type": "string",
                                 "enum": ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"]},
                 "source": {"type": "string", "description": "add_link 起点对象"},
                 "target": {"type": "string", "description": "add_link 终点对象"},
                 "statement": {"type": "string", "description": "add_rule 规则原文"},
                 "kind": {"type": "string",
                          "enum": ["VALIDATION", "PROCESS", "AUTHORITY",
                                   "CALCULATION", "OTHER"]},
                 "applies_to": {"type": "array", "items": {"type": "string"},
                                "description": "add_rule/add_action_type 关联哪些对象"},
                 "parameters": {"type": "array", "items": {"type": "object"},
                                "description": "Action 的结构化参数"},
                 "effects": {"type": "array", "items": {"type": "string"},
                             "description": "Action 执行后的业务效果"},
                 "source_endpoint": {"type": "object",
                                     "description": "可选的 ERP/API 端点映射"},
                 "actor": {"type": "string"}, "definition": {"type": "string"},
                 "required": {"type": "boolean"},
                 "property": {"type": "string",
                              "description": "add_enum_value 的属性，可写「对象.属性」"},
                 "value": {"type": "string", "description": "add_enum_value 的取值"}}},
            danger=Danger.EXTERNAL, scopes=RW)
    def _oir_add(ctx: Any, op: str, **args: Any) -> dict[str, Any]:
        return _do_oir_edit(op, **args)

    @reg.fn("oir.edit",
            "改已有本体事实：改某个断言值（口径/命名/类型/基数/必填）、标记状态（确认/排除）、"
            "把规则/Action 挂到数据对象、删除人工误加的元素。**只选 op 和参数**。改动标「人工口述」，"
            "保留未触碰部分的溯源。材料抽出来的元素不能硬删（会丢证据），要排除用 "
            "set_status(status=rejected)。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["edit_assertion", "set_status", "bind_rule",
                                 "set_action_scope",
                                 "remove_object_type", "remove_property",
                                 "remove_link", "remove_action_type", "remove_rule"]},
                 "target": {"type": "string",
                            "description": "要改的对象/属性/关系/规则（名字或 rid）"},
                 "field": {"type": "string",
                           "description": "edit_assertion 改哪个字段（displayName/"
                                          "definition/base_type/required/actor…）"},
                 "value": {"type": "string"},
                 "status": {"type": "string",
                            "enum": ["candidate", "proposed", "confirmed", "rejected"]},
                 "rule": {"type": "string", "description": "bind_rule 的规则"},
                 "action": {"type": "string", "description": "set_action_scope 的 Action"},
                 "objects": {"type": "array", "items": {"type": "string"},
                             "description": "set_action_scope 关联的数据对象"},
                 "object": {"type": "string", "description": "bind_rule 的对象"},
                 "note": {"type": "string"}}},
            danger=Danger.EXTERNAL, scopes=RW)
    def _oir_edit_tool(ctx: Any, op: str, **args: Any) -> dict[str, Any]:
        return _do_oir_edit(op, **args)

    @reg.fn("build.start",
            "开始梳理已上传的材料：解析 → 抽取 → 建本体与流程图 → 出模板。"
            "用户表达了「开始梳理 / 帮我分析这些材料 / 跑一遍」这类意思就**直接调，"
            "不要再反问一次确认**。",
            # WRITE_LOCAL 而不是 EXTERNAL：梳理是这个产品**本来就要做的事**，
            # 用户上传材料并说「开始」时再弹一次"这要花钱，确认吗"是多余的一轮，
            # 而且把主流程挡在确认门后面。花费仍然记账、仍受预算上限约束。
            {"type": "object", "properties": {}}, danger=Danger.WRITE_LOCAL, scopes=RW)
    async def _build(ctx: Any) -> dict[str, Any]:
        outcome = await _claim_and_start_build(s)
        # 抢不到租约时会退回**会话的真实状态**。它可能恰恰是 idle —— 也就是
        # "没人在跑，只是这次没抢到"（一次事务争用就够）。原来这里一律回
        # "已经在跑了"：一句彻头彻尾的假话，而且把模型逼进死角 —— 它查 status
        # 是 idle、查 oir 说没跑过、启动又说在跑，最后只能**手工编一套 Action/
        # Event 出来交差**。宁可重试一次，也不能让它对着矛盾的回执瞎编。
        if outcome in _BUILD_STARTABLE:
            outcome = await _claim_and_start_build(s)
        if outcome == "no_files":
            return {"error": "还没有材料"}
        if outcome == "missing":
            return {"error": "这个会话已经不存在了"}
        if outcome == "awaiting_answer":
            return {"error": "当前正在等待业务回答；请先处理问题清单。"}
        if outcome in ("queued", "parsing", "extracting"):
            return {"error": f"已经在跑了（状态：{outcome}），不用重复启动。",
                    "说明": "过程在推理轨迹里逐步显示；跑完会有产物。"}
        if outcome != "started":
            return {"error": f"没能启动，会话状态是「{outcome}」。",
                    "**不要自己编产物**": "本体/流程图必须由梳理管线从材料里抽出来。"
                                          "启动不了就如实告诉用户启动失败，"
                                          "**绝不能手写一份 Action/Event 交给他** —— "
                                          "那是凭空捏造的，没有任何材料依据。"}
        return {"已启动": True, "材料份数": len(s.files),
                "说明": "过程会在推理轨迹里逐步显示"}



    @reg.fn("flow.edit",
            "改业务流程图：给节点改名/指定执行者/移到别的阶段、加节点、连边或删边、"
            "给网关分支贴条件标签、删节点。**你只选 op 和参数，不重画整张图** —— "
            "重画会丢掉每个节点的证据链。你手动加的节点和边会在图上标成人工添加"
            "（和材料抽出来的区分开）。改完自动重出 SVG。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["rename_node", "set_actor", "set_stage", "add_node",
                                 "connect", "disconnect", "remove_node",
                                 "set_branch_label"]},
                 "node": {"type": "string", "description": "节点名/编号（多数 op 用）"},
                 "label": {"type": "string", "description": "新名字/边标签/新节点名"},
                 "actor": {"type": "string"}, "stage": {"type": "string"},
                 "kind": {"type": "string",
                          "enum": ["action", "event", "gateway", "terminal", "external"]},
                 "source": {"type": "string", "description": "连/删边的起点节点"},
                 "target": {"type": "string", "description": "连/删边的终点节点"}}},
            danger=Danger.EXTERNAL, scopes=RW)
    def _flow_edit(ctx: Any, op: str, **args: Any) -> dict[str, Any]:
        from .onto.flow_edit import FlowEditError, apply_flow_edit

        if _busy(s):
            return {"error": "梳理正在跑，流程图编辑要等当前版本提交后再执行。"}
        g = s.state.get("_flow")
        if g is None:
            return {"error": "还没有流程图。材料里要有结构化的流程说明才抽得出来。"}
        # 编辑前存版本（封顶）—— 和模板编辑一样，改错了要能回退
        versions = _push_version(s, "_flow_versions", g.to_dict())
        clean = {k: v for k, v in args.items() if v is not None}
        # 记进补丁日志 —— 补料重跑时 _replay_flow_patches 会把它重放回新图
        patch = s.state.setdefault("_flow_patch_log", [])
        patch.append({"op": op, "args": clean})
        try:
            note = apply_flow_edit(g, op, clean)
        except FlowEditError as exc:
            versions.pop()
            patch.pop()
            return {"error": str(exc), "改动": "无（这次编辑没做）"}
        # 全图 + 主干 + mermaid + flow.json 一把重出（含主干图，修掉编辑后主干图不更新）
        _rewrite_flow_artifacts(s, g)
        s.emit("flow.ready", stats=g.stats(), edited=note)
        return {"已改": note, "当前": g.stats(), "版本": len(versions),
                "提示": "流程图已重出，右侧「流程图」标签页能看到"}

    @reg.fn("flow.undo",
            "撤销上一次流程图编辑，回到编辑前的版本。改完自动重出 SVG/主干图。",
            {"type": "object", "properties": {}},
            danger=Danger.WRITE_LOCAL, scopes=RW)
    def _flow_undo(ctx: Any) -> dict[str, Any]:
        from .onto.flow import flow_from_dict

        if _busy(s):
            return {"error": "梳理正在跑，暂时不能撤销流程图。"}
        versions = s.state.get("_flow_versions") or []
        if not versions:
            return {"error": "没有可撤销的流程图编辑。"}
        prev = versions.pop()
        if s.state.get("_flow_patch_log"):
            s.state["_flow_patch_log"].pop()
        # flow_from_dict 原样还原 human/extracted/inferred 溯源 —— 回退不该把
        # 人工加的节点降级成推断，也不该把材料证据抹平
        g = flow_from_dict(prev)
        _rewrite_flow_artifacts(s, g)
        s.emit("flow.ready", stats=g.stats(), edited="已撤销上一次编辑")
        return {"已撤销": True, "当前": g.stats(), "剩余版本": len(versions),
                "提示": "流程图已回退，右侧「流程图」标签页能看到"}

    @reg.fn("flow.preview",
            "免费出一版业务流程图：只解析材料 + 抽流程，**不做付费的完整抽取**。"
            "文本/表格/SQL 零成本；扫描件/PDF 因视觉解析会有少量费用。想先看流程图、"
            "再决定要不要跑完整梳理时用它。",
            {"type": "object", "properties": {}},
            danger=Danger.WRITE_LOCAL, scopes=RW)
    async def _flow_preview(ctx: Any) -> dict[str, Any]:
        outcome = await _claim_and_start_build(s, tier="flow_preview")
        if outcome == "no_files":
            return {"error": "还没有材料，先上传。"}
        if outcome == "missing":
            return {"error": "这个会话已经不存在了。"}
        if outcome == "awaiting_answer":
            return {"error": "当前正在等待业务回答；请先处理问题清单。"}
        if outcome != "started":
            return {"error": "已经在跑了。"}
        return {"已启动": "免费流程预览",
                "说明": "只解析 + 出流程图，跳过付费抽取；过程在推理轨迹里显示。"}

    @reg.fn("template.edit",
            "改当前填写模板的结构：加列/删列/改列名/改必填性/改下拉/改说明/调表顺序。"
            "**你只选 op 和参数，绝不直接产出 xlsx** —— 那样隐藏的回读锚点列必丢。"
            "每次编辑后系统自动跑守卫，违反往返契约会被拒并告诉你原因。"
            "改完记得让用户「重出模板」才会生成新 xlsx。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["add_column", "drop_column", "rename_column",
                                 "set_role", "set_options", "set_guide",
                                 "reorder_sheets"]},
                 "sheet": {"type": "string", "description": "目标表名"},
                 "name": {"type": "string", "description": "add_column：新列名"},
                 "column": {"type": "string", "description": "drop/set_role/set_options：列名"},
                 "old": {"type": "string"}, "new": {"type": "string"},
                 "role": {"type": "string", "enum": ["locked", "prefilled", "required"]},
                 "value": {"type": "string"}, "comment": {"type": "string"},
                 "options": {"type": "array", "items": {"type": "string"}},
                 "text": {"type": "string", "description": "set_guide：新说明"},
                 "order": {"type": "array", "items": {"type": "string"}}}},
            danger=Danger.EXTERNAL, scopes=RW)
    def _tpl_edit(ctx: Any, op: str, **args: Any) -> dict[str, Any]:
        from .onto.template import TemplateSpec
        from .onto.template_edit import EditError, apply_edit

        if _busy(s):
            return {"error": "梳理正在跑，模板编辑要等当前版本提交后再执行。"}
        sp = s.dir / "template.spec.json"
        if not sp.exists():
            return {"error": "还没有模板可以改，先跑一轮梳理。"}
        spec = TemplateSpec.load(sp)
        # 每次编辑前存一个版本（封顶）—— 改错了要能回退。审查特别强调：没有版本
        # 的编辑等于每一步都覆盖上一步、无法挽回。
        versions = _push_version(s, "_tpl_versions", spec.to_dict())
        clean = {k: v for k, v in args.items() if v is not None}
        # 记进补丁日志 —— 重出模板时在「按新 OIR 编译」的 spec 上重放这些结构编辑，
        # 让采纳/口述改的 OIR 能进这张手改模板（reconcile_template）
        patch = s.state.setdefault("_tpl_patch_log", [])
        patch.append({"op": op, "args": clean})
        try:
            note = apply_edit(spec, op, clean)
        except EditError as exc:
            versions.pop()   # 没改成，撤掉这个版本点
            patch.pop()
            return {"error": str(exc), "改动": "无（守卫拒绝了这次编辑）"}
        spec.save(sp)
        s.state["template"] = spec.stats()
        s.emit("template.edited", op=op, note=note, stats=spec.stats(),
               version=len(versions))
        return {"已改": note, "当前": spec.stats(),
                "版本": len(versions),
                "下一步": "说「重出模板」生成新 xlsx，或「撤销上一步改动」回退"}

    @reg.fn("template.undo", "撤销上一次模板编辑，回到编辑前的版本。",
            {"type": "object", "properties": {}}, danger=Danger.WRITE_LOCAL, scopes=RW)
    def _tpl_undo(ctx: Any) -> dict[str, Any]:
        from .onto.template import TemplateSpec

        if _busy(s):
            return {"error": "梳理正在跑，暂时不能撤销模板。"}
        versions = s.state.get("_tpl_versions") or []
        if not versions:
            return {"error": "没有可撤销的编辑。"}
        prev = versions.pop()
        # 补丁日志的尾也一起弹，保 undo 与重放一致（否则撤销后重放又把它加回来）
        if s.state.get("_tpl_patch_log"):
            s.state["_tpl_patch_log"].pop()
        spec = TemplateSpec.from_dict(prev)
        spec.save(s.dir / "template.spec.json")
        s.state["template"] = spec.stats()
        s.emit("template.edited", op="undo", note="已撤销上一次编辑",
               stats=spec.stats(), version=len(versions))
        return {"已撤销": True, "当前": spec.stats(), "剩余版本": len(versions)}

    @reg.fn("template.recompile",
            "按当前产物重出模板。**零模型调用**（对齐/冲突/编译都是确定性的），"
            "和重跑梳理完全不同——后者要重新抽取、要花钱。",
            {"type": "object", "properties": {}}, danger=Danger.EXTERNAL, scopes=RW)
    async def _recomp(ctx: Any) -> dict[str, Any]:
        if s.state.get("_oir") is None:
            return {"error": "还没有产物"}
        if _busy(s):
            return {"error": "梳理正在跑，这时候重出模板会覆盖掉正在生成的产物。"
                             "等它跑完再说。"}
        # 模板被对话编辑过 → **不能**裸走 _recompile（那会从 OIR 重编译、把手改整个
        # 覆盖），也**不能**只渲染冻结 spec（那样采纳/口述改的 OIR 又进不来）。正解是
        # reconcile：按最新 OIR 新编译，再把结构手改重放上去 —— 两头都不丢。
        if s.state.get("_tpl_patch_log"):
            from .onto.template import write_xlsx
            from .onto.template_edit import reconcile_template

            oir = s.state["_oir"]
            conflicts = s.state.get("_conflicts") or []
            spec, stale = reconcile_template(oir, conflicts,
                                             s.state["_tpl_patch_log"])
            spec.save(s.dir / "template.spec.json")
            x = write_xlsx(spec, s.dir / "模板_v1.xlsx", project=s.project or s.title)
            (s.dir / "oir.json").write_text(
                json.dumps(oir.to_dict(), ensure_ascii=False, indent=1),
                encoding="utf-8")
            s.state["oir"] = oir.to_dict()
            s.state["template"] = spec.stats()
            s.state["artifacts"] = sorted(a.name for a in s.dir.iterdir()
                                          if a.is_file())
            s.emit("artifact.ready", artifact="template", name=x.name,
                   stats=spec.stats())
            if stale:
                s.emit("template.stale_edits", count=len(stale),
                       items=[{"op": p["op"], "why": p["why"]} for p in stale])
            return {"已重出": "已把 OIR 改动合并进你的手改模板",
                    "没能重放的手改": len(stale), **spec.stats()}
        await _recompile(s)
        t = s.state.get("template") or {}
        return {"已重出": True, "表数": t.get("sheets"), "预填格数": t.get("prefilled"),
                "业务必填": t.get("business_required")}

    return reg


async def _replay_pending(s: Session, action: dict[str, Any], *, batch: int = 0) -> str:
    """用户确认后，直接重放上一轮被拦的那个高危动作。

    不重新推理 —— 动作和参数已经定了，重新推理只会引入不确定性（模型可能这次
    理解成别的意思）。用同一套工具、approved=True 执行，全程照样进 tool.call
    记账，可审计不变。
    """
    tool_name = str(action.get("tool") or "")
    args = action.get("args") or {}
    try:
        async with _chat_run(
            s,
            kind="confirm",
            semantic_input={"batch": batch, "tool": tool_name, "args": args,
                            "artifactRevision": s.state.get("artifact_revision")},
        ) as run:
            tools = _converse_tools(s)
            ctx = _ChatCtx(turn_id=run.recorder_run_id, rec=run.gw.rec, approved=True)
            result = await tools.call(tool_name, args, ctx, scope="converse")
            if isinstance(result, dict) and result.get("error"):
                error = str(result["error"])
                run.fail(error)
                failed_reply = f"没执行成功：{error}"
            else:
                failed_reply = ""
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 重放失败要如实说
        return f"执行「{tool_name}」时出错了：{type(exc).__name__}: {exc}"
    if failed_reply:
        return failed_reply
    # 措辞成人话：用同一个 _say，把结果当事实交给它
    return await _say(s, _outcome("confirmed", json.dumps(result, ensure_ascii=False,
                                                          default=str)[:400],
                                  动作=tool_name, 结果=result), "确认执行")


def _chat_docs_brief(s: Session, *, cap: int = 6000) -> str:
    """聊天里用户传的文件摘成一段文本，供模型对话参考（不是正式梳理）。

    截到 cap 字符 —— 聊天不做梳理，把全文塞进 prompt 既贵又没必要；要完整梳理
    就转成工作会话。
    """
    parts = ["用户在这次聊天里上传了文件，内容摘录如下（供对话参考，不是正式梳理）："]
    used = 0
    for fname, chunks in (s.state.get("_chunks") or {}).items():
        parts.append(f"\n【{fname}】")
        for c in chunks:
            t = (c.get("text") or "").strip()
            if not t:
                continue
            parts.append(t[:1200])
            used += min(len(t), 1200)
            if used >= cap:
                parts.append("…（其余略；要完整梳理请点「转成工作会话」）")
                return "\n".join(parts)
    return "\n".join(parts)


async def _reason(s: Session, text: str, *, hint: str = "",
                  approved: bool = False) -> Any:
    # Cap rejection is a request-policy outcome, not a model Run.  Check it before
    # allocating a repository row so a rejected HTTP call cannot leave a useless
    # failed chat invocation behind.
    spent = float(s.state.get("_chat_usd") or 0.0)
    cap = appconfig.chat_usd_cap()
    if spent >= cap:
        raise HTTPException(429, f"这个会话的对话花费已达上限 ${cap}（已花 ${spent:.2f}）。"
                                 f"调 ONTOCOPILOT_CHAT_USD_CAP 或新建会话。")
    semantic_input = {
        "text": text,
        "hint": hint,
        "approved": approved,
        "lang": s.lang,
        "mode": s.state.get("mode", "work"),
        "model": s.state.get("model"),
        "files": [(f.get("name"), f.get("sha256"), f.get("size")) for f in s.files],
        "oir": s.state.get("oir"),
        "flow": s.state.get("flow"),
        "questions": s.state.get("question_backlog") or s.state.get("questions"),
        "suggestions": s.state.get("suggestions"),
        "chunks": s.state.get("_chunks"),
        "dialogue": (_dialogue(s).to_dict() if s.state.get("_dialogue") is not None
                     else None),
        "model_overrides": appconfig.model_overrides(),
    }
    async with _chat_run(
        s, kind="reason", semantic_input=semantic_input,
    ) as run:
        return await _reason_in_run(
            s, text, hint=hint, approved=approved, run=run,
        )


async def _reason_in_run(s: Session, text: str, *, hint: str,
                         approved: bool, run: _ChatRun) -> Any:
    """跑一轮对话推理，并把每一步投影成事件。

    工具只给 ``readonly`` 作用域：对话能查任何东西，但**不能静默改产物**。
    要改必须走显式执行器并回显改了什么 —— 一个能在闲聊里悄悄删掉 17 个对象的
    副驾是不能用的。
    """
    s.dir.mkdir(parents=True, exist_ok=True)
    run_id = run.recorder_run_id
    gw = run.gw
    # 对话花的钱要**跨轮累计**。Budget 是每轮新建的，$15 那个上限是"每一轮"的
    # 上限 —— 也就是说对话侧根本没有封顶。一轮真问题跑满 5 步实测约 $0.08，
    # 一天两百轮就是十几美元，而它们大多是本可以不花的。
    spent = float(s.state.get("_chat_usd") or 0.0)
    tools = _converse_tools(s)
    # 聊天模式：通用助手 + **只读分析工具**（能检索上传的材料来分析），但**没有任何
    # 生成产物的工具** —— 不抽本体/不出流程图/不生成模板，那些是工作模式的事。
    if s.state.get("mode") == "chat":
        from .onto.converse import _CHAT_SYSTEM
        # 用同一份注册表、但按 chat 作用域取工具：拿得到只读的看/查/读材料，
        # 拿不到任何改产物的（那些是 RW=converse）。作用域即授权，不靠提示词自律。
        agent = ConversationAgent(gateway=gw, tools=tools, scope="chat",
                                  max_steps=4, system=_CHAT_SYSTEM, lang=s.lang)
    else:
        # 工作模式的模型选择器：选了具体模型就让对话直接用它（梳理管线仍按能力路由）
        model_spec = None
        chosen = s.state.get("model")
        if chosen:
            card = (_CATALOG or ModelCatalog()).get(chosen)
            model_spec = card.spec if card else None
        agent = ConversationAgent(gateway=gw, tools=tools, scope="converse",
                                  max_steps=5, model=model_spec, lang=s.lang)

    def on_step(rec: dict[str, Any]) -> None:
        # 推理过程必须可见 —— 看不见的推理和编造的区别，用户分辨不出来。
        # 带上轮次 id：同一步会回调两次（发起时、拿到观察后），而不同轮次的
        # 步号会重复，只按步号去重会把上一轮的步骤覆盖掉。
        s.emit("chat.step", step={**rec, "turn": run_id, "q": text[:40]})

    ctx_text = _context_brief(s)
    dm = s.state.get("_dialogue")
    if dm is not None and dm.turns:
        ctx_text += "\n\n最近对话（用于解析‘刚才那个/上一版’等指代）：\n" + dm.render_recent(limit=6)
    # 聊天模式里用户传了文件 → 把文本摘录塞进上下文，模型才能就它对话（聊天无工具）
    if s.state.get("mode") == "chat" and s.state.get("_chunks"):
        ctx_text += "\n\n" + _chat_docs_brief(s)
    if hint:
        # 规则层的判定作为**提示**给出，不是命令 —— 措辞上要让模型知道它可以不采纳。
        ctx_text += f"\n\n规则层对这句话的初步判断（仅供参考，你可以不同意）：{hint}"
    ctx = _ChatCtx(turn_id=run_id, rec=gw.rec, approved=approved)
    turn = await agent.run(text, ctx=ctx, context=ctx_text, on_step=on_step)
    if any(f.code == "GATEWAY_ERROR" for f in turn.findings):
        run.fail(turn.answer or "conversation gateway failed")
    s.state["_last_reason"] = turn.to_dict()
    s.state["_chat_usd"] = spent + float(turn.usd or 0.0)
    # 记下这一轮被闸门拦下的高危动作，供下一轮确认时直接重放。
    # **被拦下的动作要全留。** 推理循环遇到 ToolDenied 不中断、继续往下想，所以
    # 一轮里可能连着撞上好几个要确认的写工具（oir.add 之后又 flow.edit）。只留
    # ctx.pending[0] 的话，用户点了「确认执行」也只有第一个真的发生，其余静默丢失 ——
    # 而回答里已经说了都会做。
    s.state["_pending_actions"] = list(ctx.pending or ())
    s.state["_pending_action"] = ctx.pending[0] if ctx.pending else None
    return turn


def _context_brief(s: Session) -> str:
    """给推理循环的会话状态摘要。

    进**系统层**而不是用户层：用户说的话和系统给的事实混在一起，材料里写的
    「请忽略之前的指令」就有机会冒充系统事实。
    """
    parts: list[str] = []
    st = (s.state.get("oir") or {}).get("stats")
    if st:
        parts.append("当前产物：" + "、".join(f"{k}={v}" for k, v in st.items()))
    # 材料清单带上"读进来多少段"：只给文件名的话，模型分不清一份材料是**内容都在**
    # 还是**只登记了文件名**（图片没识别时就是后者），于是会对着空气回答。
    chunks = s.state.get("_chunks") or {}
    if s.files:
        inv = "、".join(
            f"{f['name']}（{len(chunks.get(f['name']) or [])} 段"
            + ("" if chunks.get(f["name"]) else "，尚未识别内容") + "）"
            for f in s.files)
        parts.append(f"材料：{inv}")
    else:
        parts.append("材料：（还没上传）")
    dm = s.state.get("_dialogue")
    if dm is not None:
        ds = dm.active_decisions()
        if ds:
            parts.append("已拍板：" + "；".join(d.render() for d in ds[:8]))
    qs = s.state.get("questions") or []
    if qs:
        parts.append(f"待拍板 {len(qs)} 个")
    sg = s.state.get("suggestions") or []
    if sg:
        parts.append("待处理建议：" + "；".join(f"{i+1}.{x['title']}"
                                            for i, x in enumerate(sg[:5])))
    return "\n".join(parts)


async def _refresh_chat_projection(s: Session) -> Session:
    """Refresh a cached worker projection after it wins the durable chat lease.

    A lease serializes *future* mutations but does not make a worker's old Python
    object current.  Compare the durable ``state_version`` only after claiming the
    lease; when it advanced elsewhere, replace every persisted projection key and
    rebuild the live OIR/flow/dialogue objects before interpreting this turn.

    Runtime handles (SSE subscribers, local build task and locks) remain on the same
    ``Session`` instance.  That matters when a chat arrives while a local build is
    active; replacing the instance would orphan the pipeline and its subscribers.
    """
    repo = get_repo()
    row = await repo.get_session(s.id)
    if row is None:
        raise HTTPException(404, f"没有会话 {s.id}")
    if row.state_version == s.state_version:
        await _refresh_files_projection(s)
        return s

    saved = await repo.load_state(s.id)
    durable_keys = {*_PERSISTED, *_PERSISTED_PRIVATE, *_PERSISTED_PRIVATE_DOCS,
                    "dialogue"}
    for key in durable_keys:
        s.state.pop(key, None)
    s.state.update(saved)
    s.state.pop("_dialogue", None)
    await _restore_dialogue(s)

    oir_doc = s.state.get("oir")
    if isinstance(oir_doc, dict):
        try:
            s.state["_oir"] = oir_from_dict(oir_doc)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(409, f"会话本体状态无法刷新：{exc}") from exc
    else:
        s.state.pop("_oir", None)

    flow_doc = s.state.get("flow")
    if isinstance(flow_doc, dict):
        try:
            from .onto.flow import flow_from_dict
            s.state["_flow"] = flow_from_dict(flow_doc)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(409, f"会话流程状态无法刷新：{exc}") from exc
    else:
        s.state.pop("_flow", None)

    s.title, s.project = row.title, row.project
    s.status, s.error = row.status, row.error
    s.owner = row.owner
    s.state_version = row.state_version
    await _refresh_files_projection(s)
    return s


@asynccontextmanager
async def _session_mutation(
    s: Session, kind: str, *, chat_owner: str = "",
):
    """Serialize one cross-table/domain mutation across all workers.

    Claim happens before refreshing the projection or touching files/tables.  Losing
    the lease cancels the request; an exception reloads durable state so this worker's
    cached Python objects cannot leak a partial edit into a later request.
    """
    owner = chat_owner or f"{_WORKER_ID}:mutation:{uuid.uuid4().hex}"
    claimed = await get_repo().claim_mutation_lease(
        s.id, owner=owner, kind=kind, now=time.time(), ttl=_MUTATION_LEASE_TTL,
    )
    if not claimed:
        raise HTTPException(
            409, "会话正在梳理或另一个领域修改尚未提交，请稍后重试。",
        )
    owner_task = asyncio.current_task()

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(_MUTATION_HEARTBEAT_INTERVAL)
            renewed = await get_repo().renew_mutation_lease(
                s.id, owner=owner, now=time.time(), ttl=_MUTATION_LEASE_TTL,
            )
            if not renewed:
                if owner_task is not None and not owner_task.done():
                    owner_task.cancel()
                return

    heartbeat_task = asyncio.create_task(
        heartbeat(), name=f"mutation-heartbeat:{s.id}:{kind}",
    )
    previous_owner = s.mutation_lease_owner
    state_snapshot: dict[str, Any] | None = None
    status_snapshot = s.status
    error_snapshot = s.error
    version_snapshot = s.state_version
    try:
        s.mutation_lease_owner = owner
        await _refresh_chat_projection(s)
        await _refresh_files_projection(s)
        # Rejections are part of the normal API contract (invalid transition,
        # damaged return template, failed validator).  Preserve the projection that
        # existed *after* the lease refresh so a fail-closed 4xx cannot erase live
        # objects from tests/legacy sessions whose initial state has not yet been
        # checkpointed.  Deep-copy is intentional: OIR/Flow editors mutate objects in
        # place, so a shallow dict copy would still leak their changes.
        state_snapshot = copy.deepcopy(s.state)
        status_snapshot, error_snapshot = s.status, s.error
        version_snapshot = s.state_version
        yield owner
    except BaseException:
        # If no projection checkpoint committed, restore the exact leased snapshot.
        # If state_version advanced, a durable saga step won and the database is the
        # authority; hydrate it instead of rolling back a committed Decision/Revision.
        row = await get_repo().get_session(s.id)
        if (state_snapshot is not None and row is not None
                and row.state_version == version_snapshot):
            s.state.clear()
            s.state.update(state_snapshot)
            s.status, s.error = status_snapshot, error_snapshot
            s.state_version = version_snapshot
        else:
            s.state_version = -1
            try:
                await _refresh_chat_projection(s)
            except Exception as refresh_exc:  # noqa: BLE001 -- preserve original exception
                s.emit("mutation.refresh_failed", error=str(refresh_exc), kind=kind)
        raise
    finally:
        s.mutation_lease_owner = previous_owner
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        await get_repo().release_mutation_lease(s.id, owner=owner)


@app.post("/api/sessions/{sid}/chat")
async def chat(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """Single-flight wrapper for every chat mutation, including confirm replay."""
    s = await _sess_async(sid)
    lease_owner = f"{_WORKER_ID}:chat:{uuid.uuid4().hex}"
    claimed = await get_repo().claim_chat_lease(
        sid, owner=lease_owner, now=time.time(), ttl=_CHAT_LEASE_TTL,
    )
    if not claimed:
        raise HTTPException(409, "这个会话已有一轮对话正在处理，请等它结束或先停止。")
    owner_task = asyncio.current_task()

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(_CHAT_HEARTBEAT_INTERVAL)
            renewed = await get_repo().renew_chat_lease(
                sid, owner=lease_owner, now=time.time(), ttl=_CHAT_LEASE_TTL,
            )
            if not renewed:
                if owner_task is not None and not owner_task.done():
                    owner_task.cancel()
                return

    heartbeat_task = asyncio.create_task(
        heartbeat(), name=f"chat-heartbeat:{sid}",
    )
    try:
        s = await _refresh_chat_projection(s)
        if s.state.get("mode") != "chat" and not _busy(s):
            # Work-mode tools include synchronous structure editors.  Holding the
            # mutation lease for the whole turn is the only way to cover every tool
            # call before its first file/OIR side effect.  Pure chat mode never gets
            # those tools and therefore remains lease-free.
            async with _session_mutation(s, "chat.structural", chat_owner=lease_owner):
                return await _chat_claimed(s, body, chat_owner=lease_owner)
        return await _chat_claimed(s, body, chat_owner=lease_owner)
    except asyncio.CancelledError:
        # Remote /stop reaches the route task through the durable lease heartbeat.
        # The cancel intent already fenced this owner; do not append a stale stopped
        # turn or perform an unfenced save from a worker that has lost ownership.
        # 提示仍然要给 —— 但只用**纯函数**算，不写 state、不落库：这个 worker
        # 已经不是会话的主人了。
        public = {k: v for k, v in s.state.items() if not k.startswith("_")}
        return {"reply": "（已停止）", "stopped": True, "needs_confirm": False,
                "followups": followup_prompts(
                    answer="（已停止）", state=public, asked=_asked(s),
                    files=[f["name"] for f in s.files], status=s.status)}
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        await get_repo().release_chat_lease(sid, owner=lease_owner)


async def _chat_claimed(s: Session, body: dict[str, Any], *,
                        chat_owner: str) -> dict[str, Any]:
    """对话入口。

    **不阻塞流水线**：梳理跑着的时候仍可查询、解释和补充上下文。会改产物的工具
    在 Run 进行中明确拒绝并提示稍后重试；当前实现没有 durable mutation queue，
    因而不能声称动作已排队，否则 FDE 会误以为改动将在后台自动生效。
    """
    # 请求时捕获界面语言：助手回复语言、意图解析规则表都据此选（后台管线读不到请求）。
    s.lang = "en" if str(body.get("lang") or "").lower().startswith("en") else "zh"
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "说点什么")
    # 用户对上一轮那个被挡住的动作说「确认」。**这一轮限定放行** ——
    # 不是给会话开一个长期后门。
    approved = bool(body.get("confirm"))

    # 确认时**直接重放**上一轮被拦的动作，不重新推理。全局 approved bool 不记得
    # 在确认什么，模型重新推理时会把「确认」理解成别的意思（采纳哪条建议）——
    # 用户明明在确认一个模板编辑，却被问"要采纳第几条建议"。重放才是确定的。
    pending_all = s.state.get("_pending_actions") or (
        [p] if (p := s.state.get("_pending_action")) else [])
    if approved and pending_all:
        _publish_turn(s, Speaker.USER, text, intent="confirm", confidence=1.0)
        # 逐个重放，逐个回执 —— 做了几件就说几件，不能只报第一件
        parts = [await _replay_pending(s, a, batch=i)
                 for i, a in enumerate(pending_all)]
        reply = "\n\n".join(x for x in parts if x)
        _publish_turn(s, Speaker.ASSISTANT, reply)
        s.state["_pending_actions"] = []
        s.state["_pending_action"] = None
        # 重放没走推理循环，也就没有自带的追问 —— 这条路上补算一次。
        replay_followups = _settle_followups(s, reply=reply)
        await _persist(s, status=False, chat_owner=chat_owner)
        return {"reply": reply, "needs_confirm": False, "replayed": True,
                "followups": replay_followups}

    parse = _parser_for(s).parse(text)
    top = max(parse.matches, key=lambda m: m.confidence)
    _publish_turn(s, Speaker.USER, text, intent=str(top.intent),
                  confidence=top.confidence)

    # **每一轮都进推理循环。** 以前是规则判出意图就直接执行、模型只负责措辞 ——
    # 那样「你好」根本走不到推理，轨迹永远是空的；规则判错时模型也没有机会纠正，
    # 它拿到的已经是既成事实。
    #
    # 规则的判定没有丢，降级成提示塞进 prompt：它便宜、准、可审计，
    # 但不再是绕过模型的旁路。
    hint = "、".join(
        f"{m.intent.value}({m.confidence:.0%}"
        + (f", {json.dumps(m.slots, ensure_ascii=False)}" if m.slots else "") + ")"
        for m in parse.matches if m.intent is not Intent.UNKNOWN)
    s.chat_task = asyncio.create_task(_reason(s, text, hint=hint, approved=approved))
    try:
        turn = await s.chat_task
    except asyncio.CancelledError:
        # 用户点了停止。已经流出的推理步骤留着，落一个"已停止"标记，安静收尾。
        # 这里 catch 的是**子任务**被 cancel —— 不会连带取消 chat() 这个协程本身。
        _publish_turn(s, Speaker.ASSISTANT, "（已停止）")
        # 停下来之后更需要一个出口。
        stopped_followups = _settle_followups(s, reply="（已停止）")
        await _persist(s, status=False, chat_owner=chat_owner)
        return {"reply": "（已停止）", "stopped": True,
                "needs_confirm": False, "followups": stopped_followups}
    finally:
        s.chat_task = None
    replies = [turn.answer] if turn.answer else []
    if turn.citations:
        replies.append("依据：" + "　".join(f"◧ {c}" for c in turn.citations[:4]))
    if turn.followup:
        replies.append(f"（我不确定的一点：{turn.followup}）")

    reply = "\n\n".join(r for r in replies if r) or "收到。"
    _publish_turn(s, Speaker.ASSISTANT, reply)
    # 系统刚说完"有 3 个死路"，用户得自己想出"哪三个"这个问题 —— 这个断层
    # 没理由留给他。**在 _persist 之前定下来**，chips 才跟着这一轮一起落库。
    followups = _settle_followups(s, model_questions=turn.next_questions, reply=reply)
    # 人拍的板是最不该丢的一份状态，每轮都落。
    await _persist(s, status=False, chat_owner=chat_owner)
    # 这一轮有没有动作被确认门挡住 —— 前端据此显示确认按钮。靠子串匹配确认门的
    # 拒绝语（tools.py 里 requires_approval 挡下时的固定措辞）：确认门是唯一产出
    # 这些字样的地方，约定稳定，比另开一条并行布尔信号更不容易走岔。
    pending = [x for x in turn.steps
               if "需要人工确认" in str(x.get("observation") or "")
               or "要用户确认" in str(x.get("observation") or "")]
    return {"intents": parse.to_dict(),
            "reply": reply, "needs_confirm": bool(pending),
            "usd": round(float(s.state.get("_chat_usd") or 0), 4),
            "followups": followups}


def _ask_back(s: Session, m: Any) -> str:
    """判不出意图时反问。**不猜** —— 猜错一个 SET_SCOPE 会静默删掉一批对象。"""
    hint = (m.slots or {}).get("hint")
    if hint == "adopt_which":
        ss = s.state.get("suggestions") or []
        opts = "；".join(f"{i + 1}. {x['title']}" for i, x in enumerate(ss[:5]))
        return f"你是要采纳哪一条？现在有：{opts}" if opts else "现在还没有建议可以采纳。"
    return _outcome(
        "not_understood",
        "这句我没把握理解成一个具体动作。你可以直接说：回答第几个问题、"
        "采纳第几条建议、约定口径、排除哪些对象、或者让我解释某个判断。",
        没听懂的原话=str((m.slots or {}).get("phrase") or m.span or ""),
        我能做的=["回答某个待拍板的问题", "采纳/否决某条建议", "约定口径或命名",
                "排除某些对象", "解释某个判断的依据", "开始或重跑梳理"],
        当前有几条建议=len(s.state.get("suggestions") or []),
        当前有几个待拍板=len(s.state.get("questions") or []))



#: 措辞生成的产出契约。**只让模型措辞，不让它决定事实** —— 事实由执行器算好
#: 一并传进去，模型的任务是把它说成人话。
_SAY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["reply"],
    "properties": {
        "reply": {"type": "string",
                  "description": "给 FDE 的回复。用给你的事实说话，**一个数字都不要改、"
                                 "不要补充事实里没有的东西**。简短、像人说话、不要复述他的问题。"},
    },
}

_SAY_SYSTEM = """你是 OntoCopilot 的对话侧，面对一位 FDE 工程师。

系统刚刚替他做了一件事，把结果告诉你。你的任务只有一个：**把这个结果说成人话**。

纪律：
- 事实以给你的为准。数字、名字、条数一个都不许改，也不许补充没给你的东西。
- 简短。他要的是"做了什么、接下来能干什么"，不是解释。
- 不要用"好的""收到""没问题"开头。直接说结果。
- 他没问的别答，别推销功能。"""



def _as_outcome(r: Any) -> dict[str, Any]:
    """兼容：执行器可以返回结构化 outcome，也可以直接返回一句话。

    逐个改造二十几个分支是可以的，但一次改完全部会让这次改动没法验证 ——
    先让两种形态都能走，再逐个把有价值的分支改成带事实的。
    """
    if isinstance(r, dict):
        return r
    return {"kind": "text", "facts": {"结果": str(r)}, "fallback": str(r)}


async def _say(s: Session, outcome: dict[str, Any], user_text: str) -> str:
    """把执行结果措辞成一句回复。

    以前这里是二十几处写死的字符串。规则决定**做什么**是对的（可审计、免费、
    确定），但"这句话怎么说"是对话本身 —— 模板化的结果是一个明显在念稿子的
    副驾：问它"你好"，它回"在。"

    事实和措辞分开的好处是双向的：数字不会被模型改掉，措辞不会被模板卡死。
    模型不可用时退回 ``fallback`` —— 说得难听点总比不说话强。
    """
    fallback = str(outcome.get("fallback") or "")
    if outcome.get("verbatim"):
        return fallback  # 有些回复必须一字不差（比如引用原文）
    _trace_aux(s, "措辞", f"把「{outcome.get('kind', '结果')}」的事实说成人话")
    try:
        prompt = (
            f"## 他说的\n{user_text}\n\n"
            f"## 系统做了什么（事实，照它说）\n"
            f"{json.dumps(outcome.get('facts') or {}, ensure_ascii=False, indent=1)}\n\n"
            f"## 备用措辞（可参考，但你可以说得更好）\n{fallback}"
        )
        async with _chat_run(
            s,
            kind="say",
            semantic_input={"prompt": prompt, "lang": s.lang},
        ) as run:
            comp = await run.gw.call(
                "CHAT.say", prompt,
                system=_SAY_SYSTEM, difficulty=Difficulty.LOW, schema=_SAY_SCHEMA,
                max_tokens=600)
        said = str((comp.data or {}).get("reply") or "").strip()
        return said or fallback
    except Exception:  # noqa: BLE001 — 措辞失败不该让整轮对话失败
        return fallback


def _outcome(kind: str, fallback: str, **facts: Any) -> dict[str, Any]:
    """执行器的返回形态：**事实 + 备用措辞**，不是一句成品。"""
    return {"kind": kind, "facts": facts, "fallback": fallback}


# ══════════════════════════════════════════════════════════════════
#  AI 推荐问题（面向 FDE）
# ══════════════════════════════════════════════════════════════════
#: 推荐问题的产出契约。至多 3 条；``send`` 缺省等于 ``text``（同 onto.prompts.Prompt）。
_FOLLOWUPS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["questions"],
    "properties": {
        "questions": {
            "type": "array", "maxItems": 3,
            "items": {
                "type": "object", "required": ["text"],
                "properties": {
                    "text": {"type": "string", "description": "展示给 FDE 的问题，一句话"},
                    "send": {"type": "string",
                             "description": "点下去实际发送的话；缺省等于 text"},
                },
            },
        },
    },
}

_FDE_SYSTEM = """你在为一位 FDE（前向部署工程师）预测：结合当前项目状态，
他接下来最可能想问的问题。

给 3 条以内。每条都要：
- 具体、可执行 —— 扣住材料、产物、待拍板/建议的现状，别问空泛的（"能详细说说吗"）。
- 是这个角色真正关心的：材料哪里没写清、哪些推断没依据、口径由谁定、
  哪些必须问客户、接下来该跑什么。
- 只问答得上、且答了有用的 —— 一个点下去得到"我查不到"的问题，净价值是负的。

不要寒暄，不要重复他已经问过的，不要把一个问题拆成两条。"""


def _as_prompts(questions: list[str]) -> list[dict[str, Any]]:
    """模型给的追问 → 可点的 chips。

    显示的和点下去发出去的是**同一句话**：chip 上写着什么，他就问了什么。
    """
    return [{"text": q, "send": q, "group": ""} for q in questions]


def _settle_followups(s: Session, *, model_questions: list[str] | None = None,
                      reply: str = "") -> list[dict[str, Any]]:
    """定下这一轮的 chips，记进会话状态，并返回它们。

    **每一次交互结束，聊天窗口里都得有"接下来能问什么"** —— 这是这个函数存在的
    全部理由。两级来源，后一级保证非空：

    1. 模型跟着回答一起给的（最贴，零额外往返）；
    2. 启发式（:func:`followup_prompts` 不会返回空）。

    **这里不发起任何模型调用，所以它是同步的。** 曾经有过第三级"补算一次"，
    删掉是因为它在一条对话请求里 await：答案早就通过 SSE 上屏、思考气泡也收了，
    用户读完就去点 chips —— 而这条请求还攥着 chat lease 没还，那一下点击直接吃
    409「已有一轮对话正在处理」，连他输入框里的字都被清掉了。网关挂掉时更糟：
    答案本身重试完 6~9 秒，补算再对着同一个死网关重试一遍，翻倍。
    模型自己都判断"没什么好问的"时，用一批免费的、按状态长出来的提示顶上，
    比让他为此等一次往返划算得多。

    写进 ``s.state`` 而不是只当返回值：chips 是会话的一部分，重开会话、刷新页面
    之后"接下来干什么"不该消失。调用方随后的 ``_persist`` 会把它落库。
    """
    qs = _as_prompts(
        [q for q in (str(x).strip() for x in (model_questions or [])) if q][:3])
    if not qs:
        public = {k: v for k, v in s.state.items() if not k.startswith("_")}
        qs = followup_prompts(answer=reply, state=public,
                              files=[f["name"] for f in s.files], status=s.status,
                              asked=_asked(s))
    s.state["followups"] = qs
    return qs


def _asked(s: Session) -> list[str]:
    """他自己说过的话。启发式提示据此避开"推荐他刚问过的那句"。"""
    dm = s.state.get("_dialogue")
    turns = (dm.to_dict().get("turns") if dm is not None else []) or []
    return [str(t.get("text") or "") for t in turns if t.get("speaker") == "user"]


def _fast_spec(gw: Any) -> Any:
    """辅助调用（推荐问题）用哪个模型规格：路由表给的最低推理档。

    ``None`` 表示这套路由没有单独的快档（Anthropic 的 Haiku、离线 stub），
    调用方照常按难度路由 —— 不要在这里瞎编一个 effort 下发给不认它的后端。
    """
    return getattr(getattr(gw, "routing", None), "fast", None)


async def _ai_recommend(s: Session, *, slot: str, user_text: str | None = None,
                        reply: str | None = None) -> list[dict[str, Any]] | None:
    """结合上下文，让模型预测 FDE 接下来会问的问题。

    失败 / 空结果一律返回 ``None`` —— 调用方据此退回启发式 ``prompts.py``。
    ``slot="followup"`` 传 ``user_text``/``reply``（他刚问的和刚给的答复）；
    ``slot="opening"`` 只看当前项目状态。
    """
    # 对话花费封顶时就别再花这一次 —— 推荐问题是锦上添花，不值得顶着上限跑。
    spent = float(s.state.get("_chat_usd") or 0.0)
    cap = float(os.getenv("ONTOCOPILOT_CHAT_USD_CAP", "3"))
    if spent >= cap:
        return None
    try:
        corpus = s.state.get("corpus") or {}
        findings = "；".join(f.get("message", "")
                             for f in (corpus.get("findings") or [])[:5])
        dm = s.state.get("_dialogue")
        dlg = (dm.to_dict().get("turns") if dm is not None else []) or []
        recent = "\n".join(f"{t.get('speaker')}: {str(t.get('text', ''))[:200]}"
                           for t in dlg[-4:] if t.get("speaker") != "system")
        prompt = (
            f"## 当前项目状态\n{_context_brief(s)}\n"
            + (f"\n## 材料里已发现的问题\n{findings}\n" if findings else "")
            + (f"\n## 最近几轮对话\n{recent}\n" if recent else "")
            + (f"\n## 他刚问的\n{user_text}\n" if user_text else "")
            + (f"\n## 刚给他的回复\n{reply}\n" if reply else ""))
        async with _chat_run(
            s,
            kind="recommend",
            semantic_input={"slot": slot, "prompt": prompt, "lang": s.lang},
        ) as run:
            # 400 太紧了：会思考的模型（gemini-2.5+/o 系列）推理 token 也算进这个额度，
            # 实测三条推荐问题连撞三次「JSON 不完整」然后整个失败。这几百 token 的差价
            # 远小于"每轮推荐问题都算不出来"的代价。
            #
            # 走**最低推理档**（routing.fast）。这一档的模型思考不能关（网关明说
            # "Reasoning is mandatory"），但能压到最低：实测同一句提示 7.8s/934 出
            # token → 3.5s/202，四分之一的钱。猜三条追问不值得一次深度推理。
            comp = await run.gw.call(
                "CHAT.recommend", prompt, system=_FDE_SYSTEM,
                difficulty=Difficulty.LOW, model=_fast_spec(run.gw),
                schema=_FOLLOWUPS_SCHEMA, max_tokens=4000,
            )
        s.state["_chat_usd"] = spent + float(getattr(comp, "usd", 0) or 0)
        out: list[dict[str, Any]] = []
        for q in (comp.data or {}).get("questions") or []:
            text = str(q.get("text") or "").strip()
            if not text:
                continue
            send = str(q.get("send") or "").strip() or text
            out.append({"text": text, "send": send, "group": ""})
            if len(out) >= 3:
                break
        return out or None
    except Exception:  # noqa: BLE001 — 推荐失败不该影响回复，退回启发式即可
        return None


def _trace_aux(s: Session, what: str, detail: str) -> None:
    """把**辅助性的模型调用**也投影进推理面板。

    措辞、推荐问题这些调用一样在花钱、一样是"AI 在想事情"，但它们不走对话推理
    循环，于是推理面板里完全看不见 —— 用户看到的是一个偶尔卡一下、不知道在干嘛
    的界面。既然那一栏叫「推理」，它就该是**这一轮所有模型工作**的全集。
    """
    n = len([e for e in s.events if e.get("kind") == "chat.step"
             and (e.get("step") or {}).get("turn") == "aux"]) + 1
    s.emit("chat.step", step={"turn": "aux", "q": "后台", "n": n,
                              "thought": f"{what}：{detail}"})


async def _emit_ai_prompts(s: Session, *, slot: str = "opening") -> None:
    """后台算**开场**推荐问题，算出来了就发 ``prompts.ready`` 换掉启发式那批。

    只有开场（新会话、材料传完）走后台：那会儿人在读文件列表，晚几秒换一批提示
    不打断任何事。**一轮对话的追问不走这里** —— 它跟着回答一起回来（见
    ``converse.ANSWER_SCHEMA`` 的 next_questions），所以这里不需要对轮次，
    也就不会有一个活过 chat lease 的后台 writer。

    失败就什么都不发 —— ``/files``、``/sessions`` 早已带着启发式提示返回，
    chips 已经在了。
    """
    # This optional model call still writes chat spend and durable events.  Give it a
    # real chat lease rather than letting a fire-and-forget task outlive the request
    # that spawned it and race the next worker's turn.  If a human turn already owns
    # the session, simply keep the heuristic prompts that the HTTP response included.
    owner = f"{_WORKER_ID}:recommend:{uuid.uuid4().hex}"
    claimed = await get_repo().claim_chat_lease(
        s.id, owner=owner, now=time.time(), ttl=_CHAT_LEASE_TTL,
    )
    if not claimed:
        return
    owner_task = asyncio.current_task()

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(_CHAT_HEARTBEAT_INTERVAL)
            renewed = await get_repo().renew_chat_lease(
                s.id, owner=owner, now=time.time(), ttl=_CHAT_LEASE_TTL,
            )
            if not renewed:
                if owner_task is not None and not owner_task.done():
                    owner_task.cancel()
                return

    heartbeat_task = asyncio.create_task(
        heartbeat(), name=f"recommend-heartbeat:{s.id}",
    )
    try:
        # 推理面板记的是**它在想什么**，不是它想出来的东西。算完的推荐问题不再往这里
        # 抄一份：那是给人点的产物，位置在聊天窗口的 chips 上；抄进推理面板只会得到
        # 一行截断到 18 字、点不了的半截问题，还让人以为回答还没完。
        before = float(s.state.get("_chat_usd") or 0.0)
        _trace_aux(s, "想推荐问题", "结合当前材料和产物，算他最该从哪问起")
        qs = await _ai_recommend(s, slot=slot)
        if float(s.state.get("_chat_usd") or 0.0) != before:
            await _persist(
                s, status=False, chat_owner=owner, docs_only={"_chat_usd"},
            )
        if qs:
            s.emit("prompts.ready", slot=slot, questions=qs)
    except asyncio.CancelledError:
        # Losing the durable owner fences both spend projection and prompt delivery.
        return
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        await get_repo().release_chat_lease(s.id, owner=owner)


async def _act(s: Session, m: Any) -> str:
    """执行一个意图。每个分支都要回显**它到底做了什么**，不能只回"好的"。"""
    dm = _dialogue(s)
    slots = m.slots or {}

    if m.intent is Intent.CHITCHAT:
        # 寒暄本来就是对话，最没理由套模板 —— 「你好」回「在。」是这套东西
        # 在念稿子最刺眼的证据。
        st = (s.state.get("oir") or {}).get("stats") or {}
        return _outcome("chitchat", "在。" if not s.files else _status_line(s),
                        材料份数=len(s.files),
                        材料=[f["name"] for f in s.files][:5],
                        当前产物=st or "还没跑过梳理",
                        待拍板=len(s.state.get("questions") or []),
                        建议条数=len(s.state.get("suggestions") or []))
    if m.intent is Intent.ASK_STATUS:
        st = (s.state.get("oir") or {}).get("stats") or {}
        spent = (s.state.get("budget") or {}).get("spent") or {}
        return _outcome("status", _status_line(s),
                        产物=st or "还没跑过梳理", 材料份数=len(s.files),
                        花费美元=round(float(spent.get("usd") or 0), 2),
                        待拍板=len(s.state.get("questions") or []),
                        建议=[x["title"] for x in (s.state.get("suggestions") or [])][:5])
    if m.intent is Intent.ADD_CONTEXT:
        dm.decide(DecisionKind.CORRECTION, slots.get("content", "")[:200])
        # 收作补充背景，进后续重抽的上下文。要直接改当前产物，走对话推理循环
        # （oir.add/flow.edit）—— 那条路把口述的事实落进 OIR/流程图并要用户确认。
        return ("收下了，作为补充背景，会进后续节点的上下文。想直接改当前产物"
                "（补字段/加取值/连流程），直接说，我用结构化编辑改并请你确认。")
    if m.intent in (Intent.SET_CALIBER, Intent.SET_NAMING):
        kind = (DecisionKind.CALIBER if m.intent is Intent.SET_CALIBER
                else DecisionKind.NAMING)
        d = dm.decide(kind, slots.get("statement", ""))
        cn = "口径" if kind is DecisionKind.CALIBER else "命名"
        return _outcome(
            "decision_recorded",
            f"记为{cn}约定：{d.statement}。后续每个抽取节点都会带上它；"
            f"要让它作用到已抽好的部分，说一声「重跑」。",
            记下的约定=d.statement, 类型=cn,
            生效范围="后续每个抽取节点；已抽好的部分要重跑才会应用",
            当前生效的约定数=len(dm.active_decisions()),
            已经跑过梳理=bool(s.state.get("_oir")))
    if m.intent is Intent.SET_SCOPE:
        return _do_scope(s, slots)
    if m.intent in (Intent.ADOPT_SUGGESTION, Intent.REJECT_SUGGESTION):
        return _do_suggestion(s, m)
    if m.intent is Intent.EXPLAIN:
        return _do_explain(s, slots)
    if m.intent is Intent.ANSWER_QUESTION:
        return _do_answer(s, slots)
    if m.intent is Intent.START_BUILD:
        outcome = await _claim_and_start_build(s)
        if outcome == "no_files":
            return "还没有材料。把文件拖进来，或者点 + 添加。"
        if outcome == "missing":
            return "这个会话已经不存在了，请回到会话列表重新打开。"
        if outcome == "awaiting_answer":
            return "当前正在等业务回答。先回答、延期或导出问题清单，不能用新一轮覆盖待拍板状态。"
        if outcome != "started":
            return "已经在跑了。"
        return f"开始梳理 {len(s.files)} 份材料。过程我会一步步说。"

    if m.intent is Intent.RERUN:
        # 重出模板是**确定性重算**（对齐→冲突→自动修→澄清→编译），零模型调用。
        # 重抽材料才要重跑 DAG，那个贵得多，不能一句"重跑"就替用户花钱。
        oir = s.state.get("_oir")
        if oir is None:
            return "还没有产物。点「开始梳理」跑第一轮。"
        if any(w in slots.get("phrase", "") for w in ("模板", "编译", "产物", "出表")):
            await _recompile(s)
            return (f"已按当前结果重出模板：{s.state['template']['sheets']} 张表、"
                    f"{s.state['template']['prefilled']} 格预填。")
        return ("重抽材料要重跑整个 DAG，是要花钱的（上一轮 "
                f"${(s.state.get('budget') or {}).get('spent', {}).get('usd', 0):.2f}）。"
                "确定的话点「重新梳理」。只想按新决定重出模板的话，说「重出模板」。")
    return ""


def _status_line(s: Session) -> str:
    st = (s.state.get("oir") or {}).get("stats") or {}
    if not st:
        return f"还没跑过梳理。当前 {len(s.files)} 份材料就绪。"
    spent = (s.state.get("budget") or {}).get("spent") or {}
    return (f"已完成：{st.get('objects', 0)} 个对象、{st.get('properties', 0)} 个属性、"
            f"{st.get('links', 0)} 条关系、{st.get('actions', 0)} 个行动、"
            f"{st.get('rules', 0)} 条业务规则。花了 ${spent.get('usd', 0):.2f}。"
            f"还有 {len(s.state.get('questions') or [])} 个待拍板、"
            f"{len(s.state.get('suggestions') or [])} 条建议。")


def _do_scope(s: Session, slots: dict[str, Any]) -> str:
    """纳入/排除。落不到具体对象上就反问，**绝不按模糊短语批量删**。"""
    oir = s.state.get("_oir")
    named = slots.get("named") or []
    action = slots.get("action", "exclude")
    if oir is None:
        return "还没有产物可以调整范围，先跑一轮梳理。"
    if not named:
        # 挂到建议上：EXCLUDE 类建议的 payload 里已经有算好的对象清单
        tech = next((x for x in s.state.get("suggestions") or []
                     if x["kind"] == "EXCLUDE"), None)
        if tech and action == "exclude":
            n = len(tech["payload"].get("objects") or [])
            return (f"你是指那 {n} 个疑似临时/日志表吗？（{tech['title']}）"
                    f"说「采纳」我就按这份清单排除。")
        return "没听出具体是哪些对象。给个名字，或者引用某条建议。"
    dm = _dialogue(s)
    dm.decide(DecisionKind.SCOPE,
              f"{'排除' if action == 'exclude' else '保留'} {'、'.join(named)}",
              scope_refs=named)
    return (f"记下了：{'排除' if action == 'exclude' else '保留'} "
            f"{'、'.join(named)}。产物在下次编译模板时生效。")


def _do_suggestion(s: Session, m: Any) -> str:
    sid = (m.slots or {}).get("suggestion_id")
    sug = next((x for x in s.state.get("suggestions") or [] if x["id"] == sid), None)
    if sug is None:
        return "这条建议已经不在列表里了。"
    dm = _dialogue(s)
    adopt = m.intent is Intent.ADOPT_SUGGESTION
    dm.decide(DecisionKind.ADOPTION,
              f"{'采纳' if adopt else '否决'}：{sug['title']}", scope_refs=[sid])
    if not adopt:
        return f"好，不做「{sug['title']}」。"
    oir = s.state.get("_oir")
    if oir is None:
        return f"记下了：采纳「{sug['title']}」。等跑完一轮梳理才有产物可以落。"
    applied = apply_suggestion(oir, sug, note=f"对话中采纳：{sug['title']}")
    if not applied["changed"]:
        return (f"「{sug['title']}」这条没有可以自动执行的动作 —— "
                f"它需要你补材料或逐条选择，我不能替你做。")
    # 快照要跟着刷 —— 内存里的 OIR 已经变了，前端读的是 state["oir"]，
    # 不刷的话界面上纹丝不动，用户会以为采纳没生效。
    s.state["oir"] = oir.to_dict()
    s.emit("human.recorded", conflict=sid, option="adopt",
           label=applied["label"], changed=applied["changed"])
    return _outcome(
        "suggestion_applied",
        f"已采纳「{sug['title']}」，实际改了 {len(applied['changed'])} 项。"
        f"说「重出模板」我就按新结果重编译。",
        建议=sug["title"], 实际改动数=len(applied["changed"]),
        改动类型=applied["kind"], 产物是否已重编译=False,
        下一步="说「重出模板」按新结果重编译")


def _do_explain(s: Session, slots: dict[str, Any]) -> str:
    """解释某个判断。**只讲有据可查的**，讲不出依据就说讲不出。"""
    oir = s.state.get("_oir")
    named = slots.get("named") or []
    if oir is None or not named:
        return "指个具体对象或判断，我把依据和出处调出来。"
    out = []
    for name in named[:3]:
        ot = next((o for o in oir.objects.values()
                   if o.api_name.value == name), None)
        if ot is None:
            continue
        ev = ot.api_name.evidence
        cite = ev[0].cite() if ev else "无出处"
        acts = [a.api_name.value for a in oir.actions.values() if ot.rid in a.applies_to]
        out.append(f"{name}（{ot.display_name.value}）来自 {cite}"
                   + (f"，挂了 {len(acts)} 个行动：{'、'.join(acts[:4])}" if acts else
                      "，材料里没有给它定义任何字段或行动"))
    return "\n".join(out) or "没找到这些对象。"


def _do_answer(s: Session, slots: dict[str, Any]) -> str:
    """用文字回答一个澄清问题。

    走的是和点选按钮**同一条**路径（apply_decision）—— 两条路径会漂移，
    而漂移的那天你不会知道该信哪个。
    """
    qid = slots.get("question_id")
    conflicts = s.state.get("_conflicts") or []
    target = next((c for c in conflicts if c.rid == qid), None)
    if target is None:
        return "对不上具体哪个问题，直接点问题卡片里的选项更稳。"
    q = next((x for x in s.state.get("questions") or []
              if x["conflict_rid"] == qid), None)
    opts = (q or {}).get("options") or []
    raw = str(slots.get("option") or "")
    idx = "①②③④⑤".find(raw)
    if idx < 0 and raw.isdigit():
        idx = int(raw) - 1
    if idx < 0 and raw.upper() in "ABCDE":
        idx = "ABCDE".index(raw.upper())
    if not (0 <= idx < len(opts)):
        return f"这个问题有 {len(opts)} 个选项，说个序号。"
    chosen = opts[idx]
    return (f"你选的是「{chosen['label']}」。点一下问题卡片里的确认按钮生效 —— "
            f"这一步改的是骨架，我不替你按。")


# ══════════════════════════════════════════════════════════════════
#  产物与溯源
# ══════════════════════════════════════════════════════════════════
@app.get("/api/sessions/{sid}/artifacts/{name}")
async def artifact(sid: str, name: str) -> FileResponse:
    s = await _sess_async(sid)
    p = s.dir / Path(name).name  # basename：防路径穿越
    if not p.exists():
        raise HTTPException(404, name)
    return FileResponse(p, filename=p.name)


@app.get("/api/sessions/{sid}/export")
async def export_table(sid: str, seq: int, format: str = "xlsx") -> Response:
    """把界面上某一张表直接导成文件（按事件 seq 定位）。

    界面上那排「存为 XLSX/CSV/…」按钮已经撤了 —— FDE 直接跟 OntoCopilot 说一句
    就行，不必在每张表下面挂一排按钮。这条路本身留着：它按**耐久事件 seq** 取表，
    冷 worker 也能服务，是 seq 定位导出的唯一入口。

    在内存里生成、不落盘：这条路是"看到什么就下什么"，没有留档的意义。AI 用
    ``export.file`` 工具导的那份才落盘 —— 那是他明确要来的东西。
    """
    from .onto import export as X

    s = await _sess_async(sid)
    ev = next((e for e in reversed(s.events)
               if e.get("seq") == seq and e.get("kind") == "ui.table"), None)
    if ev is None:
        # SSE 发出的 seq 来自 session_event；下载请求可能落到另一个 worker，
        # 不能依赖原 worker 的 Session.events 缓存。
        durable = await get_repo().read_events(sid, since=seq)
        row = next((x for x in durable
                    if x.seq == seq and x.kind == "ui.table"), None)
        ev = row.as_sse() if row is not None else None
    if ev is None:
        raise HTTPException(404, "没有这张表")
    fmt = X.resolve_format(format)
    if not fmt:
        raise HTTPException(400, f"不支持的格式 {format}")
    rows = [list(r) for r in (ev.get("rows") or [])]
    doc = X.ExportDoc(title=str(ev.get("title") or "清单"),
                      blocks=X.table_block(list(ev.get("columns") or []), rows),
                      note=f"共 {len(rows)} 条，由 OntoCopilot 导出")
    data, spec = X.render(doc, fmt)
    name = X.safe_name(doc.title, spec.ext)
    return Response(content=data, media_type=spec.media_type,
                    headers={"Content-Disposition": _content_disposition(name)})


@app.get("/api/sessions/{sid}/exports/{name}")
async def export_download(sid: str, name: str) -> FileResponse:
    """下载对话里导出的文件。

    单独一个目录、单独一个路由 —— 导出件**不是产物**。产物列表是"会话根目录下所有
    文件"算出来的，把导出塞在那儿会让它混进产物 tab、混进交付包 zip，一个叫
    「问题清单.xlsx」的导出还会被「下载填写模板」按钮抓走（它取第一个 .xlsx）。
    """
    s = await _sess_async(sid)
    p = s.dir / "exports" / Path(name).name      # basename：防路径穿越
    if not p.exists():
        raise HTTPException(404, name)
    return FileResponse(p, filename=p.name,
                        headers={"Content-Disposition": _content_disposition(p.name)})


def _content_disposition(name: str, *, ascii_fallback: str = "") -> str:
    """带中文文件名的 Content-Disposition：ASCII 兜底 + RFC 5987 filename*，
    让中文包名在各浏览器都能正确落地。

    兜底名以前**硬编码成 bundle.zip** —— 只有交付包一个调用方时没露馅，但任何其他
    格式复用它，都会在忽略 filename* 的客户端上存成一个 .zip。按真实后缀生成。
    """
    from urllib.parse import quote

    ext = Path(name).suffix or ".bin"
    fallback = ascii_fallback or f"download{ext}"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


@app.get("/api/sessions/{sid}/bundle")
async def bundle(sid: str, materials: bool = True) -> Response:
    """把会话的全部产物打成一个交付 zip（产物 + manifest.json + 交付说明.md）。

    **收集而非重算** —— 产物在节点边界和每次 edit 都已落盘、与内存态一致；重算只会
    引入字节漂移、破坏可复现。用会 hydrate 的 ``_sess_async``：FDE 常在重启后打开
    旧会话来导出，这时 `_flow`/oir/flow/artifacts 都靠 hydrate 载回。
    """
    import time
    from datetime import datetime

    from .onto import bundle as B

    def _aval(x: Any) -> str:
        v = x.get("value") if isinstance(x, dict) else x
        return str(v or "").strip()

    s = await _sess_async(sid)
    # Bundle 是给业务方/下游消费的**正式交付边界**，与仍可下载的单份工作产物
    # 不同。Question Ledger 是权威门禁：旧 ``release_state=RELEASED`` 在重新打开
    # blocking 问题后会滞后，不能据此继续发旧包。
    rows = await get_repo().list_questions(sid)
    backlog = (QuestionBacklog.from_dict([row.doc for row in rows])
               if rows else _question_backlog(s))
    pending = [q for q in backlog.questions.values() if q.status in {
        QuestionStatus.OPEN, QuestionStatus.ASSIGNED, QuestionStatus.BLOCKED,
    }]
    blockers = [q for q in pending if q.blocking]
    if blockers:
        preview = "、".join(q.id for q in blockers[:5])
        more = f" 等 {len(blockers)} 项" if len(blockers) > 5 else ""
        raise HTTPException(
            409,
            f"正式 Bundle 已被阻塞问题拦截：{preview}{more}。"
            "问题清单和单份工作产物仍可下载；处理或明确取消阻塞项后再导出。",
        )
    stored_release = str(s.state.get("release_state") or "").upper()
    release_state = (
        "DRAFT" if pending or stored_release != "RELEASED" else "RELEASED"
    )
    entries: list[tuple[str, bytes]] = []
    files_meta: list[dict[str, Any]] = []
    if s.dir.exists():
        for p in sorted(s.dir.iterdir()):
            if not p.is_file():         # 跳过 materials/journal/blobs 子目录
                continue
            data = p.read_bytes()
            kind, title, prov = B.classify(p.name)
            entries.append((p.name, data))
            files_meta.append({"path": p.name, "size": len(data),
                               "sha256": sha256_hex(data), "kind": kind,
                               "title": title, "provenance": prov})

    mats_meta: list[dict[str, Any]] = []
    mdir = s.dir / "materials"
    if materials and mdir.exists():
        for p in sorted(mdir.iterdir()):
            if not p.is_file():
                continue
            data = p.read_bytes()
            entries.append((f"materials/{p.name}", data))
            mats_meta.append({"name": p.name, "size": len(data),
                              "sha256": sha256_hex(data)})

    oir = s.state.get("oir") or {}
    # 空会话：没有任何产物就别给一个空壳包
    if not files_meta and not s.state.get("flow") and not oir:
        raise HTTPException(409, "这个会话还没有产出可交付的产物，先跑一轮梳理。")

    open_qs: list[dict[str, Any]] = []
    for q in (oir.get("questions") or []):
        if not _aval(q.get("answer")):
            open_qs.append({"rid": q.get("rid", ""), "q": _aval(q.get("text"))})
    for q in (s.state.get("questions") or []):
        open_qs.append({"rid": q.get("conflict_rid", ""), "q": q.get("title", "")})

    now = time.time()
    try:
        row = await get_repo().get_session(sid)
        state_version = getattr(row, "state_version", 0) if row else 0
    except Exception:  # noqa: BLE001
        state_version = 0

    manifest = B.build_manifest(
        session={"id": s.id, "title": s.title, "project": s.project,
                 "status": s.status, "release_state": release_state,
                 "created": s.created,
                 "state_version": state_version},
        product_version=__version__, files=files_meta, materials=mats_meta,
        flow=s.state.get("flow"), oir=oir or None, open_questions=open_qs,
        generated_at=now,
        generated_at_iso=datetime.fromtimestamp(now, UTC).isoformat())
    blob = B.build_zip(entries, manifest, B.readme_text(manifest))
    fname = f"交付包_{s.project or s.title or s.id}_{s.id}.zip"
    return Response(content=blob, media_type="application/zip",
                    headers={"Content-Disposition": _content_disposition(fname)})


@app.get("/api/sessions/{sid}/source")
async def source(sid: str, file: str, q: str = "") -> dict[str, Any]:
    """按文件名取原文切片 —— 前端点「出处」时跳到这里。

    这是 ADR-3 的兑现：任何结论都要能点回原文的确切位置。

    **一律从构建时的缓存读，不重新解析。** 两个原因，第二个更要命：

    1. 扫描件重新解析要再调一次视觉模型，看一眼预览就付一次钱；
    2. 重跑 OCR 可能给出与抽取时**不同**的文本 —— 那样"点回原文"看到的
       就不是系统当初实际读到的东西，这个功能的意义正好被抵消。
    """
    s = await _sess_async(sid)
    name = Path(file).name
    cache = s.state.get("_chunks", {})

    if name in cache:
        pool = cache[name]
    else:
        path = s.dir / "materials" / name
        if not path.exists():
            raise HTTPException(404, file)
        if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".pdf", ".webp", ".tif", ".tiff"):
            return {"file": name, "kind": "scan", "chunks": [],
                    "findings": [{"kind": "not_parsed_yet",
                                  "message": "扫描件要走视觉模型识别，先点「开始梳理」。"
                                             "预览不会单独再跑一次 OCR。"}]}
        doc = default_registry().parse(path)
        pool = [{"cite": c.cite(), "text": c.render[:1500], "tags": c.tags,
                 "locator": c.locator} for c in doc.chunks]
        cache[name] = pool
        s.state["_chunks"] = cache

    hits = [c for c in pool
            if not q or q.lower() in c["text"].lower() or q in c["cite"]]
    # 不再截到 80 —— 一份材料几张表几百行，截断会让排在后面的整张表凭空消失。
    # 检索时（有 q）才收窄，浏览全文时给全量。
    limit = 200 if q else 2000
    return {"file": name, "kind": "cached", "chunks": hits[:limit],
            "findings": [f for f in s.state.get("corpus", {}).get("findings", ())
                         if f.get("file") == name]}


@app.post("/api/sessions/{sid}/audit")
async def audit(sid: str, files: list[UploadFile], apply: bool = False
                ) -> dict[str, Any]:
    """业务方回传的**两阶段**审核与回写。

    ``apply=false`` 只在 OIR 副本上运行规则，返回 cell diff/结构损伤/
    可回写预览，绝不修改当前 Ontology。``apply=true`` 才在 FDE 明确确认后
    merge、生成 revision、重算问题与全部产物。
    """
    s = await _sess_async(sid)
    if apply:
        async with _session_mutation(s, "audit.apply"):
            return await _audit_once(s, files, apply=True)
    return await _audit_once(s, files, apply=False)


async def _audit_once(s: Session, files: list[UploadFile], *,
                      apply: bool) -> dict[str, Any]:
    """Run preview/apply after the route acquired the required mutation lease."""
    spec_path = s.dir / "template.spec.json"
    if not spec_path.exists():
        raise HTTPException(409, "这个会话还没有编译出模板")
    if not files:
        raise HTTPException(400, "没有上传回传模板")
    if _busy(s):
        raise HTTPException(409, "当前梳理正在运行，请等当前版本提交后再回传。")
    up = files[0]
    raw = await up.read()
    max_bytes = int(os.getenv("ONTOCOPILOT_MAX_UPLOAD_MB", "100")) * 1024 * 1024
    if len(raw) > max_bytes:
        raise HTTPException(413, f"回传件超过上限 {max_bytes // 1024 // 1024} MB")
    # 预审不该在产物目录里制造一个看似已纳入交付的文件。单独
    # 放 returns/；应用后保留原件，manifest 仍能审计这版来自哪个回传。
    returned_dir = s.dir / "returns"
    returned_dir.mkdir(parents=True, exist_ok=True)
    safe = Path(up.filename or "returned.xlsx").name
    digest = sha256_hex(raw)
    dest = returned_dir / f"{digest[:12]}_{safe}"
    dest.write_bytes(raw)

    spec = TemplateSpec.load(spec_path)
    live = s.state.get("_oir")
    if live is None:
        raise HTTPException(409, "这个会话的 OIR 未恢复，不能审核回传件")
    # ReturnAuditor 会对命名违规做 auto_repair。即使是“预审”也必须给它
    # 副本，否则 apply=false 也会悄悄修改活 OIR。
    preview_oir = oir_from_dict(live.to_dict())
    result = ReturnAuditor().audit(spec, read_returned(dest), oir=preview_oir)
    summary = result.summary()
    diffs = [
        {"rid": d.rid, "sheet": d.sheet, "field": d.field,
         "before": d.before, "after": d.after, "owner": d.owner,
         "role": str(d.role), "changed": d.changed, "filled": d.filled}
        for d in result.diffs if d.changed
    ]
    from .onto.audit import merge_into_oir
    merge_probe = oir_from_dict(live.to_dict())
    mergeable, dropped = merge_into_oir(merge_probe, result.diffs)
    payload: dict[str, Any] = {
        **summary, "apply": apply, "applied": False, "diffs": diffs,
        "mergeable": mergeable, "dropped": dropped, "file": safe,
        "sha256": digest, "revision": int(s.state.get("artifact_revision") or 0),
        "autoRepairs": result.auto_repaired,
    }
    if not apply:
        # 预审摘要可以显示，但不持久一个“已完成 audit”的业务状态。
        s.emit("audit.previewed", **payload)
        return payload

    # ``AuditResult.damage`` 的契约是 fail closed：锚点缺失、重复 RID、
    # 表头/锚点被移动都意味着我们无法证明读回的是业务方实际填写的完整内容。
    # 不能因为仍有一部分 cell “看起来能读”就把它们混入当前 Ontology；否则
    # 一张损坏表会形成一个貌似成功、实则静默丢答复的 revision。
    if result.damage:
        raise HTTPException(
            422,
            detail={
                "code": "RETURN_TEMPLATE_DAMAGED",
                "message": "回传模板结构已改变，未应用任何数据。请按预审提示修复后重新上传。",
                "damage": result.damage,
                "sha256": digest,
            },
        )

    # 幂等检查必须在修改活 OIR 之前。否则即使后面发现 revision
    # 已存在，也已有一段时间让其它协程观察到未提交的 OIR。
    existing = next((r for r in await get_repo().list_revisions(s.id)
                     if r.idempotency_key == f"returned:{digest}"), None)
    if existing is not None and existing.status == str(RevisionStatus.APPLIED):
        committed = s.state.get("audit") or {}
        if committed.get("sha256") == digest and committed.get("phase") == "committing":
            # The Revision terminal row won but the final cosmetic projection did
            # not.  Artifacts/OIR were already committed by the preceding fenced
            # checkpoint; finish that marker without replaying merge or compile.
            committed = {**committed, "phase": "applied", "applied": True,
                         "created": False, "revision": existing.ordinal}
            s.state["audit"] = committed
            await _persist(s)
        return {**payload, **(committed if committed.get("sha256") == digest else {}),
                "applied": True, "created": False, "revision": existing.ordinal,
                "note": "这份回传件已应用过，未重复生成版本。"}
    if existing is not None and existing.status != str(RevisionStatus.PROPOSED):
        raise HTTPException(
            409,
            f"这份回传件的 Revision 已是 {existing.status}，不能再应用。",
        )

    before = live.to_dict()
    changed, dropped = merge_into_oir(live, result.diffs)
    # 预审里的命名 auto-repair 是在副本上算的；确认应用时要把同一份可逆修复
    # 明确提交到活 OIR，否则用户看到“将自动修复”，点确认后结果却没有修。
    for repair in result.auto_repaired:
        rid, new_name = str(repair.get("rid") or ""), repair.get("to")
        if not rid or not new_name:
            continue
        for bucket in (live.objects, live.properties, live.links, live.actions):
            entity = bucket.get(rid)
            if entity is None or entity.api_name.value == new_name:
                continue
            from .onto.oir import Origin
            entity.api_name.value = str(new_name)
            entity.api_name.origin = Origin.AUTO_REPAIRED
            changed.append(f"{rid}.apiName")
            break
    versions = _push_version(s, "_oir_versions", before)
    if not changed:
        versions.pop()
    s.state["oir"] = live.to_dict()

    # 回传合并是一次正式 artifact revision，不走聊天补丁旁路。
    rows = await get_repo().list_revisions(s.id)
    ordinal = max((r.ordinal for r in rows), default=0) + 1
    parent = max(rows, key=lambda r: r.ordinal).id if rows else None
    revision = Revision(
        id=f"rev.{ordinal}", ordinal=ordinal, parent_id=parent,
        # Claim first, publish only after compile + fenced projection commit.  A
        # process can die between those operations; ``proposed`` makes the same
        # idempotency key resumable instead of falsely reporting a half revision as
        # already applied.
        kind="returned_template", status=RevisionStatus.PROPOSED,
        patch_set=PatchSet(
            id=f"patch.return.{digest[:16]}", base_revision=max(0, ordinal - 1), ops=[],
            affected_ids=sorted({x.split('.', 1)[0] for x in changed}),
            blocked_artifacts=["ontology.package.json", "模板_v1.xlsx"],
            idempotency_key=f"returned:{digest}", actor="fde",
            reason=f"业务方回传 {safe}"),
        changed_ids=changed,
        invalidated_artifacts=["ontology.package.json", "模板_v1.xlsx", "问题清单.xlsx"],
        actor="fde", snapshot_hash=digest)
    if existing is None:
        try:
            stored, created = await get_repo().record_revision(
                s.id, RevisionRow.from_domain(
                    revision, idempotency_key=f"returned:{digest}"))
        except IdempotencyConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        if not created:
            # The durable mutation lease should make this unreachable; retain a
            # defensive read so a future caller cannot continue with an unknown row.
            existing = stored
    else:
        stored, created = existing, False

    # A prior invocation may have committed every projection/artifact and died in
    # the tiny window before finalising its Revision row.  The marker is written by
    # the same fenced session-state checkpoint as the OIR, so it is safe to finish
    # without recompiling (which would mint another artifact revision).
    durable_audit = s.state.get("audit") or {}
    if (not created and durable_audit.get("sha256") == digest
            and durable_audit.get("phase") == "committing"):
        stored = await get_repo().finalize_revision(
            s.id, stored.id, status=str(RevisionStatus.APPLIED),
        )
        durable_audit.update({"phase": "applied", "applied": True,
                              "created": False, "revision": stored.ordinal})
        s.state["audit"] = durable_audit
        await _persist(s)
        return {**payload, **durable_audit, "resumed": True,
                "note": "已完成上次中断的回传应用，未重复生成版本。"}

    s.state["audit"] = {
        **payload, "applied": True, "created": created,
        "changed": changed, "dropped": dropped,
        "revision": stored.ordinal, "phase": "committing",
    }

    await _recompile(s)
    await _persist(s)
    stored = await get_repo().finalize_revision(
        s.id, stored.id, status=str(RevisionStatus.APPLIED),
    )
    payload.update({
        "applied": True, "created": created, "changed": changed, "dropped": dropped,
        "revision": stored.ordinal, "artifact_revision": s.state.get("artifact_revision"),
        "artifacts": s.state.get("artifacts") or [], "phase": "applied",
    })
    s.state["audit"] = payload
    s.emit("audit.applied", revision=stored.ordinal,
           artifact_revision=payload["artifact_revision"],
           changed=len(changed), dropped=dropped, file=safe)
    await _persist(s)
    return payload


# ══════════════════════════════════════════════════════════════════
#  前端
# ══════════════════════════════════════════════════════════════════
@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    """前端外壳。**明确禁止缓存。**

    没有缓存头时浏览器会把这个 HTML 缓存住，于是后端改了、前端没改 —— 用户看到
    的是几个版本之前的界面，报上来的 bug 是早就修掉的那个。单文件前端（HTML 里
    内联 CSS+JS）尤其严重：整个应用就是这一个文件。
    """
    p = UI / "index.html"
    body = (p.read_text(encoding="utf-8") if p.exists()
            else "<h1>OntoCopilot</h1><p>前端未构建。API 在 /docs。</p>")
    return HTMLResponse(body, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache"})
