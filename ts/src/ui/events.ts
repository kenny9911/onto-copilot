// 事件：时间线归并、卡片名单、词汇表、操作记录。
//
// **卡片本身已经不在这里了** —— 事件卡（evCard）与推理轨迹（traceCard）由
// <EvCard> / <TraceCard>（react/events.tsx）画。这个模块只剩不碰 DOM 的那一半：
// 归并顺序、哪些事件配一张卡、中文说法、好坏判定、要点、操作记录。
import { G } from "./state.js";
import { esc, hhmm } from "./dom.js";

// 事件卡片和聊天气泡以前是**两段拼起来的**：先 push 全部事件，再 push 全部气泡。
// 于是一张在对话末尾产生的表（AI 调 ui.table 列出 192 条问题）被画在**整段对话的
// 最上方**，而渲染完又自动滚到底 —— 用户看到的是助手说"请见下表"，下面什么都没有。
// 他两次报"表没画出来"，其实每次都画了，只是画在他看不到的地方。
//
// 两边都带绝对时间戳 ts（事件有，Utterance.to_dict 也有），按它归并成一条时间线。
// 用 ts 而不是 seq：seq 是进程内计数，重启后 s.events 从 0 重新开始，而历史轮次
// 是从库里读回来的 —— 两套 seq 撞在一起就乱了，ts 不会。
//
// **返回的是次序，不是标记。** 每一项要么是一条发言（turn），要么是一张事件卡
// （ev），画的人是 <Stream>（react/stream.tsx）—— 归并这件事和「长什么样」是两回
// 事，混在一起的那版正是上面那个 bug 藏身的地方。
export interface TimelineItem {
  /** 排序主键：这一项该落在时间线的哪一刻。 */
  key: number;
  /** 同一刻内的次序：发言在前（0），事件卡按事件顺序跟在后面。 */
  ord: number;
  turn?: any;
  ev?: any;
}

function webRows(ev: any): any[] {
  return Array.isArray(ev?.results) ? ev.results : Array.isArray(ev?.sources) ? ev.sources : [];
}

function webSourceId(row: any): string {
  return String(row?.source_id ?? row?.id ?? "").trim();
}

/** URL 去 fragment、收掉非根路径末尾的 `/`；同一篇正文的锚点链接不能占两行。 */
function canonicalWebUrl(row: any): string {
  const raw = String(row?.url ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return raw.replace(/#.*$/u, "");
  }
}

function webContentRank(row: any): number {
  const status = String(row?.content_status ?? row?.contentStatus ?? "");
  if (status === "fetched") return 3;
  if (status === "snippet_only") return 2;
  if (status === "blocked") return 1;
  return 0;
}

/**
 * 同一来源后来的 `web.read` 要把搜索摘要升级成正文，但空字段不能反过来擦掉标题/URL。
 * 同级时保留先来的版本，时间线因此不会因 SSE 重放而抖动。
 */
function mergeWebRow(current: any, incoming: any): any {
  const primary = webContentRank(incoming) > webContentRank(current) ? incoming : current;
  const fallback = primary === incoming ? current : incoming;
  const merged = { ...(fallback && typeof fallback === "object" ? fallback : {}) };
  if (primary && typeof primary === "object") {
    for (const [key, value] of Object.entries(primary)) {
      if (value !== undefined && value !== null && value !== "") merged[key] = value;
    }
  }
  return merged;
}

function citedWebIds(text: unknown): Map<string, number> {
  const order = new Map<string, number>();
  const re = /WEB\[([^\]\r\n]+)\]/gu;
  const body = String(text ?? "");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const id = String(match[1] ?? "").trim();
    if (id && !order.has(id)) order.set(id, order.size);
  }
  return order;
}

interface MergedWebRow {
  row: any;
  order: number;
  ids: Set<string>;
  urls: Set<string>;
}

