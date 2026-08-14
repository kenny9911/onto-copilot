/**
 * 最后一批接线的三个模块：`glue/act.ts`、`glue/export_doc.ts`、`glue/harness.ts`。
 *
 * `_act` 与 `_export_doc` 在 Python 侧**一条单测都没有**（`_act` 的唯一调用方
 * `_drain_queue` 读的 `s.state["_queued"]` 全仓从没被写过）。所以这里的期望值
 * 一律来自 `golden/server.act_export.json` —— 那是 Python 真跑出来的事实，
 * 不是我对它的猜测（契约 §3）。
 *
 * `harness.ts` 没有 golden：它装配的是 AgentLoop/Scheduler 这类**对象**，
 * 序列化不出有意义的字节。断言的是"装配起来了、拿到的是同一份 system、
 * `code.exec` 的有无跟着沙箱走"这几件真会咬人的事。
 */

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(tmpdir(), `ontocopilot-actexport-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Session, SESSIONS } = await import("../src/server/session.js");
const { AsyncLock } = await import("../src/server/session.js");
const { act, doAnswer, doExplain, doScope, statusLine } = await import(
  "../src/server/glue/act.js"
);
const { exportDoc } = await import("../src/server/glue/export_doc.js");
const { HARNESS } = await import("../src/server/glue/harness.js");
const { drainQueue } = await import("../src/server/glue/compile.js");
const { DialogueMemory, Speaker } = await import("../src/kernel/memory/dialogue.js");
const { Intent, makeIntentMatch } = await import("../src/kernel/intent.js");
const { EvidenceIndex } = await import("../src/kernel/memory/evidence.js");
const { defaultAgents, renderSystem } = await import("../src/kernel/agents.js");
const { defaultLibrary } = await import("../src/kernel/skills.js");
const { OIR, extracted, makeActionType, makeObjectType, makeProvenance } = await import(
  "../src/onto/oir.js"
);
const { ConflictKind, makeConflict, makeOption } = await import("../src/onto/conflict.js");
const { Question, QuestionBacklog } = await import("../src/onto/questions.js");
const { MemoryRepo } = await import("../src/store/repo/memory.js");

import type { Session as SessionT } from "../src/server/session.js";
import type { ActResult } from "../src/server/glue/act.js";

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../golden/server.act_export.json", import.meta.url)), "utf8"),
) as {
  export_doc: {
    name: string;
    source: string;
    contains: string;
    title: string;
    table_name: string;
    doc: { title: string; note: string; blocks: unknown[] } | null;
    receipt: Record<string, unknown>;
  }[];
  act: { name: string; intent: string; slots: Record<string, unknown>; result: unknown }[];
};

const T0 = 1_700_000_000.0;

function gExport(name: string): (typeof GOLDEN)["export_doc"][number] {
  const c = GOLDEN.export_doc.find((x) => x.name === name);
  if (c === undefined) throw new Error(`golden 里没有 export_doc 用例 ${name}`);
  return c;
}

function gAct(name: string): (typeof GOLDEN)["act"][number] {
  const c = GOLDEN.act.find((x) => x.name === name);
  if (c === undefined) throw new Error(`golden 里没有 act 用例 ${name}`);
  return c;
}

let seq = 0;
function makeSession(state: Record<string, unknown> = {}): SessionT {
  const s = new Session(`sess_${(seq += 1)}`, {
    title: "示例会话",
    project: "示例 ERP 项目",
    created: T0,
  } as never);
  Object.assign(s.state, state);
  SESSIONS.set(s.id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

/** golden 里的 block 形态（Python `Block` 的全部字段）。 */
function blocksOf(doc: { blocks: readonly unknown[] }): unknown[] {
  return (doc.blocks as { kind: string; text: string; level: number; items: unknown[];
    columns: readonly string[]; rows: readonly (readonly unknown[])[] }[]).map((b) => ({
    kind: b.kind,
    text: b.text,
    level: b.level,
    columns: [...b.columns],
    rows: b.rows.map((r) => [...r]),
    items: b.items.map((i) => [...(i as unknown[])]),
  }));
}

// ══════════════════════════════════════════════════════════════════
//  夹具（与 tools/golden/server_act_export.py 的同名函数逐字对应）
// ══════════════════════════════════════════════════════════════════

function a(v: unknown): Record<string, unknown> {
  return { value: v, origin: "extracted", confidence: 1.0, evidence: [] };
}

function oirState(): Record<string, unknown> {
  return {
    objects: [
      { rid: "ot_order", api_name: a("Order"), display_name: a("订单"),
        description: a("客户下的一笔订单，含税口径见口径约定"), status: "candidate" },
      { rid: "ot_tmp", api_name: a("TmpStage"), display_name: a("临时暂存表"),
        description: a("ETL 中间结果"), status: "candidate" },
    ],
    properties: [
      { rid: "pt_amt", parent: "ot_order", api_name: a("amount"), display_name: a("金额"),
        base_type: a("decimal"), definition: a("含税金额") },
    ],
    actions: [{ rid: "at_submit", api_name: a("submitOrder"), applies_to: ["ot_order"] }],
    rules: [],
    links: [],
    questions: [{ rid: "oq_1", text: a("订单金额含税吗？"), answer: a(""), code: "Q-1" }],
    stats: { objects: 2, properties: 1, links: 0, actions: 1, rules: 0 },
  };
}

function backlogState(): Record<string, unknown> {
  const bag = new QuestionBacklog();
  bag.add(
    new Question({ id: "q-a", text: "订单金额是含税还是不含税？", why: "口径不一致会让报表对不上",
      audienceRole: "财务", ownerUserId: "", createdAt: T0, updatedAt: T0 }),
  );
  bag.add(
    new Question({ id: "q-b", text: "客户主数据的唯一键是什么？", ownerUserId: "li",
      priority: "blocking", why: "", createdAt: T0 + 1, updatedAt: T0 + 1 }),
  );
  return bag.toDict();
}

function dm(): InstanceType<typeof DialogueMemory> {
  const m = new DialogueMemory();
  m.say(Speaker.SYSTEM, "（已压缩 6 轮）早前聊了材料范围与口径");
  m.say(Speaker.USER, "订单金额是含税的吗？");
  m.say(Speaker.ASSISTANT, "## 结论\n\n是含税。\n\n- 依据 A\n- 依据 B");
  for (const t of m.turns) t.ts = T0;
  return m;
}

function realOir(): InstanceType<typeof OIR> {
  const oir = new OIR();
  const prov = makeProvenance("f1", "订单.xlsx", { sheet: "Sheet1", row: 3 });
  oir.addObject(
    makeObjectType({
      rid: "ot_order",
      apiName: extracted("Order", prov),
      displayName: extracted("订单", prov),
    }),
  );
  oir.addAction(
    makeActionType({
      rid: "at_submit",
      apiName: extracted("submitOrder", prov),
      appliesTo: ["ot_order"],
    }),
  );
  return oir;
}

function conflictFixture(): [unknown[], Record<string, unknown>[]] {
  const c = makeConflict("cf_1", ConflictKind.TYPE_MISMATCH, ["pt_amt"], "金额字段用哪个类型？", {
    options: [makeOption("o1", "decimal(18,2)"), makeOption("o2", "整数分")],
  });
  const q = {
    conflict_rid: "cf_1",
    options: [
      { id: "o1", label: "decimal(18,2)" },
      { id: "o2", label: "整数分" },
    ],
  };
  return [[c], [q]];
}

const EXPORT_DEPS = {
  repo: () => new MemoryRepo(),
  dialogue: (s: { state: Record<string, unknown> }) => {
    let d = s.state["_dialogue"];
    if (d === null || d === undefined) {
      d = new DialogueMemory();
      s.state["_dialogue"] = d;
    }
    return d as InstanceType<typeof DialogueMemory>;
  },
  registry: () => {
    throw new Error("这些用例走不到 last_table，不该需要解析器");
  },
};

async function runExport(
  name: string,
  s: SessionT,
): Promise<[unknown, Record<string, unknown>]> {
  const c = gExport(name);
  const [doc, receipt] = await exportDoc(
    s as never,
    EXPORT_DEPS as never,
    c.source,
    c.contains,
    c.title,
    c.table_name,
  );
  return [
    doc === null ? null : { title: doc.title, note: doc.note, blocks: blocksOf(doc) },
    receipt,
  ];
}

async function runAct(name: string, s: SessionT): Promise<ActResult> {
  const c = gAct(name);
  return await act(s, makeIntentMatch(c.intent as never, 0.9, c.slots, "", "test"), {
    claimAndStartBuild: () => {
      throw new Error("这些用例不该起 build");
    },
    recompile: () => {
      throw new Error("这些用例不该重编译");
    },
  });
}

// ══════════════════════════════════════════════════════════════════
//  _export_doc
// ══════════════════════════════════════════════════════════════════
describe("_export_doc（golden 逐条比对）", () => {
  it("questions：台账在就走 QuestionBacklog，台账不在就掉到梳理产物那一档", async () => {
    // 判据是 `source == "questions" and s.state.get("question_backlog")`。
    // 少了后半个条件，新会话导问题清单会拿到一份空台账 —— 而不是产物里那条。
    for (const [name, state] of [
      ["questions_backlog", { question_backlog: backlogState() }],
      ["questions_backlog_miss", { question_backlog: backlogState() }],
      ["questions_from_oir", { oir: oirState() }],
    ] as const) {
      const c = gExport(name);
      expect([name, await runExport(name, makeSession(state))]).toEqual([
        name,
        [c.doc, c.receipt],
      ]);
    }
  });

  it("_OIR_COLS 那一档：表头、行、标题拼法、筛空与整类为空", async () => {
    for (const name of [
      "oir_objects",
      "oir_objects_contains",
      "oir_objects_contains_empty",
      "oir_rules_empty",
      "oir_props_titled",
    ]) {
      const c = gExport(name);
      expect([name, await runExport(name, makeSession({ oir: oirState() }))]).toEqual([
        name,
        [c.doc, c.receipt],
      ]);
    }
  });

  it("conversation：**system 轮次不能丢** —— 它是被压缩掉那些轮次仅存的记录", async () => {
    const c = gExport("conversation");
    expect(await runExport("conversation", makeSession({ _dialogue: dm() }))).toEqual([
      c.doc,
      c.receipt,
    ]);
    // note 里那句"更早的轮次已被压缩成 N 条摘要"必须在 —— 少了它，这份导出就在
    // 宣称自己是完整的对话记录
    expect(c.doc?.note).toContain("压缩");
  });

  it("last_answer / 空会话 / 认不出的 source", async () => {
    const cases: [string, SessionT][] = [
      ["last_answer", makeSession({ _dialogue: dm() })],
      ["conversation_empty", makeSession()],
      ["last_answer_empty", makeSession()],
      ["unknown_source", makeSession()],
    ];
    for (const [name, s] of cases) {
      const c = gExport(name);
      expect([name, await runExport(name, s)]).toEqual([name, [c.doc, c.receipt]]);
    }
  });

  it("golden 里的每条 export_doc 用例都被这个文件覆盖到了", () => {
    // 只跑一半用例、剩下的悄悄没人管，是这种表驱动测试最常见的失效方式
    const covered = new Set([
      "questions_backlog", "questions_backlog_miss", "questions_from_oir",
      "oir_objects", "oir_objects_contains", "oir_objects_contains_empty",
      "oir_rules_empty", "oir_props_titled", "conversation", "last_answer",
      "conversation_empty", "last_answer_empty", "unknown_source",
    ]);
    expect(GOLDEN.export_doc.map((c) => c.name).filter((n) => !covered.has(n))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  _act
// ══════════════════════════════════════════════════════════════════
describe("_act（golden 逐条比对）", () => {
  it("寒暄与状态：**返回的是 dict**（事实 + 备用措辞），不是一句成品", async () => {
    const empty = makeSession();
    expect(await runAct("chitchat_empty", empty)).toEqual(gAct("chitchat_empty").result);

    const s = makeSession({
      oir: oirState(),
      budget: { spent: { usd: 1.2345 } },
      questions: [{ id: "1" }],
      suggestions: SUGS(),
    });
    s.files = [{ name: "订单.xlsx" }, { name: "接口.json" }] as never;
    expect(await runAct("chitchat_with_files", s)).toEqual(gAct("chitchat_with_files").result);
  });

  it("ask_status：花费走 round(x, 2)（half-even），措辞走 .2f", async () => {
    const s = makeSession({
      oir: oirState(),
      budget: { spent: { usd: 1.2345 } },
      questions: [{ id: "1" }],
      suggestions: SUGS(),
    });
    s.files = [{ name: "订单.xlsx" }] as never;
    expect(await runAct("ask_status", s)).toEqual(gAct("ask_status").result);
    expect(await runAct("ask_status_cold", makeSession())).toEqual(
      gAct("ask_status_cold").result,
    );
  });

  it("补充背景 / 口径 / 命名：决定真的落进 DialogueMemory", async () => {
    const ctx = makeSession();
    expect(await runAct("add_context", ctx)).toEqual(gAct("add_context").result);
    expect((ctx.state["_dialogue"] as InstanceType<typeof DialogueMemory>).decisions).toHaveLength(1);

    expect(await runAct("set_caliber", makeSession())).toEqual(gAct("set_caliber").result);
    // golden 那条用的是 `object()`（Python 里恒为真）。TS 侧的 `pyTruthy` 对空
    // 对象是**假**（`bool({})` 就是 False），所以夹具得给一份真的 OIR ——
    // 用 `{}` 会让"已经跑过梳理"翻成 false，那不是移植错误，是夹具错误。
    expect(await runAct("set_naming", makeSession({ _oir: realOir() }))).toEqual(
      gAct("set_naming").result,
    );
  });

  it("范围：落不到具体对象上就反问，**绝不按模糊短语批量删**", async () => {
    expect(await runAct("scope_no_oir", makeSession())).toEqual(gAct("scope_no_oir").result);
    expect(
      await runAct("scope_suggest", makeSession({ _oir: {}, suggestions: SUGS() })),
    ).toEqual(gAct("scope_suggest").result);
    expect(await runAct("scope_no_hint", makeSession({ _oir: {}, suggestions: [] }))).toEqual(
      gAct("scope_no_hint").result,
    );
    expect(await runAct("scope_named", makeSession({ _oir: {} }))).toEqual(
      gAct("scope_named").result,
    );
    expect(await runAct("scope_keep", makeSession({ _oir: {} }))).toEqual(
      gAct("scope_keep").result,
    );
  });

  it("建议：不在列表 / 否决 / 采纳但还没有产物", async () => {
    for (const name of ["sug_missing", "sug_reject", "sug_adopt_no_oir"]) {
      expect([name, await runAct(name, makeSession({ suggestions: SUGS() }))]).toEqual([
        name,
        gAct(name).result,
      ]);
    }
  });

  it("解释：只讲有据可查的，讲不出依据就说讲不出", async () => {
    expect(await runAct("explain_cold", makeSession())).toEqual(gAct("explain_cold").result);
    expect(await runAct("explain_real", makeSession({ _oir: realOir() }))).toEqual(
      gAct("explain_real").result,
    );
    expect(await runAct("explain_unknown", makeSession({ _oir: realOir() }))).toEqual(
      gAct("explain_unknown").result,
    );
  });

  it("回答：①②③ / 数字 / 字母三种写法，**空串选中第一项**（原件的形状）", async () => {
    const [conflicts, questions] = conflictFixture();
    for (const name of [
      "answer_circled",
      "answer_digit",
      "answer_letter",
      "answer_oob",
      "answer_blank",
      "answer_no_target",
    ]) {
      const s = makeSession({ _conflicts: conflicts, questions });
      expect([name, await runAct(name, s)]).toEqual([name, gAct(name).result]);
    }
    // 空串那条不是笔误：Python 的 `raw.upper() in "ABCDE"` 对空串恒为真（子串
    // 判定），`"ABCDE".index("")` 是 0。照搬它，不"修"成"没说序号" —— 两侧行为
    // 分叉才是真正的坑。
    expect(gAct("answer_blank").result).toBe(gAct("answer_digit").result);
  });

  it("重跑：没产物就说没产物；重抽材料先报价", async () => {
    expect(await runAct("rerun_cold", makeSession())).toEqual(gAct("rerun_cold").result);
    expect(
      await runAct("rerun_full", makeSession({ _oir: {}, budget: { spent: { usd: 1.2345 } } })),
    ).toEqual(gAct("rerun_full").result);
  });

  it("认不出的意图回空串 —— `_drain_queue` 的 `if r:` 靠它把这一条丢掉", async () => {
    expect(await runAct("unknown_intent", makeSession())).toBe("");
  });

  it("golden 里的每条 act 用例都被这个文件覆盖到了", () => {
    const covered = new Set(
      GOLDEN.act.map((c) => c.name).filter((n) => n !== "__none__"),
    );
    // 反过来查：这里列的是**被跑到过的**名字，漏一条就说明上面少写了一个断言
    const asserted = new Set([
      "chitchat_empty", "chitchat_with_files", "ask_status", "ask_status_cold",
      "add_context", "set_caliber", "set_naming", "scope_no_oir", "scope_suggest",
      "scope_no_hint", "scope_named", "scope_keep", "sug_missing", "sug_reject",
      "sug_adopt_no_oir", "explain_cold", "explain_real", "explain_unknown",
      "answer_circled", "answer_digit", "answer_letter", "answer_oob", "answer_blank",
      "answer_no_target", "rerun_cold", "rerun_full", "unknown_intent",
    ]);
    expect([...covered].filter((n) => !asserted.has(n))).toEqual([]);
  });

  it("START_BUILD 的五种回执走的是**同一份** claimAndStartBuild", async () => {
    const s = makeSession();
    s.files = [{ name: "订单.xlsx" }] as never;
    const seen: string[] = [];
    const run = async (res: string): Promise<ActResult> =>
      await act(s, makeIntentMatch(Intent.START_BUILD, 0.9, {}, "", "t"), {
        claimAndStartBuild: async () => {
          seen.push(res);
          return await Promise.resolve(res);
        },
        recompile: () => Promise.reject(new Error("不该走到")),
      });
    expect(await run("no_files")).toBe("还没有材料。把文件拖进来，或者点 + 添加。");
    expect(await run("missing")).toBe("这个会话已经不存在了，请回到会话列表重新打开。");
    expect(await run("awaiting_answer")).toContain("等业务回答");
    expect(await run("extracting")).toBe("已经在跑了。");
    expect(await run("started")).toBe("开始梳理 1 份材料。过程我会一步步说。");
    expect(seen).toHaveLength(5);
  });

  it("RERUN 说到「模板/编译/产物/出表」才重编译 —— 其余是一句报价，不花钱", async () => {
    const s = makeSession({ _oir: {}, template: { sheets: 4, prefilled: 128 } });
    let calls = 0;
    const run = async (phrase: string): Promise<ActResult> =>
      await act(s, makeIntentMatch(Intent.RERUN, 0.9, { phrase }, "", "t"), {
        claimAndStartBuild: () => Promise.reject(new Error("不该走到")),
        recompile: async () => {
          calls += 1;
          await Promise.resolve();
        },
      });
    expect(await run("重出模板")).toBe("已按当前结果重出模板：4 张表、128 格预填。");
    expect(calls).toBe(1);
    await run("重新梳理一遍");
    expect(calls).toBe(1); // 重抽材料要花钱，一句"重跑"不能替用户按下去
  });
});

function SUGS(): Record<string, unknown>[] {
  return [
    { id: "sg_1", kind: "EXCLUDE", title: "排除 3 张疑似临时表",
      payload: { objects: ["ot_tmp", "ot_a", "ot_b"] } },
    { id: "sg_2", kind: "SPLIT", title: "拆分订单表", payload: {} },
  ];
}

// ══════════════════════════════════════════════════════════════════
//  `_drain_queue` 与 `_act` 的接缝
// ══════════════════════════════════════════════════════════════════
describe("drainQueue × act", () => {
  const glue = (over: Record<string, unknown> = {}): never =>
    ({
      repo: () => new MemoryRepo(),
      now: () => T0,
      persist: async () => undefined,
      projectMemory: () => {
        throw new Error("不该走到");
      },
      emitAiPrompts: () => undefined,
      act: async () => await Promise.resolve(""),
      publishAssistant: () => undefined,
      sessionMutation: async (_s: unknown, _k: string, body: () => Promise<unknown>) =>
        await body(),
      restoreDialogue: async () => undefined,
      preparse: async () => undefined,
      ...over,
    }) as never;

  it("字符串回执照常拼成一段回话", async () => {
    const s = makeSession({ _queued: [{ intent: "chitchat", span: "你好" }] });
    const said: string[] = [];
    await drainQueue(s, glue({ act: () => Promise.resolve("办好了"), publishAssistant: (_x: unknown, t: string) => said.push(t) }));
    expect(said).toEqual(["梳理跑完了，把你刚才排下的几件事办了：\n\n办好了"]);
  });

  it("**dict 回执在 join 上炸** —— 与 Python 一致，不悄悄发一句 [object Object]", async () => {
    // `_act` 的 `_outcome(...)` 分支返回 dict，而 `"\n\n".join(done)` 在 dict 上
    // 抛 TypeError。这条路当前到不了（全仓没有任何地方往 `_queued` 写东西），
    // 但两侧必须在同一个地方以同一种方式失败。
    const s = makeSession({ _queued: [{ intent: "chitchat", span: "你好" }] });
    await expect(
      drainQueue(s, glue({ act: () => Promise.resolve({ kind: "chitchat", facts: {}, fallback: "在。" }) })),
    ).rejects.toThrow(/expected str instance, dict found/);
  });

  it("一条失败不拖垮其余的 —— 失败的那条变成一句能看懂的回执", async () => {
    const s = makeSession({
      _queued: [
        { intent: "chitchat", span: "第一件" },
        { intent: "chitchat", span: "第二件" },
      ],
    });
    const said: string[] = [];
    let n = 0;
    await drainQueue(
      s,
      glue({
        act: () => {
          n += 1;
          return n === 1 ? Promise.reject(new Error("崩了")) : Promise.resolve("第二件办好了");
        },
        publishAssistant: (_x: unknown, t: string) => said.push(t),
      }),
    );
    expect(said[0]).toContain("「第一件」没执行成功");
    expect(said[0]).toContain("第二件办好了");
  });
});

// ══════════════════════════════════════════════════════════════════
//  harness
// ══════════════════════════════════════════════════════════════════
/** 注册表里 analyze 作用域看得见的工具名。`code.exec` 声明的就是 analyze/compile。 */
function toolNames(reg: unknown): string[] {
  return (reg as { forScope(s: string): { spec: { name: string } }[] })
    .forScope("analyze")
    .map((t) => t.spec.name);
}

describe("harness", () => {
  it("extractorSystem = render_system(skills) + 空行 + skills.load(agent.skills)", () => {
    // 两段是两件事：前者只列技能**摘要**，后者贴技能**全文**。少了后半段，
    // 模型知道有这么一门技能却读不到它的做法。
    const agent = defaultAgents().get("extractor");
    const skills = defaultLibrary();
    const sys = HARNESS.extractorSystem();
    expect(sys).toBe(`${renderSystem(agent, skills)}\n\n${skills.load([...agent.skills])}`);
    expect(sys.length).toBeGreaterThan(renderSystem(agent, skills).length + 2);
  });

  it("makeContext 的预算是写死的 90k，不跟着模型窗口走", () => {
    const cm = HARNESS.makeContext({
      system: "SYS",
      evidence: new EvidenceIndex() as never,
      longTerm: null,
    });
    expect((cm as unknown as { budgetTokens: number }).budgetTokens).toBe(90_000);
    expect((cm as unknown as { system: string }).system).toBe("SYS");
    cm.reflect("用户已拍板：含税指专票口径");
    expect([...cm.reflections]).toEqual(["用户已拍板：含税指专票口径"]);
  });

  it("**沙箱探不到时 `code.exec` 不进动作空间** —— 不是进了之后每次调用都失败", async () => {
    // 注册一个必然失败的工具，模型会把失败回执读成"参数写错了"然后反复重试，
    // 把预算烧光，而每一轮都真花钱。
    const before = process.env["ONTOCOPILOT_ENABLE_CODEACT"];
    delete process.env["ONTOCOPILOT_ENABLE_CODEACT"];
    try {
      const reg = await HARNESS.buildTools({
        evidence: new EvidenceIndex() as never,
        profiles: null,
      });
      // 按 analyze 作用域看 —— `code.exec` 声明的就是 analyze/compile，
      // 在这里都看不见，说明它根本没被注册（不是被作用域挡住了）
      const names = toolNames(reg);
      expect(names).not.toContain("code.exec");
      // 别的内建工具照常在 —— "没有沙箱"不该把整套工具一起吞掉
      expect(names).toContain("evidence.search");
    } finally {
      if (before === undefined) delete process.env["ONTOCOPILOT_ENABLE_CODEACT"];
      else process.env["ONTOCOPILOT_ENABLE_CODEACT"] = before;
    }
  });

  it("开关开了但这台机器上没有容器运行时，照样不进动作空间（两种「没有」同一个处理）", async () => {
    const beforeFlag = process.env["ONTOCOPILOT_ENABLE_CODEACT"];
    const beforePath = process.env["PATH"];
    process.env["ONTOCOPILOT_ENABLE_CODEACT"] = "1";
    process.env["PATH"] = ""; // docker 不在 PATH 上 → 探不到沙箱
    try {
      const reg = await HARNESS.buildTools({
        evidence: new EvidenceIndex() as never,
        profiles: null,
      });
      expect(toolNames(reg)).not.toContain("code.exec");
    } finally {
      if (beforeFlag === undefined) delete process.env["ONTOCOPILOT_ENABLE_CODEACT"];
      else process.env["ONTOCOPILOT_ENABLE_CODEACT"] = beforeFlag;
      if (beforePath !== undefined) process.env["PATH"] = beforePath;
    }
  });

  it("engagementDag 是冻结的（冻结是安全边界，Scheduler 拒收没冻结的）", () => {
    const dag = HARNESS.engagementDag() as unknown as { frozen: boolean; name: string };
    expect(dag.frozen).toBe(true);
    expect(dag.name).not.toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  AsyncLock：`acquire()` 必须回一个释放函数
// ══════════════════════════════════════════════════════════════════
describe("Session.buildLock", () => {
  it("acquire() 返回幂等的释放函数 —— 段 D 的 withLock 用的就是这个形状", async () => {
    // 真实事故：这个类原来只回 void，`withLock` 在 finally 里 `release()` 拿到
    // undefined → `TypeError: release is not a function`。它发生在**拿到锁之后**，
    // 于是 POST /build 从 400「还没有上传材料」变成 500，而且锁再也放不掉。
    const lock = new AsyncLock();
    const rel = await lock.acquire();
    expect(typeof rel).toBe("function");
    expect(lock.isLocked).toBe(true);
    rel();
    expect(lock.isLocked).toBe(false);
    rel(); // 幂等：再放一次不会把锁交给下一个等待者两遍
    expect(lock.isLocked).toBe(false);
  });

  it("FIFO：release 直接把锁交给队首，不经过 locked=false", async () => {
    const lock = new AsyncLock();
    const order: number[] = [];
    const r1 = await lock.acquire();
    const p2 = lock.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = lock.acquire().then((r) => {
      order.push(3);
      r();
    });
    r1();
    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });

  it("`run()` 那条老路照常能用 —— 返回值多了个函数不影响它", async () => {
    const lock = new AsyncLock();
    expect(await lock.run(async () => await Promise.resolve(7))).toBe(7);
    expect(lock.isLocked).toBe(false);
    await expect(lock.run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(lock.isLocked).toBe(false); // 异常路径也必须放锁
  });
});

// 清掉临时 workspace
process.on("exit", () => {
  rmSync(ROOT, { recursive: true, force: true });
});
