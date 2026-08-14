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

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import { scopesForTool } from "../../kernel/agents.js";
import type { EvidenceIndex } from "../../kernel/memory/evidence.js";
import { Danger, ToolRegistry, type ToolCallCtx } from "../../kernel/tools.js";
import { cpSlice } from "../../onto/parse/base.js";
import {
  ContainerSandbox,
  asSandboxLike,
  defaultSandbox,
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
  const reg = new ToolRegistry();
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
        const hits = evidence.byLocator({ file, container, rows: span, limit });
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
        description: "查当前 OIR 里已有的对象/属性/关系。用来避免重复抽取同一个概念。",
        schema: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: ["objects", "properties", "links", "actions", "stats"],
            },
            name_contains: { type: "string" },
          },
        },
        danger: Danger.READ,
      },
      (args) => {
        const kind = argStr(args, "kind");
        const nameContains = argStr(args, "name_contains");
        if (kind === "stats") return oir.stats();
        // Python 是 `getattr(oir, kind)` —— 桶不存在就 AttributeError。这里
        // 同样显式炸：schema 已经把 kind 限死在五个值里，出现别的值是内部错误。
        const bucket = (oir as unknown as Record<string, unknown>)[kind];
        if (!(bucket instanceof Map)) throw new Error(`OIR 没有 ${kind} 这个桶`);
        const items: unknown[] = [];
        for (const e of bucket.values()) {
          const api = assertionValue(e, "apiName");
          if (nameContains && !String(api).toLowerCase().includes(nameContains.toLowerCase())) {
            continue;
          }
          items.push((e as { toDict(): unknown }).toDict());
        }
        return { count: items.length, items: items.slice(0, 60) };
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
        return {
          target: { rid, kind: ridKind(oir, rid), name: ridName(oir, rid) },
          total: items.length,
          counts,
          affected: affected.slice(0, 60),
          note:
            items.length > 0
              ? "这是**结构**上的影响面，不含「业务上谁会不高兴」。口径类的影响要另外看冲突清单。"
              : "顺着依赖走不到任何东西 —— 要么它确实是叶子，要么关系还没抽出来。",
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

  return reg;
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
    const executor = defaultSandbox({ production: true });
    // **探一次再注册。** 容器沙箱要外部运行时；`docker` 不在 PATH 上时它每次
    // 调用都抛 SandboxError —— 那正是文件头说的"模型反复重试一个永远不会成功
    // 的工具"。
    if (executor instanceof ContainerSandbox && !onPath(executor.docker, env)) return null;
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
