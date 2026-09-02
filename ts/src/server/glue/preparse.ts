/**
 * `_chunk_cache`（`server.py:1671`）与 `_preparse`（`server.py:1684`）。
 *
 * 解析装配层（`onto/parse/index.ts` = Python 的 `onto/parse/__init__.py`）由另一条
 * track 落地，这里**直接 import**。自己再写一份注册表是最坏的选择：两份注册顺序
 * 一旦不同，"同一份材料在上传路和梳理路被不同解析器接走"，而两边都不报错。
 */

import { makeChunk, type ParsedDoc } from "../../onto/parse/base.js";
import type { VisionGateway } from "../../onto/parse/vision.js";
import {
  buildIndex,
  collectEndpoints,
  collectProfiles,
  corpusSummary,
  defaultRegistry,
} from "../../onto/parse/index.js";
import { citeOf, toEvidenceChunk } from "./chunks.js";
import type { Session } from "../session.js";
import { getDocumentServiceOptional } from "../../document/deps.js";
import {
  manifestPinKey,
  projectDocumentPinsInProjection,
  reconcileProjectDocumentProjection,
} from "./document_projection.js";
import { documentScope } from "./project_scope.js";

/** `s.state["_chunks"]` 里一份材料的一片。**两条解析路共用这一个形状**。 */
export interface CachedChunk {
  readonly cite: string;
  readonly text: string;
  readonly tags: string[];
  readonly locator: Record<string, unknown>;
}

/** `_CHUNK_TEXT_CAP`（`server.py:1663`）。 */
export const CHUNK_TEXT_CAP = 1500;

/**
 * 把解析结果摊成可持久化的切片缓存。**解析的两条路共用这一个形状。**
 *
 * 以前上传那条路存全文、不带 tags，梳理管线那条存截断到 1500、带 tags —— 谁最后
 * 跑谁说了算。下游按 tags 过滤时，取决于当时是哪条路写的，行为会莫名其妙地变，
 * 而且不报错。
 */
export function chunkCache(docs: readonly ParsedDoc[]): Record<string, CachedChunk[]> {
  const out: Record<string, CachedChunk[]> = {};
  for (const d of docs) {
    out[d.file_name] = d.chunks.map((c) => ({
      cite: citeOf(c),
      // `render[:1500]` 按码点切 —— 按 UTF-16 会把中文切出半个字，而这段文本
      // 会原样进模型上下文。
      text: [...c.render].slice(0, CHUNK_TEXT_CAP).join(""),
      tags: [...(c.tags ?? [])],
      locator: { ...c.locator },
    }));
  }
  return out;
}

/**
 * 持久化切片缓存 → 活证据索引。
 *
 * hydrate、同名重传失效都要走同一条重建路径；各写一份最容易漏掉 tags，结果就是
 * 重启后 rule/relation 的检索加权悄悄消失。
 */
export function indexFromChunkCache(
  cache: Readonly<Record<string, readonly CachedChunk[] | undefined>>,
): ReturnType<typeof buildIndex> {
  const index = buildIndex([]);
  for (const [fname, saved] of Object.entries(cache)) {
    if (saved === undefined) continue;
    const fid = `restored_${fname}`;
    saved.forEach((c, i) => {
      index.add(
        toEvidenceChunk(
          makeChunk({
            docId: `r${i}`,
            fileId: fid,
            fileName: fname,
            locator: c.locator ?? {},
            render: c.text ?? "",
            order: i,
            tags: c.tags ?? [],
          }),
        ),
      );
    });
  }
  return index;
}

/**
 * 只用刚刚通过 ACL 的 manifest 保留项目切片，并立即重建一份安全索引。
 * manifest 读取失败时传 `[]`，会清掉全部项目切片但保留会话临时附件/OCR。
 */
export function reconcileDocumentEvidence(
  s: { readonly state: Record<string, unknown> },
  manifest: unknown,
  opts: { readonly forceRebuild?: boolean } = {},
): void {
  const reconciled = reconcileProjectDocumentProjection(s.state, manifest, {
    forceInvalidateDerived: opts.forceRebuild === true,
  });
  // 只在**真的动过**投影时重建索引。旧写法是 `opts.forceRebuild === true || …`，
  // 于是没有项目的会话每聊一轮都要把整份 _chunks 重新灌一遍 EvidenceIndex：
  // 真库里最大的三个会话各有 ~3.9k 切片，实测一次重建 ~140ms 冷 / ~63ms 热，
  // 全在请求路径上，且结果和上一轮一模一样。
  if (reconciled.invalidatedDerived || s.state["_index"] === undefined) {
    const safe = s.state["_chunks"] as Record<string, CachedChunk[] | undefined>;
    if (Object.values(safe).some((rows) => (rows?.length ?? 0) > 0)) {
      s.state["_index"] = indexFromChunkCache(safe);
    } else {
      delete s.state["_index"];
    }
  }
}

