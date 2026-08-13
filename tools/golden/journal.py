"""导出 kernel/journal.py 的 golden —— 落盘的**确切字节**。

这个模块几乎没有逻辑，全部价值在字节上，而且是最容易被"看起来一样"骗过去的那种：

1. `FileJournal.append` 写的是 ``json.dumps(ev.to_dict(), ensure_ascii=False)``：
   **不排序、默认分隔符 ", " / ": "**。既不是 golden/events.json 里的 line
   （那是 sort_keys + separators=(",",":")），也不是 JS 的 JSON.stringify（紧凑）。
   写错了不会报错，只会让 Python 时代的 .jsonl 和 TS 时代的对不上。
2. `BlobStore.put_json` 用同一套分隔符，而 blob 的 **ref 是内容哈希** ——
   多一个空格，ref 就全变，历史 blob 一个都找不回来。
3. float 的 repr 边界：Python 在 ``exp < -4 or exp >= 16`` 时转指数记号且指数补两位
   （``1e-05``），JS 的 String() 在 ``< 1e-6`` 才转且不补位（``0.00001`` / ``1e-7``）。
   usd 成本这种量级（1.2e-5）正好落在分叉区间里，所以单独导一组字面量向量。

字节确定：无时间戳（ts_ms 全部写死）、无随机、无 set 迭代。重跑两次 shasum 一致。

**这一份 golden 不能 sort_keys** —— 别的导出器都加了，这里加就等于把要测的东西
（payload 的插入顺序）先抹掉再去测它。确定性由"全部字面量、无 set 迭代"保证，
不靠排序。
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "src"))

from ontocopilot.kernel.events import Event, EventKind  # noqa: E402
from ontocopilot.kernel.ids import content_ref  # noqa: E402
from ontocopilot.kernel.journal import FileBlobStore, FileJournal  # noqa: E402

TS = 1_723_000_000_000  # 写死的墙钟，保证导出确定

# float 字面量向量。用**字符串**携带而不是 JSON number：JSON 表达不出
# "这是个 float 不是 int"，而整数值的 float（1.0）恰好是 TS 侧无解的那条分叉。
# float(lit) 与 JS Number(lit) 都是正确舍入的十进制→double，两边拿到同一个 double。
_FLOATS = [
    "0.13", "1.5", "1234.5", "0.1", "0.0001", "1e-4", "1e-5", "1e-6", "1e-7",
    "1.5e-7", "2.5e-10", "5e-324", "1e15", "9999999999999998.0", "-0.5",
    "3.141592653589793", "1e16", "1e21", "1e22", "1.7976931348623157e308",
    "1.2345678901234568e20", "0.30000000000000004", "1.0", "0.0", "-0.0", "100.0",
]

#: 值为整数的 float 在 JS 里与 int 无从区分 —— 分成两组，前一组 TS 必须逐字节相同，
#: 后一组是**已知分叉**，导出来给 TS 侧钉成用例（见契约 §3）。
_FLOATS_EXACT = [lit for lit in _FLOATS if not float(lit).is_integer()]
_FLOATS_DIVERGENT = [lit for lit in _FLOATS if float(lit).is_integer()]

# 事件向量。**payload 的键故意不按字典序**（mode 在 attempt 前）—— json.dumps
# 默认不排序，落盘顺序就是 dict 的插入顺序，这一条必须被钉住。
_EVENTS = [
    Event(run_id="r1", seq=0, kind=EventKind.RUN_STARTED, ts_ms=TS),
    Event(
        run_id="r1", seq=1, kind=EventKind.NODE_ENTERED, node_id="EXTRACT",
        payload={"mode": "plan_execute", "attempt": 1}, ts_ms=TS + 12,
    ),
    # node_id / ref 是空串：省略判据是 `is not None` 而不是真值性，两个字段都要写出来
    Event(run_id="r1", seq=2, kind=EventKind.NODE_SKIPPED, node_id="", ref="", ts_ms=TS + 20),
    # 非 ASCII 原样保留（ensure_ascii=False），控制字符/引号/反斜杠按 JSON 转义
    Event(
        run_id="r1", seq=3, kind=EventKind.THOUGHT, node_id="抽取#1",
        payload={
            "text": "他说\"好\"\n换行\t制表\\反斜杠",
            "emoji": "🐍",
            "nested": {"z": [1, "二", None, True, False], "empty_d": {}, "empty_l": []},
            "cost_usd": 1.2e-5,
            "ratio": 0.13,
            "neg": -7,
        },
        ts_ms=TS + 31,
    ),
    Event(
        run_id="r1", seq=4, kind=EventKind.EFFECT_COMPLETED, node_id="EXTRACT",
        payload={"key": "EXTRACT#0", "kind": "llm.call", "fp": "a1b2c3d4e5f60718"},
        ref="blob:3f2a1c0d5e6b7a8940123456789abcde", ts_ms=TS + 44,
    ),
    Event(run_id="r1", seq=5, kind=EventKind.RUN_COMPLETED, ts_ms=TS + 50),
]

# blob 输入：字符串（含非 ASCII / 空串）与真二进制（含非法 UTF-8 字节）
_BLOB_STRS = ["", "hello", "中文内容", "🐍" * 3, "line1\nline2\n", " 前后空格 "]
_BLOB_BYTES = [b"", b"\x00\x01\x02", b"\xff\xfe\xfd", bytes(range(256))]

# put_json 输入：blob 的 ref 由这些字节决定，分隔符错一个空格 ref 就全变
_JSON_VALUES = [
    {},
    [],
    {"a": 1, "b": [1, 2, 3]},
    {"中": "值", "列表": [{"x": None}, True]},
    {"nested": {"deep": {"deeper": [1, {"k": "v"}]}}},
    "裸字符串",
    [1, "二", None, True],
    {"cost": 1.2e-5, "ratio": 0.13},
]


def _line(ev: Event) -> str:
    """与 journal.py:144 逐字一致的落盘行（不含换行）。"""
    return json.dumps(ev.to_dict(), ensure_ascii=False)


def main() -> None:
    out: dict[str, object] = {}

    out["events"] = [{"dict": ev.to_dict(), "line": _line(ev)} for ev in _EVENTS]

    # 整个 run 的 jsonl 文件字节 + last_seq。seq 故意**乱序**（5 在 2 前面）——
    # last_seq 取的是"最后一条"而不是"最大的一条"，这个区别得钉死。
    unordered = [
        Event(run_id="r2", seq=5, kind=EventKind.RUN_STARTED, ts_ms=TS),
        Event(run_id="r2", seq=2, kind=EventKind.RUN_FAILED, ts_ms=TS + 1),
    ]
    out["jsonl"] = {
        "run_id": "r1",
        "file": "".join(_line(ev) + "\n" for ev in _EVENTS),
        "last_seq": _EVENTS[-1].seq,
        "unordered": {
            "file": "".join(_line(ev) + "\n" for ev in unordered),
            "last_seq": unordered[-1].seq,
            "dicts": [ev.to_dict() for ev in unordered],
        },
        "missing_run_last_seq": -1,
        "filename": "r1.jsonl",
    }

    # json.dumps(..., ensure_ascii=False) 的分隔符/形状（不带 default=str，
    # 与 FileJournal.append 同参数）
    out["dumps"] = [
        {"value": v, "out": json.dumps(v, ensure_ascii=False)} for v in _JSON_VALUES
    ]
    out["float_repr"] = [
        {"lit": lit, "out": json.dumps(float(lit), ensure_ascii=False)} for lit in _FLOATS_EXACT
    ]
    # 整数值的 float 与大整数 —— TS 侧无法区分 1 与 1.0，这两组是**已知分叉**，
    # 导出来是为了让 TS 侧把分叉钉成用例而不是绕过去。
    out["known_divergence"] = {
        "int_valued_float": [
            {"lit": lit, "python": json.dumps(float(lit), ensure_ascii=False)}
            for lit in _FLOATS_DIVERGENT
        ],
        "big_int": [
            {"lit": lit, "python": json.dumps(int(lit))}
            for lit in ["9007199254740993", "9223372036854775807", "10000000000000000000000000000000"]
        ],
        "non_finite": {
            "nan": json.dumps(float("nan")),
            "inf": json.dumps(float("inf")),
            "-inf": json.dumps(float("-inf")),
        },
    }

    # content_ref + FileBlobStore 的分桶路径
    out["blobs"] = {
        "strings": [
            {"in": s, "ref": content_ref(s), "path": _bucket(content_ref(s))}
            for s in _BLOB_STRS
        ],
        "bytes": [
            {
                "b64": base64.b64encode(b).decode("ascii"),
                "ref": content_ref(b),
                "path": _bucket(content_ref(b)),
            }
            for b in _BLOB_BYTES
        ],
        "put_json": [
            {
                "value": v,
                "bytes": json.dumps(v, ensure_ascii=False, default=str),
                "ref": content_ref(json.dumps(v, ensure_ascii=False, default=str)),
            }
            for v in _JSON_VALUES
        ],
        # _path 是 ref.split(":", 1)[-1] —— 多个冒号时只切第一个，没有冒号就是整串
        "path_edge": [
            {"ref": r, "path": _bucket(r)}
            for r in ["blob:abcdef0123", "abcdef0123", "sha256:aa:bb", "blob:ab"]
        ],
        "missing_message": "blob 不存在: blob:deadbeef",
    }

    # 真的落一次盘，确认上面推出来的路径与实现一致（自检，不进 golden）
    _selfcheck()

    dst = pathlib.Path(__file__).resolve().parents[2] / "golden" / "journal.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {dst}")


def _bucket(ref: str) -> str:
    digest = ref.split(":", 1)[-1]
    return f"{digest[:2]}/{digest}"


def _selfcheck() -> None:
    """拿真实现验一遍导出的假设，别让 golden 变成"我以为"。"""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td)
        j = FileJournal(root / "journal")
        for ev in _EVENTS:
            j.append(ev)
        got = (root / "journal" / "r1.jsonl").read_text(encoding="utf-8")
        assert got == "".join(_line(ev) + "\n" for ev in _EVENTS), "jsonl 字节与推导不一致"
        assert j.last_seq("r1") == _EVENTS[-1].seq
        assert j.last_seq("没有这个run") == -1
        assert [ev.to_dict() for ev in j.read("r1")] == [ev.to_dict() for ev in _EVENTS]

        b = FileBlobStore(root / "blobs")
        for s in _BLOB_STRS:
            ref = b.put(s)
            assert ref == content_ref(s)
            rel = (root / "blobs" / _bucket(ref)).relative_to(root / "blobs")
            assert rel.as_posix() == _bucket(ref)
            assert b.get(ref) == s.encode("utf-8")
        for v in _JSON_VALUES:
            ref = b.put_json(v)
            assert ref == content_ref(json.dumps(v, ensure_ascii=False, default=str))
            assert b.get_json(ref) == v


if __name__ == "__main__":
    main()
