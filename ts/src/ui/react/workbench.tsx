// FDE 问题工作台（questions.ts 里 questionWorkbench() / engagementProgress() 的组件形态）。
//
// 这是产品的核心交付面：ERP 顾问就在这块屏幕上把「材料里说不清的地方」一条条问
// 出去、收回来。三条契约换了框架也一个字不变 ——
//
//   1. **blocked / deferred 的问题必须先「恢复待答」才能回答。** 卡片上没有
//      「提交回答」这个按钮，回答框与参考选项都是锁着的。业务侧的语义是「这条现在
//      不该有人往里填」；给一个填得动、提交时才报错的框，等于把已经打上的字丢掉。
//   2. **Bundle 的门禁在 <BundleLink> 一处**（bundle.tsx），有阻塞问题就点不动，
//      但问题清单（XLSX/MD/JSON）与单份产物照常可下载 —— 关的只有 Bundle 那一扇门。
//   3. **后端没有 Question Ledger 时不假装能写。** 三个导出口不出现、界面上明说是
//      兼容模式；真正拦住写操作的是 qRequest 自己，那份逻辑一个字没动。
//
// ## 值从哪来
//
// 每张卡的四个输入（负责人 / 应答角色 / 优先级 / 答案 + 参考选项）由组件自己持有。
// 内联 JS 时代是提交时用 `card.querySelector("[data-q-answer]").value` 回读 DOM ——
// React 下那条路不该再走。所以 questions.ts 里把提交拆成了 qSubmitWith / qSaveMetaWith：
// **判断逻辑仍是同一份**，只是值由调用方给。data-q-* 这些属性仍原样保留：CSS 与
// 遗留渲染路径都还认它们。
//
// 类名与 DOM 结构逐字对齐原来的模板字符串（.qwbhead .qdeliver .qnext .qnotice
// .qfilters .qcard .qmeta .qbadge .qfields .qanswer .qactions .qempty .qmore）。

import { useState, type ReactElement, type ReactNode } from "react";

import { API } from "../dom.js";
import {
  loadQuestions, qDefer, qReopen, qSaveMetaWith, qSetFilter, qSubmitWith, releaseView,
} from "../questions.js";
import { openSource } from "../preview.js";
import { openReturnPicker } from "../returnaudit.js";
import { G, Q_BUSY } from "../state.js";
import { bumped } from "./bridge.js";
import { BundleLink } from "./bundle.js";
import { ArtifactRows, PREVIEW_TABS } from "./preview.js";
import { ReturnAuditCard } from "./returncard.js";
import { bumpUi, useUi } from "./store.js";

export { BundleLink };

// ── 旧动作函数 + 一次 bumpUi（见 bridge.ts）────────────────────────
const reload = bumped(loadQuestions);
const setFilter = bumped(qSetFilter);
const defer = bumped(qDefer);
const reopen = bumped(qReopen);
const submit = bumped(qSubmitWith);
const saveMeta = bumped(qSaveMetaWith);
const pickReturn = bumped(openReturnPicker);
const showSource = bumped(openSource);

// ── 收口后的那套枚举。**四档优先级来自领域契约，没有 medium 这一档。**─────
const STATUS_LABEL: Record<string, string> = {
  open: "待回答", assigned: "已分派", blocked: "受阻",
  answered: "已回答", deferred: "已延期", cancelled: "已取消",
};
const ROLE_OPTIONS = ["", "业务负责人", "流程负责人", "ERP顾问", "数据负责人", "财务/法务", "FDE"];
const PRIORITY_OPTIONS: Array<[string, string]> = [
  ["low", "低优先级"], ["normal", "普通优先级"], ["high", "高优先级"], ["blocking", "阻塞交付"],
];
const ENG_LABELS: Record<string, string> = {
  INTAKE: "盘点", PROCESS: "流程", ERP_MAP: "ERP 映射", RULES: "规则",
  DATA_OBJECTS: "数据对象", GAP: "缺口", INTERVIEW: "访谈", CANONICALIZE: "规范化",
  REVIEW: "交付审查", EXPORT: "导出",
};

/** 还等着人回答的三种 lifecycle。releaseView 用的是同一个判断。 */
const isActive = (q: any): boolean => ["open", "assigned", "blocked"].includes(q.status);

