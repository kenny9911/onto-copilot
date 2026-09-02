// 聊天流的四块：气泡 / 推理卡 / 「正在思考」占位 / 推荐问题 chips。
//
// 对应 chat.ts 里的 bubble() / stepsCard() / thinkingBubble()，以及 render.ts 中栏
// 那一段 chips 的模板字符串。**类名与结构逐字对齐旧字符串** —— 767 行 CSS 认的是
// `.bub.me` `.bub.oc` `.body` `.itag.low` `.mdbody` `.steps` `.stp` `.stt` `.sto`
// `.stb` `.dots` `.tsec` `.pchips` `.pchip` 这些选择器，少一个类名就是少一块样式。
//
// ## 这一层不碰的东西
//
// 状态归约（addTurn / mergeStateSnapshot / turnKey）、发送与停止（sendChat /
// stopChat / stopRun）、打字机（startStream）全部留在 chat.ts —— 它们一行都不碰
// DOM，React 化不该动它们，它们那 27 条测试也就一条都不用改。
//
// ## chips 的两条规矩写在组件里，不写在调用方
//
// 「这一轮还在路上就不画」和「追问为空退回开场那批」是**同一处判断的两半**，
// 拆到调用方去写，迟早有一个调用点只抄了一半：
//   · 只抄前半 → 停止/出错那一刻 chips 全没了，聊天窗口一条出口都不剩；
//   · 只抄后半 → 答案由 SSE 先上屏、chips 跟着 HTTP 响应才到，中间那几十毫秒
//     里上一轮的提示会在输入框正上方闪一下再被换掉，整块跳一跳。
// 所以 <ChatChips> 自己读 G，自己决定画不画。调用方只管把它放进消息流。

