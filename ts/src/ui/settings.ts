// 设置：外观对所有人；网关 / 模型 / 预算 / 环境变量仅管理员。用量面板也在这里。
// **这个文件只剩动作与判据**，面板长什么样在 react/settings.tsx。
import { G } from "./state.js";
import { $, API, j } from "./dom.js";
import { t } from "./i18n.js";
import { applyAppearance, savePref } from "./appearance.js";
import { fmtAmount } from "./quota.js";
import { loadSessions } from "./sessions.js";
import { bumpUi } from "./react/store.js";
import { loadAndRenderLogs } from "./logs.js";

// ── 设置（外观对所有人；网关/模型/预算/环境变量仅管理员） ──────────

/**
 * 设置正文的两个瞬时态。旧代码是直接往 `$("setBody").innerHTML` 里塞一段占位
 * HTML（`<div class="cap">…</div>` / `<div class="fnd">错误</div>`），容器归
 * React 之后只能是状态。
 *   loading  正在拉数据时显示的那句话（空串 = 不在加载）
 *   error    拉失败时**整块**换成的那句话
 */
export const SETB = { loading: "", error: "" };

/**
 * 网关设置那张表单的两处反馈，外加一个重挂计数。
 *   err/saved  保存失败 / 保存成功那两行小字
 *   seq        表单里的输入框是**非受控**的（saveConfig 仍按 id 读它们）。旧代码
 *              保存成功后整块重画，输入框因此回到服务端刚返回的值；React 会留住
 *              同一批节点，所以拿 seq 当 key，G.CONFIG 换一次就重挂一次。
 */
export const CFG = { err: "", saved: false, seq: 0 };

/** @param tab 直接落到哪个 tab。左下角菜单的「日志」就是靠它跳过来的 ——
 *  否则用户要先开设置、再自己找那个 tab，多一步且找不到。 */
export function openSettings(tab = "appearance"){
  G.SET_TAB = tab;
  $("setTitle").textContent = t("settings.title");
  $("settingsModal").style.display = "flex";
  renderSettingsShell();
}
export function closeSettings(){ $("settingsModal").style.display = "none"; }

export function switchSetTab(tab: any){ G.SET_TAB = tab; renderSettingsShell(); }

/** 选中的 tab 该显示什么：需要拉数据的两个 tab 在这里发起请求，然后通知重画。 */
export function renderSettingsShell(){
  const isAdmin = G.CURRENT_USER && G.CURRENT_USER.role === "admin";
  SETB.loading = ""; SETB.error = "";
  if (G.SET_TAB === "system" && isAdmin) loadAndRenderConfig();
  else if (G.SET_TAB === "usage") loadAndRenderUsage();
  else if (G.SET_TAB === "logs") loadAndRenderLogs();
  else renderAppearanceTab();
}

export function renderAppearanceTab(){ bumpUi(); }

export function setTheme(v: any){ savePref("theme", v); applyAppearance(); renderAppearanceTab(); }
export function setAccent(v: any){ savePref("accent", v); applyAppearance(); renderAppearanceTab(); }
// 回默认：强调色退回 CSS 里深浅各一的那套，主按钮也跟着回到 #16150f / #4a4842。
// 存空串而不是 removeItem —— 空串一样是假值（判定处都当"没选过"），但它会**同步到
// 服务端**：removeItem 只清本地，换台机器登录，旧的强调色又从 prefs 里回来了。
export function resetAccent(){ savePref("accent", ""); applyAppearance(); renderAppearanceTab(); }
export function setFontScale(v: any){ savePref("fontscale", v); applyAppearance(); renderAppearanceTab(); }
export function setDensity(v: any){ savePref("density", v); applyAppearance(); renderAppearanceTab(); }
export function setTz(v: any){ savePref("tz", v); renderAppearanceTab(); if (G.S) loadSessions(); }

// ── 用量：模型调用流水的汇总 ──────────────────────────────────────


export async function loadAndRenderUsage(){
  SETB.loading = t("usage.loading"); SETB.error = ""; bumpUi();
  try {
    // 一天以内按小时看，否则按天 —— 30 根柱子按小时是 720 根，什么也看不出来
    const bucket = G.USAGE_DAYS <= 1 ? "hour" : "day";
    // owner 只是个"钻取"参数：服务端仍会自己判权限，普通用户传什么都会被钉回自己。
    const own = G.USAGE_OWNER ? `&owner=${encodeURIComponent(G.USAGE_OWNER)}` : "";
    G.USAGE = await j(`/api/usage?days=${G.USAGE_DAYS}&bucket=${bucket}${own}`);
    SETB.loading = "";
    renderUsageTab();
  } catch (e: any) {
    SETB.loading = ""; SETB.error = e.message; bumpUi();
  }
}
export function setUsageDays(d: any){ G.USAGE_DAYS = d; loadAndRenderUsage(); }
/** 钻到某个账号（""=全部）。只有管理员点得到——普通用户界面上根本没有那一块。 */
export function setUsageOwner(o: string){ G.USAGE_OWNER = o; loadAndRenderUsage(); }
export function toggleUsageRows(){ G.USAGE_ROWS_OPEN = !G.USAGE_ROWS_OPEN; renderUsageTab(); }

