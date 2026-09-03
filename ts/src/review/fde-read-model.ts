/**
 * FDE / Ontology 审阅读模型。
 *
 * Question Ledger 仍然是唯一权威：本文件既不写 Question，也不改变它的 status、
 * priority 或 release gate。它只把面向机器的逐实体 lint 和面向业务的澄清问题，
 * 转成更适合 FDE 访谈与建模审查的分组、排序和解释层。
 */

export const FDE_REVIEW_SCHEMA_VERSION = "ontocopilot.fde-review/1" as const;

export type FdeReviewLevel = "blocking" | "important" | "completeness" | "diagnostic";
export type FdeReviewMode = "question" | "batch";
export type FdeReviewDomain =
  | "process_boundary"
  | "workflow_orchestration"
  | "role_permission"
  | "state_transition"
  | "action_contract"
  | "event_contract"
  | "integration_ownership"
  | "exception_compensation"
  | "rule_threshold"
  | "data_responsibility"
  | "link_contract"
  | "ontology_completeness"
  | "schema_quality";

export interface FdeReviewQuestionRef {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly priority: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
}

export interface FdeReviewItem {
  readonly id: string;
  readonly mode: FdeReviewMode;
  readonly domain: FdeReviewDomain;
  readonly domainLabel: string;
  readonly domainLabelEn: string;
  /** 面向 FDE 的建模注意级别；不覆盖 Question.priority。 */
  readonly level: FdeReviewLevel;
  readonly title: string;
  readonly titleEn: string;
  readonly status: string;
  readonly why: string;
  readonly whyEn: string;
  readonly impact: string;
  readonly impactEn: string;
  readonly expectedAnswer: string;
  readonly expectedAnswerEn: string;
  readonly questionIds: string[];
  readonly primaryQuestionId: string;
  readonly questions: FdeReviewQuestionRef[];
  readonly authority: {
    readonly blocking: number;
    readonly high: number;
    readonly active: number;
    readonly answered: number;
  };
  readonly searchText: string;
}

export interface FdeReviewGroup {
  readonly id: FdeReviewDomain;
  readonly label: string;
  readonly labelEn: string;
  readonly description: string;
  readonly descriptionEn: string;
  readonly itemIds: string[];
  readonly questionCount: number;
  readonly activeCount: number;
}

export interface FdeReviewReadModel {
  readonly schemaVersion: typeof FDE_REVIEW_SCHEMA_VERSION;
  readonly summary: {
    readonly originalQuestions: number;
    readonly activeQuestions: number;
    readonly answeredQuestions: number;
    readonly visibleItems: number;
    readonly businessQuestions: number;
    readonly diagnosticQuestions: number;
    readonly diagnosticBatches: number;
    readonly blockingItems: number;
    readonly importantItems: number;
    readonly completenessItems: number;
    readonly diagnosticItems: number;
  };
  readonly groups: FdeReviewGroup[];
  readonly items: FdeReviewItem[];
}

type Dict = Record<string, unknown>;

const ACTIVE = new Set(["open", "assigned", "blocked"]);
const ANSWERED = new Set(["answered", "cancelled"]);

interface DomainCopy {
  readonly label: string;
  readonly labelEn: string;
  readonly description: string;
  readonly descriptionEn: string;
  readonly why: string;
  readonly whyEn: string;
  readonly impact: string;
  readonly impactEn: string;
  readonly expectedAnswer: string;
  readonly expectedAnswerEn: string;
}

