/**
 * 产物与溯源 —— `server.py` 6611–7035 的移植（六条路由）。
 *
 * | 方法 | 路径 | 干什么 |
 * |---|---|---|
 * | GET  | `/api/sessions/{sid}/artifacts/{name}` | 下载一份产物 |
 * | GET  | `/api/sessions/{sid}/export`          | 按事件 seq 把界面上某张表导成文件 |
 * | GET  | `/api/sessions/{sid}/exports/{name}`  | 下载对话里导出的文件 |
 * | GET  | `/api/sessions/{sid}/bundle`          | 打交付包 zip |
 * | GET  | `/api/sessions/{sid}/source`          | 按文件名取原文切片（「出处」） |
 * | POST | `/api/sessions/{sid}/audit`           | 业务方回传模板的两阶段审核与回写 |
 *
 * ## 下载这件事只有两个头，两个都写错过
 *
 * `Content-Type` 与 `Content-Disposition`。它们写错不会有异常、不会有测试变红 ——
 * 只会让 FDE 存下来的文件叫 `download.zip`、或者中文包名变成一串问号，而他大概
 * 只会觉得"这软件真难用"。所以两个头的**每一种取值**都由
 * `golden/server.artifacts.json` 从 Python 侧真跑一遍钉住：
 *
 * - `artifact` / `exports/{name}` 走 Starlette 的 `FileResponse`，它的规则是
 *   **`quote(name) == name` 就用朴素 `filename="…"`，否则只给 `filename*=utf-8''…`
 *   （小写 utf-8，且没有 ASCII 兜底）**；
 * - `export` / `bundle` 走 {@link contentDisposition}，那是 Python 侧自己写的
 *   函数：ASCII 兜底 + `filename*=UTF-8''…`（**大写** UTF-8）。两者刻意不同，
 *   照抄，别统一。
 * - media_type 来自 `mimetypes.guess_type`，而它在 macOS 上会读
 *   `/etc/apache2/mime.types` —— `.xlsx` / `.mmd` 的值就来自那里，不在 Python
 *   内置表里。照抄内置表会把模板下载成 `application/octet-stream`。
 *
 * ## 依赖注入
 *
 * `_persist` / `_recompile` / `_session_mutation` / `onto.export` 归别的段落，
 * 落地前先由 {@link ArtifactDeps} 显式传入。路由路径、HTTP 方法、请求/响应的
 * JSON 字段名一个字都没动。
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { sha256Hex } from "../../kernel/ids.js";
import {
  auditSummary,
  diffChanged,
  diffFilled,
  mergeIntoOir,
  readReturned,
  ReturnAuditor,
  type AuditResult,
  type CellDiff,
} from "../../onto/audit.js";
import { buildManifest, buildZip, classify, readmeText } from "../../onto/bundle.js";
import { oirFromDict, Origin, type OIR } from "../../onto/oir.js";
import {
  IdempotencyConflict,
  PatchSet,
  QuestionBacklog,
  QuestionStatus,
  Revision,
  RevisionStatus,
} from "../../onto/questions.js";
import { TemplateSpec } from "../../onto/template.js";
import { eventRowAsSse, revisionRowFromDomain, type JsonObject } from "../../store/types.js";
import { cmpCodePoint } from "../../onto/difflib.js";
import { cpSlice } from "../../onto/parse/base.js";
import { currentRepo, sessAsync, type Session } from "../session.js";

// ══════════════════════════════════════════════════════════════════
//  产品版本
// ══════════════════════════════════════════════════════════════════
/** `ontocopilot.__version__`。进 manifest 的 `product_version`，不是装饰。 */
export const PRODUCT_VERSION = "0.1.0";

/** `_VERSION_STACK_CAP`（server.py:2695）。 */
const VERSION_STACK_CAP = 20;

// ══════════════════════════════════════════════════════════════════
//  外部接线
// ══════════════════════════════════════════════════════════════════

/** `onto/export.py` 的 `ExportSpec`。 */
export interface ExportSpec {
  readonly ext: string;
  readonly media_type: string;
  readonly label: string;
}

/** `onto/export.py` 的 `ExportDoc`（这一段只组装表格，用不到别的块）。 */
export interface ExportDocLike {
  readonly title: string;
  readonly blocks: readonly unknown[];
  readonly note: string;
}

/**
 * `from .onto import export as X` 的等价物。
 *
 * `onto/export.py` 还没有 TS 对应件（它归导出那一段），所以这里按调用面收成一个
 * 接口注入。**不要**在这里现写一份 —— 两份 `safe_name` 必然分叉，而分叉的症状是
 * "同一张表在对话里导出叫 A、在这条路上导出叫 B"。
 */
export interface ExportModule {
  resolveFormat(fmt: string): string;
  tableBlock(columns: string[], rows: string[][], title?: string): unknown[];
  makeDoc(p: { title: string; blocks: unknown[]; note: string }): ExportDocLike;
  render(doc: ExportDocLike, fmt: string): [Uint8Array, ExportSpec];
  safeName(title: string, ext: string): string;
}

