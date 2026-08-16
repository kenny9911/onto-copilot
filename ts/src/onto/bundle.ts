/**
 * Ontology 交付包（Bundle）—— 把一个会话的全部产物打成一个可下载的 zip。
 * 移植自 `src/ontocopilot/onto/bundle.py`。
 *
 * FDE 跑完梳理，手里是一堆散落在会话目录里的文件（模板 xlsx、流程图 SVG、oir.json…）。
 * 他真正要交付给业务方/下游的，是**一个自洽的包**：产物 + 一份清单（manifest）+ 一份
 * 中文交付说明。清单里最关键的一件事是**把「有据」和「推断」标出来** —— 灰色/虚线的
 * 东西是系统猜的，交付前必须让人知道哪些还没有材料依据。
 *
 * 这个模块是**纯函数、零依赖**（只用 node:zlib 做 deflate），和 diagram.ts /
 * flow_extract.ts 一样可以脱离服务单测。打包逻辑不塞进 server，就是为了能这样测。
 *
 * ── 移植时被钉住的 Python/JS 分叉 ────────────────────────────────
 *
 *  1. **`x or fallback` 的真值判断**：Python 里 `[]` / `{}` / `""` / `0` 都是假，
 *     JS 里 `[]` `{}` 是真。`flow.get("stats") or {}`、`int(stats.get("dead_ends") or 0)`
 *     全靠这一条。见 `pyTruthy`。
 *  2. **`sorted(files, key=path)`** 按 code point 排；JS 默认 sort 按 UTF-16 code
 *     unit 排。文件名里有中文（`流程图.svg`）时两者可能不同序，而 bundle_id 是
 *     排完序拼出来哈希的 —— 排序一漂，同样的产物在两侧算出不同的版本戳。
 *  3. **zip 的字节**：Python `zipfile.writestr(str, ...)` 把 **当前本地时间**
 *     写进每个成员的 mtime（`time.localtime(time.time())[:6]`），所以
 *     **Python 侧的 build_zip 本身就不是字节确定的**。这里照实迁（默认取当前
 *     本地时间），另外开一个 `dateTime` 选项让调用方冻结它 —— golden 就是靠
 *     冻结之后做整包字节比对的。默认行为一个字节都没改。
 *  4. **整数值的 float**：Python 的 `round(1.0, 3)` 还是 float，`json.dumps` 印成
 *     `1.0`；JS 的 number 分不出 int/float，印出 `1`。manifest 里的
 *     `generated_at` 命中这一条（见 `pyJsonDumps` 的说明）。
 *  5. **deflate 的字节两侧对不上**：CPython 链接的是 zlib 1.2.12，Node 24 带的是
 *     打过 Chromium 优化补丁的 1.3.1。同一份输入、同样的 level/memLevel/strategy，
 *     两者产出的 deflate 流**都合法但不同**（实测 1827 字节的 manifest.json：
 *     Python 848 字节，Node 864 字节；小而规整的输入反而常常一致）。
 *     所以「TS 打的包与 Python 打的包字节全等」是**做不到**的，别去追。
 *     真正要守住的是另外两条，golden 也是按这两条钉的：
 *       · zip 的**容器形态**逐字节一致（头部字段、成员顺序、CRC、原始大小、
 *         mtime、external_attr）；
 *       · **解压出来的每个成员字节一致**。
 *     产品要的"同样输入同样字节"是**同一个实现内**的可复现性 —— 冻结 dateTime
 *     之后 TS 侧满足，因为 zlib 对同一输入是确定的。
 */

import { deflateRawSync } from "node:zlib";

import { sha256Hex } from "../kernel/ids.js";
import { round3 } from "./oir.js";

export const BUNDLE_SCHEMA = "ontocopilot.bundle/1";

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/** Python 的真值判断。`x or y` 在这个模块里出现十几次，每一处都靠它。 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (typeof v === "number") return !Number.isNaN(v) ? v !== 0 : true; // NaN 在 Python 里是真
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function isPlainDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python 的 `d.get(k)` —— d 不是 dict 时会 AttributeError。
 *
 * **不静默返回 undefined**：一份 nodes 里混进字符串的 flow.json，静默跳过等于
 * 把「这份产物结构不对」这件事吞掉，而汇总数字照样出得来、照样进交付包。 */
function dget(d: unknown, k: string): unknown {
  if (!isPlainDict(d)) {
    throw new TypeError(`AttributeError: ${JSON.stringify(d)} 没有 .get —— 期望一个对象`);
  }
  const v = d[k];
  return v === undefined ? null : v;
}

