/**
 * 材料上传 / 撤回 —— 移植自 `server.py` 的 1398–1596 行。
 *
 * 覆盖 `POST /api/sessions/{sid}/files` 与 `DELETE /api/sessions/{sid}/files/{name}`。
 *
 * 两条路都在 mutation 租约里跑，且都要在**文件系统与 repo 两个权威存储**之间
 * 保持一致：文件系统没有多文件事务，所以用"旧版本先原子移到 backup，全部成功
 * 才删 backup，任何一步失败按逆序恢复"这一套。
 */

import type { Context, Hono } from "hono";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { sha256Hex } from "../../kernel/ids.js";
import { openingPrompts } from "../../onto/prompts.js";
import { makeFileRow } from "../../store/types.js";
import type { AppEnv } from "../app.js";
import { invalidateMaterialCaches } from "../glue/preparse.js";
import { materialFileList } from "../material_status.js";
import { currentRepo, sessAsync } from "../session.js";
import type { Session, SessionFile } from "../session.js";
import {
  apiError,
  autoTitle,
  baseName,
  engagementView,
  fileRowOf,
  publicState,
} from "./sessions.js";
import type { ServerEnv } from "./sessions.js";

/** multipart 里那个字段名。前端 `fd.append("files", f)`（ui/index.html:3057）——
 * 改了它上传就静默 400，而没有任何类型检查跨得过 HTTP。 */
const UPLOAD_FIELD = "files";

/** `int(os.getenv(name, dflt))`；解析不出来时按 Python 的 ValueError 语义**抛**，
 * 不悄悄回落 —— 一个写错的 env 应该在第一次上传时就被看见。 */
function envInt(name: string, dflt: string): number {
  const raw = process.env[name] ?? dflt;
  const v = Number.parseInt(raw, 10);
  if (Number.isNaN(v)) throw apiError(500, `环境变量 ${name} 不是整数: ${raw}`);
  return v;
}

export function registerFileRoutes(app: Hono<AppEnv>, env: ServerEnv): void {
  app.post("/api/sessions/:sid/files", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const files = await incomingFiles(c);
    const result = await env.sessionMutation(s, "materials.upload", async () =>
      uploadOnce(env, s, files),
    );
    // 第一份材料落定就有名字可用了。放在租约**外**：改的是会话表的 title 列，
    // 和刚提交的那份 projection 不相干，没有要串行的东西。
    await autoTitle(s);
    // Start the optional recommendation only after releasing the mutation lease; its
    // own chat lease is then guaranteed not to race this upload's projection commit.
    env.emitAiPrompts(s, "opening");
    return c.json(result);
  });

  /**
   * 撤掉一份还没梳理的材料。
   *
   * FDE 传错了、传多了要能拿掉再开始 —— 只能重传不能删，等于逼他重开一个会话。
   * 删完重跑 `preparse`，证据索引与语料摘要跟着收缩，否则聊天还能检索到一份
   * 已经不在列表里的材料。
   */
  app.delete("/api/sessions/:sid/files/:name", async (c) => {
    const s = await sessAsync(c.req.param("sid"));
    const name = c.req.param("name");
    return await env.sessionMutation(s, "materials.remove", async () =>
      c.json(await removeMaterialOnce(env, s, name)),
    );
  });
}

/** 一份进来的材料。Hono 的 `parseBody` 给的是 Web `File`，已经在内存里；
 * Python 侧是流式 `UploadFile.read(1MB)`，配额判断的**顺序**在下面保住了。 */
