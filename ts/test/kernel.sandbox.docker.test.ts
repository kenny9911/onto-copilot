/**
 * 真容器：**执行**跑得通、**边界**关得住。
 *
 * 需要本机 docker daemon + `ontocopilot/sandbox:node24` 镜像，没有就整组跳过 ——
 * 装了 docker 的机器上它是真的在跑容器，CI 上它是零成本的。
 * 镜像构建见 `tools/sandbox-image/`。
 *
 * 为什么值得花这个钱：选档逻辑（tier 那组）测的是"挑了哪一档"，测不出
 * "挑中的那一档能不能真跑"。这两个 bug 在这个项目里都真实发生过 ——
 * `--runtime runsc` 挑得很对、每次调用都失败；`/private/tmp` 挂进去
 * **静默变成空目录**，宿主一切正常、容器里 `Cannot find module '/main.mts'`。
 */

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { RuncSandbox, dockerRuntimes } from "../src/kernel/sandbox.js";

const IMAGE = "ontocopilot/sandbox:node24";

function ready(): boolean {
  if (!dockerRuntimes().has("runc")) return false;
  const r = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf-8", timeout: 10_000 });
  return r.status === 0;
}

const RUN = ready();

describe.runIf(RUN)("容器沙箱：真执行", () => {
  const sbx = RuncSandbox({});

  it("代码在容器里跑完，emit 的结果回得来", async () => {
    const r = await sbx.exec(`emit({ sum: [1,2,3,4].reduce((a,b)=>a+b,0), where: "container" });`, {});
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ sum: 10, where: "container" });
  }, 120_000);

  it("arquero 在容器里 import 得到 —— 裸名解析不了，得给镜像内绝对路径", async () => {
    // `NODE_PATH` 是 CJS 时代的机制，对 ESM 的 import **完全不生效**：
    // 实测报 `Cannot find package 'arquero' imported from /main.mts`。
    const r = await sbx.exec(`const t = aq.table({ a: INPUTS.a }); emit({ rows: t.numRows() });`, {
      inputs: { a: [1, 2, 3] },
    });
    expect(r.ok).toBe(true);
    expect((r.result as Record<string, unknown>)["rows"]).toBe(3);
  }, 120_000);
});

describe.runIf(RUN)("容器沙箱：边界关得住", () => {
  const sbx = RuncSandbox({});

  // 静态扫描（exec 前拒绝可疑模式）是第一层，这里刻意绕过它 ——
  // 验的是**第二层**。纵深防御的意义就在于扫描器被绕过时下面还有东西。
  it("出网：ENETUNREACH（--network none），扫描器被绕过也一样", async () => {
    const r = await sbx.exec(
      `const f = globalThis["fet"+"ch"];
       try { const x = await f("http://1.1.1.1/"); emit({ net: "通了 " + x.status }); }
       catch (e) { emit({ net: String(e.cause?.code ?? e.message) }); }`,
      {},
    );
    expect(r.ok).toBe(true);
    expect((r.result as Record<string, unknown>)["net"]).toBe("ENETUNREACH");
  }, 120_000);

  it("宿主家目录读不到：ENOENT（没挂进去）", async () => {
    const r = await sbx.exec(
      `import { readFileSync } from "node:fs";
       try { readFileSync("${process.env["HOME"]}/.zshrc", "utf8"); emit({ fs: "读到了" }); }
       catch (e) { emit({ fs: String(e.code ?? e.message) }); }`,
      {},
    );
    expect((r.result as Record<string, unknown>)["fs"]).toBe("ENOENT");
  }, 120_000);

  it("根文件系统只读：EROFS", async () => {
    const r = await sbx.exec(
      `import { writeFileSync } from "node:fs";
       try { writeFileSync("/evil", "x"); emit({ root: "写进去了" }); }
       catch (e) { emit({ root: String(e.code ?? e.message) }); }`,
      {},
    );
    expect((r.result as Record<string, unknown>)["root"]).toBe("EROFS");
  }, 120_000);

  it("非 root 运行：uid 是 nobody(65534)，不是 0", async () => {
    const r = await sbx.exec(`emit({ uid: process.getuid() });`, {});
    expect((r.result as Record<string, unknown>)["uid"]).not.toBe(0);
  }, 120_000);

  it("静态扫描仍是第一层：明写 fetch 在起容器**之前**就被拒", async () => {
    // 起容器要几百毫秒，能在进程内挡掉的就别花那个钱。
    await expect(sbx.exec(`await fetch("http://x/");`, {})).rejects.toThrow(/network/);
  });
});
