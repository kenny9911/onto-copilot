/**
 * server 段 F+G —— AI 推荐问题 / 产物与溯源。
 *
 * 两件事在这里被钉死：
 *
 * 1. **推荐问题的产出契约**：至多 3 条、字段名 `text`/`send`/`group`、
 *    `send` 缺省等于 `text`。前端直接按这个形状渲染那三个气泡，少一条多一条
 *    都会在界面上看得见。
 * 2. **下载的两个头**：`Content-Type` 与 `Content-Disposition`。它们写错不会
 *    抛异常，只会让用户存下来的文件叫 `download.zip`、或者中文名变成乱码。
 *    期望值全部来自 `golden/server.artifacts.json` —— 由
 *    `tools/golden/server_artifacts.py` 从 Python + Starlette 真跑一遍导出，
 *    不是手写的猜测。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OIR } from "../src/onto/oir.js";
import { TemplateSpec } from "../src/onto/template.js";
import { MemoryRepo } from "../src/store/repo/memory.js";
import { makeQuestionRow, makeSessionRow } from "../src/store/types.js";
import { setRepoForTests } from "../src/store/deps.js";
import {
  contentDisposition,
  fileResponseDisposition,
  guessMediaType,
  registerArtifactRoutes,
  type ArtifactDeps,
  type ExportModule,
  type Upload,
  auditOnce,
} from "../src/server/routes/artifacts.js";
import {
  asPrompts,
  aiRecommend,
  emitAiPrompts,
  FDE_SYSTEM,
  FOLLOWUPS_SCHEMA,
  fastSpec,
  settleFollowups,
  traceAux,
  type ChatRunner,
} from "../src/server/routes/prompts.js";

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../golden/server.artifacts.json", import.meta.url)), "utf8"),
) as {
  content_disposition: { name: string; ascii_fallback: string; out: string }[];
  file_response: { name: string; media_type: string; content_disposition: string }[];
  resolve_format: { fmt: string; out: string }[];
  spec: Record<string, { ext: string; media_type: string; label: string }>;
};

// 必须在 import session.ts **之前**定下 workspace 根：那个模块级的 `_root`
// 在 import 时就求值了。vitest 的 import 提升让 `process.env` 赋值跑不到前面，
// 所以改用 refreshRoot()（session.ts 为 lifespan 留的那个口子）。
const ROOT = join(tmpdir(), `ontocopilot-artifacts-${process.pid}`);
process.env["ONTOCOPILOT_WORKSPACE"] = ROOT;

const { Session, SESSIONS, refreshRoot, registerHydrator } = await import(
  "../src/server/session.js"
);
type SessionT = InstanceType<typeof Session>;

// ══════════════════════════════════════════════════════════════════
//  夹具
// ══════════════════════════════════════════════════════════════════

/** `onto/export.py` 还没有 TS 对应件，这里给一个够用的替身：格式表与
 * `resolve_format` 的行为**照 golden 抄**，所以路由那一层仍然是真判据。 */
const FAKE_EXPORT: ExportModule = {
  resolveFormat(fmt) {
    const row = GOLDEN.resolve_format.find((r) => r.fmt === fmt);
    if (row) return row.out;
    const f = fmt.trim().toLowerCase().replace(/^\.+/, "");
    return f in GOLDEN.spec ? f : "";
  },
  tableBlock(columns, rows) {
    return [{ kind: "table", columns, rows }];
  },
  makeDoc(p) {
    return { title: p.title, blocks: p.blocks, note: p.note };
  },
  render(doc, fmt) {
    const spec = GOLDEN.spec[fmt];
    if (!spec) throw new Error(`unknown fmt ${fmt}`);
    return [new TextEncoder().encode(JSON.stringify(doc)), spec];
  },
  safeName(title, ext) {
    return `${title || "导出"}.${ext}`;
  },
};

const FAKE_REGISTRY = {
  parse: async (path: string) => ({
    chunks: [
      {
        cite: () => `${path.split("/").pop()}!Sheet1!R2-9`,
        render: "订单表：order_id 订单号，customer_id 客户".repeat(60),
        tags: ["table"],
        locator: { kind: "range", sheet: "Sheet1", rows: [2, 9] },
      },
      {
        cite: () => `${path.split("/").pop()}#/paths/~1orders`,
        render: "退货流程：客户发起 → 客服审核 → 财务退款",
        tags: ["flow"],
        locator: { kind: "json", pointer: "/paths/~1orders" },
      },
    ],
  }),
};

/** 从内存 zip 里取一个成员的正文。只认这一个包用到的 deflate/stored 两档 ——
 * 不是要写一个 zip 库，是不想为了看一眼 manifest 去装依赖。 */
function unzipMember(zip: Buffer, want: string): string {
  const target = Buffer.from(want, "utf8");
  for (let i = 0; i + 30 <= zip.length; i++) {
    if (zip.readUInt32LE(i) !== 0x04034b50) continue;
    const method = zip.readUInt16LE(i + 8);
    const compSize = zip.readUInt32LE(i + 18);
    const nameLen = zip.readUInt16LE(i + 26);
    const extraLen = zip.readUInt16LE(i + 28);
    const name = zip.subarray(i + 30, i + 30 + nameLen);
    if (!name.equals(target)) continue;
    const start = i + 30 + nameLen + extraLen;
    const data = zip.subarray(start, start + compSize);
    return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
  }
  throw new Error(`zip 里没有 ${want}`);
}

