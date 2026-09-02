/**
 * 4A 架构投影：业务（A1）/ 应用（A2）/ 数据（A3）/ 技术（A4）。
 *
 * **是投影，不是新标签。** 层归属由「这条记录落在哪个桶」确定性推出 ——
 * 流程/阶段/角色 → A1，接口/系统 → A2，对象/属性/关系 → A3，平台/数据库/API 绑定 → A4。
 * 给实体加一个 `layer` 字段会让同一个事实有两个真相源，改一处忘一处就开始撒谎。
 * 零模型调用、零 schema 变更。
 *
 * ## 为什么这份投影必须诚实到这个程度
 *
 * 真库把三层的实情摆得很清楚（2026-08-26 实测三个会话）：
 *  · **A1 有实料**：flow 节点 31–64；
 *  · **A2 表面全空**：`sourceEndpoint` 三个会话都是 0/N —— 但内容并没有消失，
 *    它躲在对象**描述的散文**里：fc58b72e91bd 有 311 个对象的 description 提到
 *    SAP / 接口 / 集成，客户甚至交来了《采购领域应用架构清单》。
 *    所以这一层要报的不是「没有」，而是**「有料但没有容器」**，并说清下一步；
 *  · **A3 有实料**：对象 32–926；
 *  · **A4 真的空**：客户材料里就没有基础设施内容。空要**显式判空** ——
 *    留白会被读成「系统正在建，等等就有」，而实际上等不来。
 *
 * 一层「看起来空」有两种完全不同的成因：**没料**（去要材料）与**有料没接住**
 * （去修管线）。把这两种混成同一个空白，是这份投影最该避免的事。
 */

import type { FlowGraph } from "./flow.js";
import type { OIR } from "./oir.js";

export type FourALayerId = "A1" | "A2" | "A3" | "A4";

/** 这一层建到什么程度。空 / 只有零星线索 / 有骨架缺细节 / 立得住。 */
export type FourACoverage = "none" | "thin" | "partial" | "solid";

export interface FourAItem {
  /** 展示名。 */
  readonly label: string;
  /** 这条属于本层的哪一类（流程环节 / 数据对象 / 带接口的动作 …）。 */
  readonly kind: string;
}

export interface FourALayer {
  readonly id: FourALayerId;
  readonly name: string;
  /** 这一层回答什么问题 —— 写在文档里，客户才知道该看什么。 */
  readonly question: string;
  readonly items: FourAItem[];
  readonly counts: Record<string, number>;
  readonly coverage: FourACoverage;
  /** 缺什么。 */
  readonly missing: string[];
  /** 找谁要。 */
  readonly askWho: string;
  /** 观察到的事实（例如「N 个对象的描述里提到系统/接口，但模型里没有容器」）。 */
  readonly notes: string[];
}

export interface FourAMatrix {
  readonly columns: string[];
  readonly rows: string[][];
}

export interface FourAView {
  readonly layers: FourALayer[];
  readonly matrix: FourAMatrix;
}

/** 一行最多列几个承载物 —— 这是给人看的文档，不是全量导出。 */
const ITEM_CAP = 40;
/** 对齐矩阵最多多少行（真库有 64 个流程节点，够用）。 */
const MATRIX_CAP = 200;

/**
 * 描述里提到应用系统/接口的线索词。
 *
 * **只用来数、不用来判定**：命中不等于「这是一个系统」，只说明这一层的原料确实
 * 在材料里出现过、只是没有容器接住。判定要等 System/Integration 成为一等容器。
 */
const SYSTEM_HINT = /SAP|SRM|ERP|FIS|MES|WMS|OA|接口|集成|事务码|中间件|系统/u;

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["value"] ?? "");
  }
  return String(v);
}

function coverageOf(n: number, thin = 3, partial = 12): FourACoverage {
  if (n <= 0) return "none";
  if (n < thin) return "thin";
  if (n < partial) return "partial";
  return "solid";
}

