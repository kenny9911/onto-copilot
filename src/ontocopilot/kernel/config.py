"""配置加载 —— 凭证只从环境读，绝不落进源码。

``.env`` 已在 ``.gitignore`` 里。这个模块做的是最小可用的 dotenv 解析，不引
python-dotenv：内核依赖越少越好，而且这里的语义（不覆盖已有环境变量）需要
显式控制。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path | str = ".env", *, override: bool = False) -> dict[str, str]:
    """读 ``.env`` 到环境变量。

    默认**不覆盖**已存在的环境变量 —— CI 里注入的凭证优先于开发机上的文件。
    """
    p = Path(path)
    if not p.exists():
        return {}
    loaded: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip("'\"")
        if override or k not in os.environ:
            os.environ[k] = v
        loaded[k] = v
    return loaded


@dataclass(frozen=True, slots=True)
class LLMConfig:
    base_url: str
    api_key: str

    @property
    def redacted_key(self) -> str:
        """打日志用。凭证永远不完整出现在日志、事件、异常里。"""
        k = self.api_key
        return f"{k[:6]}…{k[-4:]}" if len(k) > 12 else "…"

    @property
    def insecure_transport(self) -> bool:
        return self.base_url.startswith("http://")


def llm_config(*, dotenv: Path | str | None = ".env") -> LLMConfig:
    """从环境读取自定义网关配置。

    Raises:
        RuntimeError: 缺少必需变量时。**不静默降级到别的端点** —— 悄悄换成
            另一个模型服务比直接失败危险得多。
    """
    if dotenv is not None:
        load_dotenv(dotenv)
    base = os.environ.get("CUSTOM_LLM_BASE_URL", "").rstrip("/")
    key = os.environ.get("CUSTOM_LLM_API_KEY", "")
    missing = [n for n, v in (("CUSTOM_LLM_BASE_URL", base), ("CUSTOM_LLM_API_KEY", key)) if not v]
    if missing:
        raise RuntimeError(
            f"缺少环境变量 {missing}。把它们写进 .env（见 .env.example）或直接导出。"
        )
    return LLMConfig(base_url=base, api_key=key)
