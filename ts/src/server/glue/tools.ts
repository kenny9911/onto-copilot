/**
 * `kernel/tools.py` 的 `builtin_registry` —— 内建工具的装配。
 *
 * ── 为什么它住在 `server/glue/` 而不是 `kernel/tools.ts` ────────────────
 *
 * 五个工具里四个只认数据结构，第五个（`code.exec`）要一个**能跑起来的沙箱** ——
 * 而"这台机器上有没有容器运行时"是部署拓扑，不是内核概念。`kernel/tools.ts`
 * 只管注册表与安全闸，选沙箱、探沙箱这两件事落在这一层。
 *
 * ── 没有沙箱时 `code.exec` **不出现**，而不是调用时报错 ────────────────
 *
 * Python 那行是 `if sandbox is not None:` —— 沙箱缺席时这个工具压根不注册。
 * 必须照搬这个形状：注册一个"调了必然失败"的工具，模型会反复重试它（失败回执
 * 在它看来是"参数写错了"），把预算烧光，而且每一轮都真花钱。动作空间里没有
 * 这个工具，模型才会去找别的路。
 *
 * 所以 {@link sandboxForTools} 要在**注册之前**把话问清楚：开关开了吗、
 * 容器运行时在吗。这两件事任一为否，返回 `null`。
 */

import { FlowGraph } from "../../onto/flow.js";
import { flowDependents } from "../../onto/flow_link.js";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import {
  assertManagedToolRegistrations,
  managedToolRegistrar,
  scopesForTool,
} from "../../catalog/tools.js";
import type { EvidenceIndex } from "../../kernel/memory/evidence.js";
import { Danger, ToolRegistry, type ToolCallCtx } from "../../kernel/tools.js";
import {
  actionToDict,
  linkToDict,
  objectToDict,
  propertyToDict,
  ruleToDict,
  type ActionType,
  type BusinessRule,
  type LinkType,
  type ObjectType,
  type PropertyType,
} from "../../onto/oir.js";
import { cpSlice } from "../../onto/parse/base.js";
// 「差在哪几个字」全仓只有这一份实现（由 golden/onto.conflict.json 钉住）。
// **不在这里另写一个相似度切片** —— 换一个「看起来差不多」的算法，报出来的
// 片段就变了，而片段是这条差异可信的全部理由。
import { undescribedDiff } from "../../onto/conflict.js";
import {
  asSandboxLike,
  bestContainerSandbox,
  type ExecResultDict,
} from "../../kernel/sandbox.js";
import { pyReprList, pyUnquote } from "../pipeline/tables.js";

// ══════════════════════════════════════════════════════════════════
//  端口
// ══════════════════════════════════════════════════════════════════

/**
 * `evidence.search` / `evidence.rows` 要的那一小块 `EvidenceIndex`。
 *
 * 不直接收 `EvidenceIndex`：对话那条路传进来的是 `_LazyIndex`（server.py:4663），
 * 一个**按调用时**解析 `s.state["_index"]` 的壳。早绑索引的症状很具体 ——
 * AI 在这一轮里刚用 `material.parse` 把材料读进索引，却发现这一轮没有检索工具
 * 可用，只能等下一轮，白跑一趟。
 */
export interface EvidenceLike {
  search(query: string, opts: Record<string, unknown>): readonly ChunkLike[];
  fileNames(): Map<string, string>;
  byLocator(opts: Record<string, unknown>): readonly ChunkLike[];
  allChunks(): readonly ChunkLike[];
}

export interface ChunkLike {
  readonly fileName: string;
  readonly locator: Record<string, unknown> | null;
  readonly render: string;
  cite(): string;
}

/** `oir.query` / `impact.trace` 碰到的 OIR 成员。 */
export interface OirLike {
  readonly objects?: Map<string, unknown>;
  readonly properties?: Map<string, unknown>;
  readonly links?: Map<string, unknown>;
  readonly actions?: Map<string, unknown>;
  readonly rules?: Map<string, unknown>;
  stats(): unknown;
  dependents(rid: string): Iterable<string>;
}

/**
 * `code.exec` 认的沙箱形状：`exec(code, inputs) -> dict`。
 *
 * 收窄成一个方法而不是整个 `SandboxExecutor`：这一层只会调这一件事，而窄接口
 * 让测试可以喂一个字面量对象，不必起一个真沙箱。`asSandboxLike()` 把内核那个
 * 执行器包成这个形状。
 */
export interface SandboxLike {
  exec(code: string, inputs?: Record<string, unknown>): Promise<ExecResultDict>;
}

export interface BuiltinRegistryOptions {
  readonly evidence?: EvidenceLike | EvidenceIndex | null;
  readonly oir?: OirLike | null;
  readonly profiles?: Record<string, unknown> | null;
  readonly sandbox?: SandboxLike | null;
  /** 会话当前的 FlowGraph（可缺）。impact.trace 的流程段用 —— 改对象会波及
   *  哪些**流程环节**，桥是 FlowNode.objects（autoBindObjects 补的）。 */
  readonly flow?: () => unknown;
}

// ══════════════════════════════════════════════════════════════════
//  impact.trace 的小工具（`tools.py:634`）
// ══════════════════════════════════════════════════════════════════

/** OIR 的实体桶 → 单数名。顺序即查找优先级：对象 → 属性 → 关系 → 行动 → 规则。
 *  单数名写死而不是 `bucket[:-1]` —— 后者把 properties 削成 "propertie"。 */
const OIR_BUCKETS: Readonly<Record<string, string>> = {
  objects: "object",
  properties: "property",
  links: "link",
  actions: "action",
  rules: "rule",
};

/** 单数名 → 桶名。**不能靠 `kind + "s"` 拼**：property 的桶叫 properties 不叫 propertys，
 * 拼错的后果是整个桶查不到、每个字段读成 null，然后被判成「两边都空 = 没有差异」——
 * 静默的假阴性，比报错难发现得多。 */
