/**
 * 会话资产记忆的服务端接线。
 *
 * 领域层 `onto/asset_memory.ts` 只管理索引；这里负责把真实文件、事件、问题台账和
 * 外部素材投影进去，并在文件被同名覆盖前保存一份不可变字节快照。快照放在
 * `exports/` 的隐藏命名空间，不进入正式 artifacts / Bundle，但仍沿用已有的鉴权下载
 * 路由。这样旧聊天卡、旧问题清单和“上一张图”不会指向后来覆盖的新字节。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { sha256Hex } from "../kernel/ids.js";
import {
  AssetMemory,
  inferAssetKind,
  type AssetKind,
  type AssetRecord,
  type AssetSearchHit,
} from "../onto/asset_memory.js";
import type { Repo } from "../store/repo/protocol.js";
import { eventRowAsSse, type JsonValue } from "../store/types.js";
import { root } from "./session.js";

type Dict = Record<string, unknown>;

/** Session 与对话/流水线端口共同拥有的最小资产投影。 */
export interface AssetSessionLike {
  readonly id: string;
  readonly dir: string;
  readonly files: readonly {
    readonly name: string;
    readonly path?: string;
    readonly size?: number;
    readonly sha256?: string;
  }[];
  readonly events: readonly Dict[];
  state: Dict;
}

const SNAPSHOT_PREFIX = ".__asset_memory__";

function record(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Dict
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function seqOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function lastEventSeq(s: AssetSessionLike): number {
  let best = 0;
  for (const event of s.events) best = Math.max(best, seqOf(event["seq"]));
  return best;
}

function memoryFromState(s: AssetSessionLike): AssetMemory {
  const raw = s.state["asset_memory"];
  const loaded = AssetMemory.fromDict(raw);
  return loaded.sessionId === s.id ? loaded : new AssetMemory(s.id);
}

function eventKind(event: Readonly<Dict>): string {
  return text(event["kind"]);
}

function eventPath(event: Readonly<Dict>, fallbackName = ""): string {
  const explicit = text(event["path"]);
  if (explicit) return explicit.replace(/^\/+/, "");
  const name = basename(text(event["name"]) || fallbackName);
  if (!name) return "";
  const kind = eventKind(event);
  return text(event["storage"]) === "exports" || kind === "export.ready" || kind === "sketch.ready"
    ? `exports/${name}`
    : name;
}

/** 每个文件最近一次生成事件；只保留小元数据，不把 ui.table 的 rows 再复制一份。 */
function fileEventIndex(s: AssetSessionLike): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const raw of s.events) {
    const event = record(raw);
    const kind = eventKind(event);
    if (kind === "artifact.ready" || kind === "export.ready") {
      const path = eventPath(event);
      if (path) out.set(path, event);
      continue;
    }
    if (kind !== "sketch.ready") continue;
    for (const field of ["name", "mermaid", "png"] as const) {
      const name = text(event[field]);
      if (!name) continue;
      out.set(`exports/${basename(name)}`, { ...event, sketch_field: field });
    }
  }
  return out;
}

function snapshotName(name: string, digest: string): string {
  const original = basename(name);
  const dot = original.lastIndexOf(".");
  const ext = dot > 0 ? original.slice(dot) : "";
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const safeStem = [...stem.replace(/[\u0000-\u001f/\\:]/g, "_")].slice(0, 72).join("") || "asset";
  return `${SNAPSHOT_PREFIX}${digest.slice(0, 20)}__${safeStem}${ext}`;
}

function matchingSource(memory: AssetMemory, sourcePath: string): AssetRecord | null {
  for (const asset of memory.list({ includeSuperseded: true })) {
    if (text(asset.metadata["sourcePath"]) === sourcePath || asset.path === sourcePath) return asset;
  }
  return null;
}

