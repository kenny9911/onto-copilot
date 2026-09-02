/**
 * 问题分诊 —— 纯确定性，一条模型调用都不花（分诊自己要是上了 LLM，
 * 它就是第二个要花 $90 的东西）。
 *
 * 动机（实测会话 fc58b72e91bd）：4044 条问题里 3906 条（97%）是逐行 lint ——
 * 「未声明主键」×1365、「与任何对象都没有关系」×1357、「apiName 不合规范」×849，
 * 全部无差别标 BLOCKING 推给人。真正人工筛过的（open_question / agent_analysis）
 * 只有 138 条，被淹在里面。
 *
 * 三件事，三个函数：
 *  · {@link conflictKindOf}   —— 聚类键从 sourceRef 前缀解析（cf_missing_required_f50d…
 *    → missing_required）。机器可读的键**已经存在**，不靠文本正则；
 *  · {@link fillTriageSignals} —— informationGain / blastRadius 的确定性生产者。
 *    此前全仓没有任何生产者，排序键第二位恒 0，next() 实际按生成早晚出题。
 *    只填空（0 / 空串），不覆盖已有值 —— 人工提过档的不许打回去；
 *  · {@link triageBacklog}    —— 逐行 lint 按 kind 折叠成模式级问题
 *    （「1365 个对象未声明主键：主键口径统一按什么定？」），真决策类
 *    （口径分歧/疑似重复/类型不一致/缺失操作）**永不折叠** —— 每条都要单独拍板，
 *    折叠它们等于把决策藏起来。
 *
 * 解析不出 kind 的 conflict 一律保守处理：不聚类、优先级不动、gain 取中档。
 *
 * **不 import questions.ts 的运行时符号**（只 import type）：questions.ts 的
 * buildQuestionBacklog 要反向调用这里，运行时循环依赖会让先加载的一方拿到
 * 半初始化的模块。优先级因此用字符串字面量比较 —— 与 QuestionPriority 的值
 * 逐字相同，契约由 onto.triage.test.ts 钉住。
 */

import type { Question } from "./questions.js";

/** 与 onto/conflict.ts 的 ConflictKind 值逐字一致（那边是权威）。 */
const KNOWN_KINDS = [
  "semantic_divergence",
  "missing_required",
  "naming_violation",
  "duplicate",
  "perfunctory",
  "orphan",
  "type_mismatch",
  "missing_action",
] as const;

/**
 * 逐行 lint：单条不值得打断人，折叠后按模式问一次。
 * 口径分歧、疑似重复、类型不一致、缺失操作**不在此列** —— 它们是真决策。
 */
const LINT_KINDS: ReadonlySet<string> = new Set([
  "missing_required",
  "naming_violation",
  "orphan",
  "perfunctory",
]);

const KIND_CN: Readonly<Record<string, string>> = {
  semantic_divergence: "口径分歧",
  missing_required: "主键与必填",
  naming_violation: "命名规范",
  duplicate: "疑似重复",
  perfunctory: "疑似敷衍",
  orphan: "孤立对象",
  type_mismatch: "类型不一致",
  missing_action: "缺失操作",
};

/** 模式级问题的问法 —— 这一句就是拿去问业务方的话，必须带答得动的选项方向。 */
const KIND_ASK: Readonly<Record<string, (n: number) => string>> = {
  missing_required: (n) =>
    `${n} 个对象未声明主键 —— 主键口径统一按什么定（编码字段 / 复合键 / 系统生成）？`,
  orphan: (n) => `${n} 个对象与其他对象没有任何关系 —— 是漏了关系，还是本就是独立清单？`,
  naming_violation: (n) => `${n} 处命名不合规范 —— 按建议批量改名，还是保留现状登记为例外？`,
  perfunctory: (n) => `${n} 处疑似敷衍填写 —— 请业务方补充实义，还是按现状接受？`,
};

/**
 * `cf_<kind>_<hash>` → kind。认不出回 null —— 老式引用（cf_1）、非 conflict
 * 引用（oq_1）都走保守路径。按 KNOWN_KINDS 前缀匹配而不是「剥掉尾部 hash」：
 * kind 自己带下划线（missing_required），从右边剥是剥不干净的。
 */
export function conflictKindOf(sourceRef: string): string | null {
  if (!sourceRef.startsWith("cf_")) return null;
  const rest = sourceRef.slice(3);
  for (const kind of KNOWN_KINDS) {
    if (rest === kind || rest.startsWith(`${kind}_`)) return kind;
  }
  return null;
}

/** 这条 lint 该不该在生成时降档（raw conflict 的优先级策略用它）。 */
export function isLintConflictRef(sourceRef: string): boolean {
  const kind = conflictKindOf(sourceRef);
  return kind !== null && LINT_KINDS.has(kind);
}

/** 单选项且自带机器可执行 effect —— 不是要人拍板的决策，是可自动施加的修复通知。 */
function machineApplicable(q: Question): boolean {
  if (q.options.length !== 1) return false;
  const only = q.options[0];
  if (typeof only !== "object" || only === null) return false;
  const effect = (only as Record<string, unknown>)["effect"];
  if (effect === null || effect === undefined) return false;
  if (typeof effect === "object") return Object.keys(effect as object).length > 0;
  return Boolean(effect);
}