/** `source` 路由要的解析器。`default_registry()` 归解析那一段。 */
export interface SourceChunk {
  cite(): string;
  readonly render: string;
  readonly tags: readonly string[];
  readonly locator: Readonly<Record<string, unknown>>;
}
export interface SourceDoc {
  readonly chunks: readonly SourceChunk[];
}
export interface ParseRegistry {
  parse(path: string): Promise<SourceDoc>;
}

/** 这一段用到的、住在别的段落里的服务端零件。 */
export interface ArtifactDeps {
  readonly exportModule: ExportModule;
  readonly parseRegistry: ParseRegistry;
  /** `_persist(s)`。 */
  readonly persist: (s: Session) => Promise<void>;
  /** `_recompile(s)`：确定性重算（对齐→冲突→自动修→澄清→编译），零模型调用。 */
  readonly recompile: (s: Session) => Promise<void>;
  /**
   * `async with _session_mutation(s, "audit.apply")`：跨 worker 的耐久变更租约。
   * 回调形 —— 进入/退出的成对性由签名保证，不靠调用方记得写 `finally`。
   */
  readonly sessionMutation: <T>(s: Session, kind: string, body: () => Promise<T>) => Promise<T>;
  /** `os.getenv` 的注入口。 */
  readonly env?: (name: string) => string | undefined;
  /** `time.time()`，测试里钉住 manifest 的 `generated_at`。 */
  readonly now?: () => number;
}

// ══════════════════════════════════════════════════════════════════
//  Content-Disposition / Content-Type
// ══════════════════════════════════════════════════════════════════

/**
 * 带中文文件名的 Content-Disposition：ASCII 兜底 + RFC 5987 filename*，
 * 让中文包名在各浏览器都能正确落地。
 *
 * 兜底名以前**硬编码成 bundle.zip** —— 只有交付包一个调用方时没露馅，但任何其他
 * 格式复用它，都会在忽略 filename* 的客户端上存成一个 .zip。按真实后缀生成。
 */
export function contentDisposition(name: string, opts: { asciiFallback?: string } = {}): string {
  const ext = pySuffix(name) || ".bin";
  const fallback = opts.asciiFallback || `download${ext}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${quote(name)}`;
}

/**
 * Starlette `FileResponse(path, filename=name)` 拼出来的 Content-Disposition。
 *
 * **与 {@link contentDisposition} 刻意不同**：能原样放进 quoted-string 就不给
 * `filename*`，需要 `filename*` 时反而不给 ASCII 兜底，而且 charset 是**小写**
 * `utf-8`。这是 Starlette 的实现细节，不是设计选择 —— 但它是前端与浏览器实际
 * 看到的东西，所以照抄。
 */
export function fileResponseDisposition(name: string): string {
  const quoted = quote(name);
  return quoted !== name
    ? `attachment; filename*=utf-8''${quoted}`
    : `attachment; filename="${name}"`;
}

/**
 * `mimetypes.guess_type(name)[0] or "application/octet-stream"`。
 *
 * 表里既有 Python 内置 `types_map` 的条目，也有 macOS `/etc/apache2/mime.types`
 * 才有的两条（`.xlsx` / `.mmd`）—— 后者正是模板和流程图源码的后缀，漏了它们，
 * 浏览器拿到的模板就是一坨 octet-stream。`.mmd` 那个 karaoke 类型看着荒唐，
 * 但它就是 Python 侧真实返回的值，**不许"顺手改对"**（改了两侧就分叉）。
 *
 * 注：Starlette 1.6 的兜底是 `application/octet-stream`（1.4 及更早是
 * `text/plain`）。跟着装着的版本走。
 */
export function guessMediaType(name: string): string {
  return MEDIA_TYPES[pySuffix(name).toLowerCase()] ?? "application/octet-stream";
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".md": "text/markdown",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bin": "application/octet-stream",
  ".sql": "application/x-sql",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // 这两条只在 /etc/apache2/mime.types 里，Python 内置表没有。见上面的说明。
  ".mmd": "application/vnd.chipnuts.karaoke-mmd",
};

/** `urllib.parse.quote(s)`：默认 safe="/"，其余非 unreserved 字符全部百分号编码。
 * `encodeURIComponent` 不编 `!'()*` 而 Python 编，所以要补上。 */
