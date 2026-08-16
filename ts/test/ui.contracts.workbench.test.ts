/**
 * FDE 问题工作台的行为契约（原 tests/test_ui_question_workbench.py 的前半）。
 *
 * 那份 Python 测试是按源码文本锚点切 ui/index.html 的内联 JS 再喂给 Node 跑的
 * （`assert 'qRequest(i, "/answer", "POST"' in script`）。打包之后锚点全没了 ——
 * 前提（「单文件、没有构建步骤」）不成立了。这里逐条改成**直接 import 模块、
 * 断言行为或产出的 HTML**：写法变了，钉的东西一个不少。
 *
 * 三类东西必须留住：
 *   · Ledger 写接口与遗留 OIR/conflict 兼容路径**同时**存在（后端可以渐进升级）；
 *   · Bundle 的发布门禁 —— BLOCKED 时所有入口都点不动，但问题清单与单份草稿照下；
 *   · 回传件是「预审 → 人确认 → 应用」三步，任何一步没过都不许写 Ontology。
 */
import "./ui.env.js";
import { el, resetDom } from "./ui.env.js";

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { G, Q_BUSY } from "../src/ui/state.js";
import {
  bundleLink, engagementProgress, loadQuestions, normalizeQuestion, qDefer, qReopen,
  qSaveMeta, qSubmit, questionWorkbench, releaseView,
} from "../src/ui/questions.js";
import { paint } from "../src/ui/preview.js";
import { paintActions } from "../src/ui/render.js";
import {
  applyReturnAudit, auditReturnPicked, returnAuditCard,
} from "../src/ui/returnaudit.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI_SRC = resolve(ROOT, "ts", "src", "ui");
const uiSources = (): Array<[string, string]> =>
  readdirSync(UI_SRC).filter(f => f.endsWith(".ts") && f !== "browser.d.ts")
    .map(f => [f, readFileSync(resolve(UI_SRC, f), "utf8")] as [string, string]);

// ── 测试替身 ────────────────────────────────────────────────────
type Call = { url: string; method: string; body: any };
let calls: Call[] = [];
let alerts: string[] = [];
const g = globalThis as any;
const realQuerySelector = g.document.querySelector;

/** 按 URL 片段路由的假 fetch，并记下每一次请求。 */
function installFetch(routes: Array<[RegExp, any]>): void {
  g.fetch = async (url: string, opts: any = {}) => {
    const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method: opts.method || "GET", body });
    for (const [re, payload] of routes) {
      if (re.test(String(url))) {
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
}

/** qCard(i) 走 document.querySelector('.qcard[data-qidx=…]')；给它一张有值的卡。 */
function installCard(fields: Record<string, string>): void {
  const card = { querySelector: (sel: string) => (sel in fields ? { value: fields[sel] } : null) };
  g.document.querySelector = (sel: string) => (String(sel).startsWith(".qcard") ? card : null);
}

const q = (raw: Record<string, unknown>) => normalizeQuestion({ id: "q1", text: "口径是什么", ...raw }, "ledger");

beforeEach(() => {
  resetDom();
  calls = []; alerts = [];
  Q_BUSY.clear();
  g.alert = (m: string) => { alerts.push(String(m)); };
  g.confirm = () => false;
  g.document.querySelector = realQuerySelector;
  G.S = { id: "s1", title: "T", mode: "work", status: "done", files: 1,
          state: { dialogue: { turns: [] }, artifacts: [] }, events: [], filelist: [] };
  G.TAB = "q";
  G.Q_BACKLOG = []; G.Q_NEXT = []; G.Q_API = true; G.Q_FILTER = "all"; G.Q_LIMIT = 40;
  G.RETURN_AUDIT = null; G.RETURN_FILE = null; G.RETURN_BUSY = false;
  G.PENDING = []; G.STEPS = []; G.TRACE = []; G.OPS = [];
  installFetch([]);
});

afterEach(() => { g.document.querySelector = realQuerySelector; });

// ══════════════════════════════════════════════════════════════════
//  工作台本身
// ══════════════════════════════════════════════════════════════════
// #pbody 已经归 React 了（react/preview.tsx 末尾那行 registerRegion），所以这两条
// 从「paint() 往 #pbody 里写了什么」改成「paint() 一个字节都不写 + 工作台本身还是
// 那个工作台」。**一个容器只能有一个主人** —— 旧渲染器再往里写 innerHTML，React
// 下一次更新轻则丢节点、重则抛 NotFoundError，所以「不写」本身就是一条要钉住的
// 契约。「用户点得到、点下去发生了对的事」那一版断言在
// ui.contracts.workbench.react.test.tsx（组件版）与 ui.react.preview.test.tsx（接线）。
describe("问题 tab 是一个真的工作台", () => {
  it("paint() 不再在 React 背后碰 #pbody；四种可编辑能力仍在工作台上", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    paint();
    expect(el("pbody").innerHTML).toBe("");
    const html = questionWorkbench();
    expect(html).toContain("FDE 问题工作台");
    for (const cap of ["data-q-owner", "data-q-role", "data-q-priority", "data-q-answer"]) {
      expect(html).toContain(cap);
    }
  });

  it("没有问题时也是工作台，不是一片空白", () => {
    paint();
    expect(el("pbody").innerHTML).toBe("");
    expect(questionWorkbench()).toContain("这个筛选下没有问题");
  });
});

