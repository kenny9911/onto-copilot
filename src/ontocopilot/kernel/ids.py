"""稳定 ID 与内容寻址。

重放要求 ID 可复现，所以内核里**不允许**用 uuid4 / random 生成 ID。
两种合法来源：
  1. 内容寻址 —— 由内容 sha256 导出，天然去重、天然幂等。
  2. 结构化路径 —— 由 (run_id, node_id, 序号) 拼出，调度顺序确定则 ID 确定。

外部注入的 ID（run_id、上传文件 id）由调用方给定，在 Run 开始前就固定下来，
之后进入事件日志，重放时从日志读回。
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

#: slug 里保留什么。**CJK 必须保留** —— 只留 ASCII 的话，一整批中文名会被
#: 抹成同一个空串，于是不同的东西拿到同一个 rid、后写的静默覆盖先写的。
_SLUG_RE = re.compile(r"[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def content_ref(data: bytes | str, *, prefix: str = "blob") -> str:
    """内容寻址引用，如 ``blob:3f2a...``（截断到 32 位十六进制）。"""
    return f"{prefix}:{sha256_hex(data)[:32]}"


def canonical_json(obj: Any) -> str:
    """确定性 JSON 序列化 —— 键排序、无多余空白。

    effect 指纹依赖它：同样的请求必须序列化成同样的字节，否则重放会误报
    determinism violation。
    """
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)


def fingerprint(obj: Any) -> str:
    """请求指纹，用于重放一致性校验。"""
    return sha256_hex(canonical_json(obj))[:16]


def slug(text: str, *, max_len: int = 40) -> str:
    """人可读的稳定 slug，用于 rid。

    **中文必须留下**。原来的实现只保留 ASCII，于是「集采计划编制已发起」和
    「编制集采计划」双双被抹成 ``x`` —— 两个完全不同的东西拿到同一个 rid，
    后写的把先写的覆盖掉，而且不报错。

    之前没暴露是因为实体名多半是 ``pbpHeader`` 这类英文码；流程节点全是中文，
    一下就撞穿了。既然 rid 只要求"稳定 + 可读"，中文本身就满足，
    没有理由把它扔掉。

    纯符号名（"---"）仍会退化成空，此时用内容哈希兜底而不是常量 ``x`` ——
    常量兜底就是把所有这类名字折叠成同一个 id。
    """
    s = _SLUG_RE.sub("_", text.strip().lower()).strip("_")
    if not s:
        return "x" + sha256_hex(text)[:8]
    return s[:max_len]


def rid(kind: str, name: str) -> str:
    """OIR 实体的稳定 rid，如 ``ot_purchase_plan_header``。

    kind 用短前缀：ot=ObjectType, pt=PropertyType, lt=LinkType, at=ActionType,
    cf=Conflict, dc=Decision。
    """
    return f"{kind}_{slug(name)}"


def child_id(parent: str, *parts: str | int) -> str:
    """结构化子 ID，如 ``EXTRACT.property#3``。"""
    tail = "#".join(str(p) for p in parts)
    return f"{parent}#{tail}" if tail else parent