function quote(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** `Path(name).suffix`：最后一个点之后的部分；没有点、或点在开头（隐藏文件）→ ""。 */
function pySuffix(name: string): string {
  const base = pyPathName(name);
  const i = base.lastIndexOf(".");
  return i > 0 && i < base.length - 1 ? base.slice(i) : "";
}

/**
 * `Path(name).name` —— **防路径穿越的唯一一道门**。
 *
 * pathlib 的语义不是"取最后一段"那么简单：`Path("a/.")` 会把 `.` 规范化掉
 * （name 是 `"a"`），而 `Path("..")` 的 name 是**空串**（`..` 不算一个"名字"）。
 * 空串接到 `s.dir / ""` 上就是目录本身，正好被下面的 `existsSync` 挡在 404 之前
 * 打不开 —— 但这条链条必须显式写出来，别让后来的人以为 `basename()` 就够了。
 */
function pyPathName(name: string): string {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  const last = parts[parts.length - 1];
  if (last === undefined || last === "..") return "";
  return last;
}

// ══════════════════════════════════════════════════════════════════
//  查询参数（FastAPI 的类型转换）
// ══════════════════════════════════════════════════════════════════

/** pydantic 的 bool 解析。认的词与大小写与 FastAPI 一致；别的值 422。 */
function queryBool(c: Context, key: string, dflt: boolean): boolean {
  const raw = c.req.query(key);
  if (raw === undefined) return dflt;
  const v = raw.trim().toLowerCase();
  if (["1", "on", "t", "true", "y", "yes"].includes(v)) return true;
  if (["0", "off", "f", "false", "n", "no"].includes(v)) return false;
  throw new HTTPException(422, { message: `Input should be a valid boolean: ${key}` });
}

/** FastAPI 的 `seq: int`：缺席或非整数一律 422（Python 侧由 pydantic 拦）。 */
function queryInt(c: Context, key: string): number {
  const raw = c.req.query(key);
  if (raw === undefined) {
    throw new HTTPException(422, { message: `Field required: ${key}` });
  }
  const v = raw.trim();
  if (!/^[+-]?\d+$/.test(v)) {
    throw new HTTPException(422, { message: `Input should be a valid integer: ${key}` });
  }
  return Number.parseInt(v, 10);
}

// ══════════════════════════════════════════════════════════════════
//  路由
// ══════════════════════════════════════════════════════════════════

export function registerArtifactRoutes(app: Hono, deps: ArtifactDeps): void {
  const now = deps.now ?? (() => Date.now() / 1000);
  const env = deps.env ?? ((n: string) => process.env[n]);

  // ── 下载一份产物 ────────────────────────────────────────────────
  app.get("/api/sessions/:sid/artifacts/:name", async (c) => {
    const sid = c.req.param("sid");
    const name = c.req.param("name");
    const s = await sessAsync(sid);
    const p = join(s.dir, pyPathName(name)); // basename：防路径穿越
    if (!existsSync(p)) throw new HTTPException(404, { message: name });
    const fname = basename(p);
    return c.body(toBody(readFileSync(p)), 200, {
      "Content-Type": guessMediaType(fname),
      "Content-Disposition": fileResponseDisposition(fname),
      "Accept-Ranges": "bytes",
    });
  });

  // ── 按事件 seq 导出界面上的一张表 ───────────────────────────────
  /**
   * 把界面上某一张表直接导成文件（按事件 seq 定位）。
   *
   * 界面上那排「存为 XLSX/CSV/…」按钮已经撤了 —— FDE 直接跟 OntoCopilot 说一句
   * 就行，不必在每张表下面挂一排按钮。这条路本身留着：它按**耐久事件 seq** 取表，
   * 冷 worker 也能服务，是 seq 定位导出的唯一入口。
   *
   * 在内存里生成、不落盘：这条路是"看到什么就下什么"，没有留档的意义。AI 用
   * `export.file` 工具导的那份才落盘 —— 那是他明确要来的东西。
   */
  app.get("/api/sessions/:sid/export", async (c) => {
    const sid = c.req.param("sid");
    const seq = queryInt(c, "seq");
    const format = c.req.query("format") ?? "xlsx";
    const X = deps.exportModule;

    const s = await sessAsync(sid);
    let ev: Record<string, unknown> | null = null;
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i];
      if (e !== undefined && e["seq"] === seq && e["kind"] === "ui.table") {
        ev = e;
        break;
      }
    }
    if (ev === null) {
      // SSE 发出的 seq 来自 session_event；下载请求可能落到另一个 worker，
      // 不能依赖原 worker 的 Session.events 缓存。
      const durable = await currentRepo().readEvents(sid, { since: seq });
      const row = durable.find((x) => x.seq === seq && x.kind === "ui.table");
      ev = row !== undefined ? (eventRowAsSse(row) as Record<string, unknown>) : null;
    }
    if (ev === null) throw new HTTPException(404, { message: "没有这张表" });
    const fmt = X.resolveFormat(format);
    if (!fmt) throw new HTTPException(400, { message: `不支持的格式 ${format}` });
    const rows = asArray(ev["rows"]).map((r) => asArray(r).map((x) => x as string));
    const doc = X.makeDoc({
      title: String(pyTruthy(ev["title"]) ? ev["title"] : "清单"),
      blocks: X.tableBlock(asArray(ev["columns"]) as string[], rows),
      note: `共 ${rows.length} 条，由 OntoCopilot 导出`,
    });
    const [data, spec] = X.render(doc, fmt);
    const name = X.safeName(doc.title, spec.ext);
    return c.body(toBody(data), 200, {
      "Content-Type": spec.media_type,
      "Content-Disposition": contentDisposition(name),
    });
  });

  // ── 下载对话里导出的文件 ────────────────────────────────────────
  /**
   * 单独一个目录、单独一个路由 —— 导出件**不是产物**。产物列表是"会话根目录下所有
   * 文件"算出来的，把导出塞在那儿会让它混进产物 tab、混进交付包 zip，一个叫
   * 「问题清单.xlsx」的导出还会被「下载填写模板」按钮抓走（它取第一个 .xlsx）。
   */
  app.get("/api/sessions/:sid/exports/:name", async (c) => {
    const sid = c.req.param("sid");
    const name = c.req.param("name");
    const s = await sessAsync(sid);
    const p = join(s.dir, "exports", pyPathName(name)); // basename：防路径穿越
    if (!existsSync(p)) throw new HTTPException(404, { message: name });
    const fname = basename(p);
    // 显式给了 Content-Disposition，Starlette 的 `setdefault` 就不会覆盖 ——
    // 所以这条路用的是**大写 UTF-8 + ASCII 兜底**的那一版，和 artifacts 不同。
    return c.body(toBody(readFileSync(p)), 200, {
      "Content-Type": guessMediaType(fname),
      "Content-Disposition": contentDisposition(fname),
      "Accept-Ranges": "bytes",
    });
  });

  // ── 交付包 ──────────────────────────────────────────────────────
  /**
   * 把会话的全部产物打成一个交付 zip（产物 + manifest.json + 交付说明.md）。
   *
   * **收集而非重算** —— 产物在节点边界和每次 edit 都已落盘、与内存态一致；重算只会
   * 引入字节漂移、破坏可复现。用会 hydrate 的 `sessAsync`：FDE 常在重启后打开
   * 旧会话来导出，这时 `_flow`/oir/flow/artifacts 都靠 hydrate 载回。
   */
  app.get("/api/sessions/:sid/bundle", async (c) => {
    const sid = c.req.param("sid");
    const materials = queryBool(c, "materials", true);
    const s = await sessAsync(sid);

    // Bundle 是给业务方/下游消费的**正式交付边界**，与仍可下载的单份工作产物
    // 不同。Question Ledger 是权威门禁：旧 `release_state=RELEASED` 在重新打开
    // blocking 问题后会滞后，不能据此继续发旧包。
    const rows = await currentRepo().listQuestions(sid);
    const backlog =
      rows.length > 0
        ? QuestionBacklog.fromDict(rows.map((row) => row.doc as Record<string, unknown>))
        : questionBacklog(s);
    const pending = [...backlog.questions.values()].filter(
      (q) =>
        q.status === QuestionStatus.OPEN ||
        q.status === QuestionStatus.ASSIGNED ||
        q.status === QuestionStatus.BLOCKED,
    );
    const blockers = pending.filter((q) => q.blocking);
    if (blockers.length > 0) {
      const preview = blockers.slice(0, 5).map((q) => q.id).join("、");
      const more = blockers.length > 5 ? ` 等 ${blockers.length} 项` : "";
      throw new HTTPException(409, {
        message:
          `正式 Bundle 已被阻塞问题拦截：${preview}${more}。` +
          "问题清单和单份工作产物仍可下载；处理或明确取消阻塞项后再导出。",
      });
    }
    const storedRelease = String(
      pyTruthy(s.state["release_state"]) ? s.state["release_state"] : "",
    ).toUpperCase();
    const releaseState =
      pending.length > 0 || storedRelease !== "RELEASED" ? "DRAFT" : "RELEASED";

    const entries: [string, Uint8Array][] = [];
    const filesMeta: Record<string, unknown>[] = [];
    if (existsSync(s.dir)) {
      for (const p of sortedDirEntries(s.dir)) {
        if (!statSync(p).isFile()) continue; // 跳过 materials/journal/blobs 子目录
        const data = readFileSync(p);
        const [kind, title, prov] = classify(basename(p));
        entries.push([basename(p), data]);
        filesMeta.push({
          path: basename(p),
          size: data.length,
          sha256: sha256Hex(data),
          kind,
          title,
          provenance: prov,
        });
      }
    }

    const matsMeta: Record<string, unknown>[] = [];
    const mdir = join(s.dir, "materials");
    if (materials && existsSync(mdir)) {
      for (const p of sortedDirEntries(mdir)) {
        if (!statSync(p).isFile()) continue;
        const data = readFileSync(p);
        entries.push([`materials/${basename(p)}`, data]);
        matsMeta.push({ name: basename(p), size: data.length, sha256: sha256Hex(data) });
      }
    }

    const oir = asRecord(s.state["oir"]);
    // 空会话：没有任何产物就别给一个空壳包
    if (filesMeta.length === 0 && !pyTruthy(s.state["flow"]) && !pyTruthy(oir)) {
      throw new HTTPException(409, {
        message: "这个会话还没有产出可交付的产物，先跑一轮梳理。",
      });
    }

    const openQs: Record<string, unknown>[] = [];
    for (const q of asArray(oir["questions"])) {
      const qq = asRecord(q);
      if (!aval(qq["answer"])) {
        openQs.push({ rid: qq["rid"] ?? "", q: aval(qq["text"]) });
      }
    }
    for (const q of asArray(s.state["questions"])) {
      const qq = asRecord(q);
      openQs.push({ rid: qq["conflict_rid"] ?? "", q: qq["title"] ?? "" });
    }

    const ts = now();
    let stateVersion = 0;
    try {
      const row = await currentRepo().getSession(sid);
      stateVersion = row ? row.state_version : 0;
    } catch {
      stateVersion = 0;
    }

    const manifest = buildManifest({
      session: {
        id: s.id,
        title: s.title,
        project: s.project,
        status: s.status,
        release_state: releaseState,
        created: s.created,
        state_version: stateVersion,
      },
      productVersion: PRODUCT_VERSION,
      files: filesMeta,
      materials: matsMeta,
      flow: (s.state["flow"] ?? null) as Record<string, unknown> | null,
      oir: pyTruthy(oir) ? oir : null,
      openQuestions: openQs,
      generatedAt: ts,
      generatedAtIso: isoUtc(ts),
    });
    const blob = buildZip(entries, manifest, readmeText(manifest));
    const fname = `交付包_${s.project || s.title || s.id}_${s.id}.zip`;
    return c.body(toBody(blob), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(fname),
    });
  });

  // ── 溯源：按文件名取原文切片 ────────────────────────────────────
  /**
   * 按文件名取原文切片 —— 前端点「出处」时跳到这里。
   *
   * 这是 ADR-3 的兑现：任何结论都要能点回原文的确切位置。
   *
   * **一律从构建时的缓存读，不重新解析。** 两个原因，第二个更要命：
   *
   * 1. 扫描件重新解析要再调一次视觉模型，看一眼预览就付一次钱；
   * 2. 重跑 OCR 可能给出与抽取时**不同**的文本 —— 那样"点回原文"看到的
   *    就不是系统当初实际读到的东西，这个功能的意义正好被抵消。
   */
  app.get("/api/sessions/:sid/source", async (c) => {
    const sid = c.req.param("sid");
    const file = c.req.query("file");
    if (file === undefined) {
      throw new HTTPException(422, { message: "Field required: file" });
    }
    const q = c.req.query("q") ?? "";
    const s = await sessAsync(sid);
    const name = pyPathName(file);
    const cache = asRecord(s.state["_chunks"]);

    let pool: Record<string, unknown>[];
    if (Object.hasOwn(cache, name)) {
      pool = asArray(cache[name]).map((x) => asRecord(x));
    } else {
      const path = join(s.dir, "materials", name);
      if (!existsSync(path)) throw new HTTPException(404, { message: file });
      if (SCAN_SUFFIXES.has(pySuffix(name).toLowerCase())) {
        return c.json({
          file: name,
          kind: "scan",
          chunks: [],
          findings: [
            {
              kind: "not_parsed_yet",
              message:
                "扫描件要走视觉模型识别，先点「开始梳理」。" + "预览不会单独再跑一次 OCR。",
            },
          ],
        });
      }
      const doc = await deps.parseRegistry.parse(path);
      pool = doc.chunks.map((ch) => ({
        cite: ch.cite(),
        text: cpSlice(ch.render, 0, 1500),
        tags: ch.tags,
        locator: ch.locator,
      }));
      cache[name] = pool;
      s.state["_chunks"] = cache;
    }

    const needle = q.toLowerCase();
    const hits = pool.filter(
      (ch) =>
        !q ||
        String(ch["text"] ?? "").toLowerCase().includes(needle) ||
        String(ch["cite"] ?? "").includes(q),
    );
    // 不再截到 80 —— 一份材料几张表几百行，截断会让排在后面的整张表凭空消失。
    // 检索时（有 q）才收窄，浏览全文时给全量。
    const limit = q ? 200 : 2000;
    return c.json({
      file: name,
      kind: "cached",
      chunks: hits.slice(0, limit),
      findings: asArray(asRecord(s.state["corpus"])["findings"]).filter(
        (f) => asRecord(f)["file"] === name,
      ),
    });
  });

  // ── 回传审核 ────────────────────────────────────────────────────
  /**
   * 业务方回传的**两阶段**审核与回写。
   *
   * `apply=false` 只在 OIR 副本上运行规则，返回 cell diff/结构损伤/
   * 可回写预览，绝不修改当前 Ontology。`apply=true` 才在 FDE 明确确认后
   * merge、生成 revision、重算问题与全部产物。
   */
  app.post("/api/sessions/:sid/audit", async (c) => {
    const sid = c.req.param("sid");
    const apply = queryBool(c, "apply", false);
    const files = await parseUploads(c);
    const s = await sessAsync(sid);
    if (apply) {
      return c.json(
        await deps.sessionMutation(s, "audit.apply", () =>
          auditOnce(s, files, { apply: true, deps, env }),
        ),
      );
    }
    return c.json(await auditOnce(s, files, { apply: false, deps, env }));
  });
}

