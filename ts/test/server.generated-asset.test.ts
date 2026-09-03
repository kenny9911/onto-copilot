import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { persistGeneratedAssetVersion } from "../src/server/generated_asset.js";

const execFileAsync = promisify(execFile);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "onto-generated-asset-"));
}

describe("generated asset version persistence", () => {
  it("当前版本字节相同就复用，不制造 _vN", () => {
    const dir = tempDir();
    const bytes = Buffer.from("same-image-bytes");

    const first = persistGeneratedAssetVersion(dir, "流程图_视觉版.png", bytes);
    const second = persistGeneratedAssetVersion(dir, "流程图_视觉版.png", bytes);

    expect(first).toMatchObject({ name: "流程图_视觉版.png", version: 1, created: true });
    expect(second).toMatchObject({ name: first.name, version: 1, created: false, digest: first.digest });
    expect(readdirSync(dir)).toEqual(["流程图_视觉版.png"]);
  });

  it("当前版本字节不同才发布新版；新版再次相同仍复用 head", () => {
    const dir = tempDir();
    const first = persistGeneratedAssetVersion(dir, "流程图.png", Buffer.from("style-a"));
    const changed = persistGeneratedAssetVersion(dir, "流程图.png", Buffer.from("style-b"));
    const unchanged = persistGeneratedAssetVersion(dir, "流程图.png", Buffer.from("style-b"));

    expect(first).toMatchObject({ name: "流程图.png", version: 1, created: true });
    expect(changed).toMatchObject({ name: "流程图_v2.png", version: 2, created: true });
    expect(unchanged).toMatchObject({ name: "流程图_v2.png", version: 2, created: false });
    expect(readFileSync(join(dir, "流程图.png"), "utf8")).toBe("style-a");
    expect(readFileSync(join(dir, "流程图_v2.png"), "utf8")).toBe("style-b");
    expect(readdirSync(dir).sort()).toEqual(["流程图.png", "流程图_v2.png"]);
  });

  it("多个进程同时发布相同字节时只有一个版本和一个 created=true", async () => {
    const dir = tempDir();
    const modulePath = fileURLToPath(new URL("../src/server/generated_asset.ts", import.meta.url));
    const script = join(dir, "publish.mjs");
    writeFileSync(script, [
      `import { persistGeneratedAssetVersion } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
      "const wait = Math.max(0, Number(process.argv[4]) - Date.now());",
      "if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);",
      "const out = persistGeneratedAssetVersion(process.argv[2], process.argv[3], Buffer.from('same'));",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n"));
    const startAt = Date.now() + 600;

    const results = await Promise.all(Array.from({ length: 6 }, async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", script, dir, "并发图.png", String(startAt)],
        { cwd: fileURLToPath(new URL("..", import.meta.url)) },
      );
      return JSON.parse(stdout) as { created: boolean; name: string; digest: string };
    }));

    expect(results.filter((row) => row.created)).toHaveLength(1);
    expect(new Set(results.map((row) => row.name))).toEqual(new Set(["并发图.png"]));
    expect(new Set(results.map((row) => row.digest)).size).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith(".png"))).toEqual(["并发图.png"]);
  }, 15_000);
});

