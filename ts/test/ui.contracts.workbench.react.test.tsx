// @vitest-environment happy-dom
/**
 * FDE 问题工作台的行为契约 —— **组件版**。
 *
 * `ui.contracts.workbench.test.ts` 那 33 条断的是 `questionWorkbench()` 吐出来的
 * HTML 字符串（`expect(html).toContain('onclick="qReopen(0)"')` 这种）。换成 React
 * 之后那种判据既测不了也不该测：没有内联处理器可数，DOM 由框架生成。
 * 所以这里逐条改成**渲染组件 → 找到那个按钮 → 点它 → 看发出去的请求**。
 *
 * **判据变了，钉的东西一条没少**，而且比原来强一档：原来断的是「HTML 里有这段
 * 文本」，现在断的是「用户点得到它，点下去发生了对的事」。
 *
 * 三类东西必须留住（与原件同一份清单）：
 *   · Ledger 写接口与遗留 OIR/conflict 兼容路径**同时**存在（后端可以渐进升级）；
 *   · Bundle 的发布门禁 —— BLOCKED 时所有入口都点不动，但问题清单与单份草稿照下；
 *   · 回传件是「预审 → 人确认 → 应用」三步，任何一步没过都不许写 Ontology。
 *
 * 外加一条 React 特有的：**blocked / deferred 的问题必须先「恢复待答」**——
 * 卡片上没有「提交回答」，回答框与参考选项是锁着的。
 *
 * ## 为什么这里立的是 index.html 那份真 body，而不是 mock 掉 paint / render
 *
 * 动作函数末尾仍留着一句 `paint()`（旧渲染器，归 preview track 管，这次不动它）。
 * 拿 vi.mock 去掉它是行不通的：preview ↔ questions ↔ returnaudit 三个模块是**互相
 * import 的一个环**，环里做模块替换，谁先被求值谁就拿到真的那一份 —— 表现是
 * questions 里的 paint 是 spy、returnaudit 里的却是真货，然后在一个「fetch 从没发出去」
 * 的假象里查半天。
 *
 * 立真 DOM 反而更简单也更硬：`ui/index.html` 的 <body> 原样搬进来，旧渲染器写它的
 * innerHTML，组件画它自己的那份，两边都跑得通 —— 迁移期本来就是这个样子。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

import { G, Q_BUSY } from "../src/ui/state.js";
import { loadQuestions, normalizeQuestion } from "../src/ui/questions.js";
import {
  ArtifactsTab, BundleLink, EngagementProgress, QuestionWorkbench,
} from "../src/ui/react/workbench.js";
import { ReturnAuditCard } from "../src/ui/react/returncard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_SRC = resolve(ROOT, "ts", "src", "ui");
const INDEX_HTML = readFileSync(resolve(ROOT, "ui", "index.html"), "utf8");
/** index.html 里 <body> 到那段内联脚本之间的全部结构（#pbody #stream #abar …）。
 *  **脚本要从 <body> 之后找起** —— <head> 里还有一个（那是 theme 的防闪烁那段），
 *  从头找会切出一段空字符串，然后所有 $("pbody") 都是 null。 */
const SHELL = (() => {
  const from = INDEX_HTML.indexOf("<body>") + "<body>".length;
  return INDEX_HTML.slice(from, INDEX_HTML.indexOf("<script>", from));
})();

// ── 测试替身 ────────────────────────────────────────────────────
type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let alerts: string[] = [];
const g = globalThis as any;

const BASE_ROUTES: Array<[RegExp, any]> = [
  [/\/api\/sessions$/, []], [/\/api\/projects$/, { projects: [] }],
];

