/**
 * 仓库根定位。**这条测试的存在是因为一次真实事故。**
 *
 * 原来各处写死 `resolve(HERE, "..", "..")`，从 `ts/src/main.ts` 跑是对的，从
 * `ts/dist/src/main.js` 跑就少算了 `dist/` 那一层，cwd 落在 `ts/`。后果不是报错，
 * 是**所有相对路径整体偏移一级**，且每处都伪装成毫不相干的毛病：
 * `workspace/` 变成 `ts/workspace/` 的空库 → 零账号 → 门禁进开放模式 →
 * 真账号登不进去，而真库就躺在旁边。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findRepoRoot } from "../src/repo_root.js";

/** 造一个假仓库（两个标志物都要有），返回它的根。 */
function fakeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
  mkdirSync(join(root, "ui"), { recursive: true });
  writeFileSync(join(root, "ui", "index.html"), "<!doctype html>");
  mkdirSync(join(root, "ts"), { recursive: true });
  writeFileSync(join(root, "ts", "package.json"), "{}");
  return root;
}

describe("findRepoRoot", () => {
  it("源码布局：从 ts/src 找得到根", () => {
    const root = fakeRepo();
    const from = join(root, "ts", "src");
    mkdirSync(from, { recursive: true });
    expect(findRepoRoot(from)).toBe(root);
  });

  it("**dist 布局：从 ts/dist/src 也找得到同一个根** —— 这一条就是那次登录不上的根因", () => {
    const root = fakeRepo();
    const from = join(root, "ts", "dist", "src");
    mkdirSync(from, { recursive: true });
    expect(findRepoRoot(from)).toBe(root);
    // 写死上两级会停在 ts/dist —— 正是它把 workspace/ 指到了空库上。
    expect(findRepoRoot(from)).not.toBe(join(root, "ts"));
  });

  it("两种布局解析出的是同一个根 —— 换个跑法不该换一个库", () => {
    const root = fakeRepo();
    const src = join(root, "ts", "src", "server");
    const dist = join(root, "ts", "dist", "src", "server");
    mkdirSync(src, { recursive: true });
    mkdirSync(dist, { recursive: true });
    expect(findRepoRoot(src, 3)).toBe(findRepoRoot(dist, 3));
  });

  // 这一条是哨兵测试抓出来的：只认 ui/index.html 时，app.ts 的 PACKAGED_UI
  // （就是 HERE/ui）第一级就命中，打包目录把自己冒充成了仓库根，前端于是继续
  // 读那份不会自动同步的打包副本 —— 表面上"修好了"，实际什么也没变。
  it("打包目录旁边的 ui/ 不能冒充仓库根", () => {
    const root = fakeRepo();
    const here = join(root, "ts", "dist", "src", "server");
    mkdirSync(join(here, "ui"), { recursive: true });
    writeFileSync(join(here, "ui", "index.html"), "<!doctype html>打包副本");
    // 起步那一级自己就带着 ui/index.html，但没有 ts/package.json → 不该被认成根
    expect(findRepoRoot(here, 3)).toBe(root);
    expect(findRepoRoot(here, 3)).not.toBe(here);
  });

  it("找不到标志物时退回指定级数，不把 cwd 甩到文件系统根上", () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), "oc-orphan-")));
    const from = join(orphan, "a", "b", "c");
    mkdirSync(from, { recursive: true });
    expect(findRepoRoot(from, 2)).toBe(join(orphan, "a"));
    expect(findRepoRoot(from, 3)).toBe(orphan);
  });
});
