// 外观：主题 / 强调色 / 字号 / 密度，以及它们与服务端 prefs 的同步。
import { G } from "./state.js";
import { j } from "./dom.js";
import { applyI18n } from "./i18n.js";

// ── 外观：主题 / 强调色 / 字号 / 密度 ──────────────────────────────
// 每个预设给浅色、深色两份色值 —— 同一个强调色直接照搬到深色背景上，
// 多数情况下都偏暗，文字对比度不够。
// 每个预设两支：light 是**深色**那一支（浅色主题的强调色，同时是主按钮底色，
// 上面压的是写死的白字），dark 是提亮版（深色主题里当文字/描边用）。
//
// 加新色前必须过三道对比度（都按 WCAG AA 4.5:1 算，实测值见注释）：
//   ① 白字 @ light 底（主按钮）  ② light 当文字 @ 纸底  ③ dark 当文字 @ 夜底
export const ACCENTS: Record<string, {light: string; dark: string}> = {
  // Claude 那个暖橙。原色 #d97757 只能当**深色模式**的强调色（压在夜底上 5.03）——
  // 白字压在它上面只有 3.12、它当浅色模式的正文色只有 2.97，两项都不到 4.5。
  // 所以浅色那一支压暗到 79%（#ab5e45，4.52），刚好过线又尽量留住那个暖调；
  // 深色模式下你看到的就是原汁原味的 #d97757。
  claude: {light:"#ab5e45", dark:"#d97757"},   // 5.03 / 4.52 / 5.03
  green:  {light:"#2f6b4f", dark:"#4fae7f"},   // 6.29 / 5.98 / 5.76
  teal:   {light:"#1f6a68", dark:"#4fb0aa"},   // 6.33 / 6.01 / 6.08
  blue:   {light:"#2f5f8f", dark:"#5b9bd8"},   // 6.66 / 6.33 / 5.33
  indigo: {light:"#4a4c94", dark:"#9092de"},   // 7.63 / 7.25 / 5.50
  plum:   {light:"#7a4a68", dark:"#c07fae"},   // 6.98 / 6.64 / 5.15
  rose:   {light:"#9b3a55", dark:"#e0839a"},   // 6.71 / 6.38 / 5.90
  orange: {light:"#a8501c", dark:"#e08b4f"},   // 5.48 / 5.21 / 5.97
  amber:  {light:"#8a6a1f", dark:"#e0ac3f"},   // 5.05 / 4.80 / 6.50
  olive:  {light:"#5c6b2a", dark:"#a8bc5e"},   // 5.85 / 5.56 / 7.50
  slate:  {light:"#4b5768", dark:"#93a4b8"},   // 7.34 / 6.97 / 6.17
};

