/**
 * `onto/gaps.ts` + `onto/questions.ts` 的 golden 校验。
 *
 * 这两个模块合起来是「给 ERP 顾问填的问题清单」那份交付物的产生逻辑：
 * gaps 决定**问什么**（从证据里挖，不是照抄某份材料的问卷），
 * questions 决定**怎么排、怎么答、怎么改**（排序一漂，交付物的顺序就变了）。
 *
 * 三份 golden：
 *   - `golden/pipeline.oir.json` —— 真材料（材料.xlsx）跑出来的完整 OIR，
 *     里面那 5 条问题**就是** mine_questions 挖出来的。端到端断言用它。
 *   - `golden/gaps.json` —— `tools/golden/gaps.py` 导出。四条挖掘通道逐条判据，
 *     每条都带一个"该问的问出来了"和一个"不该问的没问"，外加 Python/JS 分叉。
 *   - `golden/questions.json` —— `tools/golden/questions.py` 导出。状态机全矩阵、
 *     排序、幂等、校验消息。
 *
 * 期望值一律来自 golden，不手写 —— 手写的是我对 Python 行为的猜测。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  alignmentGaps,
  emptyContainers,
  enumerations,
  type Gap,
  type GapChunk,
  type GapDoc,
  gapToQuestion,
  makeGap,
  mineQuestions,
  structuralGaps,
  undeterminedSlots,
  type UncertainPair,
} from "../src/onto/gaps.js";
import {
  oirFromDict,
  type OpenQuestion,
  provToDict,
  questionToDict,
} from "../src/onto/oir.js";
import {
  answerQuestion,
  buildQuestionBacklog,
  Decision,
  DecisionLedger,
  PatchOp,
  PatchSet,
  Question,
  QuestionBacklog,
  QuestionPriority,
  type QuestionInit,
  QuestionStatus,
  Revision,
  type RevisionStatus,
  timeSource,
} from "../src/onto/questions.js";

const readGolden = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, "../../golden", name), "utf8")) as Record<
    string,
    unknown
  >;

type Dict = Record<string, unknown>;

const PIPELINE = readGolden("pipeline.oir.json");
const G = readGolden("gaps.json") as unknown as {
  slots: { name: string; chunks: GapChunk[]; limit: number; gaps: Dict[] }[];
  empty: { name: string; docs: GapDoc[]; gaps: Dict[] }[];
  enums: { name: string; chunks: GapChunk[]; limit: number; gaps: Dict[] }[];
  struct: { name: string; oir: Dict; gaps: Dict[] }[];
  align: {
    oir: Dict;
    cases: { name: string; uncertain: UncertainPair[]; limit: number; gaps: Dict[] }[];
  };
  mine: {
    name: string;
    docs: GapDoc[];
    chunks: GapChunk[];
    extra: Dict[];
    extra_gaps: Dict[];
    limit: number;
    questions: Dict[];
    oir?: Dict;
  }[];
  material: {
    chunks: GapChunk[];
    docs: GapDoc[];
    undetermined_slots: Dict[];
    empty_containers: Dict[];
    enumerations: Dict[];
    structural_gaps: Dict[];
    questions: Dict[];
  };
};

type ErrShape = { ok: boolean; value?: unknown; error?: string; message?: string };

const Q = readGolden("questions.json") as unknown as {
  schema_version: string;
  now: number;
  statuses: string[];
  priorities: string[];
  revision_statuses: string[];
  round_trip: { question: Dict; round_trip: Dict };
  from_dict: { name: string; raw: Dict; question: Dict; round_trip: Dict }[];
  from_legacy: { name: string; open_question: Dict; question: Dict }[];
  from_legacy_errors: { input: string; result: ErrShape }[];
  transitions: {
    from: string;
    to: string;
    owner: string;
    result: ErrShape;
    after: { status: string; updated_at: number; version: number };
  }[];
  assign: { name: string; result: ErrShape; after: Dict }[];
  next_batch: {
    name: string;
    batch?: string[];
    all?: string[];
    stats?: Dict;
    to_dict_order?: string[];
    zero?: string[];
    negative?: string[];
  }[];
  backlog_lifecycle: { preserved: Dict; not_preserved: Dict };
  build_backlog: { open_question: Dict; card: Dict; conflicts: Dict[]; backlog: Dict };
  decisions: Dict;
  decision_from_dict: { name: string; raw: Dict; decision: Dict }[];
  answer_question: Dict;
  patch: Dict;
  validate: {
    cases: { name: string; schema: Dict; value: unknown; result: ErrShape }[];
    divergent: { name: string; schema: Dict; value: unknown; js: string; result: ErrShape }[];
  };
};

// ══════════════════════════════════════════════════════════════════
//  公共件
// ══════════════════════════════════════════════════════════════════

/** 与 `tools/golden/gaps.py` 的 `gap_d` 同形。prov 走 oir 的 `provToDict`。 */
function gapD(g: Gap): Dict {
  return {
    text: g.text,
    group: g.group,
    kind: g.kind,
    prov: g.prov ? provToDict(g.prov) : null,
    options: g.options,
    applies_to: g.appliesTo,
    weight: g.weight,
  };
}