// ══════════════════════════════════════════════════════════════════
//  回传审核的正文
// ══════════════════════════════════════════════════════════════════

/** 一份上传件。`UploadFile` 的调用面只用到这两处。 */
export interface Upload {
  readonly filename: string;
  read(): Promise<Uint8Array>;
}

/** Run preview/apply after the route acquired the required mutation lease. */
export async function auditOnce(
  s: Session,
  files: readonly Upload[],
  opts: {
    apply: boolean;
    deps: ArtifactDeps;
    env?: (name: string) => string | undefined;
  },
): Promise<Record<string, unknown>> {
  const { apply, deps } = opts;
  const env = opts.env ?? ((n: string) => process.env[n]);
  const specPath = join(s.dir, "template.spec.json");
  if (!existsSync(specPath)) {
    throw new HTTPException(409, { message: "这个会话还没有编译出模板" });
  }
  const up = files[0];
  if (up === undefined) throw new HTTPException(400, { message: "没有上传回传模板" });
  if (busy(s)) {
    throw new HTTPException(409, { message: "当前梳理正在运行，请等当前版本提交后再回传。" });
  }
  const raw = await up.read();
  const maxBytes = Number.parseInt(env("ONTOCOPILOT_MAX_UPLOAD_MB") ?? "100", 10) * 1024 * 1024;
  if (raw.length > maxBytes) {
    throw new HTTPException(413, {
      message: `回传件超过上限 ${Math.floor(Math.floor(maxBytes / 1024) / 1024)} MB`,
    });
  }
  // 预审不该在产物目录里制造一个看似已纳入交付的文件。单独
  // 放 returns/；应用后保留原件，manifest 仍能审计这版来自哪个回传。
  const returnedDir = join(s.dir, "returns");
  await mkdir(returnedDir, { recursive: true });
  const safe = pyPathName(up.filename || "returned.xlsx");
  const digest = sha256Hex(raw);
  const dest = join(returnedDir, `${digest.slice(0, 12)}_${safe}`);
  await writeFile(dest, raw);

  const spec = TemplateSpec.load(specPath);
  const live = s.state["_oir"] as OIR | null | undefined;
  if (live === null || live === undefined) {
    throw new HTTPException(409, { message: "这个会话的 OIR 未恢复，不能审核回传件" });
  }
  // ReturnAuditor 会对命名违规做 auto_repair。即使是"预审"也必须给它
  // 副本，否则 apply=false 也会悄悄修改活 OIR。
  const previewOir = oirFromDict(live.toDict());
  const result: AuditResult = new ReturnAuditor().audit(spec, readReturned(readFileSync(dest)), {
    oir: previewOir,
  });
  const summary = auditSummary(result);
  const diffs = result.diffs
    .filter((d) => diffChanged(d))
    .map((d: CellDiff) => ({
      rid: d.rid,
      sheet: d.sheet,
      field: d.field,
      before: d.before,
      after: d.after,
      owner: d.owner,
      role: String(d.role),
      changed: diffChanged(d),
      filled: diffFilled(d),
    }));
  const mergeProbe = oirFromDict(live.toDict());
  const [mergeable, dropped0] = mergeIntoOir(mergeProbe, result.diffs);
  const payload: Record<string, unknown> = {
    ...summary,
    apply,
    applied: false,
    diffs,
    mergeable,
    dropped: dropped0,
    file: safe,
    sha256: digest,
    revision: pyInt(s.state["artifact_revision"]),
    autoRepairs: result.autoRepaired,
  };
  if (!apply) {
    // 预审摘要可以显示，但不持久一个"已完成 audit"的业务状态。
    s.emit("audit.previewed", payload as JsonObject);
    return payload;
  }

  // `AuditResult.damage` 的契约是 fail closed：锚点缺失、重复 RID、
  // 表头/锚点被移动都意味着我们无法证明读回的是业务方实际填写的完整内容。
  // 不能因为仍有一部分 cell "看起来能读"就把它们混入当前 Ontology；否则
  // 一张损坏表会形成一个貌似成功、实则静默丢答复的 revision。
  if (result.damage.length > 0) {
    throw new HTTPException(422, {
      // FastAPI 的 `detail=` 是**结构化**的：前端按 `code` 分支。别压成字符串。
      res: jsonResponse(422, {
        detail: {
          code: "RETURN_TEMPLATE_DAMAGED",
          message: "回传模板结构已改变，未应用任何数据。请按预审提示修复后重新上传。",
          damage: result.damage,
          sha256: digest,
        },
      }),
    });
  }

  const repo = currentRepo();
  // 幂等检查必须在修改活 OIR 之前。否则即使后面发现 revision
  // 已存在，也已有一段时间让其它协程观察到未提交的 OIR。
  let existing =
    (await repo.listRevisions(s.id)).find((r) => r.idempotency_key === `returned:${digest}`) ??
    null;
  if (existing !== null && existing.status === String(RevisionStatus.APPLIED)) {
    let committed = asRecord(s.state["audit"]);
    if (committed["sha256"] === digest && committed["phase"] === "committing") {
      // The Revision terminal row won but the final cosmetic projection did
      // not.  Artifacts/OIR were already committed by the preceding fenced
      // checkpoint; finish that marker without replaying merge or compile.
      committed = {
        ...committed,
        phase: "applied",
        applied: true,
        created: false,
        revision: existing.ordinal,
      };
      s.state["audit"] = committed;
      await deps.persist(s);
    }
    return {
      ...payload,
      ...(committed["sha256"] === digest ? committed : {}),
      applied: true,
      created: false,
      revision: existing.ordinal,
      note: "这份回传件已应用过，未重复生成版本。",
    };
  }
  if (existing !== null && existing.status !== String(RevisionStatus.PROPOSED)) {
    throw new HTTPException(409, {
      message: `这份回传件的 Revision 已是 ${existing.status}，不能再应用。`,
    });
  }

  const before = live.toDict();
  const [changed, dropped] = mergeIntoOir(live, result.diffs);
  // 预审里的命名 auto-repair 是在副本上算的；确认应用时要把同一份可逆修复
  // 明确提交到活 OIR，否则用户看到"将自动修复"，点确认后结果却没有修。
  for (const repair of result.autoRepaired) {
    const rid = String(repair["rid"] ?? "");
    const newName = repair["to"];
    if (!rid || !pyTruthy(newName)) continue;
    for (const bucket of [live.objects, live.properties, live.links, live.actions]) {
      const entity = bucket.get(rid);
      if (entity === undefined || entity.apiName.value === newName) continue;
      entity.apiName.value = String(newName);
      entity.apiName.origin = Origin.AUTO_REPAIRED;
      changed.push(`${rid}.apiName`);
      break;
    }
  }
  const versions = pushVersion(s, "_oir_versions", before);
  if (changed.length === 0) versions.pop();
  s.state["oir"] = live.toDict();

  // 回传合并是一次正式 artifact revision，不走聊天补丁旁路。
  const revRows = await repo.listRevisions(s.id);
  // `max(..., default=0)`：**空集**才用 0，不是"和 0 取大" —— 后者在有负 ordinal
  // 的行时会给出不同的号。
  const ordinal = (revRows.length > 0 ? Math.max(...revRows.map((r) => r.ordinal)) : 0) + 1;
  const parent =
    revRows.length > 0
      ? revRows.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)).id
      : null;
  const revision = new Revision({
    id: `rev.${ordinal}`,
    ordinal,
    parentId: parent,
    // Claim first, publish only after compile + fenced projection commit.  A
    // process can die between those operations; `proposed` makes the same
    // idempotency key resumable instead of falsely reporting a half revision as
    // already applied.
    kind: "returned_template",
    status: RevisionStatus.PROPOSED,
    patchSet: new PatchSet({
      id: `patch.return.${digest.slice(0, 16)}`,
      baseRevision: Math.max(0, ordinal - 1),
      ops: [],
      affectedIds: [...new Set(changed.map((x) => x.split(".", 1)[0] ?? ""))].sort(cmpCodePoint),
      blockedArtifacts: ["ontology.package.json", "模板_v1.xlsx"],
      idempotencyKey: `returned:${digest}`,
      actor: "fde",
      reason: `业务方回传 ${safe}`,
    }),
    changedIds: changed,
    invalidatedArtifacts: ["ontology.package.json", "模板_v1.xlsx", "问题清单.xlsx"],
    actor: "fde",
    snapshotHash: digest,
  });
  let stored;
  let created: boolean;
  if (existing === null) {
    try {
      [stored, created] = await repo.recordRevision(
        s.id,
        // `Revision.toDict()` 声明成 `Record<string, unknown>`，`HasToDict` 要
        // `JsonObject`；内容本来就是纯 JSON，这里只是把这层名义差异抹掉。
        revisionRowFromDomain(
          { toDict: () => revision.toDict() as JsonObject },
          `returned:${digest}`,
        ),
      );
    } catch (exc) {
      if (exc instanceof IdempotencyConflict) {
        throw new HTTPException(409, { message: exc.message });
      }
      throw exc;  // 不该吞的重新抛出（契约 §1 的 `except Exception` 那一行）
    }
    if (!created) {
      // The durable mutation lease should make this unreachable; retain a
      // defensive read so a future caller cannot continue with an unknown row.
      existing = stored;
    }
  } else {
    stored = existing;
    created = false;
  }

  // A prior invocation may have committed every projection/artifact and died in
  // the tiny window before finalising its Revision row.  The marker is written by
  // the same fenced session-state checkpoint as the OIR, so it is safe to finish
  // without recompiling (which would mint another artifact revision).
  const durableAudit = asRecord(s.state["audit"]);
  if (!created && durableAudit["sha256"] === digest && durableAudit["phase"] === "committing") {
    stored = await repo.finalizeRevision(s.id, stored.id, {
      status: String(RevisionStatus.APPLIED),
    });
    durableAudit["phase"] = "applied";
    durableAudit["applied"] = true;
    durableAudit["created"] = false;
    durableAudit["revision"] = stored.ordinal;
    s.state["audit"] = durableAudit;
    await deps.persist(s);
    return {
      ...payload,
      ...durableAudit,
      resumed: true,
      note: "已完成上次中断的回传应用，未重复生成版本。",
    };
  }

  s.state["audit"] = {
    ...payload,
    applied: true,
    created,
    changed,
    dropped,
    revision: stored.ordinal,
    phase: "committing",
  };

  await deps.recompile(s);
  await deps.persist(s);
  stored = await repo.finalizeRevision(s.id, stored.id, {
    status: String(RevisionStatus.APPLIED),
  });
  Object.assign(payload, {
    applied: true,
    created,
    changed,
    dropped,
    revision: stored.ordinal,
    artifact_revision: s.state["artifact_revision"],
    artifacts: pyTruthy(s.state["artifacts"]) ? s.state["artifacts"] : [],
    phase: "applied",
  });
  s.state["audit"] = payload;
  s.emit("audit.applied", {
    revision: stored.ordinal,
    artifact_revision: (payload["artifact_revision"] ?? null) as JsonObject[string],
    changed: changed.length,
    dropped,
    file: safe,
  });
  await deps.persist(s);
  return payload;
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/** `_question_backlog`（server.py:3291）。两行，就地实现而不是注入 —— 注入一个
 * 两行纯函数只会让接线更容易接错。 */
