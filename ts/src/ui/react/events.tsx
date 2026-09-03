// 聊天流里的两块「系统在做事」：事件卡片（evCard）与推理轨迹（traceCard）。
//
// 对应 events.ts 里那两个拼模板字符串的函数，**类名与结构逐字对齐**：767 行 CSS
// 认的是 `.card` `.card>h4` `.n` `.cap` `.fnd` `.act` `.act.pri` `.trace` `.tb`
// `.step` `.tag.ok|warn|err|run` `.sub` 这些选择器，少一个类名就是少一块样式。
//
// ## 事件卡片与推理轨迹的分工（这条界线以前被搞混过）
//
// 大多数事件只进推理轨迹那条折叠时间线；只有**需要人读全文**的才升级成卡片：
// 材料里发现的问题、人拍的板、产出的东西。哪些算「需要人读全文」由 events.ts 的
// `hasCard()` 说了算 —— 组件与那份名单必须一致，所以这里第一句就是
// `if (!hasCard(ev)) return null`，而不是各写各的一套 if。
//
// ## ui.table 那张表为什么默认只画 30 行
//
// 数据由服务端直接从产物出，不经模型复述（202 个对象让模型一条条打出来，必然
// 截断、还可能记错，而且很贵）。但 202 行一次铺开会把聊天流冲垮 —— 所以默认 30 行
// 加一个展开按钮，且**展开状态按事件 seq 记**（TBL_OPEN），一屏里的两张表各记各的。
//
// ## 行内样式照抄，不许「顺手」搬进 CSS
//
// 这几张表的 style 是写在模板字符串里的（`style="overflow:auto;max-height:420px"`
// 那些）。搬进 index.html 的 CSS 就是改那 767 行，所以这里逐条译成 JSX 的 style
// 对象 —— 值一个字符都没变，`var(--line)` 这种 CSS 变量在对象写法里照样生效。

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { API, fmtSize } from "../dom.js";
import { evDetail, evLabel, evTag, hasCard } from "../events.js";
import { t } from "../i18n.js";
import { toggleTable } from "../preview.js";
import { TBL_OPEN } from "../state.js";
import { BundleLink } from "./bundle.js";
import { prefillComposer } from "../context-sync.js";
import { bumpUi, useUi } from "./store.js";
import { WebSourcesCard } from "./web-search.js";

// 参考流程图的预览尺寸。行内样式（不进那 767 行 CSS —— 见文件头最后一段）：
// 宽度跟着卡片走，高度封顶免得一张 6 泳道的图把整条聊天流顶下去。
const SKETCH_IMG = {
  display: "block", maxWidth: "100%", maxHeight: "360px",
  border: "1px solid var(--line)", borderRadius: "6px",
  background: "#fff",
} as const;

// 大图预览是 portal，不能依赖聊天流的层叠上下文（#stream 有自己的滚动与裁切）。
// 样式留在组件内，既不改那份冻结的页面壳，也能让浅色/深色主题共用同一套遮罩。
const PREVIEW_TRIGGER = {
  display: "block", width: "100%", margin: "8px 0 0", padding: 0,
  border: 0, borderRadius: "6px", background: "transparent", cursor: "zoom-in",
} as const;
const LIGHTBOX_BACKDROP = {
  position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center",
  padding: "clamp(16px, 4vw, 48px)", background: "rgba(10, 10, 8, .88)",
  backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
} as const;
const LIGHTBOX_PANEL = {
  position: "relative", display: "flex", flexDirection: "column", alignItems: "center",
  maxWidth: "100%", maxHeight: "100%", gap: "10px",
} as const;
const LIGHTBOX_IMG = {
  display: "block", maxWidth: "min(94vw, 1800px)", maxHeight: "calc(100vh - 112px)",
  objectFit: "contain", borderRadius: "8px", background: "#fff",
  boxShadow: "0 24px 80px rgba(0, 0, 0, .48)",
} as const;
const LIGHTBOX_CLOSE = {
  position: "absolute", top: "-14px", right: "-14px", zIndex: 1,
  width: "38px", height: "38px", border: "1px solid rgba(255,255,255,.3)",
  borderRadius: "999px", background: "rgba(20,20,18,.9)", color: "#fff",
  fontSize: "24px", lineHeight: 1, cursor: "pointer",
} as const;
const LIGHTBOX_CAPTION = {
  maxWidth: "min(92vw, 1000px)", color: "rgba(255,255,255,.88)",
  fontSize: "13px", textAlign: "center", overflowWrap: "anywhere",
} as const;

