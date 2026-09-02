/**
 * FDE v3 交付计划的发布边界。
 *
 * Workflow 只给出数据；server 独占路径选择权。模型不能通过 `artifacts`、文件名或
 * 任意 key 控制写盘位置，compile 只消费下面的固定 key → 固定文件名映射。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { isReleaseAcceptanceAuthority } from "../../onto/release_authority.js";

type Dict = Record<string, unknown>;
type StateCarrier = { readonly state: Record<string, unknown> };

export type EngagementDeliveryDisposition = "RELEASED" | "REJECTED_DRAFT";

export const ENGAGEMENT_DELIVERY_FILES = [
  ["decision_proposal", "decision-proposals.json"],
  ["decision_application", "decision-application.json"],
  ["requirements", "requirements.json"],
  ["architecture", "architecture.json"],
  ["acceptance_test_plan", "acceptance-test-plan.json"],
  ["acceptance", "human-acceptance.json"],
] as const;

/**
 * compile 会更新的全部对外可见文件。这是路径的唯一权威白名单：
 * workflow/model 输出只能决定内容，不能增加、改名或跳出 session.dir。
 */
export const ENGAGEMENT_RELEASE_FILES = [
  "模板_v1.xlsx",
  "template.spec.json",
  "oir.json",
  "ontology.package.json",
  "ontology-package.schema.json",
  "data-objects.json",
  "actions.json",
  "events.json",
  "rules.json",
  "questions.json",
  ...ENGAGEMENT_DELIVERY_FILES.map(([, name]) => name),
] as const;

export interface EngagementReleaseFileOps {
  readonly exists: (path: string) => boolean;
  readonly copy: (source: string, target: string) => void;
  readonly rename: (source: string, target: string) => void;
  readonly unlink: (path: string) => void;
  readonly mkdir: (path: string) => void;
  readonly mkdtemp: (prefix: string) => string;
  readonly rmTree: (path: string) => void;
  readonly statFile: (path: string) => boolean;
  readonly fsyncFile: (path: string) => void;
  readonly fsyncDirectory: (path: string) => void;
}

export type EngagementReleaseFileOpsOverride = Partial<EngagementReleaseFileOps>;

const NODE_RELEASE_FILE_OPS: EngagementReleaseFileOps = {
  exists: existsSync,
  copy: copyFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  mkdtemp: mkdtempSync,
  rmTree: (path) => rmSync(path, { recursive: true, force: true }),
  statFile: (path) => statSync(path).isFile(),
  fsyncFile: syncFile,
  fsyncDirectory: syncDirectory,
};

export function engagementReleaseFileOps(
  overrides: EngagementReleaseFileOpsOverride = {},
): EngagementReleaseFileOps {
  return { ...NODE_RELEASE_FILE_OPS, ...overrides };
}

export interface EngagementReleaseStage {
  readonly schemaVersion: "1.0.0";
  readonly sessionDir: string;
  readonly stageDir: string;
  readonly files: readonly string[];
}

export interface EngagementReleaseCommit {
  readonly stage: EngagementReleaseStage;
  readonly installed: readonly string[];
  readonly backedUp: readonly string[];
}

/** 在 session.dir 内建 staging，确保后续 rename 不跨文件系统。 */
export function createEngagementReleaseStage(
  sessionDir: string,
  files: readonly string[],
  ops: EngagementReleaseFileOps,
): EngagementReleaseStage {
  assertReleaseFiles(files);
  const stageDir = ops.mkdtemp(join(sessionDir, ".release-stage-"));
  ops.mkdir(join(stageDir, "files"));
  ops.mkdir(join(stageDir, "incoming"));
  ops.mkdir(join(stageDir, "backup"));
  return { schemaVersion: "1.0.0", sessionDir, stageDir, files: [...files] };
}

export function engagementReleaseStagePath(stage: EngagementReleaseStage, name: string): string {
  assertStage(stage);
  assertReleaseFiles([name]);
  if (!stage.files.includes(name)) throw new Error(`交付 staging 不包含文件：${name}`);
  return join(stage.stageDir, "files", name);
}

/** 所有字节完整生成后统一 fsync；在此之前不碰可见目标。 */
export function sealEngagementReleaseStage(
  stage: EngagementReleaseStage,
  ops: EngagementReleaseFileOps,
): void {
  assertStage(stage);
  for (const name of stage.files) {
    const path = engagementReleaseStagePath(stage, name);
    if (!ops.statFile(path)) throw new Error(`交付 staging 缺少普通文件：${name}`);
    ops.fsyncFile(path);
  }
  ops.fsyncDirectory(join(stage.stageDir, "files"));
}

