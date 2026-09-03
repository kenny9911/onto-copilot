import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(TS_ROOT, "catalog");
const TARGET = resolve(TS_ROOT, "dist", "catalog");

// Generated target only: replace it so removed definitions cannot survive as stale files.
await rm(TARGET, { recursive: true, force: true });
await mkdir(TARGET, { recursive: true });
await cp(SOURCE, TARGET, { recursive: true, force: true });
