// 账户管理（仅管理员）—— **动作**。表格长什么样在 react/accounts.tsx。
import { G } from "./state.js";
import { $, j } from "./dom.js";
import { t } from "./i18n.js";
import { bumpUi } from "./react/store.js";

// ── 账户管理（仅管理员） ────────────────────────────────────────

/**
 * 账号面板的两处瞬时态，外加一个重挂计数。
 *
 *   err    行内那条 `.err`（重名 / 最后一个管理员 / 删自己……）
 *   fatal  连用户列表都没拉到 —— 整块换成一句话，表格根本无从画起
 *   seq    新增账号那三个输入框是**非受控**的（doAddUser 仍按 id 读它们）。
 *          旧代码每调一次 renderAccounts() 就把整块 innerHTML 重写一遍，输入框
 *          因此跟着清空；React 会**留住**同一批 DOM 节点，值就残留下来了。
 *          所以把 seq 挂成那段表单的 key：renderAccounts() 一次 = 重挂一次 =
 *          清空一次，与旧行为逐次对齐（新增失败后输入框也确实是空的）。
 *
 * **不进 G**：state.ts 那份状态有两百多条断言直接读写，为一句错误提示去改它
 * 不值当，何况那是别人的文件。
 */
export const ACCT = { err: "", fatal: "", seq: 0 };

export function acctError(msg: any){
  ACCT.err = String(msg ?? "");
  bumpUi();
}

export async function openAccounts(){
  G.RESET_ID = null;
  ACCT.err = ""; ACCT.fatal = "";
  $("acctTitle").textContent = t("accounts.title");
  $("accountsModal").style.display = "flex";
  await loadUsers();
}
export function closeAccounts(){ $("accountsModal").style.display = "none"; }

export async function loadUsers(){
  try { G.USERS = await j("/api/users"); ACCT.err = ""; ACCT.fatal = ""; renderAccounts(); }
  catch (e: any) { ACCT.fatal = e.message; bumpUi(); }
}

// 账号表。**旧实现在这里逐条 esc / eattr / earg 拼 innerHTML** —— 用户名只经过
// strip().lower()（auth.py），引号一个都没拦：`o'brien` 能让一行的 onclick 语法
// 错误、按钮直接失灵，而 `x','');alert(1);//` 是一次对管理员的存储型 XSS，他只是
// 打开了账号面板。组件化之后参数是**值**（onClick={() => doDeleteUser(u.id, …)}），
// 那趟「拼进属性 → HTML 解码 → 当 JS 编译」的旅程整个不存在了。
export function renderAccounts(){
  ACCT.seq++;          // 见 ACCT.seq：整块重画 = 新增表单清空
  bumpUi();
}

export async function doAddUser(){
  const username = ($("newUsername").value || "").trim();
  const password = $("newPassword").value || "";
  const role = $("newRole").value;
  if (!username || !password) return;
  try {
    await j("/api/users", {method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({username, password, role})});
    await loadUsers();
  } catch (e: any) { renderAccounts(); acctError(/409/.test(e.message) ? t("accounts.errDup") : e.message); }
}

export async function changeRole(id: any, role: any){
  try { await j(`/api/users/${id}`, {method:"PATCH", headers:{"content-type":"application/json"}, body: JSON.stringify({role})}); await loadUsers(); }
  catch (e: any) { await loadUsers(); acctError(/409/.test(e.message) ? t("accounts.errLastAdmin") : e.message); }
}

export async function toggleActive(id: any, active: any){
  try { await j(`/api/users/${id}`, {method:"PATCH", headers:{"content-type":"application/json"}, body: JSON.stringify({active})}); await loadUsers(); }
  catch (e: any) { await loadUsers(); acctError(/409/.test(e.message) ? t("accounts.errLastAdmin") : e.message); }
}

export function beginReset(id: any){ G.RESET_ID = id; renderAccounts(); }
export function cancelReset(){ G.RESET_ID = null; renderAccounts(); }
export async function doResetPassword(id: any){
  const val = ($("resetPwInput").value || "");
  if (!val) return;
  try {
    await j(`/api/users/${id}/reset-password`, {method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({password: val})});
    G.RESET_ID = null; await loadUsers();
  } catch (e: any) { acctError(e.message); }
}

export async function doDeleteUser(id: any, username: any){
  if (!confirm(`${t("accounts.confirmDelete")} (${username})`)) return;
  try { await j(`/api/users/${id}`, {method:"DELETE"}); await loadUsers(); }
  catch (e: any) {
    await loadUsers();
    acctError(/409/.test(e.message) ? (/self/i.test(e.message) ? t("accounts.errSelfDelete") : t("accounts.errLastAdmin")) : e.message);
  }
}
