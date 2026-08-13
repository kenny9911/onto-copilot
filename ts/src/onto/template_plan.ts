/**
 * 让 AI 把模板**改得贴这个项目** —— 但一格 xlsx 也不由它生成。
 * 移植自 `src/ontocopilot/onto/template_plan.py`，由 `golden/onto.export.json`
 * 的 `template_plan` 段钉住（提示词逐字、五条应用说明逐字、六条拒绝理由逐字）。
 *
 * `compileTemplate()` 是确定性的：固定几张表、固定顺序、固定列。它保证了往返契约
 * （隐藏锚点列、列名==field==回写 key），但也意味着不管做的是采购、保险还是排产，
 * 业务方拿到的都是同一张骨架，列名是 `apiName`/`baseType`/`cardinality` 这种他一列
 * 都读不懂的词。
 *
 * 这里加的是**适配**，不是生成：
 *
 *     确定性编译器出骨架  →  AI 只选一串结构化编辑 op  →  守卫逐条校验  →  应用
 *
 * 模型永远不产出 xlsx、也不产出整份 spec，它只能从 `template_edit` 已有的 op 里选
 * （改列名、调顺序、写说明、设下拉、改必填性）。所以：
 *
 * * 锚点列删不掉、改不了名 —— 守卫拦着，和人工编辑走同一套；
 * * 回写路径断不了 —— `WRITEBACK_FIELDS` 那条守卫对 AI 一视同仁；
 * * 出错不致命 —— 某条 op 违规就丢掉那一条，其余照常应用，最差退回原始骨架。
 *
 * 这条分界线是有意的：**能确定性做的事不要交给模型**（哪些行进表、值从哪来、锚点
 * 怎么埋），模型只做确定性代码做不了的那部分 —— 判断这个项目里哪些列重要、该用
 * 客户的哪个词、哪些取值该做成下拉。
 */

import { EditError, applyEdit } from "./template_edit.js";
import type { TemplateSpec } from "./template.js";

/**
 * AI 只能选 op + 参数。**没有"直接给我一张表"这个选项** —— 那会丢掉锚点。
 * 白名单也刻意不含 add_column/drop_column：加列要有回写路径才有意义，删列容易
 * 把业务方要填的东西删没；这两个留给人工显式指令，AI 适配只做"改措辞、调顺序、
 * 给提示、设下拉、定必填"。
 */
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["edits"],
  properties: {
    edits: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["op", "why"],
        properties: {
          op: {
            type: "string",
            enum: ["rename_column", "set_guide", "set_options", "set_role", "reorder_sheets"],
          },
          sheet: { type: "string" },
          column: { type: "string" },
          old: { type: "string" },
          new: { type: "string" },
          text: { type: "string", description: "set_guide：给业务方的说明" },
          role: { type: "string", enum: ["locked", "prefilled", "required"] },
          options: { type: "array", items: { type: "string" } },
          order: { type: "array", items: { type: "string" } },
          why: { type: "string", description: "为什么这么改，一句话。会记进补丁日志备查" },
        },
      },
    },
  },
};

// ══════════════════════════════════════════════════════════════════
//  Python 语义垫片
// ══════════════════════════════════════════════════════════════════

/**
 * `f"{stats}"` —— Python 的 dict repr（`{'objects': 12, 'properties': 40}`）。
 *
 * 提示词里那一行直接把 dict 插值进去了。**不能换成 `JSON.stringify`**：那会写成
 * `{"objects":12}`，与 Python 时代的提示词逐字不同。提示词一个字节的差别就是
 * 另一份分布，之前调好的少数派行为（"没把握就少提几条"）不保证还成立。
 */
function pyDictRepr(d: Readonly<Record<string, unknown>>): string {
  const body = Object.entries(d)
    .map(([k, v]) => `${pyValueRepr(k)}: ${pyValueRepr(v)}`)
    .join(", ");
  return `{${body}}`;
}

function pyValueRepr(v: unknown): string {
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (v === null) return "None";
  if (v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map(pyValueRepr).join(", ")}]`;
  if (typeof v === "object") return pyDictRepr(v as Record<string, unknown>);
  return String(v);
}

/** 提示词里出现的表骨架的一行。 */
export interface PlanSheetView {
  readonly name: string;
  readonly rows?: number;
  readonly columns?: readonly string[] | null;
}

/** 让模型看着**这个项目的骨架和词汇**提改法。 */
export function planPrompt(o: {
  project: string;
  stats: Readonly<Record<string, unknown>>;
  sheets: readonly PlanSheetView[];
  vocabulary: readonly string[];
  openQuestions: readonly string[];
}): string {
  const sheetLines = o.sheets
    .map((s) => `- 「${s.name}」${s.rows ?? 0} 行；列：${(s.columns ?? []).join("、")}`)
    .join("\n");
  const parts = [
    `## 项目\n${o.project || "（未命名）"}\n`,
    `## 已抽出的产物规模\n${pyDictRepr(o.stats)}\n`,
    `## 当前模板骨架\n${sheetLines}\n`,
    o.vocabulary.length > 0 ? `## 材料里出现的业务词\n${o.vocabulary.slice(0, 40).join("、")}\n` : "",
    o.openQuestions.length > 0
      ? "## 待澄清的问题\n" + o.openQuestions.slice(0, 8).map((q) => `- ${q}`).join("\n") + "\n"
      : "",
    "这张模板要发给**业务方**填。他们不是建模的人：`apiName`、`baseType`、" +
      "`cardinality` 这些词他们读不懂，也不知道该往哪一列写什么。\n\n" +
      "在**不改变有哪些行、值从哪来**的前提下，提一组改法让它更好填：\n" +
      "- 把列名换成客户材料里的说法（用上面那些业务词，别自己造词）；\n" +
      "- 给每张表写一句说明：这张表要他回答什么、答到什么程度算完；\n" +
      "- 取值有限的列做成下拉（选项要来自材料里真出现过的值）；\n" +
      "- 把最该他答、只有他答得了的表排前面。\n\n" +
      "每条都要写 why。**没有把握就少提几条** —— 提一条错的改法比不提更糟。",
  ];
  // Python 是 `"\n".join(x for x in [...] if x)`：空串的段整段不出现
  return parts.filter((x) => x !== "").join("\n");
}

