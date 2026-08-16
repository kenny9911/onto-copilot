// 右栏预览：材料 / 实体 / 冲突 / 问题 / 产物 / 流程图 / 推理。
//
// **这个文件已经不画 DOM 了。** 七个页签全部由组件出（react/preview.tsx +
// react/workbench.tsx + react/think.tsx），#pbody 归 React。留在这里的是
// **状态与动作**：切页签、取材料原文、按 sheet 分组、判形状 —— 它们一行都不碰
// 真实 DOM，换宿主本来就不该动它们，它们的测试也就一条都不用改。
import { G, TBL_OPEN } from "./state.js";
import { $, esc, j } from "./dom.js";
import { loadQuestions } from "./questions.js";
import { render } from "./render.js";
import { bumpUi } from "./react/store.js";

// ── 渲染：右栏 ──────────────────────────────────────────────────
export function go(t: any){
  G.TAB = t;
  document.querySelectorAll(".tab").forEach((b: any) => b.classList.toggle("on", b.dataset.t === G.TAB));
  if (t === "q" && G.S) loadQuestions(); else paint();
  pfade();
}

// 切标签页时给预览区来一次淡入。**只在这里调**：paint() 本身会被 SSE 事件反复
// 触发，把淡入常驻在卡片上会让面板跟着每条事件闪（见那条 CSS 的注释）。
//
// **必须同步挂 class，不能等 requestAnimationFrame。** 上一版用双层 rAF 来"重启
// 动画"，结果是：paint() 已经把新内容写进 DOM 了，class 还要两帧后才到 —— 这两帧
// 里内容按 opacity:1 画出来，等 class 一挂，fill-mode:both 立刻套用 from{opacity:0}
// 把它摁灭，再淡入。用户看到的是"先亮一下、灭掉、再浮现"，比不做动画还难看。
// 同步挂上，第一帧画出来就已经是 opacity:0，淡入才是干净的。
//
// 重启动画不需要 rAF：动画挂在 **#pbody 这个容器本身**上，摘掉 class → 强制重排
// → 重新挂上，就是重新起跑。#pbody 归 React 之后这一点反而更稳：容器是 portal 的
// 宿主，它自己的 class 不在 React 的虚拟树里，两边不会互相覆盖 —— 组件换的是它的
// 子节点，pfade 换的是它的 class，各碰各的。
//
// 次序也仍然是对的：go() 先 paint()（= bumpUi，React 在这一轮微任务末尾才把新内容
// 提交上去），再同步挂 class。等新内容真的进 DOM 时 class 早就在了，fill-mode:both
// 让它从 opacity:0 起跑 —— 正是上面要的那种干净淡入。

export function pfade(){
  const b = $("pbody");
  if (!b) return;
  clearTimeout(G.PFADE_T);
  b.classList.remove("pfade");
  void b.offsetWidth;                       // 强制重排，让动画能重新起跑
  b.classList.add("pfade");
  // **播完必须摘掉。** 留着的话，之后每一次 SSE 触发的 paint() 重画出来的新节点
  // 都会再淡入一遍 —— 那正是这套改法要避免的闪烁，只是换了个地方发作。
  G.PFADE_T = setTimeout(() => b.classList.remove("pfade"), 400);
}

