"""导出 server 段 F+G（推荐问题 / 产物与溯源）的 golden。

钉住的是**下载这件事的字节形态**：Content-Type 与 Content-Disposition。
这两个头写错不会报错、不会有测试变红 —— 只会让 FDE 存下来的文件叫
``download.zip``、或者中文包名变成一串乱码，而他多半只会觉得"这软件真难用"。

FileResponse 那一档是 Starlette 自己拼的（``artifact`` / ``export_download``
两条路都直接返回 FileResponse），所以从 Starlette 真实构造一次再读回头部，
而不是照着文档抄一遍。media_type 同理：``mimetypes.guess_type`` 在 macOS 上会
读 ``/etc/apache2/mime.types``，``.xlsx``/``.mmd`` 的值就来自那里，
不是 Python 内置表 —— 抄内置表会得到 ``text/plain``。

字节确定：没有时间戳、没有随机数，重跑两次哈希一致。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from starlette.responses import FileResponse

from ontocopilot.onto import export as X
from ontocopilot.server import _content_disposition

OUT = Path(__file__).resolve().parents[2] / "golden" / "server.artifacts.json"

#: 会话目录里真实会出现的产物名 + 几个刻意刁钻的（中文、空格、无后缀）。
NAMES = [
    "oir.json",
    "flow.json",
    "ontology.package.json",
    "template.spec.json",
    "流程图.svg",
    "流程图_主干.svg",
    "流程图.mmd",
    "模板_v1.xlsx",
    "问题清单.xlsx",
    "交付说明.md",
    "交付包_测试 项目_s1.zip",
    "回传_x.xlsx",
    "data-objects.json",
    "README",
    "a b.txt",
    "报告.pdf",
    "x.csv",
    "x.docx",
    "x.bpmn",
    "x.jsonl",
]

FALLBACKS = ["", "download.zip", "bundle.zip"]

TITLES = [
    "清单",
    "对象/属性 一览",
    "  前后空格  ",
    "",
    "..",
    ".",
    "a" * 120,
    "含\\斜杠:冒号*星号?问号\"引号<>|竖线",
    "多   个   空格",
]

FORMATS = ["xlsx", "XLSX", " .csv", "excel", "表格", "word", "文档", "md",
           "markdown", "文本", "txt", "pdf", "docx", "zip", "", "xls",
           "spreadsheet", "doc"]


def _file_response(name: str) -> dict[str, Any]:
    """``FileResponse(p, filename=p.name)`` 实际发出去的两个头。

    路径给一个不存在的文件也没关系：这两个头只由 filename 决定，
    Starlette 是在 ``__init__`` 里就拼好的（stat 头才需要真文件）。
    """
    r = FileResponse("/nonexistent/" + name, filename=name)
    return {"media_type": r.media_type,
            "content_disposition": r.headers.get("content-disposition", "")}


def main() -> None:
    data: dict[str, Any] = {
        # ``_content_disposition``：ASCII 兜底按真实后缀生成 + RFC 5987 filename*
        "content_disposition": [
            {"name": n, "ascii_fallback": f,
             "out": _content_disposition(n, ascii_fallback=f)}
            for n in NAMES for f in FALLBACKS
        ],
        # ``artifact`` / ``export_download`` 走 FileResponse，头由 Starlette 拼
        "file_response": [{"name": n, **_file_response(n)} for n in NAMES],
        # ``export_table`` 的格式解析与落地文件名
        "resolve_format": [{"fmt": f, "out": X.resolve_format(f)} for f in FORMATS],
        "spec": {k: {"ext": s.ext, "media_type": s.media_type, "label": s.label}
                 for k, s in X.SPECS.items()},
        "formats": list(X.FORMATS),
        "safe_name": [{"title": t, "ext": e, "out": X.safe_name(t, e)}
                      for t in TITLES for e in ("xlsx", "md")],
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2,
                              sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
