/**
 * 流程图这一条产物链 —— `server.py` 3582 / 3596 / 3623 / 3643 / 3796。
 *
 * 五个函数放在一起，因为它们共用同一条铁律：**图一变，全部产物一起重出**。
 * 历史上 `flow.edit` 漏了重出主干图，于是编辑之后主干图一直是编辑前的那张，
 * 而它长得很正常 —— 没有任何地方会报错。
 */

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDiagramStyle, toMermaid, toSvg } from "../../onto/diagram.js";
import { FlowEditError, applyFlowEdit } from "../../onto/flow_edit.js";
import {
  applySceneTitles,
  attachGateways,
  buildFlow,
  gapsToQuestions,
  looksLikeProcess,
  mayHaveCondition,
  parseGateways,
  parseSteps,
  sceneHeaders,
  stagesByDomain,
  stagesFromSurvey,
  surveyStageGroups,
  type Gateway,
  type ProcessStep,
} from "../../onto/flow_extract.js";
import { flowFromBpmnDocs } from "../../onto/flow_bpmn.js";
import { assertEvidenceDiscipline } from "../../onto/flow_evidence.js";
import { toLaneSvg } from "../../onto/diagram_lanes.js";
import { attachEndpoints, coverageGaps, flowFromActions, linkReportSummary } from "../../onto/flow_link.js";
import { OIREditError, applyOirEdit } from "../../onto/oir_edit.js";
import { pyJsonDumps } from "../../onto/canonical.js";
import type { FlowGraph } from "../../onto/flow.js";
import { autoBindObjects } from "../../onto/flow_link.js";
import { OIR } from "../../onto/oir.js";
import type { Gap } from "../../onto/flow_link.js";
import type { ParsedDoc } from "../../onto/parse/base.js";
import { citeOf } from "./chunks.js";
import type { Session } from "../session.js";

// ══════════════════════════════════════════════════════════════════
//  重放人工编辑
// ══════════════════════════════════════════════════════════════════

/** `_replay_oir_patches`（`server.py:3582`）：
 *  把 FDE 的结构化 OIR 修改重放到新抽取结果；冲突项显式返回而不是静默丢失。 */
export function replayOirPatches(s: Session, oir: OIR): Record<string, unknown>[] {
  const stale: Record<string, unknown>[] = [];
  for (const patch of patchLog(s.state["_oir_patch_log"])) {
    try {
      applyOirEdit(oir, String(patch["op"]), argsOf(patch), {
        source: patch["source"] === "generic_assumption" ? "generic_assumption" : "user",
      });
    } catch (exc) {
      if (!(exc instanceof OIREditError)) throw exc;
      stale.push({ ...patch, why: exc.message });
    }
  }
  return stale;
}

/**
 * `_replay_flow_patches`（`server.py:3623`）：把会话记下的人工流程图编辑重放到一张
 * 新建的图上，返回重放不上的（stale）。
 *
 * 重跑管线会从材料重建 FlowGraph、覆盖掉 FDE 上一轮手动补的节点/边。把每次
 * flow.edit 的 op 记进 `_flow_patch_log`，重建后按顺序重放 —— 节点 rid/code 跨进程
 * 稳定，靠标签/编号引用的 op 能重新解析上；人工加的节点/边经各自 add_node/connect
 * 重现，仍标 human。解析不上的（引用的节点在新图里没了）收集为 stale 上报，
 * **绝不静默丢**。
 */
export function replayFlowPatches(s: Session, g: FlowGraph): Record<string, unknown>[] {
  const stale: Record<string, unknown>[] = [];
  for (const p of patchLog(s.state["_flow_patch_log"])) {
    try {
      applyFlowEdit(g, String(p["op"]), argsOf(p), {
        source: p["source"] === "generic_assumption" ? "generic_assumption" : "user",
      });
    } catch (exc) {
      if (!(exc instanceof FlowEditError)) throw exc;
      stale.push({ ...p, why: exc.message });
    }
  }
  return stale;
}

// ══════════════════════════════════════════════════════════════════
//  落产物
// ══════════════════════════════════════════════════════════════════

