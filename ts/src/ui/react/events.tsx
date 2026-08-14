// 聊天流里的两块「系统在做事」：事件卡片（evCard）与推理轨迹（traceCard）。
//
// 对应 events.ts 里那两个拼模板字符串的函数，**类名与结构逐字对齐**：767 行 CSS
// 认的是 `.card` `.card>h4` `.n` `.cap` `.fnd` `.act` `.act.pri` `.trace` `.tb`
// `.step` `.tag.ok|warn|err|run` `.sub` 这些选择器，少一个类名就是少一块样式。
//
// ## 事件卡片与推理轨迹的分工（这条界线以前被搞混过）
//
// 大多数事件只进推理轨迹那条折叠时间线；只有**需要人读全文**的才升级成卡片：
// 材料里发现的问题、人拍的板、产出的东西。哪些算「需要人读全文」由 events.ts 的
// `hasCard()` 说了算 —— 组件与那份名单必须一致，所以这里第一句就是
// `if (!hasCard(ev)) return null`，而不是各写各的一套 if。
//
// ## ui.table 那张表为什么默认只画 30 行
//
// 数据由服务端直接从产物出，不经模型复述（202 个对象让模型一条条打出来，必然
// 截断、还可能记错，而且很贵）。但 202 行一次铺开会把聊天流冲垮 —— 所以默认 30 行
// 加一个展开按钮，且**展开状态按事件 seq 记**（TBL_OPEN），一屏里的两张表各记各的。
//
// ## 行内样式照抄，不许「顺手」搬进 CSS
//
// 这几张表的 style 是写在模板字符串里的（`style="overflow:auto;max-height:420px"`
// 那些）。搬进 index.html 的 CSS 就是改那 767 行，所以这里逐条译成 JSX 的 style
// 对象 —— 值一个字符都没变，`var(--line)` 这种 CSS 变量在对象写法里照样生效。

import type { ReactNode } from "react";

import { API, fmtSize } from "../dom.js";
import { evDetail, evLabel, evTag, hasCard } from "../events.js";
import { t } from "../i18n.js";
import { toggleTable } from "../preview.js";
import { TBL_OPEN } from "../state.js";
import { BundleLink } from "./bundle.js";
import { useUi } from "./store.js";

// ── ui.table 的行内样式（逐条抄自原模板字符串）────────────────────
const TBL_BOX = { overflow: "auto", maxHeight: "420px", marginTop: "6px" } as const;
const TBL = { borderCollapse: "collapse", width: "100%", fontSize: "0.926rem" } as const;
const TH = {
  textAlign: "left", padding: "5px 8px", borderBottom: "1px solid var(--line)",
  position: "sticky", top: 0, background: "var(--panel)", whiteSpace: "nowrap",
} as const;
const TD = {
  padding: "5px 8px", borderBottom: "1px solid var(--line-soft)", verticalAlign: "top",
} as const;