const DOMAIN_COPY: Readonly<Record<FdeReviewDomain, DomainCopy>> = Object.freeze({
  process_boundary: {
    label: "流程边界",
    labelEn: "Process boundary",
    description: "先确认业务起止、上下游、分支和范围，避免把局部步骤误建成完整 Workflow。",
    descriptionEn: "Confirm business start/end points, upstream/downstream handoffs, branches, and scope before treating local steps as a complete Workflow.",
    why: "需要确认 Workflow 的业务边界、入口、出口和分支归属。",
    whyEn: "The Workflow needs explicit business boundaries, entries, exits, and branch ownership.",
    impact: "边界不清会造成节点漏接、跨流程职责混淆，以及 Workflow 无法独立验证和交付。",
    impactEn: "Unclear boundaries leave nodes disconnected, blur cross-process ownership, and prevent independent Workflow validation and delivery.",
    expectedAnswer: "请给出起点/终点、上游输入、下游输出、主要分支，以及明确不属于本流程的场景。",
    expectedAnswerEn: "Provide the start/end, upstream inputs, downstream outputs, major branches, and scenarios explicitly outside this process.",
  },
  workflow_orchestration: {
    label: "Workflow 编排契约",
    labelEn: "Workflow orchestration",
    description: "确认节点顺序、网关、并发/汇合、定时器、SLA、重入与终止语义。",
    descriptionEn: "Confirm node order, gateways, forks/joins, timers, SLAs, re-entry, and termination semantics.",
    why: "Workflow 必须把节点之间的控制流和等待条件表达成可执行编排，而不只是步骤清单。",
    whyEn: "A Workflow must express executable control flow and wait conditions, not just a list of steps.",
    impact: "编排不清会造成错误并发、流程悬挂、重复触发，或入口/出口不可达。",
    impactEn: "Ambiguous orchestration can cause unsafe concurrency, hanging flows, duplicate triggers, or unreachable entries and exits.",
    expectedAnswer: "请给出前驱/后继、网关条件、并行与汇合规则、Timer/SLA、循环/重入策略，以及成功和失败终点。",
    expectedAnswerEn: "Provide predecessors/successors, gateway conditions, fork/join rules, timers/SLAs, loop/re-entry policy, and success/failure terminals.",
  },
  role_permission: {
    label: "角色与权限",
    labelEn: "Roles and permissions",
    description: "确定谁发起、审批、执行、查看和兜底，并把组织条件映射到 Action 权限。",
    descriptionEn: "Identify who initiates, approves, executes, views, and owns fallback, then map organizational conditions to Action permissions.",
    why: "Action 的执行角色和授权条件必须能映射到真实组织与岗位。",
    whyEn: "Action actors and authorization conditions must map to real teams and roles.",
    impact: "角色不清会让 Action 无法配置权限，审批节点也无法确定消费者和责任人。",
    impactEn: "Unclear roles prevent permission configuration and leave approval consumers and owners undefined.",
    expectedAnswer: "请按 RACI 给出发起/审批/执行/可见/兜底角色，并说明组织、金额或状态条件。",
    expectedAnswerEn: "Provide RACI roles for initiate/approve/execute/view/fallback and any organization, amount, or state conditions.",
  },
  state_transition: {
    label: "状态迁移",
    labelEn: "State transitions",
    description: "把对象生命周期、允许动作和守卫条件串成可执行的状态机。",
    descriptionEn: "Turn object lifecycle, allowed Actions, and guards into an executable state machine.",
    why: "需要把业务描述落成 DataObject 的明确状态迁移和守卫条件。",
    whyEn: "Business language must resolve into explicit DataObject transitions and guards.",
    impact: "缺少迁移契约会导致 Action effects 不可验证、事件时点模糊，并产生非法状态。",
    impactEn: "Without a transition contract, Action effects cannot be validated, Event timing is ambiguous, and illegal states can appear.",
    expectedAnswer: "请给出当前状态→目标状态、触发 Action、前置条件，以及撤销、失败和回退路径。",
    expectedAnswerEn: "Provide current → target state, triggering Action, preconditions, and cancel/failure/rollback paths.",
  },
  action_contract: {
    label: "Action 契约",
    labelEn: "Action contract",
    description: "确认 Action 的调用者、对象、输入、前置条件、effects、权限和失败语义。",
    descriptionEn: "Confirm each Action's caller, object, inputs, preconditions, effects, permissions, and failure semantics.",
    why: "Action 只有具备完整前置条件和 effects，才能从业务意图变成可实现接口。",
    whyEn: "An Action needs complete preconditions and effects before business intent can become an implementable interface.",
    impact: "契约缺失会阻断 API 对接、权限配置、状态更新和下游 Event 的发布。",
    impactEn: "Missing contracts block API integration, permission setup, state updates, and downstream Event publication.",
    expectedAnswer: "请给出 Action 名称、调用者、作用对象、参数、preconditions、effects、幂等策略与失败码。",
    expectedAnswerEn: "Provide Action name, caller, target object, parameters, preconditions, effects, idempotency policy, and failure codes.",
  },
  event_contract: {
    label: "Event 发布与消费",
    labelEn: "Event producers and consumers",
    description: "对齐 producer Action、发布时点、payload、消费者和投递语义。",
    descriptionEn: "Align producer Actions, publish timing, payloads, consumers, and delivery semantics.",
    why: "Event 必须明确由哪个 Action 发布、谁消费，以及消费后触发什么行为。",
    whyEn: "Each Event must identify its producer Action, consumers, and the behavior triggered on consumption.",
    impact: "生产消费链不清会形成孤立 Event、重复处理或关键下游没有触发。",
    impactEn: "An unclear producer/consumer chain creates orphan Events, duplicate processing, or missing downstream triggers.",
    expectedAnswer: "请给出 Event 名称、producer Action、发布时间、payload/版本、consumer 与重复/乱序策略。",
    expectedAnswerEn: "Provide Event name, producer Action, publish timing, payload/version, consumers, and duplicate/out-of-order policy.",
  },
  integration_ownership: {
    label: "系统、API 与数据责任",
    labelEn: "Systems, APIs, and ownership",
    description: "识别 system of record、读写方向、接口/Topic、认证、SLA 和 owner。",
    descriptionEn: "Identify the system of record, read/write direction, API or topic, authentication, SLA, and owners.",
    why: "Ontology 需要与真实系统边界、API/消息入口和数据责任人对齐。",
    whyEn: "The Ontology must align with real system boundaries, API/message entry points, and data owners.",
    impact: "系统责任不清会让同一字段多处写入、接口无法配置，并留下不可追踪的数据漂移。",
    impactEn: "Unclear ownership enables conflicting writes, blocks interface configuration, and creates untraceable data drift.",
    expectedAnswer: "请给出 source-of-truth 系统、API/Topic、读写方向、协议认证、SLA、技术 owner 与数据 owner。",
    expectedAnswerEn: "Provide the source-of-truth system, API/topic, read/write direction, protocol/auth, SLA, technical owner, and data owner.",
  },
  exception_compensation: {
    label: "异常与补偿",
    labelEn: "Exceptions and compensation",
    description: "覆盖失败、超时、取消、撤回、重试、补偿和人工兜底。",
    descriptionEn: "Cover failures, timeouts, cancellation, withdrawal, retries, compensation, and manual fallback.",
    why: "正常主干之外还需要可执行、可审计的异常与补偿路径。",
    whyEn: "The happy path also needs executable and auditable exception and compensation paths.",
    impact: "没有补偿语义会留下半完成状态、重复扣减/写入，或无法恢复的业务对象。",
    impactEn: "Missing compensation semantics leave partial states, duplicate deductions/writes, or unrecoverable business objects.",
    expectedAnswer: "请逐场景给出失败/超时条件、重试上限、补偿 Action、人工兜底、通知对象与审计记录。",
    expectedAnswerEn: "For each scenario, provide failure/timeout conditions, retry limit, compensation Action, manual fallback, notification target, and audit record.",
  },
  rule_threshold: {
    label: "规则与阈值",
    labelEn: "Rules and thresholds",
    description: "把自然语言规则转成带单位、作用域、优先级、例外和 owner 的约束。",
    descriptionEn: "Convert natural-language rules into constraints with units, scope, priority, exceptions, and an owner.",
    why: "业务规则必须有可计算条件、阈值和适用范围，才能进入 Rules 配置。",
    whyEn: "Business rules need computable conditions, thresholds, and scope before entering Rules configuration.",
    impact: "模糊规则会让网关分支、审批路径和 Action preconditions 无法稳定执行。",
    impactEn: "Ambiguous rules make gateways, approval routing, and Action preconditions non-deterministic.",
    expectedAnswer: "请给出规则表达式、阈值与单位、生效范围、优先级、例外、版本和规则 owner。",
    expectedAnswerEn: "Provide the rule expression, threshold/unit, scope, priority, exceptions, version, and rule owner.",
  },
  data_responsibility: {
    label: "DataObject 与数据语义",
    labelEn: "DataObject semantics",
    description: "确认对象/字段口径、唯一标识、必填、来源、质量约束和责任人。",
    descriptionEn: "Confirm object/field meaning, identity, required fields, sources, quality constraints, and owners.",
    why: "DataObject 需要稳定身份、字段语义与来源责任，才能关联 Action、Link 和 Event payload。",
    whyEn: "A DataObject needs stable identity, field semantics, and source ownership before it can connect to Actions, Links, and Event payloads.",
    impact: "数据口径不清会造成对象重复、Join 失败、必填校验不一致和下游 payload 歧义。",
    impactEn: "Unclear data semantics create duplicate objects, failed joins, inconsistent required-field validation, and ambiguous downstream payloads.",
    expectedAnswer: "请给出对象/字段定义、业务主键、必填与枚举、来源系统、更新责任人、敏感性和质量规则。",
    expectedAnswerEn: "Provide object/field definitions, business keys, required/enumerated values, source system, update owner, sensitivity, and quality rules.",
  },
  link_contract: {
    label: "Link 关系契约",
    labelEn: "Link contract",
    description: "确认关系方向、角色名、基数、连接键、生命周期和跨系统解析方式。",
    descriptionEn: "Confirm relation direction, role names, cardinality, join keys, lifecycle, and cross-system resolution.",
    why: "Link 需要明确两端对象和可验证的连接语义，不能只停留在“有关联”。",
    whyEn: "A Link needs explicit endpoints and verifiable join semantics; saying objects are merely related is insufficient.",
    impact: "方向、基数或连接键不清会导致重复关联、丢失关系和跨系统 Join 错误。",
    impactEn: "Unclear direction, cardinality, or join keys cause duplicate relations, missing links, and incorrect cross-system joins.",
    expectedAnswer: "请给出 source/target DataObject、双向角色名、1:1/1:N/N:M 基数、join key、必选性、有效期和关系 owner。",
    expectedAnswerEn: "Provide source/target DataObjects, role names in both directions, 1:1/1:N/N:M cardinality, join keys, optionality, effective dates, and owner.",
  },
  ontology_completeness: {
    label: "Ontology 完整性",
    labelEn: "Ontology completeness",
    description: "检查对象、Link、Action、Event、Workflow 和 Rule 是否闭合，而不是逐字段刷屏。",
    descriptionEn: "Check whether DataObjects, Links, Actions, Events, Workflows, and Rules form a closed model without flooding review with field-level lint.",
    why: "需要确认缺失的模型关系是真实业务缺口，还是材料范围或抽取方式导致。",
    whyEn: "Determine whether a missing model relation is a real business gap or an artifact of source scope or extraction.",
    impact: "未闭合的 Ontology 会出现孤立对象、无消费者事件或无对象 Action，无法形成可部署 Package。",
    impactEn: "An open Ontology leaves orphan objects, Events without consumers, or Actions without objects and cannot become a deployable Package.",
    expectedAnswer: "请确认缺失关系是否应补建；若应补建，给出端点与语义；若不应，标注引用型对象、范围外或豁免原因。",
    expectedAnswerEn: "Confirm whether each missing relation should be modeled. If yes, provide endpoints and semantics; if no, mark it reference-only, out of scope, or exempt with a reason.",
  },
  schema_quality: {
    label: "Schema 质量诊断",
    labelEn: "Schema diagnostics",
    description: "把同型字段、主键、孤立对象和命名问题合并成可批量处理的清单。",
    descriptionEn: "Batch repeated field, key, orphan-object, and naming findings into actionable lists.",
    why: "这是模型质量检查，不适合逐对象向业务人员重复提问。",
    whyEn: "These are model-quality checks and should not be repeated as one interview question per object.",
    impact: "不处理会降低 Package 校验与集成可用性；但应由 FDE/数据负责人批量修复或确认豁免。",
    impactEn: "Leaving them unresolved weakens Package validation and integration readiness, but an FDE or data owner should fix or exempt them in bulk.",
    expectedAnswer: "请按批次提供映射/修复/豁免清单，并注明来源系统、负责人和统一处理规则。",
    expectedAnswerEn: "Provide a batch mapping/fix/exemption list with source system, owner, and the common resolution rule.",
  },
});