/**
 * `_rewrite_flow_artifacts`（`server.py:3596`）：把一张流图落成全部产物：全图 SVG、
 * 主干 SVG、mermaid、flow.json，并刷新内存态与产物列表。**首次建图 / flow.edit /
 * flow.undo 共用这一条** —— 否则三处各写各的，迟早漂移（历史上 flow.edit 就漏了
 * 重出主干图，编辑后主干图一直是旧的）。
 *
 * 主干图只在「主干 ⊊ 全图」时才有意义：删节点删到只剩主干时出一张精简视图；一旦
 * 主干等于全图，旧的主干文件要删掉，否则留着一张过期的图冒充当前主干。
 */
export function rewriteFlowArtifacts(s: Session, g: FlowGraph): void {
  // 落盘前的最后一道：声称来自材料却没有出处的断言，一个都不许出门。
  // 放这里而不是放在各生成策略里，是因为这里是**唯一**的落盘出口 ——
  // 加一条新策略不需要记得再加一次校验，它天然被这道门管住。
  assertEvidenceDiscipline(g);
  const title = `${s.project || s.title} · Action + Event 业务流程`;
  const style = resolveDiagramStyle(g, { title, template: "auto" });
  writeFileSync(
    join(s.dir, "流程图.svg"),
    toSvg(g, { title, palette: style.palette, layout: style.layout }),
    "utf-8",
  );
  writeFileSync(join(s.dir, "流程图.mmd"), toMermaid(g, { direction: style.layout.direction }), "utf-8");
  const main = g.mainPath();
  const mainSvg = join(s.dir, "流程图_主干.svg");
  if (main.nodes.size < g.nodes.size) {
    const mainTitle = `${s.project || s.title} · 主干流程（仅有依据的环节）`;
    const mainStyle = resolveDiagramStyle(main, { title: mainTitle, template: "auto" });
    writeFileSync(
      mainSvg,
      toSvg(main, { title: mainTitle, palette: mainStyle.palette, layout: mainStyle.layout }),
      "utf-8",
    );
  } else if (existsSync(mainSvg)) {
    rmSync(mainSvg); // 主干不再区别于全图，删掉过期文件
  }
  // 泳道图：actor 数据一直都有，从来没画过。只在真有人标了执行者时才出 ——
  // 全是「未指定」的一张图没有信息量，出了反而像系统认真分过工。
  const laneSvg = join(s.dir, "流程图_泳道.svg");
  const hasActor = [...g.nodes.values()].some((n) => n.actor.value.trim() !== "");
  if (hasActor) {
    writeFileSync(
      laneSvg,
      toLaneSvg(g, { title: `${s.project || s.title} · 按执行者分泳道` }),
      "utf-8",
    );
  } else if (existsSync(laneSvg)) {
    rmSync(laneSvg); // 执行者被删光了，别留一张过期的泳道图
  }
  writeFileSync(join(s.dir, "flow.json"), pyJsonDumps(g.toDict(), 1), "utf-8");
  s.state["_flow"] = g;
  s.state["flow"] = g.toDict();
  s.state["artifacts"] = sortedArtifacts(s.dir);
}

/**
 * 一旦材料管线真的产出/链接了一张图，就不能继续沿用初始化草案的 `generic`
 * 会话标记。混入的通用补丁仍保持零 evidence，context 投影会据此正确显示 mixed；
 * 这里写成可持久化的 material 标记（不能 delete：repo 的 state 文档是 merge/upsert，
 * 缺键不会删除旧值），从而不再把整张图强制判成 generic。
 */
function clearGenericFlowOverride(s: Session): void {
  s.state["flow_provenance"] = "material";
}

// ══════════════════════════════════════════════════════════════════
//  建图
// ══════════════════════════════════════════════════════════════════

/** `_build_flow_diagram` 中「出图 + 报缺口」那一段，BPMN 与规则抽取两条路共用。 */
/**
 * 建图后自动补对象↔环节绑定（C2 前置）。OIR 还没建出来（flow 在 PARSE 后、
 * EXTRACT 前就出图）时静默跳过 —— 下一次重建或对话里的 bind_auto 会补上。
 * 只补空的，人工/BPMN 绑定不动（见 onto/flow_link.ts）。
 */
