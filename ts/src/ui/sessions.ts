// 会话：列表、侧栏渲染、改名、新建/打开/删除。
// 侧栏那块界面（会话行 / 项目分组 / 未归类）已经归 react/sidebar.tsx；
// 转义三件套 esc / eattr / earg 跟着那段模板字符串一起没了 —— JSX 自己转义，
// 再转一遍只会在界面上显示出 &lt;。
import { G, SESSION_TITLE_MAX } from "./state.js";
import { $, j } from "./dom.js";
import { bumpUi } from "./react/store.js";
import { t } from "./i18n.js";
import { loadProjects, syncProjectChrome } from "./projects.js";
import { render } from "./render.js";
import { paint, go } from "./preview.js";
import { connect } from "./sse.js";
import { loadQuestions } from "./questions.js";
import { loadModels } from "./upload.js";
import { applyMode } from "./mode.js";
import { stopThinking } from "./chat.js";

export async function loadSessions(){
  // 聊天与工作各自一份列表（像 ChatGPT 的对话 vs 项目），按当前模式过滤
  await loadProjects();
  const all = await j("/api/sessions");
  G.SESSION_LIST = all.filter((s: any) => (s.mode || "work") === G.MODE);
  paintSessions();
  // 当前会话若不属于本模式，就不强开；否则在当前列表里挑第一个
  if ((!G.S || (G.S.mode || "work") !== G.MODE) && G.SESSION_LIST.length) openSession(G.SESSION_LIST[0].id);
  else if (!G.S) render();
}

/**
 * 侧栏重画。**名字与全部调用点一个都没动** —— 变的只是函数体：
 * 那段拼 `#convs` innerHTML 的模板字符串已经搬进 `react/sidebar.tsx`
 * （<Sidebar> / <ProjectGroup> / <ConvRow>），这里只剩「通知它重画」。
 *
 * `syncProjectChrome()` 留在这儿是因为它管的不是 `#convs`，而是 `#pjnewBtn` ——
 * 那颗按钮长在冻结的 index.html 上，不属于任何 region，React 接管不了它。
 * 一个容器只能有一个主人，反过来说也一样：不归 React 的那部分得继续有人管。
 *
 * 单独拆出来的原因没变：折叠项目、切语言这类**纯重画**不用再跑一次网络请求。
 */
/**
 * 从拍板点分叉 —— 借 pi 的会话树：复制材料 + 前 N 条已拍板决策，产物由「重新梳理」重建。
 *
 * v1 只提供「从最新拍板点分叉」这一个入口（菜单一条）。按任意 ordinal 分叉的
 * 能力后端已有（POST body 里给 at_ordinal），等决策历史在界面上有了自己的列表，
 * 每一条挂一个入口才有意义 —— 在那之前挂在哪都像是藏起来的。
 */