/** 业务架构：价值流与业务流程 —— 从流程图与角色来。 */
function businessLayer(flow: FlowGraph | null): FourALayer {
  const nodes = flow === null ? [] : [...flow.nodes.values()];
  const stages = flow === null ? [] : [...flow.stages.values()];
  const workflows = flow === null ? [] : [...flow.workflows.values()];
  const actors = new Set<string>();
  for (const n of nodes) {
    const a = text((n as unknown as Record<string, unknown>)["actor"]).trim();
    if (a) actors.add(a);
  }
  const counts = {
    流程环节: nodes.length,
    阶段: stages.length,
    工作流: workflows.length,
    执行角色: actors.size,
  };
  const missing: string[] = [];
  if (nodes.length === 0) missing.push("还没有业务流程 —— 这一层是其余三层的骨架，先把它立起来");
  if (nodes.length > 0 && actors.size === 0) missing.push("每个环节由谁执行（岗位，不是人名）");
  if (workflows.length === 0 && nodes.length > 0) missing.push("端到端的价值流：从哪个事件起、到哪个结果止");
  return {
    id: "A1",
    name: "业务架构",
    question: "业务是怎么跑的：有哪些环节、谁在做、按什么顺序、目标是什么",
    items: nodes.slice(0, ITEM_CAP).map((n) => ({
      label: text((n as unknown as Record<string, unknown>)["label"]),
      kind: "流程环节",
    })),
    counts,
    coverage: coverageOf(nodes.length),
    missing,
    askWho: "业务流程负责人 / 各环节执行岗位",
    notes: nodes.length === 0
      ? ["还没有流程图。可以先画一张通用参考图与业务方核对，再用回传件替换成贵司实际。"]
      : [],
  };
}

/** 应用架构：业务由哪些系统承载、系统之间怎么集成。 */
function applicationLayer(oir: OIR): FourALayer {
  const actions = [...oir.actions.values()];
  const withEndpoint = actions.filter((a) => {
    const ep = (a as unknown as Record<string, unknown>)["sourceEndpoint"];
    const v = ep !== null && typeof ep === "object" ? (ep as Record<string, unknown>)["value"] : null;
    return v !== null && v !== undefined;
  });
  const objects = [...oir.objects.values()];
  // 原料在不在？—— 数描述里提到系统/接口的对象。**只数不判**，见 SYSTEM_HINT。
  const hinted = objects.filter((o) =>
    SYSTEM_HINT.test(text((o as unknown as Record<string, unknown>)["description"])));
  const counts = { 带接口的动作: withEndpoint.length, 动作总数: actions.length };
  const items: FourAItem[] = withEndpoint.slice(0, ITEM_CAP).map((a) => {
    const ep = (a as unknown as Record<string, unknown>)["sourceEndpoint"] as Record<string, unknown>;
    const v = (ep["value"] ?? {}) as Record<string, unknown>;
    // ActionType 没有 displayName（见 oir.ts 的 makeActionType）—— 读 apiName，
    // 读错字段的代价是标签一律空白，而那要等接口真的有数据了才看得出来。
    const name = text((a as unknown as Record<string, unknown>)["apiName"])
      || String(v["display"] ?? "");
    return { label: `${name} · ${String(v["path"] ?? "")}`, kind: "接口" };
  });
  const notes: string[] = [];
  const missing: string[] = [];
  if (withEndpoint.length === 0 && hinted.length > 0) {
    // **有料没容器**：这是最要说清的一种「空」。
    notes.push(
      `有 ${hinted.length} 个数据对象的描述里提到了系统/接口/集成（如 SAP、SRM、事务码），` +
      "但模型里还没有「应用系统」与「系统间集成」的容器，这些信息只能散在描述文字里 —— " +
      "所以这一层看起来空，实际是**有料没接住**，不是没料。",
    );
    missing.push("应用系统清单：每个系统的产品、版本、模块、归口部门");
    missing.push("系统间集成清单：接口编码、源系统、目标系统、方向、传输内容");
  } else if (withEndpoint.length === 0) {
    notes.push("材料里还没有出现系统或接口信息。");
    missing.push("业务由哪些系统承载：系统清单与各自负责的业务范围");
  }
  if (withEndpoint.length > 0) {
    missing.push("每个接口的源/目标系统与传输方向（现在只有接口标识）");
  }
  return {
    id: "A2",
    name: "应用架构",
    question: "这些业务由哪些系统承载、系统之间怎么传数据",
    items,
    counts,
    coverage: withEndpoint.length > 0
      ? coverageOf(withEndpoint.length)
      : (hinted.length > 0 ? "thin" : "none"),
    missing,
    askWho: "IT 应用负责人 / 各业务系统的系统管理员",
    notes,
  };
}

/** 数据架构：企业的数据资源怎么组织、谁是事实来源。 */
function dataLayer(oir: OIR): FourALayer {
  const objects = [...oir.objects.values()];
  const props = [...oir.properties.values()];
  const links = [...oir.links.values()];
  const withPk = objects.filter((o) =>
    (text((o as unknown as Record<string, unknown>)["primaryKey"]) !== ""
      || ((o as unknown as Record<string, unknown>)["primaryKey"] as { value?: unknown[] } | undefined)
        ?.value?.length),
  );
  const counts = {
    数据对象: objects.length,
    字段: props.length,
    对象关系: links.length,
    有主键的对象: withPk.length,
  };
  const missing: string[] = [];
  if (objects.length === 0) missing.push("还没有数据对象");
  if (objects.length > 0 && withPk.length < objects.length) {
    missing.push(`业务主键：${objects.length - withPk.length} 个对象还说不出「哪一列能唯一定位一行」`);
  }
  if (objects.length > 0 && links.length === 0) missing.push("对象之间的关系（谁引用谁、一对多还是多对多）");
  missing.push("每个对象的事实来源系统（system of record）—— 同一份数据在多个系统里时以谁为准");
  return {
    id: "A3",
    name: "数据架构",
    question: "有哪些数据对象、字段口径是什么、以哪个系统为准",
    items: objects.slice(0, ITEM_CAP).map((o) => ({
      label: text((o as unknown as Record<string, unknown>)["displayName"]),
      kind: "数据对象",
    })),
    counts,
    coverage: coverageOf(objects.length),
    missing,
    askWho: "数据负责人 / 主数据管理岗",
    notes: [],
  };
}

