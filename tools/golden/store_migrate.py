"""导出 store/migrate.py 的 golden —— 目录发现、校验和、以及 upgrade 的**语句轨迹**。

这个模块没有算法可言，值钱的全是**行为的确切形状**：

1. `Migration.checksum` 的字节 —— sha256(文本)[:32]。注意 `Path.read_text` 走
   **universal newlines**：`\\r\\n` / 单独的 `\\r` 在返回前就被翻成 `\\n`。
   Node 的 `readFileSync(p,"utf8")` **不翻**。同一个 CRLF 文件两边算出不同校验和，
   后果不是"哈希不一样"，是 TS 侧启动时对着 Python 迁过的库当场报"迁移内容变了"。
   所以这里连**字节**一起导（base64），让 TS 侧能验的是"从这堆字节出发得到同一个值"，
   而不是"我假设两边读文件是一回事"。

2. `discover` 的报错文本与判据顺序（命名 → 重号 → 不连续）。

3. `upgrade` 的语句轨迹 —— 拿一个**记录型假 engine** 真跑一遍 `upgrade()`，
   把每一条 execute / 原生脚本 / 加锁解锁按顺序记下来。这样"解锁在 finally 里、
   校验和不符时后面的迁移一条都不许跑、dry_run 不写库"这些不变量是**跑出来的**，
   不是我猜的。

字节确定：无时间、无随机、临时目录只导文件名不导路径，`sort_keys=True`。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

import sqlalchemy as sa  # noqa: E402

import ontocopilot.store.engine as engine_mod  # noqa: E402
from ontocopilot.store.migrate import (  # noqa: E402
    LOCK_KEY,
    MIGRATIONS,
    Migration,
    _main,
    discover,
    upgrade,
)

ROOT = pathlib.Path(__file__).resolve().parents[2]


# ══════════════════════════════════════════════════════════════════
#  记录型假 engine —— 只实现 upgrade() 真正碰到的那几个方法
# ══════════════════════════════════════════════════════════════════


class _Result:
    def __init__(self, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = [] if rows is None else rows

    def scalar(self):
        return self._scalar

    def all(self):
        return self._rows


class _Raw:
    """asyncpg 的原生连接。`execute` 走 simple query protocol，收整段脚本。"""

    def __init__(self, trace: list) -> None:
        self._trace = trace

    async def execute(self, sql: str) -> None:
        self._trace.append({
            "op": "script",
            "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
            "chars": len(sql),
        })


class _RawWrapper:
    def __init__(self, raw: _Raw) -> None:
        self.driver_connection = raw


class _Conn:
    def __init__(self, trace: list, table_exists: bool, rows: list) -> None:
        self._trace = trace
        self._table_exists = table_exists
        self._rows = rows

    async def execution_options(self, **kw):
        self._trace.append({"op": "execution_options", "kw": dict(sorted(kw.items()))})
        return self

    async def get_raw_connection(self):
        return _RawWrapper(_Raw(self._trace))

    async def execute(self, stmt, params=None):
        text = stmt.text
        self._trace.append({
            "op": "execute",
            "sql": text,
            "params": None if params is None else dict(sorted(params.items())),
        })
        if "to_regclass" in text:
            return _Result(scalar=self._table_exists)
        if text.startswith("SELECT version, checksum"):
            return _Result(rows=list(self._rows))
        return _Result()


class _Engine:
    def __init__(self, dialect: str, table_exists: bool, rows: list) -> None:
        self.dialect = type("D", (), {"name": dialect})()
        self.trace: list = []
        self._table_exists = table_exists
        self._rows = rows

    def connect(self):
        engine = self

        class _Ctx:
            async def __aenter__(self):
                engine.trace.append({"op": "connect"})
                return _Conn(engine.trace, engine._table_exists, engine._rows)

            async def __aexit__(self, *exc):
                engine.trace.append({"op": "close"})
                return False

        return _Ctx()


async def _run(scenario: str, *, dialect="postgresql", table_exists=False,
               rows=None, dry_run=False, root=None) -> dict:
    eng = _Engine(dialect, table_exists, rows or [])
    # 输入一起导出，TS 侧就不必照抄一遍装配代码 —— 照抄的那份会自己漂。
    out: dict = {
        "scenario": scenario,
        "dry_run": dry_run,
        "input": {
            "dialect": dialect,
            "table_exists": table_exists,
            "rows": [list(r) for r in (rows or [])],
            "root_kind": "empty" if root is not None else "default",
        },
    }
    try:
        out["applied"] = await upgrade(eng, root=root, dry_run=dry_run)
    except Exception as exc:  # noqa: BLE001 —— 报错文本本身就是被钉的东西
        out["error"] = {"type": type(exc).__name__, "message": str(exc)}
    out["trace"] = eng.trace
    return out


# ══════════════════════════════════════════════════════════════════
#  CLI —— 跑真的 _main，只把 engine/Store 换成假的
# ══════════════════════════════════════════════════════════════════


class _FakeStore:
    def __init__(self, eng) -> None:
        self.engine = eng

    async def close(self) -> None:
        pass


def _cli_case(label: str, argv: list[str], *, url="postgresql+asyncpg://x/y",
              table_exists=False, rows=None) -> dict:
    """CLI 的输出是运维唯一看得见的东西，所以钉的是 **stdout/stderr 的字节**。

    `_main` 在函数体内 `from .engine import Store, database_url`，所以替换模块属性
    就能拦住 —— 不碰 migrate.py 一个字。
    """
    eng = _Engine("postgresql", table_exists, rows or [])
    old_store, old_url = engine_mod.Store, engine_mod.database_url

    class _S:
        @staticmethod
        async def open(u, **kw):
            del u, kw
            return _FakeStore(eng)

    engine_mod.Store = _S
    engine_mod.database_url = lambda: url
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = asyncio.run(_main(argv))
    finally:
        engine_mod.Store, engine_mod.database_url = old_store, old_url
    return {"label": label, "argv": argv, "rc": code,
            "input": {"url": url, "table_exists": table_exists,
                      "rows": [list(r) for r in (rows or [])]},
            "stdout": out.getvalue(), "stderr": err.getvalue()}


# ══════════════════════════════════════════════════════════════════
#  discover 的用例
# ══════════════════════════════════════════════════════════════════


def _discover_case(label: str, names: list[str]) -> dict:
    """在独立临时目录里放一组文件名，记录 discover 的结果或报错。

    每个用例一个目录 —— 同目录放大小写变体在 macOS 的大小写不敏感卷上会互相覆盖，
    导出就不确定了。
    """
    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)
        for n in names:
            (root / n).write_text(f"-- {n}\n", encoding="utf-8")
        case: dict = {"label": label, "files": sorted(names)}
        try:
            case["versions"] = [m.version for m in discover(root)]
            case["names"] = [m.name for m in discover(root)]
        except Exception as exc:  # noqa: BLE001
            case["error"] = {"type": type(exc).__name__, "message": str(exc)}
        return case


def _checksum_case(label: str, raw: bytes) -> dict:
    """校验和是从**磁盘字节**出发算的，所以用例也从字节出发。"""
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "0001_x.sql"
        p.write_bytes(raw)
        m = Migration(1, "x", p)
        return {
            "label": label,
            "bytes_b64": base64.b64encode(raw).decode("ascii"),
            "text": m.sql,
            "checksum": m.checksum,
            "sha256_full": hashlib.sha256(m.sql.encode("utf-8")).hexdigest(),
        }


def main() -> None:
    migs = discover()
    catalog = [
        {
            "version": m.version,
            "name": m.name,
            "filename": m.path.name,
            "checksum": m.checksum,
            "sha256_full": hashlib.sha256(m.sql.encode("utf-8")).hexdigest(),
            "chars": len(m.sql),
            "bytes": m.path.stat().st_size,
        }
        for m in migs
    ]

    discover_cases = [
        _discover_case("empty", []),
        _discover_case("ok", ["0001_init.sql", "0002_accounts_v2.sql"]),
        # .sql 之外的文件被 glob 直接排除，不参与命名检查
        _discover_case("ignores_non_sql", ["0001_init.sql", "README.md", "0002_x.txt"]),
        # pathlib.glob 会**收进**点开头的文件（shell glob 不会），于是它进了命名检查
        _discover_case("dotfile_is_not_ignored", ["0001_init.sql", ".keep.sql"]),
        _discover_case("bad_no_padding", ["1_init.sql"]),
        _discover_case("bad_uppercase", ["0001_Init.sql"]),
        _discover_case("bad_dash", ["0001-init.sql"]),
        _discover_case("bad_no_number", ["init.sql"]),
        _discover_case("bad_five_digits", ["00001_init.sql"]),
        _discover_case("bad_empty_name", ["0001_.sql"]),
        _discover_case("dup", ["0001_a.sql", "0001_b.sql"]),
        _discover_case("gap", ["0001_a.sql", "0003_c.sql"]),
        _discover_case("starts_at_zero", ["0000_a.sql"]),
        _discover_case("starts_at_two", ["0002_a.sql"]),
        # 报错优先级：命名不合规先于重号/不连续（前者在循环里就抛了）
        _discover_case("bad_name_wins_over_gap", ["0003_a.sql", "bad.sql"]),
    ]

    checksum_cases = [
        _checksum_case("lf", b"BEGIN;\nSELECT 1;\nCOMMIT;\n"),
        _checksum_case("crlf", b"BEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n"),
        _checksum_case("cr_only", b"BEGIN;\rSELECT 1;\rCOMMIT;\r"),
        _checksum_case("mixed", b"A\r\nB\rC\nD"),
        _checksum_case("empty", b""),
        _checksum_case("bom", b"\xef\xbb\xbfSELECT 1;\n"),
        _checksum_case("cjk", "-- 会话表\nCREATE TABLE session ();\n".encode("utf-8")),
        _checksum_case("no_trailing_newline", b"SELECT 1;"),
    ]

    # 真实目录上的场景 —— 校验和从真文件来，不是编的
    real = {m.version: m.checksum for m in migs}
    last = migs[-1].version
    tampered_mid = [(v, ("0" * 32 if v == 3 else c)) for v, c in sorted(real.items()) if v <= 5]

    with tempfile.TemporaryDirectory() as d:
        empty_root = pathlib.Path(d)
        scenarios = asyncio.run(_gather(migs, real, last, tampered_mid, empty_root))

    half = [(v, c) for v, c in sorted(real.items()) if v <= 5]
    cli_cases = [
        _cli_case("status_none", ["--status"]),
        _cli_case("status_partial", ["--status"], table_exists=True, rows=half),
        _cli_case("status_all", ["--status"], table_exists=True, rows=sorted(real.items())),
        _cli_case("upgrade_up_to_date", [], table_exists=True, rows=sorted(real.items())),
        _cli_case("upgrade_partial", ["--dry-run"], table_exists=True, rows=half),
        _cli_case("upgrade_one", ["--dry-run"], table_exists=True,
                  rows=[(v, c) for v, c in sorted(real.items()) if v < last]),
        _cli_case("no_database_url", [], url=""),
    ]

    out = {
        "cli_cases": cli_cases,
        "lock_key": LOCK_KEY,
        "migrations_dir": MIGRATIONS.name,
        "migrations_is_source_checkout": MIGRATIONS == ROOT / "migrations",
        "catalog": catalog,
        "discover_cases": discover_cases,
        "checksum_cases": checksum_cases,
        "upgrade_scenarios": scenarios,
    }

    dst = ROOT / "golden" / "store_migrate.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                   encoding="utf-8")
    print(f"wrote {dst}")


async def _gather(migs, real, last, tampered_mid, empty_root) -> list:
    return [
        # 空库：schema_migration 表都还不存在
        await _run("fresh"),
        await _run("fresh_dry_run", dry_run=True),
        # 表在但一行没有（比如迁移跑到一半崩了又被手工清空）
        await _run("table_exists_but_empty", table_exists=True, rows=[]),
        # 跑到第 5 号
        await _run("partial", table_exists=True,
                   rows=[(v, c) for v, c in sorted(real.items()) if v <= 5]),
        # 已是最新
        await _run("up_to_date", table_exists=True, rows=sorted(real.items())),
        await _run("up_to_date_dry_run", table_exists=True, rows=sorted(real.items()),
                   dry_run=True),
        # **核心不变量**：已应用的迁移内容被改动，当场拒绝
        await _run("tampered_middle", table_exists=True, rows=tampered_mid),
        await _run("tampered_first", table_exists=True, rows=[(1, "0" * 32)]),
        # dry_run 也照样拒绝 —— 校验和检查在 dry_run 分支之前
        await _run("tampered_dry_run", table_exists=True, rows=[(1, "0" * 32)], dry_run=True),
        # 库里有文件里没有的版本号（回滚到旧代码）：被忽略，不报错
        await _run("unknown_version_in_db", table_exists=True,
                   rows=sorted(real.items()) + [(last + 90, "f" * 32)]),
        # version 从库里读出来是字符串时也要能对上（int(v) 那一步）
        await _run("version_as_text", table_exists=True,
                   rows=[(str(v), c) for v, c in sorted(real.items())]),
        # 方言不对：在 connect 之前就抛，一条语句都不发
        await _run("sqlite_dialect", dialect="sqlite"),
        await _run("mysql_dialect", dialect="mysql"),
        # 空目录：照样连接、加锁、解锁，只是没得跑
        await _run("empty_catalog", root=empty_root),
    ]


if __name__ == "__main__":
    main()
