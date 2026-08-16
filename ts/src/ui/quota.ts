// 额度提醒条 —— **状态与判据**。条子长什么样在 react/quota.tsx。
//
// 这个文件里剩下的东西**没有一样碰 DOM**，React 化不该动它们（契约 §12 的分层）：
//   noteQuota / clearQuota   一条事件该不该竖起条子、什么时候该收回去
//   fmtAmount                一个数该怎么说出口（美元 / 人民币 / token 额度）
//   paintQuotaBar            换会话时把过期的本地闸清掉，然后通知界面重画
//   quotaVisible             此刻该不该摆出来（纯判断，组件每次渲染都问一次）
import { G, QUOTA_STALE_SEC } from "./state.js";
import { nfmt } from "./dom.js";
import { t } from "./i18n.js";
import { bumpUi } from "./react/store.js";

// ── 额度提醒条 ──────────────────────────────────────────────────
// 三种事件三种含义，**分清 S1 与 S3 是这一段的全部重点**：
//   quota.exhausted  网关账户真的没钱了 —— 得去网关充值（危险色）
//   quota.low        查得到余额且偏低 —— 提前告知，不阻断（警告色）
//   budget.capped    我们自己在设置里设的花费闸用满了 —— **网关没欠费**（警告色）
// 把 budget.capped 说成"余额不足"，用户会跑去给一个好端端的账户充值，
// 然后回来发现还是跑不动 —— 这是这个功能最容易造成的实际伤害。
// G.QUOTA / QUOTA_KINDS / QUOTA_STALE_SEC 三个声明**不在这里**，在文件顶上那批
// 全局旁边 —— applyI18n 在 init 同步段里就要读它们，放这儿会撞 TDZ。

export function noteQuota(ev: any){
  const rank = (k: any) => (k === "quota.exhausted" ? 2 : 1);
  const ts = +ev.ts || 0;
  if (ts && Date.now() / 1000 - ts > QUOTA_STALE_SEC) return;
  // 已经在喊"没钱了"的时候，别被一条 quota.low 降级成温和的黄条
  if (G.QUOTA && rank(G.QUOTA.kind) > rank(ev.kind)) return;
  G.QUOTA = {
    kind: ev.kind, ts,
    sid: G.S?.id || null,                       // budget.capped 是这一次运行的事
    detail: String(ev.detail ?? ev.error ?? ev.message ?? "").slice(0, 200),
    amount: ev.remaining ?? ev.balance?.remaining ?? null,
    currency: ev.currency ?? ev.balance?.currency ?? "USD",
    cap: ev.cap ?? ev.usd_cap ?? ev.limit ?? null,
  };
  paintQuotaBar();
}

// 清掉的判据是**证据**，不是时间：网关刚成功回了一次，就说明它有钱。
export function clearQuota(){ if (G.QUOTA) { G.QUOTA = null; paintQuotaBar(); } }

export function dismissQuota(){ clearQuota(); }

export function fmtAmount(v: any, cur: any){
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "";
  cur = String(cur || "USD").toUpperCase();
  if (cur === "USD") return "$" + n.toFixed(2);
  if (cur === "CNY" || cur === "RMB") return "¥" + n.toFixed(2);
  // New-API 那一类返回的是 token 额度，不是美元。换算不确定就**不假装是钱**。
  return t("balance.quotaUnit", "", {v: nfmt(n)});
}

/**
 * **本地闸只属于这一次运行**：换到别的会话还挂着它就是句错话（那个会话一分钱
 * 都还没花）。这一句是**改状态**，所以留在这里而不是搬进组件 —— 渲染期间改
 * 全局状态是 React 下最难查的一类 bug，而且 `paintQuotaBar()` 之后 `G.QUOTA`
 * 真的变成 null 这件事本身就是一条契约（换会话、切语言都靠它）。
 *
 * 函数名与全部调用点一个字没动（render.ts 换会话时、applyI18n 切语言时都调它），
 * 只是「把条子画出来」这一步换成了通知 React 重画。
 */
export function paintQuotaBar(){
  if (G.QUOTA && G.QUOTA.kind === "budget.capped" && G.QUOTA.sid && G.QUOTA.sid !== (G.S?.id || null))
    G.QUOTA = null;
  bumpUi();
}

/**
 * 此刻该不该把条子摆出来。**纯判断，不改任何东西** —— 组件每次渲染都问一次，
 * 于是「别的地方 bump 了一下，一条过期的本地闸趁机露出来」这种缝也堵上了。
 */
export function quotaVisible(): boolean {
  const q = G.QUOTA;
  if (!q) return false;
  if (q.kind === "budget.capped" && q.sid && q.sid !== (G.S?.id || null)) return false;
  return true;
}
