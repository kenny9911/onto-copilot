// 页面级可变状态。
//
// 内联 JS 时代这些全是顶层 `let`，模块化之后必须换个住处：ESM 的 import 绑定是
// 只读的，`import {S} from "./state.js"; S = x` 编译不过 —— 逐个写 setter 会让
// 三千行代码里的每一次赋值都变形，而这次迁移唯一的安全性来源就是「两边逐函数
// 可比」。所以收进一个可变对象 `G`，赋值从 `S = x` 变成 `G.S = x`，**形状不变**。
//
// 声明顺序刻意跟着原文件走（原文件顶部那批 let 有一段注释解释为什么必须留在
// 最上面：init 那个 IIFE 是同步开跑的，applyI18n 会读 SESSION_LIST / QUOTA，
// 声明在后面就撞 TDZ）。放进对象之后 TDZ 不再是问题，但注释留着 —— 它记的是
// 一次真实事故，不是实现细节。

/** 服务端负载一律是无模式 JSON：这里不假装知道它的形状。 */
export type Json = any;

export interface UiState {
  /** 当前会话（/api/sessions/{id}/state 的返回，外加前端挂的 events / filelist）。 */
  S: Json;
  /** 中栏顶级页面。项目知识库是独立页面，不属于右侧会话上下文栏。 */
  MAIN_PAGE: "chat" | "knowledge";
  TAB: string;
  /** 从模型/审阅点进证据后回到原工作上下文；显式切导航时清空。 */
  CONTEXT_BACK: string | null;
  FILE: string | null;
  SRC: Record<string, Json>;
  ES: Json;
  ANSWERS: Record<string, string>;

  // 服务端新 Question Ledger 不可用时，仍从 state.oir.questions 与冲突卡合成只读 backlog。
  // 这样升级可渐进部署：前端先到不会让现有工作台失效，后端到后自动启用写操作。
  Q_BACKLOG: Json[];
  Q_API: boolean;
  Q_FILTER: string;
  Q_LIMIT: number;
  Q_NEXT: Json[];
  RETURN_AUDIT: Json;
  RETURN_FILE: Json;
  RETURN_BUSY: boolean;

  MODE: string;

  // 侧栏项目文件夹。**只在工作模式存在** —— 聊天模式 PROJECTS 恒为空数组，分组
  // 渲染因此天然退回平铺，不需要在画的时候再判一次模式。
  // PROJECTS_OK：这个实例的后端有没有 /api/projects。拉不到就当没有项目，
  // 侧栏保持现在的样子，不弹错 —— 前端可以先于后端部署。
  // 这几个 let 必须留在这里（而不是跟着 loadSessions 走）：init 那个 IIFE 是同步
  // 开跑的，applyI18n 会读 SESSION_LIST，声明在文件后面就撞 TDZ。
  PROJECTS: Json[];
  PROJECTS_OK: boolean;
  SESSION_LIST: Json[];

  // 额度提醒条的状态。**跟上面 SESSION_LIST 同一个理由留在这儿**：applyI18n 里那句
  // paintQuotaBar() 会读 QUOTA，而 init 那个 IIFE 是同步开跑的 —— 声明放回下面
  // 「额度提醒条」那一段（原来就在那儿）就撞 TDZ，每次加载都抛一次
  // "Cannot access 'QUOTA' before initialization"，把 init 的后半段整个吞掉。
  // 三种事件各自的含义写在下面 paintQuotaBar 那一段，别在这里重复。
  QUOTA: Json;

  STREAM: Json; // {full, i, timer} —— 助手回答的打字机流式呈现

  // 477 个切片全渲染会让面板卡住，也没人会一次看完。
  MAT_N: number;
  // 材料预览：哪些 sheet 是展开的。默认第一张展开，其余折叠。
  MAT_OPEN: Set<string>;

  // 乐观上屏的消息。服务端回执到达后由 S.state.dialogue 接管，这里清空 ——
  // 不清的话同一句话会显示两遍。
  PENDING: Json[];
  /** 轮次在跑时用户又发的话。**不丢也不硬发** —— 硬发会撞服务端的 409，
   *  而那条错误以前会永久卡在气泡流里。落地后自动出队。 */
  QUEUED: string[];
  // 当前这轮推理的过程。回答落地后清空 —— 保留的话每轮都会越堆越长。
  STEPS: Json[];
  // 是否正在等回复。发出去的那一刻就置上，不等第一个 step。
  THINKING: boolean;
  // 上一轮有动作被闸门挡住，等用户点确认。**一轮限定**，用完即清。
  NEEDS_CONFIRM: boolean;
  CONFIRM_NEXT: boolean;
  // 开场提示（会话级）与追问（每轮刷新）。空白输入框对新用户最不友好。
  PROMPTS: Json[];
  FOLLOWUPS: Json[];
  // 全部推理轮次的存档，给右栏「推理」tab 用。STEPS 只有当前这轮。
  TRACE: Json[];
  // **这个会话里发生过的每一件事**，给右栏「推理」tab 的操作记录用。
  // 和 TRACE 分开：TRACE 记的是「AI 想了什么」，OPS 记的是「系统做了什么」——
  // 混成一条时间线，两边都读不清。封顶防止长会话把内存吃光。
  OPS: Json[];
  // 停止按钮：中断在跑的对话轮。abort 掉这条 /chat fetch 让前端不再干等；真正让
  // 服务端停下的是并发发出的 /stop。
  CHAT_ABORT: AbortController | null;

