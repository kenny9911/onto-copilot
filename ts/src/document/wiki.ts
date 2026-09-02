import { open, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "../kernel/ids.js";

export const WIKI_CLAIM_KINDS = [
  "MATERIAL_FACT",
  "HUMAN_DECISION",
  "INFERENCE",
  "GENERAL_GUIDANCE",
  "CONTESTED",
  "STALE",
] as const;

export type WikiClaimKind = typeof WIKI_CLAIM_KINDS[number];
export type WikiClaimState = "draft" | "confirmed";

export interface WikiActor {
  readonly kind: "ai" | "human";
  readonly id: string;
  readonly name?: string;
}

export interface WikiConfirmation {
  readonly actor: WikiActor & { readonly kind: "human" };
  readonly evidenceRefs: readonly string[];
  readonly confirmedAt: string;
}

export interface WikiClaim {
  readonly id: string;
  readonly projectId: string;
  readonly kind: WikiClaimKind;
  readonly subject: string;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly state: WikiClaimState;
  readonly author: WikiActor;
  readonly createdAt: string;
  readonly confirmation: WikiConfirmation | null;
  readonly supersedesClaimId: string | null;
}

export interface WikiClaimDraftInput {
  readonly projectId: string;
  readonly kind: WikiClaimKind;
  readonly subject: string;
  readonly statement: string;
  readonly evidenceRefs?: readonly string[];
  readonly author: WikiActor;
  readonly createdAt: string;
  readonly supersedesClaimId?: string;
}

export interface WikiClaimConfirmationInput {
  readonly actor: WikiActor;
  readonly evidenceRefs: readonly string[];
  readonly confirmedAt: string;
}

/** 已通过文档服务按精确 evidence_ref 打开的原文。调用方不能拿搜索摘要代替。 */
export interface WikiEvidenceExcerpt {
  readonly evidenceRef: string;
  readonly text: string;
  /** 项目当前人工采用的精确版本；latest/current 不能替代 adopted。 */
  readonly versionState: "adopted" | "unadopted" | "unknown";
}

export interface WikiMaterialSupportCheck {
  readonly supported: boolean;
  readonly method: "literal" | "critical_values_and_coverage" | "unsupported";
  readonly coverage: number;
  readonly matchedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly missingCriticalValues: readonly string[];
}

export interface WikiPage {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly claims: readonly WikiClaim[];
  readonly updatedAt: string;
}

export interface WikiPageInput {
  readonly id?: string;
  readonly projectId: string;
  readonly title: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly claims: readonly WikiClaim[];
  readonly updatedAt: string;
}

export interface VaultFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

export interface ObsidianVaultBundle {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly files: readonly VaultFile[];
  readonly pagePaths: Readonly<Record<string, string>>;
  readonly fingerprint: string;
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文字`);
  const result = value.trim();
  if (!result || result.includes("\u0000") || [...result].length > max) {
    throw new Error(`${label}不能为空、不能含 NUL，且不能超过 ${max} 个字`);
  }
  return result;
}

function cleanDate(value: unknown, label: string): string {
  const text = cleanText(value, label, 64);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`${label}不是有效时间`);
  return new Date(time).toISOString();
}

function cleanActor(actor: WikiActor, expected?: "human"): WikiActor {
  if (actor === null || typeof actor !== "object") throw new Error("声明 actor 无效");
  if (actor.kind !== "ai" && actor.kind !== "human") throw new Error("声明 actor 类型无效");
  if (expected !== undefined && actor.kind !== expected) throw new Error("只有真人可以确认 Wiki 声明");
  const id = cleanText(actor.id, "actor.id", 160);
  const name = actor.name?.trim();
  return name ? { kind: actor.kind, id, name: cleanText(name, "actor.name", 160) } : { kind: actor.kind, id };
}

function cleanList(values: readonly string[] | undefined, label: string, maxItems: number): string[] {
  if (values !== undefined && !Array.isArray(values)) throw new Error(`${label}必须是列表`);
  const out = new Set<string>();
  for (const raw of values ?? []) {
    out.add(cleanText(raw, label, 2_048));
    if (out.size > maxItems) throw new Error(`${label}最多 ${maxItems} 项`);
  }
  return [...out].sort();
}

function validKind(kind: string): kind is WikiClaimKind {
  return (WIKI_CLAIM_KINDS as readonly string[]).includes(kind);
}

function normalizedSupportText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}%‰]+/gu, "");
}

interface CriticalQuantity {
  readonly display: string;
  readonly number: string;
  readonly unit: string;
}

const QUANTITY = /[+-]?\d+(?:\.\d+)?(?:%|‰|万|亿|元|天|日|月|年|小时|分钟|秒|个|次|笔|件|台|吨|kg|g|m|cm|mm)?/giu;
const QUANTITY_PARTS = /^([+-]?\d+(?:\.\d+)?)(.*)$/u;
const CRITICAL_WORDS = [
  "不超过", "不少于", "不等于", "不得", "不能", "无需", "禁止", "必须", "至少", "至多",
  "只能", "超过", "低于", "高于", "大于", "小于", "等于", "可以", "需要", "应当", "仅",
  "不", "无", "未", "非",
] as const;
// 只容忍数字前可省略的系词（“金额为100元” = “金额100元”）。关系词如
// “由/与/或”绝不能删除，否则会把责任人或与/或条件改成另一条规则。
const NUMERIC_COPULA = /[为是](?=[+-]?\d)/gu;
const UNSUPPORTED_MATERIAL_CONTEXT: readonly [RegExp, string][] = [
  [/(?:错误答案|错误说法|错误示例|说法(?:错误|不成立)|并不成立|有误|不正确|不准确|并非事实|这句话.{0,4}(?:错|有误))/u, "原文在否定这句话"],
  [/(?:不要|不应|不得|禁止)(?:继续)?采用|不再(?:采用|适用|执行|要求)/u, "原文要求不要采用这句话"],
  [/(?:已|已经|现已|后来)?(?:废止|废除|作废|取消|失效|过期|被替代|被取代)|(?:过去|曾经|曾规定|旧|历史)(?:.{0,8})?(?:规则|口径|版本|要求|规定|内容|条款)|旧版(?:内容|规则|条款|口径)/u, "原文把它标成旧版或已失效内容"],
  [/(?:不再|停止|已经停止).{0,8}(?:适用|执行|生效)|(?:以上|以下|上述|该).{0,8}(?:内容|规则|条款).{0,8}(?:废除|废止|失效|作废|删除)|(?:已删除|已移除|废弃).{0,8}(?:内容|规则|条款)/u, "原文把相邻内容标成不再适用"],
  [/(?:仅供|只是|仅是).{0,6}(?:举例|示例|参考)|(?:举例|示例|反例|测试用例(?:内容)?|测试内容|培训材料|演示内容|样例|例句)\s*[：:]/u, "原文只是在举例或测试"],
  [/(?:尚未|还未|未|待)(?:确认|核实|验证)|(?:不确定|存疑|待定)/u, "原文明确说尚未确认"],
  [/(?:有人|用户|客户|业务方).{0,6}(?:问|询问)|(?:请问|是否)|[？?]|吗(?:\s|[。！？!?]|$)/u, "原文是在提问"],
  [/(?:可能|或许|也许|据猜测|推测|假设|假定|据说|传闻|听说)/u, "原文只表达可能性或假设"],
  [/(?:草案|草稿|建议稿|征求意见|拟议|拟定|提议)|(?:待|尚待).{0,10}(?:生效|批准|审批|确认)/u, "原文仍是草案、建议或尚未生效"],
  [/(?:仅|只)(?:在|于|限于|适用于)|(?:例外|除外|不适用)(?:情况|条款|范围)?|(?:若|如果|假如|假设).{0,80}(?:则|那么|才)/u, "原文还有条件、例外或适用范围"],
  [/^\s*[“”‘’「」『』"'][\s\S]+[“”‘’「」『』"']\s*$/u, "原文只是一个孤立引文"],
];

export function materialEvidenceContextRisk(evidenceText: string): string | null {
  for (const [pattern, explanation] of UNSUPPORTED_MATERIAL_CONTEXT) {
    if (pattern.test(evidenceText)) return explanation;
  }
  return null;
}

function evidenceSentences(value: string): string[] {
  return value.normalize("NFKC")
    .split(/[。！？!?；;\n\r]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function evidenceClauses(sentence: string): string[] {
  const clean = (value: string): string => value
    .replace(/^[\s“”‘’「」『』"'()（）\[\]【】]+|[\s“”‘’「」『』"'()（）\[\]【】]+$/gu, "")
    .trim();
  const whole = clean(sentence);
  const colon = sentence.search(/[：:]/u);
  if (colon < 0) return whole === "" ? [] : [whole];
  const prefix = sentence.slice(0, colon).trim();
  const safeLabel =
    /^(?:(?:规则|制度|条款|口径|定义|要求|规定)(?:明确)?(?:为|如下)?|(?:现行|当前(?:有效)?|本版本|正式|已生效)(?:的)?\s*(?:规则|制度|条款|口径|定义|要求|规定)(?:明确)?(?:为|如下)?|现行制度明确规定)$/iu;
  const unsafeLabel =
    /(?:旧|历史|错误|不实|虚假|假的|非现行|测试|训练|示例|样例|反例|草案|建议|假设|失效|过时|废|删除|例外|暂定|待确认|未来|演示|模拟)/u;
  if (!safeLabel.test(prefix) || unsafeLabel.test(prefix)) return whole === "" ? [] : [whole];
  const content = clean(sentence.slice(colon + 1));
  // 标签后的内容作为一个完整命题比较。绝不按逗号摘取前半句，否则“X，
  // 但已失效/仅适用于某部门”会被错误升级为无条件事实。
  return [...new Set([whole, content])].filter(Boolean);
}

function omittedScopeContext(sentence: string, clause: string): string | null {
  if (normalizedSupportText(sentence) === normalizedSupportText(clause)) return null;
  if (/^(?:若|如果|假如|假设|仅当|除非|当.{0,30}(?:时|情况下)|在.{0,20}(?:时|情况下))/u.test(sentence.trim())) {
    return "原文还有条件或适用范围，不能只摘取结论";
  }
  return null;
}

function quantities(value: string): CriticalQuantity[] {
  const compact = normalizedSupportText(value).replaceAll(",", "");
  const out = new Map<string, CriticalQuantity>();
  for (const match of compact.matchAll(QUANTITY)) {
    const display = match[0]!.toLocaleLowerCase("zh-CN");
    const parts = QUANTITY_PARTS.exec(display);
    if (parts === null) continue;
    const number = parts[1]!.replace(/^\+/u, "");
    const unit = parts[2] ?? "";
    out.set(`${number}\u0000${unit}`, { display, number, unit });
  }
  return [...out.values()];
}

function quantitySupported(expected: CriticalQuantity, actual: readonly CriticalQuantity[]): boolean {
  return actual.some((candidate) =>
    candidate.number === expected.number &&
    (expected.unit === "" || candidate.unit === expected.unit));
}

function supportTerms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const out = new Set<string>();
  for (const match of normalized.matchAll(/[a-z][a-z0-9_]*|[\p{Script=Han}]+/gu)) {
    const token = match[0]!;
    if (/^[a-z]/u.test(token)) {
      if (token.length > 1) out.add(token);
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) {
      if (!"的是为和与及或在由把将了".includes(chars[0]!)) out.add(chars[0]!);
      continue;
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      const term = `${chars[index]!}${chars[index + 1]!}`;
      if (![...term].every((char) => "的是为和与及或在由把将了".includes(char))) out.add(term);
    }
  }
  return [...out].sort();
}

function materialSupportForOne(statement: string, evidenceText: string): WikiMaterialSupportCheck {
  const expected = normalizedSupportText(statement);
  const expectedQuantities = quantities(statement);
  const terms = supportTerms(statement);
  const claimCore = expected.replace(NUMERIC_COPULA, "");
  let best: WikiMaterialSupportCheck = {
    supported: false,
    method: "unsupported",
    coverage: 0,
    matchedTerms: [],
    missingTerms: terms,
    missingCriticalValues: expectedQuantities.map((quantity) => quantity.display),
  };
  let contextRisk: string | null = null;

  const sentences = evidenceSentences(evidenceText);
  const globalRisk = materialEvidenceContextRisk(evidenceText);
  // Wiki 的“已确认材料事实”必须引用聚焦到单一条款的原文。多句片段可能把
  // “旧规则/仅在某条件适用”放在相邻句，任何逐句命中都会丢掉限定语。
  if (globalRisk !== null || sentences.length !== 1) {
    return {
      supported: false,
      method: "unsupported",
      coverage: 0,
      matchedTerms: [],
      missingTerms: [`证据语境:${globalRisk ?? "证据片段包含多句，无法确定主张的完整范围"}`],
      missingCriticalValues: [],
    };
  }

  for (const sentence of sentences) {
    const sentenceRisk = materialEvidenceContextRisk(sentence);
    if (sentenceRisk !== null) {
      contextRisk ??= sentenceRisk;
      continue;
    }
    for (const clause of evidenceClauses(sentence)) {
      const omittedScope = omittedScopeContext(sentence, clause);
      if (omittedScope !== null) {
        contextRisk ??= omittedScope;
        continue;
      }
      const actual = normalizedSupportText(clause);
      const actualQuantities = quantities(clause);
      const missingCriticalValues = expectedQuantities
        .filter((quantity) => !quantitySupported(quantity, actualQuantities))
        .map((quantity) => quantity.display);
      const missingCriticalWords = CRITICAL_WORDS.filter((word) =>
        expected.includes(word) && !actual.includes(word));
      const evidenceTerms = new Set(supportTerms(clause));
      const matchedTerms = terms.filter((term) => evidenceTerms.has(term));
      const missingTerms = terms.filter((term) => !evidenceTerms.has(term));
      const coverage = terms.length === 0 ? 0 : matchedTerms.length / terms.length;
      const clauseCore = actual.replace(NUMERIC_COPULA, "");
      // MATERIAL_FACT 只接受一个独立条款完整表达该事实。禁止在整段中做
      // includes：否则“过去曾规定 X，但已废除”或“测试用例：X”会被误认成
      // 当前有效事实。宽松改写应保留为 INFERENCE，交给真人确认。
      const literal = expected.length > 0 && actual === expected;
      const normalizedLiteral = claimCore.length > 0 && clauseCore === claimCore;
      const supported =
        missingCriticalValues.length === 0 &&
        missingCriticalWords.length === 0 &&
        (literal || normalizedLiteral);
      if (supported) {
        return {
          supported: true,
          method: literal ? "literal" : "critical_values_and_coverage",
          coverage: 1,
          matchedTerms: terms,
          missingTerms: [],
          missingCriticalValues: [],
        };
      }
      const current: WikiMaterialSupportCheck = {
        supported: false,
        method: "unsupported",
        coverage,
        matchedTerms,
        missingTerms: [...missingTerms, ...missingCriticalWords.map((word) => `关键语义:${word}`)],
        missingCriticalValues,
      };
      if (current.coverage > best.coverage) best = current;
    }
  }
  if (contextRisk !== null && best.coverage === 0) {
    return {
      supported: false,
      method: "unsupported",
      coverage: 0,
      matchedTerms: [],
      missingTerms: [`证据语境:${contextRisk}`],
      missingCriticalValues: [],
    };
  }
  return best;
}

/**
 * MATERIAL_FACT 的确定性证据门禁。
 *
 * 它不做“语义猜测”：疑问、举例、旧规则、否定结论和“尚未确认”的语境先直接
 * 拒绝；其余内容必须由一个独立条款完整表达主张，去掉常见语法虚词后也只能
 * 做整条相等，不能在段落里做子串命中；主张里的业务名词、角色、动作、数字、单位、否定和强制词都不能变化。多个
 * 无关片段不能拼接成一个事实，词面大部分相同也不能掩盖关键角色被替换。
 * HUMAN_DECISION 不调用这个函数——那一类的权威来源是真人确认本身，而不是材料
 * 已经证明了这个决定。
 */
export function checkWikiMaterialFactSupport(
  statement: string,
  evidence: readonly WikiEvidenceExcerpt[],
): WikiMaterialSupportCheck {
  const cleanStatement = cleanText(statement, "声明正文", 20_000);
  let best: WikiMaterialSupportCheck = {
    supported: false,
    method: "unsupported",
    coverage: 0,
    matchedTerms: [],
    missingTerms: supportTerms(cleanStatement),
    missingCriticalValues: quantities(cleanStatement).map((quantity) => quantity.display),
  };
  for (const excerpt of evidence) {
    cleanText(excerpt.evidenceRef, "证据引用", 2_048);
    if (excerpt.versionState !== "adopted") {
      const current: WikiMaterialSupportCheck = {
        supported: false,
        method: "unsupported",
        coverage: 0,
        matchedTerms: [],
        missingTerms: [excerpt.versionState === "unadopted"
          ? "证据版本:引用的不是项目当前采用版本"
          : "证据版本:无法确认引用是否为项目当前采用版本"],
        missingCriticalValues: [],
      };
      if (best.coverage === 0) best = current;
      continue;
    }
    const text = cleanText(excerpt.text, "证据原文", 200_000);
    const current = materialSupportForOne(cleanStatement, text);
    if (current.supported) return current;
    if (
      current.coverage > best.coverage ||
      (current.coverage === best.coverage && current.missingTerms.some((term) => term.startsWith("证据语境:")))
    ) best = current;
  }
  return best;
}

/**
 * 无论作者是 AI 还是真人，新声明都先进入 draft。AI 没有能创建 confirmed 的 API；
 * 这条约束在类型之外还会由 {@link confirmWikiClaim} 做运行时检查。
 */
export function createWikiClaimDraft(input: WikiClaimDraftInput): WikiClaim {
  if (!validKind(input.kind)) throw new Error("不支持的 Wiki 声明类型");
  const projectId = cleanText(input.projectId, "projectId", 256);
  const subject = cleanText(input.subject, "声明主题", 300);
  const statement = cleanText(input.statement, "声明正文", 20_000);
  const evidenceRefs = cleanList(input.evidenceRefs, "证据引用", 100);
  const author = cleanActor(input.author);
  const createdAt = cleanDate(input.createdAt, "createdAt");
  const supersedesClaimId = input.supersedesClaimId === undefined
    ? null
    : cleanText(input.supersedesClaimId, "supersedesClaimId", 256);
  const identity = {
    projectId,
    kind: input.kind,
    subject,
    statement,
    evidenceRefs,
    supersedesClaimId,
  };
  return {
    id: `claim_${sha256Hex(canonicalJson(identity)).slice(0, 24)}`,
    projectId,
    kind: input.kind,
    subject,
    statement,
    evidenceRefs,
    state: "draft",
    author,
    createdAt,
    confirmation: null,
    supersedesClaimId,
  };
}

/** 真人确认必须同时留下 actor、时间和至少一条可审计依据。 */
export function confirmWikiClaim(
  claim: WikiClaim,
  input: WikiClaimConfirmationInput,
): WikiClaim {
  assertWikiClaim(claim);
  if (claim.state !== "draft" || claim.confirmation !== null) throw new Error("这条声明已经确认，不能静默覆盖确认记录");
  const actor = cleanActor(input.actor, "human") as WikiActor & { readonly kind: "human" };
  const evidenceRefs = cleanList(input.evidenceRefs, "确认依据", 100);
  if (evidenceRefs.length === 0) throw new Error("人工确认必须附至少一条证据或业务方原话引用");
  return {
    ...claim,
    state: "confirmed",
    confirmation: {
      actor,
      evidenceRefs,
      confirmedAt: cleanDate(input.confirmedAt, "confirmedAt"),
    },
  };
}

/**
 * 争议和过期不是对旧声明的原地篡改，而是带 supersedes 的新草稿；仍需人工确认。
 */
export function createClaimStateDraft(
  claim: WikiClaim,
  input: {
    readonly kind: "CONTESTED" | "STALE";
    readonly statement: string;
    readonly evidenceRefs: readonly string[];
    readonly author: WikiActor;
    readonly createdAt: string;
  },
): WikiClaim {
  assertWikiClaim(claim);
  return createWikiClaimDraft({
    projectId: claim.projectId,
    kind: input.kind,
    subject: claim.subject,
    statement: input.statement,
    evidenceRefs: input.evidenceRefs,
    author: input.author,
    createdAt: input.createdAt,
    supersedesClaimId: claim.id,
  });
}

function assertWikiClaim(claim: WikiClaim, expectedProjectId?: string): void {
  if (claim === null || typeof claim !== "object") throw new Error("Wiki 声明无效");
  cleanText(claim.id, "声明 ID", 256);
  const projectId = cleanText(claim.projectId, "projectId", 256);
  if (expectedProjectId !== undefined && projectId !== expectedProjectId) {
    throw new Error("Wiki 页面不能混入其他项目的声明");
  }
  if (!validKind(claim.kind)) throw new Error("不支持的 Wiki 声明类型");
  cleanText(claim.subject, "声明主题", 300);
  cleanText(claim.statement, "声明正文", 20_000);
  cleanList(claim.evidenceRefs, "证据引用", 100);
  cleanActor(claim.author);
  cleanDate(claim.createdAt, "createdAt");
  if (claim.supersedesClaimId !== null) cleanText(claim.supersedesClaimId, "supersedesClaimId", 256);
  if (claim.state === "draft") {
    if (claim.confirmation !== null) throw new Error("草稿不能伪造人工确认记录");
    return;
  }
  if (claim.state !== "confirmed" || claim.confirmation === null) {
    throw new Error("Wiki 声明状态与确认记录不一致");
  }
  cleanActor(claim.confirmation.actor, "human");
  const evidenceRefs = cleanList(claim.confirmation.evidenceRefs, "确认依据", 100);
  if (evidenceRefs.length === 0) throw new Error("已确认声明必须保留人工确认依据");
  cleanDate(claim.confirmation.confirmedAt, "confirmedAt");
}

export function createWikiPage(input: WikiPageInput): WikiPage {
  const projectId = cleanText(input.projectId, "projectId", 256);
  const title = cleanText(input.title, "Wiki 页面标题", 300);
  const summary = input.summary?.trim() ?? "";
  if ([...summary].length > 4_000 || summary.includes("\u0000")) throw new Error("Wiki 页面摘要无效");
  const tags = cleanList(input.tags, "页面标签", 50);
  const seen = new Set<string>();
  const claims = [...input.claims].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const claim of claims) {
    assertWikiClaim(claim, projectId);
    if (seen.has(claim.id)) throw new Error(`Wiki 页面含重复声明：${claim.id}`);
    seen.add(claim.id);
  }
  const id = input.id === undefined
    ? `wiki_${sha256Hex(canonicalJson({ projectId, title })).slice(0, 24)}`
    : cleanText(input.id, "Wiki 页面 ID", 256);
  return { id, projectId, title, summary, tags, claims, updatedAt: cleanDate(input.updatedAt, "updatedAt") };
}

function assertWikiPage(page: WikiPage): void {
  if (page === null || typeof page !== "object") throw new Error("Wiki 页面无效");
  cleanText(page.id, "Wiki 页面 ID", 256);
  const projectId = cleanText(page.projectId, "projectId", 256);
  cleanText(page.title, "Wiki 页面标题", 300);
  if (typeof page.summary !== "string" || page.summary.includes("\u0000") || [...page.summary].length > 4_000) {
    throw new Error("Wiki 页面摘要无效");
  }
  cleanList(page.tags, "页面标签", 50);
  cleanDate(page.updatedAt, "updatedAt");
  if (!Array.isArray(page.claims)) throw new Error("Wiki 页面声明必须是列表");
  const ids = new Set<string>();
  for (const claim of page.claims) {
    assertWikiClaim(claim, projectId);
    if (ids.has(claim.id)) throw new Error(`Wiki 页面含重复声明：${claim.id}`);
    ids.add(claim.id);
  }
}

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("!", "\\!")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("\r", "")
    .trim();
}

function codeText(value: string): string {
  return value.replaceAll("`", "ˋ").replaceAll("\r", "").replaceAll("\n", " ").trim();
}

function frontmatterText(value: string): string {
  return JSON.stringify(markdownText(value));
}

const KIND_LABELS: Readonly<Record<WikiClaimKind, string>> = {
  MATERIAL_FACT: "材料事实",
  HUMAN_DECISION: "人工决定",
  INFERENCE: "待验证推断",
  GENERAL_GUIDANCE: "通用参考",
  CONTESTED: "存在争议",
  STALE: "可能已过期",
};

function claimMarkdown(claim: WikiClaim): string[] {
  const state = claim.state === "confirmed" ? "已由人工确认" : "草稿（不可当作已确认事实）";
  const lines = [
    `### ${markdownText(claim.subject)}`,
    "",
    `- 类型：${KIND_LABELS[claim.kind]}`,
    `- 状态：${state}`,
    `- 声明 ID：\`${codeText(claim.id)}\``,
    `- 起草者：${claim.author.kind === "ai" ? "AI" : "人工"} · \`${codeText(claim.author.id)}\``,
  ];
  if (claim.confirmation !== null) {
    lines.push(
      `- 确认人：\`${codeText(claim.confirmation.actor.id)}\``,
      `- 确认时间：${claim.confirmation.confirmedAt}`,
    );
  }
  if (claim.supersedesClaimId !== null) lines.push(`- 替代声明：\`${codeText(claim.supersedesClaimId)}\``);
  const refs = claim.confirmation?.evidenceRefs ?? claim.evidenceRefs;
  if (refs.length > 0) lines.push(`- 依据：${refs.map((ref) => `\`${codeText(ref)}\``).join("、")}`);
  lines.push("", ...markdownText(claim.statement).split("\n").map((line) => `> ${line}`), "");
  return lines;
}

/** 单页 Markdown 导出；原文中的 HTML、Obsidian embed 和任意 wiki-link 均被转义。 */
export function renderWikiMarkdown(page: WikiPage): string {
  assertWikiPage(page);
  const lines = [
    "---",
    `id: ${frontmatterText(page.id)}`,
    `project_id: ${frontmatterText(page.projectId)}`,
    `title: ${frontmatterText(page.title)}`,
    `updated_at: ${frontmatterText(page.updatedAt)}`,
    `tags: ${JSON.stringify(page.tags.map((tag) => markdownText(tag)))}`,
    "---",
    "",
    `# ${markdownText(page.title)}`,
    "",
  ];
  if (page.summary) lines.push(markdownText(page.summary), "");
  if (page.claims.length === 0) lines.push("（暂无声明）", "");
  for (const kind of WIKI_CLAIM_KINDS) {
    const claims = page.claims.filter((claim) => claim.kind === kind);
    if (claims.length === 0) continue;
    lines.push(`## ${KIND_LABELS[kind]}`, "");
    for (const claim of claims) lines.push(...claimMarkdown(claim));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function safeStem(value: string): string {
  const forbidden = /[\u0000-\u001f\u007f<>:"/\\|?*#^\[\]]/gu;
  let stem = value.normalize("NFKC").replace(forbidden, "_").replace(/\s+/gu, " ").trim();
  stem = stem.replace(/^\.+|[. ]+$/gu, "");
  if (!stem) stem = "未命名页面";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(stem)) stem = `_${stem}`;
  return [...stem].slice(0, 100).join("");
}

function safeRelativePath(path: string): boolean {
  if (!path || [...path].length > 1_024 || isAbsolute(path) || path.includes("\u0000") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) =>
    part !== "" && part !== "." && part !== ".." && [...part].length <= 255 && !part.includes("/"));
}