function fileDigest(
  memory: AssetMemory,
  absolutePath: string,
  sourcePath: string,
): { digest: string; size: number; mtimeMs: number } {
  const st = statSync(absolutePath);
  const prior = matchingSource(memory, sourcePath);
  const priorSize = Number(prior?.metadata["sourceSize"] ?? -1);
  const priorMtime = Number(prior?.metadata["sourceMtimeMs"] ?? -1);
  if (
    prior?.contentDigest &&
    priorSize === st.size &&
    priorMtime === st.mtimeMs
  ) {
    return { digest: prior.contentDigest, size: st.size, mtimeMs: st.mtimeMs };
  }
  return {
    digest: sha256Hex(readFileSync(absolutePath)),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function inferredKind(name: string, event: Readonly<Dict>, hint: AssetKind | "" = ""): AssetKind {
  if (hint) return hint;
  const explicit = text(event["asset_kind"] || event["assetKind"] || event["type"]);
  const sketchField = text(event["sketch_field"]);
  if (eventKind(event) === "sketch.ready") {
    if (sketchField === "png") return "image";
    return "sketch";
  }
  return inferAssetKind(name, explicit || text(event["artifact"]));
}

function snapshotFile(
  s: AssetSessionLike,
  memory: AssetMemory,
  sourcePath: string,
  absolutePath: string,
  event: Readonly<Dict>,
  seq: number,
  kindHint: AssetKind | "" = "",
): void {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return;
  const name = basename(sourcePath);
  if (name.startsWith(SNAPSHOT_PREFIX)) return;
  const { digest, size, mtimeMs } = fileDigest(memory, absolutePath, sourcePath);
  const exportsDir = join(s.dir, "exports");
  mkdirSync(exportsDir, { recursive: true });
  const immutableName = snapshotName(name, digest);
  const immutablePath = `exports/${immutableName}`;
  const immutableAbsolute = join(exportsDir, immutableName);
  if (!existsSync(immutableAbsolute)) copyFileSync(absolutePath, immutableAbsolute);

  const prior = matchingSource(memory, sourcePath);
  const eventSource = text(event["source"]);
  const kind = inferredKind(name, event, kindHint);
  const generic = eventSource === "generic_reference" || eventKind(event) === "sketch.ready";
  const logicalRef = text(event["logical_ref"] || event["logicalRef"])
    || text(prior?.metadata["logicalRef"])
    || sourcePath;
  memory.upsert({
    kind,
    name,
    mime: text(event["mime"] || event["media_type"]),
    source: eventKind(event) || prior?.source || (kind === "material" ? "session.files" : "filesystem"),
    origin: kind === "material"
      ? "uploaded"
      : generic ? "model_knowledge" : "generated",
    sessionId: s.id,
    seq: seq || prior?.updatedSeq || 1,
    eventKind: eventKind(event) || prior?.sessionRef.eventKind || null,
    aliases: [
      text(event["title"]),
      text(event["domain"]),
      text(event["artifact"]),
      sourcePath,
    ].filter(Boolean),
    tags: [kind, eventSource, text(event["surface"])].filter(Boolean),
    provenanceRefs: Array.isArray(event["provenance_refs"])
      ? event["provenance_refs"] as string[]
      : prior?.provenanceRefs ?? [],
    evidenceRefs: Array.isArray(event["evidence_ids"])
      ? event["evidence_ids"] as string[]
      : prior?.evidenceRefs ?? [],
    displayOnly: event["display_only"] === true || prior?.displayOnly === true || generic,
    path: immutablePath,
    contentDigest: digest,
    logicalRef,
    metadata: {
      ...(prior?.metadata ?? {}),
      sourcePath,
      sourceSize: size,
      sourceMtimeMs: mtimeMs,
      immutable: true,
      model: event["model"] ?? prior?.metadata["model"] ?? null,
      surface: event["surface"] ?? prior?.metadata["surface"] ?? null,
      sourceKind: event["source"] ?? prior?.metadata["sourceKind"] ?? null,
      genericReference: generic,
    },
  });
}

function scanFiles(s: AssetSessionLike, memory: AssetMemory, baseSeq: number): void {
  const events = fileEventIndex(s);
  let ordinal = 0;

  for (const file of [...s.files].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"))) {
    const name = basename(String(file.name));
    const rel = `materials/${name}`;
    snapshotFile(s, memory, rel, String(file.path), events.get(rel) ?? {}, baseSeq + ordinal, "material");
    ordinal += 1;
  }

  const artifacts = Array.isArray(s.state["artifacts"]) ? s.state["artifacts"] : [];
  for (const raw of artifacts) {
    const item = typeof raw === "string" ? { name: raw } : record(raw);
    const name = basename(text(item["name"]) || text(item["path"]));
    if (!name) continue;
    snapshotFile(s, memory, name, join(s.dir, name), events.get(name) ?? item, baseSeq + ordinal);
    ordinal += 1;
  }

  const exportsDir = join(s.dir, "exports");
  if (!existsSync(exportsDir)) return;
  for (const name of readdirSync(exportsDir).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    if (name.startsWith(SNAPSHOT_PREFIX)) continue;
    const absolute = join(exportsDir, name);
    if (!statSync(absolute).isFile()) continue;
    const rel = `exports/${name}`;
    snapshotFile(s, memory, rel, absolute, events.get(rel) ?? {}, baseSeq + ordinal);
    ordinal += 1;
  }
}

function ingestTablesAndReferences(s: AssetSessionLike, memory: AssetMemory): void {
  for (const raw of s.events) {
    const event = record(raw);
    const kind = eventKind(event);
    const seq = seqOf(event["seq"]);
    if (kind === "ui.table") {
      const title = text(event["title"]) || `会话表格 #${seq}`;
      const rows = Array.isArray(event["rows"]) ? event["rows"] : [];
      const columns = Array.isArray(event["columns"]) ? event["columns"] : [];
      memory.upsert({
        kind: "dataset",
        name: title,
        source: kind,
        origin: "derived",
        sessionId: s.id,
        seq,
        eventKind: kind,
        sourceRef: `event:${seq}`,
        logicalRef: `event:${seq}`,
        contentDigest: sha256Hex(JSON.stringify({ columns, rows })),
        aliases: [title, "聊天表格", "清单"],
        tags: ["表格", "数据"],
        metadata: { eventSeq: seq, columns, rowCount: rows.length },
      });
    }
    if (kind !== "web.sources") continue;
    for (const rawResult of Array.isArray(event["results"]) ? event["results"] : []) {
      const result = record(rawResult);
      const url = text(result["url"]);
      const sourceId = text(result["source_id"]);
      const title = text(result["title"]) || url || sourceId;
      if (!title) continue;
      memory.upsert({
        kind: "reference",
        name: title,
        source: kind,
        origin: "derived",
        sessionId: s.id,
        seq,
        eventKind: kind,
        sourceRef: sourceId || url || title,
        logicalRef: `web:${sourceId || url || title}`,
        uri: url || null,
        contentDigest: sha256Hex(JSON.stringify(result)),
        aliases: [sourceId, text(result["site"]), text(event["query"])],
        tags: ["网页素材", text(result["site"])].filter(Boolean),
        metadata: {
          sourceId,
          site: result["site"] ?? null,
          snippet: result["snippet"] ?? null,
          retrievedAt: event["retrieved_at"] ?? null,
        },
      });
    }
  }
}

/**
 * 从当前所有权威投影重建/增量合并资产目录，并写回 `state.asset_memory`。
 * 可重复调用：相同字节、相同逻辑引用不会制造新版本。
 */
export function syncAssetMemory(s: AssetSessionLike): AssetMemory {
  const memory = memoryFromState(s);
  const seq = lastEventSeq(s);
  // 文件产物单独按真实字节扫描，避免只有 locator 的事件把旧 revision 的不可变路径
  // 又改回可覆盖的当前路径。
  const { artifacts: _ignoredArtifacts, asset_memory: _ignoredMemory, ...stateWithoutFiles } = s.state;
  void _ignoredArtifacts;
  void _ignoredMemory;
  memory.ingestSession({
    sessionId: s.id,
    seq,
    state: stateWithoutFiles,
    files: s.files,
  });
  scanFiles(s, memory, Math.max(1, seq));
  ingestTablesAndReferences(s, memory);
  s.state["asset_memory"] = memory.toDict();
  return memory;
}

export interface AssetAccess {
  readonly available: boolean;
  readonly previewUrl: string;
  readonly downloadUrl: string;
}

/** 访问地址只由服务端按受控路径构造，绝不采用模型传入的任意 URL。 */
export function assetAccess(asset: AssetRecord, currentSessionDir?: string): AssetAccess {
  if (/^https?:\/\//i.test(asset.uri ?? "")) {
    return { available: true, previewUrl: asset.uri ?? "", downloadUrl: asset.uri ?? "" };
  }
  const sid = asset.sessionRef.sessionId;
  const rel = asset.path ?? "";
  if (!sid) return { available: false, previewUrl: "", downloadUrl: "" };
  if (!rel && asset.kind === "dataset") {
    const eventSeq = seqOf(asset.metadata["eventSeq"]);
    if (eventSeq > 0) {
      const url = `/api/sessions/${encodeURIComponent(sid)}/export?seq=${eventSeq}&format=xlsx`;
      return { available: true, previewUrl: "", downloadUrl: url };
    }
  }
  if (!rel) return {
    available: asset.kind === "question" || asset.kind === "question_list",
    previewUrl: "",
    downloadUrl: "",
  };
  const base = currentSessionDir || join(root(), sid);
  const absolute = join(base, ...rel.split("/"));
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return { available: false, previewUrl: "", downloadUrl: "" };
  }
  const name = basename(rel);
  const encodedSid = encodeURIComponent(sid);
  const encodedName = encodeURIComponent(name);
  const url = rel.startsWith("exports/")
    ? `/api/sessions/${encodedSid}/exports/${encodedName}`
    : rel.startsWith("materials/")
      ? `/api/sessions/${encodedSid}/preview?source=material&name=${encodedName}`
      : `/api/sessions/${encodedSid}/artifacts/${encodedName}`;
  return { available: true, previewUrl: url, downloadUrl: url };
}

/** 给系统 prompt 的轻量目录；正文与大 metadata 永远不塞进去。 */
export function assetMemoryBrief(s: AssetSessionLike, limit = 8): string {
  const memory = syncAssetMemory(s);
  const rows = memory.list().slice(0, Math.max(1, limit));
  if (rows.length === 0) return "";
  const rendered = rows.map((row) =>
    `${row.id}｜${row.kind}｜${row.name}｜来源=${row.origin}` +
      (row.revision > 1 ? `｜v${row.revision}` : ""),
  );
  return `资产记忆（共 ${memory.list().length} 项；可用 asset.recall 按名称或“刚才那张图”取回）：\n${rendered.join("\n")}`;
}

export interface ScopedAssetHit extends AssetSearchHit {
  readonly sessionId: string;
}

export function searchAssetMemory(
  memory: AssetMemory,
  query: string,
  options: { readonly limit?: number; readonly includeSuperseded?: boolean; readonly kinds?: readonly AssetKind[] } = {},
): ScopedAssetHit[] {
  return memory.search(query, options).map((hit) => ({ ...hit, sessionId: hit.asset.sessionRef.sessionId }));
}

// ══════════════════════════════════════════════════════════════════
//  历史会话惰性迁移（CAS、owner/project 隔离）
// ══════════════════════════════════════════════════════════════════

export interface AssetMemoryScope {
  readonly owner: string;
  readonly projectId: string;
}

export type AssetMemoryMigrationStatus =
  | "current"
  | "persisted"
  | "missing"
  | "out_of_scope"
  | "conflict";

export interface AssetMemoryMigrationResult {
  readonly status: AssetMemoryMigrationStatus;
  readonly memory: AssetMemory | null;
  /** 本次读取所基于的版本；hydrate 只在它仍等于本地版本时推进本地 CAS 游标。 */
  readonly basedOnVersion: number | null;
  /** persisted 时是提交后的版本；current 时是当前仓储版本。 */
  readonly stateVersion: number | null;
}

export interface AssetMemoryMigrationOptions {
  /** hydrate/测试可传已经解析出的目录；项目召回默认仍走 workspace/<sid>。 */
  readonly directory?: string;
  readonly attempts?: number;
}

function inScope(
  row: { readonly owner: string; readonly project_id: string },
  scope: AssetMemoryScope,
): boolean {
  return row.owner === scope.owner && row.project_id === scope.projectId;
}

function validStoredMemory(raw: unknown, sid: string): AssetMemory | null {
  const doc = record(raw);
  if (
    doc["$schema"] !== "ontocopilot.asset-memory/1" ||
    text(doc["sessionId"]) !== sid ||
    !Array.isArray(doc["assets"])
  ) return null;
  const memory = AssetMemory.fromDict(doc);
  return memory.sessionId === sid ? memory : null;
}

function rootArtifactNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    try {
      if (statSync(join(directory, name)).isFile()) out.push(name);
    } catch {
      // 文件可在 readdir 与 stat 之间被另一条导出路径替换；下一次迁移会补。
    }
  }
  return out.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function safeStoredPath(directory: string, relPath: string): string {
  const workspace = resolve(dirname(directory));
  const absolute = resolve(workspace, relPath);
  return absolute === workspace || absolute.startsWith(`${workspace}${sep}`) ? absolute : "";
}

