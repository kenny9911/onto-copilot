/**
 * 参考流程图 —— 从**模型的领域通识**画一张「一般来说这个流程长什么样」。
 *
 * 起因是一句每次 kickoff 都会被问到的话：「先帮我分析一下一般采购流程是什么，
 * 生成一份流程图」。这时候**手里一份材料都没有** —— `flow.preview` 那条路要先有
 * 材料才走得动，于是 FDE 被挡回「还没有材料，先上传」，而他要的恰恰是上传之前的
 * 那张底图：拿它去跟业务方对，业务方指着说「我们这儿不是这样」，那句话本身就是
 * 第一条需求。
 *
 * ── 这张图和真流程图是两种东西，必须一眼分得清 ────────────────
 *
 * 这个产品有一条硬要求：**问题清单 / 流程图 / 模板列都要从证据推出来，不许照抄
 * 某份材料的形状**。整条管线（抽取 → 冲突检测 → 缺口挖掘 → 模板编译）都建立在
 * 「每一条断言都能回答『凭什么』」之上。
 *
 * 而这张图**恰恰不是从证据来的**：它来自模型读过的行业资料，一条 evidence 都没有。
 * 所以它必须：
 *
 *  1. **三处显式标注来源**（SVG 标题 / 产物文件名 / 聊天卡片）。少标一处，就会有人
 *     把它截图进方案文档，然后所有人都以为那是从客户材料里读出来的现状。一张分不清
 *     出处的流程图比没有图更危险 —— 它看起来同样确定。
 *  2. **不写进会话的 OIR / flow 状态**。写进去的后果不是「多一张图」，是整条下游被
 *     污染：冲突检测会拿模型编的环节去和客户材料对撞，缺口挖掘会为一个客户根本没有
 *     的环节生成问题，模板编译会为它开一列。到那时已经分不出哪些结论是证据推的。
 *     它是一张**参考图**，不是交付物 —— 因此落在 `exports/` 而不是会话根目录
 *     （根目录下的文件会被算成产物、进产物 tab、进交付包 zip）。
 *  3. 节点与边一律 `Origin.INFERRED`、零 evidence。这不是偷懒：`to_svg` 对
 *     `grounded == false` 的节点画虚线框，对无 evidence 的边计入
 *     「N 条边为系统推断，需人工确认」。所以**整张参考图天然是虚线的**，
 *     而真流程图里有依据的环节是实线 —— 摆在一起是看得出来的。
 *
 * ── 模型出结构，不出 SVG ──────────────────────────────────────
 *
 * 模型只负责它真正知道的那部分：有哪些环节、谁做、什么顺序、哪里分叉。图形由
 * `diagram.ts` 的 `toSvg()` 画。理由有三条，每条都吃过亏：
 *
 *  · 模型直接画 SVG 会画歪（坐标算不准、框会重叠），而且两次生成不一致；
 *  · 泳道分层、换行、配色、编号已经在 `diagram.ts`/`flow.ts` 里了，让模型另画一套
 *    等于这张图和真流程图长得不一样 —— 而它们本来就该长得一样，只差实线虚线；
 *  · **结构化产出可以被校验**。下面 `graphFromSketch` 那一堆检查，对着一坨 SVG
 *    字符串是做不了的。
 *
 * ── 不许写死成采购 ────────────────────────────────────────────
 *
 * 一个只会画采购的工具正好踩在上面那条产品原则上（照抄某个域的形状）。所以这里
 * 没有任何领域词表：域名只作为参数进 prompt，制造/医疗/财务照样出得来。
 * 节点编号交给 `flow.ts` 的 `codeFor()` —— 它认不出行业动词时回退到内容哈希，
 * 不会因为换个域就编不出编号。
 */

import { rid as makeRid } from "../kernel/ids.js";
import {
  EdgeKind,
  FlowGraph,
  NodeKind,
  makeFlowNode,
  makeStage,
} from "./flow.js";
import { inferred } from "./oir.js";

// ══════════════════════════════════════════════════════════════════
//  来源标注
// ══════════════════════════════════════════════════════════════════

/**
 * 三处标注共用的**同一个串**。
 *
 * 写成一个常量而不是三处各写一句：三处措辞一旦漂开，「这张图是哪来的」就会变成
 * 一个要靠猜的问题 —— 而这正是这个常量存在的全部理由。
 */
export const SKETCH_MARK = "通用参考 · 模型知识，非客户材料证据";

/** 给用户看的一句话解释。卡片和工具回执共用。 */
export const SKETCH_CAVEAT =
  "这张图来自模型的行业通识，**不是**从你的材料里抽出来的。" +
  "拿它当讨论底图用；材料上传后跑出来的那张才是有依据的流程图。";