function autoBindFlow(s: Session, g: FlowGraph): void {
  const oir = s.state["_oir"];
  if (!(oir instanceof OIR)) return;
  const n = autoBindObjects(g, oir);
  if (n > 0) s.emit("flow.autobind", { bound: n });
}

function publishFlow(s: Session, g: FlowGraph, fileName: string): void {
  s.state["_flow_gaps"] = gapsToQuestions(g, { fileName });
  // 产物列表要立刻刷 —— 流程图在 PARSE 之后就出来了，而 artifacts 原来只在
  // _compile（几分钟后）才写。中间这段时间文件在盘上、界面上却看不到。
  s.state["artifacts"] = sortedArtifacts(s.dir);
  s.emit("flow.ready", {
    stats: g.stats(),
    gap_questions: (s.state["_flow_gaps"] as unknown[]).length,
    issues: {
      死路: g.deadEnds().slice(0, 6).map((n) => n.label.value),
      无标签分支: g.unlabeledBranches().slice(0, 6).map((n) => n.label.value),
      有动作无事件: g.actionsWithoutEvents().slice(0, 6).map((n) => n.label.value),
    },
  });
}

function reportStale(s: Session, stale: readonly Record<string, unknown>[]): void {
  if (stale.length === 0) return;
  s.emit("flow.stale_edits", {
    count: stale.length,
    items: stale.map((x) => ({ op: String(x["op"] ?? ""), why: String(x["why"] ?? "") })),
  });
}

/**
 * `_build_flow_diagram`（`server.py:3643`）：从材料里抽流程说明，出 mermaid + SVG。
 * **零模型调用。**
 *
 * 这是产品的主产出：FDE 要的不是一份结构化数据，是一张能拿去跟客户对的
 * 流程图。抽不出来就不出图 —— 出一张空图比不出更糟，它会让人以为材料里
 * 没有流程。
 */
