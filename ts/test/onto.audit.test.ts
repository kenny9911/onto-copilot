/**
 * onto/audit.ts —— 回传审核。
 *
 * 这是交付前的最后一道闸：**漏判等于把问题直接交给客户**。所以每条规则都按
 * 正反两面测（该报的报出来、不该报的不许报），期望值来自
 * `golden/onto.audit.json` + `golden/onto.audit.*.xlsx`
 * （`tools/golden/onto_audit.py` 从 Python 原件真跑出来的）。
 *
 * xlsx 是真文件、两侧读同一份 —— 「锚点对齐」这条承诺只有这样才算验到：
 * 业务方顶上插一行、左边插一列、删掉隐藏列、复制粘贴出重复行，四种最常见的
 * 破坏各有一份。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ReturnAuditor,
  auditCounts,
  auditReadable,
  auditSummary,
  cellSignals,
  diffChanged,
  diffFilled,
  diffUntouchedPrefill,
  makeCellDiff,
  mergeIntoOir,
  pyRound,
  readReturned,
  readReturnedFromSheets,
  slipToDict,
  type ReturnedSheet,
} from "../src/onto/audit.js";
import { ConflictKind, conflictToDict } from "../src/onto/conflict.js";
import { OIR, Origin, round3, oirFromDict } from "../src/onto/oir.js";
import { Role, TemplateSpec, ridFieldKey } from "../src/onto/template.js";

const GOLDEN_DIR = fileURLToPath(new URL("../../golden/", import.meta.url));

interface Pair {
  rid: string;
  field: string;
  value: string;
}
interface GoldenFile {
  read_returned: {
    name: string;
    file: string;
    sheets: ReturnedSheet[];
    returned: Pair[];
  }[];
  tiny_spec: Record<string, unknown>;
  audit: {
    label: string;
    returned: Pair[];
    with_oir: boolean;
    summary: Record<string, unknown>;
    completeness: number;
    findings: Record<string, unknown>[];
    auto_repaired: Record<string, unknown>[];
    diffs: Record<string, unknown>[];
    slips: Record<string, unknown>[];
    oir_after?: Record<string, unknown>;
  }[];
  pipeline_template_empty: {
    summary: Record<string, unknown>;
    findings_count: number;
    first_findings: Record<string, unknown>[];
  };
  merge: {
    label: string;
    returned: Pair[];
    changed: string[];
    dropped: string[];
    oir_after: Record<string, unknown>;
  }[];
  py_round: { x: number; nd: number; out: number }[];
}
const G = JSON.parse(readFileSync(GOLDEN_DIR + "onto.audit.json", "utf-8")) as GoldenFile;

const SPEC = TemplateSpec.fromDict(G.tiny_spec);

function toMap(pairs: readonly Pair[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of pairs) m.set(ridFieldKey(p.rid, p.field), p.value);
  return m;
}

function fromMap(m: Map<string, string>): Pair[] {
  return [...m].map(([k, value]) => {
    const i = k.indexOf("\u0000");
    return { rid: k.slice(0, i), field: k.slice(i + 1), value };
  });
}

/** 与 Python 侧同构的一份小 OIR（golden 的 `oir_after` 就是它跑出来的）。 */
function baseOir(): OIR {
  return oirFromDict(SEED_OIR);
}
const SEED_OIR: Record<string, unknown> = (() => {
  // 从 golden 的 merge 用例里借一份"没被改过"的形态：dropped_unknown_rid 那条
  // 什么都没写回去，它的 oir_after 就是起始状态。手抄一份起始 OIR 等于手写
  // 期望值，两侧一漂就白测。
  const untouched = G.merge.find((m) => m.label === "dropped_unknown_rid");
  if (!untouched) throw new Error("golden 缺 merge/dropped_unknown_rid");
  return untouched.oir_after;
})();

