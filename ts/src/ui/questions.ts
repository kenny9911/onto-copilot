// FDE 问题工作台：Question Ledger 与历史 OIR/clarify 形态在这里收口。
import { G, Q_BUSY } from "./state.js";
import { $, API, esc, eattr, j } from "./dom.js";
import { t } from "./i18n.js";
import { refresh } from "./sessions.js";
import { paint } from "./preview.js";
import { showLogin } from "./auth.js";
import { returnAuditCard, openReturnPicker } from "./returnaudit.js";

// ── FDE 问题工作台 ──────────────────────────────────────────────
// 新 Question Ledger 与历史 OIR/clarify 形态在这里收口。前端后续只认这一种结构，
// 避免每个卡片各自猜字段，也让后端可以渐进迁移已有会话。
export const qval = (v: any) => (v && typeof v === "object" && "value" in v) ? v.value : (v ?? "");
export function normalizeQuestion(raw: any, source: any){
  const activeDecision = raw.activeDecision || raw.decision || {};
  const directRaw = qval(raw.answer), ledgerRaw = qval(activeDecision.answer);
  const directAnswer = directRaw == null ? "" : directRaw;
  const ledgerAnswer = ledgerRaw == null ? "" : ledgerRaw;
  const answer = String(directAnswer !== "" ? directAnswer : ledgerAnswer || "").trim();
  let status = String(raw.status || "").toLowerCase().replace(/^status\./, "");
  const ledgerStatus = ["open","assigned","blocked","answered","deferred","cancelled"].includes(status);
  // 统一 Ledger 的显式 lifecycle 赢过历史 Decision（reopen 后仍会保留旧决定）；
  // 只有遗留 OIR/Candidate 形态才用非空 answer 推断已回答。
  if (!ledgerStatus && answer) status = "answered";
  else if (status === "candidate" || status === "draft" || !status) status = "open";
  else if (status === "confirmed") status = "answered";
  else if (status === "rejected") status = "cancelled";
  else if (!["open","assigned","blocked","answered","deferred","cancelled"].includes(status)) status = "open";
  const impactN = Number(raw.blastRadius || raw.blast_radius || raw.impact_count || raw.impactCount || 0);
  let priority = String(raw.priority || raw.severity || "").toLowerCase();
  if (!priority) priority = (raw.blocking || raw.reversible === false || impactN >= 10)
    ? "high" : "normal";
  const options = (raw.options || []).map((o: any, i: any) => typeof o === "object"
    ? {id:String(o.id ?? i), label:String(o.label ?? o.value ?? ""), rationale:o.rationale || ""}
    : {id:String(i), label:String(o), rationale:""}).filter((o: any) => o.label);
  const applies = raw.appliesTo || raw.applies_to || raw.blockedArtifacts || [];
  const blockedArtifacts = raw.blockedArtifacts || raw.blocked_artifacts || [];
  return {
    id: String(raw.id || raw.rid || raw.conflict_rid || `q_${source}_${Math.random()}`),
    text: String(qval(raw.text) || raw.title || raw.q || "（未命名问题）"),
    status, priority, answer, options,
    answerSchema: raw.answerSchema || raw.answer_schema || {type:"string"},
    owner: String(raw.ownerUserId || raw.owner_user_id || raw.owner || ""),
    role: String(raw.audienceRole || raw.audience_role || raw.role || raw.audience || raw.askedBy || ""),
    why: String(raw.why || raw.rationale || raw.group || raw.reason || ""),
    impact: String(raw.impact || raw.impactSummary || (impactN ? `影响 ${impactN} 个实体` : "")),
    applies: Array.isArray(applies) ? applies.map(String) : [String(applies)],
    blockedArtifacts: Array.isArray(blockedArtifacts) ? blockedArtifacts.map(String) : [String(blockedArtifacts)],
    evidence: raw.evidence || raw.citations || raw.evidenceIds || raw.evidence_ids || [], code: String(raw.code || ""),
    source: String(raw.sourceKind || raw.source_kind || raw.source || source || "system"), conflictRid: raw.conflict_rid || raw.conflictRid || "",
    revision: raw.revision ?? raw.version ?? raw.updated_at ?? null, raw,
  };
}

