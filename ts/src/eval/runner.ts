/**
 * EvalOps runner —— 起**真服务**、传**真材料**、跑**真模型**，对终态做语义断言。
 *
 * 为什么走 HTTP 而不是进程内调 pipeline 函数：评测要护住的是**用户真正走的那条
 * 路**（上传 → 解析 → DAG 抽取 → 问题挖掘 → 落库），进程内直调会绕过路由、
 * 租约、持久化 —— 那几层的回归恰恰是单测最难覆盖的（AsyncLock 那次 500 就是
 * 只有真跑才现形的）。
 *
 * 每次尝试用**全新 workspace + 全新服务进程**：pass^k 要衡量的是"这条链路稳不稳"，
 * 复用进程会让第 2 次尝试踩着第 1 次的缓存跑，k 次就不再独立。
 *
 * 花真钱，所以：不自动跑（CLI 要显式 --live）、每条用例带 max_usd 上限、
 * 报告里逐次记账 —— EvalReport 本来就要求 cost 是一等字段（架构审计 §8.3）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { startServer } from "../serve.js";
import type { AssertionOutcome, AttemptFacts, CaseAssertions } from "./assertions.js";
import { evaluateAttempt, passPowK } from "./assertions.js";

export interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly materials: readonly string[];
  readonly assertions: CaseAssertions;
}

export interface Manifest {
  readonly dataset_version: string;
  readonly cases: readonly EvalCase[];
}

export interface AttemptReport {
  readonly facts: AttemptFacts;
  readonly outcomes: readonly AssertionOutcome[];
  readonly pass: boolean;
}

export interface CaseReport {
  readonly id: string;
  readonly title: string;
  readonly attempts: readonly AttemptReport[];
  /** pass^k：k 次全过才算过。 */
  readonly pass: boolean;
}

export interface EvalReport {
  readonly dataset_version: string;
  readonly k: number;
  readonly started: string; // ISO
  readonly cases: readonly CaseReport[];
  readonly total_usd: number;
  readonly total_seconds: number;
  readonly pass: boolean;
}