const gapsD = (gs: Gap[]): Dict[] => gs.map(gapD);

/** golden 里的 gap 字典还原成 Gap（只在 extra_gaps 上用，那些都没有 prov）。 */
function gapFrom(d: Dict): Gap {
  return makeGap({
    text: d["text"] as string,
    group: d["group"] as string,
    kind: d["kind"] as string,
    prov: null,
    options: (d["options"] as string[] | null) ?? null,
    appliesTo: (d["applies_to"] as string[] | null) ?? null,
    weight: d["weight"] as number,
  });
}

/** golden 里的 `OpenQuestion.to_dict()` 列表还原成 OIR 的 OpenQuestion。
 * 走 `oirFromDict` 而不是手搓 —— 那条路已经被 oir 的 golden 钉过一遍了。 */
function openQuestionsFrom(rows: Dict[]): OpenQuestion[] {
  return [...oirFromDict({ questions: rows }).questions.values()];
}

/** 把一次调用的"抛没抛、抛的什么"整理成与 Python `err()` 同形的结构。 */
function callErr(fn: () => unknown): ErrShape {
  try {
    const value = fn();
    return { ok: true, value: value === undefined ? null : value };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name, message: err.message };
  }
}

/** 与 `tools/golden/questions.py` 的 `base_question` 同形。 */
function baseQuestion(id = "q.threshold", over: Partial<QuestionInit> = {}): Question {
  return new Question({
    id,
    text: "金额正好等于50万元时是否需要总监审批？",
    answerSchema: { type: "boolean" },
    priority: QuestionPriority.BLOCKING,
    blockedArtifacts: ["rule.approval", "flow.gateway.approval"],
    createdAt: 100.0,
    updatedAt: 100.0,
    ...over,
  });
}

// ══════════════════════════════════════════════════════════════════
//  gaps —— 1. 材料自己写下的未定参数
// ══════════════════════════════════════════════════════════════════
describe("undeterminedSlots —— 客户自己标出来的待办", () => {
  for (const c of G.slots) {
    it(c.name, () => {
      expect(gapsD(undeterminedSlots(c.chunks, { limit: c.limit }))).toEqual(c.gaps);
    });
  }

  it("默认 limit 是 40", () => {
    // 每句一个占位符、句子各不相同 —— 50 句进去只出 40 条。
    const chunks: GapChunk[] = [];
    for (let i = 0; i < 50; i++) {
      chunks.push({
        file_id: "f1",
        file_name: "x.xlsx",
        locator: { kind: "range", sheet: "业务规则", rows: [i, i] },
        render: `第${i}条：如提前XX天预警，责任人待定；`,
      });
    }
    expect(undeterminedSlots(chunks)).toHaveLength(40);
  });
});

