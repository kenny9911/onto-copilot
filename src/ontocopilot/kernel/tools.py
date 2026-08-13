"""工具注册表与 MCP 安全闸。

动作空间二分（架构文档 ADR-2）：

* **数据变换 → CodeAct**。清洗、透视、连接、profiling 的逻辑每个项目都不一样，
  预定义一百个工具也覆盖不全，"写一段 pandas"能覆盖全部。
* **外部交互 → 工具调用**。需要严格的权限边界和审计，代码空间太自由。

MCP 侧的威胁是真实的：1899 个开源 server 里 7.2% 含通用漏洞、5.5% 存在**工具
投毒** —— 恶意指令藏在 tool description 里（arXiv:2509.06572）。所以这里的闸门
不是形式主义：描述指纹锁定防 rug pull，静态扫描拦投毒特征，描述以**数据块**而非
指令块注入上下文。
"""

from __future__ import annotations

import re
import unicodedata
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

from .errors import ToolDenied
from .events import EventKind
from .ids import sha256_hex


class Danger(IntEnum):
    """工具的危险等级 —— 决定要不要人工确认、要不要进沙箱。"""

    READ = 0  # 只读，无副作用
    COMPUTE = 1  # 有计算但不改外部状态（沙箱内）
    WRITE_LOCAL = 2  # 改本系统状态（写 OIR、产物）
    EXTERNAL = 3  # 改外部世界（发邮件、建 issue）—— 一律需人工确认


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    danger: Danger = Danger.READ
    #: 供应方。``builtin`` 可信；``mcp:<server>`` 要过安全闸。
    origin: str = "builtin"
    #: 工具返回值契约。MCP 工具不能只校验入参：被攻陷的 server
    #: 可以在返回值中偷塞指令、凭证或超大 payload。
    output_schema: dict[str, Any] | None = None

    @property
    def requires_approval(self) -> bool:
        return self.danger >= Danger.EXTERNAL

    def fingerprint(self) -> str:
        """描述 + schema 的指纹。变了就说明工具被换过，必须重新审批。"""
        import json

        return sha256_hex(
            self.description
            + json.dumps(self.input_schema, sort_keys=True)
            + json.dumps(self.output_schema, sort_keys=True))[:16]

    def render(self) -> str:
        """进 prompt 的形态。

        描述包在显式边界里 —— 它是**外部数据**，不是我们的指令。缺了边界，
        投毒的描述就和系统提示词混在一起了。
        """
        import json

        body = self.description.strip()
        return (
            f"### {self.name}　[{self.danger.name}]\n"
            f"<tool_description source=\"{self.origin}\">\n{body}\n</tool_description>\n"
            f"参数：{json.dumps(self.input_schema, ensure_ascii=False)}"
        )


class Tool(ABC):
    spec: ToolSpec

    @abstractmethod
    async def run(self, args: dict[str, Any], ctx: Any) -> Any: ...


class FnTool(Tool):
    """把一个普通函数包成工具。"""

    def __init__(self, spec: ToolSpec, fn: Callable[..., Any | Awaitable[Any]]) -> None:
        self.spec = spec
        self._fn = fn

    async def run(self, args: dict[str, Any], ctx: Any) -> Any:
        out = self._fn(ctx=ctx, **args)
        if hasattr(out, "__await__"):
            out = await out
        return out


# ══════════════════════════════════════════════════════════════════
#  MCP 安全闸
# ══════════════════════════════════════════════════════════════════
#: 工具投毒的典型特征。描述本该只讲这个工具做什么，出现祈使句和越权措辞
#: 就说明有人想借描述给模型下指令。
POISON_PATTERNS = (
    (r"ignore\s+(?:all\s+)?(?:previous|prior|above)", "试图覆盖既有指令"),
    (r"忽略(?:之前|上面|以上|全部)", "试图覆盖既有指令"),
    (r"do\s+not\s+(?:tell|mention|inform|reveal)", "要求对用户隐瞒"),
    (r"不要(?:告诉|提及|告知|透露)", "要求对用户隐瞒"),
    (r"(?:you\s+must|always)\s+(?:first\s+)?call", "试图劫持调用顺序"),
    (r"<\s*(?:system|instructions?)\s*>", "伪装成系统指令"),
    (r"(?:api[_\s-]?key|password|token|secret)\s*[:=]", "索取凭证"),
    (r"\.ssh|id_rsa|\.env\b|credentials", "指向凭证文件"),
)

