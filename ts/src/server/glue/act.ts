/**
 * `_act`（`server.py:6416`）与它的五个分支函数 —— 意图执行器。
 *
 * 每个分支都要回显**它到底做了什么**，不能只回"好的"：静默执行和静默丢弃，
 * 用户同样分辨不出来。
 *
 * ── 唯一的调用方是 `_drain_queue` ──────────────────────────────────────
 *
 * 梳理期间用户说的"把临时表排掉"会被排进 `s.state["_queued"]`，跑完由
 * `glue/compile.ts` 的 `drainQueue` 逐条执行 —— 就是这里。入队的时候我们对用户
 * 说了"本轮梳理跑完就执行"，不排干那句话就是谎话。
 *
 * ── 返回类型是 `string | dict`，这是原件的形状 ──────────────────────────
 *
 * `_act` 声明的是 `-> str`，但 `_outcome(...)` 分支返回的是 dict（`{kind, facts,
 * fallback}` —— 给措辞层的"事实 + 备用措辞"）。`_drain_queue` 随后
 * `"\n\n".join(done)` 会在 dict 上抛 TypeError。这条路在当前代码里**到不了**：
 * 全仓没有任何地方往 `s.state["_queued"]` 写过东西（`grep -rn _queued src/` 只有
 * 读的那一处）。照搬这个联合返回类型而不是把 dict 分支"修"成字符串 —— 一旦哪天
 * 有人接上入队那一侧，两边应该在同一个地方暴露同一个问题，而不是 TS 这边悄悄
 * 换了一种行为。分叉的确切形状记在 divergences 里。
 */

import { DecisionKind, type DialogueMemory } from "../../kernel/memory/dialogue.js";
import { Intent } from "../../kernel/intent.js";
import { formatFixed2 } from "../../kernel/gateway_balance.js";
import { cite, type OIR } from "../../onto/oir.js";
import { pyRound } from "../../onto/shape.js";
import { applySuggestion } from "../../onto/suggest.js";
import { cpSlice } from "../../onto/parse/base.js";
import { pyStr, pyTruthy } from "../pipeline/tables.js";
import type { Session } from "../session.js";
import { dialogueOf as memoryDialogueOf } from "../dialogue/memory.js";
import type { IntentMatchLike } from "./deps.js";
import { seam } from "./deps.js";

/** `_act` 的返回：一句话，或 {@link outcome} 那个"事实 + 备用措辞"的 dict。 */
export type ActResult = string | Record<string, unknown>;

/** `_outcome(kind, fallback, **facts)`（`server.py:6190`）。
 *  执行器的返回形态：**事实 + 备用措辞**，不是一句成品。 */
function outcome(
  kind: string,
  fallback: string,
  facts: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, facts, fallback };
}

/** `(s.state.get("oir") or {}).get("stats") or {}`。 */
function stats(s: Session): Record<string, unknown> {
  const oir = s.state["oir"];
  const st = pyTruthy(oir) ? (oir as Record<string, unknown>)["stats"] : undefined;
  return pyTruthy(st) ? (st as Record<string, unknown>) : {};
}

/** `(s.state.get("budget") or {}).get("spent") or {}`。 */
function spentOf(s: Session): Record<string, unknown> {
  const b = s.state["budget"];
  const sp = pyTruthy(b) ? (b as Record<string, unknown>)["spent"] : undefined;
  return pyTruthy(sp) ? (sp as Record<string, unknown>) : {};
}

/** `s.state.get(key) or []` 的长度。 */
function countOf(s: Session, key: string): number {
  const v = s.state[key];
  return pyTruthy(v) ? (v as unknown[]).length : 0;
}

function listOf(s: Session, key: string): Record<string, unknown>[] {
  const v = s.state[key];
  return pyTruthy(v) ? (v as Record<string, unknown>[]) : [];
}

/** `float(x or 0)`。 */
function pyFloatOr0(v: unknown): number {
  if (!pyTruthy(v)) return 0;
  return Number(v);
}

/** `_status_line`（`server.py:6491`）。 */
export function statusLine(s: Session): string {
  const st = stats(s);
  if (Object.keys(st).length === 0) {
    return `还没跑过梳理。当前 ${s.files.length} 份材料就绪。`;
  }
  const spent = spentOf(s);
  return (
    `已完成：${pyStr(st["objects"] ?? 0)} 个对象、${pyStr(st["properties"] ?? 0)} 个属性、` +
    `${pyStr(st["links"] ?? 0)} 条关系、${pyStr(st["actions"] ?? 0)} 个行动、` +
    `${pyStr(st["rules"] ?? 0)} 条业务规则。花了 $${formatFixed2(pyFloatOr0(spent["usd"] ?? 0))}。` +
    `还有 ${countOf(s, "questions")} 个待拍板、${countOf(s, "suggestions")} 条建议。`
  );
}

