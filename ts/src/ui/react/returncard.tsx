// 业务方回传件的预审卡（returnaudit.ts 里 returnAuditCard() 的组件形态）。
//
// ## 这张卡钉住的那条契约：**预审 → 人点头 → 应用**，三步一步都不能省
//
// 它自己只负责第三步的**入口**：预审没给出明确可读结果、或者检出结构损伤时，
// 「确认应用并生成新版本」这个按钮**根本不出现**（不是画出来再 disabled ——
// 一个点得到的按钮加一句 alert，和一个不存在的按钮，是两种不同的安全等级）。
// 真正的闸在 applyReturnAudit() 里，那份逻辑一个字没动。
//
// 已应用之后给的是 <BundleLink>，跟着发布门禁走：回传件合并完照样可能有阻塞
// 问题，此时新包一样不许下载。
//
// 类名与结构逐字对齐原来的模板字符串：.retcard(.warn) .retstats .retstat
// .retlist .qtext .qwhy .qimpact .qactions —— 767 行 CSS 认的就是这些。

import type { ReactElement, ReactNode } from "react";

import { cancelReturnAudit, applyReturnAudit } from "../returnaudit.js";
import { bumped } from "./bridge.js";
import { BundleLink } from "./bundle.js";
import { useUi } from "./store.js";

const cancel = bumped(cancelReturnAudit);
const apply = bumped(applyReturnAudit);

/** 数组 / 单值 / 空 三种形态收成数组（原 asList，逐字同一份判断）。 */
const asList = (x: any): any[] => Array.isArray(x) ? x : x ? [x] : [];

function DiffItem({ x }: { x: any }): ReactElement {
  if (typeof x !== "object") return <li>{String(x)}</li>;
  const at = x.path || [x.rid, x.field].filter(Boolean).join(".") || "字段";
  return <li>{at}：{x.before ?? ""} → {x.after ?? ""}</li>;
}

function List({ title, items }: { title: string; items: any[] }): ReactNode {
  if (!items.length) return null;
  return <>
    <div className="qimpact">{title}</div>
    <ul className="retlist">{items.slice(0, 8).map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
  </>;
}

export function ReturnAuditCard(): ReactNode {
  const G = useUi();
  if (G.RETURN_BUSY) return (
    <div className="retcard">
      <div className="qtext">{`正在${G.RETURN_AUDIT ? "应用" : "预审"}回传件…`}</div>
      <div className="cap">先校验锚点、遗漏、结构损伤和非目标变更，不会直接覆盖当前产物。</div>
    </div>
  );
  if (!G.RETURN_AUDIT) return null;
  if (G.RETURN_AUDIT.error) return (
    <div className="retcard warn">
      <div className="qtext">回传件没有通过预审</div>
      <div className="qwhy">{G.RETURN_AUDIT.error}</div>
      <div className="qactions">
        <button className="act" onClick={() => cancel()}>关闭</button>
      </div>
    </div>
  );

  const a = G.RETURN_AUDIT;
  const findings = a.findings || a.counts || {};
  const findingN: any = typeof findings === "number" ? findings : Array.isArray(findings) ? findings.length
    : Object.values(findings).reduce((n: any, x: any) => n + (Number.isFinite(Number(x)) ? Number(x) : 0), 0);
  const changed = Number(a.cells_changed ?? a.changed?.length ?? a.applied_count ?? 0);
  const diffs = asList(a.diff || a.diffs || a.changes);
  const dropped = asList(a.dropped || a.unmatched_rows);
  const damage = asList(a.damage);
  // **fail closed**：没读出明确的 readable:true，或者有任何结构损伤，就没有应用入口。
  const previewBlocked = !a.applied && (a.readable !== true || damage.length > 0);
  const revision = a.revision ?? a.artifact_revision ?? G.S.state?.artifact_revision;

  return (
    <div className={"retcard" + ((damage.length || findingN) ? " warn" : "")}>
      <div className="qtext">{`${a.applied ? "回传答复已应用" : "回传件预审"} · ${G.RETURN_FILE?.name || ""}`}</div>
      <div className="retstats">
        <div className="retstat"><b>{Math.round(Number(a.completeness || 0) * 100)}%</b>完成度</div>
        <div className="retstat"><b>{changed}</b>处变化</div>
        <div className="retstat"><b>{findingN}</b>项待处理</div>
      </div>
      <List title={`结构损伤 ${damage.length} 处`} items={damage} />
      {diffs.length ? <>
        <div className="qimpact">{`差异预览（前 ${Math.min(8, diffs.length)} 项）`}</div>
        <ul className="retlist">{diffs.slice(0, 8).map((x, i) => <DiffItem key={i} x={x} />)}</ul>
      </> : null}
      <List title={`未合并 / 丢弃 ${dropped.length} 项`} items={dropped} />
      <div className="qwhy">{a.applied
        ? `已生成 ${revision === undefined ? "新" : "revision " + revision}；问题清单和关联产物已刷新。`
        : previewBlocked
          ? "已阻断应用：请恢复隐藏锚点与表结构后重新上传；当前 Ontology 未发生任何变化。"
          : "此时尚未写入 Ontology。确认后才会应用安全差异并生成新 revision。"}</div>
      <div className="qactions">
        {a.applied ? <BundleLink label="下载新 Bundle" className="act pri" />
          : previewBlocked ? null
            : <button className="act pri" onClick={() => apply()}>确认应用并生成新版本</button>}
        <button className="act" onClick={() => cancel()}>{a.applied ? "完成" : "取消"}</button>
      </div>
    </div>
  );
}
