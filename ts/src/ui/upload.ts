// 上传材料、开跑、模型下拉。
import { G } from "./state.js";
import { $, j } from "./dom.js";
import { t } from "./i18n.js";
import { esc, eattr } from "./dom.js";
import { newSession } from "./sessions.js";
import { render } from "./render.js";
import { paint, go } from "./preview.js";

// ── 上传与启动 ──────────────────────────────────────────────────
export async function uploadPicked(){
  const fs = [...$("picker").files];
  if (!fs.length) return;
  if (!G.S) await newSession(true);
  await uploadFiles(fs);
  $("picker").value = "";
}

export async function startBuild(tier: any){
  if (!G.S || !G.S.files) return;
  const q = tier ? `?tier=${encodeURIComponent(tier)}` : "";
  try {
    await j(`/api/sessions/${G.S.id}/build${q}`, {method:"POST",
      headers:{"content-type":"application/json"}, body: JSON.stringify({lang:G.LANG})});
    G.S.status = "queued"; render(); paint();
  } catch (e: any){ alert("启动失败：" + e.message); }
}

// 拖拽上传。"把文件拖进来"是这类工具的默认预期 —— 让人去找一个「附件」按钮
// 是多余的一步。整个中栏都是投放区，不只是输入框那一小条。
export function bindDrop(){
  const zone = document.querySelector(".main");
  const box = document.querySelector(".cbox");
  let depth = 0;   // dragenter/dragleave 会在子元素间反复触发，用计数而不是布尔
  zone.addEventListener("dragover", (e: any) => { e.preventDefault(); });
  zone.addEventListener("dragenter", (e: any) => {
    e.preventDefault();
    if (++depth === 1) box.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; box.classList.remove("drag"); } });
  zone.addEventListener("drop", async (e: any) => {
    e.preventDefault(); depth = 0; box.classList.remove("drag");
    const fs = [...(e.dataTransfer?.files || [])];
    if (!fs.length) return;
    if (!G.S) await newSession(true);
    await uploadFiles(fs);
  });
}

export async function uploadFiles(list: any){
  const fd = new FormData();
  for (const f of list) fd.append("files", f);
  $("chip").textContent = "读取中…";
  const r = await j(`/api/sessions/${G.S.id}/files`, {method:"POST", body: fd});
  G.S.files = r.files.length; G.S.filelist = r.files;
  G.PROMPTS = r.prompts || G.PROMPTS; G.FOLLOWUPS = [];   // 材料进来了，能问的完全变了
  render(); go("mat");
  // **上传不自动开跑。** FDE 传完还要增删材料、还要写一句话说清这轮要什么
  // （"重点看采购包的状态流转"），那句话正是梳理的输入。自动开始等于替他
  // 决定，而且把他还没传完的材料先跑一遍。他写完 prompt 发出来，或点
  // 「开始梳理」，再跑。
}

// ── 模型选择 ────────────────────────────────────────────────────
// 「自动」= 按难度路由。选了具体模型就用它对话。**梳理管线不受影响** ——
// 扫描件 OCR 这类需要视觉的环节仍按能力自动挑带视觉的模型，否则选了个纯文本
// 模型就等于把 OCR 关掉了。
// MODELS 住在 state.ts
export async function loadModels(){
  try {
    const r = await j("/api/models");
    G.MODELS = r.models || [];
    const sel = $("modelsel");
    if (!sel) return;
    const cur = (G.S && G.S.model) || "";
    sel.innerHTML = `<option value="">${esc(t("model.auto"))}</option>` + G.MODELS.map(m =>
      `<option value="${eattr(m.name)}"${m.name===cur?" selected":""}>${esc(m.name)}${
        (m.capabilities||[]).includes("vision") ? " 👁" : ""}</option>`).join("");
  } catch (e: any) { /* 模型列表拉不到不该挡住输入框 */ }
}

export async function setModel(name: any){
  if (!G.S) return;
  try {
    await j(`/api/sessions/${G.S.id}/model`, {method:"POST",
      headers:{"content-type":"application/json"}, body: JSON.stringify({model:name})});
    G.S.model = name;
  } catch (e: any){ alert("没能切换模型：" + e.message); }
}

// 开跑前撤掉一份材料。传错/传多了要能拿掉，不必重开会话。
export async function dropMaterial(name: any){
  if (!G.S) return;
  if (!confirm(`移除材料「${name}」？`)) return;
  try {
    const r = await j(`/api/sessions/${G.S.id}/files/${encodeURIComponent(name)}`,
                      {method:"DELETE"});
    G.S.filelist = r.files; G.S.files = r.files.length;
    // 材料少了一份，能问的也就变了 —— 和上传那条路对称地换掉提示
    G.PROMPTS = r.prompts || G.PROMPTS; G.FOLLOWUPS = [];
    if (G.FILE === name) { G.FILE = null; }
    render(); paint();
  } catch (e: any){ alert("没能移除：" + e.message); }
}
