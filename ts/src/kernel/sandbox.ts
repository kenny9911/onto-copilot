/**
 * 沙箱执行器 —— 跑模型生成的代码。
 *
 * **威胁模型不是「防 bug」，是「防运行时生成的对抗代码」。** 代码在执行前无法被人
 * 审阅，所以隔离强度决定了这个产品能不能碰客户数据。
 *
 * 三档实现，接口相同：
 *
 * | 实现                     | 隔离强度           | 用途                                  |
 * | ------------------------ | ------------------ | ------------------------------------- |
 * | `LocalSubprocessSandbox` | 进程 + 权限模型     | **仅开发**。无内核隔离，见下方警告     |
 * | `GVisorSandbox`          | 用户态内核          | 生产默认。CodeAct 常规数据处理         |
 * | `FirecrackerSandbox`     | 独立内核 microVM    | 未知来源二进制、扫描件 OCR             |
 *
 * ⚠️ {@link LocalSubprocessSandbox} **不提供内核级隔离**。它做的是资源上限、
 * 文件系统限定（Node 权限模型）、环境变量清洗、出网拦截、超时终止 —— 足以挡住
 * 失控的循环和误删，挡不住蓄意的提权或逃逸。生产环境必须用 gVisor 或 Firecracker。
 * 这一点在 {@link SandboxExecutor.describe} 里也会明说，免得部署时被当成安全的。
 *
 * ── 从 Python 版搬过来时变了什么（`kernel/sandbox.py`）──────────────
 *
 * 1. **沙箱里跑的是 TypeScript/JavaScript，不再是 Python。** 数据变换用 arquero
 *    （`aq` 已预先注入），它提供 dplyr 风格的 table / groupby / rollup / join /
 *    derive。工具描述里必须写明有 `aq` —— 模型不知道有什么就不会用。
 *
 * 2. **隔离用子进程 + `node --permission`，不用 `node:vm`。** Node 官方文档明说
 *    vm **不是安全边界**（一行 `this.constructor.constructor("return process")()`
 *    就出来了），拿它当沙箱等于没有沙箱。权限模型是进程级的，能把文件系统精确到
 *    目录，并且默认拒绝 child_process / worker_threads / 原生插件 / WASI —— 后面
 *    这几条恰好堵死了「换个干净的 isolate 把补丁绕过去」这条路。
 *
 * 3. **出网是运行时补丁，不是权限模型。** Node 24 的权限模型**没有网络维度**
 *    （`node --help` 里只有 fs / child-process / worker / addons / wasi /
 *    inspector），所以本地沙箱在子进程里预加载一段代码，把 `net.Socket.prototype
 *    .connect`、`dgram`、`dns`、`fetch`、`WebSocket` 全部换成抛错。它挡得住模型
 *    写出来的任何常规出网代码（所有 TCP 都过 `Socket.prototype.connect`），
 *    但它和静态扫描一样是**用户态的**：真正的边界是容器的 `--network none`。
 */

import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import { constants as osConstants, tmpdir } from "node:os";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { SandboxError, pyRepr } from "./errors.js";

/** 沙箱里允许留下的环境变量。其余全部清掉 —— 凭证绝不进沙箱。 */
export const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "HOME",
  "TMPDIR",
]);

/**
 * 危险模块。既要匹配 `import net from "node:net"` 也要匹配裸用 `net.connect()` ——
 * 只写一种形式会漏掉另一种，而两种都是最常见的写法。
 *
 * 桶名（`network` / `subprocess`）与 Python 版**一致**：这些字符串会作为 `flags`
 * 进 journal 和模型上下文，换词等于换契约。变的只有桶里的模块名 —— 宿主语言换了，
 * `socket` / `urllib` 在 JS 里根本不存在。
 */
const RISKY_MODULES: Readonly<Record<string, readonly string[]>> = {
  network: [
    "net",
    "http",
    "https",
    "http2",
    "tls",
    "dns",
    "dgram",
    "undici",
    "axios",
    "node-fetch",
    "ws",
  ],
  subprocess: ["child_process", "worker_threads", "cluster", "inspector", "vm"],
};

/**
 * 明显在试探边界的模式。命中不代表一定恶意，但要记账并可选择拦截。
 *
 * `cs`（case sensitive）这一列是 Python 版没有的：Python 把两边都 `lower()` 了，
 * 而 JS 里 `Function(` 一旦被小写就会命中每一个 `function (`，扫描结果全是噪声。
 * 大小写敏感的那几条必须逐字匹配。
 */
const SUSPICIOUS: readonly (readonly [string, readonly string[], boolean])[] = [
  [
    "subprocess",
    ["child_process", "execsync", "spawnsync", "process.binding", "process.dlopen"],
    false,
  ],
  ["env_probe", ["process.env", "getenv", "os.userinfo", "process.execpath"], false],
  ["fs_escape", ["../..", "/etc/passwd", "~/.ssh", "/proc/self", "/root/"], false],
  // `fetch` / `WebSocket` 是**全局**，不经过任何 import —— 只按模块名扫会整条漏掉
  // JS 里最常见的出网写法。Python 那边没有这一类（出网必须先 import）。
  ["network", ["fetch(", "websocket", "xmlhttprequest", "navigator.sendbeacon"], false],
  ["dynamic_exec", ["eval(", "constructor.constructor", "runinnewcontext"], false],
  ["dynamic_exec", ["Function(", "createRequire("], true],
];

