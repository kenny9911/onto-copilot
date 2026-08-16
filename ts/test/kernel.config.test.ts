/**
 * kernel/config 的 golden 校验。
 *
 * golden：`golden/config.json`（由 `tools/golden/config.py` 导出，主导出器没覆盖
 * 这个模块）。**期望值一个都不是手写的** —— 手写的是我对 Python 行为的猜测。
 *
 * 用例里的 .env 内容全部按**字节**（golden 里的 `content_hex`）写盘：BOM、非法
 * UTF-8、`\x0b` 这类分隔符，只有走字节才说得清楚，也才和 Python 侧吃到同一份输入。
 *
 * 环境隔离：每个用例前把 `process.env` 整个换成 golden 里记的 `pre_env`
 * （导出时 Python 侧也是清空后只放 pre_env），跑完还原。否则本机的 PATH 之类
 * 会混进 `env_after` 的比对里。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  insecureTransport,
  llmConfig,
  loadDotenv,
  makeLLMConfig,
  pySplitlines,
  pyStrip,
  pyStripChars,
  redactedKey,
} from "../src/kernel/config.js";

// ── golden 的形状 ────────────────────────────────────────────────

interface PyErr {
  type: string;
  message: string;
}
interface DotenvCase {
  name: string;
  content_hex: string;
  exists: boolean;
  pre_env: Record<string, string>;
  override: boolean;
  loaded?: [string, string][];
  raises?: PyErr;
  env_after: Record<string, string>;
}
interface RedactedCase {
  api_key: string;
  len: number;
  out: string;
}
interface InsecureCase {
  base_url: string;
  out: boolean;
}
interface LlmCase {
  name: string;
  pre_env: Record<string, string>;
  dotenv_hex: string | null;
  use_dotenv: boolean;
  out?: { base_url: string; api_key: string };
  raises?: PyErr;
  env_after: Record<string, string>;
}
interface Golden {
  load_dotenv: DotenvCase[];
  redacted_key: RedactedCase[];
  insecure_transport: InsecureCase[];
  llm_config: LlmCase[];
  primitives: {
    isspace_codepoints: number[];
    splitlines_separator_codepoints: number[];
    strip: { in: string; out: string }[];
    strip_quotes: { in: string; out: string }[];
    strip_then_quotes: { in: string; out: string }[];
    splitlines: { in: string; out: string[] }[];
    rstrip_slash: { in: string; out: string }[];
    missing_list_repr: { in: string[]; out: string }[];
  };
}

const G: Golden = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "golden", "config.json"), "utf8"),
) as Golden;

// ── 环境与临时文件 ───────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "ts-config-"));
const SAVED = { ...process.env };

/** 把 process.env 整个换成 pre —— 与导出时 Python 侧的 clean_env 一一对应。 */
function setEnv(pre: Record<string, string>): void {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, pre);
}

/**
 * 当前环境的完整快照，与 golden 的 env_after 直接比。
 *
 * **必须用 `Object.fromEntries`**：`out[k] = v` 在 `k === "__proto__"` 时改的是
 * 原型而不是建自有属性，proto_keys 那条用例会看到"少了一个键"而以为是 config.ts
 * 的锅。`fromEntries` 走的是 CreateDataProperty，`__proto__` 老老实实变成自有属性
 * （golden 那边 `JSON.parse` 也是这么建的，两边才对得上）。
 */
function envSnapshot(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(process.env)
      .sort()
      .map((k) => [k, process.env[k] as string]),
  );
}

function writeHex(name: string, hex: string): string {
  const p = join(TMP, `${name}.env`);
  writeFileSync(p, Buffer.from(hex, "hex"));
  return p;
}

afterEach(() => setEnv(SAVED as Record<string, string>));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ══════════════════════════════════════════════════════════════════