describe("读回传件：锚点对齐", () => {
  for (const book of G.read_returned) {
    it(`${book.name}（按 grid 读）`, () => {
      const got = readReturnedFromSheets(book.sheets);
      expect(fromMap(got)).toEqual(book.returned);
    });

    it(`${book.name}（读真 xlsx 字节，与 openpyxl 同源）`, () => {
      const bytes = readFileSync(GOLDEN_DIR + book.file);
      expect(fromMap(readReturned(bytes))).toEqual(book.returned);
    });
  }

  it("正常表：行内容按 (rid, 字段) 取到，且没有损伤", () => {
    const plain = G.read_returned.find((b) => b.name === "plain")!;
    const got = readReturnedFromSheets(plain.sheets);
    expect(got.get(ridFieldKey("pt_amount_budget", "definition"))).toBe("含税，年度累计");
    expect(got.has(ridFieldKey("__damage__", "__damage__"))).toBe(false);
  });

  it("顶部插行 + 左侧插列：照样读得到，但必须报出结构被动过", () => {
    // 反面就是上一条：位置没变时不该报损伤。报了会天天狼来了，没人再看。
    const shifted = G.read_returned.find((b) => b.name === "shifted")!;
    const got = readReturnedFromSheets(shifted.sheets);
    expect(got.get(ridFieldKey("pt_amount_budget", "definition"))).toBe("含税，年度累计");
    const damage = got.get(ridFieldKey("__damage__", "__damage__"))!;
    expect(damage).toContain("表头在第 3 行、锚点在第 2 列");
  });

  it("锚点列被删：整张表读不回来，且必须说出来", () => {
    // 以前这里是静默 continue —— 一整张 172 行的表凭空消失，没人知道。
    const na = G.read_returned.find((b) => b.name === "no_anchor")!;
    const got = readReturnedFromSheets(na.sheets);
    expect(got.size).toBe(1); // 只剩损伤那一条
    const damage = got.get(ridFieldKey("__damage__", "__damage__"))!;
    expect(damage).toContain("找不到锚点列 _oir_rid");
    expect(damage).toContain("行没有被读取");
  });

  it("锚点被推到扫描窗口之外：同样按读不到处理", () => {
    const far = G.read_returned.find((b) => b.name === "far_anchor")!;
    const got = readReturnedFromSheets(far.sheets);
    expect(got.get(ridFieldKey("__damage__", "__damage__"))).toContain("找不到锚点列");
  });

  it("业务方自己加的说明页读不了是正常的，不报损伤", () => {
    // 判据是行列规模，不是表名 —— 以前靠 `00_` 前缀判，改个表名就能让 19 行消失。
    const ns = G.read_returned.find((b) => b.name === "note_sheet")!;
    const got = readReturnedFromSheets(ns.sheets);
    expect(got.has(ridFieldKey("__damage__", "__damage__"))).toBe(false);
    expect(got.get(ridFieldKey("pt_plan_id", "owner"))).toBe("王明");
  });

  it("复制粘贴出的重复行：后写覆盖先写，且必须报出来", () => {
    const dup = G.read_returned.find((b) => b.name === "duplicated")!;
    const got = readReturnedFromSheets(dup.sheets);
    expect(got.get(ridFieldKey("pt_amount_budget", "definition"))).toBe("复制粘贴出来的");
    expect(got.get(ridFieldKey("__damage__", "__damage__"))).toContain("与前面重复，后者已覆盖前者");
  });

  it("重复检测按表做 —— 同一个 rid 出现在两张表里不算损伤", () => {
    // 跨表去重会把"对象清单和术语表都有这个对象"这种正常结构报成损伤。
    const ms = G.read_returned.find((b) => b.name === "multi_sheet")!;
    const both: ReturnedSheet[] = [ms.sheets[0]!, { ...ms.sheets[0]!, title: "另一张表" }];
    expect(readReturnedFromSheets(both).has(ridFieldKey("__damage__", "__damage__"))).toBe(false);
  });

  it("插进来的空白列不算数据列", () => {
    const bc = G.read_returned.find((b) => b.name === "blank_col")!;
    const got = readReturnedFromSheets(bc.sheets);
    expect([...got.keys()].some((k) => k.endsWith("\u0000"))).toBe(false);
  });

  it("锚点两列（_oir_rid / _oir_hash）本身不是数据列", () => {
    const plain = G.read_returned.find((b) => b.name === "plain")!;
    const got = readReturnedFromSheets(plain.sheets);
    expect(got.has(ridFieldKey("pt_plan_id", "_oir_rid"))).toBe(false);
    expect(got.has(ridFieldKey("pt_plan_id", "_oir_hash"))).toBe(false);
  });
});