/** `import x from "m"` / `import "m"` / `export … from "m"`。 */
const IMPORT_RE = /^[^\S\n]*(?:import|export)\b[^'"\n]*['"]([^'"]+)['"]/gm;
/** `import("m")` / `require("m")`。 */
const DYN_IMPORT_RE = /(?:^|[^\w$.])(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]/g;

export interface SandboxLimits {
  readonly cpuSeconds: number;
  readonly wallclockSeconds: number;
  readonly memoryMb: number;
  readonly maxOutputBytes: number;
  readonly maxOutDirMb: number;
  /** 默认无网。需要出网的活不该在沙箱里干。 */
  readonly network: boolean;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpuSeconds: 60,
  wallclockSeconds: 180,
  memoryMb: 2048,
  maxOutputBytes: 2_000_000,
  maxOutDirMb: 512,
  network: false,
};

/** 只想改一两条上限时用它 —— 其余照 {@link DEFAULT_LIMITS}。 */
export function sandboxLimits(over: Partial<SandboxLimits> = {}): SandboxLimits {
  return { ...DEFAULT_LIMITS, ...over };
}

/**
 * `ExecResult.to_dict()` 的线上形态。
 *
 * 字段名保持 snake_case（与 Python 侧 `ExecResult.to_dict()` 逐字段一致）——
 * 这份 dict **原样**作为 `code.exec` 的工具返回值进模型上下文和 journal，
 * 在这里改字段名等于把工具的对外契约改了。
 */
export interface ExecResultDict {
  readonly ok: boolean;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifacts: readonly string[];
  readonly result: unknown;
  readonly flags: readonly string[];
}

/**
 * Python 的 `s[-n:]`（按**码点**取尾巴）。
 *
 * `s.slice(-n)` 是按 UTF-16 码元切的：4000 个 emoji 在 Python 里是 4000 个字符、
 * 在 JS 里是 8000 个码元，两边截出来的长度差一倍。更糟的是 `slice` 有一半概率把
 * 尾巴切在代理对中间，留下一个落单代理 —— 它会一路混进 JSON、进 journal，
 * 到某个 `JSON.parse` 或数据库写入时才炸，而那时已经看不出源头。
 *
 * 快路径（没有代理码元时按码元切就等于按码点切）挡住了绝大多数调用的开销。
 */
function tailCodePoints(s: string, n: number): string {
  if (s.length <= n) return s;
  const fast = s.slice(-n);
  // 没有代理对 ⇒ 码元数 == 码点数，快路径的结果就是对的。
  if (!/[\uD800-\uDFFF]/.test(fast)) return fast;
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(-n).join("");
}

export class ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  /** 文件名 → 字节数。`toDict()` 只把**键**交出去（Python 侧 `list(self.artifacts)`）。 */
  artifacts: Record<string, number>;
  /** `/out/result.json` 的内容，也就是沙箱里 `emit()` 交回的东西。 */
  result: unknown;
  /** 静态扫描命中的可疑模式。**不是安全边界**，是记账与告警。 */
  flags: string[];

  constructor(init: {
    ok: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    durationMs?: number;
    artifacts?: Record<string, number>;
    result?: unknown;
    flags?: string[];
  }) {
    this.ok = init.ok;
    this.stdout = init.stdout ?? "";
    this.stderr = init.stderr ?? "";
    this.exitCode = init.exitCode ?? null;
    this.durationMs = init.durationMs ?? 0;
    this.artifacts = init.artifacts ?? {};
    this.result = init.result ?? null;
    this.flags = init.flags ?? [];
  }

  toDict(): ExecResultDict {
    return {
      ok: this.ok,
      exit_code: this.exitCode,
      duration_ms: this.durationMs,
      stdout: tailCodePoints(this.stdout, 4000),
      stderr: tailCodePoints(this.stderr, 4000),
      artifacts: Object.keys(this.artifacts),
      result: this.result,
      flags: [...this.flags],
    };
  }
}

/**
 * 静态扫描。**不是安全边界**，是记账与告警 —— 真正的边界是隔离层。
 *
 * 静态扫描原理上就绕得过去（`await import("ne"+"t")`、`globalThis["fe"+"tch"]`
 * 之类），所以它的定位是「发现明显的越界尝试并留痕」，不是「保证代码安全」。
 * 这条判断跟着 Python 版一起搬过来，防的是下一个人误以为静态扫描能当边界，
 * 于是把隔离那一层省掉。
 */
