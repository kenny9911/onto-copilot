/**
 * 三个「判断题」对话工具：`conflict.query` / `decision.query` / `release.check`。
 *
 * 这一批的共同性质：**数据早就算出来了，缺的只是出口**。冲突检测、决定台账、
 * release gate 都真实存在于会话状态里，FDE 在对话里却问不到，只能让模型去猜。
 *
 * 所以断言的重点不是「算得对不对」（那是各自模块的测试管的），而是三条产品纪律：
 *
 *  · **查不到 ≠ 没有** —— 没跑过梳理时必须说「还没跑过」，不能说「没有冲突」。
 *    把「未知」渲染成「健康」是这个产品最不能犯的错；
 *  · **过滤视图不能掩盖全局** —— 按类型筛出 2 条时，总数必须还看得见；
 *  · **说清楚没查什么** —— release gate 有一部分只在 DAG 里跑，对话侧看不到，
 *    这部分必须明说，不能让「我这儿没问题」听起来像「全绿」。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../src/kernel/tools.js";
import { AsyncLock } from "../src/server/pipeline/types.js";
import { converseTools } from "../src/server/dialogue.js";
import { dialogueOf } from "../src/server/dialogue/memory.js";
import { conflictToDict, makeConflict, ConflictKind,
  makeOption,
} from "../src/onto/conflict.js";
import { makeProvenance } from "../src/onto/oir.js";
import type { SessionEvent } from "../src/session_events.js";
import type { DialogueDeps, SessionLike } from "../src/server/dialogue/ports.js";

function makeSession(): SessionLike {
  const dir = mkdtempSync(join(tmpdir(), "onto-judge-"));
  const s: SessionLike = {
    id: "s1", title: "新建会话", project: "", projectId: "", created: 1700000000,
    files: [], status: "idle", error: "", dir, events: [], state: {}, stateVersion: 0,
    owner: "", buildLeaseOwner: "", mutationLeaseOwner: "",
    buildLock: new AsyncLock(), chatTask: null, runTask: null, lang: "zh",
    emit(kind, payload = {}) {
      const ev = { ...payload, kind } as unknown as SessionEvent;
      (s.events as unknown[]).push(ev);
      return ev;
    },
    async emitDurable(kind, payload = {}) { return s.emit(kind, payload); },
  } as SessionLike;
  return s;
}

function makeDeps(): DialogueDeps {
  const impl: Partial<DialogueDeps> = {
    builtinRegistry: () => new ToolRegistry(),
    // `export.file` 的描述按**运行时能力矩阵**拼（这台机器导不导得出 pdf），
    // 所以 converseTools **注册时**就要 exportApi，不只是调用时。
    exportApi: {
      FORMATS: ["xlsx", "docx", "pdf", "md", "csv"],
      availableFormats: () => ["xlsx", "docx", "md", "csv"],
      resolveFormat: (f: string) => f,
      render: async () => [new Uint8Array(), { ext: ".md", label: "MD" }],
      safeName: (t: string, ext: string) => `${t}${ext}`,
    } as unknown as DialogueDeps["exportApi"],
  };
  return new Proxy(impl as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      throw new Error(`fake deps：这批工具不该碰 ${k}`);
    },
  }) as unknown as DialogueDeps;
}

async function call(s: SessionLike, name: string, args: Record<string, unknown> = {}) {
  const reg = converseTools(s, makeDeps());
  return (await reg.call(name, args, { approved: true, pending: [] }, {
    scope: "converse",
  })) as Record<string, unknown>;
}

function prov(file: string, snippet: string) {
  return makeProvenance(file, file, { kind: "para" }, { snippet, extractor: "rule", confidence: 0.9 });
}

// ══════════════════════════════════════════════════════════════════
//  conflict.query
// ══════════════════════════════════════════════════════════════════

describe("conflict.query", () => {
  it("**没跑过梳理时说「还没跑过」，不说「没有冲突」**", async () => {
    const s = makeSession();
    const out = await call(s, "conflict.query");
    expect(out["总数"]).toBe(0);
    expect(String(out["说明"])).toContain("还没跑过");
  });

  it("跑过但确实零冲突 —— 这时候才能说没检出", async () => {
    const s = makeSession();
    s.state["conflicts"] = [];
    const out = await call(s, "conflict.query");
    expect(String(out["说明"])).toContain("没有检出");
    expect(String(out["说明"])).not.toContain("还没跑过");
  });

  it("带双方出处 —— 「凭什么说它们矛盾」必须能点回原文", async () => {
    const s = makeSession();
    s.state["conflicts"] = [
      conflictToDict(
        makeConflict("cf_1", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a", "pt_b"], "计划金额两处口径不一致", {
          evidence: [prov("采购制度.docx", "含税"), prov("合同管理办法.pdf", "不含税")],
        }),
      ),
    ];
    const out = await call(s, "conflict.query");
    const items = out["冲突"] as Record<string, unknown>[];
    const files = (items[0]!["出处"] as Record<string, unknown>[]).map((e) => e["文件"]);
    expect(files).toContain("采购制度.docx");
    expect(files).toContain("合同管理办法.pdf");
  });

  it("每条冲突带处置方式 —— 「要不要人拍板」是 FDE 排优先级的依据", async () => {
    const s = makeSession();
    s.state["conflicts"] = [
      conflictToDict(makeConflict("cf_1", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a"], "口径分歧")),
    ];
    const out = await call(s, "conflict.query");
    const items = out["冲突"] as Record<string, unknown>[];
    expect(items[0]!["处置"]).toBe("ask_user");
  });

  it("按类型过滤时，**全量分布仍然看得见**", async () => {
    const s = makeSession();
    s.state["conflicts"] = [
      conflictToDict(makeConflict("cf_1", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a"], "口径分歧")),
      conflictToDict(makeConflict("cf_2", ConflictKind.DUPLICATE, ["ot_a"], "疑似重复")),
      conflictToDict(makeConflict("cf_3", ConflictKind.DUPLICATE, ["ot_b"], "疑似重复")),
    ];
    const out = await call(s, "conflict.query", { kind: "duplicate" });
    expect((out["冲突"] as unknown[]).length).toBe(2);
    expect(out["总数"]).toBe(3);
    expect((out["分布"] as Record<string, number>)["semantic_divergence"]).toBe(1);
  });

  it("按 subject 过滤：只看牵扯到某个实体的", async () => {
    const s = makeSession();
    s.state["conflicts"] = [
      conflictToDict(makeConflict("cf_1", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a"], "甲")),
      conflictToDict(makeConflict("cf_2", ConflictKind.DUPLICATE, ["ot_z"], "乙")),
    ];
    const out = await call(s, "conflict.query", { subject: "pt_a" });
    const items = out["冲突"] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]!["rid"]).toBe("cf_1");
  });
});

// ══════════════════════════════════════════════════════════════════
//  decision.query
// ══════════════════════════════════════════════════════════════════

describe("decision.query", () => {
  it("空台账说「还没有人拍过板」", async () => {
    const out = await call(makeSession(), "decision.query");
    expect(out["总数"]).toBe(0);
    expect(String(out["说明"])).toContain("还没有");
  });

  it("给出口径的全部字段 —— session.status 只给一行 render()，审计不够用", async () => {
    const s = makeSession();
    dialogueOf(s).decide("caliber", "计划金额一律含税", { scopeRefs: ["pt_a"] });
    const out = await call(s, "decision.query");
    const items = out["决定"] as Record<string, unknown>[];
    expect(items[0]!["类型"]).toBe("caliber");
    expect(items[0]!["约定"]).toBe("计划金额一律含税");
    expect(items[0]!["作用范围"]).toEqual(["pt_a"]);
    expect(items[0]!["第几轮"]).toBeDefined();
  });

  it("**被推翻的决定默认不显示，但数得出来** —— 改主意的过程本身是信息", async () => {
    const s = makeSession();
    const dm = dialogueOf(s);
    dm.decide("caliber", "计划金额含税");
    dm.decide("caliber", "改了：计划金额不含税");
    const out = await call(s, "decision.query");
    expect((out["决定"] as unknown[]).length).toBe(1);
    expect(out["已被推翻"]).toBe(1);
  });

  it("显式要历史时把推翻链一起给出来", async () => {
    const s = makeSession();
    const dm = dialogueOf(s);
    dm.decide("caliber", "计划金额含税");
    dm.decide("caliber", "改了：计划金额不含税");
    const out = await call(s, "decision.query", { include_superseded: true });
    const items = out["决定"] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items.some((d) => d["已生效"] === false)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  release.check
// ══════════════════════════════════════════════════════════════════

describe("release.check", () => {
  it("什么都没跑时结论是 NOT_STARTED，不是 READY", async () => {
    const out = await call(makeSession(), "release.check");
    expect(out["结论"]).toBe("NOT_STARTED");
  });

  it("有阻塞问题时 BLOCKED，并列出阻塞了什么", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 3 } };
    s.state["question_backlog"] = {
      questions: [
        { id: "q1", title: "主键用哪个字段", priority: "blocking", status: "open" },
        { id: "q2", title: "要不要拆表", priority: "normal", status: "open" },
      ],
    };
    const out = await call(s, "release.check");
    expect(out["结论"]).toBe("BLOCKED");
    expect(out["阻塞项"]).toHaveLength(1);
    expect((out["阻塞项"] as Record<string, unknown>[])[0]!["标题"]).toBe("主键用哪个字段");
  });

  it("**必须说清楚哪些门没在这儿查** —— 否则「我这儿没问题」会被当成全绿", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 3 } };
    const out = await call(s, "release.check");
    expect(String(out["本工具未覆盖"])).toContain("schema");
  });

  it("待人拍板的冲突也算阻塞 —— 它和问题是同一件事的两种形态", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 3 } };
    s.state["conflicts"] = [
      conflictToDict(makeConflict("cf_1", ConflictKind.SEMANTIC_DIVERGENCE, ["pt_a"], "口径分歧")),
    ];
    const out = await call(s, "release.check");
    expect(out["结论"]).toBe("BLOCKED");
    expect(out["待拍板冲突"]).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  conflict.query 在**真实规模**下的行为
//
//  真实数据打脸出来的：workspace 里最大的会话有 463 条冲突
//  （missing_required 202 / orphan 184 / naming_violation 76 / missing_action 1）。
//  初版实现按迭代顺序切前 60 条，结果返回 59 条 missing_required + 1 条
//  missing_action —— 184 条 orphan 和 76 条 naming_violation **一条都露不出来**。
//
//  更要命的是那唯一 1 条 missing_action 恰好是全会话唯一 ask_user 的：
//  它进来纯属运气。FDE 真正要问的是「有几条必须我拍板」，而按 kind 的分布
//  答不了这个问题 —— 该分的是 handling。
// ══════════════════════════════════════════════════════════════════

function bulkConflicts() {
  const rows: Record<string, unknown>[] = [];
  const push = (
    kind: (typeof ConflictKind)[keyof typeof ConflictKind],
    n: number,
    pre: string,
    opts: Record<string, unknown> = {},
  ) => {
    for (let i = 0; i < n; i += 1) {
      rows.push(conflictToDict(
        makeConflict(`cf_${pre}_${i}`, kind, [`rid_${pre}_${i}`], `${pre} 第 ${i} 条`, opts),
      ));
    }
  };
  push(ConflictKind.MISSING_REQUIRED, 202, "mr");
  push(ConflictKind.ORPHAN, 184, "or");
  // 命名违规要带上**可执行的**改名选项 —— 「机器能自己修」这件事现在取决于
  // 有没有 set_api_name 可应用（handlingOf）。不带选项的命名违规是修不了的，
  // 会如实落到 round_trip（等业务方回填译名），那不是这条用例要表达的意思。
  push(ConflictKind.NAMING_VIOLATION, 76, "nv", {
    options: [makeOption("apply", "改为 poHeader", "可逆、零语义损失", {
      effect: { set_api_name: "poHeader" },
    })],
  });
  push(ConflictKind.MISSING_ACTION, 1, "ma");
  return rows;
}

describe("conflict.query：真实规模", () => {
  it("**截断要分层** —— 463 条里每一类都要露面，不能被第一类占满", async () => {
    const s = makeSession();
    s.state["conflicts"] = bulkConflicts();
    const out = await call(s, "conflict.query");
    const kinds = new Set((out["冲突"] as Record<string, unknown>[]).map((c) => c["类型"]));
    expect(kinds).toContain("missing_required");
    expect(kinds).toContain("orphan");
    expect(kinds).toContain("naming_violation");
    expect(kinds).toContain("missing_action");
  });

  it("**按 handling 给分布** —— 「有几条必须我拍板」是 FDE 排优先级的唯一依据", async () => {
    const s = makeSession();
    s.state["conflicts"] = bulkConflicts();
    const out = await call(s, "conflict.query");
    const byHandling = out["按处置"] as Record<string, number>;
    expect(byHandling["ask_user"]).toBe(1);
    expect(byHandling["round_trip"]).toBe(202);
    expect(byHandling["hint"]).toBe(184);
    expect(byHandling["auto_repair"]).toBe(76);
  });

  it("**要人拍板的排最前** —— 1 条 ask_user 埋在 462 条噪音里等于没有", async () => {
    const s = makeSession();
    s.state["conflicts"] = bulkConflicts();
    const out = await call(s, "conflict.query");
    expect((out["冲突"] as Record<string, unknown>[])[0]!["处置"]).toBe("ask_user");
  });

  it("说明里直接点出要拍板的条数，不让人自己去数", async () => {
    const s = makeSession();
    s.state["conflicts"] = bulkConflicts();
    const out = await call(s, "conflict.query");
    expect(String(out["说明"])).toContain("1");
    expect(String(out["说明"])).toContain("拍板");
  });

  it("只筛 ask_user：FDE 最常用的那一问", async () => {
    const s = makeSession();
    s.state["conflicts"] = bulkConflicts();
    const out = await call(s, "conflict.query", { handling: "ask_user" });
    expect(out["本次返回"]).toBe(1);
    expect(out["总数"]).toBe(463);
  });
});

// ══════════════════════════════════════════════════════════════════
//  release.check：跨来源不一致
//
//  真实数据打脸出来的：workspace 里那个会话的 question_backlog 是**空的**，
//  而同一份 OIR 的 stats 写着 open_questions: 192。初版实现只读台账，
//  于是输出里「阻塞项 0 条」和产物统计里的「open_questions: 192」并排出现，
//  自相矛盾 —— 而读的人（或模型）会取那个更省事的结论。
//
//  这是「查不到 ≠ 没有」的同一族错误，只是跨了数据源。
// ══════════════════════════════════════════════════════════════════

describe("release.check：跨来源不一致", () => {
  it("台账空、但 OIR 说还有未回答问题 → **报不一致**，不报 0", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 175, open_questions: 192 } };
    s.state["question_backlog"] = { questions: [] };
    const out = await call(s, "release.check");
    expect(out["结论"]).not.toBe("READY_FOR_REVIEW");
    expect(String(out["口径不一致"])).toContain("192");
  });

  it("两边一致时不报噪音", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 175, open_questions: 0 } };
    s.state["question_backlog"] = { questions: [] };
    const out = await call(s, "release.check");
    expect(out["口径不一致"]).toBeUndefined();
    expect(out["结论"]).toBe("READY_FOR_REVIEW");
  });

  it("OIR 有未答问题时结论必须是 BLOCKED —— 不能因为台账没同步就放行", async () => {
    const s = makeSession();
    s.state["oir"] = { stats: { objects: 10, open_questions: 5 } };
    const out = await call(s, "release.check");
    expect(out["结论"]).toBe("BLOCKED");
  });
});

// ══════════════════════════════════════════════════════════════════
//  revision.diff
//
//  「上一版到这一版变了什么」—— 全库此前没有任何 diff 函数。
//  地基是 `snapshotHash`：答复路径把回写后的 canonical package 内容寻址存进
//  blob，两个 revision 之间才有可比的内容。
//
//  最要紧的一条纪律：**「没有快照」不是「没有变化」**。接线之前的老 revision
//  哈希是空串，把它渲染成「无改动」就是把「不知道」说成「已确认一致」——
//  而这正是这一轮反复踩到的那一类错。
// ══════════════════════════════════════════════════════════════════

const PKG = (over: Record<string, unknown> = {}) => ({
  $schema: "https://schemas.ontocopilot.dev/ontology-package/1/schema.json",
  schemaVersion: "ontocopilot.ontology-package/1",
  packageId: "pkg.s1", revision: 1, baseRevision: null, generatedAt: "2026-08-18T00:00:00Z",
  dataObjects: [], links: [], actions: [], events: [],
  processNodes: [], processEdges: [], workflows: [], rules: [], integrations: [], ...over,
});

/** deps 里塞一个假的 revision 读取器 + blob 读取器。 */
function diffDeps(revs: { id: string; ordinal: number; kind?: string; snapshot_hash?: string }[], blobs: Record<string, unknown>) {
  return {
    listRevisions: async (_s: unknown) => revs,
    // 端口签名是 `(s, ref)` —— 少一个参数就会把 session 当成 ref 去查
    readSnapshot: async (_s: unknown, ref: string) => {
      if (!(ref in blobs)) throw new Error(`blob 不存在: ${ref}`);
      return blobs[ref];
    },
  };
}

