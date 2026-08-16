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