interface NormalizedQuestion extends FdeReviewQuestionRef {
  readonly blockedArtifacts: string[];
  readonly why: string;
  readonly impact: string;
  readonly expectedAnswer: string;
  readonly raw: Dict;
}

function record(value: unknown): Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Dict
    : {};
}

function value(value: unknown): unknown {
  const row = record(value);
  return Object.prototype.hasOwnProperty.call(row, "value") ? row["value"] : value;
}

function text(value_: unknown): string {
  const raw = value(value_);
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();
  if (["number", "boolean", "bigint"].includes(typeof raw)) return String(raw);
  return "";
}

function strings(value_: unknown): string[] {
  const values = Array.isArray(value_) ? value_ : value_ === null || value_ === undefined ? [] : [value_];
  return [...new Set(values.map(text).filter(Boolean))];
}

function normalizedQuestion(value_: unknown, index: number): NormalizedQuestion {
  const outer = record(value_);
  const raw = Object.keys(record(outer["raw"])).length > 0 ? record(outer["raw"]) : outer;
  const id = text(outer["id"] ?? raw["id"] ?? raw["rid"]) || `review:${index}`;
  const status = text(outer["status"] ?? raw["status"]).toLowerCase().replace(/^status\./u, "") || "open";
  return {
    id,
    text: text(outer["text"] ?? raw["text"] ?? raw["title"] ?? raw["q"]) || "（未命名问题）",
    status,
    priority: text(outer["priority"] ?? raw["priority"] ?? raw["severity"]).toLowerCase() || "normal",
    sourceKind: text(outer["source"] ?? raw["sourceKind"] ?? raw["source_kind"] ?? raw["source"]),
    sourceRef: text(raw["sourceRef"] ?? raw["source_ref"] ?? outer["sourceRef"]),
    blockedArtifacts: strings(outer["blockedArtifacts"] ?? raw["blockedArtifacts"] ?? raw["blocked_artifacts"]),
    why: text(outer["why"] ?? raw["why"] ?? raw["rationale"]),
    impact: text(outer["impact"] ?? raw["impact"] ?? raw["impactSummary"]),
    expectedAnswer: text(outer["expectedAnswer"] ?? raw["expectedAnswer"] ?? raw["expected_answer"]),
    raw,
  };
}

