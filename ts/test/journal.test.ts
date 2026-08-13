/**
 * journal 的 golden 校验 —— 这个模块的价值全在**落盘字节**上。
 *
 * 三样东西错一个字节，历史就读不回来，而且当场不报错：
 *   1. jsonl 一行 = `json.dumps(to_dict(), ensure_ascii=False)`（默认分隔符 ", " / ": "，不排序）；
 *   2. blob 的 ref = `json.dumps(obj, ensure_ascii=False, default=str)` 的内容哈希；
 *   3. FileBlobStore 的分桶路径。
 *
 * 另外两组用例针对的是**改成异步之后新长出来的风险**（Python 侧不存在，所以没有
 * golden 可抄）：append 后不 flush 直接 read 必须读得到；后台落盘失败必须能报出来，
 * 且**不能**变成 unhandledRejection 把进程带走。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventKind, eventFromDict, eventToDict, makeEvent, type Event } from "../src/kernel/events.js";
import { contentRef } from "../src/kernel/ids.js";
import {
  BlobNotFound,
  FileBlobStore,
  FileJournal,
  InMemoryBlobStore,
  InMemoryJournal,
  eventLine,
  pyJsonDumps,
} from "../src/kernel/journal.js";

interface Golden {
  events: { dict: Record<string, unknown>; line: string }[];
  jsonl: {
    run_id: string;
    file: string;
    last_seq: number;
    unordered: { file: string; last_seq: number; dicts: Record<string, unknown>[] };
    missing_run_last_seq: number;
    filename: string;
  };
  dumps: { value: unknown; out: string }[];
  float_repr: { lit: string; out: string }[];
  known_divergence: {
    int_valued_float: { lit: string; python: string }[];
    big_int: { lit: string; python: string }[];
    non_finite: Record<string, string>;
  };
  blobs: {
    strings: { in: string; ref: string; path: string }[];
    bytes: { b64: string; ref: string; path: string }[];
    put_json: { value: unknown; bytes: string; ref: string }[];
    path_edge: { ref: string; path: string }[];
    missing_message: string;
  };
}

const G: Golden = JSON.parse(
  readFileSync(join(__dirname, "../../golden/journal.json"), "utf8"),
) as Golden;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 收集后台落盘错误的 journal，别让默认的 stderr 上报污染测试输出。 */
function fileJournal(sub = "journal"): { j: FileJournal; errs: Error[] } {
  const errs: Error[] = [];
  const j = new FileJournal(join(dir, sub), { onError: (e) => errs.push(e) });
  return { j, errs };
}

