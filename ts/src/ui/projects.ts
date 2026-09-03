// 项目文件夹：分组、行内菜单、拖拽归类。
import { G, PJ_OFF } from "./state.js";
import { $, API, j } from "./dom.js";
import { t } from "./i18n.js";
import { forkSession, loadSessions, newSession, paintSessions, renameSession } from "./sessions.js";

// ── 项目文件夹 ──────────────────────────────────────────────────
// 拉项目列表。**故意不走 j()**：j() 对非 2xx 直接抛、401 还会弹登录框，而这个
// 接口在旧后端上就是 404 —— 那种情况该安静地退回平铺列表，不是弹一个错。
export async function loadProjects(){
  if (G.MODE !== "work") { G.PROJECTS = []; return; }   // 聊天模式不进项目（R5）
  try {
    const r = await fetch(API + "/api/projects");
    if (!r.ok) throw new Error(String(r.status));
    G.PROJECTS = ((await r.json()) as any).projects || [];
    G.PROJECTS_OK = true;
  } catch (e: any) { G.PROJECTS = []; G.PROJECTS_OK = false; }
}

// 「＋建项目」只在后端支持、且在工作模式时露出来
export function syncProjectChrome(){
  const b = $("pjnewBtn");
  if (b) b.hidden = !(G.PROJECTS_OK && G.MODE === "work");
}

export function savePjOff(){ localStorage.setItem("oc_pj_off", JSON.stringify([...PJ_OFF])); }

export function toggleProject(pid: any){
  if (PJ_OFF.has(pid)) PJ_OFF.delete(pid); else PJ_OFF.add(pid);
  savePjOff();
  paintSessions();
}

export function closePopMenu(){ const m = $("popMenu"); if (m) { m.hidden = true; m.innerHTML = ""; } }
document.addEventListener("click", (e: any) => {
  if (!e.target.closest(".popmenu")) closePopMenu();
});
document.addEventListener("keydown", (e: any) => { if (e.key === "Escape") closePopMenu(); });

// items：{label, run, cls?} 或 {sec:"分组标题"}。
// **用 DOM API 而不是拼 innerHTML** —— 菜单项的文字是项目名/会话标题这类自由文本，
// textContent 天然不解析，也就不存在内联处理器里那种转义陷阱。
export function openPopMenu(ev: any, items: any[]){
  ev.stopPropagation();   // 否则同一次点击立刻被下面那个 document 监听器关掉
  const m = $("popMenu");
  if (!m) return;
  m.innerHTML = "";
  for (const it of items) {
    if (it.sec !== undefined) {
      const d = document.createElement("div");
      d.className = "pmsec"; d.textContent = it.sec; m.appendChild(d);
      continue;
    }
    const b = document.createElement("button");
    b.className = "acctitem" + (it.cls ? " " + it.cls : "");
    b.textContent = it.label;
    b.title = it.label;                       // 长项目名会被省略号截掉
    if (it.run) b.onclick = () => { closePopMenu(); it.run(); };
    m.appendChild(b);
  }
  // 先显示再量尺寸：贴着屏幕下沿/右沿的那一行否则会把菜单顶出视口
  m.style.left = "0px"; m.style.top = "0px"; m.hidden = false;
  const r = ev.currentTarget.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = (r.bottom + m.offsetHeight + 8 > innerHeight
    ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4) + "px";
}

export function projectMenu(ev: any, pid: any){
  const p = G.PROJECTS.find(x => x.id === pid);
  if (!p) return;
  openPopMenu(ev, [
    {label: t("project.rename"), run: () => renameProject(pid)},
    {label: t("project.delete"), cls: "danger", run: () => deleteProject(pid)},
  ]);
}

// 会话行的「⋯」：移入/移出项目。**用菜单不做拖拽** —— 侧栏是滚动容器，
// 拖到一个折叠起来的项目上没有可视目标，菜单反而说得清"现在在哪、能去哪"。
export function sessionMenu(ev: any, sid: any){
  const s = G.SESSION_LIST.find(x => x.id === sid);
  if (!s) return;
  const cur = s.project_id || "";
  // 改名放在最上面：双击标题这个手势界面上没有任何可见提示（只有一条 title
  // 悬浮字），菜单是它被发现的地方。聊天模式下这颗 ⋯ 根本不存在（R5：那里
  // 一点项目痕迹都不能有），所以双击才是**每种模式都在**的那条路。
  const items: any[] = [{label: t("session.rename"), run: () => renameSession(sid)},
                 // 分叉：复制材料+已拍板的决策到新会话，重新梳理。放在改名旁边 ——
                 // 它们同属「对这个会话本身的操作」，项目归属那一段是另一类。
                 {label: t("session.fork"), run: () => forkSession(sid)},
                 {sec: t("project.moveTo")}];
  if (G.PROJECTS.length) {
    for (const p of G.PROJECTS) items.push({
      label: p.name, cls: p.id === cur ? "on" : "",
      run: p.id === cur ? null : () => moveSession(sid, p.id)});
  } else {
    items.push({label: t("project.none"), cls: "muted"});
  }
  if (cur) items.push({label: t("project.moveOut"), run: () => moveSession(sid, null)});
  items.push({label: t("project.new"), run: () => newProject(sid)});
  openPopMenu(ev, items);
}

