/**
 * ContextManager —— 四层记忆的装配。移植自 `kernel/memory/context.py`。
 *
 *     L0 System      角色 + 建模规范 + 命名词典        常驻，已压缩成规则表
 *     L1 Working     上游节点产出 + 本节点 scratchpad   全量（超预算则压缩）
 *     L2 Evidence    原始材料切片                      **按需检索**，弹性层
 *     L3 Reflection  本 Run 内 critic 沉淀的教训 + 长期记忆召回   全量（体量小）
 *
 * 装配顺序即优先级：L0 → L3 → L1 → L2。前三层是"必须知道的"，证据层拿剩下的
 * 额度 —— 因为证据永远装不完，而且少装几片的代价远小于挤掉规范或教训。
 *
 * 超预算时的处置顺序也是设计好的：先压 scratchpad（节点内过程，信息密度最低），
 * 再截上游产出的长文本字段，最后才削证据。**任何时候都不动 locator。**
 *
 * 由 `golden/memory.long_term.json` 的 `context` / `clip` / `render_upstream`
 * 三节钉住 —— 装配顺序错了，模型看到的上下文就变了，而那是不报错的那种错。
 */

// Python 侧 `_render_upstream` 里是**函数内 import json**，按契约 §1 提到顶层。
// 用 journal 的 `pyJsonDumps` 而不是 `JSON.stringify`：Python 的默认分隔符是
// `", "` / `": "`，`JSON.stringify` 是紧凑的 —— 上游产出的字节长度直接决定
// est_tokens 的结果和 _clip 的切点，差一个空格整层就对不上。
import { pyJsonDumps } from "../journal.js";
import { EvidenceIndex } from "./evidence.js";
import type { Chunk } from "./evidence.js";
import type { LongTermStore } from "./long_term.js";
import type { Scratchpad, WorkingSet } from "./short_term.js";
import { estTokens } from "./types.js";
import type { MemoryItem, MemoryKind } from "./types.js";

/** 各层的预算占比。证据层不列 —— 它拿剩下的全部。 */
export interface LayerShares {
  readonly system: number;
  readonly reflection: number;
  readonly working: number;
  /** 证据层最少要留这么多，否则这个节点根本没法做归因。 */
  readonly evidenceFloor: number;
}

export interface LayerSharesInit {
  readonly system?: number | undefined;
  readonly reflection?: number | undefined;
  readonly working?: number | undefined;
  readonly evidenceFloor?: number | undefined;
}

export function makeLayerShares(p: LayerSharesInit = {}): LayerShares {
  return {
    system: p.system ?? 0.12,
    reflection: p.reflection ?? 0.1,
    working: p.working ?? 0.38,
    evidenceFloor: p.evidenceFloor ?? 0.2,
  };
}

/** `RenderedContext.stats()` 的形态。 */
export interface ContextStats {
  total_tokens: number;
  layers: Record<string, number>;
  chunks: number;
  recalled: number;
  compactions: number;
  dropped: string[];
}

/**
 * 装配结果。
 *
 * `layers` / `tokens` 是普通对象而不是 Map：键固定是四个 `L*_*` 字符串，不是整数
 * 样式，V8 的插入序就是 Python dict 的插入序（契约 §1 的例外条件不成立）。
 */
export class RenderedContext {
  text: string;
  layers: Record<string, string> = {};
  tokens: Record<string, number> = {};
  chunks: Chunk[] = [];
  recalled: MemoryItem[] = [];
  compactions = 0;
  dropped: string[] = [];

  constructor(text: string) {
    this.text = text;
  }

  get totalTokens(): number {
    let n = 0;
    for (const v of Object.values(this.tokens)) n += v;
    return n;
  }

  stats(): ContextStats {
    return {
      total_tokens: this.totalTokens,
      layers: { ...this.tokens },
      chunks: this.chunks.length,
      recalled: this.recalled.length,
      compactions: this.compactions,
      dropped: this.dropped,
    };
  }
}

export interface ContextManagerInit {
  /** L0 常驻内容（角色、Ontology 原语定义、项目建模规范）。 */
  readonly system?: string | undefined;
  /** 长期记忆库，可为 null（首个 Run 冷启动）。 */
  readonly longTerm?: LongTermStore | null | undefined;
  readonly evidence?: EvidenceIndex | null | undefined;
  /** 单次装配的总预算。 */
  readonly budgetTokens?: number | undefined;
  readonly shares?: LayerShares | undefined;
}