// ══════════════════════════════════════════════════════════════════
describe("json.dumps 的字节形态（默认分隔符，不排序）", () => {
  it("golden 的每个值都逐字节一致", () => {
    for (const g of G.dumps) expect(pyJsonDumps(g.value)).toBe(g.out);
  });

  it("分隔符是 ', ' 与 ': '，不是 JSON.stringify 的紧凑形态", () => {
    const v = { a: 1, b: [1, 2] };
    expect(pyJsonDumps(v)).toBe('{"a": 1, "b": [1, 2]}');
    expect(pyJsonDumps(v)).not.toBe(JSON.stringify(v));
  });

  it("键不排序 —— 落盘顺序就是插入顺序", () => {
    expect(pyJsonDumps({ z: 1, a: 2 })).toBe('{"z": 1, "a": 2}');
  });

  it("非 ASCII 原样保留（ensure_ascii=False）", () => {
    expect(pyJsonDumps({ 中: "值🐍" })).toBe('{"中": "值🐍"}');
  });

  it("空容器不带空格", () => {
    expect(pyJsonDumps({})).toBe("{}");
    expect(pyJsonDumps([])).toBe("[]");
    expect(pyJsonDumps({ a: {}, b: [] })).toBe('{"a": {}, "b": []}');
  });

  it("float 的记号选择与 CPython repr 一致（String() 在这里是错的）", () => {
    for (const g of G.float_repr) expect(pyJsonDumps(Number(g.lit))).toBe(g.out);
    // 点名两个 String() 会给错的：JS 直到 1e-6 才转指数，且指数不补零
    expect(String(1e-5)).toBe("0.00001");
    expect(pyJsonDumps(1e-5)).toBe("1e-05");
    expect(String(1e-7)).toBe("1e-7");
    expect(pyJsonDumps(1e-7)).toBe("1e-07");
  });

  it("Map 当 dict 序列化，键按 Python 的规则转字符串", () => {
    expect(pyJsonDumps(new Map([["a", 1]]))).toBe('{"a": 1}');
    expect(pyJsonDumps(new Map<unknown, unknown>([[1, "x"], [true, "y"], [null, "z"]]))).toBe(
      '{"1": "x", "true": "y", "null": "z"}',
    );
  });

  it("undefined / 函数 / symbol：对象里整键消失，数组里变 null", () => {
    expect(pyJsonDumps({ a: 1, b: undefined, c: () => 0 })).toBe('{"a": 1}');
    expect(pyJsonDumps([1, undefined, 2])).toBe("[1, null, 2]");
    expect(() => pyJsonDumps(undefined)).toThrow();
  });

  it("循环引用抛错，不爆栈（append 在同步路径上，爆栈就是整个进程完蛋）", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => pyJsonDumps(a)).toThrow(/循环引用/);
    // 兄弟位置上的重复引用是合法的，别把它也当成环
    const shared = { x: 1 };
    expect(pyJsonDumps({ p: shared, q: shared })).toBe('{"p": {"x": 1}, "q": {"x": 1}}');
  });

  it("非纯数据对象没有 default 钩子时抛错，不静默写成 {}", () => {
    expect(() => pyJsonDumps(new Date(0))).toThrow();
    expect(pyJsonDumps(new Date(0), { defaultStr: true })).toBe(pyJsonDumps(String(new Date(0))));
  });

  it("NaN / Infinity 被拒绝 —— Python 会写出 JSON.parse 读不回来的裸字面量", () => {
    expect(G.known_divergence.non_finite["nan"]).toBe("NaN");
    expect(G.known_divergence.non_finite["inf"]).toBe("Infinity");
    expect(() => JSON.parse("NaN")).toThrow();
    for (const x of [NaN, Infinity, -Infinity]) expect(() => pyJsonDumps(x)).toThrow();
  });
});

describe("已知分叉（钉住形状，不绕过）", () => {
  it("值为整数的 float：记号不同，但表示的是同一个 double", () => {
    for (const g of G.known_divergence.int_valued_float) {
      const ts = pyJsonDumps(Number(g.lit));
      // 关键不变量：JSON 读回来还是同一个值，所以重放不受影响
      expect(Number(ts)).toBe(Number(g.python));
      expect(JSON.parse(ts)).toBe(JSON.parse(g.python.replace("Infinity", "1e999")));
    }
    // 具体形状：Python 认得 float，TS 认不得
    expect(pyJsonDumps(1.0)).toBe("1");
    expect(G.known_divergence.int_valued_float[0]!.lit).toBe("1e15");
    expect(G.known_divergence.int_valued_float[0]!.python).toBe("1000000000000000.0");
    expect(pyJsonDumps(1e15)).toBe("1000000000000000");
  });

  it("大整数：走 number 会在 2^53 处丢精度，走 bigint 与 Python int 逐字节一致", () => {
    for (const g of G.known_divergence.big_int) {
      expect(pyJsonDumps(BigInt(g.lit))).toBe(g.python); // bigint == Python 的任意精度 int
    }
    const lossy = G.known_divergence.big_int[0]!; // 9007199254740993 = 2^53+1
    expect(pyJsonDumps(Number(lossy.lit))).not.toBe(lossy.python);
    expect(pyJsonDumps(Number(lossy.lit))).toBe("9007199254740992");
  });
});