interface Incoming {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

async function incomingFiles(c: Context): Promise<Incoming[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body[UPLOAD_FIELD];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Incoming[] = [];
  for (const item of list) {
    if (typeof item === "string") continue; // 非文件字段，FastAPI 会 422，这里跳过
    out.push({
      filename: item.name,
      bytes: new Uint8Array(await item.arrayBuffer()),
    });
  }
  return out;
}

/** Stage and atomically install one multipart batch under a mutation lease. */
export async function uploadOnce(
  env: ServerEnv,
  s: Session,
  files: readonly Incoming[],
): Promise<Record<string, unknown>> {
  const sid = s.id;
  if (env.busy(s)) throw apiError(409, "正在梳理，不能同时替换材料。");
  const mats = join(s.dir, "materials");
  mkdirSync(mats, { recursive: true });
  const maxFiles = Math.max(1, envInt("ONTOCOPILOT_MAX_FILES", "100"));
  const fileLimit = envInt("ONTOCOPILOT_MAX_UPLOAD_MB", "100") * 1024 * 1024;
  const sessionLimit = envInt("ONTOCOPILOT_MAX_SESSION_MB", "500") * 1024 * 1024;
  const existing = new Map<string, number>(s.files.map((i) => [i.name, Math.trunc(i.size || 0)]));
  const incomingNames = new Set(files.map((f) => baseName(f.filename || "unnamed") || "unnamed"));
  const projectedNames = new Set([...existing.keys(), ...incomingNames]);
  if (projectedNames.size > maxFiles) {
    throw apiError(413, `会话材料数不能超过 ${maxFiles} 份`);
  }
  let baseTotal = 0;
  for (const [name, size] of existing) {
    if (!incomingNames.has(name)) baseTotal += size;
  }

  // staged 保插入序（Python dict 也保），提交阶段按同一顺序 replace。
  const staged = new Map<string, { temp: string; size: number; digest: string }>();
  const temps = new Set<string>();
  let stagedTotal = 0;
  try {
    for (const f of files) {
      const name = baseName(f.filename || "unnamed") || "unnamed";
      const temp = join(mats, `.${hex()}.upload`);
      temps.add(temp);
      const size = f.bytes.byteLength;
      // 同一 multipart 里若名字重复，以最后一份为准；前一份不计配额也不落盘。
      const prior = staged.get(name);
      if (prior !== undefined) {
        staged.delete(name);
        rmSync(prior.temp, { force: true });
        stagedTotal -= prior.size;
      }
      // Python 是边读边判：`size > file_limit` 在每个 1MB 分片上先判，
      // `base + staged + size > session_limit` 后判。所以当两条同时会被触发时，
      // **先被跨过的那条**报出来 —— 谁的阈值在更小的累计字节数上被越过谁先报，
      // 相等时按代码顺序算文件超限。这里显式还原这个次序，不是"随便挑一条"。
      const fileHeadroom = fileLimit;
      const sessionHeadroom = sessionLimit - baseTotal - stagedTotal;
      const overFile = size > fileLimit;
      const overSession = baseTotal + stagedTotal + size > sessionLimit;
      if (overFile && (!overSession || fileHeadroom <= sessionHeadroom)) {
        throw apiError(413, `${name} 超过单文件 ${Math.floor(fileLimit / 1024 / 1024)}MB 限制`);
      }
      if (overSession) {
        throw apiError(
          413,
          `会话材料总量超过 ${Math.floor(sessionLimit / 1024 / 1024)}MB 限制`,
        );
      }
      writeFileSync(temp, f.bytes);
      staged.set(name, { temp, size, digest: sha256Hex(f.bytes) });
      stagedTotal += size;
    }
  } catch (exc) {
    // 校验阶段的失败还没有触碰正式文件；清掉整批 staging，包括已经完整读完的
    // 前序文件。只有整个 multipart 读完才会进入下面的提交阶段。
    for (const temp of temps) rmSync(temp, { force: true });
    throw exc;
  }

  // 文件系统没有多文件事务。每个旧版本先原子移到同目录 backup；只有所有 replace
  // 和 repo 的单事务 upsert 都成功后才删除 backup。任何一步（包括第二个 replace、
  // DB 写入或请求取消）失败，都按逆序恢复旧版本并移除本批新文件。
  const backups = new Map<string, string | null>();
  const installed: string[] = [];
  const added: SessionFile[] = [...staged.entries()].map(([name, v]) => ({
    name,
    size: v.size,
    path: join(mats, name),
    sha256: v.digest,
  }));
  let committed = false;
  try {
    for (const [name, v] of staged) {
      const dest = join(mats, name);
      let backup: string | null = null;
      if (existsSync(dest)) {
        backup = join(mats, `.${hex()}.backup`);
        renameSync(dest, backup);
      }
      backups.set(name, backup);
      renameSync(v.temp, dest);
      installed.push(name);
    }
    await currentRepo().addFiles(
      sid,
      added.map(fileRowOf),
    );
    committed = true;
  } catch (exc) {
    for (const name of [...installed].reverse()) rmSync(join(mats, name), { force: true });
    for (const [name, backup] of backups) {
      if (backup !== null && existsSync(backup)) renameSync(backup, join(mats, name));
    }
    throw exc;
  } finally {
    if (committed) {
      for (const backup of backups.values()) {
        if (backup !== null) rmSync(backup, { force: true });
      }
    }
    for (const temp of temps) rmSync(temp, { force: true });
  }

  for (const item of added) {
    // 同名上传是替换，不是把同一材料在语料清单里追加两遍。内存投影只在磁盘与
    // repo 均成功后更新，异常路径与两个权威存储保持旧状态。
    s.files = s.files.filter((old) => old.name !== item.name);
    s.files.push(item);
  }
  // 同名重传后旧 `_chunks/_index` 仍按文件名命中，会让 UI 显示“已读入”，检索却
  // 返回上一版正文。以本批文件名精确失效；没变化的材料缓存与索引继续可用。
  invalidateMaterialCaches(s, new Set(added.map((item) => item.name)));
  s.emit("files.attached", { files: s.files.map((f) => f.name) });
  // **上传只登记，不解析。** 解析是不是现在做、做哪几份，交给 AI 判断（它有
  // material.list 看清单、material.parse 去读）。上传即解析看着"贴心"，实际是
  // 替 FDE 和 AI 都做了决定：他可能还要再传两份、可能只想先聊聊，而 AI 也没有
  // 机会说"这份跟你要问的没关系，先不读"。
  s.emit("materials.registered", {
    files: added.map((f) => f.name),
    note: "已登记，还没读内容。要读时由助手调用解析。",
  });
  const pub = publicState(s);
  pub["engagement"] = engagementView(env, s);
  return {
    files: responseFiles(s),
    corpus: s.state["corpus"] ?? null,
    prompts: openingPrompts({
      state: pub,
      files: s.files.map((f) => f.name),
      status: s.status,
    }),
  };
}

/** Remove and re-index one material under a cross-worker mutation lease. */
export async function removeMaterialOnce(
  env: ServerEnv,
  s: Session,
  name: string,
): Promise<Record<string, unknown>> {
  const sid = s.id;
  if (env.busy(s)) {
    throw apiError(409, "正在梳理，这时候增删材料会和正在跑的解析打架。");
  }
  const fname = baseName(name); // basename：防路径穿越
  const oldIndex = s.files.findIndex((f) => f.name === fname);
  if (oldIndex < 0) throw apiError(404, name);
  const oldItem = s.files[oldIndex]!;
  const p = join(s.dir, "materials", fname);
  const backup = existsSync(p) ? join(s.dir, "materials", `.${hex()}.remove`) : null;
  if (backup !== null) renameSync(p, backup);
  s.files = s.files.filter((f) => f.name !== fname);
  try {
    await currentRepo().removeFile(sid, fname);
    s.emit("files.attached", { files: s.files.map((f) => f.name) });
    // 索引/语料要跟着这次删除重算；没材料了就把上一轮的残留清干净。
    if (s.files.length > 0) {
      await env.preparse(s);
    } else {
      for (const k of ["_docs", "_index", "_chunks", "_profiles", "_endpoints", "corpus"]) {
        delete s.state[k];
      }
    }
    // 撤掉一份材料，"现在能问什么"就变了 —— 上传那条路早就带着新提示回去了，
    // 删除这条以前不带，于是 chips 还在问一份已经不存在的材料里有什么。
    //
    // 写空数组，**不能 delete**：`persist` 只做 upsert（`docs = {k: state[k]
    // for k in _PERSISTED if k in state}`），删掉内存里的 key 只是让它不进
    // docs，库里那份原样留着 —— 换个 worker hydrate 一次，chips 又回来问
    // 一份已经删掉的材料。正是这几行想防的事。
    s.state["followups"] = [];
    await env.persist(s, { status: false });
  } catch (exc) {
    // File + file inventory + derived projection are one user operation.  Put
    // both authoritative stores back before the mutation context restores the
    // in-memory state snapshot.
    if (backup !== null && existsSync(backup)) renameSync(backup, p);
    s.files.splice(Math.min(oldIndex, s.files.length), 0, oldItem);
    await currentRepo().addFiles(sid, [
      makeFileRow({
        name: fname,
        rel_path: fileRowOf(oldItem).rel_path,
        size: Math.trunc(oldItem.size || 0),
        sha256: String(oldItem.sha256 ?? ""),
      }),
    ]);
    throw exc;
  }
  if (backup !== null) rmSync(backup, { force: true });
  const pub = publicState(s);
  return {
    files: responseFiles(s),
    corpus: s.state["corpus"] ?? null,
    prompts: openingPrompts({
      state: pub,
      files: s.files.map((f) => f.name),
      status: s.status,
    }),
  };
}

/** 上传/删除响应保留旧有的 sha/path 字段，同时带上与 `/state` 相同的解析状态。 */
function responseFiles(s: Session): Array<Record<string, unknown>> {
  const status = new Map(materialFileList(s).map((f) => [f.name, f]));
  return s.files.map((f) => ({ ...f, ...(status.get(f.name) ?? {}) }));
}

/** `uuid.uuid4().hex` —— 临时/备份文件名用。 */
function hex(): string {
  return randomUUID().replace(/-/gu, "");
}