export interface AssembleOptions {
  /** 本节点的任务描述，进 L0 尾部。 */
  readonly task: string;
  /** 证据检索与长期记忆召回的查询串，默认用 task。 */
  readonly query?: string | undefined;
  readonly working?: WorkingSet | null | undefined;
  /** 上游节点 id，支持 `PARSE.*` 通配。 */
  readonly deps?: readonly string[] | null | undefined;
  readonly scratch?: Scratchpad | null | undefined;
  readonly runId?: string | undefined;
  readonly evidenceFiles?: readonly string[] | null | undefined;
  readonly evidenceTopK?: number | undefined;
  readonly budgetTokens?: number | null | undefined;
  readonly recallKinds?: readonly MemoryKind[] | null | undefined;
  /** 本轮在看的材料名。只影响参考档记忆：跨材料的那些会被降权并在 prompt 里标
   * 出来。不传 = 不做这层判断。 */
  readonly currentFiles?: ReadonlySet<string> | null | undefined;
}

/** 把四层记忆装配成一份 prompt 上下文。 */
export class ContextManager {
  system: string;
  longTerm: LongTermStore | null;
  evidence: EvidenceIndex;
  budgetTokens: number;
  shares: LayerShares;
  private readonly reflectionList: string[] = [];

  constructor(p: ContextManagerInit = {}) {
    this.system = p.system ?? "";
    this.longTerm = p.longTerm ?? null;
    // Python 那行是 `EvidenceIndex() if evidence is None else evidence` 而不是
    // `evidence or EvidenceIndex()` —— EvidenceIndex 定义了 __len__，空索引是
    // falsy，用 `or` 会在"先建空索引、再往里灌切片"这个常见顺序下静默丢掉索引。
    // TS 侧对象恒为真值，坑本身不存在，但注释留着：改回 `??` 之外的写法之前先看这行。
    this.evidence = p.evidence === undefined || p.evidence === null ? new EvidenceIndex() : p.evidence;
    this.budgetTokens = p.budgetTokens ?? 120_000;
    this.shares = p.shares ?? makeLayerShares();
  }

  // ── L3 写入 ─────────────────────────────────────────────────

  /**
   * Reflexion：把 critic 反馈沉淀成本 Run 内的教训。
   *
   * 同一 Run 后续节点会看到它，从而不再犯同样的错。是否升入长期库由
   * `PromotionGate` 决定 —— 这里只管短期。
   */
  reflect(lesson: string): void {
    if (lesson && !this.reflectionList.includes(lesson)) this.reflectionList.push(lesson);
  }

  get reflections(): string[] {
    return [...this.reflectionList];
  }

  // ── 装配 ────────────────────────────────────────────────────