/** 按 URL 片段路由的假 fetch，并记下每一次请求。 */
function installFetch(routes: Array<[RegExp, any]>): void {
  g.fetch = async (url: string, opts: any = {}) => {
    const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method: opts.method || "GET", body });
    // refresh() 会连带拉一次会话列表 —— 不给它形状对的空壳，某条断言之外的
    // 代码路径会在 all.filter 上抛一个跟本用例无关的 unhandled rejection。
    for (const [re, payload] of [...routes, ...BASE_ROUTES] as Array<[RegExp, any]>) {
      if (re.test(String(url))) {
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
}

const q = (raw: Record<string, unknown>) => normalizeQuestion({ id: "q1", text: "口径是什么", ...raw }, "ledger");

/** 工作台。返回的容器就是那一整块右栏内容。 */
const board = () => render(<QuestionWorkbench />).container;
/** 按钮按**可见文字**找 —— 用户看到的就是这个。 */
const btn = (root: Element, label: string): any =>
  Array.from(root.querySelectorAll("button") as any[]).find((b: any) => b.textContent === label);
const btns = (root: Element): string[] =>
  Array.from(root.querySelectorAll("button") as any[]).map((b: any) => String(b.textContent));
/** 点一下并等异步动作跑完。 */
const click = async (el: any): Promise<void> => { await act(async () => { fireEvent.click(el); }); };
const fill = (el: any, value: string): void => { fireEvent.change(el, { target: { value } }); };

beforeEach(() => {
  document.body.innerHTML = SHELL;
  calls = []; alerts = [];
  Q_BUSY.clear();
  g.CSS = g.CSS || { escape: (s: string) => s };
  // refresh() 走到底会 connect() 一条 SSE —— happy-dom 没有 EventSource，
  // 不给个空壳就是一条与本用例无关的 unhandled rejection。
  g.EventSource = class { close(): void {} };
  g.alert = (m: string) => { alerts.push(String(m)); };
  g.confirm = () => false;
  g.prompt = () => null;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 1,
          state: { dialogue: { turns: [] }, artifacts: [] }, events: [], filelist: [] };
  G.TAB = "q";
  G.Q_BACKLOG = []; G.Q_NEXT = []; G.Q_API = true; G.Q_FILTER = "all"; G.Q_LIMIT = 40;
  G.RETURN_AUDIT = null; G.RETURN_FILE = null; G.RETURN_BUSY = false;
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = [];
  installFetch([]);
});
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════
//  工作台本身
// ══════════════════════════════════════════════════════════════════
describe("问题 tab 是一个真的工作台", () => {
  it("四种可编辑能力都在，而且是能打字的真控件", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    const c = board();
    expect(c.textContent).toContain("FDE 问题工作台");
    for (const cap of ["[data-q-owner]", "[data-q-role]", "[data-q-priority]", "[data-q-answer]"]) {
      expect(c.querySelector(cap), cap).not.toBeNull();
      expect(c.querySelector(cap).disabled).toBe(false);
    }
  });

  it("没有问题时也是工作台，不是一片空白", () => {
    const c = board();
    expect(c.querySelector(".qempty").textContent).toBe("这个筛选下没有问题");
    expect(c.textContent).toContain("FDE 问题工作台");
  });

  it("卡片结构与类名和原来逐字一致 —— 767 行 CSS 认的就是这些", () => {
    G.Q_BACKLOG = [q({ status: "open", code: "Q-1", why: "口径不一致", impact: "3 个实体",
                       applies_to: ["订单"], options: [{ id: "o1", label: "甲" }] })];
    const c = board();
    const card = c.querySelector(".qcard");
    expect(card.getAttribute("data-qidx")).toBe("0");
    for (const sel of [".qmeta", ".qbadge", ".qtext", ".qwhy", ".qimpact", ".cap",
                       ".qfields", ".qinput", ".qselect", ".qanswer", ".qactions"]) {
      expect(card.querySelector(sel), sel).not.toBeNull();
    }
    expect(c.querySelector(".qwbhead")).not.toBeNull();
    expect(c.querySelector(".qdeliver")).not.toBeNull();
    expect(c.querySelector(".qfilters")).not.toBeNull();
  });

  it("状态与优先级各占一个 badge，文案是收口后那套", () => {
    G.Q_BACKLOG = [q({ status: "blocked", priority: "blocking" })];
    const labels = Array.from(board().querySelectorAll(".qbadge") as any[]).map((x: any) => x.textContent);
    expect(labels).toContain("受阻");
    expect(labels).toContain("高优先级");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Ledger 写接口与遗留兼容路径同时在
// ══════════════════════════════════════════════════════════════════
describe("Ledger 写接口与遗留兼容路径同时在", () => {
  it("提交回答 → POST /questions/{id}/answer，带幂等键与期望版本", async () => {
    G.Q_BACKLOG = [normalizeQuestion({ id: "q 1", text: "t", revision: 7 }, "ledger")];
    const c = board();
    fill(c.querySelector("[data-q-answer]"), "  按下单时间口径  ");
    await click(btn(c, "提交回答"));
    const answer = calls.find(x => x.url.includes("/answer"))!;
    expect(answer.url).toBe("/api/sessions/s1/questions/q%201/answer");
    expect(answer.method).toBe("POST");
    expect(answer.body.answerText).toBe("按下单时间口径");
    expect(answer.body.actor).toBe("fde");
    expect(String(answer.body.idempotencyKey).length).toBeGreaterThan(0);
    expect(answer.body.expected_revision).toBe(7);
    // 成功之后必须重新拉一次清单，否则界面还停在旧状态
    expect(calls.some(x => x.url === "/api/sessions/s1/questions" && x.method === "GET")).toBe(true);
  });

  it("答案与参考选项都空着 → 不发请求，直接说清楚要先填", async () => {
    G.Q_BACKLOG = [q({ status: "open", options: [{ id: "o1", label: "甲" }] })];
    const c = board();
    await click(btn(c, "提交回答"));
    expect(calls).toEqual([]);
    expect(alerts.join()).toContain("请先选择选项或填写答案");
  });

  it("延期 → PATCH status:deferred；重新打开 → POST /reopen", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    g.prompt = () => "等业务确认";
    await click(btn(board(), "延期"));
    const defer = calls.find(x => x.method === "PATCH")!;
    expect(defer.body).toMatchObject({ status: "deferred", reason: "等业务确认" });

    cleanup();
    calls = [];
    G.Q_BACKLOG = [q({ status: "deferred" })];   // 上一步的 loadQuestions 已经把清单换掉了
    await click(btn(board(), "恢复待答"));
    const reopen = calls.find(x => x.url.endsWith("/reopen"))!;
    expect(reopen.method).toBe("POST");
    expect(reopen.body.reason).toBeTruthy();
  });

  it("延期对话框点取消（prompt 返回 null）就什么都不发", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    g.prompt = () => null;
    await click(btn(board(), "延期"));
    expect(calls).toEqual([]);
  });

  it("保存分派 → PATCH ownerUserId / audienceRole / priority", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    const c = board();
    fill(c.querySelector("[data-q-owner]"), " 张三 ");
    fill(c.querySelector("[data-q-role]"), "业务负责人");
    fill(c.querySelector("[data-q-priority]"), "high");
    await click(btn(c, "保存分派"));
    const meta = calls.find(x => x.method === "PATCH")!;
    expect(meta.body).toEqual({ ownerUserId: "张三", audienceRole: "业务负责人", priority: "high" });
  });

  it("**值来自组件自己的状态，不再回读 DOM** —— 卡片重画不会把它丢掉", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    installFetch([[/\/questions$/, { questions: [{ id: "q1", text: "口径是什么" }] }]]);
    const c = board();
    fill(c.querySelector("[data-q-answer]"), "业务原话");
    expect(c.querySelector("[data-q-answer]").value).toBe("业务原话");
    await click(btn(c, "保存分派"));      // 走一趟请求，中间重画了两次
    expect(c.querySelector("[data-q-answer]").value).toBe("业务原话");
  });

  it("后端没有 Ledger 时：冲突卡仍走稳定的 /api/sessions/{id}/answer", async () => {
    G.Q_API = false;
    G.Q_BACKLOG = [normalizeQuestion(
      { id: "c1", text: "两个口径打架", conflict_rid: "c1", options: [{ id: "o1", label: "按下单" }] }, "conflict")];
    const c = board();
    fill(c.querySelector("[data-q-option]"), "o1");
    await click(btn(c, "提交回答"));
    const legacy = calls.find(x => x.url === "/api/sessions/s1/answer")!;
    expect(legacy.method).toBe("POST");
    expect(legacy.body).toMatchObject({ conflict_rid: "c1", option_id: "o1" });
  });

  it("后端没有 Ledger 时：Ledger 专属写操作说清楚而不是静默失败", async () => {
    G.Q_API = false;
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    await click(btn(board(), "重新打开"));
    expect(calls).toEqual([]);
    expect(alerts.join()).toContain("Question Ledger");
  });

  it("遗留会话把 oir.questions 与冲突卡合成同一个 backlog，并画得出来", async () => {
    G.S.state.oir = { questions: [{ id: "o1", text: "问卷问题" }] };
    G.S.state.questions = [{ conflict_rid: "c1", title: "冲突问题" }];
    g.fetch = async () => { throw new Error("no ledger"); };   // 后端没这个接口
    await act(async () => { await loadQuestions(); });
    expect(G.Q_API).toBe(false);
    expect(G.Q_BACKLOG.map((x: any) => x.text)).toEqual(["问卷问题", "冲突问题"]);
    const texts = Array.from(board().querySelectorAll(".qcard .qtext") as any[]).map((x: any) => x.textContent);
    expect(texts).toEqual(["问卷问题", "冲突问题"]);
  });

  it("刷新按钮重新拉一次清单", async () => {
    installFetch([[/\/questions$/, { questions: [{ id: "a", text: "新拉到的" }] }]]);
    await click(btn(board(), "刷新"));
    expect(calls.some(x => x.url === "/api/sessions/s1/questions")).toBe(true);
    expect(G.Q_BACKLOG.map((x: any) => x.text)).toEqual(["新拉到的"]);
  });
});

