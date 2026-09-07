/**
 * OpenAPI / JSON Schema 解析。移植自 `onto/parse/api.py`。
 *
 * 对本体建模有两个用途：
 *
 * * **schemas → 对象与属性候选**。`components.schemas` 是别人已经做过一遍的
 *   建模，白拿。
 * * **写操作端点 → ActionType 草稿**。这是产品的杀手锏：没人填 ActionType 时，
 *   从 `POST/PUT/PATCH/DELETE` 反推草稿让业务确认，比让他们从零写完成率高得多。
 *
 * GET 端点不进 ActionType —— 读操作不改变世界状态，不是 Action。
 *
 * ── 两个 Python↔JS 的语义坑（golden 钉着）─────────────────────────
 *
 * 1. `json.dumps` 的默认分隔符是 `", "` / `": "`，不是 `JSON.stringify` 的紧凑
 *    形式；ensure_ascii=False 时中文原样输出。切片 render 里嵌的就是这个串，
 *    用 JSON.stringify 会让每一条 render 都差几个空格。
 * 2. Python 区分 int 与 float，`1.0` 序列化成 `"1.0"`；JS 里 1 和 1.0 是同一个
 *    值，只能给 `"1"`。这条是语言边界（`ids.ts` 文件头已经钉过），不是 bug ——
 *    测试里按"已知差异"钉住形状，不绕过。
 */

import { basename } from "node:path";

import { parse as parseYaml } from "yaml";

import { pyStripChars } from "../../kernel/config.js";
import { pyRepr } from "../../kernel/errors.js";
import type { ParsedDoc } from "./base.js";
import { Parser, cpSlice, makeChunk, makeFinding, makeParsedDoc, readTextReplace } from "./base.js";

export const WRITE_METHODS = ["post", "put", "patch", "delete"] as const;

/** JSON Schema 类型 → OIR BaseType。键是 `type\0format`，`\0` 分隔是为了让
 *  `("string", null)` 与 `("string", "")` 不撞 —— Python 的元组键天然不撞。 */
const TYPE_MAP = new Map<string, string>([
  ["string\u0000", "STRING"],
  ["string\u0000date", "DATE"],
  ["string\u0000date-time", "TIMESTAMP"],
  ["string\u0000uuid", "STRING"],
  ["integer\u0000", "INTEGER"],
  ["number\u0000", "DECIMAL"],
  ["boolean\u0000", "BOOLEAN"],
]);

/** 只有 str / None 能当键的一半。别的类型在 Python 侧要么不可哈希（list 直接
 *  抛 TypeError）要么不可能命中，这里一律当"没命中"。 */
function typeKey(type: unknown, format: unknown): string | null {
  const t = typeof type === "string" ? type : type === null || type === undefined ? "" : null;
  const f = typeof format === "string" ? format : format === null || format === undefined ? "" : null;
  return t === null || f === null ? null : `${t}\u0000${f}`;
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `d.get(k)` —— 没有该键给 undefined，且**不穿原型链**（`{}` 上是有
 *  `constructor` 的，用 `in` 会把它当成 spec 里真有这个键）。 */
function get(d: Record<string, unknown>, k: string): unknown {
  return Object.hasOwn(d, k) ? d[k] : undefined;
}

/** `x or {}` 之后再 `.items()` —— Python 对非 dict 会抛 AttributeError，这里退化成空。 */
function asDict(v: unknown): Record<string, unknown> {
  return isDict(v) ? v : {};
}

// ══════════════════════════════════════════════════════════════════
//  Python 的 str() / json.dumps()
// ══════════════════════════════════════════════════════════════════

/** Python `str(x)`（用在 f-string 插值和 enum 取值域里）。 */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return pyNum(v);
  if (Array.isArray(v)) return `[${v.map(pyReprValue).join(", ")}]`;
  if (isDict(v)) {
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyReprValue(x)}`).join(", ")}}`;
  }
  return String(v);
}