  LANG: string;
  CURRENT_USER: Json;

  AUTH_MODE: string; // login | register —— 共用同一套表单
  // 主动点开的（本地模式下从账户菜单进来）可以关掉；强制鉴权弹出来的那次不行 ——
  // 那是闸，关掉只会看到一个空壳应用。
  AUTH_DISMISSIBLE: boolean;

  DRAG_SID: string | null;

  SEEN_BUBBLES: number;
  SEEN_SID: string | null;

  PENDING_OPEN: boolean;

  MODELS: Json[];

  THINK_T0: number;
  THINK_TIMER: Json;
  PFADE_T: Json;

  USERS: Json[];
  RESET_ID: string | null; // 正在给哪个用户重置密码，行内展开一个小表单

  SET_TAB: string;
  CONFIG: Json; // GET /api/config 的缓存，只有管理员会去拿

  USAGE: Json;
  USAGE_DAYS: number;
  /** 用量按账号钻取；""=全部。只有管理员用得到。 */
  USAGE_OWNER: string;
  USAGE_ROWS_OPEN: boolean;
}

export const G: UiState = {
  S: null, MAIN_PAGE: "chat", TAB: "model", CONTEXT_BACK: null, FILE: null, SRC: {}, ES: null, ANSWERS: {},
  Q_BACKLOG: [], Q_API: false, Q_FILTER: "open", Q_LIMIT: 40,
  Q_NEXT: [], RETURN_AUDIT: null, RETURN_FILE: null, RETURN_BUSY: false,
  MODE: localStorage.getItem("oc_mode") || "work", // 聊天 / 工作 双模式
  PROJECTS: [], PROJECTS_OK: false, SESSION_LIST: [],
  QUOTA: null,
  STREAM: null,
  MAT_N: 100,
  MAT_OPEN: new Set<string>(),
  PENDING: [], QUEUED: [], STEPS: [], THINKING: false,
  NEEDS_CONFIRM: false, CONFIRM_NEXT: false,
  PROMPTS: [], FOLLOWUPS: [], TRACE: [], OPS: [],
  CHAT_ABORT: null,
  LANG: localStorage.getItem("oc_lang") || "zh",
  CURRENT_USER: null,
  AUTH_MODE: "login", AUTH_DISMISSIBLE: false,
  DRAG_SID: null,
  SEEN_BUBBLES: 0, SEEN_SID: null,
  PENDING_OPEN: true,
  MODELS: [],
  THINK_T0: 0, THINK_TIMER: null, PFADE_T: null,
  USERS: [], RESET_ID: null,
  SET_TAB: "appearance", CONFIG: null,
  USAGE: null, USAGE_DAYS: 7, USAGE_OWNER: "", USAGE_ROWS_OPEN: false,
};

/** 忙着提交的问题 id。原文件是 `const Q_BUSY = new Set()`，从没被重新赋值。 */
export const Q_BUSY = new Set<string>();

// 折叠起来的项目。存的是「收起了哪些」而不是「展开了哪些」，这样新建的项目默认展开。
// 「未归类」在收展状态里和项目共用一套存储。用一个真项目 id 不可能长成的
// 字面量当 key —— 项目 id 是 uuid4().hex[:12]，撞不上。
export const UNFILED = "__unfiled__";
export const PJ_OFF = new Set<string>(JSON.parse(localStorage.getItem("oc_pj_off") || "[]"));

// AI 列出来的表格默认只显示前 30 行，展开状态按事件 seq 记 —— 202 条一次铺开
// 会把聊天流冲垮，但"全部列出来"的承诺又必须能兑现。
export const TBL_OPEN = new Set<number>();

export const OPS_CAP = 600;

export const QUOTA_KINDS = ["quota.exhausted", "quota.low", "budget.capped"];
// 事件重放会把三天前那条 quota.exhausted 原样再送一遍（EventSource 重连、
// 打开旧会话都从 since=0 开始）。提醒条断言的是**此刻**的状态，六小时前的证据
// 撑不起这句话；真没钱的话，下一次调用几秒内就会把它重新竖起来。
export const QUOTA_STALE_SEC = 6 * 3600;

// 侧栏一行只看得见头几十个字，再长的名字在界面上没有任何意义，服务端也要挡。
export const SESSION_TITLE_MAX = 120;
