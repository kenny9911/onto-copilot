// 中栏：状态条、常驻动作栏，以及「中栏该重画一次」这个信号。
//
// **消息流 #stream 已经不在这里了** —— 它归 <Stream>（react/stream.tsx）。
// render() 这个名字和它那几十个调用点一个都没动，函数体末尾的
// `box.innerHTML = …` 换成了 bumpUi()：两边的触发时机因此完全一致，
// 而「长什么样」整块搬进了组件。
//
// 顶栏那几个（#status / #title / #chip / #cin）还是就地写 —— 它们长在**冻结的
// HTML** 上，不是空容器，React 没有可以接管的宿主。
import { G } from "./state.js";
import { $, API, esc } from "./dom.js";
import { t } from "./i18n.js";
import { statusText } from "./sessions.js";
import { paintSendBtn } from "./chat.js";
import { paintQuotaBar } from "./quota.js";
import { bundleLink } from "./questions.js";
import { bumpUi } from "./react/store.js";

// ── 渲染：中栏 ──────────────────────────────────────────────────
export function render(){
  const st = $("status");
  const s = G.S?.status || "idle";
  st.className = "pill" + (["queued","parsing","extracting"].includes(s) ? " busy" : s==="failed" ? " err" : "");
  st.innerHTML = `<i></i>${esc(G.S ? statusText(s) : t("status.ready"))}`;
  $("title").textContent = G.S?.title || "OntoCopilot";
  $("chip").textContent = `附件 ${G.S?.files ?? 0}`;
  // 输入框永远可用 —— 跑着的时候恰恰是最想插话的时候。
  $("cin").disabled = !G.S;
  $("cin").placeholder = !G.S ? "" : t("composer.placeholder");
  $("chip").textContent = G.S?.files ? t("mat.count", "", {n: G.S.files}) : "";
  paintSendBtn();
  paintActions();
  paintQuotaBar();     // 换会话时那条「本次上限用满」得跟着走
  // 消息流。**这一句就是原来那三十行**：空状态、开场提示、推理轨迹、待办卡、
  // 时间线（气泡 + 事件卡）、乐观上屏、推理卡、思考占位、chips、确认闸 ——
  // 全部由 <Stream> 从 G 推出来。入场动画与自动滚到底是它的布局副作用。
  bumpUi();
}

// 常驻动作栏。**这是产品的主干道** —— 上传材料之后，"接下来做什么"必须
// 一眼可见，而不是要用户猜该打什么字。
//
// 之前这里只有一个藏在空状态里的按钮：上传本身就产生了事件，空状态立刻消失，
// 于是材料传上去以后界面上一个入口都没有。
//
// 用户点按钮**本身就是确认**。确认闸是用来挡模型自作主张花钱的，不是用来
// 挡人的 —— 挡人只会让他多点一次，然后学会无脑点确定。
export function paintActions(){
  const bar = $("abar");
  if (!G.S) { bar.innerHTML = ""; return; }
  const st = G.S.status, n = G.S.files || 0;
  const arts = G.S.state?.artifacts || [];
  const tpl = arts.find((a: any) => a.endsWith(".xlsx"));
  const btns = [];

  if (["queued","parsing","extracting"].includes(st)) {
    btns.push(`<span class="apend"><i></i>正在梳理…</span>`);
    // 梳理在跑时也能停 —— 尤其当同时有对话在跑、组合按钮被对话占着的时候。
    btns.push(`<button class="abtn" onclick="stopRun()">■ ${t("composer.stop","停止")}</button>`);
  } else if (n && st !== "done") {
    btns.push(`<button class="abtn pri" onclick="startBuild()">开始梳理 ${n} 份材料</button>`);
  } else if (st === "done") {
    if (tpl) btns.push(`<a class="abtn pri" download
      href="${API}/api/sessions/${G.S.id}/artifacts/${encodeURIComponent(tpl)}">下载填写模板</a>`);
    btns.push(bundleLink("导出交付包", "abtn"));
    btns.push(`<button class="abtn" onclick="go('art')">全部产物</button>`);
    btns.push(`<button class="abtn" onclick="startBuild()">重新梳理</button>`);
  }
  bar.innerHTML = btns.join("");
}
