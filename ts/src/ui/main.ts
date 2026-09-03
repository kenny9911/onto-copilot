// 入口。原文件里那个同步开跑的 init IIFE 原样搬过来。
//
// **bindGlobals() 必须排在最前**：内联处理器是浏览器在用户点下去那一刻才编译的，
// 但 init 里第一次 render() 就会往页面里写带 onclick 的 HTML —— 名字挂晚了，
// 那几毫秒里点到的按钮就是死的。
import { G } from "./state.js";
import { $, j } from "./dom.js";
import { esc } from "./dom.js";
import { t, applyI18n } from "./i18n.js";
import { applyAppearance, applyUserPrefs } from "./appearance.js";
import { applyMode } from "./mode.js";
import { bindAuthForms, showLogin, renderIdentity } from "./auth.js";
import { loadSessions } from "./sessions.js";
import { uploadPicked, loadModels, bindDrop } from "./upload.js";
import { bindComposer } from "./chat.js";
import { bindResize } from "./layout.js";
import { bindGlobals } from "./globals.js";
import { mountApp } from "./react/app.js";
import "./react/regions.js";   // 组件注册：不 import 就等于一个 region 都没有

bindGlobals();
// React 树。**没有 region 注册时这是一次空操作** —— 页面仍由现成的 paint*/render
// 那套画出来。视图 track 每 registerRegion 一个容器，就有一块换成组件渲染。
// 排在 init 之前：init 的第一次 render() 之后就有 DOM 了，portal 的宿主必须先立好。
mountApp();

(async function init(){
  applyI18n();
  applyAppearance();
  applyMode();
  bindAuthForms();

  // 认证闸：先问清楚"我是谁、这个实例要不要登录"，答案没定之前不碰会话列表。
  let auStatus;
  try { auStatus = await j("/api/auth/status"); }
  catch (e: any) { auStatus = {auth_enabled:false, bootstrap_needed:false, authenticated:true, user:null}; }

  if (auStatus.auth_enabled && !auStatus.authenticated) {
    // 设了 ONTOCOPILOT_AUTH 时服务端会关掉自助注册，这里要跟着把"去注册"藏起来。
    G.REGISTRATION_OPEN = auStatus.registration_open !== false;
    // 零账号时默认进注册（首个注册者即管理员）；否则登录。两者共用同一个可切换的表单。
    showLogin(auStatus.first_user_is_admin ? "register" : "login");
    return;
  }

  // 未开启认证 / 单机模式：合成一个本地管理员身份，UI 逻辑不用为"没有用户"
  // 这个状态单独分叉。
  G.CURRENT_USER = auStatus.user || {id:"__local__", username:"local", role:"admin", prefs:{}};
  applyUserPrefs(G.CURRENT_USER.prefs);
  renderIdentity();

  try {
    // **只在出问题时说话。** 以前这里常驻一行"● 已连接数据库 / schema v0" ——
    // 一切正常时它没有告诉用户任何他能用上的事，只是把实现细节钉在侧栏底部。
    // 真正值得占这个位置的只有一件：**你的东西会不会丢**。
    const db = (await j("/api/health")).database || {};
    $("store").innerHTML = db.mode === "memory"
      ? `<span style="color:var(--warn)">● ${esc(t("store.memory"))}</span><br>${esc(t("store.memoryHint"))}`
      : db.ok ? ""
      : `<span style="color:var(--danger)">● ${esc(t("store.error"))}</span><br>${esc(String(db.error||"").slice(0,60))}`;
  } catch (e: any) { /* 健康检查失败不该在界面上留一行技术说明 */ }
  await loadSessions();
  // 刚建完首个账号：告诉他原来的会话已经归到这个账号名下。少了这一句，他看到的
  // 是"注册完界面变了" —— 而会话列表长度没变这件事，他不会主动去核对。
  const adopted = sessionStorage.getItem("oc_adopted");
  if (adopted) {
    sessionStorage.removeItem("oc_adopted");
    const el = $("store");
    if (el) el.innerHTML = `<span style="color:var(--accent)">● ${
      esc(t("auth.adopted", "", {n: adopted}))}</span>`;
  }
  $("picker").onchange = uploadPicked;
  bindComposer();
  bindDrop();
  bindResize();
  loadModels();          // 模型下拉：拉网关实际可用的列表
})();
