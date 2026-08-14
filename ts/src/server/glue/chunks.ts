/**
 * `onto/parse/base.ts` 的 `Chunk` → `kernel/memory/evidence.ts` 的 `Chunk`。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────
 *
 * Python 侧 `onto/parse/base.py` 第 19 行直接 `from ...kernel.memory.evidence
 * import Chunk` —— 解析器吐的**就是**证据切片本体，`c.cite()` 随手可用。TS 侧
 * parse track 把它重新声明成了一个 snake_case 的纯数据 interface（解析器要一边扫
 * 一边 push，纯数据更贴合），于是这两个 `Chunk` 成了两个类型。
 *
 * 后果只有一处：`cite()` 是**方法**，纯数据对象上没有。`_preparse` /
 * `_build_flow_diagram` 都要引用出处，所以在这里补一次转换 —— **复用 evidence 的
 * 那个类**，不另写一份 cite 的格式化逻辑。cite 串会进 prompt、进 provenance、进
 * 用户看到的「点回原文」，两份实现漂开的症状是"引用点不回去"。
 */

import { Chunk as EvidenceChunk } from "../../kernel/memory/evidence.js";
import type { Chunk as ParseChunk } from "../../onto/parse/base.js";

/** 纯数据切片 → 证据切片。字段一一对应，没有任何推断。 */
export function toEvidenceChunk(c: ParseChunk): EvidenceChunk {
  return new EvidenceChunk({
    chunkId: c.chunk_id,
    fileId: c.file_id,
    fileName: c.file_name,
    locator: { ...c.locator },
    render: c.render,
    raw: c.raw,
    order: c.order,
    tags: [...c.tags],
    context: c.context,
  });
}

/** `c.cite()`。 */
export function citeOf(c: ParseChunk): string {
  return toEvidenceChunk(c).cite();
}