const BUCKET_OF_KIND: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(OIR_BUCKETS).map(([bucket, singular]) => [singular, bucket])),
);

/** `getattr(oir, bucket, None) or {}` —— 取不到就是空表。 */
function bucketOf(oir: OirLike, name: string): Map<string, unknown> {
  const raw = (oir as unknown as Record<string, unknown>)[name];
  return raw instanceof Map ? raw : new Map<string, unknown>();
}

/** `getattr(getattr(item, attr, None), "value", None)` —— 取 `Assertion.value`。 */
function assertionValue(item: unknown, attr: string): unknown {
  if (item === null || typeof item !== "object") return null;
  const holder = (item as Record<string, unknown>)[attr];
  if (holder === null || typeof holder !== "object") return null;
  return (holder as Record<string, unknown>)["value"] ?? null;
}

/** OIR 的 TS 成员是 plain interfaces，不是带 `toDict()` 的 Python 实例。 */
function oirItemToDict(kind: string, item: unknown): Record<string, unknown> {
  switch (kind) {
    case "objects":
      return objectToDict(item as ObjectType);
    case "properties":
      return propertyToDict(item as PropertyType);
    case "links":
      return linkToDict(item as LinkType);
    case "actions":
      return actionToDict(item as ActionType);
    case "rules":
      return ruleToDict(item as BusinessRule);
    default:
      throw new Error(`OIR 没有 ${kind} 这个桶`);
  }
}

export function ridKind(oir: OirLike, rid: string): string {
  for (const [bucket, singular] of Object.entries(OIR_BUCKETS)) {
    if (bucketOf(oir, bucket).has(rid)) return singular;
  }
  return "unknown";
}

/** 人看的名字。取不到就退回 rid —— 空字符串会让影响面清单变成一列空白。 */
export function ridName(oir: OirLike, rid: string): string {
  for (const bucket of Object.keys(OIR_BUCKETS)) {
    const item = bucketOf(oir, bucket).get(rid);
    if (item === undefined) continue;
    for (const attr of ["displayName", "apiName", "statement"]) {
      const val = assertionValue(item, attr);
      if (val !== null && val !== undefined && val !== "") return cpSlice(String(val), 0, 80);
    }
  }
  return rid;
}

/**
 * 把用户/模型给的东西解析成 rid。
 *
 * **接受名字而不只是 rid**：模型手上多半只有材料里的中文名或 apiName，
 * 要求它先查一次 rid 是白白多一轮往返，而且它会开始猜 rid 的构造规则。
 */
export function resolveRid(oir: OirLike, target: string): string | null {
  const t = String(target ?? "").trim();
  if (!t) return null;
  for (const bucket of Object.keys(OIR_BUCKETS)) {
    if (bucketOf(oir, bucket).has(t)) return t;
  }
  const low = t.toLowerCase();
  for (const bucket of Object.keys(OIR_BUCKETS)) {
    for (const [rid, item] of bucketOf(oir, bucket)) {
      for (const attr of ["apiName", "displayName"]) {
        const val = assertionValue(item, attr);
        if (val !== null && val !== undefined && val !== "" && String(val).toLowerCase() === low) {
          return rid;
        }
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  entity.compare 的小工具
// ══════════════════════════════════════════════════════════════════

/** `model.lint` 查哪几类。**导出成常量而不是散在代码里**：工具要如实回答
 * 「查了什么」，而「没报出来」有两种性质完全不同的情况 —— 查过确实没有，
 * 和根本没查。 */
const CHECKED_LINTS: readonly string[] = [
  "orphan_object", "broken_link", "orphan_property", "action_no_host",
  "object_no_primary_key", "object_no_description",
];

/** 每一类实体拿哪些字段并排。**顺序有意义**：口径类字段排在前面，先看见最贵的差异。 */
const COMPARE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  object: ["displayName", "apiName", "description", "primaryKey", "aliases", "owner", "status"],
  property: [
    "definition", "displayName", "apiName", "baseType", "semanticType", "unit",
    "valueDomain", "required", "parent", "owner", "status",
  ],
  link: ["apiName", "source", "target", "cardinality", "joinKey", "status"],
  action: ["apiName", "appliesTo", "effects", "parameters", "status"],
  rule: ["statement", "apiName", "status"],
};

/**
 * 读一个字段的值。字段可能是 `Assertion<T>`（有 `.value`）也可能是裸值
 * （`source` / `owner` / `status` / `aliases` 这些）。两种都要认，否则
 * 裸值字段会全部读成 null 然后被判成「两边都空 = 一样」—— 静默的假阴性。
 */
function fieldValue(item: unknown, attr: string): unknown {
  if (item === null || typeof item !== "object") return null;
  const raw = (item as Record<string, unknown>)[attr];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return (raw as Record<string, unknown>)["value"] ?? null;
  }
  return raw ?? null;
}

/** 字段上挂的出处。裸值字段没有，返回空。 */
function fieldEvidence(item: unknown, attr: string): readonly Record<string, unknown>[] {
  if (item === null || typeof item !== "object") return [];
  const raw = (item as Record<string, unknown>)[attr];
  if (raw === null || typeof raw !== "object") return [];
  const ev = (raw as Record<string, unknown>)["evidence"];
  return Array.isArray(ev) ? (ev as Record<string, unknown>[]) : [];
}

/** 判等按**归一后的 JSON**：数组顺序无关的比较留给调用方，这里只要稳定可复现。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
  }
  return String(a) === String(b);
}

function sortedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort(cmpCodePoint)) {
      out[k] = sortedKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 某个对象下所有属性的 apiName。粒度差异靠属性集合才看得出来。 */
function propApiNames(oir: OirLike, objectRid: string): string[] {
  const out: string[] = [];
  for (const pt of bucketOf(oir, "properties").values()) {
    if (fieldValue(pt, "parent") !== objectRid) continue;
    const api = fieldValue(pt, "apiName");
    if (api !== null && api !== "") out.push(String(api));
  }
  return [...new Set(out)].sort(cmpCodePoint);
}

// ══════════════════════════════════════════════════════════════════
//  参数取值（Python 是 `fn(ctx, **args)` + 签名默认值）
// ══════════════════════════════════════════════════════════════════

function argStr(args: Record<string, unknown>, key: string, dflt = ""): string {
  const v = args[key];
  return v === undefined || v === null ? dflt : String(v);
}

function argInt(args: Record<string, unknown>, key: string, dflt: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  return Math.trunc(Number(v));
}

function argIntOrNull(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  return Math.trunc(Number(v));
}

function argList(args: Record<string, unknown>, key: string): string[] | null {
  const v = args[key];
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x));
}