/** 一张动态表格。**默认 30 行**，展开状态按事件 seq 记 —— 一屏两张表各记各的。 */
function TableCard({ ev }: { ev: any }): ReactNode {
  const cols = ev.columns || [], rows = ev.rows || [];
  const N = ev.seq;
  const open = TBL_OPEN.has(N);
  const shown = open ? rows : rows.slice(0, 30);
  return (
    <div className="card"><h4>{ev.title || "清单"}</h4>
      <div style={TBL_BOX}>
        <table style={TBL}>
          <thead><tr>{cols.map((c: any, i: number) => <th key={i} style={TH}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((r: any, i: number) => (
            <tr key={i}>{r.map((v: any, k: number) => <td key={k} style={TD}>{String(v ?? "")}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      {rows.length > 30
        ? <button className="act" style={{ marginTop: "8px" }} onClick={() => { toggleTable(N); }}>
            {open ? t("table.collapse") : t("table.expand", "", { n: rows.length })}</button>
        : null}
      <div className="cap" style={{ marginTop: "4px" }}>{t("table.total", "", { n: rows.length })}</div>
    </div>
  );
}

/**
 * 值得单独占一张卡片的事件。认不出的种类画空（`null`），而不是画一张写着原始 key
 * 的空卡 —— 那是把实现细节摆到用户脸上。
 */
export function EvCard({ ev }: { ev: any }): ReactNode {
  const G = useUi();
  if (!hasCard(ev)) return null;

  if (ev.kind === "corpus.ready") {
    return (
      <div className="card">
        <h4>材料解析<span className="n">{`${ev.stats?.files ?? 0} 份 · ${ev.stats?.chunks ?? 0} 切片`}</span></h4>
        {(ev.findings || []).map((x: any, i: number) => <div className="fnd" key={i}>{x.message}</div>)}
      </div>
    );
  }

  if (ev.kind === "parse.failed") {
    return <div className="card"><h4>解析失败</h4><div className="cap">{ev.error || ""}</div></div>;
  }

  if (ev.kind === "human.recorded") {
    const changed = ev.changed || [];
    return (
      <div className="card">
        <h4>已确认<span className="n">{ev.conflict || ""}</span></h4>
        {ev.label || ""}
        {changed.length ? <div className="cap">{`变更 ${changed.join("、")}`}</div> : null}
      </div>
    );
  }

  if (ev.kind === "artifact.ready") {
    const st = ev.stats || {};
    return (
      <div className="card">
        <h4>{ev.name || "产物"}</h4>
        <div className="cap">{`${st.sheets ?? 0} 张表 · ${st.business_required ?? 0} 格待业务方填写`}</div>
        <a className="act" href={`${API}/api/sessions/${G.S.id}/artifacts/${encodeURIComponent(ev.name)}`}>下载</a>
      </div>
    );
  }

  if (ev.kind === "audit.applied") {
    const rev = ev.revision ?? ev.artifact_revision ?? "新";
    return (
      <div className="card">
        <h4>业务回传已合并<span className="n">{`revision ${rev}`}</span></h4>
        <div className="cap">{`${ev.changed ?? ev.cells_changed ?? 0} 处变化 · ${ev.dropped?.length ?? 0} 项未合并`}</div>
        <BundleLink label="下载新 Bundle" className="act pri" />
      </div>
    );
  }

  if (ev.kind === "ui.table") return <TableCard ev={ev} />;

  // 对话里导出的文件。**不进产物列表** —— 产物是梳理跑出来的东西，这是他随口要的
  // 一份拷贝，混在一起会让「全部产物」变成一个垃圾堆。
  if (ev.kind === "export.ready") {
    return (
      <div className="card">
        <h4>{ev.title || ev.name || "导出"}</h4>
        <div className="cap">{`${ev.label || ""} · ${fmtSize(ev.size)}${ev.rows ? ` · ${ev.rows} 行` : ""}`}</div>
        <a className="act pri" style={{ marginTop: "8px" }} download
          href={`${API}/api/sessions/${G.S.id}/exports/${encodeURIComponent(ev.name)}`}
        >{t("export.download", "", { name: ev.name })}</a>
      </div>
    );
  }

  if (ev.kind === "run.failed") {
    return <div className="card"><h4>没跑完</h4><div className="cap">{ev.error || ""}</div></div>;
  }

  if (ev.kind === "session.restored") {
    return (
      <div className="card"><h4>会话已恢复</h4>
        <div className="cap">{`${ev.files ?? 0} 份材料${ev.stats ? ` · ${ev.stats.objects ?? 0} 个对象` : ""}`}</div>
      </div>
    );
  }
  return null;
}

/**
 * 推理轨迹。**对话事件不进轨迹** —— 轨迹是「系统做了什么」，对话是「我们说了
 * 什么」，混在一起两边都读不清。
 *
 * 只有几条事件时默认收起：一个只有「附件、读完材料」的展开面板占了半屏却什么
 * 也没说。完整的操作记录在右栏「推理」里，这里只是就地看一眼。
 *
 * `open` 是**初值**，不是受控值：用户点开/收起之后 React 不会再写这个属性
 * （props 没变就不重新落 DOM），和内联 JS 时代那个 `<details open>` 行为一致。
 */
export function TraceCard(): ReactNode {
  const G = useUi();
  const evs = G.S.events.filter((e: any) => !["chat.turn", "chat.step"].includes(e.kind));
  if (!evs.length) return null;
  return (
    <details className="trace" open={evs.length > 4}>
      <summary>{`推理轨迹 · ${evs.length} 条`}</summary>
      <div className="tb">
        {evs.map((ev: any, i: number) => {
          const d = evDetail(ev);
          return (
            <div className="step" key={i}>
              <span className={"tag " + evTag(ev.kind)}>{evLabel(ev.kind)}</span>
              <div>{ev.model
                ? <div className="sub">{`${ev.model} · $${ev.usd}`}</div>
                : d ? <div className="sub">{d}</div> : null}</div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