/** `hydrateAttachedDocumentEvidence` 需要的最小会话形状。 */
export interface DocumentEvidenceHost {
  readonly id: string;
  readonly projectId: string;
  readonly owner: string;
  readonly state: Record<string, unknown>;
  /** 对话侧的 SessionLike 没有声明 emit —— 有就发事件，没有就只留 state 上的标记。 */
  emit?(kind: string, payload?: Record<string, unknown>): unknown;
}

/**
 * 把 manifest 里**已授权但正文还没进活会话**的那些版本加载进证据索引。
 *
 * 这是「用于本次分析」点了不生效的正解。旧行为下，attach 只写一行 `session_document`，
 * 随后所有路径调的 `reconcileDocumentEvidence` 都是**纯减法**：它按 manifest 过滤
 * `_chunks`，再从**已经缓存的东西**重建索引，没有任何一条分支会去仓储读正文。
 * 结果是会话落到最坏的状态 —— `_document_manifest` 有这一行，于是 `contextBrief`
 * 告诉模型「本次已固定的项目知识：某某（v2）」，严格材料门也因此打开并要求引用；
 * 而 `_chunks`/`_index` 里一个切片都没有。模型被告知证据存在、却拿不到、还必须引用。
 *
 * 故意**不**把加载塞进 `reconcileDocumentEvidence`：那个函数是 fail-closed 的减法半边，
 * `preparse` 第 148 行正是靠它「先清空再整体重灌」，让它顺带加载会在那里重复加载一次。
 *
 * 判定依据取自 `_chunks` 而不是某个变更计数器，所以它也顺带自愈了
 * `refreshChatProjection` 那个洞：持久化副本里的 DOC 正文本来就被剥掉了
 * （pipeline/persist.ts），跨 worker 状态回灌之后这里会自然把它补回来。
 *
 * @returns 是否真的加载了新正文（steady state 恒为 false，不碰任何东西）。
 */
export async function hydrateAttachedDocumentEvidence(
  s: DocumentEvidenceHost,
  manifest: unknown,
): Promise<boolean> {
  const rows = Array.isArray(manifest) ? (manifest as Record<string, unknown>[]) : [];
  if (rows.length === 0) return false;
  const present = projectDocumentPinsInProjection(s.state);
  const wanted = rows.map(manifestPinKey).filter((key): key is string => key !== null);
  // 稳定态：清单里每一版的正文都已经在活会话里 —— 什么都不做，连索引都不重建。
  if (wanted.length > 0 && wanted.every((key) => present.has(key))) return false;

  const documents = getDocumentServiceOptional();
  if (documents === null) {
    // fail closed：绝不能留下一条指向「加载不到的正文」的 manifest 行。
    s.state["_document_manifest"] = [];
    s.state["_document_manifest_error"] = "项目知识库服务尚未就绪，未使用任何历史项目切片。";
    reconcileDocumentEvidence(s, [], { forceRebuild: true });
    return false;
  }
  try {
    // loadAttachedParsedDocs 会对每个精确版本重新鉴权并钉住 ACL revision，
    // 所以轮中加载必须走它，而不是更便宜的仓储直读。
    const loaded = await documents.loadAttachedParsedDocs({
      ...(await documentScope(s)),
      sessionId: s.id,
    });
    // 用刚刚重新裁决过的那份 manifest，而不是调用方传进来的。
    s.state["_document_manifest"] = loaded.manifest;
    delete s.state["_document_manifest_error"];
    const cache = {
      ...(s.state["_chunks"] as Record<string, CachedChunk[]> | undefined ?? {}),
      ...chunkCache(loaded.documents),
    };
    s.state["_chunks"] = cache;
    // 整体重建而不是增量并入：增量形态会让 buildIndex 的真实 fileId 和后续重建时的
    // `restored_<name>` 两套键共存，`evidence.search(files=[...])` 的答案会取决于
    // 你什么时候看。这条路径只在挂载真的变化的那一轮走。
    s.state["_index"] = indexFromChunkCache(cache);
    // 不删 _profiles/_endpoints：文档集合只增不减，全语料汇总仍然成立。
    return true;
  } catch (exc) {
    s.state["_document_manifest"] = [];
    s.state["_document_manifest_error"] = formatExc(exc);
    reconcileDocumentEvidence(s, [], { forceRebuild: true });
    s.emit?.("document.load_failed", { error: formatExc(exc) });
    return false;
  }
}

/**
 * 新增/同名替换材料后，旧派生状态不能继续冒充当前文件的解析结果。
 * 未变化文件的缓存与检索仍保留；profiles/endpoints 涉及全语料汇总，只能失效。
 * corpus 本身也是按文件展开的，所以保留未变化文件那部分；否则重传一份文本会把
 * 另一份已 OCR 材料的成功/失败状态一起抹掉。
 */
