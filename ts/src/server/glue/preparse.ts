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
    docs = await reg.parseAll(s.files.map((f) => f.path));
  } catch (exc) {
    // 解析失败不该让上传失败 —— 拖了个文件进来，读不动它不该让这次上传整个失败。
    s.emit("parse.failed", { error: formatExc(exc) });
    return;
  }
  const index = buildIndex(docs);
  // **保住上一轮花钱 OCR 出来的切片。** 这里是不带视觉网关的重解析（上传时、
  // 每次 hydrate 都会跑），扫描件在这条路上恒定产出 0 切片。直接覆盖的话，
  // build 阶段付费识别出来的内容就在下一次开会话时静默蒸发 —— 而 `/source`
  // 会对一份明明识别过的材料回"尚未解析"。所以：新解析没读出东西、而旧缓存
  // 里有的文件，保留旧的，并把它们重新灌回检索索引。
  const prev = (s.state["_chunks"] ?? {}) as Record<string, CachedChunk[] | undefined>;
  const fresh = chunkCache(docs);
  let kept = 0;
  for (const [fname, saved] of Object.entries(prev)) {
    const got = fresh[fname];
    if ((got !== undefined && got.length > 0) || saved === undefined || saved.length === 0) {
      continue;
    }
    fresh[fname] = saved;
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
          }),
        ),
      );
    });
    kept += saved.length;
  }
  // `_docs` 曾经存在这里，但只被写、从没被读（唯一提到它的地方是删材料时的
  // pop 列表）。存一份活的 ParsedDoc 列表在 state 里既占内存又是第二份真相 ——
  // 需要文档的地方（建流程图、切段）都在解析当场就拿到了。
  s.state["_index"] = index;
  s.state["_profiles"] = collectProfiles(docs);
  s.state["_endpoints"] = collectEndpoints(docs);
  s.state["corpus"] = corpusSummary(docs);
  s.state["_chunks"] = fresh;
  if (kept) {
    s.emit("corpus.restored", {
      chunks: kept,
      note: "沿用上一轮已识别的扫描件内容，未重新调用视觉模型",
    });
  }
  const findings = docs
    .flatMap((d) => d.findings)
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