function questionBacklog(s: Session): QuestionBacklog {
  const raw = s.state["question_backlog"];
  return QuestionBacklog.fromDict(
    (pyTruthy(raw) ? raw : { questions: [] }) as Record<string, unknown>,
  );
}

/**
 * 这个会话正在跑 DAG 吗（`_busy`，server.py:4637）。
 *
 * 改产物的动作必须看这个。旧的 chat 路由有「跑着时排队」，我在改成
 * agent-first 的时候把它删了 —— 审查当场指出来：跑着的时候调重编译，
 * 界面会显示「已完成」而抽取还在继续。
 */
function busy(s: Session): boolean {
  return s.status === "queued" || s.status === "parsing" || s.status === "extracting";
}

/**
 * `_push_version`（server.py:3158）：把一个「编辑前」快照压进版本栈并就地封顶，
 * 返回该栈（活列表）。
 *
 * 调用方在编辑失败时还要 `pop()` 掉刚压的这个，所以返回的必须是同一个列表。
 */
function pushVersion(s: Session, key: string, snap: Record<string, unknown>): unknown[] {
  let v = s.state[key];
  if (!Array.isArray(v)) {
    v = [];
    s.state[key] = v;
  }
  const list = v as unknown[];
  list.push(snap);
  // Python 是 `del v[:len(v)-CAP]` —— **原地**删头部。换成重新赋值会把调用方
  // 已经拿到的引用留在旧数组上，那正是 `versions.pop()` 要操作的那个。
  if (list.length > VERSION_STACK_CAP) list.splice(0, list.length - VERSION_STACK_CAP);
  return list;
}