/** 容器内部走 repr：字符串带单引号，其余与 str 相同。 */
function pyReprValue(v: unknown): string {
  return typeof v === "string" ? pyRepr(v) : pyStr(v);
}

/**
 * Python `repr(number)`。
 *
 * **已知分叉**：Python 的 `1.0` 这里只能给 `"1"` —— JS 没有 int/float 之分。
 * `-0.0`（Python `"-0.0"`）与 `1e-07`（JS `"1e-7"`）同理。
 */
function pyNum(n: number): string {
  return String(n);
}

/** Python `json.dumps(v, ensure_ascii=False)` —— 分隔符 `", "` / `": "`，键按插入序。 */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNum(v);
  // 字符串的转义规则两边一致（控制字符走 \uXXXX / \n\t\r\b\f，非 ASCII 原样）
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  if (isDict(v)) {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonDumps(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ══════════════════════════════════════════════════════════════════
//  解析器
// ══════════════════════════════════════════════════════════════════

/** YAML 加载 seam：测试/嵌入方仍可替换，生产默认由 defaultRegistry 注入。 */
export type YamlLoader = (text: string) => unknown;

/**
 * 生产 YAML loader。`yaml` 的 core schema 不执行用户标签；别名展开也有硬上限，
 * 避免一份 alias bomb 在转成 JS 对象时无限放大。
 */
export const defaultYamlLoader: YamlLoader = (text) => parseYaml(text, { maxAliasCount: 100 });

export class OpenApiParser extends Parser {
  override readonly kind = "openapi";
  override readonly extensions = [".json", ".yaml", ".yml"];

  private readonly yamlLoad: YamlLoader | null;

  constructor(yamlLoad: YamlLoader | null = null) {
    super();
    this.yamlLoad = yamlLoad;
  }

  override async parse(path: string, opts: { fileId: string }): Promise<ParsedDoc> {
    const fileId = opts.fileId;
    const fileName = basename(path);
    const doc = makeParsedDoc({ fileId, fileName, kind: this.kind });
    const text = await readTextReplace(path);

    let spec: unknown;
    try {
      spec = JSON.parse(text);
    } catch (e) {
      // 消息里嵌的是解析器自己的报错文本，Python 那边是 JSONDecodeError 的
      // "Expecting value: line 1 column 1 (char 0)"，JS 给的是 V8 的措辞。
      // 这一句无法逐字对齐（要对齐得手写一个 CPython 兼容的 JSON 解析器），
      // 是**已记录的分叉**：kind / severity / 前半句都一致，只有异常文本不同。
      const jsonMessage = e instanceof Error ? e.message : String(e);
      if (this.yamlLoad === null) {
        doc.findings.push(makeFinding(
          "parse_failed",
          `既不是合法 JSON 也读不成 YAML：${jsonMessage}`,
          {},
          "warn",
        ));
        return doc;
      }
      try {
        spec = this.yamlLoad(text);
      } catch (yamlError) {
        // 默认注册表已经带 YAML 解析器。此时真正有用的是 YAML 的行列号与语法
        // 错误，而不是前一步 JSON.parse 那句几乎恒定的 "Unexpected token"。
        const yamlMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
        doc.findings.push(makeFinding(
          "parse_failed",
          `既不是合法 JSON 也读不成 YAML：${yamlMessage}`,
          {},
          "warn",
        ));
        return doc;
      }
    }

    // 顶层是**数组**的 JSON 走普通 JSON 那条路，不再当成解析失败。
    //
    // 用户现场（2026-09-07）：objects.json / actions.json / events.json 这一批文件
    // 顶层都是 `[{...}, {...}]`（一组记录），在库里全是 chunk_count=0、
    // parse_status=degraded，界面上写着「这一版还没有读出可核验的正文」——
    // 六份材料，一份都读不出来。
    //
    // 而 plainJson 本来就会处理数组（`Array.isArray(obj) ? obj.map(...)`，见下面），
    // 挡住它的只是这里这道 isDict 守卫：它是给下面 OpenAPI 分支用的
    // （那条路要 spec.paths / spec.components），却拦在了 plainJson 前面。
    //
    // 「一组记录」是 JSON 最常见的形状之一，不是边角情况。
    //
    // 这改动会动一条 Python 时代的 golden（onto.parse.json 里 toplevel_list.json
    // = `[1, 2]` 钉着 parse_failed）。Python 侧已整树删除，golden 现在是回归钉
    // 而不是跨实现契约，所以这是一次**有意的行为变更**，golden 一并更新。
    if (!isDict(spec)) {
      if (Array.isArray(spec)) {
        doc.kind = "json";
        return plainJson(doc, spec, fileId, fileName);
      }
      // 顶层是标量（一个裸数字/字符串/null）—— 那确实没有可切片的结构。
      doc.findings.push(makeFinding("parse_failed", "顶层不是对象也不是数组", {}, "warn"));
      return doc;
    }
    if (!Object.hasOwn(spec, "paths") && !Object.hasOwn(spec, "components")) {
      doc.kind = "json";
      return plainJson(doc, spec, fileId, fileName);
    }

    const endpoints = collectEndpoints(spec, fileId, fileName);
    const schemas = collectSchemas(spec);
    doc.structured = {
      endpoints,
      schemas,
      title: get(asDict(get(spec, "info")), "title") ?? "",
    };

    let order = 0;
    for (const e of endpoints) {
      const tag = e["write"] === true ? "写操作，可反推 ActionType" : "读操作";
      const summary = e["summary"];
      doc.chunks.push(
        makeChunk({
          docId: `ep${order}`,
          fileId,
          fileName,
          locator: { kind: "json", pointer: e["pointer"] },
          // 两个空格 + U+3000（全角空格）都是原件的字面量，别"顺手规整"
          render:
            `${pyStr(e["method"]).toUpperCase()} ${pyStr(e["path"])}`
            + `  operationId=${pyStr(e["operationId"])}`
            + `　〔${tag}〕`
            + (summary ? ` ${pyStr(summary)}` : ""),
          raw: e,
          order,
          tags: ["endpoint", e["write"] === true ? "write" : "read"],
        }),
      );
      order += 1;
      // 端点→请求体 schema 是一条关系，像 DDL 外键那样单独成一等切片
      if (e["request_schema"]) {
        doc.chunks.push(
          makeChunk({
            // docId 用的是**自增之后**的 order（原件如此），所以 ep0 的伴随切片
            // 叫 eplink1 而不是 eplink0
            docId: `eplink${order}`,
            fileId,
            fileName,
            locator: { kind: "json", pointer: e["pointer"] },
            render:
              `${pyStr(e["operationId"])} → ${pyStr(e["request_schema"])}`
              + "（请求体，引用该 schema）",
            raw: { from: e["operationId"], to: e["request_schema"] },
            order,
            tags: ["link", "relation"],
          }),
        );
        order += 1;
      }
    }

    for (const [name, s] of Object.entries(schemas)) {
      const props = Object.entries(s["properties"] as Record<string, Record<string, unknown>>)
        .map(([p, d]) => propStr(p, d))
        .join("、");
      const description = s["description"];
      doc.chunks.push(
        makeChunk({
          docId: `schema:${name}`,
          fileId,
          fileName,
          locator: { kind: "json", pointer: `$.components.schemas.${name}` },
          render:
            `schema ${name}：${props}` + (description ? `　${pyStr(description)}` : ""),
          raw: s,
          order,
          tags: ["schema"],
        }),
      );
      order += 1;
    }

    if (!endpoints.some((e) => e["write"] === true)) {
      doc.findings.push(
        makeFinding("no_write_endpoints", "spec 里没有写操作端点，无法反推 ActionType 草稿", {}),
      );
    }
    return doc;
  }
}

/**
 * property → 一段可检索文本：类型 + 必填 + 取值域 + 口径说明。
 *
 * description 常常就是口径（"含税、年度累计"），enum 是取值域 —— 只放进 raw 而不
 * 进 render，检索时就看不见。
 */
function propStr(p: string, d: Record<string, unknown>): string {
  let s = `${p}:${pyStr(d["base_type"])}` + (d["required"] === true ? "*" : "");
  const en = d["enum"];
  if (en) s += "[" + (Array.isArray(en) ? en.map(pyStr).join("|") : pyStr(en)) + "]";
  if (d["description"]) s += `（${pyStr(d["description"])}）`;
  return s;
}

function collectEndpoints(
  spec: Record<string, unknown>,
  fileId: string,
  fileName: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [path, ops] of Object.entries(asDict(get(spec, "paths")))) {
    if (!isDict(ops)) continue;
    for (const [method, op] of Object.entries(ops)) {
      const m = method.toLowerCase();
      if ((m !== "get" && !(WRITE_METHODS as readonly string[]).includes(m)) || !isDict(op)) {
        continue;
      }
      const oid = get(op, "operationId");
      const sum = get(op, "summary") || get(op, "description") || "";
      out.push({
        operationId: oid || synthId(m, path),
        method: m,
        path,
        write: (WRITE_METHODS as readonly string[]).includes(m),
        summary: cpSlice(typeof sum === "string" ? sum : pyStr(sum), 0, 120),
        tags: Object.hasOwn(op, "tags") ? op["tags"] : [],
        request_schema: refName(get(op, "requestBody")),
        file_id: fileId,
        file_name: fileName,
        pointer: `$.paths.${path}.${m}`,
      });
    }
  }
  return out;
}

function collectSchemas(spec: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = asDict(
    get(asDict(get(spec, "components")), "schemas") || get(spec, "definitions") || {},
  );
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, s] of Object.entries(raw)) {
    if (!isDict(s)) continue;
    const t = get(s, "type");
    if (t !== undefined && t !== null && t !== "object") continue;
    const requiredRaw = get(s, "required");
    const required = new Set(Array.isArray(requiredRaw) ? requiredRaw : []);
    const props: Record<string, unknown> = {};
    for (const [pname, p] of Object.entries(asDict(get(s, "properties")))) {
      if (!isDict(p)) continue;
      const k1 = typeKey(get(p, "type"), get(p, "format"));
      const k2 = typeKey(get(p, "type"), null);
      props[pname] = {
        base_type:
          (k1 === null ? undefined : TYPE_MAP.get(k1))
          ?? (k2 === null ? undefined : TYPE_MAP.get(k2))
          ?? "STRING",
        required: required.has(pname),
        // OpenAPI 的 description 常常就是口径说明，必须带出来
        description: get(p, "description") ?? "",
        enum: get(p, "enum") ?? null,
        format: get(p, "format") ?? null,
      };
    }
    out[name] = { name, description: get(s, "description") ?? "", properties: props };
  }
  return out;
}

