"""HTTP 服务 —— FastAPI + SSE。

事件流是内核事件日志的**投影**，不是另一套埋点。所以前端上看到的推理轨迹与
事后重放、审计看到的是同一份数据 —— 两套埋点必然会漂移，而漂移的那天你不会
知道该信哪个。

::

    uvicorn ontocopilot.server:app --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from . import __version__
from . import appconfig
from . import authgate
from . import configapi
from .kernel.backends import OpenAICompatBackend
from .store.deps import get_repo, get_store, lifespan as store_lifespan
from .store.repo import FileRow, SessionRow
from .kernel.budget import Budget
from .kernel.catalog import Capability, ModelCatalog, SmartGateway
from .kernel.dag import Difficulty
from .kernel.events import EventKind
from .kernel.journal import FileBlobStore, FileJournal
from .kernel.llm import ModelGateway, gateway_routing
from .kernel.recorder import Recorder
from .kernel.skills import default_library
from .onto.align import align_and_apply
from .onto.oir import oir_from_dict
from .onto.converse import ConversationAgent, needs_reasoning
from .onto.prompts import followup_prompts, opening_prompts
from .onto.suggest import apply_suggestion, suggest
from .onto.audit import ReturnAuditor, read_returned
from .onto.clarify import ClarificationEngine, apply_decision
from .onto.conflict import auto_repair, detect_all
from .kernel.bus.bus import AgentBus
from .kernel.critic import CriticPanel
from .kernel.loop import AgentLoop
from .kernel.intent import Intent, RuleIntentParser
from .kernel.memory.context import ContextManager
from .kernel.memory.dialogue import (
    Decision,
    DecisionKind,
    DialogueMemory,
    Speaker,
)
from .kernel.sandbox import default_sandbox
from .kernel.scheduler import Scheduler
from .kernel.tools import Danger, builtin_registry
from .kernel.agents import default_agents
from .onto.pipeline import (
    CoverageCritic,
    build_dag,
    build_oir,
    finish,
    handlers_for,
    provenance_critic,
    segment_corpus,
)
from .onto.parse import (
    build_index,
    collect_endpoints,
    collect_profiles,
    corpus_summary,
    default_registry,
)
from .onto.template import TemplateSpec, compile_template, write_xlsx

ROOT = Path("workspace")
UI = Path(__file__).resolve().parents[2] / "ui"


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
    status: str = "idle"  # idle | parsing | extracting | awaiting_answer | done | failed
    #: SSE 订阅者的队列。断线重连时按 seq 补发，见 /stream。
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    state: dict[str, Any] = field(default_factory=dict)
    error: str = ""

    @property
    def dir(self) -> Path:
        return ROOT / self.id

    def emit(self, kind: str, /, **payload: Any) -> dict[str, Any]:
        """发一条事件。

        ``kind`` 是**位置限定**参数（``/``）：payload 里带 ``kind`` 字段是很自然的
        写法（冲突类型、产物类型都叫 kind），不限定就会和这个形参撞名报错。
        payload 里的同名字段会覆盖事件类型，所以下面把它放在展开之前。
        """
        ev = {"seq": len(self.events), "ts": time.time(), **payload, "kind": kind}
        self.events.append(ev)
        for q in list(self.subscribers):
            q.put_nowait(ev)
        return ev

    def brief(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "project": self.project,
                "status": self.status, "files": len(self.files),
                "mode": self.state.get("mode", "work"),
                "created": self.created, "error": self.error}


SESSIONS: dict[str, Session] = {}

#: 按网关实际可用模型过滤后的目录。视觉选型（OCR）靠它 —— 见 _ensure_catalog。
#: 懒发现：第一次 build 时（网关此刻一定配好了）拉一次 /v1/models 并缓存。
_CATALOG: ModelCatalog | None = None
_CATALOG_OK: bool = False

# lifespan 取代 on_event("startup")：后者在 FastAPI 里已弃用，而且没有对称的
# 关闭钩子 —— 连接池不 dispose 的话，热重载会一轮轮泄漏连接。
@asynccontextmanager
async def _lifespan(app: FastAPI) -> Any:
    """先起库，再对账。顺序不能反 —— 对账要用 repo。"""
    async with store_lifespan(app):
        ROOT.mkdir(parents=True, exist_ok=True)
        await appconfig.refresh(get_repo())      # 预热设置缓存（网关/模型/预算覆盖）
        await _reconcile_on_boot()
        yield


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


def _sess(sid: str) -> Session:
    """取活着的会话。**不做恢复** —— 恢复要 await，这个函数是同步的。

    需要恢复的路由用 :func:`_sess_async`。
    """
    if sid not in SESSIONS:
        raise HTTPException(404, f"没有会话 {sid}（可能需要先打开它）")
    return SESSIONS[sid]


async def _sess_async(sid: str) -> Session:
    """取会话，不在内存里就从库/盘恢复。"""
    return SESSIONS.get(sid) or await _hydrate(sid)


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


def _gateways(out: Path, run_id: str) -> tuple[Any, ModelGateway, SmartGateway, Budget]:
    cfg = appconfig.resolved_llm_config()          # 设置 → env → 抛错
    rec = Recorder(run_id, FileJournal(out / "journal"), FileBlobStore(out / "blobs"))
    # 一份几百行的梳理表要跑十来个抽取节点，每个节点还可能因 critic 打回重来。
    # 上限设太紧的后果不是省钱，是跑到一半 HALT、前面花掉的钱全打水漂。
    budget = Budget(tokens=4_000_000, usd=appconfig.usd_cap())
    backend = OpenAICompatBackend(cfg.base_url, cfg.api_key)
    # 启动时按网关可用模型过滤过的目录 —— 视觉选型据此落到网关真有的视觉模型上
    catalog = _CATALOG or ModelCatalog()
    # 路由按当前设置构建（含各档模型覆盖）并随本次 Run 固定：配置改动只作用到之后
    # 新建的 Run，不影响在跑的这次。
    routing = gateway_routing(appconfig.model_overrides(), catalog)
    gw = ModelGateway(backend, rec, routing=routing, budget=budget)
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
    name = str((body or {}).get("model") or "")
    cat = await _ensure_catalog()
    s.state["model"] = name if (name and cat.get(name)) else ""
    await _persist(s, status=False)
    return {"model": s.state["model"]}


@app.get("/api/sessions")
async def list_sessions() -> list[dict[str, Any]]:
    """会话列表**以库为准**。

    内存里的 SESSIONS 只是本进程活着的那些。重启后库里还有一堆会话，
    只列内存的话它们就凭空消失了 —— 而 workspace/ 下的产物还在，
    用户会以为数据丢了。
    """
    rows = await get_repo().list_sessions()
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
async def create_session(body: dict[str, Any] | None = None) -> dict[str, Any]:
    body = body or {}
    s = Session(id=uuid.uuid4().hex[:12],
                title=body.get("title") or "采购中台 Ontology 梳理",
                project=body.get("project", ""))
    # 聊天 / 工作 双模式：chat = 纯对话（只读工具、无梳理管线），work = 完整工作台。
    s.state["mode"] = body.get("mode") if body.get("mode") in ("work", "chat") else "work"
    s.dir.mkdir(parents=True, exist_ok=True)
    SESSIONS[s.id] = s
    await get_repo().create_session(SessionRow(
        id=s.id, title=s.title, project=s.project, status=s.status,
        error="", created=s.created, state_version=0))
    await _persist(s, status=False)   # 把 mode 落下来，重载前就存在
    return s.brief()


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str, purge: bool = False) -> dict[str, Any]:
    """删会话。

    Args:
        purge: 连 ``workspace/<sid>/`` 一起删。默认 **False** —— 产物、事件日志、
            原始材料都在那儿，"从列表里去掉"和"把东西删了"是两件事，
            后者要用户明确说。
    """
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
    s = _sess(sid)
    mats = s.dir / "materials"
    mats.mkdir(parents=True, exist_ok=True)
    for f in files:
        dest = mats / Path(f.filename or "unnamed").name
        dest.write_bytes(await f.read())
        s.files.append({"name": dest.name, "size": dest.stat().st_size,
                        "path": str(dest)})
    await get_repo().add_files(sid, [
        FileRow(name=f["name"], rel_path=str(Path(f["path"]).relative_to(ROOT)),
                size=f["size"], sha256="")
        for f in s.files[-len(files):]])
    s.emit("files.attached", files=[f["name"] for f in s.files])
    # 上传即解析。xlsx / csv / ddl / docx 的解析是**零模型调用**的，没有任何
    # 理由让人先花几美元跑完整轮抽取才能问第一个问题。扫描件例外 —— 它要过
    # 视觉模型，那个要花钱，留到 build 再做。
    await _preparse(s)
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    return {"files": s.files, "corpus": s.state.get("corpus"),
            "prompts": opening_prompts(state=public,
                                       files=[f["name"] for f in s.files],
                                       status=s.status)}


async def _preparse(s: Session) -> None:
    """上传后立刻解析出证据索引，让对话马上能查材料。

    **不传 vision_gateway** —— 扫描件在这里只登记不识别，findings 里会明说
    "内容没有进入产物"，不静默跳过。真正的 OCR 留到 build，因为它要花钱，
    而花钱这件事不该由"拖了个文件进来"触发。
    """
    try:
        reg = default_registry()
        docs = await reg.aparse_all([f["path"] for f in s.files])
    except Exception as exc:  # noqa: BLE001 — 解析失败不该让上传失败
        s.emit("parse.failed", error=f"{type(exc).__name__}: {exc}")
        return
    index = build_index(docs)
    s.state["_docs"] = docs
    s.state["_index"] = index
    s.state["_profiles"] = collect_profiles(docs)
    s.state["_endpoints"] = collect_endpoints(docs)
    s.state["corpus"] = corpus_summary(docs)
    s.state["_chunks"] = {
        d.file_name: [{"cite": c.cite(), "text": c.render, "locator": c.locator}
                      for c in d.chunks] for d in docs}
    s.emit("corpus.ready", stats={"files": len(docs), "chunks": len(index)},
           findings=[{"kind": f.kind, "message": f.message,
                      "severity": f.severity, "locator": f.locator}
                     for d in docs for f in d.findings][:12])




async def _restore_dialogue(s: Session) -> None:
    """把库里的决定装回对话记忆。

    不装的话，"我记下了你的口径约定"在重启之后就成了空话 —— 库里明明有，
    但下一次 Run 的 ContextManager 读的是内存里的 DialogueMemory，那是空的。
    """
    rows = await get_repo().list_decisions(s.id)
    if not rows:
        return
    dm = _dialogue(s)
    for r in rows:
        d = Decision(kind=DecisionKind(r.kind), statement=r.statement,
                     scope_refs=list(r.scope_refs or []), turn_index=r.turn_index,
                     ts=r.ts)
        d.superseded_by = r.superseded_by
        dm._decisions.append(d)  # noqa: SLF001 — 恢复要保住 ordinal 与推翻链


async def _hydrate(sid: str) -> Session:
    """把库里/盘上的会话变回一个活的 Session。

    **重启后打开一个旧会话，必须真的能用** —— 只把标题和文件名读回来、
    而所有操作都 409，比列表里干脆不显示它更糟：用户看着一个"完成"的会话，
    点什么都没反应。

    重的东西（OIR、证据索引）按需重建：OIR 从 oir.json 反序列化，索引重新解析
    材料（xlsx 解析是零模型调用的）。扫描件例外 —— 它要过视觉模型，重建要花钱，
    所以留到用户真的点了「重新梳理」。
    """
    if sid in SESSIONS:
        return SESSIONS[sid]
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
                        ("done" if (d / "oir.json").exists() else "idle")))
    SESSIONS[sid] = s

    mats = d / "materials"
    if mats.exists():
        s.files = [{"name": f.name, "size": f.stat().st_size, "path": str(f)}
                   for f in sorted(mats.iterdir()) if f.is_file()]
    if row is not None:
        s.state.update(await get_repo().load_state(sid))
        await _restore_dialogue(s)
        # 进程死在半路时状态停在 parsing/extracting，永远不会自己变。
        # 挂着一个"进行中"的会话比说清"上次没跑完"更糟 —— 用户会一直等。
        if s.status in ("parsing", "extracting"):
            s.status = "failed"
            s.error = "上次运行被中断（进程退出）。材料和已拍板的决定都在，可以重新开始。"
            await get_repo().set_status(sid, s.status, error=s.error)

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
    s.state["artifacts"] = [x.name for x in d.iterdir() if x.is_file()]
    s.emit("session.restored", files=len(s.files),
           stats=(s.state.get("oir") or {}).get("stats"))
    return s


@app.get("/api/sessions/{sid}/state")
async def state(sid: str) -> dict[str, Any]:
    """会话全量状态。

    ``filelist`` 必须一并返回 —— 只给数量的话，重新打开一个会话时前端就没法
    渲染材料列表，"点回原文"这条路直接断掉。
    """
    s = await _sess_async(sid)
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    dm = s.state.get("_dialogue")
    if dm is not None:
        public["dialogue"] = dm.to_dict()
        public["decisions"] = [d.to_dict() for d in dm.active_decisions()]
    names = [f["name"] for f in s.files]
    return {**s.brief(),
            "filelist": [{"name": f["name"], "size": f["size"]} for f in s.files],
            "state": public, "events": len(s.events),
            # 一个空白输入框对新用户是最不友好的界面 —— 他知道这工具能分析
            # 业务文档，但不知道该说什么才有用。
            "prompts": opening_prompts(state=public, files=names, status=s.status)}



def s_state_dialogue(s: Session) -> Any:
    """取会话已有的对话记忆，没有就返回 None（不新建 —— 这里只读）。"""
    return s.state.get("_dialogue")


# ══════════════════════════════════════════════════════════════════
#  事件流
# ══════════════════════════════════════════════════════════════════
@app.get("/api/sessions/{sid}/stream")
async def stream(sid: str, since: int = 0) -> StreamingResponse:
    """SSE。``since`` 用于断线重连补发 —— SSE 本身没有重放，不补就会丢事件。"""
    s = await _sess_async(sid)
    q: asyncio.Queue = asyncio.Queue()
    s.subscribers.append(q)

    async def gen():
        try:
            for ev in s.events[since:]:  # 先补历史，再接实时
                yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"  # 防中间代理掐断长连接
        finally:
            if q in s.subscribers:
                s.subscribers.remove(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ══════════════════════════════════════════════════════════════════
#  流水线
# ══════════════════════════════════════════════════════════════════
@app.post("/api/sessions/{sid}/build")
async def build(sid: str, tier: str = "full") -> dict[str, Any]:
    s = _sess(sid)
    if not s.files:
        raise HTTPException(400, "还没有上传材料")
    if s.status in ("parsing", "extracting"):
        raise HTTPException(409, "已经在跑了")
    # tier=flow_preview：只解析 + 出流程图，跳过付费抽取。默认 full 走完整管线。
    tier = tier if tier in ("full", "flow_preview") else "full"
    asyncio.create_task(_run_pipeline(s, tier=tier))
    return {"started": True, "session": s.id, "tier": tier}


async def _run_pipeline(s: Session, *, tier: str = "full") -> None:
    """跑真正的 Harness：解析 → 切段 → DAG 调度抽取 → 合并 → 下游确定性环节。

    抽取**不是一次大调用**。语料按 sheet/章节切段后 fan-out 成多个 DAG 节点，
    每个节点内部是带工具的 agent loop、出来还要过 critic。这是唯一能处理真实
    材料的形态 —— 一次性把几百个切片丢给模型，八成内容会被截掉，而流水线
    还会一路绿灯跑完。
    """
    backend = None
    try:
        s.status = "parsing"
        s.emit("node.entered", node="PARSE", title="解析材料")
        await _ensure_catalog()          # 按网关可用模型过滤目录（视觉网关/OCR 靠它）
        backend, gw, smart, budget = _gateways(s.dir, f"run_{s.id}")

        paths = [Path(f["path"]) for f in s.files]
        docs = await default_registry(vision_gateway=smart).aparse_all(paths)
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
        s.state["_chunks"] = {
            d.file_name: [{"cite": c.cite(), "text": c.render[:1500], "tags": c.tags,
                          "locator": c.locator}
                          for c in d.chunks]
            for d in docs
        }
        await _build_flow_diagram(s, docs)
        await _persist(s)
        s.emit("node.completed", node="PARSE",
               stats={"files": len(paths), "chunks": len(index),
                      "endpoints": len(endpoints), "profiles": len(profiles)},
               findings=summary["findings"])

        # 免费流程预览：流程图已出，到此为止 —— 不进 EXTRACT 那条付费 DAG。
        # 文本/表格/SQL 语料到这里零模型成本；扫描件/PDF 因视觉解析会有少量费用。
        if tier == "flow_preview":
            s.status = "done"
            await _persist(s)
            fstats = (s.state.get("flow") or {}).get("stats") or {}
            s.emit("run.completed", stats={"tier": "flow_preview", **fstats})
            return

        # ── 切段并冻结计划 ─────────────────────────────────────
        segments = segment_corpus(index, docs)
        s.emit("plan.frozen", segments=[{"key": g.key, "label": g.label,
                                         "file": g.file_name, "chunks": len(g.chunk_ids)}
                                        for g in segments],
               note="段数来自材料结构（有几个 sheet/章节），不来自内容 —— 计划冻结成立")
        if not segments:
            raise RuntimeError("材料里没有可抽取的内容")

        # ── 装配 Harness ───────────────────────────────────────
        s.status = "extracting"
        agent = default_agents().get("extractor")
        skills = default_library()
        system = agent.render_system(skills) + "\n\n" + skills.load(list(agent.skills))

        bus = AgentBus(gw.rec)
        sandbox = default_sandbox()
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
        outcome = await sched.run(f"run_{s.id}")
        _pump_kernel_events(s, gw.rec, bus)

        if not outcome.ok:
            raise RuntimeError(f"抽取失败：{outcome.error}")

        merged = outcome.outputs.get("MERGE") or {}
        oir = build_oir(merged, index)
        # 流程图缺口生成的问题合流进来。图上标黄的地方 = 客户要回答的问题，
        # 这是这个工具的价值落点：不只画图，还指出图里哪儿是空的。
        for q in s.state.get("_flow_gaps") or ():
            if q.rid not in oir.questions:
                oir.add_question(q)
        s.emit("node.completed", node="EXTRACT",
               stats=oir.stats(), segments=len(segments),
               usd=round(budget.snapshot()["spent"]["usd"], 4))

        # ── 下游：全部确定性 ───────────────────────────────────
        s.emit("node.entered", node="FINISH", title="对齐 → 冲突 → 澄清 → 模板")
        res = finish(oir, endpoints=endpoints, profiles=profiles,
                     project=s.project or s.title)
        conflicts = res["conflicts"]
        kinds: dict[str, int] = {}
        for c in conflicts:
            kinds[str(c.kind)] = kinds.get(str(c.kind), 0) + 1
        s.emit("node.completed", node="ALIGN", stats=res["align"],
               merged=res["merged"], uncertain=res["uncertain"])
        await _persist(s)
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
        s.emit("clarify.request", questions=s.state["questions"], routing=cs.summary())
        if s.state["suggestions"]:
            # 建议不阻塞 —— 单独发一条事件，前端另起一栏，不要塞进问题流里让人
            # 误以为必须先答完才能继续。
            s.emit("suggest.ready", suggestions=s.state["suggestions"])

        if cs.questions:
            s.status = "awaiting_answer"
            s.emit("run.suspended", reason="等待 FDE 拍板")
            return
        await _compile(s)
    except Exception as exc:  # noqa: BLE001 — 服务边界，错误要送到前端而不是吞掉
        s.status = "failed"
        s.error = f"{type(exc).__name__}: {exc}"
        s.emit("run.failed", error=s.error)
    finally:
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
_PERSISTED = ("oir", "template", "artifacts", "questions", "suggestions",
              "corpus", "budget", "routing", "answered", "audit", "mode", "model")

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


def _push_version(s: Session, key: str, snap: dict[str, Any]) -> list[Any]:
    """把一个「编辑前」快照压进版本栈并就地封顶，返回该栈（活列表）。

    调用方在编辑失败时还要 ``pop()`` 掉刚压的这个，所以返回的必须是同一个列表。
    """
    v = s.state.setdefault(key, [])
    v.append(snap)
    if len(v) > _VERSION_STACK_CAP:
        del v[: len(v) - _VERSION_STACK_CAP]
    return v


async def _persist(s: Session, *, status: bool = True) -> None:
    """把会话当前状态写进库。**在每个节点边界调用。**

    只在最后写一次的后果是：跑到一半崩了，前面几分钟和几美元全白花，
    而磁盘上什么都没有。节点边界是天然的检查点 —— 那正是 Recorder 记
    ``NODE_COMPLETED`` 的地方。

    失败不抛：数据库出问题不该把一次正在跑的梳理带下去。**但要报出来** ——
    静默降级成内存模式，用户会以为存下来了。
    """
    repo = get_repo()
    try:
        if status:
            await repo.set_status(s.id, s.status, error=s.error)
        docs = {k: s.state[k] for k in _PERSISTED if k in s.state}
        # 私有的版本/补丁栈也落，顺手把内存态也封顶
        for k in _PERSISTED_PRIVATE:
            stack = s.state.get(k)
            if stack:
                s.state[k] = stack[-_VERSION_STACK_CAP:]
                docs[k] = s.state[k]
        conflicts = [c.to_dict() for c in (s.state.get("_conflicts") or [])]
        await repo.save_state(s.id, docs, conflicts=conflicts or None,
                              asked_rids=[q["conflict_rid"]
                                          for q in (s.state.get("questions") or [])])
        dm = s.state.get("_dialogue")
        if dm is not None:
            await _persist_decisions(s, dm)
    except Exception as exc:  # noqa: BLE001
        s.emit("persist.failed", error=f"{type(exc).__name__}: {exc}")


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


async def _recompile(s: Session) -> None:
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
    await _compile(s)
    s.emit("suggest.ready", suggestions=s.state["suggestions"])



#: 材料里的流程说明常常没有阶段划分 —— 它只给一串编号节点。阶段是**人划的**，
#: 不是猜的：猜阶段会让整张图的骨架建立在没人确认过的判断上。
#: 这里给一个按节点号均分的兜底，并在图上注明"阶段划分待确认"。
_STAGE_CHUNK = 4


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
    from .onto.flow import FlowGraph, Stage
    from .onto.flow_extract import (
        attach_gateways,
        build_flow,
        looks_like_process,
        parse_gateways,
        parse_steps,
        stages_from_survey,
        survey_stage_groups,
    )

    steps: list[Any] = []
    rule_texts: list[tuple[str, str]] = []   # (原文, cite) 供网关抽取
    survey_cols: dict[str, list[str]] = {}   # 供阶段划分
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
                    got = parse_steps(text, cite=c.cite())
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
    if not steps:
        s.emit("flow.skipped", reason="材料里没有找到「触发条件/输入/输出」这种"
                                      "结构化的流程说明")
        return

    steps.sort(key=lambda x: x.no)

    # ── 阶段：优先用问卷的节点分组，退回按编号切 ──────────────────
    groups = survey_stage_groups(survey_cols) if survey_cols else []
    if groups:
        g, mapping = stages_from_survey(groups)
    else:
        g = FlowGraph()
        mapping = {}
        for i in range(0, len(steps), _STAGE_CHUNK):
            grp = steps[i:i + _STAGE_CHUNK]
            key = f"s{i // _STAGE_CHUNK + 1}"
            g.stages[key] = Stage(
                key=key, order=i // _STAGE_CHUNK + 1,
                title=f"阶段{i // _STAGE_CHUNK + 1}｜{grp[0].name}…{grp[-1].name}",
                subtitle="阶段划分由系统按节点顺序切分，待人工确认")
            for st in grp:
                mapping[st.no] = key

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


async def _compile(s: Session) -> None:
    oir = s.state["_oir"]
    conflicts = s.state.get("_conflicts") or []
    s.emit("node.entered", node="COMPILE", title="编译模板")
    spec = compile_template(oir, conflicts)
    xlsx = write_xlsx(spec, s.dir / "模板_v1.xlsx", project=s.project or s.title)
    spec.save(s.dir / "template.spec.json")
    (s.dir / "oir.json").write_text(
        json.dumps(oir.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
    # oir.json 写了、state 里的快照没刷 —— 前端读的是快照，于是磁盘上是新的、
    # 界面上是旧的。这种不一致只有对着文件核对才会发现。
    s.state["oir"] = oir.to_dict()
    s.state["template"] = spec.stats()
    s.state["artifacts"] = [p.name for p in s.dir.iterdir() if p.is_file()]
    s.status = "done"
    await _persist(s)
    s.emit("artifact.ready", artifact="template", name=xlsx.name, stats=spec.stats())
    # 排队的动作要在"完成"**之前**执行完。放在之后的话，用户先看到「已完成」、
    # 界面停止刷新，然后产物才悄悄变了 —— 他不会知道。
    await _drain_queue(s)
    s.emit("run.completed", stats=oir.stats())


@app.post("/api/sessions/{sid}/answer")
async def answer(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """回答一个澄清问题。人的决策标 ``Origin.USER``，后续自动逻辑不得覆盖。"""
    s = _sess(sid)
    oir, conflicts = s.state.get("_oir"), s.state.get("_conflicts")
    if oir is None:
        raise HTTPException(409, "这个会话还没有待答问题")

    target = next((c for c in conflicts if c.rid == body.get("conflict_rid")), None)
    if target is None:
        raise HTTPException(404, f"没有冲突 {body.get('conflict_rid')}")
    applied = apply_decision(oir, target, body["option_id"], note=body.get("note", ""))
    s.emit("human.recorded", conflict=target.rid, option=body["option_id"],
           label=applied["label"], changed=applied["changed"])

    answered = set(s.state.setdefault("answered", []))
    answered.add(target.rid)
    s.state["answered"] = sorted(answered)
    pending = [q for q in s.state.get("questions", ())
               if q["conflict_rid"] not in answered]
    if not pending:
        await _compile(s)
    return {"applied": applied, "pending": len(pending), "status": s.status}



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
                  confidence: float = 1.0, refs: list[str] | None = None) -> None:
    """写进对话记忆并投影成 SSE 事件。

    两件事必须一起做：只写记忆前端看不见，只发事件刷新页面就没了。
    """
    dm = _dialogue(s)
    u = dm.say(speaker, text, intent=intent, refs=refs or [])
    dm.compact_to_fit()
    s.emit("chat.turn", turn={**u.to_dict(), "confidence": round(confidence, 2)})



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
    """启动时对账：把状态卡在「进行中」的会话标成中断。

    **没有任何 Run 能活过进程重启** —— 调度器、DAG、事件队列全在内存里。
    所以启动那一刻，库里所有 parsing/extracting 都是谎话。

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
        if r.status in ("parsing", "extracting"):
            await repo.set_status(
                r.id, "failed",
                error="上次运行被中断（进程退出）。材料和已拍板的决定都在，可以重新开始。")
            n += 1
    if n:
        print(f"[store] 启动对账：{n} 个会话上次没跑完，已标记为中断")