describe("golden 逐案比对：审核", () => {
  for (const c of G.audit) {
    it(c.label, () => {
      const oir = c.with_oir ? baseOir() : null;
      const returned = toMap(c.returned);
      const r = new ReturnAuditor().audit(SPEC, returned, { oir });
      expect(r.findings.map(conflictToDict).map(canon)).toEqual(c.findings.map(canon));
      expect(r.autoRepaired).toEqual(c.auto_repaired);
      expect(r.slips.map(slipToDict).map(canon)).toEqual(c.slips.map(canon));
      expect(r.completeness).toBeCloseTo(c.completeness, 12);
      expect(canon(auditSummary(r))).toEqual(canon(c.summary));
      expect(
        r.diffs.map((d) => ({
          rid: d.rid,
          sheet: d.sheet,
          field: d.field,
          before: d.before,
          after: d.after,
          role: d.role,
          owner: d.owner,
          changed: diffChanged(d),
          filled: diffFilled(d),
          untouched_prefill: diffUntouchedPrefill(d),
        })),
      ).toEqual(c.diffs);
      if (c.oir_after !== undefined) expect(oir!.toDict()).toEqual(c.oir_after);
    });
  }

  it("真材料模板 + 空回传：完成度与问题数与 Python 一致", () => {
    const real = TemplateSpec.fromDict(
      JSON.parse(readFileSync(GOLDEN_DIR + "pipeline.template.json", "utf-8")) as Record<
        string,
        unknown
      >,
    );
    const r = new ReturnAuditor().audit(real, new Map());
    expect(canon(auditSummary(r))).toEqual(canon(G.pipeline_template_empty.summary));
    expect(r.findings.length).toBe(G.pipeline_template_empty.findings_count);
    expect(r.findings.slice(0, 8).map(conflictToDict).map(canon)).toEqual(
      G.pipeline_template_empty.first_findings.map(canon),
    );
  });
});

describe("规则：必填缺失（REQ-01）", () => {
  const run = (pairs: Record<string, string>): ReturnType<ReturnAuditor["audit"]> =>
    new ReturnAuditor().audit(SPEC, mk(pairs));

  it("必填空着 → 报；填了 → 不报", () => {
    const empty = run({});
    expect(kinds(empty)[ConflictKind.MISSING_REQUIRED]).toBe(5);
    const filled = run({
      "pt_amount_budget|definition": "不含税、单次结算，由财务共享中心维护",
      "pt_amount_budget|confirmed": "已确认",
      "pt_amount_contract|definition": "含税、年度累计，口径由预算科维护",
      "pt_amount_contract|confirmed": "待确认",
      "ot_采购包|displayName": "采购包（新）",
    });
    expect(kinds(filled)[ConflictKind.MISSING_REQUIRED]).toBeUndefined();
  });

  it("只读格（LOCKED）空着不算缺失 —— 那不是业务方的活", () => {
    const r = run({});
    expect(r.findings.every((c) => !c.summary.includes("note"))).toBe(true);
  });

  it("只有空白的填写等于没填", () => {
    const r = run({ "pt_amount_budget|definition": "   \n  " });
    const hit = r.findings.filter(
      (c) => c.kind === ConflictKind.MISSING_REQUIRED && c.subjects[0] === "pt_amount_budget",
    );
    expect(hit.length).toBe(2); // definition + confirmed 都算没填
  });
});

describe("规则：枚举越界（ENUM-01）", () => {
  it("取值不在允许集合 → 报；在集合里 → 不报", () => {
    const bad = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|confirmed": "差不多确认了" }));
    const c = bad.findings.find((x) => x.kind === ConflictKind.TYPE_MISMATCH)!;
    expect(c.summary).toContain("不在允许集合 已确认、待确认");
    expect(c.detector).toBe("rule:ENUM-01");
    const ok = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|confirmed": "已确认" }));
    expect(kinds(ok)[ConflictKind.TYPE_MISMATCH]).toBeUndefined();
  });

  it("没有 options 的列不做枚举校验（空列表也算没有）", () => {
    // Python 里 `not cell.options` 对空列表为真。照 JS 写成 `!== null` 会让
    // 每一格都判越界 —— 一份满是假问题的打回单等于没有打回单。
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|definition": "随便什么" }));
    expect(kinds(r)[ConflictKind.TYPE_MISMATCH]).toBeUndefined();
  });

  it("空着的枚举格走缺失，不走越界", () => {
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|confirmed": "" }));
    expect(kinds(r)[ConflictKind.TYPE_MISMATCH]).toBeUndefined();
    expect(kinds(r)[ConflictKind.MISSING_REQUIRED]).toBeGreaterThan(0);
  });
});

