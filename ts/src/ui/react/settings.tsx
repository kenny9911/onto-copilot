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

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { fmtWhen, nfmt } from "../dom.js";
import { t } from "../i18n.js";
import { ACCENTS, accentName, effectiveDark } from "../appearance.js";
import {
  CFG, SETB, balanceLine, resetAccent, saveConfig, setAccent, setDensity,
  setFontScale, setTheme, setTz, setUsageDays, setUsageOwner, switchSetTab, toggleUsageRows,
} from "../settings.js";
import { registerRegion } from "./app.js";
import { LogsTab } from "./logs.js";
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
      {/* 日志对所有登录用户都开：普通用户看自己的，管理员看全部。
          可见范围在服务端 /api/logs/* 里判，前端不做任何过滤 —— 前端过滤
          等于把数据发下来再假装看不见。 */}
      {tab("logs", t("logs.title"))}
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

      {/* 按账号分账。**只有能看全部的人才有这一块** —— 普通用户被服务端钉死在
          自己账上，给他一张只有一行的分账表等于把 total 又说了一遍。
          点一行钻进那个账号，再点「全部账号」回来。 */}
      {u.can_see_all && (u.by_owner || []).length ? (
        <div className="sgrp">
          <div className="slabel">
            {t("usage.byOwner")}
            {u.owner_filter ? (
              <button className="act" style={{ marginLeft: "8px" }}
                onClick={() => setUsageOwner("")}>{t("usage.allOwners")}</button>
            ) : null}
          </div>
          <div className="envtbl">{u.by_owner.map((o: any, i: number) => {
            const pct = tot.tokens ? Math.round(o.tokens / tot.tokens * 100) : 0;
            const nm = (u.owner_names || {})[o.name] || (o.name ? o.name : t("usage.noOwner"));
            return (
              <div className="envrow" key={i} style={{ cursor: "pointer" }}
                onClick={() => setUsageOwner(o.name)}>
                <b>{nm}</b>
                <span className="ushare"><i style={{ width: pct + "%" }}></i></span>
                <span className="unum">{nfmt(o.tokens)}</span>
                <span className="badge">{pct}%</span>
                <span className="badge">{o.calls} {t("usage.callsUnit")}</span>
              </div>
            );
          })}</div>
        </div>
      ) : null}

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
/** 逗号/顿号分隔的候选串 → 有序去重列表（后端就是这么存的）。 */
function parseCandidates(raw: unknown): string[] {
  const out: string[] = [];
  for (const part of String(raw ?? "").split(/[,、]/u)) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 一档一个多选器。
 *
 * 后端早就收「逗号候选串、顺序即优先序、跑的时候取目录里第一个可用的」
 * （kernel/llm.ts 的 overrideSpec），此前界面却要用户把模型名自己打进输入框 ——
 * 打错一个字就静默回落默认档。现在从目录里挑，序号即优先序。
 *
 * `#tier_<tk>` 保留成隐藏输入：saveConfig 按这个 id 读值（settings.ts），
 * 芯片只是它的编辑器。
 */
function TierField({ tk, tiers, catalog, imageCatalog }: {
  tk: string; tiers: any; catalog: any[]; imageCatalog?: string[];
}): ReactElement {
  const cur = tiers[tk] || {};
  const [picked, setPicked] = useState<string[]>(() => parseCandidates(cur.candidates || cur.model || ""));
  const tierLabel = "settings.tier" + tk.charAt(0).toUpperCase() + tk.slice(1);
  const swap = (i: number, k: number): void => {
    const next = [...picked];
    const a = next[i]!, b = next[k]!;
    next[i] = b; next[k] = a;
    setPicked(next);
  };
  const rest = catalog.filter((m: any) => !picked.includes(String(m?.name ?? "")));
  return (
    <div className="field" data-tier={tk}>
      <label>{t(tierLabel)}</label>
      {/* 隐藏输入是保存契约：值永远是「按优先序的候选串」。 */}
      <input type="hidden" id={"tier_" + tk} value={picked.join(", ")} readOnly />
      <div className="tier-chips">
        {picked.map((name, index) => (
          <span className="tier-chip" key={name}>
            <b>{index + 1}</b>{name}
            {index > 0 ? <button type="button" className="tier-up" title="上移一位（更优先）"
              onClick={() => swap(index, index - 1)}>↑</button> : null}
            <button type="button" className="tier-drop" title="从这一档移除"
              onClick={() => setPicked(picked.filter((item) => item !== name))}>×</button>
          </span>
        ))}
        {picked.length === 0 ? <span className="cap">{t("settings.default")}</span> : null}
      </div>
      {tk === "image" ? (
        /* 图像模型被 NOT_CHAT_RE 有意挡在聊天目录外（不该被难度路由选去回话），
           所以这一档的候选列表来自**网关探测**（GET /api/config 的 image_catalog）。
           探测失败列表为空 —— 手填框永远保留兜底，保存时后端按名形校验。 */
        <>
          {(imageCatalog ?? []).length > 0 ? (
            <select className="qselect tier-add" value="" aria-label={t(tierLabel)}
              onChange={(event) => {
                const name = event.target.value;
                if (name && !picked.includes(name)) setPicked([...picked, name]);
              }}>
              <option value="">＋ 加一个出图模型…</option>
              {(imageCatalog ?? []).filter((name) => !picked.includes(name)).map((name, i) => (
                <option key={i} value={name}>{name}</option>
              ))}
            </select>
          ) : null}
          <input className="input tier-add" placeholder="或手填网关上的出图模型，回车加入"
            aria-label={t(tierLabel)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const name = event.currentTarget.value.trim();
              if (name && !picked.includes(name)) setPicked([...picked, name]);
              event.currentTarget.value = "";
            }} />
        </>
      ) : (
      <select className="qselect tier-add" value="" aria-label={t(tierLabel)}
        onChange={(event) => {
          const name = event.target.value;
          if (name && !picked.includes(name)) setPicked([...picked, name]);
        }}>
        <option value="">＋ 加一个模型…</option>
        {rest.map((m: any, i: number) => (
          <option key={i} value={m.name}>
            {m.name}{m.vendor ? " · " + m.vendor : ""}{m.quality ? " · " + m.quality : ""}
          </option>
        ))}
      </select>
      )}
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
        {["low", "medium", "high", "critical", "image"].map((tk) => (
          <TierField key={tk} tk={tk} tiers={tiers} catalog={catalog}
            imageCatalog={c.image_catalog || []} />
        ))}
        {/* 顺序有没有用、多配几个是什么意思，得写出来 —— 否则只能靠猜。 */}
        <p className="cap tier-hint">每一档可以配多个模型，序号就是优先序：真正跑的时候用目录里第一个可用的那个，
          前面的模型下线或不在网关目录里就自动顺延。一个都不配＝用系统默认档。</p>
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
  if (G.SET_TAB === "logs") return <LogsTab />;
  return <AppearanceTab />;
}

registerRegion("setTabs", SettingsTabs);
registerRegion("setBody", SettingsBody);
