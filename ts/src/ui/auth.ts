// 认证：登录 / 注册 / 账户菜单 / 个人资料 / 改密码。
import { G } from "./state.js";
import { $, API, esc } from "./dom.js";
import { t } from "./i18n.js";
import { render } from "./render.js";
import { bumpUi } from "./react/store.js";

// ── 认证：登录 / 首次启动引导 ──────────────────────────────────────
export function bindAuthForms(){
  const onEnter = (id: any, fn: any) => { const el = $(id); if (el) el.addEventListener("keydown", (e: any) => {
    if (e.key === "Enter") { e.preventDefault(); fn(); } }); };
  onEnter("loginUser", doAuthSubmit);
  onEnter("loginName", doAuthSubmit);
  onEnter("loginPass", doAuthSubmit);
  onEnter("pwOld", doPassword);
  onEnter("pwNew", doPassword);
  onEnter("profName", doProfile);
  // Esc 关掉可关的遮罩。强制鉴权那次 closeLogin 自己会拒绝。
  document.addEventListener("keydown", (e: any) => {
    if (e.key !== "Escape") return;
    if ($("profileOverlay") && $("profileOverlay").style.display === "flex") closeProfile();
    else if ($("pwOverlay") && $("pwOverlay").style.display === "flex") closePassword();
    else if ($("loginOverlay") && $("loginOverlay").style.display === "flex") closeLogin();
  });
}

export function showLogin(mode?: any, dismissible?: any){
  G.AUTH_MODE = (mode === "register") ? "register" : "login";
  if (dismissible !== undefined) G.AUTH_DISMISSIBLE = !!dismissible;
  const reg = G.AUTH_MODE === "register";
  $("loginTitle").textContent = t(reg ? "register.title" : "login.title");
  $("loginSubtitle").textContent = t(
    G.AUTH_DISMISSIBLE && reg ? "register.subtitleLocal"
      : (reg ? "register.subtitle" : "login.subtitle"));
  $("loginUserLabel").textContent = t("login.username");
  // 名字只在注册时要。切回登录时清空 —— showLogin 不像 openPassword 那样清 value，
  // 来回切会残留上次输入。
  $("loginNameLabel").textContent = t("login.displayName");
  $("loginNameField").style.display = reg ? "" : "none";
  if (!reg) $("loginName").value = "";
  $("loginPassLabel").textContent = t("login.password");
  $("loginPass").setAttribute("autocomplete", reg ? "new-password" : "current-password");
  $("loginSubmit").textContent = t(reg ? "register.submit" : "login.submit");
  $("loginToggle").textContent = t(reg ? "auth.to_login" : "auth.to_register");
  $("loginErr").style.display = "none";
  const cancel = $("loginCancel");
  cancel.textContent = t("auth.later");
  cancel.style.display = G.AUTH_DISMISSIBLE ? "" : "none";
  $("loginOverlay").style.display = "flex";
  $("loginUser").focus();
}

export function closeLogin(){
  if (!G.AUTH_DISMISSIBLE) return;
  $("loginOverlay").style.display = "none";
}

export function toggleAuthMode(){ showLogin(G.AUTH_MODE === "login" ? "register" : "login"); }
export function doAuthSubmit(){ return G.AUTH_MODE === "register" ? doRegister() : doLogin(); }