type MigratedAssetFile = { name: string; path: string; size: number; sha256: string };

function diskMaterialFiles(directory: string): MigratedAssetFile[] {
  const materials = join(directory, "materials");
  if (!existsSync(materials)) return [];
  const out: MigratedAssetFile[] = [];
  for (const name of readdirSync(materials).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
    const path = join(materials, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ name, path, size: st.size, sha256: "" });
    } catch {
      // 同上：迁移目录是派生索引，不为一次并发文件替换把召回整轮打成 500。
    }
  }
  return out;
}

/**
 * 从仓储状态、file 表、durable event 和会话磁盘重建一份迁移候选。
 * 这里只返回派生快照；真正写库始终由下面的 expectedVersion CAS 完成。
 */
async function migrationSnapshot(
  repo: Repo,
  sid: string,
  directory: string,
  state: Dict,
): Promise<AssetSessionLike> {
  const [fileRows, eventRows, questionRows] = await Promise.all([
    repo.listFiles(sid),
    repo.readEvents(sid, { since: 0 }),
    repo.listQuestions(sid),
  ]);
  const byName = new Map<string, MigratedAssetFile>();
  for (const file of diskMaterialFiles(directory)) byName.set(file.name, { ...file });
  for (const file of fileRows) {
    const path = safeStoredPath(directory, file.rel_path);
    // file 表可能比磁盘清理晚一步；不能让一条已失效的 rel_path 覆盖掉同名、仍
    // 存在于该会话 materials/ 下的真实文件。
    if (!path || !existsSync(path)) continue;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    byName.set(file.name, {
      name: file.name,
      path,
      size: file.size,
      sha256: file.sha256,
    });
  }
  const migratedState: Dict = { ...state, artifacts: rootArtifactNames(directory) };
  if (questionRows.length > 0) {
    migratedState["question_backlog"] = { questions: questionRows.map((row) => row.doc) };
  }
  return {
    id: sid,
    dir: directory,
    files: [...byName.values()],
    events: eventRows.map((event) => eventRowAsSse(event) as Dict),
    state: migratedState,
  };
}