def _busy(s: Session) -> bool:
    """这个会话正在跑 DAG 吗。

    改产物的动作必须看这个。旧的 chat 路由有「跑着时排队」，我在改成
    agent-first 的时候把它删了 —— 审查当场指出来：跑着的时候调重编译，
    界面会显示「已完成」而抽取还在继续。
    """
    return s.status in ("parsing", "extracting")


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
    reg = builtin_registry(evidence=s.state.get("_index"), oir=s.state.get("_oir"),
                           profiles=s.state.get("_profiles"))
    # 工作模式的工具都挂在 converse 作用域。聊天模式不走这套 —— 它用一份空注册表，
    # 保证零工具（见 _reason），所以这里不再需要单独的 chat 作用域。
    RO, RW = ("converse",), ("converse",)

    @reg.fn("session.status", "查当前会话的状态：材料、产物统计、待拍板的问题、建议、花费。"
            "回答『进度』『现在什么情况』这类问题前先调它。",
            {"type": "object", "properties": {}}, danger=Danger.READ, scopes=RO)
    def _status(ctx: Any) -> dict[str, Any]:
        st = (s.state.get("oir") or {}).get("stats") or {}
        spent = (s.state.get("budget") or {}).get("spent") or {}
        return {"材料": [f["name"] for f in s.files], "状态": s.status,
                "产物": st or "还没跑过梳理",
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

    @reg.fn("oir.add",
            "口述新增本体事实：加对象/属性/关系/业务规则/枚举状态值。FDE 说出材料没写"
            "但他知道的事实（如「采购包创建后状态变成已发布」= 给采购包.状态加取值"
            "「已发布」，且/或加一条 PROCESS 规则）。**你只选 op 和参数，绝不重写整份 OIR** —— "
            "重写会抹掉其它断言的溯源。新增内容一律标「人工口述」(Origin=USER)，在 OIR 里"
            "可见、可信度高，但绝不冒充材料抽取。改完让用户「重出模板」。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["add_object_type", "add_property", "add_link",
                                 "add_rule", "add_enum_value"]},
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
                                "description": "add_rule 约束哪些对象"},
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
            "把规则挂到对象、删除人工误加的元素。**只选 op 和参数**。改动标「人工口述」，"
            "保留未触碰部分的溯源。材料抽出来的元素不能硬删（会丢证据），要排除用 "
            "set_status(status=rejected)。",
            {"type": "object", "required": ["op"],
             "properties": {
                 "op": {"type": "string",
                        "enum": ["edit_assertion", "set_status", "bind_rule",
                                 "remove_object_type", "remove_property",
                                 "remove_link", "remove_rule"]},
                 "target": {"type": "string",
                            "description": "要改的对象/属性/关系/规则（名字或 rid）"},
                 "field": {"type": "string",
                           "description": "edit_assertion 改哪个字段（displayName/"
                                          "definition/base_type/required/actor…）"},
                 "value": {"type": "string"},
                 "status": {"type": "string",
                            "enum": ["candidate", "proposed", "confirmed", "rejected"]},
                 "rule": {"type": "string", "description": "bind_rule 的规则"},
                 "object": {"type": "string", "description": "bind_rule 的对象"},
                 "note": {"type": "string"}}},
            danger=Danger.EXTERNAL, scopes=RW)
    def _oir_edit_tool(ctx: Any, op: str, **args: Any) -> dict[str, Any]:
        return _do_oir_edit(op, **args)

    @reg.fn("build.start", "开始梳理已上传的材料。**要花钱**（上一轮的花费见 session.status），"
            "只在用户明确要求开始时调。",
            {"type": "object", "properties": {}}, danger=Danger.EXTERNAL, scopes=RW)
    def _build(ctx: Any) -> dict[str, Any]:
        if not s.files:
            return {"error": "还没有材料"}
        if _busy(s):
            return {"error": "已经在跑了"}
        asyncio.create_task(_run_pipeline(s))
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

        versions = s.state.get("_flow_versions") or []
        if not versions:
            return {"error": "没有可撤销的流程图编辑。"}
        prev = versions.pop()
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
    def _flow_preview(ctx: Any) -> dict[str, Any]:
        if not s.files:
            return {"error": "还没有材料，先上传。"}
        if _busy(s):
            return {"error": "已经在跑了。"}
        asyncio.create_task(_run_pipeline(s, tier="flow_preview"))
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


