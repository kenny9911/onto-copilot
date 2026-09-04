// 事件流（EventSource）。首连从 0 水合；断线后从已收到的最大 durable seq 继续。
import { G, OPS_CAP, QUOTA_KINDS } from "./state.js";
import { API } from "./dom.js";
import { evLabel, evDetail, evTag } from "./events.js";
import { noteQuota, clearQuota } from "./quota.js";
import { applySessionTitle } from "./sessions.js";
import { loadQuestions } from "./questions.js";
import { mergeStateSnapshot, addTurn, stopThinking } from "./chat.js";
import { render } from "./render.js";
import { paint } from "./preview.js";
import { contextSyncStore } from "./context-sync.js";
import { emitKnowledgeChanged } from "./knowledge-events.js";

// ── 事件流 ──────────────────────────────────────────────────────
const ES_OPEN = 1;
const RECONNECT_MS = 500;
let streamGeneration = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function cancelReconnect(): void {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/** 断点只认已落库的非负 seq；pending projection 不能变成续传游标。 */
function nextDurableSeq(sid: string): number {
  if (!G.S || G.S.id !== sid) return 0;
  let latest = -1;
  for (const ev of G.S.events || []) {
    const seq = Number(ev?.seq);
    if (Number.isSafeInteger(seq) && seq >= 0) latest = Math.max(latest, seq);
  }
  return latest + 1;
}

/**
 * generation + sid 是同一道隔离栅：关掉 EventSource 不保证已排进事件队列的
 * message/reset 不再回调，所以旧流的回调还必须自己失效。
 */
function openStream(sid: string, since: number): void {
  cancelReconnect();
  const previous = G.ES;
  G.ES = null;
  previous?.close?.();
  const generation = ++streamGeneration;
  if (!G.S || G.S.id !== sid) return;

  const source = new EventSource(`${API}/api/sessions/${sid}/stream?since=${since}`);
  G.ES = source;
  const current = (): boolean =>
    generation === streamGeneration && G.S?.id === sid && G.ES === source;

  source.onopen = () => {
    if (current()) cancelReconnect();
  };
  source.onerror = () => {
    if (!current() || reconnectTimer !== null) return;
    // 先给原生 EventSource 一个恢复窗口；若它重新 open，onopen 会撤销这次重建。
    // 否则只有这一枚定时器换流，错误风暴也不会同时建出多条连接。
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!current() || Number(source.readyState) === ES_OPEN) return;
      openStream(sid, nextDurableSeq(sid));
    }, RECONNECT_MS);
  };
  source.onmessage = (e: any) => {
    if (!current()) return;
    const ev = JSON.parse(e.data);
    // 服务端从头重放前先发这一条。事件序号现在来自持久 session_event，重启后也
    // 不会归零；下面每条事件本来就按 seq 去重。因此这里不能先清空现有投影：历史
    // chat.turn 总在 web.sources 之前重放，清空会让已经显示的来源卡先消失，若重放
    // 中途断开就会一直消失到用户手动刷新。切换会话时 openSession 已负责清空。
    if (ev.kind === "stream.reset") return;
    G.S.events = G.S.events.filter((x: any) => x.seq !== ev.seq).concat([ev]).sort((a: any,b: any)=>a.seq-b.seq);
    // 操作记录：**除了对话本身，发生的每一件事都记一笔**，给右栏「推理」用。
    // 对话内容不进来（它在聊天窗口里，抄一遍是噪声），但对话过程中 AI 调了什么
    // 工具、系统改了什么产物、哪一步失败了，都要留痕。
    if (!["chat.turn", "chat.step"].includes(ev.kind)) {
      if (!G.OPS.some(x => x.seq === ev.seq && x.kind === ev.kind)) {
        G.OPS.push({seq: ev.seq, kind: ev.kind, ts: ev.ts,
                  label: evLabel(ev.kind), detail: evDetail(ev), tag: evTag(ev.kind)});
        if (G.OPS.length > OPS_CAP) G.OPS.splice(0, G.OPS.length - OPS_CAP);
        if (G.TAB === "think") paint();
      }
    }
    // 额度提醒条。事件按 seq 顺序到达，所以"先没钱、后又跑通了"的历史会话
    // 重放一遍之后自然停在"跑通了"上，不会挂着一条隔夜的红条。
    if (QUOTA_KINDS.includes(ev.kind)) noteQuota(ev);
    if (ev.kind === "run.completed" || ev.kind === "artifact.ready"
        || (ev.kind === "chat.turn" && ev.turn?.speaker === "assistant")) clearQuota();
    // 自动命名（上传完第一份材料、第一轮对话之后）在服务端发生，改完发这一条。
    // 事件走的是**当前会话**那条流，所以没带会话 id 时它说的就是当前这条。
    // 知识库被模型改了。
    //
    // 这条通道以前整条不存在：模型 promote / attach / archive 成功之后，界面上
    // 一个字都没有 —— 知识库页开着的话，左边的树里不会冒出刚存进去的材料；
    // 右栏「已固定 N 份」的 N 也不动。用户只能自己去点刷新，而他刚刚明明看见
    // 系统说改好了。
    //
    // 两件事分开做，因为它们答的是两个问题：
    //   · 回执卡答「刚才发生了什么」—— 走 contextSyncStore，和右栏那十来个
    //     人点出来的回执共用一条渠道和一种外观。它刻意不是聊天气泡：
    //     「系统写进了什么」不该混在对话里。
    //   · 自定义事件答「哪一块该重画」—— 知识库页自己订阅它去重拉列表。
    //     事件里**不带清单**：让页面自己去拉，那条路上有 ACL；把内容塞进
    //     事件等于绕开它。
    //
    // createdAt 用事件自己的时间戳，不用 now()。回执 id 是按内容（含 createdAt）
    // 哈希的，于是断线重连的全量重放会算出同一个 id、被 publish 原样去重 ——
    // 否则重放 2000 条历史会在流尾堆出一摞重复回执，那正是 2026-08-25 那次
    // 页面冻死的同一类成因。
    if (ev.kind === "document.changed") {
      contextSyncStore.publish({
        type: "context.update",
        section: "evidence",
        origin: "system",
        title: documentChangeTitle(ev),
        summary: "这是 Copilot 在本轮里对知识库做的改动，不是它给你的回答。",
        ...(ev.ts ? { createdAt: ev.ts } : {}),
      });
      emitKnowledgeChanged(String(ev.action || ""));
    }
    if (ev.kind === "session.renamed") applySessionTitle(ev.id || G.S.id, ev.title);
    if (ev.kind === "clarify.request") { G.S.state.questions = ev.questions; loadQuestions(); }
    if (ev.kind === "suggest.ready") G.S.state.suggestions = ev.suggestions;
    if (ev.kind === "chat.step") {
      // 同一步会回调两次（发起时、拿到结果后），按 n 就地更新而不是追加
      const key = (x: any) => `${x.turn}#${x.n}`;
      // 后台辅助调用（措辞、推荐问题）**只进「推理」tab，不进对话流**。它们大多
      // 发生在回答落地之后，而 G.STEPS 在那一刻刚被清空 —— 于是答案下方又冒出一张
      // "想推荐问题：…"的思考卡，像是还没答完。那一栏叫「推理」，它归那儿。
      if (ev.step.turn !== "aux") {
        const i = G.STEPS.findIndex(x => key(x) === key(ev.step));
        if (i >= 0) G.STEPS[i] = ev.step; else G.STEPS.push(ev.step);
      }
      const j = G.TRACE.findIndex(x => key(x) === key(ev.step));
      if (j >= 0) G.TRACE[j] = {...ev.step, ts: ev.ts};
      else G.TRACE.push({...ev.step, ts: ev.ts});
      if (G.TAB === "think") paint();
    }
    // 梳理过程的内核推理也要进「推理」面板。以前那一栏只认 chat.step（对话侧），
    // 于是抽取跑几分钟、AI 一直在想在查，面板却是空的 —— FDE 分不清"在干活"
    // 还是"卡住了"。这里把内核事件映成同一种行结构，归到「材料梳理」这一轮下。
    if (ev.kind && ev.kind.indexOf("kernel.") === 0) {
      // cohort（节点内并行子任务）标注：同一个节点里几条线各想各的，不标出
      // 是谁在想，面板上就是一锅粥（P4）。
      const coTag = (x: any) => (x.cohort_task !== undefined ? `[并行任务${x.cohort_task + 1}] ` : "");
      const KROW: Record<string, (x: any) => any> = {
        "kernel.thought":     (x: any) => ({thought: coTag(x) + x.detail}),
        "kernel.plan":        (x: any) => (x.cohort
          ? {thought: `${x.node || ""} 启动 ${x.cohort_tasks} 个并行分析任务：${x.detail || ""}`}
          : {thought: "计划：" + (x.detail || "")}),
        "kernel.observation": (x: any) => ({tool: x.node || "查证", observation: coTag(x) + x.detail}),
        "kernel.critic":      (x: any) => ({observation: "审查：" + (x.detail || "")}),
        "kernel.node_failed": (x: any) => ({observation: `${x.node || ""} 失败：${x.detail || ""}`}),
        "kernel.degraded":    (x: any) => ({observation: "降级：" + (x.detail || "")}),
        // 完成行带耗时（投影层现算的 secs，不是心跳）——「在干活」和「卡住了」
        // 的第三种答案是「已经干完了，花了多久」。
        "kernel.node_completed": (x: any) => ({
          observation: `${x.node || ""} 完成${typeof x.secs === "number" ? `（${x.secs}s）` : ""}`,
        }),
      };
      const mk = KROW[ev.kind];
      if (mk) {
        const n = G.TRACE.filter(x => x.turn === "build").length + 1;
        G.TRACE.push({turn:"build", q:"材料梳理", n, ...mk(ev), ts: ev.ts});
        if (G.TAB === "think") paint();
      }
    }
    if (ev.kind === "chat.turn") {
      if (ev.turn.speaker === "assistant") G.STEPS = [];   // 回答落地，过程收起
      addTurn(ev.turn);
      // 回执到了，撤掉对应的乐观占位
      if (ev.turn.speaker === "user") G.PENDING = G.PENDING.filter(x => x.text !== ev.turn.text);
      if (ev.turn.speaker === "assistant") stopThinking();
    }
    // AI 算出的**开场**提示到了，把启发式那批换掉。一轮对话的追问不走这条路 ——
    // 它跟着回答一起从 /chat 回来（res.followups），和答案同一刻上屏，
    // 所以这里不再需要对轮次。
    if (ev.kind === "prompts.ready" && ev.slot === "opening") G.PROMPTS = ev.questions || [];
    if (ev.kind === "node.completed" && ev.node === "CONFLICT") G.S.state.conflicts = ev.conflicts;
    // 对话层的写入**必须**在这张表里。它们本来只进活动流（G.OPS），于是界面上
    // 看得到"改了本体"这条记录，右栏的对象/流程计数却纹丝不动 —— 用户只能去点
    // 刷新，而他刚刚明明看见系统说改好了。判据是"这个事件代表会话状态变了吗"，
    // 不是"它由哪一层发出"。
    if (["corpus.ready","corpus.restored","parse.failed","run.completed","run.failed","run.suspended","run.cancelled","artifact.ready","human.recorded","question.updated","question.answered","audit.applied","draft.initialized","draft.updated","oir.edited","flow.ready","sketch.ready","template.edited","document.changed"].includes(ev.kind))
      scheduleStateRefresh();
    scheduleRender();
  };
}

