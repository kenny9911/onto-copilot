/**
 * 沙箱 —— 这一层没有算法，只有**边界**，所以测试全都在问同一个问题：
 * 「说好挡住的，真的挡住了吗？」
 *
 * 每一条都真的起一个子进程、真的跑一遍模型可能写出来的代码。**不 mock** ——
 * mock 掉 spawn 之后剩下的只是「参数拼对了没有」，而隔离参数拼对了不等于隔离
 * 生效了（写错一个 `--allow-fs-write` 不会报错，只会静默变得不安全）。
 *
 * 出网那一条尤其：测试自己起一个 HTTP 服务，让沙箱去打它，然后断言
 * **服务端一个请求都没收到**。只断言「抛了个错」是不够的 —— 错可能来自别处。
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SandboxError } from "../src/kernel/errors.js";
import {
  ContainerSandbox,
  DEFAULT_LIMITS,
  ExecResult,
  FirecrackerSandbox,
  GVisorSandbox,
  LocalSubprocessSandbox,
  asSandboxLike,
  defaultSandbox,
  sandboxLimits,
  scan,
} from "../src/kernel/sandbox.js";

/** 起子进程 + 加载 arquero 大约几百毫秒；vitest 默认的 5s 不够跑完一组。 */
const SLOW = 90_000;

/** 测试用的短上限：墙钟 30s 足够跑完任何一条正常用例，又不至于挂死 CI。 */
const fast = (over: Partial<typeof DEFAULT_LIMITS> = {}) =>
  sandboxLimits({ wallclockSeconds: 30, cpuSeconds: 30, memoryMb: 512, ...over });

const sbx = (over: Partial<typeof DEFAULT_LIMITS> = {}) =>
  new LocalSubprocessSandbox(fast(over));

describe("scan：记账与告警，不是安全边界", () => {
  it("命中网络 / 子进程 / 动态执行，桶名与 Python 版一致", () => {
    expect(scan(`import net from "node:net";`)).toContain("network");
    expect(scan(`const { execSync } = require("child_process");`)).toContain("subprocess");
    expect(scan(`await fetch("http://x")`)).toContain("network"); // undici 走 fetch 全局
    expect(scan(`const f = new Function("return 1")`)).toContain("dynamic_exec");
    expect(scan(`eval("1+1")`)).toContain("dynamic_exec");
    expect(scan(`console.log(process.env.OPENAI_API_KEY)`)).toContain("env_probe");
    expect(scan(`fs.readFileSync("/etc/passwd")`)).toContain("fs_escape");
    expect(scan(`http.get(url)`)).toContain("network"); // 裸用形式，没有 import
  });

  it("干净的数据变换代码不报任何 flag", () => {
    const code = `const t = aq.from(INPUTS.rows).groupby("g").rollup({ n: aq.op.count() });
emit(t.objects());`;
    expect(scan(code)).toEqual([]);
  });

  it("`Function(` 大小写敏感 —— 否则每个 `function (` 都会命中", () => {
    // 这是相对 Python 版的唯一判据变化：那边把整段代码 lower() 之后再找子串。
    expect(scan(`function makeRow(x) { return x; }`)).toEqual([]);
    expect(scan(`const g = Function("return 1")`)).toContain("dynamic_exec");
  });

  it("`net.` 这类裸用要求词边界 —— `planet.x` 不算出网", () => {
    expect(scan(`const planet = {}; planet.name = "地球";`)).toEqual([]);
    expect(scan(`const nethttp = {}; nethttp.x = 1;`)).toEqual([]);
  });

  it("去重且保序（同一个桶被两条规则命中只出现一次）", () => {
    const flags = scan(`import cp from "node:child_process"; cp.execSync("ls")`);
    expect(flags.filter((f) => f === "subprocess")).toHaveLength(1);
  });

  it("扫描绕得过去 —— 这正是它不能当边界的原因", () => {
    // 留一条用例把这件事钉在纸面上：下一个人想「加强扫描来替代隔离」时，
    // 先看到这里。
    expect(scan(`const m = await import("ne" + "t");`)).toEqual([]);
  });
});

