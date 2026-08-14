// i18n。静态标签的翻译表 —— 从 index.html 的内联 JS 逐字节搬过来，一个字符都没动。
import { G } from "./state.js";
import { $ } from "./dom.js";
import { paintSessions } from "./sessions.js";
import { renderIdentity } from "./auth.js";
import { paintQuotaBar } from "./quota.js";
import { savePref } from "./appearance.js";
import { render } from "./render.js";
import { paint } from "./preview.js";

// ── i18n ────────────────────────────────────────────────────────
export const I18N: Record<string, Record<string, string>> = {
  zh: {
    "nav.newSession":"+ 新会话", "nav.sessions":"会话",
    "sidebar.chatMeta":"对话", "sidebar.emptyChat":"还没有对话", "sidebar.emptyWork":"还没有工作会话",
    "tab.mat":"材料", "tab.ent":"实体", "tab.cf":"冲突", "tab.q":"问题", "tab.art":"产物", "tab.flow":"流程图", "tab.think":"推理",
    "mode.chat":"聊天", "mode.work":"工作",
    "status.idle":"待上传", "status.queued":"排队中", "status.parsing":"解析中", "status.extracting":"抽取中",
    "status.awaiting_answer":"待拍板", "status.done":"已完成", "status.failed":"失败", "status.ready":"就绪",
    "status.stopped":"已停止",
    "composer.placeholder":"说点什么，或直接把材料拖进来",
    "action.refresh":"刷新", "preview.title":"预览",
    "model.auto":"自动选模型",
    "mat.parsed":"已读入 {n} 段", "mat.scanPending":"待识别 · 图片", "mat.unread":"未读入",
    "mat.remove":"移除这份材料", "mat.allRead":"材料都已读入，可以开始梳理或直接提问",
    "mat.pendingScan":"有 {n} 份还没读入；图片/扫描件要点「开始梳理」才会用视觉模型识别",
    "mat.pendingText":"有 {n} 份还没读入；问它内容时助手会自动读，或直接「开始梳理」",
    "mat.count":"{n} 份材料",
    "table.expand":"展开全部 {n} 条", "table.collapse":"收起", "table.total":"共 {n} 条",
    "export.download":"下载 {name}",
    "session.newChat":"新对话", "session.newWork":"新会话",
    "session.rename":"重命名", "session.renamePrompt":"给这个会话起个名字",
    "session.renameTip":"双击可以改名", "session.renameFailed":"没能改名，稍后再试",
    "login.title":"登录", "login.subtitle":"登录后继续使用 OntoCopilot",
    "login.username":"用户名", "login.password":"密码", "login.submit":"登录",
    "login.displayName":"你的名字", "login.bad":"用户名或密码错误",
    "login.throttled":"尝试太多，请稍后再试",
    "register.title":"注册", "register.subtitle":"创建账号并登录（首个账号是管理员）",
    "register.submit":"注册", "register.short":"密码至少 6 位", "register.dup":"用户名已存在",
    "register.needName":"请填写你的名字",
    // 空状态那行小字：认得出人就问候他，认不出（本地模式、未登录）就还是那句
    "empty.tagline":"try, and do it",
    "empty.welcomeBack":"欢迎回来，{name}", "empty.welcomeNew":"欢迎，{name}",
    "auth.to_register":"没有账号？注册", "auth.to_login":"已有账号？登录",
    "register.subtitleLocal":"本机的会话会归到这个账号名下，不会丢",
    "auth.signIn":"登录 / 创建账号", "auth.later":"以后再说",
    "auth.changePassword":"修改密码", "auth.profile":"个人资料",
    "prof.title":"个人资料", "prof.subtitle":"账号不变，只改别人怎么称呼你",
    "prof.account":"账号", "prof.name":"你的名字", "prof.submit":"保存",
    "prof.failed":"没能保存，稍后再试",
    "pw.title":"修改密码", "pw.subtitle":"改完需要重新登录",
    "pw.old":"当前密码", "pw.new":"新密码（至少 6 位）", "pw.submit":"确认修改",
    "auth.pwTooShort":"新密码至少 6 位", "auth.pwWrong":"当前密码不对",
    // "common.cancel" 原文件在这里和末尾各写了一遍（值相同，JS 里后者胜出）。
    // TS 的对象字面量不许重复键，删掉靠前那一份 —— 得到的表与原来逐键相同。
    "auth.pwFailed":"改不了，稍后再试",
    "store.memory":"内存模式", "store.memoryHint":"会话在服务重启后会丢失",
    "store.error":"数据库异常", "auth.adopted":"已把 {n} 个会话归到这个账号",
    "auth.logout":"退出", "auth.local":"本地模式", "auth.accounts":"账户管理", "auth.settings":"设置", "auth.language":"语言",
    "role.admin":"管理员", "role.user":"用户",
    "accounts.title":"账户管理", "accounts.username":"用户名", "accounts.role":"角色", "accounts.active":"启用",
    "accounts.actions":"操作", "accounts.add":"添加账号", "accounts.addBtn":"添加", "accounts.password":"密码",
    "accounts.resetPw":"重置密码", "accounts.delete":"删除", "accounts.confirmDelete":"确定删除这个账号？",
    "accounts.newPwPrompt":"新密码",
    "accounts.errDup":"用户名已存在", "accounts.errLastAdmin":"不能移除最后一个管理员",
    "accounts.errSelfDelete":"不能删除自己",
    "settings.title":"设置", "settings.gateway":"网关", "settings.baseUrl":"服务地址", "settings.apiKey":"API Key",
    "settings.apiKeyHint":"留空则不修改", "settings.insecure":"不安全的 HTTP 连接",
    "settings.models":"模型分级", "settings.tierLow":"低", "settings.tierMedium":"中",
    "settings.tierHigh":"高", "settings.tierCritical":"关键",
    "settings.default":"默认", "settings.overridden":"已覆盖",
    "settings.budget":"预算", "settings.usdCap":"总额上限（USD）", "settings.chatUsdCap":"对话额度上限（USD）",
    // 余额：查不到是常态（多数网关没有这个接口），那时要说"查不到"，
    // 不能留空、更不能显示 0 —— 0 会被读成"钱花光了"。
    "balance.label":"网关余额", "balance.unknown":"当前网关不提供余额查询",
    "balance.remaining":"剩余 {v}", "balance.ofTotal":"（共 {v}）",
    "balance.quotaUnit":"{v} 额度", "balance.source":"来自 {v}",
    // 三种事件三种文案。S1（网关真的没钱）与 S3（我们自己设的闸）**必须分得清**：
    // 把 S3 说成"余额不足"，用户会去给一个根本没欠费的账户充值。
    "quota.exhausted":"网关账户余额不足，梳理已经停下",
    "quota.exhaustedHint":"这是网关那边的账户没钱了，充值后重试即可；已经跑出来的东西都还在。",
    "quota.low":"网关余额只剩 {v}，这次梳理可能跑不完",
    "quota.lowGeneric":"网关余额偏低，这次梳理可能跑不完",
    "quota.lowHint":"不想中途停的话，先去网关补一点。",
    // 这三句里**不出现**"充值 / 余额不足"这类词：本地上限跟网关账户没有半点关系。
    "budget.capped":"本次运行的花费上限用满了",
    "budget.cappedAmount":"本次运行的花费上限（{v}）用满了",
    "budget.cappedHint":"这是你自己在设置里设的闸，网关账户没有任何问题。要接着跑就把上限调高。",
    "quota.openSettings":"去设置", "quota.dismiss":"关掉这条提醒",
    "settings.env":"环境变量", "settings.restartRequired":"需重启", "settings.secret":"敏感",
    "settings.save":"保存", "settings.saved":"已保存",
    "usage.title":"用量", "usage.loading":"读取用量…",
    "usage.range":"时间范围", "usage.d1":"最近 24 小时", "usage.d7":"最近 7 天",
    "usage.d30":"最近 30 天", "usage.d90":"最近 90 天",
    "usage.tokens":"总 token", "usage.calls":"调用次数",
    "usage.tokIn":"输入 token", "usage.tokOut":"输出 token",
    "usage.trend":"消耗趋势", "usage.byModel":"按模型", "usage.byKind":"按用途",
    "usage.detail":"明细", "usage.cost":"金额（网关账单）",
    "usage.costAll":"全部 {total} 次调用都有网关账单",
    "usage.costPartial":"{total} 次调用里只有 {n} 次带网关账单；其余按本地价目表估的金额不计入",
    "usage.callsUnit":"次", "usage.peak":"峰值 {n}",
    "usage.empty":"这段时间还没有模型调用",
    "usage.failed":"其中 {n} 次最终失败（token 已消耗，仍计入）",
    "usage.failedTag":"失败", "usage.truncated":"条数过多，只统计了最近的一批",
    "usage.kind.build":"梳理", "usage.kind.chat":"对话", "usage.kind.aux":"辅助",
    "appearance.title":"外观", "appearance.theme":"主题",
    "appearance.theme.system":"跟随系统", "appearance.theme.light":"浅色", "appearance.theme.dark":"深色",
    "appearance.accent":"强调色", "appearance.accent.default":"默认", "appearance.font":"字号",
    "appearance.font.s":"小", "appearance.font.m":"中", "appearance.font.l":"大",
    "appearance.density":"密度", "appearance.density.comfortable":"舒适", "appearance.density.compact":"紧凑",
    "appearance.timezone":"时区", "appearance.timezone.browser":"跟随浏览器",
    // 项目文件夹（只有工作模式）
    "project.new":"新建项目", "project.namePrompt":"项目名称",
    "project.rename":"重命名", "project.renamePrompt":"新的项目名称",
    "project.delete":"删除项目",
    "project.confirmDelete":"删除项目「{name}」？\n\n里面的会话不会被删除，会掉回「未归类」；\n这个项目积累的项目记忆会一起删掉，且不可恢复。",
    "project.unfiled":"未归类", "project.noUnfiled":"会话都归好类了",
    "project.section":"项目", "project.createFirst":"+ 新建项目",
    "project.newSessionHere":"在这个项目里新建会话",
    "project.empty":"这个项目还没有会话",
    "project.moveTo":"移到项目", "project.moveOut":"移出项目", "project.none":"还没有项目",
    "project.failed":"没能改动，稍后再试",
    "common.cancel":"取消", "common.confirm":"确认", "common.close":"关闭",
  },
  en: {
    "nav.newSession":"+ New session", "nav.sessions":"Sessions",
    "sidebar.chatMeta":"Chat", "sidebar.emptyChat":"No conversations yet", "sidebar.emptyWork":"No work sessions yet",
    "tab.mat":"Materials", "tab.ent":"Entities", "tab.cf":"Conflicts", "tab.q":"Questions", "tab.art":"Artifacts", "tab.flow":"Flow", "tab.think":"Reasoning",
    "mode.chat":"Chat", "mode.work":"Work",
    "status.idle":"Pending upload", "status.queued":"Queued", "status.parsing":"Parsing", "status.extracting":"Extracting",
    "status.awaiting_answer":"Awaiting decision", "status.done":"Done", "status.failed":"Failed", "status.ready":"Ready",
    "status.stopped":"Stopped",
    "composer.placeholder":"Say something, or drop materials in",
    "action.refresh":"Refresh", "preview.title":"Preview",
    "model.auto":"Auto-select model",
    "mat.parsed":"{n} segments read", "mat.scanPending":"Pending OCR · image",
    "mat.unread":"Not read", "mat.remove":"Remove this material",
    "mat.allRead":"All materials read — start the run, or just ask",
    "mat.pendingScan":"{n} not read yet; images need “Start run” to be recognised",
    "mat.pendingText":"{n} not read yet; the assistant reads them when you ask, or start the run",
    "mat.count":"{n} materials",
    "table.expand":"Show all {n}", "table.collapse":"Collapse", "table.total":"{n} rows",
    "export.download":"Download {name}",
    "session.newChat":"New chat", "session.newWork":"New session",
    "session.rename":"Rename", "session.renamePrompt":"Name this session",
    "session.renameTip":"Double-click to rename",
    "session.renameFailed":"Couldn’t rename, try again later",
    "login.title":"Sign in", "login.subtitle":"Sign in to continue using OntoCopilot",
    "login.username":"Username", "login.password":"Password", "login.submit":"Sign in",
    "login.displayName":"Your name", "login.bad":"Incorrect username or password",
    "login.throttled":"Too many attempts, try again later",
    "register.title":"Create account", "register.subtitle":"Register and sign in (the first account is admin)",
    "register.submit":"Register", "register.short":"Password must be at least 6 characters", "register.dup":"Username already taken",
    "register.needName":"Please enter your name",
    "empty.tagline":"try, and do it",
    "empty.welcomeBack":"Welcome back, {name}", "empty.welcomeNew":"Welcome, {name}",
    "auth.to_register":"No account? Register", "auth.to_login":"Have an account? Sign in",
    "register.subtitleLocal":"Sessions on this machine move to this account — nothing is lost",
    "auth.signIn":"Sign in / Create account", "auth.later":"Not now",
    "auth.changePassword":"Change password", "auth.profile":"Profile",
    "prof.title":"Profile", "prof.subtitle":"Your account stays the same — this is just what people call you",
    "prof.account":"Account", "prof.name":"Your name", "prof.submit":"Save",
    "prof.failed":"Could not save, try again",
    "pw.title":"Change password", "pw.subtitle":"You'll need to sign in again afterwards",
    "pw.old":"Current password", "pw.new":"New password (min 6 characters)",
    "pw.submit":"Change password",
    "auth.pwTooShort":"New password must be at least 6 characters",
    "auth.pwWrong":"Current password is wrong",
    "auth.pwFailed":"Couldn't change it, try again later",
    "store.memory":"In-memory mode", "store.memoryHint":"Sessions are lost when the server restarts",
    "store.error":"Database error", "auth.adopted":"{n} session(s) moved to this account",
    "auth.logout":"Log out", "auth.local":"Local mode", "auth.accounts":"Accounts", "auth.settings":"Settings", "auth.language":"Language",
    "role.admin":"Admin", "role.user":"User",
    "accounts.title":"Accounts", "accounts.username":"Username", "accounts.role":"Role", "accounts.active":"Active",
    "accounts.actions":"Actions", "accounts.add":"Add account", "accounts.addBtn":"Add", "accounts.password":"Password",
    "accounts.resetPw":"Reset password", "accounts.delete":"Delete", "accounts.confirmDelete":"Delete this account?",
    "accounts.newPwPrompt":"New password",
    "accounts.errDup":"Username already exists", "accounts.errLastAdmin":"Cannot remove the last admin",
    "accounts.errSelfDelete":"Cannot delete yourself",
    "settings.title":"Settings", "settings.gateway":"Gateway", "settings.baseUrl":"Base URL", "settings.apiKey":"API Key",
    "settings.apiKeyHint":"Leave blank to keep unchanged", "settings.insecure":"Insecure HTTP connection",
    "settings.models":"Model tiers", "settings.tierLow":"Low", "settings.tierMedium":"Medium",
    "settings.tierHigh":"High", "settings.tierCritical":"Critical",
    "settings.default":"Default", "settings.overridden":"Overridden",
    "settings.budget":"Budget", "settings.usdCap":"Total cap (USD)", "settings.chatUsdCap":"Chat cap (USD)",
    "balance.label":"Gateway balance", "balance.unknown":"This gateway offers no balance lookup",
    "balance.remaining":"{v} left", "balance.ofTotal":"(of {v})",
    "balance.quotaUnit":"{v} quota", "balance.source":"from {v}",
    "quota.exhausted":"The gateway account is out of credit — the run stopped",
    "quota.exhaustedHint":"The account at your gateway has run dry. Top it up and retry; everything produced so far is kept.",
    "quota.low":"Only {v} left on the gateway — this run may not finish",
    "quota.lowGeneric":"The gateway balance is low — this run may not finish",
    "quota.lowHint":"Add a little at the gateway if you would rather not stop halfway.",
    "budget.capped":"This run hit the spending cap",
    "budget.cappedAmount":"This run hit the spending cap you set ({v})",
    "budget.cappedHint":"That cap is your own limit in Settings; nothing is wrong with the gateway account. Raise it to keep going.",
    "quota.openSettings":"Open settings", "quota.dismiss":"Dismiss this notice",
    "settings.env":"Environment", "settings.restartRequired":"Restart required", "settings.secret":"Secret",
    "settings.save":"Save", "settings.saved":"Saved",
    "usage.title":"Usage", "usage.loading":"Loading usage…",
    "usage.range":"Range", "usage.d1":"Last 24h", "usage.d7":"Last 7 days",
    "usage.d30":"Last 30 days", "usage.d90":"Last 90 days",
    "usage.tokens":"Total tokens", "usage.calls":"Calls",
    "usage.tokIn":"Input tokens", "usage.tokOut":"Output tokens",
    "usage.trend":"Consumption over time", "usage.byModel":"By model",
    "usage.byKind":"By purpose", "usage.detail":"Detail",
    "usage.cost":"Cost (gateway-billed)",
    "usage.costAll":"All {total} calls came with a gateway bill",
    "usage.costPartial":"Only {n} of {total} calls came with a gateway bill; locally estimated amounts are excluded",
    "usage.callsUnit":"calls", "usage.peak":"peak {n}",
    "usage.empty":"No model calls in this range",
    "usage.failed":"{n} of these ultimately failed (tokens were still spent and are counted)",
    "usage.failedTag":"failed", "usage.truncated":"Too many rows; only the most recent batch is counted",
    "usage.kind.build":"Build", "usage.kind.chat":"Chat", "usage.kind.aux":"Aux",
    "appearance.title":"Appearance", "appearance.theme":"Theme",
    "appearance.theme.system":"System", "appearance.theme.light":"Light", "appearance.theme.dark":"Dark",
    "appearance.accent":"Accent color", "appearance.accent.default":"Default", "appearance.font":"Font size",
    "appearance.font.s":"Small", "appearance.font.m":"Medium", "appearance.font.l":"Large",
    "appearance.density":"Density", "appearance.density.comfortable":"Comfortable", "appearance.density.compact":"Compact",
    "appearance.timezone":"Timezone", "appearance.timezone.browser":"Browser default",
    "project.new":"New project", "project.namePrompt":"Project name",
    "project.rename":"Rename", "project.renamePrompt":"New project name",
    "project.delete":"Delete project",
    "project.confirmDelete":"Delete project “{name}”?\n\nIts sessions are not deleted — they fall back to “Unfiled”.\nThe project memory it accumulated is deleted with it, and cannot be recovered.",
    "project.unfiled":"Unfiled", "project.noUnfiled":"Every session is filed",
    "project.section":"Projects", "project.createFirst":"+ New project",
    "project.newSessionHere":"New session in this project",
    "project.empty":"No sessions in this project yet",
    "project.moveTo":"Move to project", "project.moveOut":"Take out of the project",
    "project.none":"No projects yet",
    "project.failed":"That change did not go through, try again later",
    "common.cancel":"Cancel", "common.confirm":"Confirm", "common.close":"Close",
  },
};