/** 走视觉模型才读得动的后缀。 */
const SCAN_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".pdf", ".webp", ".tif", ".tiff"]);

/** `x.get("value") if isinstance(x, dict) else x` → `str(v or "").strip()`。 */
function aval(x: unknown): string {
  const v = x !== null && typeof x === "object" && !Array.isArray(x) ? asRecord(x)["value"] : x;
  return pyTruthy(v) ? String(v).trim() : "";
}

/** `sorted(dir.iterdir())`：PosixPath 之间比的是**完整路径字符串**，按 code point。 */
function sortedDirEntries(dir: string): string[] {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .sort(cmpCodePoint);
}

/** `datetime.fromtimestamp(now, UTC).isoformat()`。
 * Python 给 `2026-08-13T11:22:33.456789+00:00`：微秒 6 位、带 `+00:00`，
 * **不是** JS 的 `…Z`（毫秒 3 位）。整秒时 Python 省略小数部分。 */
function isoUtc(ts: number): string {
  let sec = Math.floor(ts);
  let micro = Math.round((ts - sec) * 1e6);
  if (micro >= 1e6) {
    // 小数部分四舍五入到了整秒，得进位 —— 否则会印出 `…:20.1000000`。
    sec += 1;
    micro = 0;
  }
  const head = new Date(sec * 1000).toISOString().slice(0, 19);
  const frac = micro === 0 ? "" : `.${String(micro).padStart(6, "0")}`;
  return `${head}${frac}+00:00`;
}