interface LintBatchDefinition {
  readonly id: string;
  readonly title: (count: number) => string;
  readonly titleEn: (count: number) => string;
  readonly match: (question: NormalizedQuestion) => boolean;
  readonly expectedAnswer: string;
  readonly expectedAnswerEn: string;
}

const LINT_BATCHES: readonly LintBatchDefinition[] = [
  {
    id: "missing_primary_key",
    title: (count) => `${count} 个 DataObject 缺少主键定义`,
    titleEn: (count) => `${count} DataObjects have no primary key`,
    match: (question) => /未声明主键|missing (?:a )?primary key/iu.test(question.text)
      || /missing_required/iu.test(question.sourceRef) && /主键|primary/iu.test(question.text),
    expectedAnswer: "请批量提交 DataObject → primaryKey[] 映射；若没有稳定主键，请给出来源系统唯一键、组合键或豁免原因。",
    expectedAnswerEn: "Submit a DataObject → primaryKey[] mapping in bulk. Where no stable key exists, provide the source-system unique key, composite key, or exemption reason.",
  },
  {
    id: "orphan_object",
    title: (count) => `${count} 个对象尚未接入 Link、Action 或 Workflow`,
    titleEn: (count) => `${count} objects are not connected to a Link, Action, or Workflow`,
    match: (question) => /与任何对象都没有关系|没有任何关系|orphan(?:ed)? object|no relation/iu.test(question.text)
      || /(?:^|_)orphan(?:_|$)/iu.test(question.sourceRef),
    expectedAnswer: "请批量标注每个对象应连接的 Link/Action/Workflow；仅供引用或范围外的对象请给出豁免类型和原因。",
    expectedAnswerEn: "For each object, identify the Link/Action/Workflow it should connect to. Mark reference-only or out-of-scope objects with exemption type and reason.",
  },
  {
    id: "naming_registry",
    title: (count) => `${count} 个名称或缩写未通过命名规范`,
    titleEn: (count) => `${count} names or abbreviations fail the naming policy`,
    match: (question) => /疑似未登记缩写|命名(?:规范|冲突|违规)|naming.violation|unregistered abbreviation/iu.test(question.text)
      || /naming_violation/iu.test(question.sourceRef),
    expectedAnswer: "请批量提交术语 → canonical apiName、中文名、英文名和缩写表；无法确认的项标注 owner。",
    expectedAnswerEn: "Submit a term → canonical apiName, Chinese name, English name, and abbreviation registry in bulk; assign an owner to unresolved terms.",
  },
  // 空槽模板家族：机器对每个对象各生成一条同型问题（真实会话里 25 条 SoR +
  // 27 条负责人）。逐条问等于把空槽表原样倒给人看，而答案本该一张表一次给。
  // 匹配优先认 sourceRef 前缀（`oq_missing_systemofrecord_*`，生成器给的稳定键），
  // 文案兜底只认**模板句式整句**，免得把真业务问题误折进来。
  {
    id: "missing_system_of_record",
    title: (count) => `${count} 个 DataObject 未标注 system of record`,
    titleEn: (count) => `${count} DataObjects have no system of record`,
    match: (question) => /oq_missing_systemofrecord/iu.test(question.sourceRef)
      || /^DataObject .+ 的 system of record 是什么？$/u.test(question.text.trim()),
    expectedAnswer: "请一次给出对象 → 来源系统（SoR）对照表：谁是唯一事实来源、同步方向与频率；无 SoR 的对象请注明原因。",
    expectedAnswerEn: "Provide an object → system-of-record table in one pass: authoritative source, sync direction and frequency; note the reason for objects with no SoR.",
  },
  {
    id: "missing_owner_role",
    title: (count) => `${count} 个 DataObject 没有业务负责人角色`,
    titleEn: (count) => `${count} DataObjects have no business owner role`,
    match: (question) => /oq_missing_ownerrole/iu.test(question.sourceRef)
      || /^DataObject .+ 的业务负责人角色是什么？$/u.test(question.text.trim()),
    expectedAnswer: "请一次给出对象 → 负责角色对照表（岗位而非个人）：谁定义口径、谁批准变更；共用同一角色的可合并成一行。",
    expectedAnswerEn: "Provide an object → owning role table in one pass (role, not person): who defines the semantics and who approves changes; group objects that share a role.",
  },
  {
    id: "field_schema_lint",
    title: (count) => `${count} 个字段或 Schema 约束需要批量修复`,
    titleEn: (count) => `${count} field or Schema constraints need a batch fix`,
    // **只认来源，不认文案。** 真库审计（d53cb63f7e18 / fc58b72e91bd）：文案分支
    // 在 208 条成员里贡献 6 条，无一是真的字段 lint —— 3 条 blocking 的「口径
    // 不一致」、1 条「是否同一业务对象」、2 条 high 的专业分析结论。它们被吞进
    // 批次后硬判成 diagnostic，blocking 直接从摘要里消失。而「字段」二字在业务
    // 问题里本来就常见，靠它分辨逐行 lint 与真决策，方向就是错的。
    match: (question) => /missing_required/iu.test(question.sourceRef),
    expectedAnswer: "请批量给出字段类型、必填、枚举/单位/精度、来源字段和豁免项；不要逐字段口头回答。",
    expectedAnswerEn: "Provide field types, required flags, enum/unit/precision, source fields, and exemptions in bulk rather than answering one field at a time.",
  },
];