/** 同一回答里的 search/read 事件折成一份来源清单；不改变服务端耐久事件本身。 */
function mergeWebSourceEvents(events: any[], assistant: any): any {
  const records: MergedWebRow[] = [];
  let rowOrder = 0;
  for (const ev of events) {
    for (const row of webRows(ev)) {
      const id = webSourceId(row);
      const url = canonicalWebUrl(row);
      const matches = records.filter((record) =>
        (id !== "" && record.ids.has(id)) || (url !== "" && record.urls.has(url)));
      let record = matches.sort((a, b) => a.order - b.order)[0];
      if (!record) {
        record = { row, order: rowOrder++, ids: new Set(), urls: new Set() };
        records.push(record);
      } else {
        record.row = mergeWebRow(record.row, row);
        // 一条后来数据可能拿 id 命中 A、拿 URL 命中 B；两组也必须桥接成一条。
        for (const duplicate of matches.slice(1)) {
          record.row = mergeWebRow(record.row, duplicate.row);
          duplicate.ids.forEach((value) => record!.ids.add(value));
          duplicate.urls.forEach((value) => record!.urls.add(value));
          const index = records.indexOf(duplicate);
          if (index >= 0) records.splice(index, 1);
        }
      }
      if (id) record.ids.add(id);
      if (url) record.urls.add(url);
      const mergedId = webSourceId(record.row);
      const mergedUrl = canonicalWebUrl(record.row);
      if (mergedId) record.ids.add(mergedId);
      if (mergedUrl) record.urls.add(mergedUrl);
    }
  }

  const cited = citedWebIds(assistant?.text);
  const citationRank = (record: MergedWebRow): number => {
    let rank = Number.POSITIVE_INFINITY;
    record.ids.forEach((id) => { rank = Math.min(rank, cited.get(id) ?? Number.POSITIVE_INFINITY); });
    return rank;
  };
  records.sort((a, b) => citationRank(a) - citationRank(b) || a.order - b.order);
  const validIds = new Set<string>();
  records.forEach((record) => record.ids.forEach((id) => validIds.add(id)));
  const citationIds = [...cited.keys()].filter((id) => validIds.has(id));

  const search = events.find((ev) => !String(ev?.search_id ?? ev?.searchId ?? "").startsWith("read_")) ?? events[0] ?? {};
  const first = events[0] ?? {};
  const declared = events.map((ev) => Number(ev?.total)).filter((n) => Number.isSafeInteger(n) && n >= 0);
  const total = Math.max(records.length, ...declared, 0);
  const merged = {
    ...first,
    query: search.query ?? first.query,
    search_id: search.search_id ?? search.searchId ?? first.search_id ?? first.searchId,
    provider: search.provider ?? first.provider,
    retrieved_at: search.retrieved_at ?? search.retrievedAt ?? first.retrieved_at ?? first.retrievedAt,
    total,
    truncated: events.some((ev) => ev?.truncated === true) || total > records.length,
    citation_ids: citationIds,
    results: records.map((record) => record.row),
  };
  delete merged.sources;
  return merged;
}