describe("Ledger 写接口与遗留兼容路径同时在", () => {
  it("提交回答 → POST /questions/{id}/answer，带幂等键与期望版本", async () => {
    G.Q_BACKLOG = [normalizeQuestion({ id: "q 1", text: "t", revision: 7 }, "ledger")];
    installCard({ "[data-q-answer]": "  按下单时间口径  " });
    await qSubmit(0);
    const answer = calls.find(c => c.url.includes("/answer"))!;
    expect(answer.url).toBe("/api/sessions/s1/questions/q%201/answer");
    expect(answer.method).toBe("POST");
    expect(answer.body.answerText).toBe("按下单时间口径");
    expect(answer.body.actor).toBe("fde");
    expect(String(answer.body.idempotencyKey).length).toBeGreaterThan(0);
    expect(answer.body.expected_revision).toBe(7);
    // 成功之后必须重新拉一次清单，否则界面还停在旧状态
    expect(calls.some(c => c.url === "/api/sessions/s1/questions" && c.method === "GET")).toBe(true);
  });

  it("延期 → PATCH status:deferred；重新打开 → POST /reopen", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    g.prompt = () => "等业务确认";
    await qDefer(0);
    const defer = calls.find(c => c.method === "PATCH")!;
    expect(defer.body).toMatchObject({ status: "deferred", reason: "等业务确认" });

    calls = [];
    G.Q_BACKLOG = [q({ status: "deferred" })];   // 上一步的 loadQuestions 已经把清单换掉了
    await qReopen(0);
    const reopen = calls.find(c => c.url.endsWith("/reopen"))!;
    expect(reopen.method).toBe("POST");
    expect(reopen.body.reason).toBeTruthy();
  });

  it("延期对话框点取消（prompt 返回 null）就什么都不发", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    g.prompt = () => null;
    await qDefer(0);
    expect(calls).toEqual([]);
  });

  it("保存分派 → PATCH ownerUserId / audienceRole / priority", async () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    installCard({ "[data-q-owner]": " 张三 ", "[data-q-role]": "业务负责人", "[data-q-priority]": "high" });
    await qSaveMeta(0);
    const meta = calls.find(c => c.method === "PATCH")!;
    expect(meta.body).toEqual({ ownerUserId: "张三", audienceRole: "业务负责人", priority: "high" });
  });

  it("后端没有 Ledger 时：冲突卡仍走稳定的 /api/sessions/{id}/answer", async () => {
    G.Q_API = false;
    G.Q_BACKLOG = [normalizeQuestion(
      { id: "c1", text: "两个口径打架", conflict_rid: "c1", options: [{ id: "o1", label: "按下单" }] }, "conflict")];
    installCard({ "[data-q-answer]": "", "[data-q-option]": "o1" });
    await qSubmit(0);
    const legacy = calls.find(c => c.url === "/api/sessions/s1/answer")!;
    expect(legacy.method).toBe("POST");
    expect(legacy.body).toMatchObject({ conflict_rid: "c1", option_id: "o1" });
  });

  it("后端没有 Ledger 时：Ledger 专属写操作说清楚而不是静默失败", async () => {
    G.Q_API = false;
    G.Q_BACKLOG = [q({ status: "open" })];
    await qReopen(0);
    expect(calls).toEqual([]);
    expect(alerts.join()).toContain("Question Ledger");
  });

  it("遗留会话把 oir.questions 与冲突卡合成同一个 backlog", async () => {
    G.S.state.oir = { questions: [{ id: "o1", text: "问卷问题" }] };
    G.S.state.questions = [{ conflict_rid: "c1", title: "冲突问题" }];
    g.fetch = async () => { throw new Error("no ledger"); };   // 后端没这个接口
    await loadQuestions();
    expect(G.Q_API).toBe(false);
    expect(G.Q_BACKLOG.map((x: any) => x.text)).toEqual(["问卷问题", "冲突问题"]);
  });
});

