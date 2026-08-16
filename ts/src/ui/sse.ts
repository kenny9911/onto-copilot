// 事件流（EventSource）。断线重连总是 ?since=0，重放的处理写在下面。
import { G, OPS_CAP, QUOTA_KINDS, TBL_OPEN } from "./state.js";
import { API } from "./dom.js";
import { evLabel, evDetail, evTag } from "./events.js";
import { noteQuota, clearQuota } from "./quota.js";
import { applySessionTitle } from "./sessions.js";
import { loadQuestions } from "./questions.js";
import { mergeStateSnapshot, addTurn, stopThinking } from "./chat.js";
import { render } from "./render.js";
import { paint } from "./preview.js";

// ── 事件流 ──────────────────────────────────────────────────────
export function connect(){
  if (G.ES) G.ES.close();
  if (!G.S) return;
  G.ES = new EventSource(`${API}/api/sessions/${G.S.id}/stream?since=0`);
  G.ES.onmessage = (e: any) => {
    const ev = JSON.parse(e.data);
    // 服务端从头重放前先发这一条。EventSource 掉线会自动重连（服务重启、部署、
    // 网络抖一下都会），而重连总是 ?since=0；不清空的话新旧两轮的 seq 会交叠，
    // 同一张表画两遍，其中一份的导出按钮指向一个已经不存在的 seq。
    if (ev.kind === "stream.reset") { G.S.events = []; G.OPS = []; TBL_OPEN.clear(); return; }
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
      const KROW: Record<string, (x: any) => any> = {
        "kernel.thought":     (x: any) => ({thought: x.detail}),
        "kernel.plan":        (x: any) => ({thought: "计划：" + (x.detail || "")}),
        "kernel.observation": (x: any) => ({tool: x.node || "查证", observation: x.detail}),
        "kernel.critic":      (x: any) => ({observation: "审查：" + (x.detail || "")}),
        "kernel.node_failed": (x: any) => ({observation: `${x.node || ""} 失败：${x.detail || ""}`}),
        "kernel.degraded":    (x: any) => ({observation: "降级：" + (x.detail || "")}),
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
    if (["corpus.ready","corpus.restored","parse.failed","run.completed","run.failed","run.suspended","run.cancelled","artifact.ready","human.recorded","question.updated","question.answered","audit.applied"].includes(ev.kind))
      void fetch(`${API}/api/sessions/${G.S.id}/state`).then(r=>r.json()).then((st: any) => {
        mergeStateSnapshot(st);
        G.S.files = (st.filelist || []).length; loadQuestions(); render(); paint();
      }).catch(() => { /* 状态刷新失败不应打断 SSE 归约；下一个事件或手动刷新会重试。 */ });
    render();
  };
}
