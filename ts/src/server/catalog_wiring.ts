/**
 * 把 `kernel/catalog.ts` 接到 server 段留下的 `registerCatalogPort()` 上。
 *
 * 单独一个文件而不是改 `usage.ts`：那边的注册点是**接缝**，接缝两侧各自独立编译
 * 才是它存在的意义。这里只有接线，没有逻辑 —— 逻辑（懒发现、缓存、退回内置目录）
 * 全在 `kernel/catalog.ts` 的 `ensureCatalog()` 里。
 *
 * 启动时调一次 {@link installCatalogPort}；build 前调 {@link ensureCatalogFromConfig}
 * （对应 Python 的 `await _ensure_catalog()`，server.py:2201 / 4978）。
 *
 * **`current()` 绝不返回 null。** Python 那句是 `_CATALOG or ModelCatalog()` ——
 * 给 null 的话 `overrideSpec` 会走"目录里没有这个模型"的保守分支，把管理员在设置页
 * 选的模型一律当成 mid 档、无 effort。症状是账单口径和推理深度都悄悄变了，而日志
 * 里什么都看不出来。
 */

import { ensureCatalog, makeCatalogPort } from "../kernel/catalog.js";
import type { LlmEndpoint, ModelCatalog } from "../kernel/catalog.js";
import { appConfig, registerCatalogPort } from "./usage.js";

/** `appconfig.resolved_llm_config()`：设置 → env → **抛错**。绝不静默换端点。 */
function resolve(): LlmEndpoint {
  return appConfig().resolvedLlmConfig();
}

/** 启动时调一次。之后 `gateways()` 拿到的目录就是过滤过的那一份。 */
export function installCatalogPort(): void {
  registerCatalogPort(makeCatalogPort(resolve));
}

/** `_ensure_catalog()`。懒发现、成功一次即缓存，失败退回内置目录且不置 OK。 */
export function ensureCatalogFromConfig(): Promise<ModelCatalog> {
  return ensureCatalog(resolve);
}