describe("规则：命名规范（NAME-01）", () => {
  it("中文 / 下划线 apiName → 报并给出可自动应用的选项", () => {
    const r = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_amount_budget|apiName": "计划金额", "pt_amount_contract|apiName": "contract_amount" }),
    );
    // 命名违规是 AUTO_REPAIR 档：没有 oir 时只记账，findings 里被移走
    expect(r.autoRepaired.map((x) => x["to"])).toEqual(["计划金额", "contractAmount"]);
    expect(kinds(r)[ConflictKind.NAMING_VIOLATION]).toBeUndefined();
  });

  it("合规的 lowerCamelCase → 不报", () => {
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|apiName": "planAmountNew" }));
    expect(r.autoRepaired).toEqual([]);
  });

  it("没改过的 apiName 不审 —— 编译期已经合规", () => {
    // 预填值原样交回时 changed=false，这条规则整条跳过。
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|apiName": "planAmount" }));
    expect(r.autoRepaired).toEqual([]);
  });

  it("带 oir 时真的改进模型，并标 AUTO_REPAIRED、记下改前的值", () => {
    const oir = baseOir();
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|apiName": "plan_amount" }), {
      oir,
    });
    expect(r.autoRepaired[0]).toMatchObject({
      field: "apiName",
      to: "planAmount",
      reversible: true,
      from: "计划金额",
    });
    const p = oir.properties.get("pt_amount_budget")!;
    expect(p.apiName.value).toBe("planAmount");
    expect(p.apiName.origin).toBe(Origin.AUTO_REPAIRED);
  });
});

describe("规则：疑似敷衍（PERF-01）", () => {
  const perf = (pairs: Record<string, string>): string[] =>
    new ReturnAuditor()
      .audit(SPEC, mk(pairs))
      .findings.filter((c) => c.kind === ConflictKind.PERFUNCTORY)
      .map((c) => c.summary);

  it("占位符（无/待定）→ 报", () => {
    expect(perf({ "pt_amount_budget|definition": "无" }).join()).toContain("PLACEHOLDER");
  });

  it("太短 → 报；写清楚了 → 不报", () => {
    expect(perf({ "pt_amount_budget|definition": "税" }).join()).toContain("TOO_SHORT");
    expect(perf({ "pt_amount_budget|definition": "含税口径见附表说明" })).toEqual([]);
  });

  it("AI 预填原样交回 → 报，并且点名说这格没被审过", () => {
    const s = perf({ "pt_amount_budget|definition": "含税，年度累计" }).join();
    expect(s).toContain("UNCHANGED_PREFILL");
    expect(s).toContain("AI 预填值被原样交回，这格没有被真正审过");
  });

  it("整列一个值 → 报 BULK_FILLED；只有两行时不报（两行谈不上整列一个值）", () => {
    // 阈值是离散度 < 0.2，两行填一样是 1/2 = 0.5 —— 不该触发。这条正好是
    // 误报的边界：小表上按重复率判会把认真填的两行也打回。
    expect(
      perf({
        "pt_amount_budget|definition": "以实际发生额为准，具体口径参见财务制度",
        "pt_amount_contract|definition": "以实际发生额为准，具体口径参见财务制度",
      }),
    ).toEqual([]);
    const cell = SPEC.byRid().get(ridFieldKey("pt_amount_budget", "definition"))!;
    const d = makeCellDiff({
      rid: "pt_amount_budget",
      sheet: "s",
      field: "definition",
      before: "",
      after: "以实际发生额为准，具体口径参见财务制度",
      role: Role.REQUIRED,
    });
    expect(cellSignals(d, cell, 0.1)).toEqual(["BULK_FILLED"]);
    expect(cellSignals(d, cell, 0.5)).toEqual([]);
  });

  it("枚举列整列一个值 → **不**报 —— 它本来取值就少", () => {
    // 这是误报的重灾区：按重复率判会把正常填写的枚举列全部打回。
    expect(perf({ "pt_amount_budget|confirmed": "已确认", "pt_amount_contract|confirmed": "已确认" })).toEqual(
      [],
    );
  });

  it("把列名抄进格子 → 报 COPIED_HEADER", () => {
    expect(perf({ "pt_amount_budget|definition": "definition" }).join()).toContain("COPIED_HEADER");
  });

  it("cellSignals：非自由文本列不套「太短/整列一个值」这两条", () => {
    const d = makeCellDiff({
      rid: "x",
      sheet: "s",
      field: "confirmed",
      before: "",
      after: "是",
      role: Role.REQUIRED,
    });
    expect(cellSignals(d, undefined, 0.01)).toEqual([]);
    const cell = SPEC.byRid().get(ridFieldKey("pt_amount_budget", "definition"))!;
    expect(cellSignals({ ...d, field: "definition" }, cell, 0.01)).toEqual([
      "TOO_SHORT",
      "BULK_FILLED",
    ]);
  });
});