// ══════════════════════════════════════════════════════════════════
//  交付物
// ══════════════════════════════════════════════════════════════════
describe("交付物：三种导出格式 + Bundle", () => {
  const hrefs = (root: Element): string[] =>
    Array.from(root.querySelectorAll("a") as any[]).map((a: any) => a.getAttribute("href"));

  it("Ledger 在时给 XLSX / MD / JSON 三个下载口，外加 Bundle", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    const c = board();
    for (const f of ["xlsx", "md", "json"]) {
      expect(hrefs(c)).toContain(`/api/sessions/s1/questions/export?format=${f}`);
      const link = Array.from(c.querySelectorAll("a") as any[])
        .find((a: any) => a.getAttribute("href").endsWith(`format=${f}`));
      expect(link.textContent).toBe(f.toUpperCase());
      expect(link.hasAttribute("download")).toBe(true);
    }
    expect(hrefs(c)).toContain("/api/sessions/s1/bundle");
  });

  it("兼容模式下不假装能导出 —— 但清单本身还在", () => {
    G.Q_API = false;
    G.Q_BACKLOG = [q({ status: "open" })];
    const c = board();
    expect(hrefs(c).some(h => h.includes("questions/export?format="))).toBe(false);
    expect(c.querySelector(".qnotice").textContent).toContain("兼容模式");
    expect(c.textContent).toContain("口径是什么");
  });

  it("关联产物只挑问题/本体/流程图那几类，最多五条", () => {
    G.S.state.artifacts = ["问题清单.xlsx", "ontology.json", "流程图.svg", "oir.json",
                           "flow.json", "无关的日志.txt", "另一个问题.md"];
    const c = board();
    const arts = Array.from(c.querySelectorAll("a") as any[])
      .filter((a: any) => a.getAttribute("href").includes("/artifacts/"));
    expect(arts).toHaveLength(5);
    expect(hrefs(c).some(h => h.includes("%E6%97%A5%E5%BF%97"))).toBe(false);   // 日志没进来
    expect(c.querySelector(".qdeliver .qwbsum").textContent).toContain("6 份关联产物");
  });
});

