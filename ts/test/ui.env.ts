/**
 * 给 ui 模块用的最小浏览器环境。
 *
 * **为什么不装 happy-dom / jsdom**：并行迁移期间禁止动 package.json（抢 lock 会把
 * 别人的 track 一起搅烂），而这里要测的东西也不需要一个真 DOM —— 渲染函数产出的是
 * **字符串**，状态归约动的是**对象**，真正碰 DOM 的只有「把字符串塞进 innerHTML」
 * 那一句。这个 stub 只要让 `$()` 返回一个不会炸的东西，被测函数就能跑完。
 *
 * 用法：在测试文件的**第一行** import 它 —— ESM 的静态 import 按声明顺序求值，
 * ui 模块在自己的模块体里就会读 localStorage（`G.MODE` / `G.LANG` / `PJ_OFF`），
 * 环境装晚了那三个值就是 undefined。
 */

const store = new Map<string, string>();

function stubEl(): any {
  const el: any = {
    innerHTML: "", textContent: "", value: "", title: "", disabled: false,
    hidden: false, checked: false, className: "", scrollTop: 0, scrollHeight: 0,
    clientHeight: 0, offsetWidth: 0, offsetHeight: 0, files: [],
    dataset: {} as Record<string, string>,
    style: {} as Record<string, unknown>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    setAttribute() {}, removeAttribute() {}, click() {}, focus() {}, select() {},
    scrollIntoView() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [] as any[],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}

const g = globalThis as any;

g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: unknown) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};
g.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
/** 按 id 记住元素 —— 渲染函数写的是 $("convs").innerHTML，测试要读得回来。 */
const byId = new Map<string, any>();
export function el(id: string): any {
  let e = byId.get(id);
  if (!e) { e = stubEl(); byId.set(id, e); }
  return e;
}
/** 每个用例之间清一次，免得上一条的 innerHTML 漏到下一条。 */
export function resetDom(): void { byId.clear(); }

g.document = {
  documentElement: {
    lang: "",
    style: { setProperty() {}, removeProperty() {}, fontSize: "" },
    setAttribute() {}, removeAttribute() {},
  },
  body: { style: {}, classList: { add() {}, remove() {}, toggle() {} } },
  getElementById: (id: string) => el(id),
  querySelector: () => stubEl(),
  querySelectorAll: () => [] as any[],
  createElement: () => stubEl(),
  addEventListener() {},
};
g.window = {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {}, innerWidth: 1400, innerHeight: 900,
};
g.innerWidth = 1400;
g.innerHeight = 900;
g.location = { reload() {} };
g.CSS = { escape: (s: string) => s };
g.alert = () => {};
g.confirm = () => false;
g.prompt = () => null;

/** connect() 造的 EventSource：把 onmessage 抓出来，测试自己往里喂事件。 */
export class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  close(): void { this.closed = true; }
  /** 按 SSE 的形态送一条事件（data 是 JSON 文本）。 */
  send(ev: unknown): void { this.onmessage?.({ data: JSON.stringify(ev) }); }
}
g.EventSource = FakeEventSource;

/** 网络：默认全部拒绝。要断言请求就自己换掉 globalThis.fetch。 */
g.fetch = async () => { throw new Error("test: fetch not stubbed"); };

export { store as localStorageStore, stubEl };
