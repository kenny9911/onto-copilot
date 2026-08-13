/**
 * `store/repo/pg.ts` 与 Python `PgRepo` 的逐步对齐。
 *
 * **不手写期望值。** golden/store.repo.pg.json 是 `tools/golden/store_repo_pg.py`
 * 把真 PgRepo 跑一遍（SQLite 方言、TZ=UTC、临时库）录下来的 191 步返回值 + 全库
 * 快照。这个文件照同一个剧本跑 TS 侧的 PgRepo，逐步比对。
 *
 * 手写期望值在这个模块上尤其危险：三个租约的抢占真值表、计数器的发号与自愈、
 * save_state 家族的 CAS —— 这些"该返回 true 还是 false"读代码是推不出来的。
 */

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/kernel/ids.js";
import { Store } from "../src/store/engine.js";
import type { Conn, Engine } from "../src/store/engine.js";
import { TABLE_NAMES, TABLE_SPECS } from "../src/store/schema.js";
import { PgRepo, activeDecisionV1, tstzEpoch, tstzText } from "../src/store/repo/pg.js";
import { REPO_METHOD_NAMES } from "../src/store/repo/protocol.js";
import {
  makeAuthSessionRow,
  makeDecisionRecordRow,
  makeDecisionRow,
  makeFileRow,
  makeProjectMemoryRow,
  makeProjectRow,
  makeQuestionRow,
  makeRevisionRow,
  makeSessionRow,
  makeUsageRow,
  makeUserRow,
} from "../src/store/types.js";
import type { JsonObject } from "../src/store/types.js";

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../golden/store.repo.pg.json", import.meta.url)),
    "utf8",
  ),
) as {
  readonly steps: readonly { step: string; value?: unknown; error?: string; message?: string }[];
  readonly snapshot: Readonly<Record<string, readonly Record<string, unknown>[]>>;
};

// ══════════════════════════════════════════════════════════════════
//  归一化（与 tools/golden/store_repo_pg.py 里那两个函数同形）
// ══════════════════════════════════════════════════════════════════

const EVENT_KEYS = ["event_id", "kind", "payload", "seq", "ts"].join(",");

function dto(v: unknown): unknown {
  if (v === undefined) return null; // Python 的 None（`set_status` 这类无返回值）
  if (v instanceof Set) return [...v].sort();
  if (Array.isArray(v)) return v.map(dto);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = dto(x);
    return out;
  }
  return v;
}

function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = norm(x);
    if (Object.keys(out).sort().join(",") === EVENT_KEYS) out["ts"] = "<ts>";
    if ("finalizedAt" in out) out["finalizedAt"] = "<ts>";
    return out;
  }
  return v;
}

/** Python 的异常类型在 TS 侧没有对等物的那几步 —— **逐条列出来，不许静默放过**。
 *
 * `KeyError` 没有 JS 对等物（`str(KeyError("x"))` 还带一层 repr 引号），
 * （`validateUsageRow` 那条分叉已经修掉了 —— types.ts 现在抛 ValueError，
 * 与 Python 一致，所以它不在这张表里。）下面同时钉住 **Python 侧原本的形状**，
 * 哪天 Python 改了消息，这个测试照样红。 */
const ERROR_OVERRIDES: Record<
  string,
  { python: { error: string; message: string }; ts: { error: string; message: string } }
> = {
  "finalize_decision_v1/missing": {
    python: { error: "KeyError", message: "'没有 Decision d.zz'" },
    ts: { error: "Error", message: "没有 Decision d.zz" },
  },
  "finalize_revision/missing": {
    python: { error: "KeyError", message: "'没有 Revision rev.99'" },
    ts: { error: "Error", message: "没有 Revision rev.99" },
  },
};

// ══════════════════════════════════════════════════════════════════
//  全库快照（与 golden 脚本同一套换算）
// ══════════════════════════════════════════════════════════════════

const NONDET: Readonly<Record<string, readonly string[]>> = {
  session: ["updated_at"],
  session_file: ["uploaded_at"],
  session_state: ["updated_at"],
  decision: ["created_at"],
  run: ["started_at", "ended_at"],
  blob: ["created_at"],
  app_setting: ["updated_at"],
  llm_usage: ["created_at"],
  project: ["created_at", "updated_at"],
  project_memory: ["updated_at"],
  session_event: ["ts"],
};

function canon(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}

async function snapshot(conn: Conn): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of [...TABLE_NAMES].sort()) {
    const spec = TABLE_SPECS[name];
    const cols = Object.entries(spec.columns);
    const rows = await conn.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    const dumped = rows.map((r) => {
      const item: Record<string, unknown> = {};
      for (const [col, cs] of cols) {
        const v = r[col];
        if ((NONDET[name] ?? []).includes(col)) item[col] = v === null ? null : "<ts>";
        else if (v === null || v === undefined) item[col] = null;
        else if (cs.kind === "tstz") item[col] = tstzEpoch(v);
        else if (cs.kind === "json") item[col] = JSON.parse(String(v));
        else if (cs.kind === "bool") item[col] = Boolean(v);
        else if (cs.kind === "bytes") item[col] = `sha256:${sha256Hex(v as Uint8Array)}`;
        else if (cs.kind === "text") item[col] = String(v);
        else item[col] = Number(v);
      }
      return item;
    });
    // metadata 里的 finalizedAt 是 time.time() 落的，快照同样要归一化（同 golden 脚本）。
    const normed = dumped.map(norm);
    normed.sort((a, b) => (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0));
    out[name] = normed;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
//  剧本
// ══════════════════════════════════════════════════════════════════

const T0 = 1_700_000_000;

const CONFLICTS: JsonObject[] = [
  {
    rid: "c.b",
    kind: "duplicate",
    handling: "ask_user",
    summary: "两个同名实体",
    subjects: ["e.1", "e.2"],
    detector: "rule",
    owner: "u1",
    options: [{ id: "keep" }],
  },
  { rid: "c.a", kind: "gap", handling: "hint" },
  {
    rid: "c.c",
    kind: "caliber",
    handling: "round_trip",
    summary: "",
    subjects: [],
    detector: "llm",
    owner: null,
  },
];

interface Recorded {
  step: string;
  value?: unknown;
  error?: string;
  message?: string;
}

class Script {
  readonly steps: Recorded[] = [];

  async run<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const value = await fn();
      this.steps.push({ step: name, value: norm(dto(value)) });
      return value;
    } catch (e) {
      const err = e as Error;
      this.steps.push({ step: name, error: err.name, message: err.message });
      return null;
    }
  }
}