import { useId, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";

import { prefillComposer } from "../context-sync.js";
import { t } from "../i18n.js";
import { Markdown } from "./markdown.js";
import { useUi } from "./store.js";

/**
 * Markdown 里的来源编号由安全的 data-source-id 与紧随回答的来源卡对齐。事件代理让
 * dangerouslySetInnerHTML 里生成的链接仍可用键盘/鼠标激活，又不用给不可信内容绑
 * 行内处理器。相同 URL 在历史轮次里可能重复，所以从当前回答向后找，不能全局按 id 找。
 */
function revealWebCitation(event: MouseEvent<HTMLDivElement>): void {
  // 这个工程的 server/client 共用 tsconfig，没有全量 DOM lib；运行时仍只做标准 DOM
  // 鸭子类型判断，测试环境和浏览器都支持 closest/querySelectorAll。
  const eventTarget = event.target as any;
  const origin = eventTarget?.closest
    ? eventTarget.closest("a.web-citation-link[data-source-id]") as any
    : null;
  const sourceId = origin?.dataset.sourceId || "";
  if (!origin || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(sourceId)) return;

  const focusSource = (container: any): boolean => {
    const target = Array.from(container.querySelectorAll(".web-source-article[data-source-id]") as any[])
      .find((item: any) => item.dataset.sourceId === sourceId) as any;
    if (!target) return false;
    target.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    target.focus?.({ preventScroll: true });
    return true;
  };

  let collapsedCard: any = null;
  let sibling: any = (event.currentTarget as any).parentElement?.nextElementSibling ?? null;
  while (sibling && !sibling.classList.contains("bub")) {
    if (focusSource(sibling)) {
      event.preventDefault();
      return;
    }
    if (!collapsedCard && sibling.classList.contains("web-sources-card")
        && sibling.querySelector('.web-source-toggle[aria-expanded="false"]')) collapsedCard = sibling;
    sibling = sibling.nextElementSibling;
  }

  // 引用可能指向默认折叠的第 4/5 条。先展开本回答后面的那张来源卡，再在 React
  // 提交新列表后定位；用户不必猜“先展开，再回来点一次编号”。
  const toggle = collapsedCard?.querySelector('.web-source-toggle[aria-expanded="false"]') as any;
  if (toggle) {
    event.preventDefault();
    toggle.click();
    setTimeout(() => { focusSource(collapsedCard); }, 0);
  }
}

/**
 * 对话气泡。与推理轨迹卡片刻意用不同的视觉语言 ——
 * 轨迹是「系统在做事」，气泡是「人在说话」。
 *
 * 用户那半边是**纯文本**：JSX 的文本节点由 React 转义，旧代码里那句 esc(txt) 不
 * 但多余，还会把 `<` 变成界面上看得见的 `&lt;`。助手那半边走 markdown，
 * 那是 React 下唯一还能被打穿的地方（见 markdown.tsx）。
 */
export function Bubble({ turn }: { turn: any }): ReactElement {
  const G = useUi();
  const me = turn.speaker === "user";
  let txt: string = turn.text || "";
  // 正在流式的那条助手消息按当前进度截断（判据与旧 bubble() 一致）。
  // **这就是打字机的全部呈现逻辑** —— startStream 每一帧只推进 G.STREAM.i 然后
  // 通知重画，不再往 DOM 里直写；那根光标同理，揭示完（i 到全长）就收起来。
  const streaming = !me && !!G.STREAM && txt === G.STREAM.full;
  if (streaming) txt = G.STREAM.full.slice(0, G.STREAM.i);
  return (
    <div className={"bub " + (me ? "me" : "oc")}>
      <div className="body" onClick={me ? undefined : revealWebCitation}
        {...(turn.pending ? { style: { opacity: .55 } } : {})}>
        {me ? txt : <>
          {turn.intent
            ? <span className={"itag" + ((turn.confidence ?? 1) < 0.6 ? " low" : "")}>{turn.intent}</span>
            : null}
          <Markdown text={txt} cursor={streaming && G.STREAM.i < G.STREAM.full.length} />
        </>}
      </div>
    </div>
  );
}

const SENSITIVE_KEY = /(?:pass(?:word|wd)?|pwd|token|api[_. -]?key|authorization|cookie|secret|credential|client[_. -]?secret)/iu;
const INLINE_SECRET = /((?:pass(?:word|wd)?|pwd|access[_. -]?token|refresh[_. -]?token|api[_. -]?key|authorization|cookie|secret|credential|client[_. -]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const AUTH_SECRET = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const FIELD_TEXT_LIMIT = 12_000;
const DISCLOSURE_TEXT_LIMIT = 48_000;

function redactText(value: unknown): string {
  return String(value ?? "")
    .replace(AUTH_SECRET, (_all, kind: string) => `${kind} ${t("reasoning.redacted")}`)
    .replace(INLINE_SECRET, (_all, prefix: string) => `${prefix}${t("reasoning.redacted")}`);
}

/** 深度、节点数都有上限：恶意工具结果不能靠一个巨型对象在「脱敏」阶段冻住 UI。 */
function redactStructured(value: unknown, seen = new WeakSet<object>(), budget = { nodes: 2_000 }, depth = 0): unknown {
  if (budget.nodes-- <= 0 || depth > 12) return t("reasoning.truncated");
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactStructured(item, seen, budget, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    out[key] = SENSITIVE_KEY.test(key) ? t("reasoning.redacted") : redactStructured(item, seen, budget, depth + 1);
  }
  return out;
}

function jsonText(value: unknown): string {
  try { return JSON.stringify(redactStructured(value ?? {})); }
  catch { return redactText(value); }
}

function boundedText(value: unknown, remaining: { chars: number }, fieldLimit = FIELD_TEXT_LIMIT): string {
  const clean = value !== null && typeof value === "object" ? jsonText(value) : redactText(value);
  const limit = Math.max(0, Math.min(fieldLimit, remaining.chars));
  remaining.chars -= Math.min(clean.length, limit);
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit) + t("reasoning.truncated");
}

/**
 * 展开区里的完整步骤。结果不再只留 240 字；容器自己滚动，用户点开后才能核对
 * Harness 想了什么、调用了哪个工具、工具返回了什么。为防巨大/恶意结果拖垮 DOM，
 * 单字段与整块各有明确上限，且敏感字段先脱敏。所有内容仍是 JSX 文本节点。
 */
function StepRows({ steps }: { steps: any[] }): ReactElement {
  if (!steps.length) return <div className="reasoning-empty">{t("reasoning.preparing")}</div>;
  const remaining = { chars: DISCLOSURE_TEXT_LIMIT };
  return <div className="reasoning-step-list">
    {steps.slice().sort((a: any, b: any) => (+a?.n || 0) - (+b?.n || 0)).map((x: any, i: number) => {
      const thought = x?.thought ? boundedText(x.thought, remaining) : "";
      const tool = x?.tool ? boundedText(x.tool, remaining, 240) : "";
      const args = tool ? boundedText(jsonText(x.args), remaining) : "";
      const observation = x?.observation !== undefined && x?.observation !== null && String(x.observation) !== ""
        ? boundedText(x.observation, remaining) : "";
      return <div className="stp" key={`${String(x?.turn ?? "")}:${String(x?.n ?? i)}`}>
        <div className="reasoning-step-head">
          <span className="reasoning-step-number" aria-hidden="true">{String(x?.n ?? i + 1).padStart(2, "0")}</span>
          {thought ? <div className="stt">{thought}</div> : null}
        </div>
        {tool ? <div className="sto"><code>{tool}</code>{" "}{args}</div> : null}
        {observation ? <div className="stb">{observation}</div> : null}
      </div>;
    })}
  </div>;
}

interface ReasoningDisclosureProps {
  steps: any[];
  running: boolean;
  status?: string;
  question?: string;
  className?: string;
}

/** 原生 details 保留 Enter/Space、读屏语义和浏览器自己的展开状态。 */
function ReasoningDisclosure({ steps, running, status, question, className = "" }: ReasoningDisclosureProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const label = running ? (status || t("reasoning.thinking")) : t("reasoning.completed");
  const toggleLabel = t(running ? "reasoning.toggleRunning" : "reasoning.toggleCompleted");
  return (
    <details className={`reasoning-disclosure ${running ? "is-running" : "is-complete"} ${className}`.trim()}
      aria-busy={running} onToggle={(event: any) => setExpanded(!!event.currentTarget.open)}>
      <summary className="reasoning-summary" aria-expanded={expanded} aria-controls={detailId}
        aria-label={question ? `${toggleLabel}：${question}` : toggleLabel} title={toggleLabel}>
        {running ? <span className="dots" aria-hidden="true"><i></i><i></i><i></i></span>
          : <span className="reasoning-done" aria-hidden="true">✓</span>}
        <span className="reasoning-status">{label}</span>
        {running ? <span className="tsec" id="tsec" aria-hidden="true"></span>
          : <span className="reasoning-count">{t("reasoning.steps", "", { n: steps.length })}</span>}
        <span className="reasoning-chevron" aria-hidden="true"></span>
      </summary>
      <div className="reasoning-details" id={detailId} role="region" aria-label={toggleLabel}>
        {expanded ? <StepRows steps={steps} /> : null}
      </div>
    </details>
  );
}

/** 已结束轮次仍保留在对话时间线里，但永远默认折叠。 */
export function StepsCard({ steps, question }: { steps?: any[]; question?: string } = {}): ReactElement {
  const G = useUi();
  return <ReasoningDisclosure steps={steps ?? G.STEPS} running={false} className="steps"
    {...(question === undefined ? {} : { question })} />;
}

function sourceRows(ev: any): any[] {
  return Array.isArray(ev?.results) ? ev.results : Array.isArray(ev?.sources) ? ev.sources : [];
}

/** 当前轮检索到的候选数；只给业务进度文案用，不把内部工具名漏到折叠摘要。 */
export function currentWebCandidateCount(state: any, activeTurnId = ""): number {
  if (!activeTurnId) return 0;
  const events = state?.events || [];
  const boundary = events.find((ev: any) =>
    ev?.kind === "chat.step" && String(ev?.step?.turn ?? "") === activeTurnId);
  if (!boundary) return 0;
  const boundarySeq = Number(boundary.seq);
  const boundaryTs = +boundary.ts || 0;
  const ids = new Set<string>();
  let declared = 0;
  for (const ev of events) {
    if (ev?.kind !== "web.sources") continue;
    const afterBoundary = Number.isSafeInteger(boundarySeq) && Number.isSafeInteger(Number(ev.seq))
      ? Number(ev.seq) > boundarySeq : (+ev.ts || 0) >= boundaryTs;
    if (!afterBoundary) continue;
    const n = Number(ev?.total);
    if (Number.isSafeInteger(n) && n >= 0) declared = Math.max(declared, n);
    sourceRows(ev).forEach((row: any, i: number) => {
      const id = String(row?.source_id ?? row?.id ?? row?.url ?? `${ev?.seq ?? "ev"}:${i}`).trim();
      if (id) ids.add(id);
    });
  }
  return Math.max(ids.size, declared);
}

/** 运行摘要只说业务动作；真实 tool/args/observation 留在用户主动展开的区域。 */
export function currentReasoningStatus(state: any, steps: any[]): string {
  const activeTurnId = String(steps[0]?.turn ?? "");
  const candidates = currentWebCandidateCount(state, activeTurnId);
  if (candidates > 0) return t("reasoning.screeningWeb", "", { n: candidates });
  const tool = String(steps[steps.length - 1]?.tool ?? "").toLowerCase();
  if (/^(web\.|browser\.)|web[._-]?(search|read)/u.test(tool)) return t("reasoning.searchingWeb");
  if (/(evidence|corpus|document|material|file)[._-]?(search|read|list)?/u.test(tool)) return t("reasoning.readingMaterials");
  if (/^(oir|flow|ontology|model)[._-]/u.test(tool)) return t("reasoning.checkingModel");
  return t("reasoning.thinking");
}

/**
 * 正在思考。**必须在发出去的那一刻就出现**，不能等第一个 step 回来 ——
 * 推理循环的第一次模型调用要好几秒，这几秒里界面纹丝不动的话，
 * 用户会以为没发出去然后再点一次。
 *
 * 两个细节不能丢：
 *   · 外层的 `think` 类 —— 这颗气泡是**临时占位**，答案一到就被换掉。
 *     markNewBubbles 靠它把这颗排除在计数之外；不排除的话「思考中消失、答案出现」
 *     这一步净变化为零，于是整个界面上最该被看见的那条反而拿不到入场动画。
 *   · `id="tsec"` —— 秒数由 startThinking 的定时器每 500ms 直接写 textContent。
 *     那个计时器活在 chat.ts（状态层），不在这里；id 换掉它就再也找不到这个 span。
 */
export function ThinkingBubble(): ReactElement {
  const G = useUi();
  return (
    <div className="bub oc think">
      <ReasoningDisclosure steps={G.STEPS} running status={currentReasoningStatus(G.S, G.STEPS)}
        className="body think" />
    </div>
  );
}

export interface Chip {
  text: string;
  /** 点下去真正发出去的话。缺省就是 text 本身。 */
  send?: string;
}

/**
 * 一排推荐指令。**点一条 = 把它填进输入框，不发送。**
 *
 * 以前是点一下直接发出去。两个毛病叠在一起，结果是这排东西不敢点：
 *
 *   1. 文案是问句（「要导出成访谈提纲 excel 吗？」）—— 那是**该由副驾问用户的话**。
 *      点下去却以用户身份发出，等于他自己问自己，方向反了。文案的口径已经在
 *      `converse.ts` 的 next_questions 契约里改成陈述/祈使；副驾自己的疑问走
 *      `followup` 字段，两者不再混。
 *   2. 点即发，没有反悔余地。而这些是**猜**出来的话，猜错时用户要的是改一改
 *      再发，不是撤回一条已经发出去的消息。
 *
 * 所以现在统一填进输入框、光标落到末尾，发不发、改不改由他决定。**不做例外**：
 * 一部分点即发、一部分填输入框，用户就得记住哪个是哪个 —— 记不住的结果是两个
 * 都不敢点。
 *
 * `data-s` 保留着：旧写法是 `onclick="ask(this.dataset.s)"`，属性是那句话的**运输
 * 工具**；React 下参数直接就是值，属性已经不承担运输，但它是这批按钮在 DOM 上
 * 的身份标记（测试与将来的埋点都按它找），去掉等于改结构。
 */
export function Chips({ chips, center = false }: { chips: Chip[]; center?: boolean }): ReactElement | null {
  if (!chips.length) return null;
  return (
    <div className="pchips" {...(center ? { style: { justifyContent: "center" } } : {})}>
      {chips.map((c, i) => {
        const send = c.send || c.text;
        return <button className="pchip" key={i} data-s={send}
          title="填进输入框，可以改了再发"
          onClick={() => { prefillComposer(send, { mode: "replace", focusSidebar: false }); }}>{c.text}</button>;
      })}
    </div>
  );
}

/**
 * 聊天窗口里那一排 —— 见文件头「chips 的两条规矩」。
 *
 * 有追问就出追问，没有就退回开场那批。两者不同时出：提示的位置很贵，占一条就
 * 少一条真正有用的。**但不能两者都不出** —— 旧逻辑在聊过一句后会把 PROMPTS 直接
 * 清空，于是追问一旦为空（梳理刚跑完、材料刚传完、上一轮出错），聊天窗口就一条
 * 出口都没有，而服务端那时刚算好的一批开场提示正躺在 PROMPTS 里没人用。
 */
export function ChatChips(): ReactElement | null {
  const G = useUi();
  // CHAT_ABORT 非空 = 这一轮还在路上。
  if (G.THINKING || G.CHAT_ABORT) return null;
  return <Chips chips={G.FOLLOWUPS.length ? G.FOLLOWUPS : G.PROMPTS} />;
}

/**
 * 空状态那一排（居中）。空状态**也要带开场提示** —— 那正是最需要它的时候：
 * 一个还没上传任何材料的人，面对的正是一个空输入框。
 */
export function IntroChips(): ReactNode {
  const G = useUi();
  return <Chips chips={G.PROMPTS} center />;
}
