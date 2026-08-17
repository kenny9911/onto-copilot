/**
 * EvalOps CLI。`npm run eval -- --live [--k 2] [--case <id>]`
 *
 * **不带 --live 直接拒绝**：评测打真网关、花真钱。CI 里谁误触了一次
 * `npm run eval`，不该是一笔账单 —— 花钱必须是显式决定。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest, runEval, writeReport } from "./runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(ROOT); // .env / workspace 都是 cwd 相对的（与 main.ts 同一个理由）

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!has("--live")) {
  console.error("eval 打真网关、花真钱。确认要跑：npm run eval -- --live");
  process.exit(2);
}

const k = Math.max(1, Number(val("--k") ?? "1") || 1);
const only = val("--case");

const manifest = loadManifest(ROOT);
console.log(`评测集 ${manifest.dataset_version} · k=${k}${only ? ` · 只跑 ${only}` : ""}`);

const report = await runEval(ROOT, manifest, { k, only, log: (l) => console.log(l) });
const path = writeReport(ROOT, report);

console.log("");
console.log(`══ EvalReport ═══════════════════════════════════`);
for (const c of report.cases) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.id}  (${c.attempts.length} 次尝试)`);
}
console.log(`  成本 $${report.total_usd.toFixed(4)} · 用时 ${report.total_seconds.toFixed(0)}s`);
console.log(`  报告 ${path}`);
process.exit(report.pass ? 0 : 1);
