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
