// 待办卡片（decisions.ts 里 pendingCard() / questionCards() / suggestionCards() 的组件形态）。
//
// 它是**对话流里的一条消息**，钉在「梳理刚完成、用户还没开口」那个时间点，之后
// 每一句对话都排在它后面。所以它可折叠：处理过一轮之后就该让位给对话，而不是
// 一直占半屏。
//
// 两块内容的次序是有意的：**必须人拍板的决策在前，不阻塞的建议在后。**
//
//   · 决策卡：选项带证据，点证据跳回原文；没选中之前「确认」是灰的 ——
//     选择本身就是那次不可逆动作的输入，空着提交只会写进一个没人做过的决定。
//     已确认的卡不再可选（选项没有 onClick），只留一行「已确认」。
//   · 建议卡：**每一条都要能直接采纳**。一个采纳不了的建议不如不给，它让人以为
//     做了决定而实际什么都没发生。ASK_MATERIAL 是唯一的例外（它要的是上传材料，
//     不是一次可执行的改动），所以那一类没有按钮。
//
// 采纳走的是对话通道，和用户自己打字说「第 N 条建议采纳」**完全同一条路径** ——
// 两条路径会漂移，而漂移的那天你不会知道该信哪个。
//
// 类名与结构逐字对齐原来的模板字符串：.pcard .pchead .ptri .pchi .pcbody
// .q(.answered) .qh .qm .qt .qbody .opt(.sel) .rd .rr .ev .cap .acts .act.pri
// .sgc .sgh .sgi .sgt .sgm .sgr

import { useState, type ReactElement, type ReactNode } from "react";

import { plainQuestionCopy, plainUserFacingCopy } from "../../onto/plain_language.js";
import { adopt, pickAnswer, postAnswer } from "../decisions.js";
import { openSource } from "../preview.js";
import { bumped } from "./bridge.js";
import { bumpUi, useUi } from "./store.js";

const showSource = bumped(openSource);
const take = bumped(adopt);

/** 建议种类的图标。认不出的种类给一个中性的 ▸，不是不画。 */
const ICON: Record<string, string> = {
  ADD_LINK: "⇢", ASK_MATERIAL: "◱", EXCLUDE: "⊘", NAMING: "Aa",
  BIND_RULE: "§", REVIEW: "◎",
};

// ══════════════════════════════════════════════════════════════════
//  必须人拍板的决策
// ══════════════════════════════════════════════════════════════════
function DecisionCard({ q, i, n, done }: { q: any; i: number; n: number; done: boolean }): ReactElement {
  const G = useUi();
  const [busy, setBusy] = useState(false);
  const chosen = G.ANSWERS[q.id];
  const title = plainUserFacingCopy(plainQuestionCopy(q.title).text);
  const confirm = (): void => {
    setBusy(true);
    void postAnswer(q.id, q.conflict_rid).finally(() => { setBusy(false); bumpUi(); });
  };
  return (
    <div className={"q" + (done ? " answered" : "")}>
      <div className="qh">
        <div className="qm">{`第 ${i + 1}/${n} 个问题 · 涉及 ${q.impact_count} 项 · ${q.reversible ? "可以撤销" : "确认后不能自动撤销"}`}</div>
        <div className="qt">{title}</div>
      </div>
      <div className="qbody">
        {(q.options || []).map((o: any) => (
          <div key={o.id} className={"opt" + (chosen === o.id ? " sel" : "")}
            {...(done ? {} : { onClick: () => { pickAnswer(q.id, o.id); bumpUi(); } })}>
            <span className="rd"></span>
            <div>{plainUserFacingCopy(o.label)}
              {o.rationale ? <div className="rr">{plainUserFacingCopy(o.rationale)}</div> : null}
              {(o.evidence || []).slice(0, 3).map((e: any, k: number) => (
                <span key={k} className="ev"
                  onClick={ev => { ev.stopPropagation(); showSource(e.file_name, e.cite); }}>◧ {e.cite}</span>
              ))}
            </div>
          </div>
        ))}
        {done ? <div className="cap">已确认</div> : (
          <div className="acts">
            {/* 没选中之前点不动 —— 这一格就是那次不可逆动作的输入。 */}
            <button className="act pri" data-submit={q.id} disabled={!chosen || busy}
              onClick={confirm}>{busy ? "提交中…" : "确认"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function DecisionCards(): ReactNode {
  const G = useUi();
  const qs = G.S?.state?.questions || [];
  if (!qs.length) return null;
  const answered = new Set(G.S.state?.answered || []);
  return <>{qs.map((q: any, i: number) => (
    <DecisionCard key={q.id ?? i} q={q} i={i} n={qs.length} done={answered.has(q.conflict_rid)} />
  ))}</>;
}

// ══════════════════════════════════════════════════════════════════
//  不阻塞的建议
// ══════════════════════════════════════════════════════════════════
export function SuggestionCards(): ReactNode {
  const G = useUi();
  const ss = G.S?.state?.suggestions || [];
  if (!ss.length) return null;
  return <>{ss.map((x: any, i: number) => (
    <div className="sgc" key={i}>
      <div className="sgh">
        <span className="sgi">{ICON[x.kind] || "▸"}</span>
        <span className="sgt">{plainUserFacingCopy(x.title)}</span>
        <span className="sgm">{`涉及 ${x.impact} 项 · 可信度 ${Math.round(x.confidence * 100)}%`}</span>
      </div>
      <div className="sgr">{plainUserFacingCopy(x.rationale)}</div>
      {(x.citations || []).slice(0, 3).map((c: any, k: number) => (
        <span key={k} className="ev" onClick={() => showSource("", c)}>◧ {c}</span>
      ))}
      {x.kind === "ASK_MATERIAL" ? null : (
        <div className="acts">
          <button className="act" onClick={() => take(i + 1)}>采纳</button>
        </div>
      )}
    </div>
  ))}</>;
}

// ══════════════════════════════════════════════════════════════════
//  外壳
// ══════════════════════════════════════════════════════════════════
export function PendingCard(): ReactNode {
  const G = useUi();
  // 已确认的决策仍然算数（卡片上要看得到「已确认」），只有全部处理完才收起整块。
  const q = (G.S?.state?.questions || []).filter((x: any) =>
    !(G.S?.state?.answered || []).includes(x.conflict_rid));
  const sg = G.S?.state?.suggestions || [];
  if (!q.length && !sg.length) return null;
  const head = `${q.length ? `${q.length} 个待拍板` : ""}${q.length && sg.length ? " · " : ""}${sg.length ? `${sg.length} 条建议` : ""}`;
  return (
    <div className="pcard">
      <div className="pchead" onClick={() => { G.PENDING_OPEN = !G.PENDING_OPEN; bumpUi(); }}>
        <span className="ptri">{G.PENDING_OPEN ? "▾" : "▸"}</span>
        <span className="pchi">◔</span> 我梳理时发现了这些 · {head}
      </div>
      {G.PENDING_OPEN ? <div className="pcbody"><DecisionCards /><SuggestionCards /></div> : null}
    </div>
  );
}
