/**
 * 仓库根的定位。**从源码跑和从 `dist/` 跑，目录深度不一样。**
 *
 * 这里曾经是各处手写的 `resolve(HERE, "..", "..")`：
 *
 *     ts/src/main.ts        → 上两级 = 仓库根            ✅
 *     ts/dist/src/main.js   → 上两级 = ts/               ❌ 少算了 dist 这一层
 *
 * 少算一层的后果不是报错，而是**一切相对路径整体偏移一级**，且每一处都表现成
 * 完全不同的怪毛病，谁也想不到是同一个原因：
 *
 *   * `workspace/` → `ts/workspace/`：开的是一个空库。库里零账号，门禁据此判定
 *     "全新实例"进开放模式、注入合成管理员，于是**真账号怎么输都登不进去** ——
 *     而真库好端端躺在旁边。
 *   * `ui/index.html` → `ts/ui/index.html`：该目录不存在，回落到打包副本，于是
 *     前端改了却不生效，而 `ui/index.html` 明明是新的。
 *   * `.env` → `ts/.env`：不存在，报一句"缺少 LLM 网关配置"，而 `.env` 就在那儿。
 *
 * 所以不再数层数，改成**向上找标志物**：带 `ui/index.html` 的那一级就是仓库根。
 * 层数会变，标志物不会。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * 认仓库根的标志物 —— **两个都要满足**。
 *
 * 只用 `ui/index.html` 不够，这一点是被哨兵测试当场抓住的：`app.ts` 的
 * `PACKAGED_UI` 就是 `HERE/ui`，也就是说**打包目录自己长得和仓库根一模一样**。
 * 于是从 `ts/dist/src/server` 起步时第一级就"命中"，把打包目录认成仓库根，
 * 前端照旧读那份不会自动同步的打包副本 —— 修了个寂寞。
 *
 * 加上 `ts/package.json`：它只在源码检出里存在，不可能出现在 `HERE/ui` 旁边。
 * 两个条件一起，两种布局都只命中真正的仓库根。真的打包安装两个都不满足，
 * 走 fallback，`uiDir()` 再回落到 `PACKAGED_UI` —— 那才是它该起作用的场合。
 */
const MARKERS = [join("ui", "index.html"), join("ts", "package.json")] as const;

/**
 * 从 `fromDir` 逐级向上找仓库根。
 *
 * @param fallbackUp 找不到标志物时向上退的级数（打包安装的场景没有 `ui/` 在上层，
 *   保持原来的行为，不要把 cwd 甩到文件系统根上去）。
 */
export function findRepoRoot(fromDir: string, fallbackUp = 2): string {
  let dir = resolve(fromDir);
  // 到达文件系统根时 dirname(dir) === dir，用它当终止条件而不是数循环次数。
  for (;;) {
    if (MARKERS.every((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(fromDir, ...Array.from({ length: fallbackUp }, () => ".."));
}