/**
 * informationGain / blastRadius / group / code 的确定性生产者。**只填空**：
 * gain 只在 0 时填、group/code 只在空串时填 —— agent 问题带着自己的分组进来，
 * 人工提档的值不许打回去。档位的依据是「谁筛过它」：
 *  · agent_analysis 0.7 —— 专业节点筛过；
 *  · open_question 0.6 —— 材料里真实提出；
 *  · conflict 真决策类 0.7、解析不出 kind 0.5、逐行 lint 0.25、
 *    机器可执行的修复通知 0.15（答案早已在 options.effect 里）。
 */
export function fillTriageSignals(q: Question): void {
  const kind = q.sourceKind === "conflict" ? conflictKindOf(q.sourceRef) : null;
  if (q.informationGain === 0) {
    if (q.sourceKind === "agent_analysis") {
      q.informationGain = 0.7;
    } else if (q.sourceKind === "open_question") {
      q.informationGain = 0.6;
    } else if (q.sourceKind === "conflict") {
      q.informationGain = machineApplicable(q)
        ? 0.15
        : kind === null
          ? 0.5
          : LINT_KINDS.has(kind)
            ? 0.25
            : 0.7;
    }
  }
  if (q.blastRadius === 0) {
    q.blastRadius = Math.max(q.scopeRefs.length, q.blockedArtifacts.length);
  }
  if (kind !== null) {
    if (!q.group) q.group = KIND_CN[kind] ?? kind;
    if (!q.code) q.code = `CF_${kind.toUpperCase()}`;
  }
}

export interface QuestionCluster {
  readonly kind: string;
  readonly group: string;
  /** 模式级问法 —— 直接可以进访谈提纲的那一句。 */
  readonly title: string;
  readonly count: number;
  /** 成员里带机器可执行修复（单选项 + effect）的条数 —— 拍板后可批量应用。 */
  readonly autoApplicable: number;
  /** 插入序第一条 —— 举例给人看「同型长什么样」。 */
  readonly representative: Question;
  readonly instanceIds: string[];
  /** 成员里的最高优先级（字符串值与 QuestionPriority 逐字一致）。 */
  readonly priority: string;
}

export interface TriageResult {
  /** 原生高价值：逐条问。已按（优先级，gain×blast，createdAt，id）排序。 */
  readonly ask: Question[];
  /** 模式级：折叠后的逐行 lint，按规模降序。 */
  readonly clusters: QuestionCluster[];
}

/** 与 QuestionPriority 的值逐字一致（见文件头：不 import 运行时符号的理由）。 */
const PRIORITY_RANK: Readonly<Record<string, number>> = {
  blocking: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/**
 * 折叠 + 分层。给谁的问题、什么状态算「待问」由**调用方**筛好再进来 ——
 * 这里不猜业务语境（question.next 只给非终态的，报表脚本可以全量看漏斗）。
 */
export function triageBacklog(
  questions: Iterable<Question>,
  opts: { minCluster?: number } = {},
): TriageResult {
  const minCluster = opts.minCluster ?? 3;
  const byKind = new Map<string, Question[]>();
  const rest: Question[] = [];
  for (const q of questions) {
    const kind = q.sourceKind === "conflict" ? conflictKindOf(q.sourceRef) : null;
    if (kind !== null && LINT_KINDS.has(kind)) {
      const bucket = byKind.get(kind);
      if (bucket === undefined) byKind.set(kind, [q]);
      else bucket.push(q);
    } else {
      rest.push(q);
    }
  }
  const clusters: QuestionCluster[] = [];
  for (const [kind, members] of byKind) {
    if (members.length < minCluster) {
      // 不够一撮的不折叠 —— 三两条逐条问比「模式 ×2」更自然
      rest.push(...members);
      continue;
    }
    let top = 0;
    for (const m of members) top = Math.max(top, PRIORITY_RANK[String(m.priority)] ?? 1);
    const priority =
      Object.entries(PRIORITY_RANK).find(([, rank]) => rank === top)?.[0] ?? "normal";
    clusters.push({
      kind,
      group: KIND_CN[kind] ?? kind,
      title: (KIND_ASK[kind] ?? ((n: number) => `${n} 处同型：${members[0]!.text}`))(
        members.length,
      ),
      count: members.length,
      autoApplicable: members.filter(machineApplicable).length,
      representative: members[0]!,
      instanceIds: members.map((m) => m.id),
      priority,
    });
  }
  clusters.sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  // 与 QuestionBacklog.next() 同构的排序键：(优先级, gain×max(1,blast), createdAt, id)
  rest.sort((a, b) => {
    const pa = PRIORITY_RANK[String(a.priority)] ?? 1;
    const pb = PRIORITY_RANK[String(b.priority)] ?? 1;
    if (pa !== pb) return pb - pa;
    const ga = a.informationGain * Math.max(1, a.blastRadius);
    const gb = b.informationGain * Math.max(1, b.blastRadius);
    if (ga !== gb) return gb - ga;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { ask: rest, clusters };
}