  assemble(o: AssembleOptions): RenderedContext {
    const task = o.task;
    const q = o.query || task;
    // 节点可以给更紧的预算。抽取类节点的正文已经很长，再按全局预算灌证据
    // 会让单次输入涨好几倍，而多出来的部分往往是同一批切片。
    const budget = Math.min(this.budgetTokens, o.budgetTokens || this.budgetTokens);
    const ctx = new RenderedContext("");

    // ── L0 System ───────────────────────────────────────────
    const sysBudget = Math.trunc(budget * this.shares.system);
    const sysText = clip(`${this.system}\n\n## 当前任务\n${task}`.trim(), sysBudget);
    ctx.layers["L0_system"] = sysText;
    ctx.tokens["L0_system"] = estTokens(sysText);

    // ── L3 Reflection：本 Run 教训 + 长期记忆召回 ─────────────
    const reflBudget = Math.trunc(budget * this.shares.reflection);
    let recalled: MemoryItem[] = [];
    if (this.longTerm !== null) {
      recalled = this.longTerm.recall(q, {
        runId: o.runId ?? "",
        kinds: o.recallKinds ?? null,
        limit: 10,
        budgetTokens: Math.trunc(reflBudget * 0.6),
        currentFiles: o.currentFiles ?? null,
      });
    }
    // 参考档的来源标注由 render 放在**内容前面** —— 下面这段会被整体 clip，
    // 写在条目末尾的标注会被切掉，只剩一句看着像事实的断言。
    const lines = recalled.map((m) => `· ${m.render(m.fromOtherMaterial(o.currentFiles ?? null))}`);
    for (const r of this.reflectionList) lines.push(`· 本轮教训：${r}`);
    const reflText = clip(lines.join("\n"), reflBudget);
    ctx.layers["L3_reflection"] = reflText;
    ctx.tokens["L3_reflection"] = estTokens(reflText);
    ctx.recalled = recalled;

    // ── L1 Working：上游产出 + scratchpad ────────────────────
    const workBudget = Math.trunc(budget * this.shares.working);
    const working = o.working ?? null;
    const scratch = o.scratch ?? null;
    const upstream = working ? working.select([...(o.deps ?? [])]) : {};
    // 注意扣的是**压缩前**的 scratch.tokens：Python 就是这个顺序（先算上游预算，
    // 再压 scratchpad）。挪到压缩之后，上游能拿到的额度会变多，整层随之漂移。
    const upText = renderUpstream(upstream, workBudget - (scratch ? scratch.tokens : 0));
    let padText = "";
    if (scratch !== null) {
      if (scratch.overBudget()) ctx.compactions += scratch.compactToFit();
      padText = scratch.render();
    }
    let workText = [upText, padText].filter((x) => x).join("\n\n");
    if (estTokens(workText) > workBudget) {
      workText = clip(workText, workBudget);
      ctx.dropped.push("working:truncated");
    }
    ctx.layers["L1_working"] = workText;
    ctx.tokens["L1_working"] = estTokens(workText);

    // ── L2 Evidence：拿剩下的全部，但有地板 ──────────────────
    const used = ctx.totalTokens;
    const evBudget = Math.max(Math.trunc(budget * this.shares.evidenceFloor), budget - used);
    if (used + evBudget > budget) {
      // 前三层挤占了证据地板 —— 削 working 而不是削证据
      const over = used + evBudget - budget;
      ctx.layers["L1_working"] = clip(
        ctx.layers["L1_working"] ?? "",
        Math.max(0, (ctx.tokens["L1_working"] ?? 0) - over),
      );
      ctx.tokens["L1_working"] = estTokens(ctx.layers["L1_working"]);
      ctx.dropped.push(`working:-${over}tok(保证据地板)`);
    }

    const chunks = this.evidence.search(q, {
      topK: o.evidenceTopK ?? 24,
      files: o.evidenceFiles ?? null,
      expand: 1,
      budgetTokens: evBudget,
    });
    const evText = EvidenceIndex.render(chunks);
    ctx.layers["L2_evidence"] = evText;
    ctx.tokens["L2_evidence"] = estTokens(evText);
    ctx.chunks = chunks;

    ctx.text = join(ctx.layers);
    return ctx;
  }
}

// ── 渲染辅助 ────────────────────────────────────────────────────

const HEADERS: Readonly<Record<string, string>> = {
  L0_system: "",
  L3_reflection: "## 已知约定与教训",
  L1_working: "## 上游产出",
  L2_evidence: "## 证据切片（每片带出处，引用时必须带上）",
};

const LAYER_ORDER = ["L0_system", "L3_reflection", "L1_working", "L2_evidence"] as const;

function join(layers: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const key of LAYER_ORDER) {
    const body = (layers[key] ?? "").trim();
    if (!body) continue;
    const head = HEADERS[key] ?? "";
    parts.push(head ? `${head}\n${body}`.trim() : body);
  }
  return parts.join("\n\n");
}

/**
 * 按 token 预算截断。宁可截断也不能超预算 —— 超了是硬失败。
 *
 * 二分的下标是**码点**下标，不是 `.length` 的码元下标：切在代理对中间会产生一个
 * 落单代理，那种串 `JSON.stringify` 得出来是 `\udXXX`，落进日志就是坏数据。
 * Python 的 `text[:mid]` 天然按码点，这里必须显式还原。
 */
export function clip(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estTokens(text) <= maxTokens) return text;
  const cps = [...text];
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estTokens(cps.slice(0, mid).join("")) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  // `.rstrip()` → `.trimEnd()`（契约 §1：保留集内等价，见 ids.ts 的说明）
  return cps.slice(0, lo).join("").trimEnd() + " …[已截断]";
}

/** 上游产出渲染。按节点均分预算，避免某个大产出把别的挤没。 */
export function renderUpstream(upstream: Readonly<Record<string, unknown>>, budget: number): string {
  const keys = Object.keys(upstream);
  if (keys.length === 0) return "";
  // `//` 是 floor 除。budget 会被 scratch.tokens 减成负数，那时 floor 与
  // 截断（Math.trunc）方向相反 —— 但外面还套着 max(200, …)，负数一律被抬到 200。
  const per = Math.max(200, Math.floor(budget / Math.max(1, keys.length)));
  const parts: string[] = [];
  for (const nid of keys) {
    const out = upstream[nid];
    const body = typeof out === "string" ? out : pyJsonDumps(out, { defaultStr: true });
    parts.push(`### ← ${nid}\n${clip(body, per)}`);
  }
  return parts.join("\n\n");
}