/** SVG 标题（第一处标注）。 */
export function sketchTitle(domain: string): string {
  return `${domain} · 一般流程参考图（${SKETCH_MARK}）`;
}

/**
 * 文件名里禁用的字符。与 `onto/export.ts` 的 `safeName` 同一条规则。
 *
 * 没有直接复用那个函数：它是「任意标题 → 文件名」的通用清洗，而这里的名字是
 * **固定形状**的（标注词是常量，只有域名是自由输入）—— 标注必须逐字出现在文件名里，
 * 这件事不能交给一个会截断、会回退到「导出」的通用函数。
 */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f\u0020]/g;

/** 产物文件名（第二处标注）。`ext` 不带点。 */
export function sketchFileName(domain: string, ext: string): string {
  // 先 trim 再替换，替换完再削掉首尾的 `_` —— 顺序反了的话「   」会清成 `___`
  // 而不是回退到「未命名」（trim 削不掉下划线）。
  // 域名按 code point 截断：中文域名按 UTF-16 切会切出半个字。
  const cleaned = domain.trim().replace(BAD_NAME, "_").replace(/^_+|_+$/g, "");
  const safe = [...cleaned].slice(0, 24).join("").replace(/_+$/g, "") || "未命名";
  return `通用参考流程图_模型知识_${safe}.${ext}`;
}

// ══════════════════════════════════════════════════════════════════
//  模型这一侧：schema 与 prompt
// ══════════════════════════════════════════════════════════════════

/** 详细程度。**只影响 prompt 里要的规模**，不影响校验 —— 模型给多给少都得是合法结构。 */
export const SketchDetail = {
  BRIEF: "brief",
  STANDARD: "standard",
  DETAILED: "detailed",
} as const;
export type SketchDetail = (typeof SketchDetail)[keyof typeof SketchDetail];

export const SKETCH_DETAILS: readonly string[] = Object.values(SketchDetail);

/** 各档位要的规模。写在一处，prompt 和回执都读它。 */
const DETAIL_SHAPE: Readonly<Record<SketchDetail, { stages: string; nodes: string }>> = {
  [SketchDetail.BRIEF]: { stages: "2–3", nodes: "6–10" },
  [SketchDetail.STANDARD]: { stages: "3–5", nodes: "12–20" },
  [SketchDetail.DETAILED]: { stages: "5–7", nodes: "22–34" },
};

export function parseSketchDetail(v: unknown): SketchDetail {
  const s = v === null || v === undefined ? "" : String(v).trim().toLowerCase();
  if (!s) return SketchDetail.STANDARD;
  for (const x of Object.values(SketchDetail)) if (x === s) return x;
  throw new SketchError(
    `详细程度只能是 ${SKETCH_DETAILS.join(" / ")}，收到「${s}」。不给就是 standard。`,
  );
}

/**
 * 结构化输出的 schema。
 *
 * 注意 `kind` 的 `enum` **不会被网关校验**（`kernel/llm.ts` 的
 * `validateAgainstSchema` 只查 type/required/items，不查 enum）—— 它写在这里是给
 * 模型看的约束，真正的把关在 {@link graphFromSketch}。两处都要有：schema 让模型
 * 一次就写对，校验保证写错时是一句人话而不是一个崩溃。
 */
export const SKETCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["stages", "nodes", "edges"],
  properties: {
    title: { type: "string", description: "这条流程的名字，如「一般采购流程」" },
    stages: {
      type: "array",
      description: "阶段（图上的泳道），按先后顺序",
      items: {
        type: "object",
        required: ["key", "title"],
        properties: {
          key: { type: "string", description: "短标识，节点用它挂到这个阶段，如 s1" },
          title: { type: "string", description: "阶段名，如「阶段一｜需求与计划」" },
          subtitle: { type: "string", description: "一句话说明，可省" },
        },
      },
    },
    nodes: {
      type: "array",
      description: "环节",
      items: {
        type: "object",
        required: ["key", "kind", "label", "stage"],
        properties: {
          key: { type: "string", description: "短标识，边用它引用，如 n1" },
          kind: {
            type: "string",
            enum: ["action", "event", "gateway", "terminal", "external"],
            description:
              "action=有人/系统要做的一件事；event=做完之后可观测的事实（名字用「已…」）；" +
              "gateway=分叉点，出边必须带条件；terminal=终态；external=外部平台/接口",
          },
          label: { type: "string", description: "环节名，中文，图上显示的就是它" },
          stage: { type: "string", description: "所属阶段的 key" },
          actor: { type: "string", description: "谁做这一步（角色，不是人名），action 才有意义" },
        },
      },
    },
    edges: {
      type: "array",
      description: "顺序。分叉的出边一定要写条件",
      items: {
        type: "object",
        required: ["from", "to"],
        properties: {
          from: { type: "string", description: "起点节点的 key" },
          to: { type: "string", description: "终点节点的 key" },
          label: { type: "string", description: "条件，如「通过」「驳回」；顺流可省" },
        },
      },
    },
    caveats: {
      type: "array",
      items: { type: "string" },
      description: "这个域里各家做法差别最大的几点 —— 正是要拿去问业务方的地方",
    },
  },
};