export function scan(code: string): string[] {
  const low = code.toLowerCase();
  const hits: string[] = [];
  for (const [name, pats, cs] of SUSPICIOUS) {
    const hay = cs ? code : low;
    if (pats.some((p) => hay.includes(p))) hits.push(name);
  }

  const imported = new Set<string>();
  for (const re of [IMPORT_RE, DYN_IMPORT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const spec = m[1];
      if (spec === undefined) continue;
      // "node:child_process" → "child_process"；"undici/lib/x" → "undici"。
      imported.add(spec.replace(/^node:/, "").split("/")[0]!.toLowerCase());
    }
  }

  for (const [kind, mods] of Object.entries(RISKY_MODULES)) {
    // 裸用形式（`net.connect(...)`）要求点号前是词边界。Python 版写的是朴素的
    // `"http." in low`，那会被 `xhttp.` / `myhttp.` 命中 —— 同一个启发式，
    // 这里少一堆假阳性，代价是零。
    const bare = mods.some((m) =>
      new RegExp(`(?<![\\w$.])${m.replace(/[-]/g, "\\-")}\\.`).test(low),
    );
    if (mods.some((m) => imported.has(m)) || bare) hits.push(kind);
  }
  return [...new Set(hits)];
}

// ══════════════════════════════════════════════════════════════════
//  注入到每段代码前面的序言
// ══════════════════════════════════════════════════════════════════
/**
 * 给出 `INPUTS` / `IN_DIR` / `OUT_DIR` / `emit()`，省得模型每次自己拼路径 ——
 * 拼错了就是一次白跑。四个名字与 Python 版**同名同语义**。
 *
 * 多出来的一个是 `aq`（arquero）：宿主换成 Node 之后 pandas 没了，数据变换全靠它。
 *
 * Python 版的序言是在运行时 `if Path("/in").exists()` 二选一（容器里是 `/in`，
 * 本地是相对路径）。这里改成**生成时**由执行器把路径填进来：本地沙箱开了权限
 * 模型，`existsSync("/in")` 这种对根目录的试探属于越权读，虽然 `existsSync` 会
 * 吞掉异常返回 false，但让沙箱代码的第一行就去撞权限墙实在没有必要。
 */
function preamble(opts: { inDir: string; outDir: string; arquero: string }): string {
  const q = (s: string) => JSON.stringify(s);
  return `import * as __fs from "node:fs";
import * as __path from "node:path";
import * as aq from ${q(opts.arquero)};

const IN_DIR = ${q(opts.inDir)};
const OUT_DIR = ${q(opts.outDir)};
__fs.mkdirSync(OUT_DIR, { recursive: true });
const INPUTS = JSON.parse(__fs.readFileSync(__path.join(IN_DIR, "inputs.json"), "utf8"));

/**
 * 序列化前的归一化。**不能用 JSON.stringify 的 replacer 做这件事**：规范里
 * toJSON 先于 replacer 执行，而 arquero 的 Table 自带 toJSON 且返回的是一个
 * **字符串**，等 replacer 看到它时它已经是 '[{"a":1}]' 这种字符串了，认不出来。
 * 所以在进 stringify 之前先走一遍。
 */
function __norm(v, seen) {
  if (typeof v === "bigint") return String(v); // BigInt 会让 stringify 直接抛
  if (v === null || typeof v !== "object") return v;
  // 模型 emit(表) 是极常见的写法，静默交回一坨字符串比报错难查得多。
  if (typeof v.objects === "function" && typeof v.numRows === "function") return v.objects();
  if (seen.has(v)) return v; // 有环：交给 stringify 抛它自己那条清楚的错
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => __norm(x, seen));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Date 之类保持原样
  const o = {};
  for (const k of Object.keys(v)) o[k] = __norm(v[k], seen);
  return o;
}

/** 把结构化结果交回宿主。只有 OUT_DIR 里的东西能带出去。 */
function emit(obj) {
  __fs.writeFileSync(
    __path.join(OUT_DIR, "result.json"),
    JSON.stringify(__norm(obj, new WeakSet()), (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    ),
    "utf8",
  );
}

// ---- 以下是生成的代码 ----
`;
}

/**
 * 子进程的出网拦截。**用户态补丁，不是内核边界** —— 见文件头第 3 条。
 *
 * 补在原型上而不只是模块导出上：`net.Socket.prototype.connect` 是所有 TCP 的
 * 唯一入口（fetch/undici、http、https、tls、http2 全部经过它），补住它就等于
 * 补住了所有「换个模块再试一次」的写法。模块导出那几个另外补一遍，是为了让
 * 错误在调用点就抛出来，而不是变成一个 error 事件飘到别处。
 */
const NET_BLOCK_PRELOAD = `import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const deny = (what) => {
  const e = new Error("[sandbox] 网络已禁用（" + what + "）—— 沙箱里不做出网");
  e.code = "ERR_SANDBOX_NETWORK_DENIED";
  return e;
};
const stub = (obj, keys, label) => {
  for (const k of keys) {
    if (typeof obj?.[k] === "function") obj[k] = () => { throw deny(label + "." + k); };
  }
};

net.Socket.prototype.connect = function () { throw deny("net.Socket.connect"); };
dgram.Socket.prototype.send = function () { throw deny("dgram.Socket.send"); };
dgram.Socket.prototype.bind = function () { throw deny("dgram.Socket.bind"); };
http.Agent.prototype.createConnection = function () { throw deny("http.Agent.createConnection"); };

stub(net, ["connect", "createConnection", "createServer"], "net");
stub(tls, ["connect", "createServer"], "tls");
stub(dgram, ["createSocket"], "dgram");
stub(http, ["request", "get", "createServer"], "http");
stub(https, ["request", "get", "createServer"], "https");
stub(dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveSrv"], "dns");
stub(dns.promises, ["lookup", "resolve", "resolve4", "resolve6"], "dns.promises");

globalThis.fetch = () => Promise.reject(deny("fetch"));
for (const g of ["WebSocket", "EventSource"]) {
  if (g in globalThis) globalThis[g] = function () { throw deny(g); };
}
`;

