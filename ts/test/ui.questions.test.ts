/**
 * 问题工作台的三个纯函数：形态收口、发布门禁、Bundle 链接。
 *
 * normalizeQuestion 是**兼容层**：服务端可能给新 Question Ledger 的形状，也可能
 * 只有历史 OIR / 冲突卡。前端后面所有卡片只认收口后的这一种结构，所以这里钉的是
 * 「哪种输入映到哪种 status」——尤其 reopen 之后 Ledger 的显式 lifecycle 必须赢过
 * 还挂着的旧 Decision，否则一个重新打开的问题会显示成已回答。
 *
 * releaseView 是**fail closed**：有阻塞问题就必须 BLOCKED，哪怕会话状态还写着
 * RELEASED。bundleLink 据此把导出按钮变成不可点 —— 这是交付门禁的最后一道。
 */
import "./ui.env.js";

import { beforeEach, describe, expect, it } from "vitest";

import { G } from "../src/ui/state.js";
import { bundleLink, localQuestionBacklog, normalizeQuestion, releaseView } from "../src/ui/questions.js";

beforeEach(() => {
  G.S = { id: "s1", status: "done", state: {} };
  G.Q_BACKLOG = [];
});

describe("normalizeQuestion", () => {
  it("Ledger 的显式 lifecycle 赢过还挂着的旧 Decision", () => {
    const q = normalizeQuestion(
      { id: "q1", text: "口径是什么", status: "open", activeDecision: { answer: "旧答案" } }, "ledger");
    expect(q.status).toBe("open");
    expect(q.answer).toBe("旧答案"); // 答案还在，但状态是 open
  });

  it("遗留形态：没有 lifecycle 但有答案 → 已回答", () => {
    expect(normalizeQuestion({ id: "q", text: "t", answer: "有" }, "oir").status).toBe("answered");
  });

  it("candidate / draft / 空 → open；confirmed → answered；rejected → cancelled", () => {
    const s = (status: unknown) => normalizeQuestion({ id: "q", text: "t", status }, "oir").status;
    expect(s("candidate")).toBe("open");
    expect(s("draft")).toBe("open");
    expect(s(undefined)).toBe("open");
    expect(s("confirmed")).toBe("answered");
    expect(s("rejected")).toBe("cancelled");
    expect(s("莫名其妙")).toBe("open"); // 认不出的一律当待答，不能凭空消失
  });

  it("status. 前缀会被剥掉（服务端有时给的是枚举全名）", () => {
    expect(normalizeQuestion({ id: "q", text: "t", status: "STATUS.DEFERRED" }, "l").status).toBe("deferred");
  });

  it("优先级：显式为准，否则按 blocking / 不可逆 / 影响面推", () => {
    const p = (raw: Record<string, unknown>) => normalizeQuestion({ id: "q", text: "t", ...raw }, "l").priority;
    expect(p({ priority: "LOW" })).toBe("low");
    expect(p({ blocking: true })).toBe("high");
    expect(p({ reversible: false })).toBe("high");
    expect(p({ blastRadius: 10 })).toBe("high");
    expect(p({ blastRadius: 9 })).toBe("normal");
  });

  it("选项两种形态都收：对象或裸字符串；空 label 丢掉", () => {
    const q = normalizeQuestion({ id: "q", text: "t",
      options: [{ id: "a", label: "甲", rationale: "因为" }, "乙", { label: "" }] }, "l");
    expect(q.options).toEqual([
      { id: "a", label: "甲", rationale: "因为" },
      { id: "1", label: "乙", rationale: "" },
    ]);
  });

  it("{value:…} 包装的字段会被拆开", () => {
    expect(normalizeQuestion({ id: "q", text: { value: "问句" } }, "l").text).toBe("问句");
  });

  it("没有正文时给出可读的占位，而不是 undefined", () => {
    expect(normalizeQuestion({ id: "q" }, "l").text).toBe("（未命名问题）");
  });

  it("旧问题里的机器协议只保留在 raw，卡片显示可直接询问的正文", () => {
    const q = normalizeQuestion({
      id: "q.agent.1",
      text: "[高][ERP顾问][blocked:sys.erp] 客户使用哪个 ERP 版本？ | answer:TEXT | evidence:a#p1",
      why: "由 ERP_MAP 独立分析发现，需由相应业务角色确认",
      sourceKind: "agent_analysis",
    }, "ledger");
    expect(q).toMatchObject({
      text: "客户使用哪个 ERP 版本？",
      priority: "high",
      role: "ERP顾问",
      why: "材料里的系统信息没有说明清楚，需要请ERP顾问确认。",
      source: "agent_analysis",
      sourceLabel: "材料分析",
    });
    expect(q.raw.text).toContain("blocked:sys.erp");
  });

  it("下划线与驼峰两套字段名都认", () => {
    const q = normalizeQuestion(
      { id: "q", text: "t", owner_user_id: "u1", audience_role: "业务", applies_to: ["A"], blocked_artifacts: "B" }, "l");
    expect([q.owner, q.role, q.applies, q.blockedArtifacts]).toEqual(["u1", "业务", ["A"], ["B"]]);
  });
});

describe("localQuestionBacklog（后端没有 Ledger 时的只读兜底）", () => {
  it("把 OIR 问题与冲突卡合成一份，按正文去重", () => {
    G.S.state = {
      oir: { questions: [{ id: "o1", text: "同一个问题" }] },
      questions: [{ conflict_rid: "c1", title: "同一个问题" }, { conflict_rid: "c2", title: "另一个" }],
      answered: ["c2"],
    };
    const rows = localQuestionBacklog();
    expect(rows.map((q: any) => q.text)).toEqual(["同一个问题", "另一个"]);
    expect(rows[1].status).toBe("answered"); // answered 名单里的冲突卡要标已回答
  });

  it("没有会话时给空数组，不抛", () => {
    G.S = null;
    expect(localQuestionBacklog()).toEqual([]);
  });
});