async def _replay_pending(s: Session, action: dict[str, Any]) -> str:
    """用户确认后，直接重放上一轮被拦的那个高危动作。

    不重新推理 —— 动作和参数已经定了，重新推理只会引入不确定性（模型可能这次
    理解成别的意思）。用同一套工具、approved=True 执行，全程照样进 tool.call
    记账，可审计不变。
    """
    tool_name = str(action.get("tool") or "")
    args = action.get("args") or {}
    run_id = f"confirm_{uuid.uuid4().hex[:10]}"
    _, gw, _, _ = _gateways(s.dir, run_id)
    tools = _converse_tools(s)
    ctx = _ChatCtx(turn_id=run_id, rec=gw.rec, approved=True)
    try:
        result = await tools.call(tool_name, args, ctx, scope="converse")
    except Exception as exc:  # noqa: BLE001 — 重放失败要如实说
        return f"执行「{tool_name}」时出错了：{type(exc).__name__}: {exc}"
    if isinstance(result, dict) and result.get("error"):
        return f"没执行成功：{result['error']}"
    # 措辞成人话：用同一个 _say，把结果当事实交给它
    return await _say(s, _outcome("confirmed", json.dumps(result, ensure_ascii=False,
                                                          default=str)[:400],
                                  动作=tool_name, 结果=result), "确认执行")