// ══════════════════════════════════════════════════════════════════
//  接口
// ══════════════════════════════════════════════════════════════════
export interface ExecOptions {
  /** 会以 `INPUTS` 全局变量注入（已 JSON 化）。 */
  readonly inputs?: Record<string, unknown>;
  /** `{沙箱内文件名: 宿主路径}`，只读拷进 `/in`。 */
  readonly files?: Record<string, string>;
}

/**
 * 执行一段 TypeScript/JavaScript，返回结构化结果。
 *
 * 约定（三种实现一致）：
 *
 * - `IN_DIR`  只读放调用方给的输入文件
 * - `OUT_DIR` 可写，执行完只有这里的东西能带出来
 * - 代码把结构化结果写到 `OUT_DIR/result.json`（用注入的 `emit()`），
 *   由 `result` 字段返回
 */
export abstract class SandboxExecutor {
  name = "abstract";
  isolation = "none";
  readonly limits: SandboxLimits;
  readonly blockSuspicious: boolean;

  constructor(limits?: SandboxLimits | null, blockSuspicious = false) {
    this.limits = limits ?? DEFAULT_LIMITS;
    this.blockSuspicious = blockSuspicious;
  }

  protected abstract run(workdir: string, codeFile: string): Promise<ExecResult>;

  /** 沙箱里 `IN_DIR` / `OUT_DIR` 的值。容器里是挂载点，本地是宿主绝对路径。 */
  protected dirsInSandbox(workdir: string): { inDir: string; outDir: string } {
    void workdir;
    return { inDir: "/in", outDir: "/out" };
  }

  /** `aq` 的模块说明符。容器里镜像自带，本地要指到宿主 node_modules 的绝对路径。 */
  protected arqueroSpecifier(): string {
    return "arquero";
  }