const POLL_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 一次尝试：新 workspace、新进程，跑完拆干净。 */
async function runAttempt(
  repoRoot: string,
  c: EvalCase,
  log: (line: string) => void,
): Promise<AttemptFacts> {
  const ws = mkdtempSync(join(tmpdir(), "oc-eval-"));
  const prevWs = process.env["ONTOCOPILOT_WORKSPACE"];
  process.env["ONTOCOPILOT_WORKSPACE"] = ws;
  // startServer 读的是模块级的 root()，refreshRoot 在 lifespan 里做 —— 环境变量
  // 必须在 startServer 之前就位。
  const t0 = Date.now();
  const running = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${running.port}`;
  try {
    const sid = (
      (await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "work" }),
        })
      ).json()) as { id: string }
    ).id;

    for (const rel of c.materials) {
      const p = resolve(repoRoot, rel);
      const fd = new FormData();
      fd.append("files", new Blob([new Uint8Array(readFileSync(p))]), basename(p));
      const up = await fetch(`${base}/api/sessions/${sid}/files`, { method: "POST", body: fd });
      if (!up.ok) throw new Error(`上传失败 HTTP ${up.status}: ${await up.text()}`);
    }

    // 传完材料后台会算推荐问题（占租约）。build 有自己的 409 语义，直接重试到接受。
    const timeoutMs = (c.assertions.max_seconds ?? 600) * 1000;
    for (;;) {
      const r = await fetch(`${base}/api/sessions/${sid}/build`, { method: "POST" });
      if (r.ok) break;
      if (Date.now() - t0 > timeoutMs) throw new Error(`build 一直 ${r.status}，放弃`);
      await sleep(2_000);
    }

    let status = "?";
    let error = "";
    let oir: { objects?: unknown[]; actions?: unknown[]; questions?: unknown[] } = {};
    for (;;) {
      const st = (await (await fetch(`${base}/api/sessions/${sid}/state`)).json()) as Record<
        string,
        unknown
      >;
      status = String(st["status"] ?? "?");
      error = String(st["error"] ?? "");
      // 公开状态嵌在 `state` 键下（/state 顶层是会话元信息）。第一版读的是顶层，
      // 于是 oir/question_backlog 永远"缺席" —— dump 开关抓出来的。
      oir = ((st["state"] as Record<string, unknown> | undefined)?.["oir"] as typeof oir) ?? {};
      if (["done", "awaiting_answer", "failed", "stopped"].includes(status)) break;
      if (Date.now() - t0 > timeoutMs) {
        error = error || `评测超时（${timeoutMs / 1000}s）`;
        break;
      }
      await sleep(POLL_MS);
      log(`    …${status}`);
    }

    const usage = (await (await fetch(`${base}/api/usage?days=1`)).json()) as {
      total?: { usd_billed?: number };
    };

    // question_backlog 的形状历史上有两种（裸数组 / {questions: []}），都认。
    const st2 = (await (await fetch(`${base}/api/sessions/${sid}/state`)).json()) as Record<
      string,
      unknown
    >;
    const pub = (st2["state"] as Record<string, unknown> | undefined) ?? {};
    const rawBacklog = pub["question_backlog"];
    const backlogArr: Record<string, unknown>[] = Array.isArray(rawBacklog)
      ? (rawBacklog as Record<string, unknown>[])
      : Array.isArray((rawBacklog as Record<string, unknown> | null)?.["questions"])
        ? ((rawBacklog as Record<string, unknown>)["questions"] as Record<string, unknown>[])
        : [];
    const questionTexts = backlogArr
      .map((q) => String(q["text"] ?? q["title"] ?? q["question"] ?? ""))
      .filter(Boolean);

    if (process.env["OC_EVAL_DUMP"] === "1") {
      // 排障开关：打印 state 的顶层键与候选容器的形状，别靠猜
      const keys = Object.keys(st2).sort();
      log(`    [dump] state keys: ${keys.join(", ")}`);
      for (const k of ["question_backlog", "suggestions", "questions", "engagement"]) {
        const v = ((st2["state"] as Record<string, unknown> | undefined) ?? {})[k];
        log(`    [dump] ${k}: ${v === undefined ? "缺席" : JSON.stringify(v).slice(0, 200)}`);
      }
    }

    const names = ((oir.objects ?? []) as Record<string, unknown>[])
      .map((o) => String((o["name"] as string) ?? ""))
      .filter(Boolean);
    return {
      status,
      error,
      object_names: names,
      action_count: (oir.actions ?? []).length,
      question_count: (oir.questions ?? []).length,
      backlog_count: backlogArr.length,
      question_texts: questionTexts,
      usd: usage.total?.usd_billed ?? 0,
      seconds: (Date.now() - t0) / 1000,
    };
  } finally {
    await running.close();
    if (prevWs === undefined) delete process.env["ONTOCOPILOT_WORKSPACE"];
    else process.env["ONTOCOPILOT_WORKSPACE"] = prevWs;
    rmSync(ws, { recursive: true, force: true });
  }
}

export async function runEval(
  repoRoot: string,
  manifest: Manifest,
  opts: { k: number; only?: string | undefined; log?: (line: string) => void },
): Promise<EvalReport> {
  const log = opts.log ?? (() => {});
  const started = new Date().toISOString();
  const cases: CaseReport[] = [];

  for (const c of manifest.cases) {
    if (opts.only !== undefined && c.id !== opts.only) continue;
    log(`▶ ${c.id} — ${c.title}`);
    const attempts: AttemptReport[] = [];
    for (let i = 0; i < opts.k; i++) {
      log(`  尝试 ${i + 1}/${opts.k}`);
      let facts: AttemptFacts;
      try {
        facts = await runAttempt(repoRoot, c, log);
      } catch (e) {
        // 基础设施炸了也是一次失败的尝试 —— 评测衡量的就是"这条链路稳不稳"，
        // 起不来和跑错了对用户是同一件事。
        facts = {
          status: "infra_error",
          error: e instanceof Error ? e.message : String(e),
          object_names: [],
          action_count: 0,
          question_count: 0,
          backlog_count: 0,
          question_texts: [],
          usd: 0,
          seconds: 0,
        };
      }
      const outcomes = evaluateAttempt(c.assertions, facts);
      const pass = outcomes.every((o) => o.pass);
      attempts.push({ facts, outcomes, pass });
      for (const o of outcomes) log(`    ${o.pass ? "✓" : "✗"} ${o.name}: ${o.detail}`);
    }
    cases.push({
      id: c.id,
      title: c.title,
      attempts,
      pass: passPowK(attempts.map((a) => [...a.outcomes])),
    });
  }

  return {
    dataset_version: manifest.dataset_version,
    k: opts.k,
    started,
    cases,
    total_usd: cases.reduce(
      (s, c) => s + c.attempts.reduce((t, a) => t + a.facts.usd, 0),
      0,
    ),
    total_seconds: cases.reduce(
      (s, c) => s + c.attempts.reduce((t, a) => t + a.facts.seconds, 0),
      0,
    ),
    pass: cases.every((c) => c.pass),
  };
}

export function loadManifest(repoRoot: string): Manifest {
  return JSON.parse(readFileSync(join(repoRoot, "eval", "manifest.json"), "utf-8")) as Manifest;
}

export function writeReport(repoRoot: string, report: EvalReport): string {
  const dir = join(repoRoot, "eval", "reports");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${report.started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(p, JSON.stringify(report, null, 2) + "\n", "utf-8");
  return p;
}