function refName(body: unknown): string | null {
  if (!isDict(body)) return null;
  for (const media of Object.values(asDict(get(body, "content")))) {
    const ref = get(asDict(get(asDict(media), "schema")), "$ref");
    if (typeof ref === "string") return ref.slice(ref.lastIndexOf("/") + 1);
  }
  return null;
}

function synthId(method: string, path: string): string {
  const parts = pyStripChars(path, "/")
    .split("/")
    .filter((p) => p !== "" && !p.startsWith("{"));
  const tail = parts.map((p) => cpSlice(p, 0, 1).toUpperCase() + cpSlice(p, 1)).join("");
  // 原件是 `f"{method}{tail}" or method`；method 非空时前半永远为真，
  // 那个 `or` 永远走不到。照抄不改 —— 它不碍事，改了反而与原件对不上。
  return `${method}${tail}` || method;
}

/** 不是 OpenAPI 的普通 JSON：按顶层键切片，保留 JSON Pointer。 */
/**
 * 一条记录的人类可读标签。
 *
 * 只认这几个字段名，且只认**非空字符串**：猜错一个标签比用下标更糟 ——
 * 下标至少诚实地表示「这是第几条」，而一个猜错的标签会让人以为记录叫那个名字。
 */
/**
 * 标签 + 正文拼成切片的那段字。
 *
 * 记录铺成多行时标签**自成一行**（像标题）；其余情况保持 `键: 值` 的老形状 ——
 * 一行里「标签: id: rule-…」读起来像两个冒号打架。
 */