export async function openSource(file: any, cite: any){
  // 证据 chip 有时只给 cite、不给文件名（流程图/建议里的引用就是 openSource('', cite)）。
  // cite 形如「文件名!sheet!R1C2」或「文件名#p2」——从前缀兜底出文件名，
  // 否则 file='' 会命中 /source?file= 的 500，而且什么都定位不到。
  if (!file && cite) file = String(cite).split(/[!#]/)[0];
  go("mat"); G.FILE = file; paint();
  if (file) await loadSource(file);
  if (!cite) return;
  const el = document.querySelector(`[data-cite="${CSS.escape(cite)}"]`);
  if (el) { el.scrollIntoView({block:"center"}); el.style.boxShadow = "0 0 0 2px var(--accent-line)"; }
}


// 打开一份材料时，默认展开第一张有内容的 sheet —— 全折叠等于什么都没显示。
export function _openFirstSheet(file: any){
  const doc = G.SRC[file];
  if (!doc || !doc.chunks) return;
  const g = groupBySheet(doc.chunks);
  // 跳过纯元数据那张，展开第一张真表
  const first = g.find(x => x.sheet !== "文档元数据") || g[0];
  if (first) G.MAT_OPEN = new Set([first.sheet]);
}

export async function loadSource(file: any){
  G.MAT_OPEN = new Set(); G.MAT_N = 100;
  if (!G.S || G.SRC[file]) { _openFirstSheet(file); paint(); return; }
  try { G.SRC[file] = await j(`/api/sessions/${G.S.id}/source?file=${encodeURIComponent(file)}`); }
  catch (e: any){ G.SRC[file] = {error: e.message, chunks: []}; }
  _openFirstSheet(file);
  paint();
}

// 点流程节点看出处这件事**不在这里了**：它现在是 <FlowTab> 的一份局部状态，
// 由 <FlowCite> 画（react/preview.tsx）。旧的 flowCite() 直接写 #fcite 的
// innerHTML —— 那个容器现在住在 React 的虚拟树里，在它背后改真 DOM，下一次更新
// 轻则丢节点重则抛 NotFoundError。所以这个函数连同它在 window 上的绑定一起删掉，
// 而不是留一份「暂时没人调」的定时炸弹。

// 表格行的 render 是 "列名=值 | 列名=值" 的长串，直接吐出来要横向找半天。
// 拆成键值对之后，同一列在不同行是对齐的，扫一眼就知道哪个格子空着。

// 按 sheet 把切片分组。sheet 名从 locator 取，取不到就从 cite 里 `文件!sheet!行`
// 解析 —— cite 是权威的，locator 有时缺。
export function groupBySheet(chunks: any){
  const map = new Map();
  for (const c of chunks) {
    let sheet = c.locator?.sheet || c.locator?.section;
    if (!sheet) {
      const m = String(c.cite||"").match(/!([^!]+)!/);
      sheet = m ? m[1] : (c.locator?.kind === "meta" ? "文档元数据" : "其它");
    }
    if (!map.has(sheet)) map.set(sheet, []);
    map.get(sheet).push(c);
  }
  return [...map.entries()].map(([sheet, rows]) => ({sheet, rows, shape: sheetShape(rows)}));
}

// 一眼看出这是什么表。纯前端启发式，只为导航 —— 真正的形状判定在后端 shape.py。
export function sheetShape(rows: any){
  const txt = rows.slice(0, 8).map((r: any) => r.text || "").join(" ");
  // 顺序即优先级：先判最特征化的，散文兜底放最后
  if (/文档元数据|abs_path|creator|last_modified/.test(txt)) return "文档元数据";
  if (/触发条件|输入.*输出|执行者|执行着/.test(txt)) return "流程说明";
  if (/[?？]|参考选项|澄清问题/.test(txt)) return "待填问卷";
  if (/\burl\b|openapi|\/v\d|接口路径/i.test(txt)) return "接口清单";
  if (/实体编码|实体名称|apiName|业务对象/.test(txt)) return "实体清单";
  if (rows.length && (rows[0].text||"").length > 60) return "规则/散文";
  return "";
}

export function toggleTable(seq: any){
  if (TBL_OPEN.has(seq)) TBL_OPEN.delete(seq); else TBL_OPEN.add(seq);
  render();
}

export function toggleSheet(sheet: any){
  if (G.MAT_OPEN.has(sheet)) G.MAT_OPEN.delete(sheet); else G.MAT_OPEN.add(sheet);
  G.MAT_N = 100; paint();
}

export function chunkBody(c: any){
  const t = String(c.text || "");
  if (!t.includes("=") || !t.includes("|")) return esc(t).slice(0, 600);
  const pairs = t.split("|").map(x => x.trim()).filter(Boolean);
  if (pairs.length < 2) return esc(t).slice(0, 600);
  return `<div class="kv">` + pairs.map(p => {
    const i = p.indexOf("=");
    if (i < 0) return `<div class="kvr"><span class="kvv">${esc(p)}</span></div>`;
    return `<div class="kvr"><span class="kvk">${esc(p.slice(0,i))}</span>
      <span class="kvv">${esc(p.slice(i+1))}</span></div>`;
  }).join("") + `</div>`;
}

// 右栏「重画一次」。
//
// **函数体只剩这一句是这次迁移的终点**：#pbody 归了 React（见 react/preview.tsx
// 末尾那行 registerRegion），画什么由 <PreviewBody> 按 G.TAB 决定，这里要做的只是
// 「G 变了，通知订阅它的组件」。原来那 150 行 paintLegacy() 整个删掉了。
//
// **调用点一个都没动** —— sse.ts / questions.ts / returnaudit.ts / sessions.ts /
// upload.ts / mode.ts / i18n.ts 里那十几处 `paint()` 原样留着，它们的语义（右栏
// 重画一次）也原样成立。那是这次换框架能做到「行为等价」的全部依据。
export function paint(){
  bumpUi();
}
