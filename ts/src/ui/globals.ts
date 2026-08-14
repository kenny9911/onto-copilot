// 把内联事件处理器要用的符号挂回 window。
//
// **为什么必须有这一层**：index.html 的 HTML 结构逐字节不动，而它（以及运行时
// 拼出来的那些卡片）用的是 `onclick="newSession()"` 这种内联处理器 —— 浏览器把
// 属性值当**全局作用域**里的一段 JS 编译。打包成 IIFE 之后模块作用域是闭起来的，
// 不显式挂回去，界面上每一个按钮都会静默失灵（控制台一行 ReferenceError，
// 而没人在看控制台）。
//
// 名单是从 index.html 里**扫出来**的，不是凭印象列的：把所有
// on{click,change,input,dblclick,drag*,drop} 属性里的调用点和赋值点收集了一遍。
// 加新的内联处理器时这里必须跟着加 —— 这条约束是内联处理器自带的，不是打包引入的。

import { G } from "./state.js";
import { applyReturnAudit, auditReturnPicked, cancelReturnAudit, openReturnPicker } from "./returnaudit.js";
// 聊天流归 React 之后，chat.ts 只剩 sendChat / stopRun 要挂上去 —— 它们长在冻结的
// HTML 上（`#send` 与常驻动作栏里那颗停止）。ask / confirmAct 不在了：前者原来只被
// chips 那串 onclick 用，后者只被确认闸那串用，两串字符串都已经不存在。
// decisions.ts 整个从这份名单里消失，同理（pick / submitAnswer / pendingCard 连
// 函数本身都随 <PendingCard> 一起没了，adopt 现在是 <SuggestionCards> 的 onClick）。
import { sendChat, stopRun } from "./chat.js";
import {
  beginReset, cancelReset, changeRole, closeAccounts, doAddUser, doDeleteUser,
  doResetPassword, openAccounts, toggleActive,
} from "./accounts.js";
import {
  closeAcctMenu, closeLogin, closePassword, closeProfile, doAuthSubmit, doLogout,
  doPassword, doProfile, openPassword, openProfile, showLogin, toggleAcctMenu, toggleAuthMode,
} from "./auth.js";
import { dismissQuota } from "./quota.js";
// 侧栏归 React 之后，projects.ts 里只剩 newProject 还需要挂到 window ——
// 它是 index.html 里那颗 `#pjnewBtn` 的内联处理器（冻结的 HTML，改不得）。
// 其余十二个（toggleProject / dragSession / dropOnProject / …）原来只被
// paintSessions() 拼出来的那串 onclick 用，那串字符串已经不存在了。
import { newProject } from "./projects.js";
import { dropMaterial, setModel, startBuild } from "./upload.js";
// 右栏归 React 之后，preview.ts 这几个仍要挂上去：go / paint 长在冻结的 HTML 上
// （页签条那七颗 `.tab` 与「刷新」）。flowCite 不在了 —— 它原来只被 paintLegacy() 拼出
// 来的那串 onclick 用，那串字符串已经不存在，函数本身也随 #fcite 一起归了组件。
// toggleTable 同理：聊天流那张 ui.table 卡归了 <EvCard>，它现在是一个 onClick。
import { go, loadSource, openSource, paint, toggleSheet } from "./preview.js";
import { loadQuestions, qDefer, qReopen, qSaveMeta, qSetFilter, qSubmit } from "./questions.js";
// 同理：openSession / renameSession / dropSession 是会话行上的三个动作，
// 现在是 <ConvRow> 的 onClick，参数直接是值。newSession（`#newchatBtn`）与
// refresh（`#refreshBtn`）仍长在冻结的 HTML 上，必须留着。
import { newSession, refresh } from "./sessions.js";
import { render } from "./render.js";
import { setLang } from "./i18n.js";
import { setMode } from "./mode.js";
import {
  openSettings, closeSettings, resetAccent, saveConfig, setAccent, setDensity,
  setFontScale, setTheme, setTz, setUsageDays, switchSetTab, toggleUsageRows,
} from "./settings.js";
import { togglePreview, toggleSidebar } from "./layout.js";

const FNS: Record<string, unknown> = {
  applyReturnAudit, auditReturnPicked, beginReset, cancelReset,
  cancelReturnAudit, changeRole, closeAccounts, closeAcctMenu, closeLogin,
  closePassword, closeProfile, closeSettings, dismissQuota, doAddUser,
  doAuthSubmit, doDeleteUser, doLogout, doPassword, doProfile, doResetPassword,
  dropMaterial, go, loadQuestions, loadSource, newProject, newSession,
  openAccounts, openPassword, openProfile, openReturnPicker,
  openSettings, openSource, paint, qDefer, qReopen,
  qSaveMeta, qSetFilter, qSubmit, refresh, render, resetAccent,
  saveConfig, sendChat, setAccent, setDensity, setFontScale, setLang,
  setMode, setModel, setTheme, setTz, setUsageDays, showLogin, startBuild, stopRun,
  switchSetTab, toggleAcctMenu, toggleActive, toggleAuthMode,
  togglePreview, toggleSheet, toggleSidebar,
  toggleUsageRows,
};

// 内联处理器里**被直接赋值**的那几个全局。
//   onclick="Q_LIMIT+=40;paint()"            onclick="…;MAT_N+=100;paint()"
//   onclick="FILE='…';loadSource('…')"
// 用 get/set 访问器桥到 G，而不是把这些卡片的 onclick 文本改成调用 setter ——
// 改文本也能跑，但那会让「运行时生成的 HTML」两边不再逐字节可比，而可比正是
// 这次迁移唯一的验收手段。
//
// NEEDS_CONFIRM / PENDING_OPEN 不在这里了：`onclick="NEEDS_CONFIRM=false;render()"`
// 与 `onclick="PENDING_OPEN=!PENDING_OPEN;render()"` 分别是确认闸和待办卡头上的两串，
// 现在是 <ConfirmBar> / <PendingCard> 里的 onClick —— 直接改 G 再 bumpUi()。
const BRIDGED = ["FILE", "Q_LIMIT", "MAT_N"] as const;

export function bindGlobals(): void {
  for (const [name, fn] of Object.entries(FNS)) window[name] = fn;
  for (const name of BRIDGED) {
    Object.defineProperty(window, name, {
      configurable: true,
      get: () => (G as any)[name],
      set: (v: unknown) => { (G as any)[name] = v; },
    });
  }
}