async def _reason(s: Session, text: str, *, hint: str = "",
                  approved: bool = False) -> Any:
    """跑一轮对话推理，并把每一步投影成事件。

    工具只给 ``readonly`` 作用域：对话能查任何东西，但**不能静默改产物**。
    要改必须走显式执行器并回显改了什么 —— 一个能在闲聊里悄悄删掉 17 个对象的
    副驾是不能用的。
    """
    out = s.dir
    out.mkdir(parents=True, exist_ok=True)
    run_id = f"chat_{uuid.uuid4().hex[:10]}"
    _, gw, _, budget = _gateways(out, run_id)
    # 对话花的钱要**跨轮累计**。Budget 是每轮新建的，$15 那个上限是"每一轮"的
    # 上限 —— 也就是说对话侧根本没有封顶。一轮真问题跑满 5 步实测约 $0.08，
    # 一天两百轮就是十几美元，而它们大多是本可以不花的。
    spent = float(s.state.get("_chat_usd") or 0.0)
    cap = appconfig.chat_usd_cap()
    if spent >= cap:
        raise HTTPException(429, f"这个会话的对话花费已达上限 ${cap}（已花 ${spent:.2f}）。"
                                 f"调 ONTOCOPILOT_CHAT_USD_CAP 或新建会话。")
    tools = _converse_tools(s)
    # 聊天模式：通用助手 + **完全无工具**（空注册表，连 * 作用域的内建检索都拿不到），
    # 纯对话不该能触发梳理/改产物/花钱。工作模式才装全套工具、用 FDE 系统提示。
    if s.state.get("mode") == "chat":
        from .kernel.tools import ToolRegistry
        from .onto.converse import _CHAT_SYSTEM
        agent = ConversationAgent(gateway=gw, tools=ToolRegistry(), scope="chat",
                                  max_steps=3, system=_CHAT_SYSTEM)
    else:
        # 工作模式的模型选择器：选了具体模型就让对话直接用它（梳理管线仍按能力路由）
        model_spec = None
        chosen = s.state.get("model")
        if chosen:
            card = (_CATALOG or ModelCatalog()).get(chosen)
            model_spec = card.spec if card else None
        agent = ConversationAgent(gateway=gw, tools=tools, scope="converse",
                                  max_steps=5, model=model_spec)

    def on_step(rec: dict[str, Any]) -> None:
        # 推理过程必须可见 —— 看不见的推理和编造的区别，用户分辨不出来。
        # 带上轮次 id：同一步会回调两次（发起时、拿到观察后），而不同轮次的
        # 步号会重复，只按步号去重会把上一轮的步骤覆盖掉。
        s.emit("chat.step", step={**rec, "turn": run_id, "q": text[:40]})

    ctx_text = _context_brief(s)
    if hint:
        # 规则层的判定作为**提示**给出，不是命令 —— 措辞上要让模型知道它可以不采纳。
        ctx_text += f"\n\n规则层对这句话的初步判断（仅供参考，你可以不同意）：{hint}"
    ctx = _ChatCtx(turn_id=run_id, rec=gw.rec, approved=approved)
    turn = await agent.run(text, ctx=ctx, context=ctx_text, on_step=on_step)
    s.state["_last_reason"] = turn.to_dict()
    s.state["_chat_usd"] = spent + float(turn.usd or 0.0)
    # 记下这一轮被闸门拦下的高危动作，供下一轮确认时直接重放。
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
    parts.append(f"材料：{'、'.join(f['name'] for f in s.files) or '（还没上传）'}")
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