export function localQuestionBacklog(){
  if (!G.S) return [];
  const out: any[] = [], seen = new Set();
  const add = (raw: any, source: any) => {
    const q = normalizeQuestion(raw, source);
    const key = String(q.text || "").trim().toLocaleLowerCase() || q.id;
    if (!seen.has(key)) { seen.add(key); out.push(q); }
  };
  for (const q of (G.S.state?.oir?.questions || [])) add(q, q.askedBy || "oir");
  const answered = new Set(G.S.state?.answered || []);
  for (const q of (G.S.state?.questions || [])) {
    const copy = {...q};
    if (answered.has(q.conflict_rid)) copy.status = "answered";
    add(copy, "conflict");
  }
  return out;
}

export async function loadQuestions(){
  if (!G.S) { G.Q_BACKLOG = []; G.Q_API = false; return; }
  const sid = G.S.id;
  try {
    const r = await fetch(`${API}/api/sessions/${sid}/questions`);
    if (r.status === 401) showLogin();
    if (!r.ok) throw new Error(String(r.status));
    const body: any = await r.json();
    if (!G.S || G.S.id !== sid) return;             // 切会话后的迟到响应不能污染新会话
    const rows = Array.isArray(body) ? body : (body.questions || []);
    G.Q_BACKLOG = rows.map((q: any) => normalizeQuestion(q, q.source || "ledger"));
    G.Q_NEXT = (body.nextBatch || body.next_batch || []).map((item: any) => {
      if (typeof item === "string") return G.Q_BACKLOG.find(q => q.id === item) || null;
      return normalizeQuestion(item, item.source || "ledger");
    }).filter(Boolean);
    G.Q_API = true;
  } catch (e: any) {
    if (!G.S || G.S.id !== sid) return;
    G.Q_BACKLOG = localQuestionBacklog(); G.Q_NEXT = [];
    G.Q_API = false;
  }
  if (G.TAB === "q") paint();
}

export function qSetFilter(v: any){ G.Q_FILTER = v; G.Q_LIMIT = 40; paint(); }
export function qRow(i: any){ return G.Q_BACKLOG[i]; }
export function qCard(i: any){ return document.querySelector(`.qcard[data-qidx="${i}"]`); }

export async function qRequest(i: any, path: any, method: any, body: any){
  const q = qRow(i);
  if (!q || !G.S || Q_BUSY.has(q.id)) return false;
  if (!G.Q_API) {
    alert("当前服务端尚未启用 Question Ledger；问题可查看和下载，但分派、延期与自由文本回答需要升级后端。");
    return false;
  }
  Q_BUSY.add(q.id); paint();
  try {
    const payload = {...body};
    if (q.revision !== null && q.revision !== undefined) payload.expected_revision = q.revision;
    const r = await fetch(`${API}/api/sessions/${G.S.id}/questions/${encodeURIComponent(q.id)}${path}`, {
      method, headers:{"content-type":"application/json"}, body:JSON.stringify(payload)});
    if (r.status === 409) throw new Error("问题已被其他人更新，请刷新后重试");
    if (!r.ok) throw new Error((await r.text()).slice(0,240) || `HTTP ${r.status}`);
    await loadQuestions();
    return true;
  } catch (e: any) { alert(`没有保存：${e.message || e}`); return false; }
  finally { Q_BUSY.delete(q.id); paint(); }
}

export async function qSaveMeta(i: any){
  const card = qCard(i); if (!card) return;
  await qRequest(i, "", "PATCH", {
    ownerUserId: card.querySelector("[data-q-owner]")?.value.trim() || null,
    audienceRole: card.querySelector("[data-q-role]")?.value || null,
    priority: card.querySelector("[data-q-priority]")?.value || "normal",
  });
}
export async function qDefer(i: any){
  const reason = prompt("延期原因（可选）", "等待相关业务人员确认") ?? null;
  if (reason === null) return;
  await qRequest(i, "", "PATCH", {status:"deferred", reason});
}
export async function qReopen(i: any){ await qRequest(i, "/reopen", "POST", {reason:"FDE 重新打开"}); }
export async function qSaveMetaWith(i: any, meta: {owner: string; role: string; priority: string}){
  await qRequest(i, "", "PATCH", {
    ownerUserId: meta.owner.trim() || null,
    audienceRole: meta.role || null,
    priority: meta.priority || "normal",
  });
}
export async function qSubmit(i: any){
  const q = qRow(i), card = qCard(i); if (!q || !card) return;
  const answer = card.querySelector("[data-q-answer]")?.value.trim() || "";
  const optionId = card.querySelector("[data-q-option]")?.value || "";
  await qSubmitWith(i, answer, optionId);
}