/** Python 的 `int(x)`：float 向零截断，str 按十进制解析，不合法就抛。 */
function pyInt(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError(`cannot convert ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^[+-]?\d+$/.test(s)) throw new RangeError(`invalid literal for int(): '${v}'`);
    return Number(s);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${typeof v}'`);
}

/** Python 的 `str.__lt__`：按 code point 比。中文文件名的排序全靠它。 */
function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return x.length - y.length;
}

/** Python 的 `float.__repr__` 在 JSON 里的形态。
 *
 * 已知**无法**在 TS 侧复现的一条：Python 的 `1.0` 印成 `"1.0"`，JS 的 number
 * 里不存在「整数值的 float」这个概念，只能印成 `1`。manifest 的 `generated_at`
 * 是 `round(time.time(), 3)`，实际取值几乎不会是整秒，但用 `generated_at=1.0`
 * 这种手写值调用时两侧 manifest 会差这一个字节。**照实报出来，不假装修好** ——
 * 要修得在 Python 侧一起改（例如统一走 ISO 字符串）。 */
function pyNumRepr(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  // Python 的指数至少两位（`1e-07`），JS 是 `1e-7`。
  return String(n).replace(/e([+-])(\d)$/, "e$10$2");
}

/** `json.dumps(obj, ensure_ascii=False, indent=2)` 的等价物。
 *
 * 不能直接用 `JSON.stringify(o, null, 2)`：数字形态（见 `pyNumRepr`）之外，
 * `undefined` 在 JS 里会被整个丢掉键，而 Python 没有 undefined —— 这里统一
 * 当成 `null`，宁可印出 null 也不要让一个键凭空消失。 */
export function pyJsonDumps(value: unknown, indent = 2): string {
  const pad = " ".repeat(indent);
  const enc = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return pyNumRepr(v);
    if (typeof v === "string") return JSON.stringify(v);
    const nl = "\n" + pad.repeat(depth + 1);
    const end = "\n" + pad.repeat(depth);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[" + nl + v.map((x) => enc(x, depth + 1)).join("," + nl) + end + "]";
    }
    const pairs: [string, unknown][] =
      v instanceof Map ? [...v.entries()].map(([k, x]) => [String(k), x]) : Object.entries(v);
    if (pairs.length === 0) return "{}";
    const body = pairs
      .map(([k, x]) => `${JSON.stringify(k)}: ${enc(x, depth + 1)}`)
      .join("," + nl);
    return "{" + nl + body + end + "}";
  };
  return enc(value, 0);
}

// ══════════════════════════════════════════════════════════════════
//  文件归类
// ══════════════════════════════════════════════════════════════════

/** 按文件名归类：`[kind, 中文标题, 溯源提示]`。
 *
 * 溯源提示：grounded 全有据、inferred 全推断、mixed 有据+推断混、
 * n/a 不适用（元数据/原始上传）。文件名是产物流水线里固定命名的，靠它就够，
 * 不用读内容。 */
export function classify(name: string): [string, string, string] {
  const n = name;
  if (n === "oir.json") {
    return ["oir_json", "Ontology 中间表示（对象/属性/关系/动作/规则/问题）", "mixed"];
  }
  if (n === "flow.json") return ["flow_json", "业务流程图数据（Action+Event+Workflow）", "mixed"];
  if (n === "流程图_主干.svg") return ["flow_svg_main", "主干业务流程图（仅有依据的环节）", "grounded"];
  if (n === "流程图.svg") return ["flow_svg_full", "完整业务流程图（含推断环节）", "mixed"];
  if (n === "流程图.mmd") return ["flow_mermaid", "业务流程图 Mermaid 源码", "mixed"];
  if (n === "template.spec.json") return ["template_spec", "填写模板结构定义（含回读锚点）", "mixed"];
  if (n.startsWith("回传") && n.endsWith(".xlsx")) return ["audit_return", "回传审核表", "n/a"];
  if (n.endsWith(".xlsx")) return ["template_xlsx", "业务方填写模板", "mixed"];
  return ["other", name, "n/a"];
}

// ══════════════════════════════════════════════════════════════════
//  溯源汇总
// ══════════════════════════════════════════════════════════════════