  /**
   * 执行代码。
   *
   * 文件名用 `main.mts`：`.mts` 是无歧义的 ESM + TypeScript，Node 24 原生按类型
   * 剥离（type stripping）跑，模型写 TS 还是写 JS 都能过 —— 合法的 JS 本来就是
   * 合法的 TS。代价是类型剥离不支持 `enum` / `namespace`（它们要生成运行时代码），
   * 这两样在数据变换脚本里没有出场机会。
   */
  async exec(code: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const flags = scan(code);
    if (flags.length > 0 && this.blockSuspicious) {
      // 消息与 Python 逐字对齐（那边是 f-string 里的 list repr）。
      throw new SandboxError(
        `代码命中可疑模式 [${flags.map(pyRepr).join(", ")}]，已按策略拒绝执行`,
      );
    }

    const work = fs.mkdtempSync(path.join(sandboxTmpRoot(), "oc-sbx-"));
    try {
      const inDir = path.join(work, "in");
      const outDir = path.join(work, "out");
      fs.mkdirSync(inDir);
      fs.mkdirSync(outDir);
      for (const [name, src] of Object.entries(opts.files ?? {})) {
        fs.copyFileSync(src, path.join(inDir, path.basename(name)));
      }
      fs.writeFileSync(
        path.join(inDir, "inputs.json"),
        JSON.stringify(opts.inputs ?? {}, (_k, v: unknown) =>
          typeof v === "bigint" ? String(v) : v,
        ),
        "utf8",
      );

      const codeFile = path.join(work, "main.mts");
      const dirs = this.dirsInSandbox(work);
      fs.writeFileSync(
        codeFile,
        preamble({ ...dirs, arquero: this.arqueroSpecifier() }) + code,
        "utf8",
      );

      const res = await this.run(work, codeFile);
      res.flags = flags;
      res.artifacts = collectArtifacts(outDir);

      // 产物目录上限。`ulimit -f` 只管得住**单个文件**，一千个小文件照样能把盘
      // 塞满，所以这里再按总量核一次 —— 这一条是精确的、跨平台的。
      const total = Object.values(res.artifacts).reduce((a, b) => a + b, 0);
      const cap = this.limits.maxOutDirMb * 1024 * 1024;
      if (total > cap) {
        res.ok = false;
        res.stderr += `\n[sandbox] 产物超过 ${this.limits.maxOutDirMb}MB 上限（${total} 字节），已丢弃`;
        res.artifacts = {};
        return res;
      }

      const rp = path.join(outDir, "result.json");
      if (fs.existsSync(rp)) {
        const text = fs.readFileSync(rp, "utf8");
        try {
          res.result = JSON.parse(text);
        } catch (exc) {
          res.stderr += `\n[sandbox] /out/result.json 不是合法 JSON: ${String(exc)}`;
        }
      }
      return res;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** 部署时看这个。**隔离强度必须可见** —— 把开发用沙箱当生产用是灾难。 */
  describe(): Record<string, unknown> {
    return {
      name: this.name,
      isolation: this.isolation,
      production_safe: this.isolation === "gvisor" || this.isolation === "microvm",
      limits: {
        cpu_s: this.limits.cpuSeconds,
        wall_s: this.limits.wallclockSeconds,
        mem_mb: this.limits.memoryMb,
        network: this.limits.network,
      },
    };
  }
}

/**
 * 产物清单。**排序**是相对 Python 的一处有意分叉：那边是 `Path.iterdir()` 的
 * readdir 顺序（由文件系统决定，同一份代码在两台机器上能给出不同的列表），
 * 而这份列表要进 journal 参与重放比对。顺序本来就没被承诺，钉死它只有好处。
 */
function collectArtifacts(outDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of fs.readdirSync(outDir).sort()) {
    const st = fs.statSync(path.join(outDir, name));
    if (st.isFile()) out[name] = st.size;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  本地子进程（仅开发）
// ══════════════════════════════════════════════════════════════════
/** `require.resolve("arquero")` 的结果 + 它所在的 node_modules 根。只算一次。 */
let arqueroCache: { entry: string; nodeModules: string } | null = null;

function resolveArquero(): { entry: string; nodeModules: string } {
  if (arqueroCache !== null) return arqueroCache;
  let entry: string;
  try {
    entry = fs.realpathSync(createRequire(import.meta.url).resolve("arquero"));
  } catch (e) {
    throw new SandboxError(`沙箱要给模型注入 aq(arquero)，但解析不到这个包: ${String(e)}`);
  }
  // 权限模型要按目录放行，而 arquero 自己还要 import flechette / acorn。逐个包
  // 授权会随依赖树漂移而静默失效（某次升级多一个传递依赖，沙箱就起不来了），
  // 所以放行整个 node_modules —— 那里面只有包源码，且是**只读**。
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = entry.lastIndexOf(marker);
  const nodeModules =
    at >= 0 ? entry.slice(0, at + marker.length - 1) : path.dirname(entry);
  arqueroCache = { entry, nodeModules };
  return arqueroCache;
}

/** POSIX sh 的单参数转义。路径来自 mkdtemp / 包解析，仍然照转不误。 */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 信号名 → Python 的 `returncode` 语义（被信号杀死是 `-signum`）。 */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  if (signal === null) return null;
  const num = (osConstants.signals as Record<string, number | undefined>)[signal];
  return num === undefined ? null : -num;
}

/**
 * 本机这个 Node 认不认 `--allow-net`（Node 26 起的 Net 权限档）。认就是这个串，
 * 不认就是 null —— 见 `nodeArgs` 里为什么必须先探测。
 *
 * `allowedNodeEnvironmentFlags` 是 Node 自己那份完整的参数名集合，比对版本号靠谱：
 * 发行版可能回补，而我们要问的从来是「这个二进制认不认」。
 */
const ALLOW_NET: string | null = process.allowedNodeEnvironmentFlags.has("--allow-net")
  ? "--allow-net"
  : null;

/**
 * 独立进程 + Node 权限模型 + 资源上限 + 环境清洗 + 出网拦截。
 *
 * ⚠️ **无内核隔离。** 挡得住失控循环、内存爆炸、误删宿主文件、顺手出网；挡不住
 * 蓄意提权或逃逸（权限模型自己就是同进程的 JS 检查，Node 也从没把它当成对抗
 * 恶意代码的边界）。只用于本地开发和 CI。
 */
export class LocalSubprocessSandbox extends SandboxExecutor {
  override name = "local-subprocess";
  override isolation = "process";

  protected override dirsInSandbox(workdir: string): { inDir: string; outDir: string } {
    return { inDir: path.join(workdir, "in"), outDir: path.join(workdir, "out") };
  }

  protected override arqueroSpecifier(): string {
    // 沙箱的工作目录在 /tmp 下，裸名 `arquero` 在那里解析不到（往上找不到任何
    // node_modules）。给绝对 file: URL，Node 直接按路径加载。
    return pathToFileURL(resolveArquero().entry).href;
  }

  /**
   * 子进程的命令行。单独拆出来是为了可测 —— **隔离参数写错了不会有报错，只会
   * 静默变得不安全**，所以必须能断言。
   */
  nodeArgs(workdir: string, codeFile: string, preload: string | null): string[] {
    const l = this.limits;
    const args = [
      "--permission",
      // 工作目录整个可读（in/ 里的输入、main.mts、preload），只有 out/ 可写。
      `--allow-fs-read=${workdir}`,
      `--allow-fs-read=${resolveArquero().nodeModules}`,
      `--allow-fs-write=${path.join(workdir, "out")}`,
      // 老生代堆上限。Buffer / TypedArray 走堆外，所以这不是内存总量的硬顶 ——
      // 但模型写的数据变换（数组、对象、字符串）全在老生代里。
      `--max-old-space-size=${l.memoryMb}`,
    ];
    // Node 26 起权限模型多了 **Net** 这一档：开着 `--permission` 时出网默认就是
    // 拒绝的（`ERR_ACCESS_DENIED` / `permission: 'Net'`），不再需要谁去拦。
    // 对 `network: false` 这是白捡的一层——preload 照打不误，两道锁而已。
    // 但 `network: true` 的语义是「沙箱不管出网，交给上面的人管」，在新 Node 上
    // 会被权限模型连坐掐死，所以这里要显式放行。
    //
    // 之所以先探测再加：不认识的参数会让 node **起都起不来**（`node: bad option`），
    // 而不是忽略掉。旧 Node 上没有 Net 这一档，出网本来就是通的，不加正好。
    if (l.network && ALLOW_NET !== null) args.push(ALLOW_NET);
    if (preload !== null) args.push(`--import=${pathToFileURL(preload).href}`);
    args.push(codeFile);
    return args;
  }

  protected override async run(workdir: string, codeFile: string): Promise<ExecResult> {
    const l = this.limits;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (ENV_ALLOWLIST.has(k) && v !== undefined) env[k] = v;
    }
    // 临时文件也只许落在 out/ 里 —— 别的地方权限模型也不让写。
    env["TMPDIR"] = path.join(workdir, "out");

    let preload: string | null = null;
    if (!l.network) {
      preload = path.join(workdir, "netblock.mjs");
      fs.writeFileSync(preload, NET_BLOCK_PRELOAD, "utf8");
    }

    const args = this.nodeArgs(workdir, codeFile, preload);

    // CPU 时间与单文件大小走 `ulimit`：Node 的 spawn 没有 preexec_fn，拿不到
    // setrlimit，而 sh 的 ulimit 是同一套 RLIMIT。`exec` 让 sh 把自己换成 node，
    // 所以 pid 仍然是 node 的 —— 中间不留一层壳，超时要杀的还是它。
    // RLIMIT_NPROC 没有对应物，但也不需要：权限模型已经默认拒绝 child_process /
    // worker_threads，fork 炸弹连第一个子进程都起不来。
    const posix = process.platform !== "win32";
    const fileBlocks = Math.max(1, Math.floor((l.maxOutDirMb * 1024 * 1024) / 512));
    const line = [
      `ulimit -t ${l.cpuSeconds} 2>/dev/null || :`,
      `ulimit -f ${fileBlocks} 2>/dev/null || :`,
      `exec ${[process.execPath, ...args].map(shQuote).join(" ")}`,
    ].join("; ");

    const t0 = performance.now();
    const child = posix
      ? spawn("/bin/sh", ["-c", line], {
          cwd: workdir,
          env,
          detached: true, // 独立进程组，超时能连子孙一起杀干净（os.setsid 的对等物）
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(process.execPath, args, {
          cwd: workdir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

    const cap = l.maxOutputBytes;
    const sink = (): { chunks: Buffer[]; n: number } => ({ chunks: [], n: 0 });
    const out = sink();
    const err = sink();
    const feed = (s: { chunks: Buffer[]; n: number }) => (b: Buffer) => {
      if (s.n >= cap) return; // 超了就不再往内存里堆 —— 结果与「先收全再切」一致
      s.chunks.push(b);
      s.n += b.length;
    };
    child.stdout?.on("data", feed(out));
    child.stderr?.on("data", feed(err));
    const text = (s: { chunks: Buffer[]; n: number }) =>
      Buffer.concat(s.chunks).subarray(0, cap).toString("utf8");

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, l.wallclockSeconds * 1000);

    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(new SandboxError(`沙箱子进程起不来: ${String(e)}`));
        });
        // 用 close 而不是 exit：exit 先到，stdout/stderr 可能还没读完，
        // 那样拿到的输出会随机缺一截。
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );

    const durationMs = Math.round(performance.now() - t0);
    if (timedOut) {
      // 与 Python 一致：超时只回一条说明，不回半截输出。
      return new ExecResult({
        ok: false,
        exitCode: null,
        stderr: `[sandbox] 超过墙钟上限 ${l.wallclockSeconds}s，已终止`,
        durationMs,
      });
    }

    return new ExecResult({
      ok: ended.code === 0,
      stdout: text(out),
      stderr: text(err),
      exitCode: exitCodeFor(ended.code, ended.signal),
      durationMs,
    });
  }
}

// ══════════════════════════════════════════════════════════════════
//  容器化（生产）
// ══════════════════════════════════════════════════════════════════
/** `shutil.which` 的对等物。不 spawn 任何东西 —— 只是查 PATH。 */
function which(cmd: string): string | null {
  if (cmd.includes(path.sep)) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

export interface ContainerSandboxOptions {
  /** 传给 `docker --runtime` 的值（`runsc` / `kata-runtime`）。 */
  readonly runtime: string;
  /** 执行镜像。应当是最小镜像 + 数据处理库（含 arquero），不带 shell 工具。 */
  readonly image?: string;
  readonly isolation?: string;
  readonly docker?: string;
  readonly limits?: SandboxLimits | null;
  readonly blockSuspicious?: boolean;
}

/** 通过外部运行时执行。gVisor / Firecracker 的共同实现。 */
export class ContainerSandbox extends SandboxExecutor {
  /**
   * 容器里 arquero 的**绝对路径**，不是裸名。
   *
   * 基类返回 `"arquero"`（本地档靠把宿主 node_modules 只读挂进去 + 绝对 file: URL
   * 解析）。容器里没有那份挂载，而 `NODE_PATH` 是 **CJS 时代的机制，对 ESM 的
   * `import` 完全不生效** —— 实测报 `Cannot find package 'arquero' imported from
   * /main.mts`，还贴心地建议 `arquero/src/index.js`。所以这里直接给镜像里的
   * 绝对路径（arquero 的 package.json 里 main/module 都是 ./src/index.js，
   * 没有 exports 字段，所以这条路径就是它的真入口）；镜像换布局时改这一处。
   */
  protected override arqueroSpecifier(): string {
    return "/sbx/node_modules/arquero/src/index.js";
  }

  readonly runtime: string;
  readonly image: string;
  readonly docker: string;

  constructor(opts: ContainerSandboxOptions) {
    super(opts.limits ?? null, opts.blockSuspicious ?? true);
    this.runtime = opts.runtime;
    this.image = opts.image ?? "ontocopilot/sandbox:node24";
    this.isolation = opts.isolation ?? "gvisor";
    this.docker = opts.docker ?? "docker";
    this.name = `container:${opts.runtime}`;
  }

  /**
   * 构造运行命令。单独拆出来是为了可测 —— 隔离参数写错了不会有报错，
   * 只会静默变得不安全，所以必须能断言。
   */
  command(workdir: string): string[] {
    const l = this.limits;
    return [
      this.docker,
      "run",
      "--rm",
      "--runtime",
      this.runtime,
      "--network",
      l.network ? "bridge" : "none", // 这一条才是真正的出网边界
      "--memory",
      `${l.memoryMb}m`,
      "--memory-swap",
      `${l.memoryMb}m`, // 禁用 swap，否则内存限制形同虚设
      "--cpus",
      "2",
      "--pids-limit",
      "128",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only", // 根文件系统只读
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "-v",
      `${path.join(workdir, "in")}:/in:ro`, // 输入只读
      "-v",
      `${path.join(workdir, "out")}:/out:rw`,
      "-v",
      `${path.join(workdir, "main.mts")}:/main.mts:ro`,
      "-w",
      "/out",
      "--user",
      "65534:65534", // nobody
      this.image,
      "node",
      `--max-old-space-size=${l.memoryMb}`,
      "/main.mts",
    ];
  }

  protected override async run(workdir: string, codeFile: string): Promise<ExecResult> {
    void codeFile; // 容器里的路径是挂载点 /main.mts，宿主路径由 command() 拼
    if (which(this.docker) === null) {
      throw new SandboxError(
        `找不到 ${this.docker}。生产环境必须用容器沙箱；本地开发请显式换成 ` +
          `LocalSubprocessSandbox 并知悉它没有内核隔离。`,
      );
    }

    const cmd = this.command(workdir);
    const t0 = performance.now();
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });

    const cap = this.limits.maxOutputBytes;
    const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
    child.stdout?.on("data", (b: Buffer) => chunks.out.push(b));
    child.stderr?.on("data", (b: Buffer) => chunks.err.push(b));

    let timedOut = false;
    // 容器多给 20s：拉起 runsc/kata 的开销不该算进用户代码的墙钟预算。
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, (this.limits.wallclockSeconds + 20) * 1000);

    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(new SandboxError(`起不了容器: ${String(e)}`));
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );

    const durationMs = Math.round(performance.now() - t0);
    if (timedOut) {
      return new ExecResult({ ok: false, stderr: "[sandbox] 容器超时，已终止", durationMs });
    }
    return new ExecResult({
      ok: ended.code === 0,
      stdout: Buffer.concat(chunks.out).subarray(0, cap).toString("utf8"),
      stderr: Buffer.concat(chunks.err).subarray(0, cap).toString("utf8"),
      exitCode: exitCodeFor(ended.code, ended.signal),
      durationMs,
    });
  }
}

