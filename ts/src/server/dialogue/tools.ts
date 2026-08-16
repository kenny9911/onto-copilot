/**
 * 对话侧的动作工具 —— 移植自 `src/ontocopilot/server.py` 的 `_converse_tools`
 * （4647–5607）。
 *
 * 这一节是用户每天真正在用的东西：聊天框里问一句，系统要能改 OIR、补证据、
 * 导出文件、回答问题。因此有两件事必须逐字保住：
 *
 * 1. **每个工具的参数校验与失败文案。** 模型会传奇怪的参数，那些
 *    `{"error": …}` 的返回是**设计好的**（让模型看懂并改正），不是兜底。
 *    改一个字，模型学到的自纠模式就变了。
 * 2. **权限作用域。** `kernel/tools.ts` 的 `register` 里记着一条真实事故：
 *    `scopes` 默认 `["*"]` 会把工具发给每一个作用域，包括直接读用户上传材料的
 *    extract —— 材料里一段伪装成业务说明的指令就能诱导模型调它。所以下面每个
 *    工具都**显式**写 scopes，RW 一律只给 `converse`。
 *
 * 形态上的一处必然变化：Python 是 `@reg.fn(...)` 装饰器 + `fn(ctx, **args)`，
 * TS 是 `reg.fn(spec, handler)` + `handler(args, ctx)`（见 `kernel/tools.ts` 头部
 * 的说明）。参数默认值因此由处理函数自己写，不再来自函数签名。
 */