describe("blockSuspicious：按策略拒绝", () => {
  it("命中即抛 SandboxError，消息里带 flag 列表", async () => {
    const s = new LocalSubprocessSandbox(fast(), true);
    await expect(s.exec(`import net from "node:net";`)).rejects.toThrow(SandboxError);
    await expect(s.exec(`import net from "node:net";`)).rejects.toThrow(
      "代码命中可疑模式 ['network']，已按策略拒绝执行",
    );
  });

  it("默认不拦，只记账 —— flags 跟着结果一起回来", async () => {
    const res = await sbx().exec(`console.log("ok")\nconst x = process.env;`);
    expect(res.flags).toContain("env_probe");
    expect(res.ok).toBe(true);
  }, SLOW);
});

describe("正常执行", () => {
  it("跑通 + INPUTS 注入 + emit 交回结构化结果", async () => {
    const res = await sbx().exec(
      `console.log("hello", INPUTS.name);
emit({ doubled: INPUTS.n * 2, dir_ok: OUT_DIR.endsWith("out") });`,
      { inputs: { name: "OntoCopilot", n: 21 } },
    );
    expect(res.stderr).toBe("");
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello OntoCopilot");
    expect(res.result).toEqual({ doubled: 42, dir_ok: true });
    expect(res.durationMs).toBeGreaterThan(0);
  }, SLOW);

  it("模型写 TypeScript（带类型标注）也能跑 —— 文件是 .mts，Node 直接剥类型", async () => {
    const res = await sbx().exec(
      `const rows: { g: string; v: number }[] = INPUTS.rows;
const total: number = rows.reduce((a, r) => a + r.v, 0);
emit({ total });`,
      { inputs: { rows: [{ g: "a", v: 1 }, { g: "b", v: 2 }] } },
    );
    expect(res.stderr).toBe("");
    expect(res.result).toEqual({ total: 3 });
  }, SLOW);

  it("aq(arquero) 预先注入：groupby / rollup 直接可用", async () => {
    const res = await sbx().exec(
      `const t = aq.from(INPUTS.rows)
  .groupby("dept")
  .rollup({ n: aq.op.count(), amount: (d) => aq.op.sum(d.amount) })
  .orderby("dept");
emit(t.objects());`,
      {
        inputs: {
          rows: [
            { dept: "采购", amount: 100 },
            { dept: "采购", amount: 50 },
            { dept: "财务", amount: 7 },
          ],
        },
      },
    );
    expect(res.stderr).toBe("");
    expect(res.result).toEqual([
      { dept: "财务", n: 1, amount: 7 },
      { dept: "采购", n: 2, amount: 150 },
    ]);
  }, SLOW);

  it("emit(表) 也认 —— 直接交 arquero Table 不会静默变成 {}", async () => {
    // Table 自带 toJSON 且返回**字符串**，JSON.stringify 的 replacer 拦不住它
    // （规范里 toJSON 先于 replacer 跑），所以嵌在对象里的那一份也要验。
    const res = await sbx().exec(
      `emit({ flat: aq.from([{ a: 1 }, { a: 2 }]), nested: { t: aq.from([{ b: 3 }]) } });`,
    );
    expect(res.result).toEqual({ flat: [{ a: 1 }, { a: 2 }], nested: { t: [{ b: 3 }] } });
  }, SLOW);

  it("代码抛异常：ok=false、退出码非 0、堆栈进 stderr", async () => {
    const res = await sbx().exec(`throw new Error("业务算错了");`);
    expect(res.ok).toBe(false);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("业务算错了");
  }, SLOW);

  it("result.json 不是合法 JSON 时给出可诊断的 stderr，而不是静默丢结果", async () => {
    const res = await sbx().exec(
      `import fs from "node:fs";
fs.writeFileSync(OUT_DIR + "/result.json", "{ 这不是 JSON");`,
    );
    expect(res.result).toBeNull();
    expect(res.stderr).toContain("/out/result.json 不是合法 JSON");
  }, SLOW);
});