// ══════════════════════════════════════════════════════════════════
//  gaps —— 2. 声明了却空着的容器
// ══════════════════════════════════════════════════════════════════
describe("emptyContainers —— 有名字没内容的表", () => {
  for (const c of G.empty) {
    it(c.name, () => {
      expect(gapsD(emptyContainers(c.docs))).toEqual(c.gaps);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  gaps —— 3. 成套的取值清单
// ══════════════════════════════════════════════════════════════════
describe("enumerations —— 取值清单的完整性", () => {
  for (const c of G.enums) {
    it(c.name, () => {
      expect(gapsD(enumerations(c.chunks, { limit: c.limit }))).toEqual(c.gaps);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  gaps —— 4. 结构缺口
// ══════════════════════════════════════════════════════════════════
describe("structuralGaps —— OIR 建出来之后才暴露的空位", () => {
  for (const c of G.struct) {
    it(c.name, () => {
      expect(gapsD(structuralGaps(oirFromDict(c.oir)))).toEqual(c.gaps);
    });
  }
});

describe("alignmentGaps —— 「这俩是不是一个东西」", () => {
  // OIR 也从 golden 来。手搓一份"形状差不多"的必然漏掉 evidence，而 `prov` 就是从
  // evidence 上取的 —— 真踩过：四条用例全红在 prov=null。
  const alignOir = (): ReturnType<typeof oirFromDict> => oirFromDict(G.align.oir);

  for (const c of G.align.cases) {
    it(c.name, () => {
      expect(gapsD(alignmentGaps(alignOir(), c.uncertain, c.limit))).toEqual(c.gaps);
    });
  }

  it("uncertain 传 null 时什么都不说", () => {
    expect(alignmentGaps(alignOir())).toEqual([]);
  });
});


// ══════════════════════════════════════════════════════════════════
//  gaps —— 汇总
// ══════════════════════════════════════════════════════════════════
describe("mineQuestions —— 四条通道一起挖、排序、去重、名额", () => {
  for (const c of G.mine) {
    it(c.name, () => {
      const oir = oirFromDict(c.oir ?? {});
      const out = mineQuestions(oir, {
        docs: c.docs,
        chunks: c.chunks,
        extra: openQuestionsFrom(c.extra),
        extraGaps: c.extra_gaps.map(gapFrom),
        limit: c.limit,
      });
      expect(out.map(questionToDict)).toEqual(c.questions);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  gaps —— 真材料端到端
// ══════════════════════════════════════════════════════════════════
describe("真材料（材料.xlsx）端到端", () => {
  const M = G.material;
  const oir = oirFromDict(PIPELINE);

  it("占位符：材料里两处 XX 都问出来了", () => {
    expect(gapsD(undeterminedSlots(M.chunks))).toEqual(M.undetermined_slots);
  });

  it("空容器：「实体间关系-待梳理」那张空表", () => {
    expect(gapsD(emptyContainers(M.docs))).toEqual(M.empty_containers);
  });

  it("取值清单：进度状态标准的六个取值", () => {
    expect(gapsD(enumerations(M.chunks))).toEqual(M.enumerations);
  });

  it("结构缺口：7 个对象都没有口径", () => {
    expect(gapsD(structuralGaps(oir))).toEqual(M.structural_gaps);
  });

  it("同一份 OIR 进去，挖出来的问题与 Python 一致", () => {
    const out = mineQuestions(oir, { docs: M.docs, chunks: M.chunks });
    expect(out.map(questionToDict)).toEqual(M.questions);
  });

  it("挖出来的这 5 条就是 pipeline.oir.json 里那 5 条", () => {
    const out = mineQuestions(oir, { docs: M.docs, chunks: M.chunks });
    const pipelineQs = PIPELINE["questions"] as Dict[];
    expect(out.map((q) => q.rid)).toEqual(pipelineQs.map((q) => q["rid"]));
  });
});

describe("gapToQuestion", () => {
  it("没有出处的缺口产出没有 evidence 的问题", () => {
    const q = gapToQuestion(makeGap({ text: "问一句", group: "g", kind: "k", weight: 1 }));
    expect(q.text.evidence).toEqual([]);
    expect(q.askedBy).toBe("system");
    expect(q.code).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  questions
// ══════════════════════════════════════════════════════════════════
/** 真实时钟。要在 `beforeEach` 把它换掉之前抓住引用。 */
const REAL_NOW = timeSource.now;

beforeEach(() => {
  // Python 侧导出时把 `time.time` 换成了常量时钟；这里对等地钉住。
  // 不钉的话 createdAt 落到当前时间，`缺 createdAt 时落到当前时间`那条对不上。
  timeSource.now = (): number => Q.now;
});

describe("时钟", () => {
  it("默认实现是**秒**，不是毫秒", () => {
    // Python 的 `time.time()` 给秒。写成 `Date.now()` 会让 createdAt 差三个数量级，
    // 而 createdAt 是 `nextBatch` 和 `toDict` 两处排序的键 —— golden 里那些用例
    // 全都显式传了时间，挡不住这一条，只能在这里直接量它。
    expect(Math.abs(REAL_NOW() - Date.now() / 1000)).toBeLessThan(2);
  });
});

describe("枚举的线上取值", () => {
  it("三个枚举的取值与顺序", () => {
    expect(Object.values(QuestionStatus)).toEqual(Q.statuses);
    expect(Object.values(QuestionPriority)).toEqual(Q.priorities);
    expect(Q.revision_statuses).toEqual(["proposed", "applied", "rejected", "rolled_back"]);
  });
});

describe("Question 的往返契约", () => {
  it("to_dict / from_dict 原样回来", () => {
    const q = baseQuestion("q.threshold", {
      ownerUserId: "user.chen",
      audienceRole: "business_owner",
      dependencies: ["q.amount_basis"],
      evidenceIds: ["ev.221"],
    });
    expect(q.toDict()).toEqual(Q.round_trip.question);
    expect(Question.fromDict(q.toDict()).toDict()).toEqual(Q.round_trip.round_trip);
  });
});

describe("Question.fromDict —— 兼容层的每一条取值规则", () => {
  for (const c of Q.from_dict) {
    it(c.name, () => {
      const q = Question.fromDict(c.raw);
      expect(q.toDict()).toEqual(c.question);
      expect(Question.fromDict(q.toDict()).toDict()).toEqual(c.round_trip);
    });
  }
});

describe("Question.fromLegacy —— OIR 的 OpenQuestion 进统一队列", () => {
  for (const c of Q.from_legacy) {
    it(c.name, () => {
      const oq = openQuestionsFrom([c.open_question])[0]!;
      // 按形状识别出 OIR 的 OpenQuestion 之后，必须与 Python 的
      // `hasattr(raw,"to_dict")` 那条路同结果 —— 尤其是 evidenceIds。
      expect(Question.fromLegacy(oq).toDict()).toEqual(c.question);
    });
  }

  it("Question 进去是浅拷贝，不是同一个对象", () => {
    const q = baseQuestion();
    const c = Question.fromLegacy(q);
    expect(c).not.toBe(q);
    expect(c.toDict()).toEqual(q.toDict());
  });

  for (const c of Q.from_legacy_errors) {
    it(`拒绝：${c.input}`, () => {
      const raw =
        c.input === "一个字符串"
          ? "x"
          : c.input === "一个列表"
            ? [1, 2]
            : c.input === "None"
              ? null
              : 7;
      expect(callErr(() => Question.fromLegacy(raw))).toEqual(c.result);
    });
  }
});

describe("Question 的状态机", () => {
  // 6 状态 × 7 目标 × 有无 owner = 84 条，全矩阵与 Python 逐条对齐。
  for (const c of Q.transitions) {
    it(`${c.from} → ${c.to}${c.owner ? "（有 owner）" : ""}`, () => {
      const q = baseQuestion("q.threshold", {
        status: c.from as QuestionStatus,
        ownerUserId: c.owner,
      });
      expect(callErr(() => q.transition(c.to, { now: 200.0 }))).toEqual(c.result);
      expect({ status: q.status, updated_at: q.updatedAt, version: q.version }).toEqual(
        c.after,
      );
    });
  }

  it("转到当前状态是空操作，不加 version", () => {
    const q = baseQuestion();
    q.transition(QuestionStatus.OPEN, { now: 999.0 });
    expect([q.version, q.updatedAt]).toEqual([0, 100.0]);
  });

  it("now=0 落回当前时间（Python 的 `now or _now()`）", () => {
    const q = baseQuestion("q.x", { ownerUserId: "u1" });
    q.transition(QuestionStatus.ASSIGNED, { now: 0 });
    expect(q.updatedAt).toBe(Q.now);
  });
});

describe("Question.assign", () => {
  for (const [i, c] of Q.assign.entries()) {
    it(c.name, () => {
      let q: Question;
      let run: () => unknown;
      switch (i) {
        case 0:
          q = baseQuestion();
          run = () => q.assign("u1", { audienceRole: "process_owner", now: 101.0 });
          break;
        case 1:
          q = baseQuestion("q.threshold", {
            status: QuestionStatus.ASSIGNED,
            ownerUserId: "u1",
          });
          run = () => q.assign("u2", { now: 102.0 });
          break;
        case 2:
          q = baseQuestion();
          run = () => q.assign("   ");
          break;
        case 3:
          q = baseQuestion("q.threshold", { status: QuestionStatus.ANSWERED });
          run = () => q.assign("u1");
          break;
        case 4:
          q = baseQuestion();
          run = () => q.assign("  u1  ", { audienceRole: "  erp  ", now: 103.0 });
          break;
        default:
          q = baseQuestion("q.threshold", { audienceRole: "旧角色" });
          run = () => q.assign("u1", { now: 104.0 });
      }
      expect(callErr(run)).toEqual(c.result);
      expect(q.toDict()).toEqual(c.after);
    });
  }
});

describe("QuestionBacklog.nextBatch —— 交付顺序", () => {
  it("依赖 / 角色 / 优先级三重过滤", () => {
    const c = Q.next_batch[0]!;
    const bag = new QuestionBacklog();
    bag.add(baseQuestion("q.root", { status: QuestionStatus.ANSWERED }));
    bag.add(
      baseQuestion("q.ready", {
        dependencies: ["q.root"],
        audienceRole: "business_owner",
        informationGain: 0.8,
        blastRadius: 4,
      }),
    );
    bag.add(
      baseQuestion("q.blocked", {
        dependencies: ["q.missing"],
        audienceRole: "business_owner",
      }),
    );
    bag.add(
      baseQuestion("q.erp", {
        priority: QuestionPriority.HIGH,
        audienceRole: "erp_consultant",
        blockedArtifacts: [],
      }),
    );
    expect(
      bag.nextBatch({ limit: 5, audienceRole: "business_owner" }).map((q) => q.id),
    ).toEqual(c.batch);
    expect(bag.nextBatch({ limit: 10 }).map((q) => q.id)).toEqual(c.all);
    expect(bag.stats()).toEqual(c.stats);
  });

  it("按优先级权重排", () => {
    const c = Q.next_batch[1]!;
    const bag = new QuestionBacklog();
    for (const [id, pri] of [
      ["q.low", QuestionPriority.LOW],
      ["q.normal", QuestionPriority.NORMAL],
      ["q.high", QuestionPriority.HIGH],
      ["q.blocking", QuestionPriority.BLOCKING],
    ] as const) {
      bag.add(baseQuestion(id, { priority: pri, blockedArtifacts: [] }));
    }
    expect(bag.nextBatch({ limit: 10 }).map((q) => q.id)).toEqual(c.batch);
  });

  it("信息增益 × 影响半径（blastRadius=0 按 1 算）", () => {
    const c = Q.next_batch[2]!;
    const bag = new QuestionBacklog();
    for (const [id, gain, blast] of [
      ["q.a", 0.5, 0],
      ["q.b", 0.5, 3],
      ["q.c", 0.9, 1],
      ["q.d", 0.0, 100],
    ] as const) {
      bag.add(
        baseQuestion(id, { informationGain: gain, blastRadius: blast, blockedArtifacts: [] }),
      );
    }
    expect(bag.nextBatch({ limit: 10 }).map((q) => q.id)).toEqual(c.batch);
  });

  it("createdAt 然后 id 按 code point（不是 UTF-16 code unit）", () => {
    const c = Q.next_batch[3]!;
    const bag = new QuestionBacklog();
    for (const [id, created] of [
      ["q.晚", 10.0],
      ["q.早", 5.0],
      ["Zz", 5.0],
      ["q.😀", 5.0],
      ["q.￿", 5.0],
    ] as const) {
      bag.add(
        baseQuestion(id, { createdAt: created, updatedAt: created, blockedArtifacts: [] }),
      );
    }
    expect(bag.nextBatch({ limit: 10 }).map((q) => q.id)).toEqual(c.batch);
    expect((bag.toDict()["questions"] as Dict[]).map((q) => q["id"])).toEqual(
      c.to_dict_order,
    );
    // 按 UTF-16 排的话 😀（前导代理 D83D）会排在 ￿ 前面 —— 那才是分叉的形状。
    expect(c.batch!.indexOf("q.￿")).toBeLessThan(c.batch!.indexOf("q.😀"));
  });

  it("owner 过滤放行无主问题", () => {
    const c = Q.next_batch[4]!;
    const bag = new QuestionBacklog();
    bag.add(baseQuestion("q.mine", { ownerUserId: "u1" }));
    bag.add(baseQuestion("q.hers", { ownerUserId: "u2" }));
    bag.add(baseQuestion("q.free"));
    expect(bag.nextBatch({ limit: 10, ownerUserId: "u1" }).map((q) => q.id)).toEqual(c.batch);
  });

  it("limit=0 与负数都给空", () => {
    const c = Q.next_batch[5]!;
    const bag = new QuestionBacklog();
    bag.add(baseQuestion("q.mine", { ownerUserId: "u1" }));
    expect(bag.nextBatch({ limit: 0 }).map((q) => q.id)).toEqual(c.zero);
    expect(bag.nextBatch({ limit: -3 }).map((q) => q.id)).toEqual(c.negative);
  });
});

describe("重跑挖掘不许抹掉人的分派/关闭状态", () => {
  it("preserveLifecycle 保住 status / owner / createdAt / version", () => {
    const existing = new QuestionBacklog({
      oq_1: new Question({
        id: "oq_1",
        text: "旧文案",
        status: QuestionStatus.DEFERRED,
        ownerUserId: "u1",
        audienceRole: "旧角色",
        createdAt: 10.0,
        updatedAt: 20.0,
        version: 3,
      }),
    });
    const rebuilt = buildQuestionBacklog({
      openQuestions: [{ rid: "oq_1", text: { value: "更新后的文案" } }],
      existing,
    });
    expect(rebuilt.toDict()).toEqual(Q.backlog_lifecycle.preserved);
  });

  it("preserveLifecycle=false 就是覆盖", () => {
    const bag = new QuestionBacklog();
    bag.add(
      new Question({
        id: "oq_1",
        text: "不保留 lifecycle",
        status: QuestionStatus.OPEN,
        createdAt: 1.0,
        updatedAt: 1.0,
      }),
      { preserveLifecycle: false },
    );
    expect(bag.toDict()).toEqual(Q.backlog_lifecycle.not_preserved);
  });
});

describe("澄清卡的优先级分流（HITL 关口被 naming lint 挤占的案发路径）", () => {
  it("单选项 + 机器可执行 effect → LOW；单选项无 effect / 多选项 → BLOCKING", () => {
    const backlog = buildQuestionBacklog({
      clarificationQuestions: [
        { id: "q_lint", text: "ot_me2n: apiName 不是 lowerCamelCase",
          options: [{ id: "apply", label: "改为 mE2N", effect: { set_api_name: "mE2N" } }],
          source_ref: "cf_n1" },
        { id: "q_free", text: "审批边界不明确",
          options: [{ id: "include", label: "包含50万" }], source_ref: "cf_n2" },
        { id: "q_choice", text: "供应商主数据的 SOR 是哪个系统？",
          options: [{ id: "sap", label: "SAP MM" }, { id: "ecp", label: "ECP" }],
          source_ref: "cf_n3" },
      ],
    });
    const by = new Map([...backlog.questions.values()].map((q) => [q.text.slice(0, 6), q.priority]));
    expect(by.get("ot_me2")).toBe("low");
    expect(by.get("审批边界不明")).toBe("blocking");
    expect(by.get("供应商主数据")).toBe("blocking");
  });
});

describe("buildQuestionBacklog —— 三种遗留来源合流", () => {
  it("OpenQuestion + 澄清卡 + 原始 conflict", () => {
    const B = Q.build_backlog;
    const legacy = openQuestionsFrom([B.open_question])[0]!;
    const bag = buildQuestionBacklog({
      openQuestions: [legacy],
      clarificationQuestions: [B.card],
      conflicts: B.conflicts,
    });
    expect(bag.toDict()).toEqual(B.backlog);
  });
});

describe("Decision / DecisionLedger", () => {
  const D = Q.decisions as {
    semantic_payload: Dict;
    fingerprint: string;
    to_dict: Dict;
    from_dict_round_trip: Dict;
    records: { name: string; id?: string; created?: boolean; supersedes?: string;
      result?: ErrShape }[];
    ledger: Dict;
    active_for_q1: string;
    active_for_missing: unknown;
    ledger_round_trip: Dict;
    ledger_from_list: Dict;
    duplicate_id: ErrShape;
    duplicate_key: ErrShape;
  };

  const dec = (over: Partial<ConstructorParameters<typeof Decision>[0]> = {}): Decision =>
    new Decision({ id: "", questionId: "q1", answer: true, actor: "u1", createdAt: 500.0,
      ...over });

  it("semanticPayload 的 affectedIds 按 code point 排序", () => {
    const d = dec({
      id: "dec.1",
      actorRole: "business_owner",
      authority: "process_owner",
      affectedIds: ["z.artifact", "a.artifact", "😀", "￿"],
      rationale: "按 2026 年新制度",
    });
    expect(d.semanticPayload()).toEqual(D.semantic_payload);
    expect(d.fingerprint).toBe(D.fingerprint);
    expect(d.toDict()).toEqual(D.to_dict);
    expect(Decision.fromDict(d.toDict()).toDict()).toEqual(D.from_dict_round_trip);
  });

  it("幂等、supersede、冲突", () => {
    const ledger = new DecisionLedger();
    const r1 = ledger.record(dec({ idempotencyKey: "k1" }));
    const r2 = ledger.record(dec({ idempotencyKey: "k1" }));
    const conflict = callErr(() =>
      ledger.record(dec({ answer: false, idempotencyKey: "k1" })),
    );
    const r3 = ledger.record(dec({ answer: false, idempotencyKey: "k2" }));
    const r4 = ledger.record(dec({ answer: false, idempotencyKey: "k3" }));

    expect([r1[0].id, r1[1]]).toEqual([D.records[0]!.id, D.records[0]!.created]);
    expect([r2[0].id, r2[1]]).toEqual([D.records[1]!.id, D.records[1]!.created]);
    expect(conflict).toEqual(D.records[2]!.result);
    expect([r3[0].id, r3[1], r3[0].supersedes]).toEqual([
      D.records[3]!.id,
      D.records[3]!.created,
      D.records[3]!.supersedes,
    ]);
    expect([r4[0].id, r4[1]]).toEqual([D.records[4]!.id, D.records[4]!.created]);

    expect(ledger.toDict()).toEqual(D.ledger);
    expect(ledger.activeFor("q1")!.id).toBe(D.active_for_q1);
    expect(ledger.activeFor("没有这个问题")).toBe(D.active_for_missing);
    expect(DecisionLedger.fromDict(ledger.toDict()).toDict()).toEqual(D.ledger_round_trip);
    expect(
      DecisionLedger.fromDict(ledger.toDict()["decisions"] as Dict[]).toDict(),
    ).toEqual(D.ledger_from_list);
  });

  it("构造时就拒绝重复的 id / 幂等键", () => {
    expect(callErr(() => new DecisionLedger([dec({ id: "x" }), dec({ id: "x", answer: false })])))
      .toEqual(D.duplicate_id);
    expect(
      callErr(
        () =>
          new DecisionLedger([
            dec({ id: "a", idempotencyKey: "k" }),
            dec({ id: "b", idempotencyKey: "k" }),
          ]),
      ),
    ).toEqual(D.duplicate_key);
  });

  for (const c of Q.decision_from_dict) {
    it(`fromDict：${c.name}`, () => {
      expect(Decision.fromDict(c.raw).toDict()).toEqual(c.decision);
    });
  }
});

describe("answerQuestion —— 领域入口", () => {
  const A = Q.answer_question as {
    schema_rejected: ErrShape;
    first: { decision: Dict; created: boolean };
    again: { decision: Dict; created: boolean };
    missing_key: ErrShape;
    missing_question: ErrShape;
    superseding: { decision: Dict; created: boolean };
    ledger: Dict;
    backlog: Dict;
  };

  it("校验 → 幂等 → 关闭 → supersede", () => {
    const bag = new QuestionBacklog({ "q.threshold": baseQuestion() });
    const ledger = new DecisionLedger();

    expect(
      callErr(() =>
        answerQuestion(bag, ledger, "q.threshold", "是", {
          actor: "u1",
          idempotencyKey: "answer-1",
        }),
      ),
    ).toEqual(A.schema_rejected);

    const first = answerQuestion(bag, ledger, "q.threshold", true, {
      actor: "u1",
      actorRole: "business_owner",
      authority: "process_owner",
      idempotencyKey: "answer-1",
      revision: 13,
      now: 110.0,
    });
    const again = answerQuestion(bag, ledger, "q.threshold", true, {
      actor: "u1",
      actorRole: "business_owner",
      authority: "process_owner",
      idempotencyKey: "answer-1",
      revision: 13,
      now: 111.0,
    });
    expect({ decision: first[0].toDict(), created: first[1] }).toEqual(A.first);
    expect({ decision: again[0].toDict(), created: again[1] }).toEqual(A.again);

    expect(
      callErr(() =>
        answerQuestion(bag, ledger, "q.threshold", true, {
          actor: "u1",
          idempotencyKey: "   ",
        }),
      ),
    ).toEqual(A.missing_key);
    expect(
      callErr(() =>
        answerQuestion(bag, ledger, "没有这个问题", true, {
          actor: "u1",
          idempotencyKey: "k",
        }),
      ),
    ).toEqual(A.missing_question);

    bag.transition("q.threshold", QuestionStatus.OPEN, { now: 112.0 });
    const fresh = answerQuestion(bag, ledger, "q.threshold", false, {
      actor: "u1",
      idempotencyKey: "answer-2",
      now: 113.0,
    });
    expect({ decision: fresh[0].toDict(), created: fresh[1] }).toEqual(A.superseding);
    expect(ledger.toDict()).toEqual(A.ledger);
    expect(bag.toDict()).toEqual(A.backlog);
  });
});

describe("PatchOp / PatchSet / Revision", () => {
  const P = Q.patch as {
    ops: Dict[];
    ops_round_trip: Dict[];
    op_errors: { name: string; result: ErrShape }[];
    patch: Dict;
    patch_round_trip: Dict;
    require_base_ok: ErrShape;
    require_base_conflict: ErrShape;
    patch_id_from_ops: Dict;
    revision: Dict;
    revision_round_trip: Dict;
    revision_minimal: Dict;
    revision_bad_status: ErrShape;
  };

  const ops = (): PatchOp[] => [
    new PatchOp("replace", "/rules/rule.approval/expression", "amount >= 500000", "", [
      "rule.approval",
    ]),
    new PatchOp("remove", "/rules/rule.old"),
    new PatchOp("move", "/rules/b", null, "/rules/a"),
  ];

  const patch = (): PatchSet =>
    new PatchSet({
      id: "patch.13",
      baseRevision: 12,
      ops: ops(),
      affectedIds: ["z.rule", "a.rule"],
      blockedArtifacts: ["flow.approval"],
      idempotencyKey: "edit-12-a",
      actor: "u1",
      createdAt: 600.0,
    });

  it("PatchOp 的 toDict / fromDict", () => {
    expect(ops().map((o) => o.toDict())).toEqual(P.ops);
    expect(ops().map((o) => PatchOp.fromDict(o.toDict()).toDict())).toEqual(P.ops_round_trip);
  });

  it("PatchOp 的四条构造期校验", () => {
    const runs = [
      (): unknown => new PatchOp("upsert", "/a"),
      (): unknown => new PatchOp("add", "rules/a"),
      (): unknown => new PatchOp("move", "/b"),
      (): unknown => new PatchOp("copy", "/b", null, "a"),
    ];
    P.op_errors.forEach((c, i) => {
      expect(callErr(runs[i]!)).toEqual(c.result);
    });
  });

  it("PatchSet 的指纹与 CAS", () => {
    const p = patch();
    expect(p.toDict()).toEqual(P.patch);
    expect(PatchSet.fromDict(p.toDict()).toDict()).toEqual(P.patch_round_trip);
    expect(PatchSet.fromDict(p.toDict()).fingerprint).toBe(p.fingerprint);
    expect(callErr(() => p.requireBase(12))).toEqual(P.require_base_ok);
    expect(callErr(() => p.requireBase(13))).toEqual(P.require_base_conflict);
  });

  it("没有 id 时由 ops 摘要出 id", () => {
    expect(
      PatchSet.fromDict({
        baseRevision: 1,
        ops: [{ op: "add", path: "/a", value: 1 }],
      }).toDict(),
    ).toEqual(P.patch_id_from_ops);
  });

  it("Revision 的往返", () => {
    const rev = new Revision({
      id: "rev.13",
      ordinal: 13,
      parentId: "rev.12",
      kind: "answer",
      status: "applied" as RevisionStatus,
      patchSet: patch(),
      changedIds: ["rule.approval"],
      actor: "u1",
      createdAt: 601.0,
    });
    expect(rev.toDict()).toEqual(P.revision);
    expect(Revision.fromDict(rev.toDict()).toDict()).toEqual(P.revision_round_trip);
    expect(Revision.fromDict({ id: "rev.1" }).toDict()).toEqual(P.revision_minimal);
    expect(callErr(() => Revision.fromDict({ id: "r", status: "不认识" }))).toEqual(
      P.revision_bad_status,
    );
  });
});

describe("回答校验 —— 消息形态一个字都不能漂", () => {
  for (const c of Q.validate.cases) {
    it(c.name, () => {
      const q = new Question({
        id: "q",
        text: "t",
        answerSchema: c.schema,
        createdAt: 1,
        updatedAt: 1,
      });
      expect(callErr(() => q.validateAnswer(c.value))).toEqual(c.result);
    });
  }

  // ── 已知分叉：JS 里 3.0 与 3 是同一个值 ───────────────────────────
  for (const c of Q.validate.divergent) {
    it(`分叉：${c.name}`, () => {
      const q = new Question({
        id: "q",
        text: "t",
        answerSchema: c.schema,
        createdAt: 1,
        updatedAt: 1,
      });
      const got = callErr(() => q.validateAnswer(c.value));
      if (c.js === "ok") {
        // Python 拒（float 不是 int），JS 无从区分 —— 钉住这个形状本身。
        expect(c.result.ok).toBe(false);
        expect(got.ok).toBe(true);
      } else {
        expect(got).toEqual(c.result);
      }
    });
  }
});
