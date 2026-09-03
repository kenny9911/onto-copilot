/**
 * 右侧 Sidebar 的统一只读预览协议。
 *
 * 预览和下载是两件事：下载路由可以把任意受支持产物作为 attachment 返回，预览
 * 则只允许浏览器安全内嵌的 PNG / SVG，或返回已经存在的解析切片。Excel / DOCX
 * 没有切片时明确降级为「仅下载」，GET 绝不为了看一眼而重跑解析、改 session state。
 *
 * 文件访问有两层白名单：
 * 1. artifact 必须出现在 `state.artifacts`，material 必须出现在 repo 刷新的 files；
 * 2. 文件名必须是单个 basename，且最终路径留在对应会话目录内、不是符号链接。
 *
 * 这意味着即使有人把 `../secret` 塞进查询参数，甚至污染了 artifact 投影，也无法
 * 借预览路由读取会话目录之外的内容。
 */

import type { Hono } from "hono";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import type { AppEnv } from "../app.js";
import { materialFindings } from "../material_status.js";
import { refreshFilesProjection, sessAsync, type Session } from "../session.js";
import { guessMediaType } from "./artifacts.js";
import { buildContextReadModel, type ContextModelItem } from "./context.js";
import { apiError } from "./sessions.js";

export const PREVIEW_SCHEMA_VERSION = "ontocopilot.preview/1" as const;
export const PREVIEW_TEXT_LIMIT = 2 * 1024 * 1024;
export const PREVIEW_IMAGE_LIMIT = 5 * 1024 * 1024;
export const PREVIEW_CHUNK_LIMIT = 2_000;
/** 直读表格（没有解析切片时）的上限：文件大小、每张表的行/列。
 *
 * **2MB 不是拍脑袋**：直读是同步的，Node 是单线程 —— 实测 308K 的真实 xlsx
 * （8 张表 1485 行）要 92ms，线性外推 8MB 就是两秒多的事件循环阻塞，那两秒里
 * 所有人的请求都在排队等一个人看一眼表。2MB 把最坏情况压在半秒上下。 */
export const PREVIEW_SHEET_BYTES = 2 * 1024 * 1024;
export const PREVIEW_SHEET_ROWS = 500;
export const PREVIEW_SHEET_COLS = 40;
/**
 * 直读的**硬阈值**：一张表超过这么多行就不读，回落成「只能下载」。
 *
 * 文件大小挡不住这件事 —— xlsx 是 ZIP，压缩比轻松上百。实测 1.91MB / 11 万行的
 * 表，`workbook.xlsx.readFile` 吃 545MB RSS、阻塞事件循环 609ms，6 并发峰值 2GB。
 * 代价按**单元格数**算，闸就必须按行数设，而且要在读的过程中停，不能读完再截。
 */
export const PREVIEW_SHEET_HARD_ROWS = 20_000;

// exceljs 是 CJS（同 routes/questions.ts 的说明）：具名 import 运行时直接 SyntaxError。
const ExcelJS = createRequire(import.meta.url)("exceljs") as typeof import("exceljs");

type Dict = Record<string, unknown>;
type FileSource = "artifact" | "material";

export interface PreviewCapabilities {
  readonly inline: boolean;
  readonly parsed: boolean;
  readonly search: boolean;
  readonly zoom: boolean;
  readonly download: boolean;
  readonly sourceSlices: boolean;
}

export interface PreviewReadModel {
  readonly schemaVersion: typeof PREVIEW_SCHEMA_VERSION;
  readonly target: {
    readonly source: FileSource | "model";
    readonly name: string;
    readonly format: string;
    readonly mediaType: string;
    readonly size: number;
  };
  readonly previewKind:
    | "image"
    | "markdown"
    | "json"
    | "spreadsheet"
    | "document"
    | "graph"
    | "download";
  readonly capabilities: PreviewCapabilities;
  readonly previewUrl: string;
  readonly inlineUrl: string;
  readonly downloadUrl: string;
  readonly sourceUrl: string;
  readonly notice: string;
  readonly data: unknown;
}