export async function forkSession(sid: string): Promise<void> {
  try {
    const out = await j(`/api/sessions/${encodeURIComponent(sid)}/fork`, { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" });
    await loadSessions();
    if (out && out.id) await openSession(String(out.id));
  } catch (e: any) {
    // 与其它会话操作同一个失败出口：说人话，不吞
    alert(t("fork.failed", "分叉失败") + ": " + (e?.message || e));
  }
}

export function paintSessions(){
  syncProjectChrome();
  bumpUi();
}

// ── 会话改名 ────────────────────────────────────────────────────
// SESSION_TITLE_MAX 住在 state.ts（侧栏一行只看得见头几十个字，再长的名字在界面上
// 没有任何意义，服务端也要挡）。

// 把新标题就地贴到显示它的**三处**：侧栏那一行、当前会话对象、顶栏 <h2>。
// 不走 loadSessions()：自动命名发生在"第一份材料上传完"和"第一轮对话之后"，
// 那两刻侧栏和中栏正忙着别的事，为改一个字符串再拉一次全量列表既是多余的
// 往返，也会让列表整块闪一下。
export function applySessionTitle(sid: any, title: any){
  if (!sid || typeof title !== "string" || !title) return;
  let hit = false;
  const row = G.SESSION_LIST.find(x => x.id === sid);
  if (row && row.title !== title) { row.title = title; hit = true; }
  if (G.S && G.S.id === sid && G.S.title !== title) { G.S.title = title; hit = true; }
  if (!hit) return;                      // 名字没变就别重画，省掉一次无谓的闪烁
  paintSessions();
  // 顶栏只代表**当前**会话；别的会话改名不该动它。
  if (G.S && G.S.id === sid) { const h = $("title"); if (h) h.textContent = title; }
}

// 改名入口有两个：会话行标题上双击（每种模式都在），和工作模式 ⋯ 菜单里那一项。
export async function renameSession(sid: any){
  const known = G.SESSION_LIST.find(x => x.id === sid) || (G.S && G.S.id === sid ? G.S : null);
  const cur = (known && known.title) || "";
  // 折叠空白，和服务端的规范化保持一致：换行留在标题里没有任何意义，却会把
  // 侧栏那一行撑成两行；不折的话本地会先显示一个服务端并没有存下的样子。
  let name = (prompt(t("session.renamePrompt"), cur) || "").replace(/\s+/g, " ").trim();
  if (!name || name === cur) return;
  // 超长先截断而不是提交完被 400 顶回来 —— 用户当场就能看到"最后叫什么"。
  if (name.length > SESSION_TITLE_MAX) name = name.slice(0, SESSION_TITLE_MAX);
  let saved;
  try {
    saved = await j(`/api/sessions/${encodeURIComponent(sid)}`, {method:"PATCH",
      headers:{"content-type":"application/json"}, body: JSON.stringify({title: name})});
  } catch (e: any) {
    // 老后端的这条接口对 title 直接 400。**失败时一个字都不许本地改**：
    // 界面上先变成新名字、刷新一下又变回去，比当场说"没改成"更让人困惑。
    alert(t("session.renameFailed"));
    return;
  }
  // 以服务端存下的那个为准（它会再规范化一次），本地那份只是接口没回标题时的兜底。
  applySessionTitle(sid, (saved && saved.title) || name);
}

export const statusText = (s: any) => t("status." + s, s);

export async function newSession(silent?: any){
  G.S = await j("/api/sessions", {method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify({
      title: G.MODE === "chat" ? t("session.newChat") : t("session.newWork"),
      mode: G.MODE})});
  G.S.state = {}; G.S.events = []; G.ANSWERS = {}; G.SRC = {}; G.FILE = null; G.PENDING = []; G.QUEUED = []; G.MAT_N = 100;
  G.TAB = "model"; G.CONTEXT_BACK = null;
  G.S.filelist = []; G.S.files = 0; G.PROMPTS = []; G.FOLLOWUPS = [];
  G.Q_BACKLOG = []; G.Q_API = false; G.Q_FILTER = "open"; G.Q_LIMIT = 40; G.Q_NEXT = [];
  G.RETURN_AUDIT = null; G.RETURN_FILE = null; G.RETURN_BUSY = false;
  // 每 per-session 状态都得清，否则会残留上一个会话的内容（推理 tab 尤其明显）
  G.TRACE = []; G.OPS = []; G.STEPS = []; G.NEEDS_CONFIRM = false; G.CONFIRM_NEXT = false; stopThinking();
  // 新会话立刻拿开场提示 —— 不然第一屏是个空白输入框
  try { G.PROMPTS = (await j(`/api/sessions/${G.S.id}/state`)).prompts || []; } catch (e: any) {}
  await loadSessions(); connect(); render();
  // silent：文件已经拖进来了，再弹一次选择器是打断
  if (!silent) $("cin")?.focus();
}

export async function openSession(id: any){
  const st = await j(`/api/sessions/${id}/state`);
  G.S = st; G.S.events = []; G.ANSWERS = {}; G.SRC = {}; G.FILE = null; G.PENDING = []; G.QUEUED = []; G.MAT_N = 100;
  G.CONTEXT_BACK = null;
  G.MAIN_PAGE = "chat";
  const browserWindow = typeof window === "undefined" ? null : window;
  if (browserWindow?.location?.hash === "#knowledge" && browserWindow.history?.replaceState) {
    browserWindow.history.replaceState(
      { ...(browserWindow.history.state || {}), ocPage: "chat" },
      "",
      `${browserWindow.location.pathname}${browserWindow.location.search}`,
    );
  }
  // 上一轮的 chips 跟着会话回来（服务端存着）。以前这里写死清空，于是**每次
  // 重开一个聊过的会话、每次刷新，"接下来能问什么"就永久消失** —— 而那正是
  // 最需要它的时刻：隔了一天回来，对着一段旧对话，不知道该接着问什么。
  G.PROMPTS = st.prompts || []; G.FOLLOWUPS = st.followups || [];
  G.Q_BACKLOG = []; G.Q_API = false; G.Q_FILTER = "open"; G.Q_LIMIT = 40; G.Q_NEXT = [];
  G.RETURN_AUDIT = null; G.RETURN_FILE = null; G.RETURN_BUSY = false;
  // 切会话同样要清掉推理/待确认/思考残留 —— G.TRACE 是「推理」tab 唯一数据源
  G.TRACE = []; G.OPS = []; G.STEPS = []; G.NEEDS_CONFIRM = false; G.CONFIRM_NEXT = false; stopThinking();
  // 视图跟随会话自身的模式（聊天/工作），并同步顶部切换
  if (st.mode && st.mode !== G.MODE) { G.MODE = st.mode; localStorage.setItem("oc_mode", G.MODE); }
  applyMode();
  G.S.model = st.model || "";
  loadModels();          // 下拉要反映**这个**会话选的模型
  G.S.files = (st.filelist || []).length;
  await loadSessions(); connect(); render();
  await loadQuestions(); paint();
}

// 删会话。默认**只从列表移除**，产物和事件日志留在 workspace/ —— 这两件事
// 分开问，因为后者不可逆。
export async function dropSession(id: any, title: any){
  if (!confirm(`删除会话「${title}」？\n\n产物文件会保留在 workspace/ 里。`)) return;
  const purge = confirm("连同产物文件一起彻底删除？\n\n取消 = 只从列表移除（推荐）。");
  await j(`/api/sessions/${id}${purge ? "?purge=true" : ""}`, {method:"DELETE"});
  if (G.S && G.S.id === id) { G.S = null; if (G.ES) G.ES.close(); }
  await loadSessions(); render(); paint();
}

export async function refresh(){ if (G.S) await openSession(G.S.id); }
