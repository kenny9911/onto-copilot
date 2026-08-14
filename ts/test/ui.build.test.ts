/**
 * 构建产物的三道闸。**这是「没动样式」的唯一硬证据**，所以它必须是一条测试，
 * 而不是一次手动跑过的命令：
 *
 *   1. ui/index.html 的 CSS 与 HTML 与内联 JS 时代那份原件（git blob 52cc8bc）
 *      逐字节相同；
 *   2. 原件那 3495 行内联 JS 的每一行，在 ts/src/ui/ 里都找得到（TS 化的形变已归一
 *      化掉，找不到的必须写在豁免名单里并说明理由）；
 *   3. ui/index.html 与当前的 ts/src/ui/ 没有漂移 —— 改了源码忘了重新构建会被拦下。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const TS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(tool: string, ...args: string[]): string {
  return execFileSync(process.execPath, [resolve(TS, "tools", tool), ...args],
    { cwd: TS, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("ui 构建", () => {
  it("CSS 与 HTML 逐字节未变", () => {
    expect(run("verify-ui-shell.mjs")).toContain("CSS 与 HTML 逐字节未变");
  });

  it("原件的每一行内联 JS 都在移植件里", () => {
    expect(run("verify-ui-port.mjs")).toContain("原件的每一行都在移植件里找得到");
  });

  it("ui/index.html 与 ts/src/ui 没有漂移", () => {
    expect(run("build-ui.mjs", "--check")).toContain("与源码一致");
  });
}, 60_000);