export function timeline(dlg: any){
  const isAsst = (t: any) => String(t.speaker || "").toLowerCase().includes("assistant");
  const asc = dlg.map((t: any, i: number) => ({ts: +t.ts || 0, a: isAsst(t), i, turn: t}))
    .sort((x: any, y: any) => x.ts - y.ts || x.i - y.i);
  const nextTurn = (ts: any) => {                       // 紧随这一刻之后的那条发言
    let lo = 0, hi = asc.length;
    while (lo < hi){ const m = (lo + hi) >> 1; if (asc[m].ts > ts) hi = m; else lo = m + 1; }
    return asc[lo] || null;
  };
  const previousTurn = (ts: any) => {                   // 这一刻之前最后一条发言
    let lo = 0, hi = asc.length;
    while (lo < hi){ const m = (lo + hi) >> 1; if (asc[m].ts < ts) lo = m + 1; else hi = m; }
    return asc[lo - 1] || null;
  };

  const items: TimelineItem[] = dlg.map((t: any) => ({key: +t.ts || 0, ord: 0, turn: t}));
  const webByAssistant = new Map<number, { turn: any; ts: number; first: number; events: any[] }>();
  const orphanWebByTurn = new Map<number, { ts: number; first: number; events: any[] }>();
  const webTurnActive = !!(G.THINKING || G.CHAT_ABORT);
  const lastDialogueTurn = asc[asc.length - 1] ?? null;
  // 新一轮运行时只隐藏**这一轮**的候选。历史上某次失败后留下的兜底来源卡不能
  // 因为用户又问了一句话就暂时消失；正常链路里 user chat.turn 总先于 web.sources。
  const activeWebOwner = webTurnActive && lastDialogueTurn && !lastDialogueTurn.a
    ? lastDialogueTurn.i : null;
  // **只留最后一条 session.restored。** 每次服务重启/水合都会发一条**持久**事件，
  // 于是它们在事件表里累积（真实库里见过同一会话 5 条），流里就叠出 5 张一模一样的
  // 「会话已恢复」。它是一条状态陈述而不是一件事，最新那条已经涵盖了全部信息。
  //
  // 折叠在这里而不是在渲染层：ord 用的是事件在 events 里的下标，渲染层再过滤会让
  // 同一刻的卡片次序随别的事件增删而漂移（见上面那段注释）。
  const lastRestored = G.S.events.reduce(
    (acc: number, ev: any, i: number) => (ev && ev.kind === "session.restored" ? i : acc), -1);
  G.S.events.forEach((ev: any, i: any) => {
    if (ev && ev.kind === "session.restored" && i !== lastRestored) return;
    // 画不出卡片的事件在这里就滤掉（大多数事件只进推理轨迹）。**滤在推进 ord 之前
    // 不行** —— ord 用的是事件在 events 里的下标，换成过滤后的下标会让同一刻的两张
    // 卡片次序随别的事件增删而漂移。
    if (!hasCard(ev)) return;
    const ts = +ev.ts || 0;
    // 工具在助手这一轮里产出的卡片，时间上**早于**助手那句话（先调工具后成文），
    // 但读起来属于那句话之后 —— 他写的是"已列出 192 条，见下表"。所以挂到紧随
    // 其后的那条助手发言之后，而不是插在提问和回答中间。梳理过程自己产出的卡片
    // （后面没有助手发言）按自己的时刻排，位置不变。
    const n = nextTurn(ts);
    if (ev?.kind === "web.sources") {
      if (n && n.a) {
        const group = webByAssistant.get(n.i) ?? {
          turn: n.turn, ts: n.ts, first: i, events: [] as any[],
        };
        group.first = Math.min(group.first, i);
        group.events.push(ev);
        webByAssistant.set(n.i, group);
      } else {
        // 停止、网络失败或服务端异常时不一定有 assistant chat.turn。此时这批候选
        // 已经不会再被一条回答收编，按它前面的用户轮聚成一张兜底卡；不能因为没有
        // 回答就让已取回且已持久化的证据永久消失。仍在运行时则继续只藏候选全文。
        const previous = previousTurn(ts);
        const owner = previous?.i ?? -1;
        const belongsToActiveTurn = webTurnActive
          && (activeWebOwner === null || owner === activeWebOwner);
        if (!belongsToActiveTurn) {
          const group = orphanWebByTurn.get(owner) ?? { ts, first: i, events: [] as any[] };
          group.ts = Math.max(group.ts, ts);
          group.first = Math.min(group.first, i);
          group.events.push(ev);
          orphanWebByTurn.set(owner, group);
        }
      }
      // 还没有助手回答，说明这一轮仍在检索、读正文和筛选候选。事件照常留在
      // G.S.events 里供审计、重连与最后归并，但候选卡先不进入聊天时间线；否则
      // 每次 web.search/web.read 都会把一整张中间清单铺出来，最终再突然收成 5 条。
      // 下一条不是助手时同样不展示：孤立的工具结果没有一条完成回答可供核验。
      return;
    }
    items.push({key: n && n.a ? n.ts : ts, ord: 1 + i * 1e-6, ev});
  });
  // 只在助手回答落地后展示。搜索和逐篇读正文都是同一回答的取证过程：先按回答
  // 中 WEB[id] 的引用顺序选优，再由 WebSourcesCard 封顶 5 条；逐事件画卡会出现
  // 「上一张只剩尾巴，下一张又从头开始」，也会把未入选的中间候选误当成结论。
  // 这里收成一张，且仍用第一条事件的 ord 与其他卡稳定排序。
  webByAssistant.forEach((group) => {
    items.push({
      key: group.ts,
      ord: 1 + group.first * 1e-6,
      ev: mergeWebSourceEvents(group.events, group.turn),
    });
  });
  orphanWebByTurn.forEach((group) => {
    items.push({
      key: group.ts,
      ord: 1 + group.first * 1e-6,
      ev: mergeWebSourceEvents(group.events, null),
    });
  });
  return items.sort((a: any, b: any) => a.key - b.key || a.ord - b.ord);
}

