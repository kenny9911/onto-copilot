// 三栏可调：会话栏收起、上下文栏收起 + 拖拽调宽。宽度记进 localStorage，
// 下次打开还是上次的样子 —— 每次都手动拉一遍是折磨。
//
// 没有「宽屏/紧凑」按钮：那是一颗和拖拽分隔条职责重叠的按钮，两个入口改同一个
// 宽度，谁最后写的赢，用户还得记住自己现在处在哪种模式。留拖拽这一个入口。

const PREVIEW_MIN = 320;
const PREVIEW_MAX = 900;
const PREVIEW_DEFAULT = 440;

function clampPreviewWidth(width: number): number {
  return Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, width));
}

function setPreviewWidth(width: number): void {
  const pv = document.getElementById("preview");
  if (!pv) return;
  const next = clampPreviewWidth(width);
  pv.style.width = next + "px";
  pv.style.flexBasis = next + "px";
  pv.dataset.wide = next >= 680 ? "1" : "";
  document.getElementById("pdrag")?.setAttribute("aria-valuenow", String(next));
  localStorage.setItem("oc_pv_w", String(next));
  pv.dispatchEvent(new CustomEvent("oc:preview-resize", { detail: { width: next } }));
}
export function toggleSidebar(){
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  const mobile = typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 860px)").matches
    : window.innerWidth <= 860;
  let expanded: boolean;
  if (mobile) {
    sidebar.classList.remove("hidden");
    expanded = sidebar.classList.toggle("mobile-open");
  } else {
    sidebar.classList.remove("mobile-open");
    expanded = !sidebar.classList.toggle("hidden");
  }
  document.getElementById("sidetoggle")?.setAttribute("aria-expanded", String(expanded));
}
export function togglePreview(){
  const pv = document.getElementById("preview");
  if (!pv) return;
  const hidden = pv.classList.toggle("hidden");
  // bindResize 会把宽度写成**内联** style，内联样式盖过 .hidden 的 width:0 ——
  // 所以收起时必须清掉内联宽度，展开时再按保存值恢复，否则按钮点了没反应。
  if (hidden) {
    pv.style.width = ""; pv.style.flexBasis = "";
  } else {
    const saved = parseInt(localStorage.getItem("oc_pv_w") || String(PREVIEW_DEFAULT), 10);
    setPreviewWidth(Number.isFinite(saved) ? saved : PREVIEW_DEFAULT);
  }
  const ex = document.getElementById("prevExpand"); if (ex) ex.style.display = hidden ? "block" : "none";
  localStorage.setItem("oc_pv_hidden", hidden ? "1" : "");
}

export function bindResize(){
  const pv = document.getElementById("preview");
  const drag = document.getElementById("pdrag");
  if (!pv || !drag) return;
  const saved = parseInt(localStorage.getItem("oc_pv_w") || "0", 10);
  const sidebar = document.querySelector(".sidebar");
  const sidebarToggle = document.getElementById("sidetoggle");
  const mobileQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 860px)")
    : null;
  const syncSidebar = (mobile: boolean): void => {
    if (!sidebar) return;
    if (mobile) {
      sidebar.classList.remove("hidden", "mobile-open");
      sidebarToggle?.setAttribute("aria-expanded", "false");
    } else {
      sidebar.classList.remove("mobile-open");
      sidebarToggle?.setAttribute("aria-expanded", String(!sidebar.classList.contains("hidden")));
    }
  };
  syncSidebar(mobileQuery?.matches ?? window.innerWidth <= 860);
  mobileQuery?.addEventListener?.("change", (event: any) => syncSidebar(Boolean(event.matches)));
  // 收起状态优先：收起时别再写内联宽度（会盖过 .hidden 的 width:0）
  if (localStorage.getItem("oc_pv_hidden")) {
    pv.classList.add("hidden");
    const ex = document.getElementById("prevExpand"); if (ex) ex.style.display = "block";
  } else if (saved >= PREVIEW_MIN && saved <= PREVIEW_MAX) {
    setPreviewWidth(saved);
  } else {
    setPreviewWidth(PREVIEW_DEFAULT);
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
    const w = clampPreviewWidth(window.innerWidth - e.clientX);
    pv.style.width = w + "px"; pv.style.flexBasis = w + "px";
    pv.dataset.wide = w >= 680 ? "1" : "";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.classList.remove("dragging");
    setPreviewWidth(parseInt(pv.style.width, 10) || PREVIEW_DEFAULT);
  });
  drag.addEventListener("keydown", (e: any) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const current = pv.getBoundingClientRect().width || PREVIEW_DEFAULT;
    // 分隔条在面板左侧：向左移动会让右栏变宽，向右则变窄。
    if (e.key === "ArrowLeft") setPreviewWidth(current + (e.shiftKey ? 80 : 24));
    if (e.key === "ArrowRight") setPreviewWidth(current - (e.shiftKey ? 80 : 24));
    if (e.key === "Home") setPreviewWidth(PREVIEW_MIN);
    if (e.key === "End") setPreviewWidth(PREVIEW_MAX);
  });
}
