/**
 * DDL 解析 —— **不在 TS 侧实现**，过 sidecar 调 Python 的 sqlglot（契约 §2.3）。
 *
 * 为什么不迁：
 *
 * **注释是这个解析器最重要的产出**，不是附属信息。`plan_amount DECIMAL(18,2)`
 * 在两张表里长得一模一样，区别全在 `-- 含税·年度累计` 和 `-- 不含税·单次`
 * 这两行注释里。丢掉注释，口径冲突就永远发现不了。而"把注释按行号关联回列定义"
 * 这套土办法是**建立在 sqlglot 的 AST 之上**的（先解析出列名，再拿行扫描的结果
 * 去补）。JS 侧没有 sqlglot 的对等物，自己写一个多方言 DDL 解析器只会得到一个
 * "看起来在跑、口径悄悄丢一半"的东西。
 *
 * 所以这个文件只有一件事：**把 sidecar 返回的线上形态接回本地形态**。逻辑一行都
 * 不许在这里重新实现 —— 否则两个宿主就不是同一份行为了。
 */

import { basename } from "node:path";

import type { ParsedDoc } from "./base.js";
import { Parser, makeChunk, makeFinding, makeParsedDoc, readTextReplace } from "./base.js";

/**
 * `/sql/parse` 的**真实**返回形状（`sidecar/app.py:136-143`）。
 *
 * 这里没有直接用 `sidecar/client.ts` 的 `ParsedChunk` / `ParsedFinding`：那两个
 * interface 把 `locator` 和 `raw` 写成了 `string`、把 `tags` 写成了
 * `Record<string, unknown>`，而 app.py 交出来的分别是 dict、任意 JSON、str 数组。
 * 键名是对的、类型是错的。client.ts 是主 agent 的文件，不由我改 —— 所以在这里
 * 按 app.py 重新声明一份，并在接入口做一次 `as unknown as` 的显式转换。
 * **这一处是有意为之的类型断言**，不是偷懒：见 notes 里给主 agent 的修正建议。
 */
interface WireChunk {
  readonly chunk_id: string;
  readonly locator: Record<string, unknown>;
  readonly render: string;
  readonly raw: unknown;
  readonly order: number;
  readonly tags: readonly string[];
}

interface WireFinding {
  readonly kind: string;
  readonly message: string;
  readonly locator: Record<string, unknown>;
  readonly severity: string;
}

interface WireDoc {
  readonly file_id: string;
  readonly file_name: string;
  readonly kind: string;
  readonly structured: Record<string, unknown>;
  readonly chunks: readonly WireChunk[];
  readonly findings: readonly WireFinding[];
}

/**
 * 只要求"能解析 DDL"这一个能力，而不是整个 `SidecarClient`。
 *
 * 这样测试可以喂 golden 里那份 `wire`（sidecar 真跑出来的），不必起进程、不必
 * 打桩 fetch。`SidecarClient` 结构上满足它 —— 测试里有一条编译期断言盯着这件事。
 */
export interface SqlParseClient {
  parseSql(sql: string, opts: { dialect?: string; fileName?: string }): Promise<unknown>;
}

export class DdlParser extends Parser {
  override readonly kind = "ddl";
  override readonly extensions = [".ddl", ".sql"];

  constructor(
    private readonly client: SqlParseClient,
    private readonly dialect: string | null = null,
  ) {
    super();
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileName = basename(path);
    // Python 侧是 `read_text(encoding="utf-8", errors="replace")`，不是 tabular
    // 那套编码猜测 —— DDL 基本都是 UTF-8，猜错编码比读出替换字符更难查。
    const sql = await readTextReplace(path);
    const wire = (await this.client.parseSql(sql, {
      dialect: this.dialect ?? "",
      fileName,
    })) as unknown as WireDoc;
    return adoptWireDoc(wire, { fileId: opts.fileId, fileName });
  }
}

/**
 * 线上形态 → 本地 `ParsedDoc`。
 *
 * 三处必须改写，别当成"字段搬家"：
 *
 * 1. **`chunk_id` 要重新加前缀。** sidecar 那边 `file_id` 恒为 `"sidecar"`
 *    （app.py:135 写死的），所以两份不同的 DDL 交回来的 chunk_id 会长得一模一样。
 *    而 `EvidenceIndex.add()` 见到重复 chunk_id 是**直接 return**、不报错的 ——
 *    原样接进去的后果是第二份 DDL 整个消失，且没有任何人被告知。
 * 2. **`file_id` / `file_name` 要补回每个切片。** 线上形态没有这两个字段（doc 级
 *    有、chunk 级没有），而按文件过滤的检索和引用串全靠它们。
 * 3. **`context` 补空串。** 它属于本地形态，线上形态里不存在。
 */
export function adoptWireDoc(
  wire: WireDoc,
  opts: { fileId: string; fileName: string },
): ParsedDoc {
  if (!Array.isArray(wire.chunks) || !Array.isArray(wire.findings)) {
    // 形状漂移要**响**。悄悄当成空文档的话，一次 sidecar 改字段会以"这份 DDL
    // 里没有表"的形态出现在用户面前，排查方向整个跑偏。
    throw new Error("sidecar /sql/parse 返回的形状不对：chunks / findings 不是数组");
  }
  const { fileId, fileName } = opts;
  const doc = makeParsedDoc({ fileId, fileName, kind: wire.kind });
  doc.structured = wire.structured;
  const prefix = `${wire.file_id}:`;
  for (const c of wire.chunks) {
    doc.chunks.push(
      makeChunk({
        docId: c.chunk_id.startsWith(prefix) ? c.chunk_id.slice(prefix.length) : c.chunk_id,
        fileId,
        fileName,
        locator: c.locator,
        render: c.render,
        raw: c.raw,
        order: c.order,
        tags: c.tags,
      }),
    );
  }
  for (const f of wire.findings) {
    doc.findings.push(makeFinding(f.kind, f.message, f.locator, f.severity));
  }
  return doc;
}