import { basename, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";

import { Danger, type ToolCallCtx, type ToolRegistry } from "../../kernel/tools.js";
import { fingerprint } from "../../kernel/ids.js";
import { DecisionKind, PROMOTABLE, parseDecisionKind, userSaid } from "../../kernel/memory/dialogue.js";
import { cite, oirFromDict, type OIR } from "../../onto/oir.js";
import { FlowGraph, flowFromDict, nodeGrounded } from "../../onto/flow.js";
import { toMermaid, toSvg } from "../../onto/diagram.js";
import {
  SKETCH_CAVEAT,
  SKETCH_MARK,
  SKETCH_SCHEMA,
  SKETCH_SYSTEM,
  SKETCH_DETAILS,
  SketchError,
  graphFromSketch,
  parseSketchDetail,
  sketchCaveats,
  sketchFileName,
  sketchPrompt,
  sketchTitle,
} from "../../onto/flow_sketch.js";
import { applySuggestion } from "../../onto/suggest.js";
import { OIREditError, applyOirEdit } from "../../onto/oir_edit.js";
import { TemplateSpec, writeXlsx } from "../../onto/template.js";
import { EditError, applyEdit, reconcileTemplate } from "../../onto/template_edit.js";

import { cpSlice } from "../../onto/parse/base.js";
import { pyJsonDumps } from "../../kernel/journal.js";
import { MultiSheet, NoRows, oirTable, pyReprList, pyTruthy, pyUnquote } from "../pipeline/tables.js";
import { pushVersion } from "../pipeline/persist.js";
import { BUILD_STARTABLE } from "../pipeline/run.js";

import { ChatCtx } from "./ctx.js";
// `_dialogue` 住在 memory.ts —— 单独一个文件是为了避开 tools.ts ↔ dialogue.ts
// 的循环 import（ESM 下循环里的具名导出在求值期是 undefined，症状是"函数不是函数"）。
import { dialogueOf } from "./memory.js";
import {
  ExportDependencyMissing,
  FlowEditError,
  ROWS_MAX,
  type DialogueDeps,
  type SessionLike,
} from "./ports.js";
import { excName, excText, pyJsonIndent, pyRound, pySorted } from "./pyutil.js";

/** 结构化编辑类工具的参数袋。 */
type Args = Record<string, unknown>;

/** 扫描件后缀。文本类现在就能读，图片类要视觉模型 —— 两种"没读"必须分清。 */
const SCAN_EXT = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf"] as const;

function isScan(name: string): boolean {
  const low = name.toLowerCase();
  return SCAN_EXT.some((e) => low.endsWith(e));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** `s.state[key]` 当数组读（Python 的 `s.state.get(k) or []`）。 */
function stateList(s: SessionLike, key: string): Record<string, unknown>[] {
  const v = s.state[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** `_chunks` 的形态：文件名 → 段列表。 */
function chunksOf(s: SessionLike): Record<string, Record<string, unknown>[]> {
  const v = s.state["_chunks"];
  return v !== null && typeof v === "object" ? (v as Record<string, Record<string, unknown>[]>) : {};
}

/**
 * 这个会话正在跑 DAG 吗。
 *
 * 改产物的动作必须看这个。旧的 chat 路由有「跑着时排队」，改成 agent-first 的
 * 时候被删掉 —— 审查当场指出来：跑着的时候调重编译，界面会显示「已完成」而
 * 抽取还在继续。
 */
export function isBusy(s: SessionLike): boolean {
  return s.status === "queued" || s.status === "parsing" || s.status === "extracting";
}

/**
 * 证据索引按**调用时**解析，不按建注册表时。
 *
 * 工具集是一轮开始时装配的，而 `material.parse` 就是在这一轮中间把索引建出来的
 * —— 早绑的话，AI 刚读完材料却发现这一轮没有检索工具可用，只能等下一轮，白跑一趟。
 */
function lazyIndex(s: SessionLike): unknown {
  const ix = (): Record<string, unknown> | null => {
    const v = s.state["_index"];
    return v === null || v === undefined ? null : (v as Record<string, unknown>);
  };
  return {
    search(...a: unknown[]): unknown {
      const live = ix();
      if (live === null) return [];
      return (live["search"] as (...x: unknown[]) => unknown).call(live, ...a);
    },
    fileNames(): Record<string, string> {
      const live = ix();
      if (live === null) return {};
      return (live["fileNames"] as () => Record<string, string>).call(live);
    },
    size(): number {
      const live = ix();
      if (live === null) return 0;
      return (live["size"] as () => number).call(live);
    },
  };
}

/**
 * 同理：OIR 也按调用时解析。
 *
 * `oir.query` 是**条件注册**的（Python 侧 `if oir is not None`），而工具集在回合
 * 开始时就装配好了 —— 一个还没跑过梳理的会话里它压根不存在，等这一轮里梳理跑完
 * （或者 hydrate 把 OIR 载回来），模型仍然查不了自己刚产出的东西。
 *
 * Python 用 `__getattr__` 转发；TS 用 `Proxy` 是唯一等价物 —— 普通对象没法
 * 拦截"访问一个还不存在的属性"。
 */
function lazyOir(s: SessionLike): unknown {
  return new Proxy(
    {},
    {
      get(_t, name: string | symbol): unknown {
        const live = s.state["_oir"];
        if (live === null || live === undefined) {
          throw new Error("还没有产物（没跑过梳理），查不了本体。");
        }
        const v = (live as Record<string | symbol, unknown>)[name];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(live) : v;
      },
    },
  );
}

/**
 * 把执行器注册成推理循环可以调的工具。
 *
 * 以前是反过来的：规则判出意图 → 直接执行 → 模型只负责给结果措辞。那套东西
 * 的问题不是不好用，是**没有思考可看** —— 「你好」根本走不到推理循环，
 * 推理轨迹永远是空的；而且规则判错时模型没有机会纠正，它拿到的已经是既成事实。
 *
 * 现在模型自己决定调什么。规则的判定降级成提示塞进 prompt —— 它仍然有用
 * （便宜、准、可审计），但不再是绕过模型的旁路。
 *
 * **改产物的工具一律 WRITE_LOCAL**，且每个都在返回值里说清改了什么，
 * 模型必须把它转述给用户。静默改产物是这层最不能出的错。
 */
export function converseTools(s: SessionLike, deps: DialogueDeps): ToolRegistry {
  const reg = deps.builtinRegistry({
    evidence: lazyIndex(s),
    oir: lazyOir(s),
    profiles: s.state["_profiles"],
  });

  // RO（只读：看状态、看材料清单、查流程）两个模式都给 —— 聊天也要能就上传的
  // 材料对话。RW（改产物：抽本体、改流程图、出模板、开跑）**只给工作模式**。
  // `material.parse` 单独放行到聊天：它只是把文件读进索引，不产出任何产物，
  // 而聊天要分析上传的文件就必须能读。
  const RO = ["converse", "chat"] as const;
  const RW = ["converse"] as const;
  const RO_PARSE = ["converse", "chat"] as const;

  const turnIdOf = (ctx: ToolCallCtx): string =>
    ctx instanceof ChatCtx ? ctx.turnId : str((ctx as unknown as Record<string, unknown>)["turnId"]);

  // ── material.list ───────────────────────────────────────────
  reg.fn(
    {
      name: "material.list",
      description:
        "列出这次会话的全部材料：文件名、体量、已经读进来多少段、有没有还没识别的。" +
        "**要判断某份材料值不值得细看、或者用户问「都有什么材料」时，先调它。** 零成本。",
      schema: { type: "object", properties: {} },
      danger: Danger.READ,
      scopes: RO,
    },
    () => {
      const chunks = chunksOf(s);
      const rows = s.files.map((f) => {
        const cs = chunks[f.name] ?? [];
        return {
          文件: f.name,
          大小KB: pyRound((Number(f["size"] ?? 0) || 0) / 1024, 0),
          已读入段数: cs.length,
          // 两种"没读"要分清：文本类现在就能读（material.parse，零成本），
          // 图片类要视觉模型、留到梳理时 —— 混成一句话会让 AI 对着文本材料
          // 干等"开始梳理"，或者以为图片现在就能读。
          状态:
            cs.length > 0
              ? "已读入"
              : isScan(f.name)
                ? "还没识别（图片/扫描件，点「开始梳理」时用视觉模型识别）"
                : "还没读入（调 material.parse 即可读，零成本）",
        };
      });
      return {
        材料数: s.files.length,
        材料: rows,
        说明: "要看某份材料的正文，用 evidence.search 并把文件名填进 files",
      };
    },
  );

  // ── template.query ──────────────────────────────────────────
  reg.fn(
    {
      name: "template.query",
      description:
        "看当前填写模板长什么样：有哪些表、每张表几行、有哪些列、哪些格要业务方填。" +
        "**要改模板之前先看一眼** —— 不知道现在有什么列就改，多半改错。零成本。",
      schema: {
        type: "object",
        properties: { sheet: { type: "string", description: "只看某张表；不给则看总览" } },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const sheet = str(args["sheet"]);
      const sp = join(s.dir, "template.spec.json");
      if (!existsSync(sp)) return { error: "还没有模板。跑完一轮梳理才会生成。" };
      const spec = TemplateSpec.load(sp);
      if (sheet) {
        const sh = spec.sheets.find((x) => x.name === sheet || x.name.includes(sheet));
        if (sh === undefined) {
          return {
            error: `没有表「${sheet}」。现有：${pyReprList(spec.sheets.map((x) => x.name))}`,
          };
        }
        const roles: Record<string, number> = {};
        for (const row of sh.rows) {
          for (const c of row.values()) roles[c.role] = (roles[c.role] ?? 0) + 1;
        }
        return {
          表: sh.name,
          行数: sh.rows.length,
          列: [...sh.columns],
          说明: sh.guide,
          各类格子数: roles,
          前两行: sh.rows.slice(0, 2).map((r) => Object.fromEntries([...r].map(([k, v]) => [k, v.value]))),
        };
      }
      return {
        轮次: spec.round,
        统计: spec.stats(),
        表: spec.sheets.map((x) => ({
          表名: x.name,
          行数: x.rows.length,
          列: [...x.columns],
          说明: cpSlice(x.guide || "", 0, 80),
        })),
        提示: "要看某张表的内容传 sheet=表名；要改结构用 template.edit",
      };
    },
  );

  // ── ui.table ────────────────────────────────────────────────
  reg.fn(
    {
      name: "ui.table",
      description:
        "把一批产物**以表格形式列给用户看**（对象/属性/关系/动作/规则/待澄清问题）。" +
        "用户说「列出来」「全部列一遍」「有哪些」这类要求时**用它，不要自己在回答里" +
        "一条条打出来** —— 你打字既会截断、又可能记错；这个表由系统直接从产物里出，" +
        "一条不少。调完在回答里说一句「已列出 N 条，见下表」即可。",
      schema: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: {
            type: "string",
            enum: ["objects", "properties", "links", "actions", "rules", "questions"],
          },
          contains: { type: "string", description: "只列名字/内容里含这个词的；不给则全部" },
          title: { type: "string", description: "给这张表起个标题" },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    async (args) => {
      const kind = str(args["kind"]);
      const contains = str(args["contains"]);
      const title = str(args["title"]);
      if (kind === "questions" && pyTruthy(s.state["question_backlog"])) {
        const backlog = deps.questionBacklog(s);
        let qs = [...backlog.questions.values()];
        if (contains) {
          const needle = contains.toLowerCase();
          qs = qs.filter((q) => pyJsonDumps(q.toDict()).toLowerCase().includes(needle));
        }
        const head = ["问题ID", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问"];
        const rows = qs.map((q) => [
          q.id,
          q.text,
          q.status,
          q.priority,
          q.audienceRole,
          q.ownerUserId,
          q.why,
        ]);
        await s.emitDurable("ui.table", {
          title: title || `统一问题清单（${rows.length} 条）`,
          columns: head,
          rows,
        });
        return {
          已列出: rows.length,
          类型: "统一问题清单",
          说明: "问题台账已经显示；不要在回答里逐条复述。",
        };
      }
      const oir = asRecord(s.state["oir"]);
      const items = asArray(oir[kind]);
      if (items.length === 0) {
        // 这条错最容易被误读成"这东西读不出来"，然后模型就去 evidence.search 抄
        // 几条片段凑清单、再跟用户说"系统读取异常"。要列的东西在**用户自己上传
        // 的表**里时，根本不需要梳理 —— 直接读那张表就有。
        return {
          error: `还没有 ${kind} —— 这里列的是**梳理产出的**东西，而梳理还没跑过。`,
          下一步:
            "如果用户要的其实是**他上传的表格里已有的内容**（比如他自己整理好的问题清单），" +
            "用 material.rows(file=…) 直接把那张表列出来，不用先梳理。",
        };
      }
      const [label, head, rows] = oirTable(oir, kind, contains);
      await s.emitDurable("ui.table", {
        title: title || `${label}（${rows.length} 条）`,
        columns: head,
        rows,
        total: rows.length,
        src: { kind: "oir", oir_kind: kind, contains },
      });
      // 返回给模型的是**摘要**，不是全部行 —— 它不需要、也不该把这些再打一遍
      return {
        已列出: rows.length,
        类型: label,
        说明:
          `表格已经显示给用户了。回答里说一句「已列出 ${rows.length} 条${label}，见下表」` +
          `就够了，**不要再逐条复述**。`,
      };
    },
  );

  // ── question.next ───────────────────────────────────────────
  reg.fn(
    {
      name: "question.next",
      description:
        "读取统一 QuestionBacklog 的下一批高价值问题。用户问『接下来该问什么/问谁』" +
        "或要访谈议程时用；会直接在聊天中显示可导出的表格。",
      schema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 },
          audience_role: { type: "string", description: "只看某个回答角色" },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    async (args) => {
      const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
      const audienceRole = str(args["audience_role"]);
      const backlog = deps.questionBacklog(s);
      let batch = backlog.nextBatch({ limit: Math.max(1, Math.min(limit, 20)) });
      if (audienceRole) batch = batch.filter((q) => q.audienceRole.includes(audienceRole));
      const head = ["问题ID", "问题", "优先级", "回答对象", "负责人", "影响/为什么问"];
      const rows = batch.map((q) => [
        q.id,
        q.text,
        q.priority,
        q.audienceRole,
        q.ownerUserId,
        q.why,
      ]);
      await s.emitDurable("ui.table", {
        title: `下一批访谈问题（${rows.length} 条）`,
        columns: head,
        rows,
      });
      return {
        count: rows.length,
        questionIds: batch.map((q) => q.id),
        summary: backlog.stats(),
        说明: "问题已显示为表格；可继续分派、回答或导出。",
      };
    },
  );

  // ── question.answer ─────────────────────────────────────────
  reg.fn(
    {
      name: "question.answer",
      description:
        "把业务人员/ERP 顾问对某个问题的自由文本或选项回答写入 DecisionLedger，" +
        "更新 Ontology 与 Revision，并生成下一批问题。必须使用 question.next/ui.table" +
        "中展示的稳定 question_id；写入前向用户说明影响并等待本轮确认。",
      schema: {
        type: "object",
        required: ["question_id", "answer"],
        properties: {
          question_id: { type: "string" },
          answer: {},
          option_id: { type: "string" },
          answer_text: { type: "string" },
          actor: { type: "string" },
          actor_role: { type: "string" },
          idempotency_key: { type: "string" },
        },
      },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    async (args, ctx) => {
      const questionId = str(args["question_id"]);
      const answer = args["answer"];
      const optionId = str(args["option_id"]);
      const answerText = str(args["answer_text"]);
      const actor = args["actor"] === undefined ? "fde" : str(args["actor"]);
      const actorRole = str(args["actor_role"]);
      const idempotencyKey = str(args["idempotency_key"]);
      const idem =
        idempotencyKey || `chat:${turnIdOf(ctx)}:${questionId}:${cpSlice(fingerprint(answer), 0, 12)}`;
      const result = await deps.answerDomainQuestion(
        s,
        questionId,
        {
          answer,
          // Python 是 `option_id or None`：空串要变成 null，不是空串。
          option_id: optionId || null,
          answerText,
          actor,
          actorRole,
          sourceTurn: turnIdOf(ctx),
          idempotencyKey: idem,
        },
        { mutationClaimed: Boolean(s.mutationLeaseOwner) },
      );
      return {
        已记录: result.decision.id,
        created: result.created,
        question: questionId,
        pending: result.pending,
        status: result.status,
        下一步: "用 question.next 取下一批问题",
      };
    },
  );

  // ── export.file ─────────────────────────────────────────────
  reg.fn(
    {
      name: "export.file",
      description:
        "把**刚刚给用户看的那份内容**存成一个可下载的文件。他说「把这个表转成 " +
        "excel 给我」「导出成 word / pdf」「能不能下载」时用它，调完他那边就会出现" +
        "一个下载按钮。\n" +
        "source 选哪个：他说「这个表/刚才那个清单」→ last_table（默认 —— **屏幕上" +
        "最后出现的那张表**，你用 ui.table 列的、从材料里读的、以及你直接写在回答" +
        "正文里的 markdown 表格，都算）；他指名要某一类产物 → " +
        "objects/properties/links/actions/rules/questions；他说「把你刚才那段回答" +
        "存下来」→ last_answer；「把我们这段对话导出来」→ conversation。\n" +
        "格式挑不准就按内容挑：**表格类给 xlsx**（能筛能排能粘），**成文的东西给 " +
        "docx 或 pdf**，要留档给 md。",
      schema: {
        type: "object",
        required: ["format"],
        properties: {
          format: {
            type: "string",
            // 口语别名（excel/word/表格）由 export.resolveFormat 规范化；这里若写死
            // 五个 enum，工具契约会在处理器有机会规范化之前就拒绝合法的“excel”。
            description: "xlsx/excel、docx/word、pdf、md、csv",
          },
          source: {
            type: "string",
            enum: [
              "last_table",
              "objects",
              "properties",
              "links",
              "actions",
              "rules",
              "questions",
              "last_answer",
              "conversation",
            ],
            description: "导什么；不给就是上一张表",
          },
          contains: { type: "string", description: "只导含这个词的行（对表格类有效）" },
          name: {
            type: "string",
            description:
              "他点名要哪张表时填上那个名字（比如「AI 招聘业务流程梳理及访谈提问框架」）。" +
              "**只要他说了名字就一定要填** —— 不填就是导最后一张，很可能是别的话题那张。" +
              "source=last_table 时有效",
          },
          title: { type: "string", description: "文件名/标题；不给就按内容起一个" },
        },
      },
      danger: Danger.WRITE_LOCAL,
      scopes: RO,
    },
    async (args) => {
      const X = deps.exportApi;
      const format = str(args["format"]);
      const source = args["source"] === undefined ? "last_table" : str(args["source"]);
      const contains = str(args["contains"]);
      const title = str(args["title"]);
      let name = str(args["name"]);

      let fmt: string;
      try {
        fmt = X.resolveFormat(format);
        if (!fmt) {
          return { error: `不支持的格式「${format}」。可用：${X.FORMATS.join("/")}` };
        }
      } catch (exc) {
        return { error: excText(exc) };
      }

      const [doc, receipt] = await deps.exportDoc(s, source, contains, title, name);
      if (doc === null) return receipt; // 组不出内容时 receipt 里是 error

      let data: Uint8Array;
      let spec: { ext: string; label: string };
      try {
        [data, spec] = await X.render(doc, fmt);
      } catch (exc) {
        // 某个格式的库没装：只影响这一种
        if (exc instanceof ExportDependencyMissing) {
          return { error: `这台机器上导不出 ${fmt}：${excText(exc)}` };
        }
        return { error: `写 ${fmt} 失败：${excName(exc)}: ${excText(exc)}` };
      }

      // 写进 exports/ **子目录**：会话根目录下的散文件会被当成产物（artifacts 是
      // "根目录下所有文件"算出来的），于是导出件会混进产物列表、混进交付包 zip，
      // 一个叫「问题清单.xlsx」的导出还可能被「下载填写模板」按钮抓走。
      const outdir = join(s.dir, "exports");
      mkdirSync(outdir, { recursive: true });
      name = X.safeName(doc.title, spec.ext);
      writeFileSync(join(outdir, name), data, { flag: "w" });

      let rows = 0;
      for (const t of doc.tables) rows += t.rows.length;
      s.emit("export.ready", {
        name,
        label: spec.label,
        size: data.length,
        rows,
        title: doc.title,
      });
      return {
        已生成: name,
        格式: spec.label,
        大小字节: data.length,
        表格行数: rows || "不适用",
        说明:
          `下载按钮已经显示给用户了。回答里说一句「已导出「${name}」，点下面就能下载」` +
          `即可，**不要贴链接、不要说存在哪个目录**。`,
        // 补不回全量之类的话要一起说，不能只写在文件里
        ...receipt,
      };
    },
  );

  // ── material.parse ──────────────────────────────────────────
  reg.fn(
    {
      name: "material.parse",
      description:
        "把还没读过的材料**读进来**（不产出任何本体/流程图/模板）。" +
        "表格/CSV/SQL/文档零成本。**图片/扫描件要传 ocr=true**，那会调视觉模型" +
        "把图里的内容识别出来（要花钱，但只识别、不梳理）。\n" +
        "用户说「分析一下这张图/这份材料」「这图讲了什么」时用它 —— 读完再用 " +
        "evidence.search 看内容然后回答。**这不是「开始梳理」**：他只是想看看，" +
        "没让你产出本体和流程图。",
      schema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "只读这几份（文件名）；不给就把还没读的都读了",
          },
          ocr: { type: "boolean", description: "图片/扫描件要识别就传 true（会调视觉模型）" },
        },
      },
      danger: Danger.WRITE_LOCAL,
      scopes: RO_PARSE,
    },
    async (args) => {
      const files = Array.isArray(args["files"]) ? (args["files"] as string[]) : null;
      const ocr = args["ocr"] === true;
      if (s.files.length === 0) return { error: "还没有材料。" };
      if (isBusy(s)) return { error: "梳理正在跑，它自己会解析。" };
      const before = { ...chunksOf(s) };
      if (ocr) {
        // **只识别，不梳理。** 用户说"分析一下这张图"时要的就是这个：把图读懂，
        // 而不是启动一整条抽本体/出流程图/编模板的管线。识别结果进证据索引，
        // 接下来用 evidence.search 就能就图作答。
        await deps.ensureCatalog();
        const targets = new Set(pySorted(files ?? s.files.map((f) => f.name)));
        await deps.chatRun(
          s,
          {
            kind: "ocr",
            semanticInput: {
              files: s.files
                .filter((f) => targets.has(f.name))
                .map((f) => [f.name, f.sha256, f.size]),
            },
          },
          async (run) => {
            await deps.preparse(s, { vision: run.smart });
          },
        );
      } else {
        await deps.preparse(s); // 零模型调用；扫描件在这条路上不识别
      }
      const after = chunksOf(s);
      const got: Record<string, number> = {};
      for (const [k, v] of Object.entries(after)) {
        if (v.length > (before[k] ?? []).length) got[k] = v.length;
      }
      const loaded: Record<string, number> = {};
      for (const [k, v] of Object.entries(after)) if (v.length > 0) loaded[k] = v.length;
      const scans = s.files
        .filter((f) => !pyTruthy(after[f.name]) && isScan(f.name))
        .map((f) => f.name);
      // **措辞必须让模型没法误解成"已经在跑了"。** 这里回过"没有新读入的（可能
      // 都读过了）"，模型就据此对用户说"系统正在解析中" —— 一句彻头彻尾的假话，
      // 而其实什么都没启动。工具的回执是模型唯一的事实来源，含糊即等于撒谎。
      const out: Record<string, unknown> = {
        本次读入: Object.keys(got).length > 0 ? got : "无（没有可用这种方式读的新材料）",
        当前状态: s.status,
        已读入的材料: Object.keys(loaded).length > 0 ? loaded : "无",
      };
      if (scans.length > 0) {
        out["还没识别的图片"] = scans;
        out["下一步"] =
          "这些是图片/扫描件。**要看懂它们就再调一次本工具、带上 ocr=true**" +
          "（会调视觉模型识别，只识别不梳理），然后用 evidence.search 查内容作答。" +
          "只有当用户明确要**产出**本体/流程图/模板时，才用 build.start。" +
          "**不要说系统正在解析** —— 在你调用之前什么都没开始。";
      } else if (Object.keys(got).length > 0) {
        out["下一步"] = "已经读进来了，用 evidence.search 查内容";
      }
      return out;
    },
  );

  // ── material.inspect ────────────────────────────────────────
  reg.fn(
    {
      name: "material.inspect",
      description:
        "看一份材料的结构大纲：分成了哪些段、都是什么类型、解析时发现了什么问题。" +
        "**这是目录不是正文** —— 要正文用 evidence.search。零成本。",
      schema: {
        type: "object",
        required: ["file"],
        properties: { file: { type: "string", description: "文件名" } },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const file = str(args["file"]);
      const chunks = chunksOf(s);
      const cand = file.includes("%") ? [file, pyUnquote(file)] : [file];
      const name =
        cand.find((x) => x in chunks) ??
        Object.keys(chunks).find((k) => cand.some((x) => x !== "" && k.includes(x))) ??
        "";
      if (!name) {
        const known = pySorted(Object.keys(chunks));
        return {
          error: `没有材料「${file}」。现有：${known.length > 0 ? pyReprList(known) : "（还没上传）"}`,
        };
      }
      const cs = chunks[name] ?? [];
      const byTag: Record<string, number> = {};
      for (const c of cs) {
        const tags = asArray(c["tags"]);
        for (const t of tags.length > 0 ? tags : ["未分类"]) {
          const key = str(t);
          byTag[key] = (byTag[key] ?? 0) + 1;
        }
      }
      return {
        文件: name,
        段数: cs.length,
        各类段落: byTag,
        前几段: cs.slice(0, 5).map((c) => ({
          出处: c["cite"] ?? null,
          摘录: cpSlice(str(c["text"]), 0, 160),
        })),
        下一步:
          `要**整张表列给用户**：material.rows(file="${name}")；` +
          `要查某个说法在哪：evidence.search(query=…, files=["${name}"])`,
      };
    },
  );

  // ── material.rows ───────────────────────────────────────────
  reg.fn(
    {
      name: "material.rows",
      description:
        "把**用户自己上传的表格**里的行原样列出来给他看（xlsx/csv）。他说「把表里的" +
        "问题列给我」「这份表有哪些行」「全部列一遍」，而东西在**他上传的表**里时，" +
        "用这个 —— 行由系统直接从文件读，150 行就是 150 行。\n" +
        "**绝不要拿 evidence.search 的片段凑清单**：那是按相关度取的前几条，拿它当" +
        "全集必然只剩零星几条，而他要的正是全部。零成本，不需要先梳理。\n" +
        "（`ui.table` 列的是**梳理产出的**对象/属性/规则；这个列的是**原始材料**。）",
      schema: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "string", description: "文件名" },
          sheet: { type: "string", description: "工作表名；整份只有一张表时可不给" },
          contains: { type: "string", description: "只列内容里含这个词的行；不给则全部" },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "只要这几列；不给则全部",
          },
          title: { type: "string", description: "给这张表起个标题" },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    async (args) => {
      const file = str(args["file"]);
      const sheet = str(args["sheet"]);
      const contains = str(args["contains"]);
      const columns = Array.isArray(args["columns"]) ? (args["columns"] as string[]) : null;
      const title = str(args["title"]);

      let fname: string;
      let pick: string;
      let cols: string[];
      let data: string[][];
      let note: Record<string, unknown>;
      try {
        [fname, pick, cols, data, note] = await deps.materialTable(s, file, sheet, contains, columns);
      } catch (exc) {
        if (exc instanceof MultiSheet) {
          return {
            多张工作表: exc.sheets,
            下一步: "传 sheet=表名 再调一次；用户没指定就先问他要哪张。",
          };
        }
        if (exc instanceof NoRows) return { error: excText(exc) };
        throw exc;
      }

      const total = data.length;
      const shown = data.slice(0, ROWS_MAX);
      await s.emitDurable("ui.table", {
        title:
          title ||
          `${fname}·${pick}` + (contains ? `（含「${contains}」${total} 行）` : `（${total} 行）`),
        columns: cols,
        rows: shown,
        total,
        // 来源配方：导出时据此重算**全量**行，不受屏幕封顶影响
        src: { kind: "material", file: fname, sheet: pick, contains, columns: columns ?? [] },
      });
      const out: Record<string, unknown> = {
        已列出: shown.length,
        总行数: total,
        表: pick,
        列: cols,
        说明: `表格已经显示给用户了。回答里说一句「已列出 ${shown.length} 条，见下表」就够了，**不要再逐条复述**。`,
        ...note,
      };
      if (total > shown.length) {
        out["只显示了前几行"] =
          `共 ${total} 行，界面上只列了前 ${ROWS_MAX} 行。` +
          `**要告诉用户还有 ${total - shown.length} 行没列**，` +
          `想看全部可以用 contains=… 缩小范围，或者直接导出成文件 —— **导出是全量的**。`;
      }
      return out;
    },
  );

  // ── session.status ──────────────────────────────────────────
  reg.fn(
    {
      name: "session.status",
      description:
        "查当前会话的状态：材料、产物统计、待拍板的问题、建议、花费。" +
        "回答『进度』『现在什么情况』这类问题前先调它。",
      schema: { type: "object", properties: {} },
      danger: Danger.READ,
      scopes: RO,
    },
    () => {
      const st = asRecord(asRecord(s.state["oir"])["stats"]);
      const spent = asRecord(asRecord(s.state["budget"])["spent"]);
      const chunks = chunksOf(s);
      const suggestions = stateList(s, "suggestions");
      return {
        材料: s.files.map((f) => `${f.name}（${(chunks[f.name] ?? []).length} 段）`),
        状态: s.status,
        产物: Object.keys(st).length > 0 ? st : "还没跑过梳理",
        // 生成了哪些文件也要能看见 —— 模型总不能对着自己产出的东西说不知道
        已生成的文件: pyTruthy(s.state["artifacts"]) ? s.state["artifacts"] : "无",
        流程图: pyTruthy(asRecord(s.state["flow"])["stats"])
          ? asRecord(s.state["flow"])["stats"]
          : "还没有",
        模板: pyTruthy(s.state["template"]) ? s.state["template"] : "还没有",
        花费美元: pyRound(Number(spent["usd"] ?? 0) || 0, 2),
        待拍板: stateList(s, "questions").map((q) => q["title"] ?? null),
        建议: suggestions.map((x, i) => ({ 序号: i + 1, 标题: x["title"], 影响: x["impact"] })),
        已拍板的约定: dialogueOf(s).activeDecisions().map((d) => d.render()),
      };
    },
  );

  // ── flow.query ──────────────────────────────────────────────
  reg.fn(
    {
      name: "flow.query",
      description:
        "查已抽出的业务流程图：阶段、动作、事件、边。" +
        "回答『流程有哪些环节』『某个动作的上下游是什么』之前先调它。",
      schema: {
        type: "object",
        properties: {
          stage: { type: "string", description: "只看某个阶段，留空看全部" },
          around: { type: "string", description: "只看某个节点的上下游，填节点名或编号" },
        },
      },
      danger: Danger.READ,
      scopes: RO,
    },
    (args) => {
      const stage = str(args["stage"]);
      const around = str(args["around"]);
      const g = s.state["_flow"];
      if (!(g instanceof FlowGraph)) {
        return {
          error: "还没有流程图。材料里要有「触发条件/输入/输出」这类结构化的流程说明才抽得出来",
        };
      }
      if (around) {
        const hit = [...g.nodes.values()].find(
          (n) => n.label.value.includes(around) || around === n.code,
        );
        if (hit === undefined) return { error: `找不到「${around}」` };
        const st = g.stages.get(hit.stage);
        const first = hit.label.evidence[0];
        return {
          节点: hit.label.value,
          编号: hit.code,
          阶段: st !== undefined ? st.title : hit.stage,
          执行者: hit.actor.value || "（材料没写）",
          上游: g
            .inEdges(hit.rid)
            .filter((e) => g.nodes.has(e.source))
            .map((e) => g.nodes.get(e.source)?.label.value),
          下游: g
            .outEdges(hit.rid)
            .filter((e) => g.nodes.has(e.target))
            .map((e) => g.nodes.get(e.target)?.label.value),
          出处: first !== undefined ? cite(first) : "（推断，无出处）",
        };
      }
      const nodes = [...g.nodes.values()].filter((n) => {
        if (!stage) return true;
        const st = g.stages.get(n.stage);
        return (st !== undefined ? st.title : n.stage).includes(stage);
      });
      return {
        统计: g.stats(),
        阶段: [...g.stages.values()].sort((a, b) => a.order - b.order).map((x) => x.title),
        节点: nodes.slice(0, 60).map((n) => ({
          名: n.label.value,
          编号: n.code,
          类型: n.kind,
          有依据: nodeGrounded(n),
        })),
      };
    },
  );

  // ── flow.issues ─────────────────────────────────────────────
  reg.fn(
    {
      name: "flow.issues",
      description:
        "查流程图的问题：断掉的环节、没标条件的分支、有动作却没有对应事件的地方。" +
        "这些正是该拿去问客户的 —— 它们标出了材料里缺了什么。",
      schema: { type: "object", properties: {} },
      danger: Danger.READ,
      scopes: RO,
    },
    () => {
      const g = s.state["_flow"];
      if (!(g instanceof FlowGraph)) return { error: "还没有流程图" };
      return {
        "死路（有入无出且不是终态）": g.deadEnds().slice(0, 10).map((n) => {
          const first = n.label.evidence[0];
          return { 节点: n.label.value, 出处: first !== undefined ? cite(first) : "推断" };
        }),
        "悬空（既无入也无出）": g.dangling().slice(0, 10).map((n) => n.label.value),
        分支没标条件: g.unlabeledBranches().slice(0, 10).map((n) => n.label.value),
        有动作没有对应事件: g.actionsWithoutEvents().slice(0, 10).map((n) => n.label.value),
        推断的边数: g.stats()["inferred_edges"],
        说明: "推断的边是系统按节点编号顺序补的，材料里没有直接依据",
      };
    },
  );

  // ── decision.record ─────────────────────────────────────────
  reg.fn(
    {
      name: "decision.record",
      description:
        "记下用户拍板的一条约定（口径、命名、范围）。它会进后续每个抽取节点的上下文。" +
        "**只在用户明确表态时调**——他在问「口径是什么」不是在定口径。",
      schema: {
        type: "object",
        required: ["kind", "statement", "quote"],
        properties: {
          kind: { type: "string", enum: ["caliber", "naming", "scope", "correction"] },
          statement: { type: "string", description: "用他的原话，不要改写" },
          quote: {
            type: "string",
            description:
              "用户**这次真的说过**的一小段原话（照抄，标点可以不一致）。它会作为这条约定的" +
              "出处存下来。你自己推出来的、或从上下文里读到的结论**不算**用户说过 —— " +
              "那种情况下这条只在本会话生效。",
          },
          scope_refs: {
            type: "array",
            items: { type: "string" },
            description: "限定作用的对象 rid；全局约定留空",
          },
        },
      },
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    async (args) => {
      const kind = str(args["kind"]);
      const statement = str(args["statement"]);
      const quote = str(args["quote"]);
      const scopeRefs = Array.isArray(args["scope_refs"]) ? (args["scope_refs"] as string[]) : [];
      const d = dialogueOf(s).decide(parseDecisionKind(kind), statement, { scopeRefs });
      // 会话级落库靠这一轮收尾时的 persist；项目记忆不在那条路上，显式写一次。
      // quote 校验不过就只写本会话 —— 见 rememberDecision 与 userSaid。
      await deps.rememberDecision(s, d, { quote });
      const grounded = Boolean(userSaid(dialogueOf(s), quote));
      const shared = Boolean(s.projectId) && PROMOTABLE.has(d.kind) && grounded;
      const out: Record<string, unknown> = {
        已记下: d.render(),
        类型: kind,
        生效范围:
          "后续每个抽取节点；已抽好的部分要重跑才应用" +
          (shared ? "；同项目的其它会话也会看到" : ""),
        当前生效的约定数: dialogueOf(s).activeDecisions().length,
      };
      if (s.projectId && PROMOTABLE.has(d.kind) && !grounded) {
        out["只在本会话生效"] =
          "没能在用户说过的话里找到 quote。跨项目生效的约定必须指得出他说的是哪句 —— " +
          "他确实表过态的话，照抄那一小段重调一次。";
      }
      return out;
    },
  );

  // ── suggestion.apply ────────────────────────────────────────
  reg.fn(
    {
      name: "suggestion.apply",
      description:
        "采纳或否决一条建议。采纳会**真的改产物**（补关系、标记排除等）。" +
        "调之前必须先用 session.status 看清有哪些建议、序号是几。",
      schema: {
        type: "object",
        required: ["index", "accept"],
        properties: {
          index: { type: "integer", description: "从 1 开始" },
          accept: { type: "boolean" },
        },
      },
      // EXTERNAL 而不是 WRITE_LOCAL：`requiresApproval` 只认 EXTERNAL，
      // 而"把 20 个对象标成排除"是不可逆的（代码里没有 un-exclude）。
      // 分级的语义在这里让位于后果的语义。
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    (args) => {
      const index = Number(args["index"]);
      const accept = args["accept"] === undefined ? true : args["accept"] === true;
      if (accept && isBusy(s)) {
        // 改的是上一轮留在 state 里的 OIR，而 _run_pipeline 跑完会整个覆盖它
        // —— 用户的采纳被静默吞掉，没有任何报错。
        return { error: "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。" };
      }
      const ss = stateList(s, "suggestions");
      if (!(index >= 1 && index <= ss.length)) {
        return { error: `没有第 ${index} 条建议，现在共 ${ss.length} 条` };
      }
      const sug = ss[index - 1] as Record<string, unknown>;
      dialogueOf(s).decide(DecisionKind.ADOPTION, `${accept ? "采纳" : "否决"}：${str(sug["title"])}`, {
        scopeRefs: [str(sug["id"])],
      });
      if (!accept) return { 已否决: sug["title"], 产物未改动: true };
      const oir = s.state["_oir"];
      if (oir === null || oir === undefined) return { error: "还没有产物，先跑一轮梳理" };
      const applied = applySuggestion(oir as OIR, sug, { note: `对话中采纳：${str(sug["title"])}` });
      s.state["oir"] = (oir as OIR).toDict();
      s.emit("human.recorded", {
        conflict: sug["id"],
        option: "adopt",
        label: applied.label,
        changed: applied.changed,
      });
      return {
        已采纳: sug["title"],
        实际改动数: applied.changed.length,
        改动类型: applied.kind,
        下一步:
          applied.changed.length > 0 ? "说「重出模板」才会按新结果重编译" : "这条没有可自动执行的动作",
      };
    },
  );

  // ── oir.add / oir.edit 的共用落地 ───────────────────────────
  /** 口述的事实进 OIR，一律标人工来源（USER）。 */
  function doOirEdit(op: string, args: Args): Record<string, unknown> {
    const oir = s.state["_oir"];
    if (oir === null || oir === undefined) return { error: "还没有产物，先跑一轮梳理。" };
    if (isBusy(s)) {
      // 改的是上一轮留在 state 里的 OIR，_run_pipeline 跑完会整个覆盖它
      return { error: "梳理正在跑，现在改产物会在它跑完时被覆盖。等一下。" };
    }
    const clean: Args = {};
    for (const [k, v] of Object.entries(args)) if (v !== null && v !== undefined) clean[k] = v;
    const versions = pushVersion(s, "_oir_versions", (oir as OIR).toDict());
    const patch = ensureList(s, "_oir_patch_log");
    patch.push({ op, args: clean });
    let note: string;
    try {
      note = applyOirEdit(oir as OIR, op, clean);
    } catch (exc) {
      if (!(exc instanceof OIREditError)) throw exc;
      versions.pop();
      patch.pop();
      return { error: excText(exc), 改动: "无（这次编辑没做）" };
    }
    s.state["oir"] = (oir as OIR).toDict();
    writeFileSync(
      join(s.dir, "oir.json"),
      pyJsonIndent((oir as OIR).toDict(), 1),
      "utf8",
    );
    // 记一条 CORRECTION 决定 —— 既落当前产物，也进后续重抽的上下文
    dialogueOf(s).decide(DecisionKind.CORRECTION, `人工口述改本体：${note}`);
    s.emit("oir.edited", { op, note, stats: (oir as OIR).stats() });
    s.emit("human.recorded", { kind: "oir", note });
    return {
      已改: note,
      当前: (oir as OIR).stats(),
      下一步: "说「重出模板」按新结果重编译（会保留你的模板手工修改）",
    };
  }

  // ── oir.undo ────────────────────────────────────────────────
  reg.fn(
    {
      name: "oir.undo",
      description: "撤销上一次人工本体编辑，并恢复对应证据与来源。",
      schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    () => {
      if (isBusy(s)) return { error: "梳理正在跑，暂时不能撤销本体编辑。" };
      const versions = stateList(s, "_oir_versions");
      if (versions.length === 0) return { error: "没有可撤销的本体编辑。" };
      const previous = versions.pop() as Record<string, unknown>;
      const log = s.state["_oir_patch_log"];
      if (Array.isArray(log) && log.length > 0) log.pop();
      const restored = oirFromDict(previous);
      s.state["_oir"] = restored;
      s.state["oir"] = restored.toDict();
      writeFileSync(join(s.dir, "oir.json"), pyJsonIndent(previous, 1), "utf8");
      s.emit("oir.edited", { op: "undo", note: "已撤销上一次本体编辑", stats: restored.stats() });
      return { 已撤销: true, 当前: restored.stats(), 剩余版本: versions.length };
    },
  );

  // ── oir.add ─────────────────────────────────────────────────
  reg.fn(
    {
      name: "oir.add",
      description:
        "口述新增本体事实：加数据对象/属性/关系/Action/业务规则/枚举状态值。FDE 说出材料没写" +
        "但他知道的事实（如「采购包创建后状态变成已发布」= 给采购包.状态加取值" +
        "「已发布」，且/或加一条 PROCESS 规则）。**你只选 op 和参数，绝不重写整份 OIR** —— " +
        "重写会抹掉其它断言的溯源。新增内容一律标「人工口述」(Origin=USER)，在 OIR 里" +
        "可见、可信度高，但绝不冒充材料抽取。改完让用户「重出模板」。",
      schema: {
        type: "object",
        required: ["op"],
        properties: {
          op: {
            type: "string",
            enum: [
              "add_object_type",
              "add_property",
              "add_link",
              "add_action_type",
              "add_rule",
              "add_enum_value",
            ],
          },
          object: { type: "string", description: "add_property 的所属对象名" },
          api_name: { type: "string" },
          display_name: { type: "string" },
          base_type: {
            type: "string",
            enum: ["STRING", "INTEGER", "DECIMAL", "DATE", "TIMESTAMP", "BOOLEAN", "ENUM"],
          },
          cardinality: {
            type: "string",
            enum: ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"],
          },
          source: { type: "string", description: "add_link 起点对象" },
          target: { type: "string", description: "add_link 终点对象" },
          statement: { type: "string", description: "add_rule 规则原文" },
          kind: {
            type: "string",
            enum: ["VALIDATION", "PROCESS", "AUTHORITY", "CALCULATION", "OTHER"],
          },
          applies_to: {
            type: "array",
            items: { type: "string" },
            description: "add_rule/add_action_type 关联哪些对象",
          },
          parameters: {
            type: "array",
            items: { type: "object" },
            description: "Action 的结构化参数",
          },
          effects: {
            type: "array",
            items: { type: "string" },
            description: "Action 执行后的业务效果",
          },
          source_endpoint: { type: "object", description: "可选的 ERP/API 端点映射" },
          actor: { type: "string" },
          definition: { type: "string" },
          required: { type: "boolean" },
          property: { type: "string", description: "add_enum_value 的属性，可写「对象.属性」" },
          value: { type: "string", description: "add_enum_value 的取值" },
        },
      },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    (args) => {
      const { op, ...rest } = args;
      return doOirEdit(str(op), rest);
    },
  );

  // ── oir.edit ────────────────────────────────────────────────
  reg.fn(
    {
      name: "oir.edit",
      description:
        "改已有本体事实：改某个断言值（口径/命名/类型/基数/必填）、标记状态（确认/排除）、" +
        "把规则/Action 挂到数据对象、删除人工误加的元素。**只选 op 和参数**。改动标「人工口述」，" +
        "保留未触碰部分的溯源。材料抽出来的元素不能硬删（会丢证据），要排除用 " +
        "set_status(status=rejected)。",
      schema: {
        type: "object",
        required: ["op"],
        properties: {
          op: {
            type: "string",
            enum: [
              "edit_assertion",
              "set_status",
              "bind_rule",
              "set_action_scope",
              "remove_object_type",
              "remove_property",
              "remove_link",
              "remove_action_type",
              "remove_rule",
            ],
          },
          target: { type: "string", description: "要改的对象/属性/关系/规则（名字或 rid）" },
          field: {
            type: "string",
            description: "edit_assertion 改哪个字段（displayName/definition/base_type/required/actor…）",
          },
          value: { type: "string" },
          status: {
            type: "string",
            enum: ["candidate", "proposed", "confirmed", "rejected"],
          },
          rule: { type: "string", description: "bind_rule 的规则" },
          action: { type: "string", description: "set_action_scope 的 Action" },
          objects: {
            type: "array",
            items: { type: "string" },
            description: "set_action_scope 关联的数据对象",
          },
          object: { type: "string", description: "bind_rule 的对象" },
          note: { type: "string" },
        },
      },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    (args) => {
      const { op, ...rest } = args;
      return doOirEdit(str(op), rest);
    },
  );

  // ── build.start ─────────────────────────────────────────────
  reg.fn(
    {
      name: "build.start",
      description:
        "开始梳理已上传的材料：解析 → 抽取 → 建本体与流程图 → 出模板。" +
        "用户表达了「开始梳理 / 帮我分析这些材料 / 跑一遍」这类意思就**直接调，" +
        "不要再反问一次确认**。",
      schema: { type: "object", properties: {} },
      // WRITE_LOCAL 而不是 EXTERNAL：梳理是这个产品**本来就要做的事**，
      // 用户上传材料并说「开始」时再弹一次"这要花钱，确认吗"是多余的一轮，
      // 而且把主流程挡在确认门后面。花费仍然记账、仍受预算上限约束。
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    async () => {
      let outcome = await deps.claimAndStartBuild(s);
      // 抢不到租约时会退回**会话的真实状态**。它可能恰恰是 idle —— 也就是
      // "没人在跑，只是这次没抢到"（一次事务争用就够）。原来这里一律回
      // "已经在跑了"：一句彻头彻尾的假话，而且把模型逼进死角 —— 它查 status
      // 是 idle、查 oir 说没跑过、启动又说在跑，最后只能**手工编一套 Action/
      // Event 出来交差**。宁可重试一次，也不能让它对着矛盾的回执瞎编。
      if (BUILD_STARTABLE.includes(outcome)) outcome = await deps.claimAndStartBuild(s);
      if (outcome === "no_files") return { error: "还没有材料" };
      if (outcome === "missing") return { error: "这个会话已经不存在了" };
      if (outcome === "awaiting_answer") {
        return { error: "当前正在等待业务回答；请先处理问题清单。" };
      }
      if (outcome === "queued" || outcome === "parsing" || outcome === "extracting") {
        return {
          error: `已经在跑了（状态：${outcome}），不用重复启动。`,
          说明: "过程在推理轨迹里逐步显示；跑完会有产物。",
        };
      }
      if (outcome !== "started") {
        return {
          error: `没能启动，会话状态是「${outcome}」。`,
          "**不要自己编产物**":
            "本体/流程图必须由梳理管线从材料里抽出来。启动不了就如实告诉用户启动失败，" +
            "**绝不能手写一份 Action/Event 交给他** —— 那是凭空捏造的，没有任何材料依据。",
        };
      }
      return { 已启动: true, 材料份数: s.files.length, 说明: "过程会在推理轨迹里逐步显示" };
    },
  );

  // ── flow.edit ───────────────────────────────────────────────
  reg.fn(
    {
      name: "flow.edit",
      description:
        "改业务流程图：给节点改名/指定执行者/移到别的阶段、加节点、连边或删边、" +
        "给网关分支贴条件标签、删节点。**你只选 op 和参数，不重画整张图** —— " +
        "重画会丢掉每个节点的证据链。你手动加的节点和边会在图上标成人工添加" +
        "（和材料抽出来的区分开）。改完自动重出 SVG。",
      schema: {
        type: "object",
        required: ["op"],
        properties: {
          op: {
            type: "string",
            enum: [
              "rename_node",
              "set_actor",
              "set_stage",
              "add_node",
              "connect",
              "disconnect",
              "remove_node",
              "set_branch_label",
            ],
          },
          node: { type: "string", description: "节点名/编号（多数 op 用）" },
          label: { type: "string", description: "新名字/边标签/新节点名" },
          actor: { type: "string" },
          stage: { type: "string" },
          kind: {
            type: "string",
            enum: ["action", "event", "gateway", "terminal", "external"],
          },
          source: { type: "string", description: "连/删边的起点节点" },
          target: { type: "string", description: "连/删边的终点节点" },
        },
      },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    (args) => {
      const { op: rawOp, ...rest } = args;
      const op = str(rawOp);
      if (isBusy(s)) return { error: "梳理正在跑，流程图编辑要等当前版本提交后再执行。" };
      const g = s.state["_flow"];
      if (!(g instanceof FlowGraph)) {
        return { error: "还没有流程图。材料里要有结构化的流程说明才抽得出来。" };
      }
      // 编辑前存版本（封顶）—— 和模板编辑一样，改错了要能回退
      const versions = pushVersion(s, "_flow_versions", g.toDict());
      const clean: Args = {};
      for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) clean[k] = v;
      // 记进补丁日志 —— 补料重跑时 _replay_flow_patches 会把它重放回新图
      const patch = ensureList(s, "_flow_patch_log");
      patch.push({ op, args: clean });
      let note: string;
      try {
        note = deps.applyFlowEdit(g, op, clean);
      } catch (exc) {
        if (!(exc instanceof FlowEditError)) throw exc;
        versions.pop();
        patch.pop();
        return { error: excText(exc), 改动: "无（这次编辑没做）" };
      }
      // 全图 + 主干 + mermaid + flow.json 一把重出（含主干图，修掉编辑后主干图不更新）
      deps.rewriteFlowArtifacts(s, g);
      s.emit("flow.ready", { stats: g.stats(), edited: note });
      return {
        已改: note,
        当前: g.stats(),
        版本: versions.length,
        提示: "流程图已重出，右侧「流程图」标签页能看到",
      };
    },
  );

  // ── flow.undo ───────────────────────────────────────────────
  reg.fn(
    {
      name: "flow.undo",
      description: "撤销上一次流程图编辑，回到编辑前的版本。改完自动重出 SVG/主干图。",
      schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    () => {
      if (isBusy(s)) return { error: "梳理正在跑，暂时不能撤销流程图。" };
      const versions = stateList(s, "_flow_versions");
      if (versions.length === 0) return { error: "没有可撤销的流程图编辑。" };
      const prev = versions.pop() as Record<string, unknown>;
      const log = s.state["_flow_patch_log"];
      if (Array.isArray(log) && log.length > 0) log.pop();
      // flowFromDict 原样还原 human/extracted/inferred 溯源 —— 回退不该把
      // 人工加的节点降级成推断，也不该把材料证据抹平
      const g = flowFromDict(prev);
      deps.rewriteFlowArtifacts(s, g);
      s.emit("flow.ready", { stats: g.stats(), edited: "已撤销上一次编辑" });
      return {
        已撤销: true,
        当前: g.stats(),
        剩余版本: versions.length,
        提示: "流程图已回退，右侧「流程图」标签页能看到",
      };
    },
  );

  // ── flow.preview ────────────────────────────────────────────
  reg.fn(
    {
      name: "flow.preview",
      description:
        "免费出一版业务流程图：只解析材料 + 抽流程，**不做付费的完整抽取**。" +
        "文本/表格/SQL 零成本；扫描件/PDF 因视觉解析会有少量费用。想先看流程图、" +
        "再决定要不要跑完整梳理时用它。",
      schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    async () => {
      const outcome = await deps.claimAndStartBuild(s, { tier: "flow_preview" });
      if (outcome === "no_files") return { error: "还没有材料，先上传。" };
      if (outcome === "missing") return { error: "这个会话已经不存在了。" };
      if (outcome === "awaiting_answer") {
        return { error: "当前正在等待业务回答；请先处理问题清单。" };
      }
      if (outcome !== "started") return { error: "已经在跑了。" };
      return {
        已启动: "免费流程预览",
        说明: "只解析 + 出流程图，跳过付费抽取；过程在推理轨迹里显示。",
      };
    },
  );

  // ── flow.sketch ─────────────────────────────────────────────
  //
  // `flow.preview` 的**前一步**：那条要先有材料，这条一份材料都不要。
  //
  // 为什么要显式区分两者、而不是让 flow.preview "没材料时就凭通识画一张"：
  // 那样两张图会共用同一个产物位、同一个 flow 会话状态，于是「这张图是从客户材料
  // 里读出来的现状，还是模型编的行业通识」变成一个要靠时间线去猜的问题。这个产品
  // 的硬要求是问题清单/流程图/模板列都要从证据推出来 —— 一张来自模型知识的图
  // 混进证据链，冲突检测会拿它去和客户材料对撞、缺口挖掘会为一个客户根本没有的
  // 环节生成问题，而到那时已经分不清哪些结论有依据。所以这条：
  //
  //   · 产物落 `exports/`，**不进**会话根目录（根目录下的文件会被算成产物、
  //     进产物 tab、进交付包 zip）；
  //   · **一个字都不写** `_flow` / `flow` / `_oir` / `oir` / `artifacts`；
  //   · 标题、文件名、聊天卡片三处都带 SKETCH_MARK。
  //
  // 详细的理由见 `onto/flow_sketch.ts` 的文件头。
  reg.fn(
    {
      name: "flow.sketch",
      description:
        "**还没有材料**的时候，凭领域通识画一张参考流程图。用户说「一般采购流程" +
        "是什么，画出来」「先给我看看报销流程长什么样」时用它 —— 这时候 " +
        "flow.preview 走不动（那条要先有材料）。\n" +
        "产出的是**通用参考图，不是从客户材料抽的**，图上、文件名上都标着。" +
        "你转述时也必须说明这一点，并且建议拿它去跟业务方对、再上传材料跑真流程。\n" +
        "domain 写领域/主题（采购、报销、入职、门诊、放款…都行）。" +
        "**材料已经上传过、用户问的是「我们的流程」时不要用它** —— 那种情况用 " +
        "flow.preview 或 flow.query。",
      schema: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: {
            type: "string",
            description: "领域/主题，如「采购」「医疗门诊」「设备维修」。用用户自己的说法",
          },
          // 这两个**故意不写 enum**（照 export.file 的 format 那条）：契约层的 enum
          // 会在处理器有机会说人话之前就把调用整个拒掉，而模型看到的是一句
          // ToolDenied、不是"只能是 brief/standard/detailed，不给就是 standard"。
          // 后者它能据此改对，前者只会让它换个工具再试一遍。
          detail: {
            type: "string",
            description: `详细程度：${SKETCH_DETAILS.join(" / ")}（默认 standard）。` +
              "brief 6–10 个环节 / standard 12–20 / detailed 22–34",
          },
          format: {
            type: "string",
            description: "svg（默认，能缩放、能改）或 png（要贴进 PPT 的位图）",
          },
        },
      },
      // 只写本地文件、不碰 OIR —— 与 flow.preview 同一档。
      danger: Danger.WRITE_LOCAL,
      // RW（只给工作模式）：它要花一次模型调用。聊天模式那条路是"就已上传的材料
      // 对话"，不该能从那儿发起付费生成。
      scopes: RW,
    },
    async (args) => {
      const domain = str(args["domain"]).trim();
      if (!domain) {
        return { error: "要画哪个领域的流程？给一个主题，比如「采购」「报销」「门诊」。" };
      }
      const format = (str(args["format"]).trim() || "svg").toLowerCase();
      if (format !== "svg" && format !== "png") {
        return { error: `format 只能是 svg 或 png，收到「${format}」。` };
      }
      let detail;
      try {
        detail = parseSketchDetail(args["detail"]);
      } catch (exc) {
        if (!(exc instanceof SketchError)) throw exc;
        return { error: excText(exc) };
      }
      // **故意不看 isBusy**：这条不碰任何会话产物，梳理跑着的时候画一张参考图
      // 既不冲突也不会被覆盖。挡住它只会让用户在最想讨论流程的那几分钟里没图可看。

      // ── 让模型出结构（不是出 SVG）──────────────────────────
      let data: unknown;
      try {
        data = await deps.chatRun(
          s,
          { kind: "flow_sketch", semanticInput: { domain, detail } },
          async (run) => {
            const comp = await run.gw.call("FLOW_SKETCH", sketchPrompt({ domain, detail }), {
              system: SKETCH_SYSTEM,
              schema: SKETCH_SCHEMA,
              maxTokens: 8000,
            });
            return comp.data ?? null;
          },
        );
      } catch (exc) {
        // 模型没调通（配额、网络、连撞 schema）。和"结构不合用"分开报 ——
        // 前者等一会儿再试，后者是让模型重出一遍，两条下一步完全不同。
        return { error: `参考图没画成：${excName(exc)}: ${excText(exc)}` };
      }

      let g: FlowGraph;
      try {
        g = graphFromSketch(data, { domain });
      } catch (exc) {
        // 畸形结构给**可读的**错误，不是崩。这句话模型看得懂（它能据此重出一版），
        // 用户也看得懂（他至少知道是模型没写对，不是系统坏了）。
        if (!(exc instanceof SketchError)) throw exc;
        return { error: `模型给的流程结构不合用：${excText(exc)}` };
      }

      // ── 出图（第一处标注：SVG 标题）────────────────────────
      const title = sketchTitle(domain);
      const svg = toSvg(g, { title });

      // ── 落盘（第二处标注：文件名）──────────────────────────
      // `exports/` 而不是会话根目录 —— 理由见上面那段。
      const outdir = join(s.dir, "exports");
      mkdirSync(outdir, { recursive: true });
      const svgName = sketchFileName(domain, "svg");
      writeFileSync(join(outdir, svgName), svg, { flag: "w" });
      // mermaid 一起落：`diagram.ts` 文件头那条 —— 能被人接手改的草稿才是草稿。
      // 参考图尤其如此，FDE 拿它去开会，回来第一件事就是照业务方的话改。
      const mmdName = sketchFileName(domain, "mmd");
      writeFileSync(join(outdir, mmdName), toMermaid(g), { flag: "w" });

      let pngName = "";
      let pngNote = "";
      if (format === "png") {
        try {
          const out = await deps.renderSvgPng(svg);
          pngName = sketchFileName(domain, "png");
          writeFileSync(join(outdir, pngName), out.png, { flag: "w" });
        } catch (exc) {
          // **不静默降级。** SVG 照样给（它是好的），但必须有一句话说清 PNG 没出来、
          // 为什么、以及模型要把这件事转述给用户 —— 一个以为自己拿到了 PNG 的人，
          // 会在打开 PPT 准备贴图的时候才发现，那时候他已经在会议室里了。
          pngNote =
            `PNG 没生成（${excName(exc)}: ${excText(exc)}）。` +
            "SVG→PNG 在本进程内渲染，这一张没渲染成。" +
            "**下面给的是 SVG，不是 PNG** —— 回答里必须说这一句。";
        }
      }

      // ── 聊天卡片（第三处标注：source_note）─────────────────
      // 事件类型和 `export.ready` 分开：那张卡是"他随口要的一份拷贝"，这张是
      // 一张带着"非证据"标记的参考图，两者混成一种卡片，标记就没地方挂。
      const stats = g.stats();
      s.emit("sketch.ready", {
        name: svgName,
        mermaid: mmdName,
        png: pngName,
        domain,
        title,
        detail,
        size: Buffer.byteLength(svg, "utf8"),
        stats,
        source_note: SKETCH_MARK,
        caveat: SKETCH_CAVEAT,
      });

      const caveats = sketchCaveats(data);
      const out: Record<string, unknown> = {
        已生成: svgName,
        来源: SKETCH_MARK,
        领域: domain,
        规模: `${stats["actions"] ?? 0} 个 Action ｜ ${stats["events"] ?? 0} 个 Event ｜ ${stats["stages"] ?? 0} 个阶段`,
        说明:
          `卡片和下载按钮已经显示给用户了。**转述时必须说清这是通用参考、不是从他的` +
          `材料里抽的**（${SKETCH_CAVEAT}）。不要贴链接、不要说存在哪个目录。`,
        没写进产物: "这张图不进产物列表、不进交付包、不影响后续抽取 —— 它是参考图，不是交付物。",
      };
      if (caveats.length > 0) {
        out["要跟业务方确认的差异点"] = caveats.slice(0, 5);
      }
      if (pngName) out["PNG"] = pngName;
      if (pngNote) out["PNG不可用"] = pngNote;
      return out;
    },
  );

  // ── template.edit ───────────────────────────────────────────
  reg.fn(
    {
      name: "template.edit",
      description:
        "改当前填写模板的结构：加列/删列/改列名/改必填性/改下拉/改说明/调表顺序。" +
        "**你只选 op 和参数，绝不直接产出 xlsx** —— 那样隐藏的回读锚点列必丢。" +
        "每次编辑后系统自动跑守卫，违反往返契约会被拒并告诉你原因。" +
        "改完记得让用户「重出模板」才会生成新 xlsx。",
      schema: {
        type: "object",
        required: ["op"],
        properties: {
          op: {
            type: "string",
            enum: [
              "add_column",
              "drop_column",
              "rename_column",
              "set_role",
              "set_options",
              "set_guide",
              "reorder_sheets",
            ],
          },
          sheet: { type: "string", description: "目标表名" },
          name: { type: "string", description: "add_column：新列名" },
          column: { type: "string", description: "drop/set_role/set_options：列名" },
          old: { type: "string" },
          new: { type: "string" },
          role: { type: "string", enum: ["locked", "prefilled", "required"] },
          value: { type: "string" },
          comment: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          text: { type: "string", description: "set_guide：新说明" },
          order: { type: "array", items: { type: "string" } },
        },
      },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    (args) => {
      const { op: rawOp, ...rest } = args;
      const op = str(rawOp);
      if (isBusy(s)) return { error: "梳理正在跑，模板编辑要等当前版本提交后再执行。" };
      const sp = join(s.dir, "template.spec.json");
      if (!existsSync(sp)) return { error: "还没有模板可以改，先跑一轮梳理。" };
      const spec = TemplateSpec.load(sp);
      // 每次编辑前存一个版本（封顶）—— 改错了要能回退。审查特别强调：没有版本
      // 的编辑等于每一步都覆盖上一步、无法挽回。
      const versions = pushVersion(s, "_tpl_versions", spec.toDict());
      const clean: Args = {};
      for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) clean[k] = v;
      // 记进补丁日志 —— 重出模板时在「按新 OIR 编译」的 spec 上重放这些结构编辑，
      // 让采纳/口述改的 OIR 能进这张手改模板（reconcileTemplate）
      const patch = ensureList(s, "_tpl_patch_log");
      patch.push({ op, args: clean });
      let note: string;
      try {
        note = applyEdit(spec, op, clean);
      } catch (exc) {
        if (!(exc instanceof EditError)) throw exc;
        versions.pop(); // 没改成，撤掉这个版本点
        patch.pop();
        return { error: excText(exc), 改动: "无（守卫拒绝了这次编辑）" };
      }
      spec.save(sp);
      s.state["template"] = spec.stats();
      s.emit("template.edited", { op, note, stats: spec.stats(), version: versions.length });
      return {
        已改: note,
        当前: spec.stats(),
        版本: versions.length,
        下一步: "说「重出模板」生成新 xlsx，或「撤销上一步改动」回退",
      };
    },
  );

  // ── template.undo ───────────────────────────────────────────
  reg.fn(
    {
      name: "template.undo",
      description: "撤销上一次模板编辑，回到编辑前的版本。",
      schema: { type: "object", properties: {} },
      danger: Danger.WRITE_LOCAL,
      scopes: RW,
    },
    () => {
      if (isBusy(s)) return { error: "梳理正在跑，暂时不能撤销模板。" };
      const versions = stateList(s, "_tpl_versions");
      if (versions.length === 0) return { error: "没有可撤销的编辑。" };
      const prev = versions.pop() as Record<string, unknown>;
      // 补丁日志的尾也一起弹，保 undo 与重放一致（否则撤销后重放又把它加回来）
      const log = s.state["_tpl_patch_log"];
      if (Array.isArray(log) && log.length > 0) log.pop();
      const spec = TemplateSpec.fromDict(prev);
      spec.save(join(s.dir, "template.spec.json"));
      s.state["template"] = spec.stats();
      s.emit("template.edited", {
        op: "undo",
        note: "已撤销上一次编辑",
        stats: spec.stats(),
        version: versions.length,
      });
      return { 已撤销: true, 当前: spec.stats(), 剩余版本: versions.length };
    },
  );

  // ── template.recompile ──────────────────────────────────────
  reg.fn(
    {
      name: "template.recompile",
      description:
        "按当前产物重出模板。**零模型调用**（对齐/冲突/编译都是确定性的），" +
        "和重跑梳理完全不同——后者要重新抽取、要花钱。",
      schema: { type: "object", properties: {} },
      danger: Danger.EXTERNAL,
      scopes: RW,
    },
    async () => {
      if (s.state["_oir"] === null || s.state["_oir"] === undefined) {
        return { error: "还没有产物" };
      }
      if (isBusy(s)) {
        return {
          error: "梳理正在跑，这时候重出模板会覆盖掉正在生成的产物。等它跑完再说。",
        };
      }
      // 模板被对话编辑过 → **不能**裸走 recompile（那会从 OIR 重编译、把手改整个
      // 覆盖），也**不能**只渲染冻结 spec（那样采纳/口述改的 OIR 又进不来）。正解是
      // reconcile：按最新 OIR 新编译，再把结构手改重放上去 —— 两头都不丢。
      if (pyTruthy(s.state["_tpl_patch_log"])) {
        const oir = s.state["_oir"] as OIR;
        const conflicts = stateList(s, "_conflicts");
        const [spec, stale] = reconcileTemplate(
          oir,
          conflicts as never,
          s.state["_tpl_patch_log"] as never,
        );
        spec.save(join(s.dir, "template.spec.json"));
        const x = await writeXlsx(spec, join(s.dir, "模板_v1.xlsx"), {
          project: s.project || s.title,
        });
        writeFileSync(join(s.dir, "oir.json"), pyJsonIndent(oir.toDict(), 1), "utf8");
        s.state["oir"] = oir.toDict();
        s.state["template"] = spec.stats();
        s.state["artifacts"] = pySorted(
          readdirSync(s.dir).filter((a) => statSync(join(s.dir, a)).isFile()),
        );
        s.emit("artifact.ready", { artifact: "template", name: basename(x), stats: spec.stats() });
        if (stale.length > 0) {
          s.emit("template.stale_edits", {
            count: stale.length,
            items: stale.map((p) => ({ op: p.op, why: p.why })),
          });
        }
        return {
          已重出: "已把 OIR 改动合并进你的手改模板",
          没能重放的手改: stale.length,
          ...spec.stats(),
        };
      }
      await deps.recompile(s);
      const t = asRecord(s.state["template"]);
      return {
        已重出: true,
        表数: t["sheets"] ?? null,
        预填格数: t["prefilled"] ?? null,
        业务必填: t["business_required"] ?? null,
      };
    },
  );

  return reg;
}

// ══════════════════════════════════════════════════════════════════
//  局部工具
// ══════════════════════════════════════════════════════════════════

/** Python 的 `s.state.setdefault(key, [])`。 */
function ensureList(s: SessionLike, key: string): Record<string, unknown>[] {
  const cur = s.state[key];
  if (Array.isArray(cur)) return cur as Record<string, unknown>[];
  const fresh: Record<string, unknown>[] = [];
  s.state[key] = fresh;
  return fresh;
}
