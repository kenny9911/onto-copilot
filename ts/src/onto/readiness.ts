/**
 * 材料就绪度评估 —— 回答三个问题：**够不够、差哪块、去问谁**。
 *
 * 位置在 gaps.ts 之前：gaps 在抽取**之后**挖"材料没说清的地方"，而这里在抽取
 * **之前**判"材料有没有说到"。两者不重叠 —— readiness 说"流程文档整个缺失"，
 * gaps 说"流程文档第 4 页的阈值没定"。
 *
 * **判据全部可规则化，零模型调用**（ADR-5）。六个维度的信号来自两处：
 *   1. 解析器打好的语义标签（table/column/fk/endpoint+write/bpmn —— 见 parse/*）；
 *   2. 正文切片上的确定性正则（动词句、阈值句、流程词）。
 * LLM 在这条链上只配做最后一步 —— 把补料清单的措辞写得像人话，而那一步由
 * 对话模型在转述时自然完成，不需要额外调用。
 */

export interface ReadinessDimension {
  readonly key: "objects" | "attributes" | "links" | "actions" | "flow" | "rules";
  readonly label: string;
  /** 0 = 没有信号；1 = 只有正文提及（弱）；2 = 有专用来源（强）。 */
  readonly score: 0 | 1 | 2;
  /** 人读的信号清单，如「DDL 里 12 张表」。空数组 = 什么都没找到。 */
  readonly signals: readonly string[];
  /** score < 2 时：该补什么。 */
  readonly missing: string;
  /** 找谁要。 */
  readonly askWho: string;
}

export interface ReadinessReport {
  readonly verdict: "READY" | "PARTIAL" | "NOT_ENOUGH";
  readonly dimensions: readonly ReadinessDimension[];
  /** 可以先抽的维度（score ≥ 1）。PARTIAL 时告诉用户"能先干什么"。 */
  readonly extractableNow: readonly string[];
  /** 按角色分组的补料清单。 */
  readonly supplements: readonly { readonly role: string; readonly items: readonly string[] }[];
}

interface ChunkLike {
  readonly text?: unknown;
  readonly tags?: unknown;
}

type ChunkMap = Readonly<Record<string, readonly ChunkLike[]>>;

function textOf(c: ChunkLike): string {
  const v = c.text;
  return typeof v === "string" ? v : "";
}

function tagsOf(c: ChunkLike): readonly string[] {
  return Array.isArray(c.tags) ? c.tags.map(String) : [];
}

/** 动词句：一句话里带着"谁对什么做了什么"。Action 的正文信号。 */
const VERB_RE = /(?:提交|审批|批准|驳回|退回|创建|发起|生成|录入|上传|冲销|付款|打款|核销|验收|签收|作废|撤回|复核|稽核)/u;
/** 阈值/条件句：Rule 的正文信号。与 gaps.undeterminedSlots 同一族判式。 */
const RULE_RE = /(?:超过|大于|小于|不得|必须|不能|禁止|上限|下限|阈值|需要?.{0,6}(?:审批|加签|复核)|[0-9０-９]+\s*(?:元|万|天|日|%|个工作日))/u;
/** 流程词：Flow 的正文信号。 */
const FLOW_RE = /(?:流程|审批流|流转|环节|节点|下一步|转交|移交|上一环|泳道|会签)/u;
/** 关系词：Link 的正文信号。 */
const LINK_RE = /(?:外键|关联|一对多|多对一|多对多|一对一|主键.{0,8}引用|对应关系)/u;

/**
 * 主入口。`files` 只要名字（判断有没有传料）；信号全部从 chunks 来 ——
 * 没解析的文件没有切片，也就不产生信号，这是**对的**：没读进来的材料等于没有。
 */