// vars 用来填 "{n} 份材料" 这类占位。不给 vars 时行为和以前完全一致。
export function t(key: string, fallback?: any, vars?: any): string {
  let s = (I18N[G.LANG] && I18N[G.LANG]![key]) ?? (I18N["zh"]![key]) ?? fallback ?? key;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
  return s;
}

export function setLang(l: string): void {
  G.LANG = (l === "en") ? "en" : "zh";
  localStorage.setItem("oc_lang", G.LANG);
  document.documentElement.lang = G.LANG === "en" ? "en" : "zh-CN";
  applyI18n();
  savePref("lang", G.LANG);
}

// 静态标签的翻译。动态内容（statusText、composer placeholder 等）在各自的
// render 里已经走 t()，这里只处理不随会话状态变化的固定文案。
export function applyI18n(): void {
  document.documentElement.lang = G.LANG === "en" ? "en" : "zh-CN";
  const set = (id: string, txt: string) => { const el = $(id); if (el) el.textContent = txt; };
  set("newchatBtn", t("nav.newSession"));
  const sec = document.querySelector(".sec"); if (sec) sec.textContent = t("nav.sessions");
  const pjn = $("pjnewBtn"); if (pjn) pjn.title = t("project.new");
  // 会话行里的状态、项目组的「未归类」都是翻过的文案，切语言得重画一遍侧栏
  if (G.SESSION_LIST.length || G.PROJECTS.length) paintSessions();
  const mChat = document.querySelector('#modetog button[data-mode="chat"]'); if (mChat) mChat.textContent = t("mode.chat");
  const mWork = document.querySelector('#modetog button[data-mode="work"]'); if (mWork) mWork.textContent = t("mode.work");
  document.querySelectorAll(".tab").forEach((b: any) => { const k = b.dataset.t;
    if (k) b.textContent = t("tab." + k); });
  set("refreshBtn", t("action.refresh"));
  const pt = document.querySelector(".preview .pt"); if (pt) pt.textContent = t("preview.title");
  document.querySelectorAll("#langsw button").forEach((b: any) => b.classList.toggle("on", b.dataset.lang === G.LANG));
  renderIdentity();
  paintQuotaBar();     // 提醒条常驻，切语言时它多半正挂着
  if (G.S) { render(); paint(); }
}