/** S1：常规数据处理（arquero / exceljs）。启动快，用户态内核拦系统调用。 */
export function GVisorSandbox(
  kw: Omit<ContainerSandboxOptions, "runtime" | "isolation"> = {},
): ContainerSandbox {
  return new ContainerSandbox({ ...kw, runtime: "runsc", isolation: "gvisor" });
}

/**
 * 本地开发档：普通 `runc`。**明确标 `isolation = "container"`，不是 gvisor** ——
 * `production_safe` 的判据只认 gvisor/microvm，所以这一档如实地报"不安全到可以
 * 生产"。它给的是容器边界（`--network none`、只读根、cap-drop ALL、非 root），
 * 比 `node --permission` 的用户态补丁强，但共享宿主内核，挡不住内核漏洞。
 *
 * 存在的理由：绝大多数开发机（尤其 macOS Docker Desktop）**没有 runsc**。
 * 没有这一档的话，本地只能在"完全没有容器隔离"和"配一套 gVisor"之间二选一。
 */
export function RuncSandbox(
  kw: Omit<ContainerSandboxOptions, "runtime" | "isolation"> = {},
): ContainerSandbox {
  return new ContainerSandbox({ ...kw, runtime: "runc", isolation: "container" });
}

/** S2：未知来源二进制、扫描件 OCR。独立内核，隔离最强，启动慢。 */
export function FirecrackerSandbox(
  kw: Omit<ContainerSandboxOptions, "runtime" | "isolation"> = {},
): ContainerSandbox {
  return new ContainerSandbox({ ...kw, runtime: "kata-runtime", isolation: "microvm" });
}