export function renderUsageTab(){ bumpUi(); }

export async function loadAndRenderConfig(){
  SETB.loading = "…"; SETB.error = ""; bumpUi();
  try {
    G.CONFIG = await j("/api/config");
    SETB.loading = ""; CFG.err = ""; CFG.saved = false; CFG.seq++;
    renderConfigForm();
  }
  catch (e: any) { SETB.loading = ""; SETB.error = e.message; bumpUi(); }
}

// 「预算」段下面那一行余额。
// 铁律 C1：**查不到就是查不到**。多数网关根本没有余额接口，那是常态不是故障 ——
// 这一行留空会被当成还没加载完，显示 0 会被当成钱花光了，两种都是假消息。
//
// **返回的是纯文本，不再 esc()。** 它现在落进 JSX 的文本节点，React 自己转义；
// 再转一遍只会让界面上冒出 `&lt;`。挡住标记这件事一点没少，只是换了执行的人。
export function balanceLine(b: any){
  const num = (v: any) => v !== null && v !== undefined && Number.isFinite(Number(v));
  // known 缺字段时按有没有数来判（老后端 / 字段改名都不该导致误报"没钱"）
  const known = b && (b.known === true
    || (b.known === undefined && (num(b.remaining) || num(b.total) || num(b.used))));
  if (!known) return t("balance.unknown");
  const cur = b.currency || "USD";
  const bits = [];
  const left = num(b.remaining) ? fmtAmount(b.remaining, cur)
    : (num(b.total) && num(b.used) ? fmtAmount(Number(b.total) - Number(b.used), cur) : "");
  if (left) bits.push(t("balance.remaining", "", {v: left}));
  if (num(b.total)) bits.push(t("balance.ofTotal", "", {v: fmtAmount(b.total, cur)}));
  if (!bits.length) return t("balance.unknown");
  if (b.source) bits.push("· " + t("balance.source", "", {v: b.source}));
  return bits.join(" ");
}

export function renderConfigForm(){ bumpUi(); }

export async function saveConfig(){
  CFG.err = ""; CFG.saved = false; bumpUi();
  const body: any = {};
  const baseUrl = ($("cfgBaseUrl").value || "").trim();
  if (baseUrl !== (G.CONFIG.gateway?.base_url || "")) body.base_url = baseUrl;
  const apiKey = $("cfgApiKey").value || "";
  // api_key 是只写字段：placeholder 就是服务端返回的脱敏串（含"…"），
  // 只有用户真的敲了新值、且这个值不含"…"，才当成一次真实修改发回去。
  if (apiKey && !apiKey.includes("…")) body.api_key = apiKey;
  const models: any = {};
  // "image" 必须在这个清单里：图像档的芯片更新的是同一套 #tier_image 隐藏输入，
  // 这里不读它，用户加完出图模型点保存就是静默丢弃 —— 界面上看是"无法保存"。
  for (const tk of ["low","medium","high","critical","image"]) {
    const sel = $("tier_" + tk);
    // 与「人配的原始候选串」比 —— 输入框默认值就是 candidates（可能是「a, b」），
    // 拿它和单个 model 比会把没改过的多候选误判成一次修改。
    const tierCfg = (G.CONFIG.tiers?.[tk] || {});
    const cur = tierCfg.candidates || tierCfg.model || "";
    if (sel && sel.value !== cur) models[tk] = sel.value;
  }
  if (Object.keys(models).length) body.models = models;
  const usdCapRaw = $("cfgUsdCap").value;
  if (usdCapRaw !== "" && Number(usdCapRaw) !== G.CONFIG.budget?.usd_cap) body.usd_cap = Number(usdCapRaw);
  const chatCapRaw = $("cfgChatUsdCap").value;
  if (chatCapRaw !== "" && Number(chatCapRaw) !== G.CONFIG.budget?.chat_usd_cap) body.chat_usd_cap = Number(chatCapRaw);
  try {
    const r = await fetch(API + "/api/config", {method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify(body)});
    if (!r.ok) { CFG.err = (await r.text()).slice(0,300); bumpUi(); return; }
    G.CONFIG = await r.json();
    CFG.seq++;                 // 换了一份 CONFIG：非受控输入框跟着重挂，回到服务端的值
    renderConfigForm();
    CFG.saved = true; bumpUi();
  } catch (e: any) { CFG.err = String(e.message || e); bumpUi(); }
}