interface AllowedFile {
  readonly source: FileSource;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly format: string;
  readonly mediaType: string;
  readonly downloadUrl: string;
  readonly sourceUrl: string;
}

interface SafetyResult {
  readonly ok: boolean;
  readonly notice: string;
}

export function registerPreviewRoutes(app: Hono<AppEnv>): void {
  /**
   * 内嵌二进制只服务 PNG / SVG。它不替代下载路由，也不允许文档借 iframe 直接执行。
   */
  app.get("/api/sessions/:sid/preview/content", async (c) => {
    const sourceRaw = requiredQuery(c.req.query("source"), "source");
    if (sourceRaw === "model") throw apiError(400, "model graph 返回 JSON，不走图片 content 路由");
    const source = fileSource(sourceRaw);
    const name = requiredQuery(c.req.query("name"), "name");
    const s = await sessAsync(c.req.param("sid"));
    const file = await allowedFile(s, source, name);
    const safety = inlineImageSafety(file);
    if (!safety.ok) throw apiError(415, safety.notice);

    const headers: Record<string, string> = {
      "Content-Type": file.mediaType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // SVG 直接导航时也处在唯一 opaque origin，脚本/外链均被禁。`style-src` 只为
      // 系统生成图中的内联样式；外部样式仍由 default-src 'none' 拦住。
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    };
    const bytes = readFileSync(file.path);
    return c.body(Uint8Array.from(bytes).buffer as ArrayBuffer, 200, headers);
  });

  /** 统一 metadata + 结构化内容。 */
  app.get("/api/sessions/:sid/preview", async (c) => {
    const source = requiredQuery(c.req.query("source"), "source");
    const name = requiredQuery(c.req.query("name"), "name");
    const s = await sessAsync(c.req.param("sid"));

    if (source === "model") return c.json(await modelGraphPreview(s, name));
    const file = await allowedFile(s, fileSource(source), name);
    return c.json(await filePreview(s, file));
  });
}

async function filePreview(s: Session, file: AllowedFile): Promise<PreviewReadModel> {
  const previewUrl = previewApiUrl(s.id, file.source, file.name);
  const inlineUrl = inlineContentUrl(s.id, file.source, file.name);
  const common = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    target: {
      source: file.source,
      name: file.name,
      format: file.format,
      mediaType: file.mediaType,
      size: file.size,
    },
    previewUrl,
    downloadUrl: file.downloadUrl,
    sourceUrl: file.sourceUrl,
  } as const;

  if (file.format === "png" || file.format === "svg") {
    const safety = inlineImageSafety(file);
    const inline = safety.ok;
    return {
      ...common,
      previewKind: "image",
      capabilities: capabilities({
        inline,
        parsed: inline,
        zoom: inline,
        download: Boolean(file.downloadUrl),
      }),
      inlineUrl: inline ? inlineUrl : "",
      notice: safety.notice,
      data: null,
    };
  }

  if (file.format === "md" || file.format === "markdown") {
    if (file.size > PREVIEW_TEXT_LIMIT) {
      return downloadOnly(common, "Markdown 超过安全预览上限，请下载后查看");
    }
    return {
      ...common,
      previewKind: "markdown",
      capabilities: capabilities({
        inline: true,
        parsed: true,
        search: true,
        download: Boolean(file.downloadUrl),
      }),
      inlineUrl: "",
      notice: "",
      // 返回 Markdown 原文而不是 HTML；渲染与消毒由前端唯一 Markdown 组件负责。
      data: { text: readFileSync(file.path, "utf8") },
    };
  }

  if (file.format === "json") {
    if (file.size > PREVIEW_TEXT_LIMIT) {
      return downloadOnly(common, "JSON 超过安全预览上限，请下载后查看");
    }
    const raw = readFileSync(file.path, "utf8");
    try {
      return {
        ...common,
        previewKind: "json",
        capabilities: capabilities({
          inline: true,
          parsed: true,
          search: true,
          download: Boolean(file.downloadUrl),
        }),
        inlineUrl: "",
        notice: "",
        data: { value: JSON.parse(raw) as unknown },
      };
    } catch {
      return {
        ...common,
        previewKind: "json",
        capabilities: capabilities({
          inline: true,
          parsed: false,
          search: true,
          download: Boolean(file.downloadUrl),
        }),
        inlineUrl: "",
        notice: "文件扩展名是 JSON，但内容不是合法 JSON；已按纯文本显示",
        data: { text: raw },
      };
    }
  }

  if (["xlsx", "xlsm", "xltx", "xls", "csv", "tsv"].includes(file.format)) {
    return await cachedDocumentPreview(s, file, "spreadsheet", common);
  }

  if (["docx", "doc"].includes(file.format)) {
    return await cachedDocumentPreview(s, file, "document", common);
  }

  return downloadOnly(common, "这个格式当前只支持下载，不在浏览器内解析");
}