describe("交付物：三种导出格式 + Bundle", () => {
  it("Ledger 在时给 XLSX / MD / JSON 三个下载口，外加 Bundle", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    const html = questionWorkbench();
    for (const f of ["xlsx", "md", "json"]) {
      expect(html).toContain(`/api/sessions/s1/questions/export?format=${f}`);
      expect(html).toContain(`>${f.toUpperCase()}<`);
    }
    expect(html).toContain("/api/sessions/s1/bundle");
  });

  it("兼容模式下不假装能导出 —— 但清单本身还在", () => {
    G.Q_API = false;
    G.Q_BACKLOG = [q({ status: "open" })];
    const html = questionWorkbench();
    expect(html).not.toContain("questions/export?format=");
    expect(html).toContain("兼容模式");
    expect(html).toContain("口径是什么");
  });
});

describe("服务端排好的下一批", () => {
  it("nextBatch 里的裸 id 解析回 backlog 里那条，对象则就地收口", async () => {
    installFetch([[/\/questions$/, {
      questions: [{ id: "a", text: "先问这条" }],
      nextBatch: ["a", { id: "b", text: "再问这条", audience_role: "财务" }, "不存在的 id"],
    }]]);
    await loadQuestions();
    expect(G.Q_NEXT.map((x: any) => x.text)).toEqual(["先问这条", "再问这条"]);
    const html = questionWorkbench();
    expect(html).toContain("建议下一批先问");
    expect(html).toContain("再问这条");
    expect(html).toContain("财务");
  });

  it("没有 nextBatch 就不画这一块", async () => {
    installFetch([[/\/questions$/, { questions: [{ id: "a", text: "x" }] }]]);
    await loadQuestions();
    expect(questionWorkbench()).not.toContain("建议下一批先问");
  });
});

describe("优先级用的是领域契约那四档", () => {
  it("下拉里就是 低/普通/高/阻塞交付，没有 medium 这一档", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    const html = questionWorkbench();
    for (const [v, label] of [["low", "低优先级"], ["normal", "普通优先级"],
                              ["high", "高优先级"], ["blocking", "阻塞交付"]]) {
      expect(html).toContain(`<option value="${v}" `);
      expect(html).toContain(label!);
    }
    expect(html).not.toContain("medium");
  });

  it("影响面推优先级的阈值是 10，不是 3", () => {
    expect(normalizeQuestion({ id: "q", text: "t", blastRadius: 3 }, "l").priority).toBe("normal");
    expect(normalizeQuestion({ id: "q", text: "t", blastRadius: 10 }, "l").priority).toBe("high");
  });
});