function vaultFile(path: string, content: string): VaultFile {
  if (!safeRelativePath(path)) throw new Error(`不安全的 Vault 路径：${path}`);
  return { path, content, sha256: sha256Hex(content) };
}

/**
 * 纯函数生成 Obsidian Vault。文件路径只来自系统清洗后的页面标题；同名按页面 ID
 * 稳定加后缀，绝不接受 claim/模型提供的相对路径。
 */
export function buildObsidianVault(input: {
  readonly projectId: string;
  readonly pages: readonly WikiPage[];
  readonly generatedAt: string;
}): ObsidianVaultBundle {
  const projectId = cleanText(input.projectId, "projectId", 256);
  const generatedAt = cleanDate(input.generatedAt, "generatedAt");
  const pages = [...input.pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const used = new Set<string>(["首页.md", ".obsidian/app.json"].map((path) => path.toLocaleLowerCase("en-US")));
  const pageIds = new Set<string>();
  const pagePaths = Object.create(null) as Record<string, string>;
  const files: VaultFile[] = [];
  for (const page of pages) {
    assertWikiPage(page);
    if (page.projectId !== projectId) throw new Error("Vault 不能混入其他项目的页面");
    if (pageIds.has(page.id)) throw new Error(`Vault 含重复页面 ID：${page.id}`);
    pageIds.add(page.id);
    const stem = safeStem(page.title);
    let path = `${stem}.md`;
    let finalFolded = path.toLocaleLowerCase("en-US");
    let collision = 0;
    while (used.has(finalFolded)) {
      collision += 1;
      if (collision > 10_000) throw new Error(`无法消解页面文件名冲突：${page.title}`);
      const suffix = collision === 1
        ? sha256Hex(page.id).slice(0, 8)
        : `${sha256Hex(page.id).slice(0, 8)}-${collision}`;
      path = `${stem}--${suffix}.md`;
      finalFolded = path.toLocaleLowerCase("en-US");
    }
    used.add(finalFolded);
    pagePaths[page.id] = path;
    files.push(vaultFile(path, renderWikiMarkdown(page)));
  }
  const index = [
    "---",
    `project_id: ${frontmatterText(projectId)}`,
    `generated_at: ${frontmatterText(generatedAt)}`,
    "---",
    "",
    "# 项目知识库",
    "",
    ...pages.map((page) => {
      const target = pagePaths[page.id]!.replace(/\.md$/u, "");
      return `- [[${target}]] — ${markdownText(page.title)}`;
    }),
    "",
  ].join("\n");
  files.push(
    vaultFile("首页.md", index),
    vaultFile(".obsidian/app.json", `${JSON.stringify({ showUnsupportedFiles: false }, null, 2)}\n`),
  );
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const fingerprint = sha256Hex(canonicalJson(files.map((file) => [file.path, file.sha256]))).slice(0, 32);
  return { projectId, generatedAt, files, pagePaths, fingerprint };
}

function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * 写入一个全新的 Vault 目录。目的目录已存在就拒绝，因而不会覆盖用户笔记或跟随
 * 目录内预埋的软链接；每个文件仍使用 wx 做最后一道保护。
 */
export async function writeObsidianVault(destination: string, bundle: ObsidianVaultBundle): Promise<void> {
  if (bundle.files.length > 10_000) throw new Error("Vault 文件数超过 10000，已拒绝导出");
  let total = 0;
  const caseFolded = new Set<string>();
  for (const file of bundle.files) {
    if (!safeRelativePath(file.path)) throw new Error(`不安全的 Vault 路径：${file.path}`);
    if (sha256Hex(file.content) !== file.sha256) throw new Error(`Vault 文件校验失败：${file.path}`);
    const folded = file.path.toLocaleLowerCase("en-US");
    if (caseFolded.has(folded)) throw new Error(`Vault 路径冲突：${file.path}`);
    caseFolded.add(folded);
    total += Buffer.byteLength(file.content, "utf8");
    if (Buffer.byteLength(file.content, "utf8") > 10 * 1024 * 1024 || total > 100 * 1024 * 1024) {
      throw new Error("Vault 导出内容超过安全上限");
    }
  }
  for (const folded of caseFolded) {
    const parts = folded.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (caseFolded.has(parts.slice(0, index).join("/"))) {
        throw new Error(`Vault 同一路径不能既是文件又是目录：${folded}`);
      }
    }
  }
  const root = resolve(destination);
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const file of bundle.files) {
    const target = resolve(root, ...file.path.split("/"));
    if (!inside(root, target)) throw new Error(`Vault 路径越界：${file.path}`);
    const parent = target.slice(0, target.lastIndexOf(sep));
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(file.content, "utf8");
    } finally {
      await handle.close();
    }
  }
}
