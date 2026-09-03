/**
 * 面向用户的中文文案投影。
 *
 * Question 的权威文本有时为了兼容字符串 schema，会把路由信息紧凑编码成：
 *
 *   [高][ERP顾问][blocked:sys.erp] 请确认版本 | answer:TEXT | evidence:doc#p1
 *
 * 这份编码对机器有用，但不能直接端给业务人员。本模块只生成显示文案，绝不改写
 * Question Ledger / OIR 中保存的原文，因此回答、回放和审计仍使用稳定 ID 与原始值。
 */

export interface PlainQuestionCopy {
  readonly text: string;
  readonly priority: string;
  readonly audienceRole: string;
  readonly blockedArtifact: string;
  readonly answerFormat: string;
  readonly evidenceRef: string;
  readonly hadMachineMarkup: boolean;
}

const PRIORITIES: Readonly<Record<string, string>> = Object.freeze({
  "高": "high",
  high: "high",
  blocking: "blocking",
  "阻塞": "blocking",
  "中": "normal",
  normal: "normal",
  medium: "normal",
  "普通": "normal",
  "低": "low",
  low: "low",
});

const DOMAIN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  INTAKE: "材料范围",
  PROCESS: "业务流程",
  ERP_MAP: "系统信息",
  RULES: "业务规则",
  DATA_OBJECTS: "业务对象",
  GAP: "缺失信息",
  INTERVIEW: "业务访谈",
  CANONICALIZE: "名称和口径",
  REVIEW: "交付检查",
  EXPORT: "交付文件",
});

function clean(value: unknown): string {
  return String(value ?? "").trim().replace(/[\t ]+/gu, " ");
}

function roleTag(tag: string): boolean {
  return /^(?:FDE|ERP顾问|业务顾问|业务方|业务部门|业务负责人|流程负责人|数据负责人|系统负责人|财务(?:负责人)?|法务(?:负责人)?|财务\/法务|交付工程师)$/iu.test(tag)
    || /(?:顾问|负责人|工程师)$/u.test(tag);
}

function technicalTag(tag: string): boolean {
  return /^(?:blocked|answer|expected|evidence|format)\s*[:：]/iu.test(tag)
    || /^(?:q|rule|fn|sys|obj|act|evt|event|wf|flow|proc|req)[._:-].+$/iu.test(tag);
}

function assignTag(copy: {
  priority: string;
  audienceRole: string;
  blockedArtifact: string;
  answerFormat: string;
  evidenceRef: string;
}, rawTag: string): boolean {
  const tag = clean(rawTag);
  const priority = PRIORITIES[tag.toLowerCase()] ?? PRIORITIES[tag];
  if (priority) {
    copy.priority = priority;
    return true;
  }
  if (roleTag(tag)) {
    copy.audienceRole = tag;
    return true;
  }
  const field = tag.match(/^(blocked|answer|expected|format|evidence)\s*[:：]\s*(.*)$/iu);
  if (field) {
    const key = field[1]!.toLowerCase();
    const value = clean(field[2]);
    if (key === "blocked") copy.blockedArtifact = value;
    else if (key === "evidence") copy.evidenceRef = value;
    else copy.answerFormat = value;
    return true;
  }
  return technicalTag(tag);
}

/**
 * 拆掉 Question 字符串中的机器路由外壳，只留下业务人员真正需要回答的问题。
 * 未识别的方括号会原样保留，避免把「[供应商]是否……」一类业务正文误删。
 */
export function plainQuestionCopy(value: unknown): PlainQuestionCopy {
  const raw = clean(value);
  const mutable = {
    priority: "",
    audienceRole: "",
    blockedArtifact: "",
    answerFormat: "",
    evidenceRef: "",
  };
  let rest = raw;
  const visibleTags: string[] = [];
  let hadMachineMarkup = false;
  for (let i = 0; i < 12; i += 1) {
    const match = rest.match(/^\[([^\]\r\n]{1,180})\]\s*/u);
    if (!match) break;
    const tag = match[1]!;
    if (assignTag(mutable, tag)) hadMachineMarkup = true;
    else visibleTags.push(`[${tag}]`);
    rest = rest.slice(match[0].length);
  }

  const visibleParts: string[] = [];
  for (const part of rest.split(/\s*\|\s*/u)) {
    const field = part.match(/^(blocked|answer|expected|format|evidence)\s*[:：]\s*(.*)$/iu);
    if (field) {
      assignTag(mutable, `${field[1]}:${field[2]}`);
      hadMachineMarkup = true;
    } else if (clean(part)) {
      visibleParts.push(clean(part));
    }
  }
  const text = clean(`${visibleTags.join("")} ${visibleParts.join(" | ")}`) || raw;
  return { text, ...mutable, hadMachineMarkup };
}