// ══════════════════════════════════════════════════════════════════
describe("事件行的字节（jsonl 的一行）", () => {
  for (const [i, g] of G.events.entries()) {
    it(`向量 ${i} —— ${String(g.dict["kind"])}`, () => {
      const ev = eventFromDict(g.dict);
      expect(eventLine(ev)).toBe(g.line);
      // 字段省略与键序也一并确认（它们决定了上面那行的形状）
      expect(Object.keys(eventToDict(ev))).toEqual(Object.keys(g.dict));
    });
  }

  it("与 JSON.stringify 确实不同 —— 别顺手换掉", () => {
    const ev = eventFromDict(G.events[1]!.dict);
    expect(JSON.stringify(eventToDict(ev))).not.toBe(eventLine(ev));
  });

  it("payload 不可序列化时当场抛在调用点，不拖到后台", () => {
    const bad = makeEvent({
      runId: "r",
      seq: 0,
      kind: EventKind.THOUGHT,
      payload: { x: NaN },
    });
    const { j } = fileJournal();
    expect(() => j.append(bad)).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
describe("FileJournal 落盘", () => {
  const events = (): Event[] => G.events.map((g) => eventFromDict(g.dict));

  it("flush 之后文件字节与 Python 写的完全一致", async () => {
    const { j, errs } = fileJournal();
    for (const ev of events()) j.append(ev);
    await j.flush();
    expect(errs).toEqual([]);
    expect(readFileSync(join(dir, "journal", G.jsonl.filename), "utf8")).toBe(G.jsonl.file);
  });

  it("文件名是 <run_id>.jsonl", () => {
    const { j } = fileJournal();
    expect(j.pathFor("r1")).toBe(join(dir, "journal", G.jsonl.filename));
  });

  it("读回来的事件与写进去的一致（Python 写的文件也读得动）", async () => {
    const { j } = fileJournal();
    writeFileSync(join(dir, "journal", "r1.jsonl"), G.jsonl.file, "utf8");
    expect([...j.read("r1")].map(eventToDict)).toEqual(G.events.map((g) => g.dict));
    await j.flush();
  });

  it("append 之后不 flush 也能立刻 read 到（异步落盘不许改变可见性）", async () => {
    const { j } = fileJournal();
    for (const ev of events()) j.append(ev);
    const before = [...j.read("r1")].map(eventToDict);
    await j.flush();
    const after = [...j.read("r1")].map(eventToDict);
    expect(before).toEqual(G.events.map((g) => g.dict));
    expect(after).toEqual(before); // flush 前后必须**完全**一样，不能多也不能少
  });

  it("落盘过程中读也不会读出重复（写完到 Promise resolve 之间有个可见窗口）", async () => {
    const { j } = fileJournal();
    for (const ev of events()) j.append(ev);
    const seen: number[] = [];
    // 在 drain 的各个阶段插进去读，每次都必须恰好是 6 条
    for (let i = 0; i < 8; i += 1) {
      seen.push([...j.read("r1")].length);
      await new Promise((r) => setImmediate(r));
    }
    await j.flush();
    seen.push([...j.read("r1")].length);
    expect(new Set(seen)).toEqual(new Set([G.events.length]));
  });

  it("多个 run 各写各的文件，互不串行", async () => {
    const { j } = fileJournal();
    j.append(makeEvent({ runId: "a", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    j.append(makeEvent({ runId: "b", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    j.append(makeEvent({ runId: "a", seq: 1, kind: EventKind.RUN_COMPLETED, tsMs: 2 }));
    await j.flush();
    expect([...j.read("a")].map((e) => e.seq)).toEqual([0, 1]);
    expect([...j.read("b")].map((e) => e.seq)).toEqual([0]);
    expect(readdirSync(join(dir, "journal")).sort()).toEqual(["a.jsonl", "b.jsonl"]);
  });

  it("追加不覆盖 —— 第二个实例接着上一个写", async () => {
    const a = fileJournal().j;
    a.append(makeEvent({ runId: "r", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    await a.flush();
    const b = fileJournal().j;
    b.append(makeEvent({ runId: "r", seq: 1, kind: EventKind.RUN_COMPLETED, tsMs: 2 }));
    expect([...b.read("r")].map((e) => e.seq)).toEqual([0, 1]); // 未 flush 也要看得见历史
    await b.flush();
    expect([...b.read("r")].map((e) => e.seq)).toEqual([0, 1]);
  });

  it("lastSeq 取的是**最后一条**而不是最大的一条", () => {
    const { j } = fileJournal();
    writeFileSync(join(dir, "journal", "r2.jsonl"), G.jsonl.unordered.file, "utf8");
    expect(j.lastSeq("r2")).toBe(G.jsonl.unordered.last_seq);
    expect(G.jsonl.unordered.last_seq).toBeLessThan(
      Math.max(...G.jsonl.unordered.dicts.map((d) => d["seq"] as number)),
    );
  });

  it("没有这个 run 时 lastSeq = -1，read 是空且不抛", () => {
    const { j } = fileJournal();
    expect(j.lastSeq("不存在")).toBe(G.jsonl.missing_run_last_seq);
    expect([...j.read("不存在")]).toEqual([]);
  });

  it("空行与 CRLF 结尾都跳得过去（Python 是 line.strip()）", () => {
    const { j } = fileJournal();
    const [a, b] = [G.events[0]!.line, G.events[1]!.line];
    writeFileSync(join(dir, "journal", "r1.jsonl"), `${a}\r\n\n  \n${b}\n`, "utf8");
    expect([...j.read("r1")].map((e) => e.seq)).toEqual([0, 1]);
  });

  it("read 是惰性的 —— 拿到生成器时还没碰过磁盘", () => {
    const { j } = fileJournal();
    const it = j.read("r1"); // 文件不存在也不抛
    writeFileSync(join(dir, "journal", "r1.jsonl"), G.jsonl.file, "utf8");
    expect([...it]).toHaveLength(G.events.length); // 第一次 next() 才读，读到的是新内容
  });

  it("flush 在没有待写时立即完成", async () => {
    const { j } = fileJournal();
    await expect(j.flush()).resolves.toBeUndefined();
  });
});

describe("FileJournal 的落盘失败：报出来，但不许杀进程", () => {
  /** 把 <run>.jsonl 变成一个目录，appendFile 必然 EISDIR。 */
  function poison(root: string, runId: string): void {
    mkdirSync(join(root, `${runId}.jsonl`), { recursive: true });
  }

  it("失败经 onError 上报，并从 flush 抛出", async () => {
    const { j, errs } = fileJournal();
    poison(join(dir, "journal"), "r");
    j.append(makeEvent({ runId: "r", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    await expect(j.flush()).rejects.toThrow();
    expect(errs).toHaveLength(1);
    // 取走即清空：第二次 flush 不再重复抛同一批
    await expect(j.flush()).resolves.toBeUndefined();
  });

  it("失败的那一批不会把后面的事件永久堵住", async () => {
    const { j, errs } = fileJournal();
    poison(join(dir, "journal"), "bad");
    j.append(makeEvent({ runId: "bad", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    j.append(makeEvent({ runId: "ok", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
    await expect(j.flush()).rejects.toThrow();
    expect(errs).toHaveLength(1);
    expect(existsSync(join(dir, "journal", "ok.jsonl"))).toBe(true);
  });

  it("没人 await 的后台失败不会变成 unhandledRejection（Node 里那是直接杀进程）", async () => {
    const caught: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      caught.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { j, errs } = fileJournal();
      poison(join(dir, "journal"), "r");
      j.append(makeEvent({ runId: "r", seq: 0, kind: EventKind.RUN_STARTED, tsMs: 1 }));
      // 故意**不** flush，让后台任务自生自灭
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      expect(errs).toHaveLength(1); // 错误确实发生了
      expect(caught).toEqual([]); // 但没有冒成 unhandledRejection
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
describe("InMemoryJournal", () => {
  it("按 run 分组，read 给出插入顺序", () => {
    const j = new InMemoryJournal();
    j.append(makeEvent({ runId: "a", seq: 0, kind: EventKind.RUN_STARTED }));
    j.append(makeEvent({ runId: "b", seq: 9, kind: EventKind.RUN_STARTED }));
    j.append(makeEvent({ runId: "a", seq: 1, kind: EventKind.RUN_COMPLETED }));
    expect([...j.read("a")].map((e) => e.seq)).toEqual([0, 1]);
    expect([...j.read("b")].map((e) => e.seq)).toEqual([9]);
    expect([...j.read("c")]).toEqual([]);
  });

  it("read 先拷一份再迭代 —— 调用方常在遍历历史时继续追加", () => {
    const j = new InMemoryJournal();
    j.append(makeEvent({ runId: "a", seq: 0, kind: EventKind.RUN_STARTED }));
    const out: number[] = [];
    for (const ev of j.read("a")) {
      out.push(ev.seq);
      if (ev.seq < 3) j.append(makeEvent({ runId: "a", seq: ev.seq + 1, kind: EventKind.THOUGHT }));
    }
    expect(out).toEqual([0]); // 迭代中追加的事件不进这一轮
    expect([...j.read("a")].map((e) => e.seq)).toEqual([0, 1]);
  });

  it("lastSeq 是最后一条（不是最大的一条），空 run 给 -1", () => {
    const j = new InMemoryJournal();
    j.append(makeEvent({ runId: "a", seq: 5, kind: EventKind.RUN_STARTED }));
    j.append(makeEvent({ runId: "a", seq: 2, kind: EventKind.RUN_FAILED }));
    expect(j.lastSeq("a")).toBe(2);
    expect(j.lastSeq("空")).toBe(-1);
  });

  it("flush 是空操作（不落盘就没有等的东西）", async () => {
    await expect(new InMemoryJournal().flush()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
describe("BlobStore 的内容寻址", () => {
  it("字符串的 ref 与 golden 一致", async () => {
    const mem = new InMemoryBlobStore();
    const file = new FileBlobStore(join(dir, "blobs"));
    for (const g of G.blobs.strings) {
      expect(contentRef(g.in)).toBe(g.ref);
      expect(await mem.put(g.in)).toBe(g.ref);
      expect(await file.put(g.in)).toBe(g.ref);
      expect(Buffer.from(await file.get(g.ref)).toString("utf8")).toBe(g.in);
    }
  });

  it("二进制（含非法 UTF-8）原样存取", async () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    for (const g of G.blobs.bytes) {
      const raw = Buffer.from(g.b64, "base64");
      expect(await file.put(raw)).toBe(g.ref);
      expect(Buffer.from(await file.get(g.ref)).equals(raw)).toBe(true);
    }
  });

  it("putJson 的字节与 ref 与 Python 一致（多一个空格 ref 就全变）", async () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    for (const g of G.blobs.put_json) {
      expect(pyJsonDumps(g.value, { defaultStr: true })).toBe(g.bytes);
      expect(await file.putJson(g.value)).toBe(g.ref);
      expect(await file.getJson(g.ref)).toEqual(g.value);
      expect(Buffer.from(await file.get(g.ref)).toString("utf8")).toBe(g.bytes);
    }
  });

  it("分桶路径 = <ref 冒号之后的前两位>/<全串>", () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    for (const g of G.blobs.path_edge) {
      expect(file.pathFor(g.ref)).toBe(join(dir, "blobs", ...g.path.split("/")));
    }
  });

  it("落盘后目录里只有分桶文件，没有半截的 .tmp", async () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    const ref = await file.put("内容");
    const bucket = join(dir, "blobs", ref.split(":")[1]!.slice(0, 2));
    expect(readdirSync(bucket)).toEqual([ref.split(":")[1]!]);
  });

  it("同一份内容写两次只占一份（天然幂等）", async () => {
    const mem = new InMemoryBlobStore();
    expect(await mem.put("同样的内容")).toBe(await mem.put("同样的内容"));
    expect(mem.size).toBe(1);
    const file = new FileBlobStore(join(dir, "blobs"));
    expect(await file.put("同样的内容")).toBe(await file.put("同样的内容"));
  });

  it("同一份内容并发 put 不互相踩（Python 的固定 tmp 名在这里会 rename ENOENT）", async () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    const data = "并发写同一份内容".repeat(500);
    const refs = await Promise.all(Array.from({ length: 8 }, () => file.put(data)));
    expect(new Set(refs).size).toBe(1);
    const digest = refs[0]!.split(":")[1]!;
    expect(readdirSync(join(dir, "blobs", digest.slice(0, 2)))).toEqual([digest]); // 没有残留 .tmp
    expect(Buffer.from(await file.get(refs[0]!)).toString("utf8")).toBe(data);
  });

  it("字符串与等价字节给同一个 ref（Python 侧 put 也是先 encode 再哈希）", async () => {
    const mem = new InMemoryBlobStore();
    expect(await mem.put("中文")).toBe(await mem.put(Buffer.from("中文", "utf8")));
  });

  it("缺失的 blob 抛 BlobNotFound，消息与 Python 的 KeyError 一致", async () => {
    const mem = new InMemoryBlobStore();
    const file = new FileBlobStore(join(dir, "blobs"));
    for (const s of [mem, file]) {
      await expect(s.get("blob:deadbeef")).rejects.toBeInstanceOf(BlobNotFound);
      await expect(s.get("blob:deadbeef")).rejects.toThrow(G.blobs.missing_message);
    }
  });

  it("blob 内容不是合法 UTF-8 时 getJson 抛，不悄悄替换成 U+FFFD", async () => {
    const file = new FileBlobStore(join(dir, "blobs"));
    const ref = await file.put(Buffer.from([0xff, 0xfe]));
    await expect(file.getJson(ref)).rejects.toThrow();
  });

  it("putJson 用 default=str 兜底，不像 append 那样抛", async () => {
    const mem = new InMemoryBlobStore();
    const ref = await mem.putJson({ when: new Date(0) });
    expect(await mem.getJson(ref)).toEqual({ when: String(new Date(0)) });
  });
});
