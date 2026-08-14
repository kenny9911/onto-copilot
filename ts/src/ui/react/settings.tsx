// 设置面板：tab 条 + 正文（外观 / 用量 / 网关）。
// 动作与判据全在 ../settings.ts，这里只画。
//
// 类名与结构逐字对着旧的模板字符串搬：`.stab` `.stab.on` `.sgrp` `.slabel`
// `.schoice` `.act` `.act.pri` `.swatch` `.swatch.on` `.field` `.input`
// `.cap` `.fnd` `.stats` `.stat` `.ubars` `.ubar` `.ubar.tight` `.uaxis`
// `.envtbl` `.envrow` `.envname` `.envval` `.ushare` `.unum` `.badge`
// `.badge.warn` `.badge.danger` `.saverow` `.err` —— 767 行 CSS 认的就是这些。
//
// 网关表单里那几个 id 保留：saveConfig 仍按 id 读它们，所以它们必须是**非受控**
// 输入框（给了 value 就变成受控，用户敲的字会被下一次渲染抹掉）。它们的「重置」
// 由 CFG.seq 那个 key 负责，见 settings.ts 的注释。

import type { ReactElement, ReactNode } from "react";

import { fmtWhen, nfmt } from "../dom.js";
import { t } from "../i18n.js";
import { ACCENTS, accentName, effectiveDark } from "../appearance.js";
import {
  CFG, SETB, balanceLine, resetAccent, saveConfig, setAccent, setDensity,
  setFontScale, setTheme, setTz, setUsageDays, switchSetTab, toggleUsageRows,
} from "../settings.js";
import { registerRegion } from "./app.js";
import { useUi } from "./store.js";

// ── tab 条 ────────────────────────────────────────────────────────
export function SettingsTabs(): ReactElement {
  const G = useUi();
  const isAdmin = G.CURRENT_USER && G.CURRENT_USER.role === "admin";
  const tab = (k: string, label: string): ReactElement => (
    <button className={"stab " + (G.SET_TAB === k ? "on" : "")}
      onClick={() => switchSetTab(k)}>{label}</button>
  );
  return (
    <>
      {tab("appearance", t("appearance.title"))}
      {tab("usage", t("usage.title"))}
      {isAdmin ? tab("system", t("settings.gateway")) : null}
    </>
  );
}

// ── 外观 ─────────────────────────────────────────────────────────
const TZS = ["", "Asia/Shanghai", "Asia/Tokyo", "UTC", "America/New_York", "Europe/London"];

export function AppearanceTab(): ReactElement {
  useUi();                     // 切语言、换主题都要重画
  const theme = localStorage.getItem("oc_theme") || "system";
  // 原始值和兜底值分开：**"没选过"要能和"手动选了 green"区分开**，否则默认态下
  // green 会被画成选中，用户看着像已经选了一个颜色，也就没法表达"我要回默认"。
  const accentPick = localStorage.getItem("oc_accent");
  const fs = localStorage.getItem("oc_fontscale") || "m";
  const density = localStorage.getItem("oc_density") || "comfortable";
  const tz = localStorage.getItem("oc_tz") || "";
  const dark = effectiveDark();
  return (
    <>
      <div className="sgrp">
        <div className="slabel">{t("appearance.theme")}</div>
        <div className="schoice">
          {(["system", "light", "dark"] as const).map((v) => (
            <button key={v} className={"act " + (theme === v ? "pri" : "")}
              onClick={() => setTheme(v)}>{t("appearance.theme." + v)}</button>
          ))}
        </div>
      </div>
      <div className="sgrp">
        <div className="slabel">{t("appearance.accent")}</div>
        <div className="schoice">
          <button className={"act " + (!accentPick ? "pri" : "")}
            onClick={() => resetAccent()}>{t("appearance.accent.default")}</button>
          {Object.keys(ACCENTS).map((k) => (
            <button key={k} className={"swatch " + (accentPick === k ? "on" : "")}
              title={accentName(k)} aria-label={accentName(k)}
              style={{ background: dark ? ACCENTS[k]!.dark : ACCENTS[k]!.light }}
              onClick={() => setAccent(k)}></button>
          ))}
        </div>
      </div>
      <div className="sgrp">
        <div className="slabel">{t("appearance.font")}</div>
        <div className="schoice">
          {(["s", "m", "l"] as const).map((v) => (
            <button key={v} className={"act " + (fs === v ? "pri" : "")}
              onClick={() => setFontScale(v)}>{t("appearance.font." + v)}</button>
          ))}
        </div>
      </div>
      <div className="sgrp">
        <div className="slabel">{t("appearance.density")}</div>
        <div className="schoice">
          {(["comfortable", "compact"] as const).map((v) => (
            <button key={v} className={"act " + (density === v ? "pri" : "")}
              onClick={() => setDensity(v)}>{t("appearance.density." + v)}</button>
          ))}
        </div>
      </div>
      <div className="sgrp">
        <div className="slabel">{t("appearance.timezone")}</div>
        <select className="input" id="tzSel" value={tz} onChange={(e) => setTz(e.target.value)}>
          {TZS.map((v) => (
            <option key={v} value={v}>{v === "" ? t("appearance.timezone.browser") : v}</option>
          ))}
        </select>
      </div>
    </>
  );
}