/**
 * 读取已有资产目录；历史会话没有目录时，按权威投影惰性重建并只写
 * `session_state.asset_memory`。
 *
 * - 每次写都带 `expectedVersion`，绝不把 hydrate/召回时读到的旧 state 覆盖回去；
 * - CAS 失败后整份重新读取并重建，而不是拿旧目录盲重试；
 * - 写前、写后都核对 owner + project，调用方永远拿不到越界目录。
 */
export async function loadOrMigrateAssetMemory(
  repo: Repo,
  sid: string,
  scope: AssetMemoryScope,
  options: AssetMemoryMigrationOptions = {},
): Promise<AssetMemoryMigrationResult> {
  const attempts = Math.max(1, Math.min(5, Math.trunc(options.attempts ?? 3)));
  const directory = options.directory ?? join(root(), sid);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await repo.getSession(sid);
    if (row === null) {
      return { status: "missing", memory: null, basedOnVersion: null, stateVersion: null };
    }
    if (!inScope(row, scope)) {
      return {
        status: "out_of_scope",
        memory: null,
        basedOnVersion: row.state_version,
        stateVersion: row.state_version,
      };
    }

    const state = await repo.loadState(sid);
    const stored = validStoredMemory(state["asset_memory"], sid);
    if (stored !== null) {
      // owner/project 的重判不推进 state_version，不能只相信上面的旧 row。
      const afterRead = await repo.getSession(sid);
      if (afterRead === null) {
        return { status: "missing", memory: null, basedOnVersion: null, stateVersion: null };
      }
      if (!inScope(afterRead, scope)) {
        return {
          status: "out_of_scope",
          memory: null,
          basedOnVersion: row.state_version,
          stateVersion: afterRead.state_version,
        };
      }
      if (afterRead.state_version !== row.state_version) continue;
      return {
        status: "current",
        memory: stored,
        basedOnVersion: row.state_version,
        stateVersion: row.state_version,
      };
    }

    const snapshot = await migrationSnapshot(repo, sid, directory, state as Dict);
    const memory = syncAssetMemory(snapshot);
    const doc = memory.toDict();
    // sync 的结果若与一个并发迁移刚写入的结果相同，CAS 仍会让本次返回 null；下一轮
    // 会直接走 current，不会制造额外 revision 或多推进一次版本。
    const version = await repo.saveState(
      sid,
      { asset_memory: doc as unknown as JsonValue },
      { expectedVersion: row.state_version },
    );
    if (version === null) continue;

    const afterWrite = await repo.getSession(sid);
    if (afterWrite === null) {
      return { status: "missing", memory: null, basedOnVersion: row.state_version, stateVersion: null };
    }
    if (!inScope(afterWrite, scope)) {
      return {
        status: "out_of_scope",
        memory: null,
        basedOnVersion: row.state_version,
        stateVersion: afterWrite.state_version,
      };
    }
    return {
      status: "persisted",
      memory,
      basedOnVersion: row.state_version,
      stateVersion: version,
    };
  }

  return { status: "conflict", memory: null, basedOnVersion: null, stateVersion: null };
}
