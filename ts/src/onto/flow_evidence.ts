/**
 * 证据纪律的硬闸门。
 *
 * 一条断言把 `origin` 标成 `EXTRACTED`，就是在说「这句话来自客户材料」。
 * 说了这句话却拿不出 `evidence`，是**非法状态**：图上它会画成实线（`nodeGrounded`
 * 只看 evidence 非空），主干图会拿它当骨架，交付包会把它当事实收进去，
 * 走查会沿着它走 —— 全都建立在一个没有出处的断言上。
 *
 * ── 为什么要新写这一道 ──────────────────────────────────────
 * 设计评审逐条核实过：仓库里两个 provenance critic 都不管这件事。
 * `pipeline.ts` 那个只扫 objects/properties/links 三个桶的 source_locator，
 * 从不看 `origin`、从不看流程图，且只发 `Severity.MEDIUM`（注释自陈「不 RETRY」）；
 * `engagement_runtime.ts` 那个只在 REVIEW 节点跑，`passed` 恒为 true。
 * 只有 schema critic 会发能 block 的 HIGH。
 * 也就是说这道门**此前不存在**，不是"沿用既有"。
 *
 * ── 为什么抛错而不是报 finding ──────────────────────────────
 * finding 会被人忽略，而这条一旦破防，产物里"有据"的那部分就是假的。
 * 宁可不出图，也不出一张分不清真假的图 —— 这与本模块所在管线一贯的
 * 「抽不出来就不出图，出一张空图比不出更糟」是同一条纪律。
 */

import type { Assertion } from "./oir.js";
import { Origin } from "./oir.js";
import type { FlowGraph } from "./flow.js";

/** 一处违规：谁、哪个字段、写了什么。 */
export interface EvidenceViolationItem {
  /** 节点或边的 rid。 */
  readonly rid: string;
  /** 出问题的字段名，如 `label` / `actor`。 */
  readonly field: string;
  /** 断言的值，用来让人一眼认出是哪一条。 */
  readonly value: string;
}

export class EvidenceViolation extends Error {
  readonly violations: readonly EvidenceViolationItem[];

  constructor(violations: readonly EvidenceViolationItem[]) {
    const lines = violations
      .map((v) => `  · ${v.rid} 的 ${v.field}：「${v.value}」`)
      .join("\n");
    super(
      `有 ${violations.length} 处断言声称来自材料（origin=extracted）却没有出处：\n${lines}\n`
      + "没有出处就不能标 extracted —— 要么补上出处，要么改标 inferred。",
    );
    this.name = "EvidenceViolation";
    this.violations = violations;
  }
}

/** `extracted` 却没有 evidence 的断言就是违规。 */
function offends(a: Assertion<string> | undefined): boolean {
  return a !== undefined && a.origin === Origin.EXTRACTED && a.evidence.length === 0;
}

/**
 * 落盘前的最后一道检查。有任何一处违规就抛 `EvidenceViolation`，不写产物。
 *
 * 一次收齐所有违规再抛：碰到第一个就停的话，修完一处又撞下一处，
 * 一张图要来回跑很多轮才能修干净。
 */
export function assertEvidenceDiscipline(g: FlowGraph): void {
  const bad: EvidenceViolationItem[] = [];

  for (const n of g.nodes.values()) {
    if (offends(n.label)) {
      bad.push({ rid: n.rid, field: "label", value: n.label.value });
    }
    if (offends(n.actor)) {
      bad.push({ rid: n.rid, field: "actor", value: n.actor.value });
    }
  }

  if (bad.length > 0) throw new EvidenceViolation(bad);
}
