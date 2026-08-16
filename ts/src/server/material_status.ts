/**
 * 一份材料在 UI / API / 对话工具里的统一解析状态。
 *
 * `_chunks` 只能回答“现在缓存了几段”，不能回答“为什么只有这些段”。混合 PDF
 * 可能已经读到文本页、但仍有扫描页待识别；失败的解析器也会留下一个空数组。
 * 真正的状态必须把 chunks 与 `corpus.findings` 一起看，而且所有出口要共用同一套
 * 优先级，否则页面说“已解析”、工具却说“待识别”。
 */

export type MaterialParseState =
  | "parsed"
  | "partial"
  | "failed"
  | "unsupported"
  | "pending"
  | "unread";

export interface MaterialStateSource {
  readonly state: Record<string, unknown>;
  readonly files: readonly {
    readonly name: string;
    readonly size?: number;
  }[];
}

export interface MaterialFindingView {
  readonly file: string;
  readonly kind: string;
  readonly severity: string;
  readonly message: string;
  readonly locator: Readonly<Record<string, unknown>>;
}

export interface MaterialStatusView {
  readonly chunks: number;
  readonly state: MaterialParseState;
  readonly issue?: string;
  readonly issue_kind?: string;
}

export interface MaterialFileView extends MaterialStatusView {
  readonly name: string;
  readonly size: number;
}

const SCAN_SUFFIXES = [
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
] as const;

const FAILED_FINDINGS = new Set([
  "parse_failed", "vision_failed", "empty_ocr", "no_vision_model",
]);

/** 有内容但没有读全，也不能叫“已解析”。 */
const PARTIAL_FINDINGS = new Set(["vision_pending", "page_limit"]);

export function materialFindings(
  s: Pick<MaterialStateSource, "state">,
  fileName: string,
): MaterialFindingView[] {
  const corpus = asRecord(s.state["corpus"]);
  const out: MaterialFindingView[] = [];
  for (const raw of asArray(corpus["findings"])) {
    const f = asRecord(raw);
    if (String(f["file"] ?? "") !== fileName) continue;
    out.push({
      file: fileName,
      kind: String(f["kind"] ?? ""),
      severity: String(f["severity"] ?? "info"),
      message: String(f["message"] ?? ""),
      locator: asRecord(f["locator"]),
    });
  }
  return out;
}

export function materialStatus(
  s: Pick<MaterialStateSource, "state">,
  fileName: string,
): MaterialStatusView {
  const cache = asRecord(s.state["_chunks"]);
  const value = cache[fileName];
  const chunks = Array.isArray(value) ? value.length : 0;
  const findings = materialFindings(s, fileName);
  const corpusFiles = asArray(asRecord(s.state["corpus"])["files"]);
  const parsedOnce = corpusFiles.some((raw) => String(asRecord(raw)["file"] ?? "") === fileName);

  const unsupported = findings.find((f) => f.kind === "unsupported");
  const failed = findings.find((f) => FAILED_FINDINGS.has(f.kind));
  const incomplete = findings.find((f) => PARTIAL_FINDINGS.has(f.kind));
  const issue = unsupported ?? failed ?? incomplete;

  let state: MaterialParseState;
  if (unsupported !== undefined) state = chunks > 0 ? "partial" : "unsupported";
  else if (failed !== undefined) state = chunks > 0 ? "partial" : "failed";
  else if (incomplete !== undefined) state = chunks > 0 ? "partial" : "pending";
  else if (chunks > 0) state = "parsed";
  // 空文件也可能被完整、成功地解析成 0 段；corpus.files 是“解析器跑完了”的证据。
  else if (parsedOnce) state = "parsed";
  else if (isScan(fileName)) state = "pending";
  else state = "unread";

  return {
    chunks,
    state,
    ...(issue === undefined || issue.message === "" ? {} : { issue: issue.message }),
    ...(issue === undefined || issue.kind === "" ? {} : { issue_kind: issue.kind }),
  };
}

export function materialFileList(s: MaterialStateSource): MaterialFileView[] {
  return s.files.map((f) => ({
    name: f.name,
    size: Math.trunc(Number(f.size ?? 0) || 0),
    ...materialStatus(s, f.name),
  }));
}

function isScan(name: string): boolean {
  const lower = name.toLowerCase();
  return SCAN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
