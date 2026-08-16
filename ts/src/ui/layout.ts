// 三栏可调：会话栏收起、预览栏收起 + 拖拽调宽。

// 三栏可调：会话栏收起、预览栏收起+拖拽调宽。宽度记进 localStorage，
// 下次打开还是上次的样子 —— 每次都手动拉一遍是折磨。
export function toggleSidebar(){
  document.querySelector(".sidebar").classList.toggle("hidden");
}
export function togglePreview(){
  const pv = document.getElementById("preview");
  const hidden = pv.classList.toggle("hidden");
  // bindResize 会把宽度写成**内联** style，内联样式盖过 .hidden 的 width:0 ——
  // 所以收起时必须清掉内联宽度，展开时再按保存值恢复，否则按钮点了没反应。
  if (hidden) {
    pv.style.width = ""; pv.style.flexBasis = "";
  } else {
    const saved = parseInt(localStorage.getItem("oc_pv_w") || "400", 10);
    const w = (saved >= 320 && saved <= 900) ? saved : 400;
    pv.style.width = w + "px"; pv.style.flexBasis = w + "px";
  }
  const ex = document.getElementById("prevExpand"); if (ex) ex.style.display = hidden ? "block" : "none";
  localStorage.setItem("oc_pv_hidden", hidden ? "1" : "");
}
export function bindResize(){
  const pv = document.getElementById("preview");
  const drag = document.getElementById("pdrag");
  const saved = parseInt(localStorage.getItem("oc_pv_w") || "0", 10);
  // 收起状态优先：收起时别再写内联宽度（会盖过 .hidden 的 width:0）
  if (localStorage.getItem("oc_pv_hidden")) {
    pv.classList.add("hidden");
    const ex = document.getElementById("prevExpand"); if (ex) ex.style.display = "block";
  } else if (saved >= 320 && saved <= 900) {
    pv.style.width = saved + "px"; pv.style.flexBasis = saved + "px";
  }
  let dragging = false;
  drag.addEventListener("mousedown", (e: any) => {
    dragging = true; document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none"; e.preventDefault();
    // 拖动期间关掉宽度过渡，否则面板会吊在光标后面（见 body.dragging 那条 CSS）
    document.body.classList.add("dragging");
  });
  window.addEventListener("mousemove", (e: any) => {
    if (!dragging) return;
    // 预览在最右，宽度 = 视口右缘到鼠标。夹在 [320, 900]。
    const w = Math.min(900, Math.max(320, window.innerWidth - e.clientX));
    pv.style.width = w + "px"; pv.style.flexBasis = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.classList.remove("dragging");
    localStorage.setItem("oc_pv_w", String(parseInt(pv.style.width, 10) || 400));
  });
}
