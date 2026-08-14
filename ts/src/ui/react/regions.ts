// **组件注册的总入口。**
//
// registerRegion() 写在各个组件模块的顶层，模块体不执行就等于没注册；而组件模块
// 是被 JSX 引用的，没有任何一处 `import` 会顺带把它们带进来。所以这里逐个点名，
// main.ts 只 import 这一个文件。
//
// 迁一个模块过来就往下加一行（各条 track 的合并点因此只有这一处，不是 main.ts）。
import "./quota.js";        // #quotaBar  ← paintQuotaBar()
import "./settings.js";     // #setTabs / #setBody ← renderSettingsShell() 那一套
import "./accounts.js";     // #acctBody  ← renderAccounts()
import "./identity.js";     // #identity  ← renderIdentity()
import "./sidebar.js";      // #convs     ← paintSessions() / convRow()
import "./stream.js";       // #stream    ← render() 的中栏那一段
import "./preview.js";      // #pbody     ← paint() / paintLegacy() 那七个分支
// 下面两行登记的**不是** region，而是 PREVIEW_TABS 里剩下的三个 tab
// （见 react/preview.tsx 末尾定的接法）。<PreviewBody> 按 G.TAB 去这张表里取组件，
// 取不到就画空 —— 所以少 import 一行 = 少一整块屏幕，而且不报错。
import "./workbench.js";    // PREVIEW_TABS.q / .art   ← questionWorkbench() / 产物 tab
import "./think.js";        // PREVIEW_TABS.think      ← engagementProgress() / traceRow() / opsLog()