describe("资源上限", () => {
  it("墙钟超时：kill 掉整个进程组，exit_code 为 null", async () => {
    const res = await sbx({ wallclockSeconds: 3, cpuSeconds: 60 }).exec(
      `while (true) { /* 死循环 */ }`,
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toBe("[sandbox] 超过墙钟上限 3s，已终止");
    expect(res.durationMs).toBeLessThan(20_000);
  }, SLOW);

  it("CPU 上限：墙钟还没到就被 SIGXCPU 杀掉（exit_code 是负的信号号）", async () => {
    const res = await sbx({ cpuSeconds: 1, wallclockSeconds: 30 }).exec(
      `let x = 0; while (true) { x += Math.sqrt(x + 1); }`,
    );
    expect(res.ok).toBe(false);
    // 被信号杀死 ⇒ Python 的 returncode 语义是 -signum。SIGXCPU = 24。
    expect(res.exitCode).toBe(-os.constants.signals.SIGXCPU);
    expect(res.durationMs).toBeLessThan(20_000);
  }, SLOW);

  it("内存上限：堆爆掉，不是把宿主拖垮", async () => {
    const res = await sbx({ memoryMb: 64, wallclockSeconds: 60 }).exec(
      `const keep = [];
while (true) { keep.push(new Array(10_000).fill(Math.random())); }`,
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/heap out of memory|JavaScript heap|Allocation failed/i);
  }, SLOW);

  it("输出截断：stdout / stderr 都不超过 max_output_bytes", async () => {
    const res = await sbx({ maxOutputBytes: 1000 }).exec(
      `for (let i = 0; i < 500; i++) console.log("x".repeat(200));
for (let i = 0; i < 500; i++) console.error("y".repeat(200));`,
    );
    expect(Buffer.byteLength(res.stdout)).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(res.stderr)).toBeLessThanOrEqual(1000);
    expect(res.stdout.startsWith("xxx")).toBe(true);
  }, SLOW);

  it("产物总量超上限：丢弃并说明，不让它悄悄进下游", async () => {
    const res = await sbx({ maxOutDirMb: 1 }).exec(
      `import fs from "node:fs";
for (let i = 0; i < 3; i++) fs.writeFileSync(OUT_DIR + "/big" + i + ".txt", "z".repeat(600_000));`,
    );
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("产物超过 1MB 上限");
    expect(res.toDict().artifacts).toEqual([]);
  }, SLOW);
});

describe("隔离：文件系统", () => {
  it("读宿主任意文件被权限模型挡住", async () => {
    const res = await sbx().exec(
      `import fs from "node:fs";
try { fs.readFileSync("/etc/hosts", "utf8"); emit({ leaked: true }); }
catch (e) { emit({ leaked: false, code: e.code }); }`,
    );
    expect(res.result).toEqual({ leaked: false, code: "ERR_ACCESS_DENIED" });
  }, SLOW);

  it("往 OUT_DIR 之外写被挡住（宿主临时目录也不行）", async () => {
    const target = path.join(os.tmpdir(), "oc-sbx-escape-probe.txt");
    fs.rmSync(target, { force: true });
    const res = await sbx().exec(
      `import fs from "node:fs";
try { fs.writeFileSync(INPUTS.target, "pwned"); emit({ wrote: true }); }
catch (e) { emit({ wrote: false, code: e.code }); }`,
      { inputs: { target } },
    );
    expect(res.result).toMatchObject({ wrote: false, code: "ERR_ACCESS_DENIED" });
    expect(fs.existsSync(target)).toBe(false);
  }, SLOW);

  it("起子进程被挡住 —— 否则所有上限都能被一个 `sh -c` 绕开", async () => {
    const res = await sbx().exec(
      `try { const cp = await import("node:child_process"); cp.execSync("echo pwned"); emit({ ran: true }); }
catch (e) { emit({ ran: false, code: e.code }); }`,
    );
    expect(res.result).toEqual({ ran: false, code: "ERR_ACCESS_DENIED" });
  }, SLOW);

  it("files 参数：只读拷进 IN_DIR，沙箱里读得到", async () => {
    const src = path.join(os.tmpdir(), `oc-sbx-in-${process.pid}.csv`);
    fs.writeFileSync(src, "a,b\n1,2\n", "utf8");
    try {
      const res = await sbx().exec(
        `import fs from "node:fs";
emit({ text: fs.readFileSync(IN_DIR + "/in.csv", "utf8") });`,
        { files: { "in.csv": src } },
      );
      expect(res.result).toEqual({ text: "a,b\n1,2\n" });
    } finally {
      fs.rmSync(src, { force: true });
    }
  }, SLOW);
});