async function cachedDocumentPreview(
  s: Session,
  file: AllowedFile,
  previewKind: "spreadsheet" | "document",
  common: Omit<PreviewReadModel, "previewKind" | "capabilities" | "inlineUrl" | "notice" | "data">,
): Promise<PreviewReadModel> {
  const cached = asRows(asDict(s.state["_chunks"])[file.name]).map(asDict);
  // 切片优先：它带着 cite，点得回原文；直读没有这个。
  let tooBigToRead = previewKind === "spreadsheet" && file.size > PREVIEW_SHEET_BYTES;
  if (cached.length === 0 && previewKind === "spreadsheet" && !tooBigToRead) {
    // **我们自己生成的表格产物永远没有切片** —— 切片是材料解析的产物。以前这里
    // 一律降级成「只能下载」，于是交付页的「数据字典.xlsx」根本打不开（2026-08-25
    // 用户截图）。直读一张表是确定性的、零模型、不改 session state，与文件头那条
    // 「GET 不重跑解析」并不冲突：那条防的是重跑**解析管线**，不是不许读文件。
    const direct = await readSheets(file);
    // "too_large"：解压后行数超硬阈值。走下面「太大」那一支，而不是含糊的
    // 「没有切片」—— 两者对用户意味着完全不同的下一步动作。
    if (direct === "too_large") tooBigToRead = true;
    else if (direct !== null) return { ...common, previewKind, ...direct };
  }
  if (cached.length === 0) {
    const label = previewKind === "spreadsheet" ? "Excel" : "DOCX";
    return {
      ...common,
      previewKind,
      capabilities: capabilities({
        download: Boolean(file.downloadUrl),
        sourceSlices: Boolean(file.sourceUrl),
      }),
      inlineUrl: "",
      notice: tooBigToRead
        // 「太大所以不当场读」与「还没解析过」是两件事。含糊成一句会让人跑去
        // 重跑解析 —— 而那对这个文件根本不解决问题。
        ? `这张表太大（${Math.round(file.size / 1024 / 1024 * 10) / 10}MB / 超过 ${PREVIEW_SHEET_HARD_ROWS} 行），` +
          "预览不在请求里同步解析它（会拖住整台服务）。可下载原文件；或让它进解析管线，之后按切片预览、还能点回原文。"
        : `${label} 当前没有可复用的解析切片；预览接口不会在 GET 中重跑解析。` +
          (file.downloadUrl ? "可下载原文件。" : "可通过材料原文入口触发既有解析流程。"),
      data: { groups: [], chunks: 0, truncated: false, findings: materialFindings(s, file.name) },
    };
  }

  const rows = cached.slice(0, PREVIEW_CHUNK_LIMIT).map((chunk, index) => {
    const locator = asDict(chunk["locator"]);
    const text = String(chunk["text"] ?? "");
    return {
      id: `${file.name}:${index}`,
      cite: String(chunk["cite"] ?? ""),
      text,
      tags: stringList(chunk["tags"]),
      locator,
      cells: previewKind === "spreadsheet" ? cellsFromRender(text) : {},
    };
  });
  const grouped = new Map<string, Dict[]>();
  for (const row of rows) {
    const locator = asDict(row["locator"]);
    const key = previewGroup(locator, previewKind);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  const groups = [...grouped].map(([name, groupRows]) => ({
    name,
    rows: groupRows,
    count: groupRows.length,
  }));
  return {
    ...common,
    previewKind,
    capabilities: capabilities({
      inline: true,
      parsed: true,
      search: true,
      download: Boolean(file.downloadUrl),
      sourceSlices: true,
    }),
    inlineUrl: "",
    notice: cached.length > PREVIEW_CHUNK_LIMIT
      ? `预览显示前 ${PREVIEW_CHUNK_LIMIT} 个切片；原文件与完整解析状态未改变`
      : "",
    data: {
      groups,
      chunks: cached.length,
      truncated: cached.length > PREVIEW_CHUNK_LIMIT,
      findings: materialFindings(s, file.name),
    },
  };
}

async function modelGraphPreview(s: Session, requestedName: string): Promise<PreviewReadModel> {
  if (!["flow", "process", "actions-events"].includes(requestedName)) {
    throw apiError(404, `没有模型预览 ${requestedName}`);
  }
  const flow = asDict(s.state["flow"]);
  // /context 是 live Ontology 的唯一前端 read model。这里复用它的 item/evidence/question
  // 引用，只把 flow 图结构补成画布友好的节点/边，不再复制一套本体归一化逻辑。
  const context = await buildContextReadModel(s);
  const itemById = new Map(context.model.items.map((item) => [item.id, item]));
  const rawNodes = asRows(flow["nodes"]).map(asDict);
  const rawEdges = asRows(flow["edges"]).map(asDict);
  const stages = asRows(flow["stages"]);
  const rawWorkflows = asRows(flow["workflows"]).map(asDict);
  const nodes = rawNodes.map((node) => canvasNode(node, itemById.get(String(node["rid"] ?? ""))));
  const edges = rawEdges.map(canvasEdge);
  const workflows = rawWorkflows.map((workflow) => {
    const id = String(workflow["key"] ?? "");
    const item = itemById.get(id);
    return {
      id,
      title: String(workflow["title"] ?? item?.label ?? id),
      description: String(workflow["description"] ?? item?.description ?? ""),
      entry: String(workflow["entry"] ?? ""),
      exits: stringList(workflow["exits"]),
      status: item?.status ?? "candidate",
      grounded: item?.grounded ?? false,
      inferred: item?.inferred ?? true,
      evidenceIds: [...(item?.evidenceIds ?? [])],
      questionIds: [...(item?.questionIds ?? [])],
      nodeIds: stringList(asDict(item?.data)["nodeIds"]),
    };
  });
  const ontologyActions = context.model.items
    .filter((item) => item.type === "action")
    .map(canvasOntologyItem);
  const events = context.model.items
    .filter((item) => item.type === "event")
    .map(canvasOntologyItem);
  const available = nodes.length > 0 || edges.length > 0 || workflows.length > 0;
  const relatedArtifacts = artifactNames(s)
    .filter((name) => /(?:flow|流程|action|event)/iu.test(name))
    .filter((name) => ["svg", "png", "json", "mmd"].includes(fileFormat(name)))
    .map((name) => ({
      name,
      format: fileFormat(name),
      downloadUrl: artifactDownloadUrl(s.id, name),
      previewUrl: previewApiUrl(s.id, "artifact", name),
    }));
  const downloadUrl = relatedArtifacts[0]?.downloadUrl ?? "";
  return {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    target: {
      source: "model",
      name: "flow",
      format: "graph",
      mediaType: "application/json",
      size: nodes.length + edges.length,
    },
    previewKind: "graph",
    capabilities: capabilities({
      inline: available,
      parsed: available,
      search: available,
      zoom: available,
      download: Boolean(downloadUrl),
    }),
    previewUrl: previewApiUrl(s.id, "model", "flow"),
    inlineUrl: "",
    downloadUrl,
    sourceUrl: "",
    notice: available ? "" : "当前 revision 还没有流程图结构",
    data: {
      stages,
      workflows,
      nodes,
      edges,
      ontologyActions,
      events,
      stats: asDict(flow["stats"]),
      nodeCounts: countNodeKinds(nodes),
      provenance: context.project.provenance,
      evidence: context.evidence.records.filter((record) =>
        record.relatedIds.some((id) => itemById.has(id))),
      questionIds: [...new Set([
        ...nodes.flatMap((node) => stringList(node["questionIds"])),
        ...workflows.flatMap((workflow) => workflow.questionIds),
        ...ontologyActions.flatMap((action) => action.questionIds),
      ])],
      relatedArtifacts,
    },
  };
}

function canvasNode(raw: Dict, item: ContextModelItem | undefined): Dict {
  const labelAssertion = asDict(raw["label"]);
  return {
    id: String(raw["rid"] ?? item?.id ?? ""),
    type: String(raw["kind"] ?? item?.type ?? "process_step"),
    label: String(labelAssertion["value"] ?? item?.label ?? raw["code"] ?? ""),
    code: String(raw["code"] ?? item?.apiName ?? ""),
    stage: String(raw["stage"] ?? ""),
    status: String(raw["status"] ?? item?.status ?? "candidate"),
    actor: asDict(raw["actor"])["value"] ?? "",
    objectIds: stringList(raw["objects"]),
    endpoint: String(raw["endpoint"] ?? ""),
    grounded: typeof raw["grounded"] === "boolean" ? raw["grounded"] : (item?.grounded ?? false),
    inferred: item?.inferred ?? true,
    provenance: item?.origin ?? String(labelAssertion["origin"] ?? "inferred"),
    evidenceIds: [...(item?.evidenceIds ?? [])],
    questionIds: [...(item?.questionIds ?? [])],
    conflictIds: [...(item?.conflictIds ?? [])],
  };
}

function canvasEdge(raw: Dict): Dict {
  const evidence = asRows(raw["evidence"]).map(asDict);
  return {
    id: String(raw["rid"] ?? ""),
    source: String(raw["from"] ?? ""),
    target: String(raw["to"] ?? ""),
    type: String(raw["kind"] ?? "flow"),
    label: String(raw["label"] ?? ""),
    grounded: typeof raw["grounded"] === "boolean" ? raw["grounded"] : evidence.length > 0,
    evidence: evidence.map((row) => ({
      fileId: String(row["file_id"] ?? row["fileId"] ?? ""),
      fileName: String(row["file_name"] ?? row["fileName"] ?? ""),
      cite: String(row["cite"] ?? ""),
      locator: asDict(row["locator"]),
    })),
    questionIds: [],
  };
}

function canvasOntologyItem(item: ContextModelItem): {
  id: string;
  type: string;
  label: string;
  apiName: string;
  status: string;
  grounded: boolean;
  inferred: boolean;
  evidenceIds: string[];
  questionIds: string[];
  relatedIds: string[];
} {
  return {
    id: item.id,
    type: item.type,
    label: item.label,
    apiName: item.apiName,
    status: item.status,
    grounded: item.grounded,
    inferred: item.inferred,
    evidenceIds: [...item.evidenceIds],
    questionIds: [...item.questionIds],
    relatedIds: item.related.map((relation) => relation.id),
  };
}

async function allowedFile(s: Session, source: FileSource, requestedName: string): Promise<AllowedFile> {
  if (source === "material") await refreshFilesProjection(s);
  const allowed = source === "artifact"
    ? artifactNames(s).includes(requestedName)
    : s.files.some((file) => file.name === requestedName);
  if (!allowed) throw apiError(404, requestedName);

  // 同时拒绝 POSIX/Windows 分隔符、NUL 与特殊段。服务器当前即使跑在 POSIX，
  // 也不把一个将来换平台就变成穿越的名字写进 API 契约。
  if (
    !requestedName || requestedName === "." || requestedName === ".." ||
    requestedName.includes("/") || requestedName.includes("\\") || requestedName.includes("\0")
  ) {
    throw apiError(404, requestedName);
  }
  const base = resolve(source === "artifact" ? s.dir : join(s.dir, "materials"));
  const path = resolve(base, requestedName);
  const rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw apiError(404, requestedName);

  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw apiError(404, requestedName);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw apiError(404, requestedName);

  const format = fileFormat(requestedName);
  return {
    source,
    name: requestedName,
    path,
    size: stat.size,
    format,
    mediaType: guessMediaType(requestedName),
    downloadUrl: source === "artifact" ? artifactDownloadUrl(s.id, requestedName) : "",
    sourceUrl: source === "material" ? materialSourceUrl(s.id, requestedName) : "",
  };
}

function inlineImageSafety(file: AllowedFile): SafetyResult {
  if (file.format !== "png" && file.format !== "svg") {
    return { ok: false, notice: "内嵌内容只支持 PNG 或 SVG" };
  }
  if (file.size > PREVIEW_IMAGE_LIMIT) {
    return { ok: false, notice: "图片超过安全内嵌上限，请下载后查看" };
  }
  const bytes = readFileSync(file.path);
  if (file.format === "png") {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const valid = bytes.length >= 24 && magic.every((byte, index) => bytes[index] === byte) &&
      bytes.toString("ascii", 12, 16) === "IHDR";
    return valid
      ? { ok: true, notice: "" }
      : { ok: false, notice: "文件扩展名是 PNG，但内容不是有效的 PNG 头" };
  }
  return svgSafety(bytes.toString("utf8"));
}

function svgSafety(svg: string): SafetyResult {
  const head = svg.replace(/^\uFEFF/u, "").trimStart();
  if (!/^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/iu.test(head)) {
    return { ok: false, notice: "文件扩展名是 SVG，但内容没有 SVG 根元素" };
  }
  const denied: ReadonlyArray<readonly [RegExp, string]> = [
    [/<!(?:DOCTYPE|ENTITY)\b/iu, "SVG 含 DTD/ENTITY 声明，不能安全内嵌"],
    [/<(?:script|foreignObject|iframe|object|embed|audio|video)\b/iu,
      "SVG 含可执行或嵌入式内容，不能安全内嵌"],
    [/\son[a-z0-9:_-]+\s*=/iu, "SVG 含事件处理属性，不能安全内嵌"],
    [/(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:text\/html)/iu,
      "SVG 引用了外部或可执行资源，不能安全内嵌"],
    [/(?:@import|url\s*\(\s*["']?\s*(?:https?:|\/\/|javascript:))/iu,
      "SVG 样式引用了外部或可执行资源，不能安全内嵌"],
  ];
  for (const [pattern, notice] of denied) if (pattern.test(svg)) return { ok: false, notice };
  return { ok: true, notice: "" };
}

function downloadOnly(
  common: Omit<PreviewReadModel, "previewKind" | "capabilities" | "inlineUrl" | "notice" | "data">,
  notice: string,
): PreviewReadModel {
  return {
    ...common,
    previewKind: "download",
    capabilities: capabilities({ download: Boolean(common.downloadUrl) }),
    inlineUrl: "",
    notice,
    data: null,
  };
}

function capabilities(overrides: Partial<PreviewCapabilities>): PreviewCapabilities {
  return {
    inline: false,
    parsed: false,
    search: false,
    zoom: false,
    download: false,
    sourceSlices: false,
    ...overrides,
  };
}

/**
 * 直读表格文件 → 预览的 groups 形态。读不了（太大、格式不认、文件坏）返回 null，
 * 由调用方回落到既有的「只能下载」说明 —— 读文件失败不该变成一个 500。
 *
 * 与切片路径的差别要诚实标出来：`sourceSlices: false` —— 直读没有 cite 锚点，
 * 点不回原文；cite 给的是 `文件!表!R行` 这个位置串，只用来定位，不做跳转承诺。
 */
async function readSheets(
  file: AllowedFile,
): Promise<Pick<PreviewReadModel, "capabilities" | "inlineUrl" | "notice" | "data"> | null | "too_large"> {
  if (file.size > PREVIEW_SHEET_BYTES) return null;
  let sheets: { name: string; header: string[]; rows: string[][]; total: number }[];
  try {
    sheets = ["csv", "tsv"].includes(file.format)
      ? delimitedSheets(readFileSync(file.path, "utf8"), file.format === "tsv" ? "\t" : ",", file.name)
      : await workbookSheets(file.path);
  } catch (exc) {
    // 行数超标要与「坏文件」分开：前者要说「太大」，后者说「读不了」。
    if (exc instanceof SheetTooLarge) return "too_large";
    return null; // 坏文件/加密表：回落成「只能下载」，比抛 500 诚实
  }
  if (sheets.length === 0) return null;
  let truncated = false;
  const groups = sheets.map((sheet) => {
    if (sheet.total > sheet.rows.length) truncated = true;
    return {
      name: sheet.name,
      count: sheet.rows.length,
      rows: sheet.rows.map((cells, index) => ({
        id: `${file.name}:${sheet.name}:${index}`,
        cite: `${file.name}!${sheet.name}!R${index + 2}`,
        text: cells.filter(Boolean).join(" | "),
        tags: [] as string[],
        locator: { sheet: sheet.name, row: index + 2 },
        cells: Object.fromEntries(sheet.header.map((key, i) => [key, cells[i] ?? ""])),
      })),
    };
  });
  return {
    capabilities: capabilities({
      inline: true,
      parsed: true,
      search: true,
      download: Boolean(file.downloadUrl),
      sourceSlices: false,
    }),
    inlineUrl: "",
    notice: truncated ? `预览显示每张表前 ${PREVIEW_SHEET_ROWS} 行；原文件未改变` : "",
    data: { groups, chunks: 0, truncated, findings: [] as unknown[] },
  };
}

/** 表头 = 第一行非空单元格；其余是数据行。列数按表头截断。 */
function sheetShape(name: string, matrix: string[][]): { name: string; header: string[]; rows: string[][]; total: number } | null {
  const nonEmpty = matrix.filter((row) => row.some((cell) => cell !== ""));
  if (nonEmpty.length === 0) return null;
  const header = (nonEmpty[0] ?? []).slice(0, PREVIEW_SHEET_COLS)
    .map((cell, index) => cell || `列${index + 1}`);
  const body = nonEmpty.slice(1);
  return {
    name,
    header,
    rows: body.slice(0, PREVIEW_SHEET_ROWS).map((row) => header.map((_, i) => row[i] ?? "")),
    total: body.length,
  };
}

/** 行数超过硬阈值时抛这个 —— 由 readSheets 翻译成「太大」的说明。 */
class SheetTooLarge extends Error {}

async function workbookSheets(path: string): Promise<{ name: string; header: string[]; rows: string[][]; total: number }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: { name: string; header: string[]; rows: string[][]; total: number }[] = [];
  let tooLarge = false;
  wb.eachSheet((sheet) => {
    if (tooLarge) return;
    // rowCount 在 readFile 之后就能问，先用它做一次早停 —— 免得把 11 万行
    // 一行行搬进 matrix（内存代价就在这一步，不在后面的截断）。
    if (sheet.rowCount > PREVIEW_SHEET_HARD_ROWS) { tooLarge = true; return; }
    const matrix: string[][] = [];
    let seen = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // 只搬需要展示的那几行（多留几行给空行/表头的余量），其余只数不搬。
      seen += 1;
      if (matrix.length >= PREVIEW_SHEET_ROWS + 8) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        if (col > PREVIEW_SHEET_COLS) return;   // 列也在搬的时候就截
        cells[col - 1] = cellText(cell.value);
      });
      matrix.push([...cells].map((cell) => cell ?? ""));
    });
    const shaped = sheetShape(sheet.name || `Sheet${out.length + 1}`, matrix);
    // total 报**真实行数**（减去表头那一行），不是搬进来的那几行 —— 否则
    // 「共有多少行」会跟着截断一起说谎。
    if (shaped !== null) out.push({ ...shaped, total: Math.max(shaped.total, seen - 1) });
  });
  if (tooLarge) throw new SheetTooLarge("行数超过直读上限");
  return out;
}

