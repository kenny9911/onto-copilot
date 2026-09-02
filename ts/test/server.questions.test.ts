/**
 * server 段 G —— 七条问题清单路由。
 *
 * 这一段是「给 ERP 顾问填的问题清单」的**回传闭环**：清单做得出来但答不回来，
 * 等于半条链路是断的。所以这里钉的不是"路由返回 200"，而是三件真正会咬人的事：
 *
 * 1. **交付物的字节**。`问题清单.md` / `.json` 是要发出去的文件 —— 编号错位、
 *    "未关闭 N 条"算错、md 与 json 的排序抄成同一份，没有任何东西会报错，只会
 *    让顾问按错的清单去开会。期望值来自 `golden/server.questions.json`
 *    （`tools/golden/server_questions.py` 从 Python 真跑一遍导出），不是手写的猜测。
 * 2. **`/answer` 的幂等**。`decision_live_answer_uq` + 幂等键让重复提交天然回同
 *    一条 Decision；这里逐项断言"第二次没有新增 Decision 行、没有新增 Revision
 *    行、没有再跑一次副作用"。少了这一条，一次网络重试就会把同一个决定应用两次。
 * 3. **双重加锁的顺序**。mutation 租约在外、`questionLock` 在内。反了是死锁，
 *    而死锁的症状是一次超时 500，看不出跟锁有关。
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { BUILD_ACTIVE_CONFLICT } from "../src/server/glue/decisions_queue.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeConflict, makeOption, ConflictKind, type Conflict } from "../src/onto/conflict.js";
import {
  BaseType,
  OIR,
  Origin,
  Status,
  extracted,
  makePropertyType,
} from "../src/onto/oir.js";
import {
  Decision,
  Question,
  QuestionBacklog,
  QuestionPriority,
  QuestionStatus,
} from "../src/onto/questions.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { setRepoForTests } from "../src/store/deps.js";
import {
  makeDecisionRecordRow,
  questionRowFromDomain,
  type JsonObject, makeSessionRow } from "../src/store/types.js";
import {
  answerDomainQuestion,
  expectedVersionOf,
  predictDecisionEffect,
  questionBacklog,
  questionPayload,
  registerQuestionRoutes,
  writeQuestionExports,
  type QuestionDeps,
} from "../src/server/routes/questions.js";
import { contentDisposition } from "../src/server/routes/artifacts.js";
import type { AppEnv, RequestUser } from "../src/server/app.js";

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../golden/server.questions.json", import.meta.url)),
    "utf8",
  ),
) as {
  exports: { md: string; json: string; artifacts: string[]; stats: Record<string, number> };
  payload: { without_decision: JsonObject; with_decision: JsonObject };
  expected_version: { body: Record<string, unknown>; out?: number | null; error?: [number, string] }[];
  predict_effect: { what: string; option: string; out?: string[]; error?: [number, string] }[];
  content_disposition: Record<string, string>;
  media: Record<string, string>;
  next_batch: Record<string, string[]>;
};

// 必须在 import session.ts **之前**定下 workspace 根（同 server.artifacts.test.ts）。
const ROOT = join(tmpdir(), `ontocopilot-questions-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Session, SESSIONS, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);
type SessionT = InstanceType<typeof Session>;

// ══════════════════════════════════════════════════════════════════
//  夹具
// ══════════════════════════════════════════════════════════════════

const T0 = 1_700_000_000;

/** 与 `tools/golden/server_questions.py::_backlog` 逐字段一致的那份 backlog。
 * 插入序与"阻塞项优先"的排序序**刻意不一致** —— md 与 json 因此不可能靠同一个
 * 循环写出来。 */
function goldenBacklog(): QuestionBacklog {
  const bag = new QuestionBacklog();
  bag.add(
    new Question({
      id: "q-a",
      text: "订单金额是含税还是不含税？",
      why: "口径不一致会让报表对不上",
      audienceRole: "财务",
      ownerUserId: "",
      priority: QuestionPriority.NORMAL,
      sourceKind: "open_question",
      sourceRef: "oq_1",
      dependencies: ["q-b"],
      createdAt: T0 + 1,
      updatedAt: T0 + 1,
    }),
    { preserveLifecycle: false },
  );
  bag.add(
    new Question({
      id: "q-b",
      text: "客户主数据的唯一键是什么？",
      why: "",
      audienceRole: "",
      ownerUserId: "li",
      status: QuestionStatus.ASSIGNED,
      priority: QuestionPriority.BLOCKING,
      blockedArtifacts: ["模板_v1.xlsx", "ontology.package.json"],
      sourceKind: "conflict",
      sourceRef: "cf_2",
      createdAt: T0 + 2,
      updatedAt: T0 + 2,
    }),
    { preserveLifecycle: false },
  );
  bag.add(
    new Question({
      id: "q-c",
      text: "退货流程是否需要财务复核？",
      status: QuestionStatus.ANSWERED,
      priority: QuestionPriority.LOW,
      audienceRole: "业务",
      createdAt: T0 + 3,
      updatedAt: T0 + 3,
    }),
    { preserveLifecycle: false },
  );
  bag.add(
    new Question({
      id: "q-d",
      text: "这条先放一放",
      status: QuestionStatus.CANCELLED,
      createdAt: T0 + 4,
      updatedAt: T0 + 4,
    }),
    { preserveLifecycle: false },
  );
  return bag;
}

function backlogWithReleaseAcceptance(): QuestionBacklog {
  const bag = goldenBacklog();
  bag.add(
    new Question({
      id: "q-release-acceptance",
      text: "是否正式验收并发布当前交付候选？",
      audienceRole: "业务验收负责人",
      answerSchema: { type: "string", enum: ["APPROVE", "REJECT"] },
      priority: QuestionPriority.BLOCKING,
      blockedArtifacts: ["ontology.package.json"],
      sourceKind: "release_acceptance",
      sourceRef: "q-release-acceptance",
      createdAt: T0 + 5,
      updatedAt: T0 + 5,
    }),
    { preserveLifecycle: false },
  );
  return bag;
}

/** golden 里那条 Decision。 */
function goldenDecision(): Decision {
  return new Decision({
    id: "dec_fixed",
    questionId: "q-a",
    answer: "不含税",
    actor: "fde",
    actorRole: "财务",
    authority: "财务总监",
    sourceTurn: "t-7",
    affectedIds: ["oir_x", "oir_y"],
    idempotencyKey: "idem-1",
    rationale: "以 ERP 里的净额为准",
    createdAt: T0 + 10,
    metadata: { status: "applied" },
  });
}