export function assessReadiness(
  files: readonly { readonly name: string }[],
  chunks: ChunkMap,
): ReadinessReport {
  const all: { file: string; chunk: ChunkLike }[] = [];
  for (const [file, list] of Object.entries(chunks)) {
    for (const chunk of list) all.push({ file, chunk });
  }
  const byTag = (tag: string): number => all.filter((x) => tagsOf(x.chunk).includes(tag)).length;
  const filesWithTag = (tag: string): string[] =>
    [...new Set(all.filter((x) => tagsOf(x.chunk).includes(tag)).map((x) => x.file))];
  // 正文 = 没有结构化标签的切片。**判据是"不带结构标签"，不是"零标签"** ——
  // 上一版只认零标签或 heading，而 OCR 出来的切片全带 ['ocr','title'/'paragraph'/
  // 'note']，于是**整份图片的文字被排除在所有正文信号之外**：用户传一张写满
  // 「采购需求计划流程」的流程图，六个维度全判「没有」，被指去画通用模板图。
  // 图片 OCR 的正文就是正文 —— 它只该是弱信号（score 1），但不能是零信号。
  const STRUCTURAL = new Set(["schema", "table", "column", "fk", "link", "row", "write", "endpoint", "bpmn"]);
  const proseHits = (re: RegExp): number =>
    all.filter((x) => !tagsOf(x.chunk).some((t) => STRUCTURAL.has(t)))
      .filter((x) => re.test(textOf(x.chunk))).length;

  const dim = (
    key: ReadinessDimension["key"],
    label: string,
    strong: readonly [number, string][],
    weak: readonly [number, string][],
    missing: string,
    askWho: string,
  ): ReadinessDimension => {
    const signals: string[] = [];
    let score: 0 | 1 | 2 = 0;
    for (const [n, tpl] of strong) {
      if (n > 0) {
        signals.push(tpl.replace("{n}", String(n)));
        score = 2;
      }
    }
    if (score < 2) {
      for (const [n, tpl] of weak) {
        if (n > 0) {
          signals.push(tpl.replace("{n}", String(n)));
          score = 1;
        }
      }
    }
    return { key, label, score, signals, missing: score === 2 ? "" : missing, askWho };
  };

  const schemaTables = byTag("schema") + byTag("table");
  const dimensions: ReadinessDimension[] = [
    dim("objects", "数据对象",
      [[schemaTables, "结构化表 {n} 处（DDL/实体表/文档表格）"]],
      [[byTag("row"), "数据行切片 {n} 条"]],
      "实体清单或建库 DDL —— 至少要一份「有哪些业务对象」的表",
      "数据负责人 / IT"),
    dim("attributes", "属性与口径",
      [[byTag("column"), "列定义 {n} 条"]],
      [[byTag("row"), "可从数据行反推列（无口径说明）"]],
      "字段口径表：字段名、类型、必填、含义 —— 没有口径的属性只能靠猜",
      "数据负责人"),
    dim("links", "对象关系",
      [[byTag("fk") + byTag("link"), "外键/关系声明 {n} 条"]],
      [[proseHits(LINK_RE), "正文提到关系 {n} 处"]],
      "对象间关系（谁挂在谁下面、一对多还是多对多、用什么键连接）",
      "数据负责人 / IT"),
    dim("actions", "Action（操作）",
      [[filesWithTag("write").length > 0 ? byTag("write") : 0, "OpenAPI 写端点 {n} 个"]],
      [[proseHits(VERB_RE), "正文动词句 {n} 处"]],
      "操作清单或 OpenAPI：谁能对对象做什么（提交/审批/作废…），最好带接口定义",
      "IT / 流程负责人"),
    dim("flow", "业务流程",
      [[byTag("bpmn") + byTag("process"), "BPMN/流程定义 {n} 处"]],
      [[proseHits(FLOW_RE), "正文流程描述 {n} 处"]],
      "流程文档：环节顺序、分支条件、各环节负责人 —— 制度文件或流程图都行",
      "流程负责人"),
    dim("rules", "业务规则",
      [[0, ""]],
      [[proseHits(RULE_RE), "阈值/条件句 {n} 处"]],
      "规则与阈值：金额上限、审批层级、时限 —— 通常在管理制度里",
      "财务 / 流程负责人"),
  ];

  const scored = dimensions.filter((d) => d.score >= 1).length;
  const verdict: ReadinessReport["verdict"] =
    files.length === 0 || all.length === 0
      ? "NOT_ENOUGH"
      : dimensions.every((d) => d.score >= 1)
        ? "READY"
        : scored >= 2
          ? "PARTIAL"
          : "NOT_ENOUGH";

  const byRole = new Map<string, string[]>();
  for (const d of dimensions) {
    if (d.score === 2) continue;
    const prefix = d.score === 0 ? "【必补】" : "【最好补】";
    const list = byRole.get(d.askWho) ?? [];
    list.push(`${prefix}${d.label}：${d.missing}`);
    byRole.set(d.askWho, list);
  }

  return {
    verdict,
    dimensions,
    extractableNow: dimensions.filter((d) => d.score >= 1).map((d) => d.label),
    supplements: [...byRole.entries()].map(([role, items]) => ({ role, items })),
  };
}