/**
 * 按固定白名单提交。每个旧文件先 rename 到同文件系统 backup；任一步失败
 * 立即删除本轮新文件并还原所有 backup。staging 原件一直保留到持久化成功。
 */
export function commitEngagementReleaseStage(
  stage: EngagementReleaseStage,
  ops: EngagementReleaseFileOps,
): EngagementReleaseCommit {
  assertStage(stage);
  const installed: string[] = [];
  const backedUp: string[] = [];
  try {
    for (const name of stage.files) {
      const prepared = engagementReleaseStagePath(stage, name);
      const incoming = join(stage.stageDir, "incoming", name);
      const target = join(stage.sessionDir, name);
      const backup = join(stage.stageDir, "backup", name);
      // copy 保留 sealed 原件，使 persist 失败回滚后能按原字节重试。
      ops.copy(prepared, incoming);
      ops.fsyncFile(incoming);
      if (ops.exists(target)) {
        ops.rename(target, backup);
        backedUp.push(name);
      }
      ops.rename(incoming, target);
      installed.push(name);
    }
    ops.fsyncDirectory(stage.sessionDir);
    return { stage, installed, backedUp };
  } catch (error) {
    const rollbackError = rollbackFiles(stage, installed, backedUp, ops);
    if (rollbackError !== null) {
      throw new AggregateError([error, rollbackError], "交付提交与回滚均失败");
    }
    throw error;
  }
}

export function rollbackEngagementReleaseCommit(
  commit: EngagementReleaseCommit,
  ops: EngagementReleaseFileOps,
): void {
  const error = rollbackFiles(commit.stage, commit.installed, commit.backedUp, ops);
  if (error !== null) throw error;
}

/** 只能在可见文件与 RELEASED/DRAFT 状态都持久化成功后调用。 */
export function finalizeEngagementReleaseCommit(
  stage: EngagementReleaseStage,
  ops: EngagementReleaseFileOps,
): void {
  assertStage(stage);
  ops.rmTree(stage.stageDir);
}

export function validEngagementReleaseStage(
  value: unknown,
  sessionDir: string,
  files: readonly string[],
  ops: EngagementReleaseFileOps,
): value is EngagementReleaseStage {
  if (mapping(value) === null) return false;
  const stage = value as unknown as EngagementReleaseStage;
  try {
    assertReleaseFiles(files);
    assertStage(stage);
    if (resolve(stage.sessionDir) !== resolve(sessionDir)) return false;
    if (stage.files.length !== files.length || stage.files.some((name, i) => name !== files[i])) {
      return false;
    }
    return stage.files.every((name) => ops.statFile(engagementReleaseStagePath(stage, name)));
  } catch {
    return false;
  }
}

