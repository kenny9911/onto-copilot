// 取元素、转义、发请求 —— 三千行里被引用最多的四五个符号。
import { showLogin } from "./auth.js";

export const API = "";

export const $ = (id: string): any => document.getElementById(id);

// 三个转义函数，**按值最终落在哪个位置**选，不是按手感选：
//   esc   → 文本节点（只需挡住标签）
//   eattr → 普通属性值（还要挡住引号，否则能闭合属性再开一个新的）
//   earg  → 内联事件处理器里的字符串参数（见下）
export const esc = (s: any): string =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
export const eattr = (s: any): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
// **内联处理器里 eattr 一个人不够。** 浏览器是先把属性值做 HTML 实体解码，
// 再把解码后的字符串当 JavaScript 编译的 —— `&#39;` 解码回 `'`，照样把
// onclick="f('…')" 里那个字符串字面量劈开。实测：用户名
// `x','');window.__pwned=1;//` 只用 eattr 时，点一下删除按钮就执行了。
// 所以顺序是**先按 JS 字面量转义，再按属性转义**：`'` → `\'` → `\&#39;`
// → 解码回 `\'` → 编译时是一个转义引号，留在字符串里。
export const ejs = (s: any): string =>
  String(s ?? "")
    .replace(/[\\'"]/g, (c) => "\\" + c)
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); // JS 里也是换行符
export const earg = (s: any): string => eattr(ejs(s));

export const j = async (u: string, o?: any): Promise<any> => {
  const r = await fetch(API + u, o);
  // 401 意味着会话过期或从未登录 —— 除了登录请求本身，任何接口踩到这个都该
  // 弹登录框，而不是让调用方各自处理一遍「未授权」。
  if (r.status === 401 && u !== "/api/login") showLogin();
  if (!r.ok) {
    // **把状态码和人话都带上。** 原来直接 `throw new Error(await r.text())`：
    //   1. 调用方分不清 409（会话忙，等一下就好）和 500（真出事了）—— 而这两者
    //      该有完全不同的反应，一个是排队，一个是报错。
    //   2. 抛出去的是响应体原文，于是界面上出现的是
    //      `没发出去：{"detail":"这个会话已有一轮对话正在处理…"}` —— 把一句本来
    //      写得好好的中文包在 JSON 里念给用户听。
    const body = (await r.text()).slice(0, 2000);
    let detail = body;
    try {
      const o = JSON.parse(body);
      // FastAPI 风格是 detail，我们自己的路由有的用 error。两个都认。
      const d = o?.detail ?? o?.error ?? o?.message;
      if (typeof d === "string" && d) detail = d;
    } catch { /* 不是 JSON 就用原文，总比什么都不说强 */ }
    const err = new Error(detail.slice(0, 300)) as Error & { status?: number; body?: string };
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return r.json();
};

// 会话时间戳：按用户选的时区格式化，时区非法或格式化失败就退回浏览器默认，
// 绝不能因为一个坏的时区字符串让整个侧栏列表崩掉。
export function fmtWhen(epochSec: any): string {
  if (!epochSec) return "";
  const tz = localStorage.getItem("oc_tz") || undefined;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short", timeZone: tz || undefined }).format(new Date(epochSec * 1000));
  } catch (e: any) {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(epochSec * 1000)); }
    catch (e2: any) { return ""; }
  }
}

export function fmtSize(n: any): string {
  n = +n || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export function nfmt(n: any): string {
  n = +n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

export function hhmm(ts: any): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const ph = (k: string, t: string): string => `<div class="ph"><div class="ic">${k}</div>${t}</div>`;