describe("服务端排好的下一批", () => {
  it("nextBatch 里的裸 id 解析回 backlog 里那条，对象则就地收口", async () => {
    installFetch([[/\/questions$/, {
      questions: [{ id: "a", text: "先问这条" }],
      nextBatch: ["a", { id: "b", text: "再问这条", audience_role: "财务" }, "不存在的 id"],
    }]]);
    await act(async () => { await loadQuestions(); });
    expect(G.Q_NEXT.map((x: any) => x.text)).toEqual(["先问这条", "再问这条"]);
    const next = board().querySelector(".qnext");
    expect(next.textContent).toContain("建议下一批先问");
    expect(next.textContent).toContain("再问这条");
    expect(next.textContent).toContain("财务");
  });

  it("没有 nextBatch 就不画这一块", async () => {
    installFetch([[/\/questions$/, { questions: [{ id: "a", text: "x" }] }]]);
    await act(async () => { await loadQuestions(); });
    expect(board().querySelector(".qnext")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  优先级 / 筛选
// ══════════════════════════════════════════════════════════════════
describe("优先级用的是领域契约那四档", () => {
  it("下拉里就是 低/普通/高/阻塞交付，没有 medium 这一档", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    const sel = board().querySelector("[data-q-priority]");
    const opts = Array.from(sel.querySelectorAll("option") as any[])
      .map((o: any) => [o.getAttribute("value"), o.textContent]);
    expect(opts).toEqual([["low", "低优先级"], ["normal", "普通优先级"],
                          ["high", "高优先级"], ["blocking", "阻塞交付"]]);
    expect(sel.textContent).not.toContain("medium");
  });

  it("影响面推优先级的阈值是 10，不是 3", () => {
    expect(normalizeQuestion({ id: "q", text: "t", blastRadius: 3 }, "l").priority).toBe("normal");
    expect(normalizeQuestion({ id: "q", text: "t", blastRadius: 10 }, "l").priority).toBe("high");
  });

  it("筛选按钮带计数，点一下换筛选", async () => {
    G.Q_BACKLOG = [q({ id: "a", status: "open" }), q({ id: "b", status: "answered", answer: "好" })];
    const c = board();
    expect(btns(c)).toContain("待回答 1");
    expect(btns(c)).toContain("已回答 1");
    expect(btns(c)).toContain("全部 2");
    await click(btn(c, "已回答 1"));
    expect(G.Q_FILTER).toBe("answered");
    expect(c.querySelectorAll(".qcard")).toHaveLength(1);
    expect(c.querySelector(".qfilter.on").textContent).toBe("已回答 1");
  });

  it("超过 Q_LIMIT 的部分收起来，点一下再放 40 条", async () => {
    G.Q_LIMIT = 1;
    G.Q_BACKLOG = [q({ id: "a" }), q({ id: "b" }), q({ id: "c" })];
    const c = board();
    expect(c.querySelectorAll(".qcard")).toHaveLength(1);
    await click(c.querySelector(".qmore"));
    expect(c.querySelectorAll(".qcard")).toHaveLength(3);
  });
});

// ══════════════════════════════════════════════════════════════════
//  发布状态
// ══════════════════════════════════════════════════════════════════
describe("发布状态与「计划是否冻结」是两件事", () => {
  const plan = (frozen: boolean) => {
    G.S.state.engagement = { frozen, version: "v3", plan: [{ id: "INTAKE", state: "done" }] };
  };
  const eng = () => render(<EngagementProgress />).container;

  it("冻结的 DAG 说 FROZEN DAG，没冻结说 EDITABLE PLAN", () => {
    plan(true);
    expect(eng().textContent).toContain("FROZEN DAG");
    cleanup();
    plan(false);
    expect(eng().textContent).toContain("EDITABLE PLAN");
  });

  it("冻结与 DRAFT/BLOCKED/RELEASED 各说各的，不能拿冻结冒充发布状态", () => {
    plan(true);
    G.Q_BACKLOG = [q({ status: "open" })];                       // → DRAFT
    expect(eng().querySelector(".engmeta").textContent).toContain("FROZEN DAG · DRAFT");
    cleanup();

    G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })]; // → BLOCKED
    const meta = eng().querySelector(".engmeta").textContent;
    expect(meta).toContain("FROZEN DAG · BLOCKED");
    expect(meta).toContain("1 BLOCKERS");
  });

  it("没有 engagement 计划就整块不画", () => {
    expect(eng().innerHTML).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════
//  Bundle 门禁
// ══════════════════════════════════════════════════════════════════
describe("Bundle 下载的门禁", () => {
  const blocked = () => { G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })]; };
  const link = (label = "Bundle", cls = "act pri") =>
    render(<BundleLink label={label} className={cls} />).container;

  it("BLOCKED 时不是链接，且说清楚「问题清单和单份草稿仍可下载」", () => {
    blocked();
    const c = link();
    expect(c.querySelector("a")).toBeNull();
    expect(c.innerHTML).not.toContain("/bundle");
    const span = c.querySelector("span");
    expect(span.getAttribute("aria-disabled")).toBe("true");
    expect(span.className).toBe("act pri disabled");
    expect(span.textContent).toBe("Bundle · BLOCKED");
    expect(span.getAttribute("title")).toContain("问题清单和单份草稿仍可下载");
  });

  it("**每一个** Bundle 入口都走同一道闸 —— 组件只有一个，绕不过去", () => {
    blocked();
    G.S.state.artifacts = ["问题填写模板.xlsx"];
    G.RETURN_AUDIT = { applied: true, readable: true, completeness: 1 };
    G.RETURN_FILE = { name: "回传.xlsx" };
    const c = board();                       // 工作台里含交付条 + 回传已应用卡
    const gates = Array.from(c.querySelectorAll("[aria-disabled='true']") as any[]);
    expect(gates.length).toBeGreaterThanOrEqual(2);   // 交付条一处、回传卡一处
    for (const gate of gates) expect(gate.textContent).toContain("BLOCKED");
    expect(Array.from(c.querySelectorAll("a") as any[])
      .map((a: any) => a.getAttribute("href")).some((h: string) => h.endsWith("/bundle"))).toBe(false);
    // 但问题清单和单份产物照旧可下载 —— 门禁只关 Bundle 这一扇门
    const hrefs = Array.from(c.querySelectorAll("a") as any[]).map((a: any) => a.getAttribute("href"));
    expect(hrefs.some((h: string) => h.includes("questions/export?format=xlsx"))).toBe(true);
    expect(hrefs.some((h: string) => h.includes("/artifacts/") && h.includes(".xlsx"))).toBe(true);
  });

  it("唯一那条真实 href 只存在于 bundle.tsx 里（源码级）", () => {
    // `import … from "./bundle.js"` 里也有 "/bundle" —— 只认后面不再跟标识符字符的那种。
    const withHref = tsxSources().filter(([, src]) => /\/bundle(?![\w.])/.test(codeLines(src)));
    expect(withHref.map(([f]) => f)).toEqual(["react/bundle.tsx"]);
  });

  it("一个已发布会话重新打开普通问题，当前包立刻降为 DRAFT", () => {
    G.S.state.release_state = "RELEASED";
    G.Q_BACKLOG = [q({ status: "open" })];
    const a = link("Bundle", "act").querySelector("a");
    expect(a.textContent).toBe("Bundle · DRAFT");
    expect(a.getAttribute("href")).toBe("/api/sessions/s1/bundle");
  });

  it("门禁清空之后才是干净的下载链接（没有 DRAFT 后缀）", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    const a = link().querySelector("a");
    expect(a.textContent).toBe("Bundle");
    expect(a.getAttribute("title")).toBe("已通过发布门禁");
  });

  it("产物 tab 上那个入口走的是同一个组件 —— 门禁一起生效", () => {
    G.S.state.artifacts = ["填写模板.xlsx"];
    let c = render(<ArtifactsTab />).container;
    expect(Array.from(c.querySelectorAll("a") as any[])
      .map((a: any) => a.getAttribute("href"))).toContain("/api/sessions/s1/bundle");
    cleanup();
    blocked();
    c = render(<ArtifactsTab />).container;
    expect(c.querySelector("[aria-disabled='true']").textContent).toBe("导出 Bundle · BLOCKED");
    expect(c.innerHTML).not.toContain("/bundle");
    // 单份产物照旧下得动
    expect(Array.from(c.querySelectorAll("a") as any[])
      .some((a: any) => a.getAttribute("href").includes("/artifacts/"))).toBe(true);
  });

  it("一份产物都没有时不画「导出 Bundle」—— 空包比没有按钮更像出错", () => {
    const c = render(<ArtifactsTab />).container;
    expect(c.querySelector(".ph > .ic").textContent).toBe("ARTIFACTS");
    expect(btns(c)).toEqual([]);
  });

  it("不可点的样式是有的 —— `hidden`/`disabled` 这类靠 CSS 兜底的必须存在", () => {
    expect(readFileSync(resolve(ROOT, "ui", "index.html"), "utf8"))
      .toContain(".act.disabled,.abtn.disabled");
  });
});

// ══════════════════════════════════════════════════════════════════
//  受阻 / 已延期
// ══════════════════════════════════════════════════════════════════
describe("受阻/已延期的问题必须先恢复待答", () => {
  for (const status of ["deferred", "blocked"]) {
    it(`${status} 的卡片只给「恢复待答」，回答框与参考选项都是锁着的`, () => {
      G.Q_BACKLOG = [q({ status, options: [{ id: "o1", label: "甲" }] })];
      const c = board();
      expect(btns(c)).toContain("恢复待答");
      expect(btns(c)).not.toContain("提交回答");
      expect(btns(c)).not.toContain("延期");
      expect(c.querySelector(".qanswer").disabled).toBe(true);
      expect(c.querySelector("[data-q-option]").disabled).toBe(true);
      expect(c.querySelector(".qcard").className).toContain("deferred");
    });
  }

  it("已回答的给「重新打开」，待回答的才给「提交回答」+「延期」", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    let c = board();
    expect(btns(c)).toContain("重新打开");
    expect(c.querySelector(".qcard").className).toContain("answered");
    expect(c.querySelector(".qanswer").disabled).toBe(true);
    cleanup();

    G.Q_BACKLOG = [q({ status: "open" })];
    c = board();
    expect(btns(c)).toContain("提交回答");
    expect(btns(c)).toContain("延期");
    expect(c.querySelector(".qanswer").disabled).toBe(false);
  });

  it("正在提交的那张卡整张锁住（Q_BUSY）", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    Q_BUSY.add("q1");
    const c = board();
    expect(btn(c, "保存中…").disabled).toBe(true);
    expect(c.querySelector("[data-q-owner]").disabled).toBe(true);
    expect(c.querySelector(".qanswer").disabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  证据
// ══════════════════════════════════════════════════════════════════
describe("证据 chip 能跳回原文", () => {
  it("点证据 → openSource(文件, cite)，参数是原样的值", async () => {
    G.Q_BACKLOG = [q({ status: "open",
      evidence: [{ file_name: "订单表.xlsx", cite: "订单表.xlsx!Sheet1!R2C3" }] })];
    const c = board();
    const ev = c.querySelector(".ev");
    expect(ev.textContent).toBe("◧ 订单表.xlsx!Sheet1!R2C3");
    await click(ev);
    // openSource 的效果：跳到材料 tab 并定位到那份文件（参数原样，没被转义动过）
    expect(G.TAB).toBe("mat");
    expect(G.FILE).toBe("订单表.xlsx");
    expect(calls.some(x => x.url.includes("source?file=") && x.url.includes(encodeURIComponent("订单表.xlsx")))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  回传模板：预审 → 人确认 → 应用
// ══════════════════════════════════════════════════════════════════
describe("回传模板走「预审 → 显式应用」两步", () => {
  const card = () => render(<ReturnAuditCard />).container;

  it("预审卡：损伤与丢弃逐条列出，被挡住时不给应用按钮", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: ["锚点被删"], dropped: ["第 12 行"], completeness: 0.5 };
    const c = card();
    expect(c.textContent).toContain("结构损伤 1 处");
    expect(c.textContent).toContain("锚点被删");
    expect(c.textContent).toContain("未合并 / 丢弃 1 项");
    expect(c.textContent).toContain("第 12 行");
    expect(c.textContent).toContain("已阻断应用");
    expect(btns(c)).not.toContain("确认应用并生成新版本");
    expect(c.querySelector(".retcard").className).toContain("warn");
  });

  it("预审通过、还没应用时：明说尚未写入，并给出那个确认按钮", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    const c = card();
    expect(c.textContent).toContain("尚未写入 Ontology");
    expect(btn(c, "确认应用并生成新版本")).not.toBeUndefined();
  });

  it("readable 不是明确的 true → 一样没有应用入口（fail closed）", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: "maybe", damage: [] };
    expect(btns(card())).not.toContain("确认应用并生成新版本");
  });

  it("最后一步是人点头：confirm 取消就不写", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    g.confirm = () => false;
    await click(btn(card(), "确认应用并生成新版本"));
    expect(calls).toEqual([]);
  });

  it("确认之后才 apply=true，并刷新问题清单", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    g.confirm = () => true;
    installFetch([
      [/audit\?apply=true/, { applied_count: 4, revision: 9 }],
      [/\/state$/, { id: "s1", filelist: [] }],
      [/\/questions$/, { questions: [] }],
    ]);
    await click(btn(card(), "确认应用并生成新版本"));
    expect(calls.map(x => x.url)).toContain("/api/sessions/s1/audit?apply=true");
    expect(calls.some(x => x.url === "/api/sessions/s1/questions")).toBe(true);
    expect(G.RETURN_AUDIT.applied).toBe(true);
  });

  it("已应用之后给的是 <BundleLink>，跟着门禁走", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { applied: true, readable: true, completeness: 1, revision: 9 };
    let c = card();
    expect(c.textContent).toContain("已生成 revision 9");
    expect(c.querySelector("a").getAttribute("href")).toBe("/api/sessions/s1/bundle");
    cleanup();
    G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })];
    c = card();
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("BLOCKED");
  });

  it("预审中 / 预审失败各有自己的样子，且都不给应用入口", () => {
    G.RETURN_BUSY = true;
    expect(card().textContent).toContain("正在预审回传件…");
    cleanup();
    G.RETURN_BUSY = false;
    G.RETURN_AUDIT = { error: "读不出这份表" };
    const c = card();
    expect(c.textContent).toContain("回传件没有通过预审");
    expect(c.textContent).toContain("读不出这份表");
    expect(btns(c)).toEqual(["关闭"]);
  });

  it("没有预审结果时整块不画", () => {
    expect(card().innerHTML).toBe("");
  });

  it("工作台上那个入口在，预审卡就挂在工作台里", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    const c = board();
    expect(btns(c)).toContain("上传回传模板");
    expect(c.querySelector(".retcard")).not.toBeNull();
    expect(within(c.querySelector(".retcard") as any).getByText(/回传件预审/)).toBeTruthy();
    expect(btns(c)).toContain("刷新");
  });
});

