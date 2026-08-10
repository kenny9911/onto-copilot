"""跨层常量。

单独一个模块，是为了让 :mod:`~ontocopilot.store.repo` 的内存实现**不 import
SQLAlchemy** —— 没配 ``DATABASE_URL`` 的部署与现有 244 个测试不该为 Postgres
付出任何导入代价。
"""

from __future__ import annotations

#: 会重建的、丢了不心疼的 session_state key。恢复会话时可以不读。
#: **_chunks 不在里面** —— 扫描件重建要再调一次视觉模型，而且 OCR 结果可能与
#: 抽取时不同，那样"点回原文"看到的就不是系统当初读到的东西
#: （server.py:840-844 的注释自己写了这个后果）。
DERIVED_KEYS = frozenset({
    "routing", "budget", "corpus", "template", "artifacts", "_profiles", "_endpoints",
})

#: session_event.payload 超过这个字节数就落 blob，行里只留 ref。
#: 与 recorder.INLINE_LIMIT（2048）是同一个道理，阈值放大一档 —— 前端事件天然
#: 比 effect 结果大（单条 node.completed node=CONFLICT 实测 235,702 B）。
EVENT_INLINE_LIMIT = 16_384

__all__ = ["DERIVED_KEYS", "EVENT_INLINE_LIMIT"]