@app.post("/api/sessions/{sid}/chat")
async def chat(sid: str, body: dict[str, Any]) -> dict[str, Any]:
    """对话入口。

    **不阻塞流水线**：梳理跑着的时候照样能说话。跑着的时候恰恰是用户最想插话的
    时候（"这批临时表别要了"），这时候禁用输入是最糟的手感。会改产物的意图在
    Run 进行中会排队到本轮结束再执行 —— 否则就是在动一份正在被读写的 OIR。
    """
    s = await _sess_async(sid)
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "说点什么")
    # 用户对上一轮那个被挡住的动作说「确认」。**这一轮限定放行** ——
    # 不是给会话开一个长期后门。
    approved = bool(body.get("confirm"))

    # 确认时**直接重放**上一轮被拦的动作，不重新推理。全局 approved bool 不记得
    # 在确认什么，模型重新推理时会把「确认」理解成别的意思（采纳哪条建议）——
    # 用户明明在确认一个模板编辑，却被问"要采纳第几条建议"。重放才是确定的。
    pending = s.state.get("_pending_action")
    if approved and pending:
        _publish_turn(s, Speaker.USER, text, intent="confirm", confidence=1.0)
        reply = await _replay_pending(s, pending)
        _publish_turn(s, Speaker.ASSISTANT, reply)
        s.state["_pending_action"] = None
        await _persist(s, status=False)
        public = {k: v for k, v in s.state.items() if not k.startswith("_")}
        return {"reply": reply, "needs_confirm": False, "replayed": True,
                "followups": followup_prompts(answer=reply, state=public,
                    files=[f["name"] for f in s.files], status=s.status)}

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
    turn = await _reason(s, text, hint=hint, approved=approved)
    replies = [turn.answer] if turn.answer else []
    if turn.citations:
        replies.append("依据：" + "　".join(f"◧ {c}" for c in turn.citations[:4]))
    if turn.followup:
        replies.append(f"（我不确定的一点：{turn.followup}）")

    reply = "\n\n".join(r for r in replies if r) or "收到。"
    _publish_turn(s, Speaker.ASSISTANT, reply)
    # 人拍的板是最不该丢的一份状态，每轮都落。
    await _persist(s, status=False)
    # 这一轮有没有动作被确认门挡住 —— 前端据此显示确认按钮。靠子串匹配确认门的
    # 拒绝语（tools.py 里 requires_approval 挡下时的固定措辞）：确认门是唯一产出
    # 这些字样的地方，约定稳定，比另开一条并行布尔信号更不容易走岔。
    pending = [x for x in turn.steps
               if "需要人工确认" in str(x.get("observation") or "")
               or "要用户确认" in str(x.get("observation") or "")]
    public = {k: v for k, v in s.state.items() if not k.startswith("_")}
    return {"intents": parse.to_dict(),
            "reply": reply, "needs_confirm": bool(pending),
            "usd": round(float(s.state.get("_chat_usd") or 0), 4),
            # 系统刚说完"有 3 个死路"，用户得自己想出"哪三个"这个问题 ——
            # 这个断层没理由留给他。
            "followups": followup_prompts(
                answer=reply, state=public,
                files=[f["name"] for f in s.files], status=s.status)}


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
    try:
        _, gw, _, _ = _gateways(s.dir, f"say_{uuid.uuid4().hex[:8]}")
        comp = await gw.call(
            "CHAT.say",
            f"## 他说的\n{user_text}\n\n"
            f"## 系统做了什么（事实，照它说）\n"
            f"{json.dumps(outcome.get('facts') or {}, ensure_ascii=False, indent=1)}\n\n"
            f"## 备用措辞（可参考，但你可以说得更好）\n{fallback}",
            system=_SAY_SYSTEM, difficulty=Difficulty.LOW, schema=_SAY_SCHEMA,
            max_tokens=600)
        said = str((comp.data or {}).get("reply") or "").strip()
        return said or fallback
    except Exception:  # noqa: BLE001 — 措辞失败不该让整轮对话失败
        return fallback


