/**
 * B13：失败轮的写效果账本隔离。
 *
 * 链条：写工具在 rec.effect 里执行完 → 轮子随后失败 → withSessionMutation 把
 * 内存回滚 → journal 文件留着 → 重问同一句话按语义指纹 resume 命中 →
 * **工具不再执行、直接回放「已改」**，而状态里什么都没有。
 */
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chatRun } from "../src/server/glue/chat_run.js";

function makeSession(dir: string): any {
  const events: unknown[] = [];
  return {
    id: "s1", dir, owner: "", state: {}, events,
    emit: (kind: string, payload: unknown) => events.push({ kind, ...(payload as object) }),
  };
}

const DEPS = {
  repo: () => { throw new Error("no repo"); },
  gateways: () => ({
    backend: { aclose: async () => {} },
    gw: {}, smart: null,
    budget: { snapshot: () => ({}) },
  }),
} as never;

function journalPath(dir: string, runId: string): string {
  return join(dir, "journal", `${runId}.jsonl`);
}

async function failingRun(s: any, lines: string[]): Promise<string> {
  let runId = "";
  await expect(chatRun(s, DEPS, { kind: "reason", semanticInput: { q: "改一下" } },
    async (run) => {
      runId = run.recorderRunId;
      mkdirSync(join(s.dir, "journal"), { recursive: true });
      writeFileSync(journalPath(s.dir, runId), lines.join("\n"));
      throw new Error("轮子在写完工具之后炸了");
    })).rejects.toThrow("炸了");
  return runId;
}

const WRITE_EFFECT = JSON.stringify({
  kind: "tool.call", status: "completed",
  payload: { tool: "oir.add", danger: "write_local", args: {} },
});
const READ_EFFECT = JSON.stringify({
  kind: "tool.call", status: "completed",
  payload: { tool: "evidence.search", danger: "read", args: {} },
});

describe("chat_run 的失败轮账本", () => {
  it("**含写效果的失败轮 journal 被隔离** —— 重试必须重新执行，不是回放「已改」", async () => {
    const s = makeSession(mkdtempSync(join(tmpdir(), "ocq-")));
    const runId = await failingRun(s, [READ_EFFECT, WRITE_EFFECT]);
    expect(existsSync(journalPath(s.dir, runId))).toBe(false);
    expect(existsSync(`${journalPath(s.dir, runId)}.rolledback`)).toBe(true);
    expect(s.events.some((e: any) => e.kind === "chat.journal_quarantined")).toBe(true);
  });

  it("**纯读的失败轮保留 journal** —— resume 省的是真金白银，回放只读结果无害", async () => {
    const s = makeSession(mkdtempSync(join(tmpdir(), "ocq-")));
    const runId = await failingRun(s, [READ_EFFECT]);
    expect(existsSync(journalPath(s.dir, runId))).toBe(true);
    expect(s.events.some((e: any) => e.kind === "chat.journal_quarantined")).toBe(false);
  });

  it("成功的轮子一个字节都不动", async () => {
    const s = makeSession(mkdtempSync(join(tmpdir(), "ocq-")));
    let runId = "";
    await chatRun(s, DEPS, { kind: "reason", semanticInput: { q: "改一下" } }, async (run) => {
      runId = run.recorderRunId;
      mkdirSync(join(s.dir, "journal"), { recursive: true });
      writeFileSync(journalPath(s.dir, runId), WRITE_EFFECT);
      return "ok";
    });
    expect(existsSync(journalPath(s.dir, runId))).toBe(true);
  });
});