// 哪些事件值得单独占一张卡片。**这份名单是 <EvCard> 的判据本身** —— 组件第一句
// 就是 `if (!hasCard(ev)) return null`，两边不会各写一套 if 然后慢慢漂开
// （ui.react.stream.test.tsx 有一条逐种类核对「名单说有、组件就真的画得出」）。
//
// corpus.ready 是唯一带条件的：没有 findings 的那条不值得占位置 —— 它想说的
// 「读完了」在推理轨迹里已经有一行。
const CARD_KINDS = new Set(["parse.failed", "human.recorded", "artifact.ready", "asset.recalled",
  "audit.applied", "ui.table", "export.ready", "run.failed", "session.restored",
  // 网络资料不塞进模型生成的 markdown：结构化来源卡保留真实 URL、站点、摘要与
  // 正文读取状态，FDE 才能回到原文核验，而不是把一串"参考资料名称"当证据。
  "web.sources",
  // sketch.ready 必须占一张卡：它是一张**要当场看**的图（拿去跟业务方对），
  // 而且卡上挂着「这是模型通识不是客户证据」那句标记 —— 缩成轨迹里的一行，
  // 图看不见，标记也跟着不见了。
  "sketch.ready"]);

export function hasCard(ev: any): boolean {
  if (ev?.kind === "corpus.ready") return (ev.findings || []).length > 0;
  return CARD_KINDS.has(ev?.kind);
}