/** 系统提示。**明说这是通识不是证据**，免得模型在 caveats 里编出「据贵司资料」。 */
export const SKETCH_SYSTEM =
  "你是一位业务流程分析师。用户还没有提供任何材料，要你凭**行业通识**画一张" +
  "该领域「一般来说长什么样」的参考流程。\n" +
  "**你手上没有任何客户材料，不许假装有。** 不要写「根据贵司现状」「材料显示」" +
  "这类话，也不要编造具体的系统名、单号规则、部门名。说不准的地方写进 caveats，" +
  "那正是接下来要问业务方的问题。";

export function sketchPrompt(o: { domain: string; detail: SketchDetail }): string {
  const shape = DETAIL_SHAPE[o.detail];
  return [
    `领域/主题：${o.domain}`,
    "",
    `画出这个领域里**通行的**业务流程，按 ${shape.stages} 个阶段分泳道，` +
      `一共 ${shape.nodes} 个环节。`,
    "",
    "几条硬要求：",
    "1. Action 和 Event 是**两种**节点，不许合并。「提交申请」是 action，" +
      "「申请已提交」是 event —— 前者是有人要做的事，后者是做完之后别人能观测到的事实。" +
      "关键动作后面要跟它产出的事实。",
    "2. 有分叉的地方放一个 gateway，它的每条出边都要写条件（如「通过」「驳回」）。" +
      "驳回一类的回退边要连回它该回到的那个环节，不要留死路。",
    "3. 只用这个领域里**通用**的说法。不要编具体的系统名、单据编号规则、部门全称。",
    "4. 每个 node 的 stage 必须是上面 stages 里出现过的 key；每条 edge 的 from/to" +
      "必须是上面 nodes 里出现过的 key。",
    "5. caveats 里写 3–5 条：这个领域里各家做法差别最大的地方（谁审批、卡在哪个环节、" +
      "有没有某个步骤）。这些是接下来要问业务方的。",
  ].join("\n");
}

// ══════════════════════════════════════════════════════════════════
//  结构 → FlowGraph
// ══════════════════════════════════════════════════════════════════

/**
 * 模型给的结构不合用。
 *
 * 单独一个类型是为了让调用方能把它和「模型没调通」「盘写不进去」分开 —— 三者
 * 对应三种完全不同的下一步（重说一遍 / 等一会儿再试 / 去看磁盘），混成一条
 * 「生成失败」等于把排查方向交给运气。
 */
export class SketchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SketchError";
    Object.setPrototypeOf(this, SketchError.prototype);
  }
}

