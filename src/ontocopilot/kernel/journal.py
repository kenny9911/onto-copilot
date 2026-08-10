"""事件日志与 blob 存储的持久化。

两套实现：
  - InMemory* —— 测试与单机 demo。
  - File* —— 本地开发；jsonl 追加 + 内容寻址目录。

生产替换成 Postgres（事件元数据）+ S3（blob），接口不变。
"""

from __future__ import annotations

import json
import threading
from abc import ABC, abstractmethod
from collections.abc import Iterator
from pathlib import Path

from .events import Event
from .ids import content_ref


# ══════════════════════════════════════════════════════════════════
#  BlobStore
# ══════════════════════════════════════════════════════════════════
class BlobStore(ABC):
    """内容寻址存储。同样的内容写多次只占一份，天然幂等。"""

    @abstractmethod
    def put(self, data: bytes | str) -> str: ...

    @abstractmethod
    def get(self, ref: str) -> bytes: ...

    def put_json(self, obj: object) -> str:
        return self.put(json.dumps(obj, ensure_ascii=False, default=str))

    def get_json(self, ref: str) -> object:
        return json.loads(self.get(ref))


class InMemoryBlobStore(BlobStore):
    def __init__(self) -> None:
        self._d: dict[str, bytes] = {}
        self._lock = threading.Lock()

    def put(self, data: bytes | str) -> str:
        raw = data.encode("utf-8") if isinstance(data, str) else data
        ref = content_ref(raw)
        with self._lock:
            self._d.setdefault(ref, raw)
        return ref

    def get(self, ref: str) -> bytes:
        try:
            return self._d[ref]
        except KeyError:
            raise KeyError(f"blob 不存在: {ref}") from None

    def __len__(self) -> int:
        return len(self._d)


class FileBlobStore(BlobStore):
    """按 ref 前两位分桶，避免单目录文件数爆炸。"""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, ref: str) -> Path:
        digest = ref.split(":", 1)[-1]
        return self.root / digest[:2] / digest

    def put(self, data: bytes | str) -> str:
        raw = data.encode("utf-8") if isinstance(data, str) else data
        ref = content_ref(raw)
        p = self._path(ref)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")
            tmp.write_bytes(raw)
            tmp.replace(p)  # 原子落盘，避免半截文件
        return ref

    def get(self, ref: str) -> bytes:
        p = self._path(ref)
        if not p.exists():
            raise KeyError(f"blob 不存在: {ref}")
        return p.read_bytes()


# ══════════════════════════════════════════════════════════════════
#  Journal
# ══════════════════════════════════════════════════════════════════
class Journal(ABC):
    """append-only 事件日志。永不修改、永不删除 —— 审计要求。"""

    @abstractmethod
    def append(self, event: Event) -> None: ...

    @abstractmethod
    def read(self, run_id: str) -> Iterator[Event]: ...

    def last_seq(self, run_id: str) -> int:
        seq = -1
        for ev in self.read(run_id):
            seq = ev.seq
        return seq


class InMemoryJournal(Journal):
    def __init__(self) -> None:
        self._runs: dict[str, list[Event]] = {}
        self._lock = threading.Lock()

    def append(self, event: Event) -> None:
        with self._lock:
            self._runs.setdefault(event.run_id, []).append(event)

    def read(self, run_id: str) -> Iterator[Event]:
        # 拷一份再迭代：调用方常在遍历历史的同时继续追加新事件
        with self._lock:
            snapshot = list(self._runs.get(run_id, ()))
        yield from snapshot

    def last_seq(self, run_id: str) -> int:
        with self._lock:
            evs = self._runs.get(run_id)
            return evs[-1].seq if evs else -1


class FileJournal(Journal):
    """每个 Run 一个 jsonl 文件。"""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, run_id: str) -> Path:
        return self.root / f"{run_id}.jsonl"

    def append(self, event: Event) -> None:
        line = json.dumps(event.to_dict(), ensure_ascii=False) + "\n"
        with self._lock, self._path(event.run_id).open("a", encoding="utf-8") as f:
            f.write(line)
            f.flush()

    def read(self, run_id: str) -> Iterator[Event]:
        p = self._path(run_id)
        if not p.exists():
            return
        with p.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield Event.from_dict(json.loads(line))
