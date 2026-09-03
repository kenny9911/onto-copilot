/**
 * 会话里的 OntoDocument 派生投影不是权限票据。
 *
 * 项目文档的权威正文位于 DocumentRepository；`_chunks` 只是一份运行期索引缓存。
 * 旧实现把 `DOC[document@version] ...` 一起持久化，hydrate 又会无条件恢复，导致
 * attach → persist → 撤权 → 重启后，撤权前正文重新进入 EvidenceIndex。本模块集中
 * 识别并清理这类缓存，所有调用方共享同一条 fail-closed 规则。
 */

export interface ProjectDocumentPin {
  readonly documentId: string;
  readonly versionId: string;
}

type Dict = Record<string, unknown>;

const PINNED_NAME = /^DOC\[([^@\]\s]+)@([^\]\s]+)\](?:\s|$)/u;

function record(value: unknown): Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Dict
    : {};
}

/** 解析 Harness 为不可变项目版本生成的保留文件名。 */
export function projectDocumentPin(fileName: string): ProjectDocumentPin | null {
  const match = PINNED_NAME.exec(fileName);
  if (match === null) return null;
  return { documentId: match[1]!, versionId: match[2]! };
}

/** locator 是更强的身份；名称前缀兼容已经落库的旧投影。 */
function pinFromChunks(fileName: string, chunks: unknown): ProjectDocumentPin | null {
  if (Array.isArray(chunks)) {
    for (const raw of chunks) {
      const locator = record(record(raw)["locator"]);
      const documentId = String(locator["_document_id"] ?? "").trim();
      const versionId = String(locator["_version_id"] ?? "").trim();
      if (documentId && versionId) return { documentId, versionId };
    }
  }
  return projectDocumentPin(fileName);
}

const pinKey = (pin: ProjectDocumentPin): string => `${pin.documentId}\u0000${pin.versionId}`;

/**
 * 活会话投影里**当前确实持有正文**的那些精确版本。
 *
 * 「这份版本的正文在不在活会话里」只有这一个答案来源 —— 加载判定和撤权过滤共用
 * 同一条身份规则（locator 优先、DOC[...] 名称前缀兼容旧投影），否则两份手写解析
 * 早晚会漂移，症状是某一份文档被静默重复加载、或者静默永不加载。
 */
export function projectDocumentPinsInProjection(state: Dict): Set<string> {
  const out = new Set<string>();
  for (const [fileName, chunks] of Object.entries(record(state["_chunks"]))) {
    const pin = pinFromChunks(fileName, chunks);
    if (pin !== null) out.add(pinKey(pin));
  }
  return out;
}

/** manifest 行 → 与上面同构的身份键。 */
export function manifestPinKey(row: Dict): string | null {
  const documentId = String(row["document_id"] ?? "").trim();
  const versionId = String(row["version_id"] ?? "").trim();
  if (!documentId || !versionId) return null;
  return pinKey({ documentId, versionId });
}

/**
 * 返回不含未授权项目切片的新缓存。`allowed=null` 表示项目切片一律不保留；这用于
 * 持久化，因为项目正文无需在 Session state 留第二份真相。传 manifest 时只保留
 * 当前调用刚刚重新鉴权成功的精确版本。
 */
export function filterProjectDocumentChunks(
  raw: unknown,
  allowed: readonly ProjectDocumentPin[] | null = null,
): Record<string, unknown> {
  const source = record(raw);
  const allowedKeys = allowed === null ? null : new Set(allowed.map(pinKey));
  const out: Record<string, unknown> = {};
  for (const [fileName, chunks] of Object.entries(source)) {
    const pin = pinFromChunks(fileName, chunks);
    if (pin === null || (allowedKeys !== null && allowedKeys.has(pinKey(pin)))) {
      out[fileName] = chunks;
    }
  }
  return out;
}

function pinsFromManifest(raw: unknown): ProjectDocumentPin[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectDocumentPin[] = [];
  for (const item of raw) {
    const row = record(item);
    const documentId = String(row["document_id"] ?? "").trim();
    const versionId = String(row["version_id"] ?? "").trim();
    if (documentId && versionId) out.push({ documentId, versionId });
  }
  return out;
}

function isAllowedCorpusFile(fileName: string, allowed: ReadonlySet<string>): boolean {
  const pin = projectDocumentPin(fileName);
  return pin === null || allowed.has(pinKey(pin));
}

/**
 * 原地收敛 Session 投影到刚刚实时取得的 manifest。调用方随后应重建 `_index`；这里
 * 先删活索引，保证任何遗漏都是“暂时没有证据”，而不是继续使用撤权前证据。
 */
export function reconcileProjectDocumentProjection(
  state: Dict,
  manifest: unknown,
  opts: { readonly forceInvalidateDerived?: boolean } = {},
): { readonly removedFiles: readonly string[]; readonly invalidatedDerived: boolean } {
  const allowedPins = pinsFromManifest(manifest);
  const allowed = new Set(allowedPins.map(pinKey));
  const before = record(state["_chunks"]);
  const after = filterProjectDocumentChunks(before, allowedPins);
  const removedFiles = Object.keys(before).filter((name) => !(name in after));
  state["_chunks"] = after;

  // 投影里**本来就没有**项目正文时，没有任何东西需要撤权 —— 这时 forceInvalidateDerived
  // 只是白白把画像和端点删掉。而删掉它们的代价是不可逆的：`_profiles`/`_endpoints`
  // 只有 preparse 和流水线会重算（glue/preparse.ts:232-233），reconcile 自己从不重算，
  // 且它们只活在内存里（session_state 里查不到这两个 key）。glue/tools.ts:1039 又是
  // `if (profiles !== null && Object.keys(profiles).length > 0)` 才注册 `data.profile`，
  // 所以「没有项目的会话」每聊一轮就会把列画像删掉、把 data.profile 摘掉，直到下次
  // preparse。真实库里 33/42 个会话 project_id 为空，也就是说这是常态而不是边角。
  const hadProjectText = Object.entries(before).some(
    ([fileName, chunks]) => pinFromChunks(fileName, chunks) !== null,
  );
  const invalidatedDerived =
    removedFiles.length > 0 || (opts.forceInvalidateDerived === true && hadProjectText);

  // EvidenceIndex/画像/端点都可能含已撤权正文，不能只改序列化缓存而留活对象。
  // 成功刷新且精确版本集合未变时不必把仍获授权的运行期索引白白清掉。
  if (invalidatedDerived) {
    delete state["_index"];
    delete state["_profiles"];
    delete state["_endpoints"];
  }

  const corpus = record(state["corpus"]);
  if (Object.keys(corpus).length > 0) {
    const files = Array.isArray(corpus["files"])
      ? corpus["files"].filter((item) =>
          isAllowedCorpusFile(String(record(item)["file"] ?? ""), allowed))
      : [];
    const findings = Array.isArray(corpus["findings"])
      ? corpus["findings"].filter((item) =>
          isAllowedCorpusFile(String(record(item)["file"] ?? ""), allowed))
      : [];
    state["corpus"] = {
      ...corpus,
      files,
      findings,
      chunks: Object.values(after).reduce<number>(
        (sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0),
        0,
      ),
    };
  }
  return { removedFiles, invalidatedDerived };
}