describe("隔离：出网", () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.end("secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("真发请求：fetch / http.get / net.connect 全部失败，服务端一个请求都没收到", async () => {
    const before = hits;
    const res = await sbx().exec(
      `import { connect } from "node:net";
import http from "node:http";
const url = "http://127.0.0.1:" + INPUTS.port + "/";
const out = {};

try { const r = await fetch(url); out.fetch = "OK:" + r.status; }
catch (e) { out.fetch = e.code || e.message; }

try { http.get(url, () => { out.http = "OK"; }); out.http ??= "OK-no-throw"; }
catch (e) { out.http = e.code || e.message; }

try { connect(INPUTS.port, "127.0.0.1"); out.net = "OK"; }
catch (e) { out.net = e.code || e.message; }

try { const s = new (await import("node:net")).Socket(); s.connect(INPUTS.port, "127.0.0.1"); out.socket = "OK"; }
catch (e) { out.socket = e.code || e.message; }

emit(out);`,
      { inputs: { port } },
    );
    expect(res.result).toEqual({
      fetch: "ERR_SANDBOX_NETWORK_DENIED",
      http: "ERR_SANDBOX_NETWORK_DENIED",
      net: "ERR_SANDBOX_NETWORK_DENIED",
      socket: "ERR_SANDBOX_NETWORK_DENIED",
    });
    // 最重要的一行：不是「抛了个错」，是**真的没打出去**。
    expect(hits).toBe(before);
  }, SLOW);

  it("worker_threads 起不来 —— 否则新 isolate 里的 net 是没打过补丁的", async () => {
    const res = await sbx().exec(
      `try { await import("node:worker_threads").then((w) => new w.Worker("", { eval: true })); emit({ ran: true }); }
catch (e) { emit({ ran: false, code: e.code }); }`,
    );
    expect(res.result).toMatchObject({ ran: false, code: "ERR_ACCESS_DENIED" });
  }, SLOW);

  it("limits.network=true 时不打补丁（沙箱不是唯一的出网禁令来源）", async () => {
    const before = hits;
    const res = await sbx({ network: true }).exec(
      `const r = await fetch("http://127.0.0.1:" + INPUTS.port + "/");
emit({ body: await r.text() });`,
      { inputs: { port } },
    );
    expect(res.result).toEqual({ body: "secret" });
    expect(hits).toBe(before + 1);
  }, SLOW);
});

describe("产物回收", () => {
  it("OUT_DIR 里的文件按名字列进 artifacts，result.json 也在里面", async () => {
    const res = await sbx().exec(
      `import fs from "node:fs";
fs.writeFileSync(OUT_DIR + "/report.csv", "a,b\\n1,2\\n");
fs.writeFileSync(OUT_DIR + "/chart.svg", "<svg/>");
emit({ done: true });`,
    );
    expect(res.toDict().artifacts).toEqual(["chart.svg", "report.csv", "result.json"]);
    expect(res.artifacts["report.csv"]).toBe(8);
    expect(res.result).toEqual({ done: true });
  }, SLOW);

  it("工作目录执行完就删干净（成功和失败都删）", async () => {
    const left = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("oc-sbx-"));
    const before = left().length;
    await sbx().exec(`emit({ ok: 1 });`);
    await sbx().exec(`throw new Error("boom");`);
    expect(left().length).toBe(before);
  }, SLOW);
});

