"""导出 auth / authgate 的 golden —— Python 侧真跑出来的输入/输出对。

两类内容：

1. **Python 生成的口令散列**（`hashes`）。TS 侧必须能验过它们，否则老用户全部
   登不进来。散列里带随机盐，所以这一份**不是字节确定**的 —— 它记的是"某一次
   Python 真的产出过这些串"，重跑会换一批新盐但断言仍然成立。为了让 diff 不是
   噪声，已存在的文件**原样保留**，只有 `--regen` 才重写。
2. **纯函数的输入/输出对**（`normalize_username` / `token_hash` /
   `clean_display_name` / `_truthy`），这些是字节确定的。

用法::

    .venv/bin/python tools/golden/authgate.py [--regen]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ontocopilot.auth import (  # noqa: E402
    hash_password,
    normalize_username,
    token_hash,
)
from ontocopilot.authgate import _truthy, clean_display_name  # noqa: E402

OUT = ROOT / "golden" / "auth.json"

#: 口令样本。覆盖 ASCII、CJK、emoji、前后空白、超长 —— TS 侧的 UTF-8 编码
#: 与 Python 的 `password.encode("utf-8")` 必须逐字节相同。
PASSWORDS = [
    "correct horse battery staple",
    "a",
    "中文密码",
    "emoji🔑密码",
    "  前后有空格  ",
    "x" * 200,
    "包含$美元符号$的口令",
]

USERNAMES = ["  Alice  ", "BOB", "ＵＮＩＣＯＤＥ", "", "   ", "混合Case用户名", "已有\t制表符"]

TOKENS = ["", "abc", "中文令牌", "x" * 43]

DISPLAY_NAMES = [
    "程宇涵",
    "  张伟  （采购）  ",
    "多\n行\t名字",
    "",
    "   ",
    "a" * 40,
    " 　全角空白 包夹 ",
]

TRUTHY = ["", "0", "false", "FALSE", "no", "off", "1", "true", " yes ", "  ", "OFF", "n"]


def main() -> int:
    regen = "--regen" in sys.argv
    if OUT.exists() and not regen:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    else:
        data = {}

    # 带随机盐 ⇒ 只在缺失或显式 --regen 时重算。
    if "hashes" not in data or regen:
        data["hashes"] = [{"password": p, "encoded": hash_password(p)} for p in PASSWORDS]

    data["normalize_username"] = [{"raw": u, "out": normalize_username(u)} for u in USERNAMES]
    data["token_hash"] = [{"token": t, "out": token_hash(t)} for t in TOKENS]
    data["clean_display_name"] = [
        {"raw": n, "out": clean_display_name(n)} for n in DISPLAY_NAMES
    ]
    data["truthy"] = [{"raw": v, "out": _truthy(v)} for v in TRUTHY]
    # `_truthy(None)` 走的是 `bool(v)` 那一支 —— JSON 里用 null 表示。
    data["truthy"].append({"raw": None, "out": _truthy(None)})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