let repo: MemoryRepo;
let recompiled: number;
let synced: number;
/** `persist` 被调用时 questionLock 是否已经握在手里（锁序的观测点）。 */
let persistSawLock: boolean[];
/** `sessionMutation` 进入时 questionLock 是否已被占（**必须是 false**）。 */
let mutationSawLock: boolean[];
let mutationKinds: string[];
let mutationDepth: number;
/** persist 时是否已在 mutation 作用域内。 */
let persistSawMutation: number[];

function makeDeps(over: Partial<QuestionDeps> = {}): QuestionDeps {
  return {
    persist: async (s) => {
      persistSawLock.push(s.questionLock.isLocked);
      persistSawMutation.push(mutationDepth);
    },
    sessionMutation: async (s, kind, body) => {
      mutationKinds.push(kind);
      mutationSawLock.push(s.questionLock.isLocked);
      mutationDepth += 1;
      try {
        return await body();
      } finally {
        mutationDepth -= 1;
      }
    },
    recompile: async () => {
      recompiled += 1;
    },
    syncQuestionBacklog: async (s) => {
      synced += 1;
      return questionBacklog(s);
    },
    now: () => T0 + 100,
    ...over,
  };
}

function makeApp(
  over: Partial<QuestionDeps> = {},
  principal?: RequestUser | null,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  if (principal !== undefined) {
    app.use("*", async (c, next) => {
      c.set("user", principal);
      await next();
    });
  }
  // serve.ts 的 `app.onError`：FastAPI 的 `HTTPException(code, "文案")` 落到线上是
  // `{"detail": "文案"}`。测试要按同样的形状读回来。
  app.onError((err) => {
    if (err instanceof HTTPException) {
      if (err.res !== undefined) return err.getResponse();
      return Response.json({ detail: err.message }, { status: err.status });
    }
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  });
  registerQuestionRoutes(app, makeDeps(over));
  return app;
}

