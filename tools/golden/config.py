"""kernel/config 的 golden —— 主导出器没覆盖这个模块，这份是它的全部真相。

config.py 只有 50 行，看着"没什么可测的"，可它每一行都踩在 Python 与 JS 语义
不等价的地方上，而且踩的都是**静默**分叉（不报错，只是行为悄悄不同）：

  - ``line.strip()`` —— Python 的 ``str.isspace()`` 有 29 个字符，比 JS ``trim()``
    多 ``\\x1c-\\x1f`` 和 ``\\x85``，少 ``\\ufeff``。**BOM 那条会咬人**：Windows
    编辑器存出来的 ``.env``，Python 侧第一个键叫 ``\\ufeffCUSTOM_LLM_BASE_URL``
    （于是"变量没配"直接抛），JS 侧 ``trim()`` 顺手把 BOM 吃掉就成功了 ——
    TS 端"更宽容"意味着两边跑同一份文件得到不同结论。
  - ``splitlines()`` —— 切 10 种分隔符（含 ``\\x0b \\x0c \\x1c \\x1d \\x1e \\x85``
    ``\\u2028 \\u2029``），不是 ``split(/\\r\\n|\\r|\\n/)``。
  - ``v.strip("'\\"")`` —— 是**字符集**剥离不是"配对去引号"：``'\\"\\"\\"'`` → 空串，
    ``'\\"z'`` → ``z``。而且它在 ``.strip()`` **之后**，所以引号**里面**的空格留着。
  - ``os.environ[""] = v`` —— CPython 抛 ``OSError [Errno 22]``；Node 的
    ``process.env[""] = v`` 静默什么也不做。一行 ``=value`` 在 Python 侧会让
    server.py:290 的 ``load_dotenv()`` 把整个服务端启动打挂。
  - ``k not in os.environ`` —— ``process.env`` 有原型链，``"toString" in process.env``
    是 **true**，照抄 ``in`` 会让 ``toString=x`` 这行被当成"环境里已经有了"跳过。
  - ``len(k)`` / ``k[:6]`` —— Python 数 code point，JS ``.length`` 数 UTF-16 码元。
    emoji 密钥上 ``redacted_key`` 的分支判断直接反过来。
  - ``base.rstrip("/")`` —— 剥**全部**尾斜杠，``"///"`` → ``""`` → 于是"缺变量"。

导出 ``golden/config.json``。**新文件，不碰主导出器**。字节确定：环境在每个用例
前被清空成声明的 ``pre_env``，临时 ``.env`` 的路径不入 golden，键排序固定。

    .venv/bin/python tools/golden/config.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

from ontocopilot.kernel.config import LLMConfig, llm_config, load_dotenv  # noqa: E402

OUT = Path(__file__).resolve().parent.parent.parent / "golden"

_TMP = Path(tempfile.mkdtemp(prefix="golden-config-"))


@contextmanager
def clean_env(pre: dict[str, str]) -> Iterator[None]:
    """把进程环境整个换成 ``pre``，退出时还原。

    整个清空（而不是只 setenv 几个）是为了让 ``env_after`` 能原样入 golden ——
    否则 PATH 之类的机器相关变量会混进去，导出就不是字节确定的了。
    """
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(pre)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def _err(e: BaseException) -> dict[str, Any]:
    return {"type": type(e).__name__, "message": str(e)}


# ══════════════════════════════════════════════════════════════════
#  load_dotenv
# ══════════════════════════════════════════════════════════════════
def dotenv_case(
    name: str,
    raw: bytes,
    *,
    pre_env: dict[str, str] | None = None,
    override: bool = False,
    exists: bool = True,
) -> dict[str, Any]:
    pre = dict(pre_env or {})
    row: dict[str, Any] = {
        "name": name,
        # 文件按**字节**入 golden：BOM、非法 UTF-8、\x0b 这类分隔符用十六进制才
        # 说得清楚，TS 侧照着 hex 写文件才能拿到同一份输入。
        "content_hex": raw.hex(),
        "exists": exists,
        "pre_env": dict(sorted(pre.items())),
        "override": override,
    }
    if exists:
        p = _TMP / f"{name}.env"
        p.write_bytes(raw)
    else:
        p = _TMP / f"{name}-does-not-exist.env"

    with clean_env(pre):
        try:
            loaded = load_dotenv(p, override=override)
        except BaseException as e:  # noqa: BLE001 —— 就是要把抛什么钉住
            row["raises"] = _err(e)
        else:
            # dict 的**插入序**是语义的一部分（重复键谁在后面），所以存成 pair 列表
            row["loaded"] = [[k, v] for k, v in loaded.items()]
        # 环境已被清成 pre_env，所以这里就是完整环境，可以原样入 golden
        row["env_after"] = dict(sorted(os.environ.items()))
    return row


def load_dotenv_cases() -> list[dict[str, Any]]:
    u = lambda s: s.encode("utf-8")  # noqa: E731
    return [
        dotenv_case("basic", u("A=1\nB=2\n")),
        dotenv_case("no_file", b"", exists=False),
        dotenv_case("empty_file", b""),
        # 注释 / 空行 / 没有 = 的行全跳过；注意 "  " 那行 strip 后为空
        dotenv_case("skips", u("# 注释\n\n  \nNOPE\n#A=9\nA=1\n")),
        # 键值两侧空白：先整行 strip，再各自 strip
        dotenv_case("spaces_around", u("  A  =  1  \n")),
        # 引号是**字符集**剥离，不是配对去引号
        dotenv_case(
            "quotes",
            u("A=\"  x  \"\nB='y'\nC=\"z\nD=\"\"\"\nE='\"mix\"'\nF=\"'\"\nG=''\n"),
        ),
        # partition 只切第一个 =
        dotenv_case("first_eq_wins", u("A=B=C\nURL=http://h/v1?a=b\n")),
        # 没有行内注释这回事：# 后面的东西属于值
        dotenv_case("hash_in_value", u("A=1 # 这不是注释\n")),
        # 空值合法
        dotenv_case("empty_value", u("A=\nB=  \nC=\"\"\n")),
        # 重复键：loaded 后写覆盖，环境**前写生效** —— 两者会不一致
        dotenv_case("dup_key", u("A=1\nA=2\n")),
        dotenv_case("dup_key_override", u("A=1\nA=2\n"), override=True),
        # 环境里已有 → 默认不覆盖（CI 注入的凭证优先于开发机的文件）
        dotenv_case("preexisting", u("A=file\n"), pre_env={"A": "env"}),
        dotenv_case("preexisting_override", u("A=file\n"), pre_env={"A": "env"}, override=True),
        # 空字符串的已有值也算"已存在"（`in` 判的是键不是真值）
        dotenv_case("preexisting_empty", u("A=file\n"), pre_env={"A": ""}),
        # ── 分叉重灾区 ──────────────────────────────────────────────
        # BOM：Python 的 strip 不吃 ﻿，键名带着它；JS 的 trim 会吃掉
        dotenv_case("bom", b"\xef\xbb\xbfA=1\nB=2\n"),
        dotenv_case("crlf", b"A=1\r\nB=2\r\n"),
        dotenv_case("cr_only", b"A=1\rB=2\r"),
        dotenv_case("no_trailing_newline", u("A=1\nB=2")),
        # splitlines 的"额外"分隔符：\x0b \x0c \x1c \x1d \x1e \x85
        dotenv_case("vt_ff_splits", u("A=1\x0bB=2\x0cC=3\n")),
        dotenv_case("fs_gs_rs_splits", u("A=1\x1cB=2\x1dC=3\x1eD=4\n")),
        dotenv_case("nel_splits", u("A=1\x85B=2\n")),
        dotenv_case("line_sep_splits", u("A=1 B=2 C=3\n")),
        # \x1f 是 isspace 但**不是** splitlines 分隔符 → 同一行，被 strip 掉
        dotenv_case("us_is_space_not_sep", u("\x1fA=1\x1f\nB=2\n")),
        # \xa0 / 　 两边都算空白
        dotenv_case("nbsp_ideographic", u("\xa0A=1\xa0\n　B=2　\n")),
        # 键里的怪东西：process.env 有原型链，"toString" 会被 `in` 误判成已存在
        dotenv_case("proto_keys", u("toString=1\nconstructor=2\n__proto__=3\nhasOwnProperty=4\n")),
        # 键含空格：setenv 允许（只有 = 和空名不行）
        dotenv_case("key_with_space", u("A B=c\n")),
        # 空键 → CPython OSError；Node 的 process.env[""] 是静默 no-op
        dotenv_case("empty_key", u("=v\n")),
        # 抛之前已经写进环境的**不回滚**（照抄逐行边解析边 setenv）
        dotenv_case("empty_key_after_good_line", u("A=1\n=v\nB=2\n")),
        # 键含 NUL：Python ValueError，Node 直接接受
        dotenv_case("nul_in_key", b"A\x00B=1\n"),
        # 非法 UTF-8 → Python UnicodeDecodeError；Node 默认会替换成 U+FFFD
        dotenv_case("invalid_utf8", b"A=\xff\xfe\n"),
        # 值里的非 ASCII 原样保留
        dotenv_case("cjk_value", u("NAME=采购订单头\nEMOJI=🔑\n")),
    ]


# ══════════════════════════════════════════════════════════════════
#  LLMConfig 的两个 property
# ══════════════════════════════════════════════════════════════════
def redacted_cases() -> list[dict[str, Any]]:
    keys = [
        "",
        "…",
        "sk-1",
        "sk-abcdef12",          # len 11
        "sk-abcdef123",         # len 12 —— 分支边界（`> 12` 为假），返回裸 "…"
        "sk-abcdef1234",        # len 13 —— 刚好开始脱敏，只藏住 3 个字符
        "sk-proj-AbCdEf0123456789xyz",
        "0123456789012",
        # code point vs UTF-16 码元：13 个汉字，Python len=13（脱敏），
        # JS .length 也是 13（BMP 内一致）—— 这条是对照组
        "密钥密钥密钥密钥密钥密钥密",
        # 13 个 emoji：Python len=13 → 脱敏；JS .length=26，
        # 且 k[:6] 会切出 3 个 emoji 而不是 6 个
        "🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑",
        # 12 个 emoji：Python len=12 → **不**脱敏（返回 "…"），
        # JS .length=24 > 12 会走错分支
        "🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑",
        # 混合宽度，尾 4 个 code point 里含代理对
        "sk-abcdefgh🔑🔑🔑🔑",
        # 组合字符（分解形 e + U+0301）：Python 按 code point 切，会把基字符和
        # 组合符切开 —— 截断结果不是"看起来的前 6 个字"
        "é" * 7,
    ]
    return [{"api_key": k, "len": len(k), "out": LLMConfig(base_url="x", api_key=k).redacted_key}
            for k in keys]


def insecure_cases() -> list[dict[str, Any]]:
    urls = [
        "http://a:3010/v1",
        "https://a/v1",
        "HTTP://a/v1",          # startswith 区分大小写 → False
        "Http://a/v1",
        "",
        " http://a/v1",         # 前导空格 → False
        "http:/a",
        "httpx://a",
        "http://",
    ]
    return [{"base_url": u, "out": LLMConfig(base_url=u, api_key="k").insecure_transport}
            for u in urls]


# ══════════════════════════════════════════════════════════════════
#  llm_config
# ══════════════════════════════════════════════════════════════════
def llm_case(
    name: str,
    pre_env: dict[str, str],
    *,
    dotenv_raw: bytes | None = None,
    use_dotenv: bool = True,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "name": name,
        "pre_env": dict(sorted(pre_env.items())),
        "dotenv_hex": None if dotenv_raw is None else dotenv_raw.hex(),
        "use_dotenv": use_dotenv,
    }
    if dotenv_raw is not None:
        p = _TMP / f"llm-{name}.env"
        p.write_bytes(dotenv_raw)
    else:
        p = _TMP / f"llm-{name}-absent.env"

    with clean_env(pre_env):
        try:
            cfg = llm_config(dotenv=p if use_dotenv else None)
        except BaseException as e:  # noqa: BLE001
            row["raises"] = _err(e)
        else:
            row["out"] = {"base_url": cfg.base_url, "api_key": cfg.api_key}
        row["env_after"] = dict(sorted(os.environ.items()))
    return row


BASE = "CUSTOM_LLM_BASE_URL"
KEY = "CUSTOM_LLM_API_KEY"


def llm_config_cases() -> list[dict[str, Any]]:
    return [
        llm_case("ok", {BASE: "http://gw:3010/v1", KEY: "sk-live"}, use_dotenv=False),
        # rstrip("/") 剥掉**全部**尾斜杠
        llm_case("strips_all_slashes", {BASE: "http://gw:3010/v1///", KEY: "sk"}, use_dotenv=False),
        # 只剥尾部，不动中间
        llm_case("keeps_inner_slashes", {BASE: "http://gw//v1/", KEY: "sk"}, use_dotenv=False),
        # 全是斜杠 → 剥成空 → 于是"缺变量"
        llm_case("all_slashes_becomes_missing", {BASE: "///", KEY: "sk"}, use_dotenv=False),
        # 纯空白**不是**空 —— Python 不 strip base_url，"   " 是真值，照过
        llm_case("blank_is_truthy", {BASE: "   ", KEY: "sk"}, use_dotenv=False),
        llm_case("missing_both", {}, use_dotenv=False),
        llm_case("missing_key", {BASE: "http://gw/v1"}, use_dotenv=False),
        llm_case("missing_base", {KEY: "sk"}, use_dotenv=False),
        # 空串等同于没配
        llm_case("empty_strings", {BASE: "", KEY: ""}, use_dotenv=False),
        # dotenv=None：不读文件（文件存在也不读）
        llm_case("dotenv_none_skips_file",
                 {}, dotenv_raw=b"CUSTOM_LLM_BASE_URL=http://f/v1\nCUSTOM_LLM_API_KEY=sk-f\n",
                 use_dotenv=False),
        # 走文件
        llm_case("from_dotenv",
                 {}, dotenv_raw=b"CUSTOM_LLM_BASE_URL=http://f/v1/\nCUSTOM_LLM_API_KEY=sk-f\n"),
        # 环境已有 → 文件不覆盖（override=False）
        llm_case("env_wins_over_dotenv",
                 {BASE: "http://env/v1", KEY: "sk-env"},
                 dotenv_raw=b"CUSTOM_LLM_BASE_URL=http://f/v1\nCUSTOM_LLM_API_KEY=sk-f\n"),
        # 文件不存在 → load_dotenv 返回 {}，接着照常读环境
        llm_case("dotenv_absent", {BASE: "http://gw/v1", KEY: "sk"}),
        # BOM 的 .env：键名带 ﻿，于是环境里其实什么都没设 → 抛
        llm_case("bom_dotenv_still_missing",
                 {}, dotenv_raw=b"\xef\xbb\xbfCUSTOM_LLM_BASE_URL=http://f/v1\n"
                                b"CUSTOM_LLM_API_KEY=sk-f\n"),
    ]


# ══════════════════════════════════════════════════════════════════
#  被移植的 Python 原语（TS 侧要自己实现，单独钉）
# ══════════════════════════════════════════════════════════════════
def primitives() -> dict[str, Any]:
    space = [i for i in range(0x110000) if chr(i).isspace()]
    seps = [i for i in range(0x110000) if len((chr(i) + "A").splitlines()) > 1]

    strip_in = [
        "", "  x  ", "\tx\n", "\x1cx\x1d", "\x1fx\x1f", "\x85x\x85",
        "﻿x﻿", "\xa0x\xa0", "　x　", " x ",
        "​x​", "᠎x᠎", "   ", "\x0bx\x0c", "x", "﻿",
    ]
    quote_in = [
        "", "'y'", '"y"', '"""', "'''", "\"'x'\"", '"z', "z'", "'\"mix\"'",
        "''", '""', "'", '"', "  x  ", "\"  x  \"", "a'b", "x\"", "\"'\"",
    ]
    split_in = [
        "", "a", "a\n", "a\nb", "a\r\nb", "a\rb", "a\r\r\nb", "a\n\nb",
        "a\x0bb", "a\x0cb", "a\x1cb", "a\x1db", "a\x1eb", "a\x1fb",
        "a\x85b", "a b", "a b", "\n", "\n\n", "a\r\n",
    ]
    return {
        "isspace_codepoints": space,
        "splitlines_separator_codepoints": seps,
        "strip": [{"in": s, "out": s.strip()} for s in strip_in],
        "strip_quotes": [{"in": s, "out": s.strip("'\"")} for s in quote_in],
        # 真实调用顺序：先 strip() 再 strip("'\"")
        "strip_then_quotes": [{"in": s, "out": s.strip().strip("'\"")} for s in quote_in],
        "splitlines": [{"in": s, "out": s.splitlines()} for s in split_in],
        "rstrip_slash": [{"in": s, "out": s.rstrip("/")} for s in
                         ["", "/", "///", "http://a", "http://a/", "http://a///",
                          "http://a//b//", "a/b", "//", "http://"]],
        # 错误消息里的 {missing} 是 str(list)，元素走 repr（errors.ts 的 pyRepr）
        "missing_list_repr": [{"in": v, "out": str(v)} for v in
                              [[], ["CUSTOM_LLM_BASE_URL"], ["CUSTOM_LLM_API_KEY"],
                               ["CUSTOM_LLM_BASE_URL", "CUSTOM_LLM_API_KEY"]]],
    }


def main() -> None:
    out: dict[str, Any] = {
        "load_dotenv": load_dotenv_cases(),
        "redacted_key": redacted_cases(),
        "insecure_transport": insecure_cases(),
        "llm_config": llm_config_cases(),
        "primitives": primitives(),
    }
    p = OUT / "config.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.rmtree(_TMP, ignore_errors=True)
    print(f"  config.json  {p.stat().st_size} B")


if __name__ == "__main__":
    main()