describe("规则：口径矛盾（AXIS-01）", () => {
  it("同族两条口径在税轴上冲突 → 报，并点名两个责任人", () => {
    const r = new ReturnAuditor().audit(
      SPEC,
      mk({
        "pt_amount_budget|definition": "含税口径，按发票金额统计",
        "pt_amount_contract|definition": "不含税口径，按净额统计",
      }),
    );
    const c = r.findings.find((x) => x.kind === ConflictKind.SEMANTIC_DIVERGENCE)!;
    expect(c.summary).toContain("税（含税 vs 不含税）");
    expect(c.summary).toContain("需 李强、王明 对齐");
    expect(c.subjects).toEqual(["pt_amount_budget", "pt_amount_contract"]);
  });

  it("两条口径同轴同值 → 不报（那是一致，不是矛盾）", () => {
    const r = new ReturnAuditor().audit(
      SPEC,
      mk({
        "pt_amount_budget|definition": "含税口径，按发票金额统计",
        "pt_amount_contract|definition": "含税口径，按发票统计",
      }),
    );
    expect(kinds(r)[ConflictKind.SEMANTIC_DIVERGENCE]).toBeUndefined();
  });

  it("一边识别不出轴 → 不报（那是信息缺失，不是矛盾）", () => {
    const r = new ReturnAuditor().audit(
      SPEC,
      mk({
        "pt_amount_budget|definition": "含税口径，按发票金额统计",
        "pt_amount_contract|definition": "由业务部门自行确认后补充说明",
      }),
    );
    expect(kinds(r)[ConflictKind.SEMANTIC_DIVERGENCE]).toBeUndefined();
  });

  it("多轴分歧的轴序由 conflict.ts 定（Python 那边每跑一次都可能不同）", () => {
    // Python 的 `pa.keys() & pb.keys()` 是 set，顺序随 str 哈希种子变 ——
    // 也就是**同一份回传件审两次，打回单文案可能不一样**。TS 侧是确定的。
    const run = (): string =>
      new ReturnAuditor()
        .audit(
          SPEC,
          mk({
            "pt_amount_budget|definition": "含税、年度累计，按发票金额统计",
            "pt_amount_contract|definition": "不含税、单次，按净额统计",
          }),
        )
        .findings.find((x) => x.kind === ConflictKind.SEMANTIC_DIVERGENCE)!.summary;
    expect(run()).toBe(run());
    expect(run()).toContain("税（含税 vs 不含税）、时间粒度（年度累计 vs 单次）");
  });
});

describe("结构损伤：拦住流程", () => {
  it("损伤进 findings，不只进 summary 的一个角落", () => {
    // 只放进 summary 的列表会被完成度、打回单淹没，而它的后果比任何一条填错
    // 都严重：一整张表的人白填了，且收不到任何提示。
    const returned = mk({});
    returned.set(ridFieldKey("__damage__", "__damage__"), "「01_对象清单」找不到锚点列\n第二条");
    const r = new ReturnAuditor().audit(SPEC, returned);
    expect(auditReadable(r)).toBe(false);
    expect(r.damage).toEqual(["「01_对象清单」找不到锚点列", "第二条"]);
    const c = r.findings.find((x) => x.rid === "cf_return_damaged")!;
    expect(c.detector).toBe("rule:return_structure");
    expect(c.summary).toContain("有内容没能读回来");
  });

  it("损伤那条被从 returned 里摘掉 —— 不能被当成一个新行", () => {
    const returned = mk({});
    returned.set(ridFieldKey("__damage__", "__damage__"), "x");
    const r = new ReturnAuditor().audit(SPEC, returned);
    expect(r.newRows).toEqual([]);
    expect(returned.has(ridFieldKey("__damage__", "__damage__"))).toBe(false);
  });

  it("没有损伤时 readable 为真、damage 为空", () => {
    const r = new ReturnAuditor().audit(SPEC, mk({}));
    expect(auditReadable(r)).toBe(true);
    expect(r.damage).toEqual([]);
  });
});

