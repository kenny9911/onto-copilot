/**
 * 沙箱**分档选择**的测试：探运行时、按可用档降级、工作目录落在挂得进容器的地方。
 *
 * 这一层过去是靠"docker 在不在 PATH 上"决定的，于是这台机器上
 * `docker run --runtime runsc` 每次都返回 `unknown or invalid runtime name: runsc`
 * —— 探活过了、调用必然失败，正是"模型反复重试一个永远不会成功的工具、
 * 把预算烧光"的形状。所以测试注入假 docker，断的是**选档逻辑**本身。
 *
 * 真容器的执行与边界（无网 / 只读根 / 非 root）在 `kernel.sandbox.docker.test.ts`，
 * 那一组需要 docker daemon，默认跳过。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ContainerSandbox,
  FirecrackerSandbox,
  GVisorSandbox,
  RuncSandbox,
  bestContainerSandbox,
  dockerRuntimes,
  resetRuntimeCache,
  sandboxTmpRoot,
} from "../src/kernel/sandbox.js";

/** 造一个假 docker：`docker info --format …` 打印给定的运行时名，每行一个。 */
function fakeDocker(dir: string, name: string, runtimes: string[], status = 0): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${runtimes.map((r) => `echo ${r}`).join("\n")}\nexit ${status}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("dockerRuntimes：探的是运行时，不是 docker 在不在", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-fakedocker-"));
    resetRuntimeCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRuntimeCache();
  });

  it("解析出运行时名集合，空行被丢掉", () => {
    const d = fakeDocker(dir, "d1", ["runc", "", "  runsc  "]);
    expect([...dockerRuntimes(d)].sort()).toEqual(["runc", "runsc"]);
  });

  it("docker 不存在 → 空集合，不抛", () => {
    expect(dockerRuntimes(join(dir, "不存在的docker")).size).toBe(0);
  });

  it("docker 非零退出（daemon 没起）→ 空集合，不采信 stdout", () => {
    const d = fakeDocker(dir, "d2", ["runc"], 1);
    expect(dockerRuntimes(d).size).toBe(0);
  });

  it("按二进制名分键缓存 —— 换个 docker 必须重新探", () => {
    const a = fakeDocker(dir, "da", ["runc"]);
    const b = fakeDocker(dir, "db", ["runsc"]);
    expect([...dockerRuntimes(a)]).toEqual(["runc"]);
    // 若缓存不分键，这里会拿到上一个二进制的 ["runc"]
    expect([...dockerRuntimes(b)]).toEqual(["runsc"]);
  });

  it("同一个二进制第二次走缓存；refresh 强制重探", () => {
    const d = join(dir, "dyn");
    writeFileSync(d, "#!/bin/sh\necho runc\n");
    chmodSync(d, 0o755);
    expect([...dockerRuntimes(d)]).toEqual(["runc"]);
    writeFileSync(d, "#!/bin/sh\necho runsc\n"); // 二进制变了
    expect([...dockerRuntimes(d)]).toEqual(["runc"]); // 仍走缓存
    expect([...dockerRuntimes(d, true)]).toEqual(["runsc"]);
  });
});

describe("bestContainerSandbox：按实际可用的运行时降级", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-fakedocker-"));
    resetRuntimeCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRuntimeCache();
  });

  const iso = (s: ContainerSandbox | null): unknown =>
    s === null ? null : (s.describe() as Record<string, unknown>)["isolation"];

  it("kata 在场 → microvm（最强档优先）", () => {
    expect(iso(bestContainerSandbox({ docker: fakeDocker(dir, "k", ["runc", "kata-runtime"]) }))).toBe(
      "microvm",
    );
  });

  it("只有 runsc → gvisor", () => {
    expect(iso(bestContainerSandbox({ docker: fakeDocker(dir, "g", ["runc", "runsc"]) }))).toBe(
      "gvisor",
    );
  });

  it("只有 runc → container（真容器边界，但不 production_safe）", () => {
    const s = bestContainerSandbox({ docker: fakeDocker(dir, "r", ["runc"]) });
    expect(iso(s)).toBe("container");
    expect((s?.describe() as Record<string, unknown>)["production_safe"]).toBe(false);
  });

  it("一个运行时都没有 → null，**不悄悄降级到子进程**", () => {
    // 降级到"没有隔离"比报错危险得多：部署时没人会注意到边界已经没了。
    expect(bestContainerSandbox({ docker: join(dir, "无") })).toBeNull();
  });
});

describe("各档的自述与 production_safe 判据", () => {
  it("runc 档如实报 production_safe = false —— 共享宿主内核", () => {
    const d = RuncSandbox({}).describe() as Record<string, unknown>;
    expect(d["isolation"]).toBe("container");
    expect(d["production_safe"]).toBe(false);
  });

  it("gvisor / microvm 才算 production_safe", () => {
    expect((GVisorSandbox({}).describe() as Record<string, unknown>)["production_safe"]).toBe(true);
    expect((FirecrackerSandbox({}).describe() as Record<string, unknown>)["production_safe"]).toBe(
      true,
    );
  });
});

describe("sandboxTmpRoot：工作目录必须挂得进容器", () => {
  const KEY = "ONTOCOPILOT_SANDBOX_TMP";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("环境变量覆盖优先，且目录被建出来", () => {
    const want = join(mkdtempSync(join(tmpdir(), "oc-sbxroot-")), "深", "一层");
    expect(sandboxTmpRoot({ [KEY]: want })).toContain("一层");
  });

  it("空字符串不算覆盖 —— 视同没设", () => {
    const got = sandboxTmpRoot({ [KEY]: "" });
    expect(got).not.toBe("");
  });

  it.runIf(process.platform === "darwin")(
    "macOS 默认落在家目录下：Docker Desktop 默认不共享 /private/tmp，挂进去是**静默的空目录**",
    () => {
      // 静默为空，不是报错 —— 容器里报 `Cannot find module '/main.mts'`，
      // 宿主这边一切正常，是最难查的那种。
      expect(sandboxTmpRoot({})).toContain(homedir());
    },
  );
});
