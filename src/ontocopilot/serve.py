"""服务启动器 —— 前后端同进程。

前端是纯静态页面，由后端在 ``/`` 直接吐出来，**不单开一个前端服务器**：
多一个进程就多一份 CORS、端口、部署配置要对齐，而这个 UI 没有构建步骤，
分开跑没有任何好处。
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ontocopilot-server", description="启动 OntoCopilot 服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true", help="改代码自动重启（开发用）")
    args = ap.parse_args(argv)

    import uvicorn

    print(f"  界面  http://{args.host}:{args.port}/")
    print(f"  API   http://{args.host}:{args.port}/docs")
    uvicorn.run("ontocopilot.server:app", host=args.host, port=args.port,
                reload=args.reload, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