/** 只在确实检测到紧凑协议时清理；普通 Markdown 和业务方括号保持不动。 */
export function stripQuestionProtocolFromAnswer(value: unknown): string {
  return String(value ?? "").split("\n").map((line) => {
    const prefix = line.match(/^(\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*))/u)?.[1] ?? "";
    const body = line.slice(prefix.length);
    const copy = plainQuestionCopy(body);
    return copy.hadMachineMarkup ? `${prefix}${copy.text}` : line;
  }).join("\n");
}

/**
 * 清理确定性规则生成的卡片文案。
 *
 * 这不是改写器，只处理产品里已知的内部类型名、命名术语和 Markdown 标记；业务
 * 名称、数字与判断结论一律保留。适用于建议、冲突和选项等已经生成好的展示文本。
 */
function replaceInternalTerms(value: string): string {
  return value
    .replace(/^(?:ot|pt|lt|at|br|wf|fn|cf|q)[._:-][^\s:：]+\s*[:：]\s*/iu, "")
    .replace(/\bNon-Obvious\b/giu, "容易漏掉但会影响上线的")
    .replace(/\bintercompany\b/giu, "跨公司")
    .replace(/\bTransfer[ -]Pricing\b/giu, "内部交易定价")
    .replace(/\bNeed-by[ -]Date\b/giu, "最晚到货日")
    .replace(/\bLT\b/gu, "预计运输时间")
    .replace(/\blowerCamelCase\b/giu, "首字母小写的英文名称")
    .replace(/\bupperCamelCase\b|\bPascalCase\b/giu, "首字母大写的英文名称")
    .replace(/\bDataObject\b|\bObjectType\b/giu, "业务对象")
    .replace(/\bPropertyType\b/giu, "字段")
    .replace(/\bActionType\b/giu, "业务操作")
    .replace(/\bLinkType\b/giu, "对象关系")
    .replace(/\bSystem[_ ]Of[_ ]Record\b|\bSoR\b/giu, "以哪个系统为准")
    .replace(/\bapiName\b/giu, "系统名称")
    .replace(/\bOntology\b/giu, "业务模型")
    .replace(/\bsubject\b/giu, "关联对象")
    .replace(/\bblast(?:\s+radius)?\b/giu, "影响范围")
    .replace(/\bjoin[ _-]?key\b/giu, "关联字段")
    .replace(/\bpayload\b/giu, "传输内容")
    .replace(/\bcardinality\b/giu, "对应数量关系")
    .replace(/\bpreconditions?\b/giu, "执行条件")
    .replace(/\beffects?\b/giu, "执行结果")
    .replace(/\bRACI\b/gu, "职责分工")
    .replace(/\bFDE\b/gu, "交付工程师")
    .replace(/本体/gu, "业务模型")
    .replace(/物理现实割裂/gu, "实际执行与系统规则不一致")
    .replace(/异常长尾拦截失败/gu, "少见异常没有被系统拦住")
    .replace(/非显而易见维度/gu, "容易漏掉的方面")
    .replace(/深层阻碍/gu, "关键问题")
    .replace(/硬拦截/gu, "直接阻止")
    .replace(/软预警/gu, "只提醒、不阻止")
    .replace(/[\t ]+/gu, " ")
    .replace(/([\p{Script=Han}]) +(?=[\p{Script=Han}])/gu, "$1")
    .trim();
}

/**
 * 只改写解释性文字，材料原文、字段名和代码必须逐字保留。
 *
 * 最后的“说人话”处理发生在模型已经给出引用之后。若直接全局替换 `LT`、
 * `apiName` 等词，引用本身也会被改写，界面上看到的就不再是材料原文。这里先把
 * Markdown 代码、引用块、显式原文行、链接和引号内容封存，改写完再原样放回。
 */