/**
 * 聊天图的统一预览器。
 *
 * 缩略图用真正的 button 包起来，所以鼠标、Enter、Space 都原生可用；打开后焦点
 * 落在关闭按钮，Escape/遮罩都可退出，退出时焦点回到原图。外层卡片原有的「看大图」
 * 与下载链接不受影响，用户也仍可用浏览器的新标签页查看原文件。
 */
function PreviewableImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: any) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [open]);

  const dialog = open && typeof document !== "undefined" ? createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby={titleId}
      data-image-lightbox="true" style={LIGHTBOX_BACKDROP}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}>
      <figure style={LIGHTBOX_PANEL}>
        <button ref={closeRef} type="button" aria-label="关闭大图预览"
          style={LIGHTBOX_CLOSE} onClick={() => setOpen(false)}>×</button>
        <img src={src} alt={alt} style={LIGHTBOX_IMG} />
        <figcaption id={titleId} style={LIGHTBOX_CAPTION}>{alt}</figcaption>
      </figure>
    </div>,
    document.body,
  ) : null;

  return <>
    <button ref={triggerRef} type="button" aria-label={`放大预览：${alt}`}
      aria-haspopup="dialog" aria-expanded={open} style={PREVIEW_TRIGGER}
      onClick={() => setOpen(true)}>
      <img src={src} alt={alt} style={SKETCH_IMG} />
    </button>
    {dialog}
  </>;
}

// `<img>` 只内嵌浏览器可直接解码的位图。SVG 即使从我们的产物路由读取，也可能
// 夹脚本/外链，不走这条聊天内嵌通道。后缀按文件名末尾断，`a.png.exe` 不能蒙混过关。
const SAFE_BITMAP = /\.(?:png|jpe?g|webp|gif)$/iu;
const SAFE_BITMAP_MIME = /^image\/(?:png|jpeg|webp|gif)$/iu;

function isSafeBitmap(name: unknown, mime?: unknown): boolean {
  return SAFE_BITMAP.test(String(name ?? "").trim())
    || SAFE_BITMAP_MIME.test(String(mime ?? "").trim());
}

/** 这些 URL 来自服务端的记忆索引；仍 fail closed，不让耐久事件把 javascript/data URI 变成链接。 */
function safeAssetUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (/^\/(?!\/)/u.test(raw)) return `${API}${raw}`;
  if (/^https?:\/\//iu.test(raw)) return raw;
  return "";
}

function artifactUrl(sessionId: unknown, name: unknown, storage: unknown = "artifacts"): string {
  const bucket = storage === "exports" ? "exports" : "artifacts";
  return `${API}/api/sessions/${encodeURIComponent(String(sessionId ?? ""))}` +
    `/${bucket}/${encodeURIComponent(String(name ?? ""))}`;
}

function artifactEventUrl(ev: any, sessionId: unknown, purpose: "preview" | "download"): string {
  const supplied = purpose === "preview"
    ? ev?.preview_url ?? ev?.previewUrl ?? ev?.url
    : ev?.download_url ?? ev?.downloadUrl ?? ev?.url;
  return safeAssetUrl(supplied) || artifactUrl(sessionId, ev?.name, ev?.storage);
}

function referenceTags(ev: any): ReactNode {
  const generic = ev?.generic_reference === true || ev?.source === "generic_reference";
  return <>{generic ? <span className="n">通用参考</span> : null}
    {ev?.display_only === true ? <span className="n">仅供展示</span> : null}</>;
}

function assetKindLabel(ev: any, image: boolean): string {
  const kind = String(ev?.asset_kind ?? ev?.assetKind ?? ev?.type ?? "").trim().toLowerCase();
  if (image || kind === "image" || kind === "picture") return "图片";
  if (kind === "material" || kind === "source") return "材料";
  if (kind === "document" || kind === "doc") return "文档";
  if (kind === "question" || kind === "question_list") return "问题";
  return "记忆素材";
}

// ── ui.table 的行内样式（逐条抄自原模板字符串）────────────────────
const TBL_BOX = { overflow: "auto", maxHeight: "420px", marginTop: "6px" } as const;
const TBL = { borderCollapse: "collapse", width: "100%", fontSize: "0.926rem" } as const;
const TH = {
  textAlign: "left", padding: "5px 8px", borderBottom: "1px solid var(--line)",
  position: "sticky", top: 0, background: "var(--panel)", whiteSpace: "nowrap",
} as const;
const TD = {
  padding: "5px 8px", borderBottom: "1px solid var(--line-soft)", verticalAlign: "top",
} as const;