let repo: MemoryRepo;
let recompiled = 0;
let persisted = 0;

function makeDeps(over: Partial<ArtifactDeps> = {}): ArtifactDeps {
  return {
    exportModule: FAKE_EXPORT,
    preparse: async (s) => {
      const chunks: Record<string, unknown[]> = {};
      const files: Record<string, unknown>[] = [];
      const findings: Record<string, unknown>[] = [];
      for (const f of s.files) {
        if (f.name.toLowerCase().endsWith(".pdf")) {
          chunks[f.name] = [];
          files.push({ file: f.name, kind: "scan", chunks: 0, findings: 1 });
          findings.push({
            file: f.name, kind: "vision_pending", severity: "info",
            message: "扫描页待视觉识别", locator: {},
          });
          continue;
        }
        const doc = await FAKE_REGISTRY.parse(f.path);
        chunks[f.name] = doc.chunks.map((ch) => ({
          cite: ch.cite(), text: [...ch.render].slice(0, 1500).join(""),
          tags: [...ch.tags], locator: { ...ch.locator },
        }));
        files.push({ file: f.name, kind: "xlsx", chunks: doc.chunks.length, findings: 0 });
      }
      s.state["_chunks"] = chunks;
      s.state["_index"] = { built: true };
      s.state["corpus"] = { files, chunks: Object.values(chunks).flat().length, findings };
    },
    persist: async () => {
      persisted += 1;
    },
    recompile: async () => {
      recompiled += 1;
    },
    sessionMutation: async (_s, _kind, body) => body(),
    now: () => 1_700_000_000,
    ...over,
  };
}

function makeApp(over: Partial<ArtifactDeps> = {}): Hono {
  const app = new Hono();
  registerArtifactRoutes(app, makeDeps(over));
  return app;
}

/** 造一个在 SESSIONS 里、目录也真实存在的会话。 */
function makeSession(id: string, init: Record<string, unknown> = {}): SessionT {
  const s = new Session(id, init as never);
  SESSIONS.set(id, s);
  mkdirSync(s.dir, { recursive: true });
  return s;
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  refreshRoot();
  // 会话恢复不接线时 `sessAsync` 会显式抛；这里所有会话都预置进 SESSIONS，
  // 注册一个"找不到就 404"的 hydrator 才能测到路径不存在的分支。
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
  persisted = 0;
});

