"""沙箱执行器 —— 跑模型生成的代码。

**威胁模型不是"防 bug"，是"防运行时生成的对抗代码"。** 代码在执行前无法被人
审阅，所以隔离强度决定了这个产品能不能碰客户数据。

三档实现，接口相同：

===================== ================= ==================================
实现                   隔离强度           用途
===================== ================= ==================================
LocalSubprocessSandbox 进程 + 资源上限     **仅开发**。无内核隔离，见下方警告
GVisorSandbox          用户态内核         生产默认。CodeAct 常规数据处理
FirecrackerSandbox     独立内核 microVM   未知来源二进制、扫描件 OCR
===================== ================= ==================================

.. warning::
   :class:`LocalSubprocessSandbox` **不提供内核级隔离**。它做的是资源上限、
   文件系统限定、环境变量清洗、超时终止 —— 足以挡住失控的循环和误删，挡不住
   蓄意的提权或逃逸。生产环境必须用 gVisor 或 Firecracker。这一点在
   :meth:`SandboxExecutor.describe` 里也会明说，免得部署时被当成安全的。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import SandboxError

#: 沙箱里允许留下的环境变量。其余全部清掉 —— 凭证绝不进沙箱。
ENV_ALLOWLIST = frozenset({"PATH", "LANG", "LC_ALL", "TZ", "HOME", "TMPDIR"})

#: 危险模块。既要匹配 ``import socket`` 也要匹配 ``socket.socket()`` ——
#: 只写带点号的形式会漏掉裸 import，那是最常见的写法。
_RISKY_MODULES = {
    "network": ("socket", "urllib", "requests", "httpx", "http", "ftplib",
                "smtplib", "telnetlib", "aiohttp"),
    "subprocess": ("subprocess", "pty", "multiprocessing"),
}

#: 明显在试探边界的模式。命中不代表一定恶意，但要记账并可选择拦截。
SUSPICIOUS = (
    ("subprocess", ("os.system", "os.popen", "os.exec", "os.spawn")),
    ("env_probe", ("os.environ", "getenv")),
    ("fs_escape", ("../..", "/etc/passwd", "~/.ssh", "/proc/self", "/root/")),
    ("dynamic_exec", ("eval(", "exec(", "__import__", "compile(")),
)

_IMPORT = re.compile(r"^\s*(?:import|from)\s+([\w.]+)", re.MULTILINE)


@dataclass(frozen=True, slots=True)
class SandboxLimits:
    cpu_seconds: int = 60
    wallclock_seconds: int = 180
    memory_mb: int = 2048
    max_output_bytes: int = 2_000_000
    max_out_dir_mb: int = 512
    network: bool = False  # 默认无网。需要出网的活不该在沙箱里干


@dataclass(slots=True)
class ExecResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    duration_ms: int = 0
    artifacts: dict[str, Any] = field(default_factory=dict)
    result: Any = None  # /out/result.json 的内容
    flags: list[str] = field(default_factory=list)  # 命中的可疑模式

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok, "exit_code": self.exit_code, "duration_ms": self.duration_ms,
            "stdout": self.stdout[-4000:], "stderr": self.stderr[-4000:],
            "artifacts": list(self.artifacts), "result": self.result, "flags": self.flags,
        }


def scan(code: str) -> list[str]:
    """静态扫描。**不是安全边界**，是记账与告警 —— 真正的边界是隔离层。

    静态扫描原理上就绕得过去（``__import__('so'+'cket')`` 之类），所以它的定位
    是"发现明显的越界尝试并留痕"，不是"保证代码安全"。
    """
    low = code.lower()
    hits = [name for name, pats in SUSPICIOUS if any(p.lower() in low for p in pats)]

    imported = {m.group(1).split(".")[0].lower() for m in _IMPORT.finditer(code)}
    for kind, mods in _RISKY_MODULES.items():
        if imported & set(mods) or any(f"{m}." in low for m in mods):
            hits.append(kind)
    return list(dict.fromkeys(hits))


# ══════════════════════════════════════════════════════════════════
#  接口
# ══════════════════════════════════════════════════════════════════
class SandboxExecutor(ABC):
    """执行一段 Python，返回结构化结果。

    约定（三种实现一致）：

    * ``/in``  只读挂载调用方给的输入文件
    * ``/out`` 可写，执行完只有这里的东西能带出来
    * 代码把结构化结果写到 ``/out/result.json``，由 ``result`` 字段返回
    """

    name = "abstract"
    isolation = "none"

    def __init__(self, limits: SandboxLimits | None = None, *, block_suspicious: bool = False):
        self.limits = limits or SandboxLimits()
        self.block_suspicious = block_suspicious

    @abstractmethod
    async def _run(self, workdir: Path, code_file: Path) -> ExecResult: ...

    async def exec(
        self, code: str, *, inputs: dict[str, Any] | None = None,
        files: dict[str, Path] | None = None,
    ) -> ExecResult:
        """执行代码。

        Args:
            inputs: 会以 ``INPUTS`` 全局变量注入（已 JSON 化）。
            files: ``{沙箱内文件名: 宿主路径}``，只读拷进 ``/in``。
        """
        flags = scan(code)
        if flags and self.block_suspicious:
            raise SandboxError(f"代码命中可疑模式 {flags}，已按策略拒绝执行")

        work = Path(tempfile.mkdtemp(prefix="oc-sbx-"))
        try:
            (work / "in").mkdir()
            (work / "out").mkdir()
            for name, src in (files or {}).items():
                shutil.copy2(src, work / "in" / Path(name).name)
            (work / "in" / "inputs.json").write_text(
                json.dumps(inputs or {}, ensure_ascii=False, default=str), encoding="utf-8")

            code_file = work / "main.py"
            code_file.write_text(_PREAMBLE + code, encoding="utf-8")

            res = await self._run(work, code_file)
            res.flags = flags
            res.artifacts = {
                p.name: p.stat().st_size for p in (work / "out").iterdir() if p.is_file()
            }
            rp = work / "out" / "result.json"
            if rp.exists():
                try:
                    res.result = json.loads(rp.read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    res.stderr += f"\n[sandbox] /out/result.json 不是合法 JSON: {exc}"
            return res
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def describe(self) -> dict[str, Any]:
        """部署时看这个。**隔离强度必须可见** —— 把开发用沙箱当生产用是灾难。"""
        return {
            "name": self.name, "isolation": self.isolation,
            "production_safe": self.isolation in ("gvisor", "microvm"),
            "limits": {
                "cpu_s": self.limits.cpu_seconds, "wall_s": self.limits.wallclock_seconds,
                "mem_mb": self.limits.memory_mb, "network": self.limits.network,
            },
        }


#: 注入到每段代码前面。给出 INPUTS / IN_DIR / OUT_DIR / emit()，
#: 省得模型每次自己拼路径 —— 拼错了就是一次白跑。
_PREAMBLE = '''\
import json, os, sys, pathlib
IN_DIR  = pathlib.Path("/in") if pathlib.Path("/in").exists() else pathlib.Path("in")
OUT_DIR = pathlib.Path("/out") if pathlib.Path("/out").exists() else pathlib.Path("out")
OUT_DIR.mkdir(parents=True, exist_ok=True)
INPUTS = json.loads((IN_DIR / "inputs.json").read_text(encoding="utf-8"))

def emit(obj):
    """把结构化结果交回宿主。只有 /out 里的东西能带出去。"""
    (OUT_DIR / "result.json").write_text(
        json.dumps(obj, ensure_ascii=False, default=str), encoding="utf-8")

# ---- 以下是生成的代码 ----
'''


# ══════════════════════════════════════════════════════════════════
#  本地子进程（仅开发）
# ══════════════════════════════════════════════════════════════════
class LocalSubprocessSandbox(SandboxExecutor):
    """独立进程 + 资源上限 + 目录限定 + 环境清洗。

    .. warning::
       **无内核隔离。** 挡得住失控循环、内存爆炸、误删宿主文件；挡不住蓄意提权
       或逃逸。只用于本地开发和 CI。
    """

    name = "local-subprocess"
    isolation = "process"

    async def _run(self, workdir: Path, code_file: Path) -> ExecResult:
        import time

        env = {k: v for k, v in os.environ.items() if k in ENV_ALLOWLIST}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["TMPDIR"] = str(workdir / "out")

        t0 = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-S", str(code_file),
            cwd=workdir, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            preexec_fn=self._limits_fn() if os.name == "posix" else None,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(), timeout=self.limits.wallclock_seconds)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return ExecResult(
                ok=False, exit_code=None,
                stderr=f"[sandbox] 超过墙钟上限 {self.limits.wallclock_seconds}s，已终止",
                duration_ms=int((time.monotonic() - t0) * 1000))

        cap = self.limits.max_output_bytes
        return ExecResult(
            ok=proc.returncode == 0,
            stdout=out[:cap].decode("utf-8", "replace"),
            stderr=err[:cap].decode("utf-8", "replace"),
            exit_code=proc.returncode,
            duration_ms=int((time.monotonic() - t0) * 1000))

    def _limits_fn(self):
        limits = self.limits

        def apply() -> None:  # 在子进程里、exec 之前执行
            import resource

            resource.setrlimit(resource.RLIMIT_CPU,
                               (limits.cpu_seconds, limits.cpu_seconds))
            mem = limits.memory_mb * 1024 * 1024
            for res in ("RLIMIT_AS", "RLIMIT_DATA"):
                if hasattr(resource, res):
                    try:
                        resource.setrlimit(getattr(resource, res), (mem, mem))
                    except (ValueError, OSError):
                        pass  # macOS 上 RLIMIT_AS 常被忽略，不是致命问题
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
            resource.setrlimit(resource.RLIMIT_FSIZE,
                               (limits.max_out_dir_mb * 1024 * 1024,) * 2)
            os.setsid()  # 独立进程组，超时能连子孙一起杀干净

        return apply


# ══════════════════════════════════════════════════════════════════
#  容器化（生产）
# ══════════════════════════════════════════════════════════════════
class ContainerSandbox(SandboxExecutor):
    """通过外部运行时执行。gVisor / Firecracker 的共同实现。

    Args:
        runtime: 传给 ``docker --runtime`` 的值（``runsc`` / ``kata-runtime``）。
        image: 执行镜像。应当是最小镜像 + 数据处理库，不带 shell 工具。
    """

    def __init__(
        self, *, runtime: str, image: str = "ontocopilot/sandbox:py312",
        isolation: str = "gvisor", docker: str = "docker",
        limits: SandboxLimits | None = None, block_suspicious: bool = True,
    ) -> None:
        super().__init__(limits, block_suspicious=block_suspicious)
        self.runtime = runtime
        self.image = image
        self.isolation = isolation
        self.docker = docker
        self.name = f"container:{runtime}"

    def command(self, workdir: Path) -> list[str]:
        """构造运行命令。单独拆出来是为了可测 —— 隔离参数写错了不会有报错，
        只会静默变得不安全，所以必须能断言。"""
        l = self.limits
        cmd = [
            self.docker, "run", "--rm",
            "--runtime", self.runtime,
            "--network", "bridge" if l.network else "none",
            "--memory", f"{l.memory_mb}m",
            "--memory-swap", f"{l.memory_mb}m",  # 禁用 swap，否则内存限制形同虚设
            "--cpus", "2",
            "--pids-limit", "128",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",                                    # 根文件系统只读
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
            "-v", f"{workdir / 'in'}:/in:ro",                  # 输入只读
            "-v", f"{workdir / 'out'}:/out:rw",
            "-v", f"{workdir / 'main.py'}:/main.py:ro",
            "-w", "/out",
            "--user", "65534:65534",                           # nobody
            self.image,
            "python", "-I", "-S", "/main.py",
        ]
        return cmd

    async def _run(self, workdir: Path, code_file: Path) -> ExecResult:
        import time

        if shutil.which(self.docker) is None:
            raise SandboxError(
                f"找不到 {self.docker}。生产环境必须用容器沙箱；本地开发请显式"
                "换成 LocalSubprocessSandbox 并知悉它没有内核隔离。")

        t0 = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *self.command(workdir),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(), timeout=self.limits.wallclock_seconds + 20)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return ExecResult(ok=False, stderr="[sandbox] 容器超时，已终止",
                              duration_ms=int((time.monotonic() - t0) * 1000))

        cap = self.limits.max_output_bytes
        return ExecResult(
            ok=proc.returncode == 0,
            stdout=out[:cap].decode("utf-8", "replace"),
            stderr=err[:cap].decode("utf-8", "replace"),
            exit_code=proc.returncode,
            duration_ms=int((time.monotonic() - t0) * 1000))


def GVisorSandbox(**kw: Any) -> ContainerSandbox:
    """S1：常规数据处理（pandas / openpyxl）。启动快，用户态内核拦系统调用。"""
    return ContainerSandbox(runtime="runsc", isolation="gvisor", **kw)


def FirecrackerSandbox(**kw: Any) -> ContainerSandbox:
    """S2：未知来源二进制、扫描件 OCR。独立内核，隔离最强，启动慢。"""
    return ContainerSandbox(runtime="kata-runtime", isolation="microvm", **kw)


def default_sandbox(*, production: bool = False, **kw: Any) -> SandboxExecutor:
    """按环境选沙箱。**默认不给生产级隔离，必须显式要**。

    反过来（默认容器、找不到就悄悄降级到子进程）更危险 —— 部署时没人会注意到
    隔离已经没了。
    """
    return GVisorSandbox(**kw) if production else LocalSubprocessSandbox(**kw)