describe("对齐与完成度", () => {
  it("没交回来的行进 unmatchedRows，多出来的进 newRows", () => {
    const r = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_不认识的|definition": "业务方自己加的一行", "pt_amount_budget|definition": "含税，按发票" }),
    );
    expect(r.newRows).toEqual(["pt_不认识的"]);
    expect(r.unmatchedRows).toContain("pt_amount_contract");
    expect(r.unmatchedRows).toEqual([...r.unmatchedRows].sort());
  });

  it("完成度只算业务必填，且原样交回的预填不算已填", () => {
    const zero = new ReturnAuditor().audit(SPEC, mk({}));
    expect(zero.completeness).toBe(0);
    const prefillBack = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_amount_budget|definition": "含税，年度累计" }),
    );
    expect(prefillBack.completeness).toBe(0);
    const real = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_amount_budget|definition": "不含税、单次结算，由财务共享中心维护" }),
    );
    expect(real.completeness).toBeGreaterThan(0);
  });

  it("完成度是加权的 —— definition(4.0) 比 confirmed(1.0) 值钱", () => {
    const a = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_amount_budget|definition": "不含税、单次结算，由财务共享中心维护" }),
    );
    const b = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|confirmed": "已确认" }));
    expect(a.completeness).toBeGreaterThan(b.completeness);
  });

  it("命中敷衍信号的格子不计入完成度", () => {
    const real = new ReturnAuditor().audit(
      SPEC,
      mk({ "pt_amount_budget|definition": "不含税、单次结算，由财务共享中心维护" }),
    );
    const lazy = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|definition": "无" }));
    expect(lazy.completeness).toBe(0);
    expect(real.completeness).toBeGreaterThan(0);
  });

  it("没有必填格时完成度是 1.0，不是 0（除零陷阱）", () => {
    const empty = new ReturnAuditor();
    expect(empty.completeness([])).toBe(1.0);
    expect(
      empty.completeness([
        makeCellDiff({ rid: "a", sheet: "s", field: "note", before: "", after: "", role: Role.LOCKED }),
      ]),
    ).toBe(1.0);
  });

  it("target 是构造参数，默认 0.95", () => {
    expect(new ReturnAuditor().target).toBe(0.95);
    expect(new ReturnAuditor({ target: 0.8 }).target).toBe(0.8);
  });
});

describe("打回单", () => {
  it("按责任人分组、条数多的在前，没有责任人的归「未分派」", () => {
    // 打回给"团队"等于打回给没有人。
    const r = new ReturnAuditor().audit(SPEC, mk({}));
    const slips = r.slips.map(slipToDict);
    expect(slips.map((s) => s["owner"])).toEqual(["王明", "李强", "未分派"]);
    expect(slips[0]!["count"]).toBe(2);
    expect(Object.keys(slips[0]!["by_kind"] as object)).toEqual(["missing_required"]);
  });

  it("只有 ROUND_TRIP / ASK_USER 进打回单 —— AUTO_REPAIR 不占人的注意力", () => {
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|apiName": "计划金额" }));
    expect(r.autoRepaired.length).toBe(1); // 命名违规确实被抓到了
    // 但它不该出现在任何人的打回单里 —— 系统自己就修好了
    const all = r.slips.flatMap((s) => s.items.map((c) => c.kind));
    expect(all).not.toContain(ConflictKind.NAMING_VIOLATION);
    expect(new Set(all)).toEqual(new Set([ConflictKind.MISSING_REQUIRED]));
  });
});