//: 色块的鼠标提示。原来直接显示 `green` 这种英文键名。
export const ACCENT_NAME: Record<string, string> = {
  claude:"Claude 橙", green:"墨绿", teal:"青", blue:"靛蓝", indigo:"紫罗兰", plum:"梅",
  rose:"绯", orange:"橙", amber:"琥珀", olive:"橄榄", slate:"石板",
};
export const ACCENT_NAME_EN: Record<string, string> = {
  claude:"Claude Orange", green:"Green", teal:"Teal", blue:"Blue", indigo:"Indigo", plum:"Plum",
  rose:"Rose", orange:"Orange", amber:"Amber", olive:"Olive", slate:"Slate",
};
export const accentName = (k: any) => (G.LANG === "en" ? ACCENT_NAME_EN : ACCENT_NAME)[k] || k;
export function effectiveDark(){
  const theme = localStorage.getItem("oc_theme") || "system";
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
export function applyAppearance(){
  const theme = localStorage.getItem("oc_theme") || "system";
  if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");

  // 原始值（可能是 null）单独留着：**"从没选过"和"手动选了 green"是两回事**，
  // 下面 --btn 要靠这个区分。accentKey 仍按老规矩兜底成 green 给强调色用。
  const accentPick = localStorage.getItem("oc_accent");
  const accentKey = accentPick || "green";
  const preset = ACCENTS[accentKey] || ACCENTS["green"]!;
  const hex = effectiveDark() ? preset.dark : preset.light;
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-tint", `color-mix(in srgb, ${hex} 14%, var(--panel))`);
  root.setProperty("--accent-line", `color-mix(in srgb, ${hex} 35%, var(--panel))`);
  // **主按钮：默认走 CSS 的深浅双色，手动选过强调色才跟着强调色走。**
  //
  // 这里有两条互相拉扯的诉求，各让一步：
  //   · 强调色设置要有存在感 —— 不碰最抢眼的三处（+新会话、发送键、用户气泡），
  //     换一圈颜色几乎看不出区别，设置形同虚设。
  //   · 但**默认**得是 CSS 里深浅各一的那两个色**（浅 #16150f / 深 #4a4842）**，
  //     那是这套界面本来的样子；一上来就把主按钮刷成强调色不是默认该有的观感。
  // 所以判据是"用户有没有真的挑过"：oc_accent 没写过就把行内值摘掉，让 CSS 的
  // 双色生效；挑过了才覆盖。**必须 removeProperty 而不是跳过** —— 行内样式是留在
  // 元素上的，选了颜色再改回默认时不摘掉，旧的强调色会一直钉在按钮上。
  //
  // 覆盖时两个主题都取 preset.light（那是**深色**的那一支）。深色主题的 preset.dark
  // 是提亮版，用来当文字/描边色；拿它做按钮底，白字压上去对比度只有 2:1 左右。
  // 按钮上的白字是写死的，所以底色只能选深色系 —— 这条约束原来就写在 CSS 注释里。
  if (accentPick && ACCENTS[accentPick]) root.setProperty("--btn", preset.light);
  else root.removeProperty("--btn");

  // **必须设在 html 上。** 以前设的是 body.style.fontSize —— 而全站的字号都写死
  // 成绝对 px，body 变了没有任何元素跟着变，这个设置等于不存在（实测 12.5→15px
  // 之间，气泡 13.3、标题 13、说明 10.5、按钮 12.3 一个都不动）。现在字号统一
  // 换算成 rem，rem 只认根元素，所以旋钮拧在 html 上。
  const FS: Record<string, number> = {s: 12, m: 13.5, l: 15.5};
  const scale = FS[localStorage.getItem("oc_fontscale") || "m"] || FS.m;
  document.documentElement.style.fontSize = scale + "px";
  document.body.style.fontSize = "";        // 清掉历史遗留的行内值
  document.body.classList.toggle("dense", (localStorage.getItem("oc_density") || "comfortable") === "compact");
}
// 系统主题跟随时，操作系统本身切换深浅也要跟着重算强调色的浅/深版本
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("oc_theme") || "system") === "system") applyAppearance();
  });
}

// 本地存储的 key 名和后端 /api/me/prefs 的字段名不完全一样（oc_tz ↔ timezone，
// oc_fontscale ↔ font_scale），这里做一次映射，两头都不用迁就对方。
export const PREF_SERVER_KEY: Record<string, string> = {theme:"theme", accent:"accent", lang:"lang", tz:"timezone", fontscale:"font_scale", density:"density"};
export function savePref(localKey: any, val: any){
  localStorage.setItem("oc_" + localKey, val);
  if (G.CURRENT_USER && G.CURRENT_USER.id !== "__local__") {
    const serverKey = PREF_SERVER_KEY[localKey] || localKey;
    j("/api/me/prefs", {method:"PATCH", headers:{"content-type":"application/json"},
      body: JSON.stringify({[serverKey]: val})}).catch(() => {});
  }
}
// 登录 / 刷新时，服务端记的偏好赢过本地缓存 —— 换个设备登录也该是同一套外观。
export function applyUserPrefs(prefs: any){
  if (!prefs) return;
  const map = {theme:"oc_theme", accent:"oc_accent", lang:"oc_lang", timezone:"oc_tz", font_scale:"oc_fontscale", density:"oc_density"};
  let langChanged = false;
  for (const [serverKey, lsKey] of Object.entries(map)) {
    if (!(serverKey in prefs)) continue;
    const v = prefs[serverKey] ?? "";
    localStorage.setItem(lsKey, v);
    if (serverKey === "lang" && v && v !== G.LANG) { G.LANG = v; langChanged = true; }
  }
  applyAppearance();
  if (langChanged) applyI18n();
}
