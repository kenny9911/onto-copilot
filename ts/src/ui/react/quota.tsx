// 额度提醒条的**样子**。判据与状态仍在 ../quota.ts（noteQuota / fmtAmount /
// paintQuotaBar），这里只负责把它画出来。
//
// 三种事件三种含义，**分清 S1 与 S3 是这一段的全部重点**：
//   quota.exhausted  网关账户真的没钱了 —— 得去网关充值（危险色）
//   quota.low        查得到余额且偏低 —— 提前告知，不阻断（警告色）
//   budget.capped    我们自己在设置里设的花费闸用满了 —— **网关没欠费**（警告色）
// 把 budget.capped 说成"余额不足"，用户会跑去给一个好端端的账户充值，
// 然后回来发现还是跑不动 —— 这是这个功能最容易造成的实际伤害。
//
// 类名与结构逐字对着旧的模板字符串搬：`.qbar` `.qbar.bad` `.qtxt` `.qraw`
// `.qact` `.qx` —— 767 行 CSS 认的就是这几个。

import { useLayoutEffect, type ReactElement } from "react";

import { t } from "../i18n.js";
import { dismissQuota, fmtAmount, quotaVisible } from "../quota.js";
import { openSettings } from "../settings.js";
import { registerRegion } from "./app.js";
import { useUi } from "./store.js";

/**
 * 宿主容器自己的 `class` 与 `hidden`。
 *
 * **portal 只管容器的孩子，容器本身 React 碰不到**，而旧代码把这两样写在容器上
 * （`el.className = "qbar bad"` / `el.hidden = true`）—— 而且 CSS 认的就是那个
 * 容器上的 `.qbar` / `.bad`。所以在 layout 阶段写回同一个容器的同两个属性。
 * 这不违反「一个容器只能有一个主人」：主人就是这个组件，没有第二处在写它。
 */
function useHostFlags(id: string, className: string, hidden: boolean): void {
  useLayoutEffect(() => {
    const host = typeof document === "undefined" ? null : document.getElementById(id);
    if (!host) return;
    host.className = className;
    host.hidden = hidden;
  });
}

export function QuotaBar(): ReactElement | null {
  const G = useUi();
  const on = quotaVisible();
  const q = G.QUOTA;
  const bad = on && q.kind === "quota.exhausted";
  // hook 不能写在 return 后面：没条子的时候也要把容器收回去（一条空的常驻条
  // 会把顶栏推下去）。
  useHostFlags("quotaBar", "qbar" + (bad ? " bad" : ""), !on);
  if (!on) return null;

  let head: string, hint: string;
  let act = false;
  if (bad) {
    head = t("quota.exhausted"); hint = t("quota.exhaustedHint");
  } else if (q.kind === "quota.low") {
    const amt = fmtAmount(q.amount, q.currency);
    head = amt ? t("quota.low", "", {v: amt}) : t("quota.lowGeneric");
    hint = t("quota.lowHint");
  } else {
    const cap = fmtAmount(q.cap, "USD");
    head = cap ? t("budget.cappedAmount", "", {v: cap}) : t("budget.capped");
    hint = t("budget.cappedHint");
    act = true;                 // 本地闸给的出口是真能解决这件事的那个地方
  }

  return (
    <>
      <div className="qtxt">
        <b>{head}</b>{" "}{hint}
        {q.detail ? <span className="qraw">{q.detail}</span> : null}
      </div>
      {act ? (
        <button className="qact" onClick={() => openSettings()}>{t("quota.openSettings")}</button>
      ) : null}
      {/* 余额不足没有「关掉」：关掉它也照样跑不动，只是把坏消息藏起来。
          它自己会在下一次调用成功时消失（clearQuota 的判据是**证据**）。 */}
      {bad ? null : (
        <button className="qx" title={t("quota.dismiss")} onClick={() => dismissQuota()}>×</button>
      )}
    </>
  );
}

registerRegion("quotaBar", QuotaBar);