// ── 事件词汇表：所有事件类型的中文说法，聊天流轨迹和右栏推理共用 ────────
//
// **一处定义，两处用。** 以前只有聊天流那张表有标签，而它只覆盖了一半的事件
// 类型 —— 剩下的靠 `LABEL[kind] || kind` 兜底，于是界面上直接冒出
// `materials.registered`、`prompts.ready` 这种原始 key。用户看到的是内部实现，
// 而这些恰恰是他最想知道"系统刚才干了什么"的时刻。
export const EV_LABEL: Record<string, string> = {
  // 材料
  "files.attached":"收到材料", "materials.registered":"材料已登记",
  "corpus.ready":"读完材料", "corpus.restored":"恢复语料", "parse.failed":"解析失败",
  "session.restored":"恢复会话", "session.renamed":"会话改名",
  "session.rename_failed":"自动命名失败",
  // 梳理流水线
  "plan.frozen":"冻结计划", "node.entered":"进入", "node.completed":"完成",
  "extract.dropped":"抽取时丢弃", "gaps.mined":"挖出缺口",
  "run.completed":"梳理结束", "run.failed":"梳理失败",
  "run.suspended":"挂起等拍板", "run.cancelled":"已取消",
  // 产物
  "artifact.ready":"产物就绪", "artifact.validation_failed":"产物校验失败",
  "asset.recalled":"从记忆取回",
  "flow.ready":"流程图就绪", "flow.linked":"流程接上接口", "flow.from_api":"由接口反推流程",
  "flow.bpmn":"BPMN", "flow.scenes":"流程场景", "flow.skipped":"跳过流程图",
  "flow.step":"流程步骤", "flow.stale_edits":"流程编辑已失效",
  "oir.edited":"改了本体", "oir.stale_edits":"本体编辑已失效",
  "template.edited":"改了模板", "template.stale_edits":"模板编辑已失效",
  "export.ready":"导出文件", "ui.table":"列出表格",
  "web.sources":"网络资料",
  "sketch.ready":"参考流程图",
  // 决策与问题
  "clarify.request":"待拍板", "question.answered":"答复问题",
  "human.recorded":"记下决策", "suggest.ready":"给出建议", "prompts.ready":"推荐问题",
  "audit.previewed":"回传预览", "audit.applied":"回传已应用", "audit.completed":"审核完成",
  // Engagement
  "engagement.stage":"交付阶段", "engagement.frozen":"冻结交付计划",
  "engagement.checkpoint_migrated":"迁移检查点",
  // 运行时（出问题时最该看见的那些）
  "quota.low":"额度不足", "quota.exhausted":"额度耗尽", "budget.capped":"到达花费上限",
  "persist.failed":"落库失败", "memory.failed":"记忆写入失败",
  "memory.not_shared":"记忆未共享", "hydrate.partial":"会话恢复不完整",
  "mutation.refresh_failed":"刷新状态失败", "queue.drained":"排队任务已执行",
};

//: 统计字段的中文。JSON 摆在界面上等于没说 —— 用户得自己在脑子里翻译一遍。
export const EV_STAT_CN: Record<string, string> = {objects:"对象", properties:"属性", links:"关系", actions:"行动",
  rules:"规则", questions:"问题", open_questions:"待答", orphans:"孤儿",
  confirmed:"已确认", files:"文件", chunks:"切片", sheets:"表",
  prefilled:"预填", business_required:"业务必填", total_cells:"格",
  clusters:"聚簇", merged_away:"合并", endpoints:"接口", profiles:"列画像"};

export function evLabel(kind: any){
  // 兜底也要像人话：把 `some.thing` 拆成可读的词，而不是原样吐 key
  return EV_LABEL[kind] || String(kind || "").replace(/[._]/g, " ");
}

// 这条事件是好消息、坏消息还是在跑。**失败必须一眼看得出来** ——
// 一屏灰条里混着一条 persist.failed，等于没报。
export function evTag(kind: any){
  const k = String(kind || "");
  // `_failed` 和 `.failed` 是同一件事（session.rename_failed / kernel.node_failed）——
  // 只认点号的话，一屏灰条里混着一条失败等于没报。
  if (k.endsWith(".failed") || k.endsWith("_failed") || k === "quota.exhausted") return "err";
  if (k === "run.suspended" || k === "quota.low" || k === "budget.capped"
      || k === "extract.dropped" || k.endsWith(".stale_edits")) return "warn";
  if (k.endsWith("completed") || k.endsWith(".ready") || k === "corpus.ready" || k === "asset.recalled") return "ok";
  return "run";
}

export function evStats(o: any){
  return Object.entries(o || {})
    .filter(([k, v]) => v !== 0 && v !== null && EV_STAT_CN[k])
    .map(([k, v]) => `${EV_STAT_CN[k]} ${v}`).join(" · ");
}