// ══════════════════════════════════════════════════════════════════
//  源码级：转义那一层在这块屏幕上也不许回来
// ══════════════════════════════════════════════════════════════════
/** ts/src/ui 下**递归**的全部 .tsx。 */
function tsxSources(): Array<[string, string]> {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f: string) => {
    const p = resolve(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return f.endsWith(".tsx") ? [p] : [];
  });
  return walk(UI_SRC).map(p => [relative(UI_SRC, p), readFileSync(p, "utf8")] as [string, string]);
}
/** 去掉整行注释 —— 通扫要断的是代码。 */
const codeLines = (src: string): string =>
  src.split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n");

describe("这三块屏幕的组件里没有拼串的后门", () => {
  const mine = ["react/workbench.tsx", "react/returncard.tsx", "react/pending.tsx", "react/bundle.tsx"];

  it("不再调 esc / eattr / earg，也没有 innerHTML 赋值", () => {
    const bad: string[] = [];
    for (const [file, src] of tsxSources()) {
      if (!mine.includes(file)) continue;
      for (const m of codeLines(src).matchAll(/(?<![\w.])(?:esc|eattr|earg|ejs)\(/g)) bad.push(`${file}: ${m[0]}`);
      for (const m of codeLines(src).matchAll(/\.innerHTML\s*=/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("dangerouslySetInnerHTML 一处都没有 —— 这块屏幕上没有 markdown", () => {
    const hits = tsxSources().filter(([f]) => mine.includes(f))
      .filter(([, src]) => codeLines(src).includes("dangerouslySetInnerHTML")).map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it("敌意问题正文渲染成文本，不是标记", () => {
    const evil = `"><img src=x onerror=alert(1)>`;
    G.Q_BACKLOG = [q({ text: evil, why: evil, impact: evil, status: "open" })];
    const c = board();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector(".qcard .qtext").textContent).toBe(evil);
    expect(c.innerHTML).not.toMatch(/\son[a-z]+="/);
  });
});