#: 不可见字符 —— 藏在描述里的指令用它们躲过肉眼审查。必须写成 escape，
#: 源码本身不能真的含这些双向/零宽控制字符。
_INVISIBLE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]")


def scan_description(text: str) -> list[str]:
    """扫描工具描述里的投毒特征。返回命中的原因。"""
    hits: list[str] = []
    if _INVISIBLE.search(text):
        hits.append("含不可见控制字符（可能藏有隐藏指令）")
    normalized = unicodedata.normalize("NFKC", text)
    for pattern, reason in POISON_PATTERNS:
        if re.search(pattern, normalized, re.IGNORECASE):
            hits.append(reason)
    if len(text) > 4000:
        hits.append("描述异常长（正常工具描述不需要几千字）")
    return list(dict.fromkeys(hits))


@dataclass(slots=True)
class MCPGateway:
    """MCP server 接入闸。

    三道防线，缺一不可：

    1. **静态扫描** —— 接入时扫描述里的投毒特征。
    2. **指纹锁定** —— 首次接入登记指纹；描述变了自动禁用，需人工复审
       （防 rug pull：先用良性描述通过审核，之后再改成恶意的）。
    3. **参数双向校验** —— 出入参按声明 schema 严校验，越权字段直接丢弃。
    """

    #: name → 已批准的指纹
    approved: dict[str, str] = field(default_factory=dict)
    quarantined: dict[str, list[str]] = field(default_factory=dict)
    #: 出网白名单。空 = 不允许任何出网。
    egress_allowlist: tuple[str, ...] = ()
    #: 安全默认：首次出现的 MCP 工具只进隔离区，不自动变成已批准。
    #: 开发环境若确实要保留旧行为，可显式设 ``auto_approve_first=True``。
    auto_approve_first: bool = False
    max_result_bytes: int = 1_048_576

    def admit(self, spec: ToolSpec, *, force: bool = False) -> tuple[bool, str]:
        """接入一个 MCP 工具。返回 ``(是否放行, 说明)``。"""
        if hits := scan_description(spec.description):
            self.quarantined[spec.name] = hits
            if not force:
                return False, f"描述命中投毒特征：{'；'.join(hits)}"

        fp = spec.fingerprint()
        known = self.approved.get(spec.name)
        if known is None:
            if not self.auto_approve_first:
                self.quarantined[spec.name] = ["首次接入，等待管理员审批指纹"]
                return False, f"首次接入，已隔离待审（指纹 {fp}）"
            self.approved[spec.name] = fp
            return True, "首次接入，开发模式已自动登记指纹"
        if known != fp:
            self.quarantined[spec.name] = ["描述或 schema 与已批准版本不一致"]
            return False, (
                f"{spec.name} 的描述已变更（{known} → {fp}）。这是 rug pull 的典型形态，"
                "工具已禁用，需人工复审后重新登记。")
        return True, "指纹匹配"

    def approve(self, spec: ToolSpec) -> str:
        """管理员显式批准当前版本，返回锁定的指纹。

        批准也不能跳过投毒扫描；描述/schema 任一变化后旧批准自动失效。
        """
        if hits := scan_description(spec.description):
            self.quarantined[spec.name] = hits
            raise ToolDenied(f"{spec.name} 描述命中投毒特征：{'；'.join(hits)}")
        fp = spec.fingerprint()
        self.approved[spec.name] = fp
        self.quarantined.pop(spec.name, None)
        return fp

    def validate_args(self, spec: ToolSpec, args: dict[str, Any]) -> dict[str, Any]:
        """按声明 schema 过滤入参。**未声明的字段直接丢弃**，不是报错。

        丢弃比报错好：报错会让调用方知道哪些字段被拒，反而给了试探边界的信号。
        """
        props = (spec.input_schema or {}).get("properties") or {}
        clean = {k: v for k, v in args.items() if k in props}
        _validate_schema(clean, spec.input_schema or {"type": "object"},
                         path=f"{spec.name}.args")
        return clean

    def validate_result(self, spec: ToolSpec, result: Any) -> Any:
        """校验工具返回值的形状与体积。

        只对声明了 ``output_schema`` 的工具做结构校验；体积上限对所有
        工具生效，防止工具结果把 Agent context 和日志撑爆。
        """
        import json

        try:
            size = len(json.dumps(result, ensure_ascii=False, default=str).encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise ToolDenied(f"{spec.name} 返回值无法序列化：{exc}") from exc
        if size > self.max_result_bytes:
            raise ToolDenied(
                f"{spec.name} 返回 {size} 字节，超过上限 {self.max_result_bytes}")
        if spec.output_schema:
            _validate_schema(result, spec.output_schema, path=f"{spec.name}.result")
        return result


# ══════════════════════════════════════════════════════════════════
#  注册表
# ══════════════════════════════════════════════════════════════════
class ToolRegistry:
    """节点可用工具的唯一来源。

    工具按**节点作用域**授予，不是全局可用 —— 抽取节点不该有发邮件的能力。
    这也是间接提示注入的主要防线：材料内容再怎么诱导，抽取节点的动作空间里
    根本没有出网工具。
    """

    def __init__(self, gateway: MCPGateway | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        self._scopes: dict[str, set[str]] = {}  # 作用域名 → 工具名
        self.gateway = gateway or MCPGateway()

    # ── 注册 ────────────────────────────────────────────────────
    def register(self, tool: Tool, *, scopes: tuple[str, ...] = ("*",)) -> ToolRegistry:
        name = tool.spec.name
        if name in self._tools:
            raise ValueError(f"工具 {name!r} 已注册，拒绝静默覆盖")
        if tool.spec.origin.startswith("mcp:"):
            ok, why = self.gateway.admit(tool.spec)
            if not ok:
                raise ToolDenied(f"{name} 未通过 MCP 安全闸：{why}")
        self._tools[name] = tool
        for s in scopes:
            self._scopes.setdefault(s, set()).add(name)
        return self

    def fn(
        self, name: str, description: str, schema: dict[str, Any], *,
        danger: Danger = Danger.READ, scopes: tuple[str, ...] = ("*",),
        output_schema: dict[str, Any] | None = None,
    ) -> Callable[[Callable], Callable]:
        """装饰器写法。"""

        def deco(f: Callable) -> Callable:
            self.register(FnTool(ToolSpec(name, description, schema, danger,
                                          output_schema=output_schema), f),
                          scopes=scopes)
            return f

        return deco

    # ── 查询 ────────────────────────────────────────────────────
    def for_scope(self, scope: str) -> list[Tool]:
        names = self._scopes.get("*", set()) | self._scopes.get(scope, set())
        return [self._tools[n] for n in sorted(names) if n in self._tools]

    def get(self, name: str, *, scope: str = "*") -> Tool:
        allowed = {t.spec.name for t in self.for_scope(scope)}
        if name not in allowed:
            raise ToolDenied(
                f"作用域 {scope!r} 里没有工具 {name!r}（可用：{sorted(allowed)}）")
        return self._tools[name]

    def catalog(self, scope: str = "*") -> str:
        """进 prompt 的工具目录。"""
        tools = self.for_scope(scope)
        if not tools:
            return "（本节点没有可用工具）"
        return "\n\n".join(t.spec.render() for t in tools)

    # ── 调用 ────────────────────────────────────────────────────
    async def call(
        self, name: str, args: dict[str, Any], ctx: Any, *, scope: str = "*",
    ) -> Any:
        """调一个工具。走这里而不是直接拿 tool 调，才能统一做校验和记账。"""
        tool = self.get(name, scope=scope)
        clean = self.gateway.validate_args(tool.spec, args or {})

        rec = getattr(ctx, "rec", None)
        node = getattr(ctx, "node_id", "")

        if tool.spec.requires_approval and not getattr(ctx, "approved", False):
            # **被拒也要记账。** 只记成功的调用，事后就看不到"模型曾经想改产物、
            # 被闸门挡住了"—— 而这恰恰是判断闸门有没有在起作用的唯一证据，
            # 也是发现提示注入的第一现场。
            if rec is not None:
                rec.emit(EventKind.EFFECT_REQUESTED, node_id=node,
                         payload={"kind": "tool.denied", "tool": name,
                                  "danger": tool.spec.danger.name,
                                  "args": _digest(clean)})
            # 把被拒的动作记在 ctx.pending 上，供上层在用户确认时**直接重放** ——
            # 而不是让模型重新推理一遍。全局的 approved bool 不记得在确认什么，
            # 于是"确认"会被理解成别的意思（采纳哪条建议）。重放才是确定的。
            pend = getattr(ctx, "pending", None)
            if pend is not None:
                pend.append({"tool": name, "args": dict(clean)})
            raise ToolDenied(
                f"{name} 会改变产物或花钱（{tool.spec.danger.name}），要用户确认后才能执行。"
                f"请把你打算做什么、影响多大告诉他，让他说一句确认。")
        budget = getattr(ctx, "budget", None)
        spend_node_call = getattr(ctx, "spend_tool_call", None)
        if callable(spend_node_call):
            spend_node_call()
        if budget is not None:
            budget.check("tool_calls")
            budget.spend(tool_calls=1)

        async def invoke() -> Any:
            result = await tool.run(clean, ctx)
            return self.gateway.validate_result(tool.spec, result)

        # 非确定性工具与 LLM 一样走 Recorder.effect：首次执行记完整
        # requested/completed/failed，恢复时直接读回结果，不重复修文档或付费。
        if rec is not None:
            effect_key = getattr(ctx, "tool_effect_key", None)
            if not effect_key and clean.get("idempotency_key"):
                effect_key = f"tool:{name}:{clean['idempotency_key']}"
            return await rec.effect(
                node or "TOOL", "tool.call",
                {"tool": name, "scope": scope, "danger": tool.spec.danger.name,
                 "fingerprint": tool.spec.fingerprint(), "args": clean},
                invoke, key=effect_key)
        return await invoke()


def _validate_schema(value: Any, schema: dict[str, Any], *, path: str) -> None:
    """严格校验工具契约需要的 JSON Schema 子集。

    支持 type/enum/const/required/properties/items/长度/数值范围；未识别的
    keyword 留给上层完整 validator，但已声明的约束绝不 fail-open。
    """
    if not schema:
        return
    if "const" in schema and value != schema["const"]:
        raise ToolDenied(f"{path} 必须等于 {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        raise ToolDenied(f"{path} 必须是 {schema['enum']!r} 之一")
    kinds = schema.get("type")
    kinds = [kinds] if isinstance(kinds, str) else list(kinds or [])
    checks = {
        "null": lambda x: x is None,
        "boolean": lambda x: isinstance(x, bool),
        "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
        "number": lambda x: isinstance(x, (int, float)) and not isinstance(x, bool),
        "string": lambda x: isinstance(x, str),
        "array": lambda x: isinstance(x, list),
        "object": lambda x: isinstance(x, dict),
    }
    if kinds and not any(checks.get(k, lambda _: True)(value) for k in kinds):
        raise ToolDenied(f"{path} 类型必须是 {kinds}，实际是 {type(value).__name__}")
    if isinstance(value, dict):
        missing = [x for x in schema.get("required") or [] if x not in value]
        if missing:
            raise ToolDenied(f"{path} 缺少必填参数 {missing}")
        props = schema.get("properties") or {}
        for key, sub in props.items():
            if key in value and isinstance(sub, dict):
                _validate_schema(value[key], sub, path=f"{path}.{key}")
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(props))
            if extra:
                raise ToolDenied(f"{path} 含未声明字段 {extra}")
    if isinstance(value, list):
        if schema.get("minItems") is not None and len(value) < int(schema["minItems"]):
            raise ToolDenied(f"{path} 数量少于 {schema['minItems']}")
        if schema.get("maxItems") is not None and len(value) > int(schema["maxItems"]):
            raise ToolDenied(f"{path} 数量多于 {schema['maxItems']}")
        if isinstance(schema.get("items"), dict):
            for i, item in enumerate(value):
                _validate_schema(item, schema["items"], path=f"{path}[{i}]")
    if isinstance(value, str):
        if schema.get("minLength") is not None and len(value) < int(schema["minLength"]):
            raise ToolDenied(f"{path} 长度小于 {schema['minLength']}")
        if schema.get("maxLength") is not None and len(value) > int(schema["maxLength"]):
            raise ToolDenied(f"{path} 长度大于 {schema['maxLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if schema.get("minimum") is not None and value < schema["minimum"]:
            raise ToolDenied(f"{path} 不能小于 {schema['minimum']}")
        if schema.get("maximum") is not None and value > schema["maximum"]:
            raise ToolDenied(f"{path} 不能大于 {schema['maximum']}")


def _digest(args: dict[str, Any], limit: int = 200) -> dict[str, str]:
    out = {}
    for k, v in args.items():
        s = str(v)
        out[k] = s if len(s) <= limit else s[:limit] + f"…(+{len(s) - limit})"
    return out


# ══════════════════════════════════════════════════════════════════
#  内建工具
# ══════════════════════════════════════════════════════════════════
def _scopes_for(tool: str) -> tuple[str, ...]:
    """按 :data:`~.agents.TOOL_SCOPES` 求这个工具该出现在哪些作用域。

    那张表一直是**声明式**的：``builtin_registry`` 全用默认的 ``("*",)`` 注册，
    于是每个作用域都拿到全部内建工具，表里写的限制一条也没生效。这里把它变成
    真的授权依据 —— 架构审计列的 P0-1（工具最小权限失效）说的就是这件事。

    表里没提到的工具（纯只读的检索/查询）保持 ``("*",)``：它们不出网、不改状态，
    限制它们只会让各处忘记加作用域时静默失能。
    """
    from .agents import TOOL_SCOPES

    hit = tuple(sc for sc, names in TOOL_SCOPES.items() if tool in names)
    return hit or ("*",)


def builtin_registry(
    *, evidence: Any = None, oir: Any = None, profiles: dict | None = None,
    sandbox: Any = None,
) -> ToolRegistry:
    """装配内建工具。

    只给真正需要的东西：检索证据、查 OIR、看列画像、跑代码。**没有出网工具** ——
    这个系统在正常运行中不需要访问互联网。
    """
    reg = ToolRegistry()

    if evidence is not None:
        @reg.fn("evidence.search",
                "在已上传的材料里检索证据切片。返回的每一片都带 file!locator 出处，"
                "引用时必须原样带上，不要改写或简化出处。",
                {"type": "object", "required": ["query"],
                 "properties": {
                     "query": {"type": "string", "description": "检索词，用材料里的原词"},
                     "top_k": {"type": "integer", "description": "最多返回几片，默认 12"},
                     "files": {"type": "array", "items": {"type": "string"},
                               "description": "限定文件，写**文件名**即可（如 "
                                              "「实体梳理.xlsx」）；不给则全库"},
                     "kinds": {"type": "array", "items": {"type": "string"},
                               "description": "限定来源类型，如 ddl/json/range/page/cell；"
                                              "不给则不限。想只看物理定义就传 [\"ddl\"]"}}},
                danger=Danger.READ)
        def _search(ctx: Any, query: str, top_k: int = 12,
                    files: list[str] | None = None,
                    kinds: list[str] | None = None) -> dict[str, Any]:
            # `files` 按 file_id 过滤，但**没有任何工具向模型给过 file_id** ——
            # 它看到的只有文件名和 cite。于是模型一填 files 就必然过滤掉全部切片、
            # 静默拿到空结果（比报错更糟：它会据此断言"材料里没有"）。这里把文件名
            # 解析成 id；解析不到的原样传下去，仍当 id 用。
            if files:
                by_name = evidence.file_names()
                resolved, unknown = [], []
                for f in files:
                    # 模型很爱把中文文件名**百分号编码**了再传
                    # （"%E9%87%87%E8%B4%AD…xlsx"）—— 大概是把它当 URL 片段。
                    # material.parse 那边靠子串匹配蒙混过去了，这里按全名查就
                    # 全军覆没，回一句"没有这些材料"，而它上一秒刚读进来。
                    # 认一下解码后的形态，别让同一个名字在两个工具里一个认一个不认。
                    cand = [f]
                    if "%" in f:
                        from urllib.parse import unquote
                        dec = unquote(f)
                        if dec != f:
                            cand.append(dec)
                    hit = next((by_name.get(x) for x in cand if by_name.get(x)), None)
                    if hit is None:
                        hit = next((fid for nm, fid in by_name.items()
                                    if any(x in nm for x in cand)), None)
                    (resolved.append(hit) if hit else unknown.append(f))
                if unknown and not resolved:
                    return {"count": 0, "chunks": [],
                            "error": f"没有这些材料：{unknown}。现有："
                                     f"{sorted(by_name)}"}
                files = resolved or None
            hits = evidence.search(query, top_k=top_k, files=files, kinds=kinds, expand=1)
            return {"count": len(hits),
                    "chunks": [{"cite": c.cite(), "text": c.render[:1200]} for c in hits]}

        @reg.fn("evidence.rows",
                "**按位置**取原文，不走关键词检索。要看某张表的第 30~46 行、"
                "或某个 sheet 的全部内容时用它 —— 行号不是关键词，"
                "evidence.search 打不出分，只会返回一堆无关切片。",
                {"type": "object",
                 "properties": {
                     "file": {"type": "string", "description": "文件名，可只写一部分"},
                     "container": {"type": "string",
                                   "description": "sheet / 章节 / 表名，可只写一部分"},
                     "from_row": {"type": "integer", "description": "起始行号（含）"},
                     "to_row": {"type": "integer", "description": "结束行号（含）"},
                     "limit": {"type": "integer", "description": "最多返回几片，默认 60"}}},
                danger=Danger.READ)
        def _rows(ctx: Any, file: str = "", container: str = "",
                  from_row: int | None = None, to_row: int | None = None,
                  limit: int = 60) -> dict[str, Any]:
            span = None
            if from_row is not None or to_row is not None:
                lo = from_row if from_row is not None else 0
                hi = to_row if to_row is not None else 10**9
                span = (min(lo, hi), max(lo, hi))
            hits = evidence.by_locator(file=file, container=container, rows=span,
                                       limit=limit)
            if not hits:
                # 空结果最危险：模型会据此断言"材料里没有"。把实际存在的容器名
                # 报回去，它才知道是位置写错了、还是真的没有。
                seen: dict[str, None] = {}
                for c in evidence.all_chunks():
                    where = str((c.locator or {}).get("sheet")
                                or (c.locator or {}).get("section") or "")
                    if where:
                        seen.setdefault(f"{c.file_name}!{where}", None)
                return {"count": 0, "chunks": [],
                        "note": "这个位置没有内容。现有的表/章节："
                                f"{list(seen)[:20]}"}
            return {"count": len(hits),
                    "chunks": [{"cite": c.cite(), "text": c.render[:1200]} for c in hits]}

    if oir is not None:
        @reg.fn("oir.query",
                "查当前 OIR 里已有的对象/属性/关系。用来避免重复抽取同一个概念。",
                {"type": "object", "required": ["kind"],
                 "properties": {
                     "kind": {"type": "string",
                              "enum": ["objects", "properties", "links", "actions", "stats"]},
                     "name_contains": {"type": "string"}}},
                danger=Danger.READ)
        def _oir(ctx: Any, kind: str, name_contains: str = "") -> Any:
            if kind == "stats":
                return oir.stats()
            bucket = getattr(oir, kind)
            items = [e.to_dict() for e in bucket.values()
                     if not name_contains
                     or name_contains.lower() in str(e.api_name.value).lower()]
            return {"count": len(items), "items": items[:60]}

    if oir is not None:
        @reg.fn("impact.trace",
                "改这一个东西会牵动哪些别的东西。给一个对象/属性/关系/行动的名字或 rid，"
                "返回顺着依赖走出去的全部受影响项、各自的路径和为什么受影响。"
                "**回答「这个能不能改」「改了影响多大」之前先调它** —— "
                "凭印象说「影响不大」是这个岗位最贵的错误之一。",
                {"type": "object", "required": ["target"],
                 "properties": {
                     "target": {"type": "string",
                                "description": "rid，或对象/属性的 apiName、中文名"},
                     "depth": {"type": "integer",
                               "description": "顺着依赖走几层，默认 2，最大 4"}}},
                danger=Danger.READ)
        def _impact(ctx: Any, target: str, depth: int = 2) -> Any:
            rid = _resolve_rid(oir, target)
            if rid is None:
                return {"error": f"OIR 里找不到「{target}」",
                        "note": "先用 oir.query 看现有的名字，别照着材料里的写法猜 rid"}
            depth = max(1, min(int(depth or 2), 4))
            # 广度优先，逐层记路径。纯图遍历、零模型 —— 这条链路上不存在编造，
            # 返回的每个 rid 都必然是 OIR 里已有的实体。
            seen: dict[str, list[str]] = {rid: [rid]}
            frontier = [rid]
            for _ in range(depth):
                nxt: list[str] = []
                for cur in frontier:
                    for dep in oir.dependents(cur):
                        if dep in seen:
                            continue
                        seen[dep] = [*seen[cur], dep]
                        nxt.append(dep)
                frontier = nxt
                if not frontier:
                    break
            items = [{"rid": r, "kind": _rid_kind(oir, r),
                      "name": _rid_name(oir, r), "path": p,
                      "hops": len(p) - 1}
                     for r, p in seen.items() if r != rid]
            counts: dict[str, int] = {}
            for it in items:
                counts[it["kind"]] = counts.get(it["kind"], 0) + 1
            return {"target": {"rid": rid, "kind": _rid_kind(oir, rid),
                               "name": _rid_name(oir, rid)},
                    "total": len(items), "counts": counts,
                    "affected": sorted(items, key=lambda x: (x["hops"], x["kind"]))[:60],
                    "note": ("这是**结构**上的影响面，不含「业务上谁会不高兴」。"
                             "口径类的影响要另外看冲突清单。" if items else
                             "顺着依赖走不到任何东西 —— 要么它确实是叶子，"
                             "要么关系还没抽出来。")}

    if profiles:
        @reg.fn("profile.column",
                "查某一列的确定性统计（唯一率、空值率、推断类型、样本值）。"
                "判断声明类型与实际数据是否相符时用它 —— 这类跨行分布问题"
                "不要靠自己看样本推断。",
                {"type": "object", "required": ["column"],
                 "properties": {"column": {"type": "string",
                                           "description": "形如 表名.列名"}}},
                danger=Danger.READ)
        def _profile(ctx: Any, column: str) -> Any:
            if column in profiles:
                return profiles[column]
            near = [k for k in profiles if column.lower() in k.lower()]
            return {"error": f"没有 {column} 的画像", "did_you_mean": near[:8]}

    if sandbox is not None:
        @reg.fn("code.exec",
                "在隔离沙箱里执行 Python。用于数据清洗、透视、连接、统计这类"
                "变换。环境里已注入 INPUTS(dict)、IN_DIR、OUT_DIR 和 emit(obj)；"
                "结构化结果请用 emit() 交回。无网络。",
                {"type": "object", "required": ["code"],
                 "properties": {
                     "code": {"type": "string", "description": "Python 源码"},
                     "inputs": {"type": "object", "description": "注入为 INPUTS"}}},
                # **最小权限：只给声明了它的作用域。** 默认的 ("*",) 会把执行代码的
                # 能力发给每一个作用域，包括直接读用户上传材料的 extract —— 材料里
                # 一段伪装成业务说明的指令就能诱导模型调它。TOOL_SCOPES 早就写明
                # 只有 analyze/compile 该有，这里让那份声明真正生效。
                danger=Danger.COMPUTE, scopes=_scopes_for("code.exec"))
        async def _exec(ctx: Any, code: str, inputs: dict | None = None) -> Any:
            res = await sandbox.exec(code, inputs=inputs or {})
            return res.to_dict()

    return reg


# ══════════════════════════════════════════════════════════════════
#  impact.trace 的小工具
# ══════════════════════════════════════════════════════════════════
#: OIR 的实体桶 → 单数名。顺序即查找优先级：对象 → 属性 → 关系 → 行动 → 规则。
#: 单数名写死而不是 ``bucket[:-1]`` —— 后者把 properties 削成 "propertie"。
_OIR_BUCKETS: dict[str, str] = {
    "objects": "object", "properties": "property", "links": "link",
    "actions": "action", "rules": "rule",
}


def _rid_kind(oir: Any, rid: str) -> str:
    for bucket, singular in _OIR_BUCKETS.items():
        if rid in (getattr(oir, bucket, None) or {}):
            return singular
    return "unknown"


def _rid_name(oir: Any, rid: str) -> str:
    """人看的名字。取不到就退回 rid —— 空字符串会让影响面清单变成一列空白。"""
    for bucket in _OIR_BUCKETS:
        item = (getattr(oir, bucket, None) or {}).get(rid)
        if item is None:
            continue
        for attr in ("display_name", "api_name", "statement"):
            val = getattr(getattr(item, attr, None), "value", None)
            if val:
                return str(val)[:80]
    return rid


def _resolve_rid(oir: Any, target: str) -> str | None:
    """把用户/模型给的东西解析成 rid。

    **接受名字而不只是 rid**：模型手上多半只有材料里的中文名或 apiName，
    要求它先查一次 rid 是白白多一轮往返，而且它会开始猜 rid 的构造规则。
    """
    t = str(target or "").strip()
    if not t:
        return None
    for bucket in _OIR_BUCKETS:
        if t in (getattr(oir, bucket, None) or {}):
            return t
    low = t.lower()
    for bucket in _OIR_BUCKETS:
        for rid, item in (getattr(oir, bucket, None) or {}).items():
            for attr in ("api_name", "display_name"):
                val = getattr(getattr(item, attr, None), "value", None)
                if val and str(val).lower() == low:
                    return rid
    return None