// 一条事件的要点。**按事件类型分别说**，不是所有带 questions 的都叫"决策" ——
// 以前 prompts.ready（推荐给用户点的问题）被显示成"2 个决策"，那是两件完全
// 不同的事：一个是聊天框上方的提示，一个是必须人拍板的建模决策。
export function evDetail(ev: any){
  const k = ev.kind;
  if (k === "prompts.ready") return `${(ev.questions || []).length} 条`;
  if (k === "clarify.request") return `${(ev.questions || []).length} 个待拍板`;
  if (k === "suggest.ready") return `${(ev.suggestions || []).length} 条`;
  if (k === "gaps.mined") return `${ev.count ?? 0} 条${ev.groups?.length ? "（" + ev.groups.slice(0,3).join("、") + "）" : ""}`;
  if (k === "files.attached" || k === "materials.registered")
    return (ev.files || []).join("、") || `${(ev.files || []).length} 份`;
  if (k === "export.ready") return ev.name || "";
  if (k === "asset.recalled") return `${ev.name || ""}${ev.source ? ` · ${ev.source}` : ""}`;
  // 轨迹那一行也带上「通用参考」四个字：卡片会被折叠，标记不能只活在卡片上。
  if (k === "sketch.ready") return `${ev.domain || ""}· 通用参考`;
  if (k === "session.renamed") return ev.title || "";
  if (k === "ui.table") return ev.title || `${(ev.rows || []).length} 行`;
  if (k === "web.sources") {
    const rows = Array.isArray(ev.results) ? ev.results : Array.isArray(ev.sources) ? ev.sources : [];
    return `${rows.length} 条${ev.query ? ` · ${String(ev.query)}` : ""}`;
  }
  if (k === "question.answered") {
    // 服务端发的键是 `question`（server/routes/questions.ts 的 emit）。
    // 这里原本读的是 `question_id || qid` —— **两个都不存在**，于是每条
    // 「答复问题」都渲染成空白详情。`question_id`/`qid` 保留只为老会话。
    const qid = ev.question || ev.question_id || ev.qid || "";
    // 人要看的是「定了什么」，不是「哪条问题」。label 是被选中那个选项的原话。
    const label = ev.label || "";
    const n = Array.isArray(ev.changed) ? ev.changed.length : 0;
    if (!label) return qid;
    return n > 0 ? `${label} · 改了 ${n} 处` : label;
  }
  if (k === "engagement.stage") return ev.node || "";
  if (k === "node.entered" || k === "node.completed")
    return `${ev.node || ""}${ev.title ? " · " + ev.title : ""}`;
  const stat = evStats(ev.stats);
  if (stat) return stat;
  return ev.error || ev.reason || ev.detail || ev.name || "";
}

// 操作记录 —— **这个会话里发生过的每一件事**，倒序，最新的在最上面。
//
// 它和上面的推理分组是两回事：推理是「AI 想了什么」（每轮一组），操作是
// 「系统做了什么」（一条时间线）。以前后者只在聊天流里那张折叠卡上，
// 而那张卡的标签表只覆盖一半事件、且会随对话滚走 —— 想回头查"刚才那次梳理
// 到底跑了哪几步、哪一步失败了"，没有地方可查。
export function opsLog(){
  if (!G.OPS.length) return "";
  const rows = G.OPS.slice().reverse().map(o => `
    <div class="oprow">
      <span class="tag ${o.tag}">${esc(o.label)}</span>
      <span class="opd">${esc(o.detail || "")}</span>
      <span class="opt">${esc(hhmm(o.ts))}</span>
    </div>`).join("");
  return `<div class="tgrp opgrp">
    <div class="tgq">操作记录 · ${G.OPS.length} 条</div>${rows}</div>`;
}


// 推理轨迹的一行。**思考文字全文显示，不截断** —— 这个 tab 存在的理由就是
// 让人能核对它到底想了什么；截断的思考和没有思考一样不可核对。
export function traceRow(x: any){
  return `<div class="trw">
    <div class="trn">${x.n ?? "·"}</div>
    <div class="trb">
      ${x.thought ? `<div class="trt">${esc(x.thought)}</div>` : ""}
      ${x.tool ? `<div class="trc"><code>${esc(x.tool)}</code> ${esc(JSON.stringify(x.args || {}))}</div>` : ""}
      ${x.observation ? `<div class="tro">${esc(String(x.observation))}</div>` : ""}
    </div></div>`;
}