// ── SSE 归约的两个去抖阀 ─────────────────────────────────────────
//
// **案发现场（2026-08-25，会话 d53cb63f7e18）**：首连是 `?since=0` 全历史回放，
// 2016 条事件同步涌入。上面那张「状态刷新事件表」扩进了高频事件（oir.edited /
// flow.ready / draft.updated / template.edited）之后，历史里的每一条都触发一次
// 「拉 8MB /state + loadQuestions（数千问题）+ 全量 render+paint」；再叠加
// 每事件一次的收尾 render —— 渲染进程 100% CPU 冻死 10 分钟以上，页面对点击
// 无任何反应。表本身的意图是对的（状态变了要刷新），错在**每条事件都立刻全套**。
// 去抖之后：回放风暴坍缩成一次刷新 + 每帧一次渲染；活动期的事件爆发
// （比如 mutation queue 收尾一次 drain 多条事件）同样受益。

/** 手动打开/切换会话时从头水合；自动断线才走上面的续传游标。 */
/**
 * 回执卡上那一行字。
 *
 * 说的是**动作**，不是工具名：用户不需要知道有个东西叫 document.promote_batch。
 * 认不出来的动作就笼统说一句，绝不把英文枚举漏到界面上。
 */
function documentChangeTitle(ev: any): string {
  const title = String(ev.title || "").trim();
  switch (String(ev.action || "")) {
    case "promote": return title ? `Copilot 把「${title}」存进了知识库` : "Copilot 把一份材料存进了知识库";
    case "promote_batch": return `Copilot 把 ${Number(ev.count) || 0} 份材料存进了知识库`;
    case "attach": return "Copilot 把一份知识库材料加进了本次分析";
    case "detach": return "Copilot 把一份材料移出了本次分析";
    case "archive": return title ? `Copilot 归档了「${title}」` : "Copilot 归档了一份材料";
    case "restore": return title ? `Copilot 恢复了「${title}」` : "Copilot 恢复了一份材料";
    case "adopt_version": return title ? `Copilot 切换了「${title}」的采用版本` : "Copilot 切换了采用版本";
    case "update_metadata": return title ? `Copilot 改了「${title}」的信息` : "Copilot 改了一份材料的信息";
    case "remember": return `Copilot 记了一条待确认的项目知识：${String(ev.subject || "").trim() || "（无主题）"}`;
    default: return "Copilot 改动了知识库";
  }
}