describe("Python 字符串原语", () => {
  it("isspace 的 29 个字符与 CPython 完全一致", () => {
    // 逐个 code point 过 pyStrip：只有属于 Python isspace 集的才该被剥掉。
    // 这是全量比对而不是抽样 —— 集合写错一个字符，.env 的解析就会在那个字符上
    // 静默分叉，而 JS 的 trim() 与它在两个方向上都有差集。
    const mine: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // 落单代理，两边都不是空白
      const c = String.fromCodePoint(cp);
      if (pyStrip(`${c}x${c}`) === "x") mine.push(cp);
    }
    expect(mine).toEqual(G.primitives.isspace_codepoints);
  });

  it("JS 的 trim() 与它确实不等价（钉住差集，别哪天顺手换回 trim）", () => {
    const py = new Set(G.primitives.isspace_codepoints);
    const jsOnly: number[] = [];
    const pyOnly: number[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const trimmed = String.fromCodePoint(cp).trim() === "";
      if (trimmed && !py.has(cp)) jsOnly.push(cp);
      if (!trimmed && py.has(cp)) pyOnly.push(cp);
    }
    expect(jsOnly).toEqual([0xfeff]); // BOM：JS 剥、Python 不剥
    expect(pyOnly).toEqual([0x1c, 0x1d, 0x1e, 0x1f, 0x85]); // Python 剥、JS 不剥
  });

  it("splitlines 的分隔符与 CPython 完全一致", () => {
    const mine: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (pySplitlines(`${String.fromCodePoint(cp)}A`).length > 1) mine.push(cp);
    }
    expect(mine).toEqual(G.primitives.splitlines_separator_codepoints);
  });

  for (const c of G.primitives.strip) {
    it(`strip(${JSON.stringify(c.in)})`, () => expect(pyStrip(c.in)).toBe(c.out));
  }
  for (const c of G.primitives.strip_quotes) {
    it(`strip("'\\"") on ${JSON.stringify(c.in)}`, () =>
      expect(pyStripChars(c.in, "'\"")).toBe(c.out));
  }
  for (const c of G.primitives.strip_then_quotes) {
    it(`strip().strip("'\\"") on ${JSON.stringify(c.in)}`, () =>
      expect(pyStripChars(pyStrip(c.in), "'\"")).toBe(c.out));
  }
  for (const c of G.primitives.splitlines) {
    it(`splitlines(${JSON.stringify(c.in)})`, () => expect(pySplitlines(c.in)).toEqual(c.out));
  }
  for (const c of G.primitives.rstrip_slash) {
    it(`rstrip("/") on ${JSON.stringify(c.in)}`, () =>
      // llm_config 里用的就是这条正则；`$` 无 m 标志时只匹配串尾，与 rstrip 等价
      expect(c.in.replace(/\/+$/, "")).toBe(c.out));
  }
});

// ══════════════════════════════════════════════════════════════════

describe("loadDotenv（golden 全量）", () => {
  for (const c of G.load_dotenv) {
    it(c.name, () => {
      setEnv(c.pre_env);
      const p = c.exists ? writeHex(c.name, c.content_hex) : join(TMP, `${c.name}-absent.env`);

      if (c.raises) {
        let caught: unknown;
        try {
          loadDotenv(p, c.override);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error;
        if (c.raises.type === "UnicodeDecodeError") {
          // 已知分叉：Python 报 "'utf-8' codec can't decode byte 0xff in position
          // 2: invalid start byte"，TextDecoder 报的是自己那句。**都抛**是契约，
          // 消息不是 —— 全仓没有任何地方 catch 它或匹配它的文本。
          expect(err.message.length).toBeGreaterThan(0);
        } else {
          // OSError / ValueError：消息与 name 都逐字对齐 CPython
          expect(err.name).toBe(c.raises.type);
          expect(err.message).toBe(c.raises.message);
        }
      } else {
        const loaded = loadDotenv(p, c.override);
        // Map 的迭代序就是插入序，与 Python dict 一一对应
        expect([...loaded.entries()]).toEqual(c.loaded);
      }
      // 无论抛没抛，环境的最终形态都要一致 —— 抛之前已经写进去的**不回滚**
      expect(envSnapshot()).toEqual(c.env_after);
    });
  }
});

describe("loadDotenv 的几条不能靠 golden 表达的性质", () => {
  it("默认路径是 .env（不存在时返回空 Map，不抛）", () => {
    setEnv({});
    // cwd 是 ts/，仓库的 .env 不在这里；行为等价于 Path(".env").exists() 为假
    expect(loadDotenv(join(TMP, "definitely-absent.env")).size).toBe(0);
    expect(envSnapshot()).toEqual({});
  });

  it("原型链上的键名不会被误判成「环境里已存在」", () => {
    // `"toString" in process.env` 是 true 而 os.environ 里没有 —— 用 `in` 的话
    // 这一行会被静默跳过。golden 的 proto_keys 已经钉了结果，这里钉住原因。
    setEnv({});
    expect("toString" in process.env).toBe(true); // 就是这个陷阱本身
    expect(Object.hasOwn(process.env, "toString")).toBe(false);
    loadDotenv(writeHex("proto-why", Buffer.from("toString=1\n", "utf8").toString("hex")));
    expect(process.env["toString"]).toBe("1");
  });
});

// ══════════════════════════════════════════════════════════════════

describe("redactedKey", () => {
  for (const c of G.redacted_key) {
    it(`len(code point)=${c.len} ${JSON.stringify(c.api_key)}`, () => {
      expect(redactedKey(makeLLMConfig("http://x", c.api_key))).toBe(c.out);
    });
  }

  it("按 code point 数长度而不是 UTF-16 码元（12 个 emoji 的分支必须与 Python 同侧）", () => {
    const k = "🔑".repeat(12);
    expect(k.length).toBe(24); // 天真的 .length —— 会走进脱敏分支
    expect([...k].length).toBe(12); // Python 看到的长度 —— 不脱敏
    expect(redactedKey(makeLLMConfig("http://x", k))).toBe("…");
  });
});

describe("insecureTransport", () => {
  for (const c of G.insecure_transport) {
    it(JSON.stringify(c.base_url), () => {
      expect(insecureTransport(makeLLMConfig(c.base_url, "sk"))).toBe(c.out);
    });
  }
});

describe("makeLLMConfig", () => {
  it("frozen=True 在运行期也成立", () => {
    const cfg = makeLLMConfig("http://x", "sk");
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as { baseUrl: string }).baseUrl = "http://evil";
    }).toThrow(); // 测试文件是 ESM（严格模式），赋值冻结对象直接抛
    expect(cfg.baseUrl).toBe("http://x");
  });
});