function lintBatch(question: NormalizedQuestion): LintBatchDefinition | null {
  return LINT_BATCHES.find((batch) => batch.match(question)) ?? null;
}

function domainOf(question: NormalizedQuestion): FdeReviewDomain {
  const source = `${question.text} ${question.sourceKind} ${question.sourceRef}`;
  // 显式控制流问题优先归入编排契约；其中出现“超时/失败终点”并不等于补偿问题。
  if (/(?:Workflow|工作流|编排).*(?:网关|gateway|并行|串行|分流|汇合|fork|join|timer|定时器|SLA|前驱|后继|入口|出口|循环|回环|重入)|(?:网关|gateway|并行|汇合|timer|定时器|SLA).*(?:Workflow|工作流|编排)/iu.test(source)) {
    return "workflow_orchestration";
  }
  if (/取消|撤回|作废|失败|超时|异常|补偿|回滚|重试|恢复|驳回|退回|冲正|兜底|降级|重入/iu.test(source)) {
    return "exception_compensation";
  }
  if (/Event|事件|发布|订阅|消费者|消费方|消息|Topic|通知谁|触发谁的待办/iu.test(source)) {
    return "event_contract";
  }
  if (/Link|关系方向|关系角色|关联关系|基数|多对一|一对多|一对一|多对多|1\s*:\s*[1n]|n\s*:\s*m|join.?key|连接键|关联键|外键|foreign.?key|源对象|目标对象|有效期关系/iu.test(source)) {
    return "link_contract";
  }
  if (/系统|API|接口|endpoint|端点|推送|同步|数据库|ERP|MRP|source.?of.?truth|数据源|外部平台|集成/iu.test(source)) {
    return "integration_ownership";
  }
  if (/Workflow|工作流|编排|网关|gateway|并行|串行|分流|汇合|fork|join|timer|定时器|SLA|前驱|后继|入口节点|出口节点|循环|回环|重入/iu.test(source)) {
    return "workflow_orchestration";
  }
  if (/谁能|谁来|谁编|谁批|角色|权限|审批人|负责人|岗位|部门(?:负责人|领导)|哪个部门|分配给.{0,8}部门|代办|代改|转办|加签|可见/iu.test(source)) {
    return "role_permission";
  }
  if (/Action|动作|操作|precondition|effect|前置|后置|作用对象|执行者|调用者|幂等|写回/iu.test(source)) {
    return "action_contract";
  }
  if (/状态|流转|生命周期|生效|失效|已编制|已审批|待审批|变更后|修改后|阶段/iu.test(source)) {
    return "state_transition";
  }
  // “金额字段口径”首先是 DataObject 语义，不应因为同时出现“金额”被误排到规则阈值。
  if (/字段|属性|数据对象|业务口径|数据口径|主键|必填|唯一|枚举|粒度|单位|精度|编码/iu.test(source)) {
    return "data_responsibility";
  }
  if (/规则|阈值|金额|比例|时限|几级|多少|条件|校验|必须|不能|是否允许|免审|上限|下限/iu.test(source)) {
    return "rule_threshold";
  }
  if (/流程|开始|结束|入口|出口|范围|上下游|之前|之后|拆分|合并|分支|主干|节点/iu.test(source)) {
    return "process_boundary";
  }
  if (/对象|数据|口径|附件|物料/iu.test(source)) {
    return "data_responsibility";
  }
  if (question.sourceKind === "conflict") return "ontology_completeness";
  return "ontology_completeness";
}