// 「提交一个回答」本身不需要 DOM：值从哪来是调用方的事 —— 内联 JS 时代从卡片上
// 回读，React 版从组件自己的状态里来。**分叉只准有这一处**：遗留冲突卡走稳定的
// /answer、Ledger 走 /questions/{id}/answer，这个判断两条路径共用同一份。
export async function qSubmitWith(i: any, answer: string, optionId: string){
  const q = qRow(i); if (!q) return;
  const option = q.options.find((o: any) => o.id === optionId);
  const text = answer || option?.label || "";
  if (!text) { alert("请先选择选项或填写答案"); return; }
  // 旧冲突卡仍走稳定的 /answer；Ledger API 到位后所有问题统一走 answer endpoint。
  if (!G.Q_API && q.conflictRid && optionId) {
    try {
      await j(`/api/sessions/${G.S.id}/answer`, {method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({conflict_rid:q.conflictRid, option_id:optionId,
          note:answer || "由 FDE 在问题工作台确认", lang:G.LANG})});
      await refresh();
    } catch (e: any) { alert(`没有保存：${e.message || e}`); }
    return;
  }
  const allowed = q.answerSchema?.enum || [];
  const typedAnswer = optionId && (q.source === "conflict" || allowed.length)
    ? (allowed.length && !allowed.includes(optionId) && allowed.includes(text) ? text : optionId)
    : text;
  const idem = (globalThis.crypto?.randomUUID?.() || `fde-${Date.now()}-${Math.random()}`);
  await qRequest(i, "/answer", "POST", {
    answer:typedAnswer, answerText:text, option_id:optionId || null,
    actor:"fde", idempotencyKey:idem,
  });
}