/**
 * `_do_scope`（`server.py:6503`）：纳入/排除。
 *
 * **落不到具体对象上就反问，绝不按模糊短语批量删。** 「把临时表都去掉」听起来
 * 很明确，但"临时表"这个词落到哪几个对象上只有材料知道 —— 猜错就是静默删掉
 * 用户要的东西，而他要到出模板的时候才发现。
 */
export function doScope(s: Session, slots: Record<string, unknown>): string {
  const oir = s.state["_oir"];
  const named = (pyTruthy(slots["named"]) ? (slots["named"] as unknown[]) : []).map(pyStr);
  const action = slots["action"] === undefined ? "exclude" : pyStr(slots["action"]);
  if (oir === null || oir === undefined) return "还没有产物可以调整范围，先跑一轮梳理。";
  if (named.length === 0) {
    // 挂到建议上：EXCLUDE 类建议的 payload 里已经有算好的对象清单
    const tech = listOf(s, "suggestions").find((x) => x["kind"] === "EXCLUDE") ?? null;
    if (tech !== null && action === "exclude") {
      const payload = (tech["payload"] as Record<string, unknown> | undefined) ?? {};
      const n = pyTruthy(payload["objects"]) ? (payload["objects"] as unknown[]).length : 0;
      return (
        `你是指那 ${n} 个疑似临时/日志表吗？（${pyStr(tech["title"])}）` +
        `说「采纳」我就按这份清单排除。`
      );
    }
    return "没听出具体是哪些对象。给个名字，或者引用某条建议。";
  }
  const dm = dialogueOf(s);
  const verb = action === "exclude" ? "排除" : "保留";
  dm.decide(DecisionKind.SCOPE, `${verb} ${named.join("、")}`, { scopeRefs: named });
  return `记下了：${verb} ${named.join("、")}。产物在下次编译模板时生效。`;
}

/** `_do_suggestion`（`server.py:6519`）：采纳/否决一条建议。 */
export function doSuggestion(s: Session, m: IntentMatchLike): ActResult {
  const sid = pyStr(m.slots["suggestion_id"] ?? "");
  const sug = listOf(s, "suggestions").find((x) => x["id"] === sid) ?? null;
  if (sug === null) return "这条建议已经不在列表里了。";
  const dm = dialogueOf(s);
  const adopt = m.intent === Intent.ADOPT_SUGGESTION;
  const title = pyStr(sug["title"]);
  dm.decide(DecisionKind.ADOPTION, `${adopt ? "采纳" : "否决"}：${title}`, { scopeRefs: [sid] });
  if (!adopt) return `好，不做「${title}」。`;
  const oir = s.state["_oir"];
  if (oir === null || oir === undefined) {
    return `记下了：采纳「${title}」。等跑完一轮梳理才有产物可以落。`;
  }
  const applied = applySuggestion(oir as OIR, sug, { note: `对话中采纳：${title}` });
  if (applied.changed.length === 0) {
    return `「${title}」这条没有可以自动执行的动作 —— 它需要你补材料或逐条选择，我不能替你做。`;
  }
  // 快照要跟着刷 —— 内存里的 OIR 已经变了，前端读的是 state["oir"]，
  // 不刷的话界面上纹丝不动，用户会以为采纳没生效。
  s.state["oir"] = (oir as OIR).toDict();
  s.emit("human.recorded", {
    conflict: sid,
    option: "adopt",
    label: applied.label,
    changed: applied.changed,
  });
  return outcome(
    "suggestion_applied",
    `已采纳「${title}」，实际改了 ${applied.changed.length} 项。说「重出模板」我就按新结果重编译。`,
    {
      建议: title,
      实际改动数: applied.changed.length,
      改动类型: applied.kind,
      产物是否已重编译: false,
      下一步: "说「重出模板」按新结果重编译",
    },
  );
}