describe("store/repo/pg —— PgRepo 与 Python 原件逐步对齐", () => {
  it("191 步返回值 + 全库快照与 golden 一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-pg-"));
    const store = await Store.open(`sqlite+aiosqlite:///${join(dir, "golden.db")}`, {
      createAll: true,
    });
    const engine = store.engine;
    if (engine === null) throw new Error("引擎没建起来");
    const repo = new PgRepo(engine);
    const s = new Script();
    s.steps.push({ step: "mode", value: repo.mode });

    try {
      // ── 会话 ──────────────────────────────────────────────────
      await s.run("create_session/s1", () =>
        repo.createSession(
          makeSessionRow({ id: "s1", title: "第一个", project: "P", created: T0 + 0.5, owner: "u1" }),
        ),
      );
      await s.run("create_session/s2", () =>
        repo.createSession(makeSessionRow({ id: "s2", title: "第二个", created: T0 + 100 })),
      );
      await s.run("get_session/s1", () => repo.getSession("s1"));
      await s.run("get_session/missing", () => repo.getSession("zz"));
      await s.run("list_sessions/all", () => repo.listSessions());
      await s.run("list_sessions/owner", () => repo.listSessions({ owner: "u1" }));
      await s.run("list_sessions/empty_owner", () => repo.listSessions({ owner: "" }));
      await s.run("list_sessions/limit", () => repo.listSessions({ limit: 1 }));
      await s.run("rename_session/hit", () => repo.renameSession("s1", "改过名"));
      await s.run("rename_session/miss", () => repo.renameSession("zz", "x"));
      await s.run("set_status/s2", () => repo.setStatus("s2", "failed", { error: "boom" }));
      await s.run("get_session/s2", () => repo.getSession("s2"));
      await s.run("claim_session_status/ok", () =>
        repo.claimSessionStatus("s2", { fromStatuses: ["failed", "failed"], toStatus: "idle" }),
      );
      await s.run("claim_session_status/again", () =>
        repo.claimSessionStatus("s2", { fromStatuses: ["failed"], toStatus: "idle" }),
      );
      await s.run("claim_session_status/empty", () =>
        repo.claimSessionStatus("s2", { fromStatuses: [], toStatus: "idle" }),
      );

      // ── 文件 ──────────────────────────────────────────────────
      await s.run("add_files", () =>
        repo.addFiles("s1", [
          makeFileRow({ name: "b.xlsx", rel_path: "s1/b.xlsx", size: 12, sha256: "bb" }),
          makeFileRow({ name: "a.pdf", rel_path: "s1/a.pdf", size: 34, sha256: "aa" }),
        ]),
      );
      await s.run("add_files/upsert", () =>
        repo.addFiles("s1", [
          makeFileRow({ name: "a.pdf", rel_path: "s1/a2.pdf", size: 99, sha256: "a2" }),
        ]),
      );
      await s.run("list_files", () => repo.listFiles("s1"));
      await s.run("remove_file/hit", () => repo.removeFile("s1", "b.xlsx"));
      await s.run("remove_file/miss", () => repo.removeFile("s1", "b.xlsx"));

      // ── 归属改判 ──────────────────────────────────────────────
      await s.run("reassign_sessions/empty", () => repo.reassignSessions("", "u2"));
      await s.run("reassign_sessions/named", () => repo.reassignSessions("u2", "u3"));
      await s.run("get_session/s2/after", () => repo.getSession("s2"));

      // ── 状态与冲突 ────────────────────────────────────────────
      await s.run("save_state/first", () =>
        repo.saveState(
          "s1",
          { oir: { entities: [1, 2] }, budget: { spent: 3 } },
          { conflicts: CONFLICTS, askedRids: ["c.c", "c.b"] },
        ),
      );
      await s.run("load_state/all", () => repo.loadState("s1"));
      await s.run("load_state/keys", () => repo.loadState("s1", { keys: ["oir"] }));
      await s.run("load_state/empty_keys", () => repo.loadState("s1", { keys: [] }));
      await s.run("load_state/no_derived", () => repo.loadState("s1", { includeDerived: false }));
      await s.run("list_conflicts", () => repo.listConflicts("s1"));
      await s.run("get_conflict/hit", () => repo.getConflict("s1", "c.a"));
      await s.run("get_conflict/miss", () => repo.getConflict("s1", "zz"));
      await s.run("save_state/cas_stale", () =>
        repo.saveState("s1", { oir: { entities: [] } }, { expectedVersion: 0 }),
      );
      await s.run("load_state/after_stale", () => repo.loadState("s1", { keys: ["oir"] }));
      await s.run("save_state/cas_ok", () =>
        repo.saveState("s1", { oir: { entities: [7] } }, { expectedVersion: 1 }),
      );
      await s.run("list_conflicts/after_cas", () => repo.listConflicts("s1"));
      await s.run("save_state/clear_conflicts", () => repo.saveState("s1", {}, { conflicts: [] }));
      await s.run("list_conflicts/cleared", () => repo.listConflicts("s1"));

      // ── build 租约 ────────────────────────────────────────────
      await s.run("claim_build_lease/ok", () =>
        repo.claimBuildLease("s1", {
          owner: "b1",
          now: T0,
          ttl: 60,
          fromStatuses: ["idle"],
          toStatus: "queued",
        }),
      );
      await s.run("claim_build_lease/taken", () =>
        repo.claimBuildLease("s1", {
          owner: "b2",
          now: T0,
          ttl: 60,
          fromStatuses: ["idle", "queued"],
        }),
      );
      await s.run("renew_build_lease/ok", () =>
        repo.renewBuildLease("s1", { owner: "b1", now: T0 + 1, ttl: 60 }),
      );
      await s.run("renew_build_lease/other", () =>
        repo.renewBuildLease("s1", { owner: "b2", now: T0 + 1, ttl: 60 }),
      );
      await s.run("set_build_status/ok", () =>
        repo.setBuildStatus("s1", { owner: "b1", now: T0 + 2, status: "parsing" }),
      );
      await s.run("set_build_status/other", () =>
        repo.setBuildStatus("s1", { owner: "b2", now: T0 + 2, status: "done" }),
      );
      await s.run("save_build_state/ok", () =>
        repo.saveBuildState(
          "s1",
          { flow: { steps: 2 } },
          {
            owner: "b1",
            now: T0 + 3,
            status: "extracting",
            conflicts: [CONFLICTS[1]!],
            askedRids: ["c.a"],
          },
        ),
      );
      await s.run("save_build_state/other", () =>
        repo.saveBuildState("s1", { flow: {} }, { owner: "b2", now: T0 + 3, status: "done" }),
      );
      await s.run("request_build_cancel/ok", () => repo.requestBuildCancel("s1", { now: T0 + 4 }));
      await s.run("request_build_cancel/again", () =>
        repo.requestBuildCancel("s1", { now: T0 + 4 }),
      );
      await s.run("renew_build_lease/cancelled", () =>
        repo.renewBuildLease("s1", { owner: "b1", now: T0 + 5, ttl: 60 }),
      );
      await s.run("release_build_lease/ok", () => repo.releaseBuildLease("s1", { owner: "b1" }));
      await s.run("release_build_lease/again", () => repo.releaseBuildLease("s1", { owner: "b1" }));

      await s.run("set_status/idle", () => repo.setStatus("s1", "idle", { error: "" }));
      await s.run("claim_build_lease/short", () =>
        repo.claimBuildLease("s1", {
          owner: "b3",
          now: T0 + 10,
          ttl: 1,
          fromStatuses: ["idle"],
          toStatus: "queued",
        }),
      );
      await s.run("reap_expired_build_lease/live", () =>
        repo.reapExpiredBuildLease("s1", { now: T0 + 10.5, error: "太久没心跳" }),
      );
      await s.run("reap_expired_build_lease/expired", () =>
        repo.reapExpiredBuildLease("s1", { now: T0 + 100, error: "太久没心跳" }),
      );
      await s.run("get_session/after_reap", () => repo.getSession("s1"));
      await s.run("reap_expired_build_lease/done", () =>
        repo.reapExpiredBuildLease("s1", { now: T0 + 200, error: "x" }),
      );

      // ── chat 租约 ─────────────────────────────────────────────
      await s.run("claim_chat_lease/ok", () =>
        repo.claimChatLease("s1", { owner: "c1", now: T0, ttl: 30 }),
      );
      await s.run("claim_chat_lease/taken", () =>
        repo.claimChatLease("s1", { owner: "c2", now: T0, ttl: 30 }),
      );
      await s.run("claim_chat_lease/missing_session", () =>
        repo.claimChatLease("zz", { owner: "c1", now: T0, ttl: 30 }),
      );
      await s.run("renew_chat_lease/ok", () =>
        repo.renewChatLease("s1", { owner: "c1", now: T0 + 1, ttl: 30 }),
      );
      await s.run("renew_chat_lease/other", () =>
        repo.renewChatLease("s1", { owner: "c2", now: T0 + 1, ttl: 30 }),
      );
      await s.run("save_chat_state/ok", () =>
        repo.saveChatState("s1", { dialogue: { turns: 1 } }, { owner: "c1", now: T0 + 2 }),
      );
      await s.run("save_chat_state/other", () =>
        repo.saveChatState("s1", { dialogue: {} }, { owner: "c2", now: T0 + 2 }),
      );
      await s.run("request_chat_cancel/ok", () => repo.requestChatCancel("s1", { now: T0 + 3 }));
      await s.run("request_chat_cancel/again", () => repo.requestChatCancel("s1", { now: T0 + 3 }));
      await s.run("renew_chat_lease/cancelled", () =>
        repo.renewChatLease("s1", { owner: "c1", now: T0 + 4, ttl: 30 }),
      );
      await s.run("release_chat_lease/ok", () => repo.releaseChatLease("s1", { owner: "c1" }));

      // ── mutation 租约 ─────────────────────────────────────────
      await s.run("claim_mutation_lease/ok", () =>
        repo.claimMutationLease("s1", { owner: "m1", kind: "edit", now: T0, ttl: 30 }),
      );
      await s.run("claim_mutation_lease/taken", () =>
        repo.claimMutationLease("s1", { owner: "m2", kind: "edit", now: T0, ttl: 30 }),
      );
      await s.run("renew_mutation_lease/ok", () =>
        repo.renewMutationLease("s1", { owner: "m1", now: T0 + 1, ttl: 30 }),
      );
      await s.run("renew_mutation_lease/other", () =>
        repo.renewMutationLease("s1", { owner: "m2", now: T0 + 1, ttl: 30 }),
      );
      await s.run("save_mutation_state/ok", () =>
        repo.saveMutationState(
          "s1",
          { oir: { entities: [9] } },
          { owner: "m1", now: T0 + 2, status: "done" },
        ),
      );
      await s.run("save_mutation_state/other", () =>
        repo.saveMutationState("s1", { oir: {} }, { owner: "m2", now: T0 + 2, status: "done" }),
      );
      await s.run("claim_build_lease/blocked_by_mutation", () =>
        repo.claimBuildLease("s1", {
          owner: "b9",
          now: T0 + 2,
          ttl: 60,
          fromStatuses: ["done", "idle"],
        }),
      );
      await s.run("release_mutation_lease/ok", () =>
        repo.releaseMutationLease("s1", { owner: "m1" }),
      );
      await s.run("release_mutation_lease/again", () =>
        repo.releaseMutationLease("s1", { owner: "m1" }),
      );

      // ── 人的决定（legacy）─────────────────────────────────────
      await s.run("record_decision/naming", () =>
        repo.recordDecision(
          "s1",
          makeDecisionRow({
            ordinal: -1,
            kind: "naming",
            statement: "叫客户",
            scope_refs: ["e.1"],
            ts: T0 + 20,
          }),
        ),
      );
      await s.run("record_decision/naming_again", () =>
        repo.recordDecision(
          "s1",
          makeDecisionRow({
            ordinal: -1,
            kind: "naming",
            statement: "改叫甲方",
            scope_refs: ["e.1"],
            ts: T0 + 21,
          }),
        ),
      );
      await s.run("record_decision/other_scope", () =>
        repo.recordDecision(
          "s1",
          makeDecisionRow({
            ordinal: -1,
            kind: "naming",
            statement: "别的",
            scope_refs: ["e.2"],
            ts: T0 + 22,
          }),
        ),
      );
      await s.run("record_decision/answer", () =>
        repo.recordDecision(
          "s1",
          makeDecisionRow({
            ordinal: -1,
            kind: "answer",
            target_rid: "c.a",
            option_id: "keep",
            ts: T0 + 23,
          }),
        ),
      );
      await s.run("record_decision/answer_again", () =>
        repo.recordDecision(
          "s1",
          makeDecisionRow({
            ordinal: -1,
            kind: "answer",
            target_rid: "c.a",
            option_id: "drop",
            ts: T0 + 24,
          }),
        ),
      );
      await s.run("list_decisions/all", () => repo.listDecisions("s1"));
      await s.run("list_decisions/active", () => repo.listDecisions("s1", { activeOnly: true }));
      await s.run("answered_rids", () => repo.answeredRids("s1"));

      // ── Question v1 ───────────────────────────────────────────
      const q1 = makeQuestionRow({
        id: "q.1",
        text: "主体是谁？",
        status: "open",
        priority: "blocking",
        dependencies: ["q.0"],
        source_kind: "conflict",
        source_ref: "c.a",
        doc: { id: "q.1", text: "主体是谁？", version: 0 },
        version: 0,
        created: T0 + 30,
        updated: T0 + 30,
      });
      const q2 = makeQuestionRow({
        id: "q.2",
        text: "口径按月还是按年？",
        doc: { id: "q.2", version: 0 },
        created: T0 + 31,
        updated: T0 + 31,
      });
      await s.run("upsert_questions", () => repo.upsertQuestions("s1", [q1, q2]));
      await s.run("list_questions/all", () => repo.listQuestions("s1"));
      await s.run("list_questions/status", () => repo.listQuestions("s1", { statuses: ["open"] }));
      await s.run("list_questions/none", () => repo.listQuestions("s1", { statuses: [] }));
      await s.run("get_question/hit", () => repo.getQuestion("s1", "q.1"));
      await s.run("get_question/miss", () => repo.getQuestion("s1", "zz"));
      await s.run("save_question/insert", () =>
        repo.saveQuestion(
          "s1",
          makeQuestionRow({
            id: "q.3",
            text: "新问题",
            doc: { id: "q.3", version: 0 },
            created: T0 + 32,
            updated: T0 + 32,
          }),
        ),
      );
      await s.run("save_question/cas_ok", () =>
        repo.saveQuestion(
          "s1",
          makeQuestionRow({
            id: "q.1",
            text: "主体是谁？",
            status: "answered",
            doc: { id: "q.1", text: "主体是谁？", version: 0 },
            version: 0,
            created: T0 + 30,
            updated: T0 + 33,
          }),
          { expectedVersion: 0 },
        ),
      );
      await s.run("save_question/cas_stale", () =>
        repo.saveQuestion(
          "s1",
          makeQuestionRow({
            id: "q.1",
            text: "x",
            doc: { id: "q.1", version: 0 },
            version: 0,
            created: T0 + 30,
            updated: T0 + 34,
          }),
          { expectedVersion: 0 },
        ),
      );
      await s.run("get_question/after_cas", () => repo.getQuestion("s1", "q.1"));

      // ── Decision v1 ───────────────────────────────────────────
      await s.run("record_decision_v1/new", () =>
        repo.recordDecisionV1(
          "s1",
          makeDecisionRecordRow({
            id: "d.1",
            question_id: "q.1",
            answer: { value: "甲方" },
            actor: "user",
            actor_role: "owner",
            authority: "final",
            idempotency_key: "k1",
            semantic_hash: "h1",
            created: T0 + 40,
          }),
        ),
      );
      await s.run("record_decision_v1/same_key", () =>
        repo.recordDecisionV1(
          "s1",
          makeDecisionRecordRow({
            id: "d.1b",
            question_id: "q.1",
            answer: { value: "甲方" },
            actor: "user",
            idempotency_key: "k1",
            semantic_hash: "h1",
            created: T0 + 41,
          }),
        ),
      );
      await s.run("record_decision_v1/key_clash", () =>
        repo.recordDecisionV1(
          "s1",
          makeDecisionRecordRow({
            id: "d.1c",
            question_id: "q.1",
            answer: { value: "别的" },
            actor: "user",
            idempotency_key: "k1",
            semantic_hash: "h9",
            created: T0 + 42,
          }),
        ),
      );
      await s.run("record_decision_v1/no_key", () =>
        repo.recordDecisionV1(
          "s1",
          makeDecisionRecordRow({ id: "d.x", question_id: "q.1", answer: null, actor: "user" }),
        ),
      );
      await s.run("record_decision_v1/supersede", () =>
        repo.recordDecisionV1(
          "s1",
          makeDecisionRecordRow({
            id: "d.2",
            question_id: "q.1",
            answer: { value: "乙方" },
            actor: "user",
            idempotency_key: "k2",
            semantic_hash: "h2",
            created: T0 + 43,
          }),
        ),
      );
      await s.run("finalize_decision_v1/applied", () =>
        repo.finalizeDecisionV1("s1", "d.2", { status: "applied" }),
      );
      await s.run("finalize_decision_v1/conflict", () =>
        repo.finalizeDecisionV1("s1", "d.2", { status: "failed", error: "炸了" }),
      );
      await s.run("finalize_decision_v1/bad_status", () =>
        repo.finalizeDecisionV1("s1", "d.2", { status: "weird" }),
      );
      await s.run("finalize_decision_v1/missing", () =>
        repo.finalizeDecisionV1("s1", "d.zz", { status: "applied" }),
      );
      await s.run("list_decisions_v1", () => repo.listDecisionsV1("s1"));

      // ── Revision ──────────────────────────────────────────────
      await s.run("record_revision/new", () =>
        repo.recordRevision(
          "s1",
          makeRevisionRow({
            id: "rev.0",
            ordinal: 0,
            parent_id: null,
            kind: "edit",
            status: "proposed",
            doc: { id: "rev.0", ordinal: 0 },
            idempotency_key: "r0",
            created: T0 + 50,
          }),
        ),
      );
      await s.run("record_revision/same_key", () =>
        repo.recordRevision(
          "s1",
          makeRevisionRow({
            id: "rev.0",
            ordinal: 0,
            parent_id: null,
            kind: "edit",
            status: "proposed",
            doc: { id: "rev.0", ordinal: 0 },
            idempotency_key: "r0",
            created: T0 + 51,
          }),
        ),
      );
      await s.run("record_revision/key_clash", () =>
        repo.recordRevision(
          "s1",
          makeRevisionRow({
            id: "rev.0b",
            ordinal: 0,
            parent_id: null,
            kind: "edit",
            status: "proposed",
            doc: { id: "rev.0b" },
            idempotency_key: "r0",
            created: T0 + 52,
          }),
        ),
      );
      await s.run("append_revision/first", () =>
        repo.appendRevision(
          "s1",
          makeRevisionRow({
            id: "ignored",
            ordinal: -1,
            parent_id: "ignored",
            kind: "edit",
            status: "proposed",
            doc: { kind: "edit", id: "ignored" },
            changed_ids: ["e.1"],
            idempotency_key: "ra",
            created: T0 + 53,
          }),
        ),
      );
      await s.run("append_revision/second", () =>
        repo.appendRevision(
          "s1",
          makeRevisionRow({
            id: "ignored",
            ordinal: -1,
            parent_id: null,
            kind: "edit",
            status: "proposed",
            doc: { kind: "edit" },
            idempotency_key: "rb",
            created: T0 + 54,
          }),
        ),
      );
      await s.run("append_revision/idempotent", () =>
        repo.appendRevision(
          "s1",
          makeRevisionRow({
            id: "ignored",
            ordinal: -1,
            parent_id: null,
            kind: "edit",
            status: "proposed",
            doc: { kind: "edit" },
            idempotency_key: "rb",
            created: T0 + 55,
          }),
        ),
      );
      await s.run("finalize_revision/applied", () =>
        repo.finalizeRevision("s1", "rev.1", { status: "applied" }),
      );
      await s.run("finalize_revision/retry", () =>
        repo.finalizeRevision("s1", "rev.1", { status: "applied" }),
      );
      await s.run("finalize_revision/conflict", () =>
        repo.finalizeRevision("s1", "rev.1", { status: "rejected" }),
      );
      await s.run("finalize_revision/bad", () =>
        repo.finalizeRevision("s1", "rev.1", { status: "weird" }),
      );
      await s.run("finalize_revision/missing", () =>
        repo.finalizeRevision("s1", "rev.99", { status: "applied" }),
      );
      await s.run("list_revisions", () => repo.listRevisions("s1"));

      // ── 事件 ──────────────────────────────────────────────────
      await s.run("append_event/1", () => repo.appendEvent("s1", "chat.delta", { text: "你好" }));
      await s.run("append_event/2", () => repo.appendEvent("s1", "chat.done", { ok: true }));
      await s.run("append_event/idem", () =>
        repo.appendEvent("s1", "chat.delta", { text: "重" }, { eventId: "e-1" }),
      );
      await s.run("append_event/idem_retry", () =>
        repo.appendEvent("s1", "chat.delta", { text: "不一样" }, { eventId: "e-1" }),
      );
      await s.run("append_event/big", () =>
        repo.appendEvent("s1", "node.completed", { blob: "汉".repeat(20000) }),
      );
      await s.run("read_events/all", () => repo.readEvents("s1"));
      await s.run("read_events/since", () => repo.readEvents("s1", { since: 3 }));
      await s.run("count_events", () => repo.countEvents("s1"));

      // ── Run ───────────────────────────────────────────────────
      const r1 = await s.run("next_run/1", () => repo.nextRun("s1", "build"));
      await s.run("next_run/2", () => repo.nextRun("s1", "chat"));
      await s.run("finish_run", () =>
        repo.finishRun(r1!, { status: "done", budget: { usd: 0.5 } }),
      );

      // ── 账号 ──────────────────────────────────────────────────
      await s.run("create_user/admin", () =>
        repo.createUser(
          makeUserRow({
            id: "u1",
            username: "admin",
            password_hash: "scrypt$x",
            role: "admin",
            prefs: { theme: "dark" },
            created: T0 + 60,
            display_name: "管理员",
          }),
        ),
      );
      await s.run("create_user/plain", () =>
        repo.createUser(
          makeUserRow({ id: "u2", username: "bob", password_hash: "scrypt$y", created: T0 + 61 }),
        ),
      );
      await s.run("create_user/dup", () =>
        repo.createUser(
          makeUserRow({ id: "u3", username: "bob", password_hash: "scrypt$z", created: T0 + 62 }),
        ),
      );
      await s.run("get_user/hit", () => repo.getUser("u1"));
      await s.run("get_user/miss", () => repo.getUser("zz"));
      await s.run("get_user_by_username", () => repo.getUserByUsername("bob"));
      await s.run("list_users", () => repo.listUsers());
      await s.run("count_users", () => repo.countUsers());
      await s.run("update_user/partial", () =>
        repo.updateUser("u2", { role: "admin", active: false }),
      );
      await s.run("update_user/noop", () => repo.updateUser("u2"));
      await s.run("update_user/missing", () => repo.updateUser("zz", { role: "admin" }));

      // ── 登录会话 ──────────────────────────────────────────────
      await s.run("create_auth_session", () =>
        repo.createAuthSession(
          makeAuthSessionRow({
            token_hash: "t1",
            user_id: "u1",
            created: T0 + 70,
            last_seen: 0,
            expires: T0 + 3600,
          }),
        ),
      );
      await s.run("create_auth_session/expired", () =>
        repo.createAuthSession(
          makeAuthSessionRow({
            token_hash: "t2",
            user_id: "u2",
            created: T0 + 71,
            last_seen: T0 + 71,
            expires: T0 + 72,
          }),
        ),
      );
      await s.run("get_auth_session/hit", () => repo.getAuthSession("t1"));
      await s.run("get_auth_session/miss", () => repo.getAuthSession("zz"));
      await s.run("prune_auth_sessions", () => repo.pruneAuthSessions({ now: T0 + 100 }));
      await s.run("delete_auth_session/hit", () => repo.deleteAuthSession("t1"));
      await s.run("delete_auth_session/miss", () => repo.deleteAuthSession("t1"));
      await s.run("create_auth_session/again", () =>
        repo.createAuthSession(
          makeAuthSessionRow({
            token_hash: "t3",
            user_id: "u2",
            created: T0 + 80,
            last_seen: T0 + 80,
            expires: T0 + 9999,
          }),
        ),
      );
      await s.run("delete_user_auth_sessions", () => repo.deleteUserAuthSessions("u2"));
      await s.run("delete_user/hit", () => repo.deleteUser("u2"));
      await s.run("delete_user/miss", () => repo.deleteUser("u2"));

      // ── 用量 ──────────────────────────────────────────────────
      await s.run("add_usage/1", () =>
        repo.addUsage(
          makeUsageRow({
            id: "usage.1",
            ts: T0 + 90,
            day: "2023-11-14",
            model: "gpt-5",
            owner: "u1",
            session_id: "s1",
            run_id: "s1.0",
            node_id: "EXTRACT",
            kind: "build",
            effort: "high",
            tok_in: 1000,
            tok_out: 200,
            cache_read: 30,
            cache_write: 4,
            usd: 0.125,
            usd_source: "gateway",
            attempts: 2,
            status: "ok",
          }),
        ),
      );
      await s.run("add_usage/2", () =>
        repo.addUsage(
          makeUsageRow({
            id: "usage.2",
            ts: T0 + 91,
            day: "2023-11-14",
            model: "haiku",
            kind: "chat",
          }),
        ),
      );
      await s.run("add_usage/bad", () =>
        repo.addUsage(
          makeUsageRow({
            id: "usage.3",
            ts: T0 + 92,
            day: "2023-11-14",
            model: "x",
            attempts: 0,
          }),
        ),
      );
      await s.run("usage_since/all", () => repo.usageSince(0));
      await s.run("usage_since/owner", () => repo.usageSince(0, { owner: "u1" }));
      await s.run("usage_since/no_owner", () => repo.usageSince(0, { owner: "" }));
      await s.run("usage_since/window", () => repo.usageSince(T0 + 91));
      await s.run("usage_since/limit0", () => repo.usageSince(0, { limit: 0 }));

      // ── 项目 ──────────────────────────────────────────────────
      await s.run("create_project/1", () =>
        repo.createProject(makeProjectRow({ id: "p1", name: "甲项目", owner: "u1", sort_order: 1 })),
      );
      await s.run("create_project/2", () =>
        repo.createProject(makeProjectRow({ id: "p2", name: "乙项目", sort_order: 0 })),
      );
      await s.run("list_projects/all", () => repo.listProjects());
      await s.run("list_projects/owner", () => repo.listProjects({ owner: "u1" }));
      await s.run("get_project/hit", () => repo.getProject("p1"));
      await s.run("get_project/miss", () => repo.getProject("zz"));
      await s.run("rename_project/hit", () => repo.renameProject("p1", "甲项目改"));
      await s.run("rename_project/miss", () => repo.renameProject("zz", "x"));
      await s.run("reassign_projects/empty", () => repo.reassignProjects("", "u9"));
      await s.run("assign_session/set", () => repo.assignSession("s1", "p1"));
      await s.run("assign_session/clear", () => repo.assignSession("s2", ""));
      await s.run("assign_session/miss", () => repo.assignSession("zz", "p1"));
      await s.run("get_session/assigned", () => repo.getSession("s1"));
      await s.run("upsert_project_memory", () =>
        repo.upsertProjectMemory([
          makeProjectMemoryRow({
            project_id: "p1",
            key: "naming:客户",
            tier: "authoritative",
            kind: "naming",
            content: "统一叫甲方",
            confidence: 0.9,
            support: ["f1"],
            tags: ["naming"],
            origin_session: "s1",
            origin_files: ["a.pdf"],
            use_count: 2,
            created_run: "s1.0",
            last_used_run: "s1.1",
          }),
          makeProjectMemoryRow({
            project_id: "p1",
            key: "caliber:月",
            tier: "reference",
            kind: "caliber",
            content: "按自然月",
          }),
        ]),
      );
      await s.run("upsert_project_memory/empty", () => repo.upsertProjectMemory([]));
      await s.run("list_project_memory", () => repo.listProjectMemory("p1"));
      await s.run("delete_project_memory/keys", () =>
        repo.deleteProjectMemory("p1", { keys: ["caliber:月"] }),
      );
      await s.run("delete_project_memory/empty", () => repo.deleteProjectMemory("p1", { keys: [] }));
      await s.run("list_project_memory/after", () => repo.listProjectMemory("p1"));
      await s.run("delete_project/p1", () => repo.deleteProject("p1"));
      await s.run("get_session/released", () => repo.getSession("s1"));
      await s.run("list_project_memory/gone", () => repo.listProjectMemory("p1"));

      // ── 设置 ──────────────────────────────────────────────────
      await s.run("set_setting/new", () => repo.setSetting("gateway", { url: "https://x" }));
      await s.run("set_setting/update", () => repo.setSetting("gateway", { url: "https://y" }));
      await s.run("set_setting/scalar", () => repo.setSetting("budget", 12.5));
      await s.run("get_setting/hit", () => repo.getSetting("gateway"));
      await s.run("get_setting/miss", () => repo.getSetting("zz"));
      await s.run("list_settings", () => repo.listSettings());
      await s.run("delete_setting/hit", () => repo.deleteSetting("budget"));
      await s.run("delete_setting/miss", () => repo.deleteSetting("budget"));

      // ── 收尾 ──────────────────────────────────────────────────
      await s.run("delete_session/hit", () => repo.deleteSession("s2"));
      await s.run("delete_session/miss", () => repo.deleteSession("s2"));
      await s.run("count_events/after_delete", () => repo.countEvents("s2"));

      // ── 比对 ──────────────────────────────────────────────────
      expect(s.steps.map((x) => x.step)).toEqual(GOLDEN.steps.map((x) => x.step));
      for (const [i, actual] of s.steps.entries()) {
        const golden = GOLDEN.steps[i]!;
        const ov = ERROR_OVERRIDES[actual.step];
        if (ov !== undefined) {
          // Python 原本的形状也钉住：它变了这里也要红，不能靠 override 把差异盖掉。
          expect({ error: golden.error, message: golden.message }).toEqual(ov.python);
          expect(actual).toEqual({ step: actual.step, ...ov.ts });
          continue;
        }
        expect(actual, `第 ${i} 步 ${actual.step}`).toEqual(golden);
      }

      const snap = await engine.connect(async (conn) => snapshot(conn));
      expect(Object.keys(snap).sort()).toEqual(Object.keys(GOLDEN.snapshot).sort());
      for (const name of Object.keys(snap)) {
        expect(snap[name], `表 ${name}`).toEqual(GOLDEN.snapshot[name]);
      }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════
//  TS 侧独有的风险面（Python 覆盖不到的）
// ══════════════════════════════════════════════════════════════════

describe("tstz 编解码", () => {
  it("写出来的文本与 SQLAlchemy 在 SQLite 上的格式逐字相同", () => {
    // 实测值：TZ=Asia/Shanghai 下 datetime.fromtimestamp(1700000000.5, UTC) 落库成这个。
    expect(tstzText(1_700_000_000.5)).toBe("2023-11-14 22:13:20.500000");
    expect(tstzText(0)).toBe("1970-01-01 00:00:00.000000");
    // 微秒不过 Date（毫秒精度）才留得住 —— time.time() 给的就是微秒。
    expect(tstzText(1_700_000_000.000001)).toBe("2023-11-14 22:13:20.000001");
  });

  it("读回来按 UTC 解释，且吃得下没有小数位的 CURRENT_TIMESTAMP", () => {
    expect(tstzEpoch("2023-11-14 22:13:20.500000")).toBe(1_700_000_000.5);
    expect(tstzEpoch("2023-11-14 22:13:20")).toBe(1_700_000_000);
    // 小数位不足 6 位要右补零，不是当整数读。
    expect(tstzEpoch("2023-11-14 22:13:20.5")).toBe(1_700_000_000.5);
    expect(tstzEpoch("2023-11-14T22:13:20.500000Z")).toBe(1_700_000_000.5);
    expect(tstzEpoch(null)).toBe(0);
    expect(() => tstzEpoch("昨天")).toThrow();
  });

  it("往返不丢精度（微秒级）", () => {
    for (const sec of [1, 1_700_000_000.123456, 1_899_999_999.999999]) {
      expect(tstzEpoch(tstzText(sec))).toBeCloseTo(sec, 6);
    }
  });
});

describe("activeDecisionV1", () => {
  const mk = (id: string, sup: string | null, status?: string) =>
    makeDecisionRecordRow({
      id,
      question_id: "q.1",
      answer: null,
      actor: "user",
      supersedes: sup,
      metadata: status === undefined ? {} : { status },
    });

  it("取最后一条没被 supersedes 指向的", () => {
    const rows = [mk("a", null), mk("b", "a")];
    expect(activeDecisionV1(rows, "q.1")?.id).toBe("b");
  });

  it("failed 既不能当 active，也不能靠 supersedes 把上一条拿掉", () => {
    const rows = [mk("a", null), mk("b", "a", "failed")];
    expect(activeDecisionV1(rows, "q.1")?.id).toBe("a");
  });

  it("问题对不上就没有 active", () => {
    expect(activeDecisionV1([mk("a", null)], "q.9")).toBeNull();
  });
});

describe("接口完整性与事务作用域", () => {
  it("79 个方法一个不少（清单来自 protocol.ts，不是手抄）", () => {
    // 一个"一用就报错"的假引擎：这条用例只看方法表，不该碰库。
    const fake: Engine = {
      dialect: "sqlite",
      connect: () => Promise.reject(new Error("不该连库")),
      begin: () => Promise.reject(new Error("不该连库")),
      dispose: () => Promise.resolve(),
    };
    const repo = new PgRepo(fake);
    for (const name of REPO_METHOD_NAMES) {
      expect(typeof (repo as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(REPO_METHOD_NAMES.length).toBe(79);
    expect(repo.mode).toBe("sqlite");
  });

  it("atomic：正常提交、抛出回滚", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-pg-atomic-"));
    const store = await Store.open(`sqlite+aiosqlite:///${join(dir, "a.db")}`, { createAll: true });
    const engine = store.engine!;
    const repo = new PgRepo(engine);
    try {
      await repo.createSession(makeSessionRow({ id: "s1", created: T0 }));
      await repo.atomic(async (scope) => {
        const conn = scope as Conn;
        await conn.exec(`UPDATE "session" SET title = 'committed' WHERE id = 's1'`);
      });
      expect((await repo.getSession("s1"))?.title).toBe("committed");

      await expect(
        repo.atomic(async (scope) => {
          const conn = scope as Conn;
          await conn.exec(`UPDATE "session" SET title = 'rolled back' WHERE id = 's1'`);
          throw new Error("半路炸了");
        }),
      ).rejects.toThrow("半路炸了");
      expect((await repo.getSession("s1"))?.title).toBe("committed");
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendEvent：计数器落在已提交行后面时从表里的真实最大值兜底并自愈", async () => {
    // 这是 Python 注释里记下的真实事故（StaticPool 把 next_event_seq 搅回去过）：
    // 不兜底的话分配出来的 seq 会撞 UNIQUE，重试永远撞同一个号，这个会话再也写不进
    // 任何事件 —— 界面上表现为"消息要刷新才出现"。
    const dir = mkdtempSync(join(tmpdir(), "repo-pg-seq-"));
    const store = await Store.open(`sqlite+aiosqlite:///${join(dir, "a.db")}`, { createAll: true });
    const engine = store.engine!;
    const repo = new PgRepo(engine);
    try {
      await repo.createSession(makeSessionRow({ id: "s1", created: T0 }));
      await repo.appendEvent("s1", "a", {});
      await repo.appendEvent("s1", "b", {});
      // 人为把计数器搅回去
      await engine.begin(async (conn) =>
        conn.exec(`UPDATE "session" SET next_event_seq = 0 WHERE id = 's1'`),
      );
      const ev = await repo.appendEvent("s1", "c", {});
      expect(ev.seq).toBe(2);
      const nxt = await engine.connect(async (conn) =>
        conn.scalar(`SELECT next_event_seq FROM "session" WHERE id = 's1'`),
      );
      expect(Number(nxt)).toBe(3); // 计数器被修回来了
      expect((await repo.readEvents("s1")).map((e) => e.seq)).toEqual([0, 1, 2]);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