/** 一条 AI 提的改法。`op`/`why` 之外的键就是那个 op 的参数。 */
export type PlanEdit = Record<string, unknown>;

/** 被拒的条目：原样带回 + 一条 `why_rejected`（**线上形态，snake_case**）。 */
export type RejectedEdit = PlanEdit & { readonly why_rejected: string };

/**
 * 把 AI 提的改法逐条应用。返回 `[应用成功的说明, 被拒的条目]`。
 *
 * **逐条独立**：一条违规只丢那一条，不影响其余，也绝不半途把 spec 留在中间态
 * （`applyEdit` 本身是写时复制 + 守卫，被拒时原 spec 不动）。
 */
export function applyPlan(
  spec: TemplateSpec,
  edits: readonly PlanEdit[] | null | undefined,
): [string[], RejectedEdit[]] {
  const done: string[] = [];
  const rejected: RejectedEdit[] = [];
  for (const e of edits ?? []) {
    const op = e["op"] === null || e["op"] === undefined ? "" : String(e["op"]);
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      // Python 是 `v not in (None, "", [])`：空列表也算"没给"。`[] == []` 在 JS
      // 里是 false，所以要显式判长度 —— 不判的话一个 `options: []` 会被当成
      // 有效参数传下去，守卫报的错就变成了另一条（"下拉不能为空"而不是"缺参数"）。
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (k === "op" || k === "why") continue;
      args[k] = v;
    }
    try {
      done.push(applyEdit(spec, op, args));
    } catch (exc) {
      // 守卫拒了就记下来。AI 提的改法和人工的一视同仁 —— 锚点、回写路径、
      // 下拉长度这些不变量对谁都不放行。
      // Python 是 `except (EditError, TypeError)`：TS 侧 template_edit 已经把
      // 参数错误包成 EditError，TypeError 仍然接着 —— 别的异常必须原样上抛，
      // 不然一个真 bug 会伪装成"模型提了条坏改法"。
      if (!(exc instanceof EditError) && !(exc instanceof TypeError)) throw exc;
      rejected.push({ ...e, why_rejected: exc.message });
    }
  }
  return [done, rejected];
}

/** `gateway.call()` 在这一段用到的那一小块。 */
export interface PlanGateway {
  call(
    nodeId: string,
    prompt: string,
    opts: { schema?: unknown; max_tokens?: number; key?: string },
  ): Promise<{ data?: Record<string, unknown> | null }>;
}

export interface AdaptResult {
  readonly applied: string[];
  readonly rejected: RejectedEdit[];
  readonly error: string | null;
}

/**
 * 给骨架做一轮 AI 适配。**失败就用原骨架，绝不让这一步弄挂整次编译。**
 */
export async function adaptTemplate(
  spec: TemplateSpec,
  o: {
    gateway: PlanGateway;
    nodeId: string;
    project: string;
    stats: Readonly<Record<string, unknown>>;
    vocabulary: readonly string[];
    openQuestions: readonly string[];
  },
): Promise<AdaptResult> {
  const sheets: PlanSheetView[] = spec.sheets.map((sh) => ({
    name: sh.name,
    rows: sh.rows.length,
    columns: [...sh.columns],
  }));
  let edits: PlanEdit[];
  try {
    const comp = await o.gateway.call(
      o.nodeId,
      planPrompt({
        project: o.project,
        stats: o.stats,
        sheets,
        vocabulary: o.vocabulary,
        openQuestions: o.openQuestions,
      }),
      { schema: PLAN_SCHEMA, max_tokens: 4000, key: "tpl_plan" },
    );
    const raw = (comp.data ?? {})["edits"];
    edits = Array.isArray(raw) ? (raw as PlanEdit[]) : [];
  } catch (exc) {
    // 模型不可用不该让模板出不来。消息形态照抄 `f"{type(exc).__name__}: {exc}"`。
    const name = exc instanceof Error ? exc.name : typeof exc;
    const text = exc instanceof Error ? exc.message : String(exc);
    return { applied: [], rejected: [], error: `${name}: ${text}` };
  }
  const [applied, rejected] = applyPlan(spec, edits);
  return { applied, rejected, error: null };
}
