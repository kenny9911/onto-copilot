// 推理 tab —— preview.ts 里 paint() 那第七个分支的组件形态。
//
// 三块，次序与旧模板串逐字一致：
//   1. Engagement 工作流条（workbench.tsx 的 <EngagementProgress/>，那条 track 的东西）
//   2. **按轮次分组**的推理轨迹（traceRow()）
//   3. 操作记录（opsLog()）
//
// 分组这件事不是排版偏好：不分组的话不同问题的步骤混在一起，步号还会重复 ——
// 看的人分不清哪一步属于哪个问题。最新的一轮排在最上面（groups.reverse()），
// 只有它不带那个 `· ` 前缀。
//
// 「AI 想了什么」（TRACE，每轮一组）和「系统做了什么」（OPS，一条倒序时间线）是
// **两件事**，所以是两块，不是一块。后者以前只在聊天流那张会滚走的折叠卡上，
// 想回头查「刚才那次梳理跑了哪几步、哪一步失败了」没有地方可查。
//
// 类名与结构逐字对齐原来的模板字符串：.tgrp .opgrp .tgq .trw .trn .trb .trt .trc
// .tro .oprow .tag .opd .opt —— 少一个类名就是少一块样式，那等于改设计。
//
// **思考文字全文显示，不截断**：这个 tab 存在的理由就是让人能核对它到底想了
// 什么，截断的思考和没有思考一样不可核对。（聊天流里那份 <StepsCard> 才截到
// 240 字 —— 那里是顺带看一眼，这里是专门来查。）

import type { ReactElement, ReactNode } from "react";

import { hhmm } from "../dom.js";
import { Placeholder, PREVIEW_TABS } from "./preview.js";
import { useUi } from "./store.js";
import { EngagementProgress } from "./workbench.js";

/** 推理轨迹的一行。序号缺失时给一个「·」，而不是留一格空白。 */
export function TraceRow({ x }: { x: any }): ReactElement {
  return (
    <div className="trw">
      <div className="trn">{x.n ?? "·"}</div>
      <div className="trb">
        {x.thought ? <div className="trt">{x.thought}</div> : null}
        {x.tool ? <div className="trc"><code>{x.tool}</code> {JSON.stringify(x.args || {})}</div> : null}
        {x.observation ? <div className="tro">{String(x.observation)}</div> : null}
      </div></div>
  );
}

/** 按轮次分组的推理轨迹。最新的一轮在最上面。 */
export function TraceGroups(): ReactNode {
  const G = useUi();
  const groups: any[] = [];
  for (const x of G.TRACE) {
    const g = groups.find(y => y.turn === x.turn);
    if (g) g.rows.push(x); else groups.push({ turn: x.turn, q: x.q, rows: [x] });
  }
  return <>{groups.reverse().map((g, i) => (
    <div className="tgrp" key={g.turn ?? i}>
      <div className="tgq">{i === 0 ? "" : "· "}{g.q || ""}</div>
      {g.rows.slice().sort((a: any, b: any) => a.n - b.n)
        .map((x: any, k: number) => <TraceRow x={x} key={k} />)}
    </div>
  ))}</>;
}

/**
 * 操作记录 —— **这个会话里发生过的每一件事**，倒序，最新的在最上面。
 *
 * 一条都没有时整块不画（旧 opsLog() 返回空串）：一个只有标题、下面什么都没有的
 * 分组比不画更让人以为漏渲染了。
 */
export function OpsLog(): ReactNode {
  const G = useUi();
  if (!G.OPS.length) return null;
  return (
    <div className="tgrp opgrp">
      <div className="tgq">操作记录 · {G.OPS.length} 条</div>
      {G.OPS.slice().reverse().map((o: any, i: number) => (
        <div className="oprow" key={o.seq === undefined ? i : `${o.seq}-${o.kind}`}>
          <span className={"tag " + o.tag}>{o.label}</span>
          <span className="opd">{o.detail || ""}</span>
          <span className="opt">{hhmm(o.ts)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 推理 tab 的整块。
 *
 * **两条轨迹都空时仍然画工作流条**，占位符跟在它后面 —— 旧代码就是这样
 * （`workflow + ph("REASONING", …)`）：还没问过话的会话，最该看见的正是
 * 「这次交付分几步、走到哪了」。
 */
export function ThinkTab(): ReactNode {
  const G = useUi();
  if (!G.TRACE.length && !G.OPS.length) {
    return <>
      <EngagementProgress />
      <Placeholder ic="REASONING">问一句话，这里会显示它想了什么、查了什么</Placeholder>
    </>;
  }
  return <><EngagementProgress /><TraceGroups /><OpsLog /></>;
}

// ── 接进右栏 ──────────────────────────────────────────────────────
// preview track 定的接法：**在自己的模块顶层往 PREVIEW_TABS 里登记**，不改它那个
// 文件。这是七个 tab 里最后一个 —— 它一登记，#pbody 就整块归了 React。
PREVIEW_TABS["think"] = ThinkTab;