function levelOf(question: NormalizedQuestion, domain: FdeReviewDomain): FdeReviewLevel {
  if (question.priority === "blocking" || question.blockedArtifacts.length > 0) return "blocking";
  if (question.priority === "high") return "important";
  if (["action_contract", "event_contract", "integration_ownership", "state_transition",
    "exception_compensation", "role_permission", "process_boundary", "workflow_orchestration",
    "link_contract", "rule_threshold"].includes(domain)) {
    return "important";
  }
  return "completeness";
}

interface DecisionProjection {
  readonly title: string;
  readonly titleEn: string;
  readonly expectedAnswer?: string;
  readonly expectedAnswerEn?: string;
}

/**
 * 抽取器的聚合诊断可以保留在权威 Question 里，但投影给 FDE 时必须变成
 * 可作答的设计决策。这里只改显示文案，原 Question.text 与 id 均保持不变。
 */
function decisionProjection(question: NormalizedQuestion): DecisionProjection {
  const actionTypeGap = question.text.match(/(\d+)\s*个对象没有任何\s*ActionType[；;，, ]*OpenAPI\s*(?:里)?(?:没有|无)可用端点/iu);
  if (actionTypeGap) {
    const count = actionTypeGap[1] || "这些";
    return {
      title: `请确认 ${count} 个 DataObject 的操作边界：哪些由现有系统/API 写入，哪些应明确标记为只读或范围外？`,
      titleEn: `Confirm the operation boundary for ${count} DataObjects: which are written through an existing system/API, and which are explicitly read-only or out of scope?`,
      expectedAnswer: "请按对象族给出 owning system、写入 Action、API/Topic 与技术 owner；无写操作的对象标注 read-only、not_applicable 或范围外，并说明依据。",
      expectedAnswerEn: "For each object family, provide the owning system, write Action, API/topic, and technical owner. Mark objects with no write operation as read-only, not_applicable, or out of scope with rationale.",
    };
  }
  return { title: question.text, titleEn: question.text };
}

