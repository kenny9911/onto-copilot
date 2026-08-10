"""持久化。

分层：``schema``（表定义）→ ``repo``（仓储，两个实现）→ ``deps``（FastAPI 接线）。
``engine`` 负责选路，``migrate`` 是运维入口。

没配 ``DATABASE_URL`` 时整个包除了 ``engine`` / ``repo.MemoryRepo`` 之外
**不会被导入**，SQLAlchemy 也不会被 import —— 所以它是 optional dependency，
现有 254 个测试的启动时间不受影响。
"""

from .const import DERIVED_KEYS, EVENT_INLINE_LIMIT
from .engine import Store, database_url
from .repo import DecisionRow, EventRow, FileRow, MemoryRepo, Repo, SessionRow, build_repo

__all__ = ["Store", "database_url", "Repo", "MemoryRepo", "build_repo",
           "SessionRow", "FileRow", "EventRow", "DecisionRow",
           "DERIVED_KEYS", "EVENT_INLINE_LIMIT"]