def _outcome(kind: str, fallback: str, **facts: Any) -> dict[str, Any]:
    """执行器的返回形态：**事实 + 备用措辞**，不是一句成品。"""
    return {"kind": kind, "facts": facts, "fallback": fallback}


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
        if not s.files:
            return "还没有材料。把文件拖进来，或者点 + 添加。"
        if s.status in ("parsing", "extracting"):
            return "已经在跑了。"
        asyncio.create_task(_run_pipeline(s))
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
    s = _sess(sid)
    p = s.dir / Path(name).name  # basename：防路径穿越
    if not p.exists():
        raise HTTPException(404, name)
    return FileResponse(p, filename=p.name)


def _content_disposition(name: str) -> str:
    """带中文文件名的 Content-Disposition：ASCII 兜底 + RFC 5987 filename*，
    让中文包名在各浏览器都能正确落地。"""
    from urllib.parse import quote

    return f"attachment; filename=\"bundle.zip\"; filename*=UTF-8''{quote(name)}"


@app.get("/api/sessions/{sid}/bundle")
async def bundle(sid: str, materials: bool = True) -> Response:
    """把会话的全部产物打成一个交付 zip（产物 + manifest.json + 交付说明.md）。

    **收集而非重算** —— 产物在节点边界和每次 edit 都已落盘、与内存态一致；重算只会
    引入字节漂移、破坏可复现。用会 hydrate 的 ``_sess_async``：FDE 常在重启后打开
    旧会话来导出，这时 `_flow`/oir/flow/artifacts 都靠 hydrate 载回。
    """
    import time
    from datetime import datetime, timezone

    from .kernel.ids import sha256_hex
    from .onto import bundle as B

    def _aval(x: Any) -> str:
        v = x.get("value") if isinstance(x, dict) else x
        return str(v or "").strip()

    s = await _sess_async(sid)
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
                 "status": s.status, "created": s.created,
                 "state_version": state_version},
        product_version=__version__, files=files_meta, materials=mats_meta,
        flow=s.state.get("flow"), oir=oir or None, open_questions=open_qs,
        generated_at=now,
        generated_at_iso=datetime.fromtimestamp(now, timezone.utc).isoformat())
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
    s = _sess(sid)
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
async def audit(sid: str, files: list[UploadFile]) -> dict[str, Any]:
    """审业务方回传的模板。"""
    s = _sess(sid)
    spec_path = s.dir / "template.spec.json"
    if not spec_path.exists():
        raise HTTPException(409, "这个会话还没有编译出模板")
    up = files[0]
    dest = s.dir / f"回传_{Path(up.filename or 'x').name}"
    dest.write_bytes(await up.read())

    spec = TemplateSpec.load(spec_path)
    result = ReturnAuditor().audit(spec, read_returned(dest), oir=s.state.get("_oir"))
    s.state["audit"] = result.summary()
    s.emit("audit.completed", **result.summary())
    return result.summary()


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