// ── 用量 ─────────────────────────────────────────────────────────
// 按时间的消耗曲线。**手搓 div 柱子，不引任何图表库** —— 引一套图表库进这个页面
// 意味着单文件产物再涨一截，而这里要的只是「哪天花得多」。
// 颜色一律走 var(--accent)（CSS 里）：applyAppearance() 会在运行时把 --accent 改写成
// 用户选的强调色，写死十六进制的话换主题就脱节，深色模式下还会瞎。
export function UsageChart({ series }: { series: any[] }): ReactElement {
  const max = Math.max(1, ...series.map((b: any) => b.tokens));
  const wide = series.length > 40;      // 太密就不画间隙，否则柱子比缝还细
  return (
    <>
      <div className="ubars">{series.map((b: any, i: number) => {
        const h = Math.round((b.tokens / max) * 100);
        const lbl = `${b.t} · ${nfmt(b.tokens)} tok · ${b.calls} ${t("usage.callsUnit")}`;
        return (
          <div key={i} className={"ubar" + (wide ? " tight" : "")} title={lbl}>
            <i style={{ height: (b.tokens ? Math.max(h, 2) : 0) + "%" }}></i>
          </div>
        );
      })}</div>
      <div className="uaxis">
        <span>{series[0] ? series[0].t : ""}</span>
        <span>{t("usage.peak", "", { n: nfmt(max) })}</span>
        <span>{series.length ? series[series.length - 1]!.t : ""}</span>
      </div>
    </>
  );
}

const RANGES: Array<[number, string]> = [[1, "usage.d1"], [7, "usage.d7"], [30, "usage.d30"], [90, "usage.d90"]];