export function invalidateMaterialCaches(s: Session, names: ReadonlySet<string>): void {
  const previous = (s.state["_chunks"] ?? {}) as Record<string, CachedChunk[] | undefined>;
  const kept: Record<string, CachedChunk[]> = {};
  for (const [name, chunks] of Object.entries(previous)) {
    if (!names.has(name) && chunks !== undefined) kept[name] = chunks;
  }
  s.state["_chunks"] = kept;
  s.state["_index"] = indexFromChunkCache(kept);
  const corpus = filteredCorpus(s.state["corpus"], names, kept);
  if (corpus === null) delete s.state["corpus"];
  else s.state["corpus"] = corpus;
  for (const key of ["_profiles", "_endpoints"]) delete s.state[key];
}

/**
 * 解析材料、建证据索引，让对话能查材料。**不产出任何本体/流程图/模板。**
 *
 * `vision` 默认不给：扫描件在这条路上只登记不识别 —— 识别要调模型、要花钱，
 * 不该由"拖了个文件进来"触发。给了就连图片一起识别，用于用户明确说"分析一下
 * 这张图"的场景（他要的是读懂这张图，不是启动整条梳理管线）。
 */
export async function preparse(
  s: Session,
  opts: { vision?: VisionGateway | null } = {},
): Promise<void> {
  const vision = opts.vision ?? null;
  // 项目正文每次都从 DocumentService 重新鉴权并装载，绝不拿持久化旧缓存顶替。
  // 会话临时附件（包括付费 OCR）仍保留，下面原有合并逻辑只会看到这些安全切片。
  reconcileDocumentEvidence(s, [], { forceRebuild: true });
  let docs: ParsedDoc[];
  try {
    const reg = defaultRegistry({
      visionGateway: vision,
      visionProgress:
        vision !== null ? (m: string) => s.emit("flow.step", { cite: "", found: m }) : null,
    });
    docs = await reg.parseAll(s.files.map((f) => f.path), { continueOnError: true });
  } catch (exc) {
    // 解析失败不该让上传失败 —— 拖了个文件进来，读不动它不该让这次上传整个失败。
    s.emit("parse.failed", { error: formatExc(exc) });
    return;
  }
  // OntoDocument 与会话临时附件汇入同一份证据索引，但身份绝不能混：项目文档的
  // file_id/chunk_id 来自不可变 version，文件名只用于显示。只有显式 attach 到本会话
  // 的精确版本会进入这里；项目库里后来出现的新版本不会自动替换。
  const documents = getDocumentServiceOptional();
  if (documents !== null && s.projectId) {
    try {
      // owner 走项目边界解析：HTTP 侧存进去的分区是项目的，这里用会话的
      // 就会读到另一个（空的）分区。见 glue/project_scope.ts。
      const loaded = await documents.loadAttachedParsedDocs({
        ...(await documentScope(s)),
        sessionId: s.id,
      });
      docs.push(...loaded.documents);
      s.state["_document_manifest"] = loaded.manifest;
      delete s.state["_document_manifest_error"];
    } catch (exc) {
      // 对话侧可以继续处理临时附件，但必须显式标出项目文档没有加载，不能把缺失
      // 伪装成“知识库里没有”。严格材料门会因 manifest/项目材料存在而拒绝无证据结论。
      s.emit("document.load_failed", { error: formatExc(exc) });
      s.state["_document_manifest"] = [];
      s.state["_document_manifest_error"] = formatExc(exc);
      reconcileDocumentEvidence(s, [], { forceRebuild: true });
    }
  } else if (s.projectId) {
    s.state["_document_manifest"] = [];
    s.state["_document_manifest_error"] = "项目知识库服务尚未就绪，未使用任何历史项目切片。";
    reconcileDocumentEvidence(s, [], { forceRebuild: true });
  } else {
    s.state["_document_manifest"] = [];
    delete s.state["_document_manifest_error"];
  }
  const index = buildIndex(docs);
  const previousCorpus = asRecord(s.state["corpus"]);
  // **保住上一轮花钱 OCR 出来的切片。** 这里是不带视觉网关的重解析（上传时、
  // 每次 hydrate 都会跑），扫描件在这条路上恒定产出 0 切片；混合 PDF 则会读出
  // 文本页、但不会重新 OCR 扫描页。直接覆盖的话，
  // build 阶段付费识别出来的内容就在下一次开会话时静默蒸发 —— 而 `/source`
  // 会对一份明明识别过的材料回"尚未解析"。所以：全空时保留整份旧缓存；本次
  // 已读到原生文本时，仍把旧缓存里带 `ocr` 标签的页合回来。按完整切片身份去重，
  // 不能按 cite 去重 —— 同一 PDF 页的多个 OCR 块本来就共享一个 `#pN` cite。
  const prev = (s.state["_chunks"] ?? {}) as Record<string, CachedChunk[] | undefined>;
  const fresh = chunkCache(docs);
  let kept = 0;
  const restoredFiles = new Set<string>();
  for (const [fname, saved] of Object.entries(prev)) {
    const got = fresh[fname];
    if (saved === undefined || saved.length === 0) continue;
    const candidates = got === undefined || got.length === 0
      ? saved
      : vision === null
        ? saved.filter((chunk) => chunk.tags.includes("ocr"))
        : [];
    if (candidates.length === 0) continue;
    const seen = new Set((got ?? []).map(cachedChunkIdentity));
    const reused = candidates.filter((chunk) => {
      const key = cachedChunkIdentity(chunk);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (reused.length === 0) continue;
    fresh[fname] = [...(got ?? []), ...reused];
    const restored = indexFromChunkCache({ [fname]: reused });
    index.addAll(restored.allChunks());
    kept += reused.length;
    restoredFiles.add(fname);
  }
  // `_docs` 曾经存在这里，但只被写、从没被读（唯一提到它的地方是删材料时的
  // pop 列表）。存一份活的 ParsedDoc 列表在 state 里既占内存又是第二份真相 ——
  // 需要文档的地方（建流程图、切段）都在解析当场就拿到了。
  s.state["_index"] = index;
  s.state["_profiles"] = collectProfiles(docs);
  s.state["_endpoints"] = collectEndpoints(docs);
  const summary = { ...corpusSummary(docs), chunks: index.size };
  for (const stat of summary.files) {
    const name = String(stat["file"] ?? "");
    if (restoredFiles.has(name)) stat["chunks"] = fresh[name]?.length ?? 0;
  }
  // 上一轮 pipeline 的 findings 才知道 OCR 当时是完整成功、页数截断还是中途失败。
  // hydrate 的免费重解析只会得到笼统的 vision_pending；恢复了旧 OCR 切片时，用上一
  // 轮同文件的状态替换它，避免 UI 把一份完整识别过的材料误标成“部分读入”。
  const previousFindings = asArray(previousCorpus["findings"]);
  for (const fname of restoredFiles) {
    const prior = previousFindings
      .map(asRecord)
      .filter((finding) => String(finding["file"] ?? "") === fname);
    if (prior.length === 0) continue;
    for (let i = summary.findings.length - 1; i >= 0; i -= 1) {
      if (summary.findings[i]?.file === fname) summary.findings.splice(i, 1);
    }
    summary.findings.push(...prior.map((finding) => ({
      file: fname,
      kind: String(finding["kind"] ?? ""),
      severity: String(finding["severity"] ?? "info"),
      message: String(finding["message"] ?? ""),
      locator: asRecord(finding["locator"]),
    })));
  }
  s.state["corpus"] = summary;
  s.state["_chunks"] = fresh;
  if (kept) {
    s.emit("corpus.restored", {
      chunks: kept,
      note: "沿用上一轮已识别的扫描件内容，未重新调用视觉模型",
    });
  }
  const findings = summary.findings
    .slice(0, 12)
    .map((f) => ({
      kind: f.kind,
      message: f.message,
      severity: f.severity,
      locator: { ...f.locator } as Record<string, never>,
    }));
  s.emit("corpus.ready", {
    stats: { files: docs.length, chunks: index.size },
    findings,
  });
}

function formatExc(exc: unknown): string {
  if (exc instanceof Error) return `${exc.name}: ${exc.message}`;
  return `${typeof exc}: ${String(exc)}`;
}

/** 重传一部分材料时，保住其他文件的逐文件解析状态；聚合 chunk 数按现存缓存重算。 */
function filteredCorpus(
  raw: unknown,
  changed: ReadonlySet<string>,
  kept: Readonly<Record<string, readonly CachedChunk[] | undefined>>,
): Record<string, unknown> | null {
  const corpus = asRecord(raw);
  if (!Array.isArray(corpus["files"]) || !Array.isArray(corpus["findings"])) return null;
  const files = asArray(corpus["files"])
    .map(asRecord)
    .filter((stat) => !changed.has(String(stat["file"] ?? "")));
  const findings = asArray(corpus["findings"])
    .map(asRecord)
    .filter((finding) => !changed.has(String(finding["file"] ?? "")));
  if (files.length === 0 && findings.length === 0) return null;
  const chunks = Object.values(kept).reduce((sum, list) => sum + (list?.length ?? 0), 0);
  return { ...corpus, files, findings, chunks };
}

/** cite 在 page locator 上不唯一；正文、标签与 locator 都要参与缓存去重。 */
function cachedChunkIdentity(chunk: CachedChunk): string {
  return JSON.stringify([chunk.cite, chunk.text, chunk.tags, chunk.locator]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