// ══════════════════════════════════════════════════════════════════
//  交付条：这一版是什么、能下载什么
// ══════════════════════════════════════════════════════════════════
function DeliverBar(): ReactElement {
  const G = useUi();
  // 「关联产物」= 问题清单/本体/流程图那几类，不是全部产物 —— 交付条要短。
  const artifacts = (G.S.state?.artifacts || []).filter((a: any) =>
    /问题|question|ontology|oir\.json|flow\.json|流程图/i.test(a));
  const revision = G.S.state?.ontology_package?.revision ?? G.S.state?.artifact_revision
    ?? G.S.state_version ?? G.S.revision ?? G.S.state?.revision?.id;
  const version = revision === undefined || revision === null
    ? "当前会话快照" : `产物 revision ${revision}`;
  const release = releaseView();
  return (
    <div className="qdeliver">
      <div className="qtext">访谈清单与当前交付版本</div>
      <div className="qwbsum">{`${G.Q_BACKLOG.length} 个问题 · ${artifacts.length} 份关联产物 · ${version} · ${release.state}${release.blockers ? `（${release.blockers} 个阻塞项）` : ""}`}</div>
      <div className="acts">
        {G.Q_API ? ["xlsx", "md", "json"].map(f => (
          <a key={f} className="act" download
            href={`${API}/api/sessions/${encodeURIComponent(G.S.id)}/questions/export?format=${f}`}
          >{f.toUpperCase()}</a>
        )) : null}
        {artifacts.slice(0, 5).map((a: any) => (
          <a key={a} className="act" download title={a}
            href={`${API}/api/sessions/${encodeURIComponent(G.S.id)}/artifacts/${encodeURIComponent(a)}`}
          >{a}</a>
        ))}
        <BundleLink label="Bundle" className="act pri" />
        <button className="act" onClick={() => pickReturn()}>上传回传模板</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  服务端排好的下一批
// ══════════════════════════════════════════════════════════════════
function NextBatch(): ReactNode {
  const G = useUi();
  if (!G.Q_NEXT.length) return null;
  return (
    <div className="qnext">
      <div className="qtext">建议下一批先问</div>
      <div className="qwbsum">按阻塞范围、信息价值与依赖排序</div>
      <ol>{G.Q_NEXT.slice(0, 5).map((q: any, i: number) => (
        <li key={q.id ?? i}>{q.text}{q.role ? ` · ${q.role}` : ""}</li>
      ))}</ol>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  一张问题卡
// ══════════════════════════════════════════════════════════════════
interface Draft { owner: string; role: string; priority: string; answer: string; option: string }

/** 从收口后的问题里取初值。参考选项按「答案正好等于某个选项的 label」回选。 */
function seed(q: any): Draft {
  return {
    owner: String(q.owner || ""),
    role: String(q.role || ""),
    priority: String(q.priority || ""),
    answer: String(q.answer || ""),
    option: String(q.options.find((o: any) => o.label === q.answer)?.id ?? ""),
  };
}
/** 服务端那份变了（重新拉过清单 / 别人改了）就重新播种，别把陈旧的值发回去。 */
const seedKey = (q: any): string =>
  JSON.stringify([q.id, q.status, q.owner, q.role, q.priority, q.answer, q.revision]);

export function QCard({ q, i }: { q: any; i: number }): ReactElement {
  useUi();
  const [draft, setDraft] = useState<Draft>(() => seed(q));
  const [seen, setSeen] = useState<string>(() => seedKey(q));
  const now = seedKey(q);
  if (now !== seen) { setSeen(now); setDraft(seed(q)); }
  const put = (patch: Partial<Draft>): void => { setDraft({ ...draft, ...patch }); };

  const busy = Q_BUSY.has(q.id);
  const done = ["answered", "cancelled"].includes(q.status);
  const needsReopen = ["deferred", "blocked"].includes(q.status);
  // 受阻/已延期/已回答的卡：回答框与参考选项都锁着 —— 先恢复待答再说。
  const locked = busy || done || needsReopen;
  const statusLabel = STATUS_LABEL[q.status] || q.status;
  const roleOptions = [...ROLE_OPTIONS];
  if (q.role && !roleOptions.includes(q.role)) roleOptions.push(q.role);
  // 认不出的优先级退回第一档（旧的 <select> 没有 selected 时浏览器也是这个行为）。
  const priority = PRIORITY_OPTIONS.some(([v]) => v === draft.priority) ? draft.priority : "low";

  return (
    <div className={"qcard" + (done ? " answered" : needsReopen ? " deferred" : "")} data-qidx={i}>
      <div className="qmeta">
        <span className={"qbadge " + q.status}>{statusLabel}</span>
        <span className={"qbadge " + q.priority}>
          {(q.priority === "high" || q.priority === "blocking" ? "高" : q.priority === "low" ? "低" : "普通") + "优先级"}
        </span>
        {q.code ? <span className="qbadge">{q.code}</span> : null}
        <span className="qbadge">{q.sourceLabel || q.source}</span>
      </div>
      <div className="qtext">{q.text}</div>
      {q.why ? <div className="qwhy">为什么问：{q.why}</div> : null}
      {q.impact ? <div className="qimpact">影响：{q.impact}</div> : null}
      {q.applies.length ? <div className="cap">关联：{q.applies.join("、")}</div> : null}
      {(q.evidence || []).slice(0, 3).map((e: any, k: number) => {
        const cite = typeof e === "object" ? (e.cite || e.location || e.id || "") : String(e);
        const file = typeof e === "object" ? (e.file_name || e.file || "") : "";
        return cite ? (
          <button key={k} className="ev" data-file={file} data-cite={cite}
            onClick={() => showSource(file, cite)}>◧ {cite}</button>
        ) : null;
      })}
      <div className="qfields">
        <input className="qinput" data-q-owner="" aria-label="负责人" placeholder="负责人 / owner"
          value={draft.owner} disabled={busy}
          onChange={e => put({ owner: e.target.value })} />
        <select className="qselect" data-q-role="" aria-label="应答角色"
          value={draft.role} disabled={busy}
          onChange={e => put({ role: e.target.value })}>
          {roleOptions.map(x => <option key={x} value={x}>{x || "应答角色"}</option>)}
        </select>
        <select className="qselect" data-q-priority="" aria-label="优先级"
          value={priority} disabled={busy}
          onChange={e => put({ priority: e.target.value })}>
          {PRIORITY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {q.options.length ? (
          <select className="qselect" data-q-option="" aria-label="参考选项"
            value={draft.option} disabled={locked}
            onChange={e => put({ option: e.target.value })}>
            <option value="">选择参考答案（可选）</option>
            {q.options.map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ) : <span></span>}
      </div>
      <textarea className="qanswer" data-q-answer="" aria-label="问题答案"
        placeholder="记录业务人员的原话；可补充背景、例外和证据"
        value={draft.answer} disabled={locked}
        onChange={e => put({ answer: e.target.value })} />
      <div className="qactions">
        {done
          ? <button className="act" disabled={busy} onClick={() => reopen(i)}>重新打开</button>
          : needsReopen
            ? <button className="act pri" disabled={busy} onClick={() => reopen(i)}>恢复待答</button>
            : <>
              <button className="act pri" disabled={busy}
                onClick={() => submit(i, draft.answer.trim(), draft.option)}>{busy ? "保存中…" : "提交回答"}</button>
              <button className="act" disabled={busy} onClick={() => defer(i)}>延期</button>
            </>}
        <button className="act" disabled={busy}
          onClick={() => saveMeta(i, { owner: draft.owner, role: draft.role, priority })}>保存分派</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  工作台本体
// ══════════════════════════════════════════════════════════════════
export function QuestionWorkbench(): ReactNode {
  const G = useUi();
  if (!G.S) return null;
  const counts: Record<string, number> = { open: 0, answered: 0, deferred: 0 };
  G.Q_BACKLOG.forEach((q: any) => {
    const bucket = isActive(q) ? "open" : q.status;
    counts[bucket] = (counts[bucket] || 0) + 1;
  });
  const filtered = G.Q_BACKLOG.map((q: any, i: number) => ({ q, i })).filter(({ q }) => {
    if (G.Q_FILTER === "all") return true;
    if (G.Q_FILTER === "open") return isActive(q);
    if (G.Q_FILTER === "high") return isActive(q) && ["high", "blocking"].includes(q.priority);
    return q.status === G.Q_FILTER;
  });
  const shown = filtered.slice(0, G.Q_LIMIT);
  const filters: Array<[string, string]> = [
    ["open", `待回答 ${counts["open"] || 0}`], ["high", "高优先级"],
    ["answered", `已回答 ${counts["answered"] || 0}`], ["deferred", `已延期 ${counts["deferred"] || 0}`],
    ["all", `全部 ${G.Q_BACKLOG.length}`],
  ];
  const more = (): void => { G.Q_LIMIT += 40; bumpUi(); };

  return <>
    <div className="qwbhead">
      <div>
        <div className="qwbtitle">FDE 问题工作台</div>
        <div className="qwbsum">回答会更新 Decision Ledger，并触发受影响产物的增量重算</div>
      </div>
      <button className="act" onClick={() => reload()}>刷新</button>
    </div>
    <DeliverBar />
    <ReturnAuditCard />
    <NextBatch />
    {G.Q_API ? null : <div className="qnotice">兼容模式：已汇总材料问卷与冲突问题；当前后端未启用统一 Question Ledger，分派、延期和自由文本回答暂为只读。</div>}
    <div className="qfilters">{filters.map(([k, label]) => (
      <button key={k} className={"qfilter " + (G.Q_FILTER === k ? "on" : "")}
        onClick={() => setFilter(k)}>{label}</button>
    ))}</div>
    {shown.length
      ? shown.map(({ q, i }) => <QCard key={q.id ?? i} q={q} i={i} />)
      : <div className="qempty">这个筛选下没有问题</div>}
    {filtered.length > shown.length
      ? <button className="qmore" onClick={more}>再显示 {Math.min(40, filtered.length - shown.length)} 条</button>
      : null}
  </>;
}

// ══════════════════════════════════════════════════════════════════
//  产物 tab
// ══════════════════════════════════════════════════════════════════
/**
 * 交付包那一行 + 回传预审卡 + 产物列表。
 *
 * **空态只给占位符** —— 一份产物都没有的时候不画「导出 Bundle」，那是原来的行为：
 * 一个下下来必然是空的包，比没有这个按钮更让人以为出了错。
 *
 * <ArtifactRows/> 是 preview track 的组件（产物列表本身归它），这里只把 Bundle 与
 * 回传两块接上去 —— 它们的门禁与状态都在这条 track 手里。
 */
export function ArtifactsTab(): ReactNode {
  const G = useUi();
  const arts = G.S?.state?.artifacts || [];
  if (!arts.length) return <ArtifactRows />;      // 空态的占位符由它自己给
  return <>
    <div className="chunk">
      <div className="c">交付包（含清单与溯源）</div>
      <div className="acts">
        <BundleLink label="导出 Bundle" />
        <button className="act pri" onClick={() => pickReturn()}>上传业务方回传模板</button>
      </div>
    </div>
    <ReturnAuditCard />
    <ArtifactRows />
  </>;
}

// ══════════════════════════════════════════════════════════════════
//  Engagement 工作流条（推理 tab 顶部）
// ══════════════════════════════════════════════════════════════════
export function EngagementProgress(): ReactNode {
  const G = useUi();
  const engagement = G.S?.state?.engagement;
  if (!engagement?.plan?.length) return null;
  const release = releaseView();
  // 「计划冻不冻结」与「发布状态」是两件事，各说各的 —— 不能拿冻结冒充已发布。
  return (
    <div className="eng">
      <div className="enghead">
        <div className="engtitle">FDE Engagement 工作流</div>
        <div className="engmeta">{`${engagement.frozen ? "FROZEN DAG" : "EDITABLE PLAN"} · ${release.state}${release.blockers ? ` (${release.blockers} BLOCKERS)` : ""} · ${engagement.version || ""}`}</div>
      </div>
      <div className="engsteps">{engagement.plan.map((n: any, i: number) => (
        <span key={n.id ?? i} className={"engstep " + (n.state || "pending")} title={n.mode || ""}>
          {ENG_LABELS[n.id] || n.id}
        </span>
      ))}</div>
    </div>
  );
}

// ── 接进右栏 ──────────────────────────────────────────────────────
// preview track 定的接法：**在自己的模块顶层往 PREVIEW_TABS 里登记**，不改它那个
// 文件（见 react/preview.tsx 末尾）。#pbody 的 registerRegion 要等七个 tab 齐了才落，
// 所以这两行现在还不改变任何显示 —— 它们只是把这条 track 的那两块交出去。
//
// think 那个 tab 不在这里：它是 <EngagementProgress/> 加上 events.ts 的
// traceRow()/opsLog()，后两个还没交出组件，凑不出一整块。
PREVIEW_TABS["q"] = QuestionWorkbench;
PREVIEW_TABS["art"] = ArtifactsTab;