export function connect(){
  cancelReconnect();
  if (!G.S) {
    G.ES?.close?.();
    G.ES = null;
    streamGeneration++;
    return;
  }
  openStream(G.S.id, 0);
}

/** 渲染合并：一个 tick 内的多条事件只画一次。render 是 G 的幂等投影，晚 16ms
 *  画丢不了任何状态。 */
let renderQueued = false;
function scheduleRender(){
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 16);
}

/** 状态刷新合并：静默 400ms 后拉**一次** /state；拉的期间又有事件到，就在
 *  拉完后补一次（latest-wins）。绝不并发拉 —— /state 有几 MB，叠着拉是自噎。 */
let stateTimer: ReturnType<typeof setTimeout> | null = null;
let stateInFlight = false;
let stateDirty = false;
function scheduleStateRefresh(){
  if (stateInFlight) { stateDirty = true; return; }
  if (stateTimer !== null) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    stateInFlight = true;
    void fetch(`${API}/api/sessions/${G.S.id}/state`).then(r=>r.json()).then((st: any) => {
      mergeStateSnapshot(st);
      G.S.files = (st.filelist || []).length; loadQuestions(); render(); paint();
    }).catch(() => { /* 状态刷新失败不应打断 SSE 归约；下一个事件或手动刷新会重试。 */ })
      .finally(() => {
        stateInFlight = false;
        if (stateDirty) { stateDirty = false; scheduleStateRefresh(); }
      });
  }, 400);
}
