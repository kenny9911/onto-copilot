/**
 * Runtime definition catalog I/O.
 *
 * Human-maintained Skills, Agents, tool policy and frozen workflows live under
 * `ts/catalog/`; executable TypeScript stays under `ts/src/`.  Keeping the path
 * resolution here prevents every loader from growing its own source/dist rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { findRepoRoot } from "../repo_root.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_MARKER = "catalog.yaml";

function isCatalogRoot(path: string): boolean {
  return existsSync(join(path, CATALOG_MARKER));
}

/**
 * Locate the catalog in source checkouts, compiled checkouts and packaged installs.
 * `ONTOCHAT_CATALOG_DIR` is an explicit deployment override and fails fast when wrong.
 */
export function catalogRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ONTOCHAT_CATALOG_DIR"]?.trim();
  if (override) {
    const root = resolve(override);
    if (!isCatalogRoot(root)) {
      throw new Error(
        `ONTOCHAT_CATALOG_DIR 指向的目录缺少 ${CATALOG_MARKER}: ${root}`,
      );
    }
    return root;
  }

  // src/catalog/io.ts -> ts/catalog; dist/src/catalog/io.js -> ts/dist/catalog.
  const packaged = resolve(HERE, "..", "..", "catalog");
  if (isCatalogRoot(packaged)) return packaged;

  // Compiled code executed inside a source checkout can use the source catalog.
  const checkout = join(findRepoRoot(HERE, 3), "ts", "catalog");
  if (isCatalogRoot(checkout)) return checkout;

  throw new Error(
    `找不到 OntoChat 定义目录；请部署 ts/catalog 或设置 ONTOCHAT_CATALOG_DIR` +
      `（已检查 ${packaged}、${checkout}）`,
  );
}

export function catalogPath(...segments: readonly string[]): string {
  return join(catalogRoot(), ...segments);
}

/** Read UTF-8 text with the same universal-newline behavior used by Python. */
export function readCatalogText(...segments: readonly string[]): string {
  return readFileSync(catalogPath(...segments), "utf8").replace(/\r\n?/g, "\n");
}

export function readCatalogYaml(...segments: readonly string[]): unknown {
  return parseYaml(readCatalogText(...segments)) as unknown;
}

export interface FrontmatterDocument {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** Parse a Markdown file with a required YAML frontmatter block. */
export function readCatalogMarkdown(...segments: readonly string[]): FrontmatterDocument {
  const text = readCatalogText(...segments);
  if (!text.startsWith("---\n")) {
    throw new Error(`定义文件缺少 YAML frontmatter: ${segments.join("/")}`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(`定义文件的 YAML frontmatter 未闭合: ${segments.join("/")}`);
  }
  const parsed = parseYaml(text.slice(4, end)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`定义文件的 YAML frontmatter 必须是对象: ${segments.join("/")}`);
  }
  return {
    attributes: parsed as Readonly<Record<string, unknown>>,
    body: text.slice(end + 5),
  };
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

export function asStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return [...(value as string[])];
}

export function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数字`);
  }
  return value;
}
