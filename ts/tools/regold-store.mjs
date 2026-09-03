// 用与 store.engine.test.ts 里 dump() 逐字相同的 PRAGMA 逻辑，
// 把新增的表/列并进 golden —— 不是重写整份 golden，只补差集。
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { Store } = await import("../dist/src/store/engine.js");

const dir = mkdtempSync(join(tmpdir(), "regold-"));
const path = join(dir, "fresh.db");
const store = await Store.open(`sqlite:///${path}`, { createAll: true });
await store.close();

function dump(p) {
  const db = new DatabaseSync(p);
  try {
    const uv = db.prepare("PRAGMA user_version").get();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r) => r.name).filter((n) => !n.startsWith("sqlite_")).sort();
    const tables = {};
    for (const t of names) {
      const columns = db.prepare(`PRAGMA table_info("${t}")`).all();
      const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all().map((r) => ({
        table: r.table, from: r.from, to: r.to,
        on_update: r.on_update, on_delete: r.on_delete, match: r.match,
      })).sort((a, b) => `${a.table}${a.from}`.localeCompare(`${b.table}${b.from}`));
      const indexes = db.prepare(`PRAGMA index_list("${t}")`).all().map((r) => ({
        name: r.name, unique: r.unique, origin: r.origin, partial: r.partial,
        columns: db.prepare(`PRAGMA index_info("${r.name}")`).all().map((c) => c.name),
      })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
      tables[t] = { columns, foreign_keys: fks, indexes, sql: row.sql };
    }
    return { user_version: uv.user_version, tables };
  } finally { db.close(); }
}

// 只补**这次真的动了的**那两张表。整份重取会把其余 23 张 Python 派生的基线
// 一起覆盖成 TS 自己的 dump —— 那等于把「断言的尺子」换成被测对象自己，
// 而这份 golden 的文件头写的正是不能这么干。
const TOUCHED = new Set(["onto_document", "onto_document_folder"]);
const got = dump(path);
const gp = new URL("../../golden/store.engine.json", import.meta.url);
const golden = JSON.parse(readFileSync(gp, "utf8"));
const report = [];
// fresh / reopen / legacy 三份快照都带表清单；legacy 是老库升级之后的形状，
// 升级路径（upgradeSqliteCompat + createAll 的 IF NOT EXISTS）跑完应当和 fresh 一致。
for (const snap of ["fresh", "reopen", "legacy"]) {
  const tables = golden[snap].tables;
  const before = Object.keys(tables).length;
  for (const [name, spec] of Object.entries(got.tables)) {
    if (!TOUCHED.has(name)) continue;
    tables[name] = spec;
  }
  golden[snap].tables = Object.fromEntries(Object.keys(tables).sort().map((k) => [k, tables[k]]));
  golden[snap].user_version = got.user_version;
  report.push(`${snap}: ${before} → ${Object.keys(golden[snap].tables).length} 表, user_version=${got.user_version}`);
}
golden.constants.SQLITE_SCHEMA_VERSION = got.user_version;
// 原文件是 1 空格缩进；用 2 会把整份文件改一遍，把真正的改动淹在格式噪音里。
writeFileSync(gp, JSON.stringify(golden, null, 1) + "\n");
console.log(report.join("\n"));
console.log("只动了:", [...TOUCHED].join(", "));