/** 一张参考图最多允许多少个节点。 */
const NODE_CAP = 80;
/** 最多多少条泳道。 */
const STAGE_CAP = 12;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取一个**非空**字符串字段；不是字符串或空串都算缺。 */
function field(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : "";
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

const KINDS = new Set<string>(Object.values(NodeKind));

/**
 * 把模型给的结构变成一张 `FlowGraph`。
 *
 * 校验是**逐条报**的：模型看到「n3 的 stage 是 s9，而 stages 里只有 s1/s2」能改对，
 * 看到「结构不合法」只会原样再给一遍。这里每一条错误消息都是写给模型看的自纠信号，
 * 顺带也是写给人看的 —— 用户会在聊天里看到它。
 */
export function graphFromSketch(data: unknown, opts: { domain: string }): FlowGraph {
  if (!isRecord(data)) {
    throw new SketchError(`模型没给出结构（拿到的是 ${typeName(data)}）。让它按 schema 重出一遍。`);
  }

  // ── 泳道 ──────────────────────────────────────────────────
  const rawStages = data["stages"];
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    throw new SketchError("stages 是空的：流程图至少要有一个阶段（泳道）。");
  }
  if (rawStages.length > STAGE_CAP) {
    throw new SketchError(`stages 有 ${rawStages.length} 个，太多了（最多 ${STAGE_CAP} 个）。`);
  }
  const g = new FlowGraph();
  const stageKeys = new Set<string>();
  rawStages.forEach((raw, i) => {
    if (!isRecord(raw)) throw new SketchError(`stages[${i}] 不是对象。`);
    const key = field(raw, "key");
    const title = field(raw, "title");
    if (!key) throw new SketchError(`stages[${i}] 缺 key（节点要靠它挂到这条泳道上）。`);
    if (!title) throw new SketchError(`stages[${i}]（key=${key}）缺 title。`);
    if (stageKeys.has(key)) throw new SketchError(`阶段 key「${key}」重复了。`);
    stageKeys.add(key);
    g.stages.set(key, makeStage({ key, title, subtitle: field(raw, "subtitle"), order: i }));
  });

  // ── 节点 ──────────────────────────────────────────────────
  const rawNodes = data["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new SketchError("nodes 是空的：一张没有环节的流程图没有意义。");
  }
  if (rawNodes.length > NODE_CAP) {
    throw new SketchError(
      `nodes 有 ${rawNodes.length} 个，超过上限 ${NODE_CAP}。参考图是拿去开会讨论的，` +
        "环节太多反而没人看得完 —— 用 detail=\"standard\" 重出一版。",
    );
  }
  const ridOf = new Map<string, string>(); // 模型给的 key → 图里的 rid
  rawNodes.forEach((raw, i) => {
    if (!isRecord(raw)) throw new SketchError(`nodes[${i}] 不是对象。`);
    const key = field(raw, "key");
    const label = field(raw, "label");
    const kind = field(raw, "kind").toLowerCase();
    const stage = field(raw, "stage");
    if (!key) throw new SketchError(`nodes[${i}] 缺 key（边要靠它引用这个节点）。`);
    if (ridOf.has(key)) throw new SketchError(`节点 key「${key}」重复了。`);
    if (!label) throw new SketchError(`节点「${key}」缺 label（图上显示的就是它）。`);
    if (!KINDS.has(kind)) {
      throw new SketchError(
        `节点「${key}」的 kind 是「${kind || "空"}」，只能是 ${[...KINDS].join(" / ")}。`,
      );
    }
    if (!stageKeys.has(stage)) {
      throw new SketchError(
        `节点「${key}」的 stage 是「${stage || "空"}」，而 stages 里只有 ` +
          `${[...stageKeys].join(" / ")}。`,
      );
    }
    // rid 里带序号：模型给的 key 不保证经得起 slug（"n1" 和 "N1" 会撞成同一个），
    // 而两个节点撞 rid 的症状是图上少一个框、边还连得好好的。
    const nodeRid = makeRid("fn", `sk${i}-${label}`);
    ridOf.set(key, nodeRid);
    g.addNode(
      makeFlowNode({
        rid: nodeRid,
        kind: kind as NodeKind,
        // 一律 inferred + 零 evidence：这张图**没有**出处，标成别的就是伪造溯源。
        // 附带效果是 to_svg 把每个框都画成虚线 —— 见文件头第 3 条。
        label: inferred(label),
        stage,
        actor: inferred(field(raw, "actor")),
        // code 留空 → addNode 交给 codeFor() 按规则生成。**不让模型编号**：
        // 模型每次生成都会漂一点，而漂了的编号让两版图之间没法做 diff。
      }),
    );
  });

  // ── 边 ────────────────────────────────────────────────────
  const rawEdges = data["edges"];
  if (!Array.isArray(rawEdges) || rawEdges.length === 0) {
    throw new SketchError("edges 是空的：只给了环节没给顺序，那不是流程图。");
  }
  rawEdges.forEach((raw, i) => {
    if (!isRecord(raw)) throw new SketchError(`edges[${i}] 不是对象。`);
    const from = field(raw, "from");
    const to = field(raw, "to");
    const src = ridOf.get(from);
    const dst = ridOf.get(to);
    if (src === undefined) {
      throw new SketchError(`edges[${i}] 的 from 是「${from || "空"}」，nodes 里没有这个 key。`);
    }
    if (dst === undefined) {
      throw new SketchError(`edges[${i}] 的 to 是「${to || "空"}」，nodes 里没有这个 key。`);
    }
    // **每条边都是 INFERRED**，不管模型说它是什么。理由和节点一样：这张图整体
    // 没有出处，让模型自称某条边是"抽出来的"就是伪造溯源。附带效果是 SVG 抬头的
    // 「N 条边为系统推断，需人工确认」会等于全部边数 —— 那句话在这里字面属实。
    g.connect(src, dst, { kind: EdgeKind.INFERRED, label: field(raw, "label") });
  });

  // 域名进不了图的数据结构（FlowGraph 没有这个字段），它由调用方拼进标题和文件名。
  // 这里只做一次最后的完整性检查：孤立节点意味着模型漏了边。
  const orphans = g.dangling();
  if (orphans.length > 0) {
    throw new SketchError(
      `这些环节没有任何连线：${orphans.map((n) => n.label.value).join("、")}。` +
        `${opts.domain}的流程要连起来才看得懂 —— 给它们补上前后顺序。`,
    );
  }
  return g;
}

/** 模型给的 caveats（要拿去问业务方的差异点）。缺了就是空数组，不算错。 */
export function sketchCaveats(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const raw = data["caveats"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}