/**
 * 技术架构：跑在什么上面。
 *
 * 真库里这一层是空的，而且**空得合理** —— 客户交来的是业务材料，里面就没有
 * 机房、中间件、部署拓扑。所以这里不去猜，只把「空」说明白，并列出要问什么。
 */
function technologyLayer(oir: OIR): FourALayer {
  const actions = [...oir.actions.values()];
  const platformish = actions.filter((a) => {
    const ep = (a as unknown as Record<string, unknown>)["sourceEndpoint"];
    const v = ep !== null && typeof ep === "object" ? (ep as Record<string, unknown>)["value"] : null;
    if (v === null || v === undefined || typeof v !== "object") return false;
    const r = v as Record<string, unknown>;
    return Boolean(r["platform"] ?? r["database"] ?? r["provider"]);
  });
  const counts = { 技术组件: platformish.length };
  return {
    id: "A4",
    name: "技术架构",
    question: "这些系统跑在什么上面：部署形态、数据库、中间件、集成通道",
    items: platformish.slice(0, ITEM_CAP).map((a) => ({
      label: text((a as unknown as Record<string, unknown>)["apiName"]),
      kind: "技术组件",
    })),
    counts,
    coverage: coverageOf(platformish.length),
    missing: [
      "各系统的部署形态（本地机房 / 私有云 / SaaS）与版本",
      "数据库与中间件：用什么、谁运维",
      "系统间的集成通道（消息队列 / 文件交换 / 直连接口）与时效要求",
      "非功能要求：可用性、容灾、数据保留期限",
    ],
    askWho: "IT 基础设施 / 运维负责人",
    notes: platformish.length === 0
      ? [
        "**这一层是空的，而且空得合理**：目前的材料都是业务口径文档，里面本来就没有" +
        "基础设施内容。要建这一层，需要另外要一批材料（见下方「缺什么」），" +
        "**不要让模型凭通识补** —— 编出来的机房拓扑没人能验证。",
      ]
      : [],
  };
}

/**
 * 对齐矩阵：一行一个流程环节，横着看它连着哪些数据对象、哪个系统、哪个技术组件。
 *
 * 这张表是 4A 的「结合」处 —— 四层各自成章只是四份清单，
 * 只有把它们按同一条业务链路对齐，才看得出哪一环没有系统承载、哪一环没有数据支撑。
 * 连不上的格子一律写「未…」，**不留空** —— 空格会被读成「这里不用填」。
 */
function alignmentMatrix(oir: OIR, flow: FlowGraph | null): FourAMatrix {
  const columns = ["流程环节", "执行角色", "数据对象", "应用系统", "技术组件"];
  if (flow === null) return { columns, rows: [] };
  const objectName = new Map<string, string>();
  for (const o of oir.objects.values()) {
    const r = o as unknown as Record<string, unknown>;
    objectName.set(String(r["rid"] ?? ""), text(r["displayName"]));
  }
  const rows: string[][] = [];
  for (const n of [...flow.nodes.values()].slice(0, MATRIX_CAP)) {
    const r = n as unknown as Record<string, unknown>;
    const bound = (Array.isArray(r["objects"]) ? (r["objects"] as unknown[]) : [])
      .map((rid) => objectName.get(String(rid)) ?? String(rid))
      .filter(Boolean);
    const endpoint = text(r["endpoint"]).trim();
    rows.push([
      text(r["label"]),
      text(r["actor"]).trim() || "未指定角色",
      bound.length > 0 ? bound.join("、") : "未绑定对象",
      endpoint || "未接入系统",
      "未采集",
    ]);
  }
  return { columns, rows };
}

/** 把 OIR 与流程图投影成四层 + 一张对齐矩阵。纯函数，零模型调用。 */
export function projectFourA(oir: OIR, flow: FlowGraph | null): FourAView {
  return {
    layers: [
      businessLayer(flow),
      applicationLayer(oir),
      dataLayer(oir),
      technologyLayer(oir),
    ],
    matrix: alignmentMatrix(oir, flow),
  };
}