// moveSid：从会话菜单进来的那次，建完顺手把这个会话放进去 —— 否则用户得再点一遍。
export async function newProject(moveSid: any){
  const name = (prompt(t("project.namePrompt"), "") || "").trim();
  if (!name) return;
  try {
    const p = await j("/api/projects", {method:"POST",
      headers:{"content-type":"application/json"}, body: JSON.stringify({name})});
    if (moveSid && p && p.id) await j(`/api/sessions/${encodeURIComponent(moveSid)}`,
      {method:"PATCH", headers:{"content-type":"application/json"},
       body: JSON.stringify({project_id: p.id})});
  } catch (e: any) { alert(t("project.failed")); return; }
  await loadSessions();
}

export async function renameProject(pid: any){
  const p = G.PROJECTS.find(x => x.id === pid);
  if (!p) return;
  const name = (prompt(t("project.renamePrompt"), p.name) || "").trim();
  if (!name || name === p.name) return;
  try {
    await j(`/api/projects/${encodeURIComponent(pid)}`, {method:"PATCH",
      headers:{"content-type":"application/json"}, body: JSON.stringify({name})});
  } catch (e: any) { alert(t("project.failed")); return; }
  await loadSessions();
}

// 确认框必须把两件后果分开说清楚：**会话不会跟着没**（掉回未归类），
// **项目记忆会跟着没**。只说"删除项目？"的话，前者会让人不敢删，后者会让人乱删。
export async function deleteProject(pid: any){
  const p = G.PROJECTS.find(x => x.id === pid);
  if (!p) return;
  if (!confirm(t("project.confirmDelete", "", {name: p.name}))) return;
  try { await j(`/api/projects/${encodeURIComponent(pid)}`, {method:"DELETE"}); }
  catch (e: any) { alert(t("project.failed")); return; }
  PJ_OFF.delete(pid); savePjOff();
  await loadSessions();
}

export async function moveSession(sid: any, pid: any){
  try {
    await j(`/api/sessions/${encodeURIComponent(sid)}`, {method:"PATCH",
      headers:{"content-type":"application/json"}, body: JSON.stringify({project_id: pid})});
  } catch (e: any) { alert(t("project.failed")); return; }
  await loadSessions();
}

// ── 拖拽归类 ────────────────────────────────────────────────────
// 菜单那条路留着（键盘/触屏/无障碍都还得靠它），拖拽是**加**上来的一条快路：
// 侧栏里"把这个会话丢进那个文件夹"是空间操作，用菜单要点三下。
// DRAG_SID 住在 state.ts

export function dragSession(ev: any, sid: any){
  G.DRAG_SID = sid;
  ev.dataTransfer.effectAllowed = "move";
  // 必须 setData，否则 Firefox 根本不认这次拖拽
  try { ev.dataTransfer.setData("text/plain", sid); } catch (e: any) {}
  ev.currentTarget.classList.add("dragging");
}
export function dragEnd(ev: any){ G.DRAG_SID = null; ev.currentTarget.classList.remove("dragging"); }

export function dragOver(ev: any, el: any){
  if (!G.DRAG_SID) return;              // 从桌面拖文件进来的不算，那是上传的活
  ev.preventDefault();                // 不 preventDefault 就不会触发 drop
  ev.dataTransfer.dropEffect = "move";
  el.classList.add("dragover");
}
export function dragOut(el: any){ el.classList.remove("dragover"); }

export async function dropOnProject(ev: any, pid: any){
  ev.preventDefault();
  ev.currentTarget.classList.remove("dragover");
  const sid = G.DRAG_SID || (ev.dataTransfer && ev.dataTransfer.getData("text/plain"));
  G.DRAG_SID = null;
  if (sid) await moveSession(sid, pid);
}

// 「未归类」那一段同样是放置目标 —— 只能进不能出的文件夹是个陷阱。
export async function dropOnUnfiled(ev: any){
  ev.preventDefault();
  ev.currentTarget.classList.remove("dragover");
  const sid = G.DRAG_SID || (ev.dataTransfer && ev.dataTransfer.getData("text/plain"));
  G.DRAG_SID = null;
  if (sid) await moveSession(sid, null);
}

// 在某个项目里直接开新会话。等价于「新建会话 + 移进去」，但用户点的是项目上的
// ＋，他的心智是"在这个文件夹里新建"，不该让他建完再自己搬一次。
export async function newSessionIn(pid: any){
  await newSession();
  if (G.S && G.S.id) await moveSession(G.S.id, pid);
}