/** 一条断言里每条证据的 extractor（docling/llm/ocr/human…）。 */
function extractors(assertion: unknown): string[] {
  if (!isPlainDict(assertion)) return [];
  const ev = dget(assertion, "evidence");
  const list = pyTruthy(ev) ? ev : [];
  if (!Array.isArray(list)) throw new TypeError("evidence 不是数组");
  const out: string[] = [];
  for (const e of list) {
    if (!isPlainDict(e)) continue; // Python: `if isinstance(e, dict)`
    const x = dget(e, "extractor");
    out.push(String(pyTruthy(x) ? x : "llm"));
  }
  return out;
}

function isGrounded(assertion: unknown): boolean {
  if (!isPlainDict(assertion)) return false;
  const ev = dget(assertion, "evidence");
  return pyTruthy(pyTruthy(ev) ? ev : []);
}

/** 从 flow.json 汇总有据 vs 推断。空图返回一份全 0 的结构，别让下游判 None。 */
export function flowProvenance(flow: Record<string, unknown> | null): Record<string, unknown> {
  const f: Record<string, unknown> = pyTruthy(flow) ? (flow as Record<string, unknown>) : {};
  const nodesRaw = dget(f, "nodes");
  const nodes = (pyTruthy(nodesRaw) ? nodesRaw : []) as unknown[];
  const edgesRaw = dget(f, "edges");
  const edges = (pyTruthy(edgesRaw) ? edgesRaw : []) as unknown[];
  const statsRaw = dget(f, "stats");
  const stats = (pyTruthy(statsRaw) ? statsRaw : {}) as Record<string, unknown>;

  let groundedNodes = 0;
  for (const n of nodes) if (pyTruthy(dget(n, "grounded"))) groundedNodes++;

  let human = 0;
  for (const n of nodes) {
    const label = dget(n, "label");
    const ev = dget(pyTruthy(label) ? label : {}, "evidence");
    for (const e of (pyTruthy(ev) ? ev : []) as unknown[]) {
      if (dget(e, "extractor") === "human") {
        human++;
        break;
      }
    }
  }
  for (const e of edges) {
    const ev = dget(e, "evidence");
    for (const p of (pyTruthy(ev) ? ev : []) as unknown[]) {
      if (dget(p, "extractor") === "human") {
        human++;
        break;
      }
    }
  }

  let groundedEdges = 0;
  let ungroundedEdges = 0;
  for (const e of edges) {
    if (pyTruthy(dget(e, "grounded"))) groundedEdges++;
    else ungroundedEdges++;
  }
  const inferredEdges = dget(stats, "inferred_edges");
  const deadEnds = dget(stats, "dead_ends");
  const dangling = dget(stats, "dangling");
  return {
    nodes: nodes.length,
    grounded_nodes: groundedNodes,
    inferred_nodes: nodes.length - groundedNodes,
    edges: edges.length,
    grounded_edges: groundedEdges,
    inferred_edges: pyInt(pyTruthy(inferredEdges) ? inferredEdges : ungroundedEdges),
    dead_ends: pyInt(pyTruthy(deadEnds) ? deadEnds : 0),
    dangling: pyInt(pyTruthy(dangling) ? dangling : 0),
    human_edited: human,
  };
}

/** 实体的主名断言：displayName 优先，退回 apiName/statement/text。 */
function primaryAssertion(entity: unknown): unknown {
  if (!isPlainDict(entity)) {
    throw new TypeError(`TypeError: ${JSON.stringify(entity)} 不支持 in —— 期望一个对象`);
  }
  for (const k of ["displayName", "apiName", "statement", "text"]) {
    if (k in entity) return entity[k];
  }
  return null;
}

/** 从 oir.json 汇总每类容器的数量 + 有据/推断 + 按 extractor 统计。
 *
 * 实体「有据」的判定：它的主名断言有 evidence。这是 UI 上区别渲染用的同一条标准。 */