describe("回写 OIR", () => {
  for (const c of G.merge) {
    it(`golden：${c.label}`, () => {
      const oir = baseOir();
      const r = new ReturnAuditor().audit(SPEC, toMap(c.returned));
      const [changed, dropped] = mergeIntoOir(oir, r.diffs);
      expect(changed).toEqual(c.changed);
      expect(dropped).toEqual(c.dropped);
      expect(oir.toDict()).toEqual(c.oir_after);
    });
  }

  it("写回的内容标 USER 来源", () => {
    const oir = baseOir();
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|definition": "不含税、单次" }));
    mergeIntoOir(oir, r.diffs);
    const p = oir.properties.get("pt_amount_budget")!;
    expect(p.definition.value).toBe("不含税、单次");
    expect(p.definition.origin).toBe(Origin.USER);
  });

  it("原样交回的预填不写回 —— 那格没有被人认领过", () => {
    const oir = baseOir();
    const before = JSON.stringify(oir.toDict());
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|definition": "含税，年度累计" }));
    const [changed] = mergeIntoOir(oir, r.diffs);
    expect(changed).toEqual([]);
    expect(JSON.stringify(oir.toDict())).toBe(before);
  });

  it("没有回写路径的列必须报出来，不许静默丢弃", () => {
    // 实测过的黑洞：627 格被判为真正填写，只有 172 条落回 OIR。
    const oir = baseOir();
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_amount_budget|confirmed": "已确认" }));
    const [changed, dropped] = mergeIntoOir(oir, r.diffs);
    expect(changed).toEqual([]);
    expect(dropped).toEqual(["pt_amount_budget.confirmed（没有回写路径）"]);
  });

  it("找不到条目的也要报出来", () => {
    const oir = baseOir();
    const r = new ReturnAuditor().audit(SPEC, mk({ "pt_不认识的|definition": "x" }));
    const [, dropped] = mergeIntoOir(oir, r.diffs);
    expect(dropped).toEqual([]); // 这个 rid 不在模板里，压根不会产生 diff
  });

  it("往没有该字段的实体上回写会抛，不会静默造一个没人读的键", () => {
    const oir = baseOir();
    const d = makeCellDiff({
      rid: "br_1",
      sheet: "s",
      field: "displayName",
      before: "",
      after: "改个名",
      role: Role.REQUIRED,
    });
    expect(() => mergeIntoOir(oir, [d])).toThrow(/AttributeError/);
  });

  it("答复写回问题：同时把状态改成 CONFIRMED —— 待办变成事实", () => {
    const oir = baseOir();
    const d = makeCellDiff({
      rid: "oq_1",
      sheet: "s",
      field: "答复",
      before: "",
      after: "上限是 500 万",
      role: Role.REQUIRED,
    });
    const [changed] = mergeIntoOir(oir, [d]);
    expect(changed).toEqual(["oq_1.答复"]);
    const q = oir.questions.get("oq_1")!;
    expect(q.answer.value).toBe("上限是 500 万");
    expect(q.status).toBe("confirmed");
  });

  it("「这条对吗」三态：对 / 不对 / 其它", () => {
    const mkD = (after: string) =>
      makeCellDiff({
        rid: "br_1",
        sheet: "s",
        field: "这条对吗",
        before: "",
        after,
        role: Role.REQUIRED,
      });
    for (const [ans, status] of [
      ["对", "confirmed"],
      ["不对", "rejected"],
      ["说不好", "proposed"],
    ] as const) {
      const oir = baseOir();
      mergeIntoOir(oir, [mkD(ans)]);
      expect(oir.rules.get("br_1")!.status).toBe(status);
    }
  });

  it("「管哪个单据」按显示名解析；一个都对不上要报出来", () => {
    const oir = baseOir();
    const good = makeCellDiff({
      rid: "br_1",
      sheet: "s",
      field: "管哪个单据",
      before: "",
      after: "采购包",
      role: Role.REQUIRED,
    });
    expect(mergeIntoOir(oir, [good])[0]).toEqual(["br_1.管哪个单据"]);
    expect(oir.rules.get("br_1")!.appliesTo).toEqual(["ot_采购包"]);

    const oir2 = baseOir();
    const bad = { ...good, after: "根本不存在的单据" };
    const [changed, dropped] = mergeIntoOir(oir2, [bad]);
    expect(changed).toEqual([]);
    expect(dropped[0]).toContain("对不上任何对象");
  });

  it("primaryKey / effects 的中英文顿号都能拆", () => {
    const oir = baseOir();
    const d = makeCellDiff({
      rid: "ot_采购包",
      sheet: "s",
      field: "primaryKey",
      before: "",
      after: "planId，orgId、 lineNo ",
      role: Role.REQUIRED,
    });
    mergeIntoOir(oir, [d]);
    expect(oir.objects.get("ot_采购包")!.primaryKey.value).toEqual([
      "planId",
      "orgId",
      "lineNo",
    ]);
  });
});