export async function doLogin(){
  const u = ($("loginUser").value || "").trim();
  const p = $("loginPass").value || "";
  const errEl = $("loginErr");
  errEl.style.display = "none";
  if (!u || !p) return;
  const btn = $("loginSubmit");
  btn.disabled = true;
  try {
    // 走原生 fetch 而不是 j()：401/429 在这里是正常的表单校验结果，
    // 不该弹第二个登录框或被当成异常抛出去。
    const r = await fetch(API + "/api/login", {method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({username:u, password:p})});
    if (r.status === 401) { errEl.textContent = t("login.bad"); errEl.style.display = "block"; return; }
    if (r.status === 429) { errEl.textContent = t("login.throttled"); errEl.style.display = "block"; return; }
    if (!r.ok) { errEl.textContent = (await r.text()).slice(0,200); errEl.style.display = "block"; return; }
    location.reload();
  } catch (e: any) {
    errEl.textContent = String(e.message || e); errEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

export async function doRegister(){
  const u = ($("loginUser").value || "").trim();
  const n = ($("loginName").value || "").trim();
  const p = $("loginPass").value || "";
  const errEl = $("loginErr");
  errEl.style.display = "none";
  if (!u || !p) return;
  if (!n) { errEl.textContent = t("register.needName"); errEl.style.display = "block"; return; }
  if (p.length < 6) { errEl.textContent = t("register.short"); errEl.style.display = "block"; return; }
  const btn = $("loginSubmit");
  btn.disabled = true;
  try {
    const r = await fetch(API + "/api/register", {method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({username:u, password:p, display_name:n})});
    if (r.status === 409) { errEl.textContent = t("register.dup"); errEl.style.display = "block"; return; }
    if (r.status === 429) { errEl.textContent = t("login.throttled"); errEl.style.display = "block"; return; }
    // 400 不再一律当成"密码太短"：名字空/超长也是 400，照抄服务端那句话最准。
    if (r.status === 400) {
      const d: any = await r.json().catch(() => ({}));
      errEl.textContent = d.detail || t("register.short");
      errEl.style.display = "block"; return;
    }
    if (!r.ok) { errEl.textContent = (await r.text()).slice(0,200); errEl.style.display = "block"; return; }
    // 首个账号会把开放模式下建的会话认领过来。这件事不能悄悄发生 —— 用户刚点了
    // "创建账户"，界面整个变一次，得让他知道东西还在、去哪了。
    const body: any = await r.json().catch(() => ({}));
    if (body.adopted_sessions) sessionStorage.setItem("oc_adopted", body.adopted_sessions);
    // 刚注册完的人没有"回来"可言。标记这个标签页，问候语用「欢迎」而不是
    // 「欢迎回来」—— 注册后 reload、点「新会话」，两三秒内就会撞上那句。
    sessionStorage.setItem("oc_new_account", "1");
    location.reload();   // 注册即登录
  } catch (e: any) {
    errEl.textContent = String(e.message || e); errEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

// showBootstrap/retryBootstrap 删了：/api/auth/status 早就不返回 bootstrap_needed
// （自助注册那次改动去掉了这个分支），这两个函数从此没人调用，那层遮罩也永远不会
// 出现。而它写的是"请到主机上敲 ontocopilot useradd" —— 现在账户菜单里就能建号。

export async function doLogout(){
  try { await fetch(API + "/api/logout", {method:"POST"}); } catch (e: any) {}
  location.reload();
}

// 侧栏底部账户区：账号入口 + 上弹菜单。设置、语言从顶栏挪到这里（参考主流产品
// 的账户菜单），登录用户再多「账户管理」(管理员) 和「退出」。
//
// 菜单的开合从「直接翻 #acctMenu 的 hidden」变成一个状态：那个元素现在由
// <Identity> 画（react/identity.tsx），在它背后改真实 DOM 正是「一个容器两个
// 主人」那类事故的起点 —— React 下一次更新会按自己记得的样子把它改回去。
export const ACCT_MENU = { open: false };
export function toggleAcctMenu(e: any){
  if (e) e.stopPropagation();
  ACCT_MENU.open = !ACCT_MENU.open;
  bumpUi();
}
export function closeAcctMenu(){ if (ACCT_MENU.open) { ACCT_MENU.open = false; bumpUi(); } }
document.addEventListener("click", (e: any) => {
  if (ACCT_MENU.open && !e.target.closest(".acct") && !e.target.closest(".acctmenu")) closeAcctMenu();
});

// 该怎么称呼当前这个人。空串 = 没人可称呼（开放模式、未登录）——
// 调用方据此决定是问候还是回落到那句 tagline。
export function greetName(){
  const u = G.CURRENT_USER;
  if (!u || u.id === "__local__") return "";     // 本地模式没有"谁"，只有一台机器
  return String(u.display_name || "").trim() || String(u.username || "").trim();
}

// 空状态那一行。**返回的是文本，不是标记** —— 名字是用户自己填的自由文本，
// 以前这行字要拼进 innerHTML，所以先 esc 再交给 t() 插值（t() 自己不转义，
// 它只做 {name} 替换）。现在它落进 <Stream> 的一个 JSX 文本节点，React 自己转义；
// 再手工 esc 一遍只会让界面上显示出 `&lt;`。
export function greetLine(){
  const name = greetName();
  if (!name) return t("empty.tagline");
  // 刚注册完的人没有"回来"可言（doRegister 里打的标记）。
  const key = sessionStorage.getItem("oc_new_account") ? "empty.welcomeNew" : "empty.welcomeBack";
  return t(key, "", {name});
}

/**
 * 侧栏底部那块身份区该重画一次。**画的人是 <Identity>**（react/identity.tsx）——
 * 函数名和全部调用点没动（main.ts 认证完、applyI18n 切语言、doProfile 改完称呼
 * 都调它），换掉的只是「怎么画」。
 */
export function renderIdentity(){
  // **顺手把菜单收掉是旧行为，不是我加的**：旧实现整块重写 innerHTML，而模板里
  // 的 #acctMenu 写死了 hidden，于是每次 renderIdentity() 菜单都跟着没了。
  // 唯一看得见的地方是在菜单里点「中 / EN」——切完语言菜单就收起来。这次换的是
  // 框架不是外观，所以照搬。
  ACCT_MENU.open = false;
  bumpUi();
}

/**
 * 头像里那个字。**Array.from 而不是 slice(0,1)**：名字里的 emoji 是代理对，
 * 按码元切会切出半个、渲染成一个替换字符。
 */
export function avatarChar(name: any){
  return String(Array.from(name || "?")[0] || "?").toUpperCase();
}

// 改密码。后端 /api/me/password 一直存在、也一直没有入口 —— 一个"账户系统"里
// 个人资料。**账号是账号，资料是资料**：username 是登录标识，这里只读地摆出来，
// 能改的只有称呼。注册时填的名字不该是一锤子买卖 —— 打错了、换了称呼都得能改。
export function openProfile(){
  const o = $("profileOverlay");
  if (!o || !G.CURRENT_USER) return;
  $("profTitle").textContent = t("prof.title");
  $("profSubtitle").textContent = t("prof.subtitle");
  $("profAccountLabel").textContent = t("prof.account");
  $("profNameLabel").textContent = t("prof.name");
  $("profSubmit").textContent = t("prof.submit");
  $("profCancel").textContent = t("common.cancel");
  $("profAccount").value = G.CURRENT_USER.username || "";
  $("profName").value = G.CURRENT_USER.display_name || "";
  $("profErr").textContent = ""; $("profErr").style.display = "none";
  o.style.display = "flex";
  $("profName").focus();
  $("profName").select();
}
export function closeProfile(){ const o = $("profileOverlay"); if (o) o.style.display = "none"; }

export async function doProfile(){
  const err = $("profErr");
  const name = ($("profName").value || "").trim();
  err.style.display = "none";
  if (!name) { err.textContent = t("register.needName"); err.style.display = "block"; return; }
  const btn = $("profSubmit");
  btn.disabled = true;
  try {
    const r = await fetch(API + "/api/me/profile", {
      method: "POST", headers: {"Content-Type": "application/json"},
      // 字段名必须是 display_name —— 端点读的就是它，裸 dict 会静默丢掉别的键
      body: JSON.stringify({display_name: name})});
    if (!r.ok) {
      const d: any = await r.json().catch(() => ({}));
      err.textContent = d.detail || t("prof.failed");
      err.style.display = "block";
      return;
    }
    const body: any = await r.json().catch(() => ({}));
    // 就地生效：问候语、左下角、头像首字都读 G.CURRENT_USER，不用刷新页面
    G.CURRENT_USER.display_name = (body.user && body.user.display_name) || name;
    closeProfile();
    renderIdentity();
    render();
  } catch (e: any) {
    err.textContent = String(e.message || e); err.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

// 用户改不了自己的密码，说不过去。复用登录框那套 .opanel/.field/.input/.err。
export function openPassword(){
  const o = $("pwOverlay");
  if (!o) return;
  // 文案在打开时填，不在启动时填 —— 切语言后再打开要跟着变
  $("pwTitle").textContent = t("pw.title");
  $("pwSubtitle").textContent = t("pw.subtitle");
  $("pwOldLabel").textContent = t("pw.old");
  $("pwNewLabel").textContent = t("pw.new");
  $("pwSubmit").textContent = t("pw.submit");
  $("pwCancel").textContent = t("common.cancel");
  $("pwOld").value = ""; $("pwNew").value = "";
  // .err 有底色和边框，空着也会画出一条红条 —— 每次打开都先藏起来，别让人
  // 在还没出错的时候就先看见一个报错框
  $("pwErr").textContent = ""; $("pwErr").style.display = "none";
  o.style.display = "flex";
  $("pwOld").focus();
}
export function closePassword(){ const o = $("pwOverlay"); if (o) o.style.display = "none"; }

export async function doPassword(){
  const err = $("pwErr");
  const oldp = $("pwOld").value, newp = $("pwNew").value;
  if (newp.length < 6) { err.textContent = t("auth.pwTooShort"); return; }
  const btn = $("pwSubmit");
  btn.disabled = true;
  try {
    const r = await fetch(API + "/api/me/password", {
      method: "POST", headers: {"Content-Type": "application/json"},
      // 字段名必须是 old/new —— /api/me/password 读的就是这两个（authgate.py:293）。
      // 用 old_password/new_password 的话 new 恒为空，服务端在校验旧密码之前就
      // 400「新密码不能为空」，界面把它翻成"改不了，稍后再试"，于是这个功能
      // 对每个人、每一次都是坏的。
      body: JSON.stringify({old: oldp, new: newp})});
    if (!r.ok) {
      err.textContent = r.status === 401 || r.status === 403
        ? t("auth.pwWrong")
        : r.status === 400 ? t("auth.pwTooShort") : t("auth.pwFailed");
      err.style.display = "block";
      return;
    }
    // 改密码会踢掉这个账号的**全部**会话，包括当前这条 —— 直接回登录页，
    // 比让他点下一个按钮时莫名其妙 401 要清楚。
    closePassword();
    location.reload();
  } catch (e: any) { err.textContent = t("auth.pwFailed"); }
  finally { btn.disabled = false; }
}