/** `c.render[:1200]` —— 按码点，中文才不会被切出半个字。 */
function preview(text: string): string {
  return cpSlice(text, 0, 1200);
}

// ══════════════════════════════════════════════════════════════════
//  装配
// ══════════════════════════════════════════════════════════════════

/**
 * 装配内建工具。
 *
 * 只给真正需要的东西：检索证据、查 OIR、看列画像、跑代码。**没有出网工具** ——
 * 这个系统在正常运行中不需要访问互联网。
 */
export function builtinRegistry(opts: BuiltinRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const reg = managedToolRegistrar(registry, "core");
  const flowOf = opts.flow ?? (() => null);
  const evidence = (opts.evidence ?? null) as EvidenceLike | null;
  const oir = opts.oir ?? null;
  const profiles = opts.profiles ?? null;
  const sandbox = opts.sandbox ?? null;

  if (evidence !== null) {
    reg.fn(
      {
        name: "evidence.search",
        description:
          "在已上传的材料里检索证据切片。返回的每一片都带 file!locator 出处，" +
          "引用时必须原样带上，不要改写或简化出处。",
        schema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "检索词，用材料里的原词" },
            top_k: { type: "integer", description: "最多返回几片，默认 12" },
            files: {
              type: "array",
              items: { type: "string" },
              description: "限定文件，写**文件名**即可（如 「实体梳理.xlsx」）；不给则全库",
            },
            kinds: {
              type: "array",
              items: { type: "string" },
              description:
                "限定来源类型，如 ddl/json/range/page/cell；" +
                '不给则不限。想只看物理定义就传 ["ddl"]',
            },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("evidence.search"),
      },
      (args) => {
        const query = argStr(args, "query");
        const topK = argInt(args, "top_k", 12);
        let files = argList(args, "files");
        const kinds = argList(args, "kinds");
        // `files` 按 file_id 过滤，但**没有任何工具向模型给过 file_id** ——
        // 它看到的只有文件名和 cite。于是模型一填 files 就必然过滤掉全部切片、
        // 静默拿到空结果（比报错更糟：它会据此断言"材料里没有"）。这里把文件名
        // 解析成 id；解析不到的原样传下去，仍当 id 用。
        if (files !== null && files.length > 0) {
          const byName = evidence.fileNames();
          const resolved: string[] = [];
          const unknownNames: string[] = [];
          for (const f of files) {
            // 模型很爱把中文文件名**百分号编码**了再传
            // （"%E9%87%87%E8%B4%AD…xlsx"）—— 大概是把它当 URL 片段。
            // material.parse 那边靠子串匹配蒙混过去了，这里按全名查就
            // 全军覆没，回一句"没有这些材料"，而它上一秒刚读进来。
            // 认一下解码后的形态，别让同一个名字在两个工具里一个认一个不认。
            const cand = [f];
            if (f.includes("%")) {
              // `pyUnquote` 而不是 `decodeURIComponent`：后者对残缺的 `%` 序列直接
              // 抛 URIError，Python 的 `unquote` 是原样留下。截断的编码真的会出现。
              const dec = pyUnquote(f);
              if (dec !== f) cand.push(dec);
            }
            let hit: string | null = null;
            for (const x of cand) {
              const v = byName.get(x);
              if (v !== undefined && v !== "") {
                hit = v;
                break;
              }
            }
            if (hit === null) {
              for (const [nm, fid] of byName) {
                if (cand.some((x) => nm.includes(x))) {
                  hit = fid;
                  break;
                }
              }
            }
            if (hit !== null && hit !== "") resolved.push(hit);
            else unknownNames.push(f);
          }
          if (unknownNames.length > 0 && resolved.length === 0) {
            return {
              count: 0,
              chunks: [],
              error:
                `没有这些材料：${pyReprList(unknownNames)}。现有：` +
                `${pyReprList([...byName.keys()].sort(cmpCodePoint))}`,
            };
          }
          files = resolved.length > 0 ? resolved : null;
        }
        const hits = evidence.search(query, { topK, files, kinds, expand: 1 });
        return {
          count: hits.length,
          chunks: hits.map((c) => ({ cite: c.cite(), text: preview(c.render) })),
        };
      },
    );

    reg.fn(
      {
        name: "evidence.rows",
        description:
          "**按位置**取原文，不走关键词检索。要看某张表的第 30~46 行、" +
          "或某个 sheet 的全部内容时用它 —— 行号不是关键词，" +
          "evidence.search 打不出分，只会返回一堆无关切片。",
        schema: {
          type: "object",
          properties: {
            file: { type: "string", description: "文件名，可只写一部分" },
            container: { type: "string", description: "sheet / 章节 / 表名，可只写一部分" },
            from_row: { type: "integer", description: "起始行号（含）" },
            to_row: { type: "integer", description: "结束行号（含）" },
            limit: { type: "integer", description: "最多返回几片，默认 60" },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("evidence.rows"),
      },
      (args) => {
        const file = argStr(args, "file");
        const container = argStr(args, "container");
        const fromRow = argIntOrNull(args, "from_row");
        const toRow = argIntOrNull(args, "to_row");
        const limit = argInt(args, "limit", 60);
        let span: readonly [number, number] | null = null;
        if (fromRow !== null || toRow !== null) {
          const lo = fromRow ?? 0;
          const hi = toRow ?? 10 ** 9;
          span = [Math.min(lo, hi), Math.max(lo, hi)];
        }
        // **一个过滤条件都没给 = 参数名多半写错了。**
        //
        // 网关的 validateArgs 会把未声明的键**静默剥掉**（那是刻意的安全设计：
        // 报错等于告诉调用方边界在哪）。于是模型写错参数名时，这里收到的是一个
        // 空过滤器，byLocator 会老老实实返回"全库前 60 片" —— 模型看到一堆
        // 不相干的内容，以为工具坏了或者材料不对，然后换个说法反复重试。
        // 一次真实事故里这正是把节点墙钟耗光的那几轮。
        const noFilter = !file && !container && span === null;
        const hits = noFilter ? [] : evidence.byLocator({ file, container, rows: span, limit });
        if (hits.length === 0) {
          // 空结果最危险：模型会据此断言"材料里没有"。把实际存在的容器名
          // 报回去，它才知道是位置写错了、还是真的没有。
          const seen: string[] = [];
          const seenSet = new Set<string>();
          for (const c of evidence.allChunks()) {
            const loc = c.locator ?? {};
            const where = String(loc["sheet"] ?? loc["section"] ?? "");
            if (where) {
              const key = `${c.fileName}!${where}`;
              if (!seenSet.has(key)) {
                seenSet.add(key);
                seen.push(key);
              }
            }
          }
          return {
            count: 0,
            chunks: [],
            note: `这个位置没有内容。现有的表/章节：${pyReprList(seen.slice(0, 20))}`,
          };
        }
        return {
          count: hits.length,
          chunks: hits.map((c) => ({ cite: c.cite(), text: preview(c.render) })),
        };
      },
    );
  }

  if (oir !== null) {
    reg.fn(
      {
        name: "oir.query",
        description:
          "分页查询当前 OIR 的对象、属性、关系、行动和规则。支持按业务名、物理名或规则原文搜索；" +
          "返回 total/returned/truncated，不能把第一页误当全集。",
        schema: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: ["objects", "properties", "links", "actions", "rules", "stats"],
            },
            name_contains: {
              type: "string",
              description: "匹配 apiName、displayName 或规则 statement（不区分大小写）",
            },
            q: {
              type: "string",
              description: "name_contains 的简写；匹配业务名、物理名或规则原文",
            },
            offset: { type: "integer", description: "从第几条开始，默认 0" },
            limit: { type: "integer", description: "本页条数，默认 60，最大 200" },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("oir.query"),
      },
      (args) => {
        const kind = argStr(args, "kind");
        // q is easier for model tool use; keep name_contains for callers that
        // already depend on the original contract.
        const nameContains = argStr(args, "q") || argStr(args, "name_contains");
        if (kind === "stats") return oir.stats();
        const offset = Math.max(0, argInt(args, "offset", 0));
        const limit = Math.max(1, Math.min(200, argInt(args, "limit", 60)));
        // Python 是 `getattr(oir, kind)` —— 桶不存在就 AttributeError。这里
        // 同样显式炸：schema 已经把 kind 限死在五个值里，出现别的值是内部错误。
        const bucket = (oir as unknown as Record<string, unknown>)[kind];
        if (!(bucket instanceof Map)) throw new Error(`OIR 没有 ${kind} 这个桶`);
        const items: unknown[] = [];
        for (const e of bucket.values()) {
          if (nameContains) {
            const needle = nameContains.toLowerCase();
            const hay = ["apiName", "displayName", "statement"]
              .map((field) => assertionValue(e, field))
              .filter((value) => value !== null && value !== undefined)
              .map(String)
              .join("\n")
              .toLowerCase();
            if (!hay.includes(needle)) continue;
          }
          items.push(oirItemToDict(kind, e));
        }
        const page = items.slice(offset, offset + limit);
        return {
          count: items.length,
          total: items.length,
          returned: page.length,
          offset,
          limit,
          truncated: offset + page.length < items.length,
          next_offset: offset + page.length < items.length ? offset + page.length : null,
          items: page,
        };
      },
    );

    reg.fn(
      {
        name: "impact.trace",
        description:
          "改这一个东西会牵动哪些别的东西。给一个对象/属性/关系/行动的名字或 rid，" +
          "返回顺着依赖走出去的全部受影响项、各自的路径和为什么受影响。" +
          "**回答「这个能不能改」「改了影响多大」之前先调它** —— " +
          "凭印象说「影响不大」是这个岗位最贵的错误之一。",
        schema: {
          type: "object",
          required: ["target"],
          properties: {
            target: { type: "string", description: "rid，或对象/属性的 apiName、中文名" },
            depth: { type: "integer", description: "顺着依赖走几层，默认 2，最大 4" },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("impact.trace"),
      },
      (args) => {
        const target = argStr(args, "target");
        const rid = resolveRid(oir, target);
        if (rid === null) {
          return {
            error: `OIR 里找不到「${target}」`,
            note: "先用 oir.query 看现有的名字，别照着材料里的写法猜 rid",
          };
        }
        // Python 是 `int(depth or 2)`：0 / None 都落回 2。
        const rawDepth = args["depth"];
        const depth = Math.max(
          1,
          Math.min(
            Math.trunc(
              rawDepth === undefined || rawDepth === null || Number(rawDepth) === 0
                ? 2
                : Number(rawDepth),
            ),
            4,
          ),
        );
        // 广度优先，逐层记路径。纯图遍历、零模型 —— 这条链路上不存在编造，
        // 返回的每个 rid 都必然是 OIR 里已有的实体。
        const seen = new Map<string, string[]>([[rid, [rid]]]);
        let frontier = [rid];
        for (let i = 0; i < depth; i += 1) {
          const nxt: string[] = [];
          for (const cur of frontier) {
            for (const dep of oir.dependents(cur)) {
              if (seen.has(dep)) continue;
              seen.set(dep, [...seen.get(cur)!, dep]);
              nxt.push(dep);
            }
          }
          frontier = nxt;
          if (frontier.length === 0) break;
        }
        const items = [...seen.entries()]
          .filter(([r]) => r !== rid)
          .map(([r, p]) => ({
            rid: r,
            kind: ridKind(oir, r),
            name: ridName(oir, r),
            path: p,
            hops: p.length - 1,
          }));
        const counts: Record<string, number> = {};
        for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
        // Python 的 `sorted(key=(hops, kind))` 是稳定的，且 kind 比的是码点序。
        const affected = [...items].sort(
          (a, b) => a.hops - b.hops || cmpCodePoint(a.kind, b.kind),
        );
        // 流程段（C2）：改这些对象会波及哪些**流程环节**。桥是 FlowNode.objects
        // （autoBindObjects 在建图收尾补、bind_auto 可手动触发）。绑定为空的
        // 老会话这里自然是空 —— 空不等于「不波及」，note 里说清。
        const flowGraph = flowOf();
        const oirObjects = (oir as { objects?: Map<string, unknown> }).objects;
        const objRids =
          oirObjects === undefined
            ? []
            : [rid, ...items.map((it) => it.rid)].filter((r) => oirObjects.has(r));
        const flowHits =
          flowGraph instanceof FlowGraph && objRids.length > 0
            ? flowDependents(flowGraph, objRids)
            : [];
        return {
          target: { rid, kind: ridKind(oir, rid), name: ridName(oir, rid) },
          total: items.length,
          counts,
          affected: affected.slice(0, 60),
          ...(flowHits.length > 0
            ? {
                波及流程环节: flowHits.slice(0, 20).map((h) => h.label),
              }
            : flowGraph instanceof FlowGraph && objRids.length > 0
              ? { 波及流程环节: [], 流程段说明: "流程图的对象绑定为空（老会话）——用 flow.edit 的 bind_auto 先把桥搭上再看。" }
              : {}),
          note:
            items.length > 0
              ? "这是**结构**上的影响面，不含「业务上谁会不高兴」。口径类的影响要另外看冲突清单。"
              : "顺着依赖走不到任何东西 —— 要么它确实是叶子，要么关系还没抽出来。",
        };
      },
    );
    reg.fn(
      {
        name: "entity.compare",
        description:
          "把两个对象/属性/关系/行动**逐字段并排**，报出差在哪、依据是什么。" +
          "**回答「这两个是不是一回事」「该合还是该拆」之前先调它** —— " +
          "同名不同义的口径差异看原文是看不出来的（两段话都在说「金额」），" +
          "而合并不可逆，是这个岗位最贵的错误之一。",
        schema: {
          type: "object",
          required: ["a", "b"],
          properties: {
            a: { type: "string", description: "rid，或 apiName、中文名" },
            b: { type: "string", description: "rid，或 apiName、中文名" },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("entity.compare"),
      },
      (args) => {
        const rawA = argStr(args, "a");
        const rawB = argStr(args, "b");
        const ridA = resolveRid(oir, rawA);
        const ridB = resolveRid(oir, rawB);
        const missing = [
          ridA === null ? rawA : null,
          ridB === null ? rawB : null,
        ].filter((x): x is string => x !== null);
        if (missing.length > 0) {
          return {
            error: `OIR 里找不到${missing.map((m) => `「${m}」`).join("、")}`,
            note: "先用 oir.query 看现有的名字，别照着材料里的写法猜 rid",
          };
        }
        const kindA = ridKind(oir, ridA!);
        const kindB = ridKind(oir, ridB!);
        const sideA = { rid: ridA!, kind: kindA, name: ridName(oir, ridA!) };
        const sideB = { rid: ridB!, kind: kindB, name: ridName(oir, ridB!) };

        if (kindA !== kindB) {
          return {
            a: sideA,
            b: sideB,
            comparable: false,
            note:
              `不是同一类实体（${kindA} vs ${kindB}），逐字段并排没有意义。` +
              "要问的多半是「这个属性该不该挂到那个对象上」——那用 impact.trace 看依赖。",
          };
        }

        const bucket = BUCKET_OF_KIND[kindA] ?? "";
        const itemA = bucketOf(oir, bucket).get(ridA!);
        const itemB = bucketOf(oir, bucket).get(ridB!);
        const fields = COMPARE_FIELDS[kindA] ?? ["apiName", "displayName", "status"];

        const differences: Record<string, unknown>[] = [];
        const same: string[] = [];
        const evidence: Record<string, unknown>[] = [];
        for (const f of fields) {
          const va = fieldValue(itemA, f);
          const vb = fieldValue(itemB, f);
          // 两边都空的字段既不算「相同」也不算「不同」—— 它只是没抽出来。
          // 混进 same 会把「查不到」伪装成「已确认一致」。
          const emptyA = va === null || va === "" || (Array.isArray(va) && va.length === 0);
          const emptyB = vb === null || vb === "" || (Array.isArray(vb) && vb.length === 0);
          if (emptyA && emptyB) continue;
          if (sameValue(va, vb)) {
            same.push(f);
            continue;
          }
          // 长文本不吐原文：真实数据里 description 存的是几百字抽取理由，
          // 两边一起吐能把上下文撑爆，而 FDE 要的是「差在哪」不是两堵墙。
          const TEXT_CAP = 140;
          const isLongText =
            typeof va === "string" && typeof vb === "string" &&
            (va.length > TEXT_CAP || vb.length > TEXT_CAP);
          let row: Record<string, unknown> = { field: f, a: va, b: vb };
          if (isLongText) {
            const sa = String(va);
            const sb = String(vb);
            row = {
              field: f,
              a: cpSlice(sa, 0, TEXT_CAP),
              b: cpSlice(sb, 0, TEXT_CAP),
              截断: true,
            };
            // 一边有一边空**不是**「差在哪几个字」—— 那时 opcodes 只会把
            // 有内容那一边整段当成片段吐出来，比不给还糟。真实数据上就是这样：
            // 一条 description 为空的对象，片段里出现了对方 250 字的全文。
            if (sa.trim() === "" || sb.trim() === "") {
              row["单边"] = sa.trim() === "" ? "b" : "a";
            } else {
              // 片段也要封顶：两段完全不共享内容时，opcodes 给的是整段级别的大块。
              row["差在"] = undescribedDiff(sa, sb).map((x) => cpSlice(x, 0, 60));
            }
          }
          differences.push(row);
          for (const [side, item] of [["a", itemA], ["b", itemB]] as const) {
            for (const ev of fieldEvidence(item, f)) {
              evidence.push({
                side,
                field: f,
                file: String(ev["fileName"] ?? ev["fileId"] ?? ""),
                snippet: String(ev["snippet"] ?? ""),
                locator: ev["locator"] ?? null,
              });
            }
          }
        }

        const out: Record<string, unknown> = {
          a: sideA,
          b: sideB,
          comparable: true,
          differences,
          same: same.sort(cmpCodePoint),
          evidence: evidence.slice(0, 40),
        };

        if (kindA === "object") {
          const pa = propApiNames(oir, ridA!);
          const pb = propApiNames(oir, ridB!);
          const sa = new Set(pa);
          const sb = new Set(pb);
          out["shared_properties"] = pa.filter((x) => sb.has(x));
          out["only_in_a"] = pa.filter((x) => !sb.has(x));
          out["only_in_b"] = pb.filter((x) => !sa.has(x));
        }

        // **信号不是结论。** 合并不可逆，工具报到「值得问一句」为止；
        // 真要合，走 oir.edit 或记一条 decision，由人点头。
        //
        // 优先级有意义（真实数据打脸出来的）：那份 175 对象的 OIR 里有 4 对
        // **显示名完全相同、只有 apiName 不同**的对象。它们是全模型最该合并的
        // 候选，初版却给了和「真的不同」一样的 `differs` —— 读起来正好反了。
        // 但口径冲突必须**压过**它：同名而口径不同时若读成「只是编码不一样」，
        // 就会把最贵的那类错误（合并两个不同口径）伪装成一次无害的重命名。
        const nameOf = (item: unknown): string => String(fieldValue(item, "displayName") ?? "");
        const sameDisplayName = nameOf(itemA) !== "" && nameOf(itemA) === nameOf(itemB);
        const calibreFields = new Set(["definition", "unit", "baseType", "cardinality"]);
        const signal =
          differences.some((d) => calibreFields.has(String(d["field"])))
            ? "caliber_conflict"
            : differences.length === 0
              ? "high_similarity"
              : sameDisplayName && differences.every((d) => d["field"] !== "displayName")
                ? "naming_variance"
                : "differs";
        out["signal"] = signal;
        out["note"] =
          signal === "naming_variance"
            ? "**业务名完全相同，差的是技术编码** —— 这是最强的合并候选那一类。" +
              "但**合并不可逆**：先确认两边指的确实是同一个业务对象，再决定留哪个 apiName。"
            : signal === "high_similarity"
            ? "并排的字段没有差异 —— 但**合并不可逆**，这只是「值得问一句」，不是「就是同一个」。" +
              "空字段没参与比较：两边都没抽出来的字段不算一致。"
            : signal === "caliber_conflict"
              ? "口径或单位不同 —— 这类同名不同义**合了就再也分不开**，" +
                "合并不可逆，先拿证据去问业务方哪个口径算数。"
              : "有差异。要判断该合还是该拆，先看 differences 里的字段和它们的出处。";
        return out;
      },
    );
    reg.fn(
      {
        name: "model.lint",
        description:
          "查当前本体模型里的结构病灶：孤儿对象、断链关系、无宿主属性、挂空的行动、" +
          "缺主键、缺描述。**纯图检查、零模型** —— 每条都指向 OIR 里真实存在的 rid。" +
          "回答「现在模型有什么问题」「能不能开始出交付物」之前先调它。",
        schema: {
          type: "object",
          properties: {
            kind: { type: "string", description: "只看某一类病灶；留空看全部" },
          },
        },
        danger: Danger.READ,
        scopes: scopesForTool("model.lint"),
      },
      (args) => {
        const only = argStr(args, "kind");
        const objects = bucketOf(oir, "objects");
        const properties = bucketOf(oir, "properties");
        const links = bucketOf(oir, "links");
        const actions = bucketOf(oir, "actions");

        const findings: Record<string, unknown>[] = [];
        const add = (kind: string, rid: string, why: string) => {
          findings.push({ kind, rid, name: ridName(oir, rid), why });
        };

        // 关系两端连了谁 —— 孤儿判定要用
        const linked = new Set<string>();
        for (const [rid, l] of links) {
          const src = String(fieldValue(l, "source") ?? "");
          const dst = String(fieldValue(l, "target") ?? "");
          linked.add(src);
          linked.add(dst);
          const dangling = [src, dst].filter((x) => x !== "" && !objects.has(x));
          if (dangling.length > 0) {
            add("broken_link", rid, `两端指向不存在的对象：${dangling.join("、")}`);
          }
        }

        for (const [rid, o] of objects) {
          if (!linked.has(rid)) {
            add("orphan_object", rid, "没有任何关系连到它 —— 要么关系还没抽出来，要么它不该独立成对象");
          }
          const pk = fieldValue(o, "primaryKey");
          if (pk === null || (Array.isArray(pk) && pk.length === 0)) {
            add("object_no_primary_key", rid, "没有主键 —— 下游没法稳定引用它");
          }
          const desc = fieldValue(o, "description");
          if (desc === null || String(desc).trim() === "") {
            add("object_no_description", rid, "没有业务定义 —— 同名不同义的风险全靠人记");
          }
        }

        for (const [rid, pt] of properties) {
          const parent = String(fieldValue(pt, "parent") ?? "");
          if (parent === "" || !objects.has(parent)) {
            add("orphan_property", rid, `parent 指向不存在的对象：${parent || "(空)"}`);
          }
        }

        for (const [rid, at] of actions) {
          const applies = fieldValue(at, "appliesTo");
          const list = Array.isArray(applies) ? applies.map(String) : [];
          const missing = list.filter((x) => !objects.has(x));
          if (list.length === 0) {
            add("action_no_host", rid, "没有声明作用在哪个对象上");
          } else if (missing.length > 0) {
            add("action_no_host", rid, `作用的对象不存在：${missing.join("、")}`);
          }
        }

        // **全量分布**：过滤视图不能让人以为别的病灶不存在
        const counts: Record<string, number> = {};
        for (const f of findings) {
          const k = String(f["kind"]);
          counts[k] = (counts[k] ?? 0) + 1;
        }

        // ── 系统性缺失 vs 个体病灶 ────────────────────────────
        //
        // 真实数据打脸出来的：一份 175 对象 / 0 关系的 OIR 会报 175 条「孤儿对象」
        // + 175 条「没有主键」。那不是 350 个病灶，是**两个系统性事实**：关系层
        // 没抽出来、主键从来没填过。逐条报的后果是名额被占满、别的病灶一条都露不出来，
        // 而「links 是零」这个真正的结论反而没人说。
        //
        // 判据：某一类命中了几乎全体（≥90%）且基数够大（≥10），就收敛成一条带
        // 计数和例子的结论。少数命中（3/175）仍然逐条报 —— 那才是信号。
        const SYSTEMIC_RATIO = 0.9;
        const SYSTEMIC_MIN = 10;
        const POPULATION: Readonly<Record<string, number>> = {
          orphan_object: objects.size,
          object_no_primary_key: objects.size,
          object_no_description: objects.size,
          orphan_property: properties.size,
          broken_link: links.size,
          action_no_host: actions.size,
        };
        const systemic: Record<string, unknown>[] = [];
        const collapsed = new Set<string>();
        for (const [kind, n] of Object.entries(counts)) {
          const pop = POPULATION[kind] ?? 0;
          if (pop < SYSTEMIC_MIN || n / pop < SYSTEMIC_RATIO) continue;
          collapsed.add(kind);
          systemic.push({
            kind,
            count: n,
            of: pop,
            examples: findings
              .filter((f) => f["kind"] === kind)
              .slice(0, 3)
              .map((f) => String(f["name"])),
            why:
              kind === "orphan_object" && links.size === 0
                ? "**整份模型一条关系都没有** —— 这不是 " +
                  `${n} 个孤儿，是关系层根本没抽出来。先补关系，别逐个去查对象。`
                : `${n}/${pop} 全都这样 —— 这是一次系统性缺失（某个抽取环节没填这个字段），` +
                  "不是逐个实体的问题。逐条查没有意义，要回到抽取。",
          });
        }
        // 零关系是**结构事实**，不是「90% 的对象碰巧是孤儿」。即使对象数不到 10，
        // 也要单独说 —— 否则一个 5 对象 0 关系的模型会安静地什么都不报。
        if (objects.size > 0 && links.size === 0 && !collapsed.has("orphan_object")) {
          systemic.push({
            kind: "no_links_at_all",
            count: objects.size,
            of: objects.size,
            examples: [],
            why: "整份模型一条关系都没有 —— 关系层没抽出来。",
          });
        }
        if (links.size === 0 && collapsed.has("orphan_object")) {
          systemic[systemic.findIndex((x) => x["kind"] === "orphan_object")]!["kind"] =
            "no_links_at_all";
        }

        // 收敛是**默认视图**的降噪，不是审查权限。他点名要看某一类，就给他逐条 ——
        // 否则「显式筛 orphan_object」会拿到空结果，读起来像「没有孤儿」。
        let pool = only
          ? findings.filter((f) => f["kind"] === only)
          : findings.filter((f) => !collapsed.has(String(f["kind"])));

        // **分层截断。** 按迭代顺序切前 80 条，会让第一类占满名额、后面的类
        // 一条都露不出来（真实数据上就是这样：80 条全是 orphan_object）。
        const CAP = 80;
        const byKind = new Map<string, Record<string, unknown>[]>();
        for (const f of pool) {
          const k = String(f["kind"]);
          if (!byKind.has(k)) byKind.set(k, []);
          byKind.get(k)!.push(f);
        }
        const shown: Record<string, unknown>[] = [];
        let round = 0;
        while (shown.length < CAP) {
          let added = false;
          for (const rows of byKind.values()) {
            if (round >= rows.length) continue;
            if (shown.length >= CAP) break;
            shown.push(rows[round]!);
            added = true;
          }
          if (!added) break;
          round += 1;
        }

        const empty = objects.size === 0 && properties.size === 0 && links.size === 0;
        return {
          total: findings.length,
          counts,
          systemic,
          findings: shown,
          // 「没报出来」有两种：查过确实没有，和根本没查。把查了哪几项说出来。
          checked: CHECKED_LINTS,
          note: empty
            ? "OIR 是空的 —— **还没抽过**，不是「已确认健康」。先跑梳理或用 oir.add 手工补。"
            : findings.length === 0
              ? `查了 ${CHECKED_LINTS.length} 类结构病灶，都没命中。注意这只覆盖**结构**，` +
                "口径矛盾要另外看冲突清单。"
              : "这些都是**结构**问题（引用断了、缺必要字段）。口径类分歧不在这里，看冲突清单。",
        };
      },
    );
  }

  // Python 是 `if profiles:` —— 空 dict 也不注册（一个没有任何列画像的会话里，
  // 这个工具只会一直回"没有 xxx 的画像"，纯属噪声）。
  if (profiles !== null && Object.keys(profiles).length > 0) {
    reg.fn(
      {
        name: "profile.column",
        description:
          "查某一列的确定性统计（唯一率、空值率、推断类型、样本值）。" +
          "判断声明类型与实际数据是否相符时用它 —— 这类跨行分布问题" +
          "不要靠自己看样本推断。",
        schema: {
          type: "object",
          required: ["column"],
          properties: { column: { type: "string", description: "形如 表名.列名" } },
        },
        danger: Danger.READ,
        scopes: scopesForTool("profile.column"),
      },
      (args) => {
        const column = argStr(args, "column");
        if (Object.hasOwn(profiles, column)) return profiles[column];
        const near = Object.keys(profiles).filter((k) =>
          k.toLowerCase().includes(column.toLowerCase()),
        );
        return { error: `没有 ${column} 的画像`, did_you_mean: near.slice(0, 8) };
      },
    );
  }

  if (sandbox !== null) {
    reg.fn(
      {
        name: "code.exec",
        // 沙箱换成 TS 之后这段**必须**跟着改：模型是照描述写代码的，还写 pandas
        // 的话每一次调用都是白跑，而它从错误里学不到「这里没有 Python」。
        description:
          "在隔离沙箱里执行 TypeScript/JavaScript（ESM，可写类型标注）。用于数据" +
          "清洗、透视、连接、统计这类变换。已预先注入：aq（arquero，dplyr 风格的" +
          "表操作 —— aq.from(rows) / groupby / rollup / derive / join / orderby，" +
          "聚合函数在 aq.op 下）、INPUTS(对象)、IN_DIR、OUT_DIR、emit(obj)；" +
          "结构化结果请用 emit() 交回（直接 emit 一张 arquero 表也认）。" +
          "无网络，无子进程，只有 OUT_DIR 可写。",
        schema: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", description: "TypeScript/JavaScript 源码（ESM）" },
            inputs: { type: "object", description: "注入为 INPUTS" },
          },
        },
        // **最小权限：只给声明了它的作用域。** 默认的 `["*"]` 会把执行代码的
        // 能力发给每一个作用域，包括直接读用户上传材料的 extract —— 材料里
        // 一段伪装成业务说明的指令就能诱导模型调它。TOOL_SCOPES 早就写明
        // 只有 analyze/compile 该有，这里让那份声明真正生效。
        danger: Danger.COMPUTE,
        scopes: scopesForTool("code.exec"),
      },
      async (args) => {
        const code = argStr(args, "code");
        const inputs = args["inputs"];
        const res = await sandbox.exec(
          code,
          inputs !== null && typeof inputs === "object" && !Array.isArray(inputs)
            ? (inputs as Record<string, unknown>)
            : {},
        );
        return res;
      },
    );
  }

  assertManagedToolRegistrations(registry.registrationSnapshot(), "core");
  return registry;
}

/**
 * `default_sandbox(production=True) if ONTOCOPILOT_ENABLE_CODEACT else None` 的
 * TS 对等物 —— 沙箱本体在 `kernel/sandbox.ts`，同一个进程里。
 *
 * 两种"没有"都回 `null`，因为 {@link builtinRegistry} 对它们的处理必须一样：
 * 开关没开、容器运行时不在。**返回 null 的意思是 `code.exec` 不进动作空间**，
 * 见文件头。
 *
 * **`production: true` 不能省。** HTTP 服务跑的是不可信材料引出的代码，
 * `LocalSubprocessSandbox` 没有内核隔离（它自己的文件头写着这句）。宁可这台
 * 机器上没有 `code.exec`，也不要一个"看起来有沙箱"的子进程。
 */
export async function sandboxForTools(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxLike | null> {
  // HTTP 服务绝不把宿主沙箱暴露给不可信材料。确需 CodeAct 的部署必须显式开启。
  const flag = String(env["ONTOCOPILOT_ENABLE_CODEACT"] ?? "").toLowerCase();
  if (!["1", "true", "yes"].includes(flag)) return null;
  try {
    // **探一次再注册，而且要探到运行时那一层。**
    //
    // 原来这里是 `defaultSandbox({production:true})`（写死 gVisor）+ 只查
    // `docker` 在不在 PATH。实测下来这个组合有个洞：Docker Desktop 装了、
    // docker 在 PATH 上、探活通过，但 `docker run --runtime runsc` 报
    // `unknown or invalid runtime name: runsc` —— 于是 code.exec 进了动作空间、
    // 每次调用必然失败，正是文件头说的"模型反复重试一个永远不会成功的工具"。
    //
    // 现在按**实际可用的运行时**挑最强的那一档（microvm > gvisor > runc），
    // 一个都没有就返回 null。runc 档不冒充 production_safe（那个判据只认
    // gvisor/microvm），但它是真的容器边界，好过完全没有。
    const executor = bestContainerSandbox({});
    if (executor === null) return null;
    if (!onPath(executor.docker, env)) return null;
    return asSandboxLike(executor);
  } catch {
    // 装配失败等同于"没有沙箱"。抛上去会让整条对话/梳理起不来，
    // 而 code.exec 从来不是必需品。
    return null;
  }
}

/**
 * PATH 上有没有这个可执行文件。
 *
 * 自己走一遍 PATH 而不是 `spawnSync("docker","--version")`：探活会在**每次**装配
 * 工具表时跑，起一个进程要几十毫秒，而对话那条路每轮都装一次。
 */
function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  if (bin.includes("/")) return canExec(bin);
  const dirs = (env["PATH"] ?? "").split(":").filter((d) => d !== "");
  return dirs.some((d) => canExec(join(d, bin)));
}

function canExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 先探沙箱再装配。`_run_pipeline` 那条路要的就是这个组合。 */
export async function builtinRegistryWithSandbox(
  opts: BuiltinRegistryOptions = {},
): Promise<ToolRegistry> {
  return builtinRegistry({ ...opts, sandbox: await sandboxForTools() });
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/** Python 字符串比较按码点；JS 的 `<` 按 UTF-16 码元。CJK 之外的面上不同。 */
function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return x.length - y.length;
}