function rollbackFiles(
  stage: EngagementReleaseStage,
  installed: readonly string[],
  backedUp: readonly string[],
  ops: EngagementReleaseFileOps,
): Error | null {
  const failures: unknown[] = [];
  for (const name of [...installed].reverse()) {
    const target = join(stage.sessionDir, name);
    try {
      if (ops.exists(target)) ops.unlink(target);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const name of [...backedUp].reverse()) {
    const backup = join(stage.stageDir, "backup", name);
    const target = join(stage.sessionDir, name);
    try {
      if (ops.exists(backup)) ops.rename(backup, target);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    ops.fsyncDirectory(stage.sessionDir);
  } catch (error) {
    failures.push(error);
  }
  return failures.length === 0 ? null : new AggregateError(failures, "交付回滚失败");
}

function assertReleaseFiles(files: readonly string[]): void {
  const allowed = new Set<string>(ENGAGEMENT_RELEASE_FILES);
  const seen = new Set<string>();
  for (const name of files) {
    if (!allowed.has(name) || basename(name) !== name || seen.has(name)) {
      throw new Error(`交付文件不在固定白名单：${name}`);
    }
    seen.add(name);
  }
}

function assertStage(stage: EngagementReleaseStage): void {
  if (stage.schemaVersion !== "1.0.0") throw new Error("交付 staging 版本无效");
  const sessionDir = resolve(stage.sessionDir);
  const stageDir = resolve(stage.stageDir);
  if (dirname(stageDir) !== sessionDir || !basename(stageDir).startsWith(".release-stage-")) {
    throw new Error("交付 staging 必须位于 session.dir 内");
  }
  if (!stageDir.startsWith(`${sessionDir}${sep}`)) throw new Error("交付 staging 路径越界");
  assertReleaseFiles(stage.files);
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface StagedDelivery {
  readonly schemaVersion: "1.0.0";
  readonly disposition: EngagementDeliveryDisposition;
  readonly human_accepted: boolean;
  readonly human_decided: boolean;
  readonly releaseState: "RELEASED" | "DRAFT";
  readonly documents: Dict;
}

function mapping(value: unknown): Dict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function signedAcceptanceDecision(acceptance: Dict | null): "APPROVE" | "REJECT" | null {
  if (
    acceptance === null ||
    acceptance["signed"] !== true ||
    acceptance["package_bound"] !== true ||
    acceptance["review_passed"] !== true ||
    !isReleaseAcceptanceAuthority(acceptance["authority"])
  ) {
    return null;
  }
  const decision = String(acceptance["decision"] ?? "").toUpperCase();
  return decision === "APPROVE" || decision === "REJECT" ? decision : null;
}

function signedDecision(plan: Dict): "APPROVE" | "REJECT" | null {
  return signedAcceptanceDecision(mapping(plan["acceptance"]));
}

/** 只有正式 APPROVE 能发布；正式 REJECT 是有效的人类终态，但只能保存 DRAFT。 */
export function engagementDeliveryDisposition(
  plan: Dict,
): EngagementDeliveryDisposition | null {
  const decision = signedDecision(plan);
  if (
    decision === "APPROVE" &&
    plan["human_accepted"] === true &&
    plan["releaseState"] === "RELEASED"
  ) {
    return "RELEASED";
  }
  if (
    decision === "REJECT" &&
    plan["human_decided"] === true &&
    plan["human_accepted"] !== true &&
    plan["releaseState"] === "DRAFT"
  ) {
    return "REJECTED_DRAFT";
  }
  return null;
}

/**
 * 在 compile 之前冻结一次 JSON 快照。JSON round-trip 同时拒绝循环/BigInt 等非交付
 * 数据，并断开模型输出对象后续被原地修改的可能。
 */
export function stageEngagementDelivery(s: StateCarrier, plan: Dict): EngagementDeliveryDisposition {
  const disposition = engagementDeliveryDisposition(plan);
  if (disposition === null) {
    throw new Error("FDE Engagement 缺少有效人工验收决定，已阻止交付提交");
  }
  const documents: Dict = {};
  for (const [key] of ENGAGEMENT_DELIVERY_FILES) {
    documents[key] = jsonSnapshot(plan[key] ?? {});
  }
  const staged: StagedDelivery = {
    schemaVersion: "1.0.0",
    disposition,
    human_accepted: disposition === "RELEASED",
    human_decided: true,
    releaseState: disposition === "RELEASED" ? "RELEASED" : "DRAFT",
    documents,
  };
  s.state["_engagement_delivery"] = staged;
  return disposition;
}

export function stagedEngagementDelivery(
  s: StateCarrier,
): { readonly disposition: EngagementDeliveryDisposition; readonly documents: readonly {
  readonly name: string;
  readonly payload: unknown;
}[] } | null {
  const staged = mapping(s.state["_engagement_delivery"]);
  if (staged === null) return null;
  const disposition = staged["disposition"];
  const validDisposition = disposition === "RELEASED" || disposition === "REJECTED_DRAFT";
  const releaseValid =
    disposition === "RELEASED"
      ? staged["human_accepted"] === true && staged["releaseState"] === "RELEASED"
      : staged["human_decided"] === true && staged["releaseState"] === "DRAFT";
  const documents = mapping(staged["documents"]);
  const stagedDecision = documents === null
    ? null
    : signedAcceptanceDecision(mapping(documents["acceptance"]));
  const acceptanceValid = disposition === "RELEASED"
    ? stagedDecision === "APPROVE"
    : stagedDecision === "REJECT";
  if (!validDisposition || !releaseValid || !acceptanceValid || documents === null) {
    throw new Error("FDE Engagement 暂存交付计划无效，已阻止写盘");
  }
  return {
    disposition,
    documents: ENGAGEMENT_DELIVERY_FILES.map(([key, name]) => ({
      name,
      payload: documents[key] ?? {},
    })),
  };
}

export function clearStagedEngagementDelivery(s: StateCarrier): void {
  delete s.state["_engagement_delivery"];
}

function jsonSnapshot(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("FDE 交付件包含不可序列化的值");
  return JSON.parse(encoded) as unknown;
}