// ══════════════════════════════════════════════════════════════════

describe("llmConfig（golden 全量）", () => {
  for (const c of G.llm_config) {
    it(c.name, () => {
      setEnv(c.pre_env);
      const p =
        c.dotenv_hex === null
          ? join(TMP, `llm-${c.name}-absent.env`)
          : writeHex(`llm-${c.name}`, c.dotenv_hex);
      const arg = c.use_dotenv ? p : null;

      if (c.raises) {
        expect(c.raises.type).toBe("RuntimeError");
        let caught: unknown;
        try {
          llmConfig(arg);
        } catch (e) {
          caught = e;
        }
        // Python 抛 RuntimeError，cli.py:82 / server.py:809 是按类型接的；
        // TS 侧换成 ConfigError（见 config.ts 的说明），消息逐字一致。
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).message).toBe(c.raises.message);
      } else {
        const cfg = llmConfig(arg);
        expect(cfg.baseUrl).toBe(c.out?.base_url);
        expect(cfg.apiKey).toBe(c.out?.api_key);
      }
      expect(envSnapshot()).toEqual(c.env_after);
    });
  }
});

describe("llmConfig 的凭证不外泄", () => {
  it("缺变量时的异常里只有变量名，没有任何值", () => {
    setEnv({ CUSTOM_LLM_API_KEY: "sk-super-secret-value" });
    let caught: ConfigError | undefined;
    try {
      llmConfig(null);
    } catch (e) {
      caught = e as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    // 消息、name、missing、栈 —— 四处都不许出现 key 的任何片段
    const surfaces = [
      caught?.message ?? "",
      caught?.name ?? "",
      JSON.stringify(caught?.missing),
      String(caught),
    ].join("|");
    expect(surfaces).not.toContain("sk-super-secret-value");
    expect(surfaces).not.toContain("super");
    expect(caught?.missing).toEqual(["CUSTOM_LLM_BASE_URL"]);
  });

  it("missing 列表的 repr 形态（str(list)，元素走 repr）", () => {
    for (const c of G.primitives.missing_list_repr) {
      if (c.in.length === 0) continue; // 空 missing 不会抛，没有对应路径
      setEnv(
        Object.fromEntries(
          (["CUSTOM_LLM_BASE_URL", "CUSTOM_LLM_API_KEY"] as const)
            .filter((n) => !c.in.includes(n))
            .map((n) => [n, n === "CUSTOM_LLM_BASE_URL" ? "http://gw/v1" : "sk"]),
        ),
      );
      let msg = "";
      try {
        llmConfig(null);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toBe(`缺少环境变量 ${c.out}。把它们写进 .env（见 .env.example）或直接导出。`);
    }
  });
});