/** `_do_explain`（`server.py:6562`）：解释某个判断。**只讲有据可查的**。 */
export function doExplain(s: Session, slots: Record<string, unknown>): string {
  const oir = s.state["_oir"] as OIR | null | undefined;
  const named = (pyTruthy(slots["named"]) ? (slots["named"] as unknown[]) : []).map(pyStr);
  if (oir === null || oir === undefined || named.length === 0) {
    return "指个具体对象或判断，我把依据和出处调出来。";
  }
  const out: string[] = [];
  for (const name of named.slice(0, 3)) {
    const ot = [...oir.objects.values()].find((o) => o.apiName.value === name) ?? null;
    if (ot === null) continue;
    const ev = ot.apiName.evidence;
    const c = ev.length > 0 ? cite(ev[0]!) : "无出处";
    const acts = [...oir.actions.values()]
      .filter((a) => a.appliesTo.includes(ot.rid))
      .map((a) => a.apiName.value);
    out.push(
      `${name}（${ot.displayName.value}）来自 ${c}` +
        (acts.length > 0
          ? `，挂了 ${acts.length} 个行动：${acts.slice(0, 4).join("、")}`
          : "，材料里没有给它定义任何字段或行动"),
    );
  }
  return out.join("\n") || "没找到这些对象。";
}

/** ①②③④⑤ / 1-5 / A-E —— 用户口述选项时的三种写法。 */
const CIRCLED = "①②③④⑤";
const LETTERS = "ABCDE";

/**
 * `_do_answer`（`server.py:6583`）：用文字回答一个澄清问题。
 *
 * **只回显选了什么，不替用户按确认。** 这一步改的是骨架 —— 让口述直接落库，
 * 一次听错就把本体改了，而用户以为自己只是在说话。
 */
export function doAnswer(s: Session, slots: Record<string, unknown>): string {
  const qid = slots["question_id"];
  const conflicts = pyTruthy(s.state["_conflicts"])
    ? (s.state["_conflicts"] as { rid: string }[])
    : [];
  const target = conflicts.find((c) => c.rid === qid) ?? null;
  if (target === null) return "对不上具体哪个问题，直接点问题卡片里的选项更稳。";
  const q =
    listOf(s, "questions").find((x) => x["conflict_rid"] === qid) ?? ({} as Record<string, unknown>);
  const opts = pyTruthy(q["options"]) ? (q["options"] as Record<string, unknown>[]) : [];
  const raw = pyStr(pyTruthy(slots["option"]) ? slots["option"] : "");
  let idx = [...CIRCLED].indexOf(raw);
  // `raw.isdigit()` 认 Unicode 十进制数字，`\p{Nd}` 是它的对等物；空串是 false。
  if (idx < 0 && raw !== "" && /^\p{Nd}+$/u.test(raw)) idx = Number(raw) - 1;
  // Python 的 `raw.upper() in "ABCDE"` 对**空串恒为真**（子串判定），然后
  // `"ABCDE".index("")` 是 0 —— 也就是说不给 option 时会选中第一项。这里照搬：
  // 上一行的数字分支已经把 idx 留在 -1，空串走到这里必须同样落到 0。
  const up = raw.toUpperCase();
  if (idx < 0 && LETTERS.includes(up)) idx = LETTERS.indexOf(up);
  if (!(idx >= 0 && idx < opts.length)) return `这个问题有 ${opts.length} 个选项，说个序号。`;
  const chosen = opts[idx]!;
  return (
    `你选的是「${pyStr(chosen["label"])}」。点一下问题卡片里的确认按钮生效 —— ` +
    `这一步改的是骨架，我不替你按。`
  );
}

/**
 * 执行一个意图。
 *
 * `deps` 只用到两样：`claimAndStartBuild`（START_BUILD）与 `recompile`（RERUN 的
 * 重出模板那一档）。它们都属于别的段，走 deps 而不是直接 import。
 */