export function UsageTab(): ReactElement | null {
  const G = useUi();
  const u = G.USAGE;
  if (!u) return null;
  const tot = u.total || {};
  const rows = u.rows || [];
  return (
    <>
      <div className="sgrp">
        <div className="slabel">{t("usage.range")}</div>
        <div className="schoice">{RANGES.map(([d, k]) => (
          <button key={d} className={"act " + (G.USAGE_DAYS === d ? "pri" : "")}
            onClick={() => setUsageDays(d)}>{t(k)}</button>
        ))}</div>
      </div>

      <div className="stats">
        <div className="stat"><b className="v">{nfmt(tot.tokens)}</b><span className="l">{t("usage.tokens")}</span></div>
        <div className="stat"><b className="v">{nfmt(tot.calls)}</b><span className="l">{t("usage.calls")}</span></div>
        <div className="stat"><b className="v">{nfmt(tot.tok_in)}</b><span className="l">{t("usage.tokIn")}</span></div>
        <div className="stat"><b className="v">{nfmt(tot.tok_out)}</b><span className="l">{t("usage.tokOut")}</span></div>
      </div>
      {tot.failed ? <div className="cap">{t("usage.failed", "", { n: tot.failed })}</div> : null}

      <div className="sgrp" style={{ marginTop: "16px" }}>
        <div className="slabel">{t("usage.trend")}</div>
        {tot.calls ? <UsageChart series={u.series || []} />
                   : <div className="fnd">{t("usage.empty")}</div>}
      </div>

      {(u.by_model || []).length ? (
        <div className="sgrp">
          <div className="slabel">{t("usage.byModel")}</div>
          <div className="envtbl">{u.by_model.map((m: any, i: number) => {
            const pct = tot.tokens ? Math.round(m.tokens / tot.tokens * 100) : 0;
            return (
              <div className="envrow" key={i}>
                <b>{m.name}</b>
                <span className="ushare"><i style={{ width: pct + "%" }}></i></span>
                <span className="unum">{nfmt(m.tokens)}</span>
                <span className="badge">{pct}%</span>
                <span className="badge">{m.calls} {t("usage.callsUnit")}</span>
              </div>
            );
          })}</div>
        </div>
      ) : null}

      {(u.by_kind || []).length ? (
        <div className="sgrp">
          <div className="slabel">{t("usage.byKind")}</div>
          <div className="envtbl">{u.by_kind.map((k: any, i: number) => (
            <div className="envrow" key={i}>
              <b>{t("usage.kind." + k.name, k.name)}</b>
              <span className="unum">{nfmt(k.tokens)}</span>
              <span className="badge">{k.calls} {t("usage.callsUnit")}</span>
            </div>
          ))}</div>
        </div>
      ) : null}

      {/* 金额：**只认网关回的真实账单**。本地价目表对经网关发现的模型是统一编的，
          拿它算出来的钱看着精确其实是错的 —— 显示一个假的金额比不显示更糟。 */}
      {u.cost_note === "none" ? null : (
        <div className="sgrp">
          <div className="slabel">{t("usage.cost")}</div>
          <div className="envtbl"><div className="envrow">
            <b>${(tot.usd_billed || 0).toFixed(4)}</b>
            <span>{t(u.cost_note === "billed" ? "usage.costAll" : "usage.costPartial",
              "", { n: tot.billed_calls, total: tot.calls })}</span>
          </div></div>
        </div>
      )}

      {rows.length ? (
        <div className="sgrp">
          <div className="slabel">{t("usage.detail")}</div>
          <div className="envtbl">{(G.USAGE_ROWS_OPEN ? rows : rows.slice(0, 8)).map((r: any, i: number) => (
            <div className="envrow" key={i}>
              <b>{fmtWhen(r.ts)}</b>
              <span>{r.model}</span>
              <span className="unum">{nfmt(r.tokens)}</span>
              {r.attempts > 1 ? <span className="badge warn">{r.attempts}×</span> : null}
              {r.status !== "ok" ? <span className="badge danger">{t("usage.failedTag")}</span> : null}
            </div>
          ))}</div>
          {rows.length > 8 ? (
            <button className="act" style={{ marginTop: "6px" }} onClick={() => toggleUsageRows()}
            >{G.USAGE_ROWS_OPEN ? t("table.collapse") : t("table.expand", "", { n: rows.length })}</button>
          ) : null}
          {u.truncated ? <div className="cap">{t("usage.truncated")}</div> : null}
        </div>
      ) : null}
    </>
  );
}

// ── 网关 / 模型 / 预算 / 环境变量 ─────────────────────────────────
function TierField({ tk, tiers, catalog }: { tk: string; tiers: any; catalog: any[] }): ReactElement {
  const cur = tiers[tk] || {};
  const tierLabel = "settings.tier" + tk.charAt(0).toUpperCase() + tk.slice(1);
  return (
    <div className="field">
      <label>{t(tierLabel)}</label>
      <select className="input" id={"tier_" + tk} defaultValue={cur.model || ""}>
        <option value="">{t("settings.default")}</option>
        {catalog.map((m: any, i: number) => (
          <option key={i} value={m.name}>
            {m.name}{m.vendor ? " · " + m.vendor : ""}{m.quality ? "/" + m.quality : ""}
          </option>
        ))}
      </select>
      <span className="cap">{cur.effort || ""}{cur.overridden
        ? <span className="badge warn">{t("settings.overridden")}</span>
        : <span className="badge">{t("settings.default")}</span>}</span>
    </div>
  );
}