function replaceOutsideVerbatim(value: string, replace: (text: string) => string): string {
  const protectedParts: string[] = [];
  const protect = (text: string): string => {
    const index = protectedParts.push(text) - 1;
    return `\uE000${index}\uE001`;
  };
  let editable = value;
  const patterns: readonly RegExp[] = [
    /```[^\r\n]*\r?\n[\s\S]*?```|~~~[^\r\n]*\r?\n[\s\S]*?~~~/gu,
    /^\s*>[^\r\n]*(?:\r?\n|$)/gmu,
    /^\s*(?:材料原文|原文|直接引用|引用内容|字段名|接口名|产品名)\s*[：:][^\r\n]*(?:\r?\n|$)/gmu,
    /`[^`\r\n]+`/gu,
    /\[[^\]\r\n]*\]\([^\s)]+(?:\s+"[^"]*")?\)/gu,
    /“[^”\r\n]*”|「[^」\r\n]*」|『[^』\r\n]*』|"(?:\\.|[^"\\\r\n])*"/gu,
  ];
  for (const pattern of patterns) editable = editable.replace(pattern, protect);
  let out = replace(editable);
  out = out.replace(/\uE000(\d+)\uE001/gu, (_match, rawIndex: string) => {
    return protectedParts[Number(rawIndex)] ?? "";
  });
  return out;
}

/**
 * 聊天回答只拆机器协议，不做术语级全文替换。
 *
 * “本体管理系统”、`apiName` 等完全可能是客户材料里的正式名称；即使没有引号，
 * 展示层也无权把它改成另一个词。自然表达交给回答提示词，确定性收尾只做不会改变
 * 业务含义的协议清理。
 */
export function plainConversationCopy(value: unknown): string {
  return stripQuestionProtocolFromAnswer(value);
}

/** 卡片按纯文本渲染，顺便移除会原样露出的 Markdown 加粗符号。 */
export function plainUserFacingCopy(value: unknown): string {
  return replaceOutsideVerbatim(
    stripQuestionProtocolFromAnswer(value),
    replaceInternalTerms,
  ).replace(/\*\*/gu, "");
}

export function plainQuestionRole(value: unknown): string {
  const role = clean(value);
  if (!role) return "相关业务人员";
  if (/^FDE$/iu.test(role)) return "交付工程师";
  if (role === "业务部门") return "业务负责人";
  return role;
}

export function plainQuestionPriority(value: unknown): string {
  const priority = clean(value).toLowerCase();
  if (priority === "blocking") return "会影响交付";
  if (priority === "high") return "优先确认";
  if (priority === "low") return "可稍后确认";
  return "普通";
}

export function plainQuestionStatus(value: unknown): string {
  const status = clean(value).toLowerCase().replace(/^status\./u, "");
  return ({
    open: "待回答",
    assigned: "已分派",
    blocked: "暂时无法回答",
    answered: "已回答",
    deferred: "已延期",
    cancelled: "已取消",
  } as Record<string, string>)[status] ?? clean(value);
}

export function plainQuestionSource(value: unknown): string {
  const source = clean(value);
  const key = source.toLowerCase();
  return ({
    ledger: "问题清单",
    question_ledger: "问题清单",
    conflict: "材料冲突",
    agent: "材料分析",
    agent_analysis: "材料分析",
    oir: "业务模型",
    rules: "业务规则",
    erp_map: "系统信息",
    system: "系统检查",
  } as Record<string, string>)[key] ?? source.replace(/_/gu, " ");
}

/** 把自动生成的“为什么问”模板改成业务人员能直接理解的一句话。 */
export function plainQuestionWhy(value: unknown, audienceRole: unknown = ""): string {
  const why = clean(value);
  if (!why) return "";
  const generated = why.match(/^由\s*([A-Z][A-Z0-9_]*)\s*独立分析发现[，,]?\s*需由相应业务角色确认[。.]?$/u);
  if (generated) {
    const domain = generated[1]!;
    const subject = DOMAIN_LABELS[domain] ?? "这项信息";
    return `材料里的${subject}没有说明清楚，需要请${plainQuestionRole(audienceRole)}确认。`;
  }
  let out = why;
  for (const [token, label] of Object.entries(DOMAIN_LABELS)) {
    out = out.replace(new RegExp(`\\b${token}\\b`, "gu"), label);
  }
  return out
    .replace(/需由相应业务角色确认/gu, `需要请${plainQuestionRole(audienceRole)}确认`)
    .replace(/独立分析发现/gu, "检查时发现");
}

/** 模型可自定义表名，但常见内部说法不能继续出现在用户界面。 */
export function plainQuestionTableTitle(value: unknown, count: number): string {
  const title = clean(value);
  if (!title) return `需要确认的问题（${count} 条）`;
  const readable = title
    .replace(/阻碍系统自动抽取的关键待澄清问题/gu, "需要优先确认的问题")
    .replace(/关键待澄清问题/gu, "需要优先确认的问题")
    .replace(/待澄清问题/gu, "待确认问题")
    .replace(/Non-Obvious/giu, "容易忽略")
    .replace(/非显而易见/gu, "容易忽略");
  return readable || `需要确认的问题（${count} 条）`;
}