function renderChunkText(label: string, value: unknown, insideArray: boolean): string {
  const body = cpSlice(renderValue(value, insideArray), 0, 600);
  return body.includes("\n") ? `${label}\n${body}` : `${label}: ${body}`;
}

/**
 * 一条切片的正文长什么样。
 *
 * 一组记录（数组里的对象）铺成**逐字段一行**，其余一切照旧 JSON 序列化。
 *
 * 为什么只对这一种：用户点开一份 34 条记录的 objects.json，读到的是
 *
 *     需求计划须经技术与商务双重确认: {"id": "rule-tech-…", "name": "需求计划须经…",
 *     "category": "职责确认", "belongsToClient": "中厂核", "description": "采购需求…
 *
 * —— 标签修好了，后面仍然是一堵 600 字的 JSON 墙，名字还重复一遍。他说的
 * 「无法展现和 render 出来」，解析修好之后剩下的就是这一堵墙。铺成
 *
 *     需求计划须经技术与商务双重确认: category: 职责确认
 *     belongsToClient: 中厂核
 *     description: 采购需求计划必须完成技术与商务确认后再提交审批…
 *
 * 人能读，BM25 也更好切（字段值之间有分隔，不再夹着 JSON 标点）。
 *
 * 已经当成标签用掉的那个字段跳过，不重复一遍。嵌套值仍然 JSON 序列化 ——
 * 把它们也铺平会让「哪一层」丢失，而 raw 里存着完整原貌，需要时能拿到。
 */