export function buildFlowDiagram(s: Session, docs: readonly ParsedDoc[]): void {
  // BPMN 已经是一张结构化图，必须直接保留节点 id、泳道、条件和 sequenceFlow
  // provenance；再从 render 文本做一次规则抽取会丢信息，还可能改写原有顺序。
  const bpmnGraph = flowFromBpmnDocs(docs);
  if (bpmnGraph !== null) {
    reportStale(s, replayFlowPatches(s, bpmnGraph));
    clearGenericFlowOverride(s);
    autoBindFlow(s, bpmnGraph);
    rewriteFlowArtifacts(s, bpmnGraph);
    const sourceNames = docs.filter((d) => d.kind === "bpmn").map((d) => d.file_name);
    const source = sourceNames.join("、");
    s.emit("flow.bpmn", {
      sources: sourceNames,
      stats: bpmnGraph.stats(),
      why: "BPMN 是结构化流程定义，已直接映射，未让模型重新解释",
    });
    publishFlow(s, bpmnGraph, source);
    return;
  }

  const steps: ProcessStep[] = [];
  const ruleTexts: [string, string][] = []; // (原文, cite) 供网关抽取
  const surveyCols = new Map<string, string[]>(); // 供阶段划分
  let scenes: string[] = []; // 材料里写明的业务场景标题
  const seenText = new Set<string>(); // 同段被 raw/render 各扫一遍，去重
  for (const d of docs) {
    for (const c of d.chunks) {
      const raw = isPlainObject(c.raw) ? c.raw : {};
      for (const val of [...Object.values(raw), c.render]) {
        const text = String(val ?? "");
        // Python 的 `len(text) < 60` 是**码点数**；这里用 UTF-16 长度会让含
        // emoji 的段落被误判成够长。
        if ([...text].length < 60 || seenText.has(text)) continue;
        seenText.add(text);
        // 两条通道**独立判定**，不是 if/elif —— 流程说明段本身也含
        // 「如…则…」（"如不满足，则创建执行计划"），用 elif 会让它被
        // 流程通道吃掉、进不了网关抽取，于是网关只剩零星几个。
        if (looksLikeProcess(text)) {
          const got = parseSteps(text, { cite: citeOf(c), fileName: d.file_name });
          const known = new Set(steps.map((x) => x.no));
          const fresh = got.filter((x) => !known.has(x.no));
          steps.push(...fresh);
          if (fresh.length > 0) {
            // 每一步推理都投影出来 —— 用户要看见流程是**从哪一行材料
            // 推出来的**，而不是接受一张凭空出现的图。"不是瞎编"要能核对。
            s.emit("flow.step", {
              cite: citeOf(c),
              found:
                `识别为流程说明，抽出 ${fresh.length} 个节点：` +
                fresh
                  .slice(0, 6)
                  .map((x) => `（${x.no}）${x.name}`)
                  .join("、") +
                (fresh.length > 6 ? "…" : ""),
            });
          }
        }
        // 预筛与 COND_RE 共用词形（见 flow_extract.mayHaveCondition）。
        // 曾经写死成 includes("如")+includes("则")，把「若…需…」「当…就…」
        // 写的规则整段挡在门外 —— 症状是"这份材料一个分支都没有"，不报错。
        if (mayHaveCondition(text)) {
          ruleTexts.push([text, citeOf(c)]);
        }
      }
      // 问卷的「节点」列：一行一个 (N) 节点名，作阶段依据
      const values = Object.values(raw);
      const first = values.length > 0 ? values[0] : "";
      if (typeof first === "string" && first.trim()) {
        const bucket = surveyCols.get(d.file_name) ?? [];
        bucket.push(first.trim());
        surveyCols.set(d.file_name, bucket);
      }
      // 场景标题：编号和名字常常分在**相邻的两个单元格**里
      // （A 列「业务场景1」、B 列「采购执行计划创建」），只读第一列
      // 就只剩一串没有名字的编号。
      scenes = scenes.concat(sceneHeaders(values.map((v) => String(v ?? ""))));
    }
  }
  if (steps.length === 0) {
    s.emit("flow.skipped", {
      reason: "材料里没有找到「触发条件/输入/输出」这种结构化的流程说明",
    });
    return;
  }

  // Python 的 `list.sort` 是稳定排序，`key=lambda x: x.no` 只比 no。
  steps.sort((a, b) => a.no - b.no);

  // ── 阶段：三条依据按可信度排队，全部来自材料 ────────────────────
  //   1. 问卷/场景明写了节点区间（「业务场景一（重点覆盖节点6—10）」）—— 最硬；
  //   2. 问卷「节点」列的 `（N）短名` 分组 —— 客户自己就是按这个讨论的；
  //   3. 都没有，按**业务域**切（相邻且处理同一个单据的节点归一段）。
  // 第 3 条以前是"每 4 个切一刀"，那个 4 没有任何依据，切出来的边界纯属巧合。
  const groups = surveyCols.size > 0 ? surveyStageGroups(surveyCols) : [];
  let g: FlowGraph;
  let mapping: Map<number, string>;
  let basis: string;
  if (groups.length > 0) {
    [g, mapping] = stagesFromSurvey(groups);
    basis = "问卷节点分组";
  } else {
    [g, mapping] = stagesByDomain(steps);
    basis = "业务对象切分";
  }
  if (scenes.length > 0) {
    // 客户自己给场景起的名字比我们切出来的标题更完整，也是他开会时会用的词。
    // 对得上的泳道换成他的说法，对不上的保持原样 —— 硬凑会给一段流程贴上
    // 另一段的名字。
    const renamed = applySceneTitles(g, scenes);
    s.emit("flow.scenes", { scenes: scenes.slice(0, 12), basis, renamed });
  }

  const fname = docs.length > 0 ? docs[0]!.file_name : "";
  g = buildFlow(steps, { stages: mapping, fileName: fname, graph: g });

  // ── 网关：从「如…则…」规则里抽，尽量挂到相关动作 ──────────────
  const stepByKw = new Map<string, number>(steps.map((st) => [st.name, st.no]));
  const gws: [Gateway, number | null][] = [];
  const seenGw = new Set<string>();
  for (const [text, cite] of ruleTexts) {
    for (const gw of parseGateways(text, { cite })) {
      const key = [...gw.condition].slice(0, 20).join("");
      if (seenGw.has(key)) continue; // 同一条规则被多处引用，只挂一次
      seenGw.add(key);
      let node: number | null = null;
      for (const [name, no] of stepByKw) {
        const short = [...name].slice(0, 4).join("");
        if (gw.ruleText.includes(name) || gw.ruleText.includes(short)) {
          node = no;
          break;
        }
      }
      gws.push([gw, node]);
    }
  }
  if (gws.length > 0) g = attachGateways(g, gws.slice(0, 16), { fileName: fname });

  // 重放人工编辑 —— 补料重跑不能吞掉 FDE 上一轮手动补的节点/边
  reportStale(s, replayFlowPatches(s, g));
  // 全图 + 主干 + mermaid + flow.json 一把落地（和 flow.edit/flow.undo 共用同一条）
  clearGenericFlowOverride(s);
  autoBindFlow(s, g); // 此时多半还没有 OIR（静默跳过）；linkFlowToApi 那一站会真正补上
  rewriteFlowArtifacts(s, g);
  // 流程图上标黄的每一处缺口，都是一个 FDE 本该问客户却容易漏掉的问题。
  // 暂存起来 —— OIR 这时候还没建，等它建好把这些问题合流进问题容器，
  // 客户不需要知道哪条是他自己问卷里提的、哪条是系统从图里发现的。
  publishFlow(s, g, fname);
}