describe("pyRound", () => {
  for (const v of G.py_round) {
    it(`round(${v.x}, ${v.nd}) === ${v.out}`, () => {
      expect(pyRound(v.x, v.nd)).toBe(v.out);
    });
  }

  it("与 oir.ts 已被 golden 钉死的 round3 在 3 位上完全一致", () => {
    // round3 是同一套 half-even 逻辑的 3 位特化，已有 golden。两者对不上就是
    // 这份推广版写错了。
    for (const x of [0.0625, 0.1235, 0.1245, 2.5e-4, -0.0001, 0, 1 / 3, 0.9995, 123.4565]) {
      expect(pyRound(x, 3)).toBe(round3(x));
    }
  });

  it("非有限值原样返回", () => {
    expect(pyRound(Number.NaN, 4)).toBeNaN();
    expect(pyRound(Infinity, 4)).toBe(Infinity);
  });
});

// ── 小工具 ──────────────────────────────────────────────────────

/** `"rid|field": value` 的简写。 */
function mk(pairs: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(pairs)) {
    const i = k.indexOf("|");
    m.set(ridFieldKey(k.slice(0, i), k.slice(i + 1)), v);
  }
  return m;
}

function kinds(r: { findings: { kind: string }[] }): Record<string, number> {
  return auditCounts(r as Parameters<typeof auditCounts>[0]);
}

/** JSON 往返一次抹平 Map / undefined 的形态差异，顺带归一口径矛盾的轴序。
 *
 * 轴序是**Python 侧自己就不确定**的：`axis_diff` 返回 `pa.keys() & pb.keys()`，
 * set 的迭代序随 str 哈希种子变，同一份回传件审两次文案可能不同（golden 导出
 * 因此固定了 PYTHONHASHSEED=0）。`conflict.ts` 把它定成了 AXES 声明序。
 * 这里只比**内容**，顺序留给各自，免得把一条真 bug 伪装成两边不一致。 */
function canon<T>(v: T): unknown {
  return walk(JSON.parse(JSON.stringify(v)));
}

const DIVERGENCE_HEAD = "回传后仍存在口径矛盾：";

function walk(v: unknown): unknown {
  if (typeof v === "string") return normalizeAxes(v);
  if (Array.isArray(v)) return v.map(walk);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  }
  return v;
}

function normalizeAxes(s: string): string {
  if (!s.startsWith(DIVERGENCE_HEAD)) return s;
  const body = s.slice(DIVERGENCE_HEAD.length);
  const at = body.indexOf("，需 ");
  const axes = at < 0 ? body : body.slice(0, at);
  const tail = at < 0 ? "" : body.slice(at);
  return DIVERGENCE_HEAD + axes.split("、").sort().join("、") + tail;
}

describe("B10：回传基数过枚举闸", () => {
  it("常见手填写法归一：一对多/1:N/M:N", async () => {
    const { normalizeCardinality } = await import("../src/onto/audit.js");
    expect(normalizeCardinality("一对多")).toBe("ONE_TO_MANY");
    expect(normalizeCardinality("1:n")).toBe("ONE_TO_MANY");
    expect(normalizeCardinality(" M:N ")).toBe("MANY_TO_MANY");
    expect(normalizeCardinality("one_to_one")).toBe("ONE_TO_ONE");
  });

  it("**多对一归一不了** —— 这里改的是已存在关系的基数、动不了方向，悄悄转成一对多会反转语义", async () => {
    const { normalizeCardinality } = await import("../src/onto/audit.js");
    expect(normalizeCardinality("多对一")).toBeNull();
    expect(normalizeCardinality("N:1")).toBeNull();
  });

  it("认不出的写法返回 null —— 由调用方降级成待确认，不丢不收", async () => {
    const { normalizeCardinality } = await import("../src/onto/audit.js");
    expect(normalizeCardinality("大概一对多吧")).toBeNull();
  });
});