export function oirProvenance(oir: Record<string, unknown> | null): Record<string, unknown> {
  const o: Record<string, unknown> = pyTruthy(oir) ? (oir as Record<string, unknown>) : {};
  const bucket = (k: string): unknown[] => {
    const v = dget(o, k);
    const list = pyTruthy(v) ? v : [];
    if (!Array.isArray(list)) throw new TypeError(`${k} 不是数组`);
    return list;
  };
  const objects = bucket("objects");
  const statsRaw = dget(o, "stats");
  const stats = (pyTruthy(statsRaw) ? statsRaw : {}) as Record<string, unknown>;

  // extractor 名一律是标识符（docling / llm / ocr / human / openapi / sqlglot），
  // 不可能是整数样式的键，所以普通对象的插入序在这里是安全的。
  const byExt: Record<string, number> = {};
  for (const name of ["objects", "properties", "links", "actions", "rules", "questions"]) {
    for (const e of bucket(name)) {
      for (const ext of extractors(primaryAssertion(e))) {
        byExt[ext] = (byExt[ext] ?? 0) + 1;
      }
    }
  }

  let groundedObjects = 0;
  for (const x of objects) if (isGrounded(primaryAssertion(x))) groundedObjects++;
  const openQ = dget(stats, "open_questions");
  const confirmed = dget(stats, "confirmed");
  return {
    objects: objects.length,
    properties: bucket("properties").length,
    links: bucket("links").length,
    actions: bucket("actions").length,
    rules: bucket("rules").length,
    questions: bucket("questions").length,
    open_questions: pyInt(pyTruthy(openQ) ? openQ : 0),
    confirmed: pyInt(pyTruthy(confirmed) ? confirmed : 0),
    grounded_objects: groundedObjects,
    inferred_objects: objects.length - groundedObjects,
    by_extractor: byExt,
  };
}

// ══════════════════════════════════════════════════════════════════
//  版本戳 + 清单
// ══════════════════════════════════════════════════════════════════

/** 内容寻址的版本戳：文件摘要、产品版本和发布状态共同取 sha256[:12]。
 *
 * 只有产物字节变了它才变 —— 同样的产物打两次包，bundleId 相同（可复现）；
 * DRAFT→RELEASED 也会变；时间戳（generated_at）单独存，不进这个哈希。 */
export function bundleId(
  files: Record<string, unknown>[],
  productVersion: string,
  releaseState = "",
): string {
  const sorted = [...files].sort((a, b) => cmpCodePoint(String(a["path"]), String(b["path"])));
  const payload = sorted
    .map((f) => {
      if (f["path"] === undefined) throw new Error("KeyError: 'path'");
      const sha = f["sha256"];
      return `${String(f["path"])}:${sha === undefined ? "" : String(sha)}`;
    })
    .join("\n");
  // 同一批字节从 DRAFT 通过门禁成为 RELEASED，是一次真实的发布语义变化；
  // 两个离线包不能共享同一个版本戳。空值保留旧纯函数调用的兼容行为。
  const stateLine = releaseState ? `\nrelease_state:${releaseState}` : "";
  return sha256Hex(`${productVersion}\n${payload}${stateLine}`).slice(0, 12);
}

export interface ManifestInput {
  session: Record<string, unknown>;
  productVersion: string;
  files: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  flow: Record<string, unknown> | null;
  oir: Record<string, unknown> | null;
  openQuestions: Record<string, unknown>[];
  generatedAt: number;
  generatedAtIso?: string;
}

/** 组装 manifest.json。有据 vs 推断在三个层级都露出来：每文件 provenance、
 * provenance_summary 汇总、以及 notes 里的提醒。 */
export function buildManifest(p: ManifestInput): Record<string, unknown> {
  const rs = dget(p.session, "release_state");
  let releaseState = String(pyTruthy(rs) ? rs : "DRAFT").toUpperCase();
  if (releaseState !== "DRAFT" && releaseState !== "RELEASED") releaseState = "DRAFT";
  return {
    schema: BUNDLE_SCHEMA,
    product_version: p.productVersion,
    bundle_id: bundleId(p.files, p.productVersion, releaseState),
    // 离开 OntoCopilot UI 后仍必须能判断这是不是正式发布版本。BLOCKED 不会
    // 生成 Bundle；存在非阻塞待答项时允许生成、但必须显式标成 DRAFT。
    release_state: releaseState,
    generated_at: round3(p.generatedAt),
    generated_at_iso: p.generatedAtIso ?? "",
    session: p.session,
    materials: p.materials,
    files: p.files,
    provenance_summary: {
      flow: flowProvenance(p.flow),
      oir: oirProvenance(p.oir),
    },
    open_questions: p.openQuestions,
    notes:
      "灰色/虚线元素为系统推断（材料中无直接依据），交付前请与业务方确认。" +
      "人工口述/人工编辑的内容标记为 human 来源，同样不是材料证据。",
  };
}

/** Python 的 `f"{x}"`：None 印成 `None`，其它走 str()。 */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return pyNumRepr(v);
  return String(v);
}