// ══════════════════════════════════════════════════════════════════
//  接口清单 → 流程图
// ══════════════════════════════════════════════════════════════════

/**
 * `_link_flow_to_api`（`server.py:3796`）：把接口清单接到流程图上，重出产物，
 * 返回对不上的缺口。**零模型调用。**
 *
 * 时序上必须在这里：流程图在 PARSE 之后就出来了（那时 OIR 还不存在），而接口
 * 清单要等 EXTRACT 跑完。两者以前就一直是两份互不相干的产物 —— 图上看不出哪
 * 一步有系统支撑，接口清单里也看不出这个接口落在流程的哪一环。
 *
 * 材料里**没有**流程说明时（`_flow` 不存在），退一步用接口清单本身建一张接口
 * 视角的草图：同一个单据上 create → approve → cancel 的先后关系本身就能拿去和
 * 客户对，比一张白纸有用。顺序是推的，图上是虚线。
 */
export function linkFlowToApi(s: Session, oir: OIR): Gap[] {
  let g = (s.state["_flow"] as FlowGraph | undefined) ?? null;
  if (g === null) {
    if (oir.actions.size === 0) return [];
    g = flowFromActions(oir, { fileName: s.files.length > 0 ? s.files[0]!.name : "" });
    if (g.nodes.size === 0) return [];
    s.emit("flow.from_api", {
      nodes: g.nodes.size,
      why: "材料里没有流程说明，这张图是按接口清单的生命周期推的，全部待确认",
    });
  }
  const report = attachEndpoints(g, oir);
  // C2 前置的真正落点：这一站 OIR 已建好 —— 对象↔环节的桥在这里搭上，
  // impact.trace 的流程段与 flow.walk 的对象视角都靠它。只补空的。
  const bound = autoBindObjects(g, oir);
  if (bound > 0) s.emit("flow.autobind", { bound });
  clearGenericFlowOverride(s);
  rewriteFlowArtifacts(s, g);
  const gaps = coverageGaps(report, oir);
  s.emit("flow.linked", { ...linkReportSummary(report), gaps: gaps.length });
  return gaps;
}

// ══════════════════════════════════════════════════════════════════
//  小工具
// ══════════════════════════════════════════════════════════════════

function patchLog(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/** `patch.get("args") or {}`。 */
function argsOf(patch: Record<string, unknown>): Record<string, unknown> {
  const a = patch["args"];
  return isPlainObject(a) && Object.keys(a).length > 0 ? a : {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `sorted(x.name for x in s.dir.iterdir() if x.is_file())`。 */
export function sortedArtifacts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    try {
      if (statSync(join(dir, name)).isFile()) out.push(name);
    } catch {
      // 列目录与 stat 之间文件可能已被删。`is_file()` 对不存在的路径回 False。
    }
  }
  return out.sort(cmpCodePoint);
}

function cmpCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const ca = x[i]!.codePointAt(0)!;
    const cb = y[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return x.length - y.length;
}