function statusSummary(questions: readonly NormalizedQuestion[]): string {
  const active = questions.filter((question) => ACTIVE.has(question.status)).length;
  if (active > 0) return "open";
  if (questions.some((question) => question.status === "deferred")) return "deferred";
  if (questions.every((question) => ANSWERED.has(question.status))) return "answered";
  return questions[0]?.status || "open";
}

function authoritySummary(questions: readonly NormalizedQuestion[]): FdeReviewItem["authority"] {
  return {
    blocking: questions.filter((question) => question.priority === "blocking" || question.blockedArtifacts.length > 0).length,
    high: questions.filter((question) => question.priority === "high").length,
    active: questions.filter((question) => ACTIVE.has(question.status)).length,
    answered: questions.filter((question) => ANSWERED.has(question.status)).length,
  };
}

function questionRef(question: NormalizedQuestion): FdeReviewQuestionRef {
  return {
    id: question.id,
    text: question.text,
    status: question.status,
    priority: question.priority,
    sourceKind: question.sourceKind,
    sourceRef: question.sourceRef,
  };
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const LEVEL_ORDER: Readonly<Record<FdeReviewLevel, number>> = Object.freeze({
  blocking: 0,
  important: 1,
  completeness: 2,
  diagnostic: 3,
});

const DOMAIN_ORDER: readonly FdeReviewDomain[] = [
  "process_boundary",
  "workflow_orchestration",
  "role_permission",
  "state_transition",
  "action_contract",
  "event_contract",
  "integration_ownership",
  "exception_compensation",
  "rule_threshold",
  "data_responsibility",
  "link_contract",
  "ontology_completeness",
  "schema_quality",
];

/**
 * 构建纯只读投影。所有 `questionIds` 都指向原 Question；batch 只是 UI 容器，不能
 * 被回答或写回，因此不会把 175 个不同对象的问题错误地合并成一个 Decision。
 */
export function buildFdeReviewReadModel(rawQuestions: readonly unknown[]): FdeReviewReadModel {
  const normalized = rawQuestions.map(normalizedQuestion);
  const batchMembers = new Map<string, { definition: LintBatchDefinition; questions: NormalizedQuestion[] }>();
  const semantic: NormalizedQuestion[] = [];
  for (const question of normalized) {
    const batch = lintBatch(question);
    if (batch === null) {
      semantic.push(question);
      continue;
    }
    const current = batchMembers.get(batch.id) ?? { definition: batch, questions: [] };
    current.questions.push(question);
    batchMembers.set(batch.id, current);
  }

  const items: FdeReviewItem[] = semantic.map((question) => {
    const domain = domainOf(question);
    const copy = DOMAIN_COPY[domain];
    const level = levelOf(question, domain);
    const projection = decisionProjection(question);
    const why = question.why || copy.why;
    const impact = question.impact || copy.impact;
    const expectedAnswer = projection.expectedAnswer || question.expectedAnswer || copy.expectedAnswer;
    const expectedAnswerEn = projection.expectedAnswerEn || copy.expectedAnswerEn;
    return {
      id: `question:${question.id}`,
      mode: "question",
      domain,
      domainLabel: copy.label,
      domainLabelEn: copy.labelEn,
      level,
      title: projection.title,
      titleEn: projection.titleEn,
      status: question.status,
      why,
      whyEn: copy.whyEn,
      impact,
      impactEn: copy.impactEn,
      expectedAnswer,
      expectedAnswerEn,
      questionIds: [question.id],
      primaryQuestionId: question.id,
      questions: [questionRef(question)],
      authority: authoritySummary([question]),
      searchText: [question.text, projection.title, projection.titleEn, copy.label, copy.labelEn,
        why, copy.whyEn, impact, copy.impactEn, expectedAnswer, expectedAnswerEn, question.sourceKind]
        .join(" ").toLocaleLowerCase(),
    };
  });

  for (const { definition, questions } of batchMembers.values()) {
    const copy = DOMAIN_COPY.schema_quality;
    const authority = authoritySummary(questions);
    const samples = questions.slice(0, 8).map(questionRef);
    items.push({
      id: `batch:${definition.id}`,
      mode: "batch",
      domain: "schema_quality",
      domainLabel: copy.label,
      domainLabelEn: copy.labelEn,
      level: "diagnostic",
      title: definition.title(questions.length),
      titleEn: definition.titleEn(questions.length),
      status: statusSummary(questions),
      why: copy.why,
      whyEn: copy.whyEn,
      impact: copy.impact,
      impactEn: copy.impactEn,
      expectedAnswer: definition.expectedAnswer,
      expectedAnswerEn: definition.expectedAnswerEn,
      questionIds: questions.map((question) => question.id),
      primaryQuestionId: questions[0]?.id || "",
      questions: questions.map(questionRef),
      authority,
      searchText: [definition.title(questions.length), definition.titleEn(questions.length), copy.label,
        copy.labelEn, copy.why, copy.whyEn, copy.impact, copy.impactEn,
        definition.expectedAnswer, definition.expectedAnswerEn, ...samples.map((question) => question.text)]
        .join(" ").toLocaleLowerCase(),
    });
  }

  items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    || DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain)
    || Number(b.authority.active > 0) - Number(a.authority.active > 0)
    || compareCodePoint(a.id, b.id));

  const groups: FdeReviewGroup[] = DOMAIN_ORDER.map((domain) => {
    const members = items.filter((item) => item.domain === domain);
    const questionIds = new Set(members.flatMap((item) => item.questionIds));
    return {
      id: domain,
      label: DOMAIN_COPY[domain].label,
      labelEn: DOMAIN_COPY[domain].labelEn,
      description: DOMAIN_COPY[domain].description,
      descriptionEn: DOMAIN_COPY[domain].descriptionEn,
      itemIds: members.map((item) => item.id),
      questionCount: questionIds.size,
      activeCount: members.reduce((count, item) => count + item.authority.active, 0),
    };
  }).filter((group) => group.itemIds.length > 0);

  const diagnosticQuestions = [...batchMembers.values()]
    .reduce((count, batch) => count + batch.questions.length, 0);
  return {
    schemaVersion: FDE_REVIEW_SCHEMA_VERSION,
    summary: {
      originalQuestions: normalized.length,
      activeQuestions: normalized.filter((question) => ACTIVE.has(question.status)).length,
      answeredQuestions: normalized.filter((question) => ANSWERED.has(question.status)).length,
      visibleItems: items.length,
      businessQuestions: semantic.length,
      diagnosticQuestions,
      diagnosticBatches: batchMembers.size,
      blockingItems: items.filter((item) => item.level === "blocking").length,
      importantItems: items.filter((item) => item.level === "important").length,
      completenessItems: items.filter((item) => item.level === "completeness").length,
      diagnosticItems: items.filter((item) => item.level === "diagnostic").length,
    },
    groups,
    items,
  };
}