/** 一份人可读的中文交付说明，进包顶层。让接包的人不打开 manifest 也能看懂。 */
export function readmeText(manifest: Record<string, unknown>): string {
  const m = manifest;
  const sessRaw = dget(m, "session");
  const sess = (pyTruthy(sessRaw) ? sessRaw : {}) as Record<string, unknown>;
  const ps = m["provenance_summary"];
  if (!isPlainDict(ps)) throw new Error("KeyError: 'provenance_summary'");
  const fp = ps["flow"] as Record<string, unknown>;
  const op = ps["oir"] as Record<string, unknown>;
  const rsRaw = dget(m, "release_state");
  const releaseState = String(pyTruthy(rsRaw) ? rsRaw : "DRAFT").toUpperCase();

  const title = (() => {
    const proj = dget(sess, "project");
    if (pyTruthy(proj)) return fmt(proj);
    const t = dget(sess, "title");
    if (pyTruthy(t)) return fmt(t);
    return fmt(sess["id"] === undefined ? "" : sess["id"]);
  })();
  const genAt = dget(m, "generated_at_iso");
  const lines: string[] = [
    `# 交付包 · ${title}`,
    "",
    `- 产品版本：${fmt(m["product_version"])}`,
    `- 包版本戳（bundle_id）：${fmt(m["bundle_id"])}`,
    `- 发布状态：${releaseState}`,
    `- 生成时间：${fmt(pyTruthy(genAt) ? genAt : dget(m, "generated_at"))}`,
    `- 会话：${fmt(sess["id"] === undefined ? "" : sess["id"])}（${fmt(
      sess["status"] === undefined ? "" : sess["status"],
    )}）`,
    "",
  ];
  if (releaseState !== "RELEASED") {
    lines.push("> **草稿提示：此包仍有非阻塞问题待澄清，不得视为正式发布版本。**", "");
  }
  lines.push("## 产物清单");
  const filesRaw = dget(m, "files");
  for (const f of (pyTruthy(filesRaw) ? filesRaw : []) as unknown[]) {
    const provRaw = dget(f, "provenance");
    const prov = provRaw === null ? "n/a" : String(provRaw);
    const tagMap: Record<string, string> = {
      grounded: "有据",
      inferred: "推断",
      mixed: "有据+推断",
      "n/a": "—",
    };
    const tag = tagMap[prov] ?? "—";
    const fd = f as Record<string, unknown>;
    if (fd["path"] === undefined) throw new Error("KeyError: 'path'");
    const t = dget(fd, "title");
    const size = dget(fd, "size");
    lines.push(
      `- \`${fmt(fd["path"])}\` · ${fmt(t === null ? "" : t)}（${tag}，${fmt(
        size === null ? 0 : size,
      )} 字节）`,
    );
  }
  const materials = dget(m, "materials");
  if (pyTruthy(materials)) {
    lines.push("", "## 原始材料（输入）");
    for (const x of materials as unknown[]) {
      const xd = x as Record<string, unknown>;
      if (xd["name"] === undefined) throw new Error("KeyError: 'name'");
      const size = dget(xd, "size");
      lines.push(`- \`materials/${fmt(xd["name"])}\`（${fmt(size === null ? 0 : size)} 字节）`);
    }
  }
  const k = (d: Record<string, unknown>, key: string): string => {
    if (d[key] === undefined) throw new Error(`KeyError: '${key}'`);
    return fmt(d[key]);
  };
  lines.push(
    "",
    "## 溯源概览",
    `- 流程图：${k(fp, "nodes")} 节点（${k(fp, "grounded_nodes")} 有据 / ` +
      `${k(fp, "inferred_nodes")} 推断），${k(fp, "edges")} 条边（${k(fp, "inferred_edges")} 推断），` +
      `人工修改 ${k(fp, "human_edited")} 处，死路 ${k(fp, "dead_ends")}。`,
    `- 本体：${k(op, "objects")} 对象（${k(op, "grounded_objects")} 有据 / ` +
      `${k(op, "inferred_objects")} 推断）、${k(op, "properties")} 属性、${k(op, "links")} 关系、` +
      `${k(op, "rules")} 规则，待澄清 ${k(op, "open_questions")} 条。`,
  );
  const oq = dget(m, "open_questions");
  if (pyTruthy(oq)) {
    lines.push("", "## 待澄清（交付前建议先问业务方）");
    for (const q of (oq as unknown[]).slice(0, 20)) {
      const qq = dget(q, "q");
      if (pyTruthy(qq)) lines.push(`- ${fmt(qq)}`);
      else {
        const t = dget(q, "text");
        lines.push(`- ${fmt(t === null ? "" : t)}`);
      }
    }
  }
  const notes = dget(m, "notes");
  lines.push("", "---", fmt(notes === null ? "" : notes));
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════
//  打包
// ══════════════════════════════════════════════════════════════════

/** zip 成员的 MS-DOS 时间戳：`(年, 月, 日, 时, 分, 秒)`。 */
export type ZipDateTime = readonly [number, number, number, number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `time.localtime(time.time())[:6]`。 */
function localNow(now = new Date()): ZipDateTime {
  return [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ];
}

interface Member {
  nameBytes: Uint8Array;
  flagBits: number;
  crc: number;
  compressed: Uint8Array;
  size: number;
  offset: number;
}

export interface BuildZipOptions {
  /** 冻结成员 mtime。**Python 侧没有这个开关**（它写当前本地时间），加它是为了
   * 能与 golden 做整包字节比对，以及给「同样的输入必须产出同样的字节」这条
   * 产品要求留一条明路。不传 = 与 Python 完全一致的行为。 */
  dateTime?: ZipDateTime;
}

/** 把 `(arcname, bytes)` 列表 + manifest.json + 交付说明.md 打成内存 zip，返回字节。
 *
 * 内存打包：会话产物体量小，不落临时文件，也贴合离线/零依赖的取向。
 *
 * 字节形态逐字对齐 CPython 的 `zipfile`：`extract_version=20`、`create_system=3`
 * （posix）、`external_attr=0o600<<16`、非 ASCII 文件名才打 0x800 标志、
 * deflate 用 zlib 默认档（level=-1 / memLevel=8 / strategy=0，raw）。
 * 差一个字节都会让「同一份产物的两次导出」diff 全红。 */
export function buildZip(
  entries: readonly (readonly [string, Uint8Array | string])[],
  manifest: Record<string, unknown>,
  readme: string,
  opts: BuildZipOptions = {},
): Uint8Array {
  const dt = opts.dateTime ?? localNow();
  const all: (readonly [string, Uint8Array | string])[] = [
    ...entries,
    ["manifest.json", pyJsonDumps(manifest, 2)],
    ["交付说明.md", readme],
  ];
  const enc = new TextEncoder();
  const dosDate = ((dt[0] - 1980) << 9) | (dt[1] << 5) | dt[2];
  const dosTime = (dt[3] << 11) | (dt[4] << 5) | Math.floor(dt[5] / 2);

  const chunks: Uint8Array[] = [];
  const members: Member[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    offset += b.length;
  };

  for (const [arcname, raw] of all) {
    const data = typeof raw === "string" ? enc.encode(raw) : raw;
    // `_encodeFilenameFlags`：能编成 ASCII 就不打 UTF-8 标志。
    const ascii = /^[\x00-\x7f]*$/.test(arcname);
    const nameBytes = enc.encode(arcname);
    const flagBits = ascii ? 0 : 0x800;
    const compressed = new Uint8Array(deflateRawSync(data));
    const crc = crc32(data);
    const here = offset;

    const header = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);
    header[4] = 20; // extract_version
    header[5] = 0; // reserved
    hv.setUint16(6, flagBits, true);
    hv.setUint16(8, 8, true); // ZIP_DEFLATED
    hv.setUint16(10, dosTime, true);
    hv.setUint16(12, dosDate, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, compressed.length, true);
    hv.setUint32(22, data.length, true);
    hv.setUint16(26, nameBytes.length, true);
    hv.setUint16(28, 0, true); // extra
    header.set(nameBytes, 30);
    push(header);
    push(compressed);
    members.push({ nameBytes, flagBits, crc, compressed, size: data.length, offset: here });
  }

  const centStart = offset;
  for (const m of members) {
    const rec = new Uint8Array(46 + m.nameBytes.length);
    const cv = new DataView(rec.buffer);
    cv.setUint32(0, 0x02014b50, true);
    rec[4] = 20; // create_version
    rec[5] = 3; // create_system：posix。Windows 上 CPython 写 0 —— 迁移目标是 macOS/Linux。
    rec[6] = 20; // extract_version
    rec[7] = 0; // reserved
    cv.setUint16(8, m.flagBits, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, m.crc, true);
    cv.setUint32(20, m.compressed.length, true);
    cv.setUint32(24, m.size, true);
    cv.setUint16(28, m.nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal_attr
    cv.setUint32(38, 0o600 << 16, true); // external_attr
    cv.setUint32(42, m.offset, true);
    rec.set(m.nameBytes, 46);
    push(rec);
  }
  const centSize = offset - centStart;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, centSize, true);
  ev.setUint32(16, centStart, true);
  ev.setUint16(20, 0, true);
  push(end);

  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
