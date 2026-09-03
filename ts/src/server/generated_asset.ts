/**
 * 模型生成文件的原子版本落盘。
 *
 * 图像网关即使接受了不同 prompt，也可能因为缓存、上游降级或实现缺陷返回完全
 * 相同的字节。调用方不能只凭“请求不同”就制造 `_vN`、资产 revision 和聊天卡：
 * 这里以同一逻辑文件的**当前版本真实字节**为准，相同就复用；不同才发布新版本。
 *
 * 发布使用“同目录临时文件 + hard link”。link 是不覆盖的原子操作：多个 worker
 * 同时争同一个版本名时只有一个能成功，失败者重新扫描当前 head 后再决定复用还是
 * 申请下一版，不会互相覆盖，也不会让读者看到半写完的目标文件。
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { sha256Hex } from "../kernel/ids.js";

export interface GeneratedAssetVersion {
  /** 本轮真正对应的文件名；复用时是已有 head。 */
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly version: number;
  /** false 表示生成器返回的字节与当前版本完全相同，磁盘没有发生变化。 */
  readonly created: boolean;
}

interface VersionScan {
  readonly occupiedMax: number;
  readonly current: { readonly name: string; readonly version: number; readonly digest: string } | null;
}

function nameAtVersion(preferredName: string, version: number): string {
  if (version <= 1) return preferredName;
  const dot = preferredName.lastIndexOf(".");
  return dot > 0
    ? `${preferredName.slice(0, dot)}_v${version}${preferredName.slice(dot)}`
    : `${preferredName}_v${version}`;
}

function versionOf(preferredName: string, candidate: string): number | null {
  if (candidate === preferredName) return 1;
  const dot = preferredName.lastIndexOf(".");
  const stem = dot > 0 ? preferredName.slice(0, dot) : preferredName;
  const ext = dot > 0 ? preferredName.slice(dot) : "";
  if (!candidate.startsWith(`${stem}_v`) || !candidate.endsWith(ext)) return null;
  const raw = candidate.slice(stem.length + 2, candidate.length - ext.length);
  if (!/^[2-9][0-9]*$/u.test(raw)) return null;
  const version = Number(raw);
  return Number.isSafeInteger(version) ? version : null;
}

function scanVersions(dir: string, preferredName: string): VersionScan {
  let occupiedMax = 0;
  let current: VersionScan["current"] = null;
  for (const name of readdirSync(dir)) {
    const version = versionOf(preferredName, name);
    if (version === null) continue;
    occupiedMax = Math.max(occupiedMax, version);
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      if (current === null || version > current.version) {
        current = { name, version, digest: sha256Hex(readFileSync(path)) };
      }
    } catch {
      // 文件可能在 readdir/stat/read 之间被另一个进程发布；外层重试会再次扫描。
    }
  }
  return { occupiedMax, current };
}

function isAlreadyExists(exc: unknown): boolean {
  return exc !== null
    && typeof exc === "object"
    && "code" in exc
    && (exc as { code?: unknown }).code === "EEXIST";
}

function publishWithoutOverwrite(dir: string, name: string, bytes: Uint8Array): boolean {
  const destination = join(dir, name);
  const temporary = join(dir, `.__generated_asset_tmp__${process.pid}_${randomUUID()}`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      linkSync(temporary, destination);
      return true;
    } catch (exc) {
      if (isAlreadyExists(exc)) return false;
      throw exc;
    }
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // 临时文件名不可被产品路由引用；极端清理失败留给运维清扫，不能掩盖发布结果。
    }
  }
}

/**
 * 保存一个模型生成文件；相同 head 字节是幂等 no-op，不创建新版本。
 *
 * `preferredName` 必须是单一文件名，禁止调用方借此越出已授权目录。
 */
export function persistGeneratedAssetVersion(
  dir: string,
  preferredName: string,
  bytes: Uint8Array,
): GeneratedAssetVersion {
  if (!preferredName || basename(preferredName) !== preferredName) {
    throw new Error("生成资产文件名必须是不含路径的文件名");
  }
  mkdirSync(dir, { recursive: true });
  const digest = sha256Hex(bytes);

  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const scan = scanVersions(dir, preferredName);
    if (scan.current?.digest === digest) {
      return {
        name: scan.current.name,
        path: join(dir, scan.current.name),
        digest,
        version: scan.current.version,
        created: false,
      };
    }

    const version = scan.occupiedMax + 1;
    const name = nameAtVersion(preferredName, version);
    if (!publishWithoutOverwrite(dir, name, bytes)) continue;
    return { name, path: join(dir, name), digest, version, created: true };
  }
  throw new Error("同名生成文件版本过多，无法原子发布新版本");
}