export function questionWorkbench(){
  const counts: Record<string, number> = {open:0, answered:0, deferred:0};
  const active = (q: any) => ["open","assigned","blocked"].includes(q.status);
  G.Q_BACKLOG.forEach(q => {
    const bucket = active(q) ? "open" : q.status;
    counts[bucket] = (counts[bucket] || 0) + 1;
  });
  const filtered = G.Q_BACKLOG.map((q, i) => ({q, i})).filter(({q}) => {
    if (G.Q_FILTER === "all") return true;
    if (G.Q_FILTER === "open") return active(q);
    if (G.Q_FILTER === "high") return active(q) && ["high","blocking"].includes(q.priority);
    return q.status === G.Q_FILTER;
  });
  const shown = filtered.slice(0, G.Q_LIMIT);
  const artifacts = (G.S.state?.artifacts || []).filter((a: any) => /问题|question|ontology|oir\.json|flow\.json|流程图/i.test(a));
  const revision = G.S.state?.ontology_package?.revision ?? G.S.state?.artifact_revision
    ?? G.S.state_version ?? G.S.revision ?? G.S.state?.revision?.id;
  const version = revision === undefined || revision === null
    ? "当前会话快照" : `产物 revision ${revision}`;
  const release = releaseView();
  const deliver = `<div class="qdeliver">
    <div class="qtext">访谈清单与当前交付版本</div>
    <div class="qwbsum">${G.Q_BACKLOG.length} 个问题 · ${artifacts.length} 份关联产物 · ${esc(version)} · ${esc(release.state)}${release.blockers ? `（${release.blockers} 个阻塞项）` : ""}</div>
    <div class="acts">
      ${G.Q_API ? ["xlsx","md","json"].map(f => `<a class="act" download
        href="${API}/api/sessions/${encodeURIComponent(G.S.id)}/questions/export?format=${f}">${f.toUpperCase()}</a>`).join("") : ""}
      ${artifacts.slice(0,5).map((a: any) => `<a class="act" download title="${eattr(a)}"
        href="${API}/api/sessions/${encodeURIComponent(G.S.id)}/artifacts/${encodeURIComponent(a)}">${esc(a)}</a>`).join("")}
      ${bundleLink("Bundle", "act pri")}
      <button class="act" onclick="openReturnPicker()">上传回传模板</button>
    </div></div>`;
  const notice = G.Q_API ? "" : `<div class="qnotice">兼容模式：已汇总材料问卷与冲突问题；当前后端未启用统一 Question Ledger，分派、延期和自由文本回答暂为只读。</div>`;
  const filters = [
    ["open", `待回答 ${counts.open||0}`], ["high", "高优先级"],
    ["answered", `已回答 ${counts.answered||0}`], ["deferred", `已延期 ${counts.deferred||0}`],
    ["all", `全部 ${G.Q_BACKLOG.length}`],
  ].map(([k, label]) => `<button class="qfilter ${G.Q_FILTER===k?"on":""}" onclick="qSetFilter('${k}')">${esc(label)}</button>`).join("");
  const nextBatch = G.Q_NEXT.length ? `<div class="qnext"><div class="qtext">建议下一批先问</div>
    <div class="qwbsum">按阻塞范围、信息价值与依赖排序</div><ol>${G.Q_NEXT.slice(0,5).map(q =>
      `<li>${esc(q.text)}${q.role?` · ${esc(q.role)}`:""}</li>`).join("")}</ol></div>` : "";
  const cards = shown.map(({q, i}) => {
    const busy = Q_BUSY.has(q.id), done = ["answered","cancelled"].includes(q.status);
    const needsReopen = ["deferred","blocked"].includes(q.status);
    const statusLabel = ({open:"待回答",assigned:"已分派",blocked:"受阻",answered:"已回答",deferred:"已延期",cancelled:"已取消"} as Record<string, string>)[q.status] || q.status;
    const roleOptions = ["", "业务负责人", "流程负责人", "ERP顾问", "数据负责人", "财务/法务", "FDE"];
    if (q.role && !roleOptions.includes(q.role)) roleOptions.push(q.role);
    const evidence = (q.evidence || []).slice(0,3).map((e: any) => {
      const cite = typeof e === "object" ? (e.cite || e.location || e.id || "") : String(e);
      const file = typeof e === "object" ? (e.file_name || e.file || "") : "";
      return cite ? `<button class="ev" data-file="${eattr(file)}" data-cite="${eattr(cite)}"
        onclick="openSource(this.dataset.file,this.dataset.cite)">◧ ${esc(cite)}</button>` : "";
    }).join("");
    return `<div class="qcard ${done?"answered":needsReopen?"deferred":""}" data-qidx="${i}">
      <div class="qmeta">
        <span class="qbadge ${eattr(q.status)}">${esc(statusLabel)}</span>
        <span class="qbadge ${eattr(q.priority)}">${q.priority==="high"||q.priority==="blocking"?"高":q.priority==="low"?"低":"普通"}优先级</span>
        ${q.code ? `<span class="qbadge">${esc(q.code)}</span>` : ""}
        <span class="qbadge">${esc(q.source)}</span>
      </div>
      <div class="qtext">${esc(q.text)}</div>
      ${q.why ? `<div class="qwhy">为什么问：${esc(q.why)}</div>` : ""}
      ${q.impact ? `<div class="qimpact">影响：${esc(q.impact)}</div>` : ""}
      ${q.applies.length ? `<div class="cap">关联：${esc(q.applies.join("、"))}</div>` : ""}
      ${evidence}
      <div class="qfields">
        <input class="qinput" data-q-owner aria-label="负责人" placeholder="负责人 / owner" value="${eattr(q.owner)}" ${busy?"disabled":""}>
        <select class="qselect" data-q-role aria-label="应答角色" ${busy?"disabled":""}>${roleOptions.map(x =>
          `<option value="${eattr(x)}" ${x===q.role?"selected":""}>${esc(x || "应答角色")}</option>`).join("")}</select>
        <select class="qselect" data-q-priority aria-label="优先级" ${busy?"disabled":""}>
          ${[["low","低优先级"],["normal","普通优先级"],["high","高优先级"],["blocking","阻塞交付"]].map(([v,l]) =>
            `<option value="${v}" ${v===q.priority?"selected":""}>${l}</option>`).join("")}</select>
        ${q.options.length ? `<select class="qselect" data-q-option aria-label="参考选项" ${busy||done||needsReopen?"disabled":""}>
          <option value="">选择参考答案（可选）</option>${q.options.map((o: any) =>
            `<option value="${eattr(o.id)}" ${q.answer===o.label?"selected":""}>${esc(o.label)}</option>`).join("")}</select>` : `<span></span>`}
      </div>
      <textarea class="qanswer" data-q-answer aria-label="问题答案" placeholder="记录业务人员的原话；可补充背景、例外和证据" ${busy||done||needsReopen?"disabled":""}>${esc(q.answer)}</textarea>
      <div class="qactions">
        ${done ? `<button class="act" onclick="qReopen(${i})" ${busy?"disabled":""}>重新打开</button>` : `
          ${needsReopen ? `<button class="act pri" onclick="qReopen(${i})" ${busy?"disabled":""}>恢复待答</button>` : `
            <button class="act pri" onclick="qSubmit(${i})" ${busy?"disabled":""}>${busy?"保存中…":"提交回答"}</button>
            <button class="act" onclick="qDefer(${i})" ${busy?"disabled":""}>延期</button>`}`}
        <button class="act" onclick="qSaveMeta(${i})" ${busy?"disabled":""}>保存分派</button>
      </div></div>`;
  }).join("");
  return `<div class="qwbhead"><div><div class="qwbtitle">FDE 问题工作台</div>
      <div class="qwbsum">回答会更新 Decision Ledger，并触发受影响产物的增量重算</div></div>
      <button class="act" onclick="loadQuestions()">刷新</button></div>
    ${deliver}${returnAuditCard()}${nextBatch}${notice}<div class="qfilters">${filters}</div>
    ${cards || `<div class="qempty">这个筛选下没有问题</div>`}
    ${filtered.length > shown.length ? `<button class="qmore" onclick="Q_LIMIT+=40;paint()">再显示 ${Math.min(40, filtered.length-shown.length)} 条</button>` : ""}`;
}