function renderValue(value: unknown, insideArray: boolean): string {
  if (!insideArray || !isDict(value)) return pyJsonDumps(value);
  const label = recordLabel(value);
  const lines: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && field === label) continue;
    lines.push(`${key}: ${typeof field === "string" ? field : pyJsonDumps(field)}`);
  }
  return lines.length > 0 ? lines.join("\n") : pyJsonDumps(value);
}

function recordLabel(value: unknown): string | null {
  if (!isDict(value)) return null;
  for (const key of ["name", "title", "名称", "标题", "label", "id"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return null;
}

function plainJson(
  doc: ParsedDoc,
  obj: unknown,
  fileId: string,
  fileName: string,
): ParsedDoc {
  const items: [unknown, unknown][] = Array.isArray(obj)
    ? obj.map((v, i): [unknown, unknown] => [i, v])
    : Object.entries(asDict(obj));
  items.forEach(([k, v], i) => {
    // **标签和指针是两回事，不能混。**
    //
    // 指针（locator.pointer）是「这段在原文的哪个位置」，是证据链的一环 ——
    // 数组里就必须是下标，写成记录名根本不是一条能走回去的路径。
    //
    // 标签是给人看的那几个字：它会出现在阅读器里、进检索命中的 cite、也参与
    // BM25 打分。数组下标在这个位置是纯噪音 —— 一份 34 条对象的 objects.json
    // 读起来是「0: {…}」「1: {…}」，用户说的「无法展现」，解析修好之后剩下的
    // 就是这一半。所以一组记录时标签用记录自己的名字，指针照旧是下标。
    //
    // 找不到名字就退回下标（一组标量、或字段命名不一样的记录），和以前一致。
    const label = Array.isArray(obj) ? recordLabel(v) ?? pyStr(k) : pyStr(k);
    doc.chunks.push(
      makeChunk({
        docId: `k${i}`,
        fileId,
        fileName,
        locator: { kind: "json", pointer: `$.${pyStr(k)}` },
        render: renderChunkText(label, v, Array.isArray(obj)),
        raw: v,
        order: i,
        tags: ["json"],
      }),
    );
  });
  doc.structured = {
    keys: Array.isArray(obj) ? obj.length : Object.keys(asDict(obj)),
  };
  return doc;
}
