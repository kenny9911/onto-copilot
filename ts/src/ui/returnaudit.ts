// 业务方回传件：预审 → 确认 → 应用。
import { G } from "./state.js";
import { $, API, esc, j } from "./dom.js";
import { showLogin } from "./auth.js";
import { loadQuestions, bundleLink } from "./questions.js";
import { render } from "./render.js";
import { paint } from "./preview.js";

export function openReturnPicker(){
  if (!G.S) return;
  const p = $("returnPicker");
  if (p) { p.value = ""; p.click(); }
}
export async function auditReturnPicked(){
  const p = $("returnPicker"), file = p?.files?.[0];
  if (!file || !G.S) return;
  G.RETURN_FILE = file; G.RETURN_AUDIT = null; G.RETURN_BUSY = true; paint();
  try {
    const form = new FormData(); form.append("files", file, file.name);
    const r = await fetch(`${API}/api/sessions/${G.S.id}/audit?apply=false`, {method:"POST", body:form});
    if (r.status === 401) showLogin();
    if (!r.ok) throw new Error((await r.text()).slice(0,300) || `HTTP ${r.status}`);
    G.RETURN_AUDIT = await r.json();
  } catch (e: any) {
    G.RETURN_AUDIT = {error:String(e.message || e)};
  } finally { G.RETURN_BUSY = false; paint(); }
}

export async function applyReturnAudit(){
  if (!G.S || !G.RETURN_FILE || G.RETURN_BUSY) return;
  if (!G.RETURN_AUDIT || G.RETURN_AUDIT.error || G.RETURN_AUDIT.readable !== true) {
    alert("请先完成且通过回传件预审；未取得明确可读结果时不会应用任何数据。");
    return;
  }
  const damaged = (G.RETURN_AUDIT?.damage || []).length;
  if (damaged) {
    alert(`检测到 ${damaged} 处结构损伤，系统不会应用任何数据。请按提示修复模板后重新上传。`);
    return;
  }
  const msg = "确认把预审通过的业务答复写入当前 Ontology，并生成新 revision？";
  if (!confirm(msg)) return;
  G.RETURN_BUSY = true; paint();
  try {
    const form = new FormData(); form.append("files", G.RETURN_FILE, G.RETURN_FILE.name);
    const r = await fetch(`${API}/api/sessions/${G.S.id}/audit?apply=true`, {method:"POST", body:form});
    if (r.status === 401) showLogin();
    if (!r.ok) throw new Error((await r.text()).slice(0,300) || `HTTP ${r.status}`);
    const applied: any = await r.json();
    G.RETURN_AUDIT = {...G.RETURN_AUDIT, ...applied, applied:true};
    const st = await j(`/api/sessions/${G.S.id}/state`);
    const evs = G.S.events; Object.assign(G.S, st); G.S.events = evs;
    G.S.files = (st.filelist || []).length;
    await loadQuestions(); render(); paint();
  } catch (e: any) {
    G.RETURN_AUDIT = {...(G.RETURN_AUDIT || {}), error:String(e.message || e)};
  } finally { G.RETURN_BUSY = false; paint(); }
}

export function cancelReturnAudit(){
  G.RETURN_AUDIT = null; G.RETURN_FILE = null; G.RETURN_BUSY = false;
  const p = $("returnPicker"); if (p) p.value = "";
  paint();
}

export function returnAuditCard(){
  if (G.RETURN_BUSY) return `<div class="retcard"><div class="qtext">正在${G.RETURN_AUDIT?"应用":"预审"}回传件…</div>
    <div class="cap">先校验锚点、遗漏、结构损伤和非目标变更，不会直接覆盖当前产物。</div></div>`;
  if (!G.RETURN_AUDIT) return "";
  if (G.RETURN_AUDIT.error) return `<div class="retcard warn"><div class="qtext">回传件没有通过预审</div>
    <div class="qwhy">${esc(G.RETURN_AUDIT.error)}</div><div class="qactions">
      <button class="act" onclick="cancelReturnAudit()">关闭</button></div></div>`;
  const a = G.RETURN_AUDIT;
  const findings = a.findings || a.counts || {};
  const findingN: any = typeof findings === "number" ? findings : Array.isArray(findings) ? findings.length
    : Object.values(findings).reduce((n: any, x: any) => n + (Number.isFinite(Number(x)) ? Number(x) : 0), 0);
  const changed = Number(a.cells_changed ?? a.changed?.length ?? a.applied_count ?? 0);
  const asList = (x: any) => Array.isArray(x) ? x : x ? [x] : [];
  const diffs = asList(a.diff || a.diffs || a.changes);
  const dropped = asList(a.dropped || a.unmatched_rows);
  const damage = asList(a.damage);
  const previewBlocked = !a.applied && (a.readable !== true || damage.length > 0);
  const revision = a.revision ?? a.artifact_revision ?? G.S.state?.artifact_revision;
  return `<div class="retcard ${(damage.length||findingN)?"warn":""}">
    <div class="qtext">${a.applied?"回传答复已应用":"回传件预审"} · ${esc(G.RETURN_FILE?.name || "")}</div>
    <div class="retstats">
      <div class="retstat"><b>${Math.round(Number(a.completeness || 0)*100)}%</b>完成度</div>
      <div class="retstat"><b>${changed}</b>处变化</div>
      <div class="retstat"><b>${findingN}</b>项待处理</div>
    </div>
    ${damage.length ? `<div class="qimpact">结构损伤 ${damage.length} 处</div><ul class="retlist">${damage.slice(0,8).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${diffs.length ? `<div class="qimpact">差异预览（前 ${Math.min(8,diffs.length)} 项）</div><ul class="retlist">${diffs.slice(0,8).map(x=>{
      if (typeof x !== "object") return `<li>${esc(x)}</li>`;
      const at = x.path || [x.rid,x.field].filter(Boolean).join(".") || "字段";
      return `<li>${esc(at)}：${esc(x.before ?? "")} → ${esc(x.after ?? "")}</li>`;
    }).join("")}</ul>` : ""}
    ${dropped.length ? `<div class="qimpact">未合并 / 丢弃 ${dropped.length} 项</div><ul class="retlist">${dropped.slice(0,8).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${a.applied ? `<div class="qwhy">已生成 ${revision===undefined?"新":"revision "+revision}；问题清单和关联产物已刷新。</div>` : previewBlocked
      ? `<div class="qwhy">已阻断应用：请恢复隐藏锚点与表结构后重新上传；当前 Ontology 未发生任何变化。</div>`
      : `<div class="qwhy">此时尚未写入 Ontology。确认后才会应用安全差异并生成新 revision。</div>`}
    <div class="qactions">
      ${a.applied ? bundleLink("下载新 Bundle", "act pri")
        : previewBlocked ? "" : `<button class="act pri" onclick="applyReturnAudit()">确认应用并生成新版本</button>`}
      <button class="act" onclick="cancelReturnAudit()">${a.applied?"完成":"取消"}</button>
    </div></div>`;
}
