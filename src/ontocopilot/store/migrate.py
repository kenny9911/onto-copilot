"""迁移执行器 —— 手写编号 SQL，不用 Alembic。

**为什么不用 Alembic。** Alembic 的核心价值是 autogenerate：从声明式 ORM 模型
diff 出 DDL。这个项目**没有 ORM 模型** —— 领域对象是手写 dataclass，落库形态是
``to_dict()`` 的 JSONB，表结构由人设计而不是由类推导。没有 autogenerate 的
Alembic 剩下的就是"给 SQL 文件编号 + 记一张版本表"，而那是下面这 60 行。
代价那边：alembic.ini + env.py 的 async engine 配置、``script_location``、
revision 链的分叉合并、以及一个团队里没人真正读过的 ``down_revision``。

**什么时候该换成 Alembic**：需要带数据回填的迁移（不只是 DDL）、需要多个环境
停在不同版本、或者出现了分支并行开发同时改 schema。这三条现在一条都不成立。

**没有 down migration。** 生产回滚靠"新写一个前向迁移"，不靠 downgrade ——
downgrade 脚本几乎从不被执行，因此几乎从不被验证，需要它的那天它是坏的。

用法::

    python -m ontocopilot.store.migrate            # 迁到最新
    python -m ontocopilot.store.migrate --status   # 只看状态
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import sys
from dataclasses import dataclass
from pathlib import Path

#: 源码 checkout 继续直接读取仓库根目录，方便 CI/运维审阅；wheel 会把同一目录
#: force-include 到 ``ontocopilot/migrations``，因此安装包也能独立执行迁移。
_SOURCE_MIGRATIONS = Path(__file__).resolve().parents[3] / "migrations"
_PACKAGED_MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
MIGRATIONS = (
    _SOURCE_MIGRATIONS if _SOURCE_MIGRATIONS.is_dir() else _PACKAGED_MIGRATIONS
)

#: 迁移期间持有的会话级 advisory lock。多副本同时启动时只有一个真正执行，
#: 其余阻塞等待，避免两个进程同时 CREATE TABLE。0x4F4E544F == b"ONTO"。
LOCK_KEY = 0x4F4E544F

_NAME_RE = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")


@dataclass(frozen=True, slots=True)
class Migration:
    version: int
    name: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.sql.encode("utf-8")).hexdigest()[:32]


def discover(root: Path | None = None) -> list[Migration]:
    """扫出 ``NNNN_name.sql``，按编号排序。编号必须连续、不许重号。"""
    root = MIGRATIONS if root is None else root
    out: list[Migration] = []
    for p in sorted(root.glob("*.sql")):
        m = _NAME_RE.match(p.name)
        if not m:
            raise ValueError(f"迁移文件名不合规（要 NNNN_name.sql）: {p.name}")
        out.append(Migration(int(m.group(1)), m.group(2), p))
    seen = [x.version for x in out]
    if len(set(seen)) != len(seen):
        raise ValueError(f"迁移编号重复: {seen}")
    if seen and seen != list(range(1, len(seen) + 1)):
        raise ValueError(f"迁移编号不连续: {seen}")
    return out


async def applied(conn) -> dict[int, str]:
    """已应用的 {version: checksum}。表还不存在时返回空。"""
    import sqlalchemy as sa
    exists = (await conn.execute(sa.text(
        "SELECT to_regclass('public.schema_migration') IS NOT NULL"))).scalar()
    if not exists:
        return {}
    rs = (await conn.execute(sa.text(
        "SELECT version, checksum FROM schema_migration"))).all()
    return {int(v): c for v, c in rs}


async def upgrade(engine, *, root: Path | None = None, dry_run: bool = False) -> list[int]:
    """把库迁到最新。返回本次实际执行的版本号。

    每个迁移文件**自带 BEGIN/COMMIT**，所以连接跑在 AUTOCOMMIT 上，由文件自己
    控制事务边界。一个文件失败不会让前面成功的那些回滚，版本表如实反映停在哪。

    只支持 Postgres —— SQLite（测试）走 ``metadata.create_all()``，
    见 :meth:`Store.open` 的 ``create_all`` 参数。
    """
    import sqlalchemy as sa
    if engine.dialect.name != "postgresql":
        raise RuntimeError(f"迁移只跑 Postgres，当前方言 {engine.dialect.name}；"
                           f"SQLite 请用 Store.open(create_all=True)")
    todo: list[int] = []
    migs = discover(root)

    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        # 多副本同时启动时只有一个真正执行，其余在这里排队。
        await conn.execute(sa.text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
        try:
            done = await applied(conn)
            for m in migs:
                if m.version in done:
                    if done[m.version] != m.checksum:
                        raise RuntimeError(
                            f"迁移 {m.version:04d}_{m.name} 的内容变了 "
                            f"（库里 {done[m.version]}，文件 {m.checksum}）。"
                            f"已应用的迁移不许改 —— 新写一个前向迁移。")
                    continue
                todo.append(m.version)
                if dry_run:
                    continue
                # **必须走 asyncpg 的原生 execute()。**
                # SQLAlchemy 的 exec_driver_sql 会走 prepared statement，
                # 而 asyncpg 对预编译语句只允许**单条** —— 一个带
                # BEGIN/CREATE TABLE/COMMIT 的迁移文件会直接报
                # `cannot insert multiple commands into a prepared statement`。
                # 原生 execute 用的是 simple query protocol，接受整段脚本。
                raw = (await conn.get_raw_connection()).driver_connection
                await raw.execute(m.sql)
                await conn.execute(
                    sa.text("INSERT INTO schema_migration (version, name, checksum) "
                            "VALUES (:v, :n, :c)"),
                    {"v": m.version, "n": m.name, "c": m.checksum})
        finally:
            await conn.execute(sa.text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
    return todo


async def _main(argv: list[str]) -> int:
    from .engine import Store, database_url
    url = database_url()
    if not url:
        print("DATABASE_URL 未配置 —— 内存模式不需要迁移。", file=sys.stderr)
        return 0
    store = await Store.open(url)
    try:
        if "--status" in argv:
            async with store.engine.connect() as conn:
                done = await applied(conn)
            for m in discover():
                mark = "✓" if m.version in done else " "
                print(f"[{mark}] {m.version:04d}_{m.name}")
            return 0
        ran = await upgrade(store.engine, dry_run="--dry-run" in argv)
        print(f"应用了 {len(ran)} 个迁移: {ran or '（已是最新）'}")
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main(sys.argv[1:])))