describe("releaseView / bundleLink", () => {
  const q = (o: Record<string, unknown>) => normalizeQuestion({ id: String(Math.random()), text: "t", ...o }, "l");

  it("有阻塞问题就 BLOCKED —— 哪怕会话状态写着 RELEASED", () => {
    G.S.state.release_state = "RELEASED";
    G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })];
    expect(releaseView()).toEqual({ state: "BLOCKED", blockers: 1, pending: 1 });
  });

  it("阻塞了某个产物的问题同样算阻塞项", () => {
    G.Q_BACKLOG = [q({ status: "open", blockedArtifacts: ["模板.xlsx"] })];
    expect(releaseView().state).toBe("BLOCKED");
  });

  it("只有非阻塞的待答问题 → DRAFT", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    expect(releaseView()).toMatchObject({ state: "DRAFT", blockers: 0, pending: 1 });
  });

  it("问题清空且会话已完成 → RELEASED", () => {
    G.Q_BACKLOG = [q({ status: "answered", answer: "好" })];
    expect(releaseView().state).toBe("RELEASED");
  });

  it("BLOCKED 时导出按钮不是链接，点不动", () => {
    G.Q_BACKLOG = [q({ status: "open", priority: "blocking" })];
    const html = bundleLink("导出交付包", "abtn");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("BLOCKED");
    expect(html).not.toContain("<a ");
  });

  it("DRAFT 时能下载，但标着草稿", () => {
    G.Q_BACKLOG = [q({ status: "open" })];
    const html = bundleLink("导出交付包");
    expect(html).toContain('href="/api/sessions/s1/bundle"');
    expect(html).toContain("· DRAFT");
  });
});

// ══════════════════════════════════════════════════════════════════
//  qRequest 的 409 分诊自愈
//
//  2026-08-25 事故：审阅面板保存答复，客户端把**一切** 409 都翻译成
//  「问题已被其他人更新，请刷新后重试」。可实测里那次 409 根本不是版本冲突，
//  是跑批在途、mutation 租约必拒 —— 刷新一万次也没用，用户被误导。
//  这里钉三条：跑批在途要诚实转述且不重试；真版本落后要自动拉新重试一次；
//  拉新后发现已终态要说真话、不许再写。
// ══════════════════════════════════════════════════════════════════

import { qRequest } from "../src/ui/questions.js";

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> };

function resp(status: number, body: unknown): FakeResponse {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

describe("qRequest 409 自愈", () => {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  let alerts: string[];
  let script: Array<(c: { method: string; url: string }) => FakeResponse>;

  beforeEach(() => {
    calls.length = 0;
    alerts = [];
    script = [];
    G.S = { id: "s1", status: "awaiting_answer", state: {} };
    G.Q_API = true;
    G.TAB = "";
    G.Q_BACKLOG = [{ id: "q1", text: "口径", status: "open", revision: 3, options: [] }];
    (globalThis as unknown as { alert: (m: string) => void }).alert = (m) => { alerts.push(String(m)); };
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const step = script.shift();
      if (!step) throw new Error(`fetch 脚本用完了：${method} ${url}`);
      return step({ method, url });
    };
  });

  const listBody = (over: Record<string, unknown> = {}) => ({
    questions: [{ id: "q1", text: "口径", status: "open", version: 5, ...over }],
    nextBatch: [],
  });

  it("真版本落后：自动拉新 revision 重试一次，成功后不打扰用户", async () => {
    script = [
      () => resp(409, { detail: "问题已更新：预期 version 3，实际 5" }),
      () => resp(200, listBody()),                       // 拉新
      () => resp(200, { question: { id: "q1" } }),       // 重试成功
      () => resp(200, listBody()),                       // 成功后的常规刷新
    ];
    const ok = await qRequest(0, "", "PATCH", { priority: "high" });
    expect(ok).toBe(true);
    expect(alerts).toEqual([]);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(2);
    expect(patches[0]!.body!.expected_revision).toBe(3);
    expect(patches[1]!.body!.expected_revision).toBe(5); // 用的是拉新后的版本
    expect(patches[1]!.body!.priority).toBe("high");     // 用户意图原样带上
  });

  it("跑批在途：不重试、不说「已被其他人更新」，诚实转述并保住草稿", async () => {
    script = [
      () => resp(409, { detail: "会话正在梳理（parsing），本轮跑完才能保存这类修改，请稍后重试。" }),
    ];
    const ok = await qRequest(0, "", "PATCH", { priority: "high" });
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(1); // 明知必败不重试
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("梳理");
    expect(alerts[0]).not.toContain("已被其他人更新");
  });

  it("拉新后发现已被别处回答 → 说真话，不再覆写", async () => {
    script = [
      () => resp(409, { detail: "问题已更新：预期 version 3，实际 6" }),
      () => resp(200, listBody({ status: "answered", version: 6, activeDecision: { answer: "别人答的" } })),
    ];
    const ok = await qRequest(0, "", "PATCH", { priority: "high" });
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(1);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("回答");
  });

  it("重试仍冲突 → 放弃并告知，不无限循环", async () => {
    script = [
      () => resp(409, { detail: "问题已更新：预期 version 3，实际 5" }),
      () => resp(200, listBody()),
      () => resp(409, { detail: "问题已更新：预期 version 5，实际 7" }),
    ];
    const ok = await qRequest(0, "", "PATCH", { priority: "high" });
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(2);
    expect(alerts.length).toBe(1);
  });
});