function makeSession(id: string, init: Record<string, unknown> = {}): SessionT {
  const s = new Session(id, init as never);
  SESSIONS.set(id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

/** 领域对象 → repo 行的接缝（同 `artifacts.ts:811` 的理由）。 */
function qrow(q: Question) {
  return questionRowFromDomain({ toDict: () => q.toDict() as JsonObject });
}

/** 把一份 backlog 灌进 repo + state，模拟"梳理已经跑过一轮"。 */
async function seed(s: SessionT, bag: QuestionBacklog): Promise<void> {
  s.state["question_backlog"] = bag.toDict();
  await repo.upsertQuestions(s.id, [...bag.questions.values()].map(qrow));
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
  registerHydrator(async (sid: string) => {
    throw new Error(`no such session ${sid}`);
  });
});

afterAll(() => {
  registerHydrator(null);
  setRepoForTests(null);
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  SESSIONS.clear();
  repo = new MemoryRepo();
  setRepoForTests(repo);
  recompiled = 0;
  synced = 0;
  persistSawLock = [];
  persistSawMutation = [];
  mutationSawLock = [];
  mutationKinds = [];
  mutationDepth = 0;
});

// ══════════════════════════════════════════════════════════════════
//  交付物的字节（golden）
// ══════════════════════════════════════════════════════════════════
describe("问题清单三格式：同源生成", () => {
  it("md 使用稳定的人话展示格式", async () => {
    const s = makeSession("s-md", { project: "示例 ERP 项目", title: "会话标题" });
    await writeQuestionExports(s, goldenBacklog());
    expect(readFileSync(join(s.dir, "问题清单.md"), "utf8")).toBe(GOLDEN.exports.md);
  });

  it("md 的编号走插入序、json 走「阻塞项优先」—— 两份刻意不同", async () => {
    const s = makeSession("s-order", { project: "示例 ERP 项目", title: "会话标题" });
    await writeQuestionExports(s, goldenBacklog());
    const md = readFileSync(join(s.dir, "问题清单.md"), "utf8");
    expect(md).toContain("## 1. 订单金额是含税还是不含税？"); // 插入序第一条
    const doc = JSON.parse(readFileSync(join(s.dir, "问题清单.json"), "utf8")) as {
      questions: { id: string }[];
    };
    expect(doc.questions.map((q) => q.id)).toEqual(["q-b", "q-a", "q-c", "q-d"]);
  });

  it("md 导出会拆掉旧问题中的机器协议，但 JSON 仍保留原文供审计", async () => {
    const s = makeSession("s-plain-export", { project: "示例 ERP 项目" });
    const bag = new QuestionBacklog();
    const raw = "[高][ERP顾问][blocked:sys_metaerp] 客户使用哪个系统版本？ | answer:TEXT | evidence:材料.docx#p1";
    bag.add(new Question({
      id: "q.agent.1",
      text: raw,
      why: "由 ERP_MAP 独立分析发现，需由相应业务角色确认",
    }), { preserveLifecycle: false });
    await writeQuestionExports(s, bag);

    const md = readFileSync(join(s.dir, "问题清单.md"), "utf8");
    expect(md).toContain("客户使用哪个系统版本？");
    expect(md).toContain("请谁回答：ERP顾问");
    expect(md).toContain("出处：材料.docx#p1");
    expect(md).not.toMatch(/q\.agent|blocked:|answer:TEXT|evidence:|ERP_MAP|状态：open|优先级：normal/u);

    const json = JSON.parse(readFileSync(join(s.dir, "问题清单.json"), "utf8")) as { questions: { text: string }[] };
    expect(json.questions[0]!.text).toBe(raw);
  });

  it("json 的结构等于 Python 侧的产物（schemaVersion / questions / summary）", async () => {
    const s = makeSession("s-json", { project: "示例 ERP 项目", title: "会话标题" });
    await writeQuestionExports(s, goldenBacklog());
    const got = JSON.parse(readFileSync(join(s.dir, "问题清单.json"), "utf8")) as unknown;
    // **按解析后的值比，不按字节比**：Python 的 `json.dumps` 把 `0.0` 写成
    // `"0.0"`，JS 写成 `"0"` —— 同一个 JSON 值的两种合法写法，整个仓库都有这处
    // 分叉（见 divergences）。结构、字段名、排序仍然逐项对上。
    expect(got).toEqual(JSON.parse(GOLDEN.exports.json));
  });

  it("summary 与 s.state.artifacts 的投影", async () => {
    const s = makeSession("s-stats", { project: "示例 ERP 项目", title: "会话标题" });
    const bag = goldenBacklog();
    await writeQuestionExports(s, bag);
    expect(bag.stats()).toEqual(GOLDEN.exports.stats);
    expect(s.state["artifacts"]).toEqual(GOLDEN.exports.artifacts);
  });

  it("空 backlog 也照样出三份文件（顾问那边不能拿到 404）", async () => {
    const s = makeSession("s-empty");
    await writeQuestionExports(s, new QuestionBacklog());
    const md = readFileSync(join(s.dir, "问题清单.md"), "utf8");
    expect(md).toContain("共 0 条，待处理 0 条。");
    expect(s.state["artifacts"]).toEqual(["问题清单.json", "问题清单.md", "问题清单.xlsx"]);
  });
});

describe("_question_payload", () => {
  it("没有 activeDecision 时两个字段都是 null", () => {
    const q = goldenBacklog().questions.get("q-a")!;
    expect(questionPayload(q)).toEqual(GOLDEN.payload.without_decision);
  });

  it("有 activeDecision 时把 answer 也投影上来", () => {
    const q = goldenBacklog().questions.get("q-a")!;
    expect(questionPayload(q, goldenDecision())).toEqual(GOLDEN.payload.with_decision);
  });
});

describe("_expected_version", () => {
  it("golden 的每一种输入（含 int() 对浮点 / 数字串 / bool 的语义）", () => {
    for (const row of GOLDEN.expected_version) {
      if (row.error) {
        expect(() => expectedVersionOf(row.body), JSON.stringify(row.body)).toThrowError(
          expect.objectContaining({ status: row.error[0] }),
        );
      } else {
        expect(expectedVersionOf(row.body), JSON.stringify(row.body)).toBe(row.out ?? null);
      }
    }
  });
});

describe("_predict_decision_effect", () => {
  const cf = (...options: ReturnType<typeof makeOption>[]): Conflict =>
    makeConflict("cf_2", ConflictKind.SEMANTIC_DIVERGENCE, ["p_1", "p_2", "p_3"], "口径不一致", {
      options,
    });
  const effects: Record<string, Conflict | null> = {
    no_conflict: null,
    split: cf(makeOption("o1", "拆", "", { effect: { split: ["p_1", "p_3"] } })),
    unify_to: cf(makeOption("o2", "统一", "", { effect: { unify_to: "p_2" } })),
    set_base_type: cf(makeOption("o3", "改类型", "", { effect: { set_base_type: "decimal" } })),
    empty_effect: cf(makeOption("o4", "无副作用")),
    missing_option: cf(makeOption("o1", "拆")),
  };

  it("四条分支 + 找不到选项时的 422 消息原文", () => {
    const q = goldenBacklog().questions.get("q-b")!;
    for (const row of GOLDEN.predict_effect) {
      const target = effects[row.what] ?? null;
      if (row.error) {
        let caught: unknown;
        try {
          predictDecisionEffect(q, target, row.option);
        } catch (e) {
          caught = e;
        }
        expect(caught, row.what).toBeInstanceOf(HTTPException);
        expect((caught as HTTPException).status).toBe(row.error[0]);
        expect((caught as HTTPException).message).toBe(row.error[1]);
      } else {
        expect(predictDecisionEffect(q, target, row.option), row.what).toEqual(row.out);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  GET /questions
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/{sid}/questions", () => {
  it("questions / summary / nextBatch / revision 四个字段", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const res = await makeApp().request("/api/sessions/s1/questions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      questions: { id: string; answer: unknown; activeDecision: unknown }[];
      summary: Record<string, number>;
      nextBatch: string[];
      revision: number;
    };
    // repo 的 listQuestions 按 (created, id) 排 —— 与 json 导出那份"阻塞项优先"
    // 的排序**不是**同一个，别把两者混起来。
    expect(body.questions.map((q) => q.id)).toEqual(["q-a", "q-b", "q-c", "q-d"]);
    expect(body.summary).toEqual(GOLDEN.exports.stats);
    // q-a 依赖 q-b，q-b 没关闭 —— 所以下一批只有 q-b。
    expect(body.nextBatch).toEqual(GOLDEN.next_batch["0"]);
    expect(body.revision).toBe(0);
  });

  it("limit 的钳位：`max(1, min(limit or 5, 50))`", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    for (const limit of ["0", "1", "2", "99", "-3"]) {
      const res = await makeApp().request(`/api/sessions/s1/questions?limit=${limit}`);
      const body = (await res.json()) as { nextBatch: string[] };
      expect(body.nextBatch, limit).toEqual(GOLDEN.next_batch[limit]);
    }
  });

  it("非整数 limit → 422（FastAPI 的 pydantic 会拦）", async () => {
    makeSession("s1");
    const res = await makeApp().request("/api/sessions/s1/questions?limit=abc");
    expect(res.status).toBe(422);
  });

  it("activeDecision 投影：answer 跟着最新一条未被 supersede 的 Decision 走", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    await repo.recordDecisionV1(
      "s1",
      makeDecisionRecordRow({
        id: "dec_1",
        question_id: "q-a",
        answer: "不含税",
        actor: "fde",
        idempotency_key: "k1",
        semantic_hash: "h1",
        metadata: { status: "applied" },
      }),
    );
    // failed 的那条**不进投影** —— 否则界面会显示一个其实没生效的答案。
    await repo.recordDecisionV1(
      "s1",
      makeDecisionRecordRow({
        id: "dec_2",
        question_id: "q-c",
        answer: "要复核",
        actor: "fde",
        idempotency_key: "k2",
        semantic_hash: "h2",
        metadata: { status: "failed" },
      }),
    );
    const res = await makeApp().request("/api/sessions/s1/questions");
    const body = (await res.json()) as { questions: { id: string; answer: unknown }[] };
    const byId = new Map(body.questions.map((q) => [q.id, q.answer]));
    expect(byId.get("q-a")).toBe("不含税");
    expect(byId.get("q-c")).toBeNull();
  });

  it("state 里没有 backlog 而 _oir 在 → 先跑一次 _sync_question_backlog", async () => {
    const s = makeSession("s1");
    s.state["_oir"] = new OIR();
    const res = await makeApp().request("/api/sessions/s1/questions");
    expect(res.status).toBe(200);
    expect(synced).toBe(1);
  });

  it("既没有 backlog 也没有 _oir → 不去碰那个还没接线的零件", async () => {
    makeSession("s1");
    const res = await makeApp().request("/api/sessions/s1/questions");
    expect(res.status).toBe(200);
    expect(synced).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  GET /questions/export
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/{sid}/questions/export", () => {
  it("三种格式的 Content-Type 与 Content-Disposition 逐字对上 Python", async () => {
    const s = makeSession("s1", { project: "示例 ERP 项目", title: "会话标题" });
    s.state["question_backlog"] = goldenBacklog().toDict();
    for (const fmt of ["xlsx", "md", "json"]) {
      const res = await makeApp().request(`/api/sessions/s1/questions/export?format=${fmt}`);
      expect(res.status, fmt).toBe(200);
      expect(res.headers.get("content-type"), fmt).toBe(GOLDEN.media[fmt]);
      expect(res.headers.get("content-disposition"), fmt).toBe(GOLDEN.content_disposition[fmt]);
    }
  });

  it("缺省 format 是 xlsx，且真的是一份 zip（xlsx 的魔数）", async () => {
    const s = makeSession("s1");
    s.state["question_backlog"] = goldenBacklog().toDict();
    const res = await makeApp().request("/api/sessions/s1/questions/export");
    expect(res.headers.get("content-type")).toBe(GOLDEN.media["xlsx"]);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("format 大小写不敏感", async () => {
    const s = makeSession("s1");
    s.state["question_backlog"] = goldenBacklog().toDict();
    const res = await makeApp().request("/api/sessions/s1/questions/export?format=MD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(GOLDEN.exports.md.replace("示例 ERP 项目", "新建会话"));
  });

  it("不认识的 format → 400", async () => {
    makeSession("s1");
    for (const fmt of ["pdf", "", "docx"]) {
      const res = await makeApp().request(`/api/sessions/s1/questions/export?format=${fmt}`);
      expect(res.status, fmt).toBe(400);
      expect(((await res.json()) as { detail: string }).detail).toBe("format 只支持 xlsx、md、json");
    }
  });

  it("导出这条路复用 artifacts 段的 contentDisposition，不是第二份实现", () => {
    for (const [fmt, name] of Object.entries({
      xlsx: "问题清单.xlsx",
      md: "问题清单.md",
      json: "问题清单.json",
    })) {
      expect(contentDisposition(name)).toBe(GOLDEN.content_disposition[fmt]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  PATCH /questions/{qid}
// ══════════════════════════════════════════════════════════════════

async function patch(app: Hono<AppEnv>, qid: string, body: unknown): Promise<Response> {
  return await app.request(`/api/sessions/s1/questions/${qid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/sessions/{sid}/questions/{qid}", () => {
  beforeEach(async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
  });

  it("分派负责人：状态进 assigned、version 只推进一次", async () => {
    const res = await patch(makeApp(), "q-a", { ownerUserId: " zhang ", audienceRole: "财务" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      question: { ownerUserId: string; status: string; version: number; audienceRole: string };
      summary: Record<string, number>;
      status: string;
    };
    expect(body.question.ownerUserId).toBe("zhang"); // strip 过
    expect(body.question.status).toBe("assigned");
    expect(body.question.audienceRole).toBe("财务");
    // 一个 PATCH 改三个字段只算**一次** revision（server.py 那条注释的兑现）。
    expect(body.question.version).toBe(1);
    expect(body.status).toBe("awaiting_answer");
  });

  it("清空负责人：assigned 回落成 open", async () => {
    const app = makeApp();
    await patch(app, "q-a", { ownerUserId: "zhang" });
    const res = await patch(app, "q-a", { ownerUserId: "" });
    const body = (await res.json()) as { question: { status: string; ownerUserId: string } };
    expect(body.question.status).toBe("open");
    expect(body.question.ownerUserId).toBe("");
  });

  it("只改角色时不动 owner", async () => {
    const res = await patch(makeApp(), "q-a", { audienceRole: " 业务 " });
    const body = (await res.json()) as { question: { audienceRole: string; status: string } };
    expect(body.question.audienceRole).toBe("业务");
    expect(body.question.status).toBe("open");
  });

  it("priority 的 medium 兼容：API 边界收，库里只存 normal", async () => {
    const res = await patch(makeApp(), "q-c", { priority: "MEDIUM" });
    const body = (await res.json()) as { question: { priority: string } };
    expect(body.question.priority).toBe("normal");
  });

  it("status=deferred：pending 归零就把会话标 done，并触发一次重算", async () => {
    const s = SESSIONS.get("s1")!;
    s.state["_oir"] = new OIR();
    const app = makeApp();
    await patch(app, "q-b", { status: "deferred" });
    const res = await patch(app, "q-a", { status: "deferred" });
    const body = (await res.json()) as { status: string; summary: Record<string, number> };
    expect(body.status).toBe("done");
    expect(body.summary["deferred"]).toBe(2);
    // deferred/cancelled 是"释放边界"，`_oir` 在就要重算一次。
    expect(recompiled).toBe(2);
  });

  it("没有 _oir 时不去碰还没接线的 _recompile", async () => {
    const res = await patch(makeApp(), "q-a", { status: "deferred" });
    expect(res.status).toBe(200);
    expect(recompiled).toBe(0);
  });

  it("answered 只能走 /answer → 400", async () => {
    const res = await patch(makeApp(), "q-a", { status: "answered" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "answered 必须通过 /answer 记录 Decision",
    );
  });

  it("不认识的状态 / 优先级 → 400，消息带上原值", async () => {
    let res = await patch(makeApp(), "q-a", { status: "半开" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("不支持的问题状态 半开");
    res = await patch(makeApp(), "q-a", { priority: "紧急" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("不支持的优先级 紧急");
  });

  it("一个可更新字段都没有 → 400", async () => {
    const res = await patch(makeApp(), "q-a", { reason: "随便写点什么" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("没有可更新的 Question 字段");
  });

  it("不存在的问题 → 404", async () => {
    const res = await patch(makeApp(), "q-zzz", { priority: "high" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe("没有问题 q-zzz");
  });

  it("expected_revision 对不上 → 409（乐观锁，前端据此提示刷新）", async () => {
    const res = await patch(makeApp(), "q-a", { priority: "high", expected_revision: 7 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "问题已更新：预期 version 7，实际 0",
    );
  });

  it("expected_revision 对得上 → CAS 成功，version 加一", async () => {
    const res = await patch(makeApp(), "q-a", { priority: "high", expectedRevision: 0 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { version: number; priority: string } };
    expect(body.question.version).toBe(1);
    expect(body.question.priority).toBe("high");
  });

  it("**加锁顺序**：mutation 租约在外、questionLock 在内", async () => {
    await patch(makeApp(), "q-a", { priority: "high" });
    expect(mutationKinds).toEqual(["question.update"]);
    // 进 mutation 时 questionLock 还没被占 —— 反过来就是 A 持锁等租约、
    // B 持租约等锁的死锁。
    expect(mutationSawLock).toEqual([false]);
    // 真正干活时两把都握着。
    expect(persistSawLock.every((v) => v)).toBe(true);
    expect(persistSawMutation.every((d) => d > 0)).toBe(true);
    expect(persistSawLock.length).toBeGreaterThan(0);
  });

  it("并发两个 PATCH：questionLock 让它们串行，不会互相吃掉版本", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      patch(app, "q-a", { priority: "high" }),
      patch(app, "q-a", { priority: "low" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const row = await repo.getQuestion("s1", "q-a");
    expect(row?.version).toBe(2); // 两次各推进一个 revision
  });
});

// ══════════════════════════════════════════════════════════════════
//  POST /questions/{qid}/reopen
// ══════════════════════════════════════════════════════════════════
describe("POST /api/sessions/{sid}/questions/{qid}/reopen", () => {
  beforeEach(async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
  });

  it("answered → open，会话回到 awaiting_answer", async () => {
    const res = await makeApp().request("/api/sessions/s1/questions/q-c/reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "FDE 重新打开" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question: { status: string; version: number }; status: string };
    expect(body.question.status).toBe("open");
    expect(body.question.version).toBe(1);
    expect(body.status).toBe("awaiting_answer");
    expect(mutationKinds).toEqual(["question.reopen"]);
    expect(mutationSawLock).toEqual([false]);
  });

  it("空 body 也认（`body: dict | None = None`）", async () => {
    const res = await makeApp().request("/api/sessions/s1/questions/q-d/reopen", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { question: { status: string } }).question.status).toBe("open");
  });

  it("不存在的问题 → 404", async () => {
    const res = await makeApp().request("/api/sessions/s1/questions/nope/reopen", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
//  POST /questions/{qid}/answer —— 幂等是这一段的命根子
// ══════════════════════════════════════════════════════════════════

async function answer(app: Hono<AppEnv>, qid: string, body: unknown): Promise<Response> {
  return await app.request(`/api/sessions/s1/questions/${qid}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sessions/{sid}/questions/{qid}/answer", () => {
  beforeEach(async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
  });

  it("一次正常回答：Decision 落库、问题进 answered、Revision 记一笔", async () => {
    const res = await answer(makeApp(), "q-a", {
      answer: "不含税",
      answerText: "以 ERP 里的净额为准",
      actor: "fde",
      actorRole: "财务",
      authority: "财务总监",
      idempotencyKey: "idem-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      decision: {
        id: string;
        answer: string;
        actor: string;
        actorRole: string;
        authority: string;
        rationale: string;
        metadata: Record<string, string>;
      };
      created: boolean;
      question: { status: string; answer: string };
      pending: number;
      status: string;
      applied: unknown;
    };
    expect(body.created).toBe(true);
    expect(body.decision.id.startsWith("dec_")).toBe(true);
    expect(body.decision.answer).toBe("不含税");
    // 普通业务问题保持兼容：没有 HTTP principal 时仍沿用原 body 身份字段。
    expect(body.decision).toMatchObject({
      actor: "fde",
      actorRole: "财务",
      authority: "财务总监",
    });
    expect(body.decision.metadata["status"]).toBe("applied");
    expect(body.question.status).toBe("answered");
    expect(body.question.answer).toBe("不含税");
    expect(body.applied).toBeNull(); // 非 conflict：没有 OIR 副作用
    expect(body.pending).toBe(1); // 只剩 q-b
    expect(body.status).toBe("awaiting_answer");

    expect(await repo.listDecisionsV1("s1")).toHaveLength(1);
    const revs = await repo.listRevisions("s1");
    expect(revs).toHaveLength(1);
    expect(revs[0]!.kind).toBe("question_answer");
    expect(revs[0]!.idempotency_key).toBe("answer:idem-1");
    expect(mutationKinds).toEqual(["question.answer"]);
    expect(mutationSawLock).toEqual([false]);
  });

  it("正式验收：普通用户即便在 body 伪造 admin 仍返回 403", async () => {
    const s = SESSIONS.get("s1")!;
    await seed(s, backlogWithReleaseAcceptance());
    const res = await answer(
      makeApp({}, { id: "user-1", username: "alice", role: "user" }),
      "q-release-acceptance",
      {
        answer: "APPROVE",
        actor: "forged-admin",
        actorRole: "admin",
        authority: "admin",
        idempotencyKey: "release-forged",
      },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toBe("正式验收需要管理员权限");
    expect(await repo.listDecisionsV1("s1")).toHaveLength(0);
    expect((await repo.getQuestion("s1", "q-release-acceptance"))?.status).toBe(
      QuestionStatus.OPEN,
    );
  });

  it("正式验收：认证 admin 覆盖 body 伪造身份并把真实 principal 落进 Ledger", async () => {
    const s = SESSIONS.get("s1")!;
    await seed(s, backlogWithReleaseAcceptance());
    const res = await answer(
      makeApp({}, { id: "admin-42", username: "root", role: "admin" }),
      "q-release-acceptance",
      {
        answer: "APPROVE",
        actor: "mallory",
        actorRole: "user",
        authority: "业务总监",
        idempotencyKey: "release-admin",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: Record<string, unknown> };
    expect(body.decision).toMatchObject({
      actor: "admin-42",
      actorRole: "admin",
      authority: "admin",
    });
    const rows = await repo.listDecisionsV1("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "admin-42",
      actor_role: "admin",
      authority: "admin",
    });
  });

  it("正式验收：开放模式注入的 synthetic admin 可完成签字", async () => {
    const s = SESSIONS.get("s1")!;
    await seed(s, backlogWithReleaseAcceptance());
    const res = await answer(
      makeApp({}, { id: "__local__", username: "local", role: "admin" }),
      "q-release-acceptance",
      { answer: "REJECT", idempotencyKey: "release-local" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { decision: Record<string, unknown> }).decision).toMatchObject({
      actor: "__local__",
      actorRole: "admin",
      authority: "admin",
    });
  });

  it("正式验收：内部/对话直调没有可验证 principal 时同样拒绝", async () => {
    const s = SESSIONS.get("s1")!;
    await seed(s, backlogWithReleaseAcceptance());
    await expect(answerDomainQuestion(
      s,
      "q-release-acceptance",
      {
        answer: "APPROVE",
        actor: "fde",
        actorRole: "admin",
        authority: "admin",
        idempotencyKey: "release-dialogue-forged",
      },
      makeDeps(),
      { mutationClaimed: true },
    )).rejects.toMatchObject({ status: 403 });
    expect(await repo.listDecisionsV1("s1")).toHaveLength(0);
  });

  it("**同一个 idempotencyKey 重放**：返回同一条 Decision，不插第二条", async () => {
    const app = makeApp();
    const payload = {
      answer: "不含税",
      answerText: "以 ERP 里的净额为准",
      actor: "fde",
      idempotencyKey: "idem-1",
    };
    const first = (await (await answer(app, "q-a", payload)).json()) as {
      decision: { id: string };
      created: boolean;
    };
    const second = (await (await answer(app, "q-a", payload)).json()) as {
      decision: { id: string };
      created: boolean;
      question: { status: string };
      applied: unknown;
    };

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.question.status).toBe("answered");
    expect(second.applied).toBeNull(); // 重放**不再**执行副作用
    // 库里始终只有一条 Decision、一条 Revision —— 这就是 decision_live_answer_uq
    // 加幂等键的意义：重复提交不会把同一个决定应用两次。
    expect(await repo.listDecisionsV1("s1")).toHaveLength(1);
    expect(await repo.listRevisions("s1")).toHaveLength(1);
  });

  it("并发两次相同提交：也只落一条", async () => {
    const app = makeApp();
    const payload = { answer: "不含税", actor: "fde", idempotencyKey: "idem-x" };
    const [a, b] = await Promise.all([answer(app, "q-a", payload), answer(app, "q-a", payload)]);
    const ja = (await a.json()) as { created: boolean; decision: { id: string } };
    const jb = (await b.json()) as { created: boolean; decision: { id: string } };
    expect([ja.created, jb.created].sort()).toEqual([false, true]);
    expect(ja.decision.id).toBe(jb.decision.id);
    expect(await repo.listDecisionsV1("s1")).toHaveLength(1);
    expect(await repo.listRevisions("s1")).toHaveLength(1);
  });

  it("同一个幂等键换了另一份答案 → 409", async () => {
    const app = makeApp();
    await answer(app, "q-a", { answer: "不含税", actor: "fde", idempotencyKey: "idem-1" });
    const res = await answer(app, "q-a", { answer: "含税", actor: "fde", idempotencyKey: "idem-1" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "幂等键 'idem-1' 已用于另一份回答",
    );
  });

  it("上一次回写失败过 → 409 并把原因带出来，而不是假装成功", async () => {
    await repo.recordDecisionV1(
      "s1",
      makeDecisionRecordRow({
        id: "dec_old",
        question_id: "q-a",
        answer: "不含税",
        actor: "fde",
        idempotency_key: "idem-1",
        semantic_hash: new Decision({
          id: "",
          questionId: "q-a",
          answer: "不含税",
          actor: "fde",
          actorRole: "财务",
          idempotencyKey: "idem-1",
        }).fingerprint,
        metadata: { status: "failed", error: "RuntimeError: 炸了" },
      }),
    );
    const res = await answer(makeApp(), "q-a", {
      answer: "不含税",
      actor: "fde",
      idempotencyKey: "idem-1",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "上次回答回写失败：RuntimeError: 炸了",
    );
  });

  it("answer 为空 / 缺 idempotencyKey → 400", async () => {
    let res = await answer(makeApp(), "q-a", { answer: "", idempotencyKey: "k" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("answer 不能为空");
    res = await answer(makeApp(), "q-a", { answer: "不含税" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("idempotencyKey 必填");
  });

  it("deferred 的问题不能直接答 → 409，且**一个副作用都没提交**", async () => {
    const app = makeApp();
    await patch(app, "q-a", { status: "deferred" });
    const res = await answer(app, "q-a", { answer: "不含税", idempotencyKey: "k" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "问题当前状态为 deferred，不能直接回答；请先重新打开。",
    );
    expect(await repo.listDecisionsV1("s1")).toHaveLength(0);
    expect(await repo.listRevisions("s1")).toHaveLength(0);
  });

  // 契约演进：结论必须能落账。以前 agent_analysis 一刀切 409，4000+ 条专业
  // 分析问题一条都答不了，SOR 归属这类业务结论无处安放。现在照常进 Decision
  // Ledger、问题转 ANSWERED，但不做任何字段级回写（无 applyDecision），并在
  // metadata 里显式标注 manual_conclusion。
  it("agent_analysis 回答落账为人工结论：ANSWERED + Decision，但零字段回写", async () => {
    const s = SESSIONS.get("s1")!;
    const bag = goldenBacklog();
    bag.add(
      new Question({
        id: "q-agent-erp",
        text: "当前 ERP 模块是什么？",
        audienceRole: "ERP顾问",
        priority: QuestionPriority.HIGH,
        sourceKind: "agent_analysis",
        sourceRef: "ERP_MAP",
        createdAt: T0 + 5,
        updatedAt: T0 + 5,
      }),
      { preserveLifecycle: false },
    );
    await seed(s, bag);

    const res = await answer(makeApp(), "q-agent-erp", {
      answer: "MM",
      idempotencyKey: "agent-answer-1",
    });

    expect(res.status).toBe(200);
    const saved = (await repo.getQuestion("s1", "q-agent-erp"))!;
    expect(saved.status).toBe(QuestionStatus.ANSWERED);
    expect((saved.doc["metadata"] as Record<string, unknown>)["writeback"]).toBe("manual_conclusion");
    const decisions = await repo.listDecisionsV1("s1");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.affected_ids).toEqual([]);   // 零字段回写
  });

  // fail-closed 的行为不变（409，不是 500，也不是静默落一条空决定）。
  // 契约演进：冲突没了 = 问题失去了存在理由（重跑后不再成立/已被自动修复）。
  // 以前只甩 409 —— 而 INTERVIEW 关口正拿这类问题当 blocking，用户答一条
  // 409 一条，HITL 永久死锁（真实案发：5 条 naming lint 引用的
  // cf_naming_violation_* 早被 auto_repair 清掉）。现在把问题标废并如实告知。
  it("conflict 问题但冲突找不到 → 问题标废（CANCELLED），不再 409 死锁关口", async () => {
    const res = await answer(makeApp(), "q-b", { answer: "o1", idempotencyKey: "k" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; note: string; question_id: string };
    expect(body.status).toBe("cancelled");
    expect(body.note).toContain("cf_2");
    expect(body.note).toContain("不需要回答");
    // 问题真的进了终态 —— 关口的 blocking 判定不再被它拦住
    const s = SESSIONS.get("s1")!;
    const q = [...questionBacklog(s).questions.values()].find((x) => x.id === "q-b")!;
    expect(q.status).toBe("cancelled");
  });

  it("不存在的问题 → 404", async () => {
    const res = await answer(makeApp(), "nope", { answer: "x", idempotencyKey: "k" });
    expect(res.status).toBe(404);
  });

  it("open_question 的回答会写回 OIR 的 OpenQuestion（USER 出处）", async () => {
    const s = SESSIONS.get("s1")!;
    const oir = new OIR();
    oir.questions.set("oq_1", {
      rid: "oq_1",
      text: extracted("订单金额是含税还是不含税？"),
      options: [],
      answer: extracted(""),
      group: "",
      code: "",
      appliesTo: [],
      askedBy: "",
      owner: null,
      status: Status.CANDIDATE,
    });
    s.state["_oir"] = oir;
    const res = await answer(makeApp(), "q-a", {
      answer: "不含税",
      answerText: "以 ERP 里的净额为准",
      idempotencyKey: "k",
    });
    expect(res.status).toBe(200);
    expect(oir.questions.get("oq_1")!.answer.value).toBe("以 ERP 里的净额为准");
    expect(oir.questions.get("oq_1")!.answer.origin).toBe(Origin.USER);
    expect(recompiled).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  GET /revisions
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/{sid}/revisions", () => {
  it("空会话是 count 0 / current 0，不是 404", async () => {
    makeSession("s1");
    const res = await makeApp().request("/api/sessions/s1/revisions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revisions: [], count: 0, current: 0 });
  });

  it("答完一题后能看到那一笔", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const app = makeApp();
    await answer(app, "q-a", { answer: "不含税", idempotencyKey: "k" });
    const res = await app.request("/api/sessions/s1/revisions");
    const body = (await res.json()) as {
      revisions: { kind: string; status: string }[];
      count: number;
      current: number;
    };
    expect(body.count).toBe(1);
    expect(body.current).toBe(1); // appendRevision 从 1 开始发号
    expect(body.revisions[0]!.kind).toBe("question_answer");
    expect(body.revisions[0]!.status).toBe("applied");
  });
});

// ══════════════════════════════════════════════════════════════════
//  POST /answer —— 旧 conflict API 的兼容入口
// ══════════════════════════════════════════════════════════════════

/** 一个 unify_to 的冲突 + 对应的 OIR，用来真跑一次 applyDecision。 */
function conflictFixture(s: SessionT): void {
  const oir = new OIR();
  for (const rid of ["p_1", "p_2"]) {
    oir.properties.set(
      rid,
      makePropertyType({
        rid,
        parent: "o_1",
        apiName: extracted(rid),
        displayName: extracted(rid),
        baseType: extracted(BaseType.STRING),
        definition: extracted(rid === "p_2" ? "不含税净额" : "含税金额"),
      }),
    );
  }
  s.state["_oir"] = oir;
  s.state["_conflicts"] = [
    makeConflict("cf_2", ConflictKind.SEMANTIC_DIVERGENCE, ["p_1", "p_2"], "口径不一致", {
      options: [makeOption("o2", "统一为 p_2", "", { effect: { unify_to: "p_2" } })],
    }),
  ];
}

describe("POST /api/sessions/{sid}/answer（兼容入口）", () => {
  beforeEach(async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    conflictFixture(s);
  });

  const legacy = async (app: Hono<AppEnv>, body: unknown): Promise<Response> =>
    await app.request("/api/sessions/s1/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("按 conflict_rid 找到问题、复用统一 Decision Ledger、真回写 OIR", async () => {
    const s = SESSIONS.get("s1")!;
    const res = await legacy(makeApp(), {
      conflict_rid: "cf_2",
      option_id: "o2",
      note: "由 FDE 在问题工作台确认",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: boolean;
      decision: { actor: string; rationale: string; affectedIds: string[] };
      applied: { changed: string[] };
      question: { status: string };
    };
    expect(body.created).toBe(true);
    expect(body.decision.actor).toBe("fde"); // setdefault("actor", "fde")
    expect(body.decision.rationale).toBe("由 FDE 在问题工作台确认");
    expect(body.decision.affectedIds).toEqual(["p_1"]); // unify_to：除 target 外
    expect(body.applied.changed).toEqual(["p_1"]);
    expect(body.question.status).toBe("answered");
    const oir = s.state["_oir"] as OIR;
    expect(oir.properties.get("p_1")!.definition.value).toBe("不含税净额");
    expect(oir.properties.get("p_1")!.definition.origin).toBe(Origin.USER);
    // `cf_` 前缀的问题答完要进 s.state.answered（旧界面读它）
    expect(s.state["answered"]).toEqual(["cf_2"]);
  });

  it("旧调用方没有幂等头 → 用 session+conflict+option 生成稳定键，重放天然幂等", async () => {
    const app = makeApp();
    const payload = { conflict_rid: "cf_2", option_id: "o2", note: "确认" };
    const a = (await (await legacy(app, payload)).json()) as { created: boolean; decision: { idempotencyKey: string; id: string } };
    const b = (await (await legacy(app, payload)).json()) as { created: boolean; decision: { id: string } };
    expect(a.decision.idempotencyKey).toBe("legacy:s1:cf_2:o2");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.decision.id).toBe(a.decision.id);
    expect(await repo.listDecisionsV1("s1")).toHaveLength(1);
    expect(await repo.listRevisions("s1")).toHaveLength(1);
  });

  it("找不到冲突 → 先试一次迁移，还找不到才 404", async () => {
    const res = await legacy(makeApp(), { conflict_rid: "cf_999", option_id: "o1" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe("没有冲突 cf_999");
    expect(synced).toBe(1); // 历史会话的即时迁移确实试过了
  });

  it("没给 option_id → answer 为空 → 400", async () => {
    const res = await legacy(makeApp(), { conflict_rid: "cf_2" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("answer 不能为空");
  });
});

// ══════════════════════════════════════════════════════════════════
//  chat 工具那条路：mutationClaimed
// ══════════════════════════════════════════════════════════════════
describe("跑批时排队 —— 但只对真的在跑批的那一种冲突", () => {
  // 2026-08-25 对抗式复查抓到的洞：第一版按中文文案分诊（/正在梳理/），而
  // withSessionMutation 抢不到租约时的**通用**文案是「会话正在梳理或另一个领域
  // 修改尚未提交」—— work 模式一整轮聊天独占 mutation 租约就会走这句。那种会话
  // 根本没有 Run 会来 drain 队列：拍板被排进去 = 界面说「跑完自动落账」、实际
  // 永远不落。比当场报错更糟，因为人以为已经交上去了。
  const busyExc = () => new HTTPException(409, {
    message: "会话正在梳理（parsing），本轮跑完才能保存这类修改；界面上的填写不会丢，稍后重试即可。",
    cause: BUILD_ACTIVE_CONFLICT,
  });
  const genericExc = () => new HTTPException(409, {
    message: "会话正在梳理或另一个领域修改尚未提交，请稍后重试。",
  });

  it("通用租约冲突（聊天轮持锁）→ 原样 409，不排队", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps({ sessionMutation: async () => { throw genericExc(); } });
    await expect(
      answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k-generic" }, deps),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.state["_decision_queue"]).toBeUndefined();
  });

  it("带跑批标记、且库里状态确实在跑 → 排队并诚实回执", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    s.status = "parsing" as never;
    // 状态复核问的是**库**，不是内存投影 —— 所以库里得有这一行
    await repo.createSession(makeSessionRow({ id: s.id, title: "t", status: "parsing" }));
    const deps = makeDeps({ sessionMutation: async () => { throw busyExc(); } });
    const out = await answerDomainQuestion(
      s, "q-a", { answer: "不含税", idempotencyKey: "k-queued" }, deps,
    ) as Record<string, unknown>;
    expect(out["queued"]).toBe(true);
    expect(String(out["message"])).toContain("跑完");
    expect((s.state["_decision_queue"] as unknown[]).length).toBe(1);
  });

  it("有标记但库里已经不在跑（那一瞬跑完了）→ 也不排队，原样报错让人重试", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps({ sessionMutation: async () => { throw busyExc(); } });
    await expect(
      answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k-stale" }, deps),
    ).rejects.toMatchObject({ status: 409 });
    expect(s.state["_decision_queue"]).toBeUndefined();
  });
});

describe("answerDomainQuestion(mutationClaimed)", () => {
  it("调用方已经持有 mutation 租约时**不再抢一次**，但 questionLock 照加", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps();
    const out = await answerDomainQuestion(
      s,
      "q-a",
      { answer: "不含税", idempotencyKey: "k" },
      deps,
      { mutationClaimed: true },
    );
    expect((out as { created: boolean }).created).toBe(true);
    expect(mutationKinds).toEqual([]); // 没有再 claim 一次
    expect(persistSawLock.every((v) => v)).toBe(true); // questionLock 仍然握着
    expect(s.questionLock.isLocked).toBe(false); // 出去时释放干净
  });

  // ── 事件要带得动「改了什么」 ────────────────────────────────
  //
  // 前端渲染 `question.answered` 时读的是事件 payload。payload 只有
  // `{question, decision, pending, affected}`，其中 affected 是**预测**的
  // rid 列表（predictDecisionEffect），不是实际变更；而人要看的
  // 「定了什么」（选中选项的原话）压根没进事件。
  //
  // 于是操作记录里每条「答复问题」要么空白、要么只有一串 rid。
  it("question.answered 事件带上拍板内容与**实际**变更，不只是预测的 rid", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    await answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k2" }, makeDeps(), {
      mutationClaimed: true,
    });
    const ev = (s.events as Record<string, unknown>[]).filter(
      (e) => e["kind"] === "question.answered",
    );
    expect(ev).toHaveLength(1);
    // 老字段仍在（别打断既有消费者）
    expect(ev[0]!["question"]).toBe("q-a");
    // 新字段：这两个是渲染层真正要用的
    expect(ev[0]).toHaveProperty("label");
    expect(ev[0]).toHaveProperty("changed");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Revision 快照：让 revision.diff 有地基
//
//  `snapshot_hash` 列早就存在（store/schema.ts:485，notNull 默认 ""），域字段、
//  行投影、pg 读写全都打通、只是**没人写**。答复路径造 Revision 时不给这个键，
//  于是每条 revision 的快照哈希都是空串 —— 两个 revision 之间没有任何可比的
//  内容，`revision.diff` 无从谈起。
//
//  两条硬约束：
//  · **快照失败绝不能让回答失败** —— 回答是这个产品里最重的一次人工输入，
//    为了写不进一个 blob 而把它丢掉是灾难性的；
//  · 但也**不许假装快照存在** —— 空哈希必须能与「写成功了但内容没变」区分开。
// ══════════════════════════════════════════════════════════════════

describe("Revision 快照", () => {
  it("答复成功时把快照 ref 写进 revision.snapshotHash", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps({ snapshot: async () => "sha256:deadbeef" });
    await answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k3" }, deps, {
      mutationClaimed: true,
    });
    const revs = await repo.listRevisions(s.id);
    expect(revs[revs.length - 1]!.snapshot_hash).toBe("sha256:deadbeef");
  });

  it("**快照抛错时回答照样成功** —— 不能为了一个 blob 丢掉人的输入", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps({
      snapshot: async () => {
        throw new Error("blob 写不进去");
      },
    });
    const out = await answerDomainQuestion(
      s, "q-a", { answer: "不含税", idempotencyKey: "k4" }, deps, { mutationClaimed: true },
    );
    expect((out as { created: boolean }).created).toBe(true);
  });

  it("快照失败要**看得见** —— 发一条事件，别让空哈希冒充「没变化」", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    const deps = makeDeps({
      snapshot: async () => {
        throw new Error("blob 写不进去");
      },
    });
    await answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k5" }, deps, {
      mutationClaimed: true,
    });
    const warn = (s.events as Record<string, unknown>[]).filter(
      (e) => e["kind"] === "revision.snapshot_failed",
    );
    expect(warn).toHaveLength(1);
    expect(String(warn[0]!["error"])).toContain("blob 写不进去");
  });

  it("没接 snapshot 依赖时一切照旧（哈希留空，不发告警）", async () => {
    const s = makeSession("s1");
    await seed(s, goldenBacklog());
    await answerDomainQuestion(s, "q-a", { answer: "不含税", idempotencyKey: "k6" }, makeDeps(), {
      mutationClaimed: true,
    });
    const warn = (s.events as Record<string, unknown>[]).filter(
      (e) => e["kind"] === "revision.snapshot_failed",
    );
    expect(warn).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  访谈包下载路由（发现 1：interview_kit 以前只有对话暗号一条出口）
// ══════════════════════════════════════════════════════════════════

describe("GET /questions/interview-kit", () => {
  it("路由转交 exportKit，按附件回字节", async () => {
    makeSession("s1");
    const app = makeApp({
      exportKit: async (_s, format) => ({
        name: `访谈提纲.${format}`,
        data: new TextEncoder().encode("kit-bytes"),
        mediaType: "application/test",
      }),
    });
    const res = await app.request("/api/sessions/s1/questions/interview-kit?format=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/test");
    expect(res.headers.get("Content-Disposition") ?? "").toContain("filename");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new TextEncoder().encode("kit-bytes"),
    );
  });

  it("组不出内容时 422 带原因 —— 不给一份空文件", async () => {
    makeSession("s1");
    const app = makeApp({ exportKit: async () => ({ error: "没有待确认的问题，访谈包没有内容。" }) });
    const res = await app.request("/api/sessions/s1/questions/interview-kit");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toContain("没有待确认");
  });

  it("未接线的部署 501 —— 能力缺席要说得出，不装 404", async () => {
    makeSession("s1");
    const app = makeApp();
    const res = await app.request("/api/sessions/s1/questions/interview-kit");
    expect(res.status).toBe(501);
  });
});