export async function act(
  s: Session,
  m: IntentMatchLike,
  deps: ActDeps,
): Promise<ActResult> {
  const dm = dialogueOf(s);
  const slots = pyTruthy(m.slots) ? m.slots : {};

  if (m.intent === Intent.CHITCHAT) {
    // 寒暄本来就是对话，最没理由套模板 —— 「你好」回「在。」是这套东西
    // 在念稿子最刺眼的证据。
    const st = stats(s);
    return outcome("chitchat", s.files.length === 0 ? "在。" : statusLine(s), {
      材料份数: s.files.length,
      材料: s.files.map((f) => f.name).slice(0, 5),
      当前产物: Object.keys(st).length > 0 ? st : "还没跑过梳理",
      待拍板: countOf(s, "questions"),
      建议条数: countOf(s, "suggestions"),
    });
  }

  if (m.intent === Intent.ASK_STATUS) {
    const st = stats(s);
    const spent = spentOf(s);
    return outcome("status", statusLine(s), {
      产物: Object.keys(st).length > 0 ? st : "还没跑过梳理",
      材料份数: s.files.length,
      花费美元: pyRound(pyFloatOr0(spent["usd"] ?? 0), 2),
      待拍板: countOf(s, "questions"),
      建议: listOf(s, "suggestions")
        .map((x) => x["title"])
        .slice(0, 5),
    });
  }

  if (m.intent === Intent.ADD_CONTEXT) {
    dm.decide(DecisionKind.CORRECTION, cpSlice(pyStr(slots["content"] ?? ""), 0, 200));
    // 收作补充背景，进后续重抽的上下文。要直接改当前产物，走对话推理循环
    // （oir.add/flow.edit）—— 那条路把口述的事实落进 OIR/流程图并要用户确认。
    return (
      "收下了，作为补充背景，会进后续节点的上下文。想直接改当前产物" +
      "（补字段/加取值/连流程），直接说，我用结构化编辑改并请你确认。"
    );
  }

  if (m.intent === Intent.SET_CALIBER || m.intent === Intent.SET_NAMING) {
    const kind = m.intent === Intent.SET_CALIBER ? DecisionKind.CALIBER : DecisionKind.NAMING;
    const d = dm.decide(kind, pyStr(slots["statement"] ?? ""));
    const cn = kind === DecisionKind.CALIBER ? "口径" : "命名";
    return outcome(
      "decision_recorded",
      `记为${cn}约定：${d.statement}。后续每个抽取节点都会带上它；` +
        `要让它作用到已抽好的部分，说一声「重跑」。`,
      {
        记下的约定: d.statement,
        类型: cn,
        生效范围: "后续每个抽取节点；已抽好的部分要重跑才会应用",
        当前生效的约定数: dm.activeDecisions().length,
        已经跑过梳理: pyTruthy(s.state["_oir"]),
      },
    );
  }

  if (m.intent === Intent.SET_SCOPE) return doScope(s, slots);
  if (m.intent === Intent.ADOPT_SUGGESTION || m.intent === Intent.REJECT_SUGGESTION) {
    return doSuggestion(s, m);
  }
  if (m.intent === Intent.EXPLAIN) return doExplain(s, slots);
  if (m.intent === Intent.ANSWER_QUESTION) return doAnswer(s, slots);

  if (m.intent === Intent.START_BUILD) {
    const res = await deps.claimAndStartBuild(s);
    if (res === "no_files") return "还没有材料。把文件拖进来，或者点 + 添加。";
    if (res === "missing") return "这个会话已经不存在了，请回到会话列表重新打开。";
    if (res === "awaiting_answer") {
      return "当前正在等业务回答。先回答、延期或导出问题清单，不能用新一轮覆盖待拍板状态。";
    }
    if (res !== "started") return "已经在跑了。";
    return `开始梳理 ${s.files.length} 份材料。过程我会一步步说。`;
  }

  if (m.intent === Intent.RERUN) {
    // 重出模板是**确定性重算**（对齐→冲突→自动修→澄清→编译），零模型调用。
    // 重抽材料才要重跑 DAG，那个贵得多，不能一句"重跑"就替用户花钱。
    const oir = s.state["_oir"];
    if (oir === null || oir === undefined) return "还没有产物。点「开始梳理」跑第一轮。";
    const phrase = pyStr(slots["phrase"] ?? "");
    if (["模板", "编译", "产物", "出表"].some((w) => phrase.includes(w))) {
      await deps.recompile(s);
      const tpl = (s.state["template"] as Record<string, unknown> | undefined) ?? {};
      return (
        `已按当前结果重出模板：${pyStr(tpl["sheets"])} 张表、${pyStr(tpl["prefilled"])} 格预填。`
      );
    }
    const usd = pyFloatOr0(spentOf(s)["usd"] ?? 0);
    return (
      `重抽材料要重跑整个 DAG，是要花钱的（上一轮 $${formatFixed2(usd)}）。` +
      "确定的话点「重新梳理」。只想按新决定重出模板的话，说「重出模板」。"
    );
  }

  return "";
}

/** {@link act} 用到的两个别段的能力。 */
export interface ActDeps {
  /** `_claim_and_start_build(s)`（段 D 的 `pipeline/run.ts`）。 */
  readonly claimAndStartBuild: (s: Session) => Promise<string>;
  /** `_recompile(s)`（`glue/compile.ts`）。 */
  readonly recompile: (s: Session) => Promise<void>;
}

/** `_dialogue(s)`（`server.py:4515`）—— 会话记忆，**没有就新建**。 */
function dialogueOf(s: Session): DialogueMemory {
  return memoryDialogueOf(seam(s));
}