describe("发布状态与「计划是否冻结」是两件事", () => {
  const plan = (frozen: boolean) => {
    G.S.state.engagement = { frozen, version: "v3", plan: [{ id: "INTAKE", state: "done" }] };
  };

  it("冻结的 DAG 说 FROZEN DAG，没冻结说 EDITABLE PLAN", () => {
    plan(true);
    expect(engagementProgress()).toContain("FROZEN DAG");
    plan(false);
    expect(engagementProgress()).toContain("EDITABLE PLAN");
  });

  it("冻结与 DRAFT/BLOCKED/RELEASED 各说各的，不能拿冻结冒充发布状态", () => {
    plan(true);
    G.Q_BACKLOG = [q({ status: "open" })];                       // → DRAFT
    expect(engagementProgress()).toContain("FROZEN DAG · DRAFT");

    G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })]; // → BLOCKED
    expect(engagementProgress()).toContain("FROZEN DAG · BLOCKED");
    expect(engagementProgress()).toContain("1 BLOCKERS");
  });

  it("blockedArtifacts 也算阻塞项，且会话状态 RELEASED 拦不住 fail closed", () => {
    G.S.state.release_state = "RELEASED";
    G.Q_BACKLOG = [q({ status: "open", blockedArtifacts: ["模板.xlsx"] })];
    expect(releaseView()).toEqual({ state: "BLOCKED", blockers: 1, pending: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════
//  Bundle 门禁
// ══════════════════════════════════════════════════════════════════
describe("Bundle 下载的门禁", () => {
  const blocked = () => { G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })]; };

  it("BLOCKED 时不是链接，且说清楚「问题清单和单份草稿仍可下载」", () => {
    blocked();
    const html = bundleLink("Bundle", "act pri");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("/bundle");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("问题清单和单份草稿仍可下载");
  });

  // 「回传合并事件卡」那一处不在下面这份名单里了：那张卡归 <EvCard>
  // （react/events.tsx），它上面的 Bundle 是 <BundleLink>，由
  // ui.react.stream.test.tsx 的「回传合并那张卡上的 Bundle 走的是同一道门禁」钉住。
  it("**每一个** Bundle 入口都走同一道闸 —— 没有一处能绕过去", () => {
    blocked();
    G.S.state.artifacts = ["填写模板.xlsx"];
    G.RETURN_AUDIT = { applied: true, readable: true, completeness: 1 };
    G.RETURN_FILE = { name: "回传.xlsx" };
    paintActions();
    const surfaces: Array<[string, string]> = [
      ["常驻动作栏", el("abar").innerHTML],
      ["问题工作台", questionWorkbench()],
      ["回传已应用卡", returnAuditCard()],
    ];
    for (const [name, html] of surfaces) {
      expect(html, name).toContain("BLOCKED");
      expect(html, name).not.toContain('href="/api/sessions/s1/bundle"');
    }
    // 但问题清单和单份产物照旧可下载 —— 门禁只关 Bundle 这一扇门
    expect(surfaces[1]![1]).toContain("questions/export?format=xlsx");
    expect(el("abar").innerHTML).toContain("artifacts/%E5%A1%AB%E5%86%99%E6%A8%A1%E6%9D%BF.xlsx");
  });

  it("唯一那条真实 href 只存在于 bundleLink 里（源码级）", () => {
    const withHref = uiSources().filter(([, src]) => src.includes("/bundle"));
    expect(withHref.map(([f]) => f)).toEqual(["questions.ts"]);
    const total = uiSources().reduce((n, [, src]) => n + (src.match(/bundleLink\(/g) || []).length, 0);
    // 3 个入口 + 1 个函数定义。**闸没少一道，只是搬了宿主**：产物 tab 那个入口随
    // #pbody 一起归了 React（<BundleLink>，react/bundle.tsx），事件卡那个随 #stream
    // 一起走。组件版的同一条断言在 ui.contracts.workbench.react.test.tsx，
    // 它断的是「唯一那条 href 只存在于 react/bundle.tsx」。
    expect(total).toBe(4);
  });

  it("一个已发布会话重新打开普通问题，当前包立刻降为 DRAFT", () => {
    G.S.state.release_state = "RELEASED";
    G.Q_BACKLOG = [q({ status: "open" })];
    expect(releaseView().state).toBe("DRAFT");
    expect(bundleLink("Bundle")).toContain("· DRAFT");
    expect(bundleLink("Bundle")).toContain("/api/sessions/s1/bundle");
  });

  it("不可点的样式是有的 —— `hidden`/`disabled` 这类靠 CSS 兜底的必须存在", () => {
    expect(readFileSync(resolve(ROOT, "ui", "index.html"), "utf8"))
      .toContain(".act.disabled,.abtn.disabled");
  });
});

describe("受阻/已延期的问题必须先恢复待答", () => {
  for (const status of ["deferred", "blocked"]) {
    it(`${status} 的卡片只给「恢复待答」，回答框是锁着的`, () => {
      G.Q_BACKLOG = [q({ status, options: [{ id: "o1", label: "甲" }] })];
      const html = questionWorkbench();
      expect(html).toContain('onclick="qReopen(0)"');
      expect(html).toContain("恢复待答");
      expect(html).not.toContain("提交回答");
      expect(html).toMatch(/<textarea class="qanswer"[^>]*disabled/);
      expect(html).toMatch(/data-q-option[^>]*disabled/);
    });
  }

  it("已回答的给「重新打开」，待回答的才给「提交回答」", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    expect(questionWorkbench()).toContain("重新打开");
    G.Q_BACKLOG = [q({ status: "open" })];
    const open = questionWorkbench();
    expect(open).toContain("提交回答");
    expect(open).toContain("延期");
  });
});

// ══════════════════════════════════════════════════════════════════
//  回传模板：预审 → 人确认 → 应用
// ══════════════════════════════════════════════════════════════════
describe("回传模板走「预审 → 显式应用」两步", () => {
  const pickFile = () => {
    const picker = el("returnPicker");
    picker.files = [new File(["x"], "回传.xlsx")];
  };

  it("选中文件只做预审：apply=false，一个字都不写", async () => {
    pickFile();
    installFetch([[/audit\?apply=false/, { readable: true, completeness: 0.8, damage: [] }]]);
    await auditReturnPicked();
    expect(calls[0]!.url).toBe("/api/sessions/s1/audit?apply=false");
    expect(G.RETURN_AUDIT.readable).toBe(true);
  });

  it("预审没给出明确可读结果 → 不发 apply=true，并说明不会应用任何数据", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: false };
    await applyReturnAudit();
    expect(calls).toEqual([]);
    expect(alerts.join()).toContain("不会应用任何数据");
  });

  it("有结构损伤 → 挡住，并说清是几处", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: true, damage: ["锚点被删", "表头改了"] };
    await applyReturnAudit();
    expect(calls).toEqual([]);
    expect(alerts.join()).toContain("2 处结构损伤");
    expect(alerts.join()).toContain("系统不会应用任何数据");
  });

  it("最后一步是人点头：confirm 取消就不写", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: true, damage: [] };
    g.confirm = () => false;
    await applyReturnAudit();
    expect(calls).toEqual([]);
  });

  it("确认之后才 apply=true，并刷新问题清单", async () => {
    G.RETURN_FILE = new File(["x"], "回传.xlsx");
    G.RETURN_AUDIT = { readable: true, damage: [] };
    g.confirm = () => true;
    installFetch([
      [/audit\?apply=true/, { applied_count: 4, revision: 9 }],
      [/\/state$/, { id: "s1", filelist: [] }],
      [/\/questions$/, { questions: [] }],
    ]);
    await applyReturnAudit();
    expect(calls.map(c => c.url)).toContain("/api/sessions/s1/audit?apply=true");
    expect(calls.some(c => c.url === "/api/sessions/s1/questions")).toBe(true);
    expect(G.RETURN_AUDIT.applied).toBe(true);
  });

  it("预审卡：损伤与丢弃逐条列出，被挡住时不给应用按钮", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: ["锚点被删"], dropped: ["第 12 行"], completeness: 0.5 };
    const card = returnAuditCard();
    expect(card).toContain("结构损伤 1 处");
    expect(card).toContain("锚点被删");
    expect(card).toContain("未合并 / 丢弃 1 项");
    expect(card).toContain("第 12 行");
    expect(card).toContain("已阻断应用");
    expect(card).not.toContain("applyReturnAudit()");
  });

  it("预审通过、还没应用时：明说尚未写入，并给出那个确认按钮", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    const card = returnAuditCard();
    expect(card).toContain("尚未写入 Ontology");
    expect(card).toContain('onclick="applyReturnAudit()"');
  });

  it("工作台上那个入口在（openReturnPicker），预审卡就挂在工作台里", () => {
    G.RETURN_FILE = { name: "回传.xlsx" };
    G.RETURN_AUDIT = { readable: true, damage: [], completeness: 1 };
    const html = questionWorkbench();
    expect(html).toContain('onclick="openReturnPicker()"');
    expect(html).toContain("回传件预审");
    expect(html).toContain('onclick="loadQuestions()"');
  });
});