export function releaseView(){
  const active = (q: any) => ["open","assigned","blocked"].includes(q.status);
  const pending = G.Q_BACKLOG.filter(active);
  const blockers = pending.filter(q => q.priority === "blocking" || (q.blockedArtifacts || []).length);
  let state = String(G.S?.state?.release_state || "").toUpperCase();
  // Question Ledger 是当前权威状态：一个已发布版本被重新打开阻塞问题后，旧的
  // release_state 可能仍是 RELEASED，但界面必须立即 fail closed 显示 BLOCKED。
  if (blockers.length) state = "BLOCKED";
  else if (pending.length) state = "DRAFT";
  else if (!["DRAFT","RELEASED"].includes(state)) state = G.S?.status !== "done"
    ? "DRAFT" : "RELEASED";
  return {state, blockers:blockers.length, pending:pending.length};
}

export function bundleLink(label: any, classes: any = "act"){
  const release = releaseView();
  if (release.state === "BLOCKED") return `<span class="${eattr(classes)} disabled" aria-disabled="true"
    title="${eattr(`${release.blockers} 个阻塞问题尚未处理；问题清单和单份草稿仍可下载`)}">${esc(label)} · BLOCKED</span>`;
  const suffix = release.state === "DRAFT" ? " · DRAFT" : "";
  return `<a class="${eattr(classes)}" download href="${API}/api/sessions/${encodeURIComponent(G.S.id)}/bundle"
    title="${release.state === "DRAFT" ? "草稿包：仍有非阻塞问题待澄清" : "已通过发布门禁"}">${esc(label)}${suffix}</a>`;
}

export function engagementProgress(){
  const engagement = G.S?.state?.engagement;
  if (!engagement?.plan?.length) return "";
  const labels: Record<string, string> = {
    INTAKE:"盘点", PROCESS:"流程", ERP_MAP:"ERP 映射", RULES:"规则",
    DATA_OBJECTS:"数据对象", GAP:"缺口", INTERVIEW:"访谈", CANONICALIZE:"规范化",
    REVIEW:"交付审查", EXPORT:"导出",
  };
  const release = releaseView();
  return `<div class="eng"><div class="enghead">
    <div class="engtitle">FDE Engagement 工作流</div>
    <div class="engmeta">${engagement.frozen ? "FROZEN DAG" : "EDITABLE PLAN"} · ${esc(release.state)}${release.blockers ? ` (${release.blockers} BLOCKERS)` : ""} · ${esc(engagement.version || "")}</div>
  </div><div class="engsteps">${engagement.plan.map((n: any) =>
    `<span class="engstep ${eattr(n.state || "pending")}" title="${eattr(n.mode || "")}">${esc(labels[n.id] || n.id)}</span>`
  ).join("")}</div></div>`;
}