async function callDiff(
  s: SessionLike, revs: { id: string; ordinal: number; kind?: string; snapshot_hash?: string }[], blobs: Record<string, unknown>,
  args: Record<string, unknown> = {},
) {
  const impl: Partial<DialogueDeps> = {
    builtinRegistry: () => new ToolRegistry(),
    exportApi: {
      FORMATS: [], availableFormats: () => ["md"], resolveFormat: (f: string) => f,
      render: async () => [new Uint8Array(), { ext: ".md", label: "MD" }],
      safeName: (t: string, e: string) => `${t}${e}`,
    } as unknown as DialogueDeps["exportApi"],
    ...diffDeps(revs, blobs),
  };
  const deps = new Proxy(impl as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      throw new Error(`fake deps：不该碰 ${k}`);
    },
  }) as unknown as DialogueDeps;
  return (await converseTools(s, deps).call("revision.diff", args, {
    approved: true, pending: [],
  }, { scope: "converse" })) as Record<string, unknown>;
}

describe("revision.diff", () => {
  const REVS = [
    { id: "rev1", ordinal: 1, kind: "question_answer", snapshot_hash: "blob:h1" },
    { id: "rev2", ordinal: 2, kind: "question_answer", snapshot_hash: "blob:h2" },
  ];
  const BLOBS = {
    "blob:h1": PKG({ dataObjects: [{ id: "do.po", displayName: "采购订单" }] }),
    "blob:h2": PKG({ dataObjects: [{ id: "do.po", displayName: "采购单" }] }),
  };

  it("默认比最近两版，给出 {rid, field, before, after}", async () => {
    const out = await callDiff(makeSession(), REVS, BLOBS);
    expect(out["改动"]).toContainEqual({
      rid: "do.po", field: "displayName", before: "采购订单", after: "采购单",
    });
  });

  it("**没有快照 ≠ 没有变化** —— 老 revision 哈希为空时明说比不了", async () => {
    const revs = [
      { id: "rev1", ordinal: 1, kind: "edit", snapshot_hash: "" },
      { id: "rev2", ordinal: 2, kind: "edit", snapshot_hash: "blob:h2" },
    ];
    const out = await callDiff(makeSession(), revs, BLOBS);
    expect(String(out["说明"])).toContain("没有快照");
    expect(out["改动"]).toBeUndefined();
    // 绝不能读成「一致」
    expect(String(out["说明"])).not.toContain("完全一致");
  });

  it("blob 读不出来时如实报，不当成无改动", async () => {
    const out = await callDiff(makeSession(), REVS, { "blob:h1": BLOBS["blob:h1"] });
    expect(String(out["说明"])).toContain("读不出");
  });

  it("只有一版时说清楚没得比", async () => {
    const out = await callDiff(makeSession(), [REVS[0]!], BLOBS);
    expect(String(out["说明"])).toContain("只有 1 个");
  });

  it("一条 revision 都没有时说「还没有版本」，不说「没有改动」", async () => {
    const out = await callDiff(makeSession(), [], {});
    expect(String(out["说明"])).toContain("还没有");
    expect(String(out["说明"])).not.toContain("没有改动");
  });

  it("可以指定两个 ordinal 比", async () => {
    const revs = [...REVS, { id: "rev3", ordinal: 3, kind: "edit", snapshot_hash: "blob:h1" }];
    const out = await callDiff(makeSession(), revs, BLOBS, { from: 1, to: 3 });
    // h1 vs h1 → 一致
    expect(out["一致"]).toBe(true);
    expect(String(out["说明"])).toContain("完全一致");
  });

  // ── 同一列两种语义 ──────────────────────────────────────────
  //
  // `snapshot_hash` 被两个写入点用着，含义不同：
  //  · 答复路径（新）写 `blob:<32hex>` —— 内容寻址的本体快照 ref；
  //  · 模板回传（routes/artifacts.ts:771）写 `sha256Hex(上传的 xlsx 字节)` ——
  //    64 位无前缀，指向 returns/ 里的原件，**不是本体快照**。
  //
  // 拿后者去 blob store 取必然扑空。报「读不出来」会把人引向重试，
  // 而真相是「这一版存的压根不是本体快照」——「取不到」和「不是那个东西」
  // 是两种不同的不知道。
  it("**认得出不是本体快照的哈希** —— 不报「读不出来」误导人重试", async () => {
    const revs = [
      { id: "rev1", ordinal: 1, kind: "question_answer", snapshot_hash: "blob:h1" },
      {
        id: "rev2", ordinal: 2, kind: "template_return",
        snapshot_hash: "a".repeat(64), // 回传件的 sha256，不是 blob ref
      },
    ];
    const out = await callDiff(makeSession(), revs, BLOBS);
    expect(String(out["说明"])).toContain("不是本体快照");
    expect(String(out["说明"])).not.toContain("读不出");
  });

  // ── 半指定区间：复审实跑出来的三种错答 ──────────────────────
  //
  // `pick` 只在参数是 undefined 时才用默认值，从不校验凑出来的那一对。
  // 于是三种都能发生，而且每一种都**自信地给出错答案**：
  //  · {from: 最新版} → 把最新版和自己比，然后宣布「完全一致，这是比较过的结论」
  //  · {to: 旧版}     → from 默认成次新版，比较方向倒过来，before/after 全反
  //  · 只有一版时 {to: 1} → 报「找不到指定的版本」，而他指的那版明明存在
  const THREE = [
    { id: "rev1", ordinal: 1, kind: "question_answer", snapshot_hash: "blob:h1" },
    { id: "rev2", ordinal: 2, kind: "question_answer", snapshot_hash: "blob:h2" },
    { id: "rev3", ordinal: 3, kind: "question_answer", snapshot_hash: "blob:h1" },
  ];

  it("{from: 最新版} 时说**它之后没有版本**，绝不拿它和自己比后宣布「完全一致」", async () => {
    const out = await callDiff(makeSession(), THREE, BLOBS, { from: 3 });
    expect(out["一致"]).toBeUndefined();
    expect(String(out["说明"])).not.toContain("完全一致");
    expect(String(out["说明"])).toContain("之后没有");
  });

  it("{to: 最早版} 时说**它之前没有版本**", async () => {
    const out = await callDiff(makeSession(), THREE, BLOBS, { to: 1 });
    expect(out["一致"]).toBeUndefined();
    expect(String(out["说明"])).toContain("之前没有");
  });

  it("两端都给且**方向反了要纠正**，并说明纠正过 —— 别把历史倒着讲", async () => {
    const out = await callDiff(makeSession(), THREE, BLOBS, { from: 3, to: 1 });
    expect(out["从"]).toBe(1);
    expect(out["到"]).toBe(3);
    expect(String(out["说明"])).toContain("按版本先后");
  });

  it("两端指同一版时明说没有可比的两版", async () => {
    const out = await callDiff(makeSession(), THREE, BLOBS, { from: 2, to: 2 });
    expect(String(out["说明"])).toContain("同一个版本");
    expect(String(out["说明"])).not.toContain("完全一致");
  });

  it("只有一版时指定它自己：说清楚没有可比的版本，别说「找不到」", async () => {
    const out = await callDiff(makeSession(), [THREE[0]!], BLOBS, { to: 1 });
    expect(String(out["说明"])).not.toContain("找不到");
    expect(String(out["说明"])).toContain("之前没有");
  });
});

// ══════════════════════════════════════════════════════════════════
//  session.status —— 花费必须合并两本账
// ══════════════════════════════════════════════════════════════════

describe("session.status 花费口径", () => {
  it("梳理侧 + 对话侧合计 —— 只报一本账等于低报", async () => {
    const s = makeSession();
    s.state["budget"] = { spent: { usd: 1.5 } };
    s.state["_chat_usd"] = 0.25;
    const out = await call(s, "session.status");
    expect(out["花费美元"]).toBe(1.75);
    expect(out["花费构成"]).toEqual({ 梳理: 1.5, 对话: 0.25 });
  });

  it("对话侧为零时输出形状与单账本时代一致（不摆空构成）", async () => {
    const s = makeSession();
    s.state["budget"] = { spent: { usd: 1.23 } };
    const out = await call(s, "session.status");
    expect(out["花费美元"]).toBe(1.23);
    expect(out["花费构成"]).toBeUndefined();
  });
});
