// 全量日志 tab。
//
// **一行 CSS 都不加。** 类名全部借设置弹窗现有的那套（.sgrp/.slabel/.envtbl/
// .envrow/.cap/.fnd/.act/.badge），栅格差异走行内 style —— 模板的 CSS 被
// verify-ui-shell.mjs 钉在一个 git blob 上逐字节比对，加一条就多一处红。
//
// 展示层刻意不去"美化" payload：这是给运维和管理员看的东西，原始 JSON 比一个
// 猜出来的摘要更有用。能套上推理形状（thought/tool/observation）的就套，套不上
// 就原样 <pre>，不硬凑 —— draft.updated / corpus.ready 这些 payload 根本不是
// 那个形状，硬套只会把信息挤没。

import type { ReactElement, ReactNode } from "react";

import { evLabel, evTag } from "../events.js";
import {
  LOGB, backToLogSessions, loadLogEvents, loadLogSessions, setLogKind, toggleLogFull,
} from "../logs.js";
import { useUi } from "./store.js";

function when(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** 会话清单。管理员能看到「归属」这一列，普通用户看不到（他只有自己的，那一列是废话）。 */
function SessionList(): ReactElement {
  if (!LOGB.sessions.length) return <div className="fnd">还没有任何会话日志。</div>;
  return (
    <div className="sgrp">
      <div className="slabel">
        会话 {LOGB.sessions.length} 个
        {LOGB.canSeeAll ? <span className="cap" style={{ marginLeft: "8px" }}>管理员视图：可见全部账号</span> : null}
      </div>
      <div className="envtbl">
        {LOGB.sessions.map((s) => (
          <div className="envrow" key={s.id}
            style={{ cursor: "pointer" }}
            onClick={() => { void loadLogEvents(s.id, s.title, 0); }}>
            <b>{s.title || "（无标题）"}</b>
            {LOGB.canSeeAll ? <span>{s.owner_name || s.owner || "（无归属）"}</span> : null}
            <span className="cap">{when(s.created)}</span>
            {s.status && s.status !== "idle" ? <span className="badge warn">{s.status}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 一条事件。能套上推理形状就套，套不上就原样 JSON。 */
function EventRow({ e }: { e: (typeof LOGB.events)[number] }): ReactElement {
  const full = LOGB.full.get(e.seq);
  return (
    <div className="envrow" style={{ display: "block" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ minWidth: "3em" }}>#{e.seq}</b>
        <span className={"badge " + (evTag(e.kind) || "")}>{evLabel(e.kind) || e.kind}</span>
        <span className="cap">{when(e.ts)}</span>
        {e.redacted ? (
          // 打了码就要说 —— 打码而不说，等于在审计日志上撒谎。
          <span className="badge warn" title="其中的凭证已打码">已打码</span>
        ) : null}
        <span className="cap">{e.bytes} B</span>
        <button className="act" style={{ marginLeft: "auto" }}
          onClick={() => { void toggleLogFull(e.seq); }}>
          {full === undefined ? "展开全文" : "收起"}
        </button>
      </div>
      {full === undefined ? (
        <div className="cap" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", marginTop: "4px" }}>
          {e.preview}{e.truncated ? " …" : ""}
        </div>
      ) : (
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", marginTop: "6px", fontSize: ".75rem" }}>{full}</pre>
      )}
    </div>
  );
}

const KINDS: readonly [string, string][] = [
  ["", "全部"],
  ["chat.turn", "对话"],
  ["chat.step", "推理步骤"],
  ["kernel.thought", "内核思考"],
  ["kernel.plan", "计划"],
  ["kernel.critic", "审查"],
];

function EventList(): ReactElement {
  return (
    <>
      <div className="sgrp">
        <div className="slabel">
          <button className="act" onClick={() => backToLogSessions()}>← 返回</button>
          <span style={{ marginLeft: "8px" }}>{LOGB.openTitle || LOGB.openSid}</span>
          <span className="cap" style={{ marginLeft: "8px" }}>共 {LOGB.total} 条</span>
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px" }}>
          {KINDS.map(([k, label]) => (
            <button key={k} className={"act" + (LOGB.kind === k ? " pri" : "")}
              onClick={() => setLogKind(k)}>{label}</button>
          ))}
        </div>
        <div className="envtbl">
          {LOGB.events.length
            ? LOGB.events.map((e) => <EventRow e={e} key={e.seq} />)
            : <div className="fnd">这一页没有匹配的事件。</div>}
        </div>
        {LOGB.nextSince !== null ? (
          <button className="act" style={{ marginTop: "6px" }}
            onClick={() => { void loadLogEvents(LOGB.openSid, LOGB.openTitle, LOGB.nextSince ?? 0); }}
          >读取更多</button>
        ) : null}
      </div>
    </>
  );
}

export function LogsTab(): ReactNode {
  useUi();
  if (LOGB.error) return <div className="fnd">{LOGB.error}</div>;
  if (LOGB.loading && !LOGB.sessions.length && !LOGB.events.length) {
    return <div className="cap">{LOGB.loading}</div>;
  }
  if (!LOGB.sessions.length && !LOGB.openSid) {
    // 第一次进来还没拉过：触发一次，别让用户看着空白以为坏了。
    void loadLogSessions();
    return <div className="cap">加载中…</div>;
  }
  return LOGB.openSid ? <EventList /> : <SessionList />;
}
