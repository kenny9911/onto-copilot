/**
 * `_export_doc`（`server.py:3039`）—— `export.file` 工具背后那台组装机。
 *
 * 按 `source` 把"要导出的东西"组装成一份 {@link ExportDoc}，组不出来时返回
 * `(null, 回执)`。
 *
 * ── 为什么组不出来的时候要说清是**哪一步**没有东西 ──────────────────────
 *
 * 一句"导出失败"会让模型转头跟用户说"系统限制"，而真实原因往往是他还没列过表、
 * 或者还没跑梳理 —— 那是能补的。所以每条 error 都带一句「下一步」，而且带的是
 * 具体的工具名，不是"请稍后重试"。
 *
 * ── 屏幕上的行数与文件里的行数是两回事 ──────────────────────────────────
 *
 * `ui.table` 事件里的 `rows` 是**给屏幕看的**，封了顶；文件没有这个限制。所以
 * `last_table` 这一档按事件里记的来源配方 {@link fullRowsFor} 重算全量。补不回
 * 全量时**必须说出来**，标题里那个数字也不能留着骗人 —— 否则会导出一个叫
 * 「问题清单（900 行）.xlsx」、里面只有 500 行的文件，而 FDE 会把它当完整清单
 * 发给客户。
 */

import { pyJsonDumps } from "../../kernel/journal.js";
import type { DialogueMemory } from "../../kernel/memory/dialogue.js";
import type { ParserRegistry } from "../../onto/parse/base.js";
import {
  blocksFromMarkdown,
  makeBlock,
  makeExportDoc,
  type ExportMeta,
  tableBlock,
  type Block,
  type ExportDoc,
} from "../../onto/export.js";
import {
  OIR_COLS,
  conversationTables,
  fullRowsFor,
  oirTable,
  pickTable,
  pyStr,
  pyTruthy,
  titleSimilarity,
} from "../pipeline/tables.js";
import type { MarkdownBlockLike, SessionLike } from "../pipeline/types.js";
import { seam } from "./deps.js";
import { pyStrip } from "../../onto/canonical.js";
import { assessReadiness } from "../../onto/readiness.js";
import { toErMermaid } from "../../onto/diagram_er.js";
import { OIR } from "../../onto/oir.js";
import { projectFourA } from "../../onto/architecture.js";
import { buildFdeReviewReadModel } from "../../review/fde-read-model.js";
import { QuestionBacklog, type Question } from "../../onto/questions.js";
import type { Repo } from "../../store/repo/protocol.js";

/** `_export_doc` 要用到的外部世界。`serve.ts` 里绑一次。 */
export interface ExportDocDeps {
  /**
   * 现在几点（epoch 秒）。**由调用方注入** —— 模块内部读时钟会打破
   * `onto/export.ts` 那条「同样输入同样字节」的不变量（ZIP_EPOCH 就是为它存在的），
   * 也会让 golden 每跑一次变一次。不给就不在文档头写生成时间。
   */
  readonly now?: () => number;
  readonly repo: () => Repo;
  /** `onto/diagram.ts` 的 toMermaid —— source=ontology 的流程段用。不给就跳过流程段。 */
  readonly toMermaid?: (flow: unknown) => string;
  /** `_dialogue(s)`（`server/dialogue/memory.ts` 的 `dialogueOf`）。 */
  readonly dialogue: (s: SessionLike) => DialogueMemory;
  /** `onto.parse.default_registry()` —— `_full_rows_for` 重读原始材料要它。 */
  readonly registry: () => ParserRegistry;
}

/**
 * 标题尾巴上那个「（900 行）」。
 *
 * Python 是 `re.sub(r"（[^（）]*\d+\s*[行条][^（）]*）\s*$", "", name)`。JS 的 `\d`
 * 只认 ASCII，而 Python 的 `\d` 对 str 模式认**全部** Unicode 十进制数字 ——
 * 所以这里写 `\p{Nd}` 加 `u` 标志，不是 `\d`。
 */
const TAIL_COUNT = /（[^（）]*\p{Nd}+\s*[行条][^（）]*）\s*$/u;

/** `int(x or y)`。 */
function pyIntOr(v: unknown, fallback: number): number {
  if (!pyTruthy(v)) return fallback;
  return Math.trunc(Number(v));
}

/**
 * 按 source 组装要导出的内容。返回 `[ExportDoc | null, 组不出来时的回执]`。
 */
/**
 * 连线端点的显示名。找不到节点就打印 rid 本身 —— **绝不留空**：
 * 空格子会把「数据坏了」伪装成「这一格没填」，而后者没人会去查。
 */
function edgeEnd(nodeLabel: Map<string, string>, raw: unknown): string {
  const rid = pyStr(raw ?? "");
  if (!rid || rid === "None") return "（连线缺端点）";
  return nodeLabel.get(rid) ?? `${rid}（节点已不在图上）`;
}

/** 覆盖度的人话 —— 文档里不出现 solid/thin 这种词。 */
const COVERAGE_CN: Record<string, string> = {
  none: "空",
  thin: "只有零星线索",
  partial: "有骨架、缺细节",
  solid: "立得住",
};