/**
 * 按环境选沙箱。**默认不给生产级隔离，必须显式要**。
 *
 * 反过来（默认容器、找不到就悄悄降级到子进程）更危险 —— 部署时没人会注意到
 * 隔离已经没了。
 */
/**
 * `docker info` 报出来的运行时名字集合。
 *
 * **必须问运行时，不能只问 `docker` 在不在 PATH 上。** 这台机器上
 * `docker run --runtime runsc` 的结果是
 * `unknown or invalid runtime name: runsc` —— 探活过了、每次调用却必然失败，
 * 正是"模型反复重试一个永远不会成功的工具、把预算烧光"的那个形状。
 *
 * 结果缓存：装配工具表在对话每一轮都会发生，而起一次 `docker info` 要几十毫秒。
 */
const RUNTIME_CACHE = new Map<string, ReadonlySet<string>>();

export function dockerRuntimes(docker = "docker", refresh = false): ReadonlySet<string> {
  // 按二进制名分键：换个 docker 路径（测试注入、或换 podman shim）必须重新探，
  // 否则拿到的是上一个二进制的答案 —— 那种错只会在换环境时现形。
  const cached = RUNTIME_CACHE.get(docker);
  if (cached !== undefined && !refresh) return cached;
  let found = new Set<string>();
  try {
    const out = spawnSync(docker, ["info", "--format", "{{range $k,$v := .Runtimes}}{{$k}}\n{{end}}"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (out.status === 0) {
      found = new Set(
        String(out.stdout ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  } catch {
    // docker 不在 / daemon 没起 —— 空集合，调用方据此不注册 code.exec
  }
  RUNTIME_CACHE.set(docker, found);
  return found;
}

/** 测试用：清掉运行时探测的缓存。 */
export function resetRuntimeCache(): void {
  RUNTIME_CACHE.clear();
}

/**
 * 按**实际可用的运行时**挑最强的那一档；一个都没有就返回 null。
 *
 * 顺序即优先级：microvm > gvisor > 普通容器。前两个 `production_safe`，
 * 第三个不是 —— 但它仍然是真正的容器边界，好过完全没有。
 */
export function bestContainerSandbox(
  kw: Omit<ContainerSandboxOptions, "runtime" | "isolation"> = {},
): ContainerSandbox | null {
  const rts = dockerRuntimes(kw.docker ?? "docker");
  if (rts.has("kata-runtime")) return FirecrackerSandbox(kw);
  if (rts.has("runsc")) return GVisorSandbox(kw);
  if (rts.has("runc")) return RuncSandbox(kw);
  return null;
}

/**
 * 沙箱工作目录的父目录。
 *
 * 默认 `os.tmpdir()`，但**容器档下它经常挂不进去**：macOS 的 Docker Desktop
 * 默认只共享 `/Users`、`/Volumes`、`/private` 里的一部分，实测把
 * `/private/tmp` 挂进容器得到的是一个**空目录** —— 不是报错，是静默为空。
 * 于是 `docker run … -v <work>/main.mts:/main.mts:ro` 挂上去的是个不存在的文件，
 * 容器里报 `Cannot find module '/main.mts'`，而宿主这边一切正常。
 *
 * 所以给一个环境变量出口，并在 macOS 上默认落到 `~/.ontocopilot/sandbox` ——
 * 家目录是 Docker Desktop 默认共享的。
 */
export function sandboxTmpRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ONTOCOPILOT_SANDBOX_TMP"];
  const base =
    override !== undefined && override !== ""
      ? override
      : process.platform === "darwin"
        ? path.join(os.homedir(), ".ontocopilot", "sandbox")
        : tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.realpathSync(base);
}

export function defaultSandbox(
  opts: { production?: boolean } & Omit<ContainerSandboxOptions, "runtime" | "isolation"> = {},
): SandboxExecutor {
  const { production = false, ...kw } = opts;
  if (production) return GVisorSandbox(kw);
  return new LocalSubprocessSandbox(kw.limits ?? null, kw.blockSuspicious ?? false);
}

/**
 * 包装成 `glue/tools.ts` 里 `code.exec` 要的形状（那边的 `SandboxLike`）：
 * `exec(code, inputs) -> dict`。
 *
 * 交出去的是 `toDict()` 的结果而不是 `ExecResult` 本身 —— Python 那行就是
 * `return res.to_dict()`，工具返回值原样进模型上下文，多一个 `artifacts` 的
 * 字节数 map 只会白烧 token。
 */
export function asSandboxLike(executor: SandboxExecutor): {
  exec(code: string, inputs?: Record<string, unknown>): Promise<ExecResultDict>;
} {
  return {
    exec: async (code, inputs) => (await executor.exec(code, { inputs: inputs ?? {} })).toDict(),
  };
}