describe("ExecResult.to_dict()：工具的对外契约", () => {
  it("字段名与 Python 逐字段一致，一个不多一个不少", () => {
    const r = new ExecResult({
      ok: true,
      stdout: "o",
      stderr: "e",
      exitCode: 0,
      durationMs: 5,
      artifacts: { "b.csv": 2, "a.csv": 1 },
      result: { x: 1 },
      flags: ["network"],
    });
    expect(Object.keys(r.toDict())).toEqual([
      "ok",
      "exit_code",
      "duration_ms",
      "stdout",
      "stderr",
      "artifacts",
      "result",
      "flags",
    ]);
    // artifacts 交出去的是**键**，不是 {名: 字节数}。
    expect(r.toDict().artifacts).toEqual(["b.csv", "a.csv"]);
  });

  it("stdout / stderr 只留最后 4000 个**码点**（不是码元）", () => {
    const long = "藏".repeat(5000);
    expect(new ExecResult({ ok: true, stdout: long }).toDict().stdout).toHaveLength(4000);

    // 4000 个星号 emoji = 8000 个码元。按码元切会切在代理对中间，留下落单代理，
    // 那东西一路混进 JSON 才炸。
    const emoji = "🙂".repeat(5000);
    const cut = new ExecResult({ ok: true, stdout: emoji }).toDict().stdout;
    expect(Array.from(cut)).toHaveLength(4000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
  });

  it("asSandboxLike 交出去的就是 to_dict() 的形状", async () => {
    const like = asSandboxLike(sbx());
    const out = await like.exec(`emit({ a: INPUTS.a });`, { a: 9 });
    expect(out.result).toEqual({ a: 9 });
    expect(out.ok).toBe(true);
    expect(Object.hasOwn(out, "exit_code")).toBe(true);
  }, SLOW);
});

describe("describe()：隔离强度必须可见", () => {
  it("本地子进程明说自己不是生产级", () => {
    expect(new LocalSubprocessSandbox().describe()).toEqual({
      name: "local-subprocess",
      isolation: "process",
      production_safe: false,
      limits: { cpu_s: 60, wall_s: 180, mem_mb: 2048, network: false },
    });
  });

  it("gVisor / Firecracker 才算生产安全", () => {
    expect(GVisorSandbox().describe()).toMatchObject({
      name: "container:runsc",
      isolation: "gvisor",
      production_safe: true,
    });
    expect(FirecrackerSandbox().describe()).toMatchObject({
      name: "container:kata-runtime",
      isolation: "microvm",
      production_safe: true,
    });
  });

  it("default_sandbox 默认给的是**开发用**沙箱，生产级必须显式要", () => {
    expect(defaultSandbox()).toBeInstanceOf(LocalSubprocessSandbox);
    expect(defaultSandbox({ production: true })).toBeInstanceOf(ContainerSandbox);
    expect(defaultSandbox({ production: true }).isolation).toBe("gvisor");
  });
});

describe("命令行：写错了不会报错，只会静默变得不安全", () => {
  it("容器：无网 + 只读根 + 输入只读 + 掉光 capability + nobody", () => {
    const cmd = GVisorSandbox({ limits: sandboxLimits({ memoryMb: 256 }) }).command("/w");
    const joined = cmd.join(" ");
    expect(cmd.slice(0, 6)).toEqual(["docker", "run", "--rm", "--runtime", "runsc", "--network"]);
    expect(joined).toContain("--network none");
    expect(joined).toContain("--memory 256m --memory-swap 256m"); // 不禁 swap 等于没限
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--pids-limit 128");
    expect(joined).toContain(`${path.join("/w", "in")}:/in:ro`);
    expect(joined).toContain(`${path.join("/w", "out")}:/out:rw`);
    expect(joined).toContain("--user 65534:65534");
    expect(cmd.at(-1)).toBe("/main.mts");
  });

  it("容器：limits.network=true 才换成 bridge", () => {
    const cmd = GVisorSandbox({ limits: sandboxLimits({ network: true }) }).command("/w");
    expect(cmd.join(" ")).toContain("--network bridge");
  });

  it("本地：权限模型只放行工作目录读 + out 写，其余一律不给", () => {
    const s = new LocalSubprocessSandbox(fast({ memoryMb: 333 }));
    const args = s.nodeArgs("/w", "/w/main.mts", "/w/netblock.mjs");
    expect(args[0]).toBe("--permission");
    expect(args).toContain("--allow-fs-read=/w");
    expect(args).toContain(`--allow-fs-write=${path.join("/w", "out")}`);
    expect(args).toContain("--max-old-space-size=333");
    // 写权限**只有一个**，且指向 out。多一个就是多一条逃逸路径。
    expect(args.filter((a) => a.startsWith("--allow-fs-write="))).toHaveLength(1);
    // 没有任何 --allow-child-process / --allow-worker / --allow-addons。
    expect(args.some((a) => /^--allow-(child-process|worker|addons|wasi|inspector)/.test(a))).toBe(
      false,
    );
    expect(args.at(-1)).toBe("/w/main.mts");
    expect(args.some((a) => a.startsWith("--import=") && a.includes("netblock.mjs"))).toBe(true);
  });
});