/** 一张动态表格。**默认 30 行**，展开状态按事件 seq 记 —— 一屏两张表各记各的。 */
function TableCard({ ev }: { ev: any }): ReactNode {
  const cols = ev.columns || [], rows = ev.rows || [];
  const N = ev.seq;
  const open = TBL_OPEN.has(N);
  const shown = open ? rows : rows.slice(0, 30);
  return (
    <div className="card"><h4>{ev.title || "清单"}</h4>
      <div style={TBL_BOX}>
        <table style={TBL}>
          <thead><tr>{cols.map((c: any, i: number) => <th key={i} style={TH}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((r: any, i: number) => (
            <tr key={i}>{r.map((v: any, k: number) => <td key={k} style={TD}>{String(v ?? "")}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      {rows.length > 30
        ? <button className="act" style={{ marginTop: "8px" }} onClick={() => { toggleTable(N); }}>
            {open ? t("table.collapse") : t("table.expand", "", { n: rows.length })}</button>
        : null}
      <div className="cap" style={{ marginTop: "4px" }}>{t("table.total", "", { n: rows.length })}</div>
    </div>
  );
}

/** 关掉过的卡片。**只在内存里** —— 关掉是"这一眼别挡着我"，不是删审计记录。 */
const DISMISSED = new Set<string>();

/** 事件的身份。seq 是会话内唯一的；没有 seq 时退回 kind+ts，够区分同类里的不同条。 */
function evKey(ev: any): string {
  return String(ev?.seq ?? `${String(ev?.kind ?? "")}@${String(ev?.ts ?? "")}`);
}

/**
 * 值得单独占一张卡片的事件。认不出的种类画空（`null`），而不是画一张写着原始 key
 * 的空卡 —— 那是把实现细节摆到用户脸上。
 */
export function EvCard({ ev }: { ev: any }): ReactNode {
  const G = useUi();
  if (!hasCard(ev)) return null;

  if (ev.kind === "corpus.ready") {
    return (
      <div className="card">
        <h4>材料解析<span className="n">{`${ev.stats?.files ?? 0} 份 · ${ev.stats?.chunks ?? 0} 切片`}</span></h4>
        {(ev.findings || []).map((x: any, i: number) => <div className="fnd" key={i}>{x.message}</div>)}
      </div>
    );
  }

  if (ev.kind === "parse.failed") {
    return <div className="card"><h4>解析失败</h4><div className="cap">{ev.error || ""}</div></div>;
  }

  if (ev.kind === "human.recorded") {
    const changed = ev.changed || [];
    return (
      <div className="card">
        <h4>已确认<span className="n">{ev.conflict || ""}</span></h4>
        {ev.label || ""}
        {changed.length ? <div className="cap">{`变更 ${changed.join("、")}`}</div> : null}
      </div>
    );
  }

  if (ev.kind === "artifact.ready") {
    const st = ev.stats || {};
    const previewHref = artifactEventUrl(ev, G.S.id, "preview");
    const downloadHref = artifactEventUrl(ev, G.S.id, "download");
    const bitmap = isSafeBitmap(ev.name);
    if (bitmap) {
      const ext = String(ev.name ?? "").trim().split(".").pop()?.toUpperCase() || "图片";
      return (
        <div className="card">
          <h4>{ev.name || "图片"}{referenceTags(ev)}</h4>
          {ev.model ? <div className="cap">{`图像模型：${ev.model}`}</div> : null}
          <PreviewableImage src={previewHref} alt={ev.name || "流程图"} />
          <div style={{ marginTop: "8px" }}>
            <a className="act" target="_blank" rel="noreferrer" href={previewHref}>看大图</a>
            <a className="act" download href={downloadHref}>{`下载 ${ext}`}</a>
          </div>
        </div>
      );
    }
    return (
      <div className="card">
        <h4>{ev.name || "产物"}{referenceTags(ev)}</h4>
        <div className="cap">{`${st.sheets ?? 0} 张表 · ${st.business_required ?? 0} 格待业务方填写`}</div>
        <a className="act" href={downloadHref}>下载</a>
      </div>
    );
  }

  // 记忆检索返回的素材也是一等聊天内容：重连时它从同一条耐久事件重放，
  // 不去猜客户本地路径。预览/下载 URL 由服务端的受保护路由发给前端。
  if (ev.kind === "asset.recalled") {
    const preview = safeAssetUrl(ev.preview_url ?? ev.previewUrl ?? ev.url);
    const open = preview || safeAssetUrl(ev.url ?? ev.download_url ?? ev.downloadUrl);
    const download = safeAssetUrl(ev.download_url ?? ev.downloadUrl ?? ev.url ?? ev.preview_url);
    const bitmap = isSafeBitmap(ev.name, ev.mime) && preview !== "";
    const label = assetKindLabel(ev, bitmap);
    return (
      <div className="card">
        <h4>{ev.name || "记忆素材"}<span className="n">{label}</span>{referenceTags(ev)}</h4>
        {ev.source ? <div className="cap">{`来源：${ev.source}`}</div> : null}
        {bitmap ? <PreviewableImage src={preview} alt={ev.name || "记忆图片"} /> : null}
        {open || download ? <div style={{ marginTop: "8px" }}>
          {open ? <a className="act" target="_blank" rel="noreferrer" href={open}>
            {bitmap ? "看大图" : "打开"}</a> : null}
          {download ? <a className="act" download href={download}>下载</a> : null}
        </div> : null}
      </div>
    );
  }

  if (ev.kind === "audit.applied") {
    const rev = ev.revision ?? ev.artifact_revision ?? "新";
    return (
      <div className="card">
        <h4>业务回传已合并<span className="n">{`revision ${rev}`}</span></h4>
        <div className="cap">{`${ev.changed ?? ev.cells_changed ?? 0} 处变化 · ${ev.dropped?.length ?? 0} 项未合并`}</div>
        <BundleLink label="下载新 Bundle" className="act pri" />
      </div>
    );
  }

  if (ev.kind === "ui.table") return <TableCard ev={ev} />;

  if (ev.kind === "web.sources") return <WebSourcesCard ev={ev} />;

  // 对话里导出的文件。**不进产物列表** —— 产物是梳理跑出来的东西，这是他随口要的
  // 一份拷贝，混在一起会让「全部产物」变成一个垃圾堆。
  if (ev.kind === "export.ready") {
    // P3 产物迭代：文件是模型第 N 版的投影。模型往前走了（M > N），这份文件
    // 就旧了 —— 当场标出来，并给一键重导（预填一句话走对话，不绕过模型权限）。
    // 老事件没有 revision：不出徽标，不猜版本。
    const based = Number(ev.revision ?? 0) || 0;
    const current = Number(G.S?.state?.artifact_revision ?? 0) || 0;
    // 重导是**同名覆盖**（safeName(doc.title) 确定性），旧卡的下载链接给出的
    // 已经是新字节 —— 台账（export_meta[文件名].revision）说这个名字被更高
    // 版本盖过时，旧卡要说「已被覆盖」并撤下重导按钮，而不是继续按事件里
    // 冻结的版本喊「旧了，重导」诱导再花一次钱。
    const ledgerRev = Number(
      (G.S?.state?.export_meta as Record<string, { revision?: unknown }> | undefined)
        ?.[ev.name]?.revision ?? 0,
    ) || 0;
    const covered = based > 0 && ledgerRev > based;
    const stale = !covered && based > 0 && current > based;
    const reexport = () => {
      prefillComposer(
        `请按最新模型重新导出「${ev.title || ev.name}」，文件名保持「${ev.name}」不变。`,
        { mode: "replace" },
      );
    };
    return (
      <div className="card">
        <h4>{ev.title || ev.name || "导出"}
          {based > 0 ? <span className={stale ? "n warn" : "n"}>
            {covered
              ? `已被第 ${ledgerRev} 版重导覆盖`
              : stale
                ? `基于第 ${based} 版 · 模型已到第 ${current} 版`
                : `基于第 ${based} 版`}
          </span> : null}
        </h4>
        <div className="cap">{`${ev.label || ""} · ${fmtSize(ev.size)}${ev.rows ? ` · ${ev.rows} 行` : ""}`}</div>
        <a className="act pri" style={{ marginTop: "8px" }} download
          href={`${API}/api/sessions/${G.S.id}/exports/${encodeURIComponent(ev.name)}`}
        >{t("export.download", "", { name: ev.name })}</a>
        {stale ? <button type="button" className="act" style={{ marginTop: "8px", marginLeft: "6px" }}
          onClick={reexport}
        >重新导出（第 {current} 版）</button> : null}
      </div>
    );
  }

  // 参考流程图（flow.sketch）。**与 artifact.ready 那张卡刻意不同**：那是从材料里
  // 抽出来的交付物，这是模型凭领域通识画的底图 —— 卡上必须挂着来源标记
  // （source_note），否则截图进方案文档之后就没人分得清哪张是有依据的。
  // 直接内嵌预览而不是只给下载：这张图存在的意义就是"当场指着它跟业务方对"。
  if (ev.kind === "sketch.ready") {
    const href = `${API}/api/sessions/${G.S.id}/exports/${encodeURIComponent(ev.name)}`;
    return (
      <div className="card">
        <h4>{ev.title || "参考流程图"}<span className="n">通用参考</span></h4>
        <div className="cap">{ev.source_note || ""}</div>
        <PreviewableImage src={href} alt={ev.title || "参考流程图"} />
        <div style={{ marginTop: "8px" }}>
          <a className="act" target="_blank" rel="noreferrer" href={href}>看大图</a>
          <a className="act" download href={href}>下载 SVG</a>
          {ev.mermaid ? (
            <a className="act" download
              href={`${API}/api/sessions/${G.S.id}/exports/${encodeURIComponent(ev.mermaid)}`}
            >mermaid</a>
          ) : null}
          {ev.png ? (
            <a className="act" download
              href={`${API}/api/sessions/${G.S.id}/exports/${encodeURIComponent(ev.png)}`}
            >PNG</a>
          ) : null}
        </div>
      </div>
    );
  }

  if (ev.kind === "run.failed") {
    return <div className="card"><h4>没跑完</h4><div className="cap">{ev.error || ""}</div></div>;
  }

  if (ev.kind === "session.restored") {
    // **可关掉。** 它是一条状态陈述而不是一件事，读过就没用了；而每次服务重启/
    // 水合都会再发一条持久事件（真实库里同一会话见过 5 条），流里就一直挂着。
    // timeline() 已经只留最新一条，这里再给一个关掉的出口。
    //
    // 只记在内存里、不落库：用户关的是"这一眼别再挡着我"，不是"永久删掉这条
    // 审计记录"。刷新后再出现是对的 —— 那说明又恢复了一次。
    if (DISMISSED.has(evKey(ev))) return null;
    return (
      <div className="card" style={{ position: "relative" }}>
        <h4>会话已恢复</h4>
        <div className="cap">{`${ev.files ?? 0} 份材料${ev.stats ? ` · ${ev.stats.objects ?? 0} 个对象` : ""}`}</div>
        <button type="button" className="act" aria-label="关掉这条"
          style={{ position: "absolute", top: "6px", right: "6px", padding: "1px 6px", lineHeight: 1.4 }}
          onClick={() => { DISMISSED.add(evKey(ev)); bumpUi(); }}>×</button>
      </div>
    );
  }
  return null;
}

/**
 * 推理轨迹。**对话事件不进轨迹** —— 轨迹是「系统做了什么」，对话是「我们说了
 * 什么」，混在一起两边都读不清。
 *
 * 无论多少条都默认收起。聊天主线只给一行「运行详情」；用户主动点开后才看事件，
 * 完整的操作记录仍在右栏「推理」里。原生 details 保留键盘与读屏语义。
 */
export function TraceCard(): ReactNode {
  const G = useUi();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const evs = G.S.events.filter((e: any) => !["chat.turn", "chat.step"].includes(e.kind));
  if (!evs.length) return null;
  return (
    <details className="trace" onToggle={(event: any) => setExpanded(!!event.currentTarget.open)}>
      <summary aria-expanded={expanded} aria-controls={detailId} aria-label={t("reasoning.traceToggle")}>
        <span>{t("reasoning.trace", "", { n: evs.length })}</span>
        <span className="reasoning-chevron" aria-hidden="true"></span>
      </summary>
      <div className="tb" id={detailId} role="region" aria-label={t("reasoning.traceToggle")}>
        {expanded ? evs.map((ev: any, i: number) => {
          const d = evDetail(ev);
          return (
            <div className="step" key={i}>
              <span className={"tag " + evTag(ev.kind)}>{evLabel(ev.kind)}</span>
              <div>{ev.model
                ? <div className="sub">{`${ev.model} · $${ev.usd}`}</div>
                : d ? <div className="sub">{d}</div> : null}</div>
            </div>
          );
        }) : null}
      </div>
    </details>
  );
}