/**
 * 文档头的公共部分：生成时间、模型版本、发布状态、用到的材料。
 *
 * 每份文稿只需要补自己特有的那几项（用途 / 给谁看 / 依据 / 回传）。
 * 时间来自 `deps.now`，不给就不写这一项 —— 宁可缺一行，也不让同样的输入
 * 产出不同的字节（golden 与 bundle 的确定性都压在这条上）。
 */
function docMeta(
  s: SessionLike,
  deps: ExportDocDeps,
  own: { purpose?: string; audience?: string; basis?: string; returnTo?: string },
): ExportMeta {
  const at = deps.now?.();
  const materials = (Array.isArray((s as unknown as { files?: unknown[] }).files)
    ? ((s as unknown as { files: Record<string, unknown>[] }).files)
    : []).map((f) => pyStr(f["name"])).filter(Boolean);
  const revision = pyStr(s.state["artifact_revision"] ?? "");
  return {
    ...own,
    ...(at === undefined ? {} : { generatedAt: isoMinute(at) }),
    ...(revision && revision !== "None" ? { revision: `第 ${revision} 版` } : {}),
    ...(materials.length > 0 ? { materials } : {}),
  };
}

/** epoch 秒 → `YYYY-MM-DD HH:MM`（UTC，不看本机时区 —— 时区会让字节随机器变）。 */
function isoMinute(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export async function exportDoc(
  s: SessionLike,
  deps: ExportDocDeps,
  source: string,
  contains: string,
  title: string,
  tableName = "",
): Promise<[ExportDoc | null, Record<string, unknown>]> {
  // ── 统一问题台账 ────────────────────────────────────────────
  // 判据是 `source == "questions" and s.state.get("question_backlog")` —— 台账
  // 还没建起来时**要掉到下面 `_OIR_COLS` 那一档**（"questions" 也是 OIR 的一类），
  // 从本轮梳理的产物里导。少了后半个条件，新会话导问题清单会拿到一份空台账。
  if (source === "questions" && pyTruthy(s.state["question_backlog"])) {
    const backlog = questionBacklogOf(s);
    let items = [...backlog.values()];
    if (contains) {
      const needle = contains.toLowerCase();
      items = items.filter((q) => pyJsonDumps(q.toDict()).toLowerCase().includes(needle));
    }
    if (items.length === 0) return [null, { error: "统一问题台账里没有符合条件的问题。" }];
    const head = ["问题ID", "问题", "状态", "优先级", "回答对象", "负责人", "为什么问"];
    const rows = items.map((q) => [
      q.id,
      q.text,
      String(q.status),
      String(q.priority),
      q.audienceRole,
      q.ownerUserId,
      q.why,
    ]);
    return [
      makeExportDoc({
        title: title || "待澄清问题",
        blocks: tableBlock(head, rows),
        note: `共 ${rows.length} 条，由统一 QuestionBacklog 导出`,
      }),
      {},
    ];
  }

  // ── 会议简报（第 1 层工作坊套件）────────────────────────────
  // 「上次会议以来改了什么、谁拍的板、还差什么」—— 每周客户会的核心素材。
  // 三个来源同处一份：revision 台账（问答回写 / 对话编辑都在里面 —— 对话编辑
  // 能出现在这儿，靠的是 dialogue_edit revision 那条线）、已生效的口径约定、
  // 问题清单概况。零模型，纯投影。
  // contains 给纯数字 = 只看第 N 版之后（会前只讲增量）；给词 = 按摘要/类型过滤。
  if (source === "changelog") {
    const rows = await deps.repo().listRevisions(s.id);
    const trimmed = pyStrip(contains);
    const after = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const reasonOf = (r: { readonly patch_set: Record<string, unknown> | null }): string => {
      const ps = r.patch_set;
      return ps !== null && typeof ps["reason"] === "string" ? (ps["reason"] as string) : "";
    };
    let items = [...rows].sort((a, b) => a.ordinal - b.ordinal);
    if (after !== null) {
      items = items.filter((r) => r.ordinal > after);
    } else if (trimmed) {
      const needle = trimmed.toLowerCase();
      items = items.filter((r) => `${reasonOf(r)} ${r.kind}`.toLowerCase().includes(needle));
    }
    const decisions = deps.dialogue(s).activeDecisions();
    if (items.length === 0 && decisions.length === 0) {
      return [null, {
        error: after === null ? "还没有任何变更记录。" : `第 ${after} 版之后没有变更。`,
        下一步: "跑一轮梳理、回答问题或在对话里做修改之后再导。",
      }];
    }
    const KIND_CN: Record<string, string> = {
      question_answer: "问答回写",
      dialogue_edit: "对话编辑",
    };
    const counts = new Map<string, number>();
    for (const r of items) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    const blocks: Block[] = [
      makeBlock("para", {
        text:
          `${after === null ? "" : `自第 ${after} 版以来`}共 ${items.length} 条变更` +
          (counts.size > 0
            ? "：" + [...counts].map(([k, c]) => `${KIND_CN[k] ?? k} ${c} 条`).join("、")
            : "") +
          "。",
      }),
    ];
    if (items.length > 0) {
      blocks.push(makeBlock("heading", { text: `变更台账（${items.length}）`, level: 1 }));
      blocks.push(
        ...tableBlock(
          ["版本", "类型", "摘要", "改动范围", "时间（UTC）"],
          items.map((r) => [
            String(r.ordinal),
            KIND_CN[r.kind] ?? r.kind,
            reasonOf(r) || "（未附摘要）",
            r.changed_ids.length > 0 ? `${r.changed_ids.length} 处` : "",
            new Date(r.created * 1000).toISOString().slice(0, 16).replace("T", " "),
          ]),
        ),
      );
    }
    if (decisions.length > 0) {
      blocks.push(
        makeBlock("heading", { text: `已生效的口径约定（${decisions.length}）`, level: 1 }),
      );
      blocks.push(makeBlock("para", { text: decisions.map((d) => d.render()).join("；") }));
    }
    if (pyTruthy(s.state["question_backlog"])) {
      const all = [...questionBacklogOf(s).values()];
      const open = all.filter((q) => !q.terminal).length;
      blocks.push(
        makeBlock("para", { text: `待确认问题：未关闭 ${open} 条 / 共 ${all.length} 条。` }),
      );
    }
    return [
      makeExportDoc({
        title: title || "变更简报",
        blocks,
        note: "由 revision 台账自动生成；contains 填数字可从第 N 版之后起算。",
      }),
      {},
    ];
  }

  // ── 一键访谈包（R5）──────────────────────────────────────────
  // 访谈是**按人**组织的，不是按问题类型：同一场只见得到一个角色。所以主分组是
  // audienceRole；每题带"为什么问 + 期望答案"（复用 FDE 审阅读模型的领域文案），
  // 并留"您的回答"填写栏 —— **这一栏就是回传闭环的载体**：问题ID + 您的回答
  // 两列齐了，填完的 xlsx 传回来就能对回 Question Ledger。
  if (source === "interview_kit") {
    const backlog = pyTruthy(s.state["question_backlog"]) ? questionBacklogOf(s) : new Map();
    const open = [...backlog.values()].filter((q) => !q.terminal);
    if (open.length === 0) {
      return [
        null,
        {
          error: "没有待确认的问题，访谈包没有内容。",
          下一步: "先跑梳理（会生成待澄清问题），或用 readiness.report 看看缺什么。",
        },
      ];
    }
    const review = buildFdeReviewReadModel(open.map((q) => q.toDict()));
    const expectedOf = new Map<string, string>();
    for (const item of review.items) {
      for (const qid of item.questionIds) {
        if (!expectedOf.has(qid)) expectedOf.set(qid, item.expectedAnswer);
      }
    }
    const byRole = new Map<string, typeof open>();
    for (const q of open) {
      const role = q.audienceRole || "未指定角色";
      const list = byRole.get(role) ?? [];
      list.push(q);
      byRole.set(role, list);
    }
    const blocks: Block[] = [
      makeBlock("para", {
        text:
          "【访谈提纲】以下问题按受访角色分组。请把「您的回答」填在对应栏里 —— " +
          "答不了的写明该找谁；有例外情况写进「例外与备注」。" +
          "填写完成后整份回传给 FDE，答案会逐条对回问题台账。",
      }),
    ];
    for (const [role, qs] of byRole) {
      blocks.push(makeBlock("heading", { text: `${role}（${qs.length} 题）`, level: 1 }));
      blocks.push(
        ...tableBlock(
          ["问题ID", "问题", "为什么问", "期望获得的答案", "您的回答（请填写）", "例外与备注"],
          qs.map((q) => [
            q.id,
            q.text,
            q.why,
            expectedOf.get(q.id) ?? "",
            "",
            "",
          ]),
        ),
      );
    }
    const flowLive = s.state["_flow"];
    if (deps.toMermaid !== undefined && isFlowLike(flowLive)) {
      const mmd = deps.toMermaid(flowLive);
      if (mmd.trim() !== "") {
        blocks.push(makeBlock("heading", { text: "当前流程（供访谈时对照）", level: 1 }));
        blocks.push(makeBlock("code", { text: mmd }));
      }
    }
    return [
      makeExportDoc({
        title: title || "业务访谈提纲",
        blocks,
        note: `共 ${open.length} 题，按角色分 ${byRole.size} 组；由 OntoCopilot 导出`,
      }),
      {},
    ];
  }

  // ── 数据样例回传模板（T2 sample_kit）────────────────────────
  // 实测 semanticType 0/18、unit 0/18、valueDomain 1/18 —— 生成路径填不出、
  // 确认模板又不问，这三个字段永远空。而 FDE 实务里最便宜的补法是让业务方
  // **贴 5 行真实数据**：类型、值域、主键唯一性都能从样例行确定性推出来，
  // 业务方不需要会写「枚举值域」这种词。
  if (source === "sample_kit") {
    const oirLive = s.state["_oir"];
    if (!(oirLive instanceof OIR) || oirLive.objects.size === 0) {
      return [null, {
        说明: "还没有业务对象，出不了样例模板。",
        下一步: "先梳理出对象（build.start 或从通用场景生成草案），再导这份让业务方贴数据。",
      }];
    }
    const blocks: Block[] = [
      makeBlock("para", {
        text:
          "【数据样例回传模板】请为下面每张单据贴 5 行**真实数据**（敏感字段请脱敏：" +
          "姓名保留姓、金额可等比缩放、编号可打码但保留格式）。列不全的请在右侧自行补列。" +
          "回传后系统会从样例里自动推每个字段的类型、取值范围和唯一性 —— 您不需要填任何术语。",
      }),
    ];
    let sections = 0;
    for (const o of oirLive.objects.values()) {
      const objName = o.displayName.value || o.apiName.value;
      if (pyTruthy(contains) && !objName.includes(pyStr(contains))) continue;
      const props = o.properties
        .map((rid) => oirLive.properties.get(rid))
        .filter((x) => x !== undefined);
      const head = [
        // 隐藏第一列放 rid —— 回传时按它对号，改列序、加列都不怕
        "_rid（勿改）",
        ...(props.length > 0
          ? props.map((pp) => pp!.displayName.value || pp!.apiName.value)
          : ["（字段名请按贵司系统列在这一行）"]),
      ];
      blocks.push(makeBlock("heading", { text: `${objName}（请在下方贴 5 行真实数据）`, level: 1 }));
      blocks.push(...tableBlock(head, Array.from({ length: 5 }, () => [o.rid, ...head.slice(1).map(() => "")])));
      sections += 1;
    }
    if (sections === 0) {
      return [null, { 说明: `没有对象匹配「${pyStr(contains)}」。` }];
    }
    return [
      makeExportDoc({
        title: title || "数据样例回传模板",
        blocks,
        note: "由 OntoCopilot 生成 · 回传后自动推导字段类型/值域/唯一性（纯规则）",
      }),
      { 对象数: sections },
    ];
  }

  // ── 记忆文档 ────────────────────────────────────────────────
  // 「这个会话到今天为止做过什么、依据是什么」的一份人读得懂的账。
  //
  // 为什么必须**按依据分栏**：真实库里 100% 的断言都是 inferred，
  // 把「人明说的」和「凭通识补的」混在一张表里，等于没记 ——
  // FDE 拿这份去跟客户对账时，第一句话就是"哪些是你们确认过的"。
  if (source === "memory") {
    const log = Array.isArray(s.state["memory_log"])
      ? (s.state["memory_log"] as Record<string, unknown>[])
      : [];
    if (log.length === 0) {
      return [null, {
        说明: "这个会话还没有留下任何改动记忆。",
        下一步: "改过模型或流程之后再导 —— 每一次编辑、采纳、答复都会自动记一条。",
      }];
    }
    const BASIS_CN: Record<string, string> = {
      user: "人明说的",
      material: "材料里读到的",
      generic_assumption: "凭通识补的",
    };
    const byBasis = new Map<string, Record<string, unknown>[]>();
    for (const row of log) {
      const b = pyStr(row["basis"] ?? "user");
      if (!byBasis.has(b)) byBasis.set(b, []);
      byBasis.get(b)!.push(row);
    }
    const assumed = (byBasis.get("generic_assumption") ?? []).length;
    const blocks: Block[] = [
      makeBlock("para", {
        text: `【会话记忆】到目前为止一共 ${log.length} 条改动记录。`
          + (assumed > 0
            ? `其中 ${assumed} 条是**凭行业通识补的、没有客户材料依据**，交付前要逐条跟业务方确认。`
            : ""),
      }),
    ];
    // 人明说的排最前 —— 那是唯一能拿去跟客户说"这条是你们定的"的部分
    for (const basis of ["user", "material", "generic_assumption"]) {
      const rowsFor = byBasis.get(basis) ?? [];
      if (rowsFor.length === 0) continue;
      blocks.push(makeBlock("heading", {
        text: `${BASIS_CN[basis] ?? basis}（${rowsFor.length} 条）`, level: 1,
      }));
      blocks.push(...tableBlock(
        ["#", "类型", "做了什么", "工具"],
        rowsFor.map((row) => [
          pyStr(row["seq"]), pyStr(row["kind"]), pyStr(row["what"]), pyStr(row["tool"]),
        ]),
      ));
    }
    return [
      makeExportDoc({
        title: title || "会话记忆",
        blocks,
        note: "由 OntoCopilot 会话记忆生成（纯记录，未调用模型）",
      }),
      { 共: log.length, 凭通识补的: assumed },
    ];
  }

  // ── 补料清单（readiness 的可交接实物）────────────────────────
  // 就绪度评估的结论要能**离开对话**：FDE 把这份表发给业务方，对方按行补料。
  // 每行留"贵司对应材料"填写栏 —— 和确认稿同一个交互设计：给读的同时给填。
  if (source === "readiness") {
    const report = assessReadiness(
      s.files,
      (s.state["_chunks"] as Record<string, readonly Record<string, unknown>[]> | undefined) ?? {},
    );
    const gaps = report.dimensions.filter((d) => d.score < 2);
    if (gaps.length === 0) {
      return [null, { error: "六个维度都齐了，没有要补的料 —— 直接 build.start。" }];
    }
    const blocks: Block[] = [
      makeBlock("para", {
        text:
          `【补料清单】当前材料评估结论：${report.verdict}。` +
          "下表列出生成 Ontology 还缺的信息，请在「贵司对应材料」栏填写文件名或说明，" +
          "连同材料一并回传给 FDE。",
      }),
      ...tableBlock(
        ["优先级", "维度", "缺什么", "找谁要", "贵司对应材料（请填写）", "备注"],
        gaps.map((d) => [
          d.score === 0 ? "必补" : "最好补",
          d.label,
          d.missing,
          d.askWho,
          "",
          "",
        ]),
      ),
    ];
    const ok = report.dimensions.filter((d) => d.score === 2);
    if (ok.length > 0) {
      blocks.push(makeBlock("heading", { text: "已具备的部分（无需再提供）", level: 1 }));
      blocks.push(
        ...tableBlock(["维度", "依据"], ok.map((d) => [d.label, d.signals.join("；")])),
      );
    }
    return [
      makeExportDoc({
        title: title || "Ontology 建模补料清单",
        blocks,
        note: "由 OntoCopilot 材料就绪度评估生成（纯规则，未调用模型）",
      }),
      {},
    ];
  }

  // ── 4A 架构分析（业务 / 应用 / 数据 / 技术）──────────────────
  // 四层各自成章只是四份清单，**结合**发生在最后那张对齐矩阵上：一行一个流程
  // 环节，横着看它连着哪些数据对象、哪个系统、哪个技术组件 —— 哪一环没有系统
  // 承载、哪一环没有数据支撑，一眼看得出。投影是确定性的（onto/architecture.ts），
  // 零模型调用：这份文档不许出现任何"推测出来的架构"。
  if (source === "architecture") {
    const oir = s.state["_oir"];
    const flow = s.state["_flow"];
    if (!(oir instanceof OIR)) {
      return [
        null,
        {
          error: "还没有本体模型，没有可分析的架构。",
          下一步: "先传材料跑一轮梳理（或从通用场景要一份草案），再导 4A 分析。",
        },
      ];
    }
    const view = projectFourA(oir as never, isFlowLike(flow) ? (flow as never) : null);
    const blocks: Block[] = [
      makeBlock("para", {
        text: "本文按 ERP 4A 架构分四层盘点当前模型：每层写清**它回答什么问题**、"
          + "**现在有什么**、**缺什么**、**找谁要**。最后一节是四层对齐矩阵 —— "
          + "四份清单只有对齐到同一条业务链路上，才看得出断点在哪。",
      }),
    ];
    for (const layer of view.layers) {
      blocks.push(makeBlock("heading", { text: `${layer.id}｜${layer.name}`, level: 1 }));
      blocks.push(makeBlock("para", { text: `**这一层回答**：${layer.question}` }));
      const countLine = Object.entries(layer.counts).map(([k, v]) => `${k} ${v}`).join(" · ");
      blocks.push(makeBlock("para", { text: `**现在有**：${countLine || "（空）"}（覆盖度：${COVERAGE_CN[layer.coverage]}）` }));
      for (const note of layer.notes) blocks.push(makeBlock("para", { text: note }));
      if (layer.items.length > 0) {
        blocks.push(...tableBlock(
          ["名称", "类型"],
          layer.items.map((it) => [it.label, it.kind]),
        ));
      }
      if (layer.missing.length > 0) {
        blocks.push(makeBlock("para", { text: "**缺什么**：" }));
        // ListItem 是 [缩进层级, 序号, 文本]（onto/export.ts:147）；
        // 用 "-" 当序号 = 无序项，md/docx/xlsx 三种渲染共用同一份。
        blocks.push(makeBlock("para", {
          items: layer.missing.map((m) => [0, "-", m] as const),
        }));
      }
      blocks.push(makeBlock("para", { text: `**找谁要**：${layer.askWho}` }));
    }
    blocks.push(makeBlock("heading", { text: "四层对齐（业务 × 数据 × 应用 × 技术）", level: 1 }));
    blocks.push(makeBlock("para", {
      text: "一行一个业务环节。写着「未…」的格子就是断点：这一环还没有系统承载、"
        + "没有数据支撑、或者没人认领 —— 那正是访谈要问的。",
    }));
    blocks.push(...(view.matrix.rows.length > 0
      ? tableBlock(view.matrix.columns, view.matrix.rows)
      : [makeBlock("para", { text: "还没有业务流程，无法对齐 —— 先把流程立起来（见 A1）。" })]));
    return [
      makeExportDoc({
        title: title || `${s.project || s.title || "本项目"} · 4A 架构分析`,
        blocks,
        note: "由 OntoCopilot 从当前模型确定性投影生成（零模型调用）；空缺处已注明成因与索要对象",
        meta: docMeta(s, deps, {
          purpose: "盘点业务/应用/数据/技术四层现状，标出断点与待补材料",
          audience: "客户架构负责人 / IT 应用与数据负责人 / 业务流程负责人",
          basis: "当前模型（来自已解析材料）的确定性投影，未做任何推测",
          returnTo: "按各层「缺什么」补齐材料后回传，补一层就重导一次",
        }),
      }),
      {},
    ];
  }

  // ── 生成前的流程确认稿（发给业务方核对，填完再转正/开抽）──────
  // "先确认再建模"的实物：草图画完之后、adopt/build 之前，把流程摊成一张
  // **能填写的表**（每个环节留"确认/修改意见"栏），配 mermaid 图。md 给读，
  // xlsx 给填 —— 填完传回来就是下一批材料。
  if (source === "sketch") {
    const sketch = (s.state["sketch"] as Record<string, unknown> | undefined) ?? {};
    const graph = (sketch["graph"] as Record<string, unknown> | undefined) ?? {};
    const nodes = Array.isArray(graph["nodes"]) ? (graph["nodes"] as Record<string, unknown>[]) : [];
    if (nodes.length === 0) {
      return [
        null,
        {
          error: "还没有画过通用参考流程图，没有可确认的流程稿。",
          下一步: "先用 flow.sketch 画一张，再导确认稿。",
        },
      ];
    }
    const stages = Array.isArray(graph["stages"]) ? (graph["stages"] as Record<string, unknown>[]) : [];
    const edges = Array.isArray(graph["edges"]) ? (graph["edges"] as Record<string, unknown>[]) : [];
    const stageTitle = new Map(stages.map((st) => [pyStr(st["key"]), pyStr(st["title"])]));
    const nodeLabel = new Map(nodes.map((n) => [pyStr(n["rid"]),
      pyStr(dictLikeValue(n["label"])) || pyStr(n["code"])]));
    const blocks: Block[] = [
      makeBlock("para", {
        text:
          "【确认稿】以下流程由通用行业经验生成，非贵司事实。请逐行核对：" +
          "「确认」栏填 保留/修改/删除，改法与例外写进「修改意见」。" +
          "填写完成后回传给 FDE，即作为建模依据。",
      }),
      makeBlock("heading", { text: `环节清单（${nodes.length}）`, level: 1 }),
      ...tableBlock(
        ["阶段", "类型", "环节", "执行角色", "确认（保留/修改/删除）", "修改意见"],
        nodes.map((n) => [
          stageTitle.get(pyStr(n["stage"])) ?? pyStr(n["stage"]),
          pyStr(n["kind"]),
          pyStr(dictLikeValue(n["label"])) || pyStr(n["code"]),
          pyStr(dictLikeValue(n["actor"])),
          "",
          "",
        ]),
      ),
      makeBlock("heading", { text: `顺序与分支（${edges.length}）`, level: 1 }),
      ...tableBlock(
        ["从", "到", "条件", "对吗？（是/否）", "实际情况"],
        edges.map((e) => [
          // **键名是 from/to**：`FlowGraph.edgeToDict`（onto/flow.ts）写出来的就是这两个，
          // 内存形态 `FlowEdge` 才叫 source/target。上一版只读 source/target，于是这张
          // 让业务方逐行确认的表「从/到」两列**整列是空的** —— 而「条件」列有值，
          // 看上去像一张正常表格只是有些格没填，交付出去也没人发现
          // （真库 f6fca93bd618：32/32 条边零 source 键，已交付的 docx 里 32 行全空）。
          // 两个键都收：将来若有调用方直接塞内存对象，也不会再断一次。
          edgeEnd(nodeLabel, e["from"] ?? e["source"]),
          edgeEnd(nodeLabel, e["to"] ?? e["target"]),
          pyStr(e["label"]),
          "",
          "",
        ]),
      ),
    ];
    const live = s.state["_sketch"];
    if (deps.toMermaid !== undefined && isFlowLike(live)) {
      const mmd = deps.toMermaid(live);
      if (mmd.trim() !== "") {
        blocks.push(makeBlock("heading", { text: "流程图（mermaid）", level: 1 }));
        blocks.push(makeBlock("code", { text: mmd }));
      }
    }
    return [
      makeExportDoc({
        title: title || `${pyStr(sketch["domain"]) || "流程"}确认稿（通用假设，待业务核对）`,
        blocks,
        note: "通用行业经验生成，非客户材料事实；由 OntoCopilot 导出",
        // 文档头：这份要发给业务方逐行填，收件人第一时间会问的几件事写在最前面。
        meta: docMeta(s, deps, {
          purpose: "请业务方逐行确认流程环节与连线：保留 / 修改 / 删除，并在最后一列写修改意见",
          audience: "业务负责人 / 流程执行人",
          basis: "通用行业经验（通用假设），**尚未绑定客户材料** —— 请以贵司实际为准",
          returnTo: "填完这份表回传给 FDE（xlsx 可直接改），回传件会作为下一批材料进入梳理",
        }),
      }),
      {},
    ];
  }

  // ── 整份 Ontology 成文（md/docx/xlsx 走同一份 doc）────────────
  // JSON 形态早就有（oir.json 产物 + /ontology/draft 的 8 个 JSON 视图），
  // 缺的是**人读的成文版**：发给业务方看的不是 schema，是"这个模型说了什么、
  // 哪些是假设、还差什么"。逐类导表格拼不出这个 —— 溯源横幅、流程图、
  // 待确认清单必须在同一份文件里。
  if (source === "ontology") {
    const oir = (s.state["oir"] as Record<string, unknown> | undefined) ?? {};
    if (!pyTruthy(oir["objects"]) && !pyTruthy(oir["actions"])) {
      return [
        null,
        {
          error: "还没有 Ontology 内容可以成文 —— 模型是空的。",
          下一步: "先跑梳理（build.start），或用 draft.initialize + oir.add 建通用草案。",
        },
      ];
    }
    const prov = (s.state["draft_provenance"] as Record<string, unknown> | undefined) ?? {};
    const generic = pyStr(prov["kind"] ?? "") === "generic";
    const blocks: Block[] = [];
    // 溯源横幅放在正文最前：这份文件会脱离对话流转，marker 不在文件里等于没有。
    blocks.push(
      makeBlock("para", {
        text: generic
          ? "【来源与状态】本模型为通用行业假设（generic_assumption），无客户材料证据，" +
            "发布状态 DRAFT —— 全部条目待业务方验证，不得作为客户事实引用。"
          : `【来源与状态】由客户材料梳理产出；发布状态 ${pyStr(s.state["release_state"] ?? "DRAFT") || "DRAFT"}。` +
            "标注为待确认的条目仍需业务方核实。",
      }),
    );
    const SECTIONS: readonly [string, string][] = [
      ["objects", "数据对象"], ["properties", "属性"], ["links", "关系"],
      ["actions", "Action"], ["rules", "规则"],
    ];
    for (const [kind, title] of SECTIONS) {
      if (!pyTruthy(oir[kind])) continue;
      const [, head, rows] = oirTable(oir, kind, contains);
      if (rows.length === 0) continue;
      blocks.push(makeBlock("heading", { text: `${title}（${rows.length}）`, level: 1 }));
      blocks.push(...tableBlock(head, rows));
    }
    // ER 图（对象关系）。Ontology 的主体是对象和关系，以前成文里只有流程图 ——
    // 对客户讲模型时最需要的那张图不存在。放在流程图之前：先讲结构，再讲流转。
    const oirLive = s.state["_oir"];
    if (oirLive instanceof OIR && oirLive.objects.size > 0) {
      const er = toErMermaid(oirLive);
      if (er.includes("{")) { // 至少画出了一个实体
        blocks.push(makeBlock("heading", { text: "对象关系（mermaid ER 图）", level: 1 }));
        blocks.push(makeBlock("code", { text: er }));
      }
    }
    // 流程用 mermaid 源码块：md 里能直接渲染，docx/xlsx 里也保留可读的结构。
    const flow = s.state["_flow"];
    if (deps.toMermaid !== undefined && isFlowLike(flow)) {
      const mmd = deps.toMermaid(flow);
      if (mmd.trim() !== "") {
        blocks.push(makeBlock("heading", { text: "业务流程（mermaid）", level: 1 }));
        blocks.push(makeBlock("code", { text: mmd }));
      }
    }
    const backlog = pyTruthy(s.state["question_backlog"]) ? questionBacklogOf(s) : new Map();
    const open = [...backlog.values()].filter((q) => !q.terminal);
    if (open.length > 0) {
      blocks.push(makeBlock("heading", { text: `待确认问题（${open.length}）`, level: 1 }));
      blocks.push(
        ...tableBlock(
          ["问题", "优先级", "回答对象"],
          open.slice(0, 100).map((q) => [q.text, String(q.priority), q.audienceRole]),
        ),
      );
    }
    return [
      makeExportDoc({
        title: title || (generic ? "Ontology 草案（通用假设，待验证）" : "Ontology 模型"),
        blocks,
        note: generic
          ? "通用行业经验生成，非客户材料事实；由 OntoCopilot 导出"
          : "由 OntoCopilot 从本次梳理产物导出",
      }),
      {},
    ];
  }

  // ── 本轮梳理产物里的一类 ────────────────────────────────────
  if (Object.hasOwn(OIR_COLS, source)) {
    const oir = (s.state["oir"] as Record<string, unknown> | undefined) ?? {};
    if (!pyTruthy(oir[source])) {
      return [
        null,
        {
          error: `还没有 ${source} —— 梳理还没跑过或这一类是空的。`,
          下一步:
            "如果他要导的是**自己上传的表**，先用 material.rows " +
            "列出来，再用 source=last_table 导。",
        },
      ];
    }
    const [label, head, rows] = oirTable(oir, source, contains);
    if (rows.length === 0) {
      return [null, { error: `${label}里没有含「${contains}」的条目，导出会是空表。` }];
    }
    const name = title || (contains ? `${label}（含${contains}）` : label);
    return [
      makeExportDoc({
        title: name,
        blocks: tableBlock(head, rows),
        note: `共 ${rows.length} 条，由 OntoCopilot 从本次梳理产物导出`,
      }),
      {},
    ];
  }

  // ── 对话里出现过的某一张表 ──────────────────────────────────
  if (source === "last_table") {
    const tblOpts = {
      repo: deps.repo,
      dialogue: deps.dialogue,
      // `Block.rows` 是 `unknown[][]`，段 D 的 `MarkdownBlockLike.rows` 声明成
      // `string[][]` —— 运行时是同一份数组，只是两段各写了一份结构声明。
      blocksFromMarkdown: seam<(t: string) => readonly MarkdownBlockLike[]>(blocksFromMarkdown),
    };
    const tables = await conversationTables(s, tblOpts);
    const ev = pickTable(tables, tableName);
    if (ev === null && tableName) {
      // 点了名却找不到 —— **把有哪些告诉模型**，别让它默默导另一张给用户。
      // 连同相似度一起给：截断成 8 条再让它凭印象挑，是又一次猜。
      const titles = tables.map((r) => pyStr(r["title"] ?? "")).filter(Boolean);
      const ranked = titles
        .map((t) => ({ t, score: Math.round(titleSimilarity(tableName, t) * 100) }))
        .sort((a, b) => b.score - a.score);
      return [
        null,
        {
          error: `这段对话里没有叫「${tableName}」的表。`,
          现有的表: titles.length > 0 ? titles : "一张都没有",
          最接近的:
            ranked.length > 0 && ranked[0]!.score > 0
              ? ranked.slice(0, 3).map((x) => `${x.t}（${x.score}% 像）`)
              : "没有相近的",
          下一步:
            "**照抄上面「现有的表」里的原名重试**，不要用你自己转述的说法；" +
            "或者不传 name，导最后一张。",
        },
      ];
    }
    if (ev === null) {
      return [
        null,
        {
          error: "还没有列过表，没有「这个表」可导。",
          下一步:
            "先用 ui.table（产物）或 material.rows（上传的表）" + "把内容列给他看，再导出。",
        },
      ];
    }
    const head = [...((ev["columns"] as unknown[] | undefined) ?? [])].map(pyStr);
    const full = await fullRowsFor(s, deps.registry(), ev);
    let rows: string[][] =
      full !== null
        ? full
        : ((ev["rows"] as unknown[][] | undefined) ?? []).map((r) => [...r].map(pyStr));
    const partial = full === null && pyIntOr(ev["total"], rows.length) > rows.length;
    if (contains) {
      const k = contains.toLowerCase();
      rows = rows.filter((r) => r.map(pyStr).join(" ").toLowerCase().includes(k));
      if (rows.length === 0) return [null, { error: `这张表里没有含「${contains}」的行。` }];
    }
    let name = title || pyStr(pyTruthy(ev["title"]) ? ev["title"] : "清单");
    let note = `共 ${rows.length} 条，由 OntoCopilot 导出`;
    if (partial) {
      // 补不回全量时**必须说出来**，标题里那个数字也不能留着骗人。原标题结尾常有
      // 个「（900 行）」—— 那是屏幕上那张表的总数，直接换掉，别再追加一个括号
      // 变成「（900 行）（前 500 行）」。
      name = pyStrip(name.replace(TAIL_COUNT, ""));
      name = `${name}（前 ${rows.length} 行，原表 ${pyStr(ev["total"])} 行）`;
      note =
        `只含前 ${rows.length} 行，原表共 ${pyStr(ev["total"])} 行 —— ` +
        `重新读原始材料失败，这份**不是全量**。`;
    }
    const doc = makeExportDoc({ title: name, blocks: tableBlock(head, rows), note });
    return [doc, partial ? { 注意: note } : {}];
  }

  // **system 轮次不能一律丢掉。** DialogueMemory 每轮都 compactToFit()，超预算的
  // 旧轮次会被换成一条 Speaker.SYSTEM 的摘要（"（已压缩 N 轮）…"）—— 那是那些轮次
  // 仅存的记录。过滤掉它，导出的"整段对话"就从中间开始，而且还宣称自己是全部。
  const rawTurns = deps.dialogue(s).turns;
  const turns = rawTurns.filter((t) => String(t.speaker) !== "system");

  if (source === "last_answer") {
    const answer = [...turns].reverse().find((t) => String(t.speaker) === "assistant") ?? null;
    if (answer === null) return [null, { error: "这轮之前还没有过回答，没有「刚才那段」可导。" }];
    return [
      makeExportDoc({
        title: title || "OntoCopilot 回答",
        blocks: blocksFromMarkdown(answer.text),
        note: "由 OntoCopilot 导出",
      }),
      {},
    ];
  }

  if (source === "conversation") {
    if (rawTurns.length === 0) return [null, { error: "这个会话还没有对话内容。" }];
    const blocks: Block[] = [];
    let compacted = 0;
    for (const t of rawTurns) {
      const sp = String(t.speaker);
      if (sp === "system") {
        compacted += 1;
        blocks.push(makeBlock("heading", { text: "（早前对话摘要）", level: 2 }));
      } else {
        blocks.push(
          makeBlock("heading", { text: sp === "user" ? "FDE" : "OntoCopilot", level: 2 }),
        );
      }
      blocks.push(...blocksFromMarkdown(t.text));
    }
    let note = `共 ${turns.length} 轮，由 OntoCopilot 导出`;
    if (compacted > 0) {
      note += `；更早的轮次已被压缩成 ${compacted} 条摘要，原文不再保留`;
    }
    return [makeExportDoc({ title: title || s.title || "对话记录", blocks, note }), {}];
  }

  return [null, { error: `不认识的 source「${source}」。` }];
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

/**
 * `_question_backlog(s)`（`server.py:3291`）。
 *
 * 不 import `routes/questions.ts` 那一份：它收的是段 G 的具体 `Session` 类，而
 * 这里拿到的是 `SessionLike`。反序列化本来就全在 `QuestionBacklog.fromDict` 里，
 * 这一句只是把状态取出来喂给它 —— 两处走的是同一个反序列化实现，不会漂开。
 */
/** Assertion dict（{value,...}）或裸值都取到字符串值。 */
function dictLikeValue(v: unknown): unknown {
  return typeof v === "object" && v !== null && "value" in (v as Record<string, unknown>)
    ? (v as Record<string, unknown>)["value"]
    : v;
}

/** `_flow` 是不是一张真的 FlowGraph（有节点才值得画）。鸭子判：这层不 import onto/flow。 */
function isFlowLike(v: unknown): boolean {
  return typeof v === "object" && v !== null &&
    (v as { nodes?: { size?: number } }).nodes !== undefined &&
    Number((v as { nodes: { size?: number } }).nodes.size ?? 0) > 0;
}

function questionBacklogOf(s: SessionLike): Map<string, Question> {
  const raw = s.state["question_backlog"];
  const doc = (pyTruthy(raw) ? raw : { questions: [] }) as Record<string, unknown>;
  return QuestionBacklog.fromDict(doc).questions;
}