// ══════════════════════════════════════════════════════════════════
//  推荐问题的产出契约
// ══════════════════════════════════════════════════════════════════
describe("推荐问题：产出契约", () => {
  it("schema 只允许 3 条，且 text 必填、send 可缺省", () => {
    const q = (FOLLOWUPS_SCHEMA["properties"] as Record<string, Record<string, unknown>>)[
      "questions"
    ]!;
    expect(q["maxItems"]).toBe(3);
    const items = q["items"] as Record<string, unknown>;
    expect(items["required"]).toEqual(["text"]);
    expect(Object.keys(items["properties"] as object)).toEqual(["text", "send"]);
    expect(FDE_SYSTEM.startsWith("你在为一位 FDE")).toBe(true);
  });

  it("asPrompts：显示的和点下去发的是同一句话", () => {
    expect(asPrompts(["这批对象的口径谁定？"])).toEqual([
      { text: "这批对象的口径谁定？", send: "这批对象的口径谁定？", group: "" },
    ]);
  });

  it("settleFollowups：至多 3 条，空白丢掉，写回 state.followups", () => {
    const s = makeSession("s-settle");
    const out = settleFollowups(s, {
      modelQuestions: ["  一  ", "", "二", "三", "四"],
      reply: "答复",
    });
    expect(out.map((p) => p.text)).toEqual(["一", "二", "三"]);
    expect(out.every((p) => p.send === p.text && p.group === "")).toBe(true);
    expect(s.state["followups"]).toBe(out);
  });

  it("settleFollowups：模型一条都没给时退回启发式，且**永远不为空**", () => {
    const s = makeSession("s-heur");
    s.status = "done";
    s.files = [{ name: "订单.xlsx", size: 1, path: "x", sha256: "" }];
    const out = settleFollowups(s, { modelQuestions: [], reply: "这轮没跑通" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
    for (const p of out) {
      expect(p.send).not.toBe("");
      expect(typeof p.group).toBe("string");
    }
  });

  it("settleFollowups：内部状态（下划线开头）不进启发式", () => {
    const s = makeSession("s-private");
    // `_oir` 放一个会让 followupPrompts 崩掉的东西：真漏进去就会抛。
    s.state["_oir"] = { toDict: null };
    s.state["objects"] = 3;
    expect(() => settleFollowups(s, { modelQuestions: [] })).not.toThrow();
  });
});

describe("推荐问题：模型这一跳", () => {
  const runner =
    (data: unknown, usd = 0.01): ChatRunner =>
    async (_s, _opts, body) =>
      body({
        gw: {
          routing: { fast: null },
          call: async () =>
            ({ text: "", data, model: "m", usage: {}, usd, attempts: 1 }) as never,
        },
      });

  it("send 缺省等于 text；超过 3 条截断；空 text 跳过", async () => {
    const s = makeSession("s-rec");
    const got = await aiRecommend(
      s,
      {
        chatRun: runner({
          questions: [
            { text: "问题一" },
            { text: "  ", send: "被跳过" },
            { text: "问题二", send: "点下去发这句" },
            { text: "问题三" },
            { text: "问题四" },
          ],
        }),
        contextBrief: () => "状态",
      },
      { slot: "opening" },
    );
    expect(got).toEqual([
      { text: "问题一", send: "问题一", group: "" },
      { text: "问题二", send: "点下去发这句", group: "" },
      { text: "问题三", send: "问题三", group: "" },
    ]);
  });

  it("模型给空 → null（调用方据此退回启发式）", async () => {
    const s = makeSession("s-rec-empty");
    expect(
      await aiRecommend(
        s,
        { chatRun: runner({ questions: [] }), contextBrief: () => "" },
        { slot: "opening" },
      ),
    ).toBeNull();
  });

  it("网关抛错 → null，不把这一轮对话带下去", async () => {
    const s = makeSession("s-rec-boom");
    const got = await aiRecommend(
      s,
      {
        chatRun: async () => {
          throw new Error("gateway down");
        },
        contextBrief: () => "",
      },
      { slot: "followup", userText: "刚问的", reply: "刚答的" },
    );
    expect(got).toBeNull();
  });

  it("对话花费封顶后一分钱都不再花", async () => {
    const s = makeSession("s-rec-cap");
    s.state["_chat_usd"] = 3;
    let called = false;
    const got = await aiRecommend(
      s,
      {
        chatRun: async () => {
          called = true;
          throw new Error("不该被调到");
        },
        contextBrief: () => "",
      },
      { slot: "opening" },
    );
    expect(got).toBeNull();
    expect(called).toBe(false);
  });

  it("花费累加进 _chat_usd", async () => {
    const s = makeSession("s-rec-usd");
    s.state["_chat_usd"] = 0.25;
    await aiRecommend(
      s,
      { chatRun: runner({ questions: [{ text: "x" }] }, 0.75), contextBrief: () => "" },
      { slot: "opening" },
    );
    expect(s.state["_chat_usd"]).toBeCloseTo(1.0, 10);
  });

  it("提示词按状态拼装：没有 findings / 对话时那两段不出现", async () => {
    const s = makeSession("s-rec-prompt");
    s.state["corpus"] = { findings: [{ message: "缺主键" }, { message: "口径冲突" }] };
    s.state["_dialogue"] = {
      toDict: () => ({
        turns: [
          { speaker: "user", text: "订单表有哪些字段" },
          { speaker: "system", text: "不该出现" },
          { speaker: "assistant", text: "十二个" },
        ],
      }),
    };
    let seen = "";
    await aiRecommend(
      s,
      {
        chatRun: async (_s, opts, body) => {
          seen = String((opts.semanticInput as Record<string, unknown>)["prompt"]);
          return body({
            gw: {
              call: async () =>
                ({ text: "", data: { questions: [] }, model: "", usage: {}, usd: 0, attempts: 1 }) as never,
            },
          });
        },
        contextBrief: () => "当前：3 个对象",
      },
      { slot: "followup", userText: "他刚问的话" },
    );
    expect(seen).toContain("## 当前项目状态\n当前：3 个对象");
    expect(seen).toContain("缺主键；口径冲突");
    expect(seen).toContain("user: 订单表有哪些字段");
    expect(seen).not.toContain("不该出现"); // system 轮不进上下文
    expect(seen).toContain("## 他刚问的\n他刚问的话");
    expect(seen).not.toContain("## 刚给他的回复");
  });

  it("fastSpec：没有快档就给 null，不瞎编一个 effort", () => {
    expect(fastSpec(null)).toBeNull();
    expect(fastSpec({ call: async () => ({}) as never })).toBeNull();
    const spec = { name: "flash", provider: "x" } as never;
    expect(fastSpec({ routing: { fast: spec }, call: async () => ({}) as never })).toBe(spec);
  });
});

describe("推荐问题：后台开场那一跳", () => {
  const okRunner: ChatRunner = async (_s, _opts, body) =>
    body({
      gw: {
        call: async () =>
          ({
            text: "",
            data: { questions: [{ text: "从哪问起" }] },
            model: "",
            usage: {},
            usd: 0.2,
            attempts: 1,
          }) as never,
      },
    });

  const leaseRepo = (claim: boolean, renew = true) => {
    const calls: string[] = [];
    return {
      calls,
      claimChatLease: async () => {
        calls.push("claim");
        return claim;
      },
      renewChatLease: async () => {
        calls.push("renew");
        return renew;
      },
      releaseChatLease: async () => {
        calls.push("release");
        return true;
      },
    };
  };

  it("抢不到 chat 租约就什么都不做 —— 人的那一轮优先", async () => {
    const s = makeSession("s-emit-busy");
    const r = leaseRepo(false);
    await emitAiPrompts(s, {
      chatRun: okRunner,
      contextBrief: () => "",
      repo: r,
      persist: async () => undefined,
      newToken: () => "tok",
      sleep: async () => undefined,
    });
    expect(r.calls).toEqual(["claim"]);
    expect(s.events.some((e) => e["kind"] === "prompts.ready")).toBe(false);
  });

  it("算出来就发 prompts.ready，花了钱就落一次库，最后一定还租约", async () => {
    const s = makeSession("s-emit-ok");
    const r = leaseRepo(true);
    const saved: string[] = [];
    await emitAiPrompts(s, {
      chatRun: okRunner,
      contextBrief: () => "",
      repo: r,
      persist: async (_s, o) => {
        saved.push([...o.docsOnly].join(","));
      },
      workerId: "w1",
      newToken: () => "tok",
      // 心跳只等 abort：收尾时必须能把它叫醒，否则这条 finally 就挂住了。
      sleep: (_ms, signal) =>
        new Promise<void>((res) => signal.addEventListener("abort", () => res(), { once: true })),
    });
    expect(saved).toEqual(["_chat_usd"]);
    expect(r.calls.at(-1)).toBe("release");
    const ready = s.events.find((e) => e["kind"] === "prompts.ready");
    expect(ready).toBeDefined();
    expect(ready!["slot"]).toBe("opening");
    expect(ready!["questions"]).toEqual([{ text: "从哪问起", send: "从哪问起", group: "" }]);
    // 推理面板里只留"它在想什么"，不抄一份算出来的问题
    const aux = s.events.filter((e) => e["kind"] === "chat.step");
    expect(aux).toHaveLength(1);
    expect((aux[0]!["step"] as Record<string, unknown>)["thought"]).toBe(
      "想推荐问题：结合当前材料和产物，算他最该从哪问起",
    );
  });

  it("丢了 owner 就既不落花费也不投递提示（fenced）", async () => {
    const s = makeSession("s-emit-lost");
    const r = leaseRepo(true, false);
    let saves = 0;
    // 心跳先跑一轮续约失败，模型调用再返回 —— 顺序由这两个 await 决定。
    let beat!: () => void;
    const gate = new Promise<void>((res) => {
      beat = res;
    });
    await emitAiPrompts(s, {
      chatRun: async (_s, _o, body) =>
        body({
          gw: {
            call: async () => {
              beat();
              await new Promise((res) => setTimeout(res, 5));
              return {
                text: "",
                data: { questions: [{ text: "x" }] },
                model: "",
                usage: {},
                usd: 1,
                attempts: 1,
              } as never;
            },
          },
        }),
      contextBrief: () => "",
      repo: r,
      persist: async () => {
        saves += 1;
      },
      newToken: () => "tok",
      sleep: async () => {
        await gate;
      },
    });
    expect(saves).toBe(0);
    expect(s.events.some((e) => e["kind"] === "prompts.ready")).toBe(false);
    expect(r.calls.at(-1)).toBe("release");
  });

  it("traceAux 的序号在同一会话里递增", () => {
    const s = makeSession("s-aux");
    traceAux(s, "措辞", "一");
    traceAux(s, "想推荐问题", "二");
    const ns = s.events
      .filter((e) => e["kind"] === "chat.step")
      .map((e) => (e["step"] as Record<string, unknown>)["n"]);
    expect(ns).toEqual([1, 2]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  两个头（golden 钉住）
// ══════════════════════════════════════════════════════════════════
describe("下载头：与 Python 逐字节一致", () => {
  it("_content_disposition 的每一种取值", () => {
    for (const row of GOLDEN.content_disposition) {
      expect(contentDisposition(row.name, { asciiFallback: row.ascii_fallback })).toBe(row.out);
    }
  });

  it("FileResponse 的 media_type 与 content-disposition", () => {
    for (const row of GOLDEN.file_response) {
      expect(guessMediaType(row.name)).toBe(row.media_type);
      expect(fileResponseDisposition(row.name)).toBe(row.content_disposition);
    }
  });

  it("两条路的 disposition 刻意不同：大小写 utf-8 + 有没有 ASCII 兜底", () => {
    expect(fileResponseDisposition("模板_v1.xlsx")).toBe(
      "attachment; filename*=utf-8''%E6%A8%A1%E6%9D%BF_v1.xlsx",
    );
    expect(contentDisposition("模板_v1.xlsx")).toBe(
      "attachment; filename=\"download.xlsx\"; filename*=UTF-8''%E6%A8%A1%E6%9D%BF_v1.xlsx",
    );
  });
});

// ══════════════════════════════════════════════════════════════════
//  产物下载
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/:sid/artifacts/:name", () => {
  it("中文名 svg：类型对、名字能还原", async () => {
    const s = makeSession("a1");
    writeFileSync(join(s.dir, "流程图.svg"), "<svg/>", "utf8");
    const res = await makeApp().request("/api/sessions/a1/artifacts/%E6%B5%81%E7%A8%8B%E5%9B%BE.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=utf-8''%E6%B5%81%E7%A8%8B%E5%9B%BE.svg",
    );
    expect(await res.text()).toBe("<svg/>");
  });

  it("xlsx 走的是 apache 那张表里的类型，不是 octet-stream", async () => {
    const s = makeSession("a2");
    writeFileSync(join(s.dir, "模板_v1.xlsx"), "PK", "binary");
    const res = await makeApp().request("/api/sessions/a2/artifacts/%E6%A8%A1%E6%9D%BF_v1.xlsx");
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("不存在 → 404，名字原样回显", async () => {
    makeSession("a3");
    const res = await makeApp().request("/api/sessions/a3/artifacts/nope.json");
    expect(res.status).toBe(404);
  });

  it("路径穿越：basename 之后落在会话目录里，取不到外面的文件", async () => {
    const s = makeSession("a4");
    writeFileSync(join(ROOT, "外面.txt"), "secret", "utf8");
    expect(existsSync(join(s.dir, "外面.txt"))).toBe(false);
    const res = await makeApp().request("/api/sessions/a4/artifacts/..%2F%E5%A4%96%E9%9D%A2.txt");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:sid/exports/:name", () => {
  it("用的是带 ASCII 兜底的那一版 disposition", async () => {
    const s = makeSession("e1");
    mkdirSync(join(s.dir, "exports"), { recursive: true });
    writeFileSync(join(s.dir, "exports", "问题清单.xlsx"), "x", "utf8");
    const res = await makeApp().request(
      "/api/sessions/e1/exports/%E9%97%AE%E9%A2%98%E6%B8%85%E5%8D%95.xlsx",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"download.xlsx\"; filename*=UTF-8''%E9%97%AE%E9%A2%98%E6%B8%85%E5%8D%95.xlsx",
    );
  });

  it("导出件不在产物目录里 —— 同名文件放会话根目录取不到", async () => {
    const s = makeSession("e2");
    writeFileSync(join(s.dir, "问题清单.xlsx"), "x", "utf8");
    const res = await makeApp().request(
      "/api/sessions/e2/exports/%E9%97%AE%E9%A2%98%E6%B8%85%E5%8D%95.xlsx",
    );
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
//  按 seq 导出界面上的表
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/:sid/export", () => {
  it("从内存事件缓存里按 seq 取表", async () => {
    const s = makeSession("x1");
    s.events.push({ seq: 7, kind: "ui.table", title: "对象清单", columns: ["a"], rows: [["1"]] });
    const res = await makeApp().request("/api/sessions/x1/export?seq=7&format=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(GOLDEN.spec["xlsx"]!.media_type);
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"download.xlsx\"; filename*=UTF-8''%E5%AF%B9%E8%B1%A1%E6%B8%85%E5%8D%95.xlsx",
    );
    const doc = JSON.parse(await res.text()) as { title: string; note: string };
    expect(doc.title).toBe("对象清单");
    expect(doc.note).toBe("共 1 条，由 OntoCopilot 导出");
  });

  it("内存缓存里没有就回耐久事件读 —— 冷 worker 也能服务", async () => {
    await repo.createSession(makeSessionRow({ id: "x2" }));
    makeSession("x2");
    await repo.appendEvent("x2", "ui.table", { title: "冷表", columns: ["a"], rows: [["1"]] });
    const rows = await repo.readEvents("x2");
    const seq = rows[0]!.seq;
    const res = await makeApp().request(`/api/sessions/x2/export?seq=${seq}`);
    expect(res.status).toBe(200);
    expect((JSON.parse(await res.text()) as { title: string }).title).toBe("冷表");
  });

  it("没有这张表 → 404；格式不认 → 400", async () => {
    await repo.createSession(makeSessionRow({ id: "x3" }));
    makeSession("x3");
    expect((await makeApp().request("/api/sessions/x3/export?seq=99")).status).toBe(404);
    const s = SESSIONS.get("x3")!;
    s.events.push({ seq: 1, kind: "ui.table", title: "t", columns: [], rows: [] });
    const bad = await makeApp().request("/api/sessions/x3/export?seq=1&format=parquet");
    expect(bad.status).toBe(400);
  });

  it("别名照 golden 解析：excel/表格/word 都落到对的 spec", async () => {
    const s = makeSession("x4");
    s.events.push({ seq: 2, kind: "ui.table", title: "T", columns: [], rows: [] });
    for (const [q, key] of [
      ["excel", "xlsx"],
      ["%E8%A1%A8%E6%A0%BC", "xlsx"],
      ["word", "docx"],
      ["markdown", "md"],
    ] as const) {
      const res = await makeApp().request(`/api/sessions/x4/export?seq=2&format=${q}`);
      expect(res.headers.get("Content-Type")).toBe(GOLDEN.spec[key]!.media_type);
    }
  });

  it("seq 缺席 / 不是整数 → 422（FastAPI 侧由 pydantic 拦）", async () => {
    makeSession("x5");
    expect((await makeApp().request("/api/sessions/x5/export")).status).toBe(422);
    expect((await makeApp().request("/api/sessions/x5/export?seq=abc")).status).toBe(422);
  });
});

// ══════════════════════════════════════════════════════════════════
//  交付包
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/:sid/bundle", () => {
  function withArtifacts(id: string): SessionT {
    const s = makeSession(id, { title: "退货", project: "某客户" });
    writeFileSync(join(s.dir, "oir.json"), '{"objects":[]}', "utf8");
    writeFileSync(join(s.dir, "流程图.svg"), "<svg/>", "utf8");
    mkdirSync(join(s.dir, "materials"), { recursive: true });
    writeFileSync(join(s.dir, "materials", "订单.xlsx"), "material", "utf8");
    s.state["oir"] = { stats: { objects: 1 }, questions: [{ rid: "q1", text: "口径？" }] };
    return s;
  }

  it("打出来的 zip：中文包名 + manifest + 交付说明", async () => {
    await repo.createSession(makeSessionRow({ id: "b1" }));
    withArtifacts("b1");
    const res = await makeApp().request("/api/sessions/b1/bundle");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd.startsWith('attachment; filename="download.zip"; filename*=UTF-8\'\'')).toBe(true);
    expect(decodeURIComponent(cd.split("UTF-8''")[1]!)).toBe("交付包_某客户_b1.zip");
    const zip = Buffer.from(await res.arrayBuffer());
    const text = zip.toString("latin1");
    for (const name of ["oir.json", "manifest.json", "materials/"]) {
      expect(text).toContain(name);
    }
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const manifest = JSON.parse(unzipMember(zip, "manifest.json")) as Record<string, unknown>;
    expect(manifest["product_version"]).toBe("0.1.0");
    // `datetime.fromtimestamp(ts, UTC).isoformat()`：带 `+00:00`，不是 JS 的 `Z`；
    // 整秒时不印小数部分。
    expect(manifest["generated_at_iso"]).toBe("2023-11-14T22:13:20+00:00");
    const files = manifest["files"] as { path: string; kind: string }[];
    // `sorted(dir.iterdir())`：ASCII 在中文前面
    expect(files.map((f) => f.path)).toEqual(["oir.json", "流程图.svg"]);
    expect(files.map((f) => f.kind)).toEqual(["oir_json", "flow_svg_full"]);
    expect((manifest["materials"] as { name: string }[]).map((m) => m.name)).toEqual([
      "订单.xlsx",
    ]);
  });

  it("materials=false 时材料不进包", async () => {
    await repo.createSession(makeSessionRow({ id: "b2" }));
    withArtifacts("b2");
    const res = await makeApp().request("/api/sessions/b2/bundle?materials=false");
    const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
    expect(text).not.toContain("materials/");
  });

  it("空会话不给空壳包 → 409", async () => {
    await repo.createSession(makeSessionRow({ id: "b3" }));
    makeSession("b3");
    const res = await makeApp().request("/api/sessions/b3/bundle");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("还没有产出可交付的产物");
  });

  it("阻塞问题拦住正式包 —— Question Ledger 是权威门禁", async () => {
    await repo.createSession(makeSessionRow({ id: "b4" }));
    const s = withArtifacts("b4");
    s.state["release_state"] = "RELEASED";
    await repo.upsertQuestions("b4", [
      makeQuestionRow({
        id: "Q-1",
        text: "退货口径由谁定？",
        status: "open",
        priority: "blocking",
        doc: {
          id: "Q-1",
          text: "退货口径由谁定？",
          status: "open",
          priority: "blocking",
          blockedArtifacts: ["模板_v1.xlsx"],
        },
      }),
    ]);
    const res = await makeApp().request("/api/sessions/b4/bundle");
    expect(res.status).toBe(409);
    const msg = await res.text();
    expect(msg).toContain("正式 Bundle 已被阻塞问题拦截：Q-1");
  });

  it("有未答项时 release_state 一定是 DRAFT", async () => {
    await repo.createSession(makeSessionRow({ id: "b5" }));
    const s = withArtifacts("b5");
    s.state["release_state"] = "RELEASED";
    s.state["question_backlog"] = {
      questions: [{ id: "Q-9", text: "还没答", status: "open", priority: "high" }],
    };
    const res = await makeApp().request("/api/sessions/b5/bundle");
    expect(res.status).toBe(200);
    const manifest = JSON.parse(
      unzipMember(Buffer.from(await res.arrayBuffer()), "manifest.json"),
    ) as { release_state: string; session: Record<string, unknown>; open_questions: unknown[] };
    expect(manifest.release_state).toBe("DRAFT");
    expect(manifest.session["release_state"]).toBe("DRAFT");
    expect(manifest.open_questions).toEqual([{ rid: "q1", q: "口径？" }]);
  });

  it("materials 不是布尔词 → 422", async () => {
    makeSession("b6");
    expect((await makeApp().request("/api/sessions/b6/bundle?materials=maybe")).status).toBe(422);
  });
});

// ══════════════════════════════════════════════════════════════════
//  溯源
// ══════════════════════════════════════════════════════════════════
describe("GET /api/sessions/:sid/source", () => {
  it("从构建时的缓存读，能从一格追回到证据切片", async () => {
    const s = makeSession("src1");
    s.state["_chunks"] = {
      "订单.xlsx": [
        { cite: "订单.xlsx!Sheet1!R2-9", text: "order_id 订单号", tags: ["table"], locator: {} },
        { cite: "订单.xlsx!Sheet1!R10-20", text: "退货流程", tags: [], locator: {} },
      ],
    };
    s.state["corpus"] = {
      findings: [
        { file: "订单.xlsx", kind: "metadata_leak", message: "带作者名" },
        { file: "别的.xlsx", kind: "x", message: "不该出现" },
      ],
    };
    const res = await makeApp().request("/api/sessions/src1/source?file=%E8%AE%A2%E5%8D%95.xlsx");
    const body = (await res.json()) as {
      file: string;
      kind: string;
      chunks: { cite: string }[];
      findings: { message: string }[];
    };
    expect(body.kind).toBe("cached");
    expect(body.chunks.map((c) => c.cite)).toEqual([
      "订单.xlsx!Sheet1!R2-9",
      "订单.xlsx!Sheet1!R10-20",
    ]);
    expect(body.findings.map((f) => f.message)).toEqual(["带作者名"]);
  });

  it("带 q 时按正文或 cite 过滤", async () => {
    const s = makeSession("src2");
    s.state["_chunks"] = {
      "a.xlsx": [
        { cite: "a.xlsx!S!R1-2", text: "退货流程", tags: [], locator: {} },
        { cite: "a.xlsx#/x", text: "订单表", tags: [], locator: {} },
      ],
    };
    const byText = (await (
      await makeApp().request("/api/sessions/src2/source?file=a.xlsx&q=%E9%80%80%E8%B4%A7")
    ).json()) as { chunks: unknown[] };
    expect(byText.chunks).toHaveLength(1);
    const byCite = (await (
      await makeApp().request("/api/sessions/src2/source?file=a.xlsx&q=%23%2Fx")
    ).json()) as { chunks: unknown[] };
    expect(byCite.chunks).toHaveLength(1);
  });

  it("没缓存过就走统一 preparse，同时建立缓存、索引与 corpus", async () => {
    const s = makeSession("src3");
    mkdirSync(join(s.dir, "materials"), { recursive: true });
    const path = join(s.dir, "materials", "订单.xlsx");
    writeFileSync(path, "x", "utf8");
    s.files = [{ name: "订单.xlsx", path, size: 1, sha256: "" }];
    const res = await makeApp().request("/api/sessions/src3/source?file=%E8%AE%A2%E5%8D%95.xlsx");
    const body = (await res.json()) as { chunks: { cite: string; text: string }[] };
    expect(body.chunks).toHaveLength(2);
    expect(body.chunks[0]!.cite).toBe("订单.xlsx!Sheet1!R2-9");
    expect([...body.chunks[0]!.text].length).toBe(1500);
    expect(Object.keys(s.state["_chunks"] as object)).toEqual(["订单.xlsx"]);
    expect(s.state["_index"]).toEqual({ built: true });
    expect((s.state["corpus"] as { files: unknown[] }).files).toHaveLength(1);
  });

  it("扫描件不偷偷跑 OCR，并返回统一 preparse 留下的 vision_pending", async () => {
    const s = makeSession("src4");
    mkdirSync(join(s.dir, "materials"), { recursive: true });
    const path = join(s.dir, "materials", "合同.pdf");
    writeFileSync(path, "%PDF", "utf8");
    s.files = [{ name: "合同.pdf", path, size: 4, sha256: "" }];
    const body = (await (
      await makeApp().request("/api/sessions/src4/source?file=%E5%90%88%E5%90%8C.pdf")
    ).json()) as { kind: string; chunks: unknown[]; findings: { kind: string }[] };
    expect(body.kind).toBe("cached");
    expect(body.chunks).toEqual([]);
    expect(body.findings[0]!.kind).toBe("vision_pending");
  });

  it("统一 preparse 的 unsupported finding 不会被 source 吞掉", async () => {
    const s = makeSession("src-unsupported");
    mkdirSync(join(s.dir, "materials"), { recursive: true });
    const path = join(s.dir, "materials", "旧表.xls");
    writeFileSync(path, "binary", "utf8");
    s.files = [{ name: "旧表.xls", path, size: 6, sha256: "" }];
    const app = makeApp({
      preparse: async (session) => {
        session.state["_chunks"] = { "旧表.xls": [] };
        session.state["_index"] = { built: true };
        session.state["corpus"] = {
          files: [{ file: "旧表.xls", kind: "unsupported", chunks: 0, findings: 1 }],
          chunks: 0,
          findings: [{
            file: "旧表.xls", kind: "unsupported", severity: "warn",
            message: "旧版二进制格式不支持", locator: {},
          }],
        };
      },
    });
    const body = (await (
      await app.request("/api/sessions/src-unsupported/source?file=%E6%97%A7%E8%A1%A8.xls")
    ).json()) as { chunks: unknown[]; findings: Array<{ kind: string; message: string }> };
    expect(body.chunks).toEqual([]);
    expect(body.findings).toEqual([
      expect.objectContaining({ kind: "unsupported", message: "旧版二进制格式不支持" }),
    ]);
  });

  it("材料不存在 → 404", async () => {
    makeSession("src5");
    expect((await makeApp().request("/api/sessions/src5/source?file=no.xlsx")).status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
//  回传审核
// ══════════════════════════════════════════════════════════════════
describe("POST /api/sessions/:sid/audit", () => {
  const upload = (name: string, bytes: Uint8Array): Upload => ({
    filename: name,
    read: async () => bytes,
  });

  const XLSX = readFileSync(
    fileURLToPath(new URL("../../golden/onto.audit.plain.xlsx", import.meta.url)),
  );
  const TINY_SPEC = (
    JSON.parse(
      readFileSync(fileURLToPath(new URL("../../golden/onto.audit.json", import.meta.url)), "utf8"),
    ) as { tiny_spec: Record<string, unknown> }
  ).tiny_spec;

  function prepared(id: string): SessionT {
    const s = makeSession(id);
    writeFileSync(
      join(s.dir, "template.spec.json"),
      JSON.stringify(TemplateSpec.fromDict(TINY_SPEC).toDict()),
      "utf8",
    );
    s.state["_oir"] = new OIR();
    return s;
  }

  it("还没编译出模板 → 409", async () => {
    const s = makeSession("au1");
    await expect(
      auditOnce(s, [upload("回传.xlsx", XLSX)], { apply: false, deps: makeDeps() }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("没上传文件 → 400", async () => {
    const s = prepared("au2");
    await expect(auditOnce(s, [], { apply: false, deps: makeDeps() })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("正在跑 DAG 时不许回传 → 409", async () => {
    const s = prepared("au3");
    s.status = "extracting";
    await expect(
      auditOnce(s, [upload("回传.xlsx", XLSX)], { apply: false, deps: makeDeps() }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("超过上限 → 413，文案里是 MB", async () => {
    const s = prepared("au4");
    await expect(
      auditOnce(s, [upload("大.xlsx", new Uint8Array(3 * 1024 * 1024))], {
        apply: false,
        deps: makeDeps(),
        env: () => "1",
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("OIR 未恢复 → 409（不能拿空骨架去合并）", async () => {
    const s = prepared("au5");
    s.state["_oir"] = null;
    await expect(
      auditOnce(s, [upload("回传.xlsx", XLSX)], { apply: false, deps: makeDeps() }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("预审：只读、落 returns/、发 audit.previewed，绝不动活 OIR", async () => {
    const s = prepared("au6");
    const snapshot = JSON.stringify((s.state["_oir"] as OIR).toDict());
    const out = await auditOnce(s, [upload("回传件.xlsx", XLSX)], {
      apply: false,
      deps: makeDeps(),
    });
    expect(out["apply"]).toBe(false);
    expect(out["applied"]).toBe(false);
    expect(out["file"]).toBe("回传件.xlsx");
    expect(typeof out["sha256"]).toBe("string");
    expect(Array.isArray(out["diffs"])).toBe(true);
    // summary 的键原样透出去，前端按它渲染
    for (const k of ["completeness", "cells_compared", "cells_changed", "damage", "readable"]) {
      expect(Object.hasOwn(out, k)).toBe(true);
    }
    expect(JSON.stringify((s.state["_oir"] as OIR).toDict())).toBe(snapshot);
    expect(existsSync(join(s.dir, "returns"))).toBe(true);
    expect(s.events.some((e) => e["kind"] === "audit.previewed")).toBe(true);
    expect(recompiled).toBe(0);
    // 预审不许在产物目录里留一个看似已纳入交付的文件
    expect(existsSync(join(s.dir, "回传件.xlsx"))).toBe(false);
  });

  it("预审的 diff 每一条都带 role/owner/changed/filled —— 前端要靠它分工", async () => {
    const s = prepared("au7");
    const out = await auditOnce(s, [upload("r.xlsx", XLSX)], { apply: false, deps: makeDeps() });
    for (const d of out["diffs"] as Record<string, unknown>[]) {
      expect(Object.keys(d)).toEqual([
        "rid",
        "sheet",
        "field",
        "before",
        "after",
        "owner",
        "role",
        "changed",
        "filled",
      ]);
      expect(d["changed"]).toBe(true);
    }
  });

  it("apply=true 走一次变更租约（回调形，成对进出）", async () => {
    await repo.createSession(makeSessionRow({ id: "au8" }));
    prepared("au8");
    const seen: string[] = [];
    const app = makeApp({
      sessionMutation: async (_s, kind, body) => {
        seen.push(kind);
        return body();
      },
    });
    const form = new FormData();
    form.append("files", new File([XLSX], "回传.xlsx"));
    const res = await app.request("/api/sessions/au8/audit?apply=true", {
      method: "POST",
      body: form,
    });
    expect(seen).toEqual(["audit.apply"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["applied"]).toBe(true);
    expect(body["phase"]).toBe("applied");
    expect(body["revision"]).toBe(1);
    expect(recompiled).toBe(1);
    // 落库两次：recompile 之后一次（phase=committing 的检查点），finalize 之后一次。
    expect(persisted).toBe(2);
    // Revision 先 proposed 后 applied，幂等键钉着这份回传的哈希
    const revs = await repo.listRevisions("au8");
    expect(revs).toHaveLength(1);
    expect(revs[0]!.status).toBe("applied");
    expect(revs[0]!.idempotency_key).toBe(`returned:${body["sha256"] as string}`);
  });

  it("同一份回传再传一次不重复发版本", async () => {
    await repo.createSession(makeSessionRow({ id: "au9" }));
    const s = prepared("au9");
    const first = await auditOnce(s, [upload("r.xlsx", XLSX)], { apply: true, deps: makeDeps() });
    const second = await auditOnce(s, [upload("r.xlsx", XLSX)], { apply: true, deps: makeDeps() });
    expect(second["created"]).toBe(false);
    expect(second["revision"]).toBe(first["revision"]);
    expect(second["note"]).toBe("这份回传件已应用过，未重复生成版本。");
    expect(await repo.listRevisions("au9")).toHaveLength(1);
  });

  it("结构损伤 fail closed：422 + 结构化 detail，一格都不写", async () => {
    await repo.createSession(makeSessionRow({ id: "au10" }));
    const s = prepared("au10");
    const damaged = readFileSync(
      fileURLToPath(new URL("../../golden/onto.audit.no_anchor.xlsx", import.meta.url)),
    );
    let caught: unknown;
    try {
      await auditOnce(s, [upload("坏.xlsx", damaged)], { apply: true, deps: makeDeps() });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const res = (caught as { getResponse: () => Response }).getResponse();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { detail: Record<string, unknown> };
    expect(body.detail["code"]).toBe("RETURN_TEMPLATE_DAMAGED");
    expect(Array.isArray(body.detail["damage"])).toBe(true);
    expect(await repo.listRevisions("au10")).toHaveLength(0);
    expect(recompiled).toBe(0);
  });

  it("多份上传按表单同名多值收 —— 不能只留最后一个", async () => {
    prepared("au11");
    const app = makeApp();
    const form = new FormData();
    form.append("files", new File([XLSX], "一.xlsx"));
    form.append("files", new File([XLSX], "二.xlsx"));
    const res = await app.request("/api/sessions/au11/audit", { method: "POST", body: form });
    const body = (await res.json()) as Record<string, unknown>;
    // Python 侧取 files[0]；关键是**没有**被折成"最后一个"
    expect(body["file"]).toBe("一.xlsx");
  });
});