/** `int(x or 0)`。 */
function pyInt(x: unknown): number {
  if (!pyTruthy(x)) return 0;
  const n = typeof x === "number" ? x : Number.parseInt(String(x), 10);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/** Python 的真值判断（`x or []` / `if not x`）。就地一份：`onto/canonical.ts`
 * 里的那份没导出，而 `server/dialogue/pyutil.ts` 归对话那一段、导出面还在动。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === "" || Number.isNaN(v as number)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

/** Hono 的 body 要 ArrayBuffer 而不是 Node Buffer 的视图 —— Buffer 常常是一大块
 * 内存池的切片，直接把它的 `.buffer` 交出去会连带发送邻居的字节。 */
function toBody(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}

/** `HTTPException` 只接受 message；要发结构化 detail 就得自己给 Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `files: list[UploadFile]` 的等价物。
 *
 * FastAPI 按**表单字段名** `files` 收；Hono 的 `parseBody` 要显式打开 `all`
 * 才会把同名多值收成数组，否则只留最后一个 —— 那正是"传了三份只审了一份"。
 */
export async function parseUploads(c: Context, field = "files"): Promise<Upload[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body[field];
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Upload[] = [];
  for (const item of items) {
    if (typeof item === "string") continue;
    const f = item;
    out.push({
      filename: f.name,
      read: async () => new Uint8Array(await f.arrayBuffer()),
    });
  }
  return out;
}