export function ConfigForm(): ReactElement {
  const G = useUi();
  const c = G.CONFIG || {};
  const gw = c.gateway || {};
  const tiers = c.tiers || {};
  const catalog = c.catalog || [];
  const budget = c.budget || {};
  const env = c.env || [];
  return (
    <>
      <div className="sgrp"><div className="slabel">{t("settings.gateway")}</div>
        {gw.insecure ? <div className="badge danger">{t("settings.insecure")}</div> : null}
        <div className="field"><label>{t("settings.baseUrl")}</label>
          <input className="input" id="cfgBaseUrl" defaultValue={gw.base_url || ""} /></div>
        <div className="field"><label>{t("settings.apiKey")}</label>
          <input className="input" id="cfgApiKey" type="password" placeholder={gw.api_key || ""} />
          <span className="cap">{t("settings.apiKeyHint")}</span></div>
      </div>
      <div className="sgrp"><div className="slabel">{t("settings.models")}</div>
        {["low", "medium", "high", "critical"].map((tk) => (
          <TierField key={tk} tk={tk} tiers={tiers} catalog={catalog} />
        ))}
      </div>
      <div className="sgrp"><div className="slabel">{t("settings.budget")}</div>
        <div className="field"><label>{t("settings.usdCap")}</label>
          <input className="input" id="cfgUsdCap" type="number" step="0.01" defaultValue={budget.usd_cap ?? ""} /></div>
        <div className="field"><label>{t("settings.chatUsdCap")}</label>
          <input className="input" id="cfgChatUsdCap" type="number" step="0.01" defaultValue={budget.chat_usd_cap ?? ""} /></div>
        {/* 余额要挨着「上限」一起看才有意义：一个是网关还剩多少，一个是我们自己
            允许花多少，分开两屏就没人对得上。 */}
        <div className="field"><label>{t("balance.label")}</label>
          <span className="cap">{balanceLine(c.balance)}</span></div>
      </div>
      <div className="sgrp"><div className="slabel">{t("settings.env")}</div>
        <div className="envtbl">{env.map((e: any, i: number) => (
          <div className="envrow" key={i}>
            <span className="envname">{e.name}</span>
            <span className="envval">{e.set ? (e.value ?? "") : "—"}</span>
            {e.secret ? <span className="badge">{t("settings.secret")}</span> : null}
            {e.restart ? <span className="badge warn">{t("settings.restartRequired")}</span> : null}
          </div>
        ))}</div>
      </div>
      <div className="saverow">
        <span className="err" id="cfgErr" style={{ display: CFG.err ? "block" : "none" }}>{CFG.err}</span>
        <span className="cap" id="cfgSaved" style={{ display: CFG.saved ? "inline" : "none" }}>{t("settings.saved")}</span>
        <button className="act pri" onClick={() => saveConfig()}>{t("settings.save")}</button>
      </div>
    </>
  );
}

// ── 正文：选中哪个 tab 就画哪个 ───────────────────────────────────
export function SettingsBody(): ReactNode {
  const G = useUi();
  const isAdmin = G.CURRENT_USER && G.CURRENT_USER.role === "admin";
  if (SETB.error) return <div className="fnd">{SETB.error}</div>;
  if (SETB.loading) return <div className="cap">{SETB.loading}</div>;
  if (G.SET_TAB === "system" && isAdmin) return <ConfigForm key={CFG.seq} />;
  if (G.SET_TAB === "usage") return <UsageTab />;
  return <AppearanceTab />;
}

registerRegion("setTabs", SettingsTabs);
registerRegion("setBody", SettingsBody);