/** exceljs 的单元格值有七八种形态（富文本、公式、超链接、日期）。全折成显示文本。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as Dict;
    if (Array.isArray(v["richText"])) {
      return (v["richText"] as Dict[]).map((part) => String(part["text"] ?? "")).join("");
    }
    if ("result" in v) return cellText(v["result"]);        // 公式取结果
    if ("text" in v) return String(v["text"] ?? "");        // 超链接取显示文本
    if ("error" in v) return String(v["error"] ?? "");
    return JSON.stringify(value);
  }
  return String(value);
}

/** csv/tsv：认双引号包裹与成对转义，不认多行单元格（预览够用，不做半个 parser）。 */
function delimitedSheets(text_: string, sep: string, name: string): { name: string; header: string[]; rows: string[][]; total: number }[] {
  const matrix = text_.split(/\r?\n/u).map((line) => splitDelimited(line, sep));
  const shaped = sheetShape(name, matrix);
  return shaped === null ? [] : [shaped];
}

function splitDelimited(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function previewGroup(locator: Dict, kind: "spreadsheet" | "document"): string {
  if (kind === "spreadsheet") return String(locator["sheet"] ?? locator["section"] ?? "其它");
  const section = String(locator["section"] ?? "");
  if (section) return section;
  const page = Number(locator["page"] ?? 0);
  return page > 0 ? `第 ${page} 页` : "正文";
}

function cellsFromRender(render: string): Dict {
  const out: Dict = {};
  for (const pair of render.split("|")) {
    const item = pair.trim();
    const equal = item.indexOf("=");
    if (equal <= 0) continue;
    const key = item.slice(0, equal).trim();
    if (key) out[key] = item.slice(equal + 1).trim();
  }
  return out;
}

function countNodeKinds(nodes: readonly Dict[]): Dict {
  const counts: Dict = { action: 0, event: 0, gateway: 0, terminal: 0, external: 0 };
  for (const node of nodes) {
    const kind = String(node["kind"] ?? node["type"] ?? "");
    counts[kind] = Number(counts[kind] ?? 0) + 1;
  }
  counts["total"] = nodes.length;
  return counts;
}

function artifactNames(s: Session): string[] {
  return asRows(s.state["artifacts"]).map(String).filter(safeIndexedName);
}

function safeIndexedName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." &&
    !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function fileSource(raw: string): FileSource {
  if (raw === "artifact" || raw === "material") return raw;
  throw apiError(400, `source 只支持 artifact、material 或 model，收到 ${raw}`);
}

function requiredQuery(value: string | undefined, name: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw apiError(400, `缺少查询参数 ${name}`);
  return text;
}

function fileFormat(name: string): string {
  return extname(name).toLowerCase().replace(/^\./u, "");
}

function previewApiUrl(sessionId: string, source: FileSource | "model", name: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview?source=${encodeURIComponent(source)}` +
    `&name=${encodeURIComponent(name)}`;
}

function inlineContentUrl(sessionId: string, source: FileSource, name: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview/content?source=` +
    `${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`;
}

function artifactDownloadUrl(sessionId: string, name: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(name)}`;
}

function materialSourceUrl(sessionId: string, name: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/source?file=${encodeURIComponent(name)}`;
}

function asDict(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Dict
    : {};
}

function asRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return asRows(value).map(String).filter(Boolean);
}
